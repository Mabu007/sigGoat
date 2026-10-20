/**
 * REALTIME WORKER GATEWAY
 * =======================
 * The API server's outbound calls to the Cloudflare realtime Worker.
 *
 * TWO RULES
 * ---------
 * 1. The Worker is a SEPARATE deployment. A Vercel environment variable does
 *    not configure it, and deploying the frontend does not deploy it. Every
 *    call here therefore goes to an explicit base url, and every call fails
 *    LOUDLY but harmlessly when the Worker is not configured — the room keeps
 *    working, it just does not broadcast.
 *
 * 2. The browser never calls these endpoints. Service calls are signed with
 *    the shared secret, so an unauthenticated caller cannot push a fake
 *    session state into a room.
 */

import { signServiceRequest, realtimeWorkerUrl, isMediaSigningConfigured } from "../media/mediaSigner";

const REQUEST_TIMEOUT_MS = 8_000;

export function isRealtimeConfigured(): boolean {
  return Boolean(realtimeWorkerUrl()) && isMediaSigningConfigured();
}

function serviceHeaders(purpose: string, subject: string): Record<string, string> {
  const signature = signServiceRequest(purpose, subject);
  return {
    "content-type": "application/json",
    "x-tradingvibes-service": signature ?? "",
  };
}

async function callWorker(
  path: string,
  init: { method: string; purpose: string; subject: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = realtimeWorkerUrl();
  if (!base) return { ok: false, status: 0, body: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: serviceHeaders(init.purpose, init.subject),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    console.warn(
      `[realtime] Worker call failed (${init.method} ${path}):`,
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** Broadcasts the authoritative session state into a room. */
export async function pushSessionState(
  roomId: string,
  session: unknown,
): Promise<boolean> {
  if (!isRealtimeConfigured()) return false;
  const result = await callWorker(`/internal/rooms/${encodeURIComponent(roomId)}/session`, {
    method: "POST",
    purpose: "room-session",
    subject: roomId,
    body: { session },
  });
  return result.ok;
}

/** Broadcasts the current voice roster into a room. */
export async function pushVoiceRoster(
  roomId: string,
  roster: unknown,
): Promise<boolean> {
  if (!isRealtimeConfigured()) return false;
  const result = await callWorker(`/internal/rooms/${encodeURIComponent(roomId)}/voice`, {
    method: "POST",
    purpose: "room-voice",
    subject: roomId,
    body: { roster },
  });
  return result.ok;
}

/** Reads the live room state held by the Durable Object. */
export async function fetchRoomState(roomId: string): Promise<unknown | null> {
  if (!isRealtimeConfigured()) return null;
  const result = await callWorker(`/internal/rooms/${encodeURIComponent(roomId)}/state`, {
    method: "GET",
    purpose: "room-state",
    subject: roomId,
  });
  if (!result.ok || !result.body) return null;
  const body = result.body as { state?: unknown };
  return body?.state ?? null;
}

/** Removes an object from R2. Used to clean up a replaced image. */
export async function deleteMediaObject(key: string): Promise<boolean> {
  if (!isRealtimeConfigured()) return false;
  const result = await callWorker(`/media/${encodeURIComponent(key)}`, {
    method: "DELETE",
    purpose: "media-delete",
    subject: key,
  });
  return result.ok;
}
