/**
 * MARKET STRUCTURE — SWING LEDGER, LEVELS AND REGIMES
 * =====================================================
 * The durable, compact memory of price behaviour that survives candle pruning.
 *
 * WHAT THIS IS NOT
 *
 * It is not a rolling window of recent pivots recomputed on every call. It is
 * an append-only, bounded ledger of swings with explicit lifecycle, so the
 * system can still explain WHY a GOAT believes a level matters weeks after the
 * candles that created it have been deleted.
 *
 * THE LOOK-AHEAD PROBLEM — THE WHOLE POINT OF `confirmed`
 *
 * A pivot is a bar whose high exceeds `k` bars either side. That fact is only
 * knowable `k` bars AFTER the pivot. Treating it as known at the pivot bar is
 * look-ahead bias: backtests using it look brilliant and live trading using it
 * loses money.
 *
 * So a swing here is either:
 *
 *   - `DEVELOPING` — a candidate whose confirmation window has not elapsed.
 *     Live decisions may know about it, but it is NOT eligible to become a
 *     level, and it is never shown as a confirmed high/low.
 *   - `CONFIRMED`  — `k` bars after the pivot have actually printed.
 *
 * `confirmedAtMs` is the timestamp of the CONFIRMING bar, not of the pivot.
 * That distinction is what makes the ledger auditable.
 *
 * EVERY FACT HAS AN ORIGIN
 *
 * `origin` distinguishes an OBSERVED fact (this swing is in the price data)
 * from an INTERPRETED one (this swing is resistance). Only observed facts are
 * treated as authoritative for breaking levels; interpretations are advisory.
 */

import type { CandleRecord } from './CandleRecord';

export const STRUCTURE_SCHEMA_VERSION = 1;

export type SwingKind = 'HIGH' | 'LOW';

export type SwingStatus = 'DEVELOPING' | 'CONFIRMED' | 'BROKEN';

export type BreakDirection = 'ABOVE' | 'BELOW';

export interface SwingPoint {
  /** `${instrument}#${kind}#${pivotOpenTimeMs}` — stable across rebuilds. */
  id: string;
  instrument: string;
  kind: SwingKind;
  price: number;
  /** Open time of the PIVOT bar. */
  atMs: number;
  status: SwingStatus;
  /**
   * Open time of the bar whose arrival confirmed this pivot. Null while
   * DEVELOPING. This is strictly greater than `atMs`.
   */
  confirmedAtMs: number | null;
  /** Id of the preceding opposite-kind swing, when one exists. */
  precedingSwingId: string | null;
  /** Bars of clearance required on each side (the `k`). */
  lookback: number;
  /**
   * The timeframe this swing was detected on.
   *
   * Recorded rather than discarded: a swing confirmed on 15m and the same price
   * seen on 1h are different structural facts, and a level ledger that cannot
   * tell them apart over-claims confluence.
   */
  timeframe: string;
  /** Whether the pivot is still considered structurally valid. */
  active: boolean;
  brokenAtMs: number | null;
  breakDirection: BreakDirection | null;
  /**
   * OBSERVED: the price came from the data.
   * INTERPRETED: a judgement layered on top (e.g. "this acts as resistance").
   */
  origin: 'OBSERVED' | 'INTERPRETED';
  schemaVersion: number;
}

export type LevelKind =
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'PREV_SESSION_HIGH'
  | 'PREV_SESSION_LOW'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'ROUND_NUMBER';

export type LevelStatus = 'ACTIVE' | 'BROKEN' | 'EXPIRED';

export interface LevelRecord {
  /** `${instrument}#${kind}#${bucket}#${priceBucket}` — deterministic. */
  id: string;
  instrument: string;
  kind: LevelKind;
  price: number;
  createdAtMs: number;
  lastValidatedAtMs: number;
  status: LevelStatus;
  /** How many separate confirmations have landed on this price. */
  touches: number;
  /** Swing ids that created or re-confirmed this level. */
  sourceSwingIds: string[];
  /** True when a close traded through the level. */
  brokenAtMs: number | null;
  breakDirection: BreakDirection | null;
  /** Human-readable invalidation criterion, for explainability. */
  invalidationRule: string;
  origin: 'OBSERVED' | 'INTERPRETED';
  schemaVersion: number;
}

