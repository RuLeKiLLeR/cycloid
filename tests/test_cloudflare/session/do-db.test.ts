import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { PromptState } from "../../../apps/control-plane-worker/src/types.js";

/**
 * Tests for the DO-internal SQL schema and database access layer.
 *
 * Uses better-sqlite3 to create a real SQLite database that mirrors the
 * Cloudflare SqlStorage interface, so we can test actual SQL queries.
 */

// ---------------------------------------------------------------------------
// SqlStorage mock backed by better-sqlite3
// ---------------------------------------------------------------------------

type TransactionCapableSqlStorage = SqlStorage & { transactionSync<T>(closure: () => T): T };

function createMockSqlStorage(): TransactionCapableSqlStorage {
  const db = new Database(":memory:");

  function makeCursor(rows: Record<string, unknown>[]): SqlStorageCursor {
    return {
      toArray() {
        return rows as Record<string, SqlStorageValue>[];
      },
      rowsRead: rows.length,
      rowsWritten: 0,
      [Symbol.iterator]() {
        return rows[Symbol.iterator]() as Iterator<Record<string, SqlStorageValue>>;
      },
    } as SqlStorageCursor;
  }

  function makeWriteCursor(rowsWritten: number): SqlStorageCursor {
    return {
      toArray() {
        return [];
      },
      rowsRead: 0,
      rowsWritten,
      [Symbol.iterator]() {
        return [][Symbol.iterator]();
      },
    } as SqlStorageCursor;
  }

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");

      if (params.length === 0) {
        if (isSelect) {
          // Single SELECT without params -- use prepare().all()
          const rows = db.prepare(query).all();
          return makeCursor(rows as Record<string, unknown>[]);
        }
        // Multi-statement DDL/DML
        db.exec(query);
        return makeWriteCursor(0);
      }

      const stmt = db.prepare(query);
      if (isSelect) {
        return makeCursor(stmt.all(...(params as unknown[])) as Record<string, unknown>[]);
      }
      const result = stmt.run(...(params as unknown[]));
      return makeWriteCursor(result.changes);
    },
    get databaseSize() {
      return 0;
    },
    transactionSync<T>(closure: () => T): T {
      return db.transaction(closure)();
    },
    Cursor: class {} as unknown as typeof SqlStorageCursor,
  } as unknown as TransactionCapableSqlStorage;

  return sql;
}

// ---------------------------------------------------------------------------
// Imports (must come after mock setup since these are pure functions)
// ---------------------------------------------------------------------------

// Use dynamic path to avoid cloudflare:workers import issues
const schemaModule = await import("../../../apps/control-plane-worker/src/session/schema.js");
const doDbModule = await import("../../../apps/control-plane-worker/src/session/do-db.js");
const cycloidEventStoreModule = await import("../../../apps/control-plane-worker/src/session/cycloid-event-store.js");
const cycloidSchemaModule = await import("../../../shared/events/schema.js");

const { initSchema, MIGRATIONS } = schemaModule;
const { encodeCycloidEvent } = cycloidSchemaModule;
const { projectCycloidEventToDurableEntry } = cycloidEventStoreModule;
const {
  createSession,
  getSession,
  getSessionIdForDo,
  updateSession,
  getSessionExtended,
  updateSessionFields,
  SESSION_EXTENDED_FIELD_MAPPINGS,
  getPrompts,
  getPrompt,
  getPromptHasPendingQuestion,
  updatePrompt,
  bulkUpdatePrompts,
  PROMPT_INSERT_COLUMNS,
  serializePromptRow,
  appendEventsWithReplay,
  getEvents,
  getLatestSessionCloseReason,
  getLastEventSequence,
  getReplayEvents,
  getReplayState,
  getReplayWindowEvents,
  getReplayEventsBeforeSequence,
  ensureSandboxState,
  getSandboxState,
  updateSandboxState,
  clearRuntimeState,
  upsertPromptUsage,
  getPromptUsage,
  computeUsageCache,
  upsertPromptTokenAttribution,
  getPromptTokenAttribution,
  upsertPromptTelemetry,
  upsertPromptTraceTelemetry,
  incrementToolCallCount,
  incrementPromptToolStats,
  getPromptTelemetry,
  getPromptToolCounts,
  getPromptToolStatsForPrompt,
  upsertSessionPlan,
  getLatestSessionPlan,
  updateSessionPlanStatus,
  saveEditedPlanRevision,
  clearSnapshotMetadata,
  insertPlatformLlmCapability,
  getPlatformLlmCapability,
  consumePlatformLlmCapability,
  incrementPlatformLlmBudget,
  getPlatformLlmBudgetUsed,
  revokePromptCapabilities,
  purgeExpiredCapabilities,
  upsertPlatformLlmPromptStatus,
  getPlatformLlmPromptStatus,
} = doDbModule;

