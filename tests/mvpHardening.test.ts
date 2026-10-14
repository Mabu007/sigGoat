/**
 * REGRESSION TESTS FOR THE MVP-HARDENING PASS
 * ============================================
 * One test per defect that shipped and was found by running the real system
 * end to end. Each states the failure in the test name, because a regression
 * test whose name does not describe the bug tends to get deleted rather than
 * fixed.
 */

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { MarketStateStore } from '../src/services/market-data/MarketStateStore';
import { parseChallengeRules } from '../src/services/propdao/PropDaoClient';
import { autoAcceptSignal } from '../src/server/autonomy';
import { normaliseAutonomyMode, type FundGoat, type TradeSignal, type UserProfile } from '../src/types';

/* ------------------------------------------------------------------ */
/* MarketStateStore: the EUR/USD degrade loop                         */
/* ------------------------------------------------------------------ */

describe('a market the venue does not list does not become a hot loop', () => {
  function failingProvider() {
    let calls = 0;
    return {
      /**
       * One refresh issues TWO provider calls (`getQuote` and `getCandles` in
       * parallel), so a single cold read is already 2. The assertion below is
       * about the count NOT GROWING, which is the actual property.
       */
      get calls() {
        return calls;
      },
      name: 'failing',
      dataMode: 'LIVE' as const,
      async getSymbols() {
        return [];
      },
      async getQuote() {
        calls += 1;
        throw new Error('"EUR/USD" is not a market Hyperliquid lists.');
      },
      async getQuotes() {
        return [];
      },
      async getCandles() {
        calls += 1;
        throw new Error('"EUR/USD" is not a market Hyperliquid lists.');
      },
      getMarketMetadata() {
        return undefined;
      },
      subscribeQuotes() {
        return () => {};
      },
    };
  }

  test('repeated reads during the cooldown never touch the provider again', async () => {
    const provider = failingProvider();
    const store = new MarketStateStore(provider as never, {
      ttlMs: 100,
      failureBackoffMs: 10_000,
      maxFailureBackoffMs: 60_000,
      log: () => {},
    });

    const first = await store.getState('EUR/USD', '15m');
    expect(first.status).toBe('UNAVAILABLE');
    const callsAfterFirstRead = provider.calls;
    expect(callsAfterFirstRead).toBeGreaterThan(0);

    /**
     * The original bug: the failure path preserved `fetchedAt`, so every read
     * was a permanent cache miss. Twenty reads meant twenty more provider
     * calls and twenty log lines — the wall of `[market-state] EUR/USD 15m
     * degraded:` output that opened this work.
     */
    for (let i = 0; i < 20; i += 1) {
      const snapshot = await store.getState('EUR/USD', '15m');
      expect(snapshot.status).toBe('UNAVAILABLE');
    }

    expect(provider.calls).toBe(callsAfterFirstRead);
    expect(store.stats.backoffServes).toBe(20);
  });

  test('a repeated failure is logged once, not on every read', async () => {
    const provider = failingProvider();
    const logs: string[] = [];
    let now = 1_000_000;
    const store = new MarketStateStore(provider as never, {
      ttlMs: 100,
      failureBackoffMs: 50,
      maxFailureBackoffMs: 50,
      log: (message) => logs.push(message),
      now: () => now,
    });

    await store.getState('EUR/USD', '15m');
    expect(logs.length).toBe(1);

    // Still inside the 50ms cooldown: served, not re-fetched, not re-logged.
    now += 10;
    await store.getState('EUR/USD', '15m');
    expect(logs.length).toBe(1);

    // Cooldown elapsed: one more attempt, one more log — and it says so.
    now += 100;
    await store.getState('EUR/USD', '15m');
    expect(logs.length).toBe(2);
    expect(logs[1]).toContain('retrying in');
  });

  test('a market that recovers is picked up and the backoff is cleared', async () => {
    let fail = true;
    const store = new MarketStateStore(
      {
        name: 'flaky',
        dataMode: 'LIVE',
        async getSymbols() {
          return [];
        },
        async getQuote() {
          if (fail) throw new Error('not listed');
          return {
            symbol: 'BTC',
            mid: 100,
            bid: 99,
            ask: 101,
            change: 0,
            changePct: 0,
            high: 0,
            low: 0,
            volume: 0,
            timestamp: 0,
            stale: false,
          } as never;
        },
        async getQuotes() {
          return [];
        },
        async getCandles() {
          if (fail) throw new Error('not listed');
          return [];
        },
        getMarketMetadata() {
          return undefined;
        },
        subscribeQuotes() {
          return () => {};
        },
      } as never,
      { ttlMs: 100, failureBackoffMs: 10_000, log: () => {} },
    );

    await store.getState('BTC', '15m');
    expect((await store.getState('BTC', '15m')).status).toBe('UNAVAILABLE');

    fail = false;
    store.invalidate('BTC');
    expect((await store.getState('BTC', '15m')).status).toBe('LIVE');
  });

  test('invalidate clears the backoff, so it is never a silent no-op', async () => {
    const provider = failingProvider();
    const store = new MarketStateStore(provider as never, {
      ttlMs: 100,
      failureBackoffMs: 60_000,
      log: () => {},
    });

    await store.getState('BTC', '15m');
    await store.getState('BTC', '15m');
    const beforeInvalidate = provider.calls;

    store.invalidate('BTC');
    await store.getState('BTC', '15m');
    expect(provider.calls).toBeGreaterThan(beforeInvalidate);
  });
});

