/**
 * PROPDAO INTEGRATION TESTS
 *
 * Recorded payloads shaped from https://www.propdao.finance/docs, verified
 * against the live API on 2026-10-10.
 *
 * NOTHING HERE RUNS AGAINST PRODUCTION. These tests exercise parsing, risk
 * arithmetic and the execution gate against fixtures. Passing them is NOT a
 * claim that a real order was placed, that a real account was read, or that
 * PropDAO has authorised this integration.
 */

import { describe, expect, test } from 'bun:test';
import {
  PropDaoClient,
  PropDaoError,
  parseAccounts,
  parseChallengeRules,
  parseIdentity,
  parseMarkets,
  parseOrders,
  parsePositions,
  parseRisk,
  parseTrades,
  describePropDaoError,
} from '../src/services/propdao/PropDaoClient';
import {
  PROPDAO_CAPABILITIES,
  PropFundAccountProvider,
  isSupported,
} from '../src/services/propdao/PropFundAccountProvider';
import {
  evaluateExecution,
  executionPolicyStatus,
  isCommercialUseAuthorised,
  isExecutionEnabled,
} from '../src/services/propdao/executionPolicy';
import {
  DEFAULT_RISK_LIMITS,
  PROPDAO_FEES,
  assertExecutionSpacing,
  floorToLotStep,
  portfolioRiskUsd,
  stopDistance,
  validateTradeIntent,
} from '../src/services/propdao/PropRiskValidator';
import type { AccountRiskSnapshot, FundAccountSummary } from '../src/services/propdao/PropFundAccountProvider';

/* ------------------------------------------------------------------ */
/* Recorded payloads                                                   */
/* ------------------------------------------------------------------ */

const IDENTITY = { userId: 'u_123', loginKind: 'supabase', apiKeyId: 'k_abc' };

const ACCOUNTS = {
  accounts: [
    {
      account_id: 'prop-abc123',
      status: 'active',
      challenge_id: 'prop-25k-1',
      purchase_date: '2026-08-01T00:00:00.000Z',
      challenge: {
        account_size: 25000,
        profit_target: 10,
        max_drawdown: 5,
        // The LIVE API uses daily_drawdown; the docs example used daily_loss.
        daily_drawdown: 2,
        profit_split: 80,
        min_trading_days: 0,
        min_trade_size: 0.5,
        drawdown_type: 'Static',
      },
    },
    { account_id: 'prop-def456', status: 'funded', challenge_id: null, purchase_date: null, challenge: null },
  ],
};

/** The documented `/risk` payload, including the floor arithmetic. */
const RISK = {
  equity: 99120.5,
  balance: 98900.0,
  floor: 96000.0,
  floorKind: 'max',
  maxFloor: 95000.0,
  dailyFloor: 96000.0,
  roomUsd: 3120.5,
  roomPct: 3.15,
  breached: false,
  openPositions: 1,
};

const POSITIONS = {
  data: [
    {
      id: 'pos-1',
      symbol: 'BTCUSDC',
      side: 'BUY',
      qty: 0.01,
      entry: 64210.5,
      leverage: 2,
      notional: 642.1,
      marginAllocated: 321.0,
      openedAt: 1789688515998,
      mark: 64890.0,
      unrealizedPnl: 6.79,
      // CASH amounts...
      sl: -50.0,
      tp: 120.0,
      // ...and PRICES. Only the prices are usable as stop levels.
      slPrice: 59210.5,
      tpPrice: 76210.5,
    },
  ],
  total: 1,
};

const ORDERS = { data: [{ id: 'ord-1', symbol: 'ETHUSDC', side: 'BUY', qty: 1, orderType: 'limit', limitPrice: 3000, status: 'open' }] };
const TRADES = { data: [{ id: 'tr-1', symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, entryPrice: 64000, exitPrice: 65000, pnl: 10, fee: 0.29, closedAt: 1789688515998 }] };

const MARKETS = {
  fees: { taker: 0.00045, maker: 0.00015 },
  marginMode: 'isolated',
  leverageStep: 1,
  data: [
    // The docs say equities are 1.5x; the LIVE API reports 2x. Live wins.
    { symbol: 'AAPLUSDC', coin: 'AAPL', dex: null, maxLeverage: 2, lotStep: 0.00001, szDecimals: 5 },
    { symbol: 'BTCUSDC', coin: 'BTC', dex: null, maxLeverage: 10, lotStep: 0.00001, szDecimals: 5 },
    { symbol: 'APTUSDC', coin: 'APT', dex: null, maxLeverage: 1, lotStep: 0.1, szDecimals: 1 },
  ],
  total: 145,
};