export type TrendClassification = 'BULLISH' | 'BEARISH' | 'RANGING';
export type VolatilityRegime = 'CONTRACTING' | 'NORMAL' | 'EXPANDING';

export interface MarketRegimeRecord {
  id: string;
  instrument: string;
  /** Session this regime was derived from. */
  sessionId: string;
  asOfMs: number;
  trend: TrendClassification;
  /** 0-100. Only meaningful when derived from measured structure. */
  trendConfidence: number;
  volatility: VolatilityRegime;
  /** ATR as a fraction of price, so it compares across instruments. */
  normalisedAtr: number;
  /** Higher-timeframe trend when available. */
  higherTimeframeTrend: TrendClassification | null;
  schemaVersion: number;
}

/* ------------------------------------------------------------------ */
/* Swing detection                                                     */
/* ------------------------------------------------------------------ */

export interface DetectSwingsOptions {
  /** Bars of clearance required on each side. Default 2. */
  lookback?: number;
  /** Timeframe label recorded on each swing, e.g. '1h'. */
  timeframe?: string;
}

export interface DetectedSwings {
  confirmed: SwingPoint[];
  developing: SwingPoint[];
}

/**
 * Detects swing pivots from an ascending candle slice.
 *
 * `confirmed` requires the candle at `i + lookback` to be PRESENT in the
 * input. If the caller passes a truncated history, pivots near the right edge
 * are returned as DEVELOPING rather than confirmed — which is exactly what a
 * live system at the close of a bar must see.
 */
export function detectSwings(
  candles: readonly CandleRecord[],
  instrument: string,
  options: DetectSwingsOptions = {},
): DetectedSwings {
  const lookback = Math.max(1, Math.floor(options.lookback ?? 2));
  const timeframe = options.timeframe ?? '1m';
  const confirmed: SwingPoint[] = [];
  const developing: SwingPoint[] = [];

  if (candles.length < lookback * 2 + 1) {
    return { confirmed, developing };
  }

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const pivot = candles[i];

    const left = candles.slice(i - lookback, i);
    const right = candles.slice(i + 1, i + 1 + lookback);

    // Incomplete right-hand side => not yet confirmable.
    const rightComplete = right.length === lookback;
    if (!rightComplete) continue;

    const isHigh = left.every((c) => pivot.high > c.high) &&
      right.every((c) => pivot.high > c.high);

    const isLow = left.every((c) => pivot.low < c.low) &&
      right.every((c) => pivot.low < c.low);

    if (!isHigh && !isLow) continue;

    // A doji bar that is both a local high and a local low is degenerate
    // (a flat quote). Record it as a low so it is tracked once, not twice.
    const kind: SwingKind = isHigh ? 'HIGH' : 'LOW';

    const id = `${instrument}#${kind}#${pivot.openTimeMs}`;

    const point: SwingPoint = {
      id,
      instrument,
      kind,
      price: kind === 'HIGH' ? pivot.high : pivot.low,
      atMs: pivot.openTimeMs,
      status: 'CONFIRMED',
      /**
       * The CONFIRMING bar, which is the last bar of the right-hand window.
       * Using the pivot's own timestamp here would be exactly the look-ahead
       * bug this type exists to prevent.
       */
      confirmedAtMs: right[right.length - 1].openTimeMs,
      precedingSwingId: null,
      lookback,
      timeframe,
      active: true,
      brokenAtMs: null,
      breakDirection: null,
      origin: 'OBSERVED',
      schemaVersion: STRUCTURE_SCHEMA_VERSION,
    };

    confirmed.push(point);
  }

  /**
   * Developing pivots: the most recent bar that has a full LEFT side but not
   * yet a full RIGHT side. These are live-only facts. A GOAT may be told a
   * level is forming; it may never be told a level is confirmed.
   */
  const edge = candles.length - 1;
  if (edge >= lookback) {
    const pivot = candles[edge];
    const left = candles.slice(edge - lookback, edge);

    const isHigh = left.every((c) => pivot.high > c.high);
    const isLow = left.every((c) => pivot.low < c.low);

    if (isHigh || isLow) {
      const kind: SwingKind = isHigh ? 'HIGH' : 'LOW';
      developing.push({
        id: `${instrument}#${kind}#${pivot.openTimeMs}`,
        instrument,
        kind,
        price: kind === 'HIGH' ? pivot.high : pivot.low,
        atMs: pivot.openTimeMs,
        status: 'DEVELOPING',
        confirmedAtMs: null,
        precedingSwingId: null,
        lookback,
        timeframe,
        active: true,
        brokenAtMs: null,
        breakDirection: null,
        origin: 'OBSERVED',
        schemaVersion: STRUCTURE_SCHEMA_VERSION,
      });
    }
  }

  linkPrecedingSwings([...confirmed].sort((a, b) => a.atMs - b.atMs));

  return { confirmed, developing };
}

