import type { BacktestProvenance, BacktestResult, BacktestTrade, Candle, DataMode, FundGoat, MarketThesis, TrackerCondition, TradingSkill } from '../../types';
import type { GoatReasoningContext } from '../ai/OpenRouterClient';
import type { ReasoningResult } from '../agent/contracts';
import type { MarketDataProvider } from '../market-data/MarketDataProvider';
import { evaluateTracker } from '../tracker-sdk/DeterministicTrackerEvaluator';

export type AgentBacktestPeriod = '24h' | '7d' | '30d' | '90d';
export type HistoricalGoatReasoner = (context: GoatReasoningContext, model: string) => Promise<ReasoningResult>;
export interface AgentBacktestParams {
  goat: FundGoat; skills: TradingSkill[]; market: string; period: AgentBacktestPeriod;
  provider: MarketDataProvider; reason: HistoricalGoatReasoner;
  startingBalance?: number; riskPerTradePct?: number;
}
interface OpenPosition { trade: BacktestTrade; entryIndex: number; riskDollars: number; }
interface PendingEntry { trade: BacktestTrade; signalIndex: number; expiresIndex: number; riskDollars: number; }

const PERIOD_BARS: Record<AgentBacktestPeriod, number> = { '24h': 288, '7d': 2016, '30d': 8640, '90d': 25920 };
const MIN_HISTORY = 60;
const CONTEXT_BARS = 120;
const MAX_PENDING_BARS = 12;
const MAX_HOLDING_BARS = 35;
const TAKER_FEE = 0.00045;
const STOP_SLIPPAGE = 0.05;
const COST_SUMMARY = 'Historical OHLC only. Assumes 0.045% taker fee on entry and exit plus 5% of risk as stop-side slippage; historical spread and funding are unavailable.';

function validCandle(c: Candle): boolean {
  return [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.open > 0 && c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high);
}
function normalize(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) if (validCandle(c)) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
function windowMs(period: AgentBacktestPeriod): number {
  const hours: Record<AgentBacktestPeriod, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };
  return hours[period] * 60 * 60 * 1000;
}
function trackerSignature(t: TrackerCondition): string {
  return [t.indicatorParams?.indicator, t.indicatorParams?.period, t.operator, t.targetValue, t.rangeLow, t.rangeHigh, t.description].join('|');
}
function trackersFrom(r: ReasoningResult, market: string, runId: string, at: number): TrackerCondition[] {
  return r.thesis.trackers.slice(0, 10).map((d, i) => ({
    id: runId + '_tracker_' + at + '_' + i,
    description: d.description, type: d.type, market,
    targetValue: d.targetValue, rangeLow: d.rangeLow, rangeHigh: d.rangeHigh, operator: d.operator,
    indicatorParams: { indicator: d.indicator ?? 'PRICE', period: d.period, fastPeriod: d.fastPeriod, slowPeriod: d.slowPeriod, session: d.session, threshold: d.targetValue },
    isTriggered: false, status: 'PENDING', formulaDescription: d.description,
  }));
}
function thesisFrom(goat: FundGoat, market: string, r: ReasoningResult, trackers: TrackerCondition[], at: number): MarketThesis {
  return {
    id: 'bt_thesis_' + goat.id + '_' + at, userId: goat.userId, goatId: goat.id, market,
    directionalHypothesis: r.thesis.directionalBias, summary: r.thesis.summary,
    assetState: r.investigation.marketView ?? r.investigation.summary,
    tradePlan: r.proposal.triggerSequence?.length ? r.proposal.triggerSequence : r.thesis.observationPlan ? [r.thesis.observationPlan] : [],
    supportingEvidence: r.evidence.map(e => e.observation), contradictoryEvidence: [],
    relevantTimeframe: '5m', confirmationConditions: trackers.map(t => t.description),
    invalidationConditions: r.thesis.invalidation ? [r.thesis.invalidation] : [],
    observationPlan: r.thesis.observationPlan, trackers, confidence: r.thesis.confidence,
    status: trackers.some(t => !t.isTriggered) ? 'TRACKING' : 'FORMULATING',
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
  };
}
function proposalTrade(r: ReasoningResult, goat: FundGoat, market: string, at: number, index: number, balance: number, riskPct: number): BacktestTrade | null {
  const p = r.proposal;
  if (p.decision !== 'ACTIONABLE' || !p.direction || !p.orderType ||
      !Number.isFinite(p.entry) || !Number.isFinite(p.stopLoss) || !Number.isFinite(p.takeProfit)) return null;
  const entry = p.entry as number, stop = p.stopLoss as number, target = p.takeProfit as number;
  const stopDistance = Math.abs(entry - stop), rewardDistance = Math.abs(target - entry);
  if (entry <= 0 || stop <= 0 || target <= 0 || stopDistance <= 0) return null;
  if (p.direction === 'LONG' && !(stop < entry && target > entry)) return null;
  if (p.direction === 'SHORT' && !(stop > entry && target < entry)) return null;
  const rr = rewardDistance / stopDistance;
  if (!Number.isFinite(rr) || rr < 1.4) return null;
  return {
    id: 'bt_' + goat.id + '_' + at + '_' + index, timestamp: at, market,
    direction: p.direction, orderType: p.orderType, plannedEntry: entry, stopLoss: stop, takeProfit: target,
    pnlPips: 0, pnlPct: 0, pnlDollars: 0, outcome: 'UNFILLED', riskReward: Number(rr.toFixed(2)),
    thesis: r.thesis.summary, reason: p.rationale ?? r.investigation.summary,
    executionPath: ['Historical GOAT review at ' + new Date(at).toISOString(),
      'Model proposal: ' + p.direction + ' ' + p.orderType + '; entry ' + entry + ', SL ' + stop + ', TP ' + target,
      'Job: ' + goat.goal],
  };
}
function closePosition(position: OpenPosition, candle: Candle, exit: number, reason: string, pip: number): number {
  const t = position.trade, entry = t.entryPrice as number;
  const stopDistance = Math.abs(entry - t.stopLoss);
  const move = t.direction === 'LONG' ? exit - entry : entry - exit;
  const grossR = move / stopDistance;
  const notional = stopDistance > 0 ? position.riskDollars * entry / stopDistance : 0;
  const fees = notional * TAKER_FEE * 2;
  const slip = reason === 'STOP_LOSS' ? position.riskDollars * STOP_SLIPPAGE : 0;
  const net = position.riskDollars * grossR - fees - slip;
  t.exitPrice = exit; t.exitTime = candle.time; t.pnlPips = Number((move / pip).toFixed(2));
  t.pnlDollars = Number(net.toFixed(2)); t.pnlPct = Number((net / position.riskDollars * 100).toFixed(4));
  t.outcome = net >= 0 ? 'WIN' : 'LOSS';
  t.executionPath = [...(t.executionPath ?? []), 'Closed at ' + exit + ' (' + reason + ') on ' + new Date(candle.time).toISOString() + '; net PnL ' + net.toFixed(2) + '.'];
  return fees + slip;
}

