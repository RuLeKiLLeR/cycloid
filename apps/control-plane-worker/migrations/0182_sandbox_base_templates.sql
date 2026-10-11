CREATE TABLE IF NOT EXISTS sandbox_base_templates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  runtime_backend TEXT NOT NULL,
  resource_profile_key TEXT NOT NULL,
  base_template_ref TEXT NOT NULL,
  base_version TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  registered_by_kind TEXT NOT NULL,
  registered_by_user_id INTEGER,
  github_actor TEXT,
  git_sha TEXT,
  workflow_run_url TEXT,
  smoke_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_base_templates_current
  ON sandbox_base_templates (runtime_backend, resource_profile_key)
  WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_sandbox_base_templates_profile_created
  ON sandbox_base_templates (runtime_backend, resource_profile_key, created_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_layer_rebuild_campaigns (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  business_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS sandbox_layer_rebuild_campaign_items (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  resource_profile_key TEXT NOT NULL,
  previous_artifact_id TEXT NOT NULL,
  previous_build_id TEXT NOT NULL,
  previous_base_template_ref TEXT NOT NULL,
  previous_base_version TEXT NOT NULL,
  target_base_template_ref TEXT NOT NULL,
  target_base_version TEXT NOT NULL,
  build_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  FOREIGN KEY (campaign_id) REFERENCES sandbox_layer_rebuild_campaigns(id)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_rebuild_campaign_items_campaign
  ON sandbox_layer_rebuild_campaign_items (campaign_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_layer_rebuild_campaign_items_identity
  ON sandbox_layer_rebuild_campaign_items (
    campaign_id,
    source_id,
    resource_profile_key,
    target_base_template_ref,
    target_base_version
  );

ALTER TABLE sandbox_layer_builds ADD COLUMN rebuild_campaign_id TEXT;
ALTER TABLE sandbox_layer_builds ADD COLUMN build_reason TEXT;
