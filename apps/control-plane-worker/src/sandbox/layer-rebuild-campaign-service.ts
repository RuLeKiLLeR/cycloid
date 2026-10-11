import { stringifyError } from "../../../../shared/utils/errors.js";
import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { fetchRepoTextFileAtCommit, RepoSourceError } from "../github/repo-source";
import { createLogger } from "../logger";
import type { AuthInfo, Env, SandboxLayerBuildQueueMessage } from "../types";
import { resolveCurrentSandboxBaseTemplateForProfile, type ResolvedSandboxBaseTemplate } from "./base-template-service";
import {
  appendNextSandboxLayerBuildLogChunk,
  createOrGetSandboxLayerBuild,
  getSandboxLayerArtifactForBuild,
  getSandboxLayerBuild,
  getSandboxLayerRebuildCampaignRow,
  insertSandboxLayerRebuildCampaign,
  insertSandboxLayerRebuildCampaignItemsBatch,
  listActiveSandboxLayerArtifactRebuildCandidates,
  listPlannedSandboxLayerRebuildCampaignItems,
  listRunnableSandboxLayerRebuildCampaigns,
  listSandboxLayerRebuildCampaignItems,
  listSandboxLayerRebuildCampaignItemsForBuild,
  listSandboxLayerRebuildCandidatesForItems,
  markSandboxLayerBuildQueued,
  promoteSandboxLayerArtifactForRebuild,
  type SandboxLayerActiveArtifactRebuildCandidateRow,
  type SandboxLayerRebuildCampaignItemRow,
  type SandboxLayerRebuildCampaignItemStatus,
  type SandboxLayerRebuildCampaignRow,
  type SandboxLayerRebuildCampaignStatus,
  updateSandboxLayerRebuildCampaignItem,
  updateSandboxLayerRebuildCampaignScanCursor,
  updateSandboxLayerRebuildCampaignStatus,
} from "./layer-db";
import {
  parseSandboxLayerManifest,
  parseSandboxLayerSource,
  SANDBOX_LAYER_COMPILER_VERSION,
  SandboxLayerValidationError,
} from "./layer-parser";

const log = createLogger({ bindings: { component: "sandbox-layer-rebuild-campaign-service" } });
const DEFAULT_REBUILD_CAMPAIGN_BATCH_LIMIT = 3;
const DEFAULT_REBUILD_CANDIDATE_BATCH_LIMIT = 25;
const DEFAULT_REBUILD_ITEM_QUEUE_LIMIT = 5;
type BaseTemplateCache = Map<string, Promise<ResolvedSandboxBaseTemplate>>;

export type SandboxLayerRebuildCampaignScope = "business" | "all";
export type SandboxLayerRebuildCampaignReason = "base_update";

export interface SandboxLayerRebuildCampaignSummary {
  activeArtifactsScanned: number;
  staleArtifactsFound: number;
  currentArtifactsSkipped: number;
  missingInstallationSkips: number;
  sourceUnavailableSkips: number;
  unversionedBaseSkips: number;
  activeChangedSkips: number;
  failedItems: number;
  promotedItems: number;
  buildsQueued: number;
}

export interface SandboxLayerRebuildCampaignDetails {
  campaign: {
    id: string;
    scope: SandboxLayerRebuildCampaignScope;
    businessId: string | null;
    reason: SandboxLayerRebuildCampaignReason;
    status: SandboxLayerRebuildCampaignStatus;
    createdByUserId: number;
    createdAt: number;
    completedAt: number | null;
    summary: SandboxLayerRebuildCampaignSummary;
  };
  itemCounts: Record<string, number>;
  items: Array<{
    id: string;
    sourceId: string;
    repo: string | null;
    resourceProfileKey: string;
    previousArtifactId: string;
    previousBuildId: string;
    previousBaseTemplateRef: string;
    previousBaseVersion: string;
    targetBaseTemplateRef: string;
    targetBaseVersion: string;
    buildId: string | null;
    status: SandboxLayerRebuildCampaignItemStatus;
    error: string | null;
  }>;
}

export interface SandboxLayerRebuildCampaignTickResult {
  campaignsScanned: number;
  candidatesPlanned: number;
  itemsQueued: number;
}

