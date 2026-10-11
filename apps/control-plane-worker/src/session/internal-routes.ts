import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import type { AgentConfig } from "../../../../shared/agent/schema.js";
import type {
  AgentRole,
  HarnessKind,
  RuntimeStartupProfile,
  VerificationRuntimeMode,
} from "../../../../shared/agent/schema.js";
import type { IntegrationId } from "../../../../shared/constants/integration-helpers.js";
import type {
  IntegrationLifecycleReasonCode,
  IntegrationLifecycleStage,
  IntegrationLifecycleStatus,
} from "../../../../shared/enums/integration-lifecycle.js";
import type { EstimatedInputCompositionRecord } from "../../../../shared/events/bridge.js";
import type {
  PlatformLlmCallPlan,
  PlatformLlmCallType,
  PlatformLlmPhase,
  PlatformLlmResponse,
} from "../../../../shared/llm/platform-llm-contract.js";
import type {
  DesktopActionPathSnapshotResponse,
  RegisterDesktopActionPathRowRequest,
  RegisterDesktopActionPathRowResponse,
} from "../../../../shared/types/desktop-action-path.js";
import type {
  DesktopViewTicket,
  DesktopViewTicketCloseRequest,
  DesktopViewTicketCloseResponse,
  DesktopViewTicketConnectRequest,
  DesktopViewTicketConnectResponse,
  DesktopViewTicketHeartbeatRequest,
  DesktopViewTicketHeartbeatResponse,
  DesktopViewTicketRevokeRequest,
  DesktopViewTicketRevokeResponse,
  DesktopViewTicketStatusRequest,
  DesktopViewTicketStatusResponse,
} from "../../../../shared/types/desktop-viewer.js";
import type {
  AppRuntimeProfileDiagnostic,
  AppRuntimeProfileSource,
  PreviewContract,
  ReviewLoopPromptSourceKind,
  SandboxRuntimeBackend,
  UploadedFile,
  UploadedImage,
} from "../../../../shared/types/sandbox.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import type { SessionReplayEvent, SessionReplayResponse } from "../../../../shared/types/session-replay.js";
import type { InitiationMode } from "../enums/initiation-mode.js";
import type { SessionEntrypoint } from "../enums/session-entrypoint.js";
import type { SlackQuotedReplySource } from "../slack/blocks";
import type {
  SlackDynamicToolRouteResponse,
  SlackGetThreadInput,
  SlackGetThreadResult,
  SlackSearchMessagesInput,
  SlackSearchMessagesResult,
  SlackSendMessageInput,
  SlackSendMessageResult,
} from "../slack/dynamic-tools";
import type {
  CallbackContext,
  CallbackPayload,
  EnqueuePayload,
  EventsPayload,
  GithubIssueContext,
  LinearContext,
  PromptListPayload,
  ReplayState,
  SessionDOResponse,
  SessionState,
  SessionViewPayload,
} from "../types";
import type { ReadPrContents } from "./pr-github-ops";

export const SESSION_INTERNAL_ORIGIN = "https://internal";

export interface SessionFetchResult<T> {
  status: number;
  ok: boolean;
  payload: T | null;
}

export type SessionFetchResultWithError<T> = SessionFetchResult<T> & {
  error: string | null;
  // Sibling field to `error` on structured-error rejections. Lifted from the DO
  // response body alongside `error` so callers can surface a phase-aware
  // message (e.g. 409 `{ error: "session_not_sendable", reason: "blocked" }`).
  reason?: string | null;
  // Structured detail object lifted from the DO rejection body for callers that
  // need machine-readable fields beyond the `error`/`reason` strings (e.g. the
  // review-loop sweep adopting the surviving prompt on a duplicate-epoch reject).
  errorDetails?: Record<string, unknown> | null;
};

/**
 * The DO prompt-enqueue rejects a second prompt for a review-loop epoch that
 * already has an active prompt. On a mid-dispatch crash the first sweep enqueued
 * the prompt but died before marking the epoch enqueued; the re-sweep would
 * otherwise mint a duplicate. The reject carries `errorDetails.existingPromptId`
 * /`existingPromptStatus` so the sweep adopts the surviving prompt instead.
 */
export const REVIEW_LOOP_EPOCH_ACTIVE_PROMPT_ERROR = "review_loop_epoch_active_prompt";

export interface RepoContext {
  repoOwner?: string;
  repoName?: string;
  baseBranch?: string;
  /**
   * Optional create-time "resume this existing branch" target. Distinct from
   * baseBranch (the PR merge target): when set, the sandbox checks out this
   * branch with its history on the initial spawn instead of forking off base.
   */
  startBranch?: string;
}

export type SessionKind = "repo";

export interface InitializeSessionRequest extends RepoContext {
  sessionId: string;
  ownerUserId: string;
  businessId: string;
  agentOverrides?: Record<string, Record<string, unknown>>;
  callbackContext?: CallbackContext;
  prUrl?: string | null;
  prNumber?: number | null;
  installationId?: number;
  model?: string;
  reasoningEffort?: string;
  useOpenAIFlexServiceTier?: boolean;
  agentRuntimeBackend?: AgentRuntimeBackend;
  linearContext?: LinearContext;
  githubIssueContext?: GithubIssueContext;
  agentRole?: AgentRole;
  agentProfile?: string;
  harnessKind?: HarnessKind;
  runtimeStartupProfile?: RuntimeStartupProfile;
  verificationRuntimeMode?: VerificationRuntimeMode;
  targetPrUrl?: string | null;
  autoVerify?: boolean;
  planMode?: boolean;
  planApprovalRequired?: boolean;
  planAutoReason?: string | null;
  adoptedExternalPr?: boolean;
  runtimePreviewContract?: PreviewContract;
  runtimePreviewSource?: AppRuntimeProfileSource;
  runtimePreviewDiagnostics?: AppRuntimeProfileDiagnostic[];
  runtimeBackend?: SandboxRuntimeBackend;
  initiationMode?: InitiationMode;
  entrypoint: SessionEntrypoint;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
}

