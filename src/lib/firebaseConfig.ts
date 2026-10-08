/**
 * FIREBASE CLIENT CONFIG
 * ======================
 * Reads the PUBLIC Firebase web config from `VITE_FIREBASE_*` build-time
 * variables.
 *
 * WHY ENV VARS INSTEAD OF A COMMITTED JSON:
 * Vite statically replaces `import.meta.env.VITE_*` at BUILD time. That is
 * the correct channel for browser config and means one codebase can target
 * multiple Firebase projects by changing the build environment.
 *
 * These values are NOT secrets — Firebase ships them to every browser and
 * security rests on the Security Rules, not on hiding them. Everything that
 * IS a secret (service accounts, OpenRouter, Telegram, Cloudflare) is read
 * on the server only and is never bundled.
 */

const raw = import.meta.env as Record<string, string | undefined>;

function required(name: string): string {
  const value = raw[name]?.trim();
  return value ?? '';
}

/**
 * True when the public Firebase config is present. The app degrades to a
 * clearly-labelled offline/local mode when it is not, rather than throwing an
 * opaque FirebaseError during module evaluation.
 */
export const isFirebaseConfigured = Boolean(
  required('VITE_FIREBASE_API_KEY') &&
    required('VITE_FIREBASE_PROJECT_ID') &&
    required('VITE_FIREBASE_APP_ID'),
);

export const firebaseConfig = {
  apiKey: required('VITE_FIREBASE_API_KEY'),
  authDomain: required('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: required('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: required('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: required('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: required('VITE_FIREBASE_APP_ID'),
  measurementId: required('VITE_FIREBASE_MEASUREMENT_ID'),
  // Empty string means "the default database". getFirestore(app, '') throws,
  // so it is normalised to undefined here.
  firestoreDatabaseId: required('VITE_FIREBASE_FIRESTORE_DATABASE_ID') || undefined,
};

/**
 * List of things to fix when the config is missing. Surfaced in the UI so the
 * developer is told exactly which variable is absent instead of getting a
 * bare "Missing or insufficient permissions" from Firestore.
 */
export const firebaseConfigMissing: string[] = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
].filter((name) => !required(name));

export const isAuthEmulatorMode =
  required('VITE_FIREBASE_AUTH_EMULATORS').toLowerCase() === 'true';
