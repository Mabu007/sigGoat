# SIRGOAT

SIRGOAT is an AI-assisted trading workspace built around individual market
research agents ("GOATs"). Saved GOATs are pinned to a trading provider: cTrader GOATs use cTrader market
data and cTrader execution; legacy and explicitly Hyperliquid GOATs keep
Hyperliquid market data and the existing PropDAO execution path. The workspace
also provides provider-backed AI reasoning, deterministic setup/risk checks,
historical backtesting, trade proposals, and account views.

**Important:** PropDAO order execution is disabled by default and remains
fail-closed unless the server has both execution flags enabled and a recorded
authorisation reference. Do not assume connecting an API key enables trading.
AI output can be wrong; historical backtests are not guarantees of future results.

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

## Trading providers

The account-level provider setting is the default for newly created GOATs.
Each GOAT stores its provider so changing Settings does not silently move an
existing robot to a different market catalogue or execution venue.

| GOAT provider | Quotes, candles and historical data | Execution |
|---|---|---|
| cTrader | Selected user's authorized cTrader account and broker symbol catalogue | cTrader Open API; blocked unless `CTRADER_EXECUTION_ENABLED="true"` |
| Hyperliquid | Hyperliquid perpetual and HIP-3 market catalogues | Existing PropDAO execution policy and authorization checks |

GOAT runtime, scheduled tracker reviews, proposal handling, chat market context,
and backtesting must resolve the saved GOAT provider. Unsupported symbols or
missing historical data are rejected rather than translated to a different
provider's symbol. Legacy GOAT records without a provider remain on Hyperliquid.

### cTrader connection and safety

Set `CTRADER_CLIENT_ID`, `CTRADER_SECRET`, and `CTRADER_REDIRECT_URI` as
server-side environment variables. Register the exact redirect URI in the
cTrader Open API application. OAuth tokens are stored encrypted in the
credential vault; the browser receives only connection status and selected
account metadata. A selected account that disappears from the authorized
account list is cleared and requires the user to select again. Live accounts
are never selected automatically; a demo account is preferred when there is no
saved selection.

Order execution is disabled unless `CTRADER_EXECUTION_ENABLED="true"` is
explicitly configured on the server. Keep it disabled while connecting and
validating the integration. When enabled, order submission still requires a
selected authorized account, fresh quotes, supported broker metadata, valid
protective stop-loss/take-profit levels, and the server-side per-trade and
portfolio risk checks. An ambiguous order response is not automatically retried;
inspect cTrader's order list before attempting another submission.

## Market data

Hyperliquid quotes and candles are sourced from its perpetual and HIP-3 market
catalogues. cTrader quotes and candles are sourced from the selected authorized
broker account. Instrument availability is provider-driven; do not assume every
conventional FX pair, index, or commodity symbol exists.

The Hyperliquid provider normalises quotes and OHLC candles in
`src/services/market-data/hyperliquid/HyperliquidMarketDataProvider.ts`.
Important integrity rules:

- Quotes use published mid/mark/oracle values and order-book/impact prices where
  available. A missing bid/ask or 24-hour high/low is not fabricated to look
  like a valid quote.
- Historical replay uses real 5-minute candles. The provider pages requests
  because the upstream candle endpoint limits the number of bars returned per
  request. The backtest engine rejects incomplete requested windows rather than
  quietly presenting a partial sample as a full-period result.
- The PAPER provider is deterministic and explicitly labelled. It is suitable
  for UI/development checks, not evidence of trading performance. Production
  backtests require LIVE market data.

There is no silent fallback from a live feed outage to PAPER data. A provider
failure should be shown as unavailable/degraded instead of being represented as
a real market quote.

### Shared market state

`MarketStateStore` keeps one timestamped, persisted view per
`symbol::timeframe` -- quote, 120 candles, and every derived indicator -- and
fans it out to every GOAT. It is keyed by **market, not GOAT**, because the
expensive part is identical for everyone watching the same pair.

Six GOATs on BTC over 40 seconds: **1 poll loop and 3 provider fetches**,
where per-GOAT polling would have made 48. Counters are exposed at
`GET /api/settings/status` under `marketState`.

A provider outage keeps the last good snapshot and flags it `degraded`; reasoning
refuses to run on degraded data so stale prices cannot become a thesis.

Scheduled reviews and GOAT runtime records are backed by Firebase/Firestore. Cloudflare Workers Cron dispatches the authenticated SIRGOAT endpoint every minute while Firebase/Firestore stores durable GOAT state; see [the Cloudflare Worker scheduler runbook](docs/CLOUDFLARE_WORKER_SCHEDULER.md).

## AI providers and per-GOAT models

SIRGOAT supports account-level AI provider settings and per-GOAT overrides.
The GOAT editor currently supports **OpenRouter** and **SpaceBunny** overrides;
GOATs without an explicit override inherit the account's selected provider.
Provider credentials are resolved server-side and are not sent back to the
browser.

