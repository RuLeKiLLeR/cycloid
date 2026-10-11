-- One row per PR while a triggered review is in flight.
-- Stale rows can be atomically overtaken so crashed sessions do not block future reviews.
CREATE TABLE IF NOT EXISTS pr_review_trigger_claims (
  pr_url TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  trigger_comment_id INTEGER NOT NULL,
  session_id TEXT
);
