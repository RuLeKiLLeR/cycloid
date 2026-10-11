type RetryPolicy = {
  maxAttempts: number;
};

export const DEFAULT_SPAWN_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
};

export class SpawnRetryAbortedError extends Error {
  constructor(readonly reason: "stale" | "ready") {
    super(`Spawn retry aborted: ${reason}`);
    this.name = "SpawnRetryAbortedError";
  }
}
