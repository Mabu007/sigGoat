import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';
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
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    DATA_DIR: process.env.DATA_DIR,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    NODE_ENV: process.env.NODE_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  process.env.NODE_ENV = 'test';
  // The vault fails closed without a master key; tests must supply one.
  process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_MASTER_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key';
  // Hermetic: never touch the live market-data feed from a test.
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.DURABLE_SCHEDULER_SECRET = 'test-scheduler-secret';
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


/* ------------------------------------------------------------------ */
/* Durable scheduler callbacks                                         */
/* ------------------------------------------------------------------ */

describe('internal scheduler callbacks', () => {
  const SECRET_HEADERS = { 'x-scheduler-secret': 'test-scheduler-secret' };

  test('a wrong scheduler secret is rejected with 401', async () => {
    const res = await req('POST', '/internal/wake', {
      body: { goatId: 'g', eventId: 'e1' },
      headers: { 'x-scheduler-secret': 'wrong' },
    });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHORISED');
  });

  test('a missing scheduler secret is rejected with 401', async () => {
    const res = await req('POST', '/internal/wake', {
      body: { goatId: 'g', eventId: 'e1' },
    });
    expect(res.status).toBe(401);
  });

  test('missing goatId/eventId is a 400, not a silent no-op', async () => {
    const res = await req('POST', '/internal/wake', {
      body: {},
      headers: SECRET_HEADERS,
    });
    expect(res.status).toBe(400);
  });

  test('the tracker-check endpoint is equally protected', async () => {
    const res = await req('POST', '/internal/check-trackers', {
      body: { goatId: 'g', eventId: 'e1' },
      headers: { 'x-scheduler-secret': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  test('a valid secret for an unknown GOAT reports handled:false rather than throwing', async () => {
    const res = await req('POST', '/internal/wake', {
      body: { goatId: 'does_not_exist', eventId: 'e1' },
      headers: SECRET_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.json.handled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Tracking timeframe + schedule validation                            */
/* ------------------------------------------------------------------ */

describe('tracking timeframe is validated server-side', () => {
  test('an accepted timeframe is persisted', async () => {
    const res = await req('POST', '/goats', {
      userId: 'tf_user',
      body: {
        name: 'TF',
        goal: 'g',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
        timeframe: '5m',
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.goat.timeframe).toBe('5m');
  });

  test('each offered cadence is accepted', async () => {
    for (const tf of ['1m', '5m', '15m', '1h', '4h']) {
      const res = await req('POST', '/goats', {
        userId: `tf_${tf}`,
        body: {
          name: `TF ${tf}`,
          goal: 'g',
          markets: ['EUR/USD'],
          skillIds: [],
          model: 'openai/gpt-4o-mini',
          timeframe: tf,
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.goat.timeframe).toBe(tf);
    }
  });

  test('an unknown timeframe on CREATE degrades rather than 500s', async () => {
    const res = await req('POST', '/goats', {
      userId: 'tf_bad',
      body: {
        name: 'TF bad',
        goal: 'g',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
        timeframe: '17m',
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.goat.timeframe).toBe('15m');
  });

  test('an unknown timeframe on PATCH is rejected explicitly', async () => {
    const goatId = await createGoat('tf_patch');

    const res = await req('PATCH', `/goats/${goatId}/schedule`, {
      userId: 'tf_patch',
      body: { timeframe: 'nonsense' },
    });

    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INVALID_TIMEFRAME');
  });

  test('a valid timeframe PATCH is applied', async () => {
    const goatId = await createGoat('tf_patch2');

    const res = await req('PATCH', `/goats/${goatId}/schedule`, {
      userId: 'tf_patch2',
      body: { timeframe: '4h' },
    });

    expect(res.status).toBe(200);
    expect(res.json.timeframe).toBe('4h');
  });

  test('an empty PATCH body is rejected rather than silently accepted', async () => {
    const goatId = await createGoat('tf_patch3');
    const res = await req('PATCH', `/goats/${goatId}/schedule`, {
      userId: 'tf_patch3',
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('daily recap endpoints', () => {
  test('recaps require a symbol', async () => {
    const res = await req('GET', '/markets/recaps', { userId: 'rollup_user' });
    expect(res.status).toBe(400);
  });

  test('rollup is idempotent and protected by auth', async () => {
    const unauth = await req('POST', '/markets/rollup');
    expect(unauth.status).toBe(401);

    const authed = await req('POST', '/markets/rollup', { userId: 'rollup_user' });
    expect(authed.status).toBe(200);
    expect(Array.isArray(authed.json.recaps)).toBe(true);
  });
});
