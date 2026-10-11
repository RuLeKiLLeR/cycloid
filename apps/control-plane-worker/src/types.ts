/// <reference types="@cloudflare/workers-types" />

import type { BusinessRole } from "./auth/business-role";
import type { SlackQuotedReplySource } from "./slack/blocks";

type WorkerVersionMetadata = {
  id: string;
  tag: string;
  timestamp: string;
};

export interface Env {
  VERSION_METADATA?: WorkerVersionMetadata;
  // Durable Objects
  SESSION: DurableObjectNamespace;
  SESSION_RESUME_RATE_LIMITER?: DurableObjectNamespace;
  OPENAI_GATEWAY_BUDGET?: DurableObjectNamespace;
  SESSION_FEED?: DurableObjectNamespace;

  // D1
  DB: D1Database;

  // Vectorize
  MEMORY_VECTOR_INDEX?: Vectorize;

  // KV
  REPOS_CACHE: KVNamespace;
  RATE_LIMITS: KVNamespace;
  DERIVED_MODELS: KVNamespace;

  // R2
  // Bridge bundle store (ARC-1512): published on prod deploys, injected at session
  // start (PR 2). Optional so the worker does not crash when the binding is absent
  // locally or in environments where the bucket has not been provisioned.
  BRIDGE_BUNDLES?: R2Bucket;

  // Queues
  MEMORY_REFINE_QUEUE?: Queue;
  MEMORY_REFINE_DLQ?: Queue;

  // Secrets
  AUTH_SMOKE_TOKEN?: string;
  ARCANIST_ADMIN_TOKEN?: string;
  /** Optional Slack channel for "onboarding sandbox undersized" dev alerts. */
  SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL?: string;
  CI_AUTOMATION_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  // Dedicated HMAC key for signing Slack magic-link identity-binding tokens.
  // Separate from TOKEN_ENCRYPTION_KEY so link-token forgery and credential
  // decryption do not share a secret.
  SLACK_LINK_SIGNING_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_INSTALL_CALLBACK_URL?: string;
  SLACK_OAUTH_CALLBACK_URL?: string;
  SLACK_WORKSPACE_TEAM_ID?: string;
  SLACK_WORKSPACE_TEAM_NAME?: string;
  SLACK_BOT_USER_ID?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_HEALTH_ENABLED?: string;
  GITHUB_HEALTH_OWNER_USER_ID?: string;
  GITHUB_HEALTH_REPO_OWNER?: string;
  GITHUB_HEALTH_REPO_NAME?: string;
  GITHUB_HEALTH_INTERVAL_MS?: string;
  QA_OWNER_GITHUB_ID?: string;
  QA_OWNER_LOGIN?: string;
  QA_OWNER_EMAIL?: string;
  QA_INSTALLATION_ID?: string;
  QA_FIXTURE_REPO_OWNER?: string;
  QA_FIXTURE_REPO_NAME?: string;
  ARCANIST_LOGIN_USERNAME?: string;
  ARCANIST_LOGIN_PASSWORD?: string;
  ARCANIST_LOGIN_PAGE?: string;
  ARCANIST_AUTHENTICATED_PAGE?: string;
  QA_CLOUDFLARE_D1_API_TOKEN?: string;
  QA_CLOUDFLARE_D1_ACCOUNT_ID?: string;
  QA_CLOUDFLARE_D1_DATABASE_ID?: string;
  QA_DATADOG_API_KEY?: string;
  QA_DATADOG_APP_KEY?: string;
  QA_DATADOG_SITE?: string;
  QA_BRAINTRUST_API_KEY?: string;
  QA_BRAINTRUST_API_URL?: string;

  // Cycloid-owned provider API keys for platform LLM utilities
  ARCANIST_OPENAI_API_KEY: string;
  ARCANIST_BASETEN_API_KEY?: string;

  // Cycloid-owned platform/internal Anthropic key. Production sandboxed Claude
  // Code sessions still require BYOK; this is also used by sidecar structured
  // output calls that never enter the sandbox env.
  ARCANIST_ANTHROPIC_API_KEY?: string;

