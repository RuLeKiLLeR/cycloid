type RandomSource = () => number;

interface AdditiveJitterBackoffOptions {
  attempt: number;
  attemptOffset: number;
  baseMs: number;
  maxBaseMs: number;
  jitterMs: number;
  random?: RandomSource;
}

interface MultiplicativeJitterBackoffOptions {
  attempt: number;
  attemptOffset: number;
  baseMs: number;
  maxMs: number;
  jitterFactor: number;
  random?: RandomSource;
}

export function additiveJitterBackoffMs({
  attempt,
  attemptOffset,
  baseMs,
  maxBaseMs,
  jitterMs,
  random = Math.random,
}: AdditiveJitterBackoffOptions): number {
  const exponent = Math.max(0, attempt - attemptOffset);
  const base = Math.min(baseMs * 2 ** exponent, maxBaseMs);
  return base + random() * jitterMs;
}

export function multiplicativeJitterBackoffMs({
  attempt,
  attemptOffset,
  baseMs,
  maxMs,
  jitterFactor,
  random = Math.random,
}: MultiplicativeJitterBackoffOptions): number {
  const exponent = Math.max(0, attempt - attemptOffset);
  const base = Math.min(baseMs * 2 ** exponent, maxMs);
  return Math.min(maxMs, Math.round(base * (1 + random() * jitterFactor)));
}
