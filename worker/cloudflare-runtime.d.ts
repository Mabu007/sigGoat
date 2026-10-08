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

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

declare const DurableObject: {
  new (state: DurableObjectState, env: unknown): {
    fetch(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  };
};
