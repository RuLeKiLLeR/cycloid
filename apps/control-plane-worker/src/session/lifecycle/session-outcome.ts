import { canonicalErrorCode, isErrorCode } from "../../../../../shared/types/error-codes.js";
import type { ErrorCode } from "../../../../../shared/types/sandbox.js";
import type { SandboxTerminateReason } from "../../sandbox/e2b-client.js";
import { pickTerminalErrorCode } from "./terminal-decision.js";

/**
 * Session-deduped outcome attribution (the "outcome truth" layer).
 *
 * prompt_runs records one noisy row per prompt-run, inflated by retries and skewed
 * toward error LABELS. This module collapses a whole session into ONE outcome and ONE
 * attributed cause so we can measure user HARM ("did the session reach its intended
 * terminal — a PR or an answer?") instead of label churn. It is pure so the
 * classification is unit-tested away from the Durable Object.
 */

export type SessionOutcomeClass = "succeeded" | "failed" | "abandoned";

export type SessionTerminalStage =
  "pr_created" | "prompt_completed_no_pr" | "prompt_failed" | "queued_unprocessed" | "no_prompts";

export interface SessionOutcomeFacts {
  /** A PR was opened for the session (the strongest "reached terminal" signal). */
  prCreated: boolean;
  /** Status of the most recent prompt: "completed" | "failed" | "queued" | "processing" | null. */
  lastPromptStatus: string | null;
  completedPromptCount: number;
  failedPromptCount: number;
  queuedPromptCount: number;
  promptCount: number;
  /** Per-prompt error codes from prompt_telemetry (any order; nulls/unknown strings tolerated). */
  promptErrorCodes: (string | null | undefined)[];
  /** The close reason recorded at the convergence point (e.g. "user_closed", "sandbox_disconnected"). */
  closeReason: string;
  /**
   * Count of failed prompts NOT attributable to a user-initiated archive/abort, derived
   * from synchronous close-boundary facts (the prompt-failure rows, not the lagging
   * telemetry write). Defaults to failedPromptCount when omitted — historical/backfill
   * rows have no synchronous signal, so they keep the original "any failure" behavior.
   * A user closing a session mid-prompt force-fails the active prompt with errorCode
   * "session_archived"; that benign failure must not flip an abandonment into a "failed".
   */
  realFailedPromptCount?: number;
  /**
   * Server-side reason the sandbox was terminated, when the close was driven by a
   * control-plane kill rather than the user. NULL until the producer threads it in.
   */
  terminationReason?: SandboxTerminateReason | null;
}

export interface SessionOutcomeAttribution {
  outcome: SessionOutcomeClass;
  reachedTerminal: boolean;
  terminalStage: SessionTerminalStage;
  /** Single attributed ErrorCode; null unless outcome === "failed". */
  failureCause: ErrorCode | null;
  /** Server-side sandbox termination reason carried through to the persisted row; null if none. */
  terminationReason: SandboxTerminateReason | null;
}

// User-initiated closes where no NON-benign prompt failed are abandonment, not system
// harm: the user walked away. A non-user close reason (e.g. sandbox_disconnected,
// max_duration) on an unfinished session is harm even if a "close" was synthesized to
// archive it.
const USER_INITIATED_CLOSE_REASONS = new Set<string>([
  "user_closed",
  "user_archived",
  "user_deleted",
  "slack_stop_interaction",
  "slack_stop_message",
]);

// Error codes that mark a prompt failure as a user-driven archive/abort rather than a
// real infra failure. Used to tell "user closed mid-prompt" apart from "the session
// actually broke" when counting real failures.
const ABANDONMENT_BENIGN_FAILURE_CODES = new Set<string>(["session_archived", "aborted"]);

// SandboxTerminateReasons that mean the system killed live work (the reaper-kills-healthy-VM
// failure class) and so count as harm. Everything else in the union is routine resource
// management (runtime cleanup, duplicate-spawn dedup, resume cleanup) and is
// NOT harm on its own. Add a new reason here only when it represents killing real work.
const HARMFUL_TERMINATION_REASONS = new Set<SandboxTerminateReason>([
  "orphan_reaper",
  "cold_create_unusable",
  "bridge_start_failed",
  "stale_spawn_after_bridge",
]);

export function isHarmfulTerminationReason(reason: SandboxTerminateReason): boolean {
  return HARMFUL_TERMINATION_REASONS.has(reason);
}

/**
 * Count failed prompts that represent real infra harm, excluding benign user-driven
 * failures: the active prompt force-failed by an archive close (matched by id, since its
 * "session_archived" telemetry write is scheduled async and may not be visible yet), and
 * any prompt whose settled error code is in ABANDONMENT_BENIGN_FAILURE_CODES. Pure so the
 * benign-classification is unit-tested without the Durable Object.
 */
