// Repo context aggregate service (Wave-0 UX overhaul). Composes the injected
// context for a repo from existing D1-backed DAOs: MCP servers, secret/env-var
// NAMES (redacted — never values), sandbox setup layers, and PR-review
// settings. Read-only composition; business + repo scoped (the caller must have
// verified repo access and business membership before this runs).
//
// Deliberately NOT in D1 (documented as unavailable, never faked): detected
// instruction files (AGENTS.md/CLAUDE.md + Cycloid project/review/build
// instructions) and installed skills — both are resolved at sandbox/session
// runtime from the repo, so no persisted read exists to compose here.

import { getRepoLoginEnvBlobForRepo } from "../env-blobs/service";
import { listEnabledMcpServersForSession } from "../integrations/mcp-registry";
import { listBusinessTestCredentials } from "../integrations/test-credentials-db";
import {
  getSandboxLayerBusinessDefaultSourceDetails,
  getSandboxLayerRepoSourceAssignment,
} from "../sandbox/layer-assignment-db";
import { getUserPrReviewBotSettings } from "../settings/db";

export interface RepoContextMcpServer {
  id: string;
  name: string;
  description: string | null;
  transport: string;
  enabled: boolean;
  validationStatus: string;
  scopeType: "business" | "repositories";
  discoveredToolCount: number;
  /** Names of referenced secrets — never their values. */
  secretRefs: string[];
  /** Header name -> referenced secret name (values never resolved here). */
  headerSecretRefs: Record<string, string>;
}

export interface RepoContextAggregate {
  repo: { owner: string; name: string };
  /**
   * Instruction files are runtime-resolved from the repo (not persisted in D1),
   * so precedence cannot be projected here. Documented as unavailable.
   */
  instructionFiles: {
    available: false;
    precedenceNote: string;
    files: [];
  };
  mcpServers: RepoContextMcpServer[];
  /** Installed skills are read live from the repo (SKILL.md); not persisted in D1. */
  skills: { available: false; note: string; items: [] };
  secrets: {
    /** Per-repo test credential NAMES (redacted). */
    testCredentials: { name: string; updatedAt: number; rotatedByUserId: number | null }[];
    /** Repo runtime login env-var NAMES (redacted). */
    repoRuntimeEnvVarNames: string[];
  };
  setup: {
    /** Repo-specific sandbox layer source assignment, or null. */
    repoLayerSource: { sourceId: string; updatedAt: number } | null;
    /** Business default sandbox layer source (fallback), or null. */
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
  /** Per-user + repo PR review configuration. */
  reviewSettings: {
    expectedBots: unknown[];
    mergeConflictResolutionEnabled: boolean;
  };
}

export interface GetRepoContextInput {
  businessId: string;
  userId: number;
  repoOwner: string;
  repoName: string;
}

export async function getRepoContext(db: D1Database, input: GetRepoContextInput): Promise<RepoContextAggregate> {
  const { businessId, userId, repoOwner, repoName } = input;

  const [mcpServers, envBlob, testCredentials, repoLayer, businessDefaultLayer, reviewSettings] = await Promise.all([
    listEnabledMcpServersForSession(db, { businessId, repoOwner, repoName }),
    getRepoLoginEnvBlobForRepo(db, businessId, repoOwner, repoName),
    listBusinessTestCredentials(db, { businessId, repoOwner, repoName }),
    getSandboxLayerRepoSourceAssignment(db, { businessId, targetRepoOwner: repoOwner, targetRepoName: repoName }),
    getSandboxLayerBusinessDefaultSourceDetails(db, businessId),
    getUserPrReviewBotSettings(db, userId, repoOwner, repoName),
  ]);

  return {
    repo: { owner: repoOwner, name: repoName },
    instructionFiles: {
      available: false,
      precedenceNote:
        "Instruction files (AGENTS.md/CLAUDE.md + Cycloid project/review/build instructions) and their precedence are resolved at sandbox runtime from the repo; they are not persisted in D1.",
      files: [],
    },
    mcpServers: mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      transport: server.transport,
      enabled: server.enabled,
      validationStatus: server.validationStatus,
      scopeType: server.scope.type,
      discoveredToolCount: server.discoveredTools.length,
      secretRefs: server.secretRefs,
      headerSecretRefs: Object.fromEntries(
        Object.entries(server.headers)
          .filter(([, cfg]) => typeof cfg?.secretRef === "string")
          .map(([name, cfg]) => [name, cfg.secretRef as string]),
      ),
    })),
    skills: {
      available: false,
      note: "Installed skills are read live from the GitHub repo (SKILL.md) at request/sandbox time; not persisted in D1.",
      items: [],
    },
    secrets: {
      testCredentials,
      repoRuntimeEnvVarNames: envBlob?.keyNames ?? [],
    },
    setup: {
      repoLayerSource: repoLayer ? { sourceId: repoLayer.source_id, updatedAt: repoLayer.updated_at } : null,
      businessDefaultLayerSource: businessDefaultLayer
        ? {
            sourceId: businessDefaultLayer.source_id,
            repoOwner: businessDefaultLayer.repo_owner,
            repoName: businessDefaultLayer.repo_name,
            manifestPath: businessDefaultLayer.manifest_path,
            status: businessDefaultLayer.status,
            hasActiveArtifact: businessDefaultLayer.latest_active_artifact_ref != null,
          }
        : null,
      note: "Detailed setup/build commands (layer_instructions_json / smoke_commands_json) are not expanded here; only the assigned layer source is surfaced.",
    },
    reviewSettings: {
      expectedBots: reviewSettings.expectedBots,
      mergeConflictResolutionEnabled: reviewSettings.mergeConflictResolutionEnabled,
    },
  };
}
