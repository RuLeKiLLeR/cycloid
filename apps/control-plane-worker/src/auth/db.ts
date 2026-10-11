import { isCustomerFacingIntegration } from "../../../../shared/constants/integration-helpers.js";
import { normalizeBusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import { UserRowMissingError } from "../db/errors";
import type { IntegrationScope } from "../enums/integrations";
import {
  deleteJiraPersonalDataReportAccountsForUser,
  deleteJiraUserSite,
  disconnectIntegration,
  getGithubTokens,
  getJiraTokens,
  getLinearTokens,
  getNotionTokens,
  getUserByExternalId,
  type GithubTokenRow,
  type JiraTokenRecord,
  markJiraCredentialInvalid,
  storeGithubTokens,
  storeJiraTokens,
  storeJiraTokensIfRefreshMatches,
  storeLinearTokens,
  storeLinearTokensIfRefreshMatches,
  storeNotionTokens,
  storeNotionTokensIfRefreshMatches,
} from "../integrations/db";
import { buildIntegrationScopes, deriveAvailableIntegrations } from "../integrations/service";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { AuthSessionResult, GitHubUser, UserInfo } from "../types";
import { generateRandomHex } from "../utils";
import { type BusinessRole, toBusinessRole } from "./business-role";
import {
  expiresInToTimestamp,
  GITHUB_TOKEN_REFRESH_BUFFER_MS,
  GITHUB_TOKEN_URL,
  JIRA_TOKEN_REFRESH_BUFFER_MS,
  JIRA_TOKEN_URL,
  LINEAR_TOKEN_REFRESH_BUFFER_MS,
  LINEAR_TOKEN_URL,
  NOTION_API_VERSION,
  NOTION_REVOKE_TOKEN_URL,
  NOTION_TOKEN_REFRESH_BUFFER_MS,
  NOTION_TOKEN_URL,
  SESSION_TTL_MS,
} from "./constants";

const log = createLogger({ bindings: { component: "auth-db" } });

export const RUNTIME_AUTH_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const READ_ONLY_AUTH_SESSION_PREFIX = "aro_";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_PROBE_TIMEOUT_MS = 3000;
// Fallback token lifetime when a Linear token response omits `expires_in`.
const LINEAR_TOKEN_DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;

interface CreateAuthSessionOptions {
  readOnly?: boolean;
}

function createAuthSessionToken(options: CreateAuthSessionOptions): string {
  const suffix = generateRandomHex(32);
  return options.readOnly ? `${READ_ONLY_AUTH_SESSION_PREFIX}${suffix}` : suffix;
}

function isReadOnlyAuthSessionToken(token: string): boolean {
  return token.startsWith(READ_ONLY_AUTH_SESSION_PREFIX);
}

export function buildInsertUserStatement(
  db: D1Database,
  ghUser: GitHubUser,
  businessId: string,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO NOTHING`,
    )
    .bind(
      ghUser.id,
      ghUser.login,
      ghUser.name || null,
      ghUser.email || null,
      ghUser.avatar_url || null,
      businessId,
      now,
      now,
    );
}

export function buildUpdateUserProfileStatementByGithubId(
  db: D1Database,
  ghUser: GitHubUser,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET login = ?, name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE github_id = ?")
    .bind(ghUser.login, ghUser.name || null, ghUser.email || null, ghUser.avatar_url || null, now, ghUser.id);
}

export function buildUpsertBusinessMembershipStatement(
  db: D1Database,
  businessId: string,
  userId: number,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(businessId, userId, now, now);
}

export function buildUpsertBusinessMembershipStatementForGithubUser(
  db: D1Database,
  businessId: string,
  githubUserId: number,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       SELECT ?, users.id, 'member', ?, ?
       FROM users
       WHERE users.github_id = ?
       ON CONFLICT (user_id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(businessId, now, now, githubUserId);
}

export async function getUserBusinessIdOrNull(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT business_id FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ business_id: string | null }>();
  return row?.business_id ?? null;
}

export async function getUserBusinessId(db: D1Database, userId: number): Promise<string> {
  const businessId = await getUserBusinessIdOrNull(db, userId);
  if (!businessId) {
    throw new Error(`User ${userId} is missing business ownership`);
  }
  return businessId;
}

export async function getUserSentryProfile(
  db: D1Database,
  userId: string,
): Promise<{ id: string; email: string | null; username: string | null } | null> {
  const row = await db
    .prepare("SELECT id, login, email FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: number; login: string | null; email: string | null }>();

  if (!row?.id) return null;

  return {
    id: String(row.id),
    email: row.email ?? null,
    username: row.login ?? null,
  };
}

export async function getUserDisplayProfile(
  db: D1Database,
  userId: string | number,
): Promise<{ login: string | null; avatarUrl: string | null } | null> {
  const row = await db
    .prepare("SELECT login, avatar_url FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ login: string | null; avatar_url: string | null }>();

  if (!row) return null;
  return {
    login: row.login ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

export async function createAuthSession(
  db: D1Database,
  userId: number,
  ttlMs = SESSION_TTL_MS,
  options: CreateAuthSessionOptions = {},
): Promise<string> {
  const token = createAuthSessionToken(options);
  const now = Date.now();
  await db
    .prepare("INSERT INTO auth_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, now + ttlMs, now)
    .run();
  return token;
}

export async function deleteExpiredAuthSessions(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(now).run();
  return result.meta?.changes ?? 0;
}

export async function getAuthSessionTokensForBusiness(db: D1Database, businessId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT a.token
       FROM auth_sessions a
       INNER JOIN users u ON u.id = a.user_id
       WHERE u.business_id = ? AND a.expires_at >= ?`,
    )
    .bind(businessId, Date.now())
    .all<{ token: string }>();
  return result.results.map((row) => row.token);
}

export async function hasActiveAuthSession(db: D1Database, token: string, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS active FROM auth_sessions WHERE token = ? AND expires_at > ? LIMIT 1")
    .bind(token, now)
    .first<{ active: 1 }>();
  return !!row;
}

