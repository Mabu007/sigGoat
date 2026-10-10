/**
 * PAPER MARKET DATA PROVIDER
 * ===========================
 * Deterministic, seeded, reproducible simulated market data.
 *
 * This provider exists so the GOAT engine, backtester and UI remain fully
 * functional without a real market-data feed. It is:
 *   - deterministic: same symbol + timeframe + bar index => same prices,
 *     on every process, forever (no Math.random() anywhere);
 *   - restart-stable: prices are a pure function of time, not of process
 *     start time, so charts and candles do not shift across restarts;
 *   - clearly labelled: dataMode is always 'PAPER', and the API/UI must
 *     surface that label so synthetic prices never masquerade as live.
 *
 * Price model: smooth multi-cycle composition (trend + 2 cycles) plus a
 * deterministic per-bar micro-noise, seeded per symbol. Realistic enough
 * for exercising the engine; obviously not a real feed.
 */

import { MarketSymbol, MarketQuote, Candle, DataMode } from '../../types';
import { MarketDataProvider } from './MarketDataProvider';
import { hashString, seededRandom } from '../agent/contracts';

export const PAPER_DATA_MODE: DataMode = 'PAPER';

export const PAPER_SYMBOLS: MarketSymbol[] = [
  // Forex
  { symbol: 'EUR/USD', name: 'Euro / US Dollar', category: 'forex', baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 0.8 },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar', category: 'forex', baseCurrency: 'GBP', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 1.2 },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'JPY', pipSize: 0.01, digits: 3, minSpread: 1.0 },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', category: 'forex', baseCurrency: 'AUD', quoteCurrency: 'USD', pipSize: 0.0001, digits: 5, minSpread: 1.1 },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'CAD', pipSize: 0.0001, digits: 5, minSpread: 1.4 },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc', category: 'forex', baseCurrency: 'USD', quoteCurrency: 'CHF', pipSize: 0.0001, digits: 5, minSpread: 1.3 },
  { symbol: 'EUR/GBP', name: 'Euro / British Pound', category: 'forex', baseCurrency: 'EUR', quoteCurrency: 'GBP', pipSize: 0.0001, digits: 5, minSpread: 1.5 },

  // Commodities
  { symbol: 'XAU/USD', name: 'Gold / US Dollar', category: 'commodities', baseCurrency: 'XAU', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 1.8 },
  { symbol: 'XAG/USD', name: 'Silver / US Dollar', category: 'commodities', baseCurrency: 'XAG', quoteCurrency: 'USD', pipSize: 0.01, digits: 3, minSpread: 2.2 },
  { symbol: 'BRENT', name: 'Brent Crude Oil (Paper)', category: 'commodities', baseCurrency: 'OIL', quoteCurrency: 'USD', pipSize: 0.01, digits: 2, minSpread: 2.5 },
  { symbol: 'WTI', name: 'WTI Crude Oil (Paper)', category: 'commodities', baseCurrency: 'OIL', quoteCurrency: 'USD', pipSize: 0.01, digits: 2, minSpread: 2.4 },

  // Indices
  { symbol: 'US500', name: 'S&P 500 Index (Paper)', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 0.5 },
  { symbol: 'US100', name: 'Nasdaq 100 Index (Paper)', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 0.1, digits: 2, minSpread: 1.0 },
  { symbol: 'US30', name: 'Dow Jones 30 (Paper)', category: 'indices', baseCurrency: 'USD', quoteCurrency: 'USD', pipSize: 1.0, digits: 1, minSpread: 1.8 },
  { symbol: 'GER40', name: 'Germany DAX 40 (Paper)', category: 'indices', baseCurrency: 'EUR', quoteCurrency: 'EUR', pipSize: 1.0, digits: 1, minSpread: 1.2 },
];

const SYMBOL_INDEX = new Map<string, MarketSymbol>(PAPER_SYMBOLS.map((s) => [s.symbol, s]));

/** Anchor for bar indexing — fixed so prices never depend on process start. */
const BAR_EPOCH_MS = Date.UTC(2024, 0, 1);

const BASE_PRICES: Record<string, number> = {
  'EUR/USD': 1.0862,
  'GBP/USD': 1.2945,
  'USD/JPY': 152.42,
  'AUD/USD': 0.6583,
  'USD/CAD': 1.3872,
  'USD/CHF': 0.8654,
  'EUR/GBP': 0.8391,
  'XAU/USD': 2742.6,
  'XAG/USD': 32.85,
  BRENT: 74.3,
  WTI: 70.8,
  US500: 5864.2,
  US100: 20380.5,
  US30: 42810.0,
  GER40: 19480.0,
};

