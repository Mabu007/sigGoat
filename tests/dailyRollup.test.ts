import { describe, test, expect } from 'bun:test';
import {
  newIntradayState,
  applyQuote,
  applyCandle,
  recordEvent,
  rollUp,
  rollover,
  tradingDateFor,
  recapId,
  type IntradayState,
} from '../src/services/daily-rolling/DailyMarketRecap';
import { DailyMarketRollup } from '../src/services/daily-rolling/DailyMarketRollup';
import { InMemoryPersistence } from '../src/server/repositories';
import type { MarketQuote, Candle } from '../src/types';

/**
 * Daily recap risk boundaries: aggregation correctness, idempotency by trading
 * date, and that rollover clears ONLY ephemeral state.
 */

const MARKET = 'EUR/USD';
const DATE = '2026-10-08';

function quote(mid: number, extra: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: MARKET,
    bid: mid - 0.00003,
    ask: mid + 0.00003,
    mid,
    spread: 0.00006,
    change24h: 0,
    change24hPct: 0,
    high24h: mid + 0.002,
    low24h: mid - 0.002,
    timestamp: Date.UTC(2026, 9, 8, 12),
    ...extra,
  };
}

function candle(o: number, h: number, l: number, c: number): Candle {
  return {
    time: Date.UTC(2026, 9, 8),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  };
}

function state(): IntradayState {
  return newIntradayState(MARKET, DATE);
}

describe('intraday aggregation', () => {
  test('tracks open/high/low/close across a session', () => {
    let s = state();
    s = applyQuote(s, quote(1.1000));
    s = applyQuote(s, quote(1.1050));
    s = applyQuote(s, quote(1.0980));
    s = applyQuote(s, quote(1.1010));

    expect(s.open).toBeCloseTo(1.1, 5);
    expect(s.high).toBeCloseTo(1.105, 5);
    expect(s.low).toBeCloseTo(1.098, 5);
    expect(s.close).toBeCloseTo(1.101, 5);
  });

  test('replaying the same quote cannot corrupt high/low', () => {
    let s = state();
    s = applyQuote(s, quote(1.1050));
    const before = { ...s };
    s = applyQuote(s, quote(1.1000));
    s = applyQuote(s, quote(1.1000));

    expect(s.high).toBe(before.high);
  });

  test('an IN-PROGRESS bar is excluded so a recap cannot record an unprinted high', () => {
    let s = state();
    s = applyCandle(s, candle(1.1, 1.11, 1.099, 1.105), true);
    s = applyCandle(s, candle(1.105, 1.2, 1.104, 1.19), false);

    expect(s.high).toBeCloseTo(1.11, 5);
    expect(s.barCount).toBe(1);
  });

  test('events are recorded and bounded', () => {
    let s = state();
    for (let i = 0; i < 250; i += 1) {
      s = recordEvent(s, {
        at: i,
        kind: 'TRACKER_TRIGGERED',
        description: `event ${i}`,
      });
    }
    expect(s.events.length).toBeLessThanOrEqual(200);
  });
});

describe('daily recap', () => {
  test('produces deterministic facts without an AI call', () => {
    let s = state();
    s = applyQuote(s, quote(1.1000));
    s = applyQuote(s, quote(1.1060));
    s = applyQuote(s, quote(1.1020));

    const { recap, merged } = rollUp(s);

    expect(merged).toBe(false);
    expect(recap.id).toBe('EUR/USD:2026-10-08');
    expect(recap.open).toBeCloseTo(1.1, 5);
    expect(recap.high).toBeCloseTo(1.106, 5);
    expect(recap.low).toBeCloseTo(1.1, 5);
    expect(recap.close).toBeCloseTo(1.102, 5);
    expect(recap.change).toBeCloseTo(0.002, 5);
    expect(recap.trend).toBe('BULLISH');
    expect(recap.range).toBeCloseTo(0.006, 5);
  });

  test('a DOWN day is reported BEARISH, not forced bullish', () => {
    let s = state();
    s = applyQuote(s, quote(1.1000));
    s = applyQuote(s, quote(1.0950));

    expect(rollUp(s).recap.trend).toBe('BEARISH');
  });
});

