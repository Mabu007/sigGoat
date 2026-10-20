/**
 * R2 MEDIA AT THE EDGE
 * ====================
 * Uploads and delivery for avatars and room covers.
 *
 * THE FLOW
 * --------
 *   1. The browser asks the API for an upload ticket. The API decides the
 *      object key, the size limit and the expiry, and signs the ticket.
 *   2. The browser PUTs the bytes to /media/upload with that ticket.
 *   3. The Worker verifies the ticket, checks the bytes, and writes to R2.
 *   4. The browser tells the API it is done; the API records the reference.
 *
 * The browser never holds an R2 credential, and the Worker never trusts a
 * key the browser chose.
 *
 * The bucket is PRIVATE. Images are served through the signed delivery route
 * below, unless a public R2 domain is configured on the API side, in which
 * case the API hands out the public url instead.
 */

import { detectMediaType, MEDIA_MAX_BYTES } from "../../src/types/rooms";
import { verifyDeliverySignature, verifyUploadTicket } from "./signing";

interface MediaEnv {
  IMAGES: R2Bucket;
  ROOM_REALTIME_SECRET: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleMediaRequest(
  request: Request,
  env: MediaEnv,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/media/upload" && request.method === "PUT") {
    return handleUpload(request, env, url);
  }

  const keyMatch = url.pathname.match(/^\/media\/([^/]+(?:\/[^/]+){0,3})$/);
  if (!keyMatch) {
    return json({ error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404);
  }
  const key = decodeURIComponent(keyMatch[1]);

  if (request.method === "GET") {
    return handleDelivery(env, url, key);
  }
  if (request.method === "DELETE") {
    return handleDelete(request, env, key);
  }
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use GET, PUT or DELETE." } }, 405);
}

async function handleUpload(
  request: Request,
  env: MediaEnv,
  url: URL,
): Promise<Response> {
  const ticket =
    url.searchParams.get("t") ?? request.headers.get("x-tradingvibes-ticket");
  const payload = await verifyUploadTicket(ticket, env);
  if (!payload) {
    return json(
      { error: { code: "INVALID_TICKET", message: "The upload ticket is invalid or has expired." } },
      401,
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > payload.m || declaredLength > MEDIA_MAX_BYTES) {
    return json(
      { error: { code: "IMAGE_TOO_LARGE", message: "That image is larger than the limit." } },
      413,
    );
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return json({ error: { code: "EMPTY_UPLOAD", message: "No image data was sent." } }, 400);
  }
  if (body.byteLength > payload.m || body.byteLength > MEDIA_MAX_BYTES) {
    return json(
      { error: { code: "IMAGE_TOO_LARGE", message: "That image is larger than the limit." } },
      413,
    );
  }

  /**
   * The declared content type proves nothing, so the bytes decide. A file
   * that is not actually an image is rejected here rather than being stored
   * and served back with an image content type.
   */
  const detected = detectMediaType(new Uint8Array(body));
  if (!detected) {
    return json(
      { error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "That file is not a supported image." } },
      415,
    );
  }

  /**
   * The SIGNED intent wins. The ticket says what the server was willing to
   * accept, and the bytes have to agree with it. A browser that declares a
   * different content type is tolerated as long as the bytes and the
   * ticket agree — the declared type is a hint, not an authority.
   */
  if (payload.c && payload.c !== detected) {
    return json(
      { error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "That image type does not match its contents." } },
      415,
    );
  }

  const declaredType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (
    declaredType &&
    declaredType !== "application/octet-stream" &&
    declaredType !== detected
  ) {
    return json(
      { error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "The image type does not match its contents." } },
      415,
    );
  }

  await env.IMAGES.put(payload.k, body, {
    httpMetadata: { contentType: detected, cacheControl: "public, max-age=31536000, immutable" },
  });

  return json({ ok: true, key: payload.k, contentType: detected, size: body.byteLength });
}

async function handleDelivery(
  env: MediaEnv,
  url: URL,
  key: string,
): Promise<Response> {
  const expiry = Number(url.searchParams.get("e") ?? "0");
  const signature = url.searchParams.get("s");
  const valid = await verifyDeliverySignature(key, expiry, signature, env);
  if (!valid) {
    return json(
      { error: { code: "INVALID_SIGNATURE", message: "This image link is invalid or has expired." } },
      403,
    );
  }

  const object = await env.IMAGES.get(key);
  if (!object) {
    return json({ error: { code: "NOT_FOUND", message: "That image does not exist." } }, 404);
  }

  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("cache-control", "private, max-age=3600");
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function handleDelete(
  request: Request,
  env: MediaEnv,
  key: string,
): Promise<Response> {
  const { verifyServiceSignature } = await import("./signing");
  const { mediaSubject } = await import("../../src/shared/roomProtocol");
  const signature = request.headers.get("x-tradingvibes-service");
  const valid = await verifyServiceSignature(
    "media-delete",
    mediaSubject(key),
    signature,
    env,
  );
  if (!valid) {
    return json(
      { error: { code: "INVALID_SERVICE_SIGNATURE", message: "Service signature rejected." } },
      401,
    );
  }
  await env.IMAGES.delete(key);
  return json({ ok: true });
}
