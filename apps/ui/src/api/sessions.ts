import { z } from "zod";

import type { PlanModeSetting } from "../../../../shared/plan-mode";
import type { DisplayStatus } from "../../../../shared/session/display-status";
import { normalizeUiLifecycleStage } from "../../../../shared/session/lifecycle-stage";
import {
  flattenSessionEvents,
  getRawSessionEventPromptId,
  type RawSessionEvent,
  resolveAuthoritativePromptEventsWithDiagnostics,
} from "../../../../shared/transcript/projector.js";
import type { DesktopActionPathSnapshotResponse } from "../../../../shared/types/desktop-action-path";
import type {
  CreateDesktopViewTicketResponse,
  DesktopViewTicketHeartbeatResponse,
  DesktopViewTicketRevokeResponse,
  DesktopViewTicketStatusResponse,
} from "../../../../shared/types/desktop-viewer";
import type { UploadedFile, UploadedImage } from "../../../../shared/types/sandbox";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan";
import type { SessionReplayResponse } from "../../../../shared/types/session-replay";
import type { SessionViewResponse } from "../../../../shared/types/session-view";
import type {
  ActivityEvent,
  ModelSelection,
  Phase,
  PromptRow,
  SessionDetail,
  SessionMetadata,
  SessionStatus,
} from "../types";
import { apiCacheKeys, invalidate, swr } from "./cache";
import {
  ApiError,
  captureApiError,
  JSON_HEADERS,
  requestJson,
  requestJson as requestValidatedJson,
  requestVoid,
  trackApiAction,
} from "./client";

export type FetchSessionsResult = { sessions: SessionMetadata[]; nextCursor: string | null };

export type SessionPlan = {
  status: SessionPlanStatus;
  revision: number;
  markdown: string | null;
  userEdited: boolean;
  updatedAt: string;
  planPromptId: string;
  // Additive wire fields: older control-plane deployments omit these. The UI
  // falls back to validating generated markdown until every deployment sends
  // the authoritative capture result.
  valid?: boolean;
  missingReason?: string | null;
};

// Mirrors the DO's GET /session/plan payload (control-plane fetch-router.ts):
// `{ status, revision, markdown, userEdited, updatedAt, planPromptId }` built
// from the latest session_plans row. `valid` / `missingReason` are additive
// wire fields (see SessionPlan above), so they stay optional here.
const sessionPlanSchema = z.object({
  status: z.enum(["none", "pending", "approved", "superseded"]),
  revision: z.number(),
  markdown: z.string().nullable(),
  userEdited: z.boolean(),
  updatedAt: z.string(),
  planPromptId: z.string(),
  valid: z.boolean().optional(),
  missingReason: z.string().nullable().optional(),
});

// Mirrors ApproveSessionPlanResponse (control-plane internal-routes.ts): the
// DO's plan-approve handler returns exactly these four fields on success.
const approveSessionPlanResponseSchema = z.object({
  ok: z.literal(true),
  revision: z.number(),
  implementationPromptId: z.string(),
  idempotent: z.boolean(),
});

// Mirrors EditSessionPlanResponse (control-plane internal-routes.ts): the DO's
// PUT /session/plan handler returns this fixed envelope with the bumped revision.
const updateSessionPlanResponseSchema = z.object({
  ok: z.literal(true),
  planApprovalPending: z.literal(true),
  revision: z.number(),
  status: z.literal("pending"),
});

const desktopActionScreenshotSchema = z.object({
  actionId: z.string(),
  artifactId: z.string(),
  kind: z.literal("desktop_action_screenshot"),
  artifactAccessVisibility: z.literal("private"),
  label: z.string(),
  viewUrl: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  captureMode: z.literal("full_display").nullable(),
  displayName: z.string().nullable(),
  capturedAtMs: z.number(),
  status: z.enum(["available", "failed", "quota_exceeded", "pruned"]),
});

