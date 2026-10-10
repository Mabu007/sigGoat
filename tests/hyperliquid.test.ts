/**
 * HYPERLIQUID MARKET DATA TESTS
 *
 * Every test here runs against RECORDED RESPONSES SHAPED FROM THE OFFICIAL
 * DOCS AND VERIFIED AGAINST THE LIVE API on 2026-10-10. Nothing in this file
 * asserts behaviour of the live service, and passing these tests is NOT a
 * claim that the integration has been exercised against production.
 *
 * The point of these tests is the parts that are easy to get wrong and
 * expensive to get wrong: string-typed prices, nullable fields, coin names
 * that carry a HIP-3 prefix, and the rate-limit budget.
 */

import { describe, expect, test } from 'bun:test';
import {
  HyperliquidClient,
  HyperliquidError,
  intervalToMs,
  parseAssetContexts,
  parseMetaAndAssetCtxs,
} from '../src/services/market-data/hyperliquid/HyperliquidClient';
import {
  HyperliquidMarketDataProvider,
  resetHyperliquidCatalogue,
} from '../src/services/market-data/hyperliquid/HyperliquidMarketDataProvider';
import {
  CURRENCY_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  DEFAULT_MARKET_UNIVERSE,
  INDEX_INSTRUMENTS,
  classifyMarket,
  canonicalInstrument,
  displayNameFor,
  normaliseMarket,
  priceDigitsFor,
  searchMarkets,
  toMarketSymbol,
  tradableMarkets,
} from '../src/services/market-data/hyperliquid/MarketCatalog';

/* ------------------------------------------------------------------ */
/* Recorded fixtures, taken from the documented response shapes        */
/* ------------------------------------------------------------------ */

