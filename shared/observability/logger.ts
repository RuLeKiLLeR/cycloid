import type { Correlation } from "../correlation.js";
import type { Phase } from "../events/schema.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVEL_ORDINALS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export const LOG_TRACE_FIELD_NAMES = ["dd.trace_id", "dd.span_id"] as const;
export const LOG_PARENT_SPAN_FIELD_NAME = "dd.parent_span_id" as const;
export const LOG_CORRELATION_FIELD_NAMES = [
  "correlationTraceId",
  "correlationSpanId",
  "correlationParentSpanId",
  "sessionId",
  "promptId",
  "sandboxId",
] as const;

export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LoggerErrorHandler = (err: Error, context: Record<string, string>) => void;
export type TraceProvider = () => { traceId: string | null; spanId: string | null } | undefined;
export type CorrelationProvider = () => Correlation | undefined;
export type LoggerEntrySink = (entry: Record<string, unknown>) => void;
export type LoggerEntryRedactor = (entry: Record<string, unknown>) => Record<string, unknown>;
export type TraceLogContext = {
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
};
export type TraceLogFieldOptions = {
  includeParentSpanId?: boolean;
};

export interface CreateLoggerOptions {
  level?: LogLevel;
  minLevel?: number;
  bindings?: Record<string, unknown>;
  traceProvider?: TraceProvider;
  correlationProvider?: CorrelationProvider;
  entrySink?: LoggerEntrySink;
  entryRedactor?: LoggerEntryRedactor;
  errorHandler?: LoggerErrorHandler | null;
}

type ResolvedLoggerOptions = {
  minLevel: number;
  bindings: Record<string, unknown>;
  traceProvider?: TraceProvider;
  correlationProvider?: CorrelationProvider;
  entrySink?: LoggerEntrySink;
  entryRedactor?: LoggerEntryRedactor;
  errorHandler: LoggerErrorHandler | null;
};

let defaultErrorHandler: LoggerErrorHandler | null = null;

const consoleMethods: Record<LogLevel, "log" | "warn" | "error"> = {
  debug: "log",
  info: "log",
  warn: "warn",
  error: "error",
};

export function setLoggerErrorHandler(handler: LoggerErrorHandler | null): void {
  defaultErrorHandler = handler;
}

export function phaseLogFields<P extends Phase>(
  phase: P,
  fields: Record<string, unknown> & { event?: never; status?: never } = {},
): Record<string, unknown> & { event: P } {
  const { status, ...safeFields } = fields as Record<string, unknown>;
  return {
    ...safeFields,
    ...(status !== undefined && !Object.prototype.hasOwnProperty.call(safeFields, "phase_status")
      ? { phase_status: status }
      : {}),
    event: phase,
  };
}

export function traceLogFields(
  trace: TraceLogContext | undefined,
  options: TraceLogFieldOptions = {},
): Record<string, string> {
  if (!trace) return {};

  return {
    ...(trace.traceId ? { [LOG_TRACE_FIELD_NAMES[0]]: trace.traceId } : {}),
    ...(trace.spanId ? { [LOG_TRACE_FIELD_NAMES[1]]: trace.spanId } : {}),
    ...(options.includeParentSpanId && trace.parentSpanId ? { [LOG_PARENT_SPAN_FIELD_NAME]: trace.parentSpanId } : {}),
  };
}

export function correlationLogFields(correlation: Correlation | undefined): Record<string, string> {
  if (!correlation) return {};

  return {
    [LOG_CORRELATION_FIELD_NAMES[0]]: correlation.traceId,
    [LOG_CORRELATION_FIELD_NAMES[1]]: correlation.spanId,
    ...(correlation.parentSpanId ? { [LOG_CORRELATION_FIELD_NAMES[2]]: correlation.parentSpanId } : {}),
    [LOG_CORRELATION_FIELD_NAMES[3]]: correlation.sessionId,
    [LOG_CORRELATION_FIELD_NAMES[4]]: correlation.promptId,
    ...(correlation.sandboxId ? { [LOG_CORRELATION_FIELD_NAMES[5]]: correlation.sandboxId } : {}),
  };
}

/** Format a serialized sub-error as `Name: message` (or whichever half exists) for folding into a summary. */
function describeSerializedError(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const { name, message } = value as { name?: unknown; message?: unknown };
  const n = typeof name === "string" && name ? name : undefined;
  const m = typeof message === "string" && message ? message : undefined;
  if (n && m) return `${n}: ${m}`;
  return m ?? n ?? "unknown error";
}

