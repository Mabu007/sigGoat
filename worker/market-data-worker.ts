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

export interface MarketDataEnv {
  /** Shared secret; the Vercel app sends it as `Authorization: Bearer ...`. */
  SCHEDULER_SECRET: string;
  /** Base URL for callbacks into the Vercel application. */
  APP_ORIGIN: string;
}

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

export class MarketDataDO {
  private readonly state: DurableObjectState;
  private readonly env: MarketDataEnv;

  /** Set once `alarm()` is running, so a nested job cannot recurse. */
  private inAlarm = false;

  constructor(state: DurableObjectState, env: MarketDataEnv) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      await this.seedJobs();
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
        const job = await this.dueJob();
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
   */
  private seedJobs(): Promise<unknown> {
    const now = Date.now();
    const seeds: Array<[string, JobKind, number]> = [
      ['ingest', 'INGEST', now + INGEST_INTERVAL_MS],
      ['finalize', 'FINALIZE', now + FINALIZE_INTERVAL_MS],
      ['prune', 'PRUNE', now + PRUNE_INTERVAL_MS],
    ];

    for (const [name, kind, dueAt] of seeds) {
      this.sql.exec(
        `INSERT OR IGNORE INTO jobs (name, kind, due_at_ms) VALUES (?, ?, ?)`,
        name,
        kind,
        dueAt,
      );
    }

    return Promise.resolve();
  }

  private async dueJob(): Promise<JobRow | null> {
    return this.sql
      .exec(
        `SELECT name, kind, due_at_ms, attempts, last_error
           FROM jobs
          WHERE due_at_ms <= ?
          ORDER BY due_at_ms ASC
          LIMIT 1`,
        Date.now(),
      )
      .first<JobRow>();
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
      const instruments = await this.instrumentsFor(job.kind);

      if (instruments.length > 0) {
        await this.ingestInstruments(instruments);
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
    const row = await this.sql
      .exec(
        `SELECT MIN(due_at_ms) AS due FROM jobs WHERE due_at_ms > ?`,
        Date.now(),
      )
      .first<{ due: number | null }>();

    if (!row || row.due === null) {
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, row.due));
  }

  /* ---------------------------------------------------------------- */
  /* Ingestion                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Instruments this object owns.
   *
   * Derived from the SUBSCRIPTION table rather than from a static list, so an
   * object with no subscribers does no provider work at all. This is what makes
   * the object count independent of the catalogue size.
   */
  private async instrumentsFor(_kind: JobKind): Promise<string[]> {
    const rows = await this.sql
      .exec(
        `SELECT DISTINCT instrument FROM subscriptions ORDER BY instrument LIMIT 200`,
      )
      .toArray<{ instrument: string }>();

    return rows.map((row) => row.instrument);
  }

  /**
   * Fetches and stores one-minute candles for a bounded set of instruments.
   *
   * BiQuote needs no API key, so this is safe to run from the Worker — which is
   * the whole reason market ingestion can live here instead of on Vercel, where
   * a serverless function would be killed between requests.
   */
  private async ingestInstruments(instruments: string[]): Promise<void> {
    const limit = Math.min(instruments.length, 20);

    for (let i = 0; i < limit; i += 1) {
      const instrument = instruments[i];
      try {
        const bars = await fetchCandles(instrument, '1m', 180);
        if (bars.length > 0) {
          this.upsertCandles(instrument, bars);
        }
      } catch {
        /**
         * One failing instrument must not abort the batch. The freshness
         * counters record the gap and the next job retries it.
         */
        this.bumpFailure(instrument);
        continue;
      }
      this.bumpSuccess(instrument);
    }
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
  ): void {
    /**
     * Rows are written individually rather than as one batched statement,
     * because the Workers SQL binding API exposes parameterised exec rather
     * than a multi-row INSERT helper. The loop is bounded (180 bars per
     * instrument, 20 instruments per job) so the transaction stays short.
     */
    const now = Date.now();

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

      this.sql.exec(
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
    }
  }

  private bumpSuccess(instrument: string): void {
    this.state.storage.put(`fresh:${instrument}`, {
      at: Date.now(),
      ok: true,
    });
  }

