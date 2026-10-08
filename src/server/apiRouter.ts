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
import { biQuoteProvider } from '../services/market-data/BiQuoteMarketDataProvider';
import { paperProvider } from '../services/market-data/PaperMarketDataProvider';
import { MarketDataProvider } from '../services/market-data/MarketDataProvider';
import {
  MarketStateStore,
  isUsableMarketState,
} from '../services/market-data/MarketStateStore';
import { FileMarketStatePersistence } from '../services/market-data/FileMarketStatePersistence';
import { BacktestEngine } from '../services/backtest/BacktestEngine';
import { DEFAULT_SKILLS } from '../data/defaultSkills';
import { telegramService } from '../services/telegram/TelegramService';
import { ApiRequestError } from '../services/ai/OpenRouterClient';
import { durableObjectSchedulerFromEnv } from './scheduler/DurableObjectScheduler';
import type { WakeScheduler, FiredWake } from './scheduler/types';
import { InProcessScheduler } from './scheduler/InProcessScheduler';
import { msUntilNextScheduledTime, normaliseSchedule, describeSchedule } from '../services/durable-object/GoatDurableObject';
import {
  TRACKING_TIMEFRAMES,
  normaliseTrackingTimeframe,
  pollIntervalForTimeframe,
} from '../services/market-data/trackingTimeframes';
import { DailyMarketRollup } from '../services/daily-rolling/DailyMarketRollup';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const persistence: PersistenceLayer = createPersistence();
export const appPersistence = persistence;

const reasoningGateway = new UserScopedReasoningGateway(persistence.keys);
/**
 * Market data source: BiQuote live feed (free, no API key).
 *
 * There is deliberately NO automatic fallback to the PAPER provider. Silently
 * swapping in simulated prices would mean a feed outage quietly turns the app
 * into fiction while the UI still says "LIVE". Instead a provider outage
 * surfaces as an explicit failure — GOATDurableObject already records
 * "Market data unavailable" and backs off — and `dataMode` on every response
 * reports what is actually serving.
 *
 * Escape hatch: `MARKET_DATA_PROVIDER=paper` forces the simulated feed. Used
 * by the test suite (so it stays hermetic and offline) and for UI work with
 * no connectivity. `dataMode` reports 'PAPER' so it can never be mistaken for
 * live data.
 */
const marketProvider: MarketDataProvider =
  process.env.MARKET_DATA_PROVIDER === 'paper'
    ? paperProvider
    : biQuoteProvider;

if (marketProvider.dataMode === 'PAPER') {
  console.warn(
    '[api] MARKET_DATA_PROVIDER=paper — serving SIMULATED prices.',
  );
}

/**
 * Shared market state: one fetch + one indicator computation per
 * (symbol, timeframe) per TTL, fanned out to every GOAT and persisted so a
 * restart does not start from an empty chart.
 *
 * This is the substrate a Cloudflare Durable Object would hold (durable,
 * per-key derived market state). It is deliberately keyed by MARKET, not by
 * GOAT, because the expensive thing — indicator computation over candles — is
 * identical for every GOAT watching the same pair.
 */
export const marketStateStore = new MarketStateStore(marketProvider, {
  ttlMs: 30_000,
  pollIntervalMs: 5_000,
  timeframe: '15m',
  candleCount: 120,
  ...(marketProvider.dataMode === 'LIVE'
    ? { persist: new FileMarketStatePersistence() }
    : {}),
});

/**
 * AUTHORITATIVE SCHEDULER
 *
 * In production this is the Cloudflare Durable Object, whose alarms are durable
 * and survive restarts and redeploys. With no Worker configured (local dev, or
 * a single-process deploy) it falls back to in-process timers, and that fact is
 * reported by /api/settings/status so it can never be mistaken for the durable
 * path.
 *
 * The fallback is what makes local development work with no Cloudflare account.
 */
const durableScheduler = durableObjectSchedulerFromEnv();

