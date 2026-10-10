import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  auth,
  db,
  signInWithPopup,
  signInAnonymously,
  firebaseSignOut,
  googleProvider,
  testConnection,
  onAuthStateChanged,
  type User,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from '../lib/firebase';
import { UserProfile } from '../types';
import { getPlatformStatus, resolveApiAuthHeaders } from '../lib/apiAuth';

interface AuthContextType {
  currentUser: User | null;
  profile: UserProfile | null;

  /**
   * True while Firebase Auth is determining the current session
   * and while the user's Firestore profile is being loaded.
   */
  loading: boolean;

  /**
   * Whether Firestore connectivity was successfully verified.
   */
  isFirebaseConnected: boolean;

  /**
   * True once we know whether the server can authenticate API calls.
   *
   * `canQueryApi` is what data contexts gate on — NOT `currentUser`. In dev
   * auth mode there is no Firebase user, yet every API call is perfectly
   * valid (authenticated by `x-dev-user-id`). Gating on `currentUser` made the
   * entire SPA silently inert locally.
   */
  canQueryApi: boolean;

  /**
   * Resolved server auth mode: 'firebase' | 'dev' | 'none' | null while
   * loading. The UI labels dev mode honestly instead of implying a real login.
   */
  authMode: 'firebase' | 'dev' | 'none' | null;

  loginWithGoogle: () => Promise<void>;
  loginAnonymously: () => Promise<void>;
  logout: () => Promise<void>;

  /** Last sign-in failure as an actionable message, or null. */
  authError: string | null;

  updateProfileData: (data: Partial<UserProfile>) => Promise<void>;

