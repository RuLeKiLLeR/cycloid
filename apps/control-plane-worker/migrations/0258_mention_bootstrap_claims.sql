CREATE TABLE IF NOT EXISTS mention_bootstrap_claims (
  business_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, pr_url)
);
