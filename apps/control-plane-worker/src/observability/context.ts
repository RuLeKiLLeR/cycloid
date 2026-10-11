/**
 * Span context via AsyncLocalStorage for Cloudflare Workers.
 *
 * nodejs_compat is already enabled (wrangler.toml line 4).
 * ALS propagates through async/await within a single Worker invocation
 * but NOT across DO stubs or Service Bindings — those need explicit
 * traceparent header passing.
 */
import { AsyncLocalStorage } from "async_hooks";

import {
  generateSpanId as generateSharedSpanId,
  generateTraceId as generateSharedTraceId,
  parseTraceparent,
  serializeTraceparent,
  type SpanAttributes,
  type SpanAttributeValue,
} from "../../../../shared/observability/trace.js";

interface SpanContext {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  parentSpanId: string | null;
  attributes: SpanAttributes;
  isExporterContext?: boolean;
  pendingSpans: CompletedSpan[];
}

export interface SpanHandle {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  startTime: number;
  attributes: SpanAttributes;
}

export interface CompletedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  durationMs: number;
  attributes: SpanAttributes;
  status: "ok" | "error";
}

const spanStorage = new AsyncLocalStorage<SpanContext>();

type NullableSpanAttributes = Record<string, SpanAttributeValue | null | undefined>;

export function generateTraceId(): string {
  return generateSharedTraceId();
}

export function generateSpanId(excluded?: string): string {
  return generateSharedSpanId(excluded);
}

export function currentContext(): SpanContext | undefined {
  return spanStorage.getStore();
}

function isExporter(): boolean {
  return spanStorage.getStore()?.isExporterContext === true;
}

export function startSpan(name: string, attributes: SpanAttributes = {}): SpanHandle {
  if (isExporter()) {
    return { name, spanId: "0".repeat(16), traceId: "0".repeat(32), parentSpanId: null, startTime: 0, attributes };
  }

  const parent = spanStorage.getStore();
  const traceId = parent?.traceId ?? generateTraceId();
  const spanId = generateSpanId(parent?.spanId);

  return {
    name,
    spanId,
    traceId,
    parentSpanId: parent?.spanId ?? null,
    startTime: Date.now(),
    attributes: { ...attributes },
  };
}

/**
 * Merge attributes into the current span context. `runInSpan` shares the same
 * attributes object as the span handle, so attributes set here are picked up by
 * `endSpan(handle, ...)` (it reads `handle.attributes`). No-op outside a span /
 * inside exporter context. Skips null/undefined values to match RouteSpanRecorder.
 */
export function setSpanAttributes(attributes: NullableSpanAttributes): void {
  const ctx = spanStorage.getStore();
  if (!ctx || ctx.isExporterContext) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    ctx.attributes[key] = value;
  }
}

export function endSpan(handle: SpanHandle, status: "ok" | "error", extraAttributes?: SpanAttributes): void {
  if (isExporter() || handle.startTime === 0) return;

  const completed: CompletedSpan = {
    traceId: handle.traceId,
    spanId: handle.spanId,
    parentSpanId: handle.parentSpanId,
    name: handle.name,
    startTimeMs: handle.startTime,
    durationMs: Date.now() - handle.startTime,
    attributes: { ...handle.attributes, ...extraAttributes },
    status,
  };
  const ctx = spanStorage.getStore();
  if (!ctx || ctx.isExporterContext) return;
  ctx.pendingSpans.push(completed);
}

/**
 * Run a function within a span context. The span is available via currentContext()
 * to all async code called within fn.
 */
export function runInSpan<T>(handle: SpanHandle, fn: () => T | Promise<T>): T | Promise<T> {
  const parent = spanStorage.getStore();
  const ctx: SpanContext = {
    traceId: handle.traceId,
    spanId: handle.spanId,
    parentSpanId: handle.parentSpanId,
    attributes: handle.attributes,
    pendingSpans: parent?.pendingSpans ?? [],
  };
  return spanStorage.run(ctx, fn);
}

/**
 * Run a function in exporter context — tracing wrappers no-op inside.
 */
export function runInExporterContext<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const ctx: SpanContext = {
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    parentSpanId: null,
    attributes: {},
    isExporterContext: true,
    pendingSpans: [],
  };
  return spanStorage.run(ctx, fn);
}

/**
 * Generate W3C Trace Context traceparent header from current span context.
 * Format: 00-{traceId}-{spanId}-01
 */
export function injectTraceparent(): string | null {
  const ctx = spanStorage.getStore();
  if (!ctx || ctx.isExporterContext) return null;
  try {
    return serializeTraceparent(ctx);
  } catch {
    return null;
  }
}

/**
 * Parse a W3C traceparent header.
 */
export function extractTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null {
  const parsed = parseTraceparent(header, { allowUnsampled: true });
  if (!parsed) return null;
  return { traceId: parsed.traceId, parentSpanId: parsed.spanId };
}

/**
 * Drain all completed spans and return them. Resets the buffer.
 */
export function drainSpans(): CompletedSpan[] {
  const ctx = spanStorage.getStore();
  if (!ctx || ctx.isExporterContext) return [];
  return ctx.pendingSpans.splice(0);
}
