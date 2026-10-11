-- Snapshot the runtime fingerprint into each pool entry so the reconciler can
-- detect drift after a deploy mutates the spec. Entries created before this
-- migration leave these columns NULL; the reconciler treats NULL as "unknown"
-- and drains.
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN sandbox_image_version TEXT;
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN runtime_environment TEXT;
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN docker_enabled INTEGER;
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN repo_head_sha TEXT;

-- Optional desired repo HEAD SHA. When set, the reconciler drains entries
-- whose snapshotted repo_head_sha does not match.
ALTER TABLE warm_sandbox_pool_specs ADD COLUMN repo_head_sha TEXT;
