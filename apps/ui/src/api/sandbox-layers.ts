import { z } from "zod";

import { JSON_HEADERS, requestJson, requestJson as requestValidatedJson } from "./client";

type SandboxLayerResolutionMiss = {
  tier: "repo_local" | "repo_assignment" | "business_default";
  code: string;
  sourceId?: string;
};

export type SandboxLayerSelectionDetails = {
  tier: "repo_local" | "repo_assignment" | "business_default";
  sourceRepo: string;
  sourceId: string;
  buildId: string;
  templateId: string;
  commitSha: string;
  resourceProfileKey: string;
  manifestPath: string;
  layerPath: string;
  baseTemplateRef: string;
  baseVersion: string;
  currentBaseVersion: string | null;
  baseSource: "registry" | "env_fallback";
  baseVersionQuality: "versioned" | "unversioned";
  baseStatus: "active" | "outdated";
  createdBy: SandboxLayerBuildActor;
  builtAt: number;
  activeUpdatedAt: number;
  smokeStatus: "passed" | "failed" | null;
};

export type SandboxLayerBuildActor = {
  userId: number;
  login: string | null;
  name: string | null;
};

export type SandboxLayerLatestBuild = {
  id: string;
  status: string;
  error: string | null;
  commitSha: string;
  templateId: string | null;
  baseTemplateRef: string;
  baseVersion: string;
  createdBy: SandboxLayerBuildActor;
  resourceProfileKey: string;
  manifestPath: string;
  layerPath: string;
  createdAt: number;
  updatedAt: number;
  smoke: {
    status: "passed" | "failed" | null;
    command: string | null;
    exitCode: number | null;
    reason: string | null;
  } | null;
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

export type SandboxLayerBuildHistoryItem = {
  id: string;
  status: string;
  sourceRepo: string;
  commitSha: string;
  resourceProfileKey: string;
  templateId: string | null;
  baseTemplateRef: string;
  baseVersion: string;
  baseSource: "registry" | "env_fallback";
  baseVersionQuality: "versioned" | "unversioned";
  createdBy: SandboxLayerBuildActor;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  smokeStatus: "passed" | "failed" | null;
  failureSummary: SandboxLayerFailureSummary | null;
};

export type SandboxLayerBuildLogChunk = {
  id: string;
  build_id: string;
  sequence: number;
  message: string;
  created_at: number;
};

export type SandboxLayerBuildRequest = {
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
  baseSource: "registry" | "env_fallback";
  baseVersionQuality: "versioned" | "unversioned";
  resourceProfileKey: string;
  promotionEligibility: "default_branch_head" | "non_default_ref" | "unknown";
  willPromote?: number;
  providerArtifactRef?: string | null;
  activeTemplateRef?: string | null;
  createdBy: SandboxLayerBuildActor;
  failureSummary?: SandboxLayerFailureSummary | null;
};

// Mirrors SandboxLayerBuildActor / SandboxLayerFailureSummary /
// SandboxLayerBuildRequestEnvelope from the control plane's
// sandbox/layer-source-service.ts. Both success branches of
// POST .../sandbox-layer/build-requests (fresh resolve and idempotent replay)
// serialize through formatBuildRequest(), which always emits the full envelope;
// `willPromote`, `providerArtifactRef`, `activeTemplateRef`, and
// `failureSummary` are the envelope's optional/nullable fields.
const sandboxLayerBuildActorSchema = z.object({
  userId: z.number(),
  login: z.string().nullable(),
  name: z.string().nullable(),
});

const sandboxLayerFailureSummarySchema = z.object({
  phase: z.enum(["validation", "provider_build", "smoke", "runtime", "unknown"]),
  reason: z.string(),
  command: z.string().optional(),
  commandIndex: z.number().optional(),
  exitCode: z.number().optional(),
  stdoutPreview: z.string().optional(),
  stderrPreview: z.string().optional(),
  activeTemplateUnchanged: z.boolean(),
});

const sandboxLayerBuildRequestSchema = z.object({
  id: z.string(),
  status: z.string(),
  repo: z.string(),
  sourceRepo: z.string(),
  targetRepo: z.string(),
  requestedRef: z.string(),
  commitSha: z.string(),
  manifestPath: z.string(),
  layerPath: z.string(),
  sourceContentHash: z.string(),
  baseTemplateRef: z.string(),
  baseVersion: z.string(),
  baseSource: z.enum(["registry", "env_fallback"]),
  baseVersionQuality: z.enum(["versioned", "unversioned"]),
  resourceProfileKey: z.string(),
  promotionEligibility: z.enum(["default_branch_head", "non_default_ref", "unknown"]),
  willPromote: z.number().optional(),
  providerArtifactRef: z.string().nullable().optional(),
  activeTemplateRef: z.string().nullable().optional(),
  createdBy: sandboxLayerBuildActorSchema,
  failureSummary: sandboxLayerFailureSummarySchema.nullable().optional(),
});

export type CreateSandboxLayerBuildRequestInput = {
  manifestPath?: string;
  targetRepo?: { owner: string; name: string };
  idempotencyKey: string;
};

export type SandboxLayerAssignmentSource = {
  sourceRepoOwner: string;
  sourceRepoName: string;
  manifestPath?: string;
};

export type SandboxLayerBusinessDefaultAssignment = {
  sourceRepo: string;
  manifestPath: string;
  sourceId: string;
  latestActiveBuildId: string | null;
  latestActiveArtifactRef: string | null;
  updatedAt: number;
};

export type SandboxLayerRepoSourceAssignment = SandboxLayerBusinessDefaultAssignment & {
  targetRepo: string;
};

export type SandboxLayerAssignments = {
  businessDefault: SandboxLayerBusinessDefaultAssignment | null;
  repoAssignments: SandboxLayerRepoSourceAssignment[];
};

export type SandboxLayerResolutionPreview = {
  repo: string;
  resourceProfileKey: string | null;
  selected: {
    tier: "repo_local" | "repo_assignment" | "business_default";
    sourceRepo: string;
    sourceId: string;
    buildId: string;
    providerArtifactRef: string;
  } | null;
  selection: SandboxLayerSelectionDetails | null;
  misses: SandboxLayerResolutionMiss[];
  latestRepoBuild: SandboxLayerLatestBuild | null;
  fallback: { reason: string; templateId: string | null } | null;
};

export async function fetchSandboxLayerAssignments(businessId: string): Promise<SandboxLayerAssignments> {
  const data = await requestJson<{ ok: true } & SandboxLayerAssignments>(
    `/api/businesses/${businessId}/sandbox-layer/assignments`,
    undefined,
    "Failed to load sandbox defaults",
  );
  return {
    businessDefault: data.businessDefault ?? null,
    repoAssignments: data.repoAssignments ?? [],
  };
}

export async function setSandboxLayerBusinessDefaultSource(
  businessId: string,
  source: SandboxLayerAssignmentSource,
): Promise<SandboxLayerBusinessDefaultAssignment> {
  const data = await requestJson<{ ok: true; assignment: SandboxLayerBusinessDefaultAssignment }>(
    `/api/businesses/${businessId}/sandbox-layer/default-source`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(source),
    },
    "Failed to update sandbox default",
  );
  return data.assignment;
}

