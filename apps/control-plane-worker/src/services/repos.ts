import { isValidGithubRepoSegment } from "../../../../shared/github/repo-url";
import type { SsoOrg } from "../../../../shared/types/bootstrap";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { getValidGithubTokenResult, type GithubTokenFailureReason } from "../auth/db";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import { GitHubRequestError } from "../github/errors";
import {
  cacheInstallationRepos,
  deleteCachedInstallationReposForUser,
  getActiveInstallationsForOwners,
  getCachedInstallationReposForInstallations,
  getInstallationsByOwnerIds,
} from "../github/installations-db";
import { fetchRepoTree } from "../github/tree";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";

export const REPOS_CACHE_KEY_PREFIX = "repos";
export const REPOS_INSTALLATIONS_VERSION_KEY = "repos:installations:version";
// Bump when the cached entry shape changes so old entries are treated as stale.
// v4 added `ssoOrgs`; a v3 entry must refetch rather than serve SSO-blind results.
// v5 changed `authorizeUrl` to the same-origin /auth/github/sso path; a v4 entry
// would serve the old github.com link that skips the OAuth re-auth chain.
export const REPOS_CACHE_SCHEMA_VERSION = 5;

const REPOS_CACHE_TTL_SECONDS = 900;
const INSTALLATION_REPOS_CACHE_TTL_MS = 900_000;
const REPOS_CACHE_BYPASS_QUERY_PARAM = "refresh";
const REPO_FILES_BRANCH_MAX_LENGTH = 200;

type GhRepo = {
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
  owner: { login: string; type: string };
};

export type RepoListItem = {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  description?: string | null;
  ownerType: "User" | "Organization";
};

type RepoCacheEntry = {
  schemaVersion: number;
  installationVersion: string;
  repos: RepoListItem[];
  ssoOrgs: SsoOrg[];
};

type RepoCacheStatus = "hit" | "miss" | "bypass" | "pending";

type InstallationReposResult = { ok: true; repos: Set<string> } | { ok: false; status: number; error: string };
type FetchAccessibleReposResult =
  | {
      ok: true;
      repos: RepoListItem[];
      ssoOrgs: SsoOrg[];
      fetchedRepoCount?: number;
      selectedInstallationCount?: number;
      selectedInstallationCacheHitCount?: number;
      selectedInstallationFailureCount?: number;
    }
  | { ok: false; status: number; error: string };

type RepoListServiceResult =
  | { ok: true; repos: RepoListItem[]; ssoOrgs: SsoOrg[]; cacheStatus: RepoCacheStatus }
  | { ok: false; status: number; error: string; tokenReason?: GithubTokenFailureReason };

// Cache-only callers (bootstrap) get this extra success arm on a usable-cache
// miss: token + cache were checked, but no GitHub repo-list fetch was made, so
// the caller defers the list to a follow-up `/api/repos` call. Discriminate on
// `repos === null`. Never returned to non-`cacheOnly` callers.
type RepoListPendingResult = { ok: true; pending: true; repos: null; ssoOrgs: SsoOrg[]; cacheStatus: "pending" };

type RepoBranchesServiceResult =
  | { ok: true; branches: string[] }
  | { ok: false; status: number; error: string; tokenReason?: GithubTokenFailureReason };

type RepoFilesServiceResult =
  { ok: true; files: string[] } | { ok: false; status: number; error: string; tokenReason?: GithubTokenFailureReason };

const GITHUB_SSO_HEADER = "x-github-sso";

/**
 * Parse the `X-GitHub-SSO` response header's `partial-results` form into the set
 * of withheld org IDs. Format: `partial-results; organizations=<id,id,...>`.
 * Lenient: scans for the `organizations=` token anywhere and ignores anything
 * non-numeric. Absent/malformed input yields an empty set (fail open: no banner
 * rather than a wrong one).
 */
