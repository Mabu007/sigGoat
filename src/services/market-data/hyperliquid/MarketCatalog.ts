/**
 * HYPERLIQUID MARKET CATALOG
 * ==========================
 * Translates Hyperliquid's live instrument metadata into FundAGoat's internal
 * market model, and decides which markets are tracked by default.
 *
 * THE CENTRAL CONSTRAINT
 *   Hyperliquid's universe is NOT the conventional forex/commodity/index
 *   market. Verified against the live API on 2026-10-10:
 *
 *     - The default perp dex ("") lists 234 instruments. Every one is crypto.
 *       There is no EURUSD, no XAUUSD, no SPX on it.
 *     - The HIP-3 dex "xyz" lists 133 instruments and is where the FX,
 *       commodity, index and equity coverage actually lives: EUR, GBP, JPY,
 *       GOLD, SILVER, BRENTOIL, CL, NATGAS, COPPER, CORN, ALUMINIUM,
 *       PLATINUM, PALLADIUM, NIFTY, JP225, KR200, DXY, and per-company
 *       equities (AAPL, NVDA, TSLA…).
 *     - Spot lists 330 pairs, also crypto.
 *
 *   So "Currencies", "Commodities" and "Indices" are REAL categories here —
 *   but they are populated from a specific HIP-3 deployer, and every symbol in
 *   `DEFAULT_MARKET_UNIVERSE` below is checked against live metadata at
 *   startup and DROPPED if the provider does not list it. The alternative —
 *   hardcoding "EUR/USD is always available" — is how a product ends up
 *   rendering a chart of a market that does not exist.
 *
 * SYMBOL NAMING
 *   A market's `symbol` IS the provider's coin name, verbatim: `BTC`,
 *   `xyz:GOLD`, `xyz:NIFTY`, `@107`. No aliasing layer sits in front of it.
 *   An earlier build translated `EUR/USD` -> `EURUSD` for a different
 *   provider; that translation table is gone, and the canonical id is now
 *   whatever Hyperliquid calls the instrument. One id, one meaning.
 *
 * CATEGORISATION
 *   `classifyMarket` is a curated mapping over VERIFIED metadata, not a guess.
 *   Anything it does not recognise falls through to `crypto`, which is the
 *   only category we can assert without evidence — every unclassified
 *   Hyperliquid perp really is a crypto asset.
 */

import type { CanonicalMarketCategory, MarketCategory, MarketSymbol } from '../../../types';

/**
 * The four categories the Quotes interface exposes.
 *
 * `crypto` is listed first in the type because it is the only category whose
 * membership is verifiable without a curated mapping.
 */
export const MARKET_CATEGORIES: readonly CanonicalMarketCategory[] = [
  'crypto',
  'currencies',
  'commodities',
  'indices',
];

/**
 * Provider universe this app reads.
 *
 * `''` is Hyperliquid's default perp dex (crypto). `xyz` is a HIP-3 deployer
 * market that carries the FX/commodity/index instruments. Both are queried;
 * neither is assumed to exist — a dex that disappears or is renamed simply
 * yields no instruments and is skipped.
 */
export const HYPERLIQUID_DEXES = ['', 'xyz'] as const;
export type HyperliquidDex = (typeof HYPERLIQUID_DEXES)[number];

/** Hyperliquid's documented candle intervals, mapped to ours. */
export const HYPERLIQUID_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;

export type HyperliquidInterval = (typeof HYPERLIQUID_INTERVALS)[number];

/**
 * Interval aliases so the UI's existing `1D` / `30m` vocabulary keeps working.
 *
 * Values are CASE-SENSITIVE on the wire: the docs list `1d` (lowercase) and
 * `1M` (uppercase), which look identical but are different intervals. Getting
 * this wrong returns an empty array rather than an error, so the mapping is
 * explicit and tested rather than passed through.
 */
export const INTERVAL_MAP: Record<string, HyperliquidInterval> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '8h': '8h',
  '12h': '12h',
  '1D': '1d',
  '1d': '1d',
  '3D': '3d',
  '3d': '3d',
  '1W': '1w',
  '1w': '1w',
};