function insertPrompt(sql: SqlStorage, sessionId: string, prompt: PromptState): void {
  bulkUpdatePrompts(sql, sessionId, [...getPrompts(sql, sessionId), prompt]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DO SQL schema", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
  });

  it("initializes schema without error", () => {
    expect(() => initSchema(sql)).not.toThrow();
  });

  it("is idempotent -- can run twice without error", () => {
    initSchema(sql);
    expect(() => initSchema(sql)).not.toThrow();
  });

  it("creates the _schema_migrations table", () => {
    initSchema(sql);
    const rows = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_migrations'").toArray();
    expect(rows).toHaveLength(1);
  });

  it("creates all expected tables", () => {
    initSchema(sql);
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
    const names = tables.map((r) => r.name as string);
    expect(names).toContain("session");
    expect(names).toContain("prompts");
    expect(names).toContain("prompt_attachments");
    expect(names).toContain("events");
    expect(names).toContain("sandbox_state");
    expect(names).toContain("prompt_usage");
    expect(names).toContain("prompt_token_attribution");
    expect(names).toContain("prompt_telemetry");
    expect(names).toContain("prompt_tool_stats");
    expect(names).toContain("artifacts");
    expect(names).toContain("ws_recovery");
    expect(names).toContain("platform_llm_capabilities");
    expect(names).toContain("platform_llm_budget");
    expect(names).toContain("platform_llm_prompt_status");
  });

  it("migrates neutral runtime columns onto sandbox_state", () => {
    initSchema(sql);
    const columns = sql.exec("SELECT name FROM pragma_table_info('sandbox_state')").toArray();
    const names = columns.map((r) => r.name as string);
    expect(names).toEqual(expect.arrayContaining(["runtime_provider", "runtime_state", "runtime_sandbox_id"]));
    expect(names).toEqual(
      expect.arrayContaining([
        "runtime_backend",
        "runtime_last_provider_refreshed_at",
        "runtime_provider_ttl_expires_at",
      ]),
    );
  });

  it("includes the snapshot credential metadata migration", () => {
    expect(MIGRATIONS).toEqual([
      { id: 1, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_credential_env_keys_json TEXT;" },
      { id: 2, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_modal_workspace TEXT;" },
      { id: 3, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_modal_environment TEXT;" },
      { id: 4, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_sandbox_image_version TEXT;" },
      { id: 5, sql: "UPDATE session SET status = 'archived' WHERE status = 'closed';" },
      { id: 6, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_urls_json TEXT;" },
      { id: 7, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_url TEXT;" },
      { id: 8, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_contract_json TEXT;" },
      { id: 9, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_status TEXT;" },
      { id: 10, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_error TEXT;" },
      { id: 11, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_ready_at INTEGER;" },
      { id: 12, sql: "ALTER TABLE sandbox_state ADD COLUMN preview_updated_at INTEGER;" },
      { id: 13, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_docker_enabled INTEGER;" },
      { id: 14, sql: "ALTER TABLE session ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'repo';" },
      { id: 15, sql: "ALTER TABLE session ADD COLUMN sandbox_profile_json TEXT;" },
      { id: 16, sql: "ALTER TABLE session ADD COLUMN business_id TEXT;" },
      {
        id: 17,
        sql: "CREATE TABLE IF NOT EXISTS prompt_token_attribution (prompt_id TEXT PRIMARY KEY, attribution_json TEXT NOT NULL);",
      },
      { id: 18, sql: "ALTER TABLE session ADD COLUMN title_tags TEXT;", ignoreDuplicateColumn: true },
      { id: 19, sql: "ALTER TABLE sandbox_state ADD COLUMN snapshot_credential_fingerprints_json TEXT;" },
      {
        id: 20,
        sql: "CREATE TABLE IF NOT EXISTS platform_llm_prompt_status (prompt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);",
      },
      { id: 21, sql: "ALTER TABLE prompts ADD COLUMN skills_json TEXT;" },
      { id: 22, sql: "ALTER TABLE sandbox_state ADD COLUMN stop_reason TEXT;" },
      { id: 23, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_provider TEXT;" },
      { id: 24, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_state TEXT;" },
      { id: 25, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_sandbox_id TEXT;" },
      { id: 26, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_template_id TEXT;" },
      { id: 27, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_state_expires_at INTEGER;" },
      { id: 28, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_live_lease_expires_at INTEGER;" },
      { id: 29, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_preview_url TEXT;" },
      { id: 30, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_created_at INTEGER;" },
      { id: 31, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_last_resumed_at INTEGER;" },
      { id: 32, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_last_paused_at INTEGER;" },
      { id: 33, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_last_provider_refreshed_at INTEGER;" },
      { id: 34, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_provider_ttl_expires_at INTEGER;" },
      { id: 35, sql: "ALTER TABLE session ADD COLUMN codex_session_id TEXT;", ignoreDuplicateColumn: true },
      { id: 36, sql: "ALTER TABLE session ADD COLUMN codex_session_agent TEXT;", ignoreDuplicateColumn: true },
      { id: 37, sql: "ALTER TABLE session ADD COLUMN pr_draft INTEGER;", ignoreDuplicateColumn: true },
      { id: 38, sql: "ALTER TABLE session ADD COLUMN pr_manual_review_reason TEXT;", ignoreDuplicateColumn: true },
      {
        id: 39,
        sql: "ALTER TABLE sandbox_state ADD COLUMN intentional_pause_reason TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 40,
        sql: "ALTER TABLE prompts ADD COLUMN reply_to_text TEXT;",
        ignoreDuplicateColumn: true,
      },
      { id: 41, sql: "ALTER TABLE sandbox_state ADD COLUMN runtime_backend TEXT;", ignoreDuplicateColumn: true },
      {
        id: 42,
        sql: "ALTER TABLE session ADD COLUMN last_push_succeeded INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 43,
        sql: "ALTER TABLE session ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'not_started';",
        ignoreDuplicateColumn: true,
      },
      { id: 44, sql: "ALTER TABLE session ADD COLUMN publish_stage TEXT;", ignoreDuplicateColumn: true },
      { id: 45, sql: "ALTER TABLE session ADD COLUMN publish_error TEXT;", ignoreDuplicateColumn: true },
      { id: 46, sql: "ALTER TABLE session ADD COLUMN published_branch TEXT;", ignoreDuplicateColumn: true },
      {
        id: 47,
        sql: "ALTER TABLE session ADD COLUMN publish_attempt INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 48,
        sql: "ALTER TABLE session ADD COLUMN publish_sequence INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 49,
        sql: "ALTER TABLE session ADD COLUMN pr_polish_status TEXT NOT NULL DEFAULT 'not_started';",
        ignoreDuplicateColumn: true,
      },
      { id: 50, sql: "ALTER TABLE session ADD COLUMN pr_polish_error TEXT;", ignoreDuplicateColumn: true },
      { id: 51, sql: "ALTER TABLE prompts ADD COLUMN branch_name_hint TEXT;", ignoreDuplicateColumn: true },
      {
        id: 52,
        sql: "ALTER TABLE prompts ADD COLUMN reply_to_quote_source_json TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 53,
        sql: "ALTER TABLE platform_llm_prompt_status ADD COLUMN started_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 54,
        sql: "ALTER TABLE session ADD COLUMN publishing_started_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 55,
        sql: "ALTER TABLE prompts ADD COLUMN push_status TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 56,
        sql: "ALTER TABLE prompts ADD COLUMN push_error TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 57,
        sql: "UPDATE session SET publish_status = 'publishing' WHERE publish_status = 'ready';",
      },
      {
        id: 58,
        sql: "ALTER TABLE session ADD COLUMN initiation_mode TEXT NOT NULL DEFAULT 'user';",
        ignoreDuplicateColumn: true,
      },
      {
        id: 59,
        sql: "ALTER TABLE session ADD COLUMN scheduled_rule_id TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 60,
        sql: "ALTER TABLE session ADD COLUMN rule_name_snapshot TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 61,
        sql: "ALTER TABLE session ADD COLUMN cron_snapshot TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 62,
        sql: "ALTER TABLE session ADD COLUMN review_listening_active INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 63,
        sql: "ALTER TABLE session ADD COLUMN review_listening_pr_url TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 64,
        sql: "ALTER TABLE session ADD COLUMN review_listening_head_sha TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 65,
        sql: "ALTER TABLE session ADD COLUMN review_listening_entered_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 66,
        sql: "ALTER TABLE prompts ADD COLUMN review_loop_epoch_id TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 67,
        sql: "UPDATE prompts SET status = 'failed', completed_at = COALESCE(completed_at, updated_at), error = COALESCE(error, 'session_archived_backfill'), updated_at = updated_at WHERE status = 'processing' AND session_id IN (SELECT session_id FROM session WHERE status = 'archived');",
      },
      {
        id: 68,
        sql: "UPDATE session SET active_prompt_id = NULL WHERE status = 'archived' AND active_prompt_id IS NOT NULL;",
      },
      {
        id: 69,
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_one_processing ON prompts(session_id) WHERE status = 'processing';",
      },
      {
        id: 70,
        sql: "ALTER TABLE session DROP COLUMN active_prompt_id;",
      },
      {
        id: 71,
        sql: "ALTER TABLE session ADD COLUMN pr_title_last_applied TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 72,
        sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_hash TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 73,
        sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_expires_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      { id: 74, sql: "ALTER TABLE session RENAME COLUMN codex_session_id TO agent_session_id;" },
      { id: 75, sql: "ALTER TABLE session RENAME COLUMN codex_session_agent TO agent_session_agent;" },
      { id: 76, sql: "ALTER TABLE session ADD COLUMN agent_runtime_backend TEXT;", ignoreDuplicateColumn: true },
      {
        id: 77,
        sql: "ALTER TABLE session ADD COLUMN agent_role TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 78,
        sql: "ALTER TABLE session ADD COLUMN agent_profile TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 79,
        sql: "ALTER TABLE session ADD COLUMN harness_kind TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 80,
        sql: "ALTER TABLE session ADD COLUMN runtime_startup_profile TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 81,
        sql: "ALTER TABLE session ADD COLUMN target_pr_url TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 82,
        sql: "ALTER TABLE session ADD COLUMN ticket_key TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 83,
        sql: "ALTER TABLE session ADD COLUMN review_loop_done_state TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 84,
        sql: "ALTER TABLE session ADD COLUMN auto_verify_disabled INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 85,
        sql: "ALTER TABLE prompts ADD COLUMN review_loop_source_kind TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 86,
        sql: "ALTER TABLE session ADD COLUMN verification_state TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 87,
        sql: "ALTER TABLE session ADD COLUMN verification_attempt_count INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 88,
        sql: "ALTER TABLE session ADD COLUMN verification_max_attempts INTEGER NOT NULL DEFAULT 3;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 89,
        sql: "ALTER TABLE session ADD COLUMN verification_result TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 90,
        sql: "ALTER TABLE prompts ADD COLUMN disconnect_retry_count INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 91,
        sql: "ALTER TABLE session ADD COLUMN verification_runtime_mode TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 92,
        sql: "ALTER TABLE session ADD COLUMN verification_needs_work_label TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 93,
        sql: "ALTER TABLE session ADD COLUMN pr_draft_last_applied INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 94,
        sql: "ALTER TABLE session ADD COLUMN verification_run_baseline INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 95,
        sql: "ALTER TABLE session ADD COLUMN verification_verdict_head_sha TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 96,
        sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_hashes TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 97,
        sql: "UPDATE sandbox_state SET prev_sandbox_auth_token_hashes = '[{\"hash\":\"' || prev_sandbox_auth_token_hash || '\",\"expiresAt\":' || prev_sandbox_auth_token_expires_at || '}]' WHERE prev_sandbox_auth_token_hash IS NOT NULL AND prev_sandbox_auth_token_expires_at IS NOT NULL AND prev_sandbox_auth_token_hashes IS NULL;",
      },
      {
        id: 98,
        sql: "CREATE TABLE IF NOT EXISTS prompt_tool_stats (prompt_id TEXT NOT NULL, tool_name TEXT NOT NULL, mcp_server TEXT, ok_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER NOT NULL DEFAULT 0, duration_sample_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (prompt_id, tool_name));",
      },
      {
        id: 99,
        sql: "ALTER TABLE session ADD COLUMN arcanist_done_state TEXT NOT NULL DEFAULT 'working';",
        ignoreDuplicateColumn: true,
      },
      {
        id: 100,
        sql: "ALTER TABLE session ADD COLUMN arcanist_done_outcome TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 101,
        sql: "ALTER TABLE session ADD COLUMN arcanist_done_reasons_json TEXT NOT NULL DEFAULT '[]';",
        ignoreDuplicateColumn: true,
      },
      {
        id: 102,
        sql: "ALTER TABLE session ADD COLUMN start_branch TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 103,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_state TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 104,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_result TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 105,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_needs_work_label TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 106,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_attempt_count INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 107,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_max_attempts INTEGER NOT NULL DEFAULT 3;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 108,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_run_baseline INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 109,
        sql: "ALTER TABLE session ADD COLUMN qa_testing_verdict_head_sha TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 110,
        sql: "UPDATE session SET qa_testing_state = CASE verification_state WHEN 'verification-pending' THEN 'qa-pending' WHEN 'verification-in-progress' THEN 'qa-in-progress' WHEN 'verification-done' THEN 'qa-done' WHEN 'verification-skipped' THEN 'qa-skipped' WHEN 'verification-stopped' THEN 'qa-stopped' WHEN 'verification-exhausted' THEN 'qa-exhausted' ELSE qa_testing_state END WHERE qa_testing_state IS NULL AND verification_state IS NOT NULL;",
      },
      {
        id: 111,
        sql: "UPDATE session SET qa_testing_result = verification_result WHERE qa_testing_result IS NULL AND verification_result IS NOT NULL;",
      },
      {
        id: 112,
        sql: "UPDATE session SET qa_testing_needs_work_label = verification_needs_work_label WHERE qa_testing_needs_work_label IS NULL AND verification_needs_work_label IS NOT NULL;",
      },
      {
        id: 113,
        sql: "UPDATE session SET qa_testing_attempt_count = verification_attempt_count WHERE verification_attempt_count IS NOT NULL;",
      },
      {
        id: 114,
        sql: "UPDATE session SET qa_testing_max_attempts = verification_max_attempts WHERE verification_max_attempts IS NOT NULL;",
      },
      {
        id: 115,
        sql: "UPDATE session SET qa_testing_run_baseline = verification_run_baseline WHERE verification_run_baseline IS NOT NULL;",
      },
      {
        id: 116,
        sql: "UPDATE session SET qa_testing_verdict_head_sha = verification_verdict_head_sha WHERE qa_testing_verdict_head_sha IS NULL AND verification_verdict_head_sha IS NOT NULL;",
      },
      { id: 117, sql: "ALTER TABLE session DROP COLUMN session_kind;", ignoreMissingColumn: true },
      { id: 118, sql: "ALTER TABLE session DROP COLUMN sandbox_profile_json;", ignoreMissingColumn: true },
      {
        id: 119,
        sql: "ALTER TABLE session ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 120,
        sql: "ALTER TABLE prompts ADD COLUMN plan_context_json TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 121,
        sql: `CREATE TABLE IF NOT EXISTS session_plans (
  session_id TEXT NOT NULL,
  plan_prompt_id TEXT NOT NULL,
  implementation_prompt_id TEXT,
  markdown TEXT,
  excerpt TEXT NOT NULL,
  artifact_id TEXT,
  valid INTEGER NOT NULL DEFAULT 0,
  missing_reason TEXT,
  missing_headings_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, plan_prompt_id)
);`,
      },
      {
        id: 122,
        sql: "CREATE INDEX IF NOT EXISTS idx_session_plans_session_id ON session_plans(session_id);",
      },
      {
        id: 123,
        sql: "ALTER TABLE prompts ADD COLUMN is_plan_prompt INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      { id: 124, sql: "ALTER TABLE session DROP COLUMN verification_state;", ignoreMissingColumn: true },
      { id: 125, sql: "ALTER TABLE session DROP COLUMN verification_attempt_count;", ignoreMissingColumn: true },
      { id: 126, sql: "ALTER TABLE session DROP COLUMN verification_max_attempts;", ignoreMissingColumn: true },
      { id: 127, sql: "ALTER TABLE session DROP COLUMN verification_result;", ignoreMissingColumn: true },
      { id: 128, sql: "ALTER TABLE session DROP COLUMN verification_needs_work_label;", ignoreMissingColumn: true },
      { id: 129, sql: "ALTER TABLE session DROP COLUMN verification_run_baseline;", ignoreMissingColumn: true },
      { id: 130, sql: "ALTER TABLE session DROP COLUMN verification_verdict_head_sha;", ignoreMissingColumn: true },
      { id: 131, sql: "ALTER TABLE session DROP COLUMN review_loop_done_state;", ignoreMissingColumn: true },
      { id: 132, sql: "ALTER TABLE session DROP COLUMN arcanist_done_state;", ignoreMissingColumn: true },
      { id: 133, sql: "ALTER TABLE session DROP COLUMN arcanist_done_outcome;", ignoreMissingColumn: true },
      { id: 134, sql: "ALTER TABLE session DROP COLUMN arcanist_done_reasons_json;", ignoreMissingColumn: true },
      {
        id: 135,
        sql: "ALTER TABLE sandbox_state ADD COLUMN bridge_protocol_version INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 136,
        sql: "ALTER TABLE session ADD COLUMN plan_approval_required INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 137,
        sql: "ALTER TABLE session_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'none';",
        ignoreDuplicateColumn: true,
      },
      {
        id: 138,
        sql: "ALTER TABLE session_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 139,
        sql: "ALTER TABLE session_plans ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 140,
        sql: "ALTER TABLE session_plans ADD COLUMN approved_by TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 141,
        sql: "ALTER TABLE session_plans ADD COLUMN approved_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 142,
        sql: "ALTER TABLE session_plans ADD COLUMN source TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 143,
        sql: "ALTER TABLE session ADD COLUMN adopted_external_pr INTEGER NOT NULL DEFAULT 0;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 144,
        sql: "ALTER TABLE session ADD COLUMN entrypoint TEXT;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 145,
        sql: "ALTER TABLE session ADD COLUMN plan_auto_reason TEXT;",
        ignoreDuplicateColumn: true,
      },
    ]);
  });

  it("keeps session plan columns idempotent across repeated initialization", () => {
    initSchema(sql);
    expect(() => initSchema(sql)).not.toThrow();

    const columnNames = sql
      .exec("SELECT name FROM pragma_table_info('session_plans')")
      .toArray()
      .map((row) => row.name);
    expect(columnNames).toEqual(
      expect.arrayContaining(["status", "revision", "user_edited", "approved_by", "approved_at", "source"]),
    );
    const migrationRows = sql.exec("SELECT id FROM _schema_migrations WHERE id BETWEEN 136 AND 141").toArray();
    expect(migrationRows).toHaveLength(6);
  });

  it("upgrades existing session plans with a non-pending default status", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    for (let id = 1; id <= 135; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE session_plans (
        session_id TEXT NOT NULL,
        plan_prompt_id TEXT NOT NULL,
        implementation_prompt_id TEXT,
        markdown TEXT,
        excerpt TEXT NOT NULL,
        artifact_id TEXT,
        valid INTEGER NOT NULL DEFAULT 0,
        missing_reason TEXT,
        missing_headings_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, plan_prompt_id)
      )`,
    );
    sql.exec(
      `INSERT INTO session_plans (
        session_id, plan_prompt_id, markdown, excerpt, valid, created_at, updated_at
      ) VALUES ('s-legacy', 'p-plan', '# Legacy plan', 'Legacy plan', 1, 1000, 2000)`,
    );

    initSchema(sql);

    expect(getLatestSessionPlan(sql, "s-legacy")).toMatchObject({
      sessionId: "s-legacy",
      planPromptId: "p-plan",
      status: "none",
      revision: 0,
      userEdited: false,
    });
  });

  it("drops retired benchmark session columns from fresh DO schema", () => {
    initSchema(sql);
    const columns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    const names = columns.map((row) => row.name as string);

    expect(names).not.toContain("session_kind");
    expect(names).not.toContain("sandbox_profile_json");
  });

  it("defaults pre-field sessions to plan approval not required during migration", () => {
    const legacySql = createMockSqlStorage();
    legacySql.exec("CREATE TABLE _schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    legacySql.exec(`CREATE TABLE session (
      session_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    legacySql.exec(
      "INSERT INTO session (session_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
      "legacy-session",
      "u-1",
      Date.now(),
      Date.now(),
    );
    for (const migration of MIGRATIONS.filter(({ id }) => id < 136)) {
      legacySql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?)", migration.id, Date.now());
    }

    initSchema(legacySql);

    expect(getSession(legacySql, "legacy-session")?.planApprovalRequired).toBe(false);
  });

  it("D-59d — drops the dead verification_* DO cols", () => {
    initSchema(sql);
    const names = sql
      .exec("SELECT name FROM pragma_table_info('session')")
      .toArray()
      .map((row) => row.name as string);

    // Dropped: the dead verification_* mirror copies (superseded by qa_testing_*).
    expect(names).not.toContain("verification_state");
    expect(names).not.toContain("verification_attempt_count");
    expect(names).not.toContain("verification_max_attempts");

    // Retained: the qa_testing_* rename targets that own the verification axis now.
    expect(names).toContain("qa_testing_state");
    expect(names).toContain("qa_testing_attempt_count");
    expect(names).toContain("qa_testing_max_attempts");
  });

  it("D-59 residue fold — drops the remaining dead verification_* and done-state DO cols", () => {
    initSchema(sql);
    const names = sql
      .exec("SELECT name FROM pragma_table_info('session')")
      .toArray()
      .map((row) => row.name as string);

    // Dropped: the last dead verification_* mirror copies (superseded by qa_testing_*).
    expect(names).not.toContain("verification_result");
    expect(names).not.toContain("verification_needs_work_label");
    expect(names).not.toContain("verification_run_baseline");
    expect(names).not.toContain("verification_verdict_head_sha");

    // Dropped: done-state now comes from the pr_coordination spine projection.
    expect(names).not.toContain("review_loop_done_state");
    expect(names).not.toContain("arcanist_done_state");
    expect(names).not.toContain("arcanist_done_outcome");
    expect(names).not.toContain("arcanist_done_reasons_json");

    // Retained: the qa_testing_* rename targets that own the verification axis now.
    expect(names).toContain("qa_testing_result");
    expect(names).toContain("qa_testing_needs_work_label");
    expect(names).toContain("qa_testing_run_baseline");
    expect(names).toContain("qa_testing_verdict_head_sha");
  });

  it("drops retired benchmark session columns when legacy DOs wake up", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    for (let id = 1; id <= 116; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_kind TEXT NOT NULL DEFAULT 'repo',
        sandbox_profile_json TEXT,
        business_id TEXT
      )`,
    );

    initSchema(sql);

    const columns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    const names = columns.map((row) => row.name as string);
    expect(names).not.toContain("session_kind");
    expect(names).not.toContain("sandbox_profile_json");
    expect(names).toContain("business_id");

    const migrationRows = sql.exec("SELECT id FROM _schema_migrations WHERE id IN (117, 118) ORDER BY id").toArray();
    expect(migrationRows.map((row) => row.id)).toEqual([117, 118]);
  });

  it("marks retired benchmark column drop migrations when columns are already absent", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    for (let id = 1; id <= 116; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        business_id TEXT
      )`,
    );

    initSchema(sql);

    const migrationRows = sql.exec("SELECT id FROM _schema_migrations WHERE id IN (117, 118) ORDER BY id").toArray();
    expect(migrationRows.map((row) => row.id)).toEqual([117, 118]);
  });

  it("applies migration 38 to DOs that last woke up before manual PR review reasons", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    for (let id = 1; id <= 37; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active_prompt_id TEXT,
        codex_session_id TEXT,
        codex_session_agent TEXT
      )`,
    );
    sql.exec(
      `CREATE TABLE prompts (
        prompt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        completed_at INTEGER,
        error TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    sql.exec(
      `CREATE TABLE sandbox_state (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle'
      )`,
    );

    initSchema(sql);

    const sessionColumns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    expect(sessionColumns.map((row) => row.name)).toContain("pr_manual_review_reason");
    const migrationRows = sql.exec("SELECT id FROM _schema_migrations WHERE id = 38").toArray();
    expect(migrationRows).toHaveLength(1);
  });

  it("migration 97 backfills the legacy grace token into the N-generation list", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    // Mark everything through migration 96 (the ADD COLUMN) applied so only the
    // backfill (97) runs against a row written by the pre-list code.
    for (let id = 1; id <= 96; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE sandbox_state (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        prev_sandbox_auth_token_hash TEXT,
        prev_sandbox_auth_token_expires_at INTEGER,
        prev_sandbox_auth_token_hashes TEXT
      )`,
    );
    sql.exec(
      `INSERT INTO sandbox_state (session_id, prev_sandbox_auth_token_hash, prev_sandbox_auth_token_expires_at)
       VALUES ('s-legacy', 'deadbeefhash', 1781800000000)`,
    );
    // A row already on the new list must not be overwritten by the backfill.
    sql.exec(
      `INSERT INTO sandbox_state (session_id, prev_sandbox_auth_token_hash, prev_sandbox_auth_token_expires_at, prev_sandbox_auth_token_hashes)
       VALUES ('s-newlist', 'oldhash', 111, '[{"hash":"keepme","expiresAt":222}]')`,
    );

    initSchema(sql);

    const legacy = sql
      .exec("SELECT prev_sandbox_auth_token_hashes AS h FROM sandbox_state WHERE session_id = 's-legacy'")
      .toArray()[0];
    expect(JSON.parse(legacy.h as string)).toEqual([{ hash: "deadbeefhash", expiresAt: 1781800000000 }]);

    const newList = sql
      .exec("SELECT prev_sandbox_auth_token_hashes AS h FROM sandbox_state WHERE session_id = 's-newlist'")
      .toArray()[0];
    expect(JSON.parse(newList.h as string)).toEqual([{ hash: "keepme", expiresAt: 222 }]);
  });

  it("treats migration 18 as duplicate-safe when fresh schema already has title_tags", () => {
    sql.exec(
      `CREATE TABLE _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    for (let id = 1; id <= 17; id++) {
      sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 1)", id);
    }
    sql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        title TEXT,
        title_tags TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active_prompt_id TEXT
      )`,
    );
    sql.exec(
      `CREATE TABLE prompts (
        prompt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        completed_at INTEGER,
        error TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    sql.exec(
      `CREATE TABLE sandbox_state (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle'
      )`,
    );

    expect(() => initSchema(sql)).not.toThrow();

    const migrationRows = sql.exec("SELECT id FROM _schema_migrations WHERE id = 18").toArray();
    expect(migrationRows).toHaveLength(1);
    const sessionColumns = sql.exec("SELECT name FROM pragma_table_info('session')").toArray();
    expect(sessionColumns.map((row) => row.name)).toContain("title_tags");
  });
});

describe("session plans", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
  });

  it("creates, reads, transitions, and edits a plan revision", () => {
    upsertSessionPlan(sql, {
      sessionId: "s-1",
      planPromptId: "p-plan-1",
      implementationPromptId: null,
      markdown: "# Plan\n\nOriginal",
      excerpt: "Original",
      artifactId: "artifact-1",
      valid: false,
      missingReason: "invalid_plan",
      missingHeadings: ["Tests"],
      status: "pending",
      revision: 1,
      userEdited: false,
      approvedBy: null,
      approvedAt: null,
      source: "generated",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    });

    expect(getLatestSessionPlan(sql, "s-1")).toEqual({
      sessionId: "s-1",
      planPromptId: "p-plan-1",
      implementationPromptId: null,
      markdown: "# Plan\n\nOriginal",
      excerpt: "Original",
      artifactId: "artifact-1",
      valid: false,
      missingReason: "invalid_plan",
      missingHeadings: ["Tests"],
      status: "pending",
      revision: 1,
      userEdited: false,
      approvedBy: null,
      approvedAt: null,
      source: "generated",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    });

    expect(
      saveEditedPlanRevision(sql, {
        sessionId: "s-1",
        planPromptId: "p-plan-1",
        markdown: "# Plan\n\nEdited",
        excerpt: "Edited",
        expectedRevision: 1,
      }),
    ).toBe(true);
    expect(getLatestSessionPlan(sql, "s-1")).toMatchObject({
      markdown: "# Plan\n\nEdited",
      excerpt: "Edited",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      revision: 2,
      userEdited: true,
    });

    expect(
      updateSessionPlanStatus(sql, {
        sessionId: "s-1",
        planPromptId: "p-plan-1",
        status: "approved",
        approvedBy: "u-approver",
        approvedAt: 1_783_598_400_000,
        implementationPromptId: "p-implementation-1",
      }),
    ).toBe(true);
    expect(getLatestSessionPlan(sql, "s-1")).toMatchObject({
      status: "approved",
      approvedBy: "u-approver",
      approvedAt: "2026-07-09T12:00:00.000Z",
      implementationPromptId: "p-implementation-1",
    });
  });

  it("returns the highest revision, breaking ties by updated time", () => {
    const records = [
      { planPromptId: "p-revision-1", revision: 1, updatedAt: "2026-07-09T12:03:00.000Z" },
      { planPromptId: "p-revision-2-old", revision: 2, updatedAt: "2026-07-09T12:01:00.000Z" },
      { planPromptId: "p-revision-2-new", revision: 2, updatedAt: "2026-07-09T12:02:00.000Z" },
    ];
    for (const record of records) {
      upsertSessionPlan(sql, {
        sessionId: "s-1",
        planPromptId: record.planPromptId,
        implementationPromptId: null,
        markdown: `# ${record.planPromptId}`,
        excerpt: record.planPromptId,
        artifactId: null,
        valid: true,
        missingReason: null,
        missingHeadings: [],
        status: "pending",
        revision: record.revision,
        userEdited: false,
        approvedBy: null,
        approvedAt: null,
        source: "generated",
        createdAt: "2026-07-09T12:00:00.000Z",
        updatedAt: record.updatedAt,
      });
    }

    expect(getLatestSessionPlan(sql, "s-1")?.planPromptId).toBe("p-revision-2-new");
    expect(getLatestSessionPlan(sql, "missing")).toBeNull();
  });

  it("keeps legacy upsert callers on none status defaults", () => {
    upsertSessionPlan(sql, {
      sessionId: "s-legacy-caller",
      planPromptId: "p-plan",
      implementationPromptId: "p-implementation",
      markdown: "# Plan",
      excerpt: "Plan",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
    });

    expect(getLatestSessionPlan(sql, "s-legacy-caller")).toMatchObject({
      status: "none",
      revision: 0,
      userEdited: false,
      approvedBy: null,
      approvedAt: null,
      source: null,
    });
  });

  it("does not update a missing plan row", () => {
    expect(
      updateSessionPlanStatus(sql, {
        sessionId: "missing",
        planPromptId: "missing",
        status: "superseded",
      }),
    ).toBe(false);
    expect(
      saveEditedPlanRevision(sql, {
        sessionId: "missing",
        planPromptId: "missing",
        markdown: "# Plan",
        excerpt: "Plan",
        expectedRevision: 0,
      }),
    ).toBe(false);
  });

  it("only edits the expected pending revision", () => {
    upsertSessionPlan(sql, {
      sessionId: "s-cas",
      planPromptId: "p-plan",
      implementationPromptId: null,
      markdown: "# Plan\n\nOriginal",
      excerpt: "Original",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 3,
    });

    expect(
      saveEditedPlanRevision(sql, {
        sessionId: "s-cas",
        planPromptId: "p-plan",
        markdown: "# Plan\n\nStale",
        excerpt: "Stale",
        expectedRevision: 2,
      }),
    ).toBe(false);
    expect(getLatestSessionPlan(sql, "s-cas")).toMatchObject({ revision: 3, markdown: "# Plan\n\nOriginal" });

    updateSessionPlanStatus(sql, { sessionId: "s-cas", planPromptId: "p-plan", status: "approved" });
    expect(
      saveEditedPlanRevision(sql, {
        sessionId: "s-cas",
        planPromptId: "p-plan",
        markdown: "# Plan\n\nApproved",
        excerpt: "Approved",
        expectedRevision: 3,
      }),
    ).toBe(false);
    expect(getLatestSessionPlan(sql, "s-cas")).toMatchObject({ status: "approved", revision: 3 });
  });
});

describe("session CRUD", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
  });

  it("creates and reads a session", () => {
    const session = createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "u-1",
      businessId: "biz-1",
      model: "gpt-5.4-mini",
    });
    expect(session.sessionId).toBe("s-1");
    expect(session.ownerUserId).toBe("u-1");
    expect(session.businessId).toBe("biz-1");
    expect(session.status).toBe("active");
    expect(session.model).toBe("gpt-5.4-mini");

    const read = getSession(sql, "s-1");
    expect(read).not.toBeNull();
    expect(read!.sessionId).toBe("s-1");
    expect(read!.businessId).toBe("biz-1");
    expect(read!.status).toBe("active");
  });

  it("returns null for nonexistent session", () => {
    expect(getSession(sql, "nope")).toBeNull();
  });

  it("resolves the single session id for DO wake rehydration", () => {
    expect(getSessionIdForDo(sql)).toBeNull();
    createSession(sql, { sessionId: "s-wake", ownerUserId: "u-1" });
    expect(getSessionIdForDo(sql)).toBe("s-wake");
  });

  it("defaults the agent runtime backend to codex when unset", () => {
    const session = createSession(sql, { sessionId: "s-codex", ownerUserId: "u-1" });
    expect(session.agentRuntimeBackend).toBe("codex");
    expect(getSession(sql, "s-codex")!.agentRuntimeBackend).toBe("codex");
    expect(getSessionExtended(sql, "s-codex")?.agentRuntimeBackend).toBe("codex");
  });

  it("persists and reads back a non-default agent runtime backend", () => {
    const session = createSession(sql, {
      sessionId: "s-claude",
      ownerUserId: "u-1",
      agentRuntimeBackend: "claude_code",
    });
    expect(session.agentRuntimeBackend).toBe("claude_code");
    expect(getSession(sql, "s-claude")!.agentRuntimeBackend).toBe("claude_code");
    expect(getSessionExtended(sql, "s-claude")?.agentRuntimeBackend).toBe("claude_code");
  });

  it("persists and reads back a claude-session harness kind without nulling it", () => {
    const session = createSession(sql, {
      sessionId: "s-harness-claude",
      ownerUserId: "u-1",
      harnessKind: "claude-session",
    });
    expect(session.harnessKind).toBe("claude-session");
    expect(getSession(sql, "s-harness-claude")!.harnessKind).toBe("claude-session");
    expect(getSessionExtended(sql, "s-harness-claude")?.harnessKind).toBe("claude-session");
  });

  it("round-trips the codex-session harness kind", () => {
    createSession(sql, {
      sessionId: "s-harness-codex",
      ownerUserId: "u-1",
      harnessKind: "codex-session",
    });
    expect(getSession(sql, "s-harness-codex")!.harnessKind).toBe("codex-session");
    expect(getSessionExtended(sql, "s-harness-codex")?.harnessKind).toBe("codex-session");
  });

  it("normalizes an unknown persisted harness kind to null on read", () => {
    createSession(sql, { sessionId: "s-harness-bogus", ownerUserId: "u-1" });
    sql.exec("UPDATE session SET harness_kind = 'bogus' WHERE session_id = ?", "s-harness-bogus");
    expect(getSession(sql, "s-harness-bogus")!.harnessKind).toBeNull();
    expect(getSessionExtended(sql, "s-harness-bogus")?.harnessKind).toBeNull();
  });

  it("defaults auto-verify opt-out to disabled=false when unset", () => {
    const session = createSession(sql, { sessionId: "s-av-default", ownerUserId: "u-1" });
    expect(session.autoVerifyDisabled).toBe(false);
    expect(getSession(sql, "s-av-default")!.autoVerifyDisabled).toBe(false);
  });

  it("persists and reads back the auto-verify opt-out", () => {
    const session = createSession(sql, {
      sessionId: "s-av-optout",
      ownerUserId: "u-1",
      autoVerifyDisabled: true,
    });
    expect(session.autoVerifyDisabled).toBe(true);
    expect(getSession(sql, "s-av-optout")!.autoVerifyDisabled).toBe(true);
  });

  it("persists plan approval as immutable session-creation state", () => {
    const session = createSession(sql, {
      sessionId: "s-plan-approval",
      ownerUserId: "u-1",
      planMode: true,
      planApprovalRequired: true,
    });

    expect(session.planApprovalRequired).toBe(true);
    expect(getSession(sql, "s-plan-approval")!.planApprovalRequired).toBe(true);
    expect(getSessionExtended(sql, "s-plan-approval")?.planApprovalRequired).toBe(true);
  });

  it("reads sessions created without plan approval state as approval not required", () => {
    const session = createSession(sql, { sessionId: "s-plan-approval-legacy", ownerUserId: "u-1" });

    expect(session.planApprovalRequired).toBe(false);
    expect(getSession(sql, "s-plan-approval-legacy")!.planApprovalRequired).toBe(false);
    expect(getSessionExtended(sql, "s-plan-approval-legacy")?.planApprovalRequired).toBe(false);
  });

  it("defaults adopted-external-PR publish mode to false when unset", () => {
    const session = createSession(sql, { sessionId: "s-adopted-default", ownerUserId: "u-1" });
    expect(session.adoptedExternalPr).toBe(false);
    expect(getSession(sql, "s-adopted-default")!.adoptedExternalPr).toBe(false);
    expect(getSessionExtended(sql, "s-adopted-default")!.adoptedExternalPr).toBe(false);
  });

  it("persists and reads back adopted-external-PR publish mode", () => {
    const session = createSession(sql, {
      sessionId: "s-adopted-external",
      ownerUserId: "u-1",
      adoptedExternalPr: true,
    });
    expect(session.adoptedExternalPr).toBe(true);
    expect(getSession(sql, "s-adopted-external")!.adoptedExternalPr).toBe(true);
    expect(getSessionExtended(sql, "s-adopted-external")!.adoptedExternalPr).toBe(true);
  });

  it("round-trips the renamed agent session identity columns", () => {
    createSession(sql, { sessionId: "s-id", ownerUserId: "u-1" });
    updateSessionFields(sql, "s-id", {
      agentSessionId: "agent-session-xyz",
      agentSessionAgent: "build",
      agentRuntimeBackend: "claude_code",
    });
    const ext = getSessionExtended(sql, "s-id");
    expect(ext?.agentSessionId).toBe("agent-session-xyz");
    expect(ext?.agentSessionAgent).toBe("build");
    expect(ext?.agentRuntimeBackend).toBe("claude_code");
  });

  it("updates session metadata", () => {
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    updateSession(sql, "s-1", {
      title: "Test title",
      status: "archived",
      closedAt: new Date().toISOString(),
    });

    const read = getSession(sql, "s-1");
    expect(read!.title).toBe("Test title");
    expect(read!.status).toBe("archived");
    expect(read!.closedAt).not.toBeNull();

    const ext = getSessionExtended(sql, "s-1");
    expect(ext!.title).toBe("Test title");
  });

  it("reads and writes extended fields", () => {
    createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "u-1",
      repoOwner: "acme",
      repoName: "app",
      baseBranch: "main",
    });

    const ext = getSessionExtended(sql, "s-1");
    expect(ext).not.toBeNull();
    expect(ext!.repoOwner).toBe("acme");
    expect(ext!.repoName).toBe("app");
    expect(ext!.baseBranch).toBe("main");
    expect(ext!.promptCounter).toBe(0);

    // Defaults to null before any title is applied.
    expect(ext!.prTitleLastApplied).toBeNull();
    expect(ext!.ticketKey).toBeNull();

    updateSessionFields(sql, "s-1", {
      lastBranch: "feature-1",
      prUrl: "https://github.com/acme/app/pull/1",
      prNumber: 1,
      prDraft: true,
      prManualReviewReason: "Broad typecheck was resource-killed.",
      prTitleLastApplied: "Fix the thing",
      ticketKey: "ENG-9001",
      promptCounter: 5,
    });

    const ext2 = getSessionExtended(sql, "s-1");
    expect(ext2!.lastBranch).toBe("feature-1");
    expect(ext2!.prUrl).toBe("https://github.com/acme/app/pull/1");
    expect(ext2!.prNumber).toBe(1);
    expect(ext2!.prDraft).toBe(true);
    expect(ext2!.prManualReviewReason).toBe("Broad typecheck was resource-killed.");
    expect(ext2!.prTitleLastApplied).toBe("Fix the thing");
    expect(ext2!.ticketKey).toBe("ENG-9001");
    expect(ext2!.promptCounter).toBe(5);
  });

  it("round-trips every mapped extended session field through the shared field map", () => {
    createSession(sql, { sessionId: "s-shared-map", ownerUserId: "u-1" });
    const fieldValues = {
      repoOwner: "acme",
      repoName: "app",
      baseBranch: "main",
      startBranch: "feature/start",
      lastBranch: "feature/current",
      lastCommitSha: "abc123",
      prUrl: "https://github.com/acme/app/pull/1",
      prNumber: 1,
      prCreating: true,
      prDraft: false,
      prManualReviewReason: "Manual review required",
      prTitleLastApplied: "Fix the thing",
      ticketKey: "ARC-1",
      publishStatus: "published",
      publishStage: "done",
      publishError: "push failed",
      publishedBranch: "feature/current",
      publishAttempt: 2,
      publishSequence: 3,
      installationId: 123,
      promptCounter: 4,
      repoPrivate: true,
      callbackContext: { kind: "slack", channelId: "C1", threadTs: "1.0" },
      linearContext: { issueId: "lin-1", identifier: "ARC-1", url: "https://linear.app/acme/issue/ARC-1" },
      githubIssueContext: { owner: "acme", repo: "app", issueNumber: 9 },
      resolvedAgents: {
        build: {
          name: "build",
          description: "The default Cycloid coding agent.",
          mode: "primary",
        },
      },
      agentSessionId: "agent-session-1",
      agentSessionAgent: "implementation",
      agentRuntimeBackend: "claude_code",
      agentRole: "verification",
      agentProfile: "default",
      harnessKind: "claude-session",
      runtimeStartupProfile: "verification_ready_runtime",
      verificationRuntimeMode: "app_runtime",
      targetPrUrl: "https://github.com/acme/app/pull/2",
      planMode: true,
      planApprovalRequired: true,
      planAutoReason: "Multiple dependent changes.",
      adoptedExternalPr: true,
      publishingStartedAt: 1_800_000_000_000,
      spawnDurationMs: 1234,
      initiationMode: "automation",
      entrypoint: "scheduled",
      scheduledRuleId: "rule-1",
      ruleNameSnapshot: "Nightly",
      cronSnapshot: "0 9 * * *",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/app/pull/3",
      reviewListeningHeadSha: "def456",
      reviewListeningEnteredAt: 1_800_000_000_100,
      verificationState: "verification-in-progress",
      verificationResult: "needs-work",
      verificationNeedsWorkLabel: "verification-gap",
      verificationAttemptCount: 2,
      verificationMaxAttempts: 5,
      verificationRunBaseline: 1,
      verificationVerdictHeadSha: "head789",
    } as const;

    expect(SESSION_EXTENDED_FIELD_MAPPINGS.map((mapping) => mapping.key).sort()).toEqual(
      Object.keys(fieldValues).sort(),
    );

    const {
      planApprovalRequired,
      planAutoReason,
      initiationMode,
      entrypoint,
      scheduledRuleId,
      ruleNameSnapshot,
      cronSnapshot,
      ...writableFieldValues
    } = fieldValues;
    const readOnlyFieldValues = {
      planApprovalRequired,
      planAutoReason,
      initiationMode,
      entrypoint,
      scheduledRuleId,
      ruleNameSnapshot,
      cronSnapshot,
    };
    expect(
      SESSION_EXTENDED_FIELD_MAPPINGS.filter((mapping) => mapping.write)
        .map((mapping) => mapping.key)
        .sort(),
    ).toEqual(Object.keys(writableFieldValues).sort());

    updateSessionFields(sql, "s-shared-map", fieldValues);

    const ext = getSessionExtended(sql, "s-shared-map");
    expect(ext).toMatchObject(writableFieldValues);
    expect(ext).not.toMatchObject(readOnlyFieldValues);

    sql.exec(
      "UPDATE session SET plan_approval_required = ?, plan_auto_reason = ?, initiation_mode = ?, entrypoint = ?, scheduled_rule_id = ?, rule_name_snapshot = ?, cron_snapshot = ? WHERE session_id = ?",
      Number(planApprovalRequired),
      planAutoReason,
      initiationMode,
      entrypoint,
      scheduledRuleId,
      ruleNameSnapshot,
      cronSnapshot,
      "s-shared-map",
    );

    const extWithReadOnlyFields = getSessionExtended(sql, "s-shared-map");
    expect(extWithReadOnlyFields).toMatchObject(readOnlyFieldValues);
    expect(extWithReadOnlyFields).toMatchObject(fieldValues);
  });

  it("round-trips verification state and counters", () => {
    createSession(sql, { sessionId: "s-va", ownerUserId: "u-1" });

    expect(getSessionExtended(sql, "s-va")).toMatchObject({
      verificationState: null,
      verificationResult: null,
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
    });

    updateSessionFields(sql, "s-va", {
      verificationState: "verification-in-progress",
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
    });
    expect(sql.exec("SELECT qa_testing_state FROM session WHERE session_id = 's-va'").toArray()[0]).toMatchObject({
      qa_testing_state: "qa-in-progress",
    });
    expect(getSessionExtended(sql, "s-va")).toMatchObject({
      verificationState: "verification-in-progress",
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
    });

    updateSessionFields(sql, "s-va", {
      verificationState: "verification-done",
      verificationAttemptCount: 3,
      verificationMaxAttempts: 3,
    });
    expect(getSessionExtended(sql, "s-va")).toMatchObject({
      verificationState: "verification-done",
      verificationAttemptCount: 3,
      verificationMaxAttempts: 3,
    });

    updateSessionFields(sql, "s-va", { verificationState: null, verificationAttemptCount: 0 });
    expect(getSessionExtended(sql, "s-va")).toMatchObject({
      verificationState: null,
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
    });
  });

  it("does not read legacy verification columns for old session rows", () => {
    const legacySql = createMockSqlStorage();
    legacySql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        verification_state TEXT,
        verification_result TEXT,
        verification_needs_work_label TEXT,
        verification_attempt_count INTEGER NOT NULL DEFAULT 0,
        verification_max_attempts INTEGER NOT NULL DEFAULT 3,
        verification_run_baseline INTEGER NOT NULL DEFAULT 0,
        verification_verdict_head_sha TEXT
      )`,
    );
    legacySql.exec(
      `INSERT INTO session (
        session_id,
        owner_user_id,
        status,
        created_at,
        updated_at,
        verification_state,
        verification_result,
        verification_needs_work_label,
        verification_attempt_count,
        verification_max_attempts,
        verification_run_baseline,
        verification_verdict_head_sha
      ) VALUES (?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
      "s-va-legacy",
      "u-1",
      "verification-in-progress",
      "needs-work",
      "verification-gap",
      2,
      3,
      1,
      "legacy-head",
    );

    expect(getSessionExtended(legacySql, "s-va-legacy")).toMatchObject({
      verificationState: null,
      verificationResult: null,
      verificationNeedsWorkLabel: null,
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
      verificationRunBaseline: 0,
      verificationVerdictHeadSha: null,
    });
  });

  it("uses QA testing columns for the verification axis", () => {
    createSession(sql, { sessionId: "s-va-mixed", ownerUserId: "u-1" });
    // ARC-1330 D-59d dropped the dead `verification_state` / `verification_attempt_count` /
    // `verification_max_attempts` DO columns, and the D-59 residue fold (R1) dropped the last four
    // (`verification_result` / `verification_needs_work_label` / `verification_run_baseline` /
    // `verification_verdict_head_sha`). The verification axis now lives ENTIRELY in `qa_testing_*`; this
    // proves getSessionExtended reads it from there.
    sql.exec(
      `UPDATE session
       SET qa_testing_state = 'qa-done',
           qa_testing_result = 'merge-ready',
           qa_testing_needs_work_label = NULL,
           qa_testing_attempt_count = 3,
           qa_testing_max_attempts = 4,
           qa_testing_run_baseline = 2,
           qa_testing_verdict_head_sha = 'qa-head'
       WHERE session_id = ?`,
      "s-va-mixed",
    );

    expect(getSessionExtended(sql, "s-va-mixed")).toMatchObject({
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationNeedsWorkLabel: null,
      verificationAttemptCount: 3,
      verificationMaxAttempts: 4,
      verificationRunBaseline: 2,
      verificationVerdictHeadSha: "qa-head",
    });
  });

  it("round-trips verification result including null", () => {
    createSession(sql, { sessionId: "s-va-result", ownerUserId: "u-1" });

    expect(getSessionExtended(sql, "s-va-result")!.verificationResult).toBeNull();
    expect(getSessionExtended(sql, "s-va-result")!.verificationNeedsWorkLabel).toBeNull();

    updateSessionFields(sql, "s-va-result", { verificationResult: "merge-ready" });
    // The write lands on `qa_testing_result` (the residue fold dropped the legacy `verification_result` col).
    expect(
      sql.exec("SELECT qa_testing_result FROM session WHERE session_id = 's-va-result'").toArray()[0],
    ).toMatchObject({ qa_testing_result: "merge-ready" });
    expect(getSessionExtended(sql, "s-va-result")!.verificationResult).toBe("merge-ready");
    expect(getSessionExtended(sql, "s-va-result")!.verificationNeedsWorkLabel).toBeNull();

    updateSessionFields(sql, "s-va-result", {
      verificationResult: "needs-work",
      verificationNeedsWorkLabel: "verification-gap",
    });
    expect(getSessionExtended(sql, "s-va-result")!.verificationResult).toBe("needs-work");
    expect(getSessionExtended(sql, "s-va-result")!.verificationNeedsWorkLabel).toBe("verification-gap");

    updateSessionFields(sql, "s-va-result", { verificationResult: null, verificationNeedsWorkLabel: null });
    expect(getSessionExtended(sql, "s-va-result")!.verificationResult).toBeNull();
    expect(getSessionExtended(sql, "s-va-result")!.verificationNeedsWorkLabel).toBeNull();
  });

  it("returns the latest session close reason from the durable event log", () => {
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    appendEventsWithReplay(sql, "s-1", [
      { type: "session_closed", data: { reason: "user_closed" } },
      { type: "session_closed", data: { reason: "pr_merged" } },
    ]);

    expect(getLatestSessionCloseReason(sql, "s-1")).toBe("pr_merged");
  });

  it("returns null when no session close event exists", () => {
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });

    expect(getLatestSessionCloseReason(sql, "s-1")).toBeNull();
  });
});

describe("platform LLM capability DAO", () => {
  let sql: SqlStorage;
  const baseCapability = {
    idHash: "hash-1",
    sessionId: "s-1",
    sandboxId: "sandbox-1",
    promptId: "p-1",
    callType: "pr_template_fill" as const,
    phase: "post_execution" as const,
    expiresAt: 2_000,
    createdAt: 1_000,
  };

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
  });

  it("inserts and reads a platform LLM capability without storing the raw token", () => {
    insertPlatformLlmCapability(sql, baseCapability);
    const record = getPlatformLlmCapability(sql, "hash-1");
    expect(record).toEqual({
      ...baseCapability,
      usedAt: null,
    });
  });

  it("consumes a capability once and increments the per-prompt budget", () => {
    insertPlatformLlmCapability(sql, baseCapability);

    const consumed = consumePlatformLlmCapability(sql, {
      idHash: "hash-1",
      sessionId: "s-1",
      sandboxId: "sandbox-1",
      callType: "pr_template_fill",
      phase: "post_execution",
      now: 1_500,
      perPromptBudget: 1,
    });

    expect(consumed).toMatchObject({ ok: true, budgetUsed: 1 });
    expect(getPlatformLlmCapability(sql, "hash-1")?.usedAt).toBe(1_500);

    const reused = consumePlatformLlmCapability(sql, {
      idHash: "hash-1",
      sessionId: "s-1",
      sandboxId: "sandbox-1",
      callType: "pr_template_fill",
      phase: "post_execution",
      now: 1_600,
      perPromptBudget: 1,
    });
    expect(reused).toEqual({ ok: false, category: "capability_consumed" });
  });

  it("does not issue raw SQL transaction statements when consuming a capability", () => {
    insertPlatformLlmCapability(sql, baseCapability);

    const rawTransactionRejectingSql = {
      ...sql,
      exec(query: string, ...params: unknown[]) {
        const normalized = query.trimStart().toUpperCase();
        if (
          normalized.startsWith("BEGIN") ||
          normalized.startsWith("COMMIT") ||
          normalized.startsWith("ROLLBACK") ||
          normalized.startsWith("SAVEPOINT")
        ) {
          throw new Error(`Raw SQL transaction statement is not allowed: ${query}`);
        }
        return sql.exec(query, ...params);
      },
    } as SqlStorage;

    const consumed = consumePlatformLlmCapability(rawTransactionRejectingSql, {
      idHash: "hash-1",
      sessionId: "s-1",
      sandboxId: "sandbox-1",
      callType: "pr_template_fill",
      phase: "post_execution",
      now: 1_500,
      perPromptBudget: 1,
    });

    expect(consumed).toMatchObject({ ok: true, budgetUsed: 1 });
  });

  it("rolls back capability consumption and budget increments inside transactionSync", () => {
    const transactionalSql = createMockSqlStorage();
    initSchema(transactionalSql);
    insertPlatformLlmCapability(transactionalSql, baseCapability);

    expect(() =>
      transactionalSql.transactionSync(() => {
        consumePlatformLlmCapability(transactionalSql, {
          idHash: "hash-1",
          sessionId: "s-1",
          sandboxId: "sandbox-1",
          callType: "pr_template_fill",
          phase: "post_execution",
          now: 1_500,
          perPromptBudget: 1,
        });
        throw new Error("force rollback");
      }),
    ).toThrow("force rollback");

    expect(getPlatformLlmCapability(transactionalSql, "hash-1")?.usedAt).toBeNull();
    expect(getPlatformLlmBudgetUsed(transactionalSql, "p-1", "pr_template_fill")).toBe(0);
  });

  it("rejects expired, wrong sandbox, wrong phase, and wrong call type capabilities", () => {
    insertPlatformLlmCapability(sql, baseCapability);
    expect(
      consumePlatformLlmCapability(sql, {
        idHash: "hash-1",
        sessionId: "s-1",
        sandboxId: "sandbox-1",
        callType: "pr_template_fill",
        phase: "post_execution",
        now: 2_001,
        perPromptBudget: 1,
      }),
    ).toEqual({ ok: false, category: "capability_expired" });

    insertPlatformLlmCapability(sql, { ...baseCapability, idHash: "hash-2" });
    expect(
      consumePlatformLlmCapability(sql, {
        idHash: "hash-2",
        sessionId: "s-1",
        sandboxId: "sandbox-2",
        callType: "pr_template_fill",
        phase: "post_execution",
        now: 1_500,
        perPromptBudget: 1,
      }),
    ).toEqual({ ok: false, category: "capability_invalid" });

    insertPlatformLlmCapability(sql, { ...baseCapability, idHash: "hash-3" });
    expect(
      consumePlatformLlmCapability(sql, {
        idHash: "hash-3",
        sessionId: "s-1",
        sandboxId: "sandbox-1",
        callType: "pr_template_fill",
        phase: "prompt_preparation",
        now: 1_500,
        perPromptBudget: 1,
      }),
    ).toEqual({ ok: false, category: "wrong_phase" });

    insertPlatformLlmCapability(sql, { ...baseCapability, idHash: "hash-4" });
    expect(
      consumePlatformLlmCapability(sql, {
        idHash: "hash-4",
        sessionId: "s-1",
        sandboxId: "sandbox-1",
        callType: "commit_message" as never,
        phase: "post_execution",
        now: 1_500,
        perPromptBudget: 1,
      }),
    ).toEqual({ ok: false, category: "wrong_call_type" });
  });

  it("rejects budget exhaustion without consuming the capability", () => {
    incrementPlatformLlmBudget(sql, "p-1", "pr_template_fill");
    insertPlatformLlmCapability(sql, baseCapability);

    const result = consumePlatformLlmCapability(sql, {
      idHash: "hash-1",
      sessionId: "s-1",
      sandboxId: "sandbox-1",
      callType: "pr_template_fill",
      phase: "post_execution",
      now: 1_500,
      perPromptBudget: 1,
    });

    expect(result).toEqual({ ok: false, category: "budget_exhausted" });
    expect(getPlatformLlmCapability(sql, "hash-1")?.usedAt).toBeNull();
    expect(getPlatformLlmBudgetUsed(sql, "p-1", "pr_template_fill")).toBe(1);
  });

  it("revokes prompt capabilities and purges expired rows", () => {
    insertPlatformLlmCapability(sql, baseCapability);
    insertPlatformLlmCapability(sql, {
      ...baseCapability,
      idHash: "hash-other-session",
      sessionId: "s-2",
    });
    insertPlatformLlmCapability(sql, {
      ...baseCapability,
      idHash: "hash-2",
      promptId: "p-2",
      expiresAt: 1_100,
    });

    expect(revokePromptCapabilities(sql, "p-1", 1_500, "s-1")).toBe(1);
    expect(getPlatformLlmCapability(sql, "hash-1")?.usedAt).toBe(1_500);
    expect(getPlatformLlmCapability(sql, "hash-other-session")?.usedAt).toBeNull();
    expect(purgeExpiredCapabilities(sql, 1_200)).toBe(1);
    expect(getPlatformLlmCapability(sql, "hash-2")).toBeNull();
  });

  it("upserts and reads prompt post-execution broker status", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "executing",
      updatedAt: 1_000,
    });
    expect(getPlatformLlmPromptStatus(sql, "p-1")).toEqual({
      promptId: "p-1",
      sessionId: "s-1",
      status: "executing",
      updatedAt: 1_000,
      startedAt: null,
    });

    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "post_execution_pending",
      updatedAt: 2_000,
    });
    expect(getPlatformLlmPromptStatus(sql, "p-1")).toMatchObject({
      status: "post_execution_pending",
      updatedAt: 2_000,
    });
    expect(getPlatformLlmPromptStatus(sql, "missing")).toBeNull();
  });
});

