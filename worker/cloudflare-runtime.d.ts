/**
 * MINIMAL CLOUDFLARE WORKERS RUNTIME TYPES
 * ========================================
 * Just enough of the Durable Objects / Workers surface for `tsc --noEmit` to
 * cover worker/, without pulling in @cloudflare/workers-types as a dependency.
 *
 * THIS FILE MIRRORS THE REAL RUNTIME. THAT IS THE WHOLE POINT.
 *
 * The previous version of this file declared a `first<T>()` method and an async
 * `toArray<T>()`. Neither exists on `SqlStorageCursor`. The real cursor exposes
 * `next()`, `toArray()`, `one()`, `raw()`, plus the `rowsRead` / `rowsWritten`
 * counters — and `toArray()` is SYNCHRONOUS.
 *
 * Because the shim disagreed with the platform, `tsc` reported the Worker as
 * clean while every SQL call in MarketDataDO would have thrown
 * `cursor.first is not a function` the first time it ran in production. A
 * type declaration that lies is worse than no type declaration, so this file
 * tracks the documented API and `worker/sql.ts` provides the small ergonomic
 * layer the object code actually wants.
 *
 * If the worker starts using more of the platform API, add the real types
 * package rather than growing this file indefinitely — but anything already
 * here must match the platform exactly.
 */

interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Row values SQLite can return. Mirrors `SqlStorageValue` on the platform.
 */
type SqlStorageValue = ArrayBuffer | string | number | null;

/**
 * Result of a write statement, as read from `cursor.rowsWritten`.
 *
 * The platform exposes this as a GETTER on the cursor, not a method. It counts
 * every row written including index rows, which is fine for the only question
 * asked here: "did this statement change anything at all?"
 */
interface SqlWriteResult {
  rowsRead: number;
  rowsWritten: number;
}

/**
 * SQLite-backed storage cursor.
 *
 * SYNCHRONOUS consumption. A cursor resumed after an `await` has no snapshot
 * isolation, so every read in this codebase consumes its cursor immediately.
 */
interface SqlStorageCursor<T = Record<string, SqlStorageValue>> {
  next(): IteratorResult<T>;
  toArray(): T[];
  /** Throws unless the result has exactly one row. */
  one(): T;
  raw<U = SqlStorageValue[]>(): IterableIterator<U> & { toArray(): U[] };
  columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>;
  readonly databaseSize: number;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  /**
   * SQLite backend: SQL statements executed on `ctx.storage` inside the
   * closure are part of the transaction. The closure must not await.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * The correct primitive for a batch of synchronous `sql.exec()` calls.
   * Throwing inside rolls the whole batch back.
   */
  transactionSync<T>(fn: () => T): T;
  sync(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  /** Present only on SQLite-backed DOs. */
  readonly sql?: SqlStorage;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  id: DurableObjectId;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface FetchEventLike {
  fetchAll?(requests: Request[]): Promise<Response[]>;
}

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

declare const DurableObject: {
  new (
    state: DurableObjectState,
    env: unknown,
  ): {
    fetch(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  };
};

interface ExportedHandlerDefault {
  fetch?: (
    request: Request,
    env: unknown,
    ctx: ExecutionContextLike,
  ) => Promise<Response> | Response;
  scheduled?: (
    controller: ScheduledControllerLike,
    env: unknown,
    ctx: ExecutionContextLike,
  ) => Promise<void> | void;
}