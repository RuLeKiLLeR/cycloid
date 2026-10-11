import { stringifyError } from "../../../../shared/utils/errors.js";
import { isBusinessAdmin } from "../business/service";
import { createInstallationToken } from "../github/octokit";
import { getDefaultBranch } from "../github/pr";
import { fetchRepoTextFileAtCommit, RepoSourceError, resolveRepoCommitSha } from "../github/repo-source";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import type { AuthInfo, Env } from "../types";
import {
  getCurrentSandboxBaseTemplate,
  resolveCurrentSandboxBaseTemplate,
  type SandboxBaseTemplateRow,
  type SandboxBaseTemplateSource,
  type SandboxBaseTemplateVersionQuality,
} from "./base-template-service";
import {
  appendSandboxLayerBuildLogChunk,
  createOrGetSandboxLayerBuild,
  getActiveSandboxLayerArtifact,
  getSandboxLayerBuildWithSourceAndCreator,
  listSandboxLayerBuildLogChunks,
  listSandboxLayerBuildsWithCreator,
  type SandboxLayerActiveArtifactDetailsRow,
  type SandboxLayerBuildDetailsWithCreatorRow,
  type SandboxLayerBuildLogChunkRow,
  type SandboxLayerBuildRow,
  type SandboxLayerBuildStatus,
  type SandboxLayerBuildSummaryWithCreatorRow,
  upsertSandboxLayerSource,
} from "./layer-db";
import {
  parseSandboxLayerManifest,
  parseSandboxLayerSource,
  SANDBOX_LAYER_COMPILER_VERSION,
  SANDBOX_LAYER_MANIFEST_PATH,
  SandboxLayerValidationError,
  validateRepoRelativeCycloidPath,
} from "./layer-parser";
import { resolveSandboxLayerResourceProfile } from "./layer-resource-profile";
import { parseSmokeResult, readNumber, readSmokeStatus, readString } from "./layer-smoke-result";
import { E2B_CLOUD_RUNTIME_BACKEND } from "./runtime-backend";

export type SandboxLayerBuildRequestErrorCode =
  | "business_context_required"
  | "business_admin_required"
  | "repo_access_denied"
  | "repo_access_unavailable"
  | "github_installation_missing"
  | "ref_not_found"
  | "source_file_missing"
  | "source_file_not_text"
  | "manifest_invalid"
  | "layer_invalid"
  | "base_template_unresolved"
  | "build_request_not_found"
  | "invalid_request";

export class SandboxLayerBuildRequestError extends Error {
  constructor(
    readonly code: SandboxLayerBuildRequestErrorCode,
    message: string,
    readonly status = 400,
    readonly diagnostics?: unknown,
  ) {
    super(message);
    this.name = "SandboxLayerBuildRequestError";
  }
}

export type SandboxLayerPromotionEligibility = "default_branch_head" | "non_default_ref" | "unknown";

export const SANDBOX_LAYER_SYSTEM_USER_ID = 0;

export interface SandboxLayerBuildRequestEnvelope {
  id: string;
  status: string;
  repo: string;
  sourceRepo: string;
  targetRepo: string;
  requestedRef: string;
  commitSha: string;
  manifestPath: string;
  layerPath: string;
  sourceContentHash: string;
  baseTemplateRef: string;
  baseVersion: string;
  baseSource: SandboxBaseTemplateSource;
  baseVersionQuality: SandboxBaseTemplateVersionQuality;
  resourceProfileKey: string;
  promotionEligibility: SandboxLayerPromotionEligibility;
  willPromote?: number;
  providerArtifactRef?: string | null;
  activeTemplateRef?: string | null;
  createdBy: SandboxLayerBuildActor;
  failureSummary?: SandboxLayerFailureSummary | null;
}

export type SandboxLayerBuildActor = {
  userId: number;
  login: string | null;
  name: string | null;
};

