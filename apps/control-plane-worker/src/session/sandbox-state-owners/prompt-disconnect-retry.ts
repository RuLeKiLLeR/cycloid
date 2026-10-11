/**
 * Bounds how many times a single prompt's run is re-cloned onto a fresh
 * sandbox after a mid-turn `sandbox_disconnected`. Unlike the spawn-side
 * `spawn_retry_count` (which lives on `sandbox_state` and resets on every
 * successful connect), this budget is prompt-scoped: a disconnect-retry that
 * connects and then dies again mid-turn must still count toward the cap.
 *
 * Cap N => up to N retries => N+1 total runs of the original prompt.
 */
export const DISCONNECT_RETRY_CAP = 2;

export interface PromptDisconnectRetryDecision {
  /** The prompt's pre-retry count (0 for a prompt that has never been retried). */
  retryCount: number;
  /** True when the cap is reached and the disconnect must fail terminally. */
  retryCapReached: boolean;
  /** The count to stamp onto the retry clone when under cap (`retryCount + 1`). */
  nextRetryCount: number;
}

/**
 * Pure decision over a prompt's current `disconnectRetryCount`. The counter
 * rides the retry-clone chain (each clone is stamped with `nextRetryCount` and
 * persisted atomically with the clone row via `bulkUpdatePrompts`), so there is
 * no separate peek/commit ordering or reset-on-success to manage: a crash
 * before the clone persists leaves the original prompt's count unchanged, and a
 * fresh follow-up prompt starts at 0.
 */
export function decidePromptDisconnectRetry(currentRetryCount: number | undefined): PromptDisconnectRetryDecision {
  const retryCount = currentRetryCount ?? 0;
  return {
    retryCount,
    retryCapReached: retryCount >= DISCONNECT_RETRY_CAP,
    nextRetryCount: retryCount + 1,
  };
}
