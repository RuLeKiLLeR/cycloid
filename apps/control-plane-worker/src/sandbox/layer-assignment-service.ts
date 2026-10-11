import { isBusinessAdmin } from "../business/service";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import type { AuthInfo, Env } from "../types";
import { resolveCurrentSandboxBaseTemplateForProfile } from "./base-template-service";
import {
  canRepairSandboxLayerActiveArtifacts,
  repairLatestPromotableSandboxLayerForSource,
  repairLatestPromotableSandboxLayerForSourceProfile,
  tryRepairLatestPromotableSandboxLayerForSource,
} from "./layer-active-artifact-repair-service";
import {
  deleteSandboxLayerBusinessDefaultSource,
  deleteSandboxLayerRepoSourceAssignment,
  getAssignableSandboxLayerSourceByRepoPath,
  getSandboxLayerBusinessDefaultSourceDetails,
  hasSandboxLayerActiveArtifactForSource,
  hasSandboxLayerActiveArtifactForSourceProfile,
  hasSandboxLayerSourceInAnotherBusiness,
  listSandboxLayerRepoSourceAssignments,
  upsertSandboxLayerBusinessDefaultSource,
  upsertSandboxLayerRepoSourceAssignment,
} from "./layer-assignment-db";
import { getLatestSandboxLayerBuildForRepo, getSandboxLayerBuildWithSourceAndCreator } from "./layer-db";
import { SANDBOX_LAYER_MANIFEST_PATH, validateRepoRelativeCycloidPath } from "./layer-parser";
import {
  resolveSandboxLayerForSession,
  type SandboxLayerSelectionTier,
  type SandboxLayerSessionResolutionMiss,
} from "./layer-resolver";
import { resolveSandboxLayerResourceProfile } from "./layer-resource-profile";
import { parseSmokeResult, readNumber, readSmokeStatus, readString } from "./layer-smoke-result";
import { resolveRepoSandboxSpec } from "./repo-sandbox-specs";
import { E2B_CLOUD_RUNTIME_BACKEND } from "./runtime-backend";

export type SandboxLayerAssignmentErrorCode =
  | "business_admin_required"
  | "business_context_required"
  | "source_repo_access_denied"
  | "target_repo_access_denied"
  | "source_repo_installation_missing"
  | "target_repo_installation_missing"
  | "source_not_built"
  | "source_not_active"
  | "source_has_no_active_artifact"
  | "source_wrong_business"
  | "invalid_manifest_path"
  | "invalid_repo";

export class SandboxLayerAssignmentError extends Error {
  constructor(
    readonly code: SandboxLayerAssignmentErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SandboxLayerAssignmentError";
  }
}

export interface SandboxLayerAssignmentSourceInput {
  sourceRepoOwner?: unknown;
  sourceRepoName?: unknown;
  manifestPath?: unknown;
}

export async function listSandboxLayerAssignments(env: Env, auth: AuthInfo, input: { businessId: string }) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  let [businessDefault, repoAssignments] = await Promise.all([
    getSandboxLayerBusinessDefaultSourceDetails(env.DB, input.businessId),
    listSandboxLayerRepoSourceAssignments(env.DB, input.businessId),
  ]);
  const repairSourceIds = new Set<string>();
  if (businessDefault?.status === "active" && !businessDefault.latest_active_artifact_ref) {
    repairSourceIds.add(businessDefault.source_id);
  }
  for (const assignment of repoAssignments) {
    if (assignment.status === "active" && !assignment.latest_active_artifact_ref) {
      repairSourceIds.add(assignment.source_id);
    }
  }
  if (repairSourceIds.size > 0 && canRepairSandboxLayerActiveArtifacts(auth)) {
    await Promise.all(
      [...repairSourceIds].map((sourceId) =>
        tryRepairLatestPromotableSandboxLayerForSource(env, {
          sourceId,
          reason: "assignment_list_missing_active_artifact",
        }),
      ),
    );
    [businessDefault, repoAssignments] = await Promise.all([
      getSandboxLayerBusinessDefaultSourceDetails(env.DB, input.businessId),
      listSandboxLayerRepoSourceAssignments(env.DB, input.businessId),
    ]);
  }
  return {
    businessDefault: businessDefault
      ? {
          sourceRepo: `${businessDefault.repo_owner}/${businessDefault.repo_name}`,
          manifestPath: businessDefault.manifest_path,
          sourceId: businessDefault.source_id,
          latestActiveBuildId: businessDefault.latest_active_build_id,
          latestActiveArtifactRef: businessDefault.latest_active_artifact_ref,
          updatedAt: businessDefault.updated_at,
        }
      : null,
    repoAssignments: repoAssignments.map((assignment) => ({
      targetRepo: `${assignment.target_repo_owner}/${assignment.target_repo_name}`,
      sourceRepo: `${assignment.repo_owner}/${assignment.repo_name}`,
      manifestPath: assignment.manifest_path,
      sourceId: assignment.source_id,
      latestActiveBuildId: assignment.latest_active_build_id,
      latestActiveArtifactRef: assignment.latest_active_artifact_ref,
      updatedAt: assignment.updated_at,
    })),
  };
}