export type SandboxLayerFailureSummary = {
  phase: "validation" | "provider_build" | "smoke" | "runtime" | "unknown";
  reason: string;
  command?: string;
  commandIndex?: number;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  activeTemplateUnchanged: boolean;
};

export interface SandboxLayerBuildHistoryItem {
  id: string;
  status: string;
  sourceRepo: string;
  commitSha: string;
  resourceProfileKey: string;
  templateId: string | null;
  baseTemplateRef: string;
  baseVersion: string;
  baseSource: SandboxBaseTemplateSource;
  baseVersionQuality: SandboxBaseTemplateVersionQuality;
  createdBy: SandboxLayerBuildActor;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  smokeStatus: "passed" | "failed" | null;
  failureSummary: SandboxLayerFailureSummary | null;
}

export interface PrepareSandboxLayerBuildRequestInput {
  businessId: string;
  repoOwner: string;
  repoName: string;
  ref?: unknown;
  manifestPath?: unknown;
  targetRepoOwner?: unknown;
  targetRepoName?: unknown;
}

export interface ReadSandboxLayerBuildRequestInput {
  businessId: string;
  buildId: string;
}

export interface ReadSandboxLayerBuildLogsInput extends ReadSandboxLayerBuildRequestInput {
  afterSequence?: number;
  limit?: number;
}

export interface ListSandboxLayerBuildRequestsInput {
  businessId: string;
  sourceRepo?: string | null;
  targetRepo?: string | null;
  status?: string | null;
  limit?: number;
}

