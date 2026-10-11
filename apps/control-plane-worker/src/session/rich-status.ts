import { isLatestCompletedPromptNoChanges } from "../../../../shared/session/no-change-outcome.js";
import {
  computePhase,
  type PhaseInfo,
  type PhaseInputs,
  richStatusFromPhase,
} from "../../../../shared/session/phase.js";
import type { PublishStatus } from "../../../../shared/types/publish.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import type { PromptState, SessionState } from "../types";
import type { SandboxStopReason } from "./do-db.js";
import * as doDb from "./do-db.js";

// Structured inputs for the two rich-status wrappers. This bundles every
// projection signal that used to be threaded as a trailing optional positional
// argument — most importantly `reviewListeningActive`, which a forgotten
// positional arg would silently default to `false`, regressing a review-
// listening session's phase. Carrying it in a named field means a call site
// that omits it is a no-op default (consistent with PhaseInputs' optional
// fields) but can never be dropped by passing arguments in the wrong slot.
export type RichStatusInputs = {
  sandboxStatus: string | undefined;
  activePromptId: string | null;
  stopReason?: SandboxStopReason | null;
  activePromptHasPendingQuestion?: boolean;
  // Deliberate cross-PR seam: callers without authoritative plan state omit it
  // and preserve pre-gate behavior until the later projection-read PR lands.
  planApprovalPending?: boolean;
  // Live-idle user-stop flag (DO memory / STOPPED_KEPT_ALIVE_AT storage; not in
  // DO-SQLite). Callers with the authoritative flag must pass it so a user stop
  // supersedes waiting_for_input classifications (plan park, pending question);
  // callers without it omit it and treat the session as not user-stopped.
  userStopped?: boolean;
  publishStatus?: PublishStatus;
  postExecutionPending?: boolean;
  mostRecentPromptResultNoChanges?: boolean;
  reviewListeningActive?: boolean;
};

// `computePhase` is the canonical helper (`shared/session/phase.ts`). The legacy
// rich-status string is its mechanical projection, kept on disk in
// `session_index.rich_status` and on the wire as a `status` alias during the
// worker -> UI deploy gap. Both repo and non-repo sessions flow through the
// same compute path; non-repo sessions skip the publish-driven branches inside
// computePhase and settle on phase=idle once at rest.
export function computeRichStatus(session: SessionState | undefined, inputs: RichStatusInputs): string {
  if (!session || session.status === "archived") return "archived";
  return richStatusFromPhase(computePhase(buildPhaseInputs(session, inputs)));
}

