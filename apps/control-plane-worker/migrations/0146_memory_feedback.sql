CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  feedback_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  activity_event_id TEXT NOT NULL,
  display_event_type TEXT NOT NULL CHECK(display_event_type IN ('memory_usage', 'memory_recall_usage')),
  usage_source TEXT NOT NULL CHECK(usage_source IN ('prompt_start', 'recall', 'company_bootstrap')),
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_login TEXT,
  rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
  message TEXT,
  memory_title TEXT,
  memory_path TEXT,
  memory_reason TEXT,
  memory_expected_effect TEXT,
  memory_observed_effect TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  session_url TEXT,
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  slack_post_status TEXT CHECK(slack_post_status IN ('skipped_config', 'sent', 'failed') OR slack_post_status IS NULL),
  slack_post_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_key_created
  ON memory_feedback(feedback_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_session_prompt_created
  ON memory_feedback(session_id, prompt_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory_created
  ON memory_feedback(memory_id, created_at DESC);
