CREATE TABLE pending_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  requested_at INTEGER NOT NULL,
  denied_at INTEGER,
  denied_by_user_id INTEGER REFERENCES users(id),
  CHECK (
    (denied_at IS NULL AND denied_by_user_id IS NULL) OR
    (denied_at IS NOT NULL AND denied_by_user_id IS NOT NULL)
  )
);

CREATE INDEX idx_pending_signups_pending ON pending_signups(requested_at) WHERE denied_at IS NULL;
