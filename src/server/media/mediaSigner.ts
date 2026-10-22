/**
 * MEDIA TICKET SIGNING
 * ====================
 * Browser uploads go to the Cloudflare Worker, which owns the R2 binding. The
 * browser must not hold an R2 credential, and the Worker must not trust a
 * key the browser chose. So the API server signs a short-lived ticket and the
 * Worker verifies it before it writes anything.
 *
 * The signature is HMAC-SHA256 over a canonical string. The Worker
 * recomputes it with WebCrypto and compares. The two implementations
 * (node:crypto here, WebCrypto in realtime/src/signing.ts) MUST stay in
 * step — the canonical string format is the contract.
 *
 * Ticket format:  <base64url(payload)>.<base64url(signature)>
 * Delivery format: ?e=<expiry>&s=<base64url(signature)>
 *
 * The signing secret is shared between the API server and the Worker and is
 * never sent to the browser.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  type MediaPurpose,
} from "../../types/rooms";
import { MEDIA_TICKET_TTL_MS } from "../../shared/roomProtocol";

export type TicketPurpose = "media-upload" | "media-delivery" | "service";

export interface MediaTicketPayload {
  /** Ticket purpose. */
  p: MediaPurpose;
  /** R2 object key. */
  k: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** The Firebase uid the ticket was issued to. */
  u: string;
  /** Maximum accepted upload size in bytes. */
  m: number;
  /**
   * The image type the ticket was issued for.
   *
   * It is SIGNED, so the Worker knows what the server intended to accept
   * without trusting anything the browser declares. The Worker compares it
   * with the type it detects from the bytes.
   */
  c: string;
}

export interface UploadTicket {
  key: string;
  uploadUrl: string;
  expiresAt: string;
  headers: Record<string, string>;
  purpose: MediaPurpose;
  maxBytes: number;
  allowedTypes: string[];
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

function secretBytes(): Buffer | null {
  const secret = process.env.ROOM_REALTIME_SECRET?.trim();
  if (!secret) return null;
  return Buffer.from(secret, "utf8");
}

/** The canonical string that is signed. Keep this in step with the Worker. */
export function canonicalUploadString(payload: MediaTicketPayload): string {
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

export function canonicalDeliveryString(key: string, expiry: number): string {
  return ["media-delivery", key, String(expiry)].join("|");
}

export function canonicalServiceString(purpose: string, subject: string): string {
  return ["service", purpose, subject].join("|");
}

function sign(canonical: string): string | null {
  const secret = secretBytes();
  if (!secret) return null;
  return base64UrlEncode(createHmac("sha256", secret).update(canonical).digest());
}

/** Constant-time comparison of two base64url signatures. */
export function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True when media signing is configured at all. */
export function isMediaSigningConfigured(): boolean {
  return Boolean(process.env.ROOM_REALTIME_SECRET?.trim());
}

/** The public base url of the realtime Worker, without a trailing slash. */
export function realtimeWorkerUrl(): string | null {
  const url = process.env.ROOM_REALTIME_URL?.trim().replace(/\/+$/, "");
  return url || null;
}

export function mediaConfigured(): boolean {
  return isMediaSigningConfigured() && Boolean(realtimeWorkerUrl());
}

/** Builds a signed upload ticket for an already-generated object key. */
export function createUploadTicket(input: {
  key: string;
  purpose: MediaPurpose;
  uid: string;
  contentType: string;
  maxBytes?: number;
  ttlMs?: number;
}): UploadTicket | null {
  const worker = realtimeWorkerUrl();
  if (!worker || !isMediaSigningConfigured()) return null;

  const maxBytes = input.maxBytes ?? MEDIA_MAX_BYTES;
  const expiresAtMs = Date.now() + (input.ttlMs ?? MEDIA_TICKET_TTL_MS);
  const payload: MediaTicketPayload = {
    p: input.purpose,
    k: input.key,
    e: Math.floor(expiresAtMs / 1000),
    u: input.uid,
    m: maxBytes,
    c: input.contentType,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(canonicalUploadString(payload));
  if (!signature) return null;

  return {
    key: input.key,
    uploadUrl: `${worker}/media/upload?t=${encoded}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
    headers: {
      "content-type": input.contentType,
      "x-tradingvibes-ticket": `${encoded}.${signature}`,
    },
    purpose: input.purpose,
    maxBytes,
    allowedTypes: MEDIA_ALLOWED_TYPES,
  };
}

/** Builds a signed delivery url for an object key. */
export function createDeliveryUrl(
  key: string,
  options: { ttlMs?: number } = {},
): string | null {
  const worker = realtimeWorkerUrl();
  if (!worker) return null;

  // A configured public R2 domain serves the object directly and needs no
  // signature. The bucket's public access is an explicit, separate decision.
  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (publicBase) return `${publicBase}/${key}`;

  if (!isMediaSigningConfigured()) return null;
  const expiry = Math.floor((Date.now() + (options.ttlMs ?? 24 * 60 * 60 * 1000)) / 1000);
  const signature = sign(canonicalDeliveryString(key, expiry));
  if (!signature) return null;
  return `${worker}/media/${encodeURIComponent(key)}?e=${expiry}&s=${signature}`;
}

/**
 * A safe, server-generated object key.
 *
 * The key never contains a user-supplied filename, a path separator, or
 * anything that could escape the key namespace. The extension is derived
 * from the DETECTED content type, not from the filename.
 *
 * Room covers and avatars use separate namespaced object keys.
 */
export function buildMediaKey(input: {
  purpose: MediaPurpose;
  uid: string;
  contentType: string;
  random: string;
}): string {
  const folder = input.purpose === "avatar" ? "avatars" : "covers";
  const safeUid = input.uid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || 'anon';
  const extension =
    input.contentType === 'image/png'
      ? 'png'
      : input.contentType === 'image/webp'
        ? 'webp'
        : input.contentType === 'image/gif'
          ? 'gif'
          : 'jpg';
  const safeRandom = input.random.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  return `${folder}/${safeUid}/${Date.now().toString(36)}-${safeRandom}.${extension}`;
}

/** Signs an internal service call from the Worker to the API (or back). */
export function signServiceRequest(purpose: string, subject: string): string | null {
  return sign(canonicalServiceString(purpose, subject));
}

export function verifyServiceRequest(
  purpose: string,
  subject: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = sign(canonicalServiceString(purpose, subject));
  if (!expected) return false;
  return signaturesMatch(expected, signature);
}
