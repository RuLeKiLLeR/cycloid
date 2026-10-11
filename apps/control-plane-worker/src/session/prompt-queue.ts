import * as Sentry from "@sentry/cloudflare";

import {
  DEFAULT_AGENT_NAME,
  getValidAgentNames,
  isCodeReviewerSession,
  isQaTesterAgentRole,
  ONBOARD_AGENT_NAME,
  PLAN_AGENT_NAME,
  QA_TESTER_AGENT_ROLE,
  QA_TESTER_RUNTIME_STARTUP_PROFILE,
  REVIEW_AGENT_ROLE,
  VERIFY_AGENT_NAME,
} from "../../../../shared/agent/constants.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import { REVIEW_AGENT_ROLE_BRIDGE_PROTOCOL_VERSION } from "../../../../shared/constants/bridge-protocol.js";
import {
  buildPlanContext,
  countPlanFilesToTouch,
  isPlanContextExcerptTruncated,
  summarizePlanModeResearchReuse,
  truncatePlanText,
  validatePlanMarkdown,
} from "../../../../shared/plan-mode.js";
import {
  isPromptSendDisabled,
  isRetryAvailable,
  PROMPT_SEND_BLOCKED_ERROR,
  RETRY_BLOCKED_ERROR,
  STOP_BLOCKED_ERROR,
} from "../../../../shared/session/eligibility.js";
import { verificationResultFromAgentVerdict } from "../../../../shared/session/phase.js";
import { flattenSessionEvents, resolveAuthoritativePromptEvents } from "../../../../shared/transcript/projector.js";
import { errorCodeLabel, isErrorCode } from "../../../../shared/types/error-codes.js";
import type { QaRunTerminalSummary } from "../../../../shared/types/qa-run.js";
import { normalizeQaRunTerminalSummary } from "../../../../shared/types/qa-run.js";
import type {
  ExecutionVerification,
  PlanContext,
  PrReadinessEvidence,
  ReviewLoopPromptSourceKind,
  UploadedFile,
  UploadedImage,
  VerificationArtifact,
  VerificationParentPrompt,
  VerifierTerminalResult,
} from "../../../../shared/types/sandbox.js";
import type { ClientPrompt } from "../../../../shared/types/session-websocket.js";
import {
  buildSafeCycloidBranchHint,
  prependTicketKeyToBranchHint,
} from "../../../../shared/utils/cycloid-branch-name.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { normalizePromptActorUserId } from "../../../../shared/utils/prompt-safety.js";
import {
  validatePromptUploadSqlPayload,
  validateUploadedFilePayload,
  validateUploadedImagePayload,
} from "../../../../shared/utils/uploads.js";
import { redactVerificationPhaseOutputForPersistence } from "../../../../shared/verification/phase-artifacts.js";
import { buildVerificationSummary } from "../../../../shared/verification-summary.js";
import {
  LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
  PENDING_ANSWER_STORAGE_KEY,
  type PendingAnswerRecord,
  PR_READINESS_STORAGE_KEY,
  PROMPT_STOPPED_BY_STORAGE_KEY,
  type PromptStoppedBy,
} from "../constants/sessions";
import { GITHUB_QA_FINISHED_REACTION, postIssueCommentReaction } from "../github/issues";
import { createInstallationToken } from "../github/octokit";
import { publishManagedVerificationComment, publishVerificationSkippedComment } from "../github/verification-comment";
import { fetchVerificationPrContext, parseGithubPullRequestUrl } from "../github/verification-pr-context";
import { type Logger, phaseLogFields } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { emitVerificationRunCompletedEvent } from "../observability/review-loop-events";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { classifySpawnTimeoutPhase, type SpawnTimeoutOrigin } from "../sandbox/classifySpawnTimeoutPhase.js";
import { RETRYABLE_SANDBOX_SPAWN_ERROR_CODES } from "../sandbox/e2b-client";
import { isKnownRuntimeProvider } from "../sandbox/runtime-backend";
import { isSandboxCallbackPreflightError } from "../services/control-plane-callback-preflight";
import { isOpencodeAccessDeniedError } from "../services/opencode-access-gate";
import { resolvePublicSessionUrl } from "../services/public-url";
import { applyQaPassLabel } from "../services/qa-pass-label";
import type { UserSettingsCache } from "../settings/db";
import { extractResponseFromEvents, parseSlackQuotedReplySource, type SlackQuotedReplySource } from "../slack/blocks";
import type { DispatchContract, Env, PromptState, QueueState, ReplayState, SessionEvent, SessionState } from "../types";
import { asNonEmptyString, jsonErrorResponse, jsonResponse, nowIso, parseJsonBody, truncateDepth } from "../utils";
import { extractLinearContextFromPrompt } from "../webhooks/linear";
import type { ErrorCode, ErrorDetails, SandboxCommand, SandboxEvent, ServerMessage } from "../ws/types.js";
import { getChildSessionRow } from "./child-session-db.js";
import { toClientErrorDetails } from "./client-error-details.js";
import { buildSerializedCorrelation } from "./correlation.js";
import * as doDb from "./do-db.js";
import type { DurableEntry } from "./events";
import {
  shadowEmitVerificationTerminalOutcome,
  shadowEmitVerifierTerminalVerdict,
} from "./fsm/verification-producer.js";
import { GithubReleaseEvidenceService } from "./github-release-evidence";
import {
  type ApproveSessionPlanRequest,
  type CompleteSessionPromptRequest,
  type EnqueueSessionPromptRequest,
  type RespondToSessionRequest,
  REVIEW_LOOP_EPOCH_ACTIVE_PROMPT_ERROR,
} from "./internal-routes";
import type { SandboxHeartbeatFreshness } from "./lifecycle/heartbeat-freshness.js";
import { decideTerminalEvent } from "./lifecycle/terminal-decision.js";
import { normalizePrReadinessEvidence } from "./pr-readiness.js";
import { promptResultBranch, promptResultCommitSha, promptResultDiffSummary } from "./prompt-result.js";
import { derivePromptTitleCandidate, extractLeadingTicketKey } from "./prompt-text.js";
import { derivePhaseInfoFromPromptSnapshot, derivePhaseInfoFromSql } from "./rich-status.js";
import { clearPromptActivityForPrompt } from "./sandbox-state-owners/prompt-activity.js";
import { decidePromptDisconnectRetry, DISCONNECT_RETRY_CAP } from "./sandbox-state-owners/prompt-disconnect-retry.js";
import {
  commitSpawnTimeoutRetryDecision,
  peekSpawnTimeoutRetryDecision,
  resetSpawnRetryOnSuccess,
} from "./sandbox-state-owners/spawn-retry.js";
import { insertSlackPostIfAbsent } from "./slack-posts-db";
import { type SpawnInstrumentation, spawnInstrumentationKey } from "./spawn-workflow.js";
import { getSessionState } from "./state.js";
import { type PromptFinalizeContext, schedulePromptTerminalSideEffects } from "./terminal-side-effects.js";
import { normalizeTicketKey } from "./ticket-key.js";
import { checkVerificationRunLimit } from "./verification-gate.js";
import { syncVerificationResultForPr, syncVerificationStateForPr } from "./verification-state.js";

type PromptCompletionSource = "session_idle" | "execution_complete" | "post_execution_preclose";
type PlatformLlmPostExecutionWindowResult = "held" | "terminalize" | "already_terminal";

// ARC-1330 §17-A (PR 47) — the PER-PROMPT run-identity token store on a VERIFIER child session's DO.
// The auto-scheduler threads the committed `verification_run_id` on the prompt enqueue; it is keyed by
// promptId (NOT session — #6310 reuses one verifier session across a PR lifecycle's runs, so the token
// must ride per run/prompt) and read back at the post_execution verdict-back to populate
// `VerifierTerminalResult.verificationRunId` (the echo run-scoped verdict freshness matches against).
// Never deleted on read: a redelivered post_execution must re-resolve the same token idempotently.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
const VERIFICATION_RUN_ID_STORAGE_PREFIX = "verification_run_id:";
function verificationRunIdStorageKey(promptId: string): string {
  return `${VERIFICATION_RUN_ID_STORAGE_PREFIX}${promptId}`;
}
const QA_PASS_LABEL_APPLIED_STORAGE_PREFIX = "qa_label_applied:";
function qaPassLabelAppliedStorageKey(promptId: string): string {
  return `${QA_PASS_LABEL_APPLIED_STORAGE_PREFIX}${promptId}`;
}
const VERIFICATION_COORDINATOR_SESSION_ID_STORAGE_PREFIX = "verification_coordinator_session_id:";
function verificationCoordinatorSessionIdStorageKey(promptId: string): string {
  return `${VERIFICATION_COORDINATOR_SESSION_ID_STORAGE_PREFIX}${promptId}`;
}
const PR_TEMPLATE_FILL_STORAGE_KEY = "pr_template_fill";
const VERIFICATION_PARENT_PROMPT_TEXT_MAX_CHARS = 4000;
export const PREPARED_SESSION_TITLE_ENQUEUE_TIMEOUT_MS = 5000;

type StoppedVerificationCause = "manual_stop" | "archived" | "unexpected_terminal";
const STOPPED_VERIFICATION_REASON_MAX_CHARS = 240;
const SESSION_ARCHIVED_WHILE_PROCESSING_PREFIX = "Session archived while processing:";
const STOPPED_BY_USER_REASON = "Stopped by user";
const SAFE_UNEXPECTED_TERMINAL_REASON_PATTERNS = [
  /^Sandbox disconnected while processing$/i,
  /^Sandbox kept disconnecting after \d+ attempts$/i,
  /^Sandbox went away before the prompt started running$/i,
  /^Sandbox never started the prompt after \d+ attempts$/i,
  /^Sandbox failed to connect after \d+ attempts$/i,
] as const;
// Terminal error codes that do NOT by themselves prove the prompt reached model
// execution. Lifecycle watchdog terminals (spawn/connect/dispatch failures and
// disconnects) are finalized through completeActivePrompt with the same
// "execution_complete" source as a genuine bridge terminal, so the source alone
// cannot tell them apart. For these codes we must not force trace_expected:true at
// the source; finalizePromptRun re-derives trace_expected from real execution
// evidence (status / tokens / tool calls / bt_span_id) instead. That keeps a spawn
// failure with no span out of the completeness monitor while a prompt that genuinely
// ran before disconnecting (tokens/tool calls present) still counts.
//
// Keep in sync with the spawn_*/sandbox_*/codex_* terminals emitted by the lifecycle
// reducer (lifecycle/reducer.ts) and classifySpawnTimeoutPhase. A new pre-/non-
// execution terminal code that is NOT listed here will re-introduce the false
// completeness pages this set exists to suppress.
export const NON_EXECUTION_TRACE_ERROR_CODES = new Set<ErrorCode>([
  // Sandbox spawn / provider failures — the sandbox never came up, no turn ran.
  "spawn_timeout",
  "spawn_modal_error",
  "spawn_provider_error",
  "spawn_deadline_no_object",
  "spawn_deadline_no_bridge",
  "spawn_preconnect",
  // Sandbox dropped or never attached — defer to execution evidence; a disconnect
  // mid-turn keeps trace_expected:true via the finalizePromptRun re-derivation.
  "sandbox_disconnected",
  "sandbox_disconnected_exhausted",
  "sandbox_never_started",
  // Codex startup / dispatch watchdogs — failed before a model turn began.
  "codex_startup_timeout",
  "codex_api_readiness_timeout",
  "codex_session_create_timeout",
  "codex_not_ready",
  "codex_prompt_dispatch_timeout",
  "codex_transport_closed",
  "codex_unrecoverable",
]);

type StoppedVerificationContext = {
  promptError: string | null;
  errorCode: ErrorCode | null;
};

interface SandboxResumeState {
  stopped: boolean;
  paused: boolean;
  expired: boolean;
  resumable: boolean;
}

type PromptEnqueueValidation = { ok: true; isResumableSend: boolean } | { ok: false; reason: "stopped" };

function isPromptTerminal(prompt: Pick<PromptState, "status"> | null | undefined): boolean {
  return prompt?.status === "completed" || prompt?.status === "failed";
}

async function waitForPreparedSessionTitleForEnqueue(
  promise: Promise<{ title: string; ticketKey: string | null } | null>,
): Promise<{ title: string; ticketKey: string | null } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, PREPARED_SESSION_TITLE_ENQUEUE_TIMEOUT_MS, null);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldMarkPromptTraceExpected(
  completion: Pick<PromptCompletion, "success" | "errorCode">,
  completionSource: PromptCompletionSource,
): boolean {
  if (completion.success) return true;
  return (
    completionSource === "execution_complete" &&
    (!completion.errorCode || !NON_EXECUTION_TRACE_ERROR_CODES.has(completion.errorCode))
  );
}

async function capturePromptFinalizeContextForPrompt(
  host: Pick<SessionPromptQueueHost, "capturePromptFinalizeContext" | "state">,
  sessionId: string,
  promptId: string,
): Promise<PromptFinalizeContext> {
  const context = host.capturePromptFinalizeContext(sessionId);
  // Snapshot before terminal side effects run; a promoted follow-up prompt can
  // replace the lifecycle prompt record before finalizePromptRun executes.
  const promptPhaseRecord = await host.state.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY);
  if (!promptPhaseRecord || typeof promptPhaseRecord !== "object" || Array.isArray(promptPhaseRecord)) {
    return context;
  }

  const record = promptPhaseRecord as { promptId?: unknown; codexPromptSentAt?: unknown };
  if (record.promptId !== promptId) {
    return context;
  }

  return {
    ...context,
    promptDispatchedToAgent: record.codexPromptSentAt != null,
  };
}

function getSandboxResumeState(sandboxState: doDb.SandboxStateRow | null): SandboxResumeState {
  const paused =
    sandboxState != null &&
    isKnownRuntimeProvider(sandboxState.runtimeProvider) &&
    sandboxState.runtimeState === "paused" &&
    typeof sandboxState.runtimeSandboxId === "string";
  const expired =
    paused &&
    typeof sandboxState.runtimeStateExpiresAt === "number" &&
    sandboxState.runtimeStateExpiresAt <= Date.now();
  const stopped = sandboxState?.status === "stopped";

  return {
    stopped,
    paused,
    expired,
    // Stopped E2B runtimes are resumable until their retention expires. Expired
    // E2B runtimes and old non-user stopped rows fall through to a fresh spawn.
    resumable: stopped && (paused || sandboxState?.stopReason !== "user"),
  };
}

/**
 * Origin of a sandbox-disconnect recovery, threaded into the direct-post
 * telemetry so the next E2B-instability window is queryable (liveness-expiry vs
 * reconnect-grace-expiry were previously indistinguishable). `sandbox_never_started`
 * is the activity-signal guard: a prompt the sandbox never began running.
 */
export type PromptDisconnectOrigin = "liveness_expiry" | "reconnect_grace_expiry" | "sandbox_never_started" | "unknown";

/**
 * Decide whether a no-fresh-transport admit/promotion should start a fresh
 * sandbox spawn or wait for an in-flight reconnect/spawn.
 *
 * A `reconnecting` row is only worth waiting on when a genuine reconnect is in
 * flight: a live fresh socket, OR an unexpired reconnect-grace deadline.
 * Otherwise the VM is dead (runtime killed, or grace lapsed before the lifecycle
 * advanced the status to `stopped`) and waiting wedges the prompt to the
 * max-duration ceiling (the sandbox-death review-listening wedge). Spawn fresh
 * instead, routing into the proven cold-resume recovery rather than
 * `wait_for_inflight_spawn`.
 *
 * `spawning` always waits (a spawn is already in flight). Every other status
 * spawns, preserving the prior
 * `status !== "spawning" && status !== "reconnecting"` semantics.
 */
export function shouldStartSpawnForAdmit(opts: {
  sandboxStatus: string | null | undefined;
  hasLiveSocket: boolean;
  reconnectGraceDeadlineMs: number | null;
  nowMs: number;
}): boolean {
  const { sandboxStatus, hasLiveSocket, reconnectGraceDeadlineMs, nowMs } = opts;
  if (sandboxStatus === "spawning") return false;
  if (sandboxStatus === "reconnecting") {
    const reconnectInFlight = hasLiveSocket || (reconnectGraceDeadlineMs != null && reconnectGraceDeadlineMs > nowMs);
    return !reconnectInFlight;
  }
  return true;
}

export function validatePromptEnqueueResumeState(
  effectiveActivePromptId: string | null,
  resume: SandboxResumeState,
  isReviewLoopEnqueue: boolean,
): PromptEnqueueValidation {
  if (effectiveActivePromptId) {
    return { ok: true, isResumableSend: false };
  }
  if (resume.stopped && !resume.resumable) {
    // A review_listening session is expected to be cold; a review-loop-originated enqueue must always
    // be able to cold-resume it. Genuinely-terminal phases (archived/failed/blocked/finalizing) are
    // already rejected by the isPromptSendDisabled phase gate before this point, so the only state
    // reachable here is a stopped sandbox that can always be cold-spawned fresh.
    if (isReviewLoopEnqueue) {
      return { ok: true, isResumableSend: true };
    }
    return { ok: false, reason: "stopped" };
  }
  return { ok: true, isResumableSend: resume.resumable };
}

export interface PromptCompletion {
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
  errorDetails?: ErrorDetails;
}

export interface PromptExecutionTelemetry {
  btSpanId?: string;
  errorCode?: ErrorCode;
  errorDetails?: ErrorDetails;
  traceExpected?: boolean;
  recoverStalePrompt?: boolean;
}

export type PromptActorProfile = {
  login: string | null;
  avatarUrl: string | null;
};

type PromptQueueEnv = Pick<Env, "DD_API_KEY" | "WORKER_ENV"> &
  Partial<
    Pick<Env, "DB" | "FRONTEND_URL" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "REPOS_CACHE" | "SLACK_BOT_TOKEN">
  >;

interface SessionPromptQueueHost {
  readonly state: DurableObjectState;
  readonly env: PromptQueueEnv;
  readonly log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  fetchInternal(request: Request): Promise<Response>;
  enqueueTerminalSideEffects(task: () => Promise<void>): void;
  capturePromptFinalizeContext(sessionId: string): PromptFinalizeContext;
  getSandboxSocket(): WebSocket | null;
  /** Freshness of the lifecycle `lastHeartbeatAt` against the platform liveness bound (ARC-1196). */
  getSandboxHeartbeatFreshness(): Promise<SandboxHeartbeatFreshness>;
  /**
   * The current `sandboxReconnectGrace` lifecycle deadline (ms epoch) or null.
   * Lets the admit path tell a genuine in-flight reconnect (unexpired grace)
   * apart from a dead `reconnecting` runtime whose grace already lapsed.
   */
  getSandboxReconnectGraceDeadlineMs(): Promise<number | null>;
  /**
   * Tear down a zombie transport before dispatch: marks the connection
   * generation handled (so the async WS close delivery cannot grace/fail the
   * prompt admitted right after), finalizes the transport stop through the
   * lifecycle reducer, then closes the socket.
   */
  discardStaleSandboxTransport(sessionId: string, reason: string): Promise<void>;
  sendToSandbox(command: SandboxCommand): void | Promise<void>;
  uploadPlanMarkdownArtifact?(sessionId: string, promptId: string, markdown: string): Promise<string | null>;
  notePromptTransition(sessionId: string, promptId: string | null): Promise<void>;
  putSandboxStatus(
    sessionId: string,
    status: string,
    options?: { stopReason?: doDb.SandboxStopReason | null },
  ): Promise<void>;
  getReplayState(sessionId: string): Promise<ReplayState>;
  setHasPendingQuestion(value: boolean): Promise<void>;
  setPendingPromptDispatch(value: boolean): Promise<void>;
  isCurrentSpawnAttempt(spawnAttemptId: string | undefined | null): Promise<boolean>;
  clearSpawnAttemptState(clearAttemptId?: boolean): Promise<void>;
  stopIdleSessionAtDurabilityBoundary(session: SessionState, reason: string): Promise<void>;
  /**
   * Live-idle user stop (resume-stopped-session): keep the sandbox live instead of pausing.
   * Fires review-listening-exit + stamps STOPPED_KEPT_ALIVE_AT_STORAGE_KEY + sets the userStopped
   * broadcast flag. No pauseSandbox / finalizeSandboxStopped / closeSandboxSockets.
   */
  stopSessionKeepAlive(session: SessionState): Promise<void>;
  /** In-memory live-idle user-stop flag; PR-4 reads this at enqueue to attribute post-stop dispatch. */
  isUserStopped(): boolean;
  startSpawnAttempt(sessionId: string, operation: string): Promise<string>;
  checkSessionResumeRateLimit(sessionId: string, userId: string): Promise<{ limited: boolean }>;
  schedulePromptExecutionAlarm(): Promise<void>;
  rescheduleSessionAlarm(): Promise<void>;
  onPlanApprovalParked(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    valid: boolean;
    missingReason: string | null;
  }): Promise<void>;
  onPlanApprovalDiscussion(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    promptId: string;
  }): Promise<void>;
  onPlanApprovalApproved(sessionId: string): Promise<void>;
  onPlanApprovalStopped(sessionId: string): Promise<void>;
  cancelPlanParkPause(): Promise<void>;
  finalizePromptRun(
    sessionId: string,
    prompt: PromptState,
    session: SessionState,
    telemetry?: PromptExecutionTelemetry,
    context?: PromptFinalizeContext,
  ): Promise<void>;
  runMemoryReviewBot(sessionId: string, prompt: PromptState, session: SessionState): Promise<void>;
  writeUsageToD1(sessionId: string, ownerUserId: string, promptId: string): Promise<void>;
  writeCompletionToD1(
    sessionId: string,
    ownerUserId: string,
    promptId: string,
    event?: { diffSummary?: string; branch?: string; commitSha?: string; success?: boolean },
  ): Promise<void>;
  appendAndMirrorEvents(
    sessionId: string,
    entries: DurableEntry[],
    promptId?: string,
  ): Promise<{ events: SessionEvent[]; replay: ReplayState }>;
  notifySlackThread(sessionId: string, promptId: string, success: boolean): Promise<void>;
  withPublishUserSettingsCache?<T>(operation: (settingsCache: UserSettingsCache) => Promise<T>): Promise<T>;
  triggerPrCreation(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: Extract<SandboxEvent, { type: "post_execution" }>["verification"],
    prReadiness?: Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: Extract<SandboxEvent, { type: "post_execution" }>["prTemplateFill"],
  ): Promise<void>;
  triggerPrUpdate(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: Extract<SandboxEvent, { type: "post_execution" }>["verification"],
    prReadiness?: Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: Extract<SandboxEvent, { type: "post_execution" }>["prTemplateFill"],
  ): Promise<void>;
  // ARC-876: explicit terminal failure path when the bundled push outcome on
  // post_execution shows the branch was not pushed. Replaces the old silent
  // skip that left the session stuck in `finalizing`.
  failPublishOnPushOutcome(opts: {
    sessionId: string;
    cause: "push_failed" | "push_status_unknown";
    pushError?: string | null;
    promptId?: string;
  }): Promise<void>;
  listSessionPrompts(sessionId: string): Promise<ClientPrompt[]>;
  prepareSessionTitle(
    promptText: string,
    context: {
      sessionId: string;
      promptId: string;
      businessId?: string | null;
      ownerUserId?: string | null;
      repoOwner?: string | null;
      repoName?: string | null;
    },
  ): Promise<{ title: string; ticketKey: string | null } | null>;
  generateSessionTitle(sessionId: string, promptText: string, promptId: string): Promise<void>;
  generatePromptCallbackAuth(sessionId: string, promptId: string): Promise<string>;
  markReviewLoopEpochProcessing?(sessionId: string, promptId: string, epochId: string): Promise<void>;
  markReviewLoopEpochOwnerApprovalResolved?(sessionId: string, promptId: string, epochId: string): Promise<void>;
  /**
   * Completes the in-flight epoch owned by a review-loop prompt that reached a terminal state
   * WITHOUT publishing (reply-only / no-op / question-only turn). No-op when the epoch is not in an
   * enqueued/processing state owned by this prompt (e.g. it already published → completed, or is
   * publishing / waiting_for_owner).
   */
  resolveReviewLoopEpochForTerminalPrompt?(sessionId: string, promptId: string, epochId: string): Promise<void>;
  /**
   * Blocks the in-flight epoch owned by a prompt whose Codex runtime failed unrecoverably. The host
   * performs the prompt-bound epoch CAS and emits the matching lifecycle-spine terminal.
   */
  blockReviewLoopEpochForUnrecoverablePrompt?(sessionId: string, promptId: string, epochId: string): Promise<void>;
  /**
   * Re-points a review-loop epoch's last_prompt_id from a spawn-retried prompt's previous id to its
   * new id, so the retried prompt's publish/reply is not rejected as "attached to a different prompt".
   */
  repointReviewLoopEpochPrompt?(
    sessionId: string,
    epochId: string,
    previousPromptId: string,
    nextPromptId: string,
  ): Promise<void>;
  resolvePromptActorProfile(actorUserId: string | null): Promise<PromptActorProfile | null>;
  armPlatformLlmPostExecutionWindow?(
    sessionId: string,
    promptId: string,
  ): Promise<PlatformLlmPostExecutionWindowResult>;
  markPlatformLlmPromptTerminal?(sessionId: string, promptId: string): void;
  broadcast(message: ServerMessage): void;
}

export interface SessionPromptQueue {
  handlePromptEnqueueRequest(request: Request): Promise<Response>;
  handlePromptCallbackRequest(request: Request): Promise<Response>;
  handleStopRequest(): Promise<Response>;
  handleRespondRequest(request: Request): Promise<Response>;
  handlePlanApproveRequest(request: Request): Promise<Response>;
  handleRetryRequest(): Promise<Response>;
  handleSessionIdle(event: Extract<SandboxEvent, { type: "session_idle" }>, sessionId: string): Promise<void>;
  completeActivePrompt(
    sessionId: string,
    completion: PromptCompletion,
    expectedPromptId?: string,
    completionSource?: PromptCompletionSource,
  ): Promise<void>;
  failQueuedPrompts(sessionId: string, reason: string, timestamp: string): number;
  handleExecutionComplete(
    event: Extract<SandboxEvent, { type: "execution_complete" }>,
    sessionId: string,
    telemetry?: PromptExecutionTelemetry,
  ): Promise<void>;
  handlePostExecution(event: Extract<SandboxEvent, { type: "post_execution" }>, sessionId: string): Promise<void>;
  handleSpawnTimeout(
    sessionId: string,
    session: SessionState,
    prompts: PromptState[],
    activePrompt: PromptState,
    errorMessage: string,
    origin: SpawnTimeoutOrigin,
    spawnTimeoutMs?: number,
  ): Promise<void>;
  handleSpawnFailure(sessionId: string, operation: string, err: unknown, spawnAttemptId?: string): Promise<void>;
  failActivePromptOnDisconnect(
    session: SessionState,
    activePromptId: string,
    origin?: PromptDisconnectOrigin,
  ): Promise<void>;
  failActivePromptForArchive(session: SessionState, activePromptId: string, reason: string): Promise<void>;
  sendPendingPromptToSandbox(sessionId: string): Promise<boolean>;
  sendPendingAnswerToSandbox(sessionId: string): Promise<void>;
}

export { SLACK_NOTIFICATION_RECOVERY_DELAY_MS } from "./slack-notification-recovery.js";

export function hasCompletionProgressContext(sessionEditCount?: number, sessionPromptCount?: number): boolean {
  return typeof sessionEditCount === "number" && typeof sessionPromptCount === "number";
}

function logDurablePromptCloseComplete(
  host: Pick<SessionPromptQueueHost, "log">,
  args: {
    sessionId: string;
    promptId: string;
    source: string;
    success: boolean;
    nextPromptId: string | null;
  },
): void {
  host.log.info(
    phaseLogFields("prompt.complete", {
      step: "durable_close",
      phase_status: "completed",
      sessionId: args.sessionId,
      promptId: args.promptId,
      source: args.source,
      success: args.success,
      nextPromptId: args.nextPromptId,
    }),
    "Prompt durable close completed",
  );
}

async function publishVerifierArtifactsToGithubReleases(input: {
  host: SessionPromptQueueHost;
  sql: SqlStorage;
  sessionId: string;
  targetPrUrl: string;
  ext: ReturnType<typeof doDb.getSessionExtended>;
  artifacts: VerificationArtifact[];
}): Promise<{ artifacts: VerificationArtifact[]; skipped: boolean }> {
  if (input.artifacts.length === 0) return { artifacts: [], skipped: false };
  if (!input.artifacts.some((artifact) => artifact.type === "screenshot" || artifact.type === "video")) {
    return { artifacts: [], skipped: false };
  }
  const fallbackVisualArtifacts = linkOnlyVisualArtifacts(input.artifacts);
  const parsedPr = parseGithubPullRequestUrl(input.targetPrUrl);
  const installationId = input.ext?.installationId;
  if (!parsedPr || !installationId) {
    input.host.log.warn(
      {
        event: "verification_comment.release_artifacts.skipped",
        sessionId: input.sessionId,
        targetPrUrl: input.targetPrUrl,
        hasInstallationId: Boolean(installationId),
      },
      "Skipped GitHub release artifact publication for verification comment",
    );
    return { artifacts: fallbackVisualArtifacts, skipped: true };
  }

  try {
    const token = await createInstallationToken(input.host.env as Env, installationId);
    const service = new GithubReleaseEvidenceService(input.sql, input.host as SessionPromptQueueHost & { env: Env });
    const artifacts = await service.publishArtifactsForVerificationComment({
      sessionId: input.sessionId,
      prNumber: parsedPr.number,
      auth: {
        sessionId: input.sessionId,
        token,
        tokenSource: "installation",
        installationId,
        installationToken: token,
        repoOwner: parsedPr.owner,
        repoName: parsedPr.repo,
        ext: input.ext,
      },
    });
    return {
      artifacts: countVerificationVisualArtifacts(artifacts) > 0 ? artifacts : fallbackVisualArtifacts,
      skipped: false,
    };
  } catch (error) {
    const failureEvent = {
      event: "verification_comment.release_artifacts.failed",
      sessionId: input.sessionId,
      targetPrUrl: input.targetPrUrl,
      originalVisualArtifactCount: fallbackVisualArtifacts.length,
      errorKind: "release_artifact_publication_error",
      errorName: error instanceof Error ? error.name : typeof error,
    };
    input.host.log.warn(failureEvent, "Failed to publish verifier artifacts to GitHub releases");
    input.host.waitUntil(
      postStructuredEventToDd(input.host.env, failureEvent).catch((postError) => {
        input.host.log.warn(
          {
            event: "verification_comment.release_artifacts.observability_post_failed",
            sessionId: input.sessionId,
            errorMessage: String(postError),
          },
          "Failed to post release artifact failure event to Datadog",
        );
      }),
    );
    Sentry.captureMessage("Verifier GitHub release artifact publication failed", {
      level: "warning",
      tags: { sessionId: input.sessionId, operation: "publishVerifierArtifactsToGithubReleases" },
      extra: { targetPrUrl: input.targetPrUrl, errorKind: failureEvent.errorKind, errorName: failureEvent.errorName },
    });
    return { artifacts: fallbackVisualArtifacts, skipped: false };
  }
}

function linkOnlyVisualArtifacts(artifacts: VerificationArtifact[]): VerificationArtifact[] {
  return artifacts
    .filter((artifact) => artifact.type === "screenshot" || artifact.type === "video")
    .map((artifact) => ({ ...artifact, renderMode: "link" }));
}

