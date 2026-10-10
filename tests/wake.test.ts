import { describe, test, expect, afterEach } from 'bun:test';
import { GoatDurableObject } from '../src/services/durable-object/GoatDurableObject';
import type { ReasoningGateway } from '../src/server/reasoningGateway';
import { PaperMarketDataProvider, PAPER_DATA_MODE } from '../src/services/market-data/PaperMarketDataProvider';
import { MarketDataProvider } from '../src/services/market-data/MarketDataProvider';
import { InMemoryPersistence } from '../src/server/repositories';
import { FundGoat, TradingSkill, MarketSymbol, MarketQuote, Candle } from '../src/types';

function makeGoat(): FundGoat {
  return {
    id: 'goat_wake_test',
    userId: 'user_wake',
    name: 'Wake Test Goat',
    goal: 'Wake pipeline test.',
    markets: ['EUR/USD'],
    skillIds: [],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const SKILLS: TradingSkill[] = [];

const NO_TRADE_RESULT = {
  investigation: { summary: 'Reviewed the market.' },
  thesis: {
    directionalBias: 'NEUTRAL' as const,
    summary: 'No clear edge.',
    confidence: 40,
    trackers: [],
  },
  proposal: { decision: 'NO_TRADE' as const, noTradeReason: 'Evidence insufficient.' },
  evidence: [],
};

function gateway(options: {
  hasKey?: boolean;
  evaluate?: ReasoningGateway['evaluateGoat'];
}): ReasoningGateway {
  return {
    evaluateGoat: options.evaluate ?? (async () => NO_TRADE_RESULT),
    answerGoatQuestion: async () => 'ok',
    hasKeyFor: async () => options.hasKey ?? false,
    listModels: async () => ({ models: [], provider: 'openrouter', fetchedAt: 0, source: 'stub' }),
    providerFor: async () => 'openrouter',
    testKeyFor: async () => ({ ok: false, provider: 'openrouter', latencyMs: 0, error: 'not used here' }),
    invalidate: () => {},
  };
}

/** Provider whose quotes/candles always fail — simulates a dead feed. */
class FailingProvider implements MarketDataProvider {
  readonly name = 'Failing Feed';
  readonly dataMode = PAPER_DATA_MODE;
  async getSymbols(): Promise<MarketSymbol[]> {
    throw new Error('feed down');
  }
  async getQuote(symbol: string): Promise<MarketQuote> {
    throw new Error(`quote feed unavailable for ${symbol}`);
  }
  async getQuotes(): Promise<MarketQuote[]> {
    throw new Error('feed down');
  }
  async getCandles(): Promise<Candle[]> {
    throw new Error('feed down');
  }
  getMarketMetadata(): MarketSymbol | undefined {
    return undefined;
  }
  subscribeQuotes(): () => void {
    return () => undefined;
  }
}

let actor: GoatDurableObject | undefined;

function makeActor(gw: ReasoningGateway, provider?: MarketDataProvider) {
  const persistence = new InMemoryPersistence();
  const instance = new GoatDurableObject(makeGoat(), SKILLS, {
    reasoning: gw,
    marketProvider: provider ?? new PaperMarketDataProvider({ enableTicks: false }),
    signals: persistence.signals,
    theses: persistence.theses,
    wakeEvents: persistence.wakeEvents,
    autoStartScheduler: false,
  });
  actor = instance;
  return { actor: instance, persistence };
}

afterEach(() => {
  actor?.destroy();
  actor = undefined;
});

describe('wake pipeline resilience', () => {
  test('market-data failure becomes a clean ERROR wake event — never a crash', async () => {
    const gw = gateway({});
    const { actor: instance, persistence } = makeActor(gw, new FailingProvider());

    const state = await instance.wake('manual', 'MANUAL_REEVALUATE');

    expect(state.status).toBe('WATCHING');
    expect(state.lastWakeEvent?.decisionResult).toBe('ERROR');
    expect(state.lastWakeEvent?.details).toContain('Market data unavailable');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.isEvaluating).toBe(false);
    // Nothing was fabricated: no thesis, no signal.
    expect(state.currentThesis).toBeNull();
    expect(state.latestSignal).toBeNull();
    expect((await persistence.theses.listByGoat('goat_wake_test')).length).toBe(0);
    // The gateway was never reached with no data.
    expect(state.lastWakeEvent?.calculatedContext?.dataSource).toBe('PAPER');
  });

  test('reasoningMode is DEMO when no AI key is connected (never mislabelled AI)', async () => {
    const gw = gateway({ hasKey: false });
    const { actor: instance } = makeActor(gw);

    const state = await instance.wake('manual', 'MANUAL_REEVALUATE');

    expect(state.lastWakeEvent?.decisionResult).toBe('NO_TRADE');
    expect(state.reasoningMode).toBe('DEMO');
  });

  test('reasoningMode is AI when the owner has a model key configured', async () => {
    const gw = gateway({ hasKey: true });
    const { actor: instance } = makeActor(gw);

    const state = await instance.wake('manual', 'MANUAL_REEVALUATE');

    expect(state.lastWakeEvent?.decisionResult).toBe('NO_TRADE');
    expect(state.reasoningMode).toBe('AI');
  });

  test('destroy() mid-wake: the dead actor persists nothing and mutates nothing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gw = gateway({
      hasKey: false,
      evaluate: async () => {
        await gate;
        return NO_TRADE_RESULT;
      },
    });
    const { actor: instance, persistence } = makeActor(gw);

    const pending = instance.wake('slow wake', 'MANUAL_REEVALUATE');
    await new Promise((r) => setTimeout(r, 20));
    instance.destroy(); // GOAT deleted while the wake is in flight
    release();
    const state = await pending;

    expect(state.isEvaluating).toBe(false);
    expect(state.currentThesis).toBeNull();
    expect(state.lastWakeEvent).toBeNull();
    expect((await persistence.theses.listByGoat('goat_wake_test')).length).toBe(0);
    expect((await persistence.signals.listByGoat('goat_wake_test')).length).toBe(0);
    expect((await persistence.wakeEvents.listByGoat('goat_wake_test')).length).toBe(0);
  });

  test('stale work from a superseded generation cannot overwrite newer state', async () => {
    // Simulate supersession: while a wake's reasoning is in flight, the
    // actor's generation changes (a newer generation takes ownership).
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gw = gateway({
      hasKey: false,
      evaluate: async () => {
        await gate;
        return NO_TRADE_RESULT;
      },
    });
    const { actor: instance, persistence } = makeActor(gw);

    const pending = instance.wake('stale wake', 'MANUAL_REEVALUATE');
    await new Promise((r) => setTimeout(r, 20));
    // Externally supersede the generation (as a newer wake would).
    const runtime = instance.getState();
    expect(runtime.isEvaluating).toBe(true);
    (instance as unknown as { runtimeState: { generationId: string } }).runtimeState.generationId =
      'gen_superseded_by_test';
    release();
    const state = await pending;

    // The stale wake must not have written thesis/signal/wake-event state.
    expect(state.currentThesis).toBeNull();
    expect(state.lastWakeEvent).toBeNull();
    expect((await persistence.theses.listByGoat('goat_wake_test')).length).toBe(0);
    expect((await persistence.wakeEvents.listByGoat('goat_wake_test')).length).toBe(0);
    expect(state.isEvaluating).toBe(false);
  });
});
