-- Drop abandoned-feature tables that still hold historical rows. These features
-- have zero application readers but their tables are non-empty, so this migration
-- discards stale data and must run only after a D1 export (see plan Verification).
-- Drops FK children before parents.
--
-- Terminal bench (0063/0065): full FK family. Every child references its parent
-- with ON DELETE CASCADE; benchmark_task_run_artifacts is empty but is grouped
-- here so the family drops atomically rather than split across migrations.
DROP TABLE IF EXISTS benchmark_task_run_events;
DROP TABLE IF EXISTS benchmark_task_run_artifacts;
DROP TABLE IF EXISTS benchmark_run_events;
DROP TABLE IF EXISTS benchmark_task_runs;
DROP TABLE IF EXISTS benchmark_runs;

-- Incident analyzer (0115): no foreign keys between these tables, so order is
-- irrelevant. incident_analyzer_configs is empty and dropped in 0169.
DROP TABLE IF EXISTS incident_scratchpad_refs;
DROP TABLE IF EXISTS incident_scratchpad_entries;
DROP TABLE IF EXISTS incident_analyzer_activity;

-- Repo image prebuild (0016): feature code removed in #2556/#2559.
DROP TABLE IF EXISTS repo_images;

-- Per-user integration health checks (0096): superseded by
-- business_integration_health_checks (live in src/integrations/health-db.ts).
DROP TABLE IF EXISTS user_integration_health_checks;
