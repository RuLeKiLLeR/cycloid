WITH ranked_builds AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        repo_owner,
        repo_name,
        COALESCE(base_branch, ''),
        COALESCE(modal_environment, ''),
        COALESCE(sandbox_image_version, '')
      ORDER BY created_at DESC, id DESC
    ) AS row_num
  FROM repo_images
  WHERE status = 'building'
)
UPDATE repo_images
SET
  status = 'failed',
  error = 'Superseded before unique building index migration',
  completed_at = unixepoch() * 1000
WHERE id IN (
  SELECT id FROM ranked_builds WHERE row_num > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_images_building_unique
  ON repo_images(
    repo_owner,
    repo_name,
    COALESCE(base_branch, ''),
    COALESCE(modal_environment, ''),
    COALESCE(sandbox_image_version, '')
  )
  WHERE status = 'building';
