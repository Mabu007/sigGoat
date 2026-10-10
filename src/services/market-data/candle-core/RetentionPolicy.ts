/**
 * RETENTION POLICY
 * ================
 * Bounded storage for candle history, expressed as POLICY rather than as
 * scattered `if (age > X)` checks.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT
 *
 *   No candle is ever deleted before the session summary and structural facts
 *   derived from it are durably persisted.
 *
 * Retention here is therefore always evaluated against a `finalizedThroughMs`
 * WATERMARK — the point up to which finalization has completed — never against
 * wall-clock age. A wall-clock rule is unsafe: a session whose finalization
 * crashed would age past every threshold and get pruned with nothing derived
 * from it.
 *
 * INITIAL DEFAULTS (from the storage policy table)
 *
 *   | Data                | Default                        |
 *   |---------------------|--------------------------------|
 *   | 1m current session  | retained for the live session  |
 *   | 1m completed        | summarized, then pruned        |
 *   | 5m recent           | ~3 trading sessions (used only)|
 *   | 1h candles          | 7 calendar days                |
 *   | 1d candles          | 180 days                       |
 *   | swing points        | until broken / expired         |
 *   | session summaries   | bounded, 400 per instrument    |
 *
 * Every value is overridable per deployment via env, and per instrument via
 * `RetentionPolicy.forInstrument`.
 */

import { MINUTE_MS, floorToMinute } from './CandleRecord';

/** Retention buckets. Each is pruned independently. */
export type RetentionBucket =
  | 'M1_CURRENT'
  | 'M1_COMPLETED'
  | 'M5'
  | 'H1'
  | 'D1';

export interface RetentionPolicy {
  /**
   * 5-minute candles are retained only because some tracking timeframes need
   * them cheaply. They are DERIVED from validated 1m candles and are explicitly
   * allowed to be absent — the indicator layer falls back to computing from 1m.
   */
  m5: {
    enabled: boolean;
    /** Trading sessions retained. */
    sessions: number;
  };
  h1: {
    enabled: boolean;
    /** Calendar days retained. */
    days: number;
  };
  d1: {
    enabled: boolean;
    /** Calendar days retained. */
    days: number;
  };
  /** Session summaries kept per instrument before the oldest is expired. */
  sessionSummaries: number;
  /** Confirmed swing points kept per instrument per side (high/low). */
  swingPointsPerSide: number;
  /**
   * How long after a session's nominal close we keep accepting late provider
   * corrections before finalizing it.
   *
   * Must be >= the provider's actual finalization behaviour or a genuinely
   * final bar would be frozen in before the provider finished forming it.
   */
  lateUpdateGraceMs: number;
  /** Cap on candles deleted in a single pruning pass. */
  pruneBatchSize: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  m5: { enabled: false, sessions: 3 },
  h1: { enabled: true, days: 7 },
  d1: { enabled: true, days: 180 },
  sessionSummaries: 400,
  swingPointsPerSide: 250,
  lateUpdateGraceMs: 3 * MINUTE_MS,
  pruneBatchSize: 2_000,
};

/** Parses a positive integer env value, falling back when unusable. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads deployment overrides from the environment.
 *
 * Every value is validated and falls back independently, so one malformed
 * variable cannot silently produce an unbounded retention policy (e.g. a
 * negative or non-numeric days value would otherwise disable pruning entirely).
 */
export function retentionPolicyFromEnv(): RetentionPolicy {
  const base = DEFAULT_RETENTION;

  return {
    m5: {
      enabled: process.env.RETENTION_M5_ENABLED === 'true',
      sessions: envInt('RETENTION_M5_SESSIONS', base.m5.sessions),
    },
    h1: {
      enabled: process.env.RETENTION_H1_ENABLED !== 'false',
      days: envInt('RETENTION_H1_DAYS', base.h1.days),
    },
    d1: {
      enabled: process.env.RETENTION_D1_ENABLED !== 'false',
      days: envInt('RETENTION_D1_DAYS', base.d1.days),
    },
    sessionSummaries: envInt('RETENTION_SESSION_SUMMARIES', base.sessionSummaries),
    swingPointsPerSide: envInt('RETENTION_SWING_POINTS', base.swingPointsPerSide),
    lateUpdateGraceMs:
      envInt('RETENTION_LATE_GRACE_MINUTES', base.lateUpdateGraceMs / MINUTE_MS) *
      MINUTE_MS,
    pruneBatchSize: envInt('RETENTION_PRUNE_BATCH', base.pruneBatchSize),
  };
}

/**
 * Instruments with a genuinely 24/5 or 24/7 profile get tighter defaults.
 *
 * Crypto trades continuously, so "3 trading sessions" of 5m history is a much
 * shorter wall-clock span than for FX and would starve a longer indicator.
 */
export function retentionPolicyForInstrument(
  instrument: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionPolicy {
  const key = instrument.trim().toUpperCase();

  // 24/7 markets: a "session" is a calendar day, so scale the 5m window out.
  if (key === 'BTC' || key === 'ETH' || key === 'SOL') {
    return {
      ...policy,
      m5: { ...policy.m5, sessions: policy.m5.sessions * 2 },
      h1: { ...policy.h1, days: policy.h1.days },
    };
  }

  return policy;
}

/**
 * The candle-delete boundary for an instrument.
 *
 * Returns the OPEN timestamp strictly below which completed 1m candles may be
 * deleted. Returns `null` when nothing is eligible, which the finalizer reads
 * as "finalization has not reached this far yet — delete nothing".
 *
 * `finalizedThroughMs` is a WATERMARK, never `Date.now()`. Passing wall-clock
 * `now` here is precisely the bug that deletes the only copy of a session whose
 * summary write failed.
 */
export function pruneBoundaryMs(
  finalizedThroughMs: number | null,
): number | null {
  if (finalizedThroughMs === null) return null;
  if (!Number.isFinite(finalizedThroughMs)) return null;
  if (finalizedThroughMs <= 0) return null;
  return floorToMinute(finalizedThroughMs);
}

/** True when a candle at `openTimeMs` is eligible for deletion. */
export function isEligibleForPruning(
  openTimeMs: number,
  finalizedThroughMs: number | null,
): boolean {
  const boundary = pruneBoundaryMs(finalizedThroughMs);
  if (boundary === null) return false;
  return openTimeMs < boundary;
}

/** Bound for a derived-timeframe bucket, or null when the bucket is disabled. */
export function derivedRetentionBoundary(
  bucket: RetentionBucket,
  policy: RetentionPolicy,
  now: number,
): number | null {
  switch (bucket) {
    case 'M5':
      return policy.m5.enabled
        ? now - policy.m5.sessions * 24 * 60 * MINUTE_MS
        : null;
    case 'H1':
      return policy.h1.enabled ? now - policy.h1.days * 24 * 60 * MINUTE_MS : null;
    case 'D1':
      return policy.d1.enabled ? now - policy.d1.days * 24 * 60 * MINUTE_MS : null;
    case 'M1_CURRENT':
    case 'M1_COMPLETED':
      return null;
    default:
      return null;
  }
}

/** Human summary for the status endpoint. Contains no secrets. */
export function describeRetention(policy: RetentionPolicy): Record<string, unknown> {
  return {
    m5: policy.m5,
    h1: policy.h1,
    d1: policy.d1,
    sessionSummaries: policy.sessionSummaries,
    swingPointsPerSide: policy.swingPointsPerSide,
    lateUpdateGraceMs: policy.lateUpdateGraceMs,
    pruneBatchSize: policy.pruneBatchSize,
  };
}