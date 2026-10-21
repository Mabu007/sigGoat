/**
 * INDICATOR CATALOG — THE SINGLE SOURCE OF TRUTH
 * ===============================================
 *
 * Every indicator the TradingVibes strategy builder can use is described
 * exactly once, here. The user interface, the schema validation, the
 * calculation dispatch and the AI drafting prompt all read this catalog, so
 * they cannot drift apart.
 *
 * THE CATALOG IS THE OFFICIAL `cinar/indicatorts` CATALOG
 *
 * The upstream library (https://github.com/cinar/indicatorts, npm
 * `indicatorts@2.2.2`) publishes 53 indicators:
 *
 *   trend     24   momentum  9   volatility 11   volume  9   =  53
 *
 * The count is verified against the installed package, not against prose.
 * See `tests/indicatorCatalog.test.ts`, which asserts the catalog is exactly
 * the set of indicators the installed library exports, and nothing else.
 *
 * WHY THE CATALOG HOLDS NO ARITHMETIC
 *
 * The catalog is pure metadata: names, parameters, outputs, warm-up. The
 * arithmetic lives in `./calculations`, which is the only module that imports
 * the upstream package. The split matters because the browser bundle of the
 * strategy builder needs the catalog (to render pickers) and must not carry
 * the whole indicator library.
 *
 * `source` records where a series actually comes from:
 *
 *   'indicatorts'     computed by the upstream package.
 *   'legacy-series'   computed by this repository's own warm-up aware series
 *                     functions, which predate the library integration.
 *
 * The four legacy entries (SMA, EMA, RSI, ATR) are marked 'legacy-series' on
 * purpose. Persisted strategies built before the library integration must
 * keep producing the exact same numbers, and the legacy RSI and EMA seedings
 * differ from the library's. Switching them silently would reinterpret
 * strategies that people already backtested. `tests/strategyRegression.test.ts`
 * pins that behaviour.
 */

export type IndicatorCategory = 'trend' | 'momentum' | 'volatility' | 'volume';

export type IndicatorInput = 'open' | 'high' | 'low' | 'close' | 'volume';

export type IndicatorParameterType = 'integer' | 'number';

export interface IndicatorParameterDefinition {
  /** Stable machine name, also the key used in persisted strategies. */
  key: string;
  /** Human label shown in the builder. */
  label: string;
  type: IndicatorParameterType;
  default: number;
  min: number;
  max: number;
  step: number;
  description: string;
}

export interface IndicatorOutputDefinition {
  /** Stable machine name, also the key used in condition operands. */
  key: string;
  label: string;
  description: string;
}

export interface IndicatorCatalogEntry {
  /** Stable machine name, e.g. `MACD`. */
  key: string;
  /** Full readable name shown in the picker. */
  name: string;
  /** Short readable name shown once the indicator is added. */
  shortName: string;
  category: IndicatorCategory;
  description: string;
  source: 'indicatorts' | 'legacy-series';
  /** OHLCV fields the indicator needs. */
  inputs: readonly IndicatorInput[];
  parameters: readonly IndicatorParameterDefinition[];
  /** Every series this indicator can expose to a condition. */
  outputs: readonly IndicatorOutputDefinition[];
  /**
   * The number of completed candles the indicator needs before its series is
   * considered trustworthy. Longer than the mathematical minimum on purpose
   * where a seeded average still has to settle.
   */
  warmup: (params: Readonly<Record<string, number>>) => number;
  /** Anything a user should know that the description does not say. */
  notes?: string;
}

const period = (
  key: string,
  label: string,
  value: number,
  description: string,
  max = 500,
): IndicatorParameterDefinition => ({
  key, label, type: 'integer', default: value, min: 2, max, step: 1, description,
});

const numberParam = (
  key: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  description: string,
): IndicatorParameterDefinition => ({
  key, label, type: 'number', default: value, min, max, step, description,
});

const output = (key: string, label: string, description: string): IndicatorOutputDefinition => ({ key, label, description });

const sum = (params: Readonly<Record<string, number>>, ...keys: string[]) =>
  keys.reduce((total, key) => total + (params[key] ?? 0), 0);