/**
 * Chains each swing to the most recent preceding swing of the OPPOSITE kind.
 *
 * This is what turns a list of pivots into structure: "this higher high broke
 * that prior lower high" is a relationship, and it is the relationship a GOAT
 * reasons about.
 */
function linkPrecedingSwings(points: SwingPoint[]): void {
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;

  for (const point of points) {
    if (point.kind === 'HIGH') {
      point.precedingSwingId = lastLow?.id ?? null;
      lastHigh = point;
    } else {
      point.precedingSwingId = lastHigh?.id ?? null;
      lastLow = point;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Break detection                                                     */
/* ------------------------------------------------------------------ */

/** Default clearance, in ATR multiples, before a swing counts as broken. */
export const DEFAULT_BREAK_ATR_MULTIPLE = 0.5;

/**
 * Marks swings broken by a close beyond them by the given buffer.
 *
 * A buffer matters: without one, a level is "broken" by a single tick through
 * it, which on a CFD feed happens constantly and retires every level within
 * minutes. Sizing the buffer in ATR ties it to the instrument's own volatility
 * rather than a fixed pip count that is meaningless across symbols.
 *
 * Only candles at or AFTER the swing's confirmation time can break it. That is
 * the other half of look-ahead safety: a swing confirmed at T cannot be broken
 * by a candle that printed before T.
 */
export function applySwingBreaks(
  swings: SwingPoint[],
  candles: readonly CandleRecord[],
  atr: number,
  breakMultiple = DEFAULT_BREAK_ATR_MULTIPLE,
): SwingPoint[] {
  const buffer = Number.isFinite(atr) && atr > 0 ? atr * breakMultiple : 0;

  return swings.map((swing) => {
    if (!swing.active || swing.status !== 'CONFIRMED') return swing;

    const fromMs = swing.confirmedAtMs ?? swing.atMs;
    const threshold = swing.kind === 'HIGH'
      ? swing.price + buffer
      : swing.price - buffer;

    for (const candle of candles) {
      if (candle.openTimeMs <= fromMs) continue;

      const broke =
        swing.kind === 'HIGH'
          ? candle.close > threshold
          : candle.close < threshold;

      if (broke) {
        return {
          ...swing,
          status: 'BROKEN' as SwingStatus,
          active: false,
          brokenAtMs: candle.openTimeMs,
          breakDirection: (swing.kind === 'HIGH' ? 'ABOVE' : 'BELOW') as BreakDirection,
        };
      }
    }

    return swing;
  });
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

/**
 * Deterministic price bucketing.
 *
 * Two levels within a tenth of a pip are the SAME level for trading purposes,
 * so levels are keyed by a rounded price bucket. Without this, every retest
 * creates a "new" level and the ledger fills with duplicates.
 */
export function priceBucket(
  price: number,
  digits: number,
): number {
  const factor = 10 ** digits;
  return Math.round(price * factor) / factor;
}

/** Default display precision per instrument category. */
function defaultDigitsFor(instrument: string): number {
  const key = instrument.trim().toUpperCase();
  if (key === 'XYZ:GOLD') return 2;
  if (key === 'XYZ:SILVER') return 3;
  if (key === 'BTC' || key === 'ETH' || key === 'SOL') return 1;
  if (key === 'XYZ:JP225' || key === 'XYZ:KR200') return 2;
  if (key === 'XYZ:CL') return 2;
  if (key === 'XYZ:EUR' || key === 'XYZ:GBP') return 5;
  if (key === 'XYZ:JPY') return 3;
  return 5;
}

/**
 * Folds confirmed swings into a deduplicated level ledger.
 *
 * Idempotent by construction: the level id is derived from the instrument,
 * kind and price bucket, so re-running this over the same swings RE-TOUCHES
 * the same records instead of appending duplicates. That property is what
 * makes repeated session finalization safe.
 *
 * DEVELOPING swings are never folded in. A level built from an unconfirmed
 * pivot would be a level the market has not yet committed to.
 */
export function buildLevelLedger(
  instrument: string,
  swings: readonly SwingPoint[],
  existing: readonly LevelRecord[] = [],
  now: number = Date.now(),
): LevelRecord[] {
  const digits = defaultDigitsFor(instrument);
  const byId = new Map<string, LevelRecord>();

  for (const level of existing) {
    byId.set(level.id, { ...level });
  }

  for (const swing of swings) {
    if (swing.status !== 'CONFIRMED') continue;

    const bucket = priceBucket(swing.price, digits);
    const kind: LevelKind = swing.kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    const id = `${instrument}#${kind}#${bucket}`;

    const prior = byId.get(id);

    if (prior) {
      /**
       * A retest. `touches` is the confluence signal: a level the market has
       * rejected four times is structurally stronger than one it has rejected
       * once, and that is a fact worth surviving the candles.
       */
      byId.set(id, {
        ...prior,
        touches: prior.touches + 1,
        lastValidatedAtMs: now,
        sourceSwingIds: dedupe([
          ...prior.sourceSwingIds,
          swing.id,
        ]).slice(-32),
        /**
         * A newer confirmation of an old price does NOT resurrect a broken
         * level: it stays broken. Otherwise a level would flicker in and out of
         * existence as the price oscillated around it.
         */
        status: prior.status === 'EXPIRED' ? 'EXPIRED' : prior.status,
      });
      continue;
    }

    byId.set(id, {
      id,
      instrument,
      kind,
      price: bucket,
      createdAtMs: swing.atMs,
      lastValidatedAtMs: now,
      status: 'ACTIVE',
      touches: 1,
      sourceSwingIds: [swing.id],
      brokenAtMs: null,
      breakDirection: null,
      invalidationRule:
        swing.kind === 'HIGH'
          ? `Invalid when a ${digits}-dp close trades above ${bucket}.`
          : `Invalid when a ${digits}-dp close trades below ${bucket}.`,
      origin: 'OBSERVED',
      schemaVersion: STRUCTURE_SCHEMA_VERSION,
    });
  }

  return [...byId.values()].sort((a, b) => a.price - b.price);
}

/** Updates level status against a candle. CLOSE-based, never wick-based. */
export function applyLevelBreaks(
  levels: readonly LevelRecord[],
  candles: readonly CandleRecord[],
  atr: number,
  breakMultiple = DEFAULT_BREAK_ATR_MULTIPLE,
): LevelRecord[] {
  const buffer = Number.isFinite(atr) && atr > 0 ? atr * breakMultiple : 0;

  return levels.map((level) => {
    if (level.status !== 'ACTIVE') return level;

    for (const candle of candles) {
      if (candle.openTimeMs < level.createdAtMs) continue;

      const direction: BreakDirection | null =
        level.kind === 'SWING_LOW' || level.kind === 'PREV_SESSION_LOW' ||
          level.kind === 'SESSION_LOW'
          ? candle.close < level.price - buffer
            ? 'BELOW'
            : null
          : candle.close > level.price + buffer
            ? 'ABOVE'
            : null;

      if (direction) {
        return {
          ...level,
          status: 'BROKEN' as LevelStatus,
          brokenAtMs: candle.openTimeMs,
          breakDirection: direction,
          lastValidatedAtMs: candle.openTimeMs,
        };
      }
    }

    return level;
  });
}

/**
 * Drops stale levels under an explicit, deterministic policy.
 *
 * The ONLY things that expire a level are: it was broken, or it is older than
 * the supplied horizon and has not been retested inside it. Nothing expires
 * merely because it is far from price — a level two hundred pips away is still
 * a real level.
 */
export function expireLevels(
  levels: readonly LevelRecord[],
  now: number,
  maxAgeMs: number,
  keepBrokenForMs = 7 * 24 * 60 * MINUTE_MS,
): LevelRecord[] {
  return levels.map((level) => {
    if (level.status === 'BROKEN') {
      const brokenMs = level.brokenAtMs ?? level.lastValidatedAtMs;
      return now - brokenMs > keepBrokenForMs
        ? { ...level, status: 'EXPIRED' as LevelStatus }
        : level;
    }

    // Activity, not age, keeps a level alive.
    const idleMs = now - level.lastValidatedAtMs;
    return idleMs > maxAgeMs
      ? { ...level, status: 'EXPIRED' as LevelStatus }
      : level;
  });
}

const MINUTE_MS = 60_000;

/**
 * Trims the ledger to a bound, keeping the most structurally relevant entries.
 *
 * Broken and long-idle records go first; among equals the most recently
 * validated survive. Bounding is what stops this from being the unbounded
 * history the storage policy exists to prevent.
 */
export function boundLevelLedger(
  levels: readonly LevelRecord[],
  maxActive: number,
): LevelRecord[] {
  const scored = [...levels].sort((a, b) => {
    const rank = (l: LevelRecord) => {
      if (l.status === 'ACTIVE') return 0;
      if (l.status === 'BROKEN') return 1;
      return 2;
    };
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    return b.lastValidatedAtMs - a.lastValidatedAtMs;
  });

  return scored.slice(0, Math.max(1, maxActive));
}

/* ------------------------------------------------------------------ */
/* Regime                                                              */
/* ------------------------------------------------------------------ */

/**
 * Classifies trend and volatility from measured structure only.
 *
 * Every input is an OBSERVED fact from the candle data. Nothing here is a
 * forecast, and nothing here is model output — a GOAT may disagree with the
 * regime, but the regime is a fact about what the candles did.
 */
export function classifyRegime(
  instrument: string,
  sessionId: string,
  asOfMs: number,
  input: {
    atr: number;
    price: number;
    swingHigh: number | null;
    swingLow: number | null;
    swingHighAgeMs: number | null;
    swingLowAgeMs: number | null;
    rangePct: number;
    previousRangePct: number | null;
    higherTimeframeTrend?: TrendClassification | null;
  },
): MarketRegimeRecord {
  let trend: TrendClassification = 'RANGING';
  let confidence = 0;

  const { swingHigh, swingLow, swingHighAgeMs, swingLowAgeMs } = input;

  if (
    swingHigh !== null &&
    swingLow !== null &&
    swingHigh > swingLow &&
    input.price > 0
  ) {
    const range = swingHigh - swingLow;
    const position = (input.price - swingLow) / range;
    /**
     * "Higher high more recently than the lower low" is the textbook
     * structural uptrend. Age ordering is what separates structure from a
     * price that merely happens to sit high in its range.
     */
    const highIsNewer =
      swingHighAgeMs !== null && swingLowAgeMs !== null
        ? swingHighAgeMs < swingLowAgeMs
        : null;

    if (position >= 0.6 && highIsNewer !== false) {
      trend = 'BULLISH';
      confidence = Math.round(Math.min(100, position * 100));
    } else if (position <= 0.4 && highIsNewer === false) {
      trend = 'BEARISH';
      confidence = Math.round(Math.min(100, (1 - position) * 100));
    } else {
      trend = 'RANGING';
      confidence = Math.round(100 - Math.abs(position - 0.5) * 200);
    }
  }

  let volatility: VolatilityRegime = 'NORMAL';
  if (
    input.previousRangePct !== null &&
    input.previousRangePct > 0
  ) {
    const ratio = input.rangePct / input.previousRangePct;
    volatility = ratio > 1.4 ? 'EXPANDING' : ratio < 0.7 ? 'CONTRACTING' : 'NORMAL';
  }

  return {
    id: `${instrument}#${sessionId}`,
    instrument,
    sessionId,
    asOfMs,
    trend,
    trendConfidence: Math.max(0, Math.min(100, confidence)),
    volatility,
    normalisedAtr:
      input.price > 0 && Number.isFinite(input.atr)
        ? Number((input.atr / input.price).toFixed(8))
        : 0,
    higherTimeframeTrend: input.higherTimeframeTrend ?? null,
    schemaVersion: STRUCTURE_SCHEMA_VERSION,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}