import {
  MAX_CHILD_SESSION_SPAWN_DEPTH,
  MAX_CHILD_SESSIONS_PER_PROMPT,
  MAX_CONCURRENT_CHILD_SESSIONS_PER_USER,
  MAX_TOTAL_CHILD_SESSIONS_PER_SESSION,
  SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
  SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
  SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN,
} from "../../../../shared/constants/session.js";
import type {
  ChildSessionErrorCode,
  ChildSessionLifecycleState,
  ChildSessionSummary,
  CreateChildSessionRequest,
} from "../../../../shared/types/child-session.js";
import type { BusinessRole } from "../auth/business-role.js";
import { InitiationMode } from "../enums/initiation-mode.js";
import { createLogger } from "../logger";
import {
  type ChildSessionRow,
  deleteUnprojectedChildSessionReservation,
  deriveChildSessionFailureReason,
  deriveChildSessionStatus,
  getChildSessionLimitCounts,
  getChildSessionRow,
  getParentSessionRow,
  listChildSessionRows,
  markChildSessionReservationProjected,
  type ParentSessionRow,
  reacquireChildSessionConcurrentReservation,
  releaseChildSessionConcurrentReservation,
  reserveChildSessionLimitCapacity,
} from "../session/child-session-db";
import type { ParentSessionContext } from "../session/db";
import { getSessionView } from "../session/state";
import type { Env, InternalAuthContext } from "../types";
import { verifyRepoAccessAndInstallation } from "./repo-gate";

const log = createLogger({ bindings: { component: "child-session-service" } });

export const CHILD_SESSION_INITIATION_MODE = InitiationMode.CHILD;

interface ChildSessionAuthContext {
  userId: string;
  canAccessAllSessions: boolean;
  businessId?: string | null;
  businessRole?: BusinessRole | null;
}

interface ChildSessionPlan {
  parent: ParentSessionRow;
  parentContext: ParentSessionContext;
  childRepoOwner: string;
  childRepoName: string;
  installationId: number;
  request: CreateChildSessionRequest;
}

type ValidateChildSessionCreationResult =
  { ok: true; plan: ChildSessionPlan } | { ok: false; error: ChildSessionErrorCode };

type ReserveChildSessionCapacityResult = { ok: true } | { ok: false; error: ChildSessionErrorCode };

type ResolvedChildSessionParentPromptId = {
  parentPromptId: string;
  source: "request" | "active_prompt" | "generated_fallback";
};

