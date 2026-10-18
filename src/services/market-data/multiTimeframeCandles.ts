/**
 * MULTI-TIMEFRAME CANDLE CONTEXT
 * ==============================
 * One place that defines how much history a room loads at every timeframe,
 * and that fetches it without turning a single review into a burst of
 * provider requests.
 *
 * WHY MULTI-TIMEFRAME
 * -------------------
 * A single 60-bar 1h window tells a model almost nothing about where price
 * sits in the larger structure: it cannot see the daily trend, and it cannot
 * distinguish a 5m pullback inside an uptrend from a 5m pullback inside a
 * downtrend. Every timeframe answers a different question —
 *
 *   5m   what is the market doing right now
 *   15m  what is the current session doing
 *   1h   what is the day's structure
 *   4h   what is the swing structure
 *   1D   what is the regime
 *
 * so the agent is given all five rather than one.
 *
 * WHY A SHARED CACHE
 * ------------------
 * The chart, the AI context and the tracker evaluator all want the same
 * series, and a room polls its market route every few seconds. Fetching
 * 1,500 candles per wake, per viewer, per poll would hammer the upstream
 * provider for data that changes once per bar. A short TTL cache collapses
 * every reader in that window onto one upstream request.
 */

import type { Candle } from '../../types';
import { analyzeMarketStructure } from '../tracker-sdk/indicators';

export interface TimeframePlanEntry {
  timeframe: string;
  /** How much history this timeframe is loaded with. */
  count: number;
}

/**
 * The room's candle plan, coarsest first.
 *
 * Counts are deliberately asymmetric: a 1D bar carries far more information
 * per bar than a 5m bar, so the daily series needs the fewest and the
 * intraday series the most. These are UPPER BOUNDS — a provider that only
 * lists 289 five-minute bars returns 289, and `available` reports the truth
 * rather than the request.
 */
export const ROOM_TIMEFRAME_PLAN: readonly TimeframePlanEntry[] = [
  { timeframe: '1D', count: 100 },
  { timeframe: '4h', count: 200 },
  { timeframe: '1h', count: 300 },
  { timeframe: '15m', count: 400 },
  { timeframe: '5m', count: 500 },
];

export const ROOM_PRIMARY_TIMEFRAME = '1h';

/** Candles actually serialised into a prompt per timeframe. */
const PROMPT_CANDLES_PER_TIMEFRAME = 30;

/** Structure is computed over the whole series, not the prompt slice. */
export interface TimeframeStructure {
  bias: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastSwingHigh: number;
  lastSwingLow: number;
  retracementPct: number;
  demandZone: { low: number; high: number };
  supplyZone: { low: number; high: number };
}

/** What the agent receives for one timeframe. */
export interface TimeframeContext {
  timeframe: string;
  /** Bars actually received — may be fewer than `count`. */
  available: number;
  requested: number;
  /** Oldest and newest bar timestamps, so the model can reason about coverage. */
  fromTime: number;
  toTime: number;
  structure: TimeframeStructure;
  /** The most recent bars only; the full series stays on the server. */
  recent: Candle[];
}

export interface MultiTimeframeContext {
  symbol: string;
  timeframes: Record<string, TimeframeContext>;
}

/** The timeframe a symbol's provider can actually serve, given what loaded. */
export function pickPrimaryTimeframe(timeframes: Record<string, TimeframeContext>): string {
  const primary = timeframes[ROOM_PRIMARY_TIMEFRAME];
  if (primary && primary.available > 0) return ROOM_PRIMARY_TIMEFRAME;
  return Object.entries(timeframes).find(([, value]) => value.available > 0)?.[0] ?? ROOM_PRIMARY_TIMEFRAME;
}

/**
 * Builds the prompt-facing view of one series.
 *
 * The full series is used to derive structure — swing points and zones are
 * only meaningful over a wide window — while only the recent tail travels in
 * the prompt. Sending all 1,500 bars as text would blow the token budget for
 * no gain: the model reads levels and structure, not raw history it cannot
 * mentally index anyway.
 */
export function buildTimeframeContext(
  timeframe: string,
  candles: Candle[],
  requested: number,
  currentMid: number,
): TimeframeContext {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const structure = analyzeMarketStructure(sorted, currentMid);
  return {
    timeframe,
    available: sorted.length,
    requested,
    fromTime: sorted[0]?.time ?? 0,
    toTime: sorted.at(-1)?.time ?? 0,
    structure,
    recent: sorted.slice(-PROMPT_CANDLES_PER_TIMEFRAME),
  };
}

type CandleLoader = (symbol: string, timeframe: string, count: number) => Promise<Candle[]>;

/**
 * Fetches the whole plan in parallel.
 *
 * One timeframe failing never fails the rest: a partial context is far more
 * useful than none, and the prompt states which timeframes are missing rather
 * than implying full coverage.
 */
export async function loadMultiTimeframeCandles(
  symbol: string,
  load: CandleLoader,
  currentMid: number,
  plan: readonly TimeframePlanEntry[] = ROOM_TIMEFRAME_PLAN,
): Promise<MultiTimeframeContext> {
  const loaded = await Promise.all(plan.map(async entry => {
    try {
      const candles = await load(symbol, entry.timeframe, entry.count);
      return [entry.timeframe, buildTimeframeContext(entry.timeframe, candles, entry.count, currentMid)] as const;
    } catch {
      return [entry.timeframe, buildTimeframeContext(entry.timeframe, [], entry.count, currentMid)] as const;
    }
  }));
  return { symbol, timeframes: Object.fromEntries(loaded) };
}

/* -------------------------------------------------------------------------
   Shared TTL cache
   ------------------------------------------------------------------------- */

/** One candle bar per timeframe; well under any provider's rate limit. */
const TTL_MS = 20_000;
const cache = new Map<string, { expiresAt: number; context: MultiTimeframeContext }>();
const inflight = new Map<string, Promise<MultiTimeframeContext>>();

/**
 * Cached multi-timeframe load, de-duplicating concurrent callers.
 *
 * Keyed by symbol AND plan, because a chart asking for 5m-only and a review
 * asking for the full plan are different requests and must not share an entry.
 */
export async function cachedMultiTimeframeCandles(
  cacheKey: string,
  load: () => Promise<MultiTimeframeContext>,
): Promise<MultiTimeframeContext> {
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.context;

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const request = load()
    .then(context => {
      cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, context });
      return context;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, request);
  return request;
}