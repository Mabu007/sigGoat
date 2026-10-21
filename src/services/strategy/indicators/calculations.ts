/**
 * INDICATOR CALCULATIONS
 * ======================
 *
 * The only module in the repository that imports the upstream indicator
 * library (`indicatorts`). Every catalog entry has one adapter here, and
 * every adapter returns FULL SERIES aligned to the candles it was given.
 *
 * ALIGNMENT AND WARM-UP
 *
 * The upstream library returns arrays of the same length as its input, but
 * the early entries are partial averages or zeros rather than real
 * measurements. A series is therefore masked with `NaN` until the catalog's
 * warm-up requirement is met, and every non-finite result becomes `NaN` as
 * well. A `NaN` means "this value does not exist", and the condition
 * evaluator treats it as "not satisfied" instead of silently comparing
 * against zero.
 *
 * NO FUTURE DATA
 *
 * Two upstream exports are unusable for a backtest and are therefore not
 * used:
 *
 *   `cfo(closings)` regresses over EVERY candle in the array, so its value
 *   at any index depends on candles that have not happened yet. The catalog
 *   uses the windowed `mcfo` instead.
 *
 *   `ichimokuCloud(...)` returns the two cloud lines already displaced
 *   forward and the lagging span already displaced backward, so reading them
 *   at the decision candle either plots into the future or reads a future
 *   close. The Ichimoku adapter below re-aligns every output to the
 *   decision candle.
 *
 * `tests/indicatorLookahead.test.ts` proves the claim for the whole catalog
 * by perturbing the last candle and asserting that no earlier value moves.
 */

import {
  ab, ad, ao, apo, aroon, bb, bbw, bop, cci, ce, chaikinMoneyFlow, cmo, dc, dema, emv, fi,
  ichimokuCloud, kc, kdj, macd, massIndex, mcfo, mfi, mmax, mmin, mstd, msum, nvi, obv, po,
  ppo, psar, pvo, qstick, rma, roc, since, stoch, tema, tr, trima, trix, typprice, ui, vortex,
  vpt, vwap, vwma, willr,
} from 'indicatorts';
import { indicatorCatalogEntry, resolveIndicatorParams, type IndicatorCatalogEntry } from './catalog';

export interface CandleLike {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CalculatedIndicator {
  /** Output key to a series aligned to the candles, with `NaN` where undefined. */
  series: Record<string, number[]>;
}

type Adapter = (candles: readonly CandleLike[], params: Record<string, number>) => Record<string, number[]>;

const opens = (candles: readonly CandleLike[]) => candles.map(candle => candle.open);
const highs = (candles: readonly CandleLike[]) => candles.map(candle => candle.high);
const lows = (candles: readonly CandleLike[]) => candles.map(candle => candle.low);
const closes = (candles: readonly CandleLike[]) => candles.map(candle => candle.close);
const volumes = (candles: readonly CandleLike[]) => candles.map(candle => candle.volume);

const seriesOf = (values: number[] | undefined, length: number): number[] => {
  const series = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    const value = values?.[index];
    series[index] = typeof value === 'number' ? value : Number.NaN;
  }
  return series;
};

const zip = (first: number[], second: number[], length: number, combine: (a: number, b: number) => number) => {
  const series = new Array<number>(length);
  for (let index = 0; index < length; index += 1) series[index] = combine(first[index], second[index]);
  return series;
};

/* ------------------------------------------------------------------ */
/* Legacy series — SMA, EMA, RSI, ATR                                  */
/* ------------------------------------------------------------------ */

/**
 * The moving averages, momentum and range series this repository already
 * used before the library integration.
 *
 * They are reproduced here as full series so one evaluation pipeline can
 * handle every indicator. The maths is identical to
 * `src/services/tracker-sdk/indicatorSeries.ts`; `tests/strategyRegression.test.ts`
 * pins the two implementations against each other, so a saved strategy keeps
 * producing the same numbers.
 */

/** Simple moving average. Undefined before the window is full. */
export function smaSeriesFull(values: readonly number[], period: number): number[] {
  const series = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) series[index] = sum / period;
  }
  return series;
}

/**
 * Exponential moving average seeded with the simple average of the first
 * `period` values, which is how this repository has always computed it.
 */
export function emaSeriesFull(values: readonly number[], period: number): number[] {
  const series = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < period) return series;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let index = 0; index < period; index += 1) seed += values[index];
  let ema = seed / period;
  series[period - 1] = ema;
  for (let index = period; index < values.length; index += 1) {
    ema = values[index] * k + ema * (1 - k);
    series[index] = ema;
  }
  return series;
}