function repoIdParts(repositoryId: string): { owner: string; name: string } | null {
  const trimmed = repositoryId.trim();
  if (!SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN.test(trimmed)) return null;
  const parts = trimmed.split("/");
  return { owner: parts[0]!, name: parts[1]! };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveChildSessionParentPromptId(args: {
  env: Env;
  parentSessionId: string;
  requestId?: string | null;
  auth: InternalAuthContext;
  requestedParentPromptId?: string | null;
}): Promise<ResolvedChildSessionParentPromptId> {
  const requestedParentPromptId = nonEmptyString(args.requestedParentPromptId);
  if (requestedParentPromptId) return { parentPromptId: requestedParentPromptId, source: "request" };

  const view = await getSessionView(args.env, args.parentSessionId, args.requestId, args.auth).catch((error) => {
    log.warn(
      { parentSessionId: args.parentSessionId, requestId: args.requestId ?? null, error: String(error) },
      "Failed to resolve active parent prompt for child session",
    );
    return null;
  });
  const activePromptId = nonEmptyString(view?.ok && view.payload?.ok ? view.payload.queue.processingPromptId : null);
  if (activePromptId) return { parentPromptId: activePromptId, source: "active_prompt" };

  const parentPromptId = `fallback:${args.parentSessionId}`;
  log.warn(
    {
      parentSessionId: args.parentSessionId,
      requestId: args.requestId ?? null,
      sessionViewStatus: view?.status ?? null,
      sessionViewOk: view?.ok ?? null,
    },
    "Falling back to stable parent_prompt_id bucket for child session",
  );
  return { parentPromptId, source: "generated_fallback" };
}

/**
 * Validate that a parent session is allowed to create a child for the given
 * request. Reads the parent row from session_index for depth + repo context,
 * enforces all hard limits, and re-runs the canonical repo gate against the
 * authenticated user — same path used by user-created sessions.
 */
export async function validateChildSessionCreation(args: {
  env: Env;
  db: D1Database;
  auth: ChildSessionAuthContext;
  parentSessionId: string;
  parentPromptId: string;
  request: CreateChildSessionRequest;
}): Promise<ValidateChildSessionCreationResult> {
  const { env, db, auth, parentSessionId, parentPromptId, request } = args;

  if (!request.prompt?.trim()) {
    return { ok: false, error: { code: "missing_field", message: "prompt is required" } };
  }
  if (request.prompt.trim().length > SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `prompt must not exceed ${SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH} characters`,
      },
    };
  }
  if (!request.repositoryId?.trim()) {
    return { ok: false, error: { code: "missing_field", message: "repositoryId is required" } };
  }
  if (request.title && request.title.trim().length > SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `title must not exceed ${SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH} characters`,
      },
    };
  }

  const parsed = repoIdParts(request.repositoryId);
  if (!parsed) {
    return { ok: false, error: { code: "invalid_repo", message: "repositoryId must be 'owner/repo'" } };
  }

  const parent = await getParentSessionRow(db, parentSessionId);
  if (!parent) {
    return { ok: false, error: { code: "parent_not_found", message: "Parent session not found" } };
  }
  if (!auth.canAccessAllSessions && (auth.businessId ?? null) !== parent.business_id) {
    return { ok: false, error: { code: "parent_not_found", message: "Parent session not found" } };
  }

  if (parent.spawn_depth >= MAX_CHILD_SESSION_SPAWN_DEPTH) {
    return {
      ok: false,
      error: {
        code: "depth_limit_exceeded",
        message: `Child sessions cannot create grandchildren (max depth ${MAX_CHILD_SESSION_SPAWN_DEPTH}).`,
        details: { parentSpawnDepth: parent.spawn_depth, limit: MAX_CHILD_SESSION_SPAWN_DEPTH },
      },
    };
  }

  if (!parent.repo_owner || !parent.repo_name) {
    return {
      ok: false,
      error: {
        code: "invalid_repo",
        message: "Parent session has no repository context; child sessions are only supported for repo sessions.",
      },
    };
  }

  if (parsed.owner !== parent.repo_owner || parsed.name !== parent.repo_name) {
    return {
      ok: false,
      error: {
        code: "cross_repo_not_supported",
        message: "Child sessions must use the same repository as the parent (cross-repo not supported in MVP).",
        details: {
          parentRepo: `${parent.repo_owner}/${parent.repo_name}`,
          requestedRepo: request.repositoryId,
        },
      },
    };
  }

  // Effective user: the parent session's owner. The auth caller can be the
  // user themselves or an elevated internal auth path such as the admin token;
  // either way the child is spawned on behalf of the parent's owner rather
  // than on behalf of the credential used to make the request.
  const effectiveUserId = Number(parent.owner_user_id);
  if (!Number.isFinite(effectiveUserId)) {
    return { ok: false, error: { code: "internal_error", message: "Parent session has invalid owner_user_id" } };
  }

  const gate = await verifyRepoAccessAndInstallation(db, auth, parent.repo_owner, parent.repo_name, {
    githubTokenEnv: env,
    sessionId: parentSessionId,
    reposCacheEnv: env,
  });
  if (!gate.ok) {
    return {
      ok: false,
      error: {
        code: "unauthorized_repo",
        message: "Repo access or installation gating denied this child session.",
      },
    };
  }

  const installationId = gate.installationId;
  const childDepth = parent.spawn_depth + 1;

  log.info(
    {
      parentSessionId,
      parentPromptId,
      userId: auth.userId,
      repoOwner: parent.repo_owner,
      repoName: parent.repo_name,
      childDepth,
    },
    "Child session creation validated",
  );

  return {
    ok: true,
    plan: {
      parent,
      parentContext: {
        parentSessionId,
        parentPromptId,
        spawnedByUserId: effectiveUserId,
        spawnDepth: childDepth,
      },
      childRepoOwner: parent.repo_owner,
      childRepoName: parent.repo_name,
      installationId,
      request,
    },
  };
}

function childSessionLimitError(counts: {
  perPrompt: number;
  perSession: number;
  concurrent: number;
}): ChildSessionErrorCode {
  if (counts.perPrompt >= MAX_CHILD_SESSIONS_PER_PROMPT) {
    return {
      code: "max_children_per_prompt",
      message: `Max child sessions per parent prompt (${MAX_CHILD_SESSIONS_PER_PROMPT}) reached.`,
      details: { current: counts.perPrompt, limit: MAX_CHILD_SESSIONS_PER_PROMPT },
    };
  }
  if (counts.perSession >= MAX_TOTAL_CHILD_SESSIONS_PER_SESSION) {
    return {
      code: "max_children_per_session",
      message: `Max child sessions per parent session (${MAX_TOTAL_CHILD_SESSIONS_PER_SESSION}) reached.`,
      details: { current: counts.perSession, limit: MAX_TOTAL_CHILD_SESSIONS_PER_SESSION },
    };
  }
  return {
    code: "concurrent_limit_exceeded",
    message: `Child session capacity was unavailable; retry if capacity was just released.`,
    details: {
      current: Math.max(counts.concurrent, MAX_CONCURRENT_CHILD_SESSIONS_PER_USER),
      limit: MAX_CONCURRENT_CHILD_SESSIONS_PER_USER,
      observedCounts: counts,
      attribution: "best_effort_after_atomic_rejection",
    },
  };
}

