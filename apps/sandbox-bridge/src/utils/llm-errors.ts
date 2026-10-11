import { ProviderUserAbortError } from "../../../../shared/llm/errors.js";
import { redact, truncate } from "../../../../shared/observability/redact.js";
import type { ErrorDetails } from "../../../../shared/types/sandbox.js";

export type { ErrorDetails } from "../../../../shared/types/sandbox.js";

const STACK_PREVIEW_LENGTH = 1500;
const RESPONSE_BODY_PREVIEW_LENGTH = 500;
const MAX_CAUSE_DEPTH = 4;

/** Max chars for the `error_message` facet on the prompt.complete failure log. */
export const PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS = 500;
/** Max chars for the `error_class` facet. */
export const PROMPT_COMPLETE_ERROR_CLASS_MAX_CHARS = 120;
// `truncate()` appends a "... [truncated N chars]" marker, so budget the slice
// below the cap to keep the FINAL facet within the documented bound.
const ERROR_FACET_TRUNCATION_RESERVE = 32;

/**
 * Build the redacted, length-bounded error facets for the `prompt.complete`
 * failure log. These attach the actual failure message + error class as log
 * facets (never metric tags) so the `[Prompts] Failure spike by error_code`
 * monitor can pivot from an `error_code:unknown` alert to the real cause in one
 * hop. Returns `{}` for non-`error` outcomes (success/aborted) or when no
 * `errorDetails` are present, so the facets only appear on the population the
 * log-derived metric counts (`@outcome:error`).
 *
 * Both fields are `redact`ed (SECRET_PATTERNS scrubber) — `describeError`'s
 * `sanitizeErrorMessage` only collapses whitespace and does not remove secrets,
 * so logging raw would risk CWE-532. `name` can come from non-Error provider
 * payloads, so it is redacted + bounded too. Each emitted facet (including any
 * truncation marker) stays within its max-chars bound. Only the message and
 * class are emitted; `stack`, `raw`, and `responseBodyPreview` are omitted.
 */
export function buildPromptCompleteErrorFacets(
  outcome: string,
  errorDetails: ErrorDetails | undefined,
  maxMessageChars: number = PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS,
): { error_message?: string; error_class?: string } {
  if (outcome !== "error" || !errorDetails) return {};
  const facets: { error_message?: string; error_class?: string } = {};
  if (errorDetails.message) {
    const messageBudget = Math.max(0, maxMessageChars - ERROR_FACET_TRUNCATION_RESERVE);
    facets.error_message = truncate(redact(errorDetails.message), messageBudget).slice(0, maxMessageChars);
  }
  if (errorDetails.name) {
    facets.error_class = redact(errorDetails.name).slice(0, PROMPT_COMPLETE_ERROR_CLASS_MAX_CHARS);
  }
  return facets;
}

export function collapseAndTruncate(value: string, maxLength: number): string {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (sanitized.length <= maxLength) return sanitized;
  return sanitized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    error instanceof ProviderUserAbortError ||
    (error instanceof Error && error.name === "AbortError"),
  );
}

export function sanitizeErrorMessage(message: string | null | undefined): string {
  return collapseAndTruncate(message ?? "", 500);
}

// Node's undici surfaces all network failures as `TypeError: fetch failed`. The
// actionable errno/syscall/hostname live on `.cause` (and sometimes further
// nested). Describe unwraps that chain and also handles Codex's session.error
// payload shape so logs carry enough context to diagnose the failure.
export function describeError(err: unknown, depth = 0): ErrorDetails | undefined {
  if (err == null) return undefined;

  if (typeof err !== "object") {
    return { message: sanitizeErrorMessage(String(err)) };
  }

  const bag = err as Record<string, unknown>;

  if (typeof bag.name === "string" && bag.data && typeof bag.data === "object" && !(err instanceof Error)) {
    const data = bag.data as Record<string, unknown>;
    const details: ErrorDetails = {
      message: sanitizeErrorMessage(typeof data.message === "string" ? data.message : String(bag.name)),
      name: bag.name,
    };
    if (typeof data.providerID === "string") details.providerID = data.providerID;
    if (typeof data.statusCode === "number") details.statusCode = data.statusCode;
    if (typeof data.isRetryable === "boolean") details.isRetryable = data.isRetryable;
    if (typeof data.responseBody === "string" && data.responseBody.length > 0) {
      details.responseBodyPreview = collapseAndTruncate(data.responseBody, RESPONSE_BODY_PREVIEW_LENGTH);
    }
    return details;
  }

  if (err instanceof Error) {
    const details: ErrorDetails = {
      message: sanitizeErrorMessage(err.message),
      name: err.name,
    };
    if (typeof err.stack === "string" && err.stack.length > 0) {
      details.stack = collapseAndTruncate(err.stack, STACK_PREVIEW_LENGTH);
    }
    const withFields = err as Error & Record<string, unknown>;
    if (typeof withFields.errno === "string" || typeof withFields.errno === "number") {
      details.errno = String(withFields.errno);
    }
    if (typeof withFields.code === "string") details.code = withFields.code;
    if (typeof withFields.syscall === "string") details.syscall = withFields.syscall;
    if (typeof withFields.hostname === "string") details.hostname = withFields.hostname;
    if (typeof withFields.address === "string") details.address = withFields.address;
    if (typeof withFields.port === "number") details.port = withFields.port;

    const cause = (withFields.cause ?? (err as unknown as { cause?: unknown }).cause) as unknown;
    if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      const nested = describeError(cause, depth + 1);
      if (nested) details.cause = nested;
    }
    return details;
  }

  try {
    return {
      message: sanitizeErrorMessage("[object]"),
      raw: collapseAndTruncate(JSON.stringify(bag), STACK_PREVIEW_LENGTH),
    };
  } catch {
    return { message: sanitizeErrorMessage(String(bag)) };
  }
}
