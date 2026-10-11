import type { Env } from "../types";
import {
  tryRepairLatestPromotableSandboxLayerForRepoProfile,
  tryRepairLatestPromotableSandboxLayerForSourceProfile,
} from "./layer-active-artifact-repair-service";
import {
  getActiveSandboxLayerArtifactForSourceProfile,
  getSandboxLayerBusinessDefaultSourceForResolution,
  getSandboxLayerRepoAssignmentSource,
} from "./layer-assignment-db";
import {
  type ActiveSandboxLayerArtifactRow,
  getSandboxLayerActiveArtifactCandidateForRepo,
  getSandboxLayerActiveArtifactCandidateForRepoProfile,
  type SandboxLayerActiveArtifactDetailsRow,
} from "./layer-db";
import { SANDBOX_LAYER_MANIFEST_PATH } from "./layer-parser";
import { resolveSandboxLayerResourceProfile } from "./layer-resource-profile";
import { E2B_CLOUD_RUNTIME_BACKEND, type RuntimeBackend } from "./runtime-backend";

export type SandboxLayerSelectionTier = "repo_local" | "repo_assignment" | "business_default";

export type SandboxLayerSessionResolutionMissCode =
  | "business_missing"
  | "backend_unsupported"
  | "no_active_artifact"
  | "no_assignment"
  | "source_not_active"
  | "source_missing_active_artifact_for_profile"
  | "artifact_not_usable";

export interface SandboxLayerSessionResolutionMiss {
  tier: SandboxLayerSelectionTier;
  code: SandboxLayerSessionResolutionMissCode;
  sourceId?: string;
}

export type SandboxLayerSessionResolution =
  | {
      decision: "selected";
      selectedTier: SandboxLayerSelectionTier;
      runtimeTemplateId: string;
      artifact: ActiveSandboxLayerArtifactRow;
      resourceProfileKey: string;
      misses: SandboxLayerSessionResolutionMiss[];
    }
  | {
      decision: "not_selected";
      selectedTier: null;
      runtimeTemplateId: null;
      artifact: null;
      resourceProfileKey: string | null;
      misses: SandboxLayerSessionResolutionMiss[];
    };

export type ResolvedSandboxLayerArtifact = ActiveSandboxLayerArtifactRow;

function isUsableSessionArtifact(candidate: SandboxLayerActiveArtifactDetailsRow): boolean {
  return (
    candidate.source_status === "active" &&
    candidate.status === "active" &&
    candidate.provider === "e2b" &&
    candidate.runtime_backend === E2B_CLOUD_RUNTIME_BACKEND
  );
}

