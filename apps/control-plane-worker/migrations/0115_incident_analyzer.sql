CREATE TABLE IF NOT EXISTS incident_analyzer_configs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  slack_channel_id TEXT,
  github_label TEXT,
  enabled_sources_json TEXT NOT NULL,
  allowed_repos_json TEXT NOT NULL,
  ignore_rules_json TEXT NOT NULL,
  severity_rules_json TEXT NOT NULL,
  owner_routing_hints_json TEXT NOT NULL,
  runbook_paths_json TEXT NOT NULL,
  policy_prompt TEXT,
  configured_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_analyzer_configs_business
  ON incident_analyzer_configs (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_analyzer_configs_repo
  ON incident_analyzer_configs (business_id, repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS incident_scratchpad_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved', 'ignored')),
  suspected_service TEXT,
  suspected_code_area TEXT,
  likely_owner TEXT,
  owner_confidence REAL,
  linked_session_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_scratchpad_active_fingerprint
  ON incident_scratchpad_entries (business_id, fingerprint, status, repo_owner, repo_name, last_seen_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_scratchpad_one_active_fingerprint
  ON incident_scratchpad_entries (business_id, fingerprint)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_incident_scratchpad_session
  ON incident_scratchpad_entries (linked_session_id);

CREATE TABLE IF NOT EXISTS incident_scratchpad_refs (
  id TEXT PRIMARY KEY,
  scratchpad_entry_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('slack', 'github_issue', 'github_comment')),
  external_ref TEXT NOT NULL,
  url TEXT,
  text_preview TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_scratchpad_refs_external
  ON incident_scratchpad_refs (scratchpad_entry_id, source, external_ref);

CREATE INDEX IF NOT EXISTS idx_incident_scratchpad_refs_entry
  ON incident_scratchpad_refs (scratchpad_entry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS incident_analyzer_activity (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('slack', 'github_issue', 'github_comment')),
  external_ref TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ignored', 'duplicate', 'asked_context', 'launched_session', 'errored')),
  reason TEXT,
  fingerprint TEXT,
  scratchpad_entry_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_analyzer_activity_business
  ON incident_analyzer_activity (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_analyzer_activity_ref
  ON incident_analyzer_activity (source, external_ref, created_at DESC);
