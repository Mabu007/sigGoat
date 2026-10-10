import { describe, test, expect } from 'bun:test';
import {
  createMarketEvent,
  buildEventId,
  validateMarketEvent,
  MARKET_EVENT_SCHEMA_VERSION,
} from '../src/services/market-data/MarketEvent';
import { MarketIngestionService } from '../src/services/market-data/MarketIngestionService';
import type { CandleSource } from '../src/services/market-data/MarketIngestionService';
import { MemoryCandleRepository } from '../src/services/market-data/candle-core/CandleRepositories';
import { MINUTE_MS } from '../src/services/market-data/candle-core/CandleRecord';
import {
  NotificationOutbox,
  MemoryOutboxStore,
  notificationKey,
} from '../src/services/telegram/NotificationOutbox';
import type { OutboxRecord } from '../src/services/telegram/NotificationOutbox';

/**
 * EVENT DELIVERY, IDEMPOTENCY AND NOTIFICATION RELIABILITY
 * ==========================================================
 * Everything here is about the assumption that alarms, requests and event
 * deliveries may run MORE THAN ONCE. The system must behave correctly anyway:
 * no duplicate signals, no duplicate alerts, no lost notifications, and no
 * single failing GOAT able to stall the rest.
 */

const INSTRUMENT = 'EUR/USD';
const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

/* ------------------------------------------------------------------ */
/* Event contract                                                      */
/* ------------------------------------------------------------------ */

describe('market event contract', () => {
  test('the event id is deterministic for a logical occurrence', () => {
    const a = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: 'eur/usd',
      candleOpenTimeMs: BASE,
    });
    const b = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: 'EUR/USD',
      candleOpenTimeMs: BASE,
    });

    // Same occurrence, same id — which is what lets every consumer dedupe
    // without coordinating.
    expect(a.eventId).toBe(b.eventId);
    expect(a.eventId).toBe(buildEventId('FX', 'CANDLE_FINALIZED', 'EUR/USD', BASE));
  });

  test('different occurrences get different ids', () => {
    const base = { partition: 'FX', instrument: INSTRUMENT };

    const first = createMarketEvent({ ...base, type: 'CANDLE_FINALIZED', candleOpenTimeMs: BASE });
    const later = createMarketEvent({ ...base, type: 'CANDLE_FINALIZED', candleOpenTimeMs: BASE + MINUTE_MS });
    const other = createMarketEvent({ ...base, type: 'CANDLE_CORRECTED', candleOpenTimeMs: BASE });

    expect(new Set([first.eventId, later.eventId, other.eventId]).size).toBe(3);
  });

  test('a valid event round-trips through validation', () => {
    const event = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: INSTRUMENT,
      candleOpenTimeMs: BASE,
      context: { lagSeconds: 3, dataQuality: 'OK' },
    });

    const validated = validateMarketEvent(JSON.parse(JSON.stringify(event)));

    expect(validated).not.toBeNull();
    expect(validated!.eventId).toBe(event.eventId);
    expect(validated!.context.lagSeconds).toBe(3);
  });

  test('an event whose id was altered is rejected', () => {
    const event = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: INSTRUMENT,
      candleOpenTimeMs: BASE,
    });

    // A tampered id could otherwise be used to suppress a legitimate event by
    // colliding with it.
    const tampered = { ...event, eventId: `${event.eventId}:forged` };
    expect(validateMarketEvent(tampered)).toBeNull();
  });

  test('an event from a different schema generation is rejected', () => {
    const event = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: INSTRUMENT,
      candleOpenTimeMs: BASE,
    });

    expect(
      validateMarketEvent({ ...event, schemaVersion: MARKET_EVENT_SCHEMA_VERSION + 1 }),
    ).toBeNull();
    expect(validateMarketEvent({ ...event, eventIdVersion: 2 })).toBeNull();
  });

  test('an unknown event type is rejected', () => {
    const event = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: INSTRUMENT,
      candleOpenTimeMs: BASE,
    });

    expect(validateMarketEvent({ ...event, type: 'RUN_ARBITRARY_CODE' })).toBeNull();
  });

  test('malformed payloads are rejected rather than partially applied', () => {
    expect(validateMarketEvent(null)).toBeNull();
    expect(validateMarketEvent('string')).toBeNull();
    expect(validateMarketEvent({})).toBeNull();
    expect(validateMarketEvent({ eventId: '', partition: 'FX', instrument: 'EUR/USD', schemaVersion: 1, eventIdVersion: 1, type: 'DATA_STALE' })).toBeNull();
  });

  test('an event carries no user data', () => {
    const event = createMarketEvent({
      type: 'CANDLE_FINALIZED',
      partition: 'FX',
      instrument: INSTRUMENT,
      candleOpenTimeMs: BASE,
    });

    const serialised = JSON.stringify(event);

    expect(serialised).not.toContain('userId');
    expect(serialised).not.toContain('apiKey');
    expect(serialised).not.toContain('token');
    expect(serialised).not.toContain('thesis');
    // It is a notification, not a data transfer: no candle history rides along.
    expect(serialised).not.toContain('"candles"');
  });
});