export function parseSsoWithheldOrgIds(headerValue: string | null | undefined): Set<number> {
  const ids = new Set<number>();
  if (!headerValue) return ids;
  const match = /organizations=([0-9,\s]+)/i.exec(headerValue);
  if (!match) return ids;
  for (const part of match[1].split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/**
 * Map withheld org IDs to `SsoOrg` rows. IDs with a (non-suspended) installation
 * resolve to a login + authorize deep link; IDs without one keep a null login so
 * the UI shows a generic prompt (the org-login lookup is itself SSO-gated).
 */
async function resolveSsoWithheldOrgs(db: D1Database, orgIds: Set<number>): Promise<SsoOrg[]> {
  if (orgIds.size === 0) return [];
  const installations = await getInstallationsByOwnerIds(db, [...orgIds]);
  const loginByOwnerId = new Map(installations.map((row) => [row.owner_id, row.owner_login]));
  return [...orgIds].map((orgId) => {
    const login = loginByOwnerId.get(orgId) ?? null;
    return {
      orgId,
      login,
      authorizeUrl: login ? `/auth/github/sso?org=${login}` : null,
    };
  });
}

const REPOS_MEMORY_CACHE_MAX_ENTRIES = 500;
const REPOS_MEMORY_TTL_MS = 60_000;
const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "cycloid-worker",
});
const log = createLogger({ bindings: { component: "repos-service" } });
const reposMemoryCache = createBoundedTtlMemoryCache<string, RepoCacheEntry>(REPOS_MEMORY_CACHE_MAX_ENTRIES);

function getReposCacheKey(userId: string): string {
  return `${REPOS_CACHE_KEY_PREFIX}:${userId}`;
}

function normalizeRepoFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function validateRepoSegment(value: string, field: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "Missing owner or repo" };
  }
  if (!isValidGithubRepoSegment(trimmed)) {
    return { ok: false, error: `${field} is not a valid GitHub identifier` };
  }
  return { ok: true, value: trimmed };
}

function isUsableRepoCacheEntry(
  entry: RepoCacheEntry | null | undefined,
  installationVersion: string,
): entry is RepoCacheEntry {
  // Validate ssoOrgs structurally, not just by schemaVersion: KV entries are
  // deserialized JSON, and a malformed entry served on the hit path would make
  // `result.ssoOrgs` undefined downstream.
  return Boolean(
    entry &&
    entry.installationVersion === installationVersion &&
    entry.schemaVersion === REPOS_CACHE_SCHEMA_VERSION &&
    Array.isArray(entry.ssoOrgs),
  );
}

function shouldBypassReposCache(request: Request): boolean {
  const url = new URL(request.url);
  const refreshParam = url.searchParams.get(REPOS_CACHE_BYPASS_QUERY_PARAM)?.toLowerCase();
  if (refreshParam === "1" || refreshParam === "true") {
    return true;
  }

  const cacheControl = request.headers.get("cache-control")?.toLowerCase() ?? "";
  return cacheControl.includes("no-cache") || cacheControl.includes("no-store") || cacheControl.includes("max-age=0");
}

export function resetReposMemoryCache(): void {
  reposMemoryCache.clear();
}
async function getReposInstallationVersion(env: Pick<Env, "REPOS_CACHE"> | null | undefined): Promise<string> {
  if (!env?.REPOS_CACHE) return "0";
  try {
    return (await env.REPOS_CACHE.get(REPOS_INSTALLATIONS_VERSION_KEY)) ?? "0";
  } catch (error) {
    log.error({ error: String(error) }, "Failed to read repos installation version");
    return "0";
  }
}

async function getCachedRepos(
  env: Pick<Env, "REPOS_CACHE"> | null | undefined,
  cacheKey: string,
): Promise<RepoCacheEntry | null> {
  if (!env?.REPOS_CACHE) return null;
  try {
    return (await env.REPOS_CACHE.get(cacheKey, "json")) as RepoCacheEntry | null;
  } catch (error) {
    log.error({ cacheKey, error: String(error) }, "Failed to read repo cache entry");
    return null;
  }
}

