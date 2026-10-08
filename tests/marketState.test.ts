import { describe, test, expect } from 'bun:test';
import {
  MarketStateStore,
  MemoryMarketStatePersistence,
} from '../src/services/market-data/MarketStateStore';
import type {
  MarketDataProvider,
  MarketQuote,
  Candle,
} from '../src/services/market-data/MarketDataProvider';

/**
 * The point of MarketStateStore is that N GOATs on one symbol cost ONE fetch
 * and ONE indicator computation, not N. These tests prove that, plus the
 * degradation and timer-lifecycle behaviour that a shared cache makes
 * load-bearing.
 */

const SYMBOL = 'EUR/USD';

function candles(count: number): Candle[] {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => ({
    time: base + i * 3_600_000,
    open: 1.1 + i * 0.0001,
    high: 1.101 + i * 0.0001,
    low: 1.099 + i * 0.0001,
    close: 1.1005 + i * 0.0001,
    volume: 1000 + i,
  }));
}

function quote(mid = 1.12): MarketQuote {
  return {
    symbol: SYMBOL,
    bid: mid - 0.00003,
    ask: mid + 0.00003,
    mid,
    spread: 0.00006,
    change24h: 0,
    change24hPct: 0,
    high24h: mid + 0.002,
    low24h: mid - 0.002,
    timestamp: Date.now(),
  };
}

interface CountingProvider extends MarketDataProvider {
  quoteCalls: number;
  candleCalls: number;
}

function makeProvider(
  fail = false,
): CountingProvider {
  let quoteCalls = 0;
  let candleCalls = 0;

  const provider: CountingProvider = {
    name: 'counting',
    dataMode: 'LIVE',
    quoteCalls: 0,
    candleCalls: 0,
    async getSymbols() {
      return [];
    },
    getMarketMetadata() {
      return undefined;
    },
    async getQuote(_symbol?: string) {
      quoteCalls += 1;
      provider.quoteCalls = quoteCalls;
      if (fail) throw new Error('provider down');
      return quote();
    },
    async getQuotes(symbols: string[]) {
      return Promise.all(symbols.map((s) => provider.getQuote(s)));
    },
    async getCandles(
      _symbol?: string,
      _timeframe?: string,
      _count?: number,
    ) {
      candleCalls += 1;
      provider.candleCalls = candleCalls;
      if (fail) throw new Error('provider down');
      return candles(80);
    },
    subscribeQuotes() {
      return () => {};
    },
  };

  return provider;
}

const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, ms));

describe('MarketStateStore — de-duplication', () => {
  test('five concurrent readers cause ONE fetch, not five', async () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, { ttlMs: 10_000 });

    await Promise.all([
      store.getState(SYMBOL),
      store.getState(SYMBOL),
      store.getState(SYMBOL),
      store.getState(SYMBOL),
      store.getState(SYMBOL),
    ]);

    expect(provider.quoteCalls).toBe(1);
    expect(provider.candleCalls).toBe(1);
    expect(store.stats.inflightCollapses).toBe(4);
  });

  test('a second read inside the TTL is served from cache', async () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, { ttlMs: 10_000 });

    await store.getState(SYMBOL);
    const second = await store.getState(SYMBOL);

    expect(provider.quoteCalls).toBe(1);
    expect(second.expired).toBe(false);
    expect(store.stats.cacheHits).toBeGreaterThanOrEqual(1);
  });

  test('an expired snapshot refetches', async () => {
    const provider = makeProvider();
    let now = 1_000;
    const store = new MarketStateStore(provider, {
      ttlMs: 500,
      now: () => now,
    });

    await store.getState(SYMBOL);
    now += 200;
    await store.getState(SYMBOL);
    expect(provider.quoteCalls).toBe(1);

    now += 1_000;
    await store.getState(SYMBOL);
    expect(provider.quoteCalls).toBe(2);
  });

  test('indicators are computed once and reused across readers', async () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, { ttlMs: 10_000 });

    const a = await store.getState(SYMBOL);
    const b = await store.getState(SYMBOL);

    // Same object identity => the second reader did not recompute.
    expect(b.indicators).toBe(a.indicators);
    expect(a.indicators?.ema20).toBeGreaterThan(0);
    expect(a.indicators?.rsi14).toBeGreaterThanOrEqual(0);
  });

  test('timeframes are cached separately', async () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, { ttlMs: 10_000 });

    await store.getState(SYMBOL, '15m');
    await store.getState(SYMBOL, '1h');

    expect(provider.quoteCalls).toBe(2);
  });
});

