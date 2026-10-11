/**
 * Trace exporter via Cloudflare Queues.
 *
 * The same worker acts as both producer and consumer.
 * CRITICAL: The queue handler must NOT create spans or enqueue trace data
 * to prevent self-recursion.
 *
 * Spans are exported to the Datadog Logs API as structured log entries with
 * dd.trace_id/dd.span_id correlation.
 */
import { traceLogFields } from "../../../../shared/observability/logger.js";
import { redactSecretsInValue } from "../../../../shared/observability/redact.js";
import { DD_DEFAULT_SITE, DD_HOSTNAME, DD_SOURCE } from "../constants/observability";
import type { Env } from "../types";
import type { CompletedSpan } from "./context";
import { drainSpans, runInExporterContext } from "./context";
import type { DatadogLogsPostResult, ExportEndpointMetadata } from "./events-exporter";
import { endpointMetadata, postDatadogLogs, postStructuredEventToDd } from "./events-exporter";

// Suppress repeat warnings within a single isolate lifetime.
// In production, each isolate may log once on startup — this is expected.
let queueMissingWarned = false;
let noExportPathWarned = false;

const DD_LOGS_CHUNK_SIZE = 100;

export interface TraceQueueMessage {
  spans: CompletedSpan[];
  service: string;
  env: string;
}

interface TraceExportAttempt {
  ok: boolean;
  endpoint: ExportEndpointMetadata;
  itemCount?: number;
  status?: number;
  statusText?: string;
  bodyPreview?: string;
  error?: string;
  skipped?: DatadogLogsPostResult["skipped"];
  chunkCount?: number;
  failedChunk?: number;
}

type TraceExportMode = "dd_logs" | "failed";

function stringSpanAttribute(span: CompletedSpan | undefined, key: string): string | null {
  const value = span?.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function distinctStringSpanAttributes(messages: TraceQueueMessage[], key: string): string[] {
  const values = new Set<string>();
  for (const msg of messages) {
    for (const span of msg.spans) {
      const value = stringSpanAttribute(span, key);
      if (value) values.add(value);
    }
  }
  return Array.from(values);
}

function spanCorrelationDiagnostics(
  messages: TraceQueueMessage[],
  representativeSpan: CompletedSpan | undefined,
): Record<string, unknown> {
  return {
    session_id: stringSpanAttribute(representativeSpan, "session.id"),
    prompt_id: stringSpanAttribute(representativeSpan, "prompt.id"),
    session_ids: distinctStringSpanAttributes(messages, "session.id"),
    prompt_ids: distinctStringSpanAttributes(messages, "prompt.id"),
  };
}

function buildExporterEvent(
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    level,
    ts: Date.now(),
    event,
    ...payload,
  };
}

function emitExporterEvent(level: "info" | "warn" | "error", entry: Record<string, unknown>): void {
  const serialized = JSON.stringify(entry);

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.info(serialized);
}

function logExporterEvent(level: "info" | "warn" | "error", event: string, payload: Record<string, unknown>): void {
  emitExporterEvent(level, buildExporterEvent(level, event, payload));
}

async function logAndPostExporterEvent(
  env: Env,
  level: "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entry = buildExporterEvent(level, event, payload);
  emitExporterEvent(level, entry);
  await postStructuredEventToDd(env, entry);
  return entry;
}

/**
 * Enqueue completed spans to the trace queue. Call at the end of each
 * request/invocation. No-ops if queue binding is absent.
 *
 * Returns a Promise so the caller can pass it to ctx.waitUntil() for
 * durable delivery. The promise never rejects.
 */
export function flushSpansToQueue(
  queue: { send(message: unknown): Promise<unknown> } | undefined,
  service: string,
  env: string,
): Promise<void> {
  const spans = drainSpans();
  if (spans.length === 0) return Promise.resolve();
  const representativeTraceId = spans[0]?.traceId ?? null;
  const representativeSpanId = spans[0]?.spanId ?? null;

  if (!queue) {
    if (!queueMissingWarned) {
      queueMissingWarned = true;
      console.warn("[exporter] TRACE_QUEUE binding missing — spans will not be exported");
      logExporterEvent("warn", "trace_queue_enqueue_skipped", {
        service,
        env,
        spanCount: spans.length,
        traceId: representativeTraceId,
        spanId: representativeSpanId,
        reason: "missing_queue_binding",
      });
    }
    return Promise.resolve();
  }

  const msg: TraceQueueMessage = { spans, service, env };
  logExporterEvent("info", "trace_queue_enqueue", {
    service,
    env,
    spanCount: spans.length,
    traceId: representativeTraceId,
    spanId: representativeSpanId,
  });
  return queue
    .send(msg)
    .then(() => undefined)
    .catch((err) => {
      console.error("[exporter] queue flush failed:", err);
      logExporterEvent("error", "trace_queue_enqueue_failed", {
        service,
        env,
        spanCount: spans.length,
        traceId: representativeTraceId,
        spanId: representativeSpanId,
        error: String(err),
      });
    });
}

