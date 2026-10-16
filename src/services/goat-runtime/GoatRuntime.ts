/**
 * GOAT RUNTIME (in-process)
 * =======================================
 * One actor per deployed GOAT. Owns:
 *  - the canonical wake pipeline (investigate -> reason -> gate -> persist)
 *  - deterministic tracker evaluation on price ticks
 *  - a resilient scheduler (bounded exponential backoff, per-GOAT isolation)
 *
 * Guarantees:
 *  - A malformed LLM response NEVER crashes the GOAT: it becomes a
 *    NO_TRADE / REASONING_ERROR wake event with an observable error record.
 *  - A failed wake leaves the GOAT in a valid, recoverable state.
 *  - One GOAT failing never destabilizes other GOATs (all timers and state
 *    are per-instance; scheduler errors are caught).
 *  - Stale async work (tracker wake attempts racing a wake) is dropped via
 *    the generation guard.
 */

import {
  FundGoat,
  GoatRuntimeState,
  GoatSchedule,
  MarketThesis,
  TrackerCondition,
  TrackerIndicatorParams,
  WakeEvent,
  TradeSignal,
  TradingSkill,
  MarketQuote,
  Candle,
} from '../../types';
import { MarketDataProvider, MarketDataUnavailableError } from '../market-data/MarketDataProvider';
import {
  MarketStateSnapshot,
  MarketStateStore,
  isUsableMarketState,
} from '../market-data/MarketStateStore';
import {
  normaliseTrackingTimeframe,
  pollIntervalForTimeframe,
} from '../market-data/trackingTimeframes';
import { ReasoningResult, ReasoningValidationError, TrackerDirective } from '../agent/contracts';
import { GoatReasoningContext } from '../ai/OpenRouterClient';
import { SignalGate } from '../agent/SignalGate';
import { aggregateHardConstraints, HardConstraints } from '../agent/SkillConstraints';
import {
  computeIndicatorSnapshot,
  type TrackerEvaluationReport,
  type IndicatorSnapshot,
} from '../tracker-sdk/TrackerEvaluator';
import { evaluateTracker } from '../tracker-sdk/DeterministicTrackerEvaluator';
import { SessionSchedule } from '../tracker-sdk/SessionSchedule';
import { analyzeMarketStructure, calculateRSI, calculateEMA, calculateATR } from '../tracker-sdk/indicators';
import { ReasoningGateway } from '../../server/reasoningGateway';
import { newsService } from '../news/NewsService';
import {
  SignalRepository,
  ThesisRepository,
  WakeEventRepository,
} from '../../server/repositories';
import type { WakeScheduler } from '../../server/scheduler/types';

export interface GoatRuntimeOptions {
  reasoning: ReasoningGateway;
  marketProvider: MarketDataProvider;
  /**
   * Shared, cached, persisted market state. When supplied, tracker evaluation
   * reads a pre-computed indicator snapshot instead of refetching candles and
   * recomputing every indicator on each tick. Optional so unit tests can run
   * against a bare provider.
   */
  marketStateStore?: MarketStateStore;
  signals?: SignalRepository;
  theses?: ThesisRepository;
  wakeEvents?: WakeEventRepository;
  /** Called when the gate approves a signal (Telegram notifier, etc.). */
  onSignal?: (goat: FundGoat, signal: TradeSignal) => void;
  /**
   * Called when a deterministic tracker condition is satisfied. This is the
   * "your wait-for condition just hit" alert — distinct from a signal.
   */
  onTrackerTriggered?: (
    goat: FundGoat,
    report: TrackerEvaluationReport,
  ) => void;
  /** Start the routine scheduler automatically (default true; tests use false). */
  autoStartScheduler?: boolean;
  baseCheckIntervalMs?: number;
  maxBackoffMs?: number;
  /** Minimum age of the last evaluation before a periodic review fires.
   *  Default 5 minutes; tests use 0 to drive the scheduler deterministically. */
  periodicReviewMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /**
   * External Firestore-backed scheduler.
   *
   * When supplied, this actor does NOT arm in-process timers: the scheduler
   * owns the wake schedule and calls back into the API. This is what makes
   * production independent of a process staying alive.
   */
  scheduler?: WakeScheduler;
}

const DEFAULT_BASE_INTERVAL_MS = 45_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
const PERIODIC_REVIEW_MS = 5 * 60_000;
const MAX_TRACKERS = 10;

/** Timeframe and window used to build the reasoning context on a wake. */
const WAKE_TIMEFRAME = '1h';
const WAKE_CANDLE_COUNT = 60;

/**
 * Hard ceiling on internet research inside a wake. Research is optional
 * context; it must never hold the reasoning pipeline open.
 */
const NEWS_BUDGET_MS = 2_500;

/**
 * Resolves to `fallback` if `promise` has not settled within `ms`.
 *
 * The underlying work is NOT cancelled — it is simply no longer awaited, so a
 * late resolution cannot mutate state through this path.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);

    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Hard floor for INTERVAL schedules; below this we would burn tokens. */
const MIN_SCHEDULE_INTERVAL_MINUTES = 5;

/** Tick granularity used to re-check wall-clock TIMES schedules. */
const SCHEDULE_TICK_MS = 30_000;

/**
 * Pure bounded exponential backoff: base * 2^failures, capped at max.
 * Exported so the backoff policy is directly unit-testable.
 */
export function computeBackoffDelay(baseMs: number, maxMs: number, failures: number): number {
  const safeFailures = Math.max(0, Math.floor(failures));
  const safeBase = Math.max(1, baseMs);
  return Math.min(safeBase * Math.pow(2, safeFailures), maxMs);
}

/**
 * Normalises a GOAT schedule into something the scheduler can act on.
 * A missing or nonsensical schedule falls back to hourly rather than
 * silently becoming "run constantly".
 */
export function normaliseSchedule(schedule: GoatSchedule | undefined): GoatSchedule {
  if (!schedule || typeof schedule !== 'object') {
    return { mode: 'INTERVAL', intervalMinutes: 60 };
  }

  switch (schedule.mode) {
    case 'MANUAL':
    case 'TRACKERS':
      return { mode: schedule.mode };

    case 'TIMES': {
      /**
       * Range-validate, not just shape-validate. `/^\d{2}:\d{2}$/` happily
       * accepts "99:99", which would leave a schedule that is non-empty but can
       * never fire — a silently dead GOAT. Anything unusable therefore drops
       * to MANUAL, where the user can see the GOAT simply will not run itself.
       */
      const times = (schedule.times ?? [])
        .filter((t) => typeof t === 'string' && isValidClockTime(t))
        .slice(0, 12);

      return times.length > 0 ? { mode: 'TIMES', times } : { mode: 'MANUAL' };
    }

    case 'INTERVAL':
    default: {
      const requested = Number(schedule.intervalMinutes);
      const minutes = Number.isFinite(requested) && requested > 0
        ? Math.max(MIN_SCHEDULE_INTERVAL_MINUTES, Math.round(requested))
        : 60;

      return { mode: 'INTERVAL', intervalMinutes: minutes };
    }
  }
}

/** Milliseconds until the next local 'HH:MM' entry in `times`. */
export function msUntilNextScheduledTime(
  times: string[],
  nowMs: number,
): number {
  if (times.length === 0) return SCHEDULE_TICK_MS;

  const now = new Date(nowMs);
  let best = Number.POSITIVE_INFINITY;

  for (const entry of times) {
    const match = /^(\d{2}):(\d{2})$/.exec(entry);
    if (!match) continue;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) continue;

    // Check today and tomorrow; take the nearest future occurrence.
    for (const dayOffset of [0, 1]) {
      const candidate = new Date(now);
      candidate.setHours(hours, minutes, 0, 0);
      candidate.setDate(candidate.getDate() + dayOffset);

      const delta = candidate.getTime() - nowMs;
      if (delta >= 0 && delta < best) {
        best = delta;
      }
    }
  }

  if (!Number.isFinite(best)) return SCHEDULE_TICK_MS;
  return Math.max(1_000, best);
}

/** True only for a real 24-hour wall-clock time, e.g. "08:30". */
export function isValidClockTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/** Short human label for a schedule, used in wake reasons and the UI. */
export function describeSchedule(schedule: GoatSchedule): string {
  switch (schedule.mode) {
    case 'MANUAL':
      return 'manual analysis only';
    case 'TRACKERS':
      return 'tracker polling only';
    case 'TIMES':
      return `scheduled at ${(schedule.times ?? []).join(', ')}`;
    case 'INTERVAL':
    default: {
      const minutes = schedule.intervalMinutes ?? 60;
      if (minutes % 60 === 0 && minutes >= 60) {
        const hours = minutes / 60;
        return hours === 1 ? 'every hour' : `every ${hours} hours`;
      }
      return `every ${minutes} minutes`;
    }
  }
}

