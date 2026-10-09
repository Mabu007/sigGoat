import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocFromServer,
  serverTimestamp,
} from 'firebase/firestore';

import {
  firebaseConfig,
  firebaseConfigMissing,
  isAuthEmulatorMode,
  isFirebaseConfigured,
} from './firebaseConfig';

if (!isFirebaseConfigured) {
  /**
   * Names the variables as they ACTUALLY exist on the hosting provider.
   *
   * This used to say `VITE_FIREBASE_*`, which are not set anywhere — so anyone
   * following it would have created duplicate variables that the build does not
   * read. The real names are the `FIREBASE_*` ones already configured in the
   * project, mapped by vite.config.ts.
   */
  console.warn(
    '[firebase] Public config missing. The app will run in local/offline mode. ' +
      'These must be set in the build environment (they are mapped into the ' +
      'bundle by vite.config.ts): ' +
      (firebaseConfigMissing.length > 0
        ? firebaseConfigMissing.join(', ')
        : 'FIREBASE_apiKey, FIREBASE_authDomain, FIREBASE_projectId, FIREBASE_appId') +
      '. Sign-in will not work until they are present.',
  );
}

const app = !getApps().length
  ? initializeApp(firebaseConfig)
  : getApp();

/**
 * `getFirestore(app, '')` throws, so the database id is only passed when it
 * is actually set. An absent id means the project's default database.
 */
export const db =
  firebaseConfig.firestoreDatabaseId !== undefined
    ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
    : getFirestore(app);

export const auth = getAuth(app);

if (isAuthEmulatorMode) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connect = (auth as any).emulatorConfig;
  if (connect && typeof connect === 'function') {
    connect();
    console.info('[firebase] Auth emulator enabled (loopback only).');
  }
}

export const googleProvider = new GoogleAuthProvider();

export {
  onAuthStateChanged,
  type User,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };

  console.error('Firestore Error:', JSON.stringify(errInfo));

  throw new Error(JSON.stringify(errInfo));
}

/**
 * Verifies Firestore is reachable *and* that the signed-in user is actually
 * allowed to read their own data.
 *
 * It deliberately probes `users/{uid}` — the one document every rule set must
 * grant the owner — instead of a synthetic probe doc, which default-deny
 * rules reject and which previously produced a permanent, meaningless
 * "Missing or insufficient permissions" console error.
 *
 * Returns false when there is no session (nothing to verify) or when the
 * rules deny the read; both are reported honestly by the UI as
 * "Offline / Local".
 */
export async function testConnection(): Promise<boolean> {
  const user = auth.currentUser;

  if (!user) {
    return false;
  }

  try {
    await getDocFromServer(doc(db, 'users', user.uid));
    return true;
  } catch (error) {
    console.warn('Firestore connection test failed:', describeFirestoreError(error));
    return false;
  }
}

function describeFirestoreError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.message : String(error);
}

export {
  signInWithPopup,
  signInAnonymously,
  firebaseSignOut,
};
