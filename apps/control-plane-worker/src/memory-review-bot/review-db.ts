import type {
  MemoryReviewBotRun,
  MemoryReviewItemResult,
  MemoryReviewPromptOutcome,
  MemoryReviewRecallResult,
  MemoryReviewScopeStatus,
  MemoryReviewSessionEventDeliveryStatus,
  MemoryReviewSlackDeliveryStatus,
  MemoryReviewUsageSource,
} from "./types";

interface MemoryReviewBotRunDbRow {
  id: string;
  business_id: string;
  session_id: string;
  prompt_id: string;
  reviewer_model: string;
  prompt_version: string;
  schema_version: string;
  input_snapshot_json: string;
  output_json: string;
  prompt_outcome: MemoryReviewPromptOutcome;
  confidence: number;
  summary: string;
  evidence_json: string;
  failure_code: string | null;
  session_event_status: MemoryReviewSessionEventDeliveryStatus;
  session_event_id: string | null;
  session_event_error: string | null;
  slack_post_status: MemoryReviewSlackDeliveryStatus;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  slack_error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd_micros: number | null;
  started_at_ms: number;
  completed_at_ms: number;
  created_at_ms: number;
}

export interface InsertMemoryReviewBotRunInput {
  runId?: string;
  businessId: string;
  sessionId: string;
  promptId: string;
  reviewerModel: string;
  promptVersion: string;
  schemaVersion: string;
  inputSnapshotJson: string;
  outputJson: string;
  promptOutcome: MemoryReviewPromptOutcome;
  confidence: number;
  summary: string;
  evidenceJson: string;
  failureCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsdMicros?: number | null;
  recallResults: MemoryReviewRecallResult[];
  itemResults: Array<
    MemoryReviewItemResult & {
      source: MemoryReviewUsageSource;
      scopeStatus: MemoryReviewScopeStatus;
    }
  >;
  startedAtMs: number;
  completedAtMs?: number;
}

export interface MemoryReviewBotDigestRun {
  run: MemoryReviewBotRun;
  itemCount: number;
  usefulCount: number;
  hurtCount: number;
  memoryIds: string[];
  rootCauses: string[];
}

function requireNonEmpty(value: string, field: string, maxChars = 300): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized.slice(0, maxChars);
}

function safeNow(nowMs?: number): number {
  return typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
}

function rowToRun(row: MemoryReviewBotRunDbRow): MemoryReviewBotRun {
  return {
    id: row.id,
    businessId: row.business_id,
    sessionId: row.session_id,
    promptId: row.prompt_id,
    reviewerModel: row.reviewer_model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    inputSnapshotJson: row.input_snapshot_json,
    outputJson: row.output_json,
    promptOutcome: row.prompt_outcome,
    confidence: row.confidence,
    summary: row.summary,
    evidenceJson: row.evidence_json,
    failureCode: row.failure_code,
    sessionEventStatus: row.session_event_status,
    sessionEventId: row.session_event_id,
    sessionEventError: row.session_event_error,
    slackPostStatus: row.slack_post_status,
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    slackError: row.slack_error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsdMicros: row.cost_usd_micros,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
  };
}

