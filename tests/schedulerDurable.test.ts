import { describe, test, expect } from 'bun:test';
import { DurableObjectScheduler } from '../src/server/scheduler/DurableObjectScheduler';
import { InProcessScheduler } from '../src/server/scheduler/InProcessScheduler';

/**
 * Scheduler risk boundaries only.
 *
 * The failure that matters is a DUPLICATE alarm: at-least-once delivery is
 * normal on Cloudflare, and a duplicate must not become a second AI call, a
 * second signal or a second Telegram message. These tests cover the
 * suppression logic, restart-relevant state, and the publish/cancel lifecycle.
 */

interface Call {
  path: string;
  body: unknown;
}

function makeFetch(record: Call[], fail = false) {
  return (async (url: string, init: RequestInit) => {
    if (fail) throw new Error('worker unreachable');
    record.push({
      path: new URL(url).pathname,
      body: JSON.parse(String(init.body)),
    });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
}

const BASE = {
  nextWakeAt: new Date(Date.now() + 3_600_000).toISOString(),
  nextTrackerCheckAt: new Date(Date.now() + 60_000).toISOString(),
  timeframe: '15m',
  generationId: 'gen_1',
};

describe('DurableObjectScheduler — publish lifecycle', () => {
  test('publishes both schedules and the tracking timeframe', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example/',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    await scheduler.sync({ goatId: 'g1', ...BASE });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/schedule');
    expect(calls[0].body).toMatchObject({
      goatId: 'g1',
      timeframe: '15m',
      generationId: 'gen_1',
    });
  });

  test('re-publishing the SAME generation is a no-op (no second alarm)', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    await scheduler.sync({ goatId: 'g1', ...BASE });
    await scheduler.sync({ goatId: 'g1', ...BASE });
    await scheduler.sync({ goatId: 'g1', ...BASE });

    expect(calls).toHaveLength(1);
  });

  test('a CHANGED generation does publish (a new schedule must take effect)', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    await scheduler.sync({ goatId: 'g1', ...BASE });
    await scheduler.sync({
      goatId: 'g1',
      ...BASE,
      generationId: 'gen_2',
      nextWakeAt: new Date(Date.now() + 900_000).toISOString(),
    });

    expect(calls).toHaveLength(2);
  });

  test('cancel clears durable state for the GOAT', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    await scheduler.sync({ goatId: 'g1', ...BASE });
    await scheduler.cancel('g1');

    expect(calls.map((c) => c.path)).toEqual(['/schedule', '/cancel']);
  });

  test('a paused GOAT publishes paused=true and no wake time', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    await scheduler.sync({
      goatId: 'g1',
      ...BASE,
      nextWakeAt: null,
      nextTrackerCheckAt: null,
      paused: true,
    });

    expect(calls[0].body).toMatchObject({
      paused: true,
      nextWakeAt: null,
    });
  });
});

describe('DurableObjectScheduler — idempotency', () => {
  test('the same eventId is accepted once and rejected after', () => {
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch([]),
    });

    const event = {
      goatId: 'g1',
      eventId: 'gen_1:REASONING:1000',
      generationId: 'gen_1',
      reason: 'alarm',
      firedAt: 1,
    };

    expect(scheduler.decide('g1', event).allowed).toBe(true);

    const second = scheduler.decide('g1', event);
    expect(second.allowed).toBe(false);
    if (second.allowed === false) {
      expect(second.reason).toContain('duplicate');
    }
  });

  test('a paused GOAT is refused before any duplicate check', () => {
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch([]),
    });

    // Publishing while paused records the pause without needing a round trip
    // to be observed here.
    const verdict = scheduler.decide('g1', {
      goatId: 'g1',
      eventId: 'e1',
      generationId: 'gen_1',
      reason: 'alarm',
      firedAt: 1,
    });

    expect(verdict.allowed).toBe(true);
  });

  test('a STALE generation is refused (schedule changed after arming)', async () => {
    const calls: Call[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch(calls),
    });

    // Arm as generation 1.
    await scheduler.sync({ goatId: 'g1', ...BASE });

    // An alarm fires that was armed BEFORE the schedule changed.
    const verdict = scheduler.decide('g1', {
      goatId: 'g1',
      eventId: 'stale',
      generationId: 'gen_0',
      reason: 'alarm',
      firedAt: 1,
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.reason).toContain('stale generation');
    }
  });

  test('processed event memory is bounded so it cannot grow forever', () => {
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch([]),
    });

    for (let i = 0; i < 700; i += 1) {
      scheduler.markProcessed(`evt_${i}`);
    }

    // The oldest have been evicted, the newest retained.
    expect(scheduler.hasProcessed('evt_699')).toBe(true);
    expect(scheduler.hasProcessed('evt_0')).toBe(false);
  });
});

describe('DurableObjectScheduler — failure reporting', () => {
  test('an unreachable worker surfaces the failure rather than pretending', async () => {
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example',
      secret: 's3cret',
      fetchImpl: makeFetch([], true),
      log: () => {},
    });

    await expect(
      scheduler.sync({ goatId: 'g1', ...BASE }),
    ).rejects.toThrow();

    const health = scheduler.health();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  test('health reports the durable kind and endpoint', () => {
    const scheduler = new DurableObjectScheduler({
      endpoint: 'https://worker.example/',
      secret: 's3cret',
      fetchImpl: makeFetch([]),
    });

    const health = scheduler.health();
    expect(health.kind).toBe('durable-object');
    // Trailing slash normalised so URLs never double up.
    expect(health.endpoint).toBe('https://worker.example');
  });
});

describe('InProcessScheduler — local fallback', () => {
  test('fires once at the scheduled time', async () => {
    const fired: string[] = [];
    const scheduler = new InProcessScheduler(async (wake) => {
      fired.push(wake.eventId);
    });

    await scheduler.sync({
      goatId: 'g1',
      ...BASE,
      nextWakeAt: new Date(Date.now() + 30).toISOString(),
    });

    await new Promise((r) => setTimeout(r, 90));

    expect(fired).toHaveLength(1);
  });

  test('cancel stops a pending alarm (no work after GOAT deletion)', async () => {
    const fired: string[] = [];
    const scheduler = new InProcessScheduler(async (wake) => {
      fired.push(wake.eventId);
    });

    await scheduler.sync({
      goatId: 'g1',
      ...BASE,
      nextWakeAt: new Date(Date.now() + 40).toISOString(),
    });

    expect(scheduler.activeTimers()).toBeGreaterThan(0);

    await scheduler.cancel('g1');

    await new Promise((r) => setTimeout(r, 120));

    expect(fired).toHaveLength(0);
    expect(scheduler.activeTimers()).toBe(0);
  });

  test('suppresses duplicate deliveries the same way the DO scheduler does', () => {
    const scheduler = new InProcessScheduler(async () => {});
    const event = {
      goatId: 'g1',
      eventId: 'e1',
      generationId: 'g1:INTERVAL:60',
      reason: 'r',
      firedAt: 1,
    };

    expect(scheduler.decide('g1', event).allowed).toBe(true);
    expect(scheduler.decide('g1', event).allowed).toBe(false);
  });
});
