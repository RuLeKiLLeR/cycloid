// SessionStatus is retained only as a name re-export of the canonical phase
// enum so older typed call sites keep compiling. New code should use `Phase`
// directly from `shared/session/phase.ts`. The substate-bearing peer values
// (`sandbox_creating`, `reconnecting`, `stopped_resumable`) are gone — those
// are now expressed as `phase` + `sandboxSubstate` / `stopMode`.
export type SessionStatus = import("../../../shared/session/phase.js").Phase;
export type { ActivityEvent } from "../../../shared/transcript/projector.js";
import type { PlanModeSetting } from "../../../shared/plan-mode.js";
import type { DisplayStatus } from "../../../shared/session/display-status.js";
import type { BlockedReason, FailureReason, FsmState } from "../../../shared/session/lifecycle-chip";
import type { UiLifecycleStage } from "../../../shared/session/lifecycle-stage.js";
import type {
  CycloidDoneOutcome,
  CycloidDoneReason,
  CycloidDoneState,
  FinalizingStep,
  Phase,
  ReviewLoopDoneState,
  SandboxSubstate,
  StopMode,
  VerificationResult,
  VerificationState,
} from "../../../shared/session/phase.js";
import type { BootstrapModelGroup } from "../../../shared/types/bootstrap";
import type { IntegrationCurrentHealth } from "../../../shared/types/integrations.js";
import type { PublishStatus } from "../../../shared/types/publish.js";
import type { QaRunView } from "../../../shared/types/qa-run.js";
import type { VerificationNeedsWorkLabel } from "../../../shared/types/sandbox.js";
import type { PersistedSessionEntrypoint } from "../../../shared/types/session-entrypoint.js";
import type { SessionPlanStatus } from "../../../shared/types/session-plan.js";
import type { SessionViewOutcome } from "../../../shared/types/session-view.js";
import type { ClientPrompt } from "../../../shared/types/session-websocket.js";
import type { IntegrationToolEntry } from "../../../shared/types/tools.js";

export type { FinalizingStep, Phase, SandboxSubstate, StopMode } from "../../../shared/session/phase.js";
export type { PlanModeSetting };

export type SessionMetadata = {
  sessionId: string;
  sessionKind?: "repo";
  // Canonical phase contract (`shared/session/phase.ts`). Present for every
  // session kind after PR D.
  phase: Phase;
  displayStatus: DisplayStatus;
  // FSM-derived lifecycle vocabulary (shared/session/lifecycle-chip.ts),
  // threaded onto session-list rows by the control plane. Null/undefined on
  // optimistic and legacy rows — the UI falls back to displayStatus logic.
  fsmState?: FsmState | null;
  blockedReason?: BlockedReason | null;
  failureReason?: FailureReason | null;
  uiLifecycleStage?: UiLifecycleStage;
  sandboxSubstate?: SandboxSubstate;
  stopMode?: StopMode;
  // Live-idle "kept alive after a user stop" flag; see
  // shared/types/session-websocket.ts. Drives the "Stopped — continue anytime"
  // badge/composer hint while the sandbox stays live underneath.
  userStopped?: boolean;
  planApprovalPending?: boolean;
  planRevision?: number;
  planStatus?: SessionPlanStatus;
  finalizingStep?: FinalizingStep;
  closeReason?: string | null;
  prUrl: string | null;
  prDraft?: boolean;
  prManualReviewReason?: string | null;
  publishStatus?: PublishStatus;
  publishError?: string | null;
  publishedBranch?: string | null;
  outcome?: SessionViewOutcome | null;
  createdAt: number;
  model: ModelSelection | null;
  desktopActionPathAvailable?: boolean;
  title: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  ownerLogin?: string | null;
  ownerAvatarUrl?: string | null;
  // Parent/child orchestration metadata (ARC-657). parentSessionId is set on
  // child sessions; absent on ordinary sessions. spawnDepth is the nesting
  // level (1 for direct children, 2+ for grandchildren). Surfaced on the
  // sidebar so child rows can render an indent and glyph.
  parentSessionId?: string;
  spawnDepth?: number;
  // Session provenance. `initiationMode` is "user" for ordinary sessions,
  // "child" for spawned sessions, and "automation" for scheduler sessions.
  // Scheduled snapshot fields are populated only when initiationMode === "automation".
  initiationMode?: "user" | "child" | "automation";
  entrypoint?: PersistedSessionEntrypoint | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  // Review-loop done-state badge/dot signal (null = no claim, render nothing).
  reviewLoopDoneState?: ReviewLoopDoneState | null;
  planAutoReason?: string | null;
  cycloidDoneState?: CycloidDoneState;
  cycloidDoneOutcome?: CycloidDoneOutcome | null;
  cycloidDoneReasons?: CycloidDoneReason[];
  // Canonical verification state/result threaded from the control plane. These
  // are the authoritative source for verification/merge-ready UI; lifecycle
  // stage labels are only a legacy fallback when these fields are absent.
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  verificationNeedsWorkLabel?: VerificationNeedsWorkLabel | null;
  verificationAttemptCount?: number;
  verificationMaxAttempts?: number;
  qaRun?: QaRunView | null;
  // Client-only freshness markers for live sidebar patches. Compared against
  // session-list request issue time so a later stale snapshot cannot clobber
  // newer local phase or PR state.
  lastLiveStatusPatchAt?: number;
  lastLivePrPatchAt?: number;
  lastLiveVerificationPatchAt?: number;
};