export async function prepareSandboxLayerBuildRequest(
  env: Env,
  auth: AuthInfo,
  input: PrepareSandboxLayerBuildRequestInput,
): Promise<{ buildRequest: SandboxLayerBuildRequestEnvelope; created: boolean }> {
  await assertBusinessAccess(env, auth, input.businessId, { requireAdmin: true });
  const repoOwner = normalizeRepoSegment(input.repoOwner, "owner");
  const repoName = normalizeRepoSegment(input.repoName, "repo");
  const targetRepoOwner =
    input.targetRepoOwner == null ? repoOwner : normalizeRepoSegment(input.targetRepoOwner, "targetRepo.owner");
  const targetRepoName =
    input.targetRepoName == null ? repoName : normalizeRepoSegment(input.targetRepoName, "targetRepo.name");
  const manifestPath = normalizeManifestPath(input.manifestPath);
  const gate = await verifyRepoAccessAndInstallation(env.DB, auth, repoOwner, repoName, {
    githubTokenEnv: env,
    reposCacheEnv: env,
  });
  if (!gate.ok) throw mapRepoGateResponse(gate.response);
  if (targetRepoOwner !== repoOwner || targetRepoName !== repoName) {
    const targetGate = await verifyRepoAccessAndInstallation(env.DB, auth, targetRepoOwner, targetRepoName, {
      githubTokenEnv: env,
      reposCacheEnv: env,
    });
    if (!targetGate.ok) throw mapRepoGateResponse(targetGate.response);
  }
  const token = await createInstallationToken(env, gate.installationId);

  let defaultBranch: string;
  try {
    defaultBranch = await getDefaultBranch(token, repoOwner, repoName);
  } catch {
    throw new SandboxLayerBuildRequestError(
      "repo_access_unavailable",
      "Unable to resolve repository default branch",
      503,
    );
  }
  const requestedRef = normalizeRequestedRef(input.ref, defaultBranch);
  const commitSha = await resolveRepoSourceCommit(token, repoOwner, repoName, requestedRef);

  const manifestText = await fetchRepoSourceText(token, repoOwner, repoName, manifestPath, commitSha);
  let manifest;
  try {
    manifest = parseSandboxLayerManifest(manifestPath, manifestText);
  } catch (err) {
    throw mapParserError(err, "manifest_invalid");
  }
  const layerText = await fetchRepoSourceText(token, repoOwner, repoName, manifest.layer.dockerfile, commitSha);

  const resourceProfile = resolveBuildResourceProfile(env, targetRepoOwner, targetRepoName);
  const base = await resolveCurrentSandboxBaseTemplate(env, {
    runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
    resourceProfileKey: resourceProfile.key,
    resourceProfile,
  });
  const baseTemplateRef = base.baseTemplateRef;
  const baseVersion = base.baseVersion;
  const parsed = await parseLayerSourceOrThrow({
    manifestPath,
    manifestText,
    layerPath: manifest.layer.dockerfile,
    layerText,
    baseTemplateRef,
    baseVersion,
  });
  const defaultBranchHeadSha = await resolveRepoSourceCommit(token, repoOwner, repoName, defaultBranch).catch(
    () => null,
  );
  const promotionEligibility: SandboxLayerPromotionEligibility =
    defaultBranchHeadSha && defaultBranchHeadSha === commitSha ? "default_branch_head" : "non_default_ref";
  const createdByUserId = resolveBuildCreatorUserId(auth);

  const source = await upsertSandboxLayerSource(env.DB, {
    id: crypto.randomUUID(),
    businessId: input.businessId,
    repoOwner,
    repoName,
    manifestPath,
    createdByUserId,
    nowMs: Date.now(),
  });
  const { row, created } = await createOrGetSandboxLayerBuild(env.DB, {
    id: crypto.randomUUID(),
    sourceId: source.id,
    commitSha,
    sourceContentHash: parsed.hashes.normalizedSourceHash,
    manifestHash: parsed.hashes.manifestHash,
    layerHash: parsed.hashes.layerHash,
    normalizedLayerHash: parsed.hashes.normalizedSourceHash,
    manifestPath,
    layerPath: parsed.manifest.layerDockerfile,
    layerInstructionsJson: JSON.stringify(parsed.layer.instructions),
    smokeCommandsJson: JSON.stringify(parsed.manifest.smokeCommands),
    baseTemplateRef,
    baseVersion,
    resourceProfileKey: resourceProfile.key,
    compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
    provider: "e2b",
    runtimeBackend: "e2b_cloud",
    initialStatus: "validated",
    requestedRef,
    promotionEligibility,
    willPromote: promotionEligibility === "default_branch_head" ? 1 : 0,
    buildReason: "manual",
    createdByUserId,
    nowMs: Date.now(),
  });
  await appendSandboxLayerBuildLogChunk(env.DB, {
    id: crypto.randomUUID(),
    buildId: row.id,
    sequence: 0,
    message: "Sandbox layer source validated.",
    nowMs: Date.now(),
  });
  if (base.source === "env_fallback") {
    await appendSandboxLayerBuildLogChunk(env.DB, {
      id: crypto.randomUUID(),
      buildId: row.id,
      sequence: 1,
      message: "Sandbox base resolved from environment fallback.",
      nowMs: Date.now(),
    });
  }
  const buildWithCreator = await getSandboxLayerBuildWithSourceAndCreator(env.DB, row.id);
  return {
    buildRequest: await formatBuildRequest(
      env.DB,
      buildWithCreator ?? row,
      repoOwner,
      repoName,
      targetRepoOwner,
      targetRepoName,
    ),
    created,
  };
}

export function resolveBuildCreatorUserId(auth: AuthInfo): number {
  const userId = Number(auth.userId);
  return Number.isFinite(userId) ? userId : SANDBOX_LAYER_SYSTEM_USER_ID;
}

export async function getSandboxLayerBuildRequest(
  env: Env,
  auth: AuthInfo,
  input: ReadSandboxLayerBuildRequestInput,
): Promise<SandboxLayerBuildRequestEnvelope> {
  const row = await getReadableBuildRequest(env, auth, input);
  return formatBuildRequest(env.DB, row, row.repo_owner, row.repo_name);
}

