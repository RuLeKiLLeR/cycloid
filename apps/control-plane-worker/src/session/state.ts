import {
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import { isReadOnlyAgentRole, ONBOARD_AGENT_NAME } from "../../../../shared/agent/constants.js";
import type {
  AgentRole,
  HarnessKind,
  RuntimeStartupProfile,
  VerificationRuntimeMode,
} from "../../../../shared/agent/schema.js";
import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import {
  extractModelId,
  extractSessionStartModelIdForBackend,
  getAgentRuntimeBackendForModel,
  getDefaultSessionStartModelIdForBackend,
} from "../../../../shared/constants/models.js";
import type { PlanModeSetting } from "../../../../shared/plan-mode.js";
import {
  getRawSessionEventData,
  getRawSessionEventKind,
  getRawSessionEventTimestamp,
} from "../../../../shared/transcript/projector.js";
import type {
  DesktopActionPathSnapshotResponse,
  RegisterDesktopActionPathRowResponse,
} from "../../../../shared/types/desktop-action-path.js";
import type {
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
import type { SessionReplayResponse } from "../../../../shared/types/session-replay.js";
import { getUserBusinessId, getUserDisplayProfile } from "../auth/db";
import { PLAN_APPROVAL_ACTIVATION } from "../constants/plan-approval";
import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../constants/sessions";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import { injectTraceparent } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { assertBusinessCanUseOpencode } from "../services/opencode-access-gate";
import { assessPlanNecessity } from "../services/plan-necessity";
import { assertEffectiveProviderCredentialForModel } from "../services/provider-credential-gate";
import { syncSessionProjection } from "../services/session-projection";
import { resolveEffectiveAutonomySettings } from "../settings/autonomy";
import { getUserSettingsIfExists, type UserSettingsRow } from "../settings/db";
import type { SlackQuotedReplySource } from "../slack/blocks";
import type {
  CallbackContext,
  CallbackPayload,
  EnqueuePayload,
  Env,
  EventsPayload,
  GithubIssueContext,
  InternalAuthContext,
  LinearContext,
  PromptListPayload,
  SessionEvent,
  SessionState,
  SessionViewPayload,
} from "../types";
import { parseNonNegativeInteger } from "../utils";
import { halfJitterBackoffMs } from "../utils/backoff";
import {
  claimSlackThreadSessionRef,
  deleteSlackThreadSessionRefIfSession,
  getSessionIdBySlackThreadRef,
  SESSION_WEBHOOK_REF_SOURCE_SLACK_THREAD,
  SlackThreadAlreadyClaimedError,
  upsertSessionWebhookRef,
} from "../webhooks/db";
import { buildSlackThreadReference } from "../webhooks/prompts";
import { PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM } from "./artifacts";
import { notifyCustomerSessionStarted } from "./customer-session-start-alert";
import { insertGenesisRecord } from "./fsm/genesis";
import type { SessionInternalRouteMap } from "./internal-routes";
import {
  type ApproveSessionPlanRequest,
  type ApproveSessionPlanResponse,
  type ArchiveClosePrResponse,
  type BroadcastSessionSnapshotResponse,
  buildSessionArtifactAuthedViewPath,
  buildSessionArtifactDeletePath,
  buildSessionArtifactReadPath,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type EditSessionPlanResponse,
  type EnqueueSessionPromptRequest,
  type EnterSessionReviewListeningRequest,
  type EnterSessionReviewListeningResponse,
  type GetSessionContextResponse,
  type GetSessionExportResponse,
  type GetSessionInputCompositionResponse,
  type GetSessionPlanResponse,
  type GetSessionSandboxStateResponse,
  type GetSessionUsageResponse,
  type InitializeSessionRequest,
  type InitializeSessionResponse,
  type ListSessionArtifactsResponse,
  type NotifySessionPrClosedResponse,
  type NotifySessionPrMergedResponse,
  type RepoContext,
  type RespondToSessionRequest,
  type RespondToSessionResponse,
  type RevokeSessionArtifactResponse,
  SESSION_INTERNAL_ORIGIN,
  SESSION_INTERNAL_ROUTES,
  type SessionFetchResult,
  type SessionFetchResultWithError,
  type SessionInternalRouteName,
  type SessionInternalRouteRequest,
  type SessionInternalRouteResponse,
  type SessionKind,
  type SetSessionRepoRequest,
  type SetSessionRepoResponse,
  type StopSessionResponse,
  type UpdateSessionCallbackContextResponse,
  type UpdateSessionPrDraftRequest,
  type UpdateSessionPrDraftResponse,
  type UpdateSessionReviewListeningHeadRequest,
  type UpdateSessionReviewListeningHeadResponse,
  type UpdateSessionVerificationResultRequest,
  type UpdateSessionVerificationResultResponse,
  type UpdateSessionVerificationStateRequest,
  type UpdateSessionVerificationStateResponse,
  type ValidatePlatformLlmCapabilityRequest,
  type WarmSessionResponse,
} from "./internal-routes";
import { buildSessionReplaySearchParams, SESSION_REPLAY_MAX_LIMIT } from "./replay-contract";

export type { RepoContext, SessionKind } from "./internal-routes";

export class InvalidSessionIdError extends Error {
  readonly sessionId: unknown;

  constructor(sessionId: unknown) {
    super(INVALID_SESSION_ID_MESSAGE);
    this.name = "InvalidSessionIdError";
    this.sessionId = sessionId;
  }
}

const log = createLogger({ bindings: { component: "session-state" } });
const PLAN_AUTO_REASON_MAX_LENGTH = 240;

function normalizePlanAutoReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const normalized = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length > PLAN_AUTO_REASON_MAX_LENGTH
    ? `${normalized.slice(0, PLAN_AUTO_REASON_MAX_LENGTH - 1).trimEnd()}…`
    : normalized;
}

function resolveAutoVerifyEnabled(explicitAutoVerify: boolean | undefined, settings: UserSettingsRow | null): boolean {
  if (explicitAutoVerify !== undefined) return explicitAutoVerify;

  return resolveEffectiveAutonomySettings(settings).autoVerifyEnabled;
}

function isPlanModeCarveOut(input: {
  agentRole?: AgentRole;
  agentProfile?: string;
  targetPrUrl?: string | null;
  initiationMode?: InitiationMode;
}): boolean {
  return (
    isReadOnlyAgentRole(input.agentRole) ||
    input.agentProfile === ONBOARD_AGENT_NAME ||
    Boolean(input.targetPrUrl?.trim()) ||
    (input.initiationMode ?? InitiationMode.USER) === InitiationMode.CHILD
  );
}

function isInteractivePlanModeEntrypoint(
  entrypoint: SessionEntrypoint | undefined,
): entrypoint is typeof SessionEntrypoint.API | typeof SessionEntrypoint.SLACK {
  return entrypoint === SessionEntrypoint.API || entrypoint === SessionEntrypoint.SLACK;
}

function needsPlanModeSetting(input: {
  explicitPlanMode: PlanModeSetting | undefined;
  entrypoint: SessionEntrypoint | undefined;
  agentRole?: AgentRole;
  agentProfile?: string;
  targetPrUrl?: string | null;
  initiationMode?: InitiationMode;
}): boolean {
  return (
    PLAN_APPROVAL_ACTIVATION &&
    input.explicitPlanMode === undefined &&
    isInteractivePlanModeEntrypoint(input.entrypoint) &&
    !isPlanModeCarveOut(input)
  );
}

async function loadSessionCreationSettings(env: Env, ownerUserId: string): Promise<UserSettingsRow | null> {
  const db = (env as { DB?: D1Database }).DB;
  const numericOwnerUserId = Number(ownerUserId);
  if (!db || !Number.isFinite(numericOwnerUserId)) return null;

  try {
    return await getUserSettingsIfExists(db, numericOwnerUserId);
  } catch (error) {
    log.warn(
      { ownerUserId, error: String(error) },
      "Failed to load session creation settings; defaulting saved preferences off",
    );
    return null;
  }
}

function emitPlanModeAutoDecision(
  env: Env,
  // Bounded, non-content fields only: the classifier's free-form `reason` is
  // prompt-derived and must never reach third-party telemetry (CWE-201).
  fields: {
    sessionId: string;
    entrypoint: SessionEntrypoint;
    planNeeded: boolean | null;
    latencyMs: number;
    nullFallback: boolean;
  },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<unknown> | undefined {
  const post = postStructuredEventToDd(env, {
    event: "arcanist.plan_mode.auto_decision",
    ...fields,
  }).catch((error) => {
    log.warn(
      { event: "arcanist.plan_mode.auto_decision", error: String(error) },
      "plan_mode_auto_decision_metric_failed",
    );
  });
  if (waitUntil) {
    waitUntil(post);
    return undefined;
  }
  // No waitUntil to register with: hand the (never-rejecting) promise to the
  // caller to await, so isolate teardown cannot cancel the in-flight post.
  return post;
}

async function resolvePlanModeEnabled(input: {
  env: Env;
  sessionId: string;
  explicitPlanMode: PlanModeSetting | undefined;
  explicitPlanApprovalRequired?: boolean;
  entrypoint: SessionEntrypoint | undefined;
  settings: UserSettingsRow | null;
  promptText: string | undefined;
  waitUntil?: (promise: Promise<unknown>) => void;
  agentRole?: AgentRole;
  agentProfile?: string;
  targetPrUrl?: string | null;
  initiationMode?: InitiationMode;
}): Promise<{ planMode: boolean; planApprovalRequired: boolean; planAutoReason: string | null }> {
  if (isPlanModeCarveOut(input)) return { planMode: false, planApprovalRequired: false, planAutoReason: null };

  const legacyPlanMode = input.explicitPlanMode !== "off";
  if (!PLAN_APPROVAL_ACTIVATION) {
    return { planMode: legacyPlanMode, planApprovalRequired: false, planAutoReason: null };
  }

  if (!isInteractivePlanModeEntrypoint(input.entrypoint)) {
    return { planMode: false, planApprovalRequired: false, planAutoReason: null };
  }

  const effectiveSettings = resolveEffectiveAutonomySettings(input.settings);
  const requested = input.explicitPlanMode ?? effectiveSettings.planMode;
  if (requested === "on") {
    return {
      planMode: true,
      planApprovalRequired:
        input.explicitPlanApprovalRequired ?? (input.settings ? effectiveSettings.planApprovalRequired : true),
      planAutoReason: "Plan mode is enabled",
    };
  }
  if (requested === "off") return { planMode: false, planApprovalRequired: false, planAutoReason: null };

  const startedAt = Date.now();
  let assessment: Awaited<ReturnType<typeof assessPlanNecessity>> = null;
  if (input.promptText?.trim()) {
    try {
      const telemetryContext = {
        sessionId: input.sessionId,
        phase: "session_create" as const,
      };
      assessment = await assessPlanNecessity(input.env, input.promptText, telemetryContext);
    } catch (error) {
      // assessPlanNecessity catches internally and returns null; this guard is
      // deliberate belt-and-suspenders so a future change to that contract can
      // never let a classifier error break session creation.
      log.warn(
        { sessionId: input.sessionId, error: String(error) },
        "Plan necessity classifier threw unexpectedly; defaulting plan mode off",
      );
    }
  }
  await emitPlanModeAutoDecision(
    input.env,
    {
      sessionId: input.sessionId,
      entrypoint: input.entrypoint,
      planNeeded: assessment?.planNeeded ?? null,
      latencyMs: Date.now() - startedAt,
      nullFallback: assessment === null,
    },
    input.waitUntil,
  );
  const planMode = assessment?.planNeeded === true;
  const planApprovalRequired = planMode
    ? (input.explicitPlanApprovalRequired ?? (input.settings ? effectiveSettings.planApprovalRequired : true))
    : false;
  if (planMode && !planApprovalRequired) {
    const unattendedMetric = postStructuredEventToDd(input.env, {
      event: "arcanist.plan_mode.unattended_execution",
      sessionId: input.sessionId,
      profile: effectiveSettings.profile,
      planMode: true,
      planApprovalRequired: false,
    }).catch((error) => {
      log.warn({ sessionId: input.sessionId, error: String(error) }, "unattended_plan_execution_metric_failed");
    });
    if (input.waitUntil) input.waitUntil(unattendedMetric);
    else await unattendedMetric;
  }
  return {
    planMode,
    planApprovalRequired,
    planAutoReason: planMode ? normalizePlanAutoReason(assessment?.reason) : null,
  };
}

export function getSessionStub(env: Env, sessionId: string): DurableObjectStub {
  const durableObjectId = env.SESSION.idFromName(sessionId);
  return env.SESSION.get(durableObjectId);
}

const DO_RETRY_BASE_BACKOFF_MS = 100;
const DO_RETRY_MAX_BACKOFF_MS = 5_000;

/**
 * Half-jitter backoff: full exponential term, then jitter within
 * [50%, 100%] of it. The previous `base * random * 2^attempt` had no floor --
 * a small random draw collapsed the delay toward zero, letting retries
 * busy-spin against a still-overloaded DO instead of actually backing off.
 */
export function computeDoRetryBackoffMs(
  attempt: number,
  options: { baseBackoffMs?: number; maxBackoffMs?: number; random?: () => number } = {},
): number {
  const baseBackoffMs = options.baseBackoffMs ?? DO_RETRY_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DO_RETRY_MAX_BACKOFF_MS;
  return halfJitterBackoffMs({
    attempt,
    baseMs: baseBackoffMs,
    maxMs: maxBackoffMs,
    random: options.random,
  });
}

/**
 * Retry a DO stub.fetch with exponential backoff and jitter.
 * Creates a fresh stub on each attempt (Cloudflare best practice -- old stubs
 * are broken after transient errors). Never retries overloaded errors.
 * See: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */
export async function withDORetry<T>(
  env: Env,
  sessionId: string,
  fn: (stub: DurableObjectStub) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const stub = getSessionStub(env, sessionId);
      return await fn(stub);
    } catch (err) {
      const e = err as Error & { retryable?: boolean; overloaded?: boolean };
      if (!e.retryable || e.overloaded || attempt >= maxAttempts - 1) throw e;
      const backoffMs = computeDoRetryBackoffMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/** Extract X-Request-ID from an incoming request for DO propagation. */
export function extractRequestId(request: Request): string | null {
  return request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID);
}

function buildInternalHeaders(
  contentType?: string,
  requestId?: string | null,
  sessionId?: string | null,
  auth?: InternalAuthContext,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers[HTTP_HEADER_NAMES.CONTENT_TYPE] = contentType;
  if (requestId) headers[HTTP_HEADER_NAMES.REQUEST_ID] = requestId;
  if (sessionId) headers["x-session-id"] = sessionId;
  // Propagate trace context to DO
  const traceparent = injectTraceparent();
  if (traceparent) headers["traceparent"] = traceparent;
  if (auth) {
    headers["x-auth-user-id"] = auth.userId;
    headers["x-auth-can-access-all"] = String(auth.canAccessAllSessions);
    if (auth.businessId) {
      headers["x-auth-business-id"] = auth.businessId;
    }
    if (auth.sharedSessions !== undefined) {
      headers["x-auth-shared-sessions"] = String(auth.sharedSessions);
    }
    if (auth.businessMemberIds?.length) {
      headers["x-auth-business-member-ids"] = JSON.stringify(auth.businessMemberIds);
    }
    if (auth.repoAccessVerifiedSessionId) {
      headers["x-auth-repo-access-session-id"] = auth.repoAccessVerifiedSessionId;
    }
    if (auth.repoAccessVerifiedRepoOwner) {
      headers["x-auth-repo-access-repo-owner"] = auth.repoAccessVerifiedRepoOwner;
    }
    if (auth.repoAccessVerifiedRepoName) {
      headers["x-auth-repo-access-repo-name"] = auth.repoAccessVerifiedRepoName;
    }
    if (auth.email) {
      headers["x-auth-user-email"] = auth.email;
    }
    if (auth.username) {
      headers["x-auth-user-username"] = auth.username;
    }
    if (auth.impersonationId) {
      headers["x-auth-impersonation-id"] = auth.impersonationId;
    }
    if (auth.readOnly || auth.impersonationId) {
      headers["x-auth-read-only"] = "true";
    }
  }
  return headers;
}

function sandboxAuthForwardHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: request.headers.get("authorization") || "",
    "x-sandbox-client-ip": request.headers.get("CF-Connecting-IP")?.trim() || "unknown",
  };
  for (const key of ["User-Agent"]) {
    const value = request.headers.get(key);
    if (value) headers[key] = value;
  }
  return headers;
}

