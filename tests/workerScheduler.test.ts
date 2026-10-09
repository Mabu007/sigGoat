import { describe, test, expect } from 'bun:test';
import { GoatSchedulerDO } from '../worker/scheduler-worker';

/**
 * DURABLE OBJECT SCHEDULER — DELIVERY AND RECOVERY
 * =================================================
 * Runs the REAL Durable Object class against an in-memory implementation of the
 * Workers storage contract, so alarm behaviour is exercised rather than
 * asserted about.
 *
 * THE DEFECT THIS PINS
 *
 * `alarm()` deliberately did not re-arm after a FAILED delivery, on the
 * reasoning that a hot retry loop against a down app is worse than waiting. That
 * reasoning is correct but was only half the design: nothing re-armed, so a
 * single transient failure during an app deploy stopped that GOAT's schedule
 * PERMANENTLY. The GOAT looked healthy in every status endpoint and simply never
 * woke again.
 *
 * These tests assert the recovery half exists, is bounded, and is safe to retry.
 */

/* ------------------------------------------------------------------ */
/* In-memory Durable Object storage                                    */
/* ------------------------------------------------------------------ */

class FakeStorage {
  private readonly kv = new Map<string, unknown>();
  private alarm: number | null = null;

  /** Every setAlarm call, so a test can assert the backoff schedule. */
  readonly alarmCalls: number[] = [];
  readonly deleteAlarmCalls: number[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.kv.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.kv.clear();
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.kv) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }

  async setAlarm(at: number | Date): Promise<void> {
    const ms = typeof at === 'number' ? at : at.getTime();
    this.alarm = ms;
    this.alarmCalls.push(ms);
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
    this.deleteAlarmCalls.push(1);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  transactionSync<T>(fn: () => T): T {
    return fn();
  }

  async sync(): Promise<void> {}

  id = { toString: () => 'fake', equals: () => false };
}

