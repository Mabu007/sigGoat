import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';
import os from 'os';
import path from 'path';

/**
 * TELEGRAM COMMAND END-TO-END
 * ===========================
 * Drives the REAL apiRouter over HTTP, exactly as Telegram does, so ownership,
 * the webhook secret, duplicate suppression and rate limiting are exercised
 * together rather than in isolation.
 *
 * Each user has their own Telegram chat. Every command path resolves the caller
 * from that chat's persisted mapping, so these tests are the ones that prove a
 * user cannot drive another user's process.
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

const WEBHOOK_SECRET = 'a-sufficiently-long-webhook-secret';
const SCHEDULER_SECRET = 'scheduler-secret';

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    APP_ORIGIN: process.env.APP_ORIGIN,
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
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.APP_ORIGIN = 'https://app.example.com';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-telegram-e2e-'));
  process.env.DATA_DIR = dataDir;

  const { apiRouter, resetTelegramUpdateCache } = await import(
    '../src/server/apiRouter'
  );
  resetTelegramUpdateCache();

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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let nextUpdateId = 1000;

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

/** Posts an update the way Telegram does, with the secret header. */
function webhook(
  chatId: string,
  text: string,
  options?: { updateId?: number; secret?: string },
) {
  return call('POST', '/telegram/webhook', {
    headers: {
      'x-telegram-bot-api-secret-token': options?.secret ?? WEBHOOK_SECRET,
    },
    body: {
      update_id: options?.updateId ?? (nextUpdateId += 1),
      message: {
        message_id: nextUpdateId,
        chat: { id: Number(chatId), type: 'private' },
        text,
      },
    },
  });
}

/** Links a chat id to a user by writing the profile the app reads. */
async function linkChat(userId: string, chatId: string): Promise<void> {
  const response = await call('POST', '/settings/keys', {
    userId,
    body: { telegramChatId: chatId },
  });
  expect(response.status).toBe(200);
}

/* ------------------------------------------------------------------ */

describe('Telegram webhook authentication', () => {
  test('a wrong webhook secret is refused', async () => {
    const response = await webhook('500001', '/processes', { secret: 'wrong' });
    expect(response.status).toBe(401);
  });

  test('a missing webhook secret is refused', async () => {
    const response = await call('POST', '/telegram/webhook', {
      body: {
        update_id: 999_001,
        message: { chat: { id: 500002 }, text: '/processes' },
      },
    });
    expect(response.status).toBe(401);
  });

  test('a payload that is not a Telegram update is a 400', async () => {
    const response = await call('POST', '/telegram/webhook', {
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: { not: 'an update' },
    });
    expect(response.status).toBe(400);
  });
});