const desktopActionPathRowSchema = z.object({
  actionId: z.string(),
  desktopActionSeq: z.number(),
  sessionId: z.string(),
  promptId: z.string().nullable(),
  phase: z.enum(["agent", "verification_operator"]),
  action: z.enum(["observe", "screenshot", "click", "type", "hotkey", "scroll", "drag", "open_app", "focus_window"]),
  label: z.string(),
  status: z.enum([
    "completed",
    "action_failed",
    "desktop_unavailable",
    "screenshot_failed",
    "quota_exceeded",
    "pruned",
  ]),
  activeWindowTitle: z.string().nullable(),
  warningCode: z.string().nullable(),
  errorCode: z.string().nullable(),
  screenshot: desktopActionScreenshotSchema.nullable(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

const desktopActionPathSnapshotResponseSchema = z.object({
  ok: z.literal(true),
  rows: z.array(desktopActionPathRowSchema),
  maxDesktopActionSeq: z.number(),
});

const desktopViewTicketSchema = z.object({
  ticketId: z.string(),
  expiresAtMs: z.number(),
  hardExpiresAtMs: z.number(),
  heartbeatIntervalMs: z.number(),
  viewOnly: z.literal(true),
});

const desktopViewTicketClientPathsSchema = z.object({
  websocketPath: z.string(),
  heartbeatPath: z.string(),
  revokePath: z.string(),
  statusPath: z.string(),
});

const desktopViewTicketCloseDiagnosticsSchema = z.object({
  phase: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  statusCode: z.number().nullable().optional(),
  retryable: z.boolean().nullable().optional(),
  sandboxStatus: z.string().nullable().optional(),
  runtimeState: z.string().nullable().optional(),
  runtimeBackend: z.string().nullable().optional(),
  supervisorExitCode: z.number().nullable().optional(),
  supervisorHealthStatus: z.string().nullable().optional(),
  supervisorHealthFailedComponent: z.string().nullable().optional(),
  supervisorHealthFailedPhase: z.string().nullable().optional(),
  supervisorHealthLastError: z.string().nullable().optional(),
  supervisorHealthDisplay: z.string().nullable().optional(),
  supervisorHealthWidth: z.number().nullable().optional(),
  supervisorHealthHeight: z.number().nullable().optional(),
  supervisorHealthScreenshotOk: z.boolean().nullable().optional(),
  supervisorHealthScreenshotNonBlackPixelRatio: z.number().nullable().optional(),
  supervisorHealthScreenshotEntropy: z.number().nullable().optional(),
  supervisorHealthScreenshotUniform: z.boolean().nullable().optional(),
  supervisorHealthVncReachable: z.boolean().nullable().optional(),
  supervisorHealthNovncReachable: z.boolean().nullable().optional(),
  supervisorHealthLoopbackOnly: z.boolean().nullable().optional(),
  providerErrorCode: z.string().nullable().optional(),
  providerErrorStatus: z.number().nullable().optional(),
  providerErrorRetryAfterMs: z.number().nullable().optional(),
  providerErrorRequestSent: z.boolean().nullable().optional(),
  websocketCloseSource: z.string().nullable().optional(),
  websocketCloseCode: z.number().nullable().optional(),
  websocketCloseReason: z.string().nullable().optional(),
  websocketCloseWasClean: z.boolean().nullable().optional(),
  upstreamHostPresent: z.boolean().nullable().optional(),
  trafficAccessTokenPresent: z.boolean().nullable().optional(),
});

const createDesktopViewTicketResponseSchema = z.object({
  ok: z.literal(true),
  ticket: desktopViewTicketSchema.merge(desktopViewTicketClientPathsSchema),
});

const desktopViewTicketHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  ticket: desktopViewTicketSchema,
});

const desktopViewTicketRevokeResponseSchema = z.object({
  ok: z.literal(true),
  revoked: z.boolean(),
});

const desktopViewTicketStatusResponseSchema = z.object({
  ok: z.literal(true),
  ticket: desktopViewTicketSchema,
  connectionId: z.string().nullable(),
  connectedAtMs: z.number().nullable(),
  closedAtMs: z.number().nullable(),
  closeReason: z.string().nullable(),
  closeDetail: z.string().nullable().optional(),
  closeDiagnostics: desktopViewTicketCloseDiagnosticsSchema.nullable().optional(),
  revoked: z.boolean(),
  expired: z.boolean(),
});

export type SessionPlanConflictKind = "stale" | "state";

export class SessionPlanConflictError extends Error {
  readonly kind: SessionPlanConflictKind;
  readonly cause: unknown;

  constructor(kind: SessionPlanConflictKind, message: string, cause: unknown) {
    super(message);
    this.name = "SessionPlanConflictError";
    this.kind = kind;
    this.cause = cause;
  }
}

function planConflictKind(error: ApiError): SessionPlanConflictKind {
  const data = error.data as { error?: string } | undefined;
  const detail = `${error.code ?? ""} ${data?.error ?? ""} ${error.message}`.toLowerCase();
  return detail.includes("stale") ? "stale" : "state";
}

async function translatePlanConflict<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new SessionPlanConflictError(planConflictKind(error), error.message, error);
    }
    throw error;
  }
}
export type FetchSessionsOptions = {
  scope?: "personal" | "business";
  cursor?: string | null;
  status?: SessionStatus | null;
  query?: string | null;
};

export type RawSessionMetadata = Omit<
  SessionMetadata,
  "displayStatus" | "phase" | "uiLifecycleStage" | "desktopActionPathAvailable"
> & {
  displayStatus?: DisplayStatus | null;
  phase?: string | null;
  status?: string | null;
  uiLifecycleStage?: unknown;
  desktopActionPathAvailable?: boolean | null;
};

function normalizeListSessionPhase(rawPhase: string | null | undefined): Phase {
  switch (rawPhase) {
    case "idle":
    case "running":
    case "waiting_for_input":
    case "finalizing":
    case "review_listening":
    case "completed":
    case "superseded":
    case "blocked":
    case "failed":
    case "stopped":
    case "archived":
      return rawPhase;
    default:
      return "idle";
  }
}

export function normalizeSessionMetadata(session: RawSessionMetadata): SessionMetadata {
  return {
    ...session,
    phase: normalizeListSessionPhase(session.phase ?? session.status),
    displayStatus: session.displayStatus ?? "stopped",
    uiLifecycleStage: normalizeUiLifecycleStage(session.uiLifecycleStage),
    desktopActionPathAvailable: session.desktopActionPathAvailable === true,
  };
}

export async function fetchSessions(
  options: FetchSessionsOptions & {
    force?: boolean;
    onRevalidate?: (value: FetchSessionsResult) => void;
    isEqual?: (prev: FetchSessionsResult, next: FetchSessionsResult) => boolean;
  } = {},
): Promise<FetchSessionsResult> {
  // NOTE: route-coverage test parses this fetch path statically -- keep the
  // `/api/sessions?...` string literal in the requestJson call (the test strips
  // the query string, so the trailing `?` is fine when no filters are set).
  const params: string[] = [];
  if (options.scope === "business") params.push("scope=business");
  if (options.cursor) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
  if (options.status) params.push(`status=${encodeURIComponent(options.status)}`);
  const query = options.query?.trim();
  if (query) params.push(`q=${encodeURIComponent(query)}`);
  const result = await swr(
    apiCacheKeys.sessions(options),
    () =>
      requestJson<{ sessions: RawSessionMetadata[]; nextCursor: string | null }>(
        `/api/sessions?${params.join("&")}`,
        undefined,
        "Failed to fetch sessions",
      ).then((data) => ({
        ...data,
        sessions: data.sessions.map(normalizeSessionMetadata),
      })),
    {
      staleMs: 30_000,
      force: options.force,
      onRevalidate: options.onRevalidate,
      isEqual: options.isEqual,
    },
  );
  return result.value;
}