function mergeVerificationCommentArtifacts(
  originalArtifacts: VerificationArtifact[],
  publishedVisualArtifacts: VerificationArtifact[],
): VerificationArtifact[] {
  return [
    ...publishedVisualArtifacts,
    ...originalArtifacts.filter((artifact) => artifact.type === "log" && artifact.inlineText?.content),
  ];
}

function countVerificationVisualArtifacts(artifacts: VerificationArtifact[]): number {
  return artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video").length;
}

async function prepareVerificationCommentArtifacts(input: {
  host: SessionPromptQueueHost;
  sql: SqlStorage;
  sessionId: string;
  promptId: string;
  targetPrUrl: string;
  ext: ReturnType<typeof doDb.getSessionExtended>;
  artifacts: VerificationArtifact[];
}): Promise<VerificationArtifact[]> {
  const releaseArtifactPublication = await publishVerifierArtifactsToGithubReleases({
    host: input.host,
    sql: input.sql,
    sessionId: input.sessionId,
    targetPrUrl: input.targetPrUrl,
    ext: input.ext,
    artifacts: input.artifacts,
  });
  const releaseArtifacts = releaseArtifactPublication.artifacts;
  const originalVisualArtifactCount = countVerificationVisualArtifacts(input.artifacts);
  const publishedVisualArtifactCount = countVerificationVisualArtifacts(releaseArtifacts);
  if (!releaseArtifactPublication.skipped && publishedVisualArtifactCount < originalVisualArtifactCount) {
    const mismatchEvent = {
      event: "verification_comment.release_artifacts.visual_count_mismatch",
      sessionId: input.sessionId,
      promptId: input.promptId,
      targetPrUrl: input.targetPrUrl,
      originalVisualArtifactCount,
      publishedVisualArtifactCount,
      droppedVisualArtifactCount: originalVisualArtifactCount - publishedVisualArtifactCount,
      hasInstallationId: Boolean(input.ext?.installationId),
      repoOwner: input.ext?.repoOwner ?? null,
      repoName: input.ext?.repoName ?? null,
    };
    input.host.log.warn(
      mismatchEvent,
      "Verification comment will publish fewer visual artifacts than the verifier produced after GitHub release publication",
    );
    input.host.waitUntil(
      postStructuredEventToDd(input.host.env, mismatchEvent).catch((error) => {
        input.host.log.warn(
          {
            event: "verification_comment.release_artifacts.visual_count_mismatch.observability_post_failed",
            sessionId: input.sessionId,
            errorMessage: String(error),
          },
          "Failed to post verification comment visual artifact mismatch event to Datadog",
        );
      }),
    );
    Sentry.captureMessage(
      "Verification comment visual artifacts fell back to link-only after GitHub release publication",
      {
        level: "warning",
        tags: {
          sessionId: input.sessionId,
          promptId: input.promptId,
          operation: "publishVerifierArtifactsToGithubReleases",
        },
        extra: {
          targetPrUrl: input.targetPrUrl,
          originalVisualArtifactCount,
          publishedVisualArtifactCount,
          hasInstallationId: Boolean(input.ext?.installationId),
          repoOwner: input.ext?.repoOwner ?? null,
          repoName: input.ext?.repoName ?? null,
        },
      },
    );
  }
  return mergeVerificationCommentArtifacts(input.artifacts, releaseArtifacts);
}

type VerificationCommentPublishResult = Awaited<ReturnType<typeof publishManagedVerificationComment>>;

function logVerificationCommentPublishResult(
  host: SessionPromptQueueHost,
  params: { sessionId: string; promptId: string; targetPrUrl: string; kind: "result" | "skipped" | "stopped" },
  result: VerificationCommentPublishResult,
): void {
  if (!result.ok) {
    host.log.warn(
      {
        event: "verification_comment.publish_failed",
        sessionId: params.sessionId,
        promptId: params.promptId,
        targetPrUrl: params.targetPrUrl,
        kind: params.kind,
        reason: result.reason,
      },
      "Managed GitHub verification comment publication failed",
    );
    return;
  }
  host.log.info(
    {
      event: "verification_comment.published",
      sessionId: params.sessionId,
      promptId: params.promptId,
      targetPrUrl: params.targetPrUrl,
      kind: params.kind,
      commentId: result.commentId,
      action: result.action,
      malformed: result.malformed,
    },
    "Published managed GitHub verification comment",
  );
}

async function publishVerificationResultCommentSafely(
  host: SessionPromptQueueHost,
  params: {
    sql: SqlStorage;
    sessionId: string;
    promptId: string;
    targetPrUrl: string;
    ext: ReturnType<typeof doDb.getSessionExtended>;
    installationId: number | null;
    repoOwner: string | null;
    repoName: string | null;
    rawVerifierOutput: string;
    fallbackHeadSha: string;
    verifierResult: VerifierTerminalResult | undefined;
    artifacts: NonNullable<ExecutionVerification["artifacts"]>;
    kind: "result" | "stopped";
  },
): Promise<void> {
  try {
    const artifacts = await prepareVerificationCommentArtifacts({
      host,
      sql: params.sql,
      sessionId: params.sessionId,
      promptId: params.promptId,
      targetPrUrl: params.targetPrUrl,
      ext: params.ext,
      artifacts: params.artifacts,
    });
    const result = await publishManagedVerificationComment({
      env: host.env as Env,
      target: {
        prUrl: params.targetPrUrl,
        installationId: params.installationId,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        ownerSessionId: params.sessionId,
        promptId: params.promptId,
        headSha: params.fallbackHeadSha || undefined,
      },
      rawVerifierOutput: params.rawVerifierOutput,
      fallbackHeadSha: params.fallbackHeadSha,
      verifierResult: params.verifierResult,
      artifacts,
      sessionUrl: resolvePublicSessionUrl(host.env, params.sessionId),
    });
    logVerificationCommentPublishResult(host, params, result);
  } catch (error) {
    host.log.warn(
      {
        event: "verification_comment.publish_failed",
        sessionId: params.sessionId,
        promptId: params.promptId,
        targetPrUrl: params.targetPrUrl,
        kind: params.kind,
        error: String(error),
      },
      "Managed GitHub verification comment publication threw",
    );
  }
}

function scheduleVerificationResultCommentPublish(
  host: SessionPromptQueueHost,
  params: Parameters<typeof publishVerificationResultCommentSafely>[1],
): void {
  host.waitUntil(publishVerificationResultCommentSafely(host, params));
}

function scheduleVerificationSkippedCommentPublish(
  host: SessionPromptQueueHost,
  params: {
    sessionId: string;
    promptId: string;
    targetPrUrl: string;
    installationId: number | null;
    repoOwner: string | null;
    repoName: string | null;
    summary: string;
    reasonCode: string | null;
  },
): void {
  host.waitUntil(
    (async () => {
      try {
        const result = await publishVerificationSkippedComment({
          env: host.env as Env,
          target: {
            prUrl: params.targetPrUrl,
            installationId: params.installationId,
            repoOwner: params.repoOwner,
            repoName: params.repoName,
            ownerSessionId: params.sessionId,
            promptId: params.promptId,
          },
          summary: params.summary,
          reasonCode: params.reasonCode,
        });
        logVerificationCommentPublishResult(host, { ...params, kind: "skipped" }, result);
      } catch (error) {
        host.log.warn(
          {
            event: "verification_comment.publish_failed",
            sessionId: params.sessionId,
            promptId: params.promptId,
            targetPrUrl: params.targetPrUrl,
            kind: "skipped",
            error: String(error),
          },
          "Managed GitHub verification skipped comment publication threw",
        );
      }
    })(),
  );
}

function qaRunTerminalSummaryFromVerifierResult(input: {
  childSessionId: string;
  verifierResult: VerifierTerminalResult;
  runId?: number;
}): QaRunTerminalSummary {
  return normalizeQaRunTerminalSummary({
    childSessionId: input.childSessionId,
    runId: input.runId,
    head: input.verifierResult.verifiedHeadSha,
    evidenceCount: input.verifierResult.evidence.length,
    blockers: input.verifierResult.blockers,
  })!;
}

async function readVerifierRunIdForPrompt(host: SessionPromptQueueHost, promptId: string): Promise<number | undefined> {
  try {
    return await host.state.storage.get<number>(verificationRunIdStorageKey(promptId));
  } catch {
    return undefined;
  }
}