/**
 * Convert spans to Datadog Log entries with trace correlation.
 * Each span becomes a structured log entry that appears in Datadog Logs
 * and can be linked to RUM traces via dd.trace_id.
 */
export function traceQueueMessagesToLogEntries(messages: TraceQueueMessage[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];

  for (const msg of messages) {
    for (const span of msg.spans) {
      entries.push({
        ddsource: DD_SOURCE,
        ddtags: `env:${msg.env},service:${msg.service}`,
        hostname: DD_HOSTNAME,
        service: msg.service,
        message: `[span] ${span.name}`,
        ...traceLogFields(span, { includeParentSpanId: true }),
        "span.name": span.name,
        "span.duration_ms": span.durationMs,
        "span.status": span.status,
        "span.start_ms": span.startTimeMs,
        ...Object.fromEntries(Object.entries(span.attributes).map(([k, v]) => [`span.${k}`, redactSecretsInValue(v)])),
      });
    }
  }

  return entries;
}

function withChunkMetadata(result: DatadogLogsPostResult, chunkCount: number, itemCount: number): TraceExportAttempt {
  return {
    ok: result.ok,
    endpoint: result.endpoint,
    itemCount,
    status: result.status,
    statusText: result.statusText,
    bodyPreview: result.bodyPreview,
    error: result.error,
    skipped: result.skipped,
    chunkCount,
  };
}

async function postLogs(env: Env, messages: TraceQueueMessage[]): Promise<TraceExportAttempt> {
  const logEntries = traceQueueMessagesToLogEntries(messages);
  const chunkCount = Math.ceil(logEntries.length / DD_LOGS_CHUNK_SIZE);
  let lastResult: DatadogLogsPostResult | null = null;

  for (let chunkStart = 0; chunkStart < logEntries.length; chunkStart += DD_LOGS_CHUNK_SIZE) {
    const chunk = logEntries.slice(chunkStart, chunkStart + DD_LOGS_CHUNK_SIZE);
    const result = await postDatadogLogs(env, chunk);
    lastResult = result;
    if (!result.ok) {
      return {
        ...withChunkMetadata(result, chunkCount, logEntries.length),
        failedChunk: Math.floor(chunkStart / DD_LOGS_CHUNK_SIZE) + 1,
      };
    }
  }

  if (lastResult) {
    return withChunkMetadata(lastResult, chunkCount, logEntries.length);
  }

  return {
    ok: true,
    endpoint: endpointMetadata(`https://http-intake.logs.${DD_DEFAULT_SITE}/api/v2/logs`),
    itemCount: 0,
    chunkCount: 0,
  };
}

/**
 * Queue consumer handler. Exports batched spans to Datadog Logs as
 * structured logs with dd.trace_id/dd.span_id correlation.
 *
 * Runs inside exporter context so tracing wrappers no-op.
 */
export async function handleTraceQueue(batch: MessageBatch<TraceQueueMessage>, env: Env): Promise<void> {
  await runInExporterContext(async () => {
    const ddApiKey = env.DD_API_KEY;

    if (!ddApiKey) {
      if (!noExportPathWarned) {
        noExportPathWarned = true;
        console.warn("[exporter] No export path available (DD_API_KEY absent)");
      }
      batch.ackAll();
      return;
    }

    const messages = batch.messages.map((m) => m.body);
    const totalSpans = messages.reduce((sum, m) => sum + m.spans.length, 0);
    if (totalSpans === 0) {
      batch.ackAll();
      return;
    }
    const representativeSpan = messages.flatMap((m) => m.spans)[0];

    const logsAttempt = await postLogs(env, messages);
    const exportMode: TraceExportMode = logsAttempt.ok ? "dd_logs" : "failed";
    const exportDiagnostics = {
      exportPath: "dd_logs",
      exportMode,
      spanCount: totalSpans,
      traceId: representativeSpan?.traceId ?? null,
      spanId: representativeSpan?.spanId ?? null,
      ...spanCorrelationDiagnostics(messages, representativeSpan),
      logsConfigured: true,
      attempts: { ddLogs: logsAttempt },
    };

    if (logsAttempt.ok) {
      batch.ackAll();
      await logAndPostExporterEvent(env, "info", "trace_queue_export", exportDiagnostics);
    } else {
      console.error("[exporter] Trace export failed");
      const exportFailureEvent = buildExporterEvent("error", "trace_queue_export_failed", {
        ...exportDiagnostics,
        ...traceLogFields(representativeSpan),
      });
      emitExporterEvent("error", exportFailureEvent);
      await postStructuredEventToDd(env, exportFailureEvent);
      batch.retryAll();
    }
  });
}
