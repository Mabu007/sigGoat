/**
 * SQLITE CURSOR HELPERS
 * ====================
 * A thin, typed layer over `ctx.storage.sql`.
 *
 * WHY THIS EXISTS
 *
 * The real Workers SQLite API is deliberately low-level: `exec()` hands back a
 * cursor whose `toArray()` is synchronous, whose `one()` THROWS unless the
 * result has exactly one row, and which exposes `rowsWritten` as a getter.
 *
 * The previous code in this repository called a `first()` method that does not
 * exist and `await`ed `toArray()`, so it type-checked against a hand-written
 * declaration file and would have thrown `cursor.first is not a function` on
 * the first SQL call in production.
 *
 * These three helpers give the object code the semantics it actually wants,
 * each one consuming its cursor synchronously so no read ever crosses an
 * `await` with a live cursor attached.
 */

/** Columns SQLite hands back. Mirrors the platform's `SqlStorageValue`. */
export type SqlValue = ArrayBuffer | string | number | null;

/**
 * `SELECT` returning zero or more rows.
 *
 * Synchronous by design: the cursor is consumed before this returns, so the
 * result is a stable snapshot even if the caller awaits afterwards.
 */
export function sqlAll<T extends Record<string, SqlValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): T[] {
  return sql.exec<T>(query, ...bindings).toArray();
}

/**
 * `SELECT` returning at most one row.
 *
 * Returns null for an empty result. This is deliberately NOT the platform's
 * `one()`, which throws when the result is anything other than exactly one row
 * — a wrong behaviour for an optional lookup.
 */
export function sqlFirst<T extends Record<string, SqlValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): T | null {
  const rows = sql.exec<T>(query, ...bindings).toArray();
  return rows.length > 0 ? rows[0] : null;
}

/** A single scalar from the first row, or null. For `COUNT(*)`, `MAX(...)`. */
export function sqlScalar(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): number | null {
  const row = sqlFirst<Record<string, SqlValue>>(sql, query, ...bindings);
  if (!row) return null;

  const first = Object.values(row)[0];
  return typeof first === 'number' ? first : null;
}

/**
 * Runs a write statement and reports how many rows it touched.
 *
 * `rowsWritten` is 0 for a statement that changed nothing — an `INSERT ... ON
 * CONFLICT DO UPDATE` whose WHERE guard rejected the row, or a `DELETE` that
 * matched nothing. That is how idempotent upserts detect a duplicate delivery
 * instead of guessing.
 *
 * Note the count includes index rows, so treat it as "did anything change",
 * never as an exact row count.
 */
export function sqlRun(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): { rowsRead: number; rowsWritten: number } {
  const cursor = sql.exec(query, ...bindings);
  const result = { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
  return result;
}