function buildSessionInternalUrl(path: string, searchParams?: URLSearchParams): string {
  const url = new URL(path, SESSION_INTERNAL_ORIGIN);
  if (searchParams) url.search = searchParams.toString();
  return url.toString();
}

function mergeHeaders(baseHeaders: Record<string, string>, extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(baseHeaders);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function buildSessionRouteRequest<RouteName extends SessionInternalRouteName>(
  routeName: RouteName,
  options?: {
    searchParams?: URLSearchParams;
    headers?: HeadersInit;
    body?: BodyInit;
  },
): Request {
  const route = SESSION_INTERNAL_ROUTES[routeName];
  return new Request(buildSessionInternalUrl(route.path, options?.searchParams), {
    method: route.method,
    headers: options?.headers,
    ...(options?.body !== undefined ? { body: options.body } : {}),
  });
}

async function fetchSessionRawByPath(
  env: Env,
  sessionId: string,
  path: string,
  options: {
    method: string;
    contentType?: string;
    requestId?: string | null;
    auth?: InternalAuthContext;
    headers?: HeadersInit;
    body?: BodyInit;
    searchParams?: URLSearchParams;
    includeInternalHeaders?: boolean;
    retryDurableObjectFetch?: boolean;
    // Required by the Workers/fetch spec when `body` is a ReadableStream: a
    // streamed request body must be sent half-duplex. stub.fetch (DO RPC over
    // fetch) honors this and forwards the stream to the DO without buffering.
    duplex?: "half";
  },
): Promise<Response> {
  const {
    method,
    contentType,
    requestId,
    auth,
    headers,
    body,
    searchParams,
    includeInternalHeaders = true,
    retryDurableObjectFetch = false,
    duplex,
  } = options;
  const requestHeaders = includeInternalHeaders
    ? mergeHeaders(buildInternalHeaders(contentType, requestId, sessionId, auth), headers)
    : new Headers(headers);
  const url = buildSessionInternalUrl(path, searchParams);
  const init = {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body } : {}),
    ...(duplex !== undefined ? { duplex } : {}),
  } as RequestInit;
  if (retryDurableObjectFetch) {
    return withDORetry(env, sessionId, (stub) => stub.fetch(url, init));
  }
  const stub = getSessionStub(env, sessionId);
  return stub.fetch(url, init);
}

function encodeJsonBody<RouteName extends SessionInternalRouteName>(
  body: SessionInternalRouteRequest<RouteName> | undefined,
): BodyInit | undefined {
  return body === undefined ? undefined : JSON.stringify(body);
}

