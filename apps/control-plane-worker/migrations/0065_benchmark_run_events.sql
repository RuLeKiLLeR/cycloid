-- Run-level lifecycle events for benchmark observability.
-- Keep payloads sanitized: store coarse lifecycle state and short errors only.

CREATE TABLE IF NOT EXISTS benchmark_run_events (
  id TEXT PRIMARY KEY,
  benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  phase TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(benchmark_run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_events_run_sequence
  ON benchmark_run_events(benchmark_run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_benchmark_run_events_type
  ON benchmark_run_events(event_type);