export class SandboxLayerRebuildCampaignError extends Error {
  constructor(
    readonly code: "invalid_request" | "campaign_not_found",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SandboxLayerRebuildCampaignError";
  }
}

export async function createSandboxLayerRebuildCampaign(
  env: Env,
  auth: AuthInfo,
  input: { scope: unknown; businessId?: unknown; reason: unknown; dryRun?: unknown; processInline?: unknown },
): Promise<SandboxLayerRebuildCampaignDetails> {
  const scope = normalizeScope(input.scope);
  const reason = normalizeReason(input.reason);
  const dryRun = input.dryRun === true;
  const processInline = dryRun || input.processInline === true;
  const businessId = scope === "business" ? normalizeBusinessId(input.businessId) : null;
  const nowMs = Date.now();
  const campaignId = crypto.randomUUID();
  const campaign: SandboxLayerRebuildCampaignRow = {
    id: campaignId,
    scope,
    business_id: businessId,
    reason,
    status: dryRun ? "completed" : "queued",
    created_by_user_id: Number(auth.userId),
    created_at: nowMs,
    completed_at: dryRun ? nowMs : null,
    summary_json: JSON.stringify(emptySummary()),
    scan_cursor_updated_at: null,
    scan_cursor_artifact_id: null,
    scan_completed_at: null,
  };
  await insertSandboxLayerRebuildCampaign(env.DB, campaign);

  if (!processInline) {
    log.info(
      { campaignId, businessId, scope, dryRun, status: campaign.status },
      "Sandbox layer rebuild campaign created for scheduled processing",
    );
    return getSandboxLayerRebuildCampaign(env.DB, campaignId);
  }

  const candidates = await listActiveSandboxLayerArtifactRebuildCandidates(env.DB, { businessId });
  log.info(
    { campaignId, businessId, scope, activeArtifactsScanned: candidates.length, dryRun },
    "Sandbox layer rebuild campaign started",
  );

  const baseTemplateCache: BaseTemplateCache = new Map();
  const items: SandboxLayerRebuildCampaignItemRow[] = [];
  for (const candidate of candidates) {
    const item = await createCampaignItemForCandidate(env, campaignId, candidate, nowMs, baseTemplateCache);
    items.push(item);
  }
  await insertSandboxLayerRebuildCampaignItemsBatch(env.DB, items);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const candidate = candidates[index]!;
    log.info(
      sandboxLayerRebuildCampaignItemLogFields({ campaignId, businessId, item }),
      "Sandbox layer rebuild campaign item planned",
    );
    if (!dryRun && item.status === "planned") {
      await queueCampaignItem(env, campaignId, Number(auth.userId), item, candidate);
    }
  }

  const lastCandidate = candidates[candidates.length - 1] ?? null;
  await updateSandboxLayerRebuildCampaignScanCursor(env.DB, {
    campaignId,
    cursorUpdatedAt: lastCandidate?.active_updated_at ?? null,
    cursorArtifactId: lastCandidate?.artifact_id ?? null,
    completedAt: candidates.length < 500 ? Date.now() : null,
  });
  await refreshCampaignStatus(env.DB, campaignId, Date.now());
  return getSandboxLayerRebuildCampaign(env.DB, campaignId);
}

export async function processSandboxLayerRebuildCampaignsTick(
  env: Env,
  options: { campaignLimit?: number; candidateLimit?: number; itemQueueLimit?: number } = {},
): Promise<SandboxLayerRebuildCampaignTickResult> {
  const campaignLimit = clampPositiveInteger(options.campaignLimit, DEFAULT_REBUILD_CAMPAIGN_BATCH_LIMIT);
  const candidateLimit = clampPositiveInteger(options.candidateLimit, DEFAULT_REBUILD_CANDIDATE_BATCH_LIMIT);
  const itemQueueLimit = clampPositiveInteger(options.itemQueueLimit, DEFAULT_REBUILD_ITEM_QUEUE_LIMIT);
  const campaigns = await listRunnableSandboxLayerRebuildCampaigns(env.DB, { limit: campaignLimit });
  const result: SandboxLayerRebuildCampaignTickResult = {
    campaignsScanned: campaigns.length,
    candidatesPlanned: 0,
    itemsQueued: 0,
  };

  for (const campaign of campaigns) {
    result.candidatesPlanned += await planCampaignCandidatesBatch(env, campaign, candidateLimit);
    result.itemsQueued += await queuePlannedCampaignItemsBatch(env, campaign, itemQueueLimit);
    await refreshCampaignStatus(env.DB, campaign.id, Date.now());
  }

  return result;
}

