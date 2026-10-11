ALTER TABLE slack_workspaces ADD COLUMN business_id TEXT;
ALTER TABLE slack_workspaces ADD COLUMN team_domain TEXT;
ALTER TABLE slack_workspaces ADD COLUMN enterprise_id TEXT;

CREATE INDEX IF NOT EXISTS idx_slack_workspaces_business
  ON slack_workspaces(business_id);
CREATE INDEX IF NOT EXISTS idx_slack_workspaces_enterprise
  ON slack_workspaces(enterprise_id);