export async function getSandboxLayerBuildRequestLogs(
  env: Env,
  auth: AuthInfo,
  input: ReadSandboxLayerBuildLogsInput,
): Promise<SandboxLayerBuildLogChunkRow[]> {
  const row = await getReadableBuildRequest(env, auth, input);
  return listSandboxLayerBuildLogChunks(env.DB, {
    buildId: row.id,
    afterSequence: input.afterSequence,
    limit: input.limit,
  });
}

export async function listSandboxLayerBuildRequests(
  env: Env,
  auth: AuthInfo,
  input: ListSandboxLayerBuildRequestsInput,
): Promise<SandboxLayerBuildHistoryItem[]> {
  await assertBusinessAccess(env, auth, input.businessId, { requireAdmin: true });
  const sourceRepo = input.sourceRepo ? normalizeOptionalRepo(input.sourceRepo, "sourceRepo") : null;
  if (sourceRepo) {
    const gate = await verifyRepoAccessAndInstallation(env.DB, auth, sourceRepo.owner, sourceRepo.name, {
      githubTokenEnv: env,
      reposCacheEnv: env,
    });
    if (!gate.ok) throw mapRepoGateResponse(gate.response);
  }
  const targetRepo = input.targetRepo ? normalizeOptionalRepo(input.targetRepo, "targetRepo") : null;
  const resourceProfileKey = targetRepo
    ? resolveBuildResourceProfile(env, targetRepo.owner, targetRepo.name).key
    : undefined;
  const status = normalizeOptionalStatus(input.status);
  const rows = await listSandboxLayerBuildsWithCreator(env.DB, {
    businessId: input.businessId,
    sourceRepoOwner: sourceRepo?.owner,
    sourceRepoName: sourceRepo?.name,
    resourceProfileKey,
    status,
    limit: input.limit,
  });
  if (rows.length === 0) return [];
  const { activeArtifactsBySourceProfile, baseTemplatesByRuntimeProfile } = await prefetchBuildHistoryLookups(
    env.DB,
    rows,
  );
  return rows.map((row) =>
    formatBuildHistoryItem(row, { activeArtifactsBySourceProfile, baseTemplatesByRuntimeProfile }),
  );
}

async function getReadableBuildRequest(
  env: Env,
  auth: AuthInfo,
  input: ReadSandboxLayerBuildRequestInput,
): Promise<SandboxLayerBuildDetailsWithCreatorRow> {
  await assertBusinessAccess(env, auth, input.businessId, { requireAdmin: false });
  const row = await getSandboxLayerBuildWithSourceAndCreator(env.DB, input.buildId);
  if (!row || row.business_id !== input.businessId) {
    throw new SandboxLayerBuildRequestError("build_request_not_found", "Build request not found", 404);
  }
  if (!auth.canAccessAllSessions) {
    const gate = await verifyRepoAccessAndInstallation(env.DB, auth, row.repo_owner, row.repo_name, {
      githubTokenEnv: env,
      reposCacheEnv: env,
    });
    if (!gate.ok) throw new SandboxLayerBuildRequestError("build_request_not_found", "Build request not found", 404);
  }
  return row;
}

async function assertBusinessAccess(
  env: Env,
  auth: AuthInfo,
  businessId: string,
  options: { requireAdmin: boolean },
): Promise<void> {
  if (auth.canAccessAllSessions) return;
  if (!auth.user?.businessId || auth.user.businessId !== businessId) {
    throw new SandboxLayerBuildRequestError("business_context_required", "Business context is required", 403);
  }
  if (!options.requireAdmin) return;
  const userId = Number(auth.userId);
  if (!Number.isFinite(userId) || !(await isBusinessAdmin(env.DB, userId, businessId))) {
    throw new SandboxLayerBuildRequestError("business_admin_required", "Business admin access is required", 403);
  }
}

function normalizeRepoSegment(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SandboxLayerBuildRequestError("invalid_request", `${label} is invalid`, 400);
  }
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(normalized) || normalized === "." || normalized === "..") {
    throw new SandboxLayerBuildRequestError("invalid_request", `${label} is invalid`, 400);
  }
  return normalized.toLowerCase();
}