async function putCachedRepos(env: Env, cacheKey: string, entry: RepoCacheEntry): Promise<void> {
  try {
    await env.REPOS_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: REPOS_CACHE_TTL_SECONDS });
  } catch (error) {
    log.error({ cacheKey, error: String(error) }, "Failed to write repo cache entry");
  }
}

async function deleteCachedRepos(env: Pick<Env, "REPOS_CACHE"> | null | undefined, cacheKey: string): Promise<void> {
  if (!env?.REPOS_CACHE) return;
  try {
    await env.REPOS_CACHE.delete(cacheKey);
  } catch (error) {
    log.error({ cacheKey, error: String(error) }, "Failed to delete repo cache entry");
  }
}

/**
 * Drop one user's cached repo list across all layers so the next fetch is fresh.
 * Called from the GitHub OAuth callback so a freshly (re)SSO-authorized user
 * immediately sees previously-withheld org repos instead of the stale empty
 * list. Clears the per-user memory entry, the per-user KV entry, and the user's
 * per-installation D1 cache rows (selected installations cache separately and
 * would otherwise re-mask on the next non-refresh fetch).
 */
export async function invalidateReposCacheForUser(env: Env, userId: string | number): Promise<void> {
  const userKey = String(userId);
  const cacheKey = getReposCacheKey(userKey);
  reposMemoryCache.delete(cacheKey);
  await deleteCachedRepos(env, cacheKey);
  try {
    await deleteCachedInstallationReposForUser(env.DB, userKey);
  } catch (error) {
    log.error(
      { userId: userKey, error: String(error) },
      "Failed to clear per-installation repo cache during invalidation",
    );
  }
}

export async function hasCachedRepoAccess(
  env: Pick<Env, "REPOS_CACHE"> | null | undefined,
  userId: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  const cacheKey = getReposCacheKey(userId);
  const now = Date.now();
  const memoryCached = reposMemoryCache.get(cacheKey, now);
  const installationVersionPromise = getReposInstallationVersion(env);
  const initialKvPromise = memoryCached ? Promise.resolve<RepoCacheEntry | null>(null) : getCachedRepos(env, cacheKey);
  const installationVersion = await installationVersionPromise;
  const kvCached =
    memoryCached && !isUsableRepoCacheEntry(memoryCached, installationVersion)
      ? await getCachedRepos(env, cacheKey)
      : await initialKvPromise;
  const cached = isUsableRepoCacheEntry(memoryCached, installationVersion)
    ? memoryCached
    : isUsableRepoCacheEntry(kvCached, installationVersion)
      ? kvCached
      : null;
  if (!cached) {
    return false;
  }
  reposMemoryCache.set(cacheKey, cached, REPOS_MEMORY_TTL_MS, now);

  const normalizedTarget = normalizeRepoFullName(`${owner}/${repo}`);
  return cached.repos.some((cachedRepo) => normalizeRepoFullName(cachedRepo.fullName) === normalizedTarget);
}

/** Fetch repos the user can access through a specific "selected" installation. */
async function fetchInstallationRepos(token: string, installationId: number): Promise<InstallationReposResult> {
  const repoNames = new Set<string>();
  let page = 1;
  try {
    while (true) {
      const res = await tracedFetch(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        { headers: GH_HEADERS(token) },
        "github.installationRepos",
      );
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: `GitHub installation repositories API error: ${res.status}`,
        };
      }
      const body = (await res.json()) as { repositories: Array<{ full_name: string }> };
      for (const repo of body.repositories) {
        repoNames.add(repo.full_name.toLowerCase());
      }
      if (body.repositories.length < 100) break;
      page++;
    }
    return { ok: true, repos: repoNames };
  } catch (error) {
    const message = stringifyError(error);
    return {
      ok: false,
      status: 0,
      error: `GitHub installation repositories API exception: ${message}`,
    };
  }
}

async function getCachedSelectedInstallationRepos(
  db: D1Database,
  userId: string,
  installationIds: number[],
  nowMs: number,
): Promise<Map<number, Set<string>>> {
  try {
    return await getCachedInstallationReposForInstallations(db, userId, installationIds, nowMs);
  } catch (error) {
    log.error({ error: String(error) }, "Failed to read selected installation repository cache");
    return new Map();
  }
}

