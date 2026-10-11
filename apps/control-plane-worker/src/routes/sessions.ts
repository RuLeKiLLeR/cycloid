import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import {
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
  isAgentRuntimeBackend,
  OPENCODE_AGENT_RUNTIME_BACKEND,
  resolveAgentRuntimeBackend,
} from "../../../../shared/agent/agent-runtime-backend.js";
import {
  isQaTesterAgentRole,
  normalizePublicQaRequest,
  requiresQaTargetPrUrl,
  resolveAgentRuntimeMetadata,
  reviewVerificationExemptReason,
} from "../../../../shared/agent/constants.js";
import {
  AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE,
  normalizeGithubPullRequestUrl,
  resolveQaTargetPullRequestUrl,
} from "../../../../shared/agent/verify-directive.js";
import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import {
  extractModelId,
  extractSessionStartModelIdForBackend,
  getAgentRuntimeBackendForModel,
  getDefaultSessionStartModelIdForBackend,
  isModelAllowedForBackend,
  isSessionStartModelAllowedForBackend,
  isValidReasoningEffort,
  MODEL_REASONING_CONFIG,
} from "../../../../shared/constants/models.js";
import {
  MAX_SESSION_CREATE_BODY_BYTES,
  SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS,
} from "../../../../shared/constants/session.js";
import { MAX_PROMPT_SQL_PAYLOAD_BYTES } from "../../../../shared/constants/uploads.js";
import { isValidGithubRepoSegment } from "../../../../shared/github/repo-url.js";
import { type PlatformLlmCallPlan, type PlatformLlmPhase } from "../../../../shared/llm/platform-llm-contract.js";
import {
  normalizePlanMarkdown,
  normalizePlanModeSetting,
  PLAN_CAPTURE_MAX_CHARS,
} from "../../../../shared/plan-mode.js";
import {
  isRespondAvailable,
  isResumeAvailable,
  isRetryAvailable,
  isWarmAvailable,
  PROMPT_SEND_BLOCKED_ERROR,
  RESPOND_BLOCKED_ERROR,
  RESUME_BLOCKED_ERROR,
  RETRY_BLOCKED_ERROR,
  WARM_BLOCKED_ERROR,
} from "../../../../shared/session/eligibility.js";
import type { Phase } from "../../../../shared/session/phase.js";
import type { ChildSessionErrorCode, CreateChildSessionRequest } from "../../../../shared/types/child-session.js";
import {
  type CreateDesktopViewTicketResponse,
  type DesktopViewTicketCloseDiagnostics,
  type DesktopViewTicketCloseRequest,
  type DesktopViewTicketConnectRequest,
  type DesktopViewTicketHeartbeatRequest,
  type DesktopViewTicketRevokeRequest,
  type DesktopViewTicketStatusRequest,
} from "../../../../shared/types/desktop-viewer.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import { validatePromptUploadSqlPayload } from "../../../../shared/utils/uploads.js";
import { getUserBySlackId, getUserDisplayProfile, getValidGithubToken, resolveCycloidAdminUser } from "../auth/db";
import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { authenticateRequest } from "../auth/routes";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import {
  INVALID_SESSION_ID_MESSAGE,
  isValidSessionId,
  RESPOND_BODY_ENVELOPE_HEADROOM_BYTES,
} from "../constants/sessions";
import { BlockerKind } from "../enums/blocker";
import { SessionEntrypoint } from "../enums/session-entrypoint";
import { buildSessionTranscript } from "../eval/transcript";
import { createInstallationToken } from "../github/octokit";
import { getBranchHeadSha, parseRepoUrl } from "../github/pr";
import { fetchRepoSkills } from "../github/skills";
import { fetchRepoTree } from "../github/tree";
import { parseGithubPullRequestUrl } from "../github/verification-pr-context";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { type RouteSpanRecorder, withRouteSpan } from "../observability/route-span";
import { tracedFetch } from "../observability/wrappers";
import { isKnownRuntimeProvider, parsePersistedRuntimeBackend } from "../sandbox/runtime-backend";
import {
  buildChildSessionUrl,
  CHILD_SESSION_INITIATION_MODE,
  getChildSessionLimitTelemetryCounts,
  getChildSessionStatusSummary,
  listChildSessionSummaries,
  markChildSessionCapacityProjected,
  releaseUnprojectedChildSessionCapacity,
  reserveChildSessionCapacity,
  resolveChildSessionParentPromptId,
  validateChildSessionCreation,
} from "../services/child-session";
import {
  buildDesktopViewTicketPaths,
  type DesktopViewerInputAttempt,
  type DesktopViewerUpstreamResolveDiagnostics,
  type DesktopViewerWebSocketCloseDiagnostics,
  type DesktopViewerWebSocketHandshakeDiagnostics,
  proxyDesktopViewerWebSocket,
  resolveDesktopViewerUpstream,
} from "../services/desktop-viewer-proxy";
import {
  beginIdempotentRequest,
  commitIdempotentRequest,
  type IdempotencyToken,
  readIdempotencyKeyHeader,
  releaseIdempotentRequest,
} from "../services/idempotency";
import { gateGithubSessionStart } from "../services/integration-gating";
import { verifyCycloidMember } from "../services/internal-feature-gate";
import { getLatestMemoryFeedbackForUser, submitMemoryFeedback } from "../services/memory-feedback";
import {
  canBusinessUseOpencode,
  OPENCODE_ACCESS_DENIED_ERROR,
  OpencodeAccessDeniedError,
} from "../services/opencode-access-gate";
import { executePlatformLlmCall } from "../services/platform-llm";
import {
  evaluateProviderCredentialForModel,
  PROVIDER_KEY_NOT_VALIDATED_ERROR,
  ProviderCredentialNotValidatedError,
} from "../services/provider-credential-gate";
import {
  resolveConfiguredPublicSessionUrl,
  resolvePublicAppBaseUrl,
  resolvePublicSessionUrl,
} from "../services/public-url";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import { listAccessibleReposForUser } from "../services/repos";
import { admitSessionCreate } from "../services/session-admission";
import { resolveSessionContinuation, SessionContinuationError } from "../services/session-continuation";
import { persistInitialSessionProjection } from "../services/session-create";
import { syncRuntimeBackendProjection, syncSessionProjection } from "../services/session-projection";
import {
  checkDesktopActionPathSnapshotRateLimit,
  checkDesktopViewTicketCreateRateLimit,
  checkDesktopViewWebSocketRateLimit,
  checkSessionPlanEditRateLimit,
  checkSessionResumeRateLimit,
  checkSessionWsTelemetryRateLimit,
  type DurableObjectRateLimitResult,
} from "../services/session-resume-rate-limiter";
import { assembleSessionView, type SessionViewParentMetadata } from "../services/session-view";
import {
  emitSessionWsTelemetry,
  parseSessionWsTelemetryPayload,
  type SessionWsViewerRelation,
} from "../services/session-ws-telemetry";
import {
  decodeArtifactPathSegment,
  normalizeRequestedArtifactFilename,
  PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM,
} from "../session/artifacts";
import { getSessionIndexBusinessId } from "../session/business-id";
import {
  type ChildSessionRow,
  getChildContextForSession,
  getChildSessionIdsForParent,
  getChildSessionRow,
  getParentSessionRow,
} from "../session/child-session-db";
import { cleanupOrphanedSession } from "../session/cleanup";
import {
  canAccessSession,
  canAccessSessionIdentity,
  deleteArchivedSessionsFromIndex,
  encodeSessionListCursor,
  getSessionIndexIdentity,
  getSessionIndexIdentityWithRepo,
  hasActiveSessionSearch,
  listSessions,
  type SessionSearchOptions,
  toSessionApiShape,
} from "../session/db";
import { buildSseResponse } from "../session/events";
import { publishSessionClosedFromDb, publishSessionUpsertedFromDb } from "../session/feed-delta";
import { getSessionFeedback, upsertSessionFeedback } from "../session/feedback-db";
import { notifyUserBlocked } from "../session/notify-user-blocked";
import { getTrackingSessionIdForPrUrl } from "../session/pr-coordination-db";
import { claimPrTakeoverAdmission, releasePrTakeoverAdmission } from "../session/pr-takeover-admission-claims-db";
import { toPublicEnqueueDispatch, toPublicEnqueuedPrompt } from "../session/prompt-response";
import {
  approveSessionPlan,
  assertDatabase,
  authorizeChildSession,
  broadcastSessionSnapshot,
  callClosePrRoute,
  callCompanyMemorySandboxRoute,
  callGithubActionRoute,
  callMemoryContextSandboxRoute,
  callReadPrRoute,
  callRecordAgentTicketKeyRoute,
  callReviewLoopRecordPushRoute,
  callReviewLoopReplyRoute,
  callReviewLoopSummaryCommentRoute,
  callSessionIntegrationLifecycleRoute,
  callSlackDynamicToolRoute,
  callTelemetryBraintrustRoute,
  callTelemetryDdLogsRoute,
  callTelemetrySentryRoute,
  callUpdatePrTitleRoute,
  closeAttachedPrForArchive,
  closeSessionDesktopViewTicketAuthed,
  closeSessionState,
  connectSessionDesktopViewTicketAuthed,
  createSessionDesktopViewTicketAuthed,
  createSessionState,
  downloadSandboxRollout,
  editSessionPlan,
  enqueueSessionPrompt,
  extractRequestId,
  getAuthedSessionArtifact,
  getCliAuthToken,
  getCloneToken,
  getGithubToken,
  getPublicSessionArtifact,
  getSessionBootstrapAuthed,
  getSessionContext,
  getSessionContextAuthed,
  getSessionDesktopActionPathAuthed,
  getSessionDesktopViewTicketStatusAuthed,
  getSessionExportDataAuthed,
  getSessionInputComposition,
  getSessionPlan,
  getSessionReplayPageAuthed,
  getSessionSandboxState,
  getSessionState,
  getSessionUsage,
  getSessionView,
  heartbeatSessionDesktopViewTicketAuthed,
  InvalidSessionIdError,
  listSessionEventsAuthed,
  listSessionPrompts,
  openSandboxWebSocket,
  openSessionWebSocket,
  publishPrReviewFromSandbox,
  registerSandboxDesktopActionPathRow,
  type RepoContext,
  respondToSession,
  resumeSession,
  retrySessionPrompt,
  revokeSessionArtifact,
  revokeSessionDesktopViewTicketAuthed,
  setSessionRepo,
  stopSession,
  uploadSandboxArtifact,
  uploadSandboxRollout,
  validatePlatformLlmCapability,
  warmSession,
} from "../session/state";
import { requestCoordinatedVerification } from "../session/verification-coordinator-service";
import { postInternalAlert } from "../slack/internal-alerts";
import { SESSION_FEEDBACK_CHANNEL_ID } from "../slack/internal-channels";
import { uploadFile } from "../slack/notify";
import type {
  AuthInfo,
  CallbackContext,
  Env,
  InternalAuthContext,
  SessionDOResponse,
  SessionViewPayloadMetrics,
  SessionViewReadTiming,
} from "../types";
import {
  asNonEmptyString,
  computeSha256Hex,
  corsOrigin,
  jsonErrorResponse,
  jsonResponse,
  parseJsonBody,
  parsePositiveIntegerUserId,
  resolveSandboxCallbackSecret,
} from "../utils";
import { readCappedWebhookBody } from "../webhooks/body-limit";
import { SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR } from "../webhooks/db";
import {
  hasOversizedPlatformLlmContentLength,
  parsePlatformLlmBrokerBody,
  platformLlmFailureResponse,
} from "./sessions/platform-llm-parser";
import {
  parsePromptFilePaths,
  parseSkillsPayload,
  parseUploadedFilesPayload,
  parseUploadedImagesPayload,
} from "./sessions/prompt-upload-parser";
import {
  parseArtifactFilenameQuery,
  parseChildSessionIncludes,
  parseSessionEventsQuery,
  parseSessionListQuery,
  parseSessionReplayRequest,
  parseSessionWebSocketQuery,
} from "./sessions/query-helpers";
import type { Route, RouteHandler } from "./shared";
import { parseBody, parsePattern, requireRouteAuth } from "./shared";

const log = createLogger({ bindings: { component: "sessions" } });

const ArchiveSessionBodySchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      closePr: z.boolean().optional(),
    })
    .strict(),
);

type ArchiveSessionBody = z.infer<typeof ArchiveSessionBodySchema>;
const SESSION_LIST_DEFAULT_LIMIT = 50;
const SHARED_SESSION_PAGE_FETCH_MULTIPLIER = 5;
const PLAN_APPROVE_MAX_BODY_BYTES = 256;
const approveSessionPlanBodySchema = z.object({
  revision: z.number().int().positive(),
});

type PlanApproveAuditOutcome = "approved" | "idempotent" | "denied" | "stale" | "conflict" | "invalid" | "error";

function logPlanApproveAudit(input: {
  actorUserId: string;
  sessionId: string;
  revision: number | null;
  outcome: PlanApproveAuditOutcome;
  reason?: string | null;
}): void {
  const fields = {
    event: "plan_mode.approve_attempt",
    actorUserId: input.actorUserId,
    sessionId: input.sessionId,
    revision: input.revision,
    source: "web",
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  if (input.outcome === "approved" || input.outcome === "idempotent") {
    log.info(fields, "Plan approval attempt completed");
  } else {
    log.warn(fields, "Plan approval attempt rejected");
  }
}

const PLAN_EDIT_RAW_BODY_MAX_BYTES = PLAN_CAPTURE_MAX_CHARS * 4 + 1024;

const SandboxChildSessionBodySchema = z
  .object({
    prompt: z.string().min(1),
    repositoryId: z.string().min(1),
    title: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

const EditSessionPlanBodySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    markdown: z.string(),
  })
  .strict();

type ParsedSessionPlanEditBody =
  { ok: true; value: { revision: number; markdown: string } } | { ok: false; response: Response };

async function parseSessionPlanEditBody(request: Request): Promise<ParsedSessionPlanEditBody> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return { ok: false, response: jsonErrorResponse("Unsupported content type", 415) };
  }

  const raw = await readCappedWebhookBody(request, PLAN_EDIT_RAW_BODY_MAX_BYTES);
  if (raw instanceof Response) {
    return { ok: false, response: jsonErrorResponse("Request body is too large", 413) };
  }
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: raw,
  });
  const parsed = await parseBody(boundedRequest, EditSessionPlanBodySchema);
  if (!parsed.ok) return parsed;
  if (parsed.value.markdown.length > PLAN_CAPTURE_MAX_CHARS) {
    return { ok: false, response: jsonErrorResponse("Plan markdown is too large", 413) };
  }
  const markdown = normalizePlanMarkdown(parsed.value.markdown);
  if (!markdown) {
    return { ok: false, response: jsonErrorResponse("Plan markdown must not be empty", 400) };
  }
  return { ok: true, value: { revision: parsed.value.revision, markdown } };
}

function auditSessionPlanEdit(input: {
  actorUserId: string;
  sessionId: string;
  revision: number | null;
  outcome: string;
  status: number;
}): void {
  log.info(
    {
      event: "session_plan_edit_audit",
      actorUserId: input.actorUserId,
      sessionId: input.sessionId,
      revision: input.revision,
      source: "web",
      outcome: input.outcome,
      status: input.status,
    },
    "Session plan edit attempt",
  );
}

function waitUntilFromContext(ctx: unknown): ((promise: Promise<unknown>) => void) | undefined {
  if (!ctx || typeof (ctx as { waitUntil?: unknown }).waitUntil !== "function") return undefined;
  return (promise) => (ctx as { waitUntil: (promise: Promise<unknown>) => void }).waitUntil(promise);
}

function sanitizePublicAgentOverrides(
  agents: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!agents) return undefined;
  const sanitized: Record<string, Record<string, unknown>> = {};
  for (const [agentName, override] of Object.entries(agents)) {
    const { useOpenAIFlexServiceTier: _blocked, ...allowedOverride } = override;
    sanitized[agentName] = allowedOverride;
  }
  return sanitized;
}

function isBrowserNavigationRequest(request: Request): boolean {
  const fetchMode = request.headers.get("sec-fetch-mode")?.toLowerCase();
  if (fetchMode === "navigate") return true;
  const fetchDest = request.headers.get("sec-fetch-dest")?.toLowerCase();
  if (fetchDest === "document") return true;
  return request.headers.get("accept")?.toLowerCase().includes("text/html") === true;
}

function isAllowedDesktopViewerWebSocketOrigin(request: Request, env: Env): boolean {
  return request.headers.has("origin") && corsOrigin(request, env) !== null;
}

function localGithubAuthOrigin(env: Pick<Env, "GITHUB_CALLBACK_URL" | "WORKER_ENV">): string | null {
  if (env.WORKER_ENV !== ENVIRONMENT.Local || !env.GITHUB_CALLBACK_URL) return null;
  try {
    return new URL(env.GITHUB_CALLBACK_URL).origin;
  } catch {
    return null;
  }
}

function redirectToGithubAuthWithReturnTo(
  request: Request,
  env: Pick<Env, "GITHUB_CALLBACK_URL" | "WORKER_ENV">,
): Response {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const authOrigin = localGithubAuthOrigin(env) ?? "";
  return new Response(null, {
    status: 302,
    headers: { location: `${authOrigin}/auth/github?returnTo=${encodeURIComponent(returnTo)}` },
  });
}

function isPlatformLlmPlanPayload(value: unknown): value is { ok: true; plan: PlatformLlmCallPlan } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { plan?: unknown }).plan === "object" &&
    (value as { plan?: unknown }).plan !== null
  );
}

async function handlePlatformLlmBrokerRoute(
  request: Request,
  env: Parameters<RouteHandler>[1],
  match: RegExpMatchArray,
  phase: PlatformLlmPhase,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.headers.has("origin")) {
    return jsonErrorResponse("Origin not allowed", 403);
  }
  if (hasOversizedPlatformLlmContentLength(request)) {
    return platformLlmFailureResponse("input_too_large", 413, "platform_llm");
  }

  const sessionId = match.groups!.sessionId;
  const parsed = await parsePlatformLlmBrokerBody(request, phase);
  if (!parsed.ok) return parsed.response;

  const capabilityResponse = await validatePlatformLlmCapability(env, sessionId, request, {
    callType: parsed.value.body.callType,
    phase: parsed.value.body.phase,
    inputBytes: parsed.value.bytes,
  });
  if (!capabilityResponse.ok) return capabilityResponse;

  const planPayload = await capabilityResponse.json().catch(() => null);
  if (!isPlatformLlmPlanPayload(planPayload)) {
    return jsonErrorResponse("Invalid platform LLM capability response", 500);
  }

  const result = await executePlatformLlmCall(env, planPayload.plan, parsed.value.body.input, request.signal, {
    fetchImpl: tracedFetch,
  });
  ctx?.waitUntil(
    postStructuredEventToDd(env, {
      event: "platform_llm.call_completed",
      sessionId,
      promptId: planPayload.plan.promptId,
      callType: planPayload.plan.callType,
      phase: planPayload.plan.phase,
      sandboxId: planPayload.plan.sandboxId,
      provider: planPayload.plan.provider,
      model: planPayload.plan.model,
      outcome: result.response.ok ? "success" : "failure",
      failureCategory: result.response.ok ? null : result.response.category,
      durationMs: result.response.durationMs,
      timeoutMs: planPayload.plan.timeoutMs,
      inputBytes: parsed.value.bytes,
      attempts: result.response.attempts,
      capabilityValidated: true,
      capabilityConsumed: true,
    }),
  );

  return jsonResponse(result.response, result.status);
}

function formatSessionCreateFailure(phase: "initialize" | "persist", error: unknown): string {
  const message = stringifyError(error);
  return `Session creation failed during ${phase}: ${message}`;
}

function providerCredentialErrorResponse(error: ProviderCredentialNotValidatedError): Response {
  return jsonErrorResponse(PROVIDER_KEY_NOT_VALIDATED_ERROR, 409, {
    provider: error.provider,
    modelId: error.modelId,
    reasonCode: error.reasonCode,
    message: error.message,
  });
}

function opencodeAccessDeniedResponse(): Response {
  return jsonErrorResponse(OPENCODE_ACCESS_DENIED_ERROR, 403, {
    message: "opencode is only available to Cycloid team members",
  });
}

async function withSession(
  request: Request,
  env: Parameters<RouteHandler>[1],
  match: RegExpMatchArray,
  auth: AuthInfo | null,
  fn: (
    sessionId: string,
    session: Awaited<ReturnType<typeof getSessionState>> & object,
    requestId: string | null,
    authCtx: InternalAuthContext,
  ) => Promise<Response>,
  onOrphan?: (sessionId: string) => void | Promise<void>,
): Promise<Response> {
  const routeAuth = requireRouteAuth(auth);
  const sessionId = match.groups!.sessionId;
  const requestId = extractRequestId(request);
  const session = await getSessionState(env, sessionId, requestId);
  if (!session) {
    if (onOrphan && env.DB) {
      const row = await getSessionIndexIdentity(env.DB, sessionId);
      if (row && canAccessSessionIdentity(routeAuth, String(row.ownerUserId), row.businessId)) {
        await onOrphan(sessionId);
      }
    }
    return jsonErrorResponse("Session not found", 404);
  }
  if (!canAccessSession(routeAuth, session)) {
    return jsonErrorResponse("Session not found", 404);
  }
  const repoAccess = await authorizeSessionRepoAccess(
    env,
    routeAuth,
    sessionId,
    session as SessionRouteState,
    "access",
  );
  if (!repoAccess.ok) return repoAccess.response;
  return fn(sessionId, session, requestId, repoAccess.authCtx);
}

const DESKTOP_VIEW_RATE_LIMIT_RETRY_AFTER_SECONDS = 2;

async function emitDesktopRateLimited(
  env: Parameters<RouteHandler>[1],
  ctx: ExecutionContext | undefined,
  routeClass: string,
  sessionId: string,
  viewerUserId: string,
  rateLimit: DurableObjectRateLimitResult,
): Promise<void> {
  const payload = {
    event: "desktop.rate_limited",
    eventSource: "route",
    routeClass,
    sessionIdHash: await computeSha256Hex(sessionId),
    viewerUserIdHash: await computeSha256Hex(viewerUserId),
    retryAfterSeconds: rateLimit.retryAfterSeconds ?? DESKTOP_VIEW_RATE_LIMIT_RETRY_AFTER_SECONDS,
    resetAtMs: rateLimit.resetAtMs,
    remaining: rateLimit.remaining,
    max: rateLimit.max,
    windowSeconds: rateLimit.windowSeconds,
  };
  log.warn(payload, "Desktop route rate limited");
  ctx?.waitUntil(postStructuredEventToDd(env, payload));
}

