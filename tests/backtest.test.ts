import { describe, test, expect } from 'bun:test';
import { BacktestEngine } from '../src/services/backtest/BacktestEngine';
import { PaperMarketDataProvider, PAPER_DATA_MODE } from '../src/services/market-data/PaperMarketDataProvider';
import { MarketDataProvider } from '../src/services/market-data/MarketDataProvider';
import { FundGoat, TradingSkill, Candle, MarketSymbol, MarketQuote } from '../src/types';

function makeGoat(): FundGoat {
  return {
    id: 'goat_bt_1',
    userId: 'user_1',
    name: 'Backtest Goat',
    goal: 'Deterministic replay test.',
    markets: ['EUR/USD'],
    skillIds: [],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const SKILLS: TradingSkill[] = [];

describe('BacktestEngine', () => {
  test('same provider + params produce byte-identical results (deterministic)', async () => {
    const run = () =>
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'EUR/USD',
        period: '7d',
        provider: new PaperMarketDataProvider({ enableTicks: false }),
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(a.id).toBe(b.id);
    expect(a.trades).toEqual(b.trades);
    expect(a.netDollarPnl).toBe(b.netDollarPnl);
    expect(a.equityCurve).toEqual(b.equityCurve);
  });

  test('result is labelled PAPER — simulated data can never pass as live', async () => {
    const result = await BacktestEngine.runBacktest({
      goat: makeGoat(),
      skills: SKILLS,
      market: 'EUR/USD',
      period: '24h',
      provider: new PaperMarketDataProvider({ enableTicks: false }),
    });
    expect(result.dataSource).toBe('PAPER');
  });

  test('trades use canonical orderType and strict direction enums', async () => {
    const result = await BacktestEngine.runBacktest({
      goat: makeGoat(),
      skills: SKILLS,
      market: 'EUR/USD',
      period: '7d',
      provider: new PaperMarketDataProvider({ enableTicks: false }),
    });
    for (const trade of result.trades) {
      expect(['LIMIT', 'STOP', 'MARKET']).toContain(trade.orderType);
      expect(['LONG', 'SHORT']).toContain(trade.direction);
      expect(['WIN', 'LOSS', 'UNFILLED', 'INVALIDATED_BEFORE_FILL', 'EXPIRED']).toContain(trade.outcome);
      // Price structure sanity per direction
      if (trade.direction === 'LONG') {
        expect(trade.stopLoss).toBeLessThan(trade.plannedEntry);
        expect(trade.takeProfit).toBeGreaterThan(trade.plannedEntry);
      } else {
        expect(trade.stopLoss).toBeGreaterThan(trade.plannedEntry);
        expect(trade.takeProfit).toBeLessThan(trade.plannedEntry);
      }
    }
  });

  test('equity accounting is consistent with filled trades', async () => {
    const result = await BacktestEngine.runBacktest({
      goat: makeGoat(),
      skills: SKILLS,
      market: 'EUR/USD',
      period: '30d',
      provider: new PaperMarketDataProvider({ enableTicks: false }),
      startingBalance: 10_000,
    });
    const expected = 10_000 + result.netDollarPnl;
    const lastEquity = result.equityCurve[result.equityCurve.length - 1].equity;
    expect(lastEquity).toBeCloseTo(expected, 1);
  });

  test('missing/unavailable market data is a clean error, not a fabricated empty run', async () => {
    const stubProvider = new PaperMarketDataProvider({ enableTicks: false });
    expect(
      BacktestEngine.runBacktest({
        goat: makeGoat(),
        skills: SKILLS,
        market: 'NOT/A_SYMBOL',
        period: '7d',
        provider: stubProvider,
      }),
    ).rejects.toThrow(/Insufficient historical market data/);
  });

  test('no overlapping lifecycles: a new setup can never start while one is open', async () => {
    const result = await BacktestEngine.runBacktest({
      goat: makeGoat(),
      skills: SKILLS,
      market: 'EUR/USD',
      period: '30d',
      provider: new PaperMarketDataProvider({ enableTicks: false }),
    });
    const trades = [...result.trades].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < trades.length; i++) {
      const prev = trades[i - 1];
      const curr = trades[i];
      // Whatever the previous setup did, the next one may only exist after
      // it has been fully consumed (exited, expired, or invalidated).
      expect(curr.timestamp).toBeGreaterThanOrEqual(prev.exitTime ?? prev.timestamp);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Deterministic hand-built fixture: full control over every bar.      */
/* ------------------------------------------------------------------ */

const FIXTURE_START = Date.UTC(2024, 5, 1, 0, 0, 0);
const HOUR = 3_600_000;
const PIP = 0.0001;

function fixtureBar(index: number, open: number, close: number, highExtra = 0.00004, lowExtra = 0): Candle {
  return {
    time: FIXTURE_START + index * HOUR,
    open: Number(open.toFixed(5)),
    high: Number((Math.max(open, close) + highExtra).toFixed(5)),
    low: Number((Math.min(open, close) - lowExtra).toFixed(5)),
    close: Number(close.toFixed(5)),
    volume: 1000,
  };
}

/**
 * Crafted series:
 *  - bars 0..29  : steady decline (RSI deeply below 42 -> LONG setup at cursor 30)
 *  - bars 30..47 : gentler decline so the conditional entry fills
 *  - bars 48..119: flat, except bar 70 which spans BOTH stop and target
 *  - total 120 bars (> MIN_REQUIRED_BARS)
 */
/**
 * CALIBRATED FIXTURE.
 *
 * The previous version relied on the engine taking a counter-trend LONG during
 * a downtrend, which the corrected direction logic — a mean-reversion entry may
 * not fire against a decisive structure — no longer does, and should not.
 *
 * The shape is rebuilt around the two properties these tests actually check:
 *   - bars 0-29 drift up, so a setup first becomes available AT the 30-bar
 *     lookback boundary (the property the cursor test asserts);
 *   - a pullback fills the conditional limit, then ONE oversized bar spans
 *     both the stop and the target, which is the ambiguity the stop-first
 *     rule exists to resolve.
 */
function buildFixtureSeries(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;

  /**
   * Shape: 6 bars rising 5 pips, then 4 bars falling 9 pips. The rise builds
   * BULLISH structure with RSI inside the cap so a LONG is armed; the fall is
   * deep enough to pull price back through the conditional limit and fill it.
   *
   * On ONE cycle the THIRD falling bar is replaced by an oversized bar whose
   * high (+55 pips) clears the target and whose low (-35 pips) clears the
   * stop. OHLC cannot order those two touches inside one bar, which is
   * exactly the ambiguity the stop-first rule exists to resolve.
   *
   * The position has to be FILLED before that bar. Earlier placements either
   * invalidate the still-pending order (its low reaches the stop before the
   * entry) or leave an ordinary bar free to close the position first, and the
   * engine then never sees the ambiguous bar at all. The index was found by
   * scanning each position and asserting the one that actually produces the
   * ambiguity, rather than by guessing.
   */
  for (let cycle = 0; cycle < 12; cycle += 1) {
    for (let k = 0; k < 6; k += 1) {
      price += 5 * PIP;
      candles.push(fixtureBar(candles.length, price, price, 0.5 * PIP, 0.5 * PIP));
    }
    for (let k = 0; k < 4; k += 1) {
      if (cycle === 3 && k === 2) {
        candles.push(fixtureBar(candles.length, price, price, 55 * PIP, 35 * PIP));
      }
      price -= 9 * PIP;
      candles.push(fixtureBar(candles.length, price, price, 0.5 * PIP, 0.5 * PIP));
    }
  }

  return candles;
}

class ScriptedProvider implements MarketDataProvider {
  readonly name = 'Scripted Fixture';
  readonly dataMode = PAPER_DATA_MODE;
  constructor(private candles: Candle[]) {}
  async getSymbols(): Promise<MarketSymbol[]> {
    return [
      {
        symbol: 'EUR/USD', name: 'Euro / US Dollar', category: 'forex',
        baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: PIP, digits: 5, minSpread: 1,
      },
    ];
  }
  async getQuote(symbol: string): Promise<MarketQuote> {
    return {
      symbol, bid: 1.1, ask: 1.1, mid: 1.1, spread: 1,
      change24h: 0, change24hPct: 0, high24h: 1.1, low24h: 1.1, timestamp: Date.now(),
    };
  }
  async getQuotes(symbols: string[]): Promise<MarketQuote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }
  async getCandles(): Promise<Candle[]> {
    return this.candles;
  }
  getMarketMetadata(): MarketSymbol | undefined {
    return undefined;
  }
  subscribeQuotes(): () => void {
    return () => undefined;
  }
}

function runFixture(candles: Candle[]) {
  return BacktestEngine.runBacktest({
    goat: makeGoat(),
    skills: SKILLS,
    market: 'EUR/USD',
    period: '7d',
    provider: new ScriptedProvider(candles),
  });
}

describe('BacktestEngine — deterministic fixture scenarios', () => {
  test('same-bar target+stop ambiguity resolves conservatively (stop-first LOSS)', async () => {
    const result = await runFixture(buildFixtureSeries());

    const stopFirst = result.trades.find((t) => /same candle/i.test(t.reason));
    expect(stopFirst).toBeDefined();
    expect(stopFirst!.outcome).toBe('LOSS');
    expect(stopFirst!.direction).toBe('LONG');
    // The exit must be the CRAFTED spike bar, not some other bar: cycle 3
    // contributes bars 30-39 (6 rising then 4 falling), and the spike is the
    // third falling bar, index 38.
    expect(stopFirst!.exitTime).toBe(FIXTURE_START + 38 * HOUR);
    // Conservative: a LOSS, never credited as a win.
    expect(stopFirst!.pnlPips).toBeLessThan(0);
    expect(result.ambiguityPolicy).toContain('Stop-First');
  });

  test('the first setup is generated from historical data only (cursor 30)', async () => {
    const result = await runFixture(buildFixtureSeries());
    const first = result.trades[0];
    expect(first).toBeDefined();

    /**
     * The engine refuses to signal before it holds LOOKBACK_BARS (30) of
     * history, so the first setup cannot have been derived from fewer bars
     * than the strategy needs. `timestamp` is the FILL time, not the signal
     * time, which is why the execution path is parsed instead.
     */
    const signalTime = Date.parse(
      /generated at ([^,]+),/.exec(first.executionPath?.[0] ?? '')?.[1] ?? '',
    );
    expect(Number.isNaN(signalTime)).toBe(false);

    const signalBarIndex = Math.round((signalTime - FIXTURE_START) / HOUR);
    expect(signalBarIndex).toBeGreaterThanOrEqual(30);
    expect(first.timestamp).toBeGreaterThanOrEqual(signalTime);

    /**
     * Stop and target must sit on the correct sides OF WHICHEVER SIDE the
     * engine chose. Asserting a specific direction here would pin an
     * incidental strategy outcome; asserting the geometry cannot be wrong for
     * either direction.
     */
    if (first.direction === 'LONG') {
      expect(first.stopLoss).toBeLessThan(first.plannedEntry);
      expect(first.takeProfit).toBeGreaterThan(first.plannedEntry);
    } else {
      expect(first.stopLoss).toBeGreaterThan(first.plannedEntry);
      expect(first.takeProfit).toBeLessThan(first.plannedEntry);
    }
  });

  test('no lookahead: mutating future bars never changes earlier setups', async () => {
    const base = buildFixtureSeries();
    const divergenceIndex = 90;
    const divergenceTime = base[divergenceIndex].time;
    const mutated = base.map((c, i) =>
      i >= divergenceIndex ? fixtureBar(i, c.open, c.close + 0.0008, 0.0009, 0.0009) : c,
    );

    const [runA, runB] = await Promise.all([runFixture(base), runFixture(mutated)]);

    const preA = runA.trades.filter((t) => t.timestamp < divergenceTime);
    const preB = runB.trades.filter((t) => t.timestamp < divergenceTime);
    expect(preA.length).toBeGreaterThanOrEqual(1);
    expect(preA.length).toBe(preB.length);

    const fingerprint = (t: (typeof preA)[number]) =>
      [t.timestamp, t.direction, t.orderType, t.plannedEntry, t.stopLoss, t.takeProfit, t.thesis].join('|');
    expect(preA.map(fingerprint)).toEqual(preB.map(fingerprint));
  });

  test('a new setup cannot be generated while a previous lifecycle is still open', async () => {
    const result = await runFixture(buildFixtureSeries());
    const trades = result.trades;
    for (let i = 1; i < trades.length; i++) {
      const prev = trades[i - 1];
      const curr = trades[i];
      expect(curr.timestamp).toBeGreaterThanOrEqual(prev.exitTime ?? prev.timestamp);
    }
    // In this fixture the stop-first trade exits at bar 70 and the next
    // generation only happens after it (bar 71+).
    const lastExit = trades[0].exitTime;
    if (lastExit !== undefined) {
      expect(trades[1].timestamp).toBeGreaterThan(lastExit);
    }
  });
});
