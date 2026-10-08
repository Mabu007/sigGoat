# SignalGOAT

Personal AI market-analysis agents ("GOATs") that perform evidence-based market
reasoning, deterministic conditional-setup validation, historical backtesting,
and clearly-labelled market updates. **No automated trade execution — signals
are informational, and the human always executes manually on their own broker.**

## Run locally

**Prerequisites:** Node.js 22+ (or Bun 1.3+)

1. Install dependencies:
   ```
   npm install
   ```
2. Copy [.env.example](.env.example) to `.env.local` and fill in what you have
   (everything is optional — see below). `.env.local` is loaded automatically
   by `src/server/env.ts`; an already-set environment variable always wins over
   the file. For a local run with no Firebase project, set:
   ```
   SIGNALGOAT_ALLOW_DEV_AUTH="1"
   ```
3. Run the app:
   ```
   npm run dev
   ```

The server binds to `0.0.0.0:3000` (override with `PORT`).

## Market data

Live prices come from **biquote.io** -- free, no API key, no signup, 15,000
requests/minute. Forex, metals, crypto and index CFDs via MetaTrader 5.

Four feed behaviours that silently corrupt analysis are handled in
`src/services/market-data/BiQuoteMarketDataProvider.ts`:

| Feed behaviour | Consequence if ignored | Handling |
|---|---|---|
| OHLC bars arrive **newest-first** | every EMA/RSI/ATR/structure value wrong while the app looks healthy | reversed to ascending on read |
| `volume` is **always 0** (CFD, no exchange tape) | "volume looks strong" fabricated from zeros | real `tickVolume` mapped instead |
| Forex **closed Fri-Sun** | Friday's close analysed as a live price | `MarketQuote.stale` / `.marketState` / `.quoteAgeSeconds` |
| batching needs a **repeated** `?symbols=` param | comma form silently returns one symbol | repeated param |

There is **no automatic fallback to PAPER**. A feed outage surfaces as an
explicit failure rather than silently turning the app into fiction. Set
`MARKET_DATA_PROVIDER=paper` to force the simulated feed for offline work --
`dataMode` then reports `PAPER`.

### Shared market state

`MarketStateStore` keeps one timestamped, persisted view per
`symbol::timeframe` -- quote, 120 candles, and every derived indicator -- and
fans it out to every GOAT. It is keyed by **market, not GOAT**, because the
expensive part is identical for everyone watching the same pair.

Six GOATs on EUR/USD over 40 seconds: **1 poll loop and 3 provider fetches**,
where per-GOAT polling would have made 48. Counters are exposed at
`GET /api/settings/status` under `marketState`.

A provider outage keeps the last good snapshot and flags it `degraded`; reasoning
refuses to run on degraded data so stale prices cannot become a thesis.

See [docs/durable-objects.md](docs/durable-objects.md) for the storage and
scheduling architecture, including what ports to Cloudflare Durable Objects.

## Bring-your-own OpenRouter key (BYOK)

The Settings screen stores a per-account OpenRouter API key on the server. It is
never sent back to the browser and never shared between accounts.

| Route | Purpose |
|---|---|
| `GET /api/settings/keys` | Per-account credential status (booleans only). |
| `POST /api/settings/keys` | Saves `openRouterKey` / `telegramToken` / `telegramChatId`. Saving a new key invalidates that user's cached OpenRouter client. |
| `GET /api/ai/models` | Live OpenRouter catalogue resolved with **the caller's** key. |
| `POST /api/ai/test` | End-to-end probe: one cheap real completion on the caller's key. |

There is no hardcoded model allow-list — `GET /api/ai/models` returns the live
catalogue and `POST /api/goats` only checks that the chosen id is a well-formed
OpenRouter slug. With no key configured, a GOAT returns a deterministic
`NO_TRADE` labelled `reasoningMode: "DEMO"`; it never fabricates analysis.

## The GOAT loop

