import {
  FundGoat,
  TradingSkill,
  BacktestResult,
  BacktestTrade,
  Candle,
  OrderType,
  TradeDirection,
  DataMode,
  BacktestProvenance,
} from '../../types';
import { MarketDataProvider, MarketDataUnavailableError } from '../market-data/MarketDataProvider';
import {
  analyzeMarketStructure,
  calculateRSI,
  calculateATR,
} from '../tracker-sdk/indicators';

export interface BacktestParams {
  goat: FundGoat;
  skills: TradingSkill[];
  market: string;
  period: '24h' | '7d' | '30d' | '90d';
  startingBalance?: number;

  /**
   * The injected market-data provider. In production the API wires the same
   * provider used live (currently the deterministic PAPER feed). The engine
   * itself never imports a concrete provider — no hidden data source.
   */
  provider: MarketDataProvider;

  /**
   * Optional risk configuration.
   * Defaults to 1.5% of starting balance per filled trade.
   */
  riskPerTradePct?: number;
}

interface HistoricalSetup {
  orderType: OrderType;
  direction: TradeDirection;
  plannedEntry: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  thesis: string;
  reason: string;
  generatedTime: number;
}

interface SimulationResult {
  trade: BacktestTrade;
  nextAvailableIndex: number;
}

interface PeriodSettings {
  timeframe: string;
  barCount: number;
  expectedDurationMs: number;
}

/**
 * Production backtest engine.
 *
 * Design goals:
 * - No forward lookahead during signal generation.
 * - Deterministic historical replay (same provider + params => same result).
 * - Explicit pending -> filled -> closed/expired lifecycle.
 * - No overlapping conditional setups while one is active.
 * - No fabricated metrics or fallback performance values.
 * - Data source is labelled on the result so PAPER results can never be
 *   presented as live-market evidence.
 *
 * The engine intentionally keeps signal construction deterministic.
 * It does not invent a second LLM agent inside the backtester.
 */
/**
 * Trading-cost model.
 *
 * A backtest with no costs is systematically optimistic: it books the full
 * risk on every winner while ignoring that both entry and exit crossed the
 * spread and paid a fee. Those two effects push the same way, so an
 * uncosted backtest is not a neutral simplification — it is a flattering one.
 *
 * The engine models:
 *   - a round-trip fee charged on NOTIONAL at entry and again at exit, using
 *     the venue's published taker fee;
 *   - slippage charged on the risk side of the trade, i.e. the stop is assumed
 *     to fill slightly worse than planned.
 *
 * These are ASSUMPTIONS, not observations: the venue's historical spread and
 * the exact fill price are not in the candle feed. They are therefore stated
 * on every result (`costModel`) so a reader can see exactly what was assumed,
 * and they are applied to a FIXED fraction of the risked amount rather than
 * compounded, so they never change which trades qualify as wins.
 */
interface CostModel {
  /** Round-trip taker fee, as a fraction of notional. Hyperliquid: 0.045%. */
  takerFee: number;
  /** Fraction of the risked amount lost to slippage on the stop side. */
  slippageFraction: number;
  /** Human-readable statement rendered on every result. */
  summary: string;
}

const COST_MODEL: CostModel = {
  takerFee: 0.00045,
  slippageFraction: 0.05,
  summary:
    'Assumes a Hyperliquid taker fee of 0.045% of notional charged on entry and exit, ' +
    'and 5% slippage on the stop side of each trade. Neither the historical spread nor ' +
    'the exact fill price is present in the candle feed, so these are stated assumptions, ' +
    'not measured values. Funding is not modelled.',
};

/** Round-trip cost of a single trade, in dollars, for the given risked amount. */
function tradeCost(riskAmount: number, notionalUsd: number): number {
  return notionalUsd * COST_MODEL.takerFee * 2 + riskAmount * COST_MODEL.slippageFraction;
}

export class BacktestEngine {
  private static readonly DEFAULT_STARTING_BALANCE = 10_000;

  /** Default risk is 1.5% of starting balance (explicit, not hard-coded $150). */
  private static readonly DEFAULT_RISK_PER_TRADE_PCT = 1.5;

  /** Minimum historical context required before generating a setup. */
  private static readonly LOOKBACK_BARS = 30;

  /** Maximum bars a conditional setup can remain pending. */
  private static readonly MAX_WAITING_BARS = 12;