type CreateSessionResponse = {
  sessionId: string;
  promptAlreadyEnqueued?: boolean;
};

type CreateSessionOptions = {
  qa?: boolean;
  targetPrUrl?: string;
  prompt?: string;
  forceNewSession?: boolean;
  takeoverPrUrl?: string;
  planMode?: PlanModeSetting;
};

// Every POST /api/sessions success branch (fresh create, idempotency replay,
// coordinated QA verification) returns `sessionId`; `promptAlreadyEnqueued`
// rides only the replay/QA branches. Extra envelope fields the UI ignores
// (ok, sessionUrl, session, auth, duplicate, ...) are stripped by zod.
const createSessionResponseSchema = z.object({
  sessionId: z.string(),
  promptAlreadyEnqueued: z.boolean().optional(),
});

async function createSessionRequest(
  model?: ModelSelection,
  context?: { repoUrl: string; baseBranch?: string },
  reasoningEffort?: string,
  options?: CreateSessionOptions,
): Promise<CreateSessionResponse> {
  // No explicit agentRuntimeBackend: the control plane derives the backend
  // from the model (a Claude model implies claude_code).
  const data = await requestValidatedJson<CreateSessionResponse>(
    "/api/sessions",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...(model ? { model: model.modelID } : {}),
        ...(options?.prompt ? { prompt: options.prompt } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(options?.qa === true ? { qa: true } : {}),
        ...(options?.targetPrUrl ? { targetPrUrl: options.targetPrUrl } : {}),
        ...(options?.takeoverPrUrl ? { continuePrUrl: options.takeoverPrUrl, continueMode: "update-pr" as const } : {}),
        ...(options?.forceNewSession === true ? { forceNewSession: true } : {}),
        // Explicit plan-mode setting from the home composer chip. Sent
        // only when the capability is on (undefined otherwise), so the control
        // plane keeps deriving plan mode from the user setting for everyone else.
        ...(options?.planMode !== undefined ? { planMode: options.planMode } : {}),
        context,
      }),
    },
    "Failed to create session",
    { schema: createSessionResponseSchema },
  );
  invalidate(apiCacheKeys.sessions());
  return data;
}

export async function createSession(
  model?: ModelSelection,
  context?: { repoUrl: string; baseBranch?: string },
  reasoningEffort?: string,
  options?: CreateSessionOptions,
): Promise<string> {
  const data = await createSessionRequest(model, context, reasoningEffort, options);
  return data.sessionId;
}

export interface SessionPrerequisites {
  canStartSession: boolean;
  blocking?: { provider: string | null; reasonCode: string };
}

/**
 * Mirrors the credential gate the backend will run at session create. Lets the
 * UI disable the submit button before the user clicks, instead of accepting
 * the prompt and then failing.
 */
export async function fetchSessionPrerequisites(modelId: string): Promise<SessionPrerequisites> {
  return requestJson<SessionPrerequisites>(
    `/api/sessions/prerequisites?model=${encodeURIComponent(modelId)}`,
    undefined,
    "Failed to fetch session prerequisites",
  );
}

export async function createSessionAndSend(
  prompt: string,
  repo: { url: string; baseBranch?: string },
  model?: ModelSelection,
  files?: string[],
  uploadedFiles?: UploadedFile[],
  uploadedImages?: UploadedImage[],
  agent?: string,
  reasoningEffort?: string,
  skills?: string[],
  options?: Omit<CreateSessionOptions, "prompt">,
): Promise<{ sessionId: string; promptId: string | null; promptAlreadyEnqueued?: boolean }> {
  const session = await createSessionRequest(
    model,
    {
      repoUrl: repo.url,
      baseBranch: repo.baseBranch,
    },
    reasoningEffort,
    { ...options, prompt },
  );
  const sessionId = session.sessionId;
  if (session.promptAlreadyEnqueued) {
    return { sessionId, promptId: null, promptAlreadyEnqueued: true };
  }
  const promptId = await sendPrompt(sessionId, prompt, files, uploadedFiles, uploadedImages, agent, { skills });
  return { sessionId, promptId };
}

export async function fetchSessionFiles(id: string): Promise<string[]> {
  const data = await requestJson<{ files: string[] }>(
    `/api/sessions/${id}/files`,
    undefined,
    "Failed to load file tree",
  );
  return data.files;
}

