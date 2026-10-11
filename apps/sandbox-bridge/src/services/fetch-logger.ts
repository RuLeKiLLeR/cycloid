import { stringifyError } from "../../../../shared/utils/errors.js";
import type { BridgeLogger } from "../logger.js";
import { describeError, type ErrorDetails } from "../utils/llm-errors.js";

// Wraps globalThis.fetch so every slow-or-failing request lands in DD with the
// actual URL. The bundle minifies call sites, so we cannot infer the target
// from stack frames; this wrapper is the only place we can capture the URL
// that was handed to undici before it hung with UND_ERR_HEADERS_TIMEOUT.
const DEFAULT_SLOW_THRESHOLD_MS = 5_000;
const OBSERVABILITY_FLUSH_HOST = "api.braintrust.dev";
const OBSERVABILITY_FLUSH_PATHS = new Set(["/logs", "/logs3"]);

interface FetchLoggerOptions {
  slowThresholdMs?: number;
}

interface FetchLoggerHandle {
  installed: boolean;
  uninstall: () => void;
}

interface ObservabilityFlushTarget {
  host: string;
  basePath: string;
}

let globalInstalled = false;

export function installFetchLogger(logger: BridgeLogger, options: FetchLoggerOptions = {}): FetchLoggerHandle {
  if (globalInstalled) {
    return { installed: false, uninstall: () => {} };
  }
  const slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const log = logger.child({
    component: "fetch-logger",
    sandbox_id: process.env.SANDBOX_ID,
    session_id: process.env.SESSION_ID,
  });

  const originalFetch = globalThis.fetch.bind(globalThis);
  const observabilityFlushTarget = parseObservabilityFlushTarget(process.env.BRAINTRUST_API_URL);

  const wrapped: typeof fetch = async (input, init) => {
    const startedAt = Date.now();
    const meta = safeExtractMeta(input, init);
    try {
      const response = await originalFetch(input as Parameters<typeof fetch>[0], init);
      const durationMs = Date.now() - startedAt;
      if (!response.ok || durationMs >= slowThresholdMs) {
        safeLog(() => {
          log.warn(
            {
              ...meta,
              durationMs,
              status: response.status,
              slowThresholdMs,
            },
            response.ok ? "Fetch request slow" : "Fetch request non-ok",
          );
        });
      }
      return response;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      safeLog(() => {
        const errorDetails = describeError(err);
        const errorSummary = summarizeFetchError(err, errorDetails);
        const fields = {
          ...meta,
          durationMs,
          error: errorSummary,
          errorDetails,
        };
        if (isObservabilityFlushFailure(meta, observabilityFlushTarget)) {
          log.warn(
            {
              ...meta,
              durationMs,
              errorSummary,
              errorDetails,
              event: "observability_flush_failed",
            },
            "Observability flush failed",
          );
        } else {
          log.error(fields, "Fetch request failed");
        }
      });
      throw err;
    }
  };

  globalThis.fetch = wrapped;
  globalInstalled = true;

  log.info({ slowThresholdMs }, "Fetch logger installed");

  return {
    installed: true,
    uninstall: () => {
      globalThis.fetch = originalFetch;
      globalInstalled = false;
    },
  };
}

interface FetchMeta {
  method: string;
  host?: string;
  path?: string;
  url?: string;
}

function safeExtractMeta(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): FetchMeta {
  try {
    const { rawUrl, method } = resolveRequest(input, init);
    const sanitized = sanitizeUrl(rawUrl);
    return { method, ...sanitized };
  } catch {
    return { method: "UNKNOWN" };
  }
}

function resolveRequest(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): { rawUrl: string; method: string } {
  if (typeof input === "string") {
    return { rawUrl: input, method: (init?.method ?? "GET").toUpperCase() };
  }
  if (input instanceof URL) {
    return { rawUrl: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  }
  // Request
  const req = input as Request;
  return { rawUrl: req.url, method: (init?.method ?? req.method ?? "GET").toUpperCase() };
}

function sanitizeUrl(raw: string): { host?: string; path?: string; url?: string } {
  try {
    const u = new URL(raw);
    // Strip credentials and query/fragment — keep just protocol + host + path.
    const safe = `${u.protocol}//${u.host}${u.pathname}`;
    return { host: u.host, path: u.pathname, url: safe };
  } catch {
    return {};
  }
}

function safeLog(fn: () => void): void {
  try {
    fn();
  } catch {
    // Logging must never break the underlying fetch chain.
  }
}

function parseObservabilityFlushTarget(rawUrl: string | undefined): ObservabilityFlushTarget | undefined {
  if (!rawUrl) return undefined;
  const sanitized = sanitizeUrl(rawUrl);
  if (!sanitized.host || sanitized.path === undefined) return undefined;
  return {
    host: sanitized.host,
    basePath: stripTrailingSlash(sanitized.path),
  };
}

function stripTrailingSlash(path: string): string {
  if (path === "/") return "";
  return path.replace(/\/+$/, "");
}

function isObservabilityFlushFailure(meta: FetchMeta, target: ObservabilityFlushTarget | undefined): boolean {
  if (meta.method !== "POST" || !meta.path) return false;
  if (meta.host === OBSERVABILITY_FLUSH_HOST && OBSERVABILITY_FLUSH_PATHS.has(meta.path)) return true;
  if (!target || meta.host !== target.host) return false;

  for (const flushPath of OBSERVABILITY_FLUSH_PATHS) {
    if (meta.path === `${target.basePath}${flushPath}`) return true;
  }
  return false;
}

function summarizeFetchError(err: unknown, details: ErrorDetails | undefined): string {
  const message = details?.message || stringifyError(err);
  const cause = pickActionableCause(details);
  if (!cause) return appendErrorFields(message, details);

  const causeLabel = formatErrorLabel(cause);
  const causeSummary = appendErrorFields(causeLabel, cause);
  return `${message}: ${causeSummary}`;
}

function pickActionableCause(details: ErrorDetails | undefined): ErrorDetails | undefined {
  let current = details?.cause;
  const fallback = current;
  while (current) {
    if (hasActionableErrorFields(current)) return current;
    current = current.cause;
  }
  return fallback;
}

function hasActionableErrorFields(details: ErrorDetails): boolean {
  return Boolean(
    details.code ||
    details.errno ||
    details.syscall ||
    details.hostname ||
    details.address ||
    details.port !== undefined ||
    details.statusCode !== undefined,
  );
}

function formatErrorLabel(details: ErrorDetails): string {
  if (details.name && details.message && details.name !== "Error") return `${details.name}: ${details.message}`;
  return details.message || details.name || "unknown error";
}

function appendErrorFields(label: string, details: ErrorDetails | undefined): string {
  const fields = details ? errorFieldParts(details) : [];
  return fields.length > 0 ? `${label} (${fields.join(", ")})` : label;
}

function errorFieldParts(details: ErrorDetails): string[] {
  const fields: string[] = [];
  if (details.code) fields.push(`code=${details.code}`);
  if (details.errno) fields.push(`errno=${details.errno}`);
  if (details.syscall) fields.push(`syscall=${details.syscall}`);
  if (details.hostname) fields.push(`hostname=${details.hostname}`);
  if (details.address) fields.push(`address=${details.address}`);
  if (details.port !== undefined) fields.push(`port=${details.port}`);
  if (details.statusCode !== undefined) fields.push(`status=${details.statusCode}`);
  return fields;
}
