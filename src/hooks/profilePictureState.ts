/**
 * PROFILE PICTURE STATE
 * =====================
 * The pure decision logic of the profile-picture lifecycle, with no React and
 * no network in it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The picture used to be uploaded and committed in ONE call: choosing a file
 * immediately made it the authoritative profile picture, with no way back
 * except deleting it again. That is a bad deal for a trader who picks the
 * wrong image, and it is why the picture could disagree with itself in two
 * places at once.
 *
 * The lifecycle is now TWO PHASES:
 *
 *   1. STAGE   the bytes go to the Worker and come back as a STAGED upload:
 *               a key, a local preview url, the content type and the size.
 *               Nothing about the profile has changed yet.
 *   2. COMMIT  `/api/media/commit` records the key on the profile. Only NOW
 *               is the picture authoritative.
 *
 * `discard()` throws the staged upload away without committing it. The bytes
 * are already in the bucket at that point, so the object is an ORPHAN: the
 * server has no route that deletes an arbitrary object by key, so cleaning
 * orphans up is a server-side job (a lifecycle rule on the bucket, or a
 * sweeper that deletes `avatars/{uid}/*` objects that no profile points at).
 * The browser must never be able to do that itself.
 *
 * EVERYTHING HERE IS PURE
 * -----------------------
 * The state transitions are plain functions over plain data, and the flow
 * talks to the outside world through a `MediaTransport` interface. That is
 * what makes the interesting cases testable without a DOM and without a
 * network: the tests drive the same flow with a fake transport.
 *
 * THE STALE-RESPONSE RULE
 * -----------------------
 * Every attempt gets a number. A superseded attempt (a second file chosen
 * while the first is still uploading, or a save that lands after the file was
 * replaced) is aborted, but its promise chain still resolves a moment later.
 * Without the counter that late answer would overwrite the newer state, and
 * the trader would see a picture they had already replaced.
 */

import {
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  type MediaPurpose,
  type MediaUploadTicket,
} from '../types/rooms';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The phases of the lifecycle.
 *
 * `staged` is the phase the old flow skipped: the bytes are in the bucket,
 * the profile has not been told about them yet.
 */
export type ProfilePictureStatus =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'staged'
  | 'committing'
  | 'done'
  | 'error';

/** An upload that reached the bucket but has NOT been committed to the profile. */
export interface StagedUpload {
  /** The R2 object key. Chosen by the server, never by the browser. */
  key: string;
  /**
   * A LOCAL preview url for the chosen bytes (an object url).
   *
   * It is not a delivery url: the object is not referenced by the profile
   * yet, so the server will not sign a delivery url for it. The preview
   * shows exactly the bytes the trader picked, and it is revoked when the
   * staged upload is discarded, replaced or committed.
   */
  url: string;
  contentType: string;
  size: number;
}

