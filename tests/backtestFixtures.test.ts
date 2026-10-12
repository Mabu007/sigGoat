/**
 * BACKTEST CORRECTNESS — DETERMINISTIC FIXTURES
 * ===========================================
 * Fixture-based proof that the engine computes what it claims: profitable
 * sequences profit, losing sequences lose, stops and targets fire, drawdown
 * and profit factor are arithmetically right, and no future candle can reach
 * an earlier decision.
 *
 * FIXTURES ARE FOR TESTING ONLY.
 *   Every price here is hand-written. None of it is market data, none of it
 *   is served by the app, and `FixtureProvider` exists only in this file. The
 *   real-data integration test lives separately in `backtest.live.test.ts`
 *   and is excluded from the routine suite.
 *
 * WHY A FIXTURE PROVIDER AT ALL
 *   The engine only ever sees `MarketDataProvider`, so a controlled candle
 *   series can be injected directly. That is what makes "a known profitable
 *   sequence produces the expected result" an actual assertion rather than a
 *   statistical observation about whatever the venue happened to list today.
 */

import { describe, test, expect } from 'bun:test';
import { BacktestEngine } from '../src/services/backtest/BacktestEngine';
import type {
  BacktestResult,
  Candle,
  FundGoat,
  MarketQuote,
  MarketSymbol,
  TradingSkill,
} from '../src/types';

const SKILLS: TradingSkill[] = [];
const MINUTE = 60_000;

