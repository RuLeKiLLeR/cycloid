import type { Correlation } from "../../../shared/correlation.js";
import {
  createLogger as createSharedLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_ORDINALS,
  type Logger,
  type LogLevel,
  phaseLogFields,
  setLoggerErrorHandler,
  type TraceProvider,
} from "../../../shared/observability/logger.js";
import { redactObject } from "../../../shared/observability/redact.js";
import { currentContext } from "./observability/context";

function currentTraceProvider(): ReturnType<TraceProvider> {
  const ctx = currentContext();
  if (!ctx || ctx.isExporterContext) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

function currentWorkerCorrelation(): Correlation | undefined {
  const ctx = currentContext();
  if (!ctx || ctx.isExporterContext) return undefined;

  const sessionId = typeof ctx.attributes["session.id"] === "string" ? ctx.attributes["session.id"] : undefined;
  const promptId = typeof ctx.attributes["prompt.id"] === "string" ? ctx.attributes["prompt.id"] : undefined;
  if (!sessionId || !promptId) return undefined;

  const sandboxId = typeof ctx.attributes["sandbox.id"] === "string" ? ctx.attributes["sandbox.id"] : undefined;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: ctx.parentSpanId,
    sessionId,
    promptId,
    ...(sandboxId ? { sandboxId } : {}),
  };
}

export function createLogger(opts: { level?: LogLevel; bindings?: Record<string, unknown> } = {}): Logger {
  const level = opts.level ?? DEFAULT_LOG_LEVEL;
  return createSharedLogger({
    minLevel: LOG_LEVEL_ORDINALS[level],
    bindings: opts.bindings ?? {},
    traceProvider: currentTraceProvider,
    correlationProvider: currentWorkerCorrelation,
    entryRedactor: redactObject,
  });
}

export { DEFAULT_LOG_LEVEL, LOG_LEVEL_ORDINALS, setLoggerErrorHandler };
export { phaseLogFields };
export type { Logger, LogLevel };
