-- ARC-1018: per-installation repo-list cache to kill the GitHub API fan-out.
--
-- listAccessibleReposForUser already caches the merged repo list per user (KV +
-- memory), but on every cache miss it still fanned out one
-- /user/installations/{id}/repositories call per "selected" installation.
-- GitHub has no batch endpoint, so cache each installation's repo set per user
-- with a TTL; webhooks invalidate by installation_id.
CREATE TABLE IF NOT EXISTS github_installation_repositories_cache (
  user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repositories_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_github_installation_repositories_cache_installation
  ON github_installation_repositories_cache(installation_id);