export async function insertMemoryReviewBotRunResults(
  db: D1Database,
  input: InsertMemoryReviewBotRunInput,
): Promise<MemoryReviewBotRun> {
  const runId = input.runId ?? `memory-review:${input.sessionId}:${input.promptId}`;
  const completedAtMs = safeNow(input.completedAtMs);
  const createdAtMs = completedAtMs;
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM memory_review_bot_recall_results WHERE run_id = ?").bind(runId),
    db.prepare("DELETE FROM memory_review_bot_item_results WHERE run_id = ?").bind(runId),
    db
      .prepare(
        `INSERT INTO memory_review_bot_runs
         (id, business_id, session_id, prompt_id, reviewer_model, prompt_version,
          schema_version, input_snapshot_json, output_json, prompt_outcome, confidence,
          summary, evidence_json, failure_code, input_tokens, output_tokens, cost_usd_micros,
          started_at_ms, completed_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, prompt_id) DO UPDATE SET
           id = excluded.id,
           reviewer_model = excluded.reviewer_model,
           prompt_version = excluded.prompt_version,
           schema_version = excluded.schema_version,
           input_snapshot_json = excluded.input_snapshot_json,
           output_json = excluded.output_json,
           prompt_outcome = excluded.prompt_outcome,
           confidence = excluded.confidence,
           summary = excluded.summary,
           evidence_json = excluded.evidence_json,
           failure_code = excluded.failure_code,
           session_event_status = 'pending',
           session_event_id = NULL,
           session_event_error = NULL,
           slack_post_status = 'pending',
           slack_channel_id = NULL,
           slack_message_ts = NULL,
           slack_error = NULL,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cost_usd_micros = excluded.cost_usd_micros,
           started_at_ms = excluded.started_at_ms,
           completed_at_ms = excluded.completed_at_ms,
           created_at_ms = excluded.created_at_ms`,
      )
      .bind(
        runId,
        requireNonEmpty(input.businessId, "business_id"),
        requireNonEmpty(input.sessionId, "session_id"),
        requireNonEmpty(input.promptId, "prompt_id"),
        requireNonEmpty(input.reviewerModel, "reviewer_model"),
        requireNonEmpty(input.promptVersion, "prompt_version"),
        requireNonEmpty(input.schemaVersion, "schema_version"),
        input.inputSnapshotJson,
        input.outputJson,
        input.promptOutcome,
        Math.max(0, Math.min(1, input.confidence)),
        input.summary.slice(0, 2_000),
        input.evidenceJson,
        input.failureCode ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.costUsdMicros ?? null,
        input.startedAtMs,
        completedAtMs,
        createdAtMs,
      ),
  ];

  for (const recall of input.recallResults) {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_review_bot_recall_results
           (id, run_id, business_id, session_id, prompt_id, source, memory_count,
            relevant_count, useful_count, hurt_count, prompt_outcome, aggregate_effect,
            provenance_notes_json, evidence_ids_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${runId}:recall:${recall.source}`,
          runId,
          input.businessId,
          input.sessionId,
          input.promptId,
          recall.source,
          recall.memoryCount,
          recall.relevantCount,
          recall.usefulCount,
          recall.hurtCount,
          recall.promptOutcome,
          recall.aggregateEffect,
          JSON.stringify(recall.provenanceNotes),
          JSON.stringify(recall.evidenceIds),
          createdAtMs,
        ),
    );
  }

  for (const item of input.itemResults) {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_review_bot_item_results
           (id, run_id, business_id, session_id, prompt_id, memory_id, source,
            relevance, usefulness, effect, lifecycle_state, root_causes_json,
            evidence_ids_json, rationale, scope_status, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${runId}:item:${item.memoryId}`,
          runId,
          input.businessId,
          input.sessionId,
          input.promptId,
          item.memoryId,
          item.source,
          item.relevance,
          item.usefulness,
          item.effect,
          item.lifecycleState,
          JSON.stringify(item.rootCauses),
          JSON.stringify(item.evidenceIds),
          item.rationale.slice(0, 1_000),
          item.scopeStatus,
          createdAtMs,
        ),
    );
  }

  await db.batch(statements);

  const run = await getMemoryReviewBotRun(db, input.businessId, runId);
  if (!run) throw new Error("Failed to insert memory review bot run");
  return run;
}

export async function getMemoryReviewBotRun(
  db: D1Database,
  businessId: string,
  runId: string,
): Promise<MemoryReviewBotRun | null> {
  const row = await db
    .prepare("SELECT * FROM memory_review_bot_runs WHERE business_id = ? AND id = ? LIMIT 1")
    .bind(requireNonEmpty(businessId, "business_id"), requireNonEmpty(runId, "run_id"))
    .first<MemoryReviewBotRunDbRow>();
  return row ? rowToRun(row) : null;
}