async function fetchSessionRouteResponse<RouteName extends SessionInternalRouteName>(
  env: Env,
  sessionId: string,
  routeName: RouteName,
  options?: {
    requestId?: string | null;
    auth?: InternalAuthContext;
    body?: SessionInternalRouteRequest<RouteName>;
    searchParams?: URLSearchParams;
    retryDurableObjectFetch?: boolean;
  },
): Promise<Response> {
  const route = SESSION_INTERNAL_ROUTES[routeName];
  const body = encodeJsonBody<RouteName>(options?.body);
  return fetchSessionRawByPath(env, sessionId, route.path, {
    method: route.method,
    contentType: body === undefined ? undefined : "application/json",
    requestId: options?.requestId,
    auth: options?.auth,
    searchParams: options?.searchParams,
    retryDurableObjectFetch: options?.retryDurableObjectFetch,
    ...(body !== undefined ? { body } : {}),
  });
}

type SessionRouteRequestOptions<RouteName extends SessionInternalRouteName> = {
  requestId?: string | null;
  auth?: InternalAuthContext;
  body?: SessionInternalRouteRequest<RouteName>;
  searchParams?: URLSearchParams;
};

async function bufferedBodyInit(request: Request): Promise<{ body?: BodyInit }> {
  if (!request.body) return {};
  return { body: await request.arrayBuffer() };
}

// Streaming variant used ONLY by the rollout upload: forward the request body
// (a ReadableStream, up to 100MB) straight to the DO instead of buffering it in
// worker memory. A streamed fetch body requires duplex:"half" (set by the
// caller). Returns no body for the empty-body case so the DO sees an empty
// upload and returns 400, matching the buffered behavior.
function streamedBodyInit(request: Request): { body?: BodyInit; duplex?: "half" } {
  if (!request.body) return {};
  return { body: request.body, duplex: "half" };
}

async function parseJsonOrNull<T>(response: Response, context: string): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[session-state] Failed to parse JSON response", {
      context,
      status: response.status,
      error: String(error),
    });
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidJsonError(context: string, status: number): string {
  return `Invalid or empty JSON response from ${context} (status ${status})`;
}

async function fetchSessionRouteResult<RouteName extends SessionInternalRouteName>(
  env: Env,
  sessionId: string,
  routeName: RouteName,
  options?: SessionRouteRequestOptions<RouteName>,
): Promise<SessionFetchResult<SessionInternalRouteResponse<RouteName>>>;

async function fetchSessionRouteResult<RouteName extends SessionInternalRouteName>(
  env: Env,
  sessionId: string,
  routeName: RouteName,
  options: SessionRouteRequestOptions<RouteName> & { parseStructuredError: true },
): Promise<SessionFetchResultWithError<SessionInternalRouteResponse<RouteName>>>;

async function fetchSessionRouteResult<RouteName extends SessionInternalRouteName>(
  env: Env,
  sessionId: string,
  routeName: RouteName,
  options?: SessionRouteRequestOptions<RouteName> & { parseStructuredError?: boolean },
): Promise<
  | SessionFetchResult<SessionInternalRouteResponse<RouteName>>
  | SessionFetchResultWithError<SessionInternalRouteResponse<RouteName>>
> {
  const response = await fetchSessionRouteResponse(env, sessionId, routeName, options);
  if (options?.parseStructuredError !== true) {
    return {
      status: response.status,
      ok: response.ok,
      payload: response.ok ? ((await response.json()) as SessionInternalRouteResponse<RouteName>) : null,
    };
  }

  const route = SESSION_INTERNAL_ROUTES[routeName];
  const context = `SessionDO ${route.method} ${buildSessionInternalUrl(route.path, options.searchParams)}`;
  const payload = await parseJsonOrNull<SessionInternalRouteResponse<RouteName> | { error?: string; reason?: string }>(
    response,
    context,
  );
  if (!isJsonObject(payload)) {
    return {
      status: response.status,
      ok: false,
      payload: null,
      error: invalidJsonError(context, response.status),
    };
  }
  const error =
    !response.ok && payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : null;
  const reason =
    !response.ok && payload && typeof payload === "object" && "reason" in payload && typeof payload.reason === "string"
      ? payload.reason
      : null;
  const errorDetails =
    !response.ok &&
    payload &&
    typeof payload === "object" &&
    "errorDetails" in payload &&
    payload.errorDetails &&
    typeof payload.errorDetails === "object"
      ? (payload.errorDetails as Record<string, unknown>)
      : null;
  return {
    status: response.status,
    ok: response.ok,
    payload: response.ok ? (payload as SessionInternalRouteResponse<RouteName>) : null,
    error,
    reason,
    errorDetails,
  };
}

export function assertDatabase(env: Env): D1Database {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }
  return env.DB;
}

export async function getSessionState(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  auth?: InternalAuthContext,
): Promise<SessionState | null> {
  const response = await fetchSessionRouteResponse(env, sessionId, "state", { requestId, auth });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session DO lookup failed with status ${response.status}`);

  const payload = (await response.json()) as { session: SessionState };
  return payload.session;
}

export async function broadcastSessionSnapshot(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<BroadcastSessionSnapshotResponse | null> {
  const response = await fetchSessionRouteResponse(env, sessionId, "broadcastSnapshot", { requestId });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session DO snapshot broadcast failed with status ${response.status}`);
  return (await response.json()) as BroadcastSessionSnapshotResponse;
}

interface CreateSessionOptions {
  sessionKind?: SessionKind;
  repoContext?: RepoContext;
  agentOverrides?: Record<string, Record<string, unknown>>;
  requestId?: string | null;
  auth?: InternalAuthContext;
  callbackContext?: CallbackContext;
  linearContext?: LinearContext;
  githubIssueContext?: GithubIssueContext;
  agentRole?: AgentRole;
  agentProfile?: string;
  harnessKind?: HarnessKind;
  runtimeStartupProfile?: RuntimeStartupProfile;
  verificationRuntimeMode?: VerificationRuntimeMode;
  targetPrUrl?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  autoVerify?: boolean;
  planMode?: PlanModeSetting;
  planApprovalRequired?: boolean;
  /** Initial prompt text, used only to resolve plan mode "auto"; not persisted here. */
  promptText?: string;
  adoptedExternalPr?: boolean;
  installationId?: number;
  model?: string | null;
  reasoningEffort?: string | null;
  useOpenAIFlexServiceTier?: boolean;
  agentRuntimeBackend?: AgentRuntimeBackend;
  businessId?: string | null;
  runtimePreviewContract?: PreviewContract;
  runtimePreviewSource?: AppRuntimeProfileSource;
  runtimePreviewDiagnostics?: AppRuntimeProfileDiagnostic[];
  runtimeBackend?: SandboxRuntimeBackend;
  initiationMode?: InitiationMode;
  /** Which surface created the session; rendered in the session-start Slack alert. */
  entrypoint: SessionEntrypoint;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  credentialGate?: { mode: "enforce" } | { mode: "skip"; reason: string };
  waitUntil?: (promise: Promise<unknown>) => void;
}

type CreateSessionResult = Omit<InitializeSessionResponse, "ok">;

