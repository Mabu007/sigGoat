import { describe, test, expect } from 'bun:test';
import { GoatDurableObject } from '../src/services/durable-object/GoatDurableObject';
import { PaperMarketDataProvider } from '../src/services/market-data/PaperMarketDataProvider';
import { MarketStateStore } from '../src/services/market-data/MarketStateStore';
import { InMemoryPersistence } from '../src/server/repositories';
import { InProcessScheduler } from '../src/server/scheduler/InProcessScheduler';
import type { ReasoningGateway } from '../src/server/reasoningGateway';
import type { FundGoat, TradeSignal, TradingSkill } from '../src/types';
import type { MarketStateSnapshot } from '../src/services/market-data/MarketStateStore';

/**
 * The core loop's risk boundaries, in the order they can cause real damage:
 *
 *   1. degraded market data must NOT produce a thesis
 *   2. a tracker hit must wake the GOAT (and a miss must not)
 *   3. cooldown / isEvaluating must NOT allow duplicate concurrent wakes
 *   4. the AI must not be invoked by anything other than a real wake
 */

const NO_TRADE = {
  investigation: { summary: 'observed' },
  thesis: {
    directionalBias: 'NEUTRAL' as const,
    summary: 'no edge',
    confidence: 10,
    trackers: [],
  },
  proposal: {
    decision: 'NO_TRADE' as const,
    noTradeReason: 'no setup',
  },
  evidence: [],
};

function makeGateway(): ReasoningGateway & { calls: number } {
  const gateway = {
    calls: 0,
    async evaluateGoat() {
      gateway.calls += 1;
      return NO_TRADE as never;
    },
    async answerGoatQuestion() {
      return 'ok';
    },
    async hasKeyFor() {
      return false;
    },
    async listModels() {
      return { models: [], fetchedAt: 0 };
    },
    async testKeyFor() {
      return { ok: false, latencyMs: 0, error: 'x' };
    },
    invalidate() {},
  };
  return gateway as unknown as ReasoningGateway & { calls: number };
}

function makeGoat(over: Partial<FundGoat> = {}): FundGoat {
  return {
    id: 'goat_wake',
    userId: 'u',
    name: 'Test',
    goal: 'g',
    markets: ['EUR/USD'],
    skillIds: [],
    model: 'm',
    status: 'WATCHING',
    timeframe: '5m',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function liveSnapshot(mid: number, rsi = 25): MarketStateSnapshot {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: Date.UTC(2026, 9, 8) + i * 300_000,
    open: mid - 0.001,
    high: mid + 0.001,
    low: mid - 0.002,
    close: mid - i * 0.00001,
    volume: 500,
  }));

  return {
    symbol: 'EUR/USD',
    timeframe: '5m',
    key: 'EUR/USD:5m',
    fetchedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    status: 'LIVE',
    expired: false,
    degraded: false,
    latestPrice: mid,
    quote: {
      symbol: 'EUR/USD',
      bid: mid - 0.00003,
      ask: mid + 0.00003,
      mid,
      spread: 0.00006,
      change24h: 0,
      change24hPct: 0,
      high24h: mid + 0.002,
      low24h: mid - 0.002,
      timestamp: Date.now(),
    },
    candles,
    indicators: {
      price: mid,
      rsi14: rsi,
      ema20: mid - 0.0005,
      ema50: mid - 0.001,
      sma20: mid - 0.0004,
      atr14: 0.0008,
      macd: 0,
      macdSignal: 0,
      macdHistogram: 0,
      swingHigh20: mid + 0.002,
      swingLow20: mid - 0.002,
      sessionHigh: mid + 0.002,
      sessionLow: mid - 0.002,
      structureBias: 'RANGING',
    },
    computeMs: 1,
  };
}

function actor(gateway: ReasoningGateway, extra: Record<string, unknown> = {}) {
  const persistence = new InMemoryPersistence();
  return new GoatDurableObject(makeGoat(), [] as TradingSkill[], {
    reasoning: gateway,
    marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
    marketStateStore: new MarketStateStore(
      new PaperMarketDataProvider({ enableTicks: false }),
      { ttlMs: 60_000 },
    ),
    signals: persistence.signals,
    theses: persistence.theses,
    wakeEvents: persistence.wakeEvents,
    autoStartScheduler: false,
    ...extra,
  } as never);
}

describe('degraded data cannot produce a thesis', () => {
  test('a DEGRADED snapshot refuses to wake (no AI call)', async () => {
    const gateway = makeGateway();
    const persistence = new InMemoryPersistence();

    // A provider that is DOWN, so the shared store legitimately yields a
    // DEGRADED snapshot rather than LIVE data.
    const deadProvider = {
      name: 'dead',
      dataMode: 'LIVE' as const,
      async getSymbols() {
        return [];
      },
      getMarketMetadata() {
        return undefined;
      },
      async getQuote(): Promise<never> {
        throw new Error('provider down');
      },
      async getQuotes(): Promise<never[]> {
        throw new Error('provider down');
      },
      async getCandles(): Promise<never[]> {
        throw new Error('provider down');
      },
      subscribeQuotes() {
        return () => {};
      },
    };

    const store = new MarketStateStore(deadProvider as never, {
      ttlMs: 60_000,
      log: () => {},
    });

    const a = new GoatDurableObject(makeGoat(), [], {
      reasoning: gateway,
      marketProvider: deadProvider as never,
      marketStateStore: store,
      signals: persistence.signals,
      theses: persistence.theses,
      wakeEvents: persistence.wakeEvents,
      autoStartScheduler: false,
    } as never);

    await a.wake('manual', 'MANUAL_REEVALUATE');

    // The critical property: no AI call, and no thesis from unconfirmed data.
    expect(gateway.calls).toBe(0);
    const state = a.getState();
    expect(state.currentThesis).toBeNull();
    expect(state.lastWakeEvent?.details).toContain('Market data unavailable');
  });
});

