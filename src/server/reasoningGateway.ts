/**
 * USER-SCOPED REASONING GATEWAY
 * ============================
 * Resolves the *user's* AI credentials at call time and normalises every
 * provider into one contract.
 *
 * CREDENTIAL SCOPE IS THE WHOLE POINT
 *
 * The gateway, not the client, decides which key to use. One user's key can
 * therefore never become the key used to evaluate another user's GOAT, and no
 * GOAT-scoped component ever holds a credential at all.
 *
 * TWO PROVIDERS, ONE CONTRACT
 *
 * OpenRouter and Groq both implement the same `ReasoningGateway` surface, and
 * both funnel through `parseReasoningResult`. A GOAT's runtime cannot tell
 * which provider answered, so there is exactly one place where provider
 * behaviour could diverge — and it is behind this interface.
 *
 * A PROVIDER FAILURE NEVER BECOMES A SIGNAL
 *
 * With no credential at all, the DEMO result is returned — clearly labelled, and
 * the runtime reports `reasoningMode: 'DEMO'`. That is a deliberate, visible
 * state rather than a hidden degradation.
 *
 * WITH a credential that then fails, the error is thrown. Returning a
 * well-formed NO_TRADE instead would be indistinguishable from the model's own
 * NO_TRADE, so a broken key would silently stop all monitoring while every log
 * line said "no trade".
 */

import {
  GoatReasoningContext,
  OpenRouterClient,
  OpenRouterModel,
} from '../services/ai/OpenRouterClient';
import { GroqClient, DEFAULT_GROQ_MODEL } from '../services/ai/GroqClient';
import { buildDemoReasoningResult, DEMO_CHAT_ANSWER } from '../services/ai/demoReasoning';
import { ReasoningResult } from '../services/agent/contracts';
import { KeyStore } from './repositories';
import { isPlausibleOpenRouterKey } from './credentialValidation';

export type AiProvider = 'openrouter' | 'groq';

/** Normalised catalogue entry, whichever provider served it. */
export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  /** True only when the provider's own metadata says so. Never assumed. */
  free: boolean;
  supportsStructuredOutputs: boolean;
}

/** Connection probe result, identical shape for both providers. */
export interface ProviderTestResult {
  ok: boolean;
  provider: AiProvider;
  model?: string;
  latencyMs: number;
  error?: string;
}

export interface ReasoningGateway {
  /**
   * Runs canonical reasoning for a GOAT. Resolves the owner's credential;
   * when absent, returns the clearly-labelled DEMO deterministic result.
   */
  evaluateGoat(context: GoatReasoningContext, model: string): Promise<ReasoningResult>;

  /** Answers a chat question from the canonical GOAT context. */
  answerGoatQuestion(
    question: string,
    context: GoatReasoningContext,
    model: string,
  ): Promise<string>;

  /** True when the user has configured a usable AI model key. */
  hasKeyFor(userId: string): Promise<boolean>;

  /** The provider that will actually serve this user. */
  providerFor(userId: string): Promise<AiProvider>;

  /**
   * The provider's model catalogue.
   *
   * `source` distinguishes a LIVE catalogue from a hand-maintained list, so a
   * client can present the difference rather than implying both are current.
   */
  listModels(
    userId: string,
  ): Promise<{ models: ProviderModel[]; provider: AiProvider; fetchedAt: number; source: string }>;

  /** Cheap end-to-end probe of the user's own credential. */
  testKeyFor(userId: string): Promise<ProviderTestResult>;

  /** Drops cached clients for a user (called after their key changes). */
  invalidate(userId: string): void;
}

export class UserScopedReasoningGateway implements ReasoningGateway {
  /**
   * key: `${userId}::${provider}::${apiKey}` so rotating a key yields a fresh
   * client while unrelated users never share one.
   */
  private clients = new Map<string, OpenRouterClient | GroqClient>();

  /** Per-user provider choice. Absent means OpenRouter. */
  private providerChoices = new Map<string, AiProvider>();

  constructor(private keys: KeyStore) {}

  /* ---------------------------------------------------------------- */
  /* Credential resolution                                              */
  /* ---------------------------------------------------------------- */

  /**
   * The user's chosen provider.
   *
   * Read from the key store record rather than a request field, so a caller
   * cannot route another user's evaluation through a provider they did not
   * configure.
   */
  async providerFor(userId: string): Promise<AiProvider> {
    const chosen = await this.keys.getProvider?.(userId);
    if (chosen === 'groq' || chosen === 'openrouter') {
      this.providerChoices.set(userId, chosen);
      return chosen;
    }
    return this.providerChoices.get(userId) ?? 'openrouter';
  }

  /** Records the user's provider choice. Called by the settings route. */
  setProviderFor(userId: string, provider: AiProvider): void {
    this.providerChoices.set(userId, provider);
    // A different provider is a different credential and a different client.
    this.invalidate(userId);
  }

