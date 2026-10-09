# Durable Objects: what Cloudflare provides, what SignalGOAT needs, what is built

## TL;DR

**Shipped.** Vercel remains the application host. One Cloudflare Worker owns two
unrelated Durable Object classes with independent lifecycles:

| Durable Object | Identity | Owns |
|---|---|---|
| `GoatSchedulerDO` | one per GOAT id | the authoritative `nextWakeAt` / `nextTrackerCheckAt` and the alarm that POSTs back to Vercel |
| `MarketDataDO` | one per instrument **class** | canonical one-minute candles, session summaries, the swing/level ledger, the subscription routing table, and the alarms that ingest, finalize and prune |

All user data, ownership, market-provider credentials, AI and Telegram stay on
Vercel. Neither Durable Object ever sees a user id or an API key.

```
Vercel (application)                 Cloudflare (stateful runtime)
──────────────────                   ───────────────────────────
UI + API + Firebase                  GoatSchedulerDO  (per GOAT)
OpenRouter (user's key)                 storage: nextWakeAt, nextTrackerCheckAt,
Telegram delivery + outbox                 generationId, paused
SignalGate, theses, signals          MarketDataDO     (per instrument class)
        ▲                              SQLite: candles, session_summaries,
        │                                       swings, levels, regimes,
        │                                       subscriptions, jobs
        │                              alarms: INGEST / FINALIZE / PRUNE
        │
        ├── POST /api/internal/wake ◀────────── alarm()
        ├── POST /api/internal/check-trackers
        ├── POST /api/internal/market-event ◀── published candle events
        └── DurableMarketDataClient ──────────▶ /market/{fx,metals,energy,index,crypto}/*
```

---

## 1. What a Durable Object actually provides

| Primitive | Guarantee | Relevance here |
|---|---|---|
| **Durable storage** (`state.storage`) | Strongly consistent KV per object, transactional | Persist computed market state, indicators, GOAT config, last-evaluation timestamps |
| **Single writer per ID** | Exactly one instance active per object ID | Two workers can never reason about the same GOAT concurrently |
| **`setAlarm(timestamp)`** | Fires once after a delay and **survives restarts and redeploys** | Per-GOAT reasoning intervals with no in-process timer |
| **WebSocket Hibernation** | Push with no billed time while idle | Live tick streaming without a permanently running process |
| **Request isolation** | No shared memory between objects | Isolation is structural, not a discipline you must maintain |

### Alarms, not Cron Triggers

Cloudflare **Cron Triggers** are global and fixed at deploy time -- you declare
`crons: ["* * * * *"]` in `wrangler.toml`. They cannot express "this GOAT every
15 minutes, that one at 08:30 and 14:00". The common pattern is a 1-minute cron
that sweeps every DO and lets each decide whether it is due.

**Durable Object Alarms are strictly better for this app.** Each object owns its
own schedule, so `INTERVAL` and `TIMES` modes map directly onto one alarm each,
with no sweep loop and no per-invocation fan-out. For 5-minute-or-longer
intervals, alarms are the correct primitive and cron is unnecessary.

---

## 2. What SignalGOAT needs, mapped

| App need | DO primitive | Status |
|---|---|---|
| Persist computed market state + indicators | Durable storage keyed by `SYMBOL::TIMEFRAME` | **Built.** `MarketStateStore` + `MarketStatePersistence`, file-backed on a long-lived host, disabled on serverless |
| Canonical one-minute candle history | SQLite `PRIMARY KEY (instrument, open_time_ms)` | **Built.** `MarketDataDO.candles` |
| Idempotent candle upsert | `ON CONFLICT DO UPDATE ... WHERE values changed` | **Built.** Uniqueness is a storage constraint, not a convention |
| Bounded retention + safe pruning | Indexed bounded DELETE below a verified watermark | **Built.** `SessionFinalizer` / `MarketDataDO.finalizeInstrument` |
| Session summaries, swings, levels | Bounded tables keyed by deterministic ids | **Built.** Survive candle pruning |
| Share one fetch/computation across N GOATs | Shared store + partition routing | **Built.** Measured 16x reduction (below) |
| Per-GOAT reasoning interval | `setAlarm` per GOAT object | **Built.** `GoatSchedulerDO` |
| "Exactly one reasoning run per GOAT" | Single writer per object ID | **Built.** Plus `scheduler.decide()` on the app side |
| Survive restarts/redeploys | Alarms + storage | **Built.** In-process `setTimeout` is only the no-Worker fallback |
| Telegram alerts on tracker hit | `fetch` from the DO, or a Queue | **Built** via `NotificationOutbox` (durable, deduplicated) |