export interface InitializeSessionResponse {
  ok: true;
  session: SessionState;
  replay: ReplayState;
}

interface GetSessionStateResponse {
  ok: true;
  session: SessionState;
}

export interface GetSessionPlanResponse {
  status: SessionPlanStatus;
  revision: number;
  markdown: string | null;
  userEdited: boolean;
  updatedAt: string;
  planPromptId: string;
}

export interface CloseSessionRequest {
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface CloseSessionResponse {
  ok: true;
  session: SessionState;
  replay: ReplayState | null;
}

export interface BroadcastSessionSnapshotResponse {
  ok: true;
}

export interface EnqueueSessionPromptRequest {
  prompt: string;
  source?: "web" | "slack";
  replyToText?: string;
  replyToQuoteSource?: SlackQuotedReplySource | null;
  actorUserId?: string | null;
  agent?: string;
  skills?: string[];
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
  reviewLoopEpochId?: string;
  reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
  /**
   * ARC-1330 §17-A (PR 47) — the FSM run-identity token for a VERIFIER prompt: the committed
   * `verification_run_id` the spawn side-effect threads through the auto-scheduler. The child DO
   * persists it PER PROMPT (verifier-session reuse serves multiple runs, so the token must ride the
   * prompt, not the session) and echoes it back on the terminal `VerifierTerminalResult`, closing the
   * run-scoped verdict-freshness loop (a superseded run's late verdict carries the OLD token and is
   * ghost-discarded). Absent on every non-verifier prompt.
   */
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationRunId?: number;
  /** Coordinator session that owns verifier terminal verdicts when display parentage differs. */
  verificationCoordinatorSessionId?: string;
}

export interface CompleteSessionPromptRequest {
  promptId: string;
  success?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ListSessionEventsQuery {
  afterSequence: number;
  limit: number;
}

interface OpenSessionWebSocketQuery {
  afterSequence: number;
}

interface OpenSandboxWebSocketQuery {
  type: "sandbox";
  sandboxId: string;
}

export interface StopSessionResponse {
  ok: boolean;
  sessionId?: string;
  status?: string;
  error?: string;
}

export interface RespondToSessionRequest {
  answer: string;
  questionId?: string;
}

export interface RespondToSessionResponse {
  ok: boolean;
  error?: string;
}

export interface ApproveSessionPlanRequest {
  revision: number;
  actorUserId: string;
  source: "web" | "slack";
}

export interface ApproveSessionPlanResponse {
  ok: true;
  revision: number;
  implementationPromptId: string;
  idempotent: boolean;
}

export interface EditSessionPlanRequest {
  revision: number;
  markdown: string;
  actorUserId: string;
  source: "web";
}

export type EditSessionPlanResponse = {
  ok: true;
  planApprovalPending: true;
  revision: number;
  status: "pending";
};

export interface ReviewLoopReplyRequest {
  promptId?: string;
  epochId: string;
  targetSourceId: string;
  verdict: "fixed" | "replied" | "declined";
  body: string;
}

export type ReviewLoopReplyResponse =
  | { ok: true; status: "replied" | "already_replied"; operationId: string; githubId: string | null }
  | { ok: false; reason: string; operationId?: string; retryable?: boolean };

export interface UpdatePrTitleRequest {
  title: string;
}

export type UpdatePrTitleResponse =
  | { ok: true; outcome: "applied" | "noop" | "queued" }
  | { ok: false; outcome: "skipped_manual_rename" | "invalid" | "error"; error: string };

export interface ClosePrRequest {
  prUrl?: string;
}
export type ClosePrResponse =
  | { ok: true; outcome: "closed"; prUrl: string; prNumber: number }
  | { ok: false; outcome: "invalid" | "no_pr" | "forbidden" | "error"; error: string };

export interface ReadPrRequest {
  prUrl?: string;
}
export type ReadPrResponse =
  ({ ok: true } & ReadPrContents) | { ok: false; outcome: "invalid" | "no_pr" | "forbidden" | "error"; error: string };

export interface RecordAgentTicketKeyRequest {
  ticketKey: string;
}

export type RecordAgentTicketKeyResponse =
  | { ok: true; outcome: "set" | "already_present" }
  | { ok: false; outcome: "invalid" | "session_not_found"; error: string };

export interface RecordSessionIntegrationLifecycleRequest {
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: IntegrationLifecycleStatus;
  reasonCode?: IntegrationLifecycleReasonCode | null;
  message: string;
  details?: Record<string, unknown> | null;
  latencyMs?: number;
}

export interface RecordSessionIntegrationLifecycleResponse {
  ok: true;
  recorded: boolean;
}

export interface GetSessionUsageResponse {
  ok: boolean;
  usage?: Record<string, unknown> | null;
}

export interface GetSessionInputCompositionResponse {
  ok: boolean;
  inputComposition?: Record<string, EstimatedInputCompositionRecord> | null;
}

export interface GetSessionSandboxStateResponse {
  ok: boolean;
  sandboxState?: Record<string, unknown> | null;
  deadlines?: Record<string, number | null>;
}

export interface ListSessionArtifactsResponse {
  ok: boolean;
  artifacts?: unknown[];
  /**
   * Session identity needed for worker-side authorization (owner/business/repo
   * context). Carried alongside `artifacts` so the worker can authorize in a
   * single DO hop instead of a prior `getSessionState` call. Built by the DO via
   * `buildSessionDoResponse`, the same source `/session/state` (`getSessionState`)
   * uses, so repo-access parity is byte-identical.
   */
  session?: SessionDOResponse;
}

export interface WarmSessionResponse {
  ok: boolean;
  status?: string;
  error?: string;
}

export interface RevokeSessionArtifactResponse {
  ok: boolean;
  error?: string;
}

export interface ArchiveClosePrResponse {
  ok: true;
  prClose:
    | { attempted: false; closed: false; warning?: string }
    | { attempted: true; closed: true; warning?: string }
    | { attempted: true; closed: false; warning: string };
}

export interface GetSessionContextResponse {
  ok: boolean;
  context?: Record<string, unknown>;
  error?: string;
}

export type GetSessionExportResponse = Record<string, unknown>;

export interface SetSessionRepoRequest {
  repoOwner: string;
  repoName: string;
  baseBranch?: string;
  installationId?: number;
}

export interface SetSessionRepoResponse {
  ok: boolean;
  error?: string;
}

export type UpdateSessionCallbackContextRequest = CallbackContext;

export interface UpdateSessionCallbackContextResponse {
  ok: true;
}

export interface UpdateSessionReviewListeningHeadRequest {
  prUrl: string;
  currentHeadSha: string;
}

export interface UpdateSessionReviewListeningHeadResponse {
  ok: boolean;
  updated?: boolean;
  reason?: string;
}

export interface UpdateSessionPrDraftRequest {
  prUrl: string;
  draft: boolean;
  manualReviewReason?: string | null;
}

export interface UpdateSessionPrDraftResponse {
  ok: boolean;
  updated?: boolean;
  reason?: string;
}

export interface UpdateSessionVerificationStateRequest {
  requestId: string;
  state: import("../../../../shared/session/phase.js").VerificationState | null;
  attemptCount: number;
  maxAttempts: number;
  // Head-change reset only: lift the exhausted-state lock for a null write. `runBaseline` is a legacy
  // no-longer-read field retained for stored session compatibility.
  allowExhaustedClear?: boolean;
  runBaseline?: number;
  // ARC-1243 follow-up: stamp the head SHA the (preserved) verdict is validated for on a content
  // no-op head advance. Written independently of the state-preserve decision.
  verdictHeadSha?: string | null;
}

export interface UpdateSessionVerificationStateResponse {
  ok: boolean;
  updated: boolean;
}

export interface UpdateSessionVerificationResultRequest {
  requestId: string;
  result: import("../../../../shared/session/phase.js").VerificationResult | null;
  needsWorkLabel?: import("../../../../shared/types/sandbox.js").VerificationNeedsWorkLabel | null;
  qaRun?: import("../../../../shared/types/qa-run.js").QaRunTerminalSummary | null;
}

export interface UpdateSessionVerificationResultResponse {
  ok: boolean;
  updated: boolean;
}

export interface EnterSessionReviewListeningRequest {
  prUrl: string;
  currentHeadSha: string;
}

export interface EnterSessionReviewListeningResponse {
  ok: boolean;
  updated: boolean;
  reason?: string;
}

export interface NotifySessionPrMergedRequest {
  prUrl?: string;
}

export interface NotifySessionPrMergedResponse {
  ok: boolean;
  notified?: boolean;
  reason?: string;
}

export interface NotifySessionPrClosedRequest {
  prUrl?: string;
  /** GitHub login of whoever closed the PR (unmerged). Null when unknown. */
  closedByLogin?: string | null;
}

export interface NotifySessionPrClosedResponse {
  ok: boolean;
  notified?: boolean;
  reason?: string;
}

interface RetrySessionResponse extends EnqueuePayload {}

interface WakeSlackRetryResponse {
  ok: true;
}

export interface ValidatePlatformLlmCapabilityRequest {
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  inputBytes: number;
}

type ValidatePlatformLlmCapabilityResponse = { ok: true; plan: PlatformLlmCallPlan } | PlatformLlmResponse<never>;

interface GetSessionReplayResponse {
  ok: boolean;
  replay: ReplayState | { sessionId: null; lastEventSequence: 0; lastEventTimestamp: null; updatedAt: null };
}

interface GetSessionAgentsResponse {
  ok: boolean;
  agents: Record<string, AgentConfig>;
}

export interface SessionInternalRouteMap {
  state: {
    method: "GET";
    path: "/session/state";
    request: undefined;
    response: GetSessionStateResponse;
  };
  view: {
    method: "GET";
    path: "/session/view";
    request: undefined;
    response: SessionViewPayload;
  };
  plan: {
    method: "GET";
    path: "/session/plan";
    request: undefined;
    response: GetSessionPlanResponse;
  };
  initialize: {
    method: "POST";
    path: "/session/initialize";
    request: InitializeSessionRequest;
    response: InitializeSessionResponse;
  };
  callbackContext: {
    method: "PUT";
    path: "/session/callback-context";
    request: UpdateSessionCallbackContextRequest;
    response: UpdateSessionCallbackContextResponse;
  };
  repo: {
    method: "PUT";
    path: "/session/repo";
    request: SetSessionRepoRequest;
    response: SetSessionRepoResponse;
  };
  notifyPrMerged: {
    method: "POST";
    path: "/session/notify-pr-merged";
    request: NotifySessionPrMergedRequest;
    response: NotifySessionPrMergedResponse;
  };
  notifyPrClosed: {
    method: "POST";
    path: "/session/notify-pr-closed";
    request: NotifySessionPrClosedRequest;
    response: NotifySessionPrClosedResponse;
  };
  close: {
    method: "POST";
    path: "/session/close";
    request: CloseSessionRequest;
    response: CloseSessionResponse;
  };
  broadcastSnapshot: {
    method: "POST";
    path: "/session/broadcast-snapshot";
    request: undefined;
    response: BroadcastSessionSnapshotResponse;
  };

