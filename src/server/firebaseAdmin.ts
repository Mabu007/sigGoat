/**
 * SHARED FIREBASE-ADMIN SINGLETON
 * ===============================
 * firebase-admin only permits one initializeApp() per (projectId, appId) pair;
 * both the auth middleware and the persistence layer need it, so init is
 * centralized here.
 *
 * WHY THE IMPORTS ARE STATIC
 * --------------------------
 * This module used to load the SDK with a dynamic `createRequire(...)`. That
 * works locally, and it fails SILENTLY on Vercel:
 *
 *   Vercel traces a function's dependencies to decide what to upload. A
 *   static `import` is traced; a dynamic `require` computed at runtime is
 *   not. So `firebase-admin` was left out of the deployment entirely, and
 *   the deployed API answered every request with
 *
 *     Cannot find module 'firebase-admin'
 *     Require stack: - /var/task/.api-build/index.mjs
 *
 *   which surfaced as an opaque FUNCTION_INVOCATION_FAILED on every route.
 *   Express was in the deployment because it is statically imported, which
 *   is why the server booted at all.
 *
 * The SDK is still INITIALIZED lazily — nothing is constructed until the
 * first call — so the lazy behaviour that mattered is preserved. Only the
 * module resolution became static, which is what the deploy needs.
 *
 * This module is server-only. The client bundle never imports it, so
 * firebase-admin is never shipped to a browser.
 */

import { cert, initializeApp, type App } from 'firebase-admin/app';
import fs from 'fs';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

export interface FirebaseAdminBundle {
  app: App;
  firestore: Firestore;
  auth: Auth;
}

let bundle: FirebaseAdminBundle | null | undefined;

/** One-time, actionable explanation of why admin is unavailable. */
let lastFailureReason: string | undefined;

/** Human-readable reason admin is unavailable (undefined when it is fine). */
export function getFirebaseAdminFailureReason(): string | undefined {
  // Resolve lazily so the reason reflects the state at call time.
  getFirebaseAdmin();
  return lastFailureReason;
}

/**
 * Decodes a service account from either a raw JSON string or a BASE64
 * encoding of it.
 *
 * The BASE64 form exists because most hosts (Vercel included) store
 * multi-line environment variables badly — newlines get mangled or the value
 * is rejected outright. A single-line BASE64 blob always survives.
 */
function parseServiceAccountJson(): { json: string; source: string } | undefined {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    return { json: rawJson, source: 'FIREBASE_SERVICE_ACCOUNT_JSON' };
  }

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (base64) {
    // Tolerate base64url and missing padding.
    const normalised = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded =
      normalised +
      '='.repeat((4 - (normalised.length % 4)) % 4);

    return {
      json: Buffer.from(padded, 'base64').toString('utf8'),
      source: 'FIREBASE_SERVICE_ACCOUNT_JSON_BASE64',
    };
  }

  return undefined;
}

export function getFirebaseAdmin(): FirebaseAdminBundle | null {
  if (bundle !== undefined) return bundle;
  bundle = null;
  lastFailureReason = undefined;

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const serviceAccount = parseServiceAccountJson();

    let credential: import('firebase-admin/app').Credential | undefined;
    let projectConfigured = false;

    if (serviceAccount) {
      credential = cert(JSON.parse(serviceAccount.json));
      projectConfigured = true;
    } else {
      const credentialsPath =
        process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

      if (credentialsPath && fs.existsSync(credentialsPath)) {
        credential = cert(
          JSON.parse(fs.readFileSync(credentialsPath, 'utf8')),
        );
        projectConfigured = true;
      } else if (projectId) {
        // Application Default Credentials (Cloud Run, GCE, etc.)
        projectConfigured = true;
      }
    }

    if (!projectConfigured) {
      lastFailureReason =
        'No Firebase server credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 ' +
        '(preferred), FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, ' +
        'or FIREBASE_PROJECT_ID for Application Default Credentials.';
      return null;
    }

    const resolvedProjectId =
      projectId ||
      (serviceAccount
        ? (JSON.parse(serviceAccount.json).project_id as string | undefined)
        : undefined);

    const app = initializeApp({
      projectId: resolvedProjectId,
      credential,
    });
    const firestore = getFirestore(app);
    const auth = getAuth(app);

    bundle = { app, firestore, auth };
    console.log(
      `[firebase] Admin SDK ready (project: ${resolvedProjectId ?? 'default'}).`,
    );
  } catch (err) {
    lastFailureReason =
      err instanceof Error
        ? err.message
        : 'firebase-admin initialization failed.';
    console.warn('[firebase] firebase-admin initialization failed; continuing without it.', err);
    bundle = null;
  }

  return bundle;
}