export async function fetchSessionDesktopActionPath(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DesktopActionPathSnapshotResponse> {
  return requestValidatedJson<DesktopActionPathSnapshotResponse>(
    `/api/sessions/${sessionId}/desktop/action-path`,
    { signal },
    "Failed to load desktop action path",
    { schema: desktopActionPathSnapshotResponseSchema },
  );
}

export async function createSessionDesktopViewTicket(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CreateDesktopViewTicketResponse> {
  return requestValidatedJson<CreateDesktopViewTicketResponse>(
    `/api/sessions/${sessionId}/desktop/view-ticket`,
    {
      method: "POST",
      signal,
    },
    "Failed to create desktop viewing ticket",
    { schema: createDesktopViewTicketResponseSchema },
  );
}

export async function heartbeatSessionDesktopViewTicket(
  heartbeatPath: string,
): Promise<DesktopViewTicketHeartbeatResponse> {
  return requestValidatedJson<DesktopViewTicketHeartbeatResponse>(
    heartbeatPath,
    { method: "POST" },
    "Failed to heartbeat desktop viewing ticket",
    { schema: desktopViewTicketHeartbeatResponseSchema },
  );
}

export async function revokeSessionDesktopViewTicket(revokePath: string): Promise<DesktopViewTicketRevokeResponse> {
  return requestValidatedJson<DesktopViewTicketRevokeResponse>(
    revokePath,
    { method: "DELETE" },
    "Failed to revoke desktop viewing ticket",
    { schema: desktopViewTicketRevokeResponseSchema },
  );
}

export async function fetchSessionDesktopViewTicketStatus(
  statusPath: string,
): Promise<DesktopViewTicketStatusResponse> {
  return requestValidatedJson<DesktopViewTicketStatusResponse>(
    statusPath,
    { method: "GET" },
    "Failed to load desktop viewing ticket status",
    { schema: desktopViewTicketStatusResponseSchema },
  );
}

export type MemoryFeedbackRating = "up" | "down";
export type MemoryFeedbackDisplayEventType = "memory_usage" | "memory_recall_usage";
export type MemoryFeedbackUsageSource = "prompt_start" | "recall" | "company_bootstrap" | "company_recall";

type MemoryFeedbackEntry = {
  feedbackKey: string;
  promptId: string;
  activityEventId: string;
  displayEventType: MemoryFeedbackDisplayEventType;
  usageSource: MemoryFeedbackUsageSource;
  memoryId: string;
  rating: MemoryFeedbackRating;
  message: string | null;
  createdAt: number;
};

type SubmitMemoryFeedbackPayload = {
  promptId: string;
  activityEventId: string;
  displayEventType: MemoryFeedbackDisplayEventType;
  usageSource: MemoryFeedbackUsageSource;
  memoryId: string;
  rating: MemoryFeedbackRating;
  message?: string | null;
  memoryTitle?: string | null;
  memoryPath?: string | null;
  memoryReason?: string | null;
  memoryExpectedEffect?: string | null;
  memoryObservedEffect?: string | null;
};

export async function submitMemoryFeedback(
  sessionId: string,
  payload: SubmitMemoryFeedbackPayload,
): Promise<MemoryFeedbackEntry> {
  const data = await requestJson<{ ok: true; feedback: MemoryFeedbackEntry }>(
    `/api/sessions/${sessionId}/memory-feedback`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    },
    "Failed to submit memory feedback",
  );
  return data.feedback;
}

export type ArchiveSessionResult = {
  ok: true;
  archived: true;
  prClose?: {
    attempted: boolean;
    closed: boolean;
    warning?: string;
  };
};

// Mirrors DELETE /api/sessions/:sessionId (control-plane routes/sessions.ts):
// `{ ok: true, archived: true }` plus a `prClose` outcome only when the caller
// asked to close the PR. `warning` rides failed/skipped close attempts
// (ArchiveClosePrResponse union in internal-routes.ts).
const archiveSessionResultSchema = z.object({
  ok: z.literal(true),
  archived: z.literal(true),
  prClose: z
    .object({
      attempted: z.boolean(),
      closed: z.boolean(),
      warning: z.string().optional(),
    })
    .optional(),
});

export async function archiveSession(id: string, options: { closePr?: boolean } = {}): Promise<ArchiveSessionResult> {
  const result = await requestValidatedJson<ArchiveSessionResult>(
    `/api/sessions/${id}`,
    {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ closePr: options.closePr === true }),
    },
    "Failed to archive session",
    { schema: archiveSessionResultSchema },
  );
  invalidate(apiCacheKeys.sessions());
  return result;
}

export type ChildSessionSummary = {
  childSessionId: string;
  childSessionUrl: string;
  title: string | null;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  prUrl: string | null;
  createdAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
};

type CreateChildSessionInput = {
  prompt: string;
  repositoryId: string;
  title?: string;
  model?: ModelSelection;
  reasoningEffort?: string;
  parentPromptId?: string;
  qa?: boolean;
  targetPrUrl?: string;
  forceNewSession?: boolean;
};

type CreateChildSessionResult = {
  ok: true;
  childSessionId: string;
  childSessionUrl: string;
  parentSessionId: string;
  parentPromptId: string;
  spawnDepth: number;
  idempotentReplay?: boolean;
};

export async function createChildSession(
  parentSessionId: string,
  input: CreateChildSessionInput,
): Promise<CreateChildSessionResult> {
  const data = await requestJson<CreateChildSessionResult>(
    `/api/sessions/${parentSessionId}/child-sessions`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        prompt: input.prompt,
        repositoryId: input.repositoryId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model.modelID } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.parentPromptId ? { parentPromptId: input.parentPromptId } : {}),
        ...(input.qa === true ? { qa: true } : {}),
        ...(input.targetPrUrl ? { targetPrUrl: input.targetPrUrl } : {}),
        ...(input.forceNewSession === true ? { forceNewSession: true } : {}),
      }),
    },
    "Failed to create child session",
  );
  invalidate(apiCacheKeys.sessions());
  return data;
}

export async function fetchChildSessions(
  parentSessionId: string,
  options?: { includePrUrl?: boolean },
): Promise<ChildSessionSummary[]> {
  // Opt into the DO fan-out that populates each child's prUrl. Callers that
  // omit `include=prUrl` hit this same endpoint and get the cheap
  // single-D1-read variant.
  // NOTE: route-coverage parses these template literals statically — keep
  // both branches as clean templates with the query string fully literal,
  // do not interpolate a precomputed `qs` substring.
  type Response = { ok: true; parentSessionId: string; children: ChildSessionSummary[] };
  const data = options?.includePrUrl
    ? await requestJson<Response>(
        `/api/sessions/${parentSessionId}/child-sessions?include=prUrl`,
        undefined,
        "Failed to fetch child sessions",
      )
    : await requestJson<Response>(
        `/api/sessions/${parentSessionId}/child-sessions`,
        undefined,
        "Failed to fetch child sessions",
      );
  return data.children;
}

type SessionViewResult = {
  session: SessionDetail & { ownerAvatarUrl?: string };
  prompts: PromptRow[];
  promptPage: {
    nextCursor: string | null;
    total: number;
  };
};

const SESSION_VIEW_REQUEST_TIMEOUT_MS = 15_000;
const SESSION_VIEW_PROMPT_PAGE_LIMIT = 100;

