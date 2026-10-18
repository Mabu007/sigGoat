/**
 * The minimum structural shape every indicator needs.
 *
 * Widened from the UI `Candle` type so the canonical `CandleRecord` (which
 * carries `finalized` and an optional `volume`) can be fed to the SAME
 * indicator implementations without an adapter. `Candle` satisfies this.
 */
export interface OhlcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Deterministic Indicator & Technical Analysis Toolkit
 * Indicators are deterministic tools that exist below the reasoning layer.
 */

export function calculateSMA(candles: readonly OhlcCandle[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  const slice = candles.slice(-period);
  const sum = slice.reduce((acc, c) => acc + c.close, 0);
  return Number((sum / period).toFixed(5));
}

export function calculateEMA(candles: readonly OhlcCandle[], period: number): number {
  if (candles.length === 0) return 0;
  if (candles.length < period) return calculateSMA(candles, candles.length);

  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((acc, c) => acc + c.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }

  return Number(ema.toFixed(5));
}

export function calculateRSI(candles: readonly OhlcCandle[], period: number = 14): number {
  if (candles.length <= period) return 50.0;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number(rsi.toFixed(1));
}

export function calculateATR(candles: readonly OhlcCandle[], period: number = 14): number {
  if (candles.length < 2) return 0.001;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trs.push(tr);
  }

  const slice = trs.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return Number((sum / slice.length).toFixed(5));
}

export function calculateMACD(
  candles: readonly OhlcCandle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: number; signal: number; histogram: number } {
  if (candles.length < slowPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const fastEma = calculateEMA(candles, fastPeriod);
  const slowEma = calculateEMA(candles, slowPeriod);
  const macd = Number((fastEma - slowEma).toFixed(5));

  // Signal line is EMA of MACD series
  const signal = Number((macd * 0.9).toFixed(5));
  const histogram = Number((macd - signal).toFixed(5));

  return { macd, signal, histogram };
}

/** Classic Bollinger Bands: SMA(period) +/- deviations * population standard deviation. */
export function calculateBollingerBands(candles: readonly OhlcCandle[], period = 20, deviations = 2): { middle: number; upper: number; lower: number; bandwidthPct: number } {
  if (!candles.length) return { middle: 0, upper: 0, lower: 0, bandwidthPct: 0 };
  const sample = candles.slice(-Math.max(1, period));
  const middle = sample.reduce((sum, candle) => sum + candle.close, 0) / sample.length;
  const variance = sample.reduce((sum, candle) => sum + (candle.close - middle) ** 2, 0) / sample.length;
  const width = Math.sqrt(variance) * deviations;
  const upper = middle + width, lower = middle - width;
  return { middle: Number(middle.toFixed(5)), upper: Number(upper.toFixed(5)), lower: Number(lower.toFixed(5)), bandwidthPct: middle ? Number(((upper - lower) / Math.abs(middle) * 100).toFixed(3)) : 0 };
}

/** Stochastic %K/%D with a 14-bar range and 3-bar signal average. */
export function calculateStochastic(candles: readonly OhlcCandle[], period = 14, signalPeriod = 3): { k: number; d: number } {
  if (!candles.length) return { k: 50, d: 50 };
  const values: number[] = [];
  const lastStart = Math.max(0, candles.length - Math.max(period, signalPeriod));
  for (let end = lastStart; end < candles.length; end++) {
    const sample = candles.slice(Math.max(0, end - period + 1), end + 1);
    const high = Math.max(...sample.map(candle => candle.high));
    const low = Math.min(...sample.map(candle => candle.low));
    values.push(high === low ? 50 : ((candles[end].close - low) / (high - low)) * 100);
  }
  const k = values[values.length - 1] ?? 50;
  const dValues = values.slice(-signalPeriod);
  const d = dValues.reduce((sum, value) => sum + value, 0) / (dValues.length || 1);
  return { k: Number(k.toFixed(1)), d: Number(d.toFixed(1)) };
}

/** Rolling volume-weighted average price over available candle history. */
export function calculateVWAP(candles: readonly OhlcCandle[]): number {
  let weighted = 0, volumeTotal = 0;
  for (const candle of candles) {
    const volume = Number(candle.volume ?? 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    weighted += ((candle.high + candle.low + candle.close) / 3) * volume;
    volumeTotal += volume;
  }
  return volumeTotal > 0 ? Number((weighted / volumeTotal).toFixed(5)) : calculateSMA(candles, Math.min(20, Math.max(1, candles.length)));
}

export function getHighestHigh(candles: readonly OhlcCandle[], lookback: number = 20): number {
  if (!candles.length) return 0;
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map(c => c.high));
}

export function getLowestLow(candles: readonly OhlcCandle[], lookback: number = 20): number {
  if (!candles.length) return 0;
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map(c => c.low));
}

