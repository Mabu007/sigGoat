/**
 * SHARED FIREBASE-ADMIN SINGLETON
 * ===============================
 * firebase-admin only permits one initializeApp() per (projectId, appId) pair;
 * both the auth middleware and the persistence layer need it, so init is
 * centralized here. Loaded lazily via require() because firebase-admin is a
 * server-only dependency (never bundled into the client).
 */

import { createRequire } from 'module';
import type { App } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';

// firebase-admin ships CJS; createRequire keeps it loadable from ESM too.
const nodeRequire = createRequire(import.meta.url);

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
    const admin = nodeRequire('firebase-admin') as typeof import('firebase-admin');
    const appModule = nodeRequire('firebase-admin/app') as typeof import('firebase-admin/app');
    const fs = nodeRequire('fs') as typeof import('fs');

    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const serviceAccount = parseServiceAccountJson();

    let credential: import('firebase-admin/app').Credential | undefined;
    let projectConfigured = false;

    if (serviceAccount) {
      credential = appModule.cert(JSON.parse(serviceAccount.json));
      projectConfigured = true;
    } else {
      const credentialsPath =
        process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

      if (credentialsPath && fs.existsSync(credentialsPath)) {
        credential = appModule.cert(
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

    const app = admin.initializeApp({
      projectId: resolvedProjectId,
      credential,
    });
    const firestore = (nodeRequire('firebase-admin/firestore') as typeof import('firebase-admin/firestore')).getFirestore(app);
    const auth = (nodeRequire('firebase-admin/auth') as typeof import('firebase-admin/auth')).getAuth(app);

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
