/**
 * DO-internal SQLite schema for SessionDO.
 *
 * Runs on every DO wake-up via blockConcurrencyWhile(). All statements use
 * IF NOT EXISTS guards. Numbered migrations in MIGRATIONS[] handle additive
 * schema changes after the initial creation.
 */

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
-- Migration tracking
CREATE TABLE IF NOT EXISTS _schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Core session metadata (one row per DO)
CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT,
  title_tags TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  model TEXT,
  reasoning_effort TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  base_branch TEXT,
  start_branch TEXT,
  last_branch TEXT,
  last_commit_sha TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_creating INTEGER NOT NULL DEFAULT 0,
  pr_draft INTEGER,
  pr_manual_review_reason TEXT,
  publish_status TEXT NOT NULL DEFAULT 'not_started',
  publish_stage TEXT,
  publish_error TEXT,
  published_branch TEXT,
  publish_attempt INTEGER NOT NULL DEFAULT 0,
  publish_sequence INTEGER NOT NULL DEFAULT 0,
  pr_polish_status TEXT NOT NULL DEFAULT 'not_started',
  pr_polish_error TEXT,
  installation_id INTEGER,
  active_prompt_id TEXT,
  prompt_counter INTEGER NOT NULL DEFAULT 0,
  repo_private INTEGER,
  callback_context_json TEXT,
  linear_context_json TEXT,
  github_issue_context_json TEXT,
  resolved_agents_json TEXT,
  -- Original codex_* names; migrations 74-75 rename these to agent_session_id /
  -- agent_session_agent on both fresh and existing DOs, and migration 76 adds
  -- agent_runtime_backend. Keep the codex_* names here so the RENAME migrations
  -- succeed on freshly-created DOs (which replay all migrations).
  agent_role TEXT,
  agent_profile TEXT,
  harness_kind TEXT,
  runtime_startup_profile TEXT,
  verification_runtime_mode TEXT,
  target_pr_url TEXT,
  codex_session_id TEXT,
  codex_session_agent TEXT,
  last_push_succeeded INTEGER NOT NULL DEFAULT 0,
  publishing_started_at INTEGER,
  spawn_duration_ms INTEGER,
  initiation_mode TEXT NOT NULL DEFAULT 'user',
  entrypoint TEXT,
  scheduled_rule_id TEXT,
  rule_name_snapshot TEXT,
  cron_snapshot TEXT,
  review_listening_active INTEGER NOT NULL DEFAULT 0,
  pr_title_last_applied TEXT,
  ticket_key TEXT,
  review_listening_pr_url TEXT,
  review_listening_head_sha TEXT,
  review_listening_entered_at INTEGER,
  arcanist_done_state TEXT NOT NULL DEFAULT 'working',
  arcanist_done_outcome TEXT,
  arcanist_done_reasons_json TEXT NOT NULL DEFAULT '[]',
  verification_state TEXT,
  verification_result TEXT,
  verification_needs_work_label TEXT,
  verification_attempt_count INTEGER NOT NULL DEFAULT 0,
  verification_max_attempts INTEGER NOT NULL DEFAULT 3,
  auto_verify_disabled INTEGER NOT NULL DEFAULT 0,
  plan_mode INTEGER NOT NULL DEFAULT 0,
  plan_approval_required INTEGER NOT NULL DEFAULT 0,
  plan_auto_reason TEXT,
  adopted_external_pr INTEGER NOT NULL DEFAULT 0,
  verification_run_baseline INTEGER NOT NULL DEFAULT 0,
  verification_verdict_head_sha TEXT,
  qa_testing_state TEXT,
  qa_testing_result TEXT,
  qa_testing_needs_work_label TEXT,
  qa_testing_attempt_count INTEGER NOT NULL DEFAULT 0,
  qa_testing_max_attempts INTEGER NOT NULL DEFAULT 3,
  qa_testing_run_baseline INTEGER NOT NULL DEFAULT 0,
  qa_testing_verdict_head_sha TEXT
);

-- Prompt queue (one row per prompt)
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  reply_to_text TEXT,
  reply_to_quote_source_json TEXT,
  branch_name_hint TEXT,
  actor_user_id TEXT,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  error TEXT,
  result_json TEXT,
  queue_position INTEGER NOT NULL DEFAULT 0,
  has_pending_question INTEGER NOT NULL DEFAULT 0,
  push_status TEXT,
  push_error TEXT,
  files_json TEXT,
  uploaded_files_json TEXT,
  uploaded_images_json TEXT,
  plan_context_json TEXT,
  review_loop_epoch_id TEXT,
  review_loop_source_kind TEXT,
  disconnect_retry_count INTEGER NOT NULL DEFAULT 0,
  is_plan_prompt INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prompts_session_id ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_status ON prompts(session_id, status);
