# TRADINGVIBES REALTIME WORKER

The live-room runtime. It is a **separate Cloudflare deployment** from the
web application, and the two have to be pointed at each other by hand.

```
   Browser ──wss──▶  Worker ──▶ Durable Object (one per room)
      │                │  ▲
      │                │  │  signed service calls (room access, snapshots)
      │                ▼  │
      │             API server ──▶ Firestore (durable records)
      │                │
      └────PUT media──▶ Worker ──▶ R2 (avatars, room covers)
```

## What it owns

| Concern | Where it lives |
|---|---|
| Shared chart symbol, timeframe, drawings | Durable Object storage (per room) |
| Presence, live session state, voice roster | Durable Object, broadcast to the room |
| Durable copy of the shared chart | Firestore, written as a throttled snapshot |
| Avatars, room covers | R2, private bucket, signed delivery |
| Voice media | Cloudflare Realtime SFU (the API server holds the secret) |

## DEPLOYMENT STATUS

**DEPLOYED.**

```
https://tradingvibes-realtime.gtebogo75.workers.dev
```

- Worker: `tradingvibes-realtime`, Durable Object class `RoomCoordinator`
  (SQLite-backed, migration `v1`), R2 binding `IMAGES` -> the `tradingvibes`
  bucket.
- `ROOM_REALTIME_SECRET` is set as a Worker SECRET and as a Vercel
  environment variable for the production and preview environments.
- `ROOM_REALTIME_URL` is set on Vercel for the same environments.
- The Worker can be reached: `GET /health` answers
  `{"ok":true,"protocolVersion":1}`.

The shared chart, the drawings, the presence list and the live session state
are verified end to end against the deployed Worker with two independent
clients.

## One-time setup

```sh
cd realtime

# 1. The bucket. It is private by default.
wrangler r2 bucket create tradingvibes

# 2. The shared secret. It must be the SAME value on both sides.
wrangler secret put ROOM_REALTIME_SECRET
```

Then edit `realtime/wrangler.toml`:

```toml
[vars]
ROOM_API_ORIGIN = "https://sig-goat.vercel.app"
FIREBASE_PROJECT_ID = "sirgoat-b10b5"
```

## Deploy

```sh
cd realtime
wrangler deploy
```

Wrangler prints the workers.dev url. Put it in the API server's environment:

```
ROOM_REALTIME_URL="https://tradingvibes-realtime.<subdomain>.workers.dev"
ROOM_REALTIME_SECRET="<the same value you put in the Worker secret>"
```

**Neither of those variables configures the Worker.** The Worker needs the
API's url; the API needs the Worker's url. Deploying the Vercel frontend
does not deploy the Worker, and setting `ROOM_REALTIME_URL` does not create
the bucket.

## Verifying a deployment

```sh
curl https://<worker-url>/health
# {"ok":true,"service":"tradingvibes-realtime","protocolVersion":1,...}
```

Then, from the API server:

```sh
curl -s https://<api-host>/api/realtime/status | jq
# { "realtime": { "configured": true, "url": "https://..." },
#   "voice":    { "configured": false, "reason": "..." },
#   "media":    { "configured": true, ... } }
```

`realtime.configured` is false until BOTH `ROOM_REALTIME_URL` and
`ROOM_REALTIME_SECRET` are set on the API side.

## Room access

The Worker holds no membership data and no Firebase Admin credentials. When
a socket opens it asks the API:

```
GET {ROOM_API_ORIGIN}/api/internal/rooms/access?roomId=…&uid=…
x-tradingvibes-service: <hmac>
```

The API answers from the authoritative store, and the Worker's Firebase ID
token verification has already proved who the caller is. The Durable Object
receives that ANSWER — it never has to trust a uid a client chose.

## Media

Uploads are a three-step, server-signed flow:

1. `POST /api/media/upload-ticket` (API) → a signed ticket with a
   server-generated object key, a size limit and a 10 minute expiry.
2. `PUT {ticket.uploadUrl}` (Worker) → the Worker verifies the ticket, checks
   the size, and checks the MAGIC BYTES of the file. A file that is not
   actually an image is rejected with 415.
3. `POST /api/media/commit` (API) → the API checks that the key belongs to
   this caller and this purpose, and records the reference.

Delivery is `GET {worker}/media/{key}?e=…&s=…` with a signed, expiring url,
unless `R2_PUBLIC_BASE_URL` is configured, in which case the API hands out
the public domain url instead.

## Voice

Voice is NOT in the Worker. The API server holds the SFU App Secret and
performs every SFU API call; the browser receives only a session id and the
SDP answer. See `src/server/sfu/sfuClient.ts`.

The SFU is configured in production: `CLOUDFLARE_SFU_APP_ID` and
`CLOUDFLARE_SFU_API_KEY` are set, and `GET /api/rooms/:id/voice` reports
`configured: true`.

## THE RUNTIME FACTS THAT COST THREE DEPLOYMENTS

These are the differences between the documented API and the runtime, and
each of them fails SILENTLY, so they are written down.

1. **The signing keys come from the JWK endpoint, not the X.509 one.** A
   certificate's DER is not a SubjectPublicKeyInfo, so
   `importKey('spki', ...)` rejects it with "Invalid keyData" and every
   token looks invalid. The JWK endpoint
   (`service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`) serves
   the same keys — the `kid` sets overlap exactly — in the format WebCrypto
   imports directly.

2. **A WebSocket upgrade must be forwarded UNCHANGED.** Rebuilding the
   request to add a header (`new Request(request, { headers })`) drops the
   upgrade, and the client sees "non-101 status code" while the Worker logs
   a cheerful "Ok". The Durable Object therefore makes the access decision
   itself and the Worker only routes.

3. **A hibernating Durable Object loses `addEventListener` listeners.** The
   object must implement `webSocketMessage` / `webSocketClose` /
   `webSocketError`, and it must identify a socket by the TAG attached with
   `acceptWebSocket(socket, [id])` — `getTags(socket)` reads it back after a
   restart. `setWebSocketMetadata` does not exist in this runtime.

4. **The alarm clock is on the STORAGE, not the state.**
   `state.storage.setAlarm(...)`; `state.setAlarm` is not a function.

5. **`state.getWebSockets()` and `blockConcurrencyWhile()` do exist** and are
   used to rebuild the live connections after a restart.

## Cost and quotas

- Durable Objects are billed while a room has open sockets. A room nobody is
  in costs nothing.
- R2 storage and egress are metered; avatars and covers are small.
- The SFU bills per published audio track. It has a free allowance that is
  exhausted by a busy room; check Cloudflare's current limits before
  promising a free voice tier.
- Firestore reads are the quota that has historically run out. The design
  keeps the hot path off Firestore: a drawing drag crosses the socket, not
  the database, and the durable snapshot is written at most once every 30
  seconds per room.

No free tier is unlimited. Do not promise one.
