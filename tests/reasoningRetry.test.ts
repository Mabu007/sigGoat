/**
 * REASONING-OFF RETRY SEMANTICS
 * =============================
 * `evaluateGoat` recovers from a model that spends its whole output budget on
 * hidden reasoning by retrying with reasoning disabled. This pins the two
 * properties that recovery depends on, both found in production.
 *
 * Everything here runs offline: `complete` is replaced, so no tokens are spent
 * and no network is touched.
 */

import { describe, test, expect } from 'bun:test';
import { OpenRouterClient, ApiRequestError } from '../src/services/ai/OpenRouterClient';

interface Attempt {
  maxTokens: number | undefined;
  reasoningDisabled: boolean;
}

const context = {
  goat: { id: 'g1', name: 'G', goal: 'g', markets: ['xyz:GOLD'], model: 'x' },
  market: 'xyz:GOLD',
  quote: { symbol: 'xyz:GOLD', mid: 1, timestamp: Date.now(), stale: false },
  candles: [],
  indicators: null,
  session: { name: 'London', phase: 'active' },
  skills: [],
  trackers: [],
  openPositions: [],
  recentSignals: [],
} as never;

/** A reply that satisfies the reasoning contract, so a retry can succeed. */
function validCompletion() {
  return {
    content: JSON.stringify({
      investigation: { summary: 's', marketView: 'v' },
      thesis: {
        directionalBias: 'NEUTRAL',
        summary: 's',
        confidence: 60,
        invalidation: 'i',
        observationPlan: 'o',
        trackers: [],
      },
      proposal: {
        decision: 'NO_TRADE',
        market: 'xyz:GOLD',
        direction: 'LONG',
        orderType: 'LIMIT',
        noTradeReason: 'Structure is neutral.',
        confidence: 60,
        thesis: 't',
        rationale: 'r',
        confirmationRequired: 'c',
        invalidation: 'i',
      },
      evidence: [],
    }),
    model: 'stub',
    usage: {},
    requestId: 'stub',
    latencyMs: 1,
  } as never;
}

function instrument(client: OpenRouterClient, firstThrows: boolean) {
  const attempts: Attempt[] = [];
  let call = 0;
  (client as unknown as { complete: unknown }).complete = async (
    options: { maxTokens?: number; reasoningDisabled?: boolean },
  ) => {
    attempts.push({
      maxTokens: options.maxTokens,
      reasoningDisabled: options.reasoningDisabled === true,
    });
    call += 1;
    if (firstThrows && call === 1) {
      throw new ApiRequestError(
        'The model used its entire token budget on hidden reasoning and returned no answer.',
        { code: 'REASONING_BUDGET_EXHAUSTED', retryable: false },
      );
    }
    return validCompletion();
  };
  return attempts;
}

describe('a model that exhausts its budget on reasoning is retried properly', () => {
  test('the retry disables reasoning AND raises the token ceiling', async () => {
    const client = new OpenRouterClient({ apiKey: 'sk-or-v1-test-key-not-used-000000000000' });
    const attempts = instrument(client, true);

    await client.evaluateGoat(context, 'some/model');

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0].reasoningDisabled).toBe(false);
    expect(attempts[1].reasoningDisabled).toBe(true);

    /**
     * The regression.
     *
     * The retry used to reuse the SAME ceiling. That fails for exactly the
     * reason the first attempt did — on any provider that ignores both
     * `reasoning: {exclude: true}` and the reasoning max_tokens cap — so the
     * wake died having produced nothing, every time.
     *
     * Note the subtlety that shipped it: `attempt` resolves its ceiling as
     * `options.maxTokens ?? REASONING_RUN_MAX_TOKENS`, so assigning the local
     * `budget` variable on the retry path is a silent no-op. The ceiling has
     * to be passed explicitly.
     */
    expect(attempts[1].maxTokens).toBeGreaterThan(attempts[0].maxTokens!);
  });

  test('a model that burns the retry budget too is escalated once more', async () => {
    const client = new OpenRouterClient({ apiKey: 'sk-or-v1-test-key-not-used-000000000000' });
    const attempts = instrument(client, true);

    // Every attempt burns its budget on reasoning.
    let calls = 0;
    (client as unknown as { complete: unknown }).complete = async (
      options: { maxTokens?: number; reasoningDisabled?: boolean },
    ) => {
      attempts.push({
        maxTokens: options.maxTokens,
        reasoningDisabled: options.reasoningDisabled === true,
      });
      calls += 1;
      // Attempts 1-3 are: original, 8k retry, 16k escalation.
      if (calls <= 2) {
        throw new ApiRequestError(
          'The model used its entire token budget on hidden reasoning and returned no answer.',
          { code: 'REASONING_BUDGET_EXHAUSTED', retryable: false },
        );
      }
      return validCompletion();
    };

    await client.evaluateGoat(context, 'some/model');

    /**
     * Reasoning-first free models do not merely resist `exclude` — they can
     * exhaust an 8k budget and do the same again on the next call, because
     * the free tier routes each request to a different upstream. Giving up
     * there means a GOAT that silently produces nothing.
     */
    // Attempt 1 (original) fails, 8k retry fails, 16k escalation succeeds.
    expect(attempts.length).toBe(3);
    const ceilings = attempts.map((a) => a.maxTokens!);
    expect(ceilings[1]).toBeGreaterThan(ceilings[0]);
    expect(ceilings[2]).toBeGreaterThan(ceilings[1]);
  });

  test('a healthy model is not retried at all', async () => {
    const client = new OpenRouterClient({ apiKey: 'sk-or-v1-test-key-not-used-000000000000' });
    const attempts = instrument(client, false);

    await client.evaluateGoat(context, 'some/model');

    // One attempt only: no wasted calls, no doubled cost.
    expect(attempts.length).toBe(1);
  });

  test('a non-budget error is NOT retried with reasoning disabled', async () => {
    const client = new OpenRouterClient({ apiKey: 'sk-or-v1-test-key-not-used-000000000000' });
    const attempts: Attempt[] = [];
    (client as unknown as { complete: unknown }).complete = async () => {
      attempts.push({ maxTokens: 1, reasoningDisabled: false });
      throw new ApiRequestError('Model "x/y" is no longer listed by OpenRouter.', {
        code: 'MODEL_NOT_LISTED',
        retryable: false,
      });
    };

    await client
      .evaluateGoat(context, 'some/model')
      .catch(() => undefined);

    // Retrying a retired model would just fail the same way, more slowly.
    expect(attempts.length).toBe(1);
  });
});