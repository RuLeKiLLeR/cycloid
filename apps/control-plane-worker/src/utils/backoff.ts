type RandomSource = () => number;

interface HalfJitterBackoffOptions {
  attempt: number;
  baseMs: number;
  maxMs: number;
  random?: RandomSource;
}

export function halfJitterBackoffMs({
  attempt,
  baseMs,
  maxMs,
  random = Math.random,
}: HalfJitterBackoffOptions): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jittered = exponential * (0.5 + 0.5 * random());
  return Math.min(maxMs, jittered);
}