/** Wilder's relative strength index, seeded with the first `period` changes. */
export function rsiSeriesFull(values: readonly number[], period: number): number[] {
  const series = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < period + 1) return series;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const difference = values[index] - values[index - 1];
    if (difference >= 0) gains += difference;
    else losses += Math.abs(difference);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  series[period] = rsiFrom(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    const gain = difference > 0 ? difference : 0;
    const loss = difference < 0 ? Math.abs(difference) : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    series[index] = rsiFrom(averageGain, averageLoss);
  }
  return series;
}

function rsiFrom(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

/** Average true range, the simple average of the true ranges inside the window. */
export function atrSeriesFull(candles: readonly CandleLike[], period: number): number[] {
  const series = new Array<number>(candles.length).fill(Number.NaN);
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  for (let index = period; index < candles.length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += trueRanges[index - offset - 1];
    series[index] = sum / period;
  }
  return series;
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

const legacySma: Adapter = (candles, params) => ({ sma: smaSeriesFull(closes(candles), params.period) });
const legacyEma: Adapter = (candles, params) => ({ ema: emaSeriesFull(closes(candles), params.period) });
const legacyRsi: Adapter = (candles, params) => ({ rsi: rsiSeriesFull(closes(candles), params.period) });
const legacyAtr: Adapter = (candles, params) => ({ atr: atrSeriesFull(candles, params.period) });

const apoAdapter: Adapter = (candles, params) => ({
  apo: seriesOf(apo(closes(candles), { fast: params.fastPeriod, slow: params.slowPeriod }), candles.length),
});

const aroonAdapter: Adapter = (candles, params) => {
  const result = aroon(highs(candles), lows(candles), { period: params.period });
  return { up: seriesOf(result.up, candles.length), down: seriesOf(result.down, candles.length) };
};

const bopAdapter: Adapter = (candles, params) => ({
  bop: seriesOf(bop(opens(candles), highs(candles), lows(candles), closes(candles)), candles.length),
});

const cfoAdapter: Adapter = (candles, params) => ({
  cfo: seriesOf(mcfo(closes(candles), { period: params.period }), candles.length),
});

const cciAdapter: Adapter = (candles, params) => ({
  cci: seriesOf(cci(highs(candles), lows(candles), closes(candles), { period: params.period }), candles.length),
});

const demaAdapter: Adapter = (candles, params) => ({
  dema: seriesOf(dema(closes(candles), { period: params.period }), candles.length),
});

const massIndexAdapter: Adapter = (candles, params) => ({
  mi: seriesOf(massIndex(highs(candles), lows(candles), { emaPeriod: params.emaPeriod, miPeriod: params.miPeriod }), candles.length),
});

const macdAdapter: Adapter = (candles, params) => {
  const result = macd(closes(candles), { fast: params.fastPeriod, slow: params.slowPeriod, signal: params.signalPeriod });
  const macdLine = seriesOf(result.macdLine, candles.length);
  const signal = seriesOf(result.signalLine, candles.length);
  return { macd: macdLine, signal, histogram: zip(macdLine, signal, candles.length, (a, b) => a - b) };
};

const movingMaxAdapter: Adapter = (candles, params) => ({
  mmax: seriesOf(mmax(closes(candles), { period: params.period }), candles.length),
});

const movingMinAdapter: Adapter = (candles, params) => ({
  mmin: seriesOf(mmin(closes(candles), { period: params.period }), candles.length),
});

const movingSumAdapter: Adapter = (candles, params) => ({
  msum: seriesOf(msum(closes(candles), { period: params.period }), candles.length),
});

const psarAdapter: Adapter = (candles, params) => {
  const result = psar(highs(candles), lows(candles), closes(candles), { step: params.step, max: params.max });
  return {
    psar: seriesOf(result.psarResult, candles.length),
    trend: seriesOf(result.trends.map(value => Number(value)), candles.length),
  };
};

const qstickAdapter: Adapter = (candles, params) => ({
  qstick: seriesOf(qstick(opens(candles), closes(candles), { period: params.period }), candles.length),
});

const kdjAdapter: Adapter = (candles, params) => {
  const result = kdj(highs(candles), lows(candles), closes(candles), {
    rPeriod: params.rPeriod, kPeriod: params.kPeriod, dPeriod: params.dPeriod,
  });
  return { k: seriesOf(result.k, candles.length), d: seriesOf(result.d, candles.length), j: seriesOf(result.j, candles.length) };
};

const rmaAdapter: Adapter = (candles, params) => ({
  rma: seriesOf(rma(closes(candles), { period: params.period }), candles.length),
});

const sinceAdapter: Adapter = candles => ({ since: seriesOf(since(closes(candles)), candles.length) });

const temaAdapter: Adapter = (candles, params) => ({
  tema: seriesOf(tema(closes(candles), { period: params.period }), candles.length),
});

const trimaAdapter: Adapter = (candles, params) => ({
  trima: seriesOf(trima(closes(candles), { period: params.period }), candles.length),
});

const trixAdapter: Adapter = (candles, params) => ({
  trix: seriesOf(trix(closes(candles), { period: params.period }), candles.length),
});

const typicalPriceAdapter: Adapter = candles => ({
  typprice: seriesOf(typprice(highs(candles), lows(candles), closes(candles)), candles.length),
});

const vwmaAdapter: Adapter = (candles, params) => ({
  vwma: seriesOf(vwma(closes(candles), volumes(candles), { period: params.period }), candles.length),
});

const vortexAdapter: Adapter = (candles, params) => {
  const result = vortex(highs(candles), lows(candles), closes(candles), { period: params.period });
  return { plus: seriesOf(result.plus, candles.length), minus: seriesOf(result.minus, candles.length) };
};

const awesomeOscillatorAdapter: Adapter = (candles, params) => ({
  ao: seriesOf(ao(highs(candles), lows(candles), { fast: params.fastPeriod, slow: params.slowPeriod }), candles.length),
});

const chaikinOscillatorAdapter: Adapter = (candles, params) => {
  const result = cmo(highs(candles), lows(candles), closes(candles), volumes(candles), {
    fast: params.fastPeriod, slow: params.slowPeriod,
  });
  return { ad: seriesOf(result.adResult, candles.length), cmo: seriesOf(result.cmoResult, candles.length) };
};

/**
 * Ichimoku, re-aligned to the decision candle.
 *
 * The upstream `ichimokuCloud` returns:
 *
 *   `tenkan`, `kijun`  aligned to the candle they were computed from.
 *   `ssa`, `ssb`       already projected forward, so the value stored at
 *                      position j belongs to the candle j minus the
 *                      displacement. Reading them at the current candle
 *                      would show an old cloud.
 *   `laggingSpan`      already projected backward, so the value stored at
 *                      position j is the close of candle j plus the
 *                      displacement, which is a future close.
 *
 * Every output here is therefore rebuilt so that the value at position i
 * only ever depends on candles up to and including i.
 *
 *   tenkan[i]   the conversion line computed at candle i.
 *   kijun[i]    the base line computed at candle i.
 *   spanA[i]    (tenkan[i] + kijun[i]) / 2 — the cloud boundary computed at
 *               candle i, which the standard chart draws 26 candles ahead.
 *   spanB[i]    the leading boundary computed at candle i, over the long
 *               window.
 *   lagging[i]  the close of candle i, which the standard chart draws 26
 *               candles back.
 */
const ichimokuAdapter: Adapter = (candles, params) => {
  const length = candles.length;
  const high = highs(candles);
  const low = lows(candles);
  const close = closes(candles);
  const cloud = ichimokuCloud(high, low, close, {
    short: params.shortPeriod,
    medium: params.mediumPeriod,
    long: params.longPeriod,
    close: params.displacement,
  });
  const tenkan = seriesOf(cloud.tenkan, length);
  const kijun = seriesOf(cloud.kijun, length);
  const spanA = zip(tenkan, kijun, length, (a, b) => (a + b) / 2);
  // The upstream Senkou Span B stops `long - 1` candles before the end of
  // the array, so the boundary is rebuilt from the library's own rolling
  // maximum and minimum over the same long window.
  const longHigh = seriesOf(mmax(high, { period: params.longPeriod }), length);
  const longLow = seriesOf(mmin(low, { period: params.longPeriod }), length);
  const spanB = zip(longHigh, longLow, length, (a, b) => (a + b) / 2);
  const cloudTop = zip(spanA, spanB, length, (a, b) => (a > b ? a : b));
  const cloudBottom = zip(spanA, spanB, length, (a, b) => (a < b ? a : b));
  return { tenkan, kijun, spanA, spanB, cloudTop, cloudBottom, laggingSpan: close.slice() };
};

const ppoAdapter: Adapter = (candles, params) => {
  const result = ppo(closes(candles), { fast: params.fastPeriod, slow: params.slowPeriod, signal: params.signalPeriod });
  const line = seriesOf(result.ppoResult, candles.length);
  const signal = seriesOf(result.signal, candles.length);
  return { ppo: line, signal, histogram: zip(line, signal, candles.length, (a, b) => a - b) };
};

const pvoAdapter: Adapter = (candles, params) => {
  const result = pvo(volumes(candles), { fast: params.fastPeriod, slow: params.slowPeriod, signal: params.signalPeriod });
  const line = seriesOf(result.pvoResult, candles.length);
  const signal = seriesOf(result.signal, candles.length);
  return { pvo: line, signal, histogram: zip(line, signal, candles.length, (a, b) => a - b) };
};

const rocAdapter: Adapter = (candles, params) => ({
  roc: seriesOf(roc(closes(candles), { period: params.period }), candles.length),
});

const stochasticAdapter: Adapter = (candles, params) => {
  const result = stoch(highs(candles), lows(candles), closes(candles), { kPeriod: params.kPeriod, dPeriod: params.dPeriod });
  return { k: seriesOf(result.k, candles.length), d: seriesOf(result.d, candles.length) };
};

const williamsAdapter: Adapter = (candles, params) => ({
  willr: seriesOf(willr(highs(candles), lows(candles), closes(candles), { period: params.period }), candles.length),
});

const accelerationBandsAdapter: Adapter = (candles, params) => {
  const result = ab(highs(candles), lows(candles), closes(candles), { period: params.period, multiplier: params.multiplier });
  return {
    upper: seriesOf(result.upper, candles.length),
    middle: seriesOf(result.middle, candles.length),
    lower: seriesOf(result.lower, candles.length),
  };
};

const bollingerBandsAdapter: Adapter = (candles, params) => {
  const result = bb(closes(candles), { period: params.period });
  return {
    upper: seriesOf(result.upper, candles.length),
    middle: seriesOf(result.middle, candles.length),
    lower: seriesOf(result.lower, candles.length),
  };
};

const bollingerWidthAdapter: Adapter = (candles, params) => {
  const bands = bb(closes(candles), { period: params.period });
  const result = bbw(bands, { period: params.smoothingPeriod });
  return { width: seriesOf(result.width, candles.length), widthEma: seriesOf(result.widthEma, candles.length) };
};

const chandelierExitAdapter: Adapter = (candles, params) => {
  const result = ce(highs(candles), lows(candles), closes(candles), { period: params.period });
  return { long: seriesOf(result.long, candles.length), short: seriesOf(result.short, candles.length) };
};

const donchianAdapter: Adapter = (candles, params) => {
  const result = dc(closes(candles), { period: params.period });
  return {
    upper: seriesOf(result.upper, candles.length),
    middle: seriesOf(result.middle, candles.length),
    lower: seriesOf(result.lower, candles.length),
  };
};

const keltnerAdapter: Adapter = (candles, params) => {
  const result = kc(highs(candles), lows(candles), closes(candles), { period: params.period });
  return {
    middle: seriesOf(result.middle, candles.length),
    upper: seriesOf(result.upper, candles.length),
    lower: seriesOf(result.lower, candles.length),
  };
};

const movingStandardDeviationAdapter: Adapter = (candles, params) => ({
  mstd: seriesOf(mstd(closes(candles), { period: params.period }), candles.length),
});

const projectionOscillatorAdapter: Adapter = (candles, params) => {
  const result = po(highs(candles), lows(candles), closes(candles), { period: params.period, smooth: params.smoothPeriod });
  return { po: seriesOf(result.poResult, candles.length), spo: seriesOf(result.spoResult, candles.length) };
};

const trueRangeAdapter: Adapter = candles => ({
  tr: seriesOf(tr(highs(candles), lows(candles), closes(candles)), candles.length),
});

const ulcerIndexAdapter: Adapter = (candles, params) => ({
  ui: seriesOf(ui(closes(candles), { period: params.period }), candles.length),
});

const accumulationDistributionAdapter: Adapter = candles => ({
  ad: seriesOf(ad(highs(candles), lows(candles), closes(candles), volumes(candles)), candles.length),
});

const chaikinMoneyFlowAdapter: Adapter = (candles, params) => ({
  cmf: seriesOf(chaikinMoneyFlow(highs(candles), lows(candles), closes(candles), volumes(candles), { period: params.period }), candles.length),
});

const easeOfMovementAdapter: Adapter = (candles, params) => ({
  emv: seriesOf(emv(highs(candles), lows(candles), volumes(candles), { period: params.period }), candles.length),
});

const forceIndexAdapter: Adapter = (candles, params) => ({
  fi: seriesOf(fi(closes(candles), volumes(candles), { period: params.period }), candles.length),
});

const moneyFlowIndexAdapter: Adapter = (candles, params) => ({
  mfi: seriesOf(mfi(highs(candles), lows(candles), closes(candles), volumes(candles), { period: params.period }), candles.length),
});

const negativeVolumeIndexAdapter: Adapter = (candles, params) => ({
  nvi: seriesOf(nvi(closes(candles), volumes(candles), { start: params.start, period: params.period }), candles.length),
});

const onBalanceVolumeAdapter: Adapter = candles => ({
  obv: seriesOf(obv(closes(candles), volumes(candles)), candles.length),
});

const volumePriceTrendAdapter: Adapter = candles => ({
  vpt: seriesOf(vpt(closes(candles), volumes(candles)), candles.length),
});

const vwapAdapter: Adapter = (candles, params) => ({
  vwap: seriesOf(vwap(closes(candles), volumes(candles), { period: params.period }), candles.length),
});

const ADAPTERS: Record<string, Adapter> = {
  APO: apoAdapter,
  AROON: aroonAdapter,
  BOP: bopAdapter,
  CFO: cfoAdapter,
  CCI: cciAdapter,
  DEMA: demaAdapter,
  EMA: legacyEma,
  MI: massIndexAdapter,
  MACD: macdAdapter,
  MMAX: movingMaxAdapter,
  MMIN: movingMinAdapter,
  MSUM: movingSumAdapter,
  PSAR: psarAdapter,
  QSTICK: qstickAdapter,
  KDJ: kdjAdapter,
  RMA: rmaAdapter,
  SMA: legacySma,
  SINCE: sinceAdapter,
  TEMA: temaAdapter,
  TRIMA: trimaAdapter,
  TRIX: trixAdapter,
  TYPPRICE: typicalPriceAdapter,
  VWMA: vwmaAdapter,
  VORTEX: vortexAdapter,
  AO: awesomeOscillatorAdapter,
  CMO: chaikinOscillatorAdapter,
  ICHIMOKU: ichimokuAdapter,
  PPO: ppoAdapter,
  PVO: pvoAdapter,
  ROC: rocAdapter,
  RSI: legacyRsi,
  STOCH: stochasticAdapter,
  WILLR: williamsAdapter,
  AB: accelerationBandsAdapter,
  ATR: legacyAtr,
  BB: bollingerBandsAdapter,
  BBW: bollingerWidthAdapter,
  CE: chandelierExitAdapter,
  DC: donchianAdapter,
  KC: keltnerAdapter,
  MSTD: movingStandardDeviationAdapter,
  PO: projectionOscillatorAdapter,
  TR: trueRangeAdapter,
  UI: ulcerIndexAdapter,
  AD: accumulationDistributionAdapter,
  CMF: chaikinMoneyFlowAdapter,
  EMV: easeOfMovementAdapter,
  FI: forceIndexAdapter,
  MFI: moneyFlowIndexAdapter,
  NVI: negativeVolumeIndexAdapter,
  OBV: onBalanceVolumeAdapter,
  VPT: volumePriceTrendAdapter,
  VWAP: vwapAdapter,
};

/**
 * The mask applied to every series: the first `warmup - 1` entries are
 * removed and every non-finite value becomes `NaN`.
 */
function mask(series: number[], warmupRequired: number): number[] {
  const masked = new Array<number>(series.length);
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index];
    masked[index] = index + 1 >= warmupRequired && Number.isFinite(value) ? value : Number.NaN;
  }
  return masked;
}