/* ------------------------------------------------------------------ */
/* PropDAO challenge rules                                             */
/* ------------------------------------------------------------------ */

describe('PropDAO challenge rules survive every shape the API returns', () => {
  test('rules nested on an account as a JSON STRING are parsed', () => {
    /**
     * Regression. `/accounts` returns `challenge.rules` as a JSON-encoded
     * string, not an object. Reading it as an object yields all-null rules,
     * and `PropRiskValidator` then treats that as "no limits known" — so the
     * drawdown checks meant to protect the trader's account quietly stop
     * protecting anything.
     */
    const rules = parseChallengeRules({
      id: 'prop-50k-trial',
      name: '$50K Free Trial',
      rules:
        '{"account_size":50000,"profit_target":10,"max_drawdown":5,"daily_drawdown":3,' +
        '"profit_split":0,"min_trading_days":0,"min_trade_size":0.5,"drawdown_type":"Static",' +
        '"is_trial":true,"payout_eligible":false}',
    });

    expect(rules.accountSize).toBe(50000);
    expect(rules.maxDrawdownPct).toBe(5);
    expect(rules.dailyDrawdownPct).toBe(3);
    expect(rules.drawdownType).toBe('Static');
    expect(rules.isTrial).toBe(true);
    expect(rules.payoutEligible).toBe(false);
  });

  test('rules as a plain object (the /challenges shape) still parse', () => {
    const rules = parseChallengeRules({
      rules: { account_size: 5000, max_drawdown: 5, daily_drawdown: 1, profit_split: 80 },
    });
    expect(rules.accountSize).toBe(5000);
    expect(rules.dailyDrawdownPct).toBe(1);
    expect(rules.profitSplitPct).toBe(80);
  });

  test('a rules value that is not JSON is ignored, not thrown on', () => {
    const rules = parseChallengeRules({ rules: 'not json at all' });
    expect(rules.accountSize).toBeNull();
    expect(rules.maxDrawdownPct).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Autonomy                                                            */
/* ------------------------------------------------------------------ */

describe('autonomy mode', () => {
  const goat: FundGoat = {
    id: 'goat_1',
    userId: 'u1',
    name: 'Test',
    goal: 'Test',
    markets: ['xyz:GOLD'],
    skillIds: [],
    model: 'apodex/apodex-1.1-mini:free',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'sig_1',
      userId: 'u1',
      goatId: 'goat_1',
      thesisId: 'th_1',
      market: 'xyz:GOLD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 4194,
      stopLoss: 4150,
      takeProfit: 4300,
      confidence: 70,
      thesis: 'Breakout',
      rationale: 'Because',
      confirmationRequired: 'Close above 4194',
      invalidation: 'Close below 4150',
      supportingEvidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'ACTIONABLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function profile(autonomyMode?: string): UserProfile {
    return {
      id: 'u1',
      email: 'u1@test.local',
      displayName: 'U1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(autonomyMode ? { autonomyMode: autonomyMode as never } : {}),
    };
  }

  const policy = { enabled: false, authorised: false, summary: 'off', termsSummary: '' };

  test('a user with no profile is PROPOSAL mode, never autonomous', async () => {
    /**
     * Fail-safe default. An absent profile row must never be read as
     * "autonomous", or a missing record becomes silent live trading.
     */
    expect(normaliseAutonomyMode(undefined)).toBe('PROPOSAL');
    const outcome = await autoAcceptSignal(
      { persistence: { signals: { update: async () => true }, profiles: { get: async () => null } }, policyStatus: () => policy },
      goat,
      signal(),
    );
    expect(outcome.action).toBe('SKIPPED_PROPOSAL_MODE');
  });

  test('PROPOSAL mode never decides anything', async () => {
    let updated = false;
    const outcome = await autoAcceptSignal(
      {
        persistence: {
          signals: { update: async () => { updated = true; return true; } },
          profiles: { get: async () => profile('PROPOSAL') },
        },
        policyStatus: () => policy,
      },
      goat,
      signal(),
    );
    expect(outcome.action).toBe('SKIPPED_PROPOSAL_MODE');
    expect(updated).toBe(false);
  });

  test('AUTONOMOUS mode records the acceptance and says WHY in the audit trail', async () => {
    const outcome = await autoAcceptSignal(
      {
        persistence: {
          signals: { update: async () => true },
          profiles: { get: async () => profile('AUTONOMOUS') },
        },
        policyStatus: () => policy,
      },
      goat,
      signal(),
    );

    expect(outcome.action).toBe('AUTO_ACCEPTED');
    if (outcome.action !== 'AUTO_ACCEPTED') throw new Error('unreachable');
    expect(outcome.signal.decision).toBe('ACCEPTED');
    // An audit record indistinguishable from a clicked Accept is unreviewable.
    expect(outcome.signal.decisionNote).toMatch(/autonomy/i);
    // And it reports the policy rather than implying an order went out.
    expect(outcome.execution.enabled).toBe(false);
  });

  test('a NO_TRADE signal is never auto-accepted', async () => {
    const outcome = await autoAcceptSignal(
      {
        persistence: {
          signals: { update: async () => true },
          profiles: { get: async () => profile('AUTONOMOUS') },
        },
        policyStatus: () => policy,
      },
      goat,
      signal({ direction: 'NO_TRADE' }),
    );
    expect(outcome.action).toBe('SKIPPED_NOT_ACTIONABLE');
  });

  test('an expired signal is never auto-accepted', async () => {
    const outcome = await autoAcceptSignal(
      {
        persistence: {
          signals: { update: async () => true },
          profiles: { get: async () => profile('AUTONOMOUS') },
        },
        policyStatus: () => policy,
      },
      goat,
      signal({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    );
    expect(outcome.action).toBe('SKIPPED_NOT_ACTIONABLE');
  });

  test('an already-decided signal is left alone', async () => {
    const outcome = await autoAcceptSignal(
      {
        persistence: {
          signals: { update: async () => true },
          profiles: { get: async () => profile('AUTONOMOUS') },
        },
        policyStatus: () => policy,
      },
      goat,
      signal({ decision: 'REJECTED', decidedAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(outcome.action).toBe('SKIPPED_NOT_ACTIONABLE');
  });

  test('an unknown stored mode degrades to PROPOSAL, never to autonomous', () => {
    expect(normaliseAutonomyMode('FULL_POWER')).toBe('PROPOSAL');
    expect(normaliseAutonomyMode(42)).toBe('PROPOSAL');
    expect(normaliseAutonomyMode(null)).toBe('PROPOSAL');
  });
});

/* ------------------------------------------------------------------ */
/* GOAT create must not exceed the serverless timeout                  */
/* ------------------------------------------------------------------ */

describe('creating a GOAT does not block on a model call', () => {
  const router = fs.readFileSync(
    path.join(import.meta.dir, '..', 'src', 'server', 'apiRouter.ts'),
    'utf8',
  );

  test('the first analysis is dispatched, not awaited', () => {
    /**
     * The route used to `await` a full reasoning run before responding. A
     * model call is 15-40s and the reasoning-off retry can double it, so on
     * Vercel every GOAT creation returned `504 FUNCTION_INVOCATION_TIMEOUT`
     * — for a GOAT that had been created, scheduled and persisted
     * successfully. The user retried and ended up with two.
     */
    expect(router).toContain('firstAnalysisPending: true');
    // The dispatch must be detached (`void ... .catch`) and NOT awaited.
    expect(router).toMatch(/void\s+runtime\s*\n?\s*\.wake\(/);
    expect(router).not.toMatch(/const firstRun = await runtime\.wake/);
  });

  test('the response tells the client the first analysis is still running', () => {
    /**
     * Otherwise the UI receives an empty runtime state and has no way to
     * distinguish "not started yet" from "did nothing".
     */
    expect(router).toContain('firstAnalysisPending');
  });

  test('the serverless function budget exceeds a slow reasoning retry', () => {
    const vercel = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, '..', 'vercel.json'), 'utf8'),
    );
    // 60s was below the worst-case reasoning run.
    expect(vercel.functions['api/index.js'].maxDuration).toBeGreaterThan(60);
  });
});

describe('pausing a GOAT abandons in-flight work', () => {
  const runtime = fs.readFileSync(
    path.join(import.meta.dir, '..', 'src', 'services', 'goat-runtime', 'GoatRuntime.ts'),
    'utf8',
  );

  test('pause assigns a new generation so a running wake cannot write state', () => {
    /**
     * Stopping the alarms was not enough. A model call already dispatched
     * kept running and, on return, passed every existing check and wrote its
     * thesis and signal — after the UI had told the user "No analysis and no
     * tracker evaluation will run". The runtime was silently breaking a
     * promise it made in its own copy.
     */
    const start = runtime.indexOf('pause(): GoatRuntimeState');
    expect(start).toBeGreaterThan(-1);
    // Stop at the next method declaration, which is where `pause` really ends.
    const nextMethod = runtime.indexOf('\n  /**', start + 10);
    const body = runtime.slice(start, nextMethod > start ? nextMethod : start + 1500);
    expect(body).toContain('this.runtimeState.generationId = this.newGenerationId()');
    expect(body).toContain('this.runtimeState.isEvaluating = false');
    // And it must happen BEFORE the method returns, not after an await.
    // `lastIndexOf` because the guard clause `if (this.paused) return …` sits
    // above the body we care about.
    expect(body.indexOf('newGenerationId()')).toBeLessThan(
      body.lastIndexOf('return this.runtimeState'),
    );
  });
});
