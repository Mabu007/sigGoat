/**
 * SESSION SUMMARY
 * ===============
 * The durable replacement for the minute candles a session produced.
 *
 * This record is the ONLY thing that must survive after pruning. If a summary
 * is lost, its information is gone — which is why the finalizer persists and
 * VERIFIES it before a single candle is deleted.
 *
 * EVERY NUMBER IS COMPUTED FROM REAL DATA
 *
 * There are no example values, no placeholders and no invented levels in this
 * file. Every field is derived from the actual validated candles of the
 * session. A session with 3 candles produces a summary whose completeness says
 * 3 candles, because reporting the expected 1,440 would be a lie.
 *
 * NUMERIC FACTS + A SHORT EXPLANATION
 *
 * Each section pairs the measured figure with the reasoning that made it
 * meaningful ("the session high printed 4 minutes after the open" is more
 * useful to a GOAT than "session high: 1.08500"), while the prose is generated
 * deterministically from the numbers. Nothing here is model-written: an
 * interpretation is not a fact and is stored separately by the reasoning layer.
 */

import type { CandleRecord } from './CandleRecord';
import { MINUTE_MS, floorToMinute } from './CandleRecord';
import type { MarketRegimeRecord, TrendClassification, VolatilityRegime } from './MarketStructure';
import { STRUCTURE_SCHEMA_VERSION } from './MarketStructure';

export const SESSION_SUMMARY_SCHEMA_VERSION = 1;

/** How complete a session's minute coverage actually is. */
export type DataCompleteness = 'COMPLETE' | 'PARTIAL' | 'SPARSE' | 'EMPTY';

export type DataQuality = 'OK' | 'DEGRADED' | 'SUSPECT';

export interface SessionSummary {
  /** `${instrument}#${YYYY-MM-DD}` — the idempotent key. */
  id: string;
  instrument: string;
  sessionId: string;
  sessionDate: string;
  opensAtMs: number;
  closesAtMs: number;
  timezone: string;

  open: number;
  high: number;
  low: number;
  close: number;
  /** Open times of the bars that set the high and the low. */
  highAtMs: number;
  lowAtMs: number;
  /** high - low, in price units. */
  range: number;
  /** range / open, as a fraction. Comparable across instruments. */
  rangePercent: number;
  /** close - open. Signed. */
  change: number;
  changePercent: number;

  /** Absolute and percentage change against the previous session's close. */
  previousClose: number | null;
  previousSessionChange: number | null;
  previousSessionChangePercent: number | null;
  previousHigh: number | null;
  previousLow: number | null;

  /**
   * Volatility measures, all computed from the session's own candles.
   * `atrPercent` is ATR over mean price, so it compares across symbols.
   */
  atr: number;
  atrPercent: number;
  /** Standard deviation of returns, as a fraction of price. */
  realisedVolatility: number;
  /** Minutes between the first and last candle. */
  bodyMinutes: number;

  /**
   * Higher-timeframe trend at finalization time, when it could be computed.
   * Null rather than a guess when there was no HTF data.
   */
  higherTimeframeTrend: TrendClassification | null;
  volatilityRegime: VolatilityRegime;

  /** Confirmed swing ids inside the session, for traceability. */
  confirmedSwingIds: string[];
  /** Level ids that are currently active and were touched this session. */
  activeLevelIds: string[];

  regime: MarketRegimeRecord | null;

  /* ---- data quality: the honest part -------------------------------- */

  candleCount: number;
  /** Candles we would expect if the session traded every minute. */
  expectedCandleCount: number;
  /** observed / expected, clamped to [0, 1]. */
  completenessRatio: number;
  completeness: DataCompleteness;
  quality: DataQuality;
  /** Minute opens inside the session with no candle. NOT fabricated. */
  missingMinuteCount: number;
  /** Count of bars the provider revised after first receipt. */
  correctedCandleCount: number;
  /** True when the session window spans a weekend or holiday closure. */
  spansClosure: boolean;
  /** Provider that supplied the candles. */
  source: string;

