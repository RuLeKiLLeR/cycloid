import { normalizeSpanId, normalizeTraceId, parseTraceparent, serializeTraceparent } from "./observability/trace.js";
import { asNonEmptyString, isRecord } from "./utils/type-guards.js";

export const CORRELATION_HEADER = "x-cycloid-correlation";
export const CORRELATION_ENV_VAR = "ARCANIST_CORRELATION";

export type Correlation = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string;
  promptId: string;
  sandboxId?: string;
};

export type SerializedCorrelation = {
  traceparent: string;
  sessionId: string;
  promptId: string;
  parentSpanId?: string;
  sandboxId?: string;
};

function normalizeOptionalIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return asNonEmptyString(value);
}

function validateCorrelation(correlation: Correlation): Correlation {
  const traceId = normalizeTraceId(correlation.traceId);
  if (!traceId) throw new Error("Invalid traceId");

  const spanId = normalizeSpanId(correlation.spanId);
  if (!spanId) throw new Error("Invalid spanId");

  let parentSpanId: string | null = null;
  if (correlation.parentSpanId !== null) {
    parentSpanId = normalizeSpanId(correlation.parentSpanId) ?? null;
    if (!parentSpanId || parentSpanId === spanId) throw new Error("Invalid parentSpanId");
  }

  const sessionId = asNonEmptyString(correlation.sessionId);
  if (!sessionId) throw new Error("Invalid sessionId");

  const promptId = asNonEmptyString(correlation.promptId);
  if (!promptId) throw new Error("Invalid promptId");

  const sandboxId = normalizeOptionalIdentifier(correlation.sandboxId);
  if (correlation.sandboxId !== undefined && !sandboxId) throw new Error("Invalid sandboxId");

  return {
    traceId,
    spanId,
    parentSpanId,
    sessionId,
    promptId,
    ...(sandboxId ? { sandboxId } : {}),
  };
}

export function serializeCorrelation(correlation: Correlation): SerializedCorrelation {
  const validated = validateCorrelation(correlation);
  return {
    traceparent: serializeTraceparent(validated),
    sessionId: validated.sessionId,
    promptId: validated.promptId,
    ...(validated.parentSpanId ? { parentSpanId: validated.parentSpanId } : {}),
    ...(validated.sandboxId ? { sandboxId: validated.sandboxId } : {}),
  };
}

export function parseCorrelation(value: unknown): Correlation | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed)) return null;

  const traceInfo = parseTraceparent(parsed.traceparent);
  if (!traceInfo) return null;

  const sessionId = asNonEmptyString(parsed.sessionId);
  if (!sessionId) return null;

  const promptId = asNonEmptyString(parsed.promptId);
  if (!promptId) return null;

  let parentSpanId: string | null = null;
  if (parsed.parentSpanId !== undefined && parsed.parentSpanId !== null) {
    parentSpanId = normalizeSpanId(parsed.parentSpanId) ?? null;
    if (!parentSpanId || parentSpanId === traceInfo.spanId) return null;
  }

  const sandboxId = normalizeOptionalIdentifier(parsed.sandboxId);
  if (parsed.sandboxId !== undefined && !sandboxId) return null;

  return {
    traceId: traceInfo.traceId,
    spanId: traceInfo.spanId,
    parentSpanId,
    sessionId,
    promptId,
    ...(sandboxId ? { sandboxId } : {}),
  };
}
