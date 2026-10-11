import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchQueueBatch } from "../../apps/control-plane-worker/src/queue-dispatch.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";

function makeBatch(queue: string, messages: unknown[] = []) {
  return {
    queue,
    messages: messages.map((body, index) => ({
      id: `msg-${index}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
    })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch & { ackAll: ReturnType<typeof vi.fn>; retryAll: ReturnType<typeof vi.fn> };
}

describe("workerd queue dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acks and drops unknown queues under the Workers runtime", async () => {
    const batch = makeBatch("cycloid-unknown");

    await dispatchQueueBatch(batch, { WORKER_ENV: "test" } as Env);

    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it("dispatches a configured trace queue batch under the Workers runtime", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const batch = makeBatch("cycloid-traces", [
      {
        service: "cycloid-control-plane",
        env: "test",
        spans: [
          {
            traceId: "trace-workerd",
            spanId: "span-workerd",
            parentSpanId: null,
            name: "worker.fetch",
            startTimeMs: 1,
            durationMs: 1,
            attributes: {},
            status: "ok",
          },
        ],
      },
    ]);

    await dispatchQueueBatch(batch, { DD_API_KEY: "dd-api-key", WORKER_ENV: "test" } as Env);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it("retries a configured queue batch when a handler throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const batch = makeBatch("cycloid-traces", [{ malformed: true }]);

    await dispatchQueueBatch(batch, { DD_API_KEY: "dd-api-key", WORKER_ENV: "test" } as Env);

    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(batch.retryAll).toHaveBeenCalledTimes(1);
  });
});