  /**
   * Per-user credential for the CHOSEN provider, then the server fallback.
   *
   * One user's key can never become another user's key. A stored value that
   * fails the shape check is IGNORED rather than sent: sending it produces
   * "Missing Authentication header" on every wake, which reads like an outage
   * instead of a bad key.
   */
  private async resolveKey(
    userId: string,
  ): Promise<{ provider: AiProvider; key: string | undefined }> {
    const provider = await this.providerFor(userId);

    if (provider === 'groq') {
      const userKey = await this.keys.getGroqKey?.(userId);
      const serverKey = process.env.GROQ_API_KEY?.trim();
      return {
        provider,
        key: userKey?.trim() || (serverKey ? serverKey : undefined),
      };
    }

    const userKey = await this.keys.getOpenRouterKey(userId);
    if (userKey && isPlausibleOpenRouterKey(userKey)) {
      return { provider, key: userKey.trim() };
    }

    if (userKey) {
      console.warn(
        `[reasoning] Ignoring malformed stored OpenRouter key for user ${userId}. ` +
          'Re-save the key in Settings.',
      );
    }

    const serverKey = process.env.OPENROUTER_API_KEY?.trim();
    return {
      provider,
      key: serverKey && isPlausibleOpenRouterKey(serverKey) ? serverKey : undefined,
    };
  }

  /** Returns a cached client, or null when no credential is configured. */
  private async clientFor(
    userId: string,
  ): Promise<{ provider: AiProvider; client: OpenRouterClient | GroqClient } | null> {
    const { provider, key } = await this.resolveKey(userId);
    if (!key) return null;

    const cacheKey = `${userId}::${provider}::${key}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return { provider, client: cached };

    const client =
      provider === 'groq'
        ? new GroqClient({ apiKey: key })
        : new OpenRouterClient({
            apiKey: key,
            headers: {
              'X-Title': 'SignalGOAT',
              'HTTP-Referer': 'https://signalgoat.app',
            },
          });

    this.clients.set(cacheKey, client);

    // Bound memory: keep at most 32 live credential clients.
    if (this.clients.size > 32) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }

    return { provider, client };
  }

  /* ---------------------------------------------------------------- */
  /* Evaluation                                                        */
  /* ---------------------------------------------------------------- */

  async evaluateGoat(
    context: GoatReasoningContext,
    model: string,
  ): Promise<ReasoningResult> {
    const resolved = await this.clientFor(context.userId);

    /**
     * No credential: return the clearly-labelled deterministic DEMO result
     * instead of pretending a model failed. The runtime reports
     * `reasoningMode: 'DEMO'`, so this is visible rather than silent.
     */
    if (!resolved) {
      return buildDemoReasoningResult(context);
    }

    const { provider, client } = resolved;

    if (provider === 'groq') {
      const groq = client as GroqClient;
      const { result } = await groq.evaluateGoat(context, model || DEFAULT_GROQ_MODEL);
      return result;
    }

    // The client wraps the validated contract in transport metadata.
    const { result } = await (client as OpenRouterClient).evaluateGoat(
      context,
      model,
    );
    return result;
  }

  async answerGoatQuestion(
    question: string,
    context: GoatReasoningContext,
    model: string,
  ): Promise<string> {
    const resolved = await this.clientFor(context.userId);

    if (!resolved) {
      return DEMO_CHAT_ANSWER;
    }

    const { provider, client } = resolved;

    if (provider === 'groq') {
      const groq = client as GroqClient;
      const { answer } = await groq.answerQuestion(question, context, model || DEFAULT_GROQ_MODEL);
      return answer;
    }

    const answer = await (client as OpenRouterClient).answerQuestion(
      context,
      question,
      model,
    );
    return answer.answer;
  }

  async hasKeyFor(userId: string): Promise<boolean> {
    const { key } = await this.resolveKey(userId);
    return key !== undefined;
  }

  async listModels(
    userId: string,
  ): Promise<{
    models: ProviderModel[];
    provider: AiProvider;
    fetchedAt: number;
    source: string;
  }> {
    const resolved = await this.clientFor(userId);

    if (!resolved) {
      throw new Error(
        'No AI provider is configured. Add a key in Settings to load models.',
      );
    }

    const { provider, client } = resolved;

    if (provider === 'groq') {
      const catalogue = (client as GroqClient).listModels();
      return {
        provider,
        fetchedAt: Date.now(),
        source: catalogue.source,
        models: catalogue.models.map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          free: model.freeTier,
          supportsStructuredOutputs: model.supportsStructuredOutputs,
        })),
      };
    }

    const catalogue = await (client as OpenRouterClient).fetchModels();
    const models: OpenRouterModel[] = catalogue.models;

    return {
      provider,
      fetchedAt: catalogue.fetchedAt,
      source: catalogue.source,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        /**
         * Taken from OpenRouter's own pricing metadata. A `:free` suffix is
         * never used to infer this, because the suffix and the price
         * disagree often enough to mislead a user about cost.
         */
        free: model.free,
        supportsStructuredOutputs: model.supportsStructuredOutputs,
      })),
    };
  }

  async testKeyFor(userId: string): Promise<ProviderTestResult> {
    const provider = await this.providerFor(userId);
    const resolved = await this.clientFor(userId);

    if (!resolved) {
      return {
        ok: false,
        provider,
        latencyMs: 0,
        error: `No ${provider} API key configured for this account.`,
      };
    }

    if (resolved.provider === 'groq') {
      const result = await (resolved.client as GroqClient).testConnection();
      return { ...result, provider: 'groq' };
    }

    const result = await (resolved.client as OpenRouterClient).testConnection();
    return { ...result, provider: 'openrouter' };
  }

  invalidate(userId: string): void {
    const prefix = `${userId}::`;
    for (const cacheKey of this.clients.keys()) {
      if (cacheKey.startsWith(prefix)) this.clients.delete(cacheKey);
    }
  }
}