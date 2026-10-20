/**
 * EDGE SIGNING
 * ============
 * The Worker verifies the HMAC signatures the API server produces. It must
 * produce byte-identical results to the Node implementation in
 * `src/server/media/mediaSigner.ts`, so the canonical strings live in ONE
 * place: `src/shared/roomProtocol.ts`.
 *
 * Reference implementation of the canonical strings:
 *
 *   upload    media-upload|<purpose>|<key>|<expiry>|<uid>|<maxBytes>
 *   delivery  media-delivery|<key>|<expiry>
 *   service   service|<purpose>|<subject>
 *
 * The signature is base64url(HMAC-SHA256(secret, canonical)) with the
 * padding removed. Node's `createHmac` and the WebCrypto implementation below
 * produce the same bytes.
 */

import { canonicalServiceString } from "../../src/shared/roomProtocol";

export interface UploadTicketPayload {
  p: string;
  k: string;
  e: number;
  u: string;
  m: number;
  /** The image type the ticket was issued for. */
  c: string;
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmac(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return base64UrlEncode(signature);
}

/** Constant-time-ish comparison of two base64url signatures. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** Signs a service request. Mirrors `signServiceRequest` on the API side. */
export async function signServiceRequest(
  purpose: string,
  subject: string,
  secret: string,
): Promise<string> {
  return hmac(secret, canonicalServiceString(purpose, subject));
}

/** Verifies a service request signature. */
export async function verifyServiceSignature(
  purpose: string,
  subject: string,
  signature: string | null,
  env: { ROOM_REALTIME_SECRET: string },
): Promise<boolean> {
  if (!signature || !env.ROOM_REALTIME_SECRET) return false;
  const expected = await signServiceRequest(purpose, subject, env.ROOM_REALTIME_SECRET);
  return safeEqual(expected, signature);
}

/** The canonical upload string. Must match the API side exactly. */
export function canonicalUploadString(payload: UploadTicketPayload): string {
  return [
    "media-upload",
    payload.p,
    payload.k,
    String(payload.e),
    payload.u,
    String(payload.m),
    payload.c,
  ].join("|");
}

/** The canonical delivery string. Must match the API side exactly. */
export function canonicalDeliveryString(key: string, expiry: number): string {
  return ["media-delivery", key, String(expiry)].join("|");
}

/**
 * Verifies an upload ticket.
 *
 * Returns the payload when the ticket is genuine and unexpired, and null
 * otherwise. A ticket that fails any check is not partially trusted.
 */
export async function verifyUploadTicket(
  ticket: string | null,
  env: { ROOM_REALTIME_SECRET: string },
): Promise<UploadTicketPayload | null> {
  if (!ticket || !env.ROOM_REALTIME_SECRET) return null;
  const separator = ticket.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);

  let payload: UploadTicketPayload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
    payload = parsed as UploadTicketPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.k !== "string" || typeof payload.e !== "number") {
    return null;
  }
  if (payload.e * 1000 < Date.now()) return null;
  if (!/^(avatars|covers)\/[A-Za-z0-9_-]{1,64}\/[a-z0-9-]+\.[a-z0-9]{1,5}$/.test(payload.k)) {
    return null;
  }

  const expected = await hmac(
    env.ROOM_REALTIME_SECRET,
    canonicalUploadString(payload),
  );
  if (!safeEqual(expected, signature)) return null;
  return payload;
}

/** Verifies a delivery signature for an object key. */
export async function verifyDeliverySignature(
  key: string,
  expiry: number,
  signature: string | null,
  env: { ROOM_REALTIME_SECRET: string },
): Promise<boolean> {
  if (!signature || !env.ROOM_REALTIME_SECRET) return false;
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return false;
  const expected = await hmac(
    env.ROOM_REALTIME_SECRET,
    canonicalDeliveryString(key, expiry),
  );
  return safeEqual(expected, signature);
}