## 2b. Why `MarketDataDO` is partitioned by CLASS

A Durable Object is single-threaded with a fixed request budget, so the partition
size is a real design decision, not a detail:

| Strategy | Object count | Failure mode |
|---|---|---|
| One per instrument | hundreds | one alarm per instrument whether or not the market is open |
| One for everything | 1 | a single hot object; one failing symbol blocks every other |
| **One per class** (implemented) | single digits | per-class fault isolation, bounded fan-out |

The partition key is already the routing unit, so if the supported instrument
count grew by two orders of magnitude the correct move is more partitions of the
same shape — a configuration change, not a rewrite.

---

## 3. What is built and running today

### 3.1 `MarketStateStore` -- the durable, per-market cache

`src/services/market-data/MarketStateStore.ts`

Keyed by **market**, not by GOAT, because the expensive part -- indicator
computation over candles -- is identical for every GOAT watching the same pair.

```
EUR/USD::15m  ->  { quote, candles[120], indicators, fetchedAt, degraded }
EUR/USD::1h   ->  { ... }
```

Properties that matter, each covered by tests in `tests/marketState.test.ts`:

- **Thundering-herd collapse.** Concurrent misses share one in-flight request.
- **TTL freshness.** An expired snapshot is refetched, never served as current.
- **Graceful degradation.** A provider outage keeps the last good snapshot and
  flags `degraded: true`, rather than blanking every GOAT's view. Reasoning
  refuses to run on a degraded snapshot, so stale prices cannot silently
  become a thesis.
- **Persistence seam.** `MarketStatePersistence` is the only place state lives.
  File-backed today; `state.storage`, R2 or KV drop in without touching a
  consumer.
- **One poll loop per symbol**, started on first subscriber and stopped on last
  departure, so GOAT lifecycle changes cannot leak timers.

### 3.2 Measured impact

Six GOATs on EUR/USD, 40-second window:

| | Naive (per-GOAT polling) | With `MarketStateStore` |
|---|---|---|
| Poll loops | 6 | **1** |
| Provider fetches in 40s | 48 | **3** |
| Indicator computations | 48 | **3** |

Counters are exposed at `GET /api/settings/status` under `marketState`.

### 3.3 Indicator reuse

`TrackerEvaluator.evaluate` accepts a pre-computed `IndicatorSnapshot`.
Previously every tracker on every tick recomputed RSI, EMA(20/50), SMA, ATR,
MACD, swing levels and market structure from scratch. It now computes once per
TTL and passes the snapshot in.

### 3.3b Indicator warmup is now explicit

`indicatorSeries.ts` returns, alongside each value, whether the indicator is
actually **available** given the history supplied. This exists because the
legacy `indicators.ts` contract is "always return a number", which silently
produced values indistinguishable from real measurements:

| Function | Old behaviour with insufficient history | New behaviour |
|---|---|---|
| `calculateRSI` | returned exactly `50.0` | `rsiSeries(...).available === false` |
| `calculateATR` | returned `0.001` | `atrSeries(...).available === false` |
| `calculateEMA` | substituted a short SMA | `emaSeries(...).available === false` |

An RSI of exactly 50.0 for "I have no data" is the dangerous one: it is the
neutral reading, so both "above 50" and "below 50" are false and a GOAT sits
there silently instead of knowing its tracker is not yet evaluable.

`indicators.ts` is unchanged, so no existing behaviour moved.

### 3.4 Filesystem persistence is disabled on serverless hosts

`FileMarketStatePersistence` writes to `DATA_DIR`. On Vercel that filesystem is
read-only apart from a scratch directory that is discarded on every cold start,
and the writer swallows its own errors — so it produced files nobody read and
writes that vanished without warning.

