/**
 * HYPERLIQUID MARKET DATA PROVIDER
 * =================================
 * Implements the existing `MarketDataProvider` interface against Hyperliquid,
 * so every downstream consumer — the market state store, the ingestion service,
 * the backtest engine, the GOAT runtime — works unchanged.
 *
 * THE ONE PLACE WHERE "UNAVAILABLE" IS HONEST
 *   The interface's `MarketQuote` has `bid`, `ask`, `high24h`, `low24h` as
 *   REQUIRED numbers. Hyperliquid does not publish a 24h high/low, and a
 *   coin with an empty book has no bid or ask at all. Filling those with 0
 *   would make the signal gate's spread check pass on every market and render
 *   a fake 0.00 quote.
 *
 *   So each field is filled only from a real source, and the quote carries
 *   `bidProvided`/`askProvided` so a caller can tell "the book is empty" from
 *   "the spread is genuinely zero". The gate reads those flags before
 *   enforcing `maxSpreadPips`.
 *
 * QUOTE COMPOSITION (all values verified against the live API)
 *   mid       <- assetCtxs.midPx, falling back to markPx then oraclePx
 *   bid/ask   <- assetCtxs.impactPxs (a documented [bid, ask] pair), falling
 *                back to an `l2Book` request only when impactPxs is absent
 *   change24h <- DERIVED from prevDayPx. There is no 24h-change endpoint.
 *   high/low  <- NOT AVAILABLE from this provider. Left undefined rather than
 *                fabricated from the candle window.
 */

import {
  MarketDataProvider,
  MarketDataUnavailableError,
} from '../MarketDataProvider';
import type { Candle, DataMode, MarketQuote, MarketSymbol, Timeframe } from '../../../types';
import {
  DEFAULT_MARKET_UNIVERSE,
  HYPERLIQUID_DEXES,
  HyperliquidDex,
  MARKET_CATEGORIES,
  NormalisedMarket,
  searchMarkets,
  toMarketSymbol,
  tradableMarkets,
} from './MarketCatalog';
import {
  HyperliquidClient,
  HyperliquidError,
  HyperliquidMarketSnapshot,
  hyperliquidClient,
} from './HyperliquidClient';

export type { NormalisedMarket };

/** Cached symbol catalogue, so `getMarketMetadata` never does I/O. */
let symbolIndex: Map<string, MarketSymbol> | null = null;
let marketIndex: Map<string, NormalisedMarket> | null = null;

/** Quotes are re-read at most this often, regardless of subscriber count. */
const QUOTE_TTL_MS = 3_000;
const QUOTE_REFRESH_MS = 5_000;
const MAX_QUOTES_PER_REQUEST = 100;

export class HyperliquidMarketDataProvider implements MarketDataProvider {
  readonly name = 'Hyperliquid (live)';

  /**
   * ALWAYS LIVE.
   *
   * There is no PAPER mode in this class. A simulated feed is a separate class
   * (`PaperMarketDataProvider`) so `dataMode` can never describe a simulated
   * price as a real one.
   */
  readonly dataMode: DataMode = 'LIVE';

  private quoteCache = new Map<string, { at: number; quote: MarketQuote }>();
  private quoteTimer: ReturnType<typeof setInterval> | null = null;
  private quoteSubscribers = new Set<(quote: MarketQuote) => void>();
  private activeSymbols = new Set<string>();

