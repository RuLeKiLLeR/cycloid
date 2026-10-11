export type ProviderRetryResult<T> = {
  value: T;
  attempts: number;
};

export type ProviderRetryInfo = {
  /** Upcoming attempt number (1-indexed); the attempt that is about to be retried. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
};

export type ProviderRetryDependencies = {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

export type ProviderRetryOptions<T> = ProviderRetryDependencies & {
  op: (attemptSignal: AbortSignal) => Promise<T>;
  maxAttempts: number;
  perAttemptTimeoutMs?: number;
  callerSignal?: AbortSignal;
  isTransient?: (error: unknown) => boolean;
  getRetryAfterMs?: (error: unknown) => number | null;
  abortErrorFactory?: () => Error;
  baseMs?: number;
  jitterFactor?: number;
  /**
   * Invoked before each retry sleep with the scheduled-retry details. Best-effort:
   * the loop swallows any callback error so it can never break the retry path.
   */
  onRetry?: (info: ProviderRetryInfo) => void;
};

export class ProviderRetryAbortError extends Error {
  constructor(message?: string);
}

export function withProviderRetry<T>(opts: ProviderRetryOptions<T>): Promise<ProviderRetryResult<T>>;

export function isTransientProviderError(error: unknown): boolean;

export function getProviderRetryAfterMs(error: unknown): number | null;

export function getProviderRetryAttemptCount(error: unknown, fallback: number): number;

export function setProviderRetryAttemptCount(error: unknown, attempts: number): void;

export function createProviderAttemptSignal(
  callerSignal: AbortSignal | undefined,
  perAttemptTimeoutMs?: number,
): AbortSignal | undefined;

export function jitteredExponentialBackoffMs(
  attempt: number,
  random?: () => number,
  baseMs?: number,
  jitterFactor?: number,
): number;
