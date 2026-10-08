/**
 * DAILY MARKET RECAP + INTRADAY ROLLOVER
 * ========================================
 * End-of-trading-day lifecycle for tracked markets.
 *
 *   DAY
 *   ├── intraday ticks
 *   ├── candle tracking
 *   ├── tracker events
 *   └── temporary state
 *          ↓  rollUp()
 *   ┌──────────────────────────────┐
 *   │ DailyMarketRecap (durable)   │
 *   └──────────────────────────────┘
 *          ↓  rollover clears ephemeral state only
 *   new trading day
 *
 * DESIGN RULES
 *
 * 1. DETERMINISTIC, NOT AI. A recap is aggregation of facts we already hold
 *    (OHLC, range, trend, tracker events). Calling a model to restate numbers
 *    we already have would cost money, add latency and risk hallucinating a
 *    figure. An AI-written summary, if wanted later, is a SEPARATE field and
 *    is never mixed with the facts.
 *
 * 2. IDEMPOTENT BY TRADING DATE. The key is "<MARKET>:<YYYY-MM-DD>". Running
 *    the rollover twice must not create two recaps, double-count an event, or
 *    lose the first one. Re-running merges into the existing recap.
 *
 * 3. ROLLOVER IS NARROW. It clears ONLY ephemeral intraday state. It never
 *    touches GOAT definitions, ownership, configuration, signals, thesis
 *    history or previously persisted recaps.
 */

import type { Candle, MarketQuote } from '../../types';

/** Events observed during the day, accumulated for the recap. */
export interface IntradayEvent {
  /** Epoch ms. */
  at: number;
  kind: 'TRACKER_TRIGGERED' | 'WAKE' | 'SIGNAL';
  description: string;
}

export interface DailyMarketRecap {
  /** Idempotency key: "<MARKET>:<YYYY-MM-DD>". */
  id: string;
  market: string;
  /** Trading date in the market's local calendar, YYYY-MM-DD. */
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Absolute change, close - open. */
  change: number;
  changePercent: number;
  /** high - low. */
  range: number;
  /** Range as a percentage of the open. */
  rangePercent: number;
  /** Derived from open vs close. */
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  barCount: number;
  /** Tracker/wake events that occurred during the session. */
  events: IntradayEvent[];
  /** Volume proxy; 0 on feeds without volume. */
  volume: number;
  createdAt: string;
  updatedAt: string;
  /** How many times the rollover has merged into this record. */
  revision: number;
}

/** Ephemeral state that a rollover clears. Nothing else is ever cleared. */
export interface IntradayState {
  market: string;
  /** Rolling trading date, YYYY-MM-DD. */
  tradingDate: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume: number;
  barCount: number;
  events: IntradayEvent[];
}

export function newIntradayState(
  market: string,
  tradingDate: string,
): IntradayState {
  return {
    market,
    tradingDate,
    volume: 0,
    barCount: 0,
    events: [],
  };
}

/**
 * Trading date for an epoch timestamp.
 *
 * Defaults to UTC. Forex sessions do not align to a calendar day, so a
 * session-based recap would need a per-market session boundary; UTC dates are
 * unambiguous and never produce a missing or duplicated day, which is exactly
 * what the idempotency key depends on.
 */