/** Extract an Error object from a log entry's `error` field, creating one if the field is a string. */
function extractError(obj: Record<string, unknown>, msg?: string): Error | undefined {
  const raw = obj.error;
  if (raw instanceof Error) return raw;
  if (typeof raw === "string") return new Error(raw);
  // Serialized error objects (shared/observability/error-utils.ts `serializeError`)
  // are plain objects, so reconstruct an Error to keep the real message, name, and
  // stack for the errorHandler/Sentry capture instead of falling back to the
  // generic log message.
  if (raw !== null && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string") {
    const serialized = raw as { name?: unknown; message: string; type?: unknown; stack?: unknown; errors?: unknown };
    let message = serialized.message;
    // An AggregateError carries the real failures in `errors` while its own
    // message is usually empty. Fold the sub-errors into the message so Sentry
    // receives something diagnosable instead of grouping every AggregateError
    // together under the reconstruction frame.
    if (Array.isArray(serialized.errors) && serialized.errors.length > 0) {
      const summary = serialized.errors.map(describeSerializedError).join("; ");
      message = message ? `${message} (${summary})` : summary;
    }
    // Never hand Sentry a blank message: fall back to the error class so a bare
    // empty-message error still groups by name/type rather than by call site.
    if (!message) {
      const name = typeof serialized.name === "string" && serialized.name ? serialized.name : undefined;
      const type = typeof serialized.type === "string" && serialized.type ? serialized.type : undefined;
      message = name ?? type ?? "Unknown error";
    }
    const err = new Error(message);
    if (typeof serialized.name === "string" && serialized.name) err.name = serialized.name;
    if (typeof serialized.stack === "string") err.stack = serialized.stack;
    return err;
  }
  if (msg) return new Error(msg);
  return undefined;
}

function toErrorContext(bindings: Record<string, unknown>, msg?: string): Record<string, string> {
  const context: Record<string, string> = {};
  if (msg) context.operation = msg;

  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === "string") {
      context[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      context[key] = String(value);
    }
  }

  return context;
}

function buildTraceCorrelation(traceProvider: TraceProvider | undefined): Record<string, unknown> {
  return traceLogFields(traceProvider?.());
}

function buildCorrelationFields(correlationProvider: CorrelationProvider | undefined): Record<string, unknown> {
  return correlationLogFields(correlationProvider?.());
}

function buildSentryCorrelationContext(
  traceProvider: TraceProvider | undefined,
  correlationProvider: CorrelationProvider | undefined,
): Record<string, string> {
  const trace = traceProvider?.();
  const correlation = correlationProvider?.();
  const traceId = trace?.traceId ?? correlation?.traceId;
  const spanId = trace?.spanId ?? correlation?.spanId;

  return {
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(correlation?.parentSpanId ? { parentSpanId: correlation.parentSpanId } : {}),
    ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
    ...(correlation?.promptId ? { promptId: correlation.promptId } : {}),
    ...(correlation?.sandboxId ? { sandboxId: correlation.sandboxId } : {}),
  };
}

function createLoggerImpl(options: ResolvedLoggerOptions): Logger {
  function emit(level: LogLevel, obj: Record<string, unknown>, msg?: string): void {
    if (LOG_LEVEL_ORDINALS[level] < options.minLevel) return;

    const entry: Record<string, unknown> = {
      level,
      ts: Date.now(),
      ...(msg ? { msg } : {}),
      ...buildTraceCorrelation(options.traceProvider),
      ...buildCorrelationFields(options.correlationProvider),
      ...options.bindings,
      ...obj,
    };
    const emittedEntry = options.entryRedactor ? options.entryRedactor(entry) : entry;

    // eslint-disable-next-line no-console
    console[consoleMethods[level]](JSON.stringify(emittedEntry));
    options.entrySink?.(emittedEntry);

    if (options.errorHandler && (level === "error" || (level === "warn" && "error" in obj))) {
      const errorContextFields = {
        ...(options.entryRedactor
          ? options.entryRedactor({ ...options.bindings, ...obj })
          : { ...options.bindings, ...obj }),
        ...buildSentryCorrelationContext(options.traceProvider, options.correlationProvider),
      };
      const emittedMsg = typeof emittedEntry.msg === "string" ? emittedEntry.msg : msg;
      // Redact a serialized-error object on its own instead of reading it back out
      // of `emittedEntry`. Inside the full entry the error sits a level deeper, so
      // the redactor's depth budget collapses an AggregateError's `errors[]`
      // sub-errors to `{ _truncated: true }` before extractError can fold them into
      // the Sentry message. Redacting the error field standalone gives its chain the
      // full depth budget. Error instances and strings already redact correctly in
      // `emittedEntry` (and passing an Error to the object redactor would drop its
      // non-enumerable message), so only reroute plain serialized objects.
      const rawError = obj.error;
      const redactedError =
        options.entryRedactor &&
        rawError !== null &&
        typeof rawError === "object" &&
        !Array.isArray(rawError) &&
        !(rawError instanceof Error)
          ? options.entryRedactor(rawError as Record<string, unknown>)
          : emittedEntry.error;
      const err = extractError({ error: redactedError }, emittedMsg);
      if (err) {
        options.errorHandler(err, toErrorContext(errorContextFields, emittedMsg));
      }
    }
  }

  return {
    debug: (obj, msg?) => emit("debug", obj, msg),
    info: (obj, msg?) => emit("info", obj, msg),
    warn: (obj, msg?) => emit("warn", obj, msg),
    error: (obj, msg?) => emit("error", obj, msg),
    child: (bindings) =>
      createLoggerImpl({
        ...options,
        bindings: { ...options.bindings, ...bindings },
      }),
  };
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const hasExplicitErrorHandler = Object.prototype.hasOwnProperty.call(options, "errorHandler");

  return createLoggerImpl({
    minLevel: options.minLevel ?? LOG_LEVEL_ORDINALS[level],
    bindings: options.bindings ?? {},
    traceProvider: options.traceProvider,
    correlationProvider: options.correlationProvider,
    entrySink: options.entrySink,
    entryRedactor: options.entryRedactor,
    errorHandler: hasExplicitErrorHandler ? (options.errorHandler ?? null) : defaultErrorHandler,
  });
}
