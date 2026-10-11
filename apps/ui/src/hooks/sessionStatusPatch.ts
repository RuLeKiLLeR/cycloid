import type { DisplayStatus } from "../../../../shared/session/display-status";
import type { UiLifecycleStage } from "../../../../shared/session/lifecycle-stage";
import type { FinalizingStep, Phase, SandboxSubstate, StopMode } from "../../../../shared/session/phase";
import type { SessionMetadata } from "../types";

interface SessionStatusPatchInput {
  phase: Phase;
  displayStatus?: DisplayStatus;
  uiLifecycleStage?: UiLifecycleStage;
  title?: string | null;
  sandboxSubstate?: SandboxSubstate | null;
  stopMode?: StopMode | null;
  finalizingStep?: FinalizingStep | null;
  /**
   * True while a user-manually-stopped session is kept live-idle (sandbox stays
   * live underneath; phase remains `idle`). Cleared to `false` on the next
   * prompt admit so the "Stopped" badge doesn't stick.
   */
  userStopped?: boolean;
}

/**
 * Build the `SessionMetadata` patch for a status / phase update. Shared by the
 * per-session replay path (`useSessionReplay.syncSessionStatus`) and the sidebar
 * feed reducer (`applyFeedDelta`) so the two field-mappings can never drift
 * (ARC-1322).
 *
 * Stamps `lastLiveStatusPatchAt` so a later stale list-poll snapshot cannot
 * clobber this live update (see `mergeSessionSnapshotWithLivePatches`). Missing
 * lifecycle fields are skipped (conditional spread) so they never overwrite an
 * existing value with undefined; `title` is intentionally allowed to be `null`.
 */
export function buildSessionStatusPatch(input: SessionStatusPatchInput, patchedAt: number): Partial<SessionMetadata> {
  return {
    phase: input.phase,
    ...(input.displayStatus !== undefined ? { displayStatus: input.displayStatus } : {}),
    // A phase-only status delta freshens phase/displayStatus but carries no FSM
    // fields, so a previously-fetched fsmState is now potentially stale (e.g.
    // REVIEW→NEEDS_YOU). Clear the FSM trio so FSM-first bucketing/chips fall
    // back to the fresh displayStatus until the next full upsert re-populates
    // them. They ride lastLiveStatusPatchAt (below), so the snapshot merge
    // preserves this clear over an in-flight stale poll.
    fsmState: null,
    blockedReason: null,
    failureReason: null,
    ...(input.uiLifecycleStage !== undefined ? { uiLifecycleStage: input.uiLifecycleStage } : {}),
    ...(input.sandboxSubstate != null ? { sandboxSubstate: input.sandboxSubstate } : {}),
    ...(input.stopMode != null ? { stopMode: input.stopMode } : {}),
    ...(input.finalizingStep != null ? { finalizingStep: input.finalizingStep } : {}),
    // `!== undefined` (NOT the `!= null` group above): prompt-admit clears the
    // stop by sending `userStopped:false`, and that explicit `false` must ride
    // the patch so the reducer merge overwrites a prior `true` (else the
    // "Stopped" badge sticks). Only a fully-omitted field is a no-op.
    ...(input.userStopped !== undefined ? { userStopped: input.userStopped } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    lastLiveStatusPatchAt: patchedAt,
  };
}