-- The idx_prompts_one_processing partial unique index is intentionally
-- NOT created here. It lives in migration 69 so it runs AFTER the
-- migration 67/68 backfill cleans up any existing corrupt rows. Putting
-- it in SCHEMA_DDL would make initSchema throw on the first wake-up of
-- a DO that has multiple processing prompts for the same session,
-- preventing the very backfill that would repair it.

-- Prompt attachments (separate from prompt row to keep payload small)
CREATE TABLE IF NOT EXISTS prompt_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  path_or_url TEXT,
  content_blob BLOB,
  metadata_json TEXT,
  FOREIGN KEY (prompt_id) REFERENCES prompts(prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_attachments_prompt_id ON prompt_attachments(prompt_id);

-- Canonical durable replay log
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  delivery_class TEXT NOT NULL DEFAULT 'canonical'
);

CREATE INDEX IF NOT EXISTS idx_events_session_prompt ON events(session_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- Sandbox lifecycle state (one row per session)
CREATE TABLE IF NOT EXISTS sandbox_state (
  session_id TEXT PRIMARY KEY,
  sandbox_id TEXT,
  modal_object_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_heartbeat_at INTEGER,
  last_activity_at INTEGER,
  disconnect_started_at INTEGER,
  auto_close_scheduled_at INTEGER,
  snapshot_image_id TEXT,
  snapshot_branch TEXT,
  snapshot_head_sha TEXT,
  snapshot_created_at INTEGER,
  last_snapshot_error TEXT,
  spawn_retry_count INTEGER NOT NULL DEFAULT 0,
  pending_prompt_dispatch INTEGER NOT NULL DEFAULT 0,
  sandbox_auth_token_hash TEXT,
  spawn_started_at INTEGER,
  last_spawn_attempt_id TEXT,
  prompt_last_activity_at INTEGER,
  intentional_pause_reason TEXT,
  bridge_protocol_version INTEGER,
  prev_sandbox_auth_token_hash TEXT,
  prev_sandbox_auth_token_expires_at INTEGER,
  prev_sandbox_auth_token_hashes TEXT
);

-- Per-prompt usage (one row per prompt)
CREATE TABLE IF NOT EXISTS prompt_usage (
  prompt_id TEXT PRIMARY KEY,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd_micros INTEGER NOT NULL DEFAULT 0
);

-- Per-prompt token attribution ledger
CREATE TABLE IF NOT EXISTS prompt_token_attribution (
  prompt_id TEXT PRIMARY KEY,
  attribution_json TEXT NOT NULL
);

-- Per-prompt telemetry
CREATE TABLE IF NOT EXISTS prompt_telemetry (
  prompt_id TEXT PRIMARY KEY,
  dd_trace_id TEXT,
  bt_span_id TEXT,
  error_code TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prompt_tool_stats (
  prompt_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  mcp_server TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_sample_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prompt_id, tool_name)
);

-- Artifacts (PRs, branches, external links)
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  type TEXT NOT NULL,
  url TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS session_plans (
  session_id TEXT NOT NULL,
  plan_prompt_id TEXT NOT NULL,
  implementation_prompt_id TEXT,
  markdown TEXT,
  excerpt TEXT NOT NULL,
  artifact_id TEXT,
  valid INTEGER NOT NULL DEFAULT 0,
  missing_reason TEXT,
  missing_headings_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'none',
  revision INTEGER NOT NULL DEFAULT 0,
  user_edited INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at INTEGER,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, plan_prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_session_plans_session_id ON session_plans(session_id);

-- WebSocket recovery metadata
CREATE TABLE IF NOT EXISTS ws_recovery (
  client_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  last_seen_sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-shot platform-funded LLM capabilities minted by SessionDO.
CREATE TABLE IF NOT EXISTS platform_llm_capabilities (
  id_hash          TEXT    PRIMARY KEY,
  session_id       TEXT    NOT NULL,
  sandbox_id       TEXT    NOT NULL,
  prompt_id        TEXT    NOT NULL,
  call_type        TEXT    NOT NULL,
  phase            TEXT    NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_llm_capabilities_prompt ON platform_llm_capabilities(prompt_id);

CREATE TABLE IF NOT EXISTS platform_llm_budget (
  prompt_id   TEXT NOT NULL,
  call_type   TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prompt_id, call_type)
);

CREATE TABLE IF NOT EXISTS platform_llm_prompt_status (
  prompt_id  TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER
);
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface Migration {
  id: number;
  sql: string;
  ignoreDuplicateColumn?: boolean;
  ignoreMissingColumn?: boolean;
}

/**
 * Numbered migrations applied after the initial schema creation.
 * Each migration runs exactly once, tracked by _schema_migrations.
 * Add new migrations to the end of this array. Never modify existing ones.
 */
export const MIGRATIONS: Migration[] = [
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
  { id: 39, sql: "ALTER TABLE sandbox_state ADD COLUMN intentional_pause_reason TEXT;", ignoreDuplicateColumn: true },
  { id: 40, sql: "ALTER TABLE prompts ADD COLUMN reply_to_text TEXT;", ignoreDuplicateColumn: true },
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
  // ARC-876 watchdog + push-outcome columns.
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
  // Backfill: archived sessions must not carry a still-processing prompt or a
  // stale active_prompt_id pointer. Without this, migration 69's unique index
  // creation would fail on already-corrupt rows, and subsequent archive code
  // paths would throw on the next archive attempt. Writes completed_at /
  // error / updated_at alongside status so downstream consumers that key off
  // those columns for `failed` rows see consistent data; all three columns
  // are declared in the initial CREATE TABLE so they exist on every DO.
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
  // Drop the denormalized session.active_prompt_id column. The current
  // processing prompt is now derived from prompts.status, guarded by the
  // partial unique index above. Kept in SCHEMA_DDL so newly-created DOs run
  // migrations 67/68 (which reference the column) cleanly; this drop fires
  // afterwards on both new and existing DOs. Requires SQLite >= 3.35.
  {
    id: 70,
    sql: "ALTER TABLE session DROP COLUMN active_prompt_id;",
  },
  // Track the last PR title Cycloid applied so republish can overwrite the
  // live GitHub title only when a human has not renamed the PR since.
  {
    id: 71,
    sql: "ALTER TABLE session ADD COLUMN pr_title_last_applied TEXT;",
    ignoreDuplicateColumn: true,
  },
  // Grace-overlap sandbox auth-token rotation: keep the prior token hash valid
  // for a bounded window so a still-running bridge whose transport reconnected
  // (and rotated its HTTP token) is not 403'd mid-flight on REST calls.
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
  // Phase 2: neutral agent-runtime identity (clean rename of the codex_* columns +
  // the backend axis). RENAME COLUMN requires SQLite >= 3.25 (migration 70 already
  // requires >= 3.35, so this is safe). Existing DOs get the renamed columns here;
  // brand-new DOs get them from SCHEMA_DDL.
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
  // Historical compatibility column. Cycloid no longer creates or enforces
  // draft PRs, but deployed databases may already carry this field.
  {
    id: 93,
    sql: "ALTER TABLE session ADD COLUMN pr_draft_last_applied INTEGER;",
    ignoreDuplicateColumn: true,
  },
  // Legacy ARC-1243 per-head verification budget field. Retained for existing session rows; the
  // active run-limit gate is PR-scoped and ignores it.
  {
    id: 94,
    sql: "ALTER TABLE session ADD COLUMN verification_run_baseline INTEGER NOT NULL DEFAULT 0;",
    ignoreDuplicateColumn: true,
  },
  // ARC-1243 follow-up: head SHA the current verification verdict was validated for. The
  // auto-verification scheduler skips re-verification only when this equals the head being settled (a
  // positively-identified content no-op), so a silently-failed verdict clear on a real change cannot
  // suppress verification — the stamped head differs from the new head, so it re-verifies.
  {
    id: 95,
    sql: "ALTER TABLE session ADD COLUMN verification_verdict_head_sha TEXT;",
    ignoreDuplicateColumn: true,
  },
  // N-generation auth-token overlap (supersedes the single prev_sandbox_auth_token_hash
  // slot): a JSON array of {hash, expiresAt}, newest-first, so a reconnect storm that
  // rolls the token several times does not 403 in-flight REST calls on a 2+-generations-old
  // token. ADD COLUMN is not idempotent in SQLite; the runner skips duplicate-column errors,
  // so keep this a single add-column statement.
  {
    id: 96,
    sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_hashes TEXT;",
    ignoreDuplicateColumn: true,
  },
  // Backfill the new N-generation list from the legacy single grace slot so a DO that
  // rotated under the pre-list code keeps its still-valid prior token accepted across
  // this deploy. initSchema runs before request handling, so the list is populated
  // before any auth validation reads it — no deploy-window 403 for the legacy token.
  // Built with string concatenation (no JSON SQL functions) to match the app's
  // [{"hash":..,"expiresAt":..}] shape; the hash is hex and the expiry an integer, so
  // no escaping is needed. selectValidAuthTokenGenerations prunes it if already expired.
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
    // Create-time "resume this existing branch" target (distinct from base_branch,
    // the PR merge target). Becomes CHECKOUT_BRANCH on the initial spawn so the
    // sandbox checks out the branch with its history instead of forking off base.
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
  // ARC-1330 D-59d: drop the dead DO-SQLite `verification_*` mirror columns. The verification axis was
  // renamed to `qa_testing_*` (migrations 108-116 seeded the copies) and `do-db.ts` now reads/writes ONLY
  // the `qa_testing_*` columns. Data already lives in `qa_testing_state` / `qa_testing_attempt_count` /
  // `qa_testing_max_attempts` (seeded by lower-id migrations). This follows the `active_prompt_id` /
  // session_kind precedent: keep the historical columns in SCHEMA_DDL, drop via migrations, and use
  // `ignoreMissingColumn` for legacy DOs whose table never had the column.
  { id: 124, sql: "ALTER TABLE session DROP COLUMN verification_state;", ignoreMissingColumn: true },
  { id: 125, sql: "ALTER TABLE session DROP COLUMN verification_attempt_count;", ignoreMissingColumn: true },
  { id: 126, sql: "ALTER TABLE session DROP COLUMN verification_max_attempts;", ignoreMissingColumn: true },
  // ARC-1330 D-59 residue fold (R1): drop the REMAINING dead DO-SQLite `verification_*` mirror columns that
  // D-59d deferred. Same disposition as 124-126: their data was already copied into the `qa_testing_*`
  // columns by lower-id rename migrations, and `ignoreMissingColumn` covers legacy DOs whose table predates
  // the column.
  { id: 127, sql: "ALTER TABLE session DROP COLUMN verification_result;", ignoreMissingColumn: true },
  { id: 128, sql: "ALTER TABLE session DROP COLUMN verification_needs_work_label;", ignoreMissingColumn: true },
  { id: 129, sql: "ALTER TABLE session DROP COLUMN verification_run_baseline;", ignoreMissingColumn: true },
  { id: 130, sql: "ALTER TABLE session DROP COLUMN verification_verdict_head_sha;", ignoreMissingColumn: true },
  // ARC-1330 single-writer cutover: drop the writer-less done-state DO-SQLite copies. Post-publish
  // review/done state is projected from the `pr_coordination` spine; DO snapshots and session wire fields
  // use the spine/D1 projections, not these frozen local columns.
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
];

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the DO-internal SQLite schema. Safe to call on every wake-up.
 * Must be called inside blockConcurrencyWhile() to prevent request handling
 * before schema is ready.
 */
export function initSchema(sql: SqlStorage): void {
  // Run all CREATE TABLE / CREATE INDEX statements (idempotent)
  sql.exec(SCHEMA_DDL);

  // Apply numbered migrations not yet recorded
  if (MIGRATIONS.length === 0) return;

  const applied = new Set<number>();
  try {
    const rows = sql.exec("SELECT id FROM _schema_migrations").toArray();
    for (const row of rows) {
      applied.add(row.id as number);
    }
  } catch {
    // Table might not exist yet on very first run before DDL above;
    // but since we just ran DDL, this shouldn't happen. Defensive.
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    try {
      sql.exec(migration.sql);
    } catch (error) {
      const message = String(error);
      const ignoredDuplicateColumn = migration.ignoreDuplicateColumn && message.includes("duplicate column name");
      const ignoredMissingColumn =
        migration.ignoreMissingColumn &&
        (message.includes("no such column") || message.includes("has no column named"));
      if (!ignoredDuplicateColumn && !ignoredMissingColumn) {
        throw error;
      }
    }
    sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?)", migration.id, Date.now());
  }
}
