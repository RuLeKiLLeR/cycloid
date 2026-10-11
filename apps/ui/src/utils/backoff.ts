type RandomSource = () => number;

interface AdditiveRatioBackoffOptions {
  delayMs: number;
  maxMs: number;
  jitterRatio: number;
  random?: RandomSource;
}

interface MultiplierRangeBackoffOptions {
  delayMs: number;
  maxMs: number;
  minMultiplier: number;
  maxMultiplier: number;
  random?: RandomSource;
}

export function additiveRatioBackoffMs({
  delayMs,
  maxMs,
  jitterRatio,
  random = Math.random,
}: AdditiveRatioBackoffOptions): number {
  return Math.min(delayMs + delayMs * jitterRatio * random(), maxMs);
}

export function multiplierRangeBackoffMs({
  delayMs,
  maxMs,
  minMultiplier,
  maxMultiplier,
  random = Math.random,
}: MultiplierRangeBackoffOptions): number {
  const multiplier = minMultiplier + random() * (maxMultiplier - minMultiplier);
  return Math.min(delayMs * multiplier, maxMs);
}
