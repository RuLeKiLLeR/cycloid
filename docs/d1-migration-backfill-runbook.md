# D1 migration tracking-table backfill runbook

One-time operator step run **between** the unblock PR ([1/3], #5531) and the engine-swap PR
([3/3], #5533) of the D1 migration engine unification series. It seeds wrangler's native tracking table
(`d1_migrations`) from the hand-rolled runner's table (`_schema_migrations`) so that flipping the
deploy to `wrangler d1 migrations apply` is a no-op for already-applied migrations instead of an
attempt to re-run all of them.

Run in QA first, verify, then prod. Human-run only: these are remote D1 writes, so agents must not
execute them. Prod D1 accepts a single statement per `d1 execute` (no multi-statement batches).

All commands run from `apps/control-plane-worker` so wrangler resolves `wrangler.toml`. QA also
needs `--env qa` (the QA D1 binding lives under `[env.qa.d1_databases]`, not top-level); prod uses
the top-level binding.

Set the database name per env:

- prod: `cycloid-control-plane-production` (no `--env`)
- QA: `cycloid-control-plane-qa` with `--env qa`

## 0. Precondition

The unblock PR ([1/3], 0197 comment reword) must already be merged and deployed via the old runner,
so `_schema_migrations` records 0197 and every later migration. If it has not deployed, stop and
deploy it first - otherwise the backfill copies an incomplete applied-set.

## 1. Force wrangler to create `d1_migrations` with its own schema

Do not hand-write the schema. Let wrangler create the table by listing migrations:

```bash
cd apps/control-plane-worker
# prod
npx wrangler d1 migrations list cycloid-control-plane-production --remote
# QA
npx wrangler d1 migrations list cycloid-control-plane-qa --remote --env qa
```

## 2. Pre-backfill audit

`_schema_migrations` records a migration as applied even when the old runner's per-statement
fallback silently commented real SQL out (the same fragility 0197 hit). Before trusting the table,
spot-check that the known-fragile migrations actually applied their schema, not just recorded a
row - at minimum 0197 and any earlier migration that went through the "duplicate column name"
fallback. Example check for 0197's column:

```bash
npx wrangler d1 execute cycloid-control-plane-production --remote \
  --command "SELECT name FROM pragma_table_info('pr_mergeability_attempts') WHERE name = 'update_branch_queued_at'"
```

If a row is recorded as applied but its schema change is missing, fix that env's schema before
backfilling. Do not copy a false record into wrangler's source of truth.

## 3. Backfill `d1_migrations` from `_schema_migrations`

Copy applied filenames across, normalizing to the exact on-disk filename. wrangler keys
`d1_migrations.name` on the migration's path relative to `migrations_dir` (for our flat layout: the
filename **with** `.sql`); the old runner may have stored names with or without the suffix, so
normalize. `INSERT OR IGNORE` makes re-running harmless.

```sql
INSERT OR IGNORE INTO d1_migrations (name, applied_at)
SELECT
  CASE WHEN name LIKE '%.sql' THEN name ELSE name || '.sql' END,
  applied_at
FROM _schema_migrations
ORDER BY version;
```

Run it as a single `d1 execute` with `--remote` (without `--remote`, wrangler writes to the local
dev SQLite file and the backfill silently no-ops against the real D1):

```bash
# prod
npx wrangler d1 execute cycloid-control-plane-production --remote --command "..."
# QA
npx wrangler d1 execute cycloid-control-plane-qa --remote --env qa --command "..."
```

## 4. Verify (name equality, not just count)

Both symmetric-diff directions must return zero rows. Compare the backfilled `d1_migrations.name`
set against the normalized `_schema_migrations.name` set:

```sql
SELECT name FROM d1_migrations
EXCEPT
SELECT CASE WHEN name LIKE '%.sql' THEN name ELSE name || '.sql' END FROM _schema_migrations;
```

```sql
SELECT CASE WHEN name LIKE '%.sql' THEN name ELSE name || '.sql' END FROM _schema_migrations
EXCEPT
SELECT name FROM d1_migrations;
```

Then confirm the pending set is empty for the current repo state:

```bash
npx wrangler d1 migrations list cycloid-control-plane-production --remote
npx wrangler d1 migrations list cycloid-control-plane-qa --remote --env qa
```

Because the unblock PR already recorded everything via the old runner, the expected pending set is
**empty**, not "only 0197". Any unexpected pending entry means a backfilled name did not match its
on-disk filename - investigate and fix the name before flipping the engine.

## Rollback

Before the engine-swap PR runs any native apply, this is fully reversible: `d1_migrations` is unread
by deploys until that PR, so dropping the backfilled rows restores the prior state. After native
apply has recorded new rows in `d1_migrations`, do **not** drop the table (the old runner would
replay already-applied migrations); roll forward instead. See
[rollback-runbook.md](rollback-runbook.md#d1-database).
