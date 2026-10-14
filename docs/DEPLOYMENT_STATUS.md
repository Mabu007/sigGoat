# SIRGOAT Deployment Status

## Current architecture

- **Application:** Vercel (web UI and user-facing Node.js API); Cloud Run hosts the scheduled execution endpoint using the same server/runtime code.
- **Authentication:** Firebase Authentication.
- **Durable application state:** Firebase Admin / Firestore.
- **Scheduled work (target):** Cloud Scheduler calls the private Cloud Run service `GET /api/internal/cron` every minute using Cloud Run OIDC/IAM plus `x-cron-secret`; Firestore remains the source of truth for due times and leases.
- **AI:** User-selected model/provider through the reasoning gateway.
- **Telegram:** Firestore-backed notification outbox with idempotency and retry state.

Cloudflare Workers, Cloudflare Durable Objects, Worker bindings and Wrangler are not part of the target runtime. The existing `GoatRuntime`/registry names refer to in-process TypeScript business-logic actors, not Cloudflare resources; preserve this logic until all imports/tests are migrated to neutral `GoatRuntime` names.

## Production configuration

Required for persistent production GOAT state and scheduled runs:

- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (or another supported Firebase Admin credential configuration)
- `FIREBASE_PROJECT_ID` on the Cloud Run service, with its service account granted Firestore access through Application Default Credentials
- `CRON_SECRET` mounted from Secret Manager into Cloud Run
- A Cloud Scheduler service account with `roles/run.invoker` on the private Cloud Run service
- Cloud Scheduler job URL set to the Cloud Run service URL plus `/api/internal/cron`, with OIDC audience set to the service URL and `x-cron-secret` header

Optional configuration includes `APP_ORIGIN`, the platform fallback AI key and the platform fallback Telegram bot credentials. Individual users can connect their own supported credentials through Settings.

## Operational caveats

- Cloud Scheduler dispatches every minute; it only executes work whose persisted Firestore due time has arrived. The GOAT's reasoning cadence is still governed by its own schedule.
- A green Vercel or Cloud Run deployment does not verify Firebase access, Cloud Scheduler OIDC/IAM, market data, AI credentials, or Telegram delivery.
- The production GOAT data repositories use Firestore only when Firebase Admin credentials are valid. Check `GET /api/settings/status` and the deployed function logs.
- A scheduled run requires a deployed GOAT, a valid schedule, accessible market data and an available AI provider. Errors should be surfaced in the GOAT runtime state and review history.

## Validation

Run the CI workflow and follow `docs/CLOUD_RUN_SCHEDULER.md` for the Cloud Run/Cloud Scheduler cutover. Do not disable the previous dispatcher until the Cloud Scheduler job has been manually triggered and a test GOAT's review, persisted schedule advancement, tracker path, and Telegram outbox have been verified.