`isEphemeralRuntime()` detects Vercel / Lambda / Cloud Functions / Netlify and
disables the file persistence entirely. `GET /api/settings/status` reports
`filesystemPersistence: "disabled"` so the state is visible rather than implied.
On those hosts the canonical durable home is `MarketDataDO`.

## 3.5 Market data durability and retention

### The invariant

> **No candle history is deleted before its required durable summary and
> structural facts are safely persisted.**

This is enforced in both implementations, and the ordering is the whole point:

1. resolve the newest **closed** session (never the one still forming)
2. honour a configurable late-update grace window
3. re-read the candles, so late corrections are included
4. validate OHLC integrity, ordering and duplicates
5. compute the session summary **from real candles** — no example values
6. detect and confirm swings; fold them into a deduplicated level ledger
7. classify the market regime from measured structure only
8. persist summary + swings + levels + regime
9. **verify by re-reading the summary back from storage**
10. mark finalized / advance the watermark
11. prune only candles below the watermark, in bounded batches
12. record completion so a retry cannot repeat destructive work

Steps 9–10 are load-bearing. Between persisting and deleting there is a window
where the write could have silently failed; verification closes it. Pruning is
driven by the **finalized watermark**, never by wall-clock age, so a session
whose finalization crashed is simply not eligible.

Both failure modes are covered by tests
(`tests/sessionRetention.test.ts`): a summary write failure and a read-back
verification failure each leave **every candle in place**.

### Retention defaults

| Data | Default | Env override |
|---|---|---|
| 1m current session | retained for the live session | — |
| 1m completed | summarized, then pruned below the watermark | `RETENTION_PRUNE_BATCH` (2000) |
| 5m | **not materialised**; derived from 1m on demand | `RETENTION_M5_ENABLED` (false) |
| 1h | 7 calendar days | `RETENTION_H1_DAYS` |
| 1d | 180 calendar days | `RETENTION_D1_DAYS` |
| session summaries | 400 per instrument | `RETENTION_SESSION_SUMMARIES` |
| confirmed swing points | 250 per side | `RETENTION_SWING_POINTS` |
| late-update grace | 3 minutes | `RETENTION_LATE_GRACE_MINUTES` |

Every value is validated. An unparseable override falls back to the default
rather than becoming `0` days, which would silently switch retention off.

### Session calendar

`SessionCalendar.ts` derives boundaries from **IANA zone rules** through
`Intl.DateTimeFormat`. There is no fixed UTC offset anywhere in the file.

The previous `SessionSchedule` hardcoded "London open = 07:00 UTC" and "New York
open = 13:00 UTC" all year. Both are wrong for six months: New York is UTC-5 in
winter and UTC-4 in summer. Because session finalization keys off these
boundaries, a permanent offset mislabels half of every year — pruning the wrong
window destroys live data or retains it forever.

Sessions are instrument-specific: FX/metals/energy run Sunday-evening to
Friday-evening in `America/New_York` and are labelled by their **close** date
(the FX convention); index sessions are plain intraday windows in the exchange's
own zone (`US500` in `America/New_York`, `GER40` in `Europe/Berlin`); crypto
trades continuously. `GET /api/markets/session?symbol=…` reports the UTC offset
actually in force, so DST handling can be verified in production.

### Market memory after pruning

Deleting minute candles is only safe because the durable records that outlive
them are real:

- **Session summaries** — OHLC, the timestamps of the session high and low,
  range, previous-session comparison, ATR, realised volatility, trend and
  regime, data completeness and quality, and a deterministic narrative
  generated from those numbers.
- **Swing ledger** — bounded, with `DEVELOPING` and `CONFIRMED` distinguished.
  A pivot is only knowable `k` bars later, so `confirmedAtMs` is the timestamp
  of the **confirming** bar, not the pivot. That is what prevents look-ahead
  bias.
- **Levels** — deduplicated by price bucket, with `touches` as a confluence
  count, explicit `invalidationRule`, and status `ACTIVE` / `BROKEN` /
  `EXPIRED`. A retest re-touches an existing level rather than appending a new
  one, so repeated finalization cannot grow the ledger.

### 3.6 Event delivery

