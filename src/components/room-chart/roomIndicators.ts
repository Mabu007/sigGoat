/**
 * ROOM INDICATOR MATHS
 * ====================
 * The numbers behind the room chart's indicator toggles.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A chart indicator is only useful if the line on the screen is the SAME
 * number the rest of the product reasons about. The tracker engine, the
 * GOAT's technical analysis and the room chart all have to agree, otherwise
 * the chart is a decoration and the GOAT is a different instrument.
 *
 * So every value here comes from the shared indicator implementations in
 * `src/services/tracker-sdk`:
 *
 *   - `indicators.ts`      -> `calculateSMA`, `calculateEMA`, `calculateRSI`,
 *                             `calculateMACD`, `calculateBollingerBands`
 *   - `indicatorSeries.ts`  -> `smaSeries`, `emaSeries`, `rsiSeries` (the
 *                             warmup-aware variants, used for the LEGEND so
 *                             an indicator with too little history says so
 *                             instead of showing a plausible lie)
 *
 * Nothing here invents a value. If there is not enough history the series
 * simply starts later, and the legend reports `null` for "not evaluable yet".
 *
 * PER-BAR EVALUATION
 * ------------------
 * The library functions take a candle slice and return one number, so a
 * chart series is produced by evaluating them once per bar over the history
 * that existed AT that bar. Because the SDK implementations are continuous
 * (Wilder's RSI and the EMA recursion are seeded from the FIRST bars of the
 * slice and never re-seeded), evaluating a growing slice yields exactly the
 * value that a single streaming implementation would have produced — and the
 * last point of every series equals the value the tracker engine computes
 * for the same window.
 *
 * The cost is O(n^2) over the slice length. At the ~500 bars a room chart
 * holds that is a few milliseconds, and the result is memoised on the candle
 * slice, so it is paid once per candle update rather than once per frame.
 */

import type { Candle } from '../../types';
import {
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
} from '../../services/tracker-sdk/indicators';
import { emaSeries, rsiSeries, smaSeries } from '../../services/tracker-sdk/indicatorSeries';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** The indicators the room chart can draw. */
export type RoomIndicatorKind = 'sma' | 'ema' | 'rsi' | 'macd' | 'bollinger';

/**
 * One indicator the user asked for.
 *
 * `period` means: SMA/EMA/RSI lookback, Bollinger lookback. MACD uses
 * `fastPeriod` / `slowPeriod` / `signalPeriod` instead.
 */
export interface RoomIndicatorConfig {
  kind: RoomIndicatorKind;
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  deviations?: number;
}

/** A candle in the shape the indicator maths wants: epoch SECONDS. */
export interface RoomIndicatorCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RoomIndicatorPoint {
  /** Epoch seconds, matching the chart's own time axis. */
  time: number;
  value: number;
}

export interface RoomIndicatorLine {
  /** Stable id, unique inside one indicator output. */
  id: string;
  label: string;
  color: string;
  width: number;
  data: RoomIndicatorPoint[];
}

export interface RoomIndicatorHistogram {
  data: Array<{ time: number; value: number; color: string }>;
}

/**
 * A fully evaluated indicator, ready to be turned into chart series.
 *
 * `ownPane` decides where it is drawn: `false` means "overlay the price
 * scale" (moving averages, Bollinger), `true` means "give it its own pane
 * and its own price scale" (RSI, MACD), which is what stops an RSI of 0-100
 * from being stretched over a price of 40000.
 */
export interface RoomIndicatorOutput {
  /** Unique per config, e.g. `sma:20`. */
  key: string;
  kind: RoomIndicatorKind;
  /** Human label, e.g. `SMA(20)`. */
  label: string;
  ownPane: boolean;
  lines: RoomIndicatorLine[];
  histogram?: RoomIndicatorHistogram;
  /** Latest values for the legend. `null` means "not enough history yet". */
  legend: Array<{ label: string; value: number | null }>;
}

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

/**
 * Indicator colours are DATA colours, not chrome, so they are not read from
 * the theme tokens: a moving average has to be the same colour in the light
 * theme as in the dark one, otherwise a screenshot of a room stops meaning
 * anything. They are mid-tones chosen to read on both the light canvas
 * (#edf1f6) and the dark one (#0b1322).
 */
export const ROOM_INDICATOR_COLORS = {
  sma: '#d8a24a',
  ema: '#4fc9a6',
  rsi: '#7aa2f7',
  macd: '#4fc9a6',
  macdSignal: '#d8a24a',
  macdUp: 'rgba(83, 223, 176, 0.55)',
  macdDown: 'rgba(255, 113, 133, 0.55)',
  bollingerMiddle: '#8792a6',
  bollingerBand: '#6f8fb5',
} as const;

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * The same filtering the chart itself applies (bad candles dropped, one
 * candle per second, oldest first) so the indicator series and the candle
 * series always share a timeline.
 */