async function putCachedSelectedInstallationRepos(
  db: D1Database,
  userId: string,
  entries: Array<{ installationId: number; repos: Iterable<string> }>,
  nowMs: number,
): Promise<void> {
  try {
    await cacheInstallationRepos(db, userId, entries, nowMs, INSTALLATION_REPOS_CACHE_TTL_MS);
  } catch (error) {
    log.error({ error: String(error) }, "Failed to write selected installation repository cache");
  }
}

function shouldCacheFetchedRepos(
  result: FetchAccessibleReposResult,
): result is Extract<FetchAccessibleReposResult, { ok: true }> {
  return result.ok && (result.selectedInstallationFailureCount ?? 0) === 0;
}

async function fetchAccessibleReposFromGithub(
  db: D1Database,
  token: string,
  userId: string,
  options: { bypassInstallationReposCache?: boolean } = {},
): Promise<FetchAccessibleReposResult> {
  const allRepos: GhRepo[] = [];
  const withheldOrgIds = new Set<number>();
  let page = 1;
  while (true) {
    const ghResponse = await tracedFetch(
      `https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}`,
      { headers: GH_HEADERS(token) },
      "github.repoList",
    );

    if (!ghResponse.ok) {
      return {
        ok: false,
        status: 502,
        error: `GitHub API error: ${ghResponse.status}`,
      };
    }

    // SAML SSO can withhold an org's repos with HTTP 200; the header is the only
    // signal and may appear on any page, so union across pages.
    for (const orgId of parseSsoWithheldOrgIds(ghResponse.headers.get(GITHUB_SSO_HEADER))) {
      withheldOrgIds.add(orgId);
    }

    const repos = (await ghResponse.json()) as GhRepo[];
    allRepos.push(...repos);
    if (repos.length < 100) break;
    page++;
  }

  const ssoOrgs = await resolveSsoWithheldOrgs(db, withheldOrgIds);
  if (ssoOrgs.length > 0) {
    log.info(
      {
        userId,
        event: "sso_withheld_orgs",
        withheldOrgIds: [...withheldOrgIds],
        orgCount: ssoOrgs.length,
        mappedCount: ssoOrgs.filter((org) => org.login !== null).length,
      },
      "repos.sso_withheld",
    );
  }

  const uniqueOwners = [...new Set(allRepos.map((repo) => repo.full_name.split("/")[0]))];
  const installations = await getActiveInstallationsForOwners(db, uniqueOwners);

  const allRepoOwners = new Set<string>();
  const selectedInstallations: number[] = [];
  for (const installation of installations) {
    if (installation.repository_selection === "selected") {
      selectedInstallations.push(installation.installation_id);
      continue;
    }
    allRepoOwners.add(installation.owner_login.toLowerCase());
  }

  const selectedRepoNames = new Set<string>();
  let selectedInstallationFailureCount = 0;
  const bypassInstallationReposCache = Boolean(options.bypassInstallationReposCache);
  const cachedSelectedRepos =
    bypassInstallationReposCache || selectedInstallations.length === 0
      ? new Map<number, Set<string>>()
      : await getCachedSelectedInstallationRepos(db, userId, selectedInstallations, Date.now());
  for (const repoNames of cachedSelectedRepos.values()) {
    for (const repoName of repoNames) {
      selectedRepoNames.add(repoName);
    }
  }
  const uncachedSelectedInstallations = selectedInstallations.filter(
    (installationId) => !cachedSelectedRepos.has(installationId),
  );
  const selectedInstallationCacheEntries: Array<{ installationId: number; repos: Set<string> }> = [];
  const selectedRepoResults = await Promise.all(
    uncachedSelectedInstallations.map(async (installationId) => ({
      installationId,
      result: await fetchInstallationRepos(token, installationId),
    })),
  );
  for (const { installationId, result } of selectedRepoResults) {
    if (!result.ok) {
      selectedInstallationFailureCount++;
      log.warn(
        { installationId, status: result.status, error: result.error },
        "Failed to fetch selected installation repositories; filtering that owner closed",
      );
      continue;
    }
    for (const repoName of result.repos) {
      selectedRepoNames.add(repoName);
    }
    selectedInstallationCacheEntries.push({ installationId, repos: result.repos });
  }
  // Re-warm the per-installation cache with freshly fetched results even on a
  // refresh: `bypass` skips reads so we always hit GitHub, but writing the fresh
  // result back matches the merged-cache write-through-on-refresh contract and
  // keeps the next merged-cache miss cheap. Writes only successful fetches.
  if (selectedInstallationCacheEntries.length > 0) {
    await putCachedSelectedInstallationRepos(db, userId, selectedInstallationCacheEntries, Date.now());
  }

  const accessibleRepos = allRepos
    .filter((repo) => {
      const owner = repo.full_name.split("/")[0].toLowerCase();
      if (allRepoOwners.has(owner)) return true;
      return selectedRepoNames.has(repo.full_name.toLowerCase());
    })
    .map((repo) => ({
      fullName: repo.full_name,
      url: repo.html_url,
      private: repo.private,
      defaultBranch: repo.default_branch,
      description: repo.description?.trim() || null,
      ownerType: repo.owner?.type === "Organization" ? ("Organization" as const) : ("User" as const),
    }));

  return {
    ok: true,
    repos: accessibleRepos,
    ssoOrgs,
    fetchedRepoCount: allRepos.length,
    selectedInstallationCount: selectedInstallations.length,
    selectedInstallationCacheHitCount: cachedSelectedRepos.size,
    selectedInstallationFailureCount,
  };
}

