/**
 * MINIMAL CLOUDFLARE WORKERS AMBIENT TYPES
 * ========================================
 * The realtime Worker runs on Cloudflare's runtime, not in Node and not in
 * a browser. Its full type surface is published by `@cloudflare/workers-types`
 * (or `wrangler types`), but adding that as a dependency for four
 * interfaces is not worth it.
 *
 * These declarations cover exactly what `realtime/src` uses. If a Worker
 * API is used that is not declared here, TypeScript will say so, and the
 * correct fix is to add the missing member — not to widen the types to
 * `any`.
 */

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  name?: string;
}

interface DurableObjectStub<T = unknown> {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  id: DurableObjectId;
  name?: string;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

interface DurableObject {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

interface R2Bucket {
  get(key: string, options?: { range?: { offset?: number; length?: number } }): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<R2Object | null>;
}

interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { contentType?: string; cacheControl?: string };
  body: ReadableStream;
}

interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

/** The runtime global that produces the client/server socket pair. */
declare const WebSocketPair: {
  new (): WebSocketPair;
};
