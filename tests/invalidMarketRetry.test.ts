/**
 * REGRESSION: AN INVALID MARKET CANNOT RETRY FOREVER
 * ===================================================
 *
 * The production symptom this file pins down:
 *
 *   [market-state] EUR/USD 15m degraded: "EUR/USD" is not a market
 *   Hyperliquid lists.
 *
 * repeated indefinitely, because three layers all trusted a persisted symbol
 * from a previous provider:
 *
 *   1. `restoreRuntimes` never rewrote stale persisted markets;
 *   2. `GoatDurableObject.attachMarketListeners` opened a poll loop for the
 *      symbol regardless of whether the venue listed it;
 *   3. a wake that failed on the symbol kept it in the watch list and
 *      retried it on every scheduled tick.
 *
 * These tests assert the REPLACEMENT behaviour: stale markets are migrated,
 * unlisted markets never receive a poll loop, a failed wake retires the stale
 * symbol (keeping the valid ones), and — when the provider proves a symbol
 * valid again — the GOAT recovers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  GoatDurableObject,
  isUnlistedMarketError,
} from '../src/services/durable-object/GoatDurableObject';
import { MarketStateStore } from '../src/services/market-data/MarketStateStore';
import {
  MarketDataUnavailableError,
  type MarketDataProvider,
  type Candle,
  type MarketQuote,
  type MarketSymbol,
  type DataMode,
} from '../src/services/market-data/MarketDataProvider';
import type { FundGoat, TradingSkill } from '../src/types';
import type { ReasoningGateway } from '../src/server/reasoningGateway';

/* ------------------------------------------------------------------ */
/* Fake provider: listing is a switch, so "becomes valid" is testable  */
/* ------------------------------------------------------------------ */

function symbolFor(name: string): MarketSymbol {
  return {
    symbol: name,
    name,
    category: 'crypto',
    baseCurrency: name,
    quoteCurrency: 'USD',
    pipSize: 0,
    digits: 2,
    minSpread: 0,
  };
}

function quoteFor(name: string): MarketQuote {
  return {
    symbol: name,
    bid: 100,
    ask: 101,
    mid: 100.5,
    spread: 1,
    change24h: 0,
    change24hPct: 0,
    high24h: 0,
    low24h: 0,
    timestamp: Date.now(),
  };
}

const NOT_LISTED = (symbol: string) =>
  new MarketDataUnavailableError(
    `"${symbol}" is not a market Hyperliquid lists. Search for it under Markets, or pick another instrument.`,
    symbol,
    'NOT_LISTED',
  );

class FakeProvider implements MarketDataProvider {
  readonly name = 'fake-provider';
  /**
   * PAPER on purpose: `GoatDurableObject` prewarms the NEWS service only for
   * LIVE providers, and a unit test must not reach the network.
   */
  readonly dataMode: DataMode = 'PAPER';

  /** Symbols the "venue" currently lists. Toggle to simulate listing changes. */
  listed = new Set<string>();
  /** Simulates the Hyperliquid provider's cold catalogue cache. */
  catalogueReady = true;

  /** Every getCandles call, in order — the retry-loop evidence. */
  candleCalls: string[] = [];
  quoteCalls: string[] = [];

