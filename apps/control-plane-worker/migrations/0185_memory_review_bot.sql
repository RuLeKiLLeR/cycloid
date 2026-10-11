CREATE TABLE IF NOT EXISTS memory_review_bot_runs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  prompt_outcome TEXT NOT NULL
    CHECK(prompt_outcome IN ('true_positive', 'false_positive', 'true_negative', 'false_negative')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  failure_code TEXT,
  session_event_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(session_event_status IN ('pending', 'sent', 'failed', 'skipped')),
  session_event_id TEXT,
  session_event_error TEXT,
  slack_post_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(slack_post_status IN ('pending', 'sent', 'failed', 'skipped_config')),
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  slack_error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd_micros INTEGER,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(session_id, prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_review_bot_runs_business_prompt
  ON memory_review_bot_runs(business_id, session_id, prompt_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS memory_review_bot_recall_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES memory_review_bot_runs(id),
  business_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('recall', 'company_recall')),
  memory_count INTEGER NOT NULL,
  relevant_count INTEGER NOT NULL,
  useful_count INTEGER NOT NULL,
  hurt_count INTEGER NOT NULL,
  prompt_outcome TEXT NOT NULL
    CHECK(prompt_outcome IN ('true_positive', 'false_positive', 'true_negative', 'false_negative')),
  aggregate_effect TEXT NOT NULL CHECK(aggregate_effect IN ('helped', 'hurt', 'neutral')),
  provenance_notes_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_review_bot_recall_results_run_source
  ON memory_review_bot_recall_results(run_id, source);

CREATE TABLE IF NOT EXISTS memory_review_bot_item_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES memory_review_bot_runs(id),
  business_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('recall', 'company_recall')),
  relevance TEXT NOT NULL CHECK(relevance IN ('relevant', 'borderline', 'irrelevant')),
  usefulness TEXT NOT NULL CHECK(usefulness IN ('useful', 'not_useful')),
  effect TEXT NOT NULL CHECK(effect IN ('helped', 'hurt', 'neutral')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'superseded', 'expired', 'rejected', 'unknown')),
  root_causes_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope_status TEXT NOT NULL CHECK(scope_status IN ('in_scope', 'out_of_scope', 'unknown')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_review_bot_item_results_run_memory
  ON memory_review_bot_item_results(run_id, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_review_bot_item_results_business_memory
  ON memory_review_bot_item_results(business_id, memory_id, created_at_ms DESC);