export async function getSandboxLayerRebuildCampaign(
  db: D1Database,
  campaignId: string,
): Promise<SandboxLayerRebuildCampaignDetails> {
  const campaign = await getSandboxLayerRebuildCampaignRow(db, campaignId);
  if (!campaign) {
    throw new SandboxLayerRebuildCampaignError("campaign_not_found", "Campaign not found", 404);
  }
  const items = await listSandboxLayerRebuildCampaignItems(db, campaignId);
  return formatCampaignDetails(campaign, items);
}

export async function markRebuildCampaignItemBuildingForBuild(db: D1Database, buildId: string): Promise<void> {
  const items = await listSandboxLayerRebuildCampaignItemsForBuild(db, buildId);
  const nowMs = Date.now();
  for (const item of items) {
    await updateSandboxLayerRebuildCampaignItem(db, {
      itemId: item.id,
      status: "building",
      buildId,
      error: null,
      nowMs,
    });
    await refreshCampaignStatus(db, item.campaign_id, nowMs);
  }
}

export async function markRebuildCampaignItemFailedForBuild(
  db: D1Database,
  buildId: string,
  error: string,
): Promise<void> {
  const items = await listSandboxLayerRebuildCampaignItemsForBuild(db, buildId);
  const nowMs = Date.now();
  for (const item of items) {
    await updateSandboxLayerRebuildCampaignItem(db, {
      itemId: item.id,
      status: "failed",
      buildId,
      error: boundError(error),
      nowMs,
    });
    await refreshCampaignStatus(db, item.campaign_id, nowMs);
  }
}

export async function completeRebuildCampaignBuild(
  db: D1Database,
  buildId: string,
  artifactId: string,
  nowMs: number,
): Promise<"promoted" | "skipped_active_changed" | "missing" | "blocked" | "not_rebuild"> {
  const items = await listSandboxLayerRebuildCampaignItemsForBuild(db, buildId);
  if (items.length === 0) return "not_rebuild";
  let result: "promoted" | "skipped_active_changed" | "missing" | "blocked" = "skipped_active_changed";
  let promotedPreviousArtifactId: string | null = null;
  for (const item of items) {
    const itemResult = await promoteSandboxLayerArtifactForRebuild(db, {
      buildId,
      artifactId,
      previousArtifactId: item.previous_artifact_id,
      nowMs,
    });
    if (itemResult === "promoted") {
      result = "promoted";
      promotedPreviousArtifactId = item.previous_artifact_id;
      break;
    }
    if (itemResult === "missing" || itemResult === "blocked") {
      result = itemResult;
      break;
    }
  }
  for (const linkedItem of items) {
    const status =
      result === "promoted" && linkedItem.previous_artifact_id === promotedPreviousArtifactId
        ? "promoted"
        : result === "promoted" || result === "skipped_active_changed"
          ? "skipped_active_changed"
          : "failed";
    const error =
      status === "promoted"
        ? null
        : status === "skipped_active_changed"
          ? "Active artifact changed before rebuild promotion"
          : `Promotion failed: ${result}`;
    await updateSandboxLayerRebuildCampaignItem(db, {
      itemId: linkedItem.id,
      status,
      buildId,
      error,
      nowMs,
    });
    await refreshCampaignStatus(db, linkedItem.campaign_id, nowMs);
  }
  return result;
}

