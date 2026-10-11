import { d1Changed } from "../db/errors";
import type { RuntimeBackend } from "./runtime-backend";

export type SandboxLayerSourceStatus = "active" | "blocked";
export type SandboxLayerBuildStatus =
  | "validated"
  | "queued"
  | "validating"
  | "building_provider"
  | "polling_provider"
  | "smoke_testing"
  | "completed"
  | "failed"
  | "canceled";
export type SandboxLayerProvider = "e2b";
export type SandboxLayerArtifactStatus = "candidate" | "active" | "blocked" | "superseded";
export type SandboxLayerBuildReason = "manual" | "base_update" | "source_update";

export interface SandboxLayerSourceRow {
  id: string;
  business_id: string;
  repo_owner: string;
  repo_name: string;
  manifest_path: string;
  status: SandboxLayerSourceStatus;
  created_by_user_id: number;
  created_at: number;
  updated_at: number;
}

export interface SandboxLayerBuildRow {
  id: string;
  source_id: string;
  commit_sha: string;
  source_content_hash: string;
  manifest_hash: string;
  layer_hash: string;
  normalized_layer_hash: string;
  manifest_path: string;
  layer_path: string;
  layer_instructions_json: string;
  smoke_commands_json: string;
  base_template_ref: string;
  base_version: string;
  resource_profile_key: string;
  compiler_version: string;
  provider: SandboxLayerProvider;
  runtime_backend: RuntimeBackend;
  provider_template_ref: string | null;
  provider_template_id: string | null;
  provider_build_id: string | null;
  provider_artifact_ref: string | null;
  provider_logs_json: string | null;
  provider_logs_offset: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_heartbeat_at: number | null;
  smoke_sandbox_id: string | null;
  requested_ref: string | null;
  promotion_eligibility: "default_branch_head" | "non_default_ref" | "unknown" | null;
  status: SandboxLayerBuildStatus;
  will_promote: number;
  error: string | null;
  build_log_artifact_id: string | null;
  smoke_result_json: string | null;
  created_by_user_id: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  next_attempt_at: number | null;
  attempts: number;
  rebuild_campaign_id: string | null;
  build_reason: SandboxLayerBuildReason | null;
}

export type SandboxLayerBuildDetailsRow = SandboxLayerBuildRow &
  Pick<SandboxLayerSourceRow, "business_id" | "repo_owner" | "repo_name" | "manifest_path">;
export type SandboxLayerBuildSummaryRow = SandboxLayerBuildDetailsRow;
export type SandboxLayerBuildCreatorFields = {
  created_by_login: string | null;
  created_by_name: string | null;
};
export type SandboxLayerBuildDetailsWithCreatorRow = SandboxLayerBuildDetailsRow & SandboxLayerBuildCreatorFields;
export type SandboxLayerBuildSummaryWithCreatorRow = SandboxLayerBuildSummaryRow & SandboxLayerBuildCreatorFields;

export interface SandboxLayerArtifactRow {
  id: string;
  source_id: string;
  build_id: string;
  commit_sha: string;
  source_content_hash: string;
  base_template_ref: string;
  base_version: string;
  provider: SandboxLayerProvider;
  provider_artifact_ref: string;
  runtime_backend: RuntimeBackend;
  resource_profile_key: string;
  status: SandboxLayerArtifactStatus;
  created_at: number;
  blocked_at: number | null;
}

export type SandboxLayerActiveArtifactDetailsRow = SandboxLayerArtifactRow & {
  repo_owner: string;
  repo_name: string;
  manifest_path: string;
  source_status?: SandboxLayerSourceStatus;
  artifact_id: string;
  active_build_id: string;
  active_updated_at: number;
};

export type ActiveSandboxLayerArtifactRow = SandboxLayerActiveArtifactDetailsRow;
export type SandboxLayerActiveArtifactRebuildCandidateRow = SandboxLayerActiveArtifactDetailsRow & {
  business_id: string;
  source_id: string;
  source_repo_owner: string;
  source_repo_name: string;
};

type SandboxLayerRebuildCandidateForItemRow = SandboxLayerActiveArtifactRebuildCandidateRow & {
  campaign_item_id: string;
};

export type SandboxLayerRebuildCampaignItemStatus =
  | "planned"
  | "skipped_current"
  | "skipped_unversioned_base"
  | "skipped_missing_installation"
  | "skipped_source_unavailable"
  | "queued"
  | "building"
  | "promoted"
  | "failed"
  | "skipped_active_changed";

export type SandboxLayerRebuildCampaignStatus =
  "planned" | "queued" | "running" | "completed" | "completed_with_failures" | "failed";

export interface SandboxLayerRebuildCampaignRow {
  id: string;
  scope: string;
  business_id: string | null;
  reason: string;
  status: SandboxLayerRebuildCampaignStatus;
  created_by_user_id: number;
  created_at: number;
  completed_at: number | null;
  summary_json: string | null;
  scan_cursor_updated_at: number | null;
  scan_cursor_artifact_id: string | null;
  scan_completed_at: number | null;
}

export interface SandboxLayerRebuildCampaignItemRow {
  id: string;
  campaign_id: string;
  source_id: string;
  resource_profile_key: string;
  previous_artifact_id: string;
  previous_build_id: string;
  previous_base_template_ref: string;
  previous_base_version: string;
  target_base_template_ref: string;
  target_base_version: string;
  build_id: string | null;
  status: SandboxLayerRebuildCampaignItemStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  repo_owner?: string;
  repo_name?: string;
}

export interface SandboxLayerBuildLogChunkRow {
  id: string;
  build_id: string;
  sequence: number;
  message: string;
  created_at: number;
}

export interface UpsertSandboxLayerSourceInput {
  id: string;
  businessId: string;
  repoOwner: string;
  repoName: string;
  manifestPath: string;
  createdByUserId: number;
  nowMs: number;
  initialStatus?: Extract<SandboxLayerBuildStatus, "validated" | "queued">;
  requestedRef?: string | null;
  promotionEligibility?: "default_branch_head" | "non_default_ref" | "unknown" | null;
}

