/**
 * MARKET DATA EVENT CONTRACT
 * ==========================
 * The versioned message a shared market-data runtime publishes to the GOATs
 * subscribed to an instrument.
 *
 * WHY COMPACT
 *
 * An event is a NOTIFICATION that something changed, not a data transfer. It
 * carries the identity of the candle and where to read the candle from — the
 * id plus the instrument plus the open time — never the whole history.
 *
 * Broadcasting 120 candles to every subscriber on every minute would turn a
 * 20-byte message into a multi-kilobyte fan-out to N GOATs, and the receiving
 * GOAT would discard most of it. Consumers resolve `reference` through the
 * storage port instead, which is also what lets several GOATs share one stored
 * copy rather than each holding a private one.
 *
 * NO USER DATA
 *
 * Events carry no user id, no key, no thesis, no signal. The only GOAT-shaped
 * field is `partition`, which is routing information, not identity. This is
 * what makes it safe for a shared runtime to publish to subscribers it knows
 * only as opaque routing keys.
 */

export const MARKET_EVENT_SCHEMA_VERSION = 1;

export type MarketEventType =
  | 'CANDLE_FINALIZED'
  | 'CANDLE_CORRECTED'
  | 'SESSION_FINALIZED'
  | 'LEVEL_BROKEN'
  | 'DATA_STALE'
  | 'DATA_RECOVERED';

export interface MarketEvent {
  /**
   * Stable, deterministic event id.
   *
   * `<partition>:<type>:<instrument>:<candleOpenTimeMs>` — the same logical
   * occurrence always produces the same id, which is what makes duplicate
   * suppression possible without a shared database.
   */
  eventId: string;
  eventIdVersion: 1;
  type: MarketEventType;
  /** Routing key: the shared runtime partition that produced this. */
  partition: string;
  instrument: string;
  /**
   * Open time (UTC ms) of the candle this event concerns. Null for events that
   * are not candle-scoped, such as a data-stale notice.
   */
  candleOpenTimeMs: number | null;
  /** Whether the referenced candle is final at the moment of the event. */
  finalized: boolean;
  /**
   * Where to read the payload. For candles this is the candle id, which is
   * `instrument#openTimeMs` — stable, derivable, and never a payload.
   */
  reference: string | null;
  /** Compact, non-identifying context. Never prices for the whole history. */
  context: MarketEventContext;
  schemaVersion: number;
  createdAtMs: number;
}

export interface MarketEventContext {
  /** Seconds since the newest candle closed, at emit time. */
  lagSeconds?: number;
  /** Session the candle belongs to, when one applies. */
  sessionId?: string;
  /** Summary id, for SESSION_FINALIZED. */
  summaryId?: string;
  /** Level id, for LEVEL_BROKEN. */
  levelId?: string;
  breakDirection?: 'ABOVE' | 'BELOW';
  /** Data-quality signal the tracker evaluator must respect. */
  dataQuality?: 'OK' | 'DEGRADED' | 'SUSPECT';
  /** Populated on a failure notice; never contains credentials. */
  failureReason?: string;
}

/**
 * Builds the deterministic id.
 *
 * Determinism is the whole point: a retried ingestion that re-finalizes the
 * same candle must produce the SAME event id, so every consumer's duplicate
 * check suppresses it without coordination.
 */
export function buildEventId(
  partition: string,
  type: MarketEventType,
  instrument: string,
  candleOpenTimeMs: number | null,
): string {
  return [
    partition,
    type,
    instrument.trim().toUpperCase(),
    candleOpenTimeMs === null ? 'na' : String(candleOpenTimeMs),
  ].join(':');
}

export interface CreateMarketEventInput {
  type: MarketEventType;
  partition: string;
  instrument: string;
  candleOpenTimeMs?: number | null;
  finalized?: boolean;
  reference?: string | null;
  context?: MarketEventContext;
  now?: () => number;
}

export function createMarketEvent(input: CreateMarketEventInput): MarketEvent {
  const instrument = input.instrument.trim().toUpperCase();
  const candleOpenTimeMs = input.candleOpenTimeMs ?? null;
  const createdAtMs = input.now ? input.now() : Date.now();

  return {
    eventId: buildEventId(input.partition, input.type, instrument, candleOpenTimeMs),
    eventIdVersion: 1,
    type: input.type,
    partition: input.partition,
    instrument,
    candleOpenTimeMs,
    finalized: input.finalized ?? false,
    reference:
      input.reference ??
      (candleOpenTimeMs === null
        ? null
        : `${instrument}#${candleOpenTimeMs}`),
    context: input.context ?? {},
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    createdAtMs,
  };
}

/**
 * Validates an event arriving from the shared runtime.
 *
 * The shared runtime is trusted infrastructure, not a trusted INPUT: a stale
 * deployment, a mismatched schema or a corrupted payload must be refused at
 * this boundary rather than acted on. A malformed event is dropped, not
 * partially applied.
 */
export function validateMarketEvent(input: unknown): MarketEvent | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;

  if (typeof raw.eventId !== 'string' || !raw.eventId) return null;
  if (raw.eventIdVersion !== 1) return null;
  if (typeof raw.partition !== 'string' || !raw.partition) return null;
  if (typeof raw.instrument !== 'string' || !raw.instrument) return null;
  if (raw.schemaVersion !== MARKET_EVENT_SCHEMA_VERSION) return null;

  const validTypes: MarketEventType[] = [
    'CANDLE_FINALIZED',
    'CANDLE_CORRECTED',
    'SESSION_FINALIZED',
    'LEVEL_BROKEN',
    'DATA_STALE',
    'DATA_RECOVERED',
  ];
  if (typeof raw.type !== 'string' || !validTypes.includes(raw.type as MarketEventType)) {
    return null;
  }

  const candleOpenTimeMs =
    typeof raw.candleOpenTimeMs === 'number' &&
    Number.isFinite(raw.candleOpenTimeMs)
      ? raw.candleOpenTimeMs
      : null;

  /**
   * The id is recomputed from the payload rather than trusted. A mismatch means
   * the event was altered or is from a different schema generation, and it is
   * refused — otherwise an attacker-supplied id could be used to suppress a
   * legitimate event by collision.
   */
  const expectedId = buildEventId(
    raw.partition,
    raw.type as MarketEventType,
    raw.instrument,
    candleOpenTimeMs,
  );
  if (expectedId !== raw.eventId) return null;

  return {
    eventId: raw.eventId,
    eventIdVersion: 1,
    type: raw.type as MarketEventType,
    partition: raw.partition,
    instrument: raw.instrument.trim().toUpperCase(),
    candleOpenTimeMs,
    finalized: Boolean(raw.finalized),
    reference:
      typeof raw.reference === 'string'
        ? raw.reference
        : candleOpenTimeMs === null
          ? null
          : `${raw.instrument.trim().toUpperCase()}#${candleOpenTimeMs}`,
    context:
      typeof raw.context === 'object' && raw.context !== null
        ? (raw.context as MarketEventContext)
        : {},
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    createdAtMs:
      typeof raw.createdAtMs === 'number' ? raw.createdAtMs : Date.now(),
  };
}