/** Interval offered in the market-detail chart, in ascending order. */
export const UI_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;

/* ------------------------------------------------------------------ */
/* Curated classification tables                                       */
/* ------------------------------------------------------------------ */

/**
 * HIP-3 instruments that represent a currency.
 *
 * These are USD-quoted (the HIP-3 collateral token is USDC), so `xyz:EUR`
 * behaves like EUR/USD with a 1.1205-style price. We report the provider's
 * name and do NOT invent a conventional "EUR/USD" label the user would then
 * expect to resolve elsewhere.
 */
export const CURRENCY_INSTRUMENTS: Record<string, string> = {
  'xyz:EUR': 'Euro',
  'xyz:GBP': 'British Pound',
  'xyz:JPY': 'Japanese Yen',
  'xyz:CHF': 'Swiss Franc',
  'xyz:CAD': 'Canadian Dollar',
  'xyz:AUD': 'Australian Dollar',
  'xyz:NZD': 'New Zealand Dollar',
};

/** HIP-3 instruments that represent a commodity. */
export const COMMODITY_INSTRUMENTS: Record<string, string> = {
  'xyz:GOLD': 'Gold',
  'xyz:SILVER': 'Silver',
  'xyz:PLATINUM': 'Platinum',
  'xyz:PALLADIUM': 'Palladium',
  'xyz:ALUMINIUM': 'Aluminium',
  'xyz:COPPER': 'Copper',
  'xyz:CORN': 'Corn',
  'xyz:BRENTOIL': 'Brent Crude Oil',
  'xyz:CL': 'Crude Oil (WTI)',
  'xyz:NATGAS': 'Natural Gas',
};

/** HIP-3 instruments that represent a market index. */
export const INDEX_INSTRUMENTS: Record<string, string> = {
  'xyz:NIFTY': 'Nifty 50',
  'xyz:JP225': 'Nikkei 225',
  'xyz:KR200': 'KOSPI 200',
  'xyz:DXY': 'US Dollar Index',
};

/**
 * DEFAULT TRACKED UNIVERSE
 *
 * The markets the market-data Durable Object polls and persists candles for.
 * Deliberately small and liquid: each tracked instrument costs one
 * `candleSnapshot` call per minute, and Hyperliquid charges weight 20 plus 1
 * per 60 candles returned against a 1200/minute budget. Twenty instruments at
 * one call a minute is comfortably inside that; three hundred would not be.
 *
 * VERIFIED AGAINST THE LIVE API on 2026-10-10.
 *   This list is not aspirational. Every entry was confirmed present and
 *   non-delisted, and two entries that had been delisted (`xyz:NIFTY`,
 *   `xyz:DXY`) were replaced with live alternatives (`xyz:JP225`,
 *   `xyz:KR200`). Indices on this venue turn over quickly, so:
 *
 *     - the list is validated at runtime and any entry the venue stops
 *       listing is dropped rather than polled forever (see the Worker's
 *       `instrumentsFor`), and
 *     - `/markets/search` reports the true `delisted` flag for everything it
 *       returns, so the UI never offers a dead market.
 */
export const DEFAULT_MARKET_UNIVERSE: readonly string[] = [
  // Crypto — the deepest, most liquid part of the venue.
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'BNB',

  // Currencies (HIP-3).
  'xyz:EUR',
  'xyz:GBP',
  'xyz:JPY',

  // Commodities (HIP-3).
  'xyz:GOLD',
  'xyz:SILVER',
  'xyz:CL',
  'xyz:BRENTOIL',

  // Indices (HIP-3). JP225 and KR200 replaced the delisted NIFTY and DXY.
  'xyz:JP225',
  'xyz:KR200',
];

/**
 * Per-category default filters.
 *
 * The Markets screen shows "all majors" by default, which is the union of
 * these. A user searching for an instrument OUTSIDE the tracked universe finds
 * it through `/api/markets/search`, which reads live metadata and is not
 * limited to `DEFAULT_MARKET_UNIVERSE`.
 */