export async function upsertSandboxLayerSource(
  db: D1Database,
  input: UpsertSandboxLayerSourceInput,
): Promise<SandboxLayerSourceRow> {
  await db
    .prepare(
      `INSERT INTO sandbox_layer_sources (
         id, business_id, repo_owner, repo_name, manifest_path, status, created_by_user_id, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (business_id, repo_owner, repo_name, manifest_path) DO UPDATE SET
         status = 'active',
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.businessId,
      input.repoOwner,
      input.repoName,
      input.manifestPath,
      input.createdByUserId,
      input.nowMs,
      input.nowMs,
    )
    .run();
  const row = await getSandboxLayerSourceByRepoPath(db, input);
  if (!row) throw new Error("sandbox layer source upsert did not return a row");
  return row;
}

export async function getSandboxLayerSourceByRepoPath(
  db: D1Database,
  input: { businessId: string; repoOwner: string; repoName: string; manifestPath: string },
): Promise<SandboxLayerSourceRow | null> {
  return db
    .prepare(
      `SELECT *
       FROM sandbox_layer_sources
       WHERE business_id = ? AND LOWER(repo_owner) = LOWER(?) AND LOWER(repo_name) = LOWER(?) AND manifest_path = ?
       LIMIT 1`,
    )
    .bind(input.businessId, input.repoOwner, input.repoName, input.manifestPath)
    .first<SandboxLayerSourceRow>();
}

export interface CreateOrGetSandboxLayerBuildInput {
  id: string;
  sourceId: string;
  commitSha: string;
  sourceContentHash: string;
  manifestHash: string;
  layerHash: string;
  normalizedLayerHash?: string | null;
  manifestPath?: string | null;
  layerPath?: string | null;
  layerInstructionsJson?: string | null;
  smokeCommandsJson?: string | null;
  baseTemplateRef: string;
  baseVersion: string;
  resourceProfileKey: string;
  compilerVersion: string;
  provider: SandboxLayerProvider;
  runtimeBackend?: RuntimeBackend;
  willPromote?: number;
  createdByUserId: number;
  nowMs: number;
  initialStatus?: Extract<SandboxLayerBuildStatus, "validated" | "queued">;
  requestedRef?: string | null;
  promotionEligibility?: "default_branch_head" | "non_default_ref" | "unknown" | null;
  rebuildCampaignId?: string | null;
  buildReason?: SandboxLayerBuildReason | null;
}

export async function createOrGetSandboxLayerBuild(
  db: D1Database,
  input: CreateOrGetSandboxLayerBuildInput,
): Promise<{ row: SandboxLayerBuildRow; created: boolean }> {
  const existing = await getSandboxLayerBuildByKey(db, {
    sourceId: input.sourceId,
    sourceContentHash: input.sourceContentHash,
    baseTemplateRef: input.baseTemplateRef,
    baseVersion: input.baseVersion,
    resourceProfileKey: input.resourceProfileKey,
    compilerVersion: input.compilerVersion,
    provider: input.provider,
  });
  if (existing) {
    if (existing.status === "failed" || existing.status === "canceled") {
      await db.batch([
        db
          .prepare(
            `UPDATE sandbox_layer_builds
           SET commit_sha = ?,
               manifest_hash = ?,
               layer_hash = ?,
               normalized_layer_hash = ?,
               manifest_path = ?,
               layer_path = ?,
               layer_instructions_json = ?,
               smoke_commands_json = ?,
               runtime_backend = ?,
               requested_ref = ?,
               promotion_eligibility = ?,
               status = ?,
               will_promote = ?,
               provider_template_ref = NULL,
               provider_template_id = NULL,
               provider_build_id = NULL,
               provider_artifact_ref = NULL,
               provider_logs_json = NULL,
               provider_logs_offset = 0,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               smoke_sandbox_id = NULL,
               error = NULL,
               smoke_result_json = NULL,
               started_at = NULL,
               completed_at = NULL,
               next_attempt_at = NULL,
               attempts = 0,
               created_by_user_id = ?,
               created_at = ?,
               rebuild_campaign_id = ?,
               build_reason = ?
           WHERE id = ?`,
          )
          .bind(
            input.commitSha,
            input.manifestHash,
            input.layerHash,
            input.normalizedLayerHash ?? "",
            input.manifestPath ?? "",
            input.layerPath ?? "",
            input.layerInstructionsJson ?? "[]",
            input.smokeCommandsJson ?? "[]",
            input.runtimeBackend ?? "e2b_cloud",
            input.requestedRef ?? null,
            input.promotionEligibility ?? null,
            input.initialStatus ?? "validated",
            input.willPromote ?? 0,
            input.createdByUserId,
            input.nowMs,
            input.rebuildCampaignId ?? existing.rebuild_campaign_id ?? null,
            input.buildReason ?? existing.build_reason ?? "manual",
            existing.id,
          ),
        db.prepare("DELETE FROM sandbox_layer_build_log_chunks WHERE build_id = ?").bind(existing.id),
      ]);
      return { row: (await getSandboxLayerBuild(db, existing.id)) ?? existing, created: false };
    }
    if (
      input.promotionEligibility === "default_branch_head" &&
      existing.promotion_eligibility !== "default_branch_head"
    ) {
      await db
        .prepare(
          `UPDATE sandbox_layer_builds
           SET commit_sha = ?,
               requested_ref = COALESCE(?, requested_ref),
               promotion_eligibility = 'default_branch_head',
               will_promote = 1,
               rebuild_campaign_id = COALESCE(rebuild_campaign_id, ?),
               build_reason = COALESCE(build_reason, ?)
           WHERE id = ?`,
        )
        .bind(
          input.commitSha,
          input.requestedRef ?? null,
          input.rebuildCampaignId ?? null,
          input.buildReason ?? null,
          existing.id,
        )
        .run();
      return { row: (await getSandboxLayerBuild(db, existing.id)) ?? existing, created: false };
    }
    if (input.rebuildCampaignId || input.buildReason) {
      await db
        .prepare(
          `UPDATE sandbox_layer_builds
           SET rebuild_campaign_id = COALESCE(rebuild_campaign_id, ?),
               build_reason = COALESCE(build_reason, ?)
           WHERE id = ?`,
        )
        .bind(input.rebuildCampaignId ?? null, input.buildReason ?? null, existing.id)
        .run();
      return { row: (await getSandboxLayerBuild(db, existing.id)) ?? existing, created: false };
    }
    return { row: existing, created: false };
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO sandbox_layer_builds (
         id, source_id, commit_sha, source_content_hash, manifest_hash, layer_hash, normalized_layer_hash,
         manifest_path, layer_path, layer_instructions_json, smoke_commands_json,
         base_template_ref, base_version, resource_profile_key, compiler_version, provider, runtime_backend,
         requested_ref, promotion_eligibility, status, will_promote, created_by_user_id, created_at, attempts,
         rebuild_campaign_id, build_reason
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.commitSha,
      input.sourceContentHash,
      input.manifestHash,
      input.layerHash,
      input.normalizedLayerHash ?? "",
      input.manifestPath ?? "",
      input.layerPath ?? "",
      input.layerInstructionsJson ?? "[]",
      input.smokeCommandsJson ?? "[]",
      input.baseTemplateRef,
      input.baseVersion,
      input.resourceProfileKey,
      input.compilerVersion,
      input.provider,
      input.runtimeBackend ?? "e2b_cloud",
      input.requestedRef ?? null,
      input.promotionEligibility ?? null,
      input.initialStatus ?? "queued",
      input.willPromote ?? 0,
      input.createdByUserId,
      input.nowMs,
      input.rebuildCampaignId ?? null,
      input.buildReason ?? "manual",
    )
    .run();

  const row = await getSandboxLayerBuildByKey(db, {
    sourceId: input.sourceId,
    sourceContentHash: input.sourceContentHash,
    baseTemplateRef: input.baseTemplateRef,
    baseVersion: input.baseVersion,
    resourceProfileKey: input.resourceProfileKey,
    compilerVersion: input.compilerVersion,
    provider: input.provider,
  });
  if (!row) throw new Error("sandbox layer build insert did not return a row");
  return { row, created: row.id === input.id };
}

export async function getSandboxLayerBuildByKey(
  db: D1Database,
  input: {
    sourceId: string;
    sourceContentHash: string;
    baseTemplateRef: string;
    baseVersion: string;
    resourceProfileKey: string;
    compilerVersion: string;
    provider: SandboxLayerProvider;
  },
): Promise<SandboxLayerBuildRow | null> {
  return db
    .prepare(
      `SELECT *
       FROM sandbox_layer_builds
       WHERE source_id = ?
         AND source_content_hash = ?
         AND base_template_ref = ?
         AND base_version = ?
         AND resource_profile_key = ?
         AND compiler_version = ?
         AND provider = ?
       LIMIT 1`,
    )
    .bind(
      input.sourceId,
      input.sourceContentHash,
      input.baseTemplateRef,
      input.baseVersion,
      input.resourceProfileKey,
      input.compilerVersion,
      input.provider,
    )
    .first<SandboxLayerBuildRow>();
}

export async function getSandboxLayerBuild(
  db: D1Database,
  buildId: string,
): Promise<SandboxLayerBuildDetailsRow | null> {
  return getSandboxLayerBuildWithSource(db, buildId);
}

export async function getSandboxLayerBuildWithSource(
  db: D1Database,
  buildId: string,
): Promise<SandboxLayerBuildDetailsRow | null> {
  return db
    .prepare(
      `SELECT b.*, s.business_id, s.repo_owner, s.repo_name, s.manifest_path
       FROM sandbox_layer_builds b
       INNER JOIN sandbox_layer_sources s ON s.id = b.source_id
       WHERE b.id = ?
       LIMIT 1`,
    )
    .bind(buildId)
    .first<SandboxLayerBuildDetailsRow>();
}

export async function getSandboxLayerBuildWithSourceAndCreator(
  db: D1Database,
  buildId: string,
): Promise<SandboxLayerBuildDetailsWithCreatorRow | null> {
  return db
    .prepare(
      `SELECT b.*, s.business_id, s.repo_owner, s.repo_name, s.manifest_path,
              u.login AS created_by_login, u.name AS created_by_name
       FROM sandbox_layer_builds b
       INNER JOIN sandbox_layer_sources s ON s.id = b.source_id
       LEFT JOIN users u ON u.id = b.created_by_user_id
       WHERE b.id = ?
       LIMIT 1`,
    )
    .bind(buildId)
    .first<SandboxLayerBuildDetailsWithCreatorRow>();
}

export async function claimSandboxLayerBuild(
  db: D1Database,
  input: {
    buildId: string;
    fromStatus: Extract<SandboxLayerBuildStatus, "queued" | "polling_provider">;
    toStatus: Extract<SandboxLayerBuildStatus, "validating" | "smoke_testing">;
    nowMs: number;
  },
): Promise<boolean> {
  const validPair =
    (input.fromStatus === "queued" && input.toStatus === "validating") ||
    (input.fromStatus === "polling_provider" && input.toStatus === "smoke_testing");
  if (!validPair) return false;
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = ?, started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status = ?`,
    )
    .bind(input.toStatus, input.nowMs, input.buildId, input.fromStatus)
    .run();
  return d1Changed(result);
}