const BASE_VOLATILITY: Partial<Record<MarketSymbol['category'], number>> = {
  forex: 0.004,
  currencies: 0.004,
  commodities: 0.012,
  indices: 0.008,
  crypto: 0.02,
};

export function paperTimeframeToMs(tf: string): number {
  switch (tf) {
    case '1m': return 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '1d':
    case '1D': return 24 * 60 * 60_000;
    default: return 60 * 60_000;
  }
}

function tfVolatilityMultiplier(tfMs: number): number {
  switch (tfMs) {
    case 60_000: return 0.35;
    case 5 * 60_000: return 0.6;
    case 15 * 60_000: return 0.85;
    case 60 * 60_000: return 1.4;
    case 4 * 60 * 60_000: return 2.2;
    default: return 3.5;
  }
}

/** Deterministic per-bar micro noise in [-0.5, 0.5]. */
function barNoise(symbol: string, barIndex: number): number {
  const bucket = hashString(`${symbol}|noise|${barIndex}`);
  return (bucket % 10_000) / 10_000 - 0.5;
}

/**
 * Deterministic mid price for a symbol at a bar index.
 * Multi-cycle sine composition: cheap, smooth, and stable for any bar index
 * without cumulative state (so restarts and random access are safe).
 */
export function paperPriceAt(symbol: string, tfMs: number, barIndex: number): number {
  const meta = SYMBOL_INDEX.get(symbol);
  const base = BASE_PRICES[symbol] ?? 100;
  const category = meta?.category ?? 'forex';
  const vol = BASE_VOLATILITY[category] * tfVolatilityMultiplier(tfMs);

  const seed = hashString(`signalgoat-paper:${symbol}`);
  const rng = seededRandom(seed);
  const phase0 = rng() * Math.PI * 2;
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;

  const trend = vol * 30 * Math.sin((2 * Math.PI * barIndex) / 4000 + phase0);
  const cycle1 = vol * 8 * Math.sin((2 * Math.PI * barIndex) / 220 + phase1);
  const cycle2 = vol * 3 * Math.sin((2 * Math.PI * barIndex) / 55 + phase2);
  const micro = vol * 0.6 * barNoise(symbol, barIndex);

  const price = base * (1 + trend + cycle1 + cycle2 + micro);
  const digits = meta?.digits ?? 5;
  return Number(price.toFixed(digits));
}

export function paperBarIndexAt(timeMs: number, tfMs: number): number {
  return Math.floor((timeMs - BAR_EPOCH_MS) / tfMs);
}

function paperBarOpenTime(barIndex: number, tfMs: number): number {
  return BAR_EPOCH_MS + barIndex * tfMs;
}

function buildCandle(symbol: string, tfMs: number, barIndex: number): Candle {
  const meta = SYMBOL_INDEX.get(symbol);
  const digits = meta?.digits ?? 5;
  const vol = BASE_VOLATILITY[meta?.category ?? 'forex'] * tfVolatilityMultiplier(tfMs);

  const open = paperPriceAt(symbol, tfMs, barIndex);
  const close = paperPriceAt(symbol, tfMs, barIndex + 1);

  const wickSeed = hashString(`${symbol}|wick|${barIndex}`);
  const wickRng = seededRandom(wickSeed);
  const wickUp = Math.abs(wickRng() - 0.5) * vol * 1.4;
  const wickDown = Math.abs(wickRng() - 0.5) * vol * 1.4;

  const high = Number((Math.max(open, close) * (1 + wickUp)).toFixed(digits));
  const low = Number((Math.min(open, close) * (1 - wickDown)).toFixed(digits));
  const volume = Math.floor(500 + Math.abs(wickRng()) * 4500);

  return {
    time: paperBarOpenTime(barIndex, tfMs),
    open,
    high,
    low,
    close,
    volume,
  };
}

export class PaperMarketDataProvider implements MarketDataProvider {
  readonly name = 'Paper (simulated)';
  readonly dataMode: DataMode = PAPER_DATA_MODE;

  private subscribers: Map<string, Set<(quote: MarketQuote) => void>> = new Map();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly enableTicks: boolean;