export async function resolveAuthSession(db: D1Database, token: string): Promise<AuthSessionResult> {
  // Single query that conditionally includes business member IDs via subquery
  // when shared_sessions is enabled, eliminating a separate round-trip.
  const row = await db
    .prepare(
      `SELECT a.user_id, a.expires_at, u.id, u.github_id, u.login, u.name, u.email, u.business_id, b.shared_sessions,
              bm.role AS business_role,
              CASE WHEN b.shared_sessions = 1
                   THEN (SELECT GROUP_CONCAT(id) FROM users WHERE business_id = u.business_id)
                   ELSE NULL
              END AS member_ids
       FROM auth_sessions a
       INNER JOIN users u ON u.id = a.user_id
       INNER JOIN businesses b ON b.id = u.business_id
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       WHERE a.token = ? LIMIT 1`,
    )
    .bind(token)
    .first<{
      user_id: number;
      expires_at: number;
      id: number;
      github_id: number;
      login: string;
      name: string;
      email: string;
      business_id: string;
      shared_sessions: number | null;
      business_role: string | null;
      member_ids: string | null;
    }>();

  if (!row) return { status: "invalid" };

  if (Number(row.expires_at) < Date.now()) {
    try {
      await db.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(token).run();
    } catch {
      // Best-effort cleanup for expired sessions.
    }
    return { status: "invalid" };
  }

  const sharedSessions = row.shared_sessions === 1;

  // Parse pre-loaded business member IDs from the conditional subquery
  const businessMemberIds = row.member_ids ? row.member_ids.split(",") : undefined;

  return {
    status: "ok",
    user: {
      id: row.id,
      githubUserId: row.github_id ?? null,
      login: row.login ?? null,
      name: row.name ?? null,
      email: row.email ?? null,
      businessId: row.business_id,
      businessRole: toBusinessRole(row.business_role),
      sharedSessions,
      businessMemberIds,
    },
    ...(isReadOnlyAuthSessionToken(token) ? { readOnly: true as const } : {}),
  };
}

export async function resolveAuthUser(db: D1Database, token: string): Promise<UserInfo | null> {
  const row = await db
    .prepare(
      `SELECT a.user_id, a.expires_at, u.id, u.github_id, u.login, u.name, u.email, u.avatar_url, u.business_id,
              b.shared_sessions, bm.role AS business_role
       FROM auth_sessions a
       INNER JOIN users u ON u.id = a.user_id
       INNER JOIN businesses b ON b.id = u.business_id
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       WHERE a.token = ? LIMIT 1`,
    )
    .bind(token)
    .first<{
      user_id: number;
      expires_at: number;
      id: number;
      github_id: number;
      login: string;
      name: string;
      email: string;
      avatar_url: string | null;
      business_id: string;
      shared_sessions: number | null;
      business_role: string | null;
    }>();

  if (!row) return null;

  if (Number(row.expires_at) < Date.now()) {
    try {
      await db.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(token).run();
    } catch {
      // Best-effort cleanup.
    }
    return null;
  }

  // Batch user_integrations + business_integrations queries (independent, both depend only on Q1)
  const [integrations, scopeRows] = await db.batch([
    db
      .prepare(
        "SELECT integration_id, oauth_expires_at, oauth_refresh_token, oauth_access_token IS NOT NULL as has_oauth_token, external_user_id IS NOT NULL as has_external_id FROM user_integrations WHERE user_id = ?",
      )
      .bind(row.id),
    db.prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?").bind(row.business_id),
  ]);

  const { linearConnected, jiraConnected, notionConnected, slackConnected, slackNeedsReconnect } =
    deriveIntegrationConnections(integrations);
  const businessRole = toBusinessRole(row.business_role);

  const integrationScopes = buildIntegrationScopes(
    (scopeRows.results ?? []) as { integration_id: string; scope: IntegrationScope }[],
  );
  const availableIntegrations = deriveAvailableIntegrations(integrationScopes).filter(isCustomerFacingIntegration);

  return {
    id: row.id,
    githubUserId: row.github_id ?? null,
    login: row.login ?? null,
    name: row.name ?? null,
    email: row.email ?? null,
    avatarUrl: row.avatar_url ?? null,
    businessId: row.business_id,
    businessRole,
    sharedSessions: row.shared_sessions === 1,
    linearConnected,
    jiraConnected,
    notionConnected,
    slackConnected,
    slackNeedsReconnect,
    availableIntegrations,
    integrationScopes,
  };
}

function deriveIntegrationConnections(integrations: D1Result): {
  linearConnected: boolean;
  jiraConnected: boolean;
  notionConnected: boolean;
  slackConnected: boolean;
  slackLinked: boolean;
  slackNeedsReconnect: boolean;
} {
  const connected = new Map<
    string,
    { expiresAt: number | null; hasRefresh: boolean; hasOAuthToken: boolean; hasExternalId: boolean }
  >();
  for (const r of (integrations.results ?? []) as Array<{
    integration_id: string;
    oauth_expires_at: number | null;
    oauth_refresh_token: string | null;
    has_oauth_token: number;
    has_external_id: number;
  }>) {
    connected.set(r.integration_id, {
      expiresAt: r.oauth_expires_at,
      hasRefresh: !!r.oauth_refresh_token,
      hasOAuthToken: !!r.has_oauth_token,
      hasExternalId: !!r.has_external_id,
    });
  }

  const linearInfo = connected.get("linear");
  const linearConnected = !!linearInfo && ((linearInfo.expiresAt ?? 0) > Date.now() || linearInfo.hasRefresh);
  const jiraInfo = connected.get("jira");
  const jiraConnected = !!jiraInfo && ((jiraInfo.expiresAt ?? 0) > Date.now() || jiraInfo.hasRefresh);
  const notionInfo = connected.get("notion");
  const notionConnected =
    !!notionInfo && (notionInfo.expiresAt === null || notionInfo.expiresAt > Date.now() || notionInfo.hasRefresh);

  // Slack: "connected" means the user has a `search:read` user token. A row with
  // only `external_user_id` (a magic-link identity binding) is intentionally
  // linked, NOT a broken connection, so it must not flag "needs reconnect".
  const slackInfo = connected.get("slack");
  const slackConnected = !!slackInfo?.hasOAuthToken;
  const slackLinked = !!slackInfo?.hasExternalId;
  const slackNeedsReconnect = !!slackInfo && !slackInfo.hasOAuthToken && !slackInfo.hasExternalId;
  return { linearConnected, jiraConnected, notionConnected, slackConnected, slackLinked, slackNeedsReconnect };
}