| Route | Purpose |
|---|---|
| `GET /api/settings/keys` | Per-account credential status (booleans only). |
| `POST /api/settings/keys` | Save supported provider credentials and notification settings. |
| `GET /api/ai/models` | Resolve the model catalogue using the account provider or an explicitly requested supported provider. |
| `POST /api/ai/test` | End-to-end provider credential probe. |

SpaceBunny uses its documented fixed model, **Space Bunny Alpha**, rather than a
model catalogue. A GOAT cannot use a provider until its credentials have been
configured in Settings. If reasoning has no usable credential, the runtime
must label its state as DEMO rather than presenting demo output as genuine AI
analysis.

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
| `POST /api/goats/:id/status` | `{ action: 'PAUSE' \| 'PLAY' \| 'STOP' }` — Pause preserves state; Stop requires confirmation in the UI, cancels schedules and clears runtime records while preserving the GOAT as a draft; Play/Deploy resumes or starts a fresh review. |
| `PATCH /api/goats/:id/schedule` | Change the analysis interval. |
| `POST /api/goats` | Creates a GOAT draft. Deploy explicitly with `POST /api/goats/:id/status` and `{ action: 'PLAY' }`; deployment starts the first market review. |

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
- **Execution is fail-closed.** PropDAO order writes are blocked unless
  `PROPDAO_EXECUTION_ENABLED`, `PROPDAO_EXECUTION_AUTHORISED`, and a non-empty
  `PROPDAO_EXECUTION_TERMS_REFERENCE` are configured. The code's policy
  documents a need for written authorisation for commercial third-party use;
  credentials alone are not permission to execute.
- **No fake historical data.** PAPER data is explicitly labelled and is not
  acceptable as production backtest evidence. Historical backtests require real
  candles and reject incomplete requested windows.

## Hosting

**Firebase/Firestore is the durable state layer. Cloudflare Workers Cron dispatches scheduled work; the existing SIRGOAT API executes the canonical Node-based GOAT pipeline.** This avoids Firebase Functions and Cloud Run. The Worker is a lightweight scheduler/dispatcher, not a second copy of the signal engine.

```
Cloudflare Worker Cron (every minute)
  └── authenticated GET /api/internal/cron on the deployed SIRGOAT API
        ├── Firebase/Firestore leases and schedule generations
        ├── market data + indicator evaluation
        ├── AI research only for due reviews or condition hits
        ├── SignalGate validation and persistence
        └── Telegram notification outbox
```

### Configure the API host

Set these server-side environment variables on the existing API host:

```bash
FIREBASE_SERVICE_ACCOUNT_JSON_BASE64=<base64 Firebase service-account JSON>
CRON_SECRET=<long random secret>
APP_ORIGIN=https://your-production-domain
OPENROUTER_API_KEY=                 # optional platform fallback
TELEGRAM_BOT_TOKEN=                 # optional platform fallback
```

Generate a secret with `openssl rand -hex 32`. Never expose `CRON_SECRET` through a `VITE_*` variable or commit its value.

### Deploy the free Cloudflare scheduler

Follow [the Firebase + Cloudflare Worker runbook](docs/CLOUDFLARE_WORKER_SCHEDULER.md). Configure the Worker's `SIRGOAT_API_ORIGIN` to the deployed API base URL and set its `CRON_SECRET` to the same secret configured on the API host. The GitHub Actions dispatcher remains only as a temporary fallback; disable it after the Worker dispatch and full GOAT/Telegram path are verified.

### Persistence and scheduling

- A GOAT is saved as a draft until explicitly deployed. Deployment starts an immediate market review; later AI runs follow its persisted user-selected schedule.
- Deterministic tracker checks use the separate persisted `nextTrackerCheckAt` clock. A Worker tick is not permission to call AI for every GOAT.
- Conditions are immutable within a plan: routine and tracker-triggered reviews update thesis/research but do not replace outstanding condition definitions. Each condition's evaluation cursor, last value, and hit status are persisted. An explicit manual re-evaluation can create a new plan; once every condition is terminal, the next routine review can start the next plan.
- Firestore leases and schedule generations suppress overlapping and stale dispatches. A completed run advances its next due time.
- Telegram notifications are queued and deduplicated through the Firestore-backed outbox.
- In-process timers are for local development only. Production scheduling requires working Firebase Admin/Firestore credentials and the Cloudflare Worker secrets.

### Health checks

```
GET /api/health
GET /api/settings/status
GET /api/markets/ingestion
```

A successful Worker deployment alone does not prove Firebase access, market data, AI credentials, or Telegram delivery. Verify a real GOAT end to end before removing the fallback dispatcher.

## Secrets policy

- In production, user credentials are handled through the encrypted credential vault and Firebase-backed persistence. Local development may use a file-backed repository; protect the local `data/` directory.
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
  services/goat-runtime/           # per-GOAT runtime: wake pipeline
  services/backtest/              # no-lookahead historical replay
  services/telegram/              # webhook updates + outbound messages
  server/                         # auth, repositories (firestore/file/memory), API router
  context/ + components/          # React SPA (truthful state rendering)
```
