/**
 * REAL-DATA BACKTEST INTEGRATION CHECK
 * ===================================
 * Runs the BacktestEngine against GENUINE historical candles from the live
 * market-data provider and prints the provenance and metrics of that run.
 *
 * THIS IS NOT A UNIT TEST AND IS NOT PART OF `bun test`.
 *
 * It exists because a fixture test can only prove the arithmetic. It cannot
 * prove that the venue actually serves the candles the engine asks for, how
 * many it returns, what period they really cover, or that a live result is
 * computed rather than asserted. This script answers those questions against
 * the real provider, and fails loudly if the data is not available.
 *
 * Run with:  npm run test:backtest:live
 * Optional:  BACKTEST_MARKET=xyz:EUR BACKTEST_PERIOD=30d
 */

import { BacktestEngine } from '../src/services/backtest/BacktestEngine';
import { hyperliquidProvider } from '../src/services/market-data/hyperliquid/HyperliquidMarketDataProvider';
import type { FundGoat } from '../src/types';

const MARKET = process.env.BACKTEST_MARKET ?? 'xyz:GOLD';
const PERIOD = (process.env.BACKTEST_PERIOD ?? '30d') as '24h' | '7d' | '30d' | '90d';

const goat: FundGoat = {
  id: 'goat_live_backtest',
  userId: 'user_live_backtest',
  name: 'Live Data Backtest',
  goal: 'Verify the engine against genuine historical candles.',
  markets: [MARKET],
  skillIds: [],
  model: 'test/model',
  status: 'WATCHING',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log(`\nLIVE BACKTEST — market=${MARKET} period=${PERIOD}\n`);

let result;
try {
  result = await BacktestEngine.runBacktest({
    goat,
    skills: [],
    market: MARKET,
    period: PERIOD,
    provider: hyperliquidProvider,
  });
} catch (err) {
  console.error(`\nBacktest could not run: ${err instanceof Error ? err.message : err}`);
  console.error('This is an honest failure: the venue did not supply usable history.');
  process.exit(1);
}

const p = result.provenance;
const days = (ms: number) => (ms / 86_400_000).toFixed(2);

console.log('PROVENANCE');
console.log(`  market            ${result.market}`);
console.log(`  timeframe         ${p.timeframe}`);
console.log(`  requested bars    ${p.requestedBars}`);
console.log(`  candles used      ${p.candlesUsed}`);
console.log(`  rejected candles  ${p.rejectedCandles}`);
console.log(`  window requested  ${days(p.requestedWindowMs)} days`);
console.log(`  window actual     ${days(p.actualWindowMs)} days`);
console.log(`  first candle      ${new Date(p.firstCandleTime).toISOString()}`);
console.log(`  last candle       ${new Date(p.lastCandleTime).toISOString()}`);
console.log(`  data source       ${result.dataSource}`);

console.log('\nRESULT');
console.log(`  trades (total)    ${result.totalSignals}`);
console.log(`  filled            ${result.filledSignals}`);
console.log(`  wins / losses     ${result.winningSignals} / ${result.losingSignals}`);
console.log(`  win rate          ${result.winRate}%`);
console.log(`  profit factor     ${result.profitFactor === null ? 'n/a (no losing trades)' : result.profitFactor}`);
console.log(`  net P/L           ${result.netDollarPnl}`);
console.log(`  max drawdown      ${result.maxDrawdown}%`);
console.log(`  avg realised RR   ${result.averageRR}`);
console.log(`  modelled costs    ${result.costModel.totalCosts}`);
console.log(`  equity points     ${result.equityCurve.length}`);
console.log(`  bankrupt          ${result.bankrupt}`);

console.log('\nVERIFICATION');
check('the market is the one requested', result.market === MARKET, result.market);
check('real candles were used', p.candlesUsed > 0, String(p.candlesUsed));
check('candles are in chronological order',
  result.equityCurve.length > 0 &&
  result.equityCurve.every((pt, i, a) => i === 0 || pt.time >= a[i - 1].time));
check('the full trade log is present, not truncated',
  result.trades.length === result.totalSignals,
  `${result.trades.length} of ${result.totalSignals}`);
check('signals partition correctly',
  result.filledSignals + result.invalidatedSignals + result.expiredSignals === result.totalSignals);
check('win rate matches wins / filled',
  result.filledSignals === 0 ||
  Math.abs(result.winRate - (result.winningSignals / result.filledSignals) * 100) < 0.1);
check('drawdown never exceeds 100%', result.maxDrawdown <= 100.0001, String(result.maxDrawdown));
check('every trade is on the selected market',
  result.trades.every((t) => t.market === MARKET));
check('cost assumptions are disclosed', /fee/i.test(result.costModel.summary));

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
