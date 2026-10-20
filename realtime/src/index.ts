/**
 * TRADINGVIBES REALTIME WORKER
 * ============================
 * The Cloudflare Worker that backs a live TradingVibes room.
 *
 * FOUR RESPONSIBILITIES, FOUR PLACES
 * -----------------------------------
 *   1. WEBSOCKET ENDPOINTS  -> one Durable Object per room
 *   2. R2 MEDIA             -> signed uploads and signed delivery
 *   3. FIREBASE ID TOKENS   -> verified at the edge, before a socket opens
 *   4. API CALLBACKS        -> authorization and durable snapshots
 *
 * WHY A DURABLE OBJECT PER ROOM
 * -----------------------------
 * A room's shared state (symbol, timeframe, drawings, presence) must be
 * consistent for everyone in the room and must survive the Worker being
 * evicted. A Durable Object gives exactly one instance per room id, with
 * its own storage, and it stays alive while a room is busy.
 *
 * The Durable Object's storage is NOT the room's permanent record. It is a
 * fast, recoverable cache. The permanent record lives in Firestore, and the
 * Worker writes a throttled snapshot there.
 *
 * Reference: https://developers.cloudflare.com/durable-objects/
 */

import { RoomCoordinator } from "./roomCoordinator";
import { handleMediaRequest } from "./media";
import { verifyServiceSignature } from "./signing";
import {
  roomSubject,
  ROOM_PROTOCOL_VERSION,
  type RoomRealtimeState,
} from "../../src/shared/roomProtocol";

export interface Env {
  /** Durable Object namespace: one instance per room. */
  ROOM_COORDINATOR: DurableObjectNamespace<RoomCoordinator>;
  /** R2 bucket holding avatars and room covers. */
  IMAGES: R2Bucket;
  /** Shared HMAC secret. A secret, never a var. */
  ROOM_REALTIME_SECRET: string;
  /** The API server's base url, used for authorization and snapshots. */
  ROOM_API_ORIGIN: string;
  /** Firebase project id; the ID token's audience must match it. */
  FIREBASE_PROJECT_ID: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * CORS for the browser-facing endpoints.
 *
 * The media upload and delivery routes are called directly by the browser,
 * so they need a CORS preflight. The socket and internal routes do not.
 */
function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-tradingvibes-ticket,x-tradingvibes-service",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  if (origin && allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/**
 * IS THIS SOCKET COMING FROM THE APP?
 *
 * The Firebase ID token is the credential, so a socket is already
 * authenticated. The origin check is defence in depth: it stops a page on
 * another site from opening a room socket with a token it somehow obtained,
 * and it costs one comparison.
 *
 * A request with NO origin header is allowed: that is a non-browser client
 * (a test harness, a server), and it still has to present a valid token.
 */
function originAllowed(request: Request, allowedOrigins: string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // A local development server is always allowed.
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  } catch {
    return false;
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowedOrigins = (env.ROOM_API_ORIGIN ?? "")
      .split(",")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(Boolean);

    // -- media (browser facing) -------------------------------------------
    if (url.pathname.startsWith("/media/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, allowedOrigins),
        });
      }
      const response = await handleMediaRequest(request, env, url);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(origin, allowedOrigins))) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    }

    // -- internal service routes (Worker -> API and API -> Worker) ---------
    if (url.pathname.startsWith("/internal/")) {
      return handleInternal(request, env, url);
    }

    // -- websocket ---------------------------------------------------------
    const socketMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{1,120})\/socket$/);
    if (socketMatch) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: { code: "UPGRADE_REQUIRED", message: "This endpoint expects a WebSocket upgrade." } }, 426);
      }
      return handleSocketUpgrade(request, env, url, socketMatch[1]);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "tradingvibes-realtime",
        protocolVersion: ROOM_PROTOCOL_VERSION,
        time: new Date().toISOString(),
      });
    }

    return json(
      { error: { code: "NOT_FOUND", message: "No such endpoint." } },
      404,
    );
  },
};

/**
 * Opens the room socket.
 *
 * THE REQUEST IS FORWARDED UNCHANGED.
 *
 * A Durable Object only sees a WebSocket upgrade if the request that
 * reaches it IS the upgrade request. Rebuilding it — `new Request(request,
 * { headers })`, which is how a header would normally be added — drops the
 * upgrade, and the client gets "non-101 status code" with no error anywhere.
 * So the access decision is NOT smuggled through a header: the Durable
 * Object makes it itself, and the Worker only checks the origin and routes.
 *
 * The Durable Object verifies the Firebase token and asks the API whether
 * the caller may be in the room, so the authorization decision is made in
 * ONE place, by the component that owns the room.
 */
async function handleSocketUpgrade(
  request: Request,
  env: Env,
  url: URL,
  roomId: string,
): Promise<Response> {
  const allowedOrigins = (env.ROOM_API_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (!originAllowed(request, allowedOrigins)) {
    return json(
      { error: { code: "ORIGIN_NOT_ALLOWED", message: "This socket may only be opened by the app." } },
      403,
    );
  }

  const stub = env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(roomId));
  return stub.fetch(request);
}

/**
 * The internal routes.
 *
 *   POST /internal/rooms/:roomId/session  - the API pushes a session state
 *   POST /internal/rooms/:roomId/voice    - the API pushes a voice roster
 *   GET  /internal/rooms/:roomId/state    - read the live room state
 *
 * All of them are authenticated with the same shared secret, so an
 * unauthenticated caller cannot inject a session into a room.
 */
async function handleInternal(request: Request, env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/internal\/rooms\/([A-Za-z0-9_-]{1,120})\/(\w+)$/);
  if (!match) {
    return json({ error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404);
  }
  const roomId = match[1];
  const action = match[2];
  const signature = request.headers.get("x-tradingvibes-service");

  const expectedPurpose =
    action === "session" ? "room-session" : action === "voice" ? "room-voice" : "room-state";
  const valid = await verifyServiceSignature(expectedPurpose, roomSubject(roomId), signature, env);
  if (!valid) {
    return json(
      { error: { code: "INVALID_SERVICE_SIGNATURE", message: "Service signature rejected." } },
      401,
    );
  }

  const stub = env.ROOM_COORDINATOR.get(env.ROOM_COORDINATOR.idFromName(roomId));

  if (action === "state" && request.method === "GET") {
    const response = await stub.fetch(new Request("https://internal/rooms/state", { method: "GET" }));
    return new Response(response.body, { status: response.status, headers: JSON_HEADERS });
  }

  if (action === "session" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { session?: unknown };
    const response = await stub.fetch(
      new Request("https://internal/rooms/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return new Response(response.body, { status: response.status, headers: JSON_HEADERS });
  }

  if (action === "voice" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { roster?: unknown };
    const response = await stub.fetch(
      new Request("https://internal/rooms/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return new Response(response.body, { status: response.status, headers: JSON_HEADERS });
  }

  return json({ error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404);
}

export type { RoomRealtimeState };

/**
 * The Durable Object class MUST be exported from the entrypoint, or Wrangler
 * cannot bind it to the `ROOM_COORDINATOR` namespace.
 */
export { RoomCoordinator } from "./roomCoordinator";
