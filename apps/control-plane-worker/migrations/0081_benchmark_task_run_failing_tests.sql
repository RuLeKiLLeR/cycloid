-- Store the failing test list per task run so the evals dashboard can surface
-- individual failing test names. JSON-encoded array of { name, status } objects,
-- capped by the runner. Null means "not reported yet".

ALTER TABLE benchmark_task_runs ADD COLUMN failing_tests_json TEXT;
