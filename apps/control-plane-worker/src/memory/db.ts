// ---------------------------------------------------------------------------
// D1 telemetry: memory usage tracking + memory PR outcome tracking +
// memory analysis job queue tracking + optional repo-memory D1 sink.
// ---------------------------------------------------------------------------
import type { MemoryFile } from "../../../../shared/memory/parser.js";
import { d1Changed } from "../db/errors";

// ---------------------------------------------------------------------------
// Memory PR tracking
// ---------------------------------------------------------------------------

interface UpsertMemoryPrTrackingParams {
  repoOwner: string;
  repoName: string;
  sourcePrUrl: string;
  sourcePrNumber: number;
  sourceSessionId: string;
  memoryPrUrl: string | null;
  memoryPrNumber: number | null;
  memoriesAdded: number;
  memoriesUpdated: number;
  memoriesRemoved: number;
  /** Full analyzer suggestions with rationale, serialized as JSON. */
  suggestionsJson: string;
}

/**
 * Record a memory PR creation. Idempotent via ON CONFLICT on memory_pr_url.
 * Preserves outcome/outcome_at if the row already exists (handles retries
 * where createPullRequest resolves to an existing PR).
 *
 * When `memoryPrUrl` is null the ON CONFLICT(memory_pr_url) cannot fire (SQLite
 * treats NULLs as distinct) and the random `id` differs per call, so concurrent
 * or retried pre-URL calls would insert duplicate rows. Route those through the
 * deterministic-id sibling (keyed on source PR), which writes the same table/row
 * shape and is idempotent, so the function honors its idempotency contract even
 * before a PR URL exists.
 */
export async function upsertMemoryPrTracking(db: D1Database, params: UpsertMemoryPrTrackingParams): Promise<void> {
  if (!params.memoryPrUrl) {
    await upsertMemorySuggestionTracking(db, params);
    return;
  }
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO memory_pr_tracking
       (id, repo_owner, repo_name, source_pr_url, source_pr_number, source_session_id,
        memory_pr_url, memory_pr_number, memories_added, memories_updated, memories_removed,
        suggestions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_pr_url) DO UPDATE SET
         memories_added = excluded.memories_added,
         memories_updated = excluded.memories_updated,
         memories_removed = excluded.memories_removed,
         suggestions_json = excluded.suggestions_json`,
    )
    .bind(
      crypto.randomUUID(),
      params.repoOwner,
      params.repoName,
      params.sourcePrUrl,
      params.sourcePrNumber,
      params.sourceSessionId,
      params.memoryPrUrl,
      params.memoryPrNumber,
      params.memoriesAdded,
      params.memoriesUpdated,
      params.memoriesRemoved,
      params.suggestionsJson,
      now,
    )
    .run();
}

export async function upsertMemorySuggestionTracking(
  db: D1Database,
  params: UpsertMemoryPrTrackingParams,
): Promise<void> {
  const now = Date.now();
  const id = `source:${params.repoOwner}/${params.repoName}#${params.sourcePrNumber}`;
  await db
    .prepare(
      `INSERT INTO memory_pr_tracking
       (id, repo_owner, repo_name, source_pr_url, source_pr_number, source_session_id,
        memory_pr_url, memory_pr_number, memories_added, memories_updated, memories_removed,
        suggestions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         memories_added = excluded.memories_added,
         memories_updated = excluded.memories_updated,
         memories_removed = excluded.memories_removed,
         suggestions_json = excluded.suggestions_json`,
    )
    .bind(
      id,
      params.repoOwner,
      params.repoName,
      params.sourcePrUrl,
      params.sourcePrNumber,
      params.sourceSessionId,
      params.memoryPrUrl,
      params.memoryPrNumber,
      params.memoriesAdded,
      params.memoriesUpdated,
      params.memoriesRemoved,
      params.suggestionsJson,
      now,
    )
    .run();
}

/**
 * Record a memory PR outcome (merged/closed).
 * Pass null to clear outcome (e.g. on reopen — clears both outcome and outcome_at).
 * Returns true if a tracking row was found and updated.
 */