describe('idempotency', () => {
  test('a double rollover produces ONE recap id', () => {
    let s = state();
    s = applyQuote(s, quote(1.1));

    const first = rollUp(s);
    const second = rollUp(s, first.recap);

    expect(second.recap.id).toBe(first.recap.id);
    expect(second.merged).toBe(true);
    expect(second.recap.revision).toBe(2);
  });

  test('re-running does NOT double-count events', () => {
    let s = state();
    s = applyQuote(s, quote(1.1));
    s = recordEvent(s, {
      at: 1000,
      kind: 'TRACKER_TRIGGERED',
      description: 'RSI crossed below 30',
    });

    const first = rollUp(s);
    const second = rollUp(s, first.recap);

    expect(second.recap.events).toHaveLength(1);
  });

  test('a re-run keeps the WIDER span rather than shrinking the day', () => {
    let first = state();
    first = applyQuote(first, quote(1.1));
    first = applyQuote(first, quote(1.11));
    const recap1 = rollUp(first).recap;

    // A later, narrower re-read of the same day.
    let second = state();
    second = applyQuote(second, quote(1.105));
    const recap2 = rollUp(second, recap1).recap;

    expect(recap2.high).toBeCloseTo(recap1.high, 5);
  });

  test('a SECOND rollover of an empty session cannot corrupt the day', () => {
    // Regression: after the first rollup the session is empty, and merging
    // those zeros used to overwrite open/close and destroy the record.
    let s = state();
    s = applyQuote(s, quote(1.1));
    s = applyQuote(s, quote(1.106));

    const first = rollUp(s);

    // A second rollover begins from a cleared session.
    const cleared = rollover(s, DATE);
    expect(cleared.open).toBeUndefined();

    const second = rollUp(cleared, first.recap);

    expect(second.merged).toBe(true);
    expect(second.recap.open).toBeCloseTo(first.recap.open, 5);
    expect(second.recap.close).toBeCloseTo(first.recap.close, 5);
    expect(second.recap.high).toBeCloseTo(first.recap.high, 5);
    expect(second.recap.low).toBeCloseTo(first.recap.low, 5);
    expect(second.recap.open).toBeGreaterThan(0);
  });

  test('a partial re-read keeps confirmed figures rather than zeroing them', () => {
    let s = state();
    s = applyQuote(s, quote(1.1));
    s = applyQuote(s, quote(1.11));
    const recap1 = rollUp(s).recap;

    // A session that somehow produced only a high, with no open/close.
    const partial = state();
    partial.high = 1.12;
    const recap2 = rollUp(partial, recap1).recap;

    expect(recap2.open).toBeCloseTo(recap1.open, 5);
    expect(recap2.close).toBeCloseTo(recap1.close, 5);
    expect(recap2.high).toBeCloseTo(1.12, 5);
  });

  test('a recap for a DIFFERENT date is not merged into the wrong day', () => {
    const recapA = rollUp(state()).recap;

    const nextDay = state();
    nextDay.tradingDate = '2026-10-09';
    const recapB = rollUp(nextDay, recapA);

    expect(recapB.merged).toBe(false);
    expect(recapB.recap.id).toBe('EUR/USD:2026-10-09');
  });
});

describe('rollover safety', () => {
  test('rollover clears ephemeral state for the new day', () => {
    let s = state();
    s = applyQuote(s, quote(1.1));
    s = recordEvent(s, { at: 1, kind: 'WAKE', description: 'x' });

    const next = rollover(s, '2026-10-09');

    expect(next.tradingDate).toBe('2026-10-09');
    expect(next.events).toHaveLength(0);
    expect(next.barCount).toBe(0);
    expect(next.open).toBeUndefined();
    expect(next.high).toBeUndefined();
  });

  test('rollover returns a NEW object, never a view onto the old state', () => {
    const s = state();
    const next = rollover(s, '2026-10-09');

    expect(next).not.toBe(s);
    next.events.push({ at: 1, kind: 'WAKE', description: 'x' });
    expect(s.events).toHaveLength(0);
  });
});

