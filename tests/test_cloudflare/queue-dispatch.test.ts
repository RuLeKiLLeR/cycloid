import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchQueueBatch, queueHandlerFor } from "../../apps/control-plane-worker/src/queue-dispatch";
import type { Env } from "../../apps/control-plane-worker/src/types";

const WRANGLER_TOML = path.join(__dirname, "../../apps/control-plane-worker/wrangler.toml");

function consumerQueuesFromWranglerToml(): string[] {
  const lines = readFileSync(WRANGLER_TOML, "utf8").split("\n");
  const queues: string[] = [];
  let inConsumerBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inConsumerBlock = /^\[\[(env\.[a-z0-9_-]+\.)?queues\.consumers\]\]$/.test(line);
      continue;
    }
    if (!inConsumerBlock) continue;
    const match = line.match(/^queue\s*=\s*"([^"]+)"/);
    if (match) queues.push(match[1]);
  }
  return queues;
}

function makeBatch(queue: string, messages: unknown[] = []) {
  return {
    queue,
    messages: messages.map((body, index) => ({ id: `msg-${index}`, timestamp: new Date(0), body, attempts: 1 })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch & { ackAll: ReturnType<typeof vi.fn>; retryAll: ReturnType<typeof vi.fn> };
}

describe("queue dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a handler for every consumer queue declared in wrangler.toml", () => {
    const queues = consumerQueuesFromWranglerToml();
    // Sanity: parsing found both the prod and QA consumer blocks.
    expect(queues).toContain("cycloid-traces");
    expect(queues).toContain("cycloid-traces-qa");
    for (const queue of queues) {
      expect(queueHandlerFor(queue), `consumer queue "${queue}" has no dispatch handler`).not.toBeNull();
    }
  });

  it("acks and drops batches from unknown queues", async () => {
    const batch = makeBatch("cycloid-nonexistent");
    await dispatchQueueBatch(batch, {} as Env);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
  });

  it("routes cycloid-traces-qa batches to the trace exporter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const batch = makeBatch("cycloid-traces-qa", [
      {
        service: "cycloid-control-plane",
        env: "qa",
        spans: [
          {
            traceId: "trace-1",
            spanId: "span-1",
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

    await dispatchQueueBatch(batch, { DD_API_KEY: "dd-api-key" } as never);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(batch.retryAll).not.toHaveBeenCalled();
  });
});