export async function updateMemoryPrOutcome(
  db: D1Database,
  memoryPrUrl: string,
  outcome: "merged" | "closed" | null,
): Promise<boolean> {
  const now = outcome !== null ? Date.now() : null;
  const result = await db
    .prepare(`UPDATE memory_pr_tracking SET outcome = ?, outcome_at = ? WHERE memory_pr_url = ?`)
    .bind(outcome, now, memoryPrUrl)
    .run();
  return d1Changed(result);
}

// ---------------------------------------------------------------------------
// Repo-memory D1 sink
// ---------------------------------------------------------------------------

export interface UpsertRepoMemoryParams {
  repoOwner: string;
  repoName: string;
  memory: MemoryFile;
  sourcePrUrl: string;
  sourcePrNumber: number;
  sourceSessionIds: string[];
}

export interface InsertRepoMemoryJudgmentParams {
  repoOwner: string;
  repoName: string;
  sourcePrUrl: string;
  sourcePrNumber: number;
  sourceSessionIds: string[];
  suggestionKind: "add" | "update" | "remove";
  targetMemoryId: string | null;
  memoryId: string | null;
  verdict: "store" | "reject";
  confidence: number;
  rationale: string;
  issues: string[];
  candidateJson: string;
  judgeModel: string;
}

export async function upsertRepoMemoryWithJudgment(
  db: D1Database,
  params: {
    memory: UpsertRepoMemoryParams;
    judgment: InsertRepoMemoryJudgmentParams;
  },
): Promise<void> {
  const now = Date.now();
  await db.batch([
    buildUpsertRepoMemoryStatement(db, params.memory, now),
    buildInsertRepoMemoryJudgmentStatement(db, params.judgment, now),
  ]);
}