const p = (params: Readonly<Record<string, number>>, key: string, fallback: number) => {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/* ------------------------------------------------------------------ */
/* TREND — 24 indicators                                               */
/* ------------------------------------------------------------------ */

const TREND: IndicatorCatalogEntry[] = [
  {
    key: 'APO',
    name: 'Absolute Price Oscillator (APO)',
    shortName: 'APO',
    category: 'trend',
    description: 'Distance between a fast and a slow exponential moving average of the close, in price units. Positive means the fast average is above the slow one.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [
      period('fastPeriod', 'Fast period', 14, 'Exponential moving average length for the fast line.'),
      period('slowPeriod', 'Slow period', 30, 'Exponential moving average length for the slow line.'),
    ],
    outputs: [output('apo', 'APO', 'Fast EMA minus slow EMA.')],
    warmup: params => p(params, 'slowPeriod', 30),
  },
  {
    key: 'AROON',
    name: 'Aroon Indicator',
    shortName: 'Aroon',
    category: 'trend',
    description: 'Measures how recently the highest high and the lowest low occurred inside the lookback window, as a percentage.',
    source: 'indicatorts',
    inputs: ['high', 'low'],
    parameters: [period('period', 'Period', 25, 'Lookback window used to measure the age of the extremes.')],
    outputs: [
      output('up', 'Aroon Up', 'Strength of the uptrend, 0 to 100.'),
      output('down', 'Aroon Down', 'Strength of the downtrend, 0 to 100.'),
    ],
    warmup: params => p(params, 'period', 25),
  },
  {
    key: 'BOP',
    name: 'Balance of Power (BOP)',
    shortName: 'BOP',
    category: 'trend',
    description: 'Compares where the candle closed inside its own range, showing whether buyers or sellers controlled the bar.',
    source: 'indicatorts',
    inputs: ['open', 'high', 'low', 'close'],
    parameters: [],
    outputs: [output('bop', 'BOP', 'Close minus open, divided by the candle range.')],
    warmup: () => 1,
    notes: 'A candle with no range has no defined balance of power and is reported as unavailable.',
  },
  {
    key: 'CFO',
    name: 'Chande Forecast Oscillator (CFO)',
    shortName: 'CFO',
    category: 'trend',
    description: 'Percentage difference between the close and the linear regression forecast of the close over the same window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Window used for the local linear regression forecast.')],
    outputs: [output('cfo', 'CFO', 'Close versus its local regression forecast, in percent.')],
    warmup: params => p(params, 'period', 4),
    notes: 'The library also exports a whole-series `cfo`, which regresses over every candle in the array and therefore reads future candles. The windowed moving variant is used here instead so a signal never sees data it could not have had.',
  },
  {
    key: 'CCI',
    name: 'Community Channel Index (CCI)',
    shortName: 'CCI',
    category: 'trend',
    description: 'Deviation of the typical price from its moving average, scaled by the mean deviation. Commonly used as an overbought/oversold oscillator.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 20, 'Moving average window for the typical price.')],
    outputs: [output('cci', 'CCI', 'Scaled deviation of the typical price from its average.')],
    warmup: params => p(params, 'period', 20),
    notes: 'The upstream library names this indicator "Community Channel Index"; it is the same calculation that is usually called the Commodity Channel Index.',
  },
  {
    key: 'DEMA',
    name: 'Double Exponential Moving Average (DEMA)',
    shortName: 'DEMA',
    category: 'trend',
    description: 'Moving average that reduces the lag of a plain exponential average by subtracting a second exponential average of the first.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 12, 'Base exponential moving average length.')],
    outputs: [output('dema', 'DEMA', 'The double exponential moving average value.')],
    warmup: params => p(params, 'period', 12) * 2,
  },
  {
    key: 'EMA',
    name: 'Exponential Moving Average (EMA)',
    shortName: 'EMA',
    category: 'trend',
    description: 'Moving average that gives more weight to recent closes.',
    source: 'legacy-series',
    inputs: ['close'],
    parameters: [period('period', 'Period', 12, 'Exponential moving average length.')],
    outputs: [output('ema', 'EMA', 'The exponential moving average value.')],
    warmup: params => p(params, 'period', 12),
    notes: 'Kept on this repository\'s own warm-up aware series so strategies saved before the library integration keep identical numbers.',
  },
  {
    key: 'MI',
    name: 'Mass Index (MI)',
    shortName: 'Mass Index',
    category: 'trend',
    description: 'Uses range expansion to flag potential trend reversals.',
    source: 'indicatorts',
    inputs: ['high', 'low'],
    parameters: [
      period('emaPeriod', 'EMA period', 9, 'Length of the two exponential averages applied to the high-low range.'),
      period('miPeriod', 'Summation period', 25, 'Number of range ratios summed into the index.'),
    ],
    outputs: [output('mi', 'Mass Index', 'The mass index value.')],
    warmup: params => p(params, 'emaPeriod', 9) * 2 + p(params, 'miPeriod', 25),
  },
  {
    key: 'MACD',
    name: 'Moving Average Convergence Divergence (MACD)',
    shortName: 'MACD',
    category: 'trend',
    description: 'Difference between a fast and a slow exponential moving average, with its own signal line.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [
      period('fastPeriod', 'Fast period', 12, 'Fast exponential moving average length.'),
      period('slowPeriod', 'Slow period', 26, 'Slow exponential moving average length.'),
      period('signalPeriod', 'Signal period', 9, 'Exponential moving average length of the signal line.'),
    ],
    outputs: [
      output('macd', 'MACD line', 'Fast EMA minus slow EMA.'),
      output('signal', 'Signal line', 'Exponential moving average of the MACD line.'),
      output('histogram', 'Histogram', 'MACD line minus signal line.'),
    ],
    warmup: params => p(params, 'slowPeriod', 26) + p(params, 'signalPeriod', 9) * 2,
  },
  {
    key: 'MMAX',
    name: 'Moving Max (MMAX)',
    shortName: 'Moving Max',
    category: 'trend',
    description: 'Highest value reached inside the lookback window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Lookback window length.')],
    outputs: [output('mmax', 'Moving Max', 'The highest close inside the window.')],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'MMIN',
    name: 'Moving Min (MMIN)',
    shortName: 'Moving Min',
    category: 'trend',
    description: 'Lowest value reached inside the lookback window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Lookback window length.')],
    outputs: [output('mmin', 'Moving Min', 'The lowest close inside the window.')],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'MSUM',
    name: 'Moving Sum (MSUM)',
    shortName: 'Moving Sum',
    category: 'trend',
    description: 'Sum of the values inside the lookback window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Lookback window length.')],
    outputs: [output('msum', 'Moving Sum', 'The rolling sum of closes.')],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'PSAR',
    name: 'Parabolic SAR (PSAR)',
    shortName: 'PSAR',
    category: 'trend',
    description: 'Trailing stop and reverse level that accelerates when a trend extends.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      numberParam('step', 'Step', 0.02, 0.001, 0.5, 0.001, 'Acceleration added to the stop each time a new extreme is made.'),
      numberParam('max', 'Maximum step', 0.2, 0.01, 1, 0.01, 'Largest acceleration the stop may reach.'),
    ],
    outputs: [
      output('psar', 'SAR', 'The parabolic stop and reverse price.'),
      output('trend', 'Trend', '1 while the trend is rising, -1 while it is falling.'),
    ],
    warmup: () => 2,
  },
  {
    key: 'QSTICK',
    name: 'Qstick',
    shortName: 'Qstick',
    category: 'trend',
    description: 'Moving average of the difference between the close and the open.',
    source: 'indicatorts',
    inputs: ['open', 'close'],
    parameters: [period('period', 'Period', 14, 'Moving average length of the close-open difference.')],
    outputs: [output('qstick', 'Qstick', 'The smoothed close-open difference.')],
    warmup: params => p(params, 'period', 14),
  },
  {
    key: 'KDJ',
    name: 'Random Index (KDJ)',
    shortName: 'KDJ',
    category: 'trend',
    description: 'Stochastic oscillator with a divergence line, used to spot momentum shifts inside a range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      period('rPeriod', 'Range period', 9, 'Window used to find the highest high and lowest low.'),
      period('kPeriod', 'K period', 3, 'Smoothing length of the K line.'),
      period('dPeriod', 'D period', 3, 'Smoothing length of the D line.'),
    ],
    outputs: [
      output('k', 'K', 'The fast stochastic line.'),
      output('d', 'D', 'The slow stochastic line.'),
      output('j', 'J', 'The divergence line, 3K minus 2D.'),
    ],
    warmup: params => p(params, 'rPeriod', 9) + p(params, 'kPeriod', 3) + p(params, 'dPeriod', 3),
  },
  {
    key: 'RMA',
    name: 'Rolling Moving Average (RMA)',
    shortName: 'RMA',
    category: 'trend',
    description: "Wilder's smoothed moving average, the smoothing used by RSI and ATR.",
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Smoothing length.')],
    outputs: [output('rma', 'RMA', 'The Wilder smoothed moving average.')],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'SMA',
    name: 'Simple Moving Average (SMA)',
    shortName: 'SMA',
    category: 'trend',
    description: 'Arithmetic mean of the closes inside the lookback window.',
    source: 'legacy-series',
    inputs: ['close'],
    parameters: [period('period', 'Period', 20, 'Moving average length.')],
    outputs: [output('sma', 'SMA', 'The simple moving average value.')],
    warmup: params => p(params, 'period', 20),
    notes: 'Kept on this repository\'s own warm-up aware series so strategies saved before the library integration keep identical numbers.',
  },
  {
    key: 'SINCE',
    name: 'Since Change',
    shortName: 'Since Change',
    category: 'trend',
    description: 'Number of candles since the value last changed.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [],
    outputs: [output('since', 'Since', 'Bars since the previous close was different.')],
    warmup: () => 1,
  },
  {
    key: 'TEMA',
    name: 'Triple Exponential Moving Average (TEMA)',
    shortName: 'TEMA',
    category: 'trend',
    description: 'Smooths a moving average three times to further reduce lag.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 2, 'Base exponential moving average length.')],
    outputs: [output('tema', 'TEMA', 'The triple exponential moving average value.')],
    warmup: params => p(params, 'period', 2) * 3,
  },
  {
    key: 'TRIMA',
    name: 'Triangular Moving Average (TRIMA)',
    shortName: 'TRIMA',
    category: 'trend',
    description: 'A twice smoothed simple moving average, which weights the middle of the window more heavily.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Base moving average length.')],
    outputs: [output('trima', 'TRIMA', 'The triangular moving average value.')],
    warmup: params => p(params, 'period', 4) * 2,
  },
  {
    key: 'TRIX',
    name: 'Triple Exponential Average (TRIX)',
    shortName: 'TRIX',
    category: 'trend',
    description: 'Rate of change of a triple smoothed exponential moving average.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Base exponential moving average length.')],
    outputs: [output('trix', 'TRIX', 'Percentage change of the triple smoothed average.')],
    warmup: params => p(params, 'period', 4) * 3 + 1,
  },
  {
    key: 'TYPPRICE',
    name: 'Typical Price',
    shortName: 'Typical Price',
    category: 'trend',
    description: 'Average of the high, the low and the close of a candle.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [],
    outputs: [output('typprice', 'Typical Price', 'The typical price of the candle.')],
    warmup: () => 1,
  },
  {
    key: 'VWMA',
    name: 'Volume Weighted Moving Average (VWMA)',
    shortName: 'VWMA',
    category: 'trend',
    description: 'Moving average that weights each close by the volume traded in that candle.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [period('period', 'Period', 20, 'Moving average length.')],
    outputs: [output('vwma', 'VWMA', 'The volume weighted moving average value.')],
    warmup: params => p(params, 'period', 20),
  },
  {
    key: 'VORTEX',
    name: 'Vortex Indicator',
    shortName: 'Vortex',
    category: 'trend',
    description: 'Two lines that cross when a trend changes direction, built from the movement of the true range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 14, 'Smoothing window of the true range sums.')],
    outputs: [
      output('plus', 'Vortex Plus', 'Upward movement relative to the true range.'),
      output('minus', 'Vortex Minus', 'Downward movement relative to the true range.'),
    ],
    warmup: params => p(params, 'period', 14) + 1,
  },
];

