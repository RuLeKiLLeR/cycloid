import { AUTH_ME_USER_CACHE_TTL_MS } from "../constants/auth";
import { isCycloidAdmin } from "../services/internal-feature-gate";
import type { AuthInfo, Env } from "../types";
import type { BusinessRole } from "./business-role";
import { resolveAuthUserExtras } from "./db";

type AuthMeUser = {
  id: number;
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  businessId: string;
  businessRole: BusinessRole | null;
  sharedSessions: boolean;
  egressAllowlist: string[] | null;
  isCycloidAdmin: boolean;
  linearConnected: boolean;
  jiraConnected: boolean;
  jiraSiteName: string | null;
  notionConnected: boolean;
  slackConnected: boolean;
  slackLinked: boolean;
  slackNeedsReconnect: boolean;
  slackWorkspaceInstalled: boolean;
};

type AuthMeUserCacheEntry = {
  expiresAt: number;
  user: AuthMeUser;
};

const authMeUserCache = new Map<string, AuthMeUserCacheEntry>();
let nextAuthMeUserCachePruneAt = 0;

function getAuthMeUserCacheKey(userId: number, businessId: string): string {
  return `${businessId}:${userId}`;
}

function pruneExpiredAuthMeUserCacheEntries(now: number): void {
  if (now < nextAuthMeUserCachePruneAt) {
    return;
  }

  for (const [cacheKey, entry] of authMeUserCache.entries()) {
    if (entry.expiresAt <= now) {
      authMeUserCache.delete(cacheKey);
    }
  }

  nextAuthMeUserCachePruneAt = now + AUTH_ME_USER_CACHE_TTL_MS;
}

function buildAuthMeUser(
  auth: NonNullable<AuthInfo["user"]>,
  extras: Awaited<ReturnType<typeof resolveAuthUserExtras>>,
): AuthMeUser {
  return {
    id: auth.id,
    login: auth.login,
    name: auth.name,
    email: auth.email,
    avatarUrl: extras.avatarUrl,
    businessId: extras.businessId,
    businessRole: extras.businessRole,
    sharedSessions: auth.sharedSessions ?? false,
    egressAllowlist: extras.egressAllowlist,
    isCycloidAdmin: isCycloidAdmin({
      businessId: extras.businessId,
      businessRole: extras.businessRole,
    }),
    linearConnected: extras.linearConnected,
    jiraConnected: extras.jiraConnected,
    jiraSiteName: extras.jiraSiteName,
    notionConnected: extras.notionConnected,
    slackConnected: extras.slackConnected,
    slackLinked: extras.slackLinked,
    slackNeedsReconnect: extras.slackNeedsReconnect,
    slackWorkspaceInstalled: extras.slackWorkspaceInstalled,
  };
}

export function resetAuthMeUserCache(): void {
  authMeUserCache.clear();
  nextAuthMeUserCachePruneAt = 0;
}

export async function resolveAuthMeUser(
  db: D1Database,
  _env: Env,
  auth: NonNullable<AuthInfo["user"]>,
  options: { fresh?: boolean },
): Promise<{ user: AuthMeUser; cacheHit: boolean }> {
  const now = Date.now();
  pruneExpiredAuthMeUserCacheEntries(now);

  const cacheKey = getAuthMeUserCacheKey(auth.id, auth.businessId);
  const cached = authMeUserCache.get(cacheKey);
  if (!options?.fresh && cached && cached.expiresAt > now) {
    return { user: cached.user, cacheHit: true };
  }

  if (cached) {
    authMeUserCache.delete(cacheKey);
  }

  const extras = await resolveAuthUserExtras(db, auth.id, auth.businessId);
  const user = buildAuthMeUser(auth, extras);
  authMeUserCache.set(cacheKey, {
    expiresAt: now + AUTH_ME_USER_CACHE_TTL_MS,
    user,
  });
  return { user, cacheHit: false };
}