export type ModelSelection = { providerID: string; modelID: string; label?: string };
export type Provider = BootstrapModelGroup;

export type SessionDetail = SessionMetadata & {
  queueLength: number;
  repoUrl: string | null;
  prUrl: string | null;
  prDraft?: boolean;
  prManualReviewReason?: string | null;
  publishStatus?: PublishStatus;
  publishError?: string | null;
  publishedBranch?: string | null;
  outcome?: SessionViewOutcome | null;
  model: ModelSelection | null;
  /** Session-level reasoning effort (per-prompt overrides live on PromptRow). */
  reasoningEffort?: string | null;
  lastBranch: string | null;
  baseBranch: string | null;
  startBranch?: string | null;
  spawnDurationMs?: number | null;
  /** Provider sandbox id from live sandbox state (not provenance); null before first spawn. */
  sandboxId?: string | null;
  /** Bridge socket attached and sandbox ready. Null when the record predates the field. */
  sandboxConnected?: boolean | null;
  verification?: import("../../../shared/types/sandbox.js").ExecutionVerification | null;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationSummary?: import("../../../shared/verification-summary.js").VerificationSummary | null;
  runtimeProvenance?: import("../../../shared/types/sandbox.js").RuntimeProvenance | null;
  observabilityReadiness?: import("../../../shared/types/sandbox.js").ObservabilityReadiness | null;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  // Parent/child orchestration metadata (ARC-657). parentSessionId and
  // spawnDepth are inherited from SessionMetadata. parentPromptId and
  // childSessionIds remain detail-only. qaChildSessionId points at the verifier
  // child session for this session's PR when one exists.
  parentPromptId?: string;
  childSessionIds?: string[];
  qaChildSessionId?: string;
};

export type { ProviderApiKeyState } from "../../../shared/constants/onboarding.js";
export type { UploadedFile, UploadedImage } from "../../../shared/types/sandbox.js";
export type { IntegrationToolEntry } from "../../../shared/types/tools.js";

export type PromptRow = ClientPrompt;

export type IntegrationScope = "disabled" | "user" | "business";

export type ImpersonationContext = {
  impersonationId: string;
  actor: { id: number; login: string | null } | null;
  readOnly: true;
};

export type User = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  businessId: string;
  businessRole: "admin" | "member" | null;
  sharedSessions: boolean;
  egressAllowlist?: string[] | null;
  isCycloidAdmin?: boolean;
  linearConnected: boolean;
  jiraConnected: boolean;
  jiraSiteName: string | null;
  notionConnected: boolean;
  slackConnected: boolean;
  /** True when Slack identity is linked, even without the optional search token. */
  slackLinked?: boolean;
  slackNeedsReconnect: boolean;
  /** True when the business has an active Slack workspace (bot) install. */
  slackWorkspaceInstalled?: boolean;
  /** Present only when the browser session is an impersonation. */
  impersonation?: ImpersonationContext;
};

/** Integration data returned by GET /api/user/integrations (lazy-loaded by settings pages). */
export type UserIntegrations = {
  availableIntegrations: string[];
  integrationTools: IntegrationToolEntry[];
  integrationScopes: Record<string, IntegrationScope>;
  currentHealth: Record<string, IntegrationCurrentHealth>;
};

export type UserSettings = {
  defaultPrDraft: boolean;
  autoVerifyEnabled: boolean;
  automaticReviewsEnabled: boolean;
  planMode: PlanModeSetting;
  planApprovalRequired: boolean;
  settingsProfile: "manual" | "autonomous" | "custom";
  rawSettings?: {
    defaultPrDraft: boolean;
    autoVerifyEnabled: boolean;
    automaticReviewsEnabled: boolean;
    planMode: PlanModeSetting;
    planApprovalRequired: boolean | null;
  };
  useCodexSubscription: boolean;
  defaultModel: string | null;
  defaultRepo: string | null;
  apiKeys?: Record<string, import("../../../shared/constants/onboarding.js").ProviderApiKeyState>;
};

export type UserSettingsUpdate = Partial<UserSettings>;

export type OpenAIGatewayUsage = {
  currentMonth: {
    periodStartMs: number;
    periodEndMs: number;
    spentUsdMicros: number;
    reservedUsdMicros: number;
    monthlyLimitUsdMicros: number;
    settledRequestCount: number;
    reservedRequestCount: number;
    releasedRequestCount: number;
    settlementUnresolvedRequestCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    sources: Array<{
      source: "managed_virtual_key" | "user_byok" | "business_byok";
      label: string;
      spentUsdMicros: number;
      reservedUsdMicros: number;
      settledRequestCount: number;
      reservedRequestCount: number;
      releasedRequestCount: number;
      settlementUnresolvedRequestCount: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }>;
  };
  virtualKeys: Array<{
    id: string;
    status: string;
    monthlyLimitUsdMicros: number;
    createdAt: number;
    updatedAt: number;
  }>;
};

export type Repo = {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  ownerType: "User" | "Organization";
};
