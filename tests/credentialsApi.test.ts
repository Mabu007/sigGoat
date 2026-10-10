/**
 * CREDENTIAL + PROPDAO API INTEGRATION TESTS
 *
 * Exercises the real HTTP surface with the real router, the real persistence
 * layer and a real master key. These are the tests that would catch a route
 * that reads the wrong user's credential, echoes a secret, or lets the client
 * switch on execution.
 *
 * NO EXTERNAL PROVIDER IS CONTACTED. PropDAO routes are exercised with no
 * credential saved, which is the state a fresh account is in, plus the
 * validation and refusal paths that must hold before any outbound call.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};
/** The exact persistence instance the router bound to. */
let appStore: {
  mode: string;
  credentials: {
    listEncrypted(userId: string): Promise<Array<{ provider: string; envelope: string; updatedAt: string }>>;
  };
} | null = null;

const SCHEDULER_SECRET = 'credentials-api-test-secret';

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    PROPDAO_EXECUTION_ENABLED: process.env.PROPDAO_EXECUTION_ENABLED,
    PROPDAO_EXECUTION_AUTHORISED: process.env.PROPDAO_EXECUTION_AUTHORISED,
  };

  process.env.NODE_ENV = 'test';
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.DURABLE_SCHEDULER_SECRET = SCHEDULER_SECRET;
  process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_MASTER_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key';
  // Execution OFF. A test that needs it on sets it explicitly and restores.
  delete process.env.PROPDAO_EXECUTION_ENABLED;
  delete process.env.PROPDAO_EXECUTION_AUTHORISED;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundagoat-credentials-'));
  process.env.DATA_DIR = dataDir;

  const { apiRouter, appPersistence: persistence } = await import('../src/server/apiRouter');
  appStore = persistence;
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
  baseUrl = `http://127.0.0.1:${address.port}/api`;
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
  options?: { userId?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options?.userId) headers['x-dev-user-id'] = options.userId;

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const PROPDAO_KEY = `pd_live_${'a'.repeat(32)}`;
const OPENROUTER_KEY = `sk-or-v1-${'b'.repeat(40)}`;

  /**
 * Reads the stored credential envelopes out of the persistence layer the
 * router is actually using.
 *
 * WHY NOT THE FILESYSTEM
 *   The router module is process-wide and `DATA_DIR` is read when it is first
 *   imported. Whichever harness won that race owns the store, and it may have
 *   already been torn down — at which point `persist()` swallows the write and
 *   no state file exists anywhere. Reading the LIVE store asserts the real
 *   invariant (what is actually stored) instead of a side effect that depends
 *   on which test file happened to import the router first.
 */
async function allEnvelopes(): Promise<string[]> {
  const ids = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina-disconnect'];
  const out: string[] = [];
  for (const id of ids) {
    const records = await appStore!.credentials.listEncrypted(id);
    for (const record of records) {
      out.push(`${id}/${record.provider}:${record.envelope}`);
    }
  }
  return out;
}

