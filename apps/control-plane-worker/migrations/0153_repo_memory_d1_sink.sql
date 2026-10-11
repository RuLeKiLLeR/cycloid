-- Store repo memories directly in D1 when the memory sink bypasses Git PRs.
-- The full MemoryFile is preserved as JSON while common fields are indexed for
-- retrieval, observability, and future training.

CREATE TABLE IF NOT EXISTS repo_memories (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  memory_type TEXT NOT NULL,
  action_type TEXT,
  level TEXT NOT NULL,
  primitive TEXT NOT NULL,
  confidence TEXT NOT NULL,
  authority TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  context_hint TEXT NOT NULL,
  content TEXT NOT NULL,
  applies_to_json TEXT NOT NULL,
  source_pr_url TEXT,
  source_pr_number INTEGER,
  source_session_ids_json TEXT NOT NULL,
  memory_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(repo_owner, repo_name, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_repo_memories_repo_status_updated
  ON repo_memories(repo_owner, repo_name, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_repo_memories_source_pr
  ON repo_memories(repo_owner, repo_name, source_pr_number);

CREATE TABLE IF NOT EXISTS repo_memory_judgments (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  source_pr_url TEXT NOT NULL,
  source_pr_number INTEGER NOT NULL,
  source_session_ids_json TEXT NOT NULL,
  suggestion_kind TEXT NOT NULL CHECK (suggestion_kind IN ('add', 'update', 'remove')),
  target_memory_id TEXT,
  memory_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('store', 'reject')),
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repo_memory_judgments_repo_source_pr
  ON repo_memory_judgments(repo_owner, repo_name, source_pr_number, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_repo_memory_judgments_verdict
  ON repo_memory_judgments(repo_owner, repo_name, verdict, created_at_ms DESC);
