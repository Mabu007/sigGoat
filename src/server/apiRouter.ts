/**
 * FUNDAGOAT API ROUTER
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
import { FundGoat, GoatSchedule, GoatRuntimeState, TradeSignal } from '../types';
import { authMiddleware, requireUser, resolveAuthMode } from './auth';
import { getFirebaseAdminFailureReason } from './firebaseAdmin';
import {
  CredentialValidationError,
  isPlausibleOpenRouterKey,
  normaliseGroqKey,
  normaliseOpenRouterKey,
  normalisePropDaoKey,
  normaliseTelegramToken,
} from './credentialValidation';
import {
  createPersistence,
  PersistenceLayer,
  NotFoundError,
} from './repositories';
import { UserScopedReasoningGateway, type AiProvider } from './reasoningGateway';
import { buildGoatContext } from './goatContext';
import { configureCredentialVault, credentialVault } from './security/instance';
import { CredentialVaultError } from './security/CredentialVault';
import { PropFundAccountProvider } from '../services/propdao/PropFundAccountProvider';
import { DEFAULT_RISK_LIMITS, validateTradeIntent } from '../services/propdao/PropRiskValidator';
import { durableObjectRegistry } from '../services/durable-object/DurableObjectRegistry';
import { hyperliquidProvider } from '../services/market-data/hyperliquid/HyperliquidMarketDataProvider';
import {
  DEFAULT_MARKET_UNIVERSE,
  HYPERLIQUID_DEXES,
  tradableMarkets,
} from '../services/market-data/hyperliquid/MarketCatalog';
import { paperProvider } from '../services/market-data/PaperMarketDataProvider';
import { MarketDataProvider } from '../services/market-data/MarketDataProvider';
import {
  MarketStateStore,
  isUsableMarketState,
} from '../services/market-data/MarketStateStore';
import { FileMarketStatePersistence } from '../services/market-data/FileMarketStatePersistence';
import { BacktestEngine } from '../services/backtest/BacktestEngine';
import { DEFAULT_SKILLS } from '../data/defaultSkills';
import { SYSTEM_GOATS } from '../data/systemGoats';
import { SYSTEM_SKILLS, isSystemOwnedSkillId } from '../data/systemSkills';
import { telegramService } from '../services/telegram/TelegramService';
import type {
  TelegramProcessSummary,
  TelegramResolution,
} from '../services/telegram/TelegramService';
import { TelegramRateLimiter } from '../services/telegram/TelegramCommands';
import { TelegramBotClient } from '../services/telegram/TelegramBotClient';
import { ApiRequestError } from '../services/ai/OpenRouterClient';
import { durableObjectSchedulerFromEnv } from './scheduler/DurableObjectScheduler';
import type { WakeScheduler, FiredWake } from './scheduler/types';
import { InProcessScheduler } from './scheduler/InProcessScheduler';
import { msUntilNextScheduledTime, normaliseSchedule, describeSchedule } from '../services/durable-object/GoatDurableObject';
import {
  TRACKING_TIMEFRAMES,
  isTrackingTimeframe,
  normaliseTrackingTimeframe,
  pollIntervalForTimeframe,
  type TrackingTimeframe,
} from '../services/market-data/trackingTimeframes';
import { DailyMarketRollup } from '../services/daily-rolling/DailyMarketRollup';
import {
  MarketIngestionService,
  type Subscription as IngestionSubscription,
} from '../services/market-data/MarketIngestionService';
import { MemoryCandleRepository } from '../services/market-data/candle-core/CandleRepositories';
import { retentionPolicyFromEnv } from '../services/market-data/candle-core/RetentionPolicy';
import {
  DurableMarketDataClient,
  durableMarketDataEnvFromProcess,
  validateMarketEvent,
  type DurablePartition,
} from '../services/market-data/DurableMarketDataClient';
import type { MarketEvent } from '../services/market-data/MarketEvent';
import { describeSessionSpec, resolveSession } from '../services/market-data/candle-core/SessionCalendar';
import {
  NotificationOutbox,
  MemoryOutboxStore,
} from '../services/telegram/NotificationOutbox';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const persistence: PersistenceLayer = createPersistence();
export const appPersistence = persistence;

/**
 * Bind the credential vault to THIS persistence layer, before any route can
 * use it. Without this the vault would open its own store over the same
 * directory and the two writers would clobber each other.
 */
configureCredentialVault(persistence);

/**
 * ONE PropDAO adapter factory.
 *
 * The adapter resolves the caller's key from the vault on every operation, so
 * there is no long-lived cached client holding a decrypted secret and no code
 * path that can use one user's key for another user's request.
 */
function propDaoFor(userId: string): PropFundAccountProvider {
  return new PropFundAccountProvider({
    resolveApiKey: () => credentialVault.getCredential(userId, 'propdao'),
  });
}

const reasoningGateway = new UserScopedReasoningGateway(persistence.keys);
/**
 * Market data source: the Hyperliquid public info API (no API key required).
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
    : hyperliquidProvider;

if (marketProvider.dataMode === 'PAPER') {
  console.warn(
    '[api] MARKET_DATA_PROVIDER=paper — serving SIMULATED prices.',
  );
}

/**
 * IS THE APP RUNNING IN A SERVERLESS, EPHEMERAL RUNTIME?
 *
 * Vercel functions have a read-only filesystem apart from a small scratch
 * directory that is discarded on every cold start and on every deploy. Writing
 * market snapshots there produces files nobody ever reads and writes that
 * vanish without warning — the exact "silent local persistence" failure mode
 * this app must not have.
 *
 * `VERCEL` is injected by the platform; the others cover self-hosted serverless
 * deployments that would otherwise be detected too late.
 */
