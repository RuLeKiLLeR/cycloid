-- Backfill tenant snapshots, delete unowned historical rows, and enforce NOT NULL.

UPDATE session_index
SET business_id = (
  SELECT users.business_id
  FROM users
  WHERE users.id = session_index.owner_user_id
)
WHERE business_id IS NULL;

UPDATE usage_records
SET business_id = COALESCE(
  (
    SELECT session_index.business_id
    FROM session_index
    WHERE session_index.session_id = usage_records.session_id
  ),
  (
    SELECT users.business_id
    FROM users
    WHERE users.id = usage_records.owner_user_id
  )
)
WHERE business_id IS NULL;

UPDATE prompt_runs
SET business_id = COALESCE(
  (
    SELECT session_index.business_id
    FROM session_index
    WHERE session_index.session_id = prompt_runs.session_id
  ),
  (
    SELECT users.business_id
    FROM users
    WHERE users.id = prompt_runs.owner_user_id
  )
)
WHERE business_id IS NULL;

UPDATE session_completions
SET business_id = COALESCE(
  (
    SELECT session_index.business_id
    FROM session_index
    WHERE session_index.session_id = session_completions.session_id
  ),
  (
    SELECT users.business_id
    FROM users
    WHERE users.id = session_completions.owner_user_id
  )
)
WHERE business_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_tmp_business_id_not_null_observations_session
  ON codegraph_observations(session_id);

-- codegraph_observations has no owner_user_id snapshot, so it can only
-- inherit the session_index snapshot. Unresolved rows are deleted below.
UPDATE codegraph_observations
SET business_id = (
  SELECT session_index.business_id
  FROM session_index
  WHERE session_index.session_id = codegraph_observations.session_id
)
WHERE business_id IS NULL;

DELETE FROM usage_records WHERE business_id IS NULL;
DELETE FROM prompt_runs WHERE business_id IS NULL;
DELETE FROM session_completions WHERE business_id IS NULL;
DELETE FROM codegraph_observations WHERE business_id IS NULL;
DROP INDEX IF EXISTS idx_tmp_business_id_not_null_observations_session;

DELETE FROM durable_event_replay_metadata
WHERE session_id IN (
  SELECT session_id
  FROM session_index
  WHERE business_id IS NULL
)
OR NOT EXISTS (
  SELECT 1
  FROM session_index
  WHERE session_index.session_id = durable_event_replay_metadata.session_id
);

DELETE FROM session_webhook_refs
WHERE session_id IN (
  SELECT session_id
  FROM session_index
  WHERE business_id IS NULL
)
OR NOT EXISTS (
  SELECT 1
  FROM session_index
  WHERE session_index.session_id = session_webhook_refs.session_id
);

DELETE FROM slack_thread_session_refs
WHERE session_id IN (
  SELECT session_id
  FROM session_index
  WHERE business_id IS NULL
)
OR NOT EXISTS (
  SELECT 1
  FROM session_index
  WHERE session_index.session_id = slack_thread_session_refs.session_id
);

DELETE FROM linear_issue_session_refs
WHERE session_id IN (
  SELECT session_id
  FROM session_index
  WHERE business_id IS NULL
)
OR NOT EXISTS (
  SELECT 1
  FROM session_index
  WHERE session_index.session_id = linear_issue_session_refs.session_id
);

DELETE FROM session_index WHERE business_id IS NULL;

CREATE TABLE session_index_not_null (
  session_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  installation_id INTEGER,
  title TEXT,
  rich_status TEXT,
  model TEXT,
  reasoning_effort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_event_id TEXT,
  snapshot_image_id TEXT,
  session_kind TEXT NOT NULL DEFAULT 'repo',
  business_id TEXT NOT NULL,
  title_tags TEXT
);

INSERT INTO session_index_not_null (
  session_id, owner_user_id, status, installation_id, title, rich_status, model,
  reasoning_effort, created_at, updated_at, closed_at, last_event_id,
  snapshot_image_id, session_kind, business_id, title_tags
)
SELECT
  session_id, owner_user_id, status, installation_id, title, rich_status, model,
  reasoning_effort, created_at, updated_at, closed_at, last_event_id,
  snapshot_image_id, session_kind, business_id, title_tags
FROM session_index;

DROP TABLE session_index;
ALTER TABLE session_index_not_null RENAME TO session_index;

