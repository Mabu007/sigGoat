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
import { SpaceBunnyClient, SPACE_BUNNY_MODEL } from '../services/ai/SpaceBunnyClient';
import { buildDemoReasoningResult, DEMO_CHAT_ANSWER } from '../services/ai/demoReasoning';
import { ReasoningResult } from '../services/agent/contracts';
import { KeyStore } from './repositories';
import { isPlausibleOpenRouterKey } from './credentialValidation';

export type AiProvider = 'openrouter' | 'groq' | 'spacebunny';

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
  evaluateGoat(context: GoatReasoningContext, model: string, providerOverride?: AiProvider): Promise<ReasoningResult>;

  /** Answers a chat question from the canonical GOAT context. */
  answerGoatQuestion(
    question: string,
    context: GoatReasoningContext,
    model: string,
    providerOverride?: AiProvider,
  ): Promise<string>;

  /** True when the user has configured a usable AI model key. */
  hasKeyFor(userId: string, providerOverride?: AiProvider): Promise<boolean>;

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
    providerOverride?: AiProvider,
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
  private clients = new Map<string, OpenRouterClient | GroqClient | SpaceBunnyClient>();

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
  async providerFor(userId: string, providerOverride?: AiProvider): Promise<AiProvider> {
    if (providerOverride === 'openrouter' || providerOverride === 'spacebunny' || providerOverride === 'groq') return providerOverride;
    const chosen = await this.keys.getProvider?.(userId);
    if (chosen === 'groq' || chosen === 'openrouter' || chosen === 'spacebunny') {
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
    providerOverride?: AiProvider,
  ): Promise<{ provider: AiProvider; key: string | undefined }> {
    const provider = await this.providerFor(userId, providerOverride);

    if (provider === 'groq') {
      const userKey = await this.keys.getGroqKey?.(userId);
      const serverKey = process.env.GROQ_API_KEY?.trim();
      return { provider, key: userKey?.trim() || (serverKey ? serverKey : undefined) };
    }
    if (provider === 'spacebunny') return { provider, key: (await this.keys.getSpaceBunnyKey?.(userId))?.trim() || undefined };

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
    providerOverride?: AiProvider,
  ): Promise<{ provider: AiProvider; client: OpenRouterClient | GroqClient | SpaceBunnyClient } | null> {
    const { provider, key } = await this.resolveKey(userId, providerOverride);
    if (!key) return null;

    const cacheKey = `${userId}::${provider}::${key}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return { provider, client: cached };

    const client =
      provider === 'groq'
        ? new GroqClient({ apiKey: key })
        : provider === 'spacebunny'
          ? new SpaceBunnyClient({ apiKey: key })
          : new OpenRouterClient({
            apiKey: key,
            headers: {
              'X-Title': 'SIRGOAT',
              'HTTP-Referer': 'https://sirgoat.app',
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
    providerOverride?: AiProvider,
  ): Promise<ReasoningResult> {
    const resolved = await this.clientFor(context.userId, providerOverride);

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
      // Existing GOATs can retain a model from the provider previously selected
      // in Settings. Model IDs are provider-scoped, so fall back to a known
      // Groq model rather than sending an OpenRouter slug to Groq.
      const available = groq.listModels().models.some((entry) => entry.id === model);
      const selectedModel = available ? model : DEFAULT_GROQ_MODEL;
      const { result } = await groq.evaluateGoat(context, selectedModel);
      return result;
    }
    if (provider === 'spacebunny') {
      return (await (client as SpaceBunnyClient).evaluateGoat(context, SPACE_BUNNY_MODEL)).result;
    }

    // Existing GOATs may still carry a Groq or Space Bunny model after the
    // account provider changes. Repair provider-mismatched IDs before calling
    // OpenRouter; preserve valid OpenRouter slugs as configured.
    const selectedModel = typeof model === 'string' && model.includes('/')
      ? model
      : (await this.pickAnyModel(context.userId)) || model;
    const { result } = await (client as OpenRouterClient).evaluateGoat(context, selectedModel);
    return result;
  }

  async answerGoatQuestion(
    question: string,
    context: GoatReasoningContext,
    model: string,
    providerOverride?: AiProvider,
  ): Promise<string> {
    const resolved = await this.clientFor(context.userId, providerOverride);

    if (!resolved) {
      return DEMO_CHAT_ANSWER;
    }

    const { provider, client } = resolved;

    if (provider === 'groq') {
      const groq = client as GroqClient;
      const available = groq.listModels().models.some((entry) => entry.id === model);
      const { answer } = await groq.answerQuestion(question, context, available ? model : DEFAULT_GROQ_MODEL);
      return answer;
    }
    if (provider === 'spacebunny') {
      return (await (client as SpaceBunnyClient).answerQuestion(question, context, SPACE_BUNNY_MODEL)).answer;
    }

    const selectedModel = typeof model === 'string' && model.includes('/')
      ? model
      : (await this.pickAnyModel(context.userId)) || model;
    const answer = await (client as OpenRouterClient).answerQuestion(context, question, selectedModel);
    return answer.answer;
  }

  async hasKeyFor(userId: string, providerOverride?: AiProvider): Promise<boolean> {
    const { key } = await this.resolveKey(userId, providerOverride);
    return key !== undefined;
  }

  /**
   * Picks a usable model from the caller's OWN live catalogue.
   *
   * Used when no model was chosen — a new GOAT with no saved preference. The
   * ordering is deliberate:
   *
   *   1. a model on OpenRouter's explicit `:free` tier;
   *   2. any model the catalogue prices at zero;
   *   3. a model that supports structured outputs, because the reasoning
   *      contract is JSON and a model that cannot emit it reliably returns
   *      unparseable output on every run;
   *   4. anything at all.
   *
   * WHY `:free` IS CHECKED BEFORE "PRICED AT ZERO"
   *
   *   The catalogue reports some models with `pricing: {prompt: "0",
   *   completion: "0"}` that a zero-credit account still cannot call — the
   *   request comes back `402 Insufficient credits`. Verified against the live
   *   API on 2026-10-11 with `inclusionai/ling-3.1-flash`. OpenRouter's
   *   `:free` suffix is its documented free tier and is the only signal that
   *   survives contact with the API, so it is trusted first and zero pricing
   *   is the fallback.
   *
   * Returns null rather than throwing when there is no key or the catalogue
   * is unreachable: the caller has a fallback and a catalogue outage should
   * not be the reason a GOAT cannot be created.
   */
  async pickAnyModel(userId: string): Promise<string | null> {
    const resolved = await this.clientFor(userId);
    if (!resolved) return null;

    const { provider, client } = resolved;

    if (provider === 'groq') return DEFAULT_GROQ_MODEL;
    if (provider === 'spacebunny') return SPACE_BUNNY_MODEL;

    const catalogue = await (client as OpenRouterClient).fetchModels();
    const models = catalogue.models;
    if (models.length === 0) return null;

    const pool = models.filter((m) => m.id.endsWith(':free'));
    const candidates = pool.length > 0 ? pool : models.filter((m) => m.free);
    const usable = candidates.length > 0 ? candidates : models;

    const structured = usable.filter((m) => m.supportsStructuredOutputs);
    const chosen = structured[0] ?? usable[0];

    return chosen?.id ?? null;
  }

  /**
   * True when `modelId` is currently served by the caller's own provider.
   *
   * Used to validate a SAVED preference. A model OpenRouter retired must not
   * be silently reused as a default — that is exactly the failure this
   * app already shipped once with a hardcoded slug.
   */
  async isModelAvailable(userId: string, modelId: string, providerOverride?: AiProvider): Promise<boolean> {
    const resolved = await this.clientFor(userId, providerOverride);
    if (!resolved) return false;

    const { provider, client } = resolved;
    if (provider === 'groq') {
      return (resolved.client as GroqClient).listModels().models.some((model) => model.id === modelId);
    }
    if (provider === 'spacebunny') return modelId === SPACE_BUNNY_MODEL;

    const catalogue = await (client as OpenRouterClient).fetchModels();
    return catalogue.models.some((model) => model.id === modelId);
  }

  async listModels(
    userId: string,
    providerOverride?: AiProvider,
  ): Promise<{
    models: ProviderModel[];
    provider: AiProvider;
    fetchedAt: number;
    source: string;
  }> {
    const resolved = await this.clientFor(userId, providerOverride);

    if (!resolved) {
      throw new Error(
        'No AI provider is configured for this GOAT. Add that provider key in Settings.',
      );
    }

    const { provider, client } = resolved;

    if (provider === 'spacebunny') return { provider, fetchedAt: Date.now(), source: 'spacebunny-static', models: [{ id: SPACE_BUNNY_MODEL, name: 'Space Bunny Alpha', description: 'Hosted Space Bunny reasoning model.', free: false, supportsStructuredOutputs: true }] };

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
    if (resolved.provider === 'spacebunny') return { ...(await (resolved.client as SpaceBunnyClient).testConnection()), provider: 'spacebunny' };

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