export async function reserveChildSessionCapacity(args: {
  db: D1Database;
  childSessionId: string;
  plan: ChildSessionPlan;
}): Promise<ReserveChildSessionCapacityResult> {
  const { db, childSessionId, plan } = args;
  const reserved = await reserveChildSessionLimitCapacity(db, {
    childSessionId,
    parentSessionId: plan.parent.session_id,
    parentPromptId: plan.parentContext.parentPromptId,
    spawnedByUserId: plan.parentContext.spawnedByUserId,
    maxPerPrompt: MAX_CHILD_SESSIONS_PER_PROMPT,
    maxPerSession: MAX_TOTAL_CHILD_SESSIONS_PER_SESSION,
    maxConcurrent: MAX_CONCURRENT_CHILD_SESSIONS_PER_USER,
    nowMs: Date.now(),
  });
  if (reserved) return { ok: true };

  const counts = await getChildSessionLimitCounts(db, {
    parentSessionId: plan.parent.session_id,
    parentPromptId: plan.parentContext.parentPromptId,
    spawnedByUserId: plan.parentContext.spawnedByUserId,
  });
  return { ok: false, error: childSessionLimitError(counts) };
}

export async function getChildSessionLimitTelemetryCounts(args: {
  db: D1Database;
  parentSessionId: string;
  parentPromptId: string;
  spawnedByUserId: number;
}): Promise<{ perPrompt: number; perSession: number; concurrent: number }> {
  return getChildSessionLimitCounts(args.db, {
    parentSessionId: args.parentSessionId,
    parentPromptId: args.parentPromptId,
    spawnedByUserId: args.spawnedByUserId,
  });
}

export async function markChildSessionCapacityProjected(db: D1Database, childSessionId: string): Promise<void> {
  await markChildSessionReservationProjected(db, childSessionId, Date.now());
}

export async function releaseUnprojectedChildSessionCapacity(db: D1Database, childSessionId: string): Promise<void> {
  await deleteUnprojectedChildSessionReservation(db, childSessionId);
}

export async function releaseChildSessionConcurrency(db: D1Database, childSessionId: string): Promise<void> {
  await releaseChildSessionConcurrentReservation(db, childSessionId, Date.now());
}

export async function reacquireChildSessionConcurrency(db: D1Database, childSessionId: string): Promise<boolean> {
  return reacquireChildSessionConcurrentReservation(db, childSessionId, MAX_CONCURRENT_CHILD_SESSIONS_PER_USER);
}

export function buildChildSessionUrl(frontendUrl: string, childSessionId: string): string {
  return `${frontendUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(childSessionId)}`;
}

export function buildChildSessionSummary(
  row: ChildSessionRow,
  frontendUrl: string,
  prUrl: string | null,
): ChildSessionSummary {
  const status: ChildSessionLifecycleState = deriveChildSessionStatus(row);
  const failureReason = status === "failed" ? deriveChildSessionFailureReason(row) : null;
  const closedAt = row.closed_at ? Date.parse(row.closed_at) : null;
  const createdAt = Date.parse(row.created_at);
  return {
    childSessionId: row.session_id,
    childSessionUrl: buildChildSessionUrl(frontendUrl, row.session_id),
    title: row.title,
    status,
    prUrl,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    completedAt: closedAt && Number.isFinite(closedAt) ? closedAt : null,
    failureReason,
  };
}

export async function listChildSessionSummaries(
  db: D1Database,
  parentSessionId: string,
  parentBusinessId: string | null,
  frontendUrl: string,
  options: { includePrUrl?: boolean },
): Promise<ChildSessionSummary[]> {
  const rows = await listChildSessionRows(db, parentSessionId, parentBusinessId, {
    includePrUrl: options.includePrUrl === true,
  });
  return rows.map((row) =>
    buildChildSessionSummary(row, frontendUrl, typeof row.pr_url === "string" && row.pr_url ? row.pr_url : null),
  );
}

export async function getChildSessionStatusSummary(args: {
  db: D1Database;
  childSessionId: string;
  parentSessionId: string;
  parentBusinessId: string | null;
  frontendUrl: string;
  fetchPrUrl?: (childSessionId: string) => Promise<string | null>;
}): Promise<
  { ok: true; row: ChildSessionRow; summary: ChildSessionSummary } | { ok: false; error: ChildSessionErrorCode }
> {
  const row = await getChildSessionRow(args.db, args.childSessionId);
  if (
    !row ||
    !row.parent_session_id ||
    row.parent_session_id !== args.parentSessionId ||
    row.business_id !== args.parentBusinessId
  ) {
    return { ok: false, error: { code: "not_found", message: "Child session not found" } };
  }
  const prUrl = args.fetchPrUrl ? await args.fetchPrUrl(args.childSessionId) : null;
  return { ok: true, row, summary: buildChildSessionSummary(row, args.frontendUrl, prUrl) };
}
