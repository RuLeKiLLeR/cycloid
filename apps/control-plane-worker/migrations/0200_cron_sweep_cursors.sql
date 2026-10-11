CREATE TABLE IF NOT EXISTS cron_sweep_cursors (
  job_name TEXT PRIMARY KEY,
  cursor TEXT,
  last_updated_at INTEGER NOT NULL,
  last_processed_at INTEGER
);