describe("serializePromptRow", () => {
  const basePrompt = {
    promptId: "p-1",
    prompt: "Fix the bug",
    actorUserId: "u-1",
    status: "queued" as const,
    createdAt: "2024-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2024-01-01T00:00:01.000Z",
    result: null,
    error: null,
  };

  it("returns one value per PROMPT_INSERT_COLUMNS entry", () => {
    const values = serializePromptRow(basePrompt, "s-1", 0);
    expect(values).toHaveLength(PROMPT_INSERT_COLUMNS.length);
  });

  it("places values at positions matching column order", () => {
    const createdMs = Date.parse("2024-01-01T00:00:00.000Z");
    const updatedMs = Date.parse("2024-01-01T00:00:01.000Z");
    const values = serializePromptRow(basePrompt, "s-1", 3);

    const idx = (col: string) => PROMPT_INSERT_COLUMNS.indexOf(col as (typeof PROMPT_INSERT_COLUMNS)[number]);

    expect(values[idx("prompt_id")]).toBe("p-1");
    expect(values[idx("session_id")]).toBe("s-1");
    expect(values[idx("prompt_text")]).toBe("Fix the bug");
    expect(values[idx("reply_to_quote_source_json")]).toBeNull();
    expect(values[idx("actor_user_id")]).toBe("u-1");
    expect(values[idx("agent")]).toBeNull();
    expect(values[idx("status")]).toBe("queued");
    expect(values[idx("created_at")]).toBe(createdMs);
    expect(values[idx("started_at")]).toBeNull();
    expect(values[idx("completed_at")]).toBeNull();
    expect(values[idx("updated_at")]).toBe(updatedMs);
    expect(values[idx("error")]).toBeNull();
    expect(values[idx("result_json")]).toBeNull();
    expect(values[idx("queue_position")]).toBe(3);
    expect(values[idx("skills_json")]).toBeNull();
    expect(values[idx("files_json")]).toBeNull();
    expect(values[idx("uploaded_files_json")]).toBeNull();
    expect(values[idx("uploaded_images_json")]).toBeNull();
    expect(values[idx("review_loop_epoch_id")]).toBeNull();
    expect(values[idx("review_loop_source_kind")]).toBeNull();
    expect(values[idx("is_plan_prompt")]).toBe(0);
  });

  it("serializes the isPlanPrompt marker as 1", () => {
    const values = serializePromptRow({ ...basePrompt, isPlanPrompt: true }, "s-1", 0);
    const idx = (col: string) => PROMPT_INSERT_COLUMNS.indexOf(col as (typeof PROMPT_INSERT_COLUMNS)[number]);
    expect(values[idx("is_plan_prompt")]).toBe(1);
  });

  it("serializes review-loop metadata", () => {
    const values = serializePromptRow(
      {
        ...basePrompt,
        reviewLoopEpochId: "epoch-1",
        reviewLoopSourceKind: "human",
      },
      "s-1",
      0,
    );

    expect(values[PROMPT_INSERT_COLUMNS.indexOf("review_loop_epoch_id")]).toBe("epoch-1");
    expect(values[PROMPT_INSERT_COLUMNS.indexOf("review_loop_source_kind")]).toBe("human");
  });

  it("serializes optional agent field -- present vs absent", () => {
    const withAgent = serializePromptRow({ ...basePrompt, agent: "build" }, "s-1", 0);
    const withoutAgent = serializePromptRow(basePrompt, "s-1", 0);
    const agentIdx = PROMPT_INSERT_COLUMNS.indexOf("agent");

    expect(withAgent[agentIdx]).toBe("build");
    expect(withoutAgent[agentIdx]).toBeNull();
  });

  it("serializes optional arrays as JSON strings", () => {
    const skills = ["review-spec", "ship-prod"];
    const files = ["README.md", "src/index.ts"];
    const uploadedFiles = [{ name: "a.txt", url: "https://example.com/a.txt" }];
    const uploadedImages = [{ name: "img.png", url: "https://example.com/img.png" }];

    const values = serializePromptRow(
      { ...basePrompt, skills, files, uploadedFiles, uploadedImages } as typeof basePrompt & {
        skills: string[];
        files: string[];
        uploadedFiles: typeof uploadedFiles;
        uploadedImages: typeof uploadedImages;
      },
      "s-1",
      0,
    );

    const filesIdx = PROMPT_INSERT_COLUMNS.indexOf("files_json");
    const skillsIdx = PROMPT_INSERT_COLUMNS.indexOf("skills_json");
    const ufIdx = PROMPT_INSERT_COLUMNS.indexOf("uploaded_files_json");
    const uiIdx = PROMPT_INSERT_COLUMNS.indexOf("uploaded_images_json");

    expect(JSON.parse(values[skillsIdx] as string)).toEqual(skills);
    expect(JSON.parse(values[filesIdx] as string)).toEqual(files);
    expect(JSON.parse(values[ufIdx] as string)).toEqual(uploadedFiles);
    expect(JSON.parse(values[uiIdx] as string)).toEqual(uploadedImages);
  });

  it("serializes reply quote source as JSON", () => {
    const replyToQuoteSource = {
      lines: [[{ type: "text", text: "literal <@U123>" }]],
    } as const;

    const values = serializePromptRow({ ...basePrompt, replyToQuoteSource }, "s-1", 0);
    const sourceIdx = PROMPT_INSERT_COLUMNS.indexOf("reply_to_quote_source_json");

    expect(JSON.parse(values[sourceIdx] as string)).toEqual(replyToQuoteSource);
  });

  it("serializes result as JSON", () => {
    const result = { ok: true, data: [1, 2, 3] };
    const values = serializePromptRow({ ...basePrompt, result }, "s-1", 0);
    const resultIdx = PROMPT_INSERT_COLUMNS.indexOf("result_json");

    expect(JSON.parse(values[resultIdx] as string)).toEqual(result);
  });

  it("converts ISO timestamps to Unix milliseconds", () => {
    const startedAt = "2024-06-15T12:00:00.000Z";
    const completedAt = "2024-06-15T12:05:00.000Z";
    const values = serializePromptRow({ ...basePrompt, startedAt, completedAt }, "s-1", 0);

    const startIdx = PROMPT_INSERT_COLUMNS.indexOf("started_at");
    const endIdx = PROMPT_INSERT_COLUMNS.indexOf("completed_at");

    expect(values[startIdx]).toBe(Date.parse(startedAt));
    expect(values[endIdx]).toBe(Date.parse(completedAt));
  });

  it("passes the queue_position through unchanged", () => {
    const qpIdx = PROMPT_INSERT_COLUMNS.indexOf("queue_position");

    expect(serializePromptRow(basePrompt, "s-1", 0)[qpIdx]).toBe(0);
    expect(serializePromptRow(basePrompt, "s-1", 7)[qpIdx]).toBe(7);
  });
});