async function withSessionViewTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_VIEW_REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Session details request timed out. Refresh the page or try another session.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Lazy parent-title lookup for the sidebar. Throws (via requestJson) on HTTP
// error so callers can cache a miss; the /api/sessions/:id endpoint already
// returns the title inline.
export async function fetchSessionTitle(sessionId: string): Promise<string | null> {
  const data = await requestJson<{ session?: { title?: string | null } }>(
    `/api/sessions/${sessionId}`,
    undefined,
    "Failed to fetch parent session title",
  );
  return data.session?.title ?? null;
}

export async function fetchSessionView(id: string, promptCursor?: string): Promise<SessionViewResult> {
  const startedAt = performance.now();
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  const data = await fetchSessionViewPage(id, promptCursor);
  return toSessionViewResult(id, data, { promptCursor, startedAt });
}

async function fetchSessionViewPage(id: string, promptCursor?: string): Promise<SessionViewResponse> {
  return promptCursor
    ? await withSessionViewTimeout((signal) =>
        requestJson<SessionViewResponse>(
          `/api/sessions/${id}/view?promptCursor=${encodeURIComponent(promptCursor)}&promptLimit=${SESSION_VIEW_PROMPT_PAGE_LIMIT}`,
          { signal },
          "Failed to fetch session view",
        ),
      )
    : await withSessionViewTimeout((signal) =>
        requestJson<SessionViewResponse>(
          `/api/sessions/${id}/view?promptLimit=${SESSION_VIEW_PROMPT_PAGE_LIMIT}`,
          { signal },
          "Failed to fetch session view",
        ),
      );
}

function toSessionViewResult(
  id: string,
  data: SessionViewResponse,
  metricsContext?: { promptCursor?: string | null; startedAt?: number },
): SessionViewResult {
  const vm = data.session;
  const model: ModelSelection | null = vm.model
    ? { providerID: vm.model.providerID, modelID: vm.model.modelID, label: vm.model.label }
    : null;

  const session: SessionDetail & { ownerAvatarUrl?: string } = {
    sessionId: vm.sessionId,
    phase: vm.phase,
    displayStatus: vm.displayStatus,
    uiLifecycleStage: normalizeUiLifecycleStage(vm.uiLifecycleStage),
    sandboxSubstate: vm.sandboxSubstate,
    stopMode: vm.stopMode,
    planApprovalPending: vm.planApprovalPending,
    planRevision: vm.planRevision,
    planStatus: vm.planStatus,
    // Live-idle "kept alive after a user stop" flag. The DO-served view carries
    // it, so this HTTP path (resilience poll + cold bootstrap) keeps the Stopped
    // badge/hint instead of resetting it to undefined.
    userStopped: vm.userStopped,
    finalizingStep: vm.finalizingStep,
    planAutoReason: vm.planAutoReason ?? null,
    closeReason: vm.closeReason,
    title: vm.title,
    createdAt: vm.createdAt,
    model,
    desktopActionPathAvailable: vm.desktopActionPathAvailable === true,
    prUrl: vm.prUrl,
    prDraft: vm.prDraft,
    prManualReviewReason: vm.prManualReviewReason ?? null,
    publishStatus: vm.publishStatus ?? "not_started",
    publishError: vm.publishError ?? null,
    publishedBranch: vm.publishedBranch ?? null,
    outcome: vm.outcome ?? null,
    reasoningEffort: vm.reasoningEffort ?? null,
    queueLength: vm.queueLength,
    repoUrl: vm.repoUrl,
    lastBranch: vm.lastBranch,
    baseBranch: vm.baseBranch,
    startBranch: vm.startBranch,
    spawnDurationMs: vm.spawnDurationMs,
    sandboxId: vm.sandboxId ?? null,
    sandboxConnected: vm.sandboxConnected ?? null,
    verification: vm.verification ?? null,
    qaRun: vm.qaRun ?? null,
    runtimeProvenance: vm.runtimeProvenance ?? null,
    observabilityReadiness: vm.observabilityReadiness ?? null,
    ...(vm.ownerLogin ? { ownerLogin: vm.ownerLogin } : {}),
    ...(vm.ownerAvatarUrl ? { ownerAvatarUrl: vm.ownerAvatarUrl } : {}),
    ...(vm.parentSessionId
      ? { parentSessionId: vm.parentSessionId, parentPromptId: vm.parentPromptId, spawnDepth: vm.spawnDepth }
      : {}),
    ...(vm.childSessionIds?.length ? { childSessionIds: vm.childSessionIds } : {}),
    ...(vm.qaChildSessionId ? { qaChildSessionId: vm.qaChildSessionId } : {}),
    initiationMode: vm.initiationMode ?? "user",
    entrypoint: vm.entrypoint ?? null,
    scheduledRuleId: vm.scheduledRuleId ?? null,
    ruleNameSnapshot: vm.ruleNameSnapshot ?? null,
    cronSnapshot: vm.cronSnapshot ?? null,
    reviewLoopDoneState: vm.reviewLoopDoneState ?? null,
    cycloidDoneState: vm.cycloidDoneState ?? "working",
    cycloidDoneOutcome: vm.cycloidDoneOutcome ?? null,
    cycloidDoneReasons: vm.cycloidDoneReasons ?? [],
    verificationState: vm.verificationState ?? null,
    verificationResult: vm.verificationResult ?? null,
    verificationNeedsWorkLabel: vm.verificationNeedsWorkLabel ?? null,
    ...(vm.verificationAttemptCount !== undefined ? { verificationAttemptCount: vm.verificationAttemptCount } : {}),
    ...(vm.verificationMaxAttempts !== undefined ? { verificationMaxAttempts: vm.verificationMaxAttempts } : {}),
  };

  const prompts: PromptRow[] = data.prompts.items.map((p) => ({
    promptId: p.promptId,
    session_id: id,
    prompt: p.prompt,
    ...(p.replyToText != null ? { replyToText: p.replyToText } : {}),
    status: p.status,
    result: p.result,
    actorUserId: p.actorUserId ?? null,
    ...(p.actorLogin != null ? { actorLogin: p.actorLogin } : {}),
    ...(p.actorAvatarUrl != null ? { actorAvatarUrl: p.actorAvatarUrl } : {}),
    ...(p.agent ? { agent: p.agent } : {}),
    ...(p.skills?.length ? { skills: p.skills } : {}),
    ...(p.model != null ? { model: p.model } : {}),
    ...(p.reasoningEffort != null ? { reasoningEffort: p.reasoningEffort } : {}),
    ...(p.error != null ? { error: p.error } : {}),
    ...(p.files?.length ? { files: p.files } : {}),
    ...(p.uploadedFiles?.length ? { uploadedFiles: p.uploadedFiles } : {}),
    ...(p.uploadedImages?.length ? { uploadedImages: p.uploadedImages } : {}),
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.continuesPlan ? { continuesPlan: true } : {}),
  }));

  trackApiAction("session_view_fetch", {
    sessionId: id,
    promptCount: data.prompts.total,
    promptPageSize: data.prompts.items.length,
    hasNextPromptPage: data.prompts.nextCursor !== null,
    promptCursor: metricsContext?.promptCursor ?? null,
    durationMs: metricsContext?.startedAt != null ? Math.round(performance.now() - metricsContext.startedAt) : null,
  });

  return {
    session,
    prompts,
    promptPage: {
      nextCursor: data.prompts.nextCursor,
      total: data.prompts.total,
    },
  };
}