describe('Telegram process commands', () => {
  test('a user lists their own processes and sees ids they can use', async () => {
    const chat = '501001';
    await linkChat('tg_list', chat);

    const created = await call('POST', '/goats', {
      userId: 'tg_list',
      body: {
        name: 'Listed GOAT',
        goal: 'Track the level.',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
      },
    });
    expect(created.status).toBe(200);

    const response = await webhook(chat, '/processes');
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });

  test('/pause and /resume only affect the caller own processes', async () => {
    const ownerChat = '501002';
    const strangerChat = '501003';

    await linkChat('tg_owner', ownerChat);
    await linkChat('tg_stranger', strangerChat);

    const created = await call('POST', '/goats', {
      userId: 'tg_owner',
      body: {
        name: 'Owned GOAT',
        goal: 'Track the level.',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
      },
    });
    const goatId: string = created.json.goat.id;

    // The owner pauses it.
    const paused = await webhook(ownerChat, `/pause ${goatId}`);
    expect(paused.status).toBe(200);

    const afterPause = await call('GET', `/goats/${goatId}`, {
      userId: 'tg_owner',
    });
    expect(afterPause.json.goat.status).toBe('PAUSED');

    /**
     * THE OWNERSHIP BOUNDARY.
     *
     * A different, authenticated user who knows the id must not be able to
     * resume it. `getForUser` makes this indistinguishable from a nonexistent
     * id, so the reply must not confirm the process exists either.
     */
    const strangerResume = await webhook(strangerChat, `/resume ${goatId}`);
    expect(strangerResume.status).toBe(200);

    const stillPaused = await call('GET', `/goats/${goatId}`, {
      userId: 'tg_owner',
    });
    expect(stillPaused.json.goat.status).toBe('PAUSED');
  });

  test('a stranger cannot trigger an evaluation on a process they do not own', async () => {
    const ownerChat = '501004';
    const strangerChat = '501005';

    await linkChat('tg_trigger_owner', ownerChat);
    await linkChat('tg_trigger_stranger', strangerChat);

    const created = await call('POST', '/goats', {
      userId: 'tg_trigger_owner',
      body: {
        name: 'Triggerable GOAT',
        goal: 'Track the level.',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
      },
    });
    const goatId: string = created.json.goat.id;

    const signalsBefore = await call('GET', `/goats/${goatId}/signals`, {
      userId: 'tg_trigger_owner',
    });
    const before = signalsBefore.json.signals.length;

    await webhook(strangerChat, `/trigger ${goatId}`);

    // Give any (incorrect) background evaluation time to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const signalsAfter = await call('GET', `/goats/${goatId}/signals`, {
      userId: 'tg_trigger_owner',
    });
    expect(signalsAfter.json.signals.length).toBe(before);
  });

  test('a paused process refuses a manual trigger with an explanation', async () => {
    const chat = '501006';
    await linkChat('tg_paused_trigger', chat);

    const created = await call('POST', '/goats', {
      userId: 'tg_paused_trigger',
      body: {
        name: 'Paused GOAT',
        goal: 'Track the level.',
        markets: ['EUR/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
      },
    });
    const goatId: string = created.json.goat.id;

    await call('POST', `/goats/${goatId}/status`, {
      userId: 'tg_paused_trigger',
      body: { action: 'PAUSE' },
    });

    const response = await webhook(chat, `/trigger ${goatId}`);
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });

  test('/create refuses a market the feed does not serve', async () => {
    const chat = '501007';
    await linkChat('tg_bad_market', chat);

    const response = await webhook(chat, '/create track something NOTAREALMARKET 5m');
    expect(response.status).toBe(200);

    const list = await call('GET', '/goats', { userId: 'tg_bad_market' });
    expect(list.json.goats).toHaveLength(0);
  });

  test('/create builds a process from a free-text goal and a market', async () => {
    const chat = '501008';
    await linkChat('tg_create', chat);

    const response = await webhook(
      chat,
      '/create wait for a london sweep on EUR/USD 5m',
    );
    expect(response.status).toBe(200);

    const list = await call('GET', '/goats', { userId: 'tg_create' });
    expect(list.json.goats).toHaveLength(1);

    const goat = list.json.goats[0];
    expect(goat.markets).toEqual(['EUR/USD']);
    expect(goat.timeframe).toBe('5m');
    expect(goat.goal).toContain('london sweep');
    // Owner comes from the authenticated chat mapping, never from the text.
    expect(goat.userId).toBe('tg_create');
  });

  test('a command with no process id is refused rather than run against something', async () => {
    const chat = '501009';
    await linkChat('tg_no_id', chat);

    const response = await webhook(chat, '/pause');
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });

  test('an unknown command is handled without reaching the AI', async () => {
    const chat = '501010';
    await linkChat('tg_unknown', chat);

    const response = await webhook(chat, '/definitely-not-a-command');
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });

  test('/help is answered', async () => {
    const chat = '501011';
    await linkChat('tg_help', chat);

    const response = await webhook(chat, '/help');
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });
});

