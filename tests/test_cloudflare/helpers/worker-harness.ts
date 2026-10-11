/**
 * Shared fakes and utilities for Cloudflare worker route-level tests.
 *
 * Provides the common primitives that every route test suite needs:
 * FakeStorage (simple and SQL-backed), FakeKV, FakeDurableState,
 * createDurableNamespace, workerFetch, and vi.mock factories.
 *
 * Domain-specific FakeD1 implementations stay in each test file
 * because they handle different query patterns per suite.
 */
import Database from "better-sqlite3";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// WorkerModule -- the shape of the imported control-plane-worker module
// ---------------------------------------------------------------------------

export type WorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
  SessionResumeRateLimiterDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

type DurableRequestRecord = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
};

type StorageListOptions = {
  prefix?: string;
  start?: string;
  limit?: number;
  reverse?: boolean;
};

type WaitUntilFlushOptions = {
  timeoutMs?: number;
};

type WaitUntilResult = { status: "fulfilled" } | { status: "rejected"; error: unknown };

// ---------------------------------------------------------------------------
// FakeKV -- in-memory KV namespace (for REPOS_CACHE, etc.)
// ---------------------------------------------------------------------------

export class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class WaitUntilTracker {
  private readonly pending = new Set<Promise<WaitUntilResult>>();

  track(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise)
      .then((): WaitUntilResult => ({ status: "fulfilled" }))
      .catch((error): WaitUntilResult => ({ status: "rejected", error }));