/**
 * Called when an in-process alarm fires. With a Durable Object scheduler this
 * is never used, because that actor arms no local timers.
 */
let inProcessScheduler: InProcessScheduler | null = null;

if (durableScheduler) {
  console.log('[api] Durable Object scheduler active.');
} else {
  inProcessScheduler = new InProcessScheduler(async (wake) => {
    await runScheduledWake(wake.goatId, wake.eventId, wake.reason);
  });

  // Tracker checks spend no AI: they only escalate when a condition is met.
  inProcessScheduler.onTrackerCheck = async (wake) => {
    await runTrackerCheck(wake.goatId, wake.eventId);
  };
  console.warn(
    '[api] DURABLE_SCHEDULER_URL not set — using IN-PROCESS timers. ' +
      'Schedules will NOT survive a restart. Configure the Cloudflare ' +
      'scheduler worker for production.',
  );
}

const scheduler: WakeScheduler = durableScheduler ?? inProcessScheduler!;

/**
 * Daily market recap + intraday rollover.
 *
 * Fed from the same LIVE snapshots the trackers use, so the recap is built
 * from provider-confirmed data only. Idempotent by trading date.
 */
export const dailyRollup = new DailyMarketRollup({
  recaps: persistence.recaps,
});

/**
 * Every fresh market snapshot feeds the daily session, which is what makes a
 * recap possible at all without a second data pull.
 */
marketStateStore.onSnapshot((snapshot) => {
  dailyRollup.observe(snapshot);
});

