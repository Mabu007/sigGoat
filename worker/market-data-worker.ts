/**
 * MARKET DATA DURABLE OBJECT
 * ==========================
 * The persistent, authoritative home for canonical one-minute candles and the
 * facts derived from them.
 *
 * ONE OBJECT PER INSTRUMENT CLASS
 *
 * Partitioned by class (FX / METALS / ENERGY / INDEX / CRYPTO) rather than by
 * symbol. The reasoning is in `MarketIngestionService`: an object per symbol
 * means one alarm per symbol whether or not the market is open, and one object
 * for everything means a single hot object where one failing symbol blocks
 * every other. Class partitioning gives bounded fan-out and per-class fault
 * isolation with a single-digit object count.
 *
 * WHY SQLITE AND NOT KV
 *
 * The access pattern is "candles for this instrument between T1 and T2" and
 * "delete everything below the finalized watermark, bounded, in batches". That
 * is a range scan with an index, not a key lookup. KV would mean either
 * scanning every key (unbounded work per event) or encoding the time into the
 * key and then losing the ability to query by instrument alone. The SQL
 * backend gives a real `PRIMARY KEY (instrument, open_time_ms)` UNIQUE
 * constraint — which is what makes an upsert idempotent at the storage layer
 * rather than by convention — plus indexes on exactly the two queries that run
 * on the hot path.
 *
 * RUNTIME CONSTRAINTS — UNCHANGED FROM THE SCHEDULER WORKER
 *
 * This runs on the Workers runtime, NOT Node:
 *   - `firebase-admin` cannot be imported here.
 *   - `node:fs` cannot be used; SQL storage replaces it.
 *   - No OpenRouter, no user secrets, no GOAT definitions, no ownership.
 *
 * The DO holds MARKET data only. It never sees a user id, an API key, a thesis
 * or a signal. Subscribers are opaque routing keys.
 *
 * ONE ALARM SLOT, MANY JOBS
 *
 * A Durable Object has exactly one alarm. This object needs ingestion,
 * finalization and pruning on different cadences, so the JOB QUEUE lives in
 * SQLite and the single alarm is always armed for the earliest due job. Every
 * alarm handler is idempotent because Cloudflare retries them.
 */

import { sqlAll, sqlFirst, sqlRun, sqlScalar } from './sql';
import type { SqlValue } from './sql';

export interface MarketDataEnv {
  /** Scheduler secret. Shared with GoatSchedulerDO. */
  SCHEDULER_SECRET: string;
  /**
   * Secret for market-data traffic. The app sends it as
   * `Authorization: Bearer <MARKET_DATA_WORKER_SECRET>`.
   *
   * FALLS BACK TO SCHEDULER_SECRET.
   *
   * The app and this Worker originally each compared against a single shared
   * value under two different names, which meant market-data requests could
   * only ever succeed if the operator set both variables to the same bytes.
   * That is a silent, hard-to-diagnose 401. Accepting either value keeps a
   * single-secret deployment working while still letting the two surfaces be
   * rotated independently.
   */
  MARKET_DATA_SECRET?: string;
  /** Base URL for callbacks into the Vercel application. */
  APP_ORIGIN: string;
}

/** All partitions this Worker routes to. Kept in one place. */
const PARTITIONS = ['FX', 'METALS', 'ENERGY', 'INDEX', 'CRYPTO'] as const;

/**
 * Instruments ingested even with no subscribers.
 *
 * `instrumentsFor()` reads the subscription table, which means an object with
 * no subscribers does no provider work. That is the right default — but on a
 * cold start there are no subscriptions either, so the object would sit idle
 * until the app happened to call `/subscribe`, and a market the user creates a
 * GOAT for would have no history at that moment.
 *
 * This small floor keeps the canonical store warm for the liquid instruments
 * the product defaults to. A subscription adds to it; it never removes.
 */
const DEFAULT_INSTRUMENTS: Record<string, string[]> = {
  FX: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF'],
  METALS: ['XAU/USD', 'XAG/USD'],
  ENERGY: ['WTI', 'BRENT'],
  INDEX: ['US500', 'US100', 'US30'],
  CRYPTO: ['BTC/USD', 'ETH/USD'],
};

/** Hard ceiling on instruments per ingestion pass. */
const MAX_INGEST_INSTRUMENTS = 20;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * The whole durable shape, created once.
 *
 * `candles` is the only table that grows with time, and it is the only one
 * that is ever deleted from. Everything else is bounded by policy.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  instrument   TEXT    NOT NULL,
  open_time_ms INTEGER NOT NULL,
  open   REAL NOT NULL,
  high   REAL NOT NULL,
  low    REAL NOT NULL,
  close  REAL NOT NULL,
  volume REAL,
  finalized INTEGER NOT NULL DEFAULT 1,
  revision     INTEGER NOT NULL DEFAULT 1,
  received_at_ms INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (instrument, open_time_ms)
);

-- Hot path: "newest finalized candle for this instrument". Descending order
-- lets SQLite stop at the first matching row.
CREATE INDEX IF NOT EXISTS idx_candles_finalized
  ON candles (instrument, finalized, open_time_ms DESC);

-- Retention path: bounded delete below the finalized watermark.
CREATE INDEX IF NOT EXISTS idx_candles_time
  ON candles (instrument, open_time_ms);