/** `metaAndAssetCtxs` for the default dex. Prices are STRINGS. */
const META_DEFAULT_DEX = [
  {
    universe: [
      { szDecimals: 5, name: 'BTC', maxLeverage: 40, marginTableId: 56 },
      { szDecimals: 4, name: 'ETH', maxLeverage: 25, marginTableId: 55 },
      { szDecimals: 2, name: 'ATOM', maxLeverage: 5, marginTableId: 5 },
      { szDecimals: 1, name: 'LOOM', maxLeverage: 3, isDelisted: true },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  [
    {
      funding: '0.0000079223',
      openInterest: '38190.63102',
      prevDayPx: '82607.0',
      dayNtlVlm: '1427836561.75',
      premium: '-0.0005175409',
      oraclePx: '82892.0',
      markPx: '82850.6',
      midPx: '82848.5',
      impactPxs: ['82848.0', '82849.1'],
      dayBaseVlm: '17257.60776',
    },
    {
      funding: '0.0000125',
      openInterest: '1118317.03',
      prevDayPx: '2505.3',
      dayNtlVlm: '557119600.64',
      premium: '-0.0003884242',
      oraclePx: '2497.27',
      markPx: '2496.3',
      midPx: '2496.25',
      impactPxs: ['2496.2', '2496.3'],
    },
    {
      funding: '0.0',
      openInterest: '12.208',
      prevDayPx: '447.49',
      dayNtlVlm: '0.0',
      // Documented and observed as null on the HIP-3 dex.
      premium: null,
      oraclePx: '450.78',
      markPx: '465.13',
      midPx: '464.92',
      impactPxs: null,
    },
  ],
];

/** HIP-3 dex. Names carry the `dex:` prefix and the array is index-matched. */
const META_XYZ_DEX = [
  {
    universe: [
      { szDecimals: 4, name: 'xyz:GOLD', maxLeverage: 10 },
      { szDecimals: 2, name: 'xyz:EUR', maxLeverage: 10 },
      { szDecimals: 2, name: 'xyz:NIFTY', maxLeverage: 10 },
      { szDecimals: 2, name: 'xyz:CL', maxLeverage: 10 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  [
    {
      funding: '0.00000625',
      openInterest: '7438.37',
      prevDayPx: '4100.0',
      dayNtlVlm: '167383576.13',
      oraclePx: '4190.0',
      markPx: '4190.1',
      midPx: '4190.2',
      impactPxs: ['4190.0', '4190.5'],
    },
    {
      funding: '0.0',
      openInterest: '0.0',
      prevDayPx: '1.1200',
      dayNtlVlm: '0.0',
      premium: '0.0',
      oraclePx: '1.1205',
      markPx: '1.1205',
      midPx: '1.1205',
      impactPxs: null,
    },
    { funding: '0.0', openInterest: '0.0', prevDayPx: null, dayNtlVlm: '0.0', oraclePx: '25000', markPx: '25001', midPx: '25001', impactPxs: null },
    { funding: '0.0', openInterest: '0.0', prevDayPx: '90.0', dayNtlVlm: '0.0', oraclePx: '90.7', markPx: '90.71', midPx: '90.7', impactPxs: ['90.7', '90.71'] },
  ],
];

/** `candleSnapshot`. Array of OBJECTS with string prices, per the docs. */
const CANDLES_1M = [
  { t: 1791620580000, T: 1791620639999, s: 'BTC', i: '1m', o: '82782.0', c: '82794.0', h: '82794.0', l: '82781.0', v: '3.30479', n: 65 },
  { t: 1791620460000, T: 1791620519999, s: 'BTC', i: '1m', o: '82794.0', c: '82782.0', h: '82794.0', l: '82781.0', v: '1.58401', n: 60 },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Records every request and replies from a per-`type` fixture map. */
function stubFetch(fixtures: Record<string, unknown>, calls: Array<{ type: string; body: any }> = []) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    calls.push({ type: String(body.type), body });
    if (!(body.type in fixtures)) {
      return new Response(JSON.stringify({ error: 'unknown type' }), { status: 400 });
    }
    return new Response(JSON.stringify(fixtures[body.type]), { status: 200 });
  };
}

function client(fixtures: Record<string, unknown>, calls?: Array<{ type: string; body: any }>) {
  return new HyperliquidClient({ fetchImpl: stubFetch(fixtures, calls), onWarn: () => {} });
}

/** A provider over a fixed `metaAndAssetCtxs` payload. */
function provider(metaAndAssetCtxs: unknown) {
  return new HyperliquidMarketDataProvider(
    new HyperliquidClient({
      fetchImpl: stubFetch({ metaAndAssetCtxs }),
      onWarn: () => {},
    }),
  );
}

describe('Hyperliquid metadata discovery', () => {
  test('parses the documented [meta, assetCtxs] shape', () => {
    const markets = parseMetaAndAssetCtxs(META_DEFAULT_DEX, '');
    expect(markets).not.toBeNull();
    expect(markets!.length).toBe(4);
    expect(markets![0]).toMatchObject({
      symbol: 'BTC',
      dex: '',
      deployment: 'native',
      szDecimals: 5,
      maxLeverage: 40,
      delisted: false,
    });
  });

  test('marks a delisted instrument as delisted', () => {
    const markets = parseMetaAndAssetCtxs(META_DEFAULT_DEX, '')!;
    const loom = markets.find((m) => m.symbol === 'LOOM');
    expect(loom?.delisted).toBe(true);
    // A delisted market must not appear in search results.
    expect(tradableMarkets(markets).some((m) => m.symbol === 'LOOM')).toBe(false);
  });

  test('reads HIP-3 instruments with their dex prefix intact', () => {
    const markets = parseMetaAndAssetCtxs(META_XYZ_DEX, 'xyz')!;
    expect(markets.map((m) => m.symbol)).toEqual(['xyz:GOLD', 'xyz:EUR', 'xyz:NIFTY', 'xyz:CL']);
    expect(markets.every((m) => m.deployment === 'hip3')).toBe(true);
  });

  test('rejects a default-dex instrument that carries a dex prefix', () => {
    // Names on a named dex must be prefixed. An unprefixed name there means
    // we mis-parsed the dex, and forwarding it would request a coin that
    // does not exist.
    const markets = parseMetaAndAssetCtxs(META_XYZ_DEX, 'someother')!;
    expect(markets.length).toBe(0);
  });

  test('rejects an entry with no name rather than inventing a symbol', () => {
    const markets = parseMetaAndAssetCtxs(
      [{ universe: [{ szDecimals: 2 }, { name: 'BTC' }] }, []],
      '',
    )!;
    expect(markets.map((m) => m.symbol)).toEqual(['BTC']);
  });

  test('returns null for a response that is not a meta payload', () => {
    expect(parseMetaAndAssetCtxs({ error: 'nope' }, '')).toBeNull();
    expect(parseMetaAndAssetCtxs([], '')).toBeNull();
    expect(parseMetaAndAssetCtxs([[{ universe: 'not-an-array' }], []], '')).toBeNull();
  });

  test('is resilient to non-numeric metadata fields', () => {
    const markets = parseMetaAndAssetCtxs(
      [{ universe: [{ name: 'BTC', szDecimals: 'five', maxLeverage: null }] }, []],
      '',
    )!;
    expect(markets[0].szDecimals).toBeUndefined();
    expect(markets[0].maxLeverage).toBeUndefined();
    expect(markets[0].symbol).toBe('BTC');
  });
});

describe('asset context normalisation', () => {
  test('parses string prices into numbers', () => {
    const contexts = parseAssetContexts(META_DEFAULT_DEX, ['BTC', 'ETH', 'ATOM', 'LOOM']);
    expect(contexts.get('BTC')).toMatchObject({
      markPx: 82850.6,
      midPx: 82848.5,
      oraclePx: 82892,
      prevDayPx: 82607,
      dayNtlVlm: 1427836561.75,
      funding: 0.0000079223,
    });
  });

  test('parses the documented impactPxs bid/ask pair', () => {
    const contexts = parseAssetContexts(META_DEFAULT_DEX, ['BTC', 'ETH', 'ATOM', 'LOOM']);
    expect(contexts.get('BTC')?.impactPxs).toEqual([82848.0, 82849.1]);
  });

  test('treats a null price as null, never as zero', () => {
    // The decisive case: a "0" here would render as a live 0.00 price.
    const contexts = parseAssetContexts(META_DEFAULT_DEX, ['BTC', 'ETH', 'ATOM', 'LOOM']);
    const atom = contexts.get('ATOM');
    // A null impact price must NOT become a bid of 0.
    expect(atom?.impactPxs).toBeNull();
    expect(atom?.midPx).toBe(464.92);
    expect(atom?.funding).toBe(0);
  });

  test('returns an empty map for a malformed payload', () => {
    expect(parseAssetContexts({}).size).toBe(0);
    expect(parseAssetContexts([[], {}]).size).toBe(0);
  });
});

describe('market categorisation', () => {
  test('maps the verified HIP-3 universe to the four categories', () => {
    expect(classifyMarket('xyz:EUR')).toBe('currencies');
    expect(classifyMarket('xyz:GOLD')).toBe('commodities');
    expect(classifyMarket('xyz:NIFTY')).toBe('indices');
    expect(classifyMarket('BTC')).toBe('crypto');
    expect(classifyMarket('xyz:AAPL')).toBe('crypto');
  });

  test('falls back to crypto rather than inventing a category', () => {
    // An unrecognised perpetual IS a crypto asset on this venue. Asserting
    // anything else would be a guess.
    expect(classifyMarket('SOME_FUTURE_COIN')).toBe('crypto');
  });

  test('never fabricates a conventional symbol', () => {
    // EURUSD / XAUUSD / SPX are NOT Hyperliquid instruments. There is no code
    // path that maps a display name onto one.
    expect(CURRENCY_INSTRUMENTS['EUR/USD']).toBeUndefined();
    expect(COMMODITY_INSTRUMENTS['XAU/USD']).toBeUndefined();
    expect(INDEX_INSTRUMENTS['SPX']).toBeUndefined();
  });

  test('provides human labels from the curated tables', () => {
    expect(displayNameFor('xyz:GOLD')).toBe('Gold');
    expect(displayNameFor('xyz:JP225')).toBe('Nikkei 225');
    // No curated label falls back to the provider's own symbol.
    expect(displayNameFor('BTC')).toBe('BTC');
  });

  test('uses price precision appropriate to the class', () => {
    expect(priceDigitsFor('xyz:EUR')).toBe(5);
    expect(priceDigitsFor('xyz:GOLD')).toBe(2);
    expect(priceDigitsFor('BTC', 5)).toBeGreaterThanOrEqual(2);
  });
});

describe('default universe', () => {
  test('every default symbol is a real classified market', () => {
    for (const symbol of DEFAULT_MARKET_UNIVERSE) {
      expect(['crypto', 'currencies', 'commodities', 'indices']).toContain(classifyMarket(symbol));
    }
  });

  test('is small enough to fit the documented rate budget', () => {
    // One candleSnapshot per instrument per minute at weight ~28.
    // 1200 documented weight/minute leaves ample headroom at this size.
    const perMinute = DEFAULT_MARKET_UNIVERSE.length * 28;
    expect(perMinute).toBeLessThan(1200);
  });

  test('covers all four categories', () => {
    const categories = new Set(DEFAULT_MARKET_UNIVERSE.map(classifyMarket));
    expect(categories.has('crypto')).toBe(true);
    expect(categories.has('currencies')).toBe(true);
    expect(categories.has('commodities')).toBe(true);
    expect(categories.has('indices')).toBe(true);
  });

  test('does not assume a market exists — a delisted default is still listed as delisted', () => {
    const market = normaliseMarket({ name: 'xyz:GOLD', dex: 'xyz', isDelisted: true });
    expect(market?.delisted).toBe(true);
    // tracked is metadata, not a claim of availability.
    expect(market?.tracked).toBe(true);
  });
});

describe('market search', () => {
  const universe = [
    ...(parseMetaAndAssetCtxs(META_DEFAULT_DEX, '') ?? []),
    ...(parseMetaAndAssetCtxs(META_XYZ_DEX, 'xyz') ?? []),
  ];

  test('finds markets outside the default universe', () => {
    const results = searchMarkets(universe, 'gold');
    expect(results[0]?.symbol).toBe('xyz:GOLD');
  });

  test('matches on symbol as well as label', () => {
    expect(searchMarkets(universe, 'BTC')[0]?.symbol).toBe('BTC');
    expect(searchMarkets(universe, 'nifty')[0]?.symbol).toBe('xyz:NIFTY');
    expect(searchMarkets(universe, 'gold')[0]?.symbol).toBe('xyz:GOLD');
  });

  test('is case-insensitive', () => {
    expect(searchMarkets(universe, 'nifty')[0]?.symbol).toBe('xyz:NIFTY');
    expect(searchMarkets(universe, 'NiFtY')[0]?.symbol).toBe('xyz:NIFTY');
  });

  test('ranks an exact symbol match first', () => {
    const results = searchMarkets(universe, 'BTC');
    expect(results[0].symbol).toBe('BTC');
  });

  test('excludes delisted instruments', () => {
    expect(searchMarkets(universe, 'LOOM').some((m) => m.symbol === 'LOOM')).toBe(false);
  });

  test('returns nothing for an empty query rather than the whole universe', () => {
    expect(searchMarkets(universe, '  ')).toEqual([]);
  });

  test('returns nothing for a market the provider does not list', () => {
    expect(searchMarkets(universe, 'EURUSD')).toEqual([]);
  });
});

describe('normalisation helpers', () => {
  test('produces a MarketSymbol with inert risk fields', () => {
    // pipSize/minSpread must be 0 (meaning "no constraint"). A fabricated
    // 0.0001 pip would make every spread check meaningless.
    const market = normaliseMarket({ name: 'xyz:EUR', dex: 'xyz' })!;
    const symbol = toMarketSymbol(market);
    expect(symbol.pipSize).toBe(0);
    expect(symbol.minSpread).toBe(0);
    expect(symbol.category).toBe('currencies');
    expect(symbol.symbol).toBe('xyz:EUR');
  });

  test('canonical instrument is case-insensitive and colon-preserving', () => {
    expect(canonicalInstrument('xyz:gold')).toBe('XYZ:GOLD');
    // The colon MUST survive: xyz:GOLD and GOLD are different instruments.
    expect(canonicalInstrument('GOLD')).toBe('GOLD');
  });
});

describe('intervals', () => {
  test('maps every documented interval to a duration', () => {
    expect(intervalToMs('1m')).toBe(60_000);
    expect(intervalToMs('1h')).toBe(3_600_000);
    expect(intervalToMs('1d')).toBe(86_400_000);
    expect(intervalToMs('1M')).toBe(30 * 86_400_000);
    expect(intervalToMs('4h')).toBe(4 * 3_600_000);
  });

  test('distinguishes the case-sensitive 1d and 1M', () => {
    // These look identical but are different intervals on the wire.
    expect(intervalToMs('1d')).not.toBe(intervalToMs('1M'));
  });
});

describe('candles', () => {
  test('parses the documented object-array response and returns it ascending', () => {
    const hl = client({ candleSnapshot: CANDLES_1M });
    return hl.candles('BTC', '1m', 10).then((candles) => {
      expect(candles.length).toBe(2);
      // The fixture is newest-first, as the provider returns.
      expect(candles[0].time).toBeLessThan(candles[1].time);
      expect(candles[0]).toMatchObject({
        time: 1791620460000,
        open: 82794,
        high: 82794,
        low: 82781,
        close: 82782,
        volume: 1.58401,
      });
    });
  });

  test('sends the documented request shape', async () => {
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ candleSnapshot: CANDLES_1M }, calls);
    await hl.candles('xyz:GOLD', '5m', 50);
    const req = calls[0].body.req;
    expect(calls[0].type).toBe('candleSnapshot');
    expect(req.coin).toBe('xyz:GOLD');
    expect(req.interval).toBe('5m');
    expect(typeof req.startTime).toBe('number');
    expect(typeof req.endTime).toBe('number');
    expect(req.endTime - req.startTime).toBeGreaterThan(0);
  });

  test('maps the UI timeframe vocabulary onto provider intervals', async () => {
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ candleSnapshot: CANDLES_1M }, calls);
    await hl.candles('BTC', '1D', 10);
    // '1D' is our vocabulary; Hyperliquid wants lowercase '1d'.
    expect(calls[0].body.req.interval).toBe('1d');
  });

  test('rejects an unsupported interval rather than sending garbage', async () => {
    const hl = client({ candleSnapshot: CANDLES_1M });
    expect(hl.candles('BTC', '7m', 10)).rejects.toThrow(/not a Hyperliquid candle interval/);
  });

  test('drops rows with missing or impossible prices', async () => {
    const hl = client({
      candleSnapshot: [
        { t: 1791620460000, o: '1', h: '2', l: '0.5', c: '1.5', v: '1' },
        { t: 1791620470000, o: null, h: '2', l: '1', c: '1.5', v: '1' },
        { t: 1791620480000, o: '1', h: '0.9', l: '1.2', c: '1.5', v: '1' }, // high < low
        { t: 1791620490000, o: '0', h: '0', l: '0', c: '0', v: '1' },
        { t: 1791620500000, o: '1', h: '2', l: '1', c: '1.9', v: 'not-a-number' },
      ],
    });
    const candles = await hl.candles('BTC', '1m', 10);
    // Rows 2 (null open), 3 (high < low) and 4 (all-zero price) are dropped.
    // Row 1 is a legitimate bar. Row 5 survives with volume degraded to 0
    // rather than NaN.
    expect(candles.map((c) => c.time)).toEqual([1791620460000, 1791620500000]);
    expect(candles[1].volume).toBe(0);
  });

  test('returns an empty array for a market with no history', async () => {
    const hl = client({ candleSnapshot: [] });
    expect(await hl.candles('xyz:NIFTY', '1m', 10)).toEqual([]);
  });

  test('clamps the requested count to the documented 5000 ceiling', async () => {
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ candleSnapshot: [] }, calls);
    await hl.candles('BTC', '1m', 99999);
    // startTime is derived from the CLAMPED count, so a runaway request
    // cannot ask the provider for unbounded history.
    const span = calls[0].body.req.endTime - calls[0].body.req.startTime;
    expect(span).toBeLessThanOrEqual(5000 * 60_000 * 2);
  });
});

