/**
 * IN-PROCESS SCHEDULER
 * ====================
 * Local development and single-process fallback.
 *
 * This is NOT a production scheduler: the timers live in one process and are
 * lost on restart or redeploy. It exists so `npm run dev` works with no
 * Cloudflare account, and so the Durable Object path can be introduced
 * without a big-bang cutover.
 *
 * `kind` is reported by /api/settings/status, so a deployment that is
 * accidentally running on in-process timers is visible rather than silent.
 */

import type {
  FiredWake,
  ScheduleRequest,
  SchedulerHealth,
  WakeScheduler,
} from './types';

export class InProcessScheduler implements WakeScheduler {
  readonly kind = 'in-process' as const;

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly trackerTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly generations = new Map<string, string>();
  private readonly paused = new Set<string>();
  private readonly processedEvents = new Set<string>();
  private readonly processedOrder: string[] = [];

  private static readonly MAX_PROCESSED_EVENTS = 500;

  /** Invoked when an in-process alarm comes due. */
  constructor(
    private readonly onFire: (wake: FiredWake) => void | Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async sync(request: ScheduleRequest): Promise<void> {
    this.cancelTimer(request.goatId);
    this.cancelTrackerTimer(request.goatId);

    if (request.paused) {
      this.paused.add(request.goatId);
    } else {
      this.paused.delete(request.goatId);
    }

    this.generations.set(request.goatId, request.generationId);

    if (request.paused || !request.nextWakeAt) return;

    const due = Date.parse(request.nextWakeAt);
    if (!Number.isFinite(due)) return;

    const delay = Math.max(0, due - this.now());

    const timer = setTimeout(() => {
      this.timers.delete(request.goatId);
      void this.onFire({
        goatId: request.goatId,
        eventId: `${request.generationId}:REASONING:${due}`,
        generationId: request.generationId,
        reason: 'In-process schedule',
        firedAt: this.now(),
      });
    }, delay);

    timer.unref?.();
    this.timers.set(request.goatId, timer);

    /** Tracker checks are armed alongside reasoning wakes. */
    if (request.nextTrackerCheckAt) {
      const trackerDue = Date.parse(request.nextTrackerCheckAt);
      if (Number.isFinite(trackerDue)) {
        const trackerDelay = Math.max(0, trackerDue - this.now());
        const trackerTimer = setTimeout(() => {
          this.trackerTimers.delete(request.goatId);
          void this.onTrackerCheck({
            goatId: request.goatId,
            eventId: `${request.generationId}:TRACKER_CHECK:${trackerDue}`,
            generationId: request.generationId,
            reason: 'In-process tracker check',
            firedAt: this.now(),
          });
        }, trackerDelay);
        trackerTimer.unref?.();
        this.trackerTimers.set(request.goatId, trackerTimer);
      }
    }
  }

  /** Invoked for a tracker check; the default implementation is a no-op. */
  onTrackerCheck: (wake: FiredWake) => void | Promise<void> = async () => {};

  async cancel(goatId: string): Promise<void> {
    this.cancelTimer(goatId);
    this.cancelTrackerTimer(goatId);
    this.generations.delete(goatId);
    this.paused.delete(goatId);
  }

  decide(
    goatId: string,
    event: FiredWake,
  ): { allowed: true } | { allowed: false; reason: string } {
    if (this.paused.has(goatId)) {
      return { allowed: false, reason: 'goat is paused' };
    }

    const expected = this.generations.get(goatId);
    if (expected && expected !== event.generationId) {
      return { allowed: false, reason: 'stale generation' };
    }

    if (this.processedEvents.has(event.eventId)) {
      return { allowed: false, reason: 'duplicate event' };
    }

    this.processedEvents.add(event.eventId);
    this.processedOrder.push(event.eventId);

    while (
      this.processedOrder.length > InProcessScheduler.MAX_PROCESSED_EVENTS
    ) {
      const oldest = this.processedOrder.shift();
      if (oldest) this.processedEvents.delete(oldest);
    }

    return { allowed: true };
  }

  health(): SchedulerHealth {
    return { kind: this.kind, lastSyncAt: this.now() };
  }

  activeTimers(): number {
    return this.timers.size + this.trackerTimers.size;
  }

  private cancelTrackerTimer(goatId: string): void {
    const timer = this.trackerTimers.get(goatId);
    if (timer) {
      clearTimeout(timer);
      this.trackerTimers.delete(goatId);
    }
  }

  private cancelTimer(goatId: string): void {
    const timer = this.timers.get(goatId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(goatId);
    }
  }
}
