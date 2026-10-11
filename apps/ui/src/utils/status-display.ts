import type { DisplayStatus } from "../../../../shared/session/display-status";
import type { Phase } from "../types";

export type { DisplayStatus } from "../../../../shared/session/display-status";

export const STATUS_DISPLAY_LABEL: Record<DisplayStatus, string> = {
  working: "Working",
  waiting_for_input: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  archived: "Archived",
};

// Active-prompt phases: the prompt is still running. Includes `waiting_for_input`
// so stop/transcript-turn UIs treat the pending question as live. This is the
// transcript-liveness gate (SessionTurn); `finalizing` is intentionally excluded
// because there is no live prompt while the server publishes, and arriving phase
// vs. prompt-result frames can briefly disagree on a flaky transport.
/** True when the session has an in-flight prompt (running or waiting on a question). */
export function isActivePrompt(phase: Phase | string | null | undefined, planApprovalPending: boolean): boolean {
  return !planApprovalPending && (phase === "running" || phase === "waiting_for_input");
}

// Phases the WS liveness watchdog must keep the socket warm for. A superset of
// `isActivePrompt` that also covers `finalizing`: the publish/verify window emits
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
// state-bearing side-channel frames (verification_updated, pr_created,
// session_status) that carry no sequence and are not replayable, so a half-open
// socket must be force-reconnected to recover the fresh `subscribed` snapshot
// rather than silently going stale until a manual refresh (ARC-1318). Kept
// separate from `isActivePrompt` so arming the watchdog during finalizing does
// not affect the transcript-liveness gate. `review_listening` and parked plans
// are excluded: both are long-lived and emit no liveness heartbeat for >90s,
// which would turn the watchdog into a 90s-cadence reconnect storm.
/** True when the WS liveness watchdog should stay armed for this phase. */
export function isWatchdogActivePhase(phase: Phase | string | null | undefined, planApprovalPending: boolean): boolean {
  return !planApprovalPending && (isActivePrompt(phase, false) || phase === "finalizing");
}
