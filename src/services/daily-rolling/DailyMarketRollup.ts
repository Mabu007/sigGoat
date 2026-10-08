/**
 * DAILY MARKET ROLLUP SERVICE
 * ===========================
 * Drives the intraday -> recap -> rollover lifecycle from live market state.
 *
 * Responsibilities:
 *  - accumulate the running session for each tracked market
 *  - detect a trading-date change (or an explicit request) and roll up
 *  - persist the recap idempotently, keyed "<MARKET>:<YYYY-MM-DD>"
 *  - clear ONLY ephemeral intraday state
 *
 * It owns no durable business data. Recaps live in the application
 * persistence layer; this service holds the ephemeral session in memory, so a
 * process restart simply starts the current day from whatever market state is
 * fetched next. That is deliberate: a partially-tracked day must not be
 * reconstructed into a recap that looks complete.
 */

import {
  IntradayState,
  DailyMarketRecap,
  applyCandle,
  applyQuote,
  newIntradayState,
  recapId,
  recordEvent,
  rollover,
  rollUp,
  tradingDateFor,
} from './DailyMarketRecap';
import type { MarketStateSnapshot } from '../market-data/MarketStateStore';
import { isUsableMarketState } from '../market-data/MarketStateStore';
import type { MarketRecapRepository } from '../../server/repositories';

export interface DailyRollupServiceOptions {
  recaps: MarketRecapRepository;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class DailyMarketRollup {
  private readonly sessions = new Map<string, IntradayState>();
  private readonly recaps: MarketRecapRepository;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  readonly stats = {
    observations: 0,
    rollups: 0,
    rollupsMerged: 0,
    persistenceFailures: 0,
  };

  constructor(options: DailyRollupServiceOptions) {
    this.recaps = options.recaps;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message, error) => {
      if (error) console.warn(message, error);
    });
  }

  private session(market: string): IntradayState {
    const key = market.trim().toUpperCase();
    const today = tradingDateFor(this.now());

    let state = this.sessions.get(key);

    if (!state) {
      state = newIntradayState(key, today);
      this.sessions.set(key, state);
      return state;
    }

    /**
     * A new trading day has begun. Roll up what we have BEFORE switching, so
     * the completed day is persisted rather than silently overwritten by
     * tomorrow's prices.
     */
    if (state.tradingDate !== today) {
      void this.rollUpMarket(market, today);
    }

    return state;
  }

  /**
   * Folds a fresh market-state snapshot into the session.
   *
   * Only provider-confirmed (LIVE) snapshots contribute. Feeding DEGRADED
   * prices into a daily recap would put unconfirmed values into a durable
   * historical record, which is exactly the kind of quiet corruption this
   * system is meant to avoid.
   */
  observe(snapshot: MarketStateSnapshot): void {
    if (!isUsableMarketState(snapshot)) return;

    const state = this.session(snapshot.symbol);
    this.stats.observations += 1;

    let next = applyQuote(state, snapshot.quote!);

    /**
     * The final bar is the in-progress one. BiQuote marks it `isOpen`, and
     * that flag is not carried on our Candle, so the newest bar is treated as
     * unclosed: counting it could record a high that never printed.
     */
    for (let i = 0; i < snapshot.candles.length; i += 1) {
      const isLast = i === snapshot.candles.length - 1;
      next = applyCandle(next, snapshot.candles[i], !isLast);
    }

    this.sessions.set(snapshot.symbol.trim().toUpperCase(), next);
  }

  /** Records a tracker/wake/signal event against the current session. */
  recordEvent(
    market: string,
    kind: 'TRACKER_TRIGGERED' | 'WAKE' | 'SIGNAL',
    description: string,
  ): void {
    const state = this.session(market);
    this.sessions.set(
      market.trim().toUpperCase(),
      recordEvent(state, {
        at: this.now(),
        kind,
        description: description.slice(0, 300),
      }),
    );
  }

  /**
   * Persists the recap for a market and clears ephemeral state.
   *
   * Safe to call repeatedly: the recap id embeds the trading date, and an
   * existing record is merged rather than replaced, so a duplicate run cannot
   * produce two recaps for one day.
   */
  async rollUpMarket(
    market: string,
    nextTradingDate?: string,
  ): Promise<DailyMarketRecap | null> {
    const key = market.trim().toUpperCase();
    const state = this.sessions.get(key);

    if (!state) return null;

    const existing = await this.recaps
      .getById(recapId(key, state.tradingDate))
      .catch((err) => {
        this.stats.persistenceFailures += 1;
        this.log('[daily-rollup] recap read failed', err);
        return null;
      });

    const { recap, merged, nextIntraday } = rollUp(state, existing ?? undefined);

    try {
      await this.recaps.save(recap);
      this.stats.rollups += 1;
      if (merged) this.stats.rollupsMerged += 1;
    } catch (err) {
      this.stats.persistenceFailures += 1;
      this.log('[daily-rollup] recap write failed', err);
      // Keep the session intact so a retry can still persist it.
      return null;
    }

    /**
     * Only now is it safe to drop the ephemeral session. Persisting first
     * means a write failure never loses the day.
     */
    this.sessions.set(
      key,
      rollover(state, nextTradingDate ?? tradingDateFor(this.now())),
    );

    return recap;
  }

  /** Rolls up every tracked market. Used by the reconciliation pass. */
  async rollUpAll(): Promise<DailyMarketRecap[]> {
    const recaps: DailyMarketRecap[] = [];

    for (const market of [...this.sessions.keys()]) {
      const recap = await this.rollUpMarket(market);
      if (recap) recaps.push(recap);
    }

    return recaps;
  }

  /** Current sessions, for inspection. */
  activeSessions(): IntradayState[] {
    return [...this.sessions.values()];
  }

  listRecaps(market: string, limit = 30) {
    return this.recaps.listByMarket(market.trim().toUpperCase(), limit);
  }
}