A deployed GOAT runs one pipeline on every wake, in this order:

1. **Market data** — quote + candles from the configured provider.
2. **Internet research** — fresh headlines per market
   (`src/services/news/NewsService.ts`, Google News RSS, key-free, 15 min
   cache, 3-day freshness window). A research failure never breaks the wake:
   the prompt is explicitly told research was unavailable, so the model cannot
   claim it searched. Headlines are fenced and labelled unverified.
3. **Asset state** — what the market *is* right now (trend, momentum,
   structure, volatility, where price sits). Stored on the thesis as
   `assetState`.
4. **Plan** — the ordered *wait-for* conditions. Stored as `tradePlan` and,
   for actionable setups, as `proposal.triggerSequence`.
5. **Trackers** — the plan expressed as indicator conditions
   (`EMA(20) CROSS_ABOVE 1.085`, `RSI(14) CROSS_BELOW 30`, …). Each is
   recomputed deterministically from candles by `TrackerEvaluator`; **no LLM
   runs at evaluation time**.
6. **Signal** — only gate-approved, and always conditional. `triggerSequence`
   is *required* for an `ACTIONABLE` proposal: "buy now" is rejected by the
   contract validator.

A GOAT that hits a tracked condition alerts you on Telegram immediately, then
re-runs the pipeline.

### Signals are trade ideas, never orders

`"buy at market"` cannot pass validation. An actionable proposal must supply an
ordered chain of conditions to wait for; entry/entryZone describe where the idea
becomes valid *once those conditions are met*. `SignalGate` then recomputes
risk/reward from real prices and applies the skill's hard constraints.

## Market tracking timeframe

Each GOAT stores a tracking timeframe (`1m`, `5m`, `15m`, `1h`, `4h`) chosen at
deploy time or changed later. It is the cadence at which **trackers are
observed** — not a limit on what the AI may reason about. Poll cadence scales
with the bar size and is clamped to 5–60s.

Server-side validation is authoritative: `PATCH /api/goats/:id/schedule` rejects
an unknown timeframe with `400 INVALID_TIMEFRAME`, while creation degrades an
unrecognised value to `15m` so a client sending a stale enum still gets a
working GOAT.

Market state carries `status: LIVE | DEGRADED | UNAVAILABLE`. Only `LIVE` may
satisfy a tracker or produce a thesis; a degraded snapshot is last-known data and
is refused rather than silently used.

## Daily market recap

Each tracked market accumulates an intraday session. On a trading-date change
(or via `POST /api/markets/rollup`) the session is rolled into a deterministic
`DailyMarketRecap` — open/high/low/close, change, range, trend, bar count and
tracker events — and the ephemeral state is cleared for the new day.

- **Deterministic, not AI.** Every field is aggregated from data already held.
  No model call is made to restate numbers we already have.
- **Idempotent** on `"<MARKET>:<YYYY-MM-DD>"`. Re-running merges into the same
  record: the wider high/low span is kept, and events are unioned by content, so
  a double rollover cannot create two recaps or double-count an event.
- **Narrow.** Only ephemeral intraday state is cleared. Recaps, GOAT
  definitions, ownership, signals and thesis history are never touched.

`DEGRADED` snapshots never contribute to a recap, so a stale price cannot end
up in a durable historical record.

## Analysis schedule

Each GOAT carries its own `schedule`, settable at deploy time or changed later.
It controls **AI spend only** — deterministic trackers keep evaluating on every
price tick regardless.

| Mode | Meaning |
|---|---|
| `INTERVAL` | Every N minutes (5 / 15 / 30 / 60 / 240). Floored at 5 minutes. |
| `TIMES` | At explicit local `HH:MM` wall-clock times (up to 12). |
| `TRACKERS` | Tracker polling only — zero AI spend. |
| `MANUAL` | Reasons only when asked (chat, or the Wake button). |

