import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  BiQuoteMarketDataProvider,
} from '../src/services/market-data/BiQuoteMarketDataProvider';
import { calculateEMA, calculateRSI } from '../src/services/tracker-sdk/indicators';

/**
 * BiQuote provider tests.
 *
 * These run fully OFFLINE against a captured response fixture. The provider's
 * real risk is not "does fetch work" — it is silently mis-mapping the feed:
 * newest-first bars, always-zero volume, and symbol aliasing. Those corrupt
 * every indicator downstream while the app still looks healthy.
 *
 * Shape captured from a real biquote.io response (EURUSD, live).
 */

const TICK_FIXTURE = {
  symbol: 'EURUSD',
  bid: 1.1195,
  ask: 1.11956,
  last: 0,
  volume: 0,
  timestamp: '2026-10-08T16:26:36Z',
  high: 1.12266,
  low: 1.11715,
  direction: 'FLAT',
  dayDiffPercent: -0.0446,
  spread: 0.00006,
  mid: 1.11953,
  stale: false,
  quoteAgeSeconds: 0,
  marketState: 'open',
};

/** BiQuote returns bars NEWEST-FIRST. Order must be preserved on the wire. */
const OHLC_FIXTURE = {
  symbol: 'EURUSD',
  interval: '1h',
  bars: [
    { openTime: '2026-10-08T16:00:00Z', open: 1.11912, high: 1.12039, low: 1.11847, close: 1.11953, volume: 0, tickVolume: 2764, isOpen: true },
    { openTime: '2026-10-08T15:00:00Z', open: 1.12079, high: 1.12105, low: 1.11889, close: 1.11914, volume: 0, tickVolume: 5045, isOpen: false },
    { openTime: '2026-10-08T14:00:00Z', open: 1.11952, high: 1.12269, low: 1.11926, close: 1.12081, volume: 0, tickVolume: 5711, isOpen: false },
    { openTime: '2026-10-08T13:00:00Z', open: 1.11829, high: 1.12004, low: 1.11799, close: 1.11952, volume: 0, tickVolume: 5269, isOpen: false },
  ],
};

function stubFetch(provider: BiQuoteMarketDataProvider) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
  ) => {
    const url = String(input);

    if (url.includes('/ohlc')) {
      return { ok: true, status: 200, json: async () => OHLC_FIXTURE };
    }
    if (url.includes('/latest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ EURUSD: TICK_FIXTURE }),
      };
    }
    if (url.includes('/symbols')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { name: 'EURUSD', description: 'Euro vs US Dollar', type: 'Forex', digits: 5 },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => TICK_FIXTURE };
  };

  return provider;
}

/**
 * A fresh provider + fetch stub per test. A single module-level stub is not
 * enough: later tests replace globalThis.fetch, so an earlier test reading a
 * shared provider would see whichever stub ran last.
 */
let provider: BiQuoteMarketDataProvider;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  provider = stubFetch(new BiQuoteMarketDataProvider());
});

/**
 * Bun runs test files in one process, so a stubbed globalThis.fetch would
 * leak into every other suite. Always put the real one back.
 */
afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
});

describe('BiQuote provider — data mode', () => {
  test('declares LIVE data, never PAPER', () => {
    expect(provider.dataMode).toBe('LIVE');
    expect(provider.name).toContain('live');
  });
});

describe('BiQuote provider — tick mapping', () => {
  test('maps mid/bid/ask and reports the market as open', async () => {
    const quote = await provider.getQuote('EUR/USD');

    expect(quote.symbol).toBe('EUR/USD');
    expect(quote.mid).toBeCloseTo(1.11953, 5);
    expect(quote.spread).toBeCloseTo(0.00006, 5);
    expect(quote.stale).toBe(false);
    expect(quote.marketState).toBe('open');
  });

  test('derives change24h from dayDiffPercent', async () => {
    const quote = await provider.getQuote('EUR/USD');
    // mid * pct / 100
    expect(quote.change24h).toBeCloseTo(
      (1.11953 * -0.0446) / 100,
      6,
    );
    expect(quote.change24hPct).toBeCloseTo(-0.0446, 4);
  });

  test('a CLOSED market is flagged stale, not silently treated as live', async () => {
    const weekend = stubFetch(new BiQuoteMarketDataProvider());
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...TICK_FIXTURE,
        marketState: 'closed',
        stale: true,
        quoteAgeSeconds: 7200,
      }),
    });

    const quote = await weekend.getQuote('EUR/USD');

    expect(quote.stale).toBe(true);
    expect(quote.marketState).toBe('closed');
    expect(quote.mid).toBeGreaterThan(0);
  });

  test('UI symbol EUR/USD is aliased to the native EURUSD', async () => {
    let requested = '';
    const spy = stubFetch(new BiQuoteMarketDataProvider());
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
      requested = String(input);
      return { ok: true, status: 200, json: async () => TICK_FIXTURE };
    };

    await spy.getQuote('EUR/USD');
    expect(requested).toContain('EURUSD');
    expect(requested).not.toContain('EUR%2FUSD');
  });
});

describe('BiQuote provider — candle mapping', () => {
  test('REVERSES newest-first bars into ascending order', async () => {
    const candles = await provider.getCandles('EUR/USD', '1h', 10);

    expect(candles.length).toBe(4);

    for (let i = 1; i < candles.length; i += 1) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
    }

    // Oldest bar first, newest bar last.
    expect(candles[0].close).toBeCloseTo(1.11952, 5);
    expect(candles[3].close).toBeCloseTo(1.11953, 5);
  });

  test('uses tickVolume because volume is always zero on this feed', async () => {
    const candles = await provider.getCandles('EUR/USD', '1h', 10);

    // If `volume` were mapped instead, every bar would be 0.
    expect(candles.every((c) => c.volume === 0)).toBe(false);
    expect(candles[0].volume).toBe(5269);
  });

  test('indicators compute sensibly from live-shaped bars', async () => {
    const candles = await provider.getCandles('EUR/USD', '1h', 10);

    const ema = calculateEMA(candles, 3);
    const rsi = calculateRSI(candles, 14);

    expect(Number.isFinite(ema)).toBe(true);
    // 4 bars cannot fill a 14-period RSI, so the neutral default applies.
    expect(rsi).toBe(50);
  });

  test('1D timeframe maps onto the provider 1d interval', async () => {
    let requested = '';
    const spy = stubFetch(new BiQuoteMarketDataProvider());
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
      requested = String(input);
      return { ok: true, status: 200, json: async () => OHLC_FIXTURE };
    };

    await spy.getCandles('EUR/USD', '1D', 5);
    expect(requested).toContain('interval=1d');
  });
});

describe('BiQuote provider — batch quotes', () => {
  test('uses a REPEATED symbols param, not a comma list', async () => {
    let requested = '';
    const spy = stubFetch(new BiQuoteMarketDataProvider());
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
      requested = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => ({ EURUSD: TICK_FIXTURE }),
      };
    };

    await spy.getQuotes(['EUR/USD', 'XAU/USD']);

    expect(requested).toContain('symbols=EURUSD');
    expect(requested).toContain('symbols=XAUUSD');
    // The comma form silently returns a single symbol.
    expect(requested).not.toContain('symbols=EURUSD,XAUUSD');
  });
});
