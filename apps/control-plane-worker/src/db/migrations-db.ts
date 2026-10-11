/**
 * Applied-migration names from `d1_migrations`, wrangler's native bookkeeping
 * table that `wrangler d1 migrations apply` writes during deploys. Each name is
 * the migration's path relative to `migrations_dir` (the `.sql`-suffixed
 * filename). Sorted by name. Throws when the table is missing or unreadable —
 * callers must fail closed (an unverifiable schema is not a healthy schema).
 */
export async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
  const result = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
  return result.results.map((row) => row.name);
}
