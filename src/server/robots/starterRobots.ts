import { DEFAULT_PRICE_ACTION_PARAMS, type StrategyCondition, type StrategyDefinition } from '../../services/strategy/schema';
import type { RobotRecord } from './RobotStore';

const createdAt = '2026-10-21T00:00:00.000Z';
const condition = (pattern: 'BULLISH_SWEEP'|'BEARISH_SWEEP'|'BREAKOUT_RETEST_HIGH'|'BREAKOUT_RETEST_LOW'|'BULLISH_ENGULFING'): StrategyCondition => ({
  type: 'price_action', pattern, params: { ...DEFAULT_PRICE_ACTION_PARAMS },
});

const starter = (
  key: string, name: string, description: string, instrument: string, timeframe: '15m'|'1h'|'4h',
  direction: 'LONG'|'SHORT', entry: StrategyCondition, stop: number, target: number,
): { robot: RobotRecord; definition: StrategyDefinition } => {
  const id = `starter_${key}`;
  const versionId = `${id}_v1`;
  const definition: StrategyDefinition = {
    schemaVersion: 3, strategyId: id, versionId, version: 1, name, description,
    market: { provider: 'hyperliquid', instrument, timeframe }, indicators: [],
    entry: { direction, condition: entry }, then: { action: direction === 'LONG' ? 'BUY' : 'SELL' }, exit: {},
    risk: { sizing: { mode: 'PERCENT_RISK', percent: 0.75 }, stopLossPercent: stop, takeProfitPercent: target, maxExposurePercent: 15, maxConcurrentPositions: 1, maxTradesPerDay: 3, cooldownCandles: 4, maxDailyLossPercent: 2.5 },
    execution: { mode: 'PAPER', startingBalance: 10_000, feeRate: 0.00045, slippageBps: 2 },
    visibility: 'PUBLIC', validationStatus: 'VALID', createdAt,
  };
  return { robot: { id, slug: `${key}-starter-bot`, ownerUserId: 'signalgoat_system', creatorName: 'SignalGoat Labs', name, description, visibility: 'PUBLIC', currentVersionId: versionId, currentVersion: 1, market: instrument, timeframe, runtimeStatus: 'STOPPED', createdAt, updatedAt: createdAt }, definition };
};

export const STARTER_ROBOTS = [
  starter('liquidity-sweep-scout','Liquidity Sweep Scout','Waits for a confirmed bullish liquidity sweep before entering with conservative exposure and a defined asymmetric target.','BTC','15m','LONG',condition('BULLISH_SWEEP'),0.8,1.8),
  starter('breakdown-retest-sentinel','Breakdown Retest Sentinel','Trades only after a bearish breakdown retests the broken level, reducing the risk of chasing the initial move.','ETH','1h','SHORT',condition('BREAKOUT_RETEST_LOW'),1.2,2.6),
  starter('structure-reclaim-alpha','Structure Reclaim Alpha','Requires a bullish engulfing reclaim followed by a confirmed breakout retest before deploying risk.','SOL','4h','LONG',{type:'sequence',steps:[condition('BULLISH_ENGULFING'),condition('BREAKOUT_RETEST_HIGH')],maxGapCandles:6},1.8,4.2),
] as const;

export const starterRobot = (idOrSlug: string) => STARTER_ROBOTS.find(item => item.robot.id === idOrSlug || item.robot.slug === idOrSlug);
