import { describe, test, expect } from 'bun:test';
import { GroqClient, isKnownGroqModel, GROQ_MODELS } from '../src/services/ai/GroqClient';
import { ApiRequestError } from '../src/services/ai/OpenRouterClient';
import type { GoatReasoningContext } from '../src/services/ai/OpenRouterClient';

/**
 * GROQ ADAPTER CONTRACT
 * =====================
 * The properties that matter for a fallback provider:
 *
 *   - Groq output goes through the SAME validator as OpenRouter output, so an
 *     adapter cannot smuggle an unvalidated shape into business logic;
 *   - a provider failure THROWS rather than returning a plausible NO_TRADE,
 *     because those two are indistinguishable to the runtime and one of them
 *     silently stops a user's monitoring;
 *   - Groq's model ids are its own, and no id is accepted on a `:free` suffix
 *     convention.
 *
 * `fetchImpl` is injected so these are real execution paths against a fake
 * transport, not assertions about the existence of functions.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(content: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'req_test',
    model: 'llama-3.3-70b-versatile',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    ...extra,
  });
}

/** A contract-valid payload. Anything else must be refused. */
const VALID_CONTRACT = {
  investigation: { summary: 'EUR/USD consolidating below 1.0850.' },
  thesis: {
    directionalBias: 'NEUTRAL',
    summary: 'No clean edge yet.',
    confidence: 40,
    trackers: [],
  },
  proposal: {
    decision: 'NO_TRADE',
    noTradeReason: 'Structure is unresolved; wait for a break.',
  },
  evidence: [
    {
      source: 'STRUCTURE',
      market: 'EUR/USD',
      observation: 'Consolidation under 1.0850.',
      classification: 'CONTRADICTORY',
    },
  ],
};

const context: GoatReasoningContext = {
  userId: 'u1',
  goatId: 'g1',
  goatName: 'Test GOAT',
  goatGoal: 'Wait for a London sweep.',
  market: 'EUR/USD',
  timeframe: '15m',
  candles: [],
  news: [],
  skills: [],
  deterministicIndicators: {},
} as unknown as GoatReasoningContext;

describe('GroqClient credential and model handling', () => {
  test('reports no usable key rather than making a request', async () => {
    let called = false;
    const client = new GroqClient({
      apiKey: '',
      fetchImpl: async () => {
        called = true;
        return completion('{}');
      },
    });

    expect(client.hasApiKey()).toBe(false);

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
    expect(called).toBe(false);
  });

  test('an unknown model is refused before any request is spent', async () => {
    let called = false;
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => {
        called = true;
        return completion('{}');
      },
    });

    const result = await client.testConnection('openai/gpt-4o-mini');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not one of the Groq models');
    expect(called).toBe(false);
  });

  test('model ids are Groq ids; nothing is inferred from a :free suffix', () => {
    expect(isKnownGroqModel('llama-3.3-70b-versatile')).toBe(true);
    // An OpenRouter id must not be accepted here.
    expect(isKnownGroqModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(false);
    expect(GROQ_MODELS.every((m) => !m.id.endsWith(':free'))).toBe(true);
  });

  test('the catalogue reports its source so a static list is not passed off as live', () => {
    const client = new GroqClient({ apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345' });
    const catalogue = client.listModels();

    expect(catalogue.source).toBe('groq-static');
    expect(catalogue.models.length).toBeGreaterThan(0);
    // Free tier is stated per model, never assumed from the id.
    expect(catalogue.models.every((m) => typeof m.freeTier === 'boolean')).toBe(true);
  });
});

describe('GroqClient structured output validation', () => {
  test('a contract-valid response is accepted', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => completion(JSON.stringify(VALID_CONTRACT)),
    });

    const { result } = await client.evaluateGoat(context);
    expect(result.proposal.decision).toBe('NO_TRADE');
    expect(result.thesis.confidence).toBe(40);
  });

  test('a response wrapped in a code fence is still parsed', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        completion('```json\n' + JSON.stringify(VALID_CONTRACT) + '\n```'),
    });

    const { result } = await client.evaluateGoat(context);
    expect(result.proposal.decision).toBe('NO_TRADE');
  });

  /**
   * The critical property. A malformed contract must fail LOUDLY.
   *
   * Returning a fallback NO_TRADE here would be indistinguishable from the
   * model's own NO_TRADE, so a broken Groq integration would look exactly like
   * a quiet market while the user believes they are being monitored.
   */
  test('an invalid contract throws rather than becoming a NO_TRADE', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        completion(
          JSON.stringify({
            investigation: { summary: 'ok' },
            thesis: {
              directionalBias: 'VERY_BULLISH',
              summary: 'buy now',
              confidence: 900,
              trackers: [],
            },
            proposal: { decision: 'BUY_AT_MARKET_NOW' },
            evidence: [],
          }),
        ),
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(
      /Reasoning result failed validation/,
    );
  });

  test('unparseable output retries once, then throws instead of fabricating', async () => {
    let calls = 0;
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => {
        calls += 1;
        return completion('I am afraid I cannot do that.');
      },
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(
      /did not return the required JSON contract/,
    );
    // Exactly one repair attempt, then it gives up rather than looping.
    expect(calls).toBe(2);
  });

  test('unparseable output succeeds when the repair round fixes it', async () => {
    let calls = 0;
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? completion('sorry, here goes:')
          : completion(JSON.stringify(VALID_CONTRACT));
      },
    });

    const { result } = await client.evaluateGoat(context);
    expect(result.proposal.decision).toBe('NO_TRADE');
    expect(calls).toBe(2);
  });

  test('an empty completion is a failure, not an empty contract', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        }),
    });

    await expect(client.evaluateGoat(context)).rejects.toThrow(/returned no content/);
  });

  test('a chat question returns prose and never invents a contract', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => completion('Your bias is neutral.'),
    });

    const { answer } = await client.answerQuestion('what is my bias?', context);
    expect(answer).toBe('Your bias is neutral.');
  });
});

describe('GroqClient failure mapping', () => {
  /**
   * Each case must produce a DISTINGUISHABLE message. Collapsing them into one
   * generic error is what makes a fixable configuration mistake look like an
   * outage the user cannot act on.
   */
  test('401 means the key is wrong, not that Groq is down', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'Invalid API Key' } }, 401),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rejected the API key');
  });

  test('429 is reported as a rate limit and marked retryable', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'Rate limit reached' } }, 429),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rate limit');
  });

  test('404 says the model is gone, which is actionable', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'model not found' } }, 404),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not serve model|not one of/);
  });

  test('5xx is reported as provider unavailability', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'upstream boom' } }, 503),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unavailable');
  });

  test('a network error is reported, not swallowed', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  test('a timeout is reported as a timeout', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  test('ApiRequestError carries a retryable flag so callers can decide', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'Rate limit reached' } }, 429),
    });

    const error = await client
      .evaluateGoat(context)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).retryable).toBe(true);
    expect((error as ApiRequestError).code).toBe('RATE_LIMITED');
  });

  test('the connection probe requires the expected confirmation', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => completion('I do not know what you mean.'),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not with the expected confirmation');
  });

  test('a successful probe reports latency and the model actually used', async () => {
    const client = new GroqClient({
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
      fetchImpl: async () => completion('SIGNALGOAT_CONNECTION_OK'),
    });

    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});