/** e.g. "EMA(20) CROSS_ABOVE 1.085" — the human form of a tracker. */
function describeTrackerFormula(directive: TrackerDirective): string {
  if (directive.indicator) {
    const label =
      directive.indicator === 'RSI'
        ? `RSI(${directive.period ?? 14})`
        : directive.indicator === 'ATR'
          ? `ATR(${directive.period ?? 14})`
          : directive.indicator === 'SWING_HIGH' ||
              directive.indicator === 'SWING_LOW'
            ? `${directive.period ?? 20}-bar ${directive.indicator === 'SWING_HIGH' ? 'high' : 'low'}`
            : directive.indicator;

    const target = directive.operator === 'WITHIN_RANGE' && directive.rangeLow !== undefined && directive.rangeHigh !== undefined
      ? `${directive.rangeLow}–${directive.rangeHigh}`
      : directive.targetValue ?? 'level';
    return `${label} ${directive.operator ?? 'REACHED'} ${target}`;
  }

  const target = directive.operator === 'WITHIN_RANGE' && directive.rangeLow !== undefined && directive.rangeHigh !== undefined
    ? `${directive.rangeLow}–${directive.rangeHigh}`
    : directive.targetValue ?? 'level';
  return `${directive.type} ${directive.operator ?? 'CONDITION'} ${target}`;
}

/**
 * True when a market-data failure means "the provider does not list this
 * instrument" - NOT "the provider is temporarily down".
 *
 * Two shapes reach here: the provider's own `MarketDataUnavailableError`
 * (with its machine-readable reason), and the MarketStateStore's wrapped
 * error, where the original message survives inside
 * `market data is UNAVAILABLE: <original message>`. Matching both is what
 * lets a stale persisted symbol be retired instead of retried forever.
 */
const UNLISTED_MARKET_PATTERNS = [
  /is not a market/i,
  /has been delisted/i,
  /not listed/i,
];

export function isUnlistedMarketError(err: unknown, message: string): boolean {
  if (err instanceof MarketDataUnavailableError) {
    if (err.unavailableReason === 'NOT_LISTED' || err.unavailableReason === 'DELISTED') {
      return true;
    }
  }
  return UNLISTED_MARKET_PATTERNS.some((pattern) => pattern.test(message));
}

export class GoatRuntime {
  readonly id: string;

  private goatConfig: FundGoat;
  private skills: TradingSkill[];
  private runtimeState: GoatRuntimeState;

  private readonly reasoning: ReasoningGateway;
  private readonly marketProvider: MarketDataProvider;
  private readonly marketStateStore?: MarketStateStore;
  private readonly scheduler?: WakeScheduler;
  private readonly signalRepo?: SignalRepository;
  private readonly thesisRepo?: ThesisRepository;
  private readonly wakeEventRepo?: WakeEventRepository;
  private readonly onSignalCallback?: (goat: FundGoat, signal: TradeSignal) => void;
  private readonly onTrackerTriggeredCallback?: (
    goat: FundGoat,
    report: TrackerEvaluationReport,
  ) => void;

  private unsubscribeMarketData: (() => void) | null = null;
  private scheduledAlarm: ReturnType<typeof setTimeout> | null = null;
  /** Pending catalogue-warm retry; cleared on pause/destroy. See attachMarketListeners. */
  private catalogueWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSessionReviewTriggered: string = '';
  private stopped = false;

  /**
   * User-facing pause. A paused GOAT keeps NO timers and evaluates NO
   * trackers, but stays registered so "Play" can resume it instantly
   * (unlike destroy(), which is for deletion).
   */
  private paused = false;

  private baseCheckIntervalMs: number;
  private maxBackoffMs: number;
  private periodicReviewMs: number;
  private readonly now: () => number;

  /**
   * Timestamp of the last market-data failure, for the invalid-symbol gate.
   *
   * A wake that failed because the instrument is not listed degrades the
   * shared market-state store every attempt. Retrying immediately and forever
   * is a hot error loop against a market that will not appear. The failure is
   * RECORDED (the user can see it), but repeated wakes are throttled to the
   * slow routine cadence rather than the aggressive retry interval.
   */
  private lastInvalidMarketAtMs = 0;
  /** Hydration completes before API reads decide whether an initial review is needed. */
  private readonly hydrationPromise: Promise<void>;

