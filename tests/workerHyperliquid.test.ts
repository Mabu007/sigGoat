/**
 * WORKER HYPERLIQUID PROVIDER TESTS
 *
 * Exercises the Durable Object's outbound path against recorded payloads
 * shaped from the official docs. The `globalThis.fetch` stub means no test
 * here touches the live API.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  parseCandleRow,
  fetchCandles,
  listAvailableInstruments,
  INGEST_INTERVAL,
} from '../worker/hyperliquid-provider';

/** Recorded `candleSnapshot` response: array of objects, string prices. */
const CANDLES = [
  { t: 1791620580000, T: 1791620639999, s: 'BTC', i: '1m', o: '82782.0', c: '82794.0', h: '82794.0', l: '82781.0', v: '3.30479', n: 65 },
  { t: 1791620460000, T: 1791620519999, s: 'BTC', i: '1m', o: '82794.0', c: '82782.0', h: '82794.0', l: '82781.0', v: '1.58401', n: 60 },
];

const ALL_PERP_METAS = [
  [
    {
      universe: [
        { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
        { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
        { name: 'LOOM', szDecimals: 1, isDelisted: true },
      ],
    },
    [{}, {}, {}],
  ],
  [
    {
      // HIP-3 names carry the dex prefix.
      universe: [{ name: 'xyz:GOLD' }, { name: 'xyz:EUR' }],
    },
    [{}, {}],
  ],
];

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; body: any }> = [];

/**
 * Replies per request `type`.
 *
 * `forcedStatus` lets a test exercise the error paths against a type that DOES
 * have a recorded payload, so the assertion is about the status handling and
 * not about the stub's own 400.
 */
function stubFetch(responses: Record<string, unknown>, forcedStatus?: number) {
  requests = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    if (forcedStatus !== undefined) {
      return new Response(JSON.stringify({ error: 'forced' }), { status: forcedStatus });
    }
    const key = String(body.type);
    if (!(key in responses)) {
      return new Response(JSON.stringify({ error: 'unknown' }), { status: 400 });
    }
    return new Response(JSON.stringify(responses[key]), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('candle row parsing', () => {
  test('parses the documented object shape with string prices', () => {
    const candle = parseCandleRow(CANDLES[0])!;
    expect(candle).toEqual({
      time: 1791620580000,
      open: 82782,
      high: 82794,
      low: 82781,
      close: 82794,
      volume: 3.30479,
    });
  });

  test('floors the open time to the minute', () => {
    const candle = parseCandleRow({ t: 1791620580999, o: '1', h: '2', l: '1', c: '1.5', v: '1' })!;
    expect(candle.time % 60_000).toBe(0);
    expect(candle.time).toBe(1791620580000);
  });

  test('rejects rows with missing prices', () => {
    expect(parseCandleRow({ t: 1, o: null, h: '2', l: '1', c: '1', v: '1' })).toBeNull();
    expect(parseCandleRow({ t: 1, o: '1', h: undefined, l: '1', c: '1', v: '1' })).toBeNull();
    expect(parseCandleRow({ t: null, o: '1', h: '2', l: '1', c: '1', v: '1' })).toBeNull();
  });

  test('rejects impossible bars rather than storing them', () => {
    // high < low is corrupt data; a zero price is not a price.
    expect(parseCandleRow({ t: 1, o: '1', h: '0.9', l: '1.2', c: '1', v: '1' })).toBeNull();
    expect(parseCandleRow({ t: 1, o: '0', h: '0', l: '0', c: '0', v: '1' })).toBeNull();
    expect(parseCandleRow({ t: 1, o: '-1', h: '2', l: '1', c: '1', v: '1' })).toBeNull();
  });

  test('treats missing volume as zero, not as missing', () => {
    const candle = parseCandleRow({ t: 1, o: '1', h: '2', l: '1', c: '1' })!;
    // A bar that did not trade is real; it is zero, not null.
    expect(candle.volume).toBe(0);
  });

  test('rejects a negative volume', () => {
    const candle = parseCandleRow({ t: 1, o: '1', h: '2', l: '1', c: '1', v: '-5' })!;
    expect(candle.volume).toBe(0);
  });

  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      expect(parseCandleRow(bad)).toBeNull();
    }
  });
});

