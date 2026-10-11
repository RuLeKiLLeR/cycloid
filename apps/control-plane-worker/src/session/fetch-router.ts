import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import { resolveAgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  BUILTIN_AGENTS,
  isCodeReviewerAgentRole,
  isCodeReviewerSession,
  isQaTesterAgentRole,
  REVIEW_AGENT_NAME,
} from "../../../../shared/agent/constants.js";
import type { AgentConfig } from "../../../../shared/agent/schema.js";
import { WEBM_VIDEO_SIZE_LIMIT_BYTES } from "../../../../shared/constants/artifacts.js";
import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import { GITHUB_ACTION_AUTH_DERIVATION_PREFIX } from "../../../../shared/constants/github-action-auth.js";
import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { INTEGRATION_IDS } from "../../../../shared/constants/integration-helpers.js";
import { CORRELATION_HEADER, parseCorrelation } from "../../../../shared/correlation.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { serializeError } from "../../../../shared/observability/error-utils.js";
import { buildPlanContext, normalizePlanMarkdown, PLAN_CAPTURE_MAX_CHARS } from "../../../../shared/plan-mode.js";
import { displayStatusFromPhase } from "../../../../shared/session/display-status.js";
import type { PhaseInfo } from "../../../../shared/session/phase.js";
import {
  DESKTOP_ACTION_PATH_ACTIONS,
  DESKTOP_ACTION_PATH_PHASES,
  DESKTOP_ACTION_PATH_STATUSES,
  DESKTOP_ACTION_SCREENSHOT_STATUSES,
  type DesktopActionPathAction,
  type DesktopActionPathRow,
  type DesktopActionPathSnapshotResponse,
  type DesktopActionPathStatus,
  type DesktopActionScreenshotRef,
  type DesktopActionScreenshotStatus,
  type RegisterDesktopActionPathRowRequest,
  type RegisterDesktopActionPathRowResponse,
} from "../../../../shared/types/desktop-action-path.js";
import type {
  DesktopViewTicketCloseDiagnostics,
  DesktopViewTicketCloseRequest,
  DesktopViewTicketConnectRequest,
  DesktopViewTicketHeartbeatRequest,
  DesktopViewTicketRevokeRequest,
} from "../../../../shared/types/desktop-viewer.js";
import type { PublishStatus } from "../../../../shared/types/publish.js";
import { normalizeQaRunTerminalSummary, QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY } from "../../../../shared/types/qa-run.js";
import type {
  AppRuntimeProfileDiagnostic,
  AppRuntimeProfileSource,
  PreviewContract,
  RuntimeProvenance,
} from "../../../../shared/types/sandbox.js";
import { AgentConfigError, resolveAgents } from "../agent/resolution.js";
import {
  LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
} from "../constants/sessions";
import { VERIFICATION_PENDING_RANK, VERIFICATION_STATE_RANK } from "../constants/verification";
import { InitiationMode, parseInitiationMode } from "../enums/initiation-mode.js";
import { parseSessionEntrypoint, SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createInstallationToken } from "../github/octokit";
import { getPrHeadSha, isRepoPrivate } from "../github/pr";
import { filterPrReviewFindingsByConfidence, publishPrReview } from "../github/pr-review-publish";
import { writeIntegrationLifecycleEvent } from "../integrations/lifecycle/service";
import { endSpan, extractTraceparent, runInSpan, startSpan } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { parseBody } from "../routes/shared";
import { E2BSandboxRuntimeError } from "../sandbox/e2b-client";
import type { ResolvedSandboxLayerArtifact, SandboxLayerSessionResolution } from "../sandbox/layer-resolver";
import type { SandboxProviderClient } from "../sandbox/provider-client";
import { parsePersistedRuntimeBackend, type RuntimeBackend } from "../sandbox/runtime-backend";
import { E2B_CLOUD_RUNTIME_BACKEND } from "../sandbox/runtime-backend";
import { resolvePublicArtifactBaseUrl } from "../services/public-url";
import { recordReviewLoopSelfPushForSession } from "../services/review-loop-epochs";
import { syncSessionProjection } from "../services/session-projection";
import {
  runSlackGetThreadTool,
  runSlackSearchMessagesTool,
  runSlackSendMessageTool,
  toSlackDynamicToolFailureResponse,
} from "../slack/dynamic-tools";
import type { CallbackContext, Env, GithubIssueContext, LinearContext, ReplayState, SessionState } from "../types";
import {
  asNonEmptyString,
  computeSha256Hex,
  generateRandomHex,
  jsonErrorResponse,
  jsonResponse,
  normalizeWebhookReference,
  nowIso,
  parseBearerToken,
  parseJsonBody,
  parseNonNegativeInteger,
  resolveSandboxCallbackSecret,
  timingSafeEqualString,
  truncateDepth,
} from "../utils";
import {
  buildPublicArtifactUrl,
  canServePublicArtifact,
  createArtifactAccessMetadata,
  decodeArtifactPathSegment,
  isAuthedReadableArtifactType,
  isPrSafeArtifactType,
  normalizeArtifactContentType,
  parseArtifactAccessMetadata,
  PUBLIC_ARTIFACT_CACHE_CONTROL,
  PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM,
  SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE,
  verifyArtifactAccessToken,
} from "./artifacts.js";
import { mergeCallbackContextUpdate } from "./callback-context";
import { updateCompletionDraftForPr } from "./completions-db";
import {
  closeDesktopViewTicket,
  connectDesktopViewTicket,
  createDesktopViewTicket,
  getDesktopViewTicketStatus,
  heartbeatDesktopViewTicket,
  revokeDesktopViewTicket,
} from "./desktop-view-tickets";
import type {
  CloseSessionRequest,
  E2BRuntimeCleanupReason,
  EditSessionPlanRequest,
  InitializeSessionRequest,
  InitializeSessionResponse,
  SetSessionRepoRequest,
  SetSessionRepoResponse,
  UpdateSessionCallbackContextRequest,
  UpdateSessionCallbackContextResponse,
} from "./internal-routes";
import { SESSION_BEARER_INTERNAL_ROUTES } from "./internal-routes";
import { GithubPrOperations } from "./pr-github-ops.js";
import { getPrReviewTriggerClaim, releasePrReviewTrigger } from "./pr-review-claims-db";
import { PrReviewPublishBodySchema } from "./pr-review-publish-schema";
import { emitPlanModeEvent, shouldStartSpawnForAdmit } from "./prompt-queue.js";
import { publishReviewLoopSummaryComment } from "./publish-service.js";
import {
  buildSessionReplayPage,
  okSessionReplayResponse,
  parseSessionReplayQuery,
  SESSION_REPLAY_MAX_LIMIT,
} from "./replay-contract";
import { applyRuntimePatch } from "./sandbox-state-owners/runtime-identity.js";
import { notifyZeusReviewIssues } from "./zeus-review-issues-alert";

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
  reviewListeningActive?: boolean,
  userStopped?: boolean,
): string {
  return computeRichStatus(session, {
    sandboxStatus,
    activePromptId,
    stopReason,
    activePromptHasPendingQuestion,
    userStopped,
    publishStatus,
    postExecutionPending,
    mostRecentPromptResultNoChanges,
    reviewListeningActive,
  });
}

import type { VerificationResult, VerificationState } from "../../../../shared/session/phase.js";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../constants/verification";
import * as doDb from "./do-db.js";
import { computeRichStatus, derivePhaseInfo, getRichStatusProjectionInputs } from "./rich-status.js";

const DO_SPAN_ERROR_STACK_MAX_CHARS = 4_000;

function doErrorSpanAttributes(err: unknown, sid: string | undefined): Record<string, string> {
  const serialized = serializeError(err);
  return {
    ...(sid ? { "session.id": sid } : {}),
    "error.message": serialized.message,
    ...(serialized.stack ? { "error.stack": serialized.stack.slice(0, DO_SPAN_ERROR_STACK_MAX_CHARS) } : {}),
  };
}

