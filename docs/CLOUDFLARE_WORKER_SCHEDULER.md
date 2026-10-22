# SIRGOAT scheduled runtime: Firebase + Cloudflare Workers

This is the low-cost replacement for Firebase Functions / Cloud Run. Firebase Authentication and Firestore remain the canonical identity and durable state layer. A Cloudflare Worker Cron Trigger dispatches due work every minute. The existing SIRGOAT server endpoint runs the established GOAT pipeline, because the current pipeline uses Node APIs and `firebase-admin`; this Worker does not reimplement or fork that business logic.

## Runtime responsibilities

- **Firebase Auth + Firestore:** user identity, GOAT/job description, attached skills, schedule generations, leases, thesis, immutable condition plan, condition states, signals, wake events, and Telegram notification outbox.
- **Cloudflare Worker Cron Trigger:** invokes `GET /api/internal/cron` every minute with the shared `CRON_SECRET` for GOAT work.
- **No robot Durable Objects:** Firestore owns robot due times and leases. The Worker is a stateless dispatcher shared by all robots.
- **Existing SIRGOAT API runtime:** claims due Firestore work, fetches market data, computes indicator values deterministically, calls the selected AI provider only for initial/routine/triggered analysis, applies SignalGate, persists outcomes, and drains Telegram notifications.

**Important:** Cloudflare is the scheduler/dispatch compute in this migration, not a full port of the Node API into the Worker runtime. The current API origin must remain reachable. The business logic stays in one place to avoid divergence in signal validation and Telegram behavior.

## Configure and deploy

From the repository root:

```bash
npm install
npx wrangler login
npx wrangler secret put SIRGOAT_API_ORIGIN
# Enter the deployed SIRGOAT base URL, e.g. https://your-app.example
npx wrangler secret put CRON_SECRET
# Enter the same strong secret configured on the API host
npx wrangler deploy
```

The API host needs the same `CRON_SECRET`. Firestore must be configured for durable robot schedules and dispatcher heartbeats. Starting a robot requests its initial analysis through the API; later analyses need a working external cron dispatcher.

Set the API origin without a trailing slash. Keep `CRON_SECRET` private; do not put it in `wrangler.toml`, source code, or a `VITE_*` variable. Worker requests use the `Authorization: Bearer <secret>` header expected by `/api/internal/cron`.

Check `https://<worker-subdomain>.workers.dev/health`. To test the dispatch manually, send `POST /dispatch` with `x-worker-admin-secret` equal to the same secret. This endpoint is intended for controlled operator testing; do not expose the secret to the browser.

For a robot smoke test, press Play in a robot room and confirm an initial analysis appears in Robot Log. Close the browser and wait for the selected review interval, then confirm another scheduled run and a fresh dispatcher heartbeat in Robot Details. Press Stop and confirm no later analysis is scheduled. No per-robot Durable Object is created.

## Cutover without missed schedules

1. Deploy this Worker and configure both secrets.
2. Invoke `POST /dispatch` once from a trusted terminal and inspect the JSON result.
3. Confirm the API reports `handled: true`, no scheduler failures, and sensible counts for due reviews, tracker checks, and Telegram delivery.
4. Deploy a test GOAT. Verify the initial analysis is persisted, then wait for a tracker check and a routine review. Verify one Telegram notification per event.
5. Only after those checks pass, disable `.github/workflows/goat-scheduler.yml`. Do not run both dispatchers indefinitely; Firestore leases reduce duplicates, but the two schedulers are a temporary migration fallback.

## Schedule semantics

The Worker ticks every minute. That is a dispatch cadence, **not** an AI cadence. Firestore due times decide which GOATs are processed. GOATs have two independent clocks:

- `nextTrackerCheckAt`: deterministic market-condition evaluation (default five minutes). This must not invoke AI when no condition transitions.
- `nextWakeAt`: AI reasoning schedule (user-selected interval/times/manual/tracker-triggered). A condition hit requests an AI review; routine AI checks occur only when the user's job schedule is due.

The application must never treat a Worker tick as permission to call the model for every GOAT.

## Cost and reliability notes

Cloudflare Workers' free plan has request/CPU limits, and external API timeouts still apply. The Worker performs one small authenticated dispatch per minute; the heavier Node market-analysis pipeline remains on the configured API host. If that host's serverless execution limits interrupt long runs, the next step is to split each cron batch into bounded per-GOAT jobs or port the pure runtime pieces to Worker-compatible modules—without moving SignalGate, condition evaluation, or persistence into a second divergent implementation.
