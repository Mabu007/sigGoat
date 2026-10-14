# SIRGOAT: Firebase + Cloud Run scheduler

This replaces the GitHub Actions cron dispatcher. It does **not** replace or fork the GOAT reasoning pipeline: the Cloud Run service invokes the same authenticated `/api/internal/cron` handler, which claims Firestore schedules, runs deterministic tracker checks, runs the normal GOAT wake pipeline (including SignalGate), persists results, and drains the Telegram notification outbox.

## Target architecture

- **Vercel:** existing web app and user-facing API.
- **Firebase Authentication + Firestore:** canonical user, GOAT, schedule, thesis, signal, wake-history and Telegram outbox state.
- **Cloud Run:** Node 22 service containing the existing API/runtime code. The Cloud Run service is private to authenticated callers.
- **Cloud Scheduler:** dispatches `GET /api/internal/cron` once per minute using Cloud Run IAM/OIDC plus the application-level `x-cron-secret` header.
- **OpenRouter / market-data provider / Telegram:** existing integrations remain in the same runtime pipeline.

Cloud Run is a stateless execution host; Firestore is the source of truth. Do not rely on an in-memory registry, timer, or local filesystem to keep a GOAT scheduled.

## One-time Google Cloud setup

Run these commands from the repository root with the intended Google Cloud project selected. Substitute the region and service-account names for your deployment.

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

gcloud iam service-accounts create sirgoat-runtime
gcloud iam service-accounts create sirgoat-scheduler

# The runtime needs Firestore access through Application Default Credentials.
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:sirgoat-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# Create a strong random secret locally, then store it in Secret Manager.
export CRON_SECRET="$(openssl rand -hex 32)"
printf '%s' "$CRON_SECRET" | gcloud secrets create sirgoat-cron-secret --data-file=-
gcloud secrets add-iam-policy-binding sirgoat-cron-secret \
  --member="serviceAccount:sirgoat-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

```

If the project has not previously used Cloud Scheduler, allow its service agent to finish provisioning before creating the job.

## Deploy the Cloud Run service

```bash
gcloud run deploy sirgoat-scheduler \
  --source . \
  --region YOUR_REGION \
  --service-account sirgoat-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --timeout 900 \
  --concurrency 1 \
  --max 2 \
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=YOUR_PROJECT_ID" \
  --set-secrets "CRON_SECRET=sirgoat-cron-secret:latest"
```

The project must have Firestore enabled and the runtime service account must have access to the same Firebase project used by the user-facing application. The server uses Application Default Credentials on Cloud Run; do not upload a service-account JSON file into the repository or container.

Retrieve the service URL:

```bash
SERVICE_URL="$(gcloud run services describe sirgoat-scheduler --region YOUR_REGION --format='value(status.url)')"
```

## Create the minute dispatcher

Use the private Cloud Run service URL as the OIDC audience and target. Cloud Scheduler's OIDC token occupies the `Authorization` header, so the app-level secret is sent in the separate `x-cron-secret` header.

```bash
gcloud run services add-iam-policy-binding sirgoat-scheduler \
  --region YOUR_REGION \
  --member="serviceAccount:sirgoat-scheduler@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http sirgoat-goat-dispatch \
  --location YOUR_REGION \
  --schedule="* * * * *" \
  --time-zone="UTC" \
  --uri="$SERVICE_URL/api/internal/cron" \
  --http-method=GET \
  --update-headers="x-cron-secret=$CRON_SECRET" \
  --oidc-service-account="sirgoat-scheduler@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --oidc-token-audience="$SERVICE_URL" \
  --attempt-deadline=900s
```

The minute dispatcher does not mean every GOAT reasons every minute. Firestore due times determine which GOATs are eligible. The current GOAT schedule normalisation floors reasoning intervals at five minutes; tracker checks may be due more frequently. Never set the dispatch cadence slower than the shortest required tracker cadence.

## Verify before switching off the old dispatcher

1. Confirm Cloud Run reports Ready and its startup logs say Firebase Admin is ready.
2. Confirm the Cloud Scheduler job's service account has `roles/run.invoker`.
3. Run the job once manually: `gcloud scheduler jobs run sirgoat-goat-dispatch --location YOUR_REGION`.
4. Check the response/log output for `handled: true`, scheduler health, and zero unexpected failures.
5. Deploy a test GOAT, confirm an initial review is persisted, then confirm a scheduled review advances its Firestore due time.
6. Trigger a deterministic tracker condition and confirm the tracker event, resulting review/signal (only if SignalGate approves it), and Telegram outbox delivery/history.
7. Confirm Telegram delivery retry works with a temporary invalid token and then a valid token.
8. Check Firestore contains `goatSchedules` and the GOAT, thesis, signal, wake-history, and outbox records survive a new Cloud Run instance.

Only after those checks pass should the old GitHub Actions scheduled workflow be removed/disabled. A successful container build alone does not prove live Firebase, market data, AI, or Telegram credentials work.

## Operational notes

- Firestore is the durable scheduler state. Cloud Run memory and local disk are disposable.
- Cloud Scheduler can retry a failed HTTP dispatch. The Firestore transaction lease prevents concurrent workers from claiming the same due schedule.
- Review Cloud Run request timeout and concurrency alongside the maximum batch size in `/api/internal/cron`; do not raise batch limits without load testing.
- The authenticated cron endpoint requires both Cloud Run IAM authorization and `CRON_SECRET`.
- The Vercel app's Firebase client variables still need the `VITE_FIREBASE_*` names at build time; Cloud Run's server-side `FIREBASE_PROJECT_ID` is not a replacement for browser Firebase configuration.