export function normalizeRoomCandles(candles: readonly Candle[]): RoomIndicatorCandle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.time) || candle.time <= 0) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) continue;
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) continue;
    if (candle.low > Math.min(candle.open, candle.close, candle.high)) continue;
    byTime.set(Math.floor(candle.time / 1000), candle);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, candle]) => ({
      time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Number.isFinite(candle.volume) ? candle.volume : 0,
    }));
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function clampPeriod(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = Number.isFinite(value as number) ? Math.floor(value as number) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function round(value: number, digits = 5): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** A pseudo candle so the SDK's EMA can be fed a plain number series. */
function asCandle(time: number, value: number): RoomIndicatorCandle {
  return { time, open: value, high: value, low: value, close: value, volume: 0 };
}

/**
 * The EMA of a plain number series, computed with the SDK's own EMA so the
 * signal line is the same maths the rest of the product uses.
 */
function emaOfSeries(values: RoomIndicatorPoint[], period: number): RoomIndicatorPoint[] {
  const out: RoomIndicatorPoint[] = [];
  if (values.length === 0) return out;
  const pseudo = values.map(point => asCandle(point.time, point.value));
  for (let i = period - 1; i < pseudo.length; i++) {
    out.push({ time: pseudo[i].time, value: calculateEMA(pseudo.slice(0, i + 1), period) });
  }
  return out;
}

function evaluateSma(candles: readonly RoomIndicatorCandle[], config: RoomIndicatorConfig): RoomIndicatorOutput {
  const period = clampPeriod(config.period, 20, 1, 500);
  const data: RoomIndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    data.push({ time: candles[i].time, value: calculateSMA(candles.slice(0, i + 1), period) });
  }
  const latest = smaSeries(candles, period);
  return {
    key: `sma:${period}`,
    kind: 'sma',
    label: `SMA(${period})`,
    ownPane: false,
    lines: [{ id: 'sma', label: `SMA(${period})`, color: ROOM_INDICATOR_COLORS.sma, width: 2, data }],
    legend: [{ label: `SMA(${period})`, value: latest.available ? round(latest.value) : null }],
  };
}

function evaluateEma(candles: readonly RoomIndicatorCandle[], config: RoomIndicatorConfig): RoomIndicatorOutput {
  const period = clampPeriod(config.period, 20, 1, 500);
  const data: RoomIndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    data.push({ time: candles[i].time, value: calculateEMA(candles.slice(0, i + 1), period) });
  }
  const latest = emaSeries(candles, period);
  return {
    key: `ema:${period}`,
    kind: 'ema',
    label: `EMA(${period})`,
    ownPane: false,
    lines: [{ id: 'ema', label: `EMA(${period})`, color: ROOM_INDICATOR_COLORS.ema, width: 2, data }],
    legend: [{ label: `EMA(${period})`, value: latest.available ? round(latest.value) : null }],
  };
}

function evaluateRsi(candles: readonly RoomIndicatorCandle[], config: RoomIndicatorConfig): RoomIndicatorOutput {
  const period = clampPeriod(config.period, 14, 2, 200);
  const data: RoomIndicatorPoint[] = [];
  // calculateRSI needs one more candle than the period (the first change).
  for (let i = period; i < candles.length; i++) {
    data.push({ time: candles[i].time, value: calculateRSI(candles.slice(0, i + 1), period) });
  }
  const latest = rsiSeries(candles, period);
  return {
    key: `rsi:${period}`,
    kind: 'rsi',
    label: `RSI(${period})`,
    ownPane: true,
    lines: [{ id: 'rsi', label: `RSI(${period})`, color: ROOM_INDICATOR_COLORS.rsi, width: 2, data }],
    legend: [{ label: `RSI(${period})`, value: latest.available ? round(latest.value, 1) : null }],
  };
}