export async function listAccessibleReposForUser(
  env: Env,
  userId: string,
  options: { bypassCache?: boolean; cacheOnly: true },
): Promise<RepoListServiceResult | RepoListPendingResult>;
export async function listAccessibleReposForUser(
  env: Env,
  userId: string,
  options?: { bypassCache?: boolean; cacheOnly?: false },
): Promise<RepoListServiceResult>;
export async function listAccessibleReposForUser(
  env: Env,
  userId: string,
  options: { bypassCache?: boolean; cacheOnly?: boolean } = {},
): Promise<RepoListServiceResult | RepoListPendingResult> {
  const startedAt = Date.now();
  // Token validation runs before any cache lookup and must fail closed on a
  // missing/invalid credential, even on the cacheOnly path. It can spend one
  // GitHub token-refresh POST, but never the paginated repo-list fetch.
  const tokenResult = await getValidGithubTokenResult(env.DB, userId, env);
  if (!tokenResult.ok) {
    // Status stays 401 for every token failure so the repos route keeps prompting
    // a reconnect, but tokenReason lets callers that must distinguish a genuinely
    // absent token from a present-but-rejected one (e.g. the shared-session list)
    // fail closed instead of swallowing an auth failure into an empty result.
    return { ok: false, status: 401, error: tokenResult.message, tokenReason: tokenResult.reason };
  }
  const token = tokenResult.token;

  const bypassCache = Boolean(options.bypassCache);
  const cacheOnly = Boolean(options.cacheOnly);
  const cacheKey = getReposCacheKey(userId);
  const now = Date.now();
  const memoryCached = bypassCache ? null : reposMemoryCache.get(cacheKey, now);
  const installationVersionPromise = getReposInstallationVersion(env);
  const initialKvPromise =
    bypassCache || memoryCached ? Promise.resolve<RepoCacheEntry | null>(null) : getCachedRepos(env, cacheKey);
  const installationVersion = await installationVersionPromise;
  const kvCached =
    !bypassCache && memoryCached && !isUsableRepoCacheEntry(memoryCached, installationVersion)
      ? await getCachedRepos(env, cacheKey)
      : await initialKvPromise;

  if (!bypassCache) {
    if (isUsableRepoCacheEntry(memoryCached, installationVersion)) {
      log.info(
        { userId, cache: "memory", repoCount: memoryCached.repos.length, ms: Date.now() - startedAt },
        "repos.list",
      );
      return { ok: true, repos: memoryCached.repos, ssoOrgs: memoryCached.ssoOrgs, cacheStatus: "hit" };
    }
    if (isUsableRepoCacheEntry(kvCached, installationVersion)) {
      reposMemoryCache.set(cacheKey, kvCached, REPOS_MEMORY_TTL_MS, now);
      log.info({ userId, cache: "kv", repoCount: kvCached.repos.length, ms: Date.now() - startedAt }, "repos.list");
      return { ok: true, repos: kvCached.repos, ssoOrgs: kvCached.ssoOrgs, cacheStatus: "hit" };
    }
  }

  // No usable cache entry. A cacheOnly caller (bootstrap, non-refresh) must not
  // block on the paginated GitHub repo-list fetch: return pending so the caller
  // renders immediately and the client lazy-loads `/api/repos`. A version-stale
  // entry falls through the hit checks above and lands here too, so it is never
  // served (authorization: a user dropped from an installation must refetch).
  // `bypassCache` (an explicit `?refresh`) ignores cacheOnly and fetches live.
  if (cacheOnly && !bypassCache) {
    log.info({ userId, cache: "pending", ms: Date.now() - startedAt }, "repos.list");
    return { ok: true, pending: true, repos: null, ssoOrgs: [], cacheStatus: "pending" };
  }

  const result = await fetchAccessibleReposFromGithub(env.DB, token, userId, {
    bypassInstallationReposCache: bypassCache,
  });
  if (!result.ok) {
    return result;
  }

  if (shouldCacheFetchedRepos(result)) {
    const entry: RepoCacheEntry = {
      schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
      installationVersion,
      repos: result.repos,
      ssoOrgs: result.ssoOrgs,
    };
    reposMemoryCache.set(cacheKey, entry, REPOS_MEMORY_TTL_MS, now);
    await putCachedRepos(env, cacheKey, entry);
  }

  const cacheStatus: RepoCacheStatus = bypassCache ? "bypass" : "miss";
  log.info(
    {
      userId,
      cache: cacheStatus,
      fetchedRepoCount: result.fetchedRepoCount,
      repoCount: result.repos.length,
      selectedInstallationCount: result.selectedInstallationCount,
      selectedInstallationCacheHitCount: result.selectedInstallationCacheHitCount,
      selectedInstallationFailureCount: result.selectedInstallationFailureCount,
      ms: Date.now() - startedAt,
    },
    "repos.list",
  );

  return { ok: true, repos: result.repos, ssoOrgs: result.ssoOrgs, cacheStatus };
}

