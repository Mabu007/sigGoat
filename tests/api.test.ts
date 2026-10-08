import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * API-level integration tests.
 *
 * These boot the REAL apiRouter on an ephemeral port and exercise the
 * authentication + ownership boundaries exactly as a client would:
 *   - unauthenticated            -> 401
 *   - malformed identity header  -> 401
 *   - auth not configured        -> 503 (never silently open)
 *   - owner                      -> 200
 *   - non-owner / cross-user     -> 404 (no resource enumeration)
 *   - Telegram webhook secret + payload validation
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Environment must be in place BEFORE the router module is loaded.
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  process.env.NODE_ENV = 'test';
  // Hermetic: never touch the live market-data feed from a test.
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-api-test-'));
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
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function req(
  method: string,
  urlPath: string,
  options?: { userId?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options?.headers ?? {}) };
  if (options?.userId) headers['x-dev-user-id'] = options.userId;
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (res) => {
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  });
}

async function createGoat(userId: string, name = 'Owned Goat'): Promise<string> {
  const res = await req('POST', '/goats', {
    userId,
    body: {
      name,
      goal: 'Disciplined conditional setups.',
      markets: ['EUR/USD'],
      skillIds: ['skill_price_action'],
      model: 'openai/gpt-4o-mini',
      // Hostile identity claim in the body — must be ignored entirely.
      userId: 'attacker_spoofed_user',
    },
  });
  expect(res.status).toBe(200);
  return res.json.goat.id as string;
}

describe('API authentication', () => {
  test('unauthenticated request is rejected with 401', async () => {
    const res = await req('GET', '/goats');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHENTICATED');
  });

  test('malformed dev identity header is rejected with 401', async () => {
    const res = await req('GET', '/goats', { userId: 'bad uid with spaces!' });
    expect(res.status).toBe(401);
  });

  test('auth-not-configured mode returns 503 — never silently open', async () => {
    const saved = process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
    delete process.env.SIGNALGOAT_ALLOW_DEV_AUTH;
    try {
      const res = await req('GET', '/goats');
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('AUTH_NOT_CONFIGURED');
    } finally {
      process.env.SIGNALGOAT_ALLOW_DEV_AUTH = saved;
    }
  });
});

describe('API ownership and authorization', () => {
  test('created GOAT belongs to the verified identity, never the request body', async () => {
    const res = await req('POST', '/goats', {
      userId: 'user_owner',
      body: {
        name: 'Mine',
        goal: 'Goal.',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
        userId: 'user_spoofed',
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.goat.userId).toBe('user_owner');
    expect(res.json.goat.userId).not.toBe('user_spoofed');
  });

  test('owner can read; non-owner gets 404 for the same GOAT', async () => {
    const goatId = await createGoat('user_a');

    const owner = await req('GET', `/goats/${goatId}`, { userId: 'user_a' });
    expect(owner.status).toBe(200);
    expect(owner.json.goat.id).toBe(goatId);

    const other = await req('GET', `/goats/${goatId}`, { userId: 'user_b' });
    expect(other.status).toBe(404);
  });

  test('cross-user wake is blocked; owner wake runs', async () => {
    const goatId = await createGoat('user_c');

    const foreignWake = await req('POST', `/goats/${goatId}/wake`, {
      userId: 'user_d',
      body: { reason: 'intrusion attempt' },
    });
    expect(foreignWake.status).toBe(404);

    const ownerWake = await req('POST', `/goats/${goatId}/wake`, {
      userId: 'user_c',
      body: { reason: 'legit reevaluation' },
    });
    expect(ownerWake.status).toBe(200);
    expect(ownerWake.json.state).toBeDefined();
    expect(ownerWake.json.state.lastWakeEvent.details).toContain('NO_TRADE');
    expect(ownerWake.json.dataMode).toBe('PAPER');
  });

  test('cross-user signals and chat are blocked', async () => {
    const goatId = await createGoat('user_e');

    const foreignSignals = await req('GET', `/goats/${goatId}/signals`, { userId: 'user_f' });
    expect(foreignSignals.status).toBe(404);

    const foreignChat = await req('POST', `/goats/${goatId}/chat`, {
      userId: 'user_f',
      body: { question: 'What is the thesis?' },
    });
    expect(foreignChat.status).toBe(404);
  });

  test('cross-user delete is blocked; owner delete succeeds and removes the GOAT', async () => {
    const goatId = await createGoat('user_g');

    const foreignDelete = await req('DELETE', `/goats/${goatId}`, { userId: 'user_h' });
    expect(foreignDelete.status).toBe(404);

    const stillThere = await req('GET', `/goats/${goatId}`, { userId: 'user_g' });
    expect(stillThere.status).toBe(200);

    const ownerDelete = await req('DELETE', `/goats/${goatId}`, { userId: 'user_g' });
    expect(ownerDelete.status).toBe(200);
    expect(ownerDelete.json.success).toBe(true);

    const gone = await req('GET', `/goats/${goatId}`, { userId: 'user_g' });
    expect(gone.status).toBe(404);
  });

  test('GOAT list only contains the caller\'s own GOATs', async () => {
    await createGoat('user_i', 'Mine only');
    const res = await req('GET', '/goats', { userId: 'user_j' });
    expect(res.status).toBe(200);
    expect(res.json.goats.length).toBe(0);
  });
});

describe('Telegram webhook validation', () => {
  test('wrong webhook secret is rejected with 401', async () => {
    const res = await req('POST', '/telegram/webhook', {
      body: { update_id: 1 },
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHORIZED_WEBHOOK');
  });

  test('missing webhook secret header is rejected with 401', async () => {
    const res = await req('POST', '/telegram/webhook', { body: { update_id: 1 } });
    expect(res.status).toBe(401);
  });

  test('payload that is not a Telegram update is rejected with 400', async () => {
    const res = await req('POST', '/telegram/webhook', {
      body: { foo: 'bar' },
      headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INVALID_UPDATE');
  });

  test('a valid update for an unlinked chat is acknowledged without fabrication', async () => {
    const res = await req('POST', '/telegram/webhook', {
      body: { update_id: 2, message: { chat: { id: 999999 }, text: '/status' } },
      headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    });
    expect(res.status).toBe(200);
    expect(res.json.handled).toBeDefined();
  });
});
