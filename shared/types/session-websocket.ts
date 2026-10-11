import type { DisplayStatus } from "../session/display-status.js";
import type { UiLifecycleStage } from "../session/lifecycle-stage.js";
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
} from "../session/phase.js";
import type { VerificationSummary } from "../verification-summary.js";
import type { PublishStatus } from "./publish.js";
import type { QaRunView } from "./qa-run.js";
import type {
  ClientErrorDetails,
  ExecutionVerification,
  ObservabilityReadiness,
  RuntimeProvenance,
  VerificationNeedsWorkLabel,
} from "./sandbox.js";
import type { PlanApprovalMetadata } from "./session-plan.js";
import type { SessionReplayPage } from "./session-replay.js";

export type ClientPromptFileSummary = {
  name: string;
};

export type ClientPromptImageSummary = {
  name: string;
  mediaType: string | null;
  data?: string;
};

export type ClientPrompt = {
  promptId: string;
  session_id: string;
  prompt: string;
  replyToText?: string | null;
  agent?: string;
  skills?: string[];
  actorUserId?: string | null;
  actorLogin?: string | null;
  actorAvatarUrl?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  files?: string[];
  uploadedFiles?: ClientPromptFileSummary[];
  uploadedImages?: ClientPromptImageSummary[];
  result: string | Record<string, unknown> | null;
  error?: string | null;
  errorDetails?: ClientErrorDetails | null;
  status: string;
  createdAt?: string;
  /**
   * True for the implementation turn that plan mode auto-enqueues after the plan
   * turn. The UI renders it as a continuation of the plan (an "implementing the
   * plan" transition) instead of echoing the original prompt as a second user
   * turn. Derived from the handoff prompt's `planContext`.
   */
  continuesPlan?: boolean;
};

export type ClientQueueState = {
  queuedCount: number;
  processingPromptId: string | null;
};

export type ClientSandboxState = {
  status: string | null;
  sandboxId: string | null;
  connected: boolean;
  spawnDurationMs: number | null;
  bridgeProtocolVersion?: number | null;
  runtimeProvenance?: RuntimeProvenance | null;
  observabilityReadiness?: ObservabilityReadiness | null;
};

export type ClientSessionSnapshot = PlanApprovalMetadata & {
  sessionId: string;
  ownerUserId: string;
  ownerLogin?: string | null;
  ownerAvatarUrl?: string | null;
  parentSessionId?: string;
  parentPromptId?: string;
  spawnDepth?: number;
  childSessionIds?: string[];
  qaChildSessionId?: string;
  // Canonical phase contract. Emitted for every session kind after PR D.
  phase: Phase;
  displayStatus: DisplayStatus;
  uiLifecycleStage?: UiLifecycleStage;
  sandboxSubstate?: SandboxSubstate;
  stopMode?: StopMode;
  // True while a user-manually-stopped session is kept live-idle (sandbox stays
  // live underneath; phase remains `idle`). Cleared to false on the next prompt
  // admit. Rides the live status event only — no D1 column.
  userStopped?: boolean;
  finalizingStep?: FinalizingStep;
  planAutoReason?: string | null;
  closeReason?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  lastEventId: string | null;
  title: string | null;
  model?: string | null;
  desktopActionPathAvailable?: boolean;
  reasoningEffort?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repoUrl?: string | null;
  baseBranch?: string | null;
  lastBranch?: string | null;
  prUrl?: string | null;
  prDraft?: boolean;
  prManualReviewReason?: string | null;
  publishStatus?: PublishStatus;
  publishError?: string | null;
  publishedBranch?: string | null;
  spawnDurationMs?: number | null;
  verification?: ExecutionVerification | null;
  verificationSummary?: VerificationSummary | null;
  runtimeProvenance?: RuntimeProvenance | null;
  observabilityReadiness?: ObservabilityReadiness | null;
  initiationMode?: "user" | "child" | "automation";
  entrypoint?: PersistedSessionEntrypoint | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  reviewLoopDoneState?: ReviewLoopDoneState | null;
  cycloidDoneState?: CycloidDoneState;
  cycloidDoneOutcome?: CycloidDoneOutcome | null;
  cycloidDoneReasons?: CycloidDoneReason[];
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  verificationNeedsWorkLabel?: VerificationNeedsWorkLabel | null;
  verificationAttemptCount?: number;
  verificationMaxAttempts?: number;
  qaRun?: QaRunView | null;
};

export type ClientReplayPage = SessionReplayPage;

/**
 * WebSocket replay-page request. WebSocket replay is for live reconnect /
 * bootstrap / interactive back-paging. Prompt-scoped replay reads
 * (`prompt_id`) intentionally remain HTTP/MCP-only and are not exposed here —
 * consumers that need a per-prompt slice should call
 * `/api/sessions/:id/events/history?prompt_id=...`.
 */
export type RequestReplayPage = {
  type: "request_replay_page";
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
};

/**
 * Sent by the server when a `request_replay_page` payload is malformed (e.g.
 * non-integer `afterSequence`, `limit` over the cap). The client may try a
 * different request; the connection stays open. The same fail-visibly contract
 * applies on HTTP via 400 + `{ ok: false, error }`.
 */
export type ReplayError = {
  type: "replay_error";
  message: string;
};
import type { PersistedSessionEntrypoint } from "./session-entrypoint.js";
