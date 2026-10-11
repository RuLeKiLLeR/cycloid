import {
  EGRESS_ALLOWLIST_SOURCE_PATH,
  parseEgressAllowlistSourceFile,
  serializeEgressAllowlistSourceFile,
} from "../../../../shared/egress-allowlist/parser.js";
import {
  MAX_BUSINESS_EGRESS_DOMAINS,
  normalizeEgressDomains,
} from "../../../../shared/types/business-egress-policy.js";
import type { Env } from "../types";
import { type BusinessEgressAllowlistSource, getBusinessEgressAllowlistSource } from "./db";
import { setBusinessEgressPolicy } from "./service";

type EgressAllowlistSourceResolution = {
  source: BusinessEgressAllowlistSource;
  path: string;
  defaultBranch: string;
  fileExists: boolean;
  domains: string[];
};

type EgressAllowlistPullRequestResult = {
  source: BusinessEgressAllowlistSource;
  path: string;
  defaultBranch: string;
  domains: string[];
  addedDomains: string[];
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  status: "created" | "updated" | "unchanged";
};

export class EgressAllowlistSourceError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "egress_allowlist_source_error",
  ) {
    super(message);
  }
}

export function normalizeEgressAllowlistSourceInput(input: unknown): BusinessEgressAllowlistSource {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EgressAllowlistSourceError("source must be an object");
  }
  const sourceRepoOwner = readRepoPart((input as { sourceRepoOwner?: unknown }).sourceRepoOwner, "sourceRepoOwner");
  const sourceRepoName = readRepoPart((input as { sourceRepoName?: unknown }).sourceRepoName, "sourceRepoName");
  return { sourceRepoOwner, sourceRepoName };
}

export async function resolveBusinessEgressAllowlistSourceFile(
  env: Env,
  businessId: string,
): Promise<EgressAllowlistSourceResolution> {
  const source = await requireConfiguredSource(env.DB, businessId);
  const token = await installationTokenForSource(env, source);
  const { getDefaultBranch } = await import("../github/pr.js");
  const { getFileContent } = await import("../memory/github.js");
  const defaultBranch = await getDefaultBranch(token, source.sourceRepoOwner, source.sourceRepoName);
  const content = await getFileContent(
    token,
    source.sourceRepoOwner,
    source.sourceRepoName,
    EGRESS_ALLOWLIST_SOURCE_PATH,
    defaultBranch,
  );
  return {
    source,
    path: EGRESS_ALLOWLIST_SOURCE_PATH,
    defaultBranch,
    fileExists: content !== null,
    domains: content === null ? [] : parseSourceFileContent(content),
  };
}

export async function syncBusinessEgressAllowlistFromSource(
  env: Env,
  businessId: string,
): Promise<EgressAllowlistSourceResolution> {
  const resolution = await resolveBusinessEgressAllowlistSourceFile(env, businessId);
  if (resolution.fileExists) {
    await setBusinessEgressPolicy(
      env.DB,
      businessId,
      resolution.domains.length > 0 ? { domains: resolution.domains } : null,
    );
  }
  return resolution;
}

export async function createBusinessEgressAllowlistPullRequest(
  env: Env,
  input: {
    businessId: string;
    domains: string[];
    reason?: string | null;
    actorUserId?: string | null;
  },
): Promise<EgressAllowlistPullRequestResult> {
  const source = await requireConfiguredSource(env.DB, input.businessId);
  const token = await installationTokenForSource(env, source);
  const { createPullRequest, getDefaultBranch } = await import("../github/pr.js");
  const { createOrResetRef, createOrUpdateFile, getFileContent, getRefSha } = await import("../memory/github.js");
  const defaultBranch = await getDefaultBranch(token, source.sourceRepoOwner, source.sourceRepoName);
  const baseSha = await getRefSha(token, source.sourceRepoOwner, source.sourceRepoName, `heads/${defaultBranch}`);
  const branchName = buildEgressAllowlistBranchName(input.businessId);
  const existingBranchSha = await getOptionalRefSha(
    getRefSha,
    token,
    source.sourceRepoOwner,
    source.sourceRepoName,
    `heads/${branchName}`,
  );
  const defaultContent = await getFileContent(
    token,
    source.sourceRepoOwner,
    source.sourceRepoName,
    EGRESS_ALLOWLIST_SOURCE_PATH,
    defaultBranch,
  );
  const branchContent =
    existingBranchSha !== null
      ? await getFileContent(
          token,
          source.sourceRepoOwner,
          source.sourceRepoName,
          EGRESS_ALLOWLIST_SOURCE_PATH,
          branchName,
        )
      : null;
  const baseContent = branchContent ?? defaultContent;
  const currentDomains = baseContent === null ? [] : parseSourceFileContent(baseContent);
  const requestedDomains = normalizeSourceDomains(input.domains, "domains");
  const nextDomains = normalizeSourceDomains([...currentDomains, ...requestedDomains], EGRESS_ALLOWLIST_SOURCE_PATH);
  const addedDomains = requestedDomains.filter((domain) => !currentDomains.includes(domain));

  if (addedDomains.length === 0) {
    return {
      source,
      path: EGRESS_ALLOWLIST_SOURCE_PATH,
      defaultBranch,
      domains: currentDomains,
      addedDomains: [],
      prUrl: null,
      prNumber: null,
      branchName: null,
      status: "unchanged",
    };
  }

  if (existingBranchSha === null) {
    await createOrResetRef(token, source.sourceRepoOwner, source.sourceRepoName, `refs/heads/${branchName}`, baseSha);
  }
  await createOrUpdateFile(token, source.sourceRepoOwner, source.sourceRepoName, {
    path: EGRESS_ALLOWLIST_SOURCE_PATH,
    message: "Update Cycloid egress allowlist",
    content: serializeEgressAllowlistSourceFile(nextDomains),
    branch: branchName,
  });

  const pr = await createPullRequest({
    token,
    owner: source.sourceRepoOwner,
    repo: source.sourceRepoName,
    head: branchName,
    base: defaultBranch,
    title: "Update Cycloid egress allowlist",
    body: buildEgressAllowlistPrBody({
      domains: addedDomains,
      reason: input.reason,
      actorUserId: input.actorUserId,
    }),
  });

  return {
    source,
    path: EGRESS_ALLOWLIST_SOURCE_PATH,
    defaultBranch,
    domains: nextDomains,
    addedDomains,
    prUrl: pr.prUrl,
    prNumber: pr.prNumber,
    branchName,
    status: pr.created ? "created" : "updated",
  };
}

