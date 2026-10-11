export function clampPollInterval(ms: number, minimum: number): number {
  return Math.max(ms, minimum);
}
