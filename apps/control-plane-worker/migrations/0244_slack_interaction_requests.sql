-- Durable one-shot Slack interaction requests. Every actionable Slack button
-- (answer/retry/resume/approve/stale/wake/beat) writes a pending row when the
-- button is posted; the interactions webhook consumes it exactly once on click.
-- The row is the authorization + single-consume anchor: Slack payloads are
-- hints, the stored business/session binding is the authority.
--
-- `kind` and `status` are code-validated (src/enums/slack-interaction.ts) with
-- no CHECK constraints on purpose: SQLite constraint changes force full table
-- rebuilds, so evolvable enum columns stay constraint-free. Timestamps are
-- unix-ms integers.
CREATE TABLE IF NOT EXISTS slack_interaction_requests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  message_ts TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sir_pending ON slack_interaction_requests (session_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_sir_expiry ON slack_interaction_requests (status, expires_at);
