/**
 * SIGNALGOAT API ROUTER
 * ======================
 * Every protected route: authMiddleware -> ownership check -> handler.
 * Identity comes from the verified token, never from the request body.
 *
 * Persistence: goats/skills/signals/theses/wakeEvents via the PersistenceLayer
 * (Firestore in production, file-backed JSON for self-hosted, in-memory tests).
 * Runtime state lives in the GOAT actor registry and is rebuilt from
 * persistence on boot (restart recovery).
 */

import express, { Request, Response, NextFunction } from 'express';
import { SignalGoat, GoatSchedule, GoatRuntimeState, TradeSignal } from '../types';
import { authMiddleware, requireUser, resolveAuthMode } from './auth';
import { getFirebaseAdminFailureReason } from './firebaseAdmin';
import {
  CredentialValidationError,
  isPlausibleOpenRouterKey,
  normaliseOpenRouterKey,
  normaliseTelegramToken,
} from './credentialValidation';
import {
  createPersistence,
  PersistenceLayer,
  NotFoundError,
} from './repositories';
import { UserScopedReasoningGateway } from './reasoningGateway';
import { buildGoatContext } from './goatContext';
import { durableObjectRegistry } from '../services/durable-object/DurableObjectRegistry';
import { normaliseSchedule, describeSchedule } from '../services/durable-object/GoatDurableObject';
import { paperProvider } from '../services/market-data/PaperMarketDataProvider';
import { MarketDataProvider } from '../services/market-data/MarketDataProvider';
import { BacktestEngine } from '../services/backtest/BacktestEngine';
import { DEFAULT_SKILLS } from '../data/defaultSkills';
import { telegramService } from '../services/telegram/TelegramService';
import { ApiRequestError } from '../services/ai/OpenRouterClient';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const persistence: PersistenceLayer = createPersistence();
export const appPersistence = persistence;

const reasoningGateway = new UserScopedReasoningGateway(persistence.keys);
const marketProvider: MarketDataProvider = paperProvider; // swap for a live adapter here

const runtimeOptions = {
  reasoning: reasoningGateway,
  marketProvider,
  signals: persistence.signals,
  theses: persistence.theses,
  wakeEvents: persistence.wakeEvents,
};

function ensureGoatRuntime(goat: SignalGoat) {
  const attached = allSkillsFor(goat.userId).then((skills) =>
    skills.filter((s) => goat.skillIds.includes(s.id)),
  );
  return attached.then((attachedSkills) =>
    durableObjectRegistry.getOrCreate(goat, attachedSkills, runtimeOptions),
  );
}

async function allSkillsFor(userId: string) {
  const userSkills = await persistence.skills.listByUser(userId);
  const defaults = DEFAULT_SKILLS.filter((d) => !userSkills.some((s) => s.id === d.id));
  return [...defaults, ...userSkills];
}

/** Restart recovery: rebuild runtime actors for every persisted GOAT. */
export async function restoreRuntimes(): Promise<void> {
  try {
    const goats = await persistence.goats.listAll();
    for (const goat of goats) {
      if (goat.status !== 'PAUSED') {
        await ensureGoatRuntime(goat);
      }
    }
    console.log(`[api] Restored ${goats.length} GOAT runtime(s) from persistence.`);
  } catch (err) {
    console.error('[api] Failed to restore GOAT runtimes:', err);
  }
}

/** Seed default skills once so new users always see the standard library. */
export async function seedDefaultSkills(): Promise<void> {
  try {
    for (const skill of DEFAULT_SKILLS) {
      const existing = await persistence.skills.get(skill.id);
      if (!existing) {
        await persistence.skills.save(skill);
      }
    }
  } catch (err) {
    console.error('[api] Failed to seed default skills:', err);
  }
}

