ALTER TABLE repo_images ADD COLUMN base_branch TEXT;

CREATE INDEX IF NOT EXISTS idx_repo_images_lookup
  ON repo_images(repo_owner, repo_name, base_branch, status, modal_environment, sandbox_image_version, created_at);
