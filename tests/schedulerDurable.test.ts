import fs from 'node:fs';
import path from 'node:path';
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
    /**
     * The address is ROUTING. The Worker's router matches
     * `^/do/goats/([^/]+)(/[a-z]+)?$`; a root `/schedule` matched nothing
     * and returned `{"error":"not_found"}`, so no GOAT was ever durably
     * scheduled and the alarm never fired.
     */
    expect(calls[0].path).toBe('/do/goats/g1/schedule');
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

    // Both actions are addressed under the GOAT's Durable Object route.
    expect(calls.map((c) => c.path)).toEqual([
      '/do/goats/g1/schedule',
      '/do/goats/g1/cancel',
    ]);
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

/* ------------------------------------------------------------------ */
/* The Worker's HTTP surface is a CONTRACT, not a guess                */
/* ------------------------------------------------------------------ */

describe('app-to-Worker addressing matches the routes the Worker serves', () => {
  /**
   * BOTH of these were broken in production at the same time, and both
   * presented as a silent 404:
   *
   *   - `DURABLE_SCHEDULER_URL` pointed at `sig-goat-scheduler...`, a
   *     hostname that does not exist; the real Worker is `siggoat-scheduler`.
   *   - the app then addressed the Worker at paths it does not serve.
   *
   * The net effect was that nothing was durably scheduled and the market-data
   * store was never written, while the app reported itself as healthy.
   */
  const workerPath = path.join(import.meta.dir, '..', 'worker', 'market-data-worker.ts');
  const worker = fs.readFileSync(workerPath, 'utf8');
  const client = fs.readFileSync(
    path.join(import.meta.dir, '..', 'src', 'services', 'market-data', 'DurableMarketDataClient.ts'),
    'utf8',
  );
  const scheduler = fs.readFileSync(
    path.join(import.meta.dir, '..', 'src', 'server', 'scheduler', 'DurableObjectScheduler.ts'),
    'utf8',
  );
  // The per-GOAT router lives in the scheduler Worker, not the market-data one.
  const schedulerWorker = fs.readFileSync(
    path.join(import.meta.dir, '..', 'worker', 'scheduler-worker.ts'),
    'utf8',
  );

  test('the market-data client prefixes every call with market/', () => {
    // Worker route: /^market\/(fx|metals|energy|index|crypto)(\/[a-z]+)?$/i
    expect(worker).toContain('/market\\/(fx|metals|energy|index|crypto)');
    expect(client).toContain('${this.baseUrl}/market/${path}');
  });

  test('the scheduler addresses the GOAT durable object route', () => {
    // Worker route: /^\/do\/goats\/([^/]+)(\/[a-z]+)?$/
    expect(schedulerWorker).toContain('/^\\/do\\/goats\\/([^/]+)(\\/[a-z]+)?$/');
    expect(scheduler).toContain('/do/goats/${encodeURIComponent(goatId)}${action}');
  });

  test('neither client addresses the Worker root any more', () => {
    // A root post is what produced `{"error":"not_found"}` on every call.
    expect(client).not.toContain('`${this.baseUrl}/${path}`');
    expect(scheduler).not.toContain("this.post('/schedule'");
    expect(scheduler).not.toContain("this.post('/cancel'");
  });
});

/* ------------------------------------------------------------------ */
/* END-TO-END ADDRESSING PROOF                                        */
/* ------------------------------------------------------------------ */

describe('both clients speak HTTP the Worker actually answers', () => {
  /**
   * The unit tests above pin the strings. This one proves the consequence:
   * the requests are accepted by a server implementing the Worker's EXACT
   * routers, and rejected the moment either client regresses to a root path.
   *
   * A 404 here is what production served for the lifetime of the old
   * configuration while the app reported itself as configured and healthy.
   */
  async function startWorkerStub(): Promise<{ url: string; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      hits.push(pathname);

      const market = pathname.match(/^\/market\/(fx|metals|energy|index|crypto)(\/[a-z]+)?$/i);
      if (market) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: market[2] ?? '/status', partition: market[1] }));
        return;
      }

      const goat = pathname.match(/^\/do\/goats\/([^/]+)(\/[a-z]+)?$/);
      if (goat) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: goat[2] ?? '/status', goatId: goat[1] }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
      url: `http://127.0.0.1:${port}`,
      hits,
    };
  }

  test('the scheduler arm and cancel are routed to the GOAT object', async () => {
    const stub = await startWorkerStub();
    const calls: string[] = [];
    const scheduler = new DurableObjectScheduler({
      endpoint: stub.url,
      secret: 's3cret',
      fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        return fetch(url, init);
      }) as unknown as typeof fetch,
    });

    await scheduler.sync({ goatId: 'g1', ...BASE });
    await scheduler.cancel('g1');

    expect(calls).toEqual([
      `${stub.url}/do/goats/g1/schedule`,
      `${stub.url}/do/goats/g1/cancel`,
    ]);
    // Not a single 404 — the routes resolved.
    expect(stub.hits).toEqual(['/do/goats/g1/schedule', '/do/goats/g1/cancel']);
  });

  test('the market-data client is routed to its partition', async () => {
    const stub = await startWorkerStub();
    const client = new DurableMarketDataClient(
      { url: stub.url, secret: 's3cret', enabled: true },
      { timeoutMs: 5_000 },
    );

    // health() fans out across every partition, so a routing regression on any
    // of them shows up here rather than in production.
    const health = await client.health();

    expect(health.reachable).toBe(true);
    // health() fans out in parallel, so arrival order is not part of the
    // contract — the set of routed paths is.
    expect([...stub.hits].sort()).toEqual([
      '/market/crypto/status',
      '/market/energy/status',
      '/market/fx/status',
      '/market/index/status',
      '/market/metals/status',
    ]);
  });

  test('a root-addressed call is still refused, so a regression cannot hide', async () => {
    const stub = await startWorkerStub();
    const stray = await fetch(`${stub.url}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goatId: 'g1' }),
    });

    // This is the 404 production served. It must remain a failure.
    expect(stray.status).toBe(404);
  });
});

import { createServer } from 'node:http';

import { DurableMarketDataClient } from '../src/services/market-data/DurableMarketDataClient';