export async function updateMemoryReviewBotRunSessionEventDelivery(
  db: D1Database,
  input: {
    businessId: string;
    runId: string;
    status: MemoryReviewSessionEventDeliveryStatus;
    eventId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_review_bot_runs
       SET session_event_status = ?,
           session_event_id = ?,
           session_event_error = ?
       WHERE business_id = ? AND id = ?`,
    )
    .bind(
      input.status,
      input.eventId ?? null,
      input.error ? input.error.slice(0, 500) : null,
      requireNonEmpty(input.businessId, "business_id"),
      requireNonEmpty(input.runId, "run_id"),
    )
    .run();
}

export async function listPendingMemoryReviewBotDigestRuns(
  db: D1Database,
  params: { startMs: number; endMs: number; limit: number },
): Promise<MemoryReviewBotDigestRun[]> {
  const result = await db
    .prepare(
      `SELECT r.*,
              COUNT(i.id) AS item_count,
              COALESCE(SUM(CASE WHEN i.usefulness = 'useful' THEN 1 ELSE 0 END), 0) AS useful_count,
              COALESCE(SUM(CASE WHEN i.effect = 'hurt' THEN 1 ELSE 0 END), 0) AS hurt_count,
              GROUP_CONCAT(i.memory_id) AS memory_ids,
              -- char(30) is the ASCII record separator; JSON.stringify escapes all
              -- control chars, so it can never appear inside a root_causes_json value
              -- and split the stored JSON mid-string the way '|' could.
              GROUP_CONCAT(i.root_causes_json, char(30)) AS root_causes_json
       FROM memory_review_bot_runs r
       LEFT JOIN memory_review_bot_item_results i
         ON i.business_id = r.business_id AND i.run_id = r.id
       WHERE r.slack_post_status IN ('pending', 'failed')
         AND r.completed_at_ms >= ?
         AND r.completed_at_ms < ?
       GROUP BY r.id
       ORDER BY r.completed_at_ms ASC
       LIMIT ?`,
    )
    .bind(params.startMs, params.endMs, Math.max(1, Math.min(Math.floor(params.limit), 200)))
    .all<
      MemoryReviewBotRunDbRow & {
        item_count: number;
        useful_count: number;
        hurt_count: number;
        memory_ids: string | null;
        root_causes_json: string | null;
      }
    >();
  return result.results.map((row) => ({
    run: rowToRun(row),
    itemCount: row.item_count,
    usefulCount: row.useful_count,
    hurtCount: row.hurt_count,
    memoryIds: splitCommaList(row.memory_ids).slice(0, 5),
    rootCauses: uniqueRootCauses(row.root_causes_json).slice(0, 5),
  }));
}

export async function markMemoryReviewBotDigestRunsSlackDelivery(
  db: D1Database,
  params: {
    runRefs: Array<{ businessId: string; runId: string }>;
    status: MemoryReviewSlackDeliveryStatus;
    channelId?: string | null;
    messageTs?: string | null;
    error?: string | null;
  },
): Promise<void> {
  if (params.runRefs.length === 0) return;
  await db.batch(
    params.runRefs.map((run) =>
      db
        .prepare(
          `UPDATE memory_review_bot_runs
           SET slack_post_status = ?,
               slack_channel_id = ?,
               slack_message_ts = ?,
               slack_error = ?
           WHERE business_id = ? AND id = ?`,
        )
        .bind(
          params.status,
          params.channelId ?? null,
          params.messageTs ?? null,
          params.error ? params.error.slice(0, 500) : null,
          requireNonEmpty(run.businessId, "business_id"),
          requireNonEmpty(run.runId, "run_id"),
        ),
    ),
  );
}

function splitCommaList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Matches the char(30) record separator used by the GROUP_CONCAT above.
const ROOT_CAUSES_JSON_SEPARATOR = "\x1e";

function uniqueRootCauses(value: string | null): string[] {
  const roots = new Set<string>();
  for (const entry of value?.split(ROOT_CAUSES_JSON_SEPARATOR) ?? []) {
    try {
      const parsed = JSON.parse(entry) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) roots.add(item.trim());
        }
      }
    } catch {
      // Ignore malformed stored reviewer output in digest summarization.
    }
  }
  return [...roots];
}
