/**
 * PROFILE PICTURE CLIENT
 * ======================
 * The browser half of an image upload (Cloudflare R2), as a transport.
 *
 * THE FLOW
 * --------
 *   1. POST /api/media/upload-ticket  -> a signed ticket (key, url, headers)
 *   2. PUT  ticket.uploadUrl          -> the BYTES go to the Worker, not here
 *   3. POST /api/media/commit         -> the server records the reference
 *
 * The browser never holds an R2 credential and never names the object key:
 * the server decides both. The Worker answers the PUT with the content type
 * it DETECTED from the bytes, which is the truth — a browser-declared MIME
 * type proves nothing.
 *
 * PROGRESS, HONESTLY
 * ------------------
 * `fetch` cannot report upload progress, so the PUT uses XMLHttpRequest and
 * reads `xhr.upload.onprogress`. That number is the real transferred-byte
 * ratio and is reported as such. The commit step is a small JSON round trip
 * with nothing measurable in it, so the bar HOLDS at the last measured value
 * and completes when the server confirms. No step is ever faked, and the
 * "committing" phase never pretends to move.
 *
 * DELETION
 * --------
 * There is no route that deletes an object by key. The browser may only ask
 * the server to remove ITS OWN picture, through `/api/media/remove`, which
 * clears the profile reference and deletes the object in one server-side
 * step. A staged upload that is discarded leaves an orphan object behind;
 * cleaning those up is a server-side job (see profilePictureState.ts).
 */

import type { MediaPurpose, MediaUploadTicket } from '../types/rooms';
import {
  MediaApiError,
  UploadAbortedError,
  MEDIA_NOT_AVAILABLE_MESSAGE,
  type MediaTransport,
  type UploadedBytes,
} from './profilePictureState';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

function readErrorCode(payload: unknown): string | undefined {
  const body = payload as ErrorPayload | null;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

function readErrorMessage(payload: unknown): string | undefined {
  const body = payload as ErrorPayload | null;
  const message = body?.error?.message;
  return typeof message === 'string' && message ? message : undefined;
}

type AuthHeaderGetter = () => Promise<Record<string, string>>;

/** A POST to the API, with auth, that reports the server's own error text. */
async function postJson<T>(
  path: string,
  body: unknown,
  getAuthHeaders: AuthHeaderGetter,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(await getAuthHeaders()),
  };

  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new MediaApiError(
      readErrorMessage(payload) ?? 'The server rejected that request.',
      response.status,
      readErrorCode(payload),
    );
  }

  return (payload ?? {}) as T;
}

interface MediaStatusResponse {
  media?: { configured?: boolean; maxBytes?: number; allowedTypes?: string[] };
}

let mediaStatusPromise: Promise<MediaStatusResponse | null> | null = null;

/**
 * The server's media capability, fetched once per page load.
 *
 * A failure here is NOT fatal: the ticket request will report the real
 * problem, so the cached promise is dropped and the next attempt retries.
 */
function fetchMediaStatus(): Promise<MediaStatusResponse | null> {
  if (!mediaStatusPromise) {
    mediaStatusPromise = fetch('/api/realtime/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<MediaStatusResponse>) : null,
      )
      .catch(() => null)
      .then((status) => {
        if (!status) mediaStatusPromise = null;
        return status;
      });
  }
  return mediaStatusPromise;
}

// ---------------------------------------------------------------------------
// The byte transfer
// ---------------------------------------------------------------------------

/**
 * PUTs the bytes to the Worker.
 *
 * XHR rather than fetch, for exactly one reason: `xhr.upload.onprogress`
 * reports the real number of bytes that reached the Worker. Nothing here
 * invents a percentage.
 */