async function createCampaignItemForCandidate(
  env: Env,
  campaignId: string,
  candidate: SandboxLayerActiveArtifactRebuildCandidateRow,
  nowMs: number,
  baseTemplateCache: BaseTemplateCache,
): Promise<SandboxLayerRebuildCampaignItemRow> {
  const targetBase = await resolveCachedBaseTemplate(env, candidate, baseTemplateCache);
  let status: SandboxLayerRebuildCampaignItemStatus = "planned";
  let error: string | null = null;
  if (targetBase.versionQuality === "unversioned") {
    status = "skipped_unversioned_base";
    error = "Current base template is not versioned";
  } else if (
    candidate.base_template_ref === targetBase.baseTemplateRef &&
    candidate.base_version === targetBase.baseVersion
  ) {
    status = "skipped_current";
  }
  return {
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    source_id: candidate.source_id,
    resource_profile_key: candidate.resource_profile_key,
    previous_artifact_id: candidate.artifact_id,
    previous_build_id: candidate.active_build_id,
    previous_base_template_ref: candidate.base_template_ref,
    previous_base_version: candidate.base_version,
    target_base_template_ref: targetBase.baseTemplateRef,
    target_base_version: targetBase.baseVersion,
    build_id: null,
    status,
    error,
    created_at: nowMs,
    updated_at: nowMs,
    repo_owner: candidate.source_repo_owner,
    repo_name: candidate.source_repo_name,
  };
}

async function planCampaignCandidatesBatch(
  env: Env,
  campaign: SandboxLayerRebuildCampaignRow,
  limit: number,
): Promise<number> {
  if (campaign.scan_completed_at != null) return 0;
  const cursor =
    campaign.scan_cursor_updated_at != null && campaign.scan_cursor_artifact_id
      ? { updatedAt: campaign.scan_cursor_updated_at, artifactId: campaign.scan_cursor_artifact_id }
      : null;
  const candidates = await listActiveSandboxLayerArtifactRebuildCandidates(env.DB, {
    businessId: campaign.business_id,
    activeUpdatedBeforeOrAt: campaign.created_at,
    cursor,
    limit,
  });

  const baseTemplateCache: BaseTemplateCache = new Map();
  const items: SandboxLayerRebuildCampaignItemRow[] = [];
  for (const candidate of candidates) {
    const item = await createCampaignItemForCandidate(env, campaign.id, candidate, Date.now(), baseTemplateCache);
    items.push(item);
  }
  await insertSandboxLayerRebuildCampaignItemsBatch(env.DB, items);
  for (const item of items) {
    log.info(
      sandboxLayerRebuildCampaignItemLogFields({ campaignId: campaign.id, businessId: campaign.business_id, item }),
      "Sandbox layer rebuild campaign item planned",
    );
  }

  const lastCandidate = candidates[candidates.length - 1] ?? null;
  await updateSandboxLayerRebuildCampaignScanCursor(env.DB, {
    campaignId: campaign.id,
    cursorUpdatedAt: lastCandidate?.active_updated_at ?? campaign.scan_cursor_updated_at,
    cursorArtifactId: lastCandidate?.artifact_id ?? campaign.scan_cursor_artifact_id,
    completedAt: candidates.length < limit ? Date.now() : null,
  });

  return candidates.length;
}

async function queuePlannedCampaignItemsBatch(
  env: Env,
  campaign: SandboxLayerRebuildCampaignRow,
  limit: number,
): Promise<number> {
  const items = await listPlannedSandboxLayerRebuildCampaignItems(env.DB, campaign.id, { limit });
  const candidatesByItemId = await listSandboxLayerRebuildCandidatesForItems(
    env.DB,
    items.map((item) => item.id),
  );
  let queued = 0;
  for (const item of items) {
    const candidate = candidatesByItemId.get(item.id) ?? null;
    if (!candidate) {
      await skipItem(env.DB, item, "failed", "Missing rebuild campaign candidate");
      continue;
    }
    if (await queueCampaignItem(env, campaign.id, campaign.created_by_user_id, item, candidate)) queued += 1;
  }
  return queued;
}

function baseTemplateCacheKey(candidate: SandboxLayerActiveArtifactRebuildCandidateRow): string {
  return `${candidate.runtime_backend}:${candidate.resource_profile_key}`;
}

