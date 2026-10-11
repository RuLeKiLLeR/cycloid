/**
 * Traced wrappers for Cloudflare Workers bindings.
 *
 * Workers bindings (D1, KV, DO stubs) are not monkey-patchable.
 * These create explicit proxy wrappers that emit spans.
 */
import { serializeTraceparent, type SpanAttributes } from "../../../../shared/observability/trace.js";
import { sleep } from "../../../../shared/utils/timing.js";
import { SQL_TRUNCATION_LENGTH, URL_TRUNCATION_LENGTH } from "../constants/observability";
import { D1_RETRY_SAFE_MARKER, isTransientD1StorageError } from "../db/errors";
import { endSpan, type SpanHandle, startSpan } from "./context";

// ── D1 ──────────────────────────────────────────────────────────────

/** Symbol to retrieve the native D1PreparedStatement from a traced wrapper. */
const NATIVE_STMT = Symbol("nativeD1Stmt");

/**
 * Bounded retry for transient D1 storage errors ("internal error", storage
 * resets). Two opt-in paths share this budget:
 *   - reads: a `first`/`all`/`raw` terminal carrying read-only SQL (auto-retried;
 *     a platform blip would otherwise become a user-facing 500, monitor 18984697);
 *   - writes: a `run()` terminal whose SQL carries the explicit `d1-retry-safe`
 *     marker (a transient error does not prove the write failed to commit, so
 *     non-idempotent writes must NOT retry; the marker is the author's
 *     idempotence assertion).
 * A RETURNING write consumed via `first`/`all`/`raw` is NOT read-only and the
 * marker is ignored there (retries are gated to `run()`), so it never silently
 * retries. `batch`/`exec` are never retried.
 *
 * These constants bound BOTH paths (reads and marked `run()` writes), hence no
 * "read"-specific name. The per-attempt timeout below is read-only.
 *
 * The wrapper is the observability layer; putting retry here trades layer
 * purity for the single choke point every D1 call already passes through —
 * the alternative duplicates retry policy across ~30 DAO files.
 */
const D1_RETRY_MAX = 3;
const D1_RETRY_BASE_MS = 25;

/**
 * Hung D1 attempts (~15s each on platform stalls) exhaust the retry budget
 * without ever reaching a retryable error. Each read attempt races a timer;
 * a synthetic timeout classifies as transient (message carries D1_ERROR) so
 * the normal retry loop picks it up. The timed-out query keeps executing in
 * D1, so retries can overlap in-flight reads — bounded by the retry budget
 * (≤ D1_RETRY_MAX + 1 concurrent reads per call) and acceptable because
 * timeouts fire on platform stalls, not capacity load-shed (`overloaded`
 * errors fail fast and never reach this path). Reads only — a timed-out
 * write may have committed, so it is never timeout-then-retried.
 */
const D1_READ_ATTEMPT_TIMEOUT_MS = 5000;

function isRetrySafeSql(sql: string): boolean {
  return sql.includes(D1_RETRY_SAFE_MARKER);
}

function retryDelayMs(retry: number): number {
  return D1_RETRY_BASE_MS * 2 ** (retry - 1); // 25, 50, 100
}

function attemptWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const attempt = fn();
  // Losing attempts settle after the race; swallow their late rejection so it
  // never surfaces as an unhandled rejection.
  attempt.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`D1_ERROR: synthetic per-attempt timeout after ${D1_READ_ATTEMPT_TIMEOUT_MS}ms`)),
      D1_READ_ATTEMPT_TIMEOUT_MS,
    );
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A read TERMINAL does not imply read-only SQL: the repo runs mutating
 * statements through `first`/`all`/`raw` to consume RETURNING rows
 * (e.g. `DELETE ... RETURNING`, `UPDATE ... RETURNING`). Retry only when the
 * statement itself is read-only. `WITH` is deliberately excluded: SQLite CTEs
 * can wrap INSERT/UPDATE/DELETE, so a leading WITH proves nothing.
 */
function isReadOnlySql(sql: string): boolean {
  const stripped = sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "");
  return /^SELECT\b/i.test(stripped);
}

