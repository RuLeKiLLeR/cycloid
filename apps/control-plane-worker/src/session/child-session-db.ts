import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import { QA_TESTER_AGENT_ROLE } from "../../../../shared/agent/constants.js";
import type { ChildSessionLifecycleState } from "../../../../shared/types/child-session.js";
import type { PublishStatus } from "../../../../shared/types/publish.js";
import type { SandboxRuntimeBackend } from "../../../../shared/types/sandbox.js";
import { d1Changed } from "../db/errors";

export interface ParentSessionRow {
  session_id: string;
  owner_user_id: number;
  business_id: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  installation_id: number | null;
  runtime_backend: SandboxRuntimeBackend | null;
  agent_runtime_backend: AgentRuntimeBackend | null;
  spawn_depth: number;
}

export interface ChildSessionRow {
  session_id: string;
  business_id: string | null;
  parent_session_id: string;
  parent_prompt_id: string;
  spawned_by_user_id: number;
  spawn_depth: number;
  title: string | null;
  status: string;
  rich_status: string | null;
  publish_status: PublishStatus | null;
  publish_error: string | null;
  created_at: string;
  closed_at: string | null;
  pr_url?: string | null;
}

interface ChildSessionLimitCounts {
  perPrompt: number;
  perSession: number;
  concurrent: number;
}

const PARENT_LOOKUP_SQL = `SELECT session_id, owner_user_id, business_id, repo_owner, repo_name, installation_id, runtime_backend, agent_runtime_backend, spawn_depth
  FROM session_index WHERE session_id = ? LIMIT 1`;

const CHILD_LOOKUP_SQL = `SELECT session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
    title, status, rich_status, publish_status, publish_error, created_at, closed_at
  FROM session_index WHERE session_id = ? AND parent_session_id IS NOT NULL LIMIT 1`;

const LIST_CHILDREN_SQL = `SELECT session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
    title, status, rich_status, publish_status, publish_error, created_at, closed_at
  FROM session_index
  WHERE parent_session_id = ? AND business_id IS ?
  ORDER BY created_at DESC`;

const LIST_CHILDREN_WITH_PR_URL_SQL = `SELECT session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
    title, status, rich_status, publish_status, publish_error, created_at, closed_at,
    COALESCE(
      (SELECT external_ref FROM session_webhook_refs
       WHERE session_id = session_index.session_id AND source = 'github_pr_url'
       ORDER BY updated_at DESC LIMIT 1),
      (SELECT pr_url FROM session_completions
       WHERE session_id = session_index.session_id AND pr_url IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1)
    ) AS pr_url
  FROM session_index
  WHERE parent_session_id = ? AND business_id IS ?
  ORDER BY created_at DESC`;

const RESERVE_CHILD_SESSION_LIMIT_SQL = `INSERT INTO child_session_limit_reservations (
    child_session_id, parent_session_id, parent_prompt_id, spawned_by_user_id, created_at
  )
  SELECT ?, ?, ?, ?, ?
  WHERE
    (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE parent_session_id = ? AND parent_prompt_id = ?) < ?
    AND (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE parent_session_id = ?) < ?
    AND (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE spawned_by_user_id = ? AND concurrent_released_at IS NULL) < ?`;

const LIMIT_COUNTS_SQL = `SELECT
    (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE parent_session_id = ? AND parent_prompt_id = ?) AS perPrompt,
    (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE parent_session_id = ?) AS perSession,
    (SELECT COUNT(*) FROM child_session_limit_reservations
      WHERE spawned_by_user_id = ? AND concurrent_released_at IS NULL) AS concurrent`;

export async function getParentSessionRow(db: D1Database, sessionId: string): Promise<ParentSessionRow | null> {
  const row = await db.prepare(PARENT_LOOKUP_SQL).bind(sessionId).first<ParentSessionRow>();
  return row ?? null;
}

export async function getChildSessionRow(db: D1Database, sessionId: string): Promise<ChildSessionRow | null> {
  const row = await db.prepare(CHILD_LOOKUP_SQL).bind(sessionId).first<ChildSessionRow>();
  return row ?? null;
}

export async function listChildSessionRows(
  db: D1Database,
  parentSessionId: string,
  parentBusinessId: string | null,
  options: { includePrUrl: boolean },
): Promise<ChildSessionRow[]> {
  const sql = options.includePrUrl ? LIST_CHILDREN_WITH_PR_URL_SQL : LIST_CHILDREN_SQL;
  const result = await db.prepare(sql).bind(parentSessionId, parentBusinessId).all<ChildSessionRow>();
  return result.results ?? [];
}

