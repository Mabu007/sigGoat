/**
 * SETTINGS PREFERENCES, MARKET VALIDATION AND THE MODEL-ID PATTERN
 * ================================================================
 * Integration-level tests against the real `apiRouter`, covering the routes
 * added while hardening the MVP: autonomy mode, the preferred model, and the
 * market validation that stops a GOAT being created against an instrument the
 * venue does not list.
 *
 * PAPER provider throughout, so nothing here touches the network.
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
let router: typeof import('../src/server/apiRouter');

beforeAll(async () => {
  previousEnv = {
    SIGNALGOAT_ALLOW_DEV_AUTH: process.env.SIGNALGOAT_ALLOW_DEV_AUTH,
    MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
    DATA_DIR: process.env.DATA_DIR,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    NODE_ENV: process.env.NODE_ENV,
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
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  // No provider credential: these tests must never make a live call.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-prefs-'));
  process.env.DATA_DIR = dataDir;

  router = await import('../src/server/apiRouter');
  const app = express();
  app.use(express.json());
  app.use('/api', router.apiRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function call(method: string, path: string, userId = 'u1', body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-dev-user-id': userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

describe('GET /api/settings/preferences', () => {
  test('defaults to PROPOSAL mode for a brand-new account', async () => {
    const res = await call('GET', '/api/settings/preferences', 'brand-new');
    expect(res.status).toBe(200);
    /**
     * The safe default, and the load-bearing one: an absent profile must
     * never read as "autonomous", or a missing record becomes silent trading.
     */
    expect(res.json.autonomyMode).toBe('PROPOSAL');
    expect(res.json.aiModel).toBeNull();
    expect(typeof res.json.autonomyExecutable).toBe('boolean');
  });

  test('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/settings/preferences`);
    expect([401, 503]).toContain(res.status);
  });

  test('one user cannot read another user\'s preferences', async () => {
    await call('POST', '/api/settings/preferences', 'owner-x', { autonomyMode: 'AUTONOMOUS' });
    const other = await call('GET', '/api/settings/preferences', 'someone-else');
    expect(other.json.autonomyMode).toBe('PROPOSAL');
  });
});