| Route | Purpose |
|---|---|
| `POST /api/goats/:id/status` | `{ action: 'PAUSE' \| 'PLAY' }` — Stop/Play. |
| `PATCH /api/goats/:id/schedule` | Change the analysis interval. |
| `POST /api/goats` | Deploys **and immediately runs the first analysis**, so the response already contains the first thesis, state, plan and trackers. |

## Chatting with a GOAT

- **In-app**: the Chat panel on any GOAT.
- **Telegram**: send any message to your bot. `/status` prints current state,
  and `/analyse` forces a full fresh reasoning run on demand (same wake
  pipeline as the web app, so both surfaces behave identically).

A paused GOAT still answers explicit chat and manual wake requests, but ignores
scheduled and tracker-driven runs.

## What runs out of the box (and how it is labelled)

With zero configuration the app boots fully functional in **truthful demo
mode**. Nothing pretends to be real:

| Subsystem | Default behaviour | How it is labelled |
|---|---|---|
| Market data | Deterministic PAPER feed (seeded, restart-stable, never `Math.random()`) | `dataMode: "PAPER"` on every API response; "PAPER DATA · simulated feed" badges in the UI |
| Reasoning | DEMO mode: deterministic NO_TRADE results, no fabricated analysis | `reasoningMode: "DEMO"` in runtime state; "DEMO MODE · no AI model connected" badges |
| Persistence | File-backed JSON at `DATA_DIR` (default `./data`), atomic writes | `persistenceMode` reported by `/api/settings/status` |
| Auth | Dev opt-in header mode | `authMode` reported by `/api/settings/status`; never silently enabled |

## Configuration (all optional)

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Server-wide fallback AI key. Users normally store their own key via Settings (per-user keys are resolved per call). |
| `SIGNALGOAT_ALLOW_DEV_AUTH=1` | Enables `x-dev-user-id` header auth for local runs and smoke tests. Never enable in production. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_PROJECT_ID` | Enables Firestore persistence + real Firebase ID-token verification. |
| `DATA_DIR` | Directory for file persistence (default `./data`). |
| `TELEGRAM_BOT_TOKEN` | Server-wide fallback Telegram bot token (users can store per-user tokens via Settings). |
| `TELEGRAM_WEBHOOK_SECRET` | When set, the webhook rejects updates without a matching `x-telegram-bot-api-secret-token`. |

## Hard guarantees enforced in code

- **LLM output is untrusted.** Model responses are parsed by
  `parseReasoningResult()` (`src/services/agent/contracts.ts`) and rejected as a
  whole on any contract violation — a malformed response can never crash a GOAT
  or produce a signal.
- **Skills' hard constraints are enforced deterministically**, not via prompt
  hints: `SignalGate` (`src/services/agent/SignalGate.ts`) recomputes risk/reward
  from actual prices, rejects MARKET orders under `LIMIT_ORDERS_ONLY`, enforces
  `MINIMUM_RR_X_TO_Y`, `SPREAD_UNDER_X_PIPS`, `NO_COUNTER_TREND`, and
  evidence/confidence minimums — collecting *all* violations per evaluation.
- **No automated execution exists.** Signals are conditional, informational
  plans with explicit entry zone / stop / target / invalidation.
- **No fake market data.** The only non-live provider is the labelled paper
  provider; adding a live adapter is a single swap at the `MarketDataProvider`
  boundary.

## Hosting

**Vercel runs the application. Cloudflare Durable Objects run the schedule.**

```
Vercel                              Cloudflare
────────                            ─────────
UI + API (api/index.ts)             worker/scheduler-worker.ts
Firebase auth + Firestore           one Durable Object per GOAT
BiQuote + MarketStateStore          durable: nextWakeAt,
Trackers (deterministic)              nextTrackerCheckAt,
GOAT wake -> AI -> SignalGate         generationId, paused
        ▲                                       │
        └──── POST /api/internal/wake ◀──── alarm()
              POST /api/internal/check-trackers   (no AI cost)
