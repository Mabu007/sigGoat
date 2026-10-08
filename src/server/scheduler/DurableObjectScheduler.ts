/**
 * DURABLE OBJECT WAKE SCHEDULER (client side)
 * ===========================================
 * Runs on the Vercel application. Talks to a small Cloudflare Worker that owns
 * one Durable Object per GOAT.
 *
 * The Worker is deliberately dumb: it stores `nextWakeAt`, arms an alarm, and
 * POSTs a callback when the alarm fires. No market data, no AI, no
 * persistence — none of that could run on the Workers runtime anyway, since
 * `firebase-admin` requires Node.
 *
 * FAILURE POSTURE
 *
 * If the Worker is unreachable, `sync()` throws and the caller logs it. The
 * application deliberately does NOT silently fall back to in-process timers in
 * production, because a half-scheduled GOAT is worse than an obviously
 * unscheduled one. `health()` exposes the state so /api/settings/status can
 * report it truthfully.
 */

import type {
  FiredWake,
  ScheduleRequest,
  SchedulerHealth,
  WakeScheduler,
} from './types';

export interface DurableObjectSchedulerOptions {
  /** Base URL of the Cloudflare Worker, e.g. https://sg-scheduler.workers.dev */
  endpoint: string;
  /** Shared secret sent as a bearer token; must match the Worker's. */
  secret: string;
  /** Per-request timeout. Kept short: this is on the GOAT create path. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class DurableObjectScheduler implements WakeScheduler {
  readonly kind = 'durable-object' as const;

  private readonly endpoint: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private lastSyncAt?: number;
  private consecutiveFailures = 0;
  private lastError?: string;

  /**
   * Idempotency memory for at-least-once alarm delivery.
   *
   * The DO also dedupes, but delivery can be duplicated between the DO and
   * this process (retry after a network error, redeploy mid-request), so the
   * application keeps its own bounded set of processed event ids.
   */
  private readonly processedEvents = new Set<string>();
  private readonly processedOrder: string[] = [];
  private static readonly MAX_PROCESSED_EVENTS = 500;

  /** Per-GOAT schedule generation, so a stale alarm is rejected. */
  private readonly generations = new Map<string, string>();
  private readonly paused = new Set<string>();

  constructor(options: DurableObjectSchedulerOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.log ??
      ((message, error) => {
        if (error) console.warn(message, error);
        else console.warn(message);
      });
  }

  async sync(request: ScheduleRequest): Promise<void> {
    const current = this.generations.get(request.goatId);

    // Never move a schedule backwards: a late retry of an old generation must
    // not un-arm a newer alarm.
    if (current && current === request.generationId && request.paused !== true) {
      return;
    }

    if (request.paused) {
      this.paused.add(request.goatId);
    } else {
      this.paused.delete(request.goatId);
    }

    this.generations.set(request.goatId, request.generationId);

    await this.post('/schedule', {
      goatId: request.goatId,
      nextWakeAt: request.nextWakeAt,
      nextTrackerCheckAt: request.nextTrackerCheckAt,
      timeframe: request.timeframe,
      generationId: request.generationId,
      paused: request.paused ?? false,
    });
  }

  async cancel(goatId: string): Promise<void> {
    this.generations.delete(goatId);
    this.paused.delete(goatId);
    await this.post('/cancel', { goatId });
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
      // The schedule changed after this alarm was armed.
      return {
        allowed: false,
        reason: `stale generation ${event.generationId} (current ${expected})`,
      };
    }

    if (this.processedEvents.has(event.eventId)) {
      return { allowed: false, reason: 'duplicate event' };
    }

    this.remember(event.eventId);

    return { allowed: true };
  }

  /** Records an event id as handled by a non-scheduler path (e.g. a manual wake). */
  markProcessed(eventId: string): void {
    this.remember(eventId);
  }

  hasProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  health(): SchedulerHealth {
    return {
      kind: this.kind,
      endpoint: this.endpoint,
      lastSyncAt: this.lastSyncAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  private remember(eventId: string): void {
    this.processedEvents.add(eventId);
    this.processedOrder.push(eventId);

    while (
      this.processedOrder.length >
      DurableObjectScheduler.MAX_PROCESSED_EVENTS
    ) {
      const oldest = this.processedOrder.shift();
      if (oldest) this.processedEvents.delete(oldest);
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await this.fetchImpl(
        `${this.endpoint}${path}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.secret}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        throw new Error(
          `scheduler worker returned HTTP ${response.status}`,
        );
      }

      this.lastSyncAt = this.now();
      this.consecutiveFailures = 0;
      this.lastError = undefined;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastError =
        err instanceof Error ? err.message : 'unknown error';
      this.log(
        `[scheduler] ${path} failed: ${this.lastError}`,
        err,
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reads scheduler configuration from the environment.
 *
 * Returns null when the Cloudflare Worker is not configured, which is the
 * signal to use the in-process scheduler instead. That is correct for local
 * development and for a single-process deploy; it is NOT correct for
 * production, which is why /api/settings/status reports the active kind.
 */
export function durableObjectSchedulerFromEnv(): DurableObjectScheduler | null {
  const endpoint =
    process.env.DURABLE_SCHEDULER_URL?.trim();
  const secret =
    process.env.DURABLE_SCHEDULER_SECRET?.trim();

  if (!endpoint || !secret) {
    return null;
  }

  return new DurableObjectScheduler({ endpoint, secret });
}