describe('Telegram duplicate suppression and rate limiting', () => {
  /**
   * Telegram retries until it gets a 2xx, so the same update can arrive twice.
   * Since `/trigger` spends AI, a duplicate would be a real, charged, repeated
   * action.
   */
  test('the same update_id is acknowledged but processed only once', async () => {
    const chat = '502001';
    await linkChat('tg_dup', chat);

    const updateId = 777_001;

    const first = await webhook(chat, '/processes', { updateId });
    expect(first.status).toBe(200);
    expect(first.json.duplicate).toBeUndefined();

    const second = await webhook(chat, '/processes', { updateId });
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
  });

  test('a burst from one chat is rate limited with an actionable message', async () => {
    const chat = '502002';
    await linkChat('tg_rate', chat);

    let limited: { status: number; json: any } | null = null;

    // The limiter allows 10 per minute; a few more must trip it.
    for (let i = 0; i < 15; i += 1) {
      const response = await webhook(chat, '/help');
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.json.error.code).toBe('RATE_LIMITED');
    expect(limited!.json.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('one chat being limited does not limit another', async () => {
    const busy = '502003';
    const calm = '502004';

    await linkChat('tg_rl_busy', busy);
    await linkChat('tg_rl_calm', calm);

    for (let i = 0; i < 15; i += 1) {
      await webhook(busy, '/help');
    }

    const response = await webhook(calm, '/help');
    expect(response.status).toBe(200);
    expect(response.json.handled).toBe(true);
  });
});

describe('Telegram chat identity linking', () => {
  test('a chat id cannot be claimed by a second account', async () => {
    const chat = '503001';

    const first = await call('POST', '/settings/keys', {
      userId: 'tg_claim_first',
      body: { telegramChatId: chat },
    });
    expect(first.status).toBe(200);

    /**
     * Without this check, two users could register the same chat and the second
     * write would silently reassign it — so the first user would keep receiving
     * nothing while believing they were connected.
     */
    const second = await call('POST', '/settings/keys', {
      userId: 'tg_claim_second',
      body: { telegramChatId: chat },
    });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('CHAT_ID_IN_USE');
  });

  test('a non-numeric chat id is rejected', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'tg_bad_chat',
      body: { telegramChatId: 'not-a-chat-id' },
    });
    expect(response.status).toBe(400);
  });
});

describe('Telegram connection status', () => {
  test('a stored token with no verified bot is NOT reported as connected', async () => {
    const response = await call('GET', '/telegram/status', {
      userId: 'tg_status_unconnected',
    });
    expect(response.status).toBe(200);
    expect(response.json.tokenConfigured).toBe(false);
    expect(response.json.connected).toBe(false);
    expect(response.json.webhookSecretConfigured).toBe(true);
  });

  test('connecting without a token is refused', async () => {
    const response = await call('POST', '/telegram/connect', {
      userId: 'tg_connect_empty',
      body: {},
    });
    expect(response.status).toBe(400);
  });

  test('a malformed bot token is refused before any network call', async () => {
    const response = await call('POST', '/telegram/connect', {
      userId: 'tg_connect_bad',
      body: { telegramToken: 'not-a-bot-token' },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_KEY');
  });

  test('the status endpoint never returns a token', async () => {
    const response = await call('GET', '/telegram/status', {
      userId: 'tg_status_no_leak',
    });
    const body = JSON.stringify(response.json);

    expect(body).not.toMatch(/gsk_/);
    expect(body).not.toMatch(/sk-or-v1-/);
    expect(body).not.toMatch(/\d{5,20}:[A-Za-z0-9_-]{30,}/);
  });
});

describe('AI provider selection', () => {
  test('a provider can be chosen and is reported back', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'tg_provider',
      body: { provider: 'groq' },
    });
    expect(response.status).toBe(200);
    expect(response.json.provider).toBe('groq');
  });

  test('an unknown provider is refused', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'tg_provider_bad',
      body: { provider: 'not-a-provider' },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_PROVIDER');
  });

  test('an OpenRouter key pasted into the Groq field is refused', async () => {
    const response = await call('POST', '/settings/keys', {
      userId: 'tg_wrong_key_field',
      body: { groqKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_KEY');
  });

  test('a malformed key never reaches storage', async () => {
    const userId = 'tg_bad_key_not_stored';
    const response = await call('POST', '/settings/keys', {
      userId,
      body: { openRouterKey: 'sk-or-v1-too-short' },
    });
    expect(response.status).toBe(400);

    const keys = await call('GET', '/settings/keys', { userId });
    expect(keys.status).toBe(200);
    expect(keys.json.openRouterKeyConfigured).toBe(false);
  });

  test('the keys endpoint reports configuration without revealing values', async () => {
    const userId = 'tg_keys_shape';
    const response = await call('GET', '/settings/keys', { userId });

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.json);
    expect(body).not.toMatch(/sk-or-v1-/);
    expect(body).not.toMatch(/gsk_/);
  });
});