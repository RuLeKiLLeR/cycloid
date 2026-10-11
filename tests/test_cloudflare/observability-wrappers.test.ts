import { afterEach, describe, expect, it, vi } from "vitest";

import { D1_RETRY_SAFE_MARKER } from "../../apps/control-plane-worker/src/db/errors";
import {
  drainSpans,
  endSpan,
  runInExporterContext,
  runInSpan,
  setSpanAttributes,
  startSpan,
} from "../../apps/control-plane-worker/src/observability/context";
import { tracedEnv, tracedFetch } from "../../apps/control-plane-worker/src/observability/wrappers";
import { parseTraceparent } from "../../shared/observability/trace.js";

describe("observability wrappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects a shared traceparent for the fetch span", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const root = startSpan("worker.fetch", { "request.id": "req-fetch-wrapper" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      await tracedFetch("https://api.example.com/v1/repos");

      endSpan(root, "ok");
      spans = drainSpans();
    });

    const fetchSpan = spans.find((span) => span.name === "fetch api.example.com");
    expect(fetchSpan).toBeDefined();
    expect(fetchSpan?.parentSpanId).toBe(root.spanId);
    expect(fetchSpan?.attributes["http.status_code"]).toBe(204);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const traceparent = new Headers(init?.headers).get("traceparent");
    expect(parseTraceparent(traceparent)).toEqual({
      traceId: fetchSpan!.traceId,
      spanId: fetchSpan!.spanId,
      traceFlags: "01",
    });
  });

  it("does not inject traceparent or record spans inside exporter context", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    await runInExporterContext(async () => {
      await tracedFetch("https://api.example.com/export", {
        headers: { accept: "application/json" },
      });

      expect(drainSpans()).toEqual([]);
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("traceparent")).toBe(false);
  });

  it("preserves caller-provided traceparent headers across header shapes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const upstreamTraceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-00`;
    const root = startSpan("worker.fetch", { "request.id": "req-fetch-existing-traceparent" });

    await runInSpan(root, async () => {
      await tracedFetch("https://api.example.com/headers-instance", {
        headers: new Headers({ traceparent: upstreamTraceparent }),
      });
      await tracedFetch("https://api.example.com/object-headers", {
        headers: { Traceparent: upstreamTraceparent },
      });
      await tracedFetch("https://api.example.com/array-headers", {
        headers: [["traceparent", upstreamTraceparent]],
      });
      endSpan(root, "ok");
      drainSpans();
    });

    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get("traceparent")).toBe(upstreamTraceparent);
    }
  });

  it("records D1 total_attempts on D1Result terminals (all/run) and omits it on first()", async () => {
    // Minimal D1 stub: `all` returns a D1Result with meta.total_attempts (D1's
    // built-in read-retry count); `first` returns a bare row with no meta.
    const stmt = {
      bind() {
        return this;
      },
      all() {
        return Promise.resolve({ results: [{ n: 1 }], meta: { total_attempts: 3 } });
      },
      first() {
        return Promise.resolve({ n: 1 });
      },
    };
    // batch() returns one D1Result per statement; the span should record the worst-case attempts.
    const batchFn = () =>
      Promise.resolve([
        { results: [], meta: { total_attempts: 1 } },
        { results: [], meta: { total_attempts: 2 } },
      ]);
    const env = { DB: { prepare: () => stmt, batch: batchFn } as unknown as D1Database };
    const root = startSpan("worker.fetch", { "request.id": "req-d1-attempts" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      const db = tracedEnv(env).DB!;
      await db.prepare("SELECT n FROM t WHERE id = ?").bind(1).all();
      await db.prepare("SELECT n FROM t WHERE id = ?").bind(1).first();
      await db.batch([db.prepare("SELECT n FROM t WHERE id = ?").bind(1)]);
      endSpan(root, "ok");
      spans = drainSpans();
    });

    const allSpan = spans.find((span) => span.name === "d1.all");
    const firstSpan = spans.find((span) => span.name === "d1.first");
    const batchSpan = spans.find((span) => span.name === "d1.batch");
    expect(allSpan?.attributes["db.total_attempts"]).toBe(3);
    // first() returns the row, not a D1Result, so there is no total_attempts to record.
    expect(firstSpan?.attributes["db.total_attempts"]).toBeUndefined();
    // batch records the max total_attempts across its per-statement results.
    expect(batchSpan?.attributes["db.total_attempts"]).toBe(2);
  });

  describe("transient D1 read retry", () => {
    const TRANSIENT = () => new Error("D1_ERROR: internal error");

    function envWithStmt(stmt: Record<string, unknown>) {
      const full = {
        bind() {
          return this;
        },
        ...stmt,
      };
      return { DB: { prepare: () => full } as unknown as D1Database };
    }

    /** Runs fn in a root span. Drains spans in finally so error-path tests can
     * assert span attributes and no spans leak into later tests. */
    async function inSpan<T>(
      fn: () => Promise<T>,
    ): Promise<{ value?: T; error?: unknown; spans: ReturnType<typeof drainSpans> }> {
      const root = startSpan("worker.fetch", { "request.id": "req-d1-retry" });
      let spans = [] as ReturnType<typeof drainSpans>;
      let value: T | undefined;
      let error: unknown;
      await runInSpan(root, async () => {
        try {
          value = await fn();
          endSpan(root, "ok");
        } catch (err) {
          error = err;
          endSpan(root, "error");
        } finally {
          spans = drainSpans();
        }
      });
      return { value, error, spans };
    }

    it("retries a transient error on a read terminal and tags the span", async () => {
      const all = vi
        .fn()
        .mockRejectedValueOnce(TRANSIENT())
        .mockResolvedValue({ results: [{ n: 1 }], meta: {} });
      const { value, spans } = await inSpan(() => tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all());

      expect(all).toHaveBeenCalledTimes(2);
      expect((value as { results: unknown[] }).results).toEqual([{ n: 1 }]);
      const span = spans.find((s) => s.name === "d1.all");
      expect(span?.status).toBe("ok");
      expect(span?.attributes["db.transient_retries"]).toBe(1);
    });

    it("retries the raw() read terminal too", async () => {
      const raw = vi
        .fn()
        .mockRejectedValueOnce(TRANSIENT())
        .mockResolvedValue([[1]]);
      const { value } = await inSpan(() => tracedEnv(envWithStmt({ raw })).DB!.prepare("SELECT 1").raw());

      expect(raw).toHaveBeenCalledTimes(2);
      expect(value).toEqual([[1]]);
    });

    it("surfaces the original error once retries are exhausted and tags the error span", async () => {
      const first = vi.fn().mockRejectedValue(TRANSIENT());
      const { error, spans } = await inSpan(() => tracedEnv(envWithStmt({ first })).DB!.prepare("SELECT 1").first());

      expect(String(error)).toContain("internal error");
      // 1 initial attempt + 3 retries.
      expect(first).toHaveBeenCalledTimes(4);
      const span = spans.find((s) => s.name === "d1.first");
      expect(span?.status).toBe("error");
      expect(span?.attributes["db.transient_retries"]).toBe(3);
    });

    it("does not retry a non-transient error", async () => {
      const all = vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table: nope"));
      const { error } = await inSpan(() => tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all());

      expect(String(error)).toContain("no such table");
      expect(all).toHaveBeenCalledTimes(1);
    });

    it("does not retry an overload error (load-shed must not be amplified)", async () => {
      const all = vi.fn().mockRejectedValue(new Error("D1_ERROR: overloaded"));
      const { error } = await inSpan(() => tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all());

      expect(String(error)).toContain("overloaded");
      expect(all).toHaveBeenCalledTimes(1);
    });

    it("never retries the run() write terminal even on a transient error", async () => {
      const run = vi.fn().mockRejectedValue(TRANSIENT());
      const { error } = await inSpan(() => tracedEnv(envWithStmt({ run })).DB!.prepare("UPDATE t SET x = 1").run());

      expect(String(error)).toContain("internal error");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("never retries a mutating RETURNING statement consumed via a read terminal", async () => {
      // DELETE/UPDATE ... RETURNING run through first/all/raw to consume rows;
      // re-running one after a commit would double-apply the write.
      const first = vi.fn().mockRejectedValue(TRANSIENT());
      const del = await inSpan(() =>
        tracedEnv(envWithStmt({ first })).DB!.prepare("DELETE FROM approvals WHERE id = ? RETURNING *").first(),
      );
      expect(String(del.error)).toContain("internal error");
      expect(first).toHaveBeenCalledTimes(1);

      const all = vi.fn().mockRejectedValue(TRANSIENT());
      const upd = await inSpan(() =>
        tracedEnv(envWithStmt({ all })).DB!.prepare("  UPDATE widgets SET claimed = 1 WHERE id = ? RETURNING *").all(),
      );
      expect(String(upd.error)).toContain("internal error");
      expect(all).toHaveBeenCalledTimes(1);
    });

    it("ignores the d1-retry-safe marker on a RETURNING write consumed via a read terminal", async () => {
      // The marker is a run()-terminal contract. A marked DELETE ... RETURNING
      // chained .first() is a write, not read-only, so it must NOT retry — the
      // marker alone does not make non-run terminals retryable.
      const first = vi.fn().mockRejectedValue(TRANSIENT());
      const { error } = await inSpan(() =>
        tracedEnv(envWithStmt({ first }))
          .DB!.prepare(`${D1_RETRY_SAFE_MARKER} DELETE FROM approvals WHERE id = ? RETURNING *`)
          .first(),
      );
      expect(String(error)).toContain("internal error");
      expect(first).toHaveBeenCalledTimes(1);
    });

    it("never retries batch() even on a transient error", async () => {
      const batch = vi.fn().mockRejectedValue(TRANSIENT());
      const stmt = {
        bind() {
          return this;
        },
      };
      const env = { DB: { prepare: () => stmt, batch } as unknown as D1Database };
      const db = tracedEnv(env).DB!;
      const { error } = await inSpan(() => db.batch([db.prepare("SELECT 1")]));
      expect(String(error)).toContain("internal error");
      expect(batch).toHaveBeenCalledTimes(1);
    });

    it("retries a d1-retry-safe run() on a transient error and tags the span", async () => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(TRANSIENT())
        .mockResolvedValue({ success: true, meta: { changes: 1 } });
      const { value, spans } = await inSpan(() =>
        tracedEnv(envWithStmt({ run }))
          .DB!.prepare(`${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO webhook_idempotency VALUES (?)`)
          .run(),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect((value as { meta: { changes: number } }).meta.changes).toBe(1);
      const span = spans.find((s) => s.name === "d1.run");
      expect(span?.status).toBe("ok");
      expect(span?.attributes["db.transient_retries"]).toBe(1);
    });

    it("does not retry a d1-retry-safe run() on an overload error", async () => {
      const run = vi.fn().mockRejectedValue(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."));
      const { error } = await inSpan(() =>
        tracedEnv(envWithStmt({ run }))
          .DB!.prepare(`${D1_RETRY_SAFE_MARKER} DELETE FROM webhook_idempotency WHERE idempotency_key = ?`)
          .run(),
      );

      expect(String(error)).toContain("overloaded");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("keeps the d1-retry-safe marker across bind()", async () => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(TRANSIENT())
        .mockResolvedValue({ success: true, meta: { changes: 0 } });
      const { value } = await inSpan(() =>
        tracedEnv(envWithStmt({ run }))
          .DB!.prepare(`${D1_RETRY_SAFE_MARKER} UPDATE cli_tokens SET last_used_at = ? WHERE id = ?`)
          .bind(1, 2)
          .run(),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect((value as { meta: { changes: number } }).meta.changes).toBe(0);
    });
  });

  describe("per-attempt read timeout", () => {
    function envWithStmt(stmt: Record<string, unknown>) {
      const full = {
        bind() {
          return this;
        },
        ...stmt,
      };
      return { DB: { prepare: () => full } as unknown as D1Database };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("treats a hung read attempt as a synthetic transient error and retries", async () => {
      vi.useFakeTimers();
      const hang = new Promise(() => {});
      const all = vi
        .fn()
        .mockReturnValueOnce(hang)
        .mockResolvedValue({ results: [{ n: 1 }], meta: {} });

      const root = startSpan("worker.fetch", { "request.id": "req-d1-timeout" });
      let spans = [] as ReturnType<typeof drainSpans>;
      const result = runInSpan(root, async () => {
        const value = await tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all();
        endSpan(root, "ok");
        spans = drainSpans();
        return value;
      });
      // 5s timeout fires the synthetic transient, then the 25ms retry backoff.
      await vi.advanceTimersByTimeAsync(5100);
      const value = await result;

      expect(all).toHaveBeenCalledTimes(2);
      expect((value as { results: unknown[] }).results).toEqual([{ n: 1 }]);
      const span = spans.find((s) => s.name === "d1.all");
      expect(span?.status).toBe("ok");
      expect(span?.attributes["db.transient_retries"]).toBe(1);
    });

    it("does not emit a late synthetic failure after a fast read settles", async () => {
      vi.useFakeTimers();
      const all = vi.fn().mockResolvedValue({ results: [{ n: 1 }], meta: {} });

      const root = startSpan("worker.fetch", { "request.id": "req-d1-fast" });
      await runInSpan(root, async () => {
        await tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all();
        endSpan(root, "ok");
        drainSpans();
      });

      // The per-attempt timer was cleared, so nothing is scheduled.
      expect(vi.getTimerCount()).toBe(0);
      expect(all).toHaveBeenCalledTimes(1);
    });

    it("tolerates a hung loser settling (or rejecting) after the retry wins", async () => {
      vi.useFakeTimers();
      let rejectLoser: (err: Error) => void = () => {};
      const loser = new Promise((_, reject) => {
        rejectLoser = reject;
      });
      const all = vi
        .fn()
        .mockReturnValueOnce(loser)
        .mockResolvedValue({ results: [{ n: 2 }], meta: {} });

      const root = startSpan("worker.fetch", { "request.id": "req-d1-loser" });
      const result = runInSpan(root, async () => {
        const value = await tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all();
        endSpan(root, "ok");
        drainSpans();
        return value;
      });
      await vi.advanceTimersByTimeAsync(5100);
      const value = await result;
      expect((value as { results: unknown[] }).results).toEqual([{ n: 2 }]);

      // The losing attempt rejects after the retry already returned; this must
      // not double-settle the call or surface as an unhandled rejection (the
      // test itself fails on unhandled rejections).
      rejectLoser(new Error("D1_ERROR: late loser failure"));
      await vi.advanceTimersByTimeAsync(0);
    });

    it("surfaces the synthetic timeout once hung attempts exhaust the budget", async () => {
      vi.useFakeTimers();
      const all = vi.fn().mockImplementation(() => new Promise(() => {}));

      const root = startSpan("worker.fetch", { "request.id": "req-d1-exhaust" });
      let spans = [] as ReturnType<typeof drainSpans>;
      let error: unknown;
      const result = runInSpan(root, async () => {
        try {
          await tracedEnv(envWithStmt({ all })).DB!.prepare("SELECT 1").all();
        } catch (err) {
          error = err;
        } finally {
          endSpan(root, "error");
          spans = drainSpans();
        }
      });
      // 4 hung attempts x 5s plus the 25/50/100ms backoffs.
      await vi.advanceTimersByTimeAsync(21000);
      await result;

      expect(all).toHaveBeenCalledTimes(4);
      expect(String(error)).toContain("synthetic per-attempt timeout");
      const span = spans.find((s) => s.name === "d1.all");
      expect(span?.status).toBe("error");
      expect(span?.attributes["db.transient_retries"]).toBe(3);
    });

    it("never applies the timeout to write terminals", async () => {
      vi.useFakeTimers();
      const run = vi.fn().mockImplementation(() => new Promise(() => {}));
      let settled = false;
      const root = startSpan("worker.fetch", { "request.id": "req-d1-write-hang" });
      void runInSpan(root, async () => {
        await tracedEnv(envWithStmt({ run })).DB!.prepare("UPDATE t SET x = 1").run();
        settled = true;
      });

      // Well past the read timeout: a hung write must keep hanging, never
      // race a synthetic timeout that would trigger a replay.
      await vi.advanceTimersByTimeAsync(60000);
      expect(settled).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      drainSpans();
    });
  });

  // PR3 Part A: setSpanAttributes mutates the active span context so attributes set from inside a
  // handler (e.g. the github.event / github.action webhook tags) land on the worker.fetch root span
  // when the router calls endSpan(rootSpan, ...).
  describe("setSpanAttributes", () => {
    it("merges attributes into the active span so endSpan records them on the root span", async () => {
      const root = startSpan("worker.fetch", { "http.route": "/api/webhooks/github" });
      let spans = [] as ReturnType<typeof drainSpans>;

      await runInSpan(root, async () => {
        setSpanAttributes({ "github.event": "check_run", "github.action": "completed" });
        endSpan(root, "ok", { "http.status_code": 200 });
        spans = drainSpans();
      });

      const fetchSpan = spans.find((span) => span.name === "worker.fetch");
      expect(fetchSpan?.attributes["github.event"]).toBe("check_run");
      expect(fetchSpan?.attributes["github.action"]).toBe("completed");
      expect(fetchSpan?.attributes["http.route"]).toBe("/api/webhooks/github");
      expect(fetchSpan?.attributes["http.status_code"]).toBe(200);
    });

    it("skips null/undefined values and is a no-op outside a span context", () => {
      // No active span context → must not throw.
      expect(() => setSpanAttributes({ "github.event": "status" })).not.toThrow();

      const root = startSpan("worker.fetch");
      let spans = [] as ReturnType<typeof drainSpans>;
      void runInSpan(root, () => {
        setSpanAttributes({
          "github.event": "status",
          "github.action": undefined,
          "github.skip": null as unknown as string,
        });
        endSpan(root, "ok");
        spans = drainSpans();
      });

      const fetchSpan = spans.find((span) => span.name === "worker.fetch");
      expect(fetchSpan?.attributes["github.event"]).toBe("status");
      expect("github.action" in (fetchSpan?.attributes ?? {})).toBe(false);
      expect("github.skip" in (fetchSpan?.attributes ?? {})).toBe(false);
    });
  });
});
