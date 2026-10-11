CREATE TABLE IF NOT EXISTS memory_review_candidates (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL,
  candidate_type        TEXT NOT NULL
    CHECK(candidate_type IN ('d1_supersession','d1_contradiction','d1_expiration','repo_pr_needed','cross_store_conflict','duplicate')),
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','applied','approved','rejected','dismissed')),
  primary_store         TEXT NOT NULL CHECK(primary_store IN ('d1','repo')),
  primary_memory_id     TEXT NOT NULL,
  secondary_store       TEXT CHECK(secondary_store IN ('d1','repo')),
  secondary_memory_id   TEXT,
  repo_owner            TEXT,
  repo_name             TEXT,
  repo_memory_path      TEXT,
  proposed_action       TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  evidence_json         TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  created_at_ms         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  resolved_at_ms        INTEGER,
  resolved_by_user_id   INTEGER REFERENCES users(id),
  UNIQUE (business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_review_business_status
  ON memory_review_candidates(business_id, status, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_review_repo
  ON memory_review_candidates(repo_owner, repo_name, status);

CREATE TABLE IF NOT EXISTS memory_reconciliation_cursors (
  business_id         TEXT NOT NULL,
  cursor_type         TEXT NOT NULL CHECK(cursor_type IN ('d1','repo','cross_store')),
  repo_owner          TEXT NOT NULL DEFAULT '',
  repo_name           TEXT NOT NULL DEFAULT '',
  cursor_json         TEXT,
  last_scanned_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (business_id, cursor_type, repo_owner, repo_name)
);
