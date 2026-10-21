import type { Candle } from '../../types';
import { StrategyEvaluationContext } from './indicators/evaluate';
import { normalizeCompletedCandles, STRATEGY_TIMEFRAME_MS } from './marketData';
import { evaluatePriceAction } from './priceAction';
import { migrateStrategyDefinition, type StrategyCondition, type StrategyDefinition, type StrategyOperand } from './schema';

export interface StrategyLog { id: string; at: string; candleTime?: number; type: string; message: string; details?: Record<string, unknown> }
export interface PaperPosition { id: string; direction: 'LONG' | 'SHORT'; quantity: number; entryPrice: number; openedAt: number; stopLoss: number; takeProfit: number; entryFee: number }
export interface PaperTrade extends PaperPosition { closedAt: number; exitPrice: number; exitReason: 'RULE' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END_OF_DATA'; pnl: number; fees: number }
export interface PendingEntry { direction: 'LONG' | 'SHORT'; signalCandleTime: number }
export interface StrategyRuntimeState {
  status: 'STOPPED' | 'PAPER' | 'ERROR';
  lastProcessedCandleTime: number | null;
  balance: number;
  equity: number;
  position: PaperPosition | null;
  trades: PaperTrade[];
  logs: StrategyLog[];
  lastEntryCandleIndex: number | null;
  lastEntryCandleTime: number | null;
  tradeDay: string | null;
  tradesToday: number;
  dayStartBalance: number | null;
  pendingEntry: PendingEntry | null;
  pendingExitSignalTime: number | null;
}
export interface BacktestMetrics { totalReturn: number; netPnl: number; maxDrawdown: number; winRate: number; profitFactor: number | null; completedTrades: number; averageTrade: number }
export interface StrategyBacktestResult { metrics: BacktestMetrics; trades: PaperTrade[]; equityCurve: Array<{ time: number; equity: number }>; logs: StrategyLog[]; candlesProcessed: number }

const round = (value: number, decimals = 8) => Number(value.toFixed(decimals));
const stableHash = (value: string) => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
};
const log = (type: string, message: string, candleTime = Date.now(), details?: Record<string, unknown>): StrategyLog => ({
  id: `${type}_${candleTime}_${stableHash(`${message}:${JSON.stringify(details ?? {})}`)}`,
  at: new Date(candleTime).toISOString(), type, message, candleTime, ...(details ? { details } : {}),
});

export function initialRuntimeState(definition: StrategyDefinition): StrategyRuntimeState {
  return { status: 'STOPPED', lastProcessedCandleTime: null, balance: definition.execution.startingBalance, equity: definition.execution.startingBalance, position: null, trades: [], logs: [], lastEntryCandleIndex: null, lastEntryCandleTime: null, tradeDay: null, tradesToday: 0, dayStartBalance: null, pendingEntry: null, pendingExitSignalTime: null };
}

/**
 * EVALUATES ONE CONDITION AT ONE CANDLE
 *
 * The condition is evaluated with the candles up to and including `index`.
 * Nothing after that candle is read, so a signal can never depend on a
 * candle that has not closed yet.
 */