function evaluateMacd(candles: readonly RoomIndicatorCandle[], config: RoomIndicatorConfig): RoomIndicatorOutput {
  const fast = clampPeriod(config.fastPeriod, 12, 2, 200);
  const slow = clampPeriod(config.slowPeriod, 26, 3, 400);
  const signalPeriod = clampPeriod(config.signalPeriod, 9, 2, 100);
  const macdPoints: RoomIndicatorPoint[] = [];
  for (let i = slow - 1; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const value = calculateMACD(slice, fast, slow, signalPeriod).macd;
    macdPoints.push({ time: candles[i].time, value });
  }
  /**
   * The signal line is the EMA of the MACD line, evaluated with the SDK's
   * EMA so it is a real exponential average rather than a constant
   * multiple of the MACD value.
   */
  const signalPoints = emaOfSeries(macdPoints, signalPeriod);
  const signalByTime = new Map(signalPoints.map(point => [point.time, point.value]));
  const histogram: Array<{ time: number; value: number; color: string }> = [];
  for (const point of macdPoints) {
    const signal = signalByTime.get(point.time);
    if (signal === undefined) continue;
    const value = round(point.value - signal);
    histogram.push({
      time: point.time,
      value,
      color: value >= 0 ? ROOM_INDICATOR_COLORS.macdUp : ROOM_INDICATOR_COLORS.macdDown,
    });
  }
  const lastMacd = macdPoints.at(-1)?.value ?? null;
  const lastSignal = signalPoints.at(-1)?.value ?? null;
  return {
    key: `macd:${fast}:${slow}:${signalPeriod}`,
    kind: 'macd',
    label: `MACD(${fast},${slow},${signalPeriod})`,
    ownPane: true,
    lines: [
      { id: 'macd', label: 'MACD', color: ROOM_INDICATOR_COLORS.macd, width: 2, data: macdPoints },
      { id: 'signal', label: 'Signal', color: ROOM_INDICATOR_COLORS.macdSignal, width: 2, data: signalPoints },
    ],
    histogram: { data: histogram },
    legend: [
      { label: 'MACD', value: lastMacd === null ? null : round(lastMacd) },
      { label: 'Signal', value: lastSignal === null ? null : round(lastSignal) },
    ],
  };
}

function evaluateBollinger(candles: readonly RoomIndicatorCandle[], config: RoomIndicatorConfig): RoomIndicatorOutput {
  const period = clampPeriod(config.period, 20, 2, 500);
  const deviations = clampPeriod(config.deviations, 2, 1, 6);
  const upper: RoomIndicatorPoint[] = [];
  const middle: RoomIndicatorPoint[] = [];
  const lower: RoomIndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const bands = calculateBollingerBands(candles.slice(0, i + 1), period, deviations);
    upper.push({ time: candles[i].time, value: bands.upper });
    middle.push({ time: candles[i].time, value: bands.middle });
    lower.push({ time: candles[i].time, value: bands.lower });
  }
  const last = middle.at(-1);
  const lastUpper = upper.at(-1);
  const lastLower = lower.at(-1);
  return {
    key: `bollinger:${period}:${deviations}`,
    kind: 'bollinger',
    label: `BB(${period},${deviations})`,
    ownPane: false,
    lines: [
      { id: 'upper', label: 'Upper', color: ROOM_INDICATOR_COLORS.bollingerBand, width: 1, data: upper },
      { id: 'middle', label: 'Middle', color: ROOM_INDICATOR_COLORS.bollingerMiddle, width: 1, data: middle },
      { id: 'lower', label: 'Lower', color: ROOM_INDICATOR_COLORS.bollingerBand, width: 1, data: lower },
    ],
    legend: [
      { label: 'BB upper', value: lastUpper ? round(lastUpper.value) : null },
      { label: 'BB mid', value: last ? round(last.value) : null },
      { label: 'BB lower', value: lastLower ? round(lastLower.value) : null },
    ],
  };
}

/**
 * Evaluates every requested indicator over the given candles.
 *
 * The output is ordered as requested and each entry carries everything the
 * chart needs to draw it AND everything the legend needs to describe it.
 */
export function computeRoomIndicators(
  candles: readonly RoomIndicatorCandle[],
  configs: readonly RoomIndicatorConfig[],
): RoomIndicatorOutput[] {
  const outputs: RoomIndicatorOutput[] = [];
  for (const config of configs) {
    switch (config.kind) {
      case 'sma':
        outputs.push(evaluateSma(candles, config));
        break;
      case 'ema':
        outputs.push(evaluateEma(candles, config));
        break;
      case 'rsi':
        outputs.push(evaluateRsi(candles, config));
        break;
      case 'macd':
        outputs.push(evaluateMacd(candles, config));
        break;
      case 'bollinger':
        outputs.push(evaluateBollinger(candles, config));
        break;
      default:
        break;
    }
  }
  return outputs;
}

/** The default configuration for an indicator the user just switched on. */
export function defaultRoomIndicatorConfig(kind: RoomIndicatorKind): RoomIndicatorConfig {
  switch (kind) {
    case 'sma':
      return { kind: 'sma', period: 20 };
    case 'ema':
      return { kind: 'ema', period: 20 };
    case 'rsi':
      return { kind: 'rsi', period: 14 };
    case 'macd':
      return { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
    case 'bollinger':
      return { kind: 'bollinger', period: 20, deviations: 2 };
    default:
      return { kind: 'sma', period: 20 };
  }
}