export async function createSessionState(
  env: Env,
  sessionId: string,
  ownerUserId: string,
  options: CreateSessionOptions,
): Promise<CreateSessionResult> {
  if (!isValidSessionId(sessionId)) {
    throw new InvalidSessionIdError(sessionId);
  }
  const {
    sessionKind,
    repoContext,
    agentOverrides,
    requestId,
    auth,
    callbackContext,
    linearContext,
    githubIssueContext,
    agentRole,
    agentProfile,
    harnessKind,
    runtimeStartupProfile,
    verificationRuntimeMode,
    targetPrUrl,
    prUrl,
    prNumber,
    autoVerify,
    planMode,
    planApprovalRequired,
    promptText,
    adoptedExternalPr,
    installationId,
    model,
    reasoningEffort,
    useOpenAIFlexServiceTier,
    agentRuntimeBackend,
    businessId: providedBusinessId,
    runtimePreviewContract,
    runtimePreviewSource,
    runtimePreviewDiagnostics,
    runtimeBackend,
    initiationMode,
    entrypoint,
    scheduledRuleId,
    ruleNameSnapshot,
    cronSnapshot,
    credentialGate,
    waitUntil,
  } = options;
  let businessId: string;
  if (providedBusinessId !== undefined && providedBusinessId !== null) {
    if (!providedBusinessId.trim()) {
      throw new Error(`Cannot create session without business ownership for user ${ownerUserId}`);
    }
    businessId = providedBusinessId;
  } else {
    const ownerUserIdNumber = Number(ownerUserId);
    if (!Number.isFinite(ownerUserIdNumber)) {
      throw new Error(`Cannot resolve business ownership for non-numeric owner user ${ownerUserId}`);
    }
    businessId = await getUserBusinessId(assertDatabase(env), ownerUserIdNumber);
  }
  // Model selection is scoped to the session's agent runtime backend. When no
  // backend is given, derive it from the model (a Claude model implies
  // claude_code) so non-route callers (Slack, Linear, schedules) get parity;
  // unknown models keep the codex default. The route validates this too;
  // re-validate here fail-closed since createSessionState is also reachable
  // from non-route callers.
  const requestedModelId = extractModelId(model);
  const modelBackend: AgentRuntimeBackend =
    agentRuntimeBackend ??
    (requestedModelId !== undefined ? getAgentRuntimeBackendForModel(requestedModelId) : undefined) ??
    CODEX_AGENT_RUNTIME_BACKEND;
  const sessionStartModelId = extractSessionStartModelIdForBackend(model, modelBackend);
  if (requestedModelId !== undefined && !sessionStartModelId) {
    throw new Error(`Invalid session start model for ${modelBackend}: ${requestedModelId}`);
  }
  const effectiveModelId = sessionStartModelId ?? getDefaultSessionStartModelIdForBackend(modelBackend);
  await assertBusinessCanUseOpencode(env, {
    agentRuntimeBackend: modelBackend,
    businessId,
    sessionId,
    ownerUserId,
    entrypoint: entrypoint ?? null,
  });
  await assertEffectiveProviderCredentialForModel(env, {
    ownerUserId,
    businessId,
    modelId: effectiveModelId,
    sessionId,
    credentialGate,
  });
  const planModeResolutionInput = {
    env,
    sessionId,
    businessId,
    explicitPlanMode: planMode,
    explicitPlanApprovalRequired: planApprovalRequired,
    entrypoint,
    promptText,
    waitUntil,
    agentRole,
    agentProfile,
    targetPrUrl,
    initiationMode,
  };
  const settings =
    autoVerify === undefined || needsPlanModeSetting(planModeResolutionInput)
      ? await loadSessionCreationSettings(env, ownerUserId)
      : null;
  const effectiveAutoVerify = resolveAutoVerifyEnabled(autoVerify, settings);
  const effectivePlanMode = await resolvePlanModeEnabled({ ...planModeResolutionInput, settings });
  // Invariant chokepoint: a Slack thread is bound to at most one session. Every
  // session-creation path funnels through createSessionState, so claiming the
  // thread here (fail-closed) makes it structurally impossible to create a
  // second session on a thread another session already owns - no caller can
  // forget to claim. The claim is idempotent on retries with the same sessionId
  // (e.g. the Slack mention path that pre-claims, or a DO initialize retry).
  let releaseThreadClaimOnFailure: (() => Promise<void>) | undefined;
  if (
    callbackContext?.source === "slack" &&
    callbackContext.slackTeamId &&
    callbackContext.channel &&
    callbackContext.threadTs
  ) {
    const db = assertDatabase(env);
    const { slackTeamId, channel, threadTs } = callbackContext;
    // A release runs while unwinding a primary failure, so it must never throw:
    // a thrown release would mask the original error (the caller would see a DB
    // error instead of the DO failure). Swallow and log; a failed delete leaves
    // an orphaned claim, which the log surfaces for cleanup.
    const releaseClaim = async () => {
      try {
        await deleteSlackThreadSessionRefIfSession(db, businessId, slackTeamId, channel, threadTs, sessionId);
      } catch (releaseErr) {
        log.error(
          { sessionId, channel, threadTs, error: String(releaseErr) },
          "Failed to release slack thread claim after session init failure; thread claim may be orphaned",
        );
      }
    };
    let claimedHere = await claimSlackThreadSessionRef(db, businessId, slackTeamId, channel, threadTs, sessionId);
    if (!claimedHere) {
      const owner = await getSessionIdBySlackThreadRef(db, businessId, slackTeamId, channel, threadTs);
      if (owner === sessionId) {
        // This session already owns the thread (e.g. the Slack mention path that
        // pre-claims, or a DO initialize retry); proceed without re-claiming. The
        // pre-claiming caller owns the release, so we do not set one here.
      } else if (owner) {
        throw new SlackThreadAlreadyClaimedError(owner, channel, threadTs);
      } else {
        // The prior claimant released the row between our INSERT and this lookup,
        // so the thread is free again. Re-attempt the claim so we never proceed
        // unclaimed - leaving it unclaimed would let another session double-claim
        // the same thread.
        claimedHere = await claimSlackThreadSessionRef(db, businessId, slackTeamId, channel, threadTs, sessionId);
        if (!claimedHere) {
          const reOwner = await getSessionIdBySlackThreadRef(db, businessId, slackTeamId, channel, threadTs);
          if (reOwner && reOwner !== sessionId) {
            throw new SlackThreadAlreadyClaimedError(reOwner, channel, threadTs);
          }
        }
      }
    }
    if (claimedHere) {
      releaseThreadClaimOnFailure = releaseClaim;
    }
  }
  const slackThreadWebhookRef =
    callbackContext?.source === "slack"
      ? buildSlackThreadReference(callbackContext.channel, callbackContext.threadTs)
      : null;
  const body = {
    sessionId,
    ownerUserId,
    businessId,
    ...repoContext,
    agentOverrides,
    callbackContext,
    installationId,
    model: effectiveModelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(useOpenAIFlexServiceTier === true ? { useOpenAIFlexServiceTier: true } : {}),
    agentRuntimeBackend: modelBackend,
    ...(linearContext ? { linearContext } : {}),
    ...(githubIssueContext ? { githubIssueContext } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(agentProfile ? { agentProfile } : {}),
    ...(harnessKind ? { harnessKind } : {}),
    ...(runtimeStartupProfile ? { runtimeStartupProfile } : {}),
    ...(verificationRuntimeMode ? { verificationRuntimeMode } : {}),
    ...(targetPrUrl !== undefined ? { targetPrUrl } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(effectiveAutoVerify === false ? { autoVerify: false } : {}),
    planMode: effectivePlanMode.planMode,
    planApprovalRequired: effectivePlanMode.planApprovalRequired,
    ...(effectivePlanMode.planAutoReason ? { planAutoReason: effectivePlanMode.planAutoReason } : {}),
    adoptedExternalPr: adoptedExternalPr === true,
    ...(runtimePreviewContract ? { runtimePreviewContract } : {}),
    ...(runtimePreviewSource ? { runtimePreviewSource } : {}),
    ...(runtimePreviewDiagnostics ? { runtimePreviewDiagnostics } : {}),
    ...(runtimeBackend ? { runtimeBackend } : {}),
    ...(initiationMode ? { initiationMode } : {}),
    entrypoint,
    ...(scheduledRuleId !== undefined ? { scheduledRuleId } : {}),
    ...(ruleNameSnapshot !== undefined ? { ruleNameSnapshot } : {}),
    ...(cronSnapshot !== undefined ? { cronSnapshot } : {}),
    // TEMP benchmark-session deprecation: keep forwarding legacy fields during
    // the stack, then restore stricter shape checking after readers are gone.
  } as InitializeSessionRequest;
  const sessionRequestedEvent = {
    event: "session.requested",
    session_id: sessionId,
    agent_runtime_backend: modelBackend,
    model: effectiveModelId,
    ...(repoContext?.repoOwner && repoContext.repoName
      ? { repo: `${repoContext.repoOwner}/${repoContext.repoName}` }
      : {}),
    outcome: "requested",
  };
  log.info(sessionRequestedEvent, "Startup timeline: session.requested");
  const sessionRequestedPost = postStructuredEventToDd(env, sessionRequestedEvent);
  if (waitUntil) {
    waitUntil(sessionRequestedPost);
  } else {
    void sessionRequestedPost;
  }
  // Emit ONE canonical, entrypoint-agnostic failure event for a session-start DO
  // initialize failure. createSessionState is the chokepoint every creation
  // surface funnels through, so a single event here covers Slack/API/UI/CLI/Linear
  // without forking a per-caller signal. Distinct from `e2e_session_start`
  // telemetry. Drives the "[Sessions] Session-start DO initialize failures" alert.
  //
  // Emit via BOTH the structured logger (local/tail visibility) AND a direct POST
  // to Datadog: control-plane `createLogger` output is NOT shipped to Datadog Logs,
  // so the monitor - which queries `@event:session_start.do_initialize_failed` -
  // only sees the direct-posted copy (mirrors `session_admission_rejected`).
  const logSessionStartFailure = async (reason: string, error: unknown): Promise<void> => {
    const fields = {
      event: "session_start.do_initialize_failed",
      sessionId,
      ownerUserId,
      businessId,
      entrypoint,
      reason,
      error: String(error),
    };
    log.error(fields, "Session DO initialize failed");
    // Never throws (returns false on a rejected POST); observability-only.
    await postStructuredEventToDd(env, fields);
  };

  let response: Awaited<ReturnType<typeof fetchSessionRouteResponse>>;
  try {
    // The DO `/session/initialize` handler is create-if-absent (returns the
    // existing session for a same-sessionId retry), so a transient Cloudflare DO
    // storage fault is safe to retry here. `retryDurableObjectFetch` opts into the
    // shared `withDORetry` bounded retry (fresh stub per attempt, never retries
    // overloaded), so a regional DO wobble is absorbed instead of surfacing as a
    // bare session-start failure. When the retry is exhausted the throw still
    // reaches the catch below, which emits the canonical failure event.
    response = await fetchSessionRouteResponse(env, sessionId, "initialize", {
      requestId,
      auth,
      body,
      retryDurableObjectFetch: true,
    });
  } catch (err) {
    // The session never persisted; release any thread claim made above so the
    // thread does not stay bound to a non-existent session.
    // Distinguish an exhausted DO retry (a `retryable` fault that withDORetry gave
    // up on) from a first-attempt non-retryable throw, so `@reason` alone splits
    // "platform retry exhausted" from other failures during incident triage.
    const reason = (err as { retryable?: unknown }).retryable === true ? "retry_exhausted" : "threw";
    await logSessionStartFailure(reason, err);
    await releaseThreadClaimOnFailure?.();
    throw err;
  }

  if (!response.ok) {
    await logSessionStartFailure(
      `status_${response.status}`,
      `Session DO initialize failed with status ${response.status}`,
    );
    await releaseThreadClaimOnFailure?.();
    throw new Error(`Session DO initialize failed with status ${response.status}`);
  }
  if (slackThreadWebhookRef) {
    try {
      await upsertSessionWebhookRef(
        assertDatabase(env),
        SESSION_WEBHOOK_REF_SOURCE_SLACK_THREAD,
        slackThreadWebhookRef,
        sessionId,
      );
    } catch (webhookRefErr) {
      // The Durable Object is already initialized; a transient projection
      // failure must not report session creation as failed or strand the claim.
      log.warn(
        { sessionId, slackThreadWebhookRef, error: String(webhookRefErr) },
        "Slack thread webhook ref write failed (ignored)",
      );
    }
  }
  // ARC-1330 (PR 35) row genesis: the session persisted, so stamp its `CREATED` `pr_coordination` row
  // (the spine row every later producer reads/CASes). BEST-EFFORT/try-caught OFF the legacy critical
  // path, so a genesis fault never fails session creation. Idempotent (the helper SELECT-guards) for a
  // same-`sessionId` initialize retry.
  try {
    await insertGenesisRecord({ db: assertDatabase(env), now: Date.now }, sessionId);
  } catch (genesisErr) {
    log.warn({ sessionId, error: String(genesisErr) }, "fsm genesis insert failed (ignored)");
  }
  const payload = (await response.json()) as InitializeSessionResponse;
  let ownerUserLogin: string | null = null;
  try {
    ownerUserLogin = (await getUserDisplayProfile(assertDatabase(env), ownerUserId))?.login ?? null;
  } catch (error) {
    // Login resolution is best-effort; a DB hiccup must degrade to the numeric
    // id in the alert, not suppress the alert entirely.
    log.warn({ sessionId, ownerUserId, error: String(error) }, "Owner login resolution for session start alert failed");
  }
  try {
    await notifyCustomerSessionStarted(env, {
      sessionId,
      ownerUserId,
      ownerUserLogin,
      businessId,
      repoOwner: repoContext?.repoOwner ?? null,
      repoName: repoContext?.repoName ?? null,
      entrypoint,
      agentRole: agentRole ?? null,
    });
  } catch (error) {
    log.warn({ sessionId, ownerUserId, businessId, error: String(error) }, "Customer session start alert failed");
  }
  return {
    ...payload,
    session: {
      ...payload.session,
      ...(repoContext
        ? {
            repoOwner: repoContext.repoOwner,
            repoName: repoContext.repoName,
          }
        : {}),
      ...(installationId !== undefined ? { installationId } : {}),
      ...(callbackContext !== undefined ? { callbackContext } : {}),
    },
  };
}

type CloseSessionResult = Omit<CloseSessionResponse, "ok">;
type SessionCloseOptions = CloseSessionRequest;

export async function closeSessionState(
  env: Env,
  sessionId: string,
  requestId: string | null | undefined,
  options: SessionCloseOptions,
): Promise<CloseSessionResult | null> {
  const response = await fetchSessionRouteResponse(env, sessionId, "close", {
    requestId,
    body: options,
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session DO close failed with status ${response.status}`);

  const payload = (await response.json()) as CloseSessionResponse;
  // ARC-1330 W11 D-51: the per-PR verification lock (ARC-1173) is removed, so a verifier
  // terminating without reaching `verification-done` no longer needs a lock release here —
  // the FSM-native spawn idempotency anchor (W11-V4) is the single-verifier boundary and the
  // VERIFYING dwell deadline (#6373) is the crash backstop.
  return { session: payload.session, replay: payload.replay };
}

function buildEnqueueSessionPromptRequest(
  prompt: string,
  actorUserId: string,
  options?: {
    source?: "web" | "slack";
    agent?: string;
    skills?: string[];
    replyToText?: string;
    replyToQuoteSource?: SlackQuotedReplySource | null;
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reviewLoopEpochId?: string;
    reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
    verificationRunId?: number;
    verificationCoordinatorSessionId?: string | null;
  },
): EnqueueSessionPromptRequest {
  const {
    source,
    agent,
    skills,
    replyToText,
    replyToQuoteSource,
    files,
    uploadedFiles,
    uploadedImages,
    reviewLoopEpochId,
    reviewLoopSourceKind,
    verificationRunId,
    verificationCoordinatorSessionId,
  } = options ?? {};
  return {
    prompt,
    ...(source ? { source } : {}),
    replyToText: replyToText ?? prompt,
    ...(replyToQuoteSource ? { replyToQuoteSource } : {}),
    actorUserId,
    agent,
    ...(skills?.length ? { skills } : {}),
    ...(files?.length ? { files } : {}),
    ...(uploadedFiles?.length ? { uploadedFiles } : {}),
    ...(uploadedImages?.length ? { uploadedImages } : {}),
    ...(reviewLoopEpochId ? { reviewLoopEpochId } : {}),
    ...(reviewLoopSourceKind ? { reviewLoopSourceKind } : {}),
    // ARC-1330 §17-A: the verifier run token rides the enqueue (0 is a valid backfilled run id).
    ...(verificationRunId !== undefined ? { verificationRunId } : {}),
    ...(verificationCoordinatorSessionId ? { verificationCoordinatorSessionId } : {}),
  };
}

export async function enqueueSessionPrompt(
  env: Env,
  sessionId: string,
  prompt: string,
  actorUserId: string,
  options?: {
    source?: "web" | "slack";
    agent?: string;
    skills?: string[];
    replyToText?: string;
    replyToQuoteSource?: SlackQuotedReplySource | null;
    requestId?: string | null;
    auth?: InternalAuthContext;
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reviewLoopEpochId?: string;
    reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
    /** ARC-1330 §17-A (PR 47): the verifier run token — see `EnqueueSessionPromptRequest.verificationRunId`. */
    verificationRunId?: number;
    verificationCoordinatorSessionId?: string | null;
  },
): Promise<SessionFetchResultWithError<EnqueuePayload>> {
  const {
    source,
    agent,
    skills,
    replyToText,
    replyToQuoteSource,
    requestId,
    auth,
    files,
    uploadedFiles,
    uploadedImages,
    reviewLoopEpochId,
    reviewLoopSourceKind,
    verificationRunId,
    verificationCoordinatorSessionId,
  } = options ?? {};
  return fetchSessionRouteResult(env, sessionId, "promptsEnqueue", {
    requestId,
    auth,
    body: buildEnqueueSessionPromptRequest(prompt, actorUserId, {
      source,
      agent,
      skills,
      replyToText,
      replyToQuoteSource,
      files,
      uploadedFiles,
      uploadedImages,
      reviewLoopEpochId,
      reviewLoopSourceKind,
      verificationRunId,
      verificationCoordinatorSessionId,
    }),
    parseStructuredError: true,
  });
}

export async function listSessionPrompts(
  env: Env,
  sessionId: string,
  options?: {
    requestId?: string | null;
    auth?: InternalAuthContext;
  },
): Promise<SessionFetchResult<PromptListPayload>> {
  return fetchSessionRouteResult(env, sessionId, "prompts", {
    requestId: options?.requestId,
    auth: options?.auth,
  });
}

export async function getSessionView(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  auth?: InternalAuthContext,
  options?: { promptCursor?: string; promptLimit?: number },
): Promise<SessionFetchResult<SessionViewPayload>> {
  const searchParams = new URLSearchParams();
  if (options?.promptCursor) searchParams.set("promptCursor", options.promptCursor);
  if (options?.promptLimit !== undefined) searchParams.set("promptLimit", String(options.promptLimit));
  return fetchSessionRouteResult(env, sessionId, "view", {
    requestId,
    auth,
    ...(searchParams.size > 0 ? { searchParams } : {}),
  });
}

export async function getSessionPlan(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
): Promise<SessionFetchResult<GetSessionPlanResponse>> {
  return fetchSessionRouteResult(env, sessionId, "plan", { requestId, auth });
}

/**
 * Best-effort plan read for a trusted server-side surface (e.g. rendering the
 * plan into a Slack notice already addressed to an authorized recipient).
 * Sent WITHOUT auth headers: the DO's plan route skips its access check when no
 * auth is present, mirroring {@link getSessionState}. Never throws - any DO/
 * transport failure resolves to `null` so the caller falls back to link-only.
 */
export async function getSessionPlanMarkdown(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<GetSessionPlanResponse | null> {
  try {
    const result = await fetchSessionRouteResult(env, sessionId, "plan", { requestId });
    return result.ok && result.payload ? result.payload : null;
  } catch {
    return null;
  }
}

export async function editSessionPlan(
  env: Env,
  sessionId: string,
  input: { revision: number; markdown: string; actorUserId: string },
  requestId: string | null,
  auth: InternalAuthContext,
): Promise<SessionFetchResultWithError<EditSessionPlanResponse>> {
  return fetchSessionRouteResult(env, sessionId, "planEdit", {
    requestId,
    auth,
    body: {
      revision: input.revision,
      markdown: input.markdown,
      actorUserId: input.actorUserId,
      source: "web",
    },
    parseStructuredError: true,
  });
}

export async function completeSessionPrompt(
  env: Env,
  sessionId: string,
  promptId: string,
  callbackPayload: Record<string, unknown>,
  requestId?: string | null,
): Promise<{ status: number; ok: boolean; payload: CallbackPayload | null }> {
  const response = await fetchSessionRouteResponse(env, sessionId, "promptsCallback", {
    requestId,
    body: {
      promptId,
      success: callbackPayload?.success,
      result: callbackPayload?.result ?? null,
      error: callbackPayload?.error ?? null,
    },
  });

  return {
    status: response.status,
    ok: response.ok,
    payload: response.ok ? ((await response.json()) as CallbackPayload) : null,
  };
}
export async function listSessionEventsAuthed(
  env: Env,
  sessionId: string,
  afterSequence: number,
  limit: number,
  auth: InternalAuthContext,
  requestId?: string | null,
): Promise<SessionFetchResult<EventsPayload>> {
  const params = new URLSearchParams();
  params.set("afterSequence", String(afterSequence));
  params.set("limit", String(limit));
  return fetchSessionRouteResult(env, sessionId, "events", {
    requestId,
    auth,
    searchParams: params,
  });
}

export async function openSessionWebSocket(
  env: Env,
  sessionId: string,
  request: Request,
  afterSequence: number,
  auth: InternalAuthContext,
): Promise<Response> {
  const params = new URLSearchParams();
  params.set("afterSequence", String(parseNonNegativeInteger(afterSequence, 0)));
  const headers = new Headers();
  const upgrade = request.headers.get("upgrade");
  if (upgrade) headers.set("upgrade", upgrade);
  const internalHeaders = buildInternalHeaders(undefined, extractRequestId(request), sessionId, auth);
  for (const [key, value] of Object.entries(internalHeaders)) {
    headers.set(key, value);
  }
  return withDORetry(env, sessionId, (stub) =>
    stub.fetch(
      buildSessionRouteRequest("webSocket", {
        searchParams: params,
        headers,
      }),
    ),
  );
}

export async function openSandboxWebSocket(
  env: Env,
  sessionId: string,
  request: Request,
  sandboxId: string,
): Promise<Response> {
  const params = new URLSearchParams();
  params.set("type", "sandbox");
  params.set("sessionId", sessionId);
  params.set("sandboxId", sandboxId);
  const headers = new Headers(request.headers);
  headers.set("x-sandbox-client-ip", request.headers.get("CF-Connecting-IP")?.trim() || "unknown");
  return withDORetry(env, sessionId, (stub) =>
    stub.fetch(
      buildSessionRouteRequest("webSocket", {
        searchParams: params,
        headers,
      }),
    ),
  );
}

export async function stopSession(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchSessionRouteResponse(env, sessionId, "stop", { requestId });
  return response.json() as Promise<StopSessionResponse>;
}

export async function respondToSession(
  env: Env,
  sessionId: string,
  answer: string,
  questionId?: string,
  requestId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const body = { answer, questionId } satisfies RespondToSessionRequest;
  const response = await fetchSessionRouteResponse(env, sessionId, "respond", {
    requestId,
    body,
  });
  return response.json() as Promise<RespondToSessionResponse>;
}

export async function approveSessionPlan(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: ApproveSessionPlanRequest,
): Promise<SessionFetchResultWithError<ApproveSessionPlanResponse>> {
  return fetchSessionRouteResult(env, sessionId, "planApprove", {
    requestId,
    auth,
    body,
    parseStructuredError: true,
  });
}

/** Forward clone-token request to DO (sandbox auth validated by DO). */
export async function getCloneToken(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.cloneToken.path, {
    method: SESSION_INTERNAL_ROUTES.cloneToken.method,
    headers: sandboxAuthForwardHeaders(request),
    includeInternalHeaders: false,
  });
}

/** Forward GitHub token request to DO (sandbox auth validated by DO). */
export async function getGithubToken(env: Env, sessionId: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.githubToken.path, {
    method: SESSION_INTERNAL_ROUTES.githubToken.method,
    headers: sandboxAuthForwardHeaders(request),
    searchParams: url.searchParams,
    includeInternalHeaders: false,
  });
}

export async function callGithubActionRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.githubAction.path, {
    method: SESSION_INTERNAL_ROUTES.githubAction.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/** Forward sandbox CLI auth token request to DO (sandbox auth validated by DO). */
export async function getCliAuthToken(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.cliAuthToken.path, {
    method: SESSION_INTERNAL_ROUTES.cliAuthToken.method,
    headers: sandboxAuthForwardHeaders(request),
    includeInternalHeaders: false,
  });
}

/** Verify the sandbox binding for a child-session create without minting a user token. */
export async function authorizeChildSession(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.authorizeChildSession.path, {
    method: SESSION_INTERNAL_ROUTES.authorizeChildSession.method,
    headers: sandboxAuthForwardHeaders(request),
    includeInternalHeaders: false,
  });
}

export async function publishPrReviewFromSandbox(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.publishPrReview.path, {
    method: SESSION_INTERNAL_ROUTES.publishPrReview.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callSlackDynamicToolRoute(
  env: Env,
  sessionId: string,
  request: Request,
  routeName: "slackGetThread" | "slackSearchMessages" | "slackSendMessage",
): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES[routeName].path, {
    method: SESSION_INTERNAL_ROUTES[routeName].method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callSessionIntegrationLifecycleRoute(
  env: Env,
  sessionId: string,
  request: Request,
): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.integrationLifecycle.path, {
    method: SESSION_INTERNAL_ROUTES.integrationLifecycle.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callCompanyMemorySandboxRoute(
  env: Env,
  sessionId: string,
  request: Request,
  routeName: "companyMemoryReasoningChain",
): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES[routeName].path, {
    method: SESSION_INTERNAL_ROUTES[routeName].method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callMemoryContextSandboxRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.memoryContext.path, {
    method: SESSION_INTERNAL_ROUTES.memoryContext.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      "content-type": request.headers.get("content-type") || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/**
 * Forward a sandbox Datadog-logs telemetry batch to the DO, which injects the
 * platform DD-API-KEY server-side. Sandbox auth (Bearer) validated by the DO.
 */
export async function callTelemetryDdLogsRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  const incomingContentEncoding = request.headers.get("content-encoding");
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.telemetryDdLogs.path, {
    method: SESSION_INTERNAL_ROUTES.telemetryDdLogs.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
      ...(incomingContentEncoding ? { "content-encoding": incomingContentEncoding } : {}),
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/**
 * Forward a Braintrust SDK call to the DO, which injects the platform
 * BRAINTRUST_API_KEY server-side and forwards to the allowlisted upstream. The
 * upstream subpath (matched from the public route) is conveyed via the
 * X-Telemetry-Subpath header. Sandbox auth (Bearer) validated by the DO.
 */
export async function callTelemetryBraintrustRoute(
  env: Env,
  sessionId: string,
  request: Request,
  subpath: string,
): Promise<Response> {
  const incomingContentEncoding = request.headers.get("content-encoding");
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.telemetryBraintrust.path, {
    method: SESSION_INTERNAL_ROUTES.telemetryBraintrust.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
      ...(incomingContentEncoding ? { "content-encoding": incomingContentEncoding } : {}),
      "x-telemetry-subpath": subpath,
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/**
 * Forward a Sentry envelope to the DO, which derives the ingest URL + auth from
 * the platform SENTRY_DSN server-side. The Sentry SDK tunnel sends no Bearer;
 * the bridge appends `?st=<SANDBOX_AUTH_TOKEN>`, which we propagate so the DO's
 * sandbox-auth fallback can validate it.
 */
export async function callTelemetrySentryRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  const stToken = new URL(request.url).searchParams.get("st");
  const searchParams = stToken ? new URLSearchParams({ st: stToken }) : undefined;
  const incomingContentEncoding = request.headers.get("content-encoding");
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.telemetrySentry.path, {
    method: SESSION_INTERNAL_ROUTES.telemetrySentry.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/x-sentry-envelope",
      ...(incomingContentEncoding ? { "content-encoding": incomingContentEncoding } : {}),
    },
    ...(searchParams ? { searchParams } : {}),
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callReviewLoopReplyRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.reviewLoopReply.path, {
    method: SESSION_INTERNAL_ROUTES.reviewLoopReply.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callReviewLoopRecordPushRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.reviewLoopRecordPush.path, {
    method: SESSION_INTERNAL_ROUTES.reviewLoopRecordPush.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function callReviewLoopSummaryCommentRoute(
  env: Env,
  sessionId: string,
  request: Request,
): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.reviewLoopSummaryComment.path, {
    method: SESSION_INTERNAL_ROUTES.reviewLoopSummaryComment.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/** Forward an agent-proposed PR title update to the DO (sandbox auth validated by DO). */
export async function callUpdatePrTitleRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.updatePrTitle.path, {
    method: SESSION_INTERNAL_ROUTES.updatePrTitle.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/** Forward an agent-requested PR close to the DO (sandbox auth validated by DO). */
export async function callClosePrRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.closePr.path, {
    method: SESSION_INTERNAL_ROUTES.closePr.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

export async function closeAttachedPrForArchive(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<SessionFetchResult<ArchiveClosePrResponse>> {
  return fetchSessionRouteResult(env, sessionId, "archiveClosePr", {
    requestId,
    body: {},
  });
}

/** Forward an agent-requested PR read to the DO (sandbox auth validated by DO). */
export async function callReadPrRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.readPr.path, {
    method: SESSION_INTERNAL_ROUTES.readPr.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/** Forward an agent-created ticket key capture to the DO (sandbox auth validated by DO). */
export async function callRecordAgentTicketKeyRoute(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.recordAgentTicketKey.path, {
    method: SESSION_INTERNAL_ROUTES.recordAgentTicketKey.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json; charset=utf-8",
    },
    ...(await bufferedBodyInit(request)),
    includeInternalHeaders: false,
  });
}

/** Forward platform LLM capability validation to DO (sandbox auth validated by DO). */
/**
 * Pick the internal capability-validation route matching a call's phase. The DO
 * derives `requestedPhase` from the path and rejects (400) when the request
 * body's phase disagrees, so a post_execution call MUST validate against the
 * post-execution route — otherwise it is checked as prompt_preparation and fails
 * closed. (This wrapper previously hardcoded prompt-preparation, which silently
 * broke the first post_execution call type, `pr_template_fill`.)
 */
export function platformLlmCapabilityInternalRoute(
  phase: ValidatePlatformLlmCapabilityRequest["phase"],
): (typeof SESSION_INTERNAL_ROUTES)["platformLlmPostExecution" | "platformLlmPromptPreparation"] {
  return phase === "post_execution"
    ? SESSION_INTERNAL_ROUTES.platformLlmPostExecution
    : SESSION_INTERNAL_ROUTES.platformLlmPromptPreparation;
}

export async function validatePlatformLlmCapability(
  env: Env,
  sessionId: string,
  request: Request,
  body: ValidatePlatformLlmCapabilityRequest,
): Promise<Response> {
  const route = platformLlmCapabilityInternalRoute(body.phase);
  return fetchSessionRawByPath(env, sessionId, route.path, {
    method: route.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json",
      "x-platform-llm-capability": request.headers.get("x-platform-llm-capability") || "",
    },
    body: JSON.stringify(body),
    includeInternalHeaders: false,
  });
}

export async function getSessionUsage(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<GetSessionUsageResponse> {
  const response = await fetchSessionRouteResponse(env, sessionId, "usage", { requestId });
  if (response.status === 404) return { ok: false };
  return response.json() as Promise<GetSessionUsageResponse>;
}

export async function getSessionInputComposition(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<GetSessionInputCompositionResponse> {
  const response = await fetchSessionRouteResponse(env, sessionId, "inputComposition", { requestId });
  if (response.status === 404) return { ok: false };
  return response.json() as Promise<GetSessionInputCompositionResponse>;
}

export async function getSessionSandboxState(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  auth?: InternalAuthContext,
): Promise<SessionFetchResult<GetSessionSandboxStateResponse>> {
  return fetchSessionRouteResult(env, sessionId, "sandboxState", {
    requestId,
    auth,
  });
}

export async function listSessionArtifactsAuthed(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  auth?: InternalAuthContext,
): Promise<SessionFetchResult<ListSessionArtifactsResponse>> {
  return fetchSessionRouteResult(env, sessionId, "artifactsList", {
    requestId,
    auth,
  });
}

export async function getSessionDesktopActionPathAuthed(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  auth?: InternalAuthContext,
): Promise<SessionFetchResult<DesktopActionPathSnapshotResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopActionPathSnapshot", {
    requestId,
    auth,
  });
}

export async function warmSession(
  env: Env,
  sessionId: string,
  requestId?: string | null,
  trigger?: "composer_input" | "page_open",
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const response = await fetchSessionRouteResponse(env, sessionId, "warm", {
    requestId,
    ...(trigger ? { searchParams: new URLSearchParams({ trigger }) } : {}),
  });
  return response.json() as Promise<WarmSessionResponse>;
}

export async function wakeSessionSlackRetry(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<SessionFetchResult<SessionInternalRouteResponse<"slackRetryWake">>> {
  return fetchSessionRouteResult(env, sessionId, "slackRetryWake", { requestId });
}

export async function uploadSandboxArtifact(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.artifactsUpload.path, {
    method: SESSION_INTERNAL_ROUTES.artifactsUpload.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]:
        request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/octet-stream",
      "x-artifact-type": request.headers.get("x-artifact-type") || "artifact",
      "x-artifact-label": request.headers.get("x-artifact-label") || "",
      "x-artifact-display-label": request.headers.get("x-artifact-display-label") || "",
      "x-prompt-id": request.headers.get("x-prompt-id") || "",
      "x-artifact-kind": request.headers.get("x-artifact-kind") || "",
      "x-desktop-action-id": request.headers.get("x-desktop-action-id") || "",
      "x-desktop-phase": request.headers.get("x-desktop-phase") || "",
      "x-desktop-scenario-id": request.headers.get("x-desktop-scenario-id") || "",
    },
    includeInternalHeaders: false,
    ...(await bufferedBodyInit(request)),
  });
}

export async function registerSandboxDesktopActionPathRow(
  env: Env,
  sessionId: string,
  request: Request,
): Promise<SessionFetchResult<RegisterDesktopActionPathRowResponse>> {
  const response = await fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.desktopActionPathRegister.path, {
    method: SESSION_INTERNAL_ROUTES.desktopActionPathRegister.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/json",
    },
    includeInternalHeaders: false,
    ...(await bufferedBodyInit(request)),
  });
  return {
    status: response.status,
    ok: response.ok,
    payload: response.ok ? ((await response.json()) as RegisterDesktopActionPathRowResponse) : null,
  };
}

export async function createSessionDesktopViewTicketAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
): Promise<SessionFetchResultWithError<SessionInternalRouteResponse<"desktopViewTicketCreate">>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketCreate", {
    requestId,
    auth,
    parseStructuredError: true,
  });
}

export async function heartbeatSessionDesktopViewTicketAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: DesktopViewTicketHeartbeatRequest,
): Promise<SessionFetchResult<DesktopViewTicketHeartbeatResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketHeartbeat", { requestId, auth, body });
}

export async function revokeSessionDesktopViewTicketAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: DesktopViewTicketRevokeRequest,
): Promise<SessionFetchResult<DesktopViewTicketRevokeResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketRevoke", { requestId, auth, body });
}

export async function getSessionDesktopViewTicketStatusAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: DesktopViewTicketStatusRequest,
): Promise<SessionFetchResult<DesktopViewTicketStatusResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketStatus", { requestId, auth, body });
}

export async function connectSessionDesktopViewTicketAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: DesktopViewTicketConnectRequest,
): Promise<SessionFetchResult<DesktopViewTicketConnectResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketConnect", { requestId, auth, body });
}

export async function closeSessionDesktopViewTicketAuthed(
  env: Env,
  sessionId: string,
  requestId: string | null,
  auth: InternalAuthContext,
  body: DesktopViewTicketCloseRequest,
): Promise<SessionFetchResult<DesktopViewTicketCloseResponse>> {
  return fetchSessionRouteResult(env, sessionId, "desktopViewTicketClose", { requestId, auth, body });
}

export async function uploadSandboxRollout(env: Env, sessionId: string, request: Request): Promise<Response> {
  // Stream the (up to 100MB) body to the DO instead of buffering it into worker
  // memory via arrayBuffer(). The DO enforces the size cap mid-read.
  const contentLength = request.headers.get("content-length");
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.rolloutUpload.path, {
    method: SESSION_INTERNAL_ROUTES.rolloutUpload.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: request.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) || "application/gzip",
      // Forward the caller's Content-Length so the DO's pre-read 413 fast-path
      // can reject an honestly-oversized upload before reading any body. The DO
      // never trusts it as authoritative: its mid-read byte cap still bounds the
      // body when the header is absent or understated.
      ...(contentLength ? { "content-length": contentLength } : {}),
    },
    includeInternalHeaders: false,
    ...streamedBodyInit(request),
  });
}

export async function downloadSandboxRollout(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.rolloutDownload.path, {
    method: SESSION_INTERNAL_ROUTES.rolloutDownload.method,
    headers: sandboxAuthForwardHeaders(request),
    includeInternalHeaders: false,
  });
}

export async function getPublicSessionArtifact(
  env: Env,
  sessionId: string,
  artifactId: string,
  filename: string,
  request: Request,
): Promise<Response> {
  const sourceUrl = new URL(request.url);
  if (!sourceUrl.searchParams.has(PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM)) {
    return new Response("Not found", { status: 404 });
  }

  const searchParams = new URLSearchParams(sourceUrl.search);
  return fetchSessionRawByPath(env, sessionId, buildSessionArtifactReadPath(artifactId, filename), {
    method: SESSION_INTERNAL_ROUTES.artifactsPublic.method,
    requestId: extractRequestId(request),
    searchParams,
  });
}

export async function getAuthedSessionArtifact(
  env: Env,
  sessionId: string,
  artifactId: string,
  filename: string,
  request: Request,
): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, buildSessionArtifactAuthedViewPath(artifactId, filename), {
    method: SESSION_INTERNAL_ROUTES.artifactsAuthedView.method,
    requestId: extractRequestId(request),
  });
}

export async function revokeSessionArtifact(
  env: Env,
  sessionId: string,
  artifactId: string,
  requestId?: string | null,
): Promise<RevokeSessionArtifactResponse> {
  const response = await fetchSessionRawByPath(env, sessionId, buildSessionArtifactDeletePath(artifactId), {
    method: SESSION_INTERNAL_ROUTES.artifactsDelete.method,
    requestId,
  });
  if (response.status === 404) return { ok: false, error: "Artifact not found" };
  return response.json() as Promise<{ ok: boolean; error?: string }>;
}

export async function resumeSession(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  // Resume intentionally reuses the warm DO path: both operations only need to
  // reconnect or spawn the sandbox after route-level access validation.
  return warmSession(env, sessionId, requestId);
}

/**
 * Replay the session's last terminal (completed/failed) prompt via the DO's
 * retry mechanism (`handleRetryRequest`, prompt-queue.ts): the prompt is
 * cloned, enqueued, and dispatched/spawned exactly like a fresh enqueue. The
 * DO enforces idempotency (an active/queued prompt rejects a second clone with
 * `reason: "retry_in_progress"`) and re-checks `isRetryAvailable`; callers own
 * auth, rate limiting, and repo-access re-validation (route/Slack dispatcher).
 */
export async function retrySessionPrompt(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<{ ok: boolean; status?: string; error?: string; reason?: string }> {
  const response = await fetchSessionRouteResponse(env, sessionId, "retry", { requestId });
  return response.json() as Promise<{ ok: boolean; status?: string; error?: string; reason?: string }>;
}

export async function getSessionEventHistory(
  env: Env,
  sessionId: string,
  promptId?: string,
  afterSequence?: number,
  requestId?: string | null,
): Promise<{ ok: boolean; events: SessionEvent[] }> {
  let cursor = afterSequence ?? 0;
  const events: SessionEvent[] = [];

  while (true) {
    const params = buildSessionReplaySearchParams({
      promptId,
      afterSequence: cursor,
      limit: SESSION_REPLAY_MAX_LIMIT,
    });
    const response = await fetchSessionRouteResponse(env, sessionId, "eventsHistory", {
      requestId,
      searchParams: params,
    });
    const page = (await response.json()) as SessionReplayResponse;
    if (!page.ok) {
      return { ok: false, events: [] };
    }
    events.push(
      ...page.events.map((event) => ({
        sequence: event.sequence,
        id: `replay-${event.sequence}`,
        type: getRawSessionEventKind(event),
        timestamp: getRawSessionEventTimestamp(event) ?? "",
        data: getRawSessionEventData(event) ?? {},
      })),
    );
    if (!page.hasMore || page.lastSequence == null || page.lastSequence <= cursor) {
      break;
    }
    cursor = page.lastSequence;
  }

  return { ok: true, events };
}

export async function getSessionReplayPageAuthed(
  env: Env,
  sessionId: string,
  auth: InternalAuthContext,
  query: {
    promptId?: string;
    afterSequence?: number;
    beforeSequence?: number;
    limit?: number;
    hasExplicitAfterSequence?: boolean;
  },
  requestId?: string | null,
): Promise<SessionFetchResult<SessionReplayResponse>> {
  const params = buildSessionReplaySearchParams(
    query.beforeSequence !== undefined && query.afterSequence === 0 && query.hasExplicitAfterSequence !== true
      ? { promptId: query.promptId, beforeSequence: query.beforeSequence, limit: query.limit }
      : query,
  );
  return fetchSessionRouteResult(env, sessionId, "eventsHistory", {
    requestId,
    auth,
    searchParams: params,
  });
}

export async function getSessionBootstrapAuthed(
  env: Env,
  sessionId: string,
  auth: InternalAuthContext,
  promptIds: string[],
  requestId?: string | null,
): Promise<SessionFetchResult<SessionInternalRouteMap["eventsBootstrap"]["response"]>> {
  const params = new URLSearchParams(promptIds.map((promptId) => ["prompt_id", promptId]));
  return fetchSessionRouteResult(env, sessionId, "eventsBootstrap", {
    requestId,
    auth,
    searchParams: params,
  });
}

export async function getSessionContext(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<{ ok: boolean; context?: Record<string, unknown>; error?: string }> {
  const response = await fetchSessionRouteResponse(env, sessionId, "context", { requestId });
  return response.json() as Promise<GetSessionContextResponse>;
}

export async function getSessionContextAuthed(
  env: Env,
  sessionId: string,
  auth: InternalAuthContext,
  requestId?: string | null,
): Promise<SessionFetchResult<GetSessionContextResponse>> {
  return fetchSessionRouteResult(env, sessionId, "context", {
    requestId,
    auth,
  });
}

export async function getSessionExportData(
  env: Env,
  sessionId: string,
  requestId?: string | null,
): Promise<Record<string, unknown>> {
  const response = await fetchSessionRouteResponse(env, sessionId, "export", { requestId });
  return response.json() as Promise<GetSessionExportResponse>;
}

export async function getSessionExportDataAuthed(
  env: Env,
  sessionId: string,
  auth: InternalAuthContext,
  requestId?: string | null,
): Promise<SessionFetchResult<GetSessionExportResponse>> {
  return fetchSessionRouteResult(env, sessionId, "export", {
    requestId,
    auth,
  });
}

export async function setSessionRepo(
  env: Env,
  sessionId: string,
  repoOwner: string,
  repoName: string,
  baseBranch?: string,
  installationId?: number,
  requestId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const body = { repoOwner, repoName, baseBranch, installationId } satisfies SetSessionRepoRequest;
  const response = await fetchSessionRouteResponse(env, sessionId, "repo", {
    requestId,
    body,
  });
  return response.json() as Promise<SetSessionRepoResponse>;
}

export async function updateSessionCallbackContext(
  env: Env,
  sessionId: string,
  callbackContext: CallbackContext,
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionCallbackContextResponse>> {
  return fetchSessionRouteResult(env, sessionId, "callbackContext", {
    requestId,
    body: callbackContext,
  });
}

export async function updateSessionReviewListeningHead(
  env: Env,
  sessionId: string,
  payload: UpdateSessionReviewListeningHeadRequest,
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionReviewListeningHeadResponse>> {
  return fetchSessionRouteResult(env, sessionId, "reviewListeningHead", {
    requestId,
    body: payload,
  });
}

export async function updateSessionPrDraftState(
  env: Env,
  sessionId: string,
  payload: UpdateSessionPrDraftRequest,
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionPrDraftResponse>> {
  return fetchSessionRouteResult(env, sessionId, "prDraft", {
    requestId,
    body: payload,
  });
}

export async function enterSessionReviewListening(
  env: Env,
  sessionId: string,
  payload: EnterSessionReviewListeningRequest,
  requestId?: string | null,
): Promise<SessionFetchResult<EnterSessionReviewListeningResponse>> {
  return fetchSessionRouteResult(env, sessionId, "reviewListeningEnter", {
    requestId,
    body: payload,
  });
}

export async function setSessionVerificationState(
  env: Env,
  sessionId: string,
  options: {
    state: import("../../../../shared/session/phase.js").VerificationState | null;
    attemptCount: number;
    maxAttempts: number;
    allowExhaustedClear?: boolean;
    runBaseline?: number | null;
    verdictHeadSha?: string | null;
  },
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionVerificationStateResponse>> {
  const body = {
    requestId: requestId ?? crypto.randomUUID(),
    state: options.state,
    attemptCount: options.attemptCount,
    maxAttempts: options.maxAttempts,
    ...(options.allowExhaustedClear ? { allowExhaustedClear: true } : {}),
    ...(typeof options.runBaseline === "number" ? { runBaseline: options.runBaseline } : {}),
    ...(options.verdictHeadSha !== undefined ? { verdictHeadSha: options.verdictHeadSha } : {}),
  } satisfies UpdateSessionVerificationStateRequest;
  return fetchSessionRouteResult(env, sessionId, "verificationState", {
    requestId,
    body,
  });
}

export async function setSessionVerificationResult(
  env: Env,
  sessionId: string,
  options: {
    result: import("../../../../shared/session/phase.js").VerificationResult | null;
    needsWorkLabel?: import("../../../../shared/types/sandbox.js").VerificationNeedsWorkLabel | null;
    qaRun?: import("../../../../shared/types/qa-run.js").QaRunTerminalSummary | null;
  },
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionVerificationResultResponse>> {
  const body = {
    requestId: requestId ?? crypto.randomUUID(),
    result: options.result,
    needsWorkLabel: options.needsWorkLabel ?? null,
    ...(options.qaRun !== undefined || options.result === null ? { qaRun: options.qaRun ?? null } : {}),
  } satisfies UpdateSessionVerificationResultRequest;
  return fetchSessionRouteResult(env, sessionId, "verificationResult", {
    requestId,
    body,
  });
}

export async function notifySessionReviewLoopSummaryCommentPosted(
  env: Env,
  sessionId: string,
  payload: { epochId: string; githubCommentId: number },
  requestId?: string | null,
): Promise<void> {
  await fetchSessionRouteResult(env, sessionId, "reviewLoopSummaryCommentPosted", {
    requestId,
    body: payload,
  }).catch(() => {
    // Fire-and-forget: event emission failure must not block the summary-comment response.
  });
}

export async function notifySessionPrMerged(
  env: Env,
  sessionId: string,
  prUrl: string,
  requestId?: string | null,
): Promise<SessionFetchResult<NotifySessionPrMergedResponse>> {
  return fetchSessionRouteResult(env, sessionId, "notifyPrMerged", {
    requestId,
    body: { prUrl },
  });
}

export async function notifySessionPrClosed(
  env: Env,
  sessionId: string,
  prUrl: string,
  closedByLogin: string | null,
  requestId?: string | null,
): Promise<SessionFetchResult<NotifySessionPrClosedResponse>> {
  return fetchSessionRouteResult(env, sessionId, "notifyPrClosed", {
    requestId,
    body: { prUrl, closedByLogin },
  });
}

export async function closeSessionForWebhook(
  env: Env,
  db: D1Database,
  sessionId: string,
  options?: SessionCloseOptions,
): Promise<{ closed: boolean; session: SessionState | null }> {
  const existing = await getSessionState(env, sessionId);
  if (!existing || existing.status === "archived") {
    return { closed: false, session: existing };
  }

  const closed = await closeSessionState(
    env,
    sessionId,
    undefined,
    options ?? { reason: "webhook_closed", metadata: { closeSource: "webhook" } },
  );
  if (!closed) {
    return { closed: false, session: null };
  }

  await syncSessionProjection({
    db,
    sessionId: closed.session.sessionId,
    session: closed.session,
    replay: closed.replay,
    source: "session.state.closeSessionForWebhook",
  });
  return { closed: true, session: closed.session };
}
