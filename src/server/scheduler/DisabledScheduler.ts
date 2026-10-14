import type { FiredWake, ScheduleRequest, SchedulerHealth, WakeScheduler } from './types';

/**
 * Fail-closed scheduler used on production/ephemeral hosts when Firebase
 * Admin is unavailable. A process-local timer is not a safe substitute:
 * serverless instances restart and would silently lose scheduled work.
 */
export class DisabledScheduler implements WakeScheduler {
  readonly kind = 'disabled' as const;

  constructor(private readonly reason: string) {}

  async sync(_request: ScheduleRequest): Promise<void> {
    throw new Error(this.reason);
  }

  async cancel(_goatId: string): Promise<void> {
    // There is no local or remote schedule to cancel.
  }

  decide(_goatId: string, _event: FiredWake): { allowed: true } | { allowed: false; reason: string } {
    return { allowed: false, reason: this.reason };
  }

  health(): SchedulerHealth {
    return {
      kind: 'disabled',
      consecutiveFailures: 1,
      lastError: this.reason,
    };
  }
}