export function isEphemeralRuntime(): boolean {
  if (process.env.VERCEL) return true;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
  if (process.env.FUNCTION_TARGET) return true; // Google Cloud Functions
  if (process.env.NETLIFY) return true;
  return false;
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
 *
 * PERSISTENCE IS DISABLED ON SERVERLESS HOSTS.
 *
 * A snapshot written to an ephemeral filesystem is not persistence: it is
 * discarded on the next cold start, and it fails silently because the writer
 * swallows its own errors. On Vercel the canonical, durable home for market
 * state is the Cloudflare MarketDataDO — which is configured separately via
 * MARKET_DATA_WORKER_URL — so writing a shadow copy to local disk here would
 * create a second, divergent history rather than a cache.
 */
export const marketStateStore = new MarketStateStore(marketProvider, {
  ttlMs: 30_000,
  pollIntervalMs: 5_000,
  timeframe: '15m',
  candleCount: 120,
  ...(marketProvider.dataMode === 'LIVE' && !isEphemeralRuntime()
    ? { persist: new FileMarketStatePersistence() }
    : {}),
});

/**
 * CANONICAL MARKET DATA (one-minute candles, shared ingestion)
 * -------------------------------------------------------
 * The authoritative ingestion path. Every GOAT that wants candles for an
 * instrument reads them from here; NO GOAT opens its own provider connection.
 *
 * `MarketIngestionService` owns validation, idempotent upsert, per-partition
 * overlap suppression, provider backoff and freshness, plus the session
 * finalizer that converts completed sessions into durable summaries BEFORE
 * pruning their minutes.
 *
 * On Vercel this in-process instance is the same logic the Cloudflare
 * `MarketDataDO` runs; the DO is the durable owner in production and this
 * service is what serves a self-hosted or development deployment. Both
 * implement identical rules, so behaviour does not fork between environments.
 */
export const candleStorage = new MemoryCandleRepository();

export const marketIngestion = new MarketIngestionService({
  storage: candleStorage,
  source: marketProvider,
  retention: retentionPolicyFromEnv(),
});

/**
 * Authenticated client for the Cloudflare market-data Durable Objects.
 *
 * Disabled unless both the worker URL and the shared secret are configured —
 * there is deliberately no insecure fallback. `durableMarketDataClient.enabled`
 * is reported by /api/settings/status so an unconfigured deployment is never
 * mistaken for a working one.
 */
export const durableMarketDataClient = new DurableMarketDataClient(
  durableMarketDataEnvFromProcess(),
);

/**
 * Durable notification delivery.
 *
 * Replaces the inline fire-and-forget Telegram send. A notification is written
 * to the outbox BEFORE delivery, keyed by the logical decision, so a retried
 * wake cannot send a second message and a Telegram outage leaves a retryable
 * record rather than a lost alert.
 */
export const notificationOutbox = new NotificationOutbox({
  store: new MemoryOutboxStore(),
  deliverer: {
    deliver: async (record) => {
      const token =
        (await persistence.keys.getTelegramToken(record.userId)) ||
        process.env.TELEGRAM_BOT_TOKEN;

      if (!token) {
        /**
         * No credential is a PERMANENT failure, not a transient one. Retrying
         * would burn the attempt budget on something no retry can fix.
         */
        throw new Error('No Telegram bot token configured for this user.');
      }

      const chatId =
        (await persistence.profiles.get(record.userId))?.telegramChatId ||
        process.env.TELEGRAM_CHAT_ID;

      if (!chatId) {
        throw new Error('No Telegram chat id configured for this user.');
      }

      const result = await telegramService.sendMessage(
        chatId,
        record.body,
        token,
      );

      /**
       * `sendMessage` reports failure in its RESULT rather than by throwing,
       * because a Telegram 4xx is a normal response, not an exception. Throwing
       * here is what puts the record into the retry path instead of silently
       * marking a failed delivery as sent.
       */
      if (!result.ok) {
        throw new Error(result.description ?? 'Telegram delivery failed.');
      }

      const messageId =
        result.result && typeof result.result === 'object'
          ? String((result.result as { message_id?: number }).message_id ?? '')
          : '';

      /**
       * An empty message id means the acknowledgement could not be read. The
       * outbox records that as SENT_UNCONFIRMED and will NOT retry it, which is
       * the deliberate at-least-once choice documented in NotificationOutbox.
       */
      return { messageId };
    },
  },
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
 * Routes locally-ingested events to the same handler the Cloudflare runtime
 * calls.
 *
 * This was also missing: `onEvent()` had no listener, so a candle finalized by
 * the in-process ingestion service produced no wake at all. Without it the
 * app only reacted to alarms, which is what made "the market moved and nothing
 * happened" so hard to explain.
 */
marketIngestion.onEvent((event: MarketEvent) => {
  void routeMarketEvent(event).catch((err) => {
    console.error('[market-event] local routing failed:', err);
  });
});

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

function ensureGoatRuntime(goat: FundGoat) {
  subscribeToMarkets(goat);
  const attached = allSkillsFor(goat.userId).then((skills) =>
    skills.filter((s) => goat.skillIds.includes(s.id)),
  );
  return attached.then((attachedSkills) =>
    durableObjectRegistry.getOrCreate(goat, attachedSkills, runtimeOptions),
  );
}

/**
 * Registers a GOAT with the shared ingestion layer and mirrors it into the
 * Cloudflare runtime.
 *
 * THIS WAS MISSING ENTIRELY.
 *
 * `MarketIngestionService.subscribe()` was only ever called from tests, so:
 *   - the in-process subscription table was always empty, meaning
 *     `routeMarketEvent()` considered zero subscribers and every market event
 *     was dropped as irrelevant;
 *   - `syncDurableSubscriptions()` iterated an empty list, so
 *     `MarketDataDO` never received a single subscription — and since it derives
 *     its instrument list from that table, the shared store had nothing to
 *     ingest.
 *
 * Registering here, at the single point every GOAT passes through, means a new
 * GOAT is watched whether or not anything else touched it.
 */
function subscribeToMarkets(goat: FundGoat): void {
  /**
   * A PAUSED GOAT IS UNSUBSCRIBED.
   *
   * Dormancy waits for events; stopping means the workflow does not run. A
   * stopped GOAT must therefore be removed from the routing table, not left in
   * it to ignore every event it receives. That also stops the shared runtime
   * ingesting a market nobody is watching.
   */
  if (goat.status === 'PAUSED') {
    marketIngestion.unsubscribeAll(goat.id);
    return;
  }

  for (const instrument of goat.markets) {
    marketIngestion.subscribe({
      subscriberId: goat.id,
      instrument,
      eventTypes: ['CANDLE_FINALIZED', 'SESSION_FINALIZED', 'DATA_STALE'],
    });
  }

  /**
   * Mirror into the durable runtime so the Worker knows what to ingest.
   *
   * Fire-and-forget: a GOAT must be creatable when the Worker is unreachable,
   * and `describe()` on the client reports `lastError` so the failure is
   * visible rather than silent.
   */
  if (durableMarketDataClient.isEnabled) {
    void syncDurableSubscriptions(
      marketIngestion.listSubscriptions(),
    ).catch((err) => {
      console.error('[api] durable subscription sync failed:', err);
    });
  }
}

async function allSkillsFor(userId: string) {
  const userSkills = await persistence.skills.listByUser(userId);
  const defaults = DEFAULT_SKILLS.filter((d) => !userSkills.some((s) => s.id === d.id));
  return [...defaults, ...userSkills];
}

/**
 * Stale-market migration.
 *
 * GOATs saved under the previous provider reference conventional symbols
 * (`EUR/USD`, `GBP/USD`, `XAU/USD`, `US500`, `WTI`) that the current venue
 * does not list. Left alone, each of those markets produces an endless
 * "not a market Hyperliquid lists" degrade loop. This rewrites the persisted
 * market list to the venue's actual instruments — deliberately a MIGRATION of
 * the market identifiers, not a reset: names, goals, skills, schedules,
 * theses and signals are untouched.
 */
const STALE_MARKET_REPLACEMENTS: Record<string, string> = {
  'EUR/USD': 'xyz:EUR',
  'GBP/USD': 'xyz:GBP',
  'USD/JPY': 'xyz:JPY',
  'XAU/USD': 'xyz:GOLD',
  'XAG/USD': 'xyz:SILVER',
  GOLD: 'xyz:GOLD',
  SLV: 'xyz:SILVER',
  WTI: 'xyz:CL',
  CL: 'xyz:CL',
};

/** Markets that must exist on the venue before they can be substituted in. */
const KNOWN_LISTED_MARKETS = new Set([
  ...DEFAULT_MARKET_UNIVERSE.map((s) => s.toUpperCase()),
  ...Object.values(STALE_MARKET_REPLACEMENTS).map((s) => s.toUpperCase()),
]);

/**
 * Rewrites a GOAT's markets that reference retired symbols.
 *
 * Returns a NEW Goat record when anything changed; otherwise the original.
 * A market is dropped entirely when there is no sensible venue equivalent
 * (there is no fabricated alias), and the remaining markets are kept.
 */
export function migrateGoatMarkets(goat: FundGoat): FundGoat | null {
  const migrated = goat.markets.map((market) => {
    const replacement = STALE_MARKET_REPLACEMENTS[market.toUpperCase()];
    if (!replacement) return market;
    return KNOWN_LISTED_MARKETS.has(replacement.toUpperCase()) ? replacement : market;
  });

  const unique = [...new Set(migrated)];
  if (unique.every((m) => goat.markets.includes(m)) && unique.length === goat.markets.length) {
    return null;
  }
  if (unique.length === 0) return null;

  return {
    ...goat,
    markets: unique,
    updatedAt: new Date().toISOString(),
  };
}

/** Restart recovery: rebuild runtime actors for every persisted GOAT. */
export async function restoreRuntimes(): Promise<void> {
  try {
    /**
     * Warm the instrument catalogue BEFORE restoring GOATs.
     *
     * GOAT runtimes validate their markets against the catalogue synchronously
     * on attach; warming it here means that validation is against the venue's
     * real universe rather than an empty cold-start cache.
     */
    await marketProvider.getSymbols().catch(() => {
      // A provider outage must not stop restart recovery; GOATs restore and
      // their listeners retry the catalogue (see GoatDurableObject).
    });

    const goats = await persistence.goats.listAll();
    for (const goat of goats) {
      /**
       * One-time in-memory migration pass.
       *
       * The rewrite is applied in memory AND persisted; migrating only in
       * memory would re-add the dead symbol on the restart after next. The
       * goat's other fields are untouched.
       */
      const migrated = migrateGoatMarkets(goat);
      if (migrated) {
        await persistence.goats.save(migrated);
        console.log(
          `[api] Migrated markets for goat ${goat.id}: ${goat.markets.join(', ')} -> ${migrated.markets.join(', ')}`,
        );
      }

      if (goat.status !== 'PAUSED') {
        await ensureGoatRuntime(migrated ?? goat);
      }
    }
    console.log(`[api] Restored ${goats.length} GOAT runtime(s) from persistence.`);
  } catch (err) {
    console.error('[api] Failed to restore GOAT runtimes:', err);
  }
}

/**
 * Rebuilds the subscription table and re-publishes every schedule.
 *
 * Called at boot on a long-lived host AND by `/api/internal/reconcile` on a
 * serverless one, because a cold start destroys the in-memory subscription
 * cache. Without it, a fresh container would wake nobody until each GOAT was
 * individually touched.
 *
 * Idempotent, and safe to run concurrently with live traffic.
 */
export async function reconcileRuntime(): Promise<{
  goats: number;
  subscriptions: number;
  durableSynced: number;
}> {
  const goats = await persistence.goats.listAll();

  const subscriptions: IngestionSubscription[] = [];
  for (const goat of goats) {
    if (goat.status === 'PAUSED') continue;
    for (const instrument of goat.markets) {
      subscriptions.push({
        subscriberId: goat.id,
        instrument,
        eventTypes: ['CANDLE_FINALIZED', 'SESSION_FINALIZED', 'DATA_STALE'],
      });
    }
  }

  const restored = marketIngestion.rebuildSubscriptions(subscriptions);
  const durableSynced = await syncDurableSubscriptions(subscriptions);

  return { goats: goats.length, subscriptions: restored, durableSynced };
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

  /**
   * Persist the notification intent BEFORE any send.
   *
   * The idempotency key is the signal's own id, so a retried wake that
   * re-derives the same logical decision is suppressed here rather than
   * producing a second Telegram message.
   */
  try {
    const { id, created } = await notificationOutbox.enqueue({
      goatId: goat.id,
      userId: goat.userId,
      kind: 'SIGNAL',
      subjectId: signal.id,
      body: telegramService.formatSignalMessage(signal, goat.name),
    });

    /**
     * A duplicate logical signal is suppressed entirely — including its recap
     * event, because recording the same decision twice would be the same
     * duplication one layer up.
     */
    if (!created) return;

    await notificationOutbox.deliverOne(id);
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
 *
 * The key includes the candle open time when one is available, so the SAME
 * tracker firing on the SAME bar is delivered once, while the same tracker
 * legitimately firing on a later bar is a new notification.
 */
durableObjectRegistry.onTrackerTriggered(async (goat, report) => {
  try {
    const { id, created } = await notificationOutbox.enqueue({
      goatId: goat.id,
      userId: goat.userId,
      kind: 'TRACKER_TRIGGERED',
      subjectId: report.tracker.id,
      candleOpenTimeMs: report.evaluatedCandleMs ?? null,
      body: telegramService.formatTrackerTriggerMessage(goat.name, {
        description: report.tracker.description,
        market: report.tracker.market || goat.markets[0] || '—',
        formula: report.formulaDescription,
        calculatedValue: report.calculatedValue,
      }),
    });

    if (created) await notificationOutbox.deliverOne(id);

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
/* Market event routing                                                */
/* ------------------------------------------------------------------ */

/**
 * Routes one market event to the GOATs that care about it.
 *
 * The filtering is the reason this is event-driven rather than poll-driven:
 *
 *   1. A GOAT that is STOPPED is skipped outright. Dormancy means "wait for a
 *      relevant event"; stopping means "do not run the workflow", and conflating
 *      the two is how a stopped GOAT quietly wakes.
 *   2. An event for an instrument the GOAT does not watch is skipped, so
 *      unrelated market activity costs nothing and triggers no model call.
 *   3. An event id already processed is skipped, so a redelivered candle cannot
 *      produce a second wake, a second signal or a second Telegram message.
 *   4. Only then is a wake scheduled, and only for tracker-relevant events.
 *
 * One GOAT failing is contained: each is routed in its own try/catch, so a
 * broken runtime cannot stop the others from being woken.
 */
export async function routeMarketEvent(
  event: MarketEvent,
): Promise<{
  considered: number;
  woke: number;
  duplicates: number;
  irrelevant: number;
  stopped: number;
}> {
  const seen = marketEventDedup(event.eventId);
  if (!seen) {
    return { considered: 0, woke: 0, duplicates: 1, irrelevant: 0, stopped: 0 };
  }

  const goatIds = marketIngestion
    .listSubscriptions()
    .filter((subscription) => subscription.instrument === event.instrument)
    .map((subscription) => subscription.subscriberId);

  let woke = 0;
  let irrelevant = 0;
  let stopped = 0;

  for (const goatId of goatIds) {
    try {
      const goat = await persistence.goats.get(goatId);
      if (!goat || goat.status === 'PAUSED') {
        stopped += 1;
        continue;
      }

      /**
       * Only events the GOAT's own trackers care about may wake it. A
       * session-finalized notice for a market it does not trade must not cost
       * a model call.
       */
      const runtime = durableObjectRegistry.get(goatId);
      const hasRelevantTracker = Boolean(
        runtime?.getState().trackers.some(
          (tracker) => tracker.market === event.instrument || !tracker.market,
        ),
      );

      if (event.type !== 'DATA_STALE' && event.type !== 'DATA_RECOVERED' && !hasRelevantTracker) {
        irrelevant += 1;
        continue;
      }

      const state = await marketStateStore.getState(
        event.instrument,
        normaliseTrackingTimeframe(goat.timeframe),
      );

      /**
       * A tracker wake from DEGRADED or UNAVAILABLE data is refused. A stale
       * price must never be able to satisfy a condition.
       */
      if (!isUsableMarketState(state)) {
        irrelevant += 1;
        continue;
      }

      if (event.type === 'DATA_STALE') {
        // Informational only: record the fact, spend no tokens.
        irrelevant += 1;
        continue;
      }

      const active = durableObjectRegistry.get(goatId) ?? (await ensureGoatRuntime(goat));

      await active.wake(
        `Market event: ${event.type} on ${event.instrument}`,
        'TRACKER_TRIGGERED',
        event.instrument,
        { eventId: event.eventId },
      );

      woke += 1;
    } catch (err) {
      // Containment is the point: one GOAT must not block the rest.
      console.error(`[market-event] routing failed for ${goatId}:`, err);
    }
  }

  return {
    considered: goatIds.length,
    woke,
    duplicates: 0,
    irrelevant,
    stopped,
  };
}

/**
 * Bounded, in-memory duplicate suppression for event ids.
 *
 * A Map with a hard cap rather than an unbounded Set: an unbounded id cache is
 * exactly the "growing history in memory" problem the storage policy exists to
 * prevent. At the cap, the oldest half is dropped — losing an old dedupe entry
 * is safe because the per-GOAT candle cursor still suppresses the replay.
 */
const processedEventIds = new Map<string, number>();
const EVENT_ID_CACHE_LIMIT = 10_000;

function marketEventDedup(eventId: string): boolean {
  const now = Date.now();

  /**
   * A very old id can no longer be in flight; expiring it keeps the cache
   * bounded without weakening the guarantee that matters (near-term replay).
   */
  for (const [id, seenAt] of processedEventIds) {
    if (now - seenAt > 6 * 60 * 60_000) processedEventIds.delete(id);
  }

  if (processedEventIds.has(eventId)) return false;

  processedEventIds.set(eventId, now);

  if (processedEventIds.size > EVENT_ID_CACHE_LIMIT) {
    const entries = [...processedEventIds.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, EVENT_ID_CACHE_LIMIT / 2);
    for (const [id] of entries) processedEventIds.delete(id);
  }

  return true;
}

/**
 * Mirrors the in-process subscription table into the Cloudflare runtime.
 *
 * Failure is non-fatal by design: the in-process path still works, and the
 * status endpoint reports the durable sync count so an unreachable Worker is
 * visible rather than silently degrading event delivery.
 */
async function syncDurableSubscriptions(
  subscriptions: readonly IngestionSubscription[],
): Promise<number> {
  if (!durableMarketDataClient.isEnabled) return 0;

  let synced = 0;

  for (const subscription of subscriptions) {
    const partition = MarketIngestionService.partitionFor(
      subscription.instrument,
    ) as DurablePartition;

    const result = await durableMarketDataClient.subscribe({
      partition,
      subscriberId: subscription.subscriberId,
      instrument: subscription.instrument,
      eventTypes: subscription.eventTypes,
    });

    if (result.ok) synced += 1;
  }

  return synced;
}

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
      /**
       * ONCE A RESPONSE IS COMMITTED, THIS MIDDLEWARE CHAIN IS OVER.
       *
       * The previous version called `next()` unconditionally after writing a
       * response. In development `server.ts` mounts Vite's middleware stack
       * AFTER this router, so `next()` handed an already-sent response to
       * Vite's `corsMiddleware` -> `applyHeaders`, which calls
       * `res.setHeader()`. That throws `ERR_HTTP_HEADERS_SENT`, and Vite
       * surfaces it as a full-screen overlay — which is why simply opening
       * Backtest (whose route can fail, e.g. on an unknown market) covered
       * the screen with a CORS error that had nothing to do with CORS.
       *
       * Every branch below therefore returns after responding, and an
       * already-sent response short-circuits before anything else is touched.
       */
      if (res.headersSent) return;

      if (err instanceof NotFoundError) {
        notFound(res);
        return;
      }

      console.error('[api] Unhandled route error:', err);

      /**
       * Caller-supplied bad input -> 400 with the real message.
       * Upstream provider failure -> 502, not an opaque 500, so the UI can
       * explain it (and distinguish it from the caller's own mistake).
       */
      if (err instanceof CredentialValidationError) {
        fail(res, 400, err.code, err.message);
        return;
      }

      const upstream = err instanceof ApiRequestError;
      fail(
        res,
        upstream ? 502 : 500,
        upstream ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR',
        upstream ? err.message : 'An internal error occurred.',
      );
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
function scheduleGeneration(goat: FundGoat): string {
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
  goat: FundGoat,
  from: number = Date.now(),
): number | null {
  if (goat.status === 'PAUSED') return null;

  const timeframe = normaliseTrackingTimeframe(goat.timeframe);
  return from + pollIntervalForTimeframe(timeframe);
}

function computeNextWakeAt(
  goat: FundGoat,
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
async function syncSchedule(goat: FundGoat): Promise<void> {
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
/* Internal market-data routes                                         */
/* ------------------------------------------------------------------ */

/**
 * Shared-secret auth for internal endpoints.
 *
 * These are called by the Cloudflare Durable Object, which has no user session
 * and cannot present a Firebase ID token. The secret authenticates the
 * WORKER, not a user, and every handler below still resolves the GOAT through
 * the application persistence layer and its owner — so an internal caller can
 * never widen access beyond what the owner already has.
 */
function internalAuth(req: Request, res: Response): boolean {
  const expected = process.env.DURABLE_SCHEDULER_SECRET?.trim();
  const provided = req.header('x-scheduler-secret') ?? '';

  if (!expected || provided !== expected) {
    fail(res, 401, 'UNAUTHORISED', 'Invalid scheduler secret.');
    return false;
  }

  return true;
}

/**
 * Accepts a market event from the shared runtime and routes it to subscribed
 * GOATs.
 *
 * The event is VALIDATED and its id RECOMPUTED before anything acts on it: a
 * malformed or altered event is dropped, never partially applied. Duplicate
 * suppression happens on the event id, so the same candle delivered twice wakes
 * nothing twice.
 */
apiRouter.post('/internal/market-event', handle(async (req, res) => {
  if (!internalAuth(req, res)) return;

  const event = validateMarketEvent(req.body);
  if (!event) {
    return fail(
      res,
      400,
      'INVALID_EVENT',
      'Market event failed validation or its id did not match its payload.',
    );
  }

  const result = await routeMarketEvent(event);

  res.json({
    handled: true,
    eventId: event.eventId,
    subscribersConsidered: result.considered,
    wokeGoats: result.woke,
    ignoredAsDuplicate: result.duplicates,
    ignoredAsIrrelevant: result.irrelevant,
    filteredAsStopped: result.stopped,
  });
}));

/**
 * Reconciles a market-data runtime: rebuilds this process's view of
 * subscriptions from durable records.
 *
 * Called at boot on a serverless host, where the in-memory subscription table
 * is destroyed on every cold start. Without this, a fresh container would wake
 * nobody until each GOAT happened to be touched again.
 */
apiRouter.post('/internal/reconcile', handle(async (req, res) => {
  if (!internalAuth(req, res)) return;

  /**
   * CRON RECONCILIATION
   *
   * The Cloudflare Worker's `scheduled()` handler calls this on a timer. It
   * re-publishes every non-paused GOAT's authoritative schedule.
   *
   * This is the recovery half of `GoatSchedulerDO`'s deliberate choice not to
   * re-arm after a failed delivery. That choice prevents a hot retry loop
   * against a down app; without this endpoint it also meant one transient
   * failure stopped a GOAT's schedule permanently — the GOAT reported healthy
   * and simply never woke again.
   *
   * Safe to call as often as the cron fires: `DurableObjectScheduler.sync()`
   * treats a re-publish of an unchanged generation as a no-op, and a DO that
   * already holds the same generation answers `unchanged: true`.
   */
  const goats = await persistence.goats.listAll();

  let republished = 0;
  let failed = 0;

  for (const goat of goats) {
    // syncSchedule never throws, so a failure is reported through the count.
    await syncSchedule(goat);
    if (scheduler.health().lastError) failed += 1;
    else republished += 1;
  }

  /**
   * Rebuild the market subscription table in the same pass.
   *
   * The subscription table is in-memory, so a Vercel cold start leaves it
   * empty: every market event would be dropped as irrelevant until each GOAT
   * happened to be touched again. Reconciling schedules without subscriptions
   * would fix the alarms and leave events still dead.
   */
  const runtime = await reconcileRuntime();

  res.json({
    handled: true,
    goatsConsidered: goats.length,
    republished,
    failed,
    subscriptionsRestored: runtime.subscriptions,
    durableSubscriptionsSynced: runtime.durableSynced,
    scheduler: scheduler.health(),
  });
}));

apiRouter.post('/internal/market-sync', handle(async (_req, res) => {
  if (!internalAuth(_req, res)) return;

  const goats = await persistence.goats.listAll();
  const subscriptions: IngestionSubscription[] = [];

  for (const goat of goats) {
    // A stopped GOAT is never subscribed: dormancy waits for events, stopping
    // means it does not run its workflow at all.
    if (goat.status === 'PAUSED') continue;

    for (const instrument of goat.markets) {
      subscriptions.push({
        subscriberId: goat.id,
        instrument,
        eventTypes: ['CANDLE_FINALIZED', 'SESSION_FINALIZED', 'DATA_STALE'],
      });
    }
  }

  const restored = marketIngestion.rebuildSubscriptions(subscriptions);
  const durableSynced = await syncDurableSubscriptions(subscriptions);

  res.json({
    restored,
    durableSynced,
    byPartition: marketIngestion.subscriptionCounts(),
    dataMode: marketProvider.dataMode,
  });
}));

/**
 * Observability for the shared market-data layer.
 *
 * Reports freshness, staleness, session-finalization state, prune counts,
 * subscription counts and durable-runtime health. Contains no secrets and no
 * market payloads, so it is safe to poll.
 */
apiRouter.get('/markets/ingestion', handle(async (_req, res) => {
  res.json({
    ...marketIngestion.health(),
    durableRuntime: durableMarketDataClient.describe(),
  });
}));

/**
 * Session geometry for an instrument, with the UTC offset that applies RIGHT
 * NOW. Lets an operator verify the DST handling is correct in production rather
 * than trusting the source.
 */
apiRouter.get('/markets/session', handle(async (req, res) => {
  const instrument = String(req.query.symbol ?? '').trim().toUpperCase();

  if (!instrument) {
    return fail(res, 400, 'INVALID_INPUT', 'symbol is required.');
  }

  if (!/^[A-Z0-9/_:-]{1,64}$/.test(instrument)) {
    return fail(res, 400, 'INVALID_INPUT', 'symbol must be a known instrument id (HIP-3 symbols like xyz:GOLD are allowed).');
  }

  res.json({
    ...describeSessionSpec(instrument, Date.now()),
    resolved: resolveSession(instrument, Date.now()),
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
    /**
     * Shared one-minute ingestion: freshness, staleness, subscription counts,
     * finalization and prune totals. Reported here so "why did this GOAT not
     * wake" is answerable without log archaeology.
     */
    marketIngestion: {
      stats: marketIngestion.stats,
      subscriptions: marketIngestion.subscriptionCounts(),
      subscriptionTotal: marketIngestion.totalSubscriptions(),
      freshness: marketIngestion
        .allFreshness()
        .map((state) => ({
          instrument: state.instrument,
          partition: state.partition,
          lastSuccessfulIngestAtMs: state.lastSuccessfulIngestAtMs,
          lastCandleOpenTimeMs: state.lastCandleOpenTimeMs,
          dataLagSeconds: state.dataLagSeconds,
          consecutiveFailures: state.consecutiveFailures,
          stale: state.stale,
          marketOpen: state.marketOpen,
          lastError: state.lastError,
        })),
    },
    /**
     * Durable market runtime (Cloudflare). `configured: false` is reported
     * honestly rather than omitted, so a deployment without the Worker is never
     * mistaken for one where retention and finalization are running.
     */
    durableMarketData: durableMarketDataClient.describe(),
    /**
     * Whether this process may write to a local filesystem. False on Vercel and
     * other ephemeral hosts, where a "persisted" file would vanish on the next
     * cold start.
     */
    filesystemPersistence: isEphemeralRuntime() ? 'disabled' : 'enabled',
    notifications: await notificationOutbox.health(),
  });
});

// Market data reads are public (paper feed, no secrets).
apiRouter.get('/markets/symbols', handle(async (_req, res) => {
  const symbols = await marketProvider.getSymbols();
  res.json({ symbols, provider: marketProvider.name, dataMode: marketProvider.dataMode });
}));

/**
 * MARKET DISCOVERY AND SEARCH
 *
 * The full instrument universe, from live provider metadata.
 *
 * This exists because the tracked default universe is deliberately small (one
 * `candleSnapshot` per instrument per minute against a 1200-weight/minute
 * budget). Search has to reach BEYOND it, or a user who wants an instrument
 * we do not poll would simply never find it.
 *
 *   GET /markets/search          -> the whole discovered universe
 *   GET /markets/search?q=BTC    -> filtered, ranked
 *
 * `?q` is matched case-insensitively against both the provider's coin name and
 * the curated display name, so "gold" finds `xyz:GOLD` and "aapl" finds
 * `xyz:AAPL`. Delisted instruments are excluded: they return no candles, so
 * offering them would be a dead end.
 *
 * Returns only provider-derived data. No conventional symbol is synthesised:
 * EURUSD, XAUUSD and SPX are absent from this list unless Hyperliquid actually
 * lists them.
 */
apiRouter.get('/markets/search', handle(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  try {
    const markets =
      query.length > 0
        ? await hyperliquidProvider.searchInstruments(query, limit)
        : tradableMarkets(await hyperliquidProvider.listMarketsCached(HYPERLIQUID_DEXES)).slice(0, limit);

    res.json({
      markets,
      total: markets.length,
      query,
      provider: marketProvider.name,
      dataMode: marketProvider.dataMode,
    });
  } catch (error) {
    // Discovery is an ENRICHMENT of the app, not a prerequisite for it. A
    // provider outage degrades search; it does not take down the product.
    return fail(
      res,
      503,
      'MARKET_DISCOVERY_UNAVAILABLE',
      `Instrument search is temporarily unavailable: ${
        error instanceof Error ? error.message : 'the provider could not be reached'
      }`,
    );
  }
}));

apiRouter.get('/markets/quotes', handle(async (req, res) => {
  const symbolsParam = req.query.symbols as string | undefined;
  const requested = symbolsParam ? symbolsParam.split(',').slice(0, 50) : (await marketProvider.getSymbols()).map((s) => s.symbol);
  const quotes = await marketProvider.getQuotes(requested);
  res.json({ quotes, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/markets/quote', handle(async (req, res) => {
  // No default symbol: an omitted symbol is a client bug and must be reported
  // as one, rather than silently fetching an instrument the venue may not list.
  const symbol = (req.query.symbol as string) || '';
  if (!symbol) {
    return fail(res, 400, 'INVALID_INPUT', 'symbol is required.');
  }
  const quote = await marketProvider.getQuote(symbol);
  res.json({ quote, dataMode: marketProvider.dataMode });
}));

apiRouter.get('/markets/candles', handle(async (req, res) => {
  const symbol = (req.query.symbol as string) || '';
  if (!symbol) {
    return fail(res, 400, 'INVALID_INPUT', 'symbol is required.');
  }
  const timeframe = (req.query.timeframe as string) || '1h';
  const count = Math.min(1000, Math.max(1, parseInt(req.query.count as string, 10) || 60));
  const candles = await marketProvider.getCandles(symbol, timeframe, count);
  res.json({ symbol, timeframe, candles, dataMode: marketProvider.dataMode });
}));

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */

/**
 * The signed update ids this process has already handled.
 *
 * Telegram retries an update until it receives a 2xx, so the SAME
 * `update_id` can arrive more than once. Combined with commands that spend AI
 * (`/trigger`, `/analyse`) or mutate state (`/pause`), a duplicate would be a
 * real, charged, duplicated action.
 *
 * Bounded and in-memory, like every other cache in this process. On a Vercel
 * cold start the window is empty, so a retry arriving after a cold start is
 * NOT suppressed — see the note on `telegramWebhookDedup` about why that
 * residual risk is accepted rather than papered over with an unbounded store.
 */
const handledTelegramUpdates = new Set<number>();
const TELEGRAM_UPDATE_CACHE_LIMIT = 2_000;

function claimTelegramUpdate(updateId: number): boolean {
  if (handledTelegramUpdates.has(updateId)) return false;

  handledTelegramUpdates.add(updateId);

  if (handledTelegramUpdates.size > TELEGRAM_UPDATE_CACHE_LIMIT) {
    const oldest = handledTelegramUpdates.values().next().value;
    if (oldest !== undefined) handledTelegramUpdates.delete(oldest);
  }

  return true;
}

/** For tests. */
export function resetTelegramUpdateCache(): void {
  handledTelegramUpdates.clear();
}

/**
 * Per-chat command rate limit.
 *
 * A bot token is a credential and the webhook URL is public, so an endpoint
 * that can spend a user's AI credits must be bounded. Cheap commands (listing,
 * help) and expensive ones (`/trigger`, `/analyse`) share one budget: simple
 * and uniform, and the expensive path is additionally protected by
 * `decide()` on the scheduler side.
 */
const telegramRateLimiter = new TelegramRateLimiter({
  windowMs: 60_000,
  maxPerWindow: 10,
});

/** Commands that spend AI or change state, so their failure must be reported. */
const TELEGRAM_EXPENSIVE_COMMANDS = new Set(['/trigger', '/analyse']);

/**
 * Resolves the OWNING USER for a chat.
 *
 * Every command path starts here, so ownership is decided in exactly one place
 * from the persisted chat->user mapping. The chat id is the caller's Telegram
 * identity, NOT an authorisation decision: a user can only speak for the chat
 * their account registered, because Telegram delivers the update to the bot
 * that chat actually messaged.
 */
async function ownerForChat(
  chatId: string,
): Promise<{ userId: string; chatId: string } | null> {
  const profile = await persistence.profiles.findByTelegramChatId(String(chatId));
  if (!profile) return null;
  return { userId: profile.id, chatId: String(chatId) };
}

/**
 * Resolves a process BY ID for a chat's owner.
 *
 * Uses `getForUser`, so a process belonging to somebody else returns null and
 * is indistinguishable from one that does not exist. The caller cannot be used
 * to probe for other users' process ids.
 */
async function resolveOwnedProcess(
  chatId: string,
  processId: string,
): Promise<{ goat: FundGoat; runtime: GoatRuntimeState } | null> {
  const owner = await ownerForChat(chatId);
  if (!owner) return null;

  const goat = await persistence.goats.getForUser(processId, owner.userId);
  if (!goat) return null;

  const runtime = await ensureGoatRuntime(goat);
  return { goat, runtime: runtime.getState() };
}

/** Every process the chat's owner may act on. */
async function listOwnedProcesses(
  chatId: string,
): Promise<TelegramProcessSummary[]> {
  const owner = await ownerForChat(chatId);
  if (!owner) return [];

  const goats = await persistence.goats.listByUser(owner.userId);
  return goats.map((goat) => ({
    id: goat.id,
    name: goat.name,
    markets: goat.markets,
    status: goat.status,
    timeframe: normaliseTrackingTimeframe(goat.timeframe),
    model: goat.model,
  }));
}

/**
 * Builds the runtime + context a named command needs.
 *
 * Only called AFTER ownership has been established by `resolveOwnedProcess`,
 * so the reasoning context handed to a model always belongs to the caller's own
 * process.
 */
async function buildCommandResolution(
  goat: FundGoat,
  userId: string,
): Promise<{
  resolution: TelegramResolution;
  runtime: ReturnType<typeof ensureGoatRuntime> extends Promise<infer T> ? T : never;
}> {
  const runtime = await ensureGoatRuntime(goat);
  const skills = (await allSkillsFor(userId)).filter((s) =>
    goat.skillIds.includes(s.id),
  );
  const ctx = await buildGoatContext(
    { goats: persistence.goats, skills: persistence.skills, marketProvider },
    goat.id,
    userId,
  );

  return {
    runtime,
    resolution: {
      goat: {
        id: goat.id,
        userId: goat.userId,
        name: goat.name,
        model: goat.model,
      },
      state: runtime.getState(),
      reasoningContext: {
        ...ctx.context,
        activeThesis: runtime.getState().currentThesis,
      },
      model: ctx.model,
      gateway: reasoningGateway,
      requestAnalysis: async (reason: string) =>
        buildAnalysisSummary(await runtime.wake(reason, 'MANUAL_REEVALUATE'), goat),
    },
  };
}

/**
 * Renders a completed analysis for Telegram.
 *
 * Drawn entirely from the runtime state that was just produced, so it reports
 * what happened rather than what was hoped for.
 */
function buildAnalysisSummary(state: GoatRuntimeState, goat: FundGoat): string {
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

  lines.push(signal ? telegramService.formatSignalMessage(signal, goat.name) : 'No decision produced.');
  lines.push('');
  lines.push(`Conditions armed: ${state.trackers.length} · met: ${triggered}`);
  lines.push(
    state.trackers
      .map((t) => `${t.isTriggered ? '✅' : '⏳'} ${t.formulaDescription ?? t.description}`)
      .join('\n'),
  );

  if (state.lastError) {
    lines.push(`\n_Last error: ${state.lastError.slice(0, 200)}_`);
  }

  return lines.join('\n');
}

/**
 * `/create <goal> <market> [timeframe]`
 *
 * The goal is free text and the market is the LAST whitespace-delimited token
 * that parses as an instrument, with an optional trailing timeframe. That keeps
 * a multi-word goal usable without quoting, which is what people actually type
 * in a chat.
 */
async function createProcessFromTelegram(
  chatId: string,
  args: string,
): Promise<{ ok: boolean; message: string }> {
  const owner = await ownerForChat(chatId);
  if (!owner) {
    return { ok: false, message: 'This chat is not linked to a FundAGoat account.' };
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return {
      ok: false,
      message:
        'Usage: `/create <goal> <market> [timeframe]`\n' +
        'Example: `/create wait for a London sweep on BTC 5m`',
    };
  }

  const tokens = trimmed.split(/\s+/);
  let timeframe: TrackingTimeframe | undefined;
  let market: string | undefined;

  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && isTrackingTimeframe(last)) {
    timeframe = last as TrackingTimeframe;
    market = tokens[tokens.length - 2];
    tokens.splice(-2, 2);
  } else {
    market = last;
    tokens.splice(-1, 1);
  }

  const goal = tokens.join(' ').trim();
  const instrument = String(market ?? '').trim().toUpperCase();

  /**
   * The market is validated against the provider's own symbol list rather than
   * a regex. A GOAT watching a symbol the feed does not serve would never
   * produce data, and that failure would only surface as a silent no-signal.
   */
  const known = await marketProvider.getSymbols();
  const match = known.find((s) => s.symbol.toUpperCase() === instrument);

  if (!goal || !match) {
    return {
      ok: false,
      message:
        `I could not read that. Supported markets include: ` +
        `${known.slice(0, 8).map((s) => s.symbol).join(', ')}.\n\n` +
        'Usage: `/create <goal> <market> [1m|5m|15m|1h|4h]`',
    };
  }

  const name = goal.length > 60 ? `${goal.slice(0, 57)}…` : goal;

  const goat: FundGoat = {
    id: `goat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: owner.userId,
    name,
    goal,
    markets: [match.symbol],
    skillIds: ['skill_price_action'],
    model: (await defaultModelFor(owner.userId)),
    status: 'WATCHING',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: timeframe ?? '15m',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistence.goats.save(goat);
  await syncSchedule(goat);

  /**
   * The initial analysis is NOT awaited into the Telegram reply.
   *
   * `/trigger` is the explicit way to spend AI, and Telegram gives a bot no
   * reliable long-poll window for a slow reply. Creating a process therefore
   * confirms immediately and starts the pipeline in the background, exactly as
   * the web app does.
   */
  const runtime = await ensureGoatRuntime(goat);
  void runtime
    .wake('Created from Telegram', 'MANUAL_REEVALUATE', match.symbol)
    .catch((err) => {
      console.error('[telegram] initial analysis failed:', err);
    });

  return {
    ok: true,
    message:
      `🐐 Created *${name}*\n\n` +
      `id: \`${goat.id}\`\n` +
      `market: ${match.symbol} · timeframe: ${goat.timeframe}\n\n` +
      'First analysis is running. You will be alerted when a condition is met.\n' +
      '_Use /pause ' + goat.id + ' to stop it._',
  };
}

/** The model a new process should use: the owner's, or a sane default. */
async function defaultModelFor(userId: string): Promise<string> {
  const goats = await persistence.goats.listByUser(userId);
  const existing = goats.find((g) => g.status !== 'PAUSED')?.model;
  if (existing) return existing;
  return 'openai/gpt-4o-mini';
}

/** Telegram webhook: secret-validated, payload-validated, deduplicated. */
apiRouter.post('/telegram/webhook', handle(async (req, res) => {
  /**
   * THE WEBHOOK SECRET IS NOT OPTIONAL.
   *
   * It used to be checked only when `TELEGRAM_WEBHOOK_SECRET` was set, which
   * means an unset secret produced an OPEN webhook: anyone who learned the URL
   * could post a fake Telegram update and drive every linked user's processes.
   *
   * Each user's own bot is registered with a PER-BOT secret derived from the
   * deployment secret (see `telegramWebhookSecretFor`), so all bots share one
   * configured root and none of them is unauthenticated.
   */
  const rootSecret = resolveTelegramWebhookSecret();
  if (!rootSecret) {
    return fail(
      res,
      503,
      'TELEGRAM_NOT_CONFIGURED',
      'Telegram webhook is not configured on this server. Set TELEGRAM_WEBHOOK_SECRET.',
    );
  }

  const provided = req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeStringEqual(provided, rootSecret)) {
    return fail(res, 401, 'UNAUTHORIZED_WEBHOOK', 'Invalid webhook secret.');
  }

  const update = req.body;
  if (
    typeof update !== 'object' ||
    update === null ||
    !('update_id' in (update as object))
  ) {
    return fail(res, 400, 'INVALID_UPDATE', 'Payload is not a valid Telegram update.');
  }

  const updateId = Number((update as { update_id: unknown }).update_id);
  if (Number.isFinite(updateId) && !claimTelegramUpdate(updateId)) {
    /**
     * Already handled. Telegram only stops retrying on a 2xx, so acknowledging
     * a duplicate is correct: re-running the command would spend AI again.
     */
    res.json({ handled: true, duplicate: true, updateId });
    return;
  }

  const chatId = extractChatId(update);
  if (chatId && !telegramRateLimiter.allow(chatId)) {
    const retryAfter = telegramRateLimiter.retryAfterSeconds(chatId);
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many commands. Try again in ${retryAfter}s.`,
        retryAfterSeconds: retryAfter,
      },
    });
    return;
  }

  const result = await telegramService.processUpdate(update, {
    /**
     * Every command resolves its OWN user from the persisted chat mapping.
     * There is no shared-credential path: an unlinked chat gets no token and
     * therefore no reply, rather than being served by a platform-wide bot.
     */
    getBotTokenForUser: async (userId) =>
      (await persistence.keys.getTelegramToken(userId)) ?? undefined,

    listProcessesForChat: listOwnedProcesses,
    createProcessForChat: createProcessFromTelegram,

    /**
     * Ownership is resolved through `getForUser`, so another user's process id
     * behaves exactly like a nonexistent one. The message does not distinguish
     * them, which would be a process-id oracle.
     */
    pauseProcessForChat: async (chatId, processId) => {
      const owner = await ownerForChat(chatId);
      if (!owner) return { ok: false, message: 'This chat is not linked.' };

      const goat = await persistence.goats.getForUser(processId, owner.userId);
      if (!goat) {
        return { ok: false, message: `No process \`${processId}\` for your account.` };
      }

      const updated: FundGoat = { ...goat, status: 'PAUSED', updatedAt: new Date().toISOString() };
      await persistence.goats.save(updated);
      await syncSchedule(updated);
      const runtime = await ensureGoatRuntime(updated);
      runtime.pause();

      return { ok: true, message: `⏸ Paused *${goat.name}* (\`${goat.id}\`).` };
    },

    resumeProcessForChat: async (chatId, processId) => {
      const owner = await ownerForChat(chatId);
      if (!owner) return { ok: false, message: 'This chat is not linked.' };

      const goat = await persistence.goats.getForUser(processId, owner.userId);
      if (!goat) {
        return { ok: false, message: `No process \`${processId}\` for your account.` };
      }

      const updated: FundGoat = { ...goat, status: 'WATCHING', updatedAt: new Date().toISOString() };
      await persistence.goats.save(updated);
      await syncSchedule(updated);
      const runtime = await ensureGoatRuntime(updated);
      runtime.play();

      return {
        ok: true,
        message: `▶️ Resumed *${goat.name}* (\`${goat.id}\`). Condition alerts are live again.`,
      };
    },

    /**
     * A controlled evaluation.
     *
     * Explicit user intent, so it bypasses the schedule but NOT the runtime's
     * own guards: a paused process still refuses, and the runtime's evaluation
     * mutex means a concurrent scheduled wake cannot double-charge.
     */
    triggerProcessForChat: async (chatId, processId) => {
      const owner = await ownerForChat(chatId);
      if (!owner) return { ok: false, message: 'This chat is not linked.' };

      const goat = await persistence.goats.getForUser(processId, owner.userId);
      if (!goat) {
        return { ok: false, message: `No process \`${processId}\` for your account.` };
      }

      if (goat.status === 'PAUSED') {
        return {
          ok: false,
          message: `*${goat.name}* is paused. Resume it first with /resume ${goat.id}.`,
        };
      }

      const { runtime } = await buildCommandResolution(goat, owner.userId);

      void runtime
        .wake('Triggered from Telegram', 'MANUAL_REEVALUATE', goat.markets[0])
        .catch((err) => console.error('[telegram] trigger failed:', err));

      return {
        ok: true,
        message: `🔄 Running an evaluation for *${goat.name}*… I'll message you if a condition is met.`,
      };
    },

    resolveGoatForChat: async (chatId) => {
      const owner = await ownerForChat(chatId);
      if (!owner) return null;

      const goats = await persistence.goats.listByUser(owner.userId);
      if (goats.length === 0) return null;

      /**
       * The ACTIVE process, or the first one. A user with several processes
       * gets the one that is actually running, rather than whichever happened
       * to be created first.
       */
      const goat = goats.find((g) => g.status !== 'PAUSED') ?? goats[0];
      const { resolution } = await buildCommandResolution(goat, owner.userId);
      return resolution;
    },
  });

  res.json(result);
}));

/** Extracts a chat id from an update of any supported shape. */
function extractChatId(update: unknown): string | null {
  if (typeof update !== 'object' || update === null) return null;
  const u = update as Record<string, unknown>;

  for (const key of ['message', 'edited_message', 'channel_post'] as const) {
    const message = u[key];
    if (typeof message !== 'object' || message === null) continue;
    const chat = (message as Record<string, unknown>).chat;
    if (typeof chat !== 'object' || chat === null) continue;
    const id = (chat as Record<string, unknown>).id;
    if (typeof id === 'number' || typeof id === 'string') return String(id);
  }

  return null;
}

/**
 * The deployment's Telegram webhook secret.
 *
 * Reads TELEGRAM_WEBHOOK_SECRET and refuses to invent one. Generating a secret
 * at runtime would mean every cold start rejected every webhook delivery, which
 * looks identical to Telegram being broken.
 */
function resolveTelegramWebhookSecret(): string | null {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

/**
 * The public origin of THIS app, for registering a Telegram webhook.
 *
 * Resolution order, most trustworthy first:
 *
 *   1. `APP_ORIGIN` — explicit configuration, the only thing guaranteed correct
 *      behind a proxy or on a custom domain.
 *   2. Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` — injected
 *      by the platform, so it is right for this deployment rather than guessed.
 *   3. The request's own `Origin`/`Host` header.
 *
 * The host header is last and treated as untrusted: a caller can send any value,
 * so it must never override configured configuration. It exists only so a
 * self-hosted deployment can connect a bot without extra setup.
 */
function resolvePublicAppOrigin(req: Request): string | null {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  for (const key of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL'] as const) {
    const value = process.env[key]?.trim();
    if (value) {
      return `https://${value.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    }
  }

  const headerOrigin = req.header('origin')?.trim();
  if (headerOrigin && /^https:\/\//i.test(headerOrigin)) {
    return headerOrigin.replace(/\/+$/, '');
  }

  const host = req.header('host')?.trim();
  if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    return `https://${host}`;
  }

  return null;
}

/** Constant-time comparison for a shared secret. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Protected routes                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* AUTHENTICATION BOUNDARY                                             */
/* ------------------------------------------------------------------ */
/**
 * Everything ABOVE this line is public and must carry its OWN authentication:
 *   - /internal/*  -> shared scheduler secret (DURABLE_SCHEDULER_SECRET)
 *   - /telegram/webhook -> Telegram secret
 *   - everything else -> carries no user data
 *
 * Everything BELOW it has a verified identity in `req.user`, supplied by
 * authMiddleware. Ownership is derived from `req.user.uid` only.
 *
 * Public catalogue routes belong above the line; the copy routes that WRITE a
 * user's own record belong below it. That split is the reason a template can be
 * browsed signed-out while copying one requires an account.
 */

/**
 * EXPLORE: system-owned GOAT templates.
 *
 * PUBLIC. Deliberately unauthenticated: a template is static content with no
 * user data, and letting an unauthenticated visitor see what FundAGoat can do
 * is the point of the section. Nothing here reveals a user id, a credential or
 * a live GOAT.
 *
 * Templates are immutable to everyone. Copying is a POST (below) that creates a
 * NEW record owned by the caller; there is no route that edits a template, so
 * hiding an edit button in the UI is not what enforces that.
 */
apiRouter.get('/templates/goats', handle(async (_req, res) => {
  res.json({
    templates: SYSTEM_GOATS.map((goat) => ({
      id: goat.id,
      name: goat.name,
      goal: goat.goal,
      markets: goat.markets,
      skillIds: goat.skillIds,
      model: goat.model,
      timeframe: goat.timeframe,
      schedule: goat.schedule,
      /**
       * Explicit, so the UI never has to infer "these are examples" from the
       * absence of a status field. These are unverified starting points, not
       * performance claims.
       */
      isTemplate: true,
      performsTrades: false,
    })),
  });
}));

/** EXPLORE: system-owned skills. Public for the same reason as above. */
apiRouter.get('/templates/skills', handle(async (_req, res) => {
  res.json({ templates: SYSTEM_SKILLS.map(publicTemplateSkill) });
}));

apiRouter.use(authMiddleware);

// ---- Settings / keys (user-scoped) ----------------------------------

/**
 * Per-user credential status. NEVER returns a secret.
 *
 * READS THROUGH THE VAULT, which is what makes this route safe to expose: the
 * vault's status shape contains only `{configured, updatedAt, maskedHint,
 * keyId}`. There is no code path from this response to a plaintext key, so
 * there is nothing here that a future refactor could accidentally start
 * returning.
 */
apiRouter.get('/settings/keys', handle(async (req, res) => {
  const user = requireUser(req);

  const [openrouter, groq, propdao, telegram, vaultConfigured] = await Promise.all([
    credentialVault.getCredentialStatus(user.uid, 'openrouter'),
    credentialVault.getCredentialStatus(user.uid, 'groq'),
    credentialVault.getCredentialStatus(user.uid, 'propdao'),
    credentialVault.getCredentialStatus(user.uid, 'telegram'),
    Promise.resolve(credentialVault.isConfigured()),
  ]);

  res.json({
    /**
     * False when a value is stored but is not a usable key shape, so the UI
     * cannot claim "your key is saved" while every wake fails.
     */
    openRouterKeyConfigured: openrouter.configured && !/unreadable/.test(openrouter.maskedHint ?? ''),
    openRouterKeyInvalid: Boolean(openrouter.maskedHint?.includes('unreadable')),
    openRouterKeyHint: openrouter.maskedHint,
    groqKeyConfigured: groq.configured && !/unreadable/.test(groq.maskedHint ?? ''),
    propDaoKeyConfigured: propdao.configured && !/unreadable/.test(propdao.maskedHint ?? ''),
    propDaoKeyHint: propdao.maskedHint,
    telegramTokenConfigured: telegram.configured,
    telegramTokenHint: telegram.maskedHint,
    /**
     * False means the vault cannot encrypt. Saving any credential will fail
     * with a clear error rather than silently storing plaintext — the UI
     * surfaces this so a deployment mistake is visible before a user tries.
     */
    encryptionAvailable: vaultConfigured,
    serverKeyFallback: isPlausibleOpenRouterKey(
      process.env.OPENROUTER_API_KEY,
    ),
  });
}));

apiRouter.post('/settings/keys', handle(async (req, res) => {
  const user = requireUser(req);
  const {
    openRouterKey,
    groqKey,
    telegramToken,
    telegramChatId,
    provider,
  } = req.body ?? {};

  /**
   * Provider choice is validated BEFORE any key is written.
   *
   * If the provider were saved first and the key then failed validation, the
   * user would be left pointed at a provider with no credential — every wake
   * falling back to DEMO, which looks like a working app producing no signals.
   */
  let nextProvider: AiProvider | undefined;
  if (provider !== undefined && provider !== null && provider !== '') {
    if (provider !== 'openrouter' && provider !== 'groq') {
      return fail(res, 400, 'INVALID_PROVIDER', 'provider must be openrouter or groq.');
    }
    nextProvider = provider;
  }

  // Throws CredentialValidationError (surfaced as 400) on a bad shape.
  const nextOpenRouterKey = normaliseOpenRouterKey(openRouterKey);
  const nextGroqKey = normaliseGroqKey(groqKey).key;
  const nextTelegramToken = normaliseTelegramToken(telegramToken);

  if (nextProvider) {
    await persistence.keys.setProvider?.(user.uid, nextProvider);
    reasoningGateway.setProviderFor(user.uid, nextProvider);
  }

  /**
   * SECRETS GO THROUGH THE VAULT.
   *
   * `saveCredential` validates shape, encrypts with AES-256-GCM and stores
   * only the envelope. An explicit `null` CLEARS a credential; an absent field
   * means "leave unchanged", which is the long-standing settings semantics.
   *
   * When the master key is absent this THROWS rather than falling back to
   * plaintext. The user gets a 503 with the remediation, which is strictly
   * better than a key written in the clear that looks saved.
   */
  try {
    if (nextOpenRouterKey.key !== undefined) {
      await credentialVault.saveCredential(user.uid, 'openrouter', nextOpenRouterKey.key);
      // Drop the cached client so the next request uses the new credential.
      reasoningGateway.invalidate(user.uid);
    }

    if (nextGroqKey !== undefined) {
      await credentialVault.saveCredential(user.uid, 'groq', nextGroqKey);
      reasoningGateway.invalidate(user.uid);
    }

    if (nextTelegramToken !== undefined) {
      await credentialVault.saveCredential(user.uid, 'telegram', nextTelegramToken);
    }

    if (req.body?.propDaoApiKey !== undefined) {
      const propDaoKey = normalisePropDaoKey(req.body.propDaoApiKey);
      await credentialVault.saveCredential(user.uid, 'propdao', propDaoKey);
    }
  } catch (error) {
    if (error instanceof CredentialValidationError) {
      return fail(res, 400, 'INVALID_KEY', error.message);
    }
    if (error instanceof CredentialVaultError) {
      return fail(res, 503, error.code, error.message);
    }
    throw error;
  }

  if (telegramChatId !== undefined && telegramChatId !== null) {
    if (
      typeof telegramChatId !== 'string' ||
      !/^-?\d{1,20}$/.test(telegramChatId.trim())
    ) {
      return fail(res, 400, 'INVALID_KEY', 'telegramChatId must be a numeric Telegram chat id.');
    }

    /**
     * A chat id may belong to exactly ONE account.
     *
     * Without this check, two users could claim the same chat id and each would
     * then receive the other's signals: the second write silently reassigns the
     * chat and the first user keeps a profile that no longer resolves.
     */
    const existing = await persistence.profiles.findByTelegramChatId(
      telegramChatId.trim(),
    );
    if (existing && existing.id !== user.uid) {
      return fail(
        res,
        409,
        'CHAT_ID_IN_USE',
        'That Telegram chat is already linked to another FundAGoat account. ' +
          'Unlink it there first, or use a different chat.',
      );
    }

    const profile = (await persistence.profiles.get(user.uid)) ?? {
      id: user.uid,
      email: user.email ?? `${user.uid}@fundagoat.internal`,
      displayName: 'FundAGoat Trader',
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

  const activeProvider = await reasoningGateway.providerFor(user.uid);

  // Status only. No secret is echoed, so a client that intercepts the response
  // still learns nothing about the stored value.
  const [openrouterStatus, groqStatus, propdaoStatus] = await Promise.all([
    credentialVault.getCredentialStatus(user.uid, 'openrouter'),
    credentialVault.getCredentialStatus(user.uid, 'groq'),
    credentialVault.getCredentialStatus(user.uid, 'propdao'),
  ]);

  res.json({
    success: true,
    provider: activeProvider,
    openRouterKeyConfigured: openrouterStatus.configured,
    openRouterKeyHint: openrouterStatus.maskedHint,
    groqKeyConfigured: groqStatus.configured,
    propDaoKeyConfigured: propdaoStatus.configured,
    propDaoKeyHint: propdaoStatus.maskedHint,
  });
}));

/* ------------------------------------------------------------------ */
/* PROPDAO                                                             */
/* ------------------------------------------------------------------ */

/**
 * WHY EVERY ROUTE BELOW RE-DERIVES THE USER
 *
 * Ownership comes from `req.user.uid`, set by `authMiddleware` from a verified
 * Firebase token. No route here reads a user id, an account id for ownership,
 * or an approval state from the request body. A body field naming another user
 * has no effect because there is no code path that would consult it.
 *
 * NO ROUTE RETURNS A SECRET. `/propdao/status` returns the vault's masked
 * status; the API key is decrypted inside the adapter, used for an outbound
 * request, and discarded.
 */

/**
 * Connection status: is a key saved, does it verify, what does the provider
 * say, and is execution permitted.
 *
 * `execution` is a SERVER-SIDE capability statement, not a preference. It
 * cannot be turned on from the client.
 */
apiRouter.get('/propdao/status', handle(async (req, res) => {
  const user = requireUser(req);
  const provider = propDaoFor(user.uid);

  const [credential, verification] = await Promise.all([
    credentialVault.getCredentialStatus(user.uid, 'propdao'),
    provider.verifyConnection(),
  ]);

  res.json({
    provider: 'propdao',
    credential: {
      configured: credential.configured,
      /** e.g. "pd_l••••3f2a (27 chars)". Never the secret. */
      maskedHint: credential.maskedHint,
      updatedAt: credential.updatedAt,
      keyId: credential.keyId,
      needsRotation: credential.needsRotation,
    },
    /**
     * `configured` and `verified` are different and the UI shows both. A saved
     * key proves only that some text was stored; only a successful `GET /me`
     * proves it works.
     */
    connected: verification.connected,
    verification: verification.connected === true
      ? { userId: verification.userId, accountCount: verification.accountCount }
      : { code: verification.code, message: verification.message },
    execution: provider.policyStatus(),
  });
}));

/**
 * Accounts this key can see, plus live risk for each.
 *
 * The list comes from PropDAO's own `/accounts` for the CALLER'S key, so it
 * cannot contain someone else's account. Risk is fetched per account and any
 * failure degrades that account to `available: false` rather than failing the
 * whole request.
 */
apiRouter.get('/propdao/accounts', handle(async (req, res) => {
  const user = requireUser(req);
  const provider = propDaoFor(user.uid);

  const accounts = await provider.listAccounts();
  if (accounts.length === 0) {
    res.json({
      accounts: [],
      configured: (await credentialVault.getCredentialStatus(user.uid, 'propdao')).configured,
      message: 'No PropDAO accounts are available on this key.',
    });
    return;
  }

  const withRisk = await Promise.all(
    accounts.map(async (account) => {
      const risk = await provider.risk(account.accountId);
      return {
        ...account,
        risk,
        positions: await provider.positions(account.accountId),
        orders: await provider.orders(account.accountId),
        /** Everything above is real or null; nothing is defaulted to zero. */
        available: !risk.incomplete || risk.equity !== null,
      };
    }),
  );

  res.json({
    accounts: withRisk,
    configured: true,
    execution: provider.policyStatus(),
  });
}));

/** Instruments PropDAO offers, with the LIVE leverage caps. */
apiRouter.get('/propdao/markets', handle(async (req, res) => {
  const user = requireUser(req);
  const markets = await propDaoFor(user.uid).markets();
  res.json({
    markets,
    total: markets.length,
    /**
     * The published examples disagree with the live API on leverage caps and
     * market counts, so this response is explicitly labelled as live data and
     * the client must not substitute documented values.
     */
    source: 'propdao-live',
  });
}));

/**
 * Deterministic pre-flight for a proposed trade.
 *
 * Computes the risk verdict WITHOUT placing anything. This is what the
 * proposal screen shows before an approval is requested, so the user sees the
 * verdict against live account state rather than discovering it after
 * approving.
 *
 * Even here, nothing is executed: the route calls the pure validator, not the
 * gated executor.
 */
apiRouter.post('/propdao/risk-check', handle(async (req, res) => {
  const user = requireUser(req);
  const provider = propDaoFor(user.uid);

  const { accountId, symbol, side, qty, entry, stopLoss, takeProfit, leverage } = req.body ?? {};

  if (typeof accountId !== 'string' || !accountId) {
    return fail(res, 400, 'INVALID_REQUEST', 'accountId is required.');
  }
  if (typeof symbol !== 'string' || !symbol) {
    return fail(res, 400, 'INVALID_REQUEST', 'symbol is required.');
  }
  if (side !== 'BUY' && side !== 'SELL') {
    return fail(res, 400, 'INVALID_REQUEST', 'side must be BUY or SELL.');
  }
  for (const [label, value] of [['qty', qty], ['entry', entry], ['stopLoss', stopLoss], ['takeProfit', takeProfit]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(res, 400, 'INVALID_REQUEST', `${label} must be a finite number.`);
    }
  }

  // Ownership is proven against the key's own account list, not the request.
  const account = await provider.resolveAccount(accountId);
  if (!account) {
    return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'That account is not available on your PropDAO key.');
  }

  const [risk, markets, positions] = await Promise.all([
    provider.risk(accountId),
    provider.markets(),
    provider.positions(accountId),
  ]);

  const result = validateTradeIntent(
    { symbol, side, qty, entry, stopLoss, takeProfit, leverage },
    account,
    risk,
    markets,
    positions,
  );

  res.json({
    ok: result.ok,
    violations: result.violations,
    measured: result.measured,
    limits: DEFAULT_RISK_LIMITS,
    /** Always included, so the UI can explain a refusal rather than hide it. */
    execution: provider.policyStatus(),
  });
}));

/** Disconnects PropDAO: deletes the key and reports what was removed. */
apiRouter.delete('/propdao/connect', handle(async (req, res) => {
  const user = requireUser(req);
  await credentialVault.deleteCredential(user.uid, 'propdao');
  res.json({ success: true, connected: false });
}));

/**
 * Capability + execution policy for this deployment.
 *
 * Registered AFTER `authMiddleware`, so it requires a signed-in user. That is
 * deliberate: the "can this deployment trade?" answer is deployment policy,
 * not public product information, and there is no reason to expose it
 * anonymously. It returns no user data and no secret.
 */
apiRouter.get('/propdao/capabilities', handle(async (req, res) => {
  requireUser(req);
  const provider = propDaoFor(req.user!.uid);
  res.json(provider.policyStatus());
}));


/**
 * TELEGRAM BOT CONNECTION
 * -----------------------
 * Connect the user's OWN bot: verify the token with `getMe`, register the
 * webhook with Telegram, and record what was verified.
 *
 * VERIFIED, NOT ASSUMED
 *
 * Nothing about a bot is treated as connected until `getMe` has succeeded
 * against Telegram. A stored token proves only that some text was stored, and
 * the previous flow treated that as success.
 *
 * NO TOKEN EVER LEAVES THE SERVER
 *
 * The token is used to call Telegram and is discarded. It is never echoed in a
 * response, never logged, and never returned to the browser.
 */
apiRouter.post('/telegram/connect', handle(async (req, res) => {
  const user = requireUser(req);
  const token = normaliseTelegramToken(req.body?.telegramToken);

  if (token === undefined) {
    return fail(res, 400, 'INVALID_KEY', 'A Telegram bot token from @BotFather is required.');
  }

  const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    return fail(res, 400, 'INVALID_CHAT_ID', 'chatId must be a numeric Telegram chat id.');
  }

  const webhookSecret = resolveTelegramWebhookSecret();
  if (!webhookSecret) {
    return fail(
      res,
      503,
      'TELEGRAM_NOT_CONFIGURED',
      'This server has no Telegram webhook secret configured. Set TELEGRAM_WEBHOOK_SECRET before connecting a bot.',
    );
  }

  const baseUrl = resolvePublicAppOrigin(req);
  if (!baseUrl) {
    return fail(
      res,
      503,
      'APP_ORIGIN_NOT_CONFIGURED',
      'The public URL of this app could not be determined. Set APP_ORIGIN so Telegram can deliver updates.',
    );
  }

  const client = new TelegramBotClient(token);

  /**
   * Step 1: prove the token is real and learn who this bot is. Done BEFORE any
   * state is written, so an invalid token leaves the account untouched.
   */
  let identity: Awaited<ReturnType<TelegramBotClient['getMe']>>;
  try {
    identity = await client.getMe();
  } catch (err) {
    return fail(
      res,
      400,
      'TELEGRAM_VERIFY_FAILED',
      err instanceof Error ? err.message : 'Telegram rejected this bot token.',
    );
  }

  const webhookUrl = `${baseUrl}/api/telegram/webhook`;

  /**
   * Step 2: register the webhook.
   *
   * The same deployment secret is used for every user's bot. Telegram sends it
   * as `X-Telegram-Bot-Api-Secret-Token`, which is how the endpoint proves the
   * request came from Telegram for a bot we registered. It is not derived per
   * user: the receiving endpoint has one configured secret, and a derived value
   * would have to be recomputable from the request, which would defeat it.
   */
  try {
    await client.setWebhook(webhookUrl, webhookSecret);
  } catch (err) {
    return fail(
      res,
      502,
      'TELEGRAM_WEBHOOK_FAILED',
      `The bot token is valid but the webhook could not be registered: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    );
  }

  /**
   * Step 3: confirm the chat is actually reachable by this bot.
   *
   * Only done when the user supplied a chat id. A wrong chat id is the most
   * common setup failure, and finding out here is far better than discovering
   * that no alert ever arrives.
   */
  let chatVerified = false;
  let chatUsername: string | undefined;

  if (chatId) {
    try {
      const chat = await client.verifyChat(chatId);
      chatVerified = chat.ok;
      chatUsername = chat.username;
    } catch (err) {
      return fail(
        res,
        400,
        'TELEGRAM_CHAT_UNREACHABLE',
        `The bot cannot message chat ${chatId}. Send /start to your bot first, then reconnect. (${
          err instanceof Error ? err.message : 'unknown error'
        })`,
      );
    }
  }

  // Only now is any state persisted.
  await persistence.keys.setTelegramToken(user.uid, token);
  await persistence.keys.setTelegramBot?.(user.uid, {
    id: identity.id,
    username: identity.username,
    verifiedAt: new Date().toISOString(),
    webhookUrl,
  });

  if (chatId) {
    const profile = (await persistence.profiles.get(user.uid)) ?? {
      id: user.uid,
      email: user.email ?? `${user.uid}@fundagoat.internal`,
      displayName: 'FundAGoat Trader',
      telegramNotificationsEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const existing = await persistence.profiles.findByTelegramChatId(chatId);
    if (existing && existing.id !== user.uid) {
      return fail(
        res,
        409,
        'CHAT_ID_IN_USE',
        'That Telegram chat is already linked to another FundAGoat account.',
      );
    }

    await persistence.profiles.save({
      ...profile,
      telegramChatId: chatId,
      telegramUsername: chatUsername,
      updatedAt: new Date().toISOString(),
    });
  }

  res.json({
    connected: true,
    bot: {
      id: identity.id,
      username: identity.username,
      firstName: identity.firstName,
    },
    webhookUrl,
    chatVerified,
    /**
     * Never the token. There is no code path here that can return it, which is
     * the property that matters.
     */
    tokenStored: true,
  });
}));

/** Connection status. Reports what is configured and what was verified. */
apiRouter.get('/telegram/status', handle(async (req, res) => {
  const user = requireUser(req);

  const [token, bot, chatId] = await Promise.all([
    persistence.keys.getTelegramToken(user.uid),
    persistence.keys.getTelegramBot?.(user.uid),
    persistence.profiles.get(user.uid),
  ]);

  /**
   * Reported live against Telegram rather than from the stored record, because
   * a webhook can be removed by Telegram or by the user at any time. The stored
   * record would keep claiming "connected" regardless.
   */
  let live: { ok: boolean; pendingUpdates?: number; lastErrorMessage?: string; detail?: string } | null =
    null;

  if (token) {
    try {
      const info = await new TelegramBotClient(token).getWebhookInfo();
      live = {
        ok: true,
        pendingUpdates: info.pendingUpdateCount,
        lastErrorMessage: info.lastErrorMessage,
      };
    } catch (err) {
      live = {
        ok: false,
        detail: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }

  res.json({
    tokenConfigured: Boolean(token),
    bot: bot ? { id: bot.id, username: bot.username, verifiedAt: bot.verifiedAt } : null,
    chatId: chatId?.telegramChatId ?? null,
    webhookSecretConfigured: Boolean(resolveTelegramWebhookSecret()),
    webhook: live,
    /**
     * `connected` requires a token AND a live webhook. A stored token with a
     * failing webhook is not a working connection and must not be reported as
     * one.
     */
    connected: Boolean(token) && live?.ok === true && chatId?.telegramChatId !== undefined,
  });
}));

/** Disconnects the bot: removes the webhook from Telegram and clears state. */
apiRouter.delete('/telegram/connect', handle(async (req, res) => {
  const user = requireUser(req);
  const token = await persistence.keys.getTelegramToken(user.uid);

  if (token) {
    try {
      await new TelegramBotClient(token).deleteWebhook();
    } catch (err) {
      /**
       * Reported, but the local record is still cleared: leaving a token in
       * place because Telegram was unreachable would trap the user in a state
       * they explicitly asked to leave.
       */
      console.warn('[telegram] deleteWebhook failed:', err);
    }
  }

  await persistence.keys.setTelegramToken(user.uid, undefined);
  await persistence.keys.setTelegramBot?.(user.uid, undefined);

  const profile = await persistence.profiles.get(user.uid);
  if (profile?.telegramChatId) {
    await persistence.profiles.save({
      ...profile,
      telegramChatId: undefined,
      telegramUsername: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  res.json({ connected: false });
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
  /**
   * Check the catalogue by ID FIRST.
   *
   * The built-in skills are served from the catalogue rather than from user
   * storage, so a lookup in storage alone returns nothing and the caller would
   * get a misleading 404. Immutability of a system skill must hold regardless of
   * whether it happens to have a stored copy.
   */
  if (isSystemOwnedSkillId(req.params.id)) {
    return fail(res, 400, 'DEFAULT_SKILL', 'Cannot delete system skills.');
  }

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

/* ------------------------------------------------------------------ */
/* System catalogues (Explore)                                        */
/* ------------------------------------------------------------------ */

/**
 * Copies a GOAT template into the caller's workspace.
 *
 * The template is READ and a NEW record is written with a fresh id and the
 * caller's uid. The template itself is never written to, so concurrent copies
 * cannot interfere and one user's copy cannot affect another's.
 */
apiRouter.post('/templates/goats/:id/copy', handle(async (req, res) => {
  const user = requireUser(req);
  const template = SYSTEM_GOATS.find((g) => g.id === req.params.id);

  if (!template) return notFound(res);

  const now = new Date().toISOString();
  const copy: FundGoat = {
    ...template,
    // New identity and a real owner. Spreading the template would otherwise
    // copy `id: 'system'` and make the copy collide with the template itself.
    id: `goat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: user.uid,
    name: `${template.name}`,
    status: 'WATCHING',
    createdAt: now,
    updatedAt: now,
  };

  await persistence.goats.save(copy);

  /**
   * A copy of a SKILL must also be owned by the caller, otherwise the copy would
   * reference a system record that must stay immutable.
   */
  await copyReferencedSkills(user.uid, copy.skillIds);

  await syncSchedule(copy);
  subscribeToMarkets(copy);

  res.status(201).json({ goat: copy, copiedFrom: template.id });
}));

/**
 * Ensures every skill id a GOAT references is usable by its owner.
 *
 * A system skill is referenced in place (it is immutable but readable); a user
 * skill is COPIED, so the GOAT keeps working if the user later edits or deletes
 * their own copy. Returns the ids that are actually usable.
 */
async function copyReferencedSkills(
  userId: string,
  skillIds: string[],
): Promise<string[]> {
  const resolved: string[] = [];

  for (const skillId of skillIds) {
    const system = SYSTEM_SKILLS.find((s) => s.id === skillId);

    if (system) {
      resolved.push(skillId);
      continue;
    }

    const existing = await persistence.skills.get(skillId);
    if (existing?.isDefault || existing?.userId === 'system' || isSystemOwnedSkillId(skillId)) {
      resolved.push(skillId);
      continue;
    }

    // Never copy another user's skill into this user's library.
    if (existing && existing.userId !== userId) {
      continue;
    }

    const now = new Date().toISOString();
    await persistence.skills.save({
      ...existing,
      id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  return resolved;
}

/** Copies a skill template into the caller's library. */
apiRouter.post('/templates/skills/:id/copy', handle(async (req, res) => {
  const user = requireUser(req);
  const template = SYSTEM_SKILLS.find((s) => s.id === req.params.id);

  if (!template) return notFound(res);

  const now = new Date().toISOString();
  const copy = {
    ...template,
    id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: user.uid,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };

  await persistence.skills.save(copy);
  res.status(201).json({ skill: copy, copiedFrom: template.id });
}));

/** The public shape of a template skill: no owner, no timestamps. */
function publicTemplateSkill(skill: (typeof SYSTEM_SKILLS)[number]) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    methodology: skill.methodology,
    constraints: skill.constraints,
    preferredTimeframes: skill.preferredTimeframes,
    requiredEvidence: skill.requiredEvidence,
    invalidationRules: skill.invalidationRules,
    isTemplate: true,
    /** Stated so the UI need not guess whether a skill is a live artefact. */
    executable: false,
  };
}

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
  const newGoat: FundGoat = {
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
  const updated: FundGoat = {
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

  const updated: FundGoat = {
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

/** Loads one of a caller-owned GOAT's signals, or 404s without leaking existence. */
async function ownedSignal(
  req: Parameters<typeof requireUser>[0],
  userId: string,
): Promise<{ goat: FundGoat; signal: TradeSignal } | null> {
  const goat = await persistence.goats.getForUser(String(req.params.id), userId);
  if (!goat) return null;
  const signals = await persistence.signals.listByGoat(goat.id, 500);
  const signal = signals.find((s) => s.id === String(req.params.signalId));
  if (!signal) return null;
  return { goat, signal };
}

/**
 * RECORD A PROPOSAL DECISION (accept / reject)
 * --------------------------------------------
 * The write path for the proposal screen's Accept and Reject buttons.
 *
 * THREE SAFETY PROPERTIES, all enforced here rather than in the UI:
 *
 *  1. WRITE-ONCE. A finalised proposal refuses a second decision with 409,
 *     so a double-click or a retry cannot flip an ACCEPTED proposal to
 *     REJECTED after the user (or Telegram) has already decided.
 *
 *  2. ACCEPTANCE IS GATED BY THE EXECUTION POLICY, NOT BY THE BUTTON. When
 *     order placement is disabled — the default, and the only state this
 *     deployment may run in until PropDAO grants written authorisation — an
 *     ACCEPT returns EXECUTION_DISABLED and records NOTHING. The UI therefore
 *     can never imply an order was placed, because no acceptance exists to
 *     imply it. `evaluateExecution` reads the same three environment flags the
 *     executor reads; there is no second, looser check.
 *
 *  3. REJECTION IS ALWAYS ALLOWED AND PERSISTS. Rejecting cannot place an
 *     order, so it is never blocked by the policy — but it IS persisted, so
 *     web and Telegram read the same finalised state.
 */
apiRouter.post('/goats/:id/signals/:signalId/decision', handle(async (req, res) => {
  const user = requireUser(req);
  const owned = await ownedSignal(req, user.uid);
  if (!owned) return notFound(res);
  const { goat, signal } = owned;

  const decision = req.body?.decision;
  if (decision !== 'ACCEPTED' && decision !== 'REJECTED') {
    return fail(res, 400, 'INVALID_INPUT', 'decision must be ACCEPTED or REJECTED.');
  }

  // 1. Write-once, checked SERVER-side against the persisted record.
  if (signal.decision) {
    return fail(
      res,
      409,
      'ALREADY_FINALIZED',
      `This proposal was already ${signal.decision.toLowerCase()} at ${signal.decidedAt ?? 'an earlier time'} and cannot be decided again.`,
    );
  }

  // An expired proposal can be rejected (closing it out) but not accepted.
  const expired = signal.expiresAt
    ? Date.parse(signal.expiresAt) < Date.now()
    : false;

  // 2. Acceptance passes through the SAME execution policy the executor uses.
  if (decision === 'ACCEPTED') {
    const execution = propDaoFor(user.uid).policyStatus();

    if (!execution.enabled || !execution.authorised) {
      return fail(
        res,
        409,
        'EXECUTION_DISABLED',
        `${execution.summary} ${execution.termsSummary}`,
      );
    }
    if (expired) {
      return fail(
        res,
        409,
        'PROPOSAL_EXPIRED',
        'This proposal has expired. Review the current market before approving a new one.',
      );
    }
  }

  const now = new Date().toISOString();
  const updated: TradeSignal = {
    ...signal,
    decision,
    decidedAt: now,
    decisionNote:
      typeof req.body?.note === 'string' && req.body.note.trim()
        ? req.body.note.trim().slice(0, 500)
        : undefined,
    updatedAt: now,
  };

  const persisted = await persistence.signals.update(updated);
  if (!persisted) {
    return fail(res, 404, 'NOT_FOUND', 'That proposal no longer exists.');
  }

  res.json({
    signal: updated,
    decision,
    /**
     * Always returned so the UI can state the truth next to the decision:
     * a recorded ACCEPTANCE is a user decision record, and whether an ORDER
     * exists is governed by this object — never by the button press.
     */
    execution: propDaoFor(user.uid).policyStatus(),
    dataMode: marketProvider.dataMode,
  });
}));

/**
 * PROPOSAL AI ASSISTANT
 * ---------------------
 * Contextual questions about ONE proposal, answered through the existing
 * user-scoped reasoning gateway (same BYO OpenRouter/Groq key, same
 * server-side credential resolution; no key ever reaches the browser).
 *
 * The proposal's persisted record — levels, evidence, decision state and the
 * execution policy summary — is injected verbatim into the prompt as the
 * factual record, so answers are grounded rather than improvised. The
 * assistant is READ-ONLY by construction: there is no code path from this
 * route to a proposal mutation or an order.
 */
apiRouter.post('/goats/:id/signals/:signalId/ask', handle(async (req, res) => {
  const user = requireUser(req);
  const owned = await ownedSignal(req, user.uid);
  if (!owned) return notFound(res);
  const { goat, signal } = owned;

  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim()) {
    return fail(res, 400, 'INVALID_INPUT', 'Question is required.');
  }
  if (question.length > 2000) {
    return fail(res, 400, 'INVALID_INPUT', 'Question too long.');
  }

  await ensureGoatRuntime(goat);
  const { context, model } = await buildGoatContext(
    { goats: persistence.goats, skills: persistence.skills, marketProvider },
    goat.id,
    user.uid,
  );
  const runtime = durableObjectRegistry.get(goat.id);

  const expired = signal.expiresAt
    ? Date.parse(signal.expiresAt) < Date.now()
    : false;

  const enriched = {
    ...context,
    activeThesis: runtime?.getState().currentThesis ?? null,
    proposal: {
      // The complete persisted proposal record — facts, not narration.
      ...signal,
      expired,
      sourceGoat: {
        id: goat.id,
        name: goat.name,
        goal: goat.goal,
        markets: goat.markets,
        timeframe: goat.timeframe,
        schedule: goat.schedule,
        skills: context.skills.map((s) => ({ id: s.id, name: s.name })),
      },
      // Execution restrictions travel WITH the proposal so the assistant can
      // never imply an order is possible when the policy says otherwise.
      execution: propDaoFor(user.uid).policyStatus(),
      dataSource: marketProvider.dataMode,
    },
  };

  const answer = await reasoningGateway.answerGoatQuestion(
    question.trim(),
    enriched,
    model,
  );
  res.json({ answer, dataMode: marketProvider.dataMode });
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
    : goat.markets[0];
  if (!selectedMarket) {
    return fail(res, 400, 'NO_MARKET', 'The GOAT has no market configured to backtest.');
  }
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
