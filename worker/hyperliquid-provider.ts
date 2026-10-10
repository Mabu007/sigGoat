/**
 * HYPERLIQUID PROVIDER (Worker runtime)
 * =====================================
 * The Durable Object's only outbound call. Same provider as the app-side
 * `HyperliquidClient`, reimplemented here because the Workers runtime cannot
 * import Node-targeted modules and because the DO's needs are narrower: 1m
 * candles for a fixed instrument set, on a schedule.
 *
 * DOCS
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 *
 * REQUEST SHAPE
 *   POST /info  {"type":"candleSnapshot","req":{coin,interval,startTime,endTime}}
 *   The RESPONSE is an array of OBJECTS with string-typed prices:
 *     { t, T, s, i, o, h, l, c, v, n }
 *   NOT the array-of-arrays form several exchanges use. `v` is base-asset
 *   volume; `n` is the trade count.
 *
 * RATE LIMITS: 1200 weight/min per IP. A candleSnapshot costs 20 plus 1 per
 * 60 candles returned. With `MAX_INGEST_INSTRUMENTS` instruments on a
 * 60-second alarm, that is ~20 instruments x ~28 weight = 560/min, which sits
 * inside the budget with room for the app's own reads.
 *
 * SYMBOLS ARE THE PROVIDER'S OWN NAMES
 *   `BTC`, `xyz:GOLD`, `xyz:EUR`, `@107`. No alias table. The previous build
 *   mapped `EUR/USD -> EURUSD` for a different provider; that translation is
 *   removed, because on this venue the canonical identifier for an instrument
 *   is whatever the venue calls it and inventing a conventional symbol would
 *   send requests for coins that do not exist.
 */

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

/** Bound on a single provider call. */
const FETCH_TIMEOUT_MS = 8_000;

/** The only interval this object stores. */
export const INGEST_INTERVAL = '1m';

/** Bars requested per instrument per pass. */
const CANDLES_PER_FETCH = 180;

export interface ProviderCandle {
  /** Epoch milliseconds, floored to the minute. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Parses a provider numeric field.
 *
 * Returns `null` for anything unusable. Prices here arrive as STRINGS; `0` is
 * a legitimate value and `null` is not, so the two must never be conflated.
 */
function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalises one provider row.
 *
 * Returns `null` for a bar that cannot be trusted: a missing price, a
 * non-positive price, or `high < low`. Dropping the row is strictly better
 * than storing it — a corrupt bar would poison every indicator computed
 * downstream, and the next pass would re-request it anyway.
 */
export function parseCandleRow(row: unknown): ProviderCandle | null {
  const record = asRecord(row);
  if (!record) return null;

  const openTimeMs = asNumber(record.t);
  const open = asNumber(record.o);
  const high = asNumber(record.h);
  const low = asNumber(record.l);
  const close = asNumber(record.c);
  const volume = asNumber(record.v);

  if (openTimeMs === null || open === null || high === null || low === null || close === null) {
    return null;
  }
  if (open <= 0 || close <= 0 || high <= 0 || low <= 0) return null;
  if (high < low) return null;

  return {
    // The provider's `t` is already minute-aligned for a 1m interval, but the
    // floor makes the storage key deterministic regardless.
    time: Math.floor(openTimeMs / 60_000) * 60_000,
    open,
    high,
    low,
    close,
    // A bar with no recorded volume is real (nothing traded); it is 0, not null.
    volume: volume !== null && volume >= 0 ? volume : 0,
  };
}

/**
 * Fetches 1m candles for one instrument.
 *
 * The time range is derived from the bar count and interval so a pass asks
 * for a bounded window regardless of how much history the object already has.
 */
export async function fetchCandles(
  coin: string,
  interval: string = INGEST_INTERVAL,
  limit: number = CANDLES_PER_FETCH,
): Promise<ProviderCandle[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const endTime = Date.now();
    // 2x headroom so a market with gaps (a thin HIP-3 instrument, an
    // interval rounding boundary) still returns bars rather than nothing.
    const startTime = endTime - intervalMs(interval) * limit * 2;

    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime },
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error('Hyperliquid rate limited');
    }
    if (!response.ok) {
      throw new Error(`Hyperliquid HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error('Hyperliquid candleSnapshot did not return an array');
    }

    const candles: ProviderCandle[] = [];
    for (const row of payload) {
      const candle = parseCandleRow(row);
      if (candle) candles.push(candle);
    }

    // The provider returns newest-first; this runtime stores and reads
    // ascending, and `upsertCandles` relies on that ordering.
    candles.sort((a, b) => a.time - b.time);
    return candles.length > limit ? candles.slice(candles.length - limit) : candles;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirms an instrument exists before committing to polling it.
 *
 * One `meta` call covers the whole universe, so this is used to prune the
 * default set rather than to validate each coin. An instrument the venue does
 * not list returns no candles forever; detecting that once is cheaper than
 * retrying every minute.
 */
export async function listAvailableInstruments(): Promise<Set<string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: 'allPerpMetas' }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return null;

    // allPerpMetas is an array of [meta, assetCtxs] pairs, one per dex.
    // Each pair is itself an ARRAY, so `entry[0]` is the meta object — it
    // cannot be reached through the object helper, which rejects arrays.
    const names = new Set<string>();
    for (const entry of payload) {
      if (!Array.isArray(entry)) continue;
      const universe = asRecord(entry[0])?.universe;
      if (!Array.isArray(universe)) continue;
      for (const item of universe) {
        const record = asRecord(item);
        if (typeof record?.name === 'string') names.add(record.name.toUpperCase());
      }
    }
    return names.size > 0 ? names : null;
  } catch {
    // Reconciliation is best-effort. A transient failure must not stop
    // ingestion or drop the tracked universe.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function intervalMs(interval: string): number {
  const match = /^(\d+)([mhd])$/.exec(interval.trim());
  if (!match) return 60_000;
  const value = Number(match[1]);
  switch (match[2]) {
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return 60_000;
  }
}