export function evaluateCondition(
  context: StrategyEvaluationContext,
  condition: StrategyCondition,
  index: number,
): boolean {
  if (condition.type === 'price_action') {
    return evaluatePriceAction(condition.pattern, condition.params, context.candles, index);
  }
  if (condition.type === 'all') return condition.conditions.every(child => evaluateCondition(context, child, index));
  if (condition.type === 'any') return condition.conditions.some(child => evaluateCondition(context, child, index));
  if (condition.type === 'not') return !evaluateCondition(context, condition.condition, index);
  if (condition.type === 'sequence') {
    const steps = condition.steps;
    // The LAST step has to happen on this candle. The earlier steps have to
    // have happened on strictly earlier candles, no more than
    // `maxGapCandles` apart. That is what "followed by" means here, and it
    // is not the same thing as "and".
    if (!evaluateCondition(context, steps[steps.length - 1], index)) return false;
    let upper = index;
    for (let step = steps.length - 2; step >= 0; step -= 1) {
      let found = -1;
      for (let candidate = upper - 1; candidate >= 0; candidate -= 1) {
        if (upper - candidate > condition.maxGapCandles) break;
        if (evaluateCondition(context, steps[step], candidate)) { found = candidate; break; }
      }
      if (found < 0) return false;
      upper = found;
    }
    return true;
  }
  const left = context.operand(condition.left, index);
  const right = context.operand(condition.right, index);
  if (!left.available || !right.available || !Number.isFinite(left.current) || !Number.isFinite(right.current)) return false;
  switch (condition.operator) {
    case 'GT': return left.current > right.current;
    case 'GTE': return left.current >= right.current;
    case 'LT': return left.current < right.current;
    case 'LTE': return left.current <= right.current;
    case 'EQ': return Math.abs(left.current - right.current) <= Number.EPSILON * Math.max(1, Math.abs(left.current), Math.abs(right.current));
    case 'CROSS_ABOVE': return left.previous !== null && right.previous !== null && left.previous <= right.previous && left.current > right.current;
    case 'CROSS_BELOW': return left.previous !== null && right.previous !== null && left.previous >= right.previous && left.current < right.current;
  }
}

/**
 * Evaluates a condition against a candle list, using the last candle as the
 * decision candle. Kept for callers that hold a candle list rather than a
 * context.
 */
export function evaluateConditionOnCandles(
  definition: StrategyDefinition,
  condition: StrategyCondition,
  candles: readonly Candle[],
  context?: StrategyEvaluationContext,
): boolean {
  if (!candles.length) return false;
  const evaluation = context ?? new StrategyEvaluationContext(definition, candles);
  return evaluateCondition(evaluation, condition, candles.length - 1);
}

function fillPrice(close: number, direction: 'LONG' | 'SHORT', slippageBps: number, opening: boolean): number {
  const adverse = direction === 'LONG' ? 1 : -1;
  const sign = opening ? adverse : -adverse;
  return close * (1 + sign * slippageBps / 10_000);
}

function closePosition(definition: StrategyDefinition, state: StrategyRuntimeState, candle: Candle, exitPrice: number, reason: PaperTrade['exitReason']): StrategyRuntimeState {
  const position = state.position!;
  const gross = position.direction === 'LONG' ? (exitPrice - position.entryPrice) * position.quantity : (position.entryPrice - exitPrice) * position.quantity;
  const exitFee = Math.abs(exitPrice * position.quantity) * definition.execution.feeRate;
  const pnl = gross - position.entryFee - exitFee;
  const trade: PaperTrade = { ...position, closedAt: candle.time, exitPrice: round(exitPrice), exitReason: reason, pnl: round(pnl), fees: round(position.entryFee + exitFee) };
  const balance = state.balance + gross - exitFee;
  return { ...state, balance: round(balance), equity: round(balance), position: null, trades: [...state.trades, trade], logs: [...state.logs, log('POSITION_CLOSED', `${position.direction} position closed by ${reason}.`, candle.time, { pnl: trade.pnl, exitPrice: trade.exitPrice })] };
}

/**
 * Processes one completed candle.
 *
 * `index` is the index of the candle inside `context.candles`. It must be
 * the last candle of the series that the caller has already closed.
 */