export async function setSandboxLayerBusinessDefaultSource(
  env: Env,
  auth: AuthInfo,
  input: { businessId: string; source: SandboxLayerAssignmentSourceInput },
) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  const source = await validateAssignmentSource(env, auth, input.businessId, input.source, "source");
  const row = await upsertSandboxLayerBusinessDefaultSource(env.DB, {
    businessId: input.businessId,
    sourceId: source.id,
    userId: numericUserId(auth),
    nowMs: Date.now(),
  });
  return {
    assignment: {
      sourceRepo: `${source.repo_owner}/${source.repo_name}`,
      manifestPath: source.manifest_path,
      sourceId: row.source_id,
      latestActiveBuildId: source.latest_active_build_id,
      latestActiveArtifactRef: source.latest_active_artifact_ref,
      updatedAt: row.updated_at,
    },
  };
}

export async function clearSandboxLayerBusinessDefaultSource(env: Env, auth: AuthInfo, input: { businessId: string }) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  return { deleted: await deleteSandboxLayerBusinessDefaultSource(env.DB, input.businessId) };
}

export async function setSandboxLayerRepoSourceAssignment(
  env: Env,
  auth: AuthInfo,
  input: {
    businessId: string;
    targetRepoOwner: string;
    targetRepoName: string;
    source: SandboxLayerAssignmentSourceInput;
  },
) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  const targetRepo = normalizeRepo(input.targetRepoOwner, input.targetRepoName);
  await assertRepoGate(env, auth, targetRepo.owner, targetRepo.name, "target");
  const source = await validateAssignmentSource(env, auth, input.businessId, input.source, "source");
  const targetProfile = resolveSandboxLayerResourceProfile(env, targetRepo.owner, targetRepo.name);
  let hasCoverage = await hasSandboxLayerActiveArtifactForSourceProfile(env.DB, {
    businessId: input.businessId,
    sourceId: source.id,
    resourceProfileKey: targetProfile.key,
  });
  if (!hasCoverage) {
    await repairLatestPromotableSandboxLayerForSourceProfile(env, {
      sourceId: source.id,
      resourceProfileKey: targetProfile.key,
      reason: "repo_assignment_validation_missing_profile_artifact",
    });
    hasCoverage = await hasSandboxLayerActiveArtifactForSourceProfile(env.DB, {
      businessId: input.businessId,
      sourceId: source.id,
      resourceProfileKey: targetProfile.key,
    });
  }
  const row = await upsertSandboxLayerRepoSourceAssignment(env.DB, {
    businessId: input.businessId,
    targetRepoOwner: targetRepo.owner,
    targetRepoName: targetRepo.name,
    sourceId: source.id,
    userId: numericUserId(auth),
    nowMs: Date.now(),
  });
  return {
    assignment: {
      targetRepo: `${row.target_repo_owner}/${row.target_repo_name}`,
      sourceRepo: `${source.repo_owner}/${source.repo_name}`,
      manifestPath: source.manifest_path,
      sourceId: row.source_id,
      updatedAt: row.updated_at,
      coverage: {
        resourceProfileKey: targetProfile.key,
        hasActiveArtifact: hasCoverage,
        missCode: hasCoverage ? null : "source_missing_active_artifact_for_profile",
      },
    },
  };
}