export interface ProfilePictureState {
  status: ProfilePictureStatus;
  /** 0..1. The transfer is worth 90% of it; the commit is the last 10%. */
  progress: number;
  error: string | null;
  /** The upload waiting to be committed, or null. */
  staged: StagedUpload | null;
  /** The COMMITTED url. Only a successful commit or removal changes it. */
  url: string | null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Shown whenever the server has no media signing configured. */
export const MEDIA_NOT_AVAILABLE_MESSAGE =
  'Image uploads are not available on this server.';

/** The size limit in megabytes, for a message a trader can act on. */
const MAX_MEGABYTES = Math.round((MEDIA_MAX_BYTES / (1024 * 1024)) * 10) / 10;

export const TOO_LARGE_MESSAGE = `That image is larger than the ${MAX_MEGABYTES} MB limit.`;
export const UNSUPPORTED_TYPE_MESSAGE = 'Upload a PNG, JPEG, WebP or GIF image.';
export const EMPTY_FILE_MESSAGE = 'That file is empty. Choose an image to upload.';
export const NO_ROOM_MESSAGE = 'Save the room first, then add a cover.';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error the server described, with its status and code. */
export class MediaApiError extends Error {
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
export class UploadAbortedError extends Error {
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
export function describeMediaError(error: unknown): string {
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
// File validation
// ---------------------------------------------------------------------------

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
export function resolveContentType(file: File): string | null {
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
export function validateImageFile(file: File): string | null {
  if (!resolveContentType(file)) return UNSUPPORTED_TYPE_MESSAGE;
  if (file.size <= 0) return EMPTY_FILE_MESSAGE;
  if (file.size > MEDIA_MAX_BYTES) return TOO_LARGE_MESSAGE;
  return null;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function initialProfilePictureState(): ProfilePictureState {
  return {
    status: 'idle',
    progress: 0,
    error: null,
    staged: null,
    url: null,
  };
}

/**
 * A new attempt starts: the old error is gone and the bar is empty.
 *
 * Any staged upload is dropped as well: the attempt is about to replace it,
 * so the profile must not keep pointing at a preview of bytes that are on
 * their way out. The preview url is released by the caller BEFORE this
 * transition runs.
 */
export function beginPrepare(state: ProfilePictureState): ProfilePictureState {
  return { ...state, status: 'preparing', progress: 0, error: null, staged: null };
}

/** The bytes are moving. */
export function beginUpload(state: ProfilePictureState): ProfilePictureState {
  return { ...state, status: 'uploading', error: null };
}

/** The transfer is measured, never invented: the ratio is the real one. */
export function updateProgress(
  state: ProfilePictureState,
  ratio: number,
): ProfilePictureState {
  return {
    ...state,
    status: 'uploading',
    /** The transfer is worth 90% of the visible work; the commit is the last 10%. */
    progress: Math.min(0.9, Math.max(0, ratio * 0.9)),
  };
}

/** The bytes are in the bucket. The profile has NOT been told about them. */
export function uploadSucceeded(
  state: ProfilePictureState,
  staged: StagedUpload,
): ProfilePictureState {
  return { ...state, status: 'staged', progress: 0.9, error: null, staged };
}

/** The upload failed. The saved picture is untouched. */
export function uploadFailed(
  state: ProfilePictureState,
  message: string,
): ProfilePictureState {
  return { ...state, status: 'error', error: message, staged: null };
}

/** The commit is running: a small JSON round trip with nothing measurable in it. */
export function beginCommit(state: ProfilePictureState): ProfilePictureState {
  return { ...state, status: 'committing', error: null };
}

/** The profile now points at the new picture. */
export function commitSucceeded(
  state: ProfilePictureState,
  url: string | null,
): ProfilePictureState {
  return { ...state, status: 'done', progress: 1, error: null, staged: null, url };
}

/**
 * The commit failed.
 *
 * The saved picture is STILL the saved picture: the url is left exactly as it
 * was, and the staged upload is kept so the trader can try saving it again
 * without choosing the file a second time.
 */
export function commitFailed(
  state: ProfilePictureState,
  message: string,
): ProfilePictureState {
  return { ...state, status: 'error', error: message };
}

/** The staged upload was thrown away. The saved picture is untouched. */
export function discardStaged(state: ProfilePictureState): ProfilePictureState {
  return { ...state, status: 'idle', progress: 0, error: null, staged: null };
}

/** The picture was deleted: the server cleared the reference and the object. */
export function removeSucceeded(state: ProfilePictureState): ProfilePictureState {
  return { ...state, status: 'idle', progress: 0, error: null, staged: null, url: null };
}

/** The removal failed: the picture is still there, and still the saved one. */
export function removeFailed(
  state: ProfilePictureState,
  message: string,
): ProfilePictureState {
  return { ...state, status: 'error', error: message };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** What the Worker said about the bytes it stored. */
export interface UploadedBytes {
  contentType?: string;
  size?: number;
}

/**
 * Everything the flow needs from the outside world.
 *
 * The real implementation signs tickets, PUTs the bytes and posts the
 * commit. A test supplies a fake one, so the lifecycle can be exercised
 * without a network and without a DOM.
 */
export interface MediaTransport {
  /** Asks the server for a signed upload ticket. */
  requestUploadTicket(input: {
    purpose: MediaPurpose;
    contentType: string;
    roomId?: string | null;
    signal?: AbortSignal;
  }): Promise<MediaUploadTicket>;

  /** PUTs the bytes to the Worker, reporting the real transferred ratio. */
  uploadBytes(input: {
    uploadUrl: string;
    headers: Record<string, string>;
    file: File;
    onProgress: (ratio: number) => void;
    signal?: AbortSignal;
  }): Promise<UploadedBytes>;

  /** Records the object on the profile. THIS is what makes it authoritative. */
  commitMedia(input: {
    key: string;
    purpose: MediaPurpose;
    contentType: string;
    size: number;
    roomId?: string | null;
    signal?: AbortSignal;
  }): Promise<{ url: string | null }>;

  /** Deletes the picture and clears the profile reference. */
  removeMedia(input: {
    purpose: MediaPurpose;
    roomId?: string | null;
    signal?: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export interface ProfilePictureFlowOptions {
  transport: MediaTransport;
  /** The purpose, the room and the robot, read fresh on every call. */
  getContext: () => { purpose: MediaPurpose; roomId?: string | null };
  /** Notified after every state change. */
  onChange?: (state: ProfilePictureState) => void;
  /** Notified when the COMMITTED url changes. */
  onCommitted?: (url: string | null) => void;
  /** Creates a local preview url for a staged file. */
  createPreviewUrl?: (file: File) => string;
  /** Releases a local preview url. */
  revokePreviewUrl?: (url: string | null) => void;
  /**
   * When true, `stageUpload` commits straight away.
   *
   * A room cover has no save step — the picker shows the new cover the
   * moment it is chosen — so it commits in one phase. A profile picture has
   * a save step, so it stages.
   */
  commitOnUpload?: boolean;
}

export interface ProfilePictureFlow {
  getState(): ProfilePictureState;
  /** Uploads the bytes and leaves them STAGED. Does not touch the profile. */
  stageUpload(file: File): Promise<StagedUpload | null>;
  /** Makes the staged upload authoritative. */
  commit(): Promise<string | null>;
  /** Forgets the staged upload without committing it. */
  discard(): void;
  /** Deletes the picture through the server. */
  remove(): Promise<boolean>;
  /** Aborts everything in flight and releases the local preview. */
  dispose(): void;
}

/**
 * The lifecycle, as one testable object.
 *
 * The React hooks are a thin wrapper over this: they wire the transport to
 * the network and the state to a `useState`, and nothing else.
 */
export function createProfilePictureFlow(
  options: ProfilePictureFlowOptions,
): ProfilePictureFlow {
  let state = initialProfilePictureState();
  let generation = 0;
  let controller: AbortController | null = null;

  const write = (next: ProfilePictureState) => {
    state = next;
    options.onChange?.(next);
  };

  /**
   * Every attempt gets a number.
   *
   * A superseded attempt is aborted, but its promise chain still resolves a
   * moment later. The counter is what stops that late answer from writing
   * over the newer state.
   */
  const beginAttempt = () => {
    generation += 1;
    const id = generation;
    try {
      controller?.abort();
    } catch {
      /* an abort on an already finished request is not an error */
    }
    const attempt = new AbortController();
    controller = attempt;
    return { id, signal: attempt.signal, current: () => generation === id };
  };

  const releasePreview = (url: string | null) => {
    if (!url) return;
    options.revokePreviewUrl?.(url);
  };

  const stageUpload = async (file: File): Promise<StagedUpload | null> => {
    const attempt = beginAttempt();
    const isCurrent = () => attempt.current();

    /**
     * A new file replaces the previous staged one. Its preview is released
     * and its bytes become an orphan the server can sweep up later.
     */
    releasePreview(state.staged?.url ?? null);

    const problem = validateImageFile(file);
    if (problem) {
      write(uploadFailed(state, problem));
      return null;
    }

    const { purpose, roomId } = options.getContext();
    const contentType = resolveContentType(file) as string;

    write(beginPrepare(state));

    try {
      // 1. the ticket
      const ticket = await options.transport.requestUploadTicket({
        purpose,
        roomId,
        contentType,
        signal: attempt.signal,
      });
      if (!isCurrent()) return null;

      write(beginUpload(state));

      // 2. the bytes
      const uploaded = await options.transport.uploadBytes({
        uploadUrl: ticket.uploadUrl,
        headers: { ...ticket.headers, 'content-type': contentType },
        file,
        onProgress: (ratio) => {
          if (!isCurrent()) return;
          write(updateProgress(state, ratio));
        },
        signal: attempt.signal,
      });
      if (!isCurrent()) return null;

      const staged: StagedUpload = {
        key: ticket.key,
        url: options.createPreviewUrl?.(file) ?? '',
        contentType: uploaded.contentType || contentType,
        size: typeof uploaded.size === 'number' ? uploaded.size : file.size,
      };

      write(uploadSucceeded(state, staged));

      if (options.commitOnUpload) {
        await commit();
        return staged;
      }
      return staged;
    } catch (failure) {
      if (failure instanceof UploadAbortedError) return null;
      if (!isCurrent()) return null;
      write(uploadFailed(state, describeMediaError(failure)));
      return null;
    }
  };

  const commit = async (): Promise<string | null> => {
    const staged = state.staged;
    if (!staged) return null;

    const attempt = beginAttempt();
    const isCurrent = () => attempt.current();
    const { purpose, roomId } = options.getContext();

    write(beginCommit(state));

    try {
      const result = await options.transport.commitMedia({
        key: staged.key,
        purpose,
        roomId,
        contentType: staged.contentType,
        size: staged.size,
        signal: attempt.signal,
      });
      if (!isCurrent()) return null;

      const url = result?.url ?? null;
      releasePreview(staged.url);
      write(commitSucceeded(state, url));
      options.onCommitted?.(url);
      return url;
    } catch (failure) {
      if (failure instanceof UploadAbortedError) return null;
      if (!isCurrent()) return null;
      write(commitFailed(state, describeMediaError(failure)));
      return null;
    }
  };

  const discard = () => {
    // Supersede whatever is in flight: a discarded upload must not land.
    generation += 1;
    try {
      controller?.abort();
    } catch {
      /* ignore */
    }
    controller = null;
    releasePreview(state.staged?.url ?? null);
    write(discardStaged(state));
  };

  const remove = async (): Promise<boolean> => {
    const attempt = beginAttempt();
    const isCurrent = () => attempt.current();
    const { purpose, roomId } = options.getContext();

    /**
     * A staged upload is irrelevant once the saved picture is being deleted,
     * so its preview is released before the attempt starts.
     */
    releasePreview(state.staged?.url ?? null);
    write(beginPrepare(state));

    try {
      await options.transport.removeMedia({ purpose, roomId, signal: attempt.signal });
      if (!isCurrent()) return false;

      write(removeSucceeded(state));
      options.onCommitted?.(null);
      return true;
    } catch (failure) {
      if (failure instanceof UploadAbortedError) return false;
      if (!isCurrent()) return false;
      write(removeFailed(state, describeMediaError(failure)));
      return false;
    }
  };

  const dispose = () => {
    generation += 1;
    try {
      controller?.abort();
    } catch {
      /* ignore */
    }
    controller = null;
    releasePreview(state.staged?.url ?? null);
  };

  return {
    getState: () => state,
    stageUpload,
    commit,
    discard,
    remove,
    dispose,
  };
}
