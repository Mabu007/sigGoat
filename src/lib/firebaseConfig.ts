/**
 * FIREBASE CLIENT CONFIG
 * ======================
 * Reads the PUBLIC Firebase Web App configuration.
 *
 * WHERE THE VALUES COME FROM
 *
 * The Vercel project already holds the Firebase web config under the
 * `FIREBASE_*` names the Firebase console uses (`FIREBASE_appId`,
 * `FIREBASE_messagingSenderId`, …). There are no duplicate `VITE_FIREBASE_*`
 * variables and none are needed.
 *
 * `vite.config.ts` maps that existing set into the `__VITE_FIREBASE_*` globals
 * this module reads. The mapping is an EXPLICIT ALLOW-LIST of those seven
 * values, because a prefix match on `FIREBASE_` would also inline
 * `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` — the admin private key — into the
 * public bundle. That is why this file reads narrowly-named globals instead of
 * `import.meta.env.FIREBASE_*`.
 *
 * These seven values are NOT secrets. Firebase ships them to every browser in
 * every web app, and access is governed by Security Rules, not by hiding them.
 * Everything that IS a secret (the service account, provider keys, Telegram
 * tokens, Cloudflare secrets) is read on the server only and is never bundled.
 */

/**
 * The injected values.
 *
 * Declared rather than reached through a dynamic lookup on `import.meta.env`,
 * because Vite replaces a literal `import.meta.env.__VITE_FIREBASE_APP_ID` at
 * build time and cannot resolve a computed key. Each is `undefined` only when
 * the build ran outside Vite entirely, which is treated as "not configured".
 */
const injected = {
  apiKey: import.meta.env.__VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.__VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.__VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket:
    import.meta.env.__VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId:
    import.meta.env.__VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.__VITE_FIREBASE_APP_ID as string | undefined,
  measurementId:
    import.meta.env.__VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
  /** Optional: only set for a NON-default Firestore database. */
  firestoreDatabaseId:
    import.meta.env.__VITE_FIREBASE_FIRESTORE_DATABASE_ID as string | undefined,
};

function value(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

/**
 * True when the public config is present.
 *
 * The app degrades to a clearly-labelled offline/local mode when it is not,
 * rather than throwing an opaque FirebaseError during module evaluation.
 */
export const isFirebaseConfigured = Boolean(
  value(injected.apiKey) &&
    value(injected.projectId) &&
    value(injected.appId),
);

export const firebaseConfig = {
  apiKey: value(injected.apiKey),
  authDomain: value(injected.authDomain),
  projectId: value(injected.projectId),
  storageBucket: value(injected.storageBucket),
  messagingSenderId: value(injected.messagingSenderId),
  appId: value(injected.appId),
  measurementId: value(injected.measurementId),
  // Empty string means "the default database". getFirestore(app, '') throws,
  // so it is normalised to undefined here.
  firestoreDatabaseId: value(injected.firestoreDatabaseId) || undefined,
};

/**
 * List of things to fix when the config is missing. Surfaced in the UI so the
 * developer is told exactly which value is absent instead of getting a bare
 * "Missing or insufficient permissions" from Firestore.
 */
export const firebaseConfigMissing: string[] = [
  ['apiKey', 'FIREBASE_apiKey'],
  ['authDomain', 'FIREBASE_authDomain'],
  ['projectId', 'FIREBASE_projectId'],
  ['appId', 'FIREBASE_appId'],
]
  .filter(([key]) => !value(injected[key as keyof typeof injected]))
  .map(([, sourceName]) => sourceName);

export const isAuthEmulatorMode =
  value(import.meta.env.VITE_FIREBASE_AUTH_EMULATORS).toLowerCase() === 'true';