describe('trading date', () => {
  test('is stable and sortable in UTC', () => {
    expect(tradingDateFor(Date.UTC(2026, 9, 8, 0, 0, 1))).toBe('2026-10-08');
    expect(tradingDateFor(Date.UTC(2026, 9, 8, 23, 59, 59))).toBe('2026-10-08');
    // Just after midnight UTC is the next trading date, not the previous one.
    expect(tradingDateFor(Date.UTC(2026, 9, 9, 0, 0, 1))).toBe('2026-10-09');
  });

  test('the recap id embeds market and date', () => {
    expect(recapId('eur/usd', '2026-10-08')).toBe('EUR/USD:2026-10-08');
  });
});

describe('DailyMarketRollup service', () => {
  const liveSnapshot = (mid: number, at: number) => ({
    symbol: MARKET,
    timeframe: '15m',
    key: `${MARKET}:15m`,
    fetchedAt: at,
    lastUpdatedAt: at,
    status: 'LIVE' as const,
    expired: false,
    degraded: false,
    latestPrice: mid,
    quote: quote(mid, { timestamp: at }),
    // The newest bar is treated as in-progress by the service.
    candles: [candle(1.1, mid + 0.002, mid - 0.002, mid)],
    indicators: null,
    computeMs: 1,
  });

  test('DEGRADED data never reaches a durable recap', async () => {
    const persistence = new InMemoryPersistence();
    const service = new DailyMarketRollup({ recaps: persistence.recaps });

    service.observe({
      ...liveSnapshot(1.1, 1000),
      status: 'DEGRADED',
      degraded: true,
    });

    expect(service.activeSessions()[0]?.open).toBeUndefined();
    expect(service.stats.observations).toBe(0);
  });

  test('rollUpAll persists exactly one recap per market, twice over', async () => {
    const persistence = new InMemoryPersistence();
    let clock = Date.UTC(2026, 9, 8, 12);
    const service = new DailyMarketRollup({
      recaps: persistence.recaps,
      now: () => clock,
    });

    service.observe(liveSnapshot(1.1, clock));
    service.recordEvent(MARKET, 'TRACKER_TRIGGERED', 'RSI(14) below 30');

    const first = await service.rollUpAll();
    const second = await service.rollUpAll();

    expect(first).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.events).toHaveLength(1);
    expect(service.stats.rollups).toBe(2);
    expect(service.stats.rollupsMerged).toBe(1);

    const stored = await persistence.recaps.listByMarket(MARKET);
    expect(stored).toHaveLength(1);

    clock += 86_400_000;
  });

  test('a persistence failure keeps the session so a retry can still save it', async () => {
    const persistence = new InMemoryPersistence();
    const original = persistence.recaps.save.bind(persistence.recaps);
    let failNext = true;

    persistence.recaps.save = async (recap) => {
      if (failNext) throw new Error('disk full');
      return original(recap);
    };

    const service = new DailyMarketRollup({
      recaps: persistence.recaps,
      now: () => Date.UTC(2026, 9, 8, 12),
      log: () => {},
    });

    service.observe(liveSnapshot(1.1, 1));

    const failed = await service.rollUpMarket(MARKET);
    expect(failed).toBeNull();
    expect(service.stats.persistenceFailures).toBe(1);
    // Session survives, so nothing is lost.
    expect(service.activeSessions()[0]?.open).toBeCloseTo(1.1, 5);

    failNext = false;
    const ok = await service.rollUpMarket(MARKET);
    expect(ok).not.toBeNull();
  });

  test('a new trading day rolls up the previous one automatically', async () => {
    const persistence = new InMemoryPersistence();
    let clock = Date.UTC(2026, 9, 8, 23, 50);
    const service = new DailyMarketRollup({
      recaps: persistence.recaps,
      now: () => clock,
    });

    service.observe(liveSnapshot(1.1, clock));

    // Cross midnight: the next observe must persist yesterday first.
    clock = Date.UTC(2026, 9, 9, 0, 5);
    service.observe(liveSnapshot(1.2, clock));
    await new Promise((r) => setTimeout(r, 10));

    const recaps = await persistence.recaps.listByMarket(MARKET);
    expect(recaps.map((r) => r.tradingDate)).toContain('2026-10-08');
    expect(service.activeSessions()[0]?.tradingDate).toBe('2026-10-09');
  });
});
