/**
 * CANONICAL CANDLE REPOSITORIES
 * ==============================
 * The storage ports for one-minute candles and the durable facts derived from
 * them.
 *
 * These are INTERFACES, deliberately, because the same contract has to be
 * satisfied by three very different backends:
 *
 *   - `MemoryCandleRepository` — tests, and the local long-lived process.
 *   - `FileCandleRepository`    — local/self-hosted persistence.
 *   - `MarketDataDO`            — Cloudflare Durable Object, SQLite-backed.
 *
 * Nothing above this file knows which one it is talking to, so the finalizer,
 * the ingestion service and the tracker evaluator are written once.
 *
 * QUERY SHAPE — DESIGNED FOR THE ACTUAL CALLERS
 *
 * Every read here is either a bounded `range` (finalizing one session),
 * a bounded `recent` (indicator warmup), or a single `latestAtOrBefore`
 * (freshness). There is deliberately NO "return everything" method, because
 * the one thing this whole module exists to prevent is a growing history being
 * loaded into memory.
 *
 * THE UNIQUENESS CONTRACT
 *
 * `upsertMany` is idempotent on `(instrument, openTimeMs)`. That pair is the
 * primary key in every implementation. Re-delivering the same candle is a no-op;
 * re-delivering a CORRECTED candle advances `revision` rather than creating a
 * second row. Two concurrent finalization runs therefore cannot produce two
 * candles for one minute.
 */

import type { CandleRecord, UpsertOutcome } from './CandleRecord';
import type { LevelRecord, MarketRegimeRecord, SwingPoint } from './MarketStructure';
import type { SessionSummary } from './SessionSummary';

export interface CandleRepository {
  /**
   * Idempotent write. Never throws for a bad row — a rejected candle is
   * counted in `rejected`, not lost. Throws only if the whole write failed,
   * and then the caller must NOT prune.
   */
  upsertMany(records: readonly CandleRecord[]): Promise<UpsertOutcome>;

  /** Ascending candles in [fromMs, toMs), bounded by `limit`. */
  range(
    instrument: string,
    fromMs: number,
    toMs: number,
    limit?: number,
  ): Promise<CandleRecord[]>;

  /**
   * The `count` most recent candles at or before `beforeMs`, ASCENDING.
   *
   * This is the indicator-warmup read. `count` exists so an EMA(200) asks for
   * what it needs instead of the store deciding how much history is "enough".
   */
  recent(
    instrument: string,
    count: number,
    beforeMs?: number,
  ): Promise<CandleRecord[]>;

  /** The single newest candle at or before `beforeMs`. */
  latestAtOrBefore(
    instrument: string,
    beforeMs?: number,
  ): Promise<CandleRecord | null>;

  /** Total stored candles for an instrument. Used to observe growth. */
  count(instrument: string): Promise<number>;

  /**
   * Deletes at most `limit` candles with `openTimeMs < beforeMs`.
   *
   * Returns the number actually deleted. Callers MUST have persisted the
   * derived facts first; see `SessionFinalizer` for the enforced ordering.
   */
  deleteBefore(
    instrument: string,
    beforeMs: number,
    limit: number,
  ): Promise<number>;
}

export interface SessionSummaryRepository {
  /**
   * Idempotent on `summary.id`, which embeds the session date. Re-running
   * finalization MERGES rather than creating a second summary for one session.
   */
  save(summary: SessionSummary): Promise<void>;
  get(id: string): Promise<SessionSummary | null>;
  /** Newest first. */
  list(instrument: string, limit?: number): Promise<SessionSummary[]>;
  /**
   * The watermark finalization has reached: the newest session that is fully
   * summarized. Pruning is driven ONLY by this, never by wall-clock age.
   */
  finalizedThroughMs(instrument: string): Promise<number | null>;
  count(instrument: string): Promise<number>;
}

export interface StructureRepository {
  /** Idempotent on swing id. */
  saveSwings(swings: readonly SwingPoint[]): Promise<void>;
  listSwings(instrument: string, limit?: number): Promise<SwingPoint[]>;
  /** Idempotent on level id. */
  saveLevels(levels: readonly LevelRecord[]): Promise<void>;
  listLevels(instrument: string, limit?: number): Promise<LevelRecord[]>;
  saveRegime(regime: MarketRegimeRecord): Promise<void>;
  latestRegime(instrument: string): Promise<MarketRegimeRecord | null>;
}

export interface CandleStorage extends CandleRepository {
  summaries: SessionSummaryRepository;
  structure: StructureRepository;
  /** Compacts derived-timeframe rows. Not applicable to every backend. */
  release(): void;
}

/* ------------------------------------------------------------------ */
/* In-memory implementation                                            */
/* ------------------------------------------------------------------ */

/**
 * Bounded in-memory store.
 *
 * Correct for a single process and for tests. It enforces the SAME uniqueness
 * and idempotency rules as the durable backends, so a test written against it
 * is testing the contract rather than a mock's convenience.
 */
export class MemoryCandleRepository implements CandleStorage {
  /** `${instrument}#${openTimeMs}` -> record. The primary key, in memory. */
  private readonly candles = new Map<string, CandleRecord>();

  private readonly summaryStore = new Map<string, SessionSummary>();

  private readonly swingStore = new Map<string, SwingPoint>();

  private readonly levelStore = new Map<string, LevelRecord>();

  private readonly regimeStore = new Map<string, MarketRegimeRecord>();

  /**
   * Simulates a durable write failure, used to prove that the finalizer does
   * not prune when persistence fails. Only settable by tests.
   */
  failNextWrite: string | null = null;