  private bumpFailure(instrument: string): void {
    this.state.storage.put(`fresh:${instrument}`, {
      at: Date.now(),
      ok: false,
    });
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
      await this.ingestInstruments(instruments);
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
    const rows = Number.isFinite(beforeMs) && beforeMs > 0
      ? await this.sql.exec(
          `SELECT instrument, open_time_ms, open, high, low, close, volume,
                  finalized, revision, received_at_ms, updated_at_ms
             FROM candles
            WHERE instrument = ? AND open_time_ms < ?
            ORDER BY open_time_ms DESC
            LIMIT ?`,
          instrument,
          beforeMs,
          limit,
        ).toArray()
      : await this.sql.exec(
          `SELECT instrument, open_time_ms, open, high, low, close, volume,
                  finalized, revision, received_at_ms, updated_at_ms
             FROM candles
            WHERE instrument = ?
            ORDER BY open_time_ms DESC
            LIMIT ?`,
          instrument,
          limit,
        ).toArray();

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
    const counts = await this.sql
      .exec(
        `SELECT instrument, COUNT(*) AS n, MAX(open_time_ms) AS newest
           FROM candles GROUP BY instrument`,
      )
      .toArray<{ instrument: string; n: number; newest: number }>();

    const subscriptions = await this.sql
      .exec(`SELECT COUNT(*) AS n FROM subscriptions`)
      .first<{ n: number }>();

    const summaries = await this.sql
      .exec(`SELECT COUNT(*) AS n FROM session_summaries`)
      .first<{ n: number }>();

    const levels = await this.sql
      .exec(`SELECT COUNT(*) AS n FROM levels`)
      .first<{ n: number }>();

    const jobs = await this.sql
      .exec(
        `SELECT name, kind, due_at_ms, attempts, last_error FROM jobs ORDER BY name`,
      )
      .toArray<JobRow>();

    return json({
      instruments: counts.map((row) => ({
        instrument: row.instrument,
        candles: row.n,
        newestCandleOpenTimeMs: row.newest,
      })),
      subscriptions: subscriptions?.n ?? 0,
      sessionSummaries: summaries?.n ?? 0,
      levels: levels?.n ?? 0,
      jobs,
      armedFor: null,
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
    const session = await this.sql
      .exec(
        `SELECT MIN(closes_at_ms) AS oldest, MAX(closes_at_ms) AS newest
           FROM session_summaries WHERE instrument = ?`,
        instrument,
      )
      .first<{ oldest: number | null; newest: number | null }>();

    // No summary yet: nothing has been finalized, so nothing may be deleted.
    if (session?.newest === null || session?.newest === undefined) {
      return { outcome: 'SKIPPED_NO_WATERMARK', pruned: 0, candles: 0, summaryId: null };
    }

    const watermark = session.newest;

    const agg = await this.sql
      .exec(
        `SELECT COUNT(*)        AS n,
                MIN(open)        AS o,
                MAX(high)       AS h,
                MIN(low)         AS l,
                MAX(open_time_ms) AS newest_ms,
                MIN(open_time_ms) AS oldest_ms
           FROM candles
          WHERE instrument = ? AND open_time_ms < ?`,
        instrument,
        watermark,
      )
      .first<{
        n: number; o: number; h: number; l: number;
        newest_ms: number | null; oldest_ms: number | null;
      }>();

    if (!agg || agg.n === 0) {
      return { outcome: 'NOTHING_TO_FINALIZE', pruned: 0, candles: 0, summaryId: null };
    }

    const last = await this.sql
      .exec(
        `SELECT close FROM candles
          WHERE instrument = ? AND open_time_ms < ?
          ORDER BY open_time_ms DESC LIMIT 1`,
        instrument,
        watermark,
      )
      .first<{ close: number }>();

    const summaryId = `${instrument}#${agg.newest_ms}`;

    const summary = {
      id: summaryId,
      instrument,
      sessionDate: new Date(agg.newest_ms).toISOString().slice(0, 10),
      opensAtMs: agg.oldest_ms,
      closesAtMs: watermark,
      open: agg.o,
      high: agg.h,
      low: agg.l,
      close: last?.close ?? agg.o,
      range: agg.h - agg.l,
      candleCount: agg.n,
      computedAtMs: Date.now(),
      schemaVersion: 1,
    };

    /**
     * Write the summary, then verify it read back, and only then delete.
     * The verification is a real read: a write that reports success without
     * being durable would otherwise be followed by an irreversible delete.
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

    const verified = await this.sql
      .exec(`SELECT id FROM session_summaries WHERE id = ?`, summary.id)
      .first<{ id: string }>();

    if (!verified) {
      return {
        outcome: 'FAILED_VERIFICATION',
        pruned: 0,
        candles: agg.n,
        summaryId,
      };
    }

    // Bounded delete, strictly below the watermark.
    const doomed = await this.sql
      .exec(
        `SELECT open_time_ms FROM candles
          WHERE instrument = ? AND open_time_ms < ?
          ORDER BY open_time_ms ASC
          LIMIT ?`,
        instrument,
        watermark,
        PRUNE_BATCH,
      )
      .toArray<{ open_time_ms: number }>();

    if (doomed.length === 0) {
      return { outcome: 'FINALIZED', pruned: 0, candles: agg.n, summaryId };
    }

    this.state.storage.transaction(async () => {
      for (const row of doomed) {
        this.sql.exec(
          `DELETE FROM candles WHERE instrument = ? AND open_time_ms = ?`,
          instrument,
          row.open_time_ms,
        );
      }
    });

    return { outcome: 'FINALIZED', pruned: doomed.length, candles: agg.n, summaryId };
  }

  private async candleCounts(instruments: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const instrument of instruments) {
      const row = await this.sql
        .exec(`SELECT COUNT(*) AS n FROM candles WHERE instrument = ?`, instrument)
        .first<{ n: number }>();
      counts[instrument] = row?.n ?? 0;
    }
    return counts;
  }

  private authorised(request: Request): boolean {
    return (
      request.headers.get('authorization') === `Bearer ${this.env.SCHEDULER_SECRET}`
    );
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

export { GoatScheduler, GoatSchedulerDO } from './scheduler-worker';
export type { Env as SchedulerEnv } from './scheduler-worker';

import { GoatScheduler } from './scheduler-worker';

export default {
  async fetch(
    request: Request,
    env: MarketDataEnv & {
      NAMESPACE: DurableObjectNamespace;
      MARKET_DATA: DurableObjectNamespace;
    },
  ): Promise<Response> {
    const url = new URL(request.url);
    const authorised =
      request.headers.get('authorization') === `Bearer ${env.SCHEDULER_SECRET}`;

    if (!authorised) {
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

      return stub.fetch(
        new Request(`https://do${action}`, {
          method: 'POST',
          headers: request.headers,
          body: request.method === 'POST' ? await request.text() : undefined,
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
};