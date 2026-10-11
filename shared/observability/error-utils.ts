/**
 * Loggable error serialization.
 *
 * `String(err)` collapses an error to just its message, dropping the stack,
 * the error class, the `code`, and the `cause` chain -- exactly the context a
 * responder needs. Passing the raw `Error` instead is no better: `JSON.stringify`
 * sees no enumerable own-properties on an `Error`, so it serializes to `{}`.
 *
 * `serializeError` converts any thrown value into a plain object whose safe
 * fields (name, message, code, type, stack, cause) survive JSON serialization,
 * and redacts every string leaf through the shared {@link redact} contract so it
 * is safe to put in both logs and API responses (see docs/security.md "Logging
 * and exposure controls"). Stack frames can carry file paths, so callers that
 * build user-facing API responses should pass `includeStack: false`.
 */
import { redact, redactObject } from "./redact";

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  type?: string;
  stack?: string;
  cause?: SerializedError;
  /** Aggregated sub-errors (e.g. `AggregateError.errors`). The real failures live here. */
  errors?: SerializedError[];
}

const MAX_CAUSE_DEPTH = 3;

export interface SerializeErrorOptions {
  /** Include the (redacted) stack trace. Default true. Set false for responses returned to clients. */
  includeStack?: boolean;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function serializeErrorInternal(value: unknown, includeStack: boolean, depth: number): SerializedError {
  if (value instanceof Error) {
    const result: SerializedError = {
      name: value.name || "Error",
      message: redact(value.message),
      // `||` not `??`: an anonymous-class constructor has `name === ""`, which
      // `??` would keep, silently producing `type: ""`.
      type: value.constructor?.name || value.name || "Error",
    };

    const code = (value as Error & { code?: unknown }).code;
    if (typeof code === "number") {
      result.code = code;
    } else if (typeof code === "string") {
      result.code = redact(code);
    }

    if (includeStack && typeof value.stack === "string") {
      result.stack = redact(value.stack);
    }

    if (depth > 0 && "cause" in value) {
      const cause = (value as Error & { cause?: unknown }).cause;
      if (cause !== undefined && cause !== null) {
        result.cause = serializeErrorInternal(cause, includeStack, depth - 1);
      }
    }

    // AggregateError.errors holds the aggregated failures. Its own `message` is
    // usually empty, so without this the real errors (and any diagnosable detail)
    // are dropped. Each sub-error is serialized through the same redaction path.
    if (depth > 0) {
      const aggregated = (value as Error & { errors?: unknown }).errors;
      if (Array.isArray(aggregated) && aggregated.length > 0) {
        result.errors = aggregated.map((sub) => serializeErrorInternal(sub, includeStack, depth - 1));
      }
    }

    return result;
  }

  // Non-Error throwables (strings, numbers, plain objects, etc.). For plain
  // objects, run key-aware redaction first -- a thrown `{ password: "devpass" }`
  // has secret-named fields whose values may be too short or non-pattern to be
  // caught by string redaction alone.
  let message: string;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    message = redact(safeStringify(redactObject(value as Record<string, unknown>)));
  } else {
    message = redact(safeStringify(value));
  }
  return {
    name: "NonError",
    message,
    type: value === null ? "null" : typeof value,
  };
}

/**
 * Convert any thrown value into a JSON-safe, secret-redacted {@link SerializedError}.
 * Preserves the error class, `code`, and `cause` chain so logs and responses keep
 * enough context to diagnose without local repro.
 */
export function serializeError(value: unknown, options: SerializeErrorOptions = {}): SerializedError {
  // serializeError runs inside catch blocks, several of which re-throw the
  // original error. An exotic error with a throwing getter must never let this
  // helper throw and replace the real error or drop the log entry.
  try {
    return serializeErrorInternal(value, options.includeStack ?? true, MAX_CAUSE_DEPTH);
  } catch {
    return { name: "SerializationError", message: "[error serialization failed]" };
  }
}