function desktopRateLimitedResponse(message: string, rateLimit: DurableObjectRateLimitResult): Response {
  const retryAfterSeconds = rateLimit.retryAfterSeconds ?? DESKTOP_VIEW_RATE_LIMIT_RETRY_AFTER_SECONDS;
  return jsonResponse(
    {
      ok: false,
      code: "desktop_view_rate_limited",
      error: message,
      retryAfterSeconds,
      resetAtMs: rateLimit.resetAtMs,
      remaining: rateLimit.remaining,
      max: rateLimit.max,
      windowSeconds: rateLimit.windowSeconds,
    },
    429,
    {
      "Retry-After": String(retryAfterSeconds),
    },
  );
}

function desktopTicketErrorResponse(status: number): Response {
  switch (status) {
    case 400:
      return jsonErrorResponse("Invalid desktop viewing ticket request", 400);
    case 403:
      return jsonErrorResponse("Forbidden: desktop viewing ticket is not owned by this user", 403);
    case 404:
      return jsonErrorResponse("Desktop viewing ticket not found", 404);
    case 409:
      return jsonErrorResponse("Desktop viewing ticket conflict", 409);
    case 410:
      return jsonErrorResponse("Desktop viewing ticket is no longer valid", 410);
    default:
      return jsonErrorResponse("Desktop viewing ticket operation failed", 500);
  }
}

function desktopHeartbeatBody(ticketId: string): DesktopViewTicketHeartbeatRequest {
  return { ticketId };
}

function desktopRevokeBody(ticketId: string): DesktopViewTicketRevokeRequest {
  return { ticketId };
}

function desktopStatusBody(ticketId: string): DesktopViewTicketStatusRequest {
  return { ticketId };
}

function desktopConnectBody(ticketId: string, connectionId: string): DesktopViewTicketConnectRequest {
  return { ticketId, connectionId };
}

function desktopCloseBody(
  ticketId: string,
  connectionId: string,
  reason: string,
  detail?: string | null,
  diagnostics?: DesktopViewTicketCloseDiagnostics | null,
): DesktopViewTicketCloseRequest {
  return { ticketId, connectionId, reason, detail: detail ?? null, diagnostics: diagnostics ?? null };
}

async function closeDesktopTicketAfterProxy(
  env: Parameters<RouteHandler>[1],
  sessionId: string,
  requestId: string | null,
  authCtx: InternalAuthContext,
  ticketId: string,
  connectionId: string,
  reason: string,
  detail?: string | null,
  diagnostics?: DesktopViewTicketCloseDiagnostics | null,
): Promise<void> {
  await closeSessionDesktopViewTicketAuthed(env, sessionId, requestId, authCtx, {
    ticketId,
    connectionId,
    reason,
    detail,
    diagnostics,
  });
}

type DesktopProxyTelemetryIdentity = {
  sessionIdHash: string;
  viewerUserIdHash: string;
  ticketIdHash: string;
  connectionId: string;
};

async function buildDesktopProxyTelemetryIdentity(
  sessionId: string,
  viewerUserId: string,
  ticketId: string,
  connectionId: string,
): Promise<DesktopProxyTelemetryIdentity> {
  return {
    sessionIdHash: await computeSha256Hex(sessionId),
    viewerUserIdHash: await computeSha256Hex(viewerUserId),
    ticketIdHash: await computeSha256Hex(ticketId),
    connectionId,
  };
}

function desktopCloseDiagnosticsFromResolve(
  diagnostics: DesktopViewerUpstreamResolveDiagnostics,
): DesktopViewTicketCloseDiagnostics {
  return {
    phase: diagnostics.phase,
    reason: diagnostics.reason,
    durationMs: diagnostics.durationMs,
    statusCode: diagnostics.statusCode,
    retryable: diagnostics.retryable,
    sandboxStatus: diagnostics.sandboxStatus,
    runtimeState: diagnostics.runtimeState,
    runtimeBackend: diagnostics.runtimeBackend,
    supervisorExitCode: diagnostics.supervisorExitCode,
    supervisorHealthStatus: diagnostics.supervisorHealthStatus,
    supervisorHealthFailedComponent: diagnostics.supervisorHealthFailedComponent,
    supervisorHealthFailedPhase: diagnostics.supervisorHealthFailedPhase,
    supervisorHealthLastError: diagnostics.supervisorHealthLastError,
    supervisorHealthDisplay: diagnostics.supervisorHealthDisplay,
    supervisorHealthWidth: diagnostics.supervisorHealthWidth,
    supervisorHealthHeight: diagnostics.supervisorHealthHeight,
    supervisorHealthScreenshotOk: diagnostics.supervisorHealthScreenshotOk,
    supervisorHealthScreenshotNonBlackPixelRatio: diagnostics.supervisorHealthScreenshotNonBlackPixelRatio,
    supervisorHealthScreenshotEntropy: diagnostics.supervisorHealthScreenshotEntropy,
    supervisorHealthScreenshotUniform: diagnostics.supervisorHealthScreenshotUniform,
    supervisorHealthVncReachable: diagnostics.supervisorHealthVncReachable,
    supervisorHealthNovncReachable: diagnostics.supervisorHealthNovncReachable,
    supervisorHealthLoopbackOnly: diagnostics.supervisorHealthLoopbackOnly,
    providerErrorCode: diagnostics.providerErrorCode,
    providerErrorStatus: diagnostics.providerErrorStatus,
    providerErrorRetryAfterMs: diagnostics.providerErrorRetryAfterMs,
    providerErrorRequestSent: diagnostics.providerErrorRequestSent,
    upstreamHostPresent: diagnostics.upstreamHostPresent,
    trafficAccessTokenPresent: diagnostics.trafficAccessTokenPresent,
  };
}

function desktopCloseDiagnosticsFromWebSocket(
  diagnostics: DesktopViewerWebSocketCloseDiagnostics,
): DesktopViewTicketCloseDiagnostics {
  return {
    websocketCloseSource: diagnostics.source,
    websocketCloseCode: diagnostics.code,
    websocketCloseReason: diagnostics.socketReason,
    websocketCloseWasClean: diagnostics.wasClean,
  };
}

async function buildDesktopProxyUpstreamResolveEvent(
  identity: DesktopProxyTelemetryIdentity,
  diagnostics: DesktopViewerUpstreamResolveDiagnostics,
  status: "ready" | "failed",
): Promise<Record<string, unknown>> {
  const supervisorStderrTail = diagnostics.supervisorStderr ? diagnostics.supervisorStderr.slice(-500) : null;
  return {
    event: "desktop.proxy_upstream_resolve",
    eventSource: "route",
    status,
    ...identity,
    phase: diagnostics.phase,
    reason: diagnostics.reason,
    statusCode: diagnostics.statusCode,
    durationMs: diagnostics.durationMs,
    retryable: diagnostics.retryable,
    sandboxStatus: diagnostics.sandboxStatus,
    runtimeState: diagnostics.runtimeState,
    runtimeBackend: diagnostics.runtimeBackend,
    runtimeSandboxIdHash: diagnostics.runtimeSandboxId ? await computeSha256Hex(diagnostics.runtimeSandboxId) : null,
    supervisorExitCode: diagnostics.supervisorExitCode,
    supervisorStderrTail,
    supervisorStderrTailLength: supervisorStderrTail?.length ?? 0,
    supervisorHealthStatus: diagnostics.supervisorHealthStatus,
    supervisorHealthFailedComponent: diagnostics.supervisorHealthFailedComponent,
    supervisorHealthFailedPhase: diagnostics.supervisorHealthFailedPhase,
    supervisorHealthLastError: diagnostics.supervisorHealthLastError,
    supervisorHealthDisplay: diagnostics.supervisorHealthDisplay,
    supervisorHealthWidth: diagnostics.supervisorHealthWidth,
    supervisorHealthHeight: diagnostics.supervisorHealthHeight,
    supervisorHealthScreenshotOk: diagnostics.supervisorHealthScreenshotOk,
    supervisorHealthScreenshotNonBlackPixelRatio: diagnostics.supervisorHealthScreenshotNonBlackPixelRatio,
    supervisorHealthScreenshotEntropy: diagnostics.supervisorHealthScreenshotEntropy,
    supervisorHealthScreenshotUniform: diagnostics.supervisorHealthScreenshotUniform,
    supervisorHealthVncReachable: diagnostics.supervisorHealthVncReachable,
    supervisorHealthNovncReachable: diagnostics.supervisorHealthNovncReachable,
    supervisorHealthLoopbackOnly: diagnostics.supervisorHealthLoopbackOnly,
    providerErrorCode: diagnostics.providerErrorCode,
    providerErrorStatus: diagnostics.providerErrorStatus,
    providerErrorRetryAfterMs: diagnostics.providerErrorRetryAfterMs,
    providerErrorRequestSent: diagnostics.providerErrorRequestSent,
    upstreamHostPresent: diagnostics.upstreamHostPresent,
    trafficAccessTokenPresent: diagnostics.trafficAccessTokenPresent,
  };
}

function buildDesktopProxyWebSocketHandshakeEvent(
  identity: DesktopProxyTelemetryIdentity,
  diagnostics: DesktopViewerWebSocketHandshakeDiagnostics,
): Record<string, unknown> {
  return {
    event: "desktop.proxy_ws_handshake",
    eventSource: "route",
    status: diagnostics.hasWebSocket ? "connected" : "failed",
    ...identity,
    statusCode: diagnostics.statusCode,
    hasWebSocket: diagnostics.hasWebSocket,
    closeReason: diagnostics.closeReason,
    reason: diagnostics.closeReason,
    errorType: diagnostics.errorType,
    errorMessage: diagnostics.errorMessage,
    durationMs: diagnostics.durationMs,
  };
}

function desktopProxyHandshakeCloseDetail(diagnostics: DesktopViewerWebSocketHandshakeDiagnostics): string | null {
  if (!diagnostics.closeReason) return null;
  if (diagnostics.closeReason === "proxy_failed") {
    const message = diagnostics.errorMessage?.toLowerCase() ?? "";
    if (message.includes("unsupported") && message.includes("scheme"))
      return "proxy_handshake.upstream_fetch_url_rejected";
    return diagnostics.errorType
      ? `proxy_handshake.fetch_exception_${diagnostics.errorType}`
      : "proxy_handshake.fetch_exception";
  }
  if (!diagnostics.hasWebSocket && diagnostics.statusCode !== null) {
    return `proxy_handshake.upstream_http_${diagnostics.statusCode}`;
  }
  return `proxy_handshake.${diagnostics.closeReason}`;
}

async function withSessionHistoryIdentity(
  request: Request,
  env: Parameters<RouteHandler>[1],
  match: RegExpMatchArray,
  auth: AuthInfo | null,
  fn: (sessionId: string, requestId: string | null, authCtx: InternalAuthContext) => Promise<Response>,
): Promise<Response> {
  const routeAuth = requireRouteAuth(auth);
  const sessionId = match.groups!.sessionId;
  const requestId = extractRequestId(request);
  if (!env.DB) return jsonErrorResponse("Session not found", 404);
  const baseIdentity = await getSessionIndexIdentity(env.DB, sessionId);
  if (!baseIdentity) {
    return withSession(
      request,
      env,
      match,
      routeAuth,
      async (fallbackSessionId, _session, fallbackRequestId, authCtx) =>
        fn(fallbackSessionId, fallbackRequestId, authCtx),
    );
  }
  if (!canAccessSessionIdentity(routeAuth, String(baseIdentity.ownerUserId), baseIdentity.businessId)) {
    return jsonErrorResponse("Session not found", 404);
  }
  const needsRepoIdentity = !routeAuth.canAccessAllSessions && String(baseIdentity.ownerUserId) !== routeAuth.userId;
  const identity = needsRepoIdentity ? await getSessionIndexIdentityWithRepo(env.DB, sessionId) : baseIdentity;
  if (!identity || !canAccessSessionIdentity(routeAuth, String(identity.ownerUserId), identity.businessId)) {
    return jsonErrorResponse("Session not found", 404);
  }
  const session = {
    sessionId,
    ownerUserId: String(identity.ownerUserId),
    businessId: identity.businessId,
    repoOwner: "repoOwner" in identity ? identity.repoOwner : null,
    repoName: "repoName" in identity ? identity.repoName : null,
  } as SessionRouteState;
  const repoAccess = await authorizeSessionRepoAccess(env, routeAuth, sessionId, session, "access");
  if (!repoAccess.ok) return repoAccess.response;
  return fn(sessionId, requestId, repoAccess.authCtx);
}

function toInternalAuthContext(auth: AuthInfo): InternalAuthContext {
  return {
    userId: auth.userId,
    canAccessAllSessions: auth.canAccessAllSessions,
    businessId: auth.user?.businessId ?? null,
    sharedSessions: auth.user?.sharedSessions ?? false,
    businessMemberIds: auth.user?.sharedSessions ? auth.user.businessMemberIds : undefined,
    email: auth.user?.email ?? null,
    username: auth.user?.login ?? null,
    ...(auth.impersonationId ? { impersonationId: auth.impersonationId } : {}),
    ...(auth.readOnly ? { readOnly: true } : {}),
  };
}

export type SessionRouteState = NonNullable<Awaited<ReturnType<typeof getSessionState>>> & {
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
  installationId?: number | null;
  status?: string;
};

function normalizePublicSessionPayload(
  session: Awaited<ReturnType<typeof getSessionState>> & object,
): Record<string, unknown> {
  const sessionRecord = session as Record<string, unknown>;
  const publicSessionRecord = { ...sessionRecord };
  delete publicSessionRecord.planAutoReason;
  const phase = typeof sessionRecord.phase === "string" ? sessionRecord.phase : null;
  return phase ? { ...publicSessionRecord, status: phase } : publicSessionRecord;
}

type SessionRepoAccessResult =
  { ok: true; authCtx: InternalAuthContext } | { ok: false; response: Response; status: 403 | 404 | 503 };

type ResumableSendLogContext = {
  runtimeProvider: string | null;
  runtimeState: string | null;
  runtimeStateExpiresAt: number | null;
  stopReason: string | null;
  activePromptIdFromDb: string | null;
};

function getRepoContextFromSession(session: SessionRouteState): { repoOwner: string; repoName: string } | null {
  const repoOwner = typeof session.repoOwner === "string" && session.repoOwner.length > 0 ? session.repoOwner : null;
  const repoName = typeof session.repoName === "string" && session.repoName.length > 0 ? session.repoName : null;
  return repoOwner && repoName ? { repoOwner, repoName } : null;
}

function getSessionViewerRelation(auth: AuthInfo, session: SessionRouteState): SessionWsViewerRelation {
  if (auth.canAccessAllSessions) return "admin";
  return session.ownerUserId === auth.userId ? "owner" : "shared";
}

function isResumableSendSession(session: SessionRouteState): boolean {
  // Resumable stop: sandbox was reaped or spawn failed but the next prompt should
  // auto-resume by cold-spawning a new sandbox. Distinct from a user-initiated
  // hard stop which blocks new prompts.
  const s = session as { phase?: string; sandboxStatus?: string; stopMode?: string; stopReason?: string | null };
  if (s.phase === "stopped") return s.stopMode !== "user";
  return s.phase === "completed" && s.sandboxStatus === "stopped" && s.stopReason !== "user";
}

async function getResumableSendLogContext(
  env: Parameters<RouteHandler>[1],
  sessionId: string,
  requestId: string | null,
  authCtx: InternalAuthContext,
): Promise<ResumableSendLogContext> {
  const view = await getSessionView(env, sessionId, requestId, authCtx);
  const session = view.ok ? (view.payload?.session as Record<string, unknown> | undefined) : undefined;
  const queue = view.ok ? view.payload?.queue : undefined;
  return {
    runtimeProvider: typeof session?.runtimeProvider === "string" ? session.runtimeProvider : null,
    runtimeState: typeof session?.runtimeState === "string" ? session.runtimeState : null,
    runtimeStateExpiresAt: typeof session?.runtimeStateExpiresAt === "number" ? session.runtimeStateExpiresAt : null,
    stopReason: typeof session?.stopReason === "string" ? session.stopReason : null,
    activePromptIdFromDb: typeof queue?.processingPromptId === "string" ? queue.processingPromptId : null,
  };
}

function classifyResumableSendDecision(context: ResumableSendLogContext): string {
  const hasPausedManagedRuntime = isKnownRuntimeProvider(context.runtimeProvider) && context.runtimeState === "paused";
  if (hasPausedManagedRuntime) {
    return context.runtimeStateExpiresAt != null && context.runtimeStateExpiresAt <= Date.now() ? "expired" : "live";
  }
  return "cold";
}

export function classifyResumableSendErrorDecision(status: number, error: string | null | undefined): string {
  if (status === 429) return "reject-rate-limit";
  if (status === 403) return "reject-access";
  if (status === 400) return "reject-invalid-request";
  if (status === 409) {
    if (error === "Session is archived. Start a new session to continue.") return "reject-archived";
    if (error === "Session is closed") return "reject-closed";
    return "reject-conflict";
  }
  return "reject-error";
}

function resumableSendErrorResponse(status: number, error: string | null | undefined): Response | null {
  if (status === 404) return jsonErrorResponse("Session not found", 404);
  if (status === 409) {
    return jsonResponse({ ok: false, error: error ?? "Session is closed" }, 409);
  }
  if (status === 400 || status === 403 || status === 429) {
    return jsonResponse({ ok: false, error: error ?? "Request failed" }, status);
  }
  return null;
}

async function getBoundedChildParentMetadata(
  db: D1Database,
  childRow: ChildSessionRow | null,
  sessionBusinessId: string | null,
): Promise<{ parentSessionId: string; parentPromptId: string; spawnDepth: number } | null> {
  if (!childRow || childRow.business_id !== sessionBusinessId) return null;
  const parent = await getParentSessionRow(db, childRow.parent_session_id);
  if (!parent || parent.business_id !== sessionBusinessId) return null;
  return {
    parentSessionId: childRow.parent_session_id,
    parentPromptId: childRow.parent_prompt_id,
    spawnDepth: childRow.spawn_depth,
  };
}

type SessionViewTimingSpan = {
  setAttribute: (key: string, value: string | number | boolean) => void;
};

function recordSessionViewTiming(
  span: SessionViewTimingSpan,
  prefix: string,
  timing: SessionViewReadTiming | null | undefined,
): void {
  if (!timing) return;
  span.setAttribute(`session.view.${prefix}_ms`, timing.durationMs);
  span.setAttribute(`session.view.${prefix}_outcome`, timing.outcome);
  if (timing.errorClass) span.setAttribute(`session.view.${prefix}_error_class`, timing.errorClass);
  if (timing.requestedCount !== undefined)
    span.setAttribute(`session.view.${prefix}_requested_count`, timing.requestedCount);
  if (timing.uncachedCount !== undefined)
    span.setAttribute(`session.view.${prefix}_uncached_count`, timing.uncachedCount);
}

function recordSessionViewDoMetrics(
  span: SessionViewTimingSpan,
  metrics: SessionViewPayloadMetrics | null | undefined,
): void {
  if (!metrics) return;
  span.setAttribute("session.view.do_build_ms", metrics.doBuildMs);
  recordSessionViewTiming(span, "do_prompt_actor_profiles", metrics.doPromptActorProfiles);
  recordSessionViewTiming(span, "do_owner_actor_profile", metrics.doOwnerActorProfile);
  recordSessionViewTiming(span, "do_spine_done_mirror", metrics.doSpineDoneMirror);
}

export async function authorizeSessionRepoAccess(
  env: Parameters<RouteHandler>[1],
  auth: AuthInfo,
  sessionId: string,
  session: SessionRouteState,
  operation: string,
  span?: { setAttribute: (key: string, value: string) => void },
): Promise<SessionRepoAccessResult> {
  const authCtx = toInternalAuthContext(auth);
  if (auth.canAccessAllSessions || session.ownerUserId === auth.userId) {
    return { ok: true, authCtx };
  }

  const repo = getRepoContextFromSession(session);
  if (!repo) {
    // Fail closed: with no resolvable repo context we cannot prove the
    // non-owner caller has GitHub access, so a shared-business member must not
    // reach a teammate's session by id. This matches the session-list filter,
    // which hides null-repo rows from shared members; returning 404 keeps
    // direct-by-id access consistent and does not leak the session's existence.
    // (Owners and all-session operators already returned above, so legitimate
    // owner/admin access to a not-yet-populated session is unaffected.)
    log.warn(
      { sessionId, userId: auth.userId, operation },
      `Session ${operation} rejected: repo context missing, cannot verify repo access`,
    );
    return {
      ok: false,
      status: 404,
      response: jsonErrorResponse("Session not found", 404),
    };
  }

  let hasAccess: boolean;
  try {
    hasAccess = await withRouteSpan(
      `sessions.${operation}.repo_access`,
      { auth, attributes: { "session.id": sessionId, "repo.owner": repo.repoOwner, "repo.name": repo.repoName } },
      () =>
        verifyUserRepoAccess(env.DB, auth.userId, repo.repoOwner, repo.repoName, {
          githubTokenEnv: env,
          reposCacheEnv: env,
          sessionViewCache: { sessionId },
        }),
    );
  } catch (err) {
    span?.setAttribute("error.message", String(err));
    log.error(
      { sessionId, repoOwner: repo.repoOwner, repoName: repo.repoName, userId: auth.userId, error: String(err) },
      `Session ${operation} rejected: repo access verification unavailable`,
    );
    return {
      ok: false,
      status: 503,
      response: jsonErrorResponse("Unable to verify repository access. Please try again.", 503),
    };
  }

  if (!hasAccess) {
    log.warn(
      { sessionId, repoOwner: repo.repoOwner, repoName: repo.repoName, userId: auth.userId },
      `Session ${operation} rejected: user does not have GitHub access to repo`,
    );
    return {
      ok: false,
      status: 403,
      response: jsonErrorResponse("You do not have access to this repository on GitHub", 403),
    };
  }

  return {
    ok: true,
    authCtx: {
      ...authCtx,
      repoAccessVerifiedSessionId: sessionId,
      repoAccessVerifiedRepoOwner: repo.repoOwner,
      repoAccessVerifiedRepoName: repo.repoName,
    },
  };
}

type SharedBusinessRepoAccessSnapshot = {
  accessibleRepos: Set<string>;
  cacheStatus: string;
  durationMs: number;
  noToken: boolean;
  snapshotCalls: number;
};

