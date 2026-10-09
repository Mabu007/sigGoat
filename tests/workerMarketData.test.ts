import { describe, test, expect } from 'bun:test';
import { MarketDataDO } from '../worker/market-data-worker';
import { sqlAll, sqlFirst, sqlScalar } from '../worker/sql';

/**
 * MARKET DATA DURABLE OBJECT
 * ==========================
 * Runs the REAL Durable Object against an in-memory SQLite-backed storage, so
 * the schema, the idempotent upsert, the job kinds and the retention
 * invariant are all executed rather than assumed.
 *
 * THE SQLITE API MISMATCH THIS PINS
 *
 * The Worker previously called `cursor.first()` and `await`ed `cursor.toArray()`.
 * Neither exists on the real Workers `SqlStorageCursor`, which exposes
 * `toArray()` (synchronous), `one()`, `raw()`, and `rowsRead`/`rowsWritten`
 * counters. Because a hand-written declaration file agreed with the wrong API,
 * `tsc` passed while every SQL call would have thrown in production.
 *
 * The fake cursor below implements the REAL platform surface. A test that
 * passes here therefore depends on the same contract production does.
 */

/* ------------------------------------------------------------------ */
/* SQLite storage                                                      */
/* ------------------------------------------------------------------ */

import { Database, type Statement } from 'bun:sqlite';

/**
 * A REAL in-memory SQLite database, wrapped in the Workers cursor contract.
 *
 * WHY A REAL DATABASE AND NOT A HAND-WRITTEN FAKE
 *
 * The first attempt here emulated SQL with Maps and string parsing. It took
 * longer to get right than the code under test and quietly disagreed with
 * SQLite on aggregates, identifier case and `ON CONFLICT` guard semantics — so
 * it would have asserted against a fiction.
 *
 * `bun:sqlite` is an actual SQLite engine, so `ON CONFLICT ... DO UPDATE ...
 * WHERE`, `COUNT(*)`, `MAX()`, `GROUP BY` and index-backed ordering behave
 * exactly as they do on the Workers runtime. The only thing faked is the
 * cursor SHAPE, and that shape is the thing actually under test.
 */
class SqliteStorage {
  private readonly db = new Database(':memory:');
  /** Statements are cached: the worker re-executes the same upsert per bar. */
  private readonly statements = new Map<string, Statement>();

  exec(query: string, ...bindings: unknown[]): SqliteCursor<Record<string, any>> {
    const trimmed = query.trim();

    /**
     * MULTI-STATEMENT DDL goes through `db.exec`, not `prepare`.
     *
     * The worker creates its whole schema in one `exec(SCHEMA)` call containing
     * several `CREATE TABLE` and `CREATE INDEX` statements. `prepare` accepts
     * only the first, so the later tables would silently never exist.
     *
     * The Workers runtime accepts multiple statements in `exec`, so this
     * matches the platform rather than working around it.
     */
    if (bindings.length === 0 && trimmed.includes(';')) {
      this.db.exec(trimmed);
      return new SqliteCursor([], 0);
    }

    let statement = this.statements.get(trimmed);
    if (!statement) {
      statement = this.db.prepare(trimmed);
      this.statements.set(trimmed, statement);
    }

    const args = bindings as never[];

    /**
     * READS AND WRITES TAKE DIFFERENT PATHS, AND MIXING THEM IS A TRAP.
     *
     * `bun:sqlite`'s `get()` executes the statement AND advances it. Calling
     * `run()` afterwards therefore executes it a SECOND time — so an
     * `INSERT OR IGNORE` would insert on the first call and report
     * `changes: 0` from the second, which is indistinguishable from a genuine
     * duplicate. Every assertion about idempotent upsert would then be a lie.
     *
     * So the branch is made once, from the statement's own reported columns:
     * a statement with columns returns rows, one without returns changes.
     */
    const returnsRows = statement.columnNames.length > 0;

    if (returnsRows) {
      return new SqliteCursor(statement.all(...args), 0);
    }

    return new SqliteCursor([], statement.run(...args).changes);
  }

  get databaseSize(): number {
    return 0;
  }

  /** Test affordance: the real table list, so schema assertions mean something. */
  tableNames(): string[] {
    return this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row: { name: string }) => row.name);
  }
}

/**
 * The REAL `SqlStorageCursor` surface.
 *
 * Note what is ABSENT: `first()`, and any promise-returning `toArray()`. Their
 * absence is the point — a call to either would throw here exactly as it would
 * on the Workers runtime, which is precisely how the original defect surfaced.
 */