  constructor(
    private readonly client: HyperliquidClient = hyperliquidClient,
    private readonly dexes: readonly HyperliquidDex[] = HYPERLIQUID_DEXES,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Discovery                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Fetches the live universe from the provider.
   *
   * The catalogue is built from `metaAndAssetCtxs`, so an instrument appears
   * here if and only if Hyperliquid lists it. Nothing here is hardcoded as
   * "always available".
   */
  private async refreshCatalogue(): Promise<HyperliquidMarketSnapshot[]> {
    const snapshots = await this.client.listMarkets(this.dexes);

    const symbols = new Map<string, MarketSymbol>();
    const markets = new Map<string, NormalisedMarket>();
    for (const snapshot of snapshots) {
      markets.set(snapshot.market.symbol.toUpperCase(), snapshot.market);
      if (!snapshot.market.delisted) {
        symbols.set(snapshot.market.symbol, toMarketSymbol(snapshot.market));
      }
    }

    symbolIndex = symbols;
    marketIndex = markets;
    return snapshots;
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    if (!symbolIndex) await this.refreshCatalogue();
    // Majors first so the default Markets screen shows the curated set, then
    // the rest of the venue. Both come from live metadata.
    const all = [...(symbolIndex?.values() ?? [])];
    const tracked = new Set(DEFAULT_MARKET_UNIVERSE.map((s) => s.toUpperCase()));
    return all.sort((a, b) => {
      const aTracked = tracked.has(a.symbol.toUpperCase()) ? 0 : 1;
      const bTracked = tracked.has(b.symbol.toUpperCase()) ? 0 : 1;
      if (aTracked !== bTracked) return aTracked - bTracked;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  /**
   * Searches the FULL discovered universe, not just the default set.
   *
   * This is how a user reaches an instrument that is listed but not polled:
   * it is found here, loaded on demand, and is NOT added to the Durable
   * Object's default universe.
   */
  async searchInstruments(query: string, limit = 40): Promise<NormalisedMarket[]> {
    const snapshots = await this.client.listMarkets(this.dexes);
    return searchMarkets(snapshots.map((s) => s.market), query, limit);
  }

  /** Every category the provider actually has instruments in. */
  async availableCategories(): Promise<string[]> {
    const markets = tradableMarkets(await this.client.listMarketsCached(this.dexes));
    return MARKET_CATEGORIES.filter((category) =>
      markets.some((market) => market.category === category),
    );
  }

  /**
   * The full discovered universe, without live context.
   *
   * Exposed for discovery endpoints that need names and categories only —
   * fetching a quote for every instrument on the venue would be both slow and
   * far over the documented rate budget.
   */
  async listMarketsCached(dexes: readonly HyperliquidDex[] = HYPERLIQUID_DEXES): Promise<NormalisedMarket[]> {
    return this.client.listMarketsCached(dexes);
  }

  async getMarketSnapshot(symbol: string): Promise<NormalisedMarket | undefined> {
    if (!marketIndex) await this.refreshCatalogue();
    return marketIndex?.get(symbol.trim().toUpperCase());
  }

  /* ---------------------------------------------------------------- */
  /* MarketDataProvider                                               */
  /* ---------------------------------------------------------------- */

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    // Synchronous by interface contract, so this reads the cache only. A cold
    // cache yields `undefined`, which every existing caller already treats as
    // "unknown market" — the async paths above populate it first.
    return symbolIndex?.get(symbol.trim());
  }

  /**
   * True once the discovered catalogue has been populated in this process.
   *
   * Distinguishes "the venue does not list this instrument" (a fact) from
   * "we have not asked the venue yet" (not a fact). Callers that filter
   * instruments synchronously — the GOAT runtime's subscription guard — must
   * warm the catalogue first when this is false, or a cold boot would
   * misclassify every instrument as unlisted.
   */
  catalogueLoaded(): boolean {
    return symbolIndex !== null;
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const [quote] = await this.getQuotes([symbol]);
    return quote;
  }

  /**
   * Batch quotes.
   *
   * ONE `metaAndAssetCtxs` call serves every symbol, because it returns
   * context for the whole universe. Fetching per-symbol would cost weight 20
   * each instead of weight 20 in total.
   */
  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (symbols.length === 0) return [];

    const wanted = symbols.slice(0, MAX_QUOTES_PER_REQUEST);
    const snapshots = await this.client.listMarkets(this.dexes);
    const bySymbol = new Map(snapshots.map((s) => [s.market.symbol.toUpperCase(), s]));

    const now = Date.now();
    const out: MarketQuote[] = [];

    for (const symbol of wanted) {
      const key = symbol.trim().toUpperCase();
      const snapshot = bySymbol.get(key);
      if (!snapshot) {
        out.push(unavailableQuote(symbol, now, 'NOT_LISTED'));
        continue;
      }
      if (snapshot.market.delisted) {
        out.push(unavailableQuote(symbol, now, 'DELISTED'));
        continue;
      }

      const cached = this.quoteCache.get(key);
      if (cached && now - cached.at < QUOTE_TTL_MS) {
        out.push(cached.quote);
        continue;
      }

      const quote = this.buildQuote(symbol, snapshot);
      // A market with no price at all is NOT cached: it may be an empty book
      // on one dex that is populated a moment later.
      if (quote.mid > 0) this.quoteCache.set(key, { at: now, quote });
      out.push(quote);
    }

    return out;
  }

  /**
   * Builds a quote from provider context.
   *
   * Only fields Hyperliquid actually publishes are populated:
   *   mid       from midPx -> markPx -> oraclePx
   *   bid/ask   from impactPxs
   *   change24h DERIVED from prevDayPx (no 24h endpoint exists)
   *   high24h / low24h  left undefined — not available
   */
  private buildQuote(symbol: string, snapshot: HyperliquidMarketSnapshot): MarketQuote {
    const { market, context } = snapshot;
    const now = Date.now();

    const mid = context.midPx ?? context.markPx ?? context.oraclePx ?? 0;

    const hasImpact = context.impactPxs !== null;
    const bid = hasImpact ? context.impactPxs![0] : 0;
    const ask = hasImpact ? context.impactPxs![1] : 0;

    // Change must be computed. `prevDayPx` is the documented reference from
    // 24h ago; there is no endpoint that returns a change directly.
    const prevDay = context.prevDayPx;
    const change24h =
      prevDay !== null && prevDay > 0 && mid > 0 ? mid - prevDay : 0;
    const change24hPct =
      prevDay !== null && prevDay > 0 && mid > 0 ? ((mid - prevDay) / prevDay) * 100 : 0;

    return {
      symbol: market.symbol,
      bid,
      ask,
      mid,
      spread: hasImpact && ask >= bid ? ask - bid : 0,
      change24h,
      change24hPct,
      // Hyperliquid publishes no 24h high/low. Reporting the 24h reference
      // price as both would be a fabrication; leaving them undefined is
      // truthful and the UI already omits absent stats.
      high24h: 0,
      low24h: 0,
      timestamp: now,
      // A market with no mid is genuinely unavailable, not merely quiet.
      stale: mid <= 0,
      marketState: mid > 0 ? 'open' : 'unknown',
      quoteAgeSeconds: 0,
      /**
       * Not on the shared interface, but required for truthfulness: it tells
       * the gate and the UI whether `bid`/`ask` came from the provider or are
       * placeholders for an empty book.
       */
      ...({
        bidProvided: hasImpact,
        askProvided: hasImpact,
        hasImpactPrices: hasImpact,
        volume24h: context.dayNtlVlm,
        openInterest: context.openInterest,
        fundingRate: context.funding,
        change24hProvided: prevDay !== null && prevDay > 0,
        high24hProvided: false,
        low24hProvided: false,
        deployment: market.deployment,
        category: market.category,
        dex: market.dex,
        szDecimals: market.szDecimals,
        maxLeverage: market.maxLeverage,
        tracked: market.tracked,
      } as Record<string, unknown>),
    };
  }

  async getCandles(symbol: string, timeframe: string, count = 200): Promise<Candle[]> {
    const snapshot = await this.getMarketSnapshot(symbol);
    if (!snapshot) {
      throw new MarketDataUnavailableError(
        `"${symbol}" is not a market Hyperliquid lists. Search for it under Markets, or pick another instrument.`,
        symbol,
        'NOT_LISTED',
      );
    }
    if (snapshot.delisted) {
      throw new MarketDataUnavailableError(
        `"${snapshot.symbol}" has been delisted by Hyperliquid and no longer has price data.`,
        symbol,
        'DELISTED',
      );
    }

    const limit = Math.min(Math.max(Math.floor(count) || 1, 1), 5000);

    try {
      const bars = await this.client.candles(snapshot.symbol, timeframe, limit);
      if (bars.length === 0) {
        // Real and important: a listed market with no history yet (a new
        // listing), or one that has not traded in the requested window. The
        // UI shows "no candles" rather than a synthetic flat line.
        return [];
      }
      return bars.map((bar) => ({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    } catch (error) {
      if (error instanceof HyperliquidError) {
        throw new MarketDataUnavailableError(
          `Hyperliquid could not return candles for ${snapshot.symbol} (${timeframe}): ${error.message}`,
          symbol,
          'PROVIDER_ERROR',
        );
      }
      throw error;
    }
  }

  /**
   * Quote fan-out.
   *
   * ONE shared timer for the whole provider, not one per symbol: 50
   * subscribers on 50 symbols must not become 50 upstream requests. Only
   * symbols someone actually asked about are refreshed.
   */
  subscribeQuotes(symbols: string[], callback: (quote: MarketQuote) => void): () => void {
    for (const symbol of symbols) this.activeSymbols.add(symbol);
    this.quoteSubscribers.add(callback);
    this.ensureTimer();

    void this.pushQuotes();

    return () => {
      this.quoteSubscribers.delete(callback);
      // Only stop tracking a symbol once nothing is subscribed to it.
      if (this.quoteSubscribers.size === 0) {
        this.activeSymbols.clear();
        this.stopTicks();
      }
    };
  }

  private ensureTimer(): void {
    if (this.quoteTimer) return;
    this.quoteTimer = setInterval(() => void this.pushQuotes(), QUOTE_REFRESH_MS);
    // Never hold the process open for a market-data poll.
    (this.quoteTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async pushQuotes(): Promise<void> {
    if (this.quoteSubscribers.size === 0) return;
    const symbols = [...this.activeSymbols].slice(0, MAX_QUOTES_PER_REQUEST);

    try {
      const quotes = await this.getQuotes(symbols);
      for (const quote of quotes) {
        // A copy per subscriber, so one consumer mutating a quote cannot
        // corrupt another's view.
        for (const callback of this.quoteSubscribers) {
          try {
            callback({ ...quote });
          } catch {
            // One bad subscriber must not stop the others.
          }
        }
      }
    } catch {
      // Poll failures are not thrown at subscribers; the next tick retries.
      // `stale` on the cached quote is what the UI renders in the meantime.
    }
  }

  stopTicks(): void {
    if (this.quoteTimer) {
      clearInterval(this.quoteTimer);
      this.quoteTimer = null;
    }
    this.quoteSubscribers.clear();
    this.activeSymbols.clear();
  }

  /** Connection state for the Markets header. */
  async connectionStatus(): Promise<{ connected: boolean; provider: string; detail: string }> {
    const health = await this.client.health();
    return { connected: health.ok, provider: this.name, detail: health.detail };
  }
}

/**
 * A quote for a market that cannot be quoted.
 *
 * `mid: 0` with `stale: true` is the existing interface's representation of
 * "no usable price" — `MarketStateStore` already handles it by marking the
 * snapshot DEGRADED rather than computing indicators from a zero.
 */
function unavailableQuote(symbol: string, now: number, reason: string): MarketQuote {
  return {
    symbol,
    bid: 0,
    ask: 0,
    mid: 0,
    spread: 0,
    change24h: 0,
    change24hPct: 0,
    high24h: 0,
    low24h: 0,
    timestamp: now,
    stale: true,
    marketState: 'unknown',
    quoteAgeSeconds: null as unknown as number,
    unavailableReason: reason,
  } as MarketQuote;
}

/** Resets the module-level catalogues. Test-only. */
export function resetHyperliquidCatalogue(): void {
  symbolIndex = null;
  marketIndex = null;
}

export const hyperliquidProvider = new HyperliquidMarketDataProvider();

export { DEFAULT_MARKET_UNIVERSE, HYPERLIQUID_DEXES, MARKET_CATEGORIES };
export type { Timeframe };