/** Narrows a discriminated result to its failure branch. */
function isFailure<T>(value: T): value is T & { executed: false; code: string; message: string } {
  return (value as { executed?: boolean })?.executed === false;
}

/** Narrows a discriminated result to its failure branch (connected probes). */
function isNotConnected<T>(value: T): value is T & { connected: false; code: string; message: string } {
  return (value as { connected?: boolean })?.connected === false;
}

function stubClient(handlers: Record<string, unknown>, calls: Array<{ path: string; body?: any }> = []) {
  return new PropDaoClient({
    apiKey: 'pd_live_testsonlykey0000000000',
    fetchImpl: async (url, init) => {
      const path = url.replace('https://app.propdao.finance/api/v1', '');
      const [route] = path.split('?');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: route, body });
      if (!(route in handlers)) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      return new Response(JSON.stringify(handlers[route]), { status: 200 });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

describe('PropDAO response parsing', () => {
  test('parses identity', () => {
    expect(parseIdentity(IDENTITY)).toEqual({ userId: 'u_123', loginKind: 'supabase', apiKeyId: 'k_abc' });
    expect(parseIdentity({})).toBeNull();
    expect(parseIdentity(null)).toBeNull();
  });

  test('parses both snake_case and camelCase account fields', () => {
    const accounts = parseAccounts(ACCOUNTS);
    expect(accounts.length).toBe(2);
    expect(accounts[0].accountId).toBe('prop-abc123');
    expect(accounts[0].status).toBe('active');
    // A camelCase variant must parse identically.
    expect(parseAccounts({ accounts: [{ accountId: 'x', status: 'active' }] })[0].accountId).toBe('x');
  });

  test('skips an account with no id rather than returning a blank one', () => {
    expect(parseAccounts({ accounts: [{ status: 'active' }, { account_id: 'ok' }] }).length).toBe(1);
  });

  test('parses risk including the documented floor fields', () => {
    const risk = parseRisk(RISK)!;
    expect(risk.equity).toBe(99120.5);
    expect(risk.floor).toBe(96000);
    // The docs state floor = max(maxFloor, dailyFloor) = max(95000, 96000).
    expect(risk.floor).toBe(Math.max(risk.maxFloor!, risk.dailyFloor!));
    expect(risk.roomUsd).toBeCloseTo(risk.equity! - risk.floor!, 6);
    expect(risk.breached).toBe(false);
  });

  test('returns null for risk fields the provider omitted', () => {
    const risk = parseRisk({ equity: 100 })!;
    expect(risk.floor).toBeNull();
    expect(risk.roomUsd).toBeNull();
    // Never coerced to zero — a null floor is not a zero floor.
    expect(risk.equity).toBe(100);
  });

  test('maps ONLY the price variants of sl/tp', () => {
    const [position] = parsePositions(POSITIONS);
    // sl: -50 is a CASH amount; using it as a stop price would be catastrophic.
    expect(position.slPrice).toBe(59210.5);
    expect(position.tpPrice).toBe(76210.5);
  });

  test('parses positions, orders, trades and markets', () => {
    expect(parsePositions(POSITIONS)[0].symbol).toBe('BTCUSDC');
    expect(parseOrders(ORDERS)[0].id).toBe('ord-1');
    expect(parseTrades(TRADES)[0].pnl).toBe(10);
    expect(parseMarkets(MARKETS).length).toBe(3);
  });

  test('reads daily drawdown from BOTH documented field names', () => {
    // The live API sends daily_drawdown; the docs example used daily_loss.
    // Accepting only one would silently produce a null daily limit.
    expect(parseChallengeRules(ACCOUNTS.accounts[0]).dailyDrawdownPct).toBe(2);
    expect(parseChallengeRules(ACCOUNTS.accounts[0].challenge).dailyDrawdownPct).toBe(2);
    expect(parseChallengeRules({ rules: { daily_drawdown: 3 } }).dailyDrawdownPct).toBe(3);
    expect(parseChallengeRules({ rules: { daily_loss: 3 } }).dailyDrawdownPct).toBe(3);
    expect(parseChallengeRules({ rules: { dailyDrawdown: 1 } }).dailyDrawdownPct).toBe(1);
  });

  test('trusts the live leverage cap over the documented one', () => {
    // Docs say 1.5x for equities; live says 2x.
    const markets = parseMarkets(MARKETS);
    expect(markets.find((m) => m.symbol === 'AAPLUSDC')!.maxLeverage).toBe(2);
    expect(markets.find((m) => m.symbol === 'APTUSDC')!.maxLeverage).toBe(1);
  });

  test('tolerates malformed payloads without throwing', () => {
    for (const payload of [null, undefined, 'text', 42, [], {}]) {
      expect(() => parseAccounts(payload)).not.toThrow();
      expect(() => parsePositions(payload)).not.toThrow();
      expect(() => parseRisk(payload)).not.toThrow();
    }
    expect(parseRisk(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

describe('PropDAO error handling', () => {
  test('classifies 401 as an invalid or revoked key', async () => {
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    let error: unknown;
    try { await client.identity(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PropDaoError);
    expect((error as PropDaoError).code).toBe('UNAUTHORIZED');
    expect(describePropDaoError(error).message).toMatch(/revoked/);
  });

  test('classifies 429 with Retry-After', async () => {
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } }),
    });
    let error: unknown;
    try { await client.accounts(); } catch (caught) { error = caught; }
    expect((error as PropDaoError).code).toBe('RATE_LIMITED');
    expect((error as PropDaoError).retryAfterSeconds).toBe(3);
  });

  test('classifies 409 as an in-flight idempotent request', async () => {
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => new Response('conflict', { status: 409 }),
    });
    let error: unknown;
    try { await client.accounts(); } catch (caught) { error = caught; }
    expect(describePropDaoError(error).message).toMatch(/still executing/);
  });

  test('does not reveal whether an account exists to a non-owner', async () => {
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    let error: unknown;
    try { await client.accounts(); } catch (caught) { error = caught; }
    // The message must not distinguish "no such account" from "not yours".
    expect(describePropDaoError(error).message).not.toMatch(/does not exist|unknown account/i);
  });

  test('never leaks the API key into an error message', async () => {
    const key = 'pd_live_supersecret000000000000';
    const client = new PropDaoClient({
      apiKey: key,
      fetchImpl: async () => new Response(JSON.stringify({ error: `bad key ${key}` }), { status: 401 }),
    });
    let error: unknown;
    try { await client.identity(); } catch (caught) { error = caught; }
    expect(JSON.stringify(describePropDaoError(error))).not.toContain(key);
    expect((error as Error).message).not.toContain(key);
  });

  test('does not retry a non-idempotent write', async () => {
    let calls = 0;
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => { calls += 1; return new Response('boom', { status: 500 }); },
    });
    try { await client.placeOrder('acc', { symbol: 'BTCUSDC', side: 'BUY', qty: 1, intentId: 'x' }); } catch { /* expected */ }
    // A retried order risks a duplicate fill; reads are the only safe retry.
    expect(calls).toBe(1);
  });

  test('retries a failed read with backoff', async () => {
    let calls = 0;
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return new Response('flaky', { status: 500 });
        return new Response(JSON.stringify(ACCOUNTS), { status: 200 });
      },
    });
    expect((await client.accounts()).length).toBe(2);
    expect(calls).toBe(3);
  });

  test('sends the key in the Authorization header, never in the URL', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = new Headers(init.headers).get('authorization') ?? '';
        return new Response(JSON.stringify(IDENTITY), { status: 200 });
      },
    });
    await client.identity();
    expect(seenUrl).toBe('https://app.propdao.finance/api/v1/me');
    expect(seenUrl).not.toContain('pd_live');
    expect(seenAuth).toBe('Bearer pd_live_b000000000000000000');
  });

  test('sends every documented order field', async () => {
    const calls: Array<{ path: string; body?: any }> = [];
    const client = stubClient({ '/accounts/acc1/orders': { status: 'ok', orderId: 'o1' } }, calls);
    await client.placeOrder('acc1', {
      symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, intentId: 'intent-1',
      orderType: 'limit', limitPrice: 64000, sl: 63000, tp: 66000, leverage: 2, tif: 'gtc',
    });
    expect(calls[0].body).toMatchObject({
      symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, intentId: 'intent-1',
      orderType: 'limit', limitPrice: 64000, sl: 63000, tp: 66000, leverage: 2, tif: 'gtc',
    });
  });

  test('surfaces the idempotent replay flag', async () => {
    const client = new PropDaoClient({
      apiKey: 'pd_live_b000000000000000000',
      fetchImpl: async () => new Response(JSON.stringify({ status: 'filled' }), { status: 200, headers: { 'x-idempotent-replay': 'true' } }),
    });
    const result = await client.placeOrder('acc', { symbol: 'BTCUSDC', side: 'BUY', qty: 1, intentId: 'i' });
    expect(result.idempotentReplay).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

describe('PropDAO capabilities', () => {
  test('declares the documented read capabilities', () => {
    for (const cap of ['listAccounts', 'readRisk', 'readPositions', 'readOrders', 'readTrades', 'discoverMarkets'] as const) {
      expect(isSupported(cap)).toBe(true);
    }
  });

  test('declares the documented ABSENCES as unsupported', () => {
    // There is no PATCH on an order — amend would be cancel-then-replace.
    expect(PROPDAO_CAPABILITIES.modifyOrder).toBe(false);
    // Payouts are terminal-UI-only.
    expect(PROPDAO_CAPABILITIES.payout).toBe(false);
    // No webhook endpoint is documented.
    expect(PROPDAO_CAPABILITIES.webhooks).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Execution policy                                                    */
/* ------------------------------------------------------------------ */

describe('execution policy', () => {
  const enabled = { PROPDAO_EXECUTION_ENABLED: 'true', PROPDAO_EXECUTION_AUTHORISED: 'true', PROPDAO_EXECUTION_TERMS_REFERENCE: 'email-2026-10-01' };
  const preconditions = { capabilitySupported: true, hasCredential: true, accountId: 'acc1', accountStatus: 'active' };

  test('is disabled by default', () => {
    expect(isExecutionEnabled({})).toBe(false);
    const decision = evaluateExecution(preconditions, {});
    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) {
      expect(decision.code).toBe('EXECUTION_DISABLED');
      expect(decision.message).toMatch(/personal, non-commercial use/);
    }
  });

  test('stays disabled when only the enable flag is set', () => {
    // A single flag is a misconfiguration, and the safe reading is "off".
    const decision = evaluateExecution(preconditions, { PROPDAO_EXECUTION_ENABLED: 'true' });
    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) expect(decision.code).toBe('TERMS_NOT_VERIFIED');
  });

  test('allows execution only with BOTH flags', () => {
    expect(isCommercialUseAuthorised(enabled)).toBe(true);
    expect(evaluateExecution(preconditions, enabled).allowed).toBe(true);
  });

  test('checks the deployment flag before any request precondition', () => {
    const decision = evaluateExecution(
      { capabilitySupported: false, hasCredential: false, accountId: null, accountStatus: 'failed' },
      {},
    );
    expect(decision.allowed).toBe(false);
    // The operator's switch is the answer, not a downstream condition.
    if (decision.allowed === false) expect(decision.code).toBe('EXECUTION_DISABLED');
  });

  test('refuses when there is no credential or account', () => {
    expect(evaluateExecution({ ...preconditions, hasCredential: false }, enabled).allowed).toBe(false);
    expect(evaluateExecution({ ...preconditions, accountId: null }, enabled).allowed).toBe(false);
  });

  test('refuses an account that cannot accept orders', () => {
    const decision = evaluateExecution({ ...preconditions, accountStatus: 'failed' }, enabled);
    expect(decision.allowed).toBe(false);
    if (decision.allowed === false) expect(decision.code).toBe('ACCOUNT_NOT_TRADEABLE');
  });

  test('accepts active, passed and funded accounts', () => {
    for (const status of ['active', 'passed', 'funded']) {
      expect(evaluateExecution({ ...preconditions, accountStatus: status }, enabled).allowed).toBe(true);
    }
  });

  test('reports a status that is honest about why execution is off', () => {
    const status = executionPolicyStatus({});
    expect(status.enabled).toBe(false);
    expect(status.summary).toMatch(/does not place trades/);
    expect(status.termsSummary).toMatch(/non-commercial use/);
  });
});

/* ------------------------------------------------------------------ */
/* Deterministic risk validation                                       */
/* ------------------------------------------------------------------ */

describe('deterministic risk validation', () => {
  const account: FundAccountSummary = {
    accountId: 'prop-abc123', provider: 'propdao', status: 'active',
    challengeId: 'prop-25k-1',
    rules: { accountSize: 25000, profitTargetPct: 10, maxDrawdownPct: 5, dailyDrawdownPct: 2, profitSplitPct: 80, minTradingDays: 0, minTradeSize: 0.5, drawdownType: 'Static' },
  };

  const goodRisk: AccountRiskSnapshot = {
    accountId: 'prop-abc123',
    equity: 99120.5, balance: 98900, floorUsd: 96000, floorKind: 'max',
    roomUsd: 3120.5, roomPct: 3.15, breached: false, openPositions: 0, incomplete: false,
  };

  const markets = parseMarkets(MARKETS);

  const intent = {
    symbol: 'BTCUSDC', side: 'BUY' as const, qty: 0.01,
    entry: 64210.5, stopLoss: 63210.5, takeProfit: 68210.5, leverage: 2,
  };

  test('approves a well-formed trade inside the risk budget', () => {
    const result = validateTradeIntent(intent, account, goodRisk, markets, []);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    // 1000 points of stop * 0.01 BTC = $10, plus fees.
    expect(result.measured.riskUsd).toBeCloseTo(10, 6);
    expect(result.measured.riskReward).toBeCloseTo(4, 6);
  });

  test('rejects an instrument PropDAO does not offer', () => {
    const result = validateTradeIntent({ ...intent, symbol: 'EURUSD' }, account, goodRisk, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/not a market PropDAO offers/);
  });

  test('rejects leverage above the LIVE cap, not the documented one', () => {
    const result = validateTradeIntent({ ...intent, symbol: 'AAPLUSDC', entry: 200, stopLoss: 199, takeProfit: 210, qty: 1, leverage: 3 }, account, goodRisk, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toMatch(/2x maximum/);
    // 2x is permitted for this symbol per the live market list.
    const ok = validateTradeIntent({ ...intent, symbol: 'AAPLUSDC', entry: 200, stopLoss: 199, takeProfit: 210, qty: 1, leverage: 2 }, account, goodRisk, markets, []);
    expect(ok.violations.join(' ')).not.toMatch(/Leverage/);
  });

  test('rejects a stop on the wrong side of the entry', () => {
    const long = validateTradeIntent({ ...intent, stopLoss: 65000 }, account, goodRisk, markets, []);
    expect(long.ok).toBe(false);
    expect(long.violations.join(' ')).toMatch(/stop-loss must be BELOW/);

    const short = validateTradeIntent(
      { symbol: 'BTCUSDC', side: 'SELL', qty: 0.01, entry: 64210.5, stopLoss: 63000, takeProfit: 60000 },
      account, goodRisk, markets, [],
    );
    expect(short.violations.join(' ')).toMatch(/stop-loss must be ABOVE/);
  });

  test('rejects a take-profit on the wrong side', () => {
    const result = validateTradeIntent({ ...intent, takeProfit: 60000 }, account, goodRisk, markets, []);
    expect(result.violations.join(' ')).toMatch(/take-profit must be ABOVE/);
  });

  test('rejects a trade whose risk exceeds the remaining budget', () => {
    // A 10-point stop on 10 BTC is $100 of risk against a $6.77 headroom.
    const result = validateTradeIntent({ ...intent, qty: 10 }, account, goodRisk, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toMatch(/drawdown headroom/);
    // The violation names a concrete corrective size.
    expect(result.violations.join(' ')).toMatch(/Reduce size to about/);
  });

  test('refuses entirely when the provider reported no headroom', () => {
    // roomUsd null must NOT be treated as "unlimited".
    const result = validateTradeIntent(intent, account, { ...goodRisk, roomUsd: null, incomplete: true }, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/did not report remaining risk headroom/);
  });

  test('refuses when there is no headroom left at all', () => {
    const result = validateTradeIntent(intent, account, { ...goodRisk, roomUsd: 0 }, markets, []);
    expect(result.violations.join(' ')).toMatch(/no remaining drawdown headroom/);
  });

  test('refuses a breached account', () => {
    const result = validateTradeIntent(intent, account, { ...goodRisk, breached: true }, markets, []);
    expect(result.violations.join(' ')).toMatch(/breached/);
  });

  test('refuses without an account or risk data', () => {
    expect(validateTradeIntent(intent, null, goodRisk, markets, []).ok).toBe(false);
    expect(validateTradeIntent(intent, account, null, markets, []).ok).toBe(false);
  });

  test('rejects a poor reward:risk', () => {
    const result = validateTradeIntent({ ...intent, takeProfit: 64500 }, account, goodRisk, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toMatch(/Reward:risk/);
  });

  test('includes fees in the risk figure', () => {
    const result = validateTradeIntent(intent, account, goodRisk, markets, []);
    const notional = result.measured.notionalUsd!;
    const expectedFees = notional * PROPDAO_FEES.taker * 2;
    expect(result.measured.feeUsd).toBeCloseTo(expectedFees, 8);
    // Fees are charged on both ends of the round trip.
    expect(result.measured.feeUsd).toBeCloseTo(notional * 0.0009, 8);
  });

  test('rejects a quantity below the lot step', () => {
    const result = validateTradeIntent({ ...intent, symbol: 'APTUSDC', entry: 10, stopLoss: 9.8, takeProfit: 11, qty: 0.05, leverage: 1 }, account, goodRisk, markets, []);
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toMatch(/lot step/);
  });

  test('floors a quantity to the lot step rather than rounding up', () => {
    // 0.12345 on a 0.1 step must become 0.1, never 0.2.
    expect(floorToLotStep(0.12345, 0.1)).toBeCloseTo(0.1, 8);
    expect(floorToLotStep(0.12345, 0.00001)).toBeCloseTo(0.12345, 8);
    expect(floorToLotStep(0.05, 0.1)).toBe(0);
    expect(floorToLotStep(5, null)).toBeNull();
    // Regression: 0.01/0.00001 evaluates to 999.9999999999999 in binary
    // floating point, so a naive floor() silently drops one whole lot step.
    expect(floorToLotStep(0.01, 0.00001)).toBe(0.01);
    expect(floorToLotStep(1, 0.1)).toBe(1);
    expect(floorToLotStep(0.3, 0.1)).toBe(0.3);
  });

  test('rejects a non-positive or non-finite price', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateTradeIntent({ ...intent, entry: bad }, account, goodRisk, markets, []);
      expect(result.ok).toBe(false);
    }
  });

  test('sums open-position risk against the same budget', () => {
    // One open BTC long with a $1000 stop on 0.01 = $5000 of committed risk,
    // which already exceeds the $3120.50 remaining headroom.
    const positions = parsePositions(POSITIONS).map((p) => ({ ...p, qty: 0.5 }));
    const result = validateTradeIntent(intent, account, goodRisk, markets, positions);
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toMatch(/portfolio limit/);
  });

  test('returns null portfolio risk when a position has no stop', () => {
    const unbounded = parsePositions(POSITIONS).map((p) => ({ ...p, slPrice: null }));
    // Unbounded risk cannot be summed, so it must not be reported as 0.
    expect(portfolioRiskUsd(unbounded, new Map())).toBeNull();
  });

  test('stopDistance returns null for a stop on the wrong side', () => {
    expect(stopDistance('BUY', 100, 90)).toBe(10);
    expect(stopDistance('BUY', 100, 110)).toBeNull();
    expect(stopDistance('SELL', 100, 110)).toBe(10);
    expect(stopDistance('SELL', 100, 90)).toBeNull();
  });

  test('enforces the documented 0.5s execution spacing', () => {
    expect(assertExecutionSpacing(null, 1000)).toEqual({ ok: true });
    expect(assertExecutionSpacing(1000, 2000)).toEqual({ ok: true });
    const tooSoon = assertExecutionSpacing(1000, 1100);
    expect(tooTooSoonGuard(tooSoon)).toBe(false);
    function tooTooSoonGuard(result: ReturnType<typeof assertExecutionSpacing>): boolean {
      return result.ok;
    }
  });

  test('never lets a model-shaped field influence the outcome', () => {
    // Identical inputs must give identical results, regardless of any extra
    // property a caller might attach.
    const a = validateTradeIntent(intent, account, goodRisk, markets, []);
    const b = validateTradeIntent({ ...intent, confidence: 99, approvedByModel: true } as never, account, goodRisk, markets, []);
    expect(b.ok).toBe(a.ok);
    expect(b.measured.riskUsd).toBe(a.measured.riskUsd);
  });
});

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

describe('PropDAO account adapter', () => {
  function adapter(key: string | undefined, env: NodeJS.ProcessEnv = {}) {
    return new PropFundAccountProvider({
      resolveApiKey: async () => key,
      clientFactory: (apiKey) => stubClient({ '/me': IDENTITY, '/accounts': ACCOUNTS, '/accounts/prop-abc123/risk': RISK }),
      env,
    });
  }

  test('verifies a connection without returning the key', async () => {
    const result = await adapter('pd_live_test00000000000000000000').verifyConnection();
    expect(result.connected).toBe(true);
    if (result.connected) {
      expect(result.userId).toBe('u_123');
      expect(result.accountCount).toBe(2);
    }
    // The key must not appear anywhere in the result.
    expect(JSON.stringify(result)).not.toContain('pd_live');
  });

  test('reports a clear failure for a missing key', async () => {
    const result = await adapter(undefined).verifyConnection();
    expect(result.connected).toBe(false);
    expect(isNotConnected(result) ? result.code : 'UNEXPECTED_SUCCESS').toBe('NO_CREDENTIAL');
  });

  test('maps accounts and their rules', async () => {
    const accounts = await adapter('pd_live_x000000000000000000000').listAccounts();
    expect(accounts.length).toBe(2);
    expect(accounts[0].rules?.dailyDrawdownPct).toBe(2);
    expect(accounts[0].rules?.maxDrawdownPct).toBe(5);
  });

  test('refuses to resolve an account the key cannot see', async () => {
    // This is the ownership boundary: an id from a request body must not be
    // usable unless the key's own /accounts response contains it.
    const provider = adapter('pd_live_x000000000000000000000');
    expect(await provider.resolveAccount('someone-elses-account')).toBeNull();
    expect(await provider.resolveAccount('prop-abc123')).not.toBeNull();
  });

  test('marks risk as incomplete rather than zero when the provider is silent', async () => {
    const provider = new PropFundAccountProvider({
      resolveApiKey: async () => 'pd_live_x000000000000000000000',
      clientFactory: () => stubClient({ '/accounts': ACCOUNTS, '/accounts/prop-abc123/risk': { equity: 100 } }),
    });
    const risk = await provider.risk('prop-abc123');
    expect(risk.incomplete).toBe(true);
    expect(risk.floorUsd).toBeNull();
    // A null floor must not be rendered as 0 anywhere.
    expect(risk.floorUsd).not.toBe(0);
  });

  test('refuses to execute while the deployment is disabled', async () => {
    const provider = adapter('pd_live_x000000000000000000000');
    const result = await provider.executeOrder('prop-abc123', { symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, intentId: 'i1' });
    expect(result.executed).toBe(false);
    expect(isFailure(result) ? result.code : 'UNEXPECTED_SUCCESS').toBe('EXECUTION_DISABLED');
    expect(isFailure(result) ? result.message : '').toMatch(/non-commercial use/);
  });

  test('never sends an order when execution is disabled, even for an owned account', async () => {
    const calls: Array<{ path: string; body?: any }> = [];
    const provider = new PropFundAccountProvider({
      resolveApiKey: async () => 'pd_live_x000000000000000000000',
      clientFactory: () => stubClient({ '/me': IDENTITY, '/accounts': ACCOUNTS }, calls),
      env: {},
    });
    await provider.executeOrder('prop-abc123', { symbol: 'BTCUSDC', side: 'BUY', qty: 0.01, intentId: 'i1' });
    // No POST to /orders may have been attempted.
    expect(calls.filter((c) => c.path.endsWith('/orders'))).toHaveLength(0);
  });

  test('refuses an unsupported capability before making any request', async () => {
    const calls: Array<{ path: string; body?: any }> = [];
    const provider = new PropFundAccountProvider({
      resolveApiKey: async () => 'pd_live_x000000000000000000000',
      clientFactory: () => stubClient({ '/accounts': ACCOUNTS }, calls),
      env: { PROPDAO_EXECUTION_ENABLED: 'true', PROPDAO_EXECUTION_AUTHORISED: 'true' },
    });
    // closePosition is supported, but modifyOrder is not exposed here at all;
    // the guard is that an unknown capability name is refused, not attempted.
    const result = await provider.gatedWriteTest('modifyOrder', 'prop-abc123');
    expect(result.executed).toBe(false);
    expect(isFailure(result) ? result.code : 'UNEXPECTED_SUCCESS').toBe('CAPABILITY_UNSUPPORTED');
    expect(calls).toHaveLength(0);
  });

  test('exposes a non-secret policy status', () => {
    const status = adapter('pd_live_x000000000000000000000').policyStatus();
    expect(status.enabled).toBe(false);
    expect(status.capabilities.modifyOrder).toBe(false);
    expect(JSON.stringify(status)).not.toContain('pd_live');
  });
});