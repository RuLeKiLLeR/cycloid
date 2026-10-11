import { d1Changed } from "../db/errors";
import type { SandboxLayerSourceRow } from "./layer-db";
import type { SandboxLayerActiveArtifactDetailsRow } from "./layer-db";

export interface SandboxLayerBusinessDefaultSourceRow {
  business_id: string;
  source_id: string;
  created_by_user_id: number;
  updated_by_user_id: number;
  created_at: number;
  updated_at: number;
}

export interface SandboxLayerRepoSourceAssignmentRow {
  business_id: string;
  target_repo_owner: string;
  target_repo_name: string;
  source_id: string;
  created_by_user_id: number;
  updated_by_user_id: number;
  created_at: number;
  updated_at: number;
}

export type SandboxLayerAssignmentSourceRow = SandboxLayerSourceRow & {
  active_artifact_count: number;
  latest_active_build_id: string | null;
  latest_active_artifact_ref: string | null;
};

export type SandboxLayerBusinessDefaultSourceDetailsRow = SandboxLayerBusinessDefaultSourceRow &
  Pick<SandboxLayerSourceRow, "repo_owner" | "repo_name" | "manifest_path" | "status"> & {
    latest_active_build_id: string | null;
    latest_active_artifact_ref: string | null;
  };

export type SandboxLayerRepoSourceAssignmentDetailsRow = SandboxLayerRepoSourceAssignmentRow &
  Pick<SandboxLayerSourceRow, "repo_owner" | "repo_name" | "manifest_path" | "status"> & {
    latest_active_build_id: string | null;
    latest_active_artifact_ref: string | null;
  };

export type SandboxLayerAssignedSourceRow = SandboxLayerSourceRow & {
  assignment_updated_at: number;
};