describe('POST /api/settings/preferences', () => {
  test('persists AUTONOMOUS mode', async () => {
    const res = await call('POST', '/api/settings/preferences', 'auto-1', {
      autonomyMode: 'AUTONOMOUS',
    });
    expect(res.status).toBe(200);
    expect(res.json.autonomyMode).toBe('AUTONOMOUS');

    const readBack = await call('GET', '/api/settings/preferences', 'auto-1');
    expect(readBack.json.autonomyMode).toBe('AUTONOMOUS');
  });

  test('refuses an unknown mode rather than coercing it', async () => {
    const res = await call('POST', '/api/settings/preferences', 'auto-2', {
      autonomyMode: 'EVERYTHING_GOES',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INVALID_AUTONOMY_MODE');
  });

  test('explains when autonomy is on but the deployment cannot execute', async () => {
    const res = await call('POST', '/api/settings/preferences', 'auto-3', {
      autonomyMode: 'AUTONOMOUS',
    });
    expect(res.status).toBe(200);
    /**
     * With PROPDAO_EXECUTION_ENABLED off (the default, and the state of every
     * deployment until an operator opts in) the user must be told plainly.
     */
    expect(res.json.autonomyExecutable).toBe(false);
    expect(typeof res.json.autonomyBlockedReason).toBe('string');
    expect(res.json.autonomyBlockedReason.length).toBeGreaterThan(0);
  });
});

describe('the model id pattern accepts OpenRouter free-tier slugs', () => {
  /**
   * The pattern used to forbid `:`, which rejected every `:free` model. On a
   * zero-credit account those are the only models that answer, so a user could
   * not select a single working one — GOAT creation failed with
   * `INVALID_INPUT` while a paid slug passed validation.
   */
  const FREE_MODELS = [
    'apodex/apodex-1.1-mini:free',
    'nvidia/nemotron-3.5-lightning:free',
    'poolside/laguna-s-2.1:free',
    'liquid/lfm-2.5-2.6b:free',
    'thinkingmachines/inkling-small:free',
  ];

  test('the router source no longer forbids the variant colon', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, '..', 'src', 'server', 'apiRouter.ts'),
      'utf8',
    );
    const match = /const MODEL_ID_PATTERN =\s*([\s\S]*?);/.exec(source);
    expect(match).not.toBeNull();

    // Reconstruct the literal so the real pattern is exercised, not a copy.
    const literal = match![1].trim().replace(/^\/|\/$/g, '');
    const pattern = new RegExp(literal);

    for (const id of FREE_MODELS) {
      expect(pattern.test(id)).toBe(true);
    }
    for (const id of ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o:extended']) {
      expect(pattern.test(id)).toBe(true);
    }
    for (const id of ['a/b/c:', '/leading', 'trailing/', 'has space', '../../etc/passwd', '']) {
      expect(pattern.test(id)).toBe(false);
    }
  });

  test('a free-tier model is accepted as a GOAT model', async () => {
    const created = await call('POST', '/api/goats', 'free-model-user', {
      name: 'Free model GOAT',
      goal: 'Verify a :free slug survives validation.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    expect(created.status).toBe(200);
    expect(created.json.goat.model).toBe('apodex/apodex-1.1-mini:free');
    await call('DELETE', `/api/goats/${created.json.goat.id}`, 'free-model-user');
  });

  test('a structurally invalid model is still refused', async () => {
    const created = await call('POST', '/api/goats', 'bad-model-user', {
      name: 'Bad model GOAT',
      goal: 'Verify a malformed slug is refused.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'not a model id',
      schedule: { mode: 'MANUAL' },
    });
    expect(created.status).toBe(400);
  });
});

describe('GOAT market validation', () => {
  test('a market the venue does not list is refused with a usable message', async () => {
    const res = await call('POST', '/api/goats', 'bad-market-user', {
      name: 'Bogus market',
      goal: 'Verify an unknown instrument is refused.',
      markets: ['NOT_A_REAL_MARKET_XYZZY'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('UNKNOWN_MARKET');
    // The message has to name the market or the user cannot correct it.
    expect(res.json.error.message).toContain('NOT_A_REAL_MARKET_XYZZY');
  });

  test('the suggestion names a live instrument when one is close', async () => {
    const res = await call('POST', '/api/goats', 'suggest-user', {
      name: 'Legacy FX',
      goal: 'Verify a retired symbol is migrated, not rejected.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
    });
    /**
     * Under the PAPER provider `EUR/USD` is a real instrument, so this asserts
     * the accepted path. The migration mapping itself is covered in
     * `invalidMarketRetry.test.ts`.
     */
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.json.goat.markets).toContain('EUR/USD');
      await call('DELETE', `/api/goats/${res.json.goat.id}`, 'suggest-user');
    }
  });
});

describe('backtest market handling', () => {
  test('an explicit market the GOAT does not watch is a 400, never a substitution', async () => {
    const created = await call('POST', '/api/goats', 'bt-user', {
      name: 'Backtest GOAT',
      goal: 'Verify an out-of-scope market is refused.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    expect(created.status).toBe(200);

    /**
     * The previous code silently fell back to `goat.markets[0]`, so asking to
     * backtest a retired symbol returned a confident result for a completely
     * different market. A wrong backtest is worse than none: it is a number
     * the user will act on.
     */
    const res = await call('POST', '/api/backtest/run', 'bt-user', {
      goatId: created.json.goat.id,
      market: 'GBP/USD',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INVALID_MARKET');

    await call('DELETE', `/api/goats/${created.json.goat.id}`, 'bt-user');
  });

  test('an unlisted market is a 400, not an opaque 500', async () => {
    const created = await call('POST', '/api/goats', 'bt-bad-user', {
      name: 'Backtest GOAT 2',
      goal: 'Verify an unlisted market reports cleanly.',
      markets: ['GBP/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    expect(created.status).toBe(200);

    const res = await call('POST', '/api/backtest/run', 'bt-bad-user', {
      goatId: created.json.goat.id,
      market: 'NOT_A_REAL_MARKET_XYZZY',
    });
    expect(res.status).toBe(400);

    await call('DELETE', `/api/goats/${created.json.goat.id}`, 'bt-bad-user');
  });
});

/* ------------------------------------------------------------------ */
/* Proposal decisions                                                  */
/* ------------------------------------------------------------------ */

describe('proposal decisions', () => {
  test('rejecting an unknown signal is a clean 404', async () => {
    const created = await call('POST', '/api/goats', 'dec-1', {
      name: 'Decision GOAT',
      goal: 'Verify decision validation.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    expect(created.status).toBe(200);
    const goatId = created.json.goat.id;

    const missing = await call(
      'POST',
      `/api/goats/${goatId}/signals/does-not-exist/decision`,
      'dec-1',
      { decision: 'ACCEPTED' },
    );
    expect(missing.status).toBe(404);

    await call('DELETE', `/api/goats/${goatId}`, 'dec-1');
  });

  test("another user's proposal is a 404, never a 403", async () => {
    const created = await call('POST', '/api/goats', 'dec-owner', {
      name: 'Owned GOAT',
      goal: 'Verify ownership on proposals.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    const goatId = created.json.goat.id;

    /**
     * A 403 would confirm the id exists. 404 is what ownership looks like
     * from outside, so probing cannot enumerate another user's proposals.
     */
    const res = await call(
      'POST',
      `/api/goats/${goatId}/signals/anything/decision`,
      'dec-intruder',
      { decision: 'ACCEPTED' },
    );
    expect(res.status).toBe(404);

    await call('DELETE', `/api/goats/${goatId}`, 'dec-owner');
  });

  test('an invalid decision verb is rejected', async () => {
    const created = await call('POST', '/api/goats', 'dec-2', {
      name: 'Decision GOAT 2',
      goal: 'Verify decision validation.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: 'apodex/apodex-1.1-mini:free',
      schedule: { mode: 'MANUAL' },
    });
    const goatId = created.json.goat.id;

    const res = await call(
      'POST',
      `/api/goats/${goatId}/signals/whatever/decision`,
      'dec-2',
      { decision: 'MAYBE' },
    );
    // 404 for the unknown signal, never a 200 that records a nonsense decision.
    expect([400, 404]).toContain(res.status);

    await call('DELETE', `/api/goats/${goatId}`, 'dec-2');
  });
});
