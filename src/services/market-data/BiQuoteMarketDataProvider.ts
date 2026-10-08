/**
 * BIQUOTE LIVE MARKET DATA PROVIDER
 * =================================
 * Real market data from biquote.io — free, no API key, no signup,
 * 15,000 requests/minute per IP. Forex, metals, crypto and index CFDs.
 *
 *   GET https://biquote.io/api/{SYMBOL}
 *   GET https://biquote.io/api/{SYMBOL}/ohlc?interval=1h&limit=200
 *   GET https://biquote.io/api/latest?symbols=A&symbols=B   (repeated param)
 *   GET https://biquote.io/api/symbols?quotedWithinDays=7
 *
 * PROVIDER GOTCHAS HANDLED HERE (each one silently corrupts analysis):
 *
 * 1. `last` and `volume` are ALWAYS 0. This is CFD pricing off MetaTrader 5,
 *    not an exchange tape, so there is no consolidated last price and no real
 *    volume. `mid` is the only valid price. `tickVolume` is a real tick count
 *    and is what we map into Candle.volume.
 *
 * 2. OHLC bars arrive NEWEST-FIRST. Candle[] is consumed ascending
 *    everywhere (indicators, structure, ATR), so they are reversed on read.
 *
 * 3. Forex stops quoting Friday night to Sunday night. A closed market is NOT
 *    an error: we return the last price but flag it stale, so the GOAT's
 *    prompt cannot treat Friday's close as a live quote.
 *
 * 4. The symbol catalogue field is `name`, not `symbol`.
 *
 * 5. Never request a symbol list with `liveOnly` — at a weekend it returns
 *    almost nothing and any list built from it comes back empty.
 */

import { MarketSymbol, MarketQuote, Candle, DataMode } from '../../types';
import { MarketDataProvider, MarketDataUnavailableError } from './MarketDataProvider';

const BASE_URL = 'https://biquote.io/api';
const FETCH_TIMEOUT_MS = 8_000;
const CANDLES_PER_FETCH = 300;

/**
 * The UI speaks `EUR/USD`; BiQuote speaks `EURUSD`. Keeping the UI symbols
 * stable means existing GOATs and saved theses survive the switch to live
 * data.
 */
const SYMBOL_ALIASES: Record<string, string> = {
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'USD/JPY': 'USDJPY',
  'AUD/USD': 'AUDUSD',
  'USD/CAD': 'USDCAD',
  'USD/CHF': 'USDCHF',
  'NZD/USD': 'NZDUSD',
  'EUR/GBP': 'EURGBP',
  'EUR/JPY': 'EURJPY',
  'GBP/JPY': 'GBPJPY',
  'XAU/USD': 'XAUUSD',
  'XAG/USD': 'XAGUSD',
  WTI: 'XTIUSD',
  BRENT: 'BRENT',
  US500: 'US500',
  US100: 'USTEC',
  SPX500: 'USTEC',
  US30: 'US30',
  GER40: 'DE30',
  'BTC/USD': 'BTCUSD',
  'ETH/USD': 'ETHUSD',
};

/** Static metadata so the symbol list renders before the catalogue loads. */
const STATIC_SYMBOLS: MarketSymbol[] = [
  { symbol: 'EUR/USD', name: 'Euro / US Dollar', category: 'forex', baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 0.8 },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar', category: 'forex', baseCurrency: 'GBP', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 1.2 },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'JPY', pipSize: 0.01, digits: 3, minSpread: 1.0 },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', category: 'forex', baseCurrency: 'AUD', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 1.1 },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'CAD', pipSize: 0.0001, digits: 5, minSpread: 1.4 },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'CHF', pipSize: 0.0001, digits: 5, minSpread: 1.3 },
  { symbol: 'EUR/GBP', name: 'Euro / British Pound', category: 'forex', baseCurrency: 'EUR', quoteCurrency: 'GBP', pipSize: 0.0001, digits: 5, minSpread: 1.5 },
  { symbol: 'XAU/USD', name: 'Gold / US Dollar', category: 'commodities', baseCurrency: 'XAU', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 1.8 },
  { symbol: 'XAG/USD', name: 'Silver / US Dollar', category: 'commodities', baseCurrency: 'XAG', quoteCurrency: 'USD', pipSize: 0.01, digits: 3, minSpread: 2.2 },
  { symbol: 'WTI', name: 'WTI Crude Oil', category: 'commodities', baseCurrency: 'WTI', quoteCurrency: 'USD', pipSize: 0.01, digits: 2, minSpread: 2.4 },
  { symbol: 'US500', name: 'S&P 500 Index CFD', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 0.5 },
  { symbol: 'US100', name: 'Nasdaq 100 Index CFD', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 1.0 },
  { symbol: 'US30', name: 'Dow Jones 30 Index CFD', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 1.0, digits: 1, minSpread: 1.8 },
  { symbol: 'GER40', name: 'Germany DAX Index CFD', category: 'indices', baseCurrency: 'EUR', quoteCurrency: 'EUR', pipSize: 1.0, digits: 1, minSpread: 1.2 },
  { symbol: 'BTC/USD', name: 'Bitcoin / US Dollar', category: 'forex', baseCurrency: 'BTC', quoteCurrency: 'USD', pipSize: 1, digits: 2, minSpread: 0 },
  { symbol: 'ETH/USD', name: 'Ethereum / US Dollar', category: 'forex', baseCurrency: 'ETH', quoteCurrency: 'USD', pipSize: 1, digits: 2, minSpread: 0 },
];

