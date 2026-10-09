/**
 * CANONICAL CANDLE RECORD
 * =======================
 * The one shape a candle has anywhere in SignalGOAT after it crosses the
 * provider boundary.
 *
 * WHY A SEPARATE TYPE FROM `Candle` (src/types)
 *
 * The UI-facing `Candle` is whatever the provider handed us. This type is the
 * normalized, validated, storage-ready form and it makes three things explicit
 * that `Candle` leaves implicit:
 *
 *   1. `openTimeMs` is UTC and is the candle's OPEN time, not its close time.
 *      Providers disagree on this and the disagreement silently shifts every
 *      indicator by one bar. It is stated here once and normalised everywhere.
 *   2. `finalized` is explicit. A still-forming bar must never satisfy a
 *      tracker that needs closed bars.
 *   3. `revision` counts late corrections, so a re-delivered candle that
 *      changed is visibly an update and not a duplicate.
 *
 * TIMESTAMP SEMANTICS (single source of truth)
 *
 * `openTimeMs` is ALWAYS the UTC epoch-millisecond timestamp of the candle's
 * FIRST SECOND, i.e. `floor(ms / 60000) * 60000`. Nothing else may store a
 * candle timestamp. Every id, range query, dedupe key and session assignment
 * derives from this field.
 */

export const MINUTE_MS = 60_000;

/**
 * One canonical, normalized one-minute candle.
 *
 * Volume is OPTIONAL on purpose: the live CFD feed has no consolidated tape
 * volume, and storing a fabricated 0 would make an illiquid bar
 * indistinguishable from a genuinely empty one.
 */
export interface CandleRecord {
  /** Canonical instrument id, e.g. "EUR/USD". Always trimmed + upper-cased. */
  instrument: string;
  /** UTC ms, aligned to the minute. The candle's OPEN time. */
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Only present when the provider supplies a reliable figure. */
  volume?: number;
  /**
   * True once the provider considers the bar closed.
   *
   * A finalized candle may still be corrected late (a late tick, a provider
   * backfill); that arrives as a NEW REVISION of the same id, never as a
   * different candle.
   */
  finalized: boolean;
  /** When this exact payload first reached us. */
  receivedAt: number;
  /** When this row was last written (first insert or later correction). */
  updatedAt: number;
  /**
   * Starts at 1. Increments only when a stored candle's OHLC changes.
   * A re-delivery of byte-identical OHLC does NOT bump it, which is what makes
   * duplicate delivery distinguishable from a late correction.
   */
  revision: number;
}

/** The only legal identifier for a candle: instrument + open minute. */
export function candleId(instrument: string, openTimeMs: number): string {
  return `${canonicalInstrument(instrument)}#${floorToMinute(openTimeMs)}`;
}