async function readVerificationCoordinatorSessionIdForPrompt(
  host: SessionPromptQueueHost,
  promptId: string,
): Promise<string | undefined> {
  try {
    const sessionId = await host.state.storage.get<string>(verificationCoordinatorSessionIdStorageKey(promptId));
    return sessionId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function collapseStoppedVerificationReason(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= STOPPED_VERIFICATION_REASON_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STOPPED_VERIFICATION_REASON_MAX_CHARS - 1).trimEnd()}…`;
}

function stoppedVerificationSentenceFragment(value: string | null | undefined): string | null {
  const collapsed = collapseStoppedVerificationReason(value);
  if (!collapsed) return null;
  const trimmed = collapsed.replace(/[.!?]+$/, "").trim();
  return trimmed || null;
}

function normalizeStoppedVerificationReason(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function combineStoppedVerificationReason(errorCode: ErrorCode | null, promptError: string | null): string | null {
  const detail = stoppedVerificationSentenceFragment(promptError);
  const label = errorCode ? stoppedVerificationSentenceFragment(errorCodeLabel(errorCode)) : null;
  if (!label) return detail;
  if (!detail) return label;
  const normalizedLabel = normalizeStoppedVerificationReason(label);
  const normalizedDetail = normalizeStoppedVerificationReason(detail);
  if (normalizedDetail.includes(normalizedLabel)) return detail;
  if (normalizedLabel.includes(normalizedDetail)) return label;
  return `${label}: ${detail}`;
}

// Exported for the DO's FSM transport seam: corroborates a bridge errorCode "aborted" as a genuinely
// delivered control-plane stop (the bridge sets this exact reason only in its stop-command abort path),
// vs classifyError's text-matched "aborted" (init AbortError, external session delete, failsafe aborts).
export function isStoppedByUserPromptError(promptError: string | null): boolean {
  const detail = stoppedVerificationSentenceFragment(promptError);
  if (!detail) return false;
  return normalizeStoppedVerificationReason(detail) === normalizeStoppedVerificationReason(STOPPED_BY_USER_REASON);
}

// Unexpected-terminal prompt errors can originate from raw bridge/provider text.
// Only surface locally-authored messages we control; otherwise rely on the
// structured error-code label in the PR comment.
function safeUnexpectedTerminalPromptError(promptError: string | null): string | null {
  const detail = stoppedVerificationSentenceFragment(promptError);
  if (!detail) return null;
  return SAFE_UNEXPECTED_TERMINAL_REASON_PATTERNS.some((pattern) => pattern.test(detail)) ? detail : null;
}

function archivedStoppedVerificationReason(promptError: string | null): string | null {
  const detail = stoppedVerificationSentenceFragment(promptError);
  if (!detail) return null;
  if (!detail.startsWith(SESSION_ARCHIVED_WHILE_PROCESSING_PREFIX)) return null;
  return stoppedVerificationSentenceFragment(detail.slice(SESSION_ARCHIVED_WHILE_PROCESSING_PREFIX.length));
}

function readStoppedVerificationContext(
  sql: SqlStorage,
  sessionId: string,
  promptId: string,
): StoppedVerificationContext {
  const prompt = doDb.getPrompt(sql, promptId);
  const rawErrorCode = doDb.getPromptTelemetry(sql, sessionId)[promptId]?.errorCode ?? null;
  return {
    promptError: prompt?.error ?? null,
    errorCode: isErrorCode(rawErrorCode) ? rawErrorCode : null,
  };
}

function resolveStoppedVerificationCause(
  cause: StoppedVerificationCause,
  context: StoppedVerificationContext,
): StoppedVerificationCause {
  if (cause !== "unexpected_terminal") return cause;
  if (context.errorCode === "aborted" && isStoppedByUserPromptError(context.promptError)) return "manual_stop";
  if (context.errorCode === "session_archived") return "archived";
  return cause;
}

function stoppedVerificationResult(input: {
  cause: StoppedVerificationCause;
  context: StoppedVerificationContext;
  fallbackHeadSha: string;
}): VerifierTerminalResult {
  if (input.cause === "manual_stop") {
    return {
      verdict: "INCONCLUSIVE",
      verifiedHeadSha: input.fallbackHeadSha,
      summary: "QA Tester session was stopped by the user before it could report a verdict.",
      evidence: ["The QA Tester session was stopped by the user before publishing a final QA Tester result."],
      blockers: ["QA testing was stopped by the user. Rerun QA testing for this PR to get a current verdict."],
    };
  }

  if (input.cause === "archived") {
    const reason = archivedStoppedVerificationReason(input.context.promptError);
    return {
      verdict: "INCONCLUSIVE",
      verifiedHeadSha: input.fallbackHeadSha,
      summary: reason
        ? `QA Tester session was archived before it could report a verdict: ${reason}.`
        : "QA Tester session was archived before it could report a verdict.",
      evidence: [
        reason
          ? `The QA Tester session was archived before publishing a final QA Tester result: ${reason}.`
          : "The QA Tester session was archived before publishing a final QA Tester result.",
      ],
      blockers: [
        reason
          ? `QA testing stopped because the session was archived: ${reason}. Start a new session or rerun QA testing if you still need a current verdict.`
          : "QA testing stopped because the session was archived before completion. Start a new session or rerun QA testing if you still need a current verdict.",
      ],
    };
  }

  const reason = combineStoppedVerificationReason(
    input.context.errorCode,
    safeUnexpectedTerminalPromptError(input.context.promptError),
  );
  return {
    verdict: "INCONCLUSIVE",
    verifiedHeadSha: input.fallbackHeadSha,
    summary: reason
      ? `QA Tester session stopped before it could report a verdict because of a platform error: ${reason}.`
      : "QA Tester session stopped before it could report a verdict because of a platform error.",
    evidence: [
      reason
        ? `The QA Tester session ended before publishing a final QA Tester result because of a platform error: ${reason}.`
        : "The QA Tester session ended before publishing a final QA Tester result because of a platform error.",
    ],
    blockers: [
      reason
        ? `QA testing stopped before completion because of a platform error: ${reason}. Rerun QA testing for this PR to get a current verdict.`
        : "QA testing stopped before completion because of a platform error. Rerun QA testing for this PR to get a current verdict.",
    ],
  };
}

function isVerificationSession(session: SessionState, ext: ReturnType<typeof doDb.getSessionExtended> | null): boolean {
  return isQaTesterAgentRole(session.agentRole) || isQaTesterAgentRole(ext?.agentRole);
}

function hasFinalVerificationOutcome(ext: ReturnType<typeof doDb.getSessionExtended> | null): boolean {
  return (
    ext?.verificationState === "verification-done" ||
    ext?.verificationState === "verification-skipped" ||
    ext?.verificationState === "verification-exhausted" ||
    ext?.verificationResult != null
  );
}

function shouldPublishStoppedVerificationResult(ext: ReturnType<typeof doDb.getSessionExtended> | null): boolean {
  if (!ext) return true;
  if (hasFinalVerificationOutcome(ext)) return false;
  return ext.verificationState !== "verification-stopped";
}

async function publishStoppedVerificationComment(
  host: SessionPromptQueueHost,
  sql: SqlStorage,
  session: SessionState,
  promptId: string,
  context: { cause: StoppedVerificationCause; details: StoppedVerificationContext },
): Promise<void> {
  const ext = doDb.getSessionExtended(sql, session.sessionId);
  if (!isVerificationSession(session, ext)) return;
  const targetPrUrl = session.targetPrUrl ?? ext?.targetPrUrl ?? null;
  if (!targetPrUrl) {
    host.log.warn(
      { event: "verification_comment.stopped_skipped", sessionId: session.sessionId, promptId },
      "Stopped verification session has no target PR URL; skipped managed GitHub comment",
    );
    return;
  }
  if (!host.env.DB || !host.env.GITHUB_APP_ID || !host.env.GITHUB_PRIVATE_KEY) {
    host.log.warn(
      { event: "verification_comment.stopped_skipped", sessionId: session.sessionId, promptId },
      "Stopped verification session has no GitHub environment bindings; skipped managed GitHub comment",
    );
    return;
  }
  // Non-null past the guard above; capture so the narrowing survives the awaits below.
  const db = host.env.DB;
  const latestExt = doDb.getSessionExtended(sql, session.sessionId);
  if (!shouldPublishStoppedVerificationResult(latestExt)) {
    host.log.info(
      {
        event: "verification_comment.stopped_skipped",
        sessionId: session.sessionId,
        promptId,
        verificationState: latestExt?.verificationState ?? null,
        verificationResult: latestExt?.verificationResult ?? null,
      },
      "Stopped verification comment skipped because verification already has a terminal outcome",
    );
    return;
  }

  // Finalize the terminal `verification-stopped` state + spine `stopped` emit directly; the restored
  // managed QA comment is published afterward and does not gate lifecycle state.
  {
    await syncVerificationStateForPr(host.env as Env, {
      prUrl: targetPrUrl,
      state: "verification-stopped",
      installationId: ext?.installationId ?? null,
      repoOwner: ext?.repoOwner ?? null,
      repoName: ext?.repoName ?? null,
      logger: host.log,
    });
    // ARC-1330 W11 D-51: the per-PR verification lock (ARC-1173) is removed, so this terminal no
    // longer releases a lock. A3: the rerun-after-fix path is retired (non-blocking QA) — an
    // abnormal-stop terminal ALWAYS emits the run-scoped spine `stopped` verdict.
    scheduleGithubQaFinishedReaction(host, ext?.callbackContext);
    {
      // ARC-1330 (PR 49): a truly-terminal abnormal stop synced LEGACY `verification-stopped` but emitted
      // NO spine verdict — stranding the parent's pr_coordination row (the prod-soak strand class). Echo
      // the per-prompt run token into the spine `stopped` event (→ record write + NOTIFY_QA_ISSUE via
      // CORE) so the run resolves. Best-effort/try-caught OFF the legacy path; parent resolved like the
      // verdict-back seam.
      try {
        const childRow = await getChildSessionRow(db, session.sessionId);
        const parentSessionId = childRow?.parent_session_id ?? null;
        if (parentSessionId) {
          let echoedRunId: number | undefined;
          try {
            echoedRunId = await host.state.storage.get<number>(verificationRunIdStorageKey(promptId));
          } catch {
            // best-effort token read — an unreadable token fails toward NOT-fresh, never a false accept.
          }
          await shadowEmitVerificationTerminalOutcome(
            host.env as Env,
            parentSessionId,
            { outcome: "stopped", headSha: null, runId: echoedRunId },
            { waitUntil: (promise) => host.waitUntil(promise) },
            host.log,
          );
        }
      } catch (error) {
        host.log.warn(
          {
            event: "fsm.verification_stop.shadow_emit_failed",
            sessionId: session.sessionId,
            promptId,
            error: String(error),
          },
          "ARC-1330 shadow spine stopped emit failed (ignored)",
        );
      }
    }
    await publishVerificationResultCommentSafely(host, {
      sql,
      sessionId: session.sessionId,
      promptId,
      targetPrUrl,
      ext,
      installationId: ext?.installationId ?? null,
      repoOwner: ext?.repoOwner ?? null,
      repoName: ext?.repoName ?? null,
      rawVerifierOutput: "",
      fallbackHeadSha: ext?.lastCommitSha ?? "",
      verifierResult: stoppedVerificationResult({
        cause: context.cause,
        context: context.details,
        fallbackHeadSha: ext?.lastCommitSha ?? "",
      }),
      artifacts: [],
      kind: "stopped",
    });
  }
}

async function handleStoppedVerificationOutcome(
  host: SessionPromptQueueHost,
  sql: SqlStorage,
  session: SessionState,
  promptId: string,
  cause: StoppedVerificationCause,
): Promise<void> {
  // A3: non-blocking QA — an abnormal verifier stop is never re-spawned; it finalizes the terminal
  // `verification-stopped` state, whose spine `stopped` emit (→ REVIEW record + NOTIFY_QA_ISSUE via
  // CORE) surfaces the QA issue. The 1h run-scoped backstop (fireStuckVerificationBackstops) covers a
  // verifier that dies WITHOUT ever reaching this seam.
  const details = readStoppedVerificationContext(sql, session.sessionId, promptId);
  const effectiveCause = resolveStoppedVerificationCause(cause, details);
  await publishStoppedVerificationComment(host, sql, session, promptId, {
    cause: effectiveCause,
    details,
  });
}

function trackStoppedVerificationComment(
  host: SessionPromptQueueHost,
  sql: SqlStorage,
  session: SessionState,
  promptId: string,
  cause: StoppedVerificationCause,
): void {
  host.waitUntil(
    runWithSentryTag(
      "handleStoppedVerificationOutcome",
      () => handleStoppedVerificationOutcome(host, sql, session, promptId, cause),
      host.log,
      {
        message: "Stopped verification handling failed",
        logFields: { sessionId: session.sessionId, promptId, cause },
        tags: { sessionId: session.sessionId },
      },
    ),
  );
}

/**
 * ARC-960: register a post-execution PR creation/update follow-up with the DO's
 * `waitUntil` so the Durable Object cannot go idle before the publish promise
 * settles. The catch is an observability backstop only — the durable terminal
 * publish state is owned by `publishSessionResult` (which fails closed to
 * `publishStatus: "failed"` on any throw before it reaches "publishing"). Logging
 * goes through `runWithSentryTag` per docs/conventions.md, carrying the
 * sessionId/branch context and operation-specific message.
 */
function trackPostExecutionPublish(
  host: Pick<SessionPromptQueueHost, "waitUntil" | "log">,
  operation: "triggerPrCreation" | "triggerPrUpdate",
  sessionId: string,
  branch: string,
  promise: Promise<void>,
): void {
  host.waitUntil(
    runWithSentryTag(operation, () => promise, host.log, {
      message: operation === "triggerPrCreation" ? "PR creation failed" : "PR update failed",
      logFields: { sessionId, branch },
      // runWithSentryTag already merges `operation` into the Sentry tags.
      tags: { sessionId },
    }),
  );
}

type AutoPublishDecisionSource = "post_execution" | "deferred";
type AutoPublishDecision = "trigger_create" | "trigger_update" | "skip";

interface AutoPublishDecisionFields {
  sessionId: string;
  promptId?: string | null;
  ownerUserId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  source: AutoPublishDecisionSource;
  decision: AutoPublishDecision;
  reason: string;
  branch?: string | null;
  commitSha?: string | null;
  hasChanges?: boolean | null;
  pushed?: boolean | null;
  activePromptId?: string | null;
  existingPrUrl?: string | null;
  publishStatus?: string | null;
}

function emitAutoPublishDecision(host: SessionPromptQueueHost, fields: AutoPublishDecisionFields): void {
  const repo = fields.repoOwner && fields.repoName ? `${fields.repoOwner}/${fields.repoName}` : null;
  host.waitUntil(
    postStructuredEventToDd(host.env, {
      event: "auto_publish.decision",
      session_id: fields.sessionId,
      prompt_id: fields.promptId ?? null,
      owner_user_id: fields.ownerUserId ?? null,
      repo,
      repo_owner: fields.repoOwner ?? null,
      repo_name: fields.repoName ?? null,
      source: fields.source,
      decision: fields.decision,
      reason: fields.reason,
      branch: fields.branch ?? null,
      commit_sha: fields.commitSha ?? null,
      has_changes: fields.hasChanges ?? null,
      pushed: fields.pushed ?? null,
      active_prompt_id: fields.activePromptId ?? null,
      existing_pr_url: fields.existingPrUrl ?? null,
      publish_status: fields.publishStatus ?? null,
    }).catch((err) => {
      host.log.warn(
        { sessionId: fields.sessionId, promptId: fields.promptId ?? null, reason: fields.reason, error: String(err) },
        "Failed to emit auto publish decision telemetry",
      );
    }),
  );
}

function withPublishUserSettingsCache<T>(
  host: Pick<SessionPromptQueueHost, "withPublishUserSettingsCache">,
  operation: (settingsCache?: UserSettingsCache) => Promise<T>,
): Promise<T> {
  return host.withPublishUserSettingsCache
    ? host.withPublishUserSettingsCache((settingsCache) => operation(settingsCache))
    : operation();
}

function latestCompletedPromptForBranch(prompts: PromptState[], branch: string): PromptState | null {
  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    const prompt = prompts[i];
    if (prompt.status !== "completed") continue;
    if (promptResultBranch(prompt.result) === branch) return prompt;
  }
  return null;
}

async function maybeTriggerDeferredPrCreation(
  host: SessionPromptQueueHost,
  sql: SqlStorage,
  sessionId: string,
  ownerUserId: string,
  prompts: PromptState[],
): Promise<void> {
  const activePromptId = doDb.getActiveProcessingPromptId(sql, sessionId);
  if (activePromptId) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      source: "deferred",
      decision: "skip",
      reason: "active_prompt",
      activePromptId,
    });
    return;
  }

  const ext = doDb.getSessionExtended(sql, sessionId);
  if (!ext) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      source: "deferred",
      decision: "skip",
      reason: "no_session_extended",
    });
    return;
  }
  if (ext.prUrl) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: "existing_pr_attached",
      branch: ext.lastBranch,
      commitSha: ext.lastCommitSha,
      existingPrUrl: ext.prUrl,
      publishStatus: ext.publishStatus,
    });
    return;
  }
  if (ext.publishStatus !== "not_started" && ext.publishStatus !== "failed") {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: "publish_status_ineligible",
      branch: ext.lastBranch,
      commitSha: ext.lastCommitSha,
      publishStatus: ext.publishStatus,
    });
    return;
  }

  const branch = ext.lastBranch?.trim();
  if (!branch) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: "branch_missing",
      commitSha: ext.lastCommitSha,
      publishStatus: ext.publishStatus,
    });
    return;
  }
  if (ext.baseBranch && branch === ext.baseBranch) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: "branch_is_base",
      branch,
      commitSha: ext.lastCommitSha,
      publishStatus: ext.publishStatus,
    });
    return;
  }

  const sourcePrompt = latestCompletedPromptForBranch(prompts, branch);
  if (!sourcePrompt) {
    emitAutoPublishDecision(host, {
      sessionId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: "source_prompt_missing",
      branch,
      commitSha: ext.lastCommitSha,
      publishStatus: ext.publishStatus,
    });
    return;
  }

  const pushOutcome = doDb.getPromptPushOutcome(sql, sourcePrompt.promptId);
  if (!pushOutcome || pushOutcome.pushStatus !== "succeeded") {
    emitAutoPublishDecision(host, {
      sessionId,
      promptId: sourcePrompt.promptId,
      ownerUserId,
      repoOwner: ext.repoOwner,
      repoName: ext.repoName,
      source: "deferred",
      decision: "skip",
      reason: pushOutcome ? "push_not_succeeded" : "push_outcome_missing",
      branch,
      commitSha: promptResultCommitSha(sourcePrompt.result) ?? ext.lastCommitSha,
      publishStatus: ext.publishStatus,
      pushed: pushOutcome?.pushStatus === "failed" ? false : null,
    });
    return;
  }

  trackPostExecutionPublish(
    host,
    "triggerPrCreation",
    sessionId,
    branch,
    withPublishUserSettingsCache(host, async (settingsCache) => {
      const verification = await host.state.storage.get<ExecutionVerification>("verification");
      const prReadiness = await host.state.storage.get<PrReadinessEvidence>(PR_READINESS_STORAGE_KEY);
      const prTemplateFill =
        await host.state.storage.get<Extract<SandboxEvent, { type: "post_execution" }>["prTemplateFill"]>(
          PR_TEMPLATE_FILL_STORAGE_KEY,
        );

      emitAutoPublishDecision(host, {
        sessionId,
        promptId: sourcePrompt.promptId,
        ownerUserId,
        repoOwner: ext.repoOwner,
        repoName: ext.repoName,
        source: "deferred",
        decision: "trigger_create",
        reason: "auto_create_enabled",
        branch,
        commitSha: promptResultCommitSha(sourcePrompt.result) ?? ext.lastCommitSha,
        publishStatus: ext.publishStatus,
        pushed: true,
      });

      const args = [
        sessionId,
        branch,
        promptResultDiffSummary(sourcePrompt.result),
        undefined,
        undefined,
        verification,
        prReadiness,
        sourcePrompt.promptId,
        promptResultCommitSha(sourcePrompt.result),
      ] as const;
      if (settingsCache) {
        await host.triggerPrCreation(...args, settingsCache, prTemplateFill);
      } else {
        await host.triggerPrCreation(...args, undefined, prTemplateFill);
      }
    }),
  );
}

function trackSlackThreadNotification(
  host: Pick<
    SessionPromptQueueHost,
    "env" | "state" | "waitUntil" | "log" | "notifySlackThread" | "rescheduleSessionAlarm"
  >,
  callbackContext: SessionState["callbackContext"] | undefined,
  sessionId: string,
  promptId: string,
  success: boolean,
): void {
  host.waitUntil(
    (async () => {
      const storedSession = await host.state.storage.get<SessionState>("session");
      const resolvedCallbackContext =
        callbackContext ??
        storedSession?.callbackContext ??
        doDb.getSessionExtended(host.state.storage.sql, sessionId)?.callbackContext ??
        undefined;
      if (!resolvedCallbackContext || resolvedCallbackContext.source !== "slack") return;
      if (host.env.DB) {
        await insertSlackPostIfAbsent(host.env.DB, {
          sessionId,
          promptId,
          stage: success ? "completed" : "failed",
          channel: resolvedCallbackContext.channel,
          nextAttemptAt: Date.now(),
        });
      }
      await host.rescheduleSessionAlarm();
      await runWithSentryTag(
        "notifySlackThread",
        () => host.notifySlackThread(sessionId, promptId, success),
        host.log,
        {
          message: "Slack thread notification error",
          logFields: { sessionId },
          tags: { sessionId },
        },
      );
    })(),
  );
}

function scheduleGithubQaFinishedReaction(
  host: Pick<SessionPromptQueueHost, "env" | "waitUntil" | "log">,
  callbackContext: SessionState["callbackContext"] | undefined,
): void {
  if (callbackContext?.source !== "github_qa_issue_comment") return;
  host.waitUntil(
    postIssueCommentReaction(
      host.env as Env,
      callbackContext.installationId,
      callbackContext.repoOwner,
      callbackContext.repoName,
      callbackContext.commentId,
      GITHUB_QA_FINISHED_REACTION,
    ).catch((error) => {
      host.log.warn(
        {
          error: String(error),
          repoOwner: callbackContext.repoOwner,
          repoName: callbackContext.repoName,
          issueNumber: callbackContext.issueNumber,
          commentId: callbackContext.commentId,
          targetPrUrl: callbackContext.targetPrUrl,
          reaction: GITHUB_QA_FINISHED_REACTION,
        },
        "Failed to post GitHub QA issue-comment finished reaction",
      );
    }),
  );
}

async function scheduleQaPassLabelOnce(
  host: Pick<SessionPromptQueueHost, "env" | "state" | "waitUntil" | "log">,
  options: {
    sessionId: string;
    promptId: string;
    targetPrUrl: string;
    installationId: number | null;
    repoOwner: string | null;
    repoName: string | null;
  },
): Promise<void> {
  const markerKey = qaPassLabelAppliedStorageKey(options.promptId);
  try {
    if (await host.state.storage.get<boolean>(markerKey)) return;
    // Persist before scheduling: a redelivered post_execution must not re-add a label a human removed.
    await host.state.storage.put(markerKey, true);
  } catch (error) {
    host.log.warn(
      {
        prUrl: options.targetPrUrl,
        sessionId: options.sessionId,
        promptId: options.promptId,
        error: String(error),
      },
      "Failed to persist QA pass label delivery marker",
    );
    return;
  }

  host.waitUntil(
    applyQaPassLabel(host.env as Env, {
      prUrl: options.targetPrUrl,
      sessionId: options.sessionId,
      installationId: options.installationId,
      repoOwner: options.repoOwner,
      repoName: options.repoName,
      logger: host.log,
    }).catch((error) => {
      host.log.warn(
        {
          prUrl: options.targetPrUrl,
          sessionId: options.sessionId,
          promptId: options.promptId,
          error: String(error),
        },
        "Failed to schedule QA pass label apply",
      );
    }),
  );
}

function readPromptStoppedBy(value: unknown): Record<string, PromptStoppedBy> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, PromptStoppedBy> = {};
  for (const [promptId, stoppedBy] of Object.entries(value as Record<string, unknown>)) {
    if (stoppedBy === "user") {
      result[promptId] = stoppedBy;
    }
  }
  return result;
}

async function storePromptStoppedBy(
  state: DurableObjectState,
  promptId: string,
  stoppedBy: PromptStoppedBy,
): Promise<void> {
  const markers = readPromptStoppedBy(await state.storage.get(PROMPT_STOPPED_BY_STORAGE_KEY));
  markers[promptId] = stoppedBy;
  await state.storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, markers);
}

export type PromptDispatchPath = "live" | "warm" | "cold";
const PROMPT_DISPATCH_PATH_STORAGE_KEY = "prompt_dispatch_path";

function isPromptDispatchPath(value: unknown): value is PromptDispatchPath {
  return value === "live" || value === "warm" || value === "cold";
}

function readPromptDispatchPaths(value: unknown): Record<string, PromptDispatchPath> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, PromptDispatchPath> = {};
  for (const [promptId, dispatchPath] of Object.entries(value as Record<string, unknown>)) {
    if (isPromptDispatchPath(dispatchPath)) {
      result[promptId] = dispatchPath;
    }
  }
  return result;
}

async function storePromptDispatchPath(
  state: DurableObjectState,
  promptId: string,
  dispatchPath: PromptDispatchPath,
): Promise<void> {
  const paths = readPromptDispatchPaths(await state.storage.get(PROMPT_DISPATCH_PATH_STORAGE_KEY));
  paths[promptId] = dispatchPath;
  await state.storage.put(PROMPT_DISPATCH_PATH_STORAGE_KEY, paths);
}

async function takePromptDispatchPath(state: DurableObjectState, promptId: string): Promise<PromptDispatchPath | null> {
  const paths = readPromptDispatchPaths(await state.storage.get(PROMPT_DISPATCH_PATH_STORAGE_KEY));
  const dispatchPath = paths[promptId];
  if (!dispatchPath) return null;

  delete paths[promptId];
  if (Object.keys(paths).length > 0) {
    await state.storage.put(PROMPT_DISPATCH_PATH_STORAGE_KEY, paths);
  } else {
    await state.storage.delete(PROMPT_DISPATCH_PATH_STORAGE_KEY);
  }
  return dispatchPath;
}

export function resolvePromptDispatchPath(
  shouldSendPromptNow: boolean,
  resume: SandboxResumeState,
): PromptDispatchPath {
  if (shouldSendPromptNow) return "live";
  return resume.paused && !resume.expired ? "warm" : "cold";
}

export function buildPromptQueueWaitEvent(
  session: SessionState,
  prompt: Pick<PromptState, "promptId" | "createdAt">,
  dispatchPath: PromptDispatchPath,
  nowMs = Date.now(),
): Record<string, unknown> | null {
  const createdAtMs = Date.parse(prompt.createdAt);
  if (!Number.isFinite(createdAtMs)) return null;

  return {
    event: "prompt.queue_wait",
    sessionId: session.sessionId,
    promptId: prompt.promptId,
    queue_wait_ms: Math.max(0, nowMs - createdAtMs),
    dispatch_path: dispatchPath,
    agent_runtime_backend: session.agentRuntimeBackend ?? "unknown",
  };
}

function emitPromptQueueWaitEvent(
  host: Pick<SessionPromptQueueHost, "env" | "waitUntil">,
  session: SessionState,
  prompt: Pick<PromptState, "promptId" | "createdAt">,
  dispatchPath: PromptDispatchPath,
  nowMs = Date.now(),
): void {
  const event = buildPromptQueueWaitEvent(session, prompt, dispatchPath, nowMs);
  if (!event) return;
  host.waitUntil(postStructuredEventToDd(host.env, event));
}

async function emitStoredPromptQueueWaitEvent(
  host: Pick<SessionPromptQueueHost, "env" | "state" | "waitUntil">,
  session: SessionState,
  prompt: Pick<PromptState, "promptId" | "createdAt">,
  nowMs = Date.now(),
): Promise<void> {
  const dispatchPath = await takePromptDispatchPath(host.state, prompt.promptId);
  if (!dispatchPath) return;
  emitPromptQueueWaitEvent(host, session, prompt, dispatchPath, nowMs);
}

async function clearPromptMarkers(state: DurableObjectState, promptId: string): Promise<void> {
  const stoppedBy = readPromptStoppedBy(await state.storage.get(PROMPT_STOPPED_BY_STORAGE_KEY));
  if (promptId in stoppedBy) {
    delete stoppedBy[promptId];
    if (Object.keys(stoppedBy).length > 0) {
      await state.storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, stoppedBy);
    } else {
      await state.storage.delete(PROMPT_STOPPED_BY_STORAGE_KEY);
    }
  }
  // Drop a redeliverable answer once its owning prompt is terminal so a stale
  // answer is never replayed to the next prompt's bridge (9.3).
  const pendingAnswer = (await state.storage.get(PENDING_ANSWER_STORAGE_KEY)) as PendingAnswerRecord | undefined;
  if (pendingAnswer?.promptId === promptId) {
    await state.storage.delete(PENDING_ANSWER_STORAGE_KEY);
  }
  const dispatchPaths = readPromptDispatchPaths(await state.storage.get(PROMPT_DISPATCH_PATH_STORAGE_KEY));
  if (promptId in dispatchPaths) {
    delete dispatchPaths[promptId];
    if (Object.keys(dispatchPaths).length > 0) {
      await state.storage.put(PROMPT_DISPATCH_PATH_STORAGE_KEY, dispatchPaths);
    } else {
      await state.storage.delete(PROMPT_DISPATCH_PATH_STORAGE_KEY);
    }
  }
}

function pickAttachments(prompt: Pick<PromptState, "skills" | "files" | "uploadedFiles" | "uploadedImages">) {
  return {
    ...(prompt.skills?.length ? { skills: prompt.skills } : {}),
    ...(prompt.files?.length ? { files: prompt.files } : {}),
    ...(prompt.uploadedFiles?.length ? { uploadedFiles: prompt.uploadedFiles } : {}),
    ...(prompt.uploadedImages?.length ? { uploadedImages: prompt.uploadedImages } : {}),
  };
}

type ParsedPromptUploads =
  { ok: true; uploadedFiles?: UploadedFile[]; uploadedImages?: UploadedImage[] } | { ok: false; response: Response };

function parsePromptUploads(payload: Partial<EnqueueSessionPromptRequest>, promptText: string): ParsedPromptUploads {
  let uploadedFiles: UploadedFile[] | undefined;
  if (Array.isArray(payload.uploadedFiles)) {
    const parsed: UploadedFile[] = [];
    for (const item of payload.uploadedFiles) {
      if (!item || typeof item !== "object") {
        return { ok: false, response: jsonErrorResponse("Invalid uploaded file entry", 400) };
      }
      const { name, content } = item as { name?: unknown; content?: unknown };
      if (typeof name !== "string") {
        return { ok: false, response: jsonErrorResponse("Uploaded file name must be a non-empty string", 400) };
      }
      if (typeof content !== "string") {
        return { ok: false, response: jsonErrorResponse(`Uploaded file content must be a string: ${name}`, 400) };
      }
      parsed.push({ name, content });
    }
    const validation = validateUploadedFilePayload(parsed);
    if (!validation.ok) return { ok: false, response: jsonErrorResponse(validation.error, 400) };
    uploadedFiles = validation.value.length > 0 ? validation.value : undefined;
  }

  let uploadedImages: UploadedImage[] | undefined;
  if (Array.isArray(payload.uploadedImages)) {
    const parsed: UploadedImage[] = [];
    for (const item of payload.uploadedImages) {
      if (!item || typeof item !== "object") {
        return { ok: false, response: jsonErrorResponse("Invalid uploaded image entry", 400) };
      }
      const { name, mediaType, data } = item as { name?: unknown; mediaType?: unknown; data?: unknown };
      if (typeof name !== "string") {
        return { ok: false, response: jsonErrorResponse("Uploaded image name must be a non-empty string", 400) };
      }
      if (typeof mediaType !== "string") {
        return {
          ok: false,
          response: jsonErrorResponse(
            `Unsupported image type: ${String(mediaType)}. Supported types are required.`,
            400,
          ),
        };
      }
      if (typeof data !== "string") {
        return {
          ok: false,
          response: jsonErrorResponse(`Uploaded image data must be a non-empty base64 string: ${name}`, 400),
        };
      }
      parsed.push({ name, mediaType, data });
    }
    const validation = validateUploadedImagePayload(parsed);
    if (!validation.ok) return { ok: false, response: jsonErrorResponse(validation.error, 400) };
    uploadedImages = validation.value.length > 0 ? validation.value : undefined;
  }

  const effectiveReplyToText =
    typeof payload.replyToText === "string" ? payload.replyToText.trim() || promptText : promptText;
  const sqlPayload = validatePromptUploadSqlPayload({
    promptText,
    replyToText: effectiveReplyToText,
    uploadedFiles,
    uploadedImages,
  });
  if (!sqlPayload.ok) return { ok: false, response: jsonErrorResponse(sqlPayload.error, 413) };

  return { ok: true, uploadedFiles, uploadedImages };
}

function summarizeUploads(
  prompt: Pick<PromptState, "uploadedFiles" | "uploadedImages">,
  includeUploadedImageData = false,
) {
  return {
    ...(prompt.uploadedFiles?.length ? { uploadedFiles: prompt.uploadedFiles.map((f) => ({ name: f.name })) } : {}),
    ...(prompt.uploadedImages?.length
      ? {
          uploadedImages: prompt.uploadedImages.map((img) => ({
            name: img.name,
            mediaType: img.mediaType ?? null,
            ...(includeUploadedImageData && img.data ? { data: img.data } : {}),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Exported projection helpers
// ---------------------------------------------------------------------------

export function toClientPrompt(
  prompt: PromptState,
  sessionId: string,
  sessionModel?: string | null,
  sessionReasoningEffort?: string | null,
  options?: { includeUploadedImageData?: boolean; actorProfile?: PromptActorProfile | null },
): ClientPrompt {
  let result: ClientPrompt["result"] = null;
  if (typeof prompt.result === "string") {
    result = prompt.result;
  } else if (prompt.result && typeof prompt.result === "object") {
    result = prompt.result as Record<string, unknown>;
  } else if (prompt.result != null) {
    result = JSON.stringify(prompt.result);
  }

  return {
    promptId: prompt.promptId,
    session_id: sessionId,
    prompt: prompt.prompt,
    replyToText: prompt.replyToText ?? null,
    ...(prompt.agent ? { agent: prompt.agent } : {}),
    ...(prompt.skills?.length ? { skills: prompt.skills } : {}),
    actorUserId: prompt.actorUserId ?? null,
    ...(options?.actorProfile?.login != null ? { actorLogin: options.actorProfile.login } : {}),
    ...(options?.actorProfile?.avatarUrl != null ? { actorAvatarUrl: options.actorProfile.avatarUrl } : {}),
    ...(sessionModel != null ? { model: sessionModel } : {}),
    ...(sessionReasoningEffort != null ? { reasoningEffort: sessionReasoningEffort } : {}),
    ...(prompt.files?.length ? { files: prompt.files } : {}),
    ...summarizeUploads(prompt, options?.includeUploadedImageData === true),
    result,
    error: prompt.error,
    errorDetails: toClientErrorDetails(prompt.errorDetails ?? null),
    status: prompt.status,
    createdAt: prompt.createdAt,
    // The plan→implement handoff prompt carries planContext; the UI renders it as
    // a continuation of the plan instead of a second echoed user turn.
    ...(prompt.planContext ? { continuesPlan: true } : {}),
  };
}

export async function toClientPromptWithActorProfile(
  host: SessionPromptQueueHost,
  prompt: PromptState,
  sessionId: string,
  sessionModel?: string | null,
  sessionReasoningEffort?: string | null,
  options?: { includeUploadedImageData?: boolean },
): Promise<ClientPrompt> {
  let actorProfile: PromptActorProfile | null = null;
  try {
    actorProfile = await host.resolvePromptActorProfile(prompt.actorUserId);
  } catch (err) {
    host.log.warn(
      {
        sessionId,
        promptId: prompt.promptId,
        actorUserId: prompt.actorUserId,
        error: String(err),
      },
      "Failed to resolve prompt actor profile",
    );
  }
  return toClientPrompt(prompt, sessionId, sessionModel, sessionReasoningEffort, {
    ...options,
    actorProfile,
  });
}

export function getQueueState(prompts: PromptState[], activePromptId: string | null): QueueState {
  return {
    queuedCount: prompts.filter((prompt) => prompt.status === "queued").length,
    processingPromptId: activePromptId,
  };
}

export function buildSandboxCallbackContract(
  sessionId: string,
  prompt: PromptState,
  callbackAuth: string,
  sessionModel?: string | null,
): DispatchContract {
  return {
    sessionId,
    promptId: prompt.promptId,
    prompt: prompt.prompt,
    ...(sessionModel ? { model: sessionModel } : {}),
    ...pickAttachments(prompt),
    callback: {
      method: "POST",
      path: `/internal/sandbox/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(prompt.promptId)}/callback`,
      auth: callbackAuth,
    },
  };
}

export function buildPromptCommand(prompt: PromptState, session: SessionState): SandboxCommand & { type: "prompt" } {
  const correlation = buildSerializedCorrelation({
    sessionId: session.sessionId,
    promptId: prompt.promptId,
  });
  const explicitVerifyAgent = prompt.agent === VERIFY_AGENT_NAME;
  const agentRole = explicitVerifyAgent
    ? QA_TESTER_AGENT_ROLE
    : isCodeReviewerSession(session)
      ? REVIEW_AGENT_ROLE
      : (session.agentRole ?? "implementation");
  const usePlanAgentProfile = isPlanModePlanPrompt(session, prompt);
  // Onboarding sessions pin their profile: a per-prompt `agent` must not strip
  // the onboarding playbook mid-session.
  const sessionAgentProfile = usePlanAgentProfile
    ? PLAN_AGENT_NAME
    : session.agentProfile === ONBOARD_AGENT_NAME
      ? ONBOARD_AGENT_NAME
      : (prompt.agent ??
        session.agentProfile ??
        (isQaTesterAgentRole(agentRole) ? VERIFY_AGENT_NAME : DEFAULT_AGENT_NAME));
  const promptAgent = usePlanAgentProfile
    ? PLAN_AGENT_NAME
    : (prompt.agent ?? (sessionAgentProfile !== DEFAULT_AGENT_NAME ? sessionAgentProfile : undefined));
  const runtimeStartupProfile =
    session.runtimeStartupProfile ??
    (isQaTesterAgentRole(agentRole) ? QA_TESTER_RUNTIME_STARTUP_PROFILE : "implementation_default");
  const verificationRuntimeMode = session.verificationRuntimeMode ?? "none";
  return {
    type: "prompt",
    messageId: prompt.promptId,
    content: prompt.prompt,
    branchNameHint: prompt.branchNameHint,
    actorUserId: prompt.actorUserId,
    agent: promptAgent,
    agentRole,
    agentProfile: sessionAgentProfile,
    harnessKind: session.harnessKind ?? "codex-session",
    runtimeStartupProfile,
    verificationRuntimeMode,
    ...(session.targetPrUrl ? { targetPrUrl: session.targetPrUrl } : {}),
    ...(prompt.reviewLoopEpochId
      ? {
          reviewLoopMode: true,
          epochId: prompt.reviewLoopEpochId,
          ...(prompt.reviewLoopSourceKind ? { sourceKind: prompt.reviewLoopSourceKind } : {}),
        }
      : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.agentRuntimeBackend ? { agentRuntimeBackend: session.agentRuntimeBackend } : {}),
    ...(prompt.planContext ? { planContext: prompt.planContext } : {}),
    ...pickAttachments(prompt),
    ...(correlation ? { correlation } : {}),
  };
}

export function resolvePromptAgentRoleForBridge(agentRole: AgentRole, bridgeProtocolVersion: number | null): AgentRole {
  if (
    agentRole === REVIEW_AGENT_ROLE &&
    bridgeProtocolVersion !== null &&
    bridgeProtocolVersion < REVIEW_AGENT_ROLE_BRIDGE_PROTOCOL_VERSION
  ) {
    return QA_TESTER_AGENT_ROLE;
  }
  return agentRole;
}

export function isPlanModePlanPrompt(
  session: SessionState,
  prompt: Pick<PromptState, "promptId" | "agent" | "isPlanPrompt">,
): boolean {
  if (session.planMode !== true) return false;
  // The initial plan turn is p-1; its disconnect/spawn-timeout retry clones get
  // a fresh id (p-2, ...) but are stamped isPlanPrompt so they stay in plan mode.
  if (prompt.promptId !== "p-1" && prompt.isPlanPrompt !== true) return false;
  if (prompt.agent) return false;
  if (isQaTesterAgentRole(session.agentRole)) return false;
  if (session.agentProfile === ONBOARD_AGENT_NAME) return false;
  if (session.targetPrUrl && session.targetPrUrl.trim().length > 0) return false;
  return true;
}

function hasD1Prepare(db: PromptQueueEnv["DB"]): db is D1Database {
  return !!db && typeof db.prepare === "function";
}

function truncateVerificationParentPromptText(prompt: string): string {
  if (prompt.length <= VERIFICATION_PARENT_PROMPT_TEXT_MAX_CHARS) return prompt;
  return `${prompt.slice(0, VERIFICATION_PARENT_PROMPT_TEXT_MAX_CHARS)}\n[truncated]`;
}

function toVerificationParentPrompts(prompts: ClientPrompt[]): VerificationParentPrompt[] {
  return prompts.map((prompt) => ({
    promptId: prompt.promptId,
    prompt: truncateVerificationParentPromptText(prompt.prompt),
    status: prompt.status,
    ...(prompt.createdAt ? { createdAt: prompt.createdAt } : {}),
  }));
}

async function resolveVerificationParentPromptContext(
  host: Pick<SessionPromptQueueHost, "env" | "log" | "listSessionPrompts">,
  sessionId: string,
): Promise<{ parentPrompts?: VerificationParentPrompt[]; warnings: string[] }> {
  if (!hasD1Prepare(host.env.DB)) return { warnings: [] };

  let childRow;
  try {
    childRow = await getChildSessionRow(host.env.DB, sessionId);
  } catch (error) {
    return {
      warnings: [
        `Control-plane parent prompt context lookup failed for verifier session ${sessionId}: ${String(error)}`,
      ],
    };
  }
  if (!childRow?.parent_session_id) return { warnings: [] };

  try {
    const parentPrompts = await host.listSessionPrompts(childRow.parent_session_id);
    return { parentPrompts: toVerificationParentPrompts(parentPrompts), warnings: [] };
  } catch (error) {
    host.log.warn(
      {
        event: "verification_parent_prompts_fetch_failed",
        sessionId,
        parentSessionId: childRow.parent_session_id,
        error: String(error),
      },
      "Verification parent prompts fetch failed; dispatching setup warning",
    );
    return {
      warnings: [
        `Control-plane parent prompt context fetch failed for parent session ${childRow.parent_session_id}: ${String(error)}`,
      ],
    };
  }
}

async function buildPromptCommandForDispatch(
  host: Pick<SessionPromptQueueHost, "env" | "log" | "listSessionPrompts">,
  sql: SqlStorage,
  prompt: PromptState,
  session: SessionState,
): Promise<SandboxCommand & { type: "prompt" }> {
  const builtCommand = buildPromptCommand(prompt, session);
  const bridgeProtocolVersion = doDb.getSandboxState(sql, session.sessionId)?.bridgeProtocolVersion ?? null;
  // Older bridge bundles do not understand the distinct reviewer role and
  // safely handled review-profile sessions through the verification role.
  // Keep that behavior only for the version-skew window; current bridges get
  // the persisted review role and therefore start an independent process.
  const command = {
    ...builtCommand,
    agentRole: resolvePromptAgentRoleForBridge(builtCommand.agentRole ?? "implementation", bridgeProtocolVersion),
  };
  if (!isQaTesterAgentRole(command.agentRole) && !session.adoptedExternalPr) return command;

  const warnings: string[] = [];
  const parentPromptContext = await resolveVerificationParentPromptContext(host, session.sessionId);
  warnings.push(...parentPromptContext.warnings);
  const withParentPrompts = parentPromptContext.parentPrompts
    ? { ...command, verificationParentPrompts: parentPromptContext.parentPrompts }
    : command;

  if (!command.targetPrUrl) {
    return warnings.length ? { ...withParentPrompts, verificationSetupWarnings: warnings } : withParentPrompts;
  }

  if (!host.env.DB || !host.env.REPOS_CACHE) {
    return {
      ...withParentPrompts,
      verificationSetupWarnings: [
        ...warnings,
        "Control-plane GitHub PR context fetch was skipped because required GitHub environment bindings are unavailable.",
      ],
    };
  }

  const ext = doDb.getSessionExtended(sql, session.sessionId);
  try {
    return {
      ...withParentPrompts,
      ...(warnings.length ? { verificationSetupWarnings: warnings } : {}),
      verificationPrContext: await fetchVerificationPrContext(
        host.env as Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "REPOS_CACHE">,
        command.targetPrUrl,
        {
          installationId: ext?.installationId ?? null,
          repoOwner: ext?.repoOwner ?? null,
          repoName: ext?.repoName ?? null,
          requireRepoMatch: true,
        },
      ),
    };
  } catch (error) {
    const warning = `Control-plane GitHub PR context fetch failed for ${command.targetPrUrl}: ${String(error)}`;
    host.log.warn(
      {
        event: "verification_pr_context_fetch_failed",
        sessionId: session.sessionId,
        promptId: prompt.promptId,
        targetPrUrl: command.targetPrUrl,
        error: String(error),
      },
      "Verification PR context fetch failed; dispatching setup warning",
    );
    return {
      ...withParentPrompts,
      verificationSetupWarnings: [...warnings, warning],
    };
  }
}

export function derivePromptBranchNameHint(promptText: string): string | undefined {
  const titleCandidate = derivePromptTitleCandidate(promptText);
  if (!titleCandidate) return undefined;
  const safeHint = buildSafeCycloidBranchHint(titleCandidate);
  return safeHint || undefined;
}

async function storeSlackCompletionSummary(
  host: Pick<SessionPromptQueueHost, "state">,
  events: SessionEvent[],
  promptId: string,
): Promise<void> {
  await host.state.storage.put(`slack_summary:${promptId}`, extractResponseFromEvents(events, promptId));
}

export function clonePromptForRetry(
  prompt: PromptState,
  promptId: string,
  timestamp: string,
  status: "queued" | "processing",
): PromptState {
  return {
    promptId,
    prompt: prompt.prompt,
    replyToText: prompt.replyToText ?? null,
    replyToQuoteSource: prompt.replyToQuoteSource ?? null,
    branchNameHint: prompt.branchNameHint,
    actorUserId: prompt.actorUserId,
    ...(prompt.agent ? { agent: prompt.agent } : {}),
    ...(prompt.reviewLoopEpochId ? { reviewLoopEpochId: prompt.reviewLoopEpochId } : {}),
    ...(prompt.reviewLoopSourceKind ? { reviewLoopSourceKind: prompt.reviewLoopSourceKind } : {}),
    ...(prompt.isPlanPrompt ? { isPlanPrompt: true } : {}),
    ...(prompt.planContext ? { planContext: prompt.planContext } : {}),
    ...pickAttachments(prompt),
    status,
    createdAt: timestamp,
    startedAt: status === "processing" ? timestamp : null,
    completedAt: null,
    updatedAt: timestamp,
    result: null,
    error: null,
  };
}

type PlanHandoffResult =
  | { kind: "none" }
  | {
      kind: "spliced";
      implementationPrompt: PromptState;
      promptEnqueuedEvent: DurableEntry;
    }
  | {
      kind: "parked";
      planPromptId: string;
      revision: number;
      valid: boolean;
      missingReason: string | null;
    };

export function emitPlanModeEvent(
  host: Pick<SessionPromptQueueHost, "env" | "log" | "waitUntil">,
  event:
    | "turn_ran"
    | "captured"
    | "handoff"
    | "fallback"
    | "research_reuse"
    | "parked"
    | "discussed"
    | "approved"
    | "time_to_approval"
    | "edited",
  fields: Record<string, unknown>,
): void {
  host.waitUntil(
    postStructuredEventToDd(host.env, {
      event: `arcanist.plan_mode.${event}`,
      ...fields,
    }).catch((error) => {
      host.log.warn({ event: `arcanist.plan_mode.${event}`, error: String(error) }, "plan_mode_metric_failed");
    }),
  );
}

function emitPlanModeResearchReuseEvent(input: {
  host: Pick<SessionPromptQueueHost, "env" | "log" | "waitUntil">;
  session: SessionState;
  implementationPrompt: PromptState;
  events: SessionEvent[];
  success: boolean;
}): void {
  const { host, session, implementationPrompt, events, success } = input;
  const planContext = implementationPrompt.planContext;
  if (!planContext) return;

  try {
    const projectedEvents = flattenSessionEvents(resolveAuthoritativePromptEvents(events));
    const counts = summarizePlanModeResearchReuse(projectedEvents);
    const durationMs =
      implementationPrompt.startedAt && implementationPrompt.completedAt
        ? Math.max(0, Date.parse(implementationPrompt.completedAt) - Date.parse(implementationPrompt.startedAt))
        : null;
    emitPlanModeEvent(host, "research_reuse", {
      sessionId: session.sessionId,
      planPromptId: planContext.planPromptId,
      implementationPromptId: implementationPrompt.promptId,
      outcome: success ? "success" : "failure",
      backend: session.agentRuntimeBackend ?? "unknown",
      env: host.env.WORKER_ENV ?? "unknown",
      discovery_ops: counts.discoveryOps,
      read_ops: counts.readOps,
      plan_files_touched: countPlanFilesToTouch(planContext.excerpt),
      excerpt_truncated: isPlanContextExcerptTruncated(planContext.excerpt),
      ...(durationMs !== null ? { duration_ms: durationMs } : {}),
    });
  } catch (error) {
    host.log.warn(
      {
        event: "arcanist.plan_mode.research_reuse",
        sessionId: session.sessionId,
        implementationPromptId: implementationPrompt.promptId,
        error: String(error),
      },
      "plan_mode_research_reuse_metric_failed",
    );
  }
}

function cloneImplementationPromptFromPlan(
  prompt: PromptState,
  promptId: string,
  timestamp: string,
  planContext: PlanContext,
): PromptState {
  return {
    promptId,
    prompt: planContext.valid ? "Implement the plan now." : prompt.prompt,
    replyToText: prompt.replyToText ?? null,
    replyToQuoteSource: prompt.replyToQuoteSource ?? null,
    branchNameHint: prompt.branchNameHint,
    actorUserId: prompt.actorUserId,
    ...pickAttachments(prompt),
    planContext,
    status: "queued",
    createdAt: timestamp,
    startedAt: null,
    completedAt: null,
    updatedAt: timestamp,
    result: null,
    error: null,
  };
}

function clonePlanDiscussionPrompt(input: {
  originalPrompt: PromptState;
  planPrompt: PromptState;
  promptId: string;
  discussionPrompt: string;
  replyToText: string;
  replyToQuoteSource: SlackQuotedReplySource | null;
  actorUserId: string | null;
  timestamp: string;
  planContext: PlanContext;
  skills?: string[];
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
}): PromptState {
  const { planPrompt } = input;
  const skills = [...new Set([...(planPrompt.skills ?? []), ...(input.skills ?? [])])];
  const files = [...new Set([...(planPrompt.files ?? []), ...(input.files ?? [])])];
  const uploadedFiles = [...(planPrompt.uploadedFiles ?? []), ...(input.uploadedFiles ?? [])];
  const uploadedImages = [...(planPrompt.uploadedImages ?? []), ...(input.uploadedImages ?? [])];
  return {
    promptId: input.promptId,
    prompt: [
      input.originalPrompt.prompt,
      "",
      "---",
      "",
      "Revise the current plan using this follow-up direction:",
      input.discussionPrompt,
    ].join("\n"),
    replyToText: input.replyToText,
    replyToQuoteSource: input.replyToQuoteSource,
    branchNameHint: input.originalPrompt.branchNameHint,
    actorUserId: input.actorUserId,
    ...(skills.length ? { skills } : {}),
    ...(files.length ? { files } : {}),
    ...(uploadedFiles.length ? { uploadedFiles } : {}),
    ...(uploadedImages.length ? { uploadedImages } : {}),
    isPlanPrompt: true,
    planContext: input.planContext,
    status: "queued",
    createdAt: input.timestamp,
    startedAt: null,
    completedAt: null,
    updatedAt: input.timestamp,
    result: null,
    error: null,
  };
}

function resolveOriginalPlanPrompt(prompts: PromptState[], planPrompt: PromptState): PromptState {
  let original = planPrompt;
  const visited = new Set<string>();
  while (original.planContext?.planPromptId && !visited.has(original.promptId)) {
    visited.add(original.promptId);
    const parent = prompts.find((candidate) => candidate.promptId === original.planContext?.planPromptId);
    if (!parent) break;
    original = parent;
  }
  return original;
}

type CapturedPlan = {
  planContext: PlanContext;
  revision: number;
  valid: boolean;
  missingReason: string | null;
};

async function captureAndPersistPlan(input: {
  host: SessionPromptQueueHost;
  sql: SqlStorage;
  session: SessionState;
  planPrompt: PromptState;
  timestamp: string;
  success: boolean;
}): Promise<CapturedPlan> {
  const { host, sql, session, planPrompt, timestamp, success } = input;
  let markdown: string | null = null;
  let valid = false;
  let missingReason: string | null = null;
  let missingHeadings: string[] = [];
  let artifactId: string | null = null;

  try {
    const finalResponse = extractResponseFromEvents(
      doDb.getEvents(sql, session.sessionId, { promptId: planPrompt.promptId }),
      planPrompt.promptId,
    );
    const redacted = truncatePlanText(redactVerificationPhaseOutputForPersistence(finalResponse.text));
    if (redacted.length > 0) {
      markdown = redacted;
      const validation = validatePlanMarkdown(redacted);
      valid = success && validation.valid;
      missingHeadings = validation.missingHeadings;
      missingReason = success
        ? validation.valid
          ? null
          : session.planApprovalRequired === true
            ? "invalid_plan"
            : (validation.reason ?? "invalid_plan")
        : "plan_prompt_failed";
    } else {
      missingReason = success ? "missing_final_response" : "plan_prompt_failed";
    }
  } catch (error) {
    missingReason = "plan_capture_failed";
    host.log.warn(
      {
        event: "plan_mode_capture_failed",
        sessionId: session.sessionId,
        promptId: planPrompt.promptId,
        error: String(error),
      },
      "Plan mode capture failed; continuing with an invalid persisted plan state",
    );
  }
  if (markdown && host.uploadPlanMarkdownArtifact) {
    try {
      artifactId = await host.uploadPlanMarkdownArtifact(session.sessionId, planPrompt.promptId, markdown);
    } catch (error) {
      host.log.warn(
        {
          event: "plan_mode_artifact_upload_failed",
          sessionId: session.sessionId,
          promptId: planPrompt.promptId,
          error: String(error),
        },
        "Plan mode artifact upload failed; continuing with captured plan context",
      );
    }
  }

  if (!valid) {
    emitPlanModeEvent(host, "fallback", {
      sessionId: session.sessionId,
      promptId: planPrompt.promptId,
      reason: missingReason ?? "invalid_plan",
    });
  }

  const planContext = buildPlanContext({
    markdown,
    artifactId,
    missingReason,
    planPromptId: planPrompt.promptId,
    valid,
  });
  const latestPlan = doDb.getLatestSessionPlan(sql, session.sessionId);
  const revision = Math.max(0, latestPlan?.revision ?? 0) + 1;
  doDb.upsertSessionPlan(sql, {
    sessionId: session.sessionId,
    planPromptId: planPrompt.promptId,
    implementationPromptId: null,
    markdown,
    excerpt: planContext.excerpt,
    artifactId,
    valid,
    missingReason,
    missingHeadings,
    status: session.planApprovalRequired === true ? "pending" : "none",
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  emitPlanModeEvent(host, "captured", {
    sessionId: session.sessionId,
    promptId: planPrompt.promptId,
    valid,
    artifactUploaded: artifactId !== null,
  });

  return {
    planContext,
    revision,
    valid,
    missingReason,
  };
}

async function maybeEnqueueImplementationAfterPlan(input: {
  host: SessionPromptQueueHost;
  sql: SqlStorage;
  session: SessionState;
  prompts: PromptState[];
  planPrompt: PromptState;
  timestamp: string;
  success: boolean;
}): Promise<PlanHandoffResult> {
  const { host, sql, session, prompts, planPrompt, timestamp, success } = input;
  if (!isPlanModePlanPrompt(session, planPrompt)) return { kind: "none" };

  const durationMs =
    planPrompt.startedAt && planPrompt.completedAt
      ? Math.max(0, Date.parse(planPrompt.completedAt) - Date.parse(planPrompt.startedAt))
      : null;
  emitPlanModeEvent(host, "turn_ran", {
    sessionId: session.sessionId,
    promptId: planPrompt.promptId,
    success,
    ...(durationMs !== null ? { duration_ms: durationMs } : {}),
  });

  const existingImplementationPrompt = prompts.find(
    (candidate) => candidate.planContext?.planPromptId === planPrompt.promptId,
  );
  if (existingImplementationPrompt) return { kind: "none" };

  const latestPlan = doDb.getLatestSessionPlan(sql, session.sessionId);
  if (session.planApprovalRequired === true && latestPlan?.status === "approved") {
    host.log.info(
      {
        event: "plan_mode_late_plan_turn_ignored",
        sessionId: session.sessionId,
        promptId: planPrompt.promptId,
        approvedRevision: latestPlan.revision,
      },
      "Ignored a late plan turn after approval",
    );
    return { kind: "none" };
  }

  const captured = await captureAndPersistPlan({ host, sql, session, planPrompt, timestamp, success });
  if (session.planApprovalRequired === true) {
    await host.onPlanApprovalParked({
      sessionId: session.sessionId,
      planPromptId: planPrompt.promptId,
      revision: captured.revision,
      valid: captured.valid,
      missingReason: captured.missingReason,
    });
    emitPlanModeEvent(host, "parked", {
      sessionId: session.sessionId,
      promptId: planPrompt.promptId,
      revision: captured.revision,
      valid: captured.valid,
      ...(captured.missingReason ? { missingReason: captured.missingReason } : {}),
    });
    return {
      kind: "parked",
      planPromptId: planPrompt.promptId,
      revision: captured.revision,
      valid: captured.valid,
      missingReason: captured.missingReason,
    };
  }

  const ext = doDb.getSessionExtended(sql, session.sessionId);
  const nextPromptCounter = Math.max(ext?.promptCounter ?? prompts.length, prompts.length) + 1;
  const implementationPrompt = cloneImplementationPromptFromPlan(
    planPrompt,
    `p-${nextPromptCounter}`,
    timestamp,
    captured.planContext,
  );
  const planPromptIndex = prompts.findIndex((candidate) => candidate.promptId === planPrompt.promptId);
  prompts.splice(planPromptIndex >= 0 ? planPromptIndex + 1 : prompts.length, 0, implementationPrompt);
  doDb.updateSessionFields(sql, session.sessionId, { promptCounter: nextPromptCounter });
  doDb.upsertSessionPlan(sql, {
    sessionId: session.sessionId,
    planPromptId: planPrompt.promptId,
    implementationPromptId: implementationPrompt.promptId,
    markdown: doDb.getLatestSessionPlan(sql, session.sessionId)?.markdown ?? null,
    excerpt: captured.planContext.excerpt,
    artifactId: captured.planContext.artifactId,
    valid: captured.valid,
    missingReason: captured.missingReason,
    missingHeadings: doDb.getLatestSessionPlan(sql, session.sessionId)?.missingHeadings ?? [],
    status: "none",
    revision: captured.revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  emitPlanModeEvent(host, "handoff", {
    sessionId: session.sessionId,
    planPromptId: planPrompt.promptId,
    implementationPromptId: implementationPrompt.promptId,
    valid: captured.valid,
  });

  return {
    kind: "spliced",
    implementationPrompt,
    promptEnqueuedEvent: {
      type: "prompt_enqueued",
      timestamp,
      data: { sessionId: session.sessionId, promptId: implementationPrompt.promptId, status: "queued" },
    },
  };
}

function isConcreteReviewLoopOwnerApprovalAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "chat about it" && normalized !== "something else";
}

function markQueuedPromptsFailed(
  prompts: PromptState[],
  reason: string,
  timestamp: string,
  excludeId?: string,
): number {
  let count = 0;
  for (const prompt of prompts) {
    if (prompt.status === "queued" && prompt.promptId !== excludeId) {
      prompt.status = "failed";
      prompt.error = reason;
      prompt.completedAt = timestamp;
      prompt.updatedAt = timestamp;
      count++;
    }
  }
  return count;
}

export function createSessionPromptQueue(host: SessionPromptQueueHost): SessionPromptQueue {
  function failQueuedPrompts(sessionId: string, reason: string, timestamp: string): number {
    const prompts = doDb.getPrompts(getSql(), sessionId);
    const failedCount = markQueuedPromptsFailed(prompts, reason, timestamp);
    if (failedCount > 0) doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    return failedCount;
  }

  function scheduleReviewLoopEpochProcessing(sessionId: string, prompt: PromptState): void {
    const epochId = typeof prompt.reviewLoopEpochId === "string" ? prompt.reviewLoopEpochId.trim() : "";
    if (!epochId || !host.markReviewLoopEpochProcessing) return;
    host.waitUntil(
      host.markReviewLoopEpochProcessing(sessionId, prompt.promptId, epochId).catch((error) => {
        host.log.warn(
          { sessionId, promptId: prompt.promptId, epochId, error: String(error) },
          "Failed to mark review-loop epoch processing",
        );
      }),
    );
  }
  /**
   * Awaited variant of scheduleReviewLoopEpochProcessing. The chained-next-prompt callback path
   * dispatches the prompt to the sandbox immediately after promoting it; if the enqueued→processing
   * D1 write were only scheduled (un-awaited), a fast `review_loop_reply` could reach the control
   * plane before the epoch flipped to `processing` and be rejected with
   * "epoch is not active for this prompt (enqueued)". Awaiting the write before sendToSandbox closes
   * that race (the same catch-up the sweep already performs for its enqueue path).
   */
  async function markReviewLoopEpochProcessingNow(sessionId: string, prompt: PromptState): Promise<void> {
    const epochId = typeof prompt.reviewLoopEpochId === "string" ? prompt.reviewLoopEpochId.trim() : "";
    if (!epochId || !host.markReviewLoopEpochProcessing) return;
    try {
      await host.markReviewLoopEpochProcessing(sessionId, prompt.promptId, epochId);
    } catch (error) {
      host.log.warn(
        { sessionId, promptId: prompt.promptId, epochId, error: String(error) },
        "Failed to mark review-loop epoch processing (awaited)",
      );
    }
  }
  /**
   * When a review-loop prompt reaches a terminal state without publishing (reply-only / no-op /
   * question-only turn), complete its owning epoch so it does not sit in enqueued/processing forever.
   * A prompt that published already drove the epoch to completed/publishing, so the DAO CAS no-ops.
   * Fired via waitUntil so the DO does not go idle before the D1 write lands.
   */
  function scheduleResolveReviewLoopEpochForTerminalPrompt(sessionId: string, prompt: PromptState): void {
    const epochId = typeof prompt.reviewLoopEpochId === "string" ? prompt.reviewLoopEpochId.trim() : "";
    if (!epochId || !host.resolveReviewLoopEpochForTerminalPrompt) return;
    host.waitUntil(
      host.resolveReviewLoopEpochForTerminalPrompt(sessionId, prompt.promptId, epochId).catch((error) => {
        host.log.warn(
          { sessionId, promptId: prompt.promptId, epochId, error: String(error) },
          "Failed to resolve review-loop epoch for terminal prompt",
        );
      }),
    );
  }
  function scheduleBlockReviewLoopEpochForUnrecoverablePrompt(
    sessionId: string,
    session: SessionState,
    prompt: PromptState,
    errorCode: ErrorCode | undefined,
  ): void {
    if (errorCode !== "codex_unrecoverable") return;
    const ext = doDb.getSessionExtended(getSql(), sessionId);
    if (isVerificationSession(session, ext)) return;
    const epochId = typeof prompt.reviewLoopEpochId === "string" ? prompt.reviewLoopEpochId.trim() : "";
    if (!epochId || !host.blockReviewLoopEpochForUnrecoverablePrompt) return;
    host.waitUntil(
      host.blockReviewLoopEpochForUnrecoverablePrompt(sessionId, prompt.promptId, epochId).catch((error) => {
        host.log.warn(
          { sessionId, promptId: prompt.promptId, epochId, error: String(error) },
          "Failed to block review-loop epoch after unrecoverable runtime failure",
        );
      }),
    );
  }
  function getSql(): SqlStorage {
    return host.state.storage.sql;
  }
  async function emitVerifierTerminalVerdictForPrompt(args: {
    db: D1Database;
    childSessionId: string;
    promptId: string;
    verifierResult: VerifierTerminalResult;
    exhausted: boolean;
  }): Promise<void> {
    // ARC-1330 §17-A RUN-ID ECHO (PR 47): the scheduler persisted the committed run token PER PROMPT
    // on THIS child DO's storage (`verification_run_id:<promptId>`). Both the initial comment-publish
    // path and the deferred retry path must echo it back to the parent FSM; otherwise a retry-success
    // can sync legacy verification state while the live spine remains in VERIFYING until its deadline.
    const coordinatorSessionId = await readVerificationCoordinatorSessionIdForPrompt(host, args.promptId);
    let shadowParentSessionId: string | null = null;
    try {
      const childRow = await getChildSessionRow(args.db, args.childSessionId);
      shadowParentSessionId = coordinatorSessionId ?? childRow?.parent_session_id ?? null;
    } catch {
      // best-effort parent resolve — the shadow emit is skipped if it fails.
    }
    if (!shadowParentSessionId) return;

    const echoedRunId =
      args.verifierResult.verificationRunId ?? (await readVerifierRunIdForPrompt(host, args.promptId));
    await shadowEmitVerifierTerminalVerdict(
      host.env as Env,
      shadowParentSessionId,
      echoedRunId === undefined ? args.verifierResult : { ...args.verifierResult, verificationRunId: echoedRunId },
      { exhausted: args.exhausted, waitUntil: (promise) => host.waitUntil(promise) },
      host.log,
    );
    // W11-P2 (ChatGPT P2, #6420): the terminal path's syncVerificationStateForPr ran BEFORE this
    // verdict-back committed, so its live label reconcile read the pre-verdict VERIFYING spine row.
    // Reconcile once more AFTER the commit so the post-verdict labels (verification-done /
    // verification-needs-work / review-loop:done) land immediately instead of waiting for the next
    // sweep tick. Off the response path + best-effort — the sweep remains the periodic self-heal.
    {
      const parentSessionId = shadowParentSessionId;
      host.waitUntil(
        (async () => {
          const { getPrCoordination } = await import("./pr-coordination-db.js");
          const rec = await getPrCoordination(args.db, parentSessionId);
          if (!rec?.prUrl) return;
          const { syncFsmLabelsForPr } = await import("../services/fsm-label-sync.js");
          await syncFsmLabelsForPr(host.env as Env, {
            prUrl: rec.prUrl,
            sessionId: parentSessionId,
            logger: host.log,
          });
        })().catch(() => undefined),
      );
    }
  }
  function markPlatformLlmPromptTerminal(sessionId: string, promptId: string): void {
    host.markPlatformLlmPromptTerminal?.(sessionId, promptId);
  }
  async function armPlatformLlmPostExecutionWindow(
    completion: PromptCompletion,
    completionSource: PromptCompletionSource,
    sessionId: string,
    promptId: string,
  ): Promise<PlatformLlmPostExecutionWindowResult | undefined> {
    if (!completion.success || completionSource === "post_execution_preclose") return undefined;
    return host.armPlatformLlmPostExecutionWindow?.(sessionId, promptId);
  }
  function shouldMarkPlatformLlmTerminal(
    completion: PromptCompletion,
    completionSource: PromptCompletionSource,
  ): boolean {
    return !completion.success || completionSource !== "execution_complete";
  }
  function getSessionId(): string | null {
    const rows = getSql().exec("SELECT session_id FROM session LIMIT 1").toArray();
    return rows.length > 0 ? (rows[0].session_id as string) : null;
  }
  function getHasPendingQuestion(promptId: string | null): boolean {
    if (!promptId) return false;
    return doDb.getPromptHasPendingQuestion(getSql(), promptId);
  }

  async function dispatchApprovedImplementation(session: SessionState, implementationPromptId: string): Promise<void> {
    const prompt = doDb.getPrompt(getSql(), implementationPromptId);
    const sandbox = doDb.getSandboxState(getSql(), session.sessionId);
    if (prompt?.status !== "processing" || sandbox?.pendingPromptDispatch !== true) return;

    const sandboxSocket = host.getSandboxSocket();
    const resume = getSandboxResumeState(sandbox);
    const shouldSendImplementationNow = Boolean(sandboxSocket) && !resume.stopped;
    const dispatchPath = resolvePromptDispatchPath(shouldSendImplementationNow, resume);
    if (shouldSendImplementationNow) {
      const command = await buildPromptCommandForDispatch(host, getSql(), prompt, session);
      await host.state.storage.delete([
        "company_memory_context",
        "company_memory_target_prompt",
        "company_memory_usage",
      ]);
      await host.setPendingPromptDispatch(false);
      await host.sendToSandbox(command);
      emitPromptQueueWaitEvent(host, session, prompt, dispatchPath);
      return;
    }

    const reconnectGraceDeadlineMs =
      sandbox?.status === "reconnecting" ? await host.getSandboxReconnectGraceDeadlineMs() : null;
    const shouldStartSpawn = shouldStartSpawnForAdmit({
      sandboxStatus: sandbox?.status,
      hasLiveSocket: false,
      reconnectGraceDeadlineMs,
      nowMs: Date.now(),
    });
    await storePromptDispatchPath(host.state, prompt.promptId, dispatchPath);
    if (!shouldStartSpawn) return;

    const operation = resume.paused
      ? resume.expired
        ? "spawnSandbox.resume.expired"
        : "spawnSandbox.resume.live"
      : resume.resumable
        ? "spawnSandbox.resume.cold"
        : "spawnSandbox.prompt";
    await host.startSpawnAttempt(session.sessionId, operation);
  }

  async function handlePlanApproveRequest(request: Request): Promise<Response> {
    const payload = (await parseJsonBody(request)) as Partial<ApproveSessionPlanRequest> | null;
    if (
      !payload ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision <= 0 ||
      typeof payload.actorUserId !== "string" ||
      payload.actorUserId.length === 0 ||
      (payload.source !== "web" && payload.source !== "slack")
    ) {
      return jsonErrorResponse("Invalid payload", 400);
    }

    const sid = getSessionId();
    const session = sid ? doDb.getSession(getSql(), sid) : null;
    if (!sid || !session) return jsonErrorResponse("Session not found", 404);

    const latestAtEntry = doDb.getLatestSessionPlan(getSql(), sid);
    if (latestAtEntry?.status === "pending") {
      const resume = getSandboxResumeState(doDb.getSandboxState(getSql(), sid));
      if (resume.stopped && resume.resumable) {
        const rateLimit = await host.checkSessionResumeRateLimit(sid, payload.actorUserId);
        if (rateLimit.limited) {
          return jsonErrorResponse("Resume is being retried too quickly. Please wait a moment and try again.", 429);
        }
      }
    }

    const timestamp = nowIso();
    const approvedAt = Date.now();
    const result = host.state.storage.transactionSync(() => {
      const latest = doDb.getLatestSessionPlan(getSql(), sid);
      if (!latest) return { ok: false as const, error: "plan_not_pending" };
      if (latest.revision !== payload.revision) return { ok: false as const, error: "stale_revision" };
      if (latest.status === "approved") {
        if (!latest.implementationPromptId) {
          return { ok: false as const, error: "approved_plan_missing_implementation" };
        }
        return {
          ok: true as const,
          idempotent: true,
          revision: latest.revision,
          implementationPromptId: latest.implementationPromptId,
          firstParkedAt: doDb.getFirstSessionPlanCreatedAt(getSql(), sid),
        };
      }
      if (latest.status !== "pending") return { ok: false as const, error: "plan_not_pending" };
      if (!latest.valid) return { ok: false as const, error: "plan_not_approvable" };

      const prompts = doDb.getPrompts(getSql(), sid);
      const runningDiscuss = prompts.find(
        (prompt) => prompt.status === "processing" && isPlanModePlanPrompt(session, prompt),
      );
      if (runningDiscuss) return { ok: false as const, error: "discuss_turn_running" };

      for (const prompt of prompts) {
        if (prompt.status !== "queued" || !prompt.isPlanPrompt) continue;
        prompt.status = "failed";
        prompt.error = "Superseded by plan approval";
        prompt.completedAt = timestamp;
        prompt.updatedAt = timestamp;
      }

      const planPrompt = prompts.find((prompt) => prompt.promptId === latest.planPromptId);
      if (!planPrompt) return { ok: false as const, error: "plan_prompt_not_found" };
      const extended = doDb.getSessionExtended(getSql(), sid);
      const nextPromptCounter = Math.max(extended?.promptCounter ?? prompts.length, prompts.length) + 1;
      const implementationPrompt = cloneImplementationPromptFromPlan(planPrompt, `p-${nextPromptCounter}`, timestamp, {
        planPromptId: latest.planPromptId,
        valid: latest.valid,
        excerpt: latest.excerpt,
        artifactId: latest.artifactId,
        missingReason: latest.missingReason,
        revision: latest.revision,
        userEdited: latest.userEdited,
      });
      const planPromptIndex = prompts.findIndex((prompt) => prompt.promptId === latest.planPromptId);
      prompts.splice(planPromptIndex >= 0 ? planPromptIndex + 1 : prompts.length, 0, implementationPrompt);
      const hasProcessingPrompt = prompts.some((prompt) => prompt.status === "processing");
      if (!hasProcessingPrompt) {
        implementationPrompt.status = "processing";
        implementationPrompt.startedAt = timestamp;
        implementationPrompt.updatedAt = timestamp;
      }
      doDb.bulkUpdatePrompts(getSql(), sid, prompts);
      doDb.updateSessionFields(getSql(), sid, { promptCounter: nextPromptCounter });
      if (implementationPrompt.status === "processing") {
        doDb.updateSandboxState(getSql(), sid, { pendingPromptDispatch: true });
      }
      const approved = doDb.updateSessionPlanStatus(getSql(), {
        sessionId: sid,
        planPromptId: latest.planPromptId,
        status: "approved",
        approvedBy: payload.actorUserId,
        approvedAt,
        implementationPromptId: implementationPrompt.promptId,
        source: payload.source,
      });
      if (!approved) throw new Error("Plan approval row disappeared during transaction");
      return {
        ok: true as const,
        idempotent: false,
        revision: latest.revision,
        implementationPromptId: implementationPrompt.promptId,
        implementationStarted: implementationPrompt.status === "processing",
        firstParkedAt: doDb.getFirstSessionPlanCreatedAt(getSql(), sid),
      };
    });

    if (!result.ok) return jsonResponse({ ok: false, error: result.error }, 409);

    if (!result.idempotent) {
      emitPlanModeEvent(host, "approved", {
        sessionId: sid,
        planPromptId: latestAtEntry?.planPromptId ?? null,
        implementationPromptId: result.implementationPromptId,
        revision: result.revision,
        source: payload.source,
      });
      const firstParkedAtMs = result.firstParkedAt ? Date.parse(result.firstParkedAt) : Number.NaN;
      if (Number.isFinite(firstParkedAtMs)) {
        emitPlanModeEvent(host, "time_to_approval", {
          sessionId: sid,
          revision: result.revision,
          duration_ms: Math.max(0, approvedAt - firstParkedAtMs),
        });
      }
    }

    await host.onPlanApprovalApproved(sid);

    if (!result.idempotent) {
      const eventEntries: DurableEntry[] = [
        {
          type: "prompt_enqueued",
          timestamp,
          data: { sessionId: sid, promptId: result.implementationPromptId, status: "queued" },
        },
      ];
      if (result.implementationStarted) {
        eventEntries.push({
          type: "prompt_processing",
          timestamp,
          data: { sessionId: sid, promptId: result.implementationPromptId, status: "processing" },
        });
      }
      await host.appendAndMirrorEvents(sid, eventEntries);
      if (result.implementationStarted) {
        await host.notePromptTransition(sid, result.implementationPromptId);
        await host.schedulePromptExecutionAlarm();
      }
    }

    await dispatchApprovedImplementation(session, result.implementationPromptId);
    return jsonResponse({
      ok: true,
      revision: result.revision,
      implementationPromptId: result.implementationPromptId,
      idempotent: result.idempotent,
    });
  }

  async function handlePromptEnqueueRequest(request: Request): Promise<Response> {
    // Enqueue-receipt clock for the resume-latency measure on prompt_admit_decision
    // (receipt -> dispatch decision). Live dispatch is near-zero; a cold/warm spawn
    // includes the synchronous pre-dispatch work. Captured first so nothing before
    // the admit decision is excluded from the delta.
    const enqueueReceivedAt = Date.now();
    // Post-stop attribution: read the live-idle user-stop flag BEFORE the admit
    // clears it (PR-2 clears at the notePromptTransition promotion chokepoint, which
    // can run before/around the decisionLog). Captured at entry avoids that race.
    const resumedAfterStop = host.isUserStopped();
    const payload = (await parseJsonBody(request)) as Partial<EnqueueSessionPromptRequest> | null;
    if (payload?.prompt != null && typeof payload.prompt !== "string") {
      return jsonErrorResponse("Prompt must be a string", 400);
    }
    const promptText = asNonEmptyString(payload?.prompt) ?? "";
    const hasSkills = Array.isArray(payload?.skills) && payload.skills.some((skill) => asNonEmptyString(skill));
    if (!payload || (!promptText && !hasSkills)) {
      return jsonErrorResponse("Missing prompt", 400);
    }
    if (payload.source != null && payload.source !== "web" && payload.source !== "slack") {
      return jsonErrorResponse("Invalid prompt source", 400);
    }
    const actorUserId = payload.actorUserId == null ? null : normalizePromptActorUserId(payload.actorUserId);
    if (payload.actorUserId != null && !actorUserId) {
      return jsonErrorResponse("Invalid actorUserId", 400);
    }

    const sid = getSessionId();
    if (!sid) {
      return jsonErrorResponse("Session not found", 404);
    }
    const session = doDb.getSession(getSql(), sid);
    if (!session) {
      return jsonErrorResponse("Session not found", 404);
    }
    if (session.status === "archived") {
      return jsonResponse({ error: PROMPT_SEND_BLOCKED_ERROR, reason: "archived" }, 409);
    }

    const prompts = doDb.getPrompts(getSql(), sid);
    const extended = doDb.getSessionExtended(getSql(), sid);
    const latestPlan = doDb.getLatestSessionPlan(getSql(), sid);
    const pendingPlan = latestPlan?.status === "pending" ? latestPlan : null;
    const pendingPlanPrompt = pendingPlan
      ? (prompts.find((candidate) => candidate.promptId === pendingPlan.planPromptId) ?? null)
      : null;
    if (pendingPlan && !pendingPlanPrompt) {
      host.log.warn(
        {
          event: "plan_mode.discuss_attempt",
          sessionId: sid,
          revision: pendingPlan.revision,
          source: session.callbackContext?.source ?? "web",
          outcome: "plan_prompt_not_found",
        },
        "Plan discussion rejected",
      );
      return jsonResponse({ error: PROMPT_SEND_BLOCKED_ERROR, reason: "plan_prompt_not_found" }, 409);
    }
    const promptCounterValue = extended?.promptCounter ?? 0;
    const promptCounter =
      Number.isFinite(promptCounterValue) && promptCounterValue >= 0 ? promptCounterValue : prompts.length;
    const activePromptIdFromDb = doDb.getActiveProcessingPromptId(getSql(), sid);
    const sandboxState = doDb.getSandboxState(getSql(), sid);

    // Canonical eligibility gate. Every enqueue caller (UI routes, webhook
    // handlers, MCP, CLI) hits this point, so the rule for archived /
    // blocked / failed / finalizing is enforced once. `stopped` is handled by
    // the existing `validatePromptEnqueueResumeState` below, which has runtime
    // awareness of paused-E2B resumability that the phase-only helper lacks
    // (e.g. user-stopped + paused E2B is still cold-resumable for an enqueue).
    const phaseInfo = derivePhaseInfoFromSql(
      getSql(),
      session,
      sandboxState,
      extended?.publishStatus ?? "not_started",
      activePromptIdFromDb,
      // A review_listening session (shipped its PR, watching for review feedback)
      // must derive `review_listening`, not the publish-driven fallback. Dropping
      // this let a round-1 publish-guard block (e.g. a head-change race) surface
      // as a publish-driven terminal phase, which rejected the next review round's
      // enqueue with `session_not_sendable`/`blocked` and paused the PR forever.
      extended?.reviewListeningActive ?? false,
      host.isUserStopped(),
    );
    if (
      phaseInfo.phase !== "stopped" &&
      isPromptSendDisabled(phaseInfo.phase, phaseInfo.stopMode, phaseInfo.sandboxSubstate, false)
    ) {
      host.log.info({ event: "prompt_send_blocked", sessionId: sid, reason: phaseInfo.phase }, "prompt_send_blocked");
      return jsonResponse({ error: PROMPT_SEND_BLOCKED_ERROR, reason: phaseInfo.phase }, 409);
    }
    const wasCompletedBeforeEnqueue = phaseInfo.phase === "completed";
    const activePromptFromDb = activePromptIdFromDb
      ? prompts.find((candidate) => candidate.promptId === activePromptIdFromDb)
      : null;
    const staleActivePromptId =
      typeof activePromptIdFromDb === "string" && (!activePromptFromDb || isPromptTerminal(activePromptFromDb))
        ? activePromptIdFromDb
        : null;
    const effectiveActivePromptIdFromDb = staleActivePromptId ? null : activePromptIdFromDb;
    if (staleActivePromptId) {
      await host.notePromptTransition(session.sessionId, null);
    }
    // ARC-1196 zombie-socket guard: an open socket whose bridge heartbeat is
    // past the liveness bound is a dead VM behind a live edge connection.
    // Discard that transport (finalize stop + suppressed close) BEFORE resume
    // state is computed, so this enqueue admits against a stopped sandbox and
    // takes the existing cold-resume path instead of dispatching into the
    // void. Skipped while a prompt is actively processing: that transport
    // belongs to the liveness watchdog, not the enqueue path.
    const heartbeat = host.getSandboxSocket() ? await host.getSandboxHeartbeatFreshness() : null;
    const socketFresh = heartbeat?.fresh ?? false;
    let sandboxStateForAdmit = sandboxState;
    if (heartbeat && !heartbeat.fresh && !effectiveActivePromptIdFromDb) {
      await host.discardStaleSandboxTransport(sid, "stale heartbeat at prompt dispatch");
      sandboxStateForAdmit = doDb.getSandboxState(getSql(), sid);
    }
    const resume = getSandboxResumeState(sandboxStateForAdmit);
    const isReviewLoopEnqueue =
      typeof payload.reviewLoopEpochId === "string" && payload.reviewLoopEpochId.trim().length > 0;
    const enqueueValidation = validatePromptEnqueueResumeState(
      effectiveActivePromptIdFromDb,
      resume,
      isReviewLoopEnqueue,
    );
    if (!enqueueValidation.ok) {
      return jsonResponse({ error: PROMPT_SEND_BLOCKED_ERROR, reason: enqueueValidation.reason }, 409);
    }
    const isResumableSend = enqueueValidation.isResumableSend;
    if (isResumableSend) {
      const actorForResume = request.headers.get("x-auth-user-id") || actorUserId || session.ownerUserId;
      const rateLimit = await host.checkSessionResumeRateLimit(sid, actorForResume);
      if (rateLimit.limited) {
        return jsonErrorResponse("Resume is being retried too quickly. Please wait a moment and try again.", 429);
      }
    }

    // Persisting only updates D1; it does NOT refresh the in-memory `extended`, so
    // capture the resolved context locally for the branch-name prefix below.
    let effectiveLinearContext = extended?.linearContext ?? null;
    if (!effectiveLinearContext) {
      const extracted = extractLinearContextFromPrompt(promptText);
      if (extracted) {
        doDb.updateSessionFields(getSql(), sid, { linearContext: extracted });
        effectiveLinearContext = extracted;
      }
    }

    const agentName = pendingPlan ? undefined : typeof payload.agent === "string" ? payload.agent : undefined;
    if (agentName) {
      const resolvedAgents = extended?.resolvedAgents ?? undefined;
      const validNames = getValidAgentNames(resolvedAgents as Parameters<typeof getValidAgentNames>[0]);
      if (!validNames.has(agentName)) {
        return jsonErrorResponse(`Invalid agent: ${agentName}`, 400);
      }
    }
    const timestamp = nowIso();
    const skills = Array.isArray(payload.skills)
      ? [
          ...new Set(
            payload.skills
              .filter((skill): skill is string => typeof skill === "string")
              .map((skill) => skill.trim())
              .filter((skill) => skill.length > 0),
          ),
        ]
      : undefined;
    const files = Array.isArray(payload.files) ? (payload.files as string[]) : undefined;
    const uploads = parsePromptUploads(payload, promptText);
    if (!uploads.ok) return uploads.response;
    const { uploadedFiles, uploadedImages } = uploads;
    const reviewLoopEpochId = typeof payload.reviewLoopEpochId === "string" ? payload.reviewLoopEpochId.trim() : "";
    if (payload.reviewLoopEpochId != null && !reviewLoopEpochId) {
      return jsonErrorResponse("Invalid reviewLoopEpochId", 400);
    }
    // Atomic epoch->prompt dedupe (the prompt<->epoch binding lives here in the DO
    // SQLite, not in D1). The review-loop sweep dispatches the prompt BEFORE it
    // marks the epoch enqueued; a crash in that window leaves the epoch `reserving`
    // and a re-sweep re-claims it and would mint a SECOND prompt for the same
    // epoch. Reject the duplicate and hand back the surviving prompt so the sweep
    // adopts it (binds the epoch) instead of running the agent twice.
    if (reviewLoopEpochId) {
      const existingEpochPrompt = prompts.find(
        (candidate) => candidate.reviewLoopEpochId === reviewLoopEpochId && !isPromptTerminal(candidate),
      );
      if (existingEpochPrompt) {
        host.log.info(
          {
            event: "review_loop_epoch_duplicate_prompt_rejected",
            sessionId: sid,
            reviewLoopEpochId,
            existingPromptId: existingEpochPrompt.promptId,
            existingPromptStatus: existingEpochPrompt.status,
          },
          "review_loop_epoch_duplicate_prompt_rejected",
        );
        return jsonResponse(
          {
            error: REVIEW_LOOP_EPOCH_ACTIVE_PROMPT_ERROR,
            reason: "duplicate_epoch_prompt",
            errorDetails: {
              existingPromptId: existingEpochPrompt.promptId,
              existingPromptStatus: existingEpochPrompt.status,
            },
          },
          409,
        );
      }
    }
    const validSourceKinds = new Set<string>(["bot", "human", "mixed", "merge_conflict"]);
    const reviewLoopSourceKind =
      typeof payload.reviewLoopSourceKind === "string" && validSourceKinds.has(payload.reviewLoopSourceKind)
        ? (payload.reviewLoopSourceKind as ReviewLoopPromptSourceKind)
        : undefined;
    // ARC-1330 §17-A (PR 47): the verifier run token — validated to a non-negative integer (0 is a
    // valid backfilled run id); a present-but-malformed value is rejected rather than silently
    // dropped (a dropped token would make the run's verdict unmatchable at live).
    const rawVerificationRunId = (payload as { verificationRunId?: unknown }).verificationRunId;
    const enqueueVerificationRunId =
      typeof rawVerificationRunId === "number" && Number.isInteger(rawVerificationRunId) && rawVerificationRunId >= 0
        ? rawVerificationRunId
        : undefined;
    if (rawVerificationRunId != null && enqueueVerificationRunId === undefined) {
      return jsonErrorResponse("Invalid verificationRunId", 400);
    }
    const rawVerificationCoordinatorSessionId = (payload as { verificationCoordinatorSessionId?: unknown })
      .verificationCoordinatorSessionId;
    const enqueueVerificationCoordinatorSessionId =
      typeof rawVerificationCoordinatorSessionId === "string" ? rawVerificationCoordinatorSessionId.trim() : "";
    if (rawVerificationCoordinatorSessionId != null && !enqueueVerificationCoordinatorSessionId) {
      return jsonErrorResponse("Invalid verificationCoordinatorSessionId", 400);
    }
    const replyToQuoteSource =
      payload.replyToQuoteSource == null ? null : parseSlackQuotedReplySource(payload.replyToQuoteSource);
    if (payload.replyToQuoteSource != null && !replyToQuoteSource) {
      return jsonErrorResponse("Invalid replyToQuoteSource", 400);
    }
    const discussionSource =
      payload.source ?? (replyToQuoteSource || session.callbackContext?.source === "slack" ? "slack" : "web");
    const deterministicBranchNameHint = derivePromptBranchNameHint(promptText);
    let generatedBranchNameHint: string | undefined;
    if (promptCounter === 0) {
      const preparedTitlePromise = host
        .prepareSessionTitle(promptText, {
          sessionId: sid,
          promptId: `p-${promptCounter + 1}`,
          businessId: session.businessId,
          ownerUserId: session.ownerUserId,
          repoOwner: extended?.repoOwner ?? null,
          repoName: extended?.repoName ?? null,
        })
        .catch((error) => {
          host.log.warn(
            { errorMessage: String(error), sessionId: sid, promptCounter },
            "Prepared title generation failed; using deterministic branch fallback",
          );
          return null;
        });
      const preparedTitle = await waitForPreparedSessionTitleForEnqueue(preparedTitlePromise);
      try {
        generatedBranchNameHint = preparedTitle?.title
          ? buildSafeCycloidBranchHint(preparedTitle.title) || undefined
          : undefined;
      } catch (error) {
        host.log.warn(
          { errorMessage: String(error), sessionId: sid, promptCounter },
          "Prepared title generation failed; using deterministic branch fallback",
        );
      }
    }
    const computedBranchNameHint =
      promptCounter === 0 ? (generatedBranchNameHint ?? deterministicBranchNameHint) : deterministicBranchNameHint;
    // First prompt only: prepend the resolved Linear ticket key to the branch slug
    // (e.g. `arc-746-fix-the-thing`) so Linear auto-links the PR by branch name. The
    // bridge creates the branch from the first prompt's hint; follow-up prompts do not
    // recreate it. Validate the key in control-plane; the shared helper only composes.
    let branchNameHint = computedBranchNameHint;
    if (promptCounter === 0) {
      // The title LLM's ticketKey is persisted for PR title generation only.
      // Branch prefixes must come from deterministic prompt/session context so
      // they stay aligned with Linear auto-linking and session.ticket_key.
      const ticketKey =
        normalizeTicketKey(effectiveLinearContext?.identifier) ??
        normalizeTicketKey(extractLeadingTicketKey(promptText));
      if (ticketKey) {
        branchNameHint = prependTicketKeyToBranchHint(ticketKey.toLowerCase(), computedBranchNameHint);
      }
    }
    const replyToText = typeof payload.replyToText === "string" ? payload.replyToText.trim() || promptText : promptText;
    const prompt: PromptState =
      pendingPlan && pendingPlanPrompt
        ? clonePlanDiscussionPrompt({
            originalPrompt: resolveOriginalPlanPrompt(prompts, pendingPlanPrompt),
            planPrompt: pendingPlanPrompt,
            promptId: `p-${promptCounter + 1}`,
            discussionPrompt: promptText,
            replyToText,
            replyToQuoteSource,
            actorUserId,
            timestamp,
            planContext: {
              planPromptId: pendingPlan.planPromptId,
              valid: pendingPlan.valid,
              excerpt: pendingPlan.excerpt,
              artifactId: pendingPlan.artifactId,
              missingReason: pendingPlan.missingReason,
              revision: pendingPlan.revision,
              userEdited: pendingPlan.userEdited,
            },
            skills,
            files,
            uploadedFiles,
            uploadedImages,
          })
        : {
            promptId: `p-${promptCounter + 1}`,
            prompt: promptText,
            replyToText,
            branchNameHint,
            agent: agentName,
            actorUserId,
            ...(reviewLoopEpochId ? { reviewLoopEpochId } : {}),
            ...(reviewLoopSourceKind ? { reviewLoopSourceKind } : {}),
            ...pickAttachments({ skills, files, uploadedFiles, uploadedImages }),
            status: "queued",
            createdAt: timestamp,
            startedAt: null,
            completedAt: null,
            updatedAt: timestamp,
            result: null,
            error: null,
          };
    if (!pendingPlan && replyToQuoteSource) prompt.replyToQuoteSource = replyToQuoteSource;
    prompts.push(prompt);

    let activePromptId = effectiveActivePromptIdFromDb || null;
    let dispatch: DispatchContract | null = null;
    const hasPendingQuestion = getHasPendingQuestion(activePromptId);
    const sandboxSocket = host.getSandboxSocket();
    let shouldSendPromptNow = false;
    let shouldStartSpawn = false;
    let promptsPersisted = false;
    let shouldEmitColdResume = false;
    let dispatchPath: PromptDispatchPath = "live";

    if (activePromptId && sandboxSocket && hasPendingQuestion) {
      await host.setHasPendingQuestion(false);
      await host.sendToSandbox({ type: "stop", messageId: activePromptId });
    }

    if (!activePromptId) {
      prompt.status = "processing";
      prompt.startedAt = timestamp;
      prompt.updatedAt = timestamp;
      activePromptId = prompt.promptId;
      // NOTE: the live-idle user-stop flag is cleared at the single promotion chokepoint
      // host.notePromptTransition(sessionId, <non-null>) (called at :2636 below and on every
      // other promotion path incl. the queue drain), not here — see durable-object.ts.
      shouldSendPromptNow = Boolean(sandboxSocket) && !resume.stopped && socketFresh;
      if (!shouldSendPromptNow) {
        const currentSandboxStatus = sandboxStateForAdmit?.status;
        // A no-socket `reconnecting` row whose runtime is dead (grace lapsed or
        // killed) must spawn fresh, not wedge waiting for a reconnect that will
        // never arrive. Only an unexpired reconnect-grace deadline still warrants
        // waiting. See shouldStartSpawnForAdmit.
        const reconnectGraceDeadlineMs =
          currentSandboxStatus === "reconnecting" ? await host.getSandboxReconnectGraceDeadlineMs() : null;
        shouldStartSpawn = shouldStartSpawnForAdmit({
          sandboxStatus: currentSandboxStatus,
          hasLiveSocket: Boolean(sandboxSocket) && socketFresh,
          reconnectGraceDeadlineMs,
          nowMs: Date.now(),
        });
        dispatch = buildSandboxCallbackContract(
          session.sessionId,
          prompt,
          await host.generatePromptCallbackAuth(session.sessionId, prompt.promptId),
          session.model ?? null,
        );
      }

      // Structured trace of the admit-decision so a stuck "processing" prompt can be
      // diagnosed from logs alone. When neither shouldSendPromptNow nor shouldStartSpawn
      // is true the prompt was admitted with no scheduled work -- we rely on the spawn
      // already in flight (or the prompt-execution alarm) to make progress. If that
      // path is broken the prompt stalls silently; this warn is the breadcrumb to find.
      const decision: "send_now" | "start_spawn" | "wait_for_inflight_spawn" = shouldSendPromptNow
        ? "send_now"
        : shouldStartSpawn
          ? "start_spawn"
          : "wait_for_inflight_spawn";
      // Live/warm/cold dispatch measurement. `spawn_path` is structurally locked to
      // "cold" (SpawnPath = "cold"), so warm/live reuse was previously unmeasured.
      // `send_now` dispatches into the already-live agent (no spawn) => "live". A
      // spawn is a warm E2B resume exactly when the runtime is paused and unexpired
      // (`resume.paused && !resume.expired`, i.e. operation "spawnSandbox.resume.live");
      // every other spawn (cold resume, expired retention, fresh prompt) is a cold create.
      dispatchPath = resolvePromptDispatchPath(shouldSendPromptNow, resume);
      const reviewLoopTurn = typeof prompt.reviewLoopEpochId === "string" && prompt.reviewLoopEpochId.length > 0;
      const reviewLoopSourceKind = reviewLoopTurn ? (prompt.reviewLoopSourceKind ?? "unknown") : null;
      const decisionLog = {
        event: "prompt_admit_decision",
        sessionId: session.sessionId,
        promptId: prompt.promptId,
        decision,
        dispatch_path: dispatchPath,
        review_loop_turn: reviewLoopTurn,
        review_loop_epoch_id: prompt.reviewLoopEpochId ?? null,
        review_loop_source_kind: reviewLoopSourceKind,
        resume_latency_ms: Date.now() - enqueueReceivedAt,
        resumed_after_stop: resumedAfterStop,
        provider: sandboxStateForAdmit?.runtimeProvider ?? null,
        runtime_backend: sandboxStateForAdmit?.runtimeBackend ?? null,
        hasSandboxSocket: Boolean(sandboxSocket),
        socketFresh,
        socketHeartbeatAgeMs: heartbeat?.ageMs ?? null,
        sandboxStatus: sandboxStateForAdmit?.status ?? null,
        sandboxRuntimeState: sandboxStateForAdmit?.runtimeState ?? null,
        sandboxStopReason: sandboxStateForAdmit?.stopReason ?? null,
        sandboxRuntimeProvider: sandboxStateForAdmit?.runtimeProvider ?? null,
        sandboxRuntimeSandboxId: sandboxStateForAdmit?.runtimeSandboxId ?? null,
        resumeStopped: resume.stopped,
        resumePaused: resume.paused,
        resumeExpired: resume.expired,
        resumeResumable: resume.resumable,
        isResumableSend,
      };
      if (decision === "wait_for_inflight_spawn") {
        host.log.warn(decisionLog, "prompt_admit_decision");
      } else {
        host.log.info(decisionLog, "prompt_admit_decision");
      }
      // ARC-1196: direct-post the admit decision so it stays queryable in
      // Datadog even when Workers Logs/logpush is unavailable — this exact
      // data was missing from the zombie-socket investigation. Detached via
      // waitUntil so a Datadog outage never slows dispatch; metadata only.
      host.waitUntil(postStructuredEventToDd(host.env, decisionLog));
    }

    const eventEntries: DurableEntry[] = [
      {
        type: "prompt_enqueued",
        timestamp,
        data: { sessionId: session.sessionId, promptId: prompt.promptId, status: "queued" },
      },
    ];
    if (prompt.status === "processing") {
      shouldEmitColdResume = isResumableSend && (!resume.paused || resume.expired);
      if (shouldEmitColdResume) {
        // Emit on cold-restart trigger so the UI can show the "sandbox was rebuilt"
        // banner immediately. Includes the snapshot id (if any) the worker had to
        // discard. The cold-spawn happens via the regular spawn flow that follows.
        eventEntries.push({
          type: "session_resumed_cold",
          timestamp,
          data: {
            reason: "prompt",
            promptId: prompt.promptId,
            lostSnapshotImageId: sandboxState?.snapshotImageId ?? null,
          },
        });
      }
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId: session.sessionId, promptId: prompt.promptId, status: "processing" },
      });
    }

    if (pendingPlan) {
      const committed = host.state.storage.transactionSync(() => {
        const latest = doDb.getLatestSessionPlan(getSql(), sid);
        if (
          latest?.status !== "pending" ||
          latest.planPromptId !== pendingPlan.planPromptId ||
          latest.revision !== pendingPlan.revision
        ) {
          return false;
        }
        if (
          !doDb.updateSessionPlanStatus(getSql(), {
            sessionId: sid,
            planPromptId: pendingPlan.planPromptId,
            status: "superseded",
          })
        ) {
          throw new Error("Pending plan disappeared during Discuss enqueue");
        }
        doDb.bulkUpdatePrompts(getSql(), sid, prompts);
        doDb.updateSessionFields(getSql(), sid, { promptCounter: promptCounter + 1 });
        if (prompt.status === "processing") {
          doDb.updateSandboxState(getSql(), sid, { pendingPromptDispatch: true });
        }
        return true;
      });
      if (!committed) {
        host.log.info(
          {
            event: "plan_mode.discuss_attempt",
            sessionId: sid,
            promptId: prompt.promptId,
            revision: pendingPlan.revision,
            source: discussionSource,
            outcome: "plan_state_changed",
          },
          "Plan discussion rejected",
        );
        return jsonResponse({ error: PROMPT_SEND_BLOCKED_ERROR, reason: "plan_state_changed" }, 409);
      }
      promptsPersisted = true;
      await host.onPlanApprovalDiscussion({
        sessionId: sid,
        planPromptId: pendingPlan.planPromptId,
        revision: pendingPlan.revision,
        promptId: prompt.promptId,
      });
      emitPlanModeEvent(host, "discussed", {
        sessionId: sid,
        planPromptId: pendingPlan.planPromptId,
        promptId: prompt.promptId,
        revision: pendingPlan.revision,
        source: discussionSource,
      });
      host.log.info(
        {
          event: "plan_mode.discuss_attempt",
          sessionId: sid,
          promptId: prompt.promptId,
          revision: pendingPlan.revision,
          source: discussionSource,
          outcome: "accepted",
        },
        "Plan discussion enqueued",
      );
    }

    const eventState = await host.appendAndMirrorEvents(session.sessionId, eventEntries);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    const shouldGenerateConciseTitle = !session.title && prompt.promptId === "p-1" && prompt.status === "processing";
    if (!session.title) {
      session.title = derivePromptTitleCandidate(prompt.prompt);
    }

    doDb.updateSession(getSql(), sid, { status: session.status, updatedAt: session.updatedAt, title: session.title });
    if (!promptsPersisted) {
      doDb.bulkUpdatePrompts(getSql(), sid, prompts);
      doDb.updateSessionFields(getSql(), sid, { promptCounter: promptCounter + 1 });
    }
    // ARC-1330 §17-A (PR 47): persist the verifier run token PER PROMPT so the post_execution
    // verdict-back can echo it (see verificationRunIdStorageKey). Stored right after the prompt row is
    // durable; a crash in between loses only the token — the verdict then fails toward NOT-fresh (B4),
    // never a token-less false accept.
    if (enqueueVerificationRunId !== undefined) {
      await host.state.storage.put(verificationRunIdStorageKey(prompt.promptId), enqueueVerificationRunId);
    }
    if (enqueueVerificationCoordinatorSessionId) {
      await host.state.storage.put(
        verificationCoordinatorSessionIdStorageKey(prompt.promptId),
        enqueueVerificationCoordinatorSessionId,
      );
    }

    if (prompt.status === "processing" && activePromptId) {
      scheduleReviewLoopEpochProcessing(session.sessionId, prompt);
      resetSpawnRetryOnSuccess({ sql: getSql(), sessionId: sid });
      await host.notePromptTransition(session.sessionId, activePromptId);
      if (shouldSendPromptNow) {
        const command = await buildPromptCommandForDispatch(host, getSql(), prompt, session);
        await host.setPendingPromptDispatch(false);
        await host.sendToSandbox(command);
        emitPromptQueueWaitEvent(host, session, prompt, dispatchPath);
      } else {
        await storePromptDispatchPath(host.state, prompt.promptId, dispatchPath);
        await host.setPendingPromptDispatch(true);
        if (shouldStartSpawn) {
          const operation = resume.paused
            ? resume.expired
              ? "spawnSandbox.resume.expired"
              : "spawnSandbox.resume.live"
            : isResumableSend
              ? "spawnSandbox.resume.cold"
              : "spawnSandbox.prompt";
          await host.startSpawnAttempt(session.sessionId, operation);
          if (shouldEmitColdResume) {
            host.log.info(
              {
                event: "session_resumed_cold",
                sessionId: session.sessionId,
                promptId: prompt.promptId,
                lostSnapshotImageId: sandboxState?.snapshotImageId ?? null,
              },
              "session_resumed_cold",
            );
          }
        }
      }
      if (shouldGenerateConciseTitle) {
        host.waitUntil(
          host
            .generateSessionTitle(session.sessionId, prompt.prompt, prompt.promptId)
            .catch((err) =>
              host.log.error({ sessionId: session.sessionId, error: String(err) }, "Session title generation failed"),
            ),
        );
      }
      await host.schedulePromptExecutionAlarm();
    }

    if (wasCompletedBeforeEnqueue) {
      host.log.info(
        {
          event: "completed_session_followup_prompt",
          sessionId: sid,
          promptId: prompt.promptId,
        },
        "completed_session_followup_prompt",
      );
    }

    return jsonResponse({
      ok: true,
      prompt: await toClientPromptWithActorProfile(
        host,
        prompt,
        sid,
        session.model ?? null,
        session.reasoningEffort ?? null,
        {
          includeUploadedImageData: true,
        },
      ),
      dispatch,
      queue: getQueueState(prompts, activePromptId),
      replay: eventState.replay,
      session,
    });
  }

  async function handlePromptCallbackRequest(request: Request): Promise<Response> {
    const payload = (await parseJsonBody(request)) as Partial<CompleteSessionPromptRequest> | null;
    if (!payload || typeof payload.promptId !== "string" || payload.promptId.length === 0) {
      return jsonErrorResponse("Missing promptId", 400);
    }

    const sid = getSessionId();
    if (!sid) {
      return jsonErrorResponse("Session not found", 404);
    }
    const session = doDb.getSession(getSql(), sid);
    if (!session) {
      return jsonErrorResponse("Session not found", 404);
    }

    const prompts = doDb.getPrompts(getSql(), sid);
    const prompt = prompts.find((candidate) => candidate.promptId === payload.promptId);
    if (!prompt) {
      return jsonErrorResponse("Prompt not found", 404);
    }

    let activePromptId = doDb.getActiveProcessingPromptId(getSql(), sid);
    if (activePromptId && activePromptId !== payload.promptId && prompt.status === "queued") {
      return jsonErrorResponse("Prompt is not currently processing", 409);
    }

    if (prompt.status === "completed" || prompt.status === "failed") {
      const replay = await host.getReplayState(sid);
      return jsonResponse({
        ok: true,
        completedPrompt: prompt,
        nextDispatch: null,
        nextPrompt: null,
        queue: getQueueState(prompts, activePromptId),
        replay,
        session,
      });
    }

    const timestamp = nowIso();
    const failed = payload.success === false || (typeof payload.error === "string" && payload.error.length > 0);
    prompt.status = failed ? "failed" : "completed";
    prompt.result = truncateDepth(payload.result ?? null);
    prompt.error = failed ? String(payload.error || "Sandbox execution failed") : null;
    prompt.errorDetails = null;
    prompt.completedAt = timestamp;
    prompt.updatedAt = timestamp;
    if (!prompt.startedAt) prompt.startedAt = timestamp;
    await host.setHasPendingQuestion(false);
    await host.setPendingPromptDispatch(false);

    const finalizedPromptId = prompt.promptId;
    const finalizeTelemetry = failed ? { errorCode: "sandbox_callback" as const, traceExpected: true } : undefined;
    await clearPromptMarkers(host.state, finalizedPromptId);

    if (activePromptId === payload.promptId) activePromptId = null;
    const finalizedWasPlanPrompt = isPlanModePlanPrompt(session, prompt);
    const planHandoff = await maybeEnqueueImplementationAfterPlan({
      host,
      sql: getSql(),
      session,
      prompts,
      planPrompt: prompt,
      timestamp,
      success: !failed,
    });

    let nextDispatch: DispatchContract | null = null;
    let nextPromptForResponse: PromptState | null = null;
    let shouldSendNextPromptNow = false;
    if (!activePromptId && planHandoff.kind !== "parked") {
      const nextPrompt = prompts.find((candidate) => candidate.status === "queued");
      if (nextPrompt) {
        nextPrompt.status = "processing";
        if (!nextPrompt.startedAt) nextPrompt.startedAt = timestamp;
        nextPrompt.updatedAt = timestamp;
        activePromptId = nextPrompt.promptId;
        shouldSendNextPromptNow = Boolean(host.getSandboxSocket());
        if (!shouldSendNextPromptNow) {
          nextDispatch = buildSandboxCallbackContract(
            session.sessionId,
            nextPrompt,
            await host.generatePromptCallbackAuth(session.sessionId, nextPrompt.promptId),
            session.model ?? null,
          );
        }
        nextPromptForResponse = nextPrompt;
      }
    }

    const eventEntries: DurableEntry[] = [
      {
        type: failed ? "prompt_failed" : "prompt_completed",
        timestamp,
        data: {
          sessionId: session.sessionId,
          promptId: prompt.promptId,
          status: prompt.status,
          error: prompt.error,
        },
      },
    ];
    if (planHandoff.kind === "spliced") {
      eventEntries.push(planHandoff.promptEnqueuedEvent);
    }
    if (nextPromptForResponse?.status === "processing") {
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId: session.sessionId, promptId: nextPromptForResponse.promptId, status: "processing" },
      });
    }

    const eventState = await host.appendAndMirrorEvents(session.sessionId, eventEntries);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;

    doDb.updateSession(getSql(), sid, { status: session.status, updatedAt: session.updatedAt, title: session.title });
    doDb.bulkUpdatePrompts(getSql(), sid, prompts);
    await host.notePromptTransition(session.sessionId, activePromptId);
    if (nextPromptForResponse) {
      await host.schedulePromptExecutionAlarm();
      if (shouldSendNextPromptNow) {
        // Await the enqueued→processing transition before dispatching so a fast review_loop_reply
        // from the chained prompt does not race a not-yet-`processing` epoch (#35).
        await markReviewLoopEpochProcessingNow(session.sessionId, nextPromptForResponse);
        const command = await buildPromptCommandForDispatch(host, getSql(), nextPromptForResponse, session);
        await host.setPendingPromptDispatch(false);
        await host.sendToSandbox(command);
        emitPromptQueueWaitEvent(host, session, nextPromptForResponse, "live");
      } else {
        // Not dispatching now (no socket); the sandbox will pull via the callback contract. Schedule
        // the transition in the background as before.
        scheduleReviewLoopEpochProcessing(session.sessionId, nextPromptForResponse);
        // The callback response can hand the next prompt straight back to the
        // live bridge even when the DO has no socket handle.
        emitPromptQueueWaitEvent(host, session, nextPromptForResponse, "live");
      }
    } else {
      // ARC-1196: do not wipe the alarm outright — the phase-independent
      // sandbox liveness deadline must survive prompt completion so an idle
      // zombie still converges. rescheduleSessionAlarm deletes the alarm
      // itself when no candidate deadline is valid (terminal sessions).
      await host.rescheduleSessionAlarm();
    }

    logDurablePromptCloseComplete(host, {
      sessionId: session.sessionId,
      promptId: finalizedPromptId,
      source: "prompt_callback",
      success: !failed,
      nextPromptId: activePromptId,
    });
    markPlatformLlmPromptTerminal(session.sessionId, finalizedPromptId);
    // Plan turns run terminal bookkeeping (usage record + telemetry finalize) like
    // any prompt — only the user-facing settle (Slack notification below) is
    // suppressed. The memory-review bot is skipped: a plan turn has no PR.
    schedulePromptTerminalSideEffects(host, {
      sessionId: session.sessionId,
      prompt,
      session,
      reason: "prompt_callback",
      writeUsageRecord: true,
      suppressMemoryReviewBot: finalizedWasPlanPrompt,
      completion: { success: !failed },
      finalize: { telemetry: finalizeTelemetry },
    });
    // A FAILED review-loop turn must NOT complete its epoch: completing it would silently treat the
    // review feedback as handled. Instead leave the epoch in-flight (enqueued/processing/publishing
    // with the in-flight lease set by markReviewLoopEpochEnqueued/Processing) so the stuck-epoch sweep
    // (reconcileStuckReviewLoopEpochs) reclaims and re-drives it once the lease expires, bounded by the
    // attempt cap. Only a SUCCESSFUL reply-only/no-op turn completes the epoch (handlePostExecution's
    // no-changes branch); a successful publishing turn drives it via the publish path.

    // Suppress the Slack mirror for review-loop follow-ups entirely (success or failure) — these
    // are automated review-loop turns the user did not initiate and should not surface in Slack.
    if (!activePromptId && !prompt?.reviewLoopEpochId && !finalizedWasPlanPrompt) {
      trackSlackThreadNotification(host, session.callbackContext, session.sessionId, finalizedPromptId, !failed);
    }

    return jsonResponse({
      ok: true,
      completedPrompt: prompt,
      nextDispatch,
      nextPrompt: nextPromptForResponse,
      queue: getQueueState(prompts, activePromptId),
      replay: eventState.replay,
      session,
    });
  }

  async function handleStopRequest(): Promise<Response> {
    const sid = getSessionId();
    if (!sid) {
      return jsonErrorResponse("Session not found", 404);
    }
    const session = doDb.getSession(getSql(), sid);
    if (!session) {
      return jsonErrorResponse("Session not found", 404);
    }
    await host.cancelPlanParkPause();

    if (!host.getSandboxSocket()) {
      const sbState = doDb.getSandboxState(getSql(), sid);
      if (sbState?.status === "reconnecting") {
        return jsonErrorResponse("Sandbox reconnecting, please retry", 409);
      }
      if (sbState?.status === "spawning") {
        return jsonErrorResponse("Sandbox spawning, please retry", 409);
      }
      // No socket and not transient → already idle/stopped. Return a structured
      // 409 instead of `200 { status: "already_stopped" }`: the old shape made
      // route + webhook callers indistinguishable from a successful stop and
      // hid the no-op from anything that watches HTTP status codes.
      return jsonResponse({ ok: false, error: STOP_BLOCKED_ERROR, reason: "already_stopped", sessionId: sid }, 409);
    }

    const prompts = doDb.getPrompts(getSql(), sid);
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sid);
    if (markQueuedPromptsFailed(prompts, "Stopped by user", nowIso()) > 0) {
      doDb.bulkUpdatePrompts(getSql(), sid, prompts);
    }

    const stopExt = doDb.getSessionExtended(getSql(), sid);
    const stopIsVerifier = isVerificationSession(session, stopExt);

    if (activePromptId) {
      await storePromptStoppedBy(host.state, activePromptId, "user");
      await host.sendToSandbox({ type: "stop", messageId: activePromptId });
      trackStoppedVerificationComment(host, getSql(), session, activePromptId, "manual_stop");
      // Active-prompt stop already leaves the sandbox live (only the turn is aborted). For a
      // non-verifier session, mark it live-idle so the aborted-prompt finalize surfaces "Stopped".
      if (!stopIsVerifier) {
        await host.stopSessionKeepAlive(session);
      }
      await host.onPlanApprovalStopped(sid);
      return jsonResponse({ ok: true, sessionId: session.sessionId, status: "stopping" });
    }

    if (stopIsVerifier) {
      // Decision #8: verifier sessions keep pausing so verification dedup (verification-gate) is
      // unaffected; users do not resume verifiers via this flow.
      await host.stopIdleSessionAtDurabilityBoundary(session, "user_stopped");
      trackStoppedVerificationComment(host, getSql(), session, "session-stopped", "manual_stop");
      await host.onPlanApprovalStopped(sid);
      return jsonResponse({ ok: true, sessionId: session.sessionId, status: "stopped" });
    }

    // Non-verifier idle stop: keep the sandbox live-idle (this IS the feature). No pause boundary.
    await host.stopSessionKeepAlive(session);
    trackStoppedVerificationComment(host, getSql(), session, "session-stopped", "manual_stop");
    await host.onPlanApprovalStopped(sid);
    return jsonResponse({ ok: true, sessionId: session.sessionId, status: "stopped" });
  }

  async function handleRespondRequest(request: Request): Promise<Response> {
    const payload = (await parseJsonBody(request)) as Partial<RespondToSessionRequest> | null;
    if (!payload || typeof payload.answer !== "string" || payload.answer.length === 0) {
      return jsonErrorResponse("Missing answer", 400);
    }

    const sid = getSessionId();
    if (!sid) {
      return jsonErrorResponse("Session not found", 404);
    }
    const session = doDb.getSession(getSql(), sid);
    if (!session) {
      return jsonErrorResponse("Session not found", 404);
    }

    if (!host.getSandboxSocket()) {
      const respondSbState = doDb.getSandboxState(getSql(), sid);
      if (respondSbState?.status === "reconnecting") {
        return jsonErrorResponse("Sandbox reconnecting, please retry", 409);
      }
      return jsonErrorResponse("No sandbox connected", 409);
    }

    const respondActivePromptId = doDb.getActiveProcessingPromptId(getSql(), sid);
    if (!getHasPendingQuestion(respondActivePromptId)) {
      return jsonErrorResponse("No pending question", 409);
    }

    const questionId = typeof payload.questionId === "string" ? payload.questionId : "";
    await host.setHasPendingQuestion(false);
    if (respondActivePromptId) {
      const activePrompt = doDb.getPrompt(getSql(), respondActivePromptId);
      const epochId = activePrompt?.reviewLoopEpochId?.trim();
      if (epochId && isConcreteReviewLoopOwnerApprovalAnswer(payload.answer)) {
        await host.markReviewLoopEpochOwnerApprovalResolved?.(session.sessionId, respondActivePromptId, epochId);
      }
    }
    // Persist the answer BEFORE sending so a `respond` frame dropped by a
    // mid-flight disconnect (or a DO eviction that races the send) still has a
    // durable record to redeliver on bridge reconnect via
    // sendPendingAnswerToSandbox. Ordering matters: if the send fired first and
    // the DO were evicted before this write committed, the frame would be gone
    // AND nothing would be persisted to redeliver. Without redelivery the bridge
    // stays blocked on `await answerPromise` forever: hasPendingQuestion was just
    // cleared, so the question is never replayed and a retry POST is rejected
    // with "No pending question". Keyed by promptId; cleared when that prompt
    // goes terminal. (9.3.)
    if (respondActivePromptId) {
      const pendingAnswer: PendingAnswerRecord = {
        promptId: respondActivePromptId,
        questionId,
        answer: payload.answer as string,
      };
      await host.state.storage.put(PENDING_ANSWER_STORAGE_KEY, pendingAnswer);
    }

    await host.sendToSandbox({ type: "respond", answer: payload.answer as string, requestId: questionId });

    if (questionId) {
      const answerEvent = {
        type: "answer",
        timestamp: nowIso(),
        data: { id: questionId, answer: payload.answer },
      };
      await host.appendAndMirrorEvents(session.sessionId, [answerEvent], respondActivePromptId ?? undefined);
    }

    return jsonResponse({ ok: true });
  }

  async function handleRetryRequest(): Promise<Response> {
    const sid = getSessionId();
    if (!sid) {
      return jsonErrorResponse("Session not found", 404);
    }
    const session = doDb.getSession(getSql(), sid);
    if (!session) {
      return jsonErrorResponse("Session not found", 404);
    }

    const archivedPhase = "archived";
    if (session.status === archivedPhase && !isRetryAvailable(archivedPhase)) {
      return jsonResponse({ ok: false, error: RETRY_BLOCKED_ERROR, reason: archivedPhase }, 409);
    }

    const retryExtended = doDb.getSessionExtended(getSql(), sid);
    const retrySandboxState = doDb.getSandboxState(getSql(), sid);
    const prompts = doDb.getPrompts(getSql(), sid);
    const retryPhaseInfo = derivePhaseInfoFromPromptSnapshot(
      getSql(),
      session,
      retrySandboxState,
      retryExtended?.publishStatus ?? "not_started",
      doDb.getActiveProcessingPromptId(getSql(), sid),
      prompts,
      retryExtended?.reviewListeningActive ?? false,
      host.isUserStopped(),
    );
    if (!isRetryAvailable(retryPhaseInfo.phase)) {
      return jsonResponse({ ok: false, error: RETRY_BLOCKED_ERROR, reason: retryPhaseInfo.phase }, 409);
    }

    // Idempotency guard: retry mints exactly one clone. A second retry racing
    // the first (double-click, replayed webhook, concurrent route call) finds
    // the clone active/queued and gets a 409 instead of a second clone — the
    // in-flight prompt already owns the recovery. This also rejects retry
    // while unrelated work is running; callers that want to queue more work
    // use the prompt-enqueue path, not retry.
    if (doDb.getActiveProcessingPromptId(getSql(), sid) || prompts.some((prompt) => prompt.status === "queued")) {
      return jsonResponse({ ok: false, error: RETRY_BLOCKED_ERROR, reason: "retry_in_progress" }, 409);
    }

    const lastTerminal = [...prompts]
      .reverse()
      .find((prompt) => prompt.status === "completed" || prompt.status === "failed");
    if (!lastTerminal) {
      return jsonErrorResponse("No completed or failed prompts to retry", 400);
    }

    const promptCounterValue = retryExtended?.promptCounter ?? 0;
    const promptCounter =
      Number.isFinite(promptCounterValue) && promptCounterValue >= 0 ? promptCounterValue : prompts.length;
    const timestamp = nowIso();
    const newPrompt = clonePromptForRetry(lastTerminal, `p-${promptCounter + 1}`, timestamp, "queued");
    prompts.push(newPrompt);

    let activePromptId = doDb.getActiveProcessingPromptId(getSql(), sid);
    let shouldSendRetryNow = false;
    let shouldStartRetrySpawn = false;
    let retryDispatchPath: PromptDispatchPath = "cold";
    if (!activePromptId) {
      newPrompt.status = "processing";
      newPrompt.startedAt = timestamp;
      newPrompt.updatedAt = timestamp;
      activePromptId = newPrompt.promptId;
      // ARC-1196 zombie-socket guard: retry is user/API-triggered like enqueue,
      // so socket presence alone does not prove the bridge is alive. Discard a
      // stale transport and fall through to the spawn path instead.
      const retryHeartbeat = host.getSandboxSocket() ? await host.getSandboxHeartbeatFreshness() : null;
      let retrySandboxStateForAdmit = retrySandboxState;
      if (retryHeartbeat && !retryHeartbeat.fresh) {
        await host.discardStaleSandboxTransport(sid, "stale heartbeat at prompt retry dispatch");
        retrySandboxStateForAdmit = doDb.getSandboxState(getSql(), sid);
      }
      shouldSendRetryNow = Boolean(host.getSandboxSocket()) && (retryHeartbeat?.fresh ?? false);
      if (!shouldSendRetryNow) {
        const currentSandboxStatus = retrySandboxStateForAdmit?.status;
        // Mirror the enqueue admit path: a dead `reconnecting` runtime (no socket,
        // grace lapsed/killed) spawns fresh instead of waiting forever.
        const reconnectGraceDeadlineMs =
          currentSandboxStatus === "reconnecting" ? await host.getSandboxReconnectGraceDeadlineMs() : null;
        shouldStartRetrySpawn = shouldStartSpawnForAdmit({
          sandboxStatus: currentSandboxStatus,
          hasLiveSocket: Boolean(host.getSandboxSocket()) && (retryHeartbeat?.fresh ?? false),
          reconnectGraceDeadlineMs,
          nowMs: Date.now(),
        });
      }
      retryDispatchPath = resolvePromptDispatchPath(
        shouldSendRetryNow,
        getSandboxResumeState(retrySandboxStateForAdmit),
      );
    }

    const eventEntries: DurableEntry[] = [
      {
        type: "prompt_enqueued",
        timestamp,
        data: { sessionId: session.sessionId, promptId: newPrompt.promptId, status: "queued" },
      },
    ];
    if (newPrompt.status === "processing") {
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId: session.sessionId, promptId: newPrompt.promptId, status: "processing" },
      });
    }

    const eventState = await host.appendAndMirrorEvents(session.sessionId, eventEntries);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    if (!session.title) {
      session.title = derivePromptTitleCandidate(newPrompt.prompt);
    }

    doDb.updateSession(getSql(), sid, { status: session.status, updatedAt: session.updatedAt, title: session.title });
    doDb.bulkUpdatePrompts(getSql(), sid, prompts);
    doDb.updateSessionFields(getSql(), sid, { promptCounter: promptCounter + 1 });

    if (newPrompt.status === "processing" && activePromptId) {
      resetSpawnRetryOnSuccess({ sql: getSql(), sessionId: sid });
      await host.notePromptTransition(session.sessionId, activePromptId);
      if (shouldSendRetryNow) {
        const command = await buildPromptCommandForDispatch(host, getSql(), newPrompt, session);
        await host.setPendingPromptDispatch(false);
        await host.sendToSandbox(command);
        emitPromptQueueWaitEvent(host, session, newPrompt, retryDispatchPath);
      } else {
        await storePromptDispatchPath(host.state, newPrompt.promptId, retryDispatchPath);
        await host.setPendingPromptDispatch(true);
        if (shouldStartRetrySpawn) {
          await host.startSpawnAttempt(session.sessionId, "spawnSandbox.retry");
        }
      }
      await host.schedulePromptExecutionAlarm();
    }

    return jsonResponse(
      {
        ok: true,
        prompt: newPrompt,
        status: newPrompt.status === "processing" ? "running" : "queued",
      },
      202,
    );
  }

  async function completeActivePrompt(
    sessionId: string,
    completion: PromptCompletion,
    expectedPromptId?: string,
    completionSource: PromptCompletionSource = "session_idle",
  ): Promise<void> {
    const session = doDb.getSession(getSql(), sessionId);
    const prompts = doDb.getPrompts(getSql(), sessionId);
    let activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);

    const activePrompt = activePromptId ? prompts.find((prompt) => prompt.promptId === activePromptId) : null;
    if (!activePrompt || activePrompt.status !== "processing" || !session) return;
    if (expectedPromptId && activePrompt.promptId !== expectedPromptId) return;

    const timestamp = nowIso();
    activePrompt.status = completion.success ? "completed" : "failed";
    activePrompt.error = completion.success ? null : (completion.error ?? "Execution failed");
    activePrompt.errorDetails = completion.success ? null : (completion.errorDetails ?? null);
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    doDb.updatePrompt(getSql(), activePrompt.promptId, { hasPendingQuestion: false });
    await host.setPendingPromptDispatch(false);
    const finalizedPromptId = activePrompt.promptId;
    const finalizeTelemetry =
      completion.success || completionSource === "execution_complete" || completion.errorCode || completion.errorDetails
        ? {
            ...(shouldMarkPromptTraceExpected(completion, completionSource) ? { traceExpected: true } : {}),
            ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
            ...(completion.errorDetails ? { errorDetails: completion.errorDetails } : {}),
          }
        : undefined;
    const finalizeContext = finalizeTelemetry
      ? await capturePromptFinalizeContextForPrompt(host, sessionId, finalizedPromptId)
      : undefined;
    await clearPromptMarkers(host.state, finalizedPromptId);

    activePromptId = null;
    const finalizedWasPlanPrompt = isPlanModePlanPrompt(session, activePrompt);
    const planHandoff = await maybeEnqueueImplementationAfterPlan({
      host,
      sql: getSql(),
      session,
      prompts,
      planPrompt: activePrompt,
      timestamp,
      success: completion.success,
    });

    const nextPrompt = planHandoff.kind === "parked" ? undefined : prompts.find((prompt) => prompt.status === "queued");
    let shouldSendNextPromptNow = false;
    let shouldStartNextSpawn = false;
    let nextPromptDispatchPath: PromptDispatchPath | null = null;
    if (nextPrompt) {
      nextPrompt.status = "processing";
      if (!nextPrompt.startedAt) nextPrompt.startedAt = timestamp;
      nextPrompt.updatedAt = timestamp;
      activePromptId = nextPrompt.promptId;
      shouldSendNextPromptNow = Boolean(host.getSandboxSocket());
      nextPromptDispatchPath = "live";
      if (!shouldSendNextPromptNow) {
        // Same-pattern audit (sandbox-death wedge): a promoted follow-up with no
        // transport would otherwise wait on the prompt-execution alarm against a
        // possibly-dead sandbox. Spawn fresh when the runtime is dead/missing;
        // keep waiting only for a genuine in-flight spawn/reconnect.
        const promotionSandboxState = doDb.getSandboxState(getSql(), sessionId);
        const promotionResume = getSandboxResumeState(promotionSandboxState);
        const promotionStatus = promotionSandboxState?.status;
        const reconnectGraceDeadlineMs =
          promotionStatus === "reconnecting" ? await host.getSandboxReconnectGraceDeadlineMs() : null;
        shouldStartNextSpawn = shouldStartSpawnForAdmit({
          sandboxStatus: promotionStatus,
          hasLiveSocket: false,
          reconnectGraceDeadlineMs,
          nowMs: Date.now(),
        });
        nextPromptDispatchPath = resolvePromptDispatchPath(false, promotionResume);
      }
    }

    // Persist terminal and queued-prompt promotion before rich-status projection.
    // Alarm retries must not see this prompt as still processing if D1 projection
    // fails inside setHasPendingQuestion(false), and projection must still see a
    // promoted follow-up prompt as running.
    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    await host.setHasPendingQuestion(false);
    if (!nextPrompt) {
      // A pushed branch may have arrived while this prompt was active. Retry
      // after the terminal write, when the publish slot is actually free.
      await maybeTriggerDeferredPrCreation(host, getSql(), sessionId, session.ownerUserId, prompts);
    }

    const completionClientErrorDetails = toClientErrorDetails(completion.errorDetails);
    const eventEntries: DurableEntry[] = [
      {
        type: completion.success ? "prompt_completed" : "prompt_failed",
        timestamp,
        data: {
          sessionId,
          promptId: activePrompt.promptId,
          status: activePrompt.status,
          error: activePrompt.error,
          ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
          ...(completionClientErrorDetails ? { errorDetails: completionClientErrorDetails } : {}),
          prompt: (await toClientPromptWithActorProfile(
            host,
            activePrompt,
            sessionId,
            session.model ?? null,
            session.reasoningEffort ?? null,
          )) as unknown as Record<string, unknown>,
        },
      },
    ];
    if (planHandoff.kind === "spliced") {
      eventEntries.push(planHandoff.promptEnqueuedEvent);
    }
    if (nextPrompt) {
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId, promptId: nextPrompt.promptId, status: "processing" },
      });
    }

    await host.appendAndMirrorEvents(sessionId, eventEntries);

    if (activePrompt.planContext || (!nextPrompt && !finalizedWasPlanPrompt)) {
      // Read events from SQL rather than eventState.events: appendAndMirrorEvents
      // passes includeEvents: false to avoid re-fetching after every append, so
      // eventState.events is always empty. Scoping by promptId keeps this cheap.
      const promptEvents = doDb.getEvents(getSql(), sessionId, { promptId: activePrompt.promptId });
      if (activePrompt.planContext) {
        emitPlanModeResearchReuseEvent({
          host,
          session,
          implementationPrompt: activePrompt,
          events: promptEvents,
          success: completion.success,
        });
      }
      if (!nextPrompt && !finalizedWasPlanPrompt) {
        await storeSlackCompletionSummary(host, promptEvents, activePrompt.promptId);
      }
    }

    await host.notePromptTransition(sessionId, activePromptId);
    if (nextPrompt) {
      await host.schedulePromptExecutionAlarm();
      if (shouldSendNextPromptNow) {
        const command = await buildPromptCommandForDispatch(host, getSql(), nextPrompt, session);
        await host.setPendingPromptDispatch(false);
        await host.sendToSandbox(command);
        emitPromptQueueWaitEvent(host, session, nextPrompt, nextPromptDispatchPath ?? "live");
      } else {
        // No live transport: mark the promoted prompt pending so it dispatches
        // once the sandbox is ready, whether we start a fresh spawn here (dead
        // runtime) or wait for an in-flight spawn/reconnect. Without this, the
        // wait path would leave pending_prompt_dispatch false and
        // sendPendingPromptToSandbox would skip it on reconnect, stalling it.
        if (nextPromptDispatchPath) {
          await storePromptDispatchPath(host.state, nextPrompt.promptId, nextPromptDispatchPath);
        }
        await host.setPendingPromptDispatch(true);
        if (shouldStartNextSpawn) {
          await host.startSpawnAttempt(sessionId, "spawnSandbox.promote");
        }
      }
    } else {
      // ARC-1196: do not wipe the alarm outright — the phase-independent
      // sandbox liveness deadline must survive prompt completion so an idle
      // zombie still converges. rescheduleSessionAlarm deletes the alarm
      // itself when no candidate deadline is valid (terminal sessions).
      await host.rescheduleSessionAlarm();
    }
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: completionSource,
      success: completion.success,
      nextPromptId: activePromptId,
    });
    const postExecutionWindowResult = await armPlatformLlmPostExecutionWindow(
      completion,
      completionSource,
      sessionId,
      finalizedPromptId,
    );
    if (
      postExecutionWindowResult === "terminalize" ||
      (postExecutionWindowResult === undefined && shouldMarkPlatformLlmTerminal(completion, completionSource))
    ) {
      markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    }
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt: activePrompt,
      session,
      reason: completionSource,
      writeUsageRecord: true,
      suppressMemoryReviewBot: finalizedWasPlanPrompt,
      completion: { success: completion.success },
      finalize: { telemetry: finalizeTelemetry, context: finalizeContext },
    });
    if (completion.errorCode) {
      doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode: completion.errorCode });
    }
    if (!completion.success) {
      scheduleBlockReviewLoopEpochForUnrecoverablePrompt(sessionId, session, activePrompt, completion.errorCode);
    }
    if (!completion.success && !activePromptId) {
      await handleStoppedVerificationOutcome(host, getSql(), session, finalizedPromptId, "unexpected_terminal");
    }
    // A codex_unrecoverable review-loop failure blocks its epoch immediately; every other failed turn
    // stays in-flight for lease-based reclaim. Successful turns resolve on publish or the no-changes path.
    // Suppress the Slack mirror for review-loop follow-ups entirely (success or failure) — these
    // are automated review-loop turns the user did not initiate and should not surface in Slack.
    if (!activePromptId && !activePrompt?.reviewLoopEpochId && !finalizedWasPlanPrompt) {
      trackSlackThreadNotification(host, session.callbackContext, sessionId, finalizedPromptId, completion.success);
    }
  }

  async function handleSessionIdle(
    event: Extract<SandboxEvent, { type: "session_idle" }>,
    sessionId: string,
  ): Promise<void> {
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    if (activePromptId !== event.messageId && (await recoverStalePromptCompletion("session_idle", event, sessionId))) {
      return;
    }

    await completeActivePrompt(sessionId, { success: true }, event.messageId, "session_idle");
  }

  async function handleExecutionComplete(
    event: Extract<SandboxEvent, { type: "execution_complete" }>,
    sessionId: string,
    telemetry?: PromptExecutionTelemetry,
  ): Promise<void> {
    let activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    if (
      event.success &&
      activePromptId !== event.messageId &&
      (await recoverStalePromptCompletion("execution_complete", event, sessionId, telemetry))
    ) {
      return;
    }

    const session = doDb.getSession(getSql(), sessionId);
    const prompts = doDb.getPrompts(getSql(), sessionId);

    const activePrompt = activePromptId ? prompts.find((prompt) => prompt.promptId === activePromptId) : null;
    if (!activePrompt || activePrompt.status !== "processing" || !session) return;
    if (activePrompt.promptId !== event.messageId) return;

    if (event.success) {
      const hasProgress = hasCompletionProgressContext(event.sessionEditCount, event.sessionPromptCount);
      if (!hasProgress && event.idleObserved !== false) return;
      await completeActivePrompt(sessionId, { success: true }, event.messageId, "execution_complete");
      return;
    }

    const timestamp = nowIso();
    activePrompt.status = "failed";
    activePrompt.result = null;
    activePrompt.error = event.error || "Sandbox execution failed";
    activePrompt.errorDetails = event.errorDetails ?? null;
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    await host.state.storage.delete(["company_memory_context", "company_memory_target_prompt", "company_memory_usage"]);
    await host.setHasPendingQuestion(false);
    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);
    activePromptId = null;
    const finalizedWasPlanPrompt = isPlanModePlanPrompt(session, activePrompt);
    const planHandoff = await maybeEnqueueImplementationAfterPlan({
      host,
      sql: getSql(),
      session,
      prompts,
      planPrompt: activePrompt,
      timestamp,
      success: false,
    });

    const nextPrompt = planHandoff.kind === "parked" ? undefined : prompts.find((prompt) => prompt.status === "queued");
    let shouldSendNextPromptNow = false;
    if (nextPrompt) {
      nextPrompt.status = "processing";
      if (!nextPrompt.startedAt) nextPrompt.startedAt = timestamp;
      nextPrompt.updatedAt = timestamp;
      activePromptId = nextPrompt.promptId;
      shouldSendNextPromptNow = Boolean(host.getSandboxSocket());
    }

    const eventClientErrorDetails = toClientErrorDetails(event.errorDetails);
    const eventEntries: DurableEntry[] = [
      ...(finalizedWasPlanPrompt
        ? []
        : [
            {
              type: "session_error",
              timestamp,
              data: {
                error: activePrompt.error,
                ...(event.errorCode ? { code: event.errorCode } : {}),
                promptId: activePrompt.promptId,
              },
            } satisfies DurableEntry,
          ]),
      {
        type: "prompt_failed",
        timestamp,
        data: {
          sessionId,
          promptId: activePrompt.promptId,
          status: activePrompt.status,
          error: activePrompt.error,
          ...(eventClientErrorDetails ? { errorDetails: eventClientErrorDetails } : {}),
          prompt: (await toClientPromptWithActorProfile(
            host,
            activePrompt,
            sessionId,
            session.model ?? null,
            session.reasoningEffort ?? null,
          )) as unknown as Record<string, unknown>,
        },
      },
    ];
    if (planHandoff.kind === "spliced") {
      eventEntries.push(planHandoff.promptEnqueuedEvent);
    }
    if (nextPrompt) {
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId, promptId: nextPrompt.promptId, status: "processing" },
      });
    }

    await host.appendAndMirrorEvents(sessionId, eventEntries);

    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    if (!nextPrompt) {
      await maybeTriggerDeferredPrCreation(host, getSql(), sessionId, session.ownerUserId, prompts);
    }
    await host.notePromptTransition(sessionId, activePromptId);
    if (nextPrompt) {
      await host.schedulePromptExecutionAlarm();
      if (shouldSendNextPromptNow) {
        const command = await buildPromptCommandForDispatch(host, getSql(), nextPrompt, session);
        await host.setPendingPromptDispatch(false);
        await host.sendToSandbox(command);
        emitPromptQueueWaitEvent(host, session, nextPrompt, "live");
      }
    } else {
      // ARC-1196: do not wipe the alarm outright — the phase-independent
      // sandbox liveness deadline must survive prompt completion so an idle
      // zombie still converges. rescheduleSessionAlarm deletes the alarm
      // itself when no candidate deadline is valid (terminal sessions).
      await host.rescheduleSessionAlarm();
    }
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: "execution_complete",
      success: false,
      nextPromptId: activePromptId,
    });
    markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt: activePrompt,
      session,
      reason: "execution_complete_failure",
      writeUsageRecord: true,
      suppressMemoryReviewBot: finalizedWasPlanPrompt,
      completion: { success: false },
      finalize: { telemetry: { ...telemetry, traceExpected: true } },
    });
    if (event.errorCode) {
      doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode: event.errorCode });
    }
    scheduleBlockReviewLoopEpochForUnrecoverablePrompt(sessionId, session, activePrompt, event.errorCode);
    if (!activePromptId && !finalizedWasPlanPrompt) {
      await handleStoppedVerificationOutcome(host, getSql(), session, finalizedPromptId, "unexpected_terminal");
    }
  }

  async function recoverStalePromptCompletion(
    completionSource: PromptCompletionSource,
    event: {
      messageId: string;
      connectionGeneration?: number;
      idleObserved?: boolean;
      sessionEditCount?: number;
      sessionPromptCount?: number;
    },
    sessionId: string,
    telemetry?: PromptExecutionTelemetry,
  ): Promise<boolean> {
    const executionCompleteHasProgress =
      completionSource !== "execution_complete" ||
      hasCompletionProgressContext(event.sessionEditCount, event.sessionPromptCount);

    if (completionSource === "execution_complete") {
      // Preserve the normal active-prompt completion contract from docs/bridge.md
      // while still allowing explicit late success to repair stale prompts.
      if (!executionCompleteHasProgress && event.idleObserved !== false) {
        const prompts = doDb.getPrompts(getSql(), sessionId);
        const promptTelemetry = doDb.getPromptTelemetry(getSql(), sessionId);
        const prompt = prompts.find((candidate) => candidate.promptId === event.messageId);
        if (!(prompt?.status === "failed" && promptTelemetry[event.messageId]?.errorCode === "stale_prompt")) {
          return false;
        }
      }
    }

    const session = doDb.getSession(getSql(), sessionId);
    const prompts = doDb.getPrompts(getSql(), sessionId);
    const promptTelemetry = doDb.getPromptTelemetry(getSql(), sessionId);
    const prompt = prompts.find((candidate) => candidate.promptId === event.messageId);
    if (!session || !prompt) return false;

    const stoppedBy = readPromptStoppedBy(await host.state.storage.get(PROMPT_STOPPED_BY_STORAGE_KEY));
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    const currentGeneration = ((await host.state.storage.get("sandbox_connection_gen")) as number | undefined) ?? null;
    const decision = decideTerminalEvent({
      promptId: event.messageId,
      activePromptId,
      currentConnectionGeneration: currentGeneration,
      eventConnectionGeneration: event.connectionGeneration ?? null,
      promptStoppedBy: stoppedBy[event.messageId] ?? null,
      promptRun:
        prompt.status === "failed"
          ? { outcome: "failed", errorCode: promptTelemetry[event.messageId]?.errorCode ?? null }
          : null,
    });

    if (decision.action === "complete-active") {
      return false;
    }
    if (
      decision.action === "ack-ignore-user-stopped" ||
      decision.action === "ack-ignore-superseded" ||
      decision.action === "ignore-unknown-prompt"
    ) {
      return true;
    }
    const completion: PromptCompletion = { success: true };
    const timestamp = nowIso();
    prompt.status = "completed";
    prompt.error = null;
    prompt.completedAt = timestamp;
    prompt.updatedAt = timestamp;
    const finalizedPromptId = prompt.promptId;

    const eventEntries: DurableEntry[] = [
      {
        type: "prompt_recovered",
        timestamp,
        data: {
          sessionId,
          promptId: finalizedPromptId,
          correctedFromOutcome: "failed",
          correctedAt: timestamp,
          staleReason: decision.staleReason,
        },
      },
      {
        type: "prompt_completed",
        timestamp,
        data: {
          sessionId,
          promptId: finalizedPromptId,
          status: prompt.status,
          error: prompt.error,
          recoveredFrom: "stale_prompt",
          staleReason: decision.staleReason,
          prompt: (await toClientPromptWithActorProfile(
            host,
            prompt,
            sessionId,
            session.model ?? null,
            session.reasoningEffort ?? null,
          )) as unknown as Record<string, unknown>,
        },
      },
    ];

    await host.appendAndMirrorEvents(sessionId, eventEntries, prompt.promptId);
    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    await clearPromptMarkers(host.state, finalizedPromptId);
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: `${completionSource}_stale_recovery`,
      success: completion.success,
      nextPromptId: activePromptId,
    });
    if (shouldMarkPlatformLlmTerminal(completion, completionSource)) {
      markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    }
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt,
      session,
      reason: `${completionSource}_stale_recovery`,
      writeUsageRecord: true,
      completion: { success: completion.success },
      finalize: {
        telemetry: {
          ...telemetry,
          ...(shouldMarkPromptTraceExpected(completion, completionSource) ? { traceExpected: true } : {}),
          recoverStalePrompt: true,
        },
        context: await capturePromptFinalizeContextForPrompt(host, sessionId, finalizedPromptId),
      },
    });
    // A FAILED recovered stale review-loop prompt must NOT complete its epoch (that would silently
    // treat the feedback as handled). Leave it in-flight so reconcileStuckReviewLoopEpochs reclaims and
    // re-drives it after the lease expires, bounded by the attempt cap. A successful one resolves on the
    // publish / no-changes path.

    // Only post the recovery summary once the recovered prompt is no longer active.
    // Suppress the Slack mirror for review-loop follow-ups entirely (success or failure) — these
    // are automated review-loop turns the user did not initiate and should not surface in Slack.
    if (!activePromptId && !prompt?.reviewLoopEpochId) {
      const promptEvents = doDb.getEvents(getSql(), sessionId, { promptId: finalizedPromptId });
      await storeSlackCompletionSummary(host, promptEvents, finalizedPromptId);
      trackSlackThreadNotification(host, session.callbackContext, sessionId, finalizedPromptId, completion.success);
    }

    host.log.warn(
      {
        event: "stale_prompt_recovered",
        sessionId,
        promptId: finalizedPromptId,
        staleReason: decision.staleReason,
        completionSource,
      },
      "Recovered stale prompt from late completion event",
    );
    return true;
  }

  async function handlePostExecution(
    event: Extract<SandboxEvent, { type: "post_execution" }>,
    sessionId: string,
  ): Promise<void> {
    let session = doDb.getSession(getSql(), sessionId);
    let prompts = doDb.getPrompts(getSql(), sessionId);
    let prompt = prompts.find((candidate) => candidate.promptId === event.messageId);
    const ext = session ? doDb.getSessionExtended(getSql(), sessionId) : null;
    const isVerificationSession = isQaTesterAgentRole(session?.agentRole) || isQaTesterAgentRole(ext?.agentRole);

    if (session && prompt?.status === "processing") {
      const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
      if (activePromptId === event.messageId) {
        // Post-execution can overtake the session_idle completion event. Close the prompt first;
        // the normal post-execution completion write below then records branch/commit/diff metadata.
        await completeActivePrompt(sessionId, { success: true }, event.messageId, "post_execution_preclose");
        session = doDb.getSession(getSql(), sessionId);
        prompts = doDb.getPrompts(getSql(), sessionId);
        prompt = prompts.find((candidate) => candidate.promptId === event.messageId);
      }
    }

    if (!session || !prompt) {
      return;
    }

    const updatedAt = nowIso();
    const shouldRecoverLateVerifierResult =
      isVerificationSession && prompt.status === "failed" && event.verifierResult !== undefined;
    if (prompt.status !== "completed" && !shouldRecoverLateVerifierResult) {
      return;
    }
    if (shouldRecoverLateVerifierResult) {
      prompt.status = "completed";
      prompt.error = null;
      prompt.errorDetails = null;
      prompt.completedAt = updatedAt;
      prompt.updatedAt = updatedAt;
      await host.appendAndMirrorEvents(
        sessionId,
        [
          {
            type: "prompt_recovered",
            timestamp: updatedAt,
            data: {
              sessionId,
              promptId: prompt.promptId,
              correctedFromOutcome: "failed",
              correctedAt: updatedAt,
              staleReason: "late_verifier_post_execution",
            },
          },
          {
            type: "prompt_completed",
            timestamp: updatedAt,
            data: {
              sessionId,
              promptId: prompt.promptId,
              status: "completed",
              correctedFromOutcome: "failed",
            },
          },
        ],
        prompt.promptId,
      );
      host.log.warn(
        {
          event: "late_verifier_post_execution_recovered",
          sessionId,
          promptId: prompt.promptId,
          verdict: event.verifierResult?.verdict ?? null,
        },
        "Recovered verifier prompt from late post_execution after an earlier failure",
      );
    }
    prompt.updatedAt = updatedAt;

    // ARC-876: reset stale publishStatus before evaluating the new publish
    // decision. A previous prompt may have left publishStatus="failed"
    // (watchdog-induced or thrown), and without this reset the new prompt's
    // publish attempt inherits the prior failure on the UI until
    // publishSessionResult overwrites it asynchronously. Reset before the
    // no-change deferred PR retry path as well so it cannot race a stale reset
    // after scheduling publish work.
    if (!isVerificationSession) {
      const prePublishExt = ext ?? doDb.getSessionExtended(getSql(), sessionId);
      if (prePublishExt?.publishStatus === "failed") {
        doDb.updateSessionFields(getSql(), sessionId, {
          publishStatus: "not_started",
          publishStage: null,
          publishError: null,
        });
      }
    }

    if (event.hasChanges) {
      prompt.result = {
        ...(event.branch ? { branch: event.branch } : {}),
        ...(event.commitSha ? { commitSha: event.commitSha } : {}),
        diffSummary: event.diffSummary ?? "Changes detected",
      };
      const extFieldUpdates: Partial<doDb.SessionExtendedFields> = {};
      if (event.commitSha) extFieldUpdates.lastCommitSha = event.commitSha;
      if (event.branch) {
        if (!doDb.updateSessionBranchFromSandbox(getSql(), sessionId, event.branch, extFieldUpdates)) {
          host.log.warn(
            { sessionId, branchName: event.branch },
            "Rejected unsafe sandbox-supplied branch name from post_execution",
          );
        }
      } else if (Object.keys(extFieldUpdates).length > 0) {
        doDb.updateSessionFields(getSql(), sessionId, extFieldUpdates);
      }
    } else {
      prompt.result = { noChanges: true, noChangeReason: event.noChangeReason };
      // A review-loop turn that produced no code change (reply-only / no-op / question-only) never
      // publishes, so nothing else will transition its epoch out of enqueued/processing. Complete it
      // here so it does not sit in-flight forever (and a later same-head review can open a new wave).
      scheduleResolveReviewLoopEpochForTerminalPrompt(sessionId, prompt);
      await maybeTriggerDeferredPrCreation(host, getSql(), sessionId, session.ownerUserId, prompts);
    }
    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);

    host.broadcast({
      type: "prompt_updated",
      prompt: await toClientPromptWithActorProfile(
        host,
        prompt,
        sessionId,
        session.model ?? null,
        session.reasoningEffort ?? null,
      ),
    });

    if (event.hasChanges && (event.diffSummary || event.branch || event.commitSha)) {
      schedulePromptTerminalSideEffects(host, {
        sessionId,
        prompt,
        session,
        reason: "post_execution_completion_update",
        completion: {
          diffSummary: event.diffSummary,
          branch: event.branch,
          commitSha: event.commitSha,
          success: true,
        },
      });
    }

    const normalizedPrReadiness = normalizePrReadinessEvidence(event.prReadiness);
    if (normalizedPrReadiness) {
      await host.state.storage.put(PR_READINESS_STORAGE_KEY, normalizedPrReadiness);
    } else if ((await host.state.storage.get(PR_READINESS_STORAGE_KEY)) !== undefined) {
      await host.state.storage.delete(PR_READINESS_STORAGE_KEY);
    }
    if (event.prTemplateFill) {
      await host.state.storage.put(PR_TEMPLATE_FILL_STORAGE_KEY, event.prTemplateFill);
    } else if ((await host.state.storage.get(PR_TEMPLATE_FILL_STORAGE_KEY)) !== undefined) {
      await host.state.storage.delete(PR_TEMPLATE_FILL_STORAGE_KEY);
    }

    if (event.verification) {
      await host.state.storage.put("verification", event.verification);
      host.broadcast({
        type: "verification_updated",
        verification: event.verification,
        verificationSummary: buildVerificationSummary({
          verification: event.verification,
          readiness: normalizedPrReadiness,
        }),
      });
    } else {
      const hadStoredVerification = (await host.state.storage.get("verification")) !== undefined;
      if (hadStoredVerification) {
        await host.state.storage.delete("verification");
      }
      // Broadcast when stored verification was cleared OR readiness-only
      // evidence exists; otherwise live clients diverge from fresh snapshots,
      // which build the summary from verification || prReadiness.
      if (hadStoredVerification || normalizedPrReadiness) {
        host.broadcast({
          type: "verification_updated",
          verification: null,
          verificationSummary: normalizedPrReadiness
            ? buildVerificationSummary({ verification: null, readiness: normalizedPrReadiness })
            : null,
        });
      }
    }

    if (isVerificationSession) {
      const targetPrUrl = session.targetPrUrl ?? ext?.targetPrUrl ?? null;
      if (!targetPrUrl) {
        host.log.warn(
          { event: "verification_comment.skipped", sessionId, promptId: event.messageId },
          "Verification session finished without target PR URL; skipped managed GitHub comment",
        );
        return;
      }
      if (event.verificationSkipped) {
        if (!host.env.DB || !host.env.GITHUB_APP_ID || !host.env.GITHUB_PRIVATE_KEY) {
          host.log.warn(
            { event: "verification_comment.skipped", sessionId, promptId: event.messageId },
            "Verification planner skip finished without GitHub environment bindings; skipped managed GitHub comment",
          );
          return;
        }
        // Finalize `verification-skipped` directly; the restored managed QA comment is informational and
        // does not gate lifecycle state. ARC-1330 W11 D-51 removed the per-PR verification lock.
        await syncVerificationStateForPr(host.env as Env, {
          prUrl: targetPrUrl,
          state: "verification-skipped",
          installationId: ext?.installationId ?? null,
          repoOwner: ext?.repoOwner ?? null,
          repoName: ext?.repoName ?? null,
          logger: host.log,
        });
        scheduleVerificationSkippedCommentPublish(host, {
          sessionId,
          promptId: event.messageId,
          targetPrUrl,
          installationId: ext?.installationId ?? null,
          repoOwner: ext?.repoOwner ?? null,
          repoName: ext?.repoName ?? null,
          summary: event.verificationSkipped.reason || "Verification skipped.",
          reasonCode: "verification-phase-skip",
        });
        host.log.info(
          {
            event: "verification_phase.skip.finalized",
            sessionId,
            promptId: event.messageId,
            targetPrUrl,
            headSha: event.verificationSkipped.headSha ?? null,
          },
          "Finalized verification planner skip",
        );
        // ARC-1330 (PR 49): this seam synced LEGACY `verification-skipped` but emitted NO spine verdict,
        // stranding the parent's pr_coordination row in VERIFYING (A1 cannot re-enter from VERIFYING —
        // the exact prod-soak strand class). Emit the spine skip so the row exits VERIFYING → REVIEW.
        // The planner skip event is not a VerifierTerminalResult, so it cannot echo the run token itself;
        // read the same per-prompt token the normal verdict-back path uses. In live mode a missing token
        // still mints nothing (freshness fail-closed), instead of self-sourcing a possibly superseded run.
        try {
          const childRow = await getChildSessionRow(host.env.DB, sessionId);
          const parentSessionId =
            (await readVerificationCoordinatorSessionIdForPrompt(host, event.messageId)) ??
            childRow?.parent_session_id ??
            null;
          if (parentSessionId) {
            let echoedRunId: number | undefined;
            try {
              echoedRunId = await host.state.storage.get<number>(verificationRunIdStorageKey(event.messageId));
            } catch {
              // best-effort token read — an unreadable token fails toward NOT-fresh, never a false accept.
            }
            await shadowEmitVerificationTerminalOutcome(
              host.env as Env,
              parentSessionId,
              { outcome: "skipped", headSha: event.verificationSkipped.headSha ?? null, runId: echoedRunId },
              { waitUntil: (promise) => host.waitUntil(promise) },
              host.log,
            );
          }
        } catch (error) {
          host.log.warn(
            {
              event: "fsm.verification_skip.shadow_emit_failed",
              sessionId,
              promptId: event.messageId,
              error: String(error),
            },
            "ARC-1330 shadow spine skip emit failed (ignored)",
          );
        }
        scheduleGithubQaFinishedReaction(host, ext?.callbackContext);
        return;
      }
      if (!host.env.DB || !host.env.GITHUB_APP_ID || !host.env.GITHUB_PRIVATE_KEY) {
        host.log.warn(
          { event: "verification_comment.skipped", sessionId, promptId: event.messageId },
          "Verification session finished without GitHub environment bindings; skipped managed GitHub comment",
        );
        return;
      }
      if (event.hasChanges && !event.verifierResult) {
        host.log.info(
          { event: "verification_comment.skipped", sessionId, promptId: event.messageId },
          "Verification session change-producing post_execution did not include a terminal verifier result; skipped managed GitHub comment",
        );
        return;
      }
      const rawVerifierOutput =
        normalizedPrReadiness?.evidenceBundle?.agentFinalMessage ??
        normalizedPrReadiness?.evidenceBundle?.finalSummary ??
        "";
      // A3: the rerun-after-fix gate is retired (non-blocking QA) — finalize the terminal verdict
      // unconditionally; it is recorded immediately. The restored managed QA comment (#6939) is published
      // after state sync as an isolated side effect (scheduleVerificationResultCommentPublish below), so
      // GitHub comment failures cannot wedge state.
      {
        if (event.verifierResult) {
          const verifierRunId =
            event.verifierResult.verificationRunId ?? (await readVerifierRunIdForPrompt(host, event.messageId));
          await syncVerificationResultForPr(host.env as Env, {
            prUrl: targetPrUrl,
            result: verificationResultFromAgentVerdict(event.verifierResult.verdict),
            needsWorkLabel: event.verifierResult.needsWorkLabel ?? null,
            qaRun: qaRunTerminalSummaryFromVerifierResult({
              childSessionId: sessionId,
              verifierResult: event.verifierResult,
              runId: verifierRunId,
            }),
            logger: host.log,
          });
        }
        await syncVerificationStateForPr(host.env as Env, {
          prUrl: targetPrUrl,
          state: "verification-done",
          installationId: ext?.installationId ?? null,
          repoOwner: ext?.repoOwner ?? null,
          repoName: ext?.repoName ?? null,
          logger: host.log,
        });
        scheduleGithubQaFinishedReaction(host, ext?.callbackContext);
        if (
          event.verifierResult &&
          verificationResultFromAgentVerdict(event.verifierResult.verdict) === "merge-ready"
        ) {
          await scheduleQaPassLabelOnce(host, {
            sessionId,
            promptId: event.messageId,
            targetPrUrl,
            installationId: ext?.installationId ?? null,
            repoOwner: ext?.repoOwner ?? null,
            repoName: ext?.repoName ?? null,
          });
        }
        scheduleVerificationResultCommentPublish(host, {
          sql: getSql(),
          sessionId,
          promptId: event.messageId,
          targetPrUrl,
          ext,
          installationId: ext?.installationId ?? null,
          repoOwner: ext?.repoOwner ?? null,
          repoName: ext?.repoName ?? null,
          rawVerifierOutput,
          fallbackHeadSha: event.verifierResult?.verifiedHeadSha ?? event.commitSha ?? ext?.lastCommitSha ?? "",
          verifierResult: event.verifierResult,
          artifacts: event.verification?.artifacts ?? [],
          kind: "result",
        });
        // ARC-1330 W11 D-51: the per-PR verification lock (ARC-1173) is removed. A new commit is
        // re-verified via the FSM-native spawn idempotency anchor (W11-V4); there is no lock to free.
        // Telemetry: one qa_tester.run.completed per terminal verdict. Dispatched via waitUntil
        // (resolves parent_model with an extra DAO read) so a Datadog hiccup never blocks the handler.
        // The deferred comment-retry settle path (retryPendingVerificationComment) is not yet
        // instrumented; this covers the dominant synchronous-publish terminal.
        if (event.verifierResult) {
          const verifierResult = event.verifierResult;
          const result = verificationResultFromAgentVerdict(verifierResult.verdict);
          const durationMs =
            prompt?.startedAt && prompt?.completedAt
              ? Math.max(0, Date.parse(prompt.completedAt) - Date.parse(prompt.startedAt))
              : null;
          const repo = ext?.repoOwner && ext?.repoName ? `${ext.repoOwner}/${ext.repoName}` : null;
          const ownerUserId = Number(session.ownerUserId);
          const verifierModel = session.model ?? null;
          const needsAppRuntime = session.verificationRuntimeMode === "app_runtime";
          // host.env.DB is non-null here (guarded above for verification sessions), but capture it so
          // the type narrowing survives into the async closure.
          const db = host.env.DB;
          // run_index / max_runs come from the parent FSM row. The verifier session's own ext does NOT
          // carry these — they are projected onto the implementation session.
          // `exhausted` means the verifier gave up — a needs-work verdict with no runs left — NOT a
          // merge-ready that simply landed on the last permitted run (that one converged).
          let runIndex: number | null = null;
          let maxRuns: number | null = null;
          let exhausted = false;
          let parentSessionId: string | null = null;
          let hasFsmVerificationRunToken = typeof verifierResult.verificationRunId === "number";
          try {
            parentSessionId =
              (await readVerificationCoordinatorSessionIdForPrompt(host, event.messageId)) ??
              (await getChildSessionRow(db, sessionId))?.parent_session_id ??
              null;
          } catch {
            // best-effort; the run-limit helper falls back to the PR row when parent lookup fails
          }
          if (!hasFsmVerificationRunToken) {
            try {
              hasFsmVerificationRunToken =
                typeof (await host.state.storage.get<number>(verificationRunIdStorageKey(event.messageId))) ===
                "number";
            } catch {
              // An unreadable token may still be an FSM-managed verifier; avoid adding the standalone fallback.
              hasFsmVerificationRunToken = true;
            }
          }
          try {
            const limit = await checkVerificationRunLimit(host.env as Env, host.log, targetPrUrl, {
              parentSessionId,
              includeStandaloneVerifierSessions: !hasFsmVerificationRunToken,
            });
            runIndex = limit.currentRuns === null ? null : Math.max(1, limit.currentRuns);
            maxRuns = limit.maxRuns;
            exhausted = result === "needs-work" && !limit.allowed;
          } catch {
            // best-effort; run fields fall back to null/false
          }
          host.waitUntil(
            (async () => {
              let parentModel: string | null = null;
              let parentBackend: string | null = null;
              try {
                if (parentSessionId) {
                  const parent = await getSessionState(host.env as Env, parentSessionId);
                  parentModel = parent?.model ?? null;
                  parentBackend = parent?.agentRuntimeBackend ?? null;
                }
              } catch {
                // best-effort; parent fields fall back to "unknown"
              }
              await emitVerificationRunCompletedEvent(host.env, {
                verdict: verifierResult.verdict,
                result,
                needsWorkLabel: verifierResult.needsWorkLabel ?? null,
                needsAppRuntime,
                exhausted,
                model: verifierModel,
                verifierBackend: session.agentRuntimeBackend ?? null,
                parentModel,
                parentBackend,
                repo,
                ownerUserId,
                runIndex,
                maxRuns,
                evidenceCount: verifierResult.evidence.length,
                blockerCount: verifierResult.blockers.length,
                durationMs,
                sessionId,
                prUrl: targetPrUrl,
              });
            })(),
          );
          // ARC-1330 (PR 42 + PR 47) — DUAL-EMIT the verification verdict onto the parent spine as
          // `verification.pass/app_breaks/run_limit{head_sha, run_id}`. Kept in a shared helper so the
          // deferred comment-retry path emits the same run-scoped verdict after a successful retry.
          await emitVerifierTerminalVerdictForPrompt({
            db,
            childSessionId: sessionId,
            promptId: event.messageId,
            verifierResult,
            exhausted,
          });
        }
      }
      return;
    }

    // ARC-876: gate on the push outcome bundled into post_execution. A current
    // bridge always sets `pushed` whenever there are changes (and reconstructs
    // it with pushed=true on crash recovery), so the event is authoritative.
    if (event.hasChanges && event.branch && event.pushed !== true) {
      const cause: "push_failed" | "push_status_unknown" =
        event.pushed === false ? "push_failed" : "push_status_unknown";
      await host
        .failPublishOnPushOutcome({
          sessionId,
          cause,
          pushError: event.pushError ?? null,
          promptId: event.messageId,
        })
        .catch((err) => {
          host.log.error(
            { sessionId, promptId: event.messageId, error: String(err) },
            "Failed to mark publish as failed on push outcome",
          );
          Sentry.captureException(err, { tags: { sessionId, operation: "failPublishOnPushOutcome" } });
        });
      let prCheckExtended: ReturnType<typeof doDb.getSessionExtended> | null = null;
      try {
        prCheckExtended = doDb.getSessionExtended(getSql(), sessionId);
      } catch (err) {
        host.log.warn(
          { sessionId, promptId: event.messageId, error: String(err) },
          "Failed to read session metadata for auto publish decision telemetry",
        );
      }
      emitAutoPublishDecision(host, {
        sessionId,
        promptId: event.messageId,
        ownerUserId: session.ownerUserId,
        repoOwner: prCheckExtended?.repoOwner ?? null,
        repoName: prCheckExtended?.repoName ?? null,
        source: "post_execution",
        decision: "skip",
        reason: event.pushed === false ? "push_failed" : "push_status_unknown",
        branch: event.branch,
        commitSha: event.commitSha,
        hasChanges: event.hasChanges,
        pushed: event.pushed === false ? false : null,
        existingPrUrl: prCheckExtended?.prUrl,
        publishStatus: prCheckExtended?.publishStatus,
      });
    } else if (event.branch && event.pushed === true) {
      const branch = event.branch;
      const prBody = event.prBody;

      const prCheckExtended = doDb.getSessionExtended(getSql(), sessionId);
      const currentActiveId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
      if (!currentActiveId) {
        const existingPrUrl = prCheckExtended?.prUrl;
        if (existingPrUrl) {
          emitAutoPublishDecision(host, {
            sessionId,
            promptId: event.messageId,
            ownerUserId: session.ownerUserId,
            repoOwner: prCheckExtended?.repoOwner ?? null,
            repoName: prCheckExtended?.repoName ?? null,
            source: "post_execution",
            decision: "trigger_update",
            reason: "existing_pr",
            branch: event.branch,
            commitSha: event.commitSha,
            hasChanges: event.hasChanges,
            pushed: true,
            activePromptId: currentActiveId,
            existingPrUrl,
            publishStatus: prCheckExtended?.publishStatus,
          });
          trackPostExecutionPublish(
            host,
            "triggerPrUpdate",
            sessionId,
            branch,
            host.triggerPrUpdate(
              sessionId,
              branch,
              event.diffSummary,
              event.prTitle,
              prBody,
              event.verification,
              normalizedPrReadiness ?? undefined,
              event.messageId,
              event.commitSha,
              undefined,
              event.prTemplateFill,
            ),
          );
        } else {
          trackPostExecutionPublish(
            host,
            "triggerPrCreation",
            sessionId,
            branch,
            withPublishUserSettingsCache(host, async (settingsCache) => {
              emitAutoPublishDecision(host, {
                sessionId,
                promptId: event.messageId,
                ownerUserId: session.ownerUserId,
                repoOwner: prCheckExtended?.repoOwner ?? null,
                repoName: prCheckExtended?.repoName ?? null,
                source: "post_execution",
                decision: "trigger_create",
                reason: "auto_create_enabled",
                branch,
                commitSha: event.commitSha,
                hasChanges: event.hasChanges,
                pushed: true,
                activePromptId: currentActiveId,
                existingPrUrl: null,
                publishStatus: prCheckExtended?.publishStatus,
              });
              const args = [
                sessionId,
                branch,
                event.diffSummary,
                event.prTitle,
                prBody,
                event.verification,
                normalizedPrReadiness ?? undefined,
                event.messageId,
                event.commitSha,
              ] as const;
              if (settingsCache) {
                await host.triggerPrCreation(...args, settingsCache, event.prTemplateFill);
              } else {
                await host.triggerPrCreation(...args, undefined, event.prTemplateFill);
              }
            }),
          );
        }
      } else {
        emitAutoPublishDecision(host, {
          sessionId,
          promptId: event.messageId,
          ownerUserId: session.ownerUserId,
          repoOwner: prCheckExtended?.repoOwner ?? null,
          repoName: prCheckExtended?.repoName ?? null,
          source: "post_execution",
          decision: "skip",
          reason: "active_prompt",
          branch: event.branch,
          commitSha: event.commitSha,
          hasChanges: event.hasChanges,
          pushed: true,
          activePromptId: currentActiveId,
          existingPrUrl: prCheckExtended?.prUrl,
          publishStatus: prCheckExtended?.publishStatus,
        });
        // The active prompt owns the current publish slot. Deferred recovery is
        // retried when that prompt reaches a terminal state below.
      }
    }
  }

  async function handleSpawnTimeout(
    sessionId: string,
    session: SessionState,
    prompts: PromptState[],
    activePrompt: PromptState,
    errorMessage: string,
    origin: SpawnTimeoutOrigin,
    spawnTimeoutMs?: number,
  ): Promise<void> {
    const timestamp = nowIso();
    const spawnSbState = doDb.getSandboxState(getSql(), sessionId);
    // Peek first; commit (write the new spawnRetryCount) only after the
    // durable-event sequence below succeeds. If anything between peek and
    // commit throws, the next alarm re-fires with the counter unchanged --
    // the prompt does not lose retries to a partial handler.
    const decision = peekSpawnTimeoutRetryDecision({ sql: getSql(), sessionId });
    const { retryCount: spawnRetryCount, retryCapReached } = decision;
    const spawnTimeoutErrorCode = classifySpawnTimeoutPhase({
      origin,
      providerObjectId: spawnSbState?.runtimeSandboxId ?? spawnSbState?.modalObjectId,
    });
    const spawnAlarmOvershootMs = computeSpawnAlarmOvershootMs({
      origin,
      spawnStartedAt: spawnSbState?.spawnStartedAt,
      spawnTimeoutMs,
    });
    // Emit the spawn-failure telemetry before any putSandboxStatus("stopped")
    // below deletes the breadcrumb. Covers both the retry and retry-exhausted
    // branches and the deadline / provider_error origins.
    await logSpawnFailure({
      sessionId,
      promptId: activePrompt.promptId,
      phase: spawnTimeoutErrorCode,
      origin,
      retryCount: spawnRetryCount,
      retryCapReached,
      spawnAlarmOvershootMs,
      runtimeBackendFallback: spawnSbState?.runtimeBackend ?? null,
    });

    activePrompt.status = "failed";
    activePrompt.error = retryCapReached
      ? `Sandbox failed to connect after ${spawnRetryCount + 1} attempts`
      : errorMessage;
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    await host.setHasPendingQuestion(false);
    await host.setPendingPromptDispatch(false);
    await host.clearSpawnAttemptState(retryCapReached);

    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);
    const finalizedWasPlanPrompt = isPlanModePlanPrompt(session, activePrompt);

    // A plan prompt gets the same spawn-retry resilience as any other first
    // prompt: only when the cap is reached do we give up and hand off plan-less.
    // (When retryCapReached, maybeEnqueueImplementationAfterPlan below still
    // fires the plan→implement handoff.) A transient cold-start timeout falls
    // through to the retry path, which re-clones the plan prompt (stamped
    // isPlanPrompt) so it re-runs read-only.
    if (retryCapReached) {
      let newActivePromptId: string | null = null;
      const planHandoff = await maybeEnqueueImplementationAfterPlan({
        host,
        sql: getSql(),
        session,
        prompts,
        planPrompt: activePrompt,
        timestamp,
        success: false,
      });
      const nextPrompt =
        planHandoff.kind === "parked" ? undefined : prompts.find((prompt) => prompt.status === "queued");
      if (nextPrompt) {
        nextPrompt.status = "processing";
        if (!nextPrompt.startedAt) nextPrompt.startedAt = timestamp;
        nextPrompt.updatedAt = timestamp;
        newActivePromptId = nextPrompt.promptId;

        await storePromptDispatchPath(host.state, nextPrompt.promptId, "cold");
        await host.setPendingPromptDispatch(true);
        // notePromptTransition is deferred until after bulkUpdatePrompts
        // persists the in-memory status flips (below). The post-PR2 reducer
        // reads prompts.status as the source of truth; calling here would
        // broadcast a rich_status derived from the still-stale DB row.
        await host.startSpawnAttempt(sessionId, "spawnSandbox.spawnTimeout");
      }

      const eventEntries: DurableEntry[] = [
        ...(finalizedWasPlanPrompt
          ? []
          : [
              {
                type: "session_error",
                timestamp,
                data: { error: activePrompt.error, code: spawnTimeoutErrorCode, promptId: activePrompt.promptId },
              } satisfies DurableEntry,
            ]),
        {
          type: "prompt_failed",
          timestamp,
          data: { sessionId, promptId: activePrompt.promptId, status: "failed", error: activePrompt.error },
        },
      ];
      if (planHandoff.kind === "spliced") {
        eventEntries.push(planHandoff.promptEnqueuedEvent);
      }
      if (nextPrompt) {
        eventEntries.push({
          type: "prompt_processing",
          timestamp,
          data: { sessionId, promptId: nextPrompt.promptId, status: "processing" },
        });
      }

      const eventState = await host.appendAndMirrorEvents(sessionId, eventEntries);
      session.updatedAt = timestamp;
      session.lastEventId = `event-${eventState.replay.lastEventSequence}`;

      doDb.updateSession(getSql(), sessionId, {
        status: session.status,
        updatedAt: session.updatedAt,
        title: session.title,
      });
      doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
      // Always reproject -- newActivePromptId carries either the promoted
      // queued prompt's id or null. Runs after bulkUpdatePrompts so the
      // derived helper inside notePromptTransition reads the fresh row.
      await host.notePromptTransition(sessionId, newActivePromptId);
      // Commit the spawn-retry decision now that durable events and prompt
      // state have persisted -- if an earlier step had failed, the alarm
      // would re-fire with the counter unchanged.
      commitSpawnTimeoutRetryDecision({ sql: getSql(), sessionId, decision });
      if (!nextPrompt) {
        await host.putSandboxStatus(sessionId, "stopped", { stopReason: "spawn_failed" });
        if (planHandoff.kind === "parked") {
          await host.rescheduleSessionAlarm();
        } else {
          // deleteAlarm is correct here (ARC-1196 audit): the sandbox was just
          // stopped, so no liveness deadline can be valid.
          await host.state.storage.deleteAlarm();
        }
      }
      logDurablePromptCloseComplete(host, {
        sessionId,
        promptId: finalizedPromptId,
        source: "spawn_timeout",
        success: false,
        nextPromptId: newActivePromptId,
      });
      markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
      schedulePromptTerminalSideEffects(host, {
        sessionId,
        prompt: activePrompt,
        session,
        reason: "spawn_timeout",
        suppressMemoryReviewBot: finalizedWasPlanPrompt,
        finalize: {
          telemetry: {
            errorCode: spawnTimeoutErrorCode,
            ...(spawnAlarmOvershootMs !== undefined ? { spawnAlarmOvershootMs } : {}),
          },
        },
      });
      doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode: spawnTimeoutErrorCode });
      if (!newActivePromptId && !finalizedWasPlanPrompt) {
        await handleStoppedVerificationOutcome(host, getSql(), session, finalizedPromptId, "unexpected_terminal");
      }
      return;
    }

    const spawnExtended = doDb.getSessionExtended(getSql(), sessionId);
    const spawnPromptCounterValue = spawnExtended?.promptCounter ?? 0;
    const promptCounter =
      Number.isFinite(spawnPromptCounterValue) && spawnPromptCounterValue >= 0
        ? spawnPromptCounterValue
        : prompts.length;
    const retryPrompt = clonePromptForRetry(activePrompt, `p-${promptCounter + 1}`, timestamp, "processing");
    // Carry the prompt-scoped disconnect-retry budget across the spawn-timeout
    // clone. A spawn timeout is not a fresh disconnect (so we do not increment),
    // but resetting to 0 here would let a prompt that already exhausted
    // DISCONNECT_RETRY_CAP via mid-turn drops re-earn a full budget by alternating
    // spawn-timeout and disconnect, re-running unboundedly and burning a VM each
    // time. `?? 0` preserves prior behavior for a prompt with no disconnect history.
    retryPrompt.disconnectRetryCount = activePrompt.disconnectRetryCount ?? 0;
    // Keep a retried plan turn in plan mode across the fresh prompt id.
    if (finalizedWasPlanPrompt) retryPrompt.isPlanPrompt = true;
    const firstQueuedIdx = prompts.findIndex((prompt) => prompt.status === "queued");
    if (firstQueuedIdx >= 0) {
      prompts.splice(firstQueuedIdx, 0, retryPrompt);
    } else {
      prompts.push(retryPrompt);
    }

    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    await host.notePromptTransition(sessionId, retryPrompt.promptId);
    doDb.updateSessionFields(getSql(), sessionId, { promptCounter: promptCounter + 1 });

    // Re-point the review-loop epoch's last_prompt_id from the timed-out prompt to the retry prompt.
    // The retry keeps the same reviewLoopEpochId but gets a NEW promptId, so without this the publish
    // guard / reply guard would permanently reject the retried prompt as "attached to a different
    // prompt".
    //
    // AWAITED (not waitUntil) so the re-point is authoritative before this handler returns: the
    // timed-out original prompt is now `failed`, and the retry must own the epoch's last_prompt_id (and
    // a refreshed in-flight lease, set by repointReviewLoopEpochPrompt) so its publish/reply is
    // accepted. Failure paths no longer complete the epoch, so the retry is not at risk of a terminal
    // resolve closing the epoch out from under it; landing the re-point synchronously keeps the lease
    // armed so the retry is not reclaimed by the stuck-epoch sweep while it is still working.
    const retryEpochId =
      typeof activePrompt.reviewLoopEpochId === "string" ? activePrompt.reviewLoopEpochId.trim() : "";
    if (retryEpochId && host.repointReviewLoopEpochPrompt) {
      try {
        await host.repointReviewLoopEpochPrompt(sessionId, retryEpochId, activePrompt.promptId, retryPrompt.promptId);
      } catch (error) {
        host.log.warn(
          {
            sessionId,
            epochId: retryEpochId,
            previousPromptId: activePrompt.promptId,
            nextPromptId: retryPrompt.promptId,
            error: String(error),
          },
          "Failed to re-point review-loop epoch prompt after spawn-retry",
        );
      }
    }

    await storePromptDispatchPath(host.state, retryPrompt.promptId, "cold");
    await host.setPendingPromptDispatch(true);
    // Commit the spawn-retry bump now that the retry prompt is queued and
    // active. The subsequent startSpawnAttempt advances the lifecycle to a
    // fresh attempt -- the next alarm fires for the new attempt and reads
    // the bumped counter as intended.
    commitSpawnTimeoutRetryDecision({ sql: getSql(), sessionId, decision });
    await host.startSpawnAttempt(sessionId, "spawnSandbox.spawnTimeout");

    const eventState = await host.appendAndMirrorEvents(sessionId, [
      {
        type: "session_error",
        timestamp,
        data: { error: activePrompt.error, code: spawnTimeoutErrorCode, promptId: activePrompt.promptId },
      },
      {
        type: "prompt_failed",
        timestamp,
        data: { sessionId, promptId: activePrompt.promptId, status: "failed", error: activePrompt.error },
      },
      {
        type: "prompt_enqueued",
        timestamp,
        data: { sessionId, promptId: retryPrompt.promptId, status: "queued" },
      },
      {
        type: "prompt_processing",
        timestamp,
        data: { sessionId, promptId: retryPrompt.promptId, status: "processing" },
      },
    ]);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    doDb.updateSession(getSql(), sessionId, {
      status: session.status,
      updatedAt: session.updatedAt,
      title: session.title,
    });
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: "spawn_timeout_retry",
      success: false,
      nextPromptId: retryPrompt.promptId,
    });
    markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt: activePrompt,
      session,
      reason: "spawn_timeout_retry",
      finalize: {
        telemetry: {
          errorCode: spawnTimeoutErrorCode,
          ...(spawnAlarmOvershootMs !== undefined ? { spawnAlarmOvershootMs } : {}),
        },
      },
    });
  }

  // Single indexed control-plane log line for a terminal/retrying spawn failure.
  // The success-side spawn metric (arcanist.sandbox.spawn_duration) is emitted by
  // the bridge on "ready", which a failed spawn never reaches -- so failures have
  // no spawn-phase telemetry without this. Reads the ephemeral spawn breadcrumb
  // (warm/cold + E2B-create / bridge-launch ms) before putSandboxStatus("stopped")
  // deletes it. Best-effort: telemetry must never throw out of a failure handler.
  // The matching log-derived metric is arcanist.sandbox.spawn_failures
  // (infra/datadog-sandbox.tf), grouped by phase / retry-exhausted / spawn_path.
  async function logSpawnFailure(args: {
    sessionId: string;
    promptId: string | null;
    phase: ErrorCode;
    origin: SpawnTimeoutOrigin;
    retryCount: number;
    retryCapReached: boolean;
    spawnAlarmOvershootMs?: number;
    runtimeBackendFallback?: string | null;
  }): Promise<void> {
    try {
      const instr = await host.state.storage
        .get<SpawnInstrumentation>(spawnInstrumentationKey(args.sessionId))
        .catch(() => undefined);
      // attachedAtMs is set once a runtime attached (warm claim or cold create
      // succeeded); on a no-object failure no breadcrumb exists, so this stays
      // null. When present, it is how long we waited on the bridge before giving
      // up -- the spawn_deadline_no_bridge signal.
      const bridgeLaunchMs = instr?.attachedAtMs != null ? Math.max(0, Date.now() - instr.attachedAtMs) : null;
      host.log.warn(
        {
          event: "sandbox.spawn_failed",
          sessionId: args.sessionId,
          promptId: args.promptId,
          phase: args.phase,
          spawn_origin: args.origin,
          spawn_retry_count: args.retryCount,
          spawn_retry_cap_reached: args.retryCapReached,
          ...(args.spawnAlarmOvershootMs !== undefined ? { spawn_alarm_overshoot_ms: args.spawnAlarmOvershootMs } : {}),
          spawn_path: instr?.spawnPath ?? null,
          e2b_create_ms: instr?.e2bCreateMs ?? null,
          bridge_launch_ms: bridgeLaunchMs,
          runtime_backend: instr?.runtimeBackend ?? args.runtimeBackendFallback ?? null,
        },
        "Sandbox spawn failed",
      );
    } catch (err) {
      host.log.warn({ sessionId: args.sessionId, error: String(err) }, "Failed to log spawn failure telemetry");
    }
  }

  function computeSpawnAlarmOvershootMs(args: {
    origin: SpawnTimeoutOrigin;
    spawnStartedAt: number | null | undefined;
    spawnTimeoutMs: number | undefined;
  }): number | undefined {
    if (args.origin !== "deadline") return undefined;
    if (typeof args.spawnStartedAt !== "number" || typeof args.spawnTimeoutMs !== "number") return undefined;
    const overshoot = Date.now() - args.spawnStartedAt - args.spawnTimeoutMs;
    return overshoot > 0 ? overshoot : 0;
  }

  function spawnFailureMessage(err: unknown): string {
    return stringifyError(err);
  }

  function e2bSpawnFailureCode(err: unknown): string | null {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "E2BSandboxRuntimeError" &&
      typeof (err as { code?: unknown }).code === "string"
    ) {
      return (err as { code: string }).code;
    }
    return null;
  }

  function isRetryableSpawnFailure(err: unknown): boolean {
    if (isSandboxCallbackPreflightError(err)) return false;
    if (isOpencodeAccessDeniedError(err)) return false;
    const e2bCode = e2bSpawnFailureCode(err);
    if (e2bCode) {
      return RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has(e2bCode);
    }

    return !/image build .*failed/i.test(spawnFailureMessage(err));
  }

  function spawnFailureErrorCode(err: unknown): ErrorCode {
    if (isOpencodeAccessDeniedError(err)) return "auth";
    if (isSandboxCallbackPreflightError(err)) return "sandbox_callback";
    return "spawn_preconnect";
  }

  async function failActivePromptAfterUnrecoverableSpawnFailure(
    sessionId: string,
    session: SessionState,
    prompts: PromptState[],
    activePrompt: PromptState,
    errorMessage: string,
    errorCode: ErrorCode,
  ): Promise<void> {
    // Intentionally no maybeEnqueueImplementationAfterPlan handoff here, unlike
    // the disconnect path and handleSpawnTimeout (ARC-1438). This finalizer fires
    // on a non-retryable spawn failure, so the plan turn never ran -- there is no
    // plan to carry forward -- and it hard-tears-down the session below
    // (notePromptTransition(null), putSandboxStatus("stopped"), deleteAlarm()), so
    // an enqueued implementation prompt would only wedge on a stopped/alarmless
    // session or force a re-spawn against a provider we just classified as
    // unrecoverable. handleSpawnTimeout hands off precisely because timeouts are
    // transient and the session can still spawn; that does not hold here.
    const timestamp = nowIso();
    // Log before the putSandboxStatus("stopped") below deletes the breadcrumb.
    // Non-retryable provider failure, so origin is provider_error; the retry
    // counter is read for parity but the cap path does not apply here. These
    // reads exist only to feed telemetry, so the whole block is wrapped to keep
    // the "never throws out of a failure handler" contract (the DB reads are
    // synchronous and sit outside logSpawnFailure's own try/catch).
    try {
      const unrecoverableSbState = doDb.getSandboxState(getSql(), sessionId);
      const unrecoverableRetry = peekSpawnTimeoutRetryDecision({ sql: getSql(), sessionId });
      await logSpawnFailure({
        sessionId,
        promptId: activePrompt.promptId,
        phase: errorCode,
        origin: "provider_error",
        retryCount: unrecoverableRetry.retryCount,
        retryCapReached: unrecoverableRetry.retryCapReached,
        runtimeBackendFallback: unrecoverableSbState?.runtimeBackend ?? null,
      });
    } catch (err) {
      host.log.warn({ sessionId, error: String(err) }, "Failed to log spawn failure telemetry");
    }
    activePrompt.status = "failed";
    activePrompt.error = errorMessage;
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;

    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    resetSpawnRetryOnSuccess({ sql: getSql(), sessionId });
    await host.setHasPendingQuestion(false);
    await host.setPendingPromptDispatch(false);
    await host.clearSpawnAttemptState(true);
    await host.notePromptTransition(sessionId, null);
    await host.putSandboxStatus(sessionId, "stopped", { stopReason: "spawn_failed" });
    // deleteAlarm is correct here (ARC-1196 audit): sandbox just stopped, no
    // liveness deadline can be valid.
    await host.state.storage.deleteAlarm();

    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);
    host.broadcast({ type: "sandbox_error", error: errorMessage });

    const eventState = await host.appendAndMirrorEvents(sessionId, [
      {
        type: "session_error",
        timestamp,
        data: { error: errorMessage, code: errorCode, promptId: activePrompt.promptId },
      },
      {
        type: "prompt_failed",
        timestamp,
        data: { sessionId, promptId: activePrompt.promptId, status: "failed", error: errorMessage, errorCode },
      },
    ]);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    doDb.updateSession(getSql(), sessionId, {
      status: session.status,
      updatedAt: session.updatedAt,
      title: session.title,
    });
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: errorCode,
      success: false,
      nextPromptId: null,
    });
    markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt: activePrompt,
      session,
      reason: errorCode,
      finalize: { telemetry: { errorCode } },
    });
    doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode });
    await handleStoppedVerificationOutcome(host, getSql(), session, finalizedPromptId, "unexpected_terminal");
  }

  async function handleSpawnFailure(
    sessionId: string,
    operation: string,
    err: unknown,
    spawnAttemptId?: string,
  ): Promise<void> {
    if (spawnAttemptId && !(await host.isCurrentSpawnAttempt(spawnAttemptId))) {
      host.log.info({ sessionId, operation, spawnAttemptId }, "Ignoring stale spawn failure");
      return;
    }

    host.log.error({ sessionId, error: String(err) }, `Spawn failed (${operation})`);
    Sentry.captureException(err, { tags: { sessionId, operation } });

    const failSbState = doDb.getSandboxState(getSql(), sessionId);
    const sandboxStatus = failSbState?.status;
    if (sandboxStatus !== "spawning") {
      host.log.info({ sessionId, operation, sandboxStatus }, "Spawn failure arrived after spawn state changed");
      return;
    }

    const session = doDb.getSession(getSql(), sessionId);
    const prompts = doDb.getPrompts(getSql(), sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    const activePrompt = activePromptId ? prompts.find((prompt) => prompt.promptId === activePromptId) : null;

    if (session && activePrompt && activePrompt.status === "processing") {
      const errorMessage = `Sandbox spawn failed: ${spawnFailureMessage(err)}`;
      if (!isRetryableSpawnFailure(err)) {
        await failActivePromptAfterUnrecoverableSpawnFailure(
          sessionId,
          session,
          prompts,
          activePrompt,
          errorMessage,
          spawnFailureErrorCode(err),
        );
        return;
      }

      await handleSpawnTimeout(sessionId, session, prompts, activePrompt, errorMessage, "provider_error");
      return;
    }

    await host.clearSpawnAttemptState(true);
    await host.putSandboxStatus(sessionId, "stopped", { stopReason: "spawn_failed" });
    resetSpawnRetryOnSuccess({ sql: getSql(), sessionId });
    // deleteAlarm is correct here (ARC-1196 audit): sandbox just stopped, no
    // liveness deadline can be valid.
    await host.state.storage.deleteAlarm();
    host.broadcast({ type: "sandbox_error", error: String(err) });
    await host.appendAndMirrorEvents(sessionId, [
      {
        type: "session_error",
        timestamp: nowIso(),
        data: { error: `Sandbox spawn failed: ${String(err)}`, code: "sandbox_spawn" },
      },
    ]);
  }

  // Re-run a prompt whose sandbox dropped mid-turn on a freshly-spawned sandbox,
  // bounded by DISCONNECT_RETRY_CAP. Mirrors the spawn-timeout retry path
  // (clone -> new prompt id -> re-point review-loop epoch -> startSpawnAttempt):
  // a fresh prompt id fences late `execution_complete`/`post_execution` events
  // from the dead VM and restarts the prompt max-duration clock. The retry count
  // rides the clone (parent + 1), persisted atomically with the clone row.
  // This function is reached only after the lifecycle reducer has terminalized
  // the attempt for confirmed sandbox loss or reconnect-grace expiry. Planned
  // same-sandbox Worker handoffs are consumed by the transport boundary and do
  // not call this function, so they never clone a prompt or consume this cap.
  async function retryActivePromptAfterDisconnect(
    session: SessionState,
    prompts: PromptState[],
    activePrompt: PromptState,
    nextRetryCount: number,
    origin: PromptDisconnectOrigin = "unknown",
  ): Promise<void> {
    const sessionId = session.sessionId;
    const timestamp = nowIso();
    const attempt = nextRetryCount; // 1-based attempt number for this retry
    // A sandbox that never started the prompt (zero activity to the max-duration
    // ceiling) surfaces under its own error code so it is distinguishable in
    // telemetry from a mid-turn drop, while sharing the bounded retry mechanism.
    const retryErrorCode: ErrorCode =
      origin === "sandbox_never_started" ? "sandbox_never_started" : "sandbox_disconnected";

    // Finalize the dropped run's row. It becomes `failed` (terminal) so the
    // partial unique index idx_prompts_one_processing holds and its liveness
    // watchdog stops, but we surface a soft `prompt_retrying` event instead of
    // `prompt_failed` so the session shows "retrying", not a hard failure.
    activePrompt.status = "failed";
    activePrompt.error = "Sandbox disconnected while processing; retrying on a fresh sandbox";
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    await host.setHasPendingQuestion(false);
    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);

    const extended = doDb.getSessionExtended(getSql(), sessionId);
    const promptCounterValue = extended?.promptCounter ?? 0;
    const promptCounter =
      Number.isFinite(promptCounterValue) && promptCounterValue >= 0 ? promptCounterValue : prompts.length;
    const retryPrompt = clonePromptForRetry(activePrompt, `p-${promptCounter + 1}`, timestamp, "processing");
    retryPrompt.disconnectRetryCount = nextRetryCount;
    // Keep a retried plan turn in plan mode: the clone has a new id, so without
    // this stamp isPlanModePlanPrompt would fail (id !== "p-1") and the retry
    // would dispatch write-capable, escaping the read-only planning pass.
    if (isPlanModePlanPrompt(session, activePrompt)) retryPrompt.isPlanPrompt = true;
    const firstQueuedIdx = prompts.findIndex((prompt) => prompt.status === "queued");
    if (firstQueuedIdx >= 0) {
      prompts.splice(firstQueuedIdx, 0, retryPrompt);
    } else {
      prompts.push(retryPrompt);
    }

    // Persist the failed original + the processing clone (with its bumped
    // disconnect_retry_count) before projection and the fresh spawn. The
    // counter is committed atomically with the clone row, so a crash before
    // this point leaves the original's count unchanged (no burned retry).
    doDb.bulkUpdatePrompts(getSql(), sessionId, prompts);
    await host.notePromptTransition(sessionId, retryPrompt.promptId);
    doDb.updateSessionFields(getSql(), sessionId, { promptCounter: promptCounter + 1 });

    // Re-point the review-loop epoch's last_prompt_id from the dropped prompt to
    // the retry prompt (same epoch, new prompt id) so the publish/reply guard
    // accepts the retried run and its in-flight lease stays armed.
    const retryEpochId =
      typeof activePrompt.reviewLoopEpochId === "string" ? activePrompt.reviewLoopEpochId.trim() : "";
    if (retryEpochId && host.repointReviewLoopEpochPrompt) {
      try {
        await host.repointReviewLoopEpochPrompt(sessionId, retryEpochId, activePrompt.promptId, retryPrompt.promptId);
      } catch (error) {
        host.log.warn(
          {
            sessionId,
            epochId: retryEpochId,
            previousPromptId: activePrompt.promptId,
            nextPromptId: retryPrompt.promptId,
            error: String(error),
          },
          "Failed to re-point review-loop epoch prompt after sandbox-disconnect retry",
        );
      }
    }

    await storePromptDispatchPath(host.state, retryPrompt.promptId, "cold");
    await host.setPendingPromptDispatch(true);
    await host.startSpawnAttempt(sessionId, "spawnSandbox.sandboxDisconnect");

    const eventState = await host.appendAndMirrorEvents(sessionId, [
      {
        type: "prompt_retrying",
        timestamp,
        data: {
          sessionId,
          promptId: finalizedPromptId,
          retryPromptId: retryPrompt.promptId,
          attempt,
          cap: DISCONNECT_RETRY_CAP,
          reason: "sandbox_disconnected",
        },
      },
      {
        type: "prompt_enqueued",
        timestamp,
        data: { sessionId, promptId: retryPrompt.promptId, status: "queued" },
      },
      {
        type: "prompt_processing",
        timestamp,
        data: { sessionId, promptId: retryPrompt.promptId, status: "processing" },
      },
    ]);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    doDb.updateSession(getSql(), sessionId, {
      status: session.status,
      updatedAt: session.updatedAt,
      title: session.title,
    });
    logDurablePromptCloseComplete(host, {
      sessionId,
      promptId: finalizedPromptId,
      source: "sandbox_disconnect_retry",
      success: false,
      nextPromptId: retryPrompt.promptId,
    });
    markPlatformLlmPromptTerminal(sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId,
      prompt: activePrompt,
      session,
      reason: "sandbox_disconnect_retry",
      finalize: { telemetry: { errorCode: retryErrorCode } },
    });
    const disconnectRetryEvent = {
      event: "prompt_disconnect_retry",
      sessionId,
      promptId: finalizedPromptId,
      retryPromptId: retryPrompt.promptId,
      attempt,
      cap: DISCONNECT_RETRY_CAP,
      origin,
    };
    host.log.warn(disconnectRetryEvent, "Re-running prompt on a fresh sandbox after mid-turn sandbox disconnect");
    // Direct-post so disconnect-recovery stays queryable in Datadog even when
    // Workers Logs/logpush is unavailable (mirrors the ARC-1196 admit-decision
    // direct-post above). Detached via waitUntil; metadata only.
    host.waitUntil(postStructuredEventToDd(host.env, disconnectRetryEvent));
  }

  async function failActivePromptOnDisconnect(
    session: SessionState,
    activePromptId: string,
    origin: PromptDisconnectOrigin = "unknown",
  ): Promise<void> {
    const prompts = doDb.getPrompts(getSql(), session.sessionId);
    const activePrompt = prompts.find((prompt) => prompt.promptId === activePromptId);
    if (!activePrompt || activePrompt.status !== "processing") return;

    // A still-`processing` prompt is, by construction, pre-`execution_complete`:
    // handleExecutionComplete flips the prompt out of `processing` the moment a
    // successful turn lands, so the agent has not pushed yet and a clean re-run
    // is safe. Under cap (and only for a live session — an archived session must
    // not spawn fresh work), recover by re-running on a fresh sandbox instead of
    // failing the session. The passed `session` can be a stale snapshot from the
    // socket-close path, so read the archived flag fresh from D1.
    const liveStatus = doDb.getSession(getSql(), session.sessionId)?.status ?? session.status;
    // A user Stop wrote a marker (handleStopRequest) but left the prompt
    // `processing` while the sandbox acked the stop. If the sandbox dies inside
    // that window, retrying would resurrect work the user explicitly killed and
    // burn compute. Honor the stop: take the terminal branch, never retry.
    const stoppedBy = readPromptStoppedBy(await host.state.storage.get(PROMPT_STOPPED_BY_STORAGE_KEY));
    const userStopped = stoppedBy[activePromptId] === "user";
    const decision = decidePromptDisconnectRetry(activePrompt.disconnectRetryCount);
    if (liveStatus !== "archived" && !decision.retryCapReached && !userStopped) {
      await retryActivePromptAfterDisconnect(session, prompts, activePrompt, decision.nextRetryCount, origin);
      return;
    }

    const timestamp = nowIso();
    activePrompt.status = "failed";
    // The terminal path is reached two ways: disconnect-retry cap exhausted, or
    // a disconnect on an archived session (which never retries). Only the former
    // is a "kept disconnecting" exhaustion, surfaced under a distinct error code
    // so UI/Slack/telemetry can tell "we re-ran and it kept dying" apart from a
    // single archived-disconnect terminal.
    const terminalErrorCode: ErrorCode = userStopped
      ? "aborted"
      : origin === "sandbox_never_started"
        ? "sandbox_never_started"
        : decision.retryCapReached
          ? "sandbox_disconnected_exhausted"
          : "sandbox_disconnected";
    activePrompt.error = userStopped
      ? "Stopped by user"
      : origin === "sandbox_never_started"
        ? decision.retryCapReached
          ? `Sandbox never started the prompt after ${decision.retryCount + 1} attempts`
          : "Sandbox went away before the prompt started running"
        : decision.retryCapReached
          ? `Sandbox kept disconnecting after ${decision.retryCount + 1} attempts`
          : "Sandbox disconnected while processing";
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId: session.sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    doDb.updatePrompt(getSql(), activePrompt.promptId, { hasPendingQuestion: false });
    await host.setPendingPromptDispatch(false);

    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);

    // Fail-open plan→implement handoff: a plan turn that terminally fails from
    // disconnect-retry exhaustion must still hand off to an implementation prompt,
    // matching handleSpawnTimeout's retry-cap branch and the other terminal paths.
    // Gate on a live, non-user-stopped session: an archived session is being torn
    // down, and a user Stop must not resurrect the turn the user killed (mirrors the
    // retry gate above). Reaching this terminal branch while live and non-stopped
    // implies the disconnect cap was exhausted. maybeEnqueueImplementationAfterPlan
    // splices a `queued` implementation prompt into `prompts`, which the promotion
    // below picks up and spawns.
    const finalizedWasPlanPrompt = isPlanModePlanPrompt(session, activePrompt);
    let planHandoff: PlanHandoffResult = { kind: "none" };
    if (finalizedWasPlanPrompt && liveStatus !== "archived" && !userStopped) {
      planHandoff = await maybeEnqueueImplementationAfterPlan({
        host,
        sql: getSql(),
        session,
        prompts,
        planPrompt: activePrompt,
        timestamp,
        success: false,
      });
    }

    let newActivePromptId: string | null = null;
    // Gate promotion on the fresh `liveStatus`, not the (possibly stale) snapshot
    // `session.status` from the socket-close path. If the session was archived
    // after the snapshot was taken, the stale value still reads "active" and would
    // promote a queued prompt to `processing` with a spawn the reducer fail-closes,
    // stranding the row in `processing` forever. Mirror the archived retry gate above.
    const nextPrompt =
      liveStatus !== "archived" && planHandoff.kind !== "parked"
        ? prompts.find((prompt) => prompt.status === "queued")
        : null;
    if (nextPrompt) {
      nextPrompt.status = "processing";
      if (!nextPrompt.startedAt) nextPrompt.startedAt = timestamp;
      nextPrompt.updatedAt = timestamp;
      newActivePromptId = nextPrompt.promptId;

      await storePromptDispatchPath(host.state, nextPrompt.promptId, "cold");
      await host.setPendingPromptDispatch(true);
      // notePromptTransition is deferred until after bulkUpdatePrompts
      // persists the in-memory status flips (below). See the matching
      // comment in handleSpawnTimeout for the rationale.
      await host.startSpawnAttempt(session.sessionId, "spawnSandbox.sandboxDisconnect");
    }

    // Persist terminal and queued-prompt promotion before rich-status projection.
    // Alarm retries must not see this prompt as still processing if D1 projection
    // fails inside setHasPendingQuestion(false), and projection must still see a
    // promoted follow-up prompt as running.
    doDb.bulkUpdatePrompts(getSql(), session.sessionId, prompts);
    await host.setHasPendingQuestion(false);

    const eventEntries: DurableEntry[] = [
      // When we hand off to an implementation prompt the session is continuing to
      // implementation, so a session-level error would be misleading; suppress it
      // (mirrors handleSpawnTimeout). Non-handoff terminals (user-stop, archived,
      // and all non-plan prompts) keep the session_error.
      ...(planHandoff.kind !== "none"
        ? []
        : [
            {
              type: "session_error",
              timestamp,
              data: { error: activePrompt.error, code: terminalErrorCode, promptId: activePrompt.promptId },
            } satisfies DurableEntry,
          ]),
      {
        type: "prompt_failed",
        timestamp,
        data: {
          sessionId: session.sessionId,
          promptId: activePrompt.promptId,
          status: "failed",
          error: activePrompt.error,
          errorCode: terminalErrorCode,
        },
      },
    ];
    if (planHandoff.kind === "spliced") {
      eventEntries.push(planHandoff.promptEnqueuedEvent);
    }
    if (nextPrompt) {
      eventEntries.push({
        type: "prompt_processing",
        timestamp,
        data: { sessionId: session.sessionId, promptId: nextPrompt.promptId, status: "processing" },
      });
    }

    const eventState = await host.appendAndMirrorEvents(session.sessionId, eventEntries);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;

    doDb.updateSession(getSql(), session.sessionId, {
      status: session.status,
      updatedAt: session.updatedAt,
      title: session.title,
    });
    // Always reproject after persist so the derived helper inside
    // notePromptTransition reads the fresh prompts.status row.
    await host.notePromptTransition(session.sessionId, newActivePromptId);
    logDurablePromptCloseComplete(host, {
      sessionId: session.sessionId,
      promptId: finalizedPromptId,
      source: "sandbox_disconnected",
      success: false,
      nextPromptId: newActivePromptId,
    });
    markPlatformLlmPromptTerminal(session.sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId: session.sessionId,
      prompt: activePrompt,
      session,
      reason: "sandbox_disconnected",
      // A plan turn that handed off to implementation should not trigger the
      // memory-review bot on its failed plan prompt (mirrors handleSpawnTimeout).
      ...(planHandoff.kind !== "none" ? { suppressMemoryReviewBot: true } : {}),
      finalize: { telemetry: { errorCode: terminalErrorCode } },
    });
    doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode: terminalErrorCode });
    if (!newActivePromptId) {
      await handleStoppedVerificationOutcome(
        host,
        getSql(),
        session,
        finalizedPromptId,
        userStopped ? "manual_stop" : liveStatus === "archived" ? "archived" : "unexpected_terminal",
      );
    }

    const disconnectTerminalEvent = {
      event: decision.retryCapReached ? "prompt_disconnect_retry_exhausted" : "prompt_failed_sandbox_disconnect",
      sessionId: session.sessionId,
      promptId: finalizedPromptId,
      origin,
      ...(decision.retryCapReached ? { attempts: decision.retryCount + 1, cap: DISCONNECT_RETRY_CAP } : {}),
    };
    host.log.warn(
      disconnectTerminalEvent,
      decision.retryCapReached
        ? "Active prompt failed: sandbox kept disconnecting after exhausting disconnect retries"
        : "Active prompt failed due to sandbox disconnect",
    );
    // Direct-post the disconnect-terminal outcome so exhaustion vs. under-cap
    // failure is queryable in Datadog (Workers Logs/logpush may be
    // unavailable). Detached via waitUntil; metadata only.
    host.waitUntil(postStructuredEventToDd(host.env, disconnectTerminalEvent));
  }

  // Archive-time prompt failure. The archive path must finalize any
  // still-processing prompt before flipping session.status to "archived":
  // otherwise the partial unique index `idx_prompts_one_processing` would
  // reject the next prompt and the max-duration alarm would later fire on
  // an archived session, writing a spurious failure. Emits the canonical
  // prompt_failed durable event so replay/UI stay consistent, then clears
  // active_prompt_id. Does not start a queued next prompt -- archive means
  // no more work on this session.
  async function failActivePromptForArchive(
    session: SessionState,
    activePromptId: string,
    reason: string,
  ): Promise<void> {
    const prompts = doDb.getPrompts(getSql(), session.sessionId);
    const activePrompt = prompts.find((prompt) => prompt.promptId === activePromptId);
    if (!activePrompt || activePrompt.status !== "processing") return;

    const timestamp = nowIso();
    activePrompt.status = "failed";
    activePrompt.error = `Session archived while processing: ${reason}`;
    activePrompt.completedAt = timestamp;
    activePrompt.updatedAt = timestamp;
    clearPromptActivityForPrompt({
      sql: getSql(),
      env: host.env,
      sessionId: session.sessionId,
      expectedPromptId: activePrompt.promptId,
      logger: host.log,
      waitUntil: host.waitUntil,
    });
    await host.setHasPendingQuestion(false);
    await host.setPendingPromptDispatch(false);

    const finalizedPromptId = activePrompt.promptId;
    await clearPromptMarkers(host.state, finalizedPromptId);

    const eventEntries: DurableEntry[] = [
      {
        type: "session_error",
        timestamp,
        data: { error: activePrompt.error, code: "session_archived", promptId: activePrompt.promptId },
      },
      {
        type: "prompt_failed",
        timestamp,
        data: {
          sessionId: session.sessionId,
          promptId: activePrompt.promptId,
          status: "failed",
          error: activePrompt.error,
          errorCode: "session_archived",
        },
      },
    ];

    const eventState = await host.appendAndMirrorEvents(session.sessionId, eventEntries);
    session.updatedAt = timestamp;
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;

    doDb.bulkUpdatePrompts(getSql(), session.sessionId, prompts);
    await host.notePromptTransition(session.sessionId, null);

    logDurablePromptCloseComplete(host, {
      sessionId: session.sessionId,
      promptId: finalizedPromptId,
      source: "session_archived",
      success: false,
      nextPromptId: null,
    });
    markPlatformLlmPromptTerminal(session.sessionId, finalizedPromptId);
    schedulePromptTerminalSideEffects(host, {
      sessionId: session.sessionId,
      prompt: activePrompt,
      session,
      reason: "session_archived",
      finalize: { telemetry: { errorCode: "session_archived" } },
    });
    doDb.upsertPromptTelemetry(getSql(), finalizedPromptId, { errorCode: "session_archived" });
    await handleStoppedVerificationOutcome(host, getSql(), session, finalizedPromptId, "archived");

    host.log.warn(
      {
        event: "prompt_failed_session_archived",
        sessionId: session.sessionId,
        promptId: finalizedPromptId,
        reason,
      },
      "Active prompt failed due to session archive",
    );
  }

  async function sendPendingPromptToSandbox(sessionId: string): Promise<boolean> {
    const session = doDb.getSession(getSql(), sessionId);
    const sendSbState = doDb.getSandboxState(getSql(), sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    const sandboxSocket = host.getSandboxSocket();
    if (!activePromptId || !sandboxSocket || !session) {
      host.log.info(
        { sessionId, activePromptId, hasSandbox: Boolean(sandboxSocket) },
        "No pending prompt to send on sandbox connect",
      );
      return false;
    }

    const prompts = doDb.getPrompts(getSql(), sessionId);
    const activePrompt = prompts.find((prompt) => prompt.promptId === activePromptId);
    if (!activePrompt || activePrompt.status !== "processing") {
      host.log.warn(
        { sessionId, activePromptId, found: Boolean(activePrompt), status: activePrompt?.status },
        "Active prompt not in processing state",
      );
      return false;
    }

    const shouldDispatch = sendSbState?.pendingPromptDispatch === true || sendSbState?.status === "spawning";
    if (!shouldDispatch) {
      host.log.info(
        { sessionId, activePromptId },
        "Skipping pending prompt dispatch: prompt already running in sandbox",
      );
      return false;
    }

    const command = await buildPromptCommandForDispatch(host, getSql(), activePrompt, session);
    await host.state.storage.delete(["company_memory_context", "company_memory_target_prompt", "company_memory_usage"]);

    host.log.info({ sessionId, promptId: activePrompt.promptId }, "Sending pending prompt to sandbox");
    await host.setPendingPromptDispatch(false);
    await host.sendToSandbox(command);
    await emitStoredPromptQueueWaitEvent(host, session, activePrompt);
    return host.getSandboxSocket() !== null;
  }

  /**
   * Redeliver a persisted answer to the bridge after a reconnect (9.3). The
   * `respond` command is fire-and-forget over the sandbox socket and the question
   * is cleared (`hasPendingQuestion = false`) the moment the user answers, so a
   * `respond` frame lost to a mid-flight disconnect (or a DO eviction that races
   * the send) would otherwise strand the bridge on `await answerPromise` forever:
   * the question is never replayed and a retry POST is rejected with "No pending
   * question". The stored answer is dropped once its owning prompt goes terminal
   * (`clearPromptMarkers`) or here when it no longer matches the active processing
   * prompt. Redelivery is idempotent on the bridge: a `respond` for an
   * already-resolved question is a benign no-op, so an over-eager replay never
   * errors or double-answers.
   */
  async function sendPendingAnswerToSandbox(sessionId: string): Promise<void> {
    const pending = (await host.state.storage.get(PENDING_ANSWER_STORAGE_KEY)) as PendingAnswerRecord | undefined;
    if (!pending) return;
    const activePromptId = doDb.getActiveProcessingPromptId(getSql(), sessionId);
    const activePrompt = activePromptId ? doDb.getPrompt(getSql(), activePromptId) : null;
    if (!activePrompt || activePrompt.promptId !== pending.promptId || activePrompt.status !== "processing") {
      // The owning prompt is gone or terminal: the answer can never land, so drop
      // it rather than redeliver to an unrelated prompt's bridge.
      await host.state.storage.delete(PENDING_ANSWER_STORAGE_KEY);
      return;
    }
    host.log.info(
      { event: "pending_answer_redelivered_on_reconnect", sessionId, promptId: pending.promptId },
      "Redelivering pending answer to reconnected bridge",
    );
    await host.sendToSandbox({ type: "respond", answer: pending.answer, requestId: pending.questionId });
  }

  return {
    handlePromptEnqueueRequest,
    handlePromptCallbackRequest,
    handleStopRequest,
    handleRespondRequest,
    handlePlanApproveRequest,
    handleRetryRequest,
    handleSessionIdle,
    completeActivePrompt,
    failQueuedPrompts,
    handleExecutionComplete,
    handlePostExecution,
    handleSpawnTimeout,
    handleSpawnFailure,
    failActivePromptOnDisconnect,
    failActivePromptForArchive,
    sendPendingPromptToSandbox,
    sendPendingAnswerToSandbox,
  };
}
