CREATE TABLE IF NOT EXISTS session_index (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  last_event_id TEXT
);

CREATE TABLE IF NOT EXISTS durable_event_replay_metadata (
  session_id TEXT PRIMARY KEY,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  last_event_timestamp TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  payload_hash TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
