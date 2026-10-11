import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import { githubHeaders } from "../github/pr";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { hasCachedRepoAccess } from "../services/repos";
import type { Env } from "../types";
import { getValidGithubTokenResult, type GithubTokenRefreshEnv, type GithubTokenResolutionResult } from "./db";

export const SESSION_VIEW_REPO_ACCESS_CACHE_TTL_MS = 60_000;
const SESSION_VIEW_REPO_ACCESS_CACHE_MAX_ENTRIES = 1000;

const log = createLogger({ bindings: { component: "repo-authorization" } });

type SessionViewRepoAccessCacheEntry = {
  repoFullName: string;
};

interface RepoAuthorizationOptions {
  githubTokenEnv?: GithubTokenRefreshEnv;
  preloadedGithubTokenResult?: GithubTokenResolutionResult;
  reposCacheEnv?: Pick<Env, "REPOS_CACHE"> | null;
  sessionViewCache?: { sessionId: string };
}

type GithubRepoAccessProbeResult =
  | { ok: true; access: true; source: "cache" | "github_api" }
  | {
      ok: true;
      access: false;
      reason: "repo_access_denied" | "provider_authn_rejected" | "provider_rate_limited";
      status: number;
    }
  | {
      ok: false;
      reason: "provider_api_unavailable";
      status?: number;
      message: string;
    };

const sessionViewRepoAccessCache = createBoundedTtlMemoryCache<string, SessionViewRepoAccessCacheEntry>(
  SESSION_VIEW_REPO_ACCESS_CACHE_MAX_ENTRIES,
);

function getSessionViewRepoAccessCacheKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

function normalizeRepoFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`.trim().toLowerCase();
}

function hasValidSessionViewRepoAccessCacheEntry(
  userId: string,
  sessionId: string,
  owner: string,
  repo: string,
  now: number,
): boolean {
  const cacheKey = getSessionViewRepoAccessCacheKey(userId, sessionId);
  const cached = sessionViewRepoAccessCache.get(cacheKey, now);
  if (!cached) {
    return false;
  }

  const normalizedRepo = normalizeRepoFullName(owner, repo);
  if (cached.repoFullName !== normalizedRepo) {
    return false;
  }

  return true;
}

function storeSessionViewRepoAccessCacheEntry(
  userId: string,
  sessionId: string,
  owner: string,
  repo: string,
  now: number,
): void {
  sessionViewRepoAccessCache.set(
    getSessionViewRepoAccessCacheKey(userId, sessionId),
    { repoFullName: normalizeRepoFullName(owner, repo) },
    SESSION_VIEW_REPO_ACCESS_CACHE_TTL_MS,
    now,
  );
}

export function resetSessionViewRepoAccessCache(): void {
  sessionViewRepoAccessCache.clear();
}

function buildUnexpectedRepoAccessStatusError(status: number): Error {
  return new Error(`GitHub API returned unexpected status ${status} verifying repo access`);
}

/**
 * Verify the user has access to a repo by calling the GitHub API with their OAuth token.
 * Returns true if the user can see the repo, false if access is denied (403/404).
 * Throws when GitHub credentials are missing or rejected, or on unexpected API
 * responses or network errors, so callers can fail closed and return a retryable
 * error to the user rather than inadvertently granting access.
 */
export async function verifyUserRepoAccess(
  db: D1Database,
  userId: string,
  owner: string,
  repo: string,
  options: RepoAuthorizationOptions,
): Promise<boolean> {
  const probe = await probeGithubRepoAccess(db, userId, owner, repo, options);
  if (probe.ok) {
    if (!probe.access && probe.reason === "provider_rate_limited") {
      throw new Error(`GitHub API rate limited repo access verification for ${owner}/${repo}`);
    }
    if (!probe.access && probe.reason === "provider_authn_rejected") {
      throw new Error(`GitHub credentials rejected during repo access verification for ${owner}/${repo}`);
    }
    return probe.access;
  }
  throw new Error(probe.message);
}

export async function probeGithubRepoAccess(
  db: D1Database,
  userId: string,
  owner: string,
  repo: string,
  options: RepoAuthorizationOptions,
): Promise<GithubRepoAccessProbeResult> {
  const sessionId = options?.sessionViewCache?.sessionId;
  const now = Date.now();
  if (sessionId && hasValidSessionViewRepoAccessCacheEntry(userId, sessionId, owner, repo, now)) {
    return { ok: true, access: true, source: "cache" };
  }

  const tokenResult = options?.preloadedGithubTokenResult;

  if (!tokenResult && !options?.githubTokenEnv) {
    log.error({ userId }, "GitHub token env missing for repo access verification");
    return {
      ok: false,
      reason: "provider_api_unavailable",
      message: "GitHub token verification environment missing",
    };
  }

  const resolvedTokenResult =
    tokenResult ?? (await getValidGithubTokenResult(db, userId, options.githubTokenEnv as GithubTokenRefreshEnv));
  if (!resolvedTokenResult.ok) {
    if (resolvedTokenResult.reason === "token_refresh_unavailable") {
      return {
        ok: false,
        reason: "provider_api_unavailable",
        status: resolvedTokenResult.status,
        message: resolvedTokenResult.message,
      };
    }
    log.warn({ userId, reason: resolvedTokenResult.reason }, "No usable GitHub token found for user");
    return { ok: true, access: false, reason: "provider_authn_rejected", status: 401 };
  }
  const token = resolvedTokenResult.token;

  if (await hasCachedRepoAccess(options?.reposCacheEnv, userId, owner, repo)) {
    if (sessionId) {
      storeSessionViewRepoAccessCacheEntry(userId, sessionId, owner, repo, now);
    }
    return { ok: true, access: true, source: "cache" };
  }

  try {
    const res = await tracedFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "GET", headers: githubHeaders(token) },
      "github.verifyUserRepoAccess",
    );
    if (res.status === 200) {
      if (sessionId) {
        storeSessionViewRepoAccessCacheEntry(userId, sessionId, owner, repo, now);
      }
      return { ok: true, access: true, source: "github_api" };
    }
    if (res.status === 401) {
      return { ok: true, access: false, reason: "provider_authn_rejected", status: res.status };
    }
    if (res.status === 403 || res.status === 404) {
      return { ok: true, access: false, reason: "repo_access_denied", status: res.status };
    }
    if (res.status === 429) {
      return { ok: true, access: false, reason: "provider_rate_limited", status: res.status };
    }
    const error = buildUnexpectedRepoAccessStatusError(res.status);
    log.error(
      { userId, owner, repo, status: res.status, error },
      "Unexpected GitHub API response for repo access check",
    );
    return {
      ok: false,
      reason: "provider_api_unavailable",
      status: res.status,
      message: error.message,
    };
  } catch (err) {
    log.error({ userId, owner, repo, error: String(err) }, "GitHub API call failed for repo access check");
    return {
      ok: false,
      reason: "provider_api_unavailable",
      message: `GitHub API call failed verifying repo access: ${String(err)}`,
    };
  }
}
