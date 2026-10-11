import type { MemoryRefineQueueMessage } from "./company-memory/refine";
import { handleMemoryRefineQueue } from "./company-memory/refine";
import { createLogger } from "./logger";
import type { MemoryAnalysisQueueMessage } from "./memory/service";
import { handleMemoryAnalysisQueue } from "./memory/service";
import { postStructuredEventToDd } from "./observability/events-exporter";
import type { TraceQueueMessage } from "./observability/exporter";
import { handleTraceQueue } from "./observability/exporter";
import { handleSandboxLayerBuildQueue } from "./sandbox/layer-builds";
import type { Env, SandboxLayerBuildQueueMessage } from "./types";

const queueLog = createLogger({ bindings: { component: "queue" } });

type QueueHandler = (batch: MessageBatch, env: Env) => Promise<void>;

/**
 * Every queue with a consumer entry in wrangler.toml (top-level and env.qa)
 * must resolve to a handler here; unknown batches are acked and dropped.
 * tests/test_cloudflare/queue-dispatch.test.ts enforces that coverage.
 */
export function queueHandlerFor(queueName: string): QueueHandler | null {
  switch (queueName) {
    case "cycloid-traces":
    case "cycloid-traces-qa":
      return (batch, env) => handleTraceQueue(batch as MessageBatch<TraceQueueMessage>, env);
    case "cycloid-memory-analysis":
    case "cycloid-memory-analysis-qa":
      return (batch, env) => handleMemoryAnalysisQueue(batch as MessageBatch<MemoryAnalysisQueueMessage>, env);
    case "cycloid-memory-refine":
    case "cycloid-memory-refine-qa":
      return (batch, env) => handleMemoryRefineQueue(batch as MessageBatch<MemoryRefineQueueMessage>, env);
    case "cycloid-sandbox-layer-builds":
    case "cycloid-sandbox-layer-builds-qa":
      return (batch, env) => handleSandboxLayerBuildQueue(batch as MessageBatch<SandboxLayerBuildQueueMessage>, env);
    default:
      return null;
  }
}

export async function dispatchQueueBatch(batch: MessageBatch, env: Env): Promise<void> {
  const handler = queueHandlerFor(batch.queue);
  if (!handler) {
    queueLog.error({ queue: batch.queue }, "Unknown queue");
    batch.ackAll();
    return;
  }
  try {
    await handler(batch, env);
  } catch (err) {
    // A handler that throws past its own per-message guards would otherwise let
    // the whole batch fail unobserved. Log + report to Datadog (console logs are
    // not shipped) and retry the batch so messages are not silently dropped.
    queueLog.error({ queue: batch.queue, error: String(err) }, "Queue batch handler threw");
    // Keep the retry guarantee unconditional: a throw from the Datadog post must
    // not skip retryAll() and silently fall back to Cloudflare's implicit
    // retry-on-throw, which would also lose this explicit telemetry.
    try {
      await postStructuredEventToDd(env, {
        event: "queue.batch_failed",
        queue: batch.queue,
        messageCount: batch.messages.length,
        error: String(err),
      });
    } catch (ddErr) {
      queueLog.error({ queue: batch.queue, error: String(ddErr) }, "Failed to post queue.batch_failed to Datadog");
    }
    batch.retryAll();
  }
}