export class AgentBacktestEngine {
  static async runBacktest(params: AgentBacktestParams): Promise<BacktestResult> {
    const { goat, skills, market, period, provider, reason, startingBalance = 10000, riskPerTradePct = 1.5 } = params;
    if (!Number.isFinite(startingBalance) || startingBalance <= 0) throw new Error('Starting balance must be greater than zero.');
    if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 10) throw new Error('Risk per trade must be greater than zero and at most 10%.');
    if (provider.dataMode !== 'LIVE') throw new Error('Agent backtests require real historical candles; PAPER data is refused.');
    const requestedBars = PERIOD_BARS[period];
    let raw: Candle[];
    try { raw = await provider.getCandles(market, '5m', requestedBars); }
    catch (e) { throw new Error('Historical 5m candles unavailable for ' + market + ': ' + (e instanceof Error ? e.message : 'provider error')); }
    const candles = normalize(raw);
    if (candles.length < MIN_HISTORY) throw new Error('Insufficient real 5m history for ' + market + ': received ' + candles.length + ', need at least ' + MIN_HISTORY + '.');
    const runId = 'agentbt_' + goat.id + '_' + candles[0].time + '_' + candles[candles.length - 1].time;
    const pip = provider.getMarketMetadata(market)?.pipSize ?? (market.toUpperCase().includes('JPY') ? 0.01 : market.toUpperCase().includes('XAU') ? 0.1 : 0.0001);
    const trades: BacktestTrade[] = [], pending: PendingEntry[] = [], open: OpenPosition[] = [];
    const equityCurve: { time: number; equity: number }[] = [{ time: candles[0].time, equity: startingBalance }];
    let equity = startingBalance, totalCosts = 0, tradeIndex = 0, activeTrackers: TrackerCondition[] = [];
    let activeThesis: MarketThesis | null = null, lastReasoningAt = -1, bankrupt = false;

    const reasonAt = (index: number, wakeReason: string) => {
      const history = candles.slice(Math.max(0, index - CONTEXT_BARS + 1), index + 1);
      const context: GoatReasoningContext = {
        userId: goat.userId, goatId: goat.id, goatName: goat.name, goatGoal: goat.goal,
        market, markets: goat.markets, candles: history, skills, activeThesis, wakeReason,
        reviewSession: runId + '_wake_' + index, dataSource: provider.dataMode, news: [],
        deterministicIndicators: { historical: true, timeframe: '5m', candleTime: candles[index].time,
          candlesAvailable: history.length, currentPrice: candles[index].close, noHistoricalNews: true },
      };
      return reason(context, goat.model);
    };

