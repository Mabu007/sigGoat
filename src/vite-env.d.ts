/**
 * CLIENT ENVIRONMENT TYPES
 * =========================
 * The exact set of build-time variables the client bundle may read.
 *
 * This is a CLOSED list. `ImportMetaEnv` declares what exists; it does not
 * prevent one from being added, but it makes every injected name explicit and
 * reviewable, and it means a typo in `firebaseConfig.ts` is a type error rather
 * than a silent `undefined` that degrades the app to offline mode.
 *
 * Note what is absent: there is no `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` and
 * no `FIREBASE_*` of any kind. The admin service-account credential is a server
 * secret, and nothing in this file grants the browser access to it. See
 * vite.config.ts for how the seven public values are mapped in.
 */

interface ImportMetaEnv {
  /** Firebase Web App API key. Public: shipped to every browser by Firebase. */
  readonly __VITE_FIREBASE_API_KEY?: string;
  readonly __VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly __VITE_FIREBASE_PROJECT_ID?: string;
  readonly __VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly __VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly __VITE_FIREBASE_APP_ID?: string;
  readonly __VITE_FIREBASE_MEASUREMENT_ID?: string;
  /** Only set when using a NON-default Firestore database. */
  readonly __VITE_FIREBASE_FIRESTORE_DATABASE_ID?: string;

  /** Opt-in for the Firebase Auth emulator. Loopback only, never production. */
  readonly VITE_FIREBASE_AUTH_EMULATORS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}