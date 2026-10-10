/**
 * TEST DOUBLES
 * ============
 * Shared fakes for tests that need a reasoning gateway or a GOAT runtime state.
 *
 * WHY A FACTORY INSTEAD OF INLINE STUBS
 *
 * `ReasoningGateway` gained a provider dimension (OpenRouter / Groq), and each
 * test file that hand-rolled a stub had to be edited. Centralising it means the
 * next provider change is one edit rather than five, and it keeps the stubs
 * honest: a test cannot accidentally pass because its stub happened to satisfy
 * a narrower interface than production does.
 */

import type { ReasoningGateway } from '../../src/server/reasoningGateway';
import type { GoatRuntimeState, FundGoat } from '../../src/types';

export interface StubGatewayOptions {
  /** Replaces the default echo behaviour. */
  answer?: (question: string) => Promise<string>;
  evaluate?: ReasoningGateway['evaluateGoat'];
  hasKey?: boolean;
  provider?: 'openrouter' | 'groq';
}

/** A gateway that records nothing and does nothing surprising. */
export function stubGateway(options: StubGatewayOptions = {}): ReasoningGateway {
  return {
    evaluateGoat:
      options.evaluate ??
      (async () => {
        throw new Error('evaluateGoat is not stubbed for this test');
      }),
    answerGoatQuestion:
      options.answer ?? (async (question: string) => `Echo: ${question}`),
    hasKeyFor: async () => options.hasKey ?? false,
    providerFor: async () => options.provider ?? 'openrouter',
    listModels: async () => ({
      models: [],
      provider: options.provider ?? 'openrouter',
      fetchedAt: 0,
      source: 'stub',
    }),
    testKeyFor: async () => ({
      ok: false,
      provider: options.provider ?? 'openrouter',
      latencyMs: 0,
      error: 'not used here',
    }),
    invalidate: () => {},
  };
}

/** A minimal, honest runtime state. Every field is explicit, not defaulted. */
export function stubRuntimeState(overrides: Partial<GoatRuntimeState> = {}): GoatRuntimeState {
  return {
    goatId: 'g1',
    status: 'WATCHING',
    currentThesis: null,
    trackers: [],
    lastWakeEvent: null,
    recentWakeEvents: [],
    latestSignal: null,
    dormancyReason: 'test',
    nextWatchingCondition: 'test',
    generationId: 'gen_1',
    lastEvaluatedAt: Date.now(),
    isEvaluating: false,
    consecutiveFailures: 0,
    dataSource: 'PAPER',
    reasoningMode: 'DEMO',
    ...overrides,
  };
}

/** A minimal GOAT definition. */
export function stubGoat(overrides: Partial<FundGoat> = {}): FundGoat {
  return {
    id: 'g1',
    userId: 'u1',
    name: 'Test GOAT',
    goal: 'test goal',
    markets: ['EUR/USD'],
    skillIds: ['skill_price_action'],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    schedule: { mode: 'INTERVAL', intervalMinutes: 60 },
    timeframe: '15m',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}