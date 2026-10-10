import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';
import os from 'os';
import path from 'path';

/**
 * MARKET EVENT ROUTING, AUTHORIZATION AND GOAT LIFECYCLE
 * ======================================================
 * Integration-level tests against the REAL apiRouter, covering the properties
 * that only appear once routing, persistence and the registry are wired
 * together:
 *
 *   - the internal event endpoint is secret-gated and validates every payload
 *   - a duplicate event does not wake a GOAT twice
 *   - a STOPPED GOAT ignores events, which is different from a dormant one
 *   - an event for an instrument a GOAT does not watch costs no model call
 *   - an unauthorised user cannot read or drive another user's GOAT
 *   - subscriptions rebuild from durable records, so a cold start wakes nobody
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};
let router: typeof import('../src/server/apiRouter');

const SCHEDULER_SECRET = 'lifecycle-secret';

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
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
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.DURABLE_SCHEDULER_SECRET = SCHEDULER_SECRET;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-lifecycle-'));
  process.env.DATA_DIR = dataDir;

  router = await import('../src/server/apiRouter');

  const app = express();
  app.use(express.json());
  app.use('/api', router.apiRouter);

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
  options?: { userId?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options?.headers ?? {}),
  };
  if (options?.userId) headers['x-dev-user-id'] = options.userId;

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return { status: response.status, json: await response.json().catch(() => null) };
}

function internal(body: unknown, secret = SCHEDULER_SECRET) {
  return call('POST', '/internal/market-event', {
    body,
    headers: { 'x-scheduler-secret': secret },
  });
}

async function createGoat(userId: string, name: string, markets: string[]): Promise<string> {
  const created = await call('POST', '/goats', {
    userId,
    body: {
      name,
      goal: 'Track a confirmed level.',
      markets,
      skillIds: [],
      model: 'anthropic/claude-3.5-sonnet',
      schedule: { mode: 'TRACKERS' },
      timeframe: '15m',
    },
  });

  expect(created.status).toBe(200);
  return created.json.goat.id as string;
}

describe('internal market event endpoint', () => {
  test('is rejected without the scheduler secret', async () => {
    const response = await call('POST', '/internal/market-event', {
      body: {},
    });

    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe('UNAUTHORISED');
  });

  test('is rejected with the WRONG scheduler secret', async () => {
    const response = await internal({}, 'not-the-secret');
    expect(response.status).toBe(401);
  });

  test('rejects a malformed event rather than partially applying it', async () => {
    const response = await internal({
      eventId: 'FX:CANDLE_FINALIZED:EUR/USD:1',
      eventIdVersion: 1,
      partition: 'FX',
      instrument: 'EUR/USD',
      candleOpenTimeMs: Date.now(),
      type: 'CANDLE_FINALIZED',
      schemaVersion: 1,
      finalized: true,
      context: {},
      createdAtMs: Date.now(),
      // eventId does not match the recomputed value.
    });

    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_EVENT');
  });

  test('accepts a well-formed event', async () => {
    const goatId = await createGoat('user_events', 'Events GOAT', ['EUR/USD']);

    await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    const candleOpenTimeMs = Date.now() - 120_000;
    const eventId = `FX:CANDLE_FINALIZED:EUR/USD:${candleOpenTimeMs}`;

    const response = await internal({
      eventId,
      eventIdVersion: 1,
      partition: 'FX',
      instrument: 'EUR/USD',
      candleOpenTimeMs,
      type: 'CANDLE_FINALIZED',
      schemaVersion: 1,
      finalized: true,
      reference: `EUR/USD#${candleOpenTimeMs}`,
      context: { dataQuality: 'OK' },
      createdAtMs: Date.now(),
    });

    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
    expect(response.json.eventId).toBe(eventId);
    // The GOAT exists and is subscribed; whether it wakes depends on its
    // trackers, which is reported separately from "handled".
    expect(response.json.subscribersConsidered).toBeGreaterThanOrEqual(1);
    void goatId;
  });

  test('the same event delivered twice is treated as a duplicate', async () => {
    const goatId = await createGoat('user_dup', 'Dup GOAT', ['EUR/USD']);

    await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    const candleOpenTimeMs = Date.now() - 300_000;
    const payload = {
      eventId: `FX:CANDLE_FINALIZED:EUR/USD:${candleOpenTimeMs}`,
      eventIdVersion: 1,
      partition: 'FX',
      instrument: 'EUR/USD',
      candleOpenTimeMs,
      type: 'CANDLE_FINALIZED',
      schemaVersion: 1,
      finalized: true,
      reference: `EUR/USD#${candleOpenTimeMs}`,
      context: {},
      createdAtMs: Date.now(),
    };

    const first = await internal(payload);
    const second = await internal(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // The second delivery is suppressed wholesale: no GOAT is woken again, so
    // no duplicate signal and no duplicate Telegram message can result.
    expect(second.json.ignoredAsDuplicate).toBe(1);
    expect(second.json.wokeGoats).toBe(0);
    expect(second.json.subscribersConsidered).toBe(0);
    void goatId;
  });
});

describe('GOAT lifecycle and event routing', () => {
  test('a STOPPED GOAT does not run its workflow on an event', async () => {
    const goatId = await createGoat('user_stopped', 'Stopped GOAT', ['EUR/USD']);

    await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    // Stop it.
    const stopped = await call('POST', `/goats/${goatId}/status`, {
      userId: 'user_stopped',
      body: { action: 'PAUSE' },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.json.status).toBe('PAUSED');

    /**
     * Baseline: creating a GOAT runs one initial analysis, which produces a
     * DEMO NO_TRADE signal. That signal is expected and is NOT the event's
     * doing, so the assertion below is a DELTA — what matters is that the event
     * added nothing.
     */
    const before = await call('GET', `/goats/${goatId}/signals`, {
      userId: 'user_stopped',
    });
    expect(before.status).toBe(200);
    const signalCountBefore = before.json.signals.length;

    const candleOpenTimeMs = Date.now() - 240_000;
    const response = await internal({
      eventId: `FX:CANDLE_FINALIZED:EUR/USD:${candleOpenTimeMs}`,
      eventIdVersion: 1,
      partition: 'FX',
      instrument: 'EUR/USD',
      candleOpenTimeMs,
      type: 'CANDLE_FINALIZED',
      schemaVersion: 1,
      finalized: true,
      context: {},
      createdAtMs: Date.now(),
    });

    expect(response.status).toBe(200);

    /**
     * The invariant: a stopped GOAT is never woken.
     *
     * Counters are NOT asserted here because they depend on other GOATs in this
     * shared-process test file, and an assertion about a global count would be
     * asserting the test file's ordering rather than the behaviour. What is
     * asserted is specific to THIS GOAT: it produced no wake, so no reasoning
     * ran and no signal could exist for it.
     *
     * Note pausing also removes the GOAT from the routing table
     * (`subscribeToMarkets`), so it is normally not even considered.
     */
    expect(response.json.wokeGoats).toBe(0);

    const signals = await call('GET', `/goats/${goatId}/signals`, {
      userId: 'user_stopped',
    });
    expect(signals.status).toBe(200);
    expect(signals.json.signals).toHaveLength(signalCountBefore);

    const state = await call('GET', `/goats/${goatId}`, {
      userId: 'user_stopped',
    });
    expect(state.status).toBe(200);
    expect(state.json.goat.status).toBe('PAUSED');
    expect(state.json.runtimeState.isEvaluating).toBe(false);
  });

  test('an event for an instrument a GOAT does not watch is filtered out', async () => {
    // This GOAT only watches GBP/USD.
    await createGoat('user_fx', 'FX only GOAT', ['GBP/USD']);

    await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    const candleOpenTimeMs = Date.now() - 360_000;
    const response = await internal({
      // The id must be derived from the SAME partition as the payload; a
      // mismatch is exactly what the id-integrity check exists to catch.
      eventId: `METALS:CANDLE_FINALIZED:XAU/USD:${candleOpenTimeMs}`,
      eventIdVersion: 1,
      partition: 'METALS',
      instrument: 'XAU/USD',
      candleOpenTimeMs,
      type: 'CANDLE_FINALIZED',
      schemaVersion: 1,
      finalized: true,
      context: {},
      createdAtMs: Date.now(),
    });

    expect(response.status).toBe(200);
    // Nobody is subscribed to XAU/USD, so the fan-out is empty: unrelated
    // market activity costs zero model calls.
    expect(response.json.subscribersConsidered).toBe(0);
    expect(response.json.wokeGoats).toBe(0);
  });

  test('a market-sync rebuilds subscriptions from durable records', async () => {
    await createGoat('user_sync', 'Sync GOAT', ['EUR/USD']);

    const response = await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    expect(response.status).toBe(200);
    expect(response.json.restored).toBeGreaterThan(0);
    expect(response.json.byPartition.FX).toBeGreaterThan(0);
  });

  test('market-sync does NOT subscribe a paused GOAT', async () => {
    const goatId = await createGoat('user_paused_sync', 'Paused GOAT', ['EUR/USD']);
    await call('POST', `/goats/${goatId}/status`, {
      userId: 'user_paused_sync',
      body: { action: 'PAUSE' },
    });

    const before = router.marketIngestion
      .listSubscriptions()
      .filter((s) => s.subscriberId === goatId).length;

    await call('POST', '/internal/market-sync', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {},
    });

    const after = router.marketIngestion
      .listSubscriptions()
      .filter((s) => s.subscriberId === goatId).length;

    // A stopped GOAT must not be in the routing table: it would keep being
    // woken and would then have to ignore every event.
    expect(before).toBe(after);
    expect(after).toBe(0);
  });
});

