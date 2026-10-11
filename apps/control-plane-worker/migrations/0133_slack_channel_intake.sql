CREATE TABLE IF NOT EXISTS slack_channel_intake (
  business_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('customer','incident','support','sales','generic')),
  scope_id TEXT,
  enabled_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  enabled_by_user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (business_id, team_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_intake_team_channel
  ON slack_channel_intake(team_id, channel_id);
