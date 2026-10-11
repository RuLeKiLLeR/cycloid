-- Serialize first-class PR takeover admission before a session's normal
-- pr_coordination row is bound to the adopted pull request.
CREATE TABLE IF NOT EXISTS pr_takeover_admission_claims (
  pr_url TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