/* ------------------------------------------------------------------ */
/* MOMENTUM — 9 indicators                                              */
/* ------------------------------------------------------------------ */

const MOMENTUM: IndicatorCatalogEntry[] = [
  {
    key: 'AO',
    name: 'Awesome Oscillator (AO)',
    shortName: 'AO',
    category: 'momentum',
    description: 'Difference between a fast and a slow average of the candle midpoints.',
    source: 'indicatorts',
    inputs: ['high', 'low'],
    parameters: [
      period('fastPeriod', 'Fast period', 5, 'Length of the fast average.'),
      period('slowPeriod', 'Slow period', 34, 'Length of the slow average.'),
    ],
    outputs: [output('ao', 'AO', 'Fast average minus slow average.')],
    warmup: params => p(params, 'slowPeriod', 34),
  },
  {
    key: 'CMO',
    name: 'Chaikin Oscillator (CMO)',
    shortName: 'CMO',
    category: 'momentum',
    description: 'Difference between a fast and a slow exponential average of the accumulation/distribution line.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close', 'volume'],
    parameters: [
      period('fastPeriod', 'Fast period', 3, 'Length of the fast exponential average.'),
      period('slowPeriod', 'Slow period', 10, 'Length of the slow exponential average.'),
    ],
    outputs: [
      output('ad', 'Accumulation/Distribution', 'The accumulation/distribution line the oscillator is built on.'),
      output('cmo', 'Chaikin Oscillator', 'Fast average minus slow average of the accumulation/distribution line.'),
    ],
    warmup: params => p(params, 'slowPeriod', 10),
  },
  {
    key: 'ICHIMOKU',
    name: 'Ichimoku Cloud',
    shortName: 'Ichimoku',
    category: 'momentum',
    description: 'A cloud of support and resistance built from three moving averages of the candle range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      period('shortPeriod', 'Conversion period', 9, 'Window for the Tenkan-sen line.'),
      period('mediumPeriod', 'Base period', 26, 'Window for the Kijun-sen line and the forward displacement.'),
      period('longPeriod', 'Leading period', 52, 'Window for the Senkou Span B line.'),
      period('displacement', 'Displacement', 26, 'How many candles the cloud is projected forward.'),
    ],
    outputs: [
      output('tenkan', 'Tenkan-sen', 'Conversion line, the midpoint of the short window.'),
      output('kijun', 'Kijun-sen', 'Base line, the midpoint of the medium window.'),
      output('spanA', 'Senkou Span A', 'Cloud boundary computed at this candle.'),
      output('spanB', 'Senkou Span B', 'Cloud boundary computed at this candle.'),
      output('cloudTop', 'Cloud top', 'The higher of the two cloud boundaries.'),
      output('cloudBottom', 'Cloud bottom', 'The lower of the two cloud boundaries.'),
      output('laggingSpan', 'Lagging span', 'The current close, which the standard chart plots 26 candles back.'),
    ],
    warmup: params => p(params, 'longPeriod', 52),
    notes: 'The upstream library returns the cloud lines already displaced forward and the lagging span already displaced backward, so reading them at the current candle would either plot into the future or read a future close. Every output here is re-aligned to the decision candle: the cloud outputs are the values computed at this candle, and the lagging span is the current close.',
  },
  {
    key: 'PPO',
    name: 'Percentage Price Oscillator (PPO)',
    shortName: 'PPO',
    category: 'momentum',
    description: 'Percentage difference between a fast and a slow exponential average of the close.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [
      period('fastPeriod', 'Fast period', 12, 'Fast exponential moving average length.'),
      period('slowPeriod', 'Slow period', 26, 'Slow exponential moving average length.'),
      period('signalPeriod', 'Signal period', 9, 'Exponential moving average length of the signal line.'),
    ],
    outputs: [
      output('ppo', 'PPO', 'Percentage difference between the two averages.'),
      output('signal', 'Signal', 'Exponential moving average of the PPO line.'),
      output('histogram', 'Histogram', 'PPO line minus signal line.'),
    ],
    warmup: params => p(params, 'slowPeriod', 26) + p(params, 'signalPeriod', 9) * 2,
  },
  {
    key: 'PVO',
    name: 'Percentage Volume Oscillator (PVO)',
    shortName: 'PVO',
    category: 'momentum',
    description: 'Percentage difference between a fast and a slow exponential average of the volume.',
    source: 'indicatorts',
    inputs: ['volume'],
    parameters: [
      period('fastPeriod', 'Fast period', 12, 'Fast exponential moving average length.'),
      period('slowPeriod', 'Slow period', 26, 'Slow exponential moving average length.'),
      period('signalPeriod', 'Signal period', 9, 'Exponential moving average length of the signal line.'),
    ],
    outputs: [
      output('pvo', 'PVO', 'Percentage difference between the two volume averages.'),
      output('signal', 'Signal', 'Exponential moving average of the PVO line.'),
      output('histogram', 'Histogram', 'PVO line minus signal line.'),
    ],
    warmup: params => p(params, 'slowPeriod', 26) + p(params, 'signalPeriod', 9) * 2,
  },
  {
    key: 'ROC',
    name: 'Price Rate of Change (ROC)',
    shortName: 'ROC',
    category: 'momentum',
    description: 'Percentage change of the close against the value a fixed number of candles ago.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 3, 'Number of candles to compare against.')],
    outputs: [output('roc', 'ROC', 'Percentage change over the period.')],
    warmup: params => p(params, 'period', 3) + 1,
  },
  {
    key: 'RSI',
    name: 'Relative Strength Index (RSI)',
    shortName: 'RSI',
    category: 'momentum',
    description: "Wilder's momentum oscillator between 0 and 100.",
    source: 'legacy-series',
    inputs: ['close'],
    parameters: [period('period', 'Period', 14, 'Lookback window of the RSI.')],
    outputs: [output('rsi', 'RSI', 'The relative strength index value.')],
    warmup: params => p(params, 'period', 14) + 1,
    notes: 'Kept on this repository\'s own warm-up aware series so strategies saved before the library integration keep identical numbers. The upstream library seeds its average slightly differently, which would change every stored RSI strategy.',
  },
  {
    key: 'STOCH',
    name: 'Stochastic Oscillator (STOCH)',
    shortName: 'Stoch',
    category: 'momentum',
    description: 'Position of the close inside the recent high-low range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      period('kPeriod', 'K period', 14, 'Window used to find the highest high and lowest low.'),
      period('dPeriod', 'D period', 3, 'Smoothing length of the D line.'),
    ],
    outputs: [
      output('k', 'K', 'The fast stochastic line, 0 to 100.'),
      output('d', 'D', 'The slow stochastic line, 0 to 100.'),
    ],
    warmup: params => p(params, 'kPeriod', 14) + p(params, 'dPeriod', 3),
  },
  {
    key: 'WILLR',
    name: "Williams R",
    shortName: 'Williams %R',
    category: 'momentum',
    description: 'Momentum oscillator between -100 and 0 that mirrors the stochastic oscillator.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 14, 'Window used to find the highest high and lowest low.')],
    outputs: [output('willr', 'Williams %R', 'The Williams R value, -100 to 0.')],
    warmup: params => p(params, 'period', 14),
  },
];

