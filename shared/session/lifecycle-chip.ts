// The single source of truth for lifecycle chip vocabulary — consumed by BOTH
// the control plane's FSM projection (`session/fsm/project.ts`) and the UI's
// chip rendering. There is deliberately no second copy: a new FSM state or
// blocked reason fails `tsc` here (Record totality) until someone decides its
// chip, and the two sides cannot drift because they import the same map.
//
// Tone discipline follows DESIGN.md: `live` (arcane violet + heartbeat) is for
// genuinely in-flight agent work only; `error` is reserved for FAILED — the one
// state that means "the session could not complete"; NEEDS_YOU is a warning
// (grayscale) because the work is fine and waiting on a human.

// ── FSM vocabulary (canonical unions; the worker re-exports these) ───────────

export const FSM_STATES = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "AWAITING_INPUT",
  "FINALIZING",
  "PUBLISHING",
  "ANSWERED_NO_PR",
  "REVIEW",
  "VERIFYING",
  "MERGE_READY",
  "NEEDS_YOU",
  "FAILED",
  "STOPPED",
  "MERGED",
  "CLOSED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;
export type FsmState = (typeof FSM_STATES)[number];

export type BlockedReason =
  | "owner_approval"
  | "verification_noconverge"
  | "verification_unresolved"
  | "verification_run_limit"
  | "verification_stopped"
  | "ci_fix_exhausted"
  | "ci_flapping"
  | "review_stuck"
  // ARC-1330: an epoch's fix/reply POST to GitHub failed past its retry cap (publish_failed /
  // reply_failed) — an agent-execution give-up the cascade cannot re-derive from ground truth, so it
  // surfaces immediately (via epoch.blocked{response_failed}) instead of waiting out the
  // `REVIEW_STUCK_DEADLINE_MS` review_stuck backstop.
  // Added to the pr_coordination.blocked_reason CHECK in migration 0236.
  | "review_response_failed"
  | "internal_inconsistency";

export type FailureReason =
  "codegen_error" | "publish_failed" | "post_prep_failed" | "spawn_timeout" | "execution_timeout" | "sandbox_failed";

// ── Chip vocabulary ──────────────────────────────────────────────────────────

export type LifecycleChipTone = "live" | "success" | "warning" | "error" | "neutral";

export interface LifecycleChip {
  /** Sentence-case chip label ("Needs you", "Merge ready"). */
  label: string;
  tone: LifecycleChipTone;
  /** Heartbeat pulse — `live` states only. */
  pulse?: boolean;
}

/**
 * state → chip, total over the 17-state union. `ARCHIVED` is `null` — archived
 * sessions are hidden from queues, never chipped.
 */
export const LIFECYCLE_CHIP: Record<FsmState, LifecycleChip | null> = {
  CREATED: { label: "Working", tone: "live", pulse: true },
  PROVISIONING: { label: "Working", tone: "live", pulse: true },
  GENERATING: { label: "Working", tone: "live", pulse: true },
  AWAITING_INPUT: { label: "Needs input", tone: "warning" },
  FINALIZING: { label: "Publishing", tone: "live", pulse: true },
  PUBLISHING: { label: "Publishing", tone: "live", pulse: true },
  ANSWERED_NO_PR: { label: "Answered", tone: "neutral" },
  REVIEW: { label: "In review", tone: "live", pulse: true },
  VERIFYING: { label: "Verifying", tone: "live", pulse: true },
  MERGE_READY: { label: "Merge ready", tone: "success" },
  NEEDS_YOU: { label: "Needs you", tone: "warning" },
  FAILED: { label: "Failed", tone: "error" },
  STOPPED: { label: "Stopped", tone: "neutral" },
  MERGED: { label: "Merged", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
  ARCHIVED: null,
};

/**
 * `blocked_reason` → user-facing copy (design §12 "Blocked — needs you: <reason>").
 * The FSM projection's `BLOCKED_REASON_DISPLAY` threads THIS map for its copy
 * column, so PR-body stage text and UI row detail can never disagree.
 */
export const BLOCKED_REASON_COPY: Record<BlockedReason, string> = {
  owner_approval: "Needs owner approval",
  verification_noconverge: "Verification not converging",
  verification_unresolved: "Verification findings unresolved",
  verification_run_limit: "Verification run limit reached",
  verification_stopped: "Verification stopped / no verdict",
  ci_fix_exhausted: "CI fixes exhausted",
  ci_flapping: "CI flapping — needs you",
  review_stuck: "Review stalled — needs you",
  review_response_failed: "Couldn't post review response — needs you",
  internal_inconsistency: "Internal inconsistency — needs you",
};

/** `failure_reason` → user-facing copy for the FAILED chip's detail line. */
export const FAILURE_REASON_COPY: Record<FailureReason, string> = {
  codegen_error: "Agent run failed",
  publish_failed: "Publishing the PR failed",
  post_prep_failed: "Preparing the branch failed",
  spawn_timeout: "Sandbox never started",
  execution_timeout: "Run timed out",
  sandbox_failed: "Sandbox failed",
};

/**
 * The per-row detail line accompanying a chip: NEEDS_YOU carries its blocked
 * reason, FAILED its failure reason; every other state has none (their stage
 * copy lives in the PR-body projection, not the row). Defensive `?? null` so an
 * unrecognized reason (see the guards below — `failure_reason` is unconstrained
 * TEXT in D1) yields "no detail" rather than a stray `undefined` in the UI.
 */
export function lifecycleChipDetail(
  state: FsmState,
  blockedReason: BlockedReason | null | undefined,
  failureReason: FailureReason | null | undefined,
): string | null {
  if (state === "NEEDS_YOU" && blockedReason) return BLOCKED_REASON_COPY[blockedReason] ?? null;
  if (state === "FAILED" && failureReason) return FAILURE_REASON_COPY[failureReason] ?? null;
  return null;
}

// Runtime guards for the pr_coordination TEXT columns. `state` and
// `failure_reason` are unconstrained TEXT in D1 (`blocked_reason` is
// CHECK-constrained but guarded for symmetry), so the DAO validates each value
// against the canonical set before narrowing to the union — an unknown value
// resolves to null and the row falls back to legacy rendering instead of
// indexing a map to `undefined`. Sets are derived from the canonical
// unions/maps, so the guards can't drift; `Set.has` also avoids the
// prototype-chain footgun of `in` (`"toString" in map` is true).
const FSM_STATE_SET: ReadonlySet<string> = new Set(FSM_STATES);
const BLOCKED_REASON_SET: ReadonlySet<string> = new Set(Object.keys(BLOCKED_REASON_COPY));
const FAILURE_REASON_SET: ReadonlySet<string> = new Set(Object.keys(FAILURE_REASON_COPY));

export function isFsmState(v: string | null | undefined): v is FsmState {
  return v != null && FSM_STATE_SET.has(v);
}
export function isBlockedReason(v: string | null | undefined): v is BlockedReason {
  return v != null && BLOCKED_REASON_SET.has(v);
}
export function isFailureReason(v: string | null | undefined): v is FailureReason {
  return v != null && FAILURE_REASON_SET.has(v);
}
