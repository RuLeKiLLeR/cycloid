import * as Sentry from "@sentry/cloudflare";
import { DurableObject } from "cloudflare:workers";

import {
  CODEX_AGENT_RUNTIME_BACKEND,
  inferenceProviderForBackend,
  resolveAgentRuntimeBackend,
} from "../../../../shared/agent/agent-runtime-backend.js";
import {
  isCodeReviewerAgentRole,
  isQaTesterAgentRole,
  QA_TESTER_AGENT_ROLE,
  resolveEffectiveVerificationRuntimeMode,
} from "../../../../shared/agent/constants.js";
import {
  ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV,
  isAgentVisibleRepoRuntimeEnvName,
} from "../../../../shared/constants/agent-child-env.js";
import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { INTEGRATION_IDS } from "../../../../shared/constants/integration-helpers.js";
import {
  extractModelId,
  extractSessionStartModelIdForBackend,
  getDefaultSessionStartModelIdForBackend,
  getModelDefinition,
} from "../../../../shared/constants/models.js";
import { OWNER_USER_ID_ENV, SLACK_SESSION_TEAM_ID_ENV } from "../../../../shared/constants/sandbox-env.js";
import {
  REPLAY_PAGE_SIZE,
  REPLAY_WINDOW_SIZE,
  SANDBOX_NOT_ACTIVE_ERROR_CODE,
} from "../../../../shared/constants/session.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import type { BridgeEvent as SandboxEvent, EstimatedInputCompositionRecord } from "../../../../shared/events/bridge.js";
import {
  type CycloidEvent,
  REMOVED_BRIDGE_EVENT_TYPES,
  validateCycloidEvent,
} from "../../../../shared/events/schema.js";
import {
  isPlatformLlmCallType,
  isPlatformLlmPhase,
  type PlatformLlmCallType,
  type PlatformLlmCapabilityManifest,
  type PlatformLlmFailureCategory,
  type PlatformLlmPhase,
  type PlatformLlmResponse,
} from "../../../../shared/llm/platform-llm-contract.js";
import { toRuntimeMemory } from "../../../../shared/memory/parser.js";
import { serializeError } from "../../../../shared/observability/error-utils.js";
import { redact } from "../../../../shared/observability/redact.js";
import { displayStatusFromPhase } from "../../../../shared/session/display-status.js";
import type { UiLifecycleStage } from "../../../../shared/session/lifecycle-stage.js";
import { deriveReviewLoopSummaryOrRaw } from "../../../../shared/transcript/prompt-display.js";
import { datadogErrorCodeTag, errorCodeLabel, isErrorCode } from "../../../../shared/types/error-codes.js";
import type { PublishStage, PublishStatus } from "../../../../shared/types/publish.js";
import {
  buildQaRunView,
  normalizeQaRunTerminalSummary,
  QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY,
} from "../../../../shared/types/qa-run.js";
import type {
  AppRuntimeProfileDiagnostic,
  AppRuntimeProfileSource,
  ErrorCode,
  ExecutionVerification,
  ObservabilityReadiness,
  PreviewContract,
  PreviewContractE2ECredentialDeclaration,
  PrReadinessEvidence,
  RepoMemoryContext,
  RuntimeProvenance,
  RuntimeReport,
  SandboxAckMessage,
  SandboxCommand,
  SandboxRuntimeProvider,
} from "../../../../shared/types/sandbox.js";
import type { FeedDeltaInput } from "../../../../shared/types/session-feed.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import type {
  ClientPrompt,
  ClientReplayPage,
  ClientSandboxState,
  ClientSessionSnapshot,
} from "../../../../shared/types/session-websocket.js";
import { normalizeTerminalOutcome } from "../../../../shared/types/terminal-outcome.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import { normalizeTelemetryId } from "../../../../shared/utils/trace-ids.js";
import {
  compactVerificationPhaseArtifactRecordForDurableStorage,
  upsertVerificationPhaseArtifactRecord,
  type VerificationPhaseArtifactRecord,
} from "../../../../shared/verification/phase-artifacts.js";
import { visibleRepoMemoriesForSession } from "../../../../shared/verification/qa-runtime-learnings.js";
import { buildVerificationSummary } from "../../../../shared/verification-summary.js";
import { getUserSentryProfile } from "../auth/db";
import { encodeBase64UrlBytes } from "../base64url";
import { getBusinessEgressPolicy } from "../business/db";
import { handleMemoryContextQueryForSession } from "../company-memory/context-query";
import { recordReviewLoopOutcomeMemoryIngestion } from "../company-memory/service";
import {
  getCompanyMemorySessionScope,
  handleCompanyMemoryReasoningChainForSession,
} from "../company-memory/session-query";
import { businessIdsMatch } from "../constants/businesses";
import { isCompanyMemoryDisabledForBusiness } from "../constants/company-memory";
import {
  E2B_CLEANUP_RETRY_BASE_BACKOFF_MS,
  E2B_CLEANUP_RETRY_MAX_BACKOFF_MS,
  E2B_CLEANUP_TERMINAL_COOLDOWN_MS,
  E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT,
  getE2BCleanupMaxAttempts,
  isE2BOrphanReaperLivenessGuardEnabled,
} from "../constants/e2b-cleanup";
import { TEXT_DELTA_FLUSH_MS } from "../constants/events";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { DD_DEFAULT_SITE, HIGH_FREQUENCY_LIFECYCLE_EVENT_TYPES } from "../constants/observability";
import {
  PLAN_PARK_PAUSE_AFTER_MS,
  PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY,
  PLAN_READY_DELIVERY_STORAGE_KEY,
  PLAN_READY_NOTIFICATION_MAX_ATTEMPTS,
  PLAN_READY_NOTIFICATION_RETRY_DELAYS_MS,
} from "../constants/plan-approval";
import {
  PLATFORM_LLM_CALL_CONFIG,
  PLATFORM_LLM_CAPABILITY_TTL_MS,
  PLATFORM_LLM_RATE_LIMIT_WINDOW_MS,
  PLATFORM_LLM_SESSION_QPS,
} from "../constants/platform-llm";
import { NO_SIGNAL_ADVANCE_WINDOW_MS } from "../constants/review-loop";
import { SESSION_AUTO_ARCHIVE_MIN_AGE_MS } from "../constants/session-cleanup";
import { PRE_PUBLISH_STALL_BACKSTOP_MS, STALL_WATCH_STATES } from "../constants/session-stall";
import {
  E2B_CLEANUP_JOB_STORAGE_KEY_PREFIX,
  getAutoCloseGraceMs,
  LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
  LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
  LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY,
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY,
  LIFECYCLE_SPAWN_IN_PROGRESS_STORAGE_KEY,
  LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY,
  LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
  MIN_ALARM_DELAY_MS,
  type PerPromptUsage,
  PLAN_APPROVAL_PENDING_STORAGE_KEY,
  POST_EXECUTION_DEADLINE_MS,
  PR_READINESS_STORAGE_KEY,
  PROMPT_MAX_DURATION_MS,
  PUBLISHING_DEADLINE_MS,
  SANDBOX_AUTH_TOKEN_OVERLAP_GENERATIONS,
  SANDBOX_AUTH_TOKEN_OVERLAP_MS,
  SANDBOX_CONNECTION_GENERATION_STORAGE_KEY,
  SANDBOX_DISCONNECT_CROSSCHECK_PROBE_TIMEOUT_MS,
  SANDBOX_DISCONNECT_CROSSCHECK_TIMEOUT_MS,
  SANDBOX_LOSS_RECOVERY_BUDGET_MS,
  SANDBOX_REAPER_LIVENESS_STALE_MS,
  SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
  SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS,
  SANDBOX_REAPER_ZOMBIE_SWEEP_MAX_RUNTIMES,
  SANDBOX_RECONNECT_GRACE_MS,
  SPAWN_CONNECT_TIMEOUT_COLD_MS,
  SPAWN_CONNECT_TIMEOUT_MS,
  STALE_PROMPT_TIMEOUT_MS,
  STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS,
  STOPPED_KEPT_ALIVE_AT_STORAGE_KEY,
  USAGE_SOURCE_SANDBOX,
  USD_TO_MICROS,
} from "../constants/sessions";
import { SLACK_PHASE_CARD_STAGES } from "../constants/slack-card-controls";
import { NARRATION_THROTTLE_STATE_STORAGE_KEY } from "../constants/slack-narration";
import { PROGRESS_NARRATION_INTERVAL_MS } from "../constants/slack-progress-narration";
import { BlockerKind } from "../enums/blocker.js";
import { SandboxIdlePauseReason } from "../enums/sandbox.js";
import { pickRepoLoginEnvVars } from "../env-blobs/login-env";
import {
  getPersonalSecretsCredentialFingerprint,
  resolvePersonalSecretsForSandbox,
} from "../env-blobs/personal-secrets";
import { getRepoLoginEnvCredentialFingerprint, resolveRepoLoginEnvForSandbox } from "../env-blobs/service";
import { getUserGitIdentity } from "../github/db";
import { getDefaultBranch, isRepoPrivate } from "../github/pr";
import { writeIntegrationLifecycleEvents } from "../integrations/lifecycle/service";
import {
  buildManagedMcpRuntimeConfig,
  listEnabledMcpServersForSession,
  type ManagedMcpRuntimeConfig,
} from "../integrations/mcp-registry";
import { cleanupSessionNeonBranch, resolveSessionNeonBranchCredentialEnvs } from "../integrations/neon";
import {
  getSpawnIntegrationCredentialEnvKeys,
  resolveAppRuntimeLlmKey,
  resolveSpawnIntegrationRuntime,
  type SpawnIntegrationLifecycleEvent,
  SpawnProviderCredentialError,
} from "../integrations/runtime";
import { resolveDeclaredTestCredentials } from "../integrations/test-credentials-db";
import type { Logger, LogLevel } from "../logger";
import { createLogger } from "../logger";
import { runMemoryReviewBotForCompletedPrompt } from "../memory-review-bot/review-service";
import { endSpan, runInSpan, startSpan } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { flushSpansToQueue } from "../observability/exporter";
import {
  type DriftCheckConfig,
  type PhaseTransitionCause,
  postPhaseDriftMetric,
  postPhaseTransitionEvent,
  postPhaseTransitionMetric,
  SKIP_DRIFT_CHECK,
} from "../observability/phase-metrics";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { buildSandboxObservabilityReadiness, resolveSandboxObservabilityEnv } from "../observability/sandbox-env";
import { emitSandboxDisconnectTerminalizeMetric } from "../observability/sandbox-survival-metrics";
import { resolveSentryRuntimeOptions, shouldReportToSentry } from "../observability/sentry";
import { gunzipCapped, rewriteSentryEnvelopeDsn } from "../observability/sentry-envelope";
import { emitToolCallObservedEvent, emitToolCallRollupMetrics } from "../observability/tool-call-metrics";
import { tracedFetch } from "../observability/wrappers";
import { assertActiveTemplateSupportsAgentBackend } from "../sandbox/base-template-service";
import { buildBridgeStartupDiagnosticScript } from "../sandbox/bridge-startup-diagnostics";
import { classifySpawnTimeoutPhase, type SpawnTimeoutOrigin } from "../sandbox/classifySpawnTimeoutPhase";
import {
  type E2BCreateSandboxRequest,
  type E2BCreateSandboxResponse,
  E2BSandboxRuntimeError,
  RETRYABLE_SANDBOX_SPAWN_ERROR_CODES,
  type SandboxTerminateReason,
} from "../sandbox/e2b-client";
import {
  hasE2BSandboxOutboundPolicy,
  resolveE2BSandboxNetworkPolicy,
  resolveSandboxEgressAllowlist,
} from "../sandbox/egress-policy";
import { notifySandboxEnospc } from "../sandbox/enospc-notify";
import { buildVmName } from "../sandbox/freestyle-client";
import { blockActiveSandboxLayerArtifactIfCurrent } from "../sandbox/layer-db";
import {
  type ResolvedSandboxLayerArtifact,
  resolveSandboxLayerForSession,
  type SandboxLayerSessionResolution,
} from "../sandbox/layer-resolver";
import { createSandboxProviderClient, type SandboxProviderClient } from "../sandbox/provider-client";
import { resolveRepoSandboxSpec } from "../sandbox/repo-sandbox-specs";
import { lookupRepoSnapshotMap, type RepoSnapshotLookupResult } from "../sandbox/repo-snapshot-map";
import { emitSandboxResourceGauges } from "../sandbox/resource-telemetry";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
  isKnownRuntimeProvider,
  parsePersistedRuntimeBackend,
  parsePersistedRuntimeBackendOrNull,
  providerForRuntimeBackend,
  resolveDogfoodFreestyleOverride,
  resolveRuntimeBackendForRepoSession,
  type RuntimeBackend,
} from "../sandbox/runtime-backend";
import {
  classifyCrossCheckSignal,
  type CrossCheckResult,
  crossCheckRuntimeLiveness,
  crossCheckRuntimeViaProbe,
  sanitizeErrorCode,
} from "../sandbox/runtime-liveness-crosscheck";
import { DEFAULT_SPAWN_RETRY_POLICY, SpawnRetryAbortedError } from "../sandbox/spawnRetry";
import { notifySandboxUndersized } from "../sandbox/undersize-notify";
import { createSandboxWithReservationTrace } from "../sandbox/vm-reservations";
import { assertLocalControlPlaneCallbackReachable } from "../services/control-plane-callback-preflight";
import { syncFsmLabelsForPr } from "../services/fsm-label-sync";
import { isCycloidMember } from "../services/internal-feature-gate";
import { assertBusinessCanUseOpencode } from "../services/opencode-access-gate";
import { resolvePublicAppBaseUrl, resolvePublicArtifactBaseUrl } from "../services/public-url";
import { resolveAppRuntimeProfile } from "../services/repo-preview";
import { shadowEmitReviewLoopEpochBlockedTerminal } from "../services/review-loop-epoch-blocked-terminal";
import {
  getReviewLoopEpochById,
  markReviewLoopEpochBlocked as markReviewLoopEpochBlockedInD1,
  markReviewLoopEpochOwnerApprovalResolved as markReviewLoopEpochOwnerApprovalResolvedInD1,
  markReviewLoopEpochProcessing as markReviewLoopEpochProcessingInD1,
  repointReviewLoopEpochPrompt as repointReviewLoopEpochPromptInD1,
  resolveReviewLoopEpochForTerminalPrompt as resolveReviewLoopEpochForTerminalPromptInD1,
  shadowEmitReviewLoopEpochTerminal,
} from "../services/review-loop-epochs";
import {
  MissingSessionIndexRowError,
  scheduleSessionProjectionSync,
  syncRichStatusProjection,
  syncRuntimeBackendProjection,
  syncRuntimeProjection,
  syncRuntimeProjectionChecked,
  syncSessionProjection,
} from "../services/session-projection";
import { checkSandboxAuthFailureRateLimit, checkSessionResumeRateLimit } from "../services/session-resume-rate-limiter";
import { generateSessionTitle as generateConciseSessionTitle } from "../services/session-title";
import { fetchActorProfilesByIds } from "../services/session-view";
import { resolveEffectiveAutonomySettings } from "../settings/autonomy";
import { getUserSettings, type UserSettingsCache } from "../settings/db";
import { type SlackStatusStage, slackStatusStageForPhase } from "../slack/blocks";
import {
  coalescePhaseCardNarration,
  INITIAL_NARRATION_THROTTLE_STATE,
  narrationLineForEvents,
  type NarrationThrottleState,
  narrationToolCallText,
  planNarrationUpdate,
} from "../slack/narration";
import { updateSlackStatusStageInPlace } from "../slack/phase-updates";
import {
  type PlanApprovalSupersessionReason,
  supersedePlanApprovalInteractionRequests,
} from "../slack/plan-approval-interactions";
import {
  boundProgressBuffer,
  type ProgressBufferItem,
  progressItemsForEvents,
  shouldRunProgressNarration,
  summarizeProgress,
} from "../slack/progress-narration";
import type {
  CallbackContext,
  Env,
  InternalAuthContext,
  PromptListPayload,
  PromptState,
  ReplayState,
  SessionDOResponse,
  SessionEvent,
  SessionState,
  SessionViewPayload,
  SessionViewPayloadMetrics,
  SessionViewReadTiming,
} from "../types";
import {
  computeSha256Hex,
  generateRandomHex,
  generateSandboxPromptCallbackToken,
  jsonErrorResponse,
  jsonResponse,
  normalizeEventSequence,
  nowIso,
  parseBearerToken,
  parseJsonBody,
  parseNonNegativeInteger,
  resolveSandboxCallbackSecret,
  shellQuote,
  timingSafeEqualString,
} from "../utils";
import { SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, upsertSessionWebhookRef } from "../webhooks/db";
import type { ServerMessage } from "../ws/types.js";
import { createSessionAlarmScheduler, type SessionAlarmScheduler } from "./alarm-scheduler.js";
import { createArtifactAccessMetadata, decodeArtifactPathSegment } from "./artifacts.js";
import { applyServerAuthoritativePublishMode } from "./authoritative-publish.js";
import { resolveRequiredBusinessId } from "./business-id";
import { getChildContextForSession, getParentSessionRow } from "./child-session-db";
import { insertCompletion, updateCompletionDiff } from "./completions-db";
import { addSandboxIdToCorrelation, buildSerializedCorrelation } from "./correlation.js";
import {
  type DurableEntry,
  omitMemoryRecallTraceFields,
  projectCycloidEventToDurableEntry,
  redactCycloidEventSecrets,
  translateCycloidEventToSandboxEvent,
} from "./cycloid-event-store.js";
import { clearDurableStep, clearDurableStepsByPrefix, durableStep, hasDurableStep } from "./durable-step";
import {
  abortIfStaleSpawnAttempt,
  buildBridgeStartupDiagnosticsEvent,
  buildResumeFailureClearDecisionEvent,
  buildSandboxResumeWallEvent,
  CLEARED_RUNTIME_PROJECTION_STATE,
  clearRuntimeAndSyncProjection,
  decideResumeFailureClear,
  decideSupersededRuntimeTerminate,
  emitRuntimeTerminateEvent,
  type RuntimeTerminateOutcome,
  terminateRuntimeWithLog,
  type TerminateRuntimeWithLogOptions,
} from "./e2b-runtime-lifecycle";
import { deriveEffectiveVerification } from "./effective-verification";
import { appendDurableEvents } from "./events";
import { handleSessionFetch } from "./fetch-router.js";
import { applyEvent, type ApplyEventDeps } from "./fsm/apply-event";
import { shadowFireDueDeadline } from "./fsm/deadline-producer";
import { liveFsmSinks } from "./fsm/live-side-effects";
import {
  FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY,
  type NoSignalAdvanceFireResult,
  shadowFireDueNoSignalAdvance,
  shouldSelfArmNoSignalAdvance,
} from "./fsm/no-signal-advance-producer";
import { FSM_STATES, projectDisplayColumns } from "./fsm/project";
import { resolveSpineDoneMirror } from "./fsm/spine-done-mirror";
import {
  buildPlanAwaitingInputEmission,
  buildPlanUserInputEmission,
  buildPostexecDoneEmission,
  mapLifecycleEventToFsmEvents,
  transportResolver,
} from "./fsm/transport-producer";
import type { FsmRecord } from "./fsm/types";
import type {
  E2BCandidateRuntimeStatus,
  E2BOrphanGuardDecision,
  E2BOrphanGuardReasonCode,
  E2BOrphanGuardRequest,
  E2BOrphanGuardResponse,
  E2BOrphanGuardRuntimeReadUnavailableKind,
  E2BRuntimeCleanupOutcome,
  E2BRuntimeCleanupReason,
  E2BRuntimeCleanupReasonCode,
  E2BRuntimeCleanupRunRequest,
  E2BRuntimeCleanupRunResponse,
  PrePublishStallFailRequest,
  PrePublishStallFailResponse,
  SessionOffboardingPurgeRequest,
  SessionOffboardingPurgeResponse,
  SessionPhaseReaperRequest,
  ValidatePlatformLlmCapabilityRequest,
} from "./internal-routes";
import { SESSION_INTERNAL_ROUTES } from "./internal-routes";
import { defaultLifecycleConfig } from "./lifecycle/deadlines";
import { evaluateSandboxHeartbeatFreshness, type SandboxHeartbeatFreshness } from "./lifecycle/heartbeat-freshness";
import { reduceLifecycle } from "./lifecycle/reducer";
import {
  createEmptyLifecycleState,
  type LifecycleDecision,
  type LifecycleEvent,
  type LifecyclePromptPhase,
  type LifecycleSandboxState,
  type LifecycleState,
  type LifecycleStatePatch,
} from "./lifecycle/types";
import { logBlockedDmOutcome, notifyUserBlocked } from "./notify-user-blocked";
import { getPrCoordination } from "./pr-coordination-db";
import { createSessionPrWorkflow, type SessionPrWorkflow } from "./pr-workflow.js";
import {
  createSessionPromptQueue,
  getQueueState,
  isPlanModePlanPrompt,
  isStoppedByUserPromptError,
  type PromptActorProfile,
  type PromptCompletion,
  type PromptDisconnectOrigin,
  type PromptExecutionTelemetry,
  type SessionPromptQueue,
  toClientPrompt,
} from "./prompt-queue.js";
import { buildPromptTraceFinalizationEvent, serializeErrorDetails } from "./prompt-trace-event.js";
import { computeRichStatusForPublishProjection, type ResumePublishOutcome } from "./publish-service.js";
import {
  parseAuthTokenGenerations,
  rollAuthTokenGenerations,
  selectValidAuthTokenGenerations,
  serializeAuthTokenGenerations,
} from "./sandbox-auth-token-overlap.js";
import { createSessionSandboxRuntime, type SessionSandboxRuntime } from "./sandbox-runtime.js";
import {
  DISCONNECT_TERMINAL_LIFECYCLE_EVENTS,
  shouldDeferLifecycleTerminal,
} from "./sandbox-state-owners/disconnect-terminal-precedence.js";
import {
  clearPromptActivityOnSessionClose,
  recordPromptActivityForCurrentActive,
} from "./sandbox-state-owners/prompt-activity.js";
import { applyRuntimePatch, attachRuntime, refreshLease } from "./sandbox-state-owners/runtime-identity.js";
import {
  decideRuntimeTerminationOnDisconnect,
  type RuntimeLivenessProbe,
  type RuntimeTerminationDecision,
} from "./sandbox-state-owners/runtime-termination-authority.js";
import { clearSpawnStarted, markSpawnStarted, resetSpawnRetryOnSuccess } from "./sandbox-state-owners/spawn-retry.js";
import {
  clearTransportMarkers,
  scheduleAutoCloseAt,
  setDisconnectStartedAt,
} from "./sandbox-state-owners/transport-markers.js";
import { createSessionSlackNotifications, type SessionSlackNotifications } from "./slack-notifications.js";
import { getNextDueSlackPostRetry } from "./slack-posts-db";
import {
  buildSpawnBootstrapMaterial,
  loadOrCreateSpawnBootstrap,
  resumableBridgeStart,
  shouldConvergeResumeReplay,
  shouldReleaseSupersededCapacity,
  SPAWN_PHASE,
  spawnAttemptPrefix,
  spawnAttemptStepName,
  spawnCreateStepName,
  spawnCreateStepPrefix,
  type SpawnInstrumentation,
  spawnInstrumentationKey,
} from "./spawn-workflow";
import { deriveSessionStageTimings } from "./stage-timing";
import { computeDoRetryBackoffMs } from "./state";
import { listSessionPrompts } from "./state.js";
import { createSessionStatusProjection, type SessionStatusProjection } from "./status-projection.js";
import type { PromptFinalizeContext } from "./terminal-side-effects.js";
import { insertUsageRecord } from "./usage-db";
import { ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY, createSessionWsManager, type SessionWsManager } from "./ws-manager.js";

// Returns the phase string projected onto the legacy `rich_status` column.
// Pre-phase-flip this carried a `reconnecting` short-circuit for the wire alias;
// after the flip the column stores phase strings and reconnecting lives in the
// `sandboxSubstate` field on the DO + session_status frame.
function getSessionStatusForResponse(
  session: SessionState | undefined,
  sandboxStatus: string | undefined,
  activePromptId: string | null,
  publishStatus?: PublishStatus,
  postExecutionPending?: boolean,
  mostRecentPromptResultNoChanges?: boolean,
  stopReason?: doDb.SandboxStopReason | null,
  activePromptHasPendingQuestion?: boolean,
  planApprovalPending?: boolean,
  reviewListeningActive?: boolean,
  userStopped?: boolean,
): string {
  return computeRichStatus(session, {
    sandboxStatus,
    activePromptId,
    stopReason,
    activePromptHasPendingQuestion,
    planApprovalPending,
    userStopped,
    publishStatus,
    postExecutionPending,
    mostRecentPromptResultNoChanges,
    reviewListeningActive,
  });
}

import type { Phase, PhaseInfo, VerificationState } from "../../../../shared/session/phase.js";
import {
  MAX_VERIFICATION_RUNS_PER_PR,
  VERIFICATION_PENDING_RANK,
  VERIFICATION_STATE_RANK,
} from "../constants/verification";
import * as doDb from "./do-db.js";
import { publishSessionFeedDelta } from "./feed-delta";
import { attributeSessionOutcome, countRealFailedPrompts } from "./lifecycle/session-outcome.js";
import { computeRichStatus, derivePhaseInfo, getRichStatusProjectionInputs } from "./rich-status.js";
import { initSchema } from "./schema.js";
import { recordSessionOutcome, type SessionOutcomeRow } from "./session-outcome-db.js";
import { insertToolRollupRows, type PromptToolRollupRow } from "./tool-rollup-db";

interface SessionStatusFrame {
  richStatus: string;
  phaseInfo: PhaseInfo;
  planApprovalPending: boolean;
  planRevision: number;
  planStatus: SessionPlanStatus;
  uiLifecycleStage?: UiLifecycleStage;
  // Whether the DO's local session row existed when this frame was derived.
  // `computeRichStatus`/`derivePhaseInfo` map a missing session to `archived`
  // (correct for wire reads), but on the D1 projection *write* path that string
  // carries a destructive `status='archived'` side-effect. A transiently-missing
  // row (startup/hydration race) must NOT be projected as an archive — the write
  // path consults this flag and skips instead.
  sessionPresent: boolean;
}

function phaseFieldsFromInfo(info: PhaseInfo): {
  phase: PhaseInfo["phase"];
  displayStatus: ReturnType<typeof displayStatusFromPhase>;
  sandboxSubstate: PhaseInfo["sandboxSubstate"];
  stopMode: PhaseInfo["stopMode"];
  finalizingStep: PhaseInfo["finalizingStep"];
} {
  return {
    phase: info.phase,
    displayStatus: displayStatusFromPhase(info.phase),
    sandboxSubstate: info.sandboxSubstate,
    stopMode: info.stopMode,
    finalizingStep: info.finalizingStep,
  };
}

function normalizeVerificationAttemptCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizeVerificationMaxAttempts(value: unknown): number {
  const numeric = normalizeVerificationAttemptCount(value);
  return numeric > 0 ? numeric : MAX_VERIFICATION_RUNS_PER_PR;
}

function promptTimestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldPreserveVerificationState(
  currentState: VerificationState | null,
  nextState: VerificationState | null,
  opts?: { allowExhaustedClear?: boolean },
): boolean {
  // Once exhausted, never silently downgrade except to another exhausted write — UNLESS a head change
  // is explicitly clearing the verdict (allowExhaustedClear + null next). A new head deserves a fresh
  // verification attempt, so the head-change reset path is allowed to lift the exhausted lock
  // (ARC-1243); every other caller still keeps exhausted sticky.
  if (currentState === "verification-exhausted" && nextState !== "verification-exhausted") {
    if (opts?.allowExhaustedClear && nextState === null) return false;
    return true;
  }
  // Pending-demotion guard (ARC-1219): a late fire-and-forget `verification-pending` must never
  // demote a more-advanced stored state (in-progress or terminal). Per-session state, so it does
  // not block a new run's `in-progress`, which arrives through the unguarded path.
  if (
    nextState === "verification-pending" &&
    currentState !== null &&
    VERIFICATION_STATE_RANK[currentState] > VERIFICATION_PENDING_RANK
  ) {
    return true;
  }
  return false;
}

function sessionStatusFramesDiffer(left: SessionStatusFrame, right: SessionStatusFrame): boolean {
  const leftFields = phaseFieldsFromInfo(left.phaseInfo);
  const rightFields = phaseFieldsFromInfo(right.phaseInfo);
  return (
    left.richStatus !== right.richStatus ||
    left.uiLifecycleStage !== right.uiLifecycleStage ||
    left.planApprovalPending !== right.planApprovalPending ||
    left.planRevision !== right.planRevision ||
    left.planStatus !== right.planStatus ||
    leftFields.phase !== rightFields.phase ||
    leftFields.sandboxSubstate !== rightFields.sandboxSubstate ||
    leftFields.stopMode !== rightFields.stopMode ||
    leftFields.finalizingStep !== rightFields.finalizingStep
  );
}

const WEBSOCKET_READY_STATE_OPEN = 1;
const INTEGRATION_ID_SET = new Set<string>(INTEGRATION_IDS);
const INTEGRATION_LIFECYCLE_REASON_CODE_SET = new Set<string>(Object.values(INTEGRATION_LIFECYCLE_REASON_CODE));
const INTEGRATION_LIFECYCLE_STAGE_SET = new Set<string>(Object.values(INTEGRATION_LIFECYCLE_STAGE));
const INTEGRATION_LIFECYCLE_STATUS_SET = new Set<string>(Object.values(INTEGRATION_LIFECYCLE_STATUS));
const PROJECTED_BRIDGE_EVENT_TYPES = new Set([
  "token",
  "final_answer",
  "tool_call",
  "tool_update",
  "question",
  "reasoning",
  "patch",
  "usage",
  "prompt_activity",
  "agent_progress",
  "session_idle",
  "prompt_result",
  "todo_update",
  "retry_status",
  "compaction_start",
  "compaction_complete",
  "context_fill_warning",
  "raw_agent_runtime",
  "error",
  "session_error",
  "push_error",
  "agent_timeline",
  "memory_usage",
  "memory_recall_usage",
]);
const FIRST_EXECUTION_EVENT_TYPES = new Set([
  "token",
  "reasoning",
  "tool_call",
  "question",
  "error",
  "todo_update",
  "retry_status",
  "tool_truncated",
  "context_fill_warning",
  "compaction_start",
  "memory_usage",
  "memory_recall_usage",
]);
const CRITICAL_BRIDGE_EVENT_TYPES = new Set([
  "final_answer",
  "question",
  "tool_call",
  "tool_update",
  "tool_result",
  "patch",
  "session_error",
  "memory_usage",
  "usage",
]);
const PROMPT_ACTIVE_TOOL_CALLS_STORAGE_KEY_PREFIX = "prompt_active_tool_calls:";
const PROMPT_ACTIVE_TOOL_CALLS_MAX = 256;
const CRITICAL_NATIVE_SANDBOX_EVENT_TYPES = new Set([
  "execution_complete",
  "post_execution",
  "push_complete",
  "tool_result",
  "verification_phase_artifact",
]);
const CURRENT_SANDBOX_CREDENTIAL_ENV_KEYS_STORAGE_KEY = "sandbox_credential_env_keys";
const CURRENT_SANDBOX_CREDENTIAL_FINGERPRINTS_STORAGE_KEY = "sandbox_credential_fingerprints";
const RUNTIME_PREVIEW_OVERRIDE_STORAGE_KEY = "runtime_preview_override";
const USE_OPENAI_FLEX_SERVICE_TIER_STORAGE_KEY = "use_openai_flex_service_tier";
const VERIFICATION_PHASE_ARTIFACTS_STORAGE_KEY = "verification_phase_artifacts";
const STALE_PROMPT_USER_MESSAGE = "Agent stopped responding. Please start a new session to continue.";
function normalizeRuntimeProvenance(runtimeProvenance: RuntimeProvenance | null | undefined): RuntimeProvenance | null {
  if (!runtimeProvenance) return null;
  const raw = runtimeProvenance as unknown as {
    appRuntimeProfileSource?: string | null;
    appRuntimeProfileDiagnostics?: Array<AppRuntimeProfileDiagnostic | { code?: string }>;
  };
  const rawSource = raw.appRuntimeProfileSource;
  const appRuntimeProfileSource = rawSource === "disabled" ? "none" : runtimeProvenance.appRuntimeProfileSource;
  const appRuntimeProfileDiagnostics = raw.appRuntimeProfileDiagnostics?.filter(
    (diagnostic) => String(diagnostic.code) !== "docker_disabled",
  ) as AppRuntimeProfileDiagnostic[] | undefined;
  if (
    appRuntimeProfileSource === runtimeProvenance.appRuntimeProfileSource &&
    appRuntimeProfileDiagnostics === runtimeProvenance.appRuntimeProfileDiagnostics
  ) {
    return runtimeProvenance;
  }
  return {
    ...runtimeProvenance,
    appRuntimeProfileSource,
    ...(appRuntimeProfileDiagnostics ? { appRuntimeProfileDiagnostics } : {}),
  };
}

type RuntimePreviewOverride = {
  previewContract: PreviewContract;
  source: AppRuntimeProfileSource;
  diagnostics: AppRuntimeProfileDiagnostic[];
};

function coerceRuntimePreviewOverride(value: unknown): RuntimePreviewOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const contract = raw.previewContract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const rawContract = contract as Record<string, unknown>;
  const cwd = typeof rawContract.cwd === "string" ? rawContract.cwd.trim() : "";
  const rawUrl = rawContract.url;
  const hostPort =
    rawUrl && typeof rawUrl === "object" && !Array.isArray(rawUrl)
      ? (rawUrl as Record<string, unknown>).hostPort
      : null;
  if (
    cwd.length === 0 ||
    rawContract.kind !== "web" ||
    rawContract.runner !== "docker" ||
    !rawContract.entry ||
    typeof rawContract.entry !== "object" ||
    Array.isArray(rawContract.entry) ||
    !rawUrl ||
    typeof rawUrl !== "object" ||
    Array.isArray(rawUrl) ||
    typeof hostPort !== "number" ||
    !Number.isInteger(hostPort) ||
    hostPort <= 0 ||
    hostPort > 65_535
  ) {
    return null;
  }
  const previewContract = rawContract as PreviewContract;
  const source = raw.source === "config_docker" || raw.source === "none" ? raw.source : "onboarding";
  const diagnostics = Array.isArray(raw.diagnostics)
    ? raw.diagnostics.filter((diagnostic): diagnostic is AppRuntimeProfileDiagnostic => {
        if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return false;
        const entry = diagnostic as Record<string, unknown>;
        return (
          typeof entry.code === "string" && typeof entry.severity === "string" && typeof entry.message === "string"
        );
      })
    : [];
  return { previewContract, source, diagnostics };
}

function buildSandboxCredentialEnvKeys(integrationEnvVars: Record<string, string>, cloneToken: string): string[] {
  const keys = new Set(getSpawnIntegrationCredentialEnvKeys(integrationEnvVars));
  if (cloneToken) {
    keys.add("GITHUB_CLONE_TOKEN");
    keys.add("GH_TOKEN");
  }
  return [...keys].sort();
}

function buildInitialObservabilityReadiness(env: Env): ObservabilityReadiness {
  return buildSandboxObservabilityReadiness(env);
}

function parsePositiveMsEnv(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

function parsePositiveHoursEnv(value: string | undefined, fallbackHours: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackHours;
}

function parsePromptPageCursor(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function resolveDefaultE2BSandboxTemplate(env: Env): string | null {
  const configured = env.E2B_SANDBOX_TEMPLATE?.trim();
  if (configured) return configured;
  if (env.WORKER_ENV === ENVIRONMENT.Local) return "cycloid-sandbox-dev-local";
  return null;
}

function sandboxOneTimeAuthStorageKey(sessionId: string, sandboxId: string, tokenHash: string): string {
  return `sandbox_one_time_auth:${sessionId}:${sandboxId}:${tokenHash}`;
}

function sandboxOneTimeAuthStoragePrefix(sessionId: string, sandboxId: string): string {
  return `sandbox_one_time_auth:${sessionId}:${sandboxId}:`;
}

type SandboxOneTimeAuthRecord = number | { consumedAt: number; confirmedAt?: number; lastAllowedReplayAt?: number };

function isUnconfirmedSandboxOneTimeAuthRecord(record: SandboxOneTimeAuthRecord | undefined): boolean {
  if (typeof record === "number") return false;
  return typeof record?.consumedAt === "number" && typeof record.confirmedAt !== "number";
}

function shouldAllowUnconfirmedSandboxAuthReplay(
  record: SandboxOneTimeAuthRecord | undefined,
  hasOpenSandboxSocket: boolean,
): boolean {
  return isUnconfirmedSandboxOneTimeAuthRecord(record) && !hasOpenSandboxSocket;
}

function sandboxPendingOneTimeAuthStorageKey(sessionId: string, sandboxId: string): string {
  return `sandbox_pending_one_time_auth:${sessionId}:${sandboxId}`;
}

type RunningRuntimeRecordOptions = {
  sessionId: string;
  runtimeBackend: RuntimeBackend;
  runtimeSandboxId: string;
  runtimeTemplateId: string;
  sandboxId: string;
  sandboxImageVersion: string | null;
  sandboxAuthTokenHash: string;
  credentialEnvKeys: string[];
  credentialFingerprints: string[];
  dockerEnabled: boolean;
  appRuntimeProfileSource: AppRuntimeProfileSource;
  appRuntimeProfileDiagnostics: AppRuntimeProfileDiagnostic[];
  repoImagePrimaryBootEnabled: boolean;
  repoImagePrimaryBootBlockedReason: "missing_sandbox_image_version" | null;
  repoImageLookupResult: "hit" | "miss" | null;
  repoImageMissReason: RuntimeProvenance["repoImageMissReason"];
  repoImageId: string | null;
  repoImageSha: string | null;
  repoImageStartupFallback: RuntimeProvenance["repoImageStartupFallback"];
  sessionSnapshotImageId: string | null;
  bootMode: NonNullable<RuntimeProvenance["bootMode"]>;
  sandboxLayerSelection: RuntimeProvenance["sandboxLayerSelection"];
  sandboxLayerArtifact: ResolvedSandboxLayerArtifact | null;
  // Timestamp (ms) at which the E2B sandbox lifetime was last extended on the provider side.
  // `null` signals "unknown / extension failed" so the heartbeat-driven refresher will retry on
  // the next tick instead of trusting a fictional 30-min cushion.
  providerLifetimeRefreshedAt?: number | null;
};

type E2BRuntimeClientConfig = {
  runtimeBackend: RuntimeBackend;
  client: SandboxProviderClient;
  defaultTemplate: string;
  maxRunning: number | null;
};

function shouldFallbackMissingSandboxLayerArtifact(
  error: unknown,
  runtimeBackend: RuntimeBackend,
  sandboxLayerResolution: SandboxLayerSessionResolution,
): boolean {
  return (
    runtimeBackend === E2B_CLOUD_RUNTIME_BACKEND &&
    sandboxLayerResolution.decision === "selected" &&
    error instanceof E2BSandboxRuntimeError &&
    error.code === "missing_template"
  );
}

type SessionAlarmDeadlineSource =
  | "sandboxReconnectGrace"
  | "sandboxLiveness"
  | "promptStartup"
  | "promptDispatch"
  | "promptRunningInactivity"
  | "spawnTimeout"
  | "disconnectStartedAt"
  | "autoCloseScheduledAt"
  | "promptMaxDuration"
  | "verificationCommentRetry"
  | "slackNotificationRetry"
  // ARC-876: bounded lifetime for `post_execution_pending` and `publishing`.
  // These are durable pending states whose exit depends on a later async
  // event; without a deadline a lost or delayed event leaves the session in
  // `finalizing` forever. Both fire from `dispatchWatchdogAlarms()` and force
  // a terminal `publish.failed`.
  | "postExecutionDeadline"
  | "publishingDeadline"
  // ARC-1054: cleanup-retry deadline for the DO-resident E2B cleanup workflow.
  | "e2bCleanupRetry"
  | "planParkPause"
  | "planReadyNotificationRetry"
  // ARC-1330: the no-signal advance poll for the no-expected-bots cohort. Fires through
  // `shadowFireDueNoSignalAdvance` and re-arms while the PR remains in REVIEW/VERIFYING.
  | "fsmNoSignalAdvance"
  // ARC-1330 (PR 49, DE-3): precise post-publish FSM state deadline for REVIEW/VERIFYING backstops.
  // Reprojected DIRECTLY from `pr_coordination.deadline_at` (the durable source of truth — unlike the
  // no-show deadline, which has no column, so this needs NO copied DO key that could drift) so the
  // shared DO alarm wakes exactly at the committed state deadline instead of waiting for an unrelated
  // lifecycle/watchdog tick. Deliberately NOT in IMMEDIATE_CATCH_UP: only projected while the deadline
  // is still in the FUTURE. A past-due deadline is left to the opportunistic `shadowFireDueDeadline`
  // alarm() fire (the pre-PR-49 behavior) — projecting a past-due deadline as an immediate catch-up
  // would tight-loop in shadow (the fire is a no-op there, so `deadline_at` never advances) and churn
  // in live (the transition commits via `waitUntil`, after this reschedule already re-read the row).
  | "fsmStateDeadline";

type SessionAlarmDeadlineCandidate = {
  source: SessionAlarmDeadlineSource;
  deadlineAt: number;
};

// ARC-1054: internal decision shape for the DO-resident E2B cleanup workflow.
// Mirrors the prior `cleanup-decision` HTTP response but stays in-process.
type E2BCleanupDecision =
  | {
      action: "skip";
      reason: "not_e2b" | "sandbox_changed" | "backend_changed" | "live_activity_observed" | "not_expired";
    }
  | { action: "pause"; runtimeSandboxId: string; runtimeBackend: RuntimeBackend }
  | {
      action: "terminate";
      runtimeSandboxId: string;
      runtimeBackend: RuntimeBackend;
      runtimeState: "paused" | "running";
    };

type E2BCleanupJobStatus = "active" | "terminal_failed";

// DO-storage record tracking a single sandbox's cleanup attempt history. Keyed
// by sandbox id so a newer runtime never inherits a stale attempt count. `reason`
// is stored because alarm re-entry has no incoming request to read it from.
interface E2BCleanupJobRecord {
  sessionId: string;
  runtimeSandboxId: string;
  runtimeBackend: RuntimeBackend;
  reason: E2BRuntimeCleanupReason;
  attempts: number;
  firstAttemptAt: number;
  lastError: string | null;
  status: E2BCleanupJobStatus;
  terminalFailedAt?: number;
}

interface E2BCleanupRetryPointer {
  runtimeSandboxId: string;
  deadlineAt: number;
}

interface PlanParkPauseDeadline {
  deadlineAt: number;
  parkedAt: number;
  planPromptId: string;
  runtimeSandboxId: string | null;
}

interface PlanReadyDeliveryState {
  planPromptId: string;
  revision: number;
  approvable: boolean;
  attempts: number;
  status: "pending" | "sent" | "skipped" | "exhausted";
  nextAttemptAt: number | null;
}

// Thrown by a cleanup phase to signal a retryable failure carrying the
// reason code that identifies which phase failed.
class E2BCleanupRetryableError extends Error {
  constructor(
    readonly reasonCode: E2BRuntimeCleanupReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "E2BCleanupRetryableError";
  }
}

// Per-DO in-flight guard so a cron poke and an alarm retry cannot double-process
// the same sandbox's cleanup job (attempt double-counting, racing cleanup).
const e2bCleanupInFlight = new WeakMap<DurableObjectStorage, Set<string>>();

function e2bCleanupJobKey(runtimeSandboxId: string): string {
  return `${E2B_CLEANUP_JOB_STORAGE_KEY_PREFIX}${runtimeSandboxId}`;
}

function e2bCleanupStepPrefix(runtimeSandboxId: string): string {
  return `e2b_cleanup_${runtimeSandboxId}_`;
}

const IMMEDIATE_CATCH_UP_ALARM_SOURCES = new Set<SessionAlarmDeadlineSource>([
  // A sandbox-liveness deadline means the bridge stopped proving control-plane
  // contact. If a DO alarm fires late or another path reprojects after the
  // deadline is already due, catch up immediately instead of dropping the due
  // liveness kill and waiting for the slower prompt/FSM ceilings.
  "sandboxReconnectGrace",
  "sandboxLiveness",
  "disconnectStartedAt",
  "autoCloseScheduledAt",
  "promptMaxDuration",
  "promptDispatch",
  "promptStartup",
  "promptRunningInactivity",
  "verificationCommentRetry",
  "slackNotificationRetry",
  // ARC-876 watchdogs must always fire when past-due — the whole point is to
  // force a terminal state when the session has been stuck too long.
  "postExecutionDeadline",
  "publishingDeadline",
  // ARC-1054: a cleanup retry that is already past-due must still fire. DO
  // alarms run late and the retry interval itself elapses, so without this the
  // deadline would be logged-as-stale and dropped, stranding the cleanup job.
  "e2bCleanupRetry",
  "planParkPause",
  "planReadyNotificationRetry",
  // ARC-1330: the no-signal advance key may be past-due when a DO revives. Fire immediately so a no-bots
  // no-CI session advances in minutes instead of waiting for the REVIEW state deadline.
  "fsmNoSignalAdvance",
]);

const E2B_BRIDGE_HEALTH_TIMEOUT_MS = 30_000;
const E2B_BRIDGE_STARTUP_DIAGNOSTIC_TIMEOUT_MS = 20_000;
const E2B_BRIDGE_STARTUP_DIAGNOSTIC_MAX_CHARS = 12_000;
const E2B_PROVIDER_REFRESH_MARGIN_MS = 60_000;
const MEMORY_USAGE_STATS_CACHE_TTL_MS = 60_000;

type SandboxAuthFailureReason =
  | "missing_token"
  | "no_sandbox_auth_configured"
  | "invalid_token"
  | "rate_limited"
  | "missing_or_mismatched_session_id"
  | "missing_sandbox_id"
  | "sandbox_id_mismatch"
  | "token_replay";

// ARC-1248: owner-guard decision plus the liveness-guard observability fields the
// log/metrics consume. The liveness fields are populated only when the guard's
// proof-of-life gate actually ran (status known + guard enabled); otherwise the
// guard stayed on its pure-bookkeeping decision.
type E2BOwnerGuardResult = {
  decision: E2BOrphanGuardDecision;
  reasonCode: E2BOrphanGuardReasonCode;
  candidateE2bStatus?: E2BCandidateRuntimeStatus;
  lastHeartbeatAt?: number | null;
  heartbeatAgeMs?: number | null;
  staleSweeps?: number;
  runtimeReadUnavailableKind?: E2BOrphanGuardRuntimeReadUnavailableKind;
  runtimeReadUnavailableSweeps?: number;
  // The decision the pure-bookkeeping guard would have returned for this branch,
  // so the metric can count reaps the liveness gate prevented (churn prevalence).
  bookkeepingReasonCode?: E2BOrphanGuardReasonCode;
  preventedReap?: boolean;
};

type ReaperSweepCounterEntry = number | { count: number; lastSweepStartedAtMs: number | null };

const RUNTIME_READ_UNAVAILABLE_KINDS = [
  "session",
  "sandbox_runtime",
  "sandbox_backend",
] as const satisfies readonly E2BOrphanGuardRuntimeReadUnavailableKind[];

function parseCandidateE2bStatus(value: unknown): E2BCandidateRuntimeStatus | undefined {
  return value === "running" || value === "paused" || value === "unknown" ? value : undefined;
}

function getE2BRuntimeRetentionMs(env: Env): number {
  return parsePositiveHoursEnv(env.E2B_RUNTIME_RETENTION_HOURS, 72) * 60 * 60 * 1_000;
}

export function getE2BRuntimeLiveLeaseMs(env: Env): number {
  return parsePositiveMsEnv(env.E2B_RUNTIME_LIVE_LEASE_MS, E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT);
}

// Secret forms the shared redactor deliberately leaves alone (bare Basic/Token
// values and password-ish query params over-redact user-visible event text) but
// that must not reach centrally-posted diagnostics.
const DIAGNOSTIC_EXTRA_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:Basic|Token|basic|token)\s+[A-Za-z0-9._\-+/=]{12,}/g, "[REDACTED]"],
  [/([?&](?:token|api[_-]?key|access[_-]?token|secret|password|pwd|auth)=)([^&\s'"`]+)/gi, "$1[REDACTED]"],
];

export function truncateDiagnosticText(value: string | null | undefined): string {
  let text = redact(value ?? "");
  for (const [pattern, replacement] of DIAGNOSTIC_EXTRA_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length <= E2B_BRIDGE_STARTUP_DIAGNOSTIC_MAX_CHARS) return text;
  return `${text.slice(0, E2B_BRIDGE_STARTUP_DIAGNOSTIC_MAX_CHARS)}\n[truncated]`;
}

function getE2BProviderRefreshIntervalMs(env: Env): number {
  return parsePositiveMsEnv(env.E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS, 1_800_000);
}

function getE2BProviderTtlMs(env: Env): number {
  return parsePositiveMsEnv(env.E2B_RUNTIME_PROVIDER_TTL_MS, 3_600_000);
}

export function assertValidE2BProviderRefreshConfig(env: Env): {
  intervalMs: number;
  ttlMs: number;
} {
  const intervalMs = getE2BProviderRefreshIntervalMs(env);
  const ttlMs = getE2BProviderTtlMs(env);
  if (ttlMs > 3_600_000) {
    throw new Error("E2B_RUNTIME_PROVIDER_TTL_MS must be at most 3600000");
  }
  if (ttlMs <= intervalMs + E2B_PROVIDER_REFRESH_MARGIN_MS) {
    throw new Error(
      "E2B_RUNTIME_PROVIDER_TTL_MS must exceed E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS by at least 60000ms",
    );
  }
  return { intervalMs, ttlMs };
}

// Local-dev artifact fallback: DO storage values max out at 128 KiB per key, so we chunk.
const DO_STORAGE_ARTIFACT_CHUNK_SIZE = 96 * 1024;

function doStorageArtifactMetaKey(artifactId: string, filename: string): string {
  return `artifact:${artifactId}:${filename}:meta`;
}

function doStorageArtifactChunkKey(artifactId: string, filename: string, index: number): string {
  return `artifact:${artifactId}:${filename}:chunk:${index}`;
}

async function writeDoStorageArtifact(
  storage: DurableObjectStorage,
  artifactId: string,
  filename: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const chunks: Record<string, ArrayBuffer> = {};
  let chunkCount = 0;
  for (let offset = 0; offset < body.length; offset += DO_STORAGE_ARTIFACT_CHUNK_SIZE) {
    const end = Math.min(offset + DO_STORAGE_ARTIFACT_CHUNK_SIZE, body.length);
    const chunk = body.slice(offset, end);
    chunks[doStorageArtifactChunkKey(artifactId, filename, chunkCount)] = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    );
    chunkCount += 1;
  }
  await storage.transaction(async (txn) => {
    await txn.put(chunks);
    await txn.put(doStorageArtifactMetaKey(artifactId, filename), {
      contentType,
      chunkCount,
      size: body.length,
    });
  });
}

function decodeArtifactDisplayLabelHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

async function readDoStorageArtifact(
  storage: DurableObjectStorage,
  artifactId: string,
  filename: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const meta = await storage.get<{ contentType: string; chunkCount: number; size: number }>(
    doStorageArtifactMetaKey(artifactId, filename),
  );
  if (!meta) return null;
  const keys: string[] = [];
  for (let i = 0; i < meta.chunkCount; i += 1) {
    keys.push(doStorageArtifactChunkKey(artifactId, filename, i));
  }
  const chunkMap = await storage.get<ArrayBuffer>(keys);
  const merged = new Uint8Array(meta.size);
  let cursor = 0;
  for (let i = 0; i < meta.chunkCount; i += 1) {
    const chunk = chunkMap.get(doStorageArtifactChunkKey(artifactId, filename, i));
    if (!chunk) return null;
    const view = new Uint8Array(chunk);
    merged.set(view, cursor);
    cursor += view.byteLength;
  }
  return { body: merged, contentType: meta.contentType };
}

async function deleteDoStorageArtifact(
  storage: DurableObjectStorage,
  artifactId: string,
  filename: string,
): Promise<void> {
  const metaKey = doStorageArtifactMetaKey(artifactId, filename);
  const meta = await storage.get<{ chunkCount: number }>(metaKey);
  if (!meta) return;

  const keys = [metaKey];
  for (let i = 0; i < meta.chunkCount; i += 1) {
    keys.push(doStorageArtifactChunkKey(artifactId, filename, i));
  }
  await storage.delete(keys);
}

function localStorageFilenameForArtifact(artifact: doDb.SessionArtifactRow): string | null {
  const metadataFilename = artifact.metadata?.filename;
  if (typeof metadataFilename === "string" && metadataFilename.length > 0) {
    return metadataFilename;
  }

  if (!artifact.url) return null;
  try {
    const pathname = new URL(artifact.url).pathname;
    const parts = pathname.split("/");
    const artifactsIndex = parts.findIndex((part) => part === "artifacts");
    if (artifactsIndex === -1 || parts[artifactsIndex + 1] !== artifact.artifactId) return null;
    const encodedFilename = parts.slice(artifactsIndex + 2).join("/");
    return decodeArtifactPathSegment(encodedFilename);
  } catch {
    return null;
  }
}

function normalizePromptActorProfileUserId(actorUserId: string | null | undefined): string | null {
  const normalizedActorUserId = typeof actorUserId === "string" ? actorUserId.trim() : "";
  return normalizedActorUserId.length > 0 ? normalizedActorUserId : null;
}

// Map a lifecycle event to the phase-transition cause it carries. The cause
// rides through applyLifecycleDecision → applyLifecycleStatePatch /
// finalizeSandboxStopped → persistAndBroadcastSessionStatus so phase-transition
// telemetry (`@event:session.phase_transition`) can attribute each transition
// to a semantic trigger (`stop_requested`, `archive`) rather than
// always reporting `sandbox_transport_event`. Events that have no boundary
// semantics (prompt/transport state) keep the default `sandbox_transport_event`.
export function causeForLifecycleEvent(event: LifecycleEvent): PhaseTransitionCause {
  switch (event.type) {
    case "boundary.stop_finalize":
      // Same boundary fires for /session/stop (stopReason="user"), auto-close
      // on disconnect (stopReason="reaped"), publish push failure
      // (stopReason=null), and spawn failure (stopReason="spawn_failed").
      // Only the explicit user case is a true `stop_requested`; the rest are
      // sandbox-transport-driven and should not be reported as user stops.
      return event.stopReason === "user" ? "stop_requested" : "sandbox_transport_event";
    case "boundary.transport_stop_finalize":
      // WS-disconnect-driven stop; transport-driven by definition.
      return "sandbox_transport_event";
    case "boundary.close_finalize":
    case "boundary.auto_close_scheduled":
      return "archive";
    case "boundary.intentional_pause_close":
      return "sandbox_transport_event";
    default:
      return "sandbox_transport_event";
  }
}

class SessionDOBase extends DurableObject<Env> {
  declare state: DurableObjectState;

  // Cached reference for the current sandbox connection generation.
  private sandboxWs: WebSocket | null = null;
  private cachedSandboxConnectionGen: number | null = null;
  // Live-idle user-stop (resume-stopped-session): true while a manual user stop is keeping the
  // sandbox live-idle. Rides the live session_status frame only; the durable source of truth is
  // STOPPED_KEPT_ALIVE_AT_STORAGE_KEY, which rehydrates this on DO restart. Cleared at prompt admit.
  private userStopped = false;
  private planApprovalPending = false;
  private log: Logger;
  private requestId: string | null = null;
  /** Serialized queue for durable storage writes. Critical paths await it before fanout. */
  private persistenceQueue: Promise<void> = Promise.resolve();
  /** Per-session queue for rich_status D1 projections. */
  private richStatusProjectionQueues: Map<string, Promise<void>> = new Map();
  /** Serialized background queue for prompt terminal remote writes. */
  private terminalSideEffectsQueue: Promise<void> = Promise.resolve();
  // cachedActivePromptId was removed alongside session.active_prompt_id;
  // the current processing prompt is now derived synchronously from
  // doDb.getActiveProcessingPromptId(this.sql, sessionId).
  // Last phase observed per session inside this DO instance. Seeded on the
  // first derive call after a DO start; used to detect transitions for the
  // phase-transition telemetry. A single DO hosts one session, so this is
  // typically a one-entry map; keying by sessionId mirrors the rest of the DO
  // and tolerates the rare alarm-driven multi-session paths cleanly.
  private lastObservedPhase: Map<string, Phase> = new Map();
  /** Cached session ID, populated on first SQL read or during initialization. */
  private _sessionId: string | null = null;
  /** Buffered text/reasoning delta entries awaiting batch persistence. */
  private textDeltaBuffer: DurableEntry[] = [];
  /** Session + prompt metadata for the current text delta buffer. */
  private textDeltaBufferMeta: { sessionId: string; promptId?: string } | null = null;
  /** Timer handle for the text delta flush interval. */
  private textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeToolCallIdsByPrompt = new Map<string, Set<string>>();
  private socketCacheLoadPromise: Promise<void> | null = null;
  private readonly acceptedSocketTagsFallback = new WeakMap<WebSocket, string[]>();
  private handledSandboxDisconnectGenerations = new Set<number>();
  private platformLlmRateLimitBucket: { bucket: number; count: number } | null = null;
  private repoMemoriesCache = new Map<string, { loadedAt: number; memories: RepoMemoryContext[] }>();
  private e2bBridgeHealth = new Map<
    string,
    { wsConnectedAt: number | null; runtimeInfoAt: number | null; runtimeSandboxId: string | null }
  >();
  private e2bBridgeHealthWaiters = new Map<
    string,
    Array<{
      runtimeSandboxId: string;
      sinceMs: number;
      resolve: () => void;
    }>
  >();
  /**
   * Per-instance read-through cache of user profiles resolved from D1, keyed by userId.
   * In-memory caching of D1 reads within the same DO instance lifetime is explicitly allowed by
   * the repo conventions. DO eviction naturally invalidates the cache, providing the desired
   * refresh semantic for stable data such as login/avatar.
   */
  private actorProfileCache = new Map<string, PromptActorProfile | null>();
  /**
   * Narration throttle/dedup state, write-through cached from DO storage
   * (`NARRATION_THROTTLE_STATE_STORAGE_KEY`). Null until first narration use.
   */
  private narrationThrottleState: NarrationThrottleState | null = null;
  /** Whether this session can ever render narration (Slack-bound). Memoized per DO instance. */
  private narrationEligibility: boolean | null = null;
  /** Serialized queue for narration processing so throttle-state transitions never interleave. */
  private narrationChain: Promise<void> = Promise.resolve();
  /**
   * Rolling in-memory buffer of recent copy-safe activity, fed the LLM progress
   * narrator. In-memory on purpose (rebuild-tolerant): a DO restart drops it and
   * the next events refill it — no DO-storage churn per event.
   */
  private progressBuffer: ProgressBufferItem[] = [];
  /** Bumped whenever items are appended to progressBuffer; the LLM cadence's change signal. */
  private progressBufferVersion = 0;
  /** Buffer version captured at the last LLM summary (dedup: skip when unchanged). */
  private progressSummarizedBufferVersion = -1;
  /** unix-ms the last LLM narration call started (in-memory cadence spacing). */
  private lastProgressLlmAtMs = 0;
  /**
   * Set once LLM progress narration renders its first line for this DO
   * instance. From then on the LLM owns the card's narration line (refreshed on
   * its ~30s cadence); deterministic per-event lines are suppressed so tool
   * noise never buries the richer synthesis. Resets on DO restart (in-memory),
   * where the deterministic bootstrap simply runs again until the next LLM line.
   */
  private progressNarrationActive = false;
  /** At most one LLM narration call in flight per DO instance. */
  private progressNarrationInFlight = false;
  /** Internal-business gate for the LLM path (isCycloidMember). Memoized; null until resolved. */
  private progressNarrationInternal: boolean | null = null;
  /**
   * Last card stage rendered by the phase wiring — the "no-op when phase
   * unchanged" dedup. In-memory on purpose: a DO restart re-renders once
   * (idempotent chat.update), which also repairs a card the old instance
   * failed to edit.
   */
  private lastSlackPhaseCardStage: SlackStatusStage | null = null;
  private readonly promptQueue: SessionPromptQueue;
  private readonly prWorkflow: SessionPrWorkflow;
  private readonly alarmScheduler: SessionAlarmScheduler;
  private readonly sandboxRuntime: SessionSandboxRuntime;
  private readonly slackNotifications: SessionSlackNotifications;
  private readonly statusProjection: SessionStatusProjection;
  private readonly wsManager: SessionWsManager;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.log = createLogger({
      level: (env.LOG_LEVEL as LogLevel) || undefined,
      bindings: { component: "session-do" },
    });

    // Initialize DO-internal SQL schema before handling any requests.
    void this.ctx.blockConcurrencyWhile(async () => {
      try {
        initSchema(this.state.storage.sql);
      } catch (err) {
        this.log.error({ error: serializeError(err) }, "DO SQL schema initialization failed");
        Sentry.captureException(err, { tags: { operation: "schema.init" } });
        throw err;
      }
      // Rehydrate the live-idle user-stop flag so the "Stopped" badge survives DO eviction.
      this.userStopped = (await this.state.storage.get<number>(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY)) != null;
      // Rehydrate the hot-path mirror, then reconcile it from authoritative DO SQLite.
      this.planApprovalPending = (await this.state.storage.get<number>(PLAN_APPROVAL_PENDING_STORAGE_KEY)) != null;
      const sessionId = doDb.getSessionIdForDo(this.sql);
      if (sessionId) {
        await this.refreshPlanApprovalPendingMirror(sessionId);
        await this.reconcilePlanApprovalSpine(sessionId);
      } else if (this.planApprovalPending) {
        this.planApprovalPending = false;
        await this.state.storage.delete(PLAN_APPROVAL_PENDING_STORAGE_KEY);
      }
    });

    const self = this;
    this.prWorkflow = createSessionPrWorkflow({
      get state() {
        return self.state;
      },
      get env() {
        return self.env;
      },
      get log() {
        return self.log;
      },
      waitUntil: (promise) => self.ctx.waitUntil(promise),
      broadcast: (message) => self.broadcast(message),
      appendAndMirrorEvents: (sessionId, entries, promptId) =>
        self.appendAndBroadcastEvents(sessionId, entries, promptId),
      fetchInternal: (request) => self.fetch(request),
      upsertPrWebhookRef: (prUrl, sessionId) =>
        upsertSessionWebhookRef(self.env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl, sessionId),
      enterReviewListening: async ({ sessionId, prUrl, currentHeadSha }) => {
        await self.processLifecycleEvent(sessionId, {
          type: "review_listening.entered",
          prUrl,
          currentHeadSha,
        });
      },
      setVerificationStateForPr: (input) => self.setCurrentSessionVerificationStateForPr(input),
      exitReviewListening: async ({ sessionId, reason }) => {
        await self.processLifecycleEvent(sessionId, {
          type: "review_listening.exited",
          reason,
        });
      },
      rescheduleSessionAlarm: () => self.rescheduleSessionAlarm(),
      withPublishUserSettingsCache: (operation) => self.withPublishUserSettingsCache(operation),
      getDefaultPrDraft: (ownerUserId, settingsCache) => self.getDefaultPrDraft(ownerUserId, settingsCache),
    });
    this.promptQueue = createSessionPromptQueue({
      get state() {
        return self.state;
      },
      get env() {
        return self.env;
      },
      get log() {
        return self.log;
      },
      waitUntil: (promise) => self.ctx.waitUntil(promise),
      fetchInternal: (request) => self.fetch(request),
      enqueueTerminalSideEffects: (task) => self.enqueueTerminalSideEffects(task),
      capturePromptFinalizeContext: (sessionId) => self.capturePromptFinalizeContext(sessionId),
      getSandboxSocket: () => self.getSandboxSocket(),
      getSandboxHeartbeatFreshness: () => self.getSandboxHeartbeatFreshness(),
      getSandboxReconnectGraceDeadlineMs: () => self.getSandboxReconnectGraceDeadlineMs(),
      discardStaleSandboxTransport: (sessionId, reason) => self.discardStaleSandboxTransport(sessionId, reason),
      sendToSandbox: (command) => self.sendToSandbox(command),
      notePromptTransition: (sessionId, promptId) => self.notePromptTransition(sessionId, promptId),
      putSandboxStatus: (sessionId, status, options) => self.putSandboxStatus(sessionId, status, options),
      getReplayState: (sessionId) => self.getReplayState(sessionId),
      setHasPendingQuestion: (value) => self.setHasPendingQuestion(value),
      setPendingPromptDispatch: (value) => self.setPendingPromptDispatch(value),
      isCurrentSpawnAttempt: (spawnAttemptId) => self.isCurrentSpawnAttempt(spawnAttemptId),
      clearSpawnAttemptState: (clearAttemptId) => self.clearSpawnAttemptState(clearAttemptId),
      stopIdleSessionAtDurabilityBoundary: async (session, reason) => {
        await self.stopSessionAtDurabilityBoundary(session, reason, { stopReason: "user" });
      },
      stopSessionKeepAlive: (session) => self.stopSessionKeepAlive(session),
      isUserStopped: () => self.userStopped,
      startSpawnAttempt: (sessionId, operation) => self.startSpawnAttempt(sessionId, operation),
      checkSessionResumeRateLimit: (sessionId, userId) =>
        checkSessionResumeRateLimit(self.env as Env, sessionId, userId),
      schedulePromptExecutionAlarm: () => self.schedulePromptExecutionAlarm(),
      rescheduleSessionAlarm: () => self.rescheduleSessionAlarm(),
      onPlanApprovalParked: (args) => self.onPlanApprovalParked(args),
      onPlanApprovalDiscussion: (args) => self.onPlanApprovalDiscussion(args),
      onPlanApprovalApproved: (sessionId) => self.onPlanApprovalApproved(sessionId),
      onPlanApprovalStopped: (sessionId) => self.onPlanApprovalStopped(sessionId),
      cancelPlanParkPause: () => self.cancelPlanParkPause(),
      finalizePromptRun: (sessionId, prompt, session, telemetry, context) =>
        self.finalizePromptRun(sessionId, prompt, session, telemetry, context),
      runMemoryReviewBot: (sessionId, prompt, session) => self.runMemoryReviewBot(sessionId, prompt, session),
      writeUsageToD1: (sessionId, ownerUserId, promptId) => self.writeUsageToD1(sessionId, ownerUserId, promptId),
      writeCompletionToD1: (sessionId, ownerUserId, promptId, event) =>
        self.writeCompletionToD1(sessionId, ownerUserId, promptId, event),
      appendAndMirrorEvents: (sessionId, entries, promptId) =>
        self.appendAndBroadcastEvents(sessionId, entries, promptId),
      notifySlackThread: (sessionId, promptId, success) => self.notifySlackThread(sessionId, promptId, success),
      withPublishUserSettingsCache: (operation) => self.withPublishUserSettingsCache(operation),
      triggerPrCreation: (
        sessionId,
        branch,
        diffSummary,
        prTitle,
        prBody,
        verification,
        prReadiness,
        promptId,
        commitSha,
        settingsCache,
        prTemplateFill,
      ) =>
        self.prWorkflow.triggerPrCreation(
          sessionId,
          branch,
          diffSummary,
          prTitle,
          prBody,
          verification,
          prReadiness,
          promptId,
          commitSha,
          settingsCache,
          prTemplateFill,
        ),
      triggerPrUpdate: (
        sessionId,
        branch,
        diffSummary,
        prTitle,
        prBody,
        verification,
        prReadiness,
        promptId,
        commitSha,
        settingsCache,
        prTemplateFill,
      ) =>
        self.prWorkflow.triggerPrUpdate(
          sessionId,
          branch,
          diffSummary,
          prTitle,
          prBody,
          verification,
          prReadiness,
          promptId,
          commitSha,
          settingsCache,
          prTemplateFill,
        ),
      failPublishOnPushOutcome: (opts) => self.prWorkflow.failPublishOnPushOutcome(opts),
      uploadPlanMarkdownArtifact: (sessionId, promptId, markdown) =>
        self.uploadPlanMarkdownArtifact(sessionId, promptId, markdown),
      listSessionPrompts: async (sessionId) => {
        const result = await listSessionPrompts(self.env as Env, sessionId);
        if (!result.ok || !result.payload) {
          throw new Error(`Session prompts fetch failed with status ${result.status}`);
        }
        return result.payload.prompts;
      },
      prepareSessionTitle: (promptText, context) => self.prepareSessionTitle(promptText, context),
      generateSessionTitle: (sessionId, promptText, promptId) =>
        self.generateSessionTitle(sessionId, promptText, promptId),
      markReviewLoopEpochProcessing: async (_sessionId, promptId, epochId) => {
        if (!self.env.DB) return;
        await markReviewLoopEpochProcessingInD1(self.env.DB, epochId, { promptId, nowMs: Date.now() });
      },
      markReviewLoopEpochOwnerApprovalResolved: async (_sessionId, promptId, epochId) => {
        if (!self.env.DB) return;
        await markReviewLoopEpochOwnerApprovalResolvedInD1(self.env.DB, epochId, { promptId, nowMs: Date.now() });
      },
      resolveReviewLoopEpochForTerminalPrompt: async (sessionId, promptId, epochId) => {
        if (!self.env.DB) return;
        // Reply-only / no-op review turns settle the epoch terminally here (not via the publish or
        // sweep paths), so thread telemetry so these completions land in the settle-rate numerator too.
        const epoch = await resolveReviewLoopEpochForTerminalPromptInD1(self.env.DB, epochId, {
          promptId,
          nowMs: Date.now(),
          telemetry: {
            env: self.env,
            model: doDb.getSession(self.sql, sessionId)?.model ?? null,
            dispatch: (promise) => self.ctx.waitUntil(promise),
          },
        });
        await self.settleNoopVerificationReviewLoopEpoch(sessionId, epoch);
        await self.recordReviewLoopTerminalMemoryOutcome(promptId, epochId);
        // ARC-1330 (PR 41) shadow producer: a reply-only / no-diff terminal that actually SETTLED
        // (`completed`) dual-emits `epoch.replied` (re-driven `ready` / no-progress `blocked` outcomes
        // are not terminals). Best-effort/try-caught inside the helper, OFF the legacy terminal path.
        if (epoch?.status === "completed")
          await shadowEmitReviewLoopEpochTerminal(self.env, epoch, "replied", self.log, (promise) =>
            self.ctx.waitUntil(promise),
          );
      },
      blockReviewLoopEpochForUnrecoverablePrompt: async (sessionId, promptId, epochId) => {
        if (!self.env.DB) return;
        const epoch = await markReviewLoopEpochBlockedInD1(self.env.DB, epochId, {
          nowMs: Date.now(),
          reason: "runtime_unrecoverable",
          expectedPromptId: promptId,
          telemetry: {
            env: self.env,
            model: doDb.getSession(self.sql, sessionId)?.model ?? null,
            dispatch: (promise) => self.ctx.waitUntil(promise),
          },
        });
        if (epoch)
          await shadowEmitReviewLoopEpochBlockedTerminal(
            self.env,
            epoch,
            "runtime_unrecoverable",
            self.log,
            (promise) => self.ctx.waitUntil(promise),
          );
      },
      repointReviewLoopEpochPrompt: async (_sessionId, epochId, previousPromptId, nextPromptId) => {
        if (!self.env.DB) return;
        await repointReviewLoopEpochPromptInD1(self.env.DB, epochId, {
          previousPromptId,
          nextPromptId,
          nowMs: Date.now(),
        });
      },
      resolvePromptActorProfile: (actorUserId) => self.resolveActorProfileCached(actorUserId),
      armPlatformLlmPostExecutionWindow: (sessionId, promptId) =>
        self.armPlatformLlmPostExecutionWindow(sessionId, promptId),
      markPlatformLlmPromptTerminal: (sessionId, promptId) =>
        self.markPlatformLlmPromptStatus(sessionId, promptId, "terminal"),
      generatePromptCallbackAuth: async (sessionId, promptId) => {
        const secret = resolveSandboxCallbackSecret(env);
        if (!secret) throw new Error("SANDBOX_CALLBACK_SECRET is not configured");
        const token = await generateSandboxPromptCallbackToken(sessionId, promptId, secret);
        return `Bearer ${token}`;
      },
      broadcast: (message) => self.broadcast(message),
    });
    this.slackNotifications = createSessionSlackNotifications({
      get state() {
        return self.state;
      },
      get env() {
        return self.env;
      },
      get log() {
        return self.log;
      },
      get sql() {
        return self.sql;
      },
      rescheduleSessionAlarm: () => self.rescheduleSessionAlarm(),
    });
    this.alarmScheduler = createSessionAlarmScheduler({
      runAlarmTick: () => self.runAlarmTick(),
    });
    this.sandboxRuntime = createSessionSandboxRuntime({
      runSpawnSandbox: (sessionId, spawnAttemptId, operation) =>
        self.runSpawnSandbox(sessionId, spawnAttemptId, operation),
    });
    this.statusProjection = createSessionStatusProjection({
      runPersistCurrentRichStatus: (sessionId, cause, drift) =>
        self.runPersistCurrentRichStatus(sessionId, cause, drift as DriftCheckConfig),
      runPersistAndBroadcastSessionStatus: (sessionId, cause) =>
        self.runPersistAndBroadcastSessionStatus(sessionId, cause),
    });
    this.wsManager = createSessionWsManager({
      get state() {
        return self.state;
      },
      getWorkerVersionId: () => self.env.VERSION_METADATA?.id ?? null,
      get log() {
        return self.log;
      },
      resolveSessionId: () => self.resolveSessionId(),
      ensureSocketCachesLoaded: () => self.ensureSocketCachesLoaded(),
      listAcceptedWebSockets: (tag) => self.listAcceptedWebSockets(tag),
      acceptTaggedWebSocket: (ws, tags) => self.acceptTaggedWebSocket(ws, tags),
      getSocketTags: (ws) => self.getSocketTags(ws),
      getSession: (sessionId) => doDb.getSession(self.sql, sessionId),
      getSandboxReconnectState: (sessionId) => {
        const sandbox = doDb.getSandboxState(self.sql, sessionId);
        const ext = doDb.getSessionExtended(self.sql, sessionId);
        return {
          sandboxId: sandbox?.sandboxId ?? null,
          status: sandbox?.status ?? null,
          runtimeProvider: sandbox?.runtimeProvider ?? null,
          runtimeBackend: sandbox?.runtimeBackend ?? null,
          runtimeState: sandbox?.runtimeState ?? null,
          disconnectStartedAt: sandbox?.disconnectStartedAt ?? null,
          autoCloseScheduledAt: sandbox?.autoCloseScheduledAt ?? null,
          promptLastActivityAt: sandbox?.promptLastActivityAt ?? null,
          activePromptId: doDb.getActiveProcessingPromptId(self.sql, sessionId),
          spawnDurationMs: ext?.spawnDurationMs ?? null,
          intentionalPauseReason: sandbox?.intentionalPauseReason ?? null,
          stopReason: sandbox?.stopReason ?? null,
        };
      },
      updateSandboxState: (sessionId, patch) => doDb.updateSandboxState(self.sql, sessionId, patch),
      rotateSandboxAuthTokenHash: (sessionId, nextHash) => {
        const current = doDb.getSandboxState(self.sql, sessionId);
        const now = Date.now();
        const currentHash = current?.sandboxAuthTokenHash ?? null;
        // Roll the outgoing live token into the bounded N-generation overlap list
        // (newest-first), pruning expired entries and capping at
        // SANDBOX_AUTH_TOKEN_OVERLAP_GENERATIONS. A reconnect storm rolls the token
        // several times in quick succession; keeping a few prior generations valid
        // (each independently expiring after SANDBOX_AUTH_TOKEN_OVERLAP_MS) stops an
        // in-flight REST call against a 2+-generations-old token from 403-ing.
        const nextGenerations = rollAuthTokenGenerations({
          existing: parseAuthTokenGenerations(current?.prevSandboxAuthTokenHashes),
          outgoingHash: currentHash && currentHash !== nextHash ? currentHash : null,
          now,
          overlapMs: SANDBOX_AUTH_TOKEN_OVERLAP_MS,
          maxGenerations: SANDBOX_AUTH_TOKEN_OVERLAP_GENERATIONS,
        });
        doDb.updateSandboxState(self.sql, sessionId, {
          sandboxAuthTokenHash: nextHash,
          prevSandboxAuthTokenHashes: serializeAuthTokenGenerations(nextGenerations),
        });
      },
      recordPromptActivityFromTransport: (sessionId, at) => {
        recordPromptActivityForCurrentActive({
          sql: self.sql,
          sessionId,
          at,
        });
      },
      resetSpawnRetryFromTransport: (sessionId) => resetSpawnRetryOnSuccess({ sql: self.sql, sessionId }),
      clearTransportMarkersFromTransport: (sessionId) => clearTransportMarkers({ sql: self.sql, sessionId }),
      getSandboxSocket: () => self.getSandboxSocket(),
      setSandboxSocket: (ws) => (self.sandboxWs = ws),
      nextSandboxConnectionGeneration: () => self.nextSandboxConnectionGeneration(),
      closeSupersededSandboxSockets: (currentGen, excludeSocket) =>
        self.closeSupersededSandboxSockets(currentGen, excludeSocket),
      getCachedSandboxConnectionGeneration: () => self.cachedSandboxConnectionGen,
      hasHandledSandboxDisconnectGeneration: (generation) => self.handledSandboxDisconnectGenerations.has(generation),
      markSandboxDisconnectGenerationHandled: (generation) => self.handledSandboxDisconnectGenerations.add(generation),
      processSandboxMessage: (message, session, connectionGeneration) =>
        self.processSandboxMessage(message, session, connectionGeneration),
      processSandboxDisconnectForLifecycle: async (sessionId, sandboxId, detail) => {
        // Resurrection guard (sandbox-death wedge, proven via live repro): a late
        // socket-close for a sandbox whose runtime is already killed/stopped must
        // NOT flip the lifecycle back to `reconnecting` — there is nothing to
        // reconnect to. A killed VM's close frame can arrive >100s after liveness
        // expiry already routed the row to `stopped`; without this guard it
        // resurrects `reconnecting` on a dead runtime, and a review-loop prompt
        // admitted in that window wedges to the max-duration ceiling. The reducer
        // cannot see runtime_state, so gate it here against D1 sandbox_state.
        const sandbox = doDb.getSandboxState(self.sql, sessionId);
        if (sandbox && (sandbox.runtimeState === "killed" || sandbox.status === "stopped")) {
          self.log.info(
            {
              event: "sandbox_ws_disconnect_ignored_dead_runtime",
              sessionId,
              sandboxId: sandboxId ?? null,
              runtimeState: sandbox.runtimeState ?? null,
              status: sandbox.status ?? null,
            },
            "Ignoring ws_disconnected for already-dead runtime",
          );
          return;
        }
        await self.processLifecycleEvent(sessionId, {
          type: "sandbox.ws_disconnected",
          sandboxId: sandboxId ?? "",
        });
        const disconnectDetectedPayload = {
          event: "sandbox_disconnect_detected",
          sessionId,
          sandboxId: sandboxId ?? null,
          runtimeSandboxId: sandbox?.runtimeSandboxId ?? null,
          runtimeProvider: sandbox?.runtimeProvider ?? null,
          runtimeBackend: sandbox?.runtimeBackend ?? null,
          connectionGeneration: detail.connectionGeneration,
          detectedAt: detail.detectedAt,
          confirmationEligibleAt: detail.detectedAt + SANDBOX_LOSS_RECOVERY_BUDGET_MS,
          observationState: "transport_loss_observing",
          activePromptId: doDb.getActiveProcessingPromptId(self.sql, sessionId),
        };
        self.log.warn(disconnectDetectedPayload, "Sandbox disconnect detected; awaiting provider confirmation");
        self.ctx.waitUntil(self.postDiagnosticEventToDd(disconnectDetectedPayload));
      },
      dispatchSandboxConnected: async (sessionId, sandboxId) => {
        await self.processLifecycleEvent(sessionId, {
          type: "sandbox.ws_connected",
          sandboxId,
        });
      },
      finalizeTransportStop: async (sessionId, stopReason, reason) => {
        await self.processLifecycleEvent(sessionId, {
          type: "boundary.transport_stop_finalize",
          stopReason,
          reason,
        });
      },
      completeIntentionalPauseClose: async (sessionId) => {
        // Lifecycle reducer clears disconnect/auto-close markers; the host
        // also clears `intentionalPauseReason` since that marker is owned by
        // the E2B pause flow (pauseE2BRuntimeForIdle), not the reducer.
        await self.processLifecycleEvent(sessionId, { type: "boundary.intentional_pause_close" });
        doDb.updateSandboxState(self.sql, sessionId, { intentionalPauseReason: null });
      },
      notifyE2BBridgeWebSocketConnected: (sessionId) => self.notifyE2BBridgeWebSocketConnected(sessionId),
      resumeStuckPublishOnReconnect: (sessionId) => self.resumeStuckPublishOnReconnect(sessionId),
      sendPendingPromptToSandbox: (sessionId) => self.sendPendingPromptToSandbox(sessionId),
      sendPendingAnswerToSandbox: (sessionId) => self.sendPendingAnswerToSandbox(sessionId),
      putSandboxStatus: (sessionId, status, options) => self.putSandboxStatus(sessionId, status, options),
      buildClientSubscription: (sessionId, userId, afterSequenceRaw) =>
        self.buildClientSubscription(sessionId, userId, afterSequenceRaw),
      buildReplayPage: (sessionId, afterSequenceRaw, limitRaw, maxLimit) =>
        self.buildReplayPageAfterSequence(sessionId, afterSequenceRaw, limitRaw, maxLimit),
      buildReplayPageBeforeSequence: (sessionId, beforeSequenceRaw, limitRaw) =>
        self.buildReplayPageBeforeSequence(sessionId, beforeSequenceRaw, limitRaw),
      sendReplayPageMessage: (ws, page) => self.sendReplayPageMessage(ws, page),
      durableWrite: (operation, entries, sessionId) => self.durableWrite(operation, entries, sessionId),
      computeSha256Hex: (value) => computeSha256Hex(value),
      generateRandomHex: (bytes) => generateRandomHex(bytes),
      timingSafeEqualString: (left, right) => timingSafeEqualString(left, right),
      flushBufferedEventsBeforeDisconnect: () => self.flushBufferedEventsBeforeDisconnect(),
      scheduleAutoCloseAfterDisconnect: (sessionId) => self.scheduleAutoCloseAfterDisconnect(sessionId),
      failActivePromptOnDisconnect: (session, activePromptId) =>
        self.failActivePromptOnDisconnect(session, activePromptId),
      schedulePromptExecutionAlarm: () => self.schedulePromptExecutionAlarm(),
      rescheduleSessionAlarm: () => self.rescheduleSessionAlarm(),
      broadcast: (message) => self.broadcast(message),
    });
    this.configureAutoWebSocketResponses();
  }

  /** Access DO-internal SQLite database. */
  private getCloseReasonIfArchived(sessionId: string, clientStatus: string): string | null {
    return clientStatus === "archived" ? doDb.getLatestSessionCloseReason(this.sql, sessionId) : null;
  }

  private get sql(): SqlStorage {
    return this.state.storage.sql;
  }

  private buildTraceAttributes(
    sessionId?: string | null,
    promptId?: string | null,
    extras: Record<string, string | number | boolean> = {},
  ): Record<string, string | number | boolean> {
    const sandboxId = sessionId ? (doDb.getSandboxState(this.sql, sessionId)?.sandboxId ?? null) : null;
    return {
      ...(sessionId ? { "session.id": sessionId } : {}),
      ...(promptId ? { "prompt.id": promptId } : {}),
      ...(sandboxId ? { "sandbox.id": sandboxId } : {}),
      ...extras,
    };
  }

  private async recordReviewLoopTerminalMemoryOutcome(promptId: string, epochId: string): Promise<void> {
    if (!this.env.DB) return;
    const sessionId = this.resolveSessionId();
    if (!sessionId) return;
    const session = doDb.getSession(this.sql, sessionId);
    const prompt = doDb.getPrompt(this.sql, promptId);
    if (!session?.businessId || !prompt) return;
    try {
      const epoch = await getReviewLoopEpochById(this.env.DB, epochId);
      if (!epoch) return;
      const summary = await this.state.storage.get<{ text?: unknown }>(`slack_summary:${promptId}`);
      const assistantText = typeof summary?.text === "string" ? summary.text.trim() : "";
      const noChangeReason =
        prompt.result && typeof prompt.result === "object" && "noChangeReason" in prompt.result
          ? String((prompt.result as { noChangeReason?: unknown }).noChangeReason ?? "").trim()
          : "";
      const completedAtMs = prompt.completedAt ? Date.parse(prompt.completedAt) : NaN;
      await recordReviewLoopOutcomeMemoryIngestion(this.env, {
        businessId: session.businessId,
        sessionId,
        promptId,
        epochId,
        repoOwner: epoch.repoOwner,
        repoName: epoch.repoName,
        prNumber: epoch.prNumber,
        prUrl: epoch.prUrl,
        headSha: epoch.headSha,
        outcome: "prompt_terminal",
        sourceKind: epoch.sourceKind,
        sourceTimeMs: Number.isFinite(completedAtMs) ? completedAtMs : Date.now(),
        contentText: [
          `Review-loop terminal prompt for ${epoch.repoOwner}/${epoch.repoName} PR #${epoch.prNumber}.`,
          `Session: ${sessionId}`,
          `Prompt: ${promptId}`,
          `Epoch: ${epochId}`,
          `Source kind: ${epoch.sourceKind}`,
          `Head SHA: ${epoch.headSha}`,
          noChangeReason ? `No-change reason: ${noChangeReason}` : "",
          "Review-loop prompt:",
          prompt.prompt,
          assistantText ? "Agent final response:" : "",
          assistantText,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } catch (error) {
      this.log.warn(
        { sessionId, promptId, epochId, error: serializeError(error) },
        "Failed to record review-loop memory outcome",
      );
    }
  }

  private async settleNoopVerificationReviewLoopEpoch(
    sessionId: string,
    epoch: Awaited<ReturnType<typeof resolveReviewLoopEpochForTerminalPromptInD1>>,
  ): Promise<void> {
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    if (!epoch || epoch.status !== "completed" || epoch.sourceKind !== "verification") return;
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    if (!ext) return;
    if (ext.verificationState !== "verification-done" || ext.verificationResult !== "needs-work") return;

    doDb.updateSessionFields(this.sql, sessionId, {
      verificationResult: null,
      verificationNeedsWorkLabel: null,
    });
    // ARC-1330 D-59c: the DO no longer recomputes the cycloid_done aggregate — `project()` owns it from the
    // spine and is the sole D1 mirror writer. Broadcast the cleared verification result so the UI refreshes.
    await this.broadcastSessionSnapshot(sessionId);
    // ARC-1330 D-59a: the sweep's legacy review-loop rollup + done-state decision sites are deleted; the FSM
    // owns the settle at live (labels/mirror via project()). No sweep refresh to trigger.
  }

  private async runObservedSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = startSpan(name, attributes);
    return runInSpan(span, async () => {
      try {
        const result = await fn();
        endSpan(span, "ok");
        return result;
      } catch (err) {
        endSpan(span, "error", { "error.message": String(err) });
        throw err;
      }
    }) as Promise<T>;
  }

  private flushObservedSpans(): Promise<void> {
    return flushSpansToQueue(
      (this.env as Env).TRACE_QUEUE,
      "cycloid-session-do",
      normalizeEnvironment((this.env as Env).WORKER_ENV, ENVIRONMENT.Production),
    );
  }

  private async runSpawnSandboxInSpan(
    sessionId: string,
    spawnAttemptId: string | undefined,
    operation: string,
  ): Promise<void> {
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const span = startSpan("do.spawn_sandbox", {
      "session.id": sessionId,
      operation,
      ...(spawnAttemptId ? { "spawn.attempt_id": spawnAttemptId } : {}),
      ...(activePromptId ? { "prompt.id": activePromptId } : {}),
    });

    return runInSpan(span, async () => {
      try {
        await this.spawnSandbox(sessionId, spawnAttemptId, operation);
        endSpan(span, "ok");
      } catch (err) {
        endSpan(span, "error", { "error.message": String(err) });
        throw err;
      } finally {
        await this.flushObservedSpans();
      }
    }) as Promise<void>;
  }

  private enqueueTerminalSideEffects(task: () => Promise<void>): void {
    const queuedTask = this.terminalSideEffectsQueue.catch(() => undefined).then(task);
    this.terminalSideEffectsQueue = queuedTask.catch(() => undefined);
    this.ctx.waitUntil(queuedTask);
  }

  private capturePromptFinalizeContext(sessionId: string): PromptFinalizeContext {
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const sandboxState = doDb.getSandboxState(this.sql, sessionId);
    const repoOwner = ext?.repoOwner;
    const repoName = ext?.repoName;

    return {
      repo: repoOwner && repoName ? `${repoOwner}/${repoName}` : null,
      sandboxId: sandboxState?.sandboxId || null,
      modalObjectId: sandboxState?.modalObjectId || null,
      agentSessionId: ext?.agentSessionId || null,
      promptDispatchedToAgent: null,
      runtimeProvider: sandboxState?.runtimeProvider ?? null,
      runtimeBackend: sandboxState?.runtimeBackend ?? null,
    };
  }

  /**
   * Emit the `prompt.trace.finalized` Datadog event exactly once per prompt.
   * Both the bridge-terminal handler and `finalizePromptRun` (the common D1 sink
   * reached by control-plane terminals like sandbox_disconnected / spawn_* /
   * max_duration_exceeded) call this; the durableStep dedup keyed on
   * (sessionId, promptId) makes whichever path runs first win, so control-plane
   * terminal codes become queryable in Datadog without double-counting bridge
   * terminals. Fire-and-forget so finalization never waits on Datadog; a failed
   * POST is not cached by durableStep, so it is re-attempted on a later call.
   */
  private emitPromptTraceFinalizedOnce(
    sessionId: string,
    promptId: string,
    event: Record<string, unknown>,
    opts?: { replaceExisting?: boolean },
  ): void {
    const stepName = `prompt_trace_finalized:${sessionId}:${promptId}`;
    this.ctx.waitUntil(
      (async () => {
        // A stale_prompt finalization is provisional: a late execution_complete
        // can recover the prompt and finalizePromptRun rewrites the outcome. Drop
        // the prior marker so the corrected event re-emits instead of being
        // permanently suppressed by the dedup.
        if (opts?.replaceExisting) {
          await clearDurableStep(this.state.storage, stepName);
        }
        await durableStep(
          this.state.storage,
          stepName,
          async () => {
            // Throw (don't cache) when the POST is rejected, so the duplicate
            // terminal path can still retry; log only once the emit is accepted
            // so "Prompt trace finalized" is not recorded for a suppressed POST.
            const posted = await postStructuredEventToDd(this.env, event);
            if (posted === false) {
              throw new Error("prompt.trace.finalized direct-post rejected; leaving step uncached for retry");
            }
            this.log.info(event, "Prompt trace finalized");
            return true;
          },
          this.log,
        );
      })().catch(() => undefined),
    );
  }

  /**
   * Resolve the session ID from the SQL session table. Cached after first read.
   * Returns null if no session has been created yet.
   */
  private resolveSessionId(): string | null {
    if (this._sessionId) return this._sessionId;
    const rows = this.sql.exec("SELECT session_id FROM session LIMIT 1").toArray();
    if (rows.length > 0) {
      this._sessionId = rows[0].session_id as string;
    }
    return this._sessionId;
  }

  private parseAuthHeaders(request: Request): InternalAuthContext | null {
    const userId = request.headers.get("x-auth-user-id");
    if (!userId) return null;
    const canAccessAllSessions = request.headers.get("x-auth-can-access-all") === "true";
    const businessId = request.headers.get("x-auth-business-id");
    const sharedSessions = request.headers.get("x-auth-shared-sessions") === "true";
    const repoAccessVerifiedSessionId = request.headers.get("x-auth-repo-access-session-id") ?? undefined;
    const repoAccessVerifiedRepoOwner = request.headers.get("x-auth-repo-access-repo-owner") ?? undefined;
    const repoAccessVerifiedRepoName = request.headers.get("x-auth-repo-access-repo-name") ?? undefined;
    const email = request.headers.has("x-auth-user-email") ? request.headers.get("x-auth-user-email") : undefined;
    const username = request.headers.has("x-auth-user-username")
      ? request.headers.get("x-auth-user-username")
      : undefined;
    const impersonationId = request.headers.get("x-auth-impersonation-id") ?? undefined;
    const readOnly = request.headers.get("x-auth-read-only") === "true" || Boolean(impersonationId);
    const memberIdsHeader = request.headers.get("x-auth-business-member-ids");
    let businessMemberIds: string[] | undefined;
    if (memberIdsHeader) {
      // The producer (session/state.ts) always JSON.stringifies the array.
      try {
        const parsed = JSON.parse(memberIdsHeader) as unknown;
        if (Array.isArray(parsed)) {
          businessMemberIds = parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
        }
      } catch {
        // Malformed header: leave businessMemberIds unset rather than guessing.
      }
    }
    return {
      userId,
      canAccessAllSessions,
      businessId,
      sharedSessions,
      businessMemberIds,
      ...(repoAccessVerifiedSessionId ? { repoAccessVerifiedSessionId } : {}),
      ...(repoAccessVerifiedRepoOwner ? { repoAccessVerifiedRepoOwner } : {}),
      ...(repoAccessVerifiedRepoName ? { repoAccessVerifiedRepoName } : {}),
      email,
      username,
      ...(impersonationId ? { impersonationId } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    };
  }

  private getSessionOwnerUserId(): string | null {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return null;
    return doDb.getSession(this.sql, sessionId)?.ownerUserId ?? null;
  }

  private async setSentryUserContext(
    userId: string,
    overrides?: { email?: string | null; username?: string | null },
  ): Promise<void> {
    try {
      const hasEmailOverride = overrides !== undefined && "email" in overrides;
      const hasUsernameOverride = overrides !== undefined && "username" in overrides;
      const shouldLookupProfile = this.env.DB && !(hasEmailOverride && hasUsernameOverride);
      const profile = shouldLookupProfile ? await getUserSentryProfile(this.env.DB, userId) : null;
      const email = hasEmailOverride ? (overrides.email ?? undefined) : (profile?.email ?? undefined);
      const username = hasUsernameOverride ? (overrides.username ?? undefined) : (profile?.username ?? undefined);
      Sentry.setUser({
        id: userId,
        email,
        username,
      });
    } catch (err) {
      this.log.warn({ userId, error: serializeError(err) }, "Failed to hydrate Sentry user context");
    }
  }

  private async applySentryUserContext(request: Request, ownerUserId?: string | null): Promise<void> {
    const auth = this.parseAuthHeaders(request);
    if (auth?.userId) {
      const overrides = {
        ...(auth.email !== undefined ? { email: auth.email } : {}),
        ...(auth.username !== undefined ? { username: auth.username } : {}),
      };
      await this.setSentryUserContext(auth.userId, Object.keys(overrides).length > 0 ? overrides : undefined);
      return;
    }

    const sessionOwnerUserId = ownerUserId ?? this.getSessionOwnerUserId();
    if (!sessionOwnerUserId) return;
    await this.setSentryUserContext(sessionOwnerUserId);
  }

  private checkAccess(auth: InternalAuthContext, session: SessionState): boolean {
    if (auth.canAccessAllSessions) return true;
    if (auth.userId === session.ownerUserId) return true;
    if (auth.sharedSessions && businessIdsMatch(auth.businessId, session.businessId)) {
      const ext = doDb.getSessionExtended(this.sql, session.sessionId);
      // Fail closed to mirror the worker's authorizeSessionRepoAccess gate: a
      // non-owner shared-business member must prove route-level GitHub repo
      // access. With no repo context we cannot prove access, so deny rather than
      // grant. The worker already 404s this case, so this only removes a
      // defense-in-depth divergence (fail-open) that would leak a teammate's
      // session by id if a future caller reached the DO without the worker gate.
      // Owners and all-session operators already returned above.
      if (!ext?.repoOwner || !ext.repoName) {
        return false;
      }
      return (
        auth.repoAccessVerifiedSessionId === session.sessionId &&
        auth.repoAccessVerifiedRepoOwner === ext.repoOwner &&
        auth.repoAccessVerifiedRepoName === ext.repoName
      );
    }
    return false;
  }

  private configureAutoWebSocketResponses(): void {
    if (
      typeof this.ctx.setWebSocketAutoResponse !== "function" ||
      typeof WebSocketRequestResponsePair === "undefined"
    ) {
      return;
    }

    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    // Bridge heartbeats include variable sandbox/timestamp data, so they still wake the DO.
  }

  private async ensureSocketCachesLoaded(): Promise<void> {
    if (!this.socketCacheLoadPromise) {
      this.socketCacheLoadPromise = (async () => {
        // sandbox_connection_gen: stays in KV (ephemeral)
        const sandboxConnectionGen = (await this.state.storage.get("sandbox_connection_gen")) as number | undefined;
        if (typeof sandboxConnectionGen === "number") {
          this.cachedSandboxConnectionGen = sandboxConnectionGen;
        }
      })();
    }
    await this.socketCacheLoadPromise;
  }

  private listAcceptedWebSockets(tag?: string): WebSocket[] {
    if (typeof this.ctx.getWebSockets === "function") {
      return this.ctx.getWebSockets(tag);
    }
    return [];
  }

  private acceptTaggedWebSocket(ws: WebSocket, tags: string[]): void {
    this.acceptedSocketTagsFallback.set(ws, tags);
    if (typeof this.ctx.acceptWebSocket === "function") {
      this.ctx.acceptWebSocket(ws, tags);
      return;
    }
    ws.accept();
  }

  private getSocketTags(ws: WebSocket): string[] {
    if (typeof this.ctx.getTags === "function") {
      const tags = this.ctx.getTags(ws);
      if (tags.length > 0) return tags;
    }
    return this.acceptedSocketTagsFallback.get(ws) ?? [];
  }

  private getSocketTagValue(tags: string[], prefix: string): string | null {
    const tag = tags.find((entry) => entry.startsWith(prefix));
    return tag ? tag.slice(prefix.length) : null;
  }

  private getSandboxConnectionGeneration(tags: string[]): number | null {
    const value = this.getSocketTagValue(tags, "gen:");
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async nextSandboxConnectionGeneration(): Promise<number> {
    const current =
      ((await this.state.storage.get(SANDBOX_CONNECTION_GENERATION_STORAGE_KEY)) as number | undefined) ?? 0;
    const next = current + 1;
    this.cachedSandboxConnectionGen = next;
    this.handledSandboxDisconnectGenerations.delete(next);
    await this.state.storage.put(SANDBOX_CONNECTION_GENERATION_STORAGE_KEY, next);
    return next;
  }

  private coerceLifecycleSandboxState(value: unknown): LifecycleSandboxState | null {
    return typeof value === "string" &&
      ["none", "spawning", "connecting", "ready", "reconnecting", "stopping", "stopped", "failed"].includes(value)
      ? (value as LifecycleSandboxState)
      : null;
  }

  private coerceLifecyclePromptPhase(value: unknown): LifecyclePromptPhase | null {
    return typeof value === "string" && ["none", "queued", "dispatching", "running", "terminal"].includes(value)
      ? (value as LifecyclePromptPhase)
      : null;
  }

  private async readLifecycleState(sessionId: string): Promise<LifecycleState> {
    const state = createEmptyLifecycleState();
    const session = doDb.getSession(this.sql, sessionId);
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const promptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const prompt = promptId ? doDb.getPrompt(this.sql, promptId) : null;
    const stored = await this.state.storage.get([
      LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
      LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
      LIFECYCLE_SPAWN_IN_PROGRESS_STORAGE_KEY,
      LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY,
      LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY,
      LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
      LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
      LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
      LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
      LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
      LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
    ]);
    const storedSandbox = stored.get(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY);
    const storedPrompt = stored.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY);
    const sandboxRecord =
      storedSandbox && typeof storedSandbox === "object" && !Array.isArray(storedSandbox)
        ? (storedSandbox as Partial<LifecycleState["sandbox"]>)
        : {};
    const promptRecord =
      storedPrompt && typeof storedPrompt === "object" && !Array.isArray(storedPrompt)
        ? (storedPrompt as Partial<LifecycleState["prompt"]>)
        : {};
    const storedSandboxState = this.coerceLifecycleSandboxState(sandboxRecord.state);
    const storedPromptPhase = this.coerceLifecyclePromptPhase(promptRecord.phase);

    state.sessionStatus = session?.status === "archived" ? "archived" : "active";
    state.sandbox = {
      ...state.sandbox,
      ...sandboxRecord,
      state: storedSandboxState ?? this.mapSandboxStatusToLifecycle(sandbox?.status),
      sandboxId: sandboxRecord.sandboxId ?? sandbox?.sandboxId ?? null,
      spawnInProgress: stored.get(LIFECYCLE_SPAWN_IN_PROGRESS_STORAGE_KEY) === true || sandbox?.status === "spawning",
      spawnFailureCount:
        typeof stored.get(LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY) === "number"
          ? (stored.get(LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY) as number)
          : (sandbox?.spawnRetryCount ?? 0),
      lastSpawnFailureAt:
        typeof stored.get(LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY) === "number"
          ? (stored.get(LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY) as number)
          : null,
    };
    state.prompt = {
      ...state.prompt,
      ...promptRecord,
      phase:
        storedPromptPhase ??
        (prompt?.status === "processing"
          ? "running"
          : prompt?.status === "queued"
            ? "queued"
            : prompt
              ? "terminal"
              : "none"),
      promptId: promptRecord.promptId ?? promptId,
      sandboxId: promptRecord.sandboxId ?? sandbox?.sandboxId ?? null,
    };
    state.reviewListening = {
      active: ext?.reviewListeningActive ?? false,
      prUrl: ext?.reviewListeningPrUrl ?? null,
      currentHeadSha: ext?.reviewListeningHeadSha ?? null,
      enteredAt: ext?.reviewListeningEnteredAt ?? null,
    };
    state.deadlines = {
      sandboxReconnectGrace: this.coerceDeadline(stored.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY)),
      sandboxLiveness: this.coerceDeadline(stored.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)),
      promptStartup: this.coerceDeadline(stored.get(LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY)),
      promptDispatch: this.coerceDeadline(stored.get(LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY)),
      promptRunningInactivity: this.coerceDeadline(
        stored.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY),
      ),
      spawnTimeout: this.coerceDeadline(stored.get(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY)),
    };
    return state;
  }

  private mapSandboxStatusToLifecycle(status: string | null | undefined): LifecycleSandboxState {
    if (status === "spawning") return "spawning";
    if (status === "ready") return "ready";
    if (status === "reconnecting") return "reconnecting";
    if (status === "stopping") return "stopping";
    if (status === "stopped") return "stopped";
    if (status === "failed") return "failed";
    return "none";
  }

  private async applyLifecycleStatePatch(
    sessionId: string,
    patch: LifecycleStatePatch,
    options: { delegateSandboxStateWrite?: boolean; cause?: PhaseTransitionCause } = {},
  ): Promise<void> {
    // `delegateSandboxStateWrite` lets a caller (currently the
    // finalize_sandbox_stopped applier) own the D1 sandbox_state write and the
    // rich-status sync/broadcast atomically. Without this, the patch's
    // sandbox.state="stopped" write triggers a sync before the caller has had
    // a chance to write fields like stopReason, broadcasting a transient
    // `phase=stopped` frame with `stopMode=resumable` (the default) before the
    // user/resumable distinction is settled.
    const delegate = options.delegateSandboxStateWrite === true;
    let sandboxStateChanged = false;
    let reviewListeningChanged = false;
    if (patch.sandbox) {
      const current = await this.state.storage.get<Partial<LifecycleState["sandbox"]>>(
        LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
      );
      // Strip D1-only transport markers from the DO-storage snapshot — they
      // are persisted in D1 sandbox_state, not in lifecycle storage.
      const { disconnectStartedAt: _d, autoCloseScheduledAt: _a, ...lifecycleSandboxPatch } = patch.sandbox;
      void _d;
      void _a;
      await this.state.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        ...(current ?? {}),
        ...lifecycleSandboxPatch,
      });
      if (!delegate && patch.sandbox.state && patch.sandbox.state !== "none" && patch.sandbox.state !== "connecting") {
        doDb.updateSandboxState(this.sql, sessionId, { status: patch.sandbox.state });
        sandboxStateChanged = true;
      }
      // Transport markers (`disconnectStartedAt`, `autoCloseScheduledAt`) live
      // only in D1 sandbox_state, not DO lifecycle storage. The reducer is the
      // single source of truth: set them via patch (ws_disconnected,
      // boundary.auto_close_scheduled) or clear them via patch (ws_connected,
      // boundary.intentional_pause_close). When delegating
      // (finalize_sandbox_stopped) the caller writes its own atomic patch.
      if (!delegate && patch.sandbox.disconnectStartedAt !== undefined) {
        setDisconnectStartedAt({ sql: this.sql, sessionId, at: patch.sandbox.disconnectStartedAt });
      }
      if (!delegate && patch.sandbox.autoCloseScheduledAt !== undefined) {
        scheduleAutoCloseAt({ sql: this.sql, sessionId, at: patch.sandbox.autoCloseScheduledAt });
      }
      // Belt-and-suspenders: any transition to "stopped" without explicit clears
      // still wipes the markers so reducers that emit a "stopped" patch don't
      // need to enumerate every transport field.
      if (
        !delegate &&
        patch.sandbox.state === "stopped" &&
        patch.sandbox.disconnectStartedAt === undefined &&
        patch.sandbox.autoCloseScheduledAt === undefined
      ) {
        clearTransportMarkers({ sql: this.sql, sessionId });
      }
      if (patch.sandbox.sandboxId !== undefined)
        doDb.updateSandboxState(this.sql, sessionId, { sandboxId: patch.sandbox.sandboxId });
      if (patch.sandbox.spawnInProgress !== undefined) {
        await this.state.storage.put(LIFECYCLE_SPAWN_IN_PROGRESS_STORAGE_KEY, patch.sandbox.spawnInProgress);
      }
      if (patch.sandbox.spawnFailureCount !== undefined) {
        await this.state.storage.put(LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY, patch.sandbox.spawnFailureCount);
      }
      if (patch.sandbox.lastSpawnFailureAt !== undefined) {
        await this.putOrDeleteLifecycleDeadline(
          LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY,
          patch.sandbox.lastSpawnFailureAt,
        );
      }
    }
    if (patch.prompt) {
      const current = await this.state.storage.get<Partial<LifecycleState["prompt"]>>(
        LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
      );
      // The Slack "Running" card edit moved to the phase-transition wiring in
      // runPersistAndBroadcastSessionStatus (queueSlackPhaseCardUpdate), which
      // covers every projected-phase flip — including this prompt-start one via
      // notePromptTransition's status broadcast — with stage dedup + narration
      // coalescing. A second direct edit here would race/duplicate it.
      await this.state.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, { ...(current ?? {}), ...patch.prompt });
    }
    if (patch.reviewListening) {
      const current = doDb.getSessionExtended(this.sql, sessionId);
      const active = patch.reviewListening.active ?? current?.reviewListeningActive ?? false;
      const prUrl =
        patch.reviewListening.prUrl !== undefined
          ? patch.reviewListening.prUrl
          : (current?.reviewListeningPrUrl ?? null);
      const currentHeadSha =
        patch.reviewListening.currentHeadSha !== undefined
          ? patch.reviewListening.currentHeadSha
          : (current?.reviewListeningHeadSha ?? null);
      const enteredAt =
        patch.reviewListening.enteredAt !== undefined
          ? patch.reviewListening.enteredAt
          : (current?.reviewListeningEnteredAt ?? null);
      doDb.updateSessionFields(this.sql, sessionId, {
        reviewListeningActive: active,
        reviewListeningPrUrl: prUrl,
        reviewListeningHeadSha: currentHeadSha,
        reviewListeningEnteredAt: enteredAt,
      });
      reviewListeningChanged = true;
    }
    if (patch.deadlines) {
      await Promise.all([
        patch.deadlines.sandboxReconnectGrace !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
              patch.deadlines.sandboxReconnectGrace,
            )
          : Promise.resolve(),
        patch.deadlines.sandboxLiveness !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
              patch.deadlines.sandboxLiveness,
            )
          : Promise.resolve(),
        patch.deadlines.promptStartup !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
              patch.deadlines.promptStartup,
            )
          : Promise.resolve(),
        patch.deadlines.promptDispatch !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
              patch.deadlines.promptDispatch,
            )
          : Promise.resolve(),
        patch.deadlines.promptRunningInactivity !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
              patch.deadlines.promptRunningInactivity,
            )
          : Promise.resolve(),
        patch.deadlines.spawnTimeout !== undefined
          ? this.putOrDeleteLifecycleDeadline(
              LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
              patch.deadlines.spawnTimeout,
            )
          : Promise.resolve(),
      ]);
    }
    // Lifecycle patches that change sandbox.state or review-listening state
    // bypass persistCurrentRichStatus, leaving session_index.rich_status frozen
    // at whatever value preceded the lifecycle decision. Re-project so the
    // sidebar list reflects the new state on next read, except when delegated
    // sandbox finalization owns the atomic sync.
    if (sandboxStateChanged || (reviewListeningChanged && !delegate)) {
      const cause = options.cause ?? "sandbox_transport_event";
      // Transport-driven lifecycle path: local sandbox_state is already
      // durable. Swallow projection rejection through Sentry rather than
      // halting alarm/transport processing.
      await this.swallowLifecyclePersistence(
        sessionId,
        cause,
        () => this.persistAndBroadcastSessionStatus(sessionId, cause),
        "",
      );
    }
  }

  private async putOrDeleteLifecycleDeadline(key: string, deadline: number | null): Promise<void> {
    if (deadline === null) {
      await this.state.storage.delete(key);
      return;
    }
    await this.state.storage.put(key, deadline);
  }

  private async applyLifecycleDecision(
    sessionId: string,
    decision: LifecycleDecision,
    applyTerminal: boolean,
    cause: PhaseTransitionCause = "sandbox_transport_event",
  ): Promise<void> {
    if (decision.action === "persist_state") {
      await this.applyLifecycleStatePatch(sessionId, decision.patch, { cause });
      return;
    }
    if (decision.action === "arm_alarm") {
      const now = Date.now();
      if (decision.deadlineAt <= now) {
        await this.rescheduleSessionAlarm();
        return;
      }
      await this.state.storage.setAlarm(Math.max(decision.deadlineAt, now + MIN_ALARM_DELAY_MS));
      return;
    }
    if (decision.action === "emit_terminal" && applyTerminal) {
      const message = this.messageForLifecycleTerminal(decision.errorCode);
      this.log.warn(
        {
          event: "lifecycle_terminal",
          sessionId,
          promptId: decision.promptId,
          errorCode: decision.errorCode,
          reason: decision.reason,
        },
        "Lifecycle terminal decision applied",
      );
      const finalize = () =>
        this.completeActivePrompt(
          sessionId,
          { success: false, error: message, errorCode: decision.errorCode },
          decision.promptId,
          "execution_complete",
        );
      if (decision.reason === "prompt dispatch deadline elapsed") {
        await durableStep(
          this.state.storage,
          `prompt_dispatch_watchdog_finalize_${sessionId}_${decision.promptId}`,
          finalize,
          this.log,
        );
      } else {
        await finalize();
      }
      return;
    }
    if (decision.action === "stop_sandbox") {
      await this.sendToSandbox({ type: "stop" });
      return;
    }
    if (decision.action === "finalize_sandbox_stopped") {
      // Defensive flush: the canonical flush happens just before the terminal
      // `session_stopped` / `session_closed` `appendAndBroadcastEvents(...)` call
      // in {stop,close}SessionAtDurabilityBoundary. ws-manager flushes via
      // `flushBufferedEventsBeforeDisconnect` before transport_stop_finalize.
      // This is a belt-and-suspenders fallback so any future finalize entry
      // point inherits the ordering even if it forgets the upstream flush.
      // `flushTextDeltaBuffer` is idempotent — a no-op when the buffer is empty.
      await this.flushTextDeltaBuffer();
      // Update DO storage state (sandbox.state, deadlines, etc.) WITHOUT
      // triggering applyLifecycleStatePatch's own D1 sandbox_state write or
      // rich-status sync. finalizeSandboxStopped owns the atomic D1 patch
      // (status + stopReason + cleanup fields) plus the single sync+broadcast.
      await this.applyLifecycleStatePatch(sessionId, decision.patch, {
        delegateSandboxStateWrite: true,
        cause,
      });
      await this.finalizeSandboxStopped(sessionId, {
        stopReason: decision.stopReason,
        preserveExistingStopReason: decision.preserveExistingStopReason,
        cause,
      });
      return;
    }
    if (decision.action === "spawn_sandbox" || decision.action === "noop") {
      return;
    }
  }

  private messageForLifecycleTerminal(errorCode: ErrorCode): string {
    if (isErrorCode(errorCode)) return errorCodeLabel(errorCode);
    return STALE_PROMPT_USER_MESSAGE;
  }

  private async processLifecycleEvent(
    sessionId: string,
    event: LifecycleEvent,
    options: { applyTerminal?: boolean; suppressFsmTransport?: boolean } = {},
  ): Promise<LifecycleDecision[]> {
    const now = Date.now();
    const state = await this.readLifecycleState(sessionId);
    const coldStart = await this.state.storage.get<boolean>("spawn_cold_start");
    const config = defaultLifecycleConfig({
      runningInactivityMs: this.getPromptExecutionTimeoutMs(),
      // Do NOT override sandboxLivenessMs here: the heartbeat-liveness watchdog
      // must use the short ~60s window (deadlines.ts default), not the 15-min
      // prompt-execution timeout, so a silent socket reaches provider observation.
      spawnTimeoutMs: this.getSpawnConnectTimeoutMs(coldStart),
    });
    const decisions = reduceLifecycle(state, event, config, now);
    // Single structured log per event so transitions are queryable in Datadog
    // (`@event:lifecycle_event`). Decision summary is included so
    // noop/persist-only events are still observable without spelunking.
    const lifecycleEventPayload = {
      event: "lifecycle_event",
      sessionId,
      eventType: event.type,
      decisionCount: decisions.length,
      decisionActions: decisions.map((d) => d.action),
    };
    this.log.info(lifecycleEventPayload, "Lifecycle event processed");
    // ARC-1196: direct-post so lifecycle transitions stay queryable even when
    // Workers Logs/logpush is unavailable — this exact data was missing from
    // the zombie-socket investigation. Detached via waitUntil; metadata only.
    // Heartbeat/running-activity events are excluded: they fire continuously
    // during active prompts and would dominate the direct-post volume.
    if (!HIGH_FREQUENCY_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      this.ctx.waitUntil(postStructuredEventToDd(this.env, lifecycleEventPayload));
    }
    const cause = causeForLifecycleEvent(event);
    for (const decision of decisions) {
      await this.applyLifecycleDecision(sessionId, decision, options.applyTerminal === true, cause);
    }
    // ARC-1330 (PR 36) transport producer: DUAL-EMIT the reducer's `sandbox.*`/`prompt.*` boundary
    // activity onto the shadow spine. SHADOW + additive + BEST-EFFORT/try-caught OFF the legacy path —
    // a producer fault never perturbs the live lifecycle. No-op when D1 is unbound (local/test).
    const session = doDb.getSession(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const activePrompt = activePromptId ? doDb.getPrompt(this.sql, activePromptId) : null;
    const gatedPlanWillParkFromTerminal =
      session?.planApprovalRequired === true &&
      activePrompt != null &&
      isPlanModePlanPrompt(session, activePrompt) &&
      [
        "sandbox.liveness_expired",
        "sandbox.reconnect_grace_expired",
        "prompt.running_inactivity_elapsed",
        "prompt.startup_deadline_elapsed",
        "prompt.dispatch_deadline_elapsed",
      ].includes(event.type);
    if (!options.suppressFsmTransport && !gatedPlanWillParkFromTerminal) {
      await this.shadowEmitFsmTransportEvents(sessionId, event, decisions);
    }
    return decisions;
  }

  /**
   * ARC-1330 (PR 36) — build the `applyEvent` deps for the transport producer, or `null` when D1 is
   * unbound (local/test). The transport resolver supplies the guard values the pre-REVIEW transport
   * edges read.
   */
  private buildFsmTransportDeps(sessionId: string): ApplyEventDeps | null {
    const db = (this.env as Env).DB;
    if (!db) return null;
    return {
      db,
      env: this.env as Env,
      now: Date.now,
      // PR 47 scope guard: transport stays EMIT-ONLY (live authority is the POST-PUBLISH families only —
      // the resolver's structural hold). The genesis/transport side-effect kinds stay INERT (structured
      // skip) per the Wave-10 scope decision: the transport reducer keeps its authority. Effects defer
      // through the DO's waitUntil.
      resolver: transportResolver(sessionId),
      ...liveFsmSinks(this.env as Env, { waitUntil: (promise) => this.ctx.waitUntil(promise) }),
    };
  }

  /**
   * ARC-1330 (PR 36) — map the transport reducer's `(event, decisions)` onto spine `sandbox.*`/`prompt.*`
   * events and apply them to the shadow `pr_coordination` row. SHADOW/observe-only: the whole body is
   * try-caught OFF the legacy critical path (the producer dual-emit contract), so a shadow fault is
   * isolated to this method. Emits nothing when the reducer staled the event or it has no spine analog.
   */
  private async shadowEmitFsmTransportEvents(
    sessionId: string,
    event: LifecycleEvent,
    decisions: readonly LifecycleDecision[],
  ): Promise<void> {
    const emissions = mapLifecycleEventToFsmEvents(event, decisions);
    if (emissions.length === 0) return;
    const planApprovalPending = doDb.getLatestSessionPlan(this.sql, sessionId)?.status === "pending";
    if (
      planApprovalPending &&
      emissions.some((emission) =>
        [
          "prompt.terminal",
          "prompt.max_duration_exceeded",
          "sandbox.spawn_failed",
          "sandbox.death",
          "sandbox.liveness_expired",
        ].includes(emission.event.type),
      )
    ) {
      return;
    }
    const deps = this.buildFsmTransportDeps(sessionId);
    if (!deps) return;
    try {
      for (const emission of emissions) {
        await applyEvent(deps, {
          sessionId,
          event: emission.event,
          metadata: emission.metadata,
          actor: emission.actor,
        });
      }
    } catch (err) {
      this.log.warn({ sessionId, error: String(err) }, "fsm transport producer failed (ignored)");
    }
  }

  /**
   * ARC-1330 (PR 36) — the post-execution diff decision → shadow `postexec.done` (FINALIZING→PUBLISHING
   * vs ANSWERED_NO_PR). Sourced from the bridge `post_execution` event (`hasChanges`/`promptIntendsChange`),
   * not the reducer boundary. SHADOW/observe-only, try-caught OFF the legacy critical path.
   */
  private async shadowEmitPostexecDone(
    sessionId: string,
    hasChanges: boolean,
    promptIntendsChange: boolean,
  ): Promise<void> {
    const deps = this.buildFsmTransportDeps(sessionId);
    if (!deps) return;
    try {
      const emission = buildPostexecDoneEmission(hasChanges, promptIntendsChange);
      await applyEvent(deps, {
        sessionId,
        event: emission.event,
        metadata: emission.metadata,
        actor: emission.actor,
      });
    } catch (err) {
      this.log.warn({ sessionId, error: String(err) }, "fsm postexec.done producer failed (ignored)");
    }
  }

  /**
   * ARC-876: clear any armed watchdog state. Called from terminal-transition
   * sites (archive, manual stop, hard failure) so the alarm scheduler does
   * not later fire on a closed session. The CAS guard in dispatchWatchdogAlarms
   * is the second line of defense if a watchdog row survives.
   */
  private disarmLifecycleWatchdogs(sessionId: string): void {
    doDb.casDisarmLifecycleWatchdog(this.sql, { sessionId, updatedAt: Date.now() });
    doDb.updateSessionFields(this.sql, sessionId, { publishingStartedAt: null });
  }

  /**
   * ARC-876: fires any past-due post-execution or publishing watchdogs.
   * Post-execution is per-prompt (multiple prompts can be pending at once);
   * publishing is per-session. Each fire does flush → CAS → mark terminal →
   * forced `publish.failed`, so the timeline records both a late success (if
   * it ever arrives) and the watchdog-induced terminal failure.
   */
  private async dispatchWatchdogAlarms(sessionId: string): Promise<void> {
    const now = Date.now();
    // ARC-876: terminal sessions have nothing in flight; if a watchdog row
    // somehow survived (DO eviction between archive and disarm), short-circuit
    // here so we never write into an archived session.
    const session = doDb.getSession(this.sql, sessionId);
    if (!session || session.status === "archived") return;
    const ext = doDb.getSessionExtended(this.sql, sessionId);

    // Post-execution watchdog (per-prompt). Read pending rows fresh inside the
    // critical block so the CAS check operates on the current truth.
    const pending = doDb.getPlatformLlmPromptStatusesPending(this.sql, sessionId);
    for (const record of pending) {
      const startedAt = record.startedAt;
      if (startedAt === null) continue;
      const deadlineAt = startedAt + POST_EXECUTION_DEADLINE_MS;
      if (deadlineAt > now) continue;
      const promptId = record.promptId;

      await this.runCriticalPersistence(async () => {
        await this.flushTextDeltaBuffer();
        // CAS-check: re-read the row inside the critical block. If status or
        // started_at has changed, the slot has cleared or re-armed and we
        // no-op (the success event already landed, or another prompt cycle
        // started). The durable timeline still shows both transitions if a
        // late success arrives after this point.
        const current = doDb.getPlatformLlmPromptStatus(this.sql, promptId);
        if (!current || current.status !== "post_execution_pending" || current.startedAt !== startedAt) {
          return;
        }
        const elapsedMs = now - startedAt;
        this.markPlatformLlmPromptStatus(sessionId, promptId, "terminal");
        await this.prWorkflow.failPublishOnTimeout({
          sessionId,
          phase: "post_execution",
          stage: "verifying",
          elapsedMs,
          promptId,
        });
        const telemetry = doDb.getPromptTelemetry(this.sql, sessionId)[promptId];
        this.log.warn(
          {
            event: "watchdog.expired",
            sessionId,
            promptId,
            phase: "post_execution",
            deadlineMs: POST_EXECUTION_DEADLINE_MS,
            elapsedMs,
            startedAt,
            firedAt: now,
            ddTraceId: telemetry?.ddTraceId ?? null,
            btSpanId: telemetry?.btSpanId ?? null,
          },
          "ARC-876 post-execution watchdog expired",
        );
      });
    }

    // Publishing watchdog (per-session). Only one publish-in-flight at a time
    // so a single timestamp slot is sufficient.
    const publishingStartedAt = ext?.publishingStartedAt;
    if (ext?.publishStatus === "publishing" && publishingStartedAt !== null && publishingStartedAt !== undefined) {
      const deadlineAt = publishingStartedAt + PUBLISHING_DEADLINE_MS;
      if (deadlineAt <= now) {
        await this.runCriticalPersistence(async () => {
          await this.flushTextDeltaBuffer();
          const fresh = doDb.getSessionExtended(this.sql, sessionId);
          if (!fresh || fresh.publishStatus !== "publishing" || fresh.publishingStartedAt !== publishingStartedAt) {
            return;
          }
          const elapsedMs = now - publishingStartedAt;
          const stage = (fresh.publishStage ?? "verifying") as PublishStage;
          // ARC-876 backstop: try to RESUME the stalled publish first — re-driving
          // the real publish path converges it to the correct terminal (published /
          // skipped / blocked) instead of forcing a failure on work that actually
          // finished. The forced timeout failure is the safety net, so it MUST run
          // whenever resume does not make progress — including when resume throws
          // (else the callback would abort before the fallback and leave the row
          // stuck at `publishing` forever, the exact wedge this targets).
          let resumeOutcome: ResumePublishOutcome | null = null;
          let resumeThrew = false;
          try {
            resumeOutcome = await this.prWorkflow.resumeStuckPublish({
              sessionId,
              trigger: "publishing_watchdog",
            });
          } catch (error) {
            resumeThrew = true;
            this.log.warn(
              {
                event: "publish_resume_threw",
                sessionId,
                phase: "publishing",
                error: stringifyError(error),
              },
              "Publishing-watchdog resume threw; falling back to forced timeout failure",
            );
          }
          const afterResume = doDb.getSessionExtended(this.sql, sessionId);
          const stillPublishing = afterResume?.publishStatus === "publishing";
          // A `deferred` resume (review-loop operation already running) legitimately
          // leaves the row at `publishing`; that work is in flight, not stuck, so do
          // not force-fail it. The next deadline crossing re-checks.
          const resumeDeferred = resumeOutcome?.resumed === true && resumeOutcome.status === "deferred";
          const forcedTimeoutFailure = stillPublishing && !resumeDeferred;
          if (forcedTimeoutFailure) {
            await this.prWorkflow.failPublishOnTimeout({
              sessionId,
              phase: "publishing",
              stage,
              elapsedMs,
              promptId: doDb.getActiveProcessingPromptId(this.sql, sessionId) ?? undefined,
            });
          }
          this.log.warn(
            {
              event: "watchdog.expired",
              sessionId,
              phase: "publishing",
              stage,
              deadlineMs: PUBLISHING_DEADLINE_MS,
              elapsedMs,
              startedAt: publishingStartedAt,
              firedAt: now,
              resumed: resumeOutcome?.resumed ?? false,
              resumeOutcome: resumeThrew
                ? "threw"
                : resumeOutcome
                  ? resumeOutcome.resumed
                    ? resumeOutcome.status
                    : resumeOutcome.reason
                  : null,
              forcedTimeoutFailure,
            },
            "ARC-876 publishing watchdog expired",
          );
        });
      }
    }
  }

  private async dispatchLifecycleAlarm(
    sessionId: string,
  ): Promise<{ handled: boolean; eventTypes: LifecycleEvent["type"][] }> {
    const state = await this.readLifecycleState(sessionId);
    const now = Date.now();
    const events: LifecycleEvent[] = [];
    if (state.deadlines.sandboxReconnectGrace !== null && state.deadlines.sandboxReconnectGrace <= now) {
      events.push({ type: "sandbox.reconnect_grace_expired", sandboxId: state.sandbox.sandboxId });
    }
    if (state.deadlines.promptStartup !== null && state.deadlines.promptStartup <= now && state.prompt.promptId) {
      events.push({ type: "prompt.startup_deadline_elapsed", promptId: state.prompt.promptId });
    }
    if (state.deadlines.promptDispatch !== null && state.deadlines.promptDispatch <= now && state.prompt.promptId) {
      events.push({ type: "prompt.dispatch_deadline_elapsed", promptId: state.prompt.promptId });
    }
    if (
      state.deadlines.promptRunningInactivity !== null &&
      state.deadlines.promptRunningInactivity <= now &&
      state.prompt.promptId
    ) {
      events.push({ type: "prompt.running_inactivity_elapsed", promptId: state.prompt.promptId });
    }
    if (state.deadlines.sandboxLiveness !== null && state.deadlines.sandboxLiveness <= now && state.sandbox.sandboxId) {
      events.push({ type: "sandbox.liveness_expired", sandboxId: state.sandbox.sandboxId });
    }
    if (
      state.deadlines.spawnTimeout !== null &&
      state.deadlines.spawnTimeout <= now &&
      state.sandbox.startupAttemptId
    ) {
      const sandboxState = doDb.getSandboxState(this.sql, sessionId);
      // While the canonical sandbox_state row still says "spawning", the
      // prompt queue owns spawn timeout retry/exhaustion and bridge diagnostics.
      // Letting the lifecycle reducer consume the deadline first bypasses that
      // path and can strand the session with no retry attempt.
      // Other statuses intentionally keep the lifecycle path: they mean the
      // sandbox row has moved on and the stale spawn deadline should be cleared
      // through the lifecycle reducer rather than retried as an active spawn.
      if (sandboxState?.status !== "spawning") {
        const classifiedErrorCode = classifySpawnTimeoutPhase({
          origin: "deadline",
          providerObjectId: sandboxState?.runtimeSandboxId ?? sandboxState?.modalObjectId,
        });
        events.push({
          type: "sandbox.spawn_failed",
          startupAttemptId: state.sandbox.startupAttemptId,
          errorCode: classifiedErrorCode,
        });
      }
    }
    if (events.length === 0) return { handled: false, eventTypes: [] };

    // NOTE: any prompt-deadline event added below `sandbox.liveness_expired` (11)
    // that can terminalize the active prompt must also be listed in
    // DISCONNECT_PREEMPTED_PROMPT_DEADLINE_EVENTS (disconnect-terminal-precedence.ts),
    // or it will finalize the prompt ahead of a co-batched disconnect re-enqueue.
    const order: Record<LifecycleEvent["type"], number> = {
      "prompt.abort_requested": 0,
      "sandbox.spawn_failed": 1,
      "sandbox.reconnect_grace_expired": 2,
      "prompt.startup_deadline_elapsed": 3,
      "prompt.dispatch_deadline_elapsed": 4,
      "prompt.running_inactivity_elapsed": 5,
      "sandbox.spawn_requested": 6,
      "sandbox.spawn_succeeded": 7,
      "sandbox.ws_connected": 8,
      "sandbox.heartbeat_received": 9,
      "sandbox.ws_disconnected": 10,
      "sandbox.liveness_expired": 11,
      "sandbox.stop_requested": 12,
      "sandbox.stop_completed": 13,
      "prompt.enqueued": 14,
      "prompt.sent_to_bridge": 15,
      "prompt.bridge_accepted": 16,
      "prompt.dispatching_progress": 17,
      "prompt.agent_prompt_sent": 18,
      "prompt.running_activity": 19,
      "prompt.running_keepalive": 20,
      "prompt.terminal_received": 21,
      "boundary.stop_finalize": 22,
      "boundary.close_finalize": 23,
      "boundary.pre_publish_stall_expired": 24,
      "boundary.transport_stop_finalize": 25,
      "boundary.auto_close_scheduled": 26,
      "boundary.intentional_pause_close": 27,
      "review_listening.entered": 28,
      "review_listening.epoch_enqueued": 29,
      "review_listening.exited": 30,
    };
    events.sort((left, right) => order[left.type] - order[right.type]);
    const eventTypes = events.map((event) => event.type);
    // A disconnect-terminal event (silent VM death via liveness, or clean-close
    // reconnect-grace) routes the still-`processing` prompt through the bounded
    // disconnect re-enqueue in the alarm handler, not the reducer's terminal.
    // When one is due this batch, defer prompt-deadline terminalization too so a
    // deadline sorted ahead of liveness cannot finalize the prompt first.
    const batchHasDisconnectTerminal = events.some((event) => DISCONNECT_TERMINAL_LIFECYCLE_EVENTS.has(event.type));
    await this.ctx.blockConcurrencyWhile(async () => {
      for (const event of events) {
        await this.processLifecycleEvent(sessionId, event, {
          applyTerminal: !shouldDeferLifecycleTerminal(event.type, batchHasDisconnectTerminal),
        });
      }
    });
    await this.rescheduleSessionAlarm();
    return { handled: true, eventTypes };
  }

  private closeSupersededSandboxSockets(currentGen: number, excludeSocket?: WebSocket): void {
    for (const ws of this.listAcceptedWebSockets("sandbox")) {
      if (ws === excludeSocket || ws.readyState !== WEBSOCKET_READY_STATE_OPEN) continue;
      const tags = this.getSocketTags(ws);
      const gen = this.getSandboxConnectionGeneration(tags);
      if (gen !== null && gen !== currentGen) {
        this.log.info(
          { event: "sandbox_connection_superseded", oldGen: gen, newGen: currentGen },
          "Closing superseded sandbox connection",
        );
        try {
          ws.close(1000, "Superseded by newer connection");
        } catch {
          // Ignore best-effort close failures on stale sockets.
        }
      }
    }
  }

  private getSandboxSocket(): WebSocket | null {
    if (this.sandboxWs?.readyState === WEBSOCKET_READY_STATE_OPEN) return this.sandboxWs;

    const openSockets = this.listAcceptedWebSockets("sandbox")
      .filter((ws) => ws.readyState === WEBSOCKET_READY_STATE_OPEN)
      .map((ws) => {
        const tags = this.getSocketTags(ws);
        return { ws, tags, gen: this.getSandboxConnectionGeneration(tags) };
      });

    if (openSockets.length === 0) {
      this.sandboxWs = null;
      return null;
    }

    const effectiveGen =
      this.cachedSandboxConnectionGen ??
      openSockets.reduce<number | null>((max, candidate) => {
        if (candidate.gen === null) return max;
        if (max === null || candidate.gen > max) return candidate.gen;
        return max;
      }, null);

    if (effectiveGen !== null) {
      this.closeSupersededSandboxSockets(effectiveGen);

      const current = openSockets.find((candidate) => candidate.gen === effectiveGen);
      if (current) {
        this.cachedSandboxConnectionGen = effectiveGen;
        this.sandboxWs = current.ws;
        return current.ws;
      }
    }

    this.sandboxWs = openSockets[0]?.ws ?? null;
    return this.sandboxWs;
  }

  private getClientSockets(): WebSocket[] {
    return this.listAcceptedWebSockets("client").filter((ws) => ws.readyState === WEBSOCKET_READY_STATE_OPEN);
  }

  /** Freshness of the lifecycle `lastHeartbeatAt` against the platform liveness bound (ARC-1196). */
  private async getSandboxHeartbeatFreshness(now = Date.now()): Promise<SandboxHeartbeatFreshness> {
    const stored = await this.state.storage.get(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY);
    return evaluateSandboxHeartbeatFreshness(stored, now);
  }

  /**
   * ARC-1196: tear down a zombie transport (socket open at the edge, dead VM
   * behind it) so a prompt admission can cold-resume instead of dispatching
   * into the void. Ordering is load-bearing:
   * 1. Mark the current connection generation handled so the async
   *    `webSocketClose` delivery for the discarded socket is ignored by the
   *    ws-manager dispatcher — otherwise it would see the prompt admitted
   *    right after this and grace/fail it as `sandbox_disconnected`.
   * 2. Finalize the transport stop through the lifecycle reducer so D1
   *    sandbox status reads `stopped` (stopReason `reaped` → cold-resumable)
   *    before the caller computes resume state.
   * 3. Close the socket last; by then the close event is inert.
   */
  private async discardStaleSandboxTransport(sessionId: string, reason: string): Promise<void> {
    const generation = this.cachedSandboxConnectionGen;
    if (generation !== null) {
      this.handledSandboxDisconnectGenerations.add(generation);
    }
    await this.flushBufferedEventsBeforeDisconnect();
    await this.processLifecycleEvent(sessionId, {
      type: "boundary.transport_stop_finalize",
      stopReason: "reaped",
      reason,
    });
    this.closeSandboxSockets(reason);
    this.log.info(
      {
        event: "stale_sandbox_transport_discarded",
        sessionId,
        reason,
        connectionGeneration: generation,
      },
      "stale_sandbox_transport_discarded",
    );
  }

  private closeSandboxSockets(reason: string): void {
    for (const ws of this.listAcceptedWebSockets("sandbox")) {
      try {
        ws.close(1000, reason);
      } catch {
        // Best effort; E2B runtime state remains canonical.
      }
    }
    this.sandboxWs = null;
    this.cachedSandboxConnectionGen = null;
  }

  private notifyE2BBridgeWebSocketConnected(sessionId: string): void {
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    if (!sandbox || !isKnownRuntimeProvider(sandbox.runtimeProvider) || !sandbox.runtimeSandboxId) return;
    const health = this.e2bBridgeHealth.get(sessionId) ?? {
      wsConnectedAt: null,
      runtimeInfoAt: null,
      runtimeSandboxId: null,
    };
    health.wsConnectedAt = Date.now();
    this.e2bBridgeHealth.set(sessionId, health);
    this.resolveE2BBridgeHealthWaiters(sessionId, sandbox.runtimeSandboxId);
  }

  /**
   * ARC-876 fast path. The bridge has just (re)connected. If a deploy evicted the
   * DO while a publish was in flight, the session is sitting at
   * `publishStatus = "publishing"` (textarea disabled). Resume now so it converges
   * well before the 20-min publishing watchdog. Detached via `waitUntil` so the WS
   * upgrade is never blocked; errors are swallowed (the watchdog backstop and a
   * later reconnect both retry). A cheap pre-check avoids a flush on the common
   * not-stuck path; concurrent re-triggers during churn collapse into the
   * per-prompt single-flight inside `publishSessionResult`.
   */
  resumeStuckPublishOnReconnect(sessionId: string): void {
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    if (ext?.publishStatus !== "publishing") return;
    this.ctx.waitUntil(
      (async () => {
        try {
          await this.flushTextDeltaBuffer();
          await this.prWorkflow.resumeStuckPublish({ sessionId, trigger: "bridge_reconnect" });
        } catch (error) {
          this.log.warn(
            {
              event: "publish_resume_on_reconnect_failed",
              sessionId,
              error: stringifyError(error),
            },
            "Resume-on-reconnect failed",
          );
        }
      })(),
    );
  }

  private notifyE2BRuntimeInfo(sessionId: string, runtime: RuntimeReport): void {
    // RuntimeReport.provider carries the provider the bridge reports: current bundles
    // derive it from ARCANIST_RUNTIME_PROVIDER ("e2b" | "freestyle"); bundles baked
    // before the derivation sweep hardcode "e2b". Admit any known provider so the
    // bridge-health waiters (waitForE2BBridgeHealth) resolve for freestyle too.
    if (!isKnownRuntimeProvider(runtime.provider) || !runtime.sandboxId) return;
    const health = this.e2bBridgeHealth.get(sessionId) ?? {
      wsConnectedAt: null,
      runtimeInfoAt: null,
      runtimeSandboxId: null,
    };
    health.runtimeInfoAt = Date.now();
    health.runtimeSandboxId = runtime.sandboxId;
    this.e2bBridgeHealth.set(sessionId, health);
    this.resolveE2BBridgeHealthWaiters(sessionId, runtime.sandboxId);
  }

  private resolveE2BBridgeHealthWaiters(sessionId: string, runtimeSandboxId: string): void {
    const waiters = this.e2bBridgeHealthWaiters.get(sessionId);
    if (!waiters?.length) return;
    const health = this.e2bBridgeHealth.get(sessionId);
    if (!health?.wsConnectedAt || !health.runtimeInfoAt) return;

    const remaining: typeof waiters = [];
    for (const waiter of waiters) {
      const healthy =
        waiter.runtimeSandboxId === runtimeSandboxId &&
        health.runtimeSandboxId === runtimeSandboxId &&
        health.wsConnectedAt >= waiter.sinceMs &&
        health.runtimeInfoAt >= waiter.sinceMs;
      if (healthy) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length > 0) {
      this.e2bBridgeHealthWaiters.set(sessionId, remaining);
    } else {
      this.e2bBridgeHealthWaiters.delete(sessionId);
    }
  }

  private async waitForE2BBridgeHealth(
    sessionId: string,
    runtimeSandboxId: string,
    sinceMs: number,
    timeoutMs = E2B_BRIDGE_HEALTH_TIMEOUT_MS,
  ): Promise<boolean> {
    const existing = this.e2bBridgeHealth.get(sessionId);
    if (
      existing?.wsConnectedAt &&
      existing.runtimeInfoAt &&
      existing.runtimeSandboxId === runtimeSandboxId &&
      existing.wsConnectedAt >= sinceMs &&
      existing.runtimeInfoAt >= sinceMs
    ) {
      return true;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.e2bBridgeHealthWaiters.get(sessionId) ?? [];
        this.e2bBridgeHealthWaiters.set(
          sessionId,
          waiters.filter((waiter) => waiter.resolve !== onHealthy),
        );
        resolve(false);
      }, timeoutMs);
      const onHealthy = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const waiters = this.e2bBridgeHealthWaiters.get(sessionId) ?? [];
      waiters.push({ runtimeSandboxId, sinceMs, resolve: onHealthy });
      this.e2bBridgeHealthWaiters.set(sessionId, waiters);
    });
  }

  private async collectE2BBridgeStartupDiagnostics(
    sessionId: string,
    sandboxState: doDb.SandboxStateRow | null | undefined,
    reason: string,
  ): Promise<void> {
    if (!sandboxState || !isKnownRuntimeProvider(sandboxState.runtimeProvider) || !sandboxState.runtimeSandboxId) {
      // Previously a silent return -- so a missing provider/object id looked
      // identical to "diagnostics ran but found nothing". Log it so the absence
      // of a capture is itself explained in telemetry.
      this.log.info(
        {
          event: "sandbox.bridge_startup_diagnostics",
          sessionId,
          reason,
          runtimeProvider: sandboxState?.runtimeProvider ?? null,
          hasRuntimeSandboxId: Boolean(sandboxState?.runtimeSandboxId),
        },
        "Skipped E2B bridge startup diagnostics: not an E2B runtime with a sandbox id",
      );
      this.postBridgeStartupDiagnosticsEvent({
        outcome: "skipped",
        sessionId,
        runtimeSandboxId: sandboxState?.runtimeSandboxId ?? null,
        reason,
        exitCode: null,
      });
      return;
    }

    await this.runE2BBridgeStartupDiagnostics({
      sessionId,
      runtimeSandboxId: sandboxState.runtimeSandboxId,
      runtimeBackend: sandboxState.runtimeBackend ?? this.readPersistedRuntimeBackend(sessionId),
      reason,
    });
  }

  private async runE2BBridgeStartupDiagnostics(args: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    reason: string;
  }): Promise<void> {
    const { sessionId, runtimeSandboxId, runtimeBackend, reason } = args;
    let client: SandboxProviderClient;
    try {
      client = this.buildRuntimeClientConfig(runtimeBackend).client;
    } catch (error) {
      this.log.warn(
        {
          event: "sandbox.bridge_startup_diagnostics",
          sessionId,
          runtimeSandboxId,
          reason,
          error: serializeError(error),
        },
        "Skipped E2B bridge startup diagnostics because runtime client could not be created",
      );
      this.postBridgeStartupDiagnosticsEvent({
        outcome: "skipped",
        sessionId,
        runtimeSandboxId,
        reason,
        exitCode: null,
      });
      return;
    }

    const controlPlaneUrl = (this.env as Env).CONTROL_PLANE_URL || "https://app.trycycloid.com";
    const controlPlaneWsUrl = `${controlPlaneUrl.replace(/\/+$/, "")}/api/sessions/${sessionId}/ws?type=sandbox`;
    const diagnosticScript = buildBridgeStartupDiagnosticScript({
      controlPlaneUrl,
      controlPlaneWsUrl,
    });

    try {
      const result = await client.runCommand({
        runtimeSandboxId,
        command: `bash -lc ${shellQuote(diagnosticScript)}`,
        timeoutMs: E2B_BRIDGE_STARTUP_DIAGNOSTIC_TIMEOUT_MS,
      });
      const stdout = truncateDiagnosticText(result.stdout);
      const stderr = truncateDiagnosticText(result.stderr);
      // This capture only runs after the bridge has provably failed to connect
      // by the spawn deadline, so it logs at warn.
      this.log.warn(
        {
          event: "sandbox.bridge_startup_diagnostics",
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          reason,
          exitCode: result.exitCode,
          stdout,
          stderr,
        },
        "Collected E2B bridge startup diagnostics after missing bridge connection",
      );
      this.postBridgeStartupDiagnosticsEvent({
        outcome: "collected",
        sessionId,
        runtimeSandboxId,
        reason,
        exitCode: result.exitCode,
        stdout,
        stderr,
      });
    } catch (error) {
      const serialized = serializeError(error);
      const stderr = truncateDiagnosticText(JSON.stringify(serialized));
      this.log.warn(
        {
          event: "sandbox.bridge_startup_diagnostics",
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          reason,
          error: serialized,
        },
        "Failed to collect E2B bridge startup diagnostics after missing bridge connection",
      );
      this.postBridgeStartupDiagnosticsEvent({
        outcome: "failed",
        sessionId,
        runtimeSandboxId,
        reason,
        exitCode: null,
        stderr,
      });
    }
  }

  // Direct-post bridge-startup diagnostics outcomes: the diagnostics already log
  // under `sandbox.bridge_startup_diagnostics`, but control-plane app logs are not
  // shipped to Datadog, so the only queryable signal is a direct-posted event.
  // Swallow post failures like the cross-check pattern elsewhere in this file.
  private postBridgeStartupDiagnosticsEvent(fields: {
    outcome: "collected" | "skipped" | "failed";
    sessionId: string;
    runtimeSandboxId: string | null;
    reason: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
  }): void {
    this.ctx.waitUntil(
      postStructuredEventToDd(this.env, buildBridgeStartupDiagnosticsEvent(fields)).catch(() => false),
    );
  }

  private async buildClientPromptsWithActorProfiles(
    sessionId: string,
    prompts: PromptState[],
    sessionModel?: string | null,
    sessionReasoningEffort?: string | null,
    actorProfileTiming?: SessionViewReadTiming,
  ): Promise<ClientPrompt[]> {
    const actorUserIds = new Set<string>();
    for (const prompt of prompts) {
      const actorUserId = normalizePromptActorProfileUserId(prompt.actorUserId);
      if (actorUserId) actorUserIds.add(actorUserId);
    }
    const actorProfiles = await this.resolveActorProfilesCached(actorUserIds, actorProfileTiming);

    return prompts.map((prompt) => {
      const actorUserId = normalizePromptActorProfileUserId(prompt.actorUserId);
      const actorProfile = actorUserId ? (actorProfiles.get(actorUserId) ?? null) : null;
      return toClientPrompt(prompt, sessionId, sessionModel, sessionReasoningEffort, {
        includeUploadedImageData: true,
        actorProfile,
      });
    });
  }

  private async getRuntimeProvenance(): Promise<RuntimeProvenance | null> {
    return normalizeRuntimeProvenance(await this.state.storage.get<RuntimeProvenance>("runtime_provenance"));
  }

  private async putRuntimeProvenance(runtimeProvenance: RuntimeProvenance | null): Promise<void> {
    if (!runtimeProvenance) {
      await this.state.storage.delete("runtime_provenance");
      return;
    }
    await this.state.storage.put("runtime_provenance", runtimeProvenance);
  }

  private async putObservabilityReadiness(observabilityReadiness: ObservabilityReadiness | null): Promise<void> {
    if (!observabilityReadiness) {
      await this.state.storage.delete("observability_readiness");
      return;
    }
    await this.state.storage.put("observability_readiness", observabilityReadiness);
  }

  private getSandboxAuthFailureIp(request: Request): string {
    const rawIp = request.headers.get("x-sandbox-client-ip")?.trim() || "unknown";
    return rawIp.slice(0, 128) || "unknown";
  }

  private logSandboxAuthFailure(request: Request, sessionId: string | null, reason: SandboxAuthFailureReason): void {
    this.log.warn(
      {
        event: "sandbox_auth_failure",
        ip: this.getSandboxAuthFailureIp(request),
        userAgent: request.headers.get("user-agent") ?? null,
        sessionId,
        reason,
        timestamp: new Date().toISOString(),
      },
      "Sandbox auth failure",
    );
  }

  private async recordSandboxAuthFailure(
    request: Request,
    sessionId: string | null,
    reason: SandboxAuthFailureReason,
  ): Promise<Response | null> {
    this.logSandboxAuthFailure(request, sessionId, reason);
    const ip = this.getSandboxAuthFailureIp(request);
    const rateLimit = await checkSandboxAuthFailureRateLimit(this.env as Env, ip);
    if (!rateLimit.limited) return null;
    this.logSandboxAuthFailure(request, sessionId, "rate_limited");
    return jsonErrorResponse("Too many sandbox auth failures", 429);
  }

  // Max telemetry body accepted by the broker handlers (5 MB). Larger payloads
  // are rejected with 413 before any upstream forward.
  private static readonly TELEMETRY_MAX_BODY_BYTES = 5 * 1024 * 1024;

  // The exact set of Braintrust SDK subpaths the broker forwards, mapped to their
  // fixed upstreams and HTTP methods. The logger flow is login -> project register
  // -> logs3; `api/project/register` and `api/apikey/login` are app-host endpoints
  // (appConn -> www.braintrust.dev), `logs3` and the `version` payload-limit probe
  // are api-host endpoints (apiConn). `version` is a GET (the SDK swallows its
  // failure and falls back to a default cap, but routing it lets the SDK honor the
  // real server limit and removes the 404 noise). Anything else is rejected with
  // 403. Keep this to exactly the SDK's endpoints -- a drift between this map and
  // the SDK's actual calls silently drops or degrades telemetry.
  private static readonly BRAINTRUST_UPSTREAM_BY_SUBPATH: Record<string, { method: "GET" | "POST"; url: string }> = {
    "api/apikey/login": { method: "POST", url: "https://www.braintrust.dev/api/apikey/login" },
    "api/project/register": { method: "POST", url: "https://www.braintrust.dev/api/project/register" },
    logs3: { method: "POST", url: "https://api.braintrust.dev/logs3" },
    version: { method: "GET", url: "https://api.braintrust.dev/version" },
  };

  // Per-session telemetry rate limit, shared across the three broker handlers.
  // SANDBOX_AUTH_TOKEN is agent-visible by design, so a prompt-injected agent
  // can reach these routes; the cap stops it from burning platform DD/Braintrust
  // /Sentry quota. 120/min is far above legitimate shipper traffic (dd-logs
  // flushes every few seconds, Braintrust login + periodic flushes, rare Sentry
  // envelopes). In-memory on the session DO — the DO is per-session, so the key
  // is implicit; an eviction resets the window, which only ever under-counts.
  private static readonly TELEMETRY_RATE_LIMIT_MAX = 120;
  private static readonly TELEMETRY_RATE_LIMIT_WINDOW_MS = 60_000;
  private telemetryRateWindowStartMs = 0;
  private telemetryRateCount = 0;

  private checkTelemetryRateLimit(sessionId: string): boolean {
    const now = Date.now();
    if (now - this.telemetryRateWindowStartMs >= SessionDOBase.TELEMETRY_RATE_LIMIT_WINDOW_MS) {
      this.telemetryRateWindowStartMs = now;
      this.telemetryRateCount = 0;
    }
    this.telemetryRateCount += 1;
    if (this.telemetryRateCount === SessionDOBase.TELEMETRY_RATE_LIMIT_MAX + 1) {
      // Log only on the first rejection of the window, not per dropped request.
      this.log.warn(
        { event: "telemetry_rate_limited", sessionId, max: SessionDOBase.TELEMETRY_RATE_LIMIT_MAX },
        "Session exceeded the telemetry broker rate limit; dropping until the window resets",
      );
    }
    return this.telemetryRateCount <= SessionDOBase.TELEMETRY_RATE_LIMIT_MAX;
  }

  private async readTelemetryBody(
    request: Request,
  ): Promise<{ ok: true; body: Uint8Array<ArrayBuffer> } | { ok: false; response: Response }> {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > SessionDOBase.TELEMETRY_MAX_BODY_BYTES) {
      return { ok: false, response: new Response("Payload too large", { status: 413 }) };
    }
    return { ok: true, body };
  }

  /**
   * Datadog logs broker. Reads the raw (optionally gzipped) batch and forwards
   * it to the platform DD logs intake with the server-side DD-API-KEY injected.
   * Returns 204 (no-op) when no platform key is configured. Fire-and-forget:
   * the sandbox does not need the upstream response.
   */
  private async handleTelemetryDdLogs(request: Request): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;
    if (!this.checkTelemetryRateLimit(auth.sessionId)) {
      return jsonErrorResponse("Telemetry rate limit exceeded", 429);
    }

    const contentEncoding = request.headers.get("content-encoding");
    const telemetryBody = await this.readTelemetryBody(request);
    if (!telemetryBody.ok) return telemetryBody.response;
    const { body } = telemetryBody;

    const env = this.env as Env;
    if (!env.DD_API_KEY) {
      this.log.debug({ event: "telemetry_dd_logs_noop", sessionId: auth.sessionId }, "No DD_API_KEY; dropping dd-logs");
      return new Response(null, { status: 204 });
    }

    const intakeUrl = `https://http-intake.logs.${DD_DEFAULT_SITE}/api/v2/logs`;
    const headers: Record<string, string> = {
      "DD-API-KEY": env.DD_API_KEY,
      "Content-Type": "application/json",
    };
    if (contentEncoding) headers["Content-Encoding"] = contentEncoding;

    this.ctx.waitUntil(
      tracedFetch(intakeUrl, { method: "POST", headers, body }, "telemetry.dd-logs").catch((err) => {
        this.log.warn(
          { event: "telemetry_dd_logs_forward_failed", sessionId: auth.sessionId, error: serializeError(err) },
          "Failed to forward dd-logs to Datadog",
        );
      }),
    );
    return new Response(null, { status: 202 });
  }

  /**
   * Braintrust broker. Allowlists the SDK subpaths (login, project registration,
   * log ingest, and the version payload-limit probe) and forwards to the fixed
   * Braintrust upstreams with the platform Authorization injected (overriding any
   * client-sent auth). The Braintrust SDK needs the real response, so this awaits
   * the upstream and returns its status + body. Returns 204 when no platform key
   * is configured. `api/project/register` is required: the logger resolves its
   * project id there before any `logs3` flush, so omitting it silently drops all
   * telemetry. `version` is a bodyless GET; the rest are POSTs.
   */
  private async handleTelemetryBraintrust(request: Request): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;
    if (!this.checkTelemetryRateLimit(auth.sessionId)) {
      return jsonErrorResponse("Telemetry rate limit exceeded", 429);
    }

    const rawSubpath = (request.headers.get("x-telemetry-subpath") || "").replace(/^\/+/, "");
    const upstreamRoute = SessionDOBase.BRAINTRUST_UPSTREAM_BY_SUBPATH[rawSubpath];
    if (!upstreamRoute) {
      return jsonErrorResponse("Forbidden telemetry subpath", 403);
    }

    const telemetryBody = await this.readTelemetryBody(request);
    if (!telemetryBody.ok) return telemetryBody.response;
    const { body } = telemetryBody;

    const env = this.env as Env;
    if (!env.BRAINTRUST_API_KEY) {
      this.log.debug(
        { event: "telemetry_braintrust_noop", sessionId: auth.sessionId },
        "No BRAINTRUST_API_KEY; dropping braintrust telemetry",
      );
      return new Response(null, { status: 204 });
    }

    // The version probe is a bodyless GET; the login/register/logs3 calls are
    // POSTs that forward the SDK's body and content headers.
    const isGet = upstreamRoute.method === "GET";
    const braintrustContentEncoding = request.headers.get("content-encoding");
    let upstream: Response;
    try {
      upstream = await tracedFetch(upstreamRoute.url, {
        method: upstreamRoute.method,
        headers: {
          // Override any client-sent auth with the platform key.
          [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${env.BRAINTRUST_API_KEY}`,
          ...(isGet
            ? {}
            : {
                [HTTP_HEADER_NAMES.CONTENT_TYPE]:
                  request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
                ...(braintrustContentEncoding ? { "Content-Encoding": braintrustContentEncoding } : {}),
              }),
        },
        ...(isGet ? {} : { body }),
      });
    } catch (err) {
      // Network failure (DNS/TLS/connection) rethrows before any Response
      // exists. Log without the platform key or body, and return a deliberate
      // 502 so the failure is structured instead of an opaque handler throw.
      this.log.warn(
        {
          event: "telemetry_braintrust_upstream_error",
          sessionId: auth.sessionId,
          subpath: rawSubpath,
          error: serializeError(err),
        },
        "Braintrust upstream request failed",
      );
      return jsonErrorResponse("Braintrust upstream request failed", 502);
    }
    if (!upstream.ok) {
      // Surface non-2xx upstream responses; this is the signal that silently
      // rotted before (e.g. a missing allowlist entry 403/404ing). Log status
      // only -- never the Authorization header, platform key, or body.
      this.log.warn(
        {
          event: "telemetry_braintrust_upstream_error",
          sessionId: auth.sessionId,
          subpath: rawSubpath,
          status: upstream.status,
        },
        "Braintrust upstream returned non-2xx",
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        [HTTP_HEADER_NAMES.CONTENT_TYPE]: upstream.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
      },
    });
  }

  /**
   * Sentry broker. Reads the raw envelope, rewrites its header `dsn` (the
   * sandbox SDK embeds a non-secret placeholder) to the platform SENTRY_DSN,
   * and forwards it to the DSN-derived ingest URL with the DSN public key in
   * the X-Sentry-Auth header. Returns 204 when no DSN is configured.
   * Fire-and-forget.
   */
  private async handleTelemetrySentry(request: Request): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;
    if (!this.checkTelemetryRateLimit(auth.sessionId)) {
      return jsonErrorResponse("Telemetry rate limit exceeded", 429);
    }

    const contentEncoding = request.headers.get("content-encoding");
    const telemetryBody = await this.readTelemetryBody(request);
    if (!telemetryBody.ok) return telemetryBody.response;
    const { body } = telemetryBody;

    const env = this.env as Env;
    if (!env.SENTRY_DSN) {
      this.log.debug({ event: "telemetry_sentry_noop", sessionId: auth.sessionId }, "No SENTRY_DSN; dropping envelope");
      return new Response(null, { status: 204 });
    }
    // Central prod-only enforcement: an older QA/non-prod sandbox can keep
    // tunneling across a control-plane deploy even after the bridge-side gate
    // ships, so fail closed here on the same WORKER_ENV allowlist the worker
    // uses for its own events.
    if (!shouldReportToSentry(env)) {
      this.log.debug(
        { event: "telemetry_sentry_non_prod_dropped", sessionId: auth.sessionId, workerEnv: env.WORKER_ENV },
        "Non-production environment; dropping Sentry envelope",
      );
      return new Response(null, { status: 204 });
    }

    let publicKey: string;
    let host: string;
    let projectId: string;
    try {
      const dsn = new URL(env.SENTRY_DSN);
      publicKey = dsn.username;
      host = dsn.host;
      projectId = dsn.pathname.replace(/^\/+/, "");
      if (!publicKey || !host || !projectId) throw new Error("incomplete DSN");
    } catch (err) {
      this.log.warn(
        { event: "telemetry_sentry_bad_dsn", sessionId: auth.sessionId, error: serializeError(err) },
        "Invalid SENTRY_DSN; dropping envelope",
      );
      return new Response(null, { status: 204 });
    }

    const ingestUrl = `https://${host}/api/${projectId}/envelope/`;

    // Rewrite the envelope header's placeholder dsn to the real DSN so the
    // forwarded request is the standard tunnel shape (gunzip first when the
    // SDK compressed the envelope; the rewrite forwards uncompressed). On any
    // decompress/parse failure, forward the original body unchanged.
    let forwardBody: Uint8Array<ArrayBuffer> = body;
    let forwardEncoding = contentEncoding;
    try {
      const raw = contentEncoding === "gzip" ? await gunzipCapped(body, SessionDOBase.TELEMETRY_MAX_BODY_BYTES) : body;
      forwardBody = rewriteSentryEnvelopeDsn(raw, env.SENTRY_DSN);
      forwardEncoding = null;
    } catch (err) {
      this.log.warn(
        { event: "telemetry_sentry_rewrite_failed", sessionId: auth.sessionId, error: serializeError(err) },
        "Failed to rewrite Sentry envelope DSN; forwarding original envelope",
      );
    }

    this.ctx.waitUntil(
      tracedFetch(ingestUrl, {
        method: "POST",
        headers: {
          "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
          "Content-Type": "application/x-sentry-envelope",
          ...(forwardEncoding ? { "Content-Encoding": forwardEncoding } : {}),
        },
        body: forwardBody,
      }).catch((err) => {
        this.log.warn(
          { event: "telemetry_sentry_forward_failed", sessionId: auth.sessionId, error: serializeError(err) },
          "Failed to forward Sentry envelope",
        );
      }),
    );
    return new Response(null, { status: 202 });
  }

  private async validateSandboxAuthRequest(request: Request): Promise<
    | {
        ok: true;
        sessionId: string;
        sandbox: doDb.SandboxStateRow;
      }
    | {
        ok: false;
        response: Response;
      }
  > {
    const sid = this.resolveSessionId();
    // The Sentry SDK tunnel sends no Authorization header; the bridge appends
    // `?st=<SANDBOX_AUTH_TOKEN>` to the tunnel URL. Fall back to that query
    // param ONLY on the Sentry tunnel path — every other sandbox route must
    // keep the token out of URLs (query strings can end up in request logs).
    // All hash/grace/replay logic below is unchanged.
    const requestUrl = new URL(request.url);
    const queryToken =
      requestUrl.pathname === SESSION_INTERNAL_ROUTES.telemetrySentry.path ? requestUrl.searchParams.get("st") : null;
    const bearerToken = parseBearerToken(request) || queryToken;
    if (!bearerToken) {
      const response = await this.recordSandboxAuthFailure(request, sid, "missing_token");
      if (response) return { ok: false, response };
      return { ok: false, response: jsonErrorResponse("Missing sandbox auth token", 401) };
    }
    const sandbox = sid ? doDb.getSandboxState(this.sql, sid) : null;
    const storedHash = sandbox?.sandboxAuthTokenHash ?? undefined;
    if (!sid || !sandbox || !storedHash) {
      this.logSandboxAuthFailure(request, sid, "no_sandbox_auth_configured");
      return { ok: false, response: jsonErrorResponse("No sandbox auth configured", 403) };
    }
    const tokenHash = await computeSha256Hex(bearerToken);
    // (1) Current token: the happy path.
    if (timingSafeEqualString(tokenHash, storedHash)) {
      return { ok: true, sessionId: sid, sandbox };
    }

    const sandboxId = request.headers.get("x-sandbox-id") || new URL(request.url).searchParams.get("sandboxId");

    // (2) Grace-overlap previous tokens. A transport reconnect rotates the live
    // hash and the WS-upgrade path marks the presented token consumed, so a prior
    // token is BY CONSTRUCTION a consumed token. A bridge that reconnected but
    // never adopted the new token (zombie / dropped transport) still holds it and
    // must keep authenticating its in-flight REST work through the first liveness
    // observation (~60s). A storm can roll the token several
    // times before the bridge catches up, so we accept any of the last N prior
    // generations within its window REGARDLESS of the consumed marker — the
    // one-time-exchange consume check on the upgrade path still independently blocks
    // opening a second socket with it. Checked before the replay rejection precisely
    // because prev is expected to be consumed.
    const now = Date.now();
    const validPriorGenerations = selectValidAuthTokenGenerations(
      parseAuthTokenGenerations(sandbox.prevSandboxAuthTokenHashes),
      now,
    );
    for (const generation of validPriorGenerations) {
      if (timingSafeEqualString(tokenHash, generation.hash)) {
        this.log.info(
          {
            event: "sandbox_auth_prev_token_grace",
            sessionId: sid,
            sandboxId: sandboxId ?? sandbox.sandboxId ?? null,
            msUntilExpiry: generation.expiresAt - now,
            priorGenerationsValid: validPriorGenerations.length,
          },
          "Accepted sandbox auth via grace-overlap previous token",
        );
        return { ok: true, sessionId: sid, sandbox };
      }
    }

    // (3) A consumed one-time token that is NOT the current prev is a replay.
    if (sid && sandboxId) {
      const consumedRecord = await this.state.storage.get<SandboxOneTimeAuthRecord>(
        sandboxOneTimeAuthStorageKey(sid, sandboxId, tokenHash),
      );
      if (consumedRecord !== undefined) {
        if (shouldAllowUnconfirmedSandboxAuthReplay(consumedRecord, Boolean(this.getSandboxSocket()))) {
          return { ok: true, sessionId: sid, sandbox };
        }
        const response = await this.recordSandboxAuthFailure(request, sid, "token_replay");
        if (response) return { ok: false, response };
        return { ok: false, response: jsonErrorResponse("Sandbox auth token already exchanged", 403) };
      }
    }

    // (4) Fail closed.
    const response = await this.recordSandboxAuthFailure(request, sid, "invalid_token");
    if (response) return { ok: false, response };
    return { ok: false, response: jsonErrorResponse("Invalid sandbox auth token", 403) };
  }

  private requireActiveSandboxTokenMintingTarget(
    auth: { sessionId: string; sandbox: doDb.SandboxStateRow },
    session?: SessionState | null,
  ): { ok: true; session: SessionState } | { ok: false; response: Response } {
    const resolvedSession = session ?? doDb.getSession(this.sql, auth.sessionId);
    if (!resolvedSession || resolvedSession.status !== "active") {
      this.logSandboxTokenMintingRejection(auth, resolvedSession);
      return {
        ok: false,
        response: jsonErrorResponse("Sandbox not active", 403, { code: SANDBOX_NOT_ACTIVE_ERROR_CODE }),
      };
    }
    if (auth.sandbox.status !== "ready" && auth.sandbox.status !== "reconnecting") {
      this.logSandboxTokenMintingRejection(auth, resolvedSession);
      return {
        ok: false,
        response: jsonErrorResponse("Sandbox not active", 403, { code: SANDBOX_NOT_ACTIVE_ERROR_CODE }),
      };
    }
    return { ok: true, session: resolvedSession };
  }

  private requireSandboxCliAuthMintingTarget(
    auth: { sessionId: string; sandbox: doDb.SandboxStateRow },
    session?: SessionState | null,
  ): { ok: true; session: SessionState } | { ok: false; response: Response } {
    const resolvedSession = session ?? doDb.getSession(this.sql, auth.sessionId);
    if (!resolvedSession || resolvedSession.status !== "active") {
      this.logSandboxTokenMintingRejection(auth, resolvedSession);
      return {
        ok: false,
        response: jsonErrorResponse("Sandbox not active", 403, { code: SANDBOX_NOT_ACTIVE_ERROR_CODE }),
      };
    }
    if (
      auth.sandbox.status !== "spawning" &&
      auth.sandbox.status !== "ready" &&
      auth.sandbox.status !== "reconnecting"
    ) {
      this.logSandboxTokenMintingRejection(auth, resolvedSession);
      return {
        ok: false,
        response: jsonErrorResponse("Sandbox not active", 403, { code: SANDBOX_NOT_ACTIVE_ERROR_CODE }),
      };
    }
    return { ok: true, session: resolvedSession };
  }

  /**
   * A correctly-authenticated sandbox asked for a token after the session
   * left `active` or the sandbox left ready/reconnecting — a lifecycle race
   * (e.g. user stopped the session while the bridge was still pushing), not
   * an auth failure. Logged so these 403s are visible server-side; kept
   * distinct from `sandbox_auth_failure`, which feeds the auth monitor.
   */
  private logSandboxTokenMintingRejection(
    auth: { sessionId: string; sandbox: doDb.SandboxStateRow },
    session: SessionState | null | undefined,
  ): void {
    this.log.warn(
      {
        event: "sandbox_token_mint_rejected_inactive",
        sessionId: auth.sessionId,
        sessionStatus: session?.status ?? null,
        sandboxStatus: auth.sandbox.status,
      },
      "Rejected sandbox token minting for inactive session or sandbox",
    );
  }

  private platformLlmFailureResponse(
    category: PlatformLlmFailureCategory,
    status: number,
    toolName: string,
    model?: string,
  ): Response {
    const body: PlatformLlmResponse<never> = {
      ok: false,
      category,
      attempts: 0,
      durationMs: 0,
      ...(model ? { model } : {}),
      toolName,
    };
    return jsonResponse(body, status);
  }

  private checkPlatformLlmRateLimit(now: number): boolean {
    const bucket = Math.floor(now / PLATFORM_LLM_RATE_LIMIT_WINDOW_MS);
    if (!this.platformLlmRateLimitBucket || this.platformLlmRateLimitBucket.bucket !== bucket) {
      this.platformLlmRateLimitBucket = { bucket, count: 0 };
    }
    if (this.platformLlmRateLimitBucket.count >= PLATFORM_LLM_SESSION_QPS) {
      return false;
    }
    this.platformLlmRateLimitBucket.count += 1;
    return true;
  }

  private async generatePlatformLlmCapabilityToken(): Promise<{ token: string; idHash: string }> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = encodeBase64UrlBytes(bytes);
    return { token, idHash: await computeSha256Hex(token) };
  }

  private markPlatformLlmPromptStatus(
    sessionId: string,
    promptId: string,
    status: doDb.PlatformLlmPromptStatus,
    now = Date.now(),
  ): doDb.CasPlatformLlmPromptStatusResult {
    // ARC-876: `startedAt` is the wall-clock instant the watchdog was armed
    // for `post_execution_pending`. For other statuses it is cleared. The
    // alarm handler CAS-checks this value to no-op if the slot has cleared.
    const startedAt = status === "post_execution_pending" ? now : null;
    // Allowed prior sets: each transition must monotonically advance. The
    // non-negotiable invariant is that terminal cannot be moved back to
    // executing/pending -- that is the alarm-incident bug class. For
    // non-executing targets we also allow inserting a fresh row, since some
    // prompt paths skip the executing mark
    // (attachPlatformLlmCapabilities is the canonical executing-mark site).
    const expectedPriorStatuses: doDb.PlatformLlmPromptStatus[] | "new" =
      status === "executing"
        ? "new"
        : status === "post_execution_pending"
          ? ["executing"]
          : ["executing", "post_execution_pending"];
    const result = doDb.casUpsertPlatformLlmPromptStatus(this.sql, {
      sessionId,
      promptId,
      status,
      updatedAt: now,
      startedAt,
      expectedPriorStatuses,
      allowNewRow: status !== "executing",
    });
    if (!result.accepted) {
      const payload = {
        event: "platform_llm_prompt_status_refused",
        sessionId,
        promptId,
        targetStatus: status,
        observedStatus: result.observedStatus,
        reason: result.reason,
      };
      this.log.info(payload, "platform_llm_prompt_status write refused (stale prior)");
      this.ctx.waitUntil(postStructuredEventToDd(this.env, payload));
      return result;
    }
    if (status === "terminal") {
      doDb.revokePromptCapabilities(this.sql, promptId, now, sessionId);
    }
    return result;
  }

  private async armPlatformLlmPostExecutionWindow(
    sessionId: string,
    promptId: string,
  ): Promise<"held" | "terminalize" | "already_terminal"> {
    const session = doDb.getSession(this.sql, sessionId);
    const prompt = doDb.getPrompt(this.sql, promptId);
    if (!session || !prompt || prompt.status !== "completed") {
      return "terminalize";
    }
    if (isPlanModePlanPrompt(session, prompt)) {
      return "terminalize";
    }

    const existing = doDb.getPlatformLlmPromptStatus(this.sql, promptId);
    if (existing?.status === "terminal") {
      return "already_terminal";
    }
    if (existing?.status === "post_execution_pending" && existing.startedAt !== null) {
      return "held";
    }

    const result = this.markPlatformLlmPromptStatus(sessionId, promptId, "post_execution_pending");
    if (result.accepted) {
      await this.persistAndBroadcastSessionStatus(sessionId, "post_execution");
      await this.rescheduleSessionAlarm();
      return "held";
    }
    if (result.observedStatus === "terminal") {
      return "already_terminal";
    }

    const payload = {
      event: "platform_llm_post_execution_window_arm_refused",
      sessionId,
      promptId,
      targetStatus: "post_execution_pending",
      observedStatus: result.observedStatus,
      reason: result.reason,
    };
    this.log.error(payload, "Failed to arm platform LLM post-execution window");
    this.ctx.waitUntil(postStructuredEventToDd(this.env, payload));
    return "terminalize";
  }

  private async attachPlatformLlmCapabilities(
    command: SandboxCommand,
    sessionId: string | null,
    sandboxId: string | null,
  ): Promise<SandboxCommand> {
    if (command.type !== "prompt" || !sessionId || !sandboxId) {
      return command;
    }

    const promptId = command.messageId;
    const now = Date.now();
    doDb.purgeExpiredCapabilities(this.sql, now);
    doDb.revokePromptCapabilities(this.sql, promptId, now, sessionId);
    const markResult = this.markPlatformLlmPromptStatus(sessionId, promptId, "executing", now);
    if (!markResult.accepted) {
      // The prompt has already advanced past executing (typically because a
      // late dispatch landed on an already-terminal row). Do not mint fresh
      // capabilities for an inactive prompt -- they would let the sandbox
      // make platform LLM calls against a prompt that is no longer running.
      return command;
    }

    const callTypes: PlatformLlmCallType[] = ["pr_template_fill"];
    const manifest: PlatformLlmCapabilityManifest = { capabilities: [] };
    for (const callType of callTypes) {
      const config = PLATFORM_LLM_CALL_CONFIG[callType];
      const { token, idHash } = await this.generatePlatformLlmCapabilityToken();
      doDb.insertPlatformLlmCapability(this.sql, {
        idHash,
        sessionId,
        sandboxId,
        promptId,
        callType,
        phase: config.phase,
        expiresAt: now + PLATFORM_LLM_CAPABILITY_TTL_MS,
        createdAt: now,
      });
      manifest.capabilities.push({
        callType,
        phase: config.phase,
        token,
        expiresAt: now + PLATFORM_LLM_CAPABILITY_TTL_MS,
      });
      this.log.info(
        {
          event: "platform_llm.capability_minted",
          sessionId,
          promptId,
          sandboxId,
          callType,
          phase: config.phase,
          idHashPrefix: idHash.slice(0, 8),
        },
        "Platform LLM capability minted",
      );
    }

    return { ...command, platformLlmCapabilities: manifest };
  }

  private async attachRepoMemories(command: SandboxCommand, sessionId: string | null): Promise<SandboxCommand> {
    if (command.type !== "prompt" || !sessionId || !this.env.DB) return command;
    const session = doDb.getSessionExtended(this.sql, sessionId);
    const repoOwner = session?.repoOwner?.trim();
    const repoName = session?.repoName?.trim();
    if (!repoOwner || !repoName) return command;
    // QA runtime memories are QA-session-only: the cache holds all active repo
    // memories, so filter per consumer at payload build.
    const visibleTo = (memories: RepoMemoryContext[]): RepoMemoryContext[] =>
      visibleRepoMemoriesForSession(memories, { qaSession: isQaTesterAgentRole(session?.agentRole) });
    const cacheKey = `${repoOwner}/${repoName}`;
    const now = Date.now();
    const cached = this.repoMemoriesCache.get(cacheKey);
    if (cached && now - cached.loadedAt < MEMORY_USAGE_STATS_CACHE_TTL_MS) {
      const visibleMemories = visibleTo(cached.memories);
      this.log.info(
        {
          event: "repo_memory_dispatch",
          source: "cache",
          sessionId,
          repoOwner,
          repoName,
          memoryCount: visibleMemories.length,
          memoryIds: visibleMemories.slice(0, 10).map((memory) => memory.id),
        },
        "D1 repo memories resolved for prompt dispatch",
      );
      await this.recordRepoMemoryDispatch(sessionId, command.messageId, "cache", repoOwner, repoName, visibleMemories);
      return visibleMemories.length > 0 ? { ...command, repoMemories: visibleMemories } : command;
    }
    try {
      const { listActiveRepoMemoriesForRepo } = await import("../memory/db.js");
      const memoryFiles = await listActiveRepoMemoriesForRepo(this.env.DB, repoOwner, repoName);
      const memories: RepoMemoryContext[] = memoryFiles.map((memory) => toRuntimeMemory(memory));
      this.repoMemoriesCache.set(cacheKey, { loadedAt: now, memories });
      const visibleMemories = visibleTo(memories);
      this.log.info(
        {
          event: "repo_memory_dispatch",
          source: "d1",
          sessionId,
          repoOwner,
          repoName,
          memoryCount: visibleMemories.length,
          memoryIds: visibleMemories.slice(0, 10).map((memory) => memory.id),
        },
        "D1 repo memories resolved for prompt dispatch",
      );
      await this.recordRepoMemoryDispatch(sessionId, command.messageId, "d1", repoOwner, repoName, visibleMemories);
      return visibleMemories.length > 0 ? { ...command, repoMemories: visibleMemories } : command;
    } catch (error) {
      this.log.warn(
        { error: serializeError(error), sessionId, repoOwner, repoName },
        "Failed to attach D1 repo memories",
      );
      return command;
    }
  }

  private maybeCaptureQaRuntimeLearnings(
    sessionId: string,
    event: Extract<SandboxEvent, { type: "verification_phase_artifact" }>,
  ): void {
    const phase = event.record.phase;
    if (phase !== "verification-launcher" && phase !== "verification-operator") return;
    const noteOutput = event.record.note?.output;
    if (!noteOutput || !this.env.DB) return;
    const target = event.record.artifact?.target;
    const targetPrUrl = target?.targetPrUrl ?? target?.prUrl ?? "";
    if (!targetPrUrl) return;
    const session = doDb.getSessionExtended(this.sql, sessionId);
    const repoOwner = session?.repoOwner?.trim();
    const repoName = session?.repoName?.trim();
    if (!repoOwner || !repoName) return;
    this.ctx.waitUntil(
      (async () => {
        try {
          const { captureQaRuntimeLearningsFromPhaseNote } = await import("../memory/qa-runtime.js");
          await captureQaRuntimeLearningsFromPhaseNote(this.env, {
            repoOwner,
            repoName,
            targetPrUrl,
            qaSessionId: sessionId,
            promptId: event.record.promptId,
            phase,
            noteOutput,
            log: this.log,
          });
        } catch (error) {
          this.log.warn({ error: serializeError(error), sessionId }, "QA runtime memory capture failed");
        }
      })(),
    );
  }

  private async recordRepoMemoryDispatch(
    sessionId: string,
    promptId: string,
    source: "cache" | "d1",
    repoOwner: string,
    repoName: string,
    memories: RepoMemoryContext[],
  ): Promise<void> {
    await this.appendAndBroadcastEvents(
      sessionId,
      [
        {
          type: "repo_memory_dispatch",
          timestamp: nowIso(),
          data: {
            promptId,
            source,
            repoOwner,
            repoName,
            memoryCount: memories.length,
            memoryIds: memories.slice(0, 10).map((memory) => memory.id),
          },
        },
      ],
      promptId,
    );
  }

  private async handlePlatformLlmCapabilityRequest(
    request: Request,
    requestedPhase: PlatformLlmPhase,
  ): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;

    const payload = (await parseJsonBody(request)) as Partial<ValidatePlatformLlmCapabilityRequest> | null;
    if (
      !payload ||
      !isPlatformLlmCallType(payload.callType) ||
      !isPlatformLlmPhase(payload.phase) ||
      payload.phase !== requestedPhase ||
      typeof payload.inputBytes !== "number" ||
      !Number.isFinite(payload.inputBytes) ||
      payload.inputBytes < 0
    ) {
      return jsonErrorResponse("Malformed platform LLM capability request", 400);
    }

    const config = PLATFORM_LLM_CALL_CONFIG[payload.callType];
    if (config.phase !== requestedPhase) {
      return jsonErrorResponse("Platform LLM call type is not allowed in this phase", 400);
    }
    if (payload.inputBytes > config.maxInputBytes) {
      return this.platformLlmFailureResponse("input_too_large", 413, config.toolName, config.model);
    }

    const sandboxId = auth.sandbox.sandboxId;
    if (!sandboxId) {
      return jsonErrorResponse("No sandbox id configured", 403);
    }

    const rawCapability = request.headers.get("x-platform-llm-capability")?.trim();
    if (!rawCapability) {
      return this.platformLlmFailureResponse("capability_invalid", 409, config.toolName, config.model);
    }

    const idHash = await computeSha256Hex(rawCapability);
    const existingCapability = doDb.getPlatformLlmCapability(this.sql, idHash);
    const now = Date.now();
    if (
      !existingCapability ||
      existingCapability.sessionId !== auth.sessionId ||
      existingCapability.sandboxId !== sandboxId
    ) {
      return this.platformLlmFailureResponse("capability_invalid", 409, config.toolName, config.model);
    }
    if (existingCapability.usedAt !== null) {
      return this.platformLlmFailureResponse("capability_consumed", 409, config.toolName, config.model);
    }
    if (existingCapability.expiresAt <= now) {
      return this.platformLlmFailureResponse("capability_expired", 409, config.toolName, config.model);
    }
    if (existingCapability.phase !== payload.phase) {
      return this.platformLlmFailureResponse("wrong_phase", 409, config.toolName, config.model);
    }
    if (existingCapability.callType !== payload.callType) {
      return this.platformLlmFailureResponse("wrong_call_type", 409, config.toolName, config.model);
    }
    if (!this.checkPlatformLlmRateLimit(now)) {
      return this.platformLlmFailureResponse("provider_error_retryable", 429, config.toolName, config.model);
    }

    const callType = payload.callType;
    const phase = payload.phase;
    const result = this.state.storage.transactionSync(() =>
      doDb.consumePlatformLlmCapability(this.sql, {
        idHash,
        sessionId: auth.sessionId,
        sandboxId,
        callType,
        phase,
        now,
        perPromptBudget: config.perPromptBudget,
      }),
    );

    if (!result.ok) {
      const status = result.category === "budget_exhausted" ? 429 : 409;
      this.log.info(
        {
          event: "platform_llm.capability_rejected",
          sessionId: auth.sessionId,
          sandboxId,
          callType: payload.callType,
          phase: payload.phase,
          idHashPrefix: idHash.slice(0, 8),
          reason: result.category,
        },
        "Platform LLM capability rejected",
      );
      return this.platformLlmFailureResponse(result.category, status, config.toolName, config.model);
    }

    this.log.info(
      {
        event: "platform_llm.capability_consumed",
        sessionId: auth.sessionId,
        promptId: result.record.promptId,
        sandboxId,
        callType: payload.callType,
        phase: payload.phase,
        idHashPrefix: idHash.slice(0, 8),
        budgetUsed: result.budgetUsed,
      },
      "Platform LLM capability consumed",
    );

    return jsonResponse({
      ok: true,
      plan: {
        sessionId: auth.sessionId,
        sandboxId,
        promptId: result.record.promptId,
        callType: payload.callType,
        phase: payload.phase,
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        serviceTier: config.serviceTier,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        toolName: config.toolName,
        maxOutputBytes: config.maxOutputBytes,
      },
    });
  }

  private async handleCompanyMemorySandboxRequest(request: Request): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;
    const active = this.requireActiveSandboxTokenMintingTarget(auth);
    if (!active.ok) return active.response;

    if (!this.env.DB) return jsonErrorResponse("Database not configured", 500);
    const scope = await getCompanyMemorySessionScope(this.env.DB, auth.sessionId);
    if (!scope) return jsonErrorResponse("Session not found", 404);

    return handleCompanyMemoryReasoningChainForSession(request, this.env as Env, this.env.DB, auth.sessionId, scope);
  }

  private async handleMemoryContextSandboxRequest(request: Request): Promise<Response> {
    const auth = await this.validateSandboxAuthRequest(request);
    if (!auth.ok) return auth.response;
    const active = this.requireActiveSandboxTokenMintingTarget(auth);
    if (!active.ok) return active.response;

    if (!this.env.DB) return jsonErrorResponse("Database not configured", 500);
    const scope = await getCompanyMemorySessionScope(this.env.DB, auth.sessionId);
    if (!scope) return jsonErrorResponse("Session not found", 404);
    return handleMemoryContextQueryForSession(request, this.env as Env, this.env.DB, auth.sessionId, scope, {
      metrics: { waitUntil: (promise) => this.ctx.waitUntil(promise) },
    });
  }

  private async resolveActorProfileCached(
    actorUserId: string | null | undefined,
    timing?: SessionViewReadTiming,
  ): Promise<PromptActorProfile | null> {
    const normalizedActorUserId = normalizePromptActorProfileUserId(actorUserId);
    if (!normalizedActorUserId) return null;
    const profiles = await this.resolveActorProfilesCached([normalizedActorUserId], timing);
    return profiles.get(normalizedActorUserId) ?? null;
  }

  private async resolveActorProfilesCached(
    actorUserIds: Iterable<string | null | undefined>,
    timing?: SessionViewReadTiming,
  ): Promise<Map<string, PromptActorProfile | null>> {
    const startedAt = Date.now();
    const normalizedActorUserIds = [
      ...new Set(
        [...actorUserIds]
          .map((actorUserId) => normalizePromptActorProfileUserId(actorUserId))
          .filter((actorUserId): actorUserId is string => actorUserId !== null),
      ),
    ];
    const actorProfiles = new Map<string, PromptActorProfile | null>();
    const uncachedActorUserIds: string[] = [];
    for (const actorUserId of normalizedActorUserIds) {
      if (this.actorProfileCache.has(actorUserId)) {
        actorProfiles.set(actorUserId, this.actorProfileCache.get(actorUserId) ?? null);
      } else {
        uncachedActorUserIds.push(actorUserId);
      }
    }
    if (timing) {
      timing.requestedCount = normalizedActorUserIds.length;
      timing.uncachedCount = uncachedActorUserIds.length;
    }
    if (uncachedActorUserIds.length === 0) {
      if (timing) {
        timing.durationMs = Date.now() - startedAt;
        timing.outcome = "success";
      }
      return actorProfiles;
    }

    try {
      const uncachedProfiles = await fetchActorProfilesByIds(this.env.DB, uncachedActorUserIds);
      if (timing) {
        timing.durationMs = Date.now() - startedAt;
        timing.outcome = "success";
      }
      for (const actorUserId of uncachedActorUserIds) {
        const profile = uncachedProfiles.get(actorUserId) ?? null;
        this.actorProfileCache.set(actorUserId, profile);
        actorProfiles.set(actorUserId, profile);
      }
    } catch (err) {
      if (timing) {
        timing.durationMs = Date.now() - startedAt;
        timing.outcome = "fallback";
        timing.errorClass = err instanceof Error ? err.name : typeof err;
      }
      this.log.warn(
        { actorUserIds: uncachedActorUserIds, error: serializeError(err) },
        "Session DO: failed to resolve actor profile",
      );
      for (const actorUserId of uncachedActorUserIds) {
        actorProfiles.set(actorUserId, null);
      }
    }
    return actorProfiles;
  }

  private async resolveOwnerProfileCached(ownerUserId: string): Promise<PromptActorProfile | null> {
    return this.resolveActorProfileCached(ownerUserId);
  }

  private async buildSessionDoResponse(
    sessionId: string,
    session: SessionState,
    sandbox: doDb.SandboxStateRow | null,
    ext: ReturnType<typeof doDb.getSessionExtended>,
    spineDoneTiming?: SessionViewReadTiming,
  ): Promise<SessionDOResponse> {
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const sandboxStatus = sandbox?.status ?? null;
    const stopReason = sandbox?.stopReason ?? null;
    const {
      activePromptHasPendingQuestion,
      planApprovalPending,
      planRevision,
      planStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
    } = getRichStatusProjectionInputs(this.sql, sessionId, activePromptId);
    const publishStatus = ext?.publishStatus ?? "not_started";
    const clientStatus = getSessionStatusForResponse(
      session,
      sandboxStatus ?? undefined,
      activePromptId,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      stopReason,
      activePromptHasPendingQuestion,
      planApprovalPending,
      ext?.reviewListeningActive ?? false,
      this.userStopped,
    );
    const phaseInfo = derivePhaseInfo(session, {
      sandboxStatus: sandboxStatus ?? undefined,
      activePromptId,
      stopReason,
      activePromptHasPendingQuestion,
      planApprovalPending,
      userStopped: this.userStopped,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      reviewListeningActive: ext?.reviewListeningActive ?? false,
    });
    const closeReason = this.getCloseReasonIfArchived(sessionId, clientStatus);
    const storageSnapshot = await this.state.storage.get([
      "verification",
      PR_READINESS_STORAGE_KEY,
      QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY,
      "runtime_provenance",
      "observability_readiness",
    ]);
    const storedVerification = (storageSnapshot.get("verification") as ExecutionVerification | undefined) ?? null;
    const prReadiness = (storageSnapshot.get(PR_READINESS_STORAGE_KEY) as PrReadinessEvidence | undefined) ?? null;
    const qaRunTerminalSummary = normalizeQaRunTerminalSummary(
      storageSnapshot.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY),
    );
    // Reconcile the stale stored snapshot against the authoritative columns before
    // surfacing it. See effective-verification.ts.
    const { verification, prDraft, prManualReviewReason } = deriveEffectiveVerification({
      stored: storedVerification,
      verificationState: ext?.verificationState ?? null,
      verificationResult: ext?.verificationResult ?? null,
      prDraft: ext?.prDraft ?? null,
      prManualReviewReason: ext?.prManualReviewReason ?? null,
    });
    const verificationSummary =
      verification || prReadiness ? buildVerificationSummary({ verification, readiness: prReadiness }) : null;
    const runtimeProvenance = normalizeRuntimeProvenance(
      storageSnapshot.get("runtime_provenance") as RuntimeProvenance | undefined,
    );
    const observabilityReadiness =
      (storageSnapshot.get("observability_readiness") as ObservabilityReadiness | undefined) ?? null;

    // ARC-1330 D-59c: the review-loop / cycloid-done aggregate is projected from the spine, not the
    // DO-SQLite copy (whose writer `recomputeCycloidDoneStatus` was deleted this slice).
    const [spineDone, prCoordination] = await Promise.all([
      resolveSpineDoneMirror((this.env as Env).DB, sessionId, spineDoneTiming),
      this.env.DB ? getPrCoordination(this.env.DB, sessionId).catch(() => null) : null,
    ]);

    return {
      ...session,
      ...phaseFieldsFromInfo(phaseInfo),
      // Live-idle "kept alive after a user stop" flag (in-memory; no D1 column).
      // Carried on the DO-served view payload so the HTTP session-view — which
      // the ~30s resilience poll and cold `bootstrapFromHttp` both fetch — no
      // longer clobbers the "Stopped — continue anytime" badge/hint back to
      // undefined. Same in-memory source as the WS snapshot/frame.
      userStopped: this.userStopped,
      planApprovalPending,
      planRevision,
      planStatus,
      sandboxStatus,
      // Mirror of the WS snapshot's `sandbox` block (buildClientSessionSnapshot)
      // so the view fetch resolves sandbox identity/connectedness the same way.
      sandboxId: sandbox?.sandboxId ?? null,
      sandboxConnected: Boolean(sandboxStatus === "ready" && this.getSandboxSocket()),
      sessionKind: "repo",
      repoOwner: ext?.repoOwner ?? null,
      repoName: ext?.repoName ?? null,
      repoUrl: ext?.repoOwner && ext?.repoName ? `https://github.com/${ext.repoOwner}/${ext.repoName}` : null,
      baseBranch: ext?.baseBranch ?? null,
      startBranch: ext?.startBranch ?? null,
      installationId: ext?.installationId ?? null,
      lastBranch: ext?.lastBranch ?? null,
      prUrl: ext?.prUrl ?? null,
      reviewListeningActive: ext?.reviewListeningActive ?? false,
      reviewListeningPrUrl: ext?.reviewListeningPrUrl ?? null,
      reviewListeningHeadSha: ext?.reviewListeningHeadSha ?? null,
      reviewListeningEnteredAt: ext?.reviewListeningEnteredAt ?? null,
      desktopActionPathAvailable: isCycloidMember({ businessId: session.businessId }),
      reviewLoopDoneState: spineDone.reviewLoopDoneState,
      uiLifecycleStage: spineDone.uiLifecycleStage,
      cycloidDoneState: spineDone.cycloidDone.state,
      cycloidDoneOutcome: spineDone.cycloidDone.outcome,
      cycloidDoneReasons: spineDone.cycloidDone.reasons,
      verificationState: ext?.verificationState ?? null,
      verificationResult: ext?.verificationResult ?? null,
      verificationNeedsWorkLabel: ext?.verificationNeedsWorkLabel ?? null,
      verificationAttemptCount: ext?.verificationAttemptCount ?? 0,
      verificationMaxAttempts: ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
      qaRunTerminalSummary,
      qaRun: buildQaRunView({
        state: ext?.verificationState ?? null,
        verdict: ext?.verificationResult ?? null,
        attemptCount: ext?.verificationAttemptCount ?? 0,
        maxAttempts: ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
        terminal: qaRunTerminalSummary,
        coordination: prCoordination,
      }),
      verificationRunBaseline: ext?.verificationRunBaseline ?? 0,
      verificationVerdictHeadSha: ext?.verificationVerdictHeadSha ?? null,
      prDraft,
      prManualReviewReason,
      publishStatus: ext?.publishStatus ?? "not_started",
      publishStage: ext?.publishStage ?? null,
      publishError: ext?.publishError ?? null,
      publishedBranch: ext?.publishedBranch ?? null,
      closeReason,
      spawnDurationMs: ext?.spawnDurationMs ?? null,
      verification,
      verificationSummary,
      runtimeProvenance,
      observabilityReadiness,
    };
  }

  private async buildPromptListPayload(
    sessionId: string,
    session: SessionState,
    activePromptId: string | null,
    actorProfileTiming?: SessionViewReadTiming,
  ): Promise<Pick<PromptListPayload, "prompts" | "queue">> {
    const startedAt = Date.now();
    const prompts = doDb.getPrompts(this.sql, sessionId);
    const clientPrompts = await this.buildClientPromptsWithActorProfiles(
      sessionId,
      prompts,
      session.model ?? null,
      session.reasoningEffort ?? null,
      actorProfileTiming,
    );
    const queue = getQueueState(prompts, activePromptId);

    try {
      JSON.stringify({ ok: true, prompts: clientPrompts, queue });
      this.log.info(
        {
          event: "session.do.prompt_list.metrics",
          sessionId,
          promptCount: prompts.length,
          clientPromptCount: clientPrompts.length,
          durationMs: Date.now() - startedAt,
        },
        "SessionDO prompt list metrics",
      );
      return { prompts: clientPrompts, queue };
    } catch (err) {
      this.log.error(
        { sessionId: session.sessionId, promptCount: prompts.length, error: serializeError(err) },
        "CRITICAL: JSON.stringify failed for prompts response",
      );
      Sentry.captureException(err, { tags: { operation: "getSessionPrompts", sessionId: session.sessionId } });
      const safePrompts = clientPrompts.map((p) => ({
        ...p,
        result: p.result != null ? "[stripped: serialization failed]" : null,
      }));
      return { prompts: safePrompts, queue };
    }
  }

  private async buildSessionViewPayload(
    sessionId: string,
    session: SessionState,
    options?: { promptCursor?: string | null; promptLimit?: number | null },
  ): Promise<SessionViewPayload> {
    const startedAt = Date.now();
    const metrics: SessionViewPayloadMetrics = {
      doBuildMs: 0,
      doPromptActorProfiles: { durationMs: 0, outcome: "success", requestedCount: 0, uncachedCount: 0 },
      doOwnerActorProfile: { durationMs: 0, outcome: "success", requestedCount: 0, uncachedCount: 0 },
      doSpineDoneMirror: { durationMs: 0, outcome: "success" },
    };
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    if (!options) {
      const promptPayload = await this.buildPromptListPayload(
        sessionId,
        session,
        activePromptId,
        metrics.doPromptActorProfiles,
      );
      const ownerProfile = await this.resolveActorProfileCached(session.ownerUserId, metrics.doOwnerActorProfile);
      const sessionResponse = await this.buildSessionDoResponse(
        sessionId,
        session,
        sandbox,
        ext,
        metrics.doSpineDoneMirror,
      );
      metrics.doBuildMs = Date.now() - startedAt;
      this.log.info(
        {
          event: "session.do.view_payload.metrics",
          sessionId,
          promptCount: promptPayload.prompts.length,
          promptActorProfilesMs: metrics.doPromptActorProfiles.durationMs,
          promptActorProfilesOutcome: metrics.doPromptActorProfiles.outcome,
          ownerActorProfileMs: metrics.doOwnerActorProfile.durationMs,
          ownerActorProfileOutcome: metrics.doOwnerActorProfile.outcome,
          spineDoneMirrorMs: metrics.doSpineDoneMirror.durationMs,
          spineDoneMirrorOutcome: metrics.doSpineDoneMirror.outcome,
          durationMs: Date.now() - startedAt,
        },
        "SessionDO view payload metrics",
      );

      return {
        ok: true,
        session: {
          ...sessionResponse,
          ...(ownerProfile?.login && { ownerLogin: ownerProfile.login }),
          ...(ownerProfile?.avatarUrl && { ownerAvatarUrl: ownerProfile.avatarUrl }),
        },
        prompts: promptPayload.prompts,
        queue: promptPayload.queue,
        metrics,
      };
    }

    const promptLimit = Math.max(1, Math.min(options?.promptLimit ?? 50, 100));
    const promptOffset = parsePromptPageCursor(options?.promptCursor);
    const totalPrompts = doDb.getPromptCount(this.sql, sessionId);
    const pagePrompts = doDb.getPromptPage(this.sql, sessionId, promptOffset, promptLimit);
    const latestCompletedPrompt = doDb.getLatestCompletedPrompt(this.sql, sessionId);
    const clientPrompts = await this.buildClientPromptsWithActorProfiles(
      sessionId,
      pagePrompts,
      session.model ?? null,
      session.reasoningEffort ?? null,
      metrics.doPromptActorProfiles,
    );
    const outcomePrompts = latestCompletedPrompt
      ? await this.buildClientPromptsWithActorProfiles(
          sessionId,
          [latestCompletedPrompt],
          session.model ?? null,
          session.reasoningEffort ?? null,
          metrics.doPromptActorProfiles,
        )
      : [];
    const nextPromptOffset = promptOffset + promptLimit;
    const queue = {
      queuedCount: doDb.getQueuedPromptCount(this.sql, sessionId),
      processingPromptId: activePromptId,
    };
    let safeClientPrompts = clientPrompts;

    try {
      JSON.stringify({ ok: true, prompts: clientPrompts, queue });
    } catch (err) {
      this.log.error(
        { sessionId: session.sessionId, promptCount: pagePrompts.length, error: serializeError(err) },
        "CRITICAL: JSON.stringify failed for session view prompts response",
      );
      Sentry.captureException(err, { tags: { operation: "getSessionView", sessionId: session.sessionId } });
      safeClientPrompts = clientPrompts.map((prompt) => ({
        ...prompt,
        result: prompt.result != null ? "[stripped: serialization failed]" : null,
      }));
    }

    // buildSessionDoResponse (used by /session/state as well) does not carry owner profile fields.
    const ownerProfile = await this.resolveActorProfileCached(session.ownerUserId, metrics.doOwnerActorProfile);
    const sessionResponse = await this.buildSessionDoResponse(
      sessionId,
      session,
      sandbox,
      ext,
      metrics.doSpineDoneMirror,
    );
    metrics.doBuildMs = Date.now() - startedAt;
    this.log.info(
      {
        event: "session.do.view_payload.metrics",
        sessionId,
        promptCount: safeClientPrompts.length,
        promptActorProfilesMs: metrics.doPromptActorProfiles.durationMs,
        promptActorProfilesOutcome: metrics.doPromptActorProfiles.outcome,
        ownerActorProfileMs: metrics.doOwnerActorProfile.durationMs,
        ownerActorProfileOutcome: metrics.doOwnerActorProfile.outcome,
        spineDoneMirrorMs: metrics.doSpineDoneMirror.durationMs,
        spineDoneMirrorOutcome: metrics.doSpineDoneMirror.outcome,
        durationMs: Date.now() - startedAt,
      },
      "SessionDO view payload metrics",
    );

    return {
      ok: true,
      session: {
        ...sessionResponse,
        ...(ownerProfile?.login && { ownerLogin: ownerProfile.login }),
        ...(ownerProfile?.avatarUrl && { ownerAvatarUrl: ownerProfile.avatarUrl }),
      },
      prompts: safeClientPrompts,
      outcomePrompts,
      promptPage: {
        nextCursor: nextPromptOffset < totalPrompts ? String(nextPromptOffset) : null,
        total: totalPrompts,
      },
      queue,
      metrics,
    };
  }
  private async buildClientSessionSnapshot(
    sessionId: string,
    viewerUserId: string,
  ): Promise<{
    session: ClientSessionSnapshot;
    sandbox: ClientSandboxState;
    prompts: ClientPrompt[];
    queue: ReturnType<typeof getQueueState>;
  }> {
    const session = doDb.getSession(this.sql, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found while building subscribe snapshot`);
    }
    const viewerIsOwner = viewerUserId === session.ownerUserId;

    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const prompts = doDb.getPrompts(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const sandboxStatus = sandbox?.status;
    const spawnDurationMs = ext?.spawnDurationMs ?? null;
    const [storageSnapshot, ownerProfile] = await Promise.all([
      this.state.storage.get([
        "verification",
        "runtime_provenance",
        "observability_readiness",
        QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY,
        PR_READINESS_STORAGE_KEY,
      ]),
      this.resolveOwnerProfileCached(session.ownerUserId),
    ]);
    const storedVerification = (storageSnapshot.get("verification") as ExecutionVerification | undefined) ?? null;
    const snapshotPrReadiness =
      (storageSnapshot.get(PR_READINESS_STORAGE_KEY) as PrReadinessEvidence | undefined) ?? null;
    const qaRunTerminalSummary = normalizeQaRunTerminalSummary(
      storageSnapshot.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY),
    );
    // Reconcile the stale stored snapshot against the authoritative columns before
    // surfacing it. See effective-verification.ts.
    const { verification, prDraft, prManualReviewReason } = deriveEffectiveVerification({
      stored: storedVerification,
      verificationState: ext?.verificationState ?? null,
      verificationResult: ext?.verificationResult ?? null,
      prDraft: ext?.prDraft ?? null,
      prManualReviewReason: ext?.prManualReviewReason ?? null,
    });
    const verificationSummary =
      verification || snapshotPrReadiness
        ? buildVerificationSummary({ verification, readiness: snapshotPrReadiness })
        : null;
    const runtimeProvenance = normalizeRuntimeProvenance(
      storageSnapshot.get("runtime_provenance") as RuntimeProvenance | undefined,
    );
    const observabilityReadiness =
      (storageSnapshot.get("observability_readiness") as ObservabilityReadiness | undefined) ?? null;
    const {
      activePromptHasPendingQuestion,
      planApprovalPending,
      planRevision,
      planStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
    } = getRichStatusProjectionInputs(this.sql, sessionId, activePromptId);
    const childContext =
      this.env.DB && session.businessId !== undefined
        ? await getChildContextForSession(this.env.DB, sessionId, session.businessId ?? null, ext?.prUrl ?? null).catch(
            (error: unknown) => {
              this.log.warn(
                { sessionId, error: serializeError(error) },
                "Failed to read child-session websocket metadata",
              );
              return { childRow: null, childIds: [], qaChildSessionId: null };
            },
          )
        : { childRow: null, childIds: [], qaChildSessionId: null };
    const parentMetadata =
      this.env.DB && childContext.childRow && childContext.childRow.business_id === (session.businessId ?? null)
        ? await getParentSessionRow(this.env.DB, childContext.childRow.parent_session_id)
            .then((parent) =>
              parent && parent.business_id === (session.businessId ?? null)
                ? {
                    parentSessionId: childContext.childRow!.parent_session_id,
                    parentPromptId: childContext.childRow!.parent_prompt_id,
                    spawnDepth: childContext.childRow!.spawn_depth,
                  }
                : null,
            )
            .catch((error: unknown) => {
              this.log.warn({ sessionId, error: serializeError(error) }, "Failed to read parent websocket metadata");
              return null;
            })
        : null;
    const snapshotPublishStatus = ext?.publishStatus ?? "not_started";
    const clientStatus = getSessionStatusForResponse(
      session,
      sandboxStatus,
      activePromptId,
      snapshotPublishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      ext?.reviewListeningActive ?? false,
      this.userStopped,
    );
    const snapshotPhaseInfo = derivePhaseInfo(session, {
      sandboxStatus,
      activePromptId,
      stopReason: sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      userStopped: this.userStopped,
      publishStatus: snapshotPublishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      reviewListeningActive: ext?.reviewListeningActive ?? false,
    });
    const closeReason = this.getCloseReasonIfArchived(sessionId, clientStatus);
    // ARC-1330 D-59c: project the review-loop / cycloid-done aggregate from the spine (the DO-SQLite
    // writer `recomputeCycloidDoneStatus` was deleted this slice; `project()` is the sole mirror writer).
    const spineDone = await resolveSpineDoneMirror((this.env as Env).DB, sessionId);
    const prCoordination = this.env.DB ? await getPrCoordination(this.env.DB, sessionId).catch(() => null) : null;

    return {
      session: {
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        ...(ownerProfile?.login ? { ownerLogin: ownerProfile.login } : {}),
        ...(ownerProfile?.avatarUrl ? { ownerAvatarUrl: ownerProfile.avatarUrl } : {}),
        ...(parentMetadata
          ? {
              parentSessionId: parentMetadata.parentSessionId,
              parentPromptId: parentMetadata.parentPromptId,
              spawnDepth: parentMetadata.spawnDepth,
            }
          : {}),
        ...(childContext.childIds.length > 0 ? { childSessionIds: childContext.childIds } : {}),
        ...(childContext.qaChildSessionId ? { qaChildSessionId: childContext.qaChildSessionId } : {}),
        ...phaseFieldsFromInfo(snapshotPhaseInfo),
        // Live-idle "kept alive after a user stop" flag. In-memory + durable via
        // STOPPED_KEPT_ALIVE_AT_STORAGE_KEY (rehydrated on DO restart). Carried on
        // the bootstrap snapshot so the detail-view "Stopped — continue anytime"
        // badge/composer hint survives a reload/reconnect, not just the live frame.
        userStopped: this.userStopped,
        planApprovalPending,
        planRevision,
        planStatus,
        ...(viewerIsOwner ? { planAutoReason: session.planAutoReason ?? null } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        lastEventId: session.lastEventId,
        title: session.title,
        model: session.model ?? null,
        desktopActionPathAvailable: isCycloidMember({ businessId: session.businessId }),
        reasoningEffort: session.reasoningEffort ?? null,
        repoOwner: ext?.repoOwner ?? null,
        repoName: ext?.repoName ?? null,
        repoUrl: ext?.repoOwner && ext?.repoName ? `https://github.com/${ext.repoOwner}/${ext.repoName}` : null,
        baseBranch: ext?.baseBranch ?? null,
        lastBranch: ext?.lastBranch ?? null,
        prUrl: ext?.prUrl ?? null,
        prDraft,
        prManualReviewReason,
        publishStatus: ext?.publishStatus ?? "not_started",
        publishError: ext?.publishError ?? null,
        publishedBranch: ext?.publishedBranch ?? null,
        closeReason,
        spawnDurationMs,
        verification,
        verificationSummary,
        runtimeProvenance,
        observabilityReadiness,
        initiationMode: session.initiationMode ?? "user",
        entrypoint: session.entrypoint ?? null,
        scheduledRuleId: session.scheduledRuleId ?? null,
        ruleNameSnapshot: session.ruleNameSnapshot ?? null,
        cronSnapshot: session.cronSnapshot ?? null,
        reviewLoopDoneState: spineDone.reviewLoopDoneState,
        uiLifecycleStage: spineDone.uiLifecycleStage,
        cycloidDoneState: spineDone.cycloidDone.state,
        cycloidDoneOutcome: spineDone.cycloidDone.outcome,
        cycloidDoneReasons: spineDone.cycloidDone.reasons,
        verificationState: ext?.verificationState ?? null,
        verificationResult: ext?.verificationResult ?? null,
        verificationNeedsWorkLabel: ext?.verificationNeedsWorkLabel ?? null,
        verificationAttemptCount: ext?.verificationAttemptCount ?? 0,
        verificationMaxAttempts: ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
        qaRun: buildQaRunView({
          state: ext?.verificationState ?? null,
          verdict: ext?.verificationResult ?? null,
          attemptCount: ext?.verificationAttemptCount ?? 0,
          maxAttempts: ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR,
          terminal: qaRunTerminalSummary,
          coordination: prCoordination,
        }),
      },
      sandbox: {
        status: sandboxStatus ?? null,
        sandboxId: sandbox?.sandboxId ?? null,
        connected: Boolean(sandboxStatus === "ready" && this.getSandboxSocket()),
        spawnDurationMs,
        bridgeProtocolVersion: sandbox?.bridgeProtocolVersion ?? null,
      },
      prompts: await this.buildClientPromptsWithActorProfiles(
        sessionId,
        prompts,
        session.model ?? null,
        session.reasoningEffort ?? null,
      ),
      queue: getQueueState(prompts, activePromptId),
    };
  }

  private async buildClientSubscription(
    sessionId: string,
    userId: string,
    afterSequenceRaw: unknown,
  ): Promise<{ message: ServerMessage }> {
    const startedAt = Date.now();
    const initialAfterSequence = normalizeEventSequence(afterSequenceRaw, 0);
    const initialReplayWindow = doDb.getReplayWindowEvents(
      this.sql,
      sessionId,
      initialAfterSequence,
      REPLAY_WINDOW_SIZE,
    );
    const snapshot = await this.buildClientSessionSnapshot(sessionId, userId);
    const replay = this.buildClientReplayPage(initialAfterSequence, initialReplayWindow);
    const lastDurableSequence = doDb.getLastEventSequence(this.sql, sessionId);
    this.log.info(
      {
        event: "session.ws.subscribed_bootstrap.metrics",
        sessionId,
        promptCount: snapshot.prompts.length,
        replayEventCount: replay.events.length,
        replayTruncated: replay.hasMore,
        replayDroppedCount: replay.droppedCount,
        lastDurableSequence,
        durationMs: Date.now() - startedAt,
      },
      "SessionDO subscribed bootstrap metrics",
    );
    return {
      message: {
        type: "subscribed",
        version: 2,
        session: snapshot.session,
        sandbox: snapshot.sandbox,
        queue: snapshot.queue,
        prompts: snapshot.prompts,
        lastDurableSequence,
        replay,
      } satisfies ServerMessage,
    };
  }

  private buildClientReplayPage(
    afterSequence: number,
    replayWindow: { events: ClientReplayPage["events"]; truncated: boolean; droppedCount: number },
    options?: { beforeSequence?: number | null },
  ): ClientReplayPage {
    const firstEvent = replayWindow.events[0];
    const lastEvent = replayWindow.events[replayWindow.events.length - 1];
    return {
      afterSequence,
      beforeSequence: options?.beforeSequence ?? null,
      events: replayWindow.events,
      hasMore: replayWindow.truncated,
      droppedCount: replayWindow.droppedCount,
      firstSequence: firstEvent?.sequence ?? null,
      lastSequence: lastEvent?.sequence ?? null,
    };
  }

  private sendReplayPageMessage(ws: WebSocket, page: ClientReplayPage): void {
    ws.send(JSON.stringify({ type: "replay_page", ...page } satisfies ServerMessage));
  }

  private buildReplayPageAfterSequence(
    sessionId: string,
    afterSequenceRaw: unknown,
    limitRaw: unknown,
    maxLimit = REPLAY_PAGE_SIZE,
  ): ClientReplayPage {
    const afterSequence = normalizeEventSequence(afterSequenceRaw, 0);
    const limit = Math.min(Math.max(parseNonNegativeInteger(limitRaw, REPLAY_PAGE_SIZE), 1), maxLimit);
    const replayWindow = doDb.getReplayWindowEvents(this.sql, sessionId, afterSequence, limit);
    return this.buildClientReplayPage(afterSequence, replayWindow);
  }

  private buildAckEventId(sessionId: string, ackId: string): string {
    return `ack:${sessionId}:${ackId}`;
  }

  private sendSandboxAck(ackId: string | null): void {
    if (!ackId) return;
    const sandboxSocket = this.getSandboxSocket();
    if (!sandboxSocket) return;
    const ack: SandboxAckMessage = { type: "ack", ackId };
    try {
      sandboxSocket.send(JSON.stringify(ack));
    } catch (err) {
      this.log.warn({ ackId, error: serializeError(err) }, "Failed to send sandbox ACK");
    }
  }

  private async setHasPendingQuestion(value: boolean): Promise<void> {
    // Question state is tracked on the active prompt row. The real set path is
    // deliberately not routed through here; the question handler broadcasts only
    // after the question event is durable and replay-visible.
    const sid = this.resolveSessionId();
    if (!sid) return;
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sid);
    if (!activePromptId) return;
    const hadPendingQuestion = doDb.getPromptHasPendingQuestion(this.sql, activePromptId);
    doDb.updatePrompt(this.sql, activePromptId, { hasPendingQuestion: value });
    if (!hadPendingQuestion || value) return;
    // Question event durability already happened upstream (the question
    // handler appendAndBroadcastEvents'd before flipping the flag), so by the
    // time we get here the (1) question-event-durable → (2) rich_status
    // projection durable → (3) broadcast ordering is preserved.
    // Propagate-on-rejection: the caller (prompt completion / failure /
    // dispatch handler) owns the response.
    await this.persistAndBroadcastSessionStatus(sid, "pending_question_cleared");
  }

  private async setPendingPromptDispatch(value: boolean): Promise<void> {
    const sid = this.resolveSessionId();
    if (sid) doDb.updateSandboxState(this.sql, sid, { pendingPromptDispatch: value });
  }

  private async getReplayState(sessionId: string): Promise<ReplayState> {
    return doDb.getReplayState(this.sql, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Durable storage write helpers (try/catch + logging + Sentry)
  // ---------------------------------------------------------------------------

  /** Wrap a critical storage.put with structured error logging and Sentry alerting. Re-throws. */
  private async durableWrite(
    operation: string,
    entries: Record<string, unknown> | [string, unknown],
    sessionId?: string,
  ): Promise<void> {
    const isTuple = Array.isArray(entries);
    const keys = isTuple ? [entries[0] as string] : Object.keys(entries);
    try {
      if (isTuple) {
        await this.state.storage.put(entries[0] as string, entries[1]);
      } else {
        await this.state.storage.put(entries);
      }
    } catch (err) {
      const sid = sessionId ?? "unknown";
      this.log.error({ sessionId: sid, operation, keys, error: serializeError(err) }, "DO storage write failed");
      Sentry.captureException(err, {
        tags: { operation: `durableWrite.${operation}`, sessionId: sid },
        extra: { keys },
      });
      throw err;
    }
  }

  /**
   * Swallow-style fail-closed wrapper for lifecycle persistence calls whose
   * caller class must continue cleanup/loop iteration even when the D1
   * projection write rejects (see apps/control-plane-worker/README.md
   * "Projection write ownership"). The local DO SQLite write that drove the transition is
   * already durable; this helper records the rejection through the existing
   * Sentry-tagged projection observability surface and skips the broadcast.
   *
   * Callers whose contract is "propagate" (prompt start, sandbox status,
   * pending-question flip) must `await` the helper directly and let the
   * rejection reach the route/message handler.
   */
  private async swallowLifecyclePersistence<T>(
    sessionId: string,
    cause: PhaseTransitionCause,
    work: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await work();
    } catch (err) {
      this.log.warn(
        {
          event: "session_status.persist_broadcast_failed",
          sessionId,
          cause,
          missingSessionIndexRow: err instanceof MissingSessionIndexRowError,
          error: serializeError(err),
        },
        "Lifecycle rich_status projection rejected; broadcast skipped",
      );
      this.ctx.waitUntil(
        runWithSentryTag(
          "session-rich-status-projection",
          async () => {
            throw err;
          },
          this.log,
        ),
      );
      return fallback;
    }
  }

  // Lifecycle-blocking D1 sync. Caller must `await`.
  //
  // Lifecycle phase transitions must persist `session_index.rich_status`
  // before broadcasting `session_status` — see apps/control-plane-worker/README.md
  // "Projection write ownership". `syncRichStatusProjection` throws
  // `MissingSessionIndexRowError` when the UPDATE affects zero rows so the
  // awaited broadcast path can fail closed instead of silently no-opping.
  private async persistRichStatusToD1(
    sessionId: string,
    richStatus: string,
    planApprovalPending: boolean,
    planStatus: SessionPlanStatus,
  ): Promise<void> {
    const db = (this.env as Env).DB;
    if (!db) return;
    await syncRichStatusProjection({
      db,
      sessionId,
      richStatus,
      // Dormant sessions (no plan row -> status 'none') must not change the
      // projection write at all: omit the column so the SQL matches the
      // pre-plan-gate statement. A plan row never returns to 'none', so once
      // one exists the column keeps projecting (1 pending / 0 resolved).
      planApprovalPending: planStatus === "none" ? undefined : planApprovalPending,
      logger: this.log,
      requestId: this.requestId,
      source: "durable-object.richStatus",
    });
  }

  private async setCurrentSessionVerificationStateForPr(input: {
    sessionId: string;
    prUrl: string;
    state: VerificationState | null;
    attemptCount?: number;
    maxAttempts?: number;
    installationId?: number | null;
    repoOwner?: string | null;
    repoName?: string | null;
  }): Promise<void> {
    const session = doDb.getSession(this.sql, input.sessionId);
    if (!session) return;
    const state = doDb.verificationStateOrNull(input.state);
    const attemptCount = normalizeVerificationAttemptCount(input.attemptCount);
    const maxAttempts = normalizeVerificationMaxAttempts(input.maxAttempts);
    const ext = doDb.getSessionExtended(this.sql, input.sessionId);
    const currentState = ext?.verificationState ?? null;
    const currentAttemptCount = ext?.verificationAttemptCount ?? 0;
    const currentMaxAttempts = ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR;
    const preserveCurrent = shouldPreserveVerificationState(currentState, state);
    const nextState = preserveCurrent ? currentState : state;
    const nextAttemptCount = preserveCurrent ? currentAttemptCount : attemptCount;
    const nextMaxAttempts = preserveCurrent ? currentMaxAttempts : maxAttempts;
    if (
      currentState !== nextState ||
      currentAttemptCount !== nextAttemptCount ||
      currentMaxAttempts !== nextMaxAttempts
    ) {
      doDb.updateSessionFields(this.sql, input.sessionId, {
        verificationState: nextState,
        verificationAttemptCount: nextAttemptCount,
        verificationMaxAttempts: nextMaxAttempts,
      });
      // ARC-1330 D-59c: the D1 `qa_testing_state` mirror is written exclusively by `project()` from the spine
      // (the blind `mirrorVerificationStateToIndex` was deleted). This path keeps the DO-SQLite copy (read by
      // the scheduler-suppression / effective-verification surfaces) and broadcasts the change.
      await this.broadcastSessionSnapshot(input.sessionId);

      // ARC-1330 D-59b: the canonical `labelsOf(record)` projection is the sole label writer
      // (fsm/label-projection.ts). Keying on this session's spine row keeps the write authoritative for
      // the full managed namespace, not just the verification axis.
      await syncFsmLabelsForPr(this.env, {
        prUrl: input.prUrl,
        sessionId: input.sessionId,
        installationId: input.installationId ?? null,
        repoOwner: input.repoOwner ?? null,
        repoName: input.repoName ?? null,
        logger: this.log,
      });
    }
  }

  private async persistSessionSnapshotFailure(sessionId: string, error: string): Promise<void> {
    doDb.updateSandboxState(this.sql, sessionId, {
      snapshotImageId: null,
      snapshotBranch: null,
      snapshotHeadSha: null,
      snapshotCreatedAt: null,
      snapshotCredentialEnvKeys: null,
      snapshotCredentialFingerprints: null,
      snapshotModalWorkspace: null,
      snapshotModalEnvironment: null,
      snapshotSandboxImageVersion: null,
      lastSnapshotError: error,
    });

    const db = (this.env as Env).DB;
    if (!db) return;
    await syncSessionProjection({
      db,
      reportEnv: this.env,
      sessionId,
      snapshotImageId: null,
      logger: this.log,
      requestId: this.requestId,
      source: "durable-object.snapshot.failure",
    });
  }

  private persistSessionSnapshotPreconditionFailure(sessionId: string, error: string): void {
    doDb.updateSandboxState(this.sql, sessionId, { lastSnapshotError: error });
  }

  private async storeCurrentSandboxCredentialEnvKeys(keys: string[]): Promise<void> {
    await this.state.storage.put(CURRENT_SANDBOX_CREDENTIAL_ENV_KEYS_STORAGE_KEY, [...keys]);
  }

  private async storeCurrentSandboxCredentialFingerprints(fingerprints: string[]): Promise<void> {
    await this.state.storage.put(CURRENT_SANDBOX_CREDENTIAL_FINGERPRINTS_STORAGE_KEY, [...fingerprints]);
  }

  private async invalidateSessionSnapshot(
    sessionId: string,
    reason: string,
    expectedSnapshotImageId?: string,
  ): Promise<void> {
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const snapshotImageId = sandbox?.snapshotImageId ?? null;
    if (!snapshotImageId) return;
    if (expectedSnapshotImageId && snapshotImageId !== expectedSnapshotImageId) return;

    doDb.clearSnapshotMetadata(this.sql, sessionId, expectedSnapshotImageId);
    doDb.updateSandboxState(this.sql, sessionId, { lastSnapshotError: reason });

    const db = (this.env as Env).DB;
    if (db) {
      await syncSessionProjection({
        db,
        reportEnv: this.env,
        sessionId,
        snapshotImageId: null,
        logger: this.log,
        requestId: this.requestId,
        source: "durable-object.snapshot.invalidate",
      });
    }

    this.log.info({ sessionId, snapshotImageId, reason }, "Invalidated session snapshot");
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          // This only bounds the await; the provider call may not accept an AbortSignal for cancellation.
          timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private readPersistedRuntimeBackend(sessionId: string): RuntimeBackend {
    const rows = this.sql.exec("SELECT runtime_backend FROM sandbox_state WHERE session_id = ?", sessionId).toArray();
    const raw = rows[0]?.runtime_backend;
    return parsePersistedRuntimeBackend(raw);
  }

  private readPersistedRuntimeBackendOrNull(sessionId: string): RuntimeBackend | null {
    const rows = this.sql.exec("SELECT runtime_backend FROM sandbox_state WHERE session_id = ?", sessionId).toArray();
    if (rows.length === 0) return null;
    return parsePersistedRuntimeBackendOrNull(rows[0]?.runtime_backend);
  }

  private async persistRuntimeBackendAffinity(sessionId: string, runtimeBackend: RuntimeBackend): Promise<void> {
    applyRuntimePatch({ sql: this.sql, sessionId, patch: { runtimeBackend } });
    if (this.env.DB) {
      await syncRuntimeBackendProjection(this.env, sessionId, runtimeBackend, { logger: this.log });
    }
  }

  /**
   * Provider value to CAS runtime-row clears/refreshes on. Prefer the provider
   * actually stored on the row: rows written before the derivation sweep can carry
   * "e2b" with a freestyle backend, and a derived-only CAS would zero-match and
   * strand them (D1 projection cleared, DO row left pointing at a dead VM).
   * Post-sweep rows always equal the derived value, so the fallback only fires
   * when the row is already gone.
   */
  private expectedProviderForRuntimeClear(sessionId: string, runtimeBackend: RuntimeBackend): SandboxRuntimeProvider {
    const observed = doDb.getSandboxState(this.sql, sessionId)?.runtimeProvider;
    return isKnownRuntimeProvider(observed) ? observed : providerForRuntimeBackend(runtimeBackend);
  }

  private async resolveRuntimeBackendAffinity(sessionId: string): Promise<RuntimeBackend> {
    // parsePersistedRuntimeBackend now only ever returns e2b_cloud (or throws on a
    // legacy self-hosted value), so there is no non-cloud persisted backend to honor.
    // A non-empty stored value just means affinity was already pinned; an empty one
    // means resolve it fresh.
    const rows = this.sql.exec("SELECT runtime_backend FROM sandbox_state WHERE session_id = ?", sessionId).toArray();
    const raw = rows[0]?.runtime_backend;
    if (raw !== null && raw !== undefined && raw !== "") {
      const persisted = parsePersistedRuntimeBackend(raw);
      await this.persistRuntimeBackendAffinity(sessionId, persisted);
      return persisted;
    }

    // New-session-only dogfood override: route this owner's new sessions to freestyle
    // when FREESTYLE_SANDBOX_BACKEND_OVERRIDE selects them. Pinned rows never reach
    // here, so live/resumed sessions are never re-routed. Fails closed to e2b_cloud.
    // Targeted read: sessionRowToState does not project repo_owner, so go to the
    // row directly for the two override subjects.
    const overrideSubjectRows = this.sql
      .exec("SELECT owner_user_id, repo_owner FROM session WHERE session_id = ?", sessionId)
      .toArray();
    const ownerUserId = (overrideSubjectRows[0]?.owner_user_id as string | undefined) ?? null;
    const repoOwner = (overrideSubjectRows[0]?.repo_owner as string | undefined) ?? null;
    const environment = normalizeEnvironment((this.env as Env).WORKER_ENV, ENVIRONMENT.Production);
    const override = resolveDogfoodFreestyleOverride(
      this.env.FREESTYLE_SANDBOX_BACKEND_OVERRIDE,
      ownerUserId,
      repoOwner,
      environment,
      () =>
        this.log.error(
          { event: "runtime_backend.freestyle_override_all_rejected", environment, sessionId },
          "FREESTYLE_SANDBOX_BACKEND_OVERRIDE='all' is only honored in local; ignoring override and keeping default e2b_cloud routing",
        ),
    );
    if (override) {
      this.log.info(
        { event: "runtime_backend.freestyle_dogfood_override", sessionId, ownerUserId, repoOwner },
        "Routing new session to freestyle via routing override",
      );
    }
    const resolved = override ?? resolveRuntimeBackendForRepoSession({});
    await this.persistRuntimeBackendAffinity(sessionId, resolved);
    return resolved;
  }

  /**
   * Build a runtime client for cleanup (terminate-only). Mirrors the prior worker
   * `buildCleanupClient`: no default template requirement, since cleanup never
   * spawns. Using `buildRuntimeClientConfig` here would impose a spawn-only
   * `E2B_SANDBOX_TEMPLATE` dependency on the cleanup path.
   */
  private buildCleanupClient(runtimeBackend: RuntimeBackend): SandboxProviderClient {
    // Freestyle terminate/offboarding must use the Freestyle credential; passing the
    // E2B key unconditionally would run cleanup against the wrong provider.
    if (runtimeBackend === FREESTYLE_RUNTIME_BACKEND) {
      return createSandboxProviderClient(runtimeBackend, {
        apiKey: this.env.FREESTYLE_API_KEY,
        logger: this.log,
      });
    }
    return createSandboxProviderClient(runtimeBackend, {
      apiKey: this.env.E2B_API_KEY,
      domain: this.env.E2B_DOMAIN,
      logger: this.log,
    });
  }

  private buildRuntimeClientConfig(runtimeBackend: RuntimeBackend): E2BRuntimeClientConfig {
    const env = this.env as Env;
    // Config guards throw E2BSandboxRuntimeError missing_config (not a plain Error):
    // isRetryableSpawnFailure only classifies coded runtime errors, so a plain Error
    // falls into the retryable default and burns spawn retries on a deterministic
    // env misconfiguration instead of failing the prompt immediately.
    const missingConfig = (message: string) =>
      new E2BSandboxRuntimeError(message, { code: "missing_config", requestSent: false });
    if (runtimeBackend === FREESTYLE_RUNTIME_BACKEND) {
      if (!env.FREESTYLE_API_KEY) throw missingConfig("FREESTYLE_API_KEY is not configured");
      const defaultSnapshotId = env.FREESTYLE_DEFAULT_SNAPSHOT_ID?.trim() || undefined;
      // Mirror the E2B_SANDBOX_TEMPLATE check: a missing snapshot id must fail the
      // spawn here, not cold-boot a bare Debian VM with no bridge bundle (ARC-1480).
      if (!defaultSnapshotId) throw missingConfig("FREESTYLE_DEFAULT_SNAPSHOT_ID is not configured");
      const idleRaw = Number(env.FREESTYLE_IDLE_TIMEOUT_SECONDS);
      const idleTimeoutSeconds = Number.isFinite(idleRaw) && idleRaw > 0 ? Math.floor(idleRaw) : undefined;
      return {
        runtimeBackend,
        client: createSandboxProviderClient(runtimeBackend, {
          apiKey: env.FREESTYLE_API_KEY,
          defaultSnapshotId,
          idleTimeoutSeconds,
          logger: this.log,
          // ARC-1512 / ARC-1566: inject the current Freestyle boot artifacts from R2
          // at session start. The binding is optional; absent it the client quietly
          // launches the baked bundle / start-bridge fallback copies.
          bridgeBundles: env.BRIDGE_BUNDLES,
          ddApiKey: env.DD_API_KEY,
          workerEnv: env.WORKER_ENV,
        }),
        defaultTemplate: defaultSnapshotId,
        maxRunning: null,
      };
    }
    if (!env.E2B_API_KEY) throw missingConfig("E2B_API_KEY is not configured");
    const defaultTemplate = resolveDefaultE2BSandboxTemplate(env);
    if (!defaultTemplate) throw missingConfig("E2B_SANDBOX_TEMPLATE is not configured");
    return {
      runtimeBackend,
      client: createSandboxProviderClient(runtimeBackend, {
        apiKey: env.E2B_API_KEY,
        domain: env.E2B_DOMAIN,
        defaultTemplate,
        logger: this.log,
      }),
      defaultTemplate,
      maxRunning: null,
    };
  }

  private async captureStopBoundarySnapshot(
    sessionId: string,
    reason: string,
  ): Promise<{ snapshotSaved: boolean; snapshotImageId: string | null; snapshotError: string | null }> {
    const env = this.env as Env;
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const pendingPromptDispatch = sandbox?.pendingPromptDispatch ?? false;
    if (activePromptId || pendingPromptDispatch) {
      const snapshotError = activePromptId
        ? `Cannot capture stop-boundary snapshot while prompt ${activePromptId} is active`
        : "Cannot capture stop-boundary snapshot while prompt dispatch is pending";
      this.persistSessionSnapshotPreconditionFailure(sessionId, snapshotError);
      return { snapshotSaved: false, snapshotImageId: null, snapshotError };
    }

    if (!sandbox || !isKnownRuntimeProvider(sandbox.runtimeProvider) || !sandbox.runtimeSandboxId) {
      return { snapshotSaved: false, snapshotImageId: null, snapshotError: null };
    }

    const runtimeSandboxId = sandbox.runtimeSandboxId;
    const start = Date.now();
    try {
      const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
      const runtimeConfig = this.buildRuntimeClientConfig(runtimeBackend);
      await this.withTimeout(
        runtimeConfig.client.pauseSandbox(runtimeSandboxId),
        STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS,
        `E2B pause timed out after ${STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS}ms`,
      );
      const nowMs = Date.now();
      const runtimeState = {
        runtimeProvider: providerForRuntimeBackend(runtimeBackend),
        runtimeBackend,
        runtimeState: "paused" as const,
        runtimeSandboxId,
        runtimeTemplateId: sandbox.runtimeTemplateId ?? runtimeConfig.defaultTemplate,
        runtimeStateExpiresAt: nowMs + getE2BRuntimeRetentionMs(env),
        runtimeLiveLeaseExpiresAt: null,
        runtimePreviewUrl: null,
        runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
        runtimeLastResumedAt: sandbox.runtimeLastResumedAt ?? null,
        runtimeLastPausedAt: nowMs,
        runtimeLastProviderRefreshedAt: sandbox.runtimeLastProviderRefreshedAt ?? null,
        runtimeProviderTtlExpiresAt: sandbox.runtimeProviderTtlExpiresAt ?? null,
      };
      applyRuntimePatch({
        sql: this.sql,
        sessionId,
        patch: {
          ...runtimeState,
          lastSnapshotError: null,
        },
      });
      if (env.DB) await syncRuntimeProjection(env, sessionId, runtimeState);

      this.log.info(
        {
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          reason,
          duration_ms: Date.now() - start,
        },
        "Paused E2B runtime at stop boundary",
      );

      return { snapshotSaved: false, snapshotImageId: null, snapshotError: null };
    } catch (err) {
      const snapshotError = String(err);
      await this.persistSessionSnapshotFailure(sessionId, snapshotError);
      this.log.error(
        {
          sessionId,
          runtimeSandboxId,
          reason,
          error: snapshotError,
          duration_ms: Date.now() - start,
        },
        "E2B stop-boundary pause failed",
      );
      return { snapshotSaved: false, snapshotImageId: null, snapshotError };
    }
  }

  private async closeSessionAtDurabilityBoundary(
    session: SessionState,
    reason: string,
    closeMetadata?: Record<string, unknown>,
  ): Promise<ReplayState> {
    await this.putSandboxStatus(session.sessionId, "stopping", { cause: "archive" });

    // Finalize any still-processing prompt BEFORE the snapshot attempt and
    // before flipping session.status to "archived". Without this, the
    // partial unique index `idx_prompts_one_processing` (schema.ts) would
    // reject any subsequent enqueue, the snapshot capture would refuse to
    // run with an active prompt, and the max-duration alarm would later
    // fire on an archived session and write a spurious failure.
    const preArchiveActivePromptId = doDb.getActiveProcessingPromptId(this.sql, session.sessionId);
    if (preArchiveActivePromptId) {
      await this.promptQueue.failActivePromptForArchive(session, preArchiveActivePromptId, reason);
    }

    // ARC-876: a session closed while still `publishing` must not leave a dangling
    // non-terminal publish row (the wedge this fix targets). Terminalize it BEFORE
    // the snapshot + `session_closed` append so the publish terminal event ordering
    // precedes the close marker. This does NOT re-drive a publish (the user is
    // closing the session): `published` only if a PR already exists, else `failed`.
    await this.prWorkflow.terminalizeDanglingPublishOnClose(session.sessionId, reason);

    const snapshotOutcome = await this.captureStopBoundarySnapshot(session.sessionId, reason);

    const timestamp = nowIso();
    session.status = "archived";
    session.closedAt = timestamp;
    session.updatedAt = timestamp;

    const closeData: Record<string, unknown> = {
      sessionId: session.sessionId,
      status: session.status,
      reason,
      snapshotSaved: snapshotOutcome.snapshotSaved,
    };
    if (snapshotOutcome.snapshotImageId) {
      closeData.snapshotImageId = snapshotOutcome.snapshotImageId;
    }
    if (snapshotOutcome.snapshotError) {
      closeData.snapshotError = snapshotOutcome.snapshotError;
    }
    if (closeMetadata) {
      for (const [key, value] of Object.entries(closeMetadata)) {
        if (
          key === "sessionId" ||
          key === "status" ||
          key === "reason" ||
          key === "snapshotSaved" ||
          key === "snapshotImageId" ||
          key === "snapshotError"
        ) {
          continue;
        }
        closeData[key] = value;
      }
    }

    // Flush buffered text/reasoning deltas BEFORE appending the terminal
    // session_closed event. Without this, deltas captured during the prompt
    // run land in the event log after session_closed and replay clients see
    // text appear after the close marker (apps/control-plane-worker/README.md
    // "Projection write ownership"). Idempotent — applier-level flush in
    // applyLifecycleDecision is the defensive fallback.
    await this.flushTextDeltaBuffer();
    const eventState = await this.appendAndBroadcastEvents(session.sessionId, [
      { type: "session_closed", timestamp, data: closeData },
    ]);
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    doDb.updateSession(this.sql, session.sessionId, {
      status: "archived",
      closedAt: timestamp,
      updatedAt: timestamp,
    });
    const pendingPlan = doDb.getLatestSessionPlan(this.sql, session.sessionId);
    if (pendingPlan?.status === "pending") {
      doDb.updateSessionPlanStatus(this.sql, {
        sessionId: session.sessionId,
        planPromptId: pendingPlan.planPromptId,
        status: "superseded",
      });
      await this.refreshPlanApprovalPendingMirror(session.sessionId);
      this.deferPlanApprovalInteractionSupersession(session.sessionId, "archived");
    }
    await this.state.storage.delete([PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, PLAN_READY_DELIVERY_STORAGE_KEY]);
    // ARC-876: clear any armed watchdog state so the alarm scheduler does not
    // try to fire on an archived session. CAS guard in dispatchWatchdogAlarms
    // is the second line of defense.
    this.disarmLifecycleWatchdogs(session.sessionId);
    // Cancel any DO alarm armed by the prompt queue (e.g. max-duration). The
    // alarm() handler also has an archived early return, but deleting here
    // avoids a needless wake-up.
    await this.state.storage.deleteAlarm();
    // Dispatch AFTER flipping session.status to "archived" so the rich_status
    // projection short-circuits to "archived" via computeRichStatus. The
    // reducer carves close_finalize out of the archived no-op for this reason.
    await this.processLifecycleEvent(session.sessionId, { type: "boundary.close_finalize", reason });
    this.closeSandboxSockets("Session closed");

    this.logSessionCompleted(session, reason, snapshotOutcome);
    // Session-deduped outcome-truth record (one attributed cause per session, D1
    // session_outcomes). Best-effort: attribution/write failures must not block archival.
    // preArchiveActivePromptId is the prompt this close just force-failed with
    // "session_archived"; pass it so attribution treats it as benign abandonment, not harm.
    this.recordSessionOutcomeAtClose(session, reason, preArchiveActivePromptId);

    // ARC-1044: sweep the per-operation publish durable steps (and the PR-create
    // step) now that the session is terminal. These are keyed per
    // prompt/head/operation and accumulate across a long-lived session; the
    // values are tiny, but the count is bounded only by prompt count, so clear
    // them on close per apps/control-plane-worker/README.md "SessionDO side effects". Best-effort:
    // a failure here must not block archival.
    for (const prefix of ["publish_", "create_pr_"]) {
      try {
        await clearDurableStepsByPrefix(this.state.storage, prefix);
      } catch (err) {
        this.log.warn(
          { sessionId: session.sessionId, prefix, error: serializeError(err) },
          "Failed to clear publish durable steps on session close",
        );
      }
    }

    try {
      await cleanupSessionNeonBranch(this.env.DB, {
        storage: this.state.storage,
        businessId: session.businessId ?? null,
        sessionId: session.sessionId,
        encryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
        logger: this.log,
      });
    } catch (err) {
      this.log.warn(
        { sessionId: session.sessionId, error: serializeError(err) },
        "Failed to clean up Neon session branch on close",
      );
    }

    if (closeMetadata?.closeSource === "dashboard_archive") {
      this.ctx.waitUntil(this.notifySlackSessionArchived(session.sessionId));
    }

    return eventState.replay;
  }

  private logSessionCompleted(
    session: SessionState,
    reason: string,
    snapshotOutcome: { snapshotSaved: boolean; snapshotError?: string | null },
  ): void {
    try {
      const ext = doDb.getSessionExtended(this.sql, session.sessionId);
      const prompts = doDb.getPrompts(this.sql, session.sessionId);
      const sandbox = doDb.getSandboxState(this.sql, session.sessionId);
      let completedPromptCount = 0;
      let failedPromptCount = 0;
      let queuedPromptCount = 0;
      for (const p of prompts) {
        if (p.status === "completed") completedPromptCount += 1;
        else if (p.status === "failed") failedPromptCount += 1;
        else if (p.status === "queued" || p.status === "processing") queuedPromptCount += 1;
      }
      const lastPrompt = prompts.length > 0 ? prompts[prompts.length - 1] : null;
      const createdAtMs = session.createdAt ? new Date(session.createdAt).getTime() : null;
      const closedAtMs = session.closedAt ? new Date(session.closedAt).getTime() : null;
      const durationMs = createdAtMs != null && closedAtMs != null ? closedAtMs - createdAtMs : null;
      const activeDurationMs = prompts.reduce((total, prompt) => {
        const startedAtMs = prompt.startedAt ? new Date(prompt.startedAt).getTime() : null;
        const completedAtMs = prompt.completedAt ? new Date(prompt.completedAt).getTime() : null;
        if (startedAtMs == null || completedAtMs == null) return total;
        const promptDurationMs = completedAtMs - startedAtMs;
        return Number.isFinite(promptDurationMs) && promptDurationMs > 0 ? total + promptDurationMs : total;
      }, 0);
      const prCreated = Boolean(ext?.prUrl);
      const terminalStage = prCreated
        ? "pr_created"
        : failedPromptCount > 0
          ? "prompt_failed"
          : completedPromptCount > 0
            ? "prompt_completed_no_pr"
            : queuedPromptCount > 0
              ? "queued_unprocessed"
              : "no_prompts";
      const repo = ext?.repoOwner && ext?.repoName ? `${ext.repoOwner}/${ext.repoName}` : null;
      const sessionTelemetryBase = {
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        businessId: session.businessId ?? null,
        sessionKind: "repo",
        reason,
        status: session.status,
        promptCount: prompts.length,
        completedPromptCount,
        failedPromptCount,
        queuedPromptCount,
        prCreated,
        prNumber: ext?.prNumber ?? null,
        repo,
        branch: ext?.lastBranch ?? null,
        sandboxId: sandbox?.sandboxId ?? null,
        terminalStage,
      };
      const sessionStageTimings = deriveSessionStageTimings({
        createdAt: session.createdAt,
        closedAt: session.closedAt,
        prompts,
      });
      const event: Record<string, unknown> = {
        event: "session.completed",
        ...sessionTelemetryBase,
        duration_ms: durationMs,
        activeDurationMs,
        snapshotSaved: snapshotOutcome.snapshotSaved,
        snapshotError: snapshotOutcome.snapshotError ?? null,
        lastPromptStatus: lastPrompt?.status ?? null,
        lastPromptError: lastPrompt?.error ?? null,
      };
      this.log.info(event, "Session completed");
      // Direct-POST to Datadog so @event:session.completed is queryable; without this
      // the console-log path lands as an empty-message entry and @event is not indexed.
      // Mirrors the prompt.trace.finalized pattern used for prompt-level finalization.
      this.ctx.waitUntil(postStructuredEventToDd(this.env, event));
      for (const stageTiming of sessionStageTimings) {
        const stageEvent: Record<string, unknown> = {
          event: "session.stage_timing",
          ...sessionTelemetryBase,
          stage: stageTiming.stage,
          duration_ms: stageTiming.durationMs,
          total_duration_ms: durationMs,
        };
        this.log.info(stageEvent, "Session stage timing");
        this.ctx.waitUntil(postStructuredEventToDd(this.env, stageEvent));
      }
    } catch (err) {
      this.log.warn(
        { sessionId: session.sessionId, error: serializeError(err) },
        "Failed to emit session.completed telemetry",
      );
    }
  }

  /**
   * Session-deduped outcome attribution at the terminal close convergence point.
   * Collapses the whole session into ONE outcome + ONE attributed cause (deduped by
   * session_id in D1), so user-harm is a single GROUP BY instead of summing noisy,
   * retry-inflated prompt_runs rows. Best-effort: a failure here is logged, never thrown,
   * so it cannot block archival.
   */
  private recordSessionOutcomeAtClose(
    session: SessionState,
    reason: string,
    archivedActivePromptId: string | null,
  ): void {
    try {
      const ext = doDb.getSessionExtended(this.sql, session.sessionId);
      const prompts = doDb.getPrompts(this.sql, session.sessionId);
      const telemetry = doDb.getPromptTelemetry(this.sql, session.sessionId);

      let completedPromptCount = 0;
      let failedPromptCount = 0;
      let queuedPromptCount = 0;
      const failedPrompts: { promptId: string; errorCode: string | null | undefined }[] = [];
      for (const p of prompts) {
        if (p.status === "completed") completedPromptCount += 1;
        else if (p.status === "failed") {
          failedPromptCount += 1;
          failedPrompts.push({ promptId: p.promptId, errorCode: telemetry[p.promptId]?.errorCode });
        } else if (p.status === "queued" || p.status === "processing") queuedPromptCount += 1;
      }
      const lastPrompt = prompts.length > 0 ? prompts[prompts.length - 1] : null;
      const prCreated = Boolean(ext?.prUrl);

      const attribution = attributeSessionOutcome({
        prCreated,
        lastPromptStatus: lastPrompt?.status ?? null,
        completedPromptCount,
        failedPromptCount,
        queuedPromptCount,
        promptCount: prompts.length,
        promptErrorCodes: Object.values(telemetry).map((t) => t.errorCode),
        closeReason: reason,
        // Failed prompts that are real harm, excluding the active prompt this close just
        // force-failed for archive (its "session_archived" telemetry is written async and
        // may not be visible here) and any settled archive/abort failure.
        realFailedPromptCount: countRealFailedPrompts(failedPrompts, archivedActivePromptId),
        // Server-side kill reason is not yet threaded into the close boundary (deferred to
        // the reaper/termination producer); attribution persists null until it lands.
        terminationReason: null,
      });

      const createdAtMs = session.createdAt ? new Date(session.createdAt).getTime() : null;
      const closedAtMs = session.closedAt ? new Date(session.closedAt).getTime() : Date.now();
      const repo = ext?.repoOwner && ext?.repoName ? `${ext.repoOwner}/${ext.repoName}` : null;

      const row: SessionOutcomeRow = {
        ...attribution,
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        businessId: session.businessId ?? null,
        repo,
        sessionKind: "repo",
        closeReason: reason,
        prCreated,
        promptCount: prompts.length,
        completedPromptCount,
        failedPromptCount,
        createdAtMs: createdAtMs != null && Number.isFinite(createdAtMs) ? createdAtMs : null,
        recordedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : Date.now(),
      };

      this.ctx.waitUntil(
        recordSessionOutcome(this.env.DB, row).catch((err) => {
          this.log.warn(
            { sessionId: session.sessionId, error: serializeError(err) },
            "Failed to record session outcome",
          );
        }),
      );
    } catch (err) {
      this.log.warn(
        { sessionId: session.sessionId, error: serializeError(err) },
        "Failed to attribute session outcome",
      );
    }
  }

  private async stopSessionAtDurabilityBoundary(
    session: SessionState,
    reason: string,
    options: { stopReason: doDb.SandboxStopReason | null },
  ): Promise<{ replay: ReplayState; richStatus: string }> {
    // Same boundary serves user stops, publish_push_failed, and the
    // sandbox_disconnected auto-stop; tag the early `stopping` substate sync
    // accordingly so non-user stops are not falsely reported as
    // `stop_requested`. Mirrors the discrimination in
    // `causeForLifecycleEvent` for the `boundary.stop_finalize` event that
    // fires later in this same function.
    const stopCause: PhaseTransitionCause =
      options.stopReason === "user" ? "stop_requested" : "sandbox_transport_event";
    await this.putSandboxStatus(session.sessionId, "stopping", { cause: stopCause });
    const snapshotOutcome = await this.captureStopBoundarySnapshot(session.sessionId, reason);

    const timestamp = nowIso();
    session.updatedAt = timestamp;

    const stoppedData: Record<string, unknown> = {
      sessionId: session.sessionId,
      status: "stopped",
      reason,
      snapshotSaved: snapshotOutcome.snapshotSaved,
    };
    if (snapshotOutcome.snapshotImageId) {
      stoppedData.snapshotImageId = snapshotOutcome.snapshotImageId;
    }
    if (snapshotOutcome.snapshotError) {
      stoppedData.snapshotError = snapshotOutcome.snapshotError;
    }

    // Flush buffered text/reasoning deltas BEFORE appending the terminal
    // session_stopped event so deltas captured during the prompt run cannot
    // land in the event log after the stop marker. See
    // closeSessionAtDurabilityBoundary for the same invariant.
    await this.flushTextDeltaBuffer();
    const eventState = await this.appendAndBroadcastEvents(session.sessionId, [
      { type: "session_stopped", timestamp, data: stoppedData },
      {
        type: "status",
        timestamp,
        data: {
          sessionId: session.sessionId,
          phase: "stopped",
          stopMode: options.stopReason === "user" ? "user" : "resumable",
        },
      },
    ]);
    session.lastEventId = `event-${eventState.replay.lastEventSequence}`;
    doDb.updateSession(this.sql, session.sessionId, {
      status: "active",
      closedAt: null,
      updatedAt: timestamp,
    });
    await this.processLifecycleEvent(session.sessionId, {
      type: "boundary.stop_finalize",
      stopReason: options.stopReason,
      reason,
    });
    const richStatus = this.deriveCurrentRichStatus(session.sessionId);
    this.closeSandboxSockets("Session stopped");
    if (options.stopReason === "user") {
      this.ctx.waitUntil(this.notifySlackSessionStopped(session.sessionId));
    }

    return { replay: eventState.replay, richStatus };
  }

  private deriveCurrentSessionStatusFrame(sessionId: string): SessionStatusFrame {
    const session = doDb.getSession(this.sql, sessionId);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const {
      activePromptHasPendingQuestion,
      planApprovalPending,
      planRevision,
      planStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
    } = getRichStatusProjectionInputs(this.sql, sessionId, activePromptId);
    const publishStatus = ext?.publishStatus ?? "not_started";
    // Route through getSessionStatusForResponse so the phase string projected
    // onto `session_index.rich_status` matches /session/state and the WS
    // subscribed snapshot (which also use the helper).
    const richStatus = getSessionStatusForResponse(
      session ?? undefined,
      sandbox?.status,
      activePromptId,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      ext?.reviewListeningActive ?? false,
      this.userStopped,
    );
    const phaseInfo = derivePhaseInfo(session ?? undefined, {
      sandboxStatus: sandbox?.status,
      activePromptId,
      stopReason: sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      userStopped: this.userStopped,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      reviewListeningActive: ext?.reviewListeningActive ?? false,
    });
    return {
      richStatus,
      phaseInfo,
      planApprovalPending,
      planRevision,
      planStatus,
      sessionPresent: session != null,
    };
  }

  private deriveCurrentRichStatus(sessionId: string): string {
    return this.deriveCurrentSessionStatusFrame(sessionId).richStatus;
  }

  // Derives rich status from current DO state and awaits the D1 projection
  // write unless the queued write is skipped as stale. Use this on lifecycle
  // paths that re-project rich_status without broadcasting (alarm /
  // reconnect-grace cleanup). Returns the originally derived rich_status
  // string. Callers that also need to broadcast must use
  // `persistAndBroadcastSessionStatus` instead.
  //
  // `drift` opts a callsite into passive-reconciliation drift detection. The
  // default `SKIP_DRIFT_CHECK` matches every mutation path; only the alarm
  // and reconnect-grace callsites that genuinely replay existing state
  // should pass `{ mode: "passive_reconciliation", source: "..." }`.
  private async persistCurrentRichStatus(
    sessionId: string,
    cause: PhaseTransitionCause = "unknown",
    drift: DriftCheckConfig = SKIP_DRIFT_CHECK,
  ): Promise<string> {
    return this.statusProjection.persistCurrentRichStatus(sessionId, cause, drift);
  }

  private async runPersistCurrentRichStatus(
    sessionId: string,
    cause: PhaseTransitionCause = "unknown",
    drift: DriftCheckConfig = SKIP_DRIFT_CHECK,
  ): Promise<string> {
    const frame = await this.persistAndRecordSessionStatusFrame(sessionId, cause, drift);
    return frame.richStatus;
  }

  private async refreshPlanApprovalPendingMirror(sessionId: string): Promise<void> {
    const pending = doDb.getLatestSessionPlan(this.sql, sessionId)?.status === "pending";
    if (pending === this.planApprovalPending) return;
    this.planApprovalPending = pending;
    if (pending) {
      await this.state.storage.put(PLAN_APPROVAL_PENDING_STORAGE_KEY, 1);
    } else {
      await this.state.storage.delete(PLAN_APPROVAL_PENDING_STORAGE_KEY);
    }
  }

  private async emitPlanApprovalSpineEvent(sessionId: string, kind: "awaiting" | "user_input"): Promise<void> {
    const deps = this.buildFsmTransportDeps(sessionId);
    if (!deps) return;
    const emission = kind === "awaiting" ? buildPlanAwaitingInputEmission() : buildPlanUserInputEmission();
    try {
      await applyEvent(deps, {
        sessionId,
        event: emission.event,
        metadata: emission.metadata,
        actor: emission.actor,
      });
    } catch (error) {
      this.log.warn(
        { event: "plan_approval_fsm_emit_failed", sessionId, kind, error: String(error) },
        "Plan approval FSM producer failed (ignored)",
      );
    }
  }

  private async reconcilePlanApprovalSpine(sessionId: string): Promise<void> {
    if (!this.env.DB) return;
    const pending = doDb.getLatestSessionPlan(this.sql, sessionId)?.status === "pending";
    const record = await getPrCoordination(this.env.DB, sessionId).catch(() => null);
    if (!record) return;
    if (pending && record.state !== "AWAITING_INPUT") {
      if (record.state !== "GENERATING") {
        await this.emitPlanApprovalSpineEvent(sessionId, "user_input");
      }
      await this.emitPlanApprovalSpineEvent(sessionId, "awaiting");
    } else if (!pending && record.state === "AWAITING_INPUT") {
      await this.emitPlanApprovalSpineEvent(sessionId, "user_input");
    }
  }

  private async attemptPlanReadyDelivery(sessionId: string, state: PlanReadyDeliveryState): Promise<void> {
    const latest = doDb.getLatestSessionPlan(this.sql, sessionId);
    const callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext ?? undefined;
    if (
      latest?.status !== "pending" ||
      latest.planPromptId !== state.planPromptId ||
      latest.revision !== state.revision
    ) {
      await this.state.storage.delete(PLAN_READY_DELIVERY_STORAGE_KEY);
      await logBlockedDmOutcome(this.env, "skipped_stale_plan", sessionId, BlockerKind.PlanReady, callbackContext);
      return;
    }
    const session = doDb.getSession(this.sql, sessionId);
    const ownerUserId = Number(session?.ownerUserId);
    if (!session || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
      await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
        ...state,
        status: "skipped",
        nextAttemptAt: null,
      } satisfies PlanReadyDeliveryState);
      await logBlockedDmOutcome(this.env, "skipped_bad_owner", sessionId, BlockerKind.PlanReady, callbackContext);
      return;
    }
    const result = await notifyUserBlocked(this.env, {
      sessionId,
      ownerUserId,
      callbackContext,
      kind: BlockerKind.PlanReady,
      dedupKey: `${state.planPromptId}:${state.revision}`,
      ...(state.approvable && session.businessId
        ? {
            planReadyApproval: { businessId: session.businessId, revision: state.revision },
            planReadyMarkdown: latest.markdown,
          }
        : {}),
      storage: this.state.storage,
    });
    const attempts = state.attempts + 1;
    if (result === "sent" || result === "skipped_deduped") {
      await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
        ...state,
        attempts,
        status: "sent",
        nextAttemptAt: null,
      } satisfies PlanReadyDeliveryState);
      return;
    }
    if (result !== "failed") {
      await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
        ...state,
        attempts,
        status: "skipped",
        nextAttemptAt: null,
      } satisfies PlanReadyDeliveryState);
      return;
    }
    const exhausted = attempts >= PLAN_READY_NOTIFICATION_MAX_ATTEMPTS;
    await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      ...state,
      attempts,
      status: exhausted ? "exhausted" : "pending",
      nextAttemptAt: exhausted
        ? null
        : Date.now() +
          PLAN_READY_NOTIFICATION_RETRY_DELAYS_MS[
            Math.min(attempts - 1, PLAN_READY_NOTIFICATION_RETRY_DELAYS_MS.length - 1)
          ],
    } satisfies PlanReadyDeliveryState);
  }

  private async onPlanApprovalParked(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    valid: boolean;
    missingReason: string | null;
  }): Promise<void> {
    await this.refreshPlanApprovalPendingMirror(args.sessionId);
    const parkedAt = Date.now();
    const existingDelivery = await this.state.storage.get<PlanReadyDeliveryState>(PLAN_READY_DELIVERY_STORAGE_KEY);
    const isDuplicatePark =
      existingDelivery?.planPromptId === args.planPromptId && existingDelivery.revision === args.revision;
    let delivery: PlanReadyDeliveryState | null = null;
    if (!isDuplicatePark) {
      const sandbox = doDb.getSandboxState(this.sql, args.sessionId);
      await this.state.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
        deadlineAt: parkedAt + PLAN_PARK_PAUSE_AFTER_MS,
        parkedAt,
        planPromptId: args.planPromptId,
        runtimeSandboxId: sandbox?.runtimeSandboxId ?? null,
      } satisfies PlanParkPauseDeadline);
      delivery = {
        planPromptId: args.planPromptId,
        revision: args.revision,
        approvable: args.valid,
        attempts: 0,
        status: "pending",
        nextAttemptAt: parkedAt,
      };
      await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, delivery);
    } else {
      await logBlockedDmOutcome(
        this.env,
        "skipped_duplicate_park",
        args.sessionId,
        BlockerKind.PlanReady,
        doDb.getSessionExtended(this.sql, args.sessionId)?.callbackContext ?? undefined,
      );
    }
    await this.emitPlanApprovalSpineEvent(args.sessionId, "awaiting");
    await this.persistAndBroadcastSessionStatus(args.sessionId, "active_prompt_cleared");
    if (delivery) await this.attemptPlanReadyDelivery(args.sessionId, delivery);
    await this.rescheduleSessionAlarm();
  }

  private async onPlanApprovalDiscussion(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    promptId: string;
  }): Promise<void> {
    this.deferPlanApprovalInteractionSupersession(args.sessionId, "discussed");
    await this.releasePlanApprovalPark(args.sessionId, "active_prompt_started");
  }

  private async onPlanApprovalApproved(sessionId: string): Promise<void> {
    // Render the approved plan inline into the Slack notice. Read from this.sql
    // (not a re-entrant DO self-fetch) and hand it to the supersession.
    const planMarkdown = doDb.getLatestSessionPlan(this.sql, sessionId)?.markdown ?? null;
    this.deferPlanApprovalInteractionSupersession(sessionId, "approved", planMarkdown);
    await this.releasePlanApprovalPark(sessionId, "active_prompt_started");
  }

  private async onPlanApprovalStopped(sessionId: string): Promise<void> {
    if (doDb.getLatestSessionPlan(this.sql, sessionId)?.status !== "pending") return;
    this.deferPlanApprovalInteractionSupersession(sessionId, "stopped");
  }

  // Edits bump the revision without leaving the park: the old Approve button is
  // revision-stale, so supersede it and publish a fresh PlanReady delivery bound
  // to the new revision. The park-pause deadline is left untouched (an edit does
  // not resume the sandbox). The D1 supersession must complete BEFORE the
  // replacement delivery mints its interaction row — a deferred unscoped
  // supersede can match the new row and dead-button the fresh Approve message.
  // The Slack repaint of the stale message is backgrounded: PUT /session/plan
  // awaits this hook, and a rate-limited chat.update must not stall the edit.
  private async onPlanApprovalEdited(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
  }): Promise<void> {
    await supersedePlanApprovalInteractionRequests(this.env, args.sessionId, "edited", {
      deferSlackUpdates: (work) => this.ctx.waitUntil(work),
    }).catch((error) => {
      this.log.warn(
        {
          event: "plan_approval_slack_supersession_failed",
          sessionId: args.sessionId,
          reason: "edited",
          error: String(error),
        },
        "Plan approval Slack supersession failed",
      );
    });
    const delivery: PlanReadyDeliveryState = {
      planPromptId: args.planPromptId,
      revision: args.revision,
      approvable: true,
      attempts: 0,
      status: "pending",
      nextAttemptAt: Date.now(),
    };
    await this.state.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, delivery);
    await this.attemptPlanReadyDelivery(args.sessionId, delivery);
    await this.rescheduleSessionAlarm();
  }

  private deferPlanApprovalInteractionSupersession(
    sessionId: string,
    reason: PlanApprovalSupersessionReason,
    planMarkdown: string | null = null,
  ): void {
    this.ctx.waitUntil(
      supersedePlanApprovalInteractionRequests(this.env, sessionId, reason, { planMarkdown }).catch((error) => {
        this.log.warn(
          { event: "plan_approval_slack_supersession_failed", sessionId, reason, error: String(error) },
          "Plan approval Slack supersession failed",
        );
      }),
    );
  }

  /** Shared Discuss/Accept release seam. */
  private async releasePlanApprovalPark(sessionId: string, cause: PhaseTransitionCause): Promise<void> {
    await this.state.storage.delete([PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, PLAN_READY_DELIVERY_STORAGE_KEY]);
    await this.refreshPlanApprovalPendingMirror(sessionId);
    await this.emitPlanApprovalSpineEvent(sessionId, "user_input");
    await this.persistAndBroadcastSessionStatus(sessionId, cause);
    await this.rescheduleSessionAlarm();
  }

  private async cancelPlanParkPause(): Promise<void> {
    await this.state.storage.delete(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY);
    await this.rescheduleSessionAlarm();
  }

  private async fireDuePlanParkPause(sessionId: string): Promise<void> {
    const deadline = await this.state.storage.get<PlanParkPauseDeadline>(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY);
    if (!deadline || deadline.deadlineAt > Date.now()) return;
    await this.state.storage.delete(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY);
    const latest = doDb.getLatestSessionPlan(this.sql, sessionId);
    if (latest?.status !== "pending" || latest.planPromptId !== deadline.planPromptId) return;
    if (!deadline.runtimeSandboxId) return;
    await this.pauseE2BRuntimeForIdle(
      sessionId,
      deadline.runtimeSandboxId,
      deadline.parkedAt,
      SandboxIdlePauseReason.PLAN_APPROVAL_PARK,
    );
  }

  private async fireDuePlanReadyDelivery(sessionId: string): Promise<void> {
    const delivery = await this.state.storage.get<PlanReadyDeliveryState>(PLAN_READY_DELIVERY_STORAGE_KEY);
    if (!delivery || delivery.status !== "pending" || delivery.nextAttemptAt === null) return;
    if (delivery.nextAttemptAt > Date.now()) return;
    await this.attemptPlanReadyDelivery(sessionId, delivery);
  }

  private async runRichStatusProjectionSerially<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.richStatusProjectionQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const queued = result.then(
      () => undefined,
      () => undefined,
    );
    this.richStatusProjectionQueues.set(sessionId, queued);
    try {
      return await result;
    } finally {
      if (this.richStatusProjectionQueues.get(sessionId) === queued) {
        this.richStatusProjectionQueues.delete(sessionId);
      }
    }
  }

  /**
   * Lifecycle blocking helper. Returns the invocation's derived frame after
   * its rich_status either lands in D1 or is skipped because a newer local
   * frame is already responsible for projection.
   *
   * Ordering invariants:
   * 1. Derive the frame from local DO state (pure).
   * 2. Seed `lastObservedPhase[sessionId]` SYNCHRONOUSLY, before any await.
   *    This closes the reentrancy window where a concurrent
   *    alarm/transport/socket event arriving during the projection await
   *    would emit duplicate phase telemetry.
   * 3. When the caller opts in with `drift.mode === "passive_reconciliation"`,
   *    perform the drift-check D1 SELECT inline (so it is sequenced before
   *    the projection UPDATE) but emit the Datadog drift metric via
   *    `waitUntil` so external telemetry stays off the lifecycle critical
   *    path. Drift-check failures are logged and never block the projection
   *    write. Mutation callsites (the default) skip drift detection entirely
   *    because a transitioning phase is not drift — the column is the
   *    after-image, not a stale read.
   * 4. Queue the final re-derive + projection UPDATE per session so older
   *    in-flight D1 writes cannot land after newer ones.
   * 5. Re-derive immediately before the projection UPDATE. If local state
   *    advanced while this helper was awaiting pre-write work or a prior
   *    queued projection, skip the stale UPDATE; the newer transition owns its
   *    own projection.
   * 6. Await the rich_status projection. `MissingSessionIndexRowError` is
   *    surfaced to the caller (fail-closed).
   * 7. Record the phase transition (fan-out of `postPhaseTransitionEvent` /
   *    `postPhaseTransitionMetric` happens via `waitUntil`, off critical path).
   */
  private async persistAndRecordSessionStatusFrame(
    sessionId: string,
    cause: PhaseTransitionCause = "unknown",
    drift: DriftCheckConfig = SKIP_DRIFT_CHECK,
  ): Promise<SessionStatusFrame> {
    const frame = this.deriveCurrentSessionStatusFrame(sessionId);
    const previousPhase = this.lastObservedPhase.get(sessionId) ?? null;
    // Seed BEFORE any await so concurrent re-entry sees "already observed".
    this.lastObservedPhase.set(sessionId, frame.phaseInfo.phase);
    // Reconcile the durable plan-approval mirror AFTER the synchronous seed.
    // `deriveCurrentSessionStatusFrame` already reads plan state fresh from
    // SQLite, so the mirror refresh does not affect `frame`; keeping it below
    // the seed preserves the reentrancy-window-closure invariant above (the
    // refresh awaits durable storage on a pending-state change, and a concurrent
    // re-entry during that await must observe the already-seeded phase).
    await this.refreshPlanApprovalPendingMirror(sessionId);

    // Exhaustive switch over DriftCheckConfig so adding a future mode is a
    // compile error here rather than a silent fall-through to "skip".
    switch (drift.mode) {
      case "passive_reconciliation": {
        if (this.env.DB) {
          const session = doDb.getSession(this.sql, sessionId);
          const sessionKind = session?.sessionKind ?? null;
          // Inline SELECT so it lands at D1 before the UPDATE below.
          await this.checkPhaseDriftOnSeed(sessionId, frame.phaseInfo.phase, sessionKind, cause, drift.source);
        }
        break;
      }
      case "skip":
        break;
      default: {
        const _exhaustive: never = drift;
        void _exhaustive;
      }
    }

    return this.runRichStatusProjectionSerially(sessionId, async () => {
      const currentFrame = this.deriveCurrentSessionStatusFrame(sessionId);
      // A missing local session row derives to `archived`, and the D1 projection
      // write force-flips `session_index.status='archived'` for that string
      // (buildSyncRichStatusStatement). During a startup/hydration race the row
      // can be transiently absent before the bridge connects; projecting it would
      // strand the row as a false archive (D1 archived / FSM still GENERATING /
      // sandbox alive). The genuine archive path presents a *present* archived row
      // (closeSessionAtDurabilityBoundary sets status in DO memory first), so this
      // guard never suppresses a real archive — it only drops the false one.
      if (!currentFrame.sessionPresent) {
        this.log.warn(
          {
            event: "rich_status_projection_skipped_missing_session",
            sessionId,
            derivedRichStatus: currentFrame.richStatus,
            cause,
          },
          "Skipped rich_status projection: local session row missing (would have force-written archived)",
        );
        return frame;
      }
      if (sessionStatusFramesDiffer(frame, currentFrame)) {
        this.log.info(
          {
            event: "rich_status_projection_skipped_stale",
            sessionId,
            staleRichStatus: frame.richStatus,
            currentRichStatus: currentFrame.richStatus,
            staleFields: phaseFieldsFromInfo(frame.phaseInfo),
            currentFields: phaseFieldsFromInfo(currentFrame.phaseInfo),
            cause,
          },
          "Skipped stale rich_status projection (state moved before D1 update)",
        );
        return frame;
      }

      await this.persistRichStatusToD1(sessionId, frame.richStatus, frame.planApprovalPending, frame.planStatus);
      this.recordPhaseTransition(sessionId, frame.phaseInfo, cause, previousPhase);
      return frame;
    });
  }

  // Detect phase changes and fan out transition telemetry: a structured log,
  // a queryable Datadog event (@event:session.phase_transition), and a count
  // metric tagged with previous/next phase and the trigger cause.
  //
  // `previous` is captured by the caller (`persistAndRecordSessionStatusFrame`)
  // BEFORE the synchronous `lastObservedPhase` seed and BEFORE any await, so
  // it reflects the cache state at the moment the helper was invoked. A
  // null `previous` means this was the first observation for this
  // (DO instance, sessionId): seed silently — the canonical initial phase
  // already lands via the WS subscribed snapshot, so a null→X transition on
  // every hot start would be noise. Drift detection is independent of this
  // path: it runs only when a caller explicitly opts in via
  // `drift.mode === "passive_reconciliation"` (alarm / reconnect-grace
  // cleanup), not on first observations.
  private recordPhaseTransition(
    sessionId: string,
    info: PhaseInfo,
    cause: PhaseTransitionCause,
    previous: Phase | null,
  ): void {
    if (previous === null || previous === info.phase) return;
    const session = doDb.getSession(this.sql, sessionId);
    const sessionKind = session?.sessionKind ?? null;
    const agentRuntimeBackend = session?.agentRuntimeBackend ?? null;
    this.log.info(
      {
        event: "session.phase_transition",
        sessionId,
        previousPhase: previous,
        nextPhase: info.phase,
        sandboxSubstate: info.sandboxSubstate,
        finalizingStep: info.finalizingStep,
        stopMode: info.stopMode,
        cause,
        sessionKind,
        agentRuntimeBackend,
      },
      "Session phase transition",
    );
    const event = {
      sessionId,
      previousPhase: previous,
      next: info,
      cause,
      sessionKind,
      agentRuntimeBackend,
    };
    this.ctx.waitUntil(postPhaseTransitionEvent(this.env, event));
    this.ctx.waitUntil(postPhaseTransitionMetric(this.env, event));
  }

  // Compare the just-derived phase to the persisted projection
  // (`session_index.rich_status`). A mismatch means the column lagged behind
  // a prior broadcast on a real reconciliation path — for example an alarm
  // tick or reconnect-grace cleanup that found the DO and the column out of
  // sync. Mutation callsites do not call this: their phase changes are
  // expected to differ from the pre-write column, which would otherwise
  // generate false-positive drift events (the bug fixed in PR #3337's
  // follow-up; see docs/debugging.md "session.phase_drift").
  //
  // `persistAndRecordSessionStatusFrame` calls this inline before the
  // projection UPDATE, so the read is sequenced before the write at D1. The
  // SELECT is on the lifecycle critical path; the Datadog metric POST is
  // fired via `waitUntil` so external egress never blocks the broadcast.
  // Drift-check failures are logged and never block the projection write or
  // broadcast.
  private async checkPhaseDriftOnSeed(
    sessionId: string,
    derivedPhase: Phase,
    sessionKind: string | null,
    cause: PhaseTransitionCause,
    reconciliationSource: string,
  ): Promise<void> {
    const db = this.env.DB;
    if (!db) return;
    try {
      const row = await db
        .prepare("SELECT rich_status FROM session_index WHERE session_id = ?")
        .bind(sessionId)
        .first<{ rich_status: string | null }>();
      const persistedPhase = row?.rich_status ?? null;
      if (persistedPhase === null) return;
      if (persistedPhase === derivedPhase) return;
      this.log.warn(
        {
          event: "session.phase_drift",
          sessionId,
          persistedPhase,
          derivedPhase,
          cause,
          reconciliationSource,
        },
        "Session phase drift detected during passive reconciliation",
      );
      // Keep the Datadog POST off the lifecycle critical path. The metric
      // exporter handles its own retries; a slow/dead Datadog endpoint must
      // not delay or block the awaited rich_status projection or the
      // session_status broadcast.
      this.ctx.waitUntil(
        postPhaseDriftMetric(this.env, {
          sessionId,
          persistedPhase,
          derivedPhase,
          cause,
          reconciliationSource,
        }),
      );
    } catch (err) {
      this.log.warn(
        { event: "session.phase_drift_check_failed", sessionId, error: serializeError(err) },
        "Phase drift check threw",
      );
    }
  }

  // Awaits the rich_status projection write, then broadcasts session_status
  // with the canonical phase fields. The legacy `status` wire alias was
  // removed in PR D; the returned `richStatus` string is still used
  // internally (D1 column + non-wire callers).
  //
  // Lifecycle contract: rich_status MUST be durable in D1 before the
  // broadcast so a DO restart cannot observe a phase that was already shown
  // to clients but never persisted (see apps/control-plane-worker/README.md
  // "Projection write ownership").
  //
  // Stale-frame guard: between the await and the broadcast, a concurrent
  // event can mutate DO-local state. Re-derive the frame after the await; if
  // any wire field (richStatus or any phaseFieldsFromInfo output) no longer
  // matches, drop this broadcast — the newer transition owns its own
  // broadcast. richStatus alone is phase-only and would miss substate /
  // stopMode / finalizingStep flips inside the same phase.
  private async persistAndBroadcastSessionStatus(
    sessionId: string,
    cause: PhaseTransitionCause = "unknown",
  ): Promise<string> {
    return this.statusProjection.persistAndBroadcastSessionStatus(sessionId, cause);
  }

  private async runPersistAndBroadcastSessionStatus(
    sessionId: string,
    cause: PhaseTransitionCause = "unknown",
  ): Promise<string> {
    const frame = await this.persistAndRecordSessionStatusFrame(sessionId, cause);
    const reDerived = this.deriveCurrentSessionStatusFrame(sessionId);
    const persistedFields = phaseFieldsFromInfo(frame.phaseInfo);
    if (sessionStatusFramesDiffer(frame, reDerived)) {
      const currentFields = phaseFieldsFromInfo(reDerived.phaseInfo);
      this.log.info(
        {
          event: "session_status.stale_frame_dropped",
          sessionId,
          persistedRichStatus: frame.richStatus,
          currentRichStatus: reDerived.richStatus,
          persistedFields,
          currentFields,
          cause,
        },
        "Dropped stale session_status broadcast (state moved during projection await)",
      );
      return frame.richStatus;
    }
    // Carry lastBranch on the frame so a push that re-enters a non-terminal phase
    // (review_listening/idle) surfaces the new branch to an open detail without
    // waiting for the ~30s poll -- e.g. the Create-PR CTA gates on lastBranch !=
    // baseBranch. Read fresh from D1 so it reflects the just-written push branch.
    const lastBranch = doDb.getSessionExtended(this.sql, sessionId)?.lastBranch ?? null;
    const lifecyclePatch = frame.uiLifecycleStage !== undefined ? { uiLifecycleStage: frame.uiLifecycleStage } : {};
    this.broadcast({
      type: "session_status",
      ...persistedFields,
      ...lifecyclePatch,
      lastBranch,
      userStopped: this.userStopped,
      planApprovalPending: frame.planApprovalPending,
      planRevision: frame.planRevision,
      planStatus: frame.planStatus,
    });
    // Mirror the phase flip to the per-business sidebar feed so list rows update
    // live — including alarm-driven terminal transitions, which run with zero
    // connected per-session sockets (ARC-1322).
    this.publishFeedDelta({
      type: "session_status",
      sessionId,
      source: `status:${cause}`,
      ...persistedFields,
      ...lifecyclePatch,
      userStopped: this.userStopped,
    });
    // Mirror the phase flip onto the Slack status card in place (best-effort,
    // update-only). Excluded stages: `starting` (webhook owns the initial card)
    // and `done` (terminal delivery in notifySlackThread owns the richer
    // render). Deduped per stage and serialized through the narration chain so
    // phase + narration edits of the same card cannot interleave or fight.
    const cardStage = slackStatusStageForPhase(persistedFields.phase);
    if (SLACK_PHASE_CARD_STAGES.has(cardStage)) {
      this.queueSlackPhaseCardUpdate(sessionId, cardStage);
    }
    return frame.richStatus;
  }

  /**
   * Notify the lifecycle pipeline that the active prompt changed. The source
   * of truth for "which prompt is processing" is now the prompts table (see
   * doDb.getActiveProcessingPromptId); this method emits the
   * `prompt.enqueued` lifecycle event when a new prompt becomes active and
   * always re-projects rich_status downstream. Propagate-on-rejection: prompt
   * transitions must not silently look successful to the caller if the D1
   * rich_status projection cannot be made durable.
   */
  private async notePromptTransition(sessionId: string, promptId: string | null): Promise<void> {
    if (promptId) {
      // Resume gesture (resume-stopped-session): a prompt is being promoted to the active/
      // dispatched slot. This is the single chokepoint every promotion path funnels through
      // (enqueue admit, queue drain of a resume queued behind an aborting prompt, and
      // review-loop/stale-prompt retries), so clear the live-idle user-stop flag here rather
      // than only at enqueue admit. Otherwise a resume queued behind the aborting prompt would
      // dispatch without clearing → the agent runs and returns to idle still showing "Stopped",
      // and stopped_kept_alive_at lingers (rehydrating the flag across DO eviction and
      // mis-attributing a later dispatch). No-op when already clear. Must run before the
      // active_prompt_started broadcast below so that frame carries userStopped:false.
      await this.clearUserStopped();
      this.recordRuntimeActivity(sessionId, "prompt_enqueued");
      await this.processLifecycleEvent(sessionId, { type: "prompt.enqueued", promptId });
    }
    await this.persistAndBroadcastSessionStatus(
      sessionId,
      promptId ? "active_prompt_started" : "active_prompt_cleared",
    );
  }

  // Replaces all single-key `this.state.storage.put("sandbox_status", ...)`
  // When transitioning to "stopped", pass `stopReason` so prompt-queue can
  // distinguish user-stops (block auto-resume) from auto-reaps (auto-resume).
  // Any non-"stopped" transition clears stop_reason.
  /**
   * Stash ephemeral spawn-timing breadcrumbs so the `ready` handler (a separate
   * async flow triggered when the bridge connects) can attribute the spawn to
   * warm-claim vs cold-create and surface E2B-create / bridge-launch timings.
   * Best-effort: instrumentation must never fail a spawn.
   */
  private async recordSpawnInstrumentation(sessionId: string, data: SpawnInstrumentation): Promise<void> {
    try {
      await this.state.storage.put(spawnInstrumentationKey(sessionId), data);
    } catch (err) {
      this.log.warn({ sessionId, error: serializeError(err) }, "Failed to record spawn instrumentation");
    }
  }

  private async putSandboxStatus(
    sessionId: string,
    status: string,
    options?: { stopReason?: doDb.SandboxStopReason | null; cause?: PhaseTransitionCause },
  ): Promise<void> {
    if (status === "spawning") {
      const sandbox = doDb.getSandboxState(this.sql, sessionId);
      const session = doDb.getSession(this.sql, sessionId);
      const claimStartedEvent = {
        event: "sandbox.claim_started",
        session_id: sessionId,
        ...(sandbox?.sandboxId ? { sandbox_id: sandbox.sandboxId } : {}),
        agent_runtime_backend: session?.agentRuntimeBackend ?? null,
        model: session?.model ?? null,
        ...(session?.repoOwner && session.repoName ? { repo: `${session.repoOwner}/${session.repoName}` } : {}),
        outcome: "started",
      };
      this.log.info(claimStartedEvent, "Startup timeline: sandbox.claim_started");
      this.ctx.waitUntil(postStructuredEventToDd(this.env, claimStartedEvent));
      markSpawnStarted({ sql: this.sql, sessionId, at: Date.now() });
      doDb.updateSessionFields(this.sql, sessionId, { spawnDurationMs: null });
    } else if (status === "ready") {
      const sandbox = doDb.getSandboxState(this.sql, sessionId);
      const session = doDb.getSession(this.sql, sessionId);
      const spawnStartedAt = sandbox?.spawnStartedAt;
      if (spawnStartedAt) {
        const readyAt = Date.now();
        const spawnDurationMs = readyAt - spawnStartedAt;
        const sessionCreatedAtMs = session ? Date.parse(session.createdAt) : Number.NaN;
        const sessionCreationToSandboxReadyMs = Number.isFinite(sessionCreatedAtMs)
          ? readyAt - sessionCreatedAtMs
          : null;
        // Read back the spawn breadcrumbs recorded during spawnSandbox
        // (E2B-create ms). `bridge_launch_ms` = attach -> bridge-ready.
        // Tolerate a missing record (older in-flight spawns, instrumentation
        // write failure) by emitting the base fields only.
        const instrumentation = await this.state.storage
          .get<SpawnInstrumentation>(spawnInstrumentationKey(sessionId))
          .catch(() => undefined);
        const spawnPath = instrumentation?.spawnPath;
        const e2bCreateMs = instrumentation?.e2bCreateMs ?? null;
        const runtimeBackend = sandbox?.runtimeBackend ?? instrumentation?.runtimeBackend;
        const bridgeLaunchMs = instrumentation?.attachedAtMs != null ? readyAt - instrumentation.attachedAtMs : null;
        const readyEvent = {
          sessionId,
          event: "sandbox.ready",
          session_id: sessionId,
          ...(sandbox?.sandboxId ? { sandbox_id: sandbox.sandboxId } : {}),
          ownerUserId: session?.ownerUserId ?? null,
          owner_user_id: session?.ownerUserId ?? null,
          spawn_duration_ms: spawnDurationMs,
          duration_ms: spawnDurationMs,
          session_creation_to_sandbox_ready_ms: sessionCreationToSandboxReadyMs,
          spawn_path: spawnPath,
          e2b_create_ms: e2bCreateMs,
          bridge_launch_ms: bridgeLaunchMs,
          runtime_backend: runtimeBackend,
          agent_runtime_backend: session?.agentRuntimeBackend ?? null,
          model: session?.model ?? null,
          ...(session?.repoOwner && session.repoName ? { repo: `${session.repoOwner}/${session.repoName}` } : {}),
          outcome: "ready",
        };
        this.log.info(readyEvent, "Startup timeline: sandbox.ready");
        this.ctx.waitUntil(postStructuredEventToDd(this.env, readyEvent));
        doDb.updateSessionFields(this.sql, sessionId, { spawnDurationMs });
        clearSpawnStarted({ sql: this.sql, sessionId });
        await this.sendToSandbox({
          type: "spawn_info",
          spawnDurationMs,
          spawnPath,
          e2bCreateMs,
          bridgeLaunchMs,
          runtimeBackend,
        });
        if (instrumentation) {
          await this.state.storage.delete(spawnInstrumentationKey(sessionId)).catch(() => undefined);
        }
      }
      if (sandbox?.sandboxId) {
        await this.processLifecycleEvent(sessionId, {
          type: "sandbox.ws_connected",
          sandboxId: sandbox.sandboxId,
        });
      }
    }
    const stopReason = status === "stopped" ? (options?.stopReason ?? null) : null;
    if (status === "stopped") {
      // A spawn that fails after recordSpawnInstrumentation wrote its breadcrumb
      // never reaches "ready" (where the key is consumed), so clean it up here so
      // a failed/abandoned spawn leaves no orphaned spawn_instr key in DO storage.
      // No-op on a normal stop (the ready handler already deleted it).
      await this.state.storage.delete(spawnInstrumentationKey(sessionId)).catch(() => undefined);
    }
    doDb.updateSandboxState(this.sql, sessionId, { status, stopReason });
    // Broadcast session_status so phase/substate transitions (e.g. running ->
    // sandboxSubstate=creating during spawn, or running -> sandboxSubstate=reconnecting
    // on transport flap) propagate to subscribed clients. The dropped
    // sandbox_spawning / sandbox_reconnecting peer frames used to carry those signals.
    // Propagate-on-rejection: sandbox-status callers are control-plane mutations
    // whose caller should know if the projection failed.
    await this.persistAndBroadcastSessionStatus(sessionId, options?.cause ?? "sandbox_transport_event");
  }

  // Canonical "session is finished, finalize sandbox state" projection.
  // Used by the stop/close boundaries that previously each
  // hand-wrote the same sandbox-state patch + rich-status sync + broadcast
  // sequence; one helper means a new boundary cannot forget a step.
  //
  // The local DO SQLite write (sandbox status = stopped + cleanup fields) is
  // the durable source of truth for "session finished." If the awaited D1
  // rich_status projection rejects, we MUST NOT roll that back — the wider
  // close pipeline (manifest write, S3 archive, prompt-queue cleanup, etc.)
  // depends on it. Funnel the projection rejection through the existing
  // Sentry-tagged surface and skip the broadcast; a subsequent DO restart's
  // seed drift-check will surface any lingering drift.
  private async finalizeSandboxStopped(
    sessionId: string,
    options: {
      stopReason?: doDb.SandboxStopReason | null;
      preserveExistingStopReason?: boolean;
      cause?: PhaseTransitionCause;
    } = {},
  ): Promise<string> {
    // First-authoritative-transition-wins: when preserveExistingStopReason is
    // set, the existing non-null stopReason is kept. Transport-driven stops
    // pass this so a WS close after a user-stop does not clobber "user".
    let resolvedStopReason: doDb.SandboxStopReason | null = options.stopReason ?? null;
    if (options.preserveExistingStopReason) {
      const existing = doDb.getSandboxState(this.sql, sessionId)?.stopReason ?? null;
      if (existing !== null) {
        resolvedStopReason = existing;
      }
    }
    doDb.updateSandboxState(this.sql, sessionId, {
      status: "stopped",
      stopReason: resolvedStopReason,
      pendingPromptDispatch: false,
    });
    clearTransportMarkers({ sql: this.sql, sessionId });
    clearPromptActivityOnSessionClose({ sql: this.sql, sessionId });
    const cause = options.cause ?? "sandbox_transport_event";
    const richStatus = await this.swallowLifecyclePersistence(
      sessionId,
      cause,
      () => this.persistAndBroadcastSessionStatus(sessionId, cause),
      "",
    );
    this.log.info(
      { event: "sandbox_stopped_finalized", sessionId, stopReason: resolvedStopReason, richStatus: richStatus || null },
      "Sandbox transitioned to stopped",
    );
    return richStatus;
  }

  /**
   * Live-idle user stop (resume-stopped-session): keep the sandbox live instead of pausing.
   * Fires ONLY the two semantics the pause boundary used to carry — review-listening-exit and
   * (via the caller) QA-inconclusive — with no captureStopBoundarySnapshot/pauseSandbox,
   * finalizeSandboxStopped, or closeSandboxSockets. Sandbox stays status="ready",
   * runtime_state="running", lease live, socket open → computePhase falls through to `idle`.
   */
  private async stopSessionKeepAlive(session: SessionState): Promise<void> {
    const sessionId = session.sessionId;
    const stoppedAtMs = Date.now();
    await this.state.storage.put(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY, stoppedAtMs);
    this.userStopped = true;

    // Preserve review-listening-exit (reducer.ts:521-524) WITHOUT finalize_sandbox_stopped.
    // The standalone review_listening.exited event only clears the listen markers (reducer.ts:574-575).
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    if (ext?.reviewListeningActive) {
      await this.processLifecycleEvent(sessionId, { type: "review_listening.exited", reason: "user_stop" });
    }

    // Stop divergence point: structured event PR-4 attaches arcanist.sandbox.stop_kept_alive to.
    this.ctx.waitUntil(
      postStructuredEventToDd(this.env, {
        event: "sandbox.stop_kept_alive",
        sessionId,
        stop_reason: "user",
        runtime_backend: this.readPersistedRuntimeBackendOrNull(sessionId),
        stoppedKeptAliveAt: stoppedAtMs,
      }),
    );

    // Broadcast the still-idle status frame now carrying userStopped:true (phase is unchanged).
    await this.persistAndBroadcastSessionStatus(sessionId, "stop_requested");
  }

  /**
   * Clear the live-idle user-stop flag (durable + in-memory). Called from the single prompt-
   * promotion chokepoint `notePromptTransition(sessionId, <non-null promptId>)`, so every resume
   * path (enqueue admit, queue drain, review-loop/stale retries) clears it. No-op when already clear.
   */
  private async clearUserStopped(): Promise<void> {
    this.userStopped = false;
    await this.state.storage.delete(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY);
  }

  private async isCurrentSpawnAttempt(spawnAttemptId: string | undefined | null): Promise<boolean> {
    if (!spawnAttemptId) return false;
    const currentAttemptId = (await this.state.storage.get("spawnAttemptId")) as string | undefined;
    return currentAttemptId === spawnAttemptId;
  }

  private async clearSpawnAttemptState(clearAttemptId = false): Promise<void> {
    const sid = this.resolveSessionId();
    if (sid) {
      doDb.updateSandboxState(this.sql, sid, {
        sandboxAuthTokenHash: null,
        // Clear the prior-generation grace tokens alongside the live hash: they were
        // minted for the sandbox being torn down, so they must not survive a sandbox
        // replacement and authenticate against the next sandbox.
        prevSandboxAuthTokenHashes: null,
        prevSandboxAuthTokenHash: null,
        prevSandboxAuthTokenExpiresAt: null,
        sandboxId: null,
        modalObjectId: null,
      });
      clearSpawnStarted({ sql: this.sql, sessionId: sid });
    }
    await this.state.storage.delete("spawn_cold_start");
    await this.state.storage.delete(CURRENT_SANDBOX_CREDENTIAL_ENV_KEYS_STORAGE_KEY);
    if (clearAttemptId) {
      // Terminal path: drop the attempt's durable workflow state + bootstrap
      // before forgetting which attempt it was.
      const spawnAttemptId = (await this.state.storage.get("spawnAttemptId")) as string | undefined;
      if (sid && spawnAttemptId) {
        await this.clearSpawnAttemptWorkflow(sid, spawnAttemptId);
      }
      await this.state.storage.delete("spawnAttemptId");
    }
  }

  private getSpawnConnectTimeoutMs(coldStart: boolean | undefined): number {
    return coldStart ? SPAWN_CONNECT_TIMEOUT_COLD_MS : SPAWN_CONNECT_TIMEOUT_MS;
  }

  private async scheduleSpawnConnectAlarm(): Promise<void> {
    const sid = this.resolveSessionId();
    if (sid) {
      const sandbox = doDb.getSandboxState(this.sql, sid);
      if (sandbox?.status === "spawning") {
        const coldStart = await this.state.storage.get<boolean>("spawn_cold_start");
        const startedAt = sandbox.spawnStartedAt ?? Date.now();
        await this.putOrDeleteLifecycleDeadline(
          LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
          startedAt + this.getSpawnConnectTimeoutMs(coldStart),
        );
      }
    }
    await this.rescheduleSessionAlarm();
  }

  private async schedulePromptExecutionAlarm(): Promise<void> {
    if (!this.getSandboxSocket()) {
      await this.scheduleSpawnConnectAlarm();
      return;
    }
    await this.rescheduleSessionAlarm();
  }

  private getPromptExecutionTimeoutMs(): number {
    return STALE_PROMPT_TIMEOUT_MS;
  }

  private getPromptMaxDurationMs(): number {
    return Math.max(PROMPT_MAX_DURATION_MS, this.getPromptExecutionTimeoutMs());
  }

  private async startSpawnAttempt(sessionId: string, operation: string): Promise<string> {
    const spawnAttemptId = crypto.randomUUID();
    const decisions = await this.processLifecycleEvent(
      sessionId,
      { type: "sandbox.spawn_requested", startupAttemptId: spawnAttemptId },
      { applyTerminal: true },
    );
    if (!decisions.some((decision) => decision.action === "spawn_sandbox")) {
      const sandboxStateRow = doDb.getSandboxState(this.sql, sessionId);
      const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
      this.log.warn(
        {
          event: "spawn_attempt_skipped",
          sessionId,
          operation,
          spawnAttemptId,
          activePromptId,
          decisions: decisions.map((d) => ({ action: d.action, reason: d.reason ?? null })),
          sandboxStatus: sandboxStateRow?.status ?? null,
          sandboxRuntimeState: sandboxStateRow?.runtimeState ?? null,
          sandboxStopReason: sandboxStateRow?.stopReason ?? null,
          sandboxRuntimeSandboxId: sandboxStateRow?.runtimeSandboxId ?? null,
        },
        "Lifecycle core skipped sandbox spawn",
      );
      await this.rescheduleSessionAlarm();
      return spawnAttemptId;
    }
    // A new attempt supersedes any prior one. Persist the new id FIRST so it is
    // the active stale-attempt fence, then drop the prior attempt's durable
    // workflow state so retries/respawns don't orphan it. (Clearing before the
    // put would leave the superseded attempt passing isCurrentSpawnAttempt
    // during the cleanup window.)
    const priorSpawnAttemptId = (await this.state.storage.get("spawnAttemptId")) as string | undefined;
    await this.state.storage.put("spawnAttemptId", spawnAttemptId);
    if (priorSpawnAttemptId && priorSpawnAttemptId !== spawnAttemptId) {
      await this.clearSpawnAttemptWorkflow(sessionId, priorSpawnAttemptId);
    }
    clearTransportMarkers({ sql: this.sql, sessionId });
    await this.state.storage.delete("spawn_cold_start");
    await this.putSandboxStatus(sessionId, "spawning");
    await this.scheduleSpawnConnectAlarm();
    const spawnPromise = this.runSpawnSandboxInSpan(sessionId, spawnAttemptId, operation).catch((err) => {
      if (err instanceof SpawnRetryAbortedError) {
        this.log.info({ sessionId, operation, spawnAttemptId, reason: err.reason }, "Spawn retry aborted");
        return;
      }
      return this.handleSpawnFailure(sessionId, operation, err, spawnAttemptId);
    });
    this.ctx.waitUntil(spawnPromise);
    return spawnAttemptId;
  }

  private async handleSpawnTimeout(
    sessionId: string,
    session: SessionState,
    prompts: PromptState[],
    activePrompt: PromptState,
    errorMessage: string,
    origin: SpawnTimeoutOrigin,
    spawnTimeoutMs?: number,
  ): Promise<void> {
    await this.promptQueue.handleSpawnTimeout(
      sessionId,
      session,
      prompts,
      activePrompt,
      errorMessage,
      origin,
      spawnTimeoutMs,
    );
  }

  private async handleSpawnFailure(
    sessionId: string,
    operation: string,
    err: unknown,
    spawnAttemptId?: string,
  ): Promise<void> {
    await this.promptQueue.handleSpawnFailure(sessionId, operation, err, spawnAttemptId);
  }

  async fetch(request: Request): Promise<Response> {
    return handleSessionFetch(this, request);
  }

  // ---------------------------------------------------------------------------
  // E2B runtime cleanup internal handlers
  // ---------------------------------------------------------------------------

  private async handleSessionIndexReproject(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;
    if (!this.env.DB) return jsonErrorResponse("D1 not configured", 503);

    const body = (await parseJsonBody(request)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Invalid payload", 400);

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return jsonErrorResponse("Session not found", 404);
    if (session.status === "archived") {
      return jsonResponse({ ok: false, drift: false, fields_changed: [], reason: "archived" }, 409);
    }

    const current = await this.env.DB.prepare(
      `SELECT rich_status,
              ui_lifecycle_stage,
              runtime_provider,
              runtime_backend,
              runtime_state,
              runtime_sandbox_id,
              runtime_template_id,
              runtime_state_expires_at,
              runtime_live_lease_expires_at,
              runtime_preview_url,
              runtime_created_at,
              runtime_last_resumed_at,
              runtime_last_paused_at,
              runtime_last_provider_refreshed_at,
              runtime_provider_ttl_expires_at
       FROM session_index
       WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<Record<string, unknown>>();
    if (!current) {
      return jsonResponse({ ok: false, drift: false, fields_changed: [], reason: "missing_row" }, 404);
    }

    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const runtimeState =
      sandbox && sandbox.runtimeProvider && sandbox.runtimeSandboxId
        ? this.buildRuntimeProjectionFromSandbox(sandbox)
        : CLEARED_RUNTIME_PROJECTION_STATE;
    const record = await getPrCoordination(this.env.DB, sessionId).catch(() => null);
    const fsmDisplay =
      record && (FSM_STATES as readonly string[]).includes(record.state)
        ? projectDisplayColumns(record as FsmRecord)
        : null;
    const richStatus = fsmDisplay?.richStatus ?? computeRichStatusForPublishProjection(this.sql, sessionId);
    const expected: Record<string, unknown> = {
      rich_status: richStatus,
      ...(fsmDisplay ? { ui_lifecycle_stage: fsmDisplay.uiLifecycleStage } : {}),
      runtime_provider: runtimeState.runtimeProvider ?? null,
      runtime_backend: runtimeState.runtimeBackend ?? null,
      runtime_state: runtimeState.runtimeState ?? null,
      runtime_sandbox_id: runtimeState.runtimeSandboxId ?? null,
      runtime_template_id: runtimeState.runtimeTemplateId ?? null,
      runtime_state_expires_at:
        runtimeState.runtimeState === "running" ? null : (runtimeState.runtimeStateExpiresAt ?? null),
      runtime_live_lease_expires_at: runtimeState.runtimeLiveLeaseExpiresAt ?? null,
      runtime_preview_url: runtimeState.runtimePreviewUrl ?? null,
      runtime_created_at: runtimeState.runtimeCreatedAt ?? null,
      runtime_last_resumed_at: runtimeState.runtimeLastResumedAt ?? null,
      runtime_last_paused_at: runtimeState.runtimeLastPausedAt ?? null,
      runtime_last_provider_refreshed_at: runtimeState.runtimeLastProviderRefreshedAt ?? null,
      runtime_provider_ttl_expires_at: runtimeState.runtimeProviderTtlExpiresAt ?? null,
    };
    const fieldsChanged = Object.keys(expected).filter((key) => current[key] !== expected[key]);
    if (fieldsChanged.length === 0) {
      return jsonResponse({ ok: true, drift: false, fields_changed: [] });
    }

    await syncSessionProjection({
      db: this.env.DB,
      reportEnv: this.env,
      sessionId,
      ...(fsmDisplay ? { fsmDisplay } : richStatus !== null ? { richStatus } : {}),
      runtimeState,
      source: "session-index-reconciler",
      logger: this.log,
    });

    return jsonResponse({ ok: true, drift: true, fields_changed: fieldsChanged });
  }

  private async handleSessionPhaseReap(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;

    const body = (await parseJsonBody(request)) as Partial<SessionPhaseReaperRequest> | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : this.resolveSessionId();
    const action = body?.action;
    const reason = body?.reason;
    const nowMs = typeof body?.nowMs === "number" && Number.isFinite(body.nowMs) ? body.nowMs : Date.now();
    if (
      !sessionId ||
      (action !== "archive" && action !== "exit_review_listening") ||
      (reason !== "runtime_killed" &&
        reason !== "runtime_missing_ttl" &&
        reason !== "live_lease_expired" &&
        reason !== "review_listening_ttl" &&
        reason !== "terminal_stale")
    ) {
      return jsonErrorResponse("Invalid payload", 400);
    }

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return jsonErrorResponse("Session not found", 404);
    if (session.status === "archived") {
      return jsonResponse({ ok: true, terminalized: false, action, reason: "already_archived" });
    }

    if (action === "archive") {
      const createdAtMs = Date.parse(session.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs - SESSION_AUTO_ARCHIVE_MIN_AGE_MS) {
        return jsonResponse({ ok: true, terminalized: false, action, reason: "session_too_young" });
      }
    }

    if (action === "exit_review_listening") {
      const ext = doDb.getSessionExtended(this.sql, sessionId);
      if (!ext?.reviewListeningActive) {
        return jsonResponse({ ok: true, terminalized: false, action, reason: "not_review_listening" });
      }
      await this.processLifecycleEvent(sessionId, { type: "review_listening.exited", reason: "max_monitoring_ttl" });
      return jsonResponse({ ok: true, terminalized: true, action, reason });
    }

    if (this.hasLiveRuntimeLease(sessionId, nowMs)) {
      return jsonResponse({ ok: true, terminalized: false, action, reason: "runtime_still_live" });
    }

    await this.closeSessionAtDurabilityBoundary(session, reason, {
      closeSource: "session_phase_reaper",
      reaperReason: reason,
    });
    return jsonResponse({ ok: true, terminalized: true, action, reason });
  }

  private async handlePrePublishStallFail(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;
    if (!this.env.DB) return jsonErrorResponse("D1 not configured", 503);

    const body = (await parseJsonBody(request)) as Partial<PrePublishStallFailRequest> | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : this.resolveSessionId();
    const nowMs = body?.nowMs;
    if (!sessionId || typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
      return jsonErrorResponse("Invalid payload", 400);
    }

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return jsonErrorResponse("Session not found", 404);
    if (session.status === "archived") {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "already_terminal",
      } satisfies PrePublishStallFailResponse);
    }

    const record = await getPrCoordination(this.env.DB, sessionId);
    const hardStallCutoff = nowMs - PRE_PUBLISH_STALL_BACKSTOP_MS;
    if (
      !record ||
      !(STALL_WATCH_STATES as readonly string[]).includes(record.state) ||
      record.stateEnteredAt == null ||
      record.stateEnteredAt <= 0 ||
      record.stateEnteredAt > hardStallCutoff
    ) {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "not_stalled",
      } satisfies PrePublishStallFailResponse);
    }

    if (doDb.getLatestSessionPlan(this.sql, sessionId)?.status === "pending") {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "plan_approval_pending",
      } satisfies PrePublishStallFailResponse);
    }
    if (this.hasLiveRuntimeLease(sessionId, nowMs)) {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "runtime_still_live",
      } satisfies PrePublishStallFailResponse);
    }
    if ((await this.getSandboxHeartbeatFreshness(nowMs)).fresh) {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "heartbeat_still_live",
      } satisfies PrePublishStallFailResponse);
    }
    const planApprovalPending = doDb.getLatestSessionPlan(this.sql, sessionId)?.status === "pending";
    if (planApprovalPending) {
      return jsonResponse({
        ok: true,
        terminalized: false,
        reason: "plan_approval_pending",
      } satisfies PrePublishStallFailResponse);
    }

    // `completeActivePrompt` normally promotes the next queued prompt. This is
    // a session-level terminal, so settle queued work first; otherwise the
    // active-prompt terminal below could start a fresh sandbox underneath the
    // FSM's FAILED state.
    const terminalAt = new Date(nowMs).toISOString();
    this.promptQueue.failQueuedPrompts(sessionId, STALE_PROMPT_USER_MESSAGE, terminalAt);

    await this.processLifecycleEvent(
      sessionId,
      { type: "boundary.pre_publish_stall_expired" },
      { applyTerminal: true, suppressFsmTransport: true },
    );
    const fire = await shadowFireDueDeadline(
      this.env,
      sessionId,
      nowMs,
      this.log,
      undefined,
      (promise) => this.ctx.waitUntil(promise),
      planApprovalPending,
    );
    if (!fire.wouldFire || fire.to !== "FAILED") {
      throw new Error(`Pre-publish stall deadline did not transition to FAILED (${record.state})`);
    }

    return jsonResponse({ ok: true, terminalized: true, reason: "stalled" } satisfies PrePublishStallFailResponse);
  }

  private async handleSessionOffboardingPurge(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;

    const body = (await parseJsonBody(request)) as Partial<SessionOffboardingPurgeRequest> | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Invalid payload", 400);

    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const runtimeSandboxId = sandbox?.runtimeSandboxId ?? null;
    let runtimeTerminateStatus: string | null = null;
    if (runtimeSandboxId && isKnownRuntimeProvider(sandbox?.runtimeProvider)) {
      const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
      try {
        const result = await this.buildCleanupClient(runtimeBackend).terminateSandbox(
          runtimeSandboxId,
          "business_offboarding",
        );
        runtimeTerminateStatus = result.status;
      } catch (err) {
        // A non-missing E2B failure (network, auth, outage) must not abort the rest of
        // the purge -- socket close, alarm, storage, and SQLite cleanup still need to run.
        runtimeTerminateStatus = "error";
        this.log.error(
          { sessionId, runtimeSandboxId, error: serializeError(err) },
          "Offboarding sandbox terminate failed; continuing purge",
        );
      }
    }

    this.closeSandboxSockets("Business offboarding");
    const session = doDb.getSession(this.sql, sessionId);
    try {
      await cleanupSessionNeonBranch(this.env.DB, {
        storage: this.state.storage,
        businessId: session?.businessId ?? null,
        sessionId,
        encryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
        logger: this.log,
      });
    } catch (err) {
      this.log.warn(
        { sessionId, error: serializeError(err) },
        "Failed to clean up Neon session branch during offboarding purge",
      );
    }
    await this.state.storage.deleteAlarm();
    const storageKeys = [...(await this.state.storage.list()).keys()];
    // DO storage.delete accepts at most 128 keys per call; chunk to stay under the cap.
    for (let index = 0; index < storageKeys.length; index += 128) {
      await this.state.storage.delete(storageKeys.slice(index, index + 128));
    }
    const sqliteTablesCleared = this.clearDoSqliteTables();

    return jsonResponse({
      ok: true,
      sessionId,
      runtimeSandboxId,
      runtimeTerminateStatus,
      socketsClosed: true,
      alarmDeleted: true,
      sqliteTablesCleared,
    } satisfies SessionOffboardingPurgeResponse);
  }

  private clearDoSqliteTables(): string[] {
    const rows = this.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .toArray() as Array<{ name: string }>;
    // Cloudflare-internal tables (KV backing store `_cf_KV`/`__cf_kv`, `_cf_METADATA`) surface in
    // sqlite_master but reject a direct DELETE, which would throw and abort the purge. They are all
    // underscore-prefixed, so require a leading letter to keep only app tables.
    const tableNames = rows.map((row) => row.name).filter((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name));
    for (const tableName of tableNames) {
      this.sql.exec(`DELETE FROM "${tableName}"`);
    }
    return tableNames;
  }

  private hasLiveRuntimeLease(sessionId: string, nowMs: number): boolean {
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    return Boolean(
      sandbox?.runtimeState === "running" &&
      sandbox.runtimeSandboxId &&
      sandbox.runtimeLiveLeaseExpiresAt != null &&
      sandbox.runtimeLiveLeaseExpiresAt > nowMs,
    );
  }

  private validateCleanupAuth(request: Request): Response | null {
    const secret = this.env.SANDBOX_RUNTIME_CLEANUP_SECRET;
    if (!secret) return jsonErrorResponse("Cleanup secret not configured", 503);
    const token = parseBearerToken(request);
    if (!token) return jsonErrorResponse("Missing authorization", 401);
    if (!timingSafeEqualString(token, secret)) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
    return null;
  }

  /**
   * Live cleanup decision for a candidate sandbox. Pure read of current
   * `sandbox_state` (with a lease-refresh side effect on observed live
   * activity); never memoized, because it gates whether the rest of the
   * workflow runs and must reflect the newest runtime on every entry.
   */
  private computeE2BCleanupDecision(
    sessionId: string,
    projectedRuntimeSandboxId: string,
    projectedRuntimeBackend: RuntimeBackend,
    nowMs: number,
    requestReason: E2BRuntimeCleanupReason,
  ): E2BCleanupDecision {
    // R4: the FINAL-terminal reclaim is the ONLY reason-aware branch. Every other reason keeps its
    // byte-identical live re-decide — the ownership guards below (not_e2b / sandbox_changed /
    // backend_changed) fence all reasons the same way, so only the running/paused arms differ.
    const isSessionTerminal = requestReason === "session_terminal";
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    // "not_e2b" is retained as the wire/telemetry literal (asserted by the reason
    // union, internal-routes `skipped_not_e2b`, and tests); it now means "no managed
    // runtime for ANY known provider" — the guard admits every isKnownRuntimeProvider.
    if (!sandbox || !isKnownRuntimeProvider(sandbox.runtimeProvider)) {
      return { action: "skip", reason: "not_e2b" };
    }

    // Sandbox ID changed since the projection was read — a newer runtime owns
    // the row now; never touch it.
    if (sandbox.runtimeSandboxId !== projectedRuntimeSandboxId) {
      return { action: "skip", reason: "sandbox_changed" };
    }

    const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
    if (runtimeBackend !== projectedRuntimeBackend) {
      return { action: "skip", reason: "backend_changed" };
    }

    // Running sandbox — check for live activity before allowing pause/termination
    if (sandbox.runtimeState === "running") {
      const hasActivePrompt = Boolean(doDb.getActiveProcessingPromptId(this.sql, sessionId));
      const hasPendingDispatch = sandbox.pendingPromptDispatch;

      // R4 session_terminal: the session reached a FINAL terminal — reclaim the live VM immediately.
      // NEVER yank an in-flight turn: a SUPERSEDED follow-up prompt still processing or queued
      // (`pendingPromptDispatch`) defers to the normal idle/lease/72h paths below (skipped_live_activity).
      // This skip returns PLAIN — unlike the idle path it does NOT refresh the live lease: a terminal
      // session's VM must not have its retention extended.
      if (isSessionTerminal) {
        if (hasActivePrompt || hasPendingDispatch) {
          return { action: "skip", reason: "live_activity_observed" };
        }
        return {
          action: "terminate",
          runtimeSandboxId: sandbox.runtimeSandboxId!,
          runtimeBackend,
          runtimeState: "running",
        };
      }

      // Check canonical DO heartbeat/activity fields for freshness
      const liveLeaseMs = getE2BRuntimeLiveLeaseMs(this.env);
      const activityFresh = sandbox.lastActivityAt != null && nowMs - sandbox.lastActivityAt < liveLeaseMs;
      const promptActivityFresh =
        sandbox.promptLastActivityAt != null && nowMs - sandbox.promptLastActivityAt < liveLeaseMs;

      if (hasActivePrompt || hasPendingDispatch || activityFresh || promptActivityFresh) {
        // Refresh the live lease and sync projection
        const newLeaseExpiry = nowMs + liveLeaseMs;
        applyRuntimePatch({ sql: this.sql, sessionId, patch: { runtimeLiveLeaseExpiresAt: newLeaseExpiry } });
        this.ctx.waitUntil(
          syncRuntimeProjection(this.env, sessionId, {
            ...this.buildRuntimeProjectionFromSandbox(sandbox),
            runtimeLiveLeaseExpiresAt: newLeaseExpiry,
          }),
        );
        return { action: "skip", reason: "live_activity_observed" };
      }

      // Stale running sandbox — check the live lease is actually expired
      if (sandbox.runtimeLiveLeaseExpiresAt != null && sandbox.runtimeLiveLeaseExpiresAt >= nowMs) {
        return { action: "skip", reason: "not_expired" };
      }

      return { action: "pause", runtimeSandboxId: sandbox.runtimeSandboxId!, runtimeBackend };
    }

    // Paused sandbox — check expiry
    if (sandbox.runtimeState === "paused") {
      // R4 session_terminal terminates a paused VM regardless of the 72h retention window (the whole
      // point of the reclaim is to not wait it out). Every other reason keeps the not_expired gate.
      if (!isSessionTerminal && sandbox.runtimeStateExpiresAt != null && sandbox.runtimeStateExpiresAt >= nowMs) {
        return { action: "skip", reason: "not_expired" };
      }

      return {
        action: "terminate",
        runtimeSandboxId: sandbox.runtimeSandboxId!,
        runtimeBackend,
        runtimeState: "paused",
      };
    }

    // Malformed or unknown state — terminate if we have a sandbox ID
    if (sandbox.runtimeSandboxId) {
      return {
        action: "terminate",
        runtimeSandboxId: sandbox.runtimeSandboxId,
        runtimeBackend,
        runtimeState: (sandbox.runtimeState as "paused" | "running") ?? "paused",
      };
    }

    return { action: "skip", reason: "not_e2b" };
  }

  /**
   * ARC-1054: single internal endpoint that runs the whole E2B runtime cleanup
   * as a checkpointed, self-retrying workflow inside the runtime owner. Replaces
   * the prior worker-orchestrated decide -> terminate -> clear round-trips.
   */
  private async handleE2BCleanupRun(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;

    const body = (await parseJsonBody(request)) as Partial<E2BRuntimeCleanupRunRequest> | null;
    if (
      !body?.sessionId ||
      !body.projectedRuntimeSandboxId ||
      !body.projectedRuntimeBackend ||
      !body.reason ||
      !body.nowMs
    ) {
      return jsonErrorResponse("Invalid payload", 400);
    }

    let projectedRuntimeBackend: RuntimeBackend;
    try {
      projectedRuntimeBackend = parsePersistedRuntimeBackend(body.projectedRuntimeBackend);
    } catch {
      return jsonErrorResponse("Invalid runtime backend", 400);
    }

    const result = await this.runE2BCleanupWorkflow({
      sessionId: body.sessionId,
      runtimeSandboxId: body.projectedRuntimeSandboxId,
      runtimeBackend: projectedRuntimeBackend,
      reason: body.reason,
      nowMs: body.nowMs,
    });

    return jsonResponse({
      ok: true,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      runtimeSandboxId: result.runtimeSandboxId,
    } satisfies E2BRuntimeCleanupRunResponse);
  }

  /**
   * Orphan-reaper owner guard. The reaper found an E2B sandbox with NO D1
   * reference (session_index) that carries `metadata.session_id`.
   * Before the reaper terminates it, this endpoint asks the owning Session DO —
   * the source of truth for `sandbox_state` + active-prompt state — whether the
   * VM is still owned by a live session. Ownership, NOT a liveness probe, is the
   * discriminator (a probe reports `running` for both a true orphan and a
   * wrongly-unreferenced live VM). Fails CLOSED: any owned/ambiguous candidate
   * defers (never terminates).
   */
  private async handleE2BOwnerGuard(request: Request): Promise<Response> {
    const authErr = this.validateCleanupAuth(request);
    if (authErr) return authErr;

    const body = (await parseJsonBody(request)) as Partial<E2BOrphanGuardRequest> | null;
    if (
      !body?.sessionId ||
      !body.runtimeSandboxId ||
      !body.runtimeBackend ||
      typeof body.sweepStartedAtMs !== "number" ||
      !Number.isFinite(body.sweepStartedAtMs)
    ) {
      return jsonErrorResponse("Invalid payload", 400);
    }

    let runtimeBackend: RuntimeBackend;
    try {
      runtimeBackend = parsePersistedRuntimeBackend(body.runtimeBackend);
    } catch {
      return jsonErrorResponse("Invalid runtime backend", 400);
    }

    // Unrecognized values fall back to undefined, which leaves the guard on its
    // pure-bookkeeping decision (a malformed status must never relax the gate).
    const candidateE2bStatus = parseCandidateE2bStatus(body.candidateE2bStatus);

    const result = await this.runE2BOwnerGuard({
      sessionId: body.sessionId,
      runtimeSandboxId: body.runtimeSandboxId,
      runtimeBackend,
      sweepStartedAtMs: body.sweepStartedAtMs,
      candidateE2bStatus,
    });

    this.logE2BOwnerGuardOutcome({
      sessionId: body.sessionId,
      runtimeSandboxId: body.runtimeSandboxId,
      runtimeBackend,
      result,
    });

    return jsonResponse({
      ok: true,
      decision: result.decision,
      reasonCode: result.reasonCode,
      runtimeReadUnavailableKind: result.runtimeReadUnavailableKind ?? null,
      runtimeReadUnavailableSweeps: result.runtimeReadUnavailableSweeps ?? null,
    } satisfies E2BOrphanGuardResponse);
  }

  /**
   * Decides protect | terminate | defer for an unreferenced candidate that
   * claims to belong to this session. All reads are synchronous SQLite reads, so
   * the decision is computed atomically under the DO input gate; the only
   * external I/O (the reconcile projection write) happens after a final CAS
   * re-read in `protectAndReconcileOwnedRuntime`.
   */
  private async runE2BOwnerGuard(params: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    sweepStartedAtMs: number;
    candidateE2bStatus?: E2BCandidateRuntimeStatus;
  }): Promise<E2BOwnerGuardResult> {
    const { sessionId, runtimeSandboxId, runtimeBackend, sweepStartedAtMs, candidateE2bStatus } = params;

    let session: ReturnType<typeof doDb.getSession> | null;
    try {
      session = doDb.getSession(this.sql, sessionId);
    } catch {
      session = null;
    }
    if (!session) {
      return await this.applyReaperRuntimeReadUnavailableDebounce({
        runtimeSandboxId,
        sweepStartedAtMs,
        kind: "session",
        afterDebounce: () => ({ decision: "terminate", reasonCode: "terminate_no_session" }),
      });
    }
    // Archived owner: terminal session, the runtime is genuinely done. Checked
    // BEFORE the liveness-gated branches so a terminal session's VM is always
    // terminated (`terminate_terminal`) and never protected/deferred by the gate
    // — e.g. an archived session whose sandbox row was cleared or marked killed.
    // NOT gated.
    if (session.status === "archived") {
      await this.clearReaperRuntimeReadUnavailableSweeps(runtimeSandboxId);
      return { decision: "terminate", reasonCode: "terminate_terminal" };
    }

    let sandbox: ReturnType<typeof doDb.getSandboxState> | null;
    try {
      sandbox = doDb.getSandboxState(this.sql, sessionId);
    } catch {
      sandbox = null;
    }
    // The DO cannot prove ownership from a null/cleared sandbox_state runtime
    // read. W11-B2 fails closed for one bad read, then after K distinct sweeps
    // treats persistently-null bookkeeping as reclaimable even when the
    // candidate is physically running with a fresh heartbeat; otherwise true
    // leftovers leak forever.
    if (!sandbox || !isKnownRuntimeProvider(sandbox.runtimeProvider) || !sandbox.runtimeSandboxId) {
      return await this.applyReaperRuntimeReadUnavailableDebounce({
        runtimeSandboxId,
        sweepStartedAtMs,
        kind: "sandbox_runtime",
        afterDebounce: () => ({ decision: "terminate", reasonCode: "terminate_unreferenced" }),
      });
    }
    const sandboxRuntimeBackend = this.readPersistedRuntimeBackendOrNull(sessionId);
    if (!sandboxRuntimeBackend) {
      return await this.applyReaperRuntimeReadUnavailableDebounce({
        runtimeSandboxId,
        sweepStartedAtMs,
        kind: "sandbox_backend",
        afterDebounce: () => ({ decision: "terminate", reasonCode: "terminate_unreferenced" }),
      });
    }
    await this.clearReaperRuntimeReadUnavailableSweeps(runtimeSandboxId);
    // A newer runtime owns the row now; the candidate is a stale leftover. NOT
    // gated — this is genuinely not the DO's current runtime.
    if (sandbox.runtimeSandboxId !== runtimeSandboxId) {
      return { decision: "terminate", reasonCode: "terminate_superseded" };
    }
    if (sandboxRuntimeBackend !== runtimeBackend) {
      return { decision: "terminate", reasonCode: "terminate_superseded" };
    }
    // The DO marked this runtime dead (e.g. markRuntimeKilled after a transient
    // disconnect — even when the VM is physically alive and still building).
    // ARC-1248: this is the observed churn vector, so gate on physical liveness
    // before honoring the kill.
    if (sandbox.runtimeState === "killed") {
      return await this.applyReaperLivenessGate({
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        candidateE2bStatus,
        hasOwnedRow: true,
        // Disowned (DO marked the runtime killed): a paused such VM is reclaimable.
        reclaimPaused: true,
        bookkeepingReasonCode: "terminate_killed",
        bookkeeping: () => ({ decision: "terminate", reasonCode: "terminate_killed" }),
        protectLive: () => ({ decision: "protect", reasonCode: "protected_owned" }),
      });
    }
    if (sandbox.runtimeState !== "running") {
      // Paused/unknown owned runtime: the reaper must not kill it (cleanup owns
      // paused-expiry termination), but a bare defer would leak it. cleanup
      // discovers candidates via `session_index`, and this candidate is here
      // precisely because it has no `session_index` reference — so without
      // reconciling, it is deferred every sweep and never expired. Reconcile the
      // paused runtime back into `session_index` from authoritative DO state so
      // cleanup can find and expire it, then defer this sweep. NOT gated.
      if (this.env.DB) {
        await syncRuntimeProjectionChecked(this.env, sessionId, this.buildRuntimeProjectionFromSandbox(sandbox), {
          logger: this.log,
        });
      }
      return { decision: "defer", reasonCode: "defer_reconciled" };
    }
    // The DO's sandbox_state still points at this exact running VM. ARC-1248: gate
    // before protecting so a desync'd zombie (E2B-running, bridge dead) is not
    // reprojected as healthy. A proven-live VM takes the existing protect-and-
    // reconcile path (reprojects from authoritative running state).
    return await this.applyReaperLivenessGate({
      sessionId,
      runtimeSandboxId,
      runtimeBackend,
      candidateE2bStatus,
      hasOwnedRow: true,
      // Owned current runtime: a `paused` reading is E2B idle-pausing it out of
      // band (the DO still believes it is running). It is warm-resumable and
      // cleanup/retention owns idle expiry — protect it, do not reap.
      reclaimPaused: false,
      bookkeepingReasonCode: "protected_owned",
      bookkeeping: () => this.protectAndReconcileOwnedRuntime(sessionId, runtimeSandboxId, runtimeBackend),
      protectLive: () => this.protectAndReconcileOwnedRuntime(sessionId, runtimeSandboxId, runtimeBackend),
    });
  }

  private async applyReaperRuntimeReadUnavailableDebounce(args: {
    runtimeSandboxId: string;
    sweepStartedAtMs: number;
    kind: E2BOrphanGuardRuntimeReadUnavailableKind;
    afterDebounce: () => Promise<E2BOwnerGuardResult> | E2BOwnerGuardResult;
  }): Promise<E2BOwnerGuardResult> {
    const previous = await this.readReaperRuntimeReadUnavailableSweeps(args.runtimeSandboxId, args.kind);
    const sameSweep = previous.lastSweepStartedAtMs === args.sweepStartedAtMs;
    const sweeps = sameSweep ? previous.count : previous.count + 1;
    if (sweeps >= SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS) {
      await this.clearReaperRuntimeReadUnavailableSweeps(args.runtimeSandboxId, args.kind);
      const result = await args.afterDebounce();
      return {
        ...result,
        runtimeReadUnavailableKind: args.kind,
        runtimeReadUnavailableSweeps: sweeps,
      };
    }

    if (!sameSweep || previous.count === 0) {
      await this.writeReaperRuntimeReadUnavailableSweeps(args.runtimeSandboxId, args.kind, {
        count: sweeps,
        lastSweepStartedAtMs: args.sweepStartedAtMs,
      });
    }
    return {
      decision: "defer",
      reasonCode: "defer_runtime_read_unavailable",
      runtimeReadUnavailableKind: args.kind,
      runtimeReadUnavailableSweeps: sweeps,
    };
  }

  /**
   * ARC-1248 proof-of-life gate, applied to branches that decide the DO's own
   * current/last readable runtime (`protected_owned`, `terminate_killed`).
   * Combines the physical E2B status the reaper already
   * observed with the bridge heartbeat:
   *
   * | physical | heartbeat        | decision                                |
   * |----------|------------------|-----------------------------------------|
   * | running  | fresh/future-skew| protect (reproject on owned-running)    |
   * | running  | stale/missing    | defer; reclaim after K stale sweeps     |
   * | paused   | reclaimPaused    | terminate (disowned; not in use)        |
   * | paused   | !reclaimPaused   | protect (owned, E2B idle-paused; warm)  |
   * | unknown  | any              | fall through to bookkeeping             |
   *
   * Fails safe toward NOT killing: we only terminate on positive evidence the VM
   * is not in use (a disowned `paused` VM, or a debounced zombie) — never on a
   * bare absent beat, and never on an owned runtime E2B merely idle-paused.
   */
  private async applyReaperLivenessGate(args: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    candidateE2bStatus: E2BCandidateRuntimeStatus | undefined;
    hasOwnedRow: boolean;
    // Whether a physically-`paused` candidate may be reclaimed. True only on the
    // disowned branch (`terminate_killed`); false on
    // the owned-running branch, where a `paused` reading is E2B idle-pausing the
    // DO's own runtime out of band — it is warm-resumable, so destroying it would
    // force a needless cold resume.
    reclaimPaused: boolean;
    bookkeepingReasonCode: E2BOrphanGuardReasonCode;
    bookkeeping: () => Promise<E2BOwnerGuardResult> | E2BOwnerGuardResult;
    protectLive: () => Promise<E2BOwnerGuardResult> | E2BOwnerGuardResult;
  }): Promise<E2BOwnerGuardResult> {
    const { sessionId, runtimeSandboxId, runtimeBackend, candidateE2bStatus, hasOwnedRow, reclaimPaused } = args;
    const bookkeepingReasonCode = args.bookkeepingReasonCode;
    const bookkeepingWouldTerminate = bookkeepingReasonCode.startsWith("terminate");

    // Kill switch off, or a flaky listing (`unknown`/absent status): stay on the
    // pure-bookkeeping decision. A flaky listing must not change behavior.
    if (!isE2BOrphanReaperLivenessGuardEnabled(this.env) || !candidateE2bStatus || candidateE2bStatus === "unknown") {
      const base = await args.bookkeeping();
      return { ...base, candidateE2bStatus, bookkeepingReasonCode, preventedReap: false };
    }

    if (candidateE2bStatus === "paused") {
      if (!reclaimPaused) {
        // Owned current runtime that E2B idle-paused out of band (the DO still
        // believes it is running). Not the reaper's to destroy — it is warm-
        // resumable and cleanup/retention owns idle expiry. Protect (the pre-
        // ARC-1248 behavior of the owned-running branch).
        await this.clearReaperZombieSweeps(runtimeSandboxId);
        const protectRes = await args.protectLive();
        return {
          ...protectRes,
          candidateE2bStatus,
          bookkeepingReasonCode,
          preventedReap: bookkeepingWouldTerminate && protectRes.decision !== "terminate",
        };
      }
      // Disowned, unreferenced, aged, paused VM: not in active use — reclaim it
      // (the leak fix) with the ARC-1196 teardown.
      await this.clearReaperZombieSweeps(runtimeSandboxId);
      const term = await this.terminateViaReaperLivenessGate({
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        reasonCode: "terminate_paused_unreferenced",
        hasOwnedRow,
      });
      return { ...term, candidateE2bStatus, bookkeepingReasonCode, preventedReap: false };
    }

    // Physically running: prove liveness from the bridge heartbeat. Signed
    // comparison (NOT the Math.abs `fresh` flag): a future-skewed clock counts as
    // alive (protect), never killed; only a real gap past the reaper bound — or a
    // missing beat — is stale.
    const heartbeat = await this.getSandboxHeartbeatFreshness();
    const stale =
      heartbeat.lastHeartbeatAt === null ||
      (heartbeat.ageMs !== null && heartbeat.ageMs > SANDBOX_REAPER_LIVENESS_STALE_MS);

    if (!stale) {
      // Proven alive — never reap. Reset this runtime's zombie debounce.
      await this.clearReaperZombieSweeps(runtimeSandboxId);
      const protectRes = await args.protectLive();
      return {
        ...protectRes,
        candidateE2bStatus,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        heartbeatAgeMs: heartbeat.ageMs,
        staleSweeps: 0,
        bookkeepingReasonCode,
        preventedReap: bookkeepingWouldTerminate && protectRes.decision !== "terminate",
      };
    }

    // Running but heartbeat stale: ambiguous (a live WS-dropped builder vs. a true
    // zombie). Debounce PER RUNTIME — reclaim only after K consecutive running+stale
    // sweeps. Crucially do NOT reproject: the candidate must stay unreferenced so the
    // next sweep re-evaluates it (and the debounce advances). A live builder re-beats
    // and resets; a true zombie never does.
    const staleSweeps = (await this.readReaperZombieSweeps(runtimeSandboxId)) + 1;
    if (staleSweeps >= SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS) {
      // Reclaim. clearReaperZombieSweeps drops this runtime's counter entry, so we
      // never durably write the threshold value we are about to discard.
      await this.clearReaperZombieSweeps(runtimeSandboxId);
      const term = await this.terminateViaReaperLivenessGate({
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        reasonCode: "terminate_zombie_confirmed",
        hasOwnedRow,
      });
      return {
        ...term,
        candidateE2bStatus,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        heartbeatAgeMs: heartbeat.ageMs,
        staleSweeps,
        bookkeepingReasonCode,
        preventedReap: false,
      };
    }
    await this.writeReaperZombieSweeps(runtimeSandboxId, staleSweeps);
    return {
      decision: "defer",
      reasonCode: "defer_unproven_liveness",
      candidateE2bStatus,
      lastHeartbeatAt: heartbeat.lastHeartbeatAt,
      heartbeatAgeMs: heartbeat.ageMs,
      staleSweeps,
      bookkeepingReasonCode,
      preventedReap: bookkeepingWouldTerminate,
    };
  }

  /**
   * Terminate decision from the liveness gate (a paused or debounced-zombie row).
   * Mirrors the ARC-1196 discipline: a synchronous CAS re-read confirms the DO
   * still points at this exact runtime (id/backend/provider — NOT state, since the
   * killed branch is legitimately non-running) before tearing down the transport
   * as `reaped` (cold-resumable, so a false positive self-heals on the next
   * prompt). On terminate the guard does NOT reproject into `session_index`.
   */
  private async terminateViaReaperLivenessGate(args: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    reasonCode: E2BOrphanGuardReasonCode;
    hasOwnedRow: boolean;
  }): Promise<{ decision: E2BOrphanGuardDecision; reasonCode: E2BOrphanGuardReasonCode }> {
    const { sessionId, runtimeSandboxId, runtimeBackend, reasonCode, hasOwnedRow } = args;
    if (hasOwnedRow) {
      const fresh = doDb.getSandboxState(this.sql, sessionId);
      const freshRuntimeBackend = fresh ? this.readPersistedRuntimeBackendOrNull(sessionId) : null;
      if (
        !fresh ||
        !isKnownRuntimeProvider(fresh.runtimeProvider) ||
        fresh.runtimeSandboxId !== runtimeSandboxId ||
        // The full row we just read already carries the backend; parse it the
        // same way readPersistedRuntimeBackend would (null/empty -> cloud) instead
        // of issuing a second SELECT against the same row.
        freshRuntimeBackend !== runtimeBackend
      ) {
        // State moved under us — including an invalid backend after the initial
        // validated read. Re-evaluate next sweep instead of killing.
        return { decision: "defer", reasonCode: "defer_state_changed" };
      }
      await this.discardStaleSandboxTransport(sessionId, "reaper_liveness_guard");
    }
    return { decision: "terminate", reasonCode };
  }

  /**
   * Per-runtime reaper debounce counters. One DO-storage record backs both the
   * ARC-1248 zombie-reclaim debounce and W11-B2 null-read debounce, keyed per
   * runtime so multiple leftovers of the SAME session advance independently.
   */
  private reaperSweepCounterEntries(stored: unknown): Record<string, ReaperSweepCounterEntry> {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const record = stored as Record<string, unknown>;
    // Migrate the prior single-slot shape `{ runtimeSandboxId, count }`.
    if (typeof record.runtimeSandboxId === "string" && typeof record.count === "number") {
      return Number.isFinite(record.count) ? { [record.runtimeSandboxId]: record.count } : {};
    }
    const counts: Record<string, ReaperSweepCounterEntry> = {};
    for (const [id, value] of Object.entries(record)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        counts[id] = value;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entry = value as Record<string, unknown>;
        if (typeof entry.count === "number" && Number.isFinite(entry.count)) {
          counts[id] = {
            count: entry.count,
            lastSweepStartedAtMs:
              typeof entry.lastSweepStartedAtMs === "number" && Number.isFinite(entry.lastSweepStartedAtMs)
                ? entry.lastSweepStartedAtMs
                : null,
          };
        }
      }
    }
    return counts;
  }

  private reaperSweepCounterCount(entry: ReaperSweepCounterEntry | undefined): number {
    if (entry === undefined) return 0;
    return typeof entry === "number" ? entry : entry.count;
  }

  private async readReaperSweepCounter(key: string): Promise<ReaperSweepCounterEntry | undefined> {
    const counts = this.reaperSweepCounterEntries(
      await this.state.storage.get(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY),
    );
    return counts[key];
  }

  private async writeReaperSweepCounter(key: string, entry: ReaperSweepCounterEntry): Promise<void> {
    const counts = this.reaperSweepCounterEntries(
      await this.state.storage.get(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY),
    );
    counts[key] = entry;
    const ids = Object.keys(counts);
    if (ids.length > SANDBOX_REAPER_ZOMBIE_SWEEP_MAX_RUNTIMES) {
      // Over cap: keep the entries closest to reclaim (highest counts); a dropped
      // entry simply restarts from 1 on its next matching sweep (fail-safe).
      const kept = ids
        .sort((a, b) => this.reaperSweepCounterCount(counts[b]) - this.reaperSweepCounterCount(counts[a]))
        .slice(0, SANDBOX_REAPER_ZOMBIE_SWEEP_MAX_RUNTIMES);
      const pruned: Record<string, ReaperSweepCounterEntry> = {};
      for (const id of kept) pruned[id] = counts[id];
      await this.state.storage.put(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY, pruned);
      return;
    }
    await this.state.storage.put(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY, counts);
  }

  private async clearReaperSweepCounter(key: string): Promise<void> {
    const counts = this.reaperSweepCounterEntries(
      await this.state.storage.get(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY),
    );
    if (!(key in counts)) return; // nothing tracked for this runtime — no durable write
    delete counts[key];
    if (Object.keys(counts).length === 0) {
      await this.state.storage.delete(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY);
    } else {
      await this.state.storage.put(LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY, counts);
    }
  }

  private async readReaperZombieSweeps(runtimeSandboxId: string): Promise<number> {
    return this.reaperSweepCounterCount(await this.readReaperSweepCounter(runtimeSandboxId));
  }

  private async writeReaperZombieSweeps(runtimeSandboxId: string, count: number): Promise<void> {
    await this.writeReaperSweepCounter(runtimeSandboxId, count);
  }

  private async clearReaperZombieSweeps(runtimeSandboxId: string): Promise<void> {
    await this.clearReaperSweepCounter(runtimeSandboxId);
  }

  private runtimeReadUnavailableCounterKey(
    runtimeSandboxId: string,
    kind: E2BOrphanGuardRuntimeReadUnavailableKind,
  ): string {
    return `runtime-read-unavailable:${kind}:${runtimeSandboxId}`;
  }

  private async readReaperRuntimeReadUnavailableSweeps(
    runtimeSandboxId: string,
    kind: E2BOrphanGuardRuntimeReadUnavailableKind,
  ): Promise<{ count: number; lastSweepStartedAtMs: number | null }> {
    const entry = await this.readReaperSweepCounter(this.runtimeReadUnavailableCounterKey(runtimeSandboxId, kind));
    if (!entry) return { count: 0, lastSweepStartedAtMs: null };
    if (typeof entry === "number") return { count: entry, lastSweepStartedAtMs: null };
    return entry;
  }

  private async writeReaperRuntimeReadUnavailableSweeps(
    runtimeSandboxId: string,
    kind: E2BOrphanGuardRuntimeReadUnavailableKind,
    entry: { count: number; lastSweepStartedAtMs: number },
  ): Promise<void> {
    await this.writeReaperSweepCounter(this.runtimeReadUnavailableCounterKey(runtimeSandboxId, kind), entry);
  }

  private async clearReaperRuntimeReadUnavailableSweeps(
    runtimeSandboxId: string,
    kind?: E2BOrphanGuardRuntimeReadUnavailableKind,
  ): Promise<void> {
    if (kind) {
      await this.clearReaperSweepCounter(this.runtimeReadUnavailableCounterKey(runtimeSandboxId, kind));
      return;
    }
    for (const unavailableKind of RUNTIME_READ_UNAVAILABLE_KINDS) {
      await this.clearReaperSweepCounter(this.runtimeReadUnavailableCounterKey(runtimeSandboxId, unavailableKind));
    }
  }

  /**
   * Protect path with CAS-before-write. Re-reads `sandbox_state` synchronously
   * immediately before the reconcile projection write (the input gate holds
   * across the synchronous decision but NOT across the write's await), so a
   * racing `markRuntimeKilled` / newer attach that landed between the initial
   * decision and here cannot have the stale id resurrected into session_index.
   */
  private async protectAndReconcileOwnedRuntime(
    sessionId: string,
    runtimeSandboxId: string,
    runtimeBackend: RuntimeBackend,
  ): Promise<{ decision: E2BOrphanGuardDecision; reasonCode: E2BOrphanGuardReasonCode }> {
    const fresh = doDb.getSandboxState(this.sql, sessionId);
    const freshRuntimeBackend = fresh ? this.readPersistedRuntimeBackendOrNull(sessionId) : null;
    if (
      !fresh ||
      !isKnownRuntimeProvider(fresh.runtimeProvider) ||
      fresh.runtimeSandboxId !== runtimeSandboxId ||
      fresh.runtimeState !== "running" ||
      freshRuntimeBackend !== runtimeBackend
    ) {
      // State moved under us — do not resurrect a stale id or clobber a newer
      // projection. Defer to the next sweep, which re-evaluates with fresh data.
      return { decision: "defer", reasonCode: "defer_state_changed" };
    }
    // Reconcile session_index from authoritative DO state, closing the desync
    // that made this live VM unreferenced. Checked variant: retries the missing
    // row and never throws (a thrown reconcile must not flip protect to fail).
    if (this.env.DB) {
      await syncRuntimeProjectionChecked(this.env, sessionId, this.buildRuntimeProjectionFromSandbox(fresh), {
        logger: this.log,
      });
    }
    return { decision: "protect", reasonCode: "protected_owned" };
  }

  private logE2BOwnerGuardOutcome(fields: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    result: E2BOwnerGuardResult;
  }): void {
    const { result } = fields;
    const payload = {
      event: "sandbox.runtime.owner_guard",
      session_id: fields.sessionId,
      runtime_sandbox_id: fields.runtimeSandboxId,
      runtime_backend: fields.runtimeBackend,
      decision: result.decision,
      reason_code: result.reasonCode,
      // ARC-1248 liveness-guard observability (null when the gate did not run).
      candidate_e2b_status: result.candidateE2bStatus ?? null,
      last_heartbeat_at: result.lastHeartbeatAt ?? null,
      heartbeat_age_ms: result.heartbeatAgeMs ?? null,
      stale_sweeps: result.staleSweeps ?? null,
      runtime_read_unavailable_kind: result.runtimeReadUnavailableKind ?? null,
      runtime_read_unavailable_sweeps: result.runtimeReadUnavailableSweeps ?? null,
      bookkeeping_reason_code: result.bookkeepingReasonCode ?? null,
      // Drives arcanist.sandbox.reaper.liveness_protected: a reap the gate
      // prevented (the bug's live prevalence).
      liveness_guard_prevented_reap: result.preventedReap === true,
    };
    const isLivenessOutcome =
      result.reasonCode === "defer_unproven_liveness" ||
      result.reasonCode === "defer_runtime_read_unavailable" ||
      result.reasonCode === "terminate_paused_unreferenced" ||
      result.reasonCode === "terminate_zombie_confirmed";
    if (result.decision === "protect") {
      this.log.warn(payload, "E2B orphan-reaper owner guard protected a live owned runtime");
    } else if (isLivenessOutcome) {
      this.log.warn(payload, "E2B orphan-reaper owner guard liveness outcome");
    } else {
      this.log.info(payload, "E2B orphan-reaper owner guard outcome");
    }
  }

  private mapE2BCleanupSkipReason(reason: Extract<E2BCleanupDecision, { action: "skip" }>["reason"]): {
    outcome: E2BRuntimeCleanupOutcome;
    reasonCode: E2BRuntimeCleanupReasonCode;
  } {
    switch (reason) {
      case "sandbox_changed":
        return { outcome: "skipped", reasonCode: "skipped_sandbox_changed" };
      case "backend_changed":
        return { outcome: "skipped", reasonCode: "skipped_backend_changed" };
      case "not_expired":
        return { outcome: "skipped", reasonCode: "skipped_not_expired" };
      case "live_activity_observed":
        return { outcome: "skipped", reasonCode: "skipped_live_activity" };
      case "not_e2b":
      default:
        return { outcome: "skipped", reasonCode: "skipped_not_e2b" };
    }
  }

  /**
   * Runs the cleanup workflow for one sandbox: decide (live) -> terminate
   * (memoized) -> clear/pause (guarded, recoverable). Failures arm a bounded
   * retry alarm; a stored job whose decide now skips re-syncs the projection
   * from authoritative DO state before clearing, so a half-written
   * `session_index` from a partial clear/pause converges.
   */
  private async runE2BCleanupWorkflow(params: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    reason: E2BRuntimeCleanupReason;
    nowMs: number;
  }): Promise<{
    outcome: E2BRuntimeCleanupOutcome;
    reasonCode: E2BRuntimeCleanupReasonCode;
    runtimeSandboxId: string;
  }> {
    const { sessionId, runtimeSandboxId, runtimeBackend, reason, nowMs } = params;

    let inFlight = e2bCleanupInFlight.get(this.state.storage);
    if (!inFlight) {
      inFlight = new Set();
      e2bCleanupInFlight.set(this.state.storage, inFlight);
    }
    if (inFlight.has(runtimeSandboxId)) {
      return { outcome: "skipped", reasonCode: "skipped_in_progress", runtimeSandboxId };
    }
    inFlight.add(runtimeSandboxId);
    try {
      return await this.runE2BCleanupWorkflowInner({ sessionId, runtimeSandboxId, runtimeBackend, reason, nowMs });
    } finally {
      inFlight.delete(runtimeSandboxId);
      if (inFlight.size === 0) e2bCleanupInFlight.delete(this.state.storage);
    }
  }

  private async runE2BCleanupWorkflowInner(params: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    reason: E2BRuntimeCleanupReason;
    nowMs: number;
  }): Promise<{
    outcome: E2BRuntimeCleanupOutcome;
    reasonCode: E2BRuntimeCleanupReasonCode;
    runtimeSandboxId: string;
  }> {
    const { sessionId, runtimeSandboxId, runtimeBackend, reason, nowMs } = params;
    const jobKey = e2bCleanupJobKey(runtimeSandboxId);
    const existing = await this.state.storage.get<E2BCleanupJobRecord>(jobKey);

    // A terminal-failed job stays uncleared so the worker sweep keeps
    // re-discovering it; honor a cooldown before reopening, otherwise the
    // retry cap is meaningless.
    if (existing?.status === "terminal_failed") {
      const cooledDown =
        existing.terminalFailedAt != null && nowMs - existing.terminalFailedAt >= E2B_CLEANUP_TERMINAL_COOLDOWN_MS;
      if (!cooledDown) {
        this.logE2BCleanupOutcome({
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          outcome: "terminal_failed",
          reasonCode: "terminal_failed_max_attempts",
          cleanupReason: reason,
          attempts: existing.attempts,
        });
        return { outcome: "terminal_failed", reasonCode: "terminal_failed_max_attempts", runtimeSandboxId };
      }
      // Cooled down — drop the record and treat this as a fresh attempt window.
      await this.state.storage.delete(jobKey);
    }
    const hasStoredJob = existing != null;

    // STEP 1: decide (live, never memoized). The request reason is threaded so the R4
    // `session_terminal` reclaim can override the running/paused arms; all other reasons re-decide
    // byte-identically.
    const decision = this.computeE2BCleanupDecision(sessionId, runtimeSandboxId, runtimeBackend, nowMs, reason);

    if (decision.action === "skip") {
      // If a job is stored, our runtime already transitioned (possibly via a
      // partial pause/clear that failed to sync). Re-sync the projection from
      // authoritative DO state so a half-written session_index converges,
      // except when a newer sandbox owns the row (it owns its own projection).
      if (hasStoredJob && decision.reason !== "sandbox_changed" && decision.reason !== "backend_changed") {
        await this.resyncRuntimeProjectionFromState(sessionId);
      }
      await this.finalizeE2BCleanupJob(runtimeSandboxId);
      const mapped = this.mapE2BCleanupSkipReason(decision.reason);
      this.logE2BCleanupOutcome({ sessionId, runtimeSandboxId, runtimeBackend, cleanupReason: reason, ...mapped });
      return { ...mapped, runtimeSandboxId };
    }

    try {
      if (decision.action === "pause") {
        const paused = await this.pauseE2BRuntimeForIdle(sessionId, decision.runtimeSandboxId, nowMs);
        if (paused) {
          // Guarantee D1 matches the now-paused DO state even if the pause path's
          // own projection sync was best-effort (partial-pause recovery, B7).
          await this.resyncRuntimeProjectionFromState(sessionId);
          await this.finalizeE2BCleanupJob(runtimeSandboxId);
          this.logE2BCleanupOutcome({
            sessionId,
            runtimeSandboxId,
            runtimeBackend,
            outcome: "paused",
            reasonCode: "paused",
            cleanupReason: reason,
          });
          return { outcome: "paused", reasonCode: "paused", runtimeSandboxId };
        }
        // Pause returned false: distinguish a real provider failure from a
        // benign no-op. `pauseE2BRuntimeForIdle` returns false for both a
        // swallowed provider error (runtime still stale-running) and for races
        // it already handled (work resumed -> still running with activity;
        // runtime found missing -> marked killed). Only the "still stale
        // running, no activity" case is a genuine failure worth retrying;
        // re-running full decide here would route a now-`killed` runtime into
        // the terminate/clear path, which is not this phase's job.
        const after = doDb.getSandboxState(this.sql, sessionId);
        const stillStaleRunning =
          after != null &&
          isKnownRuntimeProvider(after.runtimeProvider) &&
          after.runtimeState === "running" &&
          after.runtimeSandboxId === decision.runtimeSandboxId &&
          (after.runtimeLiveLeaseExpiresAt == null || after.runtimeLiveLeaseExpiresAt < Date.now()) &&
          !doDb.getActiveProcessingPromptId(this.sql, sessionId) &&
          !after.pendingPromptDispatch;
        if (stillStaleRunning) {
          throw new E2BCleanupRetryableError("pause_failed_retry", "idle pause did not take");
        }
        if (hasStoredJob) await this.resyncRuntimeProjectionFromState(sessionId);
        await this.finalizeE2BCleanupJob(runtimeSandboxId);
        // Distinguish "runtime found missing during the pause call" (handled
        // internally by pauseE2BRuntimeForIdle, which marks it killed + releases
        // capacity) from genuine live activity, so the reason code is not
        // misattributed in telemetry.
        const missingDuringPause =
          after != null &&
          isKnownRuntimeProvider(after.runtimeProvider) &&
          after.runtimeState === "killed" &&
          after.runtimeSandboxId === decision.runtimeSandboxId;
        const reasonCode: E2BRuntimeCleanupReasonCode = missingDuringPause
          ? "skipped_missing_during_pause"
          : "skipped_live_activity";
        this.logE2BCleanupOutcome({
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          outcome: "skipped",
          reasonCode,
          cleanupReason: reason,
        });
        return { outcome: "skipped", reasonCode, runtimeSandboxId };
      }

      const stepPrefix = e2bCleanupStepPrefix(runtimeSandboxId);
      // R4: attribute the provider kill + DD event to the FINAL-terminal reclaim when the run was
      // driven by the FSM `terminate_runtime` effect; every other cleanup reason stays "runtime_cleanup".
      const sandboxTerminateReason: SandboxTerminateReason =
        reason === "session_terminal" ? "session_terminal" : "runtime_cleanup";
      const terminateStatus = await durableStep(
        this.state.storage,
        `${stepPrefix}terminate`,
        async () => {
          try {
            const client = this.buildCleanupClient(decision.runtimeBackend);
            const res = await client.terminateSandbox(decision.runtimeSandboxId, sandboxTerminateReason);
            // Kill-path read channel (arm 3): emit inside the durableStep closure
            // so it fires exactly once per real kill (replay returns the memoized
            // status without re-running this). This bypass does not route through
            // terminateRuntimeWithLog because the step must THROW to retry, which
            // the wrapper would swallow.
            this.ctx.waitUntil(
              emitRuntimeTerminateEvent({
                env: this.env,
                sessionId,
                runtimeSandboxId: decision.runtimeSandboxId,
                reason: sandboxTerminateReason,
                terminateOutcome: res.status,
              }),
            );
            return res.status;
          } catch (err) {
            throw new E2BCleanupRetryableError("terminate_failed_retry", String(err));
          }
        },
        this.log,
      );
      const terminateReason: E2BRuntimeCleanupReasonCode =
        terminateStatus === "missing" ? "missing_sandbox" : "terminated";

      const clearResult = await durableStep(
        this.state.storage,
        `${stepPrefix}clear`,
        async () => {
          try {
            return await this.clearE2BRuntimeForCleanup({
              sessionId,
              expectedRuntimeSandboxId: decision.runtimeSandboxId,
              expectedRuntimeBackend: decision.runtimeBackend,
            });
          } catch (err) {
            throw new E2BCleanupRetryableError("clear_failed_retry", String(err));
          }
        },
        this.log,
      );

      if (!clearResult.cleared) {
        // A newer sandbox grabbed the row between decide and clear — abort
        // without claiming a clear.
        await this.finalizeE2BCleanupJob(runtimeSandboxId);
        this.logE2BCleanupOutcome({
          sessionId,
          runtimeSandboxId,
          runtimeBackend,
          outcome: "skipped",
          reasonCode: "skipped_sandbox_changed",
          cleanupReason: reason,
        });
        return { outcome: "skipped", reasonCode: "skipped_sandbox_changed", runtimeSandboxId };
      }

      // Belt-and-suspenders: ensure the projection reflects the cleared state
      // even if the clear's own sync was partial (partial-clear recovery, B2).
      await this.resyncRuntimeProjectionFromState(sessionId);
      await this.finalizeE2BCleanupJob(runtimeSandboxId);
      this.logE2BCleanupOutcome({
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        outcome: "cleared",
        reasonCode: terminateReason,
        cleanupReason: reason,
      });
      return { outcome: "cleared", reasonCode: terminateReason, runtimeSandboxId };
    } catch (err) {
      return await this.scheduleE2BCleanupRetry({ sessionId, runtimeSandboxId, runtimeBackend, reason, nowMs, err });
    }
  }

  /**
   * Records a failed attempt and arms a bounded retry alarm, or marks the job
   * `terminal_failed` once attempts are exhausted (the worker sweep is then the
   * backstop). Only the cleanup deadline + pointer are touched, never the shared
   * DO alarm directly.
   */
  private async scheduleE2BCleanupRetry(params: {
    sessionId: string;
    runtimeSandboxId: string;
    runtimeBackend: RuntimeBackend;
    reason: E2BRuntimeCleanupReason;
    nowMs: number;
    err: unknown;
  }): Promise<{
    outcome: E2BRuntimeCleanupOutcome;
    reasonCode: E2BRuntimeCleanupReasonCode;
    runtimeSandboxId: string;
  }> {
    const { sessionId, runtimeSandboxId, runtimeBackend, reason, nowMs, err } = params;
    const jobKey = e2bCleanupJobKey(runtimeSandboxId);
    const prior = await this.state.storage.get<E2BCleanupJobRecord>(jobKey);
    const attempts = (prior?.attempts ?? 0) + 1;
    const firstAttemptAt = prior?.firstAttemptAt ?? nowMs;
    const lastError = stringifyError(err);
    const reasonCode: E2BRuntimeCleanupReasonCode =
      err instanceof E2BCleanupRetryableError ? err.reasonCode : "clear_failed_retry";
    const maxAttempts = getE2BCleanupMaxAttempts(this.env);

    if (attempts >= maxAttempts) {
      const record: E2BCleanupJobRecord = {
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        reason,
        attempts,
        firstAttemptAt,
        lastError,
        status: "terminal_failed",
        terminalFailedAt: nowMs,
      };
      await this.state.storage.put(jobKey, record);
      await this.clearE2BCleanupRetryDeadline(runtimeSandboxId);
      // Re-arm the DO alarm for any other live lifecycle deadline. When this
      // branch is reached via an alarm-triggered retry, the alarm handler
      // returns early and Cloudflare clears the alarm on completion; without
      // this reschedule other deadlines (disconnect, auto-close, watchdogs)
      // would never fire again.
      await this.rescheduleSessionAlarm();
      this.logE2BCleanupOutcome({
        sessionId,
        runtimeSandboxId,
        runtimeBackend,
        outcome: "terminal_failed",
        reasonCode: "terminal_failed_max_attempts",
        cleanupReason: reason,
        attempts,
        error: lastError,
      });
      return { outcome: "terminal_failed", reasonCode: "terminal_failed_max_attempts", runtimeSandboxId };
    }

    const record: E2BCleanupJobRecord = {
      sessionId,
      runtimeSandboxId,
      runtimeBackend,
      reason,
      attempts,
      firstAttemptAt,
      lastError,
      status: "active",
    };
    await this.state.storage.put(jobKey, record);

    const backoffMs = computeDoRetryBackoffMs(attempts - 1, {
      baseBackoffMs: E2B_CLEANUP_RETRY_BASE_BACKOFF_MS,
      maxBackoffMs: E2B_CLEANUP_RETRY_MAX_BACKOFF_MS,
    });
    const pointer: E2BCleanupRetryPointer = { runtimeSandboxId, deadlineAt: nowMs + backoffMs };
    await this.state.storage.put(LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY, pointer);
    await this.rescheduleSessionAlarm();

    this.logE2BCleanupOutcome({
      sessionId,
      runtimeSandboxId,
      runtimeBackend,
      outcome: "retry_scheduled",
      reasonCode,
      cleanupReason: reason,
      attempts,
      error: lastError,
    });
    return { outcome: "retry_scheduled", reasonCode, runtimeSandboxId };
  }

  /**
   * Clears all durable state for a completed (or no-longer-relevant) cleanup
   * job: the per-sandbox step memos, the job record, and the retry pointer +
   * deadline. Re-projects the alarm so any other deadline is re-armed; never
   * calls deleteAlarm() (the DO alarm is shared across all session deadlines).
   */
  private async finalizeE2BCleanupJob(runtimeSandboxId: string): Promise<void> {
    await clearDurableStepsByPrefix(this.state.storage, e2bCleanupStepPrefix(runtimeSandboxId));
    await this.state.storage.delete(e2bCleanupJobKey(runtimeSandboxId));
    await this.clearE2BCleanupRetryDeadline(runtimeSandboxId);
    await this.rescheduleSessionAlarm();
  }

  /**
   * Deletes the cleanup retry pointer/deadline only when it points at the given
   * sandbox (or unconditionally when none is supplied). Reschedules afterward.
   */
  private async clearE2BCleanupRetryDeadline(runtimeSandboxId?: string): Promise<void> {
    const pointer = await this.state.storage.get<E2BCleanupRetryPointer>(
      LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY,
    );
    if (!pointer) return;
    if (runtimeSandboxId && pointer.runtimeSandboxId !== runtimeSandboxId) return;
    await this.state.storage.delete(LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY);
  }

  /**
   * Clear runtime state, guarding against clearing a newer sandbox.
   * `clearRuntimeAndSyncProjection` only checks `expectedProvider`, so the
   * sandbox-id/backend CAS guard lives here (B1).
   */
  private async clearE2BRuntimeForCleanup(options: {
    sessionId: string;
    expectedRuntimeSandboxId: string;
    expectedRuntimeBackend: RuntimeBackend;
  }): Promise<{ cleared: boolean }> {
    const sandbox = doDb.getSandboxState(this.sql, options.sessionId);
    // A different live managed sandbox now owns the row — do not clear it.
    if (
      sandbox &&
      isKnownRuntimeProvider(sandbox.runtimeProvider) &&
      sandbox.runtimeSandboxId &&
      sandbox.runtimeSandboxId !== options.expectedRuntimeSandboxId
    ) {
      return { cleared: false };
    }
    if (sandbox && isKnownRuntimeProvider(sandbox.runtimeProvider)) {
      const backend = this.readPersistedRuntimeBackend(options.sessionId);
      if (backend !== options.expectedRuntimeBackend) {
        return { cleared: false };
      }
    }
    await clearRuntimeAndSyncProjection({
      sql: this.sql,
      env: this.env,
      sessionId: options.sessionId,
      expectedProvider: this.expectedProviderForRuntimeClear(options.sessionId, options.expectedRuntimeBackend),
    });
    return { cleared: true };
  }

  /**
   * Re-syncs the D1 `session_index` projection from authoritative DO
   * `sandbox_state`. Used after a partial clear/pause to converge a half-written
   * projection (B2/B7); idempotent and safe to call on every workflow exit.
   */
  private async resyncRuntimeProjectionFromState(sessionId: string): Promise<void> {
    if (!this.env.DB) return;
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    if (!sandbox || !isKnownRuntimeProvider(sandbox.runtimeProvider) || !sandbox.runtimeSandboxId) {
      await syncRuntimeProjection(this.env, sessionId, CLEARED_RUNTIME_PROJECTION_STATE);
      return;
    }
    await syncRuntimeProjection(this.env, sessionId, this.buildRuntimeProjectionFromSandbox(sandbox));
  }

  /**
   * Backend-agnostic structured-log emitter for cleanup outcomes/reason codes.
   * Low-cardinality fields only; a Datadog metric, if wanted, is a log-derived
   * metric defined in infra Terraform.
   */
  private logE2BCleanupOutcome(fields: {
    sessionId: string;
    runtimeSandboxId: string | null;
    runtimeBackend: RuntimeBackend | null;
    outcome: E2BRuntimeCleanupOutcome;
    reasonCode: E2BRuntimeCleanupReasonCode;
    // The worker-passed candidate reason (why the sweep selected this row) — kept
    // distinct from `reasonCode` (the workflow outcome) so DD can split, e.g.,
    // killed_stale sweeps from ordinary paused/lease cleanups.
    cleanupReason: E2BRuntimeCleanupReason;
    attempts?: number;
    error?: string;
  }): void {
    const payload = {
      event: "sandbox.runtime.cleanup",
      session_id: fields.sessionId,
      runtime_sandbox_id: fields.runtimeSandboxId,
      runtime_backend: fields.runtimeBackend,
      outcome: fields.outcome,
      reason_code: fields.reasonCode,
      cleanup_reason: fields.cleanupReason,
      ...(fields.attempts != null ? { attempts: fields.attempts } : {}),
      ...(fields.error ? { error: fields.error } : {}),
    };
    if (fields.outcome === "retry_scheduled" || fields.outcome === "terminal_failed") {
      this.log.warn(payload, "E2B runtime cleanup outcome");
    } else {
      this.log.info(payload, "E2B runtime cleanup outcome");
    }
  }

  /**
   * Alarm-entry dispatch for a due cleanup retry. Returns true when it handled
   * the alarm (so the caller returns before the archived/lifecycle guards, which
   * would otherwise skip cleanup for stopped/archived sessions — the very
   * sessions cleanup targets, B4). The workflow re-arms or clears its own
   * deadline + reschedules, so an early return is always safe.
   */
  private async dispatchE2BCleanupRetryAlarm(sessionId: string): Promise<boolean> {
    const pointer = await this.state.storage.get<E2BCleanupRetryPointer>(
      LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY,
    );
    if (!pointer || typeof pointer.deadlineAt !== "number" || !Number.isFinite(pointer.deadlineAt)) return false;
    if (pointer.deadlineAt > Date.now()) return false;

    const job = await this.state.storage.get<E2BCleanupJobRecord>(e2bCleanupJobKey(pointer.runtimeSandboxId));
    if (!job || job.status !== "active") {
      // Stale pointer with no live job — drop it and reschedule.
      await this.clearE2BCleanupRetryDeadline(pointer.runtimeSandboxId);
      await this.rescheduleSessionAlarm();
      return true;
    }

    await this.runE2BCleanupWorkflow({
      sessionId,
      runtimeSandboxId: job.runtimeSandboxId,
      runtimeBackend: job.runtimeBackend,
      reason: job.reason,
      nowMs: Date.now(),
    });
    return true;
  }

  private buildRuntimeProjectionFromSandbox(sandbox: doDb.SandboxStateRow) {
    return {
      runtimeProvider: sandbox.runtimeProvider ?? null,
      runtimeBackend: sandbox.runtimeBackend ?? null,
      runtimeState: sandbox.runtimeState ?? null,
      runtimeSandboxId: sandbox.runtimeSandboxId ?? null,
      runtimeTemplateId: sandbox.runtimeTemplateId ?? null,
      runtimeStateExpiresAt: sandbox.runtimeStateExpiresAt ?? null,
      runtimeLiveLeaseExpiresAt: sandbox.runtimeLiveLeaseExpiresAt ?? null,
      runtimePreviewUrl: sandbox.runtimePreviewUrl ?? null,
      runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
      runtimeLastResumedAt: sandbox.runtimeLastResumedAt ?? null,
      runtimeLastPausedAt: sandbox.runtimeLastPausedAt ?? null,
      runtimeLastProviderRefreshedAt: sandbox.runtimeLastProviderRefreshedAt ?? null,
      runtimeProviderTtlExpiresAt: sandbox.runtimeProviderTtlExpiresAt ?? null,
    };
  }

  /**
   * Liveness probe via the static `getInfo` metadata read (never `connect`,
   * which auto-resumes). Returns `alive` only on an affirmative running/paused
   * state; `dead` on a confirmed-missing sandbox; `unknown` on any
   * timeout/error so callers fail toward their existing clear/terminate path.
   */
  private async probeE2BRuntimeLiveness(
    client: Pick<SandboxProviderClient, "getSandboxInfo">,
    runtimeSandboxId: string,
    logContext?: {
      sessionId?: string;
      lane?: string;
      runtimeBackend?: RuntimeBackend;
      connectionGeneration?: number | null;
    },
  ): Promise<"alive" | "dead" | "unknown"> {
    // Per-request budget, per attempt (the Freestyle client retries transient
    // failures internally — ARC-1478). 15s, not 5s: this probe's `unknown` is a
    // one-shot terminate of a possibly-live VM, and a live Freestyle per-VM read was
    // observed taking 11.6s during a transient blip. The timeout MUST exceed that
    // successful-read latency or a slow-but-alive read is still discarded as a
    // timeout → `unknown` → false kill, the exact ARC-1478 scenario; 10s cut it too
    // close (only ~-1.6s under the observation), 15s clears 11.6s with margin.
    // Worst case ≈ 3 attempts × 15s + backoffs ≈ 46s. An unavailable
    // provider remains `unknown` and is observed again; it never becomes proof
    // that the sandbox disappeared.
    const E2B_LIVENESS_PROBE_TIMEOUT_MS = 15_000;
    const probeStartedAt = Date.now();
    const info = await client.getSandboxInfo(runtimeSandboxId, {
      requestTimeoutMs: E2B_LIVENESS_PROBE_TIMEOUT_MS,
    });
    const probeCompletedAt = Date.now();
    const liveness =
      info.status === "running" || info.status === "paused" ? "alive" : info.status === "missing" ? "dead" : "unknown";
    // Diagnosis (sandbox-loss-diagnosis.md): getSandboxInfo collapses the raw SDK
    // state, so capture it here. `liveness:dead` means getSandboxInfo returned
    // `missing` (a missing_sandbox error); an unmapped state surfaces as `unknown`
    // (E2B) or a live-biased `paused` (Freestyle, ARC-1478) — both carry `rawState`,
    // so read it on every non-missing status. This is the only place the raw read
    // is visible before it is lost above the probe layer.
    const probePayload = {
      event: "sandbox_liveness_probe",
      runtimeSandboxId,
      normalizedStatus: info.status,
      rawState: "rawState" in info ? info.rawState : undefined,
      errorCode: info.status === "unknown" ? info.errorCode : undefined,
      liveness,
      probeStartedAt,
      probeCompletedAt,
      probeDurationMs: probeCompletedAt - probeStartedAt,
      ...(logContext ?? {}),
    };
    this.log.info(probePayload, "E2B liveness probe");
    // ARC-1196 read channel: direct-post so this diagnostic stays queryable in
    // Datadog (plain `this.log` never reaches it). Detached via waitUntil; off
    // the decision path; reuses the identical payload to avoid log/DD drift.
    this.ctx.waitUntil(this.postDiagnosticEventToDd(probePayload));
    return liveness;
  }

  /**
   * Direct-post a disconnect diagnostic event to Datadog, swallowing any failure:
   * a Datadog outage must never suppress the local (wrangler-tail) log, surface as
   * a cross-check error, or reject the alarm. Returns a promise that NEVER rejects,
   * so it is safe both to `await` from an already-detached context (the crossCheck
   * waitUntil) and to hand to `this.ctx.waitUntil(...)` on the synchronous alarm
   * path (a raw rejecting post handed to waitUntil becomes an unhandled rejection).
   */
  private postDiagnosticEventToDd(payload: Record<string, unknown>): Promise<void> {
    return postStructuredEventToDd(this.env, payload).then(
      () => {},
      () => {
        // Observability-only; the local this.log line already captured the event.
      },
    );
  }

  /**
   * DO-local wrapper over `terminateRuntimeWithLog` that injects `this.env` and a
   * `waitUntil` so the readable `runtime.terminate` attribution event posts off
   * the kill path. Every in-DO kill routes through here so the kill-path read
   * channel (sandbox-loss-diagnosis arm 3) is uniform and a Datadog post never
   * adds latency to a terminate.
   */
  private terminateRuntime(
    options: Omit<TerminateRuntimeWithLogOptions, "env" | "waitUntil">,
  ): Promise<{ status: RuntimeTerminateOutcome }> {
    return terminateRuntimeWithLog({
      ...options,
      env: this.env,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }

  /**
   * Observational disconnect cross-check (diagnosis only — sandbox-loss-diagnosis.md).
   * Fired via `waitUntil` AFTER the terminate decision; it never feeds the
   * decision and never throws into the alarm. Checks whether the VM our probe read
   * `dead` is in fact still alive (H2, false-negative probe) or genuinely absent
   * (H3 self-inflicted / H1 provider drop; attribution lives in the
   * `runtime.terminate` logs). `liveness` is the probe outcome that drove this
   * terminate; the summary signal is gated on it so only a provider-dead
   * decision can enter this diagnostic branch.
   *
   * The cross-check is dispatched on the session's runtime backend (ARC-1484): E2B
   * exposes an env-scoped account list to check against, but Freestyle's list is
   * account-wide AND shared across envs (isolation gated on ARC-1399), so it never
   * reliably contains this env's VM — listing it would mislabel every live Freestyle
   * VM as genuinely-gone. Freestyle instead re-reads the session's OWN VM via the
   * ARC-1478-hardened per-VM `getSandboxInfo`.
   */
  private async crossCheckRuntimeForDiagnosis(
    sessionId: string,
    runtimeSandboxId: string,
    lane: PromptDisconnectOrigin,
    liveness: RuntimeLivenessProbe,
    runtimeBackend: RuntimeBackend,
  ): Promise<void> {
    try {
      const client = this.buildCleanupClient(runtimeBackend);
      // Derive the branch from the persisted backend via the known-provider seam,
      // never a literal id check. The switch is exhaustive on SandboxRuntimeProvider,
      // so a new provider forces an explicit cross-check strategy here (compile error)
      // rather than silently falling back to the E2B list and mislabeling its fleet.
      let result: CrossCheckResult;
      switch (providerForRuntimeBackend(runtimeBackend)) {
        case "e2b":
          result = await crossCheckRuntimeLiveness({
            runtimeSandboxId,
            list: () => client.listCycloidSandboxes(),
            timeoutMs: SANDBOX_DISCONNECT_CROSSCHECK_TIMEOUT_MS,
          });
          break;
        case "freestyle":
          result = await crossCheckRuntimeViaProbe({
            runtimeSandboxId,
            probe: () =>
              client.getSandboxInfo(runtimeSandboxId, {
                requestTimeoutMs: SANDBOX_DISCONNECT_CROSSCHECK_PROBE_TIMEOUT_MS,
              }),
          });
          break;
      }
      // Log hygiene (docs/security.md): only the target id's presence/state —
      // never the full sandbox list (it carries other sessions' ids).
      const crossCheckPayload = {
        event: "sandbox_disconnect_crosscheck",
        sessionId,
        runtimeSandboxId,
        lane,
        crossCheckStatus: result.status,
        listed: result.listed,
        ...(result.listedState ? { listedState: result.listedState } : {}),
        durationMs: result.durationMs,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      };
      this.log.warn(crossCheckPayload, "Disconnect terminalize cross-check");
      // Already inside the detached crossCheck waitUntil: await directly (no
      // nested waitUntil) and swallow post failures so a Datadog error never
      // suppresses the summary log or trips the outer catch.
      await this.postDiagnosticEventToDd(crossCheckPayload);
      const crossCheckSummaryPayload = {
        event: "sandbox_disconnect_crosscheck_summary",
        sessionId,
        runtimeSandboxId,
        lane,
        liveness,
        listed: result.listed,
        signal: classifyCrossCheckSignal({
          listed: result.listed,
          status: result.status,
          liveness,
        }),
      };
      this.log.warn(crossCheckSummaryPayload, "Disconnect terminalize cross-check summary");
      await this.postDiagnosticEventToDd(crossCheckSummaryPayload);
    } catch (error) {
      const crossCheckErrorPayload = {
        event: "sandbox_disconnect_crosscheck_error",
        sessionId,
        runtimeSandboxId,
        lane,
        // Sanitized code only — never raw `String(error)`, which can carry
        // provider/network detail (docs/security.md log hygiene).
        errorCode: sanitizeErrorCode(error),
      };
      this.log.warn(crossCheckErrorPayload, "Disconnect cross-check failed (observational only)");
      await this.postDiagnosticEventToDd(crossCheckErrorPayload);
    }
  }

  private activeToolCallsStorageKey(promptId: string): string {
    return `${PROMPT_ACTIVE_TOOL_CALLS_STORAGE_KEY_PREFIX}${promptId}`;
  }

  private normalizeActiveToolCallIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
      seen.add(item);
      ids.push(item);
      if (ids.length >= PROMPT_ACTIVE_TOOL_CALLS_MAX) break;
    }
    return ids;
  }

  private async hasActiveToolCall(promptId: string): Promise<boolean> {
    const cachedIds = this.activeToolCallIdsByPrompt.get(promptId);
    if (cachedIds && cachedIds.size > 0) return true;
    const ids = this.normalizeActiveToolCallIds(await this.state.storage.get(this.activeToolCallsStorageKey(promptId)));
    if (ids.length > 0) this.activeToolCallIdsByPrompt.set(promptId, new Set(ids));
    return ids.length > 0;
  }

  private async trackActiveToolCallEvent(promptId: string, event: SandboxEvent): Promise<void> {
    const next = this.applyActiveToolCallEventInMemory(promptId, event);
    if (!next) return;
    const key = this.activeToolCallsStorageKey(promptId);
    if (next.length === 0) {
      await this.state.storage.delete(key);
      return;
    }
    await this.state.storage.put(key, next);
  }

  private applyActiveToolCallEventInMemory(promptId: string, event: SandboxEvent): string[] | null {
    if (event.type !== "tool_call" && event.type !== "tool_update") return null;
    const callId = typeof event.callId === "string" ? event.callId : "";
    if (!callId) return null;
    const current = this.activeToolCallIdsByPrompt.get(promptId) ?? new Set<string>();
    if (
      event.type === "tool_call" ||
      (event.type === "tool_update" && !this.isTerminalToolUpdateStatus(event.status))
    ) {
      current.add(callId);
      while (current.size > PROMPT_ACTIVE_TOOL_CALLS_MAX) {
        const oldest = current.values().next().value;
        if (oldest === undefined) break;
        current.delete(oldest);
      }
      this.activeToolCallIdsByPrompt.set(promptId, current);
      return [...current];
    }
    current.delete(callId);
    if (current.size === 0) {
      this.activeToolCallIdsByPrompt.delete(promptId);
      return [];
    }
    this.activeToolCallIdsByPrompt.set(promptId, current);
    return [...current];
  }

  private isTerminalToolUpdateStatus(status: string): boolean {
    return status === "completed" || status === "error";
  }

  private async clearActiveToolCalls(promptId: string): Promise<void> {
    this.activeToolCallIdsByPrompt.delete(promptId);
    await this.state.storage.delete(this.activeToolCallsStorageKey(promptId));
  }

  private async markRuntimeKilledAfterUnexpectedDisconnect(sessionId: string, reason: string): Promise<void> {
    const updatedSandbox = this.markRuntimeKilledLocallyAfterUnexpectedDisconnect(sessionId, reason);
    if (!updatedSandbox) return;
    await this.projectRuntimeKilledAfterUnexpectedDisconnect(sessionId);
  }

  private markRuntimeKilledLocallyAfterUnexpectedDisconnect(
    sessionId: string,
    reason: string,
  ): doDb.SandboxStateRow | null {
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    if (!sandbox) return null;

    // The downstream E2B kill only logs a flat `kill_reason: 'request'`, so this
    // is the one place the disconnect trigger (liveness vs reconnect-grace
    // expiry) is recorded against the session. Without it, a reaped healthy VM
    // is indistinguishable from any other terminate.
    this.log.warn(
      {
        event: "runtime.reaped",
        sessionId,
        runtimeSandboxId: sandbox.runtimeSandboxId,
        reason,
      },
      "Runtime marked killed after unexpected disconnect",
    );

    const nowMs = Date.now();
    applyRuntimePatch({
      sql: this.sql,
      sessionId,
      patch: {
        status: "stopped",
        stopReason: "reaped",
        runtimeState: "killed",
        runtimeStateExpiresAt: nowMs,
        runtimeLiveLeaseExpiresAt: null,
        intentionalPauseReason: null,
      },
    });
    clearTransportMarkers({ sql: this.sql, sessionId });
    return doDb.getSandboxState(this.sql, sessionId);
  }

  private async projectRuntimeKilledAfterUnexpectedDisconnect(sessionId: string): Promise<void> {
    // Transport disconnect path: local sandbox_state is already durable. If
    // the projection rejects, log + Sentry-tag and continue with the runtime
    // projection cleanup below.
    await this.swallowLifecyclePersistence(
      sessionId,
      "sandbox_transport_event",
      () => this.persistAndBroadcastSessionStatus(sessionId, "sandbox_transport_event"),
      "",
    );

    if (!this.env.DB) return;
    const updatedSandbox = doDb.getSandboxState(this.sql, sessionId);
    if (!updatedSandbox) return;
    await syncRuntimeProjection(this.env, sessionId, this.buildRuntimeProjectionFromSandbox(updatedSandbox));
  }

  /**
   * Termination chokepoint (Plan A). The ONE gate every disconnect kill lane
   * (reconnect-grace + silent-liveness expiry) calls before terminalizing an
   * in-flight prompt. Returns "terminate" only when an independent provider
   * probe reports the runtime missing after the sustained transport-loss
   * window. Tool state, bridge silence, provider `alive`, provider `unknown`,
   * and probe errors remain observation states.
   */
  private async confirmRuntimeDeadBeforeTerminalize(
    sessionId: string,
    lane: PromptDisconnectOrigin,
    preDispatch: LifecycleState,
  ): Promise<RuntimeTerminationDecision> {
    const killSwitchEnabled = isE2BOrphanReaperLivenessGuardEnabled(this.env);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const runtimeSandboxId = sandbox?.runtimeSandboxId ?? null;
    const hasManagedRuntime = Boolean(sandbox && isKnownRuntimeProvider(sandbox.runtimeProvider) && runtimeSandboxId);
    // Read the pinned backend defensively: a corrupt/legacy persisted value (e.g. a
    // dropped self-hosted backend) becomes unknown through the probe-error path
    // below and never rejects the alarm. On a corrupt read the
    // value stays the cloud default (and the row is healed to cloud below), so the
    // probe and the ARC-1484 backend-dispatched cross-check both run on cloud there;
    // the stashed error re-throws into the probe try so it defers with a
    // sanitized errorCode. A healthy Freestyle row keeps `freestyle`, so its
    // cross-check reads the Freestyle VM, not the E2B account list.
    // Box the caught value so a falsy throw (`throw null`/`0`/`false`) stays
    // distinguishable from "no error" — the null sentinel alone would let the probe
    // run on the cloud default and could `defer` a corrupt-backend session instead
    // without misclassifying the provider result.
    let persistedBackend: RuntimeBackend = E2B_CLOUD_RUNTIME_BACKEND;
    let persistedBackendError: { caught: unknown } | null = null;
    try {
      persistedBackend = this.readPersistedRuntimeBackend(sessionId);
    } catch (error) {
      persistedBackendError = { caught: error };
      // Heal the corrupt/legacy value to cloud so the terminate branch's spawn
      // re-clone recovers: failActivePromptOnDisconnect -> spawn ->
      // resolveRuntimeBackendAffinity re-reads + re-parses runtime_backend, so an
      // unhealed row would re-throw the same parse error and loop spawn retries.
      // Best-effort: a heal failure must not reject the observation alarm.
      try {
        await this.persistRuntimeBackendAffinity(sessionId, E2B_CLOUD_RUNTIME_BACKEND);
      } catch (healError) {
        this.log.warn(
          { event: "sandbox_disconnect_backend_heal_failed", sessionId, errorCode: sanitizeErrorCode(healError) },
          "Failed to normalize a corrupt runtime backend -- spawn re-clone may retry",
        );
      }
    }

    // Measure sustained transport loss from the last PROVEN bridge contact.
    // heartbeat (the bridge beats every 30s while alive). Read it from lifecycle
    // storage via getSandboxHeartbeatFreshness — NOT sandbox_state.last_heartbeat_at,
    // which ordinary heartbeats never write. A null anchor cannot prove the
    // sustained window and therefore cannot terminalize.
    const nowMs = Date.now();
    const heartbeat = await this.getSandboxHeartbeatFreshness();
    const recoveryElapsedMs = heartbeat.lastHeartbeatAt === null ? null : nowMs - heartbeat.lastHeartbeatAt;
    const lossWindowElapsed = recoveryElapsedMs !== null && recoveryElapsedMs >= SANDBOX_LOSS_RECOVERY_BUDGET_MS;
    const recoveryDeadlineAt =
      lane === "liveness_expiry" ? preDispatch.deadlines.sandboxLiveness : preDispatch.deadlines.sandboxReconnectGrace;
    const activePromptId = preDispatch.prompt.promptId;
    const activeToolCall = activePromptId ? await this.hasActiveToolCall(activePromptId).catch(() => null) : false;
    const connectionGeneration =
      this.cachedSandboxConnectionGen ??
      (await this.state.storage.get<number>(SANDBOX_CONNECTION_GENERATION_STORAGE_KEY)) ??
      null;
    let providerProbeDurationMs: number | null = null;
    const buildRecoveryTelemetry = () => {
      const observedAt = Date.now();
      const recoveryElapsedMs = heartbeat.lastHeartbeatAt === null ? null : observedAt - heartbeat.lastHeartbeatAt;
      return {
        activePromptId,
        activeToolCall,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        heartbeatAgeMs: recoveryElapsedMs,
        recoveryElapsedMs,
        recoveryBudgetMs: SANDBOX_LOSS_RECOVERY_BUDGET_MS,
        recoveryDeadlineAt,
        recoveryDeadlineOverdueMs: recoveryDeadlineAt === null ? null : Math.max(0, observedAt - recoveryDeadlineAt),
        connectionGeneration,
        providerProbeDurationMs,
      };
    };

    // Probe both disconnect lanes only after the independent observation window.
    // Active tool state is deliberately absent from this decision predicate.
    let liveness: RuntimeLivenessProbe = null;
    if (killSwitchEnabled && hasManagedRuntime && lossWindowElapsed && runtimeSandboxId) {
      const providerProbeStartedAt = Date.now();
      try {
        if (persistedBackendError) throw persistedBackendError.caught;
        liveness = await this.probeE2BRuntimeLiveness(this.buildCleanupClient(persistedBackend), runtimeSandboxId, {
          sessionId,
          lane,
          runtimeBackend: persistedBackend,
          connectionGeneration,
        });
      } catch (error) {
        liveness = "unknown";
        const probeErrorPayload = {
          event: "sandbox_disconnect_probe_error",
          sessionId,
          lane,
          runtimeSandboxId,
          ...buildRecoveryTelemetry(),
          // Sanitized code only — never raw `String(error)` (docs/security.md).
          errorCode: sanitizeErrorCode(error),
        };
        this.log.warn(probeErrorPayload, "Liveness probe threw -- keeping provider loss unconfirmed");
        this.ctx.waitUntil(this.postDiagnosticEventToDd(probeErrorPayload));
      } finally {
        providerProbeDurationMs = Date.now() - providerProbeStartedAt;
      }
    }

    const decision = decideRuntimeTerminationOnDisconnect({
      killSwitchEnabled,
      hasE2BRuntime: hasManagedRuntime,
      lossWindowElapsed,
      liveness,
    });

    // A4a SLO: one count per chokepoint decision, tagged lane/decision/liveness.
    // The `{decision:terminate,liveness:alive}` slice is the invariant violation
    // (a prompt killed while E2B proved its VM alive) and must read ~0; the
    // `{decision:defer}` slice is the positive signal that the gate is saving
    // live prompts in prod. Off the alarm critical path via waitUntil.
    this.ctx.waitUntil(
      emitSandboxDisconnectTerminalizeMetric(this.env, {
        lane,
        decision,
        liveness: liveness ?? "none",
      }),
    );

    if (decision === "defer") {
      const recoveryTelemetry = buildRecoveryTelemetry();
      const observationState =
        liveness === "alive"
          ? "provider_alive"
          : liveness === "unknown"
            ? "provider_unknown"
            : lossWindowElapsed
              ? "provider_unconfirmed"
              : "transport_loss_observing";
      await this.deferDisconnectTerminalize(sessionId, lane, preDispatch, {
        runtimeSandboxId,
        liveness,
        holdElapsedMs: recoveryTelemetry.recoveryElapsedMs,
        observationState,
        ...recoveryTelemetry,
      });
      return decision;
    }

    // Observational cross-check (diagnosis only): off the decision path via
    // waitUntil. The terminate decision above is already final; this only records
    // whether the VM is still alive on its own backend. Dispatched on
    // `persistedBackend` (ARC-1484) so a Freestyle VM is not cross-checked against
    // the E2B account list. A corrupt/legacy backend was healed to cloud above, so
    // `persistedBackend` is the safe cloud default there.
    if (hasManagedRuntime && runtimeSandboxId) {
      this.ctx.waitUntil(
        this.crossCheckRuntimeForDiagnosis(sessionId, runtimeSandboxId, lane, liveness, persistedBackend),
      );
    }

    const recoveryTelemetry = buildRecoveryTelemetry();
    const terminalizeConfirmedPayload = {
      event: "sandbox_disconnect_terminalize_confirmed",
      sessionId,
      lane,
      runtimeSandboxId,
      ...recoveryTelemetry,
      liveness,
      holdElapsedMs: recoveryTelemetry.recoveryElapsedMs,
      killSwitchEnabled,
      observationState: "provider_dead_confirmed",
      terminalizationReason: "provider_missing_after_sustained_transport_loss",
      persistedBackend,
    };
    this.log.info(terminalizeConfirmedPayload, "Disconnect terminalize confirmed by sustained provider-missing result");
    this.ctx.waitUntil(this.postDiagnosticEventToDd(terminalizeConfirmedPayload));
    return decision;
  }

  /**
   * Enact a "defer" decision: keep the in-flight prompt running on the SAME VM
   * and re-arm the lane's deadline so the next alarm re-probes.
   *
   * `dispatchLifecycleAlarm` has already applied the disconnect event's terminal
   * PERSIST patch (prompt.phase="terminal", prompt deadlines cleared) even though
   * the terminal EMIT was deferred — `applyLifecycleDecision` always applies
   * persist_state, gating only emit_terminal on `applyTerminal`. Since we are
   * keeping the same prompt, restore the full pre-dispatch prompt lifecycle and
   * the cleared prompt deadlines, or a reconnecting bridge's running/terminal
   * events would be rejected as a stale terminal-phase prompt and the prompt
   * would wedge. The prompt block is written directly to skip
   * applyLifecycleStatePatch's running-phase Slack side effect (it would re-fire
   */
  private async deferDisconnectTerminalize(
    sessionId: string,
    lane: PromptDisconnectOrigin,
    preDispatch: LifecycleState,
    detail: {
      runtimeSandboxId: string | null;
      liveness: RuntimeLivenessProbe;
      holdElapsedMs: number | null;
      activePromptId: string | null;
      activeToolCall: boolean | null;
      lastHeartbeatAt: number | null;
      heartbeatAgeMs: number | null;
      recoveryElapsedMs: number | null;
      recoveryBudgetMs: number;
      recoveryDeadlineAt: number | null;
      recoveryDeadlineOverdueMs: number | null;
      connectionGeneration: number | null;
      providerProbeDurationMs: number | null;
      observationState: string;
    },
  ): Promise<void> {
    const nowMs = Date.now();
    const nextObservationAt = nowMs + SANDBOX_LOSS_RECOVERY_BUDGET_MS;
    await this.state.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, preDispatch.prompt);

    const restoredPromptDeadlines = {
      promptStartup: preDispatch.deadlines.promptStartup,
      promptDispatch: preDispatch.deadlines.promptDispatch,
      promptRunningInactivity: preDispatch.deadlines.promptRunningInactivity,
    };
    if (lane === "liveness_expiry") {
      // Silent-liveness lane: no clean close, so no disconnect marker. Keep the
      // pre-dispatch sandbox state and re-arm the liveness deadline (NOT grace),
      // so a heartbeat that resumes clears the silence naturally without leaving
      // a phantom reconnect-grace hold the bridge can never satisfy.
      await this.applyLifecycleStatePatch(sessionId, {
        sandbox: { state: preDispatch.sandbox.state },
        deadlines: {
          sandboxLiveness: nextObservationAt,
          sandboxReconnectGrace: null,
          ...restoredPromptDeadlines,
        },
      });
    } else {
      // Reconnect-grace lane: reset the D1 marker with the next observation so
      // its derived candidate cannot create a past-deadline alarm loop.
      await this.applyLifecycleStatePatch(sessionId, {
        sandbox: { state: "reconnecting", disconnectStartedAt: nowMs },
        deadlines: {
          sandboxReconnectGrace: nextObservationAt,
          sandboxLiveness: null,
          ...restoredPromptDeadlines,
        },
      });
    }
    await this.rescheduleSessionAlarm();
    const terminalizeDeferredPayload = {
      event: "sandbox_disconnect_terminalize_deferred",
      sessionId,
      lane,
      runtimeSandboxId: detail.runtimeSandboxId,
      liveness: detail.liveness,
      holdElapsedMs: detail.holdElapsedMs,
      activePromptId: detail.activePromptId,
      activeToolCall: detail.activeToolCall,
      lastHeartbeatAt: detail.lastHeartbeatAt,
      heartbeatAgeMs: detail.heartbeatAgeMs,
      recoveryElapsedMs: detail.recoveryElapsedMs,
      recoveryBudgetMs: detail.recoveryBudgetMs,
      recoveryDeadlineAt: detail.recoveryDeadlineAt,
      recoveryDeadlineOverdueMs: detail.recoveryDeadlineOverdueMs,
      connectionGeneration: detail.connectionGeneration,
      providerProbeDurationMs: detail.providerProbeDurationMs,
      observationState: detail.observationState,
      nextRecoveryDeadlineAt: nextObservationAt,
    };
    this.log.warn(terminalizeDeferredPayload, "Deferred disconnect terminalize -- provider loss remains unconfirmed");
    this.ctx.waitUntil(this.postDiagnosticEventToDd(terminalizeDeferredPayload));
  }

  private recordRuntimeActivity(sessionId: string, reason: string): void {
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const nowMs = Date.now();
    const patch: Partial<doDb.SandboxStateRow> = { lastActivityAt: nowMs };
    if (isKnownRuntimeProvider(sandbox?.runtimeProvider) && sandbox?.runtimeState === "running") {
      patch.runtimeLiveLeaseExpiresAt = nowMs + getE2BRuntimeLiveLeaseMs(this.env);
    }
    applyRuntimePatch({ sql: this.sql, sessionId, patch });
    this.log.debug({ event: "runtime_activity_recorded", sessionId, reason }, "Recorded runtime activity");
  }

  private idlePauseConflictObserved(sessionId: string, sandbox: doDb.SandboxStateRow, pausedAtFence: number): boolean {
    if (doDb.getActiveProcessingPromptId(this.sql, sessionId) || sandbox.pendingPromptDispatch) {
      return true;
    }
    if (sandbox.lastActivityAt != null && sandbox.lastActivityAt > pausedAtFence) {
      return true;
    }
    return sandbox.promptLastActivityAt != null && sandbox.promptLastActivityAt > pausedAtFence;
  }

  private async pauseE2BRuntimeForIdle(
    sessionId: string,
    expectedRuntimeSandboxId: string,
    pausedAtFence: number,
    pauseReason: SandboxIdlePauseReason = SandboxIdlePauseReason.IDLE_AUTO_PAUSE,
  ): Promise<boolean> {
    let paused = false;
    let resumeAfterPause = false;

    await this.runCriticalPersistence(async () => {
      await this.flushTextDeltaBuffer();

      const sandbox = doDb.getSandboxState(this.sql, sessionId);
      const ext = doDb.getSessionExtended(this.sql, sessionId);
      if (
        !sandbox ||
        !isKnownRuntimeProvider(sandbox.runtimeProvider) ||
        sandbox.runtimeState !== "running" ||
        !sandbox.runtimeSandboxId ||
        sandbox.runtimeSandboxId !== expectedRuntimeSandboxId
      ) {
        return;
      }
      if (this.idlePauseConflictObserved(sessionId, sandbox, pausedAtFence)) {
        this.log.info(
          {
            event: "e2b_idle_pause_aborted",
            sessionId,
            runtimeSandboxId: sandbox.runtimeSandboxId,
            activePromptId: doDb.getActiveProcessingPromptId(this.sql, sessionId),
            pendingPromptDispatch: sandbox.pendingPromptDispatch,
            pausedAtFence,
            lastActivityAt: sandbox.lastActivityAt ?? null,
            promptLastActivityAt: sandbox.promptLastActivityAt ?? null,
          },
          "Skipping idle E2B pause because work resumed before pause execution",
        );
        return;
      }

      const runtimeSandboxId = sandbox.runtimeSandboxId;
      const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
      const runtimeConfig = this.buildRuntimeClientConfig(runtimeBackend);
      doDb.updateSandboxState(this.sql, sessionId, {
        intentionalPauseReason: pauseReason,
      });
      this.log.info(
        {
          event: "e2b_idle_pause_attempted",
          sessionId,
          runtimeSandboxId,
          runtimeProvider: sandbox.runtimeProvider,
        },
        "Attempting idle E2B runtime pause",
      );

      try {
        await this.withTimeout(
          runtimeConfig.client.pauseSandbox(runtimeSandboxId),
          STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS,
          `E2B idle pause timed out after ${STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS}ms`,
        );
      } catch (err) {
        const nowMs = Date.now();
        if (err instanceof E2BSandboxRuntimeError && (err.code === "missing_sandbox" || err.code === "killed")) {
          applyRuntimePatch({
            sql: this.sql,
            sessionId,
            patch: {
              status: "stopped",
              stopReason: null,
              runtimeState: "killed",
              runtimeStateExpiresAt: nowMs,
              runtimeLiveLeaseExpiresAt: null,
              intentionalPauseReason: null,
            },
          });
          clearTransportMarkers({ sql: this.sql, sessionId });
          if (this.env.DB) {
            await syncRuntimeProjection(this.env, sessionId, {
              runtimeProvider: providerForRuntimeBackend(runtimeBackend),
              runtimeBackend,
              runtimeState: "killed",
              runtimeSandboxId,
              runtimeTemplateId: sandbox.runtimeTemplateId ?? null,
              runtimeStateExpiresAt: nowMs,
              runtimeLiveLeaseExpiresAt: null,
              runtimePreviewUrl: null,
              runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
              runtimeLastResumedAt: sandbox.runtimeLastResumedAt ?? null,
              runtimeLastPausedAt: sandbox.runtimeLastPausedAt ?? null,
              runtimeLastProviderRefreshedAt: sandbox.runtimeLastProviderRefreshedAt ?? null,
              runtimeProviderTtlExpiresAt: sandbox.runtimeProviderTtlExpiresAt ?? null,
            });
          }
          // Idle-pause cleanup: local state already durable. Don't let a
          // projection rejection abort the warn-log + socket close below.
          await this.swallowLifecyclePersistence(
            sessionId,
            "sandbox_transport_event",
            () => this.persistAndBroadcastSessionStatus(sessionId, "sandbox_transport_event"),
            "",
          );
          this.closeSandboxSockets("Idle runtime missing during pause");
          this.log.warn(
            { event: "e2b_idle_pause_failed", sessionId, runtimeSandboxId, error: serializeError(err) },
            "E2B runtime was missing while attempting idle pause",
          );
          return;
        }

        doDb.updateSandboxState(this.sql, sessionId, {
          intentionalPauseReason: null,
        });
        this.log.warn(
          { event: "e2b_idle_pause_failed", sessionId, runtimeSandboxId, error: serializeError(err) },
          "Idle E2B runtime pause failed; runtime left running for retry",
        );
        return;
      }

      const postPauseSandbox = doDb.getSandboxState(this.sql, sessionId);
      if (
        !postPauseSandbox ||
        !isKnownRuntimeProvider(postPauseSandbox.runtimeProvider) ||
        postPauseSandbox.runtimeState !== "running" ||
        postPauseSandbox.runtimeSandboxId !== runtimeSandboxId
      ) {
        return;
      }

      const pausedAt = Date.now();
      const runtimeState = {
        runtimeProvider: providerForRuntimeBackend(runtimeBackend),
        runtimeBackend,
        runtimeState: "paused" as const,
        runtimeSandboxId,
        runtimeTemplateId: postPauseSandbox.runtimeTemplateId ?? runtimeConfig.defaultTemplate,
        runtimeStateExpiresAt: pausedAt + getE2BRuntimeRetentionMs(this.env),
        runtimeLiveLeaseExpiresAt: null,
        runtimePreviewUrl: null,
        runtimeCreatedAt: postPauseSandbox.runtimeCreatedAt ?? null,
        runtimeLastResumedAt: postPauseSandbox.runtimeLastResumedAt ?? null,
        runtimeLastPausedAt: pausedAt,
        runtimeLastProviderRefreshedAt: postPauseSandbox.runtimeLastProviderRefreshedAt ?? null,
        runtimeProviderTtlExpiresAt: postPauseSandbox.runtimeProviderTtlExpiresAt ?? null,
      };
      applyRuntimePatch({
        sql: this.sql,
        sessionId,
        patch: {
          ...runtimeState,
          status: "stopped",
          stopReason: null,
          intentionalPauseReason: pauseReason,
        },
      });
      clearTransportMarkers({ sql: this.sql, sessionId });
      if (this.env.DB) {
        await syncRuntimeProjection(this.env, sessionId, runtimeState);
      }
      if (this.idlePauseConflictObserved(sessionId, postPauseSandbox, pausedAtFence)) {
        resumeAfterPause = true;
        this.log.info(
          {
            event: "e2b_idle_pause_resume_after_race",
            sessionId,
            runtimeSandboxId,
            activePromptId: doDb.getActiveProcessingPromptId(this.sql, sessionId),
            pendingPromptDispatch: postPauseSandbox.pendingPromptDispatch,
            pausedAtFence,
            lastActivityAt: postPauseSandbox.lastActivityAt ?? null,
            promptLastActivityAt: postPauseSandbox.promptLastActivityAt ?? null,
          },
          "Resuming E2B runtime because new work appeared during idle pause",
        );
        return;
      }
      // Idle-pause success path: local pause state is durable. Swallow
      // projection rejection through Sentry rather than aborting the socket
      // close + success log below.
      await this.swallowLifecyclePersistence(
        sessionId,
        "sandbox_transport_event",
        () => this.persistAndBroadcastSessionStatus(sessionId, "sandbox_transport_event"),
        "",
      );
      this.closeSandboxSockets("Idle runtime paused");
      this.log.info(
        {
          event: "e2b_idle_pause_succeeded",
          sessionId,
          runtimeSandboxId,
          reason: pauseReason,
        },
        "Paused idle E2B runtime",
      );
      paused = true;
    });

    // Live-idle telemetry (consumes PR-2's stopped_kept_alive_at marker). When a
    // session was kept live-idle after a user soft-stop, record how long the VM
    // stayed live before the idle sweep ended the window: `resumed:false` for a
    // clean pause (the walk-away that spent live-VM time with no resume) and
    // `resumed:true` when work raced back in during the pause (the VM is being
    // resumed just below). Emitted once and the marker deleted so a later idle
    // cycle on the same VM can't re-count. `postDiagnosticEventToDd` routes to
    // `postStructuredEventToDd` and swallows a DD outage; the local `this.log`
    // line keeps the record either way.
    //
    // Measurement note: the marker is stamped in `stopSessionKeepAlive` at the
    // stop-button press. For an ACTIVE-prompt stop that fires before the aborting
    // turn settles, so `live_idle_ms` includes the agent-abort latency; an idle
    // stop stamps once already-idle and has no such inflation.
    if (paused || resumeAfterPause) {
      const stoppedKeptAliveAt = await this.state.storage.get<number>(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY);
      if (typeof stoppedKeptAliveAt === "number") {
        // Reuse the single durable-clear contract (reset in-memory flag + delete
        // marker) — stoppedKeptAliveAt is already captured above for
        // live_idle_ms. After a walk-away pause ends the live-idle window there
        // is nothing to resume, so clearing now keeps the in-memory flag lockstep
        // with the durable marker instead of leaving it stale-`true` until DO
        // eviction (a stale flag makes the next dispatch's resumed_after_stop
        // attribution — read by the cold-dispatch monitor + dashboard —
        // non-deterministic).
        await this.clearUserStopped();
        const liveIdleEvent = {
          event: "sandbox.live_idle",
          sessionId,
          session_id: sessionId,
          live_idle_ms: Date.now() - stoppedKeptAliveAt,
          resumed: resumeAfterPause,
          runtime_backend: this.readPersistedRuntimeBackend(sessionId),
          stop_reason: "user",
        };
        this.log.info(liveIdleEvent, "sandbox.live_idle");
        this.ctx.waitUntil(this.postDiagnosticEventToDd(liveIdleEvent));
      }
    }

    if (resumeAfterPause) {
      await this.runSpawnSandboxInSpan(sessionId, undefined, "pauseE2BRuntimeForIdle.resume_after_race");
    }

    return paused;
  }

  private buildReplayPageBeforeSequence(
    sessionId: string,
    beforeSequenceRaw: unknown,
    limitRaw: unknown,
    maxLimit = REPLAY_PAGE_SIZE,
  ): ClientReplayPage {
    const beforeSequence = normalizeEventSequence(beforeSequenceRaw, 0);
    const limit = Math.min(Math.max(parseNonNegativeInteger(limitRaw, REPLAY_PAGE_SIZE), 1), maxLimit);

    if (beforeSequence <= 1) {
      return {
        afterSequence: 0,
        beforeSequence,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      };
    }

    const { events, hasEvents, hasMore } = doDb.getReplayEventsBeforeSequence(
      this.sql,
      sessionId,
      beforeSequence,
      limit,
    );
    if (!hasEvents) {
      return {
        afterSequence: 0,
        beforeSequence,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      };
    }

    return {
      afterSequence: 0,
      beforeSequence,
      events,
      hasMore,
      droppedCount: hasMore ? 1 : 0,
      firstSequence: events[0]?.sequence ?? null,
      lastSequence: events[events.length - 1]?.sequence ?? null,
    };
  }

  // Future helper boundary: session/ws-manager.ts owns socket-kind routing and connect/close/error delegation.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.wsManager.handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.wsManager.handleWebSocketClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.wsManager.handleWebSocketError(ws, error);
  }

  // ---------------------------------------------------------------------------
  // Persistence queue helpers
  // ---------------------------------------------------------------------------

  /** Schedule a persistence task on the serialized queue and return its completion promise. */
  private schedulePersistenceTask(task: () => Promise<void>): Promise<void> {
    const queuedAt = Date.now();
    const run = this.persistenceQueue.then(async () => {
      const startedAt = Date.now();
      try {
        await task();
      } finally {
        this.log.info(
          {
            event: "session.persistence_queue.metrics",
            sessionId: this.resolveSessionId(),
            waitMs: startedAt - queuedAt,
            durationMs: Date.now() - startedAt,
          },
          "SessionDO persistence queue metrics",
        );
      }
    });
    this.persistenceQueue = run.catch((err: unknown) => {
      this.log.error({ error: serializeError(err) }, "Persistence task failed");
      Sentry.captureException(err, { tags: { operation: "persistenceQueue" } });
    });
    return run;
  }

  /** Queue a non-critical persistence task on the serialized persistence queue. */
  private enqueuePersistence(task: () => Promise<void>): void {
    void this.schedulePersistenceTask(task);
  }

  /** Run a critical persistence task on the serialized queue and await durable completion. */
  private async runCriticalPersistence(task: () => Promise<void>): Promise<void> {
    await this.schedulePersistenceTask(task);
  }

  private coerceDeadline(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /**
   * The current `sandboxReconnectGrace` lifecycle deadline (ms epoch), or null
   * when no reconnect is mid-flight. The admit path uses this to tell a genuine
   * in-flight reconnect apart from a dead `reconnecting` runtime whose grace
   * already lapsed (the sandbox-death review-listening wedge).
   */
  private async getSandboxReconnectGraceDeadlineMs(): Promise<number | null> {
    const stored = await this.state.storage.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY);
    return this.coerceDeadline(stored);
  }

  private logPastAlarmDeadlines(sessionId: string, candidates: SessionAlarmDeadlineCandidate[], now: number): void {
    for (const candidate of candidates) {
      this.log.warn(
        {
          event: "alarm_circuit_breaker",
          sessionId,
          deadlineSource: candidate.source,
          deadlineAt: candidate.deadlineAt,
          nowAt: now,
          deltaMs: now - candidate.deadlineAt,
        },
        "Skipped stale past SessionDO alarm deadline",
      );
    }
  }

  /**
   * Canonical alarm reducer: every call recomputes the next deadline purely
   * from current DB state and re-sets (or deletes) the DO alarm to match.
   *
   * Inputs (see candidates array below):
   *   - Sandbox reconnect grace (DO storage `LIFECYCLE_*` key + sandbox_state)
   *   - Sandbox liveness watchdog (DO storage key + prompt phase)
   *   - Prompt startup deadline (DO storage key + prompt phase)
   *   - Prompt dispatch-to-first-execution deadline (DO storage key + prompt phase)
   *   - Prompt running inactivity (DO storage key + prompt phase)
   *   - Spawn connect timeout (DO storage key + sandbox.status)
   *   - Disconnect-started + grace constant
   *   - Auto-close scheduled at
   *   - Prompt max-duration (prompts.started_at + max-duration constant)
   *   - Post-execution deadline (per-prompt platform_llm_prompt_status.started_at)
   *   - Publishing deadline (session.publishing_started_at)
   *
   * Each candidate is gated by `entry.valid` against the lifecycle state so
   * deadlines whose preconditions no longer hold are deleted in-place. This
   * is the structural alternative to paired arm/disarm helpers -- callers
   * mutate state, then invoke rescheduleSessionAlarm() to re-project.
   *
   * Emits `alarm.reprojected` with the winning source + delta so production
   * traffic can be audited end-to-end. Pairs with `alarm.noop_terminal_session`
   * emitted by alarm() when fired on an archived session.
   */
  private async rescheduleSessionAlarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sid = this.resolveSessionId();
      if (!sid) {
        await this.state.storage.deleteAlarm();
        return;
      }

      const candidates: SessionAlarmDeadlineCandidate[] = [];
      const now = Date.now();
      const lifecycleState = await this.readLifecycleState(sid);
      const sandbox = doDb.getSandboxState(this.sql, sid);
      const ext = doDb.getSessionExtended(this.sql, sid);
      const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sid);
      const activePrompt = activePromptId ? doDb.getPrompt(this.sql, activePromptId) : null;
      const hasActivePrompt = Boolean(activePromptId && activePrompt?.status === "processing");
      const hasActiveSandbox = Boolean(lifecycleState.sandbox.sandboxId ?? sandbox?.sandboxId);
      const lifecycleDeadlineSources = new Map<string, SessionAlarmDeadlineSource>([
        [LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, "sandboxReconnectGrace"],
        [LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, "sandboxLiveness"],
        [LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY, "promptStartup"],
        [LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY, "promptDispatch"],
        [LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, "promptRunningInactivity"],
        [LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, "spawnTimeout"],
      ]);
      const lifecycleDeadlineEntries = [
        {
          key: LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
          valid: Boolean(sandbox?.disconnectStartedAt) || lifecycleState.sandbox.state === "reconnecting",
        },
        {
          key: LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
          // Phase-independent: a ready/reconnecting sandbox whose socket goes
          // silent must converge to terminal even with no running prompt. The
          // reducer arms this deadline on ws_connected and every heartbeat.
          valid:
            (lifecycleState.sandbox.state === "ready" || lifecycleState.sandbox.state === "reconnecting") &&
            hasActiveSandbox,
        },
        {
          key: LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
          valid:
            hasActivePrompt &&
            (lifecycleState.prompt.phase === "queued" ||
              (lifecycleState.prompt.phase === "dispatching" && lifecycleState.prompt.codexPromptSentAt === null)),
        },
        {
          key: LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
          valid:
            hasActivePrompt &&
            lifecycleState.prompt.phase === "dispatching" &&
            lifecycleState.prompt.codexPromptSentAt !== null,
        },
        {
          key: LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
          valid: lifecycleState.prompt.phase === "running" && hasActivePrompt,
        },
        {
          key: LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
          valid:
            sandbox?.status === "spawning" ||
            lifecycleState.sandbox.spawnInProgress ||
            lifecycleState.sandbox.state === "spawning" ||
            lifecycleState.sandbox.state === "connecting",
        },
      ];
      const lifecycleDeadlines = await this.state.storage.get(lifecycleDeadlineEntries.map((entry) => entry.key));
      for (const entry of lifecycleDeadlineEntries) {
        const deadline = this.coerceDeadline(lifecycleDeadlines.get(entry.key));
        if (deadline === null) continue;
        if (!entry.valid) {
          await this.state.storage.delete(entry.key);
          continue;
        }
        const source = lifecycleDeadlineSources.get(entry.key);
        if (source) candidates.push({ source, deadlineAt: deadline });
      }
      if (sandbox?.disconnectStartedAt) {
        candidates.push({
          source: "disconnectStartedAt",
          deadlineAt: sandbox.disconnectStartedAt + SANDBOX_RECONNECT_GRACE_MS,
        });
      }
      if (sandbox?.autoCloseScheduledAt) {
        candidates.push({
          source: "autoCloseScheduledAt",
          deadlineAt: sandbox.autoCloseScheduledAt + getAutoCloseGraceMs(this.env as Env),
        });
      }
      if (activePrompt?.status === "processing" && activePrompt.startedAt) {
        candidates.push({
          source: "promptMaxDuration",
          deadlineAt: new Date(activePrompt.startedAt).getTime() + this.getPromptMaxDurationMs(),
        });
      }

      // ARC-876 watchdogs. Post-execution is per-prompt; multiple prompts may
      // overlap in `post_execution_pending` (the bridge backgrounds
      // post-execution so the queue can drain). Pick the soonest pending
      // deadline; the alarm handler then dispatches per-prompt.
      const pendingPostExec = doDb.getPlatformLlmPromptStatusesPending(this.sql, sid);
      for (const record of pendingPostExec) {
        if (record.startedAt === null) continue;
        candidates.push({
          source: "postExecutionDeadline",
          deadlineAt: record.startedAt + POST_EXECUTION_DEADLINE_MS,
        });
      }
      // Publishing is session-scoped (one publish in flight per session).
      if (ext?.publishStatus === "publishing" && ext.publishingStartedAt) {
        candidates.push({
          source: "publishingDeadline",
          deadlineAt: ext.publishingStartedAt + PUBLISHING_DEADLINE_MS,
        });
      }
      // ARC-1330 D-50A — the managed verification-comment retry alarm candidate was removed with the
      // comment surface.
      if (this.env.DB) {
        const slackNotificationRetry = await getNextDueSlackPostRetry(this.env.DB, sid, now);
        if (slackNotificationRetry != null) {
          candidates.push({
            source: "slackNotificationRetry",
            deadlineAt: slackNotificationRetry,
          });
        }
      }
      // ARC-1054: cleanup retry deadline. Its source is in
      // IMMEDIATE_CATCH_UP_ALARM_SOURCES so a past-due retry still fires.
      const e2bCleanupRetry = await this.state.storage.get<{ deadlineAt?: unknown }>(
        LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY,
      );
      if (
        e2bCleanupRetry &&
        typeof e2bCleanupRetry.deadlineAt === "number" &&
        Number.isFinite(e2bCleanupRetry.deadlineAt)
      ) {
        candidates.push({
          source: "e2bCleanupRetry",
          deadlineAt: e2bCleanupRetry.deadlineAt,
        });
      }
      const planParkPause = await this.state.storage.get<PlanParkPauseDeadline>(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY);
      if (planParkPause && Number.isFinite(planParkPause.deadlineAt)) {
        candidates.push({ source: "planParkPause", deadlineAt: planParkPause.deadlineAt });
      }
      const planReadyDelivery = await this.state.storage.get<PlanReadyDeliveryState>(PLAN_READY_DELIVERY_STORAGE_KEY);
      if (
        planReadyDelivery?.status === "pending" &&
        planReadyDelivery.nextAttemptAt !== null &&
        Number.isFinite(planReadyDelivery.nextAttemptAt)
      ) {
        candidates.push({ source: "planReadyNotificationRetry", deadlineAt: planReadyDelivery.nextAttemptAt });
      }
      // ARC-1330: bounded no-signal advance poll. The fire body owns the live CI read and the
      // re-arm/delete decision; this key is the durable schedule source.
      const noSignalAdvanceDeadline = this.coerceDeadline(
        await this.state.storage.get(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY),
      );
      if (noSignalAdvanceDeadline !== null) {
        candidates.push({ source: "fsmNoSignalAdvance", deadlineAt: noSignalAdvanceDeadline });
      }
      // ARC-1330 (PR 49, DE-3): precise REVIEW/VERIFYING state-deadline alarm. The deadline producer
      // already fires from alarm(); this candidate makes the shared DO alarm wake at the committed FSM
      // deadline instead of only opportunistically on another lifecycle timer. Scoped to the
      // post-publish live backstops this flip slice owns: gated on `reviewListeningActive` so only a
      // session actually in the post-publish review loop pays the `pr_coordination` read (an idle/
      // spawning/done session skips it entirely — this is a serialized alarm path). Only a FUTURE
      // deadline is projected; a past-due one is intentionally left to the opportunistic
      // `shadowFireDueDeadline` fire (see the `fsmStateDeadline` source doc — projecting past-due here
      // would tight-loop in shadow and churn in live). A mis-gated session degrades to that same
      // opportunistic fire, never a missed backstop.
      if (this.env.DB && ext?.reviewListeningActive) {
        const fsmRecord = await getPrCoordination(this.env.DB, sid).catch(() => null);
        const fsmDeadline = fsmRecord ? this.coerceDeadline(fsmRecord.deadlineAt) : null;
        if (
          fsmRecord &&
          (fsmRecord.state === "REVIEW" || fsmRecord.state === "VERIFYING") &&
          fsmDeadline !== null &&
          fsmDeadline > now
        ) {
          candidates.push({ source: "fsmStateDeadline", deadlineAt: fsmDeadline });
        }
      }

      const validCandidates = candidates.filter((candidate) => Number.isFinite(candidate.deadlineAt));
      const futureCandidates = validCandidates.filter((candidate) => candidate.deadlineAt > now);
      const pastCandidates = validCandidates.filter((candidate) => candidate.deadlineAt <= now);
      const catchUpCandidates = pastCandidates.filter((candidate) =>
        IMMEDIATE_CATCH_UP_ALARM_SOURCES.has(candidate.source),
      );
      const stalePastCandidates = pastCandidates.filter(
        (candidate) => !IMMEDIATE_CATCH_UP_ALARM_SOURCES.has(candidate.source),
      );
      const nextDeadline = futureCandidates.reduce<number | null>(
        (min, candidate) => (min === null ? candidate.deadlineAt : Math.min(min, candidate.deadlineAt)),
        null,
      );

      if (stalePastCandidates.length > 0) {
        this.logPastAlarmDeadlines(sid, stalePastCandidates, now);
      }
      if (catchUpCandidates.length > 0) {
        const catchUpAt = now + MIN_ALARM_DELAY_MS;
        await this.state.storage.setAlarm(catchUpAt);
        this.log.info(
          {
            event: "alarm.reprojected",
            sessionId: sid,
            decision: "catch_up",
            // Uniform schema across all three decisions so Datadog joins
            // on deadlineSource + deadlineAt cover catch_up rows too.
            // The first past-due candidate drives the scheduled time.
            deadlineSource: catchUpCandidates[0].source,
            catchUpSources: catchUpCandidates.map((candidate) => candidate.source),
            deadlineAt: catchUpAt,
            deltaMs: MIN_ALARM_DELAY_MS,
          },
          "Alarm reprojected: catching up on past-due deadline",
        );
        return;
      }
      if (nextDeadline === null) {
        await this.state.storage.deleteAlarm();
        this.log.info(
          {
            event: "alarm.reprojected",
            sessionId: sid,
            decision: "noop",
            deadlineSource: null,
            deadlineAt: null,
            deltaMs: null,
          },
          "Alarm reprojected: no active deadline",
        );
        return;
      }
      // futureCandidates is non-empty when nextDeadline is non-null (Math.min
      // over those candidates produced it), so the matching find() always
      // returns a candidate. The non-null assertion expresses that invariant
      // rather than masking a hypothetical fallback.
      const winningSource = futureCandidates.find((candidate) => candidate.deadlineAt === nextDeadline)!.source;
      const scheduledAt = Math.max(nextDeadline, now + MIN_ALARM_DELAY_MS);
      await this.state.storage.setAlarm(scheduledAt);
      this.log.info(
        {
          event: "alarm.reprojected",
          sessionId: sid,
          decision: "scheduled",
          deadlineSource: winningSource,
          deadlineAt: scheduledAt,
          deltaMs: scheduledAt - now,
        },
        "Alarm reprojected: next deadline scheduled",
      );
    });
  }

  /** Buffer text/reasoning deltas for batch persistence (flushed after TEXT_DELTA_FLUSH_MS). */
  private bufferTextDelta(sessionId: string, entries: DurableEntry[], promptId?: string): void {
    this.textDeltaBuffer.push(...entries);
    this.textDeltaBufferMeta = { sessionId, promptId };
    if (this.textDeltaFlushTimer === null) {
      const scheduledAt = Date.now();
      this.textDeltaFlushTimer = setTimeout(() => {
        this.textDeltaFlushTimer = null;
        this.enqueuePersistence(() => this.flushTextDeltaBuffer(scheduledAt));
      }, TEXT_DELTA_FLUSH_MS);
    }
  }

  /** Flush all buffered text deltas to durable storage. */
  private async flushTextDeltaBuffer(scheduledAt?: number): Promise<void> {
    if (this.textDeltaFlushTimer !== null) {
      clearTimeout(this.textDeltaFlushTimer);
      this.textDeltaFlushTimer = null;
    }
    if (this.textDeltaBuffer.length === 0 || !this.textDeltaBufferMeta) return;

    const entries = this.textDeltaBuffer;
    const meta = this.textDeltaBufferMeta;
    this.textDeltaBuffer = [];
    this.textDeltaBufferMeta = null;

    const startedAt = Date.now();
    await this.appendAndBroadcastEvents(meta.sessionId, entries, meta.promptId);
    this.log.info(
      {
        event: "session.text_delta_flush.metrics",
        sessionId: meta.sessionId,
        promptId: meta.promptId ?? null,
        eventCount: entries.length,
        flushLagMs: scheduledAt !== undefined ? startedAt - scheduledAt : null,
        durationMs: Date.now() - startedAt,
      },
      "SessionDO text delta flush metrics",
    );
  }

  // ---------------------------------------------------------------------------
  // Sandbox message processing
  // ---------------------------------------------------------------------------

  /**
   * Process an incoming sandbox WebSocket message.
   * Critical transitions persist before durable fanout; text/reasoning deltas
   * still use the buffered low-latency path.
   */
  private async processSandboxMessage(
    data: string | ArrayBuffer,
    session: SessionState,
    connectionGeneration?: number | null,
  ): Promise<void> {
    let parsed: Record<string, unknown>;
    let transportEvent: (CycloidEvent & { ackId?: string }) | null = null;
    let bridgeLatencySourceTs: number | null = null;
    try {
      const rawParsed = JSON.parse(String(data)) as unknown;
      if (typeof rawParsed !== "object" || rawParsed === null || Array.isArray(rawParsed)) {
        return;
      }
      if (
        typeof (rawParsed as { phase?: unknown }).phase === "string" &&
        typeof (rawParsed as { sessionId?: unknown }).sessionId === "string" &&
        typeof (rawParsed as { timestampMs?: unknown }).timestampMs === "number" &&
        typeof (rawParsed as { payload?: unknown }).payload === "object" &&
        (rawParsed as { payload?: unknown }).payload !== null &&
        !Array.isArray((rawParsed as { payload?: unknown }).payload)
      ) {
        try {
          // Redact injected secrets once at ingestion so every outbound surface
          // derived from this event is scrubbed: the live WS broadcast (via
          // translateCycloidEventToSandboxEvent) and the persisted/replayed
          // projection (via projectCycloidEventToDurableEntry). Field-precise, so
          // tool args/diffs/text survive minus the secret substrings.
          transportEvent = redactCycloidEventSecrets({
            ...(validateCycloidEvent(rawParsed) as CycloidEvent),
            ...(typeof (rawParsed as { ackId?: unknown }).ackId === "string"
              ? { ackId: (rawParsed as { ackId: string }).ackId }
              : {}),
          });
          if (transportEvent.sessionId !== session.sessionId) {
            this.log.warn(
              {
                event: "durable.session_id_mismatch",
                expected: session.sessionId,
                received: transportEvent.sessionId,
              },
              "Dropping sandbox event with mismatched sessionId",
            );
            return;
          }
          parsed = translateCycloidEventToSandboxEvent(transportEvent);
          bridgeLatencySourceTs = transportEvent.timestampMs;
        } catch {
          const envelopeSessionId = (rawParsed as { sessionId: string }).sessionId;
          if (envelopeSessionId !== session.sessionId) {
            this.log.warn(
              {
                event: "durable.session_id_mismatch",
                expected: session.sessionId,
                received: envelopeSessionId,
              },
              "Dropping sandbox event with mismatched sessionId",
            );
            return;
          }
          const payload = (rawParsed as { payload?: unknown }).payload;
          const bridgeEventType =
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as { bridgeEventType?: unknown }).bridgeEventType
              : undefined;
          if (typeof bridgeEventType === "string" && REMOVED_BRIDGE_EVENT_TYPES.has(bridgeEventType)) {
            const ackId =
              typeof (rawParsed as { ackId?: unknown }).ackId === "string"
                ? (rawParsed as { ackId: string }).ackId
                : null;
            this.sendSandboxAck(ackId);
            this.log.warn({ sessionId: session.sessionId, type: bridgeEventType }, "Dropping removed bridge event");
            return;
          }
          parsed = rawParsed as Record<string, unknown>;
          bridgeLatencySourceTs = typeof parsed.timestamp === "number" ? parsed.timestamp : null;
        }
      } else {
        parsed = rawParsed as Record<string, unknown>;
        bridgeLatencySourceTs = typeof parsed.timestamp === "number" ? parsed.timestamp : null;
      }
    } catch {
      return;
    }

    if (!parsed || typeof parsed.type !== "string") return;
    if (connectionGeneration !== undefined && connectionGeneration !== null) {
      parsed.connectionGeneration = connectionGeneration;
    }

    const bridgeLatencyMs = bridgeLatencySourceTs ? Date.now() - bridgeLatencySourceTs : null;
    this.log.debug({ event: "durable.incoming_event", type: parsed.type, bridgeLatencyMs }, "Incoming sandbox message");

    if (REMOVED_BRIDGE_EVENT_TYPES.has(parsed.type)) {
      this.sendSandboxAck(typeof parsed.ackId === "string" ? parsed.ackId : null);
      this.log.warn({ sessionId: session.sessionId, type: parsed.type }, "Dropping removed bridge event");
      return;
    }

    if (parsed.type === "execution_complete") {
      const rawEvent = parsed as unknown as Extract<SandboxEvent, { type: "execution_complete" }>;
      const terminalOutcome = normalizeTerminalOutcome({
        success: rawEvent.success === true,
        error: rawEvent.error,
        errorCode: rawEvent.errorCode,
        errorDetails: rawEvent.errorDetails,
      });
      Object.assign(parsed, {
        success: terminalOutcome.success,
        error: terminalOutcome.error ?? undefined,
        errorCode: terminalOutcome.errorCode ?? undefined,
        errorDetails: terminalOutcome.errorDetails ?? undefined,
      });
      if (transportEvent) {
        const payload = transportEvent.payload as Record<string, unknown>;
        const bridgeData =
          payload.bridgeData && typeof payload.bridgeData === "object" && !Array.isArray(payload.bridgeData)
            ? (payload.bridgeData as Record<string, unknown>)
            : {};
        transportEvent = {
          ...transportEvent,
          payload: {
            ...payload,
            success: terminalOutcome.success,
            error: terminalOutcome.error ?? undefined,
            errorCode: terminalOutcome.errorCode ?? undefined,
            errorDetails: terminalOutcome.errorDetails ?? undefined,
            bridgeData: {
              ...bridgeData,
              success: terminalOutcome.success,
              error: terminalOutcome.error ?? undefined,
              errorCode: terminalOutcome.errorCode ?? undefined,
              errorDetails: terminalOutcome.errorDetails ?? undefined,
            },
          },
        } as CycloidEvent & { ackId?: string };
      }
      if (terminalOutcome.coerced) {
        this.log.warn(
          {
            event: "terminal_outcome_coerced",
            source: "control-plane",
            raw_success: true,
            normalized_outcome: "failed",
            error_code: terminalOutcome.errorCode,
          },
          "Coerced contradictory terminal outcome to failed",
        );
      }
      if (terminalOutcome.rawErrorCode) {
        this.log.warn(
          {
            event: "terminal_error_code_coerced",
            source: "control-plane",
            raw_error_code: terminalOutcome.rawErrorCode,
          },
          "Coerced terminal error code outside the ErrorCode union to unknown",
        );
      }
    }

    // Derive activePromptId from the prompts table (in-process DO SQLite,
    // sync); fall back to the bridge's messageId if no prompt is currently
    // processing (e.g. bridge sent the event after we marked the prompt
    // terminal but before the socket carried the completion).
    const derivedActivePromptId = doDb.getActiveProcessingPromptId(this.sql, session.sessionId);
    const activePromptId =
      derivedActivePromptId || (typeof parsed.messageId === "string" ? parsed.messageId : undefined);
    const promptActivityPromptId =
      parsed.type === "prompt_activity" && typeof parsed.promptId === "string" ? parsed.promptId : null;
    const shouldResetAgentActivity =
      parsed.type !== "prompt_activity" ||
      (promptActivityPromptId !== null && promptActivityPromptId === activePromptId);
    const eventPromptId =
      typeof parsed.messageId === "string"
        ? parsed.messageId
        : parsed.type === "prompt_activity"
          ? (promptActivityPromptId ?? undefined)
          : activePromptId;
    const ackId = typeof parsed.ackId === "string" && parsed.ackId.length > 0 ? parsed.ackId : null;
    const timestamp = nowIso();
    const projectedEvent = transportEvent ? projectCycloidEventToDurableEntry(transportEvent) : null;
    const runningActivity =
      activePromptId &&
      FIRST_EXECUTION_EVENT_TYPES.has(parsed.type) &&
      shouldResetAgentActivity &&
      parsed.type !== "prompt_activity" &&
      typeof eventPromptId === "string" &&
      typeof parsed.sandboxId === "string"
        ? {
            promptId: eventPromptId,
            sandboxId: parsed.sandboxId,
            startupAttemptId: typeof parsed.startupAttemptId === "string" ? parsed.startupAttemptId : null,
          }
        : null;
    let runningActivityPromise: Promise<LifecycleDecision[]> | null = null;
    const awaitRunningActivity = async (): Promise<void> => {
      if (!runningActivity) return;
      runningActivityPromise ??= this.processLifecycleEvent(session.sessionId, {
        type: "prompt.running_activity",
        ...runningActivity,
      });
      await runningActivityPromise;
    };
    const promptActivityPhase =
      parsed.type === "prompt_activity"
        ? (() => {
            const payload = transportEvent?.payload;
            if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
              const bridgeData = (payload as { bridgeData?: unknown }).bridgeData;
              if (typeof bridgeData === "object" && bridgeData !== null && !Array.isArray(bridgeData)) {
                const phase = (bridgeData as { phase?: unknown }).phase;
                if (typeof phase === "string") return phase;
              }
            }
            return typeof parsed.phase === "string" ? parsed.phase : "";
          })()
        : "";
    let promptActivityHasActiveToolCall = false;

    const event = parsed as unknown as SandboxEvent;

    if (eventPromptId && (event.type === "tool_call" || event.type === "tool_update")) {
      const activeToolTracking = this.trackActiveToolCallEvent(eventPromptId, event).catch((err) => {
        this.log.warn(
          {
            sessionId: session.sessionId,
            promptId: eventPromptId,
            eventType: parsed.type,
            error: serializeError(err),
          },
          "Failed to update active prompt tool-call tracking",
        );
      });
      this.ctx.waitUntil(activeToolTracking);
    }

    if (parsed.type === "heartbeat" && typeof parsed.sandboxId === "string") {
      await this.processLifecycleEvent(session.sessionId, {
        type: "sandbox.heartbeat_received",
        sandboxId: parsed.sandboxId,
      });
      await this.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl("heartbeat");
      // Application-level liveness echo. Replying only AFTER the heartbeat has
      // been processed proves the DO event loop is alive and draining work --
      // the bridge keys inbound liveness on this typed echo, not on the protocol
      // pong answered by the edge / `setWebSocketAutoResponse`. Best-effort: a
      // missing nonce (older bridge) or closed socket simply skips the echo.
      if (typeof parsed.echoNonce === "string") {
        const sandboxSocket = this.getSandboxSocket();
        if (sandboxSocket) {
          try {
            sandboxSocket.send(JSON.stringify({ type: "heartbeat_echo", echoNonce: parsed.echoNonce }));
          } catch (err) {
            this.log.warn({ error: serializeError(err) }, "Failed to send heartbeat echo to sandbox");
          }
        }
      }
      this.broadcast({ type: "sandbox_event", event });
      return;
    }

    // Prompt activity excludes background liveness messages so heartbeats cannot
    // mask a stuck agent.
    if (parsed.type === "prompt_accepted") {
      if (typeof parsed.messageId === "string" && typeof parsed.sandboxId === "string") {
        await this.processLifecycleEvent(session.sessionId, {
          type: "prompt.bridge_accepted",
          promptId: parsed.messageId,
          sandboxId: parsed.sandboxId,
          startupAttemptId: typeof parsed.startupAttemptId === "string" ? parsed.startupAttemptId : null,
        });
      }
      this.recordRuntimeActivity(session.sessionId, "prompt_accepted");
      await awaitRunningActivity();
      await this.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl("prompt_event");
      return;
    }

    // memory_usage is handled through the projected durable-event path so D1 telemetry
    // stays aligned with the transport event that was actually persisted.

    // Persist Codex session ID + agent (no broadcast needed)
    if (parsed.type === "agent_session_created") {
      const opcSessionId = parsed.agentSessionId as string;
      if (opcSessionId) {
        const opcSid = this.resolveSessionId();
        if (opcSid) {
          const agentRuntimeBackend = resolveAgentRuntimeBackend(parsed.agentRuntimeBackend as string | undefined);
          this.enqueuePersistence(async () => {
            doDb.updateSessionFields(this.sql, opcSid, {
              agentSessionId: opcSessionId,
              agentSessionAgent: (parsed.agent as string) || "",
              agentRuntimeBackend,
            });
          });
        }
      }
      await awaitRunningActivity();
      return;
    }

    if (parsed.type === "agent_prompt_sent") {
      if (typeof parsed.messageId === "string" && typeof parsed.sandboxId === "string") {
        await this.processLifecycleEvent(session.sessionId, {
          type: "prompt.agent_prompt_sent",
          promptId: parsed.messageId,
          sandboxId: parsed.sandboxId,
          startupAttemptId: typeof parsed.startupAttemptId === "string" ? parsed.startupAttemptId : null,
        });
      }
      this.recordRuntimeActivity(session.sessionId, "agent_prompt_sent");
      await this.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl("activity");
      return;
    }

    if (parsed.type === "prompt_telemetry_start") {
      const promptId = typeof parsed.promptId === "string" ? parsed.promptId : null;
      const btSpanId = normalizeTelemetryId(parsed.btSpanId);
      if (promptId && btSpanId) {
        this.enqueuePersistence(async () => {
          doDb.upsertPromptTraceTelemetry(this.sql, promptId, { btSpanId });
        });
      }
      await awaitRunningActivity();
      return;
    }

    if (parsed.type === "estimated_input_composition") {
      if (eventPromptId) {
        this.recordEstimatedInputComposition(eventPromptId, parsed);
      } else {
        this.log.warn({ sessionId: session.sessionId }, "Dropping estimated input composition without promptId");
      }
      await awaitRunningActivity();
      return;
    }

    if (parsed.type === "prompt_activity") {
      if (typeof promptActivityPromptId === "string" && typeof parsed.sandboxId === "string") {
        if (
          promptActivityPhase === "prompt_dispatching" ||
          promptActivityPhase === "agent_runtime_initializing" ||
          promptActivityPhase === "session_creating" ||
          promptActivityPhase === "event_subscribing"
        ) {
          await this.processLifecycleEvent(session.sessionId, {
            type: "prompt.dispatching_progress",
            promptId: promptActivityPromptId,
            sandboxId: parsed.sandboxId,
            startupAttemptId: typeof parsed.startupAttemptId === "string" ? parsed.startupAttemptId : null,
          });
        } else if (promptActivityPhase === "waiting_for_agent_event") {
          promptActivityHasActiveToolCall = await this.hasActiveToolCall(promptActivityPromptId);
          // Waiting pulses are bridge/model polling, not proof of useful agent work.
          // They only extend running inactivity while an already-emitted tool call
          // is open, so long commands and desktop tools stay exempt without letting
          // generic model wait mask a dead prompt.
          await this.processLifecycleEvent(session.sessionId, {
            type: "prompt.running_keepalive",
            promptId: promptActivityPromptId,
            sandboxId: parsed.sandboxId,
            activeToolCall: promptActivityHasActiveToolCall,
          });
        }
      }
      if (!shouldResetAgentActivity) {
        this.log.debug(
          {
            event: "durable.prompt_activity_ignored",
            promptId: promptActivityPromptId,
            activePromptId,
          },
          "Ignoring prompt activity for non-active prompt",
        );
        return;
      }
      if (promptActivityPhase !== "waiting_for_agent_event" || promptActivityHasActiveToolCall) {
        this.recordRuntimeActivity(session.sessionId, `prompt_activity:${promptActivityPhase || "unknown"}`);
      }
    }

    // Legacy: skip redundant codex_event
    if (parsed.type === "codex_event") {
      await awaitRunningActivity();
      return;
    }

    if (PROJECTED_BRIDGE_EVENT_TYPES.has(parsed.type)) {
      const durableProjectedEvent = projectedEvent;
      if (!durableProjectedEvent) {
        return;
      }

      const isIdle = durableProjectedEvent.type === "session_idle";
      const isCriticalBridgeEvent =
        CRITICAL_BRIDGE_EVENT_TYPES.has(parsed.type) || CRITICAL_BRIDGE_EVENT_TYPES.has(durableProjectedEvent.type);
      const persistableEntries = isIdle
        ? []
        : [
            {
              ...durableProjectedEvent,
              ...(ackId && isCriticalBridgeEvent ? { eventId: this.buildAckEventId(session.sessionId, ackId) } : {}),
            },
          ];

      // Classify: text-only events can be buffered for batch persistence
      const isTextOnly =
        persistableEntries.length > 0 && persistableEntries.every((e) => e.type === "text" || e.type === "reasoning");

      if (isTextOnly && !isIdle && !isCriticalBridgeEvent) {
        // Buffer text deltas for batch persistence (50ms flush interval)
        this.bufferTextDelta(session.sessionId, persistableEntries, activePromptId);
      } else if (persistableEntries.length > 0) {
        // Structured events: flush buffered text first, then persist.
        const persistStructuredEvents = async () => {
          await this.flushTextDeltaBuffer();

          if (durableProjectedEvent.type === "question" && eventPromptId) {
            doDb.updatePrompt(this.sql, eventPromptId, { hasPendingQuestion: true });
          }

          // Accumulate usage data in durable storage (survives DO eviction, immune to event compaction)
          if (parsed.type === "usage" && eventPromptId) {
            await this.accumulateUsage(eventPromptId, parsed);
          }

          const eventState = await this.appendAndBroadcastEvents(session.sessionId, persistableEntries, eventPromptId);

          if (eventPromptId && (eventState.newReplayEvents?.length ?? 0) > 0) {
            try {
              // Incrementally count tool calls per prompt (avoids full events-blob read in finalizePromptRun).
              if (parsed.type === "tool_call") {
                doDb.incrementToolCallCount(this.sql, eventPromptId);
              } else if (parsed.type === "tool_update") {
                const update = parsed as Extract<SandboxEvent, { type: "tool_update" }>;
                doDb.incrementPromptToolStats(this.sql, eventPromptId, update);
              }
            } catch (err) {
              this.log.warn(
                {
                  sessionId: session.sessionId,
                  promptId: eventPromptId,
                  eventType: parsed.type,
                  error: serializeError(err),
                },
                "Failed to update prompt tool analytics ledger",
              );
            }

            if (parsed.type === "tool_update") {
              try {
                const update = parsed as Extract<SandboxEvent, { type: "tool_update" }>;
                const promptAgent = doDb.getPrompt(this.sql, eventPromptId)?.agent ?? null;
                emitToolCallObservedEvent(this.log, {
                  sessionId: session.sessionId,
                  promptId: eventPromptId,
                  businessId: session.businessId ?? null,
                  ownerUserId: Number(session.ownerUserId),
                  agent: promptAgent,
                  callId: update.callId,
                  toolName: update.tool,
                  status: update.status,
                  durationMs: update.durationMs,
                  failure: update.failure,
                });
              } catch (err) {
                this.log.warn(
                  {
                    sessionId: session.sessionId,
                    promptId: eventPromptId,
                    eventType: parsed.type,
                    error: serializeError(err),
                  },
                  "Failed to emit per-tool-call telemetry event",
                );
              }
            }
          }

          if (
            durableProjectedEvent.type === "question" &&
            eventPromptId &&
            (eventState.newReplayEvents?.length ?? 0) > 0
          ) {
            // The question event is now durable and replay-visible, so it is safe to
            // re-project rich status and broadcast `waiting_for_input`. Broadcasting
            // earlier would let the UI flip to a waiting state without an
            // accompanying question event to render. The newReplayEvents guard
            // prevents an extra broadcast when the sandbox redelivers an already
            // persisted question (deduped via event_id).
            //
            // Sandbox event-processing loop: swallow projection rejection so
            // a transient D1 failure does not halt processing of subsequent
            // sandbox events in this batch.
            await this.swallowLifecyclePersistence(
              session.sessionId,
              "pending_question_set",
              () => this.persistAndBroadcastSessionStatus(session.sessionId, "pending_question_set"),
              "",
            );
            // The agent is blocked until the owner answers; DM them. DO-resident
            // (storage gate), callbackContext makes the Slack-origin team
            // authoritative. dedupKey = questionId: one DM per distinct question.
            const questionId = typeof parsed.questionId === "string" ? parsed.questionId : "";
            const questionOwnerUserId = Number(session.ownerUserId);
            if (questionId && Number.isSafeInteger(questionOwnerUserId) && questionOwnerUserId > 0) {
              // Resolve callbackContext best-effort: this runs synchronously inside
              // runCriticalPersistence, so a getSessionExtended SQLite error must not
              // escape and abort critical event processing (mirrors the
              // MissingProviderKey site). callbackContext only refines Slack-team
              // resolution; notifyUserBlocked falls back to linked-team / single-workspace.
              let questionCallbackContext: CallbackContext | undefined;
              try {
                questionCallbackContext =
                  doDb.getSessionExtended(this.sql, session.sessionId)?.callbackContext ?? undefined;
              } catch (error) {
                this.log.warn(
                  { sessionId: session.sessionId, error: String(error) },
                  "awaiting-question DM: getSessionExtended failed; proceeding without callbackContext",
                );
              }
              await notifyUserBlocked(this.env, {
                sessionId: session.sessionId,
                ownerUserId: questionOwnerUserId,
                callbackContext: questionCallbackContext,
                kind: BlockerKind.AwaitingQuestion,
                dedupKey: questionId,
                storage: this.state.storage,
              });
            } else {
              // Should be unreachable: cycloid-event-store rejects question events
              // without a questionId during persistence, and the owner id is set at
              // session create. Log a trace so a bridge regression / schema drift that
              // drops the DM is diagnosable rather than silent.
              this.log.warn(
                { sessionId: session.sessionId, hasQuestionId: !!questionId, ownerUserId: session.ownerUserId },
                "awaiting-question DM skipped: missing questionId or invalid owner id",
              );
            }
          }

          if (parsed.type === "memory_usage" && eventPromptId) {
            const memoryIds = parsed.activeMemoryIds as string[] | undefined;
            const memEnv = this.env as Env;
            if (memoryIds?.length && memEnv.DB) {
              this.ctx.waitUntil(
                import("../memory/db.js")
                  .then(({ recordMemoryUsage, recordMemoryUsageEvents }) => {
                    const refs = Array.isArray(parsed.activeMemories) ? parsed.activeMemories : [];
                    return Promise.all([
                      recordMemoryUsage(memEnv.DB!, memoryIds, session.sessionId, eventPromptId),
                      recordMemoryUsageEvents(
                        memEnv.DB!,
                        memoryIds.map((memoryId, index) => {
                          const ref = refs.find(
                            (candidate) =>
                              candidate &&
                              typeof candidate === "object" &&
                              (candidate as Record<string, unknown>).id === memoryId,
                          ) as Record<string, unknown> | undefined;
                          return {
                            repoOwner: typeof parsed.repoOwner === "string" ? parsed.repoOwner : null,
                            repoName: typeof parsed.repoName === "string" ? parsed.repoName : null,
                            sessionId: session.sessionId,
                            promptId: eventPromptId,
                            memoryId,
                            source: "prompt_start" as const,
                            selectionRank: typeof ref?.selectionRank === "number" ? ref.selectionRank : index + 1,
                            selectionScore: typeof ref?.selectionScore === "number" ? ref.selectionScore : null,
                            explanation: typeof ref?.reason === "string" ? ref.reason : null,
                            expectedEffect: typeof ref?.expectedEffect === "string" ? ref.expectedEffect : null,
                          };
                        }),
                      ),
                    ]);
                  })
                  .catch((err) => {
                    this.log.error(
                      { sessionId: session.sessionId, promptId: eventPromptId, error: serializeError(err) },
                      "Memory usage recording failed",
                    );
                  }),
              );
            }
          }

          if (
            parsed.type === "memory_recall_usage" &&
            eventPromptId &&
            (parsed.eventName === "memory_recall.returned" || parsed.eventName === "memory_context.returned")
          ) {
            const returnedMemoryIds = parsed.returnedMemoryIds as string[] | undefined;
            const memEnv = this.env as Env;
            if (returnedMemoryIds?.length && memEnv.DB) {
              this.ctx.waitUntil(
                import("../memory/db.js")
                  .then(({ recordMemoryUsageEvents }) => {
                    const refs = Array.isArray(parsed.returnedMemories) ? parsed.returnedMemories : [];
                    const source = parsed.usageSource === "company_recall" ? "company_recall" : "recall";
                    const usedAt =
                      typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
                        ? parsed.timestamp
                        : undefined;
                    return recordMemoryUsageEvents(
                      memEnv.DB!,
                      returnedMemoryIds.map((memoryId, index) => {
                        const ref = refs.find(
                          (candidate) =>
                            candidate &&
                            typeof candidate === "object" &&
                            (candidate as Record<string, unknown>).id === memoryId,
                        ) as Record<string, unknown> | undefined;
                        return {
                          repoOwner: typeof parsed.repoOwner === "string" ? parsed.repoOwner : null,
                          repoName: typeof parsed.repoName === "string" ? parsed.repoName : null,
                          sessionId: session.sessionId,
                          promptId: eventPromptId,
                          memoryId,
                          source,
                          selectionRank: typeof ref?.selectionRank === "number" ? ref.selectionRank : index + 1,
                          selectionScore: typeof ref?.selectionScore === "number" ? ref.selectionScore : null,
                          explanation: typeof ref?.reason === "string" ? ref.reason : null,
                          expectedEffect: typeof ref?.expectedEffect === "string" ? ref.expectedEffect : null,
                          intent: typeof parsed.intent === "string" ? parsed.intent : null,
                          filesJson: Array.isArray(parsed.files) ? JSON.stringify(parsed.files) : null,
                          symbolsJson: Array.isArray(parsed.symbols) ? JSON.stringify(parsed.symbols) : null,
                          usedAt,
                        };
                      }),
                    );
                  })
                  .catch((err) => {
                    this.log.error(
                      { sessionId: session.sessionId, promptId: eventPromptId, error: serializeError(err) },
                      "Memory recall usage recording failed",
                    );
                  }),
              );
            }
          }
        };
        if (isCriticalBridgeEvent) {
          await this.runCriticalPersistence(persistStructuredEvents);
          this.sendSandboxAck(ackId);
        } else {
          this.enqueuePersistence(persistStructuredEvents);
        }
      }

      if (isIdle) {
        const idleEvent = event as Extract<SandboxEvent, { type: "session_idle" }>;
        this.recordRuntimeActivity(session.sessionId, "session_idle");
        this.log.info(
          {
            event: "prompt.terminal.received",
            sessionId: session.sessionId,
            promptId: idleEvent.messageId,
            source: "session_idle",
          },
          "Prompt terminal received",
        );
        // Flush all buffered events and complete the prompt
        await this.runCriticalPersistence(async () => {
          await this.flushTextDeltaBuffer();
          await this.promptQueue.handleSessionIdle(idleEvent, session.sessionId);
        });
      }
      await awaitRunningActivity();
      return;
    }

    // --- Native sandbox events (no translation) ---
    await this.runObservedSpan(
      "do.sandbox_event_ingest",
      this.buildTraceAttributes(session.sessionId, "messageId" in event ? event.messageId : null, {
        "sandbox.event_type": event.type,
        ...(event.sandboxId ? { "sandbox.id": event.sandboxId } : {}),
      }),
      async () => {
        this.log.debug({ event: "durable.sandbox_event", type: event.type }, "Native sandbox event");
        if (event.type === "sandbox_undersized") {
          // Internal "this customer needs a bigger sandbox" dev alert. Handled as
          // a pure side-effect (Slack + Datadog) and intentionally NOT broadcast,
          // persisted, or projected into the customer's session timeline. The base
          // session row does not carry repo owner/name (only getSessionExtended
          // maps them), so read the extended row to identify the offending repo.
          const extended = doDb.getSessionExtended(this.sql, session.sessionId);
          const sandbox = doDb.getSandboxState(this.sql, session.sessionId);
          const repoOwner = extended?.repoOwner ?? null;
          const repoName = extended?.repoName ?? null;
          // Re-resolve the (pure-config) spec to name the template and the
          // resources that proved too small. Best-effort: a resolution failure
          // (e.g. unconfigured base template) must not drop the alert.
          let spec: ReturnType<typeof resolveRepoSandboxSpec> | null = null;
          if (repoOwner && repoName) {
            try {
              spec = resolveRepoSandboxSpec(this.env, repoOwner, repoName);
            } catch {
              spec = null;
            }
          }
          this.ctx.waitUntil(
            notifySandboxUndersized(this.env, {
              sessionId: session.sessionId,
              ownerUserId: session.ownerUserId,
              sandboxId: sandbox?.runtimeSandboxId ?? null,
              runtimeBackend: sandbox?.runtimeBackend ?? null,
              repoOwner,
              repoName,
              businessId: session.businessId ?? null,
              oomKills: event.oomKills,
              victimComm: event.victimComm ?? null,
              victimPid: event.victimPid ?? null,
              victimRssMb: event.victimRssMb ?? null,
              runtimeTemplateId: spec?.runtimeTemplateId ?? null,
              cpuCount: spec?.cpuCount ?? null,
              memoryMB: spec?.memoryMB ?? null,
              // "repo" once the repo already has an explicit repo-sandbox-specs
              // entry — the alert then says the tier was exceeded, not "add one".
              specSource: spec?.source ?? null,
            }),
          );
          return;
        }
        if (event.type === "sandbox_enospc") {
          // Real disk-full OUTCOME: a git op failed with an ENOSPC signature. Pure
          // Datadog side-effect (a COUNT the disk monitor pages off), NOT broadcast,
          // persisted, or projected into the customer timeline. Base row lacks repo
          // owner/name, so read the extended row (low-cardinality tags only).
          const extended = doDb.getSessionExtended(this.sql, session.sessionId);
          this.ctx.waitUntil(
            notifySandboxEnospc(this.env, {
              repoOwner: extended?.repoOwner ?? null,
              repoName: extended?.repoName ?? null,
              businessId: session.businessId ?? null,
              source: event.source ?? null,
            }),
          );
          return;
        }
        if (event.type === "sandbox_resource_sample") {
          // Continuous per-session resource gauges (memory/swap/disk/cpu). Like
          // sandbox_undersized: a pure Datadog side-effect, NOT broadcast,
          // persisted, or projected into the customer timeline. The base row
          // lacks repo owner/name, so read the extended row (used only for the
          // low-cardinality metric tags — session/sandbox stay out of the tags).
          const extended = doDb.getSessionExtended(this.sql, session.sessionId);
          this.ctx.waitUntil(
            emitSandboxResourceGauges(this.env, {
              repoOwner: extended?.repoOwner ?? null,
              repoName: extended?.repoName ?? null,
              businessId: session.businessId ?? null,
              memoryUsedBytes: event.memoryUsedBytes,
              memoryLimitBytes: event.memoryLimitBytes,
              memoryUsedPercent: event.memoryUsedPercent,
              swapUsedBytes: event.swapUsedBytes,
              cpuUsedPercent: event.cpuUsedPercent,
              cpuThrottledPeriodsPercent: event.cpuThrottledPeriodsPercent,
              cpuPressureAvg10: event.cpuPressureAvg10,
              memoryPressureAvg10: event.memoryPressureAvg10,
              memoryHighEventsDelta: event.memoryHighEventsDelta,
              memoryOomEventsDelta: event.memoryOomEventsDelta,
              memoryOomKillEventsDelta: event.memoryOomKillEventsDelta,
              pidsCurrent: event.pidsCurrent,
              pidsLimit: event.pidsLimit,
              pidsUsedPercent: event.pidsUsedPercent,
              pidsMaxEventsDelta: event.pidsMaxEventsDelta,
              disks: event.disks,
            }),
          );
          return;
        }
        const isCriticalNativeEvent = CRITICAL_NATIVE_SANDBOX_EVENT_TYPES.has(event.type);
        if (!isCriticalNativeEvent) {
          this.broadcast({
            type: "sandbox_event",
            event:
              event.type === "memory_recall_usage"
                ? (omitMemoryRecallTraceFields(event as unknown as Record<string, unknown>) as unknown as typeof event)
                : event,
          });
        }

        const durableEntry: DurableEntry = projectedEvent
          ? {
              ...projectedEvent,
              ...(ackId ? { eventId: this.buildAckEventId(session.sessionId, ackId) } : {}),
            }
          : {
              type: `sandbox_${event.type}`,
              timestamp,
              data: parsed,
              ...(ackId ? { eventId: this.buildAckEventId(session.sessionId, ackId) } : {}),
            };

        if (event.type === "execution_complete") {
          this.recordRuntimeActivity(session.sessionId, "execution_complete");
          this.log.info(
            {
              event: "prompt.terminal.received",
              sessionId: session.sessionId,
              promptId: event.messageId,
              source: "execution_complete",
              success: event.success,
              ...(event.sandboxId ? { sandboxId: event.sandboxId } : {}),
            },
            "Prompt terminal received",
          );
          const terminalPrompt = doDb.getPrompt(this.sql, event.messageId);
          const gatedPlanWillPark =
            session.planApprovalRequired === true &&
            terminalPrompt != null &&
            isPlanModePlanPrompt(session, terminalPrompt);
          await this.processLifecycleEvent(
            session.sessionId,
            {
              type: "prompt.terminal_received",
              promptId: event.messageId,
              sandboxId: event.sandboxId,
              errorCode: event.success ? null : (event.errorCode ?? "unknown"),
              // Corroborates errorCode "aborted" as a delivered control-plane stop (the bridge's
              // deliberate stop-abort reason) so the FSM can route it to quiet STOPPED; an
              // uncorroborated "aborted" (classifyError text-match, external session delete,
              // failsafe abort) stays a loud FAILED.
              stoppedByUser: isStoppedByUserPromptError(event.error ?? null),
            },
            { suppressFsmTransport: gatedPlanWillPark },
          );
          const telemetry = {
            btSpanId: normalizeTelemetryId(event.btSpanId),
            errorCode: event.errorCode,
            errorDetails: event.errorDetails,
          };

          await this.runObservedSpan(
            "prompt.execution_complete",
            this.buildTraceAttributes(session.sessionId, event.messageId, {
              ...(event.sandboxId ? { "sandbox.id": event.sandboxId } : {}),
              outcome: event.success ? "success" : "error",
              ...(event.errorCode ? { "error.code": datadogErrorCodeTag(event.errorCode) } : {}),
            }),
            async () => {
              // Flush buffer, persist event, then handle execution_complete.
              await this.runCriticalPersistence(async () => {
                await this.flushTextDeltaBuffer();
                await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);

                await this.handleExecutionComplete(event, session.sessionId, telemetry);
                if (!event.success) {
                  this.markPlatformLlmPromptStatus(session.sessionId, event.messageId, "terminal");
                }

                // Backfill telemetry IDs into prompt_runs and DO storage.
                // handleExecutionComplete may early-return if session_idle already completed the prompt,
                // but we still need the trace IDs written.
                if (telemetry.btSpanId) {
                  const promptId = event.messageId;
                  doDb.upsertPromptTraceTelemetry(this.sql, promptId, { btSpanId: telemetry.btSpanId });
                }

                if ((this.env as Env).DB) {
                  const promptId = event.messageId;
                  this.ctx.waitUntil(
                    (async () => {
                      const prompt = doDb.getPrompt(this.sql, promptId);
                      const resolvedErrorDetails = telemetry.errorDetails ?? prompt?.errorDetails ?? null;
                      const resolvedErrorDetailsJson = serializeErrorDetails(resolvedErrorDetails);
                      await (this.env as Env)
                        .DB!.prepare(
                          `UPDATE prompt_runs SET
                          outcome = CASE
                            WHEN ? IS NOT NULL OR ? IS NOT NULL THEN 'failed'
                            ELSE outcome
                          END,
                          bt_span_id = COALESCE(?, bt_span_id),
                          error_code = COALESCE(?, error_code),
                          error_details_json = COALESCE(?, error_details_json)
                        WHERE session_id = ? AND prompt_id = ?`,
                        )
                        .bind(
                          telemetry.errorCode ?? null,
                          resolvedErrorDetailsJson,
                          telemetry.btSpanId ?? null,
                          telemetry.errorCode ?? null,
                          resolvedErrorDetailsJson,
                          session.sessionId,
                          promptId,
                        )
                        .run();

                      const archiveSid = this.resolveSessionId();
                      if (!archiveSid) return;
                      const promptTelemetry = doDb.getPromptTelemetry(this.sql, archiveSid)[promptId];
                      const usageMap = doDb.getPromptUsage(this.sql, archiveSid);
                      const usage = usageMap[promptId];
                      const ext = doDb.getSessionExtended(this.sql, archiveSid);
                      const sandboxStateForTrace = doDb.getSandboxState(this.sql, archiveSid);
                      const repoOwner = ext?.repoOwner;
                      const repoName = ext?.repoName;
                      const repo = repoOwner && repoName ? `${repoOwner}/${repoName}` : null;
                      const durationMs =
                        prompt?.startedAt && prompt?.completedAt
                          ? new Date(prompt.completedAt).getTime() - new Date(prompt.startedAt).getTime()
                          : null;
                      // dd_trace_id is read from historical rows only; the bridge no longer emits it.
                      const effectiveDdTraceId = promptTelemetry?.ddTraceId ?? null;
                      const effectiveBtSpanId = telemetry.btSpanId ?? promptTelemetry?.btSpanId ?? null;

                      const finalizationEvent = buildPromptTraceFinalizationEvent({
                        sessionId: session.sessionId,
                        promptId,
                        repo,
                        model: usage?.model || session.model || null,
                        agent: prompt?.agent ?? null,
                        outcome: prompt?.status ?? (event.success ? "completed" : "failed"),
                        errorCode: telemetry.errorCode ?? (prompt?.error ? "unknown" : null),
                        errorDetails: resolvedErrorDetails,
                        durationMs,
                        ddTraceId: effectiveDdTraceId,
                        btSpanId: effectiveBtSpanId,
                        traceExpected: true,
                        runtimeProvider: sandboxStateForTrace?.runtimeProvider ?? null,
                        runtimeBackend: sandboxStateForTrace?.runtimeBackend ?? null,
                        source: "execution_complete",
                      });
                      // Dedup-gated so a control-plane terminal finalizing the same
                      // prompt via finalizePromptRun cannot double-emit.
                      this.emitPromptTraceFinalizedOnce(session.sessionId, promptId, finalizationEvent);
                    })().catch((err) => {
                      this.log.error(
                        { sessionId: session.sessionId, promptId, error: serializeError(err) },
                        "Telemetry ID backfill failed",
                      );
                    }),
                  );
                }
                // Execution finished -- any pending question is now moot.
                await this.setHasPendingQuestion(false);
              });
            },
          );
          this.sendSandboxAck(ackId);
          // ARC-876: arm the post-execution watchdog if this prompt entered
          // post_execution_pending above. rescheduleSessionAlarm picks up the
          // started_at from platform_llm_prompt_status and computes the
          // deadline. No-op for the !success branch (status is terminal).
          await this.rescheduleSessionAlarm();
        } else if (event.type === "post_execution") {
          // Git/PR follow-up data arrives asynchronously after execution_complete.
          // Handles PR creation, verification persistence, and prompt result updates.
          //
          // Server-authoritative publish decision (trust the sandbox's gate INPUTS,
          // not its final fold). Rewrite the event's publishMode/verification IN
          // PLACE before it is appended to durable history or handed to
          // handlePostExecution: `event` is the same object as the durable entry's
          // `data` and is shallow-spread into the handler's event, so this single
          // mutation makes durable replay, stored verification, the UI broadcast,
          // and automatic PR creation all read the same value.
          const publishDecision = applyServerAuthoritativePublishMode(event);
          if (publishDecision.mismatch) {
            this.log.warn(
              {
                event: "publish_decision.mismatch",
                sessionId: session.sessionId,
                promptId: event.messageId,
                sandboxPublishMode: publishDecision.sandboxMode,
                derivedPublishMode: publishDecision.publishMode,
                reason: publishDecision.reason,
                gateFloor: publishDecision.gateFloor,
                functionalForcedDraft: publishDecision.functionalForcedDraft,
              },
              "Control-plane re-derived a different publish mode than the sandbox reported",
            );
          }
          await this.runCriticalPersistence(async () => {
            // ARC-876: flush text deltas before persisting the post_execution
            // event. Without this, deltas buffered just before post_execution
            // arrives can race with the durable append and corrupt replay
            // ordering (apps/control-plane-worker/README.md
            // "Projection write ownership").
            await this.flushTextDeltaBuffer();
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
            // ARC-876: persist push outcome on the prompt row so the shared
            // publish gate (isPromptPublishable) can gate without re-receiving
            // the original event.
            // A current bridge always bundles `pushed` whenever there are
            // changes (and reconstructs it with pushed=true on crash recovery),
            // so the event is authoritative.
            const pushOutcome: doDb.PromptPushOutcome =
              event.pushed === true
                ? { pushStatus: "succeeded", pushError: null }
                : event.pushed === false
                  ? { pushStatus: "failed", pushError: event.pushError ?? null }
                  : { pushStatus: "unknown", pushError: event.pushError ?? null };
            doDb.updatePromptPushOutcome(this.sql, event.messageId, pushOutcome);
            await this.handlePostExecution(event, session.sessionId);
            this.markPlatformLlmPromptStatus(session.sessionId, event.messageId, "terminal");
            await this.persistAndBroadcastSessionStatus(session.sessionId, "post_execution");
          });
          this.sendSandboxAck(ackId);
          // ARC-876: rebuild the alarm now that this prompt cleared
          // post_execution_pending. Other prompts may still be pending; the
          // scheduler picks the soonest remaining deadline (or disarms).
          await this.rescheduleSessionAlarm();
          // ARC-1330 (PR 36) transport producer: the bridge `post_execution` event carries the
          // diff decision (`hasChanges`/`promptIntendsChange`) the reducer boundary cannot — emit the
          // shadow `postexec.done` (FINALIZING→PUBLISHING vs ANSWERED_NO_PR). SHADOW + best-effort.
          await this.shadowEmitPostexecDone(
            session.sessionId,
            event.hasChanges === true,
            event.promptIntendsChange === true,
          );
        } else if (event.type === "verification_phase_artifact") {
          await this.runCriticalPersistence(async () => {
            await this.flushTextDeltaBuffer();
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
            const existing =
              ((await this.state.storage.get(VERIFICATION_PHASE_ARTIFACTS_STORAGE_KEY)) as
                VerificationPhaseArtifactRecord[] | undefined) ?? [];
            const storedRecord = compactVerificationPhaseArtifactRecordForDurableStorage(event.record);
            await this.state.storage.put(
              VERIFICATION_PHASE_ARTIFACTS_STORAGE_KEY,
              upsertVerificationPhaseArtifactRecord(existing, storedRecord),
            );
          });
          this.broadcast({ type: "sandbox_event", event });
          this.sendSandboxAck(ackId);
          // Capture runs off the full pre-compaction note (DO storage above is
          // truncated) and must never affect the critical persistence path.
          this.maybeCaptureQaRuntimeLearnings(session.sessionId, event);
        } else if (event.type === "runtime_info") {
          await this.runCriticalPersistence(async () => {
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);

            const reportedModalObjectId =
              typeof event.runtime.modalSandboxId === "string" ? event.runtime.modalSandboxId.trim() : "";
            const reportedSandboxId = typeof event.sandboxId === "string" ? event.sandboxId.trim() : "";
            let trustedReportedModalObjectId = "";
            if (reportedModalObjectId) {
              doDb.ensureSandboxState(this.sql, session.sessionId);
              const sandboxState = doDb.getSandboxState(this.sql, session.sessionId);
              const sandboxIdMatches =
                !reportedSandboxId || !sandboxState?.sandboxId || sandboxState.sandboxId === reportedSandboxId;
              if (!sandboxIdMatches) {
                this.log.warn(
                  {
                    sessionId: session.sessionId,
                    reportedSandboxId,
                    currentSandboxId: sandboxState?.sandboxId ?? null,
                    modalObjectId: reportedModalObjectId,
                  },
                  "Ignoring legacy provider object id from mismatched sandbox",
                );
              } else {
                trustedReportedModalObjectId = reportedModalObjectId;
              }
              if (trustedReportedModalObjectId && !sandboxState?.modalObjectId) {
                doDb.updateSandboxState(this.sql, session.sessionId, { modalObjectId: reportedModalObjectId });
                this.log.info(
                  {
                    sessionId: session.sessionId,
                    sandboxId: reportedSandboxId || sandboxState?.sandboxId || null,
                    modalObjectId: trustedReportedModalObjectId,
                    source: "runtime_info",
                  },
                  "Registered sandbox legacy provider object id from runtime info",
                );
              }
            }

            const existing = await this.getRuntimeProvenance();
            this.notifyE2BRuntimeInfo(session.sessionId, event.runtime);
            const reportedRuntime: RuntimeReport = {
              ...event.runtime,
              backend:
                event.runtime.backend ??
                existing?.runtime?.backend ??
                doDb.getSandboxState(this.sql, session.sessionId)?.runtimeBackend ??
                null,
            };
            const runtimeProvenance: RuntimeProvenance = {
              ...(existing ?? { updatedAt: Date.now() }),
              modalObjectId: existing?.modalObjectId ?? (trustedReportedModalObjectId || null),
              dockerEnabled: event.runtime.dockerEnabled ?? existing?.dockerEnabled,
              dockerDaemonStartMs: event.runtime.dockerDaemonStartMs ?? existing?.dockerDaemonStartMs ?? null,
              runtime: reportedRuntime,
              updatedAt: Date.now(),
            };
            await this.putRuntimeProvenance(runtimeProvenance);
            this.broadcast({ type: "runtime_provenance_updated", runtimeProvenance });

            if (event.observabilityReadiness) {
              const observabilityReadiness: ObservabilityReadiness = event.observabilityReadiness;
              await this.putObservabilityReadiness(observabilityReadiness);
              this.broadcast({ type: "observability_readiness_updated", observabilityReadiness });
            }
          });
          await this.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl("heartbeat");
        } else if (event.type === "push_error") {
          await this.runCriticalPersistence(async () => {
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
            doDb.updatePromptPushOutcome(this.sql, event.messageId, {
              pushStatus: "failed",
              pushError: event.error,
            });
          });
          this.sendSandboxAck(ackId);
          await this.stopSessionAtDurabilityBoundary(session, "publish_push_failed", { stopReason: null });
        } else if (event.type === "push_complete") {
          await this.runCriticalPersistence(async () => {
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
            doDb.updatePromptPushOutcome(this.sql, event.messageId, {
              pushStatus: "succeeded",
              pushError: null,
            });

            const branchName = (parsed as { branchName?: string }).branchName;
            if (branchName) {
              const pushSid = this.resolveSessionId();
              if (pushSid) {
                if (!isSafeGitRef(branchName)) {
                  // A forged branch name means the whole frame is suspect, so we
                  // drop the sibling commitSha and skip snapshot invalidation too
                  // rather than persisting any of it. (The post_execution path
                  // keeps commitSha because that frame is bridge-internal.)
                  this.log.warn(
                    { sessionId: pushSid, branchName },
                    "Rejected unsafe sandbox-supplied branch name from push_complete",
                  );
                } else {
                  const pushExt = doDb.getSessionExtended(this.sql, pushSid);
                  const previousWorkspaceBranch = pushExt?.lastBranch ?? pushExt?.baseBranch ?? null;
                  if (previousWorkspaceBranch && previousWorkspaceBranch !== branchName) {
                    await this.invalidateSessionSnapshot(
                      pushSid,
                      `Snapshot invalidated: workspace branch changed from ${previousWorkspaceBranch} to ${branchName}`,
                    );
                  }
                  const commitSha = (parsed as { commitSha?: string }).commitSha;
                  doDb.updateSessionBranchFromSandbox(
                    this.sql,
                    pushSid,
                    branchName,
                    typeof commitSha === "string" && commitSha.trim() ? { lastCommitSha: commitSha.trim() } : {},
                  );
                }
              }
            }
          });
          this.sendSandboxAck(ackId);
        } else if (isCriticalNativeEvent) {
          await this.runCriticalPersistence(async () => {
            await this.flushTextDeltaBuffer();
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
          });
          this.sendSandboxAck(ackId);
        } else {
          // Non-execution_complete native events: persist in background
          this.enqueuePersistence(async () => {
            await this.appendAndBroadcastEvents(session.sessionId, [durableEntry], eventPromptId);
          });
        }
      },
    );
    if (runningActivity) {
      this.recordRuntimeActivity(session.sessionId, "prompt_running_activity");
    }
    await awaitRunningActivity();
  }

  private recordEstimatedInputComposition(promptId: string, event: Record<string, unknown>): void {
    const record = this.parseEstimatedInputComposition(event);
    if (!record) {
      this.log.warn({ promptId }, "Dropping malformed estimated input composition");
      return;
    }

    this.enqueuePersistence(async () => {
      doDb.upsertPromptTokenAttribution(this.sql, promptId, record);
    });
  }

  private parseEstimatedInputComposition(event: Record<string, unknown>): EstimatedInputCompositionRecord | null {
    const rawComponents = event.components;
    if (typeof rawComponents !== "object" || rawComponents === null || Array.isArray(rawComponents)) {
      return null;
    }

    const components = rawComponents as Record<string, unknown>;
    const systemContext = this.parseNonNegativeIntegerField(components.systemContext);
    const historicalSessions = this.parseNonNegativeIntegerField(components.historicalSessions);
    const taskText = this.parseNonNegativeIntegerField(components.taskText);
    const uploads = this.parseNonNegativeIntegerField(components.uploads);
    const measuredTotal = this.parseNonNegativeIntegerField(components.measuredTotal);
    const actualInputTokens = this.parseNonNegativeIntegerField(components.actualInputTokens);
    const actualOutputTokens = this.parseNonNegativeIntegerField(components.actualOutputTokens);
    const unmeasuredTokens =
      components.unmeasuredTokens === null ? null : this.parseIntegerField(components.unmeasuredTokens);

    if (
      systemContext === null ||
      historicalSessions === null ||
      taskText === null ||
      uploads === null ||
      measuredTotal === null ||
      actualInputTokens === null ||
      actualOutputTokens === null ||
      (components.unmeasuredTokens !== null && unmeasuredTokens === null)
    ) {
      return null;
    }

    return {
      kind: "estimated_input_composition",
      version: 1,
      components: {
        systemContext,
        historicalSessions,
        taskText,
        uploads,
        measuredTotal,
        actualInputTokens,
        actualOutputTokens,
        unmeasuredTokens,
      },
    };
  }

  private parseNonNegativeIntegerField(value: unknown): number | null {
    const parsed = this.parseIntegerField(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
  }

  private parseIntegerField(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      return null;
    }
    return value;
  }

  /**
   * Accumulate usage data per-prompt in durable storage. The bridge sends cumulative
   * token totals per sandbox run (which maps to a single prompt). We store the latest
   * snapshot per promptId so summing all entries gives session-level totals.
   * Immune to event compaction and survives DO eviction.
   *
   * GET /session/usage derives the session-level summary from these per-prompt
   * snapshots, so accumulation only needs to keep the latest prompt totals.
   */
  private async accumulateUsage(promptId: string, event: Record<string, unknown>): Promise<void> {
    const rawInputTokens = typeof event.inputTokens === "number" ? event.inputTokens : 0;
    const hasNormalizedCacheReadTokens = typeof event.cacheReadTokens === "number";
    const cacheReadTokens = this.resolveCacheTokens(event.cacheReadTokens, event.cumulativeCacheRead, promptId, "read");
    const cacheWriteTokens = this.resolveCacheTokens(
      event.cacheWriteTokens,
      event.cumulativeCacheWrite,
      promptId,
      "write",
    );
    const usage: PerPromptUsage = {
      promptId,
      model: typeof event.model === "string" ? event.model : undefined,
      inputTokens: hasNormalizedCacheReadTokens ? rawInputTokens : Math.max(0, rawInputTokens - cacheReadTokens),
      outputTokens: typeof event.outputTokens === "number" ? event.outputTokens : 0,
      cacheReadTokens,
      cacheWriteTokens,
      totalCostUsd: typeof event.totalCostUsd === "number" ? event.totalCostUsd : 0,
    };

    // Single SQL upsert replaces the old read-modify-write on the KV map.
    // usage_cache is no longer stored; computed on-demand via doDb.computeUsageCache().
    doDb.upsertPromptUsage(this.sql, promptId, usage);
  }

  private resolveCacheTokens(
    normalizedValue: unknown,
    legacyValue: unknown,
    promptId: string,
    bucket: "read" | "write",
  ): number {
    if (typeof normalizedValue === "number") {
      return normalizedValue;
    }
    if (typeof legacyValue === "number") {
      this.log.warn({ promptId, bucket }, "Legacy cache token derivation");
      return legacyValue;
    }
    return 0;
  }

  /**
   * Write the completed prompt's usage to D1 for historical querying.
   * Both completeActivePrompt (session_idle) and handleExecutionComplete
   * (execution_complete) may fire for the same prompt; D1 upserts by the
   * prompt-scoped usage key so replay remains idempotent after DO restarts.
   */
  private async writeUsageToD1(sessionId: string, ownerUserId: string, promptId: string): Promise<void> {
    try {
      const sid = this.resolveSessionId();
      if (!sid) return;
      const session = doDb.getSession(this.sql, sid);
      const usageMap = doDb.getPromptUsage(this.sql, sid);
      const usage = usageMap[promptId];
      if (!usage || usage.totalCostUsd === 0) return;

      await insertUsageRecord(this.env.DB, {
        sessionId,
        promptId,
        ownerUserId,
        businessId: session?.businessId ?? null,
        source: USAGE_SOURCE_SANDBOX,
        usage,
      });

      // Emit a structured usage log so sandbox agent inference spend is queryable in Datadog
      // (logpush -> arcanist.sandbox_agent.usage_cost_usd_micros). The D1 write above is
      // idempotent via ON CONFLICT upsert, but this log is NOT: writeUsageToD1 fires for both
      // session_idle and execution_complete on the same prompt, so a raw emit would double-count
      // a log-derived spend metric. Dedup per prompt through durable storage, mirroring
      // writeCompletionToD1's "completions_written" set, so each prompt's spend is logged once.
      //
      // Persist the dedup marker BEFORE emitting: storage.put is the fallible op (log.info is a
      // synchronous, non-throwing console write). If the put throws, we throw before emitting, so
      // the retry emits exactly once instead of double-counting. The reverse order (emit, then
      // put) would re-emit on the next firing whenever the put failed.
      const usageLogged = ((await this.state.storage.get("usage_events_logged")) as Record<string, true>) || {};
      if (!usageLogged[promptId]) {
        usageLogged[promptId] = true;
        await this.state.storage.put("usage_events_logged", usageLogged);
        const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        this.log.info(
          {
            event: "sandbox_agent.usage_event",
            version: 1,
            provider: inferenceProviderForBackend(session?.agentRuntimeBackend),
            agentRuntimeBackend: session?.agentRuntimeBackend ?? null,
            model: usage.model ?? null,
            costUsdMicros: Math.round(usage.totalCostUsd * USD_TO_MICROS),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            totalTokens,
            sessionId,
            promptId,
            businessId: session?.businessId ?? null,
            ownerUserId,
            source: USAGE_SOURCE_SANDBOX,
          },
          "Sandbox agent usage event",
        );
      }
    } catch (err) {
      this.log.error(
        { sessionId, promptId, error: serializeError(err) },
        "Failed to write usage record to D1 or emit usage event",
      );
    }
  }

  /**
   * Write a completion record to D1 for the memory review bot. Fire-and-forget.
   * Deduplicates via a "completions_written" set in durable storage, same pattern
   * as writeUsageToD1. Both completeActivePrompt and handleExecutionComplete may
   * fire for the same prompt -- the first write wins, the second updates diff fields.
   */
  private async writeCompletionToD1(
    sessionId: string,
    ownerUserId: string,
    promptId: string,
    event?: { diffSummary?: string; branch?: string; commitSha?: string; success?: boolean },
  ): Promise<void> {
    try {
      const writtenSet = ((await this.state.storage.get("completions_written")) as Record<string, true>) || {};

      const completionSid = this.resolveSessionId();
      if (!completionSid) return;
      const session = doDb.getSession(this.sql, completionSid);
      const ext = doDb.getSessionExtended(this.sql, completionSid);
      const repoOwner = ext?.repoOwner;
      const repoName = ext?.repoName;

      if (!repoOwner || !repoName) return;

      const prompt = doDb.getPrompt(this.sql, promptId);
      if (!prompt) return;

      if (writtenSet[promptId]) {
        if (event?.diffSummary || event?.branch || event?.commitSha) {
          await updateCompletionDiff(this.env.DB, sessionId, promptId, {
            diffSummary: event.diffSummary ?? null,
            branch: event.branch ?? null,
            commitSha: event.commitSha ?? null,
          });
        }
        return;
      }

      await insertCompletion(this.env.DB, {
        sessionId,
        promptId,
        ownerUserId,
        businessId: session?.businessId ?? null,
        repoOwner,
        repoName,
        promptText: prompt.prompt,
        title: session?.title ?? null,
        diffSummary: event?.diffSummary ?? null,
        branch: event?.branch ?? null,
        commitSha: event?.commitSha ?? null,
        success: event?.success ?? true,
        completedAt: Date.now(),
      });
      writtenSet[promptId] = true;
      await this.state.storage.put("completions_written", writtenSet);
    } catch (err) {
      this.log.error({ sessionId, promptId, error: serializeError(err) }, "Failed to write completion to D1");
    }
  }

  private async runMemoryReviewBot(sessionId: string, prompt: PromptState, session: SessionState): Promise<void> {
    const env = this.env as Env;
    if (!env.DB || prompt.status !== "completed" || !session.businessId) return;
    try {
      const result = await runMemoryReviewBotForCompletedPrompt(
        env,
        {
          businessId: session.businessId,
          sessionId,
          promptId: prompt.promptId,
        },
        { logger: this.log, waitUntil: (promise) => this.ctx.waitUntil(promise) },
      );
      this.log.info(
        {
          event: "memory_review_bot_run",
          sessionId,
          promptId: prompt.promptId,
          businessId: session.businessId,
          ...result,
        },
        "Memory review bot run evaluated",
      );
    } catch (err) {
      this.log.warn(
        { event: "memory_review_bot_run_failed", sessionId, promptId: prompt.promptId, error: serializeError(err) },
        "Memory review bot run failed",
      );
    }
  }

  /**
   * Append events to durable storage and broadcast new replay events.
   * Replaces direct appendDurableEvents calls throughout the DO.
   */
  private async appendAndBroadcastEvents(
    sessionId: string,
    entries: DurableEntry[],
    promptId?: string,
  ): Promise<{
    replay: ReplayState;
    events: SessionEvent[];
    newEvents?: SessionEvent[];
    newReplayEvents?: ClientReplayPage["events"];
  }> {
    const startedAt = Date.now();
    const result = await appendDurableEvents(this.state, sessionId, entries, promptId, { includeEvents: false });
    const appendDurationMs = Date.now() - startedAt;
    if (entries.length > 0 && result.newReplayEvents && result.newReplayEvents.length > 0) {
      // Broadcast each new event to connected client WebSockets in real time
      for (const event of result.newReplayEvents) {
        this.broadcast({
          type: "session_event",
          event,
        });
      }
    }

    if (entries.length > 0) {
      this.queueSlackNarrationUpdate(sessionId, entries);
    }

    this.log.info(
      {
        event: "session.append_and_broadcast.metrics",
        sessionId,
        promptId: promptId ?? null,
        eventCount: entries.length,
        newEventCount: result.newEvents?.length ?? 0,
        newReplayEventCount: result.newReplayEvents?.length ?? 0,
        appendDurationMs,
        totalDurationMs: Date.now() - startedAt,
      },
      "SessionDO append and broadcast metrics",
    );
    return result;
  }

  /**
   * Live-narration consumer (Slack status card). Computes a deterministic
   * activity line from the appended batch, dedups against the last rendered
   * line, and throttles chat.update edits to NARRATION_MIN_UPDATE_INTERVAL_MS.
   * Throttled lines are stashed and flushed LAZILY on a later event — never via
   * `state.storage.setAlarm` (the DO's single alarm is multiplexed by
   * alarmScheduler for FSM deadline wakes; a raw set would clobber them).
   * Fire-and-forget: narration must not add latency to event ingestion.
   */
  private queueSlackNarrationUpdate(sessionId: string, entries: DurableEntry[]): void {
    if (this.narrationEligibility === false) return;
    // Maintain the rolling LLM buffer before the deterministic early-return so it
    // stays fresh even for events that yield no deterministic card line. Bump the
    // version (the cadence change signal) only when the batch actually produced
    // narration-relevant items.
    const newItems = progressItemsForEvents(entries, narrationToolCallText);
    if (newItems.length > 0) {
      this.progressBuffer = boundProgressBuffer([...this.progressBuffer, ...newItems]);
      this.progressBufferVersion += 1;
      // Piggyback the LLM cadence check on event arrivals (no alarm).
      this.maybeQueueProgressNarration(sessionId);
    }

    const line = narrationLineForEvents(entries);
    // Nothing new and nothing stashed to flush.
    if (line === null && !this.narrationThrottleState?.pendingLine) return;
    this.narrationChain = this.narrationChain
      .then(() => this.processSlackNarration(sessionId, line))
      .catch((err) => {
        this.log.warn({ sessionId, error: serializeError(err) }, "Slack narration update failed");
      });
    this.ctx.waitUntil(this.narrationChain);
  }

  /**
   * Cheap synchronous pre-gate for the LLM narration cadence (all in-memory):
   * Slack-eligible, not already in flight, past the spacing interval, and the
   * buffer changed since the last summary. The authoritative gate
   * (shouldRunProgressNarration) is re-evaluated inside runProgressNarration
   * once the D1-backed conditions (internal membership, running phase) resolve.
   * Fire-and-forget via waitUntil; the LLM call runs OFF the narrationChain so
   * its up-to-4s latency never stalls deterministic renders — only the final
   * render is enqueued back onto the shared serialized chain.
   */
  private maybeQueueProgressNarration(sessionId: string): void {
    if (this.narrationEligibility === false) return;
    if (this.progressNarrationInFlight) return;
    if (this.progressBufferVersion === this.progressSummarizedBufferVersion) return;
    if (Date.now() - this.lastProgressLlmAtMs < PROGRESS_NARRATION_INTERVAL_MS) return;
    this.progressNarrationInFlight = true;
    this.ctx.waitUntil(
      this.runProgressNarration(sessionId)
        .catch((err) => {
          this.log.warn({ sessionId, error: serializeError(err) }, "Slack progress narration failed");
        })
        .finally(() => {
          this.progressNarrationInFlight = false;
        }),
    );
  }

  private async runProgressNarration(sessionId: string): Promise<void> {
    // Resolve Slack eligibility lazily, mirroring processSlackNarration.
    if (this.narrationEligibility === null) {
      const callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext;
      this.narrationEligibility = callbackContext?.source === "slack";
    }
    // Resolve + memoize the internal-business gate (fail closed to OFF).
    if (this.progressNarrationInternal === null) {
      const businessId = doDb.getSession(this.sql, sessionId)?.businessId ?? null;
      this.progressNarrationInternal = isCycloidMember({ businessId });
    }

    const frame = this.deriveCurrentSessionStatusFrame(sessionId);
    const bufferVersion = this.progressBufferVersion;
    const gate = shouldRunProgressNarration({
      eligible: this.narrationEligibility === true,
      internal: this.progressNarrationInternal === true,
      running: frame.phaseInfo.phase === "running",
      nowMs: Date.now(),
      lastAtMs: this.lastProgressLlmAtMs,
      inFlight: false,
      bufferChanged: bufferVersion !== this.progressSummarizedBufferVersion,
    });
    if (!gate) return;

    // Advance cadence + summary markers BEFORE the call so a slow call cannot
    // trigger a rapid re-fire and the buffer version is pinned to this snapshot.
    this.lastProgressLlmAtMs = Date.now();
    this.progressSummarizedBufferVersion = bufferVersion;

    const bufferSnapshot = [...this.progressBuffer];
    const task = this.resolveProgressNarrationTask(sessionId);
    if (!this.narrationThrottleState) {
      this.narrationThrottleState =
        (await this.state.storage.get<NarrationThrottleState>(NARRATION_THROTTLE_STATE_STORAGE_KEY)) ??
        INITIAL_NARRATION_THROTTLE_STATE;
    }
    const lastLine = this.narrationThrottleState.lastLine;

    const businessId = doDb.getSession(this.sql, sessionId)?.businessId ?? null;
    const line = await summarizeProgress(this.env as Env, {
      task,
      buffer: bufferSnapshot,
      lastLine,
      isFirstUpdate: !this.progressNarrationActive,
      log: this.log,
      telemetry: {
        subsystem: "slack",
        callType: "slack_progress_narration",
        phase: "background",
        sourceId: `slack_progress_narration:${sessionId}:${Date.now()}`,
        sessionId,
        businessId,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      },
    });
    if (!line) return;

    // Render through the SAME serialized chain + running-phase-guarded path the
    // deterministic line uses, so both write one narrationLine and the throttle
    // lastLine dedups the deterministic path against this richer line.
    this.narrationChain = this.narrationChain
      .then(() => this.processSlackNarration(sessionId, line, "llm"))
      .catch((err) => {
        this.log.warn({ sessionId, error: serializeError(err) }, "Slack progress narration render failed");
      });
    await this.narrationChain;
  }

  /**
   * Best-effort task text for the narration prompt: the active prompt's text,
   * else the most recent prompt, else the session title. Empty string when none
   * (the prompt tolerates a missing task).
   */
  private resolveProgressNarrationTask(sessionId: string): string {
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    if (activePromptId) {
      const active = doDb.getPrompt(this.sql, activePromptId);
      if (active?.prompt)
        return deriveReviewLoopSummaryOrRaw({ prompt: active.prompt, replyToText: active.replyToText });
    }
    const prompts = doDb.getPrompts(this.sql, sessionId);
    const latest = prompts.length > 0 ? prompts[prompts.length - 1] : null;
    if (latest?.prompt) return deriveReviewLoopSummaryOrRaw({ prompt: latest.prompt, replyToText: latest.replyToText });
    return doDb.getSessionExtended(this.sql, sessionId)?.title ?? "";
  }

  private async processSlackNarration(
    sessionId: string,
    line: string | null,
    source: "deterministic" | "llm" = "deterministic",
  ): Promise<void> {
    if (this.narrationEligibility === null) {
      const callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext;
      this.narrationEligibility = callbackContext?.source === "slack";
    }
    if (!this.narrationEligibility) return;

    // Once LLM progress narration has produced a line, it OWNS the card's
    // narration line — it refreshes on the ~30s cadence with a meaningful
    // synthesis. Deterministic per-event lines (tool labels) must not clobber
    // it in between, or the card flips back to mechanical noise. The
    // deterministic line only serves as the instant bootstrap until the first
    // LLM line, and whenever LLM narration is gated off (non-internal / no key).
    if (source === "deterministic" && this.progressNarrationActive) return;
    if (source === "llm" && line !== null) this.progressNarrationActive = true;

    if (!this.narrationThrottleState) {
      this.narrationThrottleState =
        (await this.state.storage.get<NarrationThrottleState>(NARRATION_THROTTLE_STATE_STORAGE_KEY)) ??
        INITIAL_NARRATION_THROTTLE_STATE;
    }
    const plan = planNarrationUpdate(this.narrationThrottleState, line, Date.now());
    if (plan.state !== this.narrationThrottleState) {
      this.narrationThrottleState = plan.state;
      await this.state.storage.put(NARRATION_THROTTLE_STATE_STORAGE_KEY, plan.state);
    }
    if (!plan.send) return;
    // Narration is live-activity copy: a stale flush after the prompt settled
    // (or after the card moved to waiting_for_input/finalizing/…) must not
    // repaint the card back to "Running". Only the running phase narrates.
    const frame = this.deriveCurrentSessionStatusFrame(sessionId);
    if (frame.phaseInfo.phase !== "running") return;
    await updateSlackStatusStageInPlace({
      sql: this.sql,
      env: this.env as Env,
      log: this.log,
      sessionId,
      stage: "running",
      narrationLine: plan.send,
    });
  }

  /**
   * Phase-transition card update (PR 1.3 DO wiring). Chained onto the
   * narration queue so phase edits and narration edits of the same card are
   * serialized, and deduped by stage so re-broadcasts inside one phase no-op.
   * Fire-and-forget like narration: a Slack failure never blocks the status
   * projection.
   */
  private queueSlackPhaseCardUpdate(sessionId: string, stage: SlackStatusStage): void {
    if (this.narrationEligibility === false) return;
    if (this.lastSlackPhaseCardStage === stage) return;
    this.lastSlackPhaseCardStage = stage;
    this.narrationChain = this.narrationChain
      .then(() => this.processSlackPhaseCardUpdate(sessionId, stage))
      .catch((err) => {
        this.log.warn({ sessionId, stage, error: serializeError(err) }, "Slack phase card update failed");
      });
    this.ctx.waitUntil(this.narrationChain);
  }

  private async processSlackPhaseCardUpdate(sessionId: string, stage: SlackStatusStage): Promise<void> {
    if (stage === "starting") return; // webhook owns the initial card
    if (this.narrationEligibility === null) {
      const callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext;
      this.narrationEligibility = callbackContext?.source === "slack";
    }
    if (!this.narrationEligibility) return;

    if (!this.narrationThrottleState) {
      this.narrationThrottleState =
        (await this.state.storage.get<NarrationThrottleState>(NARRATION_THROTTLE_STATE_STORAGE_KEY)) ??
        INITIAL_NARRATION_THROTTLE_STATE;
    }
    // Coalesce with the narration throttle (see coalescePhaseCardNarration):
    // one chat.update carries phase + freshest narration line, and the shared
    // lastUpdateAtMs advances so the next narration tick keeps its spacing.
    const plan = coalescePhaseCardNarration(this.narrationThrottleState, stage === "running", Date.now());
    const updated = await updateSlackStatusStageInPlace({
      sql: this.sql,
      env: this.env as Env,
      log: this.log,
      sessionId,
      stage,
      narrationLine: plan.carriedLine,
      manageControls: true,
    });
    if (updated) {
      this.narrationThrottleState = plan.state;
      await this.state.storage.put(NARRATION_THROTTLE_STATE_STORAGE_KEY, plan.state);
    }
  }

  /**
   * Write a prompt_runs row to D1.
   * Uses INSERT OR IGNORE for idempotence (UNIQUE constraint on session_id + prompt_id).
   * Called from all terminal prompt paths.
   */
  private async finalizePromptRun(
    sessionId: string,
    prompt: PromptState,
    session: SessionState,
    telemetry?: PromptExecutionTelemetry,
    context?: PromptFinalizeContext,
  ): Promise<void> {
    const env = this.env as Env;
    if (!env.DB) return;

    const finalizeSid = this.resolveSessionId();
    if (!finalizeSid) return;

    try {
      const finalizeContext = context ?? this.capturePromptFinalizeContext(finalizeSid);
      const repo = finalizeContext.repo;

      await this.runObservedSpan(
        "prompt.finalize",
        this.buildTraceAttributes(sessionId, prompt.promptId, {
          ...(repo ? { repo } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(prompt.agent ? { agent: prompt.agent } : {}),
          outcome: prompt.status,
          ...(telemetry?.errorCode ? { "error.code": datadogErrorCodeTag(telemetry.errorCode) } : {}),
        }),
        async () => {
          const usageMap = doDb.getPromptUsage(this.sql, finalizeSid);
          const usage = usageMap[prompt.promptId];
          const telemetryData = doDb.getPromptTelemetry(this.sql, finalizeSid);
          const storedTelemetry = telemetryData[prompt.promptId] ?? { toolCallCount: 0 };
          const resolvedErrorDetails = telemetry?.errorDetails ?? prompt.errorDetails ?? null;
          const errorDetailsJson = serializeErrorDetails(resolvedErrorDetails);

          const durationMs =
            prompt.startedAt && prompt.completedAt
              ? new Date(prompt.completedAt).getTime() - new Date(prompt.startedAt).getTime()
              : null;

          const toolCounts = doDb.getPromptToolCounts(this.sql, finalizeSid);
          const toolCallCount = toolCounts[prompt.promptId] || 0;

          const rowErrorCode = telemetry?.errorCode || (prompt.error ? "unknown" : null);
          const rowOutcome =
            prompt.status === "completed" && (rowErrorCode || errorDetailsJson) ? "failed" : prompt.status;
          const row = {
            id: `${sessionId}:${prompt.promptId}`,
            session_id: sessionId,
            prompt_id: prompt.promptId,
            owner_user_id: session.ownerUserId,
            business_id: session.businessId,
            sandbox_id: finalizeContext.sandboxId,
            modal_object_id: finalizeContext.modalObjectId,
            repo,
            model: usage?.model || session.model || null,
            agent: prompt.agent || null,
            source: USAGE_SOURCE_SANDBOX,
            outcome: rowOutcome,
            error_code: rowErrorCode,
            input_tokens: usage?.inputTokens ?? null,
            output_tokens: usage?.outputTokens ?? null,
            cost_usd_micros: usage?.totalCostUsd ? Math.round(usage.totalCostUsd * 1_000_000) : null,
            duration_ms: durationMs,
            tool_call_count: toolCallCount,
            dd_trace_id: storedTelemetry.ddTraceId || null,
            bt_span_id: telemetry?.btSpanId || storedTelemetry.btSpanId || null,
            created_at: new Date(prompt.createdAt).getTime(),
            completed_at: prompt.completedAt ? new Date(prompt.completedAt).getTime() : null,
            error_details_json: errorDetailsJson,
          };
          const traceExpected =
            telemetry?.traceExpected === true ||
            finalizeContext.promptDispatchedToAgent === true ||
            prompt.status === "completed" ||
            toolCallCount > 0 ||
            Boolean(row.bt_span_id) ||
            (row.input_tokens ?? 0) > 0 ||
            (row.output_tokens ?? 0) > 0;
          const promptRunBusinessId = await resolveRequiredBusinessId(env.DB, {
            operation: "prompt_runs insert",
            sessionId: row.session_id,
            ownerUserId: String(row.owner_user_id),
            businessId: row.business_id,
          });

          await env.DB.prepare(
            `INSERT INTO prompt_runs (
              id, session_id, prompt_id, owner_user_id, business_id, sandbox_id, modal_object_id,
              repo, model, agent, source, outcome, error_code,
              input_tokens, output_tokens, cost_usd_micros, duration_ms, tool_call_count,
              dd_trace_id, bt_span_id, created_at, completed_at, error_details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, prompt_id) DO NOTHING`,
          )
            .bind(
              row.id,
              row.session_id,
              row.prompt_id,
              row.owner_user_id,
              promptRunBusinessId,
              row.sandbox_id,
              row.modal_object_id,
              row.repo,
              row.model,
              row.agent,
              row.source,
              row.outcome,
              row.error_code,
              row.input_tokens,
              row.output_tokens,
              row.cost_usd_micros,
              row.duration_ms,
              row.tool_call_count,
              row.dd_trace_id,
              row.bt_span_id,
              row.created_at,
              row.completed_at,
              row.error_details_json,
            )
            .run();

          if (telemetry?.recoverStalePrompt) {
            await env.DB.prepare(
              `UPDATE prompt_runs SET
                outcome = ?,
                error_code = ?,
                input_tokens = COALESCE(?, input_tokens),
                output_tokens = COALESCE(?, output_tokens),
                cost_usd_micros = COALESCE(?, cost_usd_micros),
                duration_ms = COALESCE(?, duration_ms),
                completed_at = COALESCE(?, completed_at),
                dd_trace_id = COALESCE(?, dd_trace_id),
                bt_span_id = COALESCE(?, bt_span_id),
                error_details_json = COALESCE(?, error_details_json),
                tool_call_count = CASE WHEN ? > 0 THEN ? ELSE tool_call_count END
              WHERE id = ? AND outcome = 'failed' AND error_code = 'stale_prompt'`,
            )
              .bind(
                row.outcome,
                row.error_code,
                row.input_tokens,
                row.output_tokens,
                row.cost_usd_micros,
                row.duration_ms,
                row.completed_at,
                row.dd_trace_id,
                row.bt_span_id,
                row.error_details_json,
                row.tool_call_count,
                row.tool_call_count,
                row.id,
              )
              .run();
          } else if (row.dd_trace_id || row.bt_span_id || row.tool_call_count > 0 || row.error_details_json) {
            await env.DB.prepare(
              `UPDATE prompt_runs SET
                outcome = CASE
                  WHEN ? IS NOT NULL OR ? IS NOT NULL THEN 'failed'
                  ELSE outcome
                END,
                dd_trace_id = COALESCE(?, dd_trace_id),
                bt_span_id = COALESCE(?, bt_span_id),
                error_details_json = COALESCE(?, error_details_json),
                tool_call_count = CASE WHEN ? > 0 THEN ? ELSE tool_call_count END
              WHERE id = ?`,
            )
              .bind(
                row.error_code,
                row.error_details_json,
                row.dd_trace_id,
                row.bt_span_id,
                row.error_details_json,
                row.tool_call_count,
                row.tool_call_count,
                row.id,
              )
              .run();
          }

          await runWithSentryTag(
            "prompt-tool-rollup-finalize",
            async () => {
              if (row.error_code === "stale_prompt" && telemetry?.recoverStalePrompt !== true) return;

              const toolStats = doDb.getPromptToolStatsForPrompt(this.sql, prompt.promptId);
              if (toolStats.length === 0) return;

              const createdAt = Date.now();
              const rollupRows: PromptToolRollupRow[] = toolStats.map((stats) => ({
                sessionId,
                promptId: prompt.promptId,
                businessId: promptRunBusinessId,
                ownerUserId: Number(row.owner_user_id),
                agent: row.agent,
                toolName: stats.toolName,
                mcpServer: stats.mcpServer,
                okCount: stats.okCount,
                errorCount: stats.errorCount,
                totalDurationMs: stats.totalDurationMs,
                durationSampleCount: stats.durationSampleCount,
                createdAt,
              }));
              const insertedRows = await insertToolRollupRows(env.DB, rollupRows);
              if (insertedRows.length === 0) return;

              this.ctx.waitUntil(
                runWithSentryTag(
                  "prompt-tool-rollup-metrics",
                  () => emitToolCallRollupMetrics(env, insertedRows),
                  this.log,
                  {
                    message: "Failed to emit prompt tool rollup metrics",
                    logFields: { sessionId, promptId: prompt.promptId },
                    tags: { sessionId, promptId: prompt.promptId },
                  },
                ),
              );
            },
            this.log,
            {
              message: "Failed to flush prompt tool rollup",
              logFields: { sessionId, promptId: prompt.promptId },
              tags: { sessionId, promptId: prompt.promptId },
            },
          );

          doDb.upsertPromptTelemetry(this.sql, prompt.promptId, {
            toolCallCount,
            ...(row.bt_span_id ? { btSpanId: row.bt_span_id } : {}),
            ...(row.error_code ? { errorCode: row.error_code } : {}),
          });

          // Emit prompt.trace.finalized for every terminal, including
          // control-plane-side ones (sandbox_disconnected, spawn_*,
          // max_duration_exceeded) that never reach the bridge-terminal handler
          // and so were absent from Datadog despite landing in prompt_runs.
          // Dedup-gated, so bridge terminals (which also emit from that handler)
          // are not double-counted.
          this.emitPromptTraceFinalizedOnce(
            sessionId,
            prompt.promptId,
            buildPromptTraceFinalizationEvent({
              sessionId,
              promptId: prompt.promptId,
              repo,
              model: row.model,
              agent: row.agent,
              outcome: row.outcome,
              errorCode: row.error_code,
              errorDetails: resolvedErrorDetails,
              durationMs: row.duration_ms,
              ddTraceId: row.dd_trace_id,
              btSpanId: row.bt_span_id,
              traceExpected,
              runtimeProvider: finalizeContext.runtimeProvider,
              runtimeBackend: finalizeContext.runtimeBackend,
              source: "execution_complete",
            }),
            // A stale-prompt recovery rewrites the outcome, so replace the prior
            // provisional marker and re-emit the corrected event.
            { replaceExisting: telemetry?.recoverStalePrompt === true },
          );
        },
      );
    } catch (err) {
      this.log.error(
        { sessionId, promptId: prompt.promptId, error: serializeError(err) },
        "Failed to finalize prompt run",
      );
    } finally {
      await this.flushObservedSpans();
    }
  }

  // Future helper boundary: session/prompt-queue.ts owns prompt completion, drain, retry, and disconnect recovery.
  /** Mark the matching active prompt as done and drain the queue. */
  private async completeActivePrompt(
    sessionId: string,
    completion: PromptCompletion,
    expectedPromptId?: string,
    completionSource: "session_idle" | "execution_complete" = "session_idle",
  ): Promise<void> {
    await this.promptQueue.completeActivePrompt(sessionId, completion, expectedPromptId, completionSource);
    if (expectedPromptId) await this.clearActiveToolCalls(expectedPromptId);
  }

  private async handleExecutionComplete(
    event: Extract<SandboxEvent, { type: "execution_complete" }>,
    sessionId: string,
    telemetry?: PromptExecutionTelemetry,
  ): Promise<void> {
    await this.promptQueue.handleExecutionComplete(event, sessionId, telemetry);
    await this.clearActiveToolCalls(event.messageId);
  }

  /**
   * Update prompt result with git/PR data from post_execution event.
   * The prompt may already be completed (by session_idle or execution_complete).
   */
  private async handlePostExecution(
    event: Extract<SandboxEvent, { type: "post_execution" }>,
    sessionId: string,
  ): Promise<void> {
    await this.promptQueue.handlePostExecution(event, sessionId);
  }

  private async recoverMissingSlackNotifications(sessionId: string): Promise<void> {
    await this.slackNotifications.recoverMissingSlackNotifications(sessionId);
  }

  private async notifySlackVerificationBlocker(sessionId: string, promptId: string): Promise<void> {
    await this.slackNotifications.notifySlackVerificationBlocker(sessionId, promptId);
  }

  private async notifySlackSessionArchived(sessionId: string): Promise<void> {
    await this.slackNotifications.notifySlackSessionArchived(sessionId);
  }

  private async notifySlackSessionStopped(sessionId: string): Promise<void> {
    await this.slackNotifications.notifySlackSessionStopped(sessionId);
  }

  private async notifySlackThread(sessionId: string, promptId: string, success: boolean): Promise<void> {
    await this.slackNotifications.notifySlackThread(sessionId, promptId, success);
  }

  private async flushBufferedEventsBeforeDisconnect(): Promise<void> {
    this.enqueuePersistence(() => this.flushTextDeltaBuffer());
    await this.persistenceQueue;
  }

  private async scheduleAutoCloseAfterDisconnect(sessionId: string): Promise<void> {
    this.log.info({ sessionId, reason: "sandbox_disconnected" }, "Scheduling auto-close alarm");
    await this.processLifecycleEvent(sessionId, { type: "boundary.auto_close_scheduled" });
    await this.rescheduleSessionAlarm();
  }

  /**
   * Immediately fail the active prompt when the sandbox disconnects unexpectedly.
   * Emits session_error + prompt_failed events so the UI shows the failure instantly.
   * If queued prompts exist, spawns a new sandbox to process them.
   */
  private async failActivePromptOnDisconnect(
    session: SessionState,
    activePromptId: string,
    origin: PromptDisconnectOrigin = "unknown",
  ): Promise<void> {
    await this.promptQueue.failActivePromptOnDisconnect(session, activePromptId, origin);
    await this.clearActiveToolCalls(activePromptId);
  }

  private async handleDisconnectTerminalize(args: {
    session: SessionState;
    activePromptId: string | null;
    activePrompt: ReturnType<typeof doDb.getPrompts>[number] | null;
    origin: PromptDisconnectOrigin;
    preDispatchLifecycle: LifecycleState;
  }): Promise<"deferred" | "terminalized" | "rescheduled"> {
    // Provider/sandbox loss is independent of prompt and tool state. Every
    // reconnect/liveness expiry, including an idle session, passes through the
    // same provider-dead-only authority before runtime/session state can move to
    // a disconnect terminal.
    if (
      (await this.confirmRuntimeDeadBeforeTerminalize(
        args.session.sessionId,
        args.origin,
        args.preDispatchLifecycle,
      )) === "defer"
    ) {
      return "deferred";
    }

    if (args.activePromptId && args.activePrompt?.status === "processing") {
      this.markRuntimeKilledLocallyAfterUnexpectedDisconnect(args.session.sessionId, args.origin);
      await this.failActivePromptOnDisconnect(args.session, args.activePromptId, args.origin);
      this.ctx.waitUntil(this.projectRuntimeKilledAfterUnexpectedDisconnect(args.session.sessionId));
      return "terminalized";
    }

    await this.markRuntimeKilledAfterUnexpectedDisconnect(args.session.sessionId, args.origin);
    if (!args.activePromptId) {
      await this.scheduleAutoCloseAfterDisconnect(args.session.sessionId);
      return "terminalized";
    }

    await this.rescheduleSessionAlarm();
    return "rescheduled";
  }

  // ---------------------------------------------------------------------------
  // Alarm handler: auto-close idle sessions + stale prompt sweep
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    await this.alarmScheduler.alarm();
  }

  private async runAlarmTick(): Promise<void> {
    await this.ensureSocketCachesLoaded();
    const sid = this.resolveSessionId();
    if (!sid) {
      this.log.warn({}, "alarm() fired with no session in SQL -- skipping");
      return;
    }

    // ARC-1054: a due cleanup retry must fire even for stopped/archived
    // sessions (the runtimes cleanup targets), so dispatch it before the
    // archived/lifecycle guards below. The workflow re-arms or clears its own
    // deadline and reschedules, so returning here is safe.
    if (await this.dispatchE2BCleanupRetryAlarm(sid)) {
      return;
    }

    const sandboxState = doDb.getSandboxState(this.sql, sid);
    const sandboxDisconnectAt = sandboxState?.disconnectStartedAt ?? undefined;
    const autoCloseScheduledAt = sandboxState?.autoCloseScheduledAt ?? undefined;
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sid);
    const session = doDb.getSession(this.sql, sid) ?? undefined;
    if (session?.ownerUserId) {
      await this.setSentryUserContext(session.ownerUserId);
    }

    // Archived sessions are terminal: no deadline applies, no event should
    // fire. Without this guard the max-duration branch below would emit
    // prompt.max_duration_exceeded and write a failed prompt row long after
    // the session was closed (the leak this fix targets).
    if (session?.status === "archived") {
      await this.state.storage.deleteAlarm();
      this.log.info(
        { event: "alarm.noop_terminal_session", sessionId: sid, sessionStatus: session.status },
        "Alarm fired on archived session -- cleared without side effects",
      );
      return;
    }

    await this.fireDuePlanParkPause(sid);
    await this.fireDuePlanReadyDelivery(sid);
    await this.reconcilePlanApprovalSpine(sid);
    await this.rescheduleSessionAlarm();
    const sandboxStatus = sandboxState?.status ?? undefined;
    const prompts = doDb.getPrompts(this.sql, sid);
    const activePrompt = activePromptId ? prompts.find((p) => p.promptId === activePromptId) : null;
    const sandboxSocket = this.getSandboxSocket();

    const reconnectGraceDeadline = await this.state.storage.get<number>(
      LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
    );
    if (
      sandboxSocket &&
      session &&
      typeof reconnectGraceDeadline === "number" &&
      reconnectGraceDeadline <= Date.now()
    ) {
      const socketTags = this.getSocketTags(sandboxSocket);
      const socketConnectionGeneration = this.getSandboxConnectionGeneration(socketTags);
      const acceptedHandoff = sandboxDisconnectAt
        ? await this.state.storage.get<{ connectionGeneration: number; acceptedAtMs: number }>(
            ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY,
          )
        : null;
      const socketProvesReconnect =
        !sandboxDisconnectAt ||
        (socketConnectionGeneration !== null &&
          acceptedHandoff?.connectionGeneration === socketConnectionGeneration &&
          acceptedHandoff.acceptedAtMs >= sandboxDisconnectAt);
      const liveSandboxId = sandboxState?.sandboxId ?? this.getSocketTagValue(socketTags, "sid:");
      if (socketProvesReconnect && liveSandboxId) {
        await this.processLifecycleEvent(sid, {
          type: "sandbox.ws_connected",
          sandboxId: liveSandboxId,
        });
        // Reconnect-grace cleanup (alarm path): local sandbox_state is already
        // durable. The next alarm will reproject if this attempt rejects. This
        // is a passive reconciliation path — opt into drift detection so a
        // genuinely stale `session_index.rich_status` still surfaces.
        await this.swallowLifecyclePersistence(
          sid,
          "sandbox_transport_event",
          () =>
            this.persistCurrentRichStatus(sid, "sandbox_transport_event", {
              mode: "passive_reconciliation",
              source: "reconnect_grace_cleanup_live_socket",
            }),
          "",
        );
        this.log.info(
          { event: "sandbox_reconnect_grace_deadline_cleared_for_live_socket", sessionId: session.sessionId },
          "Cleared stale reconnect grace deadline for live sandbox socket",
        );
      }
    }

    // ARC-876: fire any past-due post-execution / publishing watchdogs before
    // anything else routes the alarm. Watchdogs run inside their own
    // runCriticalPersistence so the flush + CAS + durable failed entry land
    // together. The dispatch is a no-op if nothing is past-due.
    // ARC-1330 D-50A — the managed verification-comment retry pass was removed with the comment surface.
    await this.dispatchWatchdogAlarms(sid);
    // ARC-1330 standing-stock self-heal: a review-listening row published BEFORE the universal no-signal
    // advance arm has no deadline armed, so its drain never runs and an epoch-terminal recompute reads its
    // zero-checks head as uncorroborated-absent → ci_pending forever (the wedge / hot-loop). Arm it once
    // here, gated on the already-loaded `reviewListeningActive` so only post-publish sessions pay the
    // storage read and the arm is a no-op once a key exists. The fire block below owns everything after; its
    // honest CI read can never fabricate green, so self-arming is exactly as sound as the publish-time arm.
    try {
      const hasArmedNoSignalDeadline =
        (await this.state.storage.get(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY)) != null;
      // `reviewListeningActive` is an EXTENDED session field (not on the base `getSession` above), so read
      // it from the DO's own sqlite (cheap, no D1) — the same gate the alarm reprojection uses. Only paid
      // when no key is armed yet, so a session already carrying the advance skips the read entirely.
      const reviewListeningActive =
        !hasArmedNoSignalDeadline && doDb.getSessionExtended(this.sql, sid)?.reviewListeningActive === true;
      if (shouldSelfArmNoSignalAdvance(reviewListeningActive, hasArmedNoSignalDeadline)) {
        await this.state.storage.put(
          FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY,
          Date.now() + NO_SIGNAL_ADVANCE_WINDOW_MS,
        );
        await this.rescheduleSessionAlarm();
      }
    } catch (error) {
      this.log.warn(
        { event: "fsm.no_signal_advance.self_heal_failed", sessionId: sid, error: String(error) },
        "FSM no-signal advance self-heal arm threw; continuing alarm() tick",
      );
    }
    // ARC-1330: fire the bounded no-signal advance poll only when its own key is due. This producer has
    // no row-level due predicate; calling it on unrelated alarms would poll GitHub early. The result owns
    // key fate: re-arm for REVIEW/VERIFYING, delete after terminal/other states, and re-arm on transient
    // faults so a flaky poll cannot orphan the advance path.
    try {
      const noSignalAdvanceDeadline = await this.state.storage.get<number>(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY);
      if (typeof noSignalAdvanceDeadline === "number" && noSignalAdvanceDeadline <= Date.now()) {
        let fireResult: NoSignalAdvanceFireResult = { ok: false, reArm: true, emitted: false, ciState: null };
        try {
          fireResult = await shadowFireDueNoSignalAdvance(
            this.env,
            sid,
            Date.now(),
            {
              storage: this.state.storage,
              waitUntil: (promise) => this.ctx.waitUntil(promise),
            },
            this.log,
          );
        } catch (error) {
          this.log.warn(
            { event: "fsm.no_signal_advance.dispatch_failed", sessionId: sid, error: String(error) },
            "FSM no-signal advance dispatch threw; continuing alarm() tick",
          );
        }

        if (fireResult.reArm) {
          await this.state.storage.put(
            FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY,
            Date.now() + NO_SIGNAL_ADVANCE_WINDOW_MS,
          );
        } else {
          await this.state.storage.delete(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY);
        }
        await this.rescheduleSessionAlarm();
      }
    } catch (error) {
      this.log.warn(
        { event: "fsm.no_signal_advance.cleanup_failed", sessionId: sid, error: String(error) },
        "FSM no-signal advance cleanup threw; continuing alarm() tick",
      );
    }
    // ARC-1330 (PR 44/47, DE-3): fire the per-session state-deadline backstop from the same alarm tick
    // (the noshow producer's pattern). SHADOW = observe-only would-fire logging (F39, the no-op sink);
    // LIVE = the real `deadline_exceeded` routes through the live resolver + sink, so a dwelt-past-
    // deadline REVIEW lands NEEDS_YOU(review_stuck) with the drain + loud effects dispatched. Fires
    // opportunistically on whatever alarm cadence the session already has (watchdogs/liveness) — a
    // dedicated deadline-precise alarm arm is the PR 48/49 reconcile slice. Self-isolated like noshow.
    try {
      const planApprovalPending = doDb.getLatestSessionPlan(this.sql, sid)?.status === "pending";
      await shadowFireDueDeadline(
        this.env,
        sid,
        Date.now(),
        this.log,
        undefined,
        (promise) => this.ctx.waitUntil(promise),
        planApprovalPending,
      );
    } catch (error) {
      this.log.warn(
        { event: "fsm.deadline_alarm.dispatch_failed", sessionId: sid, error: String(error) },
        "FSM deadline alarm dispatch threw; continuing alarm() tick",
      );
    }
    await this.recoverMissingSlackNotifications(sid);

    // Snapshot the lifecycle state BEFORE dispatch: a disconnect-terminal event
    // applies its terminal persist (prompt.phase="terminal", prompt deadlines
    // cleared) during dispatch even when the emit is deferred. The chokepoint's
    // defer path restores this snapshot so a probe-alive prompt can resume.
    const preDispatchLifecycle = await this.readLifecycleState(sid);
    const lifecycleAlarm = await this.dispatchLifecycleAlarm(sid);
    const reconnectGraceExpiredByLifecycle = lifecycleAlarm.eventTypes.includes("sandbox.reconnect_grace_expired");
    // A silent VM death surfaces as sandbox.liveness_expired (no clean WS close,
    // so no reconnect-grace deadline arms). Route it through the same disconnect
    // handling as reconnect-grace so a still-processing prompt re-runs on a fresh
    // sandbox (bounded by DISCONNECT_RETRY_CAP) instead of terminalizing.
    const livenessExpiredByLifecycle = lifecycleAlarm.eventTypes.includes("sandbox.liveness_expired");
    const disconnectTerminalByLifecycle = reconnectGraceExpiredByLifecycle || livenessExpiredByLifecycle;
    const disconnectOrigin: PromptDisconnectOrigin =
      livenessExpiredByLifecycle && !reconnectGraceExpiredByLifecycle ? "liveness_expiry" : "reconnect_grace_expiry";
    if (lifecycleAlarm.handled) {
      if (disconnectTerminalByLifecycle && !sandboxDisconnectAt && session) {
        await this.handleDisconnectTerminalize({
          session,
          activePromptId,
          activePrompt: activePrompt ?? null,
          origin: disconnectOrigin,
          preDispatchLifecycle,
        });
        return;
      }
      if (!disconnectTerminalByLifecycle) {
        return;
      }
    }

    if (sandboxDisconnectAt) {
      const elapsedMs = Date.now() - sandboxDisconnectAt;

      if (sandboxSocket && session && !disconnectTerminalByLifecycle) {
        clearTransportMarkers({ sql: this.sql, sessionId: sid });
        // Reconnect-grace alarm path: local sandbox_state is already durable.
        // If the projection rejects, swallow + Sentry-tag so the alarm
        // reschedule below still runs. The control-plane mutation contract
        // for putSandboxStatus (propagate-on-rejection) is preserved at all
        // non-alarm call sites.
        await this.swallowLifecyclePersistence(
          session.sessionId,
          "sandbox_transport_event",
          () => this.putSandboxStatus(session.sessionId, "ready"),
          undefined,
        );
        await this.rescheduleSessionAlarm();

        this.log.info(
          { event: "sandbox_reconnected_in_grace", sessionId: session.sessionId, elapsedMs },
          "Sandbox reconnected during grace period",
        );
      } else if (elapsedMs >= SANDBOX_RECONNECT_GRACE_MS || disconnectTerminalByLifecycle) {
        if (session) {
          const terminalizeOutcome = await this.handleDisconnectTerminalize({
            session,
            activePromptId,
            activePrompt: activePrompt ?? null,
            origin: disconnectOrigin,
            preDispatchLifecycle,
          });
          if (terminalizeOutcome === "deferred") {
            return;
          }

          // Distinguish silent VM death (liveness lease lapsed, no clean close)
          // from clean-close reconnect-grace expiry in the log, even though both
          // route through the same recovery.
          const disconnectExpiryLog =
            livenessExpiredByLifecycle && !reconnectGraceExpiredByLifecycle
              ? { event: "sandbox_liveness_expired", message: "Sandbox liveness deadline expired" }
              : { event: "sandbox_reconnect_grace_expired", message: "Sandbox reconnect grace period expired" };
          this.log.warn(
            {
              event: disconnectExpiryLog.event,
              sessionId: session.sessionId,
              elapsedMs,
              hadActivePrompt: Boolean(activePromptId),
            },
            disconnectExpiryLog.message,
          );
        } else {
          doDb.updateSandboxState(this.sql, sid, {
            status: "stopped",
            stopReason: "reaped",
          });
          clearTransportMarkers({ sql: this.sql, sessionId: sid });
          // Reaper alarm path with no session row: local sandbox_state is
          // durable. Don't let a projection rejection block the alarm
          // reschedule. This is a passive reconciliation path — opt into
          // drift detection so a stale `session_index.rich_status` still
          // surfaces.
          await this.swallowLifecyclePersistence(
            sid,
            "sandbox_transport_event",
            () =>
              this.persistCurrentRichStatus(sid, "sandbox_transport_event", {
                mode: "passive_reconciliation",
                source: "reaper_alarm_no_session",
              }),
            "",
          );
          await this.rescheduleSessionAlarm();
        }
      } else {
        await this.rescheduleSessionAlarm();
      }
      return;
    }

    if (autoCloseScheduledAt) {
      scheduleAutoCloseAt({ sql: this.sql, sessionId: sid, at: null });

      if (session && !activePromptId && !this.getSandboxSocket()) {
        this.log.info({ sessionId: session.sessionId, reason: "sandbox_disconnected" }, "Auto-stopping idle session");
        const stopOutcome = await this.stopSessionAtDurabilityBoundary(session, "sandbox_disconnected", {
          stopReason: "reaped",
        });

        const env = this.env as Env;
        if (env.DB) {
          await syncSessionProjection({
            db: env.DB,
            sessionId: session.sessionId,
            session,
            replay: stopOutcome.replay,
            richStatus: stopOutcome.richStatus,
            logger: this.log,
            requestId: this.requestId,
            source: "durable-object.autoStop",
          });
        }
      }
      await this.rescheduleSessionAlarm();
      return;
    }

    if (sandboxStatus === "spawning") {
      if (!session) return;
      if (!activePrompt || activePrompt.status !== "processing") {
        await this.clearSpawnAttemptState(true);
        await this.putSandboxStatus(session.sessionId, "stopped", { stopReason: "spawn_failed" });
        resetSpawnRetryOnSuccess({ sql: this.sql, sessionId: sid });
        await this.rescheduleSessionAlarm();
        this.log.warn(
          { sessionId: session.sessionId },
          "Spawn timed out without an active prompt -- cleaned up stalled spawn",
        );
        return;
      }

      const spawnStartedAt = sandboxState?.spawnStartedAt ?? undefined;
      const spawnColdStart = (await this.state.storage.get("spawn_cold_start")) as boolean | undefined;
      const spawnTimeout = this.getSpawnConnectTimeoutMs(spawnColdStart);
      const spawnElapsed = spawnStartedAt ? Date.now() - spawnStartedAt : Infinity;
      if (spawnElapsed >= spawnTimeout) {
        await this.collectE2BBridgeStartupDiagnostics(session.sessionId, sandboxState, "spawn_connect_timeout");
        await this.handleSpawnTimeout(
          session.sessionId,
          session,
          prompts,
          activePrompt,
          `Sandbox failed to connect within ${spawnTimeout / 60000} minutes -- retrying`,
          "deadline",
          spawnTimeout,
        );
        return;
      }

      await this.scheduleSpawnConnectAlarm();
      return;
    }

    if (!activePromptId || !activePrompt || activePrompt.status !== "processing") {
      await this.rescheduleSessionAlarm();
      return;
    }

    if (!session) return;

    const now = Date.now();

    if (activePrompt.startedAt) {
      const maxDurationMs = this.getPromptMaxDurationMs();
      const startedAtMs = new Date(activePrompt.startedAt).getTime();
      const maxDurationDeadline = startedAtMs + maxDurationMs;
      if (now >= maxDurationDeadline) {
        // A max-duration trip on a dead sandbox with no prompt activity is a
        // phantom timeout: the sandbox died (or never spawned) and the prompt
        // never ran, not a genuine long turn. Route it through the bounded
        // disconnect-retry flow on a fresh sandbox instead of a hard
        // max_duration_exceeded failure.
        //
        // Gate on the sandbox actually being gone (no live socket): a genuinely
        // long prompt keeps its socket and must still fail max_duration_exceeded.
        // prompt_last_activity_at is only written on the connect-dispatch path
        // (sendPendingPromptToSandbox), NOT for prompts dispatched over an
        // already-live socket, so a null/stale value alone does not prove the
        // prompt never ran — the missing socket does. Keep the activity check as a
        // secondary guard (never the heartbeat-stamped lastActivityAt) so a prompt
        // that demonstrably ran is never reclassified.
        const promptActivityAt = sandboxState?.promptLastActivityAt ?? null;
        const promptNeverStarted = !sandboxSocket && (promptActivityAt == null || promptActivityAt < startedAtMs);
        if (promptNeverStarted) {
          this.ctx.waitUntil(
            postStructuredEventToDd(this.env, {
              event: "prompt.sandbox_never_started",
              action: "prompt.sandbox_never_started",
              sessionId: session.sessionId,
              promptId: activePrompt.promptId,
              businessId: session.businessId,
              sandboxId: sandboxState?.sandboxId ?? null,
              connectionGeneration: this.cachedSandboxConnectionGen,
              durationMs: now - startedAtMs,
              ceilingMs: maxDurationMs,
              timestamp: new Date(now).toISOString(),
            }),
          );
          await this.failActivePromptOnDisconnect(session, activePrompt.promptId, "sandbox_never_started");
          return;
        }
        this.ctx.waitUntil(
          postStructuredEventToDd(this.env, {
            event: "prompt.max_duration_exceeded",
            action: "prompt.max_duration_exceeded",
            sessionId: session.sessionId,
            promptId: activePrompt.promptId,
            businessId: session.businessId,
            sandboxId: sandboxState?.sandboxId ?? null,
            connectionGeneration: this.cachedSandboxConnectionGen,
            durationMs: now - startedAtMs,
            ceilingMs: maxDurationMs,
            timestamp: new Date(now).toISOString(),
          }),
        );
        await this.completeActivePrompt(
          session.sessionId,
          {
            success: false,
            error: "Prompt exceeded maximum duration",
            errorCode: "max_duration_exceeded",
          },
          activePrompt.promptId,
          "execution_complete",
        );
        return;
      }
    }

    await this.rescheduleSessionAlarm();
  }

  // ---------------------------------------------------------------------------
  // Sandbox spawning (E2B)
  // ---------------------------------------------------------------------------

  /**
   * Provider create wrapped in the ARC-1477 reservation trace: a D1 row is
   * written BEFORE the create so a lost create response (VM made server-side,
   * id received by nobody) still leaves durable evidence for the alert-only
   * VM audit. Sessions without a session id (none in the spawn path today)
   * skip tracing rather than write an unattributable row.
   */
  private createSandboxWithVmReservationTrace(
    client: SandboxProviderClient,
    request: E2BCreateSandboxRequest,
    operation: string,
    spawnAttemptId: string | null,
    attempt: number | null,
  ): Promise<E2BCreateSandboxResponse> {
    const sessionId = request.sessionId;
    if (!sessionId) {
      return client.createSandbox(request);
    }
    const runtimeBackend =
      parsePersistedRuntimeBackendOrNull(request.metadata?.runtime_backend) ?? E2B_CLOUD_RUNTIME_BACKEND;
    return createSandboxWithReservationTrace({
      db: this.env.DB,
      create: () => client.createSandbox(request),
      context: {
        sessionId,
        spawnAttemptId,
        attempt,
        runtimeBackend,
        vmName: runtimeBackend === FREESTYLE_RUNTIME_BACKEND ? buildVmName(request) : null,
        operation,
      },
      logger: this.log,
      onPossibleOrphan: (fields) => {
        // logpush is off — direct-post so the possible-orphan signal reaches
        // Datadog immediately rather than waiting for the hourly audit sweep.
        this.ctx.waitUntil(
          postStructuredEventToDd(this.env, {
            event: "sandbox.create.possible_orphan",
            timestamp: new Date().toISOString(),
            ...fields,
          }),
        );
      },
    });
  }

  private async createRuntimeSandboxForSpawn(
    client: SandboxProviderClient,
    request: E2BCreateSandboxRequest,
    operation: string,
    spawnAttemptId?: string,
  ): Promise<E2BCreateSandboxResponse> {
    const trackedSpawnAttemptId = spawnAttemptId;
    if (!trackedSpawnAttemptId) {
      return this.createSandboxWithVmReservationTrace(client, request, operation, null, null);
    }
    const requestSessionId = request.sessionId;
    if (!requestSessionId) {
      throw new Error("Session sandbox spawn retry requires a session id");
    }

    const stepPrefix = spawnCreateStepPrefix(requestSessionId, trackedSpawnAttemptId);
    const clearAttemptSteps = async () => {
      try {
        await clearDurableStepsByPrefix(this.state.storage, stepPrefix);
      } catch (err) {
        this.log.warn(
          { spawnAttemptId: trackedSpawnAttemptId, error: serializeError(err) },
          "Failed to clear durable spawn steps",
        );
      }
    };

    let lastErr: unknown;
    // Only clear steps on terminal failure / abort. On the success path the
    // step must survive past `return` because the caller still performs
    // `startCommand` + `recordRunningE2BRuntimeForSpawn` (multiple awaits) —
    // a DO crash during those needs the cached `runtimeSandboxId` on replay,
    // otherwise the helper memoization is defeated.
    try {
      for (let attempt = 1; attempt <= DEFAULT_SPAWN_RETRY_POLICY.maxAttempts; attempt += 1) {
        if (!(await this.isCurrentSpawnAttempt(trackedSpawnAttemptId))) {
          throw new SpawnRetryAbortedError("stale");
        }
        try {
          const stepName = spawnCreateStepName(requestSessionId, trackedSpawnAttemptId, attempt);
          const result = await durableStep(
            this.state.storage,
            stepName,
            // Trace lives INSIDE the durable step: a memoized replay returns
            // the cached result without re-running create, so rows pair 1:1
            // with actual provider create calls.
            () => this.createSandboxWithVmReservationTrace(client, request, operation, trackedSpawnAttemptId, attempt),
            this.log,
          );
          const sandboxReady = await (async () => {
            const sandbox = doDb.getSandboxState(this.sql, requestSessionId);
            return Boolean(sandbox?.status === "ready" && sandbox.runtimeSandboxId);
          })();
          if (sandboxReady) {
            // Route through terminateRuntimeWithLog (not a bare terminateSandbox)
            // so this kill emits the same session-tagged `runtime.terminate` log
            // as the other 12 call sites — otherwise a duplicate-retry kill would
            // be invisible to the by-session query used for incident post-mortems.
            void this.terminateRuntime({
              sessionId: requestSessionId,
              runtimeSandboxId: result.runtimeSandboxId,
              reason: "duplicate_spawn_retry",
              logger: this.log,
              message: "Failed to terminate stale E2B sandbox after retry create",
              extraLogFields: { operation, spawnAttemptId: trackedSpawnAttemptId },
              terminate: (reason) => client.terminateSandbox(result.runtimeSandboxId, reason),
            });
            throw new SpawnRetryAbortedError("ready");
          }
          return result;
        } catch (err) {
          if (err instanceof SpawnRetryAbortedError) throw err;
          lastErr = err;
          const isRetryable =
            typeof err === "object" &&
            err !== null &&
            (err as { name?: unknown }).name === "E2BSandboxRuntimeError" &&
            RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has(String((err as { code?: unknown }).code));
          const canRetry = isRetryable && attempt < DEFAULT_SPAWN_RETRY_POLICY.maxAttempts;
          this.log.warn(
            {
              metric: "sandbox.spawn.retry",
              outcome: canRetry ? "retrying" : isRetryable ? "exhausted" : "non_retryable",
              sessionId: requestSessionId,
              operation,
              spawnAttemptId: trackedSpawnAttemptId,
              attempt,
              maxAttempts: DEFAULT_SPAWN_RETRY_POLICY.maxAttempts,
              retryable: isRetryable,
              error: stringifyError(err),
            },
            "E2B sandbox spawn attempt failed",
          );
          if (!canRetry) throw err;
          const timestamp = nowIso();
          await this.appendAndBroadcastEvents(requestSessionId, [
            {
              type: "retry_status",
              timestamp,
              data: {
                timestamp: Date.now(),
                scope: "sandbox_spawn",
                attempt: attempt + 1,
                maxAttempts: DEFAULT_SPAWN_RETRY_POLICY.maxAttempts,
                reason: "network",
                message: "Sandbox failed to start. Retrying...",
              },
            },
          ]);
        }
      }

      throw lastErr;
    } catch (err) {
      // Includes `SpawnRetryAbortedError` (stale / ready abort) and terminal
      // non-retryable failures. Either way the attempt is over without a
      // useful sandbox to record — drop its cached steps.
      await clearAttemptSteps();
      throw err;
    }
  }

  /**
   * Start the sandbox bridge as a resumable phase (ARC-1042). Thin binder over
   * `resumableBridgeStart`; see that helper for the crash-window reasoning.
   */
  private async startBridgeForSpawn(
    sessionId: string,
    spawnAttemptId: string | undefined,
    runtimeSandboxId: string,
    startBridge: () => Promise<unknown>,
  ): Promise<void> {
    await resumableBridgeStart({
      storage: this.state.storage,
      sessionId,
      spawnAttemptId,
      runtimeSandboxId,
      startBridge,
      probeBridgeHealth: (sid, rid, sinceMs) => this.waitForE2BBridgeHealth(sid, rid, sinceMs),
      logger: this.log,
    });
  }

  /**
   * Clear all durable workflow state for one spawn attempt: every step record
   * under the unified `session_attempt:{sessionId}:{spawnAttemptId}` prefix
   * (bootstrap / create / bridge / attach). The bootstrap step holds the sandbox
   * auth token, so dropping it is also defense in depth. Best-effort: a transient
   * storage failure here must not break the terminal path that calls it.
   */
  private async clearSpawnAttemptWorkflow(sessionId: string, spawnAttemptId: string): Promise<void> {
    try {
      await clearDurableStepsByPrefix(this.state.storage, spawnAttemptPrefix(sessionId, spawnAttemptId));
    } catch (err) {
      this.log.warn(
        { sessionId, spawnAttemptId, error: serializeError(err) },
        "Failed to clear spawn attempt workflow state",
      );
    }
  }

  private async recordRunningE2BRuntimeForSpawn(options: RunningRuntimeRecordOptions): Promise<void> {
    const env = this.env as Env;
    await Promise.all([
      this.storeCurrentSandboxCredentialEnvKeys(options.credentialEnvKeys),
      this.storeCurrentSandboxCredentialFingerprints(options.credentialFingerprints),
    ]);

    const nowMs = Date.now();
    const runtimeLiveLeaseMs = getE2BRuntimeLiveLeaseMs(env);
    const liveLeaseExpiresAt = nowMs + runtimeLiveLeaseMs;
    const providerTtlMs = parsePositiveMsEnv(env.E2B_SANDBOX_TIMEOUT_MS, 3_600_000);
    const providerLifetimeRefreshedAt =
      options.providerLifetimeRefreshedAt === undefined ? nowMs : options.providerLifetimeRefreshedAt;
    const runtimeLastProviderRefreshedAt = providerLifetimeRefreshedAt ?? 0;
    const runtimeProviderTtlExpiresAt =
      providerLifetimeRefreshedAt !== null ? providerLifetimeRefreshedAt + providerTtlMs : nowMs;
    const runtimeState = {
      runtimeProvider: providerForRuntimeBackend(options.runtimeBackend),
      runtimeBackend: options.runtimeBackend,
      runtimeState: "running" as const,
      runtimeSandboxId: options.runtimeSandboxId,
      runtimeTemplateId: options.runtimeTemplateId,
      runtimeStateExpiresAt: null,
      runtimeLiveLeaseExpiresAt: liveLeaseExpiresAt,
      runtimePreviewUrl: null,
      runtimeCreatedAt: nowMs,
      runtimeLastResumedAt: nowMs,
      runtimeLastProviderRefreshedAt,
      runtimeProviderTtlExpiresAt,
    };

    // Reclaim the prior runtime this attach is about to overwrite. `attachRuntime`
    // column-patches the new id over the old one with no read-before-write, so after
    // it lands the prior id is gone from both sandbox_state and session_index and no
    // sweep can ever reclaim it (the superseded-attempt zombie class). The DECISION is
    // read BEFORE the overwrite; the terminate FIRES only after the attach write
    // commits, so an interrupted/failed attach leaves the prior VM untouched while the
    // row still points at it. Raw column read for the backend: `getSandboxState`
    // normalizes runtime_backend through `runtimeBackendOrNull`, which collapses a
    // corrupt non-empty value into the same null the legacy-e2b default consumes — the
    // decider must see the raw value so corruption skips (logged) instead of
    // terminating against the wrong provider. Same-id (resume re-attach) and
    // null/empty prior ids no-op; ARC-1399 forbids the reservations table from
    // feeding this kill.
    const priorRuntimeSandboxId = doDb.getSandboxState(this.sql, options.sessionId)?.runtimeSandboxId;
    const priorRawRuntimeBackend =
      this.sql.exec("SELECT runtime_backend FROM sandbox_state WHERE session_id = ?", options.sessionId).toArray()[0]
        ?.runtime_backend ?? null;
    const supersededTarget = decideSupersededRuntimeTerminate({
      priorRuntimeSandboxId,
      priorRuntimeBackend: priorRawRuntimeBackend,
      nextRuntimeSandboxId: options.runtimeSandboxId,
    });
    if (
      !supersededTarget &&
      typeof priorRuntimeSandboxId === "string" &&
      priorRuntimeSandboxId !== "" &&
      priorRuntimeSandboxId !== options.runtimeSandboxId
    ) {
      // Distinct prior VM, but its persisted backend is unparseable — we cannot pick
      // a provider to terminate against, so skip rather than guess (never a throw
      // into the spawn path). Logged so a corrupted persisted backend stays visible.
      this.log.info(
        {
          sessionId: options.sessionId,
          priorRuntimeSandboxId,
          priorRuntimeBackend: priorRawRuntimeBackend,
          nextRuntimeSandboxId: options.runtimeSandboxId,
        },
        "Skipping superseded-runtime terminate: prior runtime backend unparseable",
      );
    }

    await attachRuntime({
      sql: this.sql,
      env,
      sessionId: options.sessionId,
      runtimeState,
      sandboxState: {
        ...runtimeState,
        sandboxAuthTokenHash: options.sandboxAuthTokenHash,
        sandboxId: options.sandboxId,
      },
    });

    if (supersededTarget) {
      // Post-commit: the new runtime owns the row; the superseded VM can no longer be
      // the session's runtime under any failure path. `waitUntil` (not a bare `void`)
      // ties the promise to the DO lifetime; `terminateRuntime` never rejects.
      this.ctx.waitUntil(
        this.terminateRuntime({
          sessionId: options.sessionId,
          runtimeSandboxId: supersededTarget.runtimeSandboxId,
          reason: "superseded_runtime",
          logger: this.log,
          message: "Failed to terminate superseded runtime at cold attach",
          extraLogFields: { supersededByRuntimeSandboxId: options.runtimeSandboxId },
          terminate: (reason) =>
            this.buildCleanupClient(supersededTarget.runtimeBackend).terminateSandbox(
              supersededTarget.runtimeSandboxId,
              reason,
            ),
        }),
      );
    }

    const runtimeProvenance: RuntimeProvenance = {
      bootMode: options.bootMode,
      modalEnvironment: null,
      modalObjectId: null,
      sandboxImageVersion: options.sandboxImageVersion ?? null,
      dockerEnabled: options.dockerEnabled,
      appRuntimeProfileSource: options.appRuntimeProfileSource,
      appRuntimeProfileDiagnostics: options.appRuntimeProfileDiagnostics,
      repoImagePrimaryBootEnabled: options.repoImagePrimaryBootEnabled,
      repoImagePrimaryBootBlockedReason: options.repoImagePrimaryBootBlockedReason,
      repoImageLookupResult: options.repoImagePrimaryBootEnabled ? options.repoImageLookupResult : null,
      repoImageMissReason: options.repoImagePrimaryBootEnabled ? options.repoImageMissReason : null,
      repoImageId: options.repoImageId,
      repoImageSha: options.repoImageSha,
      repoImageStartupFallback: options.repoImageStartupFallback,
      sessionSnapshotImageId: options.sessionSnapshotImageId,
      runtime: {
        provider: providerForRuntimeBackend(options.runtimeBackend),
        backend: options.runtimeBackend,
        sandboxId: options.runtimeSandboxId,
        templateId: options.runtimeTemplateId,
        reportedAt: nowMs,
      },
      sandboxLayerSelection: options.sandboxLayerSelection ?? null,
      sandboxLayer: options.sandboxLayerArtifact
        ? {
            sourceId: options.sandboxLayerArtifact.source_id,
            commitSha: options.sandboxLayerArtifact.commit_sha,
            sourceContentHash: options.sandboxLayerArtifact.source_content_hash,
            baseTemplateRef: options.sandboxLayerArtifact.base_template_ref,
            baseVersion: options.sandboxLayerArtifact.base_version,
            resourceProfileKey: options.sandboxLayerArtifact.resource_profile_key,
            provider: options.sandboxLayerArtifact.provider,
            providerArtifactRef: options.sandboxLayerArtifact.provider_artifact_ref,
            buildId: options.sandboxLayerArtifact.build_id,
          }
        : null,
      updatedAt: nowMs,
    };
    const observabilityReadiness = buildInitialObservabilityReadiness(env);
    await this.putRuntimeProvenance(runtimeProvenance);
    await this.putObservabilityReadiness(observabilityReadiness);
    this.broadcast({ type: "runtime_provenance_updated", runtimeProvenance });
    this.broadcast({ type: "observability_readiness_updated", observabilityReadiness });
  }

  private async tryResumeE2BRuntimeForSpawn(
    sessionId: string,
    runtimeConfig: E2BRuntimeClientConfig,
    spawnAttemptId?: string,
  ): Promise<boolean> {
    const env = this.env as Env;
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    // Post-attach convergence (ARC-1045): a successful resume flips runtimeState
    // to "running" but does NOT set sandbox.status='ready', so the cold-create
    // `sandboxReady` abort cannot catch a just-resumed runtime. A crash after
    // `attachRuntime` would otherwise make this return false and let
    // `spawnSandbox` fall through to a cold create and start a DUPLICATE runtime.
    //
    // Gate convergence on THIS attempt's `runtimeAttached` durable step — the
    // attach below is wrapped in it. The local sandbox_state write (runtimeState
    // 'running') and that marker commit together in DO storage, so a replay sees
    // both or neither. This deliberately does NOT converge on a bare
    // runtimeState='running' row: a sandbox reaped by `discardStaleSandboxTransport`
    // leaves `status='stopped'`/stale `runtimeState='running'` with no marker for
    // the new attempt, and must fall through to a fresh spawn rather than exit
    // with no live bridge.
    const resumeAttachedMarkerPresent = spawnAttemptId
      ? await hasDurableStep(
          this.state.storage,
          spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.runtimeAttached),
        )
      : false;
    if (
      shouldConvergeResumeReplay({
        sandbox,
        hasAttemptId: Boolean(spawnAttemptId),
        hasRuntimeAttachedMarker: resumeAttachedMarkerPresent,
      })
    ) {
      this.log.info(
        {
          sessionId,
          spawnAttemptId,
          runtimeSandboxId: sandbox?.runtimeSandboxId,
          event: "e2b_resume_converge_running",
        },
        "E2B runtime already attached by this resume attempt; treating resume as success",
      );
      return true;
    }
    if (
      !sandbox ||
      !isKnownRuntimeProvider(sandbox.runtimeProvider) ||
      !sandbox.runtimeSandboxId ||
      sandbox.runtimeState !== "paused"
    ) {
      return false;
    }
    const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
    if (runtimeBackend !== runtimeConfig.runtimeBackend) {
      throw new Error("Persisted runtime backend changed during E2B resume");
    }

    const runtimeSandboxId = sandbox.runtimeSandboxId;
    const cleanupStaleOrFailedResumedRuntime = async (releaseReason: "cleanup" | "spawn_failure" | "stale_spawn") => {
      await this.terminateRuntime({
        sessionId,
        runtimeSandboxId,
        logger: this.log,
        message:
          releaseReason === "stale_spawn"
            ? "Failed to terminate stale resumed E2B runtime"
            : "Failed to terminate resumed E2B runtime during cleanup",
        reason: releaseReason === "stale_spawn" ? "resume_stale_cleanup" : "resume_failure_cleanup",
        terminate: (reason) => runtimeConfig.client.terminateSandbox(runtimeSandboxId, reason),
      });
      await clearRuntimeAndSyncProjection({
        sql: this.sql,
        env: this.env,
        sessionId,
        expectedProvider: this.expectedProviderForRuntimeClear(sessionId, runtimeBackend),
      });
    };
    // Stale-path cleanup must be skipped ENTIRELY when this attempt was
    // superseded (ARC-1045 gap #4 beyond-capacity): both resume attempts target
    // the SAME persisted paused sandbox, so terminating it / clearing its
    // runtime row / releasing its capacity would clobber the runtime the current
    // attempt just resumed. `abortIfStaleSpawnAttempt` only fires onStale once
    // this attempt is already not-current, so this always skips there; the
    // explicit check is defense in depth for any future caller.
    const cleanupResumedRuntimeIfCurrent = async (releaseReason: "stale_spawn") => {
      const isCurrent = spawnAttemptId ? await this.isCurrentSpawnAttempt(spawnAttemptId) : true;
      if (!shouldReleaseSupersededCapacity(spawnAttemptId, isCurrent)) {
        this.log.info(
          { sessionId, runtimeSandboxId, spawnAttemptId, event: "resume_stale_cleanup_skipped" },
          "Skipping superseded resume cleanup; current attempt owns the shared sandbox",
        );
        return;
      }
      await cleanupStaleOrFailedResumedRuntime(releaseReason);
    };
    const expiresAt = sandbox.runtimeStateExpiresAt ?? 0;
    if (expiresAt > 0 && expiresAt <= Date.now()) {
      this.log.info({ sessionId, runtimeSandboxId, expiresAt }, "E2B paused runtime expired; creating fresh sandbox");
      await cleanupStaleOrFailedResumedRuntime("cleanup");
      return false;
    }

    const startedAt = Date.now();
    const operation = "spawnSandbox.resume.live";
    const postResumeWallEvent = (outcome: "resumed" | "failed", errorClass: string | null): void => {
      this.ctx.waitUntil(
        postStructuredEventToDd(
          this.env,
          buildSandboxResumeWallEvent({
            sessionId,
            runtimeSandboxId,
            runtimeBackend,
            operation,
            resumeWallMs: Date.now() - startedAt,
            outcome,
            errorClass,
          }),
        ).catch(() => false),
      );
    };
    try {
      await runtimeConfig.client.connectSandbox(
        runtimeSandboxId,
        parsePositiveMsEnv(env.E2B_SANDBOX_TIMEOUT_MS, 3_600_000),
      );
    } catch (err) {
      postResumeWallEvent(
        "failed",
        err instanceof E2BSandboxRuntimeError ? err.code : err instanceof Error ? err.name : "unknown",
      );
      if (err instanceof E2BSandboxRuntimeError && (err.code === "missing_sandbox" || err.code === "killed")) {
        // This clear nulls runtime_sandbox_id in BOTH sandbox_state and
        // session_index. Guard it so it can never create the orphan-reaper
        // desync it would otherwise cause:
        //   (1) CAS — a racing newer attempt may have attached a DIFFERENT
        //       sandbox to this session since we read it; clearing would orphan
        //       that newer live VM. Only clear if this exact id+backend still
        //       owns the row.
        //   (2) Confirm death — the connect error claims the sandbox is gone,
        //       but a spurious missing/killed on a still-live VM would let the
        //       clear orphan it. Probe via getInfo (no resume); only skip the
        //       clear when E2B AFFIRMATIVELY reports the VM alive (unknown falls
        //       through to clear, failing toward existing behavior).
        const current = doDb.getSandboxState(this.sql, sessionId);
        const stillOurs =
          current != null &&
          isKnownRuntimeProvider(current.runtimeProvider) &&
          current.runtimeSandboxId === runtimeSandboxId &&
          this.readPersistedRuntimeBackend(sessionId) === runtimeBackend;
        // Only probe when this attempt still owns the row (avoid a needless E2B
        // call when a newer attempt already superseded us).
        const liveness = stillOurs
          ? await this.probeE2BRuntimeLiveness(runtimeConfig.client, runtimeSandboxId)
          : "unknown";
        const clearDecision = decideResumeFailureClear({ stillOurs, liveness });
        // Direct-post the decision: a frequent `skip_live` (e.g. a false-negative
        // probe wrongly holding a dead VM) is otherwise invisible in Datadog since
        // control-plane app logs are not shipped.
        this.ctx.waitUntil(
          postStructuredEventToDd(
            this.env,
            buildResumeFailureClearDecisionEvent({
              sessionId,
              runtimeSandboxId,
              decision: clearDecision,
              liveness,
              stillOurs,
            }),
          ).catch(() => false),
        );
        if (clearDecision === "skip_superseded") {
          this.log.info(
            { sessionId, runtimeSandboxId, event: "resume_clear_skipped_superseded" },
            "Skipping resume-failure clear; a newer attempt owns the runtime row",
          );
          return false;
        }
        if (clearDecision === "skip_live") {
          this.log.warn(
            { sessionId, runtimeSandboxId, event: "resume_clear_skipped_live" },
            "Resume connect reported missing/killed but probe shows the VM alive; not clearing",
          );
          return false;
        }
        await clearRuntimeAndSyncProjection({
          sql: this.sql,
          env: this.env,
          sessionId,
          expectedProvider: this.expectedProviderForRuntimeClear(sessionId, runtimeBackend),
        });
        return false;
      }
      throw err;
    }

    if (
      await abortIfStaleSpawnAttempt({
        sessionId,
        spawnAttemptId,
        runtimeSandboxId,
        logger: this.log,
        message: "Ignoring stale E2B runtime resume",
        isCurrentSpawnAttempt: (attemptId) => this.isCurrentSpawnAttempt(attemptId),
        onStale: () => cleanupResumedRuntimeIfCurrent("stale_spawn"),
      })
    ) {
      return true;
    }

    const healthy = await this.waitForE2BBridgeHealth(sessionId, runtimeSandboxId, startedAt);
    if (!healthy) {
      this.log.warn({ sessionId, runtimeSandboxId }, "Resumed E2B runtime did not reconnect bridge healthily");
      postResumeWallEvent("failed", "bridge_unhealthy");
      await cleanupStaleOrFailedResumedRuntime("spawn_failure");
      return false;
    }

    const nowMs = Date.now();
    const runtimeLiveLeaseExpiresAt = nowMs + getE2BRuntimeLiveLeaseMs(env);
    const runtimeState = {
      runtimeProvider: providerForRuntimeBackend(runtimeBackend),
      runtimeBackend,
      runtimeState: "running" as const,
      runtimeSandboxId,
      runtimeTemplateId: sandbox.runtimeTemplateId ?? runtimeConfig.defaultTemplate,
      runtimeStateExpiresAt: null,
      runtimeLiveLeaseExpiresAt,
      runtimePreviewUrl: null,
      runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
      runtimeLastResumedAt: nowMs,
      runtimeLastPausedAt: sandbox.runtimeLastPausedAt ?? null,
      runtimeLastProviderRefreshedAt: sandbox.runtimeLastProviderRefreshedAt ?? null,
      runtimeProviderTtlExpiresAt: sandbox.runtimeProviderTtlExpiresAt ?? null,
    };
    if (
      await abortIfStaleSpawnAttempt({
        sessionId,
        spawnAttemptId,
        runtimeSandboxId,
        logger: this.log,
        message: "Ignoring stale E2B runtime resume after bridge health wait",
        isCurrentSpawnAttempt: (attemptId) => this.isCurrentSpawnAttempt(attemptId),
        onStale: () => cleanupResumedRuntimeIfCurrent("stale_spawn"),
      })
    ) {
      return true;
    }
    postResumeWallEvent("resumed", null);
    // Gate the attach behind THIS attempt's `runtimeAttached` marker so a replay
    // converges (see the post-attach convergence guard at the top) instead of
    // re-attaching or falling through to a duplicate spawn. The local
    // sandbox_state write and this marker commit together in DO storage, so a
    // replay observes both or neither. Resume's attach does not broadcast, so the
    // step has no non-idempotent side effect beyond the D1 write.
    const attachResumedRuntime = () =>
      attachRuntime({
        sql: this.sql,
        env,
        sessionId,
        runtimeState,
        sandboxState: {
          ...runtimeState,
          intentionalPauseReason: null,
        },
      });
    if (spawnAttemptId) {
      await durableStep(
        this.state.storage,
        spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.runtimeAttached),
        async () => {
          await attachResumedRuntime();
          return { runtimeSandboxId };
        },
        this.log,
      );
    } else {
      await attachResumedRuntime();
    }
    if (sandbox.intentionalPauseReason === SandboxIdlePauseReason.IDLE_AUTO_PAUSE) {
      this.log.info(
        { event: "e2b_idle_resume", sessionId, runtimeSandboxId, reason: sandbox.intentionalPauseReason },
        "Resumed idle-paused E2B runtime",
      );
    } else {
      this.log.info({ sessionId, runtimeSandboxId }, "Resumed E2B runtime");
    }
    return true;
  }

  private async maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl(
    reason: "heartbeat" | "activity" | "prompt_event",
  ): Promise<void> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return;
    const env = this.env as Env;
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    if (
      !sandbox ||
      !isKnownRuntimeProvider(sandbox.runtimeProvider) ||
      sandbox.runtimeState !== "running" ||
      !sandbox.runtimeSandboxId
    ) {
      return;
    }

    const nowMs = Date.now();
    const liveLeaseMs = getE2BRuntimeLiveLeaseMs(env);
    const shouldRefreshLiveLease = reason !== "heartbeat";
    const runtimeLiveLeaseExpiresAt = shouldRefreshLiveLease
      ? nowMs + liveLeaseMs
      : (sandbox.runtimeLiveLeaseExpiresAt ?? null);
    const runtimeBackend = this.readPersistedRuntimeBackend(sessionId);
    const previousLiveLeaseExpiresAt = sandbox.runtimeLiveLeaseExpiresAt ?? 0;
    const shouldProjectLiveLease = shouldRefreshLiveLease && previousLiveLeaseExpiresAt - nowMs <= liveLeaseMs / 2;

    let runtimeLastProviderRefreshedAt = sandbox.runtimeLastProviderRefreshedAt ?? null;
    let runtimeProviderTtlExpiresAt = sandbox.runtimeProviderTtlExpiresAt ?? null;
    let providerRefreshChanged = false;
    const lastProviderRefreshAt = sandbox.runtimeLastProviderRefreshedAt ?? 0;

    try {
      const { intervalMs, ttlMs } = assertValidE2BProviderRefreshConfig(env);
      if (nowMs - lastProviderRefreshAt >= intervalMs) {
        const runtimeConfig = this.buildRuntimeClientConfig(runtimeBackend);
        const refreshed = await runtimeConfig.client.refreshSandbox(sandbox.runtimeSandboxId, ttlMs);
        runtimeLastProviderRefreshedAt = nowMs;
        runtimeProviderTtlExpiresAt = refreshed.refreshedUntil ?? nowMs + ttlMs;
        providerRefreshChanged = true;
        // Record each provider-TTL refresh + the gap since the prior one. If a
        // reaped sandbox shows a long gap here (refresh starved while the VM was
        // CPU-pegged), it pins the lease lapse; a steady cadence rules it out.
        this.log.info(
          {
            event: "e2b.provider_refresh",
            sessionId,
            runtimeSandboxId: sandbox.runtimeSandboxId,
            reason,
            ttlMs,
            sinceLastRefreshMs: lastProviderRefreshAt ? nowMs - lastProviderRefreshAt : null,
            providerTtlExpiresAt: runtimeProviderTtlExpiresAt,
          },
          "Refreshed E2B provider TTL",
        );
      }
    } catch (err) {
      if (err instanceof E2BSandboxRuntimeError && (err.code === "missing_sandbox" || err.code === "killed")) {
        this.log.warn(
          { sessionId, runtimeSandboxId: sandbox.runtimeSandboxId, reason, error: serializeError(err) },
          "E2B runtime disappeared during provider TTL refresh",
        );
        applyRuntimePatch({
          sql: this.sql,
          sessionId,
          patch: {
            // Normalize status alongside runtime_state, matching the two sibling
            // killed-setters (markRuntimeKilledAfterUnexpectedDisconnect, idle-pause
            // catch). This setter previously omitted `status`, leaving a dead
            // runtime in whatever lifecycle status it held — defense-in-depth so no
            // killed runtime is ever left non-`stopped`.
            status: "stopped",
            stopReason: "reaped",
            intentionalPauseReason: null,
            runtimeState: "killed",
            runtimeStateExpiresAt: nowMs,
            runtimeLiveLeaseExpiresAt: null,
            runtimeLastProviderRefreshedAt,
            runtimeProviderTtlExpiresAt,
          },
        });
        if (env.DB) {
          await syncRuntimeProjection(env, sessionId, {
            runtimeProvider: providerForRuntimeBackend(runtimeBackend),
            runtimeBackend,
            runtimeState: "killed",
            runtimeSandboxId: sandbox.runtimeSandboxId,
            runtimeTemplateId: sandbox.runtimeTemplateId ?? null,
            runtimeStateExpiresAt: nowMs,
            runtimeLiveLeaseExpiresAt: null,
            runtimePreviewUrl: null,
            runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
            runtimeLastResumedAt: sandbox.runtimeLastResumedAt ?? null,
            runtimeLastPausedAt: sandbox.runtimeLastPausedAt ?? null,
            runtimeLastProviderRefreshedAt,
            runtimeProviderTtlExpiresAt,
          });
        }
        return;
      }
      this.log.warn(
        { sessionId, runtimeSandboxId: sandbox.runtimeSandboxId, reason, error: serializeError(err) },
        "E2B provider TTL refresh failed; keeping runtime handle for retry",
      );
    }

    const runtimeState = {
      runtimeProvider: providerForRuntimeBackend(runtimeBackend),
      runtimeBackend,
      runtimeState: "running" as const,
      runtimeSandboxId: sandbox.runtimeSandboxId,
      runtimeTemplateId: sandbox.runtimeTemplateId ?? null,
      runtimeStateExpiresAt: null,
      runtimeLiveLeaseExpiresAt,
      runtimePreviewUrl: null,
      runtimeCreatedAt: sandbox.runtimeCreatedAt ?? null,
      runtimeLastResumedAt: sandbox.runtimeLastResumedAt ?? null,
      runtimeLastPausedAt: sandbox.runtimeLastPausedAt ?? null,
      runtimeLastProviderRefreshedAt,
      runtimeProviderTtlExpiresAt,
    };
    const refreshResult = await refreshLease({
      sql: this.sql,
      env,
      sessionId,
      expectedSandboxId: sandbox.runtimeSandboxId,
      expectedProvider: this.expectedProviderForRuntimeClear(sessionId, runtimeBackend),
      runtimeState,
      sandboxState: runtimeState,
      syncProjection: false,
      logger: this.log,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    if (!refreshResult.accepted) {
      // Sandbox identity changed underneath us (released or replaced). Skip
      // the projection update too; whichever path released the sandbox is
      // responsible for the projection state.
      return;
    }
    if (env.DB && (shouldProjectLiveLease || providerRefreshChanged)) {
      await syncRuntimeProjection(env, sessionId, runtimeState);
    }
  }

  private async spawnSandbox(
    sessionId: string,
    spawnAttemptId?: string,
    operation = "spawnSandbox.direct",
  ): Promise<void> {
    await this.sandboxRuntime.spawnSandbox(sessionId, spawnAttemptId, operation);
  }

  private async runSpawnSandbox(
    sessionId: string,
    spawnAttemptId?: string,
    operation = "spawnSandbox.direct",
  ): Promise<void> {
    const env = this.env as Env;
    const session = doDb.getSession(this.sql, sessionId);
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const runtimeBackend = await this.resolveRuntimeBackendAffinity(sessionId);
    const runtimeConfig = this.buildRuntimeClientConfig(runtimeBackend);

    if (await this.tryResumeE2BRuntimeForSpawn(sessionId, runtimeConfig, spawnAttemptId)) {
      return;
    }
    if (operation === "spawnSandbox.warm.page_open") {
      await this.putSandboxStatus(sessionId, "stopped", { stopReason: "reaped" });
      await this.rescheduleSessionAlarm();
      return;
    }

    // Bootstrap material (sandbox id + auth token) must be replay-stable across
    // DO restarts: the original sandbox/bridge is started with this auth token
    // baked into its env, so a resumed attempt MUST reuse the same token or the
    // running bridge can no longer authenticate. Persist it per attempt and
    // reuse it on replay; only mint fresh material for a genuinely new attempt.
    const bootstrapStepName = spawnAttemptId
      ? spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.bootstrap)
      : null;
    const {
      sandboxId,
      authToken,
      sandboxAuthTokenHash: hashHex,
    } = await loadOrCreateSpawnBootstrap(
      this.state.storage,
      bootstrapStepName,
      () => buildSpawnBootstrapMaterial(spawnAttemptId),
      this.log,
    );
    if (spawnAttemptId && !(await this.isCurrentSpawnAttempt(spawnAttemptId))) {
      this.log.info({ sessionId, spawnAttemptId }, "Skipping stale sandbox auth setup");
      return;
    }
    doDb.updateSandboxState(this.sql, sessionId, { sandboxAuthTokenHash: hashHex, sandboxId });

    // Callers set sandbox_status = "spawning" synchronously before calling this method.
    // Only write + broadcast here if the caller didn't (defensive fallback).
    // Read session fields from SQL for sandbox spawn.
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    if (spawnAttemptId && !(await this.isCurrentSpawnAttempt(spawnAttemptId))) {
      this.log.info({ sessionId, spawnAttemptId }, "Aborting stale spawn before E2B create");
      return;
    }
    const currentStatus = sandbox?.status;
    if (currentStatus !== "spawning") {
      await this.putSandboxStatus(sessionId, "spawning");
    }

    const controlPlaneUrl = env.CONTROL_PLANE_URL || "https://app.trycycloid.com";
    const publicAppUrl = resolvePublicAppBaseUrl(env);
    await assertLocalControlPlaneCallbackReachable({ env, sessionId, logger: this.log });

    // Read repo metadata stored during session initialization
    const repoOwner = ext?.repoOwner ?? undefined;
    const repoName = ext?.repoName ?? undefined;
    if (!repoOwner || !repoName) {
      throw new Error("No repo context configured for session -- cannot spawn sandbox");
    }
    const repoSandboxSpec = resolveRepoSandboxSpec(env, repoOwner, repoName);
    const sandboxLayerResolution = await resolveSandboxLayerForSession({
      db: env.DB,
      env,
      businessId: session?.businessId ?? null,
      repoOwner,
      repoName,
      runtimeBackend,
    });
    let sandboxLayerArtifact = sandboxLayerResolution.artifact;
    let sandboxLayerSelection: RuntimeProvenance["sandboxLayerSelection"] = {
      decision: sandboxLayerResolution.decision,
      tier: sandboxLayerResolution.selectedTier,
      resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
      misses: sandboxLayerResolution.misses,
    };
    this.log.info(
      {
        event: "sandbox_layer.session_resolved",
        sessionId,
        repoOwner: repoSandboxSpec.repoOwner,
        repoName: repoSandboxSpec.repoName,
        businessId: session?.businessId ?? null,
        decision: sandboxLayerResolution.decision,
        selectedTier: sandboxLayerResolution.selectedTier,
        resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
        misses: sandboxLayerResolution.misses,
        runtimeBackend,
        repoSandboxSpecSource: repoSandboxSpec.source,
        repoSandboxSpecKey: repoSandboxSpec.specKey,
        repoSandboxCpuCount: repoSandboxSpec.cpuCount,
        repoSandboxMemoryMB: repoSandboxSpec.memoryMB,
        repoSandboxDiskGB: repoSandboxSpec.diskGB ?? null,
        repoSandboxTimeoutMs: repoSandboxSpec.timeoutMs,
        runtimeTemplateId: repoSandboxSpec.runtimeTemplateId,
        sandboxLayerSourceId: sandboxLayerArtifact?.source_id ?? null,
        sandboxLayerBuildId: sandboxLayerArtifact?.build_id ?? null,
        sandboxLayerArtifactRef: sandboxLayerArtifact?.provider_artifact_ref ?? null,
      },
      "Resolved repo sandbox spec for session spawn",
    );

    // Resolve the spawn model scoped to the session's agent runtime backend so a
    // claude_code session keeps its Claude model (and provider) instead of
    // falling back to the codex default. provider is derived from the model.
    const spawnModelBackend = ext?.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND;
    await assertBusinessCanUseOpencode(env, {
      agentRuntimeBackend: spawnModelBackend,
      businessId: session?.businessId ?? null,
      sessionId,
      ownerUserId: session?.ownerUserId ?? null,
      entrypoint: "spawn",
    });
    const requestedModel = extractModelId(session?.model);
    const model =
      (requestedModel ? extractSessionStartModelIdForBackend(requestedModel, spawnModelBackend) : undefined) ??
      getDefaultSessionStartModelIdForBackend(spawnModelBackend);
    const modelDefinition = getModelDefinition(model);
    if (!modelDefinition) {
      throw new Error(`Model '${model}' is not in MODEL_REGISTRY -- cannot spawn sandbox`);
    }
    const provider = modelDefinition.provider;

    // Fail-closed template capability preflight: only opt-in backends (opencode) are gated, so a
    // session never spawns against an active image that lacks its agent CLI/SDK. Template
    // registration soft-fails (404/5xx) and the control plane can fall back to env templates, so
    // ordering ("build the template first") is not self-enforcing -- this is the enforceable guard.
    // FREESTYLE sessions are gated at the boot-strategy step instead: the per-repo snapshot map
    // needs repo visibility + branch (resolved after this point), and the gate must validate the
    // snapshot that actually boots — gating the default here would reject sessions whose mapped
    // per-repo snapshot advertises the backend.
    if (runtimeBackend !== FREESTYLE_RUNTIME_BACKEND) {
      await assertActiveTemplateSupportsAgentBackend(env, {
        agentRuntimeBackend: spawnModelBackend,
        resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
        runtimeBackend,
        layerArtifactBase: sandboxLayerArtifact
          ? {
              artifactId: sandboxLayerArtifact.id,
              providerArtifactRef: sandboxLayerArtifact.provider_artifact_ref,
              resourceProfileKey: sandboxLayerArtifact.resource_profile_key,
              baseTemplateRef: sandboxLayerArtifact.base_template_ref,
              baseVersion: sandboxLayerArtifact.base_version,
            }
          : undefined,
      });
    }

    const ownerUserId = session?.ownerUserId ?? "";

    // Generate scoped installation token for clone -- hard fail if unavailable.
    // Session creation already gates on app installation (routes/sessions.ts),
    // so this only fires when the installation exists but token generation fails.
    const installationId = ext?.installationId ?? undefined;
    if (!installationId) {
      throw new Error("No installation_id stored for session -- cannot generate clone token");
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
      throw new Error("GITHUB_APP_ID or GITHUB_PRIVATE_KEY not configured -- cannot generate clone token");
    }
    const { createScopedInstallationToken, sandboxInstallationTokenScope } = await import("../github/octokit.js");
    const cloneToken = await createScopedInstallationToken(
      env,
      installationId,
      sandboxInstallationTokenScope(repoName),
    );
    this.log.info({ sessionId, installationId, repoName }, "Generated repo-scoped installation token for clone");

    let repoPrivate = ext?.repoPrivate ?? undefined;
    if (repoPrivate === undefined) {
      try {
        repoPrivate = await isRepoPrivate(cloneToken, repoOwner, repoName);
        doDb.updateSessionFields(this.sql, sessionId, { repoPrivate });
        this.log.info({ sessionId, repoPrivate }, "Resolved repo visibility from GitHub");
      } catch (err) {
        this.log.warn(
          { sessionId, error: serializeError(err) },
          "Failed to resolve repo visibility -- defaulting to private guidance",
        );
      }
    }

    // Track available integrations for spawn-time integration diagnostics.
    let availableSet: Set<string> | null = null;
    let integrationRuntimeEnv: Record<string, string> = {};
    let repoRuntimeEnv: Record<string, string> = {};
    let repoLoginEnv: Record<string, string> = {};
    const observabilityEnv = resolveSandboxObservabilityEnv(env);
    let repoLoginEnvFingerprint: string[] = [];
    let personalSecretsEnv: Record<string, string> = {};
    let personalSecretsFingerprint: string[] = [];
    let gitAuthorName = "";
    let gitAuthorEmail = "";
    let ownerLogin: string | null = null;
    let businessIdEnv: string | null = null;

    if (session) {
      const ownerUserIdNumber = Number(session.ownerUserId);
      // Persist spawn integration lifecycle events. Shared between the success
      // path and the provider-credential-failure path so a fatal provider
      // failure still records its FAILED row before the spawn aborts.
      const persistSpawnLifecycleEvents = (lifecycleEvents: SpawnIntegrationLifecycleEvent[]) =>
        writeIntegrationLifecycleEvents(
          env.DB,
          lifecycleEvents.map((lifecycleEvent) => ({
            integrationId: lifecycleEvent.integrationId,
            stage: lifecycleEvent.stage,
            status: lifecycleEvent.status,
            businessId: session.businessId,
            userId: Number.isFinite(ownerUserIdNumber) ? ownerUserIdNumber : null,
            sessionId,
            reasonCode: lifecycleEvent.reasonCode ?? null,
            message: lifecycleEvent.message,
            details: lifecycleEvent.details ?? null,
          })),
        ).catch((error) => {
          for (const lifecycleEvent of lifecycleEvents) {
            this.log.warn(
              {
                sessionId,
                integrationId: lifecycleEvent.integrationId,
                stage: lifecycleEvent.stage,
                error: serializeError(error),
              },
              "Failed to record spawn integration lifecycle event",
            );
          }
        });

      const [gitIdentity, integrationRuntime, resolvedRepoLoginEnv, resolvedPersonalSecrets] = await Promise.all([
        env.DB ? getUserGitIdentity(env.DB, session.ownerUserId) : Promise.resolve(null),
        resolveSpawnIntegrationRuntime({
          db: env.DB,
          env,
          logger: this.log,
          businessId: session.businessId,
          ownerUserId: session.ownerUserId,
          selectedModel: model,
          sessionId,
        }).catch(async (error) => {
          // The provider credential could not be resolved (fatal). Record the
          // carried lifecycle events -- including the provider FAILED row --
          // before re-throwing so the failure is observable.
          if (error instanceof SpawnProviderCredentialError) {
            await persistSpawnLifecycleEvents(error.lifecycleEvents);
            // The session can't start without the provider key; only the owner can
            // add it. DM off the persistence (not the throw) so the failure is
            // recorded first. dedupKey=session: one notice per blocked session.
            // Guard the owner id like the persistence path above, and resolve
            // callbackContext best-effort so a SQL error here can't replace the
            // original SpawnProviderCredentialError (the throw below) or skip the DM.
            if (Number.isFinite(ownerUserIdNumber)) {
              let callbackContext: CallbackContext | undefined;
              try {
                callbackContext = doDb.getSessionExtended(this.sql, sessionId)?.callbackContext ?? undefined;
              } catch {
                // Best-effort: callbackContext only refines Slack-team resolution;
                // notifyUserBlocked still falls back to linked-team / single-workspace.
              }
              this.ctx.waitUntil(
                notifyUserBlocked(this.env, {
                  sessionId,
                  ownerUserId: ownerUserIdNumber,
                  callbackContext,
                  kind: BlockerKind.MissingProviderKey,
                  dedupKey: sessionId,
                  storage: this.state.storage,
                }),
              );
            }
          }
          throw error;
        }),
        env.DB
          ? resolveRepoLoginEnvForSandbox(env.DB, session.businessId, repoOwner, repoName, env.TOKEN_ENCRYPTION_KEY)
          : Promise.resolve(null),
        env.DB && Number.isFinite(ownerUserIdNumber)
          ? resolvePersonalSecretsForSandbox(env.DB, ownerUserIdNumber, env.TOKEN_ENCRYPTION_KEY)
          : Promise.resolve(null),
      ]);

      availableSet = new Set(integrationRuntime.availableIntegrations);
      integrationRuntimeEnv = integrationRuntime.envVars;
      repoLoginEnvFingerprint = getRepoLoginEnvCredentialFingerprint(resolvedRepoLoginEnv);
      personalSecretsFingerprint = getPersonalSecretsCredentialFingerprint(resolvedPersonalSecrets);
      if (resolvedPersonalSecrets) {
        personalSecretsEnv = resolvedPersonalSecrets.envVars;
        this.log.info(
          { sessionId, ownerUserId: ownerUserIdNumber, envBlobId: resolvedPersonalSecrets.id },
          "Personal secrets configured for sandbox",
        );
      }
      this.log.info(
        {
          sessionId,
          availableIntegrations: integrationRuntime.availableIntegrations,
          businessId: integrationRuntime.businessId ?? "none",
        },
        "Resolved integrations for spawn",
      );
      this.log.info(
        { sessionId, integrationDiagnostics: integrationRuntime.diagnostics },
        "Resolved spawn integration runtime",
      );
      await persistSpawnLifecycleEvents(integrationRuntime.lifecycleEvents);

      if (gitIdentity?.login) {
        ownerLogin = gitIdentity.login;
      }
      businessIdEnv = integrationRuntime.businessId ?? session.businessId ?? null;

      if (gitIdentity) {
        gitAuthorName = gitIdentity.name;
        gitAuthorEmail = gitIdentity.email;
      }
      if (resolvedRepoLoginEnv) {
        repoRuntimeEnv = resolvedRepoLoginEnv.envVars;
        repoLoginEnv = pickRepoLoginEnvVars(resolvedRepoLoginEnv.envVars);
        this.log.info(
          { sessionId, businessId: session.businessId, repoOwner, repoName, envBlobId: resolvedRepoLoginEnv.id },
          "Repo runtime env configured for sandbox",
        );
      }
      if (!integrationRuntime.envVars["LINEAR_ACCESS_TOKEN"] && availableSet.has("linear")) {
        this.log.warn(
          { sessionId, userId: session.ownerUserId },
          "No Linear token configured -- sandbox will not have Linear credentials",
        );
      }
    }

    // Pass resolved agent config and branch selection to sandbox
    const resolvedAgents = ext?.resolvedAgents as Record<string, unknown> | undefined;
    let baseBranch = ext?.baseBranch ?? undefined;
    if (!baseBranch) {
      try {
        baseBranch = await getDefaultBranch(cloneToken, repoOwner, repoName);
        doDb.updateSessionFields(this.sql, sessionId, { baseBranch });
        this.log.info({ sessionId, baseBranch }, "Resolved default branch from GitHub");
      } catch (err) {
        this.log.warn(
          { sessionId, error: serializeError(err) },
          "Failed to resolve default branch -- sandbox will use remote HEAD",
        );
      }
    }

    // The branch the sandbox will actually have checked out: lastBranch (respawn)
    // or startBranch (initial resume), else base. Drives preview/snapshot lookup.
    const currentWorkspaceBranch = ext?.lastBranch ?? ext?.startBranch ?? baseBranch ?? null;
    let enableDocker = false;
    let appRuntimePreviewContract: PreviewContract | null = null;
    let appRuntimeProfileSource: AppRuntimeProfileSource = "none";
    let appRuntimeProfileDiagnostics: AppRuntimeProfileDiagnostic[] = [];
    const runtimePreviewOverride = coerceRuntimePreviewOverride(
      await this.state.storage.get<RuntimePreviewOverride>(RUNTIME_PREVIEW_OVERRIDE_STORAGE_KEY),
    );
    if (runtimePreviewOverride) {
      appRuntimePreviewContract = runtimePreviewOverride.previewContract;
      enableDocker = true;
      appRuntimeProfileSource = runtimePreviewOverride.source;
      appRuntimeProfileDiagnostics = runtimePreviewOverride.diagnostics;
    } else if (currentWorkspaceBranch) {
      try {
        const appRuntimeProfile = await resolveAppRuntimeProfile(
          cloneToken,
          repoOwner,
          repoName,
          currentWorkspaceBranch,
        );
        appRuntimePreviewContract = appRuntimeProfile.previewContract;
        enableDocker = Boolean(appRuntimeProfile.previewContract);
        appRuntimeProfileDiagnostics = appRuntimeProfile.diagnostics;
        appRuntimeProfileSource = appRuntimeProfile.source;
      } catch (err) {
        this.log.warn(
          { sessionId, error: serializeError(err), branch: currentWorkspaceBranch },
          "Failed to resolve repo preview support",
        );
      }
    } else {
      this.log.warn({ sessionId }, "Skipping repo preview capability resolution because no branch is available");
    }
    const currentCredentialEnvKeys = buildSandboxCredentialEnvKeys(integrationRuntimeEnv, cloneToken);
    const sessionSnapshotImageId = null;
    const repoImagePrimaryBootEnabled = false;
    const repoImagePrimaryBootBlockedReason = null;
    const repoImageLookupResult = null;
    const repoImageMissReason = null;
    const repoImageId = null;
    const repoImageSha = null;
    const repoImageStartupFallback = null;
    const repoSnapshotLookup =
      runtimeBackend === E2B_CLOUD_RUNTIME_BACKEND
        ? lookupRepoSnapshotMap(env.E2B_REPO_SNAPSHOT_MAP_JSON, {
            varName: "E2B_REPO_SNAPSHOT_MAP_JSON",
            repoOwner,
            repoName,
            branch: currentWorkspaceBranch,
            repoPrivate,
          })
        : ({ snapshotId: null } satisfies RepoSnapshotLookupResult);
    if (repoSnapshotLookup.error) {
      this.log.warn({ sessionId, error: repoSnapshotLookup.error }, "Ignoring invalid E2B repo snapshot map");
    }
    // Freestyle per-repo prebaked snapshot (repo pre-cloned + deps installed). Travels on
    // the create request's dedicated freestyleSnapshotId field, NEVER the `template`
    // slot below — that carries E2B template ids the Freestyle client must ignore.
    // Fall back to the base snapshot on a missing/invalid entry (the kill switch).
    const freestyleSnapshotLookup =
      runtimeBackend === FREESTYLE_RUNTIME_BACKEND
        ? lookupRepoSnapshotMap(env.FREESTYLE_REPO_SNAPSHOT_MAP_JSON, {
            varName: "FREESTYLE_REPO_SNAPSHOT_MAP_JSON",
            repoOwner,
            repoName,
            branch: currentWorkspaceBranch,
            repoPrivate,
          })
        : ({ snapshotId: null } satisfies RepoSnapshotLookupResult);
    if (freestyleSnapshotLookup.error) {
      this.log.warn(
        { sessionId, error: freestyleSnapshotLookup.error },
        "Ignoring invalid Freestyle repo snapshot map",
      );
    }
    // THE Freestyle capability gate (the early preflight skips freestyle): validates
    // the snapshot that actually boots — the per-repo prebaked snapshot when mapped, else
    // the default. No-op for baseline backends; an unmapped id advertises nothing and
    // rejects opt-in backends like opencode rather than booting an unproven snapshot.
    // Still ahead of createSandbox, so the fail-closed contract holds.
    if (runtimeBackend === FREESTYLE_RUNTIME_BACKEND) {
      await assertActiveTemplateSupportsAgentBackend(env, {
        agentRuntimeBackend: spawnModelBackend,
        resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
        runtimeBackend,
        freestyleSnapshotId: freestyleSnapshotLookup.snapshotId ?? null,
      });
    }
    let e2bRuntimeTemplate =
      sandboxLayerResolution.runtimeTemplateId ?? repoSnapshotLookup.snapshotId ?? repoSandboxSpec.runtimeTemplateId;

    this.log.info(
      {
        sessionId,
        runtimeBackend,
        restoreEnabled: false,
        repoImagePrimaryBootEnabled,
        sessionSnapshotImageId,
        e2bRepoSnapshotKey: repoSnapshotLookup.key ?? null,
        e2bRepoSnapshotEnabled: Boolean(repoSnapshotLookup.snapshotId),
        freestyleRepoSnapshotKey: freestyleSnapshotLookup.key ?? null,
        freestyleRepoSnapshotEnabled: Boolean(freestyleSnapshotLookup.snapshotId),
        dockerEnabled: enableDocker,
        appRuntimeProfileSource,
        appRuntimeProfileDiagnostics: appRuntimeProfileDiagnostics.map((diagnostic) => diagnostic.code),
      },
      "Sandbox boot strategy snapshot",
    );

    // Track cold start (no repo image, no snapshot) so we can extend spawn timeout and warn the user.
    // startSpawnAttempt() clears spawn_cold_start before scheduling a 3-min alarm. Now that we know
    // the boot strategy, set the flag and reschedule so the alarm uses the correct timeout.
    const isColdStart =
      !repoImageId && !sessionSnapshotImageId && !repoSnapshotLookup.snapshotId && !freestyleSnapshotLookup.snapshotId;
    if (isColdStart) {
      await this.state.storage.put("spawn_cold_start", true);
      await this.scheduleSpawnConnectAlarm();
    }

    // On respawn, check out the feature branch so the agent sees its previous work.
    // On the INITIAL spawn (no lastBranch yet), a create-time startBranch makes the
    // sandbox check out that existing branch with its history instead of forking a
    // fresh branch off base. lastBranch (post-push) always wins on respawn.
    const lastBranch = ext?.lastBranch ?? undefined;
    const startBranch = ext?.startBranch ?? undefined;
    const checkoutBranch = lastBranch ?? startBranch ?? undefined;
    if (checkoutBranch) {
      this.log.info(
        { sessionId, checkoutBranch, source: lastBranch ? "last_branch" : "start_branch", baseBranch },
        "Using checkout branch for sandbox repo setup",
      );
    }

    const spawnActivePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const spawnCorrelation = spawnActivePromptId
      ? buildSerializedCorrelation({ sessionId, promptId: spawnActivePromptId, sandboxId })
      : undefined;
    if (spawnAttemptId && !(await this.isCurrentSpawnAttempt(spawnAttemptId))) {
      this.log.info({ sessionId, spawnAttemptId }, "Aborting stale spawn before E2B API call");
      return;
    }
    let businessEgressPolicy: Awaited<ReturnType<typeof getBusinessEgressPolicy>> = null;
    if (session?.businessId && env.DB) {
      try {
        businessEgressPolicy = await getBusinessEgressPolicy(env.DB, session.businessId);
      } catch (error) {
        this.log.warn(
          {
            event: "business_egress_policy_invalid",
            sessionId,
            businessId: session.businessId,
            error: stringifyError(error),
          },
          "Ignoring invalid stored business egress policy during sandbox spawn",
        );
      }
    }
    const sandboxEgressAllowlist = resolveSandboxEgressAllowlist(env, {
      businessId: session?.businessId,
      controlPlaneUrl,
      businessEgressPolicy,
    });
    const e2bNetworkPolicy = resolveE2BSandboxNetworkPolicy(env);
    if (sandboxEgressAllowlist.unrestrictedInternalBusiness) {
      this.log.info(
        {
          event: "sandbox_egress_unrestricted_internal_business",
          sessionId,
          businessId: session?.businessId ?? null,
        },
        "Sandbox egress enforcement disabled for internal Cycloid business",
      );
      if (hasE2BSandboxOutboundPolicy(e2bNetworkPolicy)) {
        this.log.warn(
          {
            event: "sandbox_egress_unrestricted_internal_business_conflict",
            sessionId,
            businessId: session?.businessId ?? null,
          },
          "Internal Cycloid sandbox egress is unrestricted by iptables, but E2B outbound policy still restricts traffic",
        );
      }
    }
    let runtimeCredentialEnvs: Record<string, string> = {};
    const declaredRuntimeCredentials: PreviewContractE2ECredentialDeclaration[] = [];
    const credentialFieldsByName = new Map<string, string>();
    const credentialEnvToName = new Map<string, string>();
    const addRuntimeCredentialDeclarations = (
      declarations: readonly PreviewContractE2ECredentialDeclaration[] | undefined,
    ) => {
      for (const declaration of declarations ?? []) {
        const existingNameEnv = credentialFieldsByName.get(declaration.name);
        const existingEnvName = credentialEnvToName.get(declaration.envVar);
        if (existingNameEnv === declaration.envVar && existingEnvName === declaration.name) {
          // Same credential declared in both e2e and auth: merge `source` so a
          // BYOK opt-in on either declaration survives, and reject conflicts.
          const existing = declaredRuntimeCredentials.find((entry) => entry.name === declaration.name);
          if (existing && declaration.source) {
            if (existing.source && existing.source !== declaration.source) {
              throw new Error(
                `Cannot start session: runtime credential '${declaration.name}' is declared with conflicting sources for ${repoOwner}/${repoName}.`,
              );
            }
            existing.source = declaration.source;
          }
          continue;
        }
        if (existingNameEnv && existingNameEnv !== declaration.envVar) {
          throw new Error(
            `Cannot start session: runtime credential '${declaration.name}' is declared with multiple env vars for ${repoOwner}/${repoName}.`,
          );
        }
        if (existingEnvName && existingEnvName !== declaration.name) {
          throw new Error(
            `Cannot start session: runtime credential env var '${declaration.envVar}' is declared for multiple credential names for ${repoOwner}/${repoName}.`,
          );
        }
        credentialFieldsByName.set(declaration.name, declaration.envVar);
        credentialEnvToName.set(declaration.envVar, declaration.name);
        declaredRuntimeCredentials.push(declaration);
      }
    };
    if (enableDocker && appRuntimePreviewContract) {
      addRuntimeCredentialDeclarations(appRuntimePreviewContract.e2e?.credentials);
      addRuntimeCredentialDeclarations(appRuntimePreviewContract.auth?.credentials);
    }
    if (enableDocker && declaredRuntimeCredentials.length > 0) {
      const declarations = declaredRuntimeCredentials;
      const neonDeclarations = declarations.filter((declaration) => declaration.source === "business_neon_branch");
      const standardDeclarations = declarations.filter((declaration) => declaration.source !== "business_neon_branch");
      // Fail closed when declared credentials cannot be resolved at all —
      // a missing businessId (non-business actor) or missing DB binding
      // (misconfigured worker) means we cannot inject the customer's env vars,
      // and silently starting with `e2eCredentialEnvs = {}` would let the app
      // boot without the values it needs. The PR's fail-closed contract
      // requires aborting before the agent can drive a misconfigured app.
      if (!session?.businessId || !env.DB) {
        const reason = !session?.businessId ? "missing_business_context" : "missing_db_binding";
        appRuntimeProfileDiagnostics = [
          ...appRuntimeProfileDiagnostics,
          {
            code: "missing_e2e_credential_value" as const,
            severity: "error" as const,
            message: `Runtime credentials cannot be resolved (${reason}) for ${repoOwner}/${repoName}`,
            field: appRuntimePreviewContract?.auth?.credentials?.length ? `auth.credentials` : `e2e.credentials`,
          },
        ];
        this.log.error(
          {
            event: "e2e_session_start",
            e2e_runtime: Boolean(appRuntimePreviewContract?.e2e),
            auth_runtime: Boolean(appRuntimePreviewContract?.auth),
            result: "no_runtime",
            sessionId,
            businessId: session?.businessId ?? null,
            repo: `${repoOwner}/${repoName}`,
            reason,
            declared: declarations.map((d) => d.name),
          },
          "Runtime session failed to start: cannot resolve declared credentials",
        );
        throw new Error(
          `Cannot start session: declared runtime credentials cannot be resolved (${reason}) for ${repoOwner}/${repoName}. ` +
            `Required to inject ${declarations.map((d) => d.envVar).join(", ")}.`,
        );
      }
      let standardRuntimeCredentialEnvs: Record<string, string> = {};
      if (standardDeclarations.length > 0) {
        const { resolved, missing } = await resolveDeclaredTestCredentials(env.DB, {
          businessId: session.businessId,
          repoOwner,
          repoName,
          declarations: standardDeclarations,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        // Empty/whitespace values fail closed: an empty credential passes a bare
        // hasOwnProperty check but boots the app with a blank secret, surfacing
        // ~an hour later as an opaque provider 401 instead of a spawn-time error.
        const hasUsableValue = (value: string | undefined): value is string =>
          typeof value === "string" && value.trim().length > 0;
        const emptyResolved = resolved.filter((r) => !hasUsableValue(r.value));
        const usableResolved = resolved.filter((r) => hasUsableValue(r.value));
        const resolvesFromRepoEnv = (m: { reason: string; envVar: string }): boolean =>
          m.reason === "not_found" && hasUsableValue(repoRuntimeEnv[m.envVar]);
        const fallbackResolved = missing
          .filter(resolvesFromRepoEnv)
          .map((m) => ({ envVar: m.envVar, value: repoRuntimeEnv[m.envVar] }));
        // Zero-setup BYOK fallback: a declaration with `source` resolves from the
        // business's own stored provider key when no explicit value exists.
        // Explicit values (test credential, then repo env var) always win, so a
        // customer can still split out a dedicated key for usage tracking.
        const byokProviderForDeclaration = (name: string): "openai" | "anthropic" | null => {
          const source = standardDeclarations.find((declaration) => declaration.name === name)?.source;
          if (source === "business_openai_key") return "openai";
          if (source === "business_anthropic_key") return "anthropic";
          return null;
        };
        const byokCandidates = missing.filter(
          (m) => m.reason === "not_found" && !resolvesFromRepoEnv(m) && byokProviderForDeclaration(m.name) !== null,
        );
        const byokResolved: Array<{ name: string; envVar: string; value: string }> = [];
        const byokUnavailable = new Set<string>();
        for (const candidate of byokCandidates) {
          const provider = byokProviderForDeclaration(candidate.name)!;
          const rawKey =
            session?.ownerUserId && env.DB
              ? await resolveAppRuntimeLlmKey(env.DB, {
                  ownerUserId: session.ownerUserId,
                  businessId: session.businessId ?? null,
                  provider,
                  encryptionKey: env.TOKEN_ENCRYPTION_KEY,
                  logger: this.log,
                })
              : null;
          if (typeof rawKey === "string" && rawKey.trim().length > 0) {
            byokResolved.push({ name: candidate.name, envVar: candidate.envVar, value: rawKey });
          } else {
            byokUnavailable.add(candidate.name);
          }
        }
        const byokResolvedNames = new Set(byokResolved.map((r) => r.name));
        const unresolvedMissing = [
          ...missing
            .filter((m) => !resolvesFromRepoEnv(m) && !byokResolvedNames.has(m.name))
            .map((m) => {
              if (m.reason === "not_found" && Object.prototype.hasOwnProperty.call(repoRuntimeEnv, m.envVar)) {
                return { ...m, reason: "empty_value" };
              }
              if (byokUnavailable.has(m.name)) {
                return { ...m, reason: "byok_unavailable" };
              }
              return m;
            }),
          ...emptyResolved.map((r) => ({ name: r.name, envVar: r.envVar, reason: "empty_value" })),
        ];
        if (unresolvedMissing.length > 0) {
          appRuntimeProfileDiagnostics = [
            ...appRuntimeProfileDiagnostics,
            ...unresolvedMissing.map((m) => {
              const authCredential = appRuntimePreviewContract?.auth?.credentials?.some(
                (credential) => credential.name === m.name,
              );
              return {
                code: authCredential
                  ? ("missing_auth_credential_value" as const)
                  : ("missing_e2e_credential_value" as const),
                severity: "error" as const,
                message:
                  m.reason === "empty_value"
                    ? `Runtime credential '${m.name}' (envVar ${m.envVar}) is set but EMPTY for ${repoOwner}/${repoName}; save a non-empty value`
                    : m.reason === "byok_unavailable"
                      ? `Runtime credential '${m.name}' (envVar ${m.envVar}) has no explicit value and the business has no runnable provider key for its declared source`
                      : `Runtime credential '${m.name}' (envVar ${m.envVar}) is not set for ${repoOwner}/${repoName}`,
                field: authCredential ? `auth.credentials.${m.name}` : `e2e.credentials.${m.name}`,
              };
            }),
          ];
          // Datadog metric: e2e session_start failed (decrypt_failed wins over
          // missing_creds since it's a more serious admin-side failure).
          const decryptFailed = unresolvedMissing.some((m) => m.reason === "decrypt_failed");
          const startResult = decryptFailed ? "decrypt_failed" : "missing_creds";
          this.log.error(
            {
              event: "e2e_session_start",
              e2e_runtime: Boolean(appRuntimePreviewContract?.e2e),
              auth_runtime: Boolean(appRuntimePreviewContract?.auth),
              result: startResult,
              sessionId,
              businessId: session.businessId,
              repo: `${repoOwner}/${repoName}`,
              missing: unresolvedMissing.map((m) => m.name),
            },
            "Runtime session failed to start: declared credentials unresolved",
          );
          throw new Error(
            `Cannot start session: missing runtime credentials [${unresolvedMissing.map((m) => m.name).join(", ")}] for ${repoOwner}/${repoName}. ` +
              `Set them via 'cycloid test-creds set ${repoOwner}/${repoName} <name>' or add the matching envVar to the repository environment variables in Business settings.`,
          );
        }
        standardRuntimeCredentialEnvs = Object.fromEntries(
          [...byokResolved, ...fallbackResolved, ...usableResolved].map((r) => [r.envVar, r.value]),
        );
      }

      let neonRuntimeCredentialEnvs: Record<string, string> = {};
      if (neonDeclarations.length > 0) {
        const hasUsableValue = (value: string | undefined): value is string =>
          typeof value === "string" && value.trim().length > 0;
        const { resolved, missing } = await resolveDeclaredTestCredentials(env.DB, {
          businessId: session.businessId,
          repoOwner,
          repoName,
          declarations: neonDeclarations,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        const explicitNeonResolved = [
          ...resolved.filter((entry) => hasUsableValue(entry.value)),
          ...missing
            .filter((entry) => entry.reason === "not_found" && hasUsableValue(repoRuntimeEnv[entry.envVar]))
            .map((entry) => ({ envVar: entry.envVar, value: repoRuntimeEnv[entry.envVar] })),
        ];
        neonRuntimeCredentialEnvs = Object.fromEntries(
          explicitNeonResolved.map((entry) => [entry.envVar, entry.value]),
        );
        const resolvedNeonEnvVars = new Set(Object.keys(neonRuntimeCredentialEnvs));
        const neonDeclarationsToProvision = neonDeclarations.filter(
          (declaration) => !resolvedNeonEnvVars.has(declaration.envVar),
        );

        if (neonDeclarationsToProvision.length > 0) {
          try {
            const provisionedNeonEnvs = await resolveSessionNeonBranchCredentialEnvs(env.DB, {
              storage: this.state.storage,
              businessId: session.businessId,
              sessionId,
              repoOwner,
              repoName,
              declarations: neonDeclarationsToProvision,
              encryptionKey: env.TOKEN_ENCRYPTION_KEY,
              logger: this.log,
            });
            neonRuntimeCredentialEnvs = {
              ...neonRuntimeCredentialEnvs,
              ...provisionedNeonEnvs,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to provision a Neon session branch.";
            appRuntimeProfileDiagnostics = [
              ...appRuntimeProfileDiagnostics,
              ...neonDeclarationsToProvision.map((declaration) => {
                const authCredential = appRuntimePreviewContract?.auth?.credentials?.some(
                  (credential) => credential.name === declaration.name,
                );
                return {
                  code: authCredential
                    ? ("missing_auth_credential_value" as const)
                    : ("missing_e2e_credential_value" as const),
                  severity: "error" as const,
                  message,
                  field: authCredential
                    ? `auth.credentials.${declaration.name}`
                    : `e2e.credentials.${declaration.name}`,
                };
              }),
            ];
            this.log.error(
              {
                event: "e2e_session_start",
                e2e_runtime: Boolean(appRuntimePreviewContract?.e2e),
                auth_runtime: Boolean(appRuntimePreviewContract?.auth),
                result: "missing_creds",
                sessionId,
                businessId: session.businessId,
                repo: `${repoOwner}/${repoName}`,
                missing: neonDeclarationsToProvision.map((declaration) => declaration.name),
              },
              "Runtime session failed to start: Neon branch provisioning failed",
            );
            throw error instanceof Error ? error : new Error(message);
          }
        }
      }

      runtimeCredentialEnvs = {
        ...standardRuntimeCredentialEnvs,
        ...neonRuntimeCredentialEnvs,
      };
    }

    if (enableDocker && appRuntimePreviewContract) {
      const composeEnv = {
        ...(appRuntimePreviewContract.composeEnv ?? {}),
        ...personalSecretsEnv,
        ...repoRuntimeEnv,
        ...runtimeCredentialEnvs,
      };
      appRuntimePreviewContract = {
        ...appRuntimePreviewContract,
        ...(Object.keys(composeEnv).length > 0 ? { composeEnv } : {}),
      };
    }

    // Escalate QA sessions on app-runtime repos to the bridge-owned boot and
    // persist the mode so prompt dispatch (prompt-queue reads
    // session.verificationRuntimeMode) agrees with the sandbox env below.
    const verificationRuntimeMode = resolveEffectiveVerificationRuntimeMode({
      agentRole: ext?.agentRole,
      agentProfile: ext?.agentProfile,
      declaredMode: ext?.verificationRuntimeMode,
      hasAppRuntimeContract: Boolean(enableDocker && appRuntimePreviewContract),
    });
    if (verificationRuntimeMode !== (ext?.verificationRuntimeMode ?? "none")) {
      doDb.updateSessionFields(this.sql, sessionId, { verificationRuntimeMode });
      this.log.info(
        {
          sessionId,
          repo: `${repoOwner}/${repoName}`,
          verificationRuntimeMode,
        },
        "QA session escalated to bridge-owned app runtime boot",
      );
    }

    // Datadog metric: `e2e_session_start{result:"ok"}` fires for ANY session that
    // declared `appRuntime.e2e` and got past the credential resolution path —
    // both credential-bearing sessions AND credential-less ones (testCommand-only
    // configs are common for publicly accessible apps; previously this branch
    // gated the emission on `credentials.length > 0`, so umami-style sessions
    // would silently skip it and the alpha dashboard would show zero successful
    // E2E starts). Error paths above already emitted result:"no_runtime" /
    // "missing_creds" / "decrypt_failed" and threw, so reaching this point
    // means the session is genuinely starting cleanly.
    if (enableDocker && appRuntimePreviewContract?.e2e) {
      this.log.info(
        {
          event: "e2e_session_start",
          e2e_runtime: true,
          result: "ok",
          sessionId,
          businessId: session?.businessId ?? null,
          repo: `${repoOwner}/${repoName}`,
          credentials_resolved: Object.keys(runtimeCredentialEnvs).length,
        },
        "E2E session started",
      );
    }
    if (enableDocker && appRuntimePreviewContract?.auth) {
      this.log.info(
        {
          event: "auth_runtime_start",
          auth_runtime: true,
          result: "ok",
          sessionId,
          businessId: session?.businessId ?? null,
          repo: `${repoOwner}/${repoName}`,
          credentials_resolved: Object.keys(runtimeCredentialEnvs).length,
          credential_env_keys: Object.keys(runtimeCredentialEnvs).sort(),
        },
        "Runtime auth session started",
      );
    }
    let managedMcpRuntime: ManagedMcpRuntimeConfig = { servers: [], envVars: {}, warnings: [] };
    if (session?.businessId && env.DB) {
      try {
        managedMcpRuntime = buildManagedMcpRuntimeConfig(
          await listEnabledMcpServersForSession(env.DB, {
            businessId: session.businessId,
            repoOwner,
            repoName,
          }),
          {
            ...repoRuntimeEnv,
            ...runtimeCredentialEnvs,
            ...integrationRuntimeEnv,
          },
        );
      } catch (error) {
        this.log.warn(
          {
            sessionId,
            businessId: session.businessId,
            repoOwner,
            repoName,
            error: serializeError(error),
          },
          "Failed to resolve product-managed MCP servers for sandbox",
        );
      }
    }
    for (const warning of managedMcpRuntime.warnings) {
      this.log.warn({ sessionId, warning }, "Product-managed MCP server skipped for session");
    }
    if (managedMcpRuntime.servers.length > 0) {
      this.log.info(
        {
          sessionId,
          businessId: session?.businessId ?? null,
          managedMcpServers: managedMcpRuntime.servers.map((server) => server.name),
        },
        "Resolved product-managed MCP servers for sandbox",
      );
    }
    // A sandbox has not reported its bridge protocol version at spawn time.
    // Start reviewer sandboxes with the legacy safe role; v2+ prompt dispatch
    // upgrades the runtime to `review`, while old bridges keep the existing
    // verification-role behavior for the whole skew window.
    const sandboxStartupAgentRole = isCodeReviewerAgentRole(ext?.agentRole)
      ? QA_TESTER_AGENT_ROLE
      : (ext?.agentRole ?? "implementation");
    const sessionConfig = {
      sessionId,
      repoOwner,
      repoName,
      sessionKind: "repo",
      provider,
      model,
      baseBranch: baseBranch ?? null,
      checkoutBranch: checkoutBranch ?? null,
      agentSessionId: ext?.agentSessionId ?? null,
      agentSessionAgent: ext?.agentSessionAgent ?? null,
      agentRuntimeBackend: ext?.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND,
      agentRole: sandboxStartupAgentRole,
      agentProfile: ext?.agentProfile ?? "build",
      harnessKind: ext?.harnessKind ?? "codex-session",
      runtimeStartupProfile: ext?.runtimeStartupProfile ?? "implementation_default",
      verificationRuntimeMode,
      targetPrUrl: ext?.targetPrUrl ?? null,
      adoptedExternalPr: ext?.adoptedExternalPr === true,
      managedMcpServers: managedMcpRuntime.servers,
      useOpenAIFlexServiceTier:
        (await this.state.storage.get<boolean>(USE_OPENAI_FLEX_SERVICE_TIER_STORAGE_KEY)) === true,
    };
    // Session-scoped telemetry broker config. The sandbox points the Braintrust
    // SDK at these control-plane URLs; the control plane injects the platform
    // BRAINTRUST_API_KEY server-side. No platform secret is shipped to the sandbox.
    const telemetryBrokerBase = `${controlPlaneUrl}/api/sessions/${sessionId}/sandbox/telemetry`;
    const telemetryBrokerEnv = {
      BRAINTRUST_API_URL: `${telemetryBrokerBase}/braintrust`,
      BRAINTRUST_APP_URL: `${telemetryBrokerBase}/braintrust`,
      // Non-secret capability bit: the bridge cannot see the worker-held DD
      // key, but must report honest broker readiness in runtime_info.
      ARCANIST_DD_LOGS_BROKER_READY: buildSandboxObservabilityReadiness(env).ddLogs ? "1" : "0",
    };
    const e2bEnvs: Record<string, string> = {
      PYTHONUNBUFFERED: "1",
      SESSION_ID: sessionId,
      SANDBOX_ID: sandboxId,
      REPO_OWNER: repoOwner,
      REPO_NAME: repoName,
      ARCANIST_SESSION_KIND: "repo",
      CONTROL_PLANE_URL: controlPlaneUrl,
      FRONTEND_URL: publicAppUrl,
      SANDBOX_AUTH_TOKEN: authToken,
      PROVIDER: provider,
      MODEL: model,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
      BRANCH: baseBranch ?? "",
      CHECKOUT_BRANCH: checkoutBranch ?? "",
      // ARC-1515: an adopted external PR must check out its own head branch or fail
      // closed — never fall back to the base branch (which would run the session on
      // base and push a stray branch onto the human's PR). start-bridge.sh honors the
      // strict flag only when a checkout branch is present.
      ...(ext?.adoptedExternalPr && checkoutBranch ? { ARCANIST_STRICT_HEAD_CHECKOUT: "1" } : {}),
      AGENT_CONFIG: JSON.stringify(resolvedAgents ?? {}),
      // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
      ARCANIST_AGENT_ROLE: sandboxStartupAgentRole,
      ARCANIST_AGENT_PROFILE: ext?.agentProfile ?? "build",
      CYCLOID_RUNTIME_STARTUP_PROFILE: ext?.runtimeStartupProfile ?? "implementation_default",
      CYCLOID_VERIFICATION_RUNTIME_MODE: verificationRuntimeMode,
      CYCLOID_TARGET_PR_URL: ext?.targetPrUrl ?? "",
      ARCANIST_CORRELATION: spawnCorrelation ? JSON.stringify(spawnCorrelation) : "",
      [OWNER_USER_ID_ENV]: ownerUserId,
      CODEX_HOME: `/tmp/codex-home-${sessionId}`,
      CODEX_NO_LOGIN: "1",
      REPO_PATH: "/workspace/repo",
      // Honest vendor tag derived from the resolved backend (e2b_cloud->"e2b",
      // freestyle->"freestyle"); the bridge's codex path probe keys on this value.
      ARCANIST_RUNTIME_PROVIDER: providerForRuntimeBackend(runtimeBackend),
      // Sandbox-provider axis (e2b_cloud | freestyle) — independent of the coding-agent axis below.
      ARCANIST_RUNTIME_BACKEND: runtimeBackend,
      // Coding-agent axis (codex | claude_code) — resolved from the persisted session
      // row, orthogonal to the sandbox provider above.
      ARCANIST_AGENT_RUNTIME_BACKEND: ext?.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND,
      AGENT_RUNTIME_BACKEND: ext?.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND,
      ARCANIST_RUNTIME_ENVIRONMENT: normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Production),
      ARCANIST_CUA_ENABLED: isCycloidMember({ businessId: businessIdEnv }) ? "1" : "0",
      E2B_SANDBOX_TEMPLATE: e2bRuntimeTemplate,
      GITHUB_CLONE_TOKEN: cloneToken,
      // Repo-scoped installation token (see createScopedInstallationToken). The user
      // OAuth token is deliberately not shipped to the sandbox; PRs are opened
      // server-side as the user (github/pr.ts).
      GH_TOKEN: cloneToken,
      GIT_AUTHOR_NAME: gitAuthorName,
      GIT_AUTHOR_EMAIL: gitAuthorEmail,
      ...(enableDocker && appRuntimePreviewContract
        ? {
            ARCANIST_PREVIEW_CONTRACT_JSON: JSON.stringify(appRuntimePreviewContract),
          }
        : {}),
      ...(ownerLogin ? { OWNER_LOGIN: ownerLogin } : {}),
      ...(ext?.callbackContext?.source === "slack"
        ? { [SLACK_SESSION_TEAM_ID_ENV]: ext.callbackContext.slackTeamId }
        : {}),
      ...integrationRuntimeEnv,
      ...repoLoginEnv,
      ...observabilityEnv,
      ...telemetryBrokerEnv,
      ...sandboxEgressAllowlist.envs,
      ...runtimeCredentialEnvs,
      ...(businessIdEnv && !isCompanyMemoryDisabledForBusiness(env, businessIdEnv)
        ? { ARCANIST_MEMORY_TOOLS_ENABLED: "1" }
        : {}),
      ...(businessIdEnv ? { BUSINESS_ID: businessIdEnv } : {}),
      ...managedMcpRuntime.envVars,
      // Keep the disk-backed swapfile small by default; repo env is merged later
      // but skips existing keys, so sessions cannot raise this platform cap.
      ARCANIST_SWAP_MAX_GB: "2",
    };
    const repoRuntimeSessionEnvNames: string[] = [];
    // Apply repo secrets first so repo wins on key collision (personal fills only
    // gaps not already present). Both skip platform-owned keys already assembled
    // into `e2bEnvs` above.
    for (const [sourceName, source] of [
      ["repo", repoRuntimeEnv],
      ["personal", personalSecretsEnv],
    ] as const) {
      for (const [key, value] of Object.entries(source)) {
        if (!isAgentVisibleRepoRuntimeEnvName(key)) continue;
        if (Object.prototype.hasOwnProperty.call(e2bEnvs, key)) continue;
        e2bEnvs[key] = value;
        if (sourceName === "repo") repoRuntimeSessionEnvNames.push(key);
      }
    }
    if (repoRuntimeSessionEnvNames.length > 0) {
      e2bEnvs[ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV] = JSON.stringify(repoRuntimeSessionEnvNames.sort());
    }
    if (e2bEnvs.OPENAI_API_KEY && !e2bEnvs.CODEX_API_KEY) {
      e2bEnvs.CODEX_API_KEY = e2bEnvs.OPENAI_API_KEY;
    }
    if (
      "ARCANIST_OPENAI_API_KEY" in e2bEnvs ||
      "ARCANIST_BASETEN_API_KEY" in e2bEnvs ||
      "OPENAI_API_KEY_INTERNAL_REVIEW" in e2bEnvs
    ) {
      throw new Error("Platform-scoped auth env leaked into sandbox env assembly");
    }
    // Platform telemetry now flows via the control-plane broker; these secrets
    // must never be assembled into the sandbox env. (DD_API_KEY/DD_SITE are NOT
    // guarded here — the customer Datadog integration legitimately injects those
    // same names.)
    if ("BRAINTRUST_API_KEY" in e2bEnvs || "SENTRY_DSN" in e2bEnvs) {
      throw new Error("Platform telemetry secret leaked into sandbox env assembly");
    }
    // Claude Code backend: require an Anthropic credential and fail closed before
    // spawn if none resolves. Codex sessions are unaffected. The credential is
    // resolved upstream by resolveSpawnIntegrationRuntime — business/user BYOK in
    // prod, or the platform key (ARCANIST_ANTHROPIC_API_KEY) only via the local-dev
    // path — or supplied as a declared preview/test credential. The platform key
    // is NOT a prod fallback: claude_code requires a BYOK Anthropic key. So this
    // only reads from the already-assembled sandbox env (`e2bEnvs`); it never
    // injects the platform key directly, which also avoids clobbering a
    // customer-provided key.
    const spawnAgentRuntimeBackend = ext?.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND;
    if (spawnAgentRuntimeBackend === "claude_code" && !e2bEnvs.ANTHROPIC_API_KEY) {
      throw new Error("sandbox_auth_failure: no Anthropic credential for claude_code backend");
    }
    if ("ARCANIST_ANTHROPIC_API_KEY" in e2bEnvs) {
      throw new Error("Platform-scoped auth env leaked into sandbox env assembly");
    }
    const providerEnvForBackend =
      spawnAgentRuntimeBackend === "claude_code"
        ? e2bEnvs.ANTHROPIC_API_KEY
        : spawnAgentRuntimeBackend === "opencode"
          ? e2bEnvs.BASETEN_API_KEY
          : integrationRuntimeEnv.OPENAI_API_KEY;
    this.log.info(
      {
        event: "sandbox_auth_source",
        sessionId,
        businessId: session?.businessId ?? null,
        agentRuntimeBackend: spawnAgentRuntimeBackend,
        providerStatus: session ? (providerEnvForBackend ? "customer_scoped" : "missing") : "unknown",
        providerEnvInjected: Boolean(providerEnvForBackend),
        anthropicEnvInjected: Boolean(e2bEnvs.ANTHROPIC_API_KEY),
        basetenEnvInjected: Boolean(e2bEnvs.BASETEN_API_KEY),
      },
      "Resolved sandbox auth source",
    );
    let runtimeRecordOptionsBase: RunningRuntimeRecordOptions = {
      sessionId,
      runtimeBackend,
      runtimeSandboxId: "",
      runtimeTemplateId: e2bRuntimeTemplate,
      sandboxId,
      sandboxImageVersion: env.SANDBOX_IMAGE_VERSION ?? null,
      sandboxAuthTokenHash: hashHex,
      credentialEnvKeys: currentCredentialEnvKeys,
      credentialFingerprints: [...repoLoginEnvFingerprint, ...personalSecretsFingerprint],
      dockerEnabled: enableDocker,
      appRuntimeProfileSource,
      appRuntimeProfileDiagnostics,
      repoImagePrimaryBootEnabled,
      repoImagePrimaryBootBlockedReason,
      repoImageLookupResult,
      repoImageMissReason,
      repoImageId,
      repoImageSha,
      repoImageStartupFallback,
      sessionSnapshotImageId,
      bootMode: "fresh_clone",
      sandboxLayerSelection,
      sandboxLayerArtifact,
    };
    if (
      await abortIfStaleSpawnAttempt({
        sessionId,
        spawnAttemptId,
        logger: this.log,
        message: "Aborting stale spawn before sandbox create",
        isCurrentSpawnAttempt: (attemptId) => this.isCurrentSpawnAttempt(attemptId),
      })
    ) {
      return;
    }

    const buildCreateSandboxRequest = (): E2BCreateSandboxRequest => ({
      sessionId,
      sandboxId,
      template: e2bRuntimeTemplate,
      ...(freestyleSnapshotLookup.snapshotId ? { freestyleSnapshotId: freestyleSnapshotLookup.snapshotId } : {}),
      timeoutMs: repoSandboxSpec.timeoutMs,
      envs: e2bEnvs,
      ...e2bNetworkPolicy,
      // Per-repo VM sizing. E2B bakes sizing into `template` and ignores this; the
      // Freestyle client maps it onto vms.create (memSizeGb/vcpuCount/rootfsSizeGb).
      // Send it ONLY when the repo's entry explicitly configures sizing: a non-sizing
      // entry (e.g. timeout-only) resolves source:"repo" with DEFAULTED 2/4096, which
      // would SHRINK a Freestyle VM below the base snapshot's 8 GiB / 4 vCPU baseline
      // that unspecced repos keep.
      ...(repoSandboxSpec.sizingExplicit
        ? {
            resources: {
              cpuCount: repoSandboxSpec.cpuCount,
              memoryMB: repoSandboxSpec.memoryMB,
              ...(repoSandboxSpec.diskGB !== undefined ? { diskGB: repoSandboxSpec.diskGB } : {}),
            },
          }
        : {}),
      metadata: {
        session_id: sessionId,
        repo_owner: repoOwner,
        repo_name: repoName,
        session_kind: "repo",
        runtime_backend: runtimeBackend,
        e2b_repo_snapshot_key: repoSnapshotLookup.key ?? "",
        freestyle_repo_snapshot_key: freestyleSnapshotLookup.key ?? "",
        repo_sandbox_spec_source: repoSandboxSpec.source,
        repo_sandbox_spec_key: repoSandboxSpec.specKey,
        repo_sandbox_cpu_count: String(repoSandboxSpec.cpuCount),
        repo_sandbox_memory_mb: String(repoSandboxSpec.memoryMB),
        repo_sandbox_disk_gb: String(repoSandboxSpec.diskGB ?? ""),
        repo_sandbox_timeout_ms: String(repoSandboxSpec.timeoutMs),
        repo_sandbox_template: e2bRuntimeTemplate,
        sandbox_layer_selection_decision: sandboxLayerSelection?.decision ?? "",
        sandbox_layer_selection_tier: sandboxLayerSelection?.tier ?? "",
        sandbox_layer_resource_profile_key: sandboxLayerSelection?.resourceProfileKey ?? "",
        sandbox_layer_miss_codes:
          sandboxLayerSelection?.misses?.map((miss) => `${miss.tier}:${miss.code}`).join(",") ?? "",
        sandbox_layer_artifact_id: sandboxLayerArtifact?.id ?? "",
        sandbox_layer_source_id: sandboxLayerArtifact?.source_id ?? "",
        sandbox_layer_build_id: sandboxLayerArtifact?.build_id ?? "",
        sandbox_layer_source_hash: sandboxLayerArtifact?.source_content_hash ?? "",
      },
    });

    let result: E2BCreateSandboxResponse | null = null;
    try {
      result = await this.createRuntimeSandboxForSpawn(
        runtimeConfig.client,
        buildCreateSandboxRequest(),
        operation,
        spawnAttemptId,
      );
    } catch (createErr) {
      let err: unknown = createErr;
      if (shouldFallbackMissingSandboxLayerArtifact(err, runtimeBackend, sandboxLayerResolution)) {
        const missingArtifact = sandboxLayerArtifact;
        if (missingArtifact) {
          const fallbackRuntimeTemplateId = repoSnapshotLookup.snapshotId ?? repoSandboxSpec.runtimeTemplateId;
          const blocked = await blockActiveSandboxLayerArtifactIfCurrent(env.DB, {
            sourceId: missingArtifact.source_id,
            resourceProfileKey: missingArtifact.resource_profile_key,
            artifactId: missingArtifact.id,
            reason: "sandbox_layer_provider_artifact_missing",
            nowMs: Date.now(),
          });
          e2bRuntimeTemplate = fallbackRuntimeTemplateId;
          e2bEnvs.E2B_SANDBOX_TEMPLATE = fallbackRuntimeTemplateId;
          sandboxLayerArtifact = null;
          sandboxLayerSelection = {
            decision: "provider_artifact_missing_fallback",
            tier: sandboxLayerResolution.selectedTier,
            resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
            misses: sandboxLayerResolution.misses,
            fallbackRuntimeTemplateId,
            fallbackReason: "sandbox_layer_provider_artifact_missing",
          };
          runtimeRecordOptionsBase = {
            ...runtimeRecordOptionsBase,
            runtimeTemplateId: fallbackRuntimeTemplateId,
            sandboxLayerSelection,
            sandboxLayerArtifact: null,
          };
          await assertActiveTemplateSupportsAgentBackend(env, {
            agentRuntimeBackend: spawnModelBackend,
            resourceProfileKey: sandboxLayerResolution.resourceProfileKey,
            runtimeBackend,
          });
          this.log.info(
            {
              event: "sandbox_layer.session_fallback",
              sessionId,
              businessId: session?.businessId ?? null,
              repoOwner,
              repoName,
              runtimeBackend,
              sourceId: missingArtifact.source_id,
              buildId: missingArtifact.build_id,
              artifactId: missingArtifact.id,
              selectedTemplateId: missingArtifact.provider_artifact_ref,
              fallbackRuntimeTemplateId,
              fallbackReason: "sandbox_layer_provider_artifact_missing",
              artifactBlocked: blocked,
            },
            "Sandbox layer provider artifact missing; falling back to non-layer template",
          );
          if (blocked) {
            this.log.info(
              {
                event: "sandbox_layer.artifact_blocked",
                sessionId,
                businessId: session?.businessId ?? null,
                repoOwner,
                repoName,
                runtimeBackend,
                sourceId: missingArtifact.source_id,
                buildId: missingArtifact.build_id,
                artifactId: missingArtifact.id,
                resourceProfileKey: missingArtifact.resource_profile_key,
                fallbackReason: "sandbox_layer_provider_artifact_missing",
              },
              "Blocked missing sandbox layer artifact",
            );
          }
          try {
            result = await this.createRuntimeSandboxForSpawn(
              runtimeConfig.client,
              buildCreateSandboxRequest(),
              operation,
              spawnAttemptId,
            );
          } catch (fallbackErr) {
            err = fallbackErr;
          }
        }
      }
      if (!result) {
        // `createRuntimeSandboxForSpawn` aborts (not fails) when the attempt was
        // superseded ("stale") or a runtime is already attached ("ready"). Re-throw
        // the ORIGINAL error so `startSpawnAttempt`'s `instanceof
        // SpawnRetryAbortedError` check treats those aborts as benign.
        throw err;
      }
    }
    if (result.status !== "running" || !result.runtimeSandboxId || !result.runtimeTemplateId) {
      if (result.runtimeSandboxId) {
        await this.terminateRuntime({
          sessionId,
          runtimeSandboxId: result.runtimeSandboxId,
          logger: this.log,
          message: "Failed to terminate unusable E2B sandbox after create",
          reason: "cold_create_unusable",
          terminate: (reason) => runtimeConfig.client.terminateSandbox(result.runtimeSandboxId, reason),
        });
      }
      await clearRuntimeAndSyncProjection({
        sql: this.sql,
        env: this.env,
        sessionId,
        expectedProvider: this.expectedProviderForRuntimeClear(sessionId, runtimeBackend),
      });
      throw new Error(`E2B sandbox create returned unusable state: ${result.status || "unknown"}`);
    }
    const startBridgeCommand = () =>
      runtimeConfig.client.startCommand({
        runtimeSandboxId: result.runtimeSandboxId,
        command: "bash /app/start-bridge.sh",
        cwd: "/workspace",
        envs: e2bEnvs,
      });
    // Presence (never values) of the env vars start-bridge.sh needs to boot AND
    // ship logs. If the bridge never connects, this pins whether the VM was even
    // launched with what it needs: a missing DD_API_KEY means the bridge can't
    // ship logs (looks dark even if it ran); a missing model/auth key makes
    // `codex login` exit before `node bundle.js` ever starts.
    const bridgeColdStart = (await this.state.storage.get<boolean>("spawn_cold_start")) === true;
    this.log.info(
      {
        event: "bridge_start_command_issued",
        sessionId,
        runtimeSandboxId: result.runtimeSandboxId,
        coldStart: bridgeColdStart,
        hasControlPlaneUrl: Boolean(e2bEnvs.CONTROL_PLANE_URL),
        hasAuthToken: Boolean(e2bEnvs.SANDBOX_AUTH_TOKEN),
        // Platform DD logs now flow via the control-plane telemetry broker, which
        // is reachable whenever the broker URL + sandbox auth token exist.
        ddLogsBrokerReady: buildSandboxObservabilityReadiness(env).ddLogs,
        hasModelAuthKey: Boolean(e2bEnvs.CODEX_API_KEY || e2bEnvs.OPENAI_API_KEY || e2bEnvs.ANTHROPIC_API_KEY),
        hasCloneToken: Boolean(e2bEnvs.GITHUB_CLONE_TOKEN),
      },
      "Issuing sandbox bridge start command",
    );
    try {
      await this.startBridgeForSpawn(sessionId, spawnAttemptId, result.runtimeSandboxId, startBridgeCommand);
    } catch (err) {
      await this.terminateRuntime({
        sessionId,
        runtimeSandboxId: result.runtimeSandboxId,
        logger: this.log,
        message: "Failed to terminate E2B sandbox after bridge start failure",
        reason: "bridge_start_failed",
        terminate: (reason) => runtimeConfig.client.terminateSandbox(result.runtimeSandboxId, reason),
      });
      await clearRuntimeAndSyncProjection({
        sql: this.sql,
        env: this.env,
        sessionId,
        expectedProvider: this.expectedProviderForRuntimeClear(sessionId, runtimeBackend),
      });
      throw err;
    }

    if (
      await abortIfStaleSpawnAttempt({
        sessionId,
        spawnAttemptId,
        runtimeSandboxId: result.runtimeSandboxId,
        logger: this.log,
        message: "Ignoring stale spawn result after E2B API call",
        isCurrentSpawnAttempt: (attemptId) => this.isCurrentSpawnAttempt(attemptId),
        onStale: async () => {
          await this.terminateRuntime({
            sessionId,
            runtimeSandboxId: result.runtimeSandboxId,
            logger: this.log,
            message: "Failed to terminate stale E2B sandbox after bridge start",
            reason: "stale_spawn_after_bridge",
            terminate: (reason) => runtimeConfig.client.terminateSandbox(result.runtimeSandboxId, reason),
          });
        },
      })
    ) {
      return;
    }

    const recordRuntime = () =>
      this.recordRunningE2BRuntimeForSpawn({
        ...runtimeRecordOptionsBase,
        runtimeSandboxId: result.runtimeSandboxId,
        runtimeTemplateId: result.runtimeTemplateId,
        bootMode: "fresh_clone",
      });
    if (spawnAttemptId) {
      // Gate the whole attach (D1 row + provenance + readiness + broadcasts)
      // behind one marker so a replay neither re-attaches nor re-broadcasts.
      // The marker is set only after the function fully completes, so a crash
      // between the D1 attach and the DO-storage writes leaves no marker and
      // the replay re-runs the full attach to repair provenance/readiness.
      await durableStep(
        this.state.storage,
        spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.runtimeAttached),
        async () => {
          await recordRuntime();
          return { runtimeSandboxId: result.runtimeSandboxId };
        },
        this.log,
      );
    } else {
      await recordRuntime();
    }

    // Record the E2B-create cost + cold attach point AFTER the runtime is durably
    // attached (its auth hash is now in D1). attachedAtMs is captured here, not
    // before recordRuntime, so cold-path bridge_launch_ms (readyAt - attachedAtMs)
    // excludes the D1-write latency the bridge waits on — matching the warm path,
    // which sets attachedAtMs after its own claim/attach writes. Without this the
    // two paths would measure different intervals and skew warm-vs-cold in Datadog.
    await this.recordSpawnInstrumentation(sessionId, {
      spawnPath: "cold",
      e2bCreateMs: result.createDurationMs ?? null,
      runtimeBackend,
      attachedAtMs: Date.now(),
    });
    // Terminal success: the runtime is durably attached (its hash now lives in
    // D1 sandbox_state for bridge auth), so the per-attempt workflow steps and
    // bootstrap are no longer needed for replay. Clear them here — deterministic
    // and post-attach — rather than on bare bridge connect, which could race
    // ahead of this attach and wipe the bootstrap mid-spawn.
    if (spawnAttemptId) {
      await this.clearSpawnAttemptWorkflow(sessionId, spawnAttemptId);
    }
  }

  // Helpers
  // ---------------------------------------------------------------------------

  private async uploadPlanMarkdownArtifact(
    sessionId: string,
    promptId: string,
    markdown: string,
  ): Promise<string | null> {
    const body = new TextEncoder().encode(markdown);
    if (body.length === 0) return null;

    const artifactId = crypto.randomUUID();
    const artifactType = "log";
    const contentType = "text/markdown";
    const filename = `plan-${promptId}.md`.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const env = this.env as Env;

    try {
      const { writeArtifact } = await import("../services/archive.js");
      const s3Url = await writeArtifact(this.env, sessionId, artifactId, filename, body, contentType, this.log);
      if (!s3Url) {
        if (env.WORKER_ENV === ENVIRONMENT.Local) {
          await writeDoStorageArtifact(this.state.storage, artifactId, filename, body, contentType);
        } else {
          this.log.warn(
            { event: "plan_mode_artifact_upload_failed", sessionId, promptId },
            "Plan markdown artifact upload failed",
          );
          return null;
        }
      }

      const baseUrl = resolvePublicArtifactBaseUrl(env);
      const url = `${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/${encodeURIComponent(filename)}`;
      doDb.insertSessionArtifact(this.sql, {
        artifactId,
        sessionId,
        promptId,
        type: artifactType,
        url,
        metadata: {
          label: "Plan",
          filename,
          contentType,
          access: createArtifactAccessMetadata(artifactType, true),
        },
        createdAt: Date.now(),
      });
      return artifactId;
    } catch (error) {
      this.log.warn(
        { event: "plan_mode_artifact_upload_failed", sessionId, promptId, error: serializeError(error) },
        "Plan markdown artifact upload failed",
      );
      return null;
    }
  }

  private async sendToSandbox(command: SandboxCommand): Promise<void> {
    const sandboxSocket = this.getSandboxSocket();
    if (!sandboxSocket) return;
    let outboundCommand = command;
    const sessionId = this.resolveSessionId();
    const sandboxId = sessionId ? (doDb.getSandboxState(this.sql, sessionId)?.sandboxId ?? null) : null;
    if (command.type === "prompt") {
      const correlation = addSandboxIdToCorrelation(command.correlation, sandboxId);
      if (correlation && correlation !== command.correlation) {
        outboundCommand = { ...command, correlation };
      }
    } else if (this.requestId && (command.type === "stop" || (command.type === "respond" && !command.requestId))) {
      outboundCommand = {
        ...command,
        requestId: this.requestId,
      } as SandboxCommand;
    }
    const promptId = outboundCommand.type === "prompt" ? outboundCommand.messageId : null;
    const dispatchSpan =
      outboundCommand.type === "prompt"
        ? startSpan(
            "session.prompt_dispatch",
            this.buildTraceAttributes(sessionId, promptId, {
              "sandbox.command_type": outboundCommand.type,
              ...(outboundCommand.agent ? { agent: outboundCommand.agent } : {}),
              ...(outboundCommand.model ? { model: outboundCommand.model } : {}),
            }),
          )
        : null;
    try {
      outboundCommand = await this.attachPlatformLlmCapabilities(outboundCommand, sessionId, sandboxId);
      outboundCommand = await this.attachRepoMemories(outboundCommand, sessionId);
      if (outboundCommand.type === "prompt" && sessionId && sandboxId) {
        this.recordRuntimeActivity(sessionId, "prompt_sent_to_bridge");
        await this.processLifecycleEvent(sessionId, {
          type: "prompt.sent_to_bridge",
          promptId: outboundCommand.messageId,
          sandboxId,
        });
      } else if (outboundCommand.type === "respond" && sessionId) {
        this.recordRuntimeActivity(sessionId, "respond_sent_to_bridge");
      }
      sandboxSocket.send(JSON.stringify(outboundCommand));
      if (dispatchSpan) endSpan(dispatchSpan, "ok");
    } catch (err) {
      if (dispatchSpan) {
        endSpan(dispatchSpan, "error", { "error.message": String(err) });
      }
      if (outboundCommand.type === "prompt" && sessionId) {
        this.markPlatformLlmPromptStatus(sessionId, outboundCommand.messageId, "terminal");
      }
      this.log.error({ error: serializeError(err), commandType: outboundCommand.type }, "Failed to send to sandbox");
      this.sandboxWs = null;
    }
  }

  // Required broadcast for out-of-band session-field mutations (review-loop
  // done-state / verification state) that are not phase transitions: rebuild
  // the full subscribed v2 snapshot and push it to every subscribed socket so
  // indicators update live. Reuses the existing `subscribed` wire variant so no
  // new ServerMessage type / FE protocol change is forced.
  private async broadcastSessionSnapshot(sessionId: string): Promise<void> {
    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return;
    const clientSockets = this.getClientSockets();
    if (clientSockets.length === 0) {
      const { message } = await this.buildClientSubscription(sessionId, session.ownerUserId, 0);
      this.broadcast(message);
    }
    for (const socket of clientSockets) {
      const userId = this.getSocketTagValue(this.getSocketTags(socket), "uid:") ?? "";
      const { message } = await this.buildClientSubscription(sessionId, userId, 0);
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // Closed sockets are filtered out on the next broadcast.
      }
    }
    // Mirror done-state / verification badge signals to the sidebar feed
    // (ARC-1322). The full snapshot above carries detail-only fields; the feed
    // delta carries just the sidebar-relevant done-state fields.
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    // ARC-1330 D-59c: the review-loop / cycloid-done aggregate is projected from the spine, not the
    // DO-SQLite copy (whose writers — `recomputeCycloidDoneStatus` / `persistCycloidDoneStatusToD1` and
    // the done-state route — were deleted this slice). Reading `ext?.cycloidDone*` / `ext?.reviewLoopDoneState`
    // here would broadcast a frozen value forever. Match the read-path used by `buildSessionDoResponse` /
    // `buildClientSubscription` so the feed delta moves when the spine moves. `verificationState` /
    // `verificationResult` keep the DO-SQLite copy (still written by `setCurrentSessionVerificationStateForPr`).
    const spineDone = await resolveSpineDoneMirror((this.env as Env).DB, sessionId);
    this.publishFeedDelta({
      // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
      type: "verification",
      sessionId,
      source: "snapshot",
      reviewLoopDoneState: spineDone.reviewLoopDoneState,
      cycloidDoneState: spineDone.cycloidDone.state,
      cycloidDoneOutcome: spineDone.cycloidDone.outcome,
      cycloidDoneReasons: spineDone.cycloidDone.reasons,
      verificationState: ext?.verificationState ?? null,
      verificationResult: ext?.verificationResult ?? null,
    });
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.getClientSockets()) {
      try {
        socket.send(data);
      } catch {
        // Closed sockets are filtered out on the next broadcast.
      }
    }
  }

  /**
   * Publish a list-relevant delta to the per-business sidebar feed (ARC-1322).
   * Resolves the repo-access gate envelope (ownerUserId / repoOwner / repoName)
   * and the businessId routing key from this session's stored row, then routes
   * to SessionFeedDO. Fire-and-forget, never throws; call it *after* the
   * per-session broadcast so a delta never describes unpersisted state.
   */
  private publishFeedDelta(input: FeedDeltaInput): void {
    publishSessionFeedDelta(this.env, this.sql, input);
  }

  private withPublishUserSettingsCache<T>(operation: (settingsCache: UserSettingsCache) => Promise<T>): Promise<T> {
    return operation(new Map());
  }

  private getPublishUserSettings(
    numericOwnerId: number,
    settingsCache: UserSettingsCache | undefined,
  ): Promise<Awaited<ReturnType<typeof getUserSettings>>> {
    if (!settingsCache) return getUserSettings(this.env.DB, numericOwnerId);

    let settings = settingsCache.get(numericOwnerId);
    if (!settings) {
      settings = getUserSettings(this.env.DB, numericOwnerId);
      settingsCache.set(numericOwnerId, settings);
    }
    return settings;
  }

  /**
   * Per-user "open PRs as drafts by default" preference. Returns true when the
   * user opted in. Fails toward false (ready-for-review) on a bad owner id or
   * settings-read error: ready is the historical default and a draft PR is
   * harder to recover from than a ready one if the user actually wanted ready.
   */
  private async getDefaultPrDraft(
    ownerUserId: string,
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<boolean> {
    const numericOwnerId = Number(ownerUserId);
    if (!Number.isFinite(numericOwnerId)) {
      this.log.warn({ ownerUserId }, "Default-PR-draft gate: invalid owner user id; defaulting to ready");
      return false;
    }
    try {
      const settings = await this.getPublishUserSettings(numericOwnerId, settingsCache);
      return resolveEffectiveAutonomySettings(settings).defaultPrDraft;
    } catch (error) {
      this.log.warn(
        { ownerUserId, error: serializeError(error) },
        "Default-PR-draft gate: user setting unavailable; defaulting to ready",
      );
      return false;
    }
  }

  private parsePreparedSessionTitleRecord(value: unknown): { title: string; ticketKey: string | null } | null {
    if (!value || typeof value !== "object") return null;
    const record = value as { title?: unknown; ticketKey?: unknown };
    if (typeof record.title !== "string") return null;
    if (record.ticketKey !== null && typeof record.ticketKey !== "string") return null;
    return { title: record.title, ticketKey: record.ticketKey };
  }

  private preparedSessionTitleKey(promptId: string): string {
    return `prepared_title:${promptId}`;
  }

  private async readPreparedSessionTitle(
    promptId: string,
  ): Promise<{ title: string; ticketKey: string | null } | null> {
    const key = this.preparedSessionTitleKey(promptId);
    let stored: unknown;
    try {
      stored = await this.state.storage.get(key);
    } catch (error) {
      this.log.warn(
        { promptId, errorMessage: String(error) },
        "Prepared session title read failed; falling back to title generation",
      );
      return null;
    }
    if (stored === undefined) return null;

    const parsed = this.parsePreparedSessionTitleRecord(stored);
    if (parsed) return parsed;

    await this.deletePreparedSessionTitle(promptId, "malformed");
    return null;
  }

  private async deletePreparedSessionTitle(promptId: string, reason: string): Promise<void> {
    try {
      await this.state.storage.delete(this.preparedSessionTitleKey(promptId));
    } catch (error) {
      this.log.warn({ promptId, reason, errorMessage: String(error) }, "Prepared session title delete failed");
    }
  }

  private async generateSessionTitle(sessionId: string, promptText: string, promptId: string): Promise<void> {
    if (promptId !== "p-1") return;

    const initialSession = doDb.getSession(this.sql, sessionId);
    if (!initialSession || initialSession.status === "archived") {
      await this.deletePreparedSessionTitle(promptId, "session_unavailable");
      return;
    }

    const initialExt = doDb.getSessionExtended(this.sql, sessionId);
    const prepared = await this.readPreparedSessionTitle(promptId);
    const generated =
      prepared ??
      (await generateConciseSessionTitle(promptText, initialSession.model, this.env, this.log, {
        sessionId,
        promptId,
        businessId: initialSession.businessId,
        ownerUserId: initialSession.ownerUserId,
        repoOwner: initialExt?.repoOwner ?? null,
        repoName: initialExt?.repoName ?? null,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      }));
    if (!generated) return;
    let preparedConsumed = false;
    if (prepared) {
      await this.deletePreparedSessionTitle(promptId, "consumed");
      preparedConsumed = true;
    }

    const session = doDb.getSession(this.sql, sessionId);
    if (!session || session.status === "archived") {
      if (!preparedConsumed) {
        await this.deletePreparedSessionTitle(promptId, "session_unavailable_after_generation");
      }
      return;
    }

    if (!doDb.getPrompt(this.sql, promptId)) {
      if (!preparedConsumed) {
        await this.deletePreparedSessionTitle(promptId, "prompt_missing");
      }
      return;
    }

    const updatedAt = nowIso();
    const updatedSession: SessionState = {
      ...session,
      title: generated.title,
      updatedAt,
    };
    doDb.updateSession(this.sql, sessionId, {
      title: generated.title,
      updatedAt,
    });
    // Persist the ticket key the title LLM read from P0 so `resolvePrTitle` can
    // prefix the PR title at publish without re-calling the model. Only set it
    // when present, to avoid clobbering with a null on a no-ticket task.
    if (generated.ticketKey) {
      doDb.updateSessionFields(this.sql, sessionId, { ticketKey: generated.ticketKey });
    }

    await this.refreshPlanApprovalPendingMirror(sessionId);
    const sandbox = doDb.getSandboxState(this.sql, sessionId);
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const activePromptId = doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const {
      activePromptHasPendingQuestion,
      planApprovalPending,
      planRevision,
      planStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
    } = getRichStatusProjectionInputs(this.sql, sessionId, activePromptId);
    const publishStatus = ext?.publishStatus ?? "not_started";
    // Use the response-status helper so the title-broadcast phase string
    // matches /session/state and the WS subscribed snapshot.
    const richStatus = getSessionStatusForResponse(
      updatedSession,
      sandbox?.status,
      activePromptId,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      ext?.reviewListeningActive ?? false,
      this.userStopped,
    );
    const phaseInfo = derivePhaseInfo(updatedSession, {
      sandboxStatus: sandbox?.status,
      activePromptId,
      stopReason: sandbox?.stopReason ?? null,
      activePromptHasPendingQuestion,
      planApprovalPending,
      userStopped: this.userStopped,
      publishStatus,
      postExecutionPending,
      mostRecentPromptResultNoChanges,
      reviewListeningActive: ext?.reviewListeningActive ?? false,
    });
    const db = (this.env as Env).DB;
    if (db) {
      scheduleSessionProjectionSync({
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        db,
        sessionId,
        session: updatedSession,
        richStatus,
        logger: this.log,
        source: "session.title_generation",
        requestId: this.requestId,
      });
    }
    // `richStatus` is still computed for the D1 `rich_status` column projection
    // higher in the call stack (deferred flip — see PR D notes). It is no longer
    // emitted on the wire; the broadcast above carries only `phase` + substate.
    const _richStatusForProjection = richStatus;
    void _richStatusForProjection;
    this.broadcast({
      type: "session_status",
      ...phaseFieldsFromInfo(phaseInfo),
      planApprovalPending,
      planRevision,
      planStatus,
      title: generated.title,
    });
    this.publishFeedDelta({
      type: "session_status",
      sessionId,
      source: "session.title_generation",
      ...phaseFieldsFromInfo(phaseInfo),
      title: generated.title,
    });
  }

  private async prepareSessionTitle(
    promptText: string,
    context: {
      sessionId: string;
      promptId: string;
      businessId?: string | null;
      ownerUserId?: string | null;
      repoOwner?: string | null;
      repoName?: string | null;
    },
  ): Promise<{ title: string; ticketKey: string | null } | null> {
    const session = doDb.getSession(this.sql, context.sessionId);
    if (!session || session.status === "archived" || session.title) return null;

    const generated = await generateConciseSessionTitle(promptText, session.model, this.env, this.log, {
      ...context,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    if (!generated) return null;

    if (context.promptId === "p-1") {
      await this.state.storage.put(this.preparedSessionTitleKey(context.promptId), generated);
    }
    return generated;
  }

  private async sendPendingPromptToSandbox(sessionId: string): Promise<boolean> {
    return this.promptQueue.sendPendingPromptToSandbox(sessionId);
  }

  private async sendPendingAnswerToSandbox(sessionId: string): Promise<void> {
    return this.promptQueue.sendPendingAnswerToSandbox(sessionId);
  }
}

const sentryConfig = (env: Env) => ({
  ...resolveSentryRuntimeOptions(env), // supplies dsn, enabled, environment
  release: env.SENTRY_RELEASE,
  tracesSampleRate: 0, // Custom tracing via observability/context.ts
});

export const SessionDO = Sentry.instrumentDurableObjectWithSentry(sentryConfig, SessionDOBase);
