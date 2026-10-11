import { getModelDefinition, MODEL_CONTEXT_WINDOWS, toModelSelection } from "../../../../shared/constants/models.js";
import {
  isArchiveAvailable,
  isPromptSendDisabled,
  isRespondAvailable,
  isResumeAvailable,
  isRetryAvailable,
  isStopAvailable,
  isWarmAvailable,
} from "../../../../shared/session/eligibility.js";
import {
  isNoChangesPromptResult,
  latestCompletedPromptResult,
  noChangeOutcomeCopy,
} from "../../../../shared/session/no-change-outcome.js";
import type { Phase, SandboxSubstate, StopMode } from "../../../../shared/session/phase.js";
import type {
  SessionViewActions,
  SessionViewModel,
  SessionViewModelInfo,
  SessionViewOutcome,
  SessionViewPrompt,
  SessionViewPromptPage,
  SessionViewResponse,
} from "../../../../shared/types/session-view.js";
import type { ClientPrompt } from "../../../../shared/types/session-websocket.js";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../constants/verification";
import { deriveEffectiveVerification } from "../session/effective-verification";
import type { SessionDOResponse, SessionViewPayload, SessionViewReadTiming } from "../types";
import { isCycloidMember } from "./internal-feature-gate";

const DEFAULT_PROMPT_PAGE_SIZE = 50;
type ActorProfile = {
  login: string | null;
  avatarUrl: string | null;
};
type PagedClientPrompts = {
  items: ClientPrompt[];
  nextCursor: string | null;
  total: number;
};

const ACTOR_PROFILE_LOOKUP_BATCH_SIZE = 100;

export interface SessionViewParentMetadata {
  parentSessionId?: string | null;
  parentPromptId?: string | null;
  spawnDepth?: number | null;
  childSessionIds?: string[];
  qaChildSessionId?: string | null;
}

export type SessionViewTimingRecorder = (segment: string, timing: SessionViewReadTiming) => void;

