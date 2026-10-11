// Read-only DAO for the cross-session PR inbox (Wave-0 UX overhaul). Aggregates
// the FSM `pr_coordination` record (post-publish lifecycle state) with the
// owning `session_index` row (scope + model/backend/repo/title/source) and the
// latest `session_pr_metadata` row (pr number / draft / head branch). Raw
// prepared statements only; routes -> services -> this DAO. NO writes here (the
// FSM DAO owns every `pr_coordination` write).

import type { PrCoordinationRecord } from "./pr-coordination-db";

/** One inbox row: the full coordination record plus the joined session/PR-metadata fields. */
export interface PrInboxRow {
  /** The FSM coordination record (source of truth for lifecycle state). */
  record: PrCoordinationRecord;
  ownerUserId: number;
  businessId: string | null;
  /** Session title — the closest persisted proxy for the PR title (the live GitHub PR title is not stored). */
  title: string | null;
  model: string | null;
  agentRuntimeBackend: string | null;
  repoOwner: string | null;
  repoName: string | null;
  /** ISO-8601 string (session_index timestamps are TEXT). Sort + cursor key. */
  updatedAt: string;
  /** Raw `callback_context_json` (Slack-source ticket link), or null. Parsed by the service. */
  callbackContextJson: string | null;
  initiationMode: string | null;
  prNumber: number | null;
  /** True/false when known, null when no metadata row was written. */
  prDraft: boolean | null;
  /** The PR head branch (session_pr_metadata.published_branch). */
  headBranch: string | null;
}

/** Raw SQLite row shape for the joined inbox query (snake_case; booleans as 0/1). */
interface PrInboxDbRow {
  // pr_coordination columns
  session_id: string;
  version: number;
  state: string;
  pr_url: string | null;
  head_sha: string | null;
  verdict: string | null;
  verdict_head_sha: string | null;
  verification_run_head: string | null;
  verification_run_id: number;
  verification_child_id: string | null;
  verification_run_count: number;
  ci_fix_rounds: number;
  in_flight_epoch_id: string | null;
  code_changed_since_verification: number;
  prompt_intends_change: number | null;
  merge_ready_reopen_count: number;
  blocked_reason: string | null;
  failure_reason: string | null;
  stop_mode: string | null;
  pre_stop_state: string | null;
  update_branch_queued_at: number | null;
  deadline_at: number | null;
  state_entered_at: number | null;
  // session_index columns
  owner_user_id: number;
  business_id: string | null;
  title: string | null;
  model: string | null;
  agent_runtime_backend: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  updated_at: string;
  callback_context_json: string | null;
  initiation_mode: string | null;
  // session_pr_metadata columns
  pr_number: number | null;
  pr_draft: number | null;
  published_branch: string | null;
}

function rowToPrInboxRow(row: PrInboxDbRow): PrInboxRow {
  const record: PrCoordinationRecord = {
    sessionId: row.session_id,
    version: row.version,
    state: row.state,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    verdict: row.verdict,
    verdictHeadSha: row.verdict_head_sha,
    verificationRunHead: row.verification_run_head,
    verificationRunId: row.verification_run_id,
    verificationChildId: row.verification_child_id,
    verificationRunCount: row.verification_run_count,
    ciFixRounds: row.ci_fix_rounds,
    inFlightEpochId: row.in_flight_epoch_id,
    codeChangedSinceVerification: row.code_changed_since_verification === 1,
    promptIntendsChange: row.prompt_intends_change == null ? null : row.prompt_intends_change === 1,
    mergeReadyReopenCount: row.merge_ready_reopen_count,
    blockedReason: row.blocked_reason,
    failureReason: row.failure_reason,
    stopMode: row.stop_mode,
    preStopState: row.pre_stop_state,
    updateBranchQueuedAt: row.update_branch_queued_at,
    deadlineAt: row.deadline_at,
    stateEnteredAt: row.state_entered_at,
  };
  return {
    record,
    ownerUserId: row.owner_user_id,
    businessId: row.business_id ?? null,
    title: row.title,
    model: row.model,
    agentRuntimeBackend: row.agent_runtime_backend,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    updatedAt: row.updated_at,
    callbackContextJson: row.callback_context_json,
    initiationMode: row.initiation_mode,
    prNumber: row.pr_number,
    prDraft: row.pr_draft == null ? null : row.pr_draft === 1,
    headBranch: row.published_branch,
  };
}

