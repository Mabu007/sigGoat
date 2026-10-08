/**
 * TRACKING TIMEFRAMES
 * ===================
 * The timeframe a user selects for MARKET TRACKING — the cadence at which
 * conditions (trackers) are observed. It is not a limit on what the AI may
 * reason about: the wake pipeline still reads 1h candles for the reasoning
 * context regardless, and multi-timeframe reasoning stays possible later.
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
 * A poll cadence proportional to the bar size, clamped to a sane range.
 *
 * Polling a 4h candle every 5s is pure waste; polling a 1m candle every 5s is
 * the point. This keeps tracker latency reasonable while capping provider
 * traffic regardless of the chosen timeframe.
 */
export function pollIntervalForTimeframe(
  timeframe: TrackingTimeframe,
): number {
  const barMs = TIMEFRAME_MS[timeframe];
  return Math.max(5_000, Math.min(60_000, Math.floor(barMs / 4)));
}