const SYMBOL_INDEX = new Map(
  STATIC_SYMBOLS.map((s) => [s.symbol, s]),
);

const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1d': '1d',
};

interface BiQuoteTick {
  symbol?: string;
  bid?: number;
  ask?: number;
  mid?: number;
  spread?: number;
  high?: number;
  low?: number;
  dayDiffPercent?: number;
  direction?: string;
  stale?: boolean;
  quoteAgeSeconds?: number;
  marketState?: string;
  timestamp?: string;
  lastQuoteAt?: string;
}

interface BiQuoteBar {
  openTime?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  tickVolume?: number;
}

function toNativeSymbol(symbol: string): string {
  const key = symbol.trim().toUpperCase();
  return SYMBOL_ALIASES[key] ?? key.replace('/', '');
}

function toDisplaySymbol(native: string): string {
  const found = Object.entries(SYMBOL_ALIASES).find(
    ([, value]) => value === native,
  );
  return found ? found[0] : native;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : 0;
}

export class BiQuoteMarketDataProvider implements MarketDataProvider {
  readonly name = 'BiQuote (live)';
  readonly dataMode: DataMode = 'LIVE';

  private symbolCache: MarketSymbol[] | null = null;
  private readonly pollingTimers = new Map<string, ReturnType<typeof setInterval>>();