export async function upsertSandboxLayerBusinessDefaultSource(
  db: D1Database,
  input: { businessId: string; sourceId: string; userId: number; nowMs: number },
): Promise<SandboxLayerBusinessDefaultSourceRow> {
  await db
    .prepare(
      `INSERT INTO sandbox_layer_business_default_sources (
         business_id, source_id, created_by_user_id, updated_by_user_id, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (business_id) DO UPDATE SET
         source_id = excluded.source_id,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
    )
    .bind(input.businessId, input.sourceId, input.userId, input.userId, input.nowMs, input.nowMs)
    .run();
  const row = await getSandboxLayerBusinessDefaultSource(db, input.businessId);
  if (!row) throw new Error("sandbox layer business default upsert did not return a row");
  return row;
}

export async function deleteSandboxLayerBusinessDefaultSource(db: D1Database, businessId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM sandbox_layer_business_default_sources WHERE business_id = ?")
    .bind(businessId)
    .run();
  return d1Changed(result);
}

export async function getSandboxLayerBusinessDefaultSource(
  db: D1Database,
  businessId: string,
): Promise<SandboxLayerBusinessDefaultSourceRow | null> {
  return db
    .prepare("SELECT * FROM sandbox_layer_business_default_sources WHERE business_id = ? LIMIT 1")
    .bind(businessId)
    .first<SandboxLayerBusinessDefaultSourceRow>();
}

export async function upsertSandboxLayerRepoSourceAssignment(
  db: D1Database,
  input: {
    businessId: string;
    targetRepoOwner: string;
    targetRepoName: string;
    sourceId: string;
    userId: number;
    nowMs: number;
  },
): Promise<SandboxLayerRepoSourceAssignmentRow> {
  const owner = normalizeRepoSegment(input.targetRepoOwner);
  const repo = normalizeRepoSegment(input.targetRepoName);
  await db
    .prepare(
      `INSERT INTO sandbox_layer_repo_source_assignments (
         business_id, target_repo_owner, target_repo_name, source_id,
         created_by_user_id, updated_by_user_id, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (business_id, target_repo_owner, target_repo_name) DO UPDATE SET
         source_id = excluded.source_id,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
    )
    .bind(input.businessId, owner, repo, input.sourceId, input.userId, input.userId, input.nowMs, input.nowMs)
    .run();
  const row = await getSandboxLayerRepoSourceAssignment(db, {
    businessId: input.businessId,
    targetRepoOwner: owner,
    targetRepoName: repo,
  });
  if (!row) throw new Error("sandbox layer repo assignment upsert did not return a row");
  return row;
}

export async function deleteSandboxLayerRepoSourceAssignment(
  db: D1Database,
  input: { businessId: string; targetRepoOwner: string; targetRepoName: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM sandbox_layer_repo_source_assignments
       WHERE business_id = ? AND target_repo_owner = ? AND target_repo_name = ?`,
    )
    .bind(input.businessId, normalizeRepoSegment(input.targetRepoOwner), normalizeRepoSegment(input.targetRepoName))
    .run();
  return d1Changed(result);
}

export async function getSandboxLayerRepoSourceAssignment(
  db: D1Database,
  input: { businessId: string; targetRepoOwner: string; targetRepoName: string },
): Promise<SandboxLayerRepoSourceAssignmentRow | null> {
  return db
    .prepare(
      `SELECT *
       FROM sandbox_layer_repo_source_assignments
       WHERE business_id = ? AND target_repo_owner = ? AND target_repo_name = ?
       LIMIT 1`,
    )
    .bind(input.businessId, normalizeRepoSegment(input.targetRepoOwner), normalizeRepoSegment(input.targetRepoName))
    .first<SandboxLayerRepoSourceAssignmentRow>();
}

export async function listSandboxLayerRepoSourceAssignments(
  db: D1Database,
  businessId: string,
): Promise<SandboxLayerRepoSourceAssignmentDetailsRow[]> {
  const result = await db
    .prepare(
      `SELECT a.*, s.repo_owner, s.repo_name, s.manifest_path, s.status,
              latest.build_id AS latest_active_build_id,
              latest.provider_artifact_ref AS latest_active_artifact_ref
       FROM sandbox_layer_repo_source_assignments a
       INNER JOIN sandbox_layer_sources s ON s.id = a.source_id
       LEFT JOIN (
         SELECT active.source_id, active.build_id, artifact.provider_artifact_ref,
                ROW_NUMBER() OVER (PARTITION BY active.source_id ORDER BY active.updated_at DESC) AS rn
         FROM sandbox_layer_active_artifacts active
         INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
         WHERE artifact.status = 'active'
       ) latest ON latest.source_id = a.source_id AND latest.rn = 1
       WHERE a.business_id = ?
       ORDER BY a.target_repo_owner ASC, a.target_repo_name ASC`,
    )
    .bind(businessId)
    .all<SandboxLayerRepoSourceAssignmentDetailsRow>();
  return result.results ?? [];
}

export async function getSandboxLayerBusinessDefaultSourceDetails(
  db: D1Database,
  businessId: string,
): Promise<SandboxLayerBusinessDefaultSourceDetailsRow | null> {
  return db
    .prepare(
      `SELECT d.*, s.repo_owner, s.repo_name, s.manifest_path, s.status,
              latest.build_id AS latest_active_build_id,
              latest.provider_artifact_ref AS latest_active_artifact_ref
       FROM sandbox_layer_business_default_sources d
       INNER JOIN sandbox_layer_sources s ON s.id = d.source_id
       LEFT JOIN (
         SELECT active.source_id, active.build_id, artifact.provider_artifact_ref,
                ROW_NUMBER() OVER (PARTITION BY active.source_id ORDER BY active.updated_at DESC) AS rn
         FROM sandbox_layer_active_artifacts active
         INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
         WHERE artifact.status = 'active'
       ) latest ON latest.source_id = d.source_id AND latest.rn = 1
       WHERE d.business_id = ?
       LIMIT 1`,
    )
    .bind(businessId)
    .first<SandboxLayerBusinessDefaultSourceDetailsRow>();
}

export async function getAssignableSandboxLayerSourceByRepoPath(
  db: D1Database,
  input: { businessId: string; repoOwner: string; repoName: string; manifestPath: string },
): Promise<SandboxLayerAssignmentSourceRow | null> {
  return db
    .prepare(
      `SELECT s.*,
              COUNT(active_artifact.id) AS active_artifact_count,
              latest.build_id AS latest_active_build_id,
              latest.provider_artifact_ref AS latest_active_artifact_ref
       FROM sandbox_layer_sources s
       LEFT JOIN sandbox_layer_active_artifacts active ON active.source_id = s.id
       LEFT JOIN sandbox_layer_artifacts active_artifact
         ON active_artifact.id = active.artifact_id AND active_artifact.status = 'active'
       LEFT JOIN (
         SELECT active.source_id, active.build_id, artifact.provider_artifact_ref,
                ROW_NUMBER() OVER (PARTITION BY active.source_id ORDER BY active.updated_at DESC) AS rn
         FROM sandbox_layer_active_artifacts active
         INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
         WHERE artifact.status = 'active'
       ) latest ON latest.source_id = s.id AND latest.rn = 1
       WHERE s.business_id = ?
         AND lower(s.repo_owner) = ?
         AND lower(s.repo_name) = ?
         AND s.manifest_path = ?
       GROUP BY s.id`,
    )
    .bind(
      input.businessId,
      normalizeRepoSegment(input.repoOwner),
      normalizeRepoSegment(input.repoName),
      input.manifestPath,
    )
    .first<SandboxLayerAssignmentSourceRow>();
}

export async function hasSandboxLayerSourceInAnotherBusiness(
  db: D1Database,
  input: { businessId: string; repoOwner: string; repoName: string; manifestPath: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
       FROM sandbox_layer_sources
       WHERE business_id != ?
         AND lower(repo_owner) = ?
         AND lower(repo_name) = ?
         AND manifest_path = ?
       LIMIT 1`,
    )
    .bind(
      input.businessId,
      normalizeRepoSegment(input.repoOwner),
      normalizeRepoSegment(input.repoName),
      input.manifestPath,
    )
    .first<{ id: string }>();
  return Boolean(row);
}

export async function getSandboxLayerRepoAssignmentSource(
  db: D1Database,
  input: { businessId: string; targetRepoOwner: string; targetRepoName: string },
): Promise<SandboxLayerAssignedSourceRow | null> {
  return db
    .prepare(
      `SELECT s.*, a.updated_at AS assignment_updated_at
       FROM sandbox_layer_repo_source_assignments a
       INNER JOIN sandbox_layer_sources s ON s.id = a.source_id
       WHERE a.business_id = ?
         AND a.target_repo_owner = ?
         AND a.target_repo_name = ?
         AND s.business_id = a.business_id
       LIMIT 1`,
    )
    .bind(input.businessId, normalizeRepoSegment(input.targetRepoOwner), normalizeRepoSegment(input.targetRepoName))
    .first<SandboxLayerAssignedSourceRow>();
}

export async function getSandboxLayerBusinessDefaultSourceForResolution(
  db: D1Database,
  businessId: string,
): Promise<SandboxLayerAssignedSourceRow | null> {
  return db
    .prepare(
      `SELECT s.*, d.updated_at AS assignment_updated_at
       FROM sandbox_layer_business_default_sources d
       INNER JOIN sandbox_layer_sources s ON s.id = d.source_id
       WHERE d.business_id = ?
         AND s.business_id = d.business_id
       LIMIT 1`,
    )
    .bind(businessId)
    .first<SandboxLayerAssignedSourceRow>();
}

export async function getActiveSandboxLayerArtifactForSourceProfile(
  db: D1Database,
  input: { businessId: string; sourceId: string; resourceProfileKey: string },
): Promise<SandboxLayerActiveArtifactDetailsRow | null> {
  return db
    .prepare(
      `SELECT artifact.*, active.artifact_id, active.build_id AS active_build_id, active.updated_at AS active_updated_at,
              source.repo_owner, source.repo_name, source.manifest_path, source.status AS source_status
       FROM sandbox_layer_sources source
       INNER JOIN sandbox_layer_active_artifacts active ON active.source_id = source.id
       INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
       WHERE source.business_id = ?
         AND source.id = ?
         AND active.resource_profile_key = ?
         AND source.status = 'active'
         AND artifact.status = 'active'
         AND artifact.provider = 'e2b'
         AND artifact.runtime_backend = 'e2b_cloud'
       LIMIT 1`,
    )
    .bind(input.businessId, input.sourceId, input.resourceProfileKey)
    .first<SandboxLayerActiveArtifactDetailsRow>();
}

export async function hasSandboxLayerActiveArtifactForSource(
  db: D1Database,
  input: { businessId: string; sourceId: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT active.artifact_id
       FROM sandbox_layer_sources source
       INNER JOIN sandbox_layer_active_artifacts active ON active.source_id = source.id
       INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
       WHERE source.business_id = ?
         AND source.id = ?
         AND source.status = 'active'
         AND artifact.status = 'active'
       LIMIT 1`,
    )
    .bind(input.businessId, input.sourceId)
    .first<{ artifact_id: string }>();
  return Boolean(row);
}

export async function hasSandboxLayerActiveArtifactForSourceProfile(
  db: D1Database,
  input: { businessId: string; sourceId: string; resourceProfileKey: string },
): Promise<boolean> {
  const row = await getActiveSandboxLayerArtifactForSourceProfile(db, input);
  return Boolean(row);
}

function normalizeRepoSegment(value: string): string {
  return value.trim().toLowerCase();
}
