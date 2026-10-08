/**
 * GOAT DURABLE OBJECT (in-process actor)
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
  SignalGoat,
  GoatRuntimeState,
  GoatSchedule,
  MarketThesis,
  TrackerCondition,
  TrackerIndicatorParams,
  WakeEvent,
  TradeSignal,
  TradingSkill,
  MarketQuote,
} from '../../types';
import { MarketDataProvider } from '../market-data/MarketDataProvider';
import { ReasoningResult, ReasoningValidationError, TrackerDirective } from '../agent/contracts';
import { GoatReasoningContext } from '../ai/OpenRouterClient';
import { SignalGate } from '../agent/SignalGate';
import { aggregateHardConstraints, HardConstraints } from '../agent/SkillConstraints';
import { TrackerEvaluator, TrackerEvaluationReport } from '../tracker-sdk/TrackerEvaluator';
import { SessionSchedule } from '../tracker-sdk/SessionSchedule';
import { analyzeMarketStructure, calculateRSI, calculateEMA, calculateATR } from '../tracker-sdk/indicators';
import { ReasoningGateway } from '../../server/reasoningGateway';
import { newsService } from '../news/NewsService';
import {
  SignalRepository,
  ThesisRepository,
  WakeEventRepository,
} from '../../server/repositories';

export interface GoatDurableObjectOptions {
  reasoning: ReasoningGateway;
  marketProvider: MarketDataProvider;
  signals?: SignalRepository;
  theses?: ThesisRepository;
  wakeEvents?: WakeEventRepository;
  /** Called when the gate approves a signal (Telegram notifier, etc.). */
  onSignal?: (goat: SignalGoat, signal: TradeSignal) => void;
  /**
   * Called when a deterministic tracker condition is satisfied. This is the
   * "your wait-for condition just hit" alert — distinct from a signal.
   */
  onTrackerTriggered?: (
    goat: SignalGoat,
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
}

const DEFAULT_BASE_INTERVAL_MS = 45_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
const PERIODIC_REVIEW_MS = 5 * 60_000;
const MAX_TRACKERS = 10;

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
      const times = (schedule.times ?? [])
        .filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t))
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

    return `${label} ${directive.operator ?? 'REACHED'} ${directive.targetValue ?? 'level'}`;
  }

  return `${directive.type} ${directive.operator ?? 'CONDITION'} ${directive.targetValue ?? 'level'}`;
}

export class GoatDurableObject {
  readonly id: string;

  private goatConfig: SignalGoat;
  private skills: TradingSkill[];
  private runtimeState: GoatRuntimeState;

  private readonly reasoning: ReasoningGateway;
  private readonly marketProvider: MarketDataProvider;
  private readonly signalRepo?: SignalRepository;
  private readonly thesisRepo?: ThesisRepository;
  private readonly wakeEventRepo?: WakeEventRepository;
  private readonly onSignalCallback?: (goat: SignalGoat, signal: TradeSignal) => void;
  private readonly onTrackerTriggeredCallback?: (
    goat: SignalGoat,
    report: TrackerEvaluationReport,
  ) => void;

  private unsubscribeMarketData: (() => void) | null = null;
  private scheduledAlarm: ReturnType<typeof setTimeout> | null = null;
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