  async getSymbols(): Promise<MarketSymbol[]> {
    // Warming: mirrors HyperliquidMarketDataProvider.refreshCatalogue.
    this.catalogueReady = true;
    return [...this.listed].map(symbolFor);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    this.quoteCalls.push(symbol);
    if (!this.listed.has(symbol)) throw NOT_LISTED(symbol);
    return quoteFor(symbol);
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  async getCandles(symbol: string): Promise<Candle[]> {
    this.candleCalls.push(symbol);
    if (!this.listed.has(symbol)) throw NOT_LISTED(symbol);
    return [
      { time: Date.now(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ];
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    return this.listed.has(symbol) ? symbolFor(symbol) : undefined;
  }

  /** Present only when the fake models a real catalogue-loading provider. */
  catalogueLoaded(): boolean {
    return this.catalogueReady;
  }

  subscribeQuotes(): () => void {
    return () => undefined;
  }
}

/** Reasoning stub: wake tests fail before reasoning is ever reached. */
const reasoningStub = {
  hasKeyFor: async () => false,
  answerGoatQuestion: async () => 'stub',
} as unknown as ReasoningGateway;

function goatConfig(markets: string[]): FundGoat {
  return {
    id: 'goat_test_retry',
    userId: 'user_test',
    name: 'Retry Test GOAT',
    goal: 'Watch markets.',
    markets,
    skillIds: [],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '15m',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ------------------------------------------------------------------ */

describe('unlisted-market detection', () => {
  test('matches the provider error AND the store-wrapped message', () => {
    const direct = NOT_LISTED('EUR/USD');
    expect(isUnlistedMarketError(direct, direct.message)).toBe(true);

    const delisted = new MarketDataUnavailableError(
      '"EUR/USD" has been delisted by Hyperliquid and no longer has price data.',
      'EUR/USD',
      'DELISTED',
    );
    expect(isUnlistedMarketError(delisted, delisted.message)).toBe(true);

    // MarketStateStore wraps provider errors: the original text survives
    // inside `market data is UNAVAILABLE: <original>` but the error class
    // does NOT. The text pattern is what catches this shape.
    const wrapped = new Error(
      'market data is UNAVAILABLE: "EUR/USD" is not a market Hyperliquid lists. Search for it under Markets.',
    );
    expect(isUnlistedMarketError(wrapped, wrapped.message)).toBe(true);
  });

  test('a transient provider outage is NOT treated as an unlisted market', () => {
    const outage = new Error('market data is UNAVAILABLE: fetch failed: ECONNRESET');
    expect(isUnlistedMarketError(outage, outage.message)).toBe(false);

    const rateLimited = new Error('Hyperliquid returned HTTP 429: rate limit');
    expect(isUnlistedMarketError(rateLimited, rateLimited.message)).toBe(false);
  });
});

describe('subscription guard: no poll loop for an unlisted market', () => {
  test('a GOAT watching [EUR/USD, BTC] polls ONLY BTC — zero fetches for EUR/USD', async () => {
    const provider = new FakeProvider();
    provider.listed.add('BTC');

    const store = new MarketStateStore(provider, { pollIntervalMs: 60_000 });
    const goat = new GoatDurableObject(goatConfig(['EUR/USD', 'BTC']), [] as TradingSkill[], {
      reasoning: reasoningStub,
      marketProvider: provider,
      marketStateStore: store,
      autoStartScheduler: false,
    });

    await flush();

    // Exactly one poll loop — for the listed market only.
    expect(store.activePollers()).toBe(1);
    // The proof of no retry loop: EUR/USD is never requested at all.
    expect(provider.candleCalls).not.toContain('EUR/USD');
    expect(provider.quoteCalls).not.toContain('EUR/USD');
    expect(provider.quoteCalls).toContain('BTC');

    goat.destroy();
    store.stop();
  });

  test('a GOAT watching ONLY unlisted markets starts no poll loop at all', async () => {
    const provider = new FakeProvider(); // nothing listed
    const store = new MarketStateStore(provider, { pollIntervalMs: 60_000 });
    const goat = new GoatDurableObject(goatConfig(['EUR/USD', 'GBP/USD']), [], {
      reasoning: reasoningStub,
      marketProvider: provider,
      marketStateStore: store,
      autoStartScheduler: false,
    });

    await flush();

    // THE regression: before the guard, both symbols got 5-second pollers
    // that failed and logged on every tick, forever.
    expect(store.activePollers()).toBe(0);
    expect(store.stats.fetches).toBe(0);
    expect(provider.candleCalls).toEqual([]);
    expect(provider.quoteCalls).toEqual([]);
    // The state the user reads says why, rather than silently doing nothing.
    expect(goat.getState().dormancyReason).toContain('is listed by the data provider');
    expect(goat.getState().dormancyReason).toContain('EUR/USD');

    goat.destroy();
    store.stop();
  });

  test('recovers when the instrument becomes listed later', async () => {
    const provider = new FakeProvider();
    provider.listed.add('BTC');

    const store = new MarketStateStore(provider, { pollIntervalMs: 60_000 });
    const config = goatConfig(['EUR/USD', 'BTC']);
    const goat = new GoatDurableObject(config, [], {
      reasoning: reasoningStub,
      marketProvider: provider,
      marketStateStore: store,
      autoStartScheduler: false,
    });

    await flush();
    expect(store.activePollers()).toBe(1);
    expect(provider.candleCalls).not.toContain('EUR/USD');

    // The venue lists the instrument after all: a config reload (the path
    // `getOrCreate` takes on every subsequent request) re-evaluates and the
    // GOAT starts watching it — without any reset of its state.
    provider.listed.add('EUR/USD');
    goat.updateConfig(config, []);
    await flush();

    // The store path subscribes markets[0]; it is now the re-listed symbol.
    expect(store.activePollers()).toBe(1);
    expect(provider.quoteCalls).toContain('EUR/USD');
    expect(goat.getState().goatId).toBe('goat_test_retry'); // state preserved

    goat.destroy();
    store.stop();
  });

  test('a cold catalogue is warmed before filtering, not filtered against empty', async () => {
    const provider = new FakeProvider();
    provider.listed.add('BTC');
    provider.catalogueReady = false; // boot: cache not populated yet

    const store = new MarketStateStore(provider, { pollIntervalMs: 60_000 });
    const goat = new GoatDurableObject(goatConfig(['EUR/USD', 'BTC']), [], {
      reasoning: reasoningStub,
      marketProvider: provider,
      marketStateStore: store,
      autoStartScheduler: false,
    });

    // While the catalogue is cold nothing is subscribed (filtering against an
    // empty cache would wrongly mark BTC unlisted). Checked SYNCHRONOUSLY:
    // the warm promise's continuation has not run yet.
    expect(store.activePollers()).toBe(0);

    // getSymbols() resolves -> listener re-attaches -> BTC polls, EUR/USD
    // does not.
    await flush();
    expect(store.activePollers()).toBe(1);
    expect(provider.candleCalls).not.toContain('EUR/USD');
    expect(provider.quoteCalls).toContain('BTC');

    goat.destroy();
    store.stop();
  });
});

describe('wake path: a stale symbol is retired, not retried', () => {
  test('the first failed wake removes the unlisted market; later wakes never fetch it again', async () => {
    const provider = new FakeProvider();
    provider.listed.add('BTC');
    provider.listed.add('xyz:EUR');

    const store = new MarketStateStore(provider, { pollIntervalMs: 60_000 });
    const goat = new GoatDurableObject(goatConfig(['EUR/USD', 'BTC']), [], {
      reasoning: reasoningStub,
      marketProvider: provider,
      marketStateStore: store,
      autoStartScheduler: false,
    });

    // First wake targets markets[0] — the stale symbol.
    await goat.wake('test wake', 'MANUAL_REEVALUATE', 'EUR/USD');
    const failedCalls = provider.candleCalls.filter((c) => c === 'EUR/USD').length;
    expect(failedCalls).toBe(1);

    // The stale symbol is gone from the watch list; BTC survives.
    expect(goat.getConfig().markets).toEqual(['BTC']);

    // Second wake: the retired symbol is not requested again. BTC is briefly
    // delisted so this wake also stops at the market-data stage — the test
    // never reaches reasoning, keeping it network-free.
    provider.listed.delete('BTC');
    await goat.wake('second wake', 'MANUAL_REEVALUATE');
    expect(provider.candleCalls.filter((c) => c === 'EUR/USD').length).toBe(failedCalls);

    goat.destroy();
    store.stop();
  });
});

/* ------------------------------------------------------------------ */
/* Stale persisted-symbol migration                                    */
/* ------------------------------------------------------------------ */

describe('stale persisted market migration', () => {
  let migrateGoatMarkets: (goat: FundGoat) => FundGoat | null;
  let dataDir: string;
  let previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    previousEnv = {
      MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER,
      DATA_DIR: process.env.DATA_DIR,
      CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
      CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_KEY_ID,
    };
    process.env.MARKET_DATA_PROVIDER = 'paper';
    process.env.CREDENTIAL_ENCRYPTION_KEY =
      process.env.CREDENTIAL_ENCRYPTION_KEY ?? 'dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtdGVzdA==';
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID =
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID ?? 'test-key';
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-migrate-test-'));
    process.env.DATA_DIR = dataDir;

    ({ migrateGoatMarkets } = await import('../src/server/apiRouter'));
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const persistedGoat = (markets: string[]): FundGoat => ({
    id: 'goat_persisted',
    userId: 'user_1',
    name: 'Saved GOAT',
    goal: 'Watch the majors for sweeps.',
    markets,
    skillIds: ['skill_price_action'],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    schedule: { mode: 'INTERVAL', intervalMinutes: 60 },
    timeframe: '15m',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  test('rewrites retired BiQuote symbols to venue symbols', () => {
    const migrated = migrateGoatMarkets(persistedGoat(['EUR/USD', 'GBP/USD', 'XAU/USD', 'WTI']));
    expect(migrated?.markets).toEqual(['xyz:EUR', 'xyz:GBP', 'xyz:GOLD', 'xyz:CL']);
  });

  test('migrates ONLY the markets — identity, skills, schedule and status survive', () => {
    const original = persistedGoat(['EUR/USD', 'BTC']);
    const migrated = migrateGoatMarkets(original)!;
    expect(migrated.markets).toEqual(['xyz:EUR', 'BTC']);
    expect(migrated.id).toBe(original.id);
    expect(migrated.name).toBe(original.name);
    expect(migrated.goal).toBe(original.goal);
    expect(migrated.skillIds).toEqual(original.skillIds);
    expect(migrated.schedule).toEqual(original.schedule);
    expect(migrated.status).toBe(original.status);
    expect(migrated.timeframe).toBe(original.timeframe);
  });

  test('is idempotent: a migrated GOAT is returned as null on the next pass', () => {
    const first = migrateGoatMarkets(persistedGoat(['EUR/USD', 'GBP/USD']))!;
    expect(first).not.toBeNull();
    expect(migrateGoatMarkets(first)).toBeNull();
  });

  test('a GOAT already using venue symbols is untouched (null)', () => {
    expect(migrateGoatMarkets(persistedGoat(['BTC', 'xyz:GOLD']))).toBeNull();
  });

  test('never fabricates an alias for an unrecognised symbol', () => {
    const result = migrateGoatMarkets(persistedGoat(['SOME_UNKNOWN_MARKET']));
    // No invented replacement; the symbol is left exactly as stored.
    expect(result).toBeNull();
  });
});
