import { getAppliedMigrationNames } from "../db/migrations-db";
import type { Env } from "../types";

export type SchemaVersion = {
  appliedNames: string[];
};

/**
 * Applied-schema snapshot for post-deploy verification: the deploy workflow
 * compares these names against the repo's `migrations/*.sql` set (the side
 * that knows the expectation), so nothing build-time-embedded can drift.
 * Automation-auth only — applied migration names are deploy metadata and must
 * not leak through the public health route (docs/security.md).
 */
export async function getSchemaVersion(env: Env): Promise<SchemaVersion> {
  const appliedNames = await getAppliedMigrationNames(env.DB);
  return { appliedNames };
}
