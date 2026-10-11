import type { SessionMetadata } from "../types";

/**
 * Reconcile a server list-poll snapshot with the sidebar row's locally
 * live-patched fields, so a poll that was already in flight when a live update
 * (per-session WS replay or the ARC-1322 feed) arrived cannot clobber the newer
 * local value.
 *
 * Each field-group rides a freshness marker stamped at patch time; a group is
 * preserved from `local` only when its marker is newer than when the poll was
 * issued (`requestIssuedAt`). Markers are deliberately split so a patch that
 * touches one group does not shield another:
 *   - lastLiveStatusPatchAt   → phase / displayStatus / lifecycle / title / reviewLoopDoneState / closeReason / userStopped / fsmState+blockedReason+failureReason
 *   - lastLivePrPatchAt        → prUrl / prDraft / prManualReviewReason
 *   - lastLiveVerificationPatchAt → verification/result + done-state badge
 *
 * `reviewLoopDoneState` rides both the status marker and the verification
 * marker (the live feed plus the open-detail `SessionDetail` patch path). A
 * phase-only `session_status` delta must NOT shield `cycloidDone*` — those ride
 * the verification marker only.
 */
export function mergeSessionSnapshotWithLivePatches(
  snapshot: SessionMetadata,
  local: SessionMetadata | undefined,
  requestIssuedAt: number,
): SessionMetadata {
  if (!local) return snapshot;

  const preserveStatus = (local.lastLiveStatusPatchAt ?? 0) > requestIssuedAt;
  const preservePr = (local.lastLivePrPatchAt ?? 0) > requestIssuedAt;
  const preserveVerification = (local.lastLiveVerificationPatchAt ?? 0) > requestIssuedAt;

  return {
    ...snapshot,
    ...(preserveStatus
      ? {
          phase: local.phase,
          displayStatus: local.displayStatus,
          uiLifecycleStage: local.uiLifecycleStage,
          sandboxSubstate: local.sandboxSubstate,
          stopMode: local.stopMode,
          finalizingStep: local.finalizingStep,
          title: local.title,
          reviewLoopDoneState: local.reviewLoopDoneState,
          closeReason: local.closeReason,
          userStopped: local.userStopped,
          // The FSM trio rides the status marker: a live status delta clears
          // these (freshening displayStatus without them), so preserving the
          // local values here stops an in-flight stale poll's snapshot from
          // re-supplying a superseded fsmState over the fresher status.
          fsmState: local.fsmState,
          blockedReason: local.blockedReason,
          failureReason: local.failureReason,
        }
      : {}),
    ...(preserveVerification
      ? {
          reviewLoopDoneState: local.reviewLoopDoneState,
          cycloidDoneState: local.cycloidDoneState,
          cycloidDoneOutcome: local.cycloidDoneOutcome,
          cycloidDoneReasons: local.cycloidDoneReasons,
          verificationState: local.verificationState,
          verificationResult: local.verificationResult,
          verificationNeedsWorkLabel: local.verificationNeedsWorkLabel,
          verificationAttemptCount: local.verificationAttemptCount,
          verificationMaxAttempts: local.verificationMaxAttempts,
        }
      : {}),
    ...(preservePr
      ? {
          prUrl: local.prUrl,
          prDraft: local.prDraft,
          prManualReviewReason: local.prManualReviewReason,
        }
      : {}),
    ...(local.lastLiveStatusPatchAt !== undefined ? { lastLiveStatusPatchAt: local.lastLiveStatusPatchAt } : {}),
    ...(local.lastLivePrPatchAt !== undefined ? { lastLivePrPatchAt: local.lastLivePrPatchAt } : {}),
    ...(local.lastLiveVerificationPatchAt !== undefined
      ? { lastLiveVerificationPatchAt: local.lastLiveVerificationPatchAt }
      : {}),
  };
}
