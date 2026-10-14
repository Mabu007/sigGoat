# SIRGOAT Deployment Status

## Target architecture

- **Web UI and user-facing API:** existing deployment host.
- **Identity:** Firebase Authentication.
- **Durable state:** Firebase/Firestore, including GOATs, schedule generations, leases, theses, immutable condition plans, signals, wake history, and the Telegram outbox.
- **Serverless scheduling:** Cloudflare Workers Cron Trigger every minute.
- **Execution:** the existing SIRGOAT API's authenticated `/api/internal/cron` route runs the canonical Node pipeline. The Worker dispatches this route rather than maintaining a fork of the reasoning/signal code.
- **AI and delivery:** existing user-selected AI provider and Telegram outbox.

No Firebase Functions or Cloud Run service is required. Cloudflare Durable Objects are not required. Firestore remains the sole durable scheduler state; the Worker has no local timer or state dependency.

## GOAT execution contract

1. Creating a GOAT saves a draft. It does not start research until deployment.
2. Deployment requests an initial market review immediately.
3. The review creates a thesis and a bounded set of deterministic conditions using supported indicator/operator definitions.
4. Tracker checks are separate from AI reasoning. They compute indicator values from ordered candle data and do not call AI unless one or more conditions transition to HIT.
5. Every condition is evaluated on the same snapshot. All hits are persisted before one consolidated AI wake; a completed condition is never re-armed.
6. Routine reviews follow the user's configured interval/time/manual/tracker-only schedule. Routine and trigger-triggered research preserve the active condition definitions while any remain pending.
7. SignalGate remains authoritative. Actionable signals are persisted only after the thesis and signal writes succeed.
8. Telegram notifications are sent through the existing Firestore-backed idempotent outbox.

## Required configuration

API host:
- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (or another supported Firebase Admin credential configuration)
- `CRON_SECRET`
- AI/Telegram platform fallback credentials only if desired; per-user credentials remain supported.

Cloudflare Worker:
- Secret `SIRGOAT_API_ORIGIN`: the deployed API base URL, without a trailing slash.
- Secret `CRON_SECRET`: exactly the same secret configured on the API host.
- Cron trigger: `* * * * *`.

Follow [CLOUDFLARE_WORKER_SCHEDULER.md](CLOUDFLARE_WORKER_SCHEDULER.md) for deployment and cutover.

## Cutover safety

Keep the GitHub Actions dispatcher enabled until the Worker has been deployed and manually tested. Verify:
- initial market review and thesis persist after deployment;
- `nextTrackerCheckAt` advances after a tracker pass;
- unmet conditions do not call AI;
- all simultaneously hit conditions remain marked HIT;
- routine reviews respect the selected AI interval;
- SignalGate rejects invalid proposals;
- Telegram notifications are delivered once and retry safely.

Then disable `.github/workflows/goat-scheduler.yml` to avoid two permanent dispatchers.

## Validation status

Code and configuration have been updated in the migration pull request. Automated CI has not yet produced a usable passing result, and no live Cloudflare/Firebase deployment has been verified. Treat production cutover as incomplete until the checks above pass.