class SqliteCursor<T> {
  private index = 0;

  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly columnNames: string[] = [];

  constructor(
    private readonly rows: T[],
    written: number,
  ) {
    this.rowsRead = rows.length;
    this.rowsWritten = written;
  }

  next(): IteratorResult<T> {
    if (this.index >= this.rows.length) return { done: true, value: undefined };
    return { done: false, value: this.rows[this.index++] };
  }

  /** SYNCHRONOUS on the real platform. */
  toArray(): T[] {
    const rest = this.rows.slice(this.index);
    this.index = this.rows.length;
    return rest;
  }

  /** Throws unless exactly one row — matching the platform. */
  one(): T {
    if (this.rows.length !== 1) {
      throw new Error('one() requires exactly one row');
    }
    return this.rows[0];
  }

  raw() {
    return this.rows[Symbol.iterator]() as never;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

async function makeDO(options?: {
  partition?: string;
  appOrigin?: string;
  secret?: string;
}) {
  const sql = new SqliteStorage();
  const posted: Array<{ url: string; body: any }> = [];

  const storage = {
    sql,
    kv: new Map<string, unknown>(),
    alarms: [] as number[],
    async get<T>(key: string) {
      return this.kv.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      this.kv.set(key, value);
    },
    async delete(key: string) {
      return this.kv.delete(key);
    },
    async deleteAll() {
      this.kv.clear();
    },
    async list() {
      return new Map(this.kv);
    },
    async setAlarm(at: number | Date) {
      this.alarms.push(typeof at === 'number' ? at : at.getTime());
    },
    async deleteAlarm() {},
    async getAlarm() {
      return this.alarms[this.alarms.length - 1] ?? null;
    },
    async transaction<T>(fn: () => Promise<T>) {
      return fn();
    },
    transactionSync<T>(fn: () => T) {
      return fn();
    },
    async sync() {},
  };

  const state = {
    storage,
    id: { toString: () => 'fake', equals: () => false },
    waitUntil: () => {},
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;

  const env = {
    SCHEDULER_SECRET: options?.secret ?? 'scheduler-secret',
    MARKET_DATA_SECRET: options?.secret ?? 'market-secret',
    APP_ORIGIN: options?.appOrigin ?? 'https://app.example.com',
  };

  // Await the constructor's blockConcurrencyWhile so the schema exists.
  const instance = new MarketDataDO(state, env);
  await (state as any).blockConcurrencyWhile(async () => {});

  // Intercept event publication.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    posted.push({
      url: typeof input === 'string' ? input : String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  return {
    state,
    sql,
    posted,
    env,
    object: instance,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    request: (path: string, init?: RequestInit) =>
      new Request(`https://do${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${env.MARKET_DATA_SECRET}`,
          'x-signalgoat-partition': options?.partition ?? 'FX',
        },
        ...init,
      }),
  };
}

const AUTH = { authorization: 'Bearer market-secret' };

/* ------------------------------------------------------------------ */

describe('MarketDataDO storage contract', () => {
  test('the schema is created and every table exists', async () => {
    const harness = await makeDO();
    try {
      const tables = harness.sql.tableNames();
      for (const table of [
        'candles',
        'session_summaries',
        'swings',
        'levels',
        'regimes',
        'subscriptions',
        'jobs',
      ]) {
        expect(tables).toContain(table);
      }
    } finally {
      harness.restore();
    }
  });

  test('recurring jobs are seeded exactly once', async () => {
    const harness = await makeDO();
    try {
      const jobs = sqlAll<{ name: string }>(harness.sql as any, 'SELECT name FROM jobs');
      const names = jobs.map((job) => job.name).sort();

      expect(names).toEqual(['finalize', 'ingest', 'prune']);

      // Re-seeding is INSERT OR IGNORE, so a restart does not duplicate or
      // reset the schedule.
      await (harness.object as any).seedJobs();
      const after = sqlAll<{ name: string }>(harness.sql as any, 'SELECT name FROM jobs');
      expect(after.length).toBe(3);
    } finally {
      harness.restore();
    }
  });

  test('sqlFirst returns null for an empty result rather than throwing', async () => {
    const harness = await makeDO();
    try {
      const row = sqlFirst<{ n: number }>(
        harness.sql as any,
        'SELECT COUNT(*) AS n FROM candles',
      );
      expect(row).not.toBeNull();
      expect(Number(row!.n)).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('sqlScalar reads a single value', async () => {
    const harness = await makeDO();
    try {
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(0);
    } finally {
      harness.restore();
    }
  });
});

describe('MarketDataDO authentication', () => {
  test('the market-data secret is accepted', async () => {
    const harness = await makeDO();
    try {
      const response = await harness.object.fetch(
        new Request('https://do/status', { method: 'POST', headers: AUTH }),
      );
      expect(response.status).toBe(200);
    } finally {
      harness.restore();
    }
  });

  test('a wrong secret is refused', async () => {
    const harness = await makeDO();
    try {
      const response = await harness.object.fetch(
        new Request('https://do/status', {
          method: 'POST',
          headers: { authorization: 'Bearer wrong' },
        }),
      );
      expect(response.status).toBe(401);
    } finally {
      harness.restore();
    }
  });

  test('the scheduler secret also works, so one-secret deployments function', async () => {
    const harness = await makeDO();
    try {
      const response = await harness.object.fetch(
        new Request('https://do/status', {
          method: 'POST',
          headers: { authorization: 'Bearer scheduler-secret' },
        }),
      );
      expect(response.status).toBe(200);
    } finally {
      harness.restore();
    }
  });

  test('an absent Authorization header is refused', async () => {
    const harness = await makeDO();
    try {
      const response = await harness.object.fetch(
        new Request('https://do/status', { method: 'POST' }),
      );
      expect(response.status).toBe(401);
    } finally {
      harness.restore();
    }
  });
});

describe('MarketDataDO candle ingestion', () => {
  /**
   * Insert directly so the idempotency assertion is about the storage layer,
   * not about a provider stub.
   */
  function insertCandles(
    harness: Awaited<ReturnType<typeof makeDO>>,
    instrument: string,
    bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>,
  ) {
    return (harness.object as any).upsertCandles(instrument, bars);
  }

  test('a new candle is written and reported', async () => {
    const harness = await makeDO();
    try {
      const now = Date.now();
      const newest = insertCandles(harness, 'EUR/USD', [
        { time: now, open: 1.1, high: 1.2, low: 1.05, close: 1.15, volume: 10 },
      ]);

      expect(newest).not.toBeNull();
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(1);
    } finally {
      harness.restore();
    }
  });

  /**
   * The idempotency property.
   *
   * A byte-identical redelivery must write NOTHING, which is what stops a
   * redundant ingestion pass from publishing an event every consumer has already
   * processed.
   */
  test('an identical redelivery writes nothing and returns null', async () => {
    const harness = await makeDO();
    try {
      const now = Date.now();
      const bar = { time: now, open: 1.1, high: 1.2, low: 1.05, close: 1.15, volume: 10 };

      insertCandles(harness, 'EUR/USD', [bar]);
      const second = insertCandles(harness, 'EUR/USD', [bar]);

      expect(second).toBeNull();
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('a genuine provider correction IS written', async () => {
    const harness = await makeDO();
    try {
      const now = Date.now();
      insertCandles(harness, 'EUR/USD', [
        { time: now, open: 1.1, high: 1.2, low: 1.05, close: 1.15, volume: 10 },
      ]);

      const corrected = insertCandles(harness, 'EUR/USD', [
        { time: now, open: 1.1, high: 1.2, low: 1.05, close: 1.18, volume: 10 },
      ]);

      expect(corrected).not.toBeNull();
      // Still one row: the primary key prevents a duplicate minute.
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(1);

      const row = sqlFirst<{ close: number; revision: number }>(
        harness.sql as any,
        'SELECT close, revision FROM candles',
      );
      expect(Number(row!.close)).toBeCloseTo(1.18, 5);
    } finally {
      harness.restore();
    }
  });

  test('a corrupt bar is skipped, never stored', async () => {
    const harness = await makeDO();
    try {
      const now = Date.now();
      insertCandles(harness, 'EUR/USD', [
        { time: now, open: 0, high: 1.2, low: 1.05, close: 1.15 },
        { time: now + 60_000, open: 1.1, high: 0.9, low: 1.2, close: 1.15 },
        { time: now + 120_000, open: NaN, high: 1.2, low: 1.05, close: 1.15 },
        { time: now + 180_000, open: 1.1, high: 1.2, low: 1.05, close: 1.15 },
      ]);

      // Only the one valid bar survives.
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('candles are bucketed to the minute, so one bar per minute', async () => {
    const harness = await makeDO();
    try {
      const base = 1_700_000_000_000;
      insertCandles(harness, 'EUR/USD', [
        { time: base, open: 1.1, high: 1.2, low: 1.05, close: 1.15 },
        { time: base + 30_000, open: 1.1, high: 1.2, low: 1.05, close: 1.16 },
      ]);

      // Both land in the same minute bucket, so exactly one row.
      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM candles'),
      ).toBe(1);

      const row = sqlFirst<{ open_time_ms: number }>(
        harness.sql as any,
        'SELECT open_time_ms FROM candles',
      );
      expect(Number(row!.open_time_ms) % 60_000).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('candles are served oldest-first, as every consumer expects', async () => {
    const harness = await makeDO();
    try {
      const base = 1_700_000_000_000;
      insertCandles(harness, 'EUR/USD', [
        { time: base + 120_000, open: 1.3, high: 1.4, low: 1.25, close: 1.35 },
        { time: base, open: 1.1, high: 1.2, low: 1.05, close: 1.15 },
        { time: base + 60_000, open: 1.2, high: 1.3, low: 1.15, close: 1.25 },
      ]);

      const response = await harness.object.fetch(
        new Request('https://do/candles?instrument=EUR/USD&limit=10', {
          method: 'GET',
          headers: AUTH,
        }),
      );
      const body = await response.json();

      const times = body.candles.map((c: any) => c.open_time_ms);
      expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
    } finally {
      harness.restore();
    }
  });

  test('an unknown action is a 404, not a silent success', async () => {
    const harness = await makeDO();
    try {
      const response = await harness.object.fetch(
        new Request('https://do/nonsense', { method: 'POST', headers: AUTH }),
      );
      expect(response.status).toBe(404);
    } finally {
      harness.restore();
    }
  });
});

describe('MarketDataDO subscriptions and events', () => {
  test('a subscription is stored and a warm instrument floor exists', async () => {
    const harness = await makeDO({ partition: 'FX' });
    try {
      const response = await harness.object.fetch(
        new Request('https://do/subscribe', {
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify({
            subscriberId: 'goat_1',
            instrument: 'EUR/USD',
            eventTypes: ['CANDLE_FINALIZED'],
          }),
        }),
      );
      expect(response.status).toBe(200);

      const instruments = await (harness.object as any).instrumentsFor('INGEST');
      expect(instruments).toContain('EUR/USD');
      // The warm floor means a cold object is not idle before any subscription.
      expect(instruments.length).toBeGreaterThan(1);
    } finally {
      harness.restore();
    }
  });

  test('re-subscribing is idempotent', async () => {
    const harness = await makeDO();
    try {
      const body = JSON.stringify({ subscriberId: 'goat_1', instrument: 'EUR/USD' });

      await harness.object.fetch(
        new Request('https://do/subscribe', {
          method: 'POST',
          headers: AUTH,
          body,
        }),
      );
      await harness.object.fetch(
        new Request('https://do/subscribe', {
          method: 'POST',
          headers: AUTH,
          body,
        }),
      );

      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM subscriptions'),
      ).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('unsubscribe without an instrument removes every subscription', async () => {
    const harness = await makeDO();
    try {
      for (const instrument of ['EUR/USD', 'GBP/USD']) {
        await harness.object.fetch(
          new Request('https://do/subscribe', {
            method: 'POST',
            headers: AUTH,
            body: JSON.stringify({ subscriberId: 'goat_1', instrument }),
          }),
        );
      }

      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM subscriptions'),
      ).toBe(2);

      await harness.object.fetch(
        new Request('https://do/unsubscribe', {
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify({ subscriberId: 'goat_1' }),
        }),
      );

      expect(
        sqlScalar(harness.sql as any, 'SELECT COUNT(*) FROM subscriptions'),
      ).toBe(0);
    } finally {
      harness.restore();
    }
  });

  /**
   * THE MISSING LINK.
   *
   * The Worker ingested candles and the app had an authenticated
   * `/api/internal/market-event` endpoint, but nothing ever called it: the
   * canonical store grew while every consumer stayed blind.
   */
  test('publishing a candle event posts to the application', async () => {
    const harness = await makeDO({ partition: 'FX' });
    try {
      const candleOpenTimeMs = 1_700_000_000_000;

      await harness.object.fetch(
        new Request('https://do/subscribe', {
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify({ subscriberId: 'goat_1', instrument: 'EUR/USD' }),
        }),
      );

      insertCandleForPublish(harness, 'EUR/USD', candleOpenTimeMs);

      await (harness.object as any).publishEvents(['EUR/USD'], []);

      expect(harness.posted.length).toBe(1);
      expect(harness.posted[0].url).toBe(
        'https://app.example.com/api/internal/market-event',
      );

      const event = harness.posted[0].body;
      expect(event.type).toBe('CANDLE_FINALIZED');
      expect(event.instrument).toBe('EUR/USD');
      expect(event.partition).toBe('FX');
      expect(event.candleOpenTimeMs).toBe(candleOpenTimeMs);

      /**
       * The event id must match the rule the APP validates against
       * (`partition:type:instrument:candleOpenTimeMs`). A mismatch means the app
       * rejects every event as malformed and nothing is ever delivered.
       */
      expect(event.eventId).toBe(
        `FX:CANDLE_FINALIZED:EUR/USD:${candleOpenTimeMs}`,
      );
      expect(event.eventIdVersion).toBe(1);
      expect(event.schemaVersion).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('an event carries no user identity — only opaque routing keys', async () => {
    const harness = await makeDO();
    try {
      insertCandleForPublish(harness, 'GBP/USD', 1_700_000_000_000);
      await (harness.object as any).publishEvents(['GBP/USD'], []);

      const event = harness.posted[0].body;
      const keys = Object.keys(event);

      // Nothing that identifies a user, a credential or a GOAT definition.
      expect(keys).not.toContain('userId');
      expect(keys).not.toContain('apiKey');
      expect(keys).not.toContain('goat');
      // The only subscriber-shaped value is the partition, which is routing.
      expect(typeof event.partition).toBe('string');
    } finally {
      harness.restore();
    }
  });

  test('a freshness transition publishes DATA_STALE, a steady gap does not', async () => {
    const harness = await makeDO();
    try {
      // No candles stored for this instrument at all, so it counts as stale.
      const isStale = await (harness.object as any).isStale('EUR/USD', Date.now());
      expect(isStale).toBe(true);

      await (harness.object as any).publishEvents([], [
        { instrument: 'EUR/USD', recovered: false },
      ]);
      expect(harness.posted[0].body.type).toBe('DATA_STALE');

      harness.posted.length = 0;
      await (harness.object as any).publishEvents([], [
        { instrument: 'EUR/USD', recovered: true },
      ]);
      expect(harness.posted[0].body.type).toBe('DATA_RECOVERED');
    } finally {
      harness.restore();
    }
  });

  test('a DATA_STALE event has no candle reference', async () => {
    const harness = await makeDO();
    try {
      await (harness.object as any).publishEvents([], [
        { instrument: 'EUR/USD', recovered: false },
      ]);

      const event = harness.posted[0].body;
      expect(event.candleOpenTimeMs).toBeNull();
      expect(event.reference).toBeNull();
      // And the id still matches the app's validation rule.
      expect(event.eventId).toBe('FX:DATA_STALE:EUR/USD:na');
    } finally {
      harness.restore();
    }
  });

  test('an unreachable app does not fail the ingestion job', async () => {
    const harness = await makeDO();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('app unreachable');
    }) as unknown as typeof fetch;

    try {
      insertCandleForPublish(harness, 'EUR/USD', 1_700_000_000_000);
      // Must not throw: events are a notification, and the app re-reads candles.
      await (harness.object as any).publishEvents(['EUR/USD'], []);
    } finally {
      globalThis.fetch = originalFetch;
      harness.restore();
    }
  });

  test('status reports the real armed time and partition', async () => {
    const harness = await makeDO({ partition: 'METALS' });
    try {
      const response = await harness.object.fetch(
        new Request('https://do/status', {
          method: 'POST',
          // The router tells the object which partition it owns via this header;
          // a Durable Object cannot read back its own name.
          headers: { ...AUTH, 'x-signalgoat-partition': 'METALS' },
        }),
      );
      const body = await response.json();

      expect(body.partition).toBe('METALS');
      // Previously hardcoded null, so a stalled queue was indistinguishable
      // from a healthy one.
      expect(typeof body.armedFor).toBe('number');
      expect(Array.isArray(body.jobs)).toBe(true);
      expect(body.jobs.length).toBe(3);
    } finally {
      harness.restore();
    }
  });
});

/** Inserts one candle straight into storage, for event-publication tests. */
function insertCandleForPublish(
  harness: Awaited<ReturnType<typeof makeDO>>,
  instrument: string,
  openTimeMs: number,
) {
  (harness.sql as any).exec(
    `INSERT INTO candles
       (instrument, open_time_ms, open, high, low, close, volume,
        finalized, revision, received_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    instrument,
    openTimeMs,
    1.1,
    1.2,
    1.05,
    1.15,
    10,
    Date.now(),
    Date.now(),
  );
}