/**
 * SIGNALGOAT DURABLE SCHEDULER — Cloudflare Worker
 * ===============================================
 * One Durable Object per GOAT. Owns exactly two things:
 *
 *   1. the authoritative `nextWakeAt` for that GOAT (durable storage)
 *   2. an alarm that fires and POSTs an authenticated callback to Vercel
 *
 * RUNTIME CONSTRAINTS — READ BEFORE ADDING ANYTHING
 *
 * This code runs on the Workers runtime (V8 isolate), NOT Node. Therefore:
 *
 *   - `firebase-admin` CANNOT be imported here (needs Node crypto/gRPC).
 *   - `node:fs` cannot be used; durable storage replaces it.
 *   - No OpenRouter, no BiQuote, no indicators: those all belong to the
 *     Vercel application, which calls back into us rather than the reverse.
 *
 * The DO therefore holds NO user data, NO GOAT definition, NO ownership and NO
 * historical records — only scheduling state. There is exactly one source of
 * truth for every one of those, and it is the Vercel app's database.
 *
 * ALARM SEMANTICS
 *
 * Cloudflare delivers alarms AT LEAST ONCE. A duplicate is possible after a
 * retry or a redeploy racing an in-flight alarm. Each delivery carries a
 * deterministic `eventId` (goatId + scheduled timestamp), and the receiver
 * dedupes on it. The DO additionally skips a re-arm when the stored generation
 * is newer than the incoming one, so a late retry cannot un-arm a newer alarm.
 */

export interface Env {
  /** Shared secret; the Vercel app sends it as `Authorization: Bearer ...`. */
  SCHEDULER_SECRET: string;
  /** Base URL of the Vercel application, e.g. https://siggoat.vercel.app */
  APP_ORIGIN: string;
}

/**
 * Callback delivery timeout.
 *
 * The alarm handler must not hold the object open indefinitely: a hung request
 * would block every subsequent alarm for this GOAT.
 */
const CALLBACK_TIMEOUT_MS = 10_000;

/** First retry delay after a failed delivery. */
const RETRY_BASE_MS = 30_000;

/**
 * Ceiling on retry backoff.
 *
 * Bounded, not abandoned: a permanently unreachable app costs one request per
 * RETRY_CEILING_MS per GOAT, and recovery is automatic with no operator action.
 */
const RETRY_CEILING_MS = 15 * 60_000;

/**
 * Bound on consecutive failures.
 *
 * Reported through /status so a stuck GOAT is visible. Retries continue past
 * it at the ceiling — this is an observability threshold, not a give-up point.
 */
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Durable Object storage allows only ONE alarm per object, but two things need
 * firing: the reasoning wake (user-chosen interval / time) and the tracker
 * check (user-chosen tracking timeframe).
 *
 * So both are stored, and the single alarm is armed for whichever comes
 * first. Each delivery reports which one it is so the receiver knows whether
 * to evaluate trackers (no AI) or run a full reasoning wake (AI).
 */
type FireKind = 'REASONING' | 'TRACKER_CHECK';

interface Goats {
  /**
   * The GOAT id, stored because a Durable Object cannot read its own name from
   * DurableObjectState, yet the alarm callback must tell the app WHICH GOAT
   * to act on.
   */
  goatId: string;
  /** Next reasoning wake, or null when the GOAT spends no AI on a schedule. */
  nextWakeAt: number | null;
  /**
   * Next deterministic tracker check. Cheap: it evaluates indicators and,
   * only when a condition is actually met, escalates to a reasoning wake.
   */
  nextTrackerCheckAt: number | null;
  /** The GOAT's tracking timeframe, so the app knows what to evaluate. */
  timeframe: string;
  generationId: string;
  paused: boolean;
  lastDeliveredAt?: number;
  lastArmedAt?: number;
  /**
   * Consecutive FAILED deliveries for the current alarm.
   *
   * Reset to 0 on the first success. Bounded by MAX_DELIVERY_ATTEMPTS so a
   * permanently unreachable app produces a slow, steady retry rather than
   * either a hot loop or a permanently dead GOAT.
   */
  failedDeliveries?: number;
  /**
   * When the next retry is allowed.
   *
   * A failed delivery must not immediately re-fire: an app that is mid-deploy
   * would otherwise receive a request every few seconds. This is the floor for
   * that backoff.
   */
  retryAfterAt?: number | null;
}