/* ------------------------------------------------------------------ */
/* VOLATILITY — 11 indicators                                          */
/* ------------------------------------------------------------------ */

const VOLATILITY: IndicatorCatalogEntry[] = [
  {
    key: 'AB',
    name: 'Acceleration Bands (AB)',
    shortName: 'Acceleration Bands',
    category: 'volatility',
    description: 'Envelope around a moving average whose width grows with the volatility of the market.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      period('period', 'Period', 20, 'Length of the moving average.'),
      numberParam('multiplier', 'Multiplier', 4, 1, 10, 0.5, 'How far the bands sit from the average.'),
    ],
    outputs: [
      output('upper', 'Upper band', 'The upper acceleration band.'),
      output('middle', 'Middle band', 'The moving average the bands are built on.'),
      output('lower', 'Lower band', 'The lower acceleration band.'),
    ],
    warmup: params => p(params, 'period', 20),
  },
  {
    key: 'ATR',
    name: 'Average True Range (ATR)',
    shortName: 'ATR',
    category: 'volatility',
    description: 'Average size of the true range, used to size stops and to measure volatility.',
    source: 'legacy-series',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 14, 'Averaging window of the true range.')],
    outputs: [output('atr', 'ATR', 'The average true range value.')],
    warmup: params => p(params, 'period', 14) + 1,
    notes: 'Kept on this repository\'s own warm-up aware series so strategies saved before the library integration keep identical numbers.',
  },
  {
    key: 'BB',
    name: 'Bollinger Bands (BB)',
    shortName: 'Bollinger Bands',
    category: 'volatility',
    description: 'Moving average with an envelope of standard deviations above and below it.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 20, 'Length of the moving average.')],
    outputs: [
      output('upper', 'Upper band', 'The upper Bollinger band.'),
      output('middle', 'Middle band', 'The moving average.'),
      output('lower', 'Lower band', 'The lower Bollinger band.'),
    ],
    warmup: params => p(params, 'period', 20),
  },
  {
    key: 'BBW',
    name: 'Bollinger Band Width (BBW)',
    shortName: 'Bollinger Band Width',
    category: 'volatility',
    description: 'Normalised width of the Bollinger Bands, used to measure expanding and contracting volatility.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [
      period('period', 'Period', 20, 'Length of the underlying Bollinger Bands.'),
      period('smoothingPeriod', 'Smoothing period', 90, 'Length of the exponential average of the width.'),
    ],
    outputs: [
      output('width', 'Width', 'The normalised band width.'),
      output('widthEma', 'Width EMA', 'The exponential average of the width.'),
    ],
    warmup: params => p(params, 'period', 20) + p(params, 'smoothingPeriod', 90),
  },
  {
    key: 'CE',
    name: 'Chandelier Exit (CE)',
    shortName: 'Chandelier Exit',
    category: 'volatility',
    description: 'Trailing stop for long and short positions based on the average true range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 22, 'Window of the highest high, lowest low and average true range.')],
    outputs: [
      output('long', 'Long stop', 'The trailing stop for a long position.'),
      output('short', 'Short stop', 'The trailing stop for a short position.'),
    ],
    warmup: params => p(params, 'period', 22),
  },
  {
    key: 'DC',
    name: 'Donchian Channel (DC)',
    shortName: 'Donchian',
    category: 'volatility',
    description: 'Highest high and lowest low of the lookback window, with their midpoint.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Length of the channel window.')],
    outputs: [
      output('upper', 'Upper channel', 'The highest close inside the window.'),
      output('middle', 'Middle channel', 'The midpoint of the channel.'),
      output('lower', 'Lower channel', 'The lowest close inside the window.'),
    ],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'KC',
    name: 'Keltner Channel (KC)',
    shortName: 'Keltner',
    category: 'volatility',
    description: 'Moving average with an average-true-range envelope around it.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [period('period', 'Period', 20, 'Window of the average true range and the moving average.')],
    outputs: [
      output('middle', 'Middle line', 'The exponential moving average.'),
      output('upper', 'Upper band', 'The upper Keltner band.'),
      output('lower', 'Lower band', 'The lower Keltner band.'),
    ],
    warmup: params => p(params, 'period', 20) + 1,
  },
  {
    key: 'MSTD',
    name: 'Moving Standard Deviation (MSTD)',
    shortName: 'MSTD',
    category: 'volatility',
    description: 'Rolling standard deviation of the closes inside the lookback window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 4, 'Length of the rolling window.')],
    outputs: [output('mstd', 'MSTD', 'The rolling standard deviation.')],
    warmup: params => p(params, 'period', 4),
  },
  {
    key: 'PO',
    name: 'Projection Oscillator (PO)',
    shortName: 'PO',
    category: 'volatility',
    description: 'Position of the close inside the projected high-low range of the window.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [
      period('period', 'Period', 14, 'Window of the regression and the projected range.'),
      period('smoothPeriod', 'Smoothing period', 3, 'Exponential smoothing length of the oscillator.'),
    ],
    outputs: [
      output('po', 'PO', 'The projection oscillator value.'),
      output('spo', 'Smoothed PO', 'The smoothed projection oscillator value.'),
    ],
    warmup: params => p(params, 'period', 14) + p(params, 'smoothPeriod', 3),
  },
  {
    key: 'TR',
    name: 'True Range (TR)',
    shortName: 'True Range',
    category: 'volatility',
    description: 'The largest of the candle range and the two gaps against the previous close.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close'],
    parameters: [],
    outputs: [output('tr', 'True Range', 'The true range of the candle.')],
    warmup: () => 1,
  },
  {
    key: 'UI',
    name: 'Ulcer Index (UI)',
    shortName: 'Ulcer Index',
    category: 'volatility',
    description: 'Measures the depth and the duration of drawdowns inside the lookback window.',
    source: 'indicatorts',
    inputs: ['close'],
    parameters: [period('period', 'Period', 14, 'Length of the lookback window.')],
    outputs: [output('ui', 'Ulcer Index', 'The ulcer index value.')],
    warmup: params => p(params, 'period', 14),
  },
];

