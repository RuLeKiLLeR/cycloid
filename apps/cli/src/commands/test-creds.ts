import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { parseGithubRepoFullName } from "../../../../shared/github/repo-url.js";
import { apiFetch } from "../api.js";
import { CliError } from "../errors.js";
import { confirmOrThrow, emit, isJson, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

interface RepoArg {
  owner: string;
  name: string;
}

export function parseRepoArg(value: string): RepoArg {
  const parsed = parseGithubRepoFullName(value);
  if (!parsed) throw new CliError("user", "repo must be owner/name or a GitHub URL");
  return { owner: parsed.owner, name: parsed.repo };
}

function basePath(businessId: string, repo: RepoArg): string {
  return `/api/businesses/${encodeURIComponent(businessId)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/test-credentials`;
}

function readValue(options: { value?: string; valueFile?: string; valueStdin?: boolean }): string {
  const sources = [options.value, options.valueFile, options.valueStdin].filter((v) => v !== undefined && v !== false);
  if (sources.length !== 1) {
    throw new CliError("user", "Provide exactly one of --value, --value-file, or --value-stdin.");
  }
  if (options.value !== undefined) return options.value;
  // Strip exactly one trailing newline from file/stdin reads so that
  // `echo $SECRET | cycloid test-creds set ... --value-stdin` stores
  // "$SECRET" rather than "$SECRET\n". The shell's `echo` always appends
  // a newline, and customer-managed `cat secret-file.txt` similarly tends
  // to end in one. Stripping just one keeps embedded newlines intact for
  // the rare multi-line credential.
  const raw = options.valueFile ? readFileSync(options.valueFile, "utf8") : readFileSync(0, "utf8");
  return raw.replace(/\r?\n$/, "");
}

export async function listTestCredentialsCommand(
  repo: string,
  options: { business: string; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const repoArg = parseRepoArg(repo);
  const payload = await apiFetch<{
    ok: boolean;
    credentials: Array<{ name: string; updatedAt: number; rotatedByUserId: number | null }>;
  }>(config, basePath(options.business, repoArg));
  emit(command, options, payload, (listPayload) => {
    if (listPayload.credentials.length === 0) {
      console.log(`No test credentials configured for ${repoArg.owner}/${repoArg.name}.`);
      return;
    }
    for (const cred of listPayload.credentials) {
      const ts = new Date(cred.updatedAt).toISOString();
      console.log(`${cred.name}\t${ts}\t${cred.rotatedByUserId ?? "-"}`);
    }
  });
}

export async function setTestCredentialCommand(
  repo: string,
  name: string,
  options: {
    business: string;
    value?: string;
    valueFile?: string;
    valueStdin?: boolean;
    json?: boolean;
  } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const repoArg = parseRepoArg(repo);
  const value = readValue(options);
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `${basePath(options.business, repoArg)}/${encodeURIComponent(name)}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  );
  emit(command, options, payload, () =>
    console.log(`Set test credential '${name}' for ${repoArg.owner}/${repoArg.name}.`),
  );
}

export async function deleteTestCredentialCommand(
  repo: string,
  name: string,
  options: { business: string; yes?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  if (isJson(command, options) && options.yes !== true) {
    throw new CliError("user", "`test-creds delete --json` requires --yes.");
  }
  if (options.yes !== true) {
    const repoArg = parseRepoArg(repo);
    await confirmOrThrow(`Delete test credential '${name}' for ${repoArg.owner}/${repoArg.name}?`);
  }
  const { config } = resolveBusinessContext(command, options);
  const repoArg = parseRepoArg(repo);
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `${basePath(options.business, repoArg)}/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  emit(command, options, payload, () =>
    console.log(`Deleted test credential '${name}' for ${repoArg.owner}/${repoArg.name}.`),
  );
}