function normalizeOptionalRepo(value: string, label: string): { owner: string; name: string } {
  const [owner, name, ...rest] = value.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new SandboxLayerBuildRequestError("invalid_request", `${label} must be owner/name`, 400);
  }
  return { owner: normalizeRepoSegment(owner, `${label}.owner`), name: normalizeRepoSegment(name, `${label}.name`) };
}

function normalizeOptionalStatus(value: string | null | undefined): SandboxLayerBuildStatus | undefined {
  if (!value) return undefined;
  const statuses = new Set<SandboxLayerBuildStatus>([
    "validated",
    "queued",
    "validating",
    "building_provider",
    "polling_provider",
    "smoke_testing",
    "completed",
    "failed",
    "canceled",
  ]);
  if (!statuses.has(value as SandboxLayerBuildStatus)) {
    throw new SandboxLayerBuildRequestError("invalid_request", "status is invalid", 400);
  }
  return value as SandboxLayerBuildStatus;
}

function normalizeManifestPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : SANDBOX_LAYER_MANIFEST_PATH;
  try {
    return validateRepoRelativeCycloidPath(raw, "manifestPath");
  } catch (err) {
    throw new SandboxLayerBuildRequestError("invalid_request", stringifyError(err), 400);
  }
}

function normalizeRequestedRef(value: unknown, defaultBranch: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultBranch;
  return raw === "HEAD" ? defaultBranch : raw;
}

async function resolveRepoSourceCommit(token: string, owner: string, repo: string, ref: string): Promise<string> {
  try {
    return await resolveRepoCommitSha(token, owner, repo, ref);
  } catch (err) {
    if (err instanceof RepoSourceError) {
      throw new SandboxLayerBuildRequestError(
        err.code === "ref_not_found" ? "ref_not_found" : "repo_access_unavailable",
        err.message,
        err.status,
      );
    }
    throw err;
  }
}

async function fetchRepoSourceText(
  token: string,
  owner: string,
  repo: string,
  path: string,
  commitSha: string,
): Promise<string> {
  try {
    return await fetchRepoTextFileAtCommit(token, owner, repo, path, commitSha);
  } catch (err) {
    if (err instanceof RepoSourceError) {
      throw new SandboxLayerBuildRequestError(
        err.code === "repo_source_unavailable" ? "repo_access_unavailable" : err.code,
        err.message,
        err.status,
      );
    }
    throw err;
  }
}

function resolveBuildResourceProfile(env: Env, repoOwner: string, repoName: string) {
  try {
    return resolveSandboxLayerResourceProfile(env, repoOwner, repoName);
  } catch {
    throw new SandboxLayerBuildRequestError("base_template_unresolved", "Sandbox base template is not configured", 503);
  }
}

async function parseLayerSourceOrThrow(input: {
  manifestPath: string;
  manifestText: string;
  layerPath: string;
  layerText: string;
  baseTemplateRef: string;
  baseVersion: string;
}) {
  try {
    return await parseSandboxLayerSource({
      manifestPath: input.manifestPath,
      manifestText: input.manifestText,
      layerPath: input.layerPath,
      layerText: input.layerText,
      buildIdentity: {
        baseTemplateRef: input.baseTemplateRef,
        baseVersion: input.baseVersion,
        compilerVersion: SANDBOX_LAYER_COMPILER_VERSION,
      },
    });
  } catch (err) {
    throw mapParserError(err, "layer_invalid");
  }
}

function mapParserError(
  err: unknown,
  code: Extract<SandboxLayerBuildRequestErrorCode, "manifest_invalid" | "layer_invalid">,
): SandboxLayerBuildRequestError {
  if (err instanceof SandboxLayerValidationError) {
    return new SandboxLayerBuildRequestError(code, err.message, 400, err.issues);
  }
  return new SandboxLayerBuildRequestError(code, stringifyError(err), 400);
}