/* ------------------------------------------------------------------ */
/* VOLUME — 9 indicators                                                */
/* ------------------------------------------------------------------ */

const VOLUME: IndicatorCatalogEntry[] = [
  {
    key: 'AD',
    name: 'Accumulation/Distribution (AD)',
    shortName: 'A/D',
    category: 'volume',
    description: 'Running total of the volume classified by where the candle closed inside its range.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close', 'volume'],
    parameters: [],
    outputs: [output('ad', 'Accumulation/Distribution', 'The running accumulation/distribution total.')],
    warmup: () => 1,
  },
  {
    key: 'CMF',
    name: 'Chaikin Money Flow (CMF)',
    shortName: 'CMF',
    category: 'volume',
    description: 'Money flow weighted by where the candle closed inside its range, averaged over a window.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close', 'volume'],
    parameters: [period('period', 'Period', 20, 'Averaging window of the money flow.')],
    outputs: [output('cmf', 'CMF', 'The Chaikin money flow value.')],
    warmup: params => p(params, 'period', 20),
  },
  {
    key: 'EMV',
    name: 'Ease of Movement (EMV)',
    shortName: 'EMV',
    category: 'volume',
    description: 'Relates the price movement of a candle to the volume that produced it.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'volume'],
    parameters: [period('period', 'Period', 14, 'Averaging window of the ease of movement.')],
    outputs: [output('emv', 'EMV', 'The ease of movement value.')],
    warmup: params => p(params, 'period', 14) + 1,
  },
  {
    key: 'FI',
    name: 'Force Index (FI)',
    shortName: 'Force Index',
    category: 'volume',
    description: 'Price change weighted by the volume that produced it, then smoothed.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [period('period', 'Period', 13, 'Exponential smoothing length of the force index.')],
    outputs: [output('fi', 'Force Index', 'The force index value.')],
    warmup: params => p(params, 'period', 13) + 1,
  },
  {
    key: 'MFI',
    name: 'Money Flow Index (MFI)',
    shortName: 'MFI',
    category: 'volume',
    description: 'RSI applied to the money flow instead of the close.',
    source: 'indicatorts',
    inputs: ['high', 'low', 'close', 'volume'],
    parameters: [period('period', 'Period', 14, 'Window of the money flow index.')],
    outputs: [output('mfi', 'MFI', 'The money flow index value, 0 to 100.')],
    warmup: params => p(params, 'period', 14) + 1,
  },
  {
    key: 'NVI',
    name: 'Negative Volume Index (NVI)',
    shortName: 'NVI',
    category: 'volume',
    description: 'Tracks the close only on candles where the volume fell, the classic smart-money style index.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [
      numberParam('start', 'Start value', 1000, 1, 1_000_000_000, 1, 'Value the index starts from.'),
      period('period', 'Period', 255, 'Smoothing length of the signal line.'),
    ],
    outputs: [output('nvi', 'NVI', 'The negative volume index value.')],
    warmup: params => p(params, 'period', 255),
  },
  {
    key: 'OBV',
    name: 'On-Balance Volume (OBV)',
    shortName: 'OBV',
    category: 'volume',
    description: 'Running total of the volume, added on up candles and subtracted on down candles.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [],
    outputs: [output('obv', 'OBV', 'The on-balance volume total.')],
    warmup: () => 1,
  },
  {
    key: 'VPT',
    name: 'Volume Price Trend (VPT)',
    shortName: 'VPT',
    category: 'volume',
    description: 'Running total of the volume weighted percentage price change.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [],
    outputs: [output('vpt', 'VPT', 'The volume price trend total.')],
    warmup: () => 1,
  },
  {
    key: 'VWAP',
    name: 'Volume Weighted Average Price (VWAP)',
    shortName: 'VWAP',
    category: 'volume',
    description: 'Average price weighted by the volume traded, over a rolling window.',
    source: 'indicatorts',
    inputs: ['close', 'volume'],
    parameters: [period('period', 'Period', 14, 'Length of the rolling window.')],
    outputs: [output('vwap', 'VWAP', 'The volume weighted average price.')],
    warmup: params => p(params, 'period', 14),
  },
];