export async function clearSandboxLayerRepoSourceAssignment(
  env: Env,
  auth: AuthInfo,
  input: { businessId: string; targetRepoOwner: string; targetRepoName: string },
) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  const targetRepo = normalizeRepo(input.targetRepoOwner, input.targetRepoName);
  return {
    deleted: await deleteSandboxLayerRepoSourceAssignment(env.DB, {
      businessId: input.businessId,
      targetRepoOwner: targetRepo.owner,
      targetRepoName: targetRepo.name,
    }),
  };
}

export async function resolveAndRepairSandboxLayer(
  env: Env,
  auth: AuthInfo,
  input: { businessId: string; repoOwner: string; repoName: string },
) {
  await assertBusinessAdminAccess(env, auth, input.businessId);
  const repo = normalizeRepo(input.repoOwner, input.repoName);
  const resolution = await resolveSandboxLayerForSession({
    db: env.DB,
    env,
    businessId: input.businessId,
    repoOwner: repo.owner,
    repoName: repo.name,
    runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
    repairActiveArtifacts: canRepairSandboxLayerActiveArtifacts(auth),
  });
  const resourceProfileKey =
    resolution.resourceProfileKey ?? resolveSandboxLayerResourceProfile(env, repo.owner, repo.name).key;
  const selectedBuild = resolution.artifact
    ? await getSandboxLayerBuildWithSourceAndCreator(env.DB, resolution.artifact.build_id)
    : null;
  const currentBase = await resolveCurrentSandboxBaseTemplateForProfile(env, { resourceProfileKey }).catch(() => null);
  const latestRepoBuild = await getLatestSandboxLayerBuildForRepo(env.DB, {
    businessId: input.businessId,
    repoOwner: repo.owner,
    repoName: repo.name,
    manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
    resourceProfileKey,
  });
  return {
    repo: `${repo.owner}/${repo.name}`,
    resourceProfileKey: resolution.resourceProfileKey,
    selected: resolution.artifact
      ? {
          tier: resolution.selectedTier,
          sourceRepo: `${resolution.artifact.repo_owner}/${resolution.artifact.repo_name}`,
          sourceId: resolution.artifact.source_id,
          buildId: resolution.artifact.build_id,
          providerArtifactRef: resolution.artifact.provider_artifact_ref,
        }
      : null,
    selection:
      resolution.artifact && selectedBuild
        ? {
            tier: resolution.selectedTier,
            sourceRepo: `${resolution.artifact.repo_owner}/${resolution.artifact.repo_name}`,
            sourceId: resolution.artifact.source_id,
            buildId: resolution.artifact.build_id,
            templateId: resolution.artifact.provider_artifact_ref,
            commitSha: resolution.artifact.commit_sha,
            resourceProfileKey: resolution.artifact.resource_profile_key,
            manifestPath: resolution.artifact.manifest_path,
            layerPath: selectedBuild.layer_path,
            baseTemplateRef: selectedBuild.base_template_ref,
            baseVersion: selectedBuild.base_version,
            currentBaseVersion: currentBase?.baseVersion ?? null,
            baseSource: currentBase?.source ?? "env_fallback",
            baseVersionQuality: currentBase?.versionQuality ?? "unversioned",
            baseStatus:
              currentBase &&
              currentBase.baseTemplateRef === selectedBuild.base_template_ref &&
              currentBase.baseVersion === selectedBuild.base_version
                ? "active"
                : "outdated",
            builtAt: selectedBuild.completed_at ?? resolution.artifact.created_at,
            activeUpdatedAt: resolution.artifact.active_updated_at,
            createdBy: formatBuildActor(selectedBuild),
            smokeStatus: selectedBuild.smoke_result_json ? readSmokeStatus(selectedBuild.smoke_result_json) : null,
          }
        : null,
    misses: resolution.misses.map(formatMiss),
    latestRepoBuild: latestRepoBuild ? formatLatestBuild(latestRepoBuild) : null,
    fallback: resolution.artifact
      ? null
      : {
          reason: latestRepoBuild?.status === "failed" ? "custom_sandbox_failed" : "no_sandbox_layer_selected",
          templateId: readFallbackRuntimeTemplateId(env, repo.owner, repo.name),
        },
  };
}

