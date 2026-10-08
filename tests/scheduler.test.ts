import { describe, test, expect, afterEach } from 'bun:test';
import {
  GoatDurableObject,
  computeBackoffDelay,
} from '../src/services/durable-object/GoatDurableObject';
import { durableObjectRegistry } from '../src/services/durable-object/DurableObjectRegistry';
import type { ReasoningGateway } from '../src/server/reasoningGateway';
import { PaperMarketDataProvider } from '../src/services/market-data/PaperMarketDataProvider';
import { InMemoryPersistence } from '../src/server/repositories';
import { SignalGoat, TradingSkill } from '../src/types';

function makeGoat(id: string): SignalGoat {
  return {
    id,
    userId: 'user_sched',
    name: `Goat ${id}`,
    goal: 'Scheduler test goat.',
    markets: ['EUR/USD'],
    skillIds: [],
    model: 'openai/gpt-4o-mini',
    status: 'WATCHING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const SKILLS: TradingSkill[] = [];

/** Gateway stub that counts evaluations and can be set to fail. */
function countingGateway(fail: boolean): ReasoningGateway & { calls: number; times: number[] } {
  const stub = {
    calls: 0,
    times: [] as number[],
    async evaluateGoat() {
      this.calls += 1;
      this.times.push(Date.now());
      if (fail) {
        throw new Error('simulated model outage');
      }
      return {
        investigation: { summary: 'ok' },
        thesis: {
          directionalBias: 'NEUTRAL' as const,
          summary: 'No edge.',
          confidence: 40,
          trackers: [],
        },
        proposal: { decision: 'NO_TRADE' as const, noTradeReason: 'Quiet market.' },
        evidence: [],
      };
    },
    async answerGoatQuestion() {
      return 'ok';
    },
    async hasKeyFor() {
      return false;
    },
    async listModels() {
      return { models: [], fetchedAt: 0 };
    },
    async testKeyFor() {
      return { ok: false, latencyMs: 0, error: 'not used here' };
    },
    invalidate() {},
  };
  return stub as ReturnType<typeof countingGateway>;
}

const actors: GoatDurableObject[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  while (actors.length) {
    actors.pop()?.destroy();
  }
});

describe('scheduler backoff policy (pure)', () => {
  test('failures 0 -> base interval', () => {
    expect(computeBackoffDelay(45_000, 1_800_000, 0)).toBe(45_000);
  });

  test('delay doubles per consecutive failure', () => {
    expect(computeBackoffDelay(1_000, 100_000, 1)).toBe(2_000);
    expect(computeBackoffDelay(1_000, 100_000, 2)).toBe(4_000);
    expect(computeBackoffDelay(1_000, 100_000, 4)).toBe(16_000);
  });

  test('delay is capped at maxBackoff (no runaway timers)', () => {
    expect(computeBackoffDelay(1_000, 60_000, 10)).toBe(60_000);
    expect(computeBackoffDelay(1_000, 60_000, 1000)).toBe(60_000);
  });

  test('negative/absurd failure counts stay bounded', () => {
    expect(computeBackoffDelay(1_000, 60_000, -3)).toBe(1_000);
    expect(computeBackoffDelay(1_000, 60_000, Number.POSITIVE_INFINITY)).toBe(60_000);
  });
});

describe('scheduler runtime behaviour', () => {
  test('a persistently failing GOAT backs off instead of hammering the broken pipeline', async () => {
    const gateway = countingGateway(true);
    const p = new InMemoryPersistence();
    const live = new GoatDurableObject(makeGoat('goat_backoff'), SKILLS, {
      reasoning: gateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: p.signals,
      theses: p.theses,
      wakeEvents: p.wakeEvents,
      baseCheckIntervalMs: 25,
      maxBackoffMs: 200,
      periodicReviewMs: 0,
    });
    actors.push(live);

    await sleep(450);

    const state = live.getState();
    // Wakes happened and failures were caught, not crashed.
    expect(gateway.calls).toBeGreaterThanOrEqual(2);
    expect(state.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(state.status).toBe('WATCHING');
    expect(state.isEvaluating).toBe(false);

    // Backoff: with 25ms base and doubling to a 200ms cap, a 450ms window
    // admits far fewer attempts than a tight 25ms loop (which would be ~18).
    expect(gateway.calls).toBeLessThanOrEqual(8);

    // Gaps between attempts must grow (bounded exponential backoff).
    const gaps = gateway.times.slice(1).map((t, i) => t - gateway.times[i]);
    if (gaps.length >= 2) {
      expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(gaps[0]);
    }
  });

  test('one failing GOAT does not starve or destabilize another (failure isolation)', async () => {
    const failingGateway = countingGateway(true);
    const healthyGateway = countingGateway(false);

    const p1 = new InMemoryPersistence();
    const broken = new GoatDurableObject(makeGoat('goat_broken'), SKILLS, {
      reasoning: failingGateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: p1.signals,
      theses: p1.theses,
      wakeEvents: p1.wakeEvents,
      baseCheckIntervalMs: 25,
      maxBackoffMs: 200,
      periodicReviewMs: 0,
    });
    const p2 = new InMemoryPersistence();
    const healthy = new GoatDurableObject(makeGoat('goat_healthy'), SKILLS, {
      reasoning: healthyGateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: p2.signals,
      theses: p2.theses,
      wakeEvents: p2.wakeEvents,
      baseCheckIntervalMs: 25,
      maxBackoffMs: 200,
      periodicReviewMs: 0,
    });
    actors.push(broken, healthy);

    await sleep(300);

    expect(failingGateway.calls).toBeGreaterThanOrEqual(1);
    expect(healthyGateway.calls).toBeGreaterThanOrEqual(2);
    expect(broken.getState().consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(healthy.getState().consecutiveFailures).toBe(0);
    expect(healthy.getState().status).toBe('WATCHING');
    expect(healthy.getState().isEvaluating).toBe(false);
  });

  test('destroy() stops scheduled work: no further wakes after shutdown', async () => {
    const gateway = countingGateway(true);
    const p = new InMemoryPersistence();
    const actor = new GoatDurableObject(makeGoat('goat_stop'), SKILLS, {
      reasoning: gateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: p.signals,
      theses: p.theses,
      wakeEvents: p.wakeEvents,
      baseCheckIntervalMs: 20,
      maxBackoffMs: 100,
      periodicReviewMs: 0,
    });
    actors.push(actor);

    await sleep(70);
    actor.destroy();
    const callsAtStop = gateway.calls;
    expect(callsAtStop).toBeGreaterThanOrEqual(1);

    await sleep(120);
    expect(gateway.calls).toBe(callsAtStop);
  });

  test('registry.remove() destroys the runtime and the GOAT receives no further work', async () => {
    const gateway = countingGateway(true);
    const goat = makeGoat('goat_removed');
    const p = new InMemoryPersistence();

    const actor = durableObjectRegistry.getOrCreate(goat, SKILLS, {
      reasoning: gateway,
      marketProvider: new PaperMarketDataProvider({ enableTicks: false }),
      signals: p.signals,
      theses: p.theses,
      wakeEvents: p.wakeEvents,
      baseCheckIntervalMs: 20,
      maxBackoffMs: 100,
      periodicReviewMs: 0,
    });
    actors.push(actor);

    await sleep(60);
    durableObjectRegistry.remove(goat.id);
    expect(durableObjectRegistry.get(goat.id)).toBeUndefined();

    const callsAtRemoval = gateway.calls;
    await sleep(100);
    expect(gateway.calls).toBe(callsAtRemoval);

    // A stale wake request on the removed actor must be a no-op.
    await actor.wake('after removal', 'MANUAL_REEVALUATE');
    expect(gateway.calls).toBe(callsAtRemoval);
  });
});