async function resolveCachedBaseTemplate(
  env: Env,
  candidate: SandboxLayerActiveArtifactRebuildCandidateRow,
  cache: BaseTemplateCache,
): Promise<ResolvedSandboxBaseTemplate> {
  const key = baseTemplateCacheKey(candidate);
  let cached = cache.get(key);
  if (!cached) {
    cached = resolveCurrentSandboxBaseTemplateForProfile(env, {
      runtimeBackend: candidate.runtime_backend,
      resourceProfileKey: candidate.resource_profile_key,
    });
    cached.catch(() => {
      if (cache.get(key) === cached) cache.delete(key);
    });
    cache.set(key, cached);
  }
  return cached;
}

function sandboxLayerRebuildCampaignItemLogFields(input: {
  campaignId: string;
  businessId: string | null;
  item: SandboxLayerRebuildCampaignItemRow;
}): Record<string, unknown> {
  return {
    campaignId: input.campaignId,
    campaignItemId: input.item.id,
    businessId: input.businessId,
    sourceId: input.item.source_id,
    repoOwner: input.item.repo_owner,
    repoName: input.item.repo_name,
    resourceProfileKey: input.item.resource_profile_key,
    previousBaseTemplateRef: input.item.previous_base_template_ref,
    previousBaseVersion: input.item.previous_base_version,
    targetBaseTemplateRef: input.item.target_base_template_ref,
    targetBaseVersion: input.item.target_base_version,
    status: input.item.status,
  };
}

