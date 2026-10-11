const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_JITTER_FACTOR = 0.2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;

export class ProviderRetryAbortError extends Error {
  constructor(message = "Provider retry aborted") {
    super(message);
    this.name = "ProviderRetryAbortError";
  }
}

export function isTransientProviderError(error) {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;

  const status = getProviderErrorStatus(error);
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;

  return false;
}

export function getProviderRetryAfterMs(error) {
  const headers = getProviderErrorHeaders(error);
  if (!headers) return null;

  const retryAfterMsHeader = headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const retryAfterMs = Number.parseFloat(retryAfterMsHeader);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  }

  const retryAfterHeader = headers.get("retry-after");
  if (!retryAfterHeader) return null;

  const retryAfterSeconds = Number.parseFloat(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}

export function getProviderRetryAttemptCount(error, fallback) {
  if (!error || typeof error !== "object" || !("__retryAttempts" in error)) return fallback;
  return typeof error.__retryAttempts === "number" ? error.__retryAttempts : fallback;
}

export function setProviderRetryAttemptCount(error, attempts) {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, "__retryAttempts", {
      value: attempts,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Non-extensible errors can still be wrapped; callers fall back to outer attempt tracking.
  }
}

export function createProviderAttemptSignal(callerSignal, perAttemptTimeoutMs) {
  if (!perAttemptTimeoutMs) return callerSignal;
  const timeoutSignal = AbortSignal.timeout(perAttemptTimeoutMs);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

export async function withProviderRetry(opts) {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be at least 1");
  }

  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const isTransient = opts.isTransient ?? isTransientProviderError;
  const getRetryAfterMs = opts.getRetryAfterMs ?? getProviderRetryAfterMs;
  const abortErrorFactory = opts.abortErrorFactory ?? (() => new ProviderRetryAbortError());

  let attempts = 0;
  while (attempts < opts.maxAttempts) {
    if (opts.callerSignal?.aborted) throw abortErrorFactory();

    attempts += 1;
    const attemptSignal = createProviderAttemptSignal(opts.callerSignal, perAttemptTimeoutMs);

    try {
      const value = await opts.op(attemptSignal ?? new AbortController().signal);
      return { value, attempts };
    } catch (error) {
      if (opts.callerSignal?.aborted) throw abortErrorFactory();

      if (!isTransient(error) || attempts >= opts.maxAttempts) {
        setProviderRetryAttemptCount(error, attempts);
        throw error;
      }

      const delayMs = Math.max(
        getRetryAfterMs(error) ?? 0,
        jitteredExponentialBackoffMs(attempts, random, opts.baseMs, opts.jitterFactor),
      );

      // Notify the caller of the scheduled retry before sleeping so it can surface
      // a `retry_status` lifecycle event. `attempt` is the upcoming attempt number
      // (1-indexed). Best-effort: a callback throw must never break the retry loop.
      if (opts.onRetry) {
        try {
          opts.onRetry({ attempt: attempts + 1, maxAttempts: opts.maxAttempts, delayMs, error });
        } catch {
          // ignore callback failures
        }
      }

      try {
        await sleep(delayMs, opts.callerSignal ?? new AbortController().signal);
      } catch (sleepError) {
        if (opts.callerSignal?.aborted) throw abortErrorFactory();
        throw sleepError;
      }
    }
  }

  throw new Error("Provider retry loop exited without a result");
}

export function jitteredExponentialBackoffMs(
  attempt,
  random = Math.random,
  baseMs = DEFAULT_RETRY_BASE_MS,
  jitterFactor = DEFAULT_RETRY_JITTER_FACTOR,
) {
  const backoffBaseMs = baseMs * 2 ** (attempt - 1);
  const jitterMultiplier = 1 + (random() * 2 - 1) * jitterFactor;
  return Math.max(0, Math.round(backoffBaseMs * jitterMultiplier));
}

async function defaultSleep(ms, signal) {
  if (ms <= 0) return;

  await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderRetryAbortError());
      return;
    }

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      reject(new ProviderRetryAbortError());
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function getProviderErrorStatus(error) {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function getProviderErrorHeaders(error) {
  if (!error || typeof error !== "object" || !("headers" in error)) return undefined;
  const headers = error.headers;
  if (!headers || typeof headers !== "object" || typeof headers.get !== "function") return undefined;
  return headers;
}