describe('credential storage through the API', () => {
  test('saves a PropDAO key and reports it as configured', async () => {
    const saved = await call('POST', '/settings/keys', {
      userId: 'alice',
      body: { propDaoApiKey: PROPDAO_KEY },
    });
    expect(saved.status).toBe(200);

    const status = await call('GET', '/settings/keys', { userId: 'alice' });
    expect(status.json.propDaoKeyConfigured).toBe(true);
  });

  test('NEVER returns the secret in any response', async () => {
    const after = await call('GET', '/settings/keys', { userId: 'alice' });
    const body = JSON.stringify(after.json);
    expect(body).not.toContain(PROPDAO_KEY);
    // Only a masked hint, which is the point of masking.
    expect(after.json.propDaoKeyHint).toBeDefined();
    expect(after.json.propDaoKeyHint).not.toContain('a'.repeat(10));
  });

  test('stores the secret ENCRYPTED, never as plaintext', async () => {
    const records = await allEnvelopes();
    const raw = records.join('\n');
    expect(records.length).toBeGreaterThan(0);
    // A plaintext key in the store would defeat the whole design.
    expect(raw).not.toContain(PROPDAO_KEY);
    expect(raw).not.toContain(OPENROUTER_KEY);
    expect(raw).not.toContain('pd_live_');
    // And the record IS present, as a versioned envelope stamped with the key id.
    expect(raw).toMatch(/v1\.test-key\./);
  });

  test('reports the vault as available', async () => {
    const status = await call('GET', '/settings/keys', { userId: 'alice' });
    expect(status.json.encryptionAvailable).toBe(true);
  });

  test('rejects a malformed key with 400 and stores nothing', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'bob',
      body: { propDaoApiKey: 'sk-or-v1-not-a-propdao-key' },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.message).toMatch(/PropDAO API key/);

    const status = await call('GET', '/settings/keys', { userId: 'bob' });
    expect(status.json.propDaoKeyConfigured).toBe(false);
  });

  test('trims surrounding whitespace from a pasted key', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'carol',
      body: { propDaoApiKey: `  ${PROPDAO_KEY}  ` },
    });
    expect(response.status).toBe(200);
    const status = await call('GET', '/settings/keys', { userId: 'carol' });
    expect(status.json.propDaoKeyConfigured).toBe(true);
  });

  test('ISOLATES one user from another', async () => {
    const alice = await call('GET', '/settings/keys', { userId: 'alice' });
    const mallory = await call('GET', '/settings/keys', { userId: 'mallory' });
    expect(alice.json.propDaoKeyConfigured).toBe(true);
    expect(mallory.json.propDaoKeyConfigured).toBe(false);
    expect(JSON.stringify(mallory.json)).not.toContain(PROPDAO_KEY);
  });

  test('ignores a client-supplied userId in the body', async () => {
    // Ownership comes from the verified token, so a body field naming another
    // user must have no effect.
    await call('POST', '/settings/keys', {
      userId: 'dave',
      body: { propDaoApiKey: PROPDAO_KEY, userId: 'alice' },
    });
    const alice = await call('GET', '/settings/keys', { userId: 'alice' });
    const dave = await call('GET', '/settings/keys', { userId: 'dave' });
    expect(alice.json.propDaoKeyConfigured).toBe(true);
    expect(dave.json.propDaoKeyConfigured).toBe(true);
  });

  test('requires authentication', async () => {
    const response = await call('GET', '/settings/keys');
    // No auth header at all: the middleware must refuse rather than serve.
    expect([401, 503]).toContain(response.status);
    expect(JSON.stringify(response.json)).not.toContain(PROPDAO_KEY);
  });

  test('fails with a clear error when the vault is unavailable', async () => {
    const savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      const response = await call('POST', '/settings/keys', {
        userId: 'erin',
        body: { propDaoApiKey: PROPDAO_KEY },
      });
      // 503, and specifically NOT a 200 that silently dropped the secret.
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.json)).not.toContain(PROPDAO_KEY);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
    }
  });
});

