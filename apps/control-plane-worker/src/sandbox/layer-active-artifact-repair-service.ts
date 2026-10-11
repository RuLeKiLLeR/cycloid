import { createLogger } from "../logger";
import type { AuthInfo, Env } from "../types";
import {
  getNewestCompletedPromotableSandboxLayerBuildForSource,
  getNewestCompletedPromotableSandboxLayerBuildForSourceProfile,
  getSandboxLayerSourceByRepoPath,
} from "./layer-db";
import { SANDBOX_LAYER_MANIFEST_PATH } from "./layer-parser";
import { ensureCompletedDefaultBranchBuildPromoted } from "./layer-provider-build-service";
import { E2B_CLOUD_RUNTIME_BACKEND } from "./runtime-backend";

const log = createLogger({ bindings: { component: "sandbox-layer-active-artifact-repair-service" } });

export function canRepairSandboxLayerActiveArtifacts(auth: AuthInfo): boolean {
  if (auth.readOnly) return false;
  if (auth.authMode === "cli_token") return auth.cliTokenScope === "write";
  return true;
}

export async function repairLatestPromotableSandboxLayerForRepoProfile(
  env: Env,
  input: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    resourceProfileKey: string;
    reason: string;
  },
): Promise<string | null> {
  const source = await getSandboxLayerSourceByRepoPath(env.DB, {
    businessId: input.businessId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
  });
  if (!source || source.status !== "active") return null;
  return repairLatestPromotableSandboxLayerForSourceProfile(env, {
    sourceId: source.id,
    resourceProfileKey: input.resourceProfileKey,
    reason: input.reason,
  });
}

export async function tryRepairLatestPromotableSandboxLayerForRepoProfile(
  env: Env,
  input: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    resourceProfileKey: string;
    reason: string;
  },
): Promise<string | null> {
  try {
    return await repairLatestPromotableSandboxLayerForRepoProfile(env, input);
  } catch (error) {
    log.warn(
      {
        businessId: input.businessId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        resourceProfileKey: input.resourceProfileKey,
        reason: input.reason,
        error: String(error),
      },
      "Skipped sandbox layer active artifact repair during resolution",
    );
    return null;
  }
}

export async function repairLatestPromotableSandboxLayerForSourceProfile(
  env: Env,
  input: { sourceId: string; resourceProfileKey: string; reason: string },
): Promise<string | null> {
  const build = await getNewestCompletedPromotableSandboxLayerBuildForSourceProfile(env.DB, {
    sourceId: input.sourceId,
    resourceProfileKey: input.resourceProfileKey,
    provider: "e2b",
    runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
  });
  if (!build) return null;
  const activeTemplateRef = await ensureCompletedDefaultBranchBuildPromoted(env, build.id);
  if (activeTemplateRef) {
    log.info(
      {
        sourceId: input.sourceId,
        resourceProfileKey: input.resourceProfileKey,
        buildId: build.id,
        activeTemplateRef,
        reason: input.reason,
      },
      "Repaired sandbox layer active artifact before read",
    );
    return activeTemplateRef;
  }
  log.warn(
    {
      sourceId: input.sourceId,
      resourceProfileKey: input.resourceProfileKey,
      buildId: build.id,
      reason: input.reason,
    },
    "Unable to repair sandbox layer active artifact before read",
  );
  return null;
}

export async function tryRepairLatestPromotableSandboxLayerForSourceProfile(
  env: Env,
  input: { sourceId: string; resourceProfileKey: string; reason: string },
): Promise<string | null> {
  try {
    return await repairLatestPromotableSandboxLayerForSourceProfile(env, input);
  } catch (error) {
    log.warn(
      {
        sourceId: input.sourceId,
        resourceProfileKey: input.resourceProfileKey,
        reason: input.reason,
        error: String(error),
      },
      "Skipped sandbox layer active artifact repair during resolution",
    );
    return null;
  }
}

export async function repairLatestPromotableSandboxLayerForSource(
  env: Env,
  input: { sourceId: string; reason: string },
): Promise<string | null> {
  const build = await getNewestCompletedPromotableSandboxLayerBuildForSource(env.DB, {
    sourceId: input.sourceId,
    provider: "e2b",
    runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
  });
  if (!build) return null;
  const activeTemplateRef = await ensureCompletedDefaultBranchBuildPromoted(env, build.id);
  if (activeTemplateRef) {
    log.info(
      {
        sourceId: input.sourceId,
        resourceProfileKey: build.resource_profile_key,
        buildId: build.id,
        activeTemplateRef,
        reason: input.reason,
      },
      "Repaired sandbox layer active artifact before read",
    );
    return activeTemplateRef;
  }
  log.warn(
    {
      sourceId: input.sourceId,
      resourceProfileKey: build.resource_profile_key,
      buildId: build.id,
      reason: input.reason,
    },
    "Unable to repair sandbox layer active artifact before read",
  );
  return null;
}

export async function tryRepairLatestPromotableSandboxLayerForSource(
  env: Env,
  input: { sourceId: string; reason: string },
): Promise<string | null> {
  try {
    return await repairLatestPromotableSandboxLayerForSource(env, input);
  } catch (error) {
    log.warn(
      {
        sourceId: input.sourceId,
        reason: input.reason,
        error: String(error),
      },
      "Skipped sandbox layer active artifact repair during resolution",
    );
    return null;
  }
}