  constructor(goat: SignalGoat, skills: TradingSkill[], options: GoatDurableObjectOptions) {
    this.id = goat.id;
    this.goatConfig = goat;
    this.skills = skills;
    this.reasoning = options.reasoning;
    this.marketProvider = options.marketProvider;
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

    if (options.autoStartScheduler !== false && !this.paused) {
      this.scheduleRoutineCheck(this.baseCheckIntervalMs);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public surface                                                    */
  /* ---------------------------------------------------------------- */

  getState(): GoatRuntimeState {
    return { ...this.runtimeState };
  }

  getConfig(): SignalGoat {
    return { ...this.goatConfig };
  }

  updateConfig(goat: SignalGoat, skills: TradingSkill[]): void {
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

    if (this.scheduledAlarm) {
      clearTimeout(this.scheduledAlarm);
      this.scheduledAlarm = null;
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

    const market = targetMarket || this.goatConfig.markets[0] || 'EUR/USD';

    try {
      // ---- Stage 1: market context ------------------------------------
      let quote: MarketQuote | undefined;
      let candles: Awaited<ReturnType<MarketDataProvider['getCandles']>> = [];

      try {
        [quote, candles] = await Promise.all([
          this.marketProvider.getQuote(market),
          this.marketProvider.getCandles(market, '1h', 35),
        ]);
      } catch (err) {
        this.recordFailure(
          `Market data unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
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
      const hasAiKey = await this.reasoning
        .hasKeyFor(this.goatConfig.userId)
        .catch(() => false);
      this.runtimeState.reasoningMode = hasAiKey ? 'AI' : 'DEMO';

      let reasoningResult: ReasoningResult;
      try {
        reasoningResult = await this.reasoning.evaluateGoat(reasoningContext, this.goatConfig.model);
      } catch (err) {
        if (err instanceof ReasoningValidationError) {
          this.recordFailure(`Model response failed validation: ${err.issues.slice(0, 3).join('; ')}`);
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
          this.recordFailure(`Reasoning model unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
          await this.recordWakeEvent(
            reason,
            triggerType,
            market,
            'ERROR',
            `MODEL_UNAVAILABLE: reasoning model could not be reached. Will retry with backoff.`,
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
      const nowStr = new Date().toISOString();
      const thesisId = this.runtimeState.currentThesis?.id || this.newId('ths');
      const trackers: TrackerCondition[] = reasoningResult.thesis.trackers
        .slice(0, MAX_TRACKERS)
        .map((t, idx) =>
          this.buildTrackerCondition(t, market, idx),
        );

      /**
       * STEP 2 output: the ordered wait-for plan.
       *
       * `triggerSequence` is only mandatory for an ACTIONABLE proposal, so on
       * a NO_TRADE the plan falls back to the observation plan. Either way the
       * user always sees what the GOAT is looking for — a NO_TRADE with no
       * stated plan is not actionable information.
       */
      const tradePlan =
        reasoningResult.proposal.triggerSequence?.length
          ? reasoningResult.proposal.triggerSequence
          : reasoningResult.thesis.observationPlan
            ? [reasoningResult.thesis.observationPlan]
            : [];

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
        confirmationConditions:
          reasoningResult.proposal.confirmationRequired
            ? [reasoningResult.proposal.confirmationRequired]
            : tradePlan.length > 0
              ? tradePlan
              : reasoningResult.evidence
                .filter((e) => e.classification === 'SUPPORTING')
                .map((e) => `${e.source}: ${e.observation}`),
        invalidationConditions: reasoningResult.thesis.invalidation
          ? [reasoningResult.thesis.invalidation]
          : [],
        observationPlan: reasoningResult.thesis.observationPlan ?? '',
        trackers,
        confidence: reasoningResult.thesis.confidence,
        status: reasoningResult.proposal.decision === 'ACTIONABLE' ? 'CONFIRMED' : 'TRACKING',
        createdAt: this.runtimeState.currentThesis?.createdAt || nowStr,
        updatedAt: nowStr,
      };

      // ---- Stage 5: deterministic gate ---------------------------------
      const constraints: HardConstraints = aggregateHardConstraints(this.skills);
      const gateResult = SignalGate.validate({
        reasoningResult,
        thesis: newThesis,
        market,
        quote,
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
      try {
        await this.thesisRepo?.save(newThesis);
      } catch (err) {
        persistenceErrors.push(`thesis: ${err instanceof Error ? err.message : 'unknown'}`);
      }

      let latestSignal: TradeSignal = gateResult.signal;
      try {
        await this.signalRepo?.save(gateResult.signal);
      } catch (err) {
        persistenceErrors.push(`signal: ${err instanceof Error ? err.message : 'unknown'}`);
      }

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

      if (gateResult.approved) {
        this.runtimeState.status = 'ACTIVE';
        this.runtimeState.latestSignal = latestSignal;
        this.runtimeState.dormancyReason = `Active conditional setup (${latestSignal.orderType} ${latestSignal.direction} ${market} @ ${latestSignal.entry}).`;
        this.runtimeState.nextWatchingCondition = `Waiting for price to reach ${latestSignal.entryZone ? `${latestSignal.entryZone.low} - ${latestSignal.entryZone.high}` : latestSignal.entry} and confirm the setup`;
        this.notifySignal(latestSignal);
      } else {
        this.runtimeState.status = 'WATCHING';
        this.runtimeState.latestSignal = latestSignal;
        this.runtimeState.dormancyReason = gateResult.reasons[0]
          ? `NO_TRADE: ${gateResult.reasons[0]}`
          : 'Waiting for high-probability structural confluence.';
        this.runtimeState.nextWatchingCondition =
          trackers[0]?.description ?? `Watching ${market} key levels`;
      }

      await this.recordWakeEvent(
        reason,
        triggerType,
        market,
        gateResult.approved ? 'SIGNAL_PRODUCED' : 'NO_TRADE',
        gateResult.approved
          ? `Conditional setup formed: ${latestSignal.orderType} ${latestSignal.direction} ${market} @ ${latestSignal.entry}`
          : `NO_TRADE: ${gateResult.reasons.join(' ') || 'waiting for high-probability condition'}`,
        gateResult.approved ? 'SIGNAL_PRODUCED' : 'NO_TRADE',
        generationId,
        { gateReasons: gateResult.reasons, appliedConstraints: gateResult.appliedConstraints },
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
    if (!this.goatConfig.markets.length || this.stopped) return;

    this.unsubscribeMarketData = this.marketProvider.subscribeQuotes(
      this.goatConfig.markets,
      (quote: MarketQuote) => {
        // Fire-and-forget with full error isolation: subscriber errors must
        // never propagate into the market provider's tick loop.
        this.evaluateDeterministicTrackers(quote).catch((err) => {
          console.error(`[goat ${this.id}] tracker evaluation error:`, err);
        });
      },
    );
  }

  private async evaluateDeterministicTrackers(quote: MarketQuote): Promise<void> {
    if (this.stopped || this.paused) return;
    if (this.runtimeState.isEvaluating) return;

    const matchingTrackers = this.runtimeState.trackers.filter(
      (t) => !t.isTriggered && (t.market === quote.symbol || !t.market),
    );
    if (!matchingTrackers.length) return;

    const candles = await this.marketProvider.getCandles(quote.symbol, '15m', 60);

    for (const tracker of matchingTrackers) {
      const report = TrackerEvaluator.evaluate(tracker, quote, candles);
      if (report.isTriggered) {
        tracker.isTriggered = true;
        tracker.triggeredAt = this.now();
        tracker.currentCalculatedValue = report.calculatedValue;

        /**
         * Alert the user FIRST: this is the "your wait-for condition just
         * hit" notification. The follow-up reasoning run happens after.
         */
        this.notifyTrackerTrigger(report);

        await this.wake(
          `Tracker triggered: ${report.eventReason}`,
          'TRACKER_TRIGGERED',
          quote.symbol,
          { ...report.marketContext, trackerFormula: report.formulaDescription },
        );
        break;
      }
    }
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
    if (!this.goatConfig.schedule) {
      return computeBackoffDelay(
        this.baseCheckIntervalMs,
        this.maxBackoffMs,
        this.runtimeState.consecutiveFailures,
      );
    }

    return this.delayForSchedule(
      normaliseSchedule(this.goatConfig.schedule),
    );
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
      operator: directive.operator,
      indicatorParams,
      formulaDescription: describeTrackerFormula(directive),
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

  private newGenerationId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private newId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
}
