import type { Command } from "commander";

import { parseGithubRepoFullName } from "../../../../shared/github/repo-url.js";
import { apiFetch } from "../api.js";
import { CliError } from "../errors.js";
import { currentRepo, type RepoRef } from "../git.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

type RepoCommandOptions = RuntimeOptions & { json?: boolean };

export function parseRepoArg(value: string | undefined): RepoRef {
  if (value === undefined) return currentRepo();
  const parsed = parseGithubRepoFullName(value);
  if (!parsed) throw new CliError("user", "repo must be owner/name or a GitHub URL");
  return { owner: parsed.owner, repo: parsed.repo };
}

export async function reposListCommand(options: RepoCommandOptions = {}, command?: Command): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const payload = await apiFetch<{ repos: Array<Record<string, unknown>>; ssoOrgs: Array<Record<string, unknown>> }>(
    config,
    "/api/repos",
  );
  emit(command, options, { repos: payload.repos, ssoOrgs: payload.ssoOrgs }, (data) => {
    for (const repo of data.repos) {
      console.log(`${String(repo.fullName ?? repo.name ?? repo.repo ?? "")}\t${String(repo.defaultBranch ?? "")}`);
    }
    if (data.ssoOrgs.length > 0) console.log(`SSO withheld orgs: ${data.ssoOrgs.length}`);
  });
}

export async function repoBranchesCommand(
  repoArg: string | undefined,
  options: RepoCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const repo = parseRepoArg(repoArg);
  await apiFetch(config, "/api/repos");
  const payload = await apiFetch<{ branches: Array<Record<string, unknown>> }>(
    config,
    `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branches`,
  );
  emit(command, options, payload, (data) => {
    for (const branch of data.branches) console.log(String(branch.name ?? branch.branch ?? ""));
  });
}

export async function repoSkillsCommand(
  repoArg: string | undefined,
  options: RepoCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const repo = parseRepoArg(repoArg);
  const payload = await apiFetch<{ skills: Array<Record<string, unknown>> }>(
    config,
    `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/skills`,
  );
  emit(command, options, payload, (data) => {
    for (const skill of data.skills) console.log(`${String(skill.name ?? "")}\t${String(skill.description ?? "")}`);
  });
}
