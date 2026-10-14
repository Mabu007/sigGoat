# SIRGOAT Deployment Status

## Current architecture

- **Application:** Vercel (web UI and user-facing Node.js API); Cloudflare Workers hosts the scheduled execution endpoint using the same server/runtime code.
- **Authentication:** Firebase Authentication.
- **Durable application state:** Firebase Admin / Firestore.
- **Scheduled work (target):** Cloudflare Workers Cron calls the private Cloudflare Workers service `GET /api/internal/cron` every minute using Cloudflare Workers OIDC/IAM plus `x-cron-secret`; Firestore remains the source of truth for due times and leases.
- **AI:** User-selected model/provider through the reasoning gateway.
- **Telegram:** Firestore-backed notification outbox with idempotency and retry state.

Cloudflare Workers, Cloudflare Durable Objects, Worker bindings and Wrangler are not part of the target runtime. The GOAT execution actor is a Cloudflare-neutral in-process TypeScript runtime; it contains the wake pipeline and no Cloudflare bindings.

## Production configuration

Required for persistent production GOAT state and scheduled runs:

- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (or another supported Firebase Admin credential configuration)
- `FIREBASE_PROJECT_ID` on the Cloudflare Workers service, with its service account granted Firestore access through Application Default Credentials
- `CRON_SECRET` mounted from Secret Manager into Cloudflare Workers
- A Cloudflare Workers Cron service account with `roles/run.invoker` on the private Cloudflare Workers service
- Cloudflare Workers Cron job URL set to the Cloudflare Workers service URL plus `/api/internal/cron`, with OIDC audience set to the service URL and `x-cron-secret` header

Optional configuration includes `APP_ORIGIN`, the platform fallback AI key and the platform fallback Telegram bot credentials. Individual users can connect their own supported credentials through Settings.

## Operational caveats

- Cloudflare Workers Cron dispatches every minute; it only executes work whose persisted Firestore due time has arrived. The GOAT's reasoning cadence is still governed by its own schedule.
- A green Vercel or Cloudflare Workers deployment does not verify Firebase access, Cloudflare Workers Cron OIDC/IAM, market data, AI credentials, or Telegram delivery.
- The production GOAT data repositories use Firestore only when Firebase Admin credentials are valid. Check `GET /api/settings/status` and the deployed function logs.
- A scheduled run requires a deployed GOAT, a valid schedule, accessible market data and an available AI provider. Errors should be surfaced in the GOAT runtime state and review history.

## Validation

Run the CI workflow and follow `docs/CLOUD_RUN_SCHEDULER.md` for the Cloudflare Workers/Cloudflare Workers Cron cutover. Do not disable the previous dispatcher until the Cloudflare Workers Cron job has been manually triggered and a test GOAT's review, persisted schedule advancement, tracker path, and Telegram outbox have been verified.