describe("prompts", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
  });

  it("creates and lists prompts", () => {
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "Fix the bug",
      replyToText: "> Fix the bug",
      actorUserId: "u-1",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });

    const prompts = getPrompts(sql, "s-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].promptId).toBe("p-1");
    expect(prompts[0].prompt).toBe("Fix the bug");
    expect(prompts[0].replyToText).toBe("> Fix the bug");
    expect(prompts[0].status).toBe("queued");
  });

  it("round-trips reply quote source", () => {
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "Fix the bug",
      replyToText: "> literal <@U123>",
      replyToQuoteSource: { lines: [[{ type: "text", text: "literal <@U123>" }]] },
      actorUserId: "u-1",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });

    const prompt = getPrompt(sql, "p-1");
    expect(prompt?.replyToQuoteSource).toEqual({ lines: [[{ type: "text", text: "literal <@U123>" }]] });
  });

  it("round-trips review-loop metadata", () => {
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "Review the PR",
      actorUserId: "u-1",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
      reviewLoopEpochId: "epoch-1",
      reviewLoopSourceKind: "mixed",
    });

    const prompt = getPrompt(sql, "p-1");
    expect(prompt?.reviewLoopEpochId).toBe("epoch-1");
    expect(prompt?.reviewLoopSourceKind).toBe("mixed");
  });

  it("round-trips merge-conflict review-loop metadata", () => {
    insertPrompt(sql, "s-1", {
      promptId: "p-merge",
      prompt: "Resolve merge conflict",
      actorUserId: "u-1",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
      reviewLoopEpochId: "epoch-merge",
      reviewLoopSourceKind: "merge_conflict",
    });

    const prompt = getPrompt(sql, "p-merge");
    expect(prompt?.reviewLoopEpochId).toBe("epoch-merge");
    expect(prompt?.reviewLoopSourceKind).toBe("merge_conflict");
  });

  it("updates prompt status", () => {
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "Fix the bug",
      actorUserId: "u-1",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });

    updatePrompt(sql, "p-1", { status: "processing", startedAt: new Date().toISOString() });
    const p = getPrompt(sql, "p-1");
    expect(p!.status).toBe("processing");
    expect(p!.startedAt).not.toBeNull();
  });

  it("bulk updates prompts", () => {
    const now = new Date().toISOString();
    const prompts = [
      {
        promptId: "p-1",
        prompt: "First",
        actorUserId: "u-1",
        status: "completed" as const,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        result: { ok: true },
        error: null,
      },
      {
        promptId: "p-2",
        prompt: "Second",
        actorUserId: "u-1",
        status: "queued" as const,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        result: null,
        error: null,
      },
    ];
    bulkUpdatePrompts(sql, "s-1", prompts);

    const all = getPrompts(sql, "s-1");
    expect(all).toHaveLength(2);
    expect(all[0].promptId).toBe("p-1");
    expect(all[0].status).toBe("completed");
    expect(all[1].promptId).toBe("p-2");
    expect(all[1].status).toBe("queued");
  });

  it("bulk updates prompts in the provided array order even when created_at would sort differently", () => {
    const now = Date.now();
    const prompts = [
      {
        promptId: "p-2",
        prompt: "Retry prompt",
        actorUserId: "u-1",
        status: "processing" as const,
        createdAt: new Date(now + 5_000).toISOString(),
        startedAt: new Date(now + 5_000).toISOString(),
        completedAt: null,
        updatedAt: new Date(now + 5_000).toISOString(),
        result: null,
        error: null,
      },
      {
        promptId: "p-1",
        prompt: "Older queued prompt",
        actorUserId: "u-1",
        status: "queued" as const,
        createdAt: new Date(now).toISOString(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(now).toISOString(),
        result: null,
        error: null,
      },
    ];

    bulkUpdatePrompts(sql, "s-1", prompts);

    const all = getPrompts(sql, "s-1");
    expect(all.map((prompt) => prompt.promptId)).toEqual(["p-2", "p-1"]);
  });

  it("reads has_pending_question through getPromptHasPendingQuestion", () => {
    const now = new Date().toISOString();
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "First",
      actorUserId: "u-1",
      status: "processing",
      createdAt: now,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      result: null,
      error: null,
    });

    expect(getPromptHasPendingQuestion(sql, "p-1")).toBe(false);
    updatePrompt(sql, "p-1", { hasPendingQuestion: true });
    expect(getPromptHasPendingQuestion(sql, "p-1")).toBe(true);
    updatePrompt(sql, "p-1", { hasPendingQuestion: false });
    expect(getPromptHasPendingQuestion(sql, "p-1")).toBe(false);
    expect(getPromptHasPendingQuestion(sql, "missing")).toBe(false);
  });

  it("bulk updates prompts without clearing has_pending_question on existing rows", () => {
    const now = new Date().toISOString();
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "First",
      actorUserId: "u-1",
      status: "processing",
      createdAt: now,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      result: null,
      error: null,
    });
    updatePrompt(sql, "p-1", { hasPendingQuestion: true });

    const prompts = getPrompts(sql, "s-1");
    prompts.push({
      promptId: "p-2",
      prompt: "Second",
      actorUserId: "u-1",
      status: "queued",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      result: null,
      error: null,
    });

    bulkUpdatePrompts(sql, "s-1", prompts);

    const rows = sql
      .exec("SELECT prompt_id, has_pending_question FROM prompts WHERE session_id = ? ORDER BY prompt_id ASC", "s-1")
      .toArray();
    expect(rows).toEqual([
      { prompt_id: "p-1", has_pending_question: 1 },
      { prompt_id: "p-2", has_pending_question: 0 },
    ]);
  });
});