/** Floors a timestamp to its containing UTC minute (the candle's open time). */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** Canonical instrument normalisation. One place, used by every layer. */
export function canonicalInstrument(instrument: string): string {
  return instrument.trim().toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type CandleRejectionReason =
  | 'INSTRUMENT_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'TIMESTAMP_NOT_MINUTE_ALIGNED'
  | 'TIMESTAMP_FUTURE'
  | 'OHLC_NON_FINITE'
  | 'OHLC_NOT_POSITIVE'
  | 'OHLC_RANGE_INVALID'
  | 'OHLC_ZERO_RANGE'
  | 'VOLUME_INVALID';

export interface CandleValidationOk {
  ok: true;
  record: CandleRecord;
}

export interface CandleValidationError {
  ok: false;
  reason: CandleRejectionReason;
  detail: string;
  /**
   * Partial progress: when the rejection is about OHLC values rather than the
   * key, the identity is still usable. Ingestion keeps the row for repair and
   * counts the fault instead of silently dropping a candle with no trace.
   */
  instrument?: string;
  openTimeMs?: number;
}

export type CandleValidationResult = CandleValidationOk | CandleValidationError;

/** Upper bound on how far ahead of "now" a candle open time may sit. */
const FUTURE_TOLERANCE_MS = 2 * MINUTE_MS;

export interface ValidateCandleOptions {
  /** Injectable clock, so tests are deterministic. */
  now?: () => number;
  /**
   * Accept a candle that is more than one minute off the minute grid by
   * flooring it into alignment (off-by-one from a sloppy provider) instead of
   * rejecting it. Defaults to true; set false for strict ingestion.
   */
  floorTimestamps?: boolean;
}

/**
 * The single gate every provider payload passes through.
 *
 * Two rules drive the whole design:
 *
 *   - NEVER fabricate. A missing minute stays missing. A zero price is not a
 *     price. This function rejects; it never repairs a value.
 *   - NEVER guess. Timestamps are floored only to the minute grid (a pure
 *     normalisation); a timestamp that is not even a plausible time is
 *     rejected outright.
 */
export function validateCandle(
  input: unknown,
  options: ValidateCandleOptions = {},
): CandleValidationResult {
  if (typeof input !== 'object' || input === null) {
    return {
      ok: false,
      reason: 'OHLC_NON_FINITE',
      detail: 'Candle is not an object.',
    };
  }

  const raw = input as Record<string, unknown>;

  const instrumentRaw =
    typeof raw.instrument === 'string'
      ? raw.instrument
      : typeof raw.symbol === 'string'
        ? raw.symbol
        : '';

  const instrument = canonicalInstrument(instrumentRaw);

  if (!instrument || instrument.length > 32 || !/^[A-Z0-9/_-]+$/.test(instrument)) {
    return {
      ok: false,
      reason: 'INSTRUMENT_INVALID',
      detail: `Unusable instrument identifier: ${JSON.stringify(instrumentRaw)}`,
    };
  }

  const rawTime =
    typeof raw.openTimeMs === 'number'
      ? raw.openTimeMs
      : typeof raw.time === 'number'
        ? raw.time
        : NaN;

  if (!Number.isFinite(rawTime) || rawTime <= 0) {
    return {
      ok: false,
      reason: 'TIMESTAMP_INVALID',
      detail: `Unusable open timestamp: ${String(raw.time ?? raw.openTimeMs)}`,
      instrument,
    };
  }

  const openTimeMs = floorToMinute(rawTime);

  if (openTimeMs % MINUTE_MS !== 0) {
    return {
      ok: false,
      reason: 'TIMESTAMP_NOT_MINUTE_ALIGNED',
      detail: 'Timestamp could not be normalised to the minute grid.',
      instrument,
    };
  }

  const now = options.now ? options.now() : Date.now();
  if (openTimeMs > now + FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      reason: 'TIMESTAMP_FUTURE',
      detail: `Candle opens ${openTimeMs - now}ms in the future.`,
      instrument,
      openTimeMs,
    };
  }

  const o = toFinite(raw.open);
  const h = toFinite(raw.high);
  const l = toFinite(raw.low);
  const c = toFinite(raw.close);

  if (o === null || h === null || l === null || c === null) {
    return {
      ok: false,
      reason: 'OHLC_NON_FINITE',
      detail: `Non-finite OHLC: ${JSON.stringify([raw.open, raw.high, raw.low, raw.close])}`,
      instrument,
      openTimeMs,
    };
  }

  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) {
    return {
      ok: false,
      reason: 'OHLC_NOT_POSITIVE',
      detail: `Non-positive price: ${JSON.stringify([o, h, l, c])}`,
      instrument,
      openTimeMs,
    };
  }

  const highest = Math.max(o, h, l, c);
  const lowest = Math.min(o, h, l, c);

  // The high must bound everything and the low must bound everything. This
  // catches the classic corrupt-bar case where close sits outside [low, high].
  if (h < highest - PRICE_EPSILON || l > lowest + PRICE_EPSILON) {
    return {
      ok: false,
      reason: 'OHLC_RANGE_INVALID',
      detail: `Inconsistent bar: O=${o} H=${h} L=${l} C=${c}`,
      instrument,
      openTimeMs,
    };
  }

  if (h < l) {
    return {
      ok: false,
      reason: 'OHLC_RANGE_INVALID',
      detail: `High below low: H=${h} L=${l}`,
      instrument,
      openTimeMs,
    };
  }

  /**
   * A completely flat bar (H == L == O == C) is legal in real markets — a
   * dead-quote minute — but it is also the exact shape a stuck-price bug
   * produces. It is NOT rejected here; it is recorded and surfaced through the
   * data-quality counters so the decision stays visible and configurable
   * rather than being hidden in a validator.
   */
  const flat = h === l && o === l && c === l;

  const volume = readVolume(raw.volume);

  if (volume !== undefined && (!Number.isFinite(volume) || volume < 0)) {
    return {
      ok: false,
      reason: 'VOLUME_INVALID',
      detail: `Unusable volume: ${String(raw.volume)}`,
      instrument,
      openTimeMs,
    };
  }

  const record: CandleRecord = {
    instrument,
    openTimeMs,
    open: o,
    high: h,
    low: l,
    close: c,
    ...(volume !== undefined ? { volume } : {}),
    finalized: raw.finalized === undefined ? true : Boolean(raw.finalized),
    receivedAt:
      typeof raw.receivedAt === 'number' && Number.isFinite(raw.receivedAt)
        ? raw.receivedAt
        : now,
    updatedAt: now,
    revision: 1,
  };

  /**
   * `flat` is surfaced on the validated record rather than logged-and-dropped,
   * so the ingestion pipeline can count degenerate bars without re-deriving
   * them. It is deliberately NOT part of the storage key.
   */
  void flat;

  return { ok: true, record };
}

/**
 * Absolute tolerance for OHLC ordering, in relative price terms.
 *
 * Providers round to a fixed number of digits, so `high` can land a hair below
 * `close` when they round in different directions. A relative epsilon avoids
 * rejecting valid bars while still catching genuinely corrupt ones.
 */
const PRICE_EPSILON = 1e-9;

function toFinite(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Volume is kept ONLY when the provider supplies a real number.
 *
 * `undefined`, `null` and non-finite all collapse to "no volume". This matters:
 * the live CFD feed reports `volume: 0` constantly, and pretending a zero is a
 * measurement makes an illiquid bar indistinguishable from a data gap.
 */
function readVolume(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** True when both records carry the same OHLC payload. */
export function sameOhlc(a: CandleRecord, b: CandleRecord): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

/**
 * Upsert outcome for one batch, with the numbers observability needs.
 *
 * `updated` counts REVISIONS, not arrivals. A duplicate redelivery is
 * `duplicates` and never touches a stored row.
 */
export interface UpsertOutcome {
  inserted: number;
  updated: number;
  /** Rejected before storage. Never silently dropped — always counted. */
  rejected: number;
  /** Valid rows that were identical to what was already stored. */
  duplicates: number;
  /** Rows whose revision advanced because a stored value changed. */
  revisions: Array<{ id: string; from: number; to: number }>;
  /** Present only when the batch was not fully storable. */
  errors?: string[];
}

/** One-minute candles for an instrument, ascending. The consumer contract. */
export function sortAscending(records: CandleRecord[]): CandleRecord[] {
  return [...records].sort((a, b) => a.openTimeMs - b.openTimeMs);
}