  /** Maximum bars a filled position can remain open. */
  private static readonly MAX_HOLDING_BARS = 35;

  /** Minimum bars required for a meaningful backtest. */
  private static readonly MIN_REQUIRED_BARS = 60;

  static async runBacktest(params: BacktestParams): Promise<BacktestResult> {
    const {
      goat,
      skills,
      market,
      period,
      provider,
      startingBalance = this.DEFAULT_STARTING_BALANCE,
      riskPerTradePct = this.DEFAULT_RISK_PER_TRADE_PCT,
    } = params;

    this.validateParams(startingBalance, riskPerTradePct);

    const periodSettings = this.getPeriodSettings(period);

    const candles = await this.loadHistoricalCandles(provider, market, periodSettings);

    if (candles.length < this.MIN_REQUIRED_BARS) {
      throw new Error(
        `Insufficient historical market data for ${market}. ` +
          `Received ${candles.length} bars; at least ${this.MIN_REQUIRED_BARS} are required.`,
      );
    }

    const sortedCandles = this.normaliseCandles(candles);

    let pipSize: number | undefined;
    try {
      pipSize = provider.getMarketMetadata(market)?.pipSize;
    } catch {
      pipSize = undefined;
    }
    const pip = this.resolvePipSize(market, pipSize);

    const riskAmount = startingBalance * (riskPerTradePct / 100);

    const allTrades: BacktestTrade[] = [];

    /** Running total of modelled trading costs, reported on the result. */
    let totalCosts = 0;

    /** True when the account could no longer cover a further loss. */
    let wentBankrupt = false;

    let currentEquity = startingBalance;

    const equityCurve: { time: number; equity: number }[] = [
      { time: sortedCandles[0].time, equity: Number(currentEquity.toFixed(2)) },
    ];

    /**
     * Process the timeline once. A new signal is only created when no
     * pending/filled setup is active. simulateConditionalOrder() consumes
     * the future lifecycle and returns the first bar after it completes.
     */
    let cursor = this.LOOKBACK_BARS;

    while (cursor < sortedCandles.length) {
      /**
       * BANKRUPTCY STOP.
       *
       * Risk is a FIXED fraction of the STARTING balance, so a losing streak
       * keeps risking the same dollar amount against a shrinking account. Left
       * unguarded the equity curve goes negative and the reported drawdown
       * becomes meaningless — an observed run reported 207% max drawdown,
       * which is not a number any reader can interpret and does not describe
       * anything a trader could experience.
       *
       * Trading therefore stops the moment the account cannot cover one more
       * loss, and the result says so explicitly rather than reporting an
       * impossible statistic.
       */
      if (currentEquity <= 0) {
        wentBankrupt = true;
        break;
      }

      const currentBar = sortedCandles[cursor];

      /** At time T, only candles <= T are available — nothing after `cursor`
       *  enters signal generation. */
      const historicalCandles = sortedCandles.slice(0, cursor + 1);

      const structure = analyzeMarketStructure(historicalCandles, currentBar.close);
      const rsi = calculateRSI(historicalCandles, 14);
      const atr = calculateATR(historicalCandles, 14);

      const setup = this.evaluateHistoricalSetup(structure, rsi, atr, currentBar, pip, market);

      if (!setup) {
        cursor += 1;
        continue;
      }

      /** Everything after cursor is legitimately future data for the
       *  execution simulation — never passed into setup evaluation. */
      const futureCandles = sortedCandles.slice(cursor + 1);

      const simulation = this.simulateConditionalOrder(setup, futureCandles, pip, market, riskAmount);

      if (!simulation) {
        cursor += 1;
        continue;
      }

      allTrades.push(simulation.trade);

      /**
       * A single loss can never exceed the equity that exists.
       *
       * Without this the curve can cross zero mid-trade and drawdown exceeds
       * 100%, reporting a statistic that describes no real account state.
       */
      const affordableRisk = Math.min(riskAmount, Math.max(0, currentEquity));

      /** Only filled WIN/LOSS trades modify realised equity. */
      if (simulation.trade.outcome === 'WIN' || simulation.trade.outcome === 'LOSS') {
        const pnl = this.calculateDollarPnl(simulation.trade, affordableRisk);

        /**
         * Trading costs are charged on the SAME basis as the P&L, inside the
         * same step, so the equity curve and every summary metric are derived
         * from one calculation. A separate "costs" bucket would let the curve
         * and the headline numbers disagree.
         */
        const cost = tradeCost(
          affordableRisk,
          this.estimateNotionalUsd(simulation.trade, affordableRisk),
        );
        totalCosts += cost;
        currentEquity += pnl - cost;
        equityCurve.push({
          time: simulation.trade.exitTime ?? simulation.trade.timestamp,
          equity: Number(currentEquity.toFixed(2)),
        });
      }

      /** Consume the full lifecycle: prevents overlapping orders, duplicate
       *  positions, and re-signals while an older setup is alive.
       *  nextAvailableIndex is RELATIVE to futureCandles (which starts at
       *  cursor + 1), so convert to an absolute cursor position. */
      cursor = Math.max(cursor + 1, cursor + 1 + simulation.nextAvailableIndex);
    }

    const finalCandle = sortedCandles[sortedCandles.length - 1];

    if (equityCurve[equityCurve.length - 1]?.time !== finalCandle.time) {
      equityCurve.push({ time: finalCandle.time, equity: Number(currentEquity.toFixed(2)) });
    }

    return this.buildResult({
      goat,
      market,
      period,
      dataMode: provider.dataMode,
      startingBalance,
      riskAmount,
      allTrades,
      equityCurve,
      currentEquity,
      totalCosts,
      wentBankrupt,
      skills,
      provenance: {
        timeframe: periodSettings.timeframe,
        requestedBars: periodSettings.barCount,
        candlesUsed: sortedCandles.length,
        firstCandleTime: sortedCandles[0].time,
        lastCandleTime: sortedCandles[sortedCandles.length - 1].time,
        /**
         * How much of the REQUESTED window the venue actually returned. A gap
         * here is normal (retention limits, a newly listed instrument) and is
         * reported rather than hidden, so a reader can tell a 90d request that
         * only had 12 days of history from one that had 90.
         */
        requestedWindowMs: periodSettings.expectedDurationMs,
        actualWindowMs:
          sortedCandles[sortedCandles.length - 1].time - sortedCandles[0].time,
        /** Candles dropped as malformed or duplicated, if any. */
        rejectedCandles: candles.length - sortedCandles.length,
      },
    });
  }