export async function sendPrompt(
  id: string,
  prompt: string,
  files?: string[],
  uploadedFiles?: UploadedFile[],
  uploadedImages?: UploadedImage[],
  agent?: string,
  options?: { skills?: string[] },
): Promise<string> {
  const skills = options?.skills;
  trackApiAction("send_prompt", { sessionId: id, agent, skills });
  const data = await requestJson<{ prompt: { promptId: string } }>(
    `/api/sessions/${id}/send`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        prompt,
        ...(files?.length ? { files } : {}),
        ...(uploadedFiles?.length ? { uploadedFiles } : {}),
        ...(uploadedImages?.length ? { uploadedImages } : {}),
        ...(agent ? { agent } : {}),
        ...(skills?.length ? { skills } : {}),
      }),
    },
    "Failed to send prompt",
  );
  invalidate(apiCacheKeys.sessions());
  return data.prompt.promptId;
}

export async function fetchSessionPlan(sessionId: string): Promise<SessionPlan> {
  return requestValidatedJson<SessionPlan>(
    `/api/sessions/${sessionId}/plan`,
    { cache: "no-store" },
    "Failed to load the plan",
    {
      schema: sessionPlanSchema,
    },
  );
}

export async function approveSessionPlan(
  sessionId: string,
  revision: number,
): Promise<{ ok: true; revision: number; implementationPromptId: string; idempotent: boolean }> {
  try {
    return await translatePlanConflict(
      requestValidatedJson(
        `/api/sessions/${sessionId}/plan/approve`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ revision }),
        },
        "Failed to accept the plan",
        { schema: approveSessionPlanResponseSchema },
      ),
    );
  } finally {
    invalidate(apiCacheKeys.sessions());
  }
}

export async function updateSessionPlan(
  sessionId: string,
  revision: number,
  markdown: string,
): Promise<{ ok: true; planApprovalPending: true; revision: number; status: "pending" }> {
  return translatePlanConflict(
    requestValidatedJson(
      `/api/sessions/${sessionId}/plan`,
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ revision, markdown }),
      },
      "Failed to save the plan",
      { schema: updateSessionPlanResponseSchema },
    ),
  );
}

export async function stopSession(id: string): Promise<void> {
  trackApiAction("stop_session", { sessionId: id });
  try {
    await requestVoid(`/api/sessions/${id}/stop`, { method: "POST" }, "Failed to stop session");
    invalidate(apiCacheKeys.sessions());
  } catch (err) {
    // The route returns 409 `{ error: "session_not_stoppable", reason }` for
    // both "non-stoppable phase" and "already stopped (no socket)". Swallow
    // the no-op case so an idempotent stop click doesn't surface a user-
    // visible error toast — mirrors `apps/cli/src/commands/stop.ts`.
    if (err instanceof ApiError && err.status === 409) {
      const body = err.data as { error?: string } | undefined;
      if (body?.error === "session_not_stoppable") return;
    }
    throw err;
  }
}

export async function retrySession(id: string): Promise<void> {
  trackApiAction("retry_session", { sessionId: id });
  // 202 with the cloned prompt on success; every rejection (409
  // `{ error: "session_not_retryable", reason }`, archived, "no terminal
  // prompt") rejects as ApiError for the caller's toast. No swallow branch
  // like stopSession: a rejected retry is not a harmless no-op, so the user
  // should see why it failed.
  await requestVoid(`/api/sessions/${id}/retry`, { method: "POST" }, "Failed to retry session");
  invalidate(apiCacheKeys.sessions());
}

export type WarmSandboxTrigger = "composer_input" | "page_open";

export function warmSandbox(id: string, trigger: WarmSandboxTrigger = "composer_input"): void {
  // Fire-and-forget warm-up; route through requestVoid for the ApiError
  // contract + 45s timeout, but keep the contextual log so failures stay
  // diagnosable.
  const params = new URLSearchParams({ trigger });
  requestVoid(`/api/sessions/${id}/warm?${params}`, { method: "POST" }, "Failed to warm sandbox").catch((error) => {
    if (error instanceof ApiError && error.status === 429) return;
    console.error("[warmSandbox] Failed to warm sandbox for session", id, error);
  });
}

