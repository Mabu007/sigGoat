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

The same Express app serves two hosts, built from one factory
(`src/server/app.ts`) so they cannot drift:

| Host | Entry | Use for |
|---|---|---|
| Long-lived Node process | `server.ts` (`npm run dev` / `npm start`) | Local dev, Fly.io, Render, Railway, any VM. **Required if you want scheduled reasoning and tracker alerts.** |
| Vercel serverless | `api/index.ts` + `vercel.json` | Frontend + request/response API only. |

### ⚠️ Read this before deploying to Vercel

Per-GOAT reasoning intervals and deterministic tracker polling are
`setTimeout` loops **inside the Node process**. A serverless function is frozen
between invocations and reclaimed when idle, so on Vercel:

| Feature | Vercel serverless |
|---|---|
| Sign in, save OpenRouter key, create/stop/delete GOATs | ✅ works |
| Manual "Wake & Re-evaluate", in-app chat, `/analyse` | ✅ works |
| Telegram webhook (inbound) | ✅ works |
| Outbound Telegram alerts when a tracker fires | ⚠️ fires only while a request is live |
| Scheduled/hourly reasoning, "trackers only" polling | ❌ **will not fire** |

Pick one:

1. **Run the app on a long-lived host** (Fly.io / Render / Railway) and use
   Vercel only for the frontend — recommended.
2. **Migrate the per-GOAT actors to Cloudflare Durable Objects** — the correct
   long-term home for them, since they are already modelled as isolated actors
   in `src/services/durable-object/`.
3. Stay on Vercel and set every GOAT's schedule to **"Manual only"** so the UI
   does not promise runs that cannot happen.

### Vercel setup

1. Import the repo. `vercel.json` sets build `npm run build`, output `dist`,
   and routes `/api/*` to the `api/index.ts` function.
2. Set these under **Settings → Environment Variables** (server secrets only):

   ```
   FIREBASE_SERVICE_ACCOUNT_JSON_BASE64=<base64 of the service account JSON>
   OPENROUTER_API_KEY=                      # optional platform fallback
   TELEGRAM_BOT_TOKEN=                      # optional
   TELEGRAM_WEBHOOK_SECRET=                 # optional
   ```

   Generate the base64 locally with `base64 -w0 firebase-service-account.json`.
   Do **not** set `SIGNALGOAT_ALLOW_DEV_AUTH` — it must stay unset/`0` in
   production or anyone can impersonate a user by sending a header.

3. The public Firebase **web** config is already committed in `.env.example` as
   `VITE_FIREBASE_*` and is inlined at build time. If you use Vercel's build
   environment instead, add the same `VITE_FIREBASE_*` names under
   **Settings → Build & Development → Environment Variables**. Setting them
   only at runtime does nothing — Vite inlines them during `vite build`.

4. In the Firebase console, add your Vercel domain (and `localhost` /
   `127.0.0.1` for local work) to
   **Authentication → Settings → Authorized domains**, otherwise Google
   sign-in fails with `auth/unauthorized-domain`.

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