function parseTableFromSql(sql: string): string {
  const match = sql.match(/(?:FROM|INTO|UPDATE|TABLE)\s+["`]?(\w+)["`]?/i);
  return match?.[1] ?? "unknown";
}

function traceparentForSpan(span: SpanHandle): string | null {
  if (span.startTime === 0) return null;
  try {
    return serializeTraceparent(span);
  } catch {
    return null;
  }
}

function injectTraceparentHeader(init: RequestInit, traceparent: string): RequestInit {
  const headers = init.headers;
  if (!headers) return { ...init, headers: { traceparent } };

  if (headers instanceof Headers) {
    if (!headers.has("traceparent")) {
      headers.set("traceparent", traceparent);
    }
    return init;
  }

  const normalizedHeaders = new Headers(headers);
  if (normalizedHeaders.has("traceparent")) return init;

  if (Array.isArray(headers)) {
    normalizedHeaders.set("traceparent", traceparent);
    return { ...init, headers: Array.from(normalizedHeaders.entries()) };
  }

  return { ...init, headers: { ...(headers as Record<string, string>), traceparent } };
}

interface TracedD1PreparedStatement {
  [NATIVE_STMT]: D1PreparedStatement;
  bind(...values: unknown[]): TracedD1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  raw(): Promise<unknown[][]>;
}

function tracedStatement(inner: D1PreparedStatement, sql: string, dbName: string): TracedD1PreparedStatement {
  const table = parseTableFromSql(sql);
  const truncatedSql = sql.length > SQL_TRUNCATION_LENGTH ? sql.slice(0, SQL_TRUNCATION_LENGTH) + "..." : sql;

  function wrapTerminal<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const span = startSpan(`d1.${method}`, {
      "db.system": "d1",
      "db.name": dbName,
      "db.operation": method,
      "db.statement": truncatedSql,
      "db.table": table,
    });
    // Read terminals carrying read-only SQL retry automatically. The
    // d1-retry-safe marker opts a write into the same retry loop, but ONLY on
    // run() — a RETURNING write consumed via first/all/raw is not read-only and
    // must not silently retry just because the marker is present. (db/errors.ts
    // documents the marker as a run()-terminal contract.)
    const readOnly = (method === "first" || method === "all" || method === "raw") && isReadOnlySql(sql);
    const retryable = readOnly || (method === "run" && isRetrySafeSql(sql));
    const run = async (): Promise<T> => {
      let transientRetries = 0;
      for (;;) {
        try {
          const result = await (readOnly ? attemptWithTimeout(fn) : fn());
          // D1 auto-retries read-only queries and exposes the count on `D1Result.meta`
          // (returned by all/run/batch, not first/raw). Surfacing it shows how often the
          // platform's built-in retries are firing alongside our transient-error retry.
          const totalAttempts = (result as { meta?: { total_attempts?: number } } | null)?.meta?.total_attempts;
          endSpan(span, "ok", {
            ...(typeof totalAttempts === "number" ? { "db.total_attempts": totalAttempts } : {}),
            ...(transientRetries > 0 ? { "db.transient_retries": transientRetries } : {}),
          });
          return result;
        } catch (err) {
          if (!retryable || transientRetries >= D1_RETRY_MAX || !isTransientD1StorageError(err)) {
            endSpan(span, "error", {
              "error.message": String(err),
              ...(transientRetries > 0 ? { "db.transient_retries": transientRetries } : {}),
            });
            throw err;
          }
          transientRetries++;
          await sleep(retryDelayMs(transientRetries));
        }
      }
    };
    return run();
  }

  return {
    [NATIVE_STMT]: inner,
    bind(...values: unknown[]) {
      return tracedStatement(inner.bind(...values), sql, dbName);
    },
    first<T = Record<string, unknown>>(colName?: string) {
      return wrapTerminal("first", () => inner.first<T>(colName as string));
    },
    all<T = Record<string, unknown>>() {
      return wrapTerminal("all", () => inner.all<T>());
    },
    run() {
      return wrapTerminal("run", () => inner.run());
    },
    raw() {
      return wrapTerminal("raw", () => inner.raw());
    },
  };
}

function tracedD1(db: D1Database, name: string): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => tracedStatement(target.prepare(sql), sql, name);
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          // Unwrap traced wrappers back to native D1PreparedStatement for batch
          const native = statements.map((s) => {
            const inner = (s as unknown as Record<symbol, D1PreparedStatement>)[NATIVE_STMT];
            return inner ?? s;
          });
          const span = startSpan("d1.batch", {
            "db.system": "d1",
            "db.name": name,
            "db.batch_size": statements.length,
          });
          return target.batch(native).then(
            (result) => {
              // batch() returns one D1Result per statement, each with its own
              // meta.total_attempts (D1's built-in read-retry count). Record the worst
              // case across the batch so the d1.batch span carries the same signal as
              // the single-statement terminals.
              const maxAttempts = Array.isArray(result)
                ? result.reduce<number | undefined>((max, r) => {
                    const attempts = (r as { meta?: { total_attempts?: number } } | null)?.meta?.total_attempts;
                    return typeof attempts === "number" ? Math.max(max ?? 0, attempts) : max;
                  }, undefined)
                : undefined;
              endSpan(span, "ok", typeof maxAttempts === "number" ? { "db.total_attempts": maxAttempts } : undefined);
              return result;
            },
            (err) => {
              endSpan(span, "error", { "error.message": String(err) });
              throw err;
            },
          );
        };
      }
      if (prop === "exec") {
        return (sql: string) => {
          const span = startSpan("d1.exec", { "db.system": "d1", "db.name": name });
          return target.exec(sql).then(
            (result) => {
              endSpan(span, "ok");
              return result;
            },
            (err) => {
              endSpan(span, "error", { "error.message": String(err) });
              throw err;
            },
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ── KV ──────────────────────────────────────────────────────────────

function tracedKV(kv: KVNamespace, name: string): KVNamespace {
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (key: string, ...args: unknown[]) => {
          const span = startSpan(`kv.get`, { "kv.namespace": name, "kv.key": key });
          return (target.get as (...a: unknown[]) => Promise<unknown>)(key, ...args).then(
            (result: unknown) => {
              endSpan(span, "ok", { "kv.hit": result !== null });
              return result;
            },
            (err: unknown) => {
              endSpan(span, "error", { "error.message": String(err) });
              throw err;
            },
          );
        };
      }
      if (prop === "put") {
        return (key: string, value: unknown, ...args: unknown[]) => {
          const span = startSpan(`kv.put`, { "kv.namespace": name, "kv.key": key });
          return (target.put as (...a: unknown[]) => Promise<void>)(key, value, ...args).then(
            () => {
              endSpan(span, "ok");
            },
            (err: unknown) => {
              endSpan(span, "error", { "error.message": String(err) });
              throw err;
            },
          );
        };
      }
      if (prop === "delete") {
        return (key: string) => {
          const span = startSpan(`kv.delete`, { "kv.namespace": name, "kv.key": key });
          return target.delete(key).then(
            () => {
              endSpan(span, "ok");
            },
            (err: unknown) => {
              endSpan(span, "error", { "error.message": String(err) });
              throw err;
            },
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ── Fetch (external APIs) ───────────────────────────────────────────

export async function tracedFetch(
  url: string | URL | Request,
  init: RequestInit = {},
  spanName?: string,
): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  const name = spanName || `fetch ${new URL(urlStr).hostname}`;

  const span = startSpan(name, {
    "http.method": (init.method || "GET").toUpperCase(),
    "http.url": urlStr.length > URL_TRUNCATION_LENGTH ? urlStr.slice(0, URL_TRUNCATION_LENGTH) : urlStr,
  });

  // Inject traceparent referencing THIS span (not the caller's span)
  // so downstream services become children of this fetch span.
  // Preserve original headers type to avoid breaking callers that check exact args.
  const traceparent = traceparentForSpan(span);
  if (traceparent) {
    init = injectTraceparentHeader(init, traceparent);
  }

  try {
    const response = await fetch(url, init);
    endSpan(span, "ok", { "http.status_code": response.status });
    return response;
  } catch (err) {
    endSpan(span, "error", { "error.message": String(err) });
    throw err;
  }
}

// ── Traced Env (Option A) ───────────────────────────────────────────
// One wrapper at each entrypoint, zero changes to consumers.

interface TracedEnvOptions {
  /** Additional attributes to attach to all spans in this context */
  attributes?: SpanAttributes;
}

export function tracedEnv<
  T extends { DB?: D1Database; REPOS_CACHE?: KVNamespace; RATE_LIMITS?: KVNamespace; DERIVED_MODELS?: KVNamespace },
>(env: T, _opts?: TracedEnvOptions): T {
  // Cache traced bindings so we don't create new proxies on every property access
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (cache.has(prop)) return cache.get(prop);
      let traced: unknown;
      if (prop === "DB" && target.DB) traced = tracedD1(target.DB, "DB");
      else if (prop === "REPOS_CACHE" && target.REPOS_CACHE) traced = tracedKV(target.REPOS_CACHE, "REPOS_CACHE");
      else if (prop === "RATE_LIMITS" && target.RATE_LIMITS) traced = tracedKV(target.RATE_LIMITS, "RATE_LIMITS");
      else if (prop === "DERIVED_MODELS" && target.DERIVED_MODELS)
        traced = tracedKV(target.DERIVED_MODELS, "DERIVED_MODELS");
      else return Reflect.get(target, prop, receiver);
      cache.set(prop, traced);
      return traced;
    },
  });
}
