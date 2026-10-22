# AI robot reliability plan and implementation record

Date: 2026-10-22. Scope: the public `/robots/:slug` trading analyst, its saved market reviews, private viewer chat, and shared scheduler. Do not change the older room product or order execution policy as part of this migration.

## Release contract

1. A robot is **Running** only when it is deployed, unpaused, its Firestore schedule exists, and a trusted dispatcher has a recent heartbeat. The UI must surface a missing heartbeat and the last run failure. Play requests an initial review; Stop invalidates due work. A deployed cron Worker must be verified separately from building its source.
2. Every new review owns a unique `runId`. The same ID belongs to its thesis, signal, activities, and the validated public analysis artifact. New runs never match content by timestamp. Historical runs can use the old read-only approximation until migrated.
3. All model confidence values become percentage points before the deterministic gate. Structured provider responses must pass strict JSON Schema where supported, server Zod validation, the canonical semantic parser, and SignalGate. A missing or invalid result never authorizes a trade.
4. A `freeOnly` robot may call explicit OpenRouter `:free` models with structured output support. If none are usable it fails with `MODEL_UNAVAILABLE`; paid fallback and provider substitution are forbidden. Record the actual model and reported token usage on a successful run.
5. Public log and news data are bounded, redacted run artifacts. Private viewer chat is authenticated, persisted per viewer, quota guarded, and independent of the robot's operating prompt and schedule. A broker balance is read only with explicit consent for that question. Positions and orders are not available to the chat.

## Ordered implementation

| Step | Original finding | Change | Verification |
| --- | --- | --- | --- |
| 1 | P0 confidence scales | Normalize fractional model confidence at the parser boundary; prompt for 0–100 and display stored percentage points | A `0.85` model result reaches the gate as `85` |
| 2 | P0 paid fallback | Persist `freeOnly`; restrict candidate and fallback selection to compatible `:free` models; do not fall back for quota, malformed output, timeout, or data failure | Mock catalogue and provider failure cases; verify recorded model ID |
| 3 | P0 recurring operation | Expose Firestore due time, lease, dispatcher heartbeat and source; show Needs attention without a recent heartbeat; keep the one shared stateless Cron Worker | Deploy Worker with matching secret, invoke dispatch, observe two scheduled cycles with browser closed, then Stop |
| 4 | P1 mislabeled NO_TRADE | Derive log outcome from gate decision, not signal existence | NO_TRADE appears as no trade |
| 5 | P1 timestamp join | Validate and save bounded analysis directly on the run; set `runId` on thesis and signal; reject new robot approval and autonomous acceptance without the matching approved run | Adjacent runs stay separate; failed artifact cannot approve a signal |
| 6 | P1 temporary chat | Save per-viewer conversation in Firestore; fetch on sign-in; retain draft on failure; atomically reserve chat quota | Refresh and retry, private cross-user isolation |
| 7 | P1 per-viewer news generation | Generate one report as part of the review and display its dated source headlines to every visitor | Anonymous viewer sees the same saved report without a model call |
| 8 | P1 overstated chat data | Include saved run and its timestamps; permit optional read-only balance lookup; explicitly state that orders and positions are unavailable | With and without balance consent, verify response context |
| 9 | P1 partial creation | Preflight settings and model before writes, compensate newly created records on validation/start errors | Failed creation has no discoverable incomplete robot |
| 10 | P1 costly reads | Bound room records, query recent rows with composite indexes, skip repair writes during public discovery, reduce polling | Compare Firestore reads under simulated viewers after index deployment |
| 11 | P2 restricted/stale news | Search preferred and broad feed, dedupe with preferred first, exclude undated and stale headlines | Fresh broad story remains visible; old story does not appear breaking |
| 12 | P2 decorative graph | Use a typed, sequential pipeline while execution remains one bounded model call and validation | Existing reasoning and workflow stage behavior remain intact |

## Implemented in this branch

Steps 1, 2, 4–9, 11, and 12 have code changes. Step 3 has the UI and scheduler contract, but the Cloudflare Cron Worker has **not** been deployed or observed alive. Step 10 is partial: recent per-robot queries and polling are bounded, but public gallery discovery still scans all teams and joins several records per robot. Index definitions are committed, not yet installed in the production Firestore project. The current rollback/compensation is best effort; a datastore outage during cleanup may require reconciliation.

The saved artifact includes summary, market view, bias, confidence, confirmation and invalidation conditions, bounded evidence, gate decision and reasons, a cited news report, quote/review times, and actual model, usage and latency when reported. It excludes model raw output, hidden reasoning, private prompts, credentials, and viewer account data. Failed runs expose a typed error code and sanitized message through the existing run ledger.

## Production cutover gate

1. Review and install `firestore.indexes.json`, then wait for index build completion. Measure gallery and room read counts; add paginated discovery plus a denormalized robot card record before significant audience growth.
2. Confirm the Vercel project has the expected Firestore credentials, encrypted OpenRouter access, and `CRON_SECRET`. Configure the same secret and `SIRGOAT_API_ORIGIN` on the `sirgoat-scheduler` Cloudflare Worker. Deploy the Worker and confirm its cron trigger exists. Never print or commit secrets.
3. Call the authenticated dispatch endpoint once, then verify `/robots/:slug` reports a recent **Cloudflare Worker** heartbeat. Play a paper robot, confirm the first run moves RUNNING → COMPLETED or WAITING_APPROVAL, the log contains its structured artifact, and the actual model is `:free` with no paid fallback. Verify a second interval with the browser closed.
4. Verify NO_TRADE, provider 402, 429, timeout, malformed JSON and stale quote failure states. Test two rapid distinct runs, viewer chat persistence and isolation, unsigned news viewing, broker balance consent, and Stop clearing due work. No live broker order is needed for this smoke test.
5. Once the Cloudflare dispatcher has proved stable, remove the scheduled trigger in `.github/workflows/goat-scheduler.yml`. Until then it remains a fallback; do not claim that Cloudflare is currently the only active scheduler.

## Remaining engineering work

- Add a durable request ID and result record to robot chat so a provider success followed by Firestore append failure can be reconciled or retried without a duplicate model charge. Surface quota and provider failure codes directly in the UI.
- Migrate old public runs and gallery metadata explicitly. Eliminate historical timestamp matching after migration. Move gallery cards to an indexed, paginated projection and remove the unbounded index fallback once Firestore indexes are live.
- Make team/member creation and all cleanup operations transactional or record an explicit reconciliation job. Test failure injection at every write boundary.
- Add retention, cost and latency dashboards per robot; monitor dispatch age, due backlog, run success, model identity, response validation, market data freshness and Firestore reads. Alert the owner on a stale heartbeat or repeated failed runs.
- Run a provider-backed paper smoke test with a real free model and validate strict JSON Schema support for the selected model. Expand simulation tests for scheduler generation races, chat concurrency, and signal artifact failure. The existing Bun suite must run in CI; Node cannot load its `bun:` imports in this workspace.
- If conditional research or resumable multi-step work later becomes necessary, introduce a graph with bounded nodes, a real checkpointer, a thread ID tied to `runId`, and a recovery policy. LangGraph is not a scheduler.
