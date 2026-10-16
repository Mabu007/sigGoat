import type { Candle, MarketCategory, MarketQuote, MarketSymbol } from "../../types";
import { MarketDataUnavailableError, type MarketDataProvider } from "../market-data/MarketDataProvider";
import { CTraderOpenApiClient, type CTraderQuoteEvent, type CTraderSymbol } from "./CTraderOpenApiClient";
import { resolveValidCTraderToken } from "./CTraderOAuthService";
import { credentialVault } from "../../server/security/instance";

export interface CTraderMarketDataProviderOptions {
  userId: string;
  accountId: string;
  isLive: boolean;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
}

const CURRENCY_CODES = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "ZAR", "SGD", "HKD", "NOK", "SEK", "MXN", "PLN", "TRY", "CNH", "CNY"]);
const COMMODITY_CODES = new Set(["XAU", "XAG", "XPT", "XPD", "WTI", "BRENT", "OIL", "NGAS", "NATGAS"]);
const INDEX_CODES = new Set(["US30", "US500", "NAS100", "USTEC", "GER40", "DE40", "UK100", "JP225", "AUS200", "EU50", "FRA40", "HK50"]);

function classifySymbol(name: string): { category: MarketCategory; baseCurrency: string; quoteCurrency: string } {
  const exact = name.trim().toUpperCase();
  const compact = exact.replace(/[\/_-]/g, "");
  const split = exact.includes("/") ? exact.split("/") : compact.length === 6 && /^[A-Z]{6}$/.test(compact) ? [compact.slice(0, 3), compact.slice(3)] : [];
  if (split.length === 2 && split[0] && split[1] && CURRENCY_CODES.has(split[0]) && CURRENCY_CODES.has(split[1])) {
    return { category: "currencies", baseCurrency: split[0], quoteCurrency: split[1] };
  }
  if ([...COMMODITY_CODES].some((code) => compact.startsWith(code) || compact.includes(code))) {
    return { category: "commodities", baseCurrency: split[0] ?? exact, quoteCurrency: split[1] ?? "" };
  }
  if (INDEX_CODES.has(compact) || [...INDEX_CODES].some((code) => compact.startsWith(code))) {
    return { category: "indices", baseCurrency: exact, quoteCurrency: "" };
  }
  // Provider's exact symbol remains the identity. Unclassified instruments are
  // not relabelled to a guessed forex/commodity alias.
  return { category: "crypto", baseCurrency: split[0] ?? exact, quoteCurrency: split[1] ?? "" };
}

function finite(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new MarketDataUnavailableError(`cTrader did not provide a valid ${label}.`, undefined, "MISSING_PROVIDER_FIELD");
  return value;
}

export class CTraderMarketDataProvider implements MarketDataProvider {
  readonly name = "cTrader Open API";
  readonly dataMode = "LIVE" as const;
  private symbolCache: CTraderSymbol[] = [];
  private symbolCacheAt = 0;
  private quoteCache = new Map<string, MarketQuote>();
  private quoteBatchOffset = 0;

  constructor(private readonly options: CTraderMarketDataProviderOptions) {
    if (!options.userId || !options.accountId) throw new Error("cTrader market data requires an authenticated owner and a selected account.");
  }

  private async client(): Promise<CTraderOpenApiClient> {
    const clientId = this.options.clientId ?? process.env.CTRADER_CLIENT_ID;
    const clientSecret = this.options.clientSecret ?? process.env.CTRADER_SECRET;
    if (!clientId || !clientSecret) throw new Error("cTrader server credentials are not configured.");
    const raw = await credentialVault.getCredential(this.options.userId, "ctrader");
    const token = await resolveValidCTraderToken(raw, (bundle) =>
      credentialVault.saveCredential(this.options.userId, "ctrader", JSON.stringify(bundle)),
      (this.options.now ?? Date.now)(),
    );
    return new CTraderOpenApiClient(token, clientId, clientSecret, this.options.accountId, this.options.isLive);
  }

  private async nativeSymbols(force = false): Promise<CTraderSymbol[]> {
    if (!force && this.symbolCache.length && (this.options.now ?? Date.now)() - this.symbolCacheAt < 60_000) return this.symbolCache;
    const symbols = await (await this.client()).getSymbols();
    if (!symbols.length) throw new MarketDataUnavailableError("The selected cTrader account returned no tradable symbols.", undefined, "EMPTY_SYMBOL_CATALOG");
    this.symbolCache = symbols;
    this.symbolCacheAt = (this.options.now ?? Date.now)();
    return symbols;
  }

  private async nativeSymbol(symbol: string): Promise<CTraderSymbol> {
    const symbols = await this.nativeSymbols();
    const match = symbols.find((item) => item.symbolName === symbol);
    if (!match) throw new MarketDataUnavailableError(`cTrader does not list the exact symbol "${symbol}" for the selected account. No cross-provider symbol mapping was attempted.`, symbol, "NOT_LISTED");
    return match;
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    return (await this.nativeSymbols()).map((item) => {
      const parsed = classifySymbol(item.symbolName);
      return {
        symbol: item.symbolName,
        name: item.symbolName,
        category: parsed.category,
        baseCurrency: parsed.baseCurrency,
        quoteCurrency: parsed.quoteCurrency,
        pipSize: 10 ** -Math.max(0, item.pipPosition),
        digits: item.digits,
        // cTrader's symbol list does not provide a minimum spread. This field
        // remains a compatibility placeholder; actual spread comes from quotes.
        minSpread: 0,
      };
    });
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    const native = this.symbolCache.find((item) => item.symbolName === symbol);
    if (!native) return undefined;
    const parsed = classifySymbol(native.symbolName);
    return {
      symbol: native.symbolName,
      name: native.symbolName,
      category: parsed.category,
      baseCurrency: parsed.baseCurrency,
      quoteCurrency: parsed.quoteCurrency,
      pipSize: 10 ** -Math.max(0, native.pipPosition),
      digits: native.digits,
      minSpread: 0,
    };
  }