function mapRepoGateResponse(response: Response): SandboxLayerBuildRequestError {
  if (response.status === 503) {
    return new SandboxLayerBuildRequestError("repo_access_unavailable", "Unable to verify repository access", 503);
  }
  return new SandboxLayerBuildRequestError("repo_access_denied", "Repository access denied", 403);
}

async function formatBuildRequest(
  db: D1Database,
  row: SandboxLayerBuildRow & { created_by_login?: string | null; created_by_name?: string | null },
  repoOwner: string,
  repoName: string,
  targetRepoOwner?: string,
  targetRepoName?: string,
): Promise<SandboxLayerBuildRequestEnvelope> {
  const sourceRepo = `${repoOwner}/${repoName}`;
  const targetRepo = `${targetRepoOwner ?? repoOwner}/${targetRepoName ?? repoName}`;
  const activeArtifact = await getActiveSandboxLayerArtifact(db, {
    sourceId: row.source_id,
    resourceProfileKey: row.resource_profile_key,
  });
  const baseProvenance = await resolveBuildBaseProvenanceFromDb(db, row);
  return {
    id: row.id,
    status: row.status,
    repo: sourceRepo,
    sourceRepo,
    targetRepo,
    requestedRef: row.requested_ref ?? row.commit_sha,
    commitSha: row.commit_sha,
    manifestPath: row.manifest_path,
    layerPath: row.layer_path,
    sourceContentHash: row.source_content_hash,
    baseTemplateRef: row.base_template_ref,
    baseVersion: row.base_version,
    baseSource: baseProvenance.source,
    baseVersionQuality: baseProvenance.versionQuality,
    resourceProfileKey: row.resource_profile_key,
    promotionEligibility: row.promotion_eligibility ?? "unknown",
    willPromote: row.will_promote,
    providerArtifactRef: row.provider_artifact_ref,
    activeTemplateRef: activeArtifact?.provider_artifact_ref ?? null,
    createdBy: formatBuildActor(row),
    failureSummary: row.status === "failed" ? summarizeBuildFailure(row, Boolean(activeArtifact)) : null,
  };
}

type BuildHistoryLookupMaps = {
  activeArtifactsBySourceProfile: ReadonlyMap<string, SandboxLayerActiveArtifactDetailsRow>;
  baseTemplatesByRuntimeProfile: ReadonlyMap<string, SandboxBaseTemplateRow>;
};

async function prefetchBuildHistoryLookups(
  db: D1Database,
  rows: SandboxLayerBuildSummaryWithCreatorRow[],
): Promise<BuildHistoryLookupMaps> {
  const sourceIds = [...new Set(rows.map((row) => row.source_id))];
  const runtimeBackends = [...new Set(rows.map((row) => row.runtime_backend))];
  const resourceProfileKeys = [...new Set(rows.map((row) => row.resource_profile_key))];
  const sourcePlaceholders = sourceIds.map(() => "?").join(", ");
  const runtimeBackendPlaceholders = runtimeBackends.map(() => "?").join(", ");
  const resourceProfilePlaceholders = resourceProfileKeys.map(() => "?").join(", ");
  const [activeArtifactsResult, baseTemplatesResult] = await db.batch([
    db
      .prepare(
        `SELECT a.*, active.artifact_id, active.build_id AS active_build_id, active.updated_at AS active_updated_at,
                s.repo_owner, s.repo_name, s.manifest_path
         FROM sandbox_layer_active_artifacts active
         INNER JOIN sandbox_layer_artifacts a ON a.id = active.artifact_id
         INNER JOIN sandbox_layer_sources s ON s.id = active.source_id
         WHERE active.source_id IN (${sourcePlaceholders})
           AND a.status = 'active'`,
      )
      .bind(...sourceIds),
    db
      .prepare(
        `SELECT *
         FROM sandbox_base_templates
         WHERE runtime_backend IN (${runtimeBackendPlaceholders})
           AND resource_profile_key IN (${resourceProfilePlaceholders})
           AND is_current = 1`,
      )
      .bind(...runtimeBackends, ...resourceProfileKeys),
  ]);
  const rowSourceProfileKeys = new Set(rows.map((row) => sourceProfileKey(row)));
  const rowRuntimeProfileKeys = new Set(rows.map((row) => runtimeProfileKey(row)));
  return {
    activeArtifactsBySourceProfile: new Map(
      ((activeArtifactsResult.results ?? []) as SandboxLayerActiveArtifactDetailsRow[])
        .filter((artifact) => rowSourceProfileKeys.has(sourceProfileKey(artifact)))
        .map((artifact) => [sourceProfileKey(artifact), artifact]),
    ),
    baseTemplatesByRuntimeProfile: new Map(
      ((baseTemplatesResult.results ?? []) as SandboxBaseTemplateRow[])
        .filter((template) => rowRuntimeProfileKeys.has(runtimeProfileKey(template)))
        .map((template) => [runtimeProfileKey(template), template]),
    ),
  };
}

