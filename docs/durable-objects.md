# Durable Objects: what Cloudflare provides, what SignalGOAT needs, what is built

## TL;DR

The architecture SignalGOAT needs is **already built and running**, in a form
that ports to Cloudflare Durable Objects without rewriting any consumer. The
Cloudflare *deployment* is deliberately not done yet. See "What is deliberately
not done" at the bottom for the specific blocker.

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
| Persist computed market state + indicators | Durable storage keyed by `SYMBOL::TIMEFRAME` | **Built.** `MarketStateStore` + `MarketStatePersistence`, file-backed today |
| Share one fetch/computation across N GOATs | Durable storage as a shared cache | **Built.** Measured 16x reduction (below) |
| Per-GOAT reasoning interval | `setAlarm` per GOAT object | **Built as `GoatSchedule`**; timer adapter is in-process |
| "Exactly one reasoning run per GOAT" | Single writer per object ID | Partly. In-process mutex today; structural on DO |
| Survive restarts/redeploys | Alarms + storage | Storage: yes. Alarms: no -- in-process `setTimeout` is lost |
| Telegram alerts on tracker hit | `fetch` from the DO, or a Queue | **Built** via `onTrackerTriggered` |

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

`TrackerEvaluator.evaluate` now accepts a pre-computed `IndicatorSnapshot`.
Previously every tracker on every tick recomputed RSI, EMA(20/50), SMA, ATR,
MACD, swing levels and market structure from scratch. It now computes once per
TTL and passes the snapshot in.

### 3.4 Persistence on disk

Snapshots land in `data/market-state/` as atomic writes (temp file + rename), so
a crash mid-write cannot leave a half-parsed snapshot. A restored snapshot is
always marked `expired`, so it renders instantly and is refreshed on next read.

---

## 4. Porting to Cloudflare: what changes

The port is small on the SignalGOAT side and large on the platform side.

### 4.1 SignalGOAT side -- mechanical

| Today | On Durable Objects |
|---|---|
| `FileMarketStatePersistence` | `state.storage.put/get` on a DO keyed by `SYMBOL::TIMEFRAME` |
| `setTimeout` in `scheduleRoutineCheck` | `state.storage.setAlarm(nextRunMs)` re-armed after each wake |
| In-process mutex in `wake()` | Structural via single-writer per ID |
| Express routes in `apiRouter.ts` | DO `fetch` handler; routing moves to Hono |
| `firebase-admin` (Node only) | **Must change** -- see below |

### 4.2 The real blocker: `firebase-admin` does not run on Workers

Workers is V8-isolate, not Node. `firebase-admin` needs Node `crypto` and gRPC,
so it cannot be imported in a DO. Options, in order of preference:

1. **Firestore JS SDK** (`firebase/firestore`) -- fetch-based, works in Workers.
   Keeps client rules and offline semantics.
2. **Firestore REST API** with a service-account token -- no dependency at all.
3. Keep auth/persistence on the Node app and use DOs *only* for market state and
   alarms. Smallest change, keeps Firebase working as-is.

`node:fs` file persistence also moves to D1 or R2.

### 4.3 Two-platform cost

Today there is one deploy (Vercel frontend + API function). Adding DOs means a
second deploy (`wrangler deploy`), a second env-var set, and Cloudflare secrets
alongside Vercel env vars. Worth it for reliability; not worth it on day one.

---

## 5. What is deliberately not done, and why

A partial DO port is worse than none: a half-migrated scheduler that silently
stops firing is exactly the failure this app must not have. Specifically **not**
done yet:

- No `wrangler.toml`, no DO bindings, no Cloudflare worker.
- No `firebase-admin` replacement for Workers.
- Alarms are still in-process `setTimeout`, so **schedules do not survive a
  restart or redeploy**.

That last one is the only meaningful gap and it has a cheap mitigation that
works today -- see below.

---

## 6. Recommended sequence

**For the MVP (do not skip step 1):**

1. **Host on a long-lived Node process** -- Railway or Fly.io, `npm start`. The
   scheduler is the product; a serverless freeze silently stops every analysis
   and every Telegram alert.
2. **Add a heartbeat endpoint and make schedules due-based.** `GET /api/tick`
   recomputes each GOAT's due-ness from `lastEvaluatedAt + schedule` instead of
   trusting an in-memory timer. A Cloudflare Cron Trigger (free, one line in
   `wrangler.toml`) can hit it every minute. This makes schedules survive
   restarts and deploys, which is the property DO alarms would give you, for
   roughly an hour of work and no second platform.
3. Cut backtest, skills and the quote browser to shorten the path to launch.

**After the MVP is live and you have real users:**

4. Move market state into DOs (`MarketStatePersistence` -> `state.storage`).
5. Move per-GOAT scheduling to alarms.
6. Move auth/persistence off `firebase-admin`.

Steps 4-6 each land independently and each removes a class of failure.
