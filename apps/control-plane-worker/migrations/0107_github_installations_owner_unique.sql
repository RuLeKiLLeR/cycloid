DELETE FROM github_installations
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY owner_login COLLATE NOCASE
        ORDER BY created_at DESC, id DESC
      ) AS duplicate_rank
    FROM github_installations
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_owner_nocase_unique
  ON github_installations(owner_login COLLATE NOCASE);