  reviewListeningHead: {
    method: "POST";
    path: "/session/review-listening/head";
    request: UpdateSessionReviewListeningHeadRequest;
    response: UpdateSessionReviewListeningHeadResponse;
  };
  prDraft: {
    method: "POST";
    path: "/session/pr-draft";
    request: UpdateSessionPrDraftRequest;
    response: UpdateSessionPrDraftResponse;
  };
  reviewListeningEnter: {
    method: "POST";
    path: "/session/review-listening/enter";
    request: EnterSessionReviewListeningRequest;
    response: EnterSessionReviewListeningResponse;
  };
  verificationState: {
    method: "POST";
    path: "/session/verification/state";
    request: UpdateSessionVerificationStateRequest;
    response: UpdateSessionVerificationStateResponse;
  };
  verificationResult: {
    method: "POST";
    path: "/session/verification/result";
    request: UpdateSessionVerificationResultRequest;
    response: UpdateSessionVerificationResultResponse;
  };
  sandboxState: {
    method: "GET";
    path: "/session/sandbox-state";
    request: undefined;
    response: GetSessionSandboxStateResponse;
  };
  artifactsList: {
    method: "GET";
    path: "/session/artifacts/list";
    request: undefined;
    response: ListSessionArtifactsResponse;
  };
  desktopActionPathSnapshot: {
    method: "GET";
    path: "/session/desktop/action-path";
    request: undefined;
    response: DesktopActionPathSnapshotResponse;
  };
  desktopActionPathRegister: {
    method: "POST";
    path: "/session/desktop/action-path/register";
    request: RegisterDesktopActionPathRowRequest;
    response: RegisterDesktopActionPathRowResponse;
  };
  desktopViewTicketCreate: {
    method: "POST";
    path: "/session/desktop/view-ticket";
    request: undefined;
    response: { ok: true; ticket: DesktopViewTicket };
  };
  desktopViewTicketHeartbeat: {
    method: "POST";
    path: "/session/desktop/view-ticket/heartbeat";
    request: DesktopViewTicketHeartbeatRequest;
    response: DesktopViewTicketHeartbeatResponse;
  };
  desktopViewTicketRevoke: {
    method: "POST";
    path: "/session/desktop/view-ticket/revoke";
    request: DesktopViewTicketRevokeRequest;
    response: DesktopViewTicketRevokeResponse;
  };
  desktopViewTicketStatus: {
    method: "POST";
    path: "/session/desktop/view-ticket/status";
    request: DesktopViewTicketStatusRequest;
    response: DesktopViewTicketStatusResponse;
  };
  desktopViewTicketConnect: {
    method: "POST";
    path: "/session/desktop/view-ticket/connect";
    request: DesktopViewTicketConnectRequest;
    response: DesktopViewTicketConnectResponse;
  };
  desktopViewTicketClose: {
    method: "POST";
    path: "/session/desktop/view-ticket/close";
    request: DesktopViewTicketCloseRequest;
    response: DesktopViewTicketCloseResponse;
  };
  replay: {
    method: "GET";
    path: "/session/replay";
    request: undefined;
    response: GetSessionReplayResponse;
  };
  events: {
    method: "GET";
    path: "/session/events";
    request: ListSessionEventsQuery;
    response: EventsPayload;
  };
  webSocket: {
    method: "GET";
    path: "/session/ws";
    request: OpenSessionWebSocketQuery | OpenSandboxWebSocketQuery;
    response: Response;
  };
  prompts: {
    method: "GET";
    path: "/session/prompts";
    request: undefined;
    response: PromptListPayload;
  };
  promptsEnqueue: {
    method: "POST";
    path: "/session/prompts/enqueue";
    request: EnqueueSessionPromptRequest;
    response: EnqueuePayload;
  };
  promptsCallback: {
    method: "POST";
    path: "/session/prompts/callback";
    request: CompleteSessionPromptRequest;
    response: CallbackPayload;
  };
  planApprove: {
    method: "POST";
    path: "/session/plan/approve";
    request: ApproveSessionPlanRequest;
    response: ApproveSessionPlanResponse;
  };
  stop: {
    method: "POST";
    path: "/session/stop";
    request: undefined;
    response: StopSessionResponse;
  };
  respond: {
    method: "POST";
    path: "/session/respond";
    request: RespondToSessionRequest;
    response: RespondToSessionResponse;
  };
  planEdit: {
    method: "PUT";
    path: "/session/plan";
    request: EditSessionPlanRequest;
    response: EditSessionPlanResponse;
  };
  usage: {
    method: "GET";
    path: "/session/usage";
    request: undefined;
    response: GetSessionUsageResponse;
  };
  inputComposition: {
    method: "GET";
    path: "/session/input-composition";
    request: undefined;
    response: GetSessionInputCompositionResponse;
  };
  warm: {
    method: "POST";
    path: "/session/warm";
    request: undefined;
    response: WarmSessionResponse;
  };
  retry: {
    method: "POST";
    path: "/session/retry";
    request: undefined;
    response: RetrySessionResponse;
  };
  slackRetryWake: {
    method: "POST";
    path: "/session/slack/retry-wake";
    request: undefined;
    response: WakeSlackRetryResponse;
  };
  eventsHistory: {
    method: "GET";
    path: "/session/events/history";
    request: {
      promptId?: string;
      afterSequence?: number;
      beforeSequence?: number;
      limit?: number;
    };
    response: SessionReplayResponse;
  };
  eventsBootstrap: {
    method: "GET";
    path: "/session/events/bootstrap";
    request: { promptIds: string[] };
    response: {
      ok: true;
      results: Record<string, { events: SessionReplayEvent[]; hasMore: boolean }>;
    };
  };
  context: {
    method: "GET";
    path: "/session/context";
    request: undefined;
    response: GetSessionContextResponse;
  };
  export: {
    method: "GET";
    path: "/session/export";
    request: undefined;
    response: GetSessionExportResponse;
  };
  reviewLoopReply: {
    method: "POST";
    path: "/session/review-loop/reply";
    request: ReviewLoopReplyRequest;
    response: ReviewLoopReplyResponse;
  };
  reviewLoopRecordPush: {
    method: "POST";
    path: "/session/review-loop/record-push";
    request: { pushedHead: string; branch?: string };
    response: { ok: true; recordedEpochs: number };
  };
  reviewLoopSummaryComment: {
    method: "POST";
    path: "/session/review-loop/summary-comment";
    request: { epochId: string; headSha: string; body: string; promptId?: string };
    response: { ok: true; githubCommentId: number };
  };
  updatePrTitle: {
    method: "POST";
    path: "/session/pr-title";
    request: UpdatePrTitleRequest;
    response: UpdatePrTitleResponse;
  };
  closePr: {
    method: "POST";
    path: "/session/pr-close";
    request: ClosePrRequest;
    response: ClosePrResponse;
  };
  archiveClosePr: {
    method: "POST";
    path: "/session/archive-close-pr";
    request: Record<string, never>;
    response: ArchiveClosePrResponse;
  };
  readPr: {
    method: "POST";
    path: "/session/pr-read";
    request: ReadPrRequest;
    response: ReadPrResponse;
  };
  recordAgentTicketKey: {
    method: "POST";
    path: "/session/ticket-key";
    request: RecordAgentTicketKeyRequest;
    response: RecordAgentTicketKeyResponse;
  };
  reviewLoopSummaryCommentPosted: {
    method: "POST";
    path: "/session/review-loop/summary-comment-posted";
    request: { epochId: string; githubCommentId: number };
    response: { ok: true };
  };
  artifactsUpload: {
    method: "POST";
    path: "/session/artifacts";
    request: BodyInit;
    response: Response;
  };
  rolloutUpload: {
    method: "PUT";
    path: "/session/rollout";
    request: BodyInit;
    response: Response;
  };
  rolloutDownload: {
    method: "GET";
    path: "/session/rollout";
    request: undefined;
    response: Response;
  };
  artifactsDelete: {
    method: "DELETE";
    path: "/session/artifacts";
    request: { artifactId: string };
    response: RevokeSessionArtifactResponse;
  };
  artifactsPublic: {
    method: "GET";
    path: "/session/artifacts";
    request: { artifactId: string; filename: string };
    response: Response;
  };
  artifactsAuthedView: {
    method: "GET";
    path: "/session/artifacts/view";
    request: { artifactId: string; filename: string };
    response: Response;
  };
  cloneToken: {
    method: "GET";
    path: "/session/clone-token";
    request: undefined;
    response: Response;
  };
  githubToken: {
    method: "GET";
    path: "/session/github-token";
    request: undefined;
    response: Response;
  };
  githubAction: {
    method: "POST";
    path: "/session/github-action";
    request: { argv: string[] };
    response: Response;
  };
  cliAuthToken: {
    method: "GET";
    path: "/session/cli-auth-token";
    request: undefined;
    response: Response;
  };
  authorizeChildSession: {
    method: "POST";
    path: "/session/child-sessions/authorize";
    request: undefined;
    response: { ok: true; ownerUserId: string; businessId: string | null; agentRole: AgentRole | null };
  };
  publishPrReview: {
    method: "POST";
    path: "/session/pr-review/publish";
    request: Record<string, unknown>;
    response: Response;
  };
  slackGetThread: {
    method: "POST";
    path: "/session/slack/get-thread";
    request: SlackGetThreadInput;
    response: SlackDynamicToolRouteResponse<SlackGetThreadResult>;
  };
  slackSearchMessages: {
    method: "POST";
    path: "/session/slack/search-messages";
    request: SlackSearchMessagesInput;
    response: SlackDynamicToolRouteResponse<SlackSearchMessagesResult>;
  };
  slackSendMessage: {
    method: "POST";
    path: "/session/slack/send-message";
    request: SlackSendMessageInput;
    response: SlackDynamicToolRouteResponse<SlackSendMessageResult>;
  };
  integrationLifecycle: {
    method: "POST";
    path: "/session/integration-lifecycle";
    request: RecordSessionIntegrationLifecycleRequest;
    response: RecordSessionIntegrationLifecycleResponse;
  };
  memoryContext: {
    method: "POST";
    path: "/session/memory/context";
    request: Record<string, unknown>;
    response: Response;
  };
  companyMemoryReasoningChain: {
    method: "POST";
    path: "/session/company-memory/reasoning-chain";
    request: Record<string, unknown>;
    response: Response;
  };
  platformLlmPromptPreparation: {
    method: "POST";
    path: "/session/platform-llm/prompt-preparation";
    request: ValidatePlatformLlmCapabilityRequest;
    response: ValidatePlatformLlmCapabilityResponse;
  };
  platformLlmPostExecution: {
    method: "POST";
    path: "/session/platform-llm/post-execution";
    request: ValidatePlatformLlmCapabilityRequest;
    response: ValidatePlatformLlmCapabilityResponse;
  };
  agents: {
    method: "GET";
    path: "/session/agents";
    request: undefined;
    response: GetSessionAgentsResponse;
  };
  telemetryDdLogs: {
    method: "POST";
    path: "/session/telemetry/dd-logs";
    request: unknown;
    response: Response;
  };
  telemetryBraintrust: {
    method: "POST";
    path: "/session/telemetry/braintrust";
    request: unknown;
    response: Response;
  };
  telemetrySentry: {
    method: "POST";
    path: "/session/telemetry/sentry";
    request: unknown;
    response: Response;
  };
}

type SessionInternalRouteDefinitions = {
  [RouteName in keyof SessionInternalRouteMap]: {
    method: SessionInternalRouteMap[RouteName]["method"];
    path: SessionInternalRouteMap[RouteName]["path"];
  };
};

export const SESSION_INTERNAL_ROUTES = {
  state: { method: "GET", path: "/session/state" },
  view: { method: "GET", path: "/session/view" },
  plan: { method: "GET", path: "/session/plan" },
  initialize: { method: "POST", path: "/session/initialize" },
  callbackContext: { method: "PUT", path: "/session/callback-context" },
  repo: { method: "PUT", path: "/session/repo" },
  notifyPrMerged: { method: "POST", path: "/session/notify-pr-merged" },
  notifyPrClosed: { method: "POST", path: "/session/notify-pr-closed" },
  close: { method: "POST", path: "/session/close" },
  broadcastSnapshot: { method: "POST", path: "/session/broadcast-snapshot" },
  reviewListeningHead: { method: "POST", path: "/session/review-listening/head" },
  prDraft: { method: "POST", path: "/session/pr-draft" },
  reviewListeningEnter: { method: "POST", path: "/session/review-listening/enter" },
  verificationState: { method: "POST", path: "/session/verification/state" },
  verificationResult: { method: "POST", path: "/session/verification/result" },
  sandboxState: { method: "GET", path: "/session/sandbox-state" },
  artifactsList: { method: "GET", path: "/session/artifacts/list" },
  desktopActionPathSnapshot: { method: "GET", path: "/session/desktop/action-path" },
  desktopActionPathRegister: { method: "POST", path: "/session/desktop/action-path/register" },
  desktopViewTicketCreate: { method: "POST", path: "/session/desktop/view-ticket" },
  desktopViewTicketHeartbeat: { method: "POST", path: "/session/desktop/view-ticket/heartbeat" },
  desktopViewTicketRevoke: { method: "POST", path: "/session/desktop/view-ticket/revoke" },
  desktopViewTicketStatus: { method: "POST", path: "/session/desktop/view-ticket/status" },
  desktopViewTicketConnect: { method: "POST", path: "/session/desktop/view-ticket/connect" },
  desktopViewTicketClose: { method: "POST", path: "/session/desktop/view-ticket/close" },
  replay: { method: "GET", path: "/session/replay" },
  events: { method: "GET", path: "/session/events" },
  webSocket: { method: "GET", path: "/session/ws" },
  prompts: { method: "GET", path: "/session/prompts" },
  promptsEnqueue: { method: "POST", path: "/session/prompts/enqueue" },
  promptsCallback: { method: "POST", path: "/session/prompts/callback" },
  planApprove: { method: "POST", path: "/session/plan/approve" },
  stop: { method: "POST", path: "/session/stop" },
  respond: { method: "POST", path: "/session/respond" },
  planEdit: { method: "PUT", path: "/session/plan" },
  usage: { method: "GET", path: "/session/usage" },
  inputComposition: { method: "GET", path: "/session/input-composition" },
  warm: { method: "POST", path: "/session/warm" },
  retry: { method: "POST", path: "/session/retry" },
  slackRetryWake: { method: "POST", path: "/session/slack/retry-wake" },
  eventsHistory: { method: "GET", path: "/session/events/history" },
  eventsBootstrap: { method: "GET", path: "/session/events/bootstrap" },
  context: { method: "GET", path: "/session/context" },
  export: { method: "GET", path: "/session/export" },
  reviewLoopReply: { method: "POST", path: "/session/review-loop/reply" },
  reviewLoopRecordPush: { method: "POST", path: "/session/review-loop/record-push" },
  reviewLoopSummaryComment: { method: "POST", path: "/session/review-loop/summary-comment" },
  reviewLoopSummaryCommentPosted: { method: "POST", path: "/session/review-loop/summary-comment-posted" },
  updatePrTitle: { method: "POST", path: "/session/pr-title" },
  closePr: { method: "POST", path: "/session/pr-close" },
  archiveClosePr: { method: "POST", path: "/session/archive-close-pr" },
  readPr: { method: "POST", path: "/session/pr-read" },
  recordAgentTicketKey: { method: "POST", path: "/session/ticket-key" },
  artifactsUpload: { method: "POST", path: "/session/artifacts" },
  rolloutUpload: { method: "PUT", path: "/session/rollout" },
  rolloutDownload: { method: "GET", path: "/session/rollout" },
  artifactsDelete: { method: "DELETE", path: "/session/artifacts" },
  artifactsPublic: { method: "GET", path: "/session/artifacts" },
  artifactsAuthedView: { method: "GET", path: "/session/artifacts/view" },
  cloneToken: { method: "GET", path: "/session/clone-token" },
  githubToken: { method: "GET", path: "/session/github-token" },
  githubAction: { method: "POST", path: "/session/github-action" },
  cliAuthToken: { method: "GET", path: "/session/cli-auth-token" },
  authorizeChildSession: { method: "POST", path: "/session/child-sessions/authorize" },
  publishPrReview: { method: "POST", path: "/session/pr-review/publish" },
  slackGetThread: { method: "POST", path: "/session/slack/get-thread" },
  slackSearchMessages: { method: "POST", path: "/session/slack/search-messages" },
  slackSendMessage: { method: "POST", path: "/session/slack/send-message" },
  integrationLifecycle: { method: "POST", path: "/session/integration-lifecycle" },
  memoryContext: { method: "POST", path: "/session/memory/context" },
  companyMemoryReasoningChain: { method: "POST", path: "/session/company-memory/reasoning-chain" },
  platformLlmPromptPreparation: { method: "POST", path: "/session/platform-llm/prompt-preparation" },
  platformLlmPostExecution: { method: "POST", path: "/session/platform-llm/post-execution" },
  agents: { method: "GET", path: "/session/agents" },
  telemetryDdLogs: { method: "POST", path: "/session/telemetry/dd-logs" },
  telemetryBraintrust: { method: "POST", path: "/session/telemetry/braintrust" },
  telemetrySentry: { method: "POST", path: "/session/telemetry/sentry" },
} as const satisfies SessionInternalRouteDefinitions;

export type SessionInternalRouteName = keyof SessionInternalRouteMap;

export type SessionInternalRouteRequest<RouteName extends SessionInternalRouteName> =
  SessionInternalRouteMap[RouteName]["request"];
export type SessionInternalRouteResponse<RouteName extends SessionInternalRouteName> =
  SessionInternalRouteMap[RouteName]["response"];

function buildSessionArtifactRoutePath(
  routeName: "artifactsDelete" | "artifactsPublic" | "artifactsAuthedView",
  artifactId: string,
  filename?: string,
): string {
  const basePath = `${SESSION_INTERNAL_ROUTES[routeName].path}/${encodeURIComponent(artifactId)}`;
  return filename === undefined ? basePath : `${basePath}/${encodeURIComponent(filename)}`;
}

export function buildSessionArtifactDeletePath(artifactId: string): string {
  return buildSessionArtifactRoutePath("artifactsDelete", artifactId);
}

export function buildSessionArtifactReadPath(artifactId: string, filename: string): string {
  return buildSessionArtifactRoutePath("artifactsPublic", artifactId, filename);
}

export function buildSessionArtifactAuthedViewPath(artifactId: string, filename: string): string {
  return buildSessionArtifactRoutePath("artifactsAuthedView", artifactId, filename);
}

// ---------------------------------------------------------------------------
// E2B runtime cleanup internal endpoints (Bearer-secret auth, not session routes)
// ---------------------------------------------------------------------------

export type E2BRuntimeCleanupReason =
  | "paused_expired"
  | "live_lease_expired"
  | "running_null_lease_aged"
  | "malformed_projection"
  | "killed_stale"
  // R4: the FSM `terminate_runtime` effect drives the cleanup-run workflow with this reason on a
  // FINAL terminal. The DO's decision is reason-aware for this value ONLY (paused → terminate
  // regardless of the 72h window; running → terminate only when idle) — every other reason keeps
  // its byte-identical behavior.
  | "session_terminal";

// ARC-1054: the worker sweep makes a single call to the DO cleanup workflow per
// candidate. The DO runs decide -> terminate -> clear/pause as a checkpointed,
// self-retrying workflow and returns the resulting outcome + reason code.
export interface E2BRuntimeCleanupRunRequest {
  sessionId: string;
  projectedRuntimeSandboxId: string;
  projectedRuntimeBackend: SandboxRuntimeBackend;
  reason: E2BRuntimeCleanupReason;
  nowMs: number;
}

export type E2BRuntimeCleanupOutcome = "skipped" | "paused" | "cleared" | "retry_scheduled" | "terminal_failed";

export type E2BRuntimeCleanupReasonCode =
  // cleared outcomes
  | "terminated"
  | "missing_sandbox"
  | "terminal_disabled"
  // paused outcome
  | "paused"
  // skipped outcomes
  | "skipped_not_e2b"
  | "skipped_sandbox_changed"
  | "skipped_backend_changed"
  | "skipped_not_expired"
  | "skipped_live_activity"
  | "skipped_missing_during_pause"
  | "skipped_in_progress"
  // retry_scheduled outcomes (per failing phase)
  | "terminate_failed_retry"
  | "clear_failed_retry"
  | "pause_failed_retry"
  // terminal_failed outcome
  | "terminal_failed_max_attempts";

export interface E2BRuntimeCleanupRunResponse {
  ok: true;
  outcome: E2BRuntimeCleanupOutcome;
  reasonCode: E2BRuntimeCleanupReasonCode;
  runtimeSandboxId?: string | null;
}

// ---------------------------------------------------------------------------
// E2B orphan-reaper owner-guard endpoint (Bearer-secret auth, not session routes)
// ---------------------------------------------------------------------------

// The orphan reaper terminates E2B sandboxes that have no D1 reference
// (session_index). A live, active-session VM can be transiently
// unreferenced (runtime projection desync), which made the reaper the pinned
// mid-prompt healthy-VM terminator. Before terminating any candidate that
// carries E2B metadata.session_id, the reaper asks the owning Session DO
// whether it still owns the VM. Ownership — not a liveness probe — is the
// discriminator: a probe reports `running` for BOTH a true orphan and a
// wrongly-unreferenced live VM.
// Physical E2B state the reaper already observed for this candidate (from its
// `listCycloidSandboxes` call). ARC-1248: the owner guard combines it with the
// bridge heartbeat as proof-of-life so it never kills a physically-running VM on
// stale DO bookkeeping, nor reprojects a provably-dead one as healthy. Optional
// for back-compat: an absent value (or the liveness-guard kill switch) leaves the
// guard on its pure-bookkeeping decision.
export type E2BCandidateRuntimeStatus = "running" | "paused" | "unknown";

export interface E2BOrphanGuardRequest {
  sessionId: string;
  runtimeSandboxId: string;
  runtimeBackend: SandboxRuntimeBackend;
  sweepStartedAtMs: number;
  candidateE2bStatus?: E2BCandidateRuntimeStatus;
}

export type E2BOrphanGuardDecision = "protect" | "terminate" | "defer";

export type E2BOrphanGuardReasonCode =
  // protect
  | "protected_owned"
  // terminate
  | "terminate_no_session"
  | "terminate_unreferenced"
  | "terminate_superseded"
  | "terminate_killed"
  | "terminate_terminal"
  // terminate (ARC-1248 liveness guard: positive evidence the VM is not in use)
  | "terminate_paused_unreferenced"
  | "terminate_zombie_confirmed"
  // defer (fail closed; do nothing this sweep)
  | "defer_state_changed"
  | "defer_reconciled"
  | "defer_runtime_read_unavailable"
  // defer (ARC-1248 liveness guard: running VM, liveness not yet provable)
  | "defer_unproven_liveness";

export type E2BOrphanGuardRuntimeReadUnavailableKind = "session" | "sandbox_runtime" | "sandbox_backend";

export interface E2BOrphanGuardResponse {
  ok: true;
  decision: E2BOrphanGuardDecision;
  reasonCode: E2BOrphanGuardReasonCode;
  runtimeReadUnavailableKind?: E2BOrphanGuardRuntimeReadUnavailableKind | null;
  runtimeReadUnavailableSweeps?: number | null;
}

export type SessionPhaseReaperAction = "archive" | "exit_review_listening";
export type SessionPhaseReaperReason =
  "runtime_killed" | "runtime_missing_ttl" | "live_lease_expired" | "review_listening_ttl" | "terminal_stale";

export interface SessionPhaseReaperRequest {
  sessionId: string;
  action: SessionPhaseReaperAction;
  reason: SessionPhaseReaperReason;
  nowMs: number;
}

export interface SessionPhaseReaperResponse {
  ok: true;
  terminalized: boolean;
  action: SessionPhaseReaperAction;
  reason:
    SessionPhaseReaperReason | "already_archived" | "not_review_listening" | "runtime_still_live" | "session_too_young";
}

export interface PrePublishStallFailRequest {
  sessionId: string;
  nowMs: number;
}

export type PrePublishStallFailReason =
  | "stalled"
  | "not_stalled"
  | "plan_approval_pending"
  | "runtime_still_live"
  | "heartbeat_still_live"
  | "already_terminal";

export interface PrePublishStallFailResponse {
  ok: true;
  terminalized: boolean;
  reason: PrePublishStallFailReason;
}

export interface SessionOffboardingPurgeRequest {
  sessionId: string;
}

export interface SessionOffboardingPurgeResponse {
  ok: true;
  sessionId: string;
  runtimeSandboxId: string | null;
  runtimeTerminateStatus: string | null;
  socketsClosed: boolean;
  alarmDeleted: boolean;
  sqliteTablesCleared: string[];
}

export const SESSION_BEARER_INTERNAL_ROUTES = {
  e2bCleanupRun: { method: "POST", path: "/internal/runtime/e2b/cleanup-run" },
  e2bOwnerGuard: { method: "POST", path: "/internal/runtime/e2b/owner-guard" },
  sessionIndexReproject: { method: "POST", path: "/internal/session/reproject" },
  sessionPhaseReap: { method: "POST", path: "/internal/session/phase-reap" },
  prePublishStallFail: { method: "POST", path: "/internal/session/pre-publish-stall-fail" },
  sessionOffboardingPurge: { method: "POST", path: "/internal/session/offboarding-purge" },
} as const;