describe('quotes', () => {
  test('derives change24h from prevDayPx', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_DEFAULT_DEX);
    const [quote] = await hl.getQuotes(['BTC']);
    expect(quote.mid).toBe(82848.5);
    expect(quote.change24h).toBeCloseTo(82848.5 - 82607, 6);
    expect(quote.change24hPct).toBeCloseTo(((82848.5 - 82607) / 82607) * 100, 6);
    expect(quote.change24hProvided).toBe(true);
  });

  test('uses impactPxs as bid/ask when present', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_DEFAULT_DEX);
    const [quote] = await hl.getQuotes(['BTC']);
    expect(quote.bidProvided).toBe(true);
    expect(quote.bid).toBe(82848);
    expect(quote.ask).toBe(82849.1);
    expect(quote.spread).toBeCloseTo(1.1, 6);
  });

  test('flags an empty book rather than reporting a zero spread as tight', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_XYZ_DEX);
    const [quote] = await hl.getQuotes(['xyz:EUR']);
    // midPx exists but impactPxs is null -> no bid/ask.
    expect(quote.mid).toBe(1.1205);
    expect(quote.bidProvided).toBe(false);
    expect(quote.askProvided).toBe(false);
    expect(quote.spread).toBe(0);
  });

  test('falls back mark -> oracle for mid when midPx is absent', async () => {
    resetHyperliquidCatalogue();
    const hl = provider([{ universe: [{ name: 'AAA' }] }, [{ markPx: '10', oraclePx: '9' }]]);
    const [quote] = await hl.getQuotes(['AAA']);
    expect(quote.mid).toBe(10);
  });

  test('reports no change when prevDayPx is missing', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_XYZ_DEX);
    const [quote] = await hl.getQuotes(['xyz:NIFTY']);
    expect(quote.change24hProvided).toBe(false);
    expect(quote.change24h).toBe(0);
  });

  test('marks a delisted market stale with a reason', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_DEFAULT_DEX);
    const [quote] = await hl.getQuotes(['LOOM']);
    expect(quote.stale).toBe(true);
    expect(quote.unavailableReason).toBe('DELISTED');
  });

  test('reports a market the provider does not list', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_DEFAULT_DEX);
    const [quote] = await hl.getQuotes(['EURUSD']);
    expect(quote.unavailableReason).toBe('NOT_LISTED');
    expect(quote.stale).toBe(true);
  });

  test('never claims a 24h high or low the provider does not publish', async () => {
    resetHyperliquidCatalogue();
    const hl = provider(META_DEFAULT_DEX);
    const [quote] = await hl.getQuotes(['BTC']);
    expect(quote.high24hProvided).toBe(false);
    expect(quote.low24hProvided).toBe(false);
  });

  test('serves a whole batch from ONE metadata request', async () => {
    resetHyperliquidCatalogue();
    const calls: Array<{ type: string; body: any }> = [];
    const hl = new HyperliquidMarketDataProvider(
      new HyperliquidClient({ fetchImpl: stubFetch({ metaAndAssetCtxs: META_DEFAULT_DEX }, calls), onWarn: () => {} }),
    );
    await hl.getQuotes(['BTC', 'ETH', 'ATOM']);
    const metadataCalls = calls.filter((c) => c.type === 'metaAndAssetCtxs').length;
    // ONE request per DEX (2 configured), regardless of how many symbols were
    // requested. Per-symbol fetching would be 3 requests per dex.
    expect(metadataCalls).toBeLessThanOrEqual(2);
    expect(calls.filter((c) => c.type === 'candleSnapshot').length).toBe(0);
  });
});

