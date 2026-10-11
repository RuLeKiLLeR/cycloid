import type { UiLifecycleStage } from "./lifecycle-stage.js";
import type { FinalizingStep, Phase } from "./phase.js";

export type DisplayStatus = "working" | "waiting_for_input" | "completed" | "failed" | "stopped" | "archived";

export function displayStatusFromPhase(phase: Phase | string | null | undefined): DisplayStatus {
  switch (phase) {
    case "archived":
      return "archived";
    case "stopped":
      return "stopped";
    case "running":
    case "finalizing":
      return "working";
    case "waiting_for_input":
      return "waiting_for_input";
    case "completed":
    case "review_listening":
      return "completed";
    case "blocked":
    case "failed":
      return "failed";
    case "idle":
    case "superseded":
      return "stopped";
    default:
      return "stopped";
  }
}

export type SessionDisplayStatusInput = {
  phase: Phase;
  finalizingStep?: FinalizingStep | null;
  uiLifecycleStage?: UiLifecycleStage | null;
};

/**
 * Canonical display status for a full session record. Phase remains the
 * authority for stopped/error/input states; the finer finalizing and PR stages
 * prevent an active verification run or a settled PR from being flattened to
 * a stale generic status.
 */
export function displayStatusFromSession(input: SessionDisplayStatusInput): DisplayStatus {
  switch (input.phase) {
    case "archived":
      return "archived";
    case "stopped":
      return "stopped";
    case "waiting_for_input":
      return "waiting_for_input";
    case "blocked":
    case "failed":
      return "failed";
  }

  switch (input.uiLifecycleStage) {
    case "verifying":
      return "working";
    case "merge_ready":
    case "merged":
    case "closed":
    case "superseded":
      return "completed";
  }

  if (input.phase === "finalizing" && input.finalizingStep !== "none") return "working";
  return displayStatusFromPhase(input.phase);
}
