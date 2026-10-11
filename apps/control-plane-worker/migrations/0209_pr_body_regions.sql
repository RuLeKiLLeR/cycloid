CREATE TABLE IF NOT EXISTS pr_body_documents (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  base_body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, installation_id, pr_number)
);

CREATE TABLE IF NOT EXISTS pr_body_regions (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  region TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, installation_id, pr_number, region)
);

CREATE INDEX IF NOT EXISTS idx_pr_body_regions_pr_lookup
  ON pr_body_regions(repo_owner, repo_name, installation_id, pr_number);

CREATE TABLE IF NOT EXISTS pr_body_locks (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, installation_id, pr_number)
);
