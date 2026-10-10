import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import { TEST_MASTER_KEY } from './helpers/encryptionEnv';
import os from 'os';
import path from 'path';

/**
 * IAM: CROSS-USER ISOLATION AND SYSTEM-TEMPLATE IMMUTABILITY
 * ===========================================================
 * The property that matters most in a multi-tenant backend: user A must not be
 * able to read, change or destroy user B's records — including when A knows B's
 * exact resource id.
 *
 * Identity comes from the verified `x-dev-user-id` in this harness. The
 * middleware under test is the same one that, in production, populates
 * `req.user` from a verified Firebase ID token. What is being verified here is
 * the OWNERSHIP layer downstream of it: that no handler trusts an id in the URL,
 * body or query string.
 */

let dataDir: string;
let server: Server;
let baseUrl: string;
let previousEnv: Record<string, string | undefined> = {};

const SCHEDULER_SECRET = 'iam-test-secret';

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DURABLE_SCHEDULER_SECRET: process.env.DURABLE_SCHEDULER_SECRET,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    DATA_DIR: process.env.DATA_DIR,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.NODE_ENV = 'test';
  // The vault fails closed without a master key; tests must supply one.
  process.env.CREDENTIAL_ENCRYPTION_KEY = TEST_MASTER_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key';
  process.env.MARKET_DATA_PROVIDER = 'paper';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.DURABLE_SCHEDULER_SECRET = SCHEDULER_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-iam-'));
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

async function createGoat(userId: string, name: string): Promise<string> {
  const created = await call('POST', '/goats', {
    userId,
    body: {
      name,
      goal: 'Track a confirmed level.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'openai/gpt-4o-mini',
    },
  });
  expect(created.status).toBe(200);
  return created.json.goat.id;
}

describe('cross-user GOAT isolation', () => {
  let aliceGoat = '';
  let bobGoat = '';

  beforeAll(async () => {
    aliceGoat = await createGoat('alice', 'Alice GOAT');
    bobGoat = await createGoat('bob', 'Bob GOAT');
  });

  test('the list returns only the caller own GOATs', async () => {
    const asAlice = await call('GET', '/goats', { userId: 'alice' });
    const asBob = await call('GET', '/goats', { userId: 'bob' });

    const aliceIds = asAlice.json.goats.map((g: any) => g.id);
    const bobIds = asBob.json.goats.map((g: any) => g.id);

    expect(aliceIds).toContain(aliceGoat);
    expect(aliceIds).not.toContain(bobGoat);

    expect(bobIds).toContain(bobGoat);
    expect(bobIds).not.toContain(aliceGoat);
  });

  test('reading another user GOAT by id is refused', async () => {
    const response = await call('GET', `/goats/${bobGoat}`, { userId: 'alice' });
    expect(response.status).toBe(404);
  });

  test('deleting another user GOAT by id is refused and the record survives', async () => {
    const response = await call('DELETE', `/goats/${bobGoat}`, { userId: 'alice' });
    expect(response.status).toBe(404);

    // Still there, still owned by Bob.
    const asBob = await call('GET', '/goats', { userId: 'bob' });
    expect(asBob.json.goats.map((g: any) => g.id)).toContain(bobGoat);
  });

  test('waking another user GOAT is refused', async () => {
    const response = await call('POST', `/goats/${bobGoat}/wake`, {
      userId: 'alice',
      body: { reason: 'unauthorised wake' },
    });
    expect(response.status).toBe(404);
  });

  test('changing another user GOAT status is refused', async () => {
    const response = await call('POST', `/goats/${bobGoat}/status`, {
      userId: 'alice',
      body: { action: 'PAUSE' },
    });
    expect(response.status).toBe(404);

    const asBob = await call('GET', `/goats/${bobGoat}`, { userId: 'bob' });
    expect(asBob.json.goat.status).toBe('WATCHING');
  });

  test('reading another user signals is refused', async () => {
    const response = await call('GET', `/goats/${bobGoat}/signals`, {
      userId: 'alice',
    });
    expect(response.status).toBe(404);
  });

  test('changing another user schedule is refused', async () => {
    const response = await call('PATCH', `/goats/${bobGoat}/schedule`, {
      userId: 'alice',
      body: { timeframe: '5m' },
    });
    expect(response.status).toBe(404);
  });

  test('chatting through another user GOAT is refused', async () => {
    const response = await call('POST', `/goats/${bobGoat}/chat`, {
      userId: 'alice',
      body: { question: 'What is my bias?' },
    });
    expect(response.status).toBe(404);
  });

  test('a user-supplied userId in the body cannot reassign ownership', async () => {
    const created = await call('POST', '/goats', {
      userId: 'alice',
      body: {
        name: 'Ownership probe',
        goal: 'Attempt to claim another owner.',
        markets: ['GBP/USD'],
        skillIds: [],
        model: 'openai/gpt-4o-mini',
        // Forged owner in the payload.
        userId: 'bob',
      },
    });

    expect(created.status).toBe(200);
    // Ownership comes from the verified token, never from the body.
    expect(created.json.goat.userId).toBe('alice');
  });
});