    // Initial market review is a real GOAT reasoning call over the first 60 closed 5m bars.
    const initialIndex = MIN_HISTORY - 1;
    const initial = await reasonAt(initialIndex, 'BACKTEST_INITIAL_MARKET_REVIEW');
    activeTrackers = trackersFrom(initial, market, runId, candles[initialIndex].time);
    activeThesis = thesisFrom(goat, market, initial, activeTrackers, candles[initialIndex].time);
    lastReasoningAt = initialIndex;
    const captured = new Set<string>();

    for (let index = initialIndex + 1; index < candles.length; index++) {
      const candle = candles[index];
      if (equity <= 0) { bankrupt = true; break; }

      // A captured order is only eligible to fill on a candle after its signal candle.
      for (let j = pending.length - 1; j >= 0; j--) {
        const item = pending[j], t = item.trade;
        let fill: number | null = null;
        if (index > item.signalIndex && t.orderType === 'MARKET') fill = candle.open;
        else if (index > item.signalIndex && t.orderType === 'LIMIT' &&
          (t.direction === 'LONG' ? candle.low <= t.plannedEntry : candle.high >= t.plannedEntry)) fill = t.plannedEntry;
        else if (index > item.signalIndex && t.orderType === 'STOP' &&
          (t.direction === 'LONG' ? candle.high >= t.plannedEntry : candle.low <= t.plannedEntry)) fill = t.plannedEntry;
        if (fill !== null) {
          t.entryPrice = fill;
          t.executionPath?.push('Entry filled at ' + fill + ' on ' + new Date(candle.time).toISOString());
          open.push({ trade: t, entryIndex: index, riskDollars: item.riskDollars });
          pending.splice(j, 1);
        } else if (index >= item.expiresIndex) {
          t.outcome = 'EXPIRED'; t.reason += ' Entry order expired without a fill.';
          t.executionPath?.push('Entry expired without a fill.'); pending.splice(j, 1);
        }
      }

      // Concurrent positions are managed independently. Same-candle stop/target ambiguity is stop-first.
      for (let j = open.length - 1; j >= 0; j--) {
        const pos = open[j], t = pos.trade;
        if (index <= pos.entryIndex) continue;
        const stopHit = t.direction === 'LONG' ? candle.low <= t.stopLoss : candle.high >= t.stopLoss;
        const targetHit = t.direction === 'LONG' ? candle.high >= t.takeProfit : candle.low <= t.takeProfit;
        let exit: number | null = null, why = '';
        if (stopHit) { exit = t.stopLoss; why = 'STOP_LOSS'; }
        else if (targetHit) { exit = t.takeProfit; why = 'TAKE_PROFIT'; }
        else if (index - pos.entryIndex >= MAX_HOLDING_BARS) { exit = candle.close; why = 'TIME_EXIT'; }
        if (exit !== null) {
          totalCosts += closePosition(pos, candle, exit, why, pip);
          equity += t.pnlDollars ?? 0;
          trades.push(t); open.splice(j, 1);
        }
      }

      const hits: string[] = [];
      for (const tracker of activeTrackers) {
        if (tracker.isTriggered || tracker.status === 'HIT') continue;
        const cross = tracker.operator === 'CROSS_ABOVE' || tracker.operator === 'CROSS_BELOW';
        const ev = evaluateTracker(tracker, candles.slice(0, index + 1), {
          lastProcessedCandleMs: cross ? tracker.lastEvaluatedCandleMs : undefined,
          allowFormingCandle: false,
        });
        tracker.lastEvaluatedAt = candle.time; tracker.lastEvaluationReason = ev.reason;
        if (ev.evaluatedCandleMs !== null) tracker.lastEvaluatedCandleMs = ev.evaluatedCandleMs;
        tracker.previousCalculatedValue = ev.previousValue ?? undefined;
        tracker.currentCalculatedValue = ev.calculatedValue ?? undefined;
        if (ev.verdict === 'UNEVALUABLE') tracker.status = 'UNEVALUABLE';
        else if (ev.shouldWake) {
          tracker.status = 'HIT'; tracker.isTriggered = true; tracker.triggeredAt = candle.time;
          hits.push(tracker.description);
        } else tracker.status = 'PENDING';
      }

      if (hits.length && index > lastReasoningAt) {
        const result = await reasonAt(index, 'BACKTEST_TRACKER_TRIGGERED: ' + hits.join('; ') + '. Reassess historical price data only.');
        lastReasoningAt = index;
        const proposed = trackersFrom(result, market, runId, candle.time);
        const signatures = new Set(activeTrackers.map(trackerSignature));
        activeTrackers = [...activeTrackers, ...proposed.filter(t => !signatures.has(trackerSignature(t)))].slice(-30);
        activeThesis = thesisFrom(goat, market, result, activeTrackers, candle.time);

        const p = result.proposal;
        const opportunity = [candle.time, p.direction, p.orderType, p.entry, p.stopLoss, p.takeProfit].join('|');
        if (!captured.has(opportunity)) {
          const trade = proposalTrade(result, goat, market, candle.time, tradeIndex, equity, riskPerTradePct);
          if (trade) {
            captured.add(opportunity); tradeIndex++;
            trades.push(trade);
            pending.push({ trade, signalIndex: index, expiresIndex: index + MAX_PENDING_BARS, riskDollars: equity * riskPerTradePct / 100 });
            trade.executionPath?.push('Opportunity captured; scanning continues for independent setups.');
          }
        }
      }
      if (equityCurve[equityCurve.length - 1].time !== candle.time) equityCurve.push({ time: candle.time, equity: Number(equity.toFixed(2)) });
    }

