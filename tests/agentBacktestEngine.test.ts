import { describe, expect, test } from 'bun:test';
import { AgentBacktestEngine } from '../src/services/backtest/AgentBacktestEngine';
import type { MarketDataProvider } from '../src/services/market-data/MarketDataProvider';
import type { Candle, FundGoat, TradingSkill } from '../src/types';
import type { GoatReasoningContext } from '../src/services/ai/OpenRouterClient';
import type { ReasoningResult } from '../src/services/agent/contracts';

const start = Date.UTC(2025, 0, 1);
const candles: Candle[] = Array.from({ length: 300 }, (_, i) => {
  const close = 1 + i * 0.0001;
  return { time: start + i * 300_000, open: close - 0.00002, high: close + 0.00004, low: close - 0.00004, close, volume: 100 };
});
const provider = {
  name: 'Historical test fixture',
  dataMode: 'LIVE',
  getSymbols: async () => [],
  getQuote: async () => { throw new Error('Quote must not be used for historical replay'); },
  getQuotes: async () => [],
  getCandles: async (_market: string, timeframe: string) => {
    expect(timeframe).toBe('5m');
    return candles;
  },
  getMarketMetadata: () => ({ symbol: 'TEST/USD', pipSize: 0.0001 }),
  subscribeQuotes: () => () => undefined,
} as unknown as MarketDataProvider;

const goat: FundGoat = {
  id: 'agent-backtest-goat', userId: 'test-user', name: 'Historical Goat',
  goal: 'Find price-only breakout opportunities.', markets: ['TEST/USD'], skillIds: [],
  model: 'test/model', status: 'PAUSED', createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start).toISOString(),
};
const skills: TradingSkill[] = [];

function result(actionable: boolean): ReasoningResult {
  return {
    investigation: { summary: 'Historical price review', marketView: 'Monotonic test price series' },
    thesis: {
      directionalBias: 'BULLISH', summary: 'Breakout thesis', confidence: 80,
      observationPlan: 'Wait for price to cross the breakout level',
      trackers: [{
        description: 'Price crosses above 1.0085',
        type: 'PRICE_LEVEL', indicator: 'PRICE', operator: 'CROSS_ABOVE', targetValue: 1.0085,
      }],
    },
    proposal: actionable ? {
      decision: 'ACTIONABLE', direction: 'LONG', orderType: 'MARKET',
      entry: 1.0086, stopLoss: 1.0076, takeProfit: 1.0106,
      triggerSequence: ['Price crosses above 1.0085'],
      rationale: 'Historical breakout continuation', invalidation: 'Price closes below 1.0076',
    } : { decision: 'NO_TRADE', noTradeReason: 'Waiting for the condition to trigger' },
    evidence: [],
  } as ReasoningResult;
}

describe('AgentBacktestEngine', () => {
  test('runs initial AI review, wakes on a historical tracker hit, and opens a trade', async () => {
    const contexts: GoatReasoningContext[] = [];
    let calls = 0;
    const backtest = await AgentBacktestEngine.runBacktest({
      goat, skills, market: 'TEST/USD', period: '24h', provider,
      reason: async (context) => {
        contexts.push(context);
        calls += 1;
        return result(calls > 1);
      },
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(contexts[0].wakeReason).toBe('BACKTEST_INITIAL_MARKET_REVIEW');
    expect(contexts.every(context => context.news?.length === 0)).toBe(true);
    expect(backtest.provenance.timeframe).toBe('5m');
    expect(backtest.dataSource).toBe('LIVE');
    expect(backtest.totalSignals).toBeGreaterThan(0);
    expect(backtest.agentReplay?.engine).toBe('AGENT_HISTORICAL_REPLAY');
    expect(backtest.agentReplay?.conditionHits).toBeGreaterThan(0);
    expect(backtest.agentReplay?.events.some(event => event.type === 'TRACKER_ARMED')).toBe(true);
    expect(backtest.agentReplay?.events.some(event => event.type === 'SIGNAL_CAPTURED')).toBe(true);
    expect(backtest.trades.every(trade => trade.market === 'TEST/USD')).toBe(true);
  });

  test('refuses simulated PAPER prices', async () => {
    await expect(AgentBacktestEngine.runBacktest({
      goat, skills, market: 'TEST/USD', period: '24h',
      provider: { ...provider, dataMode: 'PAPER' } as MarketDataProvider,
      reason: async () => result(false),
    })).rejects.toThrow(/real historical candles/);
  });
});