// Signal -> Telegram fan-out (only when the owner configured Telegram).
durableObjectRegistry.onGlobalSignal(async (goat, signal) => {
  if (signal.direction === 'NO_TRADE' || signal.status !== 'ACTIONABLE') return;
  try {
    const token =
      (await persistence.keys.getTelegramToken(goat.userId)) || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const profile = await persistence.profiles.get(goat.userId);
    const chatId = profile?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;
    await telegramService.sendSignalNotification(chatId, signal, goat.name, token);
  } catch (err) {
    console.error('[api] Telegram signal notification failed:', err);
  }
});

/**
 * A tracked condition was satisfied -> tell the user straight away.
 *
 * Deliberately separate from the signal fan-out: the user asked to be
 * alerted when a wait-for condition is hit, which happens long before (and
 * independently of) any gate-approved setup.
 */
durableObjectRegistry.onTrackerTriggered(async (goat, report) => {
  try {
    const token =
      (await persistence.keys.getTelegramToken(goat.userId)) || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const profile = await persistence.profiles.get(goat.userId);
    const chatId = profile?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;

    await telegramService.sendTrackerTriggered(
      chatId,
      goat.name,
      {
        description: report.tracker.description,
        market: report.tracker.market || goat.markets[0] || '—',
        formula: report.formulaDescription,
        calculatedValue: report.calculatedValue,
      },
      token,
    );
  } catch (err) {
    console.error('[api] Telegram tracker notification failed:', err);
  }
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function notFound(res: Response): void {
  fail(res, 404, 'NOT_FOUND', 'Resource not found.');
}

/** Route wrapper: structured errors, no stack traces leaked. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (err instanceof NotFoundError) {
        return notFound(res);
      }
      console.error('[api] Unhandled route error:', err);
      if (!res.headersSent) {
        /**
         * Caller-supplied bad input -> 400 with the real message.
         * Upstream provider failure -> 502, not an opaque 500, so the UI can
         * explain it (and distinguish it from the caller's own mistake).
         */
        if (err instanceof CredentialValidationError) {
          return fail(res, 400, err.code, err.message);
        }

        const upstream = err instanceof ApiRequestError;
        fail(
          res,
          upstream ? 502 : 500,
          upstream ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR',
          upstream
            ? err.message
            : 'An internal error occurred.',
        );
      }
      next();
    });
  };
}

/**
 * Model ids come from the LIVE OpenRouter catalogue served by
 * GET /api/ai/models — there is no hardcoded allow-list, so validation is
 * limited to "well-formed OpenRouter model slug" (vendor/model, optional
 * variant suffix).
 */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._\-]*)*$/;

function isValidModel(model: unknown): boolean {
  return (
    typeof model === 'string' &&
    model.length <= 128 &&
    MODEL_ID_PATTERN.test(model)
  );
}

function validateGoatInput(body: unknown): { name: string; goal: string; markets: string[]; skillIds: string[]; model: string; schedule: GoatSchedule } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) return null;
  if (typeof b.goal !== 'string' || !b.goal.trim() || b.goal.length > 1000) return null;
  if (!Array.isArray(b.markets) || b.markets.length === 0 || b.markets.length > 20) return null;
  if (!b.markets.every((m) => typeof m === 'string' && m.length <= 32)) return null;
  if (!Array.isArray(b.skillIds) || b.skillIds.length > 20) return null;
  if (!b.skillIds.every((s) => typeof s === 'string' && s.length <= 128)) return null;
  const model = b.model ?? 'anthropic/claude-3.5-sonnet';
  if (!isValidModel(model)) return null;
  return {
    name: b.name.trim(),
    goal: b.goal.trim(),
    markets: b.markets as string[],
    skillIds: b.skillIds as string[],
    model: model as string,
    schedule: normaliseSchedule(b.schedule as GoatSchedule | undefined),
  };
}

/* ------------------------------------------------------------------ */
/* Public routes                                                       */
/* ------------------------------------------------------------------ */

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Observes every API response and logs the failures that the browser only
 * surfaces as "Failed to load resource". Without this, a bare 4xx/5xx in the
 * console gives no indication of which route or why.
 */
