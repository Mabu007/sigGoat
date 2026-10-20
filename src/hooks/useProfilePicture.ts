/**
 * PROFILE PICTURE
 * ================
 * The one place the signed-in member's picture is owned, and the one place
 * every other component reads it from.
 *
 * THE TWO HALVES
 * --------------
 *   - `useProfilePicture()`        the OWNER: it uploads, saves, discards and
 *                                  deletes, and publishes what changed.
 *   - `useProfilePictureSnapshot()` the READER: any other component (the
 *                                  header, a chat head, a roster row) reads
 *                                  the committed url from the store and
 *                                  re-renders when it changes.
 *
 * WHY ONE STORE
 * -------------
 * The picture used to live in TWO independent `useState` copies — one in the
 * header, one in the settings screen — and each fetched `GET /api/profile`
 * on its own. Two copies of one fact is how a picture ends up showing in the
 * header and not in the settings screen, until a reload "fixed" it.
 *
 * The store itself lives in `profilePictureStore.ts`; this module adds the
 * session-aware parts (whose picture this is, and how it is read) and the
 * owner hook.
 *
 * AFTER A CHANGE
 * --------------
 * Saving or deleting the picture publishes the new value to the store AND
 * dispatches `tradingvibes:profile-updated` on `window`, so a consumer that
 * keeps its own copy (the chat, a roster) can re-read it.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';
import { useImageUpload } from './useImageUpload';
import {
  ensureProfilePictureLoaded,
  getProfilePictureSnapshot,
  publishProfilePicture,
  subscribeProfilePicture,
  dispatchProfileUpdated,
  type ProfilePictureSnapshot,
} from './profilePictureStore';
import type { ProfilePictureStatus, StagedUpload } from './profilePictureState';

export {
  PROFILE_UPDATED_EVENT,
  dispatchProfileUpdated,
  getProfilePictureSnapshot,
  publishProfilePicture,
  resetProfilePictureStore,
  subscribeProfilePicture,
} from './profilePictureStore';
export type { ProfilePictureSnapshot } from './profilePictureStore';

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

/**
 * Who this browser is.
 *
 * A Firebase session has a uid. A DEV session has none — the browser only
 * knows that the server trusts a local id — so the mode itself is the key.
 * Without one there is nobody to read a picture for.
 */
function useIdentityKey(uid: string | null, authMode: string | null): string | null {
  return useMemo(() => {
    if (uid) return uid;
    if (authMode === 'dev') return 'dev';
    return null;
  }, [uid, authMode]);
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * Reads the committed picture.
 *
 * This is what any other component should use — the header, a chat message
 * head, a member row. It re-renders when the picture changes, so a save or
 * a delete in the settings screen is visible everywhere at once.
 */
export function useProfilePictureSnapshot(): ProfilePictureSnapshot {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const ownerKey = useIdentityKey(currentUser?.uid ?? null, authMode);

  const value = useSyncExternalStore(
    subscribeProfilePicture,
    getProfilePictureSnapshot,
    getProfilePictureSnapshot,
  );

  useEffect(() => {
    void ensureProfilePictureLoaded(ownerKey, getApiAuthHeaders);
  }, [ownerKey, getApiAuthHeaders]);

  /**
   * A picture that belongs to somebody else is no picture at all: the store
   * keeps the last member's url until the new one has been read.
   */
  const mine = !value.ownerKey || value.ownerKey === ownerKey;
  return mine ? value : { ...value, url: null, staged: null };
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

export interface UseProfilePicture {
  /** The COMMITTED picture url, or null when there is no picture. */
  url: string | null;
  /** The upload waiting to be saved, or null. */
  staged: StagedUpload | null;
  status: ProfilePictureStatus;
  progress: number;
  error: string | null;
  /** True once the committed picture has been read at least once. */
  loaded: boolean;
  /** Uploads the bytes and leaves them staged. The picture does not change yet. */
  upload: (file: File) => Promise<StagedUpload | null>;
  /** Saves the staged upload. This is what makes it the profile picture. */
  save: () => Promise<string | null>;
  /** Throws the staged upload away without saving it. */
  discard: () => void;
  /**
   * Deletes the picture through the server.
   *
   * Resolves true when the server confirmed the deletion; a failed deletion
   * resolves false and leaves the picture in place.
   */
  remove: () => Promise<boolean>;
  /** Re-reads the committed picture from the server. */
  refresh: () => Promise<void>;
}

/**
 * Owns the profile picture.
 *
 * It is the only place that changes the picture, and every change is
 * published to the store, so the rest of the app sees it without a reload.
 */
export function useProfilePicture(): UseProfilePicture {
  const { currentUser, authMode, getApiAuthHeaders } = useAuth();
  const ownerKey = useIdentityKey(currentUser?.uid ?? null, authMode);
  const ownerRef = useRef(ownerKey);

  useEffect(() => {
    ownerRef.current = ownerKey;
  }, [ownerKey]);

  const uploadState = useImageUpload({
    purpose: 'avatar',
    /**
     * A profile picture is saved EXPLICITLY. Choosing a file must not make
     * it the picture.
     */
    commitOnUpload: false,
    onUploaded: (url) => {
      publishProfilePicture({ url, ownerKey: ownerRef.current, loaded: true });
      dispatchProfileUpdated(url);
    },
  });

  const snapshot = useSyncExternalStore(
    subscribeProfilePicture,
    getProfilePictureSnapshot,
    getProfilePictureSnapshot,
  );

  /**
   * The staged upload and the phase are published too, so a reader can tell
   * that there is something waiting to be saved.
   */
  useEffect(() => {
    publishProfilePicture({
      staged: uploadState.staged,
      status: uploadState.status,
      progress: uploadState.progress,
      error: uploadState.error,
    });
  }, [
    uploadState.staged,
    uploadState.status,
    uploadState.progress,
    uploadState.error,
  ]);

  useEffect(() => {
    void ensureProfilePictureLoaded(ownerKey, getApiAuthHeaders);
  }, [ownerKey, getApiAuthHeaders]);

  const save = useCallback(() => uploadState.commit(), [uploadState.commit]);

  const discard = useCallback(() => uploadState.discard(), [uploadState.discard]);

  const remove = useCallback(() => uploadState.remove(), [uploadState.remove]);

  const refresh = useCallback(
    () => ensureProfilePictureLoaded(ownerKey, getApiAuthHeaders, true),
    [ownerKey, getApiAuthHeaders],
  );

  const mine = !snapshot.ownerKey || snapshot.ownerKey === ownerKey;

  return {
    url: mine ? snapshot.url : null,
    staged: uploadState.staged,
    status: uploadState.status,
    progress: uploadState.progress,
    error: uploadState.error,
    loaded: snapshot.loaded,
    upload: uploadState.upload,
    save,
    discard,
    remove,
    refresh,
  };
}

export default useProfilePicture;