interface SessionStatusFrame {
  richStatus: string;
  phaseInfo: PhaseInfo;
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

const RUNTIME_PREVIEW_OVERRIDE_STORAGE_KEY = "runtime_preview_override";
const USE_OPENAI_FLEX_SERVICE_TIER_STORAGE_KEY = "use_openai_flex_service_tier";
const VERIFICATION_PHASE_ARTIFACTS_STORAGE_KEY = "verification_phase_artifacts";
const PR_REVIEW_PUBLISHED_STORAGE_KEY = "pr_review_published";
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
  // ARC-1273: bounds a non-terminal verification by the per-PR lock's TTL. Armed as a DO-storage
  // deadline when a verifier is in flight; fires from `dispatchVerificationLivenessAlarm()`, which
  // re-reads the live lock and terminalizes the PR surfaces only if the holder is provably dead.
  | "verificationLiveness"
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
  await storage.transaction(async (txn: DurableObjectTransaction) => {
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

function exactArtifactFilenameForRead(artifact: doDb.SessionArtifactRow, requestedFilename: string): string | null {
  const storedFilename = localStorageFilenameForArtifact(artifact);
  if (!storedFilename || storedFilename !== requestedFilename) return null;
  return storedFilename;
}

// The SessionDO private surface is intentionally passed through during this
// mechanical extraction. The moved fetch ladder still owns the same behavior;
// follow-up route-table work can narrow this host contract inside this module.
type SessionFetchHost = {
  state: DurableObjectState;
  env: Env;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

type AuthorizedSessionResult = { ok: true; sid: string; session: SessionState } | { ok: false; response: Response };

type WarmTrigger = "composer_input" | "page_open";
type WarmTriggerOutcome =
  "resumed" | "spawned" | "noop_live" | "noop_inflight" | "noop_expired" | "noop_no_runtime" | "failed";

function parseWarmTrigger(value: string | null): WarmTrigger {
  return value === "page_open" ? "page_open" : "composer_input";
}

function emitWarmTriggerEvent(
  self: SessionFetchHost,
  sessionId: string,
  trigger: WarmTrigger,
  outcome: WarmTriggerOutcome,
  sandbox: doDb.SandboxStateRow | null,
  errorClass?: string,
): void {
  self.ctx.waitUntil(
    postStructuredEventToDd(self.env, {
      event: "sandbox.warm_trigger",
      sessionId,
      trigger,
      outcome,
      runtime_backend: sandbox?.runtimeBackend ?? null,
      sandboxStatus: sandbox?.status ?? null,
      sandboxRuntimeState: sandbox?.runtimeState ?? null,
      sandboxRuntimeProvider: sandbox?.runtimeProvider ?? null,
      sandboxRuntimeSandboxId: sandbox?.runtimeSandboxId ?? null,
      ...(errorClass ? { error_class: errorClass } : {}),
    }).catch(() => false),
  );
}

function isPausedRuntimeResumeAvailable(sandbox: doDb.SandboxStateRow | null): boolean {
  return (
    sandbox?.status === "stopped" &&
    sandbox.runtimeState === "paused" &&
    typeof sandbox.runtimeSandboxId === "string" &&
    (sandbox.runtimeStateExpiresAt == null || sandbox.runtimeStateExpiresAt > Date.now())
  );
}

function isPausedRuntimeExpired(sandbox: doDb.SandboxStateRow | null): boolean {
  return (
    sandbox?.runtimeState === "paused" &&
    typeof sandbox.runtimeSandboxId === "string" &&
    typeof sandbox.runtimeStateExpiresAt === "number" &&
    sandbox.runtimeStateExpiresAt <= Date.now()
  );
}

// Collapses the repeated session-load + defense-in-depth access-check preamble
// (resolveSessionId → 404 → getSession → 404 → parseAuthHeaders → checkAccess → 404).
// The existence-hiding 404 responses and the check ORDER are security-relevant, so
// this reproduces them byte-for-byte. Sites that diverge — session-load WITHOUT the
// access check, combined `!sid || !session` guards, or non-JSON `Not found` bodies —
// stay inline.
function requireAuthorizedSession(self: SessionFetchHost, request: Request): AuthorizedSessionResult {
  const sid = self.resolveSessionId();
  if (!sid) return { ok: false, response: jsonErrorResponse("Session not found", 404) };
  const session = doDb.getSession(self.sql, sid);
  if (!session) return { ok: false, response: jsonErrorResponse("Session not found", 404) };
  const auth = self.parseAuthHeaders(request);
  if (auth && !self.checkAccess(auth, session)) {
    return { ok: false, response: jsonErrorResponse("Session not found", 404) };
  }
  return { ok: true, sid, session };
}

type ActiveSandboxCaller = { sessionId: string; sandbox: doDb.SandboxStateRow };

type ActiveSandboxCallerResult =
  { ok: true; auth: ActiveSandboxCaller; session: SessionState } | { ok: false; response: Response };

type SandboxAuthResult =
  { ok: true; sessionId: string; sandbox: doDb.SandboxStateRow } | { ok: false; response: Response };

// Collapses the repeated sandbox-auth preamble
// (validateSandboxAuthRequest → getSession → 404 → requireActiveSandboxTokenMintingTarget).
// Preserves the auth-failure responses, the existence-hiding 404, and the check ORDER
// exactly. Sandbox routes that skip the explicit 404 (delegating the null-session case
// to the active-target check), use the CLI minting target, or only validate auth stay
// inline.
async function requireActiveSandboxCaller(
  self: SessionFetchHost,
  request: Request,
): Promise<ActiveSandboxCallerResult> {
  const auth = await self.validateSandboxAuthRequest(request);
  if (!auth.ok) return { ok: false, response: auth.response };
  const session = doDb.getSession(self.sql, auth.sessionId);
  if (!session) return { ok: false, response: jsonErrorResponse("Session not found", 404) };
  const activeTarget = self.requireActiveSandboxTokenMintingTarget(auth, session);
  if (!activeTarget.ok) return { ok: false, response: activeTarget.response };
  return { ok: true, auth, session };
}

const DESKTOP_ACTION_SCREENSHOT_MAX_AVAILABLE = 500;
const DESKTOP_ACTION_PATH_MAX_ROWS = DESKTOP_ACTION_SCREENSHOT_MAX_AVAILABLE;
const DESKTOP_ACTION_SCREENSHOT_MAX_BYTES = 256 * 1024 * 1024;
const DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION = "v2";
const DESKTOP_ACTION_STORAGE_BATCH_LIMIT = 128;
const DESKTOP_ACTION_PATH_ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DESKTOP_ACTION_SCREENSHOT_KIND = "desktop_action_screenshot";

function desktopActionPathIndexKey(sessionId: string): string {
  return `desktop_action_path:${sessionId}:index`;
}

function desktopActionScreenshotQuotaIndexKey(sessionId: string): string {
  return `desktop_action_path:${sessionId}:screenshot_quota_index`;
}

function desktopActionScreenshotQuotaBackfillKey(sessionId: string): string {
  return `desktop_action_path:${sessionId}:screenshot_quota_backfilled`;
}

function desktopActionPathSeqKey(sessionId: string): string {
  return `desktop_action_path:${sessionId}:seq`;
}

function desktopActionPathRowKey(sessionId: string, actionId: string): string {
  return `desktop_action_path:${sessionId}:row:${actionId}`;
}

type DurableObjectBatchStorage = Pick<DurableObjectStorage, "delete" | "get" | "put">;

type DesktopActionScreenshotQuotaEntry = {
  actionId: string;
  artifactId: string;
  bytes: number;
  desktopActionSeq: number;
};

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function storageGetMany<T>(storage: DurableObjectBatchStorage, keys: string[]): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  for (const chunk of chunkValues(keys, DESKTOP_ACTION_STORAGE_BATCH_LIMIT)) {
    const values = await storage.get<T>(chunk);
    for (const [key, value] of values) {
      result.set(key, value as T);
    }
  }
  return result;
}

async function storagePutMany(storage: DurableObjectBatchStorage, entries: Record<string, unknown>): Promise<void> {
  const entryChunks = chunkValues(Object.entries(entries), DESKTOP_ACTION_STORAGE_BATCH_LIMIT);
  for (const chunk of entryChunks) {
    await storage.put(Object.fromEntries(chunk) as Record<string, unknown>);
  }
}

async function storageDeleteMany(storage: DurableObjectBatchStorage, keys: string[]): Promise<void> {
  for (const chunk of chunkValues(keys, DESKTOP_ACTION_STORAGE_BATCH_LIMIT)) {
    await storage.delete(chunk);
  }
}

function normalizeDesktopActionPathIndex(actionIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const actionId of actionIds) {
    if (!DESKTOP_ACTION_PATH_ACTION_ID_RE.test(actionId) || seen.has(actionId)) continue;
    seen.add(actionId);
    normalized.push(actionId);
  }
  return normalized;
}

function retainDesktopActionPathIndex(actionIds: string[]): {
  retainedActionIds: string[];
  evictedActionIds: string[];
} {
  const normalized = normalizeDesktopActionPathIndex(actionIds);
  const evictedCount = Math.max(0, normalized.length - DESKTOP_ACTION_PATH_MAX_ROWS);
  return {
    retainedActionIds: normalized.slice(evictedCount),
    evictedActionIds: normalized.slice(0, evictedCount),
  };
}

function mergeDesktopActionPathIndex(
  actionIds: string[],
  actionId: string,
): { retainedActionIds: string[]; evictedActionIds: string[] } {
  const normalized = normalizeDesktopActionPathIndex(actionIds);
  if (!normalized.includes(actionId)) {
    normalized.push(actionId);
  }
  return retainDesktopActionPathIndex(normalized);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseDesktopScreenshotCaptureMode(value: unknown): "full_display" | null | undefined {
  if (value === undefined || value === null) return null;
  return value === "full_display" ? "full_display" : undefined;
}

function parseDesktopActionScreenshotRef(value: unknown): DesktopActionScreenshotRef | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const captureMode = parseDesktopScreenshotCaptureMode(record.captureMode);
  const displayName = record.displayName === undefined ? null : record.displayName;
  if (
    typeof record.actionId !== "string" ||
    !DESKTOP_ACTION_PATH_ACTION_ID_RE.test(record.actionId) ||
    typeof record.artifactId !== "string" ||
    record.artifactId.length === 0 ||
    record.kind !== DESKTOP_ACTION_SCREENSHOT_KIND ||
    record.artifactAccessVisibility !== "private" ||
    typeof record.label !== "string" ||
    typeof record.viewUrl !== "string" ||
    !isFiniteNonNegativeNumber(record.width) ||
    !isFiniteNonNegativeNumber(record.height) ||
    !isFiniteNonNegativeNumber(record.bytes) ||
    captureMode === undefined ||
    !isNullableString(displayName) ||
    !isFiniteNonNegativeNumber(record.capturedAtMs) ||
    !isOneOf(record.status, DESKTOP_ACTION_SCREENSHOT_STATUSES)
  ) {
    return undefined;
  }
  return {
    actionId: record.actionId,
    artifactId: record.artifactId,
    kind: DESKTOP_ACTION_SCREENSHOT_KIND,
    artifactAccessVisibility: "private",
    label: record.label,
    viewUrl: record.viewUrl,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    captureMode,
    displayName,
    capturedAtMs: record.capturedAtMs,
    status: record.status as DesktopActionScreenshotStatus,
  };
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function authenticatedArtifactViewUrl(sessionId: string, artifactId: string, filename: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(
    artifactId,
  )}/view?filename=${encodeURIComponent(filename)}`;
}

function shouldRejectMissingDesktopActionScreenshotArtifact(
  sessionId: string,
  screenshot: DesktopActionScreenshotRef,
): boolean {
  if (screenshot.artifactId === `artifact-${screenshot.actionId}`) return true;
  try {
    const url = new URL(screenshot.viewUrl, "https://internal");
    const encodedSessionId = encodeURIComponent(sessionId);
    const encodedArtifactId = encodeURIComponent(screenshot.artifactId);
    return url.pathname.includes(`/api/sessions/${encodedSessionId}/artifacts/${encodedArtifactId}/`);
  } catch {
    return false;
  }
}

function normalizeDesktopActionScreenshotRef(
  sql: SqlStorage,
  sessionId: string,
  screenshot: DesktopActionScreenshotRef | null,
): { ok: true; screenshot: DesktopActionScreenshotRef | null } | { ok: false; error: string } {
  if (!screenshot) return { ok: true, screenshot: null };
  if (screenshot.status !== "available") return { ok: true, screenshot };

  const artifact = doDb.getSessionArtifact(sql, sessionId, screenshot.artifactId);
  if (!artifact) {
    if (shouldRejectMissingDesktopActionScreenshotArtifact(sessionId, screenshot)) {
      return { ok: false, error: "Desktop action screenshot artifact not found" };
    }
    return { ok: true, screenshot };
  }
  if (artifact.type !== "screenshot")
    return { ok: false, error: "Desktop action screenshot artifact must be a screenshot" };

  const metadata = artifact.metadata ?? {};
  if (metadata.kind !== DESKTOP_ACTION_SCREENSHOT_KIND) {
    return { ok: false, error: "Desktop action screenshot artifact metadata kind is invalid" };
  }
  if (metadataString(metadata, "actionId") !== screenshot.actionId) {
    return { ok: false, error: "Desktop action screenshot artifact actionId mismatch" };
  }
  const access = parseArtifactAccessMetadata(metadata);
  if (access.visibility !== "private" || access.revokedAt !== null) {
    return { ok: false, error: "Desktop action screenshot artifact must be private and active" };
  }

  const filename = metadataString(metadata, "filename");
  if (!filename) return { ok: false, error: "Desktop action screenshot artifact filename is missing" };

  return {
    ok: true,
    screenshot: {
      ...screenshot,
      kind: DESKTOP_ACTION_SCREENSHOT_KIND,
      artifactAccessVisibility: "private",
      label: metadataString(metadata, "label") ?? screenshot.label,
      viewUrl: authenticatedArtifactViewUrl(sessionId, artifact.artifactId, filename),
      captureMode: screenshot.captureMode,
      displayName: screenshot.displayName,
      status: "available",
    },
  };
}

function parseDesktopActionPathRegisterRequest(
  value: unknown,
): { ok: true; row: RegisterDesktopActionPathRowRequest } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Invalid desktop action row" };
  }
  const record = value as Record<string, unknown>;
  const screenshot = parseDesktopActionScreenshotRef(record.screenshot);
  if (
    typeof record.actionId !== "string" ||
    !DESKTOP_ACTION_PATH_ACTION_ID_RE.test(record.actionId) ||
    !isNullableString(record.promptId) ||
    !isOneOf(record.phase, DESKTOP_ACTION_PATH_PHASES) ||
    !isOneOf(record.action, DESKTOP_ACTION_PATH_ACTIONS) ||
    typeof record.label !== "string" ||
    record.label.length === 0 ||
    record.label.length > 512 ||
    !isOneOf(record.status, DESKTOP_ACTION_PATH_STATUSES) ||
    !isNullableString(record.activeWindowTitle) ||
    !isNullableString(record.warningCode) ||
    !isNullableString(record.errorCode) ||
    screenshot === undefined ||
    !isFiniteNonNegativeNumber(record.createdAtMs) ||
    !isFiniteNonNegativeNumber(record.updatedAtMs)
  ) {
    return { ok: false, error: "Invalid desktop action row" };
  }
  if (screenshot && screenshot.actionId !== record.actionId) {
    return { ok: false, error: "Screenshot actionId must match row actionId" };
  }
  return {
    ok: true,
    row: {
      actionId: record.actionId,
      promptId: record.promptId,
      phase: record.phase,
      action: record.action as DesktopActionPathAction,
      label: record.label,
      status: record.status as DesktopActionPathStatus,
      activeWindowTitle: record.activeWindowTitle,
      warningCode: record.warningCode,
      errorCode: record.errorCode,
      screenshot,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    },
  };
}

function desktopScreenshotCompleteness(screenshot: DesktopActionScreenshotRef | null): number {
  if (!screenshot) return 0;
  return screenshot.status === "available" ? 2 : 1;
}

function shouldUpdateDesktopActionRow(
  existing: DesktopActionPathRow,
  incoming: RegisterDesktopActionPathRowRequest,
): boolean {
  return (
    incoming.updatedAtMs > existing.updatedAtMs ||
    desktopScreenshotCompleteness(incoming.screenshot) > desktopScreenshotCompleteness(existing.screenshot)
  );
}

function mergeDesktopActionScreenshot(
  existing: DesktopActionScreenshotRef | null,
  incoming: DesktopActionScreenshotRef | null,
): DesktopActionScreenshotRef | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return desktopScreenshotCompleteness(incoming) >= desktopScreenshotCompleteness(existing)
    ? { ...existing, ...incoming }
    : existing;
}

function mergeDesktopActionPathRow(
  existing: DesktopActionPathRow,
  incoming: RegisterDesktopActionPathRowRequest,
  sessionId: string,
): DesktopActionPathRow {
  const rowMetadata = incoming.updatedAtMs > existing.updatedAtMs ? { ...existing, ...incoming } : existing;
  return {
    ...rowMetadata,
    sessionId,
    desktopActionSeq: existing.desktopActionSeq,
    screenshot: mergeDesktopActionScreenshot(existing.screenshot, incoming.screenshot),
    updatedAtMs: Math.max(existing.updatedAtMs, incoming.updatedAtMs),
  };
}

function normalizeDesktopActionScreenshotQuotaIndex(value: unknown): DesktopActionScreenshotQuotaEntry[] {
  if (!Array.isArray(value)) return [];
  const entriesByActionId = new Map<string, DesktopActionScreenshotQuotaEntry>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.actionId !== "string" ||
      !DESKTOP_ACTION_PATH_ACTION_ID_RE.test(record.actionId) ||
      typeof record.artifactId !== "string" ||
      record.artifactId.length === 0 ||
      !isFiniteNonNegativeNumber(record.bytes) ||
      !isFiniteNonNegativeNumber(record.desktopActionSeq)
    ) {
      continue;
    }
    entriesByActionId.set(record.actionId, {
      actionId: record.actionId,
      artifactId: record.artifactId,
      bytes: record.bytes,
      desktopActionSeq: record.desktopActionSeq,
    });
  }
  return [...entriesByActionId.values()].sort((left, right) => left.desktopActionSeq - right.desktopActionSeq);
}

function desktopActionScreenshotQuotaEntry(row: DesktopActionPathRow): DesktopActionScreenshotQuotaEntry | null {
  if (row.screenshot?.status !== "available") return null;
  return {
    actionId: row.actionId,
    artifactId: row.screenshot.artifactId,
    bytes: row.screenshot.bytes,
    desktopActionSeq: row.desktopActionSeq,
  };
}

function updateDesktopActionScreenshotQuotaIndex(
  entries: DesktopActionScreenshotQuotaEntry[],
  row: DesktopActionPathRow,
): DesktopActionScreenshotQuotaEntry[] {
  const nextEntries = normalizeDesktopActionScreenshotQuotaIndex(entries).filter(
    (entry) => entry.actionId !== row.actionId,
  );
  const nextEntry = desktopActionScreenshotQuotaEntry(row);
  if (nextEntry) nextEntries.push(nextEntry);
  return nextEntries.sort((left, right) => left.desktopActionSeq - right.desktopActionSeq);
}

function removeDesktopActionScreenshotQuotaEntries(
  entries: DesktopActionScreenshotQuotaEntry[],
  actionIds: string[],
): { retainedEntries: DesktopActionScreenshotQuotaEntry[]; removedEntries: DesktopActionScreenshotQuotaEntry[] } {
  const actionIdSet = new Set(actionIds);
  const retainedEntries: DesktopActionScreenshotQuotaEntry[] = [];
  const removedEntries: DesktopActionScreenshotQuotaEntry[] = [];
  for (const entry of normalizeDesktopActionScreenshotQuotaIndex(entries)) {
    if (actionIdSet.has(entry.actionId)) {
      removedEntries.push(entry);
    } else {
      retainedEntries.push(entry);
    }
  }
  return { retainedEntries, removedEntries };
}

async function backfillDesktopActionScreenshotQuotaIndex(
  storage: DurableObjectBatchStorage,
  sessionId: string,
  retainedActionIds: string[],
  evictedActionIds: string[],
  currentRow: DesktopActionPathRow,
): Promise<{
  retainedEntries: DesktopActionScreenshotQuotaEntry[];
  evictedEntries: DesktopActionScreenshotQuotaEntry[];
}> {
  const currentRowKey = desktopActionPathRowKey(sessionId, currentRow.actionId);
  const rowKeys = uniqueValues([...retainedActionIds, ...evictedActionIds])
    .map((actionId) => desktopActionPathRowKey(sessionId, actionId))
    .filter((key) => key !== currentRowKey);
  const storedRows = await storageGetMany<DesktopActionPathRow>(storage, rowKeys);

  const entryForActionId = (actionId: string): DesktopActionScreenshotQuotaEntry | null => {
    const row =
      actionId === currentRow.actionId ? currentRow : storedRows.get(desktopActionPathRowKey(sessionId, actionId));
    return row ? desktopActionScreenshotQuotaEntry(row) : null;
  };
  const retainedEntries = retainedActionIds
    .map(entryForActionId)
    .filter((entry): entry is DesktopActionScreenshotQuotaEntry => entry !== null);
  const evictedEntries = evictedActionIds
    .map(entryForActionId)
    .filter((entry): entry is DesktopActionScreenshotQuotaEntry => entry !== null);

  return { retainedEntries, evictedEntries };
}

function pruneDesktopActionScreenshotQuotaIndex(entries: DesktopActionScreenshotQuotaEntry[]): {
  retainedEntries: DesktopActionScreenshotQuotaEntry[];
  prunedEntries: DesktopActionScreenshotQuotaEntry[];
} {
  const retainedEntries = normalizeDesktopActionScreenshotQuotaIndex(entries);
  const prunedEntries: DesktopActionScreenshotQuotaEntry[] = [];
  let availableBytes = retainedEntries.reduce((sum, entry) => sum + entry.bytes, 0);

  while (
    retainedEntries.length > DESKTOP_ACTION_SCREENSHOT_MAX_AVAILABLE ||
    availableBytes > DESKTOP_ACTION_SCREENSHOT_MAX_BYTES
  ) {
    const entry = retainedEntries.shift();
    if (!entry) break;
    availableBytes -= entry.bytes;
    prunedEntries.push(entry);
  }

  return { retainedEntries, prunedEntries };
}

async function markDesktopActionScreenshotRowsPruned(
  storage: DurableObjectBatchStorage,
  sessionId: string,
  entries: DesktopActionScreenshotQuotaEntry[],
  currentRow: DesktopActionPathRow,
  now: number,
): Promise<{ rows: DesktopActionPathRow[]; prunedArtifactIds: string[] }> {
  const currentRowKey = desktopActionPathRowKey(sessionId, currentRow.actionId);
  const keys = entries
    .map((entry) => desktopActionPathRowKey(sessionId, entry.actionId))
    .filter((key) => key !== currentRowKey);
  const storedRows = await storageGetMany<DesktopActionPathRow>(storage, keys);
  const rows: DesktopActionPathRow[] = [];
  const prunedArtifactIds: string[] = [];

  for (const entry of entries) {
    const row =
      entry.actionId === currentRow.actionId
        ? currentRow
        : storedRows.get(desktopActionPathRowKey(sessionId, entry.actionId));
    prunedArtifactIds.push(entry.artifactId);
    if (!row?.screenshot || row.screenshot.artifactId !== entry.artifactId || row.screenshot.status !== "available") {
      continue;
    }
    rows.push({
      ...row,
      status: "pruned",
      screenshot: {
        ...row.screenshot,
        status: "pruned",
      },
      updatedAtMs: Math.max(row.updatedAtMs, now),
    });
  }

  return { rows, prunedArtifactIds };
}

function replacedDesktopActionScreenshotArtifactId(
  existing: DesktopActionPathRow | undefined,
  row: DesktopActionPathRow,
): string | null {
  if (
    existing?.screenshot?.status !== "available" ||
    row.screenshot?.status !== "available" ||
    existing.screenshot.artifactId === row.screenshot.artifactId
  ) {
    return null;
  }
  return existing.screenshot.artifactId;
}

async function listDesktopActionPathRows(
  storage: DurableObjectStorage,
  sessionId: string,
): Promise<DesktopActionPathSnapshotResponse> {
  const storedIndex = (await storage.get<string[]>(desktopActionPathIndexKey(sessionId))) ?? [];
  const { retainedActionIds } = retainDesktopActionPathIndex(storedIndex);
  const keys = retainedActionIds.map((actionId) => desktopActionPathRowKey(sessionId, actionId));
  const rowMap = await storageGetMany<DesktopActionPathRow>(storage, keys);
  const rows = keys
    .map((key) => rowMap.get(key))
    .filter((row): row is DesktopActionPathRow => Boolean(row))
    .sort((left, right) => left.desktopActionSeq - right.desktopActionSeq);
  const storedSeq = (await storage.get<number>(desktopActionPathSeqKey(sessionId))) ?? 0;
  const maxDesktopActionSeq = Math.max(storedSeq, rows.at(-1)?.desktopActionSeq ?? 0);
  return { ok: true, rows, maxDesktopActionSeq };
}

async function registerDesktopActionPathRow(
  storage: DurableObjectStorage,
  sql: SqlStorage,
  sessionId: string,
  incoming: RegisterDesktopActionPathRowRequest,
): Promise<RegisterDesktopActionPathRowResponse> {
  const normalized = normalizeDesktopActionScreenshotRef(sql, sessionId, incoming.screenshot);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  const normalizedIncoming: RegisterDesktopActionPathRowRequest = {
    ...incoming,
    screenshot: normalized.screenshot,
  };
  const now = Date.now();
  const result: { response: RegisterDesktopActionPathRowResponse; prunedArtifactIds: string[] } =
    await storage.transaction(async (txn) => {
      const rowKey = desktopActionPathRowKey(sessionId, incoming.actionId);
      const indexKey = desktopActionPathIndexKey(sessionId);
      const quotaIndexKey = desktopActionScreenshotQuotaIndexKey(sessionId);
      const quotaBackfillKey = desktopActionScreenshotQuotaBackfillKey(sessionId);
      const seqKey = desktopActionPathSeqKey(sessionId);
      const storedIndex = (await txn.get<string[]>(indexKey)) ?? [];
      const index = normalizeDesktopActionPathIndex(storedIndex);
      const screenshotQuotaIndex = normalizeDesktopActionScreenshotQuotaIndex(await txn.get(quotaIndexKey));
      const quotaIndexBackfilled =
        (await txn.get<string>(quotaBackfillKey)) === DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION;
      const existing = await txn.get<DesktopActionPathRow>(rowKey);
      let response: RegisterDesktopActionPathRowResponse;
      if (existing) {
        const shouldUpdate = shouldUpdateDesktopActionRow(existing, normalizedIncoming);
        const row = shouldUpdate ? mergeDesktopActionPathRow(existing, normalizedIncoming, sessionId) : existing;
        response = { ok: true, row, idempotent: true, updated: shouldUpdate };
      } else {
        const currentSeq = (await txn.get<number>(seqKey)) ?? 0;
        const nextSeq = currentSeq + 1;
        const row: DesktopActionPathRow = {
          ...normalizedIncoming,
          sessionId,
          desktopActionSeq: nextSeq,
        };
        response = { ok: true, row, idempotent: false, updated: true };
        await txn.put(seqKey, nextSeq);
      }

      const { retainedActionIds: nextIndex, evictedActionIds } = mergeDesktopActionPathIndex(
        index,
        response.row.actionId,
      );
      const indexChanged = !stringArraysEqual(nextIndex, storedIndex);
      if (!response.updated && quotaIndexBackfilled && !indexChanged && evictedActionIds.length === 0) {
        return { response, prunedArtifactIds: [] };
      }

      const replacedArtifactId = replacedDesktopActionScreenshotArtifactId(existing, response.row);
      const evictedQuotaEntries = removeDesktopActionScreenshotQuotaEntries(screenshotQuotaIndex, evictedActionIds);
      let baseQuotaIndex = evictedQuotaEntries.retainedEntries;
      let evictedArtifactIds = evictedQuotaEntries.removedEntries.map((entry) => entry.artifactId);
      if (!quotaIndexBackfilled) {
        const backfilled = await backfillDesktopActionScreenshotQuotaIndex(
          txn,
          sessionId,
          nextIndex,
          evictedActionIds,
          response.row,
        );
        baseQuotaIndex = backfilled.retainedEntries;
        evictedArtifactIds = [
          ...new Set([...evictedArtifactIds, ...backfilled.evictedEntries.map((entry) => entry.artifactId)]),
        ];
      }

      const updatedQuotaIndex = updateDesktopActionScreenshotQuotaIndex(baseQuotaIndex, response.row);
      const pruned = pruneDesktopActionScreenshotQuotaIndex(updatedQuotaIndex);
      const prunedRows = await markDesktopActionScreenshotRowsPruned(
        txn,
        sessionId,
        pruned.prunedEntries,
        response.row,
        now,
      );
      let responseRow = response.row;
      const entriesToPut: Record<string, unknown> = {
        [indexKey]: nextIndex,
        [quotaIndexKey]: pruned.retainedEntries,
      };
      if (!quotaIndexBackfilled) {
        entriesToPut[quotaBackfillKey] = DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION;
      }
      if (!evictedActionIds.includes(response.row.actionId)) {
        entriesToPut[rowKey] = response.row;
      }
      for (const row of prunedRows.rows) {
        entriesToPut[desktopActionPathRowKey(sessionId, row.actionId)] = row;
        if (row.actionId === response.row.actionId) {
          responseRow = row;
        }
      }
      await storagePutMany(txn, entriesToPut);
      await storageDeleteMany(
        txn,
        evictedActionIds.map((actionId) => desktopActionPathRowKey(sessionId, actionId)),
      );

      return {
        response: {
          ok: true,
          row: responseRow,
          idempotent: response.idempotent,
          updated: response.updated,
        },
        prunedArtifactIds: [
          ...new Set([
            ...prunedRows.prunedArtifactIds,
            ...evictedArtifactIds,
            ...(replacedArtifactId ? [replacedArtifactId] : []),
          ]),
        ],
      };
    });

  for (const artifactId of result.prunedArtifactIds) {
    doDb.revokeSessionArtifact(sql, sessionId, artifactId, now);
  }

  return result.response;
}

async function emitDesktopActionPathPersistTelemetry(
  self: SessionFetchHost,
  sessionId: string,
  result: RegisterDesktopActionPathRowResponse,
  durationMs: number,
): Promise<void> {
  const payload = {
    event: "desktop.action_path_persist",
    sessionIdHash: await computeSha256Hex(sessionId),
    actionId: result.row.actionId,
    sequence: result.row.desktopActionSeq,
    durationMs,
    idempotentUpdate: result.idempotent,
    updated: result.updated,
    success: true,
    screenshotStatus: result.row.screenshot?.status ?? "none",
  };
  self.log.info(payload, "Desktop action path row persisted");
  self.ctx.waitUntil(postStructuredEventToDd(self.env, payload));
}

type AuthorizedDesktopViewerResult =
  { ok: true; sid: string; viewerUserId: string } | { ok: false; response: Response };

function requireAuthorizedDesktopViewer(self: SessionFetchHost, request: Request): AuthorizedDesktopViewerResult {
  const authorized = requireAuthorizedSession(self, request);
  if (!authorized.ok) return authorized;
  const auth = self.parseAuthHeaders(request);
  if (!auth) return { ok: false, response: jsonErrorResponse("Forbidden: desktop viewer auth required", 403) };
  return { ok: true, sid: authorized.sid, viewerUserId: auth.userId };
}

function desktopTicketFailureResponse(result: { status: number; error: string }): Response {
  return jsonErrorResponse(result.error, result.status);
}

type DesktopTicketOperation = "create" | "heartbeat" | "revoke" | "status" | "connect" | "close";

function desktopTicketFailureCode(error: string): string {
  if (/^[a-z0-9_]{1,64}$/.test(error)) return error;
  switch (error) {
    case "Invalid desktop ticket":
      return "invalid_ticket";
    case "Invalid desktop viewer connection":
      return "invalid_connection";
    case "Desktop viewing ticket not found":
      return "ticket_not_found";
    case "Desktop viewing ticket forbidden":
      return "ticket_forbidden";
    case "Desktop viewing ticket revoked":
      return "ticket_revoked";
    case "Desktop viewing ticket expired":
      return "ticket_expired";
    case "Desktop viewing ticket already connected":
      return "ticket_already_connected";
    case "Too many desktop viewers for this session":
      return "viewer_limit_exceeded";
    case "Desktop viewer connection mismatch":
      return "connection_mismatch";
    default:
      return "ticket_operation_failed";
  }
}

function desktopCloseDiagnosticTelemetryFields(
  diagnostics: DesktopViewTicketCloseDiagnostics | null | undefined,
): Record<string, unknown> {
  if (!diagnostics) return {};
  return {
    phase: diagnostics.phase ?? null,
    diagnosticReason: diagnostics.reason ?? null,
    statusCode: diagnostics.statusCode ?? null,
    durationMs: diagnostics.durationMs ?? null,
    retryable: diagnostics.retryable ?? null,
    sandboxStatus: diagnostics.sandboxStatus ?? null,
    runtimeState: diagnostics.runtimeState ?? null,
    runtimeBackend: diagnostics.runtimeBackend ?? null,
    supervisorExitCode: diagnostics.supervisorExitCode ?? null,
    supervisorHealthStatus: diagnostics.supervisorHealthStatus ?? null,
    supervisorHealthFailedComponent: diagnostics.supervisorHealthFailedComponent ?? null,
    supervisorHealthFailedPhase: diagnostics.supervisorHealthFailedPhase ?? null,
    supervisorHealthLastError: diagnostics.supervisorHealthLastError ?? null,
    supervisorHealthDisplay: diagnostics.supervisorHealthDisplay ?? null,
    supervisorHealthWidth: diagnostics.supervisorHealthWidth ?? null,
    supervisorHealthHeight: diagnostics.supervisorHealthHeight ?? null,
    supervisorHealthScreenshotOk: diagnostics.supervisorHealthScreenshotOk ?? null,
    supervisorHealthScreenshotNonBlackPixelRatio: diagnostics.supervisorHealthScreenshotNonBlackPixelRatio ?? null,
    supervisorHealthScreenshotEntropy: diagnostics.supervisorHealthScreenshotEntropy ?? null,
    supervisorHealthScreenshotUniform: diagnostics.supervisorHealthScreenshotUniform ?? null,
    supervisorHealthVncReachable: diagnostics.supervisorHealthVncReachable ?? null,
    supervisorHealthNovncReachable: diagnostics.supervisorHealthNovncReachable ?? null,
    supervisorHealthLoopbackOnly: diagnostics.supervisorHealthLoopbackOnly ?? null,
    providerErrorCode: diagnostics.providerErrorCode ?? null,
    providerErrorStatus: diagnostics.providerErrorStatus ?? null,
    providerErrorRetryAfterMs: diagnostics.providerErrorRetryAfterMs ?? null,
    providerErrorRequestSent: diagnostics.providerErrorRequestSent ?? null,
    closeSource: diagnostics.websocketCloseSource ?? null,
    websocketCloseSource: diagnostics.websocketCloseSource ?? null,
    websocketCloseCode: diagnostics.websocketCloseCode ?? null,
    websocketCloseReason: diagnostics.websocketCloseReason ?? null,
    websocketCloseWasClean: diagnostics.websocketCloseWasClean ?? null,
    upstreamHostPresent: diagnostics.upstreamHostPresent ?? null,
    trafficAccessTokenPresent: diagnostics.trafficAccessTokenPresent ?? null,
  };
}

async function emitDesktopTicketOperationFailed(
  self: SessionFetchHost,
  params: {
    operation: DesktopTicketOperation;
    sessionId: string;
    viewerUserId: string;
    status: number;
    error: string;
    ticketId?: string | null;
  },
): Promise<void> {
  const payload = {
    event: "desktop.proxy_ticket_operation_failed",
    eventSource: "session_do",
    operation: params.operation,
    statusCode: params.status,
    errorCode: desktopTicketFailureCode(params.error),
    reason: desktopTicketFailureCode(params.error),
    sessionIdHash: await computeSha256Hex(params.sessionId),
    viewerUserIdHash: await computeSha256Hex(params.viewerUserId),
    ticketIdHash: params.ticketId ? await computeSha256Hex(params.ticketId) : null,
  };
  self.log.warn(payload, "Desktop view ticket operation failed");
  self.ctx.waitUntil(postStructuredEventToDd(self.env, payload));
}

type DesktopViewTicketGateResult = { ok: true } | { ok: false; status: 409 | 503; error: string; reason: string };

function gateDesktopViewTicketCreate(
  session: SessionState | null,
  sandbox: doDb.SandboxStateRow | null,
): DesktopViewTicketGateResult {
  if (!session) return { ok: false, status: 409, error: "Desktop session is unavailable", reason: "session_missing" };
  if (session.status === "archived") {
    return {
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the session is archived",
      reason: "session_archived",
    };
  }
  if (!sandbox) return { ok: true };
  if (sandbox.status === "failed") {
    return {
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the sandbox failed",
      reason: "sandbox_failed",
    };
  }
  if (sandbox.status === "stopped") {
    return {
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the sandbox is stopped",
      reason: "sandbox_stopped",
    };
  }
  if (sandbox.runtimeState === "killed") {
    return {
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the runtime was killed",
      reason: "runtime_killed",
    };
  }
  if (sandbox.runtimeState === "paused") {
    return {
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the runtime is paused",
      reason: "runtime_paused",
    };
  }
  return { ok: true };
}

function parseDesktopTicketBody(
  body: Record<string, unknown> | null,
): DesktopViewTicketHeartbeatRequest | DesktopViewTicketRevokeRequest | null {
  const ticketId = body?.ticketId;
  return typeof ticketId === "string" ? { ticketId } : null;
}

function parseDesktopTicketConnectBody(body: Record<string, unknown> | null): DesktopViewTicketConnectRequest | null {
  const ticketId = body?.ticketId;
  const connectionId = body?.connectionId;
  return typeof ticketId === "string" && typeof connectionId === "string" ? { ticketId, connectionId } : null;
}

function parseDesktopTicketCloseBody(body: Record<string, unknown> | null): DesktopViewTicketCloseRequest | null {
  const ticketId = body?.ticketId;
  const connectionId = body?.connectionId;
  const reason = body?.reason;
  const detail = body?.detail;
  const diagnostics = body?.diagnostics;
  return typeof ticketId === "string" && typeof connectionId === "string" && typeof reason === "string"
    ? {
        ticketId,
        connectionId,
        reason,
        detail: typeof detail === "string" ? detail : null,
        diagnostics: diagnostics && typeof diagnostics === "object" ? diagnostics : null,
      }
    : null;
}

async function validateGithubActionAuthRequest(self: SessionFetchHost, request: Request): Promise<SandboxAuthResult> {
  const sessionId = self.resolveSessionId();
  const bearerToken = parseBearerToken(request);
  const sandbox = sessionId ? doDb.getSandboxState(self.sql, sessionId) : null;
  const storedHash = sandbox?.sandboxAuthTokenHash;
  if (!bearerToken || !sessionId || !sandbox || !storedHash) {
    return { ok: false, response: jsonErrorResponse("Unauthorized", 401) };
  }
  const expected = await computeSha256Hex(`${GITHUB_ACTION_AUTH_DERIVATION_PREFIX}${storedHash}`);
  if (!timingSafeEqualString(bearerToken, expected)) {
    return { ok: false, response: jsonErrorResponse("Unauthorized", 401) };
  }
  return { ok: true, sessionId, sandbox };
}

const GithubActionBodySchema = z.object({ argv: z.array(z.string()).max(16) }).strict();
const GITHUB_ACTION_MAX_BODY_BYTES = 16 * 1024;
const GITHUB_ACTION_MAX_ARG_BYTES = 2048;
const GITHUB_ACTION_RATE_LIMIT_KEY = "github-action-rate-limit";

async function handleGithubAction(self: SessionFetchHost, request: Request): Promise<Response> {
  const auth = await validateGithubActionAuthRequest(self, request);
  if (!auth.ok) return auth.response;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > GITHUB_ACTION_MAX_BODY_BYTES) {
    return jsonErrorResponse("Request too large", 413);
  }
  const parsed = await parseBody(request, GithubActionBodySchema);
  if (!parsed.ok) return parsed.response;
  if (parsed.value.argv.some((arg) => new TextEncoder().encode(arg).length > GITHUB_ACTION_MAX_ARG_BYTES)) {
    return jsonErrorResponse("Argument too large", 400);
  }
  const action = (await import("../../../../shared/github-action.js")).parseGithubActionArgv(parsed.value.argv);
  if (!action.ok) return jsonErrorResponse(action.message, 400);

  const now = Date.now();
  const prior = await self.state.storage.get<{ startedAt: number; count: number }>(GITHUB_ACTION_RATE_LIMIT_KEY);
  if (prior && prior.startedAt > now - 60_000 && prior.count >= 6) {
    return jsonErrorResponse("GitHub action rate limit exceeded", 429);
  }
  await self.state.storage.put(GITHUB_ACTION_RATE_LIMIT_KEY, {
    startedAt: prior && prior.startedAt > now - 60_000 ? prior.startedAt : now,
    count: prior && prior.startedAt > now - 60_000 ? prior.count + 1 : 1,
  });

  const operation = action.operation;
  const sessionExt = doDb.getSessionExtended(self.sql, auth.sessionId);
  const owner = sessionExt?.repoOwner;
  const repo = sessionExt?.repoName;
  if (!owner || !repo || (operation.repo && operation.repo.toLowerCase() !== `${owner}/${repo}`.toLowerCase())) {
    return jsonErrorResponse("Operation is limited to the session repository", 403);
  }
  const urlTarget = parsed.value.argv.find((arg) => arg.startsWith("https://github.com/"));
  if (urlTarget) {
    try {
      const targetUrl = new URL(urlTarget);
      const parts = targetUrl.pathname.split("/").filter(Boolean);
      if (
        targetUrl.hostname.toLowerCase() !== "github.com" ||
        parts.length !== 4 ||
        parts[2] !== "pull" ||
        parts[0]?.toLowerCase() !== owner.toLowerCase() ||
        parts[1]?.toLowerCase() !== repo.toLowerCase()
      ) {
        return jsonErrorResponse("Operation is limited to the session repository", 403);
      }
    } catch {
      return jsonErrorResponse("Invalid pull request target", 400);
    }
  }
  const targetUrl = `https://github.com/${owner}/${repo}/pull/${operation.prNumber}`;
  const github = new GithubPrOperations(self.sql, self.env, self.log);
  const target = await github.resolvePrTargetContext(auth.sessionId, targetUrl);
  if (!target.ok) return jsonErrorResponse("Pull request is unavailable", target.reason === "invalid" ? 400 : 404);
  try {
    const current = await github.getPrState(target.context);
    if (current === null) return jsonErrorResponse("Pull request state is unavailable", 502);
    if (operation.kind === "reopen" && current === "merged") {
      return jsonErrorResponse("Merged pull requests cannot be reopened", 400);
    }
    if (operation.kind === "close" && current !== "closed" && current !== "merged")
      await github.closePr(target.context);
    if (operation.kind === "reopen" && current === "closed") await github.reopenPr(target.context);
    if (operation.kind === "edit_title") await github.updatePrTitle(target.context, operation.title);
    const resultingState = await github.getPrState(target.context);
    const title = operation.kind === "edit_title" ? await github.getPrTitle(target.context) : undefined;
    return jsonResponse({
      ok: true,
      operation: operation.kind,
      prNumber: operation.prNumber,
      prUrl: target.context.prUrl,
      state: resultingState,
      ...(title !== undefined ? { title } : {}),
    });
  } catch {
    return jsonErrorResponse("GitHub action failed", 502);
  }
}

export async function handleSessionFetch(host: unknown, request: Request): Promise<Response> {
  const self = host as SessionFetchHost;
  const url = new URL(request.url);

  // Extract requestId from incoming request for correlation
  self.requestId = request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID) || null;
  if (self.requestId) {
    self.log = self.log.child({ requestId: self.requestId });
  }

  const incomingCorrelation = parseCorrelation(request.headers.get(CORRELATION_HEADER));
  // Extract traceparent from incoming request (set by state.ts wrappers)
  const incomingTraceparent = request.headers.get("traceparent");
  const traceInfo = incomingCorrelation
    ? { traceId: incomingCorrelation.traceId, parentSpanId: incomingCorrelation.spanId }
    : extractTraceparent(incomingTraceparent);
  const route = url.pathname;
  const headerSessionId = incomingCorrelation?.sessionId ?? request.headers.get("x-session-id");
  const doSpan = startSpan(`do.${route}`, {
    "do.route": route,
    ...(headerSessionId ? { "session.id": headerSessionId } : {}),
    ...(incomingCorrelation?.promptId ? { "prompt.id": incomingCorrelation.promptId } : {}),
    ...(incomingCorrelation?.sandboxId ? { "sandbox.id": incomingCorrelation.sandboxId } : {}),
    ...(traceInfo ? { "parent.trace_id": traceInfo.traceId } : {}),
  });
  if (traceInfo) {
    doSpan.traceId = traceInfo.traceId;
    doSpan.parentSpanId = traceInfo.parentSpanId;
  }

  return runInSpan(doSpan, async () => {
    let doSpanStatus: "ok" | "error" = "ok";
    let doSpanErrorAttributes: Record<string, string> | undefined;
    try {
      const shouldHydrateSentryUserContextOnEntry = !(
        request.method === "POST" && url.pathname === "/session/initialize"
      );
      if (shouldHydrateSentryUserContextOnEntry) {
        await self.applySentryUserContext(request);
      }
      await self.ensureSocketCachesLoaded();
      if (request.method === "GET" && url.pathname === "/session/state") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;
        const ext = doDb.getSessionExtended(self.sql, sid);
        const sandbox = doDb.getSandboxState(self.sql, sid);
        return jsonResponse({
          ok: true,
          session: await self.buildSessionDoResponse(sid, session, sandbox, ext),
        });
      }

      if (request.method === "GET" && url.pathname === "/session/view") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;
        const hasPromptPaging = url.searchParams.has("promptCursor") || url.searchParams.has("promptLimit");
        const promptLimitRaw = url.searchParams.get("promptLimit");
        const promptLimitParsed = promptLimitRaw === null ? Number.NaN : parseInt(promptLimitRaw, 10);
        return jsonResponse(
          await self.buildSessionViewPayload(
            sid,
            session,
            hasPromptPaging
              ? {
                  promptCursor: url.searchParams.get("promptCursor"),
                  promptLimit: Number.isFinite(promptLimitParsed) ? promptLimitParsed : null,
                }
              : undefined,
          ),
        );
      }

      if (request.method === "GET" && url.pathname === "/session/plan") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const latestPlan = doDb.getLatestSessionPlan(self.sql, authorized.sid);
        if (!latestPlan) return jsonErrorResponse("Plan not found", 404);
        return jsonResponse({
          status: latestPlan.status,
          revision: latestPlan.revision,
          markdown: latestPlan.markdown,
          userEdited: latestPlan.userEdited,
          updatedAt: latestPlan.updatedAt,
          planPromptId: latestPlan.planPromptId,
        });
      }

      if (request.method === "PUT" && url.pathname === "/session/plan") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid } = authorized;
        const body = (await parseJsonBody(request)) as Partial<EditSessionPlanRequest> | null;
        if (
          !body ||
          !Number.isSafeInteger(body.revision) ||
          Number(body.revision) < 0 ||
          typeof body.markdown !== "string" ||
          typeof body.actorUserId !== "string" ||
          body.actorUserId.length === 0 ||
          body.source !== "web"
        ) {
          return jsonErrorResponse("Invalid plan edit payload", 400);
        }
        if (body.markdown.length > PLAN_CAPTURE_MAX_CHARS) {
          return jsonErrorResponse("Plan markdown is too large", 413);
        }
        const markdown = normalizePlanMarkdown(body.markdown);
        if (!markdown) return jsonErrorResponse("Plan markdown must not be empty", 400);