async function queueCampaignItem(
  env: Env,
  campaignId: string,
  actorUserId: number,
  item: SandboxLayerRebuildCampaignItemRow,
  candidate: SandboxLayerActiveArtifactRebuildCandidateRow,
): Promise<boolean> {
  const nowMs = Date.now();
  const repoOwner = candidate.source_repo_owner;
  const repoName = candidate.source_repo_name;
  log.info(
    {
      campaignId,
      campaignItemId: item.id,
      sourceId: item.source_id,
      repoOwner,
      repoName,
      resourceProfileKey: item.resource_profile_key,
      baseTemplateRef: item.target_base_template_ref,
      baseVersion: item.target_base_version,
      commitSha: candidate.commit_sha,
      phase: "github_installation_lookup",
    },
    "Sandbox layer rebuild item queueing started",
  );
  const installation = await getInstallationByOwner(env.DB, repoOwner);
  if (!installation || installation.suspended_at) {
    await skipItem(env.DB, item, "skipped_missing_installation", "Missing or suspended GitHub App installation");
    return false;
  }

  let token: string;
  try {
    token = await createInstallationToken(env, installation.installation_id);
    log.info(
      {
        campaignId,
        campaignItemId: item.id,
        sourceId: item.source_id,
        repoOwner,
        repoName,
        resourceProfileKey: item.resource_profile_key,
        phase: "github_installation_token",
        status: "created",
      },
      "Sandbox layer rebuild GitHub installation token created",
    );
  } catch (err) {
    await skipItem(
      env.DB,
      item,
      "skipped_source_unavailable",
      `Unable to create installation token: ${errorMessage(err)}`,
    );
    return false;
  }

  let manifestText: string;
  let layerText: string;
  let layerPath: string;
  try {
    log.info(
      {
        campaignId,
        campaignItemId: item.id,
        sourceId: item.source_id,
        repoOwner,
        repoName,
        resourceProfileKey: item.resource_profile_key,
        commitSha: candidate.commit_sha,
        manifestPath: candidate.manifest_path,
        phase: "source_fetch",
      },
      "Sandbox layer rebuild source fetch started",
    );
    manifestText = await fetchRepoTextFileAtCommit(
      token,
      repoOwner,
      repoName,
      candidate.manifest_path,
      candidate.commit_sha,
    );
    const manifest = parseSandboxLayerManifest(candidate.manifest_path, manifestText);
    layerPath = manifest.layer.dockerfile;
    layerText = await fetchRepoTextFileAtCommit(token, repoOwner, repoName, layerPath, candidate.commit_sha);
    log.info(
      {
        campaignId,
        campaignItemId: item.id,
        sourceId: item.source_id,
        repoOwner,
        repoName,
        resourceProfileKey: item.resource_profile_key,
        commitSha: candidate.commit_sha,
        manifestPath: candidate.manifest_path,
        layerPath,
        phase: "source_fetch",
        status: "fetched",
      },
      "Sandbox layer rebuild source fetch completed",
    );
  } catch (err) {
    const status = err instanceof RepoSourceError ? "skipped_source_unavailable" : "failed";
    await skipItem(env.DB, item, status, errorMessage(err));
    return false;
  }

  let parsed;
  try {
    log.info(
      {
        campaignId,
        campaignItemId: item.id,
        sourceId: item.source_id,
        repoOwner,
        repoName,
        resourceProfileKey: item.resource_profile_key,
        manifestPath: candidate.manifest_path,
        layerPath,
        baseTemplateRef: item.target_base_template_ref,
        baseVersion: item.target_base_version,
        phase: "source_parse",
      },
      "Sandbox layer rebuild source parse started",
    );
    parsed = await parseSandboxLayerSource({
      manifestPath: candidate.manifest_path,
      manifestText,
      layerPath,
      layerText,
      buildIdentity: {
        baseTemplateRef: item.target_base_template_ref,
        baseVersion: item.target_base_version,
        compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      },
    });
    log.info(
      {
        campaignId,
        campaignItemId: item.id,
        sourceId: item.source_id,
        repoOwner,
        repoName,
        resourceProfileKey: item.resource_profile_key,
        manifestPath: candidate.manifest_path,
        layerPath,
        sourceContentHash: parsed.hashes.normalizedSourceHash,
        phase: "source_parse",
        status: "parsed",
      },
      "Sandbox layer rebuild source parse completed",
    );
  } catch (err) {
    const detail =
      err instanceof SandboxLayerValidationError
        ? `${err.message}:${JSON.stringify(err.issues ?? []).slice(0, 512)}`
        : errorMessage(err);
    await skipItem(env.DB, item, "failed", detail);
    return false;
  }

  const { row } = await createOrGetSandboxLayerBuild(env.DB, {
    id: crypto.randomUUID(),
    sourceId: candidate.source_id,
    commitSha: candidate.commit_sha,
    sourceContentHash: parsed.hashes.normalizedSourceHash,
    manifestHash: parsed.hashes.manifestHash,
    layerHash: parsed.hashes.layerHash,
    normalizedLayerHash: parsed.hashes.normalizedSourceHash,
    manifestPath: candidate.manifest_path,
    layerPath: parsed.manifest.layerDockerfile,
    layerInstructionsJson: JSON.stringify(parsed.layer.instructions),
    smokeCommandsJson: JSON.stringify(parsed.manifest.smokeCommands),
    baseTemplateRef: item.target_base_template_ref,
    baseVersion: item.target_base_version,
    resourceProfileKey: candidate.resource_profile_key,
    compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    initialStatus: "validated",
    requestedRef: candidate.commit_sha,
    promotionEligibility: "unknown",
    willPromote: 1,
    rebuildCampaignId: campaignId,
    buildReason: "base_update",
    createdByUserId: actorUserId,
    nowMs,
  });

  await appendNextSandboxLayerBuildLogChunk(env.DB, {
    id: crypto.randomUUID(),
    buildId: row.id,
    message: `Sandbox layer rebuild campaign ${campaignId} item ${item.id} queued for active commit ${candidate.commit_sha}.`,
    nowMs,
  });

  const artifact = row.status === "completed" ? await getSandboxLayerArtifactForBuild(env.DB, row.id) : null;
  if (artifact) {
    await updateSandboxLayerRebuildCampaignItem(env.DB, {
      itemId: item.id,
      status: "building",
      buildId: row.id,
      error: null,
      nowMs,
    });
    const result = await completeRebuildCampaignBuild(env.DB, row.id, artifact.id, nowMs);
    if (result === "promoted" || result === "skipped_active_changed" || result === "missing" || result === "blocked")
      return true;
  }
  if (row.status === "completed") {
    await skipItem(env.DB, item, "failed", "Completed sandbox layer build is missing its provider artifact", row.id);
    return false;
  }

  if (row.status === "validated") {
    const queue = env.SANDBOX_LAYER_BUILD_QUEUE;
    if (!queue) {
      await skipItem(env.DB, item, "failed", "Sandbox layer build queue is not configured", row.id);
      return false;
    }
    try {
      await queue.send({ buildId: row.id, reason: "start", attempt: 0 } satisfies SandboxLayerBuildQueueMessage);
      await markSandboxLayerBuildQueued(env.DB, { buildId: row.id, nowMs: Date.now() });
      log.info(
        {
          campaignId,
          campaignItemId: item.id,
          sourceId: item.source_id,
          buildId: row.id,
          repoOwner,
          repoName,
          resourceProfileKey: item.resource_profile_key,
          baseTemplateRef: item.target_base_template_ref,
          baseVersion: item.target_base_version,
          phase: "queue_enqueue",
          status: "queued",
        },
        "Sandbox layer rebuild provider build queued",
      );
    } catch (err) {
      await skipItem(env.DB, item, "failed", errorMessage(err), row.id);
      return false;
    }
  }

  const refreshed = (await getSandboxLayerBuild(env.DB, row.id)) ?? row;
  await updateSandboxLayerRebuildCampaignItem(env.DB, {
    itemId: item.id,
    status: refreshed.status === "queued" || refreshed.status === "validated" ? "queued" : "building",
    buildId: row.id,
    error: null,
    nowMs: Date.now(),
  });
  await refreshCampaignStatus(env.DB, campaignId, Date.now());
  return true;
}