// Symmetric with `computePhase`: undefined session and archived session both
// produce an `archived` PhaseInfo; everything else (repo or non-repo) delegates
// to computePhase, which now returns a phase for non-repo sessions too.
export function derivePhaseInfo(session: SessionState | undefined, inputs: RichStatusInputs): PhaseInfo {
  if (!session) {
    return { phase: "archived", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  return computePhase(buildPhaseInputs(session, inputs));
}

function buildPhaseInputs(session: SessionState, inputs: RichStatusInputs): PhaseInputs {
  return {
    sessionStatus: session.status,
    sessionKind: session.sessionKind ?? null,
    sandboxStatus: inputs.sandboxStatus,
    activePromptId: inputs.activePromptId,
    stopReason: inputs.stopReason ?? null,
    activePromptHasPendingQuestion: inputs.activePromptHasPendingQuestion,
    planApprovalPending: inputs.planApprovalPending ?? false,
    userStopped: inputs.userStopped ?? false,
    publishStatus: inputs.publishStatus,
    postExecutionPending: inputs.postExecutionPending,
    mostRecentPromptResultNoChanges: inputs.mostRecentPromptResultNoChanges,
    reviewListeningActive: inputs.reviewListeningActive,
  };
}

// Projection inputs needed by `derivePhaseInfo`/`computeRichStatus` that have
// to be read from D1: pending-question flag for the active prompt, and per-prompt
// post-execution + no-changes signals.
type RichStatusProjectionInputs = {
  activePromptHasPendingQuestion: boolean;
  planApprovalPending: boolean;
  planRevision: number;
  planStatus: SessionPlanStatus;
  postExecutionPending: boolean;
  mostRecentPromptResultNoChanges: boolean;
};

export function getRichStatusProjectionInputs(
  sql: SqlStorage,
  sessionId: string,
  activePromptId: string | null,
): RichStatusProjectionInputs {
  return getRichStatusProjectionInputsFromPrompts(sql, sessionId, doDb.getPrompts(sql, sessionId), activePromptId);
}

function getRichStatusProjectionInputsFromPrompts(
  sql: SqlStorage,
  sessionId: string,
  prompts: PromptState[],
  activePromptId: string | null,
): RichStatusProjectionInputs {
  const activePromptHasPendingQuestion = activePromptId ? doDb.getPromptHasPendingQuestion(sql, activePromptId) : false;
  const latestPlan = doDb.getLatestSessionPlan(sql, sessionId);
  let postExecutionPending = false;

  for (let i = prompts.length - 1; i >= 0; i--) {
    const prompt = prompts[i];
    if (
      !postExecutionPending &&
      doDb.getPlatformLlmPromptStatus(sql, prompt.promptId)?.status === "post_execution_pending"
    ) {
      postExecutionPending = true;
    }
    if (postExecutionPending && prompt.status === "completed") break;
  }

  return {
    activePromptHasPendingQuestion,
    planApprovalPending: latestPlan?.status === "pending",
    planRevision: latestPlan?.revision ?? 0,
    planStatus: latestPlan?.status ?? "none",
    postExecutionPending,
    mostRecentPromptResultNoChanges: isLatestCompletedPromptNoChanges(prompts),
  };
}

// Convenience: read all projection inputs from D1 + the live sandbox state and
// derive the current PhaseInfo. Used by the enqueue gate to check eligibility
// before forwarding a prompt to the DO's queue.
export function derivePhaseInfoFromSql(
  sql: SqlStorage,
  session: SessionState,
  sandboxState: doDb.SandboxStateRow | null,
  publishStatus: PublishStatus,
  activePromptId: string | null,
  // Required (never defaulted) so a caller can't silently drop it: a missing
  // `reviewListeningActive` regresses a review_listening session's phase to the
  // publish-driven fallback (e.g. `failed` on a red publish terminal), the
  // exact enqueue-gate bug this argument exists to prevent.
  reviewListeningActive: boolean,
  // Required for the same reason: the live-idle user-stop flag lives on the DO
  // (not in SQL), and dropping it would re-project a user-stopped plan-approval
  // session as waiting_for_input.
  userStopped: boolean,
): PhaseInfo {
  const inputs = getRichStatusProjectionInputs(sql, session.sessionId, activePromptId);
  return derivePhaseInfo(session, {
    sandboxStatus: sandboxState?.status ?? undefined,
    activePromptId,
    stopReason: sandboxState?.stopReason ?? null,
    activePromptHasPendingQuestion: inputs.activePromptHasPendingQuestion,
    planApprovalPending: inputs.planApprovalPending,
    userStopped,
    publishStatus,
    postExecutionPending: inputs.postExecutionPending,
    mostRecentPromptResultNoChanges: inputs.mostRecentPromptResultNoChanges,
    reviewListeningActive,
  });
}

export function derivePhaseInfoFromPromptSnapshot(
  sql: SqlStorage,
  session: SessionState,
  sandboxState: doDb.SandboxStateRow | null,
  publishStatus: PublishStatus,
  activePromptId: string | null,
  prompts: PromptState[],
  // Required for the same reasons as `derivePhaseInfoFromSql` — see those comments.
  reviewListeningActive: boolean,
  userStopped: boolean,
): PhaseInfo {
  const inputs = getRichStatusProjectionInputsFromPrompts(sql, session.sessionId, prompts, activePromptId);
  return derivePhaseInfo(session, {
    sandboxStatus: sandboxState?.status ?? undefined,
    activePromptId,
    stopReason: sandboxState?.stopReason ?? null,
    activePromptHasPendingQuestion: inputs.activePromptHasPendingQuestion,
    planApprovalPending: inputs.planApprovalPending,
    userStopped,
    publishStatus,
    postExecutionPending: inputs.postExecutionPending,
    mostRecentPromptResultNoChanges: inputs.mostRecentPromptResultNoChanges,
    reviewListeningActive,
  });
}
