import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * PUBLIC FIREBASE WEB CONFIG — the exact mapping the browser needs.
 *
 * The Vercel project already holds these under `FIREBASE_*` with the Firebase
 * console's own camelCase names (`FIREBASE_appId`, not `FIREBASE_APP_ID`), so
 * they are reused as-is and no duplicate `VITE_FIREBASE_*` set is required.
 *
 * These seven values are NOT secrets. Firebase ships them to every browser in
 * every Firebase web app, and access is governed by Security Rules, not by
 * hiding them.
 *
 * WHY AN EXPLICIT ALLOW-LIST AND NOT `envPrefix: ['FIREBASE_']`
 *
 * `envPrefix` is a PREFIX match, so `FIREBASE_` also exposes
 * `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` — which holds the service account's
 * PRIVATE KEY and which Vercel makes available to the build step. That put the
 * admin credential in the public client bundle.
 *
 * It went unnoticed because the key is base64-encoded: grepping the bundle for
 * `BEGIN PRIVATE KEY` or `iam.gserviceaccount.com` finds nothing, since neither
 * string appears in plaintext. The leak is only visible by base64-DECODING
 * candidate blobs. Verifying a bundle with a plaintext grep is not a valid
 * check for a base64 secret.
 *
 * An allow-list cannot fail that way: a variable that is not named here is
 * never inlined, regardless of its value or encoding.
 */
const FIREBASE_WEB_CONFIG: Record<string, string> = {
  __VITE_FIREBASE_API_KEY: 'FIREBASE_apiKey',
  __VITE_FIREBASE_AUTH_DOMAIN: 'FIREBASE_authDomain',
  __VITE_FIREBASE_PROJECT_ID: 'FIREBASE_projectId',
  __VITE_FIREBASE_STORAGE_BUCKET: 'FIREBASE_storageBucket',
  __VITE_FIREBASE_MESSAGING_SENDER_ID: 'FIREBASE_messagingSenderId',
  __VITE_FIREBASE_APP_ID: 'FIREBASE_appId',
  __VITE_FIREBASE_MEASUREMENT_ID: 'FIREBASE_measurementId',
};

/**
 * Resolves the allow-list to real values.
 *
 * Three sources, in order:
 *   1. the already-`VITE_`-prefixed name — local development and CI;
 *   2. the existing `FIREBASE_*` variable — what the hosting project provides,
 *      injected into `process.env` for the build;
 *   3. the same two names as read by `loadEnv` from `.env*` files.
 *
 * `loadEnv` MATTERS LOCALLY. Vite populates `import.meta.env` from `.env`
 * files AFTER the config module has been evaluated, so reading `process.env`
 * alone would miss `.env.local` entirely and a local build would ship a bundle
 * with no Firebase config — the exact failure this is meant to prevent, just
 * moved from production to the developer's machine.
 */
function resolveFirebaseDefine(
  env: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
): Record<string, string> {
  const define: Record<string, string> = {};

  for (const [viteName, sourceName] of Object.entries(FIREBASE_WEB_CONFIG)) {
    const localName = viteName.replace(/^__VITE_/, 'VITE_');

    const value = (
      env[localName] ??
      env[sourceName] ??
      fileEnv[localName] ??
      fileEnv[sourceName] ??
      ''
    ).trim();

    /**
     * The key is the FULL `import.meta.env.X` expression, not a bare
     * identifier.
     *
     * Vite's `define` replaces bare identifiers and `process.env.X`; an
     * `import.meta.env.X` key is matched literally. A bare
     * `__VITE_FIREBASE_*` key therefore does nothing, and the bundle ships with
     * no config while the failure looks identical to a missing variable.
     *
     * JSON.stringify makes the value a JS string literal rather than raw text
     * spliced into the bundle.
     */
    define[`import.meta.env.${viteName}`] = JSON.stringify(value);
  }

  return define;
}

export default defineConfig(({ mode }) => {
  // `.env*` files are read explicitly, because Vite only applies them to
  // `import.meta.env` after this module has already run.
  const fileEnv = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],

    /**
     * `VITE_` only.
     *
     * Adding `FIREBASE_` here is what exposed the admin service-account key to
     * the browser; it must never be widened again. Every variable the client
     * legitimately needs is injected explicitly by `define` below.
     */
    envPrefix: 'VITE_',

    /**
     * The public Firebase web config, and nothing else.
     *
     * Injected as `__VITE_FIREBASE_*` globals so `src/lib/firebaseConfig.ts`
     * reads them by name. A missing value becomes `""`, which is what
     * `isFirebaseConfigured` already treats as "not configured" — so an
     * unconfigured build degrades to the existing offline mode instead of
     * producing a half-initialised Firebase app.
     */
    define: resolveFirebaseDefine(process.env, fileEnv),

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});