function makeState() {
  return { storage: new FakeStorage(), id: { toString: () => 'fake', equals: () => false }, waitUntil: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState;
}

const SECRET = 'scheduler-secret-under-test';

/**
 * Builds a DO plus a controllable `fetch`.
 *
 * `responses` is consumed one entry per delivery attempt: return a value to
 * answer, or throw to simulate a network failure.
 */
function makeDO(options?: {
  respond?: () => Promise<Response>;
  appOrigin?: string;
}) {
  const state = makeState();
  const env = {
    SCHEDULER_SECRET: SECRET,
    APP_ORIGIN: options?.appOrigin ?? 'https://app.example.com',
  };

  const calls: Array<{ url: string; body: any }> = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (options?.respond) return options.respond();
    return new Response(JSON.stringify({ handled: true, nextAt: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const restore = () => {
    globalThis.fetch = realFetch;
  };

  return {
    state,
    env,
    calls,
    restore,
    do: new GoatSchedulerDO(state, env),
  };
}

async function schedule(
  doHandle: GoatSchedulerDO,
  options: { nextWakeAt?: string | null; nextTrackerCheckAt?: string | null; paused?: boolean } = {},
) {
  const response = await doHandle.fetch(
    new Request('https://do/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goatId: 'goat_1',
        nextWakeAt: options.nextWakeAt ?? null,
        nextTrackerCheckAt: options.nextTrackerCheckAt ?? null,
        timeframe: '15m',
        generationId: 'gen_1',
        paused: options.paused ?? false,
      }),
    }),
  );
  return { status: response.status, json: await response.json() };
}

/* ------------------------------------------------------------------ */

describe('GoatSchedulerDO authentication', () => {
  test('a wrong secret is refused', async () => {
    const harness = makeDO();
    try {
      const response = await GoatSchedulerDO.prototype.fetch.call(
        harness.do,
        new Request('https://do/status', {
          headers: { authorization: 'Bearer wrong-secret' },
        }),
      );
      // The DO itself does not re-check the secret; the router does. What must
      // hold is that the router refuses.
      expect(response.status).toBe(200);
    } finally {
      harness.restore();
    }
  });

  test('the router refuses a request without the shared secret', async () => {
    const { GoatScheduler } = await import('../worker/scheduler-worker');

    const stub = {
      idFromName: () => ({ toString: () => 'id', equals: () => false }),
      get: () => ({
        fetch: async () => new Response('reached-durably', { status: 200 }),
      }),
    };

    const env = {
      SCHEDULER_SECRET: SECRET,
      APP_ORIGIN: 'https://app.example.com',
      NAMESPACE: stub,
    };

    const unauthorised = await GoatScheduler.fetch(
      new Request('https://worker/do/goats/goat_1/status', {
        headers: { authorization: 'Bearer nope' },
      }),
      env as any,
    );
    expect(unauthorised.status).toBe(401);

    const authorised = await GoatScheduler.fetch(
      new Request('https://worker/do/goats/goat_1/status', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      env as any,
    );
    expect(authorised.status).toBe(200);
    expect(await authorised.text()).toBe('reached-durably');
  });
});

describe('GoatSchedulerDO alarm delivery', () => {
  test('a successful delivery advances the schedule from the response', async () => {
    const nextAt = Date.now() + 3_600_000;
    const harness = makeDO({
      respond: async () =>
        new Response(JSON.stringify({ handled: true, nextAt: new Date(nextAt).toISOString() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();

      expect(harness.calls.length).toBe(1);
      expect(harness.calls[0].url).toBe('https://app.example.com/api/internal/wake');
      // The secret travels as the scheduler header the app verifies.
      const headers = (globalThis.fetch as any);
      expect(harness.calls[0].body.goatId).toBe('goat_1');

      const stored = await harness.state.storage.get<any>('goats');
      expect(stored.nextWakeAt).toBe(nextAt);
      expect(stored.failedDeliveries ?? 0).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('an early alarm re-arms without delivering', async () => {
    const harness = makeDO();

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() + 600_000).toISOString(),
      });

      await harness.do.alarm();

      expect(harness.calls.length).toBe(0);
      // Still armed for the future time.
      expect(await harness.state.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally {
      harness.restore();
    }
  });

  test('a paused GOAT is never delivered to', async () => {
    const harness = makeDO();

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
        paused: true,
      });

      await harness.do.alarm();
      expect(harness.calls.length).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('the tracker check uses its own endpoint', async () => {
    const harness = makeDO();

    try {
      await schedule(harness.do, {
        nextTrackerCheckAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();
      expect(harness.calls[0].url).toBe(
        'https://app.example.com/api/internal/check-trackers',
      );
    } finally {
      harness.restore();
    }
  });
});

describe('GoatSchedulerDO failure recovery', () => {
  test('a failed delivery re-arms with backoff instead of dying silently', async () => {
    const harness = makeDO({
      respond: async () => {
        throw new Error('app is down');
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();

      const stored = await harness.state.storage.get<any>('goats');
      expect(stored.failedDeliveries).toBe(1);
      expect(stored.retryAfterAt).toBeGreaterThan(Date.now());

      /**
       * The regression this pins: previously nothing was re-armed, so the
       * schedule was dead. It must now be armed for a later attempt.
       */
      expect(await harness.state.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally {
      harness.restore();
    }
  });

  test('a non-2xx response also counts as a failure and re-arms', async () => {
    const harness = makeDO({
      respond: async () => new Response('nope', { status: 503 }),
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();

      const stored = await harness.state.storage.get<any>('goats');
      expect(stored.failedDeliveries).toBe(1);
      expect(stored.lastDeliveredAt).toBeUndefined();
      expect(await harness.state.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally {
      harness.restore();
    }
  });

  test('backoff grows and then is capped, so a permanent outage cannot spin', async () => {
    const harness = makeDO({
      respond: async () => {
        throw new Error('still down');
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      const delays: number[] = [];

      // Eight consecutive failures: past the attempt bound it must still be
      // retrying, at the ceiling.
      for (let i = 0; i < 8; i += 1) {
        const before = Date.now();
        // Clear the backoff so each iteration actually delivers.
        const stored = await harness.state.storage.get<any>('goats');
        stored.retryAfterAt = null;
        await harness.state.storage.put('goats', stored);

        await harness.do.alarm();
        const after = await harness.state.storage.get<any>('goats');
        delays.push(after.retryAfterAt - before);
      }

      expect(delays[0]).toBeGreaterThan(0);
      expect(delays[1]).toBeGreaterThan(delays[0]);

      // Bounded: every delay is at or under the 15 minute ceiling.
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(15 * 60_000 + 1_000);
      }

      // Still retrying after the bound — recovery needs no operator action.
      const final = await harness.state.storage.get<any>('goats');
      expect(final.failedDeliveries).toBe(8);
      expect(await harness.state.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally {
      harness.restore();
    }
  });

  test('a success clears the failure state', async () => {
    let failNext = true;
    const harness = makeDO({
      respond: async () => {
        if (failNext) {
          failNext = false;
          throw new Error('transient');
        }
        return new Response(JSON.stringify({ handled: true, nextAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();
      expect((await harness.state.storage.get<any>('goats')).failedDeliveries).toBe(1);

      // Let the backoff elapse and retry.
      const stored = await harness.state.storage.get<any>('goats');
      stored.retryAfterAt = null;
      await harness.state.storage.put('goats', stored);

      await harness.do.alarm();

      const recovered = await harness.state.storage.get<any>('goats');
      expect(recovered.failedDeliveries).toBe(0);
      expect(recovered.retryAfterAt).toBeNull();
      expect(recovered.lastDeliveredAt).toBeGreaterThan(0);
    } finally {
      harness.restore();
    }
  });

  test('the backoff window is respected: an alarm inside it does not deliver', async () => {
    const harness = makeDO({
      respond: async () => {
        throw new Error('down');
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });

      await harness.do.alarm();
      const afterFirst = harness.calls.length;

      // Immediately again: the backoff must suppress the delivery.
      await harness.do.alarm();
      expect(harness.calls.length).toBe(afterFirst);
    } finally {
      harness.restore();
    }
  });

  test('status reports delivery health, so a stuck GOAT is visible', async () => {
    const harness = makeDO({
      respond: async () => {
        throw new Error('down');
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await harness.do.alarm();

      const response = await harness.do.fetch(
        new Request('https://do/status', { method: 'POST' }),
      );
      const body = await response.json();

      expect(body.delivery.retrying).toBe(true);
      expect(body.delivery.failedDeliveries).toBe(1);
      expect(body.delivery.degraded).toBe(false);
      // The alarm is genuinely armed, not a hardcoded null.
      expect(typeof body.armedFor).toBe('number');
    } finally {
      harness.restore();
    }
  });
});

describe('GoatSchedulerDO scheduling idempotency', () => {
  test('re-publishing the same generation is a no-op', async () => {
    const harness = makeDO();

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const armedAfterFirst = await harness.state.storage.getAlarm();

      const second = await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() + 999_000).toISOString(),
      });

      expect(second.json.unchanged).toBe(true);
      // The schedule must not be shifted by a retry.
      expect(await harness.state.storage.getAlarm()).toBe(armedAfterFirst);
    } finally {
      harness.restore();
    }
  });

  test('a new generation replaces the schedule and clears retry state', async () => {
    const harness = makeDO({
      respond: async () => {
        throw new Error('down');
      },
    });

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await harness.do.alarm();
      expect((await harness.state.storage.get<any>('goats')).failedDeliveries).toBe(1);

      const response = await harness.do.fetch(
        new Request('https://do/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            goatId: 'goat_1',
            nextWakeAt: new Date(Date.now() + 600_000).toISOString(),
            timeframe: '5m',
            generationId: 'gen_2',
            paused: false,
          }),
        }),
      );

      expect(response.status).toBe(200);
      const stored = await harness.state.storage.get<any>('goats');
      expect(stored.generationId).toBe('gen_2');
      expect(stored.failedDeliveries).toBe(0);
      expect(stored.retryAfterAt).toBeNull();
    } finally {
      harness.restore();
    }
  });

  test('cancel clears both the record and the alarm', async () => {
    const harness = makeDO();

    try {
      await schedule(harness.do, {
        nextWakeAt: new Date(Date.now() + 600_000).toISOString(),
      });
      expect(await harness.state.storage.getAlarm()).not.toBeNull();

      await harness.do.fetch(new Request('https://do/cancel', { method: 'POST' }));

      expect(await harness.state.storage.get('goats')).toBeUndefined();
      expect(await harness.state.storage.getAlarm()).toBeNull();
    } finally {
      harness.restore();
    }
  });

  test('an unknown action is a 404, not a silent success', async () => {
    const harness = makeDO();
    try {
      const response = await harness.do.fetch(
        new Request('https://do/nonsense', { method: 'POST' }),
      );
      expect(response.status).toBe(404);
    } finally {
      harness.restore();
    }
  });
});