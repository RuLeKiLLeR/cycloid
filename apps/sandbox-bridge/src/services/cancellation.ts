const CANCELLATION_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

export function isCancellationError(error: unknown): boolean {
  // `AbortSignal.timeout(...)` aborts surface as "TimeoutError", not "AbortError".
  if (!(error instanceof Error)) return false;
  return CANCELLATION_ERROR_NAMES.has(error.name);
}
