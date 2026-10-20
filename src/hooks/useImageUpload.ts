/**
 * USE IMAGE UPLOAD
 * ================
 * The browser half of a TradingVibes image upload (Cloudflare R2).
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
 * ABORTING
 * --------
 * Leaving the screen must not leave a half-finished upload running: the
 * XHR is aborted and the pending fetches are cancelled. `onUploaded` is
 * never called after unmount, so a parent that has already gone away is
 * never written to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  type MediaUploadTicket,
} from '../types/rooms';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageUploadPurpose = 'avatar' | 'room-cover';

export type ImageUploadStatus =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'committing'
  | 'done'
  | 'error';

export interface UseImageUpload {
  status: ImageUploadStatus;
  /** 0..1 while uploading. */
  progress: number;
  error: string | null;
  /** The url of the stored image after a successful commit, when available. */
  url: string | null;
  /** Uploads a File. Returns the new url, or null on failure. */
  upload: (file: File) => Promise<string | null>;
  /** Removes the current image. */
  remove: () => Promise<void>;
  reset: () => void;
}

export interface UseImageUploadOptions {
  purpose: ImageUploadPurpose;
  /** Required for 'room-cover'. */
  roomId?: string | null;
  /** Called after a successful commit with the new url (or null after removal). */
  onUploaded?: (url: string | null) => void;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Shown whenever the server has no media signing configured. */
export const MEDIA_NOT_AVAILABLE_MESSAGE =
  'Image uploads are not available on this server.';

/** The size limit in megabytes, for a message a trader can act on. */
const MAX_MEGABYTES = Math.round((MEDIA_MAX_BYTES / (1024 * 1024)) * 10) / 10;

const TOO_LARGE_MESSAGE = `That image is larger than the ${MAX_MEGABYTES} MB limit.`;
const UNSUPPORTED_TYPE_MESSAGE =
  'Upload a PNG, JPEG, WebP or GIF image.';
const EMPTY_FILE_MESSAGE = 'That file is empty. Choose an image to upload.';
const NO_ROOM_MESSAGE =
  'Save the room first, then add a cover.';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error the server described, with its status and code. */
class MediaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'MediaApiError';
  }
}

/** Thrown when the upload was cancelled (unmount, or a newer upload started). */
class UploadAbortedError extends Error {
  constructor() {
    super('The upload was cancelled.');
    this.name = 'UploadAbortedError';
  }
}

/**
 * Turns a raw failure into a sentence a trader can act on.
 *
 * The server already writes user-facing text for most cases; the mapping
 * below only covers the cases where the server could not have known what the
 * browser was trying to do, plus the Worker's own upload errors.
 */