async function getSharedBusinessRepoAccessSnapshot(
  env: Parameters<RouteHandler>[1],
  auth: AuthInfo,
): Promise<{ ok: true; data: SharedBusinessRepoAccessSnapshot } | { ok: false; response: Response }> {
  const repoAccessStart = performance.now();
  let repoAccess: Awaited<ReturnType<typeof listAccessibleReposForUser>>;
  try {
    repoAccess = await listAccessibleReposForUser(env, auth.userId);
  } catch (err) {
    log.error({ userId: auth.userId, error: String(err) }, "Shared business session list repo access snapshot threw");
    return { ok: false, response: jsonErrorResponse("Unable to verify repository access. Please try again.", 503) };
  }
  const repoAccessDurationMs = performance.now() - repoAccessStart;

  if (!repoAccess.ok) {
    // Only a genuinely absent GitHub token yields an empty contribution. A present
    // but rejected token (expired/revoked, refresh failed) is an auth failure: fail
    // closed with 503 instead of silently emptying the whole shared list (L35).
    if (repoAccess.status === 401 && repoAccess.tokenReason === "token_missing") {
      return {
        ok: true,
        data: {
          accessibleRepos: new Set(),
          cacheStatus: "none",
          durationMs: repoAccessDurationMs,
          noToken: true,
          snapshotCalls: 1,
        },
      };
    }
    log.error(
      { userId: auth.userId, status: repoAccess.status, tokenReason: repoAccess.tokenReason, error: repoAccess.error },
      "Shared business session list repo access snapshot failed",
    );
    return { ok: false, response: jsonErrorResponse("Unable to verify repository access. Please try again.", 503) };
  }

  return {
    ok: true,
    data: {
      accessibleRepos: new Set(repoAccess.repos.map((repo) => repo.fullName.trim().toLowerCase()).filter(Boolean)),
      cacheStatus: repoAccess.cacheStatus,
      durationMs: repoAccessDurationMs,
      noToken: false,
      snapshotCalls: 1,
    },
  };
}

function filterSharedBusinessSessionsByRepoAccess(
  rows: Awaited<ReturnType<typeof listSessions>>["data"],
  repoAccessSnapshot: SharedBusinessRepoAccessSnapshot,
  span: RouteSpanRecorder,
): { ok: true; data: typeof rows } {
  const startedAt = performance.now();
  const visible: typeof rows = [];
  let rowsProcessed = 0;
  let missingRepoContextCount = 0;
  const batchCount = rows.length === 0 ? 0 : 1;
  const setFilterAttributes = () => {
    const filteredCount = rowsProcessed - visible.length;
    span.setAttributes({
      "sessions.shared.rows_considered": rows.length,
      "sessions.shared.rows_processed": rowsProcessed,
      "sessions.shared.session_state_reads": 0,
      "sessions.shared.batch_count": batchCount,
      "sessions.shared.page_size": rows.length,
      "sessions.shared.session_state_duration_ms": 0,
      "sessions.shared.repo_snapshot_calls": repoAccessSnapshot.snapshotCalls,
      "sessions.shared.repo_access_duration_ms": Math.round(repoAccessSnapshot.durationMs),
      "sessions.shared.repo_access_cache_status": repoAccessSnapshot.cacheStatus,
      "sessions.shared.rows_visible": visible.length,
      "sessions.shared.rows_filtered": filteredCount,
      "sessions.shared.missing_repo_context": missingRepoContextCount,
      "sessions.shared.filter_duration_ms": Math.round(performance.now() - startedAt),
    });
    log.info(
      {
        rowsConsidered: rows.length,
        rowsProcessed,
        sessionStateReads: 0,
        batchCount,
        pageSize: rows.length,
        sessionStateDurationMs: 0,
        repoSnapshotCalls: repoAccessSnapshot.snapshotCalls,
        repoAccessDurationMs: Math.round(repoAccessSnapshot.durationMs),
        repoAccessCacheStatus: repoAccessSnapshot.cacheStatus,
        rowsVisible: visible.length,
        rowsFiltered: filteredCount,
        missingRepoContextCount,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "Shared business session list repo filter completed",
    );
  };

  for (const row of rows) {
    rowsProcessed += 1;
    const repoOwner = typeof row.repo_owner === "string" && row.repo_owner.length > 0 ? row.repo_owner : null;
    const repoName = typeof row.repo_name === "string" && row.repo_name.length > 0 ? row.repo_name : null;
    if (!repoOwner || !repoName) {
      // Pre-migration rows intentionally stay hidden until a later projection sync
      // populates repo context; falling back to DO reads would reopen the slow path.
      missingRepoContextCount += 1;
      continue;
    }
    if (repoAccessSnapshot.accessibleRepos.has(`${repoOwner}/${repoName}`.trim().toLowerCase())) {
      visible.push(row);
    }
  }
  setFilterAttributes();
  return { ok: true, data: visible };
}

async function listSharedBusinessSessions(
  env: Parameters<RouteHandler>[1],
  auth: AuthInfo,
  db: D1Database,
  statusFilter: string | null,
  pagination: { cursor: string | null; limit: number | undefined },
  search: SessionSearchOptions,
  span: RouteSpanRecorder,
): Promise<
  | { ok: true; data: Awaited<ReturnType<typeof listSessions>>["data"]; nextCursor: string | null }
  | { ok: false; response: Response }
> {
  const targetLimit = pagination.limit ?? SESSION_LIST_DEFAULT_LIMIT;
  const pageLimit = Math.min(100, Math.max(targetLimit + 1, targetLimit * SHARED_SESSION_PAGE_FETCH_MULTIPLIER));
  const searchActive = hasActiveSessionSearch(search);
  const visible: Awaited<ReturnType<typeof listSessions>>["data"] = [];
  let cursor = pagination.cursor;
  let nextCursor: string | null = null;
  let repoAccessSnapshot: SharedBusinessRepoAccessSnapshot | null = null;

  while (visible.length < targetLimit) {
    const page = await listSessions(db, null, statusFilter, {
      cursor,
      limit: pageLimit,
      businessId: auth.user!.businessId!,
      excludeOwnerUserId: auth.userId,
      search,
    });
    if (page.data.length === 0) {
      nextCursor = null;
      break;
    }

    const remaining = targetLimit - visible.length;
    if (!repoAccessSnapshot) {
      const snapshotResult = await getSharedBusinessRepoAccessSnapshot(env, auth);
      if (!snapshotResult.ok) return snapshotResult;
      repoAccessSnapshot = snapshotResult.data;
      if (repoAccessSnapshot.noToken) {
        span.setAttributes({
          "sessions.shared.repo_snapshot_calls": repoAccessSnapshot.snapshotCalls,
          "sessions.shared.repo_access_duration_ms": Math.round(repoAccessSnapshot.durationMs),
          "sessions.shared.repo_access_cache_status": repoAccessSnapshot.cacheStatus,
        });
        return { ok: true, data: [], nextCursor: null };
      }
    }
    const filtered = filterSharedBusinessSessionsByRepoAccess(page.data, repoAccessSnapshot, span);
    visible.push(...filtered.data);

    if (visible.length >= targetLimit) {
      nextCursor =
        filtered.data.length > remaining || page.nextCursor
          ? encodeSessionListCursor(visible[targetLimit - 1], searchActive)
          : null;
      break;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      nextCursor = null;
      break;
    }
    cursor = page.nextCursor;
    nextCursor = page.nextCursor;
  }

  return { ok: true, data: visible.slice(0, targetLimit), nextCursor };
}

export async function resolveAndRefreshSessionResumeAccess(
  env: Parameters<RouteHandler>[1],
  auth: AuthInfo,
  sessionId: string,
  session: SessionRouteState,
): Promise<{ ok: true; installationId: number } | { ok: false; response: Response }> {
  const repoOwner = typeof session.repoOwner === "string" && session.repoOwner.length > 0 ? session.repoOwner : null;
  const repoName = typeof session.repoName === "string" && session.repoName.length > 0 ? session.repoName : null;
  if (!repoOwner || !repoName) {
    return { ok: false, response: jsonErrorResponse("Session repository context is missing", 409) };
  }

  const gate = await verifyRepoAccessAndInstallation(
    env.DB,
    {
      userId: auth.userId,
      canAccessAllSessions: !!auth.canAccessAllSessions,
      businessRole: auth.user?.businessRole ?? null,
    },
    repoOwner,
    repoName,
    { githubTokenEnv: env, sessionId, reposCacheEnv: env },
  );
  if (!gate.ok) {
    // DM the owner only on a true repo-access denial (not install-missing /
    // unverifiable). Valuable for a scheduled resume the owner isn't watching;
    // a synchronous create/resume also gets the HTTP error. Route-triggered, so
    // KV-only dedup; no callbackContext here. dedupKey = sessionId.
    const ownerUserId = Number(session.ownerUserId);
    if (gate.reason === "repo_access_denied" && Number.isSafeInteger(ownerUserId) && ownerUserId > 0) {
      // Await, not fire-and-forget: a route's floating promise can be dropped by
      // the Workers runtime once the Response dispatches, and this DM is the only
      // signal the owner gets on a scheduled resume. notifyUserBlocked never throws.
      await notifyUserBlocked(env as Env, {
        sessionId,
        ownerUserId,
        kind: BlockerKind.RepoAccessDenied,
        dedupKey: sessionId,
      });
    }
    return gate;
  }

  const baseBranch =
    typeof session.baseBranch === "string" && session.baseBranch.length > 0 ? session.baseBranch : undefined;
  const updateResult = await setSessionRepo(env, sessionId, repoOwner, repoName, baseBranch, gate.installationId);
  if (!updateResult.ok) {
    log.error(
      { sessionId, repoOwner, repoName, installationId: gate.installationId },
      "Failed to refresh session repo context before resume",
    );
    return { ok: false, response: jsonErrorResponse("Failed to refresh session repository context", 500) };
  }

  const previousInstallationId = typeof session.installationId === "number" ? session.installationId : null;
  log.info(
    {
      sessionId,
      userId: auth.userId,
      repoOwner,
      repoName,
      installationId: gate.installationId,
      installationChanged: previousInstallationId !== gate.installationId,
    },
    "Session resume access validated",
  );

  return { ok: true, installationId: gate.installationId };
}

type ChildSessionCreateOutcome = "invalid_input" | "forbidden" | "limit_exceeded" | "not_found" | "upstream_error";

const CHILD_SESSION_ERROR_HANDLING: Record<
  ChildSessionErrorCode["code"],
  { httpStatus: number; outcome: ChildSessionCreateOutcome }
> = {
  missing_field: { httpStatus: 400, outcome: "invalid_input" },
  invalid_input: { httpStatus: 400, outcome: "invalid_input" },
  invalid_repo: { httpStatus: 400, outcome: "invalid_input" },
  invalid_model: { httpStatus: 400, outcome: "invalid_input" },
  depth_limit_exceeded: { httpStatus: 429, outcome: "limit_exceeded" },
  max_children_per_prompt: { httpStatus: 429, outcome: "limit_exceeded" },
  max_children_per_session: { httpStatus: 429, outcome: "limit_exceeded" },
  concurrent_limit_exceeded: { httpStatus: 429, outcome: "limit_exceeded" },
  cross_repo_not_supported: { httpStatus: 403, outcome: "forbidden" },
  unauthorized_repo: { httpStatus: 403, outcome: "forbidden" },
  integration_gating_failed: { httpStatus: 403, outcome: "forbidden" },
  parent_not_found: { httpStatus: 404, outcome: "not_found" },
  not_found: { httpStatus: 404, outcome: "not_found" },
  internal_error: { httpStatus: 500, outcome: "upstream_error" },
};

function childSessionErrorStatus(code: string): number {
  return (CHILD_SESSION_ERROR_HANDLING as Partial<Record<string, { httpStatus: number }>>)[code]?.httpStatus ?? 400;
}

function childSessionCreateOutcomeForCode(code: string): ChildSessionCreateOutcome {
  return (
    (CHILD_SESSION_ERROR_HANDLING as Partial<Record<string, { outcome: ChildSessionCreateOutcome }>>)[code]?.outcome ??
    "upstream_error"
  );
}

async function createSandboxChildSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parentSessionId = match.groups!.sessionId;
  const authorizationResponse = await authorizeChildSession(env, parentSessionId, request);
  if (!authorizationResponse.ok) return authorizationResponse;

  const authorization = (await authorizationResponse.json().catch(() => null)) as {
    ok?: boolean;
    ownerUserId?: string;
    businessId?: string | null;
  } | null;
  if (!authorization?.ok || !authorization.ownerUserId || !authorization.businessId) {
    return jsonErrorResponse("Forbidden", 403);
  }

  const parsed = await parseBody(request, SandboxChildSessionBodySchema);
  if (!parsed.ok) return parsed.response;

  const membership = await resolveCycloidAdminUser(assertDatabase(env), Number(authorization.ownerUserId));
  if (
    !membership ||
    !membership.businessId ||
    membership.businessId !== authorization.businessId ||
    !membership.businessRole
  ) {
    return jsonErrorResponse("Forbidden", 403);
  }

  const childRoute = sessionRoutes.find(
    (route) =>
      route.method === "POST" &&
      route.auth === "authenticated" &&
      route.pattern.routeTemplate === "/api/sessions/:sessionId/child-sessions",
  );
  if (!childRoute) throw new Error("Authenticated child-session route is not registered");

  const childUrl = new URL(`/api/sessions/${encodeURIComponent(parentSessionId)}/child-sessions`, request.url);
  const childMatch = childUrl.pathname.match(childRoute.pattern);
  if (!childMatch) throw new Error("Failed to match authenticated child-session route");
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const name of ["idempotency-key", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const childRequest = new Request(childUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed.value),
  });
  const userId = Number(authorization.ownerUserId);
  const actingAuth: AuthInfo = {
    userId: authorization.ownerUserId,
    tokenSource: "sandbox_do_verified",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: Number.isSafeInteger(userId) ? userId : 0,
      login: null,
      name: null,
      email: null,
      businessId: membership.businessId,
      businessRole: membership.businessRole,
    },
  };
  return childRoute.handler(childRequest, env, childMatch, actingAuth, ctx);
}