CREATE TABLE IF NOT EXISTS session_summaries (
  id         TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  session_date TEXT NOT NULL,
  closes_at_ms INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  finalized_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_instrument
  ON session_summaries (instrument, session_date DESC);

CREATE TABLE IF NOT EXISTS swings (
  id         TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  kind       TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,
  status     TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swings_instrument
  ON swings (instrument, kind, at_ms DESC);

CREATE TABLE IF NOT EXISTS levels (
  id          TEXT PRIMARY KEY,
  instrument  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  price       REAL NOT NULL,
  status      TEXT NOT NULL,
  last_validated_at_ms INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_levels_active
  ON levels (instrument, status, price);

CREATE TABLE IF NOT EXISTS regimes (
  id         TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  as_of_ms   INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regimes_instrument
  ON regimes (instrument, as_of_ms DESC);

-- Subscription routing. subscriber_id is opaque and carries no user identity.
CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber_id TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  event_types   TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, instrument)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_instrument
  ON subscriptions (instrument);

-- The job queue behind the single alarm slot.
CREATE TABLE IF NOT EXISTS jobs (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  due_at_ms    INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (due_at_ms);
`;

type JobKind = 'INGEST' | 'FINALIZE' | 'PRUNE' | 'SWEEP';

interface JobRow {
  name: string;
  kind: JobKind;
  due_at_ms: number;
  attempts: number;
  last_error: string | null;
}

/** Cadences. Every one is a deliberate, non-polling floor. */
const INGEST_INTERVAL_MS = 60_000;
const FINALIZE_INTERVAL_MS = 15 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const MAX_JOB_ATTEMPTS = 5;

/** Hard cap on rows returned by any range query, so no call can be unbounded. */
const MAX_QUERY_ROWS = 5_000;

/** Rows deleted per prune batch. Bounded so an alarm stays short. */
const PRUNE_BATCH = 2_000;

/** Instruments finalized / pruned per alarm, so one invocation stays short. */
const MAX_FINALIZE_INSTRUMENTS = 20;

/**
 * Newest candle older than this counts as a data gap.
 *
 * Two minutes of tolerance: the provider is minute-bar data fetched every
 * minute, so a single late or closed-market bar must not be reported as an
 * outage.
 */
const STALENESS_THRESHOLD_MS = 2 * 60_000;

/** Per-event POST timeout. An event is a notification, never blocking. */
const EVENT_POST_TIMEOUT_MS = 5_000;

export class MarketDataDO {
  private readonly state: DurableObjectState;
  private readonly env: MarketDataEnv;

  /** Set once `alarm()` is running, so a nested job cannot recurse. */
  private inAlarm = false;

  /**
   * Which partition this object owns.
   *
   * A Durable Object cannot read back its own name — `idFromName` is a
   * one-way hash — so the router tells it, via a header, on every request.
   * Persisted because the ALARM fires with no request to carry the header, and
   * an alarm that does not know its partition cannot choose its instruments.
   */
  private partition: string = 'FX';

  constructor(state: DurableObjectState, env: MarketDataEnv) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      this.partition = (await this.state.storage.get<string>('partition')) ?? 'FX';
      this.seedJobs();

      /**
       * ARM ON CONSTRUCTION.
       *
       * Seeding the job queue does not arm the alarm that runs it. The object
       * therefore sat completely idle until something called `/subscribe` (which
       * arms as a side effect) or the alarm happened to fire — so a freshly
       * deployed object ingested nothing at all.
       *
       * The next due time is computed from `now`, so this is cheap and safe on
       * every cold start; the alarm it sets is replaced, not multiplied.
       */
      await this.armNext();
    });
  }

  /* ---------------------------------------------------------------- */
  /* HTTP surface                                                      */
  /* ---------------------------------------------------------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!this.authorised(request)) {
      return json({ error: 'unauthorised' }, 401);
    }

    const headerPartition = request.headers.get('x-signalgoat-partition');
    if (headerPartition) {
      const normalised = headerPartition.trim().toUpperCase();
      if (normalised !== this.partition) {
        this.partition = normalised;
        await this.state.storage.put('partition', normalised);
      }
    }

    switch (url.pathname) {
      case '/ingest':
        return this.handleIngest(request);
      case '/candles':
        return this.handleCandles(url);
      case '/subscribe':
        return this.handleSubscribe(request);
      case '/unsubscribe':
        return this.handleUnsubscribe(request);
      case '/finalize':
        return this.handleFinalize(request);
      case '/status':
        return await this.handleStatus();
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  /**
   * The single alarm slot.
   *
   * Runs whichever job is due, then re-arms for the next one. Idempotent by
   * construction: every job is "read current state, write derived facts, prune
   * below a watermark", and all of those are safe to repeat.
   */
  async alarm(): Promise<void> {
    if (this.inAlarm) return;
    this.inAlarm = true;

    try {
      // A bounded number of jobs per alarm keeps the handler short and stops a
      // backlog from producing one enormous invocation.
      for (let i = 0; i < 4; i += 1) {
const job = this.dueJob();
      if (!job) break;
      await this.runJob(job);
      }
    } finally {
      this.inAlarm = false;
      await this.armNext();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Schema and job queue                                              */
  /* ---------------------------------------------------------------- */

  private get sql(): SqlStorage {
    const storage = this.state.storage.sql;
    if (!storage) {
      throw new Error(
        'SQLite storage unavailable. Add new_sqlite_classes = ["MarketDataDO"] to wrangler.toml migrations.',
      );
    }
    return storage;
  }

  private ensureSchema(): void {
    this.sql.exec(SCHEMA);
  }

  /**
   * Seeds the recurring jobs.
   *
   * `INSERT OR IGNORE` makes this safe on every start: the due time is only set
   * the first time a job is seen, so a restart does not reset the schedule.
   *
   * Synchronous, and wrapped in `transactionSync` so the three rows either all
   * land or none do. A partially-seeded queue would leave an object with, say,
   * no PRUNE job at all — a silent, permanent retention leak.
   */
  private seedJobs(): void {
    const now = Date.now();
    const seeds: Array<[string, JobKind, number]> = [
      ['ingest', 'INGEST', now + INGEST_INTERVAL_MS],
      ['finalize', 'FINALIZE', now + FINALIZE_INTERVAL_MS],
      ['prune', 'PRUNE', now + PRUNE_INTERVAL_MS],
    ];

    this.state.storage.transactionSync(() => {
      for (const [name, kind, dueAt] of seeds) {
        this.sql.exec(
          `INSERT OR IGNORE INTO jobs (name, kind, due_at_ms) VALUES (?, ?, ?)`,
          name,
          kind,
          dueAt,
        );
      }
    });
  }

  private dueJob(): JobRow | null {
    return sqlFirst<JobRow & Record<string, SqlValue>>(
      this.sql,
      `SELECT name, kind, due_at_ms, attempts, last_error
         FROM jobs
        WHERE due_at_ms <= ?
        ORDER BY due_at_ms ASC
        LIMIT 1`,
      Date.now(),
    ) as JobRow | null;
  }

  /**
   * Runs one job.
   *
   * THE KIND MUST CHANGE THE WORK.
   *
   * Every kind used to call `ingestInstruments()`, so FINALIZE and PRUNE were
   * aliases for INGEST: candles were fetched forever and nothing was ever
   * summarized or deleted, which is unbounded growth dressed up as retention.
   * Each kind now does only its own job.
   */
  private async runJob(job: JobRow): Promise<void> {
    try {
      if (job.kind === 'INGEST') {
        const instruments = await this.instrumentsFor('INGEST');
        if (instruments.length > 0) {
          const { updated, transition } = await this.ingestInstruments(instruments);
          await this.publishEvents(updated, transition);
        }
      } else if (job.kind === 'FINALIZE') {
        await this.finalizeDue();
      } else if (job.kind === 'PRUNE') {
        await this.pruneBelowWatermark();
      }

      this.sql.exec(
        `UPDATE jobs SET due_at_ms = ?, attempts = 0, last_error = NULL WHERE name = ?`,
        this.nextDueAt(job.kind),
        job.name,
      );
    } catch (err) {
      /**
       * A failed job is RETRIED with backoff, up to a bound. Past the bound it
       * is rescheduled at the normal cadence rather than retried forever, so a
       * permanent provider failure cannot turn into an infinite alarm loop.
       */
      const attempts = job.attempts + 1;
      const giveUp = attempts >= MAX_JOB_ATTEMPTS;

      this.sql.exec(
        `UPDATE jobs SET due_at_ms = ?, attempts = ?, last_error = ? WHERE name = ?`,
        giveUp
          ? this.nextDueAt(job.kind)
          : Date.now() + Math.min(60_000 * 2 ** attempts, 30 * 60_000),
        attempts,
        String(err).slice(0, 300),
        job.name,
      );
    }
  }

  private nextDueAt(kind: JobKind): number {
    const now = Date.now();
    switch (kind) {
      case 'INGEST':
        return now + INGEST_INTERVAL_MS;
      case 'FINALIZE':
        return now + FINALIZE_INTERVAL_MS;
      case 'PRUNE':
        return now + PRUNE_INTERVAL_MS;
      default:
        return now + PRUNE_INTERVAL_MS;
    }
  }

  /** Arms the single alarm for the earliest due job. */
  private async armNext(): Promise<void> {
    const due = sqlScalar(
      this.sql,
      `SELECT MIN(due_at_ms) AS due FROM jobs WHERE due_at_ms > ?`,
      Date.now(),
    );

    if (due === null) {
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, due));
  }

  /* ---------------------------------------------------------------- */
  /* Ingestion                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Instruments this object owns: subscribed instruments plus a warm floor.
   *
   * The subscription table is the primary source — a user watching a market
   * nobody else watches still gets it ingested. `DEFAULT_INSTRUMENTS` for this
   * partition is added so a cold object is not idle before the first
   * subscription arrives.
   */
  private async instrumentsFor(_kind: JobKind): Promise<string[]> {
    const rows = sqlAll<{ instrument: string } & Record<string, SqlValue>>(
      this.sql,
      `SELECT DISTINCT instrument FROM subscriptions ORDER BY instrument LIMIT 200`,
    );

    const merged = new Set<string>();
    for (const instrument of DEFAULT_INSTRUMENTS[this.partition] ?? []) {
      merged.add(instrument);
    }
    for (const row of rows) {
      merged.add(row.instrument);
    }

    return [...merged].slice(0, 200);
  }

  /**
   * Fetches and stores one-minute candles for a bounded set of instruments.
   *
   * BiQuote needs no API key, so this is safe to run from the Worker — which is
   * the whole reason market ingestion can live here instead of on Vercel, where
   * a serverless function would be killed between requests.
   *
   * Returns only the instruments that actually produced new data, plus any
   * freshness STATE CHANGE, so the caller can publish events for those and
   * nothing else.
   */
  private async ingestInstruments(instruments: string[]): Promise<{
    updated: string[];
    transition: Array<{ instrument: string; recovered: boolean }>;
  }> {
    const limit = Math.min(instruments.length, MAX_INGEST_INSTRUMENTS);
    const updated: string[] = [];
    const transition: Array<{ instrument: string; recovered: boolean }> = [];

    for (let i = 0; i < limit; i += 1) {
      const instrument = instruments[i];
const before = await this.isStale(instrument, Date.now());

      try {
        const bars = await fetchCandles(instrument, '1m', 180);
        if (bars.length > 0) {
          const newestWritten = this.upsertCandles(instrument, bars);
          if (newestWritten !== null) updated.push(instrument);
        }
        await this.bumpSuccess(instrument);
      } catch {
        /**
         * One failing instrument must not abort the batch. The freshness
         * counters record the gap and the next job retries it.
         */
        await this.bumpFailure(instrument);
        continue;
      }

      /**
       * A gap is only EVENTFUL when it CHANGES state. Emitting DATA_STALE on
       * every pass while already stale would wake every subscriber once a
       * minute for no new information, and the app spends a deterministic
       * tracker evaluation on each one.
       */
      const after = await this.isStale(instrument, Date.now());
      if (before !== after) {
        transition.push({ instrument, recovered: !after });
      }
    }

    return { updated, transition };
  }

  /**
   * Idempotent upsert.
   *
   * `ON CONFLICT ... DO UPDATE` with a guard on actual value change is the whole
   * idempotency story at the storage layer:
   *
   *   - the PRIMARY KEY makes a second row for the same minute impossible;
   *   - the WHERE clause means a byte-identical redelivery is a no-op, so the
   *     `revision` counter only advances for a genuine correction;
   *   - `revision` advancing is what distinguishes a late provider correction
   *     from a duplicate delivery downstream.
   */
  private upsertCandles(
    instrument: string,
    bars: Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
    }>,
  ): number | null {
    /**
     * Rows are written individually rather than as one batched statement,
     * because the Workers SQL binding API exposes parameterised exec rather
     * than a multi-row INSERT helper. The loop is bounded (180 bars per
     * instrument, 20 instruments per job) so the statement count stays low.
     */
    const now = Date.now();
    let newestWritten: number | null = null;

    for (const bar of bars) {
      const openTimeMs = Math.floor(bar.time / 60_000) * 60_000;

      // Validation at the boundary. A corrupt bar is skipped, never stored.
      if (
        !Number.isFinite(bar.open) || !Number.isFinite(bar.high) ||
        !Number.isFinite(bar.low) || !Number.isFinite(bar.close) ||
        bar.open <= 0 || bar.close <= 0 || bar.high < bar.low
      ) {
        continue;
      }

      /**
       * `rowsWritten` is 0 when the ON CONFLICT WHERE guard rejected the row —
       * a byte-identical redelivery — and positive for a genuine insert or a
       * real correction. Only a real write may advance `newestWritten`, which
       * is what stops a redundant ingestion pass from republishing an event for
       * a candle every consumer has already processed.
       */
      const { rowsWritten } = sqlRun(
        this.sql,
        `INSERT INTO candles
           (instrument, open_time_ms, open, high, low, close, volume,
            finalized, revision, received_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT (instrument, open_time_ms) DO UPDATE SET
           open   = excluded.open,
           high   = excluded.high,
           low    = excluded.low,
           close  = excluded.close,
           volume = excluded.volume,
           finalized = MAX(candles.finalized, excluded.finalized),
           revision = CASE
             WHEN candles.open   IS NOT excluded.open
               OR candles.high   IS NOT excluded.high
               OR candles.low    IS NOT excluded.low
               OR candles.close  IS NOT excluded.close
               OR candles.volume IS NOT excluded.volume
             THEN candles.revision + 1
             ELSE candles.revision
           END,
           updated_at_ms = excluded.updated_at_ms
         WHERE candles.open    IS NOT excluded.open
            OR candles.high    IS NOT excluded.high
            OR candles.low     IS NOT excluded.low
            OR candles.close   IS NOT excluded.close
            OR candles.volume  IS NOT excluded.volume
            OR candles.finalized < excluded.finalized`,
        instrument,
        openTimeMs,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        typeof bar.volume === 'number' && Number.isFinite(bar.volume) ? bar.volume : null,
        now,
        now,
      );

      if (rowsWritten > 0) {
        newestWritten =
          newestWritten === null
            ? openTimeMs
            : Math.max(newestWritten, openTimeMs);
      }
    }

    return newestWritten;
  }

  private async bumpSuccess(instrument: string): Promise<void> {
    await this.state.storage.put(`fresh:${instrument}`, {
      at: Date.now(),
      ok: true,
    });
  }

  private async bumpFailure(instrument: string): Promise<void> {
    await this.state.storage.put(`fresh:${instrument}`, {
      at: Date.now(),
      ok: false,
    });
  }

  /**
   * True when this instrument's newest stored candle is older than the staleness
   * threshold. Read from the candles table rather than KV so it cannot drift
   * from what is actually stored.
   */
  private async isStale(instrument: string, nowMs: number): Promise<boolean> {
    const newest = sqlScalar(
      this.sql,
      `SELECT MAX(open_time_ms) FROM candles WHERE instrument = ?`,
      instrument,
    );

    if (newest === null) return true;
    return nowMs - newest > STALENESS_THRESHOLD_MS;
  }

  /* ---------------------------------------------------------------- */
  /* Handlers                                                          */
  /* ---------------------------------------------------------------- */

  private async handleIngest(request: Request): Promise<Response> {
    const body = (await safeJson(request)) as { instruments?: string[] } | null;
    const instruments = Array.isArray(body?.instruments)
      ? body!.instruments.filter((i) => typeof i === 'string').slice(0, 50)
      : await this.instrumentsFor('INGEST');

    try {
      const { updated, transition } = await this.ingestInstruments(instruments);
      await this.publishEvents(updated, transition);
    } catch (err) {
      return json({ error: String(err) }, 502);
    }

    // Make the result visible immediately rather than at the next alarm.
    this.sql.exec(
      `UPDATE jobs SET due_at_ms = ?, attempts = 0, last_error = NULL WHERE name = 'ingest'`,
      Date.now() + INGEST_INTERVAL_MS,
    );
    await this.armNext();

    return json({
      ok: true,
      instruments,
      counts: await this.candleCounts(instruments),
      nextIngestAtMs: Date.now() + INGEST_INTERVAL_MS,
    });
  }

  private async handleCandles(url: URL): Promise<Response> {
    const instrument = (url.searchParams.get('instrument') ?? '').toUpperCase();
    const limit = clampInt(url.searchParams.get('limit'), 1, MAX_QUERY_ROWS, 200);
    const beforeMs = Number(url.searchParams.get('beforeMs'));

    if (!instrument) return json({ error: 'instrument required' }, 400);

    // Bounded, index-backed read. No query here can return an unbounded set.
    type CandleRow = {
      instrument: string;
      open_time_ms: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
      finalized: number;
      revision: number;
      received_at_ms: number;
      updated_at_ms: number;
    } & Record<string, SqlValue>;

    const rows: CandleRow[] =
      Number.isFinite(beforeMs) && beforeMs > 0
        ? sqlAll<CandleRow>(
            this.sql,
            `SELECT instrument, open_time_ms, open, high, low, close, volume,
                    finalized, revision, received_at_ms, updated_at_ms
               FROM candles
              WHERE instrument = ? AND open_time_ms < ?
              ORDER BY open_time_ms DESC
              LIMIT ?`,
            instrument,
            beforeMs,
            limit,
          )
        : sqlAll<CandleRow>(
            this.sql,
            `SELECT instrument, open_time_ms, open, high, low, close, volume,
                    finalized, revision, received_at_ms, updated_at_ms
               FROM candles
              WHERE instrument = ?
              ORDER BY open_time_ms DESC
              LIMIT ?`,
            instrument,
            limit,
          );

    return json({
      instrument,
      // Ascending: every consumer in this repo expects candles oldest-first.
      candles: rows.reverse(),
      truncated: rows.length >= limit,
    });
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await safeJson(request)) as
      | { subscriberId?: string; instrument?: string; eventTypes?: string[] }
      | null;

    if (!body?.subscriberId || !body?.instrument) {
      return json({ error: 'subscriberId and instrument are required' }, 400);
    }

    const instrument = body.instrument.toUpperCase();

    this.sql.exec(
      `INSERT INTO subscriptions (subscriber_id, instrument, event_types, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (subscriber_id, instrument) DO UPDATE SET
         event_types   = excluded.event_types,
         updated_at_ms = excluded.updated_at_ms`,
      body.subscriberId,
      instrument,
      Array.isArray(body.eventTypes) ? body.eventTypes.join(',') : '',
      Date.now(),
    );

    // Ensure a job exists so a brand-new subscription is served promptly.
    this.seedJobs();
    this.state.waitUntil(this.armNext());

    return json({ ok: true, instrument, subscriberId: body.subscriberId });
  }

  private async handleUnsubscribe(request: Request): Promise<Response> {
    const body = (await safeJson(request)) as
      | { subscriberId?: string; instrument?: string }
      | null;

    if (!body?.subscriberId) return json({ error: 'subscriberId required' }, 400);

    if (body.instrument) {
      this.sql.exec(
        `DELETE FROM subscriptions WHERE subscriber_id = ? AND instrument = ?`,
        body.subscriberId,
        body.instrument.toUpperCase(),
      );
    } else {
      // No instrument means "remove me from everything" — used on GOAT delete.
      this.sql.exec(
        `DELETE FROM subscriptions WHERE subscriber_id = ?`,
        body.subscriberId,
      );
    }

    return json({ ok: true });
  }

  private async handleFinalize(request: Request): Promise<Response> {
    const body = (await safeJson(request)) as { instrument?: string } | null;
    const instrument = (body?.instrument ?? '').toUpperCase();

    if (!instrument) return json({ error: 'instrument required' }, 400);

    const result = await this.finalizeInstrument(instrument);
    return json({ ok: true, ...result });
  }

  private async handleStatus(): Promise<Response> {
    const counts = sqlAll<
      { instrument: string; n: number; newest: number } & Record<string, SqlValue>
    >(
      this.sql,
      `SELECT instrument, COUNT(*) AS n, MAX(open_time_ms) AS newest
         FROM candles GROUP BY instrument`,
    );

    const jobs = sqlAll<JobRow & Record<string, SqlValue>>(
      this.sql,
      `SELECT name, kind, due_at_ms, attempts, last_error FROM jobs ORDER BY name`,
    );

    const alarm = await this.state.storage.getAlarm();

    return json({
      partition: this.partition,
      instruments: counts.map((row) => ({
        instrument: row.instrument,
        candles: Number(row.n),
        newestCandleOpenTimeMs: row.newest === null ? null : Number(row.newest),
      })),
      subscriptions:
        sqlScalar(this.sql, `SELECT COUNT(*) FROM subscriptions`) ?? 0,
      sessionSummaries:
        sqlScalar(this.sql, `SELECT COUNT(*) FROM session_summaries`) ?? 0,
      levels: sqlScalar(this.sql, `SELECT COUNT(*) FROM levels`) ?? 0,
      candles: sqlScalar(this.sql, `SELECT COUNT(*) FROM candles`) ?? 0,
      jobs,
      /**
       * The real armed time. It used to be hardcoded null, so an operator could
       * not tell a healthy queue from a stalled one.
       */
      armedFor: alarm,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Finalization and pruning (SQL-native)                             */
  /* ---------------------------------------------------------------- */

  /**
   * Summarizes a closed session and prunes its minutes.
   *
   * This is the durable mirror of `SessionFinalizer`, and it enforces the same
   * invariant: the summary row is written and CONFIRMED inside the same
   * transaction as the watermark advance, and the DELETE only runs afterwards
   * and only below that watermark. A failure anywhere before the delete leaves
   * every candle intact.
   */
  private async finalizeInstrument(instrument: string): Promise<{
    outcome: string;
    pruned: number;
    candles: number;
    summaryId: string | null;
  }> {
    type SummaryRow = { oldest: number | null; newest: number | null } & Record<
      string,
      SqlValue
    >;
    type AggregateRow = {
      n: number;
      o: number;
      h: number;
      l: number;
      newest_ms: number | null;
      oldest_ms: number | null;
    } & Record<string, SqlValue>;

    const session = sqlFirst<SummaryRow>(
      this.sql,
      `SELECT MIN(closes_at_ms) AS oldest, MAX(closes_at_ms) AS newest
         FROM session_summaries WHERE instrument = ?`,
      instrument,
    );

    // No summary yet: nothing has been finalized, so nothing may be deleted.
    if (session?.newest === null || session?.newest === undefined) {
      return {
        outcome: 'SKIPPED_NO_WATERMARK',
        pruned: 0,
        candles: 0,
        summaryId: null,
      };
    }

    const watermark = Number(session.newest);

    const agg = sqlFirst<AggregateRow>(
      this.sql,
      `SELECT COUNT(*)          AS n,
              MIN(open)          AS o,
              MAX(high)          AS h,
              MIN(low)           AS l,
              MAX(open_time_ms)  AS newest_ms,
              MIN(open_time_ms)  AS oldest_ms
         FROM candles
        WHERE instrument = ? AND open_time_ms < ?`,
      instrument,
      watermark,
    );

    if (!agg || Number(agg.n) === 0) {
      return {
        outcome: 'NOTHING_TO_FINALIZE',
        pruned: 0,
        candles: 0,
        summaryId: null,
      };
    }

    const last = sqlFirst<{ close: number } & Record<string, SqlValue>>(
      this.sql,
      `SELECT close FROM candles
        WHERE instrument = ? AND open_time_ms < ?
        ORDER BY open_time_ms DESC LIMIT 1`,
      instrument,
      watermark,
    );

    const newestMs = Number(agg.newest_ms);
    const summaryId = `${instrument}#${newestMs}`;

    const summary = {
      id: summaryId,
      instrument,
      sessionDate: new Date(newestMs).toISOString().slice(0, 10),
      opensAtMs: Number(agg.oldest_ms),
      closesAtMs: watermark,
      open: Number(agg.o),
      high: Number(agg.h),
      low: Number(agg.l),
      close: last ? Number(last.close) : Number(agg.o),
      range: Number(agg.h) - Number(agg.l),
      candleCount: Number(agg.n),
      computedAtMs: Date.now(),
      schemaVersion: 1,
    };

    /**
     * Write the summary, then verify it read back, and only then delete.
     *
     * The verification is a real read. A write that reports success without
     * being durable would otherwise be followed by an irreversible delete, and
     * the watermark would advance over candles nothing had summarized.
     */
    this.sql.exec(
      `INSERT INTO session_summaries
         (id, instrument, session_date, closes_at_ms, payload, finalized_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         payload        = excluded.payload,
         finalized_at_ms = excluded.finalized_at_ms`,
      summary.id,
      summary.instrument,
      summary.sessionDate,
      summary.closesAtMs,
      JSON.stringify(summary),
      Date.now(),
    );

    const verified = sqlFirst<{ id: string } & Record<string, SqlValue>>(
      this.sql,
      `SELECT id FROM session_summaries WHERE id = ?`,
      summary.id,
    );

    if (!verified) {
      return {
        outcome: 'FAILED_VERIFICATION',
        pruned: 0,
        candles: Number(agg.n),
        summaryId,
      };
    }

    const pruned = this.pruneInstrument(instrument, watermark);

    return {
      outcome: 'FINALIZED',
      pruned,
      candles: Number(agg.n),
      summaryId,
    };
  }

  private async candleCounts(instruments: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const instrument of instruments) {
      counts[instrument] =
        sqlScalar(
          this.sql,
          `SELECT COUNT(*) FROM candles WHERE instrument = ?`,
          instrument,
        ) ?? 0;
    }
    return counts;
  }

  private authorised(request: Request): boolean {
    const provided = request.headers.get('authorization') ?? '';
    if (!provided.startsWith('Bearer ')) return false;

    const token = provided.slice(7).trim();
    const accepted = [this.env.MARKET_DATA_SECRET, this.env.SCHEDULER_SECRET]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    return accepted.some((secret) => timingSafeEqual(token, secret));
  }

  /* ---------------------------------------------------------------- */
  /* Event publication                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * POSTs market events to the application.
   *
   * THE MISSING LINK.
   *
   * The Worker ingested candles and the app had an authenticated
   * `/api/internal/market-event` endpoint, but nothing ever called it. The
   * canonical store therefore grew while every consumer stayed blind, and the
   * only way a GOAT woke was its own scheduled alarm.
   *
   * Failure is non-fatal and deliberately so: events are a NOTIFICATION, not
   * the data itself. The app re-reads candles from this object through
   * `/candles`, so a dropped event is a missed wake-up that the next ingestion
   * pass recovers, never a lost or wrong price.
   */
  private async publishEvents(
    updated: string[],
    transition: Array<{ instrument: string; recovered: boolean }>,
  ): Promise<number> {
    if (this.env.APP_ORIGIN) {
      for (const instrument of updated) {
        const newest = sqlScalar(
          this.sql,
          `SELECT MAX(open_time_ms) FROM candles WHERE instrument = ?`,
          instrument,
        );
        if (newest === null) continue;
        await this.postEvent({
          type: 'CANDLE_FINALIZED',
          instrument,
          candleOpenTimeMs: newest,
          finalized: true,
        });
      }

      for (const change of transition) {
        await this.postEvent({
          type: change.recovered ? 'DATA_RECOVERED' : 'DATA_STALE',
          instrument: change.instrument,
          candleOpenTimeMs: null,
          finalized: false,
        });
      }
    }

    return updated.length + transition.length;
  }

  /**
   * Builds and delivers ONE event.
   *
   * The id is RECOMPUTED here with the same rule the app validates against
   * (`partition:type:instrument:candleOpenTimeMs`), because the app refuses any
   * event whose id does not match its payload — which would silently drop
   * every event if the two disagreed.
   */
  private async postEvent(input: {
    type: 'CANDLE_FINALIZED' | 'DATA_STALE' | 'DATA_RECOVERED' | 'SESSION_FINALIZED';
    instrument: string;
    candleOpenTimeMs: number | null;
    finalized: boolean;
  }): Promise<void> {
    const instrument = input.instrument.trim().toUpperCase();
    const createdAtMs = Date.now();

    const event = {
      eventId: [
        this.partition,
        input.type,
        instrument,
        input.candleOpenTimeMs === null ? 'na' : String(input.candleOpenTimeMs),
      ].join(':'),
      eventIdVersion: 1 as const,
      type: input.type,
      partition: this.partition,
      instrument,
      candleOpenTimeMs: input.candleOpenTimeMs,
      finalized: input.finalized,
      reference:
        input.candleOpenTimeMs === null
          ? null
          : `${instrument}#${input.candleOpenTimeMs}`,
      context: {
        lagSeconds:
          input.candleOpenTimeMs === null
            ? undefined
            : Math.max(0, Math.round((createdAtMs - input.candleOpenTimeMs - 60_000) / 1000)),
        dataQuality: 'OK' as const,
      },
      schemaVersion: 1 as const,
      createdAtMs,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EVENT_POST_TIMEOUT_MS);

    try {
      await fetch(
        `${this.env.APP_ORIGIN.replace(/\/+$/, '')}/api/internal/market-event`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Scheduler-Secret': this.env.SCHEDULER_SECRET,
          },
          body: JSON.stringify(event),
        },
      );
    } catch {
      // See the method doc: a dropped notification is recoverable, not fatal.
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scheduled finalization and pruning                                */
  /* ---------------------------------------------------------------- */

  /**
   * Finalizes every instrument that has a due summary.
   *
   * Runs on the FINALIZE cadence. Bounded to a fixed number of instruments per
   * pass so one alarm stays short.
   */
  private async finalizeDue(): Promise<number> {
    const instruments = sqlAll<{ instrument: string } & Record<string, SqlValue>>(
      this.sql,
      `SELECT DISTINCT instrument FROM candles ORDER BY instrument LIMIT ?`,
      MAX_FINALIZE_INSTRUMENTS,
    );

    let finalized = 0;
    for (const row of instruments) {
      const result = await this.finalizeInstrument(row.instrument);
      if (result.summaryId) finalized += 1;
    }
    return finalized;
  }

  /**
   * Bounded delete strictly below each instrument's finalized watermark.
   *
   * Never deletes above the watermark: an un-finalized candle is still the only
   * record of a minute the provider may still correct.
   */
  private async pruneBelowWatermark(): Promise<number> {
    const watermarks = sqlAll<
      { instrument: string; watermark: number } & Record<string, SqlValue>
    >(
      this.sql,
      `SELECT instrument, MAX(closes_at_ms) AS watermark
         FROM session_summaries
        GROUP BY instrument
        LIMIT ?`,
      MAX_FINALIZE_INSTRUMENTS,
    );

    let pruned = 0;
    for (const row of watermarks) {
      const watermark = Number(row.watermark);
      if (!Number.isFinite(watermark)) continue;
      pruned += this.pruneInstrument(row.instrument, watermark);
    }
    return pruned;
  }

  private pruneInstrument(instrument: string, watermark: number): number {
    const doomed = sqlAll<{ open_time_ms: number } & Record<string, SqlValue>>(
      this.sql,
      `SELECT open_time_ms FROM candles
        WHERE instrument = ? AND open_time_ms < ?
        ORDER BY open_time_ms ASC
        LIMIT ?`,
      instrument,
      watermark,
      PRUNE_BATCH,
    );

    if (doomed.length === 0) return 0;

    /**
     * `transactionSync`, not `transaction`.
     *
     * The delete is a synchronous `sql.exec()` sequence, and that is exactly
     * what `transactionSync` is for: the whole batch commits atomically or none
     * of it does, so a crash mid-delete cannot leave a half-pruned range. The
     * previous code wrapped these in an `async` `storage.transaction()`
     * without awaiting it, so the deletes escaped the transaction entirely.
     */
    this.state.storage.transactionSync(() => {
      for (const row of doomed) {
        this.sql.exec(
          `DELETE FROM candles WHERE instrument = ? AND open_time_ms = ?`,
          instrument,
          Number(row.open_time_ms),
        );
      }
    });

    return doomed.length;
  }
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

const BIQUOTE_BASE = 'https://biquote.io/api';
const FETCH_TIMEOUT_MS = 8_000;

const NATIVE_ALIASES: Record<string, string> = {
  'EUR/USD': 'EURUSD', 'GBP/USD': 'GBPUSD', 'USD/JPY': 'USDJPY',
  'AUD/USD': 'AUDUSD', 'USD/CAD': 'USDCAD', 'USD/CHF': 'USDCHF',
  'NZD/USD': 'NZDUSD', 'EUR/GBP': 'EURGBP', 'EUR/JPY': 'EURJPY',
  'GBP/JPY': 'GBPJPY', 'XAU/USD': 'XAUUSD', 'XAG/USD': 'XAGUSD',
  WTI: 'XTIUSD', BRENT: 'BRENT', US500: 'US500', US100: 'USTEC',
  US30: 'US30', GER40: 'DE30', 'BTC/USD': 'BTCUSD', 'ETH/USD': 'ETHUSD',
};

function nativeSymbol(symbol: string): string {
  const key = symbol.trim().toUpperCase();
  return NATIVE_ALIASES[key] ?? key.replace('/', '');
}

/**
 * Bounded provider fetch with a timeout.
 *
 * `AbortController` is available on the Workers runtime, so the timeout is real
 * rather than a promise that resolves eventually.
 */
async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<
  Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }>
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${BIQUOTE_BASE}/${nativeSymbol(symbol)}/ohlc?interval=${encodeURIComponent(interval)}&limit=${limit}`,
      { signal: controller.signal, headers: { Accept: 'application/json' } },
    );

    if (!response.ok) {
      throw new Error(`BiQuote HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      bars?: Array<{
        openTime?: string;
        open?: number;
        high?: number;
        low?: number;
        close?: number;
        volume?: number;
        tickVolume?: number;
      }>;
    };

    const bars = Array.isArray(payload.bars) ? payload.bars : [];

    // Newest-first from the provider; this runtime stores and reads ascending.
    return bars
      .map((bar) => ({
        time: Date.parse(bar.openTime ?? '') || 0,
        open: bar.open ?? 0,
        high: bar.high ?? 0,
        low: bar.low ?? 0,
        close: bar.close ?? 0,
        // tickVolume is the real activity signal on this CFD feed; `volume` is
        // always 0 and must not be mistaken for a measurement.
        volume: bar.tickVolume ?? bar.volume,
      }))
      .filter((bar) => bar.time > 0 && bar.close > 0)
      .reverse();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Constant-time string comparison.
 *
 * A secret compared with `===` leaks its length and its matching prefix
 * through timing. Cheap to do properly and it removes the question entirely.
 * Length is compared first, which is safe: the length of a bearer token is not
 * the secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

import { GoatScheduler, type Env as SchedulerEnv } from './scheduler-worker';

export { GoatScheduler, GoatSchedulerDO } from './scheduler-worker';
export type { Env as SchedulerEnv } from './scheduler-worker';

type WorkerEnv = MarketDataEnv &
  SchedulerEnv & {
    NAMESPACE: DurableObjectNamespace;
    MARKET_DATA: DurableObjectNamespace;
  };

/**
 * Worker-wide request authentication.
 *
 * Accepts the scheduler secret OR the market-data secret. Both surfaces are
 * independently rotatable, and neither should accept the other's value.
 * Compared in constant time.
 */
function workerAuthorised(
  request: Request,
  env: MarketDataEnv & SchedulerEnv,
): boolean {
  const provided = request.headers.get('authorization') ?? '';
  if (!provided.startsWith('Bearer ')) return false;

  const token = provided.slice(7).trim();
  const accepted = [env.SCHEDULER_SECRET, env.MARKET_DATA_SECRET].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return accepted.some((secret) => timingSafeEqual(token, secret));
}

/** Health check. Deliberately unauthenticated so uptime needs no credential. */
function handlePublicHealth(env: WorkerEnv): Response {
  return json({
    ok: true,
    service: 'siggoat-scheduler',
    time: new Date().toISOString(),
    appOriginConfigured: Boolean(env.APP_ORIGIN),
    schedulerSecretConfigured: Boolean(env.SCHEDULER_SECRET),
    marketDataSecretConfigured: Boolean(env.MARKET_DATA_SECRET),
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    /**
     * Unauthenticated health probe.
     *
     * Reports only whether configuration is PRESENT, never its value. This is
     * what makes "is the Worker alive?" answerable without handing a credential
     * to a monitor.
     */
    if (url.pathname === '/health') {
      return handlePublicHealth(env);
    }

    if (!workerAuthorised(request, env)) {
      return json({ error: 'unauthorised' }, 401);
    }

    /**
     * Market-data objects are addressed by PARTITION, so every symbol in a
     * class routes to one object and shares one ingestion loop, one alarm and
     * one canonical store.
     */
    const marketMatch = url.pathname.match(
      /^\/market\/(fx|metals|energy|index|crypto)(\/[a-z]+)?$/i,
    );

    if (marketMatch) {
      const partition = marketMatch[1].toUpperCase();
      const action = marketMatch[2] ?? '/status';
      const stub = env.MARKET_DATA.get(env.MARKET_DATA.idFromName(partition));

      /**
       * The partition travels to the object as a header. A Durable Object
       * cannot read back its own name — `idFromName` is a one-way hash — and
       * the object needs it to choose its warm instrument floor and to prefix
       * every event id it publishes.
       *
       * Query strings are preserved for reads; only the body is carried for
       * writes, and both are forwarded with the caller's own method so a GET is
       * not silently turned into a bodyless POST.
       */
      const headers = new Headers(request.headers);
      headers.set('x-signalgoat-partition', partition);

      const body = request.method === 'GET' ? undefined : await request.text();

      return stub.fetch(
        new Request(`https://do${action}${url.search}`, {
          method: request.method,
          headers,
          body: body && body.length > 0 ? body : undefined,
        }),
      );
    }

    /**
     * Per-GOAT scheduling keeps its own namespace and its own router, exactly
     * as before. One Worker, two unrelated DO classes, two independent
     * lifecycles.
     */
    if (url.pathname.startsWith('/do/goats/')) {
      return GoatScheduler.fetch(request, env);
    }

    return json({ error: 'not_found' }, 404);
  },

  /**
   * CRON RECONCILIATION
   * ===================
   *
   * wrangler.toml declares a 15-minute cron, but the Worker exported no
   * `scheduled()` handler — so the trigger fired into nothing and the
   * reconciliation the config comment described did not exist.
   *
   * WHY IT IS NEEDED
   *
   * `GoatSchedulerDO.alarm()` deliberately does NOT re-arm after a failed
   * delivery, on the reasoning that a hot retry loop against a down app is
   * worse than waiting. That reasoning is right, but it needs a second half:
   * something must eventually re-arm, or a single transient failure during an
   * app deploy silently stops that GOAT's schedule FOREVER. This handler is
   * that something.
   *
   * A Durable Object namespace cannot be enumerated, so this does not walk the
   * namespace. It asks the application to re-publish every GOAT it owns; the
   * scheduler client already treats a re-sync of an unchanged generation as a
   * no-op, so this is cheap and idempotent.
   */
  async scheduled(
    _controller: ScheduledControllerLike,
    env: WorkerEnv,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    if (!env.APP_ORIGIN || !env.SCHEDULER_SECRET) {
      // Not configured: nothing to reconcile, and nothing is logged so a
      // half-configured Worker does not fill its logs with the same line.
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          const response = await fetch(
            `${env.APP_ORIGIN.replace(/\/+$/, '')}/api/internal/reconcile`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Scheduler-Secret': env.SCHEDULER_SECRET,
              },
              body: JSON.stringify({ at: Date.now() }),
            },
          );

          if (!response.ok) {
            console.warn(
              `[cron] reconcile returned HTTP ${response.status}`,
            );
          }
        } catch (err) {
          // A failed reconciliation is not fatal: the next tick tries again.
          console.warn('[cron] reconcile failed:', String(err).slice(0, 200));
        }
      })(),
    );
  },
};