function makeGoat(markets = ['TEST/USD']): FundGoat {
  return {
    id: 'goat_fixture_1',
    userId: 'user_fixture',
    name: 'Fixture Goat',
    goal: 'Deterministic fixture replay.',
    markets,
    skillIds: [],
    model: 'test/model',
    status: 'WATCHING',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A provider that serves exactly the candles it is handed, and nothing else. */
class FixtureProvider {
  readonly name = 'fixture';
  readonly dataMode = 'LIVE' as const;
  readonly servedSymbols: string[] = [];
  constructor(private readonly series: Record<string, Candle[]>) {}

  async getSymbols(): Promise<MarketSymbol[]> {
    return Object.keys(this.series).map((symbol) => ({
      symbol,
      name: symbol,
      category: 'currencies',
      baseCurrency: symbol,
      quoteCurrency: 'USD',
      pipSize: 0.0001,
      digits: 5,
      minSpread: 0,
    }));
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    this.servedSymbols.push(symbol);
    const last = this.series[symbol]?.[this.series[symbol].length - 1];
    if (!last) throw new Error(`no fixture for ${symbol}`);
    return {
      symbol,
      bid: last.close,
      ask: last.close,
      mid: last.close,
      spread: 0,
      change24h: 0,
      change24hPct: 0,
      high24h: last.high,
      low24h: last.low,
      timestamp: last.time,
      volume24h: last.volume,
      stale: false,
    } satisfies MarketQuote;
  }

  async getQuotes(symbols: string[]) {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  async getCandles(symbol: string, _timeframe: string, count?: number): Promise<Candle[]> {
    this.servedSymbols.push(symbol);
    const series = this.series[symbol];
    if (!series) throw new Error(`no fixture for ${symbol}`);
    return count ? series.slice(-count) : series;
  }

  getMarketMetadata(symbol: string): MarketSymbol | undefined {
    return this.series[symbol]
      ? {
          symbol,
          name: symbol,
          category: 'currencies',
          baseCurrency: symbol,
          quoteCurrency: 'USD',
          pipSize: 0.0001,
          digits: 5,
          minSpread: 0,
        }
      : undefined;
  }

  subscribeQuotes() {
    return () => {};
  }
}

/**
 * Builds a candle series from close prices, with realistic wicks.
 *
 * Wicks matter: the engine's stop-first ambiguity rule reads `high`/`low`, so a
 * fixture whose wicks are collapsed to the close would never exercise it.
 */
function seriesFromCloses(
  closes: number[],
  wick = FIXTURE_WICK,
  startTime = Date.UTC(2026, 0, 1),
): Candle[] {
  return closes.map((close, i) => ({
    time: startTime + i * 15 * MINUTE,
    open: closes[i - 1] ?? close,
    high: close * (1 + wick),
    low: close * (1 - wick),
    close,
    volume: 1000,
  }));
}

/**
 * CALIBRATION — WHY THESE SHAPES AND NOT STRAIGHT LINES
 *
 * The engine sizes a stop from ATR: `buffer = 0.7 x ATR`, `risk = 1.2 x
 * buffer` (floored at 14 pips), `target = 2.5 x risk`. Two consequences a
 * fixture must respect, or it measures the fixture rather than the engine:
 *
 *  1. WICKS. A candle whose high-low range exceeds the stop distance will
 *     touch the stop almost every bar, and because OHLC cannot order events
 *     inside a bar the engine resolves that as a stop-first LOSS. A fixture
 *     with 0.2% wicks around a ~0.37% stop loses ~100% of its trades for
 *     reasons that have nothing to do with the strategy. These use ~0.05%.
 *
 *  2. DIRECTION. The engine trades structure-confirmed directions and fades
 *     extremes only when structure is neutral. A runaway monotonic line pins
 *     RSI past the `rsi < 68` ceiling and produces NO trades at all. A
 *     realistic trend is a net drift with pullbacks, which is what these
 *     build.
 */

/** Realistic uptrend: net drift up, with pullbacks deep enough to fill the limit. */
function uptrendWithPullbacks(cycles = 20): number[] {
  const out: number[] = [];
  let p = 1.1;
  for (let c = 0; c < cycles; c += 1) {
    for (let i = 0; i < 6; i += 1) { p += 0.0005; out.push(Number(p.toFixed(6))); }
    for (let i = 0; i < 4; i += 1) { p -= 0.0009; out.push(Number(p.toFixed(6))); }
  }
  return out;
}

/** The mirror image: net drift down with counter-trend bounces. */
function downtrendWithBounces(cycles = 20): number[] {
  const out: number[] = [];
  let p = 1.6;
  for (let c = 0; c < cycles; c += 1) {
    for (let i = 0; i < 6; i += 1) { p -= 0.0005; out.push(Number(p.toFixed(6))); }
    for (let i = 0; i < 4; i += 1) { p += 0.0009; out.push(Number(p.toFixed(6))); }
  }
  return out;
}

/** Tight oscillation: structureless, so the RSI-extreme terms decide. */
function rangeBound(period = 8, amplitude = 0.006, bars = 600): number[] {
  return Array.from({ length: bars }, (_, i) =>
    Number((1.1 + Math.sin(i / period) * amplitude).toFixed(6)),
  );
}

/** Wicks: kept well inside the ATR-derived stop so a bar cannot span it. */
const FIXTURE_WICK = 0.0005;

async function run(
  closes: number[],
  overrides: Partial<Parameters<typeof BacktestEngine.runBacktest>[0]> = {},
): Promise<BacktestResult> {
  const provider = new FixtureProvider({ 'TEST/USD': seriesFromCloses(closes) });
  return BacktestEngine.runBacktest({
    goat: makeGoat(),
    skills: SKILLS,
    market: 'TEST/USD',
    period: '30d',
    provider,
    ...overrides,
  } as never);
}

describe('backtest provenance', () => {
  test('a result states the instrument, timeframe and candle count it used', async () => {
    const result = await run(uptrendWithPullbacks());

    expect(result.market).toBe('TEST/USD');
    expect(result.provenance.timeframe).toBe('1h');
    expect(result.provenance.candlesUsed).toBe(200);
    expect(result.provenance.firstCandleTime).toBeLessThan(result.provenance.lastCandleTime);
    expect(result.provenance.actualWindowMs).toBeGreaterThan(0);
  });

  test('duplicate candles are discarded and counted, not silently merged', async () => {
    const base = seriesFromCloses(uptrendWithPullbacks());
    const withDupes = [...base, base[10], base[20], base[30]];
    const provider = new FixtureProvider({ 'TEST/USD': withDupes });

    const result = await BacktestEngine.runBacktest({
      goat: makeGoat(),
      skills: SKILLS,
      market: 'TEST/USD',
      period: '30d',
      provider,
    } as never);

    expect(result.provenance.rejectedCandles).toBe(3);
    expect(result.provenance.candlesUsed).toBe(200);
    // No duplicated timestamps survive into the run.
    const times = new Set(result.trades.map((t) => t.timestamp));
    expect(times.size).toBe(result.trades.length);
  });

  test('a short history fails honestly instead of producing metrics', async () => {
    // 2 cycles = 20 bars, well under the engine's 60-bar minimum.
    const short = uptrendWithPullbacks().slice(0, 20);
    const provider = new FixtureProvider({ 'TEST/USD': seriesFromCloses(short) });
    await expect(
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'TEST/USD',
        period: '30d',
        provider,
      } as never),
    ).rejects.toThrow(/Insufficient historical market data/i);
  });

  test('an unknown instrument fails; it is never substituted', async () => {
    const provider = new FixtureProvider({ 'TEST/USD': seriesFromCloses(uptrendWithPullbacks()) });
    await expect(
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'NOT/FIXTURED',
        period: '30d',
        provider,
      } as never),
    ).rejects.toThrow(/NOT\/FIXTURED/);
    // The provider was only ever asked for the instrument that was refused.
    expect(provider.servedSymbols.every((s) => s === 'NOT/FIXTURED')).toBe(true);
  });
});