describe('cross-user skill isolation', () => {
  let aliceSkill = '';

  beforeAll(async () => {
    const created = await call('POST', '/skills', {
      userId: 'alice',
      body: {
        name: 'Alice private skill',
        description: 'Alice only.',
        methodology: 'Private.',
        constraints: 'REQUIRE_EVIDENCE_BEFORE_ACTIONABLE.',
        preferredTimeframes: ['15m'],
        requiredEvidence: 'Evidence.',
        invalidationRules: 'Invalidation.',
      },
    });
    expect(created.status).toBe(200);
    aliceSkill = created.json.skill.id;
  });

  test("the list shows only the caller's own and explicitly supported built-ins", async () => {
    const asAlice = await call('GET', '/skills', { userId: 'alice' });
    const asBob = await call('GET', '/skills', { userId: 'bob' });

    const aliceIds = asAlice.json.skills.map((s: any) => s.id);
    const bobIds = asBob.json.skills.map((s: any) => s.id);

    expect(aliceIds).toContain(aliceSkill);
    expect(bobIds).not.toContain(aliceSkill);
  });

  test("deleting another user's skill is refused and it survives", async () => {
    const response = await call('DELETE', `/skills/${aliceSkill}`, {
      userId: 'bob',
    });
    expect(response.status).toBe(404);

    const asAlice = await call('GET', '/skills', { userId: 'alice' });
    expect(asAlice.json.skills.map((s: any) => s.id)).toContain(aliceSkill);
  });

  test('a system skill cannot be deleted by a user', async () => {
    const response = await call('DELETE', '/skills/skill_price_action', {
      userId: 'alice',
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('DEFAULT_SKILL');
  });

  test('a GOAT cannot claim a skill belonging to another user', async () => {
    const response = await call('POST', '/goats', {
      userId: 'bob',
      body: {
        name: 'Borrowed skill',
        goal: 'Attempt to reference another user skill.',
        markets: ['USD/JPY'],
        skillIds: [aliceSkill],
        model: 'openai/gpt-4o-mini',
      },
    });

    // Rejected rather than accepted, so Bob cannot depend on Alice's record.
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('UNKNOWN_SKILL');
  });
});

describe('credentials and settings isolation', () => {
  test('a key saved by one user is not reported for another', async () => {
    // Shape-valid but not a working key; this only exercises storage scoping.
    const saved = await call('POST', '/settings/keys', {
      userId: 'carol',
      body: {
        openRouterKey: `sk-or-v1-${'a'.repeat(40)}`,
        provider: 'openrouter',
      },
    });
    expect(saved.status).toBe(200);

    const asCarol = await call('GET', '/settings/keys', { userId: 'carol' });
    const asDave = await call('GET', '/settings/keys', { userId: 'dave' });

    expect(asCarol.json.openRouterKeyConfigured).toBe(true);
    expect(asDave.json.openRouterKeyConfigured).toBe(false);
  });

  test('the key status endpoint never returns key material', async () => {
    const response = await call('GET', '/settings/keys', { userId: 'carol' });
    const body = JSON.stringify(response.json);

    expect(body).not.toMatch(/sk-or-v1-[A-Za-z0-9]/);
    expect(body).not.toMatch(/\d{5,20}:[A-Za-z0-9_-]{30,}/);
  });

  test('a Telegram chat id cannot be claimed by a second account', async () => {
    const first = await call('POST', '/settings/keys', {
      userId: 'erin',
      body: { telegramChatId: '900001' },
    });
    expect(first.status).toBe(200);

    const second = await call('POST', '/settings/keys', {
      userId: 'frank',
      body: { telegramChatId: '900001' },
    });
    expect(second.status).toBe(409);
  });
});

describe('system templates are immutable to users', () => {
  test('the GOAT template catalogue is public and carries no user data', async () => {
    const response = await call('GET', '/templates/goats');
    expect(response.status).toBe(200);
    expect(response.json.templates.length).toBeGreaterThanOrEqual(3);

    for (const template of response.json.templates) {
      expect(template.isTemplate).toBe(true);
      expect(template.userId).toBeUndefined();
      // Templates are examples, not performance claims, and never trade.
      expect(template.performsTrades).toBe(false);
    }
  });

  test('the skill template catalogue is public and marks itself non-executable', async () => {
    const response = await call('GET', '/templates/skills');
    expect(response.status).toBe(200);
    expect(response.json.templates.length).toBeGreaterThanOrEqual(4);

    for (const template of response.json.templates) {
      expect(template.isTemplate).toBe(true);
      expect(template.executable).toBe(false);
    }
  });

  test('no template claims a performance or profitability outcome', async () => {
    const goats = await call('GET', '/templates/goats');
    const skills = await call('GET', '/templates/skills');

    const text = JSON.stringify(goats.json) + JSON.stringify(skills.json).toLowerCase();
    for (const claim of [
      'guaranteed',
      'risk-free',
      'riskless',
      'win rate',
      'winrate',
      'profit',
      'returns',
      'accuracy of',
      'backtested',
    ]) {
      expect(text.includes(claim)).toBe(false);
    }
  });

  test('copying a template creates a NEW record owned by the caller', async () => {
    const copied = await call('POST', '/templates/goats/tmpl_session_sweep_fx/copy', {
      userId: 'alice',
    });

    expect(copied.status).toBe(201);
    expect(copied.json.goat.userId).toBe('alice');
    // A fresh id: copying must not collide with the template itself.
    expect(copied.json.goat.id).not.toBe('tmpl_session_sweep_fx');
    expect(copied.json.copiedFrom).toBe('tmpl_session_sweep_fx');

    // The template itself is unchanged and still lists as a template.
    const templates = await call('GET', '/templates/goats');
    const template = templates.json.templates.find(
      (t: any) => t.id === 'tmpl_session_sweep_fx',
    );
    expect(template.status).toBeUndefined();
  });

  test('a copy belongs only to the copying user', async () => {
    const copied = await call('POST', '/templates/goats/tmpl_gold_volatility/copy', {
      userId: 'alice',
    });
    expect(copied.status).toBe(201);
    const copyId = copied.json.goat.id;

    const asAlice = await call('GET', '/goats', { userId: 'alice' });
    const asBob = await call('GET', '/goats', { userId: 'bob' });

    expect(asAlice.json.goats.map((g: any) => g.id)).toContain(copyId);
    expect(asBob.json.goats.map((g: any) => g.id)).not.toContain(copyId);
  });

  test('copying a skill template yields an editable user-owned copy', async () => {
    const copied = await call('POST', '/templates/skills/skill_volatility_regime/copy', {
      userId: 'bob',
    });

    expect(copied.status).toBe(201);
    expect(copied.json.skill.userId).toBe('bob');
    expect(copied.json.skill.isDefault).toBe(false);
    expect(copied.json.skill.id).not.toBe('skill_volatility_regime');
  });

  test('copying an unknown template is a 404, not a silent no-op', async () => {
    const goat = await call('POST', '/templates/goats/tmpl_does_not_exist/copy', {
      userId: 'alice',
    });
    const skill = await call('POST', '/templates/skills/skill_nope/copy', {
      userId: 'alice',
    });

    expect(goat.status).toBe(404);
    expect(skill.status).toBe(404);
  });

  test('copying requires authentication', async () => {
    const response = await call('POST', '/templates/goats/tmpl_session_sweep_fx/copy');
    expect(response.status).toBe(401);
  });

  test('every template references only catalogue skills', async () => {
    const { SYSTEM_GOATS } = await import('../src/data/systemGoats');
    const { SYSTEM_SKILL_IDS } = await import('../src/data/systemSkills');

    for (const goat of SYSTEM_GOATS) {
      for (const skillId of goat.skillIds) {
        expect(SYSTEM_SKILL_IDS.has(skillId)).toBe(true);
      }
    }
  });

  test('no template or skill carries executable content', async () => {
    const { SYSTEM_SKILLS } = await import('../src/data/systemSkills');
    const { SYSTEM_GOATS } = await import('../src/data/systemGoats');

    const text = JSON.stringify({ SYSTEM_SKILLS, SYSTEM_GOATS }).toLowerCase();

    // A skill is prompt text. If any of these appear, something is trying to
    // become a plugin/eval path.
    for (const forbidden of ['javascript', 'eval(', 'require(', 'import(', '=>{']) {
      expect(text.includes(forbidden)).toBe(false);
    }
  });
});

describe('internal surfaces stay authenticated', () => {
  test('reconcile requires the shared secret', async () => {
    const wrong = await call('POST', '/internal/reconcile', {
      headers: { 'x-scheduler-secret': 'wrong' },
    });
    expect(wrong.status).toBe(401);
  });

  test('market-event rejects a forged event id', async () => {
    const candleOpenTimeMs = Date.now() - 60_000;

    const forged = await call('POST', '/internal/market-event', {
      headers: { 'x-scheduler-secret': SCHEDULER_SECRET },
      body: {
        // The id does not match the payload, so it must be refused outright.
        eventId: 'FX:CANDLE_FINALIZED:EUR/USD:1',
        eventIdVersion: 1,
        partition: 'FX',
        instrument: 'EUR/USD',
        candleOpenTimeMs,
        type: 'CANDLE_FINALIZED',
        schemaVersion: 1,
        finalized: true,
        context: {},
        createdAtMs: Date.now(),
      },
    });

    expect(forged.status).toBe(400);
    expect(forged.json.error.code).toBe('INVALID_EVENT');
  });

  test('the Telegram webhook requires its secret', async () => {
    // TELEGRAM_WEBHOOK_SECRET is unset in this suite, so the endpoint must
    // refuse rather than accept an unauthenticated update.
    const response = await call('POST', '/telegram/webhook', {
      body: { update_id: 1, message: { chat: { id: 1 }, text: '/processes' } },
    });

    expect(response.status).toBe(503);
  });
});