export async function assembleSessionView(
  session: SessionDOResponse,
  promptState: Pick<SessionViewPayload, "prompts" | "queue" | "outcomePrompts">,
  auth: { userId: string; canAccessAllSessions: boolean },
  options: {
    db?: D1Database | null;
    promptCursor?: string;
    promptLimit?: number;
    promptPage?: { nextCursor: string | null; total: number };
    requestId?: string | null;
    timingRecorder?: SessionViewTimingRecorder;
    // Accepts a promise so the route can start the (best-effort) parent/child
    // metadata reads and hand them off unresolved, letting them run concurrently
    // with this function's own D1 reads instead of blocking before the call.
    parentMetadata?: SessionViewParentMetadata | Promise<SessionViewParentMetadata | null> | null;
  },
): Promise<SessionViewResponse> {
  const { promptCursor } = options ?? {};
  // Clamp to >= 1: a 0 or negative promptLimit makes paginatePrompts slice an
  // empty page whose nextCursor equals the current cursor, so a client paging on
  // the cursor loops forever. `?? DEFAULT` does not catch 0 (it is not nullish).
  const promptLimit = Math.min(Math.max(1, Math.trunc(options?.promptLimit ?? DEFAULT_PROMPT_PAGE_SIZE)), 100);

  // Owner profile is resolved and cached by the DO; use it directly for non-owner viewers.
  const isOwner = session.ownerUserId === auth.userId;
  const ownerLogin = !isOwner ? session.ownerLogin : undefined;
  const ownerAvatarUrl = !isOwner ? session.ownerAvatarUrl : undefined;

  const allPrompts = promptState.prompts;
  const queueState = promptState.queue;

  const sessionModel = resolveModelInfo(session.model);
  const pagedPrompts = options?.promptPage
    ? {
        items: allPrompts,
        nextCursor: options.promptPage.nextCursor,
        total: options.promptPage.total,
      }
    : paginatePrompts(allPrompts, promptCursor, promptLimit);
  const actorProfileRequestedCount = new Set(
    pagedPrompts.items
      .map((prompt) => (typeof prompt.actorUserId === "string" ? prompt.actorUserId.trim() : ""))
      .filter((actorUserId) => actorUserId.length > 0),
  ).size;
  // Resolve the view's independent waits concurrently. Actor profile display
  // fields and UI lifecycle stage are already baked into the DO snapshot; the
  // zero-duration timings keep the existing view breakdown explicit.
  const [, , resolvedParentMetadata] = await Promise.all([
    recordImmediateTiming(options?.timingRecorder, "worker_actor_profiles", {
      durationMs: 0,
      outcome: "success",
      requestedCount: actorProfileRequestedCount,
      uncachedCount: 0,
    }),
    recordImmediateTiming(options?.timingRecorder, "worker_ui_lifecycle_stage", {
      durationMs: 0,
      outcome: "success",
    }),
    resolveParentMetadata(options?.parentMetadata ?? null, options?.timingRecorder),
  ]);
  const cpuStartedAt = Date.now();
  const prompts = toViewPromptPage(pagedPrompts);
  const actions = computeActions(session.phase, session.sandboxSubstate, session.stopMode, session.planApprovalPending);
  // Reconcile the nested verification snapshot against the authoritative columns.
  // Idempotent with the DO snapshot builder, which already applied this helper, but
  // keeps session-view self-contained for any caller. See effective-verification.ts.
  const {
    verification: effectiveVerification,
    prDraft,
    prManualReviewReason,
  } = deriveEffectiveVerification({
    stored: session.verification,
    verificationState: session.verificationState ?? null,
    verificationResult: session.verificationResult ?? null,
    prDraft: session.prDraft ?? null,
    prManualReviewReason: session.prManualReviewReason ?? null,
  });
  // Use the reconciled verification so the outcome reads column-authoritative
  // draft/manual-review state, not the raw stale snapshot.
  const outcomePrompts = options?.promptPage ? (promptState.outcomePrompts ?? allPrompts) : allPrompts;
  const outcome = deriveSessionViewOutcome({ ...session, verification: effectiveVerification }, outcomePrompts);
  const uiLifecycleStage = session.uiLifecycleStage ?? null;
  const qaRun = session.qaRun ?? null;

  const viewModel: SessionViewModel = {
    sessionId: session.sessionId,
    sessionKind: "repo",
    phase: session.phase,
    displayStatus: session.displayStatus,
    uiLifecycleStage,
    ...(session.sandboxSubstate !== undefined ? { sandboxSubstate: session.sandboxSubstate } : {}),
    ...(session.stopMode !== undefined ? { stopMode: session.stopMode } : {}),
    // Live-idle "kept alive after a user stop" flag; carried from the DO-served
    // response so the HTTP view keeps the Stopped badge/hint across the poll.
    ...(session.userStopped !== undefined ? { userStopped: session.userStopped } : {}),
    planApprovalPending: session.planApprovalPending,
    planRevision: session.planRevision,
    planStatus: session.planStatus,
    ...(session.finalizingStep !== undefined ? { finalizingStep: session.finalizingStep } : {}),
    ...(isOwner ? { planAutoReason: session.planAutoReason ?? null } : {}),
    closeReason: session.closedAt ? (session.closeReason ?? null) : undefined,
    title: session.title,
    createdAt: Date.parse(session.createdAt) || Date.now(),
    repoUrl: session.repoUrl ?? null,
    baseBranch: session.baseBranch ?? null,
    startBranch: session.startBranch ?? null,
    lastBranch: session.lastBranch ?? null,
    prUrl: session.prUrl ?? null,
    prDraft,
    prManualReviewReason,
    publishStatus: session.publishStatus ?? "not_started",
    publishError: session.publishError ?? null,
    publishedBranch: session.publishedBranch ?? null,
    outcome,
    model: sessionModel,
    desktopActionPathAvailable: isCycloidMember({ businessId: session.businessId }),
    // Session-level reasoning effort from the DO session record — the same
    // source the WS `subscribed` snapshot reads (per-prompt values ride the
    // prompt items, not this field).
    reasoningEffort: session.reasoningEffort ?? null,
    queueLength: queueState.queuedCount,
    spawnDurationMs: session.spawnDurationMs ?? null,
    // Live sandbox identity/transport state; resolved by the DO exactly like
    // the WS snapshot's `sandbox` block so fetch and WS never disagree.
    sandboxId: session.sandboxId ?? null,
    sandboxConnected: session.sandboxConnected ?? false,
    verification: effectiveVerification,
    runtimeProvenance: session.runtimeProvenance ?? null,
    observabilityReadiness: session.observabilityReadiness ?? null,
    ...(ownerLogin && { ownerLogin }),
    ...(ownerAvatarUrl && { ownerAvatarUrl }),
    ...(resolvedParentMetadata?.parentSessionId
      ? {
          parentSessionId: resolvedParentMetadata.parentSessionId,
          parentPromptId: resolvedParentMetadata.parentPromptId ?? undefined,
          spawnDepth: resolvedParentMetadata.spawnDepth ?? undefined,
        }
      : {}),
    ...(resolvedParentMetadata?.childSessionIds && resolvedParentMetadata.childSessionIds.length > 0
      ? { childSessionIds: resolvedParentMetadata.childSessionIds }
      : {}),
    ...(resolvedParentMetadata?.qaChildSessionId ? { qaChildSessionId: resolvedParentMetadata.qaChildSessionId } : {}),
    initiationMode: session.initiationMode ?? "user",
    scheduledRuleId: session.scheduledRuleId ?? null,
    ruleNameSnapshot: session.ruleNameSnapshot ?? null,
    cronSnapshot: session.cronSnapshot ?? null,
    reviewLoopDoneState: session.reviewLoopDoneState ?? null,
    cycloidDoneState: session.cycloidDoneState ?? "working",
    cycloidDoneOutcome: session.cycloidDoneOutcome ?? null,
    cycloidDoneReasons: session.cycloidDoneReasons ?? [],
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    verificationState: session.verificationState ?? null,
    verificationResult: session.verificationResult ?? null,
    verificationNeedsWorkLabel: session.verificationNeedsWorkLabel ?? null,
    verificationAttemptCount: session.verificationAttemptCount ?? 0,
    verificationMaxAttempts: session.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
    qaRun,
  };

  options?.timingRecorder?.("assembly_cpu", { durationMs: Date.now() - cpuStartedAt, outcome: "success" });
  return { session: viewModel, prompts, actions };
}

