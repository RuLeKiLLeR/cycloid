import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ObservabilityContext = typeof import("../../apps/control-plane-worker/src/observability/context");
type ObservabilityExporter = typeof import("../../apps/control-plane-worker/src/observability/exporter");

let endSpan: ObservabilityContext["endSpan"];
let runInSpan: ObservabilityContext["runInSpan"];
let startSpan: ObservabilityContext["startSpan"];
let flushSpansToQueue: ObservabilityExporter["flushSpansToQueue"];
let handleTraceQueue: ObservabilityExporter["handleTraceQueue"];
let traceQueueMessagesToLogEntries: ObservabilityExporter["traceQueueMessagesToLogEntries"];

type TestSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error";
};

type TestTraceQueueMessage = {
  spans: TestSpan[];
  service: string;
  env: string;
};

function makeSpan(overrides: Partial<TestSpan> = {}): TestSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    name: "worker.fetch",
    startTimeMs: Date.now(),
    durationMs: 5,
    attributes: { "session.id": "sess-1" },
    status: "ok",
    ...overrides,
  };
}

function makeBatch(spans: TestSpan[] = [makeSpan()]): MessageBatch<TestTraceQueueMessage> {
  return makeBatchFromMessages([
    {
      service: "cycloid-control-plane",
      env: "test",
      spans,
    },
  ]);
}