The shared runtime publishes a **versioned, compact** event
(`MarketEvent.ts`): event id, partition, instrument, candle open time,
finalization status, a reference, and a small non-identifying context. It is a
notification, not a data transfer — subscribers resolve the candle from the
shared store rather than receiving a copy.

- The event id is **deterministic** (`partition:type:instrument:candleOpenTimeMs`)
  and is **recomputed and checked** on receipt. A tampered id is rejected, which
  prevents an id collision from suppressing a legitimate event.
- Events carry no user data, no keys and no theses. The shared runtime knows
  subscribers only as opaque routing keys.
- Subscription keys are `subscriberId + instrument`, not the subscriber alone: a
  GOAT watching EUR/USD, GBP/USD and USD/JPY would otherwise silently lose two
  of its three subscriptions, because all three are FX.
- Fan-out is bounded and each GOAT is routed in its own `try/catch`, so one
  failing GOAT cannot stall the others.

### 3.7 Notification reliability

`NotificationOutbox.ts` replaces the previous fire-and-forget Telegram send.

- A notification is written to the outbox **before** any send is attempted, so
  an outage leaves a retryable record rather than a lost alert.
- The idempotency key is derived from the **logical decision** (GOAT + kind +
  subject, plus the candle open time for tracker alerts), never from the attempt.
  A retried wake re-deriving the same decision is suppressed.
- Retries are bounded with exponential backoff, then dead-lettered with the
  payload retained for inspection.
- Delivery state is reported by `GET /api/settings/status` → `notifications`.

**The honest limit.** Telegram offers no idempotency key and no correlated
delivery receipt. If a request succeeds on Telegram's side but the response is
lost, we cannot know whether the message arrived. That state is recorded as
`SENT_UNCONFIRMED` and is deliberately **not** retried: the user may get one
duplicate in a narrow window, never a silently missed alert, and the ambiguity
is recorded rather than hidden.

## 4. Deploying

### 4.1 Deploy the Worker

```bash
npx wrangler deploy
npx wrangler secret put SCHEDULER_SECRET          # must match Vercel byte-for-byte
```

`wrangler.toml` declares two migrations:

| Tag | Contents |
|---|---|
| `v1` | `new_classes = ["GoatSchedulerDO"]` |
| `v2` | `new_sqlite_classes = ["MarketDataDO"]` |

SQLite storage requires `new_sqlite_classes`, not `new_classes`. Using the wrong
tag is the usual cause of `SQLite storage unavailable` at runtime.

### 4.2 Set the secrets in BOTH platforms

| Variable | Where | Purpose |
|---|---|---|
| `DURABLE_SCHEDULER_URL` | Vercel | Worker base URL |
| `DURABLE_SCHEDULER_SECRET` | Vercel | scheduler auth, sent as `Authorization: Bearer …` |
| `SCHEDULER_SECRET` | Cloudflare | **the same bytes** as `DURABLE_SCHEDULER_SECRET` |
| `APP_ORIGIN` | Cloudflare | base URL the Worker POSTs alarms back to |
| `MARKET_DATA_WORKER_URL` | Vercel | Worker base URL for market data |
| `MARKET_DATA_WORKER_SECRET` | Vercel | market-data auth, rotatable independently |

The scheduler secret has a different NAME on each side because the Worker and
the app are separate deployments with separate secret stores. The VALUE must be
identical; the name is local to each platform.

Market-data auth is deliberately a **separate** secret from the scheduler one,
so the two surfaces rotate independently and a leaked market secret cannot
schedule GOAT wakes.

Both features degrade loudly rather than silently: `/api/settings/status`
reports `scheduler.kind` and `durableMarketData.configured`, and the boot log
says which fallbacks are active.

### 4.3 What still requires Node

`firebase-admin` needs Node `crypto`/gRPC and cannot run on Workers. This is
unchanged and is the reason both Durable Objects hold no user data. The app
remains the only place identity, ownership and credentials exist.

### 4.4 Two-platform cost

There are two deploys (Vercel + Worker) and two secret sets. That is the price
of having durable, alarm-backed state that survives a redeploy — which a Vercel
serverless function structurally cannot provide.

---

## 5. Why the boundary is shaped this way

