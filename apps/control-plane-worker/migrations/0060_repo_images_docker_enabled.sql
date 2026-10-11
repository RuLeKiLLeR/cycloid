ALTER TABLE repo_images ADD COLUMN docker_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE repo_images
SET docker_enabled = 0
WHERE docker_enabled IS NULL;

DROP INDEX IF EXISTS idx_repo_images_lookup;
CREATE INDEX IF NOT EXISTS idx_repo_images_lookup
  ON repo_images(repo_owner, repo_name, base_branch, status, modal_environment, sandbox_image_version, docker_enabled, created_at);

DROP INDEX IF EXISTS idx_repo_images_building_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_images_building_unique
  ON repo_images(
    repo_owner,
    repo_name,
    COALESCE(base_branch, ''),
    COALESCE(modal_environment, ''),
    COALESCE(sandbox_image_version, ''),
    COALESCE(docker_enabled, 0)
  )
  WHERE status = 'building';