function makeBatchFromMessages(messages: TestTraceQueueMessage[]): MessageBatch<TestTraceQueueMessage> {
  return {
    messages: messages.map((body) => ({ body })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<TestTraceQueueMessage>;
}

describe("observability exporter", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ endSpan, runInSpan, startSpan } = await import("../../apps/control-plane-worker/src/observability/context"));
    ({ flushSpansToQueue, handleTraceQueue, traceQueueMessagesToLogEntries } =
      await import("../../apps/control-plane-worker/src/observability/exporter"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs trace-correlated queue enqueue diagnostics", async () => {
    const queue = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    const rootSpan = startSpan("worker.fetch", { "session.id": "sess-1" });
    await runInSpan(rootSpan, async () => {
      const promptSpan = startSpan("prompt.finalize", { "prompt.id": "prompt-1" });
      endSpan(promptSpan, "ok");
      await flushSpansToQueue(queue, "cycloid-control-plane", "test");
    });

    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "cycloid-control-plane",
        env: "test",
        spans: [
          expect.objectContaining({
            name: "prompt.finalize",
            traceId: expect.any(String),
            spanId: expect.any(String),
          }),
        ],
      }),
    );
    const enqueueLog = consoleInfo.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => entry.event === "trace_queue_enqueue");
    expect(enqueueLog).toMatchObject({
      event: "trace_queue_enqueue",
      service: "cycloid-control-plane",
      env: "test",
      spanCount: 1,
      traceId: expect.any(String),
      spanId: expect.any(String),
    });
  });

  it("exports late background spans when a second flush runs after the request drain", async () => {
    const queue = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const rootSpan = startSpan("worker.fetch", { "session.id": "sess-1" });
    await runInSpan(rootSpan, async () => {
      await flushSpansToQueue(queue, "cycloid-session-do", "test");
      await Promise.resolve();

      const lateSpan = startSpan("prompt.finalize", { "prompt.id": "prompt-1" });
      endSpan(lateSpan, "ok");
      await flushSpansToQueue(queue, "cycloid-session-do", "test");
    });

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "cycloid-session-do",
        env: "test",
        spans: [
          expect.objectContaining({
            name: "prompt.finalize",
            traceId: expect.any(String),
            spanId: expect.any(String),
          }),
        ],
      }),
    );
  });

  it("warns about a missing trace queue only once per isolate", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const firstRootSpan = startSpan("worker.fetch", { "session.id": "sess-1" });
    await runInSpan(firstRootSpan, async () => {
      const promptSpan = startSpan("prompt.finalize", { "prompt.id": "prompt-1" });
      endSpan(promptSpan, "ok");
      await flushSpansToQueue(undefined, "cycloid-session-do", "test");
    });

    const secondRootSpan = startSpan("worker.fetch", { "session.id": "sess-2" });
    await runInSpan(secondRootSpan, async () => {
      const promptSpan = startSpan("prompt.finalize", { "prompt.id": "prompt-2" });
      endSpan(promptSpan, "ok");
      await flushSpansToQueue(undefined, "cycloid-session-do", "test");
    });

    expect(consoleWarn).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenNthCalledWith(
      1,
      "[exporter] TRACE_QUEUE binding missing — spans will not be exported",
    );
    expect(JSON.parse(String(consoleWarn.mock.calls[1]?.[0]))).toMatchObject({
      event: "trace_queue_enqueue_skipped",
      service: "cycloid-session-do",
      env: "test",
      spanCount: 1,
      reason: "missing_queue_binding",
    });
  });

  it("logs export summaries with trace correlation on successful Datadog logs export", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const batch = makeBatchFromMessages([
      {
        service: "cycloid-control-plane",
        env: "test",
        spans: [makeSpan({ attributes: { "session.id": "sess-1", "prompt.id": "prompt-1" } })],
      },
    ]);

    await handleTraceQueue(batch, {
      DD_API_KEY: "dd-api-key",
      DD_SITE: "datadoghq.com",
    } as never);

    expect(batch.ackAll).toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");

    const exportLog = consoleInfo.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => entry.event === "trace_queue_export");
    expect(exportLog).toMatchObject({
      event: "trace_queue_export",
      exportPath: "dd_logs",
      exportMode: "dd_logs",
      spanCount: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      session_id: "sess-1",
      prompt_id: "prompt-1",
      session_ids: ["sess-1"],
      prompt_ids: ["prompt-1"],
      logsConfigured: true,
      attempts: {
        ddLogs: {
          ok: true,
          endpoint: {
            host: "http-intake.logs.us5.datadoghq.com",
            path: "/api/v2/logs",
          },
          itemCount: 1,
          status: 202,
          chunkCount: 1,
        },
      },
    });
    expect(exportLog).not.toHaveProperty("apmIngestVerified");
    expect(exportLog).not.toHaveProperty("fallbackReason");
    expect(exportLog).not.toHaveProperty("collectorReady");
  });

  it("serializes span attributes with a span. prefix so cf_ip/asn become @span.cf_ip/@span.asn in Datadog", async () => {
    // Manual abuse triage depends on a `cf_ip` span attribute landing in
    // Datadog as the field `span.cf_ip` (queried as `@span.cf_ip`), not bare
    // `cf_ip`, so the exporter must preserve the `@span.`-prefixed contract.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const batch = makeBatchFromMessages([
      {
        service: "cycloid-control-plane",
        env: "test",
        spans: [
          makeSpan({
            attributes: { "http.status_code": 401, cf_ip: "203.0.113.7", asn: 13335 },
          }),
        ],
      },
    ]);

    await handleTraceQueue(batch, { DD_API_KEY: "dd-api-key", DD_SITE: "datadoghq.com" } as never);

    const body = fetchSpy.mock.calls[0]?.[1]?.body;
    const entries = JSON.parse(String(body)) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      "span.cf_ip": "203.0.113.7",
      "span.asn": 13335,
      "span.http.status_code": 401,
    });
    expect(entries[0]).not.toHaveProperty("cf_ip");
    expect(entries[0]).not.toHaveProperty("asn");
  });

  it("redacts secret-looking span attribute values before Datadog log export", () => {
    const entries = traceQueueMessagesToLogEntries([
      {
        service: "cycloid-control-plane",
        env: "test",
        spans: [
          makeSpan({
            attributes: {
              "http.url": "https://api.example.test/path?token=github_pat_1234567890abcdefSECRET",
              "error.message": "upstream failed: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz",
              "db.url": "postgres://user:pass@example.test/db",
              "session.id": "sess-1",
            },
          }),
        ],
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain("github_pat_1234567890abcdefSECRET");
    expect(JSON.stringify(entries[0])).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(entries[0])).not.toContain("postgres://user:pass@example.test/db");
    expect(entries[0]).toMatchObject({
      "span.http.url": "https://api.example.test/path?token=[REDACTED]",
      "span.error.message": "upstream failed: [REDACTED]",
      "span.db.url": "[REDACTED]",
      "span.session.id": "sess-1",
    });
  });

  it("records representative and distinct prompt correlation on export summaries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const batch = makeBatchFromMessages([
      {
        service: "cycloid-control-plane",
        env: "test",
        spans: [
          makeSpan({
            spanId: "1".repeat(16),
            attributes: { "session.id": "sess-1", "prompt.id": "prompt-1" },
          }),
        ],
      },
      {
        service: "cycloid-session-do",
        env: "test",
        spans: [
          makeSpan({
            spanId: "2".repeat(16),
            attributes: { "session.id": "sess-1", "prompt.id": "prompt-2" },
          }),
          makeSpan({
            spanId: "3".repeat(16),
            attributes: { "session.id": "sess-2" },
          }),
        ],
      },
    ]);

    await handleTraceQueue(batch, {
      DD_API_KEY: "dd-api-key",
      DD_SITE: "datadoghq.com",
    } as never);

    const exportLog = consoleInfo.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => entry.event === "trace_queue_export");
    expect(exportLog).toMatchObject({
      event: "trace_queue_export",
      session_id: "sess-1",
      prompt_id: "prompt-1",
      session_ids: ["sess-1", "sess-2"],
      prompt_ids: ["prompt-1", "prompt-2"],
    });
  });

  it("acks chunked Datadog Logs export only after all chunks succeed", async () => {
    const spans = Array.from({ length: 101 }, (_, index) =>
      makeSpan({
        spanId: index.toString(16).padStart(16, "0"),
        name: `worker.fetch.${index}`,
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const batch = makeBatch(spans);

    await handleTraceQueue(batch, {
      DD_API_KEY: "dd-api-key",
      DD_SITE: "datadoghq.com",
      WORKER_ENV: "test",
    } as never);

    expect(batch.ackAll).toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const firstLogsChunk = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const secondLogsChunk = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(firstLogsChunk).toHaveLength(100);
    expect(secondLogsChunk).toHaveLength(1);

    const exportLog = consoleInfo.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => entry.event === "trace_queue_export");
    expect(exportLog).toMatchObject({
      exportPath: "dd_logs",
      exportMode: "dd_logs",
      spanCount: 101,
      attempts: {
        ddLogs: {
          ok: true,
          status: 202,
          itemCount: 101,
          chunkCount: 2,
        },
      },
    });
  });

  it("retries the batch when a Datadog Logs chunk fails and records the failed chunk", async () => {
    const spans = Array.from({ length: 101 }, (_, index) =>
      makeSpan({
        spanId: index.toString(16).padStart(16, "0"),
        name: `worker.fetch.${index}`,
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response("second chunk rejected", { status: 429, statusText: "Too Many Requests" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = makeBatch(spans);

    await handleTraceQueue(batch, {
      DD_API_KEY: "dd-api-key",
      DD_SITE: "datadoghq.com",
      WORKER_ENV: "test",
    } as never);

    expect(batch.retryAll).toHaveBeenCalled();
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const failureLog = consoleError.mock.calls
      .map(([entry]) => {
        try {
          return JSON.parse(String(entry));
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === "trace_queue_export_failed");
    expect(failureLog).toMatchObject({
      event: "trace_queue_export_failed",
      exportPath: "dd_logs",
      exportMode: "failed",
      spanCount: 101,
      attempts: {
        ddLogs: {
          ok: false,
          status: 429,
          bodyPreview: "second chunk rejected",
          itemCount: 101,
          chunkCount: 2,
          failedChunk: 2,
        },
      },
    });
    expect(failureLog).not.toHaveProperty("apmIngestVerified");
    expect(failureLog).not.toHaveProperty("fallbackReason");
  });

  it("retries the batch and still emits a fail-open direct-post event on export failure", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error("dd intake down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const batch = makeBatch();

    await handleTraceQueue(batch, {
      DD_API_KEY: "dd-api-key",
      DD_SITE: "datadoghq.com",
      WORKER_ENV: "test",
    } as never);

    expect(batch.retryAll).toHaveBeenCalled();
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const directPostBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(directPostBody).toHaveLength(1);
    expect(directPostBody[0]).toMatchObject({
      service: "cycloid-control-plane",
      _direct_post: true,
      event: "trace_queue_export_failed",
      exportPath: "dd_logs",
      exportMode: "failed",
      spanCount: 1,
      "dd.trace_id": "a".repeat(32),
      "dd.span_id": "b".repeat(16),
      attempts: {
        ddLogs: {
          ok: false,
          status: 500,
          itemCount: 1,
          chunkCount: 1,
          failedChunk: 1,
        },
      },
    });

    const failureLog = consoleError.mock.calls
      .map(([entry]) => {
        try {
          return JSON.parse(String(entry));
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === "trace_queue_export_failed");
    expect(failureLog).toMatchObject({
      event: "trace_queue_export_failed",
      exportPath: "dd_logs",
      exportMode: "failed",
      spanCount: 1,
      "dd.trace_id": "a".repeat(32),
      "dd.span_id": "b".repeat(16),
      attempts: {
        ddLogs: {
          ok: false,
          status: 500,
          itemCount: 1,
          chunkCount: 1,
          failedChunk: 1,
        },
      },
    });
    expect(consoleWarn).toHaveBeenCalledWith("[events-exporter] direct-POST failed:", "Error: dd intake down");
  });
});