async function requireConfiguredSource(db: D1Database, businessId: string): Promise<BusinessEgressAllowlistSource> {
  const source = await getBusinessEgressAllowlistSource(db, businessId);
  if (!source) {
    throw new EgressAllowlistSourceError("Business egress allowlist source is not configured", 404, "source_missing");
  }
  return source;
}

async function installationTokenForSource(env: Env, source: BusinessEgressAllowlistSource): Promise<string> {
  const { getInstallationByOwner } = await import("../github/installations-db.js");
  const { createScopedInstallationToken } = await import("../github/octokit.js");
  const installation = await getInstallationByOwner(env.DB, source.sourceRepoOwner);
  if (!installation || installation.suspended_at !== null) {
    throw new EgressAllowlistSourceError(
      "GitHub App is not installed for the egress allowlist source owner",
      400,
      "source_installation_missing",
    );
  }
  return createScopedInstallationToken(env, installation.installation_id, {
    repositories: [source.sourceRepoName],
    permissions: { contents: "write", pull_requests: "write" },
  });
}

async function getOptionalRefSha(
  getRefSha: (token: string, owner: string, repo: string, ref: string) => Promise<string>,
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  try {
    return await getRefSha(token, owner, repo, ref);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) return null;
    throw error;
  }
}

function buildEgressAllowlistBranchName(businessId: string): string {
  const safeBusinessId = businessId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeBusinessId) {
    throw new EgressAllowlistSourceError("businessId must contain a valid branch identifier");
  }
  return `cycloid/egress-allowlist-${safeBusinessId}`;
}

function readRepoPart(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value.trim())) {
    throw new EgressAllowlistSourceError(`${field} must be a GitHub repository owner or name`);
  }
  return value.trim();
}

function parseSourceFileContent(content: string): string[] {
  try {
    return parseEgressAllowlistSourceFile(content);
  } catch (error) {
    throw buildInvalidSourceDomainsError(error);
  }
}

function normalizeSourceDomains(entries: string[], key: string): string[] {
  try {
    return normalizeEgressDomains(entries, key);
  } catch (error) {
    throw buildInvalidSourceDomainsError(error);
  }
}

function buildInvalidSourceDomainsError(error: unknown): EgressAllowlistSourceError {
  const message =
    error instanceof Error
      ? error.message
      : `${EGRESS_ALLOWLIST_SOURCE_PATH} must contain at most ${MAX_BUSINESS_EGRESS_DOMAINS} domain names`;
  return new EgressAllowlistSourceError(message, 400, "invalid_egress_allowlist_source");
}

function buildEgressAllowlistPrBody(input: {
  domains: string[];
  reason?: string | null;
  actorUserId?: string | null;
}): string {
  const lines = [
    "Updates the Cycloid workspace egress allowlist source file.",
    "",
    "Domains:",
    ...input.domains.map((domain) => `- \`${domain}\``),
  ];
  if (input.reason?.trim()) {
    lines.push("", "Reason:", input.reason.trim());
  }
  if (input.actorUserId) {
    lines.push("", `Requested by Cycloid user ${input.actorUserId}.`);
  }
  return `${lines.join("\n")}\n`;
}