describe("events", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
  });

  it("appends and retrieves events", () => {
    const events = appendEventsWithReplay(
      sql,
      "s-1",
      [
        { type: "prompt_processing", data: { promptId: "p-1" } },
        { type: "text", data: { id: "part-1", text: "Hello" } },
      ],
      "p-1",
    ).newEvents;

    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe("prompt_processing");
    expect(events[1].sequence).toBe(2);

    const all = getEvents(sql, "s-1");
    expect(all).toHaveLength(2);
  });

  it("paginates with afterSequence", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "a" }, { type: "b" }, { type: "c" }]);

    const page = getEvents(sql, "s-1", { afterSequence: 1 });
    expect(page).toHaveLength(2);
    expect(page[0].type).toBe("b");
  });

  it("tracks last event sequence", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "a" }, { type: "b" }]);
    expect(getLastEventSequence(sql, "s-1")).toBe(2);
  });

  it("returns valid replay state", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "a" }]);
    const replay = getReplayState(sql, "s-1");
    expect(replay.sessionId).toBe("s-1");
    expect(replay.lastEventSequence).toBe(1);
    expect(replay.lastEventTimestamp).not.toBeNull();
  });

  it("filters events by promptId", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "a", data: {} }]);
    appendEventsWithReplay(sql, "s-1", [{ type: "b", data: {} }], "p-1");

    const filtered = getEvents(sql, "s-1", { promptId: "p-1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe("b");
  });

  it("derives promptId per event from entry data", () => {
    appendEventsWithReplay(sql, "s-1", [
      { type: "prompt_failed", data: { promptId: "p-1", status: "failed" } },
      { type: "prompt_processing", data: { promptId: "p-2", status: "processing" } },
    ]);

    const rows = sql.exec("SELECT prompt_id FROM events WHERE session_id = ? ORDER BY sequence ASC", "s-1").toArray();
    expect(rows).toEqual([{ prompt_id: "p-1" }, { prompt_id: "p-2" }]);
  });

  it("normalizes empty-string promptId to the caller promptId", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "prompt_failed", data: { promptId: "", status: "failed" } }], "p-1");

    const rows = sql
      .exec("SELECT prompt_id, data_json FROM events WHERE session_id = ? ORDER BY sequence ASC", "s-1")
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt_id).toBe("p-1");
    expect(JSON.parse(rows[0]?.data_json as string)).toMatchObject({ promptId: "p-1" });
  });

  it("ignores duplicate explicit event IDs without consuming a sequence", () => {
    appendEventsWithReplay(
      sql,
      "s-1",
      [{ type: "question", eventId: "ack:s-1:prompt-1:question:1", data: { id: "q-1" } }],
      "prompt-1",
    );
    appendEventsWithReplay(
      sql,
      "s-1",
      [{ type: "question", eventId: "ack:s-1:prompt-1:question:1", data: { id: "q-1" } }],
      "prompt-1",
    );
    appendEventsWithReplay(sql, "s-1", [{ type: "prompt_processing", data: { promptId: "prompt-2" } }], "prompt-2");

    const rows = sql
      .exec("SELECT sequence, event_id, prompt_id, type FROM events WHERE session_id = ? ORDER BY sequence ASC", "s-1")
      .toArray();
    expect(rows).toEqual([
      {
        sequence: 1,
        event_id: "ack:s-1:prompt-1:question:1",
        prompt_id: "prompt-1",
        type: "question",
      },
      {
        sequence: 2,
        event_id: "event-2",
        prompt_id: "prompt-2",
        type: "prompt_processing",
      },
    ]);
  });

  it("dedupes mixed explicit event ID batches without prechecking each event", () => {
    appendEventsWithReplay(
      sql,
      "s-1",
      [{ type: "already-stored", eventId: "ack:s-1:prompt-1:text:1", data: { id: "stored" } }],
      "prompt-1",
    );

    const noPerEventExistenceSelectSql = {
      ...sql,
      exec(query: string, ...params: unknown[]) {
        if (
          /SELECT\s+sequence,\s*event_id,\s*type,\s*created_at,\s*data_json\s+FROM\s+events\s+WHERE\s+event_id\s+=\s+\?/i.test(
            query,
          )
        ) {
          throw new Error("appendEvents should not precheck each explicit event ID");
        }
        return sql.exec(query, ...params);
      },
    } as SqlStorage;

    const result = appendEventsWithReplay(
      noPerEventExistenceSelectSql,
      "s-1",
      [
        { type: "duplicate-existing", eventId: "ack:s-1:prompt-1:text:1", data: { id: "stored" } },
        { type: "new-explicit", eventId: "ack:s-1:prompt-1:text:2", data: { id: "new" } },
        { type: "duplicate-in-batch", eventId: "ack:s-1:prompt-1:text:2", data: { id: "new-again" } },
        { type: "generated", data: { id: "generated" } },
      ],
      "prompt-1",
    );

    expect(result.newEvents.map((event) => ({ sequence: event.sequence, id: event.id, type: event.type }))).toEqual([
      { sequence: 2, id: "ack:s-1:prompt-1:text:2", type: "new-explicit" },
      { sequence: 3, id: "event-3", type: "generated" },
    ]);
    expect(result.newReplayEvents.map((event) => ({ sequence: event.sequence, type: event.type }))).toEqual([
      { sequence: 2, type: "new-explicit" },
      { sequence: 3, type: "generated" },
    ]);

    const rows = sql
      .exec("SELECT sequence, event_id, type FROM events WHERE session_id = ? ORDER BY sequence ASC", "s-1")
      .toArray();
    expect(rows).toEqual([
      { sequence: 1, event_id: "ack:s-1:prompt-1:text:1", type: "already-stored" },
      { sequence: 2, event_id: "ack:s-1:prompt-1:text:2", type: "new-explicit" },
      { sequence: 3, event_id: "event-3", type: "generated" },
    ]);
  });

  it("continues generated event ID allocation after an explicit event-N collision", () => {
    const result = appendEventsWithReplay(sql, "s-1", [
      { type: "explicit-future-generated-id", eventId: "event-2", data: { id: "explicit" } },
      { type: "first-generated", data: { id: "first-generated" } },
      { type: "second-generated", data: { id: "second-generated" } },
    ]);

    expect(result.newEvents.map((event) => ({ sequence: event.sequence, id: event.id, type: event.type }))).toEqual([
      { sequence: 1, id: "event-2", type: "explicit-future-generated-id" },
      { sequence: 3, id: "event-3", type: "first-generated" },
      { sequence: 4, id: "event-4", type: "second-generated" },
    ]);
    expect(result.newReplayEvents.map((event) => ({ sequence: event.sequence, type: event.type }))).toEqual([
      { sequence: 1, type: "explicit-future-generated-id" },
      { sequence: 3, type: "first-generated" },
      { sequence: 4, type: "second-generated" },
    ]);

    const rows = sql
      .exec("SELECT sequence, event_id, type FROM events WHERE session_id = ? ORDER BY sequence ASC", "s-1")
      .toArray();
    expect(rows).toEqual([
      { sequence: 1, event_id: "event-2", type: "explicit-future-generated-id" },
      { sequence: 3, event_id: "event-3", type: "first-generated" },
      { sequence: 4, event_id: "event-4", type: "second-generated" },
    ]);
  });

  it("appends generated event ID batches with unchanged replay metadata", () => {
    const result = appendEventsWithReplay(sql, "s-1", [
      { type: "first-generated", data: { id: "one" } },
      { type: "second-generated", data: { id: "two" } },
    ]);

    expect(result.newEvents.map((event) => ({ sequence: event.sequence, id: event.id, type: event.type }))).toEqual([
      { sequence: 1, id: "event-1", type: "first-generated" },
      { sequence: 2, id: "event-2", type: "second-generated" },
    ]);
    expect(result.newReplayEvents).toEqual([
      { sequence: 1, type: "first-generated", data: { id: "one" } },
      { sequence: 2, type: "second-generated", data: { id: "two" } },
    ]);
  });

  it("preserves the resolved promptId on replay transport events", () => {
    const projected = projectCycloidEventToDurableEntry({
      phase: "prompt.dispatch",
      sessionId: "s-1",
      timestampMs: 1_713_456_789_000,
      payload: {
        startupAttemptId: null,
        bridgeEventType: "prompt_accepted",
        bridgeData: {},
      },
    });
    expect(projected).not.toBeNull();

    const { newReplayEvents } = appendEventsWithReplay(sql, "s-1", [projected!], "prompt-outer");
    expect(newReplayEvents).toHaveLength(1);
    expect(newReplayEvents[0]).toMatchObject({
      phase: "prompt.dispatch",
      promptId: "prompt-outer",
      sequence: 1,
    });

    expect(getReplayEvents(sql, "s-1", { limit: 1 })).toMatchObject([
      {
        phase: "prompt.dispatch",
        promptId: "prompt-outer",
        sequence: 1,
      },
    ]);
  });

  it("sanitizes transport error payloads before replay storage and readback", () => {
    const projected = projectCycloidEventToDurableEntry({
      phase: "error",
      sessionId: "s-1",
      promptId: "prompt-1",
      timestampMs: 1_713_456_789_000,
      payload: {
        message: "API error",
        code: "api_error",
        details: {
          message: "fetch failed",
          stack: "Error: fetch failed\n    at sandbox",
          responseBodyPreview: '{"error":"invalid_api_key"}',
          raw: '{"secret":"value"}',
          statusCode: 401,
        },
        bridgeData: {
          errorDetails: {
            message: "fetch failed",
            stack: "Error: fetch failed\n    at sandbox",
            responseBodyPreview: '{"error":"invalid_api_key"}',
            raw: '{"secret":"value"}',
            statusCode: 401,
          },
        },
      },
    });
    expect(projected).not.toBeNull();

    const { newReplayEvents } = appendEventsWithReplay(sql, "s-1", [projected!]);
    expect(newReplayEvents).toHaveLength(1);
    expect(newReplayEvents[0]).toMatchObject({
      phase: "error",
      payload: {
        message: "API error",
        code: "api_error",
        details: {
          message: "fetch failed",
          statusCode: 401,
        },
        bridgeData: {
          errorDetails: {
            message: "fetch failed",
            statusCode: 401,
          },
        },
      },
    });
    expect((newReplayEvents[0].payload as Record<string, unknown>).details).not.toHaveProperty("stack");
    expect((newReplayEvents[0].payload as Record<string, unknown>).details).not.toHaveProperty("responseBodyPreview");
    expect((newReplayEvents[0].payload as Record<string, unknown>).details).not.toHaveProperty("raw");

    expect(getReplayEvents(sql, "s-1", { limit: 1 })).toMatchObject([
      {
        phase: "error",
        payload: {
          message: "API error",
          code: "api_error",
          details: {
            message: "fetch failed",
            statusCode: 401,
          },
          bridgeData: {
            errorDetails: {
              message: "fetch failed",
              statusCode: 401,
            },
          },
        },
        sequence: 1,
      },
    ]);
  });

  it("sanitizes prompt.complete error details before replay storage and readback", () => {
    const projected = projectCycloidEventToDurableEntry({
      phase: "prompt.complete",
      sessionId: "s-1",
      promptId: "prompt-1",
      timestampMs: 1_713_456_789_000,
      payload: {
        success: false,
        error: "API error",
        errorCode: "api_error",
        errorDetails: {
          message: "fetch failed",
          stack: "Error: fetch failed\n    at sandbox",
          responseBodyPreview: '{"error":"invalid_api_key"}',
          raw: '{"secret":"value"}',
          statusCode: 401,
        },
        bridgeData: {
          errorDetails: {
            message: "fetch failed",
            stack: "Error: fetch failed\n    at sandbox",
            responseBodyPreview: '{"error":"invalid_api_key"}',
            raw: '{"secret":"value"}',
            statusCode: 401,
          },
        },
      },
    });
    expect(projected).not.toBeNull();

    const { newReplayEvents } = appendEventsWithReplay(sql, "s-1", [projected!]);
    expect(newReplayEvents).toHaveLength(1);
    expect(newReplayEvents[0]).toMatchObject({
      phase: "prompt.complete",
      payload: {
        success: false,
        error: "API error",
        errorCode: "api_error",
        errorDetails: {
          message: "fetch failed",
          statusCode: 401,
        },
        bridgeData: {
          errorDetails: {
            message: "fetch failed",
            statusCode: 401,
          },
        },
      },
    });
    expect((newReplayEvents[0].payload as Record<string, unknown>).errorDetails).not.toHaveProperty("stack");
    expect((newReplayEvents[0].payload as Record<string, unknown>).errorDetails).not.toHaveProperty(
      "responseBodyPreview",
    );
    expect((newReplayEvents[0].payload as Record<string, unknown>).errorDetails).not.toHaveProperty("raw");
  });

  it("fills replay pages with replayable events even when malformed transport rows are present", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "text", data: { id: "t-1", text: "first" } }]);
    sql.exec(
      `INSERT INTO events
        (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      2,
      "bad-transport-row",
      "s-1",
      null,
      "text",
      Date.now(),
      "{not-json",
      "cycloid_transport",
    );
    appendEventsWithReplay(sql, "s-1", [{ type: "text", data: { id: "t-2", text: "second" } }]);

    expect(getReplayEvents(sql, "s-1", { limit: 2 })).toMatchObject([
      { sequence: 1, type: "text", data: { id: "t-1", text: "first" } },
      { sequence: 3, type: "text", data: { id: "t-2", text: "second" } },
    ]);

    expect(getReplayWindowEvents(sql, "s-1", 0, 2)).toMatchObject({
      afterSequence: 0,
      truncated: false,
      droppedCount: 0,
      events: [
        { sequence: 1, type: "text", data: { id: "t-1", text: "first" } },
        { sequence: 3, type: "text", data: { id: "t-2", text: "second" } },
      ],
    });
  });

  it("filters historical heartbeat rows out of replay reads and truncation counts", () => {
    appendEventsWithReplay(sql, "s-1", [{ type: "text", data: { id: "t-1", text: "before" } }]);
    appendEventsWithReplay(sql, "s-1", [
      { type: "sandbox_heartbeat", data: { type: "heartbeat", sandboxId: "sbx-1" } },
    ]);
    sql.exec(
      `INSERT INTO events
        (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      3,
      "transport-heartbeat",
      "s-1",
      null,
      "bridge.connect",
      Date.now(),
      encodeCycloidEvent({
        phase: "bridge.connect",
        sessionId: "s-1",
        sandboxId: "sbx-1",
        timestampMs: 3,
        payload: { status: "connected" },
      }),
      "cycloid_transport",
    );
    appendEventsWithReplay(sql, "s-1", [{ type: "text", data: { id: "t-2", text: "after" } }]);

    expect(getReplayEvents(sql, "s-1")).toMatchObject([
      { sequence: 1, type: "text", data: { id: "t-1", text: "before" } },
      { sequence: 4, type: "text", data: { id: "t-2", text: "after" } },
    ]);

    expect(getReplayWindowEvents(sql, "s-1", 0, 2)).toMatchObject({
      afterSequence: 0,
      truncated: false,
      droppedCount: 0,
      events: [
        { sequence: 1, type: "text", data: { id: "t-1", text: "before" } },
        { sequence: 4, type: "text", data: { id: "t-2", text: "after" } },
      ],
    });

    expect(getReplayEventsBeforeSequence(sql, "s-1", 5, 2)).toMatchObject({
      hasEvents: true,
      hasMore: false,
      events: [
        { sequence: 1, type: "text", data: { id: "t-1", text: "before" } },
        { sequence: 4, type: "text", data: { id: "t-2", text: "after" } },
      ],
    });
  });

  it("uses a truncation sentinel for replay windows once older events are omitted", () => {
    appendEventsWithReplay(sql, "s-1", [
      { type: "text", data: { id: "t-1", text: "first" } },
      { type: "text", data: { id: "t-2", text: "second" } },
      { type: "text", data: { id: "t-3", text: "third" } },
    ]);

    expect(getReplayWindowEvents(sql, "s-1", 0, 2)).toMatchObject({
      afterSequence: 0,
      truncated: true,
      droppedCount: 1,
      events: [
        { sequence: 2, type: "text", data: { id: "t-2", text: "second" } },
        { sequence: 3, type: "text", data: { id: "t-3", text: "third" } },
      ],
    });
  });

  it("uses a hasMore sentinel for backward replay pagination", () => {
    appendEventsWithReplay(sql, "s-1", [
      { type: "text", data: { id: "t-1", text: "first" } },
      { type: "text", data: { id: "t-2", text: "second" } },
      { type: "text", data: { id: "t-3", text: "third" } },
    ]);

    expect(getReplayEventsBeforeSequence(sql, "s-1", 4, 2)).toMatchObject({
      hasEvents: true,
      hasMore: true,
      events: [
        { sequence: 2, type: "text", data: { id: "t-2", text: "second" } },
        { sequence: 3, type: "text", data: { id: "t-3", text: "third" } },
      ],
    });
  });

  it("adds row timestamps to legacy replay events that lack embedded timestamps", () => {
    sql.exec(
      `INSERT INTO events
        (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      1,
      "legacy-text-1",
      "s-1",
      "prompt-1",
      "text",
      1_713_456_789_000,
      JSON.stringify({ id: "t-1", text: "legacy text" }),
      "canonical",
    );

    expect(getReplayEvents(sql, "s-1")).toEqual([
      {
        sequence: 1,
        type: "text",
        data: {
          id: "t-1",
          text: "legacy text",
          timestamp: "2024-04-18T16:13:09.000Z",
        },
      },
    ]);
  });
});

describe("sandbox state", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    ensureSandboxState(sql, "s-1");
  });

  it("creates default sandbox state", () => {
    const state = getSandboxState(sql, "s-1");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("idle");
    expect(state!.spawnRetryCount).toBe(0);
    expect(state!.pendingPromptDispatch).toBe(false);
  });

  it("updates sandbox state", () => {
    updateSandboxState(sql, "s-1", {
      status: "spawning",
      sandboxId: "sb-123",
      modalObjectId: "mo-456",
      spawnStartedAt: Date.now(),
    });

    const state = getSandboxState(sql, "s-1");
    expect(state!.status).toBe("spawning");
    expect(state!.sandboxId).toBe("sb-123");
    expect(state!.modalObjectId).toBe("mo-456");
  });

  it("updates and clears neutral runtime state without touching Modal fields", () => {
    updateSandboxState(sql, "s-1", {
      sandboxId: "sb-123",
      modalObjectId: "mo-456",
      runtimeProvider: "e2b",
      runtimeState: "running",
      runtimeSandboxId: "e2b-sb-1",
      runtimeTemplateId: "cycloid-sandbox-dev-test",
      runtimeStateExpiresAt: 1_762_003_600_000,
      runtimeLiveLeaseExpiresAt: 1_762_000_000_000,
      runtimePreviewUrl: "https://preview.example",
      runtimeCreatedAt: 1_761_999_000_000,
      runtimeLastResumedAt: 1_762_000_000_000,
      runtimeLastProviderRefreshedAt: 1_762_000_001_000,
      runtimeProviderTtlExpiresAt: 1_762_003_600_000,
    });

    expect(getSandboxState(sql, "s-1")).toMatchObject({
      sandboxId: "sb-123",
      modalObjectId: "mo-456",
      runtimeProvider: "e2b",
      runtimeState: "running",
      runtimeSandboxId: "e2b-sb-1",
      runtimeTemplateId: "cycloid-sandbox-dev-test",
      runtimeStateExpiresAt: null,
      runtimeLiveLeaseExpiresAt: 1_762_000_000_000,
      runtimePreviewUrl: "https://preview.example",
      runtimeCreatedAt: 1_761_999_000_000,
      runtimeLastResumedAt: 1_762_000_000_000,
      runtimeLastProviderRefreshedAt: 1_762_000_001_000,
      runtimeProviderTtlExpiresAt: 1_762_003_600_000,
    });

    clearRuntimeState(sql, "s-1", "e2b");

    expect(getSandboxState(sql, "s-1")).toMatchObject({
      sandboxId: "sb-123",
      modalObjectId: "mo-456",
      runtimeProvider: null,
      runtimeState: null,
      runtimeSandboxId: null,
      runtimeTemplateId: null,
      runtimeLiveLeaseExpiresAt: null,
      runtimePreviewUrl: null,
    });
  });

  it("does not persist unknown runtime state as canonical state", () => {
    updateSandboxState(sql, "s-1", {
      runtimeProvider: "e2b",
      runtimeState: "unknown",
      runtimeSandboxId: "e2b-sb-1",
    } as Parameters<typeof updateSandboxState>[2]);

    expect(getSandboxState(sql, "s-1")).toMatchObject({
      runtimeProvider: "e2b",
      runtimeState: null,
      runtimeSandboxId: "e2b-sb-1",
    });
  });

  it("clears runtime state when no expected provider is supplied", () => {
    updateSandboxState(sql, "s-1", {
      runtimeProvider: "e2b",
      runtimeBackend: "e2b_cloud",
      runtimeState: "paused",
      runtimeSandboxId: "e2b-sb-1",
    });

    clearRuntimeState(sql, "s-1", null);

    expect(getSandboxState(sql, "s-1")).toMatchObject({
      runtimeProvider: null,
      runtimeBackend: "e2b_cloud",
      runtimeState: null,
      runtimeSandboxId: null,
    });
  });

  it("clears snapshot metadata", () => {
    updateSandboxState(sql, "s-1", {
      snapshotImageId: "img-1",
      snapshotBranch: "main",
      snapshotCreatedAt: Date.now(),
      snapshotCredentialEnvKeys: ["GITHUB_CLONE_TOKEN", "OPENAI_API_KEY"],
      snapshotCredentialFingerprints: ["CYCLOID_LOGIN_ENV:old:1"],
      snapshotModalWorkspace: "test-workspace",
      snapshotModalEnvironment: "test",
      snapshotSandboxImageVersion: "sandbox-v1",
    });
    expect(getSandboxState(sql, "s-1")).toMatchObject({
      snapshotImageId: "img-1",
      snapshotCredentialEnvKeys: ["GITHUB_CLONE_TOKEN", "OPENAI_API_KEY"],
      snapshotCredentialFingerprints: ["CYCLOID_LOGIN_ENV:old:1"],
      snapshotModalWorkspace: "test-workspace",
      snapshotModalEnvironment: "test",
      snapshotSandboxImageVersion: "sandbox-v1",
    });

    clearSnapshotMetadata(sql, "s-1");
    expect(getSandboxState(sql, "s-1")).toMatchObject({
      snapshotImageId: null,
      snapshotCredentialEnvKeys: null,
      snapshotCredentialFingerprints: null,
      snapshotModalWorkspace: null,
      snapshotModalEnvironment: null,
      snapshotSandboxImageVersion: null,
    });
  });

  it("skips clear if expected image ID does not match", () => {
    updateSandboxState(sql, "s-1", { snapshotImageId: "img-1" });
    clearSnapshotMetadata(sql, "s-1", "img-wrong");
    expect(getSandboxState(sql, "s-1")?.snapshotImageId).toBe("img-1");
  });

  it("round-trips a freestyle runtime provider+backend through the DO-SQLite path", () => {
    updateSandboxState(sql, "s-1", {
      runtimeProvider: "freestyle",
      runtimeBackend: "freestyle",
      runtimeState: "running",
      runtimeSandboxId: "e2b-sb-1",
    });

    expect(getSandboxState(sql, "s-1")).toMatchObject({
      runtimeProvider: "freestyle",
      runtimeBackend: "freestyle",
      runtimeState: "running",
      runtimeSandboxId: "e2b-sb-1",
    });
  });
});

describe("prompt usage", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "test",
      actorUserId: "u-1",
      status: "completed",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });
  });

  it("upserts and reads prompt usage", () => {
    upsertPromptUsage(sql, "p-1", {
      promptId: "p-1",
      model: "gpt-5.4-mini",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      totalCostUsd: 0.05,
    });

    const usage = getPromptUsage(sql, "s-1");
    expect(usage["p-1"]).toBeDefined();
    expect(usage["p-1"].inputTokens).toBe(1000);
    expect(usage["p-1"].outputTokens).toBe(500);
    expect(usage["p-1"].totalCostUsd).toBeCloseTo(0.05, 4);
  });

  it("computes usage cache correctly", () => {
    upsertPromptUsage(sql, "p-1", {
      promptId: "p-1",
      model: "gpt-5.4-mini",
      inputTokens: 30,
      outputTokens: 25_334,
      cacheReadTokens: 1_580_505,
      cacheWriteTokens: 342_354,
      totalCostUsd: 0.05,
    });

    const usage = getPromptUsage(sql, "s-1");
    const cache = computeUsageCache(usage);
    expect(cache.inputTokens).toBe(30);
    expect(cache.outputTokens).toBe(25_334);
    expect(cache.cacheReadTokens).toBe(1_580_505);
    expect(cache.cacheWriteTokens).toBe(342_354);
    expect(cache.totalTokens).toBe(25_364);
    expect(cache.totalBilledTokens).toBe(1_948_223);
    expect(cache.promptCount).toBe(1);
    expect(cache.byModel["gpt-5.4-mini"]).toBeDefined();
    expect(cache.byModel["gpt-5.4-mini"]).toMatchObject({
      inputTokens: 30,
      outputTokens: 25_334,
      cacheReadTokens: 1_580_505,
      cacheWriteTokens: 342_354,
      totalTokens: 25_364,
      totalBilledTokens: 1_948_223,
    });
  });
});

describe("prompt token attribution", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "test",
      actorUserId: "u-1",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("upserts and reads estimated input composition by session prompts only", () => {
    upsertPromptTokenAttribution(sql, "p-1", {
      kind: "estimated_input_composition",
      version: 1,
      components: {
        systemContext: 10,
        historicalSessions: 20,
        taskText: 30,
        uploads: 40,
        measuredTotal: 100,
        actualInputTokens: 120,
        actualOutputTokens: 50,
        unmeasuredTokens: 20,
      },
    });

    const attribution = getPromptTokenAttribution(sql, "s-1");
    expect(attribution["p-1"]).toEqual({
      kind: "estimated_input_composition",
      version: 1,
      components: {
        systemContext: 10,
        historicalSessions: 20,
        taskText: 30,
        uploads: 40,
        measuredTotal: 100,
        actualInputTokens: 120,
        actualOutputTokens: 50,
        unmeasuredTokens: 20,
      },
    });
  });
});

describe("prompt telemetry", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSqlStorage();
    initSchema(sql);
    createSession(sql, { sessionId: "s-1", ownerUserId: "u-1" });
    insertPrompt(sql, "s-1", {
      promptId: "p-1",
      prompt: "test",
      actorUserId: "u-1",
      status: "processing",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });
  });

  it("upserts telemetry data", () => {
    upsertPromptTelemetry(sql, "p-1", {
      btSpanId: "span-456",
    });

    const telemetry = getPromptTelemetry(sql, "s-1");
    expect(telemetry["p-1"]).toBeDefined();
    expect(telemetry["p-1"].btSpanId).toBe("span-456");
  });

  it("reads historical dd_trace_id values that predate the OTLP removal", () => {
    sql.exec(`INSERT OR IGNORE INTO prompt_telemetry (prompt_id, tool_call_count) VALUES (?, 0)`, "p-1");
    sql.exec(`UPDATE prompt_telemetry SET dd_trace_id = ? WHERE prompt_id = ?`, "legacy-trace-123", "p-1");

    const telemetry = getPromptTelemetry(sql, "s-1");
    expect(telemetry["p-1"].ddTraceId).toBe("legacy-trace-123");
  });

  it("coalesces the Braintrust span id without overwriting an existing one", () => {
    upsertPromptTraceTelemetry(sql, "p-1", { btSpanId: "bt-span-1" });
    upsertPromptTraceTelemetry(sql, "p-1", { btSpanId: "bt-span-2" });

    const telemetry = getPromptTelemetry(sql, "s-1");
    expect(telemetry["p-1"].btSpanId).toBe("bt-span-1");
  });

  it("increments tool call count", () => {
    incrementToolCallCount(sql, "p-1");
    incrementToolCallCount(sql, "p-1");
    incrementToolCallCount(sql, "p-1");

    const counts = getPromptToolCounts(sql, "s-1");
    expect(counts["p-1"]).toBe(3);
  });

  it("aggregates terminal tool updates by normalized tool and MCP server", () => {
    incrementPromptToolStats(sql, "p-1", { tool: "Read", status: "completed", durationMs: 12.4 });
    incrementPromptToolStats(sql, "p-1", { tool: "read", status: "error" });
    incrementPromptToolStats(sql, "p-1", {
      tool: "mcp__Acme_Server__namespace__Fetch",
      status: "completed",
      durationMs: 33,
    });
    incrementPromptToolStats(sql, "p-1", { tool: "bash", status: "running", durationMs: 50 });
    incrementPromptToolStats(sql, "p-2", { tool: "read", status: "completed", durationMs: 9 });

    expect(getPromptToolStatsForPrompt(sql, "p-1")).toEqual([
      {
        promptId: "p-1",
        toolName: "mcp__acme_server__namespace__fetch",
        mcpServer: "acme_server",
        okCount: 1,
        errorCount: 0,
        totalDurationMs: 33,
        durationSampleCount: 1,
      },
      {
        promptId: "p-1",
        toolName: "read",
        mcpServer: null,
        okCount: 1,
        errorCount: 1,
        totalDurationMs: 12,
        durationSampleCount: 1,
      },
    ]);
  });
});