export function countRealFailedPrompts(
  failedPrompts: { promptId: string; errorCode: string | null | undefined }[],
  archivedActivePromptId: string | null,
): number {
  let count = 0;
  for (const p of failedPrompts) {
    const benign =
      (archivedActivePromptId !== null && p.promptId === archivedActivePromptId) ||
      (p.errorCode != null && ABANDONMENT_BENIGN_FAILURE_CODES.has(p.errorCode));
    if (!benign) count += 1;
  }
  return count;
}

/**
 * Derive the terminal stage so it can never contradict the outcome: a session that
 * recovered from an early failed prompt and then completed (reachedTerminal) must read
 * "prompt_completed_no_pr", not "prompt_failed". We therefore key the completed/failed
 * split off reachedTerminal rather than raw counts (which can be non-zero for both), and
 * key the prompt_failed stage off realFailedPromptCount so a benign archive/abort
 * force-fail (which makes the outcome "abandoned") is not labeled "prompt_failed". That
 * keeps the stage consistent with the outcome: an abandoned mid-prompt close reads as
 * "queued_unprocessed" (the prompt never reached terminal), the same as a session
 * abandoned while a prompt was still processing/queued.
 */
function deriveTerminalStage(facts: SessionOutcomeFacts, reachedTerminal: boolean): SessionTerminalStage {
  const realFailedPromptCount = facts.realFailedPromptCount ?? facts.failedPromptCount;
  if (facts.prCreated) return "pr_created";
  if (reachedTerminal) return "prompt_completed_no_pr";
  if (realFailedPromptCount > 0) return "prompt_failed";
  // A prompt force-failed by a user archive/abort never reached terminal, so it reads as
  // unprocessed alongside genuinely queued prompts rather than as a real failure.
  if (facts.queuedPromptCount > 0 || facts.failedPromptCount > 0) return "queued_unprocessed";
  // Earlier prompts completed but the latest did not reach terminal (e.g. closed mid-run).
  if (facts.completedPromptCount > 0) return "prompt_completed_no_pr";
  return "no_prompts";
}

/**
 * Pick the single attributed failure cause:
 *   1. precedence-dedup over the session's per-prompt error codes (spawn > sandbox > codex > user),
 *   2. else the close reason if it is itself an ErrorCode (e.g. "sandbox_disconnected"),
 *   3. else "unknown".
 */
function attributeFailureCause(facts: SessionOutcomeFacts): ErrorCode {
  let cause: ErrorCode | null = null;
  for (const raw of facts.promptErrorCodes) {
    if (isErrorCode(raw)) {
      cause = pickTerminalErrorCode(cause, canonicalErrorCode(raw));
    }
  }
  if (cause) return cause;
  if (isErrorCode(facts.closeReason)) return canonicalErrorCode(facts.closeReason);
  return "unknown";
}

export function attributeSessionOutcome(facts: SessionOutcomeFacts): SessionOutcomeAttribution {
  const terminationReason = facts.terminationReason ?? null;
  // Backfill/historical rows omit realFailedPromptCount; fall back to failedPromptCount so
  // they keep the original behavior (any failure blocks abandonment) and prod numbers do
  // not shift retroactively.
  const realFailedPromptCount = facts.realFailedPromptCount ?? facts.failedPromptCount;

  // Reached its intended terminal if a PR exists or the latest ask was answered.
  const reachedTerminal = facts.prCreated || facts.lastPromptStatus === "completed";
  const terminalStage = deriveTerminalStage(facts, reachedTerminal);

  if (reachedTerminal) {
    return { outcome: "succeeded", reachedTerminal: true, terminalStage, failureCause: null, terminationReason };
  }

  // No work attempted -> not a session that could have been harmed (home/prewarm shells,
  // open-then-close). Excluded from the harm denominator.
  if (facts.promptCount === 0) {
    return { outcome: "abandoned", reachedTerminal: false, terminalStage, failureCause: null, terminationReason };
  }

  // User closed an unfinished session with no real (non-benign) prompt failure: walked
  // away, not a failure. A mid-prompt user close force-fails the active prompt with
  // "session_archived"; realFailedPromptCount excludes that so the close is still abandonment.
  if (USER_INITIATED_CLOSE_REASONS.has(facts.closeReason) && realFailedPromptCount === 0) {
    return { outcome: "abandoned", reachedTerminal: false, terminalStage, failureCause: null, terminationReason };
  }

  // System tore the sandbox down for routine resource management (runtime
  // cleanup, duplicate-spawn dedup) and no prompt actually failed: not user harm. A
  // harmful kill (orphan_reaper, bridge_start_failed, ...) on live work stays failed, and
  // a real prompt failure (realFailedPromptCount > 0) is always harm regardless of why the
  // sandbox later went away.
  if (realFailedPromptCount === 0 && terminationReason !== null && !isHarmfulTerminationReason(terminationReason)) {
    return { outcome: "abandoned", reachedTerminal: false, terminalStage, failureCause: null, terminationReason };
  }

  return {
    outcome: "failed",
    reachedTerminal: false,
    terminalStage,
    failureCause: attributeFailureCause(facts),
    terminationReason,
  };
}
