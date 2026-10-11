import { stringifyError } from "../../../../shared/utils/errors.js";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";

export type MemoryContextMetricEventName =
  | "memory_context.query_started"
  | "memory_context.candidates_generated"
  | "memory_context.vector_unavailable"
  | "memory_context.selector_returned"
  | "memory_context.selector_returned_empty"
  | "memory_context.work_processed"
  | "memory_context.feedback_upvoted"
  | "memory_context.feedback_downvoted";

export type MemoryContextMetricEvent = {
  event: MemoryContextMetricEventName;
  traceId?: string;
  businessId?: string;
  sessionId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  mode?: string;
  candidateCount?: number;
  selectedCount?: number;
  selectorStatus?: string;
  selectorLatencyMs?: number | null;
  failureCode?: "timeout" | "upstream_5xx" | "schema_invalid" | "aborted" | "other";
  vectorUnavailableReason?: string | null;
  laneCounts?: Record<string, number>;
  claimed?: number;
  completed?: number;
  failed?: number;
  retried?: number;
  memoryId?: string;
  rating?: "up" | "down";
  usageSource?: string;
};

export interface MemoryContextMetricSink {
  emit(event: MemoryContextMetricEvent): void;
}

export interface MemoryContextMetricOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  emit?: (env: Env, event: MemoryContextMetricEvent) => Promise<unknown>;
}

export function createMemoryContextMetricSink(
  env: Env,
  options: MemoryContextMetricOptions = {},
): MemoryContextMetricSink {
  const emit = options.emit ?? postStructuredEventToDd;
  return {
    emit(event) {
      const promise = emit(env, event).catch((error) => {
        console.warn("[memory-context-metrics] emit failed", stringifyError(error));
      });
      if (options.waitUntil) {
        options.waitUntil(promise);
      } else {
        void promise;
      }
    },
  };
}