export async function reserveChildSessionLimitCapacity(
  db: D1Database,
  args: {
    childSessionId: string;
    parentSessionId: string;
    parentPromptId: string;
    spawnedByUserId: number;
    maxPerPrompt: number;
    maxPerSession: number;
    maxConcurrent: number;
    nowMs: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(RESERVE_CHILD_SESSION_LIMIT_SQL)
    .bind(
      args.childSessionId,
      args.parentSessionId,
      args.parentPromptId,
      args.spawnedByUserId,
      args.nowMs,
      args.parentSessionId,
      args.parentPromptId,
      args.maxPerPrompt,
      args.parentSessionId,
      args.maxPerSession,
      args.spawnedByUserId,
      args.maxConcurrent,
    )
    .run();
  return d1Changed(result);
}

export async function getChildSessionLimitCounts(
  db: D1Database,
  args: { parentSessionId: string; parentPromptId: string; spawnedByUserId: number },
): Promise<ChildSessionLimitCounts> {
  const row = await db
    .prepare(LIMIT_COUNTS_SQL)
    .bind(args.parentSessionId, args.parentPromptId, args.parentSessionId, args.spawnedByUserId)
    .first<ChildSessionLimitCounts>();
  return {
    perPrompt: row?.perPrompt ?? 0,
    perSession: row?.perSession ?? 0,
    concurrent: row?.concurrent ?? 0,
  };
}

export async function markChildSessionReservationProjected(
  db: D1Database,
  childSessionId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE child_session_limit_reservations
       SET projected_at = COALESCE(projected_at, ?)
       WHERE child_session_id = ?`,
    )
    .bind(nowMs, childSessionId)
    .run();
  return d1Changed(result);
}

export async function deleteUnprojectedChildSessionReservation(
  db: D1Database,
  childSessionId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM child_session_limit_reservations WHERE child_session_id = ? AND projected_at IS NULL")
    .bind(childSessionId)
    .run();
  return d1Changed(result);
}

export async function releaseChildSessionConcurrentReservation(
  db: D1Database,
  childSessionId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE child_session_limit_reservations
       SET concurrent_released_at = COALESCE(concurrent_released_at, ?)
       WHERE child_session_id = ?`,
    )
    .bind(nowMs, childSessionId)
    .run();
  return d1Changed(result);
}