/**
 * The complete official catalog: 24 trend, 9 momentum, 11 volatility and
 * 9 volume indicators.
 */
export const INDICATOR_CATALOG: readonly IndicatorCatalogEntry[] = Object.freeze([
  ...TREND, ...MOMENTUM, ...VOLATILITY, ...VOLUME,
]);

const BY_KEY = new Map(INDICATOR_CATALOG.map(entry => [entry.key, entry]));

/** Look up one catalog entry. */
export function indicatorCatalogEntry(key: string): IndicatorCatalogEntry | undefined {
  return BY_KEY.get(key);
}

/** Every catalog key, in catalog order. */
export const INDICATOR_KEYS: readonly string[] = Object.freeze(INDICATOR_CATALOG.map(entry => entry.key));

/** The catalog split by category, for the picker in the builder. */
export const INDICATOR_CATEGORIES: ReadonlyArray<{ key: IndicatorCategory; label: string }> = Object.freeze([
  { key: 'trend', label: 'Trend' },
  { key: 'momentum', label: 'Momentum' },
  { key: 'volatility', label: 'Volatility' },
  { key: 'volume', label: 'Volume' },
]);

/** The default output of an indicator, which is what a condition uses when it does not name one. */
export function defaultIndicatorOutput(key: string): string {
  const entry = BY_KEY.get(key);
  return entry?.outputs[0]?.key ?? 'value';
}