function formatBuildHistoryItem(
  row: SandboxLayerBuildSummaryWithCreatorRow,
  lookups: BuildHistoryLookupMaps,
): SandboxLayerBuildHistoryItem {
  const activeArtifact = lookups.activeArtifactsBySourceProfile.get(sourceProfileKey(row)) ?? null;
  const baseProvenance = resolveBuildBaseProvenance(row, lookups.baseTemplatesByRuntimeProfile);
  return {
    id: row.id,
    status: row.status,
    sourceRepo: `${row.repo_owner}/${row.repo_name}`,
    commitSha: row.commit_sha,
    resourceProfileKey: row.resource_profile_key,
    templateId: row.provider_artifact_ref ?? row.provider_template_ref,
    baseTemplateRef: row.base_template_ref,
    baseVersion: row.base_version,
    baseSource: baseProvenance.source,
    baseVersionQuality: baseProvenance.versionQuality,
    createdBy: formatBuildActor(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    smokeStatus: row.smoke_result_json ? readSmokeStatus(row.smoke_result_json) : null,
    failureSummary: row.status === "failed" ? summarizeBuildFailure(row, Boolean(activeArtifact)) : null,
  };
}

async function resolveBuildBaseProvenanceFromDb(
  db: D1Database,
  row: Pick<SandboxLayerBuildRow, "runtime_backend" | "resource_profile_key" | "base_template_ref" | "base_version">,
): Promise<{ source: SandboxBaseTemplateSource; versionQuality: SandboxBaseTemplateVersionQuality }> {
  const current = await getCurrentSandboxBaseTemplate(db, {
    runtimeBackend: row.runtime_backend,
    resourceProfileKey: row.resource_profile_key,
  }).catch(() => null);
  return resolveBuildBaseProvenance(row, current ? new Map([[runtimeProfileKey(current), current]]) : undefined);
}

function resolveBuildBaseProvenance(
  row: Pick<SandboxLayerBuildRow, "runtime_backend" | "resource_profile_key" | "base_template_ref" | "base_version">,
  baseTemplatesByRuntimeProfile?: ReadonlyMap<string, SandboxBaseTemplateRow>,
): { source: SandboxBaseTemplateSource; versionQuality: SandboxBaseTemplateVersionQuality } {
  const current = baseTemplatesByRuntimeProfile?.get(runtimeProfileKey(row)) ?? null;
  if (current && current.base_template_ref === row.base_template_ref && current.base_version === row.base_version) {
    return { source: "registry", versionQuality: "versioned" };
  }
  return {
    source: "env_fallback",
    versionQuality:
      row.base_version && row.base_version !== "unknown" && row.base_version !== "unversioned"
        ? "versioned"
        : "unversioned",
  };
}

function sourceProfileKey(input: { source_id: string; resource_profile_key: string }): string {
  return `${input.source_id}:${input.resource_profile_key}`;
}

function runtimeProfileKey(input: { runtime_backend: string; resource_profile_key: string }): string {
  return `${input.runtime_backend}:${input.resource_profile_key}`;
}

function formatBuildActor(
  row: Pick<SandboxLayerBuildRow, "created_by_user_id"> & {
    created_by_login?: string | null;
    created_by_name?: string | null;
  },
): SandboxLayerBuildActor {
  return {
    userId: row.created_by_user_id,
    login: row.created_by_login ?? null,
    name: row.created_by_name ?? null,
  };
}

function summarizeBuildFailure(row: SandboxLayerBuildRow, hasActiveArtifact: boolean): SandboxLayerFailureSummary {
  const smoke = row.smoke_result_json ? readSmokeSummary(row.smoke_result_json) : null;
  const error = redactKnownSecrets(row.error ?? "Build failed");
  const phase = smoke?.phase ?? phaseFromError(error);
  return {
    phase,
    reason: smoke?.reason ?? stripErrorPrefix(error) ?? "Build failed",
    ...(smoke?.command ? { command: smoke.command } : {}),
    ...(smoke?.commandIndex !== undefined ? { commandIndex: smoke.commandIndex } : {}),
    ...(smoke?.exitCode !== undefined ? { exitCode: smoke.exitCode } : {}),
    ...(smoke?.stdoutPreview ? { stdoutPreview: smoke.stdoutPreview } : {}),
    ...(smoke?.stderrPreview ? { stderrPreview: smoke.stderrPreview } : {}),
    activeTemplateUnchanged: hasActiveArtifact,
  };
}

function phaseFromError(error: string): SandboxLayerFailureSummary["phase"] {
  if (/smoke_command_failed/i.test(error)) return "smoke";
  if (/smoke_runtime_error/i.test(error)) return "runtime";
  if (/provider/i.test(error)) return "provider_build";
  if (/manifest|layer|validation|invalid/i.test(error)) return "validation";
  return "unknown";
}

function stripErrorPrefix(error: string): string {
  return error.replace(/^(provider_build_failed|provider_build_start_failed|smoke_runtime_error):/i, "").trim();
}

function readSmokeSummary(smokeResultJson: string): {
  phase: SandboxLayerFailureSummary["phase"];
  reason: string | null;
  command?: string;
  commandIndex?: number;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
} | null {
  const parsed = parseSmokeResult(smokeResultJson);
  if (!parsed || parsed.ok !== false) return null;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const failedResult = results.find((result) => {
    if (!result || typeof result !== "object") return false;
    const exitCode = (result as Record<string, unknown>).exitCode;
    return typeof exitCode === "number" && exitCode !== 0;
  }) as Record<string, unknown> | undefined;
  const command = readString(parsed.command) ?? readString(failedResult?.command);
  const commandIndex = readNumber(parsed.commandIndex) ?? readNumber(failedResult?.commandIndex);
  const exitCode = readNumber(parsed.exitCode) ?? readNumber(failedResult?.exitCode);
  const stdoutPreview = boundPreview(readString(failedResult?.stdout));
  const stderrPreview = boundPreview(readString(failedResult?.stderr));
  const reason =
    boundPreview(readString(parsed.message)) ??
    boundPreview(readString(parsed.reason)) ??
    stderrPreview ??
    stdoutPreview ??
    boundPreview(readString(parsed.error)) ??
    null;
  return {
    phase: parsed.error === "smoke_runtime_error" ? "runtime" : "smoke",
    reason,
    ...(command ? { command } : {}),
    ...(commandIndex !== undefined ? { commandIndex } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
  };
}

function boundPreview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return redactKnownSecrets(value).slice(0, 500);
}

function redactKnownSecrets(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/(?:sk-|e2b_)[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