async function recordImmediateTiming(
  recorder: SessionViewTimingRecorder | undefined,
  segment: string,
  timing: SessionViewReadTiming,
): Promise<void> {
  recorder?.(segment, timing);
}

async function resolveParentMetadata(
  parentMetadata: SessionViewParentMetadata | Promise<SessionViewParentMetadata | null> | null,
  recorder: SessionViewTimingRecorder | undefined,
): Promise<SessionViewParentMetadata | null> {
  const startedAt = Date.now();
  try {
    const result = await Promise.resolve<SessionViewParentMetadata | null>(parentMetadata);
    recorder?.("worker_parent_metadata_wait", { durationMs: Date.now() - startedAt, outcome: "success" });
    return result;
  } catch (err) {
    recorder?.("worker_parent_metadata_wait", {
      durationMs: Date.now() - startedAt,
      outcome: "fallback",
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}

export function deriveSessionViewOutcome(
  session: Pick<
    SessionDOResponse,
    | "phase"
    | "publishStatus"
    | "publishError"
    | "verification"
    | "lastBranch"
    | "baseBranch"
    | "publishedBranch"
    | "prUrl"
  >,
  prompts: ClientPrompt[],
): SessionViewOutcome | null {
  if (session.phase === "finalizing" && (session.publishStatus ?? "not_started") === "not_started") {
    return {
      state: "final_verification_pending",
      tone: "info",
      title: "Local work complete. Final verification pending.",
      detail: null,
    };
  }

  // Terminal completed session with no PR: surface why no changes were published.
  // Read-side presentation only — never repairs persisted status. The latest
  // completed prompt result wins, so a later prompt that produced changes
  // overrides an earlier no-change prompt.
  if (session.phase === "completed" && !session.prUrl) {
    const latestResult = latestCompletedPromptResult(prompts);
    if (isNoChangesPromptResult(latestResult)) {
      const outcome = noChangeOutcomeCopy(latestResult.noChangeReason);
      // Benign clean no-op ("no changes - no PR created") is already conveyed by
      // the Completed badge; the box just adds clutter. Only surface the abnormal
      // finalization-failure variants, which carry real signal.
      return outcome.state === "no_changes" ? null : outcome;
    }
  }

  return null;
}

function resolveModelInfo(raw: unknown): SessionViewModelInfo | null {
  const selection = toModelSelection(raw);
  if (!selection) return null;

  const definition = getModelDefinition(raw);
  const label = definition?.name ?? selection.modelID;
  const contextWindow = MODEL_CONTEXT_WINDOWS[selection.modelID];

  return {
    providerID: selection.providerID,
    modelID: selection.modelID,
    label,
    ...(contextWindow != null ? { contextWindow } : {}),
  };
}
function paginatePrompts(
  allPrompts: ClientPrompt[],
  cursor: string | undefined | null,
  limit: number,
): PagedClientPrompts {
  const total = allPrompts.length;

  let startIndex = 0;
  if (cursor) {
    const cursorIndex = parseInt(cursor, 10);
    if (Number.isFinite(cursorIndex) && cursorIndex >= 0) {
      startIndex = cursorIndex;
    }
  }

  const pageItems = allPrompts.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < total;
  const nextCursor = hasMore ? String(startIndex + limit) : null;

  return { items: pageItems, nextCursor, total };
}

function toViewPromptPage(page: PagedClientPrompts): SessionViewPromptPage {
  return {
    ...page,
    items: page.items.map((prompt) => toViewPrompt(prompt)),
  };
}

export async function fetchActorProfilesByIds(
  db: D1Database,
  actorIds: Iterable<string | null | undefined>,
): Promise<Map<string, ActorProfile>> {
  const normalizedActorIds = [
    ...new Set(
      [...actorIds]
        .map((actorId) => (typeof actorId === "string" ? actorId.trim() : ""))
        .filter((actorId) => actorId.length > 0),
    ),
  ];
  const profiles = new Map<string, ActorProfile>();
  for (let offset = 0; offset < normalizedActorIds.length; offset += ACTOR_PROFILE_LOOKUP_BATCH_SIZE) {
    const batchActorIds = normalizedActorIds.slice(offset, offset + ACTOR_PROFILE_LOOKUP_BATCH_SIZE);
    const placeholders = batchActorIds.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT id, login, avatar_url FROM users WHERE id IN (${placeholders})`)
      .bind(...batchActorIds)
      .all<{ id: number | string; login: string | null; avatar_url: string | null }>();
    const rows = Array.isArray(result.results) ? result.results : [];
    for (const row of rows) {
      profiles.set(String(row.id), {
        login: row.login ?? null,
        avatarUrl: row.avatar_url ?? null,
      });
    }
  }
  return profiles;
}

function toViewPrompt(prompt: ClientPrompt): SessionViewPrompt {
  const actorUserIdRaw = typeof prompt.actorUserId === "string" ? prompt.actorUserId.trim() : "";
  const actorUserId = actorUserIdRaw.length > 0 ? actorUserIdRaw : null;
  const actorLogin = prompt.actorLogin ?? null;
  const actorAvatarUrl = prompt.actorAvatarUrl ?? null;

  return {
    promptId: prompt.promptId,
    prompt: prompt.prompt,
    ...(prompt.replyToText != null ? { replyToText: prompt.replyToText } : {}),
    ...(prompt.agent ? { agent: prompt.agent } : {}),
    ...(prompt.skills?.length ? { skills: prompt.skills } : {}),
    actorUserId,
    ...(actorLogin != null ? { actorLogin } : {}),
    ...(actorAvatarUrl != null ? { actorAvatarUrl } : {}),
    ...(prompt.model != null ? { model: prompt.model } : {}),
    ...(prompt.reasoningEffort != null ? { reasoningEffort: prompt.reasoningEffort } : {}),
    status: prompt.status,
    result: prompt.result,
    ...(prompt.error != null ? { error: prompt.error } : {}),
    ...(prompt.files?.length ? { files: prompt.files } : {}),
    ...(prompt.uploadedFiles?.length ? { uploadedFiles: prompt.uploadedFiles } : {}),
    ...(prompt.uploadedImages?.length ? { uploadedImages: prompt.uploadedImages } : {}),
    ...(prompt.createdAt ? { createdAt: prompt.createdAt } : {}),
    ...(prompt.continuesPlan ? { continuesPlan: true } : {}),
  };
}

// Server-computed action availability. Reads `phase` + `sandboxSubstate` +
// `stopMode`; valid for both repo and non-repo sessions after PR D.
function computeActions(
  phase: Phase,
  sandboxSubstate: SandboxSubstate | undefined,
  stopMode: StopMode | undefined,
  planApprovalPending: boolean,
): SessionViewActions {
  return {
    canSendPrompt: !isPromptSendDisabled(phase, stopMode, sandboxSubstate, planApprovalPending),
    canStop: isStopAvailable(phase, sandboxSubstate, planApprovalPending),
    canResume: isResumeAvailable(phase),
    canRespond: isRespondAvailable(phase, planApprovalPending),
    canWarm: isWarmAvailable(phase),
    canRetry: isRetryAvailable(phase),
    canArchive: isArchiveAvailable(phase),
  };
}
