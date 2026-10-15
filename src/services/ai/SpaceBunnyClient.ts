/**
 * SPACE BUNNY HOSTED API ADAPTER
 * =============================
 * Space Bunny exposes an OpenAI-compatible chat-completions endpoint. This
 * adapter normalises it into the same validated SIRGOAT reasoning contract as
 * the OpenRouter and Groq adapters. The API key is supplied server-side only.
 */
import {
  ApiRequestError,
  buildChatSystemPrompt,
  buildReasoningUserPrompt,
  buildReasoningSystemPrompt,
  tryParseJson,
  type GoatReasoningContext,
} from './OpenRouterClient';
import { parseReasoningResult, type ReasoningResult } from '../agent/contracts';

export const SPACE_BUNNY_MODEL = 'space-bunny-alpha';
const BASE_URL = 'https://spacebunnymodel.com/api/v1';
const REQUEST_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const REASONING_MAX_TOKENS = 3072;

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export class SpaceBunnyClient {
  private readonly apiKey: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(options: { apiKey: string; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> }) {
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async complete(model: string, messages: Message[], maxTokens: number, timeoutMs = REQUEST_TIMEOUT_MS, json = true): Promise<string> {
    if (!this.apiKey) throw new ApiRequestError('Space Bunny API key is not configured.', { code: 'MISSING_API_KEY' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: model || SPACE_BUNNY_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature: json ? 0.1 : 0.2,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as any;
      if (!response.ok) {
        const detail = typeof payload?.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
        const message = response.status === 401
          ? 'Space Bunny rejected this API key. Check the key in Settings.'
          : response.status === 402
            ? 'Space Bunny credits are insufficient. Check your prepaid balance.'
            : response.status === 429
              ? 'Space Bunny rate limit reached. Wait and retry.'
              : `Space Bunny API failed (${response.status}): ${detail}`;
        throw new ApiRequestError(message, {
          status: response.status,
          code: response.status === 401 ? 'INVALID_API_KEY' : response.status === 402 ? 'INSUFFICIENT_CREDITS' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new ApiRequestError('Space Bunny returned an empty response.', { code: 'EMPTY_RESPONSE', retryable: true });
      }
      return text.trim();
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiRequestError('Space Bunny request timed out.', { code: 'TIMEOUT', retryable: true });
      }
      throw new ApiRequestError(error instanceof Error ? error.message : 'Could not reach Space Bunny.', { code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  async evaluateGoat(context: GoatReasoningContext, _model = SPACE_BUNNY_MODEL): Promise<{ result: ReasoningResult; model: string }> {
    const messages: Message[] = [
      { role: 'system', content: buildReasoningSystemPrompt() },
      { role: 'user', content: buildReasoningUserPrompt(context) },
    ];
    let raw = await this.complete(SPACE_BUNNY_MODEL, messages, REASONING_MAX_TOKENS);
    let parsed = tryParseJson(raw);
    // A historical replay has a strict serverless time budget. Do not spend a
    // second provider request repairing malformed output; fail the replay clearly.
    if (parsed === undefined && context.wakeReason?.startsWith('BACKTEST_')) {
      throw new ApiRequestError('Space Bunny returned invalid JSON during backtesting; retry the backtest or use a shorter period.', { code: 'BACKTEST_INVALID_JSON', retryable: true });
    }
    if (parsed === undefined) {
      raw = await this.complete(SPACE_BUNNY_MODEL, [
        ...messages,
        { role: 'assistant', content: raw.slice(0, 4000) },
        { role: 'user', content: 'Return ONLY a valid JSON object with exactly the four top-level keys investigation, thesis, proposal and evidence. No markdown or prose.' },
      ], REASONING_MAX_TOKENS);
      parsed = tryParseJson(raw);
    }
    if (parsed === undefined) throw new ApiRequestError('Space Bunny did not return the required JSON reasoning contract after a repair attempt.', { code: 'UNPARSEABLE', retryable: true });
    return { result: parseReasoningResult(parsed), model: SPACE_BUNNY_MODEL };
  }

  async answerQuestion(question: string, context: GoatReasoningContext, _model = SPACE_BUNNY_MODEL): Promise<{ answer: string; model: string }> {
    const answer = await this.complete(SPACE_BUNNY_MODEL, [
      { role: 'system', content: buildChatSystemPrompt(context) },
      { role: 'user', content: question.slice(0, 2000) },
    ], 2048, REQUEST_TIMEOUT_MS, false);
    return { answer, model: SPACE_BUNNY_MODEL };
  }

  async testConnection(): Promise<{ ok: boolean; model?: string; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const response = await this.complete(SPACE_BUNNY_MODEL, [
        { role: 'user', content: 'Return exactly this text and nothing else: SIRGOAT_SPACE_BUNNY_CONNECTION_OK' },
      ], 128, PROBE_TIMEOUT_MS, false);
      const ok = response.includes('SIRGOAT_SPACE_BUNNY_CONNECTION_OK');
      return { ok, model: SPACE_BUNNY_MODEL, latencyMs: Date.now() - started, error: ok ? undefined : 'Model responded but did not return the expected confirmation.' };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'Unknown Space Bunny error.' };
    }
  }
}