export async function markSandboxLayerBuildQueued(
  db: D1Database,
  input: { buildId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'queued',
           next_attempt_at = NULL
       WHERE id = ? AND status = 'validated'`,
    )
    .bind(input.buildId)
    .run();
  return d1Changed(result);
}

export async function claimSandboxLayerProviderBuild(
  db: D1Database,
  input: { buildId: string; nowMs: number; leaseOwner?: string; leaseDurationMs?: number },
): Promise<boolean> {
  const leaseOwner = input.leaseOwner ?? crypto.randomUUID();
  const leaseExpiresAt = input.nowMs + (input.leaseDurationMs ?? 120_000);
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'building_provider',
           started_at = COALESCE(started_at, ?),
           lease_owner = ?,
           lease_expires_at = ?,
           last_heartbeat_at = ?
       WHERE id = ?
         AND status = 'queued'
         AND provider_build_id IS NULL`,
    )
    .bind(input.nowMs, leaseOwner, leaseExpiresAt, input.nowMs, input.buildId)
    .run();
  return d1Changed(result);
}

export async function recordSandboxLayerProviderBuildStart(
  db: D1Database,
  input: { buildId: string; providerTemplateRef: string; providerBuildId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'polling_provider',
           provider_template_ref = ?,
           provider_template_id = ?,
           provider_build_id = ?,
           started_at = COALESCE(started_at, ?),
           last_heartbeat_at = ?
       WHERE id = ?
         AND status IN ('validating', 'building_provider')
         AND provider_template_ref IS NULL
         AND provider_template_id IS NULL
         AND provider_build_id IS NULL`,
    )
    .bind(
      input.providerTemplateRef,
      input.providerTemplateRef,
      input.providerBuildId,
      input.nowMs,
      input.nowMs,
      input.buildId,
    )
    .run();
  if (d1Changed(result)) return true;

  const row = await getSandboxLayerBuild(db, input.buildId);
  return (
    row?.provider_build_id === input.providerBuildId &&
    (row.provider_template_ref ?? row.provider_template_id) === input.providerTemplateRef
  );
}

export async function recordSandboxLayerProviderPoll(
  db: D1Database,
  input: { buildId: string; providerLogsOffset: number; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET provider_logs_offset = ?,
           last_heartbeat_at = ?
       WHERE id = ? AND status = 'polling_provider'`,
    )
    .bind(input.providerLogsOffset, input.nowMs, input.buildId)
    .run();
  return d1Changed(result);
}

export async function recordSandboxLayerSmokeSandbox(
  db: D1Database,
  input: { buildId: string; smokeSandboxId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET smoke_sandbox_id = ?,
           last_heartbeat_at = ?
       WHERE id = ? AND status = 'smoke_testing'`,
    )
    .bind(input.smokeSandboxId, input.nowMs, input.buildId)
    .run();
  return d1Changed(result);
}

export async function rescheduleSandboxLayerBuild(
  db: D1Database,
  input: { buildId: string; nextAttemptAt: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'queued', next_attempt_at = ?, attempts = attempts + 1
       WHERE id = ? AND status IN ('queued', 'validating', 'building_provider', 'polling_provider', 'smoke_testing')`,
    )
    .bind(input.nextAttemptAt, input.buildId)
    .run();
  return d1Changed(result);
}