  constructor(options?: { enableTicks?: boolean }) {
    this.enableTicks = options?.enableTicks ?? process.env.NODE_ENV !== 'test';
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    return PAPER_SYMBOLS;
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    return SYMBOL_INDEX.get(symbol);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    return this.computeQuote(symbol, Date.now());
  }

  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  async getCandles(symbol: string, timeframe: string = '1h', count: number = 80): Promise<Candle[]> {
    const meta = SYMBOL_INDEX.get(symbol);
    if (!meta) {
      return [];
    }

    const boundedCount = Math.max(1, Math.min(1_000, Math.floor(count) || 80));
    const tfMs = paperTimeframeToMs(timeframe);
    const currentBar = paperBarIndexAt(Date.now(), tfMs);

    const candles: Candle[] = [];
    for (let i = boundedCount - 1; i >= 0; i--) {
      candles.push(buildCandle(symbol, tfMs, currentBar - i));
    }
    return candles;
  }

  subscribeQuotes(symbols: string[], callback: (quote: MarketQuote) => void): () => void {
    symbols.forEach((sym) => {
      if (!this.subscribers.has(sym)) {
        this.subscribers.set(sym, new Set());
      }
      this.subscribers.get(sym)!.add(callback);
    });

    this.ensureTickLoop();

    return () => {
      symbols.forEach((sym) => {
        this.subscribers.get(sym)?.delete(callback);
      });
    };
  }

  /** Stops the tick loop (used by tests and graceful shutdown). */
  stopTicks(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private ensureTickLoop(): void {
    if (this.tickTimer || !this.enableTicks) {
      return;
    }
    this.tickTimer = setInterval(() => this.tick(), 2_000);
    // Do not hold the process open just for paper ticks.
    this.tickTimer.unref?.();
  }

  private tick(): void {
    const now = Date.now();
    for (const [symbol, subs] of this.subscribers) {
      if (subs.size === 0) continue;
      try {
        const quote = this.computeQuote(symbol, now);
        subs.forEach((cb) => {
          try {
            cb(quote);
          } catch (e) {
            console.error('Paper provider subscriber error', e);
          }
        });
      } catch (e) {
        console.error('Paper provider tick error', e);
      }
    }
  }

  /** Deterministic quote at a given time (pure function of symbol + time). */
  private computeQuote(symbol: string, now: number): MarketQuote {
    const meta = SYMBOL_INDEX.get(symbol) ?? PAPER_SYMBOLS[0];
    const tfMs = 60 * 60_000; // quotes ride on the 1h price path
    const barIndex = paperBarIndexAt(now, tfMs);
    const barOpenTime = paperBarOpenTime(barIndex, tfMs);
    const fraction = Math.min(1, Math.max(0, (now - barOpenTime) / tfMs));

    const open = paperPriceAt(symbol, tfMs, barIndex);
    const next = paperPriceAt(symbol, tfMs, barIndex + 1);
    const tickNoise = barNoise(`${symbol}|tick`, Math.floor(now / 2_000)) * meta.pipSize * 0.5;
    const mid = Number((open + (next - open) * fraction + tickNoise).toFixed(meta.digits));

    const spread = Number((meta.minSpread * (1 + 0.1 * barNoise(`${symbol}|spread`, barIndex))).toFixed(meta.digits + 2));
    const spreadVal = spread * meta.pipSize;
    const bid = Number((mid - spreadVal / 2).toFixed(meta.digits));
    const ask = Number((mid + spreadVal / 2).toFixed(meta.digits));

    // 24h stats sampled from the 1h path (<= 24 samples, deterministic).
    const barsPerDay = Math.max(1, Math.round(24 * 60 * 60_000 / tfMs));
    let high24h = mid;
    let low24h = mid;
    for (let i = 0; i < barsPerDay; i++) {
      const p = paperPriceAt(symbol, tfMs, barIndex - i);
      if (p > high24h) high24h = p;
      if (p < low24h) low24h = p;
    }

    const dayAgo = paperPriceAt(symbol, tfMs, barIndex - barsPerDay);
    const change24h = Number((mid - dayAgo).toFixed(meta.digits));
    const change24hPct = Number(((change24h / (dayAgo || 1)) * 100).toFixed(2));

    return {
      symbol: meta.symbol,
      bid,
      ask,
      mid,
      spread,
      change24h,
      change24hPct,
      high24h: Number(high24h.toFixed(meta.digits)),
      low24h: Number(low24h.toFixed(meta.digits)),
      timestamp: now,
    };
  }
}

export const paperProvider = new PaperMarketDataProvider();
