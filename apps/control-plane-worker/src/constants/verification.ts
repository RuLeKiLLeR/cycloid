import type { VerificationState } from "../../../../shared/session/phase";

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export const MAX_VERIFICATION_RUNS_PER_PR = 3;

/**
 * Monotonic rank for verification states (ARC-1219). Used by the label reconcile and the
 * DO state-write guard to reject only a late fire-and-forget `verification-pending` write
 * that would demote a more-advanced state. The terminal states share rank 3; ordering among
 * them is not meaningful here (the guard only blocks `pending`, never terminal-vs-terminal).
 */
export const VERIFICATION_STATE_RANK: Record<VerificationState, number> = {
  "verification-pending": 1,
  "verification-in-progress": 2,
  "verification-done": 3,
  "verification-skipped": 3,
  "verification-stopped": 3,
  "verification-exhausted": 3,
};

export const VERIFICATION_PENDING_RANK = VERIFICATION_STATE_RANK["verification-pending"];

/**
 * Bound for parallel session-DO reads/writes on webhook-path fan-outs.
 * Matches the Workers runtime's simultaneous outbound connection throttle.
 */
export const SESSION_DO_FANOUT_CONCURRENCY = 6;