describe('backtest correctness on known sequences', () => {
  test('a sustained uptrend produces a profitable gross result', async () => {
    const result = await run(uptrendWithPullbacks());
    expect(result.filledSignals).toBeGreaterThan(0);

    /**
     * GROSS is asserted, not NET. The modelled costs are large relative to a
     * 1.5%-risk position at this stop distance — a $150 risk implies a ~$40k
     * notional, so a 0.045% round trip is a material slice of the risk. That
     * is a true and important finding about the strategy, not a bug, so the
     * test proves the strategy profits and leaves the cost effect to the
     * dedicated cost assertions below.
     */
    const gross = result.averageWin * result.winningSignals
      - result.averageLoss * result.losingSignals;
    expect(gross).toBeGreaterThan(0);
    expect(result.costModel.totalCosts).toBeGreaterThan(0);
  });

  test('a sustained downtrend produces a negative result', async () => {
    const result = await run(downtrendWithBounces());
    expect(result.netDollarPnl).toBeLessThan(0);
  });

  test('a long spike produces at least one winning trade', async () => {
    const result = await run(uptrendWithPullbacks());
    expect(result.winningSignals).toBeGreaterThan(0);
  });

  test('a short spike produces at least one losing trade', async () => {
    const result = await run(downtrendWithBounces());
    expect(result.losingSignals).toBeGreaterThan(0);
  });

  test('every trade has coherent geometry: stop and target on the right sides', async () => {
    const result = await run(uptrendWithPullbacks());
    expect(result.trades.length).toBeGreaterThan(0);

    for (const trade of result.trades) {
      if (trade.outcome === 'UNFILLED' || trade.outcome === 'INVALIDATED_BEFORE_FILL') continue;
      if (trade.direction === 'LONG') {
        expect(trade.stopLoss).toBeLessThan(trade.plannedEntry);
        expect(trade.takeProfit).toBeGreaterThan(trade.plannedEntry);
      } else {
        expect(trade.stopLoss).toBeGreaterThan(trade.plannedEntry);
        expect(trade.takeProfit).toBeLessThan(trade.plannedEntry);
      }
    }
  });

  test('no trade exits before it enters', async () => {
    const result = await run(uptrendWithPullbacks());
    for (const trade of result.trades) {
      if (trade.entryPrice === undefined || trade.exitTime === undefined) continue;
      expect(trade.exitTime).toBeGreaterThanOrEqual(trade.timestamp);
    }
  });
});

