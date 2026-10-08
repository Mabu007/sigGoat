/**
 * WAKE SCHEDULER BOUNDARY
 * ======================
 * The application owns persistence, market data and AI. It does NOT need to
 * own a timer.
 *
 * `WakeScheduler` is the seam that lets a Cloudflare Durable Object own the
 * authoritative schedule state (durable, alarm-backed, survives restarts and
 * redeploys) while this application remains the Vercel host that actually does
 * the work.
 *
 * WHY THIS SHAPE
 *
 * A Durable Object cannot run `firebase-admin` (it needs Node `crypto`/gRPC,
 * unavailable on the Workers runtime). Rather than forcing Node-only code into
 * the DO, or inventing a second source of truth, the DO is given exactly two
 * jobs:
 *
 *   1. remember when each GOAT is next due (durable storage)
 *   2. when an alarm fires, POST an authenticated callback to the Vercel app
 *
 * All data, all AI and all persistence stay on the Vercel side. The DO holds
 * scheduling state only, which is precisely the state that belongs to it.
 *
 * IDEMPOTENCY
 *
 * Alarms can be delivered more than once (at-least-once delivery, retries,
 * a redeploy racing an in-flight alarm). Every wake therefore carries an
 * `eventId` and a `generationId`; `decide()` is the single place that decides
 * whether a wake may proceed, so duplicate suppression cannot be bypassed by
 * adding a new trigger path.
 */

export type WakeReasonKind =
  | 'SCHEDULED'
  | 'SESSION_OPEN'
  | 'TRACKER_TRIGGERED'
  | 'MANUAL_REEVALUATE';

export interface ScheduleRequest {
  goatId: string;
  /** ISO timestamp of the next reasoning wake. Null means "no alarm". */
  nextWakeAt: string | null;
  /**
   * ISO timestamp of the next deterministic tracker check. Costs no AI and is
   * what lets trackers fire on hosts with no persistent process.
   */
  nextTrackerCheckAt: string | null;
  /** The GOAT's tracking timeframe, for the receiver's own validation. */
  timeframe: string;
  /** Bumped whenever the schedule changes; stale alarms are ignored. */
  generationId: string;
  /** Suppresses the wake entirely (paused GOAT). */
  paused?: boolean;
}

export interface FiredWake {
  goatId: string;
  /** Unique per alarm delivery. Used as the idempotency key. */
  eventId: string;
  /** Schedule generation that produced this alarm. */
  generationId: string;
  reason: string;
  firedAt: number;
}

export interface SchedulerHealth {
  kind: 'durable-object' | 'in-process' | 'disabled';
  /** Set when kind is 'durable-object'. */
  endpoint?: string;
  /** Last successful sync, epoch ms. */
  lastSyncAt?: number;
  /** Consecutive sync failures; the app keeps working without the DO. */
  consecutiveFailures?: number;
  lastError?: string;
}

export interface WakeScheduler {
  readonly kind: SchedulerHealth['kind'];

  /**
   * Publish (or clear) the authoritative next-wake time for a GOAT.
   *
   * MUST be safe to call repeatedly: publishing the same generation is a
   * no-op, so a retried request cannot create a second alarm.
   */
  sync(request: ScheduleRequest): Promise<void>;

  /** Clears all state for a GOAT. Used on delete. */
  cancel(goatId: string): Promise<void>;

  /**
   * Single authority on whether a wake may run.
   *
   * Returns the reason, or a rejection reason when it must be suppressed:
   * paused GOAT, duplicate delivery of an already-processed event, or a stale
   * generation from a superseded schedule.
   */
  decide(
    goatId: string,
    event: FiredWake,
  ): { allowed: true } | { allowed: false; reason: string };

  health(): SchedulerHealth;
}