describe('MarketStateStore — failure handling', () => {
  test('a provider outage degrades to the last good snapshot, never blanks it', async () => {
    const provider = makeProvider();
    let fail = false;
    const original = provider.getCandles.bind(provider);
    provider.getCandles = async () => {
      if (fail) throw new Error('provider down');
      return original();
    };

    let now = 1_000;
    const store = new MarketStateStore(provider, {
      ttlMs: 500,
      now: () => now,
    });

    const good = await store.getState(SYMBOL);
    expect(good.degraded).toBe(false);

    fail = true;
    now += 5_000;
    const degraded = await store.getState(SYMBOL);

    // Real data is retained and honestly flagged, rather than discarded.
    expect(degraded.degraded).toBe(true);
    expect(degraded.error).toContain('provider down');
    expect(degraded.quote?.mid).toBe(good.quote?.mid);
    expect(degraded.indicators).toBe(good.indicators);
  });

  test('a cold-start failure still returns a usable shape', async () => {
    const provider = makeProvider(true);
    const store = new MarketStateStore(provider, { ttlMs: 10_000 });

    const state = await store.getState(SYMBOL);

    expect(state.degraded).toBe(true);
    expect(state.quote).toBeNull();
    expect(state.candles).toEqual([]);
  });
});

describe('MarketStateStore — persistence seam', () => {
  test('snapshots are written through to persistence', async () => {
    const provider = makeProvider();
    const persist = new MemoryMarketStatePersistence();
    const store = new MarketStateStore(provider, {
      ttlMs: 10_000,
      persist,
    });

    await store.getState(SYMBOL);
    await sleep(5);

    const restored = await persist.load('EUR/USD::15m');
    expect(restored).not.toBeNull();
    expect(restored?.candles.length).toBe(80);
  });

  test('a persisted snapshot hydrates but is marked expired so it is refreshed', async () => {
    const provider = makeProvider();
    const persist = new MemoryMarketStatePersistence();
    const store = new MarketStateStore(provider, {
      ttlMs: 10_000,
      persist,
    });

    await store.getState(SYMBOL);
    await sleep(5);

    // A brand-new store, as after a process restart.
    const restarted = new MarketStateStore(provider, {
      ttlMs: 10_000,
      persist,
    });

    const hydrated = await restarted.hydrate(SYMBOL);

    expect(hydrated).not.toBeNull();
    expect(hydrated?.expired).toBe(true);

    // And the next read refetches rather than trusting stale state.
    const fresh = await restarted.getState(SYMBOL);
    expect(fresh.expired).toBe(false);
  });
});

describe('MarketStateStore — subscription lifecycle', () => {
  test('many subscribers share ONE poll loop per symbol', () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, {
      ttlMs: 10_000,
      pollIntervalMs: 5_000,
    });

    const unsubs = [
      store.subscribe(SYMBOL, () => {}),
      store.subscribe(SYMBOL, () => {}),
      store.subscribe(SYMBOL, () => {}),
      store.subscribe(SYMBOL, () => {}),
    ];

    expect(store.activeSubscribers()).toBe(4);
    // Four GOATs must not mean four timer loops.
    expect(store.activePollers()).toBe(1);

    store.stop();
  });

  test('the poll loop stops when the last subscriber leaves (no timer leaks)', () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, {
      ttlMs: 10_000,
      pollIntervalMs: 5_000,
    });

    const a = store.subscribe(SYMBOL, () => {});
    const b = store.subscribe(SYMBOL, () => {});

    expect(store.activePollers()).toBe(1);

    a();
    expect(store.activePollers()).toBe(1);

    b();
    expect(store.activePollers()).toBe(0);
    expect(store.activeSubscribers()).toBe(0);

    store.stop();
  });

  test('a throwing subscriber cannot break the others', async () => {
    const provider = makeProvider();
    const store = new MarketStateStore(provider, {
      ttlMs: 10_000,
      pollIntervalMs: 10,
    });

    let good = 0;

    store.subscribe(SYMBOL, () => {
      throw new Error('bad subscriber');
    });
    store.subscribe(SYMBOL, () => {
      good += 1;
    });

    await store.getState(SYMBOL);
    await sleep(40);

    expect(good).toBeGreaterThan(0);
    store.stop();
  });
});