export async function markSandboxLayerBuildFailed(
  db: D1Database,
  input: { buildId: string; error: string; nowMs: number; smokeResultJson?: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = 'failed', error = ?, smoke_result_json = ?, completed_at = ?
       WHERE id = ? AND status IN ('queued', 'validating', 'building_provider', 'polling_provider', 'smoke_testing')`,
    )
    .bind(input.error.slice(0, 4096), input.smokeResultJson ?? null, input.nowMs, input.buildId)
    .run();
  return d1Changed(result);
}

export async function markSandboxLayerBuildStatus(
  db: D1Database,
  buildId: string,
  status: SandboxLayerBuildStatus,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sandbox_layer_builds
       SET status = ?, started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
    )
    .bind(status, nowMs, buildId)
    .run();
}

export async function createSandboxLayerArtifact(
  db: D1Database,
  input: {
    id: string;
    sourceId: string;
    buildId: string;
    provider: SandboxLayerProvider;
    providerArtifactRef: string;
    runtimeBackend: RuntimeBackend;
    resourceProfileKey: string;
    status?: SandboxLayerArtifactStatus;
    nowMs: number;
  },
): Promise<SandboxLayerArtifactRow> {
  const build = await getSandboxLayerBuild(db, input.buildId);
  if (!build) throw new Error("sandbox layer artifact build does not exist");
  await db
    .prepare(
      `INSERT OR IGNORE INTO sandbox_layer_artifacts (
         id, source_id, build_id, commit_sha, source_content_hash, base_template_ref, base_version,
         provider, provider_artifact_ref, runtime_backend, resource_profile_key, status, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.buildId,
      build.commit_sha,
      build.source_content_hash,
      build.base_template_ref,
      build.base_version,
      input.provider,
      input.providerArtifactRef,
      input.runtimeBackend,
      input.resourceProfileKey,
      input.status ?? "active",
      input.nowMs,
    )
    .run();
  const row =
    (await db
      .prepare("SELECT * FROM sandbox_layer_artifacts WHERE provider = ? AND provider_artifact_ref = ? LIMIT 1")
      .bind(input.provider, input.providerArtifactRef)
      .first<SandboxLayerArtifactRow>()) ?? (await getSandboxLayerArtifactForBuild(db, input.buildId));
  if (!row) throw new Error("sandbox layer artifact insert did not return a row");
  return row;
}

export async function completeSandboxLayerBuild(
  db: D1Database,
  build: SandboxLayerBuildRow,
  providerArtifactRef: string,
  smokeResultJson: string,
  nowMs: number,
): Promise<SandboxLayerArtifactRow> {
  const claimed =
    build.status === "smoke_testing" ||
    (await claimSandboxLayerBuild(db, {
      buildId: build.id,
      fromStatus: "polling_provider",
      toStatus: "smoke_testing",
      nowMs,
    }));
  if (!claimed) {
    const existing = await getSandboxLayerArtifactForBuild(db, build.id);
    if (existing) return existing;
  }
  const shouldPromote = await shouldPromoteCompletedSandboxLayerBuild(db, build);
  // A build id can be rebuilt after its row is reset (recovery of a layer left
  // current-but-stale). sandbox_layer_artifacts has UNIQUE(build_id), so a second
  // completion for the same build id would hard-fail on a fresh INSERT and loop
  // forever in smoke_testing. Reuse the existing artifact row's id and UPSERT so
  // the rebuild re-points that row at the freshly built layer and re-promotes it.
  const priorArtifact = await getSandboxLayerArtifactForBuild(db, build.id);
  const artifactId = priorArtifact?.id ?? crypto.randomUUID();
  const statements = [
    db
      .prepare(
        `/* d1-transactional-hard-fail */
         INSERT INTO sandbox_layer_artifacts (
           id, source_id, build_id, commit_sha, source_content_hash, base_template_ref, base_version,
           provider, provider_artifact_ref, runtime_backend, resource_profile_key, status, created_at
         )
         SELECT ?, source_id, id, commit_sha, source_content_hash, base_template_ref, base_version,
                provider, ?, runtime_backend, resource_profile_key, ?, ?
         FROM sandbox_layer_builds
         WHERE id = ? AND status = 'smoke_testing'
         ON CONFLICT (build_id) DO UPDATE SET
           provider_artifact_ref = excluded.provider_artifact_ref,
           commit_sha = excluded.commit_sha,
           source_content_hash = excluded.source_content_hash,
           base_template_ref = excluded.base_template_ref,
           base_version = excluded.base_version,
           status = excluded.status,
           created_at = excluded.created_at,
           blocked_at = NULL`,
      )
      .bind(artifactId, providerArtifactRef, shouldPromote ? "active" : "candidate", nowMs, build.id),
    db
      .prepare(
        `UPDATE sandbox_layer_builds
         SET status = 'completed',
             smoke_result_json = ?,
             provider_artifact_ref = COALESCE(?, provider_artifact_ref),
             completed_at = ?
         WHERE id = ? AND status = 'smoke_testing'`,
      )
      .bind(smokeResultJson, providerArtifactRef, nowMs, build.id),
  ];
  if (shouldPromote) {
    statements.push(
      db
        .prepare(
          `UPDATE sandbox_layer_artifacts
           SET status = 'superseded'
           WHERE source_id = ?
             AND resource_profile_key = ?
             AND id != ?
             AND status = 'active'`,
        )
        .bind(build.source_id, build.resource_profile_key, artifactId),
      db
        .prepare(
          `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_id, resource_profile_key) DO UPDATE SET
             artifact_id = excluded.artifact_id,
             build_id = excluded.build_id,
             updated_at = excluded.updated_at`,
        )
        .bind(build.source_id, build.resource_profile_key, artifactId, build.id, nowMs),
    );
  }
  const results = await db.batch(statements);
  if (!d1Changed(results[0] as D1Result) || !d1Changed(results[1] as D1Result)) {
    throw new Error("sandbox layer completion did not persist artifact");
  }
  const artifact = await getSandboxLayerArtifactForBuild(db, build.id);
  if (!artifact) throw new Error("sandbox layer artifact insert did not return a row");
  return artifact;
}

async function shouldPromoteCompletedSandboxLayerBuild(db: D1Database, build: SandboxLayerBuildRow): Promise<boolean> {
  if (build.rebuild_campaign_id) return false;
  if (build.promotion_eligibility !== "default_branch_head" || build.will_promote !== 1) return false;
  const newer = await db
    .prepare(
      `SELECT newer.id
       FROM sandbox_layer_builds newer
       INNER JOIN sandbox_layer_artifacts newer_artifact ON newer_artifact.build_id = newer.id
       WHERE newer.source_id = ?
         AND newer.resource_profile_key = ?
         AND newer.provider = ?
         AND newer.status = 'completed'
         AND newer.promotion_eligibility = 'default_branch_head'
         AND newer.will_promote = 1
         AND newer.created_at > ?
       LIMIT 1`,
    )
    .bind(build.source_id, build.resource_profile_key, build.provider, build.created_at)
    .first<{ id: string }>();
  return !newer;
}

export async function getSandboxLayerArtifactForBuild(
  db: D1Database,
  buildId: string,
): Promise<SandboxLayerArtifactRow | null> {
  return db
    .prepare("SELECT * FROM sandbox_layer_artifacts WHERE build_id = ? LIMIT 1")
    .bind(buildId)
    .first<SandboxLayerArtifactRow>();
}

export async function blockActiveSandboxLayerArtifactIfCurrent(
  db: D1Database,
  input: { sourceId: string; resourceProfileKey: string; artifactId: string; reason: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_artifacts
       SET status = 'blocked', blocked_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM sandbox_layer_active_artifacts active
           WHERE active.source_id = ?
             AND active.resource_profile_key = ?
             AND active.artifact_id = sandbox_layer_artifacts.id
         )`,
    )
    .bind(input.nowMs, input.artifactId, input.sourceId, input.resourceProfileKey)
    .run();
  if (!d1Changed(result)) return false;
  await db
    .prepare(
      `DELETE FROM sandbox_layer_active_artifacts
       WHERE source_id = ?
         AND resource_profile_key = ?
         AND artifact_id = ?`,
    )
    .bind(input.sourceId, input.resourceProfileKey, input.artifactId)
    .run();
  return true;
}

export async function getActiveSandboxLayerArtifact(
  db: D1Database,
  input: { sourceId: string; resourceProfileKey: string },
): Promise<SandboxLayerActiveArtifactDetailsRow | null> {
  return db
    .prepare(
      `SELECT a.*, active.artifact_id, active.build_id AS active_build_id, active.updated_at AS active_updated_at,
              s.repo_owner, s.repo_name, s.manifest_path
       FROM sandbox_layer_active_artifacts active
       INNER JOIN sandbox_layer_artifacts a ON a.id = active.artifact_id
       INNER JOIN sandbox_layer_sources s ON s.id = active.source_id
       WHERE active.source_id = ?
         AND active.resource_profile_key = ?
         AND a.status = 'active'
       LIMIT 1`,
    )
    .bind(input.sourceId, input.resourceProfileKey)
    .first<SandboxLayerActiveArtifactDetailsRow>();
}

export async function listActiveSandboxLayerArtifactRebuildCandidates(
  db: D1Database,
  input: {
    businessId?: string | null;
    limit?: number;
    activeUpdatedBeforeOrAt?: number | null;
    cursor?: { updatedAt: number; artifactId: string } | null;
  },
): Promise<SandboxLayerActiveArtifactRebuildCandidateRow[]> {
  const conditions: string[] = ["artifact.status = 'active'", "source.status = 'active'"];
  const params: Array<string | number> = [];
  if (input.businessId) {
    conditions.push("source.business_id = ?");
    params.push(input.businessId);
  }
  if (input.activeUpdatedBeforeOrAt != null) {
    conditions.push("active.updated_at <= ?");
    params.push(input.activeUpdatedBeforeOrAt);
  }
  if (input.cursor) {
    conditions.push("(active.updated_at < ? OR (active.updated_at = ? AND artifact.id < ?))");
    params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.artifactId);
  }
  const limit = clampLimit(input.limit, 500, 1000);
  params.push(limit);
  const result = await db
    .prepare(
      `SELECT artifact.*,
              artifact.id AS artifact_id,
              active.build_id AS active_build_id,
              active.updated_at AS active_updated_at,
              source.business_id AS business_id,
              source.id AS source_id,
              source.repo_owner AS repo_owner,
              source.repo_name AS repo_name,
              source.repo_owner AS source_repo_owner,
              source.repo_name AS source_repo_name,
              source.manifest_path AS manifest_path,
              source.status AS source_status
       FROM sandbox_layer_active_artifacts active
       INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = active.artifact_id
       INNER JOIN sandbox_layer_sources source ON source.id = active.source_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY active.updated_at DESC, artifact.id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<SandboxLayerActiveArtifactRebuildCandidateRow>();
  return result.results ?? [];
}

export async function insertSandboxLayerRebuildCampaign(
  db: D1Database,
  campaign: SandboxLayerRebuildCampaignRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO sandbox_layer_rebuild_campaigns
       (id, scope, business_id, reason, status, created_by_user_id, created_at, completed_at, summary_json,
        scan_cursor_updated_at, scan_cursor_artifact_id, scan_completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      campaign.id,
      campaign.scope,
      campaign.business_id,
      campaign.reason,
      campaign.status,
      campaign.created_by_user_id,
      campaign.created_at,
      campaign.completed_at,
      campaign.summary_json,
      campaign.scan_cursor_updated_at,
      campaign.scan_cursor_artifact_id,
      campaign.scan_completed_at,
    )
    .run();
}

export async function listRunnableSandboxLayerRebuildCampaigns(
  db: D1Database,
  input: { limit?: number },
): Promise<SandboxLayerRebuildCampaignRow[]> {
  const limit = clampLimit(input.limit, 5, 25);
  const result = await db
    .prepare(
      `SELECT *
       FROM sandbox_layer_rebuild_campaigns
       WHERE status IN ('planned', 'queued', 'running')
         AND (
           scan_completed_at IS NULL
           OR EXISTS (
             SELECT 1
             FROM sandbox_layer_rebuild_campaign_items item
             WHERE item.campaign_id = sandbox_layer_rebuild_campaigns.id
               AND item.status = 'planned'
           )
         )
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<SandboxLayerRebuildCampaignRow>();
  return result.results ?? [];
}

export async function getSandboxLayerRebuildCampaignRow(
  db: D1Database,
  campaignId: string,
): Promise<SandboxLayerRebuildCampaignRow | null> {
  return db
    .prepare("SELECT * FROM sandbox_layer_rebuild_campaigns WHERE id = ? LIMIT 1")
    .bind(campaignId)
    .first<SandboxLayerRebuildCampaignRow>();
}

export async function insertSandboxLayerRebuildCampaignItem(
  db: D1Database,
  item: SandboxLayerRebuildCampaignItemRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO sandbox_layer_rebuild_campaign_items
       (id, campaign_id, source_id, resource_profile_key, previous_artifact_id, previous_build_id,
        previous_base_template_ref, previous_base_version, target_base_template_ref, target_base_version,
        build_id, status, error, created_at, updated_at, repo_owner, repo_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.campaign_id,
      item.source_id,
      item.resource_profile_key,
      item.previous_artifact_id,
      item.previous_build_id,
      item.previous_base_template_ref,
      item.previous_base_version,
      item.target_base_template_ref,
      item.target_base_version,
      item.build_id,
      item.status,
      item.error,
      item.created_at,
      item.updated_at,
      item.repo_owner ?? null,
      item.repo_name ?? null,
    )
    .run();
}

const MAX_REBUILD_CAMPAIGN_ITEM_BATCH_STATEMENTS = 50;

const INSERT_SANDBOX_LAYER_REBUILD_CAMPAIGN_ITEM_SQL = `INSERT OR IGNORE INTO sandbox_layer_rebuild_campaign_items
  (id, campaign_id, source_id, resource_profile_key, previous_artifact_id, previous_build_id,
   previous_base_template_ref, previous_base_version, target_base_template_ref, target_base_version,
   build_id, status, error, created_at, updated_at, repo_owner, repo_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function bindSandboxLayerRebuildCampaignItem(
  statement: D1PreparedStatement,
  item: SandboxLayerRebuildCampaignItemRow,
): D1PreparedStatement {
  return statement.bind(
    item.id,
    item.campaign_id,
    item.source_id,
    item.resource_profile_key,
    item.previous_artifact_id,
    item.previous_build_id,
    item.previous_base_template_ref,
    item.previous_base_version,
    item.target_base_template_ref,
    item.target_base_version,
    item.build_id,
    item.status,
    item.error,
    item.created_at,
    item.updated_at,
    item.repo_owner ?? null,
    item.repo_name ?? null,
  );
}

export async function insertSandboxLayerRebuildCampaignItemsBatch(
  db: D1Database,
  items: readonly SandboxLayerRebuildCampaignItemRow[],
): Promise<void> {
  for (let index = 0; index < items.length; index += MAX_REBUILD_CAMPAIGN_ITEM_BATCH_STATEMENTS) {
    const chunk = items.slice(index, index + MAX_REBUILD_CAMPAIGN_ITEM_BATCH_STATEMENTS);
    await db.batch(
      chunk.map((item) =>
        bindSandboxLayerRebuildCampaignItem(db.prepare(INSERT_SANDBOX_LAYER_REBUILD_CAMPAIGN_ITEM_SQL), item),
      ),
    );
  }
}

export async function listSandboxLayerRebuildCampaignItems(
  db: D1Database,
  campaignId: string,
): Promise<SandboxLayerRebuildCampaignItemRow[]> {
  const result = await db
    .prepare(
      `SELECT item.id, item.campaign_id, item.source_id, item.resource_profile_key,
              item.previous_artifact_id, item.previous_build_id,
              item.previous_base_template_ref, item.previous_base_version,
              item.target_base_template_ref, item.target_base_version,
              item.build_id, item.status, item.error, item.created_at, item.updated_at,
              COALESCE(item.repo_owner, source.repo_owner) AS repo_owner,
              COALESCE(item.repo_name, source.repo_name) AS repo_name
       FROM sandbox_layer_rebuild_campaign_items item
       LEFT JOIN sandbox_layer_sources source ON source.id = item.source_id
       WHERE item.campaign_id = ?
       ORDER BY item.created_at ASC`,
    )
    .bind(campaignId)
    .all<SandboxLayerRebuildCampaignItemRow>();
  return result.results ?? [];
}

export async function listSandboxLayerRebuildCampaignItemsForBuild(
  db: D1Database,
  buildId: string,
): Promise<SandboxLayerRebuildCampaignItemRow[]> {
  const result = await db
    .prepare("SELECT * FROM sandbox_layer_rebuild_campaign_items WHERE build_id = ? ORDER BY created_at ASC")
    .bind(buildId)
    .all<SandboxLayerRebuildCampaignItemRow>();
  return result.results ?? [];
}

export async function listPlannedSandboxLayerRebuildCampaignItems(
  db: D1Database,
  campaignId: string,
  input: { limit?: number },
): Promise<SandboxLayerRebuildCampaignItemRow[]> {
  const limit = clampLimit(input.limit, 10, 100);
  const result = await db
    .prepare(
      `SELECT item.id, item.campaign_id, item.source_id, item.resource_profile_key,
              item.previous_artifact_id, item.previous_build_id,
              item.previous_base_template_ref, item.previous_base_version,
              item.target_base_template_ref, item.target_base_version,
              item.build_id, item.status, item.error, item.created_at, item.updated_at,
              COALESCE(item.repo_owner, source.repo_owner) AS repo_owner,
              COALESCE(item.repo_name, source.repo_name) AS repo_name
       FROM sandbox_layer_rebuild_campaign_items item
       LEFT JOIN sandbox_layer_sources source ON source.id = item.source_id
       WHERE item.campaign_id = ?
         AND item.status = 'planned'
       ORDER BY item.created_at ASC
       LIMIT ?`,
    )
    .bind(campaignId, limit)
    .all<SandboxLayerRebuildCampaignItemRow>();
  return result.results ?? [];
}

export async function getSandboxLayerRebuildCandidateForItem(
  db: D1Database,
  itemId: string,
): Promise<SandboxLayerActiveArtifactRebuildCandidateRow | null> {
  return db
    .prepare(
      `SELECT artifact.*,
              artifact.id AS artifact_id,
              item.previous_build_id AS active_build_id,
              active.updated_at AS active_updated_at,
              source.business_id AS business_id,
              source.id AS source_id,
              source.repo_owner AS repo_owner,
              source.repo_name AS repo_name,
              source.repo_owner AS source_repo_owner,
              source.repo_name AS source_repo_name,
              source.manifest_path AS manifest_path,
              source.status AS source_status
       FROM sandbox_layer_rebuild_campaign_items item
       INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = item.previous_artifact_id
       INNER JOIN sandbox_layer_sources source ON source.id = item.source_id
       LEFT JOIN sandbox_layer_active_artifacts active
         ON active.source_id = item.source_id
        AND active.resource_profile_key = item.resource_profile_key
        AND active.artifact_id = item.previous_artifact_id
       WHERE item.id = ?
       LIMIT 1`,
    )
    .bind(itemId)
    .first<SandboxLayerActiveArtifactRebuildCandidateRow>();
}

const MAX_REBUILD_CANDIDATE_ITEM_ID_BINDINGS = 100;

export async function listSandboxLayerRebuildCandidatesForItems(
  db: D1Database,
  itemIds: readonly string[],
): Promise<Map<string, SandboxLayerActiveArtifactRebuildCandidateRow>> {
  const uniqueIds = [...new Set(itemIds)].filter((id) => id.length > 0);
  const candidatesByItemId = new Map<string, SandboxLayerActiveArtifactRebuildCandidateRow>();
  for (let index = 0; index < uniqueIds.length; index += MAX_REBUILD_CANDIDATE_ITEM_ID_BINDINGS) {
    const chunk = uniqueIds.slice(index, index + MAX_REBUILD_CANDIDATE_ITEM_ID_BINDINGS);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT artifact.*,
                artifact.id AS artifact_id,
                item.id AS campaign_item_id,
                item.previous_build_id AS active_build_id,
                active.updated_at AS active_updated_at,
                source.business_id AS business_id,
                source.id AS source_id,
                source.repo_owner AS repo_owner,
                source.repo_name AS repo_name,
                source.repo_owner AS source_repo_owner,
                source.repo_name AS source_repo_name,
                source.manifest_path AS manifest_path,
                source.status AS source_status
         FROM sandbox_layer_rebuild_campaign_items item
         INNER JOIN sandbox_layer_artifacts artifact ON artifact.id = item.previous_artifact_id
         INNER JOIN sandbox_layer_sources source ON source.id = item.source_id
         LEFT JOIN sandbox_layer_active_artifacts active
           ON active.source_id = item.source_id
          AND active.resource_profile_key = item.resource_profile_key
          AND active.artifact_id = item.previous_artifact_id
         WHERE item.id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<SandboxLayerRebuildCandidateForItemRow>();
    for (const row of result.results ?? []) {
      const { campaign_item_id: campaignItemId, ...candidate } = row;
      candidatesByItemId.set(campaignItemId, candidate);
    }
  }
  return candidatesByItemId;
}

export async function updateSandboxLayerRebuildCampaignItem(
  db: D1Database,
  input: {
    itemId: string;
    status: SandboxLayerRebuildCampaignItemStatus;
    buildId?: string | null;
    error?: string | null;
    nowMs: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_rebuild_campaign_items
       SET status = ?,
           build_id = COALESCE(?, build_id),
           error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(input.status, input.buildId ?? null, input.error ?? null, input.nowMs, input.itemId)
    .run();
  return d1Changed(result);
}

export async function updateSandboxLayerRebuildCampaignStatus(
  db: D1Database,
  input: {
    campaignId: string;
    status: SandboxLayerRebuildCampaignStatus;
    summaryJson: string;
    completedAt?: number | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_rebuild_campaigns
       SET status = ?,
           summary_json = ?,
           completed_at = ?
       WHERE id = ?`,
    )
    .bind(input.status, input.summaryJson, input.completedAt ?? null, input.campaignId)
    .run();
  return d1Changed(result);
}

export async function updateSandboxLayerRebuildCampaignScanCursor(
  db: D1Database,
  input: {
    campaignId: string;
    cursorUpdatedAt: number | null;
    cursorArtifactId: string | null;
    completedAt?: number | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sandbox_layer_rebuild_campaigns
       SET scan_cursor_updated_at = ?,
           scan_cursor_artifact_id = ?,
           scan_completed_at = COALESCE(scan_completed_at, ?)
       WHERE id = ?`,
    )
    .bind(input.cursorUpdatedAt, input.cursorArtifactId, input.completedAt ?? null, input.campaignId)
    .run();
  return d1Changed(result);
}

export async function promoteSandboxLayerArtifactForRebuild(
  db: D1Database,
  input: { buildId: string; artifactId: string; previousArtifactId: string; nowMs: number },
): Promise<"promoted" | "skipped_active_changed" | "blocked" | "missing"> {
  const row = await db
    .prepare(
      `SELECT a.*, b.status AS build_status
       FROM sandbox_layer_artifacts a
       INNER JOIN sandbox_layer_builds b ON b.id = a.build_id
       WHERE a.id = ? AND b.id = ?
       LIMIT 1`,
    )
    .bind(input.artifactId, input.buildId)
    .first<SandboxLayerArtifactRow & { build_status: SandboxLayerBuildStatus }>();
  if (!row || row.build_status !== "completed") return "missing";
  if (row.status === "blocked") return "blocked";

  const results = await db.batch([
    db
      .prepare(
        `UPDATE sandbox_layer_active_artifacts
       SET artifact_id = ?, build_id = ?, updated_at = ?
       WHERE source_id = ?
         AND resource_profile_key = ?
         AND artifact_id = ?`,
      )
      .bind(row.id, row.build_id, input.nowMs, row.source_id, row.resource_profile_key, input.previousArtifactId),
    db
      .prepare(
        `UPDATE sandbox_layer_artifacts
       SET status = 'superseded'
       WHERE source_id = ?
         AND resource_profile_key = ?
         AND id != ?
         AND status = 'active'
         AND EXISTS (
           SELECT 1
           FROM sandbox_layer_active_artifacts active
           WHERE active.source_id = sandbox_layer_artifacts.source_id
             AND active.resource_profile_key = sandbox_layer_artifacts.resource_profile_key
             AND active.artifact_id = ?
         )`,
      )
      .bind(row.source_id, row.resource_profile_key, row.id, row.id),
    db
      .prepare(
        `UPDATE sandbox_layer_artifacts
       SET status = 'active', blocked_at = NULL
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM sandbox_layer_active_artifacts active
           WHERE active.source_id = sandbox_layer_artifacts.source_id
             AND active.resource_profile_key = sandbox_layer_artifacts.resource_profile_key
             AND active.artifact_id = sandbox_layer_artifacts.id
         )`,
      )
      .bind(row.id),
  ]);
  const cas = results[0] as D1Result;
  if (!d1Changed(cas)) return "skipped_active_changed";
  return "promoted";
}

export async function promoteSandboxLayerArtifact(
  db: D1Database,
  input: { buildId: string; artifactId: string; nowMs: number },
): Promise<"promoted" | "stale" | "blocked" | "missing"> {
  const row = await db
    .prepare(
      `SELECT a.*, b.created_at AS build_created_at, b.status AS build_status
       FROM sandbox_layer_artifacts a
       INNER JOIN sandbox_layer_builds b ON b.id = a.build_id
       WHERE a.id = ? AND b.id = ?
       LIMIT 1`,
    )
    .bind(input.artifactId, input.buildId)
    .first<SandboxLayerArtifactRow & { build_created_at: number; build_status: SandboxLayerBuildStatus }>();
  if (!row || row.build_status !== "completed") return "missing";
  if (row.status === "blocked") return "blocked";

  const newer = await db
    .prepare(
      `SELECT newer.id
       FROM sandbox_layer_builds newer
       INNER JOIN sandbox_layer_artifacts newer_artifact ON newer_artifact.build_id = newer.id
       WHERE newer.source_id = ?
         AND newer.resource_profile_key = ?
         AND newer.provider = ?
         AND newer.status = 'completed'
         AND newer.promotion_eligibility = 'default_branch_head'
         AND newer.will_promote = 1
         AND newer_artifact.status != 'blocked'
         AND newer.created_at > ?
       LIMIT 1`,
    )
    .bind(row.source_id, row.resource_profile_key, row.provider, row.build_created_at)
    .first<{ id: string }>();
  if (newer) return "stale";

  await db.batch([
    db
      .prepare(
        `UPDATE sandbox_layer_artifacts
       SET status = 'superseded'
       WHERE source_id = ?
         AND resource_profile_key = ?
         AND id != ?
         AND status = 'active'`,
      )
      .bind(row.source_id, row.resource_profile_key, row.id),
    db.prepare("UPDATE sandbox_layer_artifacts SET status = 'active', blocked_at = NULL WHERE id = ?").bind(row.id),
    db
      .prepare(
        `INSERT INTO sandbox_layer_active_artifacts (source_id, resource_profile_key, artifact_id, build_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_id, resource_profile_key) DO UPDATE SET
         artifact_id = excluded.artifact_id,
         build_id = excluded.build_id,
         updated_at = excluded.updated_at`,
      )
      .bind(row.source_id, row.resource_profile_key, row.id, row.build_id, input.nowMs),
  ]);
  return "promoted";
}

export async function getNewestCompletedPromotableSandboxLayerArtifact(
  db: D1Database,
  input: { sourceId: string; resourceProfileKey: string; provider: SandboxLayerProvider },
): Promise<SandboxLayerArtifactRow | null> {
  return db
    .prepare(
      `SELECT a.*
       FROM sandbox_layer_builds b
       INNER JOIN sandbox_layer_artifacts a ON a.build_id = b.id
       WHERE b.source_id = ?
         AND b.resource_profile_key = ?
         AND b.provider = ?
         AND b.status = 'completed'
         AND b.promotion_eligibility = 'default_branch_head'
         AND b.will_promote = 1
         AND a.status != 'blocked'
       ORDER BY b.created_at DESC, a.created_at DESC
       LIMIT 1`,
    )
    .bind(input.sourceId, input.resourceProfileKey, input.provider)
    .first<SandboxLayerArtifactRow>();
}

export async function getNewestCompletedPromotableSandboxLayerBuildForSourceProfile(
  db: D1Database,
  input: {
    sourceId: string;
    resourceProfileKey: string;
    provider: SandboxLayerProvider;
    runtimeBackend: RuntimeBackend;
  },
): Promise<SandboxLayerBuildRow | null> {
  return db
    .prepare(
      `SELECT b.*
       FROM sandbox_layer_builds b
       LEFT JOIN sandbox_layer_artifacts a ON a.build_id = b.id
       WHERE b.source_id = ?
         AND b.resource_profile_key = ?
         AND b.provider = ?
         AND b.runtime_backend = ?
         AND b.status = 'completed'
         AND b.promotion_eligibility = 'default_branch_head'
         AND b.will_promote = 1
         AND (a.id IS NULL OR a.status != 'blocked')
       ORDER BY b.created_at DESC, b.completed_at DESC
       LIMIT 1`,
    )
    .bind(input.sourceId, input.resourceProfileKey, input.provider, input.runtimeBackend)
    .first<SandboxLayerBuildRow>();
}

export async function getNewestCompletedPromotableSandboxLayerBuildForSource(
  db: D1Database,
  input: { sourceId: string; provider: SandboxLayerProvider; runtimeBackend: RuntimeBackend },
): Promise<SandboxLayerBuildRow | null> {
  return db
    .prepare(
      `SELECT b.*
       FROM sandbox_layer_builds b
       LEFT JOIN sandbox_layer_artifacts a ON a.build_id = b.id
       WHERE b.source_id = ?
         AND b.provider = ?
         AND b.runtime_backend = ?
         AND b.status = 'completed'
         AND b.promotion_eligibility = 'default_branch_head'
         AND b.will_promote = 1
         AND (a.id IS NULL OR a.status != 'blocked')
       ORDER BY b.created_at DESC, b.completed_at DESC
       LIMIT 1`,
    )
    .bind(input.sourceId, input.provider, input.runtimeBackend)
    .first<SandboxLayerBuildRow>();
}

export async function getSandboxLayerActiveArtifactCandidateForRepo(
  db: D1Database,
  input: { businessId: string; repoOwner: string; repoName: string; manifestPath: string },
): Promise<SandboxLayerActiveArtifactDetailsRow | null> {
  return db
    .prepare(
      `SELECT a.*, active.artifact_id, active.build_id AS active_build_id, active.updated_at AS active_updated_at,
              s.repo_owner, s.repo_name, s.manifest_path, s.status AS source_status
       FROM sandbox_layer_sources s
       INNER JOIN sandbox_layer_active_artifacts active ON active.source_id = s.id
       INNER JOIN sandbox_layer_artifacts a ON a.id = active.artifact_id
       WHERE s.business_id = ?
         AND LOWER(s.repo_owner) = LOWER(?)
         AND LOWER(s.repo_name) = LOWER(?)
         AND s.manifest_path = ?
       ORDER BY active.updated_at DESC
       LIMIT 1`,
    )
    .bind(input.businessId, input.repoOwner, input.repoName, input.manifestPath)
    .first<SandboxLayerActiveArtifactDetailsRow>();
}

export async function getSandboxLayerActiveArtifactCandidateForRepoProfile(
  db: D1Database,
  input: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    manifestPath: string;
    resourceProfileKey: string;
  },
): Promise<SandboxLayerActiveArtifactDetailsRow | null> {
  return db
    .prepare(
      `SELECT a.*, active.artifact_id, active.build_id AS active_build_id, active.updated_at AS active_updated_at,
              s.repo_owner, s.repo_name, s.manifest_path, s.status AS source_status
       FROM sandbox_layer_sources s
       INNER JOIN sandbox_layer_active_artifacts active ON active.source_id = s.id
       INNER JOIN sandbox_layer_artifacts a ON a.id = active.artifact_id
       WHERE s.business_id = ?
         AND LOWER(s.repo_owner) = LOWER(?)
         AND LOWER(s.repo_name) = LOWER(?)
         AND s.manifest_path = ?
         AND active.resource_profile_key = ?
       ORDER BY active.updated_at DESC
       LIMIT 1`,
    )
    .bind(input.businessId, input.repoOwner, input.repoName, input.manifestPath, input.resourceProfileKey)
    .first<SandboxLayerActiveArtifactDetailsRow>();
}

export async function getLatestSandboxLayerBuildForRepo(
  db: D1Database,
  input: { businessId: string; repoOwner: string; repoName: string; manifestPath: string; resourceProfileKey: string },
): Promise<SandboxLayerBuildDetailsWithCreatorRow | null> {
  return db
    .prepare(
      `SELECT b.*, s.business_id, s.repo_owner, s.repo_name, s.manifest_path,
              u.login AS created_by_login, u.name AS created_by_name
       FROM sandbox_layer_sources s
       INNER JOIN sandbox_layer_builds b ON b.source_id = s.id
       LEFT JOIN users u ON u.id = b.created_by_user_id
       WHERE s.business_id = ?
         AND LOWER(s.repo_owner) = LOWER(?)
         AND LOWER(s.repo_name) = LOWER(?)
         AND s.manifest_path = ?
         AND b.resource_profile_key = ?
       ORDER BY b.created_at DESC
       LIMIT 1`,
    )
    .bind(input.businessId, input.repoOwner, input.repoName, input.manifestPath, input.resourceProfileKey)
    .first<SandboxLayerBuildDetailsWithCreatorRow>();
}

function buildLayerBuildListFilter(input: {
  businessId: string;
  sourceRepoOwner?: string;
  sourceRepoName?: string;
  resourceProfileKey?: string;
  status?: SandboxLayerBuildStatus;
  limit?: number;
}): { conditions: string[]; params: Array<string | number> } {
  const conditions = ["s.business_id = ?"];
  const params: Array<string | number> = [input.businessId];
  if (input.sourceRepoOwner && input.sourceRepoName) {
    conditions.push("LOWER(s.repo_owner) = LOWER(?)", "LOWER(s.repo_name) = LOWER(?)");
    params.push(input.sourceRepoOwner, input.sourceRepoName);
  }
  if (input.resourceProfileKey) {
    conditions.push("b.resource_profile_key = ?");
    params.push(input.resourceProfileKey);
  }
  if (input.status) {
    conditions.push("b.status = ?");
    params.push(input.status);
  }
  params.push(clampLimit(input.limit, 20, 50));
  return { conditions, params };
}

export async function listSandboxLayerBuildsWithCreator(
  db: D1Database,
  input: {
    businessId: string;
    sourceRepoOwner?: string;
    sourceRepoName?: string;
    resourceProfileKey?: string;
    status?: SandboxLayerBuildStatus;
    limit?: number;
  },
): Promise<SandboxLayerBuildSummaryWithCreatorRow[]> {
  const filter = buildLayerBuildListFilter(input);
  const result = await db
    .prepare(
      `SELECT b.*, s.business_id, s.repo_owner, s.repo_name, s.manifest_path,
              u.login AS created_by_login, u.name AS created_by_name
       FROM sandbox_layer_builds b
       INNER JOIN sandbox_layer_sources s ON s.id = b.source_id
       LEFT JOIN users u ON u.id = b.created_by_user_id
       WHERE ${filter.conditions.join(" AND ")}
       ORDER BY b.created_at DESC
       LIMIT ?`,
    )
    .bind(...filter.params)
    .all<SandboxLayerBuildSummaryWithCreatorRow>();
  return result.results ?? [];
}

export async function appendSandboxLayerBuildLogChunk(
  db: D1Database,
  input: { id: string; buildId: string; sequence: number; message: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO sandbox_layer_build_log_chunks (id, build_id, sequence, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.buildId, input.sequence, input.message, input.nowMs)
    .run();
  return d1Changed(result);
}

export async function appendNextSandboxLayerBuildLogChunk(
  db: D1Database,
  input: { id: string; buildId: string; message: string; nowMs: number },
): Promise<boolean> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(sequence), -1) AS sequence FROM sandbox_layer_build_log_chunks WHERE build_id = ?")
    .bind(input.buildId)
    .first<{ sequence: number }>();
  return appendSandboxLayerBuildLogChunk(db, {
    id: input.id,
    buildId: input.buildId,
    sequence: Number(row?.sequence ?? -1) + 1,
    message: input.message,
    nowMs: input.nowMs,
  });
}

export async function listSandboxLayerBuildLogChunks(
  db: D1Database,
  input: { buildId: string; afterSequence?: number; limit?: number },
): Promise<SandboxLayerBuildLogChunkRow[]> {
  const limit = clampLimit(input.limit, 100, 500);
  const result = await db
    .prepare(
      `SELECT *
       FROM sandbox_layer_build_log_chunks
       WHERE build_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .bind(input.buildId, input.afterSequence ?? -1, limit)
    .all<SandboxLayerBuildLogChunkRow>();
  return result.results ?? [];
}

function clampLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(Math.floor(value as number), maxValue));
}
