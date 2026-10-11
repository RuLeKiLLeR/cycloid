CREATE TABLE IF NOT EXISTS ingestion_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_event_id TEXT,
  source_uri TEXT NOT NULL,
  source_time_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_text TEXT,
  content_ref TEXT,
  scope_type TEXT,
  scope_id TEXT,
  actor_ref TEXT,
  team_id TEXT,
  channel_id TEXT,
  thread_ts TEXT,
  untrusted_payload INTEGER NOT NULL DEFAULT 0,
  processing_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(processing_state IN ('pending','processing','complete','failed','skipped','quarantined')),
  redaction_reason TEXT,
  skip_reason TEXT,
  received_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  processed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ingestion_business_scope
  ON ingestion_events(business_id, scope_type, scope_id, source_time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_business_thread
  ON ingestion_events(business_id, team_id, channel_id, thread_ts, source_time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_business_state
  ON ingestion_events(business_id, processing_state, received_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_event_id
  ON ingestion_events(business_id, source_type, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingestion_content_hash
  ON ingestion_events(business_id, source_type, content_hash);
