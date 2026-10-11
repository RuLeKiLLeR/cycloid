-- Atomic child-session admission control for ARC-792.
-- A child creation reserves one row before the session is initialized. The
-- INSERT ... SELECT statement in the DAO admits the child only while all caps
-- remain below limit, closing the check/create race between concurrent calls.

CREATE TABLE IF NOT EXISTS child_session_limit_reservations (
  child_session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_prompt_id TEXT NOT NULL,
  spawned_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  projected_at INTEGER,
  concurrent_released_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_child_session_limit_parent_prompt
  ON child_session_limit_reservations(parent_session_id, parent_prompt_id);

CREATE INDEX IF NOT EXISTS idx_child_session_limit_parent_session
  ON child_session_limit_reservations(parent_session_id);

CREATE INDEX IF NOT EXISTS idx_child_session_limit_user_concurrent
  ON child_session_limit_reservations(spawned_by_user_id, concurrent_released_at);

INSERT OR IGNORE INTO child_session_limit_reservations (
  child_session_id,
  parent_session_id,
  parent_prompt_id,
  spawned_by_user_id,
  created_at,
  projected_at,
  concurrent_released_at
)
SELECT
  session_id,
  parent_session_id,
  parent_prompt_id,
  spawned_by_user_id,
  COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0),
  COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0),
  CASE
    WHEN status = 'active' AND (rich_status IS NULL OR rich_status NOT IN ('closed', 'failed', 'canceled'))
      THEN NULL
    ELSE COALESCE(CAST(strftime('%s', closed_at) AS INTEGER) * 1000, CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0)
  END
FROM session_index
WHERE parent_session_id IS NOT NULL
  AND parent_prompt_id IS NOT NULL
  AND spawned_by_user_id IS NOT NULL;
