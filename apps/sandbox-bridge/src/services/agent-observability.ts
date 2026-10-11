export type OutputTokensObservation = {
  atMs: number;
  outputTokens: number;
  model: string;
};

export type OutputTokensPerSecondSample = {
  outputTokensPerSecond: number;
  outputTokens: number;
  durationMs: number;
  model: string;
};

export function computeOutputTokensPerSecondSample(
  previous: OutputTokensObservation,
  next: OutputTokensObservation,
): OutputTokensPerSecondSample | null {
  const durationMs = Math.max(0, next.atMs - previous.atMs);
  const outputTokens = Math.max(0, next.outputTokens - previous.outputTokens);
  if (durationMs <= 0 || outputTokens <= 0) return null;
  return {
    outputTokensPerSecond: outputTokens / (durationMs / 1000),
    outputTokens,
    durationMs,
    model: next.model,
  };
}

export function computeCompactionTokensReclaimed(before: number, after: number): number {
  return Math.max(0, before - after);
}

export function shouldEmitClaudeRateLimitedMetric(rateLimitInfo: { status?: unknown } | null | undefined): boolean {
  const status = typeof rateLimitInfo?.status === "string" ? rateLimitInfo.status : undefined;
  return Boolean(status && status !== "allowed");
}