export interface AuthUserExtras {
  avatarUrl: string | null;
  businessId: string;
  businessRole: BusinessRole | null;
  egressAllowlist: string[] | null;
  githubUserId: number | null;
  linearConnected: boolean;
  jiraConnected: boolean;
  jiraSiteName: string | null;
  notionConnected: boolean;
  slackConnected: boolean;
  slackLinked: boolean;
  slackNeedsReconnect: boolean;
  slackWorkspaceInstalled: boolean;
  availableIntegrations: string[];
  integrationScopes: Record<string, string>;
}

/**
 * Fetch the supplementary user data that resolveAuthSession doesn't provide.
 * Batches all queries into a single D1 round-trip.
 */
export async function resolveAuthUserExtras(
  db: D1Database,
  userId: number,
  businessId: string,
): Promise<AuthUserExtras> {
  const [userDetails, integrations, scopeRows, jiraSiteRows, slackWorkspaceRows] = await db.batch([
    db
      .prepare(
        `SELECT u.avatar_url, u.github_id, u.business_id, bm.role AS business_role,
                b.egress_allowlist_json
       FROM users u
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = ?
       LEFT JOIN businesses b ON b.id = ?
       WHERE u.id = ?`,
      )
      .bind(businessId, businessId, userId),
    db
      .prepare(
        "SELECT integration_id, oauth_expires_at, oauth_refresh_token, oauth_access_token IS NOT NULL as has_oauth_token, external_user_id IS NOT NULL as has_external_id FROM user_integrations WHERE user_id = ?",
      )
      .bind(userId),
    db.prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?").bind(businessId),
    db.prepare("SELECT site_name, site_url FROM jira_user_sites WHERE user_id = ? LIMIT 1").bind(userId),
    db
      .prepare("SELECT 1 AS installed FROM slack_workspaces WHERE business_id = ? AND uninstalled_at IS NULL LIMIT 1")
      .bind(businessId),
  ]);

  const detail = (
    userDetails.results as Array<{
      avatar_url: string | null;
      github_id: number | null;
      business_id: string;
      business_role: string | null;
      egress_allowlist_json: string | null;
    }>
  )?.[0];
  // No `users` row at all → stale KV-cached session for a deleted/renumbered
  // user. Throw the typed error so callers (bootstrap) fail closed to 401
  // rather than a generic 500. (Distinct from the business_id check below,
  // which is a real data-integrity fault for a user that DOES exist.)
  if (!detail) {
    throw new UserRowMissingError(userId);
  }
  const avatarUrl = detail.avatar_url ?? null;
  const resolvedBusinessId = detail.business_id;
  if (!resolvedBusinessId) {
    throw new Error(`resolveAuthUserExtras: user ${userId} is missing a business_id`);
  }
  const businessRole = toBusinessRole(detail.business_role);
  const egressAllowlist =
    businessRole === "admin" ? parseAuthBusinessEgressAllowlist(detail.egress_allowlist_json) : null;
  const githubUserId = detail.github_id ?? null;

  const { linearConnected, jiraConnected, notionConnected, slackConnected, slackLinked, slackNeedsReconnect } =
    deriveIntegrationConnections(integrations);
  const integrationScopes = buildIntegrationScopes(
    (scopeRows.results ?? []) as Array<{ integration_id: string; scope: "disabled" | "user" | "business" }>,
  );
  const availableIntegrations = deriveAvailableIntegrations(integrationScopes).filter(isCustomerFacingIntegration);
  const jiraSite = (jiraSiteRows.results as Array<{ site_name: string | null; site_url: string | null }>)?.[0];
  const jiraSiteName = jiraConnected ? (jiraSite?.site_name ?? jiraSite?.site_url ?? null) : null;
  const slackWorkspaceInstalled = (slackWorkspaceRows.results?.length ?? 0) > 0;

  return {
    avatarUrl,
    businessId: resolvedBusinessId,
    businessRole,
    egressAllowlist,
    githubUserId,
    linearConnected,
    jiraConnected,
    jiraSiteName,
    notionConnected,
    slackConnected,
    slackLinked,
    slackNeedsReconnect,
    slackWorkspaceInstalled,
    availableIntegrations,
    integrationScopes,
  };
}

function parseAuthBusinessEgressAllowlist(value: string | null): string[] | null {
  if (!value) return null;
  try {
    return normalizeBusinessEgressPolicy(JSON.parse(value), "stored business egress policy").domains;
  } catch {
    return null;
  }
}