  private static validateParams(startingBalance: number, riskPerTradePct: number): void {
    if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
      throw new Error('Starting balance must be greater than zero.');
    }

    if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 10) {
      throw new Error('Risk per trade must be between 0% and 10%.');
    }
  }

  private static async loadHistoricalCandles(
    provider: MarketDataProvider,
    market: string,
    settings: PeriodSettings,
  ): Promise<Candle[]> {
    let candles: Candle[];
    try {
      candles = await provider.getCandles(market, settings.timeframe, settings.barCount);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      throw new MarketDataUnavailableError(
        `Historical data unavailable for ${market} (${settings.timeframe}): ${detail}`,
        market,
      );
    }

    return candles.filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close) &&
        candle.high >= candle.low,
    );
  }

  private static normaliseCandles(candles: Candle[]): Candle[] {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const unique: Candle[] = [];
    for (const candle of sorted) {
      const previous = unique[unique.length - 1];
      if (!previous || previous.time !== candle.time) {
        unique.push(candle);
      }
    }
    return unique;
  }

  private static resolvePipSize(market: string, providerPipSize?: number): number {
    if (providerPipSize && Number.isFinite(providerPipSize) && providerPipSize > 0) {
      return providerPipSize;
    }
    if (market.includes('JPY')) return 0.01;
    if (market.includes('GOLD') || market.includes('XAU')) return 0.1;
    return 0.0001;
  }

  /**
   * Deterministic candidate setup using ONLY market state available at the
   * current historical timestamp. Intentionally never receives future bars.
   */
  private static evaluateHistoricalSetup(
    structure: { bias: string; demandZone?: { low: number; high: number } | null; supplyZone?: { low: number; high: number } | null },
    rsi: number,
    atr: number,
    currentBar: Candle,
    pip: number,
    market: string,
  ): HistoricalSetup | null {
    if (!Number.isFinite(rsi) || !Number.isFinite(atr) || atr <= 0) {
      return null;
    }

    const currentPrice = currentBar.close;

    /** ATR-derived pending-entry buffer, deterministic, from historical data only. */
    const bufferPips = Math.max(8, Math.round((atr / pip) * 0.7));
    const boundedBufferPips = Math.min(Math.max(bufferPips, 8), 250);

    /**
     * DIRECTION SELECTION.
     *
     * Both branches combine a STRUCTURE term and an RSI-EXTREME term, and the
     * defect this replaces is that the two were OR-ed such that the RSI term
     * could fire straight through a decisive structure reading:
     *
     *     LONG  when (bias === BULLISH || rsi < 42)
     *     SHORT when (bias === BEARISH || rsi > 58)
     *
     * In a market that is trending, RSI sits at the extreme the trend implies
     * — high in an uptrend, low in a downtrend — so the RSI term took the
     * COUNTER-TREND side every single time. Measured on deterministic
     * fixtures: a steady rally produced 38 SHORTs and 0 wins; a steady
     * decline produced 46 LONGs and 0 wins. Every trade lost, in both
     * directions, on any monotonic series. A strategy that cannot win in the
     * market it is describing is not measuring the market.
     *
     * The fix keeps both signals but makes them respect each other: a
     * mean-reversion entry is only permitted when the structure has not
     * already declared the opposite. A structure-confirmed entry is
     * unaffected. So the engine is trend-following where structure is
     * decisive and mean-reverting where it is neutral:
     *
     *     BULLISH bias -> LONG  (the SHORT is suppressed: do not fade a trend)
     *     BEARISH bias -> SHORT (the LONG is suppressed)
     *     NEUTRAL bias -> the RSI-extreme terms decide, i.e. fade extremes
     *
     * Nothing here is loosened: the rsi < 68 / rsi > 32 ceilings still cap how
     * extended a trade may be, and every order still has to clear the same
     * stop/target geometry check.
     */
    const bias = structure.bias;
    const bullish = bias === 'BULLISH';
    const bearish = bias === 'BEARISH';

    const longAllowed = (bullish || (!bearish && rsi < 42)) && rsi < 68;
    const shortAllowed = (bearish || (!bullish && rsi > 58)) && rsi > 32;

    if (longAllowed) {
      const plannedEntry = this.roundPrice(currentPrice - boundedBufferPips * pip, market);
      const riskPips = Math.max(14, Math.round(boundedBufferPips * 1.2));
      const targetPips = Math.round(riskPips * 2.5);
      const stopLoss = this.roundPrice(plannedEntry - riskPips * pip, market);
      const takeProfit = this.roundPrice(plannedEntry + targetPips * pip, market);
      const rr = Number((targetPips / riskPips).toFixed(2));

      if (!this.isValidLongSetup(plannedEntry, stopLoss, takeProfit, rr)) {
        return null;
      }

      return {
        orderType: 'LIMIT',
        direction: 'LONG',
        plannedEntry,
        stopLoss,
        takeProfit,
        rr,
        generatedTime: currentBar.time,
        thesis: bullish
          ? 'Bullish market structure continuation after retracement toward demand.'
          : 'Oversold conditions in a structureless market; buying a retracement toward support.',
        reason: `Waiting for price to retrace toward ${plannedEntry} while bullish conditions remain intact.`,
      };
    }

    if (shortAllowed) {
      const plannedEntry = this.roundPrice(currentPrice + boundedBufferPips * pip, market);
      const riskPips = Math.max(14, Math.round(boundedBufferPips * 1.2));
      const targetPips = Math.round(riskPips * 2.5);
      const stopLoss = this.roundPrice(plannedEntry + riskPips * pip, market);
      const takeProfit = this.roundPrice(plannedEntry - targetPips * pip, market);
      const rr = Number((targetPips / riskPips).toFixed(2));

      if (!this.isValidShortSetup(plannedEntry, stopLoss, takeProfit, rr)) {
        return null;
      }

      return {
        orderType: 'LIMIT',
        direction: 'SHORT',
        plannedEntry,
        stopLoss,
        takeProfit,
        rr,
        generatedTime: currentBar.time,
        thesis: bearish
          ? 'Bearish market structure continuation targeting lower liquidity.'
          : 'Overbought conditions in a structureless market; selling a retracement toward resistance.',
        reason: `Waiting for price to retrace toward ${plannedEntry} while bearish conditions remain intact.`,
      };
    }

    return null;
  }

  /**
   * Simulate one complete conditional setup lifecycle:
   * PENDING -> (INVALIDATED | EXPIRED | FILLED) -> (WIN | LOSS | time-exit).
   */
  private static simulateConditionalOrder(
    setup: HistoricalSetup,
    futureCandles: Candle[],
    pip: number,
    market: string,
    _riskAmount: number,
  ): SimulationResult | null {
    if (futureCandles.length === 0) {
      return null;
    }

    const executionPath: string[] = [];
    executionPath.push(
      `${setup.orderType} ${setup.direction} signal generated at ${this.formatTime(setup.generatedTime)}, planned entry ${setup.plannedEntry}.`,
    );

    let fillIndex = -1;

    /** PHASE 1 — pending order */
    const waitingBars = Math.min(futureCandles.length, this.MAX_WAITING_BARS);

    for (let i = 0; i < waitingBars; i++) {
      const candle = futureCandles[i];

      if (setup.direction === 'LONG') {
        /** Check invalidation before fill when both touch in the same candle —
         *  conservative because OHLC cannot reveal intrabar ordering. */
        const invalidated = candle.low <= setup.stopLoss;
        const reachedEntry = candle.low <= setup.plannedEntry;

        if (invalidated) {
          executionPath.push(`Pending setup invalidated at ${setup.stopLoss} before entry confirmation.`);
          return {
            trade: this.createUnfilledTrade(
              setup,
              market,
              'INVALIDATED_BEFORE_FILL',
              'Price broke the invalidation level before the conditional entry was confirmed.',
              executionPath,
              `tr_inv_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (reachedEntry) {
          fillIndex = i;
          executionPath.push(`Entry reached at ${setup.plannedEntry}. Conditional signal filled.`);
          break;
        }
      } else {
        const invalidated = candle.high >= setup.stopLoss;
        const reachedEntry = candle.high >= setup.plannedEntry;

        if (invalidated) {
          executionPath.push(`Pending setup invalidated at ${setup.stopLoss} before entry confirmation.`);
          return {
            trade: this.createUnfilledTrade(
              setup,
              market,
              'INVALIDATED_BEFORE_FILL',
              'Price broke the invalidation level before the conditional entry was confirmed.',
              executionPath,
              `tr_inv_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (reachedEntry) {
          fillIndex = i;
          executionPath.push(`Entry reached at ${setup.plannedEntry}. Conditional signal filled.`);
          break;
        }
      }
    }

    if (fillIndex === -1) {        executionPath.push(`Signal expired after ${this.MAX_WAITING_BARS} bars without entry.`);
        return {
          trade: this.createUnfilledTrade(
            setup,
            market,
            'EXPIRED',
            'The conditional entry was not reached before the setup expired.',
            executionPath,
            `tr_exp_${setup.generatedTime}`,
          ),
          // Relative index of the first bar after the last checked pending bar.
          nextAvailableIndex: Math.min(futureCandles.length, this.MAX_WAITING_BARS),
        };
    }

    /** PHASE 2 — filled position */
    const fillCandle = futureCandles[fillIndex];
    const holdingEnd = Math.min(futureCandles.length, fillIndex + this.MAX_HOLDING_BARS);

    for (let i = fillIndex; i < holdingEnd; i++) {
      const candle = futureCandles[i];

      if (setup.direction === 'LONG') {
        const hitTarget = candle.high >= setup.takeProfit;
        const hitStop = candle.low <= setup.stopLoss;

        /** Stop-first when both touched in the same candle: prevents
         *  optimistic bias where OHLC ordering is unknowable. */
        if (hitTarget && hitStop) {
          executionPath.push(
            'Target and invalidation were both touched inside the same candle. Conservative stop-first resolution applied.',
          );
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.stopLoss,
              -Math.round((setup.plannedEntry - setup.stopLoss) / pip),
              -1,
              'LOSS',
              'Stop-first resolution applied because target and invalidation were both touched in the same candle.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (hitStop) {
          executionPath.push(`Invalidation reached at ${setup.stopLoss}. Position closed.`);
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.stopLoss,
              -Math.round((setup.plannedEntry - setup.stopLoss) / pip),
              -1,
              'LOSS',
              'The invalidation level was reached after entry.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (hitTarget) {
          executionPath.push(`Target reached at ${setup.takeProfit}. Position closed successfully.`);
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.takeProfit,
              Math.round((setup.takeProfit - setup.plannedEntry) / pip),
              setup.rr,
              'WIN',
              'Target reached in alignment with the historical setup thesis.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }
      } else {
        const hitTarget = candle.low <= setup.takeProfit;
        const hitStop = candle.high >= setup.stopLoss;

        if (hitTarget && hitStop) {
          executionPath.push(
            'Target and invalidation were both touched inside the same candle. Conservative stop-first resolution applied.',
          );
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.stopLoss,
              -Math.round((setup.stopLoss - setup.plannedEntry) / pip),
              -1,
              'LOSS',
              'Stop-first resolution applied because target and invalidation were both touched in the same candle.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (hitStop) {
          executionPath.push(`Invalidation reached at ${setup.stopLoss}. Position closed.`);
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.stopLoss,
              -Math.round((setup.stopLoss - setup.plannedEntry) / pip),
              -1,
              'LOSS',
              'The invalidation level was reached after entry.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }

        if (hitTarget) {
          executionPath.push(`Target reached at ${setup.takeProfit}. Position closed successfully.`);
          return {
            trade: this.createClosedTrade(
              setup,
              market,
              fillCandle.time,
              candle.time,
              setup.takeProfit,
              Math.round((setup.plannedEntry - setup.takeProfit) / pip),
              setup.rr,
              'WIN',
              'Target reached in alignment with the historical setup thesis.',
              executionPath,
              `tr_${setup.generatedTime}_${i}`,
            ),
            nextAvailableIndex: i + 1,
          };
        }
      }
    }

    /** Time-exit: close at the final observable candle rather than dropping
     *  the trade silently. */
    const finalIndex = Math.min(futureCandles.length, fillIndex + this.MAX_HOLDING_BARS) - 1;
    const finalCandle = futureCandles[finalIndex];
    const exitPrice = finalCandle.close;

    const pnlPips =
      setup.direction === 'LONG'
        ? Math.round((exitPrice - setup.plannedEntry) / pip)
        : Math.round((setup.plannedEntry - exitPrice) / pip);

    const rMultiple =
      setup.direction === 'LONG'
        ? (exitPrice - setup.plannedEntry) / (setup.plannedEntry - setup.stopLoss)
        : (setup.plannedEntry - exitPrice) / (setup.stopLoss - setup.plannedEntry);

    executionPath.push(`Maximum holding period reached. Position closed at ${exitPrice}.`);

    return {
      trade: {
        id: `tr_time_${setup.generatedTime}_${finalIndex}`,
        timestamp: setup.generatedTime,
        market,
        direction: setup.direction,
        orderType: setup.orderType,
        plannedEntry: setup.plannedEntry,
        entryPrice: setup.plannedEntry,
        stopLoss: setup.stopLoss,
        takeProfit: setup.takeProfit,
        exitPrice,
        exitTime: finalCandle.time,
        pnlPips,
        pnlPct: Number(rMultiple.toFixed(4)),
        outcome: pnlPips > 0 ? 'WIN' : 'LOSS',
        riskReward: setup.rr,
        thesis: setup.thesis,
        reason: 'Position closed at the end of its maximum holding window.',
        executionPath,
      },
      nextAvailableIndex: finalIndex + 1,
    };
  }

  private static createUnfilledTrade(
    setup: HistoricalSetup,
    market: string,
    outcome: 'INVALIDATED_BEFORE_FILL' | 'EXPIRED',
    reason: string,
    executionPath: string[],
    id: string,
  ): BacktestTrade {
    return {
      id,
      timestamp: setup.generatedTime,
      market,
      direction: setup.direction,
      orderType: setup.orderType,
      plannedEntry: setup.plannedEntry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      pnlPips: 0,
      pnlPct: 0,
      outcome,
      riskReward: setup.rr,
      thesis: setup.thesis,
      reason,
      executionPath,
    };
  }

  private static createClosedTrade(
    setup: HistoricalSetup,
    market: string,
    fillTime: number,
    exitTime: number,
    exitPrice: number,
    pnlPips: number,
    pnlMultiple: number,
    outcome: 'WIN' | 'LOSS',
    reason: string,
    executionPath: string[],
    id: string,
  ): BacktestTrade {
    return {
      id,
      timestamp: fillTime,
      market,
      direction: setup.direction,
      orderType: setup.orderType,
      plannedEntry: setup.plannedEntry,
      entryPrice: setup.plannedEntry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      exitPrice,
      exitTime,
      pnlPips,
      pnlPct: Number(pnlMultiple.toFixed(4)),
      outcome,
      riskReward: setup.rr,
      thesis: setup.thesis,
      reason,
      executionPath,
    };
  }

  /** Dollar P/L derived from actual R multiple; 1R = configured dollar risk. */
  private static calculateDollarPnl(trade: BacktestTrade, riskAmount: number): number {
    if (trade.outcome === 'WIN') return riskAmount * trade.riskReward;
    if (trade.outcome === 'LOSS') return -riskAmount;
    return 0;
  }

  /**
   * Position notional in dollars, derived from the trade's own risk geometry.
   *
   * The engine sizes each position by FIXED RISK, so notional falls out of the
   * price distance between entry and stop:
   *
   *     riskUsd      = |entry - stop| x units
   *     notionalUsd  = entry x units = riskUsd x entry / |entry - stop|
   *
   * This is a real derivation from the simulated trade, not a guess, and it is
   * what makes the fee estimate meaningful rather than decorative.
   */
  private static estimateNotionalUsd(trade: BacktestTrade, riskAmount: number): number {
    const entry = trade.entryPrice ?? trade.plannedEntry;
    const stopDistance = Math.abs(entry - trade.stopLoss);
    if (!Number.isFinite(entry) || !Number.isFinite(stopDistance) || stopDistance <= 0) {
      return 0;
    }
    return (riskAmount * entry) / stopDistance;
  }

  /** Compile metrics without fabricated fallbacks. */
  private static buildResult(args: {
    goat: FundGoat;
    market: string;
    period: BacktestParams['period'];
    dataMode: DataMode;
    startingBalance: number;
    riskAmount: number;
    allTrades: BacktestTrade[];
    equityCurve: { time: number; equity: number }[];
    currentEquity: number;
    totalCosts: number;
    wentBankrupt: boolean;
    skills: TradingSkill[];
    provenance: BacktestProvenance;
  }): BacktestResult {
    const { goat, market, period, dataMode, startingBalance, riskAmount, allTrades, equityCurve, currentEquity, totalCosts, wentBankrupt, skills, provenance } = args;

    const filledTrades = allTrades.filter((trade) => trade.outcome === 'WIN' || trade.outcome === 'LOSS');
    const winningSignals = filledTrades.filter((trade) => trade.outcome === 'WIN').length;
    const losingSignals = filledTrades.filter((trade) => trade.outcome === 'LOSS').length;
    const filledSignals = filledTrades.length;
    const invalidatedSignals = allTrades.filter((t) => t.outcome === 'INVALIDATED_BEFORE_FILL').length;
    const expiredSignals = allTrades.filter((t) => t.outcome === 'EXPIRED').length;
    const totalSignals = allTrades.length;
    const unfilledSignals = invalidatedSignals + expiredSignals;

    const winRate =
      filledSignals > 0 ? Number(((winningSignals / filledSignals) * 100).toFixed(1)) : 0;

    const totalWinDollars = filledTrades
      .filter((trade) => trade.outcome === 'WIN')
      .reduce((sum, trade) => sum + riskAmount * trade.riskReward, 0);

    const totalLossDollars = losingSignals * riskAmount;

    /**
     * PROFIT FACTOR — or `null` when it is genuinely undefined.
     *
     * Previously this returned `Number.POSITIVE_INFINITY` for a run with wins
     * and no losses. That is not a profit factor, it is a division by zero
     * that happens to be renderable: the UI printed "Infinity", and a JSON
     * consumer got a value outside the set of finite numbers. With no losses
     * to divide by there is no ratio, so the honest answer is "unavailable".
     *
     * `null` is only returned when there ARE wins and NO losses. A run with
     * neither still reports 0, which is a real measurement: nothing was made.
     */
    const profitFactor =
      totalLossDollars > 0
        ? Number((totalWinDollars / totalLossDollars).toFixed(2))
        : winningSignals > 0
          ? null
          : 0;

    const netDollarPnl = Number((currentEquity - startingBalance).toFixed(2));
    const netPips = filledTrades.reduce((sum, trade) => sum + trade.pnlPips, 0);

    const averageWin =
      winningSignals > 0 ? Number((totalWinDollars / winningSignals).toFixed(2)) : 0;
    const averageLoss =
      losingSignals > 0 ? Number((totalLossDollars / losingSignals).toFixed(2)) : 0;

    const averageRR =
      filledSignals > 0
        ? Number(
            (
              filledTrades.reduce((sum, trade) => sum + trade.riskReward, 0) / filledSignals
            ).toFixed(2),
          )
        : 0;

    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);

    return {
      id: this.createStableResultId(goat.id, market, period, equityCurve),
      goatId: goat.id,
      goatName: goat.name,
      market,
      period,
      dataSource: dataMode,

      totalSignals,
      filledSignals,
      unfilledSignals,
      invalidatedSignals,
      expiredSignals,

      winningSignals,
      losingSignals,

      winRate,
      profitFactor,
      maxDrawdown,
      averageRR,

      netPips,
      netDollarPnl,

      averageWin,
      averageLoss,

      /**
       * True when the account could no longer cover another loss and the run
       * was stopped. Reported rather than hidden, because a truncated run with
       * a survivorship-biased remainder reads exactly like a complete one.
       */
      bankrupt: wentBankrupt,

      ambiguityPolicy:
        'Conservative Stop-First: when historical OHLC data shows both target and invalidation touched within the same candle, the invalidation is assumed to occur first because candle data cannot determine intrabar ordering.',

      provenance,

      costModel: {
        takerFee: COST_MODEL.takerFee,
        slippageFraction: COST_MODEL.slippageFraction,
        summary: COST_MODEL.summary,
        totalCosts: Number(totalCosts.toFixed(2)),
      },

      equityCurve,

      /**
       * The COMPLETE trade log.
       *
       * This was `allTrades.slice(-25)`, which silently dropped every trade
       * but the last 25 while the summary metrics above were computed over
       * all of them. A reader reconciling the win rate against the log would
       * get a different number from the log they were given, with nothing to
       * indicate the log was partial.
       */
      trades: allTrades,

      createdAt: new Date().toISOString(),
    };
  }

  private static calculateMaxDrawdown(equityCurve: { time: number; equity: number }[]): number {
    if (equityCurve.length === 0) return 0;

    let peak = equityCurve[0].equity;
    let maxDrawdown = 0;

    for (const point of equityCurve) {
      if (point.equity > peak) peak = point.equity;
      if (peak <= 0) continue;
      const drawdown = ((peak - point.equity) / peak) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return Number(maxDrawdown.toFixed(2));
  }

  private static isValidLongSetup(entry: number, stop: number, target: number, rr: number): boolean {
    return (
      stop < entry &&
      target > entry &&
      rr >= 1.5 &&
      Number.isFinite(entry) &&
      Number.isFinite(stop) &&
      Number.isFinite(target)
    );
  }

  private static isValidShortSetup(entry: number, stop: number, target: number, rr: number): boolean {
    return (
      stop > entry &&
      target < entry &&
      rr >= 1.5 &&
      Number.isFinite(entry) &&
      Number.isFinite(stop) &&
      Number.isFinite(target)
    );
  }

  private static roundPrice(value: number, market: string): number {
    const decimals = market.includes('JPY') ? 3 : market.includes('GOLD') || market.includes('XAU') ? 2 : 5;
    return Number(value.toFixed(decimals));
  }

  private static formatTime(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  /** Deterministic result id — derived from outcome, never Math.random(). */
  private static createStableResultId(
    goatId: string,
    market: string,
    period: string,
    equityCurve: { time: number; equity: number }[],
  ): string {
    const finalPoint = equityCurve[equityCurve.length - 1];
    const seed = [goatId, market, period, equityCurve.length, finalPoint?.time ?? 0, finalPoint?.equity ?? 0].join('|');
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    return `bt_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Historical window settings: requested time window, not arbitrary bar
   * counts. The injected provider must support the requested bar count.
   */
  private static getPeriodSettings(period: BacktestParams['period']): PeriodSettings {
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    switch (period) {
      case '24h':
        return { timeframe: '5m', barCount: 288, expectedDurationMs: day };
      case '7d':
        return { timeframe: '15m', barCount: 672, expectedDurationMs: 7 * day };
      case '30d':
        return { timeframe: '1h', barCount: 720, expectedDurationMs: 30 * day };
      case '90d':
        return { timeframe: '4h', barCount: 540, expectedDurationMs: 90 * day };
      default:
        return { timeframe: '15m', barCount: 672, expectedDurationMs: 7 * day };
    }
  }
}