CREATE INDEX IF NOT EXISTS idx_session_index_owner_updated
  ON session_index(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_index_status_updated
  ON session_index(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_index_business_updated
  ON session_index(business_id, updated_at DESC, session_id);

CREATE TABLE usage_records_not_null (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  owner_user_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'sandbox' CHECK(source IN ('sandbox', 'evaluation')),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  business_id TEXT NOT NULL
);

INSERT INTO usage_records_not_null (
  id, session_id, prompt_id, owner_user_id, source, model, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros,
  created_at, business_id
)
SELECT
  id, session_id, prompt_id, owner_user_id, source, model, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros,
  created_at, business_id
FROM usage_records;

DROP TABLE usage_records;
ALTER TABLE usage_records_not_null RENAME TO usage_records;

CREATE INDEX IF NOT EXISTS idx_usage_records_session
  ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
  ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_owner_date
  ON usage_records(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_created
  ON usage_records(business_id, created_at);

CREATE TABLE prompt_runs_not_null (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  sandbox_id TEXT,
  modal_object_id TEXT,
  opencode_session_id TEXT,
  repo TEXT,
  model TEXT,
  agent TEXT,
  source TEXT,
  outcome TEXT,
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd_micros INTEGER,
  duration_ms INTEGER,
  tool_call_count INTEGER,
  dd_trace_id TEXT,
  bt_span_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER,
  business_id TEXT NOT NULL,
  error_details_json TEXT,
  UNIQUE(session_id, prompt_id)
);

INSERT INTO prompt_runs_not_null (
  id, session_id, prompt_id, owner_user_id, sandbox_id, modal_object_id,
  opencode_session_id, repo, model, agent, source, outcome, error_code,
  input_tokens, output_tokens, cost_usd_micros, duration_ms, tool_call_count,
  dd_trace_id, bt_span_id, created_at, completed_at, business_id,
  error_details_json
)
SELECT
  id, session_id, prompt_id, owner_user_id, sandbox_id, modal_object_id,
  opencode_session_id, repo, model, agent, source, outcome, error_code,
  input_tokens, output_tokens, cost_usd_micros, duration_ms, tool_call_count,
  dd_trace_id, bt_span_id, created_at, completed_at, business_id,
  error_details_json
FROM prompt_runs;

DROP TABLE prompt_runs;
ALTER TABLE prompt_runs_not_null RENAME TO prompt_runs;

CREATE INDEX IF NOT EXISTS idx_prompt_runs_session
  ON prompt_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner
  ON prompt_runs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_repo
  ON prompt_runs(repo);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_outcome
  ON prompt_runs(outcome);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_created
  ON prompt_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner_created
  ON prompt_runs(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_business_created
  ON prompt_runs(business_id, created_at);

CREATE TABLE session_completions_not_null (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  title TEXT,
  diff_summary TEXT,
  branch TEXT,
  commit_sha TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  pr_url TEXT,
  intent_summary TEXT,
  business_id TEXT NOT NULL
);

INSERT INTO session_completions_not_null (
  id, session_id, prompt_id, owner_user_id, repo_owner, repo_name,
  prompt_text, title, diff_summary, branch, commit_sha, success,
  completed_at, created_at, pr_url, intent_summary, business_id
)
SELECT
  id, session_id, prompt_id, owner_user_id, repo_owner, repo_name,
  prompt_text, title, diff_summary, branch, commit_sha, success,
  completed_at, created_at, pr_url, intent_summary, business_id
FROM session_completions;

DROP TABLE session_completions;
ALTER TABLE session_completions_not_null RENAME TO session_completions;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_completions_prompt
  ON session_completions(session_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_session_completions_repo
  ON session_completions(owner_user_id, repo_owner, repo_name, success, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_completions_business_repo
  ON session_completions(business_id, repo_owner, repo_name, success, completed_at DESC);

CREATE TABLE codegraph_observations_not_null (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  node_id TEXT,
  file_path TEXT,
  observation TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK(observation_type IN ('architecture','bug','pattern','decision','gotcha','dependency')),
  confidence REAL NOT NULL DEFAULT 1.0,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  staled_at INTEGER,
  business_id TEXT NOT NULL
);

INSERT INTO codegraph_observations_not_null (
  id, repo_owner, repo_name, session_id, node_id, file_path, observation,
  observation_type, confidence, stale, created_at, staled_at, business_id
)
SELECT
  id, repo_owner, repo_name, session_id, node_id, file_path, observation,
  observation_type, confidence, stale, created_at, staled_at, business_id
FROM codegraph_observations;

DROP TABLE codegraph_observations;
ALTER TABLE codegraph_observations_not_null RENAME TO codegraph_observations;

CREATE INDEX IF NOT EXISTS idx_observations_repo
  ON codegraph_observations(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_observations_node
  ON codegraph_observations(node_id);
CREATE INDEX IF NOT EXISTS idx_observations_session
  ON codegraph_observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_stale
  ON codegraph_observations(stale);
CREATE INDEX IF NOT EXISTS idx_observations_business_repo
  ON codegraph_observations(business_id, repo_owner, repo_name, stale, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_business_session
  ON codegraph_observations(business_id, session_id);
