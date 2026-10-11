export class ProviderUserAbortError extends Error {
  constructor(message = "Provider request aborted by caller") {
    super(message);
    this.name = "ProviderUserAbortError";
  }
}

export function hasCauseName(error: unknown, name: string, maxDepth = 4, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > maxDepth) return false;
  const candidate = error as { name?: unknown; cause?: unknown };
  if (candidate.name === name) return true;
  return hasCauseName(candidate.cause, name, maxDepth, depth + 1);
}

export function hasTimeoutLikeCause(error: unknown): boolean {
  return hasCauseName(error, "TimeoutError") || hasCauseName(error, "AbortError");
}