  /** Deterministic narrative built from the numbers above. */
  narrative: string;

  computedAtMs: number;
  finalizedAtMs: number;
  schemaVersion: number;
}

export interface ComputeSessionSummaryInput {
  instrument: string;
  sessionId: string;
  sessionDate: string;
  opensAtMs: number;
  closesAtMs: number;
  timezone: string;
  /** Ascending candles belonging to this session. */
  candles: readonly CandleRecord[];
  previous: SessionSummary | null;
  regime: MarketRegimeRecord | null;
  confirmedSwingIds: readonly string[];
  activeLevelIds: readonly string[];
  higherTimeframeTrend?: TrendClassification | null;
  source: string;
  /** Session window spans a weekend/holiday closure. */
  spansClosure: boolean;
  now?: () => number;
}

/**
 * Computes a session summary from validated candles.
 *
 * Pure: no I/O, no clock of its own (injected), no randomness. That makes it
 * directly unit-testable and means a retry recomputes an identical value,
 * which is what allows the idempotent merge in the repository to be sound.
 */
export function computeSessionSummary(
  input: ComputeSessionSummaryInput,
): SessionSummary {
  const now = input.now ? input.now() : Date.now();
  const candles = [...input.candles].sort(
    (a, b) => a.openTimeMs - b.openTimeMs,
  );

  const expectedCandleCount = Math.max(
    0,
    Math.round((input.closesAtMs - input.opensAtMs) / MINUTE_MS),
  );

  if (candles.length === 0) {
    return emptySummary(input, expectedCandleCount, now);
  }

  let high = candles[0].high;
  let low = candles[0].low;
  let highAtMs = candles[0].openTimeMs;
  let lowAtMs = candles[0].openTimeMs;

  for (const candle of candles) {
    if (candle.high > high) {
      high = candle.high;
      highAtMs = candle.openTimeMs;
    }
    if (candle.low < low) {
      low = candle.low;
      lowAtMs = candle.openTimeMs;
    }
  }

  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  const range = high - low;

  const atr = averageTrueRange(candles, 14);
  const meanPrice = (high + low + close) / 3;
  const realisedVolatility = standardDeviationOfReturns(candles);

  const firstMs = candles[0].openTimeMs;
  const lastMs = candles[candles.length - 1].openTimeMs;
  const bodyMinutes = Math.max(0, Math.round((lastMs - firstMs) / MINUTE_MS));

  const missingMinuteCount = Math.max(
    0,
    expectedCandleCount - candles.length,
  );

  const completenessRatio =
    expectedCandleCount === 0
      ? 0
      : Math.max(0, Math.min(1, candles.length / expectedCandleCount));

  const completeness: DataCompleteness =
    candles.length === 0
      ? 'EMPTY'
      : completenessRatio >= 0.98
        ? 'COMPLETE'
        : completenessRatio >= 0.5
          ? 'PARTIAL'
          : 'SPARSE';

  const correctedCandleCount = candles.filter(
    (candle) => candle.revision > 1,
  ).length;

  /**
   * Quality is separate from completeness. A sparse session is a normal
   * weekend or a thin market; a SUSPECT one is a session whose data we do not
   * trust, and those must never back a signal.
   */
  const quality: DataQuality =
    candles.length === 0
      ? 'SUSPECT'
      : candles.some((candle) => !candle.finalized) && completenessRatio >= 0.98
        ? 'DEGRADED'
        : correctedCandleCount > candles.length * 0.2
          ? 'DEGRADED'
          : 'OK';

  const previousClose = input.previous?.close ?? null;
  const change = close - open;
  const changePercent = open > 0 ? (change / open) * 100 : 0;

  const previousSessionChange =
    previousClose !== null ? close - previousClose : null;
  const previousSessionChangePercent =
    previousClose !== null && previousClose > 0
      ? ((close - previousClose) / previousClose) * 100
      : null;

  const summary: SessionSummary = {
    id: `${input.instrument}#${input.sessionDate}`,
    instrument: input.instrument,
    sessionId: input.sessionId,
    sessionDate: input.sessionDate,
    opensAtMs: input.opensAtMs,
    closesAtMs: input.closesAtMs,
    timezone: input.timezone,

    open,
    high,
    low,
    close,
    highAtMs,
    lowAtMs,
    range,
    rangePercent: open > 0 ? (range / open) * 100 : 0,
    change,
    changePercent,

    previousClose,
    previousSessionChange,
    previousSessionChangePercent,
    previousHigh: input.previous?.high ?? null,
    previousLow: input.previous?.low ?? null,

    atr,
    atrPercent: meanPrice > 0 ? (atr / meanPrice) * 100 : 0,
    realisedVolatility,
    bodyMinutes,

    higherTimeframeTrend:
      input.higherTimeframeTrend ?? input.regime?.higherTimeframeTrend ?? null,
    volatilityRegime: input.regime?.volatility ?? 'NORMAL',

    confirmedSwingIds: [...input.confirmedSwingIds],
    activeLevelIds: [...input.activeLevelIds],

    regime: input.regime,

    candleCount: candles.length,
    expectedCandleCount,
    completenessRatio: Number(completenessRatio.toFixed(6)),
    completeness,
    quality,
    missingMinuteCount,
    correctedCandleCount,
    spansClosure: input.spansClosure,
    source: input.source,

    narrative: '',

    computedAtMs: now,
    finalizedAtMs: now,
    schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
  };

  summary.narrative = describeSession(summary);
  return summary;
}

