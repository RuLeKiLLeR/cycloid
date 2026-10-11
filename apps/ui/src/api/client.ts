import type { ZodError, ZodType } from "zod";

/**
 * Fetch + assert ok + parse JSON.
 * On failure: tries to read `data.error` from the response body, falls back
 * to `errorMsg`, then to a generic message.
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

type ParsedErrorResponse = {
  error?: string;
  code?: string;
  message?: string;
  userMessage?: string;
};

/** Default per-request ceiling. Without it a hung request never settles, so the UI spins forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Compose abort signals. Prefers native `AbortSignal.any`, but falls back to a
 * manual `AbortController` for browsers that ship `AbortSignal.timeout` but not
 * `AbortSignal.any` (Chrome 103-115, Firefox 100-123, Safari 16-17.3), where
 * calling `AbortSignal.any` directly throws `TypeError` before the fetch starts.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { signal: controller.signal });
  }
  return controller.signal;
}

/**
 * fetch with a request-level timeout. Composes the timeout with any
 * caller-provided `signal` so React Query cancellation still works. A genuine
 * caller abort propagates unchanged; only the timeout is converted into a clear
 * ApiError so callers surface "timed out" instead of hanging or a cryptic
 * DOMException.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? anySignal([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // A caller-initiated cancellation is intentional; let it propagate as-is.
    if (init?.signal?.aborted) throw error;
    // Identify the timeout by the thrown error, not post-hoc signal state: a
    // genuine network error coinciding with the timer firing must not be masked
    // as a 408. AbortSignal.timeout rejects fetch with a "TimeoutError" DOMException.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`, 408, "timeout");
    }
    throw error;
  }
}

async function parseErrorResponseJson(res: Response, url: string): Promise<ParsedErrorResponse | null> {
  try {
    return (await res.json()) as ParsedErrorResponse;
  } catch (error) {
    console.error("[api] Failed to parse error response JSON", {
      url,
      status: res.status,
      error,
    });
    return null;
  }
}

/**
 * Optional runtime validation of a successful JSON response.
 *
 * Default policy is fail-closed: a `safeParse` failure throws an `ApiError`
 * (code `invalid_response`) so it flows through the same userMessage / Sentry /
 * error-boundary path as an HTTP failure, instead of surfacing a raw `ZodError`.
 *
 * `mode: "warn"` is a per-call-site fail-soft escape hatch (log + cast, do not
 * throw). Use it only with a comment explaining why a malformed response is
 * tolerable at that call site.
 */
type ResponseValidation<T> = {
  schema: ZodType<T>;
  // Only "warn" is worth specifying: it opts out of the fail-closed default.
  // Omitting `mode` already means throw, so a "throw" literal would be redundant.
  mode?: "warn";
};

/**
 * Summarize a ZodError into sanitized field/code pairs for logging. Carries no
 * response body and no values (only field paths and zod issue codes), per
 * docs/security.md ("Do not log secrets, tokens, or PII").
 */
function summarizeValidationIssues(error: ZodError): string {
  const MAX_ISSUES = 10;
  const summary = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
  const overflow = error.issues.length > MAX_ISSUES ? ` (+${error.issues.length - MAX_ISSUES} more)` : "";
  return `${summary}${overflow}`;
}

/**
 * Transitional shim (frontend remediation plan, PR 1.1): `validate` is optional
 * and falls back to a pure cast when absent. The Phase-0 audit tracks
 * "unvalidated requestJson sites"; once that count reaches zero the cast
 * fallback is deleted and `validate` becomes required.
 */
export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  errorMsg?: string,
  validate?: ResponseValidation<T>,
): Promise<T> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const data = await parseErrorResponseJson(res, url);
    throw new ApiError(
      data?.userMessage ?? data?.message ?? data?.error ?? errorMsg ?? `Request failed: ${url}`,
      res.status,
      data?.code as string | undefined,
      data,
    );
  }
  if (!validate) {
    return res.json() as Promise<T>;
  }
  const raw = await res.json();
  const parsed = validate.schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = summarizeValidationIssues(parsed.error);
  // Sanitized record only: endpoint + issue field/code pairs, never the body.
  console.error("[api] Response validation failed", { url, status: res.status, issues });
  if (validate.mode === "warn") {
    // Warn mode does not throw, so the error boundary never sees this failure;
    // report it explicitly here. Throw mode below relies on the boundary's
    // Sentry capture (matching the HTTP-error path), so it must NOT capture here
    // or Sentry receives two events for the same failure.
    captureApiError(new ApiError(`Response validation failed: ${url}`, res.status, "invalid_response"), {
      url,
      issues,
    });
    return raw as T;
  }
  throw new ApiError(
    errorMsg ?? `Unexpected response from ${url}`,
    res.status,
    "invalid_response",
    // No response body; only the sanitized issue summary travels with the error.
    { issues },
  );
}

/**
 * Fail-closed JSON request that requires a response schema.
 *
 * This exists as a non-`requestJson(...)` call site so the frontend remediation
 * audit can ratchet down unvalidated `requestJson` usage over time.
 */
export async function requestJsonValidated<T>(
  url: string,
  init: RequestInit | undefined,
  errorMsg: string,
  validate: ResponseValidation<T>,
): Promise<T> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const data = await parseErrorResponseJson(res, url);
    throw new ApiError(
      data?.userMessage ?? data?.message ?? data?.error ?? errorMsg ?? `Request failed: ${url}`,
      res.status,
      data?.code as string | undefined,
      data,
    );
  }

  const raw = await res.json();
  const parsed = validate.schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = summarizeValidationIssues(parsed.error);
  if (validate.mode === "warn") {
    captureApiError(new ApiError(`Response validation failed: ${url}`, res.status, "invalid_response"), {
      url,
      issues,
    });
    return raw as T;
  }

  throw new ApiError(errorMsg ?? `Unexpected response from ${url}`, res.status, "invalid_response", { issues });
}

/**
 * Fetch + assert ok (no response body consumed on success).
 * On failure: tries to read `data.error` from the response body, falls back
 * to `errorMsg`, then to a generic message.
 */
export async function requestVoid(url: string, init?: RequestInit, errorMsg?: string): Promise<void> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const data = await parseErrorResponseJson(res, url);
    throw new ApiError(
      data?.userMessage ?? data?.message ?? data?.error ?? errorMsg ?? `Request failed: ${url}`,
      res.status,
      data?.code as string | undefined,
      data,
    );
  }
}

export const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function trackApiAction(name: string, context?: Record<string, unknown>) {
  import("../datadog")
    .then(({ trackAction }) => trackAction(name, context))
    .catch((error) => {
      console.error(`[api] Failed to track action "${name}":`, error);
    });
}

export function captureApiError(error: unknown, context?: Record<string, string>) {
  import("../sentry")
    .then(({ captureUiError }) => captureUiError(error, context))
    .catch((captureError) => {
      console.error("[api] Failed to capture UI error:", captureError);
    });
}
