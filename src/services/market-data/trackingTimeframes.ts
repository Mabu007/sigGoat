/**
 * TRACKING TIMEFRAMES
 * ===================
 * The candle timeframe used to calculate tracked indicator values. The
 * production scheduler checks condition state every five minutes regardless
 * of this resolution; crossovers are evaluated on closed bars while level
 * conditions can be rechecked against the current bar. AI reasoning cadence is
 * a separate persisted schedule.
 *
 * Server-side validation is authoritative. The frontend is untrusted input.
 */

/** The five tracking cadences offered to users. */
export const TRACKING_TIMEFRAMES = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
] as const;

export type TrackingTimeframe = (typeof TRACKING_TIMEFRAMES)[number];

export const DEFAULT_TRACKING_TIMEFRAME: TrackingTimeframe = '15m';

/**
 * Milliseconds per timeframe bar. Used to convert a bar count into an
 * approximate covered window, and to keep the polling cadence sensible for
 * slow timeframes.
 */
export const TIMEFRAME_MS: Record<TrackingTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

export function isTrackingTimeframe(
  value: unknown,
): value is TrackingTimeframe {
  return (
    typeof value === 'string' &&
    (TRACKING_TIMEFRAMES as readonly string[]).includes(value)
  );
}

/**
 * Coerces arbitrary input to a valid timeframe.
 *
 * Falls back to the default rather than throwing, so a malformed stored
 * document degrades to "works, at 15m" instead of breaking every wake.
 */
export function normaliseTrackingTimeframe(
  value: unknown,
): TrackingTimeframe {
  return isTrackingTimeframe(value)
    ? value
    : DEFAULT_TRACKING_TIMEFRAME;
}

/** How many bars are needed to compute the indicator set reliably. */
export function candleCountForTimeframe(
  timeframe: TrackingTimeframe,
): number {
  // Slower timeframes move less often; 120 bars covers the same wall-clock
  // horizon across all of them without over-fetching intraday noise.
  return 120;
}

/**
 * Local in-process market ingestion cadence, proportional to bar size. The
 * production Firestore scheduler uses its own five-minute condition-check
 * cadence and does not rely on these process-local polling intervals.
 */
export function pollIntervalForTimeframe(
  timeframe: TrackingTimeframe,
): number {
  const barMs = TIMEFRAME_MS[timeframe];
  return Math.max(5_000, Math.min(60_000, Math.floor(barMs / 4)));
}
