import { afterEach, describe, expect, it, vi } from "vitest";

const { postStructuredEventToDd, getMemoryAnalysisJob } = vi.hoisted(() => ({
  postStructuredEventToDd: vi.fn().mockResolvedValue(undefined),
  getMemoryAnalysisJob: vi.fn(),
}));

// Force the trace handler to throw so we exercise dispatchQueueBatch's top-level guard.
vi.mock("../../apps/control-plane-worker/src/observability/exporter", () => ({
  handleTraceQueue: vi.fn().mockRejectedValue(new Error("handler boom")),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd,
}));

// Override just getMemoryAnalysisJob to throw for one message; keep the rest of the DAO real.
vi.mock("../../apps/control-plane-worker/src/memory/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../apps/control-plane-worker/src/memory/db")>()),
  getMemoryAnalysisJob: (...args: unknown[]) => getMemoryAnalysisJob(...args),
}));

import { handleMemoryAnalysisQueue } from "../../apps/control-plane-worker/src/memory/service";
import { dispatchQueueBatch } from "../../apps/control-plane-worker/src/queue-dispatch";
import type { Env } from "../../apps/control-plane-worker/src/types";

type FakeMessage = { id: string; body: unknown; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };

function makeBatch(queue: string, bodies: unknown[]) {
  const messages: FakeMessage[] = bodies.map((body, i) => ({
    id: `msg-${i}`,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: {
      queue,
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    messages,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchQueueBatch top-level guard", () => {
  it("reports to Datadog and retries the batch when a handler throws", async () => {
    const { batch } = makeBatch("cycloid-traces", [{ spans: [] }]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatchQueueBatch(batch as unknown as MessageBatch, { DD_API_KEY: "k", WORKER_ENV: "test" } as Env);

    expect(batch.retryAll).toHaveBeenCalledTimes(1);
    expect(postStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "queue.batch_failed", queue: "cycloid-traces" }),
    );
  });

  it("still retries the batch when the Datadog post itself throws", async () => {
    postStructuredEventToDd.mockRejectedValueOnce(new Error("dd boom"));
    const { batch } = makeBatch("cycloid-traces", [{ spans: [] }]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatchQueueBatch(batch as unknown as MessageBatch, { DD_API_KEY: "k", WORKER_ENV: "test" } as Env);

    // The DD post throwing must not skip the retry guarantee.
    expect(batch.retryAll).toHaveBeenCalledTimes(1);
  });
});

describe("handleMemoryAnalysisQueue per-message isolation", () => {
  it("retries only the throwing message and still processes the rest of the batch", async () => {
    getMemoryAnalysisJob.mockImplementation(async (_db: unknown, jobId: string) => {
      if (jobId === "bad") throw new Error("d1 boom");
      return null; // job-not-found -> processor acks
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { batch, messages } = makeBatch("cycloid-memory-analysis", [{ jobId: "bad" }, { jobId: "ok" }]);

    await handleMemoryAnalysisQueue(batch as never, {} as Env);

    expect(messages[0].retry).toHaveBeenCalledTimes(1);
    expect(messages[0].ack).not.toHaveBeenCalled();
    // The second message was still processed despite the first throwing.
    expect(messages[1].ack).toHaveBeenCalledTimes(1);
    expect(messages[1].retry).not.toHaveBeenCalled();
  });
});