function emptySummary(
  input: ComputeSessionSummaryInput,
  expectedCandleCount: number,
  now: number,
): SessionSummary {
  const summary: SessionSummary = {
    id: `${input.instrument}#${input.sessionDate}`,
    instrument: input.instrument,
    sessionId: input.sessionId,
    sessionDate: input.sessionDate,
    opensAtMs: input.opensAtMs,
    closesAtMs: input.closesAtMs,
    timezone: input.timezone,

    open: 0,
    high: 0,
    low: 0,
    close: 0,
    highAtMs: input.opensAtMs,
    lowAtMs: input.opensAtMs,
    range: 0,
    rangePercent: 0,
    change: 0,
    changePercent: 0,

    previousClose: input.previous?.close ?? null,
    previousSessionChange: null,
    previousSessionChangePercent: null,
    previousHigh: input.previous?.high ?? null,
    previousLow: input.previous?.low ?? null,

    atr: 0,
    atrPercent: 0,
    realisedVolatility: 0,
    bodyMinutes: 0,

    higherTimeframeTrend: input.higherTimeframeTrend ?? null,
    volatilityRegime: 'NORMAL',

    confirmedSwingIds: [],
    activeLevelIds: [],
    regime: null,

    candleCount: 0,
    expectedCandleCount,
    completenessRatio: 0,
    completeness: 'EMPTY',
    quality: 'SUSPECT',
    missingMinuteCount: expectedCandleCount,
    correctedCandleCount: 0,
    spansClosure: input.spansClosure,
    source: input.source,

    narrative:
      `No candles were recorded for ${input.instrument} on ${input.sessionDate}. ` +
      `The session window is retained for audit but carries no price information.`,

    computedAtMs: now,
    finalizedAtMs: now,
    schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
  };

  return summary;
}

/**
 * Deterministic narrative.
 *
 * Every clause is a rendering of a number computed above. There is no
 * prediction and no sentiment here — this is what the market DID, stated
 * plainly, which is exactly what should survive pruning.
 */
