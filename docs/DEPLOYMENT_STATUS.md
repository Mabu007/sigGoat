# SIRGOAT Deployment Status

## Current architecture

- **Application:** Vercel (web UI and Node.js API).
- **Authentication:** Firebase Authentication.
- **Durable application state:** Firebase Admin / Firestore.
- **Scheduled work:** GitHub Actions workflow `.github/workflows/goat-scheduler.yml` calls `GET /api/internal/cron` every five minutes using a shared `CRON_SECRET`.
- **AI:** User-selected model/provider through the reasoning gateway.
- **Telegram:** Firestore-backed notification outbox with idempotency and retry state.

Cloudflare Workers, Durable Object scheduler callbacks, Worker bindings and Wrangler deployment are no longer part of the runtime. Legacy Worker source, Worker-specific tests, the Cloudflare scheduler adapter, Wrangler configuration and the Durable Objects deployment guide have been removed.

## Production configuration

Required for persistent production GOAT state and scheduled runs:

- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (or another supported Firebase Admin credential configuration)
- `CRON_SECRET` in Vercel environment variables
- GitHub repository variable `SIRGOAT_API_URL`
- GitHub repository secret `CRON_SECRET` with the same value as Vercel

Optional configuration includes `APP_ORIGIN`, the platform fallback AI key and the platform fallback Telegram bot credentials. Individual users can connect their own supported credentials through Settings.

## Operational caveats

- GitHub Actions scheduled workflows run on a five-minute cadence here; intervals below five minutes are not guaranteed.
- A green Vercel deployment does not verify that Firebase credentials or GitHub scheduler secrets are configured correctly.
- The production GOAT data repositories use Firestore only when Firebase Admin credentials are valid. Check `GET /api/settings/status` and the deployed function logs.
- A scheduled run requires a deployed GOAT, a valid schedule, accessible market data and an available AI provider. Errors should be surfaced in the GOAT runtime state and review history.

## Validation

The latest CI workflow run should be checked separately from the Vercel deployment status. Do not treat a deployment success alone as evidence that typecheck, tests and production behavior have passed.