/**
 * The parameters of an indicator, with the catalog defaults filled in.
 * Unknown keys are dropped, so a persisted strategy can never smuggle a
 * parameter the indicator does not understand.
 */
export function resolveIndicatorParams(key: string, params: Readonly<Record<string, number>> = {}): Record<string, number> {
  const entry = BY_KEY.get(key);
  if (!entry) return {};
  const resolved: Record<string, number> = {};
  for (const definition of entry.parameters) {
    const value = params?.[definition.key];
    resolved[definition.key] = typeof value === 'number' && Number.isFinite(value) ? value : definition.default;
  }
  return resolved;
}

/**
 * Validates the parameters of one indicator against the catalog.
 * Returns the list of human readable problems; an empty list means the
 * parameters are usable.
 */
export function validateIndicatorParams(
  key: string,
  params: Readonly<Record<string, number>> | undefined,
): string[] {
  const entry = BY_KEY.get(key);
  if (!entry) return [`Unknown indicator "${key}".`];
  const errors: string[] = [];
  const supplied = params ?? {};
  for (const definition of entry.parameters) {
    const value = supplied[definition.key];
    if (value === undefined) {
      errors.push(`Indicator "${key}" is missing the parameter "${definition.key}" (${definition.label}).`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`Indicator "${key}" parameter "${definition.key}" must be a finite number.`);
      continue;
    }
    if (definition.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`Indicator "${key}" parameter "${definition.key}" must be a whole number.`);
      continue;
    }
    if (value < definition.min || value > definition.max) {
      errors.push(`Indicator "${key}" parameter "${definition.key}" must be between ${definition.min} and ${definition.max}.`);
    }
  }
  for (const name of Object.keys(supplied)) {
    if (!entry.parameters.some(definition => definition.key === name)) {
      errors.push(`Indicator "${key}" does not accept a parameter called "${name}".`);
    }
  }
  return errors;
}

/** Validates an output name against the catalog. */
export function validateIndicatorOutput(key: string, output: string | undefined): string[] {
  const entry = BY_KEY.get(key);
  if (!entry) return [`Unknown indicator "${key}".`];
  if (output === undefined) return [];
  if (!entry.outputs.some(candidate => candidate.key === output)) {
    return [`Indicator "${key}" has no output called "${output}".`];
  }
  return [];
}

/** A one-line description of an indicator with its parameters, for summaries. */
export function describeIndicator(key: string, params: Readonly<Record<string, number>> = {}): string {
  const entry = BY_KEY.get(key);
  if (!entry) return key;
  const resolved = resolveIndicatorParams(key, params);
  const parts = entry.parameters.map(definition => `${definition.label} ${resolved[definition.key]}`);
  return parts.length ? `${entry.shortName} (${parts.join(', ')})` : entry.shortName;
}
