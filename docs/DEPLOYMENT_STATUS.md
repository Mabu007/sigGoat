# SignalGOAT — MVP status

Verified against the deployed systems on 2026-10-09. Statuses are literal:
**Implemented** = code exists, **Locally verified** = passed a test,
**Deployed** = deployment completed, **Production-verified** = the live
integration was actually exercised.

## Deployed URLs

| Service | URL | Verified |
|---|---|---|
| Application (Vercel) | https://sig-goat.vercel.app | Production-verified |
| API health | https://sig-goat.vercel.app/api/health | Production-verified |
| Cloudflare Worker | https://siggoat-scheduler.gtebogo75.workers.dev | Production-verified |
| Worker health | https://siggoat-scheduler.gtebogo75.workers.dev/health | Production-verified |

## Status

| Capability | Status |
|---|---|
| Firebase client auth + Firestore persistence | **Production-verified** — `authMode: firebase`, `persistenceMode: firestore` |
| Live market data | **Production-verified** — EUR/USD mid 1.11985, `dataMode: LIVE`, `stale: false` |
| Worker market ingestion (SQLite DO) | **Production-verified** — 181 candles/instrument, idempotent redelivery |
| Worker → app market events | **Production-verified** — ~6 events/min arriving; event-id tampering refused |
| Worker cron reconciliation | **Production-verified** — `/api/internal/reconcile` fired on schedule |
| Durable scheduling path | **Deployed** — `scheduler.kind: durable-object`, endpoint set |
| Telegram commands + bot connect | **Implemented, locally verified** (26 e2e tests). Production delivery needs a real bot |
| OpenRouter per-user keys | **Implemented, locally verified.** Not exercised with a real key |
| Groq provider | **Implemented, locally verified** (20 tests). Not exercised with a real key |
| Auth on protected routes | **Production-verified** — 401 without a token, 401 with a bad one |
| Telegram webhook closed | **Production-verified** — 401 without the secret |

## Commands the Telegram bot accepts

```
/create <goal> <market> [1m|5m|15m|1h|4h]
/processes            list your processes with ids
/trigger <ID>         run one evaluation now (spends AI)
/pause <ID>           stop a process
/resume <ID>          restart a paused process
/analyse [market]     force analysis of the default process
/status               current state
/help                 full list
```

## Known limitations

1. **The in-process scheduler is still reachable.** On a serverless host the
   durable alarm is authoritative and correct; the fallback only engages when
   `DURABLE_SCHEDULER_URL` is unset, which it is not in production.

2. **Telegram duplicate suppression is per-process.** `update_id` dedupe lives in
   a bounded in-memory set. On a cold start the window is empty, so a retry
   arriving after a deploy is not suppressed. The action itself is still safe:
   it re-reads state and `/trigger` is rate limited.

3. **SignalGOAT produces analysis and alerts only.** No order placement exists
   anywhere in the codebase, by design.

4. **`SENT_UNCONFIRMED` is possible for Telegram.** Telegram gives no
   idempotency key, so a message accepted by Telegram whose response was lost is
   recorded as unconfirmed and not retried. One duplicate is possible in a narrow
   window; a missed alert is not.

5. **Market event routing needs a subscriber.** Events are validated and
   delivered, but with no GOAT created there is nothing to wake — so
   `subscribersConsidered: 0` is correct, not a failure.

## What a first user does

1. Sign in with Google at https://sig-goat.vercel.app
2. Settings → AI Reasoning Engine → pick a provider, paste a key, "Test" it
3. Settings → Telegram → paste a bot token from @BotFather and your chat id,
   click **Connect Bot** (verifies with Telegram and registers the webhook)
4. Create a process in the UI, or `/create …` in Telegram

Steps 2 and 3 need credentials I do not have and must not ask for in chat.