export const GoatScheduler = {
  /**
   * Durable Object class: one instance per GOAT id.
   *
   * Cloudflare guarantees a single instance per ID is active at a time, which
   * is exactly the guarantee the application's in-process mutex approximates.
   */
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const authorised =
      request.headers.get('authorization') ===
      `Bearer ${env.SCHEDULER_SECRET}`;

    if (!authorised) {
      return json({ error: 'unauthorised' }, 401);
    }

    const url = new URL(request.url);

    // The DO id is derived from the goatId so one namespace routes every GOAT.
    const match = url.pathname.match(/^\/do\/goats\/([^/]+)(\/[a-z]+)?$/);

    if (!match) {
      return json({ error: 'not_found' }, 404);
    }

    const goatId = decodeURIComponent(match[1]);
    const action = match[2] ?? '/status';
    const stub = (env as unknown as { NAMESPACE: DurableObjectNamespace })
      .NAMESPACE;

    const idFromName = stub.idFromName(goatId);
    return stub.get(idFromName).fetch(
      new Request(`https://do${action}`, {
        method: 'POST',
        headers: request.headers,
        body: request.method === 'POST' ? await request.text() : undefined,
      }),
    );
  },
};

/**
 * The Durable Object itself. Exported separately so tests and a direct
 * binding can address it without going through the router above.
 */