```

The Durable Object holds **scheduling state only**. It never touches user data,
GOAT definitions, market data or AI, and it imports no Node-only module —
`firebase-admin` cannot run on the Workers runtime, which is exactly why nothing
that needs it lives there. See
[docs/durable-objects.md](docs/durable-objects.md).

### Vercel setup

1. Import the repo. `vercel.json` builds `npm run build`, serves `dist`, and
   routes `/api/*` to the `api/index.ts` function.
2. Set these under **Settings → Environment Variables**:

   ```
   FIREBASE_SERVICE_ACCOUNT_JSON_BASE64=<base64 of the service-account JSON>
   DURABLE_SCHEDULER_URL=https://<worker-name>.<subdomain>.workers.dev
   DURABLE_SCHEDULER_SECRET=<any long random string>
   OPENROUTER_API_KEY=                 # optional platform fallback
   TELEGRAM_BOT_TOKEN=                 # optional
   ```

   `base64 -w0 firebase-service-account.json`. Never set
   `SIGNALGOAT_ALLOW_DEV_AUTH` in production.

3. Deploy the scheduler Worker, with the same secret:

   ```
   npx wrangler deploy
   ```

   `SCHEDULER_SECRET` and `APP_ORIGIN` are Worker secrets:
   `npx wrangler secret put SCHEDULER_SECRET`.

4. Public Firebase **web** config is committed in `.env.example` as
   `VITE_FIREBASE_*` and inlined at build time. Add your Vercel domain (and
   `localhost` / `127.0.0.1`) to **Authentication → Settings → Authorized
   domains**, otherwise Google sign-in fails with `auth/unauthorized-domain`.

### What works where

| Feature | Vercel + DO scheduler |
|---|---|
| Sign in, save keys, GOAT CRUD, manual wake, chat | yes |
| Scheduled reasoning at the user's interval | yes — durable alarm |
| Tracker conditions firing at the tracking cadence | yes — durable alarm, no AI cost |
| Telegram alerts | yes |
| Survives Vercel restart / redeploy | yes — alarm state is in the Durable Object |

Without `DURABLE_SCHEDULER_URL` the app falls back to in-process timers and says
so loudly at boot and in `GET /api/settings/status` (`scheduler.kind`). That
fallback does **not** survive restarts.

## Secrets policy

- `data/` is git-ignored. It holds each user's saved OpenRouter key and
  Telegram token **in plaintext** — treat the directory as sensitive.
- `.env.example` is committed and must contain **empty** placeholders for
  every server-side value. Only `VITE_FIREBASE_*` holds real values, because
  Firebase web config is public by design.
- OpenRouter keys are entered by the user in Settings and are never shipped to
  the browser or stored in this repository.

## Scripts

- `npm run dev` — Express + Vite dev server (`tsx server.ts`)
- `npm run build` — production client build (`vite build`)
- `npm run start` — run the production build (`NODE_ENV=production tsx server.ts`)
- `npm run lint` — full TypeScript check (`tsc --noEmit`)
- `npm test` — test suite (`bun test`, no extra dependencies)

## Architecture sketch

```
src/
  types/index.ts                  # single source of domain types
  services/agent/contracts.ts     # canonical reasoning contract + runtime validators
  services/agent/SignalGate.ts    # deterministic signal gate (hard constraints)
  services/agent/SkillConstraints.ts  # token parsing from skills
  services/ai/OpenRouterClient.ts # LLM client; DEMO fallback; chat answering
  services/market-data/           # MarketDataProvider boundary + PAPER provider
  services/durable-object/        # per-GOAT actor: wake pipeline + scheduler
  services/backtest/              # no-lookahead historical replay
  services/telegram/              # webhook updates + outbound messages
  server/                         # auth, repositories (firestore/file/memory), API router
  context/ + components/          # React SPA (truthful state rendering)
```