function buildUpsertRepoMemoryStatement(
  db: D1Database,
  params: UpsertRepoMemoryParams,
  now: number,
): D1PreparedStatement {
  const memoryJson = JSON.stringify(params.memory);
  return db
    .prepare(
      `INSERT INTO repo_memories
       (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
        primitive, confidence, authority, enforcement, context_hint, content,
        applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
        memory_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_owner, repo_name, memory_id) DO UPDATE SET
         status = excluded.status,
         memory_type = excluded.memory_type,
         action_type = excluded.action_type,
         level = excluded.level,
         primitive = excluded.primitive,
         confidence = excluded.confidence,
         authority = excluded.authority,
         enforcement = excluded.enforcement,
         context_hint = excluded.context_hint,
         content = excluded.content,
         applies_to_json = excluded.applies_to_json,
         source_pr_url = excluded.source_pr_url,
         source_pr_number = excluded.source_pr_number,
         source_session_ids_json = excluded.source_session_ids_json,
         memory_json = excluded.memory_json,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(
      crypto.randomUUID(),
      params.repoOwner,
      params.repoName,
      params.memory.id,
      params.memory.status,
      params.memory.memory_type,
      params.memory.action_type ?? null,
      params.memory.level,
      params.memory.primitive,
      params.memory.confidence,
      params.memory.authority,
      params.memory.enforcement,
      truncateNullable(params.memory.context_hint, 1_000) ?? "",
      truncateNullable(params.memory.content, 10_000) ?? "",
      JSON.stringify(params.memory.applies_to),
      params.sourcePrUrl,
      params.sourcePrNumber,
      JSON.stringify(params.sourceSessionIds),
      memoryJson,
      now,
      now,
    );
}

export async function insertRepoMemoryJudgment(db: D1Database, params: InsertRepoMemoryJudgmentParams): Promise<void> {
  await buildInsertRepoMemoryJudgmentStatement(db, params, Date.now()).run();
}

function buildInsertRepoMemoryJudgmentStatement(
  db: D1Database,
  params: InsertRepoMemoryJudgmentParams,
  now: number,
): D1PreparedStatement {
  const id = repoMemoryJudgmentId(params);
  return db
    .prepare(
      `INSERT INTO repo_memory_judgments
       (id, repo_owner, repo_name, source_pr_url, source_pr_number, source_session_ids_json,
        suggestion_kind, target_memory_id, memory_id, verdict, confidence, rationale,
        issues_json, candidate_json, judge_model, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_session_ids_json = excluded.source_session_ids_json,
         target_memory_id = excluded.target_memory_id,
         memory_id = excluded.memory_id,
         verdict = excluded.verdict,
         confidence = excluded.confidence,
         rationale = excluded.rationale,
         issues_json = excluded.issues_json,
         candidate_json = excluded.candidate_json,
         judge_model = excluded.judge_model,
         created_at_ms = excluded.created_at_ms`,
    )
    .bind(
      id,
      params.repoOwner,
      params.repoName,
      params.sourcePrUrl,
      params.sourcePrNumber,
      JSON.stringify(params.sourceSessionIds),
      params.suggestionKind,
      params.targetMemoryId,
      params.memoryId,
      params.verdict,
      Math.max(0, Math.min(1, params.confidence)),
      truncateNullable(params.rationale, 2_000) ?? "",
      JSON.stringify(params.issues.slice(0, 20)),
      params.candidateJson.slice(0, 50_000),
      params.judgeModel,
      now,
    );
}

function repoMemoryJudgmentId(params: InsertRepoMemoryJudgmentParams): string {
  return [
    "repo-memory-judgment",
    params.repoOwner,
    params.repoName,
    String(params.sourcePrNumber),
    params.suggestionKind,
    params.memoryId ?? params.targetMemoryId ?? "none",
  ].join(":");
}

export async function listActiveRepoMemoriesForRepo(
  db: D1Database,
  repoOwner: string,
  repoName: string,
  limit = 200,
): Promise<MemoryFile[]> {
  const result = await db
    .prepare(
      `SELECT memory_json AS memoryJson
       FROM repo_memories
       WHERE repo_owner = ? AND repo_name = ? AND status = 'active'
       ORDER BY updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(repoOwner, repoName, limit)
    .all<{ memoryJson: string }>();

  return result.results
    .map((row) => parseStoredMemoryFile(row.memoryJson))
    .filter((memory): memory is MemoryFile => memory !== null && memory.status === "active");
}

// ---------------------------------------------------------------------------
// Memory analysis job tracking (queue consumer idempotency + retry)
// ---------------------------------------------------------------------------

interface MemoryAnalysisJobRow {
  id: string;
  review_id: number | null;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  status: string;
  error: string | null;
  attempt_count: number;
  params_json: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Create a memory analysis job. Idempotent via UNIQUE(repo_owner, repo_name, pr_number).
 * Returns the job ID if inserted, null if a job for this PR already exists.
 */
export async function createMemoryAnalysisJob(
  db: D1Database,
  repoOwner: string,
  repoName: string,
  prNumber: number,
  paramsJson: string,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO memory_analysis_jobs (id, repo_owner, repo_name, pr_number, params_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_owner, repo_name, pr_number) DO NOTHING`,
    )
    .bind(id, repoOwner, repoName, prNumber, paramsJson, now)
    .run();
  return d1Changed(result) ? id : null;
}

/** Fetch a memory analysis job by ID. */
export async function getMemoryAnalysisJob(db: D1Database, jobId: string): Promise<MemoryAnalysisJobRow | null> {
  return db.prepare("SELECT * FROM memory_analysis_jobs WHERE id = ?").bind(jobId).first<MemoryAnalysisJobRow>();
}

/**
 * Atomically claim a memory analysis job for processing.
 * Handles: pending (new), failed (retry), stale processing (crashed consumer).
 * Returns the new attempt_count if claimed (used as a lease guard on completion),
 * or null if the job is not claimable.
 */
export async function claimMemoryAnalysisJob(
  db: D1Database,
  jobId: string,
  staleThresholdMs: number,
  maxAttempts: number,
): Promise<number | null> {
  const now = Date.now();
  const staleCutoff = now - staleThresholdMs;
  const row = await db
    .prepare(
      `UPDATE memory_analysis_jobs
       SET status = 'processing', started_at = ?, error = NULL, attempt_count = attempt_count + 1
       WHERE id = ?
         AND attempt_count < ?
         AND (status = 'pending' OR status = 'failed' OR (status = 'processing' AND started_at < ?))
       RETURNING attempt_count`,
    )
    .bind(now, jobId, maxAttempts, staleCutoff)
    .first<{ attempt_count: number }>();
  return row?.attempt_count ?? null;
}

/**
 * Mark a memory analysis job as complete or skipped.
 * The attemptCount guard ensures a reclaimed job cannot be overwritten by
 * the original (now-stale) holder.
 */
export async function completeMemoryAnalysisJob(
  db: D1Database,
  jobId: string,
  status: "complete" | "skipped",
  attemptCount: number,
): Promise<void> {
  await db
    .prepare("UPDATE memory_analysis_jobs SET status = ?, completed_at = ? WHERE id = ? AND attempt_count = ?")
    .bind(status, Date.now(), jobId, attemptCount)
    .run();
}

/**
 * Mark a memory analysis job as failed with an error message.
 * The attemptCount guard ensures a reclaimed job cannot be overwritten by
 * the original (now-stale) holder.
 */
export async function failMemoryAnalysisJob(
  db: D1Database,
  jobId: string,
  error: string,
  attemptCount: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE memory_analysis_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND attempt_count = ?",
    )
    .bind(error.slice(0, 1000), Date.now(), jobId, attemptCount)
    .run();
}

/**
 * Find jobs eligible for re-enqueue by the cron sweep.
 * Returns: pending (never picked up), failed (within retry budget),
 * or processing with stale started_at (consumer crashed).
 */
export async function getReenqueueableMemoryJobs(
  db: D1Database,
  staleThresholdMs: number,
  maxAttempts: number,
): Promise<Array<{ id: string }>> {
  const staleCutoff = Date.now() - staleThresholdMs;
  const result = await db
    .prepare(
      `SELECT id FROM memory_analysis_jobs
       WHERE (status = 'pending' AND attempt_count < ?)
          OR (status = 'failed' AND attempt_count < ?)
          OR (status = 'processing' AND started_at < ? AND attempt_count < ?)
       ORDER BY created_at ASC LIMIT 10`,
    )
    .bind(maxAttempts, maxAttempts, staleCutoff, maxAttempts)
    .all<{ id: string }>();
  return result.results;
}

/**
 * Terminalize jobs stuck in 'processing' at or beyond max attempts.
 * Fixes the last-attempt wedge: if attempt N crashes after claim but
 * before failMemoryAnalysisJob(), the row is stuck as processing with
 * attempt_count=N. This function marks those as permanently failed.
 */
export async function terminalizeExhaustedJobs(
  db: D1Database,
  staleThresholdMs: number,
  maxAttempts: number,
): Promise<number> {
  const staleCutoff = Date.now() - staleThresholdMs;
  const result = await db
    .prepare(
      `UPDATE memory_analysis_jobs
       SET status = 'failed', error = 'max attempts exhausted', completed_at = ?
       WHERE status = 'processing'
         AND attempt_count >= ?
         AND started_at < ?`,
    )
    .bind(Date.now(), maxAttempts, staleCutoff)
    .run();
  return result.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Memory usage tracking
// ---------------------------------------------------------------------------
/**
 * Record that memories were active during a specific prompt.
 * Idempotent: INSERT OR IGNORE on (session_id, prompt_id, memory_id) PK.
 */
export async function recordMemoryUsage(
  db: D1Database,
  memoryIds: string[],
  sessionId: string,
  promptId: string,
): Promise<void> {
  if (memoryIds.length === 0) return;

  const now = Date.now();
  const statements = memoryIds.map((memoryId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO session_memory_usage (session_id, prompt_id, memory_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(sessionId, promptId, memoryId, now),
  );

  await db.batch(statements);
}

interface MemoryUsageEventInput {
  repoOwner?: string | null;
  repoName?: string | null;
  sessionId: string;
  promptId: string;
  memoryId: string;
  source: "prompt_start" | "recall" | "company_bootstrap" | "company_recall" | "company_reasoning_chain";
  selectionRank?: number | null;
  selectionScore?: number | null;
  explanation?: string | null;
  expectedEffect?: string | null;
  observedEffect?: string | null;
  intent?: string | null;
  filesJson?: string | null;
  symbolsJson?: string | null;
  reviewOutcome?: "helpful" | "incorrect" | "missed" | null;
  usedAt?: number;
}

export async function recordMemoryUsageEvents(db: D1Database, events: MemoryUsageEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const statements = events.map((event) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO memory_usage_events
         (id, repo_owner, repo_name, session_id, prompt_id, memory_id, source,
          selection_rank, selection_score, explanation, expected_effect, observed_effect,
          intent, files_json, symbols_json, review_outcome, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        event.repoOwner ?? null,
        event.repoName ?? null,
        event.sessionId,
        event.promptId,
        event.memoryId,
        event.source,
        event.selectionRank ?? null,
        event.selectionScore ?? null,
        truncateNullable(event.explanation, 1000),
        truncateNullable(event.expectedEffect, 1000),
        truncateNullable(event.observedEffect, 1000),
        truncateNullable(event.intent, 500),
        event.filesJson ?? null,
        event.symbolsJson ?? null,
        event.reviewOutcome ?? null,
        event.usedAt ?? Date.now(),
      ),
  );
  await db.batch(statements);
}

export async function updateMemoryUsageReviewOutcome(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    memoryId: string;
    source: "prompt_start" | "recall" | "company_bootstrap" | "company_recall";
    reviewOutcome: "helpful" | "incorrect";
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE memory_usage_events
       SET review_outcome = ?
       WHERE session_id = ? AND prompt_id = ? AND memory_id = ? AND source = ?`,
    )
    .bind(params.reviewOutcome, params.sessionId, params.promptId, params.memoryId, params.source)
    .run();
  return d1Changed(result);
}

export async function memoryUsageFeedbackTargetExists(
  db: D1Database,
  params: {
    sessionId: string;
    promptId: string;
    memoryId: string;
    source: "prompt_start" | "recall" | "company_bootstrap" | "company_recall";
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
       FROM memory_usage_events
       WHERE session_id = ? AND prompt_id = ? AND memory_id = ? AND source = ?
       LIMIT 1`,
    )
    .bind(params.sessionId, params.promptId, params.memoryId, params.source)
    .first<{ id: string }>();
  return row !== null;
}

interface SessionMemoryUsageRow {
  sessionId: string;
  promptId: string;
  memoryId: string;
  source: string;
  explanation: string | null;
  expectedEffect: string | null;
  observedEffect: string | null;
  reviewOutcome: string | null;
  usedAt: number;
}

export async function getMemoryUsageForSessions(
  db: D1Database,
  sessionIds: string[],
): Promise<SessionMemoryUsageRow[]> {
  const ids = [...new Set(sessionIds.filter((id) => id.trim()))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT session_id AS sessionId, prompt_id AS promptId, memory_id AS memoryId, source,
              explanation, expected_effect AS expectedEffect, observed_effect AS observedEffect,
              review_outcome AS reviewOutcome, used_at AS usedAt
       FROM memory_usage_events
       WHERE session_id IN (${placeholders})
       ORDER BY used_at ASC`,
    )
    .bind(...ids)
    .all<SessionMemoryUsageRow>();
  return result.results;
}

function truncateNullable(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function parseStoredMemoryFile(value: string): MemoryFile | null {
  try {
    const parsed = JSON.parse(value) as Partial<MemoryFile>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || typeof parsed.content !== "string") return null;
    if (typeof parsed.context_hint !== "string" || typeof parsed.memory_type !== "string") return null;
    if (typeof parsed.level !== "string" || typeof parsed.primitive !== "string") return null;
    if (parsed.status !== "active" && parsed.status !== "superseded") return null;
    return parsed as MemoryFile;
  } catch {
    return null;
  }
}