function processCompletedCandleAt(
  definition: StrategyDefinition,
  state: StrategyRuntimeState,
  context: StrategyEvaluationContext,
  index: number,
): StrategyRuntimeState {
  const candle = context.candles[index];
  if (!candle) return { ...state, status: 'ERROR', logs: [...state.logs, log('RUNTIME_ERROR', 'No completed candle was supplied.')] };
  if (state.status !== 'PAPER') return state;
  if (state.lastProcessedCandleTime !== null && candle.time <= state.lastProcessedCandleTime) return state;
  const day = new Date(candle.time).toISOString().slice(0, 10);
  const newTradingDay = state.tradeDay !== day;
  let next: StrategyRuntimeState = {
    ...state,
    lastProcessedCandleTime: candle.time,
    tradeDay: day,
    tradesToday: newTradingDay ? 0 : state.tradesToday,
    dayStartBalance: newTradingDay ? state.balance : (state.dayStartBalance ?? state.balance),
    pendingEntry: state.pendingEntry ?? null,
    pendingExitSignalTime: state.pendingExitSignalTime ?? null,
    lastEntryCandleTime: state.lastEntryCandleTime ?? null,
  };

  // Rule signals are generated only after a candle closes. They execute at
  // the next completed candle's open, which was genuinely available after
  // the signal and avoids same-close look-ahead bias.
  if (next.position && next.pendingExitSignalTime !== null && next.pendingExitSignalTime < candle.time) {
    next = closePosition(definition, next, candle, fillPrice(candle.open, next.position.direction, definition.execution.slippageBps, false), 'RULE');
    next = { ...next, pendingExitSignalTime: null };
  }

  if (!next.position && next.pendingEntry && next.pendingEntry.signalCandleTime < candle.time) {
    const pending = next.pendingEntry;
    const entryPrice = fillPrice(candle.open, pending.direction, definition.execution.slippageBps, true);
    const stopDistance = entryPrice * definition.risk.stopLossPercent / 100;
    const dailyLoss = Math.max(0, (next.dayStartBalance ?? next.balance) - next.balance);
    const dailyLossLimit = (next.dayStartBalance ?? next.balance) * definition.risk.maxDailyLossPercent / 100;
    let quantity = definition.risk.sizing.mode === 'FIXED_QUANTITY'
      ? definition.risk.sizing.quantity
      : (next.balance * definition.risk.sizing.percent / 100) / stopDistance;
    quantity = Math.min(quantity, (next.balance * definition.risk.maxExposurePercent / 100) / entryPrice);
    if (dailyLoss >= dailyLossLimit) {
      next = { ...next, pendingEntry: null, logs: [...next.logs, log('RISK_REJECTED', 'Entry rejected because the daily loss limit was reached.', candle.time, { dailyLoss, dailyLossLimit })] };
    } else if (!Number.isFinite(quantity) || quantity <= 0) {
      next = { ...next, pendingEntry: null, logs: [...next.logs, log('RISK_REJECTED', 'Entry rejected because position sizing produced no valid quantity.', candle.time)] };
    } else {
      const entryFee = Math.abs(entryPrice * quantity) * definition.execution.feeRate;
      const position: PaperPosition = {
        id: `position_${pending.signalCandleTime}_${candle.time}`, direction: pending.direction, quantity: round(quantity), entryPrice: round(entryPrice), openedAt: candle.time,
        stopLoss: round(pending.direction === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance),
        takeProfit: round(pending.direction === 'LONG' ? entryPrice * (1 + definition.risk.takeProfitPercent / 100) : entryPrice * (1 - definition.risk.takeProfitPercent / 100)),
        entryFee: round(entryFee),
      };
      next = { ...next, balance: round(next.balance - entryFee), position, pendingEntry: null, lastEntryCandleIndex: index, lastEntryCandleTime: candle.time, tradesToday: next.tradesToday + 1, logs: [...next.logs, log('PAPER_FILL', `${position.direction} paper position opened at the next candle open.`, candle.time, { quantity: position.quantity, entryPrice: position.entryPrice, signalCandleTime: pending.signalCandleTime })] };
    }
  }

  if (next.position) {
    const position = next.position;
    const stopHit = position.direction === 'LONG' ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
    const targetHit = position.direction === 'LONG' ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;
    if (stopHit) next = closePosition(definition, next, candle, position.stopLoss, 'STOP_LOSS');
    else if (targetHit) next = closePosition(definition, next, candle, position.takeProfit, 'TAKE_PROFIT');
  }

  const cooldownReady = next.lastEntryCandleTime === null
    || candle.time - next.lastEntryCandleTime > definition.risk.cooldownCandles * STRATEGY_TIMEFRAME_MS[definition.market.timeframe];
  if (next.position && next.pendingExitSignalTime === null && definition.exit.condition && evaluateCondition(context, definition.exit.condition, index)) {
    next = { ...next, pendingExitSignalTime: candle.time, logs: [...next.logs, log('EXIT_SIGNAL', 'Exit condition matched; order queued for the next candle open.', candle.time)] };
  } else if (!next.position && !next.pendingEntry && next.tradesToday < definition.risk.maxTradesPerDay && cooldownReady && evaluateCondition(context, definition.entry.condition, index)) {
    next = { ...next, pendingEntry: { direction: definition.entry.direction, signalCandleTime: candle.time }, logs: [...next.logs, log('ENTRY_SIGNAL', `${definition.entry.direction} entry condition matched; order queued for the next candle open.`, candle.time)] };
  }
  const unrealized = next.position ? (next.position.direction === 'LONG' ? candle.close - next.position.entryPrice : next.position.entryPrice - candle.close) * next.position.quantity : 0;
  return { ...next, equity: round(next.balance + unrealized), logs: next.logs.slice(-500) };
}