async function skipItem(
  db: D1Database,
  item: SandboxLayerRebuildCampaignItemRow,
  status: SandboxLayerRebuildCampaignItemStatus,
  error: string,
  buildId?: string,
): Promise<void> {
  await updateSandboxLayerRebuildCampaignItem(db, {
    itemId: item.id,
    status,
    buildId,
    error: boundError(error),
    nowMs: Date.now(),
  });
  await refreshCampaignStatus(db, item.campaign_id, Date.now());
  log.warn(
    {
      campaignId: item.campaign_id,
      campaignItemId: item.id,
      sourceId: item.source_id,
      buildId: buildId ?? item.build_id,
      repoOwner: item.repo_owner,
      repoName: item.repo_name,
      resourceProfileKey: item.resource_profile_key,
      previousBaseTemplateRef: item.previous_base_template_ref,
      previousBaseVersion: item.previous_base_version,
      targetBaseTemplateRef: item.target_base_template_ref,
      targetBaseVersion: item.target_base_version,
      status,
      errorCode: status,
      error: boundError(error),
    },
    "Sandbox layer rebuild item skipped",
  );
}

async function refreshCampaignStatus(db: D1Database, campaignId: string, nowMs: number): Promise<void> {
  const campaign = await getSandboxLayerRebuildCampaignRow(db, campaignId);
  if (!campaign) return;
  const items = await listSandboxLayerRebuildCampaignItems(db, campaignId);
  const summary = summarizeItems(items);
  const scanComplete = campaign.scan_completed_at != null;
  const status = campaign.status === "completed" ? "completed" : campaignStatusFromItems(items, scanComplete);
  await updateSandboxLayerRebuildCampaignStatus(db, {
    campaignId,
    status,
    summaryJson: JSON.stringify(summary),
    completedAt: isCampaignTerminal(status) ? (campaign.completed_at ?? nowMs) : null,
  });
}

function formatCampaignDetails(
  campaign: SandboxLayerRebuildCampaignRow,
  items: SandboxLayerRebuildCampaignItemRow[],
): SandboxLayerRebuildCampaignDetails {
  const itemCounts: Record<string, number> = {};
  for (const item of items) itemCounts[item.status] = (itemCounts[item.status] ?? 0) + 1;
  return {
    campaign: {
      id: campaign.id,
      scope: campaign.scope as SandboxLayerRebuildCampaignScope,
      businessId: campaign.business_id,
      reason: campaign.reason as SandboxLayerRebuildCampaignReason,
      status: campaign.status,
      createdByUserId: campaign.created_by_user_id,
      createdAt: campaign.created_at,
      completedAt: campaign.completed_at,
      summary: parseSummary(campaign.summary_json),
    },
    itemCounts,
    items: items.map((item) => ({
      id: item.id,
      sourceId: item.source_id,
      repo: item.repo_owner && item.repo_name ? `${item.repo_owner}/${item.repo_name}` : null,
      resourceProfileKey: item.resource_profile_key,
      previousArtifactId: item.previous_artifact_id,
      previousBuildId: item.previous_build_id,
      previousBaseTemplateRef: item.previous_base_template_ref,
      previousBaseVersion: item.previous_base_version,
      targetBaseTemplateRef: item.target_base_template_ref,
      targetBaseVersion: item.target_base_version,
      buildId: item.build_id,
      status: item.status,
      error: item.error,
    })),
  };
}

