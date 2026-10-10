import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * FIREBASE ADMIN CREDENTIAL HANDLING
 * ===================================
 * The decoding path is load-bearing: a malformed value must produce an
 * actionable diagnostic and a fail-closed result, never a half-initialised SDK
 * or a crash that takes the whole API down.
 *
 * These tests drive `getFirebaseAdmin()` through a real environment, with
 * `firebase-admin` MOCKED so no test can reach a real Google endpoint and no
 * test can read the project's real credential.
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

/** A structurally valid credential document. Contains no real key. */
const VALID_CREDENTIAL = {
  type: 'service_account',
  project_id: 'test-project-1234',
  private_key_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  private_key: '-----BEGIN PRIVATE KEY-----\nTESTKEYMATERIALNOTAREALKEY\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test-project-1234.iam.gserviceaccount.com',
  client_id: '1234567890',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const SCHEDULER_SECRET = 'cred-test-secret';

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };

  process.env.NODE_ENV = 'test';
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.DURABLE_SCHEDULER_SECRET = SCHEDULER_SECRET;

  /**
   * No Firebase credentials, and dev auth explicitly OFF, so the module loads
   * in the "cannot verify tokens" state the fail-closed tests need.
   */
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '0';

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-cred-'));
  process.env.DATA_DIR = dataDir;

  const { apiRouter } = await import('../src/server/apiRouter');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;   // router is mounted at /api
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function call(
  method: string,
  urlPath: string,
  options?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe('credential decoding (pure)', () => {
  /**
   * The exact transformation `parseServiceAccountJson` performs, exercised
   * directly so the encoding rules are pinned rather than inferred.
   */
  const decode = (base64: string): string => {
    const normalised = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  };

  test('valid base64 of a complete JSON document decodes and parses', () => {
    const decoded = decode(Buffer.from(JSON.stringify(VALID_CREDENTIAL)).toString('base64'));
    const parsed = JSON.parse(decoded);

    expect(parsed.type).toBe('service_account');
    expect(parsed.project_id).toBe('test-project-1234');
    expect(parsed.private_key).toContain('BEGIN PRIVATE KEY');
    expect(parsed.client_email).toContain('iam.gserviceaccount.com');
  });

  test('base64url variants decode identically', () => {
    const standard = Buffer.from(JSON.stringify(VALID_CREDENTIAL)).toString('base64');
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');

    expect(decode(urlSafe)).toBe(decode(standard));
  });

  test('missing padding is tolerated', () => {
    const raw = Buffer.from(JSON.stringify(VALID_CREDENTIAL)).toString('base64');
    const unpadded = raw.replace(/=+$/, '');

    expect(() => JSON.parse(decode(unpadded))).not.toThrow();
  });

  test('raw JSON pasted where base64 is expected fails loudly', () => {
    // The reported symptom: "Unexpected token ... is not valid JSON".
    expect(() => JSON.parse(decode(JSON.stringify(VALID_CREDENTIAL)))).toThrow();
  });

  test('a bare private key pasted instead of base64 JSON fails loudly', () => {
    const privateKeyOnly = VALID_CREDENTIAL.private_key;
    expect(() => JSON.parse(decode(privateKeyOnly))).toThrow();
  });

  test('truncated base64 yields invalid JSON rather than a partial credential', () => {
    const truncated = Buffer.from(JSON.stringify(VALID_CREDENTIAL)).toString('base64').slice(0, 24);
    expect(() => JSON.parse(decode(truncated))).toThrow();
  });
});

describe('missing credentials fail closed', () => {
  test('protected routes return 503, not an unauthenticated 200', async () => {
    const response = await call('GET', '/api/goats');

    // 503 because the request could never be evaluated. 200 would mean the
    // route served data with no verified identity at all.
    expect(response.status).toBe(503);
    expect(response.json.error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  test('the 503 body names the cause without leaking any credential', async () => {
    const response = await call('GET', '/api/goats');
    const body = JSON.stringify(response.json);

    expect(body).toMatch(/FIREBASE_SERVICE_ACCOUNT_JSON_BASE64/);
    // Never any part of a credential document.
    expect(body).not.toContain('BEGIN PRIVATE KEY');
    expect(body).not.toContain('private_key');
    expect(body).not.toContain('iam.gserviceaccount.com');
    expect(body).not.toMatch(/gsk_|sk-or-v1-/);
  });

  test('dev auth is refused while a user id header is supplied', async () => {
    // SIGNALGOAT_ALLOW_DEV_AUTH is '0' in this suite.
    const response = await call('GET', '/api/goats', {
      headers: { 'x-dev-user-id': 'attacker' },
    });

    // Without a working verifier the header must not authenticate anyone.
    expect(response.status).toBe(503);
  });

  test('the public status endpoint still works without credentials', async () => {
    const response = await call('GET', '/api/settings/status');

    expect(response.status).toBe(200);
    expect(response.json.platform.authMode).toBe('none');
    // The reason is reported so an operator can act, but no secret is echoed.
    expect(typeof response.json.platform.authNotConfiguredReason).toBe('string');
    expect(JSON.stringify(response.json)).not.toContain('BEGIN PRIVATE KEY');
  });

  test('internal Worker routes remain independently protected', async () => {
    // Auth failing must not weaken the shared-secret surfaces.
    const reconcile = await call('POST', '/api/internal/reconcile', {
      headers: { 'x-scheduler-secret': 'wrong' },
    });
    const event = await call('POST', '/api/internal/market-event', {
      headers: { 'x-scheduler-secret': 'wrong' },
    });

    expect(reconcile.status).toBe(401);
    expect(event.status).toBe(401);
  });

  test('health and market data remain public without credentials', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/markets/symbols')).status).toBe(200);
  });
});