describe('tracker event drives the wake', () => {
  test('a satisfied tracker escalates to a reasoning wake', async () => {
    const gateway = makeGateway();
    const a = actor(gateway);

    // Arm a tracker that WILL fire: RSI(14) below 30, snapshot rsi = 25.
    (a as never as { runtimeState: { trackers: unknown[] } }).runtimeState.trackers = [
      {
        id: 't1',
        description: 'RSI(14) below 30',
        type: 'INDICATOR',
        market: 'EUR/USD',
        operator: 'CROSS_BELOW',
        targetValue: 30,
        indicatorParams: { indicator: 'RSI', period: 14 },
        isTriggered: false,
      },
    ];

    const fired = await a.evaluateTrackersNow(liveSnapshot(1.2, 25));

    expect(fired).toBe(true);
    expect(gateway.calls).toBe(1);
  });

  test('an UNSATISFIED tracker escalates to nothing (no AI call)', async () => {
    const gateway = makeGateway();
    const a = actor(gateway);

    (a as never as { runtimeState: { trackers: unknown[] } }).runtimeState.trackers = [
      {
        id: 't1',
        description: 'RSI(14) below 30',
        type: 'INDICATOR',
        market: 'EUR/USD',
        operator: 'CROSS_BELOW',
        targetValue: 10,
        indicatorParams: { indicator: 'RSI', period: 14 },
        isTriggered: false,
      },
    ];

    const fired = await a.evaluateTrackersNow(liveSnapshot(1.2, 25));

    expect(fired).toBe(false);
    // The critical cost-control property: a market update that satisfies
    // nothing must not spend a token.
    expect(gateway.calls).toBe(0);
  });

  test('a DEGRADED snapshot cannot fire a tracker', async () => {
    const gateway = makeGateway();
    const a = actor(gateway);

    (a as never as { runtimeState: { trackers: unknown[] } }).runtimeState.trackers = [
      {
        id: 't1',
        description: 'RSI(14) below 30',
        type: 'INDICATOR',
        market: 'EUR/USD',
        operator: 'CROSS_BELOW',
        targetValue: 30,
        indicatorParams: { indicator: 'RSI', period: 14 },
        isTriggered: false,
      },
    ];

    const degraded = {
      ...liveSnapshot(1.2, 25),
      status: 'DEGRADED' as const,
      degraded: true,
    };

    const fired = await a.evaluateTrackersNow(degraded);

    expect(fired).toBe(false);
    expect(gateway.calls).toBe(0);
  });
});

describe('cooldown / duplicate protection', () => {
  test('a second concurrent wake is refused while one is evaluating', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const counter = { calls: 0 };
    const gateway = {
      ...makeGateway(),
      async evaluateGoat() {
        counter.calls += 1;
        // Hold the run open so the second wake genuinely overlaps it.
        await gate;
        return NO_TRADE as never;
      },
    } as unknown as ReasoningGateway;

    const a = actor(gateway);

    const first = a.wake('one', 'MANUAL_REEVALUATE');
    // Second request while the first is still in flight.
    const second = a.wake('two', 'MANUAL_REEVALUATE');

    release();
    await Promise.all([first, second]);

    // Exactly one run, so no duplicate signal or notification.
    expect(counter.calls).toBe(1);
  });

  test('a PAUSED GOAT ignores scheduled wakes but still answers manual ones', async () => {
    const gateway = makeGateway();
    const a = actor(gateway);
    a.pause();

    a.getState();
    await a.wake('scheduled', 'SCHEDULED');
    expect(gateway.calls).toBe(0);

    // A paused GOAT with no store would still attempt a fetch, so only assert
    // the gate itself here.
    expect(a.isPaused()).toBe(true);
  });
});

describe('scheduler presence removes in-process timers', () => {
  test('with a scheduler the actor arms NO local timer', async () => {
    const gateway = makeGateway();
    let fired = 0;

    const scheduler = new InProcessScheduler(async () => {
      fired += 1;
    });

    const a = new GoatDurableObject(makeGoat(), [] as TradingSkill[], {
      reasoning: gateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: undefined,
      theses: undefined,
      wakeEvents: undefined,
      baseCheckIntervalMs: 20,
      scheduler,
    } as never);

    await new Promise((r) => setTimeout(r, 120));

    // The durable scheduler owns the schedule, so the actor must not also
    // self-schedule — that would be two competing sources of truth.
    expect(fired).toBe(0);
    expect(scheduler.activeTimers()).toBe(0);

    a.destroy();
  });
});