export async function listAccessibleRepos(env: Env, request: Request, userId: string): Promise<RepoListServiceResult> {
  return listAccessibleReposForUser(env, userId, {
    bypassCache: shouldBypassReposCache(request),
  });
}

/**
 * Bootstrap repo read: cache-only so app load never blocks on the GitHub
 * repo-list fetch. A usable cache hit returns repos inline; a miss/stale entry
 * returns a pending result and the client lazy-loads `/api/repos`. An explicit
 * `?refresh` (post-GitHub-setup) still forces a live fetch via `bypassCache`.
 */
export async function listAccessibleReposCacheFirst(
  env: Env,
  request: Request,
  userId: string,
): Promise<RepoListServiceResult | RepoListPendingResult> {
  return listAccessibleReposForUser(env, userId, {
    bypassCache: shouldBypassReposCache(request),
    cacheOnly: true,
  });
}

export async function listRepoBranchesForUser(
  env: Env,
  userId: string,
  owner: string,
  repo: string,
): Promise<RepoBranchesServiceResult> {
  const normalizedOwner = owner.trim();
  const normalizedRepo = repo.trim();
  if (!normalizedOwner || !normalizedRepo) {
    return { ok: false, status: 400, error: "Missing owner or repo" };
  }

  const tokenResult = await getValidGithubTokenResult(env.DB, userId, env);
  if (!tokenResult.ok) {
    return { ok: false, status: 401, error: tokenResult.message, tokenReason: tokenResult.reason };
  }

  const accessible = await hasCachedRepoAccess(env, userId, normalizedOwner, normalizedRepo);
  if (!accessible) {
    return { ok: false, status: 404, error: "Repository not found" };
  }

  const branches: string[] = [];
  for (let page = 1; ; page++) {
    const ghResponse = await tracedFetch(
      `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepo)}/branches?per_page=100&page=${page}`,
      { headers: GH_HEADERS(tokenResult.token) },
      "github.repoBranches",
    );
    if (!ghResponse.ok) {
      return {
        ok: false,
        status: ghResponse.status === 404 ? 404 : 502,
        error: `GitHub API error: ${ghResponse.status}`,
      };
    }

    const body = (await ghResponse.json()) as Array<{ name?: unknown }>;
    for (const branch of body) {
      if (typeof branch.name === "string" && branch.name.trim()) branches.push(branch.name);
    }
    if (body.length < 100) break;
  }

  return { ok: true, branches };
}