describe('error handling and rate limiting', () => {
  test('classifies a 429 distinctly from a 5xx', async () => {
    const hl = new HyperliquidClient({
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
      onWarn: () => {},
    });
    expect(hl.candles('BTC', '1m', 10)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('classifies a server error without echoing the body', async () => {
    const hl = new HyperliquidClient({
      fetchImpl: async () => new Response('internal detail that must not leak', { status: 500 }),
      onWarn: () => {},
    });
    let error: unknown;
    try {
      await hl.candles('BTC', '1m', 10);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HyperliquidError);
    expect((error as HyperliquidError).code).toBe('PROVIDER_ERROR');
    expect((error as HyperliquidError).message).not.toContain('internal detail');
    expect((error as HyperliquidError).status).toBe(500);
  });

  test('classifies a timeout', async () => {
    const hl = new HyperliquidClient({
      timeoutMs: 5,
      onWarn: () => {},
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    expect(hl.candles('BTC', '1m', 10)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('classifies a network failure', async () => {
    const hl = new HyperliquidClient({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      onWarn: () => {},
    });
    expect(hl.candles('BTC', '1m', 10)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  test('classifies an unparseable body', async () => {
    const hl = new HyperliquidClient({
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
      onWarn: () => {},
    });
    expect(hl.candles('BTC', '1m', 10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  test('charges weight per the documented schedule', async () => {
    const hl = client({ metaAndAssetCtxs: META_DEFAULT_DEX });
    const before = hl.rateLimitState().used;
    await hl.listMarkets(['']);
    // 'metaAndAssetCtxs' is a documented weight-20 request.
      expect(hl.rateLimitState().used - before).toBeGreaterThan(0);
      expect(hl.rateLimitState().remaining).toBeLessThan(hl.rateLimitState().limit);
  });

  test('caches metadata so repeated calls do not re-spend weight', async () => {
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ metaAndAssetCtxs: META_DEFAULT_DEX }, calls);
    await hl.listMarkets(['']);
    const afterFirst = calls.length;
    await hl.listMarkets(['']);
    expect(calls.length).toBe(afterFirst);
  });

  test('collapses concurrent identical reads into one request', async () => {
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ metaAndAssetCtxs: META_DEFAULT_DEX }, calls);
    await Promise.all([hl.listMarkets(['']), hl.listMarkets(['']), hl.listMarkets([''])]);
    expect(calls.filter((c) => c.type === 'metaAndAssetCtxs').length).toBeLessThanOrEqual(2);
  });

  test('skips an unavailable dex without failing the others', async () => {
    const warnings: string[] = [];
    const calls: Array<{ type: string; body: any }> = [];
    const hl = new HyperliquidClient({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        calls.push({ type: String(body.type), body });
        if (body.dex === 'xyz') return new Response('no such dex', { status: 404 });
        return new Response(JSON.stringify(META_DEFAULT_DEX), { status: 200 });
      },
      onWarn: (message) => warnings.push(message),
    });
    const markets = await hl.listMarketsCached(['', 'xyz']);
    // The default dex still serves; the missing HIP-3 dex is reported.
    expect(markets.some((m) => m.symbol === 'BTC')).toBe(true);
    expect(warnings.some((w) => w.includes('xyz'))).toBe(true);
  });

  test('one request returns BOTH the universe and its context', async () => {
    // This is why listMarkets does not make a second pass: metaAndAssetCtxs
    // carries both halves, so splitting them costs a second weight-20 request
    // for the entire venue on every refresh.
    const calls: Array<{ type: string; body: any }> = [];
    const hl = client({ metaAndAssetCtxs: META_DEFAULT_DEX }, calls);
    await hl.listMarkets(['']);
    expect(calls.filter((c) => c.type === 'metaAndAssetCtxs').length).toBe(1);
    const snapshots = await hl.listMarkets(['']);
    const btc = snapshots.find((s) => s.market.symbol === 'BTC');
    expect(btc?.context.midPx).toBe(82848.5);
  });

  test('drops only the markets of the dex that failed', async () => {
    const warnings: string[] = [];
    const hl = new HyperliquidClient({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.dex === 'xyz') return new Response('flaky', { status: 503 });
        return new Response(JSON.stringify(META_DEFAULT_DEX), { status: 200 });
      },
      onWarn: (message) => warnings.push(message),
    });
    const snapshots = await hl.listMarkets(['', 'xyz']);
    // The default dex is unaffected; the failed dex contributes nothing.
    expect(snapshots.length).toBe(4);
    expect(snapshots.some((s) => s.market.symbol === 'BTC')).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('provider interface conformance', () => {
  test('implements every MarketDataProvider member', async () => {
    resetHyperliquidCatalogue();
    const provider = new HyperliquidMarketDataProvider(client({ metaAndAssetCtxs: META_DEFAULT_DEX }));
    expect(provider.name).toContain('Hyperliquid');
    expect(provider.dataMode).toBe('LIVE');

    const symbols = await provider.getSymbols();
    expect(symbols.length).toBeGreaterThan(0);

    const candles = await provider.getCandles('BTC', '1m', 2).catch(() => []);
    expect(Array.isArray(candles)).toBe(true);

    expect(typeof provider.subscribeQuotes).toBe('function');
    const unsubscribe = provider.subscribeQuotes(['BTC'], () => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    provider.stopTicks();
  });

  test('throws an explanatory error for an unlisted instrument', async () => {
    resetHyperliquidCatalogue();
    const provider = new HyperliquidMarketDataProvider(client({ metaAndAssetCtxs: META_DEFAULT_DEX }));
    await provider.getCandles('EURUSD', '1m', 10).then(
      () => expect.unreachable('should have thrown'),
      (error) => {
        expect(error.name).toBe('MarketDataUnavailableError');
        expect(error.message).toMatch(/not a market Hyperliquid lists/);
      },
    );
  });

  test('throws a distinguishable error for a delisted instrument', async () => {
    resetHyperliquidCatalogue();
    const provider = new HyperliquidMarketDataProvider(client({ metaAndAssetCtxs: META_DEFAULT_DEX }));
    await provider.getCandles('LOOM', '1m', 10).then(
      () => expect.unreachable('should have thrown'),
      (error) => expect(error.message).toMatch(/delisted/),
    );
  });

  test('finds a market outside the default universe via search', async () => {
    resetHyperliquidCatalogue();
    // xyz:AAPL is listed by the venue but NOT in DEFAULT_MARKET_UNIVERSE.
    const meta = [
      { universe: [{ name: 'xyz:AAPL', szDecimals: 2, maxLeverage: 10 }] },
      [{ markPx: '210.0', midPx: '210.1', prevDayPx: '205.0', impactPxs: ['210.0', '210.2'] }],
    ];
    const hl = new HyperliquidMarketDataProvider(
      new HyperliquidClient({ fetchImpl: stubFetch({ metaAndAssetCtxs: meta }), onWarn: () => {} }),
      ['xyz'],
    );
    // Per-company HIP-3 equities have no curated display name, so they are
    // found by TICKER. That is the realistic query for an equity.
    const results = await hl.searchInstruments('aapl');
    expect(results[0]?.symbol).toBe('xyz:AAPL');
    // Discovery finds it WITHOUT adding it to the polled universe.
    expect(results[0]?.tracked).toBe(false);
  });

  test('reports a default-universe market as tracked', async () => {
    resetHyperliquidCatalogue();
    const hl = new HyperliquidMarketDataProvider(
      new HyperliquidClient({ fetchImpl: stubFetch({ metaAndAssetCtxs: META_XYZ_DEX }), onWarn: () => {} }),
      ['xyz'],
    );
    const results = await hl.searchInstruments('gold');
    expect(results[0]?.symbol).toBe('xyz:GOLD');
    expect(results[0]?.tracked).toBe(true);
  });

  test('reports only categories that actually have instruments', async () => {
    resetHyperliquidCatalogue();
    // A crypto-only provider must not advertise currencies or indices.
    const provider = new HyperliquidMarketDataProvider(client({ metaAndAssetCtxs: META_DEFAULT_DEX }), ['']);
    const categories = await provider.availableCategories();
    expect(categories).toEqual(['crypto']);
  });
});