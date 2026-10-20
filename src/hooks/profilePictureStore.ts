/**
 * PROFILE PICTURE STORE
 * =====================
 * ONE copy of the signed-in member's picture.
 *
 * WHY A STORE
 * -----------
 * The picture used to live in TWO independent `useState` copies — one in the
 * header, one in the settings screen — and each of them fetched
 * `GET /api/profile` on its own. Two copies of one fact is how a picture
 * ends up showing in the header and not in the settings screen, or the other
 * way round, until a reload "fixed" it.
 *
 * So there is now ONE store. It holds the committed picture, and every
 * component reads it from here:
 *
 *   - `useProfilePicture()`       the OWNER: it uploads, saves, discards and
 *                                 deletes, and publishes what changed.
 *   - `useProfilePictureSnapshot()` the READER: any other component (the
 *                                 header, a chat head, a roster row) just
 *                                 reads the committed url and re-renders when
 *                                 it changes.
 *
 * The store is a tiny external store: `subscribe` / `getSnapshot` plus a
 * `useSyncExternalStore` hook. Nothing about it is React-specific, so a
 * consumer that is not a React component could read it too.
 *
 * This module deliberately imports NOTHING that touches the browser's
 * session or the network beyond one plain fetch, so it can be exercised
 * without a DOM.
 */

import { fetchProfileAvatar } from './profilePictureClient';
import type { ProfilePictureStatus, StagedUpload } from './profilePictureState';

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface ProfilePictureSnapshot {
  /** The COMMITTED picture url, or null when there is no picture. */
  url: string | null;
  /**
   * The identity the loaded picture belongs to.
   *
   * It is the session's identity, not the server's user id: in dev auth
   * mode the browser never learns the server's id, so the client-side key
   * is what says "this picture is the one this browser is showing".
   */
  ownerKey: string | null;
  /** The server's user id for the loaded picture, when it gave one. */
  ownerId: string | null;
  /** True once the committed picture has been read at least once. */
  loaded: boolean;
  /** The upload waiting to be saved, or null. */
  staged: StagedUpload | null;
  status: ProfilePictureStatus;
  progress: number;
  error: string | null;
}

const EMPTY_SNAPSHOT: ProfilePictureSnapshot = {
  url: null,
  ownerKey: null,
  ownerId: null,
  loaded: false,
  staged: null,
  status: 'idle',
  progress: 0,
  error: null,
};

let snapshot: ProfilePictureSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Subscribes to the store. Returns the unsubscribe function. */
export function subscribeProfilePicture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current snapshot. The identity only changes when the state changes. */
export function getProfilePictureSnapshot(): ProfilePictureSnapshot {
  return snapshot;
}

function sameSnapshot(a: ProfilePictureSnapshot, b: ProfilePictureSnapshot): boolean {
  const keys = Object.keys(b) as (keyof ProfilePictureSnapshot)[];
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Publishes a change.
 *
 * A publish that changes nothing does NOT notify: the store is written from
 * effects, and a notification that changes no value would re-render every
 * reader for nothing.
 */
export function publishProfilePicture(patch: Partial<ProfilePictureSnapshot>): void {
  const next = { ...snapshot, ...patch };
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const listener of Array.from(listeners)) listener();
}

/** Empties the store. Used when nobody is signed in. */
export function resetProfilePictureStore(): void {
  publishProfilePicture({ ...EMPTY_SNAPSHOT });
}

/**
 * The event other consumers listen to.
 *
 * The url is in `detail`, so a consumer that keeps its own copy does not
 * have to ask the server again.
 */
export const PROFILE_UPDATED_EVENT = 'tradingvibes:profile-updated';

export function dispatchProfileUpdated(url: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(PROFILE_UPDATED_EVENT, { detail: { url } }),
    );
  } catch {
    /* an environment without CustomEvent simply has no listeners */
  }
}

// ---------------------------------------------------------------------------
// Reading the saved picture
// ---------------------------------------------------------------------------

let loadPromise: Promise<void> | null = null;

/**
 * Reads the committed picture from the server, once per session.
 *
 * The server returns a signed DELIVERY url: the stored value is only an R2
 * object key, so the url is regenerated on every read. A member with no
 * picture is a perfectly good outcome.
 *
 * `ownerKey` is the session's identity. A different key means a different
 * member, so the picture is read again rather than shown to the wrong
 * person.
 */
export async function ensureProfilePictureLoaded(
  ownerKey: string | null,
  getAuthHeaders: () => Promise<Record<string, string>>,
  force = false,
): Promise<void> {
  if (!ownerKey) {
    resetProfilePictureStore();
    return;
  }

  const current = getProfilePictureSnapshot();
  if (!force && current.loaded && current.ownerKey === ownerKey) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const { id, url } = await fetchProfileAvatar(getAuthHeaders);
      publishProfilePicture({ url, ownerKey, ownerId: id, loaded: true });
      dispatchProfileUpdated(url);
    } catch {
      // No picture is a fine outcome: the initials stand in.
      publishProfilePicture({ loaded: true, ownerKey });
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}
