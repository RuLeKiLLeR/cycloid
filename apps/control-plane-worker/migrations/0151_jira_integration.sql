-- Jira integration: business webhook installations, issue->session refs, per-user site selection.
-- Timestamps are INTEGER Unix milliseconds except *_session_refs.updated_at, which mirrors the
-- linear_issue_session_refs TEXT ISO format so the shared displacement helpers stay uniform.

CREATE TABLE IF NOT EXISTS jira_webhook_installations (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  jira_cloud_id TEXT NOT NULL,
  site_url TEXT,
  site_name TEXT,
  webhooks_json TEXT,
  installation_token TEXT NOT NULL,
  trigger_label TEXT,
  connected_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'degraded', 'revoked')),
  webhook_registered_at INTEGER,
  webhook_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (business_id, jira_cloud_id)
);

-- Webhook ingress resolves the installation by URL token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_webhook_installations_token
  ON jira_webhook_installations(installation_token);

-- One business per Jira site while the binding is not revoked (mirrors
-- idx_linear_webhook_installations_org_active in 0070).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_webhook_installations_cloud_active
  ON jira_webhook_installations(jira_cloud_id)
  WHERE status != 'revoked';

CREATE TABLE IF NOT EXISTS jira_issue_session_refs (
  jira_issue_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jira_issue_session_refs_session
  ON jira_issue_session_refs(session_id);

-- One selected Jira site per user (v1 constraint; reconnect switches site).
-- jira_account_id is a denormalized display copy; actor resolution uses
-- user_integrations.external_user_id and its existing unique index.
CREATE TABLE IF NOT EXISTS jira_user_sites (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  jira_cloud_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  site_name TEXT,
  jira_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
