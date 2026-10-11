CREATE TABLE IF NOT EXISTS session_webhook_refs (
  source TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source, external_ref, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_webhook_refs_session
  ON session_webhook_refs(session_id);