const runtimeOptions = {
  reasoning: reasoningGateway,
  marketProvider,
  marketStateStore,
  signals: persistence.signals,
  theses: persistence.theses,
  wakeEvents: persistence.wakeEvents,
  scheduler,
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

  dailyRollup.recordEvent(
    signal.market,
    'SIGNAL',
    `${signal.direction} ${signal.orderType} @ ${signal.entry ?? 'n/a'}`,
  );
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

    dailyRollup.recordEvent(
      report.tracker.market || goat.markets[0] || 'unknown',
      'TRACKER_TRIGGERED',
      report.eventReason,
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

function validateGoatInput(body: unknown): { name: string; goal: string; markets: string[]; skillIds: string[]; model: string; schedule: GoatSchedule; timeframe: ReturnType<typeof normaliseTrackingTimeframe> } | null {
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
    /**
     * Tracking timeframe is validated server-side. An unrecognised value falls
     * back to the default rather than being rejected outright, so a client
     * sending a stale enum still gets a working GOAT.
     */
    timeframe: normaliseTrackingTimeframe(b.timeframe),
  };
}


/* ------------------------------------------------------------------ */
/* Durable scheduling                                                  */
/* ------------------------------------------------------------------ */

/** Bumped whenever a GOAT's schedule changes, invalidating stale alarms. */
function scheduleGeneration(goat: SignalGoat): string {
  const schedule = normaliseSchedule(goat.schedule);
  return [
    goat.id,
    schedule.mode,
    schedule.intervalMinutes ?? '-',
    (schedule.times ?? []).join('.') || '-',
  ].join(':');
}

/**
 * When this GOAT is next due, or null when it has no scheduled reasoning.
 *
 * MANUAL never fires on its own. TRACKERS keeps the deterministic trackers
 * running (driven by market state, not the scheduler) but spends no AI, so it
 * needs no alarm.
 */
/**
 * Next deterministic tracker check.
 *
 * This is NOT a reasoning run and spends no AI. It exists so trackers are
 * observed on the user's chosen cadence even where no long-lived process
 * exists to watch them (Vercel). The interval tracks the bar size, clamped so a
 * 1m timeframe is not polled every millisecond and a 4h timeframe is not
 * polled every 5 seconds.
 */
function computeNextTrackerCheckAt(
  goat: SignalGoat,
  from: number = Date.now(),
): number | null {
  if (goat.status === 'PAUSED') return null;

  const timeframe = normaliseTrackingTimeframe(goat.timeframe);
  return from + pollIntervalForTimeframe(timeframe);
}

function computeNextWakeAt(
  goat: SignalGoat,
  from: number = Date.now(),
): number | null {
  if (goat.status === 'PAUSED') return null;

  const schedule = normaliseSchedule(goat.schedule);

  switch (schedule.mode) {
    case 'MANUAL':
    case 'TRACKERS':
      return null;

    case 'TIMES': {
      const times = schedule.times ?? [];
      if (times.length === 0) return null;
      return from + msUntilNextScheduledTime(times, from);
    }

    case 'INTERVAL':
    default: {
      const minutes = schedule.intervalMinutes ?? 60;
      return from + minutes * 60_000;
    }
  }
}

/**
 * Publishes a GOAT's authoritative schedule to the durable scheduler.
 *
 * Never throws: a GOAT must still be creatable and usable when the scheduler
 * Worker is unreachable. The failure is reported through health() instead.
 */
async function syncSchedule(goat: SignalGoat): Promise<void> {
  const nextWakeAt = computeNextWakeAt(goat);
  const nextTrackerCheck = computeNextTrackerCheckAt(goat);

  try {
    await scheduler.sync({
      goatId: goat.id,
      nextWakeAt: nextWakeAt ? new Date(nextWakeAt).toISOString() : null,
      nextTrackerCheckAt: nextTrackerCheck
        ? new Date(nextTrackerCheck).toISOString()
        : null,
      timeframe: normaliseTrackingTimeframe(goat.timeframe),
      generationId: scheduleGeneration(goat),
      paused: goat.status === 'PAUSED',
    });
  } catch (err) {
    console.error(
      `[scheduler] failed to sync ${goat.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Executes a scheduled wake, applying duplicate suppression BEFORE any work.
 *
 * Every trigger path (Durable Object alarm, in-process timer, manual wake)
 * funnels through here so idempotency cannot be bypassed by adding a new
 * trigger. This is what stops a duplicated alarm from producing a second AI
 * call, a second signal or a second Telegram message.
 */
async function runScheduledWake(
  goatId: string,
  eventId: string,
  reason: string,
): Promise<GoatRuntimeState | null> {
  const goat = await persistence.goats.get(goatId);
  if (!goat) return null;

  const verdict = scheduler.decide(goatId, {
    goatId,
    eventId,
    generationId: scheduleGeneration(goat),
    reason,
    firedAt: Date.now(),
  });

  if (verdict.allowed === false) {
    console.log(
      `[scheduler] suppressed wake for ${goatId}: ${verdict.reason}`,
    );
    return null;
  }

  const runtime = durableObjectRegistry.get(goatId)
    ? durableObjectRegistry.get(goatId)!
    : await ensureGoatRuntime(goat);

  const state = await runtime.wake(
    reason,
    'SCHEDULED',
    goat.markets[0],
  );

  // Re-arm for the following interval, based on when this run actually
  // finished rather than when it was scheduled, so a slow run does not cause
  // the interval to drift earlier each cycle.
  const refreshed = await persistence.goats.get(goatId);
  if (refreshed) await syncSchedule(refreshed);

  return state;
}

function isoNow(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Deterministic tracker check, called by the Durable Object on the GOAT's
 * tracking cadence.
 *
 * SPENDS NO AI. Trackers are indicator comparisons recomputed from candles;
 * only when one is actually satisfied does the GOAT escalate to a full
 * reasoning wake. This is what keeps the market loop event-driven instead of
 * polling a model.
 */
/**
 * Deterministic tracker check shared by the Durable Object callback and the
 * in-process timer.
 *
 * SPENDS NO AI. Trackers are indicator comparisons recomputed from candles;
 * only a satisfied condition escalates to a full reasoning wake. Returns the
 * next check time so the caller can re-anchor its schedule.
 */
async function runTrackerCheck(
  goatId: string,
  eventId: string,
): Promise<{ handled: boolean; reason?: string; trackerFired: boolean; nextAt: string | null }> {
  const goat = await persistence.goats.get(goatId);
  if (!goat) {
    return { handled: false, reason: 'not_found', trackerFired: false, nextAt: null };
  }

  const verdict = scheduler.decide(goatId, {
    goatId,
    eventId,
    generationId: scheduleGeneration(goat),
    reason: 'Scheduled tracker check',
    firedAt: Date.now(),
  });

  if (verdict.allowed === false) {
    return {
      handled: false,
      reason: verdict.reason,
      trackerFired: false,
      nextAt: isoOrNull(computeNextTrackerCheckAt(goat)),
    };
  }

  const state = await marketStateStore.getState(
    goat.markets[0],
    normaliseTrackingTimeframe(goat.timeframe),
  );

  // Degraded data must not satisfy a tracker: a stale price is not a signal.
  if (!isUsableMarketState(state) || !state.quote) {
    return {
      handled: false,
      reason: `market data ${state.status}`,
      trackerFired: false,
      nextAt: isoOrNull(computeNextTrackerCheckAt(goat)),
    };
  }

  const runtime = await ensureGoatRuntime(goat);
  const trackerFired = await runtime.evaluateTrackersNow(state);

  const refreshed = await persistence.goats.get(goatId);

  return {
    handled: true,
    trackerFired,
    nextAt: isoOrNull(
      refreshed
        ? computeNextTrackerCheckAt(refreshed)
        : computeNextTrackerCheckAt(goat),
    ),
  };
}

/**
 * Deterministic tracker check, called by the Durable Object on the GOAT's
 * tracking cadence. See runTrackerCheck: it spends no AI unless a condition
 * actually fires.
 */
apiRouter.post('/internal/check-trackers', handle(async (req, res) => {
  const expected = process.env.DURABLE_SCHEDULER_SECRET?.trim();
  const provided = req.header('x-scheduler-secret') ?? '';

  if (!expected || provided !== expected) {
    return fail(res, 401, 'UNAUTHORISED', 'Invalid scheduler secret.');
  }

  const { goatId, eventId } = req.body ?? {};

  if (
    typeof goatId !== 'string' ||
    typeof eventId !== 'string' ||
    !goatId ||
    !eventId
  ) {
    return fail(res, 400, 'INVALID_INPUT', 'goatId and eventId are required.');
  }

  const result = await runTrackerCheck(goatId, eventId);

  res.json({ ...result, dataMode: marketProvider.dataMode });
}));

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Callback endpoint for the Durable Object scheduler.
 *
 * Authenticated with a shared secret (the Worker cannot present a Firebase ID
 * token — it has no user session and cannot run firebase-admin).
 */
apiRouter.post('/internal/wake', handle(async (req, res) => {
  const expected = process.env.DURABLE_SCHEDULER_SECRET?.trim();
  const provided =
    req.header('x-scheduler-secret') ?? '';

  if (!expected || provided !== expected) {
    return fail(res, 401, 'UNAUTHORISED', 'Invalid scheduler secret.');
  }

  const { goatId, eventId, reason } = req.body ?? {};

  if (
    typeof goatId !== 'string' ||
    typeof eventId !== 'string' ||
    !goatId ||
    !eventId
  ) {
    return fail(res, 400, 'INVALID_INPUT', 'goatId and eventId are required.');
  }

  const state = await runScheduledWake(
    goatId,
    eventId,
    typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 200)
      : 'Scheduled analysis (durable alarm)',
  );

  const refreshed = await persistence.goats.get(goatId);

  res.json({
    handled: state !== null,
    status: state?.status ?? null,
    /**
     * The DO re-arms from THIS value, so the interval stays anchored to when
     * the run actually finished instead of drifting by one alarm latency per
     * cycle.
     */
    nextAt: isoNow(
      refreshed ? computeNextWakeAt(refreshed) : null,
    ),
    dataMode: marketProvider.dataMode,
  });
}));

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
    /**
     * Shared market-state counters. `fetches` far below the number of GOATs
     * x tick interval is the proof that polling and indicator computation are
     * de-duplicated rather than repeated per GOAT.
     */
    scheduler: scheduler.health(),
    trackingTimeframes: TRACKING_TIMEFRAMES,
    dailyRollup: dailyRollup.stats,
    marketState: {
      ...marketStateStore.stats,
      activePollers: marketStateStore.activePollers(),
      activeSubscribers: marketStateStore.activeSubscribers(),
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
    timeframe: input.timeframe,
    createdAt: now,
    updatedAt: now,
  };

  await persistence.goats.save(newGoat);

  /** Durable alarm becomes the authoritative schedule. */
  await syncSchedule(newGoat);

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

  /** A paused GOAT must have its alarm cleared, not merely ignored locally. */
  await syncSchedule(updated);

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

  const hasScheduleField =
    req.body?.schedule !== undefined && req.body?.schedule !== null;
  const hasTimeframeField =
    req.body?.timeframe !== undefined && req.body?.timeframe !== null;

  if (!hasScheduleField && !hasTimeframeField) {
    return fail(
      res,
      400,
      'INVALID_INPUT',
      'Provide a schedule, a timeframe, or both.',
    );
  }

  const schedule = hasScheduleField
    ? normaliseSchedule(req.body.schedule as GoatSchedule)
    : normaliseSchedule(goat.schedule);

  /**
   * Server-side validation. An unknown timeframe is rejected explicitly here
   * rather than silently coerced, because the user is choosing a cadence and
   * silently substituting another one would be misleading.
   */
  const timeframe = hasTimeframeField
    ? req.body.timeframe
    : goat.timeframe;

  if (
    hasTimeframeField &&
    !TRACKING_TIMEFRAMES.includes(timeframe as never)
  ) {
    return fail(
      res,
      400,
      'INVALID_TIMEFRAME',
      `timeframe must be one of: ${TRACKING_TIMEFRAMES.join(', ')}.`,
    );
  }

  const updated: SignalGoat = {
    ...goat,
    schedule,
    timeframe: normaliseTrackingTimeframe(timeframe),
    updatedAt: new Date().toISOString(),
  };

  await persistence.goats.save(updated);

  /** A changed schedule is a new generation; stale alarms are rejected. */
  await syncSchedule(updated);

  const runtime = await ensureGoatRuntime(updated);
  runtime.setSchedule(schedule);
  runtime.updateConfig(updated, await allSkillsFor(user.uid));

  res.json({
    goat: updated,
    schedule,
    timeframe: updated.timeframe,
    scheduler: scheduler.health(),
    dataMode: marketProvider.dataMode,
  });
}));


apiRouter.delete('/goats/:id', handle(async (req, res) => {
  const user = requireUser(req);
  const goat = await persistence.goats.getForUser(req.params.id, user.uid);
  if (!goat) return notFound(res);

  // 1. Stop timers/subscriptions and remove the runtime actor.
  durableObjectRegistry.remove(goat.id);
  // 2. Clear the durable alarm so a deleted GOAT cannot wake.
  await scheduler.cancel(goat.id).catch((err) => {
    console.error('[scheduler] cancel failed:', err);
  });
  // 3. Remove persisted data.
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

// ---- Daily market recap ------------------------------------------------

apiRouter.get('/markets/recaps', handle(async (req, res) => {
  const symbol = String(req.query.symbol ?? '').trim();
  if (!symbol) {
    return fail(res, 400, 'INVALID_INPUT', 'symbol is required.');
  }

  const limit = Math.min(
    90,
    Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30),
  );

  const recaps = await dailyRollup.listRecaps(symbol, limit);

  res.json({ symbol, recaps, dataMode: marketProvider.dataMode });
}));

/**
 * Forces a daily rollup. Idempotent, so a cron or an operator can call it
 * freely: re-running merges rather than creating a second record for the day.
 */
apiRouter.post('/markets/rollup', handle(async (_req, res) => {
  const recaps = await dailyRollup.rollUpAll();
  res.json({ rolledUp: recaps.length, recaps });
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