    const last = candles[candles.length - 1];
    for (const item of pending) {
      item.trade.outcome = 'EXPIRED';
      item.trade.reason += ' Backtest ended before entry filled.';
      item.trade.executionPath?.push('Replay ended with entry still pending.');
    }
    for (const pos of open) {
      totalCosts += closePosition(pos, last, last.close, 'TIME_EXIT', pip);
      equity += pos.trade.pnlDollars ?? 0;
    }
    if (equityCurve[equityCurve.length - 1].time !== last.time) equityCurve.push({ time: last.time, equity: Number(equity.toFixed(2)) });
    trades.sort((a, b) => a.timestamp - b.timestamp);
    const closed = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
    const wins = closed.filter(t => t.outcome === 'WIN'), losses = closed.filter(t => t.outcome === 'LOSS');
    const winDollars = wins.reduce((s, t) => s + Math.max(0, t.pnlDollars ?? 0), 0);
    const lossDollars = losses.reduce((s, t) => s + Math.abs(Math.min(0, t.pnlDollars ?? 0)), 0);
    const netPnl = closed.reduce((s, t) => s + (t.pnlDollars ?? 0), 0);
    let peak = startingBalance, maxDrawdown = 0;
    for (const point of equityCurve) { peak = Math.max(peak, point.equity); if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak * 100); }
    const provenance: BacktestProvenance = {
      timeframe: '5m', requestedBars, candlesUsed: candles.length,
      firstCandleTime: candles[0].time, lastCandleTime: last.time,
      requestedWindowMs: windowMs(period), actualWindowMs: last.time - candles[0].time,
      rejectedCandles: raw.length - candles.length,
    };
    return {
      id: runId, goatId: goat.id, goatName: goat.name, market, period, dataSource: provider.dataMode as DataMode, provenance,
      costModel: { takerFee: TAKER_FEE, slippageFraction: STOP_SLIPPAGE, summary: COST_SUMMARY, totalCosts: Number(totalCosts.toFixed(2)) },
      totalSignals: trades.length, filledSignals: closed.length,
      unfilledSignals: trades.filter(t => t.outcome === 'UNFILLED' || t.outcome === 'EXPIRED' || t.outcome === 'INVALIDATED_BEFORE_FILL').length,
      invalidatedSignals: trades.filter(t => t.outcome === 'INVALIDATED_BEFORE_FILL').length,
      expiredSignals: trades.filter(t => t.outcome === 'EXPIRED').length,
      winningSignals: wins.length, losingSignals: losses.length,
      winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0,
      profitFactor: lossDollars > 0 ? Number((winDollars / lossDollars).toFixed(3)) : null,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      averageRR: closed.length ? Number((closed.reduce((s, t) => s + t.riskReward, 0) / closed.length).toFixed(2)) : 0,
      netPips: Number(closed.reduce((s, t) => s + t.pnlPips, 0).toFixed(2)),
      netDollarPnl: Number(netPnl.toFixed(2)),
      averageWin: wins.length ? Number((wins.reduce((s, t) => s + (t.pnlDollars ?? 0), 0) / wins.length).toFixed(2)) : 0,
      averageLoss: losses.length ? Number((losses.reduce((s, t) => s + (t.pnlDollars ?? 0), 0) / losses.length).toFixed(2)) : 0,
      ambiguityPolicy: 'Historical 5m OHLC only; if stop and target touch in the same candle, stop is assumed first. Signals cannot fill on the candle that generated them.',
      bankrupt, equityCurve, trades, createdAt: new Date().toISOString(),
    };
  }
}