  async getSymbols(): Promise<MarketSymbol[]> {
    if (this.symbolCache) return this.symbolCache;

    try {
      const response = await this.request(
        '/symbols?quotedWithinDays=7',
      );
      const catalogue = (await response.json()) as Array<{
        name?: string;
        description?: string;
        type?: string;
        digits?: number;
      }>;

      // Only surface symbols we can actually render sensibly, and that the
      // provider quotes. Unknown shapes are ignored rather than crashing the
      // symbol picker.
      const available = new Set(
        catalogue
          .filter((entry) => entry.name)
          .map((entry) => entry.name as string),
      );

      const symbols = STATIC_SYMBOLS.filter((symbol) =>
        available.has(toNativeSymbol(symbol.symbol)),
      );

      this.symbolCache = symbols.length > 0
        ? symbols
        : STATIC_SYMBOLS;

      return this.symbolCache;
    } catch (err) {
      console.warn(
        '[biquote] catalogue unavailable; serving the static symbol list.',
        err,
      );
      this.symbolCache = STATIC_SYMBOLS;
      return this.symbolCache;
    }
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    return SYMBOL_INDEX.get(symbol);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const native = toNativeSymbol(symbol);

    let tick: BiQuoteTick;
    try {
      const response = await this.request(`/${native}`);
      tick = (await response.json()) as BiQuoteTick;
    } catch (err) {
      throw new MarketDataUnavailableError(
        `BiQuote tick unavailable for ${symbol}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        symbol,
      );
    }

    return this.toQuote(symbol, tick);
  }

  /**
   * One request for every symbol. The endpoint takes a REPEATED query
   * parameter — the comma-separated form silently returns one symbol.
   */
  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    const native = symbols.map(toNativeSymbol);
    if (native.length === 0) return [];

    const query = native
      .map((s) => `symbols=${encodeURIComponent(s)}`)
      .join('&');

    const response = await this.request(`/latest?${query}`);
    const payload = (await response.json()) as Record<string, BiQuoteTick>;

    return symbols.map((symbol) => {
      const tick = payload[toNativeSymbol(symbol)];
      return this.toQuote(symbol, tick ?? {});
    });
  }

  async getCandles(
    symbol: string,
    timeframe: string,
    count = 200,
  ): Promise<Candle[]> {
    const interval =
      TIMEFRAME_MAP[timeframe.trim()] ?? '1h';
    const native = toNativeSymbol(symbol);
    const limit = Math.min(
      Math.max(1, Math.floor(count)),
      CANDLES_PER_FETCH,
    );

    const response = await this.request(
      `/${native}/ohlc?interval=${encodeURIComponent(interval)}&limit=${limit}`,
    );
    const payload = (await response.json()) as {
      bars?: BiQuoteBar[];
    };

    const bars = Array.isArray(payload.bars)
      ? payload.bars
      : [];

    /**
     * BiQuote returns bars NEWEST-FIRST; every consumer (indicators, market
     * structure, ATR) expects ascending time. Reversing here keeps that
     * assumption true everywhere downstream.
     */
    return bars
      .map((bar): Candle => ({
        time: Date.parse(bar.openTime ?? '') || 0,
        open: asNumber(bar.open),
        high: asNumber(bar.high),
        low: asNumber(bar.low),
        close: asNumber(bar.close),
        // `volume` is always 0 on this feed; tickVolume is the real activity
        // signal. A closed/illiquid bar legitimately reports 0.
        volume: asNumber(bar.tickVolume ?? bar.volume),
      }))
      .filter((candle) => candle.time > 0 && candle.close > 0)
      .reverse();
  }

  /**
   * Polling subscription.
   *
   * BiQuote also offers a SignalR WebSocket, but polling is used here
   * deliberately: it is one request per symbol per tick against a
   * 15,000/min budget, survives restarts with no connection state, and cannot
   * half-open and silently stop delivering ticks to a tracker.
   */
  subscribeQuotes(
    symbols: string[],
    callback: (quote: MarketQuote) => void,
  ): () => void {
    const intervalMs = 5_000;
    const unique = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];

    if (unique.length === 0) return () => {};

    const tick = () => {
      this.getQuotes(unique)
        .then((quotes) => {
          quotes.forEach((quote) => callback(quote));
        })
        .catch((err) => {
          // Never propagate into the provider or crash a tracker loop.
          console.warn('[biquote] quote poll failed:', err);
        });
    };

    void tick();

    const timer = setInterval(tick, intervalMs);
    timer.unref?.();

    const key = unique.join(',');
    this.pollingTimers.set(key, timer);

    return () => {
      clearInterval(timer);
      this.pollingTimers.delete(key);
    };
  }

  /** Stops every poll loop. Called on server shutdown. */
  stopTicks(): void {
    this.pollingTimers.forEach((timer) => clearInterval(timer));
    this.pollingTimers.clear();
  }

  private toQuote(symbol: string, tick: BiQuoteTick): MarketQuote {
    const bid = asNumber(tick.bid);
    const ask = asNumber(tick.ask);
    const mid =
      asNumber(tick.mid) || (bid && ask ? (bid + ask) / 2 : bid || ask);
    const timestamp =
      Date.parse(tick.timestamp ?? tick.lastQuoteAt ?? '') ||
      Date.now();

    /**
     * `dayDiffPercent` is a 24h change; derive the absolute figure from it so
     * MarketQuote.change24h means the same thing for both providers.
     */
    const change24hPct = asNumber(tick.dayDiffPercent);
    const change24h =
      mid > 0 && change24hPct !== 0
        ? (mid * change24hPct) / 100
        : 0;

    const closed = tick.marketState === 'closed';

    return {
      symbol,
      bid: bid || mid,
      ask: ask || mid,
      mid,
      spread:
        asNumber(tick.spread) ||
        (bid && ask ? ask - bid : 0),
      change24h,
      change24hPct,
      high24h: asNumber(tick.high),
      low24h: asNumber(tick.low),
      timestamp,
      /**
       * Truthful labelling: a weekend/holiday close is a real price but NOT a
       * live one. Consumers can refuse to act on a stale quote.
       */
      stale: Boolean(tick.stale) || closed,
      marketState: tick.marketState ?? 'unknown',
      quoteAgeSeconds: asNumber(tick.quoteAgeSeconds),
    };
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(
          `BiQuote HTTP ${response.status}`,
        );
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const biQuoteProvider = new BiQuoteMarketDataProvider();
