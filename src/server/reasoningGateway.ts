/**
 * REASONING GATEWAY
 * ==================
 * The GoatDurableObject depends on this interface, never on
 * OpenRouterClient directly. The gateway resolves the *user's* API key at
 * call time (GOAT-scoped credentials: one user's key can never become the
 * key used by every GOAT on the server).
 *
 * Clients are cached per resolved credential. OpenRouterClient holds the
 * live model catalogue in memory (TTL 60s); without this cache every wake,
 * chat message and catalogue request would refetch ~700 models.
 */

import { GoatReasoningContext, OpenRouterClient, OpenRouterModel } from '../services/ai/OpenRouterClient';
import { buildDemoReasoningResult, DEMO_CHAT_ANSWER } from '../services/ai/demoReasoning';
import { ReasoningResult } from '../services/agent/contracts';
import { KeyStore } from './repositories';
import { isPlausibleOpenRouterKey } from './credentialValidation';

export interface ReasoningGateway {
  /**
   * Runs canonical reasoning for a GOAT. Resolves the owner's OpenRouter
   * key; when absent, OpenRouterClient returns the clearly-labelled DEMO
   * deterministic result.
   */
  evaluateGoat(context: GoatReasoningContext, model: string): Promise<ReasoningResult>;

  /** Answers a chat question from the canonical GOAT context. */
  answerGoatQuestion(question: string, context: GoatReasoningContext, model: string): Promise<string>;

  /** True when the user has configured an AI model key (drives UI state). */
  hasKeyFor(userId: string): Promise<boolean>;

  /**
   * Live OpenRouter model catalogue for the user's resolved key.
   * Rejects with ApiRequestError(MISSING_API_KEY) when no key is configured.
   */
  listModels(userId: string): Promise<{ models: OpenRouterModel[]; fetchedAt: number }>;

  /** Cheap end-to-end probe of the user's key against a real completion. */
  testKeyFor(userId: string): Promise<{
    ok: boolean;
    model?: string;
    latencyMs: number;
    error?: string;
  }>;

  /** Drops cached clients for a user (called after their key changes). */
  invalidate(userId: string): void;
}

export class UserScopedReasoningGateway implements ReasoningGateway {
  /**
   * key: `${userId}::${apiKey}` so rotating a key yields a fresh client
   * (and therefore a fresh catalogue) while unrelated users never share one.
   */
  private clients = new Map<string, OpenRouterClient>();

  constructor(private keys: KeyStore) {}

  /**
   * Per-user key first; server-wide OPENROUTER_API_KEY as fallback.
   * One user's key can never become the key used for another user.
   *
   * A stored value that fails the credential shape check is IGNORED, not
   * sent. Sending it produces OpenRouter's misleading "Missing
   * Authentication header" on every wake, which looks like an outage rather
   * than a bad key. Ignoring it falls back cleanly and lets the UI report
   * "no usable key configured".
   */
  private async resolveKey(userId: string): Promise<string | undefined> {
    const userKey = await this.keys.getOpenRouterKey(userId);
    if (userKey && isPlausibleOpenRouterKey(userKey)) {
      return userKey.trim();
    }

    if (userKey) {
      console.warn(
        `[reasoning] Ignoring malformed stored OpenRouter key for user ${userId}. ` +
          'Re-save the key in Settings.',
      );
    }

    const serverKey = process.env.OPENROUTER_API_KEY?.trim();
    return serverKey && isPlausibleOpenRouterKey(serverKey)
      ? serverKey
      : undefined;
  }

  /** Returns a cached client, or null when no credential is configured. */
  private async clientFor(userId: string): Promise<OpenRouterClient | null> {
    const key = await this.resolveKey(userId);
    if (!key) return null;

    const cacheKey = `${userId}::${key}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const client = new OpenRouterClient({
      apiKey: key,
      headers: { 'X-Title': 'SignalGOAT', 'HTTP-Referer': 'https://signalgoat.app' },
    });
    this.clients.set(cacheKey, client);

    // Bound memory: keep at most 32 live credential clients.
    if (this.clients.size > 32) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }

    return client;
  }

  private requireClientFor(userId: string): Promise<OpenRouterClient> {
    return this.clientFor(userId).then((client) => {
      if (!client) {
        throw new Error(
          'No OpenRouter API key is configured. Add your key in Settings to enable AI reasoning.',
        );
      }
      return client;
    });
  }

  async evaluateGoat(context: GoatReasoningContext, model: string): Promise<ReasoningResult> {
    const client = await this.clientFor(context.userId);

    /**
     * No credential configured: return the clearly-labelled deterministic
     * DEMO NO_TRADE result instead of pretending a model failed. The runtime
     * already labels this state `reasoningMode: 'DEMO'`.
     */
    if (!client) {
      return buildDemoReasoningResult(context);
    }

    // OpenRouterClient wraps the validated contract in transport metadata
    // (usage, latency, requestId); callers want the contract itself.
    const { result } = await client.evaluateGoat(context, model);
    return result;
  }

  async answerGoatQuestion(question: string, context: GoatReasoningContext, model: string): Promise<string> {
    const client = await this.clientFor(context.userId);

    if (!client) {
      return DEMO_CHAT_ANSWER;
    }

    const answer = await client.answerQuestion(context, question, model);
    return answer.answer;
  }

  async hasKeyFor(userId: string): Promise<boolean> {
    return (await this.resolveKey(userId)) !== undefined;
  }

  async listModels(userId: string): Promise<{ models: OpenRouterModel[]; fetchedAt: number }> {
    const client = await this.requireClientFor(userId);
    const catalogue = await client.fetchModels();
    return { models: catalogue.models, fetchedAt: catalogue.fetchedAt };
  }

  async testKeyFor(userId: string): Promise<{
    ok: boolean;
    model?: string;
    latencyMs: number;
    error?: string;
  }> {
    const client = await this.clientFor(userId);
    if (!client) {
      return { ok: false, latencyMs: 0, error: 'No OpenRouter API key configured for this account.' };
    }
    return client.testConnection();
  }

  invalidate(userId: string): void {
    const prefix = `${userId}::`;
    for (const cacheKey of this.clients.keys()) {
      if (cacheKey.startsWith(prefix)) this.clients.delete(cacheKey);
    }
  }
}
