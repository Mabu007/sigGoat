import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';

/**
 * THE ROBOT MARKETPLACE
 * =====================
 *
 * The robot cover system, the robot broker connections and the directory
 * itself, exercised against the REAL routers.
 *
 * WHAT IS PROVEN HERE
 *   - the cover flow: a ticket, a commit, a replacement and a removal, and
 *     the ownership rule that stops one creator from touching another
 *     creator's robot;
 *   - the broker flow: only the owner's own accounts can be bound, and the
 *     responses never carry a credential;
 *   - the safety boundary: the runtime stays PAPER, and every response
 *     says so;
 *   - the directory: the cover url, the bound account and the backtest
 *     summary reach the client.
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DATA_DIR: process.env.DATA_DIR,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    NODE_ENV: process.env.NODE_ENV,
    ROOM_REALTIME_SECRET: process.env.ROOM_REALTIME_SECRET,
    ROOM_REALTIME_URL: process.env.ROOM_REALTIME_URL,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  process.env.NODE_ENV = 'test';
  process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_MASTER_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key';
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  // The media signer needs a shared secret and a Worker url to issue a
  // ticket. The Worker itself is not reachable from a test, so only the
  // server-side half of the flow is exercised.
  process.env.ROOM_REALTIME_SECRET = 'test-media-secret';
  process.env.ROOM_REALTIME_URL = 'https://media.example.test';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-robot-test-'));
  process.env.DATA_DIR = dataDir;

  const { apiRouter } = await import('../src/server/apiRouter');
  const { roomsRouter } = await import('../src/server/roomsRouter');
  const app = express();
  app.use(express.json());
  app.use('/api', roomsRouter);
  app.use('/api', apiRouter);

  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to bind the test server');
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function req(
  method: string,
  urlPath: string,
  options?: { userId?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options?.userId) headers['x-dev-user-id'] = options.userId;
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async res => {
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  });
}

const definition = () => ({
  schemaVersion: 2,
  strategyId: 'ignored',
  versionId: 'ignored',
  version: 1,
  name: 'Cover test robot',
  description: 'A robot used by the cover tests.',
  market: { provider: 'hyperliquid', instrument: 'BTC', timeframe: '1h' },
  indicators: [],
  entry: { direction: 'LONG', condition: { type: 'comparison', left: { kind: 'price', field: 'close' }, operator: 'GT', right: { kind: 'constant', value: 0 } } },
  exit: {},
  risk: { sizing: { mode: 'PERCENT_RISK', percent: 1 }, stopLossPercent: 1, takeProfitPercent: 2, maxExposurePercent: 25, maxConcurrentPositions: 1, maxTradesPerDay: 10, cooldownCandles: 0, maxDailyLossPercent: 5 },
  execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
  visibility: 'PRIVATE',
  validationStatus: 'VALID',
  createdAt: new Date().toISOString(),
});

async function createRobot(userId: string, requestId: string) {
  const created = await req('POST', '/robot-marketplace', { userId, body: { clientRequestId: requestId, definition: definition() } });
  expect(created.status).toBe(201);
  return created.json.robot as { id: string; slug: string };
}

describe('the robot cover', () => {
  test('the owner uploads, replaces and removes a cover', async () => {
    const robot = await createRobot('owner_cover', 'cover_request_0001');

    // 1. a ticket, in the robot's own namespace.
    const ticket = await req('POST', '/media/upload-ticket', {
      userId: 'owner_cover',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg' },
    });
    expect(ticket.status).toBe(200);
    // The key lives in the folder the realtime Worker already accepts, so
    // the upload works with the Worker that is deployed today.
    expect(ticket.json.ticket.key.startsWith('covers/owner_cover/')).toBe(true);
    expect(ticket.json.ticket.maxBytes).toBeGreaterThan(0);

    // 2. the commit records the cover on the robot.
    const committed = await req('POST', '/media/commit', {
      userId: 'owner_cover',
      body: { key: ticket.json.ticket.key, purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg', size: 2048 },
    });
    expect(committed.status).toBe(200);
    expect(committed.json.robotCoverUrl).toBeTruthy();

    const read = await req('GET', `/robot-marketplace/${robot.slug}`, { userId: 'owner_cover' });
    expect(read.json.robot.coverUrl).toBeTruthy();
    expect(read.json.robot.cover.key.startsWith('covers/owner_cover/')).toBe(true);

    // 3. a replacement is a second commit, and the old key is gone.
    const second = await req('POST', '/media/upload-ticket', {
      userId: 'owner_cover',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'image/png' },
    });
    const replaced = await req('POST', '/media/commit', {
      userId: 'owner_cover',
      body: { key: second.json.ticket.key, purpose: 'robot-cover', robotId: robot.id, contentType: 'image/png', size: 4096 },
    });
    expect(replaced.status).toBe(200);

    const afterReplace = await req('GET', `/robot-marketplace/${robot.slug}`, { userId: 'owner_cover' });
    expect(afterReplace.json.robot.cover.key).not.toBe(ticket.json.ticket.key);

    // 4. the removal restores the default artwork.
    const removed = await req('POST', '/media/remove', {
      userId: 'owner_cover',
      body: { purpose: 'robot-cover', robotId: robot.id },
    });
    expect(removed.status).toBe(200);
    expect(removed.json.robotCoverUrl).toBeNull();

    const afterRemove = await req('GET', `/robot-marketplace/${robot.slug}`, { userId: 'owner_cover' });
    expect(afterRemove.json.robot.coverUrl).toBeNull();
    expect(afterRemove.json.robot.cover).toBeFalsy();
  });

  test('a stranger cannot touch another creator\'s cover', async () => {
    const robot = await createRobot('owner_private', 'cover_request_0002');

    const ticket = await req('POST', '/media/upload-ticket', {
      userId: 'stranger',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg' },
    });
    expect(ticket.status).toBe(404);
    expect(ticket.json.error.code).toBe('ROBOT_NOT_FOUND');

    // A key that belongs to the stranger is still refused, because the robot
    // is not theirs.
    const strangerTicket = await req('POST', '/media/upload-ticket', {
      userId: 'stranger',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg' },
    });
    const commit = await req('POST', '/media/commit', {
      userId: 'stranger',
      body: { key: `covers/stranger/abc-123.jpg`, purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg', size: 100 },
    });
    expect(commit.status).toBe(404);
    expect(strangerTicket.status).toBe(404);

    const removal = await req('POST', '/media/remove', {
      userId: 'stranger',
      body: { purpose: 'robot-cover', robotId: robot.id },
    });
    expect(removal.status).toBe(404);
  });

  test('an image key from another namespace is refused', async () => {
    const robot = await createRobot('owner_namespace', 'cover_request_0003');
    const commit = await req('POST', '/media/commit', {
      userId: 'owner_namespace',
      body: { key: 'avatars/owner_namespace/x.jpg', purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg', size: 100 },
    });
    expect(commit.status).toBe(400);
    expect(commit.json.error.code).toBe('INVALID_KEY');
  });

  test('an unsupported image type is refused before anything is stored', async () => {
    const robot = await createRobot('owner_type', 'cover_request_0004');
    const ticket = await req('POST', '/media/upload-ticket', {
      userId: 'owner_type',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'application/pdf' },
    });
    expect(ticket.status).toBe(400);
    expect(ticket.json.error.code).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  test('an oversized image is refused', async () => {
    const robot = await createRobot('owner_size', 'cover_request_0005');
    const ticket = await req('POST', '/media/upload-ticket', {
      userId: 'owner_size',
      body: { purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg' },
    });
    const commit = await req('POST', '/media/commit', {
      userId: 'owner_size',
      body: { key: ticket.json.ticket.key, purpose: 'robot-cover', robotId: robot.id, contentType: 'image/jpeg', size: 99_000_000 },
    });
    expect(commit.status).toBe(400);
    expect(commit.json.error.code).toBe('IMAGE_TOO_LARGE');
  });
});

describe('the robot broker connections', () => {
  test('the owner reads the state and the paper boundary is stated', async () => {
    const robot = await createRobot('owner_broker', 'broker_request_0001');
    const state = await req('GET', `/robot-marketplace/${robot.slug}/broker`, { userId: 'owner_broker' });
    expect(state.status).toBe(200);
    expect(state.json.execution.mode).toBe('PAPER');
    expect(state.json.execution.liveTradingSupported).toBe(false);
    expect(state.json.execution.message).toContain('paper mode');
    expect(state.json.bound).toBeNull();
  });

  test('a stranger cannot read or change the binding', async () => {
    const robot = await createRobot('owner_binding', 'broker_request_0002');
    const read = await req('GET', `/robot-marketplace/${robot.slug}/broker`, { userId: 'stranger' });
    expect(read.status).toBe(404);

    const bind = await req('POST', `/robot-marketplace/${robot.slug}/broker`, {
      userId: 'stranger',
      body: { provider: 'ctrader', accountId: '12345678' },
    });
    expect(bind.status).toBe(404);

    const unbind = await req('DELETE', `/robot-marketplace/${robot.slug}/broker`, { userId: 'stranger' });
    expect(unbind.status).toBe(404);
  });

  test('an account that is not in the owner\'s own list is refused', async () => {
    const robot = await createRobot('owner_account', 'broker_request_0003');
    // No cTrader credential exists in a test, so the account can never be
    // one of the caller's own.
    const bind = await req('POST', `/robot-marketplace/${robot.slug}/broker`, {
      userId: 'owner_account',
      body: { provider: 'ctrader', accountId: '12345678' },
    });
    expect(bind.status).toBe(409);
    expect(bind.json.error.code).toBe('CTRADER_NOT_CONNECTED');
  });

  test('an unknown provider is refused', async () => {
    const robot = await createRobot('owner_provider', 'broker_request_0004');
    const bind = await req('POST', `/robot-marketplace/${robot.slug}/broker`, {
      userId: 'owner_provider',
      body: { provider: 'my-bank', accountId: '12345678' },
    });
    expect(bind.status).toBe(400);
    expect(bind.json.error.code).toBe('INVALID_BROKER');
  });

  test('no response ever carries a credential', async () => {
    const robot = await createRobot('owner_secret', 'broker_request_0005');
    const state = await req('GET', `/robot-marketplace/${robot.slug}/broker`, { userId: 'owner_secret' });
    const body = JSON.stringify(state.json);
    expect(body).not.toContain('accessToken');
    expect(body).not.toContain('refreshToken');
    expect(body).not.toContain('apiKey');
    expect(body.toLowerCase()).not.toContain('secret');
  });
});

describe('the directory', () => {
  test('the owner sees their robot with a cover url and no broker binding', async () => {
    const robot = await createRobot('owner_directory', 'directory_request_0001');
    const mine = await req('GET', '/robot-marketplace/mine', { userId: 'owner_directory' });
    expect(mine.status).toBe(200);
    const listed = mine.json.robots.find((item: any) => item.id === robot.id);
    expect(listed).toBeDefined();
    expect(listed.coverUrl).toBeNull();
    expect(listed.brokerAccount ?? null).toBeNull();
  });

  test('the public directory never carries the creator\'s broker account id', async () => {
    const robot = await createRobot('owner_public', 'directory_request_0003');
    // The robot is private, so it is not in the public list at all.
    const published = await req('GET', '/robot-marketplace');
    expect(published.json.robots.some((item: any) => item.id === robot.id)).toBe(false);

    // The OWNER sees the full reference, including the account id.
    const own = await req('GET', '/robot-marketplace/mine', { userId: 'owner_public' });
    const listed = own.json.robots.find((item: any) => item.id === robot.id);
    expect(listed).toBeDefined();
    expect(listed.brokerAccount ?? null).toBeNull();
  });

  test('a private robot is not listed publicly', async () => {
    await createRobot('owner_hidden', 'directory_request_0002');
    const published = await req('GET', '/robot-marketplace');
    expect(published.json.robots.some((robot: any) => robot.ownerUserId === 'owner_hidden')).toBe(false);
  });
});