describe('ingestion observability', () => {
  test('the ingestion endpoint reports freshness without secrets', async () => {
    const response = await call('GET', '/markets/ingestion');

    expect(response.status).toBe(200);
    expect(response.json).toHaveProperty('stats');
    expect(response.json).toHaveProperty('subscriptions');
    expect(response.json).toHaveProperty('retention');

    const serialised = JSON.stringify(response.json);
    expect(serialised).not.toContain('OPENROUTER_API_KEY');
    expect(serialised).not.toContain('apiKey');
    expect(serialised).not.toContain('Bearer');
  });

  test('the settings endpoint reports the durable runtime honestly', async () => {
    const response = await call('GET', '/settings/status');

    expect(response.status).toBe(200);
    // The durable runtime is not configured in tests, and that must be REPORTED
    // rather than omitted, so nobody mistakes it for a working deployment.
    expect(response.json.durableMarketData.configured).toBe(false);
    expect(response.json.filesystemPersistence).toBeDefined();
    expect(response.json.marketIngestion).toBeDefined();
    expect(response.json.notifications).toBeDefined();
  });

  test('the session endpoint reports the UTC offset in force right now', async () => {
    const summer = await call('GET', '/markets/session?symbol=EUR/USD');
    expect(summer.status).toBe(200);
    expect(summer.json.timezone).toBe('America/New_York');
    expect(summer.json.class).toBe('FX');
    expect(typeof summer.json.utcOffsetMinutes).toBe('number');
    expect(summer.json.resolved).not.toBeNull();
  });

  test('the session endpoint rejects an unusable instrument', async () => {
    const response = await call('GET', '/markets/session?symbol=../../etc/passwd');
    expect(response.status).toBe(400);
  });
});

