-- First-party benchmark result storage for Terminal Bench and future eval suites.
-- Keep this schema sanitized: do not store hidden test source, full stdout/stderr,
-- full session transcripts, or task instructions in these tables.

ALTER TABLE session_index ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'repo';

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  benchmark TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  suite_kind TEXT NOT NULL CHECK(suite_kind IN ('daily', 'weekly', 'manual')),
  experiment TEXT,
  git_branch TEXT,
  git_sha TEXT,
  model TEXT,
  repeat INTEGER NOT NULL DEFAULT 1,
  concurrency INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  started_at INTEGER,
  completed_at INTEGER,
  total_task_runs INTEGER NOT NULL DEFAULT 0,
  resolved_task_runs INTEGER NOT NULL DEFAULT 0,
  pass_rate REAL,
  braintrust_url TEXT,
  runner_modal_object_id TEXT,
  runner_log_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_benchmark_created
  ON benchmark_runs(benchmark, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_suite_created
  ON benchmark_runs(suite_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status
  ON benchmark_runs(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_git_sha
  ON benchmark_runs(git_sha);

CREATE TABLE IF NOT EXISTS benchmark_task_runs (
  id TEXT PRIMARY KEY,
  benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  category TEXT,
  difficulty TEXT,
  run_index INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  prompt_id TEXT,
  modal_sandbox_id TEXT,
  modal_object_id TEXT,
  workspace_path TEXT,
  agent_timeout_sec INTEGER,
  test_timeout_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  phase TEXT,
  is_resolved INTEGER CHECK(is_resolved IS NULL OR is_resolved IN (0, 1)),
  failure_mode TEXT,
  agent_error TEXT,
  grading_error TEXT,
  duration_ms INTEGER,
  cost_usd_micros INTEGER,
  tool_call_count INTEGER,
  tests_passed INTEGER NOT NULL DEFAULT 0,
  tests_failed INTEGER NOT NULL DEFAULT 0,
  tests_error INTEGER NOT NULL DEFAULT 0,
  tests_skipped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(benchmark_run_id, task_id, run_index)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_task_runs_run_status
  ON benchmark_task_runs(benchmark_run_id, status);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_runs_task
  ON benchmark_task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_runs_session
  ON benchmark_task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_runs_failure_mode
  ON benchmark_task_runs(failure_mode);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_runs_category
  ON benchmark_task_runs(category);

CREATE TABLE IF NOT EXISTS benchmark_task_run_events (
  id TEXT PRIMARY KEY,
  benchmark_task_run_id TEXT NOT NULL REFERENCES benchmark_task_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  phase TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(benchmark_task_run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_task_run_events_task_sequence
  ON benchmark_task_run_events(benchmark_task_run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_run_events_type
  ON benchmark_task_run_events(event_type);

CREATE TABLE IF NOT EXISTS benchmark_task_run_artifacts (
  id TEXT PRIMARY KEY,
  benchmark_task_run_id TEXT NOT NULL REFERENCES benchmark_task_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  url TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_task_run_artifacts_task
  ON benchmark_task_run_artifacts(benchmark_task_run_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_task_run_artifacts_type
  ON benchmark_task_run_artifacts(artifact_type);
