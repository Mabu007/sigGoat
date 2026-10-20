/**
 * USE IMAGE UPLOAD
 * ================
 * The browser half of a TradingVibes image upload (Cloudflare R2), as a hook.
 *
 * TWO PHASES, NOT ONE
 * -------------------
 *   1. STAGE   `upload(file)` sends the bytes to the Worker and returns a
 *               STAGED upload: a key, a local preview, the content type and
 *               the size. The profile is NOT touched.
 *   2. COMMIT  `commit()` posts the staged key to `/api/media/commit`. Only
 *               then does the picture become the profile picture.
 *
 * Choosing a file must not silently make it the authoritative profile
 * picture: a trader who picks the wrong image needs a way back that does
 * not involve deleting their picture. `discard()` throws the staged upload
 * away without committing it.
 *
 * THE ROOM COVER IS DIFFERENT
 * ---------------------------
 * A room cover has no save step — the picker shows the new cover the moment
 * it is chosen — so for `purpose: 'room-cover'` the upload commits in one
 * phase. Pass `commitOnUpload: false` to stage a room cover too.
 *
 * THE BROWSER'S POWERS
 * --------------------
 * The browser never holds an R2 credential and never names the object key:
 * the server decides both. It also cannot delete an arbitrary object: the
 * only deletion is `remove()`, which the server routes to the caller's own
 * picture.
 *
 * ABORTING
 * --------
 * Leaving the screen must not leave a half-finished upload running: the
 * XHR is aborted and the pending fetches are cancelled. `onUploaded` is
 * never called after unmount, so a parent that has already gone away is
 * never written to.
 *
 * The decision logic lives in `profilePictureState.ts` and the network half
 * in `profilePictureClient.ts`; this file is the React wiring between them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { MediaPurpose } from '../types/rooms';
import { createBrowserMediaTransport } from './profilePictureClient';
import {
  createProfilePictureFlow,
  initialProfilePictureState,
  type ProfilePictureFlow,
  type ProfilePictureState,
  type ProfilePictureStatus,
  type StagedUpload,
} from './profilePictureState';

export { MEDIA_NOT_AVAILABLE_MESSAGE } from './profilePictureState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageUploadPurpose = MediaPurpose;

/**
 * The phases of the lifecycle.
 *
 * `staged` is the phase the old one-call flow skipped: the bytes are in the
 * bucket and the profile has not been told about them yet.
 */
export type ImageUploadStatus = ProfilePictureStatus;

export interface UseImageUpload {
  status: ImageUploadStatus;
  /** 0..1 while uploading. */
  progress: number;
  error: string | null;
  /** The upload waiting to be committed, or null. */
  staged: StagedUpload | null;
  /** The url of the stored image AFTER a successful commit, when available. */
  url: string | null;
  /**
   * Uploads a File and leaves it STAGED. Returns the staged upload, or null
   * on failure. It never makes the picture authoritative.
   */
  upload: (file: File) => Promise<StagedUpload | null>;
  /** Makes the staged upload the picture. Returns the committed url. */
  commit: () => Promise<string | null>;
  /** Forgets the staged upload without committing it. */
  discard: () => void;
  /**
   * Removes the current image through the server.
   *
   * Resolves true when the server confirmed the removal; a failed removal
   * resolves false and leaves the picture in place.
   */
  remove: () => Promise<boolean>;
  /**
   * Clears the local upload state.
   *
   * It does NOT un-save the picture: only the server decides what the
   * profile points at, so a local reset cannot pretend the saved picture is
   * gone.
   */
  reset: () => void;
}

export interface UseImageUploadOptions {
  purpose: ImageUploadPurpose;
  /** Required for 'room-cover'. */
  roomId?: string | null;
  /** Called after a successful commit with the new url (or null after removal). */
  onUploaded?: (url: string | null) => void;
  /**
   * When true, `upload()` commits as soon as the bytes land.
   *
   * Defaults to true for a room cover (it has no save step) and to false for
   * an avatar (the profile picture is saved explicitly).
   */
  commitOnUpload?: boolean;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useImageUpload(options: UseImageUploadOptions): UseImageUpload {
  const { purpose, roomId, onUploaded, commitOnUpload } = options;

  const { getApiAuthHeaders } = useAuth();

  const [state, setState] = useState<ProfilePictureState>(initialProfilePictureState);

  /** The flow owns the state; React mirrors it. */
  const flowRef = useRef<ProfilePictureFlow | null>(null);
  /** The latest callback, without making every function depend on it. */
  const onUploadedRef = useRef(onUploaded);
  /** The latest auth getter, for the same reason. */
  const getApiAuthHeadersRef = useRef(getApiAuthHeaders);
  /** The latest purpose and room, read fresh on every call. */
  const contextRef = useRef<{ purpose: ImageUploadPurpose; roomId?: string | null }>({
    purpose,
    roomId,
  });
  /** Guards every state write after unmount. */
  const mountedRef = useRef(true);

  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  useEffect(() => {
    getApiAuthHeadersRef.current = getApiAuthHeaders;
  }, [getApiAuthHeaders]);

  useEffect(() => {
    contextRef.current = { purpose, roomId };
  }, [purpose, roomId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      /**
       * The flow aborts the XHR and the pending fetches, and releases the
       * local preview url.
       */
      flowRef.current?.dispose();
    };
  }, []);

  if (!flowRef.current) {
    flowRef.current = createProfilePictureFlow({
      transport: createBrowserMediaTransport({
        getAuthHeaders: () => getApiAuthHeadersRef.current(),
      }),
      getContext: () => contextRef.current,
      commitOnUpload: commitOnUpload ?? purpose === 'room-cover',
      onChange: (next) => {
        if (mountedRef.current) setState(next);
      },
      onCommitted: (url) => {
        if (mountedRef.current) onUploadedRef.current?.(url);
      },
      createPreviewUrl: (file) =>
        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : '',
      revokePreviewUrl: (url) => {
        if (!url) return;
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(url);
          }
        } catch {
          /* a preview that cannot be released is not worth an error */
        }
      },
    });
  }

  const flow = flowRef.current;

  const upload = useCallback(
    (file: File) => flow.stageUpload(file),
    [flow],
  );

  const commit = useCallback(() => flow.commit(), [flow]);

  const discard = useCallback(() => flow.discard(), [flow]);

  const remove = useCallback(() => flow.remove(), [flow]);

  const reset = useCallback(() => {
    flow.discard();
  }, [flow]);

  return {
    status: state.status,
    progress: state.progress,
    error: state.error,
    staged: state.staged,
    url: state.url,
    upload,
    commit,
    discard,
    remove,
    reset,
  };
}

export default useImageUpload;
