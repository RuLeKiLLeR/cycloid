import type { ServerMessage } from "../hooks/useSessionWebSocket";
import type { Provider, SessionDetail } from "../types";
import { parseModelSelection } from "./models";

type CurrentSessionMetadata = Pick<SessionDetail, "model" | "ownerLogin" | "ownerAvatarUrl">;

export function toSubscribedSessionDetail(
  message: Extract<ServerMessage, { type: "subscribed" }>,
  currentSession: CurrentSessionMetadata | null,
  providers?: Provider[],
): SessionDetail {
  const createdAt = Date.parse(message.session.createdAt);
  const model = message.session.model
    ? (parseModelSelection(message.session.model, providers) ?? currentSession?.model ?? null)
    : (currentSession?.model ?? null);
  const ownerLogin = message.session.ownerLogin !== undefined ? message.session.ownerLogin : currentSession?.ownerLogin;
  const ownerAvatarUrl =
    message.session.ownerAvatarUrl !== undefined ? message.session.ownerAvatarUrl : currentSession?.ownerAvatarUrl;

  return {
    sessionId: message.session.sessionId,
    phase: message.session.phase,
    displayStatus: message.session.displayStatus,
    // Rehydrates the plan-approval park across reload / reconnect so the header
    // "Needs you" chip, watchdog disarm, and Discuss composer survive without
    // waiting for the next live status frame. `ClientSessionSnapshot` always
    // carries these (PlanApprovalMetadata), defaulting to a non-parked session.
    planApprovalPending: message.session.planApprovalPending,
    planRevision: message.session.planRevision,
    planStatus: message.session.planStatus,
    ...(message.session.parentSessionId
      ? {
          parentSessionId: message.session.parentSessionId,
          parentPromptId: message.session.parentPromptId,
          spawnDepth: message.session.spawnDepth,
        }
      : {}),
    ...(message.session.childSessionIds?.length ? { childSessionIds: message.session.childSessionIds } : {}),
    ...(message.session.qaChildSessionId ? { qaChildSessionId: message.session.qaChildSessionId } : {}),
    ...(message.session.sandboxSubstate !== undefined ? { sandboxSubstate: message.session.sandboxSubstate } : {}),
    ...(message.session.stopMode !== undefined ? { stopMode: message.session.stopMode } : {}),
    // Rehydrates the live-idle "Stopped — continue anytime" badge across reload /
    // reconnect (the snapshot carries it from `buildClientSessionSnapshot`).
    ...(message.session.userStopped !== undefined ? { userStopped: message.session.userStopped } : {}),
    ...(message.session.finalizingStep !== undefined ? { finalizingStep: message.session.finalizingStep } : {}),
    ...(message.session.uiLifecycleStage !== undefined ? { uiLifecycleStage: message.session.uiLifecycleStage } : {}),
    planAutoReason: message.session.planAutoReason ?? null,
    closeReason: message.session.closeReason ?? null,
    ...(ownerLogin !== undefined ? { ownerLogin } : {}),
    ...(ownerAvatarUrl !== undefined ? { ownerAvatarUrl } : {}),
    prUrl: message.session.prUrl ?? null,
    prDraft: message.session.prDraft ?? message.session.verification?.publishMode === "draft",
    prManualReviewReason:
      message.session.prManualReviewReason ?? message.session.verification?.manualReviewReason ?? null,
    publishStatus: message.session.publishStatus ?? "not_started",
    publishError: message.session.publishError ?? null,
    publishedBranch: message.session.publishedBranch ?? null,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    model,
    desktopActionPathAvailable: message.session.desktopActionPathAvailable === true,
    reasoningEffort: message.session.reasoningEffort ?? null,
    title: message.session.title,
    queueLength: message.queue.queuedCount,
    repoUrl: message.session.repoUrl ?? null,
    lastBranch: message.session.lastBranch ?? null,
    baseBranch: message.session.baseBranch ?? null,
    spawnDurationMs: message.session.spawnDurationMs ?? null,
    sandboxId: message.sandbox.sandboxId ?? null,
    sandboxConnected: message.sandbox.connected ?? null,
    verification: message.session.verification ?? null,
    verificationSummary: message.session.verificationSummary ?? null,
    qaRun: message.session.qaRun ?? null,
    runtimeProvenance: message.session.runtimeProvenance ?? null,
    observabilityReadiness: message.session.observabilityReadiness ?? null,
    initiationMode: message.session.initiationMode ?? "user",
    entrypoint: message.session.entrypoint ?? null,
    scheduledRuleId: message.session.scheduledRuleId ?? null,
    ruleNameSnapshot: message.session.ruleNameSnapshot ?? null,
    cronSnapshot: message.session.cronSnapshot ?? null,
    reviewLoopDoneState: message.session.reviewLoopDoneState ?? null,
    cycloidDoneState: message.session.cycloidDoneState ?? "working",
    cycloidDoneOutcome: message.session.cycloidDoneOutcome ?? null,
    cycloidDoneReasons: message.session.cycloidDoneReasons ?? [],
    verificationState: message.session.verificationState ?? null,
    verificationResult: message.session.verificationResult ?? null,
    verificationNeedsWorkLabel: message.session.verificationNeedsWorkLabel ?? null,
    ...(message.session.verificationAttemptCount !== undefined
      ? { verificationAttemptCount: message.session.verificationAttemptCount }
      : {}),
    ...(message.session.verificationMaxAttempts !== undefined
      ? { verificationMaxAttempts: message.session.verificationMaxAttempts }
      : {}),
  };
}