  // Local-only worker provider fallbacks. Production user/provider keys live in D1.
  OPENAI_API_KEY?: string;
  OPENAI_API_KEY_INTERNAL_REVIEW?: string;
  BASETEN_API_KEY?: string;
  MEMORY_REPO_SINK?: string;
  MEMORY_REFINE_MONTHLY_USD_CAP_PER_BUSINESS?: string;

  // Encryption
  TOKEN_ENCRYPTION_KEY?: string;

  // Sandbox callbacks
  SANDBOX_CALLBACK_SECRET?: string;

  CONTROL_PLANE_URL?: string;
  SANDBOX_IMAGE_VERSION?: string;
  SESSION_AUTO_CLOSE_GRACE_MS?: string;

  // E2B sandbox runtime
  E2B_API_KEY?: string;
  E2B_CLEANUP_MAX_ATTEMPTS?: string;
  E2B_DOMAIN?: string;
  E2B_ORPHAN_REAPER_BATCH_LIMIT?: string;
  E2B_ORPHAN_REAPER_LIVENESS_GUARD?: string;
  E2B_ORPHAN_REAPER_MIN_AGE_MS?: string;
  E2B_RUNTIME_CLEANUP_BATCH_LIMIT?: string;
  E2B_RUNTIME_LIVE_LEASE_MS?: string;
  E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS?: string;
  E2B_RUNTIME_PROVIDER_TTL_MS?: string;
  E2B_RUNTIME_RETENTION_HOURS?: string;
  E2B_REPO_SNAPSHOT_MAP_JSON?: string;
  E2B_SANDBOX_ALLOW_INTERNET_ACCESS?: string;
  E2B_SANDBOX_EGRESS_ALLOWLIST?: string;
  E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON?: string;
  E2B_SANDBOX_NETWORK_ALLOW_OUT?: string;
  E2B_SANDBOX_NETWORK_DENY_OUT?: string;
  E2B_SANDBOX_TEMPLATE?: string;
  E2B_SANDBOX_TIMEOUT_MS?: string;
  SANDBOX_RUNTIME_CLEANUP_SECRET?: string;

  // Freestyle sandbox runtime (dogfood-scoped; see docs — never set in prod [vars])
  FREESTYLE_API_KEY?: string;
  FREESTYLE_DEFAULT_SNAPSHOT_ID?: string;
  // Per-repo prebaked snapshot map (repo pre-cloned + deps installed); same shape,
  // key precedence, and allowPrivate semantics as E2B_REPO_SNAPSHOT_MAP_JSON.
  FREESTYLE_REPO_SNAPSHOT_MAP_JSON?: string;
  FREESTYLE_IDLE_TIMEOUT_SECONDS?: string;
  // Dogfood-only routing override: comma list of owner user IDs, or "all".
  FREESTYLE_SANDBOX_BACKEND_OVERRIDE?: string;

  // Sentry
  ARCANIST_LOCAL_DEV?: string;
  SENTRY_DSN?: string;
  SENTRY_ENABLE_LOCAL?: string;
  SENTRY_RELEASE?: string;

  // Linear integration health
  LINEAR_HEALTH_INTERVAL_MS?: string;

  // Jira integration health
  JIRA_HEALTH_INTERVAL_MS?: string;

  OPENAI_ADMIN_API_KEY?: string;
  OPENAI_GATEWAY_API_KEY_ID?: string;

  // Observability
  DD_API_KEY?: string;
  DD_APP_KEY?: string;
  DD_SITE?: string;
  BRAINTRUST_API_KEY?: string;
  BRAINTRUST_API_URL?: string;
  BRAINTRUST_APP_URL?: string;
  BRAINTRUST_ORG_NAME?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_BUCKET?: string;
  S3_REGION?: string;
  TRACE_QUEUE?: Queue;
  MEMORY_ANALYSIS_QUEUE?: Queue;
  SANDBOX_LAYER_BUILD_QUEUE?: Queue<SandboxLayerBuildQueueMessage>;
  MEMORY_CONTEXT_RETRIEVAL_DISABLED?: string;
  MEMORY_CONTEXT_LOCAL_DOGFOOD_ENABLED?: string;