describe('ownership and authorization', () => {
  test('one user cannot read another user\'s GOAT', async () => {
    const goatId = await createGoat('user_owner', 'Owned GOAT', ['EUR/USD']);

    const asOwner = await call('GET', `/goats/${goatId}`, { userId: 'user_owner' });
    expect(asOwner.status).toBe(200);

    // Cross-user access is 404, not 403: a 403 would confirm the GOAT exists.
    const asStranger = await call('GET', `/goats/${goatId}`, { userId: 'user_intruder' });
    expect(asStranger.status).toBe(404);
  });

  test('one user cannot wake another user\'s GOAT', async () => {
    const goatId = await createGoat('user_owner2', 'Owned GOAT 2', ['EUR/USD']);

    const response = await call('POST', `/goats/${goatId}/wake`, {
      userId: 'user_intruder',
      body: {},
    });

    expect(response.status).toBe(404);
  });

  test('one user cannot stop another user\'s GOAT', async () => {
    const goatId = await createGoat('user_owner3', 'Owned GOAT 3', ['EUR/USD']);

    const response = await call('POST', `/goats/${goatId}/status`, {
      userId: 'user_intruder',
      body: { action: 'PAUSE' },
    });

    expect(response.status).toBe(404);

    // Confirm the GOAT is untouched.
    const asOwner = await call('GET', `/goats/${goatId}`, { userId: 'user_owner3' });
    expect(asOwner.json.goat.status).not.toBe('PAUSED');
  });

  test('credentials status never returns the secret itself', async () => {
    const response = await call('GET', '/settings/keys', { userId: 'user_owner' });

    expect(response.status).toBe(200);
    const serialised = JSON.stringify(response.json);
    expect(response.json.openRouterKeyConfigured).toBeDefined();
    expect(serialised).not.toMatch(/sk-or-v1-[A-Za-z0-9]/);
  });
});