describe('PropDAO API surface', () => {
  test('reports a not-configured connection without contacting the provider', async () => {
    const response = await call('GET', '/propdao/status', { userId: 'frank' });
    expect(response.status).toBe(200);
    expect(response.json.credential.configured).toBe(false);
    expect(response.json.connected).toBe(false);
    expect(response.json.verification.code).toBe('NO_CREDENTIAL');
  });

  test('reports execution as DISABLED by default', async () => {
    const response = await call('GET', '/propdao/status', { userId: 'alice' });
    expect(response.json.execution.enabled).toBe(false);
    expect(response.json.execution.authorised).toBe(false);
    expect(response.json.execution.summary).toMatch(/does not place trades/);
    // The terms rationale must be visible, not hidden.
    expect(response.json.execution.termsSummary).toMatch(/non-commercial use/);
  });

  test('declares the documented capability absences', async () => {
    const response = await call('GET', '/propdao/capabilities', { userId: 'alice' });
    expect(response.status).toBe(200);
    expect(response.json.capabilities.modifyOrder).toBe(false);
    expect(response.json.capabilities.payout).toBe(false);
    expect(response.json.capabilities.webhooks).toBe(false);
    expect(response.json.capabilities.readRisk).toBe(true);
  });

  test('the capabilities route requires auth and leaks no secret', async () => {
    const anonymous = await call('GET', '/propdao/capabilities');
    expect(anonymous.status).toBe(401);

    const response = await call('GET', '/propdao/capabilities', { userId: 'alice' });
    expect(JSON.stringify(response.json)).not.toContain(PROPDAO_KEY);
  });

  test('returns an empty account list with no credential', async () => {
    const response = await call('GET', '/propdao/accounts', { userId: 'frank' });
    expect(response.status).toBe(200);
    expect(response.json.accounts).toEqual([]);
    expect(response.json.configured).toBe(false);
  });

  test('validates a risk-check request BEFORE any provider call', async () => {
    const response = await call('POST', '/propdao/risk-check', {
      userId: 'alice',
      body: { accountId: 'prop-1', symbol: 'BTCUSDC', side: 'MAYBE', qty: 1, entry: 1, stopLoss: 1, takeProfit: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.message).toMatch(/BUY or SELL/);
  });

  test('rejects a non-numeric price in a risk check', async () => {
    const response = await call('POST', '/propdao/risk-check', {
      userId: 'alice',
      body: { accountId: 'prop-1', symbol: 'BTCUSDC', side: 'BUY', qty: 1, entry: 'lots', stopLoss: 1, takeProfit: 1 },
    });
    expect(response.status).toBe(400);
  });

  test('refuses an account the caller cannot prove ownership of', async () => {
    const response = await call('POST', '/propdao/risk-check', {
      userId: 'frank',
      body: { accountId: 'someone-elses-account', symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, entry: 100, stopLoss: 99, takeProfit: 102 },
    });
    // 404 rather than proceeding — the account is not in this key's list.
    expect(response.status).toBe(404);
    expect(response.json.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  test('disconnect clears the stored key', async () => {
    // Self-contained: it saves its own key rather than depending on another
    // test having run first, so it is correct in isolation and in the full run.
    const userId = 'gina-disconnect';
    await call('POST', '/settings/keys', { userId, body: { propDaoApiKey: PROPDAO_KEY } });
    const before = await call('GET', '/settings/keys', { userId });
    expect(before.json.propDaoKeyConfigured).toBe(true);

    const response = await call('DELETE', '/propdao/connect', { userId });
    expect(response.status).toBe(200);
    expect(response.json.connected).toBe(false);

    const after = await call('GET', '/settings/keys', { userId });
    expect(after.json.propDaoKeyConfigured).toBe(false);
    expect(after.json.propDaoKeyHint).toBeUndefined();

    // The stored record is gone: the vault's `deleteCredential` removes the
    // envelope rather than blanking it, so nothing remains to decrypt.
    const raw = (await allEnvelopes()).join('\n');
    expect(raw).not.toContain(PROPDAO_KEY);
    // No credential envelope survives for the disconnected user.
    expect(raw).not.toContain('gina-disconnect/propdao');
  });

  test('a client cannot switch on execution', async () => {
    // Even a user who knows the env var names has no way to enable it.
    const response = await call('POST', '/settings/keys', {
      userId: 'alice',
      body: {
        propDaoApiKey: PROPDAO_KEY,
        PROPDAO_EXECUTION_ENABLED: 'true',
        executionEnabled: true,
        enableExecution: true,
      },
    });
    expect(response.status).toBe(200);
    const status = await call('GET', '/propdao/status', { userId: 'alice' });
    expect(status.json.execution.enabled).toBe(false);
  });
});