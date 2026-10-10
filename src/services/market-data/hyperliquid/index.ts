/**
 * HYPERLIQUID MARKET DATA — public surface.
 */

export {
  HyperliquidClient,
  HyperliquidError,
  hyperliquidClient,
  parseMetaAndAssetCtxs,
  parseAssetContexts,
  intervalToMs,
} from './HyperliquidClient';
export type {
  HyperliquidCandle,
  HyperliquidAssetContext,
  HyperliquidMarketSnapshot,
  HyperliquidClientOptions,
  HyperliquidErrorCode,
} from './HyperliquidClient';

export {
  HyperliquidMarketDataProvider,
  hyperliquidProvider,
  resetHyperliquidCatalogue,
} from './HyperliquidMarketDataProvider';

export {
  MARKET_CATEGORIES,
  HYPERLIQUID_DEXES,
  HYPERLIQUID_INTERVALS,
  INTERVAL_MAP,
  UI_TIMEFRAMES,
  DEFAULT_MARKET_UNIVERSE,
  DEFAULT_UNIVERSE_BY_CATEGORY,
  CURRENCY_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  INDEX_INSTRUMENTS,
  classifyMarket,
  displayNameFor,
  decimalsFor,
  priceDigitsFor,
  normaliseMarket,
  toMarketSymbol,
  tradableMarkets,
  searchMarkets,
  partitionForCategory,
  canonicalInstrument,
} from './MarketCatalog';
export type {
  NormalisedMarket,
  NormaliseMarketInput,
  HyperliquidDex,
  HyperliquidInterval,
} from './MarketCatalog';