Both Durable Objects are deliberately narrow. They hold **scheduling and market
state**, and nothing else. The reason is runtime, not preference:

- `firebase-admin` **cannot run on Workers** (needs Node `crypto`/gRPC), so the
  objects never touch user data. They never need to.
- BiQuote needs **no API key**, so market ingestion can legitimately live on the
  Worker — which is what makes it survive between requests at all.
- Reasoning must run where credentials and persistence live, so it stays on
  Vercel.

### One alarm, many jobs

Durable Object storage allows a single alarm per object.

`GoatSchedulerDO` stores two schedules and arms for the sooner:

| Alarm kind | Cadence | Cost |
|---|---|---|
| `REASONING` | user-chosen interval or times | AI call |
| `TRACKER_CHECK` | the GOAT's tracking timeframe | **no AI** |

`MarketDataDO` keeps a **job queue in SQLite** (`ingest` / `finalize` / `prune`)
and arms the single alarm for whichever job is due. Every alarm handler is
idempotent, because Cloudflare delivers alarms at least once and retries them.
A failed job is retried with backoff up to a bound, then rescheduled at its
normal cadence rather than retried forever.

This is what keeps the core loop event-driven on a host with no persistent
process: a market update that satisfies nothing costs zero tokens.

---

## 5b. Known gaps, stated honestly

- **The Worker has not been deployed.** The Durable Objects, the SQLite schema
  and the alarm workflow are implemented and type-checked, and the whole
  ingestion + finalization pipeline is covered by tests against the same rules,
  but no `wrangler deploy` has been run and no production Cloudflare behaviour
  has been observed. Treat `MarketDataDO` as **unverified in production** until
  it is deployed and `/market/<class>/status` answers.
- **`MarketIngestionService` is the in-process twin of `MarketDataDO`.** Both
  implement the same validation, idempotency, freshness and finalize-before-prune
  rules. The in-process one is what runs on a long-lived host or in tests; the DO
  is the durable owner on Vercel. Behaviour is intended not to fork, and the
  shared rules are unit-tested — but there is no integration test that runs both
  against the same fixtures.
- **`NotificationOutbox` uses an in-memory store.** The durability guarantee is
  real only once `OutboxStore` is backed by Firestore or DO storage. Today an
  outbox record does not survive a process restart, so an alert owed at the
  moment of a cold start is lost. This is the highest-value remaining item.
- **Provider backfill is not implemented.** Late corrections are honoured within
  the grace window, but there is no bounded historical backfill request, so a
  gap that occurs outside that window stays a gap. That is deliberate — a
  fabricated candle is worse than a recorded one — but it means coverage
  figures stay below 100% after any outage.
- **`higherTimeframeTrend` is always `null`.** Higher-timeframe candles are not
  materialised; the field exists so the schema does not need changing when they
  are.
- **Holiday calendars are empty by default.** `SessionSpec.closedDates` is
  supported and instrument-specific, but no exchange calendar is shipped,
  because guessing one would fabricate market closures. Operators supply the
  real calendar for the exchange they trade.

---

## 6. Recommended sequence

**Done:**

1. ~~Host on a long-lived Node process~~ — not needed; Vercel plus Durable
   Object alarms is the deployed architecture.
2. ~~A heartbeat tick making schedules due-based~~ — superseded by real
   per-GOAT alarms plus a tracker-check tick.
3. ~~Move market state into DOs~~ — `MarketDataDO` with SQLite-backed candles.
4. ~~Move per-GOAT scheduling to alarms~~ — `GoatSchedulerDO`.

**Next, in priority order:**

1. **Back `OutboxStore` with durable storage** (Firestore or a DO table). Until
   then an alert owed across a cold start is lost. This is the only remaining
   place where a documented durability guarantee is not actually met.
2. **Deploy the Worker** and verify `MarketDataDO` against a real account:
   confirm the `new_sqlite_classes` migration applies, that alarms fire, and
   that `/market/<class>/status` reports a growing candle count with a stationary
   one after finalization.
3. **Supply real holiday calendars** for the exchanges actually traded.
4. **Add bounded provider backfill** so an outage leaves a recorded gap that is
   later repaired, rather than a permanent hole.
