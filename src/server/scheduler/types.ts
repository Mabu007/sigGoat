/**
 * FIREBASE-BACKED WAKE SCHEDULER BOUNDARY
 * =======================================
 * Firestore owns the authoritative due times, schedule generations and leases.
 * A server-side cron invocation claims due work, executes it in the Node runtime,
 * and advances the schedule after the work completes. In-process timers exist
 * only as a local-development fallback.
 *
 * Every wake carries an event id and generation id so retries are idempotent
 * and a superseded schedule cannot execute stale work.
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
  kind: 'firebase' | 'in-process' | 'disabled';
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
   * MUST be safe to call repeatedly: publishing an unchanged generation is
   * a no-op, so a retried request cannot create duplicate scheduled work.
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