function summarizeItems(items: SandboxLayerRebuildCampaignItemRow[]): SandboxLayerRebuildCampaignSummary {
  return {
    activeArtifactsScanned: items.length,
    staleArtifactsFound: items.filter((item) => !["skipped_current", "skipped_unversioned_base"].includes(item.status))
      .length,
    currentArtifactsSkipped: countStatus(items, "skipped_current"),
    missingInstallationSkips: countStatus(items, "skipped_missing_installation"),
    sourceUnavailableSkips: countStatus(items, "skipped_source_unavailable"),
    unversionedBaseSkips: countStatus(items, "skipped_unversioned_base"),
    activeChangedSkips: countStatus(items, "skipped_active_changed"),
    failedItems: countStatus(items, "failed"),
    promotedItems: countStatus(items, "promoted"),
    buildsQueued: items.filter((item) => item.build_id).length,
  };
}

function countStatus(
  items: SandboxLayerRebuildCampaignItemRow[],
  status: SandboxLayerRebuildCampaignItemStatus,
): number {
  return items.filter((item) => item.status === status).length;
}

function campaignStatusFromItems(
  items: SandboxLayerRebuildCampaignItemRow[],
  scanComplete: boolean,
): SandboxLayerRebuildCampaignStatus {
  if (items.length === 0) return scanComplete ? "completed" : "queued";
  if (items.some((item) => item.status === "building")) return "running";
  if (items.some((item) => item.status === "queued" || item.status === "planned") || !scanComplete) return "queued";
  if (items.every((item) => item.status === "failed")) return "failed";
  if (
    items.some((item) =>
      ["failed", "skipped_missing_installation", "skipped_source_unavailable", "skipped_active_changed"].includes(
        item.status,
      ),
    )
  ) {
    return "completed_with_failures";
  }
  return "completed";
}

function isCampaignTerminal(status: SandboxLayerRebuildCampaignStatus): boolean {
  return status === "completed" || status === "completed_with_failures" || status === "failed";
}

function parseSummary(value: string | null): SandboxLayerRebuildCampaignSummary {
  if (value) {
    try {
      return { ...emptySummary(), ...(JSON.parse(value) as Partial<SandboxLayerRebuildCampaignSummary>) };
    } catch {
      // fall through
    }
  }
  return emptySummary();
}

function emptySummary(): SandboxLayerRebuildCampaignSummary {
  return {
    activeArtifactsScanned: 0,
    staleArtifactsFound: 0,
    currentArtifactsSkipped: 0,
    missingInstallationSkips: 0,
    sourceUnavailableSkips: 0,
    unversionedBaseSkips: 0,
    activeChangedSkips: 0,
    failedItems: 0,
    promotedItems: 0,
    buildsQueued: 0,
  };
}

function normalizeScope(value: unknown): SandboxLayerRebuildCampaignScope {
  if (value === "business" || value === "all") return value;
  throw new SandboxLayerRebuildCampaignError("invalid_request", "scope must be business or all");
}

function normalizeReason(value: unknown): SandboxLayerRebuildCampaignReason {
  if (value === "base_update") return value;
  throw new SandboxLayerRebuildCampaignError("invalid_request", "reason must be base_update");
}

function normalizeBusinessId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SandboxLayerRebuildCampaignError("invalid_request", "businessId is required for business scope");
  }
  return value.trim();
}

function errorMessage(err: unknown): string {
  return stringifyError(err);
}

function boundError(error: string): string {
  return error.slice(0, 1024);
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
