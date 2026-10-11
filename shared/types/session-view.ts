/**
 * Session view DTO: page-ready payload for the session detail page.
 *
 * This is the single source of truth for the GET /api/sessions/:sessionId/view contract.
 * Both the control-plane-worker (producer) and UI (consumer) import from here.
 *
 * Replaces the browser-side assembly of GET /api/sessions/:id + GET /api/sessions/:id/prompts
 * by returning a consolidated, server-assembled payload with pre-computed display fields.
 */

// -- Session view model (server-assembled session metadata) -------------------

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
import type { PublishStatus } from "./publish.js";
import type { QaRunView } from "./qa-run.js";
import type {
  ExecutionVerification,
  ObservabilityReadiness,
  RuntimeProvenance,
  VerificationNeedsWorkLabel,
} from "./sandbox.js";
import type { PlanApprovalMetadata } from "./session-plan.js";
import type { ClientPromptFileSummary, ClientPromptImageSummary } from "./session-websocket.js";

export type SessionViewModelInfo = {
  providerID: string;
  modelID: string;
  label: string;
  contextWindow?: number;
};

export type SessionViewOutcome = {
  state: "final_verification_pending" | "publish_blocked" | "no_changes" | "no_change_abnormal";
  tone: "info" | "error";
  title: string;
  detail?: string | null;
};

export type SessionViewModel = PlanApprovalMetadata & {
  sessionId: string;
  sessionKind?: "repo";
  // Canonical phase contract (`shared/session/phase.ts`). Emitted for every
  // session kind. PR D removed the legacy `status` alias.
  phase: Phase;
  displayStatus: DisplayStatus;
  uiLifecycleStage?: UiLifecycleStage;
  sandboxSubstate?: SandboxSubstate;
  stopMode?: StopMode;
  // Live-idle "kept alive after a user stop" flag; see session-websocket.ts.
  userStopped?: boolean;
  finalizingStep?: FinalizingStep;
  planAutoReason?: string | null;
  closeReason?: string | null;
  title: string | null;
  createdAt: number;
  // Repo context (consolidated from session + DO context)
  repoUrl: string | null;
  baseBranch: string | null;
  startBranch: string | null;
  lastBranch: string | null;
  // PR state
  prUrl: string | null;
  prDraft: boolean;
  prManualReviewReason: string | null;
  publishStatus: PublishStatus;
  publishError?: string | null;
  publishedBranch?: string | null;
  outcome?: SessionViewOutcome | null;
  // Model with server-resolved display label
  model: SessionViewModelInfo | null;
  desktopActionPathAvailable: boolean;
  // Session-level reasoning effort (DO session record; per-prompt overrides
  // ride SessionViewPrompt.reasoningEffort).
  reasoningEffort?: string | null;
  // Queue
  queueLength: number;
  // Spawn metadata
  spawnDurationMs?: number | null;
  // Live sandbox identity/transport state (DO sandbox row + bridge socket).
  // Same resolution as the WS `subscribed.sandbox` snapshot.
  sandboxId?: string | null;
  sandboxConnected?: boolean;
  verification?: ExecutionVerification | null;
  runtimeProvenance?: RuntimeProvenance | null;
  observabilityReadiness?: ObservabilityReadiness | null;
  // Owner profile (populated for shared/business sessions)
  ownerLogin?: string;
  ownerAvatarUrl?: string;
  // Parent/child orchestration metadata (ARC-657). Set on child sessions
  // (parentSessionId/parentPromptId/spawnDepth) and on parent sessions that
  // have spawned children (childSessionIds). Absent on plain sessions.
  parentSessionId?: string;
  parentPromptId?: string;
  spawnDepth?: number;
  childSessionIds?: string[];
  qaChildSessionId?: string;
  // Session provenance. `initiationMode` is always present; scheduled snapshot
  // fields are populated only when `initiationMode === "automation"`.
  initiationMode?: "user" | "child" | "automation";
  entrypoint?: PersistedSessionEntrypoint | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  // Review-loop catch-up claim (ARC review-loop indicator). null = no claim / render nothing.
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

// -- Paginated prompts --------------------------------------------------------

export type SessionViewPrompt = {
  promptId: string;
  prompt: string;
  replyToText?: string | null;
  agent?: string;
  skills?: string[];
  actorUserId?: string | null;
  actorLogin?: string | null;
  actorAvatarUrl?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  status: string;
  result: string | Record<string, unknown> | null;
  error?: string | null;
  files?: string[];
  uploadedFiles?: ClientPromptFileSummary[];
  uploadedImages?: ClientPromptImageSummary[];
  createdAt?: string;
  /** Plan mode's auto-enqueued implementation turn; rendered as a continuation. */
  continuesPlan?: boolean;
};

export type SessionViewPromptPage = {
  items: SessionViewPrompt[];
  nextCursor: string | null;
  total: number;
};

// -- Action availability (server-computed from session status) -----------------

export type SessionViewActions = {
  canSendPrompt: boolean;
  canStop: boolean;
  canResume: boolean;
  canRespond: boolean;
  canWarm: boolean;
  canRetry: boolean;
  canArchive: boolean;
};

// -- Top-level response -------------------------------------------------------

export type SessionViewResponse = {
  session: SessionViewModel;
  prompts: SessionViewPromptPage;
  actions: SessionViewActions;
};
import type { PersistedSessionEntrypoint } from "./session-entrypoint.js";
