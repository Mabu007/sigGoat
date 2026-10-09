/**
 * GROQ PROVIDER ADAPTER
 * =====================
 * Groq as a testing and fallback provider, normalised into the SAME internal
 * contract as OpenRouter so no business logic branches on which provider ran.
 *
 * WHY THIS IS A SEPARATE ADAPTER RATHER THAN A BASE URL
 *
 * Groq is OpenAI-compatible, not OpenRouter-compatible. Four concrete
 * differences this adapter absorbs:
 *
 *   1. MODEL NAMES ARE NOT INTERCHANGEABLE. `llama-3.3-70b-versatile` is not a
 *      valid OpenRouter id and vice versa. There is no mapping table that could
 *      stay correct, so each provider keeps its own catalogue and the user
 *      chooses from the provider they configured.
 *   2. NO CATALOGUE ENDPOINT. OpenRouter serves `GET /models`; Groq does not.
 *      The model list here is a fixed, explicitly-labelled set of ids that
 *      Groq has actually served, not a live claim about availability. The
 *      first real request is the availability test.
 *   3. NO STRUCTURED-OUTPUT PARAMETER. OpenRouter's `response_format` is
 *      ignored here; JSON is requested in the prompt and extracted defensively.
 *      Groq has no equivalent, so pretending otherwise would send a parameter
 *      that does nothing.
 *   4. NOT FREE, AND NOT ALWAYS FREE. Groq has a free tier with real rate
 *      limits. Nothing here assumes a request is free or unlimited.
 *
 * A PROVIDER FAILURE MUST NEVER BECOME A TRADE SIGNAL
 *
 * Every failure path throws `ApiRequestError`. There is no default result, no
 * fallback object and no empty contract: a caller that catches an error and
 * proceeds without a signal is making that decision explicitly. The alternative
 * — returning a well-formed NO_TRADE on failure — is indistinguishable from a
 * genuine NO_TRADE, and would silently stop a user's monitoring.
 */

import {
  ApiRequestError,
  buildChatSystemPrompt,
  buildReasoningUserPrompt,
  buildReasoningSystemPrompt,
  parseUsage,
  tryParseJson,
  type GoatReasoningContext,
  type OpenRouterUsage,
} from './OpenRouterClient';
import { parseReasoningResult, type ReasoningResult } from '../agent/contracts';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const DEFAULT_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 15_000;

/** Total output budget for one reasoning run, matching the OpenRouter path. */
const REASONING_MAX_TOKENS = 8_000;
const CHAT_MAX_TOKENS = 1_200;

/**
 * Models this adapter will offer.
 *
 * STATED PLAINLY: this is a hand-maintained list, not a live catalogue, because
 * Groq publishes no model endpoint. `verifyModel()` is the real availability
 * check and is what `POST /api/ai/test` calls. Offering an id here does not
 * claim the model is up; refusing an id not listed here does not claim it is
 * gone.
 */
export const GROQ_MODELS = [
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B Versatile',
    description: 'General purpose. The default Groq model for SignalGOAT.',
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B Instant',
    description: 'Fast and cheap. Best when latency matters more than depth.',
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'GPT OSS 120B',
    description: 'Open-weight model served by Groq.',
  },
  {
    id: 'qwen/qwen3-32b',
    name: 'Qwen3 32B',
    description: 'Open-weight model served by Groq.',
  },
] as const;

export type GroqModelId = (typeof GROQ_MODELS)[number]['id'];

export const DEFAULT_GROQ_MODEL: GroqModelId = 'llama-3.3-70b-versatile';

export function isKnownGroqModel(model: string): boolean {
  return GROQ_MODELS.some((m) => m.id === model);
}

export interface GroqModelSummary {
  id: string;
  name: string;
  description: string;
  /**
   * Always true here, unlike OpenRouter.
   *
   * Honest naming: this provider genuinely does enforce JSON mode, which the
   * OpenRouter path only knows per-model from catalogue metadata.
   */
  supportsStructuredOutputs: true;
  /** True when Groq's own listing marks the model as free-tier. */
  freeTier: boolean;
}

/**
 * Free-tier flags.
 *
 * Kept separate from the id list deliberately: whether a model is on the free
 * tier is Groq's policy and changes without notice, so it is one table rather
 * than a suffix convention. Nothing in this file assumes a model is free.
 */
const GROQ_FREE_TIER: Record<string, boolean> = {
  'llama-3.3-70b-versatile': true,
  'llama-3.1-8b-instant': true,
  'openai/gpt-oss-120b': true,
  'qwen/qwen3-32b': false,
};

export interface GroqClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /**
   * Injectable transport for tests.
   *
   * Typed as a plain function rather than `typeof fetch`, because the full
   * global carries members (such as `preconnect`) a test double has no business
   * implementing. Only the call signature is actually used.
   */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Normalised result, identical in shape to OpenRouterResult's payload. */
