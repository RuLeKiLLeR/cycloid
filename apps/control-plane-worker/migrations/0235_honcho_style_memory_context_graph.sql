-- Honcho-style pull memory graph. D1 remains the authoritative store; vector
-- indexes are candidate-generation caches only.

CREATE TABLE IF NOT EXISTS memory_scopes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('business','repo','customer','slack_thread','session','incident','person')),
  scope_key TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  customer_slug TEXT,
  slack_team_id TEXT,
  slack_channel_id TEXT,
  slack_thread_ts TEXT,
  session_id TEXT,
  incident_id TEXT,
  person_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(business_id, scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_scopes_business_type
  ON memory_scopes(business_id, scope_type, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_scopes_repo
  ON memory_scopes(business_id, repo_owner, repo_name, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_scopes_session
  ON memory_scopes(session_id);

CREATE TABLE IF NOT EXISTS memory_peers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  peer_type TEXT NOT NULL CHECK (peer_type IN ('human','agent','repo','customer','channel','system','session','incident')),
  peer_key TEXT NOT NULL,
  display_name TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(business_id, peer_type, peer_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_peers_business_type
  ON memory_peers(business_id, peer_type, deleted_at_ms);

CREATE TABLE IF NOT EXISTS memory_sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('arcanist_session','slack_thread','github_pr','github_issue','linear_issue','jira_issue','manual','system')),
  source_id TEXT NOT NULL,
  source_uri TEXT,
  title TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id),
  UNIQUE(business_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_sessions_scope
  ON memory_sessions(scope_id, deleted_at_ms, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS memory_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq_in_session INTEGER NOT NULL,
  peer_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','agent','tool','system','external')),
  content_text TEXT NOT NULL,
  content_json TEXT,
  source_uri TEXT,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES memory_sessions(id),
  FOREIGN KEY (peer_id) REFERENCES memory_peers(id),
  UNIQUE(session_id, seq_in_session)
);

CREATE INDEX IF NOT EXISTS idx_memory_messages_session_seq
  ON memory_messages(session_id, seq_in_session);
CREATE INDEX IF NOT EXISTS idx_memory_messages_business_time
  ON memory_messages(business_id, occurred_at_ms DESC, deleted_at_ms);

CREATE TABLE IF NOT EXISTS memory_collections (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  observer_peer_id TEXT NOT NULL,
  observed_peer_id TEXT NOT NULL,
  collection_kind TEXT NOT NULL CHECK (collection_kind IN ('working','long_term','repo','company','session')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id),
  FOREIGN KEY (observer_peer_id) REFERENCES memory_peers(id),
  FOREIGN KEY (observed_peer_id) REFERENCES memory_peers(id),
  UNIQUE(scope_id, observer_peer_id, observed_peer_id, collection_kind)
);

CREATE INDEX IF NOT EXISTS idx_memory_collections_business_scope
  ON memory_collections(business_id, scope_id, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_collections_direction
  ON memory_collections(observer_peer_id, observed_peer_id, deleted_at_ms);

CREATE TABLE IF NOT EXISTS memory_conclusions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('explicit','deductive','inductive','contradiction')),
  status TEXT NOT NULL CHECK (status IN ('active','proposed','superseded','rejected','expired','deleted')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  authority TEXT NOT NULL CHECK (authority IN ('inferred','reviewed','source_of_truth')),
  enforcement TEXT NOT NULL DEFAULT 'none' CHECK (enforcement IN ('none','suggest','warn','block')),
  source_kind TEXT,
  source_id TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  positive_feedback_count INTEGER NOT NULL DEFAULT 0,
  negative_feedback_count INTEGER NOT NULL DEFAULT 0,
  times_derived INTEGER NOT NULL DEFAULT 0,
  valid_until_ms INTEGER,
  superseded_by TEXT,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (collection_id) REFERENCES memory_collections(id),
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id),
  FOREIGN KEY (superseded_by) REFERENCES memory_conclusions(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_conclusions_business_status
  ON memory_conclusions(business_id, status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_conclusions_scope_status
  ON memory_conclusions(scope_id, status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_conclusions_collection_status
  ON memory_conclusions(collection_id, status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_conclusions_repo_status
  ON memory_conclusions(repo_owner, repo_name, status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_conclusions_reinforced
  ON memory_conclusions(scope_id, status, reinforcement_count DESC, times_derived DESC);

CREATE TABLE IF NOT EXISTS memory_scope_cards (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  observer_peer_id TEXT NOT NULL,
  observed_peer_id TEXT NOT NULL,
  card_json TEXT NOT NULL DEFAULT '{}',
  source_conclusion_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','deleted')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id),
  FOREIGN KEY (observer_peer_id) REFERENCES memory_peers(id),
  FOREIGN KEY (observed_peer_id) REFERENCES memory_peers(id),
  UNIQUE(scope_id, observer_peer_id, observed_peer_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_scope_cards_scope_status
  ON memory_scope_cards(scope_id, status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_scope_cards_business
  ON memory_scope_cards(business_id, status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS memory_conclusion_sources (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  conclusion_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('memory_message','memory_conclusion','repo_memory','company_fact','company_take','ingestion_event','manual')),
  source_id TEXT NOT NULL,
  source_uri TEXT,
  excerpt TEXT,
  relationship TEXT NOT NULL CHECK (relationship IN ('supports','contradicts','supersedes','derived_from','cites')),
  created_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  FOREIGN KEY (conclusion_id) REFERENCES memory_conclusions(id),
  UNIQUE(conclusion_id, source_kind, source_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_memory_conclusion_sources_conclusion
  ON memory_conclusion_sources(conclusion_id, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_conclusion_sources_source
  ON memory_conclusion_sources(business_id, source_kind, source_id, deleted_at_ms);

CREATE TABLE IF NOT EXISTS memory_work_items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  work_type TEXT NOT NULL CHECK (work_type IN ('derive','consolidate','vector_sync','backfill')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('memory_session','memory_message','memory_conclusion','memory_scope','repo_memory','company_fact','company_take','semantic_document')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','canceled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  locked_until_ms INTEGER,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_work_items_queue
  ON memory_work_items(status, available_at_ms, priority DESC, attempts);
CREATE INDEX IF NOT EXISTS idx_memory_work_items_target
  ON memory_work_items(business_id, target_kind, target_id, status);

CREATE TABLE IF NOT EXISTS memory_context_queries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  session_id TEXT,
  prompt_id TEXT,
  scope_id TEXT,
  intent TEXT NOT NULL,
  request_json TEXT NOT NULL,
  lane_counts_json TEXT NOT NULL DEFAULT '{}',
  vector_available INTEGER NOT NULL DEFAULT 0 CHECK (vector_available IN (0, 1)),
  vector_unavailable_reason TEXT,
  fusion_mode TEXT NOT NULL CHECK (fusion_mode IN ('none','deterministic','rrf')),
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_ids_json TEXT NOT NULL DEFAULT '[]',
  rejected_json TEXT NOT NULL DEFAULT '[]',
  selector_status TEXT NOT NULL CHECK (selector_status IN ('not_run','selected','empty','failed','timeout')),
  selector_model TEXT,
  selector_latency_ms INTEGER,
  trace_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_context_queries_business_created
  ON memory_context_queries(business_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_context_queries_session
  ON memory_context_queries(session_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS memory_semantic_documents (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'memory_conclusion',
    'memory_message',
    'memory_scope_card',
    'repo_memory',
    'company_fact',
    'company_take'
  )),
  source_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim INTEGER NOT NULL,
  vector_namespace TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  vector_state TEXT NOT NULL CHECK (vector_state IN ('pending','synced','failed','deleted')),
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  last_sync_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(source_kind, source_id, embedding_model)
);

CREATE INDEX IF NOT EXISTS idx_memory_semantic_documents_queue
  ON memory_semantic_documents(vector_state, last_sync_at_ms, sync_attempts);
CREATE INDEX IF NOT EXISTS idx_memory_semantic_documents_business_source
  ON memory_semantic_documents(business_id, source_kind, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_semantic_documents_repo_source
  ON memory_semantic_documents(repo_owner, repo_name, source_kind, deleted_at_ms);
CREATE INDEX IF NOT EXISTS idx_memory_semantic_documents_scope
  ON memory_semantic_documents(scope_type, scope_id, deleted_at_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS repo_memories_fts USING fts5(
  context_hint,
  content,
  primitive,
  applies_to_json,
  content='repo_memories',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS repo_memories_fts_ai AFTER INSERT ON repo_memories BEGIN
  INSERT INTO repo_memories_fts(rowid, context_hint, content, primitive, applies_to_json)
  VALUES (new.rowid, new.context_hint, new.content, new.primitive, new.applies_to_json);
END;

CREATE TRIGGER IF NOT EXISTS repo_memories_fts_ad AFTER DELETE ON repo_memories BEGIN
  INSERT INTO repo_memories_fts(repo_memories_fts, rowid, context_hint, content, primitive, applies_to_json)
  VALUES('delete', old.rowid, old.context_hint, old.content, old.primitive, old.applies_to_json);
END;

CREATE TRIGGER IF NOT EXISTS repo_memories_fts_au AFTER UPDATE ON repo_memories BEGIN
  INSERT INTO repo_memories_fts(repo_memories_fts, rowid, context_hint, content, primitive, applies_to_json)
  VALUES('delete', old.rowid, old.context_hint, old.content, old.primitive, old.applies_to_json);
  INSERT INTO repo_memories_fts(rowid, context_hint, content, primitive, applies_to_json)
  VALUES (new.rowid, new.context_hint, new.content, new.primitive, new.applies_to_json);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_conclusions_fts USING fts5(
  content,
  content='memory_conclusions',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_conclusions_fts_ai AFTER INSERT ON memory_conclusions BEGIN
  INSERT INTO memory_conclusions_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_conclusions_fts_ad AFTER DELETE ON memory_conclusions BEGIN
  INSERT INTO memory_conclusions_fts(memory_conclusions_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_conclusions_fts_au AFTER UPDATE ON memory_conclusions BEGIN
  INSERT INTO memory_conclusions_fts(memory_conclusions_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memory_conclusions_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_messages_fts USING fts5(
  content_text,
  content='memory_messages',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_messages_fts_ai AFTER INSERT ON memory_messages BEGIN
  INSERT INTO memory_messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_messages_fts_ad AFTER DELETE ON memory_messages BEGIN
  INSERT INTO memory_messages_fts(memory_messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_messages_fts_au AFTER UPDATE ON memory_messages BEGIN
  INSERT INTO memory_messages_fts(memory_messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
  INSERT INTO memory_messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

INSERT INTO repo_memories_fts(repo_memories_fts) VALUES('rebuild');
INSERT INTO memory_conclusions_fts(memory_conclusions_fts) VALUES('rebuild');
INSERT INTO memory_messages_fts(memory_messages_fts) VALUES('rebuild');
