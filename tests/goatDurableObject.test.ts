import { describe, test, expect, beforeEach } from 'bun:test';
import { GoatDurableObject } from '../src/services/durable-object/GoatDurableObject';
import type { ReasoningGateway } from '../src/server/reasoningGateway';
import { PaperMarketDataProvider } from '../src/services/market-data/PaperMarketDataProvider';
import { InMemoryPersistence } from '../src/server/repositories';
import { ReasoningValidationError, parseReasoningResult } from '../src/services/agent/contracts';
import { SignalGoat, TradingSkill } from '../src/types';

function makeGoat(): SignalGoat {
  return {
    id: 'goat_test_1',
    userId: 'user_1',
    name: 'Test Goat',
    goal: 'Test disciplined conditional setups.',
    markets: ['EUR/USD'],
    skillIds: [],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const SKILLS: TradingSkill[] = [];

function makeGateway(
  evaluate: ReasoningGateway['evaluateGoat'],
): ReasoningGateway {
  return {
    evaluateGoat: evaluate,
    answerGoatQuestion: async () => 'ok',
    hasKeyFor: async () => false,
    listModels: async () => ({ models: [], fetchedAt: 0 }),
    testKeyFor: async () => ({ ok: false, latencyMs: 0, error: 'not used here' }),
    invalidate: () => {},
  };
}

function makeObject(
  gateway: ReasoningGateway,
  options?: Partial<{ baseCheckIntervalMs: number }>,
): { actor: GoatDurableObject; persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  const provider = new PaperMarketDataProvider({ enableTicks: false });
  const actor = new GoatDurableObject(makeGoat(), SKILLS, {
    reasoning: gateway,
    marketProvider: provider,
    signals: persistence.signals,
    theses: persistence.theses,
    wakeEvents: persistence.wakeEvents,
    autoStartScheduler: false,
    baseCheckIntervalMs: options?.baseCheckIntervalMs,
  });
  return { actor, persistence };
}

describe('GoatDurableObject wake pipeline', () => {
  let actor: GoatDurableObject;
  let persistence: InMemoryPersistence;

  beforeEach(() => {
    actor?.destroy();
  });

  test('malformed LLM response NEVER crashes — becomes NO_TRADE/ERROR wake event', async () => {
    const gateway = makeGateway(async () => {
      throw new Error('500 Internal');
    });
    ({ actor, persistence } = makeObject(gateway));
    const state = await actor.wake('test', 'MANUAL_REEVALUATE');

    expect(state.status).toBe('WATCHING');
    expect(state.lastWakeEvent?.decisionResult).toBe('ERROR');
    expect(state.lastWakeEvent?.details).toContain('MODEL_UNAVAILABLE');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.isEvaluating).toBe(false);
  });

  test('reasoning contract violations are recorded as REASONING_ERROR', async () => {
    const gateway = makeGateway(async () => {
      throw new ReasoningValidationError(['proposal.decision must be one of: ACTIONABLE, NO_TRADE']);
    });
    ({ actor, persistence } = makeObject(gateway));
    const state = await actor.wake('test', 'MANUAL_REEVALUATE');

    expect(state.status).toBe('WATCHING');
    expect(state.lastWakeEvent?.details).toContain('REASONING_ERROR');
    expect(state.consecutiveFailures).toBe(1);
  });

  test('valid NO_TRADE reasoning produces a clean WATCHING state and NO_TRADE signal', async () => {
    const gateway = makeGateway(async (ctx) => ({
      investigation: { summary: `Reviewed ${ctx.market}.` },
      thesis: {
        directionalBias: 'NEUTRAL',
        summary: 'No clear edge.',
        confidence: 40,
        invalidation: 'Not applicable.',
        observationPlan: 'Wait for session open.',
        trackers: [{ description: 'Price above 1.0800', type: 'PRICE_LEVEL', targetValue: 1.08, operator: 'GREATER_THAN' }],
      },
      proposal: { decision: 'NO_TRADE', noTradeReason: 'Evidence insufficient for a conditional setup.' },
      evidence: [],
    }));
    ({ actor, persistence } = makeObject(gateway));
    const state = await actor.wake('test', 'MANUAL_REEVALUATE');

    expect(state.status).toBe('WATCHING');
    expect(state.lastWakeEvent?.decisionResult).toBe('NO_TRADE');
    expect(state.currentThesis?.directionalHypothesis).toBe('NEUTRAL');
    expect(state.trackers.length).toBe(1);
    // Thesis and wake event persisted.
    expect((await persistence.theses.listByGoat('goat_test_1')).length).toBeGreaterThan(0);
    expect((await persistence.wakeEvents.listByGoat('goat_test_1')).length).toBeGreaterThan(0);
    expect(state.consecutiveFailures).toBe(0);
  });

  test('gate-approved ACTIONABLE result becomes an ACTIVE runtime with an actionable signal', async () => {
    const gateway = makeGateway(async () =>
      parseReasoningResult({
        investigation: { summary: 'Bullish structure on 1h.' },
        thesis: {
          directionalBias: 'BULLISH',
          summary: 'Bullish continuation.',
          confidence: 85,
          invalidation: 'Close below 1.0800.',
          observationPlan: 'Watch demand retest.',
          trackers: [],
        },
        proposal: {
          decision: 'ACTIONABLE',
          triggerSequence: ['EMA(20) crosses above 1.0840', 'price holds above 1.0840 on a 15m close'],
          direction: 'LONG',
          orderType: 'LIMIT',
          market: 'EUR/USD',
          entry: 1.0845,
          stopLoss: 1.082,
          takeProfit: 1.092,
          rationale: 'Demand retest after sweep.',
          confirmationRequired: '15m close above entry.',
          invalidation: 'Close below 1.0800.',
        },
        evidence: [
          { source: 'STRUCTURE', market: 'EUR/USD', observation: 'HH established.', classification: 'SUPPORTING' },
          { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI recovering.', classification: 'SUPPORTING' },
        ],
      }),
    );

    let signalled: unknown = null;
    const persistence = new InMemoryPersistence();
    const provider = new PaperMarketDataProvider({ enableTicks: false });
    const a = new GoatDurableObject(makeGoat(), SKILLS, {
      reasoning: gateway,
      marketProvider: provider,
      signals: persistence.signals,
      theses: persistence.theses,
      wakeEvents: persistence.wakeEvents,
      onSignal: (_goat, signal) => {
        signalled = signal;
      },
      autoStartScheduler: false,
    });
    actor = a;

    const state = await a.wake('test', 'MANUAL_REEVALUATE');
    expect(state.status).toBe('ACTIVE');
    expect(state.latestSignal?.status).toBe('ACTIONABLE');
    expect(state.latestSignal?.direction).toBe('LONG');
    expect(state.latestSignal?.orderType).toBe('LIMIT');
    expect(signalled).not.toBeNull();
    expect((await persistence.signals.listByGoat('goat_test_1'))[0].status).toBe('ACTIONABLE');
  });

  test('in-skill hard constraints block otherwise-valid setups (LIMIT_ORDERS_ONLY)', async () => {
    const gateway = makeGateway(async () =>
      parseReasoningResult({
        investigation: { summary: 'Bullish.' },
        thesis: { directionalBias: 'BULLISH', summary: 'Continuation.', confidence: 85, invalidation: 'Below 1.0800.', trackers: [] },
        proposal: {
          decision: 'ACTIONABLE',
          triggerSequence: ['EMA(20) crosses above 1.0840', 'price holds above 1.0840 on a 15m close'],
          direction: 'LONG',
          orderType: 'MARKET',
          market: 'EUR/USD',
          entry: 1.0845,
          stopLoss: 1.082,
          takeProfit: 1.092,
          rationale: 'Market order test.',
          confirmationRequired: 'Immediate.',
          invalidation: 'Below 1.0800.',
        },
        evidence: [
          { source: 'STRUCTURE', market: 'EUR/USD', observation: 'HH.', classification: 'SUPPORTING' },
          { source: 'RSI_14', market: 'EUR/USD', observation: 'RSI ok.', classification: 'SUPPORTING' },
        ],
      }),
    );

    const looSkill: TradingSkill = {
      id: 'skill_loo',
      userId: 'system',
      name: 'LOO',
      description: '',
      methodology: '',
      constraints: 'LIMIT_ORDERS_ONLY',
      preferredTimeframes: ['1h'],
      requiredEvidence: '',
      invalidationRules: '',
      createdAt: '',
      updatedAt: '',
    };

    const persistence = new InMemoryPersistence();
    const a = new GoatDurableObject(makeGoat(), [looSkill], {
      reasoning: gateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: persistence.signals,
      theses: persistence.theses,
      wakeEvents: persistence.wakeEvents,
      autoStartScheduler: false,
    });
    actor = a;

    const state = await a.wake('test', 'MANUAL_REEVALUATE');
    expect(state.status).toBe('WATCHING');
    expect(state.lastWakeEvent?.decisionResult).toBe('NO_TRADE');
    expect(state.lastWakeEvent?.details).toContain('LIMIT_ORDERS_ONLY');
  });

  test('wake is mutex-guarded: concurrent wakes collapse to one evaluation', async () => {
    let evaluationCount = 0;
    const gateway = makeGateway(async () => {
      evaluationCount++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        investigation: { summary: 'x' },
        thesis: { directionalBias: 'NEUTRAL', summary: 'No edge.', confidence: 40, trackers: [] },
        proposal: { decision: 'NO_TRADE', noTradeReason: 'Quiet market.' },
        evidence: [],
      };
    });
    ({ actor } = makeObject(gateway));

    await Promise.all([
      actor.wake('a', 'MANUAL_REEVALUATE'),
      actor.wake('b', 'MANUAL_REEVALUATE'),
      actor.wake('c', 'MANUAL_REEVALUATE'),
    ]);

    expect(evaluationCount).toBe(1);
    expect(actor.getState().isEvaluating).toBe(false);
  });

  test('destroy() stops the actor from further wakes', async () => {
    const gateway = makeGateway(async () => {
      throw new Error('should not be called');
    });
    ({ actor } = makeObject(gateway));
    actor.destroy();
    const state = await actor.wake('should-not-run', 'MANUAL_REEVALUATE');
    expect(state.lastWakeEvent?.reason).not.toBe('should-not-run');
  });
});