        // DO-local SQLite is single-writer. Keep the latest-row read, state and
        // revision checks, context rebuild, and conditional update synchronous
        // so the edit commits as one critical section with no interleaving await.
        const latest = doDb.getLatestSessionPlan(self.sql, sid);
        if (!latest || latest.status !== "pending") {
          return jsonErrorResponse("Plan is not pending approval", 409);
        }
        if (latest.revision !== body.revision) {
          return jsonErrorResponse("Plan revision is stale", 409);
        }
        const nextRevision = latest.revision + 1;
        const planContext = buildPlanContext({
          markdown,
          artifactId: null,
          missingReason: null,
          planPromptId: latest.planPromptId,
          revision: nextRevision,
          userEdited: true,
          valid: true,
        });
        const saved = doDb.saveEditedPlanRevision(self.sql, {
          sessionId: sid,
          planPromptId: latest.planPromptId,
          markdown,
          excerpt: planContext.excerpt,
          expectedRevision: latest.revision,
        });
        if (!saved) return jsonErrorResponse("Plan revision is stale", 409);

        await self.onPlanApprovalEdited({ sessionId: sid, planPromptId: latest.planPromptId, revision: nextRevision });
        await self.persistAndBroadcastSessionStatus(sid);
        emitPlanModeEvent(
          {
            env: self.env,
            log: self.log,
            waitUntil: (promise) => self.ctx.waitUntil(promise),
          },
          "edited",
          {
            sessionId: sid,
            planPromptId: latest.planPromptId,
            revision: nextRevision,
            actorUserId: body.actorUserId,
            source: body.source,
          },
        );
        return jsonResponse({
          ok: true,
          planApprovalPending: true,
          revision: nextRevision,
          status: "pending",
        });
      }

      if (request.method === "GET" && url.pathname === "/session/desktop/action-path") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        return jsonResponse(await listDesktopActionPathRows(self.state.storage, authorized.sid));
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/action-path/register") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;

        const session = doDb.getSession(self.sql, auth.sessionId);
        if (!session) return jsonErrorResponse("Session not found", 404);

        const parsed = parseDesktopActionPathRegisterRequest(await parseJsonBody(request));
        if (!parsed.ok) return jsonErrorResponse(parsed.error, 400);

        const startedAt = Date.now();
        let result: RegisterDesktopActionPathRowResponse;
        try {
          result = await registerDesktopActionPathRow(self.state.storage, self.sql, auth.sessionId, parsed.row);
        } catch (error) {
          return jsonErrorResponse(error instanceof Error ? error.message : "Invalid desktop action row", 400);
        }
        await emitDesktopActionPathPersistTelemetry(self, auth.sessionId, result, Date.now() - startedAt);
        try {
          self.broadcast({ type: "desktop_action_path_row", row: result.row });
        } catch (error) {
          self.log.warn(
            {
              event: "desktop.action_path_broadcast_failed",
              sessionId: auth.sessionId,
              actionId: result.row.actionId,
              error: String(error),
            },
            "Desktop action path row persisted but broadcast failed",
          );
        }
        return jsonResponse(result);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const gate = gateDesktopViewTicketCreate(
          doDb.getSession(self.sql, viewer.sid),
          doDb.getSandboxState(self.sql, viewer.sid),
        );
        if (!gate.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "create",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            status: gate.status,
            error: gate.reason,
          });
          return jsonErrorResponse(gate.error, gate.status, {
            code: "desktop_view_unavailable",
            reason: gate.reason,
            errorDetails: {
              desktopViewRetryable: false,
              desktopViewReason: gate.reason,
            },
          });
        }
        const result = await createDesktopViewTicket(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          nowMs: Date.now(),
          generateRandomHex,
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "create",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        const ticketIdHash = await computeSha256Hex(result.body.ticket.ticketId);
        const sessionIdHash = await computeSha256Hex(viewer.sid);
        const viewerUserIdHash = await computeSha256Hex(viewer.viewerUserId);
        const payload = {
          event: "desktop.proxy_ticket_create",
          eventSource: "session_do",
          sessionIdHash,
          viewerUserIdHash,
          ticketIdHash,
          expiresAtMs: result.body.ticket.expiresAtMs,
          hardExpiresAtMs: result.body.ticket.hardExpiresAtMs,
        };
        self.log.info(payload, "Desktop view ticket created");
        self.ctx.waitUntil(postStructuredEventToDd(self.env, payload));
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket/heartbeat") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const parsed = parseDesktopTicketBody(await parseJsonBody(request));
        if (!parsed) return jsonErrorResponse("Invalid desktop viewing ticket heartbeat", 400);
        const result = await heartbeatDesktopViewTicket(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          ticketId: parsed.ticketId,
          nowMs: Date.now(),
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "heartbeat",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            ticketId: parsed.ticketId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket/revoke") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const parsed = parseDesktopTicketBody(await parseJsonBody(request));
        if (!parsed) return jsonErrorResponse("Invalid desktop viewing ticket revoke", 400);
        const result = await revokeDesktopViewTicket(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          ticketId: parsed.ticketId,
          nowMs: Date.now(),
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "revoke",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            ticketId: parsed.ticketId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        const ticketIdHash = await computeSha256Hex(parsed.ticketId);
        const sessionIdHash = await computeSha256Hex(viewer.sid);
        const viewerUserIdHash = await computeSha256Hex(viewer.viewerUserId);
        const payload = {
          event: "desktop.proxy_ticket_revoke",
          eventSource: "session_do",
          sessionIdHash,
          viewerUserIdHash,
          ticketIdHash,
          revoked: result.body.revoked,
        };
        self.log.info(payload, "Desktop view ticket revoked");
        self.ctx.waitUntil(postStructuredEventToDd(self.env, payload));
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket/status") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const parsed = parseDesktopTicketBody(await parseJsonBody(request));
        if (!parsed) return jsonErrorResponse("Invalid desktop viewing ticket status", 400);
        const result = await getDesktopViewTicketStatus(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          ticketId: parsed.ticketId,
          nowMs: Date.now(),
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "status",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            ticketId: parsed.ticketId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket/connect") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const parsed = parseDesktopTicketConnectBody(await parseJsonBody(request));
        if (!parsed) return jsonErrorResponse("Invalid desktop viewing ticket connect", 400);
        const result = await connectDesktopViewTicket(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          ticketId: parsed.ticketId,
          connectionId: parsed.connectionId,
          nowMs: Date.now(),
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "connect",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            ticketId: parsed.ticketId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/desktop/view-ticket/close") {
        const viewer = requireAuthorizedDesktopViewer(self, request);
        if (!viewer.ok) return viewer.response;
        const parsed = parseDesktopTicketCloseBody(await parseJsonBody(request));
        if (!parsed) return jsonErrorResponse("Invalid desktop viewing ticket close", 400);
        const result = await closeDesktopViewTicket(self.state.storage, {
          sessionId: viewer.sid,
          viewerUserId: viewer.viewerUserId,
          ticketId: parsed.ticketId,
          connectionId: parsed.connectionId,
          reason: parsed.reason,
          detail: parsed.detail,
          diagnostics: parsed.diagnostics,
          nowMs: Date.now(),
        });
        if (!result.ok) {
          await emitDesktopTicketOperationFailed(self, {
            operation: "close",
            sessionId: viewer.sid,
            viewerUserId: viewer.viewerUserId,
            ticketId: parsed.ticketId,
            status: result.status,
            error: result.error,
          });
          return desktopTicketFailureResponse(result);
        }
        const ticketIdHash = await computeSha256Hex(parsed.ticketId);
        const sessionIdHash = await computeSha256Hex(viewer.sid);
        const viewerUserIdHash = await computeSha256Hex(viewer.viewerUserId);
        const payload = {
          event: "desktop.proxy_close",
          eventSource: "session_do",
          sessionIdHash,
          viewerUserIdHash,
          ticketIdHash,
          connectionId: parsed.connectionId,
          reason: parsed.reason.slice(0, 128),
          detail: parsed.detail ? parsed.detail.slice(0, 256) : null,
          closed: result.body.closed,
          ...desktopCloseDiagnosticTelemetryFields(parsed.diagnostics),
        };
        self.log.info(payload, "Desktop view ticket connection closed");
        self.ctx.waitUntil(postStructuredEventToDd(self.env, payload));
        return jsonResponse(result.body);
      }

      if (request.method === "POST" && url.pathname === "/session/broadcast-snapshot") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        await self.broadcastSessionSnapshot(sid);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/session/initialize") {
        const payload = (await parseJsonBody(request)) as Partial<InitializeSessionRequest> | null;
        if (!payload || !payload.sessionId || !payload.ownerUserId) {
          return jsonErrorResponse("Invalid payload", 400);
        }
        let initialRuntimeBackend: RuntimeBackend | null = null;
        if (payload.runtimeBackend !== undefined && payload.runtimeBackend !== null) {
          try {
            initialRuntimeBackend = parsePersistedRuntimeBackend(payload.runtimeBackend);
          } catch {
            return jsonErrorResponse("Invalid runtimeBackend", 400);
          }
        }
        let resolvedAgentRuntimeBackend: ReturnType<typeof resolveAgentRuntimeBackend>;
        try {
          resolvedAgentRuntimeBackend = resolveAgentRuntimeBackend(
            payload.agentRuntimeBackend == null ? undefined : String(payload.agentRuntimeBackend),
          );
        } catch {
          return jsonErrorResponse("Invalid agentRuntimeBackend", 400);
        }
        await self.applySentryUserContext(request, String(payload.ownerUserId));

        const sessionId = payload.sessionId as string;
        const existing = doDb.getSession(self.sql, sessionId);
        if (existing) {
          const existingReplay = await self.getReplayState(sessionId);
          return jsonResponse({
            ok: true,
            session: existing,
            replay: existingReplay,
          } satisfies InitializeSessionResponse);
        }

        // Resolve agent configuration
        let resolvedAgents: Record<string, AgentConfig>;
        try {
          resolvedAgents = resolveAgents(
            BUILTIN_AGENTS,
            payload.agentOverrides as Record<string, Partial<AgentConfig>> | undefined,
          );
        } catch (error) {
          if (error instanceof AgentConfigError) {
            self.log.warn(
              {
                event: "agent_config.rejected",
                code: error.code,
                sessionId,
                reason: error.message,
              },
              "Rejected agent overrides",
            );
            return jsonErrorResponse(error.message, 400, { code: error.code });
          }
          throw error;
        }

        try {
          // Production creation surfaces provide an explicit entrypoint through
          // createSessionState. Keep the internal DO endpoint compatible with
          // older callers and persisted retry payloads from before provenance
          // was introduced.
          const initiationMode = parseInitiationMode(payload.initiationMode);
          const scheduledRuleId = payload.scheduledRuleId == null ? null : String(payload.scheduledRuleId);
          const entrypoint =
            parseSessionEntrypoint(payload.entrypoint) ??
            (initiationMode === InitiationMode.AUTOMATION && scheduledRuleId
              ? SessionEntrypoint.SCHEDULED
              : SessionEntrypoint.API);
          const session = doDb.createSession(self.sql, {
            sessionId,
            ownerUserId: String(payload.ownerUserId),
            businessId: payload.businessId == null ? null : String(payload.businessId),
            model: payload.model ? String(payload.model) : undefined,
            reasoningEffort: payload.reasoningEffort ? String(payload.reasoningEffort) : undefined,
            agentRuntimeBackend: resolvedAgentRuntimeBackend,
            repoOwner: payload.repoOwner ? String(payload.repoOwner) : undefined,
            repoName: payload.repoName ? String(payload.repoName) : undefined,
            baseBranch: payload.baseBranch ? String(payload.baseBranch) : undefined,
            startBranch: payload.startBranch ? String(payload.startBranch) : undefined,
            prUrl: payload.prUrl == null ? null : String(payload.prUrl),
            prNumber:
              typeof payload.prNumber === "number" && Number.isInteger(payload.prNumber) ? payload.prNumber : undefined,
            installationId: payload.installationId ? Number(payload.installationId) : undefined,
            callbackContext: payload.callbackContext as CallbackContext | undefined,
            linearContext: payload.linearContext as LinearContext | undefined,
            githubIssueContext: payload.githubIssueContext as GithubIssueContext | undefined,
            resolvedAgents,
            // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
            agentRole:
              isQaTesterAgentRole(payload.agentRole) ||
              isCodeReviewerAgentRole(payload.agentRole) ||
              payload.agentRole === "implementation"
                ? payload.agentRole
                : undefined,
            agentProfile: payload.agentProfile ? String(payload.agentProfile) : undefined,
            harnessKind:
              payload.harnessKind === "codex-session" || payload.harnessKind === "claude-session"
                ? payload.harnessKind
                : undefined,
            runtimeStartupProfile:
              payload.runtimeStartupProfile === "verification_ready_runtime" ||
              payload.runtimeStartupProfile === "implementation_default"
                ? payload.runtimeStartupProfile
                : undefined,
            verificationRuntimeMode:
              payload.verificationRuntimeMode === "none" || payload.verificationRuntimeMode === "app_runtime"
                ? payload.verificationRuntimeMode
                : undefined,
            targetPrUrl: payload.targetPrUrl == null ? null : String(payload.targetPrUrl),
            autoVerifyDisabled: payload.autoVerify === false,
            planMode: payload.planMode === true,
            planApprovalRequired: payload.planApprovalRequired === true,
            planAutoReason: payload.planAutoReason == null ? null : String(payload.planAutoReason),
            adoptedExternalPr: payload.adoptedExternalPr === true,
            initiationMode,
            entrypoint,
            scheduledRuleId,
            ruleNameSnapshot: payload.ruleNameSnapshot == null ? null : String(payload.ruleNameSnapshot),
            cronSnapshot: payload.cronSnapshot == null ? null : String(payload.cronSnapshot),
          });

          // Initialize sandbox_state row
          doDb.ensureSandboxState(self.sql, sessionId);
          if (initialRuntimeBackend) {
            applyRuntimePatch({ sql: self.sql, sessionId, patch: { runtimeBackend: initialRuntimeBackend } });
          }

          // Keep ephemeral keys in KV
          const runtimePreviewOverride =
            payload.runtimePreviewContract && typeof payload.runtimePreviewContract === "object"
              ? coerceRuntimePreviewOverride({
                  previewContract: payload.runtimePreviewContract,
                  source: payload.runtimePreviewSource ?? "onboarding",
                  diagnostics: Array.isArray(payload.runtimePreviewDiagnostics)
                    ? payload.runtimePreviewDiagnostics
                    : [],
                })
              : null;
          await self.state.storage.put({
            sandbox_connection_gen: 0,
            [USE_OPENAI_FLEX_SERVICE_TIER_STORAGE_KEY]: payload.useOpenAIFlexServiceTier === true,
            ...(runtimePreviewOverride ? { [RUNTIME_PREVIEW_OVERRIDE_STORAGE_KEY]: runtimePreviewOverride } : {}),
          });

          self._sessionId = sessionId;

          const replay = await self.getReplayState(sessionId);
          return jsonResponse({ ok: true, session, replay } satisfies InitializeSessionResponse);
        } catch (err) {
          self.log.error({ sessionId, error: serializeError(err) }, "Session initialization failed");
          Sentry.captureException(err, { tags: { operation: "session.init", sessionId } });
          return jsonErrorResponse(`Session initialization failed: storage write error`, 500);
        }
      }

      if (request.method === "PUT" && url.pathname === "/session/callback-context") {
        const sid = self.resolveSessionId();
        const payload = (await parseJsonBody(request)) as Partial<UpdateSessionCallbackContextRequest> | null;
        if (sid && payload && typeof payload === "object") {
          const existingContext = doDb.getSessionExtended(self.sql, sid)?.callbackContext;
          doDb.updateSessionFields(self.sql, sid, {
            callbackContext: mergeCallbackContextUpdate(existingContext, payload as unknown as CallbackContext),
          });
        }
        return jsonResponse({ ok: true } satisfies UpdateSessionCallbackContextResponse);
      }

      if (request.method === "PUT" && url.pathname === "/session/repo") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<SetSessionRepoRequest> | null;
        if (!payload?.repoOwner || !payload?.repoName) {
          return jsonErrorResponse("Missing repoOwner/repoName", 400);
        }
        const repoOwner = String(payload.repoOwner);
        const repoName = String(payload.repoName);
        const ext = doDb.getSessionExtended(self.sql, sid);
        const repoChanged = ext?.repoOwner !== repoOwner || ext?.repoName !== repoName;
        const nextBaseBranch = payload.baseBranch ? String(payload.baseBranch) : (ext?.baseBranch ?? null);
        const baseBranchChanged = nextBaseBranch !== (ext?.baseBranch ?? null);
        const nextInstallationId =
          payload.installationId != null ? Number(payload.installationId) : (ext?.installationId ?? null);
        const fields: Partial<doDb.SessionExtendedFields> = {
          repoOwner,
          repoName,
        };
        if (payload.baseBranch) fields.baseBranch = nextBaseBranch;
        if (payload.installationId != null) fields.installationId = nextInstallationId;
        if (repoChanged) fields.repoPrivate = null;
        if (repoChanged || baseBranchChanged) {
          fields.agentSessionId = null;
          fields.agentSessionAgent = null;
          const reasons: string[] = [];
          if (repoChanged) {
            reasons.push(
              `repo changed from ${ext?.repoOwner ?? "unknown"}/${ext?.repoName ?? "unknown"} to ${repoOwner}/${repoName}`,
            );
          }
          if (baseBranchChanged) {
            reasons.push(`base branch changed from ${ext?.baseBranch ?? "unset"} to ${nextBaseBranch ?? "unset"}`);
          }
          await self.invalidateSessionSnapshot(sid, `Snapshot invalidated: ${reasons.join("; ")}`);
        }
        const db = (self.env as Env).DB;
        if (db) {
          await syncSessionProjection({
            db,
            sessionId: sid,
            session: {
              ...session,
              repoOwner,
              repoName,
              installationId: nextInstallationId,
            },
            logger: self.log,
            requestId: self.requestId,
            source: "durable-object.repo.update",
          });
        }
        doDb.updateSessionFields(self.sql, sid, fields);
        return jsonResponse({ ok: true } satisfies SetSessionRepoResponse);
      }

      if (request.method === "POST" && url.pathname === "/session/notify-pr-merged") {
        return self.prWorkflow.handleNotifyPrMergedRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/notify-pr-closed") {
        return self.prWorkflow.handleNotifyPrClosedRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/review-listening/head") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<{
          prUrl: string;
          currentHeadSha: string;
        }> | null;
        const prUrl = asNonEmptyString(payload?.prUrl);
        const currentHeadSha = asNonEmptyString(payload?.currentHeadSha);
        if (!prUrl || !currentHeadSha) return jsonErrorResponse("Invalid review listening head update", 400);
        const ext = doDb.getSessionExtended(self.sql, sid);
        if (session.status === "archived") return jsonResponse({ ok: true, updated: false, reason: "archived" });
        if (!ext?.reviewListeningActive) {
          return jsonResponse({ ok: true, updated: false, reason: "not_review_listening" });
        }
        if (ext.reviewListeningPrUrl !== prUrl) {
          return jsonResponse({ ok: true, updated: false, reason: "pr_mismatch" });
        }
        if (ext.reviewListeningHeadSha === currentHeadSha) {
          return jsonResponse({ ok: true, updated: false, reason: "unchanged" });
        }
        await self.processLifecycleEvent(sid, {
          type: "review_listening.epoch_enqueued",
          prUrl,
          currentHeadSha,
        });
        return jsonResponse({ ok: true, updated: true });
      }

      if (request.method === "POST" && url.pathname === "/session/pr-draft") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<{
          prUrl: string;
          draft: boolean;
          manualReviewReason?: string | null;
        }> | null;
        const prUrl = normalizeWebhookReference(payload?.prUrl);
        if (!prUrl || typeof payload?.draft !== "boolean") {
          return jsonErrorResponse("Invalid PR draft update", 400);
        }

        const ext = doDb.getSessionExtended(self.sql, sid);
        const currentPrUrl = normalizeWebhookReference(ext?.prUrl);
        if (!currentPrUrl) return jsonResponse({ ok: true, updated: false, reason: "no_pr" });
        if (currentPrUrl !== prUrl) return jsonResponse({ ok: true, updated: false, reason: "pr_mismatch" });

        const manualReviewReason =
          payload.draft && typeof payload.manualReviewReason === "string" ? payload.manualReviewReason.trim() : "";
        const nextManualReviewReason = manualReviewReason || null;
        if (ext?.prDraft === payload.draft && (ext.prManualReviewReason ?? null) === nextManualReviewReason) {
          return jsonResponse({ ok: true, updated: false, reason: "unchanged" });
        }

        const branchName = ext?.publishedBranch ?? ext?.lastBranch ?? "";
        doDb.updateSessionFields(self.sql, sid, {
          prDraft: payload.draft,
          prManualReviewReason: nextManualReviewReason,
        });
        if (self.env.DB) {
          // Scope by (session_id, pr_url): toggle only this PR's draft flag,
          // never rewrite another completion's pr_url in a multi-PR session.
          await updateCompletionDraftForPr(self.env.DB, sid, currentPrUrl, payload.draft);
        }

        const eventData = {
          sessionId: sid,
          prUrl: currentPrUrl,
          prNumber: ext?.prNumber ?? 0,
          branchName,
          ...(payload.draft ? { draft: true } : {}),
          ...(nextManualReviewReason ? { manualReviewReason: nextManualReviewReason } : {}),
        };
        self.broadcast({
          type: "pr_updated",
          prUrl: currentPrUrl,
          prNumber: ext?.prNumber ?? 0,
          branchName,
          ...(payload.draft ? { draft: true } : {}),
          ...(nextManualReviewReason ? { manualReviewReason: nextManualReviewReason } : {}),
        });
        await self.appendAndBroadcastEvents(sid, [
          {
            type: "publish.pr.updated",
            timestamp: nowIso(),
            data: eventData,
          },
          {
            type: "pr_updated",
            timestamp: nowIso(),
            data: eventData,
          },
        ]);

        return jsonResponse({ ok: true, updated: true });
      }

      if (request.method === "POST" && url.pathname === "/session/verification/state") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<{
          requestId: string;
          state: VerificationState | null;
          attemptCount: number;
          maxAttempts: number;
          allowExhaustedClear: boolean;
          runBaseline: number;
          verdictHeadSha: string | null;
        }> | null;
        const requestId = asNonEmptyString(payload?.requestId);
        if (!requestId) return jsonErrorResponse("Invalid verification state update", 400);
        const state = doDb.verificationStateOrNull(payload?.state);
        const attemptCount = normalizeVerificationAttemptCount(payload?.attemptCount);
        const maxAttempts = normalizeVerificationMaxAttempts(payload?.maxAttempts);
        const allowExhaustedClear = payload?.allowExhaustedClear === true;
        // Legacy per-head budget baseline. The active run-limit gate is PR-scoped and ignores it, but
        // the field remains accepted for stored session compatibility.
        const runBaselineProvided =
          typeof payload?.runBaseline === "number" && Number.isInteger(payload.runBaseline) && payload.runBaseline >= 0;
        // Optional verdict-head stamp (ARC-1243 follow-up): a content no-op head advance preserves
        // the verdict and stamps the new head here, so the scheduler can positively identify the
        // no-op. Written independently of the state-preserve decision, and only when the key is
        // present (so ordinary state writes never clear it). `null` explicitly clears it.
        const verdictHeadShaProvided =
          payload != null && Object.prototype.hasOwnProperty.call(payload, "verdictHeadSha");
        const nextVerdictHeadSha =
          typeof payload?.verdictHeadSha === "string" && payload.verdictHeadSha.length > 0
            ? payload.verdictHeadSha
            : null;
        const ext = doDb.getSessionExtended(self.sql, sid);
        const currentState = ext?.verificationState ?? null;
        const currentAttemptCount = ext?.verificationAttemptCount ?? 0;
        const currentMaxAttempts = ext?.verificationMaxAttempts ?? MAX_VERIFICATION_RUNS_PER_PR;
        const currentRunBaseline = ext?.verificationRunBaseline ?? 0;
        const currentVerdictHeadSha = ext?.verificationVerdictHeadSha ?? null;
        const preserveCurrent = shouldPreserveVerificationState(currentState, state, { allowExhaustedClear });
        const nextState = preserveCurrent ? currentState : state;
        const nextAttemptCount = preserveCurrent ? currentAttemptCount : attemptCount;
        const nextMaxAttempts = preserveCurrent ? currentMaxAttempts : maxAttempts;
        const nextRunBaseline = runBaselineProvided ? (payload!.runBaseline as number) : currentRunBaseline;
        const effectiveVerdictHeadSha = verdictHeadShaProvided ? nextVerdictHeadSha : currentVerdictHeadSha;
        if (
          currentState === nextState &&
          currentAttemptCount === nextAttemptCount &&
          currentMaxAttempts === nextMaxAttempts &&
          currentRunBaseline === nextRunBaseline &&
          currentVerdictHeadSha === effectiveVerdictHeadSha
        ) {
          // ARC-1330 D-59c: nothing changed in the DO-SQLite verification axis; the cycloid_done aggregate
          // is FSM-owned (`project()`) and no longer recomputed here.
          return jsonResponse({ ok: true, updated: false });
        }
        doDb.updateSessionFields(self.sql, sid, {
          verificationState: nextState,
          verificationAttemptCount: nextAttemptCount,
          verificationMaxAttempts: nextMaxAttempts,
          ...(runBaselineProvided ? { verificationRunBaseline: nextRunBaseline } : {}),
          ...(verdictHeadShaProvided ? { verificationVerdictHeadSha: nextVerdictHeadSha } : {}),
        });
        // ARC-1330 D-59c: the D1 `qa_testing_state` mirror + the cycloid_done aggregate are written by
        // `project()` from the spine; the DO keeps its own SQLite copy (read by scheduler suppression /
        // effective-verification) and broadcasts the change so the UI refreshes (cycloid_done re-projected
        // from the spine on the next snapshot build).
        await self.broadcastSessionSnapshot(sid);
        return jsonResponse({ ok: true, updated: true });
      }

      if (request.method === "POST" && url.pathname === "/session/verification/result") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<{
          requestId: string;
          result: VerificationResult | null;
          needsWorkLabel: import("../../../../shared/types/sandbox.js").VerificationNeedsWorkLabel | null;
          qaRun: unknown;
        }> | null;
        const requestId = asNonEmptyString(payload?.requestId);
        if (!requestId) return jsonErrorResponse("Invalid verification result update", 400);
        const result = doDb.verificationResultOrNull(payload?.result);
        const needsWorkLabel =
          result === "needs-work" ? doDb.verificationNeedsWorkLabelOrNull(payload?.needsWorkLabel) : null;
        const currentQaRun =
          normalizeQaRunTerminalSummary(await self.state.storage.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY)) ?? null;
        const qaRunProvided =
          payload != null && Object.prototype.hasOwnProperty.call(payload as Record<string, unknown>, "qaRun");
        const nextQaRun = result ? (qaRunProvided ? normalizeQaRunTerminalSummary(payload.qaRun) : currentQaRun) : null;
        const ext = doDb.getSessionExtended(self.sql, sid);
        const currentResult = ext?.verificationResult ?? null;
        const currentNeedsWorkLabel = ext?.verificationNeedsWorkLabel ?? null;
        const qaRunUnchanged = JSON.stringify(currentQaRun) === JSON.stringify(nextQaRun);
        if (currentResult === result && currentNeedsWorkLabel === needsWorkLabel && qaRunUnchanged) {
          // ARC-1330 D-59c: no DO-SQLite change; the cycloid_done aggregate is FSM-owned, not recomputed here.
          return jsonResponse({ ok: true, updated: false });
        }
        doDb.updateSessionFields(self.sql, sid, {
          verificationResult: result,
          verificationNeedsWorkLabel: needsWorkLabel,
        });
        if (nextQaRun) {
          await self.state.storage.put(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY, nextQaRun);
        } else if (currentQaRun) {
          await self.state.storage.delete(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY);
        }
        // ARC-1330 D-59c: cycloid_done is projected from the spine; the DO keeps the SQLite copy + broadcasts.
        await self.broadcastSessionSnapshot(sid);
        return jsonResponse({ ok: true, updated: true });
      }

      if (request.method === "POST" && url.pathname === "/session/review-listening/enter") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<{
          prUrl: string;
          currentHeadSha: string;
        }> | null;
        const prUrl = asNonEmptyString(payload?.prUrl);
        const currentHeadSha = asNonEmptyString(payload?.currentHeadSha);
        if (!prUrl || !currentHeadSha) return jsonErrorResponse("Invalid review listening enter request", 400);
        if (session.status === "archived") return jsonResponse({ ok: true, updated: false, reason: "archived" });
        await self.processLifecycleEvent(sid, {
          type: "review_listening.entered",
          prUrl,
          currentHeadSha,
        });
        return jsonResponse({ ok: true, updated: true });
      }

      if (request.method === "POST" && url.pathname === "/session/close") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        const payload = (await parseJsonBody(request)) as Partial<CloseSessionRequest> | null;
        const reason = asNonEmptyString(payload?.reason);
        if (!reason) return jsonErrorResponse("Missing close reason", 400);
        const closeMetadata =
          payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : undefined;

        let replay: ReplayState;
        if (session.status !== "archived") {
          replay = await self.closeSessionAtDurabilityBoundary(session, reason, closeMetadata);
        } else {
          replay = await self.getReplayState(sid);
        }

        return jsonResponse({ ok: true, session, replay });
      }

      if (request.method === "GET" && url.pathname === "/session/sandbox-state") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid } = authorized;
        const sandboxState = doDb.getSandboxState(self.sql, sid);
        const deadlineSnapshot = await self.state.storage.get([
          LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
          LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
          LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
          LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
          LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
          LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
        ]);
        const spawnColdStart = (await self.state.storage.get<boolean>("spawn_cold_start")) ?? null;
        return jsonResponse({
          ok: true,
          sandboxState: sandboxState
            ? {
                sandboxId: sandboxState.sandboxId,
                modalObjectId: sandboxState.modalObjectId,
                status: sandboxState.status,
                spawnRetryCount: sandboxState.spawnRetryCount,
                spawnStartedAt: sandboxState.spawnStartedAt,
                spawnColdStart,
                lastHeartbeatAt: sandboxState.lastHeartbeatAt,
                lastActivityAt: sandboxState.lastActivityAt,
                intentionalPauseReason: sandboxState.intentionalPauseReason,
                bridgeProtocolVersion: sandboxState.bridgeProtocolVersion,
                runtimeProvider: sandboxState.runtimeProvider,
                runtimeState: sandboxState.runtimeState,
                runtimeSandboxId: sandboxState.runtimeSandboxId,
                runtimeTemplateId: sandboxState.runtimeTemplateId,
                runtimeStateExpiresAt: sandboxState.runtimeStateExpiresAt,
                runtimeLiveLeaseExpiresAt: sandboxState.runtimeLiveLeaseExpiresAt,
                runtimePreviewUrl: sandboxState.runtimePreviewUrl,
                runtimeCreatedAt: sandboxState.runtimeCreatedAt,
                runtimeLastResumedAt: sandboxState.runtimeLastResumedAt,
                runtimeLastPausedAt: sandboxState.runtimeLastPausedAt,
                runtimeLastProviderRefreshedAt: sandboxState.runtimeLastProviderRefreshedAt,
                runtimeProviderTtlExpiresAt: sandboxState.runtimeProviderTtlExpiresAt,
                snapshotImageId: sandboxState.snapshotImageId,
                snapshotBranch: sandboxState.snapshotBranch,
                snapshotHeadSha: sandboxState.snapshotHeadSha,
                snapshotCreatedAt: sandboxState.snapshotCreatedAt,
                snapshotCredentialEnvKeys: sandboxState.snapshotCredentialEnvKeys,
                snapshotModalEnvironment: sandboxState.snapshotModalEnvironment,
                snapshotSandboxImageVersion: sandboxState.snapshotSandboxImageVersion,
                snapshotDockerEnabled: sandboxState.snapshotDockerEnabled,
                lastSnapshotError: sandboxState.lastSnapshotError,
              }
            : null,
          deadlines: {
            sandboxReconnectGraceDeadline:
              (deadlineSnapshot.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY) as number | undefined) ??
              null,
            sandboxLivenessDeadline:
              (deadlineSnapshot.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY) as number | undefined) ?? null,
            promptStartupDeadline:
              (deadlineSnapshot.get(LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY) as number | undefined) ?? null,
            promptDispatchDeadline:
              (deadlineSnapshot.get(LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY) as number | undefined) ?? null,
            promptRunningInactivityDeadline:
              (deadlineSnapshot.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY) as number | undefined) ??
              null,
            spawnTimeoutDeadline:
              (deadlineSnapshot.get(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY) as number | undefined) ?? null,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/session/artifacts/list") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;
        // Carry the session identity (built the same way as /session/state via
        // buildSessionDoResponse) so the worker can authorize in this single hop
        // instead of a prior getSessionState call. checkAccess above stays as
        // non-redacting defense-in-depth; the worker remains the authoritative boundary.
        const ext = doDb.getSessionExtended(self.sql, sid);
        const sandbox = doDb.getSandboxState(self.sql, sid);
        const sessionResponse = await self.buildSessionDoResponse(sid, session, sandbox, ext);
        const artifacts = doDb.listSessionArtifacts(self.sql, sid);
        return jsonResponse({ ok: true, artifacts, session: sessionResponse });
      }

      if (request.method === "GET" && url.pathname === "/session/replay") {
        const sid = self.resolveSessionId();
        if (!sid) {
          return jsonResponse({
            ok: true,
            replay: { sessionId: null, lastEventSequence: 0, lastEventTimestamp: null, updatedAt: null },
          });
        }
        const replay = await self.getReplayState(sid);
        return jsonResponse({ ok: true, replay });
      }

      if (request.method === "GET" && url.pathname === "/session/events") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;

        const afterSequence = parseNonNegativeInteger(url.searchParams.get("afterSequence"), 0);
        const limit = Math.min(parseNonNegativeInteger(url.searchParams.get("limit"), 200) || 200, 1000);
        const filtered = doDb.getEvents(self.sql, sid, { afterSequence, limit });
        const replay = await self.getReplayState(sid);
        const ext = doDb.getSessionExtended(self.sql, sid);
        const sandbox = doDb.getSandboxState(self.sql, sid);
        const activePromptId = doDb.getActiveProcessingPromptId(self.sql, sid);
        const sandboxStatus = sandbox?.status;
        const { activePromptHasPendingQuestion, postExecutionPending, mostRecentPromptResultNoChanges } =
          getRichStatusProjectionInputs(self.sql, sid, activePromptId);
        const eventsPublishStatus = ext?.publishStatus ?? "not_started";
        // Route through getSessionStatusForResponse so /session/events emits the
        // same phase string as /session/state and the WS subscribed snapshot.
        const sessionStatus = getSessionStatusForResponse(
          session,
          sandboxStatus,
          activePromptId,
          eventsPublishStatus,
          postExecutionPending,
          mostRecentPromptResultNoChanges,
          sandbox?.stopReason ?? null,
          activePromptHasPendingQuestion,
          ext?.reviewListeningActive ?? false,
          Boolean(self.userStopped),
        );
        const eventsPhaseInfo = derivePhaseInfo(session, {
          sandboxStatus,
          activePromptId,
          stopReason: sandbox?.stopReason ?? null,
          activePromptHasPendingQuestion,
          userStopped: Boolean(self.userStopped),
          publishStatus: eventsPublishStatus,
          postExecutionPending,
          mostRecentPromptResultNoChanges,
          reviewListeningActive: ext?.reviewListeningActive ?? false,
        });
        return jsonResponse({
          ok: true,
          events: filtered,
          replay,
          sessionStatus,
          ...phaseFieldsFromInfo(eventsPhaseInfo),
          sessionKind: ext?.sessionKind ?? null,
          title: session.title ?? null,
          spawnDurationMs: ext?.spawnDurationMs ?? null,
        });
      }

      // Future helper boundary: session/ws-manager.ts owns WebSocket accept/handshake logic.
      if (request.method === "GET" && url.pathname === "/session/ws") {
        const sid = self.resolveSessionId();
        const session = sid ? doDb.getSession(self.sql, sid) : null;
        if (!sid || !session) {
          return jsonErrorResponse("Session not found", 404);
        }
        const sessionId = sid;

        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return jsonErrorResponse("Expected websocket upgrade request", 426);
        }

        const isSandbox = url.searchParams.get("type") === "sandbox";

        if (isSandbox) {
          const auth = await self.validateSandboxAuthRequest(request);
          if (!auth.ok) return auth.response;
          const requestedSessionId = url.searchParams.get("sessionId");
          if (requestedSessionId !== sessionId) {
            const response = await self.recordSandboxAuthFailure(
              request,
              sessionId,
              "missing_or_mismatched_session_id",
            );
            if (response) return response;
            return jsonErrorResponse("Invalid sandbox auth exchange", 403);
          }

          const requestedSandboxId = request.headers.get("x-sandbox-id") || url.searchParams.get("sandboxId") || null;
          if (!requestedSandboxId) {
            const response = await self.recordSandboxAuthFailure(request, sessionId, "missing_sandbox_id");
            if (response) return response;
            return jsonErrorResponse("Missing sandbox id", 401);
          }
          const sandboxId = requestedSandboxId;

          if (auth.sandbox.sandboxId && auth.sandbox.sandboxId !== sandboxId) {
            const response = await self.recordSandboxAuthFailure(request, sessionId, "sandbox_id_mismatch");
            if (response) return response;
            return jsonErrorResponse("Invalid sandbox id", 403);
          }

          const bearerToken = parseBearerToken(request);
          if (!bearerToken) return jsonErrorResponse("Missing sandbox auth token", 401);
          const tokenHash = await computeSha256Hex(bearerToken);
          const consumedKey = sandboxOneTimeAuthStorageKey(sessionId, sandboxId, tokenHash);
          const hasOpenSandboxSocket = Boolean(self.getSandboxSocket());
          const alreadyConsumed = await self.state.storage.transaction(async (txn: DurableObjectTransaction) => {
            const consumedRecord = await txn.get<SandboxOneTimeAuthRecord>(consumedKey);
            if (consumedRecord !== undefined) {
              if (shouldAllowUnconfirmedSandboxAuthReplay(consumedRecord, hasOpenSandboxSocket)) {
                await txn.put(consumedKey, {
                  consumedAt: typeof consumedRecord === "number" ? consumedRecord : consumedRecord.consumedAt,
                  lastAllowedReplayAt: Date.now(),
                });
                return false;
              }
              return true;
            }
            await txn.put(consumedKey, { consumedAt: Date.now() });
            return false;
          });
          if (alreadyConsumed) {
            const response = await self.recordSandboxAuthFailure(request, sessionId, "token_replay");
            if (response) return response;
            return jsonErrorResponse("Sandbox auth token already exchanged", 403);
          }
          const consumedEntries = await self.state.storage.list({
            prefix: sandboxOneTimeAuthStoragePrefix(sessionId, sandboxId),
          });
          const staleConsumedKeys = [...consumedEntries.keys()].filter((key) => key !== consumedKey);
          if (staleConsumedKeys.length > 0) await self.state.storage.delete(staleConsumedKeys);
          await self.state.storage.put(sandboxPendingOneTimeAuthStorageKey(sessionId, sandboxId), consumedKey);

          if (typeof WebSocketPair === "undefined") {
            return jsonErrorResponse("WebSocketPair is not available in this runtime", 501);
          }
          return self.wsManager.handleSandboxWebSocket(request, session);
        }

        const auth = self.parseAuthHeaders(request);
        if (!auth || !self.checkAccess(auth, session)) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (typeof WebSocketPair === "undefined") {
          return jsonErrorResponse("WebSocketPair is not available in this runtime", 501);
        }

        return self.wsManager.handleClientWebSocket(request, url, session);
      }

      if (request.method === "GET" && url.pathname === "/session/prompts") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;

        const activePromptId = doDb.getActiveProcessingPromptId(self.sql, sid);
        return jsonResponse({ ok: true, ...(await self.buildPromptListPayload(sid, session, activePromptId)) });
      }

      // Future helper boundary: session/prompt-queue.ts owns prompt enqueue/callback/stop/respond/retry flows.
      if (request.method === "POST" && url.pathname === "/session/prompts/enqueue") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        return self.promptQueue.handlePromptEnqueueRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/prompts/callback") {
        return self.promptQueue.handlePromptCallbackRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/plan/approve") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        return self.promptQueue.handlePlanApproveRequest(request);
      }

      // Stop: send stop command to sandbox and clear queued prompts
      if (request.method === "POST" && url.pathname === "/session/stop") {
        return self.promptQueue.handleStopRequest();
      }

      // Respond: send answer to sandbox question
      if (request.method === "POST" && url.pathname === "/session/respond") {
        return self.promptQueue.handleRespondRequest(request);
      }

      // Usage: compute the session usage summary from per-prompt snapshots on demand.
      if (request.method === "GET" && url.pathname === "/session/usage") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);

        const promptUsage = doDb.getPromptUsage(self.sql, sid);
        const cached = doDb.computeUsageCache(promptUsage);
        if (cached.promptCount === 0) return jsonResponse({ ok: true, usage: null });

        return jsonResponse({ ok: true, usage: cached });
      }

      if (request.method === "GET" && url.pathname === "/session/input-composition") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);

        const inputComposition = doDb.getPromptTokenAttribution(self.sql, sid);
        if (Object.keys(inputComposition).length === 0) {
          return jsonResponse({ ok: true, inputComposition: null });
        }

        return jsonResponse({ ok: true, inputComposition });
      }

      // Warm: resume a paused sandbox, or preserve composer-input's existing
      // best-effort cold-start behavior when no paused runtime exists.
      if (request.method === "POST" && url.pathname === "/session/warm") {
        const trigger = parseWarmTrigger(url.searchParams.get("trigger"));
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        if (session.status === "archived") {
          return jsonErrorResponse("Session is archived", 409);
        }
        const sandbox = doDb.getSandboxState(self.sql, sid);
        if (self.getSandboxSocket()) {
          emitWarmTriggerEvent(self, sid, trigger, "noop_live", sandbox);
          return jsonResponse({ ok: true, status: "already_connected" }, 200);
        }
        const sandboxStatus = sandbox?.status;
        if (sandboxStatus === "spawning") {
          emitWarmTriggerEvent(self, sid, trigger, "noop_inflight", sandbox);
          return jsonResponse({ ok: true, status: "already_spawning" }, 200);
        }
        if (sandboxStatus === "ready") {
          emitWarmTriggerEvent(self, sid, trigger, "noop_inflight", sandbox);
          return jsonResponse({ ok: true, status: "already_ready" }, 200);
        }
        if (sandboxStatus === "reconnecting") {
          // The socket was already ruled out above. A genuine in-flight reconnect
          // (unexpired grace) is worth waiting on; a dead reconnecting row (killed,
          // or grace lapsed) must spawn fresh — same dead-reconnecting decision the
          // admit path uses, so /session/warm cannot preserve the wedge this PR fixes.
          const reconnectGraceDeadlineMs = await self.getSandboxReconnectGraceDeadlineMs();
          const spawnDeadRuntime = shouldStartSpawnForAdmit({
            sandboxStatus,
            hasLiveSocket: false,
            reconnectGraceDeadlineMs,
            nowMs: Date.now(),
          });
          if (!spawnDeadRuntime) {
            emitWarmTriggerEvent(self, sid, trigger, "noop_inflight", sandbox);
            return jsonResponse({ ok: true, status: "already_reconnecting" }, 200);
          }
        }
        if (isPausedRuntimeExpired(sandbox)) {
          emitWarmTriggerEvent(self, sid, trigger, "noop_expired", sandbox);
          return jsonResponse({ ok: true, status: "runtime_expired" }, 200);
        }
        if (trigger === "page_open" && !isPausedRuntimeResumeAvailable(sandbox)) {
          emitWarmTriggerEvent(self, sid, trigger, "noop_no_runtime", sandbox);
          return jsonResponse({ ok: true, status: "no_resumable_runtime" }, 200);
        }
        try {
          await self.startSpawnAttempt(
            session.sessionId,
            trigger === "page_open" ? "spawnSandbox.warm.page_open" : "spawnSandbox.warm",
          );
        } catch (err) {
          emitWarmTriggerEvent(self, sid, trigger, "failed", sandbox, err instanceof Error ? err.name : typeof err);
          throw err;
        }
        const outcome: WarmTriggerOutcome =
          trigger === "page_open" || isPausedRuntimeResumeAvailable(sandbox) ? "resumed" : "spawned";
        emitWarmTriggerEvent(self, sid, trigger, outcome, sandbox);
        return jsonResponse({ ok: true, status: "spawning" }, 202);
      }

      // Retry: re-enqueue last completed/failed prompt
      if (request.method === "POST" && url.pathname === "/session/retry") {
        return self.promptQueue.handleRetryRequest();
      }

      if (request.method === "POST" && url.pathname === "/session/slack/retry-wake") {
        const sid = self.resolveSessionId();
        if (!sid || !doDb.getSession(self.sql, sid)) return jsonErrorResponse("Session not found", 404);
        await self.rescheduleSessionAlarm();
        return jsonResponse({ ok: true });
      }

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.sessionIndexReproject.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.sessionIndexReproject.path
      ) {
        return self.handleSessionIndexReproject(request);
      }

      // Event history: return events filtered by prompt_id
      if (request.method === "GET" && url.pathname === "/session/events/history") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid } = authorized;

        const parsedReplayQuery = parseSessionReplayQuery(url.searchParams);
        if (!parsedReplayQuery.ok) {
          return jsonErrorResponse(parsedReplayQuery.error, 400);
        }

        const replayQuery = parsedReplayQuery.value;
        if (replayQuery.beforeSequence !== undefined) {
          if (replayQuery.promptId) {
            return jsonErrorResponse("prompt_id cannot be combined with before_sequence", 400);
          }
          const page = self.buildReplayPageBeforeSequence(
            sid,
            replayQuery.beforeSequence,
            replayQuery.limit,
            SESSION_REPLAY_MAX_LIMIT,
          );
          return jsonResponse(okSessionReplayResponse(page));
        }

        // Replay pagination intentionally uses numeric sequence cursors plus
        // replay metadata rather than `{ data, nextCursor }`, because continuity
        // across reconnects depends on semantically meaningful event boundaries.
        const filtered = doDb.getReplayEvents(self.sql, sid, {
          afterSequence: replayQuery.afterSequence,
          promptId: replayQuery.promptId,
          limit: replayQuery.limit + 1,
        });
        const events = filtered.slice(0, replayQuery.limit);
        const hasMore = filtered.length > replayQuery.limit;
        const page = buildSessionReplayPage(events, {
          afterSequence: replayQuery.afterSequence,
          hasMore,
        });

        return jsonResponse(okSessionReplayResponse(page));
      }

      if (request.method === "GET" && url.pathname === "/session/events/bootstrap") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const promptIds = [
          ...new Set(
            url.searchParams
              .getAll("prompt_id")
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
        if (promptIds.length === 0 || promptIds.length > 500) {
          return jsonErrorResponse("prompt_id is required and must contain at most 500 values", 400);
        }
        const results: Record<string, ReturnType<typeof doDb.getReplayEventsTail>> = {};
        for (const promptId of promptIds) {
          results[promptId] = doDb.getReplayEventsTail(self.sql, authorized.sid, promptId, 250);
        }
        return jsonResponse({ ok: true, results });
      }

      // Context: return stored session context
      if (request.method === "GET" && url.pathname === "/session/context") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;

        const ext = doDb.getSessionExtended(self.sql, sid);
        // Surface the canonical phase alongside the raw storage status so a
        // customer-visible API isn't the one read path stuck on legacy semantics.
        const contextFrame = self.deriveCurrentSessionStatusFrame(sid);

        return jsonResponse({
          ok: true,
          context: {
            sessionId: session.sessionId,
            status: session.status,
            ...phaseFieldsFromInfo(contextFrame.phaseInfo),
            repoOwner: ext?.repoOwner ?? null,
            repoName: ext?.repoName ?? null,
            repoUrl: ext?.repoOwner && ext?.repoName ? `https://github.com/${ext.repoOwner}/${ext.repoName}` : null,
            baseBranch: ext?.baseBranch ?? null,
            lastBranch: ext?.lastBranch ?? null,
            prUrl: ext?.prUrl ?? null,
            createdAt: session.createdAt,
          },
        });
      }

      // Export: full session data dump
      if (request.method === "GET" && url.pathname === "/session/export") {
        const authorized = requireAuthorizedSession(self, request);
        if (!authorized.ok) return authorized.response;
        const { sid, session } = authorized;

        const prompts = doDb.getPrompts(self.sql, sid);
        const events = doDb.getEvents(self.sql, sid);
        const ext = doDb.getSessionExtended(self.sql, sid);
        const sandbox = doDb.getSandboxState(self.sql, sid);
        const activePromptId = doDb.getActiveProcessingPromptId(self.sql, sid);
        const { activePromptHasPendingQuestion, postExecutionPending, mostRecentPromptResultNoChanges } =
          getRichStatusProjectionInputs(self.sql, sid, activePromptId);
        const clientStatus = getSessionStatusForResponse(
          session,
          sandbox?.status,
          activePromptId,
          ext?.publishStatus ?? "not_started",
          postExecutionPending,
          mostRecentPromptResultNoChanges,
          sandbox?.stopReason ?? null,
          activePromptHasPendingQuestion,
          ext?.reviewListeningActive ?? false,
          Boolean(self.userStopped),
        );
        const exportPhaseInfo = derivePhaseInfo(session, {
          sandboxStatus: sandbox?.status,
          activePromptId,
          stopReason: sandbox?.stopReason ?? null,
          activePromptHasPendingQuestion,
          userStopped: Boolean(self.userStopped),
          publishStatus: ext?.publishStatus ?? "not_started",
          postExecutionPending,
          mostRecentPromptResultNoChanges,
          reviewListeningActive: ext?.reviewListeningActive ?? false,
        });
        const usageMap = doDb.getPromptUsage(self.sql, sid);
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let totalCostUsd = 0;
        for (const entry of Object.values(usageMap)) {
          inputTokens += entry.inputTokens;
          outputTokens += entry.outputTokens;
          cacheReadTokens += entry.cacheReadTokens;
          cacheWriteTokens += entry.cacheWriteTokens;
          totalCostUsd += entry.totalCostUsd;
        }

        // Compute tool call count
        const toolCallCount = events.filter((e) => e.type === "tool_call").length;

        // Compute duration
        let totalDurationMs = 0;
        if (prompts.length > 0) {
          const firstCreated = new Date(prompts[0].createdAt).getTime();
          const lastPrompt = prompts[prompts.length - 1];
          const lastTime = lastPrompt.completedAt
            ? new Date(lastPrompt.completedAt).getTime()
            : new Date(lastPrompt.createdAt).getTime();
          totalDurationMs = lastTime - firstCreated;
        }

        const successCount = prompts.filter((p) => p.status === "completed").length;
        const failCount = prompts.filter((p) => p.status === "failed").length;

        return jsonResponse({
          ok: true,
          session: {
            id: session.sessionId,
            status: clientStatus,
            ...phaseFieldsFromInfo(exportPhaseInfo),
            repoUrl: ext?.repoOwner && ext?.repoName ? `https://github.com/${ext.repoOwner}/${ext.repoName}` : null,
            createdAt: session.createdAt,
            closedAt: session.closedAt,
          },
          prompts: prompts.map((p) => ({
            id: p.promptId,
            prompt: p.prompt,
            replyToText: p.replyToText ?? null,
            status: p.status,
            result: truncateDepth(p.result),
            error: p.error,
            createdAt: p.createdAt,
            startedAt: p.startedAt,
            completedAt: p.completedAt,
          })),
          events,
          tokens: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens,
            totalBilledTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
            totalCostUsd,
          },
          stats: {
            totalPrompts: prompts.length,
            successCount,
            failCount,
            totalToolCalls: toolCallCount,
            totalDurationMs,
          },
          pr: ext?.prUrl ? { url: ext.prUrl, number: ext.prNumber ?? null, branch: ext.lastBranch ?? null } : null,
        });
      }

      if (request.method === "POST" && url.pathname === "/session/platform-llm/prompt-preparation") {
        return self.handlePlatformLlmCapabilityRequest(request, "prompt_preparation");
      }

      if (request.method === "POST" && url.pathname === "/session/platform-llm/post-execution") {
        return self.handlePlatformLlmCapabilityRequest(request, "post_execution");
      }

      if (request.method === "POST" && url.pathname === "/session/memory/context") {
        return self.handleMemoryContextSandboxRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/company-memory/reasoning-chain") {
        return self.handleCompanyMemorySandboxRequest(request);
      }

      // Telemetry broker: the sandbox ships platform DD/Sentry/Braintrust
      // telemetry through the control plane, which injects the platform secret
      // server-side. The secrets are removed from the sandbox env entirely.
      if (request.method === "POST" && url.pathname === "/session/telemetry/dd-logs") {
        return self.handleTelemetryDdLogs(request);
      }
      if (request.method === "POST" && url.pathname === "/session/telemetry/braintrust") {
        return self.handleTelemetryBraintrust(request);
      }
      if (request.method === "POST" && url.pathname === "/session/telemetry/sentry") {
        return self.handleTelemetrySentry(request);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/session/artifacts/")) {
        const sessionId = self.resolveSessionId();
        if (!sessionId) return jsonErrorResponse("Session not found", 404);

        const session = doDb.getSession(self.sql, sessionId);
        if (!session) return jsonErrorResponse("Session not found", 404);

        const [, sessionSegment, artifactsSegment, rawArtifactId] = url.pathname.split("/");
        if (sessionSegment !== "session" || artifactsSegment !== "artifacts" || !rawArtifactId) {
          return jsonErrorResponse("Artifact not found", 404);
        }

        const artifactId = decodeArtifactPathSegment(rawArtifactId);
        if (!artifactId) return jsonErrorResponse("Artifact not found", 404);
        const artifact = doDb.getSessionArtifact(self.sql, sessionId, artifactId);
        if (!artifact) return jsonErrorResponse("Artifact not found", 404);
        const revoked = doDb.revokeSessionArtifact(self.sql, sessionId, artifactId, Date.now());
        if (!revoked) return jsonErrorResponse("Artifact not found", 404);
        if ((self.env as Env).WORKER_ENV === ENVIRONMENT.Local) {
          const filename = localStorageFilenameForArtifact(artifact);
          if (filename) {
            try {
              await deleteDoStorageArtifact(self.state.storage, artifactId, filename);
            } catch (err) {
              self.log.warn(
                { artifactId, filename, error: serializeError(err) },
                "Failed to delete local artifact chunks",
              );
            }
          }
        }
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/session/artifacts/view/")) {
        // Internal-only DO endpoint. The user-facing /api/sessions/:id/artifacts/:id/view
        // route gates auth via withSession (canAccessSession + repoAccess) before calling
        // here. The optional `auth && !checkAccess` block below mirrors the convention used
        // by the adjacent /session/artifacts/list handler: if a future internal caller does
        // pass auth headers, validate them; absent headers means the worker is the caller.
        // DO bindings are not externally addressable, so there is no path that reaches this
        // handler without going through the worker.
        const sessionId = self.resolveSessionId();
        if (!sessionId) return new Response("Not found", { status: 404 });

        const session = doDb.getSession(self.sql, sessionId);
        if (!session) return new Response("Not found", { status: 404 });
        const auth = self.parseAuthHeaders(request);
        if (auth && !self.checkAccess(auth, session)) {
          return new Response("Not found", { status: 404 });
        }

        const [, sessionSegment, artifactsSegment, viewSegment, rawArtifactId, ...rawFilenameParts] =
          url.pathname.split("/");
        if (
          sessionSegment !== "session" ||
          artifactsSegment !== "artifacts" ||
          viewSegment !== "view" ||
          !rawArtifactId ||
          rawFilenameParts.length === 0
        ) {
          return new Response("Not found", { status: 404 });
        }

        const artifactId = decodeArtifactPathSegment(rawArtifactId);
        const filename = decodeArtifactPathSegment(rawFilenameParts.join("/"));
        if (!artifactId || !filename) return new Response("Not found", { status: 404 });
        const artifact = doDb.getSessionArtifact(self.sql, sessionId, artifactId);
        if (!artifact) return new Response("Not found", { status: 404 });
        const storedFilename = exactArtifactFilenameForRead(artifact, filename);
        if (!storedFilename) return new Response("Not found", { status: 404 });

        if (!isAuthedReadableArtifactType(artifact.type)) return new Response("Not found", { status: 404 });

        const access = parseArtifactAccessMetadata(artifact.metadata);
        if (access.revokedAt !== null) return new Response("Not found", { status: 404 });

        const { getArtifact } = await import("../services/archive.js");
        let result;
        try {
          result = await getArtifact(self.env, sessionId, artifactId, storedFilename, self.log);
        } catch {
          return new Response("Internal Server Error", { status: 500 });
        }
        const buildHeaders = (contentType: string) => ({
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        });
        if (result) {
          const contentType =
            normalizeArtifactContentType(result.contentType, artifact.type) ?? SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE;
          return new Response(result.body, { headers: buildHeaders(contentType) });
        }
        if ((self.env as Env).WORKER_ENV === ENVIRONMENT.Local) {
          const fallback = await readDoStorageArtifact(self.state.storage, artifactId, storedFilename);
          if (fallback) {
            const contentType =
              normalizeArtifactContentType(fallback.contentType, artifact.type) ?? SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE;
            return new Response(fallback.body as BodyInit, { headers: buildHeaders(contentType) });
          }
        }
        return new Response("Not found", { status: 404 });
      }

      if (request.method === "GET" && url.pathname.startsWith("/session/artifacts/")) {
        const sessionId = self.resolveSessionId();
        if (!sessionId) return new Response("Not found", { status: 404 });

        const session = doDb.getSession(self.sql, sessionId);
        if (!session) return new Response("Not found", { status: 404 });

        const [, sessionSegment, artifactsSegment, rawArtifactId, ...rawFilenameParts] = url.pathname.split("/");
        if (
          sessionSegment !== "session" ||
          artifactsSegment !== "artifacts" ||
          !rawArtifactId ||
          rawFilenameParts.length === 0
        ) {
          return new Response("Not found", { status: 404 });
        }

        const artifactId = decodeArtifactPathSegment(rawArtifactId);
        const filename = decodeArtifactPathSegment(rawFilenameParts.join("/"));
        if (!artifactId || !filename) return new Response("Not found", { status: 404 });
        const artifact = doDb.getSessionArtifact(self.sql, sessionId, artifactId);
        if (!artifact) return new Response("Not found", { status: 404 });
        const storedFilename = exactArtifactFilenameForRead(artifact, filename);
        if (!storedFilename) return new Response("Not found", { status: 404 });

        const access = parseArtifactAccessMetadata(artifact.metadata);
        if (!canServePublicArtifact(access)) return new Response("Not found", { status: 404 });
        if (!isPrSafeArtifactType(artifact.type)) return new Response("Not found", { status: 404 });

        const token = url.searchParams.get(PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM);
        const secret = resolveSandboxCallbackSecret(self.env as Env);
        if (!token || !secret) return new Response("Not found", { status: 404 });

        const tokenOk = await verifyArtifactAccessToken(
          { sessionId, artifactId, filename: storedFilename },
          token,
          secret,
        );
        if (!tokenOk) return new Response("Not found", { status: 404 });

        const { getArtifact } = await import("../services/archive.js");
        let result;
        try {
          result = await getArtifact(self.env, sessionId, artifactId, storedFilename, self.log);
        } catch {
          return new Response("Internal Server Error", { status: 500 });
        }
        if (result) {
          const contentType =
            normalizeArtifactContentType(result.contentType, artifact.type) ?? SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE;
          return new Response(result.body, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": PUBLIC_ARTIFACT_CACHE_CONTROL,
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        if ((self.env as Env).WORKER_ENV === ENVIRONMENT.Local) {
          const fallback = await readDoStorageArtifact(self.state.storage, artifactId, storedFilename);
          if (fallback) {
            const contentType =
              normalizeArtifactContentType(fallback.contentType, artifact.type) ?? SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE;
            return new Response(fallback.body as BodyInit, {
              headers: {
                "Content-Type": contentType,
                "Cache-Control": PUBLIC_ARTIFACT_CACHE_CONTROL,
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
        }

        return new Response("Not found", { status: 404 });
      }

      if (request.method === "POST" && url.pathname === "/session/artifacts") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;

        const session = doDb.getSession(self.sql, auth.sessionId);
        if (!session) {
          return jsonErrorResponse("Session not found", 404);
        }

        const body = new Uint8Array(await request.arrayBuffer());
        if (body.length === 0) {
          return jsonErrorResponse("Artifact body is empty", 400);
        }

        const artifactType = request.headers.get("x-artifact-type") || "artifact";
        const artifactHeaderLabel = request.headers.get("x-artifact-label") || `${artifactType}-${Date.now()}`;
        const artifactLabel =
          decodeArtifactDisplayLabelHeader(request.headers.get("x-artifact-display-label")) ?? artifactHeaderLabel;
        const promptId = request.headers.get("x-prompt-id") || null;
        const artifactKind = request.headers.get("x-artifact-kind") || null;
        const isDesktopActionScreenshot = artifactKind === DESKTOP_ACTION_SCREENSHOT_KIND;
        if (artifactKind && !isDesktopActionScreenshot) {
          return jsonErrorResponse("Unsupported artifact kind", 400);
        }
        const desktopActionId = request.headers.get("x-desktop-action-id") || null;
        const desktopActionPhase = request.headers.get("x-desktop-phase") || null;
        const desktopScenarioId = request.headers.get("x-desktop-scenario-id") || null;
        if (isDesktopActionScreenshot) {
          if (artifactType !== "screenshot") {
            return jsonErrorResponse("Desktop action screenshots must use screenshot artifact type", 400);
          }
          if (!desktopActionId || !DESKTOP_ACTION_PATH_ACTION_ID_RE.test(desktopActionId)) {
            return jsonErrorResponse("Desktop action screenshot action id is invalid", 400);
          }
          if (!isOneOf(desktopActionPhase, DESKTOP_ACTION_PATH_PHASES)) {
            return jsonErrorResponse("Desktop action screenshot phase is invalid", 400);
          }
          if (!desktopScenarioId || desktopScenarioId.length > 256) {
            return jsonErrorResponse("Desktop action screenshot scenario id is invalid", 400);
          }
        }
        if (artifactType === "video" && body.length > WEBM_VIDEO_SIZE_LIMIT_BYTES) {
          return jsonErrorResponse("Video artifact exceeds 50 MB limit", 413);
        }
        const contentType = normalizeArtifactContentType(
          request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE),
          artifactType,
        );
        if (!contentType) {
          return jsonErrorResponse("Unsupported artifact content type", 415);
        }
        const artifactId = crypto.randomUUID();
        const filename = artifactHeaderLabel.replace(/[^a-zA-Z0-9._-]+/g, "-") || `${artifactType}-${artifactId}`;
        const sessionExt = doDb.getSessionExtended(self.sql, auth.sessionId);
        let repoPrivateForArtifact = sessionExt?.repoPrivate ?? null;
        if (
          repoPrivateForArtifact === null &&
          sessionExt?.installationId &&
          sessionExt.repoOwner &&
          sessionExt.repoName &&
          self.env.GITHUB_APP_ID &&
          self.env.GITHUB_PRIVATE_KEY
        ) {
          try {
            const { createInstallationToken } = await import("../github/octokit.js");
            const visibilityToken = await createInstallationToken(self.env, sessionExt.installationId);
            repoPrivateForArtifact = await isRepoPrivate(visibilityToken, sessionExt.repoOwner, sessionExt.repoName);
            doDb.updateSessionFields(self.sql, auth.sessionId, { repoPrivate: repoPrivateForArtifact });
            self.log.info(
              { sessionId: auth.sessionId, repoPrivate: repoPrivateForArtifact },
              "Resolved repo visibility during artifact upload",
            );
          } catch (err) {
            self.log.warn(
              { sessionId: auth.sessionId, error: serializeError(err) },
              "Failed to resolve repo visibility during artifact upload; artifact remains auth-gated",
            );
          }
        }
        const access = createArtifactAccessMetadata(artifactType, repoPrivateForArtifact, Date.now(), {
          forcePrivate: isDesktopActionScreenshot,
        });
        const env = self.env as Env;
        const artifactSigningSecret = resolveSandboxCallbackSecret(env);
        let publicArtifactSigning: { secret: string; expiresAt: number } | null = null;
        if (access.visibility === "public") {
          if (!artifactSigningSecret || access.expiresAt === null) {
            return jsonErrorResponse("Artifact signing is not configured", 500);
          }
          publicArtifactSigning = {
            secret: artifactSigningSecret,
            expiresAt: access.expiresAt,
          };
        }

        const { writeArtifact } = await import("../services/archive.js");
        const s3Url = await writeArtifact(self.env, auth.sessionId, artifactId, filename, body, contentType, self.log);
        if (!s3Url) {
          if (env.WORKER_ENV === ENVIRONMENT.Local) {
            // Local dev fallback: S3 not configured -- stash in DO storage so the artifact proxy can serve it.
            await writeDoStorageArtifact(self.state.storage, artifactId, filename, body, contentType);
          } else {
            return jsonErrorResponse("Failed to store artifact", 500);
          }
        }

        // Use the public app proxy so PR evidence persists after local callback tunnels stop.
        const baseUrl = resolvePublicArtifactBaseUrl(env);
        let url = `${baseUrl}/api/sessions/${auth.sessionId}/artifacts/${artifactId}/${encodeURIComponent(filename)}`;
        if (publicArtifactSigning) {
          url = await buildPublicArtifactUrl(
            baseUrl,
            {
              sessionId: auth.sessionId,
              artifactId,
              filename,
              expiresAt: publicArtifactSigning.expiresAt,
            },
            publicArtifactSigning.secret,
          );
        }

        const artifactMetadata: Record<string, unknown> = {
          label: artifactLabel,
          filename,
          contentType,
          access,
        };
        if (isDesktopActionScreenshot) {
          artifactMetadata.kind = DESKTOP_ACTION_SCREENSHOT_KIND;
          artifactMetadata.actionId = desktopActionId;
          artifactMetadata.phase = desktopActionPhase;
          artifactMetadata.scenarioId = desktopScenarioId;
        }

        doDb.insertSessionArtifact(self.sql, {
          artifactId,
          sessionId: auth.sessionId,
          promptId,
          type: artifactType,
          url,
          metadata: artifactMetadata,
          createdAt: Date.now(),
        });

        const viewUrl = authenticatedArtifactViewUrl(auth.sessionId, artifactId, filename);
        return jsonResponse({
          ok: true,
          artifact: {
            id: artifactId,
            type: artifactType,
            label: artifactLabel,
            url,
            accessVisibility: access.visibility,
            viewUrl,
            metadata: artifactMetadata,
          },
        });
      }

      if (request.method === "PUT" && url.pathname === "/session/rollout") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;
        // Only a live sandbox may overwrite its rollout — blocks a leaked/replayed
        // token from rewriting conversation history after the session is archived.
        const activeTarget = self.requireActiveSandboxTokenMintingTarget(auth);
        if (!activeTarget.ok) return activeTarget.response;

        const { ROLLOUT_MAX_BYTES, writeRollout } = await import("../services/archive.js");
        // Cheap fast-path: reject when Content-Length declares an oversized
        // body, before reading anything.
        const declaredLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > ROLLOUT_MAX_BYTES) {
          return jsonErrorResponse("Rollout too large", 413);
        }

        // Defense that works even when Content-Length is absent or lies: read
        // the stream incrementally and 413 the moment the running total
        // exceeds the cap, so we never buffer past ROLLOUT_MAX_BYTES in DO
        // memory. writeRollout still needs the full body in memory for S3
        // signing, but it is now bounded to the cap.
        let body: Uint8Array | null = null;
        if (request.body) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          const reader = request.body.getReader();
          let oversized = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || value.length === 0) continue;
              total += value.length;
              if (total > ROLLOUT_MAX_BYTES) {
                oversized = true;
                break;
              }
              chunks.push(value);
            }
          } finally {
            // Release the stream; on the oversized path this stops further reads.
            await reader.cancel().catch(() => {});
          }
          if (oversized) {
            return jsonErrorResponse("Rollout too large", 413);
          }
          body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
        }

        if (!body || body.length === 0) {
          return jsonErrorResponse("Rollout body is empty", 400);
        }

        const ok = await writeRollout(self.env, auth.sessionId, body, self.log);
        if (!ok) {
          return jsonErrorResponse("Failed to store rollout", 500);
        }
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/session/rollout") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;
        // Intentionally NOT gated on active-session status: cold-resume restore
        // fetches the rollout during sandbox spawn, before the session is marked
        // ready. Access is bounded by the per-session sandbox token (same as the
        // artifact GET); the sandbox token is the read authority here.

        const { readRollout } = await import("../services/archive.js");
        const body = await readRollout(self.env, auth.sessionId, self.log);
        if (!body) return new Response("Not found", { status: 404 });
        return new Response(body, { headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/gzip" } });
      }

      // Fresh GitHub token for the bridge-written agent gh config.
      if (request.method === "GET" && url.pathname === "/session/github-token") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;

        const tokenEnv = self.env as Env;
        const tokenSession = doDb.getSession(self.sql, auth.sessionId);
        const activeTarget = self.requireActiveSandboxTokenMintingTarget(auth, tokenSession);
        if (!activeTarget.ok) return activeTarget.response;
        const tokenExt = doDb.getSessionExtended(self.sql, auth.sessionId);
        const installationId = tokenExt?.installationId as number | undefined;
        const repoName = tokenExt?.repoName;

        // The sandbox never receives the user OAuth token: PRs are opened
        // server-side (github/pr.ts) with the user's token, and pushes use the
        // separate write-scoped clone-token on the bridge, so the agent's gh only
        // needs a repo-scoped READ-ONLY installation token. The bridge delivers this
        // token into a file the untrusted agent can read (its gh config), so it must
        // carry no write scope: a prompt-injection foothold that reaches this route
        // (or reads that file) can exfiltrate at most a single-repo read-only token,
        // never an account-wide user credential or a write-capable one.
        if (!installationId) {
          return jsonErrorResponse("No installation_id for session", 400);
        }
        if (!repoName) {
          return jsonErrorResponse("No repo for session -- cannot scope token", 400);
        }
        if (!tokenEnv.GITHUB_APP_ID || !tokenEnv.GITHUB_PRIVATE_KEY) {
          return jsonErrorResponse("GitHub App not configured", 500);
        }
        try {
          const { createScopedInstallationToken, sandboxGhReadonlyTokenScope } = await import("../github/octokit.js");
          const token = await createScopedInstallationToken(
            tokenEnv,
            installationId,
            sandboxGhReadonlyTokenScope(repoName),
          );
          self.log.info(
            { sessionId: auth.sessionId, installationId, repoName },
            "Generated repo-scoped read-only installation token for sandbox gh CLI",
          );
          return jsonResponse({ ok: true, token, source: "installation" });
        } catch (err) {
          self.log.error(
            { installationId, repoName, error: serializeError(err) },
            "Failed to generate GitHub token for sandbox gh CLI",
          );
          Sentry.captureException(err, {
            tags: { operation: "generateSandboxGithubToken", installationId: String(installationId) },
          });
          return jsonErrorResponse("Failed to generate token", 500);
        }
      }

      if (request.method === "POST" && url.pathname === "/session/github-action") {
        return handleGithubAction(self, request);
      }

      // Fresh installation token for push (called by sandbox-bridge before git push)
      if (request.method === "GET" && url.pathname === "/session/clone-token") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;
        const activeTarget = self.requireActiveSandboxTokenMintingTarget(auth);
        if (!activeTarget.ok) return activeTarget.response;

        const cloneEnv = self.env as Env;
        const cloneExt = doDb.getSessionExtended(self.sql, auth.sessionId);
        const installationId = cloneExt?.installationId as number | undefined;
        const repoName = cloneExt?.repoName;
        if (!installationId) {
          return jsonErrorResponse("No installation_id for session", 400);
        }
        if (!repoName) {
          return jsonErrorResponse("No repo for session -- cannot scope token", 400);
        }
        if (!cloneEnv.GITHUB_APP_ID || !cloneEnv.GITHUB_PRIVATE_KEY) {
          return jsonErrorResponse("GitHub App not configured", 500);
        }
        try {
          const { createInstallationTokenForCloneToken, sandboxInstallationTokenScope, sandboxPushTokenScope } =
            await import("../github/octokit.js");
          // The push token carries `workflows:write` so sessions that edit
          // `.github/workflows/**` can publish. If the installation has not approved
          // that permission, GitHub rejects the over-broad mint (422/403; it never
          // silently downgrades), so fall back to the minimal push scope: non-workflow
          // pushes still succeed and a workflow-file push surfaces the graceful
          // "workflows permission required" message from sandbox-bridge git/push.ts
          // instead of failing here at token mint.
          let token: string;
          try {
            token = await createInstallationTokenForCloneToken(
              cloneEnv,
              installationId,
              sandboxPushTokenScope(repoName),
            );
          } catch (err) {
            const status = (err as { status?: number }).status;
            if (status !== 422 && status !== 403) throw err;
            self.log.warn(
              { sessionId: auth.sessionId, installationId, repoName, status },
              "Push token mint with workflows scope rejected; retrying with minimal scope",
            );
            token = await createInstallationTokenForCloneToken(
              cloneEnv,
              installationId,
              sandboxInstallationTokenScope(repoName),
            );
          }
          self.log.info(
            { sessionId: auth.sessionId, installationId, repoName },
            "Generated fresh repo-scoped installation token for push",
          );
          return jsonResponse({ ok: true, token });
        } catch (err) {
          self.log.error(
            { installationId, error: serializeError(err) },
            "Failed to generate installation token for push",
          );
          Sentry.captureException(err, {
            tags: { operation: "generateInstallationToken", installationId: String(installationId) },
          });
          return jsonErrorResponse("Failed to generate token", 500);
        }
      }

      // Do not exchange sandbox-scoped credentials for owner user sessions.
      if (request.method === "GET" && url.pathname === "/session/cli-auth-token") {
        const auth = await self.validateSandboxAuthRequest(request);
        if (!auth.ok) return auth.response;

        self.log.warn(
          { sessionId: auth.sessionId },
          "Rejected sandbox CLI auth token mint because sandbox credentials cannot cross into owner user identity",
        );
        return jsonErrorResponse("CLI auth token minting is disabled", 403);
      }

      if (request.method === "POST" && url.pathname === "/session/child-sessions/authorize") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { session } = caller;
        if (isQaTesterAgentRole(session.agentRole) || isCodeReviewerAgentRole(session.agentRole)) {
          self.log.warn({ sessionId: session.ownerUserId }, "Rejected read-only agent child-session creation");
          return jsonErrorResponse("Forbidden", 403);
        }
        return jsonResponse({
          ok: true,
          ownerUserId: String(session.ownerUserId),
          businessId: session.businessId ?? null,
          agentRole: session.agentRole ?? null,
        });
      }

      if (request.method === "POST" && url.pathname === "/session/pr-review/publish") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { auth, session } = caller;
        const sessionExt = doDb.getSessionExtended(self.sql, auth.sessionId);
        if (
          !isCodeReviewerSession(session) ||
          session.agentProfile !== REVIEW_AGENT_NAME ||
          !sessionExt?.prUrl ||
          !sessionExt.repoOwner ||
          !sessionExt.repoName ||
          !sessionExt.prNumber ||
          !sessionExt.installationId
        ) {
          self.log.warn({ sessionId: auth.sessionId }, "Rejected PR review publish from an ineligible session");
          return jsonErrorResponse("Forbidden", 403);
        }

        const parsed = await parseBody(request, PrReviewPublishBodySchema);
        if (!parsed.ok) return parsed.response;
        const priorPublication = await self.state.storage.get(PR_REVIEW_PUBLISHED_STORAGE_KEY);
        if (priorPublication) return jsonErrorResponse("PR review already published", 409);

        const env = self.env as Env;
        const claim = await getPrReviewTriggerClaim(env.DB, { prUrl: sessionExt.prUrl });
        if (!claim || claim.sessionId !== auth.sessionId) {
          self.log.warn(
            { sessionId: auth.sessionId, prUrl: sessionExt.prUrl },
            "Rejected PR review publish without claim",
          );
          return jsonErrorResponse("Forbidden", 403);
        }

        await self.state.storage.put(PR_REVIEW_PUBLISHED_STORAGE_KEY, { status: "publishing", startedAt: Date.now() });
        let result: Awaited<ReturnType<typeof publishPrReview>> | null = null;
        const triggerToPublishedMs = Math.max(0, Date.now() - claim.claimedAt);
        try {
          const token = await createInstallationToken(env, sessionExt.installationId);
          const currentHeadSha = await getPrHeadSha(
            token,
            sessionExt.repoOwner,
            sessionExt.repoName,
            sessionExt.prNumber,
          );
          if (!currentHeadSha) throw new Error("GitHub PR head lookup failed");
          const publishResult = await publishPrReview({
            token,
            owner: sessionExt.repoOwner,
            repo: sessionExt.repoName,
            prNumber: sessionExt.prNumber,
            currentHeadSha,
            publication: parsed.value,
            sessionId: auth.sessionId,
            prUrl: sessionExt.prUrl,
            logger: self.log,
          });
          result = publishResult;
          await self.state.storage.put(PR_REVIEW_PUBLISHED_STORAGE_KEY, {
            status: "published",
            outcome: publishResult.outcome,
            summaryCommentId: publishResult.summaryCommentId,
          });
          self.ctx.waitUntil(
            postStructuredEventToDd(env, {
              event: "pr_review_trigger",
              sessionId: auth.sessionId,
              prUrl: sessionExt.prUrl,
              outcome: result.outcome,
              trigger_to_published_ms: triggerToPublishedMs,
            }),
          );
          try {
            await releasePrReviewTrigger(env.DB, {
              prUrl: sessionExt.prUrl,
              triggerCommentId: claim.triggerCommentId,
            });
          } catch (releaseError) {
            self.log.warn(
              { sessionId: auth.sessionId, prUrl: sessionExt.prUrl, error: serializeError(releaseError) },
              "Failed to release PR review trigger claim after publication",
            );
          }
          self.log.info(
            {
              event: "pr_review_trigger",
              sessionId: auth.sessionId,
              prUrl: sessionExt.prUrl,
              outcome: result.outcome,
              trigger_to_published_ms: triggerToPublishedMs,
            },
            "Published triggered PR review",
          );
          if (parsed.value.verdict === "issues_found") {
            self.ctx.waitUntil(
              notifyZeusReviewIssues(env, {
                sessionId: auth.sessionId,
                prUrl: sessionExt.prUrl,
                repoOwner: sessionExt.repoOwner,
                repoName: sessionExt.repoName,
                prNumber: sessionExt.prNumber,
                verdict: parsed.value.verdict,
                findings: filterPrReviewFindingsByConfidence(parsed.value.findings),
                inlineCommentCount: result.inlineCommentCount,
                foldedFindingCount: result.foldedFindingCount,
              }),
            );
          }
          return jsonResponse({ ok: true, ...result });
        } catch (error) {
          if (result) {
            try {
              await self.state.storage.put(PR_REVIEW_PUBLISHED_STORAGE_KEY, {
                status: "published",
                outcome: result.outcome,
                summaryCommentId: result.summaryCommentId,
              });
            } catch (storageError) {
              self.log.warn(
                { sessionId: auth.sessionId, prUrl: sessionExt.prUrl, error: serializeError(storageError) },
                "Failed to finalize PR review publication marker after GitHub publication",
              );
            }
          } else {
            await self.state.storage.delete(PR_REVIEW_PUBLISHED_STORAGE_KEY);
          }
          self.ctx.waitUntil(
            postStructuredEventToDd(env, {
              event: "pr_review_trigger",
              sessionId: auth.sessionId,
              prUrl: sessionExt.prUrl,
              outcome: "publish_failed",
              trigger_to_published_ms: triggerToPublishedMs,
            }),
          );
          self.log.error(
            {
              event: "pr_review_trigger",
              sessionId: auth.sessionId,
              prUrl: sessionExt.prUrl,
              outcome: "publish_failed",
              trigger_to_published_ms: triggerToPublishedMs,
              error: serializeError(error),
            },
            "Failed to publish triggered PR review",
          );
          return jsonErrorResponse("Failed to publish PR review", 502);
        }
      }

      if (request.method === "POST" && url.pathname === "/session/integration-lifecycle") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { auth, session } = caller;

        const payload = (await parseJsonBody(request)) as Record<string, unknown> | null;
        const integrationId = typeof payload?.integrationId === "string" ? payload.integrationId : null;
        const stage = typeof payload?.stage === "string" ? payload.stage : null;
        const status = typeof payload?.status === "string" ? payload.status : null;
        const message = typeof payload?.message === "string" ? payload.message.trim() : "";
        const reasonCode = typeof payload?.reasonCode === "string" ? payload.reasonCode : null;
        const details =
          payload?.details && typeof payload.details === "object" && !Array.isArray(payload.details)
            ? (payload.details as Record<string, unknown>)
            : null;
        const latencyMs =
          typeof payload?.latencyMs === "number" && Number.isFinite(payload.latencyMs) && payload.latencyMs >= 0
            ? payload.latencyMs
            : null;

        if (
          !integrationId ||
          !INTEGRATION_ID_SET.has(integrationId) ||
          !stage ||
          !INTEGRATION_LIFECYCLE_STAGE_SET.has(stage) ||
          !status ||
          !INTEGRATION_LIFECYCLE_STATUS_SET.has(status) ||
          (reasonCode !== null && !INTEGRATION_LIFECYCLE_REASON_CODE_SET.has(reasonCode)) ||
          !message
        ) {
          return jsonErrorResponse("Invalid integration lifecycle payload", 400);
        }

        const validatedIntegrationId = integrationId as (typeof INTEGRATION_IDS)[number];
        const validatedStage = stage as (typeof INTEGRATION_LIFECYCLE_STAGE)[keyof typeof INTEGRATION_LIFECYCLE_STAGE];
        const validatedStatus =
          status as (typeof INTEGRATION_LIFECYCLE_STATUS)[keyof typeof INTEGRATION_LIFECYCLE_STATUS];
        const validatedReasonCode = reasonCode as
          (typeof INTEGRATION_LIFECYCLE_REASON_CODE)[keyof typeof INTEGRATION_LIFECYCLE_REASON_CODE] | null;

        await self.flushTextDeltaBuffer();

        await writeIntegrationLifecycleEvent((self.env as Env).DB, {
          integrationId: validatedIntegrationId,
          stage: validatedStage,
          status: validatedStatus,
          businessId: session.businessId,
          userId: Number.isFinite(Number(session.ownerUserId)) ? Number(session.ownerUserId) : null,
          sessionId: auth.sessionId,
          reasonCode: validatedReasonCode,
          message,
          details,
          ...(latencyMs === null ? {} : { latencyMs }),
        });
        return jsonResponse({ ok: true, recorded: true });
      }

      if (request.method === "POST" && url.pathname === "/session/review-loop/reply") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;

        return self.prWorkflow.handleReviewLoopReplyRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/pr-title") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;

        return self.prWorkflow.handleUpdatePrTitleRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/pr-close") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;

        return self.prWorkflow.handleClosePrRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/archive-close-pr") {
        return self.prWorkflow.handleArchiveClosePrRequest();
      }

      if (request.method === "POST" && url.pathname === "/session/pr-read") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;

        return self.prWorkflow.handleReadPrRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/ticket-key") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;

        return self.prWorkflow.handleRecordAgentTicketKeyRequest(request);
      }

      if (request.method === "POST" && url.pathname === "/session/review-loop/summary-comment") {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { auth } = caller;

        const db = (self.env as import("../types").Env).DB;
        if (!db) return jsonErrorResponse("Database unavailable", 503);

        const payload = ((await parseJsonBody(request)) || {}) as Partial<{
          epochId: string;
          headSha: string;
          body: string;
          promptId: string;
        }>;
        const epochId = typeof payload.epochId === "string" && payload.epochId.trim() ? payload.epochId.trim() : null;
        const headSha = typeof payload.headSha === "string" && payload.headSha.trim() ? payload.headSha.trim() : null;
        const body = typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : null;
        if (!epochId || !body) {
          return jsonErrorResponse("Invalid review-loop summary-comment payload", 400);
        }
        const promptId =
          typeof payload.promptId === "string" && payload.promptId.trim() ? payload.promptId.trim() : undefined;

        const result = await publishReviewLoopSummaryComment({
          env: self.env as import("../types").Env,
          db,
          sessionId: auth.sessionId,
          epochId,
          headSha: headSha ?? undefined,
          body,
          promptId,
        });

        if (!result.ok) {
          const { reason } = result;
          if (reason === "body_too_large") return jsonErrorResponse(reason, 400);
          if (reason === "epoch_not_found" || reason === "session_mismatch") return jsonErrorResponse(reason, 404);
          if (reason === "invalid_source_kind" || reason === "invalid_status") return jsonErrorResponse(reason, 409);
          if (reason === "not_eligible") return jsonErrorResponse(reason, 403);
          if (reason === "github_post_failed" || reason === "github_patch_failed")
            return jsonErrorResponse(reason, 502);
          return jsonErrorResponse(reason, 500);
        }
        return jsonResponse({ ok: true, githubCommentId: result.githubCommentId });
      }

      if (request.method === "POST" && url.pathname === "/session/review-loop/record-push") {
        // Sandbox `cycloid.git_sync` reports the head it is force-pushing so the review loop can
        // recognize the advance as the session's OWN push: the reply gate's #4987 own-pushed-SHA
        // carve-out and the head-change reconciler's carry-forward both key off the recorded push
        // operation. Recorded BEFORE the actual git push (the sha is the local HEAD about to be
        // pushed), so the `synchronize` webhook can never win the race against the record. A record
        // for a push that then fails is inert — no webhook ever arrives with that sha.
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { auth } = caller;

        const db = (self.env as import("../types").Env).DB;
        if (!db) return jsonErrorResponse("Database unavailable", 503);

        const payload = ((await parseJsonBody(request)) || {}) as Partial<{ pushedHead: string; branch: string }>;
        const pushedHead =
          typeof payload.pushedHead === "string" && /^[0-9a-f]{7,64}$/i.test(payload.pushedHead.trim())
            ? payload.pushedHead.trim().toLowerCase()
            : null;
        if (!pushedHead) return jsonErrorResponse("Invalid record-push payload", 400);

        const recordedEpochs = await recordReviewLoopSelfPushForSession(db, {
          sessionId: auth.sessionId,
          pushedHead,
          nowMs: Date.now(),
        });
        return jsonResponse({ ok: true, recordedEpochs });
      }

      if (request.method === "POST" && url.pathname === "/session/review-loop/summary-comment-posted") {
        // Internal notification: append review_loop.summary_comment.posted event.
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);
        if (session.status === "archived") return jsonResponse({ ok: true, updated: false, reason: "archived" });

        const payload = (await parseJsonBody(request)) as Partial<{
          epochId: string;
          githubCommentId: number;
        }> | null;
        const epochId = typeof payload?.epochId === "string" && payload.epochId.trim() ? payload.epochId.trim() : null;
        const githubCommentId = typeof payload?.githubCommentId === "number" ? payload.githubCommentId : null;
        if (!epochId || githubCommentId === null) {
          return jsonErrorResponse("Invalid summary-comment-posted payload", 400);
        }

        await self.appendAndBroadcastEvents(sid, [
          {
            type: "review_loop.summary_comment.posted",
            timestamp: nowIso(),
            data: { sessionId: sid, epochId, githubCommentId },
          },
        ]);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/session/memory-review-bot/completed") {
        const sid = self.resolveSessionId();
        if (!sid) return jsonErrorResponse("Session not found", 404);
        const session = doDb.getSession(self.sql, sid);
        if (!session) return jsonErrorResponse("Session not found", 404);

        const payload = (await parseJsonBody(request)) as Partial<{
          sessionId: string;
          promptId: string;
          runId: string;
          promptOutcome: string;
          confidence: number;
          summary: string;
          returnedMemoryCount: number;
          usefulCount: number;
          notUsefulCount: number;
          hurtCount: number;
          falsePositiveHurt: boolean;
        }> | null;
        const promptId =
          typeof payload?.promptId === "string" && payload.promptId.trim() ? payload.promptId.trim() : null;
        const runId = typeof payload?.runId === "string" && payload.runId.trim() ? payload.runId.trim() : null;
        const promptOutcome =
          typeof payload?.promptOutcome === "string" && payload.promptOutcome.trim()
            ? payload.promptOutcome.trim()
            : null;
        const summary = typeof payload?.summary === "string" && payload.summary.trim() ? payload.summary.trim() : null;
        if (!payload || payload.sessionId !== sid || !promptId || !runId || !promptOutcome || !summary) {
          return jsonErrorResponse("Invalid memory review completion payload", 400);
        }

        const eventState = await self.appendAndBroadcastEvents(
          sid,
          [
            {
              type: "memory_review_completed",
              timestamp: nowIso(),
              data: {
                sessionId: sid,
                promptId,
                runId,
                promptOutcome,
                confidence: typeof payload.confidence === "number" ? payload.confidence : null,
                summary,
                returnedMemoryCount:
                  typeof payload.returnedMemoryCount === "number" ? payload.returnedMemoryCount : null,
                usefulCount: typeof payload.usefulCount === "number" ? payload.usefulCount : null,
                notUsefulCount: typeof payload.notUsefulCount === "number" ? payload.notUsefulCount : null,
                hurtCount: typeof payload.hurtCount === "number" ? payload.hurtCount : null,
                falsePositiveHurt: payload.falsePositiveHurt === true,
              },
            },
          ],
          promptId,
        );
        return jsonResponse({ ok: true, eventId: `event-${eventState.replay.lastEventSequence}` });
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/session/slack/get-thread" ||
          url.pathname === "/session/slack/search-messages" ||
          url.pathname === "/session/slack/send-message")
      ) {
        const caller = await requireActiveSandboxCaller(self, request);
        if (!caller.ok) return caller.response;
        const { auth, session } = caller;
        const sessionExt = doDb.getSessionExtended(self.sql, auth.sessionId);
        const slackCallbackContext =
          sessionExt?.callbackContext?.source === "slack" ? sessionExt.callbackContext : null;
        const slackTeamId = slackCallbackContext?.slackTeamId ?? null;
        const payload = await parseJsonBody(request);

        if (!slackTeamId) {
          return jsonResponse(
            {
              ok: false,
              errorCode: "workspace_unknown",
              error: "Slack tools are only available for Slack-originated sessions with a known workspace binding.",
            },
            409,
          );
        }

        try {
          if (url.pathname === "/session/slack/get-thread") {
            const result = await runSlackGetThreadTool({
              env: self.env as Env,
              slackTeamId,
              args: payload,
            });
            return jsonResponse({ ok: true, result });
          }

          if (url.pathname === "/session/slack/search-messages") {
            const result = await runSlackSearchMessagesTool({
              env: self.env as Env,
              ownerUserId: session.ownerUserId,
              args: payload,
            });
            return jsonResponse({ ok: true, result });
          }

          const result = await runSlackSendMessageTool({
            env: self.env as Env,
            ownerUserId: session.ownerUserId,
            sessionId: auth.sessionId,
            slackTeamId,
            callbackContext: slackCallbackContext,
            args: payload,
          });
          return jsonResponse({ ok: true, result });
        } catch (error) {
          const failure = toSlackDynamicToolFailureResponse(error);
          return jsonResponse(
            {
              ok: failure.ok,
              errorCode: failure.errorCode,
              error: failure.error,
            },
            failure.status,
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/session/agents") {
        const agentsSid = self.resolveSessionId();
        const agentsExt = agentsSid ? doDb.getSessionExtended(self.sql, agentsSid) : null;
        const resolvedAgents = agentsExt?.resolvedAgents;
        if (!resolvedAgents) {
          return jsonResponse({ ok: true, agents: {} });
        }
        // Filter out internal agents before returning
        const publicAgents: Record<string, AgentConfig> = {};
        for (const [name, agent] of Object.entries(resolvedAgents)) {
          if (agent.mode !== "internal") {
            publicAgents[name] = agent;
          }
        }
        return jsonResponse({ ok: true, agents: publicAgents });
      }

      // -----------------------------------------------------------------
      // E2B runtime cleanup internal endpoints (Bearer-secret auth)
      // -----------------------------------------------------------------

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.e2bCleanupRun.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.e2bCleanupRun.path
      ) {
        return self.handleE2BCleanupRun(request);
      }

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.e2bOwnerGuard.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.e2bOwnerGuard.path
      ) {
        return self.handleE2BOwnerGuard(request);
      }

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.sessionPhaseReap.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.sessionPhaseReap.path
      ) {
        return self.handleSessionPhaseReap(request);
      }

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.prePublishStallFail.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.prePublishStallFail.path
      ) {
        return self.handlePrePublishStallFail(request);
      }

      if (
        request.method === SESSION_BEARER_INTERNAL_ROUTES.sessionOffboardingPurge.method &&
        url.pathname === SESSION_BEARER_INTERNAL_ROUTES.sessionOffboardingPurge.path
      ) {
        return self.handleSessionOffboardingPurge(request);
      }

      return jsonErrorResponse("Not found", 404);
    } catch (err) {
      doSpanStatus = "error";
      const sid = self.resolveSessionId();
      doSpanErrorAttributes = doErrorSpanAttributes(err, sid);
      if (request.method === "GET" && url.pathname === "/session/export") {
        self.log.error(
          { sessionId: sid ?? null, error: serializeError(err), operation: "session.export" },
          "session export failed",
        );
      }
      throw err;
    } finally {
      endSpan(doSpan, doSpanStatus, doSpanErrorAttributes);
      // Flush DO spans to queue — pinned to waitUntil for durable delivery
      self.ctx.waitUntil(self.flushObservedSpans());
    }
  }) as Promise<Response>;
}