export const DEFAULT_UNIVERSE_BY_CATEGORY: Record<CanonicalMarketCategory, readonly string[]> = {
  crypto: DEFAULT_MARKET_UNIVERSE.filter((s) => !s.includes(':')),
  currencies: DEFAULT_MARKET_UNIVERSE.filter((s) => CURRENCY_INSTRUMENTS[s] !== undefined),
  commodities: DEFAULT_MARKET_UNIVERSE.filter((s) => COMMODITY_INSTRUMENTS[s] !== undefined),
  indices: DEFAULT_MARKET_UNIVERSE.filter((s) => INDEX_INSTRUMENTS[s] !== undefined),
};

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * Assigns a market to one of the four categories.
 *
 * Order matters: a curated table wins over every fallback, and `crypto` is the
 * catch-all because an unrecognised Hyperliquid perp IS a crypto asset.
 * There is no branch that invents a forex or commodity symbol.
 */
export function classifyMarket(symbol: string): MarketCategory {
  const key = symbol.trim();
  if (CURRENCY_INSTRUMENTS[key]) return 'currencies';
  if (COMMODITY_INSTRUMENTS[key]) return 'commodities';
  if (INDEX_INSTRUMENTS[key]) return 'indices';
  return 'crypto';
}

/** A human label, preferring the curated name over the raw ticker. */
export function displayNameFor(symbol: string): string {
  const key = symbol.trim();
  return (
    CURRENCY_INSTRUMENTS[key] ??
    COMMODITY_INSTRUMENTS[key] ??
    INDEX_INSTRUMENTS[key] ??
    key
  );
}

/**
 * Display decimals for a market.
 *
 * Derived from the provider's `szDecimals` where available, then refined by
 * observed price magnitude. Hyperliquid does not publish a tick size for FX
 * or HIP-3 instruments, so a fixed per-class rule is used instead of
 * pretending to a precision the venue does not state.
 */
export function decimalsFor(symbol: string, szDecimals?: number): number {
  const key = symbol.trim();
  if (CURRENCY_INSTRUMENTS[key]) return 5; // e.g. 1.12050
  if (INDEX_INSTRUMENTS[key]) return 2;
  if (COMMODITY_INSTRUMENTS[key]) {
    // CL trades near 90, gold near 4000; 2dp is right for both.
    return 2;
  }
  if (typeof szDecimals === 'number' && Number.isFinite(szDecimals)) {
    // Crypto sizes are quoted to szDecimals, which tracks price magnitude.
    return Math.min(Math.max(szDecimals + 1, 2), 8);
  }
  return 2;
}