describe('worker candle fetching', () => {
  test('sends the documented candleSnapshot request', async () => {
    stubFetch({ candleSnapshot: CANDLES });
    await fetchCandles('BTC');

    expect(requests[0].url).toBe('https://api.hyperliquid.xyz/info');
    expect(requests[0].body.type).toBe('candleSnapshot');
    expect(requests[0].body.req.coin).toBe('BTC');
    expect(requests[0].body.req.interval).toBe(INGEST_INTERVAL);
    expect(typeof requests[0].body.req.startTime).toBe('number');
    expect(requests[0].body.req.endTime - requests[0].body.req.startTime).toBeGreaterThan(0);
  });

  test('requests HIP-3 coins by their prefixed name', async () => {
    stubFetch({ candleSnapshot: [{ t: 1, o: '1', h: '2', l: '1', c: '1.5', v: '1', s: 'xyz:GOLD' }] });
    await fetchCandles('xyz:GOLD');
    // No aliasing: the venue's own name goes on the wire verbatim.
    expect(requests[0].body.req.coin).toBe('xyz:GOLD');
  });

  test('returns candles ASCENDING regardless of provider order', async () => {
    stubFetch({ candleSnapshot: CANDLES }); // newest-first
    const candles = await fetchCandles('BTC');
    expect(candles.length).toBe(2);
    expect(candles[0].time).toBeLessThan(candles[1].time);
  });

  test('drops unusable rows instead of failing the batch', async () => {
    stubFetch({
      candleSnapshot: [
        { t: 1, o: '1', h: '2', l: '1', c: '1.5', v: '1' },
        { t: 2, o: null, h: '2', l: '1', c: '1.5', v: '1' },
        { t: 3, o: '0', h: '0', l: '0', c: '0', v: '1' },
      ],
    });
    expect(await fetchCandles('BTC')).toHaveLength(1);
  });

  test('returns an empty array for a market with no history', async () => {
    stubFetch({ candleSnapshot: [] });
    expect(await fetchCandles('xyz:NIFTY')).toEqual([]);
  });

  test('throws on a provider error rather than returning a fake success', async () => {
    stubFetch({ candleSnapshot: CANDLES }, 500);
    await expect(fetchCandles('BTC')).rejects.toThrow(/Hyperliquid HTTP 500/);
  });

  test('throws distinctly on rate limiting', async () => {
    stubFetch({ candleSnapshot: CANDLES }, 429);
    await expect(fetchCandles('BTC')).rejects.toThrow(/rate limited/);
  });

  test('throws when the response is not an array', async () => {
    stubFetch({ candleSnapshot: { error: 'nope' } });
    await expect(fetchCandles('BTC')).rejects.toThrow(/did not return an array/);
  });
});

describe('universe reconciliation', () => {
  test('collects instrument names across every dex', async () => {
    stubFetch({ allPerpMetas: ALL_PERP_METAS });
    const names = await listAvailableInstruments();
    expect(names).not.toBeNull();
    // Both the default dex and the HIP-3 dex are represented.
    expect(names!.has('BTC')).toBe(true);
    expect(names!.has('XYZ:GOLD')).toBe(true);
    expect(names!.has('XYZ:EUR')).toBe(true);
  });

  test('includes a delisted instrument so callers can decide', async () => {
    stubFetch({ allPerpMetas: ALL_PERP_METAS });
    const names = await listAvailableInstruments();
    // Listing it is correct; the ingestion path drops it when no bars return.
    expect(names!.has('LOOM')).toBe(true);
  });

  test('returns null rather than an empty set when the read fails', async () => {
    stubFetch({ allPerpMetas: ALL_PERP_METAS }, 500);
    // An empty set would look like "the venue lists nothing" and empty the
    // tracked universe on a transient outage.
    expect(await listAvailableInstruments()).toBeNull();
  });

  test('returns null for a malformed payload', async () => {
    stubFetch({ allPerpMetas: { not: 'an array' } });
    expect(await listAvailableInstruments()).toBeNull();
  });
});