    this.pending.add(tracked);
    tracked.finally(() => {
      this.pending.delete(tracked);
    });
  }

  async flush(options: WaitUntilFlushOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 2000;

    while (this.pending.size > 0) {
      const batch = [...this.pending];
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all(batch),
        new Promise<WaitUntilResult[]>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${batch.length} waitUntil promise(s)`));
          }, timeoutMs);
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) {
        throw rejected.error;
      }
    }
  }

  reset(): void {
    this.pending.clear();
  }
}

function listEntries<T>(map: Map<string, T>, options: StorageListOptions = {}): Map<string, T> {
  let entries = [...map.entries()];

  if (options.prefix) {
    entries = entries.filter(([key]) => key.startsWith(options.prefix!));
  }
  if (options.start) {
    entries = entries.filter(([key]) => key >= options.start!);
  }

  entries.sort(([left], [right]) => left.localeCompare(right));
  if (options.reverse) entries.reverse();
  if (options.limit != null) entries = entries.slice(0, options.limit);

  return new Map(entries);
}

abstract class BaseFakeStorage {
  protected readonly map = new Map<string, unknown>();
  protected alarm: number | null = null;
  private transactionQueue = Promise.resolve();
  private pendingAsyncTransactions = 0;

  async get<T>(key: string): Promise<T | undefined>;
  async get(keys: string[]): Promise<Map<string, unknown>>;
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, unknown>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, unknown>();
      for (const key of keyOrKeys) {
        if (this.map.has(key)) result.set(key, this.map.get(key));
      }
      return result;
    }

    return this.map.get(keyOrKeys) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, value);
      return;
    }

    for (const [key, entryValue] of Object.entries(keyOrEntries)) {
      this.map.set(key, entryValue);
    }
  }

  async list<T>(options: StorageListOptions = {}): Promise<Map<string, T>> {
    return listEntries(this.map as Map<string, T>, options);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      for (const key of keyOrKeys) {
        this.map.delete(key);
      }
      return true;
    }

    return this.map.delete(keyOrKeys);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async transaction<T>(closure: (txn: this) => Promise<T>): Promise<T> {
    this.pendingAsyncTransactions += 1;
    const result = this.transactionQueue.then(async () => {
      const snapshot = new Map(this.map);
      const alarmSnapshot = this.alarm;
      try {
        return await closure(this);
      } catch (error) {
        this.map.clear();
        for (const [key, value] of snapshot) {
          this.map.set(key, value);
        }
        this.alarm = alarmSnapshot;
        throw error;
      } finally {
        this.pendingAsyncTransactions -= 1;
      }
    });
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  transactionSync<T>(closure: () => T): T {
    if (this.pendingAsyncTransactions > 0) {
      throw new Error("FakeStorage transactionSync cannot run while an async transaction is pending");
    }
    const snapshot = new Map(this.map);
    const alarmSnapshot = this.alarm;
    try {
      return closure();
    } catch (error) {
      this.map.clear();
      for (const [key, value] of snapshot) {
        this.map.set(key, value);
      }
      this.alarm = alarmSnapshot;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// FakeStorage -- simple Map-backed storage with stub SQL
// ---------------------------------------------------------------------------

export class FakeStorage extends BaseFakeStorage {
  sql = {
    exec(_query: string, ..._params: unknown[]) {
      return { toArray: () => [], rowsRead: 0, rowsWritten: 0, [Symbol.iterator]: () => [][Symbol.iterator]() };
    },
    get databaseSize() {
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// FakeSqlStorage -- Map-backed storage with real SQL via better-sqlite3
// ---------------------------------------------------------------------------

export class FakeSqlStorage extends BaseFakeStorage {
  private readonly db = new Database(":memory:");

  /** Test helper: read raw storage value synchronously. */
  _get(key: string): unknown {
    return this.map.get(key);
  }

  override transactionSync<T>(closure: () => T): T {
    return this.db.transaction(() => super.transactionSync(closure))();
  }

  sql = (() => {
    const db = this.db;
    return {
      exec(query: string, ...params: unknown[]) {
        const trimmed = query.trimStart().toUpperCase();
        const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
        if (params.length === 0) {
          if (isSelect) {
            const rows = db.prepare(query).all();
            return {
              toArray: () => rows,
              rowsRead: rows.length,
              rowsWritten: 0,
              [Symbol.iterator]: () => rows[Symbol.iterator](),
            };
          }
          db.exec(query);
          return { toArray: () => [], rowsRead: 0, rowsWritten: 0, [Symbol.iterator]: () => [][Symbol.iterator]() };
        }
        const stmt = db.prepare(query);
        if (isSelect) {
          const rows = stmt.all(...(params as unknown[]));
          return {
            toArray: () => rows,
            rowsRead: rows.length,
            rowsWritten: 0,
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        }
        const result = stmt.run(...(params as unknown[]));
        return {
          toArray: () => [],
          rowsRead: 0,
          rowsWritten: result.changes,
          [Symbol.iterator]: () => [][Symbol.iterator](),
        };
      },
      get databaseSize() {
        return 0;
      },
    };
  })();
}

// ---------------------------------------------------------------------------
// FakeDurableState -- mimics DurableObjectState for route-level tests
// ---------------------------------------------------------------------------

export class FakeDurableState<S extends FakeStorage | FakeSqlStorage = FakeStorage> {
  readonly storage: S;
  readonly id = { toString: () => "fake-do-id" };
  private readonly waitUntilTracker = new WaitUntilTracker();
  private readonly sockets = new Map<unknown, string[]>();
  private autoResponse: unknown = null;
  blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
    await fn();
  };

  constructor(storage?: S) {
    this.storage = storage ?? (new FakeStorage() as unknown as S);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilTracker.track(promise);
  }

  /** Flush tracked waitUntil work and surface the first rejection. */
  async flushWaitUntil(options?: WaitUntilFlushOptions): Promise<void> {
    await this.waitUntilTracker.flush(options);
  }

  reset(): void {
    this.waitUntilTracker.reset();
  }

  acceptWebSocket(ws: unknown, tags: string[] = []): void {
    this.sockets.set(ws, tags);
  }

  getWebSockets(tag?: string): unknown[] {
    return [...this.sockets.entries()].filter(([, tags]) => !tag || tags.includes(tag)).map(([ws]) => ws);
  }

  getTags(ws: unknown): string[] {
    return this.sockets.get(ws) ?? [];
  }

  setWebSocketAutoResponse(pair?: unknown): void {
    this.autoResponse = pair ?? null;
  }

  getWebSocketAutoResponse(): unknown {
    return this.autoResponse;
  }
}

// ---------------------------------------------------------------------------
// createDurableNamespace -- wires a DO class into a fake namespace stub
// ---------------------------------------------------------------------------

export type DurableNamespace = {
  idFromName(name: string): string;
  get(id: string): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
  _requests: DurableRequestRecord[];
  _getRequests(id?: string): DurableRequestRecord[];
  /** Expose internal state map for test setup. */
  _states: Map<string, FakeDurableState<FakeStorage> | FakeDurableState<FakeSqlStorage>>;
  /** Get the FakeDurableState for a DO instance. */
  _getState(id: string): FakeDurableState<FakeStorage> | FakeDurableState<FakeSqlStorage> | undefined;
  /** Flush all tracked waitUntil work for the namespace. */
  _flushWaitUntil(options?: WaitUntilFlushOptions): Promise<void>;
  /** Reset internal waitUntil tracking state. */
  _reset(): void;
};

export function createDurableNamespace(
  durableClass: WorkerModule["SessionDO"],
  env: Record<string, unknown>,
  options?: { sqlStorage?: boolean },
): DurableNamespace {
  const instances = new Map<string, InstanceType<WorkerModule["SessionDO"]>>();
  const states = new Map<string, FakeDurableState<FakeStorage> | FakeDurableState<FakeSqlStorage>>();
  const requests: DurableRequestRecord[] = [];

  return {
    _requests: requests,
    _getRequests(id?: string) {
      return id ? requests.filter((request) => request.id === id) : [...requests];
    },
    _states: states,
    _getState(id: string) {
      return states.get(id);
    },
    async _flushWaitUntil(options?: WaitUntilFlushOptions): Promise<void> {
      for (const state of states.values()) {
        await state.flushWaitUntil(options);
      }
    },
    _reset(): void {
      for (const state of states.values()) {
        state.reset();
      }
    },
    idFromName(name: string): string {
      return name;
    },
    get(id: string): { fetch(request: Request | string, init?: RequestInit): Promise<Response> } {
      return {
        fetch: async (request: Request | string, init?: RequestInit): Promise<Response> => {
          let instance = instances.get(id);
          if (!instance) {
            const state = options?.sqlStorage ? new FakeDurableState(new FakeSqlStorage()) : new FakeDurableState();
            states.set(id, state);
            instance = new durableClass(state, env) as InstanceType<WorkerModule["SessionDO"]>;
            instances.set(id, instance);
          }
          const actualRequest = request instanceof Request ? request : new Request(request, init);
          requests.push({
            id,
            method: actualRequest.method,
            url: actualRequest.url,
            headers: Object.fromEntries(actualRequest.headers.entries()),
          });
          return instance.fetch(actualRequest);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// workerFetch -- send a request through the worker's fetch handler
// ---------------------------------------------------------------------------

export async function workerFetch(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return workerModule.default.fetch(new Request(`https://worker.test${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Common vi.mock factories -- call at module top-level in each test file
// ---------------------------------------------------------------------------

export function mockCloudflareWorkers(_options: { setState?: boolean } = {}) {
  vi.mock("cloudflare:workers", () => ({
    DurableObject: class {
      ctx: unknown;
      env: unknown;
      state: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.state = ctx;
        this.ctx = ctx;
        this.env = env;
      }
    },
  }));
}

export function mockSentryCloudflare() {
  vi.mock("@sentry/cloudflare", () => ({
    instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
    withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
    setTag: () => {},
    setUser: () => {},
    captureException: () => {},
    captureMessage: () => {},
  }));
}
