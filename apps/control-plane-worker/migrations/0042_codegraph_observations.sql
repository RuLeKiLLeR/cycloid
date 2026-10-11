CREATE TABLE IF NOT EXISTS codegraph_observations (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  node_id TEXT,
  file_path TEXT,
  observation TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK(observation_type IN ('architecture','bug','pattern','decision','gotcha','dependency')),
  confidence REAL NOT NULL DEFAULT 1.0,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  staled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_observations_repo ON codegraph_observations(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_observations_node ON codegraph_observations(node_id);
CREATE INDEX IF NOT EXISTS idx_observations_stale ON codegraph_observations(stale);
CREATE INDEX IF NOT EXISTS idx_observations_session ON codegraph_observations(session_id);