/**
 * Processes the last completed candle of a candle list.
 *
 * `context` may be supplied by a caller that already has one, so a backtest
 * calculates every indicator only once for the whole run.
 */
export function processCompletedCandle(
  rawDefinition: StrategyDefinition,
  state: StrategyRuntimeState,
  candles: readonly Candle[],
  context?: StrategyEvaluationContext,
): StrategyRuntimeState {
  const definition = migrateStrategyDefinition(rawDefinition);
  if (!candles.length) return { ...state, status: 'ERROR', logs: [...state.logs, log('RUNTIME_ERROR', 'No completed candle was supplied.')] };
  const evaluation = context ?? new StrategyEvaluationContext(definition, candles);
  return processCompletedCandleAt(definition, state, evaluation, candles.length - 1);
}

export function runStrategyBacktest(rawDefinition: StrategyDefinition, input: readonly Candle[]): StrategyBacktestResult {
  const definition = migrateStrategyDefinition(rawDefinition);
  const candles = normalizeCompletedCandles(input, definition.market.timeframe, Number.MAX_SAFE_INTEGER);
  const context = new StrategyEvaluationContext(definition, candles);
  let state: StrategyRuntimeState = { ...initialRuntimeState(definition), status: 'PAPER', logs: [log('BACKTEST_STARTED', `Backtest started with ${candles.length} completed candles.`, candles[0]?.time ?? 0)] };
  const equityCurve: Array<{ time: number; equity: number }> = [];
  for (let index = 0; index < candles.length; index += 1) {
    state = processCompletedCandleAt(definition, state, context, index);
    equityCurve.push({ time: candles[index].time, equity: state.equity });
  }
  const finalCandle = candles.at(-1);
  if (state.position && finalCandle) {
    state = closePosition(definition, state, finalCandle, fillPrice(finalCandle.close, state.position.direction, definition.execution.slippageBps, false), 'END_OF_DATA');
    if (equityCurve.length) equityCurve[equityCurve.length - 1] = { time: finalCandle.time, equity: state.equity };
  }
  const wins = state.trades.filter(trade => trade.pnl > 0);
  const losses = state.trades.filter(trade => trade.pnl < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  let peak = definition.execution.startingBalance;
  let maxDrawdown = 0;
  for (const point of equityCurve) { peak = Math.max(peak, point.equity); if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak * 100); }
  const netPnl = state.balance - definition.execution.startingBalance;
  return {
    metrics: { totalReturn: round(netPnl / definition.execution.startingBalance * 100, 4), netPnl: round(netPnl, 2), maxDrawdown: round(maxDrawdown, 4), winRate: state.trades.length ? round(wins.length / state.trades.length * 100, 2) : 0, profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : null, completedTrades: state.trades.length, averageTrade: state.trades.length ? round(netPnl / state.trades.length, 2) : 0 },
    trades: state.trades, equityCurve, logs: [...state.logs, log('BACKTEST_COMPLETED', `Backtest completed with ${state.trades.length} closed trades.`, finalCandle?.time ?? 0)], candlesProcessed: candles.length,
  };
}
