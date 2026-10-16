import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import type { FiredWake, ScheduleRequest, SchedulerHealth, WakeScheduler } from './types';

/** Firestore owns due times and leases; Cloudflare Worker Cron dispatches the existing Node/AI workflow. */
export class FirebaseScheduler implements WakeScheduler {
  readonly kind = 'firebase' as const;
  private readonly schedules;
  private readonly processed = new Map<string, { eventId: string; at: number }>();
  private lastSyncAt?: number;
  private lastError?: string;

  constructor(private readonly db: Firestore, private readonly now: () => number = Date.now) {
    this.schedules = db.collection('goatSchedules');
  }

  async sync(request: ScheduleRequest): Promise<void> {
    try {
      const ref = this.schedules.doc(request.goatId);
      const snapshot = await ref.get();
      const existing = snapshot.exists ? snapshot.data() : undefined;
      const paused = Boolean(request.paused);
      if (existing?.generationId === request.generationId && existing?.paused === paused) {
        this.lastSyncAt = this.now();
        this.lastError = undefined;
        return;
      }
      await ref.set({
        goatId: request.goatId,
        nextWakeAt: paused ? null : request.nextWakeAt,
        nextTrackerCheckAt: paused ? null : request.nextTrackerCheckAt,
        timeframe: request.timeframe,
        generationId: request.generationId,
        paused,
        leaseUntilMs: typeof existing?.leaseUntilMs === 'number' && existing.leaseUntilMs > this.now()
          ? existing.leaseUntilMs
          : 0,
        updatedAt: new Date(this.now()).toISOString(),
      });
      this.lastSyncAt = this.now();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async cancel(goatId: string): Promise<void> {
    await this.schedules.doc(goatId).delete();
    this.processed.delete(goatId);
  }

  decide(goatId: string, event: FiredWake): { allowed: true } | { allowed: false; reason: string } {
    const previous = this.processed.get(goatId);
    if (previous?.eventId === event.eventId) return { allowed: false, reason: 'duplicate event' };
    this.processed.set(goatId, { eventId: event.eventId, at: event.firedAt });
    if (this.processed.size > 5000) {
      const cutoff = this.now() - 24 * 60 * 60_000;
      for (const [id, record] of this.processed) if (record.at < cutoff) this.processed.delete(id);
    }
    return { allowed: true };
  }

  async claimDue(nowMs = this.now(), limit = 40): Promise<FiredWake[]> {
    const dueIso = new Date(nowMs).toISOString();
    const snapshot = await this.schedules.where('nextWakeAt', '<=', dueIso).limit(Math.max(limit * 5, limit)).get();
    const claimed: FiredWake[] = [];
    for (const doc of snapshot.docs) {
      if (claimed.length >= limit) break;
      const event = await this.db.runTransaction(async transaction => {
        const fresh = await transaction.get(doc.ref) as unknown as DocumentSnapshot;
        if (!fresh.exists) return null;
        const row = fresh.data()!;
        if (row.paused || typeof row.nextWakeAt !== 'string' || row.nextWakeAt > dueIso) return null;
        if (typeof row.leaseUntilMs === 'number' && row.leaseUntilMs > nowMs) return null;
        const scheduledAt = row.nextWakeAt as string;
        const generationId = String(row.generationId ?? '');
        transaction.update(doc.ref, {
          leaseUntilMs: nowMs + 5 * 60_000,
          claimedAt: new Date(nowMs).toISOString(),
        });
        return {
          goatId: String(row.goatId ?? doc.id),
          eventId: `${doc.id}:${generationId}:${scheduledAt}`,
          generationId,
          reason: 'Firebase scheduled market review',
          firedAt: Date.parse(scheduledAt) || nowMs,
        } satisfies FiredWake;
      });
      if (event) claimed.push(event);
    }
    return claimed;
  }

  async claimDueTrackerChecks(nowMs = this.now(), limit = 40): Promise<FiredWake[]> {
    const dueIso = new Date(nowMs).toISOString();
    const snapshot = await this.schedules.where('nextTrackerCheckAt', '<=', dueIso).limit(Math.max(limit * 5, limit)).get();
    const claimed: FiredWake[] = [];
    for (const doc of snapshot.docs) {
      if (claimed.length >= limit) break;
      const event = await this.db.runTransaction(async transaction => {
        const fresh = await transaction.get(doc.ref) as unknown as DocumentSnapshot;
        if (!fresh.exists) return null;
        const row = fresh.data()!;
        if (row.paused || typeof row.nextTrackerCheckAt !== 'string' || row.nextTrackerCheckAt > dueIso) return null;
        if (typeof row.leaseUntilMs === 'number' && row.leaseUntilMs > nowMs) return null;
        const scheduledAt = row.nextTrackerCheckAt as string;
        const generationId = String(row.generationId ?? '');
        transaction.update(doc.ref, {
          leaseUntilMs: nowMs + 5 * 60_000,
          claimedAt: new Date(nowMs).toISOString(),
        });
        return {
          goatId: String(row.goatId ?? doc.id),
          eventId: `${doc.id}:tracker:${generationId}:${scheduledAt}`,
          generationId,
          reason: 'Firebase scheduled tracker check',
          firedAt: Date.parse(scheduledAt) || nowMs,
        } satisfies FiredWake;
      });
      if (event) claimed.push(event);
    }
    return claimed;
  }

  async completeTrackerCheck(goatId: string, generationId: string, nextTrackerCheckAt: string | null): Promise<void> {
    const ref = this.schedules.doc(goatId);
    await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref) as unknown as DocumentSnapshot;
      if (!snapshot.exists || snapshot.data()?.generationId !== generationId) return;
      transaction.update(ref, {
        nextTrackerCheckAt,
        leaseUntilMs: 0,
        updatedAt: new Date(this.now()).toISOString(),
      });
    });
  }

  async complete(goatId: string, generationId: string, nextWakeAt: string | null, nextTrackerCheckAt: string | null): Promise<void> {
    const ref = this.schedules.doc(goatId);
    await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref) as unknown as DocumentSnapshot;
      if (!snapshot.exists || snapshot.data()?.generationId !== generationId) return;
      transaction.update(ref, {
        nextWakeAt,
        nextTrackerCheckAt,
        leaseUntilMs: 0,
        updatedAt: new Date(this.now()).toISOString(),
      });
    });
  }

  health(): SchedulerHealth {
    return {
      kind: 'firebase',
      lastSyncAt: this.lastSyncAt,
      consecutiveFailures: this.lastError ? 1 : 0,
      lastError: this.lastError,
    };
  }
}
