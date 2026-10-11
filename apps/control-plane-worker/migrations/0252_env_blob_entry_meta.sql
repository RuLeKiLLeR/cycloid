-- Per-key metadata for repo/personal env blobs: usage notes + sensitive flags.
-- Values remain encrypted in env_text; this column is write-visible metadata only.
ALTER TABLE env_blobs ADD COLUMN entry_meta_json TEXT NOT NULL DEFAULT '{}';
