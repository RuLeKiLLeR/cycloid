CREATE TABLE IF NOT EXISTS session_pr_metadata (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  pr_number INTEGER,
  pr_draft INTEGER,
  published_branch TEXT,
  source_prompt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url)
);

CREATE INDEX IF NOT EXISTS idx_session_pr_metadata_latest
  ON session_pr_metadata(session_id, updated_at DESC, pr_url DESC);

INSERT OR IGNORE INTO session_pr_metadata (
  session_id,
  pr_url,
  pr_draft,
  created_at,
  updated_at
)
SELECT
  session_id,
  pr_url,
  pr_draft,
  completed_at,
  completed_at
FROM (
  SELECT
    session_id,
    pr_url,
    pr_draft,
    completed_at,
    ROW_NUMBER() OVER (
      PARTITION BY session_id, pr_url
      ORDER BY completed_at DESC
    ) AS rn
  FROM session_completions
  WHERE pr_url IS NOT NULL
)
WHERE rn = 1;