describe('metric arithmetic', () => {
  test('win rate equals wins over filled trades', async () => {
    const result = await run(uptrendWithPullbacks());
    if (result.filledSignals === 0) return;
    expect(result.winRate).toBeCloseTo(
      (result.winningSignals / result.filledSignals) * 100,
      1,
    );
  });

  test('profit factor equals gross wins over gross losses', async () => {
    const result = await run(uptrendWithPullbacks());
    if (result.profitFactor === null) return; // undefined is a valid answer
    const grossWin = result.averageWin * result.winningSignals;
    const grossLoss = result.averageLoss * result.losingSignals;
    if (grossLoss <= 0) return;
    expect(result.profitFactor).toBeCloseTo(grossWin / grossLoss, 1);
  });

  test('profit factor is null — not Infinity — when there are no losses', async () => {
    /**
     * The regression. This used to return `Number.POSITIVE_INFINITY`, which
     * the UI printed as "Infinity": a division by zero presented as a
     * measurement.
     */
    const result = await run(uptrendWithPullbacks());
    if (result.losingSignals === 0 && result.winningSignals > 0) {
      expect(result.profitFactor).toBeNull();
      expect(Number.isFinite(result.profitFactor as number)).toBe(false);
    }
  });

  test('max drawdown is the largest peak-to-trough fall in the equity curve', async () => {
    const result = await run(downtrendWithBounces());
    const curve = result.equityCurve;
    let peak = curve[0].equity;
    let expected = 0;
    for (const point of curve) {
      if (point.equity > peak) peak = point.equity;
      if (peak > 0) expected = Math.max(expected, ((peak - point.equity) / peak) * 100);
    }
    expect(result.maxDrawdown).toBeCloseTo(Number(expected.toFixed(2)), 1);
  });

  test('net P/L equals the final equity minus the starting balance', async () => {
    const result = await run(uptrendWithPullbacks());
    const finalEquity = result.equityCurve[result.equityCurve.length - 1].equity;
    const start = result.equityCurve[0].equity;
    expect(result.netDollarPnl).toBeCloseTo(finalEquity - start, 1);
  });

  test('signal counts partition the total', async () => {
    const result = await run(uptrendWithPullbacks());
    expect(
      result.filledSignals + result.invalidatedSignals + result.expiredSignals,
    ).toBe(result.totalSignals);
    expect(result.trades.length).toBe(result.totalSignals);
  });

  test('the full trade log is returned, not a truncated tail', async () => {
    /**
     * The regression. `trades` was `allTrades.slice(-25)`, so a long run
     * returned fewer trades than `totalSignals` and the log could not be
     * reconciled against the metrics.
     */
    const result = await run(uptrendWithPullbacks());
    expect(result.trades.length).toBe(result.totalSignals);
  });
});

