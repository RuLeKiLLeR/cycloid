// Shared helpers for integration health checks (GitHub, Jira, Linear). These
// were previously colocated with the synthetic-session machinery; they are
// generic and outlive it.

export function parsePositiveEnvMs(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function envFlagEnabled(raw: string | undefined): boolean {
  return raw === "true" || raw === "1";
}

export function sanitizedHealthExceptionDetails(
  error: unknown,
  messages: { timeoutFailureReason: string; defaultFailureReason: string },
): { errorName: string; failureReason: string } {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { errorName: error.name, failureReason: messages.timeoutFailureReason };
  }
  if (error instanceof Error) {
    return { errorName: error.name, failureReason: messages.defaultFailureReason };
  }
  return { errorName: "unknown_error", failureReason: messages.defaultFailureReason };
}
