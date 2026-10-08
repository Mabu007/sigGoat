/**
 * API AUTH HEADERS
 * ===============
 * Single place that turns "who am I in this browser" into request headers.
 *
 * Two server auth modes exist (see src/server/auth.ts):
 *
 *   'firebase' → Authorization: Bearer <firebase-id-token>
 *   'dev'      → x-dev-user-id: <stable local id>
 *   'none'     → every protected route 503s; the UI must say so.
 *
 * The server's mode is discovered once from the public
 * GET /api/settings/status endpoint and cached for the session, so the UI
 * works end to end locally (BYOK key save, live model catalogue, GOAT
 * creation) without requiring a Google sign-in the developer machine may not
 * be able to complete.
 *
 * The dev id is persisted in localStorage so a user's stored API keys
 * survive a page reload.
 */

const DEV_UID_STORAGE_KEY = 'signalgoat.devUserId';

export interface PlatformStatus {
  platform?: {
    authMode?: 'firebase' | 'dev' | 'none';
    persistenceMode?: string;
    activeActors?: number;
  };
  marketData?: { provider?: string; dataMode?: string; symbolsCount?: number };
  reasoning?: { liveCatalogue?: boolean; serverKeyConfigured?: boolean };
  telegram?: { serverConfigured?: boolean; webhookSecretRequired?: boolean };
}

let statusPromise: Promise<PlatformStatus | null> | null = null;
let cachedStatus: PlatformStatus | null = null;

/** Public platform status; memoised so the first request never races it. */
export function getPlatformStatus(): Promise<PlatformStatus | null> {
  if (!statusPromise) {
    statusPromise = fetch('/api/settings/status', {
      headers: { Accept: 'application/json' },
    })
      .then((res) => (res.ok ? (res.json() as Promise<PlatformStatus>) : null))
      .catch(() => null)
      .then((status) => {
        cachedStatus = status;
        return status;
      });
  }

  return statusPromise;
}

/** Synchronous access to an already-resolved status; null while pending. */
export function peekPlatformStatus(): PlatformStatus | null {
  return cachedStatus;
}

function getLocalDevUserId(): string {
  try {
    const existing = localStorage.getItem(DEV_UID_STORAGE_KEY);
    if (existing) return existing;

    const created = `local_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    localStorage.setItem(DEV_UID_STORAGE_KEY, created);
    return created;
  } catch {
    // Private mode / storage disabled: a per-session id is still valid.
    return `local_session_${Date.now().toString(36)}`;
  }
}

/**
 * Builds auth headers for a protected API call.
 *
 * @param firebaseToken current Firebase ID token, or null when signed out.
 * @throws when the server has no auth configured, so callers surface a real
 *         error instead of firing a request guaranteed to 401/503.
 */
export async function resolveApiAuthHeaders(
  firebaseToken: string | null,
): Promise<Record<string, string>> {
  const status = await getPlatformStatus();
  const mode = status?.platform?.authMode ?? 'none';

  if (mode === 'dev') {
    return { 'x-dev-user-id': getLocalDevUserId() };
  }

  if (mode === 'firebase') {
    if (!firebaseToken) {
      throw new Error('Authentication required. Please sign in to continue.');
    }
    return { Authorization: `Bearer ${firebaseToken}` };
  }

  throw new Error(
    'This server has no authentication configured. Set SIGNALGOAT_ALLOW_DEV_AUTH=1 in .env.local (local) or FIREBASE_SERVICE_ACCOUNT_JSON (production), then restart.',
  );
}