export async function resolveSandboxLayerForSession(input: {
  db: D1Database;
  env: Env;
  businessId: string | null;
  repoOwner: string;
  repoName: string;
  runtimeBackend: RuntimeBackend;
  repairActiveArtifacts?: boolean;
}): Promise<SandboxLayerSessionResolution> {
  if (!input.businessId) {
    return notSelectedResolution(null, [{ tier: "repo_local", code: "business_missing" }]);
  }

  const resourceProfile = resolveSandboxLayerResourceProfile(input.env, input.repoOwner, input.repoName);
  if (input.runtimeBackend !== E2B_CLOUD_RUNTIME_BACKEND) {
    return notSelectedResolution(resourceProfile.key, [{ tier: "repo_local", code: "backend_unsupported" }]);
  }

  const misses: SandboxLayerSessionResolutionMiss[] = [];
  const repairEnv = { ...input.env, DB: input.db };
  const shouldRepairActiveArtifacts = input.repairActiveArtifacts ?? true;
  let profileCandidate = await getSandboxLayerActiveArtifactCandidateForRepoProfile(input.db, {
    businessId: input.businessId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
    resourceProfileKey: resourceProfile.key,
  });
  if (
    shouldRepairActiveArtifacts &&
    profileCandidate &&
    !isUsableSessionArtifact(profileCandidate) &&
    profileCandidate.source_status === "active"
  ) {
    await tryRepairLatestPromotableSandboxLayerForRepoProfile(repairEnv, {
      businessId: input.businessId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      resourceProfileKey: resourceProfile.key,
      reason: "repo_local_unusable_active_artifact",
    });
    profileCandidate = await getSandboxLayerActiveArtifactCandidateForRepoProfile(input.db, {
      businessId: input.businessId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
      resourceProfileKey: resourceProfile.key,
    });
  }
  if (profileCandidate) {
    if (isUsableSessionArtifact(profileCandidate)) {
      return selectedResolution("repo_local", profileCandidate, resourceProfile.key, misses);
    }
    misses.push({ tier: "repo_local", code: "artifact_not_usable", sourceId: profileCandidate.source_id });
  } else {
    let anyProfileCandidate = await getSandboxLayerActiveArtifactCandidateForRepo(input.db, {
      businessId: input.businessId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
    });
    if (shouldRepairActiveArtifacts) {
      await tryRepairLatestPromotableSandboxLayerForRepoProfile(repairEnv, {
        businessId: input.businessId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        resourceProfileKey: resourceProfile.key,
        reason: anyProfileCandidate ? "repo_local_missing_profile_artifact" : "repo_local_missing_active_artifact",
      });
      profileCandidate = await getSandboxLayerActiveArtifactCandidateForRepoProfile(input.db, {
        businessId: input.businessId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
        resourceProfileKey: resourceProfile.key,
      });
    }
    if (profileCandidate) {
      if (isUsableSessionArtifact(profileCandidate)) {
        return selectedResolution("repo_local", profileCandidate, resourceProfile.key, misses);
      }
      misses.push({ tier: "repo_local", code: "artifact_not_usable", sourceId: profileCandidate.source_id });
    } else {
      anyProfileCandidate = await getSandboxLayerActiveArtifactCandidateForRepo(input.db, {
        businessId: input.businessId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        manifestPath: SANDBOX_LAYER_MANIFEST_PATH,
      });
      misses.push({
        tier: "repo_local",
        code: anyProfileCandidate ? "source_missing_active_artifact_for_profile" : "no_active_artifact",
        sourceId: anyProfileCandidate?.source_id,
      });
    }
  }

  const repoAssignment = await getSandboxLayerRepoAssignmentSource(input.db, {
    businessId: input.businessId,
    targetRepoOwner: input.repoOwner,
    targetRepoName: input.repoName,
  });
  const repoAssignmentResult = await resolveAssignedSourceTier(input.db, {
    env: repairEnv,
    tier: "repo_assignment",
    businessId: input.businessId,
    source: repoAssignment,
    resourceProfileKey: resourceProfile.key,
    repairActiveArtifacts: shouldRepairActiveArtifacts,
  });
  if (repoAssignmentResult.artifact) {
    return selectedResolution("repo_assignment", repoAssignmentResult.artifact, resourceProfile.key, misses);
  }
  misses.push(repoAssignmentResult.miss);

  const businessDefault = await getSandboxLayerBusinessDefaultSourceForResolution(input.db, input.businessId);
  const businessDefaultResult = await resolveAssignedSourceTier(input.db, {
    env: repairEnv,
    tier: "business_default",
    businessId: input.businessId,
    source: businessDefault,
    resourceProfileKey: resourceProfile.key,
    repairActiveArtifacts: shouldRepairActiveArtifacts,
  });
  if (businessDefaultResult.artifact) {
    return selectedResolution("business_default", businessDefaultResult.artifact, resourceProfile.key, misses);
  }
  misses.push(businessDefaultResult.miss);

  return notSelectedResolution(resourceProfile.key, misses);
}

function selectedResolution(
  tier: SandboxLayerSelectionTier,
  artifact: ActiveSandboxLayerArtifactRow,
  resourceProfileKey: string,
  misses: SandboxLayerSessionResolutionMiss[],
): SandboxLayerSessionResolution {
  return {
    decision: "selected",
    selectedTier: tier,
    runtimeTemplateId: artifact.provider_artifact_ref,
    artifact,
    resourceProfileKey,
    misses,
  };
}

function notSelectedResolution(
  resourceProfileKey: string | null,
  misses: SandboxLayerSessionResolutionMiss[],
): SandboxLayerSessionResolution {
  return {
    decision: "not_selected",
    selectedTier: null,
    runtimeTemplateId: null,
    artifact: null,
    resourceProfileKey,
    misses,
  };
}

async function resolveAssignedSourceTier(
  db: D1Database,
  input: {
    env: Env;
    tier: Exclude<SandboxLayerSelectionTier, "repo_local">;
    businessId: string;
    source: { id: string; status: string } | null;
    resourceProfileKey: string;
    repairActiveArtifacts: boolean;
  },
): Promise<
  | { artifact: ActiveSandboxLayerArtifactRow; miss?: never }
  | { artifact: null; miss: SandboxLayerSessionResolutionMiss }
> {
  if (!input.source) {
    return { artifact: null, miss: { tier: input.tier, code: "no_assignment" } };
  }
  if (input.source.status !== "active") {
    return { artifact: null, miss: { tier: input.tier, code: "source_not_active", sourceId: input.source.id } };
  }
  const artifact = await getActiveSandboxLayerArtifactForSourceProfile(db, {
    businessId: input.businessId,
    sourceId: input.source.id,
    resourceProfileKey: input.resourceProfileKey,
  });
  if (artifact) return { artifact };
  if (input.repairActiveArtifacts) {
    await tryRepairLatestPromotableSandboxLayerForSourceProfile(input.env, {
      sourceId: input.source.id,
      resourceProfileKey: input.resourceProfileKey,
      reason: `${input.tier}_missing_profile_artifact`,
    });
    const repairedArtifact = await getActiveSandboxLayerArtifactForSourceProfile(db, {
      businessId: input.businessId,
      sourceId: input.source.id,
      resourceProfileKey: input.resourceProfileKey,
    });
    if (repairedArtifact) return { artifact: repairedArtifact };
  }
  return {
    artifact: null,
    miss: {
      tier: input.tier,
      code: "source_missing_active_artifact_for_profile",
      sourceId: input.source.id,
    },
  };
}
