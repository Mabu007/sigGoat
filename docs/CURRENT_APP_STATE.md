# Current app state (2026-10-22)

This document describes the AI robot product now mounted on `main`. Check the live dispatcher heartbeat before relying on scheduled analysis; a stored schedule alone is not a running job.

## User flow and source of truth

| Surface | Current implementation |
| --- | --- |
| `/robots/` | Public gallery of every AI robot, backed by `GET /api/goat-teams/public`. Cards use a 16:9 cover, title, creator, market, and latest thesis. Robot covers are uploaded by the creator through the room cover picker. |
| `/robots/:slug` and old `/team/:slug` links | `PublicTeamView` renders the room. The AI robot branch shows chart, Robot Log, news report, robot chat, details, broker connection, and market indicators. Old `/team/` links remain usable. |
| Create | `AiRobotBuilder` creates a one-member team. The member holds the model, provider, market, and reasoning configuration; the team holds the share slug, room settings, and deployment metadata. |
| Play / Stop | Owner action deploys or pauses the robot. Firestore stores due times, leases, and run history. Play requests an initial analysis. Stop clears due work. |
| Scheduled analysis | External cron must call authenticated `GET /api/internal/cron` with `CRON_SECRET`. The Node API claims due Firestore work and persists the result. The Cloudflare Worker in `worker/src/index.ts` is stateless; no per-robot Durable Object is part of this flow. |
| Robot chat | Authenticated `POST /api/team-rooms/:slug/robot-chat` uses the creator's model and key with market/news/thesis context and the viewer's own broker connection status. It is informational and does not operate the robot. |
| Broker connection | Account connection settings and personal robot copy exist. A public robot's output is **not automatically mirrored as live orders** to every viewer's broker. A personal copy has its own schedule and execution policy. |

The live public Gold Man record had a stored room asset of `USDJPY` while its one AI member analyses `BNB`. Room details, chart, and news now resolve the AI member's market. The gallery repairs the old stored asset on its next read; room settings reject another asset until the robot market itself is changed. Hyperliquid AI robots display native Hyperliquid data; other rooms use BiQuote reference data.

## Production state observed in this audit

- Public health and robot discovery endpoints answered successfully; the Gold Man room and manual BNB analyses were present.
- Firebase authentication, Firestore persistence, and a server OpenRouter key were reported configured by `/api/settings/status`.
- Cloudflare listed `tradingvibes-realtime` and its room coordinator namespace, but no `sirgoat-scheduler` Worker and no per-robot scheduler Durable Objects. The unrelated realtime room system was left intact.
- The GitHub Actions fallback scheduler's recent scheduled runs failed. Gold Man's visible runs were manual, so recurring AI analysis is **not verified working**. Robot Details shows the shared dispatcher's last heartbeat to the owner; a stale or absent heartbeat means the clock is not being advanced.
- The original robot-chat registration preceded the router's authentication middleware, so even a valid signed-in request could not acquire `req.user`. The same defect affected the personal-copy action. Both actions now authenticate explicitly at registration.

## Cleanup and verification

The unmounted legacy chatbot, markets/proposals/backtest/skills/rooms views, and old client GOAT context were removed from the active tree after preserving the pre-audit commit in `archive/legacy-ui-before-robot-audit`. `AiRobotBuilder` moved out of the strategy folder. Active community-room features and server services remain because the room and API still use them. Old tests for deleted screens were replaced with AI robot navigation and room contract checks.

`npm run lint` and `npm run build` pass. The active UI suite passes 36/36 tests. The auth boundary integration regression passes in isolation. The broad historical suite has 817 passes, 74 failures, and one test harness error over 891 tests; it mixes retired GOAT/API contracts, mocked provider expectations, and timing-sensitive scheduler tests. It is not a reliable release gate yet. Do not interpret the 817 passes as a successful full suite.

## Open work

1. Deploy and configure the stateless Cloudflare cron Worker with `SIRGOAT_API_ORIGIN` and a `CRON_SECRET` matching Vercel, or repair and verify the GitHub fallback. Verify a new heartbeat and a completed scheduled robot analysis, then disable the redundant dispatcher.
2. Verify signed-in robot chat against production with a real Firebase session and test the creator's selected free OpenRouter model. The local auth regression confirms the middleware boundary, not a successful model response.
3. Decide and build a separate consent and risk-controlled broker mirroring flow if viewers should receive a public robot's orders. The current public watch and personal copy features do not provide that behavior.
4. Update or archive historical tests and old server endpoints by owner and actual usage, then establish a green robot-focused CI gate. The current full suite reports real failures and cannot be represented as passing.