  private quoteFromEvent(symbol: string, event: CTraderQuoteEvent): MarketQuote {
    const bid = finite(event.bid, "bid price");
    const ask = finite(event.ask, "ask price");
    if (bid <= 0 || ask <= 0 || ask < bid) throw new MarketDataUnavailableError(`cTrader returned invalid bid/ask values for "${symbol}".`, symbol, "INVALID_QUOTE");
    const mid = (bid + ask) / 2;
    const previous = event.sessionClose;
    const change = previous !== undefined && previous > 0 ? mid - previous : 0;
    const changePct = previous !== undefined && previous > 0 ? change / previous * 100 : 0;
    const quote: MarketQuote = {
      symbol, bid, ask, mid, spread: ask - bid,
      change24h: change, change24hPct: changePct,
      high24h: 0, low24h: 0,
      timestamp: event.timestamp ?? (this.options.now ?? Date.now)(),
      bidProvided: true, askProvided: true,
      change24hProvided: previous !== undefined && previous > 0,
      high24hProvided: false, low24hProvided: false,
      ...(event.timestamp !== undefined ? { quoteAgeSeconds: Math.max(0, ((this.options.now ?? Date.now)() - event.timestamp) / 1000) } : {}),
    };
    this.quoteCache.set(symbol, quote);
    return quote;
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const native = await this.nativeSymbol(symbol);
    const event = await (await this.client()).getQuote(native);
    return this.quoteFromEvent(symbol, event);
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    if (!symbols.length) return [];
    const nativeSymbols = await this.nativeSymbols();
    const nativeByName = new Map(nativeSymbols.map((item) => [item.symbolName, item]));
    const requested = symbols.map((symbol) => {
      const native = nativeByName.get(symbol);
      if (!native) throw new MarketDataUnavailableError(`cTrader does not list the exact symbol "${symbol}" for the selected account. No cross-provider symbol mapping was attempted.`, symbol, "NOT_LISTED");
      return { symbol, native };
    });
    const now = (this.options.now ?? Date.now)();
    const needsRefresh = requested.filter(({ symbol }) => {
      const cached = this.quoteCache.get(symbol);
      return !cached || now - cached.timestamp > 10_000;
    });
    if (needsRefresh.length) {
      // Refresh a bounded rotating slice per request. This keeps the Markets
      // screen from opening hundreds of WebSockets every few seconds.
      const count = Math.min(50, needsRefresh.length);
      const startIndex = this.quoteBatchOffset % needsRefresh.length;
      const batch = Array.from({ length: count }, (_, index) => needsRefresh[(startIndex + index) % needsRefresh.length]);
      this.quoteBatchOffset = (startIndex + count) % Math.max(1, needsRefresh.length);
      const client = await this.client();
      const events = await client.getQuotes(batch.map((item) => item.native));
      for (const item of batch) {
        const event = events.get(item.native.symbolId);
        if (event) this.quoteFromEvent(item.symbol, event);
      }
    }
    const currentTime = (this.options.now ?? Date.now)();
    return requested.flatMap(({ symbol }) => {
      const cached = this.quoteCache.get(symbol);
      if (!cached) return [];
      const ageSeconds = Math.max(0, (currentTime - cached.timestamp) / 1000);
      return [{ ...cached, stale: ageSeconds > 30, quoteAgeSeconds: ageSeconds }];
    });
  }

  async getCandles(symbol: string, timeframe: string, count = 200): Promise<Candle[]> {
    const native = await this.nativeSymbol(symbol);
    const bars = await (await this.client()).getCandles(native, timeframe, count);
    return bars.map((bar) => {
      const low = finite(bar.low, "candle low");
      const openDelta = finite(bar.deltaOpen, "candle open delta");
      const closeDelta = finite(bar.deltaClose, "candle close delta");
      const highDelta = finite(bar.deltaHigh, "candle high delta");
      const time = finite(bar.utcTimestampInMinutes, "candle timestamp") * 60_000;
      return {
        time,
        open: Number(((low + openDelta) / 100_000).toFixed(native.digits)),
        high: Number(((low + highDelta) / 100_000).toFixed(native.digits)),
        low: Number((low / 100_000).toFixed(native.digits)),
        close: Number(((low + closeDelta) / 100_000).toFixed(native.digits)),
        volume: bar.volume ?? 0,
      };
    });
  }

  subscribeQuotes(symbols: string[], callback: (quote: MarketQuote) => void): () => void {
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        for (const symbol of symbols) {
          if (!active) break;
          const quote = await this.getQuote(symbol);
          callback(quote);
        }
      } catch (error) {
        // Consumers receive no fabricated price. The next poll retries, while
        // getQuote itself throws a typed unavailable error for normal handling.
        console.warn("[ctrader-market-data] quote poll failed:", error instanceof Error ? error.message : "unknown provider error");
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => { active = false; clearInterval(timer); };
  }
}