export type PromptEventsResult = {
  events: ActivityEvent[];
  maxSequence: number;
  complete?: boolean;
  nextAfterSequence?: number | null;
  rawEventCount?: number;
};

export type PromptHistoryFetchResult =
  { ok: true; result: PromptEventsResult; rawEvents: RawSessionEvent[] } | { ok: false; error: Error; status?: number };

export type { RawSessionEvent };

const SESSION_REPLAY_PAGE_LIMIT = 1000;
const PROMPT_HISTORY_INITIAL_PAGE_LIMIT = 250;
const sessionHistoryBootstrapSchema = z.object({
  ok: z.literal(true),
  results: z.record(
    z.string(),
    z.object({
      events: z.array(z.any()),
      hasMore: z.boolean(),
    }),
  ),
});

function emptyPromptEventsResult(): PromptEventsResult {
  return {
    events: [],
    maxSequence: 0,
  };
}

export function buildPromptEventsResult(raw: RawSessionEvent[]): PromptEventsResult {
  if (raw.length === 0) return emptyPromptEventsResult();
  const { events: authoritativeEvents, diagnostics } = resolveAuthoritativePromptEventsWithDiagnostics(raw);
  if (diagnostics.mergedDurablePromptActivityCount > 0) {
    console.error("[transcript] merged durable prompt_activity events missing from embedded terminal history", {
      mergedDurablePromptActivityCount: diagnostics.mergedDurablePromptActivityCount,
      durablePromptActivityCount: diagnostics.durablePromptActivityCount,
      embeddedPromptActivityCount: diagnostics.embeddedPromptActivityCount,
      duplicateDurablePromptActivityCount: diagnostics.duplicateDurablePromptActivityCount,
    });
  }
  if (diagnostics.mergedDurableAgentProgressCount > 0) {
    console.error("[transcript] merged durable agent_progress events missing from embedded terminal history", {
      mergedDurableAgentProgressCount: diagnostics.mergedDurableAgentProgressCount,
      durableAgentProgressCount: diagnostics.durableAgentProgressCount,
      embeddedAgentProgressCount: diagnostics.embeddedAgentProgressCount,
      duplicateDurableAgentProgressCount: diagnostics.duplicateDurableAgentProgressCount,
    });
  }
  const events = flattenSessionEvents(authoritativeEvents);
  return {
    events,
    maxSequence: raw.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0),
  };
}

export type PromptEventsProbeResult = PromptEventsResult & {
  rawEvents: RawSessionEvent[];
};

function bucketEventsToPromptResults(
  allEvents: RawSessionEvent[],
  promptIds: string[],
): Map<string, PromptEventsProbeResult> {
  const promptSet = new Set(promptIds);
  const buckets = new Map<string, RawSessionEvent[]>(promptIds.map((promptId) => [promptId, []]));

  for (const event of allEvents) {
    const promptId = getRawSessionEventPromptId(event);
    if (promptId && promptSet.has(promptId)) {
      buckets.get(promptId)?.push(event);
    }
  }

  const results = new Map<string, PromptEventsProbeResult>();
  for (const promptId of promptIds) {
    const rawEvents = buckets.get(promptId) ?? [];
    results.set(promptId, { ...buildPromptEventsResult(rawEvents), rawEvents });
  }
  return results;
}

type SessionHistoryProbeResult =
  | {
      ok: true;
      complete: true;
      rawEventCount: number;
      lastSequence: number | null;
      results: Map<string, PromptEventsProbeResult>;
    }
  | {
      ok: true;
      complete: false;
      rawEventCount: number;
      lastSequence: number | null;
    }
  | { ok: false; error: Error; status?: number };