export async function clearSandboxLayerBusinessDefaultSource(businessId: string): Promise<void> {
  await requestJson<{ ok: true; deleted: boolean }>(
    `/api/businesses/${businessId}/sandbox-layer/default-source`,
    { method: "DELETE" },
    "Failed to clear sandbox default",
  );
}

export async function fetchSandboxLayerResolutionPreview(
  businessId: string,
  repoOwner: string,
  repoName: string,
): Promise<SandboxLayerResolutionPreview> {
  const data = await requestJson<{ ok: true } & SandboxLayerResolutionPreview>(
    `/api/businesses/${businessId}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/sandbox-layer/resolution`,
    undefined,
    "Failed to load sandbox environment",
  );
  return data;
}

export async function createSandboxLayerBuildRequest(
  businessId: string,
  sourceRepoOwner: string,
  sourceRepoName: string,
  input: CreateSandboxLayerBuildRequestInput,
): Promise<SandboxLayerBuildRequest> {
  const { idempotencyKey, ...body } = input;
  const data = await requestValidatedJson(
    `/api/businesses/${businessId}/repos/${encodeURIComponent(sourceRepoOwner)}/${encodeURIComponent(sourceRepoName)}/sandbox-layer/build-requests`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
    "Failed to rebuild sandbox environment",
    { schema: z.object({ ok: z.literal(true), buildRequest: sandboxLayerBuildRequestSchema }) },
  );
  return data.buildRequest;
}

export async function fetchSandboxLayerBuildHistory(
  businessId: string,
  options: { sourceRepo?: string | null; targetRepo?: string | null; status?: string | null; limit?: number } = {},
): Promise<SandboxLayerBuildHistoryItem[]> {
  const params = new URLSearchParams();
  if (options.sourceRepo) params.set("sourceRepo", options.sourceRepo);
  if (options.targetRepo) params.set("targetRepo", options.targetRepo);
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await requestJson<{ ok: true; builds: SandboxLayerBuildHistoryItem[] }>(
    `/api/businesses/${businessId}/sandbox-layer/build-requests${suffix}`,
    undefined,
    "Failed to load sandbox build history",
  );
  return data.builds;
}

export async function fetchSandboxLayerBuildLogs(
  businessId: string,
  buildId: string,
  options: { afterSequence?: number | null; limit?: number | null } = {},
): Promise<SandboxLayerBuildLogChunk[]> {
  const params = new URLSearchParams();
  if (options.afterSequence != null) params.set("afterSequence", String(options.afterSequence));
  if (options.limit != null) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await requestJson<{ ok: true; logs: SandboxLayerBuildLogChunk[] }>(
    `/api/businesses/${businessId}/sandbox-layer/build-requests/${encodeURIComponent(buildId)}/logs${suffix}`,
    undefined,
    "Failed to load sandbox build logs",
  );
  return data.logs;
}