/* ------------------------------------------------------------------ */
/* Shared ingestion                                                    */
/* ------------------------------------------------------------------ */

describe('shared market ingestion', () => {
  function bars(count: number, startMs = BASE - count * MINUTE_MS) {
    return Array.from({ length: count }, (_, i) => {
      const close = 1.085 + i * 0.0001;
      return {
        time: startMs + i * MINUTE_MS,
        open: close,
        high: close + 0.0005,
        low: close - 0.0005,
        close,
        volume: 100,
      };
    });
  }

  function source(overrides: Partial<CandleSource> = {}, count = 30): CandleSource & { calls: number } {
    const base = {
      name: 'test-source',
      calls: 0,
      getCandles: async () => {
        base.calls += 1;
        return bars(count);
      },
    };
    return Object.assign(base, overrides) as CandleSource & { calls: number };
  }

  function service(src: CandleSource, now = BASE) {
    const storage = new MemoryCandleRepository();
    return {
      storage,
      ingestion: new MarketIngestionService({ storage, source: src, now: () => now }),
    };
  }

  test('one ingestion pass serves every subscriber of that instrument', async () => {
    const src = source();
    const { ingestion } = service(src);

    // Five GOATs on the same pair must still cost ONE provider call.
    for (let i = 0; i < 5; i += 1) {
      ingestion.subscribe({ subscriberId: `goat_${i}`, instrument: INSTRUMENT, eventTypes: [] });
    }

    await ingestion.ingest([INSTRUMENT]);

    expect(src.calls).toBe(1);
    expect(ingestion.totalSubscriptions()).toBe(5);
  });

  test('overlapping passes for one partition are suppressed, not queued', async () => {
    let resolveFirst: (() => void) | null = null;
    const src: CandleSource & { calls: number } = {
      name: 'slow-source',
      calls: 0,
      getCandles: async () => {
        src.calls += 1;
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return bars(10);
      },
    };

    const { ingestion } = service(src);
    ingestion.subscribe({ subscriberId: 'a', instrument: INSTRUMENT, eventTypes: [] });

    const first = ingestion.ingest([INSTRUMENT]);

    // A second pass for the same partition while the first is still running.
    const second = await ingestion.ingest([INSTRUMENT]);

    expect(second.skipped).toBe(1);
    expect(ingestion.stats.overlapSuppressed).toBe(1);

    resolveFirst!();
    await first;

    // Exactly one provider call: the duplicate was dropped, not deferred.
    expect(src.calls).toBe(1);
  });

  test('instruments are partitioned by class', async () => {
    const src = source();
    const { ingestion } = service(src);

    await ingestion.ingest(['EUR/USD', 'XYZ:GOLD', 'XYZ:JP225', 'BTC']);

    const counts = ingestion.subscriptionCounts();
    void counts;

    expect(MarketIngestionService.partitionFor('EUR/USD')).toBe('FX');
    expect(MarketIngestionService.partitionFor('XYZ:GOLD')).toBe('METALS');
    expect(MarketIngestionService.partitionFor('XYZ:JP225')).toBe('INDEX');
    expect(MarketIngestionService.partitionFor('BTC')).toBe('CRYPTO');
  });

  test('duplicate subscription is idempotent', async () => {
    const src = source();
    const { ingestion } = service(src);

    ingestion.subscribe({ subscriberId: 'goat_a', instrument: INSTRUMENT, eventTypes: [] });
    ingestion.subscribe({ subscriberId: 'goat_a', instrument: INSTRUMENT, eventTypes: [] });

    // Two registrations for one GOAT must not double-deliver events, which
    // would otherwise show up as duplicate signals.
    expect(ingestion.totalSubscriptions()).toBe(1);
  });

  test('unsubscribing removes the subscription; unsubscribeAll clears everything', async () => {
    const src = source();
    const { ingestion } = service(src);

    ingestion.subscribe({ subscriberId: 'a', instrument: INSTRUMENT, eventTypes: [] });
    ingestion.subscribe({ subscriberId: 'a', instrument: 'GBP/USD', eventTypes: [] });

    expect(ingestion.unsubscribe('a', INSTRUMENT)).toBe(true);
    expect(ingestion.totalSubscriptions()).toBe(1);

    expect(ingestion.unsubscribeAll('a')).toBe(1);
    expect(ingestion.totalSubscriptions()).toBe(0);
  });

  test('subscriptions rebuild from durable records after a restart', async () => {
    const src = source();
    const { ingestion } = service(src);

    // A cold container has an empty table; this is what restores it.
    const restored = ingestion.rebuildSubscriptions([
      { subscriberId: 'goat_a', instrument: INSTRUMENT, eventTypes: ['CANDLE_FINALIZED'] },
      { subscriberId: 'goat_b', instrument: INSTRUMENT, eventTypes: [] },
      { subscriberId: 'goat_c', instrument: 'GBP/USD', eventTypes: [] },
    ]);

    expect(restored).toBe(3);
    expect(ingestion.totalSubscriptions()).toBe(3);

    // All three are FX, and each (subscriber, instrument) pair is distinct.
    expect(ingestion.subscriptionCounts()).toEqual({ FX: 3 });

    const pairs = ingestion
      .listSubscriptions()
      .map((s) => `${s.subscriberId}:${s.instrument}`)
      .sort();
    expect(pairs).toEqual([
      'goat_a:EUR/USD',
      'goat_b:EUR/USD',
      'goat_c:GBP/USD',
    ]);
  });

  test('corrupt candles are counted and never stored', async () => {
    const bad: CandleSource = {
      name: 'corrupt',
      getCandles: async () => [
        { time: BASE, open: 1.08, high: 1.09, low: 1.07, close: 0, volume: 1 },
        { time: BASE + MINUTE_MS, open: 1.08, high: 1.07, low: 1.09, close: 1.08, volume: 1 },
        { time: BASE + 2 * MINUTE_MS, open: 1.08, high: 1.09, low: 1.07, close: 1.085, volume: 1 },
      ],
    };

    const { storage, ingestion } = service(bad, BASE + 10 * MINUTE_MS);
    await ingestion.ingest([INSTRUMENT]);

    // Rejected bars are counted, never silently dropped and never fabricated.
    expect(ingestion.stats.candlesRejected).toBe(2);
    expect(await storage.count(INSTRUMENT)).toBe(1);
  });

  test('provider failure records staleness instead of serving stale data as live', async () => {
    const failing: CandleSource = {
      name: 'down',
      getCandles: async () => {
        throw new Error('HTTP 503');
      },
    };

    const { ingestion } = service(failing, BASE + 5 * MINUTE_MS);
    await ingestion.ingest([INSTRUMENT]);

    const state = ingestion.freshnessOf(INSTRUMENT);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.stale).toBe(true);
    expect(state.lastError).toContain('503');
    expect(state.dataLagSeconds).toBeNull();
  });

  test('repeated provider failure opens a breaker and stops hammering', async () => {
    let calls = 0;
    const failing: CandleSource = {
      name: 'down',
      getCandles: async () => {
        calls += 1;
        throw new Error('HTTP 503');
      },
    };

    const storage = new MemoryCandleRepository();
    const ingestion = new MarketIngestionService({
      storage,
      source: failing,
      breakerThreshold: 3,
      now: () => BASE,
    });

    for (let i = 0; i < 10; i += 1) {
      await ingestion.ingest([INSTRUMENT]);
    }

    // The breaker stops the hot loop: 10 attempts must not become 10 requests.
    expect(calls).toBeLessThanOrEqual(4);
    expect(ingestion.stats.breakerOpens).toBeGreaterThan(0);
  });

  test('freshness tracks the newest finalized candle', async () => {
    const src = source();
    const at = BASE + 40 * MINUTE_MS;
    const { ingestion } = service(src, at);

    await ingestion.ingest([INSTRUMENT]);

    const state = ingestion.freshnessOf(INSTRUMENT);
    expect(state.lastSuccessfulIngestAtMs).toBe(at);
    expect(state.lastCandleOpenTimeMs).toBeGreaterThan(0);
    expect(state.consecutiveFailures).toBe(0);
  });

  test('a market that is closed is reported as closed, not as a failure', async () => {
    // Saturday: FX is shut. That is normal, not an outage.
    const saturday = Date.parse('2026-01-17T12:00:00Z');
    const src = source();
    const { ingestion } = service(src, saturday);

    await ingestion.ingest([INSTRUMENT]);

    expect(ingestion.freshnessOf(INSTRUMENT).marketOpen).toBe(false);
    expect(ingestion.freshnessOf(INSTRUMENT).consecutiveFailures).toBe(0);
  });

  test('a failing subscriber listener does not stop ingestion', async () => {
    const src = source();
    const { ingestion } = service(src);

    const seen: string[] = [];
    ingestion.onEvent(() => {
      throw new Error('subscriber exploded');
    });
    ingestion.onEvent((event) => seen.push(event.type));

    const result = await ingestion.ingest([INSTRUMENT]);

    // The bad listener is contained; the good one still receives events.
    expect(seen.length).toBeGreaterThan(0);
    expect(result.inserted).toBe(30);
  });

  test('events are emitted for the newest candle only', async () => {
    const src = source();
    const { ingestion } = service(src, BASE + 60 * MINUTE_MS);

    const events: string[] = [];
    ingestion.onEvent((event) => events.push(event.type));

    await ingestion.ingest([INSTRUMENT]);

    // 30 bars in, but only the transition is worth a notification; waking a
    // GOAT for a candle from 29 minutes ago would be wrong and expensive.
    expect(events.filter((e) => e === 'CANDLE_FINALIZED')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Notification outbox                                                 */
/* ------------------------------------------------------------------ */

describe('notification outbox', () => {
  function setup() {
    const store = new MemoryOutboxStore();
    let now = BASE;
    const sent: OutboxRecord[] = [];
    let fail = false;

    const outbox = new NotificationOutbox({
      store,
      deliverer: {
        deliver: async (record) => {
          if (fail) throw new Error('Telegram unreachable');
          sent.push(record);
          return { messageId: '999' };
        },
      },
      now: () => now,
      maxAttempts: 3,
      baseBackoffMs: 1000,
    });

    return {
      store,
      outbox,
      sent,
      setNow: (value: number) => {
        now = value;
      },
      setFail: (value: boolean) => {
        fail = value;
      },
    };
  }

  const message = {
    goatId: 'goat_1',
    userId: 'user_1',
    kind: 'SIGNAL' as const,
    subjectId: 'sig_abc',
    body: 'Signal alert body',
  };

  test('the idempotency key is derived from the decision, not the attempt', () => {
    const a = notificationKey({ goatId: 'g', kind: 'SIGNAL', subjectId: 'sig_1' });
    const b = notificationKey({ goatId: 'g', kind: 'SIGNAL', subjectId: 'sig_1' });

    expect(a).toBe(b);
    expect(a).toBe('g:SIGNAL:sig_1');
  });

  test('the same tracker firing on the same candle is one notification', () => {
    const at = BASE;
    const a = notificationKey({ goatId: 'g', kind: 'TRACKER_TRIGGERED', subjectId: 't1', candleOpenTimeMs: at });
    const b = notificationKey({ goatId: 'g', kind: 'TRACKER_TRIGGERED', subjectId: 't1', candleOpenTimeMs: at });

    expect(a).toBe(b);
  });

  test('the same tracker firing on a LATER candle is a new notification', () => {
    const a = notificationKey({ goatId: 'g', kind: 'TRACKER_TRIGGERED', subjectId: 't1', candleOpenTimeMs: BASE });
    const b = notificationKey({ goatId: 'g', kind: 'TRACKER_TRIGGERED', subjectId: 't1', candleOpenTimeMs: BASE + MINUTE_MS });

    expect(a).not.toBe(b);
  });

  test('a duplicate logical signal is suppressed', async () => {
    const { outbox, sent } = setup();

    const first = await outbox.enqueue(message);
    const second = await outbox.enqueue(message);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    await outbox.deliverOne(first.id);
    await outbox.deliverOne(second.id);

    // A retried wake re-deriving the same decision must not re-notify.
    expect(sent).toHaveLength(1);
    expect(outbox.stats.suppressedDuplicates).toBe(1);
  });

  test('a Telegram outage leaves a retryable record rather than a lost alert', async () => {
    const { outbox, setFail, setNow } = setup();
    setFail(true);

    const { id } = await outbox.enqueue(message);
    await outbox.deliverOne(id);

    let record = await outbox.store.get(id);
    expect(record!.status).toBe('FAILED');
    expect(record!.attempts).toBe(1);

    // Not due yet.
    expect(await outbox.store.due(BASE, 10)).toHaveLength(0);

    // Recovery, then a successful drain.
    setFail(false);
    setNow(BASE + 10_000);
    const drained = await outbox.drain();

    expect(drained.delivered).toBe(1);
    record = await outbox.store.get(id);
    expect(record!.status).toBe('SENT');
    expect(record!.deliveredMessageId).toBe('999');
  });

  test('retries are bounded and then dead-lettered', async () => {
    const { outbox, setFail, setNow } = setup();
    setFail(true);

    const { id } = await outbox.enqueue(message);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      setNow(BASE + attempt * 60_000);
      await outbox.drain();
    }

    const record = await outbox.store.get(id);
    expect(record!.status).toBe('DEAD_LETTER');
    expect(record!.attempts).toBe(3);
    // The payload is retained for inspection rather than discarded.
    expect(record!.body).toBe('Signal alert body');
    expect(outbox.stats.deadLettered).toBe(1);
  });

  test('a delivery with no confirmation is recorded but NOT retried', async () => {
    const store = new MemoryOutboxStore();
    const outbox = new NotificationOutbox({
      store,
      // Telegram accepted it but the acknowledgement could not be read.
      deliverer: { deliver: async () => ({ messageId: '' }) },
      now: () => BASE,
    });

    const { id } = await outbox.enqueue(message);
    await outbox.deliverOne(id);

    const record = await store.get(id);
    expect(record!.status).toBe('SENT_UNCONFIRMED');

    // Deliberately not retried: a possible duplicate is preferable to a
    // certainly lost alert, and the ambiguity is recorded rather than hidden.
    expect(await store.due(BASE + 3_600_000, 10)).toHaveLength(0);
  });

  test('a terminal record is never delivered again', async () => {
    const { outbox, sent, store } = setup();
    const { id } = await outbox.enqueue(message);

    await outbox.deliverOne(id);
    await outbox.deliverOne(id);
    await outbox.deliverOne(id);

    expect(sent).toHaveLength(1);
    expect((await store.get(id))!.status).toBe('SENT');
  });

  test('a record abandoned mid-send is reclaimed by the stale sweep', async () => {
    const store = new MemoryOutboxStore();
    const outbox = new NotificationOutbox({
      store,
      deliverer: { deliver: async () => ({ messageId: '1' }) },
      now: () => BASE,
      maxAttempts: 5,
    });

    const { id } = await outbox.enqueue(message);

    // Simulate a crash between marking SENDING and settling.
    await store.save({
      ...(await store.get(id))!,
      status: 'SENDING',
      attempts: 1,
      updatedAtMs: BASE - 60 * 60_000,
    });

    const reclaimed = await outbox.reclaimStale(10 * 60_000);

    expect(reclaimed).toBe(1);
    const record = await store.get(id);
    expect(record!.status).toBe('FAILED');
    expect(record!.lastError).toContain('Abandoned mid-send');
  });

  test('the outbox never persists a bot token', async () => {
    const { store, outbox } = setup();
    await outbox.enqueue(message);

    const serialised = JSON.stringify(store.all());
    expect(serialised).not.toContain('bot');
    expect(serialised).not.toContain('token');
    expect(serialised).not.toContain('TELEGRAM');
  });

  test('health reports delivery state without message bodies', async () => {
    const { outbox, store } = setup();
    const { id } = await outbox.enqueue(message);
    await outbox.deliverOne(id);

    const health = await outbox.health();
    const serialised = JSON.stringify(health);

    expect(health.sent).toBe(1);
    expect(serialised).not.toContain('Signal alert body');
  });

  test('one failing delivery does not block the rest of the batch', async () => {
    const store = new MemoryOutboxStore();
    const outbox = new NotificationOutbox({
      store,
      deliverer: {
        deliver: async (record) => {
          if (record.subjectId === 'sig_bad') throw new Error('boom');
          return { messageId: '1' };
        },
      },
      now: () => BASE,
    });

    await outbox.enqueue({ ...message, subjectId: 'sig_bad' });
    await outbox.enqueue({ ...message, subjectId: 'sig_good' });

    const drained = await outbox.drain();

    expect(drained.delivered).toBe(1);
    expect(drained.failed).toBe(1);
    expect((await store.get('goat_1:SIGNAL:sig_good'))!.status).toBe('SENT');
    expect((await store.get('goat_1:SIGNAL:sig_bad'))!.status).toBe('FAILED');
  });
});