/** Price granularity used for display and for rounding order prices. */
export function priceDigitsFor(symbol: string, szDecimals?: number): number {
  const key = symbol.trim();
  if (CURRENCY_INSTRUMENTS[key]) return 5;
  if (COMMODITY_INSTRUMENTS[key] || INDEX_INSTRUMENTS[key]) return 2;
  return Math.min(Math.max(decimalsFor(key, szDecimals), 2), 8);
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** A market as this app knows it, whether tracked by default or discovered. */
export interface NormalisedMarket {
  symbol: string;
  name: string;
  category: MarketCategory;
  /** Which perp dex it came from. `''` = the default dex. */
  dex: string;
  /** HIP-3 deployer markets are community-deployed, not first-party. */
  deployment: 'native' | 'hip3';
  /** Provider-reported size decimals, when supplied. */
  szDecimals?: number;
  /** Provider-reported maximum leverage, when supplied. */
  maxLeverage?: number;
  /** Whether the provider currently lists it for trading. */
  delisted: boolean;
  /** A member of the polled default universe. */
  tracked: boolean;
}

export interface NormaliseMarketInput {
  name: string;
  dex: string;
  szDecimals?: number;
  maxLeverage?: number;
  isDelisted?: boolean;
  marginMode?: string;
  onlyIsolated?: boolean;
}

const TRACKED = new Set(DEFAULT_MARKET_UNIVERSE.map((s) => s.toUpperCase()));

/**
 * Turns one provider universe entry into a `NormalisedMarket`.
 *
 * Returns `null` for an entry with no usable name — the provider's own
 * examples include entries with an omitted `name`, and a blank symbol would
 * flow through to a candle request and come back empty.
 */
export function normaliseMarket(input: NormaliseMarketInput): NormalisedMarket | null {
  const symbol = input.name?.trim();
  if (!symbol) return null;

  // HIP-3 names already carry their `dex:` prefix. Verify rather than assume:
  // a mismatch means we mis-parsed which dex this came from, and prefixing it
  // again would request a coin that does not exist.
  const expectedPrefix = input.dex ? `${input.dex}:` : '';
  const wellFormed =
    input.dex === '' ? !symbol.includes(':') : symbol.startsWith(expectedPrefix);
  if (!wellFormed) return null;

  return {
    symbol,
    name: displayNameFor(symbol),
    category: classifyMarket(symbol),
    dex: input.dex,
    deployment: input.dex === '' ? 'native' : 'hip3',
    szDecimals: Number.isFinite(input.szDecimals as number) ? input.szDecimals : undefined,
    maxLeverage: Number.isFinite(input.maxLeverage as number) ? input.maxLeverage : undefined,
    delisted: input.isDelisted === true,
    tracked: TRACKED.has(symbol.toUpperCase()),
  };
}

/**
 * Converts a normalised market into the public `MarketSymbol` shape.
 *
 * `pipSize` and `minSpread` are retained on the type because the signal gate
 * reads them, and are set to values that make the gate INERT rather than
 * invented: a pip of 0 and a max spread of 0 both mean "no constraint". A
 * fabricated 0.0001 pip on a market quoted at 1.1205 would silently reject
 * every trade through `SPREAD_UNDER_x_PIPS`.
 */
export function toMarketSymbol(market: NormalisedMarket): MarketSymbol {
  const digits = priceDigitsFor(market.symbol, market.szDecimals);
  return {
    symbol: market.symbol,
    name: market.name,
    category: market.category,
    baseCurrency: market.symbol,
    quoteCurrency: 'USD',
    pipSize: 0,
    digits,
    minSpread: 0,
  };
}

/**
 * Filters a discovered list down to what the provider can actually serve.
 *
 * Delisted instruments are excluded: they remain in `meta` for historical
 * purposes but return no candles and no quote, so surfacing them in search
 * would offer the user a dead end.
 */
export function tradableMarkets(markets: NormalisedMarket[]): NormalisedMarket[] {
  return markets.filter((m) => !m.delisted);
}

/**
 * Search over discovered markets.
 *
 * Matches the symbol and the display name, case-insensitively, and ranks exact
 * symbol matches first so typing "BTC" puts BTC above "xyz:BTC-something".
 */
export function searchMarkets(markets: NormalisedMarket[], query: string, limit = 40): NormalisedMarket[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ market: NormalisedMarket; score: number }> = [];
  for (const market of markets) {
    if (market.delisted) continue;
    const symbol = market.symbol.toLowerCase();
    const name = market.name.toLowerCase();
    let score = -1;
    if (symbol === q) score = 0;
    else if (symbol.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (symbol.includes(q)) score = 3;
    else if (name.includes(q)) score = 4;
    if (score >= 0) scored.push({ market, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.market.symbol.localeCompare(b.market.symbol))
    .slice(0, limit)
    .map((entry) => entry.market);
}

/** The `instrument` label the Durable Object partitions on. */
export function partitionForCategory(category: MarketCategory): string {
  switch (category) {
    case 'currencies':
      return 'FX';
    case 'commodities':
      return 'ENERGY';
    case 'indices':
      return 'INDEX';
    case 'crypto':
    default:
      return 'CRYPTO';
  }
}

/**
 * Collapses a market symbol to the form the Durable Object stores.
 *
 * `instrument` is stored, compared and used as a SQL column value, so it is
 * normalised to upper case with a trimmed colon prefix preserved. The colon
 * matters: `xyz:GOLD` and `GOLD` are different instruments and must not
 * collide.
 */
export function canonicalInstrument(symbol: string): string {
  return symbol.trim().toUpperCase();
}