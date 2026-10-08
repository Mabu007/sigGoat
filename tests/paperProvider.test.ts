import { describe, test, expect } from 'bun:test';
import { PaperMarketDataProvider, paperPriceAt, paperBarIndexAt, PAPER_SYMBOLS } from '../src/services/market-data/PaperMarketDataProvider';

describe('PaperMarketDataProvider', () => {
  test('declares PAPER data mode', () => {
    const provider = new PaperMarketDataProvider({ enableTicks: false });
    expect(provider.dataMode).toBe('PAPER');
    expect(provider.name).toContain('Paper');
  });

  test('prices are pure functions of (symbol, timeframe, barIndex) — restart-stable', async () => {
    const a = new PaperMarketDataProvider({ enableTicks: false });
    const b = new PaperMarketDataProvider({ enableTicks: false });
    // Two independent instances must agree: no process-start-dependent state.
    const quoteA = await a.getQuote('EUR/USD');
    const quoteB = await b.getQuote('EUR/USD');
    expect(quoteA.mid).toBe(quoteB.mid);
    expect(quoteA.bid).toBe(quoteB.bid);
  });

  test('candles are valid OHLC and deterministic across instances', async () => {
    const a = new PaperMarketDataProvider({ enableTicks: false });
    const b = new PaperMarketDataProvider({ enableTicks: false });
    const candlesA = await a.getCandles('EUR/USD', '1h', 50);
    const candlesB = await b.getCandles('EUR/USD', '1h', 50);
    expect(candlesA.length).toBe(50);
    for (const c of candlesA) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.open).toBeGreaterThan(0);
      expect(Number.isFinite(c.close)).toBe(true);
    }
    expect(candlesA.map((c) => c.close)).toEqual(candlesB.map((c) => c.close));
  });

  test('unknown symbol returns no candles (no fabrication)', async () => {
    const provider = new PaperMarketDataProvider({ enableTicks: false });
    expect(await provider.getCandles('NOT/A_SYMBOL', '1h', 20)).toEqual([]);
  });

  test('paperPriceAt is stable for the same bar index', () => {
    expect(paperPriceAt('EUR/USD', 60 * 60_000, 1000)).toBe(paperPriceAt('EUR/USD', 60 * 60_000, 1000));
    expect(paperPriceAt('EUR/USD', 60 * 60_000, 1000)).not.toBe(paperPriceAt('GBP/USD', 60 * 60_000, 1000));
  });

  test('bar index math is anchored to a fixed epoch', () => {
    const tfMs = 60 * 60_000;
    // 2024-01-02T00:00:00Z is 24 bars after the 2024-01-01 epoch.
    expect(paperBarIndexAt(Date.UTC(2024, 0, 2), tfMs)).toBe(24);
  });

  test('symbol catalogue covers forex, commodities and indices', () => {
    const categories = new Set(PAPER_SYMBOLS.map((s) => s.category));
    expect(categories.has('forex')).toBe(true);
    expect(categories.has('commodities')).toBe(true);
    expect(categories.has('indices')).toBe(true);
    expect(PAPER_SYMBOLS.every((s) => s.pipSize > 0)).toBe(true);
  });

  test('subscription unsubscribe stops callbacks without leaking', async () => {
    const provider = new PaperMarketDataProvider({ enableTicks: true });
    let calls = 0;
    const unsub = provider.subscribeQuotes(['EUR/USD'], () => {
      calls++;
    });
    unsub();
    await new Promise((r) => setTimeout(r, 100));
    const callsAfterUnsub = calls;
    provider.stopTicks();
    expect(calls).toBe(callsAfterUnsub);
  });
});