apiRouter.use((req: Request, res: Response, next: NextFunction) => {
  // statusCode is still 200 at this point, so the listener must be attached
  // unconditionally and checked on 'finish'.
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    console.warn(
      `[api] ${res.statusCode} ${req.method} ${req.originalUrl}` +
        ` — authMode=${resolveAuthMode()}`,
    );
  });

  next();
});

apiRouter.get('/settings/status', async (_req, res) => {
  const mode = resolveAuthMode();
  const symbols = await marketProvider.getSymbols();

  res.json({
    marketData: {
      provider: marketProvider.name,
      dataMode: marketProvider.dataMode,
      symbolsCount: symbols.length,
    },
    reasoning: {
      /** Model ids are not hardcoded; the live catalogue is served per user. */
      liveCatalogue: true,
      serverKeyConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    },
    telegram: {
      serverConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      webhookSecretRequired: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    },
    platform: {
      authMode: mode,
      persistenceMode: persistence.mode,
      activeActors: durableObjectRegistry.getAll().length,
      /**
       * When auth is not 'firebase', tell the operator exactly which variable
       * is missing instead of leaving them guessing.
       */
      authNotConfiguredReason:
        mode === 'firebase' ? undefined : getFirebaseAdminFailureReason(),
    },
  });
});

