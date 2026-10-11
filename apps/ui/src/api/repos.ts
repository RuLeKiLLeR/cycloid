import { z } from "zod";

import type { SsoOrg } from "../../../../shared/types/bootstrap";
import type { Repo } from "../types";
import { apiCacheKeys, invalidate, swr } from "./cache";
import { requestJson as apiRequestJson } from "./client";

type ReposResponse = { repos: Repo[]; ssoOrgs: SsoOrg[] };

const repoFilesResponseSchema = z.object({
  files: z.array(z.string()),
});

/**
 * `refresh: true` bypasses the server caches (`?refresh=1`), forcing a fresh
 * `/user/repos` fetch. Use sparingly: it spends the user's GitHub API rate
 * limit, so callers must debounce/disable the control while a refresh is in
 * flight.
 */
export async function fetchRepos(options?: { refresh?: boolean }): Promise<ReposResponse> {
  const path = options?.refresh ? "/api/repos?refresh=1" : "/api/repos";
  const result = await swr(
    apiCacheKeys.repos(options),
    () => apiRequestJson<ReposResponse>(path, undefined, "Failed to fetch repos"),
    { staleMs: 30_000, force: options?.refresh },
  );
  if (options?.refresh) invalidate(apiCacheKeys.repos());
  return result.value;
}

export async function fetchRepoFiles(owner: string, repo: string, branch: string): Promise<string[]> {
  const path = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/files?branch=${encodeURIComponent(branch)}`;
  const data = await apiRequestJson(path, undefined, "Failed to fetch repository files", {
    schema: repoFilesResponseSchema,
  });
  return data.files;
}

export async function fetchInstallUrl(): Promise<string> {
  const data = await apiRequestJson<{ url: string }>(
    "/api/github/install-url",
    undefined,
    "Failed to fetch install URL",
  );
  return data.url;
}