function putBytes(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<UploadedBytes> {
  return new Promise<UploadedBytes>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    /**
     * An aborted attempt must not keep pushing bytes into the bucket.
     */
    const onAbort = () => {
      try {
        xhr.abort();
      } catch {
        /* an XHR that never started cannot be aborted */
      }
    };
    if (signal) {
      if (signal.aborted) {
        reject(new UploadAbortedError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (settle: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      settle();
    };

    try {
      xhr.open('PUT', url, true);
    } catch (error) {
      finish(() => reject(error));
      return;
    }

    try {
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
    } catch (error) {
      finish(() => reject(error));
      return;
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };

    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        finish(() => resolve((payload ?? {}) as UploadedBytes));
        return;
      }

      finish(() =>
        reject(
          new MediaApiError(
            readErrorMessage(payload) ?? 'The image could not be stored.',
            xhr.status,
            readErrorCode(payload),
          ),
        ),
      );
    };

    xhr.onerror = () => {
      finish(() =>
        reject(
          new MediaApiError(
            'Could not reach the upload server. Check your connection and try again.',
            0,
          ),
        ),
      );
    };

    xhr.ontimeout = () => {
      finish(() => reject(new MediaApiError('The upload timed out. Please try again.', 0)));
    };

    xhr.onabort = () => {
      finish(() => reject(new UploadAbortedError()));
    };

    try {
      xhr.send(file);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface BrowserMediaTransportOptions {
  /** The auth headers for the current session. */
  getAuthHeaders: AuthHeaderGetter;
}

/**
 * The real transport: the server-signed R2 flow.
 *
 * The browser never holds a bucket credential, cannot choose an object key,
 * and cannot delete anything: every one of those is a server decision.
 */
export function createBrowserMediaTransport(
  options: BrowserMediaTransportOptions,
): MediaTransport {
  const { getAuthHeaders } = options;

  return {
    async requestUploadTicket({ purpose, contentType, roomId, robotId, signal }) {
      /**
       * A server without media configured says so before a pointless
       * ticket round trip.
       */
      const capability = await fetchMediaStatus();
      if (signal?.aborted) throw new UploadAbortedError();
      if (capability?.media && capability.media.configured === false) {
        throw new MediaApiError(
          MEDIA_NOT_AVAILABLE_MESSAGE,
          503,
          'MEDIA_NOT_CONFIGURED',
        );
      }

      const response = await postJson<{ ticket?: MediaUploadTicket }>(
        '/api/media/upload-ticket',
        {
          purpose,
          ...(roomId ? { roomId } : {}),
          ...(robotId ? { robotId } : {}),
          contentType,
        },
        getAuthHeaders,
        signal,
      );

      const ticket = response.ticket;
      if (!ticket?.uploadUrl || !ticket.key) {
        throw new MediaApiError(
          'The server did not return an upload ticket.',
          500,
        );
      }
      return ticket;
    },

    uploadBytes({ uploadUrl, headers, file, onProgress, signal }) {
      return putBytes(uploadUrl, headers, file, onProgress, signal);
    },

    async commitMedia({ key, purpose, contentType, size, roomId, robotId, signal }) {
      const response = await postJson<{
        avatar?: { url?: string } | null;
        avatarUrl?: string | null;
        cover?: { url?: string } | null;
        coverUrl?: string | null;
        robotCover?: { url?: string } | null;
        robotCoverUrl?: string | null;
      }>(
        '/api/media/commit',
        {
          key,
          purpose,
          ...(roomId ? { roomId } : {}),
          ...(robotId ? { robotId } : {}),
          contentType,
          size,
        },
        getAuthHeaders,
        signal,
      );

      const url =
        response.avatarUrl ??
        response.coverUrl ??
        response.robotCoverUrl ??
        response.avatar?.url ??
        response.cover?.url ??
        response.robotCover?.url ??
        null;

      return { url };
    },

    async removeMedia({ purpose, roomId, robotId, signal }) {
      await postJson<{ ok?: boolean }>(
        '/api/media/remove',
        {
          purpose,
          ...(roomId ? { roomId } : {}),
          ...(robotId ? { robotId } : {}),
        },
        getAuthHeaders,
        signal,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the saved picture
// ---------------------------------------------------------------------------

/**
 * The signed-in member's saved picture.
 *
 * The server returns a signed DELIVERY url; the stored value is only an
 * object key, so the url is regenerated on every read. A member with no
 * picture is a perfectly good outcome, not an error.
 *
 * The id comes back too, because in dev auth mode the browser never learns
 * the server's user id — the server knows it and the browser does not.
 */
export async function fetchProfileAvatar(
  getAuthHeaders: AuthHeaderGetter,
  signal?: AbortSignal,
): Promise<{ id: string | null; url: string | null }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(await getAuthHeaders()),
  };

  const response = await fetch('/api/profile', { headers, cache: 'no-store', signal });
  if (!response.ok) return { id: null, url: null };

  const body = (await response.json().catch(() => null)) as
    | { avatarUrl?: string | null; profile?: { id?: string } | null }
    | null;

  return {
    id: body?.profile?.id ?? null,
    url: body?.avatarUrl ?? null,
  };
}

export type { MediaPurpose, MediaTransport };