export async function fetchSessionHistoryProbe(
  sessionId: string,
  promptIds: string[],
  signal?: AbortSignal,
): Promise<SessionHistoryProbeResult> {
  const startedAt = performance.now();
  try {
    const params = new URLSearchParams(promptIds.map((promptId) => ["prompt_id", promptId]));
    const bootstrap = await requestValidatedJson<{
      ok: true;
      results: Record<string, { events: RawSessionEvent[]; hasMore: boolean }>;
    }>(
      `/api/sessions/${sessionId}/events/bootstrap?${params}`,
      { signal },
      `Failed to bootstrap session history for ${sessionId}`,
      { schema: sessionHistoryBootstrapSchema },
    );
    const results = new Map<string, PromptEventsProbeResult>();
    let rawEventCount = 0;
    let lastSequence: number | null = null;
    let complete = true;
    for (const promptId of promptIds) {
      const bucket = bootstrap.results[promptId] ?? { events: [], hasMore: false };
      rawEventCount += bucket.events.length;
      complete = complete && !bucket.hasMore;
      for (const event of bucket.events) lastSequence = Math.max(lastSequence ?? 0, event.sequence ?? 0);
      results.set(promptId, { ...buildPromptEventsResult(bucket.events), rawEvents: bucket.events });
    }
    trackApiAction("session_history_bucketed_probe", {
      sessionId,
      promptCount: promptIds.length,
      rawEventCount,
      complete,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    if (!complete) {
      return {
        ok: true,
        complete: false,
        rawEventCount,
        lastSequence,
      };
    }

    return {
      ok: true,
      complete: true,
      rawEventCount,
      lastSequence,
      results,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const status = err instanceof ApiError ? err.status : undefined;
    console.error("[fetchSessionHistoryProbe] Failed to fetch session history probe", {
      sessionId,
      status,
      error,
    });
    captureApiError(error, {
      operation: "fetchSessionHistoryProbe",
      sessionId,
      ...(status !== undefined ? { status: String(status) } : {}),
    });
    trackApiAction("session_history_bucketed_probe", {
      sessionId,
      promptCount: promptIds.length,
      rawEventCount: 0,
      complete: false,
      ok: false,
      status: status ?? "unknown",
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { ok: false, error, ...(status !== undefined ? { status } : {}) };
  }
}

export async function fetchPromptEvents(
  sessionId: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<PromptHistoryFetchResult> {
  const startedAt = performance.now();
  const rawEvents: RawSessionEvent[] = [];
  let afterSequence = 0;
  try {
    while (true) {
      const page = await fetchPromptEventsPage(
        sessionId,
        promptId,
        { afterSequence: afterSequence > 0 ? afterSequence : undefined },
        signal,
      );
      if (!page.ok) return page;
      rawEvents.push(...page.rawEvents);
      if (!page.result.nextAfterSequence || page.result.nextAfterSequence <= afterSequence) break;
      afterSequence = page.result.nextAfterSequence;
      if (page.result.complete !== false) break;
    }
    const result = { ...buildPromptEventsResult(rawEvents), complete: true, rawEventCount: rawEvents.length };
    trackApiAction("session_prompt_history_hydration", {
      sessionId,
      promptId,
      eventCount: rawEvents.length,
      projectedEventCount: result.events.length,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { ok: true, result, rawEvents };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const status = err instanceof ApiError ? err.status : undefined;
    console.error("[fetchPromptEvents] Failed to fetch prompt history", { sessionId, promptId, status, error });
    captureApiError(error, {
      operation: "fetchPromptEvents",
      sessionId,
      promptId,
      ...(status !== undefined ? { status: String(status) } : {}),
    });
    trackApiAction("session_prompt_history_hydration", {
      sessionId,
      promptId,
      eventCount: 0,
      projectedEventCount: 0,
      ok: false,
      status: status ?? "unknown",
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { ok: false, error, ...(status !== undefined ? { status } : {}) };
  }
}

type PromptEventsPageFetchResult =
  | {
      ok: true;
      result: PromptEventsResult;
      rawEvents: RawSessionEvent[];
    }
  | { ok: false; error: Error; status?: number };

export async function fetchPromptEventsPage(
  sessionId: string,
  promptId: string,
  options: { afterSequence?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<PromptEventsPageFetchResult> {
  const startedAt = performance.now();
  try {
    const defaultLimit =
      options.afterSequence !== undefined && options.afterSequence > 0
        ? SESSION_REPLAY_PAGE_LIMIT
        : PROMPT_HISTORY_INITIAL_PAGE_LIMIT;
    const page = await fetchSessionReplayEventsPage(
      sessionId,
      { promptId, afterSequence: options.afterSequence, limit: options.limit ?? defaultLimit },
      signal,
    );
    const rawEvents = page.events;
    const result = buildPromptEventsResult(rawEvents);
    const hasMore = Boolean(
      page.hasMore && page.lastSequence != null && page.lastSequence > (options.afterSequence ?? 0),
    );
    const nextAfterSequence = hasMore ? (page.lastSequence ?? null) : null;
    const pageResult = {
      ...result,
      complete: !hasMore,
      nextAfterSequence,
      rawEventCount: rawEvents.length,
    };
    trackApiAction("session_prompt_history_page_hydration", {
      sessionId,
      promptId,
      afterSequence: options.afterSequence ?? null,
      nextAfterSequence,
      eventCount: rawEvents.length,
      projectedEventCount: result.events.length,
      hasMore,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { ok: true, result: pageResult, rawEvents };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const status = err instanceof ApiError ? err.status : undefined;
    console.error("[fetchPromptEventsPage] Failed to fetch prompt history page", {
      sessionId,
      promptId,
      status,
      error,
    });
    captureApiError(error, {
      operation: "fetchPromptEventsPage",
      sessionId,
      promptId,
      ...(status !== undefined ? { status: String(status) } : {}),
    });
    trackApiAction("session_prompt_history_page_hydration", {
      sessionId,
      promptId,
      afterSequence: options.afterSequence ?? null,
      eventCount: 0,
      projectedEventCount: 0,
      hasMore: false,
      ok: false,
      status: status ?? "unknown",
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { ok: false, error, ...(status !== undefined ? { status } : {}) };
  }
}

async function fetchSessionReplayEventsPage(
  sessionId: string,
  options: { promptId?: string; afterSequence?: number; limit?: number },
  signal?: AbortSignal,
): Promise<SessionReplayResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? SESSION_REPLAY_PAGE_LIMIT) });
  if (options.promptId) params.set("prompt_id", options.promptId);
  if (options.afterSequence && options.afterSequence > 0) params.set("after_sequence", String(options.afterSequence));

  return requestJson<SessionReplayResponse>(
    `/api/sessions/${sessionId}/events/history?${params.toString()}`,
    { signal },
    `Failed to fetch replay history for ${sessionId}`,
  );
}

export async function respondToQuestion(sessionId: string, answer: string, questionId: string): Promise<void> {
  trackApiAction("respond_to_question", { sessionId, questionId });
  await requestVoid(
    `/api/sessions/${sessionId}/respond`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ answer, questionId }),
    },
    "Failed to send answer",
  );
  invalidate(apiCacheKeys.sessions());
}

export async function setSessionRepo(id: string, repoUrl: string, baseBranch?: string): Promise<void> {
  await requestVoid(
    `/api/sessions/${id}/repo`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ repoUrl, baseBranch }),
    },
    "Failed to set repo",
  );
}

export function getSessionWsUrl(sessionId: string, afterSequence?: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/sessions/${sessionId}/ws`;
  return afterSequence != null ? `${url}?afterSequence=${afterSequence}` : url;
}

export function getSessionDesktopViewerWsUrl(websocketPath: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = websocketPath.startsWith("/") ? websocketPath : `/${websocketPath}`;
  return `${proto}//${window.location.host}${path}`;
}

/**
 * Same-origin URL for the per-business realtime sidebar feed (ARC-1322). One
 * always-on socket per user, independent of any open session detail.
 */
export function getSessionFeedWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/users/me/feed/ws`;
}
