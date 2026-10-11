import { requestJson } from "./client";

export type RepoContextInstructionFiles = {
  /** false in Wave 0 — instruction files are runtime-resolved, not persisted. */
  available: boolean;
  precedenceNote: string;
  files: Array<{ path: string; role: string; precedenceNote: string }>;
};

export type RepoContextMcpServer = {
  id: string;
  name: string;
  description: string | null;
  transport: "http" | "stdio" | "sse";
  enabled: boolean;
  validationStatus: "valid" | "untested" | "validating" | "invalid";
  scopeType: "business" | "repositories";
  discoveredToolCount: number;
  /** Names of referenced secrets only (never values). */
  secretRefs: string[];
  headerSecretRefs: Record<string, string>;
};

export type RepoContextSkills = {
  /** false in Wave 0 — skills are read live from the repo tree, not persisted. */
  available: boolean;
  note: string;
  items: Array<{ name: string; path: string }>;
};

export type RepoContextSecrets = {
  testCredentials: Array<{ name: string; updatedAt: number; rotatedByUserId: number | null }>;
  /** Env var NAMES only; encrypted values never read. */
  repoRuntimeEnvVarNames: string[];
};

export type RepoContextSetup = {
  repoLayerSource: { sourceId: string; updatedAt: number } | null;
  businessDefaultLayerSource: {
    sourceId: string;
    repoOwner: string;
    repoName: string;
    manifestPath: string;
    status: string;
    hasActiveArtifact: boolean;
  } | null;
  note: string;
};

// Mirrors the control-plane RepoContextAggregate["reviewSettings"]. There is
// no reviewTimeoutMinutes: the wait-window setting was removed product-wide,
// and rendering the absent field showed "undefined min".
export type RepoContextReviewSettings = {
  expectedBots: unknown[];
  mergeConflictResolutionEnabled: boolean;
};

export type RepoContext = {
  repo: { owner: string; name: string };
  instructionFiles: RepoContextInstructionFiles;
  mcpServers: RepoContextMcpServer[];
  skills: RepoContextSkills;
  secrets: RepoContextSecrets;
  setup: RepoContextSetup;
  reviewSettings: RepoContextReviewSettings;
};

export async function fetchRepoContext(owner: string, repo: string): Promise<RepoContext> {
  const url = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/context`;
  const response = await requestJson<{ ok: true; data: RepoContext }>(url, undefined, "Failed to fetch repo context");
  return response.data;
}
