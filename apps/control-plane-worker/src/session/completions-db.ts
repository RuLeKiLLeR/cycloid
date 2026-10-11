// ---------------------------------------------------------------------------
// D1 write/read: session completion records
// ---------------------------------------------------------------------------

import { resolveRequiredBusinessId } from "./business-id";

const MAX_TEXT_LENGTH = 2000;

type CompletionPrOutcome = "merged" | "closed";
type CompletionCiFirstRunStatus = "success" | "failed" | "pending" | "unknown";

function truncate(text: string | null | undefined, max = MAX_TEXT_LENGTH): string | null {
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export async function insertCompletion(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    ownerUserId: string;
    businessId: string | null;
    repoOwner: string;
    repoName: string;
    promptText: string;
    title: string | null;
    diffSummary: string | null;
    branch: string | null;
    commitSha: string | null;
    success: boolean;
    completedAt: number;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const businessId = await resolveRequiredBusinessId(db, {
    operation: "session_completions insert",
    sessionId: params.sessionId,
    ownerUserId: params.ownerUserId,
    businessId: params.businessId,
  });

  await db
    .prepare(
      `INSERT INTO session_completions
       (id, session_id, prompt_id, owner_user_id, business_id, repo_owner, repo_name, prompt_text, title, diff_summary, intent_summary, branch, commit_sha, success, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, prompt_id) DO NOTHING`,
    )
    .bind(
      id,
      params.sessionId,
      params.promptId,
      params.ownerUserId,
      businessId,
      params.repoOwner,
      params.repoName,
      truncate(params.promptText)!,
      truncate(params.title),
      truncate(params.diffSummary),
      null,
      params.branch,
      params.commitSha,
      params.success ? 1 : 0,
      params.completedAt,
    )
    .run();
}

export async function updateCompletionDiff(
  db: D1Database,
  sessionId: string,
  promptId: string,
  params: {
    diffSummary: string | null;
    branch: string | null;
    commitSha: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE session_completions
       SET diff_summary = COALESCE(?, diff_summary),
           branch = COALESCE(?, branch),
           commit_sha = COALESCE(?, commit_sha)
       WHERE session_id = ? AND prompt_id = ?`,
    )
    .bind(truncate(params.diffSummary), params.branch, params.commitSha, sessionId, promptId)
    .run();
}

export interface CompletionRow {
  id: string;
  session_id: string;
  prompt_id: string;
  owner_user_id: number;
  business_id: string;
  repo_owner: string;
  repo_name: string;
  prompt_text: string;
  title: string | null;
  diff_summary: string | null;
  intent_summary: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_url: string | null;
  pr_draft: number | null;
  pr_outcome: CompletionPrOutcome | null;
  pr_outcome_at: number | null;
  first_pass_passed: number | null;
  review_thread_count: number | null;
  followup_commit_count: number | null;
  ci_first_run_status: CompletionCiFirstRunStatus | null;
  success: number;
  completed_at: number;
  created_at: number;
}

/**
 * Publish path: stamp pr_url + draft onto the completion of the prompt that
 * opened the PR. Scoped by (session_id, prompt_id) like the sibling
 * updateCompletionDiff/updateCompletionOutcomes, so a multi-prompt session that
 * opens different PRs keeps each completion's own pr_url instead of having every
 * row rewritten to the latest PR.
 */
export async function updateCompletionPrUrlForPrompt(
  db: D1Database,
  sessionId: string,
  promptId: string,
  prUrl: string,
  draft: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE session_completions SET pr_url = ?, pr_draft = ? WHERE session_id = ? AND prompt_id = ?`)
    .bind(prUrl, draft ? 1 : 0, sessionId, promptId)
    .run();
}

/**
 * Legacy session-wide fallback for the rare publish with no publishing prompt id
 * in scope. Rewrites every completion row for the session; only safe because a
 * session with no publishing prompt has a single completion. Prefer
 * updateCompletionPrUrlForPrompt whenever the prompt id is available.
 */
export async function updateCompletionPrUrlForSession(
  db: D1Database,
  sessionId: string,
  prUrl: string,
  draft: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE session_completions SET pr_url = ?, pr_draft = ? WHERE session_id = ?`)
    .bind(prUrl, draft ? 1 : 0, sessionId)
    .run();
}

/**
 * Draft-state path: toggle the draft flag for a specific PR url. Scoped by
 * (session_id, pr_url) and does NOT rewrite pr_url, so toggling one PR's draft
 * state cannot clobber another completion's pr_url in a multi-PR session.
 */
export async function updateCompletionDraftForPr(
  db: D1Database,
  sessionId: string,
  prUrl: string,
  draft: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE session_completions SET pr_draft = ? WHERE session_id = ? AND pr_url = ?`)
    .bind(draft ? 1 : 0, sessionId, prUrl)
    .run();
}

export interface CompletionOutcomeUpdate {
  sessionId: string;
  promptId: string;
  prOutcome: CompletionPrOutcome;
  prOutcomeAt: number;
  firstPassPassed: boolean;
  reviewThreadCount: number | null;
  followupCommitCount: number | null;
  ciFirstRunStatus: CompletionCiFirstRunStatus | null;
}

export async function findCompletionsForSessionsPr(
  db: D1Database,
  sessionIds: string[],
  prUrl: string,
): Promise<CompletionRow[]> {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT * FROM session_completions
       WHERE session_id IN (${placeholders}) AND pr_url = ? AND success = 1`,
    )
    .bind(...sessionIds, prUrl)
    .all<CompletionRow>();
  return result.results;
}

export async function updateCompletionOutcomes(db: D1Database, updates: CompletionOutcomeUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const statements = updates.map((update) =>
    db
      .prepare(
        `UPDATE session_completions
         SET pr_outcome = ?,
             pr_outcome_at = ?,
             first_pass_passed = ?,
             review_thread_count = ?,
             followup_commit_count = ?,
             ci_first_run_status = ?
         WHERE session_id = ? AND prompt_id = ?`,
      )
      .bind(
        update.prOutcome,
        update.prOutcomeAt,
        update.firstPassPassed ? 1 : 0,
        update.reviewThreadCount,
        update.followupCommitCount,
        update.ciFirstRunStatus,
        update.sessionId,
        update.promptId,
      ),
  );
  await db.batch(statements);
}