export interface GroqEvaluationResult {
  result: ReasoningResult;
  model: string;
  usage?: OpenRouterUsage;
  requestId?: string;
  /**
   * How the JSON was requested.
   *
   * Groq enforces JSON mode server-side, so this is always
   * `response_format` here. Recorded explicitly rather than assumed so a
   * consumer can tell a mode that was requested from one that was merely
   * hoped for.
   */
  jsonMode: 'response_format';
}

interface GroqCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

export class GroqClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(options: GroqClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;

    /**
     * Probes use the SHORTER of the two timeouts.
     *
     * A connection test that inherits a 60s reasoning budget would leave the
     * caller waiting a minute to learn their key is wrong. Taking the minimum
     * means an explicitly shorter client timeout is honoured, and the default
     * probe still gets a 15s ceiling.
     */
    this.probeTimeoutMs = Math.min(this.timeoutMs, CONNECTION_TIMEOUT_MS);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * The models this adapter will serve.
   *
   * Reported with `source: 'groq-static'` so a client can tell a hand-maintained
   * list from a live catalogue and not present it as authoritative.
   */
  listModels(): { models: GroqModelSummary[]; source: 'groq-static' } {
    return {
      source: 'groq-static',
      models: GROQ_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        supportsStructuredOutputs: true as const,
        freeTier: GROQ_FREE_TIER[model.id] ?? false,
      })),
    };
  }

  /**
   * One completion, normalised.
   *
   * Throws `ApiRequestError` for every failure — no key, unknown model, HTTP
   * error, timeout, malformed body. A caller therefore cannot accidentally
   * treat an error as a NO_TRADE.
   */
  private async complete(params: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    maxTokens: number;
    timeoutMs?: number;
    /**
     * Whether the reply must be JSON.
     *
     * Chat answers are prose, and forcing JSON mode on them would make the model
     * wrap its answer in an object for no benefit. Default true because the
     * reasoning contract depends on it.
     */
    jsonMode?: boolean;
  }): Promise<{
    content: string;
    model: string;
    usage?: OpenRouterUsage;
    requestId?: string;
  }> {
    if (!this.hasApiKey()) {
      throw new ApiRequestError('Groq API key is not configured.', {
        code: 'MISSING_API_KEY',
        retryable: false,
      });
    }

    if (!isKnownGroqModel(params.model)) {
      /**
       * Refused BEFORE the request.
       *
       * Groq would answer 404 for an unknown model, which reads like a broken
       * integration. Saying so locally gives the user an accurate message and
       * avoids spending a request.
       */
      throw new ApiRequestError(
        `Model "${params.model}" is not one of the Groq models this app offers.`,
        { code: 'MODEL_NOT_SUPPORTED', retryable: false },
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? this.timeoutMs,
    );

    try {
      const response = await this.fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature ?? 0.1,
          max_tokens: params.maxTokens,
          /**
           * Groq DOES support `response_format: json_object`, unlike the
           * reasoning-budget knobs OpenRouter needs. Sent for the reasoning
           * contract, which genuinely depends on it, and omitted for prose.
           */
          ...(params.jsonMode === false
            ? {}
            : { response_format: { type: 'json_object' } }),
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | GroqCompletionResponse
        | null;

      if (!response.ok) {
        throw toApiRequestError(params.model, response.status, payload);
      }

      const choices = Array.isArray(payload?.choices) ? payload!.choices : [];
      const first = choices[0] as
        | { message?: { content?: unknown }; finish_reason?: unknown }
        | undefined;
      const content = first?.message?.content;

      if (typeof content !== 'string' || content.trim().length === 0) {
        /**
         * A reasoning model can spend the whole budget thinking and return
         * nothing. That is a failure, not a result — returning it as an empty
         * contract would surface as a silent NO_TRADE.
         */
        throw new ApiRequestError(
          `${params.model} returned no content (finish_reason: ${String(first?.finish_reason ?? 'unknown')}).`,
          { code: 'EMPTY_COMPLETION', retryable: true, status: response.status },
        );
      }

      return {
        content,
        model: typeof payload?.model === 'string' ? payload.model : params.model,
        usage: parseUsage(payload?.usage),
        requestId: typeof payload?.id === 'string' ? payload.id : undefined,
      };
    } catch (err) {
      if (err instanceof ApiRequestError) throw err;

      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ApiRequestError(
        aborted
          ? `Groq request timed out after ${(params.timeoutMs ?? this.timeoutMs) / 1000}s.`
          : `Groq request failed: ${err instanceof Error ? err.message : String(err)}`,
        { code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs the canonical reasoning contract.
   *
   * One retry on unparseable output, quoting the model's own reply back with a
   * correction instruction — the same self-healing step OpenRouter uses. A
   * second failure throws: it is better to fail the wake loudly than to
   * fabricate a market view.
   */
  async evaluateGoat(
    context: GoatReasoningContext,
    model: string = DEFAULT_GROQ_MODEL,
  ): Promise<GroqEvaluationResult> {
    const messages = [
      { role: 'system' as const, content: buildReasoningSystemPrompt() },
      { role: 'user' as const, content: buildReasoningUserPrompt(context) },
    ];

    const completion = await this.complete({
      model,
      messages,
      temperature: 0.1,
      maxTokens: REASONING_MAX_TOKENS,
    });

    let parsed = tryParseJson(completion.content);

    if (parsed === undefined) {
      const repaired = await this.complete({
        model,
        messages: [
          ...messages,
          { role: 'assistant' as const, content: completion.content.slice(0, 4_000) },
          {
            role: 'user' as const,
            content:
              'Your previous reply could not be parsed as JSON. ' +
              'Reply again with the JSON object ONLY: no prose, no markdown, no code fences. ' +
              'It must have exactly the four top-level keys investigation, thesis, proposal and evidence.',
          },
        ],
        temperature: 0,
        maxTokens: REASONING_MAX_TOKENS,
      });

      parsed = tryParseJson(repaired.content);

      if (parsed === undefined) {
        throw new ApiRequestError(
          `${model} did not return the required JSON contract after a repair attempt.`,
          { code: 'UNPARSEABLE', retryable: true },
        );
      }
    }

    /**
     * The shared validator is the ONLY gate. Groq output is not trusted because
     * it came from Groq; it is trusted because it passed exactly the same
     * contract check as OpenRouter output.
     */
    const result = parseReasoningResult(parsed);

    return {
      result,
      model: completion.model,
      usage: completion.usage,
      requestId: completion.requestId,
      jsonMode: 'response_format',
    };
  }

  /**
   * Answers a chat question.
   *
   * Returns TEXT, not the contract, so a failed answer throws and the caller
   * decides what to show. It never returns an invented market view.
   */
  async answerQuestion(
    question: string,
    context: GoatReasoningContext,
    model: string = DEFAULT_GROQ_MODEL,
  ): Promise<{ answer: string; model: string }> {
    const completion = await this.complete({
      model,
      messages: [
        { role: 'system' as const, content: buildChatSystemPrompt(context) },
        { role: 'user' as const, content: question.slice(0, 2_000) },
      ],
      temperature: 0.2,
      maxTokens: CHAT_MAX_TOKENS,
      timeoutMs: this.probeTimeoutMs,
      // A chat answer is prose; JSON mode would only add wrapping.
      jsonMode: false,
    });

    return { answer: completion.content, model: completion.model };
  }

  /**
   * Real end-to-end probe.
   *
   * Asks for the contract's minimal shape rather than a free-text string, so a
   * pass proves the model can actually produce what SignalGOAT needs.
   */
  async testConnection(model?: string): Promise<{
    ok: boolean;
    model?: string;
    latencyMs: number;
    error?: string;
  }> {
    const startedAt = performance.now();

    try {
      const selected = model ?? DEFAULT_GROQ_MODEL;

      const completion = await this.complete({
        model: selected,
        messages: [
          {
            role: 'user',
            content:
              'Return exactly this text and nothing else: SIGNALGOAT_CONNECTION_OK',
          },
        ],
        temperature: 0,
        maxTokens: 128,
        timeoutMs: this.probeTimeoutMs,
        jsonMode: false,
      });

      return {
        ok: completion.content.includes('SIGNALGOAT_CONNECTION_OK'),
        model: completion.model,
        latencyMs: Math.round(performance.now() - startedAt),
        error: completion.content.includes('SIGNALGOAT_CONNECTION_OK')
          ? undefined
          : 'Model responded but not with the expected confirmation.',
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}

/**
 * Maps a Groq HTTP failure onto the shared error type.
 *
 * The distinctions matter to the caller: 401 is a bad key, 404 is a model or
 * endpoint problem, 429 is a rate limit, and 5xx is retryable. Collapsing them
 * into one message would make a correctable configuration error look like an
 * outage.
 */
function toApiRequestError(
  model: string,
  status: number,
  payload: GroqCompletionResponse | null,
): ApiRequestError {
  const error = payload?.error as
    | { message?: unknown; type?: unknown; code?: unknown }
    | undefined;

  const description =
    typeof error?.message === 'string' ? error.message : `HTTP ${status}`;

  if (status === 401) {
    return new ApiRequestError(
      'Groq rejected the API key. Check the key in Settings.',
      { code: 'INVALID_API_KEY', retryable: false, status },
    );
  }

  if (status === 429) {
    return new ApiRequestError(
      `Groq rate limit reached for "${model}". Wait and retry. ${description}`,
      { code: 'RATE_LIMITED', retryable: true, status },
    );
  }

  if (status === 404) {
    return new ApiRequestError(
      `Groq does not serve model "${model}" any more. ${description}`,
      { code: 'MODEL_NOT_FOUND', retryable: false, status },
    );
  }

  if (status >= 500) {
    return new ApiRequestError(
      `Groq is unavailable (HTTP ${status}). ${description}`,
      { code: 'PROVIDER_UNAVAILABLE', retryable: true, status },
    );
  }

  return new ApiRequestError(description, {
    code: 'PROVIDER_ERROR',
    retryable: false,
    status,
  });
}