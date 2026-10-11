import { computeSha256Hex } from "../crypto";
import { d1Changed } from "../db/errors";

export type ReviewLoopOperationKind = "push" | "reply" | "summary_comment";
export type ReviewLoopReplyOperationKind = "review_comment_reply" | "issue_comment_reply";
export type ReviewLoopOperationStatus = "running" | "succeeded" | "failed";
export type ReviewLoopReplyVerdict = "fixed" | "replied" | "declined";

export interface ReviewLoopOperation {
  operationId: string;
  epochId: string;
  sessionId: string;
  promptId: string | null;
  kind: ReviewLoopOperationKind;
  targetSourceId: string | null;
  headSha: string;
  status: ReviewLoopOperationStatus;
  attempts: number;
  githubId: string | null;
  lastError: string | null;
  verdict: ReviewLoopReplyVerdict | null;
  verdictBasis: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReviewLoopOperationRow {
  operation_id: string;
  epoch_id: string;
  session_id: string;
  prompt_id: string | null;
  kind: ReviewLoopOperationKind;
  target_source_id: string | null;
  head_sha: string;
  status: ReviewLoopOperationStatus;
  attempts: number;
  github_id: string | null;
  last_error: string | null;
  verdict: ReviewLoopReplyVerdict | null;
  verdict_basis: string | null;
  created_at: number;
  updated_at: number;
}

export type BeginReviewLoopOperationAttemptResult =
  | { status: "started"; operation: ReviewLoopOperation }
  | { status: "already_succeeded"; operation: ReviewLoopOperation }
  | { status: "attempts_exhausted"; operation: ReviewLoopOperation }
  | { status: "conflict"; operation: ReviewLoopOperation };

// Lease window for an in-flight `running` attempt. While a prior attempt's `updated_at` is within
// this window, a second `beginReviewLoopOperationAttempt` for the same (deterministic) operationId
// is treated as a conflict so the GitHub side effect is NOT re-run. The bridge dynamic tool times
// out at REVIEW_LOOP_TOOL_TIMEOUT_MS=10s, so this is set comfortably above that to cover a
// crashed/evicted attempt that touched GitHub but never reached markReviewLoopOperationSucceeded.
// The lease only governs idempotent kinds (see below): once it elapses, an idempotent `running`
// attempt is presumed dead and (still under the attempts cap) may be recovered as a fresh attempt.
export const REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS = 120_000;

// Non-idempotent operation kinds POST a brand-new, user-visible GitHub comment on every attempt
// (a review-comment reply, an issue-comment reply, or a PR summary comment). If a worker POSTed the
// comment but crashed before markReviewLoopOperationSucceeded, the row stays `running` with no
// github_id. Auto-restarting such a row would re-run the POST and double-post the comment, so a
// `running` row for these kinds ALWAYS returns `conflict` regardless of lease age — it is never
// silently recovered. The genuinely-stuck case is bounded by the epoch-level reclaim + attempt cap
// (the epoch's own lease/attempt-cap eventually blocks it), so this does not loop forever.
//
// `push` is intentionally excluded: its side effect is verifyRemoteBranch, a read-only check of the
// remote head SHA (the actual git push already happened in the sandbox), so re-running it produces
// no duplicate user-visible side effect and a stale `running` push may be safely recovered.
const NON_IDEMPOTENT_OPERATION_KINDS: ReadonlySet<ReviewLoopOperationKind> = new Set(["reply", "summary_comment"]);

export function isReviewLoopReplyVerdict(value: unknown): value is ReviewLoopReplyVerdict {
  return value === "fixed" || value === "replied" || value === "declined";
}

function rowToOperation(row: ReviewLoopOperationRow): ReviewLoopOperation {
  return {
    operationId: row.operation_id,
    epochId: row.epoch_id,
    sessionId: row.session_id,
    promptId: row.prompt_id,
    kind: row.kind,
    targetSourceId: row.target_source_id,
    headSha: row.head_sha,
    status: row.status,
    attempts: row.attempts,
    githubId: row.github_id,
    lastError: row.last_error,
    verdict: row.verdict ?? null,
    verdictBasis: row.verdict_basis ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeOperationVerdict(input: {
  kind: ReviewLoopOperationKind;
  verdict?: ReviewLoopReplyVerdict | null;
  verdictBasis?: string | null;
}): { verdict: ReviewLoopReplyVerdict | null; verdictBasis: string | null } {
  if (input.kind !== "reply") return { verdict: null, verdictBasis: null };
  const verdict = input.verdict ?? null;
  const verdictBasis = verdict === "declined" ? input.verdictBasis?.trim() || null : null;
  return { verdict, verdictBasis };
}

function canonicalPayload(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

export async function buildReviewLoopPushOperationId(input: {
  epochId: string;
  headSha: string;
  worklistHash: string;
  diffHash: string;
}): Promise<string> {
  const hash = await computeSha256Hex(
    canonicalPayload({
      diff_hash: input.diffHash,
      epoch_id: input.epochId,
      head_sha: input.headSha,
      kind: "push",
      worklist_hash: input.worklistHash,
    }),
  );
  return `review-loop:push:${hash}`;
}

export async function buildReviewLoopReplyOperationId(input: {
  epochId: string;
  headSha: string;
  targetSourceId: string;
  opKind: ReviewLoopReplyOperationKind;
}): Promise<string> {
  const hash = await computeSha256Hex(
    canonicalPayload({
      epoch_id: input.epochId,
      head_sha: input.headSha,
      kind: input.opKind,
      target_source_id: input.targetSourceId,
    }),
  );
  return `review-loop:${input.opKind}:${hash}`;
}

export async function buildReviewLoopSummaryCommentOperationId(input: {
  epochId: string;
  headSha: string;
}): Promise<string> {
  const hash = await computeSha256Hex(
    canonicalPayload({
      epoch_id: input.epochId,
      head_sha: input.headSha,
      kind: "summary_comment",
    }),
  );
  return `review-loop:summary_comment:${hash}`;
}

export async function getReviewLoopOperationById(
  db: D1Database,
  operationId: string,
): Promise<ReviewLoopOperation | null> {
  const row = await db
    .prepare(`SELECT * FROM pr_review_response_operations WHERE operation_id = ? LIMIT 1`)
    .bind(operationId)
    .first<ReviewLoopOperationRow>();
  return row ? rowToOperation(row) : null;
}

/**
 * The SHA the agent's most-recent SUCCEEDED push for this epoch advanced the PR head to. A push
 * operation records the verified remote head (verifyRemoteBranch) as its github_id, so this is the
 * authoritative "epoch's own pushed head" — the only non-epoch.headSha value the review-loop head
 * guard may accept (a self-advance the agent just produced, not a third-party head change). Returns
 * null when the epoch has no succeeded push, so the guard then accepts only epoch.headSha.
 */
export async function selectLatestSucceededReviewLoopPushHead(db: D1Database, epochId: string): Promise<string | null> {
  const row = await db
    .prepare(
      // updated_at is millisecond Date.now(), so two pushes that succeed in the same ms would tie;
      // break the tie by rowid DESC (insertion order) so the most-recently-recorded push wins
      // deterministically — otherwise SQLite could return the older github_id and the head guard
      // would falsely reject a legitimate self-advance.
      `SELECT github_id FROM pr_review_response_operations
       WHERE epoch_id = ? AND kind = 'push' AND status = 'succeeded' AND github_id IS NOT NULL
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(epochId)
    .first<{ github_id: string }>();
  return row?.github_id ?? null;
}

/**
 * Whether ANY of this session's epochs on this PR RECENTLY recorded a succeeded push whose
 * verified/reported remote head (`github_id`) is exactly `headSha`. This is the own-push proof the
 * head-change reconciler consults before stale-blocking: a `synchronize` advance to a head we
 * ourselves recorded pushing (guarded publish push, or the sandbox `cycloid.git_sync` record) is the
 * session's own fix landing, not a foreign push — pending review work must carry forward, not die as
 * `head_changed`. Exact-SHA match keeps it fail-closed (mirrors the ARC-1302 queued-marker proof
 * philosophy), and `recordedAfterMs` bounds the proof to the freshness of a real self-push (the
 * webhook lands seconds after the record): without it, a FOREIGN force-push/reset back to any head
 * this session ever pushed (every former fix tip stays recorded forever) would read as an own advance
 * and carry epochs forward across a reverted branch.
 */
/**
 * Refresh a succeeded operation's `updated_at` to `nowMs`. Used when a repeat `git_sync` record for
 * the SAME pushed head hits the idempotent `already_succeeded` path: the head-change own-push proof
 * only trusts records inside its recency window, so a push retried after the window (record persists
 * from the first attempt) would otherwise stale-block the agent's own successful push. No-op unless
 * the row is still `succeeded`.
 */
export async function touchSucceededReviewLoopOperation(
  db: D1Database,
  operationId: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(`UPDATE pr_review_response_operations SET updated_at = ? WHERE operation_id = ? AND status = 'succeeded'`)
    .bind(nowMs, operationId)
    .run();
}

export async function hasSucceededReviewLoopPushToHead(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string; recordedAfterMs: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM pr_review_response_operations ops
         JOIN pr_review_response_epochs epochs ON epochs.id = ops.epoch_id
        WHERE ops.session_id = ? AND ops.kind = 'push' AND ops.status = 'succeeded' AND ops.github_id = ?
          AND ops.updated_at >= ?
          AND epochs.pr_url = ?
        LIMIT 1`,
    )
    .bind(input.sessionId, input.headSha, input.recordedAfterMs, input.prUrl)
    .first<{ hit: number }>();
  return row?.hit === 1;
}

/**
 * Whether ANY of this session's epochs on this PR already posted a succeeded reply targeting
 * `targetSourceId`. Durable cross-epoch/cross-head dedup for once-per-thread guarantees (the per-op
 * idempotency key includes epoch id + head, so a re-armed epoch or a carried-forward head would
 * otherwise mint a fresh op-id and re-post).
 */
export async function hasSucceededReviewLoopReplyToTarget(
  db: D1Database,
  input: { sessionId: string; prUrl: string; targetSourceId: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM pr_review_response_operations ops
         JOIN pr_review_response_epochs epochs ON epochs.id = ops.epoch_id
        WHERE ops.session_id = ? AND ops.kind = 'reply' AND ops.status = 'succeeded' AND ops.target_source_id = ?
          AND epochs.pr_url = ?
        LIMIT 1`,
    )
    .bind(input.sessionId, input.targetSourceId, input.prUrl)
    .first<{ hit: number }>();
  return row?.hit === 1;
}

export async function countSucceededReviewLoopOperations(db: D1Database, epochId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM pr_review_response_operations
       WHERE epoch_id = ? AND status = 'succeeded'`,
    )
    .bind(epochId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface SucceededReviewLoopReplyOperation {
  operationId: string;
  targetSourceId: string;
  verdict: ReviewLoopReplyVerdict | null;
  verdictBasis: string | null;
}

export async function listSucceededReviewLoopReplyOperations(
  db: D1Database,
  epochId: string,
): Promise<SucceededReviewLoopReplyOperation[]> {
  const result = await db
    .prepare(
      `SELECT operation_id, target_source_id, verdict, verdict_basis
       FROM pr_review_response_operations
       WHERE epoch_id = ? AND kind = 'reply' AND status = 'succeeded' AND target_source_id IS NOT NULL
       ORDER BY updated_at ASC, rowid ASC`,
    )
    .bind(epochId)
    .all<{
      operation_id: string;
      target_source_id: string;
      verdict: ReviewLoopReplyVerdict | null;
      verdict_basis: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    operationId: row.operation_id,
    targetSourceId: row.target_source_id,
    verdict: row.verdict ?? null,
    verdictBasis: row.verdict_basis ?? null,
  }));
}

async function insertReviewLoopOperationAttempt(
  db: D1Database,
  input: {
    operationId: string;
    epochId: string;
    sessionId: string;
    promptId?: string | null;
    kind: ReviewLoopOperationKind;
    targetSourceId?: string | null;
    headSha: string;
    verdict?: ReviewLoopReplyVerdict | null;
    verdictBasis?: string | null;
    nowMs: number;
  },
): Promise<ReviewLoopOperation> {
  const { verdict, verdictBasis } = normalizeOperationVerdict(input);
  await db
    .prepare(
      `INSERT INTO pr_review_response_operations (
        operation_id, epoch_id, session_id, prompt_id, kind, target_source_id, head_sha,
        status, attempts, verdict, verdict_basis, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?)`,
    )
    .bind(
      input.operationId,
      input.epochId,
      input.sessionId,
      input.promptId ?? null,
      input.kind,
      input.targetSourceId ?? null,
      input.headSha,
      verdict,
      verdictBasis,
      input.nowMs,
      input.nowMs,
    )
    .run();
  const operation = await getReviewLoopOperationById(db, input.operationId);
  if (!operation) throw new Error("Review-loop operation insert did not persist");
  return operation;
}

export async function beginReviewLoopOperationAttempt(
  db: D1Database,
  input: {
    operationId: string;
    epochId: string;
    sessionId: string;
    promptId?: string | null;
    kind: ReviewLoopOperationKind;
    targetSourceId?: string | null;
    headSha: string;
    verdict?: ReviewLoopReplyVerdict | null;
    verdictBasis?: string | null;
    maxAttempts: number;
    nowMs: number;
  },
): Promise<BeginReviewLoopOperationAttemptResult> {
  const existing = await getReviewLoopOperationById(db, input.operationId);
  if (!existing) {
    try {
      return { status: "started", operation: await insertReviewLoopOperationAttempt(db, input) };
    } catch (error) {
      const raced = await getReviewLoopOperationById(db, input.operationId);
      if (!raced) throw error;
      if (raced.status === "succeeded") return { status: "already_succeeded", operation: raced };
      if (raced.attempts >= input.maxAttempts) return { status: "attempts_exhausted", operation: raced };
      return { status: "conflict", operation: raced };
    }
  }

  const current = (await getReviewLoopOperationById(db, input.operationId)) ?? existing;
  if (current.status === "succeeded") return { status: "already_succeeded", operation: current };
  if (current.status === "running") {
    // Non-idempotent kinds (reply / summary_comment) never auto-restart from `running`: a fresh
    // attempt would re-run the GitHub POST and double-post the comment if the prior worker crashed
    // after POSTing. They stay `conflict` regardless of lease age; recovery is via the epoch-level
    // reclaim + attempt cap, not here.
    if (NON_IDEMPOTENT_OPERATION_KINDS.has(input.kind)) {
      return { status: "conflict", operation: current };
    }
    // Idempotent kinds (push): an in-flight attempt within the lease window is a conflict; one older
    // than the lease is presumed crashed/evicted and may be recovered below (subject to the cap).
    if (input.nowMs - current.updatedAt < REVIEW_LOOP_OPERATION_RUNNING_LEASE_MS) {
      return { status: "conflict", operation: current };
    }
  }
  if (current.attempts >= input.maxAttempts) return { status: "attempts_exhausted", operation: current };

  const { verdict, verdictBasis } = normalizeOperationVerdict(input);
  const result = await db
    .prepare(
      `UPDATE pr_review_response_operations
       SET status = 'running', attempts = attempts + 1, prompt_id = ?, last_error = NULL,
           verdict = ?, verdict_basis = ?, updated_at = ?
       WHERE operation_id = ? AND status != 'succeeded' AND attempts = ?`,
    )
    .bind(input.promptId ?? null, verdict, verdictBasis, input.nowMs, input.operationId, current.attempts)
    .run();
  if (!d1Changed(result)) {
    const raced = await getReviewLoopOperationById(db, input.operationId);
    if (raced?.status === "succeeded") return { status: "already_succeeded", operation: raced };
    if (raced && raced.attempts >= input.maxAttempts) return { status: "attempts_exhausted", operation: raced };
    if (raced) return { status: "conflict", operation: raced };
  }

  const operation = await getReviewLoopOperationById(db, input.operationId);
  if (!operation) throw new Error("Review-loop operation disappeared during attempt start");
  return { status: "started", operation };
}

export async function markReviewLoopOperationSucceeded(
  db: D1Database,
  operationId: string,
  options: { githubId?: string | null; nowMs: number; expectedAttempts?: number },
): Promise<ReviewLoopOperation | null> {
  // Bind the write to THIS running attempt when the caller knows its attempt number. A recovered
  // (idempotent push) attempt N+1 can start after a late attempt-N finishes, so without the guard
  // attempt N's success could clobber the in-flight N+1 row and overwrite github_id with a stale
  // verified head. Omitting expectedAttempts preserves the unconditional write for callers that
  // cannot race (kept for backward compatibility).
  if (options.expectedAttempts !== undefined) {
    await db
      .prepare(
        `UPDATE pr_review_response_operations
         SET status = 'succeeded', github_id = COALESCE(?, github_id), last_error = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'running' AND attempts = ?`,
      )
      .bind(options.githubId ?? null, options.nowMs, operationId, options.expectedAttempts)
      .run();
    return getReviewLoopOperationById(db, operationId);
  }
  await db
    .prepare(
      `UPDATE pr_review_response_operations
       SET status = 'succeeded', github_id = COALESCE(?, github_id), last_error = NULL, updated_at = ?
       WHERE operation_id = ?`,
    )
    .bind(options.githubId ?? null, options.nowMs, operationId)
    .run();
  return getReviewLoopOperationById(db, operationId);
}

export async function fillSucceededReviewLoopReplyVerdict(
  db: D1Database,
  operationId: string,
  options: { verdict: ReviewLoopReplyVerdict; verdictBasis?: string | null; nowMs: number },
): Promise<ReviewLoopOperation | null> {
  const verdictBasis = options.verdict === "declined" ? options.verdictBasis?.trim() || null : null;
  await db
    .prepare(
      `UPDATE pr_review_response_operations
       SET verdict = ?,
           verdict_basis = ?,
           updated_at = ?
       WHERE operation_id = ? AND kind = 'reply' AND status = 'succeeded' AND verdict IS NULL`,
    )
    .bind(options.verdict, verdictBasis, options.nowMs, operationId)
    .run();
  return getReviewLoopOperationById(db, operationId);
}

/**
 * Returns which of the given GitHub review-comment ids were created by a review-loop threaded
 * reply operation. Replies are posted with the user's credentials, so GitHub wraps each one in
 * an implicit empty-body review authored by that user — login-based self-trigger guards cannot
 * identify them, but the stored github_id can.
 *
 * Scoped to `target_source_id LIKE 'review-comment:%'`: only threaded review-comment replies
 * create implicit reviews. Issue-comment replies (`issue-comment:` / `review-body:` targets)
 * store ids from GitHub's separate issue-comment id namespace, and matching those here could
 * suppress a genuine human review whose comment id numerically collides.
 */
export async function selectReviewLoopReplyGithubIds(db: D1Database, githubIds: string[]): Promise<Set<string>> {
  if (githubIds.length === 0) return new Set();
  const placeholders = githubIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT github_id FROM pr_review_response_operations
       WHERE kind = 'reply' AND target_source_id LIKE 'review-comment:%' AND github_id IN (${placeholders})`,
    )
    .bind(...githubIds)
    .all<{ github_id: string }>();
  return new Set((result.results ?? []).map((row) => row.github_id));
}

/**
 * Every GitHub review-comment id THIS session posted as a review-loop threaded reply. The polled
 * worklist builder (getPrReviewLoopWorklist) surfaces EVERY comment on a human-triggered thread —
 * including Cycloid's own guarded-decline replies — so without fencing these out the loop re-ingests
 * its own reply as fresh reviewer feedback and answers it again every sweep (the PR #7119 100x
 * self-reply loop). Session-scoped (one review-loop PR per session) so a single read fences the whole
 * worklist; the webhook self-trigger guard keys off a candidate id list instead (selectReviewLoopReply-
 * GithubIds) because it has no session to scope to. Mirrors that query's `review-comment:` scoping so
 * an issue-comment reply's colliding id in GitHub's separate namespace can't suppress a real review.
 */
export async function listReviewLoopReplyGithubIdsForSession(db: D1Database, sessionId: string): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT github_id FROM pr_review_response_operations
       WHERE session_id = ? AND kind = 'reply' AND target_source_id LIKE 'review-comment:%' AND github_id IS NOT NULL`,
    )
    .bind(sessionId)
    .all<{ github_id: string }>();
  return new Set((result.results ?? []).map((row) => row.github_id));
}

export async function selectReviewLoopIssueCommentReplyGithubIds(
  db: D1Database,
  githubIds: string[],
): Promise<Set<string>> {
  if (githubIds.length === 0) return new Set();
  const placeholders = githubIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT github_id FROM pr_review_response_operations
       WHERE kind = 'reply'
         AND (target_source_id LIKE 'issue-comment:%' OR target_source_id LIKE 'review-body:%')
         AND github_id IN (${placeholders})`,
    )
    .bind(...githubIds)
    .all<{ github_id: string }>();
  return new Set((result.results ?? []).map((row) => row.github_id));
}

export async function markReviewLoopOperationFailed(
  db: D1Database,
  operationId: string,
  options: { error: string; nowMs: number; expectedAttempts?: number },
): Promise<ReviewLoopOperation | null> {
  // Only transition a row that is still THIS attempt's running row. Gating on status alone is
  // insufficient: a retry sets the row back to 'running' with a bumped attempts, so a late
  // attempt-N failure could clobber the in-flight attempt N+1. When the caller knows its attempt
  // number, require attempts to still match so a stale attempt's failure no-ops.
  if (options.expectedAttempts !== undefined) {
    await db
      .prepare(
        `UPDATE pr_review_response_operations
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'running' AND attempts = ?`,
      )
      .bind(options.error, options.nowMs, operationId, options.expectedAttempts)
      .run();
    return getReviewLoopOperationById(db, operationId);
  }
  await db
    .prepare(
      `UPDATE pr_review_response_operations
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE operation_id = ? AND status != 'succeeded'`,
    )
    .bind(options.error, options.nowMs, operationId)
    .run();
  return getReviewLoopOperationById(db, operationId);
}