export async function reacquireChildSessionConcurrentReservation(
  db: D1Database,
  childSessionId: string,
  maxConcurrent: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE child_session_limit_reservations
       SET concurrent_released_at = NULL
       WHERE child_session_id = ?
         AND concurrent_released_at IS NOT NULL
         AND (SELECT COUNT(*) FROM child_session_limit_reservations
           WHERE spawned_by_user_id = child_session_limit_reservations.spawned_by_user_id
             AND concurrent_released_at IS NULL) < ?`,
    )
    .bind(childSessionId, maxConcurrent)
    .run();
  return d1Changed(result);
}

export const CHILD_SESSION_IDS_FOR_PARENT_SQL =
  "SELECT session_id FROM session_index WHERE parent_session_id = ? AND business_id IS ? ORDER BY created_at DESC";

export const QA_CHILD_SESSION_ID_FOR_PARENT_SQL = `SELECT session_id FROM session_index
  WHERE parent_session_id = ? AND business_id IS ? AND agent_role = ?
    AND COALESCE(
      (SELECT external_ref FROM session_webhook_refs
       WHERE session_id = session_index.session_id AND source = 'github_pr_url'
       ORDER BY updated_at DESC LIMIT 1),
      target_pr_url
    ) = ?
  ORDER BY created_at DESC LIMIT 1`;

export async function getChildSessionIdsForParent(
  db: D1Database,
  parentSessionId: string,
  parentBusinessId: string | null,
): Promise<string[]> {
  const result = await db
    .prepare(CHILD_SESSION_IDS_FOR_PARENT_SQL)
    .bind(parentSessionId, parentBusinessId)
    .all<{ session_id: string }>();
  return (result.results ?? []).map((row) => row.session_id);
}

/**
 * Batches the child-row lookup (is *this* session a child?) and the
 * children-of-this-session id list plus QA child id into a single D1 round-trip.
 * The session view route needs these to render Parent/Children badges and the
 * QA link; running them via `db.batch()` avoids the separate network hops `Promise.all` would make
 * (see docs/database.md). Returns `null`/`[]` on a partial failure path is not
 * applicable here: a batch failure rejects as a whole, so the caller keeps the
 * existing best-effort `.catch()` fallback.
 */
export async function getChildContextForSession(
  db: D1Database,
  sessionId: string,
  sessionBusinessId: string | null,
  parentPrUrl: string | null = null,
): Promise<{ childRow: ChildSessionRow | null; childIds: string[]; qaChildSessionId: string | null }> {
  const [childResult, childIdsResult, qaChildResult] = await db.batch([
    db.prepare(CHILD_LOOKUP_SQL).bind(sessionId),
    db.prepare(CHILD_SESSION_IDS_FOR_PARENT_SQL).bind(sessionId, sessionBusinessId),
    db
      .prepare(QA_CHILD_SESSION_ID_FOR_PARENT_SQL)
      .bind(sessionId, sessionBusinessId, QA_TESTER_AGENT_ROLE, parentPrUrl),
  ]);
  const childRow = ((childResult.results as ChildSessionRow[] | undefined)?.[0] ?? null) || null;
  const childIds = ((childIdsResult.results as { session_id: string }[] | undefined) ?? []).map(
    (row) => row.session_id,
  );
  const qaChildSessionId =
    ((qaChildResult.results as { session_id: string }[] | undefined)?.[0]?.session_id ?? null) || null;
  return { childRow, childIds, qaChildSessionId };
}

export function deriveChildSessionStatus(row: ChildSessionRow): ChildSessionLifecycleState {
  // After the phase-flip, `rich_status` carries `Phase` strings: "failed",
  // "stopped", "completed", "superseded", "blocked", "idle", "running", "waiting_for_input",
  // "finalizing", "review_listening", "archived". User-stop and resumable-stop
  // both project to `stopped`; the substate ("user" vs "resumable") is not
  // persisted on the child-session row, so both surface here as canceled from
  // the parent's view. `blocked` is a verification-failure terminal and
  // surfaces as `failed`.
  if (row.status === "archived") {
    if (row.rich_status === "failed" || row.rich_status === "blocked") return "failed";
    if (row.rich_status === "stopped") return "canceled";
    // Pre-flip legacy rows persisted "canceled" directly; preserve the parent
    // view for permanent (never re-projected) archived rows.
    if (row.rich_status === "canceled") return "canceled";
    return row.closed_at ? "completed" : "canceled";
  }
  const phase = row.rich_status?.toLowerCase() ?? null;
  if (phase === "failed" || phase === "blocked") return "failed";
  if (phase === "stopped") return "canceled";
  // `superseded` is a benign terminal phase (review-loop publish skipped because the PR/session
  // moved on) — it settles the child as `completed` from the parent's view, never alive. Without
  // this, the new terminal phase falls through to `running` and parent automation waiting on
  // TERMINAL_CHILD_STATUSES would never converge.
  if (phase === "completed" || phase === "superseded") return "completed";
  // Active phases (idle / running / waiting_for_input / finalizing / review_listening / null) are
  // alive from the parent agent's perspective.
  return "running";
}

/**
 * Derive a meaningful failure-reason string for a child session whose
 * `deriveChildSessionStatus` resolved to `failed`. The phase column itself
 * (`row.rich_status === "failed" | "blocked"`) carries no information beyond
 * the terminal bucket, so prefer the persisted `publish_error` text and fall
 * back to a coarse classifier so the parent agent can distinguish a hard
 * publish failure from a verification block without re-fetching session view.
 */
export function deriveChildSessionFailureReason(row: ChildSessionRow): string {
  if (row.publish_error && row.publish_error.trim().length > 0) {
    return row.publish_error;
  }
  // Match the case-insensitive `rich_status` handling in
  // `deriveChildSessionStatus` so a row whose status was bucketed as "failed"
  // via `"Blocked"` doesn't fall through to the publish-phase classifier here.
  // The `blocked` rich_status is produced by the FSM `NEEDS_YOU` projection; the
  // legacy pre-publish block publish status that also fed this bucket was deleted
  // in ARC-1330 D-57. The raw-string comparison below is stored-rows compat (see
  // `computePhase`): pre-existing rows still persist the deleted literal.
  const phase = row.rich_status?.toLowerCase() ?? null;
  if (phase === "blocked" || (row.publish_status as string | null) === "blocked_by_verification") {
    return "verification_failed";
  }
  // Only call it a publish failure when publish was actually attempted and
  // failed. Sessions that terminate before reaching publish (publish_status
  // null / not_started / publishing / skipped) get a distinct generic reason
  // so the parent agent doesn't drive retry logic off a misleading bucket.
  if (row.publish_status === "failed") return "publish_failed";
  return "session_failed";
}