export function tradingDateFor(
  epochMs: number,
  timeZone: 'UTC' | 'local' = 'UTC',
): string {
  const date = new Date(epochMs);

  if (timeZone === 'UTC') {
    return date.toISOString().slice(0, 10);
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(
    date.getMonth() + 1,
  )}-${pad(date.getDate())}`;
}

export function recapId(
  market: string,
  tradingDate: string,
): string {
  return `${market.trim().toUpperCase()}:${tradingDate}`;
}

/**
 * Folds one quote into the running session.
 *
 * Idempotent: high/low are monotonic aggregates, so replaying the same quote
 * cannot corrupt them.
 */
export function applyQuote(
  state: IntradayState,
  quote: MarketQuote,
): IntradayState {
  const mid = quote.mid;
  if (!Number.isFinite(mid) || mid <= 0) return state;

  return {
    ...state,
    open: state.open ?? mid,
    high: Math.max(state.high ?? mid, mid),
    low: Math.min(state.low ?? mid, mid),
    close: mid,
    volume: state.volume + Math.max(0, quote.change24h),
  };
}

/**
 * Folds one CLOSED bar into the running session.
 *
 * The in-progress bar is ignored: a recap must not report a high that never
 * actually printed.
 */
export function applyCandle(
  state: IntradayState,
  candle: Candle,
  isClosed: boolean,
): IntradayState {
  if (!isClosed) return state;
  if (!Number.isFinite(candle.close) || candle.close <= 0) {
    return state;
  }

  return {
    ...state,
    open: state.open ?? candle.open,
    high: Math.max(state.high ?? candle.high, candle.high),
    low: Math.min(state.low ?? candle.low, candle.low),
    close: candle.close,
    barCount: state.barCount + 1,
    volume: state.volume + Math.max(0, candle.volume),
  };
}

/** Records a tracker/wake/signal event for the session. */
export function recordEvent(
  state: IntradayState,
  event: IntradayEvent,
): IntradayState {
  // Bounded so a pathological tracker loop cannot grow memory without limit.
  const events = [...state.events, event].slice(-200);
  return { ...state, events };
}

export interface RollupResult {
  recap: DailyMarketRecap;
  /** True when an existing recap was merged rather than created. */
  merged: boolean;
  /** Fresh, empty intraday state. */
  nextIntraday: IntradayState;
}

/**
 * Produces the daily recap for `state` and returns clean intraday state.
 *
 * Idempotency: pass the previously persisted recap, if any. When one exists the
 * new figures are MERGED — high/low take the wider span, events are unioned by
 * content — so a double rollover cannot lose data or create a duplicate
 * record. `merged` reports which happened.
 */
/**
 * True when a session actually observed something.
 *
 * A rollover clears the session, so a SECOND rollover of the same day starts
 * from an empty state. Merging an empty state into a real recap must not
 * overwrite the day's open/close with zeros — that is how a double rollover
 * silently destroys the record it was meant to preserve.
 */
export function hasSessionData(state: IntradayState): boolean {
  return (
    state.open !== undefined ||
    state.close !== undefined ||
    state.high !== undefined ||
    state.low !== undefined ||
    state.barCount > 0 ||
    state.events.length > 0
  );
}

export function rollUp(
  state: IntradayState,
  existing?: DailyMarketRecap,
): RollupResult {
  /**
   * Nothing new was observed. If a recap for this date already exists, return
   * it untouched rather than merging empty values into it.
   */
  if (!hasSessionData(state) && existing && existing.id === recapId(state.market, state.tradingDate)) {
    return {
      recap: {
        ...existing,
        updatedAt: new Date().toISOString(),
        revision: existing.revision + 1,
      },
      merged: true,
      nextIntraday: newIntradayState(
        state.market,
        state.tradingDate,
      ),
    };
  }

  const open = state.open ?? state.close ?? 0;
  const close = state.close ?? open;
  const high = state.high ?? close;
  const low = state.low ?? close;

  const change = close - open;
  const changePercent = open > 0 ? (change / open) * 100 : 0;
  const range = high - low;
  const rangePercent = open > 0 ? (range / open) * 100 : 0;

  const trend: DailyMarketRecap['trend'] =
    change > 0 ? 'BULLISH' : change < 0 ? 'BEARISH' : 'NEUTRAL';

  const id = recapId(state.market, state.tradingDate);
  const now = new Date().toISOString();

  if (existing && existing.id === id) {
    /**
     * Wider span wins, and a partial re-read must never overwrite confirmed
     * figures with zeros: a missing value keeps whatever was already recorded.
     */
    const positive = (a: number, b: number, prefer: 'min' | 'max') => {
      if (!Number.isFinite(b) || b <= 0) return a;
      if (!Number.isFinite(a) || a <= 0) return b;
      return prefer === 'min' ? Math.min(a, b) : Math.max(a, b);
    };

    const recap: DailyMarketRecap = {
      ...existing,
      open: positive(existing.open, open, 'min'),
      high: positive(existing.high, high, 'max'),
      low: positive(existing.low, low, 'min'),
      close: Number.isFinite(close) && close > 0 ? close : existing.close,
      change,
      changePercent,
      range: high - low,
      rangePercent,
      trend,
      barCount: Math.max(existing.barCount, state.barCount),
      volume: Math.max(existing.volume, state.volume),
      events: unionEvents(existing.events, state.events),
      updatedAt: now,
      revision: existing.revision + 1,
    };

    return {
      recap,
      merged: true,
      nextIntraday: newIntradayState(
        state.market,
        state.tradingDate,
      ),
    };
  }

  const recap: DailyMarketRecap = {
    id,
    market: state.market,
    tradingDate: state.tradingDate,
    open,
    high,
    low,
    close,
    change,
    changePercent,
    range,
    rangePercent,
    trend,
    barCount: state.barCount,
    events: [...state.events],
    volume: state.volume,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };

  return {
    recap,
    merged: false,
    nextIntraday: newIntradayState(
      state.market,
      state.tradingDate,
    ),
  };
}

/**
 * Clears ephemeral state for a NEW trading day.
 *
 * Deliberately constructs a fresh object rather than deleting fields: there
 * is no path here by which a recap, GOAT definition or signal is removed.
 */
export function rollover(
  state: IntradayState,
  nextTradingDate: string,
): IntradayState {
  return newIntradayState(state.market, nextTradingDate);
}

/** Union by content so a repeated event is never counted twice. */
function unionEvents(
  a: IntradayEvent[],
  b: IntradayEvent[],
): IntradayEvent[] {
  const seen = new Set<string>();
  const out: IntradayEvent[] = [];

  for (const event of [...a, ...b]) {
    const key = `${event.at}:${event.kind}:${event.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }

  return out.sort((x, y) => x.at - y.at).slice(-200);
}