  // Environment variables
  VERBOSE_EVENTS?: string;
  // ARC-1330 Phase B immediate-dispatch kill-switch. Default (unset) = ON: the FSM `dispatch_epoch`
  // sink drives a review epoch on the webhook-arrival turn. "off" reverts dispatch timing to the fast
  // cron / poll (the sink falls back to its Wave-11 create-only, no-dispatch behavior).
  REVIEW_LOOP_IMMEDIATE_DISPATCH?: string;
  WORKER_ENV?: string;
  LOG_LEVEL?: string;
  GITHUB_CALLBACK_URL?: string;
  LINEAR_OAUTH_CLIENT_ID?: string;
  LINEAR_OAUTH_CLIENT_SECRET?: string;
  LINEAR_OAUTH_CALLBACK_URL?: string;
  JIRA_OAUTH_CLIENT_ID?: string;
  JIRA_OAUTH_CLIENT_SECRET?: string;
  JIRA_OAUTH_CALLBACK_URL?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  NOTION_OAUTH_CALLBACK_URL?: string;
  FRONTEND_URL?: string;
  // Optional second allowlisted UI origin (internal dogfood deploy). When set,
  // its origin joins FRONTEND_URL's in the GitHub sign-in redirect-host
  // allowlist. Absent => allowlist is just FRONTEND_URL (behavior identical to
  // today). Only GitHub sign-in honors this; integration OAuth stays pinned.
  INTERNAL_FRONTEND_URL?: string;
  JIRA_TRIGGER_LABEL?: string;
  LINEAR_DEFAULT_REPO_URL?: string;
}

export type CliTokenScope = "read" | "write";
export interface SandboxLayerBuildQueueMessage {
  buildId: string;
  reason: "start" | "poll" | "smoke";
  attempt: number;
}
type AuthMode = "admin_token" | "ci_automation_token" | "cli_token" | "user_session" | "impersonated_user_session";

export type { UploadedFile, UploadedImage } from "../../../shared/types/sandbox.js";
import type { AgentRuntimeBackend } from "../../../shared/agent/agent-runtime-backend.js";
import type {
  AgentRole,
  HarnessKind,
  RuntimeStartupProfile,
  VerificationRuntimeMode,
} from "../../../shared/agent/schema.js";
import type { PublishStage, PublishStatus } from "../../../shared/types/publish.js";
import type { QaRunTerminalSummary, QaRunView } from "../../../shared/types/qa-run.js";
import type {
  ErrorDetails,
  ExecutionVerification,
  ObservabilityReadiness,
  PlanContext,
  ReviewLoopPromptSourceKind,
  RuntimeProvenance,
  UploadedFile,
  UploadedImage,
  VerificationNeedsWorkLabel,
} from "../../../shared/types/sandbox.js";
import type { ClientPrompt } from "../../../shared/types/session-websocket.js";
import type { InitiationMode } from "./enums/initiation-mode.js";
import type { SessionEntrypoint } from "./enums/session-entrypoint.js";
import type { SessionKind } from "./session/internal-routes.js";
export type { IntegrationToolEntry, IntegrationToolMeta } from "../../../shared/types/tools.js";