export const sessionRoutes: Route[] = [
  // Create session
  {
    method: "POST",
    pattern: parsePattern("/api/sessions"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      // Typed body cap: fast-reject oversized declared payloads, then enforce the
      // same cap on actual bytes read so missing/incorrect Content-Length cannot
      // force an oversized body into JSON parsing.
      const contentLengthHeader = request.headers.get("content-length");
      const declaredBodyLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (
        declaredBodyLength !== null &&
        Number.isFinite(declaredBodyLength) &&
        declaredBodyLength > MAX_SESSION_CREATE_BODY_BYTES
      ) {
        log.warn(
          { event: "session_create_body_too_large", ownerUserId: routeAuth.userId, declaredBodyLength },
          "session_create_body_too_large",
        );
        await postStructuredEventToDd(env, {
          event: "session_create_body_too_large",
          ownerUserId: routeAuth.userId,
          declaredBodyLength,
        });
        return jsonErrorResponse("Request body is too large", 413);
      }
      const bodyResult = await readCappedWebhookBody(request, MAX_SESSION_CREATE_BODY_BYTES);
      if (bodyResult instanceof Response) {
        log.warn(
          { event: "session_create_body_too_large", ownerUserId: routeAuth.userId, declaredBodyLength },
          "session_create_body_too_large",
        );
        await postStructuredEventToDd(env, {
          event: "session_create_body_too_large",
          ownerUserId: routeAuth.userId,
          declaredBodyLength,
        });
        return jsonErrorResponse("Request body is too large", 413);
      }
      let payload: Record<string, unknown> = {};
      if (bodyResult.length > 0) {
        try {
          const parsedPayload: unknown = JSON.parse(bodyResult);
          if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
            return jsonErrorResponse("Request body must be a JSON object", 400);
          }
          payload = parsedPayload as Record<string, unknown>;
        } catch {
          return jsonErrorResponse("Request body must be valid JSON", 400);
        }
      }
      if ("sessionId" in payload && !isValidSessionId(payload.sessionId)) {
        return jsonErrorResponse(INVALID_SESSION_ID_MESSAGE, 400);
      }
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : crypto.randomUUID();
      let ownerUserId =
        routeAuth.canAccessAllSessions && payload.ownerUserId ? String(payload.ownerUserId) : String(routeAuth.userId);
      const ctx = (payload.context as Record<string, unknown> | undefined) || {};
      const repoUrl = (payload.repoUrl || ctx.repoUrl) as string | undefined;
      const baseBranch = (payload.baseBranch || ctx.baseBranch) as string | undefined;
      // Optional create-time "resume this existing branch" target, distinct from
      // baseBranch (the PR merge target).
      let startBranch = (payload.startBranch as string | undefined)?.trim() || undefined;
      const sessionKind = "repo" as const;
      let repoContext: RepoContext | undefined;
      if (repoUrl) {
        let parsed: { owner: string; repo: string };
        try {
          parsed = parseRepoUrl(repoUrl);
        } catch {
          return jsonErrorResponse(`Invalid repo URL: ${repoUrl}`, 400);
        }
        if (!isValidGithubRepoSegment(parsed.owner) || !isValidGithubRepoSegment(parsed.repo)) {
          return jsonErrorResponse(`Invalid repo URL: ${repoUrl}`, 400);
        }
        repoContext = { repoOwner: parsed.owner, repoName: parsed.repo, baseBranch };
      } else if (payload.repoOwner && payload.repoName) {
        const { repoOwner, repoName } = payload;
        if (!isValidGithubRepoSegment(repoOwner) || !isValidGithubRepoSegment(repoName)) {
          return jsonErrorResponse("repoOwner and repoName must be valid GitHub identifiers", 400);
        }
        repoContext = { repoOwner, repoName, baseBranch };
      } else {
        return jsonErrorResponse("repoUrl or repoOwner+repoName is required", 400);
      }

      // Validate the resume branch as a safe git ref before it can ever reach a git
      // arg (CHECKOUT_BRANCH is a leading positional to git fetch/checkout).
      if (startBranch !== undefined && !isSafeGitRef(startBranch)) {
        return jsonErrorResponse("startBranch is not a valid git branch name", 400);
      }

      const qaRequest = normalizePublicQaRequest(payload);
      if (!qaRequest.ok) {
        return jsonErrorResponse(qaRequest.error, 400);
      }
      const qaRequested = qaRequest.qaRequested;

      // Resolve slack:* owner IDs to real user IDs
      if (ownerUserId.startsWith("slack:")) {
        const slackId = ownerUserId.slice(6);
        const linkedUser = await getUserBySlackId(env.DB, slackId);
        if (linkedUser) {
          ownerUserId = String(linkedUser.id);
        }
      }
      const numericOwnerUserId = parsePositiveIntegerUserId(ownerUserId);
      if (numericOwnerUserId === null) {
        return jsonErrorResponse("ownerUserId must be a positive integer", 400);
      }
      ownerUserId = String(numericOwnerUserId);

      let installationId: number | undefined;
      if (repoContext) {
        const githubIntegrationGate = await gateGithubSessionStart(env, {
          userId: ownerUserId,
          businessId: routeAuth.user?.businessId ?? null,
          sessionId,
          repoOwner: repoContext.repoOwner!,
          repoName: repoContext.repoName!,
        });
        if (!githubIntegrationGate.ok) {
          return jsonResponse(githubIntegrationGate.body, githubIntegrationGate.status);
        }
        installationId = githubIntegrationGate.installationId;
      }

      const requestedModelId = extractModelId(payload.model);
      let agentRuntimeBackend: AgentRuntimeBackend = CODEX_AGENT_RUNTIME_BACKEND;
      if (payload.agentRuntimeBackend !== undefined && payload.agentRuntimeBackend !== null) {
        if (!isAgentRuntimeBackend(payload.agentRuntimeBackend)) {
          return jsonErrorResponse(`Invalid agentRuntimeBackend: ${String(payload.agentRuntimeBackend)}`, 400);
        }
        agentRuntimeBackend = payload.agentRuntimeBackend;
      } else if (requestedModelId !== undefined) {
        // No explicit backend: derive it from the requested model (a Claude
        // model implies claude_code). Unknown models keep the codex default
        // and fail the allowlist check below.
        agentRuntimeBackend = getAgentRuntimeBackendForModel(requestedModelId) ?? CODEX_AGENT_RUNTIME_BACKEND;
      }
      if (
        requestedModelId !== undefined &&
        !isSessionStartModelAllowedForBackend(requestedModelId, agentRuntimeBackend)
      ) {
        return jsonErrorResponse(`Invalid model for ${agentRuntimeBackend}: ${requestedModelId}`, 400);
      }
      if (payload.model !== undefined && payload.model !== null && requestedModelId === undefined) {
        return jsonErrorResponse(`Invalid model: ${String(payload.model)}`, 400);
      }
      const baseModelId =
        extractSessionStartModelIdForBackend(payload.model, agentRuntimeBackend) ??
        getDefaultSessionStartModelIdForBackend(agentRuntimeBackend);
      if (
        agentRuntimeBackend === OPENCODE_AGENT_RUNTIME_BACKEND &&
        !isInternalCycloidBusinessId(routeAuth.user?.businessId ?? "")
      ) {
        return jsonErrorResponse("opencode is only available to Cycloid team members", 403);
      }

      if (payload.autoVerify !== undefined && typeof payload.autoVerify !== "boolean") {
        return jsonErrorResponse(`autoVerify must be a boolean, got: ${String(payload.autoVerify)}`, 400);
      }
      if (payload.planApprovalRequired !== undefined && typeof payload.planApprovalRequired !== "boolean") {
        return jsonErrorResponse(
          `planApprovalRequired must be a boolean, got: ${String(payload.planApprovalRequired)}`,
          400,
        );
      }
      const normalizedPlanMode = normalizePlanModeSetting(
        typeof payload.planMode === "string" ? payload.planMode : undefined,
      );
      if (payload.planMode !== undefined && normalizedPlanMode === undefined) {
        return jsonErrorResponse(`planMode must be one of "off", "on", "auto", got: ${String(payload.planMode)}`, 400);
      }
      const onboarding = payload.onboarding === true;
      if (onboarding && qaRequested) {
        return jsonErrorResponse("onboarding and qa are mutually exclusive", 400);
      }
      if (onboarding && sessionKind !== "repo") {
        return jsonErrorResponse("onboarding is only valid for repo sessions", 400);
      }
      let githubPrRef: unknown;
      if (payload.githubPrUrl !== undefined && payload.githubPrUrl !== null) {
        githubPrRef = payload.githubPrUrl;
      } else if (payload.prUrl !== undefined && payload.prUrl !== null) {
        githubPrRef = payload.prUrl;
      } else if (payload.pullRequestUrl !== undefined && payload.pullRequestUrl !== null) {
        githubPrRef = payload.pullRequestUrl;
      }
      let targetPrUrl: string | null = null;
      if (payload.targetPrUrl !== undefined && payload.targetPrUrl !== null) {
        targetPrUrl = normalizeGithubPullRequestUrl(payload.targetPrUrl);
        if (!targetPrUrl) return jsonErrorResponse("targetPrUrl must be a valid GitHub pull request URL", 400);
      } else if (qaRequested && githubPrRef !== undefined && githubPrRef !== null) {
        targetPrUrl = normalizeGithubPullRequestUrl(githubPrRef);
        if (!targetPrUrl) return jsonErrorResponse("targetPrUrl must be a valid GitHub pull request URL", 400);
      } else if (qaRequested) {
        const targetPrUrlSelection = resolveQaTargetPullRequestUrl(payload.prompt);
        if (targetPrUrlSelection.status === "ambiguous") {
          return jsonErrorResponse(AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE, 400);
        }
        targetPrUrl = targetPrUrlSelection.status === "selected" ? targetPrUrlSelection.targetPrUrl : null;
      }
      if (qaRequested && targetPrUrl) {
        const parsedTargetPr = parseGithubPullRequestUrl(targetPrUrl);
        if (!parsedTargetPr) return jsonErrorResponse("targetPrUrl must be a valid GitHub pull request URL", 400);
        if (
          !repoContext?.repoOwner ||
          !repoContext.repoName ||
          parsedTargetPr.owner.toLowerCase() !== repoContext.repoOwner.toLowerCase() ||
          parsedTargetPr.repo.toLowerCase() !== repoContext.repoName.toLowerCase()
        ) {
          return jsonErrorResponse("targetPrUrl must belong to the same repository as repoUrl", 403);
        }
      }

      // Honor a CLI/client Idempotency-Key before PR-continuation resolution.
      // A retry on a lost response must replay the created session even if the
      // small LLM classifier or GitHub PR fetch would fail on the retry.
      let idempotencyToken: IdempotencyToken | null = null;
      let takeoverAdmissionClaim: { prUrl: string; sessionId: string } | null = null;
      const releaseTakeoverAdmissionClaim = async (): Promise<void> => {
        if (takeoverAdmissionClaim) {
          await releasePrTakeoverAdmission(env.DB, takeoverAdmissionClaim);
          takeoverAdmissionClaim = null;
        }
      };
      const releaseCreateClaims = async (): Promise<void> => {
        await releaseTakeoverAdmissionClaim();
        if (idempotencyToken) {
          await releaseIdempotentRequest(env.DB, idempotencyToken);
          idempotencyToken = null;
        }
      };
      const idempotencyKey = readIdempotencyKeyHeader(request);
      if (idempotencyKey) {
        const decision = await beginIdempotentRequest(env.DB, {
          key: idempotencyKey,
          ownerUserId: routeAuth.userId,
          route: "session",
          requestBody: payload,
        });
        if (decision.kind === "replay") {
          log.info(
            {
              event: "idempotency_key_replayed",
              route: "session",
              ownerUserId: routeAuth.userId,
              resolvedId: decision.resolvedId,
            },
            "idempotency_key_replayed",
          );
          return jsonResponse(
            {
              ok: true,
              sessionId: decision.resolvedId,
              sessionUrl: resolveConfiguredPublicSessionUrl(env, decision.resolvedId) ?? undefined,
              idempotentReplay: true,
              ...(payload.qa === true && typeof payload.targetPrUrl === "string"
                ? { promptAlreadyEnqueued: true }
                : {}),
            },
            201,
          );
        }
        if (decision.kind === "reject") {
          log.info(
            {
              event: "idempotency_key_rejected",
              route: "session",
              ownerUserId: routeAuth.userId,
              reason: decision.reason,
            },
            "idempotency_key_rejected",
          );
          return jsonErrorResponse(
            decision.reason === "payload_mismatch"
              ? "Idempotency-Key was already used with a different request payload"
              : "A request with this Idempotency-Key is already in progress; retry shortly",
            decision.status,
          );
        }
        if (decision.kind === "proceed") idempotencyToken = decision.token;
      }

      const prContinuationAllowedOnRoute =
        routeAuth.authMode === "cli_token" ||
        (routeAuth.authMode === "user_session" && routeAuth.tokenSource === "session_token");
      const hasExplicitPrContinuationInput =
        (payload.continuePrUrl !== undefined && payload.continuePrUrl !== null) ||
        (payload.continueMode !== undefined && payload.continueMode !== null && payload.continueMode !== "");
      if (!prContinuationAllowedOnRoute && hasExplicitPrContinuationInput) {
        await releaseCreateClaims();
        return jsonErrorResponse("PR continuation is only supported from the web app, Slack, and CLI", 403);
      }

      let adoptedPrMetadata = null as Awaited<ReturnType<typeof resolveSessionContinuation>>["adoptedPrMetadata"];
      if (prContinuationAllowedOnRoute) {
        try {
          const continuation = await resolveSessionContinuation({
            env,
            sessionId,
            prompt: payload.prompt,
            continuePrUrl: payload.continuePrUrl,
            continueMode: payload.continueMode,
            repoContext,
            installationId: installationId ?? null,
            startBranch,
            allowPromptInference: !qaRequested,
            logger: log,
            telemetry: {
              ownerUserId,
              repoOwner: repoContext.repoOwner ?? null,
              repoName: repoContext.repoName ?? null,
            },
          });
          repoContext = continuation.repoContext;
          startBranch = continuation.repoContext.startBranch ?? startBranch;
          targetPrUrl = continuation.targetPrUrl ?? targetPrUrl;
          adoptedPrMetadata = continuation.adoptedPrMetadata;
        } catch (error) {
          if (error instanceof SessionContinuationError) {
            await releaseCreateClaims();
            return jsonErrorResponse(error.publicMessage, error.status, { code: error.reasonCode });
          }
          throw error;
        }
      }
      if (adoptedPrMetadata) {
        const coordinatingSessionId = await getTrackingSessionIdForPrUrl(env.DB, adoptedPrMetadata.prUrl);
        if (coordinatingSessionId) {
          const sessionIdentity = await getSessionIndexIdentity(env.DB, coordinatingSessionId);
          const conflictBody: Record<string, unknown> = { code: "pr_takeover_conflict" };
          if (
            sessionIdentity &&
            canAccessSessionIdentity(routeAuth, String(sessionIdentity.ownerUserId), sessionIdentity.businessId)
          ) {
            conflictBody.sessionId = coordinatingSessionId;
            conflictBody.sessionUrl = resolveConfiguredPublicSessionUrl(env, coordinatingSessionId) ?? undefined;
          }
          await releaseCreateClaims();
          return jsonErrorResponse("This pull request already has an active Cycloid session", 409, conflictBody);
        }

        const admissionClaim = await claimPrTakeoverAdmission(env.DB, {
          prUrl: adoptedPrMetadata.prUrl,
          sessionId,
        });
        if (!admissionClaim.won) {
          const sessionIdentity = await getSessionIndexIdentity(env.DB, admissionClaim.sessionId);
          const conflictBody: Record<string, unknown> = { code: "pr_takeover_conflict" };
          if (
            sessionIdentity &&
            canAccessSessionIdentity(routeAuth, String(sessionIdentity.ownerUserId), sessionIdentity.businessId)
          ) {
            conflictBody.sessionId = admissionClaim.sessionId;
            conflictBody.sessionUrl = resolveConfiguredPublicSessionUrl(env, admissionClaim.sessionId) ?? undefined;
          }
          await releaseCreateClaims();
          return jsonErrorResponse("This pull request already has an active Cycloid session", 409, conflictBody);
        }
        takeoverAdmissionClaim = { prUrl: adoptedPrMetadata.prUrl, sessionId };
      }
      const adoptedPrUrl = adoptedPrMetadata?.prUrl ?? null;
      const adoptedPrNumber = adoptedPrMetadata?.prNumber ?? null;
      const agentRuntime = resolveAgentRuntimeMetadata({
        qa: qaRequested,
        onboarding,
        targetPrUrl,
      });
      if (requiresQaTargetPrUrl({ qa: qaRequested, targetPrUrl: agentRuntime.targetPrUrl })) {
        await releaseCreateClaims();
        return jsonErrorResponse(
          "QA requires a GitHub pull request URL. Provide targetPrUrl or include a pull request URL in the prompt.",
          400,
        );
      }
      const reviewVerificationExempt = reviewVerificationExemptReason({
        agentRole: agentRuntime.agentRole,
        agentProfile: agentRuntime.agentProfile,
        agentRuntimeBackend,
      });
      const autoVerify = reviewVerificationExempt ? false : (payload.autoVerify as boolean | undefined);
      const modelId = baseModelId;
      if (!isModelAllowedForBackend(modelId, agentRuntimeBackend)) {
        await releaseCreateClaims();
        return jsonErrorResponse(`Invalid model for ${agentRuntimeBackend}: ${modelId}`, 500);
      }

      let reasoningEffort: string | null = MODEL_REASONING_CONFIG[modelId]?.default ?? null;
      if (typeof payload.reasoningEffort === "string" && payload.reasoningEffort) {
        if (!isValidReasoningEffort(modelId, payload.reasoningEffort)) {
          await releaseCreateClaims();
          return jsonErrorResponse(`Invalid reasoningEffort for model ${modelId}: ${payload.reasoningEffort}`, 400);
        }
        reasoningEffort = payload.reasoningEffort;
      }
      const requestId = extractRequestId(request);
      const callbackContext =
        routeAuth.canAccessAllSessions && payload.callbackContext && typeof payload.callbackContext === "object"
          ? (payload.callbackContext as CallbackContext)
          : undefined;
      if (payload.callbackContext !== undefined && !routeAuth.canAccessAllSessions) {
        await releaseCreateClaims();
        return jsonErrorResponse("callbackContext requires admin auth", 403);
      }
      if (isQaTesterAgentRole(agentRuntime.agentRole) && targetPrUrl) {
        if (!repoContext?.repoOwner || !repoContext.repoName || installationId === undefined) {
          await releaseCreateClaims();
          return jsonErrorResponse("QA requires an authorized GitHub repository context", 400);
        }
        // When the caller pinned no model, backend, or reasoning, forward nulls so
        // the verifier falls back to the requesting user's stored default model
        // (resolved in the spawn path) rather than this route's global-default
        // resolution. Any explicitly-provided value is honored unchanged.
        const qaModelExplicit =
          requestedModelId !== undefined ||
          (payload.agentRuntimeBackend !== undefined && payload.agentRuntimeBackend !== null) ||
          (typeof payload.reasoningEffort === "string" && payload.reasoningEffort.length > 0);
        const coordinated = await requestCoordinatedVerification({
          env,
          logger: log,
          waitUntil: waitUntilFromContext(ctx),
          source: "api",
          ownerUserId,
          businessId: routeAuth.user?.businessId ?? null,
          repoOwner: repoContext.repoOwner,
          repoName: repoContext.repoName,
          installationId,
          prUrl: targetPrUrl,
          prompt: typeof payload.prompt === "string" ? payload.prompt : null,
          requestId,
          modelId: qaModelExplicit ? modelId : null,
          agentRuntimeBackend: qaModelExplicit ? agentRuntimeBackend : null,
          reasoningEffort: qaModelExplicit ? reasoningEffort : null,
          // Manual "Verify" button intent: always start a fresh verifier, superseding any in-flight
          // run for this PR instead of reusing it (bounded by the per-PR run cap).
          forceNewSession: payload.forceNewSession === true,
        });
        if (coordinated.ok) {
          await releaseTakeoverAdmissionClaim();
          if (idempotencyToken) await commitIdempotentRequest(env.DB, idempotencyToken, coordinated.sessionId);
          return jsonResponse(
            {
              ok: true,
              sessionId: coordinated.sessionId,
              sessionUrl: resolveConfiguredPublicSessionUrl(env, coordinated.sessionId) ?? undefined,
              targetPrUrl: coordinated.prUrl,
              promptAlreadyEnqueued: true,
              duplicate: coordinated.duplicate,
            },
            201,
          );
        }
        await releaseCreateClaims();
        return jsonResponse(
          {
            ok: false,
            error:
              coordinated.reason === "admitted_elsewhere"
                ? "A verification request is already being admitted for this pull request"
                : "Failed to start QA verification for this pull request",
            reason: coordinated.reason,
          },
          coordinated.reason === "admitted_elsewhere" || coordinated.reason === "run_limit_reached"
            ? 409
            : coordinated.reason === "invalid_pr"
              ? 400
              : 500,
        );
      }
      // Admission control runs AFTER idempotency replay so a retried, already-
      // accepted create still replays its cached result instead of being capped.
      // Reject here releases any idempotency claim so a later retry (once capacity
      // frees) is not permanently blocked.
      const admission = await admitSessionCreate({
        db: env.DB,
        env,
        businessId: routeAuth.user?.businessId ?? null,
      });
      if (!admission.ok) {
        log.warn(
          {
            event: "session_admission_rejected",
            code: admission.code,
            ownerUserId: routeAuth.userId,
            businessId: routeAuth.user?.businessId ?? null,
            ...(admission.activeCount !== undefined ? { activeCount: admission.activeCount } : {}),
          },
          "session_admission_rejected",
        );
        // Release the idempotency claim + verification lock BEFORE the Datadog
        // round-trip. The post never throws and is observability-only; awaiting it
        // first would keep the claim held during a slow/incident DD response, so a
        // retry with the same Idempotency-Key replays the 429 instead of getting a
        // fresh admission check once capacity frees.
        await releaseCreateClaims();
        await postStructuredEventToDd(env, {
          event: "session_admission_rejected",
          code: admission.code,
          ownerUserId: routeAuth.userId,
          businessId: routeAuth.user?.businessId ?? null,
          ...(admission.activeCount !== undefined ? { activeCount: admission.activeCount } : {}),
        });
        return jsonErrorResponse(
          admission.message,
          admission.status,
          undefined,
          admission.code === "session_create_rate_limited"
            ? { "retry-after": String(SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS) }
            : undefined,
        );
      }

      // Now that the repo is authorized and the create has been admitted,
      // verify an explicit startBranch actually exists on the remote. Distinguish
      // a genuinely missing branch (fail closed, 404) from a transient
      // GitHub/network failure (503) -- never silently fall back to a fresh
      // branch off base.
      if (repoContext && startBranch !== undefined && installationId !== undefined) {
        let branchHead: string | null;
        try {
          const token = await createInstallationToken(env, installationId);
          branchHead = await getBranchHeadSha(token, repoContext.repoOwner!, repoContext.repoName!, startBranch);
        } catch (error) {
          log.warn(
            { sessionId, startBranch, error: String(error) },
            "startBranch remote existence check failed (transient)",
          );
          await releaseCreateClaims();
          return jsonErrorResponse("Could not verify the start branch on GitHub; please retry", 503);
        }
        if (branchHead === null) {
          await releaseCreateClaims();
          return jsonErrorResponse(`Start branch not found on the remote: ${startBranch}`, 404);
        }
      }

      // Attach the validated resume branch so it persists onto the session and
      // becomes CHECKOUT_BRANCH on the initial spawn.
      if (repoContext && startBranch !== undefined) {
        repoContext.startBranch = startBranch;
      }

      const agentOverrides = sanitizePublicAgentOverrides(
        payload.agents as Record<string, Record<string, unknown>> | undefined,
      );
      let session: Awaited<ReturnType<typeof createSessionState>>["session"];
      let replay: Awaited<ReturnType<typeof createSessionState>>["replay"];
      try {
        const created = await withRouteSpan(
          "sessions.create.initialize",
          {
            auth: routeAuth,
            attributes: {
              "session.id": sessionId,
              "session.kind": sessionKind,
              "repo.owner": repoContext?.repoOwner ?? "",
              "repo.name": repoContext?.repoName ?? "",
            },
          },
          () =>
            createSessionState(env, sessionId, ownerUserId, {
              sessionKind,
              entrypoint: SessionEntrypoint.API,
              repoContext,
              agentOverrides,
              callbackContext,
              requestId,
              auth: toInternalAuthContext(routeAuth),
              installationId,
              model: modelId,
              reasoningEffort,
              agentRuntimeBackend,
              autoVerify,
              planMode: normalizedPlanMode,
              planApprovalRequired: payload.planApprovalRequired as boolean | undefined,
              promptText: typeof payload.prompt === "string" ? payload.prompt : undefined,
              agentRole: agentRuntime.agentRole,
              agentProfile: agentRuntime.agentProfile,
              harnessKind: agentRuntime.harnessKind,
              runtimeStartupProfile: agentRuntime.runtimeStartupProfile,
              targetPrUrl: agentRuntime.targetPrUrl ?? null,
              prUrl: adoptedPrUrl,
              prNumber: adoptedPrNumber,
              waitUntil: waitUntilFromContext(ctx),
            }),
        );
        session = created.session;
        replay = created.replay;
      } catch (error) {
        if (error instanceof InvalidSessionIdError) {
          await releaseCreateClaims();
          return jsonErrorResponse(error.message, 400);
        }
        if (error instanceof ProviderCredentialNotValidatedError) {
          await releaseCreateClaims();
          return providerCredentialErrorResponse(error);
        }
        if (error instanceof OpencodeAccessDeniedError) {
          await releaseCreateClaims();
          return opencodeAccessDeniedResponse();
        }
        const message = formatSessionCreateFailure("initialize", error);
        log.error({ sessionId, sessionKind, ownerUserId, error: String(error) }, "Session creation initialize failed");
        await releaseCreateClaims();
        return jsonErrorResponse(message, 500);
      }
      if (!routeAuth.canAccessAllSessions && session.ownerUserId !== routeAuth.userId) {
        await releaseCreateClaims();
        return jsonErrorResponse("Session ID already exists", 409);
      }

      try {
        await withRouteSpan(
          "sessions.create.persist",
          { auth: routeAuth, attributes: { "session.id": session.sessionId } },
          () =>
            persistInitialSessionProjection(env, {
              session,
              replay,
              sessionKind,
              projectionSource: "routes.sessions.create",
              projectionUserId: routeAuth.userId,
              requestId,
              webhookRef:
                repoContext && githubPrRef
                  ? {
                      source: SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
                      externalRef: githubPrRef,
                    }
                  : undefined,
              adoptedPrMetadata,
            }),
        );
      } catch (error) {
        const message = formatSessionCreateFailure("persist", error);
        log.error({ sessionId, sessionKind, ownerUserId, error: String(error) }, "Session creation persist failed");
        await releaseCreateClaims();
        return jsonErrorResponse(message, 500);
      }

      // Session durably persisted: commit the claim with its id so a later retry
      // of the same key replays this session instead of spawning another.
      if (idempotencyToken) await commitIdempotentRequest(env.DB, idempotencyToken, session.sessionId);

      return jsonResponse(
        {
          ok: true,
          sessionId: session.sessionId,
          sessionUrl: resolveConfiguredPublicSessionUrl(env, session.sessionId) ?? undefined,
          session,
          auth: { tokenSource: routeAuth.tokenSource, authMode: routeAuth.authMode },
        },
        201,
      );
    },
  },

  // Pre-flight check: would the session-create credential gate let this user
  // start a session with the given model right now? Used by the UI to disable
  // the submit button before the user clicks. Mirrors what `POST /api/sessions`
  // would do via the same `evaluateProviderCredentialForModel` helper, so the
  // UI and backend cannot disagree.
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/prerequisites"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const url = new URL(request.url);
      const modelParam = url.searchParams.get("model");
      const modelId = extractModelId(modelParam);
      if (!modelId) {
        return jsonErrorResponse("model query parameter is required", 400);
      }
      const modelBackend = getAgentRuntimeBackendForModel(modelId);
      if (
        modelBackend &&
        !canBusinessUseOpencode({
          agentRuntimeBackend: modelBackend,
          businessId: routeAuth.user?.businessId ?? null,
        })
      ) {
        return jsonResponse({
          canStartSession: false,
          blocking: {
            provider: null,
            reasonCode: OPENCODE_ACCESS_DENIED_ERROR,
          },
        });
      }
      const evaluation = await evaluateProviderCredentialForModel(env, {
        ownerUserId: routeAuth.userId,
        businessId: routeAuth.user?.businessId ?? null,
        modelId,
      });
      if (evaluation.ok) {
        return jsonResponse({ canStartSession: true });
      }
      return jsonResponse({
        canStartSession: false,
        blocking: {
          provider: evaluation.provider,
          reasonCode: evaluation.reasonCode,
        },
      });
    },
  },

  // List sessions
  {
    method: "GET",
    pattern: parsePattern("/api/sessions"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { statusFilter, scope, pagination, search } = parseSessionListQuery(request);
      const db = assertDatabase(env);

      return withRouteSpan("sessions.list", { auth: routeAuth }, async (span) => {
        if (scope === "business" && routeAuth.user?.businessId && routeAuth.user.sharedSessions) {
          const filtered = await listSharedBusinessSessions(env, routeAuth, db, statusFilter, pagination, search, span);
          if (!filtered.ok) return filtered.response;
          span.setAttribute("db.rows_returned", filtered.data.length);
          return jsonResponse({
            sessions: filtered.data.map(toSessionApiShape),
            nextCursor: filtered.nextCursor,
          });
        }

        const ownerFilter = routeAuth.canAccessAllSessions ? null : routeAuth.userId;
        const { data, nextCursor } = await listSessions(db, ownerFilter, statusFilter, {
          ...pagination,
          search,
        });
        span.setAttribute("db.rows_returned", data.length);
        return jsonResponse({ sessions: data.map(toSessionApiShape), nextCursor });
      });
    },
  },

  // Clear legacy archived rows from the D1 index.
  {
    method: "DELETE",
    pattern: parsePattern("/api/sessions"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const ownerFilter = routeAuth.canAccessAllSessions ? null : routeAuth.userId;
      const db = assertDatabase(env);
      await deleteArchivedSessionsFromIndex(db, ownerFilter ?? undefined);
      return new Response(null, { status: 204 });
    },
  },

  // SSE events
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/events"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const { afterSequence, limit } = parseSessionEventsQuery(request);
        const eventsResult = await listSessionEventsAuthed(env, sessionId, afterSequence, limit, authCtx, requestId);
        if (eventsResult.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!eventsResult.ok) {
          throw new Error(`Session DO events listing failed with status ${eventsResult.status}`);
        }

        const ep = eventsResult.payload!;
        return buildSseResponse(
          {
            phase: ep.phase,
            sandboxSubstate: ep.sandboxSubstate,
            stopMode: ep.stopMode,
            finalizingStep: ep.finalizingStep,
          },
          ep.events || [],
          ep.title ?? null,
          ep.spawnDurationMs,
        );
      });
    },
  },

  // Clone token (sandbox auth validated by DO, same as WS)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/clone-token"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return getCloneToken(env, sessionId, request);
    },
  },

  // GitHub token for sandbox gh CLI (sandbox auth validated by DO)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/github-token"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return getGithubToken(env, sessionId, request);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/github-action"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callGithubActionRoute(env, match.groups!.sessionId, request),
  },

  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/pr-review/publish"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => publishPrReviewFromSandbox(env, match.groups!.sessionId, request),
  },

  // CLI auth token for sandbox Cycloid CLI (sandbox auth validated by DO)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/cli-auth-token"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return getCliAuthToken(env, sessionId, request);
    },
  },

  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/slack/get-thread"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callSlackDynamicToolRoute(env, match.groups!.sessionId, request, "slackGetThread"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/slack/search-messages"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callSlackDynamicToolRoute(env, match.groups!.sessionId, request, "slackSearchMessages"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/slack/send-message"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callSlackDynamicToolRoute(env, match.groups!.sessionId, request, "slackSendMessage"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/integration-lifecycle"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callSessionIntegrationLifecycleRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/action-path"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const businessId = await getSessionIndexBusinessId(env.DB, match.groups!.sessionId);
      if (!businessId || !isInternalCycloidBusinessId(businessId)) return jsonErrorResponse("Forbidden", 403);
      const result = await registerSandboxDesktopActionPathRow(env, match.groups!.sessionId, request);
      if (!result.ok || !result.payload) {
        return jsonErrorResponse("Desktop action path row registration failed", result.status);
      }
      return jsonResponse(result.payload);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/memory/context"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callMemoryContextSandboxRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/company-memory/reasoning-chain"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callCompanyMemorySandboxRoute(env, match.groups!.sessionId, request, "companyMemoryReasoningChain"),
  },
  // Telemetry broker (sandbox auth validated by DO). The sandbox
  // ships platform DD/Sentry/Braintrust telemetry here; the DO injects the
  // platform secret server-side so it never reaches the sandbox env.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/dd-logs"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callTelemetryDdLogsRoute(env, match.groups!.sessionId, request),
  },
  // parsePattern has no wildcard support, so the Braintrust SDK subpaths are
  // registered as concrete routes and the canonical upstream subpath is passed
  // through to the helper (conveyed to the DO via X-Telemetry-Subpath). The logger
  // flow is login -> project register -> logs3 (all POST); all three must be routed
  // or the logger never resolves its project id and telemetry is silently dropped.
  // `version` is the SDK's GET payload-limit probe -- routing it lets the SDK honor
  // the real server cap and removes a 404.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/braintrust/api/apikey/login"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callTelemetryBraintrustRoute(env, match.groups!.sessionId, request, "api/apikey/login"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/braintrust/api/project/register"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callTelemetryBraintrustRoute(env, match.groups!.sessionId, request, "api/project/register"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/braintrust/logs3"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callTelemetryBraintrustRoute(env, match.groups!.sessionId, request, "logs3"),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/braintrust/version"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) =>
      callTelemetryBraintrustRoute(env, match.groups!.sessionId, request, "version"),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/telemetry/sentry"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callTelemetrySentryRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/review-loop/reply"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callReviewLoopReplyRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/review-loop/record-push"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callReviewLoopRecordPushRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/review-loop/summary-comment"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callReviewLoopSummaryCommentRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/pr-title"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callUpdatePrTitleRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/pr-close"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callClosePrRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/pr-read"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callReadPrRoute(env, match.groups!.sessionId, request),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/ticket-key"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => callRecordAgentTicketKeyRoute(env, match.groups!.sessionId, request),
  },

  // Platform LLM broker (sandbox auth and one-shot capability validated by DO)
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/platform-llm/prompt-preparation"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match, _auth, ctx) =>
      handlePlatformLlmBrokerRoute(request, env, match, "prompt_preparation", ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/platform-llm/post-execution"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match, _auth, ctx) =>
      handlePlatformLlmBrokerRoute(request, env, match, "post_execution", ctx),
  },

  // WebSocket (public auth -- sandbox connections bypass user auth;
  // the Durable Object validates sandbox tokens itself)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/ws"),
    auth: "public",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return withRouteSpan("sessions.ws.upgrade", { attributes: { "session.id": sessionId } }, async (span) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return jsonErrorResponse("Expected websocket upgrade request", 426);
        }

        const socketQuery = parseSessionWebSocketQuery(request);
        if (!socketQuery.ok) {
          log.info(
            { event: "ws_handshake_rejected", sessionId, param: "afterSequence" },
            "Rejected malformed WebSocket handshake afterSequence",
          );
          return socketQuery.response;
        }

        if (socketQuery.value.isSandbox) {
          const wsResponse = await openSandboxWebSocket(env, sessionId, request, socketQuery.value.sandboxId);
          if ([401, 403, 404, 409, 426, 501].includes(wsResponse.status)) return wsResponse;
          if (wsResponse.status !== 101) {
            throw new Error(`Session DO websocket connect failed with status ${wsResponse.status}`);
          }
          return wsResponse;
        }

        const authResult = await authenticateRequest(request, env);
        if (!authResult.ok) return authResult.response;

        span.setAttributes({
          "user.id": authResult.auth.userId,
          "business.id": authResult.auth.user?.businessId,
        });

        return withSession(request, env, match, authResult.auth, async (_sessionId, _session, _requestId, authCtx) => {
          const wsResponse = await openSessionWebSocket(
            env,
            sessionId,
            request,
            socketQuery.value.afterSequence,
            authCtx,
          );
          if ([404, 409, 426, 501].includes(wsResponse.status)) return wsResponse;
          if (wsResponse.status !== 101) {
            throw new Error(`Session DO websocket connect failed with status ${wsResponse.status}`);
          }
          return wsResponse;
        });
      });
    },
  },

  // Per-business realtime sidebar feed (ARC-1322). A single always-on socket,
  // scoped to the caller's business, that streams compact list deltas for ALL
  // their sessions — so the sidebar is live with no detail view open. Keyed by
  // businessId; the feed DO gates every cross-member delivery by repo access.
  {
    method: "GET",
    pattern: parsePattern("/api/users/me/feed/ws"),
    auth: "public",
    handler: async (request, env) => {
      return withRouteSpan("sessions.feed.ws.upgrade", {}, async (span) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return jsonErrorResponse("Expected websocket upgrade request", 426);
        }

        const authResult = await authenticateRequest(request, env);
        if (!authResult.ok) return authResult.response;
        const { auth } = authResult;

        // Unlike the per-session WS, the feed is push-only (no mutating frames)
        // and only delivers data the target user would already see, so read-only
        // impersonation is allowed: key by the (impersonated) business, tag by
        // the target user id.
        const businessId = auth.user?.businessId;
        if (!businessId) {
          // Fail closed: without a business we cannot scope or gate the feed.
          return jsonErrorResponse("Forbidden: feed requires a business", 403);
        }

        const feed = env.SESSION_FEED;
        if (!feed) {
          return jsonErrorResponse("Feed channel unavailable", 503);
        }

        // Resolve the caller's accessible repos for cross-member delivery only
        // when the same business-session entitlement used by the list route and
        // bootstrap capabilities is enabled. Otherwise keep the feed owner-only.
        const snapshot = auth.user?.sharedSessions ? await getSharedBusinessRepoAccessSnapshot(env, auth) : null;
        const accessibleRepos = snapshot?.ok ? snapshot.data.accessibleRepos : new Set<string>();

        span.setAttributes({
          "user.id": auth.userId,
          "business.id": businessId,
          "feed.repo_count": accessibleRepos.size,
        });

        const headers = new Headers(request.headers);
        headers.set("x-auth-user-id", auth.userId);
        headers.set("x-feed-repos", JSON.stringify([...accessibleRepos]));
        const stub = feed.get(feed.idFromName(businessId));
        const wsResponse = await stub.fetch(new Request("https://internal/feed/ws", { method: "GET", headers }));
        if (wsResponse.status !== 101) {
          throw new Error(`Feed DO websocket connect failed with status ${wsResponse.status}`);
        }
        return wsResponse;
      });
    },
  },

  // Browser-side per-session WebSocket reliability telemetry. The UI still
  // emits Datadog RUM actions, but this authenticated mirror produces
  // queryable server logs with a server-derived owner/shared/admin relation.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/ws-telemetry"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth, ctx) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session) => {
        const rateLimit = await checkSessionWsTelemetryRateLimit(env, sessionId, routeAuth.userId);
        if (rateLimit.limited) {
          return jsonResponse({ ok: false, error: "Too many WebSocket telemetry events" }, 429);
        }

        const payload = (await parseJsonBody(request)) || {};
        const parsed = parseSessionWsTelemetryPayload(payload);
        if (!parsed.ok) return jsonErrorResponse(parsed.error, 400);

        const viewerRelation = getSessionViewerRelation(routeAuth, session as SessionRouteState);
        const emitPromise = emitSessionWsTelemetry(env, {
          sessionId,
          userId: routeAuth.userId,
          viewerRelation,
          payload: parsed.value,
        });
        if (ctx) {
          ctx.waitUntil(emitPromise);
        } else {
          void emitPromise;
        }
        return new Response(null, { status: 204 });
      });
    },
  },

  // Get latest plan
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/plan"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const isCookieSession =
        routeAuth.tokenSource === "session_token" &&
        (routeAuth.authMode === "user_session" || routeAuth.authMode === "impersonated_user_session");
      if (!isCookieSession) {
        return jsonErrorResponse("Forbidden", 403);
      }

      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await getSessionPlan(env, sessionId, requestId, authCtx);
        if (!result.ok || !result.payload) return jsonErrorResponse("Plan not found", 404);
        return jsonResponse(result.payload);
      });
    },
  },

  // Get prompts
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/prompts"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const promptListResult = await listSessionPrompts(env, sessionId, { auth: authCtx, requestId });
        if (promptListResult.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!promptListResult.ok) {
          throw new Error(`Session DO prompt listing failed with status ${promptListResult.status}`);
        }
        return jsonResponse({ prompts: promptListResult.payload!.prompts });
      });
    },
  },

  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/plan/approve"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      const actorUserId = routeAuth.actorUserId ?? routeAuth.userId;
      let revision: number | null = null;
      let auditLogged = false;
      const audit = (outcome: PlanApproveAuditOutcome, reason?: string | null) => {
        logPlanApproveAudit({ actorUserId, sessionId, revision, outcome, reason });
        auditLogged = true;
      };

      if (routeAuth.authMode !== "user_session") {
        audit("denied", "browser_session_required");
        return jsonErrorResponse("Forbidden", 403);
      }

      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        audit("invalid", "unsupported_content_type");
        return jsonErrorResponse("Content-Type must be application/json", 415);
      }
      const rawBody = await readCappedWebhookBody(request, PLAN_APPROVE_MAX_BODY_BYTES);
      if (rawBody instanceof Response) {
        audit("invalid", "body_too_large");
        return rawBody;
      }
      const boundedRequest = new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      });
      const parsed = await parseBody(boundedRequest, approveSessionPlanBodySchema);
      if (!parsed.ok) {
        audit("invalid", "invalid_body");
        return parsed.response;
      }
      revision = parsed.value.revision;

      const response = await withSession(
        request,
        env,
        match,
        routeAuth,
        async (authorizedSessionId, _session, requestId, authCtx) => {
          const result = await approveSessionPlan(env, authorizedSessionId, requestId, authCtx, {
            revision: parsed.value.revision,
            actorUserId,
            source: "web",
          });
          if (result.ok && result.payload) {
            audit(result.payload.idempotent ? "idempotent" : "approved");
            return jsonResponse(result.payload);
          }
          const error = result.error ?? "plan_approval_failed";
          audit(error === "stale_revision" ? "stale" : result.status === 409 ? "conflict" : "error", error);
          return jsonResponse({ ok: false, error }, result.status);
        },
      );
      if (!auditLogged) {
        audit(response.status === 403 || response.status === 404 ? "denied" : "error", `http_${response.status}`);
      }
      return response;
    },
  },

  // Send prompt (POST /prompts)
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/prompts"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: handleSendPrompt,
  },

  // Send prompt (POST /send alias)
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/send"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: handleSendPrompt,
  },

  // Stop session
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/stop"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const result = await stopSession(env, sessionId, requestId);
        return jsonResponse(result, result.ok ? 200 : 409);
      });
    },
  },

  // Respond to session question
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/respond"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session, requestId) => {
        const s = session as unknown as SessionDOResponse;
        if (s.planApprovalPending) {
          return jsonResponse({ ok: false, error: RESPOND_BLOCKED_ERROR, reason: "plan_approval_pending" }, 409);
        }
        // Cheap pre-parse guard: refuse to read/parse bodies that cannot hold a
        // valid answer. The precise limit applies to the answer field's UTF-8
        // bytes (checked post-parse below); the declared body length also carries
        // JSON envelope overhead (`{"answer":"…","questionId":"…"}`), so allow
        // generous headroom here and let the post-parse check be authoritative.
        const declaredLength = Number(request.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_PROMPT_SQL_PAYLOAD_BYTES + RESPOND_BODY_ENVELOPE_HEADROOM_BYTES
        ) {
          return jsonErrorResponse("Answer is too large", 413);
        }
        const payload = (await parseJsonBody(request)) || {};
        if (typeof payload.answer !== "string" || (payload.answer as string).length === 0) {
          return jsonErrorResponse("Missing answer", 400);
        }
        // Byte length, not string length: multi-byte input undercounts with .length.
        if (new TextEncoder().encode(payload.answer as string).byteLength > MAX_PROMPT_SQL_PAYLOAD_BYTES) {
          return jsonErrorResponse("Answer is too large", 413);
        }
        // Phase gate: respond only makes sense in `waiting_for_input`. The DO
        // still re-verifies the runtime `hasPendingQuestion` flag, but gating
        // here saves a DO round-trip on the common stale-tab case.
        if (s.phase && !isRespondAvailable(s.phase, s.planApprovalPending)) {
          return jsonResponse({ ok: false, error: RESPOND_BLOCKED_ERROR, reason: s.phase }, 409);
        }
        const questionId = typeof payload.questionId === "string" ? payload.questionId : undefined;
        const result = await respondToSession(env, sessionId, payload.answer as string, questionId, requestId);
        return jsonResponse(result, result.ok ? 200 : 409);
      });
    },
  },

  // Edit the latest pending plan revision.
  {
    method: "PUT",
    pattern: parsePattern("/api/sessions/:sessionId/plan"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      let audited = false;
      const audit = (revision: number | null, outcome: string, status: number): void => {
        audited = true;
        auditSessionPlanEdit({ actorUserId: routeAuth.userId, sessionId, revision, outcome, status });
      };

      // Plan actions are browser-only in v1. The router authenticates first;
      // this rejects CLI/admin bearer modes before any plan mutation.
      if (routeAuth.authMode !== "user_session") {
        audit(null, "denied_non_browser", 403);
        return jsonErrorResponse("Forbidden", 403);
      }
      const response = await withSession(
        request,
        env,
        match,
        auth,
        async (authorizedSessionId, _session, requestId, authCtx) => {
          const parsed = await parseSessionPlanEditBody(request);
          if (!parsed.ok) {
            audit(null, "invalid_request", parsed.response.status);
            return parsed.response;
          }

          const { limited } = await checkSessionPlanEditRateLimit(env, routeAuth.userId);
          if (limited) {
            audit(parsed.value.revision, "rate_limited", 429);
            return jsonErrorResponse("Too many plan edits. Please wait a moment and try again.", 429);
          }

          const result = await editSessionPlan(
            env,
            authorizedSessionId,
            {
              revision: parsed.value.revision,
              markdown: parsed.value.markdown,
              actorUserId: routeAuth.userId,
            },
            requestId,
            authCtx,
          );
          if (!result.ok || !result.payload) {
            audit(parsed.value.revision, result.status === 409 ? "conflict" : "edit_failed", result.status);
            return jsonErrorResponse(result.error ?? "Failed to edit plan", result.status);
          }
          audit(parsed.value.revision, "edited", 200);
          return jsonResponse(result.payload);
        },
      );
      if (!audited) {
        audit(
          null,
          response.status === 403 || response.status === 404 ? "denied" : "authorization_failed",
          response.status,
        );
      }
      return response;
    },
  },

  // Session usage
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/usage"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const result = await getSessionUsage(env, sessionId, requestId);
        if (!result.ok) return jsonErrorResponse("Session not found", 404);
        return jsonResponse(result);
      });
    },
  },

  // Session estimated input composition
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/input-composition"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const result = await getSessionInputComposition(env, sessionId, requestId);
        if (!result.ok) return jsonErrorResponse("Session not found", 404);
        return jsonResponse(result);
      });
    },
  },

  // Desktop action path snapshot
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/action-path"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const rateLimit = await checkDesktopActionPathSnapshotRateLimit(env, sessionId, routeAuth.userId);
        if (rateLimit.limited) {
          return jsonResponse(
            { ok: false, error: "Desktop action path snapshot is being read too quickly. Please retry shortly." },
            429,
            { "Retry-After": "2" },
          );
        }
        const result = await getSessionDesktopActionPathAuthed(env, sessionId, requestId, authCtx);
        if (!result.ok || !result.payload) {
          if (result.status === 404) return jsonErrorResponse("Session not found", 404);
          throw new Error(`Session DO desktop action path snapshot failed with status ${result.status}`);
        }
        return jsonResponse(result.payload);
      });
    },
  },

  // Desktop live-view ticket create
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/view-ticket"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth, ctx) => {
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      const rateLimit = await checkDesktopViewTicketCreateRateLimit(env, sessionId, routeAuth.userId);
      if (rateLimit.limited) {
        await emitDesktopRateLimited(env, ctx, "desktop_view_ticket_create", sessionId, routeAuth.userId, rateLimit);
        return desktopRateLimitedResponse(
          "Desktop viewing tickets are being created too quickly. Please retry shortly.",
          rateLimit,
        );
      }

      return withSession(request, env, match, routeAuth, async (authorizedSessionId, _session, requestId, authCtx) => {
        const result = await createSessionDesktopViewTicketAuthed(env, authorizedSessionId, requestId, authCtx);
        if (!result.ok || !result.payload) {
          if (result.status === 404) return jsonErrorResponse("Session not found", 404);
          if (result.errorDetails && typeof result.errorDetails.desktopViewRetryable === "boolean") {
            return jsonErrorResponse(result.error ?? "Desktop live view is unavailable", result.status, {
              code: "desktop_view_unavailable",
              desktopViewRetryable: result.errorDetails.desktopViewRetryable,
              desktopViewReason:
                typeof result.errorDetails.desktopViewReason === "string"
                  ? result.errorDetails.desktopViewReason
                  : null,
            });
          }
          return desktopTicketErrorResponse(result.status);
        }
        const response = buildDesktopViewTicketPaths(
          authorizedSessionId,
          result.payload.ticket,
        ) satisfies CreateDesktopViewTicketResponse;
        return jsonResponse(response);
      });
    },
  },

  // Desktop live-view ticket heartbeat
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/view-ticket/:ticketId/heartbeat"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);
      const routeAuth = requireRouteAuth(auth);
      const ticketId = match.groups!.ticketId;
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await heartbeatSessionDesktopViewTicketAuthed(
          env,
          sessionId,
          requestId,
          authCtx,
          desktopHeartbeatBody(ticketId),
        );
        return result.ok && result.payload ? jsonResponse(result.payload) : desktopTicketErrorResponse(result.status);
      });
    },
  },

  // Desktop live-view ticket revoke
  {
    method: "DELETE",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/view-ticket/:ticketId"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);
      const routeAuth = requireRouteAuth(auth);
      const ticketId = match.groups!.ticketId;
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await revokeSessionDesktopViewTicketAuthed(
          env,
          sessionId,
          requestId,
          authCtx,
          desktopRevokeBody(ticketId),
        );
        return result.ok && result.payload ? jsonResponse(result.payload) : desktopTicketErrorResponse(result.status);
      });
    },
  },

  // Desktop live-view ticket status
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/view-ticket/:ticketId/status"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);
      const routeAuth = requireRouteAuth(auth);
      const ticketId = match.groups!.ticketId;
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await getSessionDesktopViewTicketStatusAuthed(
          env,
          sessionId,
          requestId,
          authCtx,
          desktopStatusBody(ticketId),
        );
        return result.ok && result.payload ? jsonResponse(result.payload) : desktopTicketErrorResponse(result.status);
      });
    },
  },

  // Desktop live-view same-origin WebSocket proxy
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/desktop/view-ticket/:ticketId/ws"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    impersonationMutatingGet: true,
    handler: async (request, env, match, auth, ctx) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonErrorResponse("Expected websocket upgrade request", 426);
      }
      if (!isAllowedDesktopViewerWebSocketOrigin(request, env)) {
        return jsonErrorResponse("Origin not allowed", 403);
      }
      if (!(await verifyCycloidMember(env.DB, auth))) return jsonErrorResponse("Forbidden", 403);

      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      const ticketId = match.groups!.ticketId;
      const rateLimit = await checkDesktopViewWebSocketRateLimit(env, sessionId, routeAuth.userId);
      if (rateLimit.limited) {
        await emitDesktopRateLimited(env, ctx, "desktop_view_websocket", sessionId, routeAuth.userId, rateLimit);
        return desktopRateLimitedResponse(
          "Desktop live view is reconnecting too quickly. Please retry shortly.",
          rateLimit,
        );
      }

      return withSession(request, env, match, routeAuth, async (authorizedSessionId, _session, requestId, authCtx) => {
        const connectionId = crypto.randomUUID();
        const connectResult = await connectSessionDesktopViewTicketAuthed(
          env,
          authorizedSessionId,
          requestId,
          authCtx,
          desktopConnectBody(ticketId, connectionId),
        );
        if (!connectResult.ok || !connectResult.payload) return desktopTicketErrorResponse(connectResult.status);

        const identity = await buildDesktopProxyTelemetryIdentity(
          authorizedSessionId,
          routeAuth.userId,
          ticketId,
          connectionId,
        );
        const sandboxStateResult = await getSessionSandboxState(env, authorizedSessionId, requestId, authCtx);
        const upstreamResult = await resolveDesktopViewerUpstream({
          env,
          sandboxState: sandboxStateResult.payload?.sandboxState ?? null,
        });
        const resolvePayload = await buildDesktopProxyUpstreamResolveEvent(
          identity,
          upstreamResult.diagnostics,
          upstreamResult.ok ? "ready" : "failed",
        );
        if (upstreamResult.ok) {
          log.info(resolvePayload, "Desktop viewer upstream resolved");
        } else {
          log.warn(resolvePayload, "Desktop viewer upstream resolve failed");
        }
        ctx?.waitUntil(postStructuredEventToDd(env, resolvePayload));
        if (!upstreamResult.ok) {
          await closeDesktopTicketAfterProxy(
            env,
            authorizedSessionId,
            requestId,
            authCtx,
            ticketId,
            connectionId,
            "upstream_unavailable",
            upstreamResult.diagnostics.reason,
            desktopCloseDiagnosticsFromResolve(upstreamResult.diagnostics),
          );
          return jsonErrorResponse(upstreamResult.error, upstreamResult.status);
        }

        const connectPayload = {
          event: "desktop.proxy_connect",
          eventSource: "route",
          status: "connected",
          ...identity,
        };
        log.info(connectPayload, "Desktop viewer proxy connected");
        ctx?.waitUntil(postStructuredEventToDd(env, connectPayload));

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        server.accept();

        let lastHandshakeCloseDetail: string | null = null;
        let lastInputAttemptType: DesktopViewerInputAttempt | null = null;
        const proxyTask = proxyDesktopViewerWebSocket({
          upstream: upstreamResult.upstream,
          clientSocket: server,
          maxConnectionDurationMs: Math.max(0, connectResult.payload.ticket.hardExpiresAtMs - Date.now()),
          onInputAttempt: (inputType: DesktopViewerInputAttempt) => {
            lastInputAttemptType = inputType;
            const payload = {
              event: "desktop.proxy_input_attempt_blocked",
              eventSource: "route",
              inputType,
              ...identity,
            };
            log.warn(payload, "Desktop viewer input attempt observed on view-only proxy");
            ctx?.waitUntil(postStructuredEventToDd(env, payload));
          },
          onHandshake: async (diagnostics) => {
            lastHandshakeCloseDetail = desktopProxyHandshakeCloseDetail(diagnostics);
            const payload = buildDesktopProxyWebSocketHandshakeEvent(identity, diagnostics);
            if (diagnostics.hasWebSocket) {
              log.info(payload, "Desktop viewer upstream WebSocket handshake connected");
            } else {
              log.warn(payload, "Desktop viewer upstream WebSocket handshake failed");
            }
            ctx?.waitUntil(postStructuredEventToDd(env, payload));
          },
          onClose: async (closeDiagnostics) => {
            const reason = closeDiagnostics.reason;
            const closeDetail = reason === "input_blocked" ? lastInputAttemptType : lastHandshakeCloseDetail;
            await closeDesktopTicketAfterProxy(
              env,
              authorizedSessionId,
              requestId,
              authCtx,
              ticketId,
              connectionId,
              reason,
              closeDetail,
              desktopCloseDiagnosticsFromWebSocket(closeDiagnostics),
            );
            const payload = {
              event: "desktop.proxy_close",
              eventSource: "route",
              ...identity,
              reason,
              detail: closeDetail,
              closeSource: closeDiagnostics.source,
              closeCode: closeDiagnostics.code,
              socketCloseReason: closeDiagnostics.socketReason,
              closeWasClean: closeDiagnostics.wasClean,
            };
            log.info(payload, "Desktop viewer proxy closed");
            await postStructuredEventToDd(env, payload);
          },
        });
        ctx?.waitUntil(proxyTask);

        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      });
    },
  },

  // Sandbox artifact upload (bridge-authenticated)
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/artifacts"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return uploadSandboxArtifact(env, sessionId, request);
    },
  },

  // Sandbox Codex rollout persistence (bridge-authenticated)
  {
    method: "PUT",
    pattern: parsePattern("/api/sessions/:sessionId/rollout"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return uploadSandboxRollout(env, sessionId, request);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/rollout"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return downloadSandboxRollout(env, sessionId, request);
    },
  },

  // Artifact revocation (authenticated; prevents future public proxy access)
  {
    method: "DELETE",
    pattern: parsePattern("/api/sessions/:sessionId/artifacts/:artifactId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const artifactId = match.groups!.artifactId;
        const result = await revokeSessionArtifact(env, sessionId, artifactId, requestId);
        return jsonResponse(result, result.ok ? 200 : 404);
      });
    },
  },

  // Authenticated artifact view — serves session artifacts to the session owner via cookie auth.
  // Companion to the public proxy below; used by the UI screenshot panel for private-repo sessions.
  // MUST be declared before the wildcard `/:artifactId/:filename` route, otherwise the wildcard
  // matches `/<id>/view` first (treating "view" as a filename) and returns 404 without a token.
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/artifacts/:artifactId/view"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, _requestId) => {
        const artifactId = match.groups!.artifactId;
        const filename = parseArtifactFilenameQuery(request);
        if (!filename.ok) return filename.response;
        return getAuthedSessionArtifact(env, sessionId, artifactId, filename.value, request);
      });
    },
  },

  // Artifact proxy — serves S3-stored artifacts so PR screenshots render and PR
  // video links resolve on GitHub.
  // Two auth paths share this URL:
  //   1. Anonymous + signed `artifactToken=` query param — used by GitHub's
  //      PR-body <img> renderer for public-repo screenshots and by video links.
  //   2. Cookie-authed session owner with no token — used when a reviewer
  //      clicks a private-repo screenshot/video evidence link in a PR body.
  //      `SameSite=Lax` lets the cookie ride a top-level navigation
  //      but blocks cross-origin <img> tags, so anonymous GitHub renderers
  //      can't drag the cookie along.
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/artifacts/:artifactId/:filename"),
    auth: "public",
    handler: async (request, env, match) => {
      const { sessionId, artifactId, filename } = match.groups!;
      const requestedFilename = normalizeRequestedArtifactFilename(decodeArtifactPathSegment(filename));
      if (!requestedFilename) return new Response("Not found", { status: 404 });
      const url = new URL(request.url);

      if (url.searchParams.has(PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM)) {
        if (!resolveSandboxCallbackSecret(env)) return new Response("Not found", { status: 404 });
        return getPublicSessionArtifact(env, sessionId, artifactId, requestedFilename, request);
      }

      // Restricted to `user_session` mode so CLI/admin bearer tokens — which
      // have their own per-surface allowlists — can't backdoor private
      // artifacts here. Reviewers in browsers always come in as user_session.
      const authResult = await authenticateRequest(request, env);
      if (!authResult.ok || authResult.auth.authMode !== "user_session") {
        if (isBrowserNavigationRequest(request)) {
          return redirectToGithubAuthWithReturnTo(request, env);
        }
        return new Response("Not found", { status: 404 });
      }
      const response = await withSession(request, env, match, authResult.auth, async (sId) =>
        getAuthedSessionArtifact(env, sId, artifactId, requestedFilename, request),
      );
      if (response.status !== 200) return new Response("Not found", { status: 404 });
      return response;
    },
  },

  // Warm sandbox
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/warm"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session, requestId) => {
        // Warm and resume both trigger sandbox spawn work, so they intentionally
        // share this per-session/user budget before friendly phase/access gates.
        const rateLimit = await checkSessionResumeRateLimit(env, sessionId, routeAuth.userId);
        if (rateLimit.limited) {
          return jsonResponse(
            { ok: false, error: "Warm is being retried too quickly. Please wait a moment and try again." },
            429,
          );
        }
        const s = session as { phase?: Phase };
        if (s.phase && !isWarmAvailable(s.phase)) {
          return jsonResponse({ ok: false, error: WARM_BLOCKED_ERROR, reason: s.phase }, 409);
        }
        const validation = await resolveAndRefreshSessionResumeAccess(
          env,
          routeAuth,
          sessionId,
          session as SessionRouteState,
        );
        if (!validation.ok) return validation.response;
        const trigger =
          new URL(request.url).searchParams.get("trigger") === "page_open" ? "page_open" : "composer_input";
        const result = await warmSession(env, sessionId, requestId, trigger);
        return jsonResponse(result, result.ok ? (result.status === "spawning" ? 202 : 200) : 409);
      });
    },
  },

  // Resume sandbox for a stopped session
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/resume"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session, requestId) => {
        const sessionStatus = String((session as { status?: string }).status ?? "");
        if (sessionStatus === "archived") {
          return jsonErrorResponse("Session is archived. Start a new session to continue.", 409);
        }
        const rateLimit = await checkSessionResumeRateLimit(env, sessionId, routeAuth.userId);
        if (rateLimit.limited) {
          return jsonResponse(
            { ok: false, error: "Resume is being retried too quickly. Please wait a moment and try again." },
            429,
          );
        }
        const validation = await resolveAndRefreshSessionResumeAccess(
          env,
          routeAuth,
          sessionId,
          session as SessionRouteState,
        );
        if (!validation.ok) return validation.response;
        // Phase gate via the shared helper, placed after rate-limit + access
        // checks so abusive resume floods on a non-stopped session still
        // surface as 429 / 403 rather than masquerading as a friendly 409.
        // `isResumeAvailable` returns true only for `stopped` (both stopMode
        // flavors); resume on running/idle/waiting_for_input/etc. would race
        // the active prompt or no-op.
        const s = session as { phase?: Phase };
        // Fail closed: an absent phase is treated as non-resumable rather
        // than a free pass through the gate.
        if (!s.phase || !isResumeAvailable(s.phase)) {
          return jsonResponse({ ok: false, error: RESUME_BLOCKED_ERROR, reason: s.phase ?? "unknown" }, 409);
        }
        const result = await resumeSession(env, sessionId, requestId);
        return jsonResponse(result, result.ok ? 202 : 409);
      });
    },
  },

  // Replay the last terminal (completed/failed) prompt. First public retry
  // surface (the DO's /session/retry was previously internal-only); the Slack
  // card Retry button rides the same service path.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/retry"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session, requestId) => {
        const sessionStatus = String((session as { status?: string }).status ?? "");
        if (sessionStatus === "archived") {
          return jsonErrorResponse("Session is archived. Start a new session to continue.", 409);
        }
        // Retry spawns/dispatches like resume, so it shares resume's per-user
        // per-session rate budget (same limiter key family).
        const rateLimit = await checkSessionResumeRateLimit(env, sessionId, routeAuth.userId);
        if (rateLimit.limited) {
          return jsonResponse(
            { ok: false, error: "Retry is being attempted too quickly. Please wait a moment and try again." },
            429,
          );
        }
        const validation = await resolveAndRefreshSessionResumeAccess(
          env,
          routeAuth,
          sessionId,
          session as SessionRouteState,
        );
        if (!validation.ok) return validation.response;
        // Phase gate via the shared helper, after rate-limit + access checks
        // (same ordering rationale as resume). `isRetryAvailable` is the
        // eligibility floor; the DO additionally rejects a retry while a
        // prompt is active/queued (`retry_in_progress`) so a double call
        // cannot double-clone, and 400s when no terminal prompt exists.
        const s = session as { phase?: Phase };
        // Fail closed: an absent phase is treated as non-retryable.
        if (!s.phase || !isRetryAvailable(s.phase)) {
          return jsonResponse({ ok: false, error: RETRY_BLOCKED_ERROR, reason: s.phase ?? "unknown" }, 409);
        }
        const result = await retrySessionPrompt(env, sessionId, requestId);
        return jsonResponse(result, result.ok ? 202 : 409);
      });
    },
  },

  // Event history (with optional prompt_id filter)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/events/history"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const replayQuery = parseSessionReplayRequest(request);
        if (!replayQuery.ok) {
          return replayQuery.response;
        }
        const result = await getSessionReplayPageAuthed(env, sessionId, authCtx, replayQuery.value, requestId);
        if (result.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!result.ok) {
          throw new Error(`Session DO event history failed with status ${result.status}`);
        }
        return jsonResponse(result.payload!);
      });
    },
  },

  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/events/bootstrap"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSessionHistoryIdentity(request, env, match, routeAuth, async (sessionId, requestId, authCtx) => {
        const promptIds = [...new Set(new URL(request.url).searchParams.getAll("prompt_id"))];
        const result = await getSessionBootstrapAuthed(env, sessionId, authCtx, promptIds, requestId);
        if (result.status === 404) return jsonErrorResponse("Session not found", 404);
        if (!result.ok) throw new Error(`Session DO event bootstrap failed with status ${result.status}`);
        return jsonResponse(result.payload!);
      });
    },
  },

  // Session context inspection
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/context"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await getSessionContextAuthed(env, sessionId, authCtx, requestId);
        if (result.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!result.ok) {
          throw new Error(`Session DO context lookup failed with status ${result.status}`);
        }
        return jsonResponse(result.payload!);
      });
    },
  },

  // Session export
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/export"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const result = await getSessionExportDataAuthed(env, sessionId, authCtx, requestId);
        if (result.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!result.ok) {
          throw new Error(`Session DO export failed with status ${result.status}`);
        }
        return jsonResponse(result.payload!);
      });
    },
  },

  // Set session repo
  {
    method: "PUT",
    pattern: parsePattern("/api/sessions/:sessionId/repo"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const payload = (await parseJsonBody(request)) || {};
        const repoUrl = payload.repoUrl as string | undefined;
        if (!repoUrl || typeof repoUrl !== "string") {
          return jsonErrorResponse("Missing repoUrl", 400);
        }
        let owner: string;
        let repo: string;
        try {
          ({ owner, repo } = parseRepoUrl(repoUrl));
        } catch {
          return jsonErrorResponse(`Invalid repo URL: ${repoUrl}`, 400);
        }

        const repoGate = await verifyRepoAccessAndInstallation(
          env.DB,
          {
            userId: routeAuth.userId,
            canAccessAllSessions: !!routeAuth.canAccessAllSessions,
            businessRole: routeAuth.user?.businessRole ?? null,
          },
          owner,
          repo,
          { githubTokenEnv: env, reposCacheEnv: env },
        );
        if (!repoGate.ok) return repoGate.response;

        const baseBranch = payload.baseBranch as string | undefined;
        const result = await setSessionRepo(
          env,
          sessionId,
          owner,
          repo,
          baseBranch,
          repoGate.installationId,
          requestId,
        );
        if (!result.ok) return jsonResponse(result, 400);
        return jsonResponse({ ok: true });
      });
    },
  },
  // File tree for autocomplete
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/files"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        if (routeAuth.canAccessAllSessions) {
          return jsonErrorResponse("Browser-only feature", 403);
        }
        const ctx = await getSessionContext(env, sessionId, requestId);
        if (!ctx.ok || !ctx.context) {
          return jsonErrorResponse("Session context not available", 404);
        }
        const { repoOwner, repoName, baseBranch } = ctx.context as {
          repoOwner?: string;
          repoName?: string;
          baseBranch?: string;
        };
        if (!repoOwner || !repoName) {
          return jsonErrorResponse("No repo configured for session", 400);
        }
        const branch = baseBranch || "main";
        const cacheKey = `files:${routeAuth.userId}:${repoOwner}:${repoName}:${branch}`;

        // Check KV cache
        const cached = (await env.REPOS_CACHE.get(cacheKey, "json")) as { files: string[] } | null;
        if (cached) {
          return jsonResponse({ files: cached.files });
        }

        // Fetch from GitHub with user's OAuth token
        const token = await getValidGithubToken(env.DB, routeAuth.userId, env);
        if (!token) {
          return jsonErrorResponse("GitHub token not found", 401);
        }

        try {
          const files = await fetchRepoTree(token, repoOwner, repoName, branch);
          await env.REPOS_CACHE.put(cacheKey, JSON.stringify({ files }), { expirationTtl: 300 });
          return jsonResponse({ files });
        } catch (err) {
          Sentry.captureException(err, { tags: { operation: "fetchRepoTree" } });
          return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : "Failed to fetch file tree" },
            500,
          );
        }
      });
    },
  },

  // Submit session feedback
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/feedback"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId, authCtx) => {
        const exportResult = await getSessionExportDataAuthed(env, sessionId, authCtx, requestId);
        if (exportResult.status === 404) {
          return jsonErrorResponse("Session not found", 404);
        }
        if (!exportResult.ok) {
          throw new Error(`Session DO export failed with status ${exportResult.status}`);
        }

        const payload = (await parseJsonBody(request)) || {};
        const rating = payload.rating as string;
        if (rating !== "up" && rating !== "down") {
          return jsonErrorResponse("rating must be 'up' or 'down'", 400);
        }
        const message = asNonEmptyString(payload.message) ?? undefined;

        let transcript: string | undefined;
        try {
          const result = buildSessionTranscript(
            exportResult.payload! as unknown as Parameters<typeof buildSessionTranscript>[0],
          );
          transcript = result.transcript;
        } catch (err) {
          log.error({ err, sessionId }, "Failed to generate transcript for feedback");
        }

        const db = assertDatabase(env);
        await upsertSessionFeedback(db, { sessionId, userId: routeAuth.userId, rating, message, transcript });

        const slackToken = env.SLACK_BOT_TOKEN;
        const feedbackChannel = SESSION_FEEDBACK_CHANNEL_ID;
        if (slackToken) {
          const emoji = rating === "up" ? ":thumbsup:" : ":thumbsdown:";
          const userLabel = routeAuth.user?.login ?? routeAuth.userId;
          const sessionUrl = resolvePublicSessionUrl(env, sessionId);
          const parts = [`${emoji} *${rating}* from ${userLabel} on session \`${sessionId}\``];
          if (message) parts.push(`> ${message}`);
          parts.push(`<${sessionUrl}|View session>`);
          // Best-effort: postInternalAlert swallows Slack errors (returns null),
          // so a Slack failure no longer propagates out of the feedback route.
          const slackResp = await postInternalAlert(env, feedbackChannel, parts.join("\n"));
          if (transcript && slackResp?.ok && slackResp.ts) {
            const uploadResult = await uploadFile(
              slackToken,
              feedbackChannel,
              slackResp.ts,
              `transcript-${sessionId}.md`,
              transcript,
            );
            if (!uploadResult.ok) {
              log.error({ sessionId, error: uploadResult.error }, "Failed to upload transcript to Slack");
            }
          }
        }

        return jsonResponse({ ok: true });
      });
    },
  },

  // Get session feedback
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/feedback"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId) => {
        const db = assertDatabase(env);
        const row = await getSessionFeedback(db, sessionId, routeAuth.userId);
        return jsonResponse({
          feedback: row ? { rating: row.rating, message: row.message } : null,
        });
      });
    },
  },

  // Submit memory feedback for transcript-visible memory rows.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/memory-feedback"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, session) => {
        const payload = (await parseJsonBody(request)) || {};
        const result = await submitMemoryFeedback({
          env,
          sessionId,
          session,
          auth: { userId: routeAuth.userId, userLogin: routeAuth.user?.login ?? null },
          payload,
        });
        if (!result.ok) return jsonErrorResponse(result.error, 400);
        return jsonResponse(result);
      });
    },
  },

  // Get the latest memory feedback rows for the current user.
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/memory-feedback"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId) => {
        const feedback = await getLatestMemoryFeedbackForUser({ env, sessionId, userId: routeAuth.userId });
        return jsonResponse({ feedback });
      });
    },
  },

  // Session view (page-ready DTO for the session detail page)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/view"),
    auth: "authenticated",
    handler: async (request, env, match, auth, ctx) => {
      const routeAuth = requireRouteAuth(auth);
      const sessionId = match.groups!.sessionId;
      return withRouteSpan(
        "sessions.view",
        { auth: routeAuth, attributes: { "session.id": sessionId } },
        async (span) => {
          const requestId = extractRequestId(request);
          const cleanupOrphanIfAuthorized = async () => {
            if (!env.DB || !ctx) return;
            const row = await getSessionIndexIdentity(env.DB, sessionId);
            if (row && canAccessSessionIdentity(routeAuth, String(row.ownerUserId), row.businessId)) {
              ctx.waitUntil(cleanupOrphanedSession(env.DB, sessionId));
            }
          };

          // Single DO hop: fetch the full view once, then authorize in the
          // worker using identity/repo fields carried in the payload. We pass no
          // auth context to the DO on purpose. The DO's `checkAccess` gate for a
          // shared-business member requires the auth context to already carry the
          // repoAccessVerified* fields, and those are only populated AFTER the
          // worker proves repo access — which in this single-hop design happens
          // below, after this fetch. Forwarding the raw (unverified) context would
          // make `checkAccess` 404 a legitimate same-business viewer before the
          // worker can return the correct 403/200 (covered by session-features
          // "rejects same-business non-owner reads without GitHub repo
          // visibility"). The worker is the authoritative boundary: it proves
          // identity then repo access below and never returns data to an
          // unauthorized caller (`checkAccess` never redacts the payload).
          //
          // NOTE: we keep inline uploaded-image base64 here. SessionTurn renders
          // user-uploaded prompt images directly from `uploadedImages[].data`
          // (data: URL), not via /artifacts/:id/view, so dropping it would break
          // those thumbnails. Only agent screenshots lazy-load via the artifact
          // endpoint.
          const url = new URL(request.url);
          const promptCursor = url.searchParams.get("promptCursor") ?? undefined;
          const promptLimitRaw = url.searchParams.get("promptLimit");
          const promptLimitParsed = promptLimitRaw === null ? Number.NaN : parseInt(promptLimitRaw, 10);
          const promptLimit = Number.isFinite(promptLimitParsed) ? promptLimitParsed : undefined;

          let result;
          const viewStartedAt = Date.now();
          try {
            result = await getSessionView(env, sessionId, requestId, undefined, {
              promptCursor,
              promptLimit,
            });
          } catch (err) {
            span.setAttribute("error.message", String(err));
            log.error({ sessionId, error: String(err) }, "Session view combined DO fetch failed");
            return jsonErrorResponse("Failed to assemble session view", 500);
          }

          if (result.status === 404 || !result.payload) {
            if (result.status === 404) {
              await cleanupOrphanIfAuthorized();
              span.setAttribute("db.rows_returned", 0);
              return jsonErrorResponse("Session not found", 404);
            }
            span.setAttribute("error.message", `Session view payload unavailable (status ${result.status})`);
            log.error({ sessionId, status: result.status }, "Session view combined DO fetch failed");
            return jsonErrorResponse("Failed to assemble session view", 500);
          }

          const { session, prompts, queue, outcomePrompts } = result.payload;
          const doFetchDurationMs = Date.now() - viewStartedAt;
          recordSessionViewDoMetrics(span, result.payload.metrics);
          if (!canAccessSessionIdentity(routeAuth, session.ownerUserId, session.businessId)) {
            span.setAttribute("db.rows_returned", 0);
            return jsonErrorResponse("Session not found", 404);
          }

          // Prove repo access in the worker before returning any session data.
          // The payload's session carries repoOwner/repoName/installationId, so
          // no second DO hop is needed to supply repo context.
          const repoAccess = await authorizeSessionRepoAccess(
            env,
            routeAuth,
            sessionId,
            session as unknown as SessionRouteState,
            "view",
            span,
          );
          if (!repoAccess.ok) return repoAccess.response;

          // Surface parent/child orchestration metadata (ARC-657) so the session
          // detail page can render Parent/Children badges without an extra
          // round-trip. Best-effort: fall back gracefully if either lookup
          // fails so the view still renders.
          const db = env.DB;
          // Kick off the best-effort parent/child metadata reads (two dependent D1
          // round-trips) without awaiting, and hand the promise to assembleSessionView
          // so it resolves concurrently with that function's own D1 reads instead of
          // blocking ahead of it. Same best-effort semantics: any failure degrades to
          // no parent/child badges, never fails the view.
          const parentMetadataPromise: Promise<SessionViewParentMetadata> = db
            ? getChildContextForSession(db, sessionId, session.businessId ?? null, session.prUrl ?? null)
                .then(async ({ childRow, childIds, qaChildSessionId }) => {
                  const parentMetadata = await getBoundedChildParentMetadata(
                    db,
                    childRow,
                    session.businessId ?? null,
                  ).catch((err) => {
                    log.warn({ sessionId, error: String(err) }, "Session view: parent metadata boundary read failed");
                    return null;
                  });
                  return {
                    parentSessionId: parentMetadata?.parentSessionId ?? null,
                    parentPromptId: parentMetadata?.parentPromptId ?? null,
                    spawnDepth: parentMetadata?.spawnDepth ?? null,
                    childSessionIds: childIds,
                    qaChildSessionId,
                  } satisfies SessionViewParentMetadata;
                })
                .catch((err) => {
                  log.warn({ sessionId, error: String(err) }, "Session view: child-context batch read failed");
                  return {
                    childSessionIds: [] as string[],
                    qaChildSessionId: null,
                  } satisfies SessionViewParentMetadata;
                })
            : Promise.resolve({
                childSessionIds: [] as string[],
                qaChildSessionId: null,
              } satisfies SessionViewParentMetadata);
          try {
            // assembly_ms now measures max(actor_profiles, lifecycle_stage,
            // remaining parentMetadata wait): parentMetadataPromise is started
            // above, before this timestamp, so any of its wait that outlasts the
            // assembly reads lands inside this window. In practice negligible
            // (metadata P95 ~0.5s vs assembly P95 ~2.3s), but note it when
            // comparing pre/post-deploy assembly_ms baselines.
            const assembleStartedAt = Date.now();
            const assemblyTimings: Record<string, SessionViewReadTiming> = {};
            const view = await assembleSessionView(session, { prompts, queue, outcomePrompts }, routeAuth, {
              db,
              promptPage: result.payload.promptPage,
              requestId,
              parentMetadata: parentMetadataPromise,
              timingRecorder: (segment, timing) => {
                assemblyTimings[segment] = timing;
              },
            });
            const assemblyDurationMs = Date.now() - assembleStartedAt;
            const totalDurationMs = Date.now() - viewStartedAt;
            span.setAttribute("session.prompt_count", prompts.length);
            span.setAttribute("session.prompt_page_size", view.prompts.items.length);
            span.setAttribute("session.view.do_fetch_ms", doFetchDurationMs);
            span.setAttribute("session.view.assembly_ms", assemblyDurationMs);
            recordSessionViewTiming(span, "worker_actor_profiles", assemblyTimings.worker_actor_profiles);
            recordSessionViewTiming(span, "worker_ui_lifecycle_stage", assemblyTimings.worker_ui_lifecycle_stage);
            recordSessionViewTiming(span, "worker_parent_metadata_wait", assemblyTimings.worker_parent_metadata_wait);
            recordSessionViewTiming(span, "assembly_cpu", assemblyTimings.assembly_cpu);
            const metricsEvent = {
              event: "session.view.metrics",
              sessionId,
              promptCount: prompts.length,
              promptPageSize: view.prompts.items.length,
              promptNextCursor: view.prompts.nextCursor,
              promptTotal: view.prompts.total,
              doFetchDurationMs,
              doBuildMs: result.payload.metrics?.doBuildMs ?? null,
              doPromptActorProfilesMs: result.payload.metrics?.doPromptActorProfiles.durationMs ?? null,
              doPromptActorProfilesOutcome: result.payload.metrics?.doPromptActorProfiles.outcome ?? null,
              doOwnerActorProfileMs: result.payload.metrics?.doOwnerActorProfile.durationMs ?? null,
              doOwnerActorProfileOutcome: result.payload.metrics?.doOwnerActorProfile.outcome ?? null,
              doSpineDoneMirrorMs: result.payload.metrics?.doSpineDoneMirror.durationMs ?? null,
              doSpineDoneMirrorOutcome: result.payload.metrics?.doSpineDoneMirror.outcome ?? null,
              workerActorProfilesMs: assemblyTimings.worker_actor_profiles?.durationMs ?? null,
              workerActorProfilesOutcome: assemblyTimings.worker_actor_profiles?.outcome ?? null,
              workerUiLifecycleStageMs: assemblyTimings.worker_ui_lifecycle_stage?.durationMs ?? null,
              workerUiLifecycleStageOutcome: assemblyTimings.worker_ui_lifecycle_stage?.outcome ?? null,
              workerParentMetadataWaitMs: assemblyTimings.worker_parent_metadata_wait?.durationMs ?? null,
              workerParentMetadataWaitOutcome: assemblyTimings.worker_parent_metadata_wait?.outcome ?? null,
              assemblyCpuMs: assemblyTimings.assembly_cpu?.durationMs ?? null,
              assemblyDurationMs,
              totalDurationMs,
            };
            const metricsPost = postStructuredEventToDd(env, metricsEvent);
            if (ctx) ctx.waitUntil(metricsPost);
            log.info(metricsEvent, "Session view metrics");
            span.setAttribute("db.rows_returned", 1);
            return jsonResponse(view);
          } catch (err) {
            span.setAttribute("error.message", String(err));
            log.error({ sessionId, error: String(err) }, "Session view assembly failed");
            return jsonErrorResponse("Failed to assemble session view", 500);
          }
        },
      );
    },
  },

  // Get session
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withRouteSpan(
        "sessions.get",
        { auth: routeAuth, attributes: { "session.id": match.groups!.sessionId } },
        async (span) =>
          withSession(request, env, match, routeAuth, async (sessionId, session) => {
            const db = assertDatabase(env);
            const needsOwnerProfile = session.ownerUserId !== routeAuth.userId;

            const [ownerRow, childRow, childIds] = await Promise.all([
              needsOwnerProfile
                ? getUserDisplayProfile(db, session.ownerUserId).catch((error) => {
                    log.warn(
                      { sessionId, ownerUserId: session.ownerUserId, error: String(error) },
                      "Failed to load session owner profile",
                    );
                    return null;
                  })
                : Promise.resolve(null),
              getChildSessionRow(db, sessionId).catch((error) => {
                log.warn({ sessionId, error: String(error) }, "Failed to read child-session metadata");
                return null;
              }),
              getChildSessionIdsForParent(db, sessionId, session.businessId ?? null).catch((error) => {
                log.warn({ sessionId, error: String(error) }, "Failed to list child sessions");
                return [] as string[];
              }),
            ]);

            const parentMetadata = await getBoundedChildParentMetadata(db, childRow, session.businessId ?? null).catch(
              (error) => {
                log.warn({ sessionId, error: String(error) }, "Failed to read bounded parent metadata");
                return null;
              },
            );
            const ownerLogin = ownerRow?.login;
            const ownerAvatarUrl = ownerRow?.avatarUrl;
            span.setAttribute("db.rows_returned", 1);
            return jsonResponse({
              session: normalizePublicSessionPayload(session),
              ...(ownerLogin && { ownerLogin }),
              ...(ownerAvatarUrl && { ownerAvatarUrl }),
              ...(parentMetadata
                ? {
                    parentSessionId: parentMetadata.parentSessionId,
                    parentPromptId: parentMetadata.parentPromptId,
                    spawnDepth: parentMetadata.spawnDepth,
                  }
                : {}),
              ...(childIds.length > 0 ? { childSessionIds: childIds } : {}),
            });
          }),
      );
    },
  },

  // Create child session from a bound sandbox. The SessionDO verifies the
  // sandbox token and returns identity facts only; the worker resolves current
  // membership and invokes the shared authenticated create pipeline.
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/sandbox/child-sessions"),
    auth: "sandbox_do_verified",
    handler: async (request, env, match, _auth, ctx) => createSandboxChildSession(request, env, match, ctx),
  },

  // Create child session (ARC-657)
  {
    method: "POST",
    pattern: parsePattern("/api/sessions/:sessionId/child-sessions"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth, ctx) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (parentSessionId, _parent, requestId, authCtx) => {
        const startedAt = Date.now();
        let childSessionOutcomeEmitted = false;
        const postChildSessionCreateOutcome = (
          outcome:
            "success" | "replay" | "invalid_input" | "forbidden" | "limit_exceeded" | "not_found" | "upstream_error",
          fields: Record<string, unknown> = {},
        ) =>
          postStructuredEventToDd(env, {
            event: "spawn_child_session.create",
            surface: "control_plane",
            outcome,
            duration_ms: Math.max(0, Date.now() - startedAt),
            ...fields,
          }).catch((error) => {
            log.warn({ error: String(error), outcome }, "Failed to post child-session create telemetry");
            return false;
          });
        const emitChildSessionCreateOutcome = (
          outcome:
            "success" | "replay" | "invalid_input" | "forbidden" | "limit_exceeded" | "not_found" | "upstream_error",
          fields: Record<string, unknown> = {},
        ) => {
          childSessionOutcomeEmitted = true;
          const post = postChildSessionCreateOutcome(outcome, fields);
          if (ctx) ctx.waitUntil(post);
          else void post;
        };

        const payload = (await parseJsonBody(request)) || {};
        const prompt = asNonEmptyString(payload.prompt);
        const repositoryId = asNonEmptyString(payload.repositoryId);
        const title = asNonEmptyString(payload.title) ?? undefined;
        const reasoningEffortRaw = asNonEmptyString(payload.reasoningEffort) ?? null;
        const reasoningEffort =
          reasoningEffortRaw === "low" || reasoningEffortRaw === "medium" || reasoningEffortRaw === "high"
            ? reasoningEffortRaw
            : undefined;
        const model = asNonEmptyString(payload.model) ?? undefined;
        const qaRequest = normalizePublicQaRequest(payload);
        if (!qaRequest.ok) {
          emitChildSessionCreateOutcome("invalid_input", { errorCode: "invalid_input" });
          return jsonResponse({ ok: false, error: { code: "invalid_input", message: qaRequest.error } }, 400);
        }
        const qaRequested = qaRequest.qaRequested;
        let targetPrUrl: string | null = null;
        if (payload.targetPrUrl !== undefined && payload.targetPrUrl !== null) {
          targetPrUrl = normalizeGithubPullRequestUrl(payload.targetPrUrl);
          if (!targetPrUrl) {
            emitChildSessionCreateOutcome("invalid_input", { errorCode: "invalid_input" });
            return jsonResponse(
              {
                ok: false,
                error: { code: "invalid_input", message: "targetPrUrl must be a valid GitHub pull request URL" },
              },
              400,
            );
          }
        } else if (qaRequested) {
          const targetPrUrlSelection = resolveQaTargetPullRequestUrl(prompt);
          if (targetPrUrlSelection.status === "ambiguous") {
            emitChildSessionCreateOutcome("invalid_input", { errorCode: "invalid_input" });
            return jsonResponse(
              {
                ok: false,
                error: { code: "invalid_input", message: AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE },
              },
              400,
            );
          }
          targetPrUrl = targetPrUrlSelection.status === "selected" ? targetPrUrlSelection.targetPrUrl : null;
        }

        if (!prompt) {
          emitChildSessionCreateOutcome("invalid_input", { errorCode: "missing_field" });
          return jsonResponse({ ok: false, error: { code: "missing_field", message: "prompt is required" } }, 400);
        }
        if (!repositoryId) {
          emitChildSessionCreateOutcome("invalid_input", { errorCode: "missing_field" });
          return jsonResponse(
            { ok: false, error: { code: "missing_field", message: "repositoryId is required" } },
            400,
          );
        }

        const frontendUrl = resolvePublicAppBaseUrl(env);
        const idempotencyKey = readIdempotencyKeyHeader(request);
        let idempotencyToken: IdempotencyToken | null = null;
        let reservedChildSessionId: string | null = null;
        let childSessionProjected = false;
        let initialPromptEnqueued = false;
        const releaseIdempotencyClaim = async () => {
          if (idempotencyToken) {
            await releaseIdempotentRequest(env.DB, idempotencyToken);
            idempotencyToken = null;
          }
        };
        if (idempotencyKey) {
          const decision = await beginIdempotentRequest(env.DB, {
            key: idempotencyKey,
            ownerUserId: routeAuth.userId,
            route: `child-session:${parentSessionId}`,
            requestBody: payload,
          });
          if (decision.kind === "replay") {
            emitChildSessionCreateOutcome("replay", { idempotentReplay: true });
            return jsonResponse(
              {
                ok: true,
                childSessionId: decision.resolvedId,
                childSessionUrl: buildChildSessionUrl(frontendUrl, decision.resolvedId),
                idempotentReplay: true,
              },
              201,
            );
          }
          if (decision.kind === "reject") {
            emitChildSessionCreateOutcome(decision.reason === "payload_mismatch" ? "invalid_input" : "limit_exceeded", {
              errorCode: decision.reason,
            });
            return jsonResponse(
              {
                ok: false,
                error: {
                  code: decision.reason,
                  message:
                    decision.reason === "payload_mismatch"
                      ? "Idempotency-Key was already used with a different payload"
                      : "A request with this Idempotency-Key is in progress; retry shortly",
                },
              },
              decision.status,
            );
          }
          if (decision.kind === "proceed") {
            idempotencyToken = decision.token;
          }
        }

        try {
          const db = assertDatabase(env);
          const { parentPromptId } = await resolveChildSessionParentPromptId({
            env,
            parentSessionId,
            requestId,
            auth: authCtx,
            requestedParentPromptId: asNonEmptyString(payload.parentPromptId),
          });
          const childSessionRequest: CreateChildSessionRequest = {
            prompt,
            repositoryId,
            title,
            model,
            reasoningEffort,
            parentPromptId,
            ...(qaRequested ? { qa: true } : {}),
            ...(targetPrUrl ? { targetPrUrl } : {}),
          };
          const validated = await validateChildSessionCreation({
            env,
            db,
            auth: {
              userId: routeAuth.userId,
              canAccessAllSessions: !!routeAuth.canAccessAllSessions,
              businessId: routeAuth.user?.businessId ?? null,
              businessRole: routeAuth.user?.businessRole ?? null,
            },
            parentSessionId,
            parentPromptId,
            request: childSessionRequest,
          });
          if (!validated.ok) {
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome(childSessionCreateOutcomeForCode(validated.error.code), {
              errorCode: validated.error.code,
            });
            const status = childSessionErrorStatus(validated.error.code);
            return jsonResponse({ ok: false, error: validated.error }, status);
          }

          const { plan } = validated;
          if (qaRequested && targetPrUrl) {
            const parsedTargetPr = parseGithubPullRequestUrl(targetPrUrl);
            if (!parsedTargetPr) {
              await releaseIdempotencyClaim();
              emitChildSessionCreateOutcome("invalid_input", { errorCode: "invalid_input" });
              return jsonResponse(
                {
                  ok: false,
                  error: { code: "invalid_input", message: "targetPrUrl must be a valid GitHub pull request URL" },
                },
                400,
              );
            }
            if (
              parsedTargetPr.owner.toLowerCase() !== plan.childRepoOwner.toLowerCase() ||
              parsedTargetPr.repo.toLowerCase() !== plan.childRepoName.toLowerCase()
            ) {
              await releaseIdempotencyClaim();
              emitChildSessionCreateOutcome("forbidden", { errorCode: "unauthorized_repo" });
              return jsonResponse(
                {
                  ok: false,
                  error: {
                    code: "unauthorized_repo",
                    message: "targetPrUrl must belong to the same repository as the parent session",
                  },
                },
                403,
              );
            }
          }
          const agentRuntime = resolveAgentRuntimeMetadata({ qa: qaRequested, targetPrUrl });
          if (requiresQaTargetPrUrl({ qa: qaRequested, targetPrUrl: agentRuntime.targetPrUrl })) {
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("invalid_input", { errorCode: "missing_field" });
            return jsonResponse(
              {
                ok: false,
                error: {
                  code: "missing_field",
                  message:
                    "QA requires a GitHub pull request URL. Provide targetPrUrl or include a pull request URL in the prompt.",
                },
              },
              400,
            );
          }
          // Child sessions inherit the parent's agent runtime backend. Null legacy
          // rows resolve to codex for compatibility with sessions created before
          // agent_runtime_backend was persisted.
          let childAgentRuntimeBackend;
          try {
            childAgentRuntimeBackend = resolveAgentRuntimeBackend(plan.parent.agent_runtime_backend);
          } catch (error) {
            log.error(
              { parentSessionId, error: String(error) },
              "Child session rejected due to invalid parent agent runtime backend",
            );
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
            return jsonResponse(
              {
                ok: false,
                error: { code: "internal_error", message: "Parent session agent runtime backend is invalid" },
              },
              500,
            );
          }
          const requestedModelId = extractModelId(model);
          if (
            requestedModelId !== undefined &&
            !isSessionStartModelAllowedForBackend(requestedModelId, childAgentRuntimeBackend)
          ) {
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("invalid_input", { errorCode: "invalid_model" });
            return jsonResponse(
              { ok: false, error: { code: "invalid_model", message: `Invalid model: ${requestedModelId}` } },
              400,
            );
          }
          const modelId =
            extractSessionStartModelIdForBackend(model, childAgentRuntimeBackend) ??
            getDefaultSessionStartModelIdForBackend(childAgentRuntimeBackend);
          const resolvedReasoningEffort: string | null =
            reasoningEffort ?? MODEL_REASONING_CONFIG[modelId]?.default ?? null;
          const childSessionId = crypto.randomUUID();
          let childRuntimeBackend;
          try {
            childRuntimeBackend = parsePersistedRuntimeBackend(plan.parent.runtime_backend);
          } catch (error) {
            log.error(
              { parentSessionId, childSessionId, error: String(error) },
              "Child session rejected due to invalid parent runtime backend",
            );
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
            return jsonResponse(
              { ok: false, error: { code: "internal_error", message: "Parent session runtime backend is invalid" } },
              500,
            );
          }

          // Effective owner is always the parent's owner_user_id, regardless of
          // whether the request was authenticated by the user themselves or by
          // an elevated internal auth path such as the admin token.
          const childOwnerUserId = String(plan.parentContext.spawnedByUserId);
          reservedChildSessionId = childSessionId;
          if (isQaTesterAgentRole(agentRuntime.agentRole) && agentRuntime.targetPrUrl) {
            const coordinated = await requestCoordinatedVerification({
              env,
              logger: log,
              waitUntil: waitUntilFromContext(ctx),
              source: "child_session",
              ownerUserId: childOwnerUserId,
              businessId: plan.parent.business_id,
              repoOwner: plan.childRepoOwner,
              repoName: plan.childRepoName,
              installationId: plan.installationId,
              prUrl: agentRuntime.targetPrUrl,
              prompt,
              requestId,
              childParentContext: plan.parentContext,
              // Manual "Verify" button intent: always start a fresh verifier, superseding any in-flight
              // run for this PR instead of reusing it (bounded by the per-PR run cap).
              forceNewSession: payload.forceNewSession === true,
            });
            if (coordinated.ok) {
              if (idempotencyToken) {
                await commitIdempotentRequest(env.DB, idempotencyToken, coordinated.sessionId);
                idempotencyToken = null;
              }
              emitChildSessionCreateOutcome("success");
              childSessionOutcomeEmitted = true;
              return jsonResponse(
                {
                  ok: true,
                  childSessionId: coordinated.sessionId,
                  childSessionUrl: buildChildSessionUrl(frontendUrl, coordinated.sessionId),
                  parentSessionId,
                  parentPromptId,
                  spawnDepth: plan.parentContext.spawnDepth,
                  promptAlreadyEnqueued: true,
                  duplicate: coordinated.duplicate,
                },
                201,
              );
            }
            if (coordinated.reason === "run_limit_reached") {
              await releaseIdempotencyClaim();
              emitChildSessionCreateOutcome("limit_exceeded", { errorCode: "concurrent_limit_exceeded" });
              return jsonResponse(
                {
                  ok: false,
                  error: {
                    code: "concurrent_limit_exceeded",
                    message: "Verification has reached the run limit for this pull request",
                    details: { reason: "verification_run_limit_reached" },
                  },
                },
                409,
              );
            }
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: coordinated.reason });
            if (coordinated.reason === "admitted_elsewhere") {
              return jsonResponse(
                {
                  ok: false,
                  error: {
                    code: "concurrent_limit_exceeded",
                    message: "A verification request is already being admitted for this pull request",
                    details: { reason: "admitted_elsewhere" },
                  },
                },
                409,
              );
            }
            return jsonResponse(
              {
                ok: false,
                error: { code: "internal_error", message: "Failed to start QA verification child session" },
              },
              coordinated.reason === "invalid_pr" ? 400 : 500,
            );
          }
          const capacity = await reserveChildSessionCapacity({ db, childSessionId, plan });
          if (!capacity.ok) {
            reservedChildSessionId = null;
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome(childSessionCreateOutcomeForCode(capacity.error.code), {
              errorCode: capacity.error.code,
            });
            const status = childSessionErrorStatus(capacity.error.code);
            return jsonResponse({ ok: false, error: capacity.error }, status);
          }
          let session: Awaited<ReturnType<typeof createSessionState>>["session"];
          let replay: Awaited<ReturnType<typeof createSessionState>>["replay"];
          try {
            const created = await createSessionState(env, childSessionId, childOwnerUserId, {
              sessionKind: "repo",
              entrypoint: SessionEntrypoint.CHILD_SESSION,
              repoContext: { repoOwner: plan.childRepoOwner, repoName: plan.childRepoName },
              requestId,
              auth: authCtx,
              installationId: plan.installationId,
              model: modelId,
              reasoningEffort: resolvedReasoningEffort,
              agentRuntimeBackend: childAgentRuntimeBackend,
              autoVerify: isQaTesterAgentRole(agentRuntime.agentRole) ? false : undefined,
              agentRole: agentRuntime.agentRole,
              agentProfile: agentRuntime.agentProfile,
              harnessKind: agentRuntime.harnessKind,
              runtimeStartupProfile: agentRuntime.runtimeStartupProfile,
              verificationRuntimeMode: agentRuntime.verificationRuntimeMode,
              targetPrUrl: agentRuntime.targetPrUrl ?? null,
              businessId: plan.parent.business_id,
              runtimeBackend: childRuntimeBackend,
              initiationMode: CHILD_SESSION_INITIATION_MODE,
              waitUntil: waitUntilFromContext(ctx),
            });
            session = created.session;
            replay = created.replay;
          } catch (error) {
            if (error instanceof ProviderCredentialNotValidatedError) {
              await releaseUnprojectedChildSessionCapacity(db, childSessionId);
              reservedChildSessionId = null;
              await releaseIdempotencyClaim();
              emitChildSessionCreateOutcome("forbidden", { errorCode: PROVIDER_KEY_NOT_VALIDATED_ERROR });
              return providerCredentialErrorResponse(error);
            }
            if (error instanceof OpencodeAccessDeniedError) {
              await releaseUnprojectedChildSessionCapacity(db, childSessionId);
              reservedChildSessionId = null;
              await releaseIdempotencyClaim();
              emitChildSessionCreateOutcome("forbidden", { errorCode: OPENCODE_ACCESS_DENIED_ERROR });
              return opencodeAccessDeniedResponse();
            }
            log.error({ parentSessionId, childSessionId, error: String(error) }, "Child session DO initialize failed");
            await releaseUnprojectedChildSessionCapacity(db, childSessionId);
            reservedChildSessionId = null;
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
            return jsonResponse(
              { ok: false, error: { code: "internal_error", message: "Failed to initialize child session" } },
              500,
            );
          }

          try {
            await syncSessionProjection({
              db,
              sessionId: session.sessionId,
              session: {
                ...session,
                sessionKind: "repo",
                title: title ?? session.title,
              },
              replay,
              richStatus: "idle",
              parentContext: plan.parentContext,
              logger: log,
              source: "routes.sessions.create_child",
              requestId,
              userId: routeAuth.userId,
            });
            await syncRuntimeBackendProjection(env, childSessionId, childRuntimeBackend);
            await markChildSessionCapacityProjected(db, childSessionId);
            childSessionProjected = true;
          } catch (error) {
            log.error(
              { parentSessionId, childSessionId, error: String(error) },
              "Child session projection write failed",
            );
            await releaseUnprojectedChildSessionCapacity(db, childSessionId);
            reservedChildSessionId = null;
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
            return jsonResponse(
              { ok: false, error: { code: "internal_error", message: "Failed to persist child session metadata" } },
              500,
            );
          }

          const rollbackProjectedChildSession = async (reason: string, fields: Record<string, unknown> = {}) => {
            // Roll back: archive the child via closeSessionState so the orphan
            // session/sandbox slot doesn't leak. We've already projected an
            // 'idle' row above; closeSessionState + a follow-up projection sync
            // flips it to 'archived' and unblocks the user's concurrency cap.
            try {
              const closed = await closeSessionState(env, childSessionId, requestId, {
                reason,
                metadata: { parentSessionId, parentPromptId },
              });
              if (closed) {
                await syncSessionProjection({
                  db,
                  sessionId: childSessionId,
                  session: closed.session,
                  replay: closed.replay,
                  logger: log,
                  source: "routes.sessions.create_child.rollback",
                  requestId,
                  userId: routeAuth.userId,
                });
              }
            } catch (rollbackError) {
              log.error(
                { parentSessionId, childSessionId, error: String(rollbackError), ...fields },
                "Child session rollback after enqueue failure also failed",
              );
            }
          };

          let enqueueResult: Awaited<ReturnType<typeof enqueueSessionPrompt>>;
          try {
            enqueueResult = await enqueueSessionPrompt(env, childSessionId, prompt, childOwnerUserId, {
              auth: authCtx,
              requestId,
            });
          } catch (error) {
            log.error(
              { parentSessionId, childSessionId, error: String(error) },
              "Child session initial prompt enqueue threw",
            );
            await rollbackProjectedChildSession("child_session_enqueue_threw", { enqueueError: String(error) });
            await releaseIdempotencyClaim();
            return jsonResponse(
              {
                ok: false,
                error: { code: "internal_error", message: "Failed to enqueue initial prompt for child session" },
              },
              500,
            );
          }
          if (!enqueueResult.ok) {
            log.error(
              { parentSessionId, childSessionId, status: enqueueResult.status, error: enqueueResult.error },
              "Child session initial prompt enqueue failed",
            );
            await rollbackProjectedChildSession("child_session_enqueue_failed", {
              enqueueStatus: enqueueResult.status,
              enqueueError: enqueueResult.error,
            });
            await releaseIdempotencyClaim();
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
            return jsonResponse(
              {
                ok: false,
                error: { code: "internal_error", message: "Failed to enqueue initial prompt for child session" },
              },
              500,
            );
          }
          const ep = enqueueResult.payload!;
          initialPromptEnqueued = true;
          if (idempotencyToken) {
            await commitIdempotentRequest(env.DB, idempotencyToken, childSessionId);
            idempotencyToken = null;
          }
          await syncSessionProjection({
            db,
            sessionId: childSessionId,
            session: ep.session,
            replay: ep.replay,
            logger: log,
            source: "routes.sessions.create_child.enqueue",
            requestId,
            userId: routeAuth.userId,
          });
          // Child sessions are projected directly here (not via
          // persistInitialSessionProjection), so publish the new row to the sidebar
          // feed so the child appears live (ARC-1322). After the enqueue
          // projection, the prompt exists, so the row passes the list filter.
          await publishSessionUpsertedFromDb(env, db, childSessionId, "routes.sessions.create_child");
          await broadcastSessionSnapshot(env, parentSessionId, requestId).catch((error: unknown) => {
            log.warn(
              { parentSessionId, childSessionId, error: String(error) },
              "Failed to broadcast parent snapshot after child session creation",
            );
          });

          const childSessionUrl = buildChildSessionUrl(frontendUrl, childSessionId);
          const successTelemetry = (async () => {
            const counts = await getChildSessionLimitTelemetryCounts({
              db,
              parentSessionId,
              parentPromptId,
              spawnedByUserId: plan.parentContext.spawnedByUserId,
            });
            await postChildSessionCreateOutcome("success", {
              perPromptCountAfterCreate: counts.perPrompt,
            });
            childSessionOutcomeEmitted = true;
          })().catch((error) => {
            log.warn({ parentSessionId, childSessionId, error: String(error) }, "Child session telemetry failed");
            emitChildSessionCreateOutcome("success");
          });
          if (ctx) ctx.waitUntil(successTelemetry);
          else void successTelemetry;
          log.info(
            {
              parentSessionId,
              childSessionId,
              parentPromptId,
              spawnedByUserId: plan.parentContext.spawnedByUserId,
              spawnDepth: plan.parentContext.spawnDepth,
              repoOwner: plan.childRepoOwner,
              repoName: plan.childRepoName,
            },
            "child_session.create.ok",
          );
          return jsonResponse(
            {
              ok: true,
              childSessionId,
              childSessionUrl,
              parentSessionId,
              parentPromptId,
              spawnDepth: plan.parentContext.spawnDepth,
            },
            201,
          );
        } catch (error) {
          if (idempotencyToken && initialPromptEnqueued && reservedChildSessionId) {
            await commitIdempotentRequest(env.DB, idempotencyToken, reservedChildSessionId).catch(
              (commitError: unknown) => {
                log.error(
                  { parentSessionId, childSessionId: reservedChildSessionId, error: String(commitError) },
                  "Failed to commit child session idempotency claim after prompt enqueue",
                );
              },
            );
            idempotencyToken = null;
          } else {
            await releaseIdempotencyClaim();
          }
          if (reservedChildSessionId && !childSessionProjected) {
            await releaseUnprojectedChildSessionCapacity(assertDatabase(env), reservedChildSessionId);
          }
          if (!childSessionOutcomeEmitted) {
            emitChildSessionCreateOutcome("upstream_error", { errorCode: "internal_error" });
          }
          throw error;
        }
      });
    },
  },

  // List child sessions for a parent. By default `prUrl` is null on each
  // summary to keep the default child-list response cheap. Callers that need
  // PR links pass `?include=prUrl`; the service projects those links in the
  // same D1 child-list query.
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/child-sessions"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (parentSessionId, _parent, _requestId, _authCtx) => {
        const db = assertDatabase(env);
        const frontendUrl = resolvePublicAppBaseUrl(env);
        const includes = parseChildSessionIncludes(request);
        const summaries = await listChildSessionSummaries(
          db,
          parentSessionId,
          _parent.businessId ?? null,
          frontendUrl,
          { includePrUrl: includes.has("prUrl") },
        );
        return jsonResponse({ ok: true, parentSessionId, children: summaries });
      });
    },
  },

  // Get a single child session's status (with PR URL when present)
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/child-sessions/:childSessionId/status"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (parentSessionId, _parent, requestId, authCtx) => {
        const childSessionId = match.groups!.childSessionId;
        const db = assertDatabase(env);

        // Confirm the child belongs to this parent before exposing its
        // status. Single-row lookup keyed on the child's own session_id; the
        // membership check is the parent_session_id field on that row.
        const childRow = await getChildSessionRow(db, childSessionId);
        if (!childRow || childRow.parent_session_id !== parentSessionId) {
          return jsonResponse(
            { ok: false, error: { code: "not_found", message: "Child session not found for this parent" } },
            404,
          );
        }

        const frontendUrl = resolvePublicAppBaseUrl(env);
        const result = await getChildSessionStatusSummary({
          db,
          childSessionId,
          parentSessionId,
          parentBusinessId: _parent.businessId ?? null,
          frontendUrl,
          fetchPrUrl: async (id) => {
            const view = await getSessionView(env, id, requestId, authCtx);
            if (!view.ok || !view.payload) return null;
            const sess = view.payload.session as { prUrl?: string | null };
            return typeof sess.prUrl === "string" && sess.prUrl ? sess.prUrl : null;
          },
        });
        if (!result.ok) {
          return jsonResponse({ ok: false, error: result.error }, 404);
        }
        return jsonResponse({ ok: true, status: result.summary });
      });
    },
  },

  // Delete session
  {
    method: "DELETE",
    pattern: parsePattern("/api/sessions/:sessionId"),
    auth: "authenticated",
    mcpBusinessScopeEnforced: true,
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      return withSession(request, env, match, routeAuth, async (sessionId, _session, requestId) => {
        const parsedBody = await parseBody<ArchiveSessionBody>(request, ArchiveSessionBodySchema);
        if (!parsedBody.ok) return parsedBody.response;

        const db = assertDatabase(env);
        const dashboardArchive = routeAuth.authMode === "user_session" && routeAuth.tokenSource === "session_token";
        const prClose = parsedBody.value.closePr ? await closeAttachedPrForArchive(env, sessionId, requestId) : null;
        let prCloseResult = prClose?.ok ? prClose.payload?.prClose : undefined;
        if (prClose && !prClose.ok) {
          const warning = prClose.payload?.prClose.warning ?? "Could not close PR before archive";
          prCloseResult = {
            attempted: true,
            closed: false,
            warning,
          };
          log.warn(
            {
              event: "archive_close_pr_internal_failed",
              action: "archive_session",
              sessionId,
              userId: routeAuth.userId,
              requestId,
              status: prClose.status,
              warning,
            },
            "Archive PR close internal route failed",
          );
        }
        const closed = await closeSessionState(
          env,
          sessionId,
          requestId,
          dashboardArchive
            ? { reason: "dashboard_archive", metadata: { closeSource: "dashboard_archive" } }
            : { reason: "api_archive", metadata: { closeSource: "api_archive" } },
        );
        if (closed) {
          await syncSessionProjection({
            db,
            sessionId,
            session: closed.session,
            replay: closed.replay,
            logger: log,
            source: "routes.sessions.close",
            requestId,
            userId: routeAuth.userId,
          });
          // Tell the sidebar feed the session is gone so it drops from active
          // views in other tabs / for teammates (ARC-1322). The helper reads the
          // gate envelope (incl. repo context, which the DO core row lacks) from
          // D1 and swallows failures, so a feed publish can never fail the delete.
          await publishSessionClosedFromDb(env, db, sessionId, "routes.sessions.close");
        }
        return jsonResponse({
          ok: true,
          archived: true,
          ...(prCloseResult ? { prClose: prCloseResult } : {}),
        });
      });
    },
  },
];