  constructor(goat: FundGoat, skills: TradingSkill[], options: GoatRuntimeOptions) {
    this.id = goat.id;
    this.goatConfig = goat;
    this.skills = skills;
    this.reasoning = options.reasoning;
    this.marketProvider = options.marketProvider;
    this.marketStateStore = options.marketStateStore;
    this.scheduler = options.scheduler;
    this.signalRepo = options.signals;
    this.thesisRepo = options.theses;
    this.wakeEventRepo = options.wakeEvents;
    this.onSignalCallback = options.onSignal;
    this.onTrackerTriggeredCallback = options.onTrackerTriggered;
    this.baseCheckIntervalMs = options.baseCheckIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.periodicReviewMs = options.periodicReviewMs ?? PERIODIC_REVIEW_MS;
    this.now = options.now ?? (() => Date.now());
    this.paused = goat.status === 'PAUSED';

    const initialSession = SessionSchedule.getCurrentSession();

    this.runtimeState = {
      goatId: goat.id,
      status: this.paused ? 'PAUSED' : 'WATCHING',
      currentThesis: null,
      trackers: [],
      lastWakeEvent: null,
      recentWakeEvents: [],
      latestSignal: null,
      dormancyReason: this.paused
        ? 'Paused by the user. No analysis and no tracker evaluation will run until Play is pressed.'
        : 'Initialized. Deterministic trackers armed; awaiting session review or tracker event.',
      nextWatchingCondition: `Watching ${goat.markets.join(', ')} for session liquidity sweeps and price structure`,
      nextScheduledReview: initialSession.nextSessionName,
      generationId: this.newGenerationId(),
      lastEvaluatedAt: this.now(),
      isEvaluating: false,
      consecutiveFailures: 0,
      dataSource: this.marketProvider.dataMode,
      reasoningMode: 'DEMO',
    };

    this.attachMarketListeners();

    /**
     * HYDRATE FROM PERSISTENCE — see `hydrateFromPersistence`.
     *
     * The constructor cannot await, so this runs immediately and fills the
     * state in when it resolves. `runtimeState` is valid (and honest about
     * being un-hydrated) immediately, and becomes accurate a tick later.
     */
    this.hydrationPromise = this.hydrateFromPersistence();

    /**
     * Warm the research cache up front so the first wake does not pay for it.
     * Fire-and-forget: this must never delay startup.
     *
     * Only for LIVE data. There is no point spending a network request to
     * research headlines that will be attached to simulated prices, and doing
     * so on every actor construction is a needless cost.
     */
    if (
      goat.markets.length > 0 &&
      this.marketProvider.dataMode === 'LIVE'
    ) {
      newsService.prewarm(goat.markets);
    }

    /**
     * Only arm an in-process timer when there is no external scheduler.
     * With the Firebase scheduler, due times live in Firestore, so a local timer
     * would be a second, competing source of truth.
     */
    if (
      options.autoStartScheduler !== false &&
      !this.paused &&
      !this.scheduler
    ) {
      this.scheduleRoutineCheck(this.baseCheckIntervalMs);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public surface                                                    */
  /* ---------------------------------------------------------------- */

  /** Await persisted thesis/signal restoration before making lifecycle decisions. */
  async ready(): Promise<void> {
    await this.hydrationPromise;
  }

  /** Mark a persisted review as read in the live state cache as well. */
  markWakeEventRead(eventId: string, readAt: number): void {
    const mark = (event: WakeEvent | null | undefined): WakeEvent | null | undefined =>
      event?.id === eventId ? { ...event, readAt } : event;
    this.runtimeState.recentWakeEvents = this.runtimeState.recentWakeEvents.map((event) =>
      event.id === eventId ? { ...event, readAt } : event,
    );
    this.runtimeState.lastWakeEvent = mark(this.runtimeState.lastWakeEvent) as WakeEvent | null;
  }

  getState(): GoatRuntimeState {
    const signal = this.runtimeState.latestSignal;
    if (signal?.status === 'ACTIONABLE') {
      const explicitExpiry = signal.expiresAt ? Date.parse(signal.expiresAt) : NaN;
      const createdAt = Date.parse(signal.createdAt);
      const expiryAt = Number.isFinite(explicitExpiry)
        ? explicitExpiry
        : Number.isFinite(createdAt)
          ? createdAt + 60 * 60_000
          : 0;
      const isStale =
        signal.thesisId !== this.runtimeState.currentThesis?.id ||
        signal.market !== this.goatConfig.markets[0] ||
        expiryAt <= this.now();
      if (isStale) {
        this.runtimeState.latestSignal = null;
        if (!this.paused) this.runtimeState.status = 'WATCHING';
        this.runtimeState.dormancyReason =
          'The previous proposal is stale or expired. A fresh market review is required.';
      }
    }
    return { ...this.runtimeState };
  }

  getConfig(): FundGoat {
    return { ...this.goatConfig };
  }

  updateConfig(goat: FundGoat, skills: TradingSkill[]): void {
    const previous = this.goatConfig;
    const analysisConfigChanged =
      previous.goal !== goat.goal ||
      previous.model !== goat.model ||
      previous.aiProvider !== goat.aiProvider ||
      JSON.stringify(previous.markets) !== JSON.stringify(goat.markets) ||
      JSON.stringify(previous.skillIds) !== JSON.stringify(goat.skillIds) ||
      JSON.stringify(this.skills) !== JSON.stringify(skills);

    if (analysisConfigChanged) {
      // An in-flight model response belongs to the old config and must not
      // overwrite a newer goal/provider/skill selection when it returns.
      if (this.runtimeState.isEvaluating) {
        this.runtimeState.generationId = this.newGenerationId();
        this.runtimeState.isEvaluating = false;
      }

      // Any undecided proposal was produced for the previous config. Retire it
      // immediately so it cannot be approved after the GOAT has been edited.
      void this.expirePendingProposals('GOAT configuration changed; a fresh market review is required.')
        .catch((error) => console.error(`[goat ${this.id}] could not expire proposals after config change:`, error));
      this.runtimeState.status = this.paused || goat.status === 'PAUSED' ? 'PAUSED' : 'WATCHING';
      this.runtimeState.dormancyReason =
        'GOAT configuration changed. Run a fresh market review before trusting a proposal.';
    }

    this.goatConfig = goat;
    this.skills = skills;

    // A config reload may carry a new PAUSED status.
    if (goat.status === 'PAUSED' && !this.paused) {
      this.pause();
      return;
    }

    // reasoningMode is derived from AI-key availability during wake — never
    // from the number of attached skills.
    this.attachMarketListeners();
  }

  /** Clear the persisted review timeline without deleting the current thesis. */
  clearReviewHistory(): GoatRuntimeState {
    this.runtimeState.recentWakeEvents = [];
    this.runtimeState.lastWakeEvent = null;
    return this.runtimeState;
  }

  /** True while the user has explicitly stopped this GOAT. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * User "Stop": halts the scheduler and tracker evaluation immediately.
   * Persisted state survives because the caller writes status = 'PAUSED'.
   */
  pause(): GoatRuntimeState {
    if (this.paused) return this.runtimeState;

    this.paused = true;

    /**
     * ABANDON IN-FLIGHT WORK, DO NOT JUST STOP SCHEDULING NEW WORK.
     *
     * Stopping the alarms is not enough. A model call already dispatched
     * keeps running, and when it returns it passes every existing check and
     * writes its thesis and its signal — after the UI has told the user
     * "Paused by the user. No analysis and no tracker evaluation will run".
     * That is a promise the runtime was silently breaking.
     *
     * The runtime already has the mechanism for exactly this: work started
     * for an older generation must never mutate newer state, enforced by
     * `isCurrentGeneration`, which compares against the ASSIGNED id. So
     * pausing assigns a fresh generation — invalidating whatever is in flight
     * at its next checkpoint — and clears the flag so the UI stops showing a
     * spinner for work that is no longer going to be recorded.
     */
    this.runtimeState.generationId = this.newGenerationId();
    this.runtimeState.isEvaluating = false;

    if (this.scheduledAlarm) {
      clearTimeout(this.scheduledAlarm);
      this.scheduledAlarm = null;
    }
    if (this.catalogueWarmTimer) {
      clearTimeout(this.catalogueWarmTimer);
      this.catalogueWarmTimer = null;
    }

    this.runtimeState.status = 'PAUSED';
    this.runtimeState.dormancyReason =
      'Paused by the user. No analysis and no tracker evaluation will run until Play is pressed.';
    this.runtimeState.nextWatchingCondition = 'Stopped.';

    return this.runtimeState;
  }

  /**
   * User "Play": re-arms the scheduler and tracker subscription.
   * Resumes from the persisted thesis rather than starting blank.
   */
  play(): GoatRuntimeState {
    if (!this.paused) return this.runtimeState;

    this.paused = false;

    this.runtimeState.status = 'WATCHING';
    this.runtimeState.dormancyReason =
      'Resumed. Deterministic trackers re-armed.';
    this.runtimeState.nextWatchingCondition =
      this.runtimeState.trackers[0]?.description ??
      `Watching ${this.goatConfig.markets.join(', ')}`;

    this.attachMarketListeners();
    this.scheduleRoutineCheck(
      this.delayForSchedule(
        normaliseSchedule(this.goatConfig.schedule),
      ),
    );

    return this.runtimeState;
  }

  /**
   * Applies a new reasoning schedule and immediately re-arms the timer.
   * Returns the effective (normalised) schedule.
   */
  setSchedule(schedule: GoatSchedule | undefined): GoatSchedule {
    const normalised = normaliseSchedule(schedule);
    this.goatConfig = { ...this.goatConfig, schedule: normalised };

    if (!this.paused) {
      this.lastSessionReviewTriggered = '';
      this.scheduleRoutineCheck(
        this.delayForSchedule(normalised),
        true,
      );
    }

    return normalised;
  }

  /** Stops all timers and subscriptions. The GOAT receives no further ticks. */
  destroy(): void {
    this.stopped = true;
    if (this.unsubscribeMarketData) {
      this.unsubscribeMarketData();
      this.unsubscribeMarketData = null;
    }
    if (this.scheduledAlarm) {
      clearTimeout(this.scheduledAlarm);
      this.scheduledAlarm = null;
    }
    if (this.catalogueWarmTimer) {
      clearTimeout(this.catalogueWarmTimer);
      this.catalogueWarmTimer = null;
    }
  }

  /**
   * Manual or tracker-triggered wake. Never throws — failures are recorded
   * in runtime state and the returned wake event.
   */
  async wake(
    reason: string,
    triggerType: WakeEvent['triggerType'] = 'MANUAL_REEVALUATE',
    targetMarket?: string,
    calculatedContext?: Record<string, unknown>,
  ): Promise<GoatRuntimeState> {
    if (this.stopped) {
      return this.runtimeState;
    }

    /**
     * A paused GOAT ignores SCHEDULED and TRACKER wakes, but still honours an
     * explicit user request (MANUAL_REEVALUATE / chat), so "Stop" never
     * silently swallows a question the user just asked.
     */
    if (
      this.paused &&
      triggerType !== 'MANUAL_REEVALUATE'
    ) {
      return this.runtimeState;
    }

    if (this.runtimeState.isEvaluating) {
      return this.runtimeState;
    }

    // Mutex + generation guard: async work started for an older generation
    // must never mutate newer state.
    const generationId = this.newGenerationId();
    this.runtimeState.isEvaluating = true;
    this.runtimeState.generationId = generationId;
    this.runtimeState.status = 'INVESTIGATING';
    this.runtimeState.lastEvaluatedAt = this.now();

    const market = targetMarket || this.goatConfig.markets[0] || '';
    if (!market) {
      this.recordFailure('GOAT has no market configured.');
      this.runtimeState.isEvaluating = false;
      return this.runtimeState;
    }

    try {
      // ---- Stage 1: market context ------------------------------------
      /**
       * Read through the shared store so GOATs waking near each other share
       * one fetch. A DEGRADED snapshot (provider unreachable, serving last
       * known values) is treated as a failure here: reasoning must not be
       * generated from prices we could not confirm.
       */
      let quote: MarketQuote | undefined;
      let candles: Candle[] = [];

      try {
        if (this.marketStateStore) {
          /**
           * Reasoning context is read on the wake timeframe (1h). Tracker
           * observation happens separately on the GOAT's tracking timeframe.
           */
          const state = await this.marketStateStore.getState(market, WAKE_TIMEFRAME);

          /**
           * Hard gate: only provider-confirmed, in-TTL data may become a
           * thesis. DEGRADED (last known values) and UNAVAILABLE are both
           * refused, so stale prices can never quietly look like a reading.
           */
          if (!isUsableMarketState(state) || !state.quote) {
            throw new Error(
              `market data is ${state.status}` +
                (state.error ? `: ${state.error}` : ''),
            );
          }

          quote = state.quote;
          candles = state.candles.slice(-WAKE_CANDLE_COUNT);
        } else {
          [quote, candles] = await Promise.all([
            this.marketProvider.getQuote(market),
            this.marketProvider.getCandles(
              market,
              WAKE_TIMEFRAME,
              WAKE_CANDLE_COUNT,
            ),
          ]);
        }

        // A fresh quote alone is not enough to support a market review. Refuse
        // to ask the model for a thesis when closed-candle history is missing
        // or the provider returned a non-positive/non-finite price.
        if (!quote || !Number.isFinite(quote.mid) || quote.mid <= 0) {
          throw new Error('Market data returned an invalid or missing mid price.');
        }
        if (candles.length < WAKE_CANDLE_COUNT) {
          throw new Error(
            `Insufficient closed-candle history for ${market}: received ${candles.length}, need ${WAKE_CANDLE_COUNT} ${WAKE_TIMEFRAME} candles. No AI review was run.`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';

        /**
         * Distinguish "unlisted instrument" from "provider down".
         *
         * A market the provider never lists CANNOT recover by retrying: the
         * honest responses are to say so in the state the user reads, and to
         * stop rewriting the invalid selection, not to keep hammering the
         * provider every few seconds. The invalid market is REMOVED from the
         * GOAT's market list — the remaining markets stay intact, and the
         * removal is logged and surfaced in dormancy state.
         */
        if (isUnlistedMarketError(err, message)) {
          const remaining = this.goatConfig.markets.filter((m) => m !== market);
          this.goatConfig = { ...this.goatConfig, markets: remaining.length > 0 ? remaining : [market] };
          console.warn(
            `[goat ${this.id}] market "${market}" is not available from the provider ` +
              `(not listed/delisted). ` +
              (remaining.length > 0
                ? `Removed from this GOAT's watch list. Remaining markets: ${remaining.join(', ')}.`
                : 'It is the only configured market; it stays configured but the GOAT cannot run until a valid market is set.'),
          );
          this.runtimeState.status = 'WATCHING';
          this.runtimeState.lastError = `Market "${market}" is not available from the data provider.`;
          this.runtimeState.dormancyReason =
            `Market "${market}" is not available from the data provider. ` +
            (remaining.length > 0
              ? 'The other configured markets continue to be watched.'
              : 'Edit this GOAT to watch a listed market.');
          await this.recordWakeEvent(
            reason, triggerType, market, 'ERROR', this.runtimeState.dormancyReason,
            'ERROR', generationId,
          );
          return this.runtimeState;
        }

        this.recordFailure(
          `Market data unavailable: ${message}`,
        );
        await this.recordWakeEvent(
          reason,
          triggerType,
          market,
          'ERROR',
          `Market data unavailable — GOAT could not investigate. Will retry with backoff.`,
          'ERROR',
          generationId,
        );
        return this.runtimeState;
      }

      if (this.stopped || !this.isCurrentGeneration(generationId)) {
        // Destroyed (GOAT deleted) or superseded — never mutate state.
        return this.runtimeState;
      }

      // ---- Stage 2: deterministic indicators --------------------------
      const struct = analyzeMarketStructure(candles, quote.mid);
      const deterministicIndicators: Record<string, unknown> = {
        rsi14: calculateRSI(candles, 14),
        ema20: calculateEMA(candles, 20),
        ema50: calculateEMA(candles, 50),
        atr14: calculateATR(candles, 14),
        structureBias: struct.bias,
        demandZone: struct.demandZone,
        supplyZone: struct.supplyZone,
      };

      // ---- Stage 3: internet research (never fatal) ---------------------
      // Research failure must not break the wake; the prompt is told the
      // research was unavailable so the model cannot imply it searched.
      let news: Awaited<ReturnType<typeof newsService.getNewsForMarkets>> = [];
      try {
        news = await newsService.getNewsForMarkets(
          this.goatConfig.markets,
          quote,
        );
      } catch (err) {
        console.warn(`[goat ${this.id}] news research failed:`, err);
        news = [];
      }

      // ---- Stage 4: reasoning (untrusted until validated) -------------
      const reasoningContext: GoatReasoningContext = {
        userId: this.goatConfig.userId,
        goatId: this.goatConfig.id,
        goatName: this.goatConfig.name,
        goatGoal: this.goatConfig.goal,
        market,
        markets: this.goatConfig.markets,
        quote,
        candles,
        skills: this.skills,
        activeThesis: this.runtimeState.currentThesis,
        wakeReason: reason,
        reviewSession: triggerType === 'SESSION_OPEN' ? 'Major Session Transition' : undefined,
        deterministicIndicators,
        dataSource: this.marketProvider.dataMode,
        news,
      };

      // Truthful labelling: reasoningMode must reflect whether an AI model
      // is actually connected for this owner. A DEMO fallback result must
      // NEVER be reported as 'AI' (the UI badge depends on it).
      let hasAiKey: boolean;
      try {
        hasAiKey = await this.reasoning.hasKeyFor(
          this.goatConfig.userId,
          this.goatConfig.aiProvider,
        );
      } catch (credentialError) {
        // Do not collapse vault/database/decryption failures into "no key".
        // That sent users to Settings without explaining that their saved key
        // existed but the server could not read it.
        const message =
          'AI credential storage is unreadable or unavailable. Verify that CREDENTIAL_ENCRYPTION_KEY is stable across all deployment instances, then re-enter the provider key in Settings if needed.';
        this.runtimeState.reasoningMode = 'DEMO';
        console.error(
          `[goat ${this.id}] AI credential lookup failed:`,
          credentialError instanceof Error ? credentialError.message : 'unknown credential lookup error',
        );
        this.recordFailure(message);
        await this.expirePendingProposals(message);
        await this.recordWakeEvent(
          reason,
          triggerType,
          market,
          'ERROR',
          message,
          'ERROR',
          generationId,
        );
        return this.runtimeState;
      }
      this.runtimeState.reasoningMode = hasAiKey ? 'AI' : 'DEMO';

      if (!hasAiKey) {
        const message =
          'AI not connected: add a valid OpenRouter/provider API key in Settings before deploying this GOAT.';
        this.recordFailure(message);
        await this.expirePendingProposals(message);
        await this.recordWakeEvent(
          reason,
          triggerType,
          market,
          'ERROR',
          message,
          'ERROR',
          generationId,
        );
        this.runtimeState.isEvaluating = false;
        return this.runtimeState;
      }

      let reasoningResult: ReasoningResult;
      try {
        reasoningResult = await this.reasoning.evaluateGoat(reasoningContext, this.goatConfig.model, this.goatConfig.aiProvider);
      } catch (err) {
        if (err instanceof ReasoningValidationError) {
          const failure = `Model response failed validation: ${err.issues.slice(0, 3).join('; ')}`;
          await this.expirePendingProposals(failure);
          this.recordFailure(failure);
          await this.recordWakeEvent(
            reason,
            triggerType,
            market,
            'ERROR',
            `REASONING_ERROR: the model response could not be validated. Proposal discarded.`,
            'ERROR',
            generationId,
            { issues: err.issues.slice(0, 10) },
          );
        } else {
          /**
           * A credits error is not a transient outage — retrying with backoff
           * will fail identically forever, and "model could not be reached"
           * sends the user looking at the network when the real cause is an
           * unfunded OpenRouter account. Say which it is, and point at the fix.
           */
          const raw = err instanceof Error ? err.message : 'unknown error';
          const outOfCredits = /insufficient credit|402|payment required|add more credits/i.test(raw);
          const modelRetired = /not listed|no endpoints found|MODEL_NOT_LISTED/i.test(raw);

          const guidance = outOfCredits
            ? 'The provider reports this account has no credits. Add credit at openrouter.ai/settings/credits, or pick a free model in Settings → AI Reasoning Engine.'
            : modelRetired
              ? 'The configured model is no longer offered by OpenRouter. Pick a current model in Settings → AI Reasoning Engine.'
              : 'Will retry with backoff.';

          const failure = `Reasoning model unavailable: ${raw}`;
          await this.expirePendingProposals(failure);
          this.recordFailure(failure);
          await this.recordWakeEvent(
            reason,
            triggerType,
            market,
            'ERROR',
            `MODEL_UNAVAILABLE: reasoning model could not be reached. ${guidance}`,
            'ERROR',
            generationId,
          );
        }
        return this.runtimeState;
      }

      if (this.stopped || !this.isCurrentGeneration(generationId)) {
        // Destroyed (GOAT deleted) or superseded — never mutate state.
        return this.runtimeState;
      }

      // ---- Stage 5: thesis --------------------------------------------
      const previousCreatedAt = Date.parse(this.runtimeState.currentThesis?.createdAt ?? '');
      const thesisTimestamp = Math.max(
        this.now(),
        Number.isFinite(previousCreatedAt) ? previousCreatedAt + 1 : 0,
      );
      const nowStr = new Date(thesisTimestamp).toISOString();
      // Every review is a new thesis version. Reusing an ID made old proposals
      // indistinguishable from the latest thesis and allowed stale approvals.
      const thesisId = this.newId('ths');
      const proposedTrackers: TrackerCondition[] = reasoningResult.thesis.trackers
        .slice(0, MAX_TRACKERS)
        .map((t, idx) => this.buildTrackerCondition(t, market, idx));

      // Routine/triggered research updates the thesis, not the active condition
      // definitions. Keep the current plan until every condition has reached a
      // terminal state; an explicit manual re-evaluation starts a new plan.
      const activePlan = this.runtimeState.trackers;
      const preservePlan =
        triggerType !== 'MANUAL_REEVALUATE' &&
        activePlan.length > 0 &&
        (triggerType === 'TRACKER_TRIGGERED' ||
          activePlan.some((condition) => !condition.isTriggered));
      const trackers: TrackerCondition[] = preservePlan
        ? activePlan.map((condition) => ({ ...condition }))
        : proposedTrackers;

      /**
       * STEP 2 output: the ordered wait-for plan.
       *
       * `triggerSequence` is only mandatory for an ACTIONABLE proposal, so on
       * a NO_TRADE the plan falls back to the observation plan. Either way the
       * user always sees what the GOAT is looking for — a NO_TRADE with no
       * stated plan is not actionable information.
       */
      const proposedTradePlan =
        reasoningResult.proposal.triggerSequence?.length
          ? reasoningResult.proposal.triggerSequence
          : reasoningResult.thesis.observationPlan
            ? [reasoningResult.thesis.observationPlan]
            : [];
      const existingThesis = this.runtimeState.currentThesis;
      const tradePlan = preservePlan
        ? (existingThesis?.tradePlan?.length
            ? [...existingThesis.tradePlan]
            : activePlan.map((condition) => condition.description))
        : proposedTradePlan;

      const newThesis: MarketThesis = {
        id: thesisId,
        userId: this.goatConfig.userId,
        goatId: this.id,
        market,
        directionalHypothesis: reasoningResult.thesis.directionalBias,
        summary: reasoningResult.thesis.summary,
        // STEP 1 output: the plain-language STATE of the asset(s).
        assetState: reasoningResult.investigation.marketView,
        tradePlan,
        supportingEvidence: reasoningResult.evidence
          .filter((e) => e.classification === 'SUPPORTING')
          .map((e) => e.observation),
        contradictoryEvidence: reasoningResult.evidence
          .filter((e) => e.classification === 'CONTRADICTORY')
          .map((e) => e.observation),
        relevantTimeframe: '1h',
        confirmationConditions: preservePlan && existingThesis
          ? [...existingThesis.confirmationConditions]
          : reasoningResult.proposal.confirmationRequired
            ? [reasoningResult.proposal.confirmationRequired]
            : tradePlan.length > 0
              ? tradePlan
              : reasoningResult.evidence
                .filter((e) => e.classification === 'SUPPORTING')
                .map((e) => `${e.source}: ${e.observation}`),
        invalidationConditions: preservePlan && existingThesis
          ? [...existingThesis.invalidationConditions]
          : reasoningResult.thesis.invalidation
            ? [reasoningResult.thesis.invalidation]
            : [],
        observationPlan: preservePlan && existingThesis
          ? existingThesis.observationPlan
          : reasoningResult.thesis.observationPlan ?? '',
        trackers,
        confidence: reasoningResult.thesis.confidence,
        status: reasoningResult.proposal.decision === 'ACTIONABLE' ? 'CONFIRMED' : 'TRACKING',
        createdAt: nowStr,
        updatedAt: nowStr,
      };

      // ---- Stage 5: deterministic gate ---------------------------------
      const constraints: HardConstraints = aggregateHardConstraints(this.skills);
      const marketMetadata = this.marketProvider.getMarketMetadata(market);
      const hasBook = quote.bidProvided !== false && quote.askProvided !== false;
      const spreadPips = hasBook && marketMetadata && marketMetadata.pipSize > 0
        ? quote.spread / marketMetadata.pipSize
        : undefined;
      const spreadBps = hasBook && Number.isFinite(quote.mid) && quote.mid > 0
        ? (quote.spread / quote.mid) * 10_000
        : undefined;
      const gatedReasoningResult: ReasoningResult = preservePlan
        ? {
            ...reasoningResult,
            proposal: {
              ...reasoningResult.proposal,
              // Never approve a proposal whose trigger sequence disagrees with
              // the immutable conditions actually being monitored.
              triggerSequence: tradePlan,
              confirmationRequired: existingThesis?.confirmationConditions?.join('; ')
                || tradePlan.join('; '),
            },
          }
        : reasoningResult;
      const gateResult = SignalGate.validate({
        reasoningResult: gatedReasoningResult,
        thesis: newThesis,
        market,
        quote,
        spreadPips,
        spreadBps,
        constraints,
        goatId: this.id,
        userId: this.goatConfig.userId,
      });

      // ---- Stage 6: persist (best-effort; persistence failure must not
      //      corrupt the wake) ------------------------------------------
      if (this.stopped || !this.isCurrentGeneration(generationId)) {
        return this.runtimeState;
      }
      const persistenceErrors: string[] = [];
      let thesisPersisted = false;
      if (this.thesisRepo) {
        try {
          await this.thesisRepo.save(newThesis);
          thesisPersisted = true;
        } catch (err) {
          persistenceErrors.push(`thesis: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      } else {
        persistenceErrors.push('thesis: repository unavailable');
      }

      // Retire undecided proposals from earlier thesis versions as soon as a
      // new thesis is persisted. The decision endpoint also checks the current
      // thesis id, so a failed cleanup cannot make an old proposal acceptable.
      if (thesisPersisted && this.signalRepo) {
        try {
          const previousSignals = await this.signalRepo.listByGoat(this.id, 500);
          for (const previous of previousSignals) {
            if (
              previous.status === 'ACTIONABLE' &&
              !previous.decision &&
              previous.thesisId !== newThesis.id
            ) {
              const expiredSignal: TradeSignal = {
                ...previous,
                status: 'EXPIRED',
                updatedAt: nowStr,
              };
              const updated = await this.signalRepo.update(expiredSignal);
              if (!updated) {
                persistenceErrors.push(`stale signal ${previous.id}: update not acknowledged`);
              }
            }
          }
        } catch (err) {
          persistenceErrors.push(`stale signals: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }

      let latestSignal: TradeSignal = gateResult.signal;
      // A proposal whose thesis was not durably recorded is never actionable.
      if (gateResult.approved && !thesisPersisted) {
        latestSignal = {
          ...gateResult.signal,
          direction: 'NO_TRADE',
          status: 'NO_TRADE',
          rationale: 'Actionable proposal suppressed because the thesis could not be persisted.',
        };
      }

      let signalPersisted = false;
      if (this.signalRepo) {
        try {
          await this.signalRepo.save(latestSignal);
          signalPersisted = true;
        } catch (err) {
          persistenceErrors.push(`signal: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      } else {
        persistenceErrors.push('signal: repository unavailable');
      }

      const actionable = gateResult.approved && thesisPersisted && signalPersisted;
      if (gateResult.approved && !actionable) {
        latestSignal = {
          ...latestSignal,
          direction: 'NO_TRADE',
          status: 'NO_TRADE',
          rationale: 'Actionable proposal suppressed because persistence was not confirmed.',
        };
      }
      const finalReasons = actionable
        ? []
        : [
            ...gateResult.reasons,
            ...(persistenceErrors.length > 0
              ? ['Persistence was not confirmed; actionable proposal suppressed.']
              : []),
          ];

      // ---- Stage 7: update runtime state -------------------------------
      this.runtimeState.currentThesis = newThesis;
      this.runtimeState.trackers = trackers;
      this.runtimeState.lastEvaluatedAt = this.now();
      this.runtimeState.consecutiveFailures = 0;
      this.runtimeState.lastError = undefined;

      const session = SessionSchedule.getCurrentSession();
      this.runtimeState.nextScheduledReview = session.nextSessionName;
      if (triggerType === 'SESSION_OPEN') {
        this.runtimeState.lastReviewSession = session.session as GoatRuntimeState['lastReviewSession'];
      }

      if (actionable) {
        this.runtimeState.status = 'ACTIVE';
        this.runtimeState.latestSignal = latestSignal;
        this.runtimeState.dormancyReason = `Active conditional setup (${latestSignal.orderType} ${latestSignal.direction} ${market} @ ${latestSignal.entry}).`;
        this.runtimeState.nextWatchingCondition = `Waiting for price to reach ${latestSignal.entryZone ? `${latestSignal.entryZone.low} - ${latestSignal.entryZone.high}` : latestSignal.entry} and confirm the setup`;
        this.notifySignal(latestSignal);
      } else {
        this.runtimeState.status = 'WATCHING';
        this.runtimeState.latestSignal = latestSignal;
        this.runtimeState.dormancyReason = finalReasons[0]
          ? `NO_TRADE: ${finalReasons[0]}`
          : 'Waiting for high-probability structural confluence.';
        this.runtimeState.nextWatchingCondition =
          trackers[0]?.description ?? `Watching ${market} key levels`;
      }

      await this.recordWakeEvent(
        reason,
        triggerType,
        market,
        actionable ? 'SIGNAL_PRODUCED' : 'NO_TRADE',
        actionable
          ? `Conditional setup formed: ${latestSignal.orderType} ${latestSignal.direction} ${market} @ ${latestSignal.entry}`
          : `NO_TRADE: ${finalReasons.join(' ') || 'waiting for high-probability condition'}`,
        actionable ? 'SIGNAL_PRODUCED' : 'NO_TRADE',
        generationId,
        { gateReasons: finalReasons, appliedConstraints: gateResult.appliedConstraints, persistenceErrors },
      );

      if (persistenceErrors.length > 0) {
        this.runtimeState.lastError = `Persistence warning: ${persistenceErrors.join('; ')}`;
        console.error(`[goat ${this.id}] persistence errors during wake:`, persistenceErrors);
      }
    } catch (err) {
      // Absolute safety net: the pipeline must never throw out of wake().
      this.recordFailure(`Unexpected wake error: ${err instanceof Error ? err.message : 'unknown error'}`);
      this.runtimeState.status = 'WATCHING';
      try {
        await this.recordWakeEvent(
          reason,
          triggerType,
          market,
          'ERROR',
          `UNEXPECTED_ERROR: ${err instanceof Error ? err.message : 'unknown error'}`,
          'ERROR',
          generationId,
        );
      } catch {
        // Even error recording failed; nothing more we can do here.
      }
    } finally {
      this.runtimeState.isEvaluating = false;
    }

    return this.runtimeState;
  }

  /* ---------------------------------------------------------------- */
  /* Deterministic tracker evaluation (no LLM here)                    */
  /* ---------------------------------------------------------------- */

  private attachMarketListeners(): void {
    if (this.unsubscribeMarketData) {
      this.unsubscribeMarketData();
      this.unsubscribeMarketData = null;
    }
    if (!this.goatConfig.markets.length || this.stopped || this.paused) return;

    /**
     * CATALOGUE NOT LOADED YET? WARM IT FIRST.
     *
     * The Hyperliquid provider's synchronous `getMarketMetadata` reads a
     * module-level cache that is populated by the first `getSymbols()` call.
     * On a cold process (boot, before any browser request) filtering against
     * an empty cache would declare EVERY market unlisted and never subscribe.
     * So the catalogue is warmed first and the listener re-attached when it
     * is ready — with a delayed retry if warming fails, so a transient boot
     * failure cannot leave the GOAT silently dormant forever.
     */
    const probe = this.marketProvider as {
      catalogueLoaded?: () => boolean;
    };
    if (typeof probe.catalogueLoaded === 'function' && !probe.catalogueLoaded()) {
      if (this.catalogueWarmTimer) return; // one warm attempt in flight
      void this.marketProvider
        .getSymbols()
        .then(() => {
          if (!this.stopped && !this.paused) this.attachMarketListeners();
        })
        .catch(() => {
          // Provider unreachable at boot: retry once after a quiet interval.
          // This retries the CATALOGUE, not an invalid instrument — a market
          // the catalogue proves unlisted is never polled in the first place.
          if (this.stopped || this.paused) return;
          this.catalogueWarmTimer = setTimeout(() => {
            this.catalogueWarmTimer = null;
            if (!this.stopped && !this.paused) this.attachMarketListeners();
          }, 30_000);
          this.catalogueWarmTimer.unref?.();
        });
      return;
    }

    /**
     * Never subscribe to a market the provider does not list.
     *
     * `getMarketMetadata` reads the provider's own discovered catalogue. An
     * unknown instrument would open a poll loop whose every tick fails and
     * logs — the repeated '<symbol> is not a market Hyperliquid lists' error —
     * so the subscription is not opened at all and the state says why.
     */
    const listed = this.goatConfig.markets.filter((market) =>
      Boolean(this.marketProvider.getMarketMetadata(market)),
    );
    if (listed.length === 0) {
      this.runtimeState.dormancyReason =
        'No market this GOAT watches is listed by the data provider. ' +
        'Edit the GOAT and pick a market from the Markets screen. ' +
        `Watched markets: ${this.goatConfig.markets.join(', ')}.`;
      this.runtimeState.nextWatchingCondition =
        'Not subscribed: markets unavailable from the provider.';
      console.warn(
        `[goat ${this.id}] not subscribing — markets not listed by provider: ` +
          `${this.goatConfig.markets.join(', ')}`,
      );
      return;
    }
    if (listed.length !== this.goatConfig.markets.length) {
      const unlisted = this.goatConfig.markets.filter((m) => !listed.includes(m));
      console.warn(
        `[goat ${this.id}] some markets are not listed and are skipped: ${unlisted.join(', ')}`,
      );
    }

    /**
     * Preferred path: subscribe through the shared MarketStateStore.
     *
     * The store keys its poll loop by SYMBOL, not by GOAT, so several GOATs
     * watching the same instrument share one fetch and one indicator
     * computation per TTL instead of each running their own. It also computes
     * the indicator snapshot once and hands it to the tracker evaluator, which
     * used to recompute every indicator on every 5-second tick per GOAT.
     *
     * Fallback (unit tests, no store supplied): subscribe to the provider
     * directly and compute inline.
     */
    if (!this.marketStateStore) {        this.unsubscribeMarketData = this.marketProvider.subscribeQuotes(
        listed,
        (quote: MarketQuote) => {
          // Fire-and-forget with full error isolation: subscriber errors must
          // never propagate into the provider's tick loop.
          void this.evaluateDeterministicTrackers(quote).catch((err) => {
            console.error(`[goat ${this.id}] tracker evaluation error:`, err);
          });
        },
      );
      return;
    }

    /** Tracking cadence comes from the user's chosen timeframe. */
    const trackingTimeframe = normaliseTrackingTimeframe(
      this.goatConfig.timeframe,
    );

    this.unsubscribeMarketData = this.marketStateStore.subscribe(
      listed[0],
      (snapshot) => {
        void this.onMarketState(snapshot).catch((err) => {
          console.error(`[goat ${this.id}] tracker evaluation error:`, err);
        });
      },
      trackingTimeframe,
      pollIntervalForTimeframe(trackingTimeframe),
    );
  }

  /**
   * Evaluates trackers once against a supplied snapshot.
   *
   * Public because the serverless path calls it on demand: there is no persistent process watching market state there, so Firebase cron
   * drives deterministic tracker checks. Deterministic and AI-free — it only
   * escalates to a reasoning wake when a condition is actually satisfied.
   *
   * Returns true when a tracker fired.
   */
  async evaluateTrackersNow(snapshot: MarketStateSnapshot): Promise<boolean> {
    return this.onMarketState(snapshot);
  }

  /**
   * Deterministic tracker evaluation against a live quote, computing
   * indicators inline. Used when no MarketStateStore is available.
   */
  private async evaluateDeterministicTrackers(quote: MarketQuote): Promise<void> {
    if (this.stopped || this.paused) return;
    if (this.runtimeState.isEvaluating) return;
    if (!this.runtimeState.trackers.some((t) => !t.isTriggered)) return;

    const candles = await this.marketProvider.getCandles(quote.symbol, '15m', 60);

    await this.runTrackers(quote, candles, undefined);
  }

  /**
   * Fired by the shared store: the same evaluation against a PRE-COMPUTED
   * indicator snapshot — no fetch, no recomputation.
   */
  private async onMarketState(
    snapshot: MarketStateSnapshot,
  ): Promise<boolean> {
    if (this.stopped || this.paused) return false;
    if (this.runtimeState.isEvaluating) return false;

    const quote = snapshot.quote;
    if (!quote) return false;

    /**
     * Trackers are deterministic but not clairvoyant: a DEGRADED snapshot is a
     * stale price and must not be allowed to fire a condition.
     */
    if (!isUsableMarketState(snapshot)) return false;

    if (!this.runtimeState.trackers.some((t) => !t.isTriggered)) {
      return false;
    }

    const candles =
      snapshot.candles.length > 0
        ? snapshot.candles
        : await this.marketProvider.getCandles(quote.symbol, '15m', 60);

    return this.runTrackers(
      quote,
      candles,
      snapshot.indicators ?? undefined,
    );
  }

  /**
   * Shared tracker loop for both the store and direct-subscription paths.
   *
   * Returns true when one or more conditions fired. Every condition is evaluated
   * and persisted before one consolidated reasoning wake runs.
   */
  private async runTrackers(
    quote: MarketQuote,
    candles: Candle[],
    indicators: IndicatorSnapshot | undefined,
  ): Promise<boolean> {
    const matchingTrackers = this.runtimeState.trackers.filter(
      (tracker) =>
        !tracker.isTriggered &&
        tracker.status !== 'HIT' &&
        tracker.status !== 'INVALIDATED' &&
        tracker.status !== 'EXPIRED' &&
        (tracker.market === quote.symbol || !tracker.market),
    );
    if (!matchingTrackers.length) return false;

    const before = this.runtimeState.trackers.map((tracker) => ({ ...tracker }));
    const marketIndicators = indicators ?? computeIndicatorSnapshot(quote, candles);
    const reports: TrackerEvaluationReport[] = [];
    let changed = false;

    // Evaluate EVERY active condition against the same candle snapshot before
    // waking the agent. Multiple conditions that transition on one bar are all
    // marked and persisted; none disappear because an earlier one fired.
    for (const tracker of matchingTrackers) {
      const isCross =
        tracker.operator === 'CROSS_ABOVE' || tracker.operator === 'CROSS_BELOW';
      const latestInput = candles.length ? candles[candles.length - 1] : null;
      // The shared Candle contract exposes OHLCV, not bar-finalization state.
      // Use the newest supplied bar rather than reading an unsupported field.
      const latestEvaluable = latestInput;
      const newestCandleMs = latestEvaluable?.time ?? null;

      // Level conditions are checked on every five-minute tracker pass, even
      // when the selected candle timeframe has not rolled. Crossovers are only
      // evaluated once per newly closed candle to avoid intrabar false crosses.
      if (
        isCross &&
        newestCandleMs != null &&
        tracker.lastEvaluatedCandleMs != null &&
        newestCandleMs <= tracker.lastEvaluatedCandleMs
      ) continue;

      const evaluation = evaluateTracker(tracker, candles, {
        lastProcessedCandleMs: isCross ? tracker.lastEvaluatedCandleMs : undefined,
        allowFormingCandle: !isCross,
      });

      tracker.lastEvaluatedAt = this.now();
      tracker.lastEvaluationReason = evaluation.reason;
      if (evaluation.evaluatedCandleMs != null) {
        tracker.lastEvaluatedCandleMs = evaluation.evaluatedCandleMs;
      }
      changed = true;

      if (evaluation.verdict === 'UNEVALUABLE') {
        tracker.status = 'UNEVALUABLE';
        continue;
      }

      tracker.status = 'PENDING';
      tracker.previousCalculatedValue = evaluation.previousValue ?? undefined;
      tracker.currentCalculatedValue = evaluation.calculatedValue ?? undefined;

      if (!evaluation.shouldWake) continue;

      tracker.status = 'HIT';
      tracker.isTriggered = true;
      tracker.triggeredAt = this.now();
      reports.push({
        isTriggered: true,
        tracker: { ...tracker },
        calculatedValue: evaluation.calculatedValue ?? undefined,
        marketContext: { ...marketIndicators, spread: quote.spread },
        eventReason: evaluation.reason,
        formulaDescription: tracker.formulaDescription ?? tracker.description,
        evaluatedCandleMs: evaluation.evaluatedCandleMs,
      });
    }

    if (!changed) return false;

    // Persist all value/status transitions in one thesis write before sending
    // alerts or invoking the model. On failure, roll back the in-memory view so
    // the same candle can be retried without claiming an unpersisted hit.
    const thesis = this.runtimeState.currentThesis;
    if (!thesis || !this.thesisRepo) {
      this.runtimeState.trackers = before.map((tracker) => ({ ...tracker }));
      if (thesis) {
        this.runtimeState.currentThesis = {
          ...thesis,
          trackers: before.map((tracker) => ({ ...tracker })),
        };
      }
      this.runtimeState.lastError = 'Tracker state could not be persisted because no current thesis repository is available.';
      return false;
    }

    const updatedThesis: MarketThesis = {
      ...thesis,
      trackers: this.runtimeState.trackers.map((item) => ({ ...item })),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.thesisRepo.save(updatedThesis);
      this.runtimeState.currentThesis = updatedThesis;
    } catch (err) {
      this.runtimeState.trackers = before.map((tracker) => ({ ...tracker }));
      this.runtimeState.currentThesis = {
        ...thesis,
        trackers: before.map((tracker) => ({ ...tracker })),
      };
      this.runtimeState.lastError =
        `Tracker state could not be persisted: ${err instanceof Error ? err.message : 'unknown error'}`;
      console.error(`[goat ${this.id}] failed to persist tracker state:`, err);
      return false;
    }

    if (reports.length === 0) return false;

    // Deliver a distinct condition-hit alert for every condition that fired,
    // then perform ONE AI re-evaluation for the whole market event.
    for (const report of reports) this.notifyTrackerTrigger(report);
    const reasons = reports.map((report) => report.eventReason);
    await this.wake(
      `Tracker condition(s) hit: ${reasons.join(' | ')}`,
      'TRACKER_TRIGGERED',
      quote.symbol,
      {
        ...reports[0].marketContext,
        trackerFormula: reports.map((report) => report.formulaDescription),
        triggeredTrackerIds: reports.map((report) => report.tracker.id),
      },
    );
    return true;
  }

  private notifyTrackerTrigger(report: TrackerEvaluationReport): void {
    if (!this.onTrackerTriggeredCallback) return;
    try {
      this.onTrackerTriggeredCallback(this.goatConfig, report);
    } catch (err) {
      console.error(`[goat ${this.id}] tracker callback error:`, err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Resilient scheduler                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Delay until the next reasoning run for the configured schedule.
   *
   * - TRACKERS : the tick only re-checks trackers; no LLM spend.
   * - MANUAL   : the tick never reasons at all (still cheap bookkeeping).
   * - INTERVAL : intervalMinutes, floored at MIN_SCHEDULE_INTERVAL_MINUTES.
   * - TIMES    : until the next local HH:MM entry.
   */
  private delayForSchedule(schedule: GoatSchedule): number {
    switch (schedule.mode) {
      case 'MANUAL':
        return Math.max(this.maxBackoffMs, 60_000);

      case 'TRACKERS':
        return this.baseCheckIntervalMs;

      case 'TIMES':
        return msUntilNextScheduledTime(
          schedule.times ?? [],
          this.now(),
        );

      case 'INTERVAL':
      default:
        return Math.max(
          (schedule.intervalMinutes ?? 60) * 60_000,
          MIN_SCHEDULE_INTERVAL_MINUTES * 60_000,
        );
    }
  }

  /**
   * Delay before the next scheduled reasoning run.
   *
   * A GOAT created through the API always carries an explicit schedule, so
   * that schedule governs. A GOAT with NO schedule (legacy documents,
   * hand-built instances and tests) falls back to the fast base interval,
   * which is the documented test seam.
   */
  private nextScheduledDelay(): number {
    const failures = this.runtimeState.consecutiveFailures;
    if (!this.goatConfig.schedule) {
      return computeBackoffDelay(this.baseCheckIntervalMs, this.maxBackoffMs, failures);
    }

    const schedule = normaliseSchedule(this.goatConfig.schedule);
    // MANUAL means no automatic reasoning retry. For scheduled GOATs, a
    // failed review gets a bounded retry delay instead of silently waiting
    // until the next long interval/session. A successful review returns to
    // the configured schedule.
    if (failures > 0 && schedule.mode !== 'MANUAL') {
      return computeBackoffDelay(this.baseCheckIntervalMs, this.maxBackoffMs, failures);
    }
    return this.delayForSchedule(schedule);
  }

  /**
   * Routine checks with bounded exponential backoff.
   *
   * A healthy GOAT is checked on its own schedule; each consecutive failure
   * doubles the delay up to maxBackoff, so a broken GOAT is not hammered.
   * A successful wake (or manual wake) resets the backoff.
   *
   * A PAUSED GOAT never arms a timer at all.
   */
  private scheduleRoutineCheck(delayMs?: number, respectSchedule = false): void {
    // The Firestore-backed scheduler owns the schedule; a local timer here would be a
    // competing source of truth that dies with the process.
    if (this.scheduler) return;
    if (this.stopped || this.paused) return;
    if (this.scheduledAlarm) clearTimeout(this.scheduledAlarm);

    const schedule = normaliseSchedule(this.goatConfig.schedule);
    const failures = this.runtimeState.consecutiveFailures;
    const backoff = computeBackoffDelay(this.baseCheckIntervalMs, this.maxBackoffMs, failures);
    const delay = delayMs ?? backoff;

    this.scheduledAlarm = setTimeout(async () => {
      if (this.stopped || this.paused) return;
      try {
        const session = SessionSchedule.getCurrentSession();
        this.runtimeState.nextScheduledReview = session.nextSessionName;

        // MANUAL = the user pays for reasoning only when they ask.
        if (schedule.mode === 'MANUAL') {
          this.runtimeState.nextWatchingCondition =
            this.runtimeState.nextWatchingCondition;
        } else if (
          this.runtimeState.consecutiveFailures > 0 &&
          !this.runtimeState.isEvaluating
        ) {
          // A failed AI wake must be retried after backoff even for TRACKERS
          // schedules, whose healthy ticks normally avoid model calls.
          await this.wake(
            `Retry after previous failure (${this.runtimeState.consecutiveFailures} consecutive failures)`,
            'SCHEDULED',
          );
        } else if (
          schedule.mode !== 'TRACKERS' &&
          !this.runtimeState.isEvaluating &&
          (respectSchedule === false ||
            this.now() - this.runtimeState.lastEvaluatedAt >= this.periodicReviewMs)
        ) {
          if (
            session.isTransitionActive &&
            this.lastSessionReviewTriggered !== session.session
          ) {
            this.lastSessionReviewTriggered = session.session;
            await this.wake(`Scheduled Market Review: ${session.name}`, 'SESSION_OPEN');
          } else {
            await this.wake(
              `Scheduled analysis (${describeSchedule(schedule)})`,
              'SCHEDULED',
            );
          }
        }
      } catch (err) {
        // Scheduler must never crash the process or tight-loop.
        console.error(`[goat ${this.id}] scheduler tick error:`, err);
      } finally {
        // Always re-arm on the *current* schedule, ignoring the one-shot delay.
        this.scheduleRoutineCheck(this.nextScheduledDelay());
      }
    }, delay);

    this.scheduledAlarm.unref?.();
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private recordFailure(message: string): void {
    this.runtimeState.consecutiveFailures += 1;
    this.runtimeState.lastError = message;
    this.runtimeState.status = 'WATCHING';
    console.error(`[goat ${this.id}] ${message} (consecutive failures: ${this.runtimeState.consecutiveFailures})`);
  }

  /**
   * A failed current review cannot leave an older, undecided ACTIONABLE signal
   * presented as the GOAT's trusted recommendation. Retire persisted pending
   * proposals and mirror that status in the live actor state. Finalised user
   * decisions are immutable and are deliberately not changed.
   */
  private async expirePendingProposals(reason: string): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const current = this.runtimeState.latestSignal;
    if (current?.status === 'ACTIONABLE' && !current.decision) {
      this.runtimeState.latestSignal = {
        ...current,
        status: 'EXPIRED',
        updatedAt: now,
        rationale: `${current.rationale} Expired because the latest AI review failed: ${reason.slice(0, 300)}`,
      };
    }

    if (!this.signalRepo) return;
    try {
      const signals = await this.signalRepo.listByGoat(this.id, 500);
      for (const signal of signals) {
        if (signal.status !== 'ACTIONABLE' || signal.decision) continue;
        const expired: TradeSignal = {
          ...signal,
          status: 'EXPIRED',
          updatedAt: now,
          rationale: `${signal.rationale} Expired because the latest AI review failed: ${reason.slice(0, 300)}`,
        };
        const saved = await this.signalRepo.update(expired);
        if (!saved) {
          console.warn(`[goat ${this.id}] pending proposal ${signal.id} could not be expired after review failure.`);
          continue;
        }
        if (this.runtimeState.latestSignal?.id === signal.id) {
          this.runtimeState.latestSignal = expired;
        }
      }
    } catch (error) {
      console.error(`[goat ${this.id}] could not expire pending proposals after review failure:`, error);
    }
  }

  private isCurrentGeneration(generationId: string): boolean {
    return this.runtimeState.generationId === generationId;
  }

  private notifySignal(signal: TradeSignal): void {
    if (!this.onSignalCallback) return;
    try {
      this.onSignalCallback(this.goatConfig, signal);
    } catch (err) {
      console.error(`[goat ${this.id}] signal callback error:`, err);
    }
  }

  /**
   * Maps a model-written tracker directive into a deterministic, re-computable
   * condition. The model chooses WHAT to watch; this runtime decides HOW it is
   * measured, and the evaluator never calls an LLM.
   */
  private buildTrackerCondition(
    directive: TrackerDirective,
    market: string,
    index: number,
  ): TrackerCondition {
    const indicatorParams: TrackerIndicatorParams | undefined =
      directive.indicator
        ? {
            indicator: directive.indicator,
            period: directive.period,
            fastPeriod: directive.fastPeriod,
            slowPeriod: directive.slowPeriod,
            session: directive.session,
          }
        : directive.session
          ? { indicator: 'SESSION_HIGH', session: directive.session }
          : undefined;

    return {
      id: `${this.newId('trk')}_${index}`,
      description: directive.description,
      type: directive.type,
      market,
      targetValue: directive.targetValue,
      rangeLow: directive.rangeLow,
      rangeHigh: directive.rangeHigh,
      operator: directive.operator,
      indicatorParams,
      formulaDescription: describeTrackerFormula(directive),
      status: 'PENDING',
      isTriggered: false,
    };
  }

  private async recordWakeEvent(
    reason: string,
    triggerType: WakeEvent['triggerType'],
    market: string,
    decisionResult: WakeEvent['decisionResult'],
    details: string,
    evidenceSnapshotKind: 'SIGNAL_PRODUCED' | 'NO_TRADE' | 'ERROR',
    generationId: string,
    calculatedContext?: Record<string, unknown>,
  ): Promise<void> {
    // A destroyed actor (GOAT deleted mid-wake) must not keep writing.
    if (this.stopped) {
      return;
    }
    const event: WakeEvent = {
      id: this.newId('ev'),
      goatId: this.id,
      timestamp: Date.now(),
      reason,
      market,
      triggerType,
      evidenceSnapshot: evidenceSnapshotKind,
      decisionResult,
      details,
      calculatedContext: {
        ...calculatedContext,
        generationId,
        dataSource: this.marketProvider.dataMode,
      },
    };

    this.runtimeState.lastWakeEvent = event;
    this.runtimeState.recentWakeEvents = [event, ...this.runtimeState.recentWakeEvents].slice(0, 20);

    try {
      await this.wakeEventRepo?.save(event);
    } catch (err) {
      console.error(`[goat ${this.id}] failed to persist wake event:`, err);
    }
  }

  /**
   * RESTORES THE LAST PERSISTED REVIEW INTO RUNTIME STATE.
   *
   * WHY THIS IS NECESSARY, NOT A NICETY
   *
   *   Runtime state lives in memory. On Vercel a function instance is
   *   recycled constantly, so `restoreRuntimes()` rebuilds every actor from
   *   the persisted GOAT record — which contains no thesis, no trackers and
   *   no wake event. The constructor therefore produced a GOAT that looked
   *   like it had never been reviewed, even though its thesis was sitting in
   *   Firestore the whole time.
   *
   *   Combined with missing scheduled dispatch, nothing ever ran a wake to repopulate it. The user's Initial Market Review simply disappeared the
   *   first time their instance recycled — which, on a serverless host with a
   *   short idle window, is seconds.
   *
   * WHAT IT RESTORES
   *
   *   The most recent thesis, the trackers derived from it, the most recent
   *   signal, and the recent wake events — i.e. everything the user is shown
   *   as "the review". It never invents state: if nothing is persisted, the
   *   GOAT stays visibly unreviewed, which is the honest outcome.
   *
   * WHY IT DOES NOT RE-RUN THE MODEL
   *
   *   Hydration must never spend a token or fail a request. A GOAT with no
   *   persisted thesis is left pending, and the resume-on-read path in
   *   `apiRouter` decides whether to schedule real work for it.
   *
   * GUARDS
   *
   *   Never overwrites newer in-memory state (a wake may already be running),
   *   never runs after `destroy()`, and never throws into the constructor.
   */
  private async hydrateFromPersistence(): Promise<void> {
    if (this.stopped) return;

    try {
      const [theses, signals, events] = await Promise.all([
        this.thesisRepo?.listByGoat(this.id, 1) ?? Promise.resolve([]),
        this.signalRepo?.listByGoat(this.id, 1) ?? Promise.resolve([]),
        this.wakeEventRepo?.listByGoat(this.id, 10) ?? Promise.resolve([]),
      ]);

      // A wake that started while we were reading has newer state than the
      // rows we just loaded. Never clobber it.
      if (this.stopped || this.runtimeState.currentThesis) return;

      const thesis = theses[0] ?? null;
      const signal = signals[0] ?? null;
      const wakeEvents = events ?? [];

      if (thesis) {
        this.runtimeState.currentThesis = thesis;
        this.runtimeState.lastEvaluatedAt = Date.parse(thesis.createdAt) || this.now();

        /**
         * Trackers are persisted ON the thesis (`MarketThesis.trackers`),
         * written by the wake path, so they are restored verbatim rather than
         * re-derived. Rebuilding them from the prose plan would silently
         * downgrade every alert to a placeholder PRICE condition — the user
         * would see their GOAT "watching" something it is not actually
         * evaluating.
         */
        if (Array.isArray(thesis.trackers) && thesis.trackers.length > 0) {
          this.runtimeState.trackers = thesis.trackers;
        }

        this.runtimeState.dormancyReason = thesis.tradePlan?.length
          ? `Restored from the last review: waiting for ${thesis.tradePlan[0]}`
          : 'Restored from the last review. No further condition recorded.';
      }

      if (signal) {
        const matchesCurrentThesis =
          Boolean(thesis) &&
          signal.thesisId === thesis?.id &&
          signal.market === this.goatConfig.markets[0];
        const explicitExpiry = signal.expiresAt ? Date.parse(signal.expiresAt) : NaN;
        const signalCreatedAt = Date.parse(signal.createdAt);
        const expiryAt = Number.isFinite(explicitExpiry)
          ? explicitExpiry
          : Number.isFinite(signalCreatedAt)
            ? signalCreatedAt + 60 * 60_000
            : 0;
        const expiredActionable =
          signal.status === 'ACTIONABLE' && expiryAt <= this.now();

        if (matchesCurrentThesis && !expiredActionable) {
          this.runtimeState.latestSignal = signal;
          if (
            signal.status === 'ACTIONABLE' &&
            signal.direction !== 'NO_TRADE' &&
            !this.paused
          ) {
            this.runtimeState.status = 'ACTIVE';
            this.runtimeState.dormancyReason =
              `Restored actionable proposal for ${signal.market}; it expires at ${new Date(expiryAt).toISOString()}.`;
          }
        } else {
          // Never rehydrate an old proposal as the current actionable result.
          this.runtimeState.latestSignal = null;
          if (!this.paused) {
            this.runtimeState.status = 'WATCHING';
            this.runtimeState.dormancyReason = expiredActionable
              ? 'The previous proposal expired. A fresh market review is required before another action.'
              : 'The previous proposal belongs to an older thesis. Waiting for a current review.';
          }
        }
      }

      const lastEvent = wakeEvents[0] ?? null;
      if (lastEvent) {
        this.runtimeState.lastWakeEvent = lastEvent;
        this.runtimeState.recentWakeEvents = wakeEvents;
        if (lastEvent.decisionResult === 'ERROR') {
          this.runtimeState.lastError = lastEvent.details || 'The last market review failed.';
          this.runtimeState.consecutiveFailures = Math.max(1, this.runtimeState.consecutiveFailures);
        } else {
          this.runtimeState.lastError = undefined;
          this.runtimeState.consecutiveFailures = 0;
        }
      }

      /**
       * The review is only marked complete when something was actually
       * restored. A GOAT with no persisted thesis stays visibly pending so
       * the resume path can schedule real work for it, rather than looking
       * reviewed because an empty list hydrated successfully.
       *
       * The existing `dormancyReason` is PRESERVED when it is more specific
       * than the generic initialisation text. `attachMarketListeners` writes a
       * precise explanation when a GOAT watches only unlisted markets, and
       * overwriting it with "awaiting initial market review" would hide the
       * only thing the user can actually act on.
       */
      if (
        !thesis &&
        !this.paused &&
        this.runtimeState.dormancyReason.startsWith('Initialized.')
      ) {
        this.runtimeState.dormancyReason =
          'Awaiting initial market review. Analysis is scheduled to run.';
      }
    } catch (err) {
      // Hydration is an enrichment. Never let it break construction.
      console.error(`[goat ${this.id}] failed to hydrate from persistence:`, err);
    }
  }

  private newGenerationId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Whether a reasoning run is currently in flight. This is in-memory runtime
   * state (not persisted), so it can only answer for the process that owns the
   * actor — which is exactly where this method is used (the scheduler routes).
   */
  isEvaluating(): boolean {
    return this.runtimeState.isEvaluating;
  }

  private newId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
}