  /**
   * Returns auth headers for API requests, matching the SERVER's auth mode:
   *
   *   Authorization: Bearer <firebase-id-token>   (authMode = firebase)
   *   x-dev-user-id: <stable local id>             (authMode = dev)
   *
   * Throws when the server has no auth configured so the UI reports the real
   * problem instead of firing a request that is guaranteed to 401/503.
   */
  getApiAuthHeaders: () => Promise<Record<string, string>>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Turns a raw FirebaseError into something the user can act on.
 *
 * The most common failure by far is `auth/unauthorized-domain`, which is a
 * Firebase CONSOLE setting (authorized domains), not a code bug. The raw
 * message ("Error (auth/unauthorized-domain)") tells the user nothing about
 * what to do, so the exact fix is spelled out instead.
 */
function describeAuthError(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';

  const currentOrigin = (() => {
    try {
      return window.location.origin.replace(/^https?:\/\//, '');
    } catch {
      return 'this origin';
    }
  })();

  switch (code) {
    case 'auth/unauthorized-domain':
      return new Error(
        `"${currentOrigin}" is not an authorized domain for this Firebase project.\n\n` +
          `Firebase console → Authentication → Settings → Authorized domains → Add domain:\n` +
          `  ${currentOrigin}\n\n` +
          `For local development also add "localhost". Enable Google under ` +
          `Authentication → Sign-in method.`,
      );

    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return new Error('Sign-in was cancelled.');

    case 'auth/popup-blocked':
      return new Error(
        'The sign-in popup was blocked by the browser. Allow popups for this site and try again.',
      );

    case 'auth/operation-not-allowed':
      return new Error(
        'Google sign-in is not enabled for this Firebase project. Enable it under ' +
          'Authentication → Sign-in method.',
      );

    case 'auth/api-key-not-valid':
    case 'auth/invalid-api-key':
      return new Error(
        'The Firebase API key was rejected. Check VITE_FIREBASE_API_KEY for this project.',
      );

    case 'auth/network-request-failed':
      return new Error(
        'Could not reach Firebase. Check your connection or any network/ad-blocker rules.',
      );

    default:
      return error instanceof Error
        ? error
        : new Error(code || 'Sign-in failed.');
  }
}

const buildFallbackProfile = (user: User): UserProfile => ({
  id: user.uid,
  email: user.email || `${user.uid.slice(0, 8)}@fundagoat.internal`,
  displayName: user.displayName || 'FundAGoat Trader',
  telegramNotificationsEnabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  /**
   * loading covers both:
   * 1. Firebase Auth session initialization
   * 2. Initial Firestore profile loading
   */
  const [loading, setLoading] = useState(true);

  const [isFirebaseConnected, setIsFirebaseConnected] = useState(false);

  /**
   * Resolved once from the public platform status endpoint. Also warms the
   * cache used by resolveApiAuthHeaders so the first API call never races it.
   */
  const [authMode, setAuthMode] = useState<'firebase' | 'dev' | 'none' | null>(null);

  /**
   * Last sign-in failure, shown verbatim in the UI. Firebase errors are
   * useless as raw codes, so the message is the actionable form.
   */
  const [authError, setAuthError] = useState<string | null>(null);

  /**
   * Loads the application profile associated with the Firebase UID.
   *
   * Firebase Auth is the source of truth for identity.
   * Firestore is only the source of truth for application profile data.
   */
  const loadOrCreateProfile = useCallback(async (user: User) => {
    const userDocRef = doc(db, 'users', user.uid);

    try {
      const snap = await getDoc(userDocRef);

      if (snap.exists()) {
        setProfile(snap.data() as UserProfile);
        return;
      }

      const newProfile = buildFallbackProfile(user);

      await setDoc(userDocRef, {
        ...newProfile,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setProfile(newProfile);
    } catch (error) {
      /**
       * Authentication is still valid even if Firestore is temporarily
       * unavailable. Keep the session alive with a local fallback profile.
       *
       * IMPORTANT:
       * The fallback is not written to the server and therefore should
       * not be treated as persisted profile state.
       */
      console.warn(
        'Unable to load user profile from Firestore. Using temporary local profile.',
        error
      );

      setProfile(buildFallbackProfile(user));
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    /**
     * Resolve the server's auth mode once. This both labels the session
     * honestly and warms the header cache.
     */
    void getPlatformStatus().then((status) => {
      if (!mounted) return;
      setAuthMode(status?.platform?.authMode ?? 'none');
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const setConnection = (connected: boolean) => {
      if (mounted) setIsFirebaseConnected(connected);
    };

    /**
     * Firebase Auth is the authoritative source for the current user.
     *
     * Firestore connectivity is verified INSIDE this callback: probing before
     * the session resolves would always fail, because there is no uid to read
     * and the security rules deny anonymous access.
     */
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!mounted) return;

      setCurrentUser(user);

      if (!user) {
        setProfile(null);
        setConnection(false);
        setLoading(false);
        return;
      }

      /**
       * Profile loading is part of initial auth hydration.
       */
      await loadOrCreateProfile(user);

      if (mounted) {
        setLoading(false);
      }

      try {
        const connected = await testConnection();
        setConnection(connected);
      } catch {
        setConnection(false);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [loadOrCreateProfile]);

  /**
   * Google authentication.
   *
   * IMPORTANT:
   * A failed Google login is NOT converted into an anonymous account.
   * Doing that can create an unexpected second identity and make users
   * believe their data has disappeared.
   */
  const loginWithGoogle = useCallback(async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      setAuthError(null);
    } catch (error) {
      const described = describeAuthError(error);
      setAuthError(described.message);
      throw described;
    }
  }, []);

  /**
   * Anonymous authentication.
   *
   * The error is deliberately re-thrown so the UI can display the actual
   * authentication failure instead of silently pretending login succeeded.
   */
  const loginAnonymouslyHandler = useCallback(async () => {
    try {
      await signInAnonymously(auth);
      setAuthError(null);
    } catch (error) {
      const described = describeAuthError(error);
      setAuthError(described.message);
      throw described;
    }
  }, []);

  /**
   * Firebase sign-out.
   */
  /**
   * Firebase sign-out, followed by a FULL document navigation to /login.
   *
   * Three reasons the navigation is not a router push:
   *
   *   1. GoatContext and MarketContext hold fetched, user-specific data in
   *      component state. A client-side transition leaves that mounted, so the
   *      previous user's GOATs remain in memory and can flash if the user
   *      presses Back.
   *   2. Browser back-navigation must not re-enter protected content. Reloading
   *      a clean document at /login guarantees there is no app state to restore.
   *   3. It re-runs the auth listener from scratch, so the session cannot be
   *      resurrected from a stale in-memory token.
   *
   * The error is re-thrown so the caller can report it. Reporting a successful
   * sign-out that did not happen is the worst possible outcome here: the user
   * would believe they are logged out while their session is still valid.
   */
  const logout = useCallback(async () => {
    try {
      await firebaseSignOut(auth);

      /**
       * Clear immediately as well as via the auth listener, so the gate swaps to
       * the signed-out screen without waiting for another render cycle.
       */
      setCurrentUser(null);
      setProfile(null);

      // Unreachable in a test environment; harmless there.
      if (typeof window !== 'undefined' && window.location) {
        window.location.assign('/login');
      }
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  }, []);

  /**
   * Updates application-specific profile data.
   *
   * Firebase Auth remains authoritative for identity fields such as
   * uid/email/provider identity.
   */
  const updateProfileData = useCallback(
    async (data: Partial<UserProfile>) => {
      if (!currentUser || !profile) {
        throw new Error('Cannot update profile while not authenticated.');
      }

      const userDocRef = doc(db, 'users', currentUser.uid);

      /**
       * Optimistic local update.
       */
      const updatedProfile: UserProfile = {
        ...profile,
        ...data,
        updatedAt: new Date().toISOString(),
      };

      setProfile(updatedProfile);

      try {
        await setDoc(
          userDocRef,
          {
            ...data,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (error) {
        /**
         * Roll back the optimistic update if persistence fails.
         */
        setProfile(profile);

        console.warn('Profile Firestore write failed:', error);
        throw error;
      }
    },
    [currentUser, profile]
  );

  /**
   * Resolves request headers for the server's configured auth mode.
   *
   * SECURITY MODEL (authMode = 'firebase'):
   *
   * Browser
   *   ↓
   * Firebase ID token
   *   ↓
   * Authorization: Bearer <token>
   *   ↓
   * Server verifies token with Firebase Admin SDK
   *   ↓
   * Server obtains authenticated Firebase UID
   *   ↓
   * UID determines resource ownership
   *
   * The client never sends an arbitrary UID as an authentication mechanism
   * against a Firebase-configured server; dev header auth exists only when
   * the operator explicitly enabled SIGNALGOAT_ALLOW_DEV_AUTH.
   */
  const getApiAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const firebaseUser = auth.currentUser;

    let firebaseToken: string | null = null;
    if (firebaseUser) {
      try {
        /** getIdToken() automatically refreshes the token when necessary. */
        firebaseToken = (await firebaseUser.getIdToken()) || null;
      } catch (error) {
        console.warn('Unable to obtain Firebase authentication token:', error);
        firebaseToken = null;
      }
    }

    return resolveApiAuthHeaders(firebaseToken);
  }, []);

  /**
   * Whether API calls are permitted right now.
   *
   * The previous expression was `Boolean(currentUser) || !loading`, which was
   * true during hydration — so a data provider could fetch before the session
   * was known, and its result would land in a component that AuthGate then
   * unmounted. It is now strictly: a user exists AND hydration is finished, or
   * the server reports development mode.
   */
  const canQueryApi = React.useMemo(() => {
    if (authMode === 'dev') return true;
    if (authMode === null || loading) return false;
    return authMode === 'none' ? false : Boolean(currentUser);
  }, [authMode, loading, currentUser]);

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        profile,
        loading,
        isFirebaseConnected,
        canQueryApi,
        authMode,
        authError,
        loginWithGoogle,
        loginAnonymously: loginAnonymouslyHandler,
        logout,
        updateProfileData,
        getApiAuthHeaders,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
};