  async upsertMany(records: readonly CandleRecord[]): Promise<UpsertOutcome> {
    if (this.failNextWrite) {
      const message = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(message);
    }

    const outcome: UpsertOutcome = {
      inserted: 0,
      updated: 0,
      rejected: 0,
      duplicates: 0,
      revisions: [],
    };

    for (const record of records) {
      const key = `${record.instrument}#${record.openTimeMs}`;
      const existing = this.candles.get(key);

      if (!existing) {
        this.candles.set(key, { ...record });
        outcome.inserted += 1;
        continue;
      }

      const identical =
        existing.open === record.open &&
        existing.high === record.high &&
        existing.low === record.low &&
        existing.close === record.close &&
        existing.volume === record.volume;

      if (identical) {
        /**
         * Duplicate delivery. `finalized` may legitimately advance from false
         * to true when the provider closes the bar — that is not a correction
         * and must not bump the revision, or every redelivery would look like
         * a new revision and observers would never see a quiet market.
         */
        if (!existing.finalized && record.finalized) {
          this.candles.set(key, {
            ...existing,
            finalized: true,
            updatedAt: record.updatedAt,
          });
        }
        outcome.duplicates += 1;
        continue;
      }

      const next: CandleRecord = {
        ...record,
        revision: existing.revision + 1,
        receivedAt: existing.receivedAt,
      };

      this.candles.set(key, next);
      outcome.updated += 1;
      outcome.revisions.push({
        id: key,
        from: existing.revision,
        to: next.revision,
      });
    }

    return outcome;
  }

  async range(
    instrument: string,
    fromMs: number,
    toMs: number,
    limit = 100_000,
  ): Promise<CandleRecord[]> {
    const rows: CandleRecord[] = [];
    for (const record of this.candles.values()) {
      if (record.instrument !== instrument) continue;
      if (record.openTimeMs < fromMs || record.openTimeMs >= toMs) continue;
      rows.push(record);
      if (rows.length >= limit) break;
    }
    return rows.sort((a, b) => a.openTimeMs - b.openTimeMs);
  }

  async recent(
    instrument: string,
    count: number,
    beforeMs = Number.POSITIVE_INFINITY,
  ): Promise<CandleRecord[]> {
    const rows: CandleRecord[] = [];
    for (const record of this.candles.values()) {
      if (record.instrument !== instrument) continue;
      if (record.openTimeMs > beforeMs) continue;
      rows.push(record);
    }
    rows.sort((a, b) => a.openTimeMs - b.openTimeMs);
    return rows.slice(-Math.max(0, count));
  }

  async latestAtOrBefore(
    instrument: string,
    beforeMs = Number.POSITIVE_INFINITY,
  ): Promise<CandleRecord | null> {
    const rows = await this.recent(instrument, 1, beforeMs);
    return rows[0] ?? null;
  }

  async count(instrument: string): Promise<number> {
    let total = 0;
    for (const record of this.candles.values()) {
      if (record.instrument === instrument) total += 1;
    }
    return total;
  }

  async deleteBefore(
    instrument: string,
    beforeMs: number,
    limit: number,
  ): Promise<number> {
    const doomed: string[] = [];
    for (const [key, record] of this.candles) {
      if (record.instrument !== instrument) continue;
      if (record.openTimeMs >= beforeMs) continue;
      doomed.push(key);
      if (doomed.length >= limit) break;
    }
    for (const key of doomed) this.candles.delete(key);
    return doomed.length;
  }

  readonly summaries: SessionSummaryRepository = {
    save: async (summary) => {
      this.summaryStore.set(summary.id, { ...summary });
    },
    get: async (id) => {
      const found = this.summaryStore.get(id);
      return found ? { ...found } : null;
    },
    list: async (instrument, limit = 50) => {
      return [...this.summaryStore.values()]
        .filter((s) => s.instrument === instrument)
        .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate))
        .slice(0, limit)
        .map((s) => ({ ...s }));
    },
    finalizedThroughMs: async (instrument) => {
      const summaries = [...this.summaryStore.values()].filter(
        (s) => s.instrument === instrument,
      );
      if (summaries.length === 0) return null;
      return Math.max(...summaries.map((s) => s.closesAtMs));
    },
    count: async (instrument) => {
      let total = 0;
      for (const s of this.summaryStore.values()) {
        if (s.instrument === instrument) total += 1;
      }
      return total;
    },
  };

  readonly structure: StructureRepository = {
    saveSwings: async (swings) => {
      for (const swing of swings) this.swingStore.set(swing.id, { ...swing });
    },
    listSwings: async (instrument, limit = 500) => {
      return [...this.swingStore.values()]
        .filter((s) => s.instrument === instrument)
        .sort((a, b) => a.atMs - b.atMs)
        .slice(-limit)
        .map((s) => ({ ...s }));
    },
    saveLevels: async (levels) => {
      for (const level of levels) this.levelStore.set(level.id, { ...level });
    },
    listLevels: async (instrument, limit = 200) => {
      return [...this.levelStore.values()]
        .filter((l) => l.instrument === instrument)
        .slice(0, limit)
        .map((l) => ({ ...l }));
    },
    saveRegime: async (regime) => {
      this.regimeStore.set(regime.id, { ...regime });
    },
    latestRegime: async (instrument) => {
      const rows = [...this.regimeStore.values()].filter(
        (r) => r.instrument === instrument,
      );
      if (rows.length === 0) return null;
      rows.sort((a, b) => b.asOfMs - a.asOfMs);
      return { ...rows[0] };
    },
  };

  release(): void {
    /* nothing to release */
  }

  /** Test helper: total rows across every instrument. */
  totalRows(): number {
    return this.candles.size;
  }
}