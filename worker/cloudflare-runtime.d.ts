/**
 * MINIMAL CLOUDFLARE WORKERS RUNTIME TYPES
 * ========================================
 * Just enough of the Durable Objects / Workers surface for `tsc --noEmit` to
 * cover worker/, without pulling in @cloudflare/workers-types as a dependency.
 *
 * If the worker starts using more of the platform API, add the real types
 * package rather than growing this file indefinitely.
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
 * SQLite-backed storage, available on the DO class as `ctx.storage.sql`.
 * Requires a `new_sqlite_classes` migration entry.
 *
 * `exec` is SYNCHRONOUS on the Workers runtime — it executes against the local
 * SQLite instance and returns a cursor. Only `toArray`/`first` are async,
 * because those iterate the cursor.
 */
interface SqlStorageCursor {
  toArray<T = Record<string, unknown>>(): Promise<T[]>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface SqlStorageStatement extends SqlStorageCursor {
  bind(...values: unknown[]): SqlStorageStatement;
  run<T = Record<string, unknown>>(): Promise<{
    meta: {
      changes?: number;
      last_row_id?: number;
      rows_read?: number;
      rows_written?: number;
      duration?: number;
    };
    results: T[];
  }>;
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageStatement;
  databaseSize?: number;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
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

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  fetchAndCache?: typeof fetch;
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
  fetch?: (request: Request, env: unknown, ctx: ExecutionContextLike) => Promise<Response> | Response;
  scheduled?: (
    controller: { scheduledTime: number; cron: string },
    env: unknown,
    ctx: ExecutionContextLike,
  ) => Promise<void> | void;
}