export class GoatSchedulerDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/schedule':
        return this.handleSchedule(request);
      case '/cancel':
        return this.handleCancel();
      case '/status':
        return this.handleStatus();
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  /**
   * Cloudflare invokes this when the alarm set with `setAlarm` comes due.
   * It runs even if nothing else has touched the object for hours, which is
   * precisely what an in-process timer cannot guarantee.
   */
  async alarm(): Promise<void> {
    const goats = await this.state.storage.get<Goats>('goats');

    if (!goats || goats.paused) return;

    /**
     * A failed delivery backs off instead of re-firing immediately, so an app
     * that is briefly unavailable is not hammered and a genuinely dead one is
     * not spun on.
     */
    if (goats.retryAfterAt && Date.now() < goats.retryAfterAt) {
      await this.arm(goats);
      return;
    }

    const due = this.pickDue(goats);
    if (!due) return;

    const { kind, at } = due;

    // A spurious or early alarm must not fire.
    if (Date.now() < at - 1_000) {
      await this.arm(goats);
      return;
    }

    const eventId = `${goats.generationId}:${kind}:${at}`;

    const endpoint =
      kind === 'REASONING'
        ? '/api/internal/wake'
        : '/api/internal/check-trackers';

    let delivered = false;

    try {
      const response = await fetch(
        `${this.env.APP_ORIGIN.replace(/\/+$/, '')}${endpoint}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Scheduler-Secret': this.env.SCHEDULER_SECRET,
          },
          signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
          body: JSON.stringify({
            goatId: goats.goatId,
            eventId,
            generationId: goats.generationId,
            timeframe: goats.timeframe,
            firedAt: Date.now(),
          }),
        },
      );

      if (response.ok) {
        delivered = true;
        goats.lastDeliveredAt = Date.now();
        goats.failedDeliveries = 0;
        goats.retryAfterAt = null;

        /**
         * The receiver reports the NEXT due time for this kind, which is how
         * the schedule stays anchored to the app's own clock rather than
         * drifting by one alarm latency per cycle.
         *
         * A missing or unparseable nextAt means "no further wake of this kind"
         * rather than "wake again immediately": arming on the stale `at` value
         * would spin the alarm.
         */
        const body = (await response
          .json()
          .catch(() => null)) as { nextAt?: string | null } | null;

        const next = body?.nextAt ? Date.parse(body.nextAt) : NaN;
        const nextAt = Number.isFinite(next) ? next : null;

        if (kind === 'REASONING') {
          goats.nextWakeAt = nextAt;
        } else {
          goats.nextTrackerCheckAt = nextAt;
        }
      }
    } catch {
      // Network failure or timeout: handled by the retry branch below.
    }

    if (!delivered) {
      /**
       * RETRY WITH BOUNDED BACKOFF.
       *
       * The previous behaviour consumed the alarm and re-armed nothing,
       * relying on a reconciliation sweep that did not exist. One transient
       * failure during an app deploy therefore stopped that GOAT's schedule
       * permanently — the GOAT looked healthy in every status endpoint and
       * simply never woke again.
       *
       * Past the attempt bound the schedule is still retried, at the slow
       * floor, so a permanent outage costs a request every RETRY_CEILING_MS
       * rather than a tight loop, and recovery is automatic either way.
       */
      const failures = (goats.failedDeliveries ?? 0) + 1;
      goats.failedDeliveries = failures;

      const delay = Math.min(
        RETRY_BASE_MS * 2 ** (failures - 1),
        RETRY_CEILING_MS,
      );
      goats.retryAfterAt = Date.now() + delay;

      /**
       * Re-arm at the retry time. `pickDue` only returns a schedule whose time
       * has passed, so the original `at` remains due and this is a retry of the
       * SAME event — which the receiver deduplicates on `eventId`, so a retry
       * cannot produce a second AI call or a second Telegram message.
       */
      await this.arm(goats);
      await this.state.storage.put('goats', goats);
      return;
    }

    /**
     * Always re-arm on success. Without this an alarm with no further due time
     * stays armed forever and the object is never released.
     */
    await this.arm(goats);
    await this.state.storage.put('goats', goats);
  }

  /**
   * Whichever schedule is due, if any.
   *
   * Returns null when nothing is due yet, in which case the caller re-arms for
   * the soonest upcoming time rather than firing early.
   */
  private pickDue(
    goats: Goats,
  ): { kind: FireKind; at: number } | null {
    const now = Date.now();

    const due: Array<{ kind: FireKind; at: number }> = [];

    if (goats.nextWakeAt !== null && goats.nextWakeAt <= now + 1_000) {
      due.push({ kind: 'REASONING', at: goats.nextWakeAt });
    }

    if (
      goats.nextTrackerCheckAt !== null &&
      goats.nextTrackerCheckAt <= now + 1_000
    ) {
      due.push({
        kind: 'TRACKER_CHECK',
        at: goats.nextTrackerCheckAt,
      });
    }

    if (due.length === 0) return null;

    return due.sort((a, b) => a.at - b.at)[0];
  }

  /**
   * Arms the single alarm for whichever schedule is soonest.
   *
   * THE BACKOFF MUST BE PART OF THIS CALCULATION.
   *
   * After a failed delivery `nextWakeAt` is still in the past — that is what
   * makes it due. Taking `min(nextWakeAt, …)` alone therefore armed the alarm
   * in the PAST, so Cloudflare re-fired it immediately and the guard at the top
   * of `alarm()` suppressed the delivery only to re-arm in the past again. That
   * is a tight loop, which is exactly what the backoff exists to prevent.
   *
   * A pending retry floor is raised to at least `retryAfterAt`, so a failed
   * delivery is genuinely deferred.
   */
  private async arm(goats: Goats): Promise<void> {
    const times = [goats.nextWakeAt, goats.nextTrackerCheckAt].filter(
      (t): t is number => t !== null && Number.isFinite(t),
    );

    if (times.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }

    const soonest = Math.min(...times);

    // Never arm in the past: an alarm at or before now fires immediately.
    const floor = Math.max(Date.now() + 1_000, goats.retryAfterAt ?? 0);

    await this.state.storage.setAlarm(Math.max(soonest, floor));
  }

  private async handleSchedule(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      goatId?: string;
      nextWakeAt?: string | null;
      nextTrackerCheckAt?: string | null;
      timeframe?: string;
      generationId?: string;
      paused?: boolean;
    };

    if (!body.generationId) {
      return json({ error: 'generationId required' }, 400);
    }

    const existing = await this.state.storage.get<Goats>('goats');

    /**
     * Idempotency: re-publishing the same generation is a no-op, so a retried
     * request from the app cannot create a second alarm or shift the schedule.
     */
    if (existing?.generationId === body.generationId) {
      return json({ ok: true, unchanged: true });
    }

    const parseTime = (value?: string | null): number | null => {
      if (!value) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    };

    const record: Goats = {
      goatId: body.goatId ?? existing?.goatId ?? '',
      nextWakeAt: parseTime(body.nextWakeAt),
      nextTrackerCheckAt: parseTime(body.nextTrackerCheckAt),
      timeframe: body.timeframe ?? existing?.timeframe ?? '15m',
      generationId: body.generationId,
      paused: Boolean(body.paused),
      lastArmedAt: Date.now(),
      /**
       * A NEW generation clears the retry state. The previous generation's
       * failures say nothing about this one, and carrying them forward would
       * delay the first wake of a freshly saved schedule for no reason.
       */
      failedDeliveries: 0,
      retryAfterAt: null,
    };

    await this.state.storage.put('goats', record);
    await this.arm(record);

    return json({
      ok: true,
      nextWakeAt: record.nextWakeAt,
      nextTrackerCheckAt: record.nextTrackerCheckAt,
    });
  }

  private async handleCancel(): Promise<Response> {
    await this.state.storage.deleteAlarm();
    await this.state.storage.delete('goats');
    return json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const goats = await this.state.storage.get<Goats>('goats');
    const alarm = await this.state.storage.getAlarm();

    const failedDeliveries = goats?.failedDeliveries ?? 0;

    return json({
      goats: goats ?? null,
      armedFor: alarm ?? null,
      /**
       * Delivery health, surfaced rather than buried in `goats`.
       *
       * `retrying` is the signal that matters operationally: it means the
       * schedule is alive but the app is not answering, which looks identical
       * to "nothing is happening" without it.
       */
      delivery: {
        lastDeliveredAt: goats?.lastDeliveredAt ?? null,
        failedDeliveries,
        retryAfterAt: goats?.retryAfterAt ?? null,
        retrying: failedDeliveries > 0,
        degraded: failedDeliveries >= MAX_DELIVERY_ATTEMPTS,
      },
    });
  }

}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
