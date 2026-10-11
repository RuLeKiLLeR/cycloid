-- Drop the warm sandbox pool tables. The warm-pool subsystem (a latency
-- optimization that pre-booted E2B VMs for tryarcanist/arcanist only) has been
-- removed: all sessions now cold-spawn, which was already the constant fallback
-- on every pool miss. The control-plane code, cron handlers, reaper source, and
-- sandbox-image prepare-pool script were already deleted and deployed in PR
-- #5171; this drop is split into its own migration-only PR per the migration-PR
-- gate, so these tables have zero remaining readers/writers when it runs.
-- Destructive-change exception:
-- proven zero readers, pure latency feature, no data to preserve. SQLite drops
-- each table's indices automatically. Do not edit the creating migrations
-- (0090, 0091, 0118, 0167, 0168) — they are deployed.
DROP TABLE IF EXISTS warm_sandbox_pool_entries;
DROP TABLE IF EXISTS warm_sandbox_pool_specs;