async function validateAssignmentSource(
  env: Env,
  auth: AuthInfo,
  businessId: string,
  input: SandboxLayerAssignmentSourceInput,
  label: "source",
) {
  const sourceRepo = normalizeRepo(input.sourceRepoOwner, input.sourceRepoName);
  const manifestPath = normalizeManifestPath(input.manifestPath);
  await assertRepoGate(env, auth, sourceRepo.owner, sourceRepo.name, label);
  const source = await getAssignableSandboxLayerSourceByRepoPath(env.DB, {
    businessId,
    repoOwner: sourceRepo.owner,
    repoName: sourceRepo.name,
    manifestPath,
  });
  if (!source) {
    if (
      await hasSandboxLayerSourceInAnotherBusiness(env.DB, {
        businessId,
        repoOwner: sourceRepo.owner,
        repoName: sourceRepo.name,
        manifestPath,
      })
    ) {
      throw new SandboxLayerAssignmentError(
        "source_wrong_business",
        "Sandbox layer source belongs to another business",
        403,
      );
    }
    throw new SandboxLayerAssignmentError("source_not_built", "Sandbox layer source has not been built", 404);
  }
  if (source.status !== "active") {
    throw new SandboxLayerAssignmentError("source_not_active", "Sandbox layer source is not active", 409);
  }
  if (!(await hasSandboxLayerActiveArtifactForSource(env.DB, { businessId, sourceId: source.id }))) {
    await repairLatestPromotableSandboxLayerForSource(env, {
      sourceId: source.id,
      reason: "assignment_validation_missing_active_artifact",
    });
    const repairedSource = await getAssignableSandboxLayerSourceByRepoPath(env.DB, {
      businessId,
      repoOwner: sourceRepo.owner,
      repoName: sourceRepo.name,
      manifestPath,
    });
    if (repairedSource) {
      source.active_artifact_count = repairedSource.active_artifact_count;
      source.latest_active_artifact_ref = repairedSource.latest_active_artifact_ref;
      source.latest_active_build_id = repairedSource.latest_active_build_id;
    }
    if (!(await hasSandboxLayerActiveArtifactForSource(env.DB, { businessId, sourceId: source.id }))) {
      throw new SandboxLayerAssignmentError(
        "source_has_no_active_artifact",
        "Sandbox layer source has no active artifact",
        409,
      );
    }
  }
  return source;
}

async function assertBusinessAdminAccess(env: Env, auth: AuthInfo, businessId: string): Promise<void> {
  if (auth.canAccessAllSessions) return;
  if (!auth.user?.businessId || auth.user.businessId !== businessId) {
    throw new SandboxLayerAssignmentError("business_context_required", "Business context is required", 403);
  }
  const userId = Number(auth.userId);
  if (!Number.isFinite(userId) || !(await isBusinessAdmin(env.DB, userId, businessId))) {
    throw new SandboxLayerAssignmentError("business_admin_required", "Business admin access is required", 403);
  }
}

async function assertRepoGate(
  env: Env,
  auth: AuthInfo,
  owner: string,
  repo: string,
  label: "source" | "target",
): Promise<void> {
  const gate = await verifyRepoAccessAndInstallation(env.DB, auth, owner, repo, {
    githubTokenEnv: env,
    reposCacheEnv: env,
  });
  if (gate.ok) return;
  throw new SandboxLayerAssignmentError(
    label === "source" ? "source_repo_access_denied" : "target_repo_access_denied",
    `${label === "source" ? "Source" : "Target"} repository access denied`,
    gate.response.status === 503 ? 503 : 403,
  );
}