export interface PrInboxCursor {
  updatedAt: string;
  sessionId: string;
}

export function encodePrInboxCursor(row: { updatedAt: string; record: { sessionId: string } }): string {
  return btoa(`${row.updatedAt}|${row.record.sessionId}`);
}

export function decodePrInboxCursor(cursor: string | null | undefined): PrInboxCursor | null {
  if (!cursor) return null;
  try {
    const parts = atob(cursor).split("|");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { updatedAt: parts[0], sessionId: parts[1] };
  } catch {
    return null;
  }
}

export interface ListPrInboxRowsInput {
  /** Owner scope: filter to this user's sessions, or null for no owner filter (admin/all). */
  ownerUserId: string | null;
  /** Optional `owner/name` (lower-cased) repo filter. */
  repoSlug?: string | null;
  /** Lower-cased AND-match terms normalized by the service. */
  searchTerms: readonly string[];
  cursor?: PrInboxCursor | null;
  limit: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * One keyset page of published-PR rows (pr_url present), newest-updated first.
 * Owner-scoped (or unscoped for an admin caller). Bucket derivation + filtering
 * is a pure post-projection step in the service so the taxonomy has one source
 * of truth (`derivePrBucket`) — this DAO only scopes, filters by repo, and pages.
 */
export async function listPrInboxRows(db: D1Database, input: ListPrInboxRowsInput): Promise<PrInboxRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit)));
  const conditions: string[] = ["pc.pr_url IS NOT NULL"];
  const binds: unknown[] = [];

  if (input.ownerUserId) {
    conditions.push("s.owner_user_id = ?");
    binds.push(input.ownerUserId);
  }
  if (input.repoSlug) {
    conditions.push("LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) = ?");
    binds.push(input.repoSlug);
  }
  for (const term of input.searchTerms) {
    const pattern = `%${escapeLike(term)}%`;
    conditions.push(
      `(LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(m.published_branch, '')) LIKE ? ESCAPE '\\'
        OR LOWER(CASE WHEN m.pr_number IS NULL THEN '' ELSE '#' || CAST(m.pr_number AS TEXT) END) LIKE ? ESCAPE '\\')`,
    );
    binds.push(pattern, pattern, pattern, pattern);
  }
  if (input.cursor) {
    conditions.push("(s.updated_at < ? OR (s.updated_at = ? AND pc.session_id < ?))");
    binds.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.sessionId);
  }

  const result = await db
    .prepare(
      `SELECT pc.session_id, pc.version, pc.state, pc.pr_url, pc.head_sha, pc.verdict, pc.verdict_head_sha,
              pc.verification_run_head, pc.verification_run_id, pc.verification_child_id, pc.verification_run_count,
              pc.ci_fix_rounds, pc.in_flight_epoch_id, pc.code_changed_since_verification, pc.prompt_intends_change,
              pc.merge_ready_reopen_count, pc.blocked_reason, pc.failure_reason, pc.stop_mode, pc.pre_stop_state,
              pc.update_branch_queued_at, pc.deadline_at, pc.state_entered_at,
              s.owner_user_id, s.business_id, s.title, s.model, s.agent_runtime_backend, s.repo_owner, s.repo_name,
              s.updated_at, s.callback_context_json, s.initiation_mode,
              m.pr_number, m.pr_draft, m.published_branch
       FROM pr_coordination pc
       INNER JOIN session_index s ON s.session_id = pc.session_id
       LEFT JOIN session_pr_metadata m ON m.session_id = pc.session_id AND m.pr_url = pc.pr_url
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.updated_at DESC, pc.session_id DESC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<PrInboxDbRow>();
  return (result.results ?? []).map(rowToPrInboxRow);
}
