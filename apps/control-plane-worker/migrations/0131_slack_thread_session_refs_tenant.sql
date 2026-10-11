CREATE TABLE IF NOT EXISTS slack_thread_session_refs (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS slack_thread_session_refs_new (
  business_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(business_id, team_id, channel_id, thread_ts)
);

INSERT OR IGNORE INTO slack_thread_session_refs_new
  (business_id, team_id, channel_id, thread_ts, session_id, updated_at_ms)
SELECT
  session_index.business_id,
  '',
  refs.channel_id,
  refs.thread_ts,
  refs.session_id,
  CASE
    WHEN typeof(refs.updated_at) IN ('integer', 'real') THEN CAST(refs.updated_at AS INTEGER)
    ELSE COALESCE(CAST(strftime('%s', refs.updated_at) AS INTEGER) * 1000, unixepoch() * 1000)
  END
FROM slack_thread_session_refs refs
JOIN session_index ON session_index.session_id = refs.session_id
WHERE session_index.business_id IS NOT NULL;

DROP TABLE slack_thread_session_refs;
ALTER TABLE slack_thread_session_refs_new RENAME TO slack_thread_session_refs;

CREATE INDEX IF NOT EXISTS idx_slack_thread_refs_business_lookup
  ON slack_thread_session_refs(business_id, team_id, channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_slack_thread_refs_business_session
  ON slack_thread_session_refs(business_id, session_id);
