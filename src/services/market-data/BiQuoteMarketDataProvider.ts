import type { Candle, MarketCategory, MarketQuote, MarketSymbol } from "../../types";
import { MarketDataUnavailableError, type MarketDataProvider } from "./MarketDataProvider";

const BASE_URL = "https://biquote.io";
type BiQuoteSymbol = { name?: string; symbol?: string; description?: string; type?: string; exchange?: string; source?: string };
type BiQuoteTick = {
  symbol?: string; description?: string; bid?: number; ask?: number; mid?: number; spread?: number;
  dayDiffPercent?: number; high?: number; low?: number; timestamp?: string; marketState?: string;
  stale?: boolean; quoteAgeSeconds?: number;
};
type BiQuoteBar = { openTime: string; open: number; high: number; low: number; close: number; volume?: number; tickVolume?: number; isOpen?: boolean };

function categoryFor(value: string | undefined): MarketCategory {
  switch ((value ?? "").toLowerCase()) {
    case "forex": return "currencies";
    case "commodity": case "commodities": return "commodities";
    case "index": case "indices": return "indices";
    default: return "crypto";
  }
}
function toSymbol(item: BiQuoteSymbol): MarketSymbol {
  const symbol = String(item.name ?? item.symbol ?? "").toUpperCase();
  const category = categoryFor(item.type);
  const match = symbol.match(/^([A-Z]{3})([A-Z]{3})$/);
  const commodity = /^(XAU|XAG|XPT|XPD|WTI|BRENT|OIL|NGAS)/.test(symbol);
  const digits = symbol.includes("JPY") ? 3 : category === "currencies" ? 5 : 2;
  return {
    symbol,
    name: item.description || symbol,
    category,
    baseCurrency: match?.[1] ?? (commodity ? symbol.slice(0, 3) : symbol),
    quoteCurrency: match?.[2] ?? (category === "currencies" || commodity ? "USD" : ""),
    pipSize: 10 ** -digits,
    digits,
    minSpread: 0,
  };
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function toQuote(raw: BiQuoteTick, fallbackSymbol: string): MarketQuote {
  const symbol = String(raw.symbol ?? fallbackSymbol).toUpperCase();
  const mid = finite(raw.mid) ?? ((finite(raw.bid) ?? 0) + (finite(raw.ask) ?? 0)) / 2;
  const bid = finite(raw.bid) ?? mid;
  const ask = finite(raw.ask) ?? mid;
  const timestamp = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();
  return {
    symbol, bid, ask, mid, spread: finite(raw.spread) ?? Math.max(0, ask - bid),
    change24h: 0, change24hPct: finite(raw.dayDiffPercent) ?? 0,
    high24h: finite(raw.high) ?? mid, low24h: finite(raw.low) ?? mid,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    stale: raw.stale === true, marketState: raw.marketState ?? "unknown",
    quoteAgeSeconds: finite(raw.quoteAgeSeconds),
    bidProvided: finite(raw.bid) !== undefined, askProvided: finite(raw.ask) !== undefined,
    change24hProvided: finite(raw.dayDiffPercent) !== undefined,
    high24hProvided: finite(raw.high) !== undefined, low24hProvided: finite(raw.low) !== undefined,
  };
}

/**
 * BiQuote's public, no-key market-data adapter. This is a REAL reference feed
 * used by DEMO teams; it is never an execution adapter and cannot submit orders.
 */
export class BiQuoteMarketDataProvider implements MarketDataProvider {
  readonly name = "BiQuote (Demo reference feed)";
  readonly dataMode = "LIVE" as const;
  private symbols: MarketSymbol[] = [];
  private symbolsFetchedAt = 0;
  private readonly quoteCache = new Map<string, MarketQuote>();

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new MarketDataUnavailableError(
        `BiQuote request failed (${response.status})${body ? `: ${body.slice(0, 180)}` : ""}`,
        undefined,
        response.status === 404 ? "NOT_LISTED" : response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
      );
    }
    return response.json() as Promise<T>;
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    if (this.symbols.length && Date.now() - this.symbolsFetchedAt < 5 * 60_000) return this.symbols;
    const raw = await this.request<BiQuoteSymbol[]>("/api/symbols?quotedWithinDays=7");
    if (!Array.isArray(raw)) throw new MarketDataUnavailableError("BiQuote returned an invalid symbol catalogue.");
    this.symbols = raw.map(toSymbol).filter(item => item.symbol);
    this.symbolsFetchedAt = Date.now();
    return this.symbols;
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    return this.symbols.find(item => item.symbol === symbol.toUpperCase());
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const key = symbol.trim().toUpperCase();
    if (!key) throw new MarketDataUnavailableError("A market symbol is required.");
    const raw = await this.request<BiQuoteTick>(`/api/${encodeURIComponent(key)}?allowStale=false`);
    const quote = toQuote(raw, key);
    if (!quote.mid || !Number.isFinite(quote.mid)) throw new MarketDataUnavailableError(`BiQuote has no usable price for ${key}.`, key, "MISSING_PRICE");
    this.quoteCache.set(key, quote);
    return quote;
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    const keys = [...new Set(symbols.map(item => item.trim().toUpperCase()).filter(Boolean))];
    if (!keys.length) return [];
    const params = new URLSearchParams();
    for (const key of keys.slice(0, 100)) params.append("symbols", key);
    const raw = await this.request<Record<string, BiQuoteTick>>(`/api/latest?${params.toString()}`);
    return keys.map(key => {
      const item = raw[key] ?? raw[key.toLowerCase()];
      if (!item) throw new MarketDataUnavailableError(`BiQuote has no current quote for ${key}.`, key, "NOT_QUOTING");
      const quote = toQuote(item, key);
      this.quoteCache.set(key, quote);
      return quote;
    });
  }

  async getCandles(symbol: string, timeframe: string, count = 200): Promise<Candle[]> {
    const interval = ({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "1D": "1d" } as Record<string, string>)[timeframe] ?? "1h";
    const limit = Math.max(1, Math.min(1000, Math.floor(count)));
    const raw = await this.request<{ symbol?: string; interval?: string; bars?: BiQuoteBar[] }>(
      `/api/${encodeURIComponent(symbol.trim().toUpperCase())}/ohlc?interval=${interval}&limit=${limit}`,
    );
    if (!Array.isArray(raw.bars)) throw new MarketDataUnavailableError(`BiQuote returned no candle series for ${symbol}.`, symbol, "NO_CANDLES");
    return raw.bars
      .filter(bar => bar && typeof bar.openTime === "string" && [bar.open, bar.high, bar.low, bar.close].every(value => typeof value === "number" && Number.isFinite(value)))
      .map(bar => ({ time: Date.parse(bar.openTime), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: finite(bar.tickVolume) ?? finite(bar.volume) ?? 0 }))
      .filter(bar => Number.isFinite(bar.time))
      .sort((a, b) => a.time - b.time);
  }

  subscribeQuotes(symbols: string[], callback: (quote: MarketQuote) => void): () => void {
    const keys = [...new Set(symbols.map(item => item.trim().toUpperCase()).filter(Boolean))].slice(0, 100);
    let stopped = false;
    let running = false;
    const poll = async () => {
      if (stopped || running || !keys.length) return;
      running = true;
      try { for (const quote of await this.getQuotes(keys)) if (!stopped) callback(quote); }
      catch { /* Preserve the last good quote; consumers can inspect its timestamp. */ }
      finally { running = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => { stopped = true; clearInterval(timer); };
  }
}

export const biQuoteMarketDataProvider = new BiQuoteMarketDataProvider();