function normalizeRepo(owner: unknown, name: unknown): { owner: string; name: string } {
  if (typeof owner !== "string" || typeof name !== "string") {
    throw new SandboxLayerAssignmentError("invalid_repo", "Repository is invalid", 400);
  }
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  const segmentPattern = /^[a-z0-9_.-]{1,100}$/;
  if (
    !segmentPattern.test(normalizedOwner) ||
    !segmentPattern.test(normalizedName) ||
    normalizedOwner === "." ||
    normalizedOwner === ".." ||
    normalizedName === "." ||
    normalizedName === ".."
  ) {
    throw new SandboxLayerAssignmentError("invalid_repo", "Repository is invalid", 400);
  }
  return { owner: normalizedOwner, name: normalizedName };
}

function normalizeManifestPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : SANDBOX_LAYER_MANIFEST_PATH;
  try {
    return validateRepoRelativeCycloidPath(raw, "manifestPath");
  } catch (err) {
    throw new SandboxLayerAssignmentError(
      "invalid_manifest_path",
      err instanceof Error ? err.message : "Manifest path is invalid",
      400,
    );
  }
}

function numericUserId(auth: AuthInfo): number {
  const parsed = Number(auth.userId);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMiss(miss: SandboxLayerSessionResolutionMiss): {
  tier: SandboxLayerSelectionTier;
  code: string;
  sourceId?: string;
} {
  return {
    tier: miss.tier,
    code: miss.code,
    ...(miss.sourceId ? { sourceId: miss.sourceId } : {}),
  };
}

function formatLatestBuild(build: NonNullable<Awaited<ReturnType<typeof getLatestSandboxLayerBuildForRepo>>>) {
  return {
    id: build.id,
    status: build.status,
    error: build.error,
    commitSha: build.commit_sha,
    templateId: build.provider_artifact_ref ?? build.provider_template_ref,
    baseTemplateRef: build.base_template_ref,
    baseVersion: build.base_version,
    createdBy: formatBuildActor(build),
    resourceProfileKey: build.resource_profile_key,
    manifestPath: build.manifest_path,
    layerPath: build.layer_path,
    createdAt: build.created_at,
    updatedAt: build.completed_at ?? build.started_at ?? build.created_at,
    smoke: build.smoke_result_json ? readSmokeSummary(build.smoke_result_json) : null,
  };
}

function formatBuildActor(build: {
  created_by_user_id: number;
  created_by_login?: string | null;
  created_by_name?: string | null;
}) {
  return {
    userId: build.created_by_user_id,
    login: build.created_by_login ?? null,
    name: build.created_by_name ?? null,
  };
}

function readSmokeSummary(smokeResultJson: string): {
  status: "passed" | "failed" | null;
  command: string | null;
  exitCode: number | null;
  reason: string | null;
} | null {
  const parsed = parseSmokeResult(smokeResultJson);
  if (!parsed) return null;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const failedResult = results.find((result) => {
    if (!result || typeof result !== "object") return false;
    const exitCode = (result as Record<string, unknown>).exitCode;
    return typeof exitCode === "number" && exitCode !== 0;
  }) as Record<string, unknown> | undefined;
  const command = readString(parsed.command) ?? readString(failedResult?.command) ?? null;
  const exitCode = readNumber(parsed.exitCode) ?? readNumber(failedResult?.exitCode) ?? null;
  const reason =
    readString(parsed.message) ??
    readString(parsed.reason) ??
    readString(failedResult?.stderr) ??
    readString(failedResult?.stdout) ??
    readString(parsed.error) ??
    null;
  return {
    status: parsed.ok === true ? "passed" : parsed.ok === false ? "failed" : null,
    command,
    exitCode,
    reason,
  };
}

function readFallbackRuntimeTemplateId(env: Env, repoOwner: string, repoName: string): string | null {
  try {
    return resolveRepoSandboxSpec(env, repoOwner, repoName).runtimeTemplateId;
  } catch {
    return null;
  }
}
