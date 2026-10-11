import { isErrorCode } from "./error-codes.js";
import type { ErrorCode, ErrorDetails } from "./sandbox.js";

const TERMINAL_ERROR_FALLBACK = "Prompt failed with an unknown terminal error";

export type TerminalOutcomeInput = {
  success: boolean;
  error?: string | null;
  errorCode?: ErrorCode | string | null;
  errorDetails?: ErrorDetails | null;
};

export type NormalizedTerminalOutcome = {
  success: boolean;
  error: string | null;
  errorCode: ErrorCode | null;
  errorDetails: ErrorDetails | null;
  coerced: boolean;
  /**
   * The producer-set error code when it was outside the ErrorCode union and
   * collapsed to "unknown"; null when no coercion happened. Callers log this
   * so union drift is visible instead of silent (ARC-1622).
   */
  rawErrorCode: string | null;
};

/** Keep terminal success and error telemetry coupled at every transport boundary. */
export function normalizeTerminalOutcome(input: TerminalOutcomeInput): NormalizedTerminalOutcome {
  const hasTerminalError = Boolean(!input.success || input.error || input.errorCode || input.errorDetails);
  const success = !hasTerminalError;
  const errorCode = hasTerminalError ? (isErrorCode(input.errorCode) ? input.errorCode : "unknown") : null;
  const rawErrorCode =
    hasTerminalError && input.errorCode != null && input.errorCode !== "" && !isErrorCode(input.errorCode)
      ? String(input.errorCode)
      : null;

  return {
    success,
    error: hasTerminalError ? input.error || input.errorDetails?.message || TERMINAL_ERROR_FALLBACK : null,
    errorCode,
    errorDetails: input.errorDetails ?? null,
    coerced: input.success && !success,
    rawErrorCode,
  };
}