function describeMediaError(error: unknown): string {
  if (error instanceof MediaApiError) {
    switch (error.code) {
      case 'MEDIA_NOT_CONFIGURED':
        return MEDIA_NOT_AVAILABLE_MESSAGE;
      case 'UNSUPPORTED_IMAGE_TYPE':
        return UNSUPPORTED_TYPE_MESSAGE;
      case 'IMAGE_TOO_LARGE':
        return TOO_LARGE_MESSAGE;
      case 'INVALID_ROOM':
        return NO_ROOM_MESSAGE;
      case 'ROOM_NOT_FOUND':
        return 'That room no longer exists.';
      case 'ROOM_NOT_MANAGED':
        return 'Only the room owner or a leader can change this image.';
      case 'UNAUTHENTICATED':
        return 'Your session expired. Sign in again to upload an image.';
      case 'AUTH_NOT_CONFIGURED':
        return 'This server cannot verify sign-ins, so image uploads are unavailable.';
      case 'INVALID_TICKET':
        return 'That upload link has expired. Please try again.';
      case 'EMPTY_UPLOAD':
        return EMPTY_FILE_MESSAGE;
      default:
        break;
    }
    if (error.status === 503) return MEDIA_NOT_AVAILABLE_MESSAGE;
    if (error.status === 0) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (error.status === 401) {
      return 'Your session expired. Sign in again to upload an image.';
    }
    if (error.status === 403) {
      return 'You do not have permission to change this image.';
    }
    return error.message;
  }

  if (error instanceof UploadAbortedError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'The image could not be uploaded.';
}

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

/** Extension fallback for browsers that report no MIME type at all. */
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * The content type to declare, or null when the file is not an image this
 * product accepts.
 */
function resolveContentType(file: File): string | null {
  const declared = (file.type || '').trim().toLowerCase();
  if (declared) {
    return MEDIA_ALLOWED_TYPES.includes(declared) ? declared : null;
  }

  const match = /\.([a-z0-9]+)$/i.exec(file.name || '');
  const byExtension = match ? EXTENSION_TYPES[match[1].toLowerCase()] : undefined;
  if (byExtension) return byExtension;

  return null;
}

/** Client-side validation. Returns an error message, or null when the file is fine. */
function validateImage(file: File): string | null {
  if (!resolveContentType(file)) return UNSUPPORTED_TYPE_MESSAGE;
  if (file.size <= 0) return EMPTY_FILE_MESSAGE;
  if (file.size > MEDIA_MAX_BYTES) return TOO_LARGE_MESSAGE;
  return null;
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

interface WorkerUploadResponse {
  ok?: boolean;
  key?: string;
  contentType?: string;
  size?: number;
}

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
  register: (xhr: XMLHttpRequest) => void,
): Promise<WorkerUploadResponse> {
  return new Promise<WorkerUploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);

    try {
      xhr.open('PUT', url, true);
    } catch (error) {
      reject(error);
      return;
    }

    try {
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
    } catch (error) {
      reject(error);
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
        resolve((payload ?? {}) as WorkerUploadResponse);
        return;
      }

      reject(
        new MediaApiError(
          readErrorMessage(payload) ?? 'The image could not be stored.',
          xhr.status,
          readErrorCode(payload),
        ),
      );
    };

    xhr.onerror = () => {
      reject(
        new MediaApiError(
          'Could not reach the upload server. Check your connection and try again.',
          0,
        ),
      );
    };

    xhr.ontimeout = () => {
      reject(new MediaApiError('The upload timed out. Please try again.', 0));
    };

    xhr.onabort = () => {
      reject(new UploadAbortedError());
    };

    try {
      xhr.send(file);
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useImageUpload(options: UseImageUploadOptions): UseImageUpload {
  const { purpose, roomId, onUploaded } = options;

  const { getApiAuthHeaders } = useAuth();

  const [status, setStatus] = useState<ImageUploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  /** The in-flight XHR, so it can be aborted. */
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  /** The in-flight fetches, so they can be cancelled. */
  const abortRef = useRef<AbortController | null>(null);
  /** Guards every state write and every `onUploaded` call after unmount. */
  const mountedRef = useRef(true);
  /** The latest callback, without making every function depend on it. */
  const onUploadedRef = useRef(onUploaded);

  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        xhrRef.current?.abort();
      } catch {
        /* an aborted XHR that never started is not an error */
      }
      xhrRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  /** Cancels whatever is running and starts a fresh attempt. */
  const cancelInFlight = useCallback(() => {
    try {
      xhrRef.current?.abort();
    } catch {
      /* ignore */
    }
    xhrRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * Every attempt gets a number.
   *
   * A superseded attempt (a second file chosen while the first is still
   * uploading) is aborted, but its promise chain still resolves a moment
   * later. Without this counter that late answer would set the error state
   * of the attempt that replaced it, and the trader would see "The upload
   * was cancelled" over a perfectly healthy upload.
   */
  const generationRef = useRef(0);

  const upload = useCallback(
    async (file: File): Promise<string | null> => {
      /**
       * A second upload supersedes the first one.
       */
      cancelInFlight();

      const generation = generationRef.current + 1;
      generationRef.current = generation;

      /** True when this attempt has been replaced by a newer one. */
      const superseded = () => generationRef.current !== generation;

      const problem = validateImage(file);
      if (problem) {
        if (mountedRef.current) {
          setStatus('error');
          setProgress(0);
          setError(problem);
        }
        return null;
      }

      if (purpose === 'room-cover' && !roomId) {
        if (mountedRef.current) {
          setStatus('error');
          setProgress(0);
          setError(NO_ROOM_MESSAGE);
        }
        return null;
      }

      const contentType = resolveContentType(file) as string;

      if (mountedRef.current) {
        setStatus('preparing');
        setProgress(0);
        setError(null);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        /**
         * A server without media configured says so before a pointless
         * ticket round trip.
         */
        const capability = await fetchMediaStatus();
        if (superseded()) return null;
        if (capability?.media && capability.media.configured === false) {
          throw new MediaApiError(
            MEDIA_NOT_AVAILABLE_MESSAGE,
            503,
            'MEDIA_NOT_CONFIGURED',
          );
        }

        // 1. the ticket
        const ticketResponse = await postJson<{ ticket?: MediaUploadTicket }>(
          '/api/media/upload-ticket',
          {
            purpose,
            ...(roomId ? { roomId } : {}),
            contentType,
          },
          getApiAuthHeaders,
          controller.signal,
        );

        const ticket = ticketResponse.ticket;
        if (superseded()) return null;
        if (!ticket?.uploadUrl || !ticket.key) {
          throw new MediaApiError(
            'The server did not return an upload ticket.',
            500,
          );
        }

        if (mountedRef.current) setStatus('uploading');

        /**
         * 2. the bytes.
         *
         * The ticket's headers are sent as they are, except for the content
         * type: the Worker compares the DECLARED type against the type it
         * detected in the bytes and refuses a mismatch, so the real type of
         * the file is declared here. The Worker still verifies the bytes.
         */
        const uploadHeaders: Record<string, string> = { ...ticket.headers };
        uploadHeaders['content-type'] = contentType;

        const uploaded = await putBytes(
          ticket.uploadUrl,
          uploadHeaders,
          file,
          (ratio) => {
            if (!mountedRef.current || superseded()) return;
            /**
             * The transfer is 90% of the visible work; the commit is the
             * remaining 10% and completes when the server confirms.
             */
            setProgress(Math.min(0.9, Math.max(0, ratio * 0.9)));
          },
          (xhr) => {
            xhrRef.current = xhr;
          },
        );

        xhrRef.current = null;
        if (superseded()) return null;

        if (mountedRef.current) setStatus('committing');

        // 3. the commit
        const commitResponse = await postJson<{
          avatar?: { url?: string } | null;
          avatarUrl?: string | null;
          cover?: { url?: string } | null;
          coverUrl?: string | null;
        }>(
          '/api/media/commit',
          {
            key: ticket.key,
            purpose,
            ...(roomId ? { roomId } : {}),
            contentType: uploaded.contentType || contentType,
            size: typeof uploaded.size === 'number' ? uploaded.size : file.size,
          },
          getApiAuthHeaders,
          controller.signal,
        );

        const committedUrl =
          commitResponse.avatarUrl ??
          commitResponse.coverUrl ??
          commitResponse.avatar?.url ??
          commitResponse.cover?.url ??
          null;

        if (!mountedRef.current || superseded()) return null;

        setUrl(committedUrl);
        setProgress(1);
        setStatus('done');
        setError(null);
        onUploadedRef.current?.(committedUrl);

        return committedUrl;
      } catch (failure) {
        if (failure instanceof UploadAbortedError) return null;
        if (!mountedRef.current || superseded()) return null;

        setStatus('error');
        setError(describeMediaError(failure));
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancelInFlight, getApiAuthHeaders, purpose, roomId],
  );

  const remove = useCallback(async (): Promise<void> => {
    cancelInFlight();

    const generation = generationRef.current + 1;
    generationRef.current = generation;

    /** True when this attempt has been replaced by a newer one. */
    const superseded = () => generationRef.current !== generation;

    if (mountedRef.current) {
      setStatus('preparing');
      setError(null);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await postJson<{ ok?: boolean; avatarUrl?: string | null; coverUrl?: string | null }>(
        '/api/media/remove',
        {
          purpose,
          ...(roomId ? { roomId } : {}),
        },
        getApiAuthHeaders,
        controller.signal,
      );

      if (!mountedRef.current || superseded()) return;

      setUrl(null);
      setProgress(0);
      setStatus('idle');
      onUploadedRef.current?.(null);
    } catch (failure) {
      if (failure instanceof UploadAbortedError) return;
      if (!mountedRef.current || superseded()) return;
      setStatus('error');
      setError(describeMediaError(failure));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [cancelInFlight, getApiAuthHeaders, purpose, roomId]);

  const reset = useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setError(null);
    setUrl(null);
  }, []);

  return { status, progress, error, url, upload, remove, reset };
}

export default useImageUpload;