export interface SessionState {
  sessionId: string;
  ownerUserId: string;
  businessId: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  lastEventId: string | null;
  title: string | null;
  titleTags?: string[] | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend;
  sessionKind?: SessionKind;
  agentRole?: AgentRole | null;
  agentProfile?: string | null;
  harnessKind?: HarnessKind | null;
  runtimeStartupProfile?: RuntimeStartupProfile | null;
  verificationRuntimeMode?: VerificationRuntimeMode | null;
  targetPrUrl?: string | null;
  autoVerifyDisabled?: boolean;
  planMode?: boolean;
  /** Immutable creation-time gate; absent on legacy sessions and therefore false. */
  planApprovalRequired?: boolean;
  /** Owner-visible Auto classifier reason; absent/null for legacy and non-Auto sessions. */
  planAutoReason?: string | null;
  adoptedExternalPr?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  installationId?: number | null;
  callbackContext?: CallbackContext | null;
  reviewListeningActive?: boolean;
  reviewListeningPrUrl?: string | null;
  reviewListeningHeadSha?: string | null;
  reviewListeningEnteredAt?: number | null;
  reviewLoopDoneState?: import("../../../shared/session/phase.js").ReviewLoopDoneState | null;
  cycloidDoneState?: import("../../../shared/session/phase.js").CycloidDoneState;
  cycloidDoneOutcome?: import("../../../shared/session/phase.js").CycloidDoneOutcome | null;
  cycloidDoneReasons?: import("../../../shared/session/phase.js").CycloidDoneReason[];
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState?: import("../../../shared/session/phase.js").VerificationState | null;
  verificationResult?: import("../../../shared/session/phase.js").VerificationResult | null;
  verificationNeedsWorkLabel?: VerificationNeedsWorkLabel | null;
  verificationAttemptCount?: number;
  verificationMaxAttempts?: number;
  // Legacy run-count baseline from the former per-head verification budget. Retained for stored
  // session compatibility; the active run-limit gate is PR-scoped and ignores it.
  verificationRunBaseline?: number;
  // Head SHA the current verification verdict was validated for. The auto-verification scheduler
  // suppresses re-verification only when this equals the head being settled (a positively-identified
  // content no-op), so a failed verdict clear on a real change still re-verifies (ARC-1243 follow-up).
  verificationVerdictHeadSha?: string | null;
  initiationMode?: InitiationMode;
  /** Immutable creation provenance; null for sessions created before migration 0260. */
  entrypoint?: SessionEntrypoint | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
}

export interface ReplayState {
  sessionId: string;
  lastEventSequence: number;
  lastEventTimestamp: string | null;
  updatedAt: string | null;
  /** Approximate serialized size of the events array in bytes. Used to skip expensive compaction when small. */
  approximateBytes?: number;
}

