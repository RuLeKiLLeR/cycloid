/* eslint-disable no-console -- CLI commands print human-readable status in non-JSON mode. */
import { readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  EGRESS_ALLOWLIST_SOURCE_PATH,
  parseEgressAllowlistSourceFile,
} from "../../../../shared/egress-allowlist/parser.js";
import { parseGithubRepoFullName } from "../../../../shared/github/repo-url.js";
import { normalizeEgressDomains } from "../../../../shared/types/business-egress-policy.js";
import { apiFetch, resolveBusinessId } from "../api.js";
import { CliError } from "../errors.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

type EgressCommandOptions = RuntimeOptions & { business?: string };
type SourceSetOptions = EgressCommandOptions;
type EgressAddOptions = EgressCommandOptions & { reason?: string };

type SourceResponse = {
  ok: boolean;
  source: { sourceRepoOwner: string; sourceRepoName: string } | null;
  path: string;
  defaultBranch?: string;
  domains: string[];
};

type PullRequestResponse = {
  ok: boolean;
  addedDomains: string[];
  prUrl: string | null;
  status: "created" | "updated" | "unchanged";
};

type SyncResponse = {
  ok: boolean;
  egressAllowlist: string[];
  source: { sourceRepoOwner: string; sourceRepoName: string };
  path: string;
  defaultBranch: string;
};

export function parseRepoArg(value: string): { owner: string; repo: string } {
  const parsed = parseGithubRepoFullName(value);
  if (!parsed) throw new CliError("user", "repo must be owner/name or a GitHub URL");
  return {
    ...parsed,
    // Preserve the legacy shorthand contract while URLs and SSH remotes are
    // normalized by the shared parser itself.
    repo: /^[^/:]+\/[^/]+\.git$/.test(value.trim()) ? parsed.repo.slice(0, -4) : parsed.repo,
  };
}

export async function egressSourceSetCommand(
  sourceRepoArg: string,
  options: SourceSetOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const source = parseRepoArg(sourceRepoArg);
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/egress-allowlist/source`,
    {
      method: "PUT",
      body: JSON.stringify({ sourceRepoOwner: source.owner, sourceRepoName: source.repo }),
    },
  );
  emit(command, options, payload, () =>
    console.log(`Set egress allowlist source to ${source.owner}/${source.repo}:${EGRESS_ALLOWLIST_SOURCE_PATH}.`),
  );
}

export async function egressSourceGetCommand(options: EgressCommandOptions = {}, command?: Command): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const payload = await apiFetch<SourceResponse>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/egress-allowlist/source`,
  );
  emit(command, options, payload, (sourcePayload) => {
    if (!sourcePayload.source) {
      console.log("No egress allowlist source configured.");
      return;
    }
    console.log(
      `${sourcePayload.source.sourceRepoOwner}/${sourcePayload.source.sourceRepoName}:${sourcePayload.path} (${sourcePayload.defaultBranch ?? "default branch"})`,
    );
    console.log(`${sourcePayload.domains.length} ${sourcePayload.domains.length === 1 ? "domain" : "domains"}.`);
  });
}

export async function egressAddCommand(
  domains: string[],
  options: EgressAddOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const normalized = normalizeEgressDomains(domains, "domains");
  const payload = await apiFetch<PullRequestResponse>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/egress-allowlist/pull-request`,
    {
      method: "POST",
      body: JSON.stringify({ domains: normalized, ...(options.reason ? { reason: options.reason } : {}) }),
    },
  );
  emit(command, options, payload, (addPayload) => {
    if (addPayload.status === "unchanged") {
      console.log("All requested domains are already present in the source file.");
      return;
    }
    console.log(`Egress allowlist PR ${addPayload.status}: ${addPayload.prUrl}`);
    console.log(`Added: ${addPayload.addedDomains.join(", ")}`);
  });
}

export async function egressSyncCommand(options: EgressCommandOptions = {}, command?: Command): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const payload = await apiFetch<SyncResponse>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/egress-allowlist/sync`,
    { method: "POST" },
  );
  emit(command, options, payload, (syncPayload) =>
    console.log(
      `Applied ${syncPayload.egressAllowlist.length} egress allowlist domains from ${syncPayload.source.sourceRepoOwner}/${syncPayload.source.sourceRepoName}:${syncPayload.path}.`,
    ),
  );
}

export async function egressValidateCommand(
  path = EGRESS_ALLOWLIST_SOURCE_PATH,
  options: RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const content = readFileSync(path, "utf8");
  const domains = parseEgressAllowlistSourceFile(content, path);
  emit(command, options, { ok: true, path, domains }, (payload) => {
    console.log(`Valid egress allowlist: ${payload.path}`);
    console.log(`${payload.domains.length} ${payload.domains.length === 1 ? "domain" : "domains"}.`);
  });
}