function mapRepoTreeError(error: unknown): { status: number; error: string } {
  if (error instanceof GitHubRequestError) {
    if (error.status === 403 || error.status === 404) {
      return { status: 404, error: "Repository not found" };
    }
    if (error.status === 429) {
      return { status: 429, error: "GitHub API rate limited repository file listing" };
    }
    return { status: 502, error: `GitHub API error: ${error.status}` };
  }
  return { status: 502, error: "Failed to fetch file tree" };
}

export async function listRepoFilesForUser(
  env: Env,
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<RepoFilesServiceResult> {
  const ownerResult = validateRepoSegment(owner, "owner");
  const repoResult = validateRepoSegment(repo, "repo");
  if (!ownerResult.ok) return { ok: false, status: 400, error: ownerResult.error };
  if (!repoResult.ok) return { ok: false, status: 400, error: repoResult.error };

  const normalizedBranch = branch.trim() || "main";
  if (normalizedBranch.length > REPO_FILES_BRANCH_MAX_LENGTH) {
    return { ok: false, status: 400, error: "Branch name too long" };
  }
  const tokenResult = await getValidGithubTokenResult(env.DB, userId, env);
  if (!tokenResult.ok) {
    return { ok: false, status: 401, error: tokenResult.message, tokenReason: tokenResult.reason };
  }

  const accessible = await hasCachedRepoAccess(env, userId, ownerResult.value, repoResult.value);
  if (!accessible) {
    return { ok: false, status: 404, error: "Repository not found" };
  }

  const cacheOwner = ownerResult.value.toLowerCase();
  const cacheRepo = repoResult.value.toLowerCase();
  const cacheKey = `files:${userId}:${cacheOwner}:${cacheRepo}:${normalizedBranch}`;
  const cached = (await env.REPOS_CACHE.get(cacheKey, "json")) as { files: string[] } | null;
  if (cached && Array.isArray(cached.files)) {
    return { ok: true, files: cached.files };
  }

  try {
    const files = await fetchRepoTree(tokenResult.token, ownerResult.value, repoResult.value, normalizedBranch);
    await env.REPOS_CACHE.put(cacheKey, JSON.stringify({ files }), { expirationTtl: 300 });
    return { ok: true, files };
  } catch (error) {
    return { ok: false, ...mapRepoTreeError(error) };
  }
}

export async function bumpReposInstallationVersion(env: Pick<Env, "REPOS_CACHE">): Promise<void> {
  try {
    const nextVersion = `${Date.now()}:${crypto.randomUUID()}`;
    await env.REPOS_CACHE.put(REPOS_INSTALLATIONS_VERSION_KEY, nextVersion);
    reposMemoryCache.clear();
    log.info({ version: nextVersion }, "Bumped repos installation cache version");
  } catch (error) {
    log.error({ error: String(error) }, "Failed to bump repos installation cache version");
  }
}