// Market data reads are public (paper feed, no secrets).
apiRouter.get('/markets/symbols', handle(async (_req, res) => {
  const symbols = await marketProvider.getSymbols();
  res.json({ symbols, provider: marketProvider.name, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/markets/quotes', handle(async (req, res) => {
  const symbolsParam = req.query.symbols as string | undefined;
  const requested = symbolsParam ? symbolsParam.split(',').slice(0, 50) : (await marketProvider.getSymbols()).map((s) => s.symbol);
  const quotes = await marketProvider.getQuotes(requested);
  res.json({ quotes, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/markets/quote', handle(async (req, res) => {
  const symbol = (req.query.symbol as string) || 'EUR/USD';
  const quote = await marketProvider.getQuote(symbol);
  res.json({ quote, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/markets/candles', handle(async (req, res) => {
  const symbol = (req.query.symbol as string) || 'EUR/USD';
  const timeframe = (req.query.timeframe as string) || '1h';
  const count = Math.min(1000, Math.max(1, parseInt(req.query.count as string, 10) || 60));
  const candles = await marketProvider.getCandles(symbol, timeframe, count);
  res.json({ symbol, timeframe, candles, dataMode: marketProvider.dataMode });
}));

// Telegram webhook: secret-validated, payload-validated.
apiRouter.post('/telegram/webhook', handle(async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.header('x-telegram-bot-api-secret-token');
    if (provided !== secret) {
      return fail(res, 401, 'UNAUTHORIZED_WEBHOOK', 'Invalid webhook secret.');
    }
  }

  const update = req.body;
  if (typeof update !== 'object' || update === null || !('update_id' in (update as object))) {
    return fail(res, 400, 'INVALID_UPDATE', 'Payload is not a valid Telegram update.');
    }    const result = await telegramService.processUpdate(update, {
      resolveGoatForChat: async (chatId) => {
        const profile = await persistence.profiles.findByTelegramChatId(String(chatId));
        if (!profile) return null;
        const goats = await persistence.goats.listByUser(profile.id);
        if (goats.length === 0) return null;
        const goat = goats[0];
        const runtime = await ensureGoatRuntime(goat);
        const skills = (await allSkillsFor(goat.userId)).filter((s) => goat.skillIds.includes(s.id));
        const ctx = await buildGoatContext(
          { goats: persistence.goats, skills: persistence.skills, marketProvider },
          goat.id,
          profile.id,
        );
        return {
          goat,
          state: runtime.getState(),
          reasoningContext: { ...ctx.context, activeThesis: runtime.getState().currentThesis },
          model: ctx.model,
          userId: profile.id,
          skills,
          gateway: reasoningGateway,

          /**
           * /analyse: force a full run now, then summarise the outcome for
           * Telegram. Uses the same wake pipeline as the web app so both
           * surfaces behave identically.
           */
          requestAnalysis: async (reason: string) => {
            const state = await runtime.wake(reason, 'MANUAL_REEVALUATE');

            const thesis = state.currentThesis;
            const signal = state.latestSignal;
            const triggered = state.trackers.filter((t) => t.isTriggered).length;

            const lines = [
              `🐐 *${goat.name.toUpperCase()} · FRESH ANALYSIS*`,
              '',
              `Schedule: ${describeSchedule(normaliseSchedule(goat.schedule))}`,
              `Reasoning: ${state.reasoningMode} · Data: ${state.dataSource}`,
              '',
            ];

            if (thesis) {
              lines.push(`*Asset state:* ${thesis.summary ?? '—'}`);
              if (thesis.assetState) lines.push(`${thesis.assetState.slice(0, 400)}`);
              lines.push('');
            }

            if (signal) {
              lines.push(telegramService.formatSignalMessage(signal, goat.name));
            } else {
              lines.push('No decision produced.');
            }

            lines.push('');
            lines.push(`Conditions armed: ${state.trackers.length} · met: ${triggered}`);
            lines.push(
              state.trackers
                .map(
                  (t) =>
                    `${t.isTriggered ? '✅' : '⏳'} ${t.formulaDescription ?? t.description}`,
                )
                .join('\n'),
            );

            if (state.lastError) {
              lines.push(`\n_Last error: ${state.lastError.slice(0, 200)}_`);
            }

            return lines.join('\n');
          },
        };
      },
      getBotTokenForUser: async (userId) =>
        (await persistence.keys.getTelegramToken(userId)) || process.env.TELEGRAM_BOT_TOKEN,
    });


  res.json(result);
}));

/* ------------------------------------------------------------------ */
/* Protected routes                                                    */
/* ------------------------------------------------------------------ */

apiRouter.use(authMiddleware);

// ---- Settings / keys (user-scoped) ----------------------------------

/** Per-user credential status. Never returns the secret itself. */
apiRouter.get('/settings/keys', handle(async (req, res) => {
  const user = requireUser(req);
  const [openRouterKey, telegramToken] = await Promise.all([
    persistence.keys.getOpenRouterKey(user.uid),
    persistence.keys.getTelegramToken(user.uid),
  ]);

  res.json({
    /**
     * Reported false when a value is stored but is not a usable key shape, so
     * the UI cannot claim "your key is saved" while every wake fails.
     */
    openRouterKeyConfigured: isPlausibleOpenRouterKey(openRouterKey),
    /** A key exists but is malformed and needs re-entering. */
    openRouterKeyInvalid: Boolean(openRouterKey) && !isPlausibleOpenRouterKey(openRouterKey),
    telegramTokenConfigured: Boolean(telegramToken),
    serverKeyFallback: isPlausibleOpenRouterKey(
      process.env.OPENROUTER_API_KEY,
    ),
  });
}));

apiRouter.post('/settings/keys', handle(async (req, res) => {
  const user = requireUser(req);
  const { openRouterKey, telegramToken, telegramChatId } = req.body ?? {};

  const nextOpenRouterKey =
    normaliseOpenRouterKey(openRouterKey);
  const nextTelegramToken =
    normaliseTelegramToken(telegramToken);

  if (nextOpenRouterKey.key !== undefined) {
    await persistence.keys.setOpenRouterKey(
      user.uid,
      nextOpenRouterKey.key,
    );
    // Drop the cached client so the next request uses the new credential.
    reasoningGateway.invalidate(user.uid);
  }

  if (nextTelegramToken !== undefined) {
    await persistence.keys.setTelegramToken(
      user.uid,
      nextTelegramToken,
    );
  }

  if (telegramChatId !== undefined && telegramChatId !== null) {
    if (typeof telegramChatId !== 'string' || !/^-?\d{1,20}$/.test(telegramChatId.trim())) {
      return fail(res, 400, 'INVALID_KEY', 'telegramChatId must be a numeric Telegram chat id.');
    }
    const profile = (await persistence.profiles.get(user.uid)) ?? {
      id: user.uid,
      email: user.email ?? `${user.uid}@signalgoat.internal`,
      displayName: 'SignalGOAT Trader',
      telegramNotificationsEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistence.profiles.save({
      ...profile,
      telegramChatId: telegramChatId.trim(),
      updatedAt: new Date().toISOString(),
    });
  }

  res.json({
    success: true,
    openRouterKeyConfigured: isPlausibleOpenRouterKey(
      await persistence.keys.getOpenRouterKey(user.uid),
    ),
  });
}));

// ---- AI / OpenRouter (user-scoped key) ------------------------------

/**
 * Live OpenRouter model catalogue, resolved with the CALLER's key.
 * Never leaks another user's credential: key resolution happens inside the
 * gateway, keyed by the verified uid.
 */
apiRouter.get('/ai/models', handle(async (req, res) => {
  const user = requireUser(req);
  if (!(await reasoningGateway.hasKeyFor(user.uid))) {
    return fail(
      res,
      400,
      'AI_NOT_CONFIGURED',
      'Add your OpenRouter API key in Settings → AI Reasoning Engine to load models.',
    );
  }
  const catalogue = await reasoningGateway.listModels(user.uid);
  res.json({ models: catalogue.models, fetchedAt: catalogue.fetchedAt, source: 'openrouter' });
}));

/** Live end-to-end probe of the caller's own key. */
apiRouter.post('/ai/test', handle(async (req, res) => {
  const user = requireUser(req);
  const result = await reasoningGateway.testKeyFor(user.uid);
  res.json(result);
}));

apiRouter.post('/telegram/test', handle(async (req, res) => {
  const user = requireUser(req);
  const { chatId } = req.body ?? {};
  if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId.trim())) {
    return fail(res, 400, 'INVALID_CHAT_ID', 'chatId must be a numeric Telegram chat id.');
  }
  const token = (await persistence.keys.getTelegramToken(user.uid)) || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return fail(res, 400, 'TELEGRAM_NOT_CONFIGURED', 'No Telegram bot token configured.');
  }
  const result = await telegramService.sendTestMessage(chatId.trim(), token);
  res.json(result);
}));

// ---- Skills ----------------------------------------------------------

apiRouter.get('/skills', handle(async (req, res) => {
  const user = requireUser(req);
  const skills = await allSkillsFor(user.uid);
  res.json({ skills, dataMode: marketProvider.dataMode });
}));

apiRouter.post('/skills', handle(async (req, res) => {
  const user = requireUser(req);
  const body = req.body ?? {};
  if (typeof body !== 'object' || body === null) {
    return fail(res, 400, 'INVALID_INPUT', 'Body must be an object.');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) {
    return fail(res, 400, 'INVALID_INPUT', 'Skill name is required (max 100 chars).');
  }

  const skillId = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newSkill = {
    id: skillId,
    userId: user.uid,
    name: b.name.trim(),
    description: typeof b.description === 'string' ? b.description.slice(0, 500) : '',
    methodology: typeof b.methodology === 'string' ? b.methodology.slice(0, 4000) : '',
    constraints: typeof b.constraints === 'string' ? b.constraints.slice(0, 1000) : '',
    preferredTimeframes: Array.isArray(b.preferredTimeframes)
      ? (b.preferredTimeframes as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 10)
      : ['1h'],
    requiredEvidence: typeof b.requiredEvidence === 'string' ? b.requiredEvidence.slice(0, 1000) : '',
    invalidationRules: typeof b.invalidationRules === 'string' ? b.invalidationRules.slice(0, 1000) : '',
    rawMarkdown: typeof b.rawMarkdown === 'string' ? b.rawMarkdown.slice(0, 20000) : undefined,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistence.skills.save(newSkill);
  res.json({ skill: newSkill });
}));

apiRouter.delete('/skills/:id', handle(async (req, res) => {
  const user = requireUser(req);
  const skill = await persistence.skills.get(req.params.id);
  if (!skill) return notFound(res);
  if (skill.isDefault || skill.userId === 'system') {
    return fail(res, 400, 'DEFAULT_SKILL', 'Cannot delete default system skills.');
  }
  if (skill.userId !== user.uid) {
    return notFound(res); // avoid resource enumeration
  }
  await persistence.skills.delete(skill.id);
  res.json({ success: true, deletedId: skill.id });
}));

// ---- GOATs ------------------------------------------------------------

apiRouter.get('/goats', handle(async (req, res) => {
  const user = requireUser(req);
  const goats = await persistence.goats.listByUser(user.uid);
  const withState = goats.map((goat) => ({
    ...goat,
    runtimeState: durableObjectRegistry.get(goat.id)?.getState() ?? null,
  }));
  res.json({ goats: withState, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/goats/:id', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);
  const runtime = await ensureGoatRuntime(goat);
  res.json({ goat, runtimeState: runtime.getState(), dataMode: marketProvider.dataMode });
}));

apiRouter.post('/goats', handle(async (req, res) => {
  const user = requireUser(req);
  const input = validateGoatInput(req.body);
  if (!input) {
    return fail(res, 400, 'INVALID_INPUT', 'Name, goal, at least one market, and a supported model are required.');
  }

  // Ownership validation: skillIds must reference defaults or the user's own skills.
  const skills = await allSkillsFor(user.uid);
  const knownIds = new Set(skills.map((s) => s.id));
  const unknownSkills = input.skillIds.filter((id) => !knownIds.has(id));
  if (unknownSkills.length > 0) {
    return fail(res, 400, 'UNKNOWN_SKILL', `Unknown skill ids: ${unknownSkills.join(', ')}`);
  }

  const goatId = `goat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const newGoat: SignalGoat = {
    id: goatId,
    userId: user.uid,
    name: input.name,
    goal: input.goal,
    markets: input.markets,
    skillIds: input.skillIds.length > 0 ? input.skillIds : ['skill_price_action'],
    model: input.model,
    status: 'WATCHING',
    schedule: input.schedule,
    createdAt: now,
    updatedAt: now,
  };

  await persistence.goats.save(newGoat);
  const runtime = await ensureGoatRuntime(newGoat);

  /**
   * INSTANT FIRST RUN.
   *
   * A deployed GOAT must analyse the market immediately rather than sitting
   * idle until its first scheduled tick. Awaited so the response already
   * contains the first thesis, state and trackers. A failure here is NOT
   * fatal — the GOAT still exists and the scheduler will retry.
   */
  let firstRun: GoatRuntimeState | null = null;
  try {
    firstRun = await runtime.wake(
      'Initial analysis on deployment',
      'MANUAL_REEVALUATE',
      input.markets[0],
    );
  } catch (err) {
    console.error('[api] Initial GOAT analysis failed:', err);
  }

  res.json({
    goat: newGoat,
    runtimeState: firstRun ?? runtime.getState(),
    dataMode: marketProvider.dataMode,
  });
}));

// ---- Stop / Play / schedule ------------------------------------------

apiRouter.post('/goats/:id/status', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  const action = req.body?.action;
  if (action !== 'PAUSE' && action !== 'PLAY') {
    return fail(res, 400, 'INVALID_ACTION', 'action must be PAUSE or PLAY.');
  }

  const pausing = action === 'PAUSE';
  const now = new Date().toISOString();
  const updated: SignalGoat = {
    ...goat,
    status: pausing ? 'PAUSED' : 'WATCHING',
    updatedAt: now,
  };

  await persistence.goats.save(updated);

  // Re-attach so the actor picks up the new status, then apply the action.
  const runtime = await ensureGoatRuntime(updated);
  const state = pausing ? runtime.pause() : runtime.play();

  res.json({
    goat: updated,
    status: updated.status,
    runtimeState: state,
    schedule: runtime.getConfig().schedule,
    dataMode: marketProvider.dataMode,
  });
}));

apiRouter.patch('/goats/:id/schedule', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  const schedule = normaliseSchedule(req.body?.schedule as GoatSchedule | undefined);
  const updated: SignalGoat = {
    ...goat,
    schedule,
    updatedAt: new Date().toISOString(),
  };

  await persistence.goats.save(updated);

  const runtime = await ensureGoatRuntime(updated);
  runtime.setSchedule(schedule);

  res.json({ goat: updated, schedule, dataMode: marketProvider.dataMode });
}));


apiRouter.delete('/goats/:id', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  // 1. Stop timers/subscriptions and remove the runtime actor.
  durableObjectRegistry.remove(goat.id);
  // 2. Remove persisted data.
  await persistence.goats.delete(goat.id);

  res.json({ success: true, deletedId: goat.id });
}));

apiRouter.post('/goats/:id/wake', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  const runtime = await ensureGoatRuntime(goat);
  const reason =
    typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 200)
      : 'Manual user-requested reevaluation';
  const market =
    typeof req.body?.market === 'string' && goat.markets.includes(req.body.market)
      ? req.body.market
      : goat.markets[0];

  const state = await runtime.wake(reason, 'MANUAL_REEVALUATE', market);
  res.json({ state, dataMode: marketProvider.dataMode });
}));

apiRouter.post('/goats/:id/chat', handle(async (req, res) => {
  const user = requireUser(req);
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim()) {
    return fail(res, 400, 'INVALID_INPUT', 'Question is required.');
  }
  if (question.length > 2000) {
    return fail(res, 400, 'INVALID_INPUT', 'Question too long.');
  }

  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  await ensureGoatRuntime(goat);
  const { context, model } = await buildGoatContext(
    { goats: persistence.goats, skills: persistence.skills, marketProvider },
    goat.id,
    user.uid,
  );
  const runtime = durableObjectRegistry.get(goat.id);
  const enriched = { ...context, activeThesis: runtime?.getState().currentThesis ?? null };

  const answer = await reasoningGateway.answerGoatQuestion(question.trim(), enriched, model);
  res.json({ answer, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/goats/:id/signals', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);
  const signals: TradeSignal[] = await persistence.signals.listByGoat(goat.id, 100);
  res.json({ signals });
}));

// ---- Backtest ----------------------------------------------------------

apiRouter.post('/backtest/run', handle(async (req, res) => {
  const user = requireUser(req);
  const { goatId, market, period } = req.body ?? {};

  const goat = goatId
    ? await persistence.goats.getForUser(String(goatId), user.uid)
    : (await persistence.goats.listByUser(user.uid))[0];
  if (!goat) {
    return fail(res, 400, 'NO_GOAT', 'No GOAT available for backtest.');
  }

  const skills = (await allSkillsFor(user.uid)).filter((s) => goat.skillIds.includes(s.id));
  const selectedMarket = typeof market === 'string' && goat.markets.includes(market)
    ? market
    : goat.markets[0] ?? 'EUR/USD';
  const validPeriods = ['24h', '7d', '30d', '90d'];
  const selectedPeriod = validPeriods.includes(period as string) ? (period as string) : '7d';

  const result = await BacktestEngine.runBacktest({
    goat,
    skills,
    market: selectedMarket,
    period: selectedPeriod as '24h' | '7d' | '30d' | '90d',
    provider: marketProvider,
  });

  res.json({ result });
}));