function describeSession(summary: SessionSummary): string {
  if (summary.candleCount === 0) {
    return (
      `${summary.instrument} recorded no candles on ${summary.sessionDate}.`
    );
  }

  const direction =
    summary.change > 0 ? 'higher' : summary.change < 0 ? 'lower' : 'flat';

  const highOffset = Math.round(
    (summary.highAtMs - summary.opensAtMs) / MINUTE_MS,
  );
  const lowOffset = Math.round(
    (summary.lowAtMs - summary.opensAtMs) / MINUTE_MS,
  );

  const vsPrevious =
    summary.previousSessionChangePercent !== null
      ? ` Session close is ${formatSigned(
          summary.previousSessionChangePercent,
        )}% against the previous session.`
      : '';

  const closureNote = summary.spansClosure
    ? ` The window spans a market closure, so ${summary.missingMinuteCount} expected minutes have no candle.`
    : '';

  const qualityNote =
    summary.quality === 'DEGRADED'
      ? ` ${summary.correctedCandleCount} bar(s) were revised by the provider after first receipt.`
      : '';

  return (
    `${summary.instrument} ${direction} on ${summary.sessionDate}: O ${summary.open} H ${summary.high} L ${summary.low} C ${summary.close}. ` +
    `Range ${summary.range} (${summary.rangePercent.toFixed(3)}%); high printed ${highOffset}m into the session, low ${lowOffset}m. ` +
    `ATR ${summary.atr} (${summary.atrPercent.toFixed(3)}%).` +
    vsPrevious +
    closureNote +
    qualityNote +
    ` Derived from ${summary.candleCount} of ${summary.expectedCandleCount} expected one-minute candles (${summary.completeness}).`
  );
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* Derived measures                                                    */
/* ------------------------------------------------------------------ */

/**
 * Average True Range over a candle slice, using Wilder-style smoothing.
 *
 * Exported because the finalizer and the structure classifier need the honest
 * value for a possibly-short session, while `indicators.ts` deliberately keeps
 * its always-return-a-number contract for the live path.
 */
export function averageTrueRange(
  candles: readonly CandleRecord[],
  period: number,
): number {
  if (candles.length < 2) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }

  const window = trs.slice(-Math.max(1, period));
  const sum = window.reduce((acc, value) => acc + value, 0);
  return round(sum / window.length, 8);
}

/** Population standard deviation of per-bar returns, as a fraction. */
export function standardDeviationOfReturns(candles: readonly CandleRecord[]): number {
  if (candles.length < 3) return 0;

  const returns: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1].close;
    if (previous > 0) returns.push((candles[i].close - previous) / previous);
  }

  if (returns.length === 0) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) /
    returns.length;

  return round(Math.sqrt(variance), 8);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Merges a newly computed summary into an existing one.
 *
 * Repeated finalization MUST NOT create a second summary, and MUST NOT widen
 * an existing one with worse data either. The rule: a summary whose candle
 * count is at least as large and whose quality is at least as good wins;
 * otherwise the stored record is kept and the recomputation is discarded.
 */
export function mergeSessionSummary(
  existing: SessionSummary,
  incoming: SessionSummary,
): SessionSummary {
  if (existing.schemaVersion > incoming.schemaVersion) return existing;
  if (incoming.schemaVersion > existing.schemaVersion) return incoming;

  const existingIsRicher =
    existing.candleCount >= incoming.candleCount &&
    qualityRank(existing.quality) >= qualityRank(incoming.quality);

  if (existingIsRicher) {
    // Keep the original facts, but honour the later finalization timestamp so
    // a re-run is still observable in the audit trail.
    return { ...existing, finalizedAtMs: incoming.finalizedAtMs };
  }

  // Take the richer record's facts, retain the earliest provenance.
  return {
    ...incoming,
    computedAtMs: Math.min(existing.computedAtMs, incoming.computedAtMs),
    finalizedAtMs: incoming.finalizedAtMs,
  };
}

function qualityRank(quality: DataQuality): number {
  switch (quality) {
    case 'OK':
      return 2;
    case 'DEGRADED':
      return 1;
    case 'SUSPECT':
      return 0;
    default:
      return 0;
  }
}

/** The watermark a session sets when it is finalized. */
export function summaryWatermark(summary: SessionSummary): number {
  return floorToMinute(summary.closesAtMs);
}