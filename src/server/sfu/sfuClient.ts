/**
 * CLOUDFLARE REALTIME SFU CLIENT
 * ===============================
 * A thin, typed wrapper over the documented Cloudflare Realtime SFU
 * Connection API.
 *
 *   base url : https://rtc.live.cloudflare.com/v1
 *   auth     : Authorization: Bearer <APP SECRET>
 *
 * The App Secret never leaves the server. The browser receives only the
 * session id and the SDP answer the SFU produced.
 *
 * CREDENTIALS
 * -----------
 * Two values are needed:
 *
 *   CLOUDFLARE_SFU_APP_ID   - the SFU application's id
 *   CLOUDFLARE_SFU_API_KEY  - the SFU application's SECRET, used as the
 *                             bearer token
 *
 * `CLOUDFLARE_SFU_API_KEY` is the name the environment already uses. The
 * value it holds must be the App Secret, NOT a general Cloudflare API token:
 * the SFU Connection API authenticates with the app secret, and an account
 * API token is not interchangeable with it. If the value in the environment
 * turns out to be an account-level API token, set
 * `CLOUDFLARE_SFU_BEARER_TOKEN` to the App Secret instead — it takes
 * precedence — and the account token remains usable for account management.
 *
 * Reference: https://developers.cloudflare.com/realtime/sfu/api/
 */

export interface SfuTrackRequest {
  location: "local" | "remote";
  mid?: string;
  trackName?: string;
  sessionId?: string;
}

export interface SfuSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface SfuTrackResult {
  location: "local" | "remote";
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface SfuTracksResponse {
  sessionDescription?: SfuSessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: SfuTrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

export interface SfuSessionInfo {
  sessionId?: string;
  tracks?: { location: string; mid: string; trackName: string; status: string }[];
  dataChannels?: unknown[];
}

const SFU_BASE_URL = "https://rtc.live.cloudflare.com/v1";
const REQUEST_TIMEOUT_MS = 12_000;

export interface SfuConfig {
  appId: string;
  bearerToken: string;
}

export function resolveSfuConfig(): SfuConfig | null {
  const appId = process.env.CLOUDFLARE_SFU_APP_ID?.trim();
  const bearerToken =
    process.env.CLOUDFLARE_SFU_BEARER_TOKEN?.trim() ||
    process.env.CLOUDFLARE_SFU_API_KEY?.trim();
  if (!appId || !bearerToken) return null;
  return { appId, bearerToken };
}

export function isSfuConfigured(): boolean {
  return resolveSfuConfig() !== null;
}

/** Why the SFU is unavailable, for the status endpoint. Never leaks a value. */
export function sfuUnavailableReason(): string | undefined {
  if (isSfuConfigured()) return undefined;
  const hasAppId = Boolean(process.env.CLOUDFLARE_SFU_APP_ID?.trim());
  const hasKey = Boolean(
    process.env.CLOUDFLARE_SFU_BEARER_TOKEN?.trim() ||
      process.env.CLOUDFLARE_SFU_API_KEY?.trim(),
  );
  if (!hasAppId && !hasKey) {
    return "CLOUDFLARE_SFU_APP_ID and CLOUDFLARE_SFU_API_KEY are not set.";
  }
  if (!hasAppId) return "CLOUDFLARE_SFU_APP_ID is not set.";
  return "CLOUDFLARE_SFU_API_KEY is not set.";
}

export class SfuApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SfuApiError";
  }
}

async function sfuRequest<T>(
  config: SfuConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${SFU_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const errorBody = body as { errorCode?: string; errorDescription?: string } | null;
      throw new SfuApiError(
        errorBody?.errorDescription || `SFU request failed (${response.status})`,
        response.status,
        errorBody?.errorCode,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof SfuApiError) throw error;
    throw new SfuApiError(
      error instanceof Error ? error.message : "SFU request failed",
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Creates an SFU session. The id identifies one WebRTC connection. */
export async function createSession(
  config: SfuConfig,
): Promise<{ sessionId: string }> {
  const result = await sfuRequest<{ sessionId: string }>(
    config,
    `/apps/${encodeURIComponent(config.appId)}/sessions/new`,
    { method: "POST" },
  );
  if (!result?.sessionId) {
    throw new SfuApiError("SFU did not return a session id", 502);
  }
  return result;
}

/** Publishes local tracks or subscribes to remote ones. */
export async function createTracks(
  config: SfuConfig,
  sessionId: string,
  body: { sessionDescription?: SfuSessionDescription; tracks: SfuTrackRequest[] },
): Promise<SfuTracksResponse> {
  return sfuRequest<SfuTracksResponse>(
    config,
    `/apps/${encodeURIComponent(config.appId)}/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
    { method: "POST", body },
  );
}

/** Submits the browser's answer to an SFU offer. */
export async function renegotiate(
  config: SfuConfig,
  sessionId: string,
  body: { sessionDescription: SfuSessionDescription },
): Promise<SfuTracksResponse> {
  return sfuRequest<SfuTracksResponse>(
    config,
    `/apps/${encodeURIComponent(config.appId)}/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
    { method: "PUT", body },
  );
}

/** Closes tracks. `force` stops forwarding without an SDP exchange. */
export async function closeTracks(
  config: SfuConfig,
  sessionId: string,
  body: { tracks: { mid?: string }[]; sessionDescription?: SfuSessionDescription; force?: boolean },
): Promise<SfuTracksResponse> {
  return sfuRequest<SfuTracksResponse>(
    config,
    `/apps/${encodeURIComponent(config.appId)}/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
    { method: "PUT", body },
  );
}

/** Reads what the SFU knows about a session. */
export async function getSession(
  config: SfuConfig,
  sessionId: string,
): Promise<SfuSessionInfo> {
  return sfuRequest<SfuSessionInfo>(
    config,
    `/apps/${encodeURIComponent(config.appId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
  );
}