/**
 * Calculates one indicator over the given candles.
 *
 * The returned series are aligned to the candles, one value per candle, and
 * `NaN` wherever the value does not exist.
 */
export function calculateIndicator(
  key: string,
  candles: readonly CandleLike[],
  params: Readonly<Record<string, number>> = {},
): CalculatedIndicator {
  const adapter = ADAPTERS[key];
  if (!adapter) throw new Error(`No calculation adapter for indicator "${key}".`);
  const resolved = resolveIndicatorParams(key, params);
  const calculated = adapter(candles, resolved);
  const warmupRequired = indicatorWarmup(key, resolved);
  const series: Record<string, number[]> = {};
  for (const [output, values] of Object.entries(calculated)) {
    series[output] = mask(values, warmupRequired);
  }
  return { series };
}

/** The warm-up requirement of an indicator, in completed candles. */
export function indicatorWarmup(key: string, params: Readonly<Record<string, number>> = {}): number {
  const entry: IndicatorCatalogEntry | undefined = indicatorCatalogEntry(key);
  if (!entry) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.ceil(entry.warmup(resolveIndicatorParams(key, params))));
}

/** The catalog keys that have a calculation adapter. */
export const CALCULATED_INDICATOR_KEYS: readonly string[] = Object.freeze(Object.keys(ADAPTERS));