export interface SessionEvent {
  sequence: number;
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface PromptState {
  promptId: string;
  prompt: string;
  replyToText?: string | null;
  replyToQuoteSource?: SlackQuotedReplySource | null;
  branchNameHint?: string;
  agent?: string;
  actorUserId: string | null;
  skills?: string[];
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
  reviewLoopEpochId?: string | null;
  reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
  planContext?: PlanContext;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  result: unknown;
  error: string | null;
  errorDetails?: ErrorDetails | null;
  /**
   * How many times this prompt's run has been re-cloned onto a fresh sandbox
   * after a mid-turn `sandbox_disconnected`. Set on the clone at retry time
   * (parent count + 1) and bounded by `DISCONNECT_RETRY_CAP`. Fresh prompts
   * default to 0; the counter rides the retry-clone chain and dies with it,
   * so no explicit reset on completion is needed.
   */
  disconnectRetryCount?: number;
  /**
   * True when this prompt is plan mode's read-only planning turn. Set on the
   * initial plan prompt's retry clones so a mid-turn disconnect/spawn-timeout
   * retry (a fresh prompt id, e.g. p-2) is still recognized as the plan turn and
   * dispatched read-only. Without it the retry escapes plan mode (id !== "p-1")
   * and runs write-capable. Persisted so the marker survives DO eviction.
   */
  isPlanPrompt?: boolean;
}

export interface QueueState {
  queuedCount: number;
  processingPromptId: string | null;
}

export type SessionDOResponse = Omit<SessionState, "status"> & {
  phase: import("../../../shared/session/phase.js").Phase;
  displayStatus: import("../../../shared/session/display-status.js").DisplayStatus;
  uiLifecycleStage?: import("../../../shared/session/lifecycle-stage.js").UiLifecycleStage;
  sandboxSubstate?: import("../../../shared/session/phase.js").SandboxSubstate;
  stopMode?: import("../../../shared/session/phase.js").StopMode;
  // Live-idle "kept alive after a user stop" flag (in-memory DO state; no D1
  // column). Populated by buildSessionDoResponse from this.userStopped.
  userStopped?: boolean;
  planApprovalPending: boolean;
  planRevision: number;
  planStatus: import("../../../shared/types/session-plan.js").SessionPlanStatus;
  finalizingStep?: import("../../../shared/session/phase.js").FinalizingStep;
  sandboxStatus: string | null;
  /** Provider sandbox id from the DO sandbox row; null before first spawn. */
  sandboxId?: string | null;
  /** Bridge socket attached and sandbox ready — same derivation as the WS `subscribed.sandbox.connected`. */
  sandboxConnected?: boolean;
  sessionKind?: "repo";
  repoOwner?: string | null;
  repoName?: string | null;
  repoUrl?: string | null;
  baseBranch?: string | null;
  startBranch?: string | null;
  installationId?: number | null;
  lastBranch?: string | null;
  prUrl?: string | null;
  prDraft?: boolean;
  prManualReviewReason?: string | null;
  publishStatus?: PublishStatus;
  publishStage?: PublishStage | null;
  publishError?: string | null;
  publishedBranch?: string | null;
  closeReason?: string | null;
  spawnDurationMs?: number | null;
  verification?: ExecutionVerification | null;
  verificationSummary?: import("../../../shared/verification-summary.js").VerificationSummary | null;
  qaRunTerminalSummary?: QaRunTerminalSummary | null;
  qaRun?: QaRunView | null;
  runtimeProvenance?: RuntimeProvenance | null;
  observabilityReadiness?: ObservabilityReadiness | null;
  ownerLogin?: string | null;
  ownerAvatarUrl?: string | null;
  desktopActionPathAvailable: boolean;
};

export type SessionViewTimingOutcome = "success" | "fallback";

export interface SessionViewReadTiming {
  durationMs: number;
  outcome: SessionViewTimingOutcome;
  errorClass?: string;
  requestedCount?: number;
  uncachedCount?: number;
}

export interface SessionViewPayloadMetrics {
  doBuildMs: number;
  doPromptActorProfiles: SessionViewReadTiming;
  doOwnerActorProfile: SessionViewReadTiming;
  doSpineDoneMirror: SessionViewReadTiming;
}

export interface SessionViewPayload {
  ok: boolean;
  session: SessionDOResponse;
  prompts: ClientPrompt[];
  outcomePrompts?: ClientPrompt[];
  promptPage?: {
    nextCursor: string | null;
    total: number;
  };
  queue: QueueState;
  metrics?: SessionViewPayloadMetrics;
}

export interface AuthInfo {
  userId: string;
  tokenSource: string;
  authMode: AuthMode;
  canAccessAllSessions: boolean;
  cliTokenScope?: CliTokenScope;
  cliTokenId?: number;
  user?: UserInfo;
  /**
   * Impersonation: when set, `userId` and `user` represent the impersonation
   * target (so identity-keyed reads continue to work unchanged), while these
   * fields identify the internal operator behind the request.
   */
  actorUserId?: string;
  actorUser?: UserInfo;
  actorGithubUserId?: number | null;
  impersonationId?: string;
  /** Router/DO-enforced mutating-route deny bit for scoped credentials. */
  readOnly?: true;
}

export interface InternalAuthContext {
  userId: string;
  canAccessAllSessions: boolean;
  businessId?: string | null;
  sharedSessions?: boolean;
  businessMemberIds?: string[];
  repoAccessVerifiedSessionId?: string;
  repoAccessVerifiedRepoOwner?: string;
  repoAccessVerifiedRepoName?: string;
  email?: string | null;
  username?: string | null;
  impersonationId?: string;
  readOnly?: true;
}

export type AuthResult = { ok: true; auth: AuthInfo } | { ok: false; response: Response };

export interface UserInfo {
  id: number;
  githubUserId?: number | null;
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl?: string | null;
  businessId: string;
  businessRole?: BusinessRole | null;
  sharedSessions?: boolean;
  /** Pre-loaded business member user IDs (string) when sharedSessions is true. */
  businessMemberIds?: string[];
  linearConnected?: boolean;
  jiraConnected?: boolean;
  notionConnected?: boolean;
  slackConnected?: boolean;
  slackNeedsReconnect?: boolean;
  availableIntegrations?: string[];
  integrationScopes?: Record<string, "disabled" | "user" | "business">;
}

export interface DispatchContract {
  sessionId: string;
  promptId: string;
  prompt: string;
  model?: string | null;
  skills?: string[];
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
  callback: {
    method: string;
    path: string;
    auth: string;
  };
}

export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export type AuthSessionResult =
  | {
      status: "ok";
      user: {
        id: number;
        githubUserId?: number | null;
        login: string | null;
        name: string | null;
        email: string | null;
        businessId: string;
        businessRole?: BusinessRole | null;
        sharedSessions: boolean;
        businessMemberIds?: string[];
      };
      readOnly?: true;
    }
  | { status: "invalid" | "backend_unavailable" };

export interface ReplayWindow {
  afterSequence: number;
  events: SessionEvent[];
  truncated: boolean;
  droppedCount: number;
}

interface SlackCallbackContext {
  source: "slack";
  channel: string;
  /**
   * Thread anchor. Present for interactive Slack sessions and Slack-alert
   * automations (which post a starting message and thread onto it). Absent for
   * scheduled automations that deliver a single plain top-level digest with no
   * starting message — those post to the channel, not a thread.
   */
  threadTs?: string;
  slackTeamId: string;
  reactionMessageTimestamps?: string[];
  /**
   * `ts` of the initial bot status reply (e.g. "Working on `owner/repo`..."), when
   * it was posted successfully. Captured so completion notifications can reason
   * about ordering and future updates can edit the same message.
   */
  statusMessageTs?: string;
  /**
   * `ts` of the latest ask message (blocker/error requiring user attention).
   * New asks post a notifying reply, then compact the previous ask in place.
   */
  askMessageTs?: string;
  /**
   * Count of ask-anchor REPAIRS (re-posts after Slack lost the anchored message).
   * Not a "new asks" allowance; bounded by `SLACK_MAX_ASK_REPOSTS_PER_SESSION`.
   */
  askRepostCount?: number;
  /** `ts` of the latest terminal result message (the answer/outcome reply). */
  resultMessageTs?: string;
  /** Prompt/event key for `resultMessageTs`; duplicate deliveries for the same key update in place. */
  resultPromptId?: string;
}

interface GithubQaIssueCommentCallbackContext {
  source: "github_qa_issue_comment";
  installationId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  commentId: number;
  targetPrUrl: string;
}

export type CallbackContext = SlackCallbackContext | GithubQaIssueCommentCallbackContext;

export interface LinearContext {
  identifier: string;
  url: string;
}

export interface GithubIssueContext {
  githubIssueId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  url: string;
}

// DO response payloads (returned by session DO proxy functions)
export interface EnqueuePayload {
  ok: boolean;
  prompt: ClientPrompt;
  dispatch: DispatchContract | null;
  queue: QueueState;
  replay: ReplayState;
  session: SessionState;
}

export interface PromptListPayload {
  ok: boolean;
  prompts: ClientPrompt[];
  queue: QueueState;
}

export interface EventsPayload {
  ok: boolean;
  events: SessionEvent[];
  replay: ReplayState;
  // Canonical phase contract. Emitted for every session kind after PR D; the
  // legacy `sessionStatus` alias was removed.
  phase: import("../../../shared/session/phase.js").Phase;
  displayStatus: import("../../../shared/session/display-status.js").DisplayStatus;
  sandboxSubstate?: import("../../../shared/session/phase.js").SandboxSubstate;
  stopMode?: import("../../../shared/session/phase.js").StopMode;
  finalizingStep?: import("../../../shared/session/phase.js").FinalizingStep;
  // Distinguishes repo vs non-repo lifecycle terminality (idle is terminal for non-repo).
  sessionKind?: string | null;
  title?: string | null;
  spawnDurationMs?: number | null;
}

export interface CallbackPayload {
  ok: boolean;
  completedPrompt: ClientPrompt;
  nextDispatch: DispatchContract | null;
  nextPrompt: ClientPrompt | null;
  queue: QueueState;
  replay: ReplayState;
  session: SessionState;
}
