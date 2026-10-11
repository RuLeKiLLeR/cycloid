import type { ObservabilityReadiness } from "../types/sandbox.js";
import { bytesToHex } from "../utils/hex.js";

export const TRACEPARENT_VERSION = "00";
export const TRACEPARENT_TRACE_FLAGS = "01";
export const TRACEPARENT_UNSAMPLED_TRACE_FLAGS = "00";

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;

declare const traceIdBrand: unique symbol;
declare const spanIdBrand: unique symbol;
declare const traceparentBrand: unique symbol;

export type TraceId = string & { readonly [traceIdBrand]: true };
export type SpanId = string & { readonly [spanIdBrand]: true };
export type Traceparent = string & { readonly [traceparentBrand]: true };

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;
export type OptionalSpanAttributeValue = SpanAttributeValue | null | undefined;
export type OptionalSpanAttributes = Record<string, OptionalSpanAttributeValue>;
export type TraceparentTraceFlags = typeof TRACEPARENT_TRACE_FLAGS | typeof TRACEPARENT_UNSAMPLED_TRACE_FLAGS;

export const TRACING_STATES = ["disabled", "init_failed", "enabled"] as const;
export type TracingState = (typeof TRACING_STATES)[number];

export type TraceparentParts = {
  traceId: TraceId;
  spanId: SpanId;
  traceFlags: TraceparentTraceFlags;
};

export type TracingReadiness = {
  traceExportEnabled: boolean;
  ddLogsEnabled: boolean;
  tracingState: TracingState;
};

export type TracingReadinessConfig = {
  ddApiKey?: unknown;
};

type ParseTraceparentOptions = {
  allowUnsampled?: boolean;
};

function isAllZeroes(value: string): boolean {
  return /^0+$/.test(value);
}

function generateHex(bytes: number, excluded?: string): string {
  while (true) {
    const value = bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
    if (!isAllZeroes(value) && value !== excluded) return value;
  }
}

export function normalizeTraceId(traceId: unknown): TraceId | undefined {
  if (typeof traceId !== "string" || !TRACE_ID_RE.test(traceId) || isAllZeroes(traceId)) {
    return undefined;
  }
  return traceId.toLowerCase() as TraceId;
}

export function normalizeSpanId(spanId: unknown): SpanId | undefined {
  if (typeof spanId !== "string" || !SPAN_ID_RE.test(spanId) || isAllZeroes(spanId)) {
    return undefined;
  }
  return spanId.toLowerCase() as SpanId;
}

export function generateTraceId(): TraceId {
  return generateHex(16) as TraceId;
}

export function generateSpanId(excluded?: string): SpanId {
  const excludedSpanId = normalizeSpanId(excluded);
  return generateHex(8, excludedSpanId) as SpanId;
}

export function parseTraceparent(traceparent: unknown, options: ParseTraceparentOptions = {}): TraceparentParts | null {
  if (typeof traceparent !== "string") return null;

  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(traceparent);
  if (!match) return null;

  const [, version, rawTraceId, rawSpanId, traceFlags] = match;
  const normalizedTraceFlags = traceFlags.toLowerCase();
  const acceptedTraceFlags = options.allowUnsampled
    ? new Set([TRACEPARENT_TRACE_FLAGS, TRACEPARENT_UNSAMPLED_TRACE_FLAGS])
    : new Set([TRACEPARENT_TRACE_FLAGS]);
  if (version.toLowerCase() !== TRACEPARENT_VERSION || !acceptedTraceFlags.has(normalizedTraceFlags)) {
    return null;
  }

  const traceId = normalizeTraceId(rawTraceId);
  const spanId = normalizeSpanId(rawSpanId);
  if (!traceId || !spanId) return null;

  return { traceId, spanId, traceFlags: normalizedTraceFlags as TraceparentTraceFlags };
}

export function serializeTraceparent(context: { traceId: unknown; spanId: unknown }): Traceparent {
  const traceId = normalizeTraceId(context.traceId);
  if (!traceId) throw new Error("Invalid traceId");

  const spanId = normalizeSpanId(context.spanId);
  if (!spanId) throw new Error("Invalid spanId");

  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${TRACEPARENT_TRACE_FLAGS}` as Traceparent;
}

// The sandbox/bridge no longer exports OTLP traces; readiness reports Datadog
// log configuration only. `traceExportEnabled` stays false and `tracingState`
// stays "disabled" because there is no exporter to initialize.
export function buildTracingReadiness(config: TracingReadinessConfig): TracingReadiness {
  return {
    traceExportEnabled: false,
    ddLogsEnabled: Boolean(config.ddApiKey),
    tracingState: "disabled",
  };
}

export function observabilityReadinessFromTracing(readiness: TracingReadiness): ObservabilityReadiness {
  return {
    traceExport: readiness.traceExportEnabled,
    traceExportConfigured: readiness.traceExportEnabled,
    ddLogs: readiness.ddLogsEnabled,
    tracingState: readiness.tracingState,
  };
}

export function observabilityReadinessLogFields(readiness: ObservabilityReadiness): Record<string, unknown> {
  return {
    trace_export_enabled: readiness.traceExport,
    trace_export_configured: readiness.traceExportConfigured ?? readiness.traceExport,
    dd_logs_enabled: readiness.ddLogs,
    tracing_state: readiness.tracingState,
  };
}