export async function resolveInternalFeatureGateUser(
  db: D1Database,
  userId: number,
): Promise<{ businessId: string } | null> {
  const row = await db
    .prepare("SELECT business_id FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ business_id: string | null }>();

  if (!row?.business_id) {
    return null;
  }

  return {
    businessId: row.business_id,
  };
}

export async function resolveCycloidAdminUser(
  db: D1Database,
  userId: number,
): Promise<{ businessId: string | null; businessRole: BusinessRole | null } | null> {
  const row = await db
    .prepare(
      `SELECT u.business_id, bm.role AS business_role
       FROM users u
       LEFT JOIN business_members bm ON bm.user_id = u.id AND bm.business_id = u.business_id
       WHERE u.id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<{ business_id: string | null; business_role: string | null }>();

  if (!row) return null;

  return {
    businessId: row.business_id,
    businessRole: row.business_role === "admin" || row.business_role === "member" ? row.business_role : null,
  };
}

export async function deleteAuthSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(token).run();
}

// ---------------------------------------------------------------------------
// Linear tokens
// ---------------------------------------------------------------------------

export { storeLinearTokens };

export async function clearGithubToken(db: D1Database, userId: string): Promise<void> {
  await disconnectIntegration(db, Number(userId), "github");
}

/**
 * Revoke a Linear OAuth access token on Linear's side.
 * Best-effort: failures are logged but do not prevent local cleanup.
 * See https://linear.app/developers/oauth-2-0-authentication
 */
async function revokeLinearTokenOnRemote(accessToken: string): Promise<void> {
  try {
    const res = await tracedFetch(
      "https://api.linear.app/oauth/revoke",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: "access_token",
        }),
      },
      "linear.revokeToken",
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "Linear token revocation HTTP error");
    }
  } catch (err) {
    log.warn({ error: String(err) }, "Linear token revocation failed");
  }
}

export async function clearLinearTokens(
  db: D1Database,
  userId: string,
  env: { TOKEN_ENCRYPTION_KEY?: string },
  preloadedAccessToken?: string | null,
): Promise<void> {
  try {
    const accessToken =
      preloadedAccessToken !== undefined
        ? preloadedAccessToken
        : (await getLinearTokens(db, userId, env.TOKEN_ENCRYPTION_KEY))?.accessToken;
    if (accessToken) {
      await revokeLinearTokenOnRemote(accessToken);
    }
  } catch (err) {
    log.warn(
      { userId, action: "linear.token.revoke_skipped", error: String(err) },
      "Skipping remote revoke (lookup/decrypt failed); proceeding with local delete",
    );
  }
  await disconnectIntegration(db, Number(userId), "linear");
}

export { storeNotionTokens };

async function revokeNotionTokenOnRemote(
  accessToken: string,
  env: { NOTION_OAUTH_CLIENT_ID?: string; NOTION_OAUTH_CLIENT_SECRET?: string },
): Promise<void> {
  const clientId = env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;

  try {
    const res = await tracedFetch(
      NOTION_REVOKE_TOKEN_URL,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "content-type": "application/json",
          "Notion-Version": NOTION_API_VERSION,
        },
        body: JSON.stringify({ token: accessToken }),
      },
      "notion.revokeToken",
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "Notion token revocation HTTP error");
    }
  } catch (err) {
    log.warn({ error: String(err) }, "Notion token revocation failed");
  }
}

export async function clearNotionTokens(
  db: D1Database,
  userId: string,
  env: { NOTION_OAUTH_CLIENT_ID?: string; NOTION_OAUTH_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  preloadedAccessToken?: string | null,
): Promise<void> {
  try {
    const accessToken =
      preloadedAccessToken !== undefined
        ? preloadedAccessToken
        : (await getNotionTokens(db, userId, env.TOKEN_ENCRYPTION_KEY))?.accessToken;
    if (accessToken) {
      await revokeNotionTokenOnRemote(accessToken, env);
    }
  } catch (err) {
    log.warn(
      { userId, action: "notion.token.revoke_skipped", error: String(err) },
      "Skipping Notion remote revoke (lookup/decrypt failed); proceeding with local delete",
    );
  }
  await disconnectIntegration(db, Number(userId), "notion");
}

export interface RefreshableOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  /**
   * The stored (encrypted) refresh-token ciphertext, used as the CAS guard when
   * persisting a rotation. Encryption is non-deterministic, so the compare must
   * run against the exact stored value rather than a re-encryption. Non-null
   * whenever `refreshToken` is non-null (both derive from the same column).
   */
  refreshTokenCiphertext: string | null;
}

type LinearTokenProbeStatus = "ok" | "revoked" | "transient";

async function probeLinearToken(accessToken: string): Promise<LinearTokenProbeStatus> {
  try {
    const res = await tracedFetch(
      LINEAR_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
        signal: AbortSignal.timeout(LINEAR_TOKEN_PROBE_TIMEOUT_MS),
      },
      "linear.viewerProbe",
    );

    if (res.status === 401 || res.status === 403) {
      log.info(
        { action: "linear.probe", probe_status: "revoked", http_status: res.status },
        "Linear token liveness probe completed",
      );
      return "revoked";
    }
    if (!res.ok) {
      log.info(
        { action: "linear.probe", probe_status: "transient", http_status: res.status },
        "Linear token liveness probe completed",
      );
      return "transient";
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log.info(
        { action: "linear.probe", probe_status: "transient", http_status: res.status },
        "Linear token liveness probe returned malformed JSON",
      );
      return "transient";
    }

    const typed = body as {
      data?: { viewer?: { id?: string } | null };
      errors?: Array<{ extensions?: { code?: string; statusCode?: number } }>;
    };
    if (
      typed.errors?.some((error) => {
        const code = error.extensions?.code;
        const statusCode = error.extensions?.statusCode;
        return code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN" || statusCode === 401 || statusCode === 403;
      })
    ) {
      log.info(
        { action: "linear.probe", probe_status: "revoked", http_status: res.status },
        "Linear token liveness probe completed",
      );
      return "revoked";
    }
    if (typed.data?.viewer?.id) {
      log.info(
        { action: "linear.probe", probe_status: "ok", http_status: res.status },
        "Linear token liveness probe completed",
      );
      return "ok";
    }

    log.info(
      { action: "linear.probe", probe_status: "transient", http_status: res.status },
      "Linear token liveness probe returned 200 without viewer.id",
    );
    return "transient";
  } catch {
    log.info({ action: "linear.probe", probe_status: "transient" }, "Linear token liveness probe failed transiently");
    return "transient";
  }
}

/**
 * Provider-parameterized OAuth refresh + CAS-persist flow shared by Linear and
 * Notion, whose refresh paths are otherwise near-verbatim (comments included).
 * Called by the wrappers ONLY once a refresh is actually needed (token expired
 * or inside the refresh buffer); the valid-token fast path stays in the wrapper
 * because it diverges (Linear runs a liveness probe; Notion treats a null
 * expiry as non-expiring).
 *
 * Behavior mirrors the original per-provider code exactly: same log lines (only
 * the provider label differs), same D1 writes, same fail-closed returns. All
 * divergent pieces (token endpoint + request encoding, DAOs, expiry default,
 * missing-access-token handling, and Linear's post-refresh probe) are injected
 * via `config`.
 *
 * NOT used by Jira (ciphertext-compare race semantics + markCredentialInvalid)
 * or GitHub (Result contract + unconditional store, no CAS) -- see the comments
 * above those functions.
 */
interface OAuthRefreshFlowConfig {
  userId: string;
  /** Human-readable provider name used verbatim in log messages (e.g. "Linear"). */
  providerLabel: string;
  /** Log `action` prefix for the race-lost telemetry (e.g. "linear.token"). */
  actionPrefix: string;
  tokens: RefreshableOAuthTokens;
  /** Whether both OAuth client credentials are present. */
  hasOAuthCredentials: boolean;
  encryptionKey: string | undefined;
  tokenUrl: string;
  traceName: string;
  /** `expires_in` fallback when the provider omits it (Linear: seconds; Notion: null). */
  defaultExpiresIn: number | null;
  /** Notion returns null on a 200 without an access token; Linear's contract guarantees one. */
  bailOnMissingAccessToken: boolean;
  buildRequestInit: (refreshToken: string) => RequestInit;
  getTokens: () => Promise<RefreshableOAuthTokens | null>;
  store: (accessToken: string, refreshToken: string | null, expiresIn: number | null) => Promise<void>;
  storeIfRefreshMatches: (
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number | null,
    expectedRefreshCiphertext: string,
  ) => Promise<boolean>;
  clear: () => Promise<void>;
  /** Linear-only: probe the freshly minted token and clear if revoked upstream. */
  postRefresh?: (accessToken: string) => Promise<string | null>;
}

async function refreshOAuthTokenWithCas(config: OAuthRefreshFlowConfig): Promise<string | null> {
  const {
    userId,
    providerLabel,
    actionPrefix,
    tokens,
    hasOAuthCredentials,
    encryptionKey,
    tokenUrl,
    traceName,
    defaultExpiresIn,
    bailOnMissingAccessToken,
    buildRequestInit,
    getTokens,
    store,
    storeIfRefreshMatches,
    clear,
    postRefresh,
  } = config;

  // Token expired or within buffer -- attempt refresh
  if (!tokens.refreshToken || !hasOAuthCredentials) {
    log.warn(
      { userId },
      `${providerLabel} token expired with no refresh token or missing OAuth credentials -- clearing`,
    );
    await clear();
    return null;
  }

  if (!encryptionKey) {
    log.error(
      { userId },
      `TOKEN_ENCRYPTION_KEY missing -- cannot store refreshed ${providerLabel} token, aborting refresh`,
    );
    return null;
  }

  try {
    const res = await tracedFetch(tokenUrl, buildRequestInit(tokens.refreshToken), traceName);

    if (res.ok) {
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string | null;
        expires_in?: number;
        bot_id?: string;
      };
      if (!data.access_token && bailOnMissingAccessToken) {
        return null;
      }
      // Linear's contract guarantees access_token on a 200; Notion bailed above.
      const accessToken = data.access_token as string;
      const rotatedRefreshToken = data.refresh_token ?? tokens.refreshToken ?? null;
      const expiresIn = data.expires_in ?? defaultExpiresIn;
      if (tokens.refreshTokenCiphertext) {
        // CAS-guard the rotation so a concurrent refresh that already rotated
        // the row is not clobbered with our (now superseded) tokens.
        const stored = await storeIfRefreshMatches(
          accessToken,
          rotatedRefreshToken,
          expiresIn,
          tokens.refreshTokenCiphertext,
        );
        if (!stored) {
          // CAS missed. Compare the *decrypted* refresh token, not the
          // ciphertext: a concurrent read-repair re-encrypts the same token to a
          // fresh non-deterministic ciphertext, which would otherwise look like a
          // rotation and discard the token we just minted.
          const current = await getTokens();
          if (!current) return null; // row vanished (concurrent disconnect); do not resurrect it
          if (current.refreshToken !== tokens.refreshToken) {
            log.info(
              { userId, action: `${actionPrefix}.refresh_race_lost` },
              `Concurrent ${providerLabel} refresh won; using stored tokens`,
            );
            return current.accessToken ?? null;
          }
          // Same underlying refresh token (ciphertext changed only via
          // read-repair); our refresh is authoritative, so persist it. Leave
          // external_user_id untouched, matching the CAS path -- a refresh does
          // not change identity.
          await store(accessToken, rotatedRefreshToken, expiresIn);
        }
      } else {
        // No stored ciphertext to compare against (legacy/edge); fall back to an
        // unconditional write to preserve prior behavior. Leave external_user_id
        // untouched so this path matches the CAS path.
        await store(accessToken, rotatedRefreshToken, expiresIn);
      }
      log.info({ userId }, `${providerLabel} token refreshed successfully`);
      if (postRefresh) return await postRefresh(accessToken);
      return accessToken;
    }

    if (res.status >= 400 && res.status < 500) {
      // A 4xx can mean rotated-token reuse: a concurrent refresh may have won
      // and rotated the row after we read it. Re-read before clearing, comparing
      // the *decrypted* refresh token (read-repair changes the ciphertext for an
      // unchanged token, so a ciphertext compare would false-positive here).
      const current = await getTokens();
      if (current?.refreshToken && current.refreshToken !== tokens.refreshToken) {
        log.info(
          { userId, status: res.status, action: `${actionPrefix}.refresh_race_lost` },
          `${providerLabel} refresh rejected for stale rotated token; using concurrently refreshed tokens`,
        );
        return current.accessToken ?? null;
      }
      log.error({ userId, status: res.status }, `${providerLabel} token refresh failed -- clearing tokens`);
      await clear();
      return null;
    }

    // 5xx -- transient, preserve refresh token
    log.error(
      { userId, status: res.status },
      `${providerLabel} token refresh failed -- transient, preserving refresh token`,
    );
    return null;
  } catch (err) {
    log.error(
      { userId, error: String(err) },
      `${providerLabel} token refresh failed -- transient, preserving refresh token`,
    );
    return null;
  }
}

export async function getValidLinearToken(
  db: D1Database,
  userId: string,
  env: { LINEAR_OAUTH_CLIENT_ID?: string; LINEAR_OAUTH_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  preloadedTokens?: RefreshableOAuthTokens | null,
): Promise<string | null> {
  const tokens = preloadedTokens ?? (await getLinearTokens(db, userId, env.TOKEN_ENCRYPTION_KEY));
  if (!tokens) return null;

  const expiresAt = tokens.expiresAt ?? 0;
  if (expiresAt > Date.now() + LINEAR_TOKEN_REFRESH_BUFFER_MS) {
    // This is awaited during session spawn; keep the probe timeout small to cap added startup latency.
    const probe = await probeLinearToken(tokens.accessToken);
    if (probe === "revoked") {
      const current = await getLinearTokens(db, userId, env.TOKEN_ENCRYPTION_KEY);
      if (current?.accessToken === tokens.accessToken) {
        log.warn(
          { userId, action: "linear.token.cleared", reason: "revoked_upstream" },
          "Linear token revoked upstream, clearing",
        );
        await clearLinearTokens(db, userId, env, tokens.accessToken);
      } else {
        log.info(
          { userId, action: "linear.token.cleared", reason: "concurrent_reconnect_skipped" },
          "Skipping clear: row changed since probe",
        );
      }
      return null;
    }
    return tokens.accessToken;
  }

  return refreshOAuthTokenWithCas({
    userId,
    providerLabel: "Linear",
    actionPrefix: "linear.token",
    tokens,
    hasOAuthCredentials: !!(env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET),
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    tokenUrl: LINEAR_TOKEN_URL,
    traceName: "linear.tokenRefresh",
    defaultExpiresIn: LINEAR_TOKEN_DEFAULT_EXPIRES_IN_SECONDS,
    bailOnMissingAccessToken: false,
    buildRequestInit: (refreshToken) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: env.LINEAR_OAUTH_CLIENT_ID as string,
        client_secret: env.LINEAR_OAUTH_CLIENT_SECRET as string,
      }),
    }),
    getTokens: () => getLinearTokens(db, userId, env.TOKEN_ENCRYPTION_KEY),
    store: (accessToken, refreshToken, expiresIn) =>
      storeLinearTokens(
        db,
        Number(userId),
        accessToken,
        refreshToken,
        expiresIn ?? LINEAR_TOKEN_DEFAULT_EXPIRES_IN_SECONDS,
        env.TOKEN_ENCRYPTION_KEY,
      ),
    storeIfRefreshMatches: (accessToken, refreshToken, expiresIn, expectedRefreshCiphertext) =>
      storeLinearTokensIfRefreshMatches(
        db,
        Number(userId),
        accessToken,
        refreshToken,
        expiresIn ?? LINEAR_TOKEN_DEFAULT_EXPIRES_IN_SECONDS,
        env.TOKEN_ENCRYPTION_KEY,
        expectedRefreshCiphertext,
      ),
    clear: () => clearLinearTokens(db, userId, env),
    postRefresh: async (accessToken) => {
      const probe = await probeLinearToken(accessToken);
      if (probe === "revoked") {
        const current = await getLinearTokens(db, userId, env.TOKEN_ENCRYPTION_KEY);
        if (current?.accessToken === accessToken) {
          log.warn(
            { userId, action: "linear.token.cleared", reason: "revoked_after_refresh" },
            "Linear token revoked upstream after refresh, clearing",
          );
          await clearLinearTokens(db, userId, env, accessToken);
        }
        return null;
      }
      return accessToken;
    },
  });
}

// ---------------------------------------------------------------------------
// Jira tokens
// ---------------------------------------------------------------------------

export { storeJiraTokens };

/**
 * Atlassian 3LO has no public token-revocation endpoint; clearing is local-only.
 * Deletes the credential row and the user's selected-site row together so a
 * disconnected user's account mapping cannot keep triggering webhook sessions.
 */
export async function clearJiraTokens(db: D1Database, userId: string): Promise<void> {
  await deleteJiraPersonalDataReportAccountsForUser(db, Number(userId));
  await disconnectIntegration(db, Number(userId), "jira");
  await deleteJiraUserSite(db, Number(userId));
}

/**
 * Returns a Jira access token that is valid for at least the refresh buffer,
 * refreshing through Atlassian when needed. Atlassian rotates refresh tokens
 * (each one is single-use), so the rotated pair persists through a CAS update;
 * on a lost race the concurrently-stored newer tokens win and are returned.
 *
 * Deliberately NOT built on `refreshOAuthTokenWithCas`: Jira's race semantics
 * diverge (4xx re-read compares the refresh-token *ciphertext*, not the
 * decrypted value; a CAS miss returns the stored token without a decrypted
 * re-compare or fallback re-store), it marks the credential invalid via
 * `markJiraCredentialInvalid` instead of clearing, and it splits the
 * missing-refresh vs missing-credentials guards. Forcing it into the shared
 * helper would require behavior-selecting callbacks, so it stays standalone.
 */
export async function getValidJiraToken(
  db: D1Database,
  userId: string,
  env: { JIRA_OAUTH_CLIENT_ID?: string; JIRA_OAUTH_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  preloadedTokens?: JiraTokenRecord | null,
): Promise<string | null> {
  const tokens = preloadedTokens ?? (await getJiraTokens(db, userId, env.TOKEN_ENCRYPTION_KEY));
  if (!tokens) return null;

  const expiresAt = tokens.expiresAt ?? 0;
  if (expiresAt > Date.now() + JIRA_TOKEN_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }

  // Token expired or within buffer -- attempt refresh
  if (!tokens.refreshToken || !tokens.refreshTokenCiphertext) {
    log.warn({ userId, action: "jira.token.refresh_unavailable" }, "Jira token expired with no refresh token");
    await markJiraCredentialInvalid(db, Number(userId), "oauth_token_expired");
    return null;
  }
  if (!env.JIRA_OAUTH_CLIENT_ID || !env.JIRA_OAUTH_CLIENT_SECRET) {
    log.warn({ userId }, "Jira token expired but OAuth client credentials are missing -- cannot refresh");
    return null;
  }
  if (!env.TOKEN_ENCRYPTION_KEY) {
    log.error({ userId }, "TOKEN_ENCRYPTION_KEY missing -- cannot store refreshed Jira token, aborting refresh");
    return null;
  }

  try {
    const res = await tracedFetch(
      JIRA_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: env.JIRA_OAUTH_CLIENT_ID,
          client_secret: env.JIRA_OAUTH_CLIENT_SECRET,
          refresh_token: tokens.refreshToken,
        }),
      },
      "jira.tokenRefresh",
    );

    if (res.ok) {
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
      // Fall back to the prior refresh token if Atlassian omits one; clearing
      // it would strand the credential until manual reconnect.
      const stored = await storeJiraTokensIfRefreshMatches(
        db,
        Number(userId),
        data.access_token,
        data.refresh_token ?? tokens.refreshToken,
        data.expires_in ?? 3600,
        env.TOKEN_ENCRYPTION_KEY,
        tokens.refreshTokenCiphertext,
      );
      if (!stored) {
        // A concurrent refresh already rotated the row; its tokens are newer.
        log.info(
          { userId, action: "jira.token.refresh_race_lost" },
          "Concurrent Jira refresh won; using stored tokens",
        );
        const current = await getJiraTokens(db, userId, env.TOKEN_ENCRYPTION_KEY);
        return current?.accessToken ?? null;
      }
      log.info({ userId }, "Jira token refreshed successfully");
      return data.access_token;
    }

    if (res.status >= 400 && res.status < 500) {
      // A 4xx can mean rotated-token reuse: a concurrent refresh may have won
      // the CAS and rotated the row after we read it. Re-read before declaring
      // the grant dead -- if the stored refresh token changed, the credential
      // is healthy and the winner's tokens are authoritative.
      const current = await getJiraTokens(db, userId, env.TOKEN_ENCRYPTION_KEY);
      if (current?.refreshTokenCiphertext && current.refreshTokenCiphertext !== tokens.refreshTokenCiphertext) {
        log.info(
          { userId, status: res.status, action: "jira.token.refresh_race_lost" },
          "Jira refresh rejected for stale rotated token; using concurrently refreshed tokens",
        );
        return current.accessToken ?? null;
      }
      // Permanent: rotated-token reuse or revoked grant. Mark degraded so the
      // settings UI surfaces reconnect; keep the row for diagnostics.
      log.error({ userId, status: res.status }, "Jira token refresh rejected -- marking credential invalid");
      await markJiraCredentialInvalid(db, Number(userId), "oauth_token_expired");
      return null;
    }

    log.error({ userId, status: res.status }, "Jira token refresh failed -- transient, preserving refresh token");
    return null;
  } catch (err) {
    log.error({ userId, error: String(err) }, "Jira token refresh failed -- transient, preserving refresh token");
    return null;
  }
}

export async function getValidNotionToken(
  db: D1Database,
  userId: string,
  env: { NOTION_OAUTH_CLIENT_ID?: string; NOTION_OAUTH_CLIENT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string },
  preloadedTokens?: RefreshableOAuthTokens | null,
): Promise<string | null> {
  const tokens = preloadedTokens ?? (await getNotionTokens(db, userId, env.TOKEN_ENCRYPTION_KEY));
  if (!tokens) return null;

  if (tokens.expiresAt === null) {
    return tokens.accessToken;
  }

  if (tokens.expiresAt > Date.now() + NOTION_TOKEN_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }

  return refreshOAuthTokenWithCas({
    userId,
    providerLabel: "Notion",
    actionPrefix: "notion.token",
    tokens,
    hasOAuthCredentials: !!(env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET),
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    tokenUrl: NOTION_TOKEN_URL,
    traceName: "notion.tokenRefresh",
    defaultExpiresIn: null,
    bailOnMissingAccessToken: true,
    buildRequestInit: (refreshToken) => ({
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`)}`,
        "content-type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }),
    getTokens: () => getNotionTokens(db, userId, env.TOKEN_ENCRYPTION_KEY),
    store: (accessToken, refreshToken, expiresIn) =>
      storeNotionTokens(db, Number(userId), accessToken, refreshToken, expiresIn, env.TOKEN_ENCRYPTION_KEY),
    storeIfRefreshMatches: (accessToken, refreshToken, expiresIn, expectedRefreshCiphertext) =>
      storeNotionTokensIfRefreshMatches(
        db,
        Number(userId),
        accessToken,
        refreshToken,
        expiresIn,
        env.TOKEN_ENCRYPTION_KEY,
        expectedRefreshCiphertext,
      ),
    clear: () => clearNotionTokens(db, userId, env, tokens.accessToken),
  });
}

// ---------------------------------------------------------------------------
// GitHub user-token refresh
// ---------------------------------------------------------------------------

export type GithubTokenRefreshEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

export type GithubTokenFailureReason = "token_missing" | "token_refresh_rejected" | "token_refresh_unavailable";

export type GithubTokenResolutionResult =
  | { ok: true; token: string }
  | {
      ok: false;
      reason: GithubTokenFailureReason;
      status?: number;
      message: string;
    };

/**
 * Deliberately NOT built on `refreshOAuthTokenWithCas`: GitHub returns a typed
 * `GithubTokenResolutionResult` (reason + message + status) rather than
 * token-or-null, persists refreshed tokens with an unconditional
 * `storeGithubTokens` (no CAS, no concurrent-rotation race handling), and clears
 * on 4xx without a re-read. Its contract and store path differ enough that the
 * shared helper would not fit without collapsing those distinctions, so it stays
 * standalone.
 */
export async function getValidGithubTokenResult(
  db: D1Database,
  userId: string,
  env: GithubTokenRefreshEnv,
  preloadedTokens?: GithubTokenRow | null,
): Promise<GithubTokenResolutionResult> {
  const tokens = preloadedTokens ?? (await getGithubTokens(db, userId, env.TOKEN_ENCRYPTION_KEY));
  if (!tokens) {
    return { ok: false, reason: "token_missing", message: "No GitHub OAuth token is stored for this user." };
  }

  // expiresAt is null for legacy rows (App configured without expiring user tokens). Treat
  // those as non-expiring -- the only way they go bad is upstream revocation, which we
  // can't detect without spending a probe call on every read.
  if (tokens.expiresAt === null) return { ok: true, token: tokens.accessToken };

  if (tokens.expiresAt > Date.now() + GITHUB_TOKEN_REFRESH_BUFFER_MS) {
    return { ok: true, token: tokens.accessToken };
  }

  if (!tokens.refreshToken || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    log.warn(
      { userId, action: "github.token.cleared", reason: "no_refresh_credentials" },
      "GitHub user token expired with no refresh token or missing OAuth credentials -- clearing",
    );
    await clearGithubToken(db, userId);
    return {
      ok: false,
      reason: "token_refresh_rejected",
      message: "GitHub user token expired with no refresh token or missing OAuth credentials.",
    };
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    log.error(
      { userId, action: "github.token.refresh_aborted", reason: "encryption_key_missing" },
      "TOKEN_ENCRYPTION_KEY missing -- cannot store refreshed GitHub token",
    );
    return {
      ok: false,
      reason: "token_refresh_unavailable",
      message: "TOKEN_ENCRYPTION_KEY missing -- cannot store refreshed GitHub token.",
    };
  }

  try {
    const res = await tracedFetch(
      GITHUB_TOKEN_URL,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
        }),
      },
      "github.tokenRefresh",
    );

    if (res.ok) {
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!data.access_token) {
        log.warn(
          {
            userId,
            providerError: data.error ?? null,
            action: "github.token.cleared",
            reason: "refresh_no_access_token",
          },
          "GitHub token refresh returned no access token -- clearing",
        );
        await clearGithubToken(db, userId);
        return {
          ok: false,
          reason: "token_refresh_rejected",
          message: "GitHub token refresh returned no access token.",
        };
      }
      const refreshedExpiresAt = expiresInToTimestamp(data.expires_in);
      await storeGithubTokens(
        db,
        Number(userId),
        data.access_token,
        data.refresh_token ?? tokens.refreshToken,
        refreshedExpiresAt,
        env.TOKEN_ENCRYPTION_KEY,
      );
      log.info({ userId, action: "github.token.refreshed" }, "GitHub user token refreshed successfully");
      return { ok: true, token: data.access_token };
    }

    if (res.status >= 400 && res.status < 500) {
      log.error(
        { userId, status: res.status, action: "github.token.cleared", reason: "refresh_4xx" },
        "GitHub token refresh failed with 4xx -- clearing tokens",
      );
      await clearGithubToken(db, userId);
      return {
        ok: false,
        reason: "token_refresh_rejected",
        status: res.status,
        message: `GitHub token refresh failed with HTTP ${res.status}.`,
      };
    }

    // 5xx -- transient, preserve refresh token so a later attempt can succeed.
    log.error(
      { userId, status: res.status, action: "github.token.refresh_transient" },
      "GitHub token refresh failed with 5xx -- transient, preserving refresh token",
    );
    return {
      ok: false,
      reason: "token_refresh_unavailable",
      status: res.status,
      message: `GitHub token refresh failed with HTTP ${res.status}.`,
    };
  } catch (err) {
    const message = `GitHub token refresh failed: ${String(err)}`;
    log.error(
      { userId, error: String(err), action: "github.token.refresh_transient" },
      "GitHub token refresh failed -- transient, preserving refresh token",
    );
    return { ok: false, reason: "token_refresh_unavailable", message };
  }
}

export async function getValidGithubToken(
  db: D1Database,
  userId: string,
  env: GithubTokenRefreshEnv,
  preloadedTokens?: GithubTokenRow | null,
): Promise<string | null> {
  const result = await getValidGithubTokenResult(db, userId, env, preloadedTokens);
  return result.ok ? result.token : null;
}

// ---------------------------------------------------------------------------
// Slack link
// ---------------------------------------------------------------------------

export async function getUserBySlackId(
  db: D1Database,
  slackUserId: string,
): Promise<{ id: number; login: string | null } | null> {
  return getUserByExternalId(db, "slack", slackUserId);
}

/**
 * Team-scoped Slack actor lookup for authorization surfaces. Slack user ids
 * are workspace-scoped strings, so matching on the id alone (getUserBySlackId)
 * would let a same-id user from a different workspace resolve to this user.
 * The link's workspace must equal `teamId`: reads the durable
 * `user_integrations.external_team_id` first, falling back to the most-recent
 * `slack_link_token_consumptions` row only for links bound before migration
 * 0205 added the column (mirrors getLinkedSlackTeamIdForUser in
 * slack/link-db.ts). Links with no recorded team on either source never match
 * — fail closed rather than guess.
 */
export async function getUserBySlackIdForTeam(
  db: D1Database,
  slackUserId: string,
  teamId: string,
): Promise<{ id: number; login: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.login
       FROM user_integrations ui
       INNER JOIN users u ON u.id = ui.user_id
       WHERE ui.integration_id = 'slack'
         AND ui.external_user_id = ?
         AND COALESCE(
               ui.external_team_id,
               (SELECT slack_team_id FROM slack_link_token_consumptions
                 WHERE consumed_by_user_id = ui.user_id
                 ORDER BY consumed_at DESC
                 LIMIT 1)
             ) = ?
       LIMIT 1`,
    )
    .bind(slackUserId, teamId)
    .first<{ id: number; login: string | null }>();
  return row ?? null;
}

export async function getUserByLinearId(
  db: D1Database,
  linearUserId: string,
): Promise<{ id: number; login: string | null } | null> {
  return getUserByExternalId(db, "linear", linearUserId);
}

export async function getUserByGithubId(
  db: D1Database,
  githubUserId: number,
): Promise<{ id: number; login: string | null } | null> {
  const row = await db
    .prepare("SELECT id, login FROM users WHERE github_id = ? LIMIT 1")
    .bind(githubUserId)
    .first<{ id: number; login: string | null }>();

  return row ? { id: row.id, login: row.login ?? null } : null;
}

export async function clearSlackLink(db: D1Database, userId: string): Promise<void> {
  await disconnectIntegration(db, Number(userId), "slack");
}
