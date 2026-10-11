import type { Logger } from "../logger";
import { writeOffboardingArchiveObject } from "../services/archive";
import type { Env } from "../types";
import { type OffboardingJob, readBusinessOffboardingRows } from "./db";

export type OffboardingExportManifest = {
  version: 1;
  businessId: string;
  jobId: string;
  archiveKey: string;
  tableCounts: Record<string, number>;
  tableKeys: Record<string, string>;
  sessionArtifactKeys: string[];
  exportedAt: number;
};

export async function exportBusinessOffboardingRows(
  env: Env,
  db: D1Database,
  job: OffboardingJob,
  sessionArtifactKeys: string[],
  log: Logger,
  now = Date.now(),
): Promise<OffboardingExportManifest> {
  const tableExports = await readBusinessOffboardingRows(db, job);
  const tableCounts: Record<string, number> = {};
  const tableKeys: Record<string, string> = {};

  for (const tableExport of tableExports) {
    const key = `${job.archiveKey}/${tableExport.table}.ndjson`;
    const body = new TextEncoder().encode(tableExport.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const ok = await writeOffboardingArchiveObject(env, key, body, "application/x-ndjson", log);
    if (!ok) throw new Error(`Failed to write offboarding table export: ${tableExport.table}`);
    tableCounts[tableExport.table] = tableExport.rows.length;
    tableKeys[tableExport.table] = key;
  }

  const manifest: OffboardingExportManifest = {
    version: 1,
    businessId: job.businessId,
    jobId: job.jobId,
    archiveKey: job.archiveKey,
    tableCounts,
    tableKeys,
    sessionArtifactKeys,
    exportedAt: now,
  };
  const manifestOk = await writeOffboardingArchiveObject(
    env,
    `${job.archiveKey}/manifest.json`,
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "application/json",
    log,
  );
  if (!manifestOk) throw new Error("Failed to write offboarding export manifest");
  return manifest;
}