async function handleSendPrompt(
  request: Request,
  env: Parameters<RouteHandler>[1],
  match: RegExpMatchArray,
  auth: AuthInfo | null,
): Promise<Response> {
  const routeAuth = requireRouteAuth(auth);
  return withSession(request, env, match, routeAuth, async (sessionId, session, requestId, authCtx) => {
    const payload = (await parseJsonBody(request)) || {};
    const skillsResult = parseSkillsPayload(payload.skills);
    if (!skillsResult.ok) {
      return skillsResult.response;
    }
    const skills = skillsResult.value;
    if (payload.prompt != null && typeof payload.prompt !== "string") {
      return jsonErrorResponse("Prompt must be a string", 400);
    }
    const prompt = asNonEmptyString(payload.prompt) ?? "";
    if (!prompt && !skills?.length) {
      return jsonErrorResponse("Missing prompt", 400);
    }

    const agent = typeof payload.agent === "string" ? payload.agent : undefined;

    if (skills?.length) {
      const repo = getRepoContextFromSession(session as SessionRouteState);
      if (!repo) {
        return jsonErrorResponse("Skills require a repository-backed session", 400);
      }
      let availableSkills: Awaited<ReturnType<typeof fetchRepoSkills>>;
      try {
        availableSkills = await fetchRepoSkills(env, routeAuth.userId, repo.repoOwner, repo.repoName);
      } catch (err) {
        log.warn(
          { sessionId, repoOwner: repo.repoOwner, repoName: repo.repoName, error: String(err) },
          "Skill discovery failed during prompt validation",
        );
        return jsonErrorResponse("Unable to verify repository skills", 503);
      }
      if (availableSkills.length === 0) {
        return jsonErrorResponse("Unable to verify repository skills", 503);
      }
      const availableNames = new Set(availableSkills.map((skill) => skill.name));
      const unknownSkill = skills.find((skill) => !availableNames.has(skill));
      if (unknownSkill) {
        return jsonErrorResponse(`Unknown skill: ${unknownSkill}`, 400);
      }
    }

    const filesResult = parsePromptFilePaths(payload.files);
    if (!filesResult.ok) {
      return filesResult.response;
    }
    const files = filesResult.value;

    const uploadedFilesResult = parseUploadedFilesPayload(payload.uploadedFiles);
    if (!uploadedFilesResult.ok) {
      return uploadedFilesResult.response;
    }
    const uploadedFiles = uploadedFilesResult.value;
    if (uploadedFiles) {
      log.info(
        {
          fileNames: uploadedFiles.map((f) => f.name),
          count: uploadedFiles.length,
          sizes: uploadedFiles.map((f) => new TextEncoder().encode(f.content).byteLength),
        },
        "Uploaded files received",
      );
    }

    const uploadedImagesResult = parseUploadedImagesPayload(payload.uploadedImages);
    if (!uploadedImagesResult.ok) {
      return uploadedImagesResult.response;
    }
    const uploadedImages = uploadedImagesResult.value;
    if (uploadedImages) {
      log.info(
        {
          imageNames: uploadedImages.map((i) => i.name),
          count: uploadedImages.length,
          mediaTypes: uploadedImages.map((i) => i.mediaType),
        },
        "Uploaded images received",
      );
    }

    const effectiveReplyToText =
      typeof payload.replyToText === "string" ? payload.replyToText.trim() || prompt : prompt;
    const uploadSqlPayload = validatePromptUploadSqlPayload({
      promptText: prompt,
      replyToText: effectiveReplyToText,
      uploadedFiles,
      uploadedImages,
    });
    if (!uploadSqlPayload.ok) {
      return jsonErrorResponse(uploadSqlPayload.error, 413);
    }

    const resumableSend = isResumableSendSession(session as SessionRouteState);
    let resumableSendLogContext: ResumableSendLogContext | null = null;
    if (resumableSend) {
      resumableSendLogContext = await getResumableSendLogContext(env, sessionId, requestId, authCtx);
      const validation = await resolveAndRefreshSessionResumeAccess(
        env,
        routeAuth,
        sessionId,
        session as SessionRouteState,
      );
      if (!validation.ok) {
        log.info(
          {
            event: "resumable_send_attempt",
            sessionId,
            promptId: null,
            requestId,
            userId: routeAuth.userId,
            runtimeProvider: resumableSendLogContext.runtimeProvider,
            runtimeState: resumableSendLogContext.runtimeState,
            runtimeStateExpiresAt: resumableSendLogContext.runtimeStateExpiresAt,
            stopReason: resumableSendLogContext.stopReason,
            activePromptIdFromDb: resumableSendLogContext.activePromptIdFromDb,
            decision: "reject-access",
          },
          "resumable_send_attempt",
        );
        return validation.response;
      }
    }

    // Honor a CLI/client Idempotency-Key: a retry on a lost response must not
    // enqueue a second prompt (second agent run / second PR). The key is scoped
    // per session via the route discriminant so the same key on two sessions does
    // not collide. Claim before enqueue, commit with the assigned prompt id once
    // it durably lands, release on enqueue failure. Absent header => untracked.
    const idempotencyKey = readIdempotencyKeyHeader(request);
    let idempotencyToken: IdempotencyToken | null = null;
    if (idempotencyKey) {
      const decision = await beginIdempotentRequest(env.DB, {
        key: idempotencyKey,
        ownerUserId: routeAuth.userId,
        route: `prompt:${sessionId}`,
        requestBody: payload,
      });
      if (decision.kind === "replay") {
        log.info(
          {
            event: "idempotency_key_replayed",
            route: "prompt",
            sessionId,
            ownerUserId: routeAuth.userId,
            resolvedId: decision.resolvedId,
          },
          "idempotency_key_replayed",
        );
        return jsonResponse(
          { ok: true, sessionId, prompt: { promptId: decision.resolvedId }, idempotentReplay: true },
          202,
        );
      }
      if (decision.kind === "reject") {
        log.info(
          {
            event: "idempotency_key_rejected",
            route: "prompt",
            sessionId,
            ownerUserId: routeAuth.userId,
            reason: decision.reason,
          },
          "idempotency_key_rejected",
        );
        return jsonErrorResponse(
          decision.reason === "payload_mismatch"
            ? "Idempotency-Key was already used with a different request payload"
            : "A request with this Idempotency-Key is already in progress; retry shortly",
          decision.status,
        );
      }
      if (decision.kind === "proceed") idempotencyToken = decision.token;
    }

    // enqueueSessionPrompt calls the SessionDO over the network and can throw
    // (timeout, fetch failure). The structured-error branches below release the
    // claim, but a throw bypasses all of them and would leave the key pending
    // forever (no TTL/cleanup), bricking every retry with 409. Release on throw,
    // then re-throw. Post-commit throws are safe: releaseIdempotencyKey only
    // deletes pending rows, so releasing a committed key is a no-op.
    let enqueueResult;
    try {
      enqueueResult = await enqueueSessionPrompt(env, sessionId, prompt, routeAuth.userId, {
        source: "web",
        agent,
        skills,
        auth: authCtx,
        requestId,
        files,
        uploadedFiles,
        uploadedImages,
      });
    } catch (err) {
      if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
      throw err;
    }
    if (enqueueResult.status === 409 && enqueueResult.error === PROMPT_SEND_BLOCKED_ERROR) {
      if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
      return jsonResponse(
        {
          ok: false,
          error: PROMPT_SEND_BLOCKED_ERROR,
          ...(enqueueResult.reason ? { reason: enqueueResult.reason } : {}),
        },
        409,
      );
    }
    const forwardedError = resumableSendErrorResponse(enqueueResult.status, enqueueResult.error);
    if (forwardedError) {
      if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
      if (resumableSend && resumableSendLogContext) {
        log.info(
          {
            event: "resumable_send_attempt",
            sessionId,
            promptId: null,
            requestId,
            userId: routeAuth.userId,
            runtimeProvider: resumableSendLogContext.runtimeProvider,
            runtimeState: resumableSendLogContext.runtimeState,
            runtimeStateExpiresAt: resumableSendLogContext.runtimeStateExpiresAt,
            stopReason: resumableSendLogContext.stopReason,
            activePromptIdFromDb: resumableSendLogContext.activePromptIdFromDb,
            decision: classifyResumableSendErrorDecision(enqueueResult.status, enqueueResult.error),
          },
          "resumable_send_attempt",
        );
      }
      return forwardedError;
    }
    if (!enqueueResult.ok) {
      if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
      throw new Error(`Session DO prompt enqueue failed with status ${enqueueResult.status}`);
    }

    const db = assertDatabase(env);
    const ep = enqueueResult.payload!;
    // Prompt durably enqueued in the SessionDO: commit the claim with the
    // assigned prompt id so a later retry of the same key replays it.
    if (idempotencyToken) await commitIdempotentRequest(env.DB, idempotencyToken, ep.prompt.promptId);
    if (resumableSend && resumableSendLogContext) {
      log.info(
        {
          event: "resumable_send_attempt",
          sessionId,
          promptId: ep.prompt.promptId,
          requestId,
          userId: routeAuth.userId,
          runtimeProvider: resumableSendLogContext.runtimeProvider,
          runtimeState: resumableSendLogContext.runtimeState,
          runtimeStateExpiresAt: resumableSendLogContext.runtimeStateExpiresAt,
          stopReason: resumableSendLogContext.stopReason,
          activePromptIdFromDb: resumableSendLogContext.activePromptIdFromDb,
          decision: classifyResumableSendDecision(resumableSendLogContext),
        },
        "resumable_send_attempt",
      );
    }
    await syncSessionProjection({
      db,
      sessionId,
      session: ep.session,
      replay: ep.replay,
      logger: log,
      source: "routes.sessions.enqueue",
      requestId,
      userId: routeAuth.userId,
    });

    return jsonResponse(
      {
        ok: true,
        sessionId,
        prompt: toPublicEnqueuedPrompt(ep.prompt),
        dispatch: toPublicEnqueueDispatch(ep.dispatch),
        queue: ep.queue,
      },
      202,
    );
  });
}
