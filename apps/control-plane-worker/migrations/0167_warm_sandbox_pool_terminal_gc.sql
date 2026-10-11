-- Deep-plan 6.3: GC of terminal warm_sandbox_pool_entries.
--
-- Before: drain/fail paths only flip status to 'draining'/'failed'; there is no
-- DELETE anywhere, so terminal rows accumulate forever (678 in prod, up to 46
-- days old, all still retaining runtime_sandbox_id).
--
-- After: reconcile sweeps terminal rows older than a retention window via
-- `deleteTerminalWarmSandboxPoolEntries`. This partial index serves that GC
-- query (status IN ('draining','failed') ORDER BY updated_at ASC).
CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_entries_terminal_gc
  ON warm_sandbox_pool_entries(status, updated_at)
  WHERE status IN ('draining', 'failed');