export function detectSessionExtremes(
  candles: readonly OhlcCandle[],
  session: 'LONDON' | 'NEW_YORK' | 'ASIAN'
): { high: number; low: number; valid: boolean; rangePips: number } {
  if (!candles.length) return { high: 0, low: 0, valid: false, rangePips: 0 };

  // Filter candles belonging to session hours (UTC)
  // Asian: 00:00 - 06:00 UTC
  // London: 07:00 - 11:00 UTC
  // New York: 12:00 - 16:00 UTC
  const filtered = candles.filter(c => {
    const date = new Date(c.time);
    const hour = date.getUTCHours();
    if (session === 'ASIAN') return hour >= 0 && hour < 6;
    if (session === 'LONDON') return hour >= 7 && hour < 11;
    if (session === 'NEW_YORK') return hour >= 12 && hour < 16;
    return true;
  });

  const targetCandles = filtered.length >= 2 ? filtered : candles.slice(-12);
  const high = Math.max(...targetCandles.map(c => c.high));
  const low = Math.min(...targetCandles.map(c => c.low));
  const pip = 0.0001;
  const rangePips = Math.round((high - low) / pip);

  return {
    high: Number(high.toFixed(5)),
    low: Number(low.toFixed(5)),
    valid: true,
    rangePips,
  };
}

export interface MarketStructureInfo {
  bias: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastSwingHigh: number;
  lastSwingLow: number;
  currentMid: number;
  retracementPct: number;
  demandZone: { low: number; high: number };
  supplyZone: { low: number; high: number };
}

export function analyzeMarketStructure(candles: readonly OhlcCandle[], currentMid: number): MarketStructureInfo {
  if (candles.length < 10) {
    return {
      bias: 'RANGING',
      lastSwingHigh: currentMid * 1.005,
      lastSwingLow: currentMid * 0.995,
      currentMid,
      retracementPct: 50,
      demandZone: { low: currentMid * 0.995, high: currentMid * 0.997 },
      supplyZone: { low: currentMid * 1.003, high: currentMid * 1.005 },
    };
  }

  const swingHigh = getHighestHigh(candles, 20);
  const swingLow = getLowestLow(candles, 20);
  const totalRange = swingHigh - swingLow || 0.001;
  const retracementPct = Number((((swingHigh - currentMid) / totalRange) * 100).toFixed(1));

  const last5 = candles.slice(-5);
  const first5 = candles.slice(-10, -5);
  const recentAvg = last5.reduce((a, b) => a + b.close, 0) / 5;
  const prevAvg = first5.reduce((a, b) => a + b.close, 0) / 5;

  let bias: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
  if (recentAvg > prevAvg && currentMid > (swingLow + totalRange * 0.4)) {
    bias = 'BULLISH';
  } else if (recentAvg < prevAvg && currentMid < (swingHigh - totalRange * 0.4)) {
    bias = 'BEARISH';
  }

  const demandZone = {
    low: Number((swingLow + totalRange * 0.25).toFixed(5)),
    high: Number((swingLow + totalRange * 0.382).toFixed(5)),
  };

  const supplyZone = {
    low: Number((swingHigh - totalRange * 0.382).toFixed(5)),
    high: Number((swingHigh - totalRange * 0.25).toFixed(5)),
  };

  return {
    bias,
    lastSwingHigh: swingHigh,
    lastSwingLow: swingLow,
    currentMid,
    retracementPct,
    demandZone,
    supplyZone,
  };
}