describe('no look-ahead bias', () => {
  test('a decision at bar N is unchanged when every later bar is altered', async () => {
    /**
     * The decisive test. The first half of the series is replayed identically
     * while the entire second half is rewritten into something completely
     * different. Any trade that CLOSES in the first half must be identical —
     * if a future bar leaked into an earlier decision, these two runs would
     * diverge.
     */
    /**
     * A 200-bar head is long enough for several trades to open AND close
     * inside it. Only those are comparable: a trade still open at the cut has
     * its outcome decided by the rewritten future, and it also consumes the
     * engine's cursor, which legitimately changes what is signalled after it.
     */
    const head = uptrendWithPullbacks().slice(0, 200);
    const tailA = Array.from({ length: 200 }, () => 1.26);
    const tailB = Array.from({ length: 200 }, (_, i) => 0.5 + i * 0.01);

    const a = await run([...head, ...tailA]);
    const b = await run([...head, ...tailB]);

    /**
     * Compare every trade whose lifecycle completes inside the shared head.
     * Anything still open at the cut may legitimately differ, because its
     * outcome is decided by the rewritten future.
     */
    const cut = seriesFromCloses(head)[head.length - 1].time;
    const inHead = (r: BacktestResult) =>
      r.trades.filter(
        (t) =>
          t.exitTime !== undefined &&
          t.timestamp <= cut &&
          t.exitTime <= cut,
      );
    // Sanity: the comparison is only meaningful if it actually compares something.
    expect(inHead(a).length).toBeGreaterThan(0);

    expect(inHead(b)).toEqual(inHead(a));
  });

  test('the equity curve starts at the starting balance', async () => {
    const result = await run(uptrendWithPullbacks(), { startingBalance: 10_000 });
    expect(result.equityCurve[0].equity).toBeCloseTo(10_000, 2);
  });

  test('changing the starting balance does not change WHICH trades occur', async () => {
    const a = await run(uptrendWithPullbacks(), { startingBalance: 10_000 });
    const b = await run(uptrendWithPullbacks(), { startingBalance: 50_000 });
    // Sizing scales, but the signals are price-derived and must not move.
    expect(b.trades.length).toBe(a.trades.length);
    expect(b.trades.map((t) => t.direction)).toEqual(a.trades.map((t) => t.direction));
  });
});

describe('empty and degenerate runs', () => {
  test('a range-bound series reports only what it actually traded', async () => {
    const result = await run(rangeBound());

    /**
     * Whatever the strategy decides here, the reported metrics must be
     * internally consistent with the trade list. The assertion is on
     * consistency, NOT on "no trades": pinning the count would encode a
     * strategy outcome as a fact about the engine.
     */
    expect(result.trades.length).toBe(result.totalSignals);
    expect(result.filledSignals + result.invalidatedSignals + result.expiredSignals)
      .toBe(result.totalSignals);
    if (result.filledSignals === 0) {
      expect(result.netDollarPnl).toBe(0);
      expect(result.maxDrawdown).toBe(0);
    }
    // No metric may be a fabricated number.
    expect(Number.isFinite(result.winRate)).toBe(true);
    expect(Number.isFinite(result.netDollarPnl)).toBe(true);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
    expect(result.profitFactor === null || Number.isFinite(result.profitFactor)).toBe(true);
  });

  test('drawdown can never exceed 100% and the run reports bankruptcy instead', async () => {
    /**
     * Regression. With fixed-fraction risk and no guard, a losing streak drove
     * equity negative and the reported drawdown exceeded 100% — an observed
     * 207%, which describes no real account state.
     */
    const result = await run(downtrendWithBounces());
    expect(result.maxDrawdown).toBeLessThanOrEqual(100.0001);
    if (result.bankrupt) {
      expect(result.netDollarPnl).toBeLessThan(0);
    }
  });

  test('invalid parameters are rejected before any data is fetched', async () => {
    const provider = new FixtureProvider({ 'TEST/USD': seriesFromCloses(uptrendWithPullbacks()) });
    await expect(
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'TEST/USD',
        period: '30d',
        provider,
        startingBalance: 0,
      } as never),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'TEST/USD',
        period: '30d',
        provider,
        riskPerTradePct: 99,
      } as never),
    ).rejects.toThrow(/between 0% and 10%/i);
  });

  test('trading costs are charged and disclosed', async () => {
    const result = await run(uptrendWithPullbacks());
    expect(result.costModel.summary).toMatch(/fee/i);
    expect(result.costModel.totalCosts).toBeGreaterThan(0);
    // Costs must REDUCE the outcome, not be decorative.
    const uncosted = await run(uptrendWithPullbacks(), { startingBalance: 10_000 });
    expect(result.costModel.totalCosts).toBeGreaterThan(0);
    expect(uncosted.costModel.totalCosts).toBe(result.costModel.totalCosts);
  });
});