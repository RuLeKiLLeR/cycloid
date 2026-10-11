import * as Sentry from "@sentry/cloudflare";

import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import {
  buildIntegrationToolEntries as getIntegrationToolEntries,
  type IntegrationId,
} from "../../../../shared/constants/integration-helpers.js";
import { OAUTH_CALLBACK_CODES, type OAuthCallbackCode } from "../../../../shared/constants/onboarding.js";
import {
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { AUTH_SESSION_CACHE_TTL, IMPERSONATION_COOKIE_NAME } from "../constants/auth";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { SLACK_TOKEN_URL } from "../constants/slack";
import {
  getConflictingInstallationByOwner,
  isInstallationOwnerUniqueConstraintError,
  replaceConflictingInstallation,
  upsertInstallation,
} from "../github/installations-db";
import { getAppSlug } from "../github/octokit";
import { deriveCurrentIntegrationHealth } from "../integrations/current-health";
import {
  connectIntegration,
  consumeJiraOAuthPending,
  deleteJiraUserSite,
  deleteUnreferencedJiraPersonalDataReportAccounts,
  getGithubTokens,
  getJiraOAuthPending,
  insertJiraOAuthPending,
  listJiraPersonalDataReportAccountIdsForUser,
  storeJiraTokens,
  storeLinearTokens,
  storeNotionTokens,
  upsertJiraPersonalDataReportAccount,
  upsertJiraUserSite,
} from "../integrations/db";
import { getLatestBusinessIntegrationHealthCheck } from "../integrations/health-db";
import { getIntegrationLifecycleSummaries, writeIntegrationLifecycleEvent } from "../integrations/lifecycle/service";
import { isIntegrationAvailable } from "../integrations/service";
import { createLogger } from "../logger";
import { endSpan, startSpan } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { tracedFetch } from "../observability/wrappers";
import { resolveCliToken } from "../services/cli-tokens";
import { bumpReposInstallationVersion, invalidateReposCacheForUser } from "../services/repos";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import { decrypt, encrypt } from "../settings/encryption";
import { renderSlackLinkConsentHtml, renderSlackLinkSignInHtml } from "../slack/link-consent";
import { confirmSlackLink, resolveSlackLink } from "../slack/link-service";
import {
  installSlackWorkspaceFromCode,
  seedSlackWorkspaceFromEnv,
  SLACK_WORKSPACE_INSTALL_SCOPE,
  SLACK_WORKSPACE_INSTALL_STATE_COOKIE,
  slackInstallCallbackUrl,
  SlackWorkspaceInstallError,
} from "../slack/workspace-install";
import type { AuthInfo, AuthResult, AuthSessionResult, Env, UserInfo } from "../types";
import {
  clearCookieHeader,
  computeSha256Hex,
  generateRandomHex,
  jsonErrorResponse,
  jsonResponse,
  parseBearerToken,
  parseCookies,
  parseImpersonationTokenCookie,
  parseJsonBody,
  parseSessionTokenCookie,
  setCookieHeader,
  timingSafeEqualString,
} from "../utils";
import { upsertJiraWebhookInstallation, upsertLinearWebhookInstallation } from "../webhooks/db";
import { resetAuthMeUserCache, resolveAuthMeUser } from "./auth-me";
import {
  expiresInToTimestamp,
  GITHUB_TOKEN_URL,
  JIRA_ACCESSIBLE_RESOURCES_URL,
  JIRA_AUTHORIZE_URL,
  JIRA_ME_URL,
  JIRA_OAUTH_BUSINESS_SCOPE,
  JIRA_OAUTH_PENDING_TTL_MS,
  JIRA_OAUTH_USER_SCOPE,
  JIRA_TOKEN_URL,
  LINEAR_TOKEN_URL,
  NOTION_API_VERSION,
  NOTION_OAUTH_AUTHORIZE_URL,
  NOTION_TOKEN_URL,
  OAUTH_STATE_COOKIE_MAX_AGE_MS,
  SESSION_TTL_MS,
} from "./constants";
import {
  clearGithubToken,
  clearNotionTokens,
  clearSlackLink,
  createAuthSession,
  deleteAuthSession,
  getUserBusinessIdOrNull,
  getUserByGithubId,
  hasActiveAuthSession,
  resolveAuthSession,
  resolveAuthUser,
  resolveAuthUserExtras,
} from "./db";
import { resolveGithubOAuthHost } from "./github-oauth-host";
import { GITHUB_OAUTH_RETURN_TO_COOKIE, githubOAuthAuthorizePath } from "./github-sso";
import { resolveImpersonationByTokenHash, revokeImpersonationByTokenHash } from "./impersonation-db";
import { deletePendingSignupByGithubId, getPendingSignupByGithubId, upsertPendingSignup } from "./pending-signups-db";
import { notifyCycloidAdminOfPendingSignup } from "./pending-signups-notify";
import {
  authSessionCacheKey,
  BusinessMismatchError,
  invalidateAuthSessionCache,
  persistAuthenticatedGitHubUser,
} from "./service";
import { renderTurnstileAuthForm, verifyTurnstileAuthRequest } from "./turnstile";

const log = createLogger({ bindings: { component: "auth" } });
const GITHUB_OAUTH_GENERIC_ERROR = "Unable to continue";
const USER_INTEGRATIONS_BUSINESS_HEALTH_IDS = new Set<IntegrationId>(["jira", "linear"]);
const GITHUB_OAUTH_DENIED_HTML = "<html><body><p>Access unavailable. Contact your administrator.</p></body></html>";
const UNKNOWN_GITHUB_SIGNUP_RATE_LIMIT_MAX = 5;
const UNKNOWN_GITHUB_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const LINEAR_OAUTH_STATE_COOKIE = "linear_oauth_state";
const LINEAR_BUSINESS_OAUTH_STATE_COOKIE = "linear_business_oauth_state";
const LINEAR_OAUTH_SCOPE = "read,write,issues:create";
const NOTION_OAUTH_STATE_COOKIE = "notion_oauth_state";
const NOTION_INTEGRATIONS_SETTINGS_PATH = "/settings/integrations";
const SLACK_WORKSPACE_INSTALL_RETURN_TO_COOKIE = "slack_install_return_to";
const SLACK_WORKSPACE_INSTALL_DEFAULT_RETURN_TO = "/settings/workspace-integrations";
const SLACK_WORKSPACE_INSTALL_ALLOWED_RETURN_TO = new Set([
  "/settings/integrations",
  SLACK_WORKSPACE_INSTALL_DEFAULT_RETURN_TO,
]);

async function emitAuthLifecycleEvent(params: {
  db: D1Database;
  integrationId: IntegrationId;
  userId: number;
  businessId?: string | null;
  stage: (typeof INTEGRATION_LIFECYCLE_STAGE)[keyof typeof INTEGRATION_LIFECYCLE_STAGE];
  status?: (typeof INTEGRATION_LIFECYCLE_STATUS)[keyof typeof INTEGRATION_LIFECYCLE_STATUS];
  message: string;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await writeIntegrationLifecycleEvent(params.db, {
    integrationId: params.integrationId,
    stage: params.stage,
    status: params.status ?? INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: params.businessId ?? null,
    userId: params.userId,
    message: params.message,
    details: params.details ?? null,
  }).catch((error) => {
    log.warn(
      {
        integrationId: params.integrationId,
        stage: params.stage,
        status: params.status ?? INTEGRATION_LIFECYCLE_STATUS.PASSED,
        userId: params.userId,
        error: String(error),
      },
      "Failed to emit integration lifecycle event from auth route",
    );
  });
}

function githubOAuthErrorResponse(status: number, clearCookies: string | string[]): Response {
  const headers = new Headers({ [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" });
  for (const cookie of Array.isArray(clearCookies) ? clearCookies : [clearCookies]) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify({ error: GITHUB_OAUTH_GENERIC_ERROR }), {
    status,
    headers,
  });
}

export function normalizeGithubOAuthReturnTo(value: string | undefined): string | null {
  const rawValue = value?.trim();
  if (!rawValue || !rawValue.startsWith("/") || rawValue.startsWith("//")) return null;
  try {
    const parsed = new URL(rawValue, "https://app.trycycloid.com");
    if (parsed.origin !== "https://app.trycycloid.com") return null;
    // Re-validate after canonicalization: dot-segments (e.g. `/..//evil`) can
    // collapse into a protocol-relative path (`//evil`) that resolves to an
    // external origin during the post-auth redirect. Reject anything that is no
    // longer a strict single-slash relative path.
    const normalized = `${parsed.pathname}${parsed.search}`;
    if (!normalized.startsWith("/") || normalized.startsWith("//")) return null;
    return normalized;
  } catch {
    return null;
  }
}

function githubOAuthRedirectResponse(request: Request, env: Env): Response {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("GitHub OAuth not configured", 503);
  }

  const state = generateRandomHex(16);
  // Derive the redirect_uri host from the (allowlisted) serving host so the
  // callback — and its session_token Set-Cookie — lands on whichever UI host the
  // user is on. Fails closed to GITHUB_CALLBACK_URL when the host isn't allowlisted.
  const { callbackUrl } = resolveGithubOAuthHost(request, env);
  const returnTo = normalizeGithubOAuthReturnTo(new URL(request.url).searchParams.get("returnTo") ?? undefined);
  const headers = new Headers({
    location: `https://github.com${githubOAuthAuthorizePath(clientId, callbackUrl, state)}`,
  });
  headers.append(
    "set-cookie",
    setCookieHeader("oauth_state", state, { maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS, path: "/" }),
  );
  if (returnTo) {
    headers.append(
      "set-cookie",
      setCookieHeader(GITHUB_OAUTH_RETURN_TO_COOKIE, returnTo, { maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS, path: "/" }),
    );
  } else {
    headers.append("set-cookie", clearCookieHeader(GITHUB_OAUTH_RETURN_TO_COOKIE));
  }

  return new Response(null, {
    status: 302,
    headers,
  });
}

// Worker-served path prefixes. Paths under these are kept on the OAuth callback
// origin (the worker) — used by deep links like artifact downloads. Everything
// else (e.g. `/?sso=complete`, SPA routes) resolves against the frontend.
const WORKER_RETURN_TO_PREFIXES = ["/api/", "/auth/"];

export function githubOAuthReturnToRedirectUrl(returnTo: string | null, callbackUrl: URL, frontendUrl: string): string {
  // Defense in depth: even though the value is normalized before it is stored,
  // fall back to the frontend for anything that is not a strict single-slash
  // relative path so a protocol-relative or absolute value can never resolve to
  // an external origin here. Backslashes are excluded too: the WHATWG URL parser
  // treats `\` as `/`, so `/\evil.example` would otherwise resolve externally.
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    return frontendUrl;
  }
  const servedByWorker = WORKER_RETURN_TO_PREFIXES.some((prefix) => returnTo.startsWith(prefix));
  const base = servedByWorker ? `${callbackUrl.origin}/` : `${frontendUrl.replace(/\/$/, "")}/`;
  return new URL(returnTo, base).toString();
}

function githubOAuthDeniedResponse(clearCookies: string | string[]): Response {
  const headers = new Headers({ [HTTP_HEADER_NAMES.CONTENT_TYPE]: "text/html" });
  for (const cookie of Array.isArray(clearCookies) ? clearCookies : [clearCookies]) {
    headers.append("set-cookie", cookie);
  }
  return new Response(GITHUB_OAUTH_DENIED_HTML, {
    status: 403,
    headers,
  });
}

function notionSettingsRedirect(frontendUrl: string, clearStateCookie: string, errorCode?: string): Response {
  const location = errorCode
    ? `${frontendUrl}${NOTION_INTEGRATIONS_SETTINGS_PATH}?error=${errorCode}`
    : `${frontendUrl}${NOTION_INTEGRATIONS_SETTINGS_PATH}`;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": clearStateCookie,
    },
  });
}

function normalizeSlackWorkspaceInstallReturnTo(value: string | null | undefined): string {
  const rawValue = value?.trim();
  if (!rawValue || !rawValue.startsWith("/") || rawValue.startsWith("//")) {
    return SLACK_WORKSPACE_INSTALL_DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(rawValue, "https://app.trycycloid.com");
    const path = `${parsed.pathname}${parsed.search}`;
    return SLACK_WORKSPACE_INSTALL_ALLOWED_RETURN_TO.has(path) ? path : SLACK_WORKSPACE_INSTALL_DEFAULT_RETURN_TO;
  } catch {
    return SLACK_WORKSPACE_INSTALL_DEFAULT_RETURN_TO;
  }
}

function slackWorkspaceInstallRedirectLocation(
  env: Env,
  kind: "success" | "error",
  code: OAuthCallbackCode,
  returnTo: string | null | undefined,
): string {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const path = normalizeSlackWorkspaceInstallReturnTo(returnTo);
  const separator = path.includes("?") ? "&" : "?";
  return `${frontendUrl}${path}${separator}${kind}=${code}`;
}

function slackWorkspaceInstallClearCookies(clearStateCookie?: string): string[] {
  return [
    clearStateCookie ?? clearCookieHeader(SLACK_WORKSPACE_INSTALL_STATE_COOKIE),
    clearCookieHeader(SLACK_WORKSPACE_INSTALL_RETURN_TO_COOKIE),
  ];
}

function getRequestIp(request: Request): string | null {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const first = forwardedFor.split(",")[0]?.trim();
  return first || null;
}

async function checkUnknownGithubSignupRateLimit(
  kv: KVNamespace | undefined,
  ip: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!kv || !ip) return true;
  const bucket = Math.floor(now / (UNKNOWN_GITHUB_SIGNUP_RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `oauth:github:unknown-signup:${ip}:${bucket}`;
  const count = parseInt((await kv.get(key)) ?? "", 10) || 0;
  if (count >= UNKNOWN_GITHUB_SIGNUP_RATE_LIMIT_MAX) {
    return false;
  }
  await kv.put(key, String(count + 1), {
    expirationTtl: UNKNOWN_GITHUB_SIGNUP_RATE_LIMIT_WINDOW_SECONDS * 2,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Auth session KV cache
// ---------------------------------------------------------------------------

/**
 * Resolve an auth session with KV caching. On page load the browser fires
 * 3–5 authenticated endpoints in parallel; each would independently run the
 * same D1 JOIN query. Caching the result in KV for 60 s reduces those to at
 * most one D1 hit per burst.
 */
async function resolveAuthSessionCached(
  db: D1Database,
  token: string,
  kvCache: KVNamespace | undefined,
): Promise<AuthSessionResult> {
  const fetchSession = () => resolveAuthSession(db, token);
  if (!kvCache) return fetchSession();

  const hash = await computeSha256Hex(token);
  return getCachedOrFetch(hash, kvCache, fetchSession);
}

async function getCachedOrFetch(
  hash: string,
  kvCache: KVNamespace,
  fetchSession: () => Promise<AuthSessionResult>,
): Promise<AuthSessionResult> {
  const cacheKey = authSessionCacheKey(hash);
  try {
    const cached = (await kvCache.get(cacheKey, "json")) as AuthSessionResult | null;
    if (cached) return cached;
  } catch {
    // KV read failure is non-fatal; fall through to D1.
  }

  const result = await fetchSession();
  if (result.status === "ok") {
    // Fire-and-forget: don't block the response on a cache write.
    kvCache.put(cacheKey, JSON.stringify(result), { expirationTtl: AUTH_SESSION_CACHE_TTL }).catch(() => {});
  }

  return result;
}
// ---------------------------------------------------------------------------
// Shared OAuth scaffolding for integration flows (Slack, Linear, etc.)
// ---------------------------------------------------------------------------

interface OAuthStartContext {
  user: UserInfo;
  state: string;
}

/**
 * Resolve the logged-in user from the session cookie, verify that the
 * requested integration is enabled for their org, and mint a random state
 * value. Returns the context needed to build the provider redirect, or an
 * early-exit Response on failure.
 */
export async function resolveOAuthStart(
  request: Request,
  env: Env,
  integration: IntegrationId | "slack",
  options?: { checkAvailability?: boolean },
): Promise<OAuthStartContext | Response> {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;

  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }
  const user = await resolveAuthUser(env.DB, sessionToken);
  if (!user) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }

  if (
    (options?.checkAvailability ?? true) &&
    integration !== "slack" &&
    !(await isIntegrationAvailable(env.DB, user.id, integration))
  ) {
    const label = integration.charAt(0).toUpperCase() + integration.slice(1);
    return jsonErrorResponse(`${label} integration is disabled for your organization`, 403);
  }

  const state = generateRandomHex(16);
  return { user, state };
}

interface OAuthCallbackContext {
  user: UserInfo;
  code: string | null;
  clearStateCookie: string;
}

/**
 * Validate the OAuth state parameter against the stored cookie, then resolve
 * the logged-in user. Returns the context needed for provider-specific token
 * exchange, or an early-exit Response on failure.
 */
export async function resolveOAuthCallback(
  request: Request,
  url: URL,
  env: Env,
  cookieName: string,
): Promise<OAuthCallbackContext | Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const storedState = cookies[cookieName];
  const clearState = clearCookieHeader(cookieName);

  if (!state || state !== storedState) {
    return new Response(JSON.stringify({ error: "Invalid OAuth state" }), {
      status: 400,
      headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json", "set-cookie": clearState },
    });
  }

  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: HTTP_RESPONSE_BODY.UNAUTHORIZED }), {
      status: 401,
      headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json", "set-cookie": clearState },
    });
  }
  const user = await resolveAuthUser(env.DB, sessionToken);
  if (!user) {
    return new Response(JSON.stringify({ error: HTTP_RESPONSE_BODY.UNAUTHORIZED }), {
      status: 401,
      headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json", "set-cookie": clearState },
    });
  }

  return { user, code: code ?? null, clearStateCookie: clearState };
}

function impersonationUnauthorized(): Response {
  const headers = new Headers({ [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" });
  headers.append("set-cookie", clearCookieHeader(IMPERSONATION_COOKIE_NAME));
  return new Response(JSON.stringify({ ok: false, error: HTTP_RESPONSE_BODY.UNAUTHORIZED }), { status: 401, headers });
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  const bearerToken = parseBearerToken(request);

  // Impersonation cookie takes precedence over any other browser auth. If present
  // but expired/revoked/unknown, fail closed and clear the cookie — never silently
  // fall back to session_token.
  const impersonationCookie = parseImpersonationTokenCookie(request);
  if (impersonationCookie) {
    const db = env.DB;
    if (!db) {
      return { ok: false, response: jsonErrorResponse("Auth backend unavailable", 503) };
    }
    const tokenHash = await computeSha256Hex(impersonationCookie);
    const result = await resolveImpersonationByTokenHash(db, tokenHash);
    if (result.status !== "ok") {
      return { ok: false, response: impersonationUnauthorized() };
    }
    const { row, target, actor } = result.resolved;
    return {
      ok: true,
      auth: {
        userId: String(target.id),
        tokenSource: "session_token",
        authMode: "impersonated_user_session",
        canAccessAllSessions: false,
        user: target,
        actorUserId: String(actor.id),
        actorUser: actor,
        actorGithubUserId: actor.githubUserId ?? null,
        impersonationId: row.id,
        readOnly: true,
      },
    };
  }

  if (bearerToken && env.ARCANIST_ADMIN_TOKEN && timingSafeEqualString(bearerToken, env.ARCANIST_ADMIN_TOKEN)) {
    const url = new URL(request.url);
    log.warn(
      {
        action: "admin_token_used",
        method: request.method,
        path: url.pathname,
        requestId: request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID),
      },
      "Admin token used for authentication",
    );
    return {
      ok: true,
      auth: {
        userId: "admin-token",
        tokenSource: "bearer",
        authMode: "admin_token",
        canAccessAllSessions: true,
      },
    };
  }

  if (bearerToken && env.CI_AUTOMATION_TOKEN && timingSafeEqualString(bearerToken, env.CI_AUTOMATION_TOKEN)) {
    return {
      ok: true,
      auth: {
        userId: "ci-automation-token",
        tokenSource: "bearer",
        authMode: "ci_automation_token",
        canAccessAllSessions: false,
      },
    };
  }

  // CLI personal access tokens: detected by arc_ prefix on bearer token only (never cookies)
  if (bearerToken?.startsWith("arc_")) {
    const db = env.DB;
    if (!db) {
      return { ok: false, response: jsonErrorResponse("Auth backend unavailable", 503) };
    }
    const resolved = await resolveCliToken(db, bearerToken);
    if (resolved.status !== "ok") {
      return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
    }
    return {
      ok: true,
      auth: {
        userId: String(resolved.user.id),
        tokenSource: "bearer",
        authMode: "cli_token",
        canAccessAllSessions: false,
        cliTokenScope: resolved.scope,
        cliTokenId: resolved.tokenId,
        user: resolved.user,
      },
    };
  }

  const sessionToken = parseSessionTokenCookie(request);
  const token = bearerToken || sessionToken;
  if (!token) {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
  }

  const db = env.DB;
  if (!db) {
    return { ok: false, response: jsonErrorResponse("Auth backend unavailable", 503) };
  }

  const resolved = await resolveAuthSessionCached(db, token, env.RATE_LIMITS);
  if (resolved.status !== "ok") {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
  }

  return {
    ok: true,
    auth: {
      userId: String(resolved.user.id),
      tokenSource: bearerToken ? "bearer" : "session_token",
      authMode: "user_session",
      canAccessAllSessions: false,
      user: resolved.user,
      ...(resolved.readOnly ? { readOnly: true as const } : {}),
    },
  };
}

export async function handleAuthGithub(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const challenge = renderTurnstileAuthForm(request, env);
    if (challenge) return challenge;
  } else {
    const challengeError = await verifyTurnstileAuthRequest(request, env);
    if (challengeError) return challengeError;
  }

  return githubOAuthRedirectResponse(request, env);
}

export async function handleAuthCallback(
  request: Request,
  url: URL,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const storedState = cookies.oauth_state;
  const clearStateCookie = clearCookieHeader("oauth_state");
  const clearReturnToCookie = clearCookieHeader(GITHUB_OAUTH_RETURN_TO_COOKIE);
  const clearGithubOAuthCookies = [clearStateCookie, clearReturnToCookie];
  const returnTo = normalizeGithubOAuthReturnTo(cookies[GITHUB_OAUTH_RETURN_TO_COOKIE]);
  const requestId = request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID);
  let githubLogin: string | null = null;

  if (!state || state !== storedState) {
    log.warn(
      { requestId, hasState: !!state, hasStoredState: !!storedState },
      "GitHub OAuth callback denied: invalid state",
    );
    return githubOAuthErrorResponse(400, clearGithubOAuthCookies);
  }

  try {
    const clientId = env.GITHUB_CLIENT_ID;
    const clientSecret = env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      log.error(
        { requestId, hasClientId: !!clientId, hasClientSecret: !!clientSecret },
        "GitHub OAuth callback failed: OAuth not configured",
      );
      return githubOAuthErrorResponse(503, clearGithubOAuthCookies);
    }

    const tokenRes = await tracedFetch(
      GITHUB_TOKEN_URL,
      {
        method: "POST",
        headers: { accept: "application/json", [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      },
      "github.oauth",
    );
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!tokenData.access_token) {
      log.warn(
        { requestId, status: tokenRes.status, providerError: tokenData.error ?? null },
        "GitHub OAuth callback failed: token exchange returned no access token",
      );
      return githubOAuthErrorResponse(502, clearGithubOAuthCookies);
    }

    const userRes = await tracedFetch(
      "https://api.github.com/user",
      {
        headers: {
          [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${tokenData.access_token}`,
          accept: "application/json",
          "user-agent": "cycloid-worker",
        },
      },
      "github.userFetch",
    );
    if (!userRes.ok) {
      log.warn({ requestId, status: userRes.status }, "GitHub OAuth callback failed: user fetch failed");
      return githubOAuthErrorResponse(502, clearGithubOAuthCookies);
    }
    const ghUser = (await userRes.json()) as {
      id?: number;
      login?: string;
      name?: string;
      email?: string;
      avatar_url?: string;
    };
    if (!ghUser.id || !ghUser.login) {
      log.warn(
        { requestId, githubUserId: ghUser.id ?? null, hasLogin: !!ghUser.login },
        "GitHub OAuth callback failed: invalid user response",
      );
      return githubOAuthErrorResponse(502, clearGithubOAuthCookies);
    }
    githubLogin = ghUser.login;

    const db = env.DB;
    // The callback is proxied through the SAME UI host the user signed in from,
    // so X-Forwarded-Host re-derives the frontend origin the session_token cookie
    // and post-login redirect must target. Fails closed to FRONTEND_URL.
    const { frontendUrl } = resolveGithubOAuthHost(request, env);

    let approvedUser = await getUserByGithubId(db, ghUser.id);
    if (!approvedUser) {
      // Self-serve signup: user has no users row yet. Funnel into pending_signups.
      const pending = await getPendingSignupByGithubId(db, ghUser.id);
      if (pending?.deniedAt) {
        log.warn(
          { requestId, githubLogin: ghUser.login, githubUserId: ghUser.id, reason: "denied" },
          "GitHub OAuth callback: previously denied signup",
        );
        return new Response(null, {
          status: 302,
          headers: [
            ["location", `${frontendUrl}/denied`],
            ["set-cookie", clearStateCookie],
            ["set-cookie", clearReturnToCookie],
          ],
        });
      }

      const allowed = await checkUnknownGithubSignupRateLimit(env.RATE_LIMITS, getRequestIp(request));
      if (!allowed) {
        log.warn(
          { requestId, githubLogin: ghUser.login, githubUserId: ghUser.id, reason: "rate_limited_pending_signup" },
          "GitHub OAuth callback denied: unknown-user signup rate limited",
        );
        return githubOAuthErrorResponse(429, clearGithubOAuthCookies);
      }

      const inserted = await upsertPendingSignup(
        db,
        {
          githubId: ghUser.id,
          login: ghUser.login,
          name: ghUser.name ?? null,
          email: ghUser.email ?? null,
          avatarUrl: ghUser.avatar_url ?? null,
        },
        Date.now(),
      );
      approvedUser = await getUserByGithubId(db, ghUser.id);
      if (approvedUser) {
        await deletePendingSignupByGithubId(db, ghUser.id);
        log.warn(
          {
            requestId,
            githubLogin: ghUser.login,
            githubUserId: ghUser.id,
            userId: approvedUser.id,
            action: "pending_signup_race_cleaned_up",
          },
          "GitHub OAuth callback: removed stale pending signup for existing user",
        );
      } else if (inserted) {
        log.info(
          { requestId, githubLogin: ghUser.login, githubUserId: ghUser.id, action: "pending_signup_created" },
          "GitHub OAuth callback: created pending signup",
        );
        const eventPromise = postStructuredEventToDd(env, {
          event: "pending_signup_created",
        }).catch((error) => {
          log.warn({ requestId, error: String(error) }, "GitHub OAuth callback: pending signup event export failed");
          return false;
        });
        const notifyPromise = notifyCycloidAdminOfPendingSignup(env, {
          githubLogin: ghUser.login,
          githubId: ghUser.id,
          name: ghUser.name ?? null,
          email: ghUser.email ?? null,
          frontendUrl,
        });
        // Slack and telemetry delivery are best-effort and must not delay the OAuth redirect.
        if (ctx) {
          ctx.waitUntil(eventPromise);
          ctx.waitUntil(notifyPromise);
        } else {
          void eventPromise;
          void notifyPromise;
        }
      } else {
        log.info(
          { requestId, githubLogin: ghUser.login, githubUserId: ghUser.id, action: "pending_signup_revisited" },
          "GitHub OAuth callback: pending signup already exists",
        );
      }
      if (!approvedUser) {
        return new Response(null, {
          status: 302,
          headers: [
            ["location", `${frontendUrl}/pending`],
            ["set-cookie", clearStateCookie],
            ["set-cookie", clearReturnToCookie],
          ],
        });
      }
    }

    // Existing approved user: look up their business membership and proceed with normal login.
    const businessId = await getUserBusinessIdOrNull(db, approvedUser.id);
    if (!businessId) {
      // Should not happen: existing users always have business_id NOT NULL.
      log.error(
        { requestId, githubLogin: ghUser.login, githubUserId: ghUser.id, userId: approvedUser.id },
        "GitHub OAuth callback: existing user missing business_id",
      );
      return githubOAuthErrorResponse(500, clearGithubOAuthCookies);
    }

    const userId = await persistAuthenticatedGitHubUser(
      db,
      { id: ghUser.id, login: ghUser.login, name: ghUser.name, email: ghUser.email, avatar_url: ghUser.avatar_url },
      {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? null,
        expiresAt: expiresInToTimestamp(tokenData.expires_in),
      },
      businessId,
      env.TOKEN_ENCRYPTION_KEY,
    );
    log.info(
      { userId, githubUserId: ghUser.id, businessId, action: "github_oauth_login" },
      "GitHub OAuth login succeeded",
    );
    // A fresh OAuth (re)authorization may grant SAML SSO access to orgs whose
    // repos were previously withheld. Drop the user's repo caches so the next
    // fetch reflects the new grant instead of serving the stale (empty) list.
    try {
      await invalidateReposCacheForUser(env, userId);
    } catch (err) {
      log.warn({ userId, error: String(err) }, "Failed to invalidate repos cache after OAuth login");
    }
    const sessionToken = await createAuthSession(db, userId);

    // Check if the user has an installation of THIS GitHub App (not any app).
    // The OAuth token has `repo` scope so /user/repos returns all repos regardless of app install.
    let redirectUrl = githubOAuthReturnToRedirectUrl(returnTo, url, frontendUrl);
    try {
      const appId = env.GITHUB_APP_ID;
      const installCheckRes = await tracedFetch(
        "https://api.github.com/user/installations?per_page=100",
        {
          headers: {
            [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${tokenData.access_token}`,
            accept: "application/vnd.github+json",
            "user-agent": "cycloid-worker",
          },
        },
        "github.installationCheck",
      );
      if (installCheckRes.ok) {
        const data = (await installCheckRes.json()) as {
          installations: Array<{ app_id: number }>;
        };
        const hasOurApp = data.installations.some((i) => String(i.app_id) === String(appId));
        if (!hasOurApp) {
          const slug = await getAppSlug(env);
          redirectUrl = `https://github.com/apps/${slug}/installations/new`;
        }
      }
    } catch (err) {
      // Non-fatal: if the check fails, just send them to the frontend
      log.warn({ error: String(err) }, "Installation check after OAuth failed, skipping install redirect");
    }

    const headers: [string, string][] = [
      ["location", redirectUrl],
      ["set-cookie", clearStateCookie],
      ["set-cookie", clearReturnToCookie],
      ["set-cookie", setCookieHeader("session_token", sessionToken, { path: "/", maxAge: SESSION_TTL_MS })],
    ];
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof BusinessMismatchError) {
      log.warn(
        {
          requestId,
          githubLogin,
          storedBusinessId: err.storedBusinessId,
          requestedBusinessId: err.requestedBusinessId,
          action: "business_mismatch_denied",
        },
        "GitHub OAuth callback denied: business mismatch",
      );
      return githubOAuthDeniedResponse(clearGithubOAuthCookies);
    }
    Sentry.captureException(err);
    log.error({ requestId, githubLogin, error: String(err) }, "OAuth callback failed");
    return githubOAuthErrorResponse(502, clearGithubOAuthCookies);
  }
}

export async function handleAuthLinear(request: Request, env: Env): Promise<Response> {
  const clientId = env.LINEAR_OAUTH_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Linear OAuth not configured", 503);
  }

  const result = await resolveOAuthStart(request, env, "linear");
  if (result instanceof Response) return result;

  const callbackUrl = env.LINEAR_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/linear/callback";

  return new Response(null, {
    status: 302,
    headers: {
      location: `https://linear.app/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${LINEAR_OAUTH_SCOPE}&response_type=code&state=${result.state}`,
      "set-cookie": setCookieHeader(LINEAR_OAUTH_STATE_COOKIE, result.state, {
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
        path: "/",
      }),
    },
  });
}

export async function handleAuthLinearBusiness(request: Request, env: Env): Promise<Response> {
  const clientId = env.LINEAR_OAUTH_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Linear OAuth not configured", 503);
  }

  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const businessSettingsPath = "/settings/business-integrations";
  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }
  const user = await resolveAuthUser(env.DB, sessionToken);
  if (!user) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }
  if (user.businessRole !== "admin") {
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${businessSettingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_BUSINESS_ADMIN_REQUIRED}`,
      },
    });
  }
  if (!(await isIntegrationAvailable(env.DB, user.id, "linear"))) {
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${businessSettingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_INTEGRATION_DISABLED}`,
      },
    });
  }

  const state = generateRandomHex(16);
  const callbackUrl = env.LINEAR_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/linear/callback";
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://linear.app/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${LINEAR_OAUTH_SCOPE}&response_type=code&state=${state}`,
      "set-cookie": setCookieHeader(LINEAR_BUSINESS_OAUTH_STATE_COOKIE, state, {
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
        path: "/",
      }),
    },
  });
}

export async function handleAuthLinearCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const isBusinessSetup = !!state && cookies[LINEAR_BUSINESS_OAUTH_STATE_COOKIE] === state;
  const stateCookieName = isBusinessSetup ? LINEAR_BUSINESS_OAUTH_STATE_COOKIE : LINEAR_OAUTH_STATE_COOKIE;
  const settingsPath = isBusinessSetup ? "/settings/business-integrations" : "/settings/integrations";

  try {
    const result = await resolveOAuthCallback(request, url, env, stateCookieName);
    if (result instanceof Response) return result;
    const { user, code, clearStateCookie } = result;

    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "linear",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_CALLBACK_RECEIVED,
      message: "Linear OAuth callback received.",
      details: {
        provider: "linear",
        credentialScope: isBusinessSetup ? "business" : "user",
      },
    });

    if (!code) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_CONNECT_FAILED}`,
          "set-cookie": clearStateCookie,
        },
      });
    }

    if (isBusinessSetup && user.businessRole !== "admin") {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_CONNECT_FAILED}`,
          "set-cookie": clearStateCookie,
        },
      });
    }

    const clientId = env.LINEAR_OAUTH_CLIENT_ID;
    const clientSecret = env.LINEAR_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return jsonErrorResponse("Linear OAuth not configured", 503);
    }

    const callbackUrl = env.LINEAR_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/linear/callback";
    const tokenRes = await tracedFetch(
      LINEAR_TOKEN_URL,
      {
        method: "POST",
        headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          code,
        }),
      },
      "linear.oauth",
    );
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.access_token) {
      log.error({ error: tokenData.error, status: tokenRes.status }, "Linear token exchange failed");
      return new Response(null, {
        status: 302,
        headers: {
          location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_CONNECT_FAILED}`,
          "set-cookie": clearStateCookie,
        },
      });
    }

    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "linear",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_TOKEN_EXCHANGED,
      message: "Linear OAuth token exchange succeeded.",
      details: {
        provider: "linear",
        credentialScope: isBusinessSetup ? "business" : "user",
      },
    });

    // Fetch the Linear user's UUID for webhook actor resolution
    let linearViewerId: string | undefined;
    let linearOrganizationId: string | undefined;
    let linearOrganizationName: string | undefined;
    let linearOrganizationUrlKey: string | undefined;
    let viewerWarning = false;
    try {
      const viewerRes = await tracedFetch(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: {
            [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${tokenData.access_token}`,
            [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json",
          },
          body: JSON.stringify({
            query: isBusinessSetup ? "{ viewer { id organization { id name urlKey } } }" : "{ viewer { id } }",
          }),
        },
        "linear.viewer",
      );
      if (viewerRes.ok) {
        const viewerData = (await viewerRes.json()) as {
          data?: { viewer?: { id?: string; organization?: { id?: string; name?: string; urlKey?: string } } };
        };
        linearViewerId = viewerData?.data?.viewer?.id ?? undefined;
        linearOrganizationId = viewerData?.data?.viewer?.organization?.id ?? undefined;
        linearOrganizationName = viewerData?.data?.viewer?.organization?.name ?? undefined;
        linearOrganizationUrlKey = viewerData?.data?.viewer?.organization?.urlKey ?? undefined;
        if (!linearViewerId) {
          log.warn({ userId: user.id }, "Linear viewer query returned no ID");
          viewerWarning = true;
        }
        if (isBusinessSetup && !linearOrganizationId) {
          log.warn({ userId: user.id }, "Linear viewer query returned no organization ID");
          viewerWarning = true;
        }
      } else {
        log.warn({ userId: user.id, status: viewerRes.status }, "Linear viewer query failed");
        viewerWarning = true;
      }
    } catch (err) {
      log.warn({ userId: user.id, error: String(err) }, "Linear viewer query failed");
      viewerWarning = true;
    }

    try {
      await storeLinearTokens(
        env.DB,
        user.id,
        tokenData.access_token,
        tokenData.refresh_token ?? null,
        tokenData.expires_in ?? 86_400,
        env.TOKEN_ENCRYPTION_KEY,
        linearViewerId,
      );
      resetAuthMeUserCache();
    } catch (err) {
      // Unique constraint on (integration_id, external_user_id) -- same Linear account linked to another user
      const errMsg = String(err);
      if (errMsg.includes("UNIQUE constraint failed") || errMsg.includes("unique")) {
        log.warn({ userId: user.id, linearViewerId }, "Linear account already connected to another user");
        return new Response(null, {
          status: 302,
          headers: {
            location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_ACCOUNT_ALREADY_CONNECTED}`,
            "set-cookie": clearStateCookie,
          },
        });
      }
      throw err;
    }

    if (isBusinessSetup) {
      if (!linearOrganizationId) {
        log.warn({ userId: user.id }, "Linear business OAuth callback missing organization ID");
        return new Response(null, {
          status: 302,
          headers: {
            location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_CONNECT_FAILED}`,
            "set-cookie": clearStateCookie,
          },
        });
      }
      await upsertLinearWebhookInstallation(env.DB, {
        businessId: user.businessId,
        linearOrganizationId,
        linearOrganizationName: linearOrganizationName ?? null,
        linearOrganizationUrlKey: linearOrganizationUrlKey ?? null,
        connectedByUserId: user.id,
      });
      await emitAuthLifecycleEvent({
        db: env.DB,
        integrationId: "linear",
        userId: user.id,
        businessId: user.businessId,
        stage: INTEGRATION_LIFECYCLE_STAGE.WORKSPACE_BOUND,
        message: "Linear business workspace is bound for webhook ingress.",
        details: {
          provider: "linear",
          workspaceId: linearOrganizationId,
        },
      });
    }

    log.info(
      { userId: user.id, linearViewerId, linearOrganizationId, linearOrganizationUrlKey, isBusinessSetup },
      "Linear OAuth connected",
    );

    const redirectParams = viewerWarning ? `?warning=${OAUTH_CALLBACK_CODES.LINEAR_ID_FETCH_FAILED}` : "";
    return new Response(null, {
      status: 302,
      headers: [
        ["location", `${frontendUrl}${settingsPath}${redirectParams}`],
        ["set-cookie", clearStateCookie],
      ],
    });
  } catch (err) {
    Sentry.captureException(err);
    log.error({ error: String(err) }, "Linear OAuth callback failed");
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${settingsPath}?error=${OAUTH_CALLBACK_CODES.LINEAR_CONNECT_FAILED}`,
        "set-cookie": clearCookieHeader(stateCookieName),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Jira OAuth (Atlassian 3LO)
// ---------------------------------------------------------------------------

const JIRA_OAUTH_STATE_COOKIE = "jira_oauth_state";
const JIRA_BUSINESS_OAUTH_STATE_COOKIE = "jira_business_oauth_state";
const JIRA_SETTINGS_PATH = "/settings/integrations";
const JIRA_BUSINESS_SETTINGS_PATH = "/settings/business-integrations";

interface JiraAccessibleSite {
  cloudId: string;
  url: string;
  name: string | null;
}

interface JiraTokenExchange {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

function jiraAuthorizeRedirect(params: {
  clientId: string;
  callbackUrl: string;
  scope: string;
  state: string;
  stateCookie: string;
}): Response {
  const location =
    `${JIRA_AUTHORIZE_URL}?audience=api.atlassian.com&client_id=${encodeURIComponent(params.clientId)}` +
    `&scope=${encodeURIComponent(params.scope)}&redirect_uri=${encodeURIComponent(params.callbackUrl)}` +
    `&state=${params.state}&response_type=code&prompt=consent`;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": setCookieHeader(params.stateCookie, params.state, {
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
        path: "/",
      }),
    },
  });
}

export async function handleAuthJira(request: Request, env: Env): Promise<Response> {
  const clientId = env.JIRA_OAUTH_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Jira OAuth not configured", 503);
  }

  const result = await resolveOAuthStart(request, env, "jira");
  if (result instanceof Response) return result;

  const callbackUrl = env.JIRA_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/jira/callback";
  return jiraAuthorizeRedirect({
    clientId,
    callbackUrl,
    scope: JIRA_OAUTH_USER_SCOPE,
    state: result.state,
    stateCookie: JIRA_OAUTH_STATE_COOKIE,
  });
}

export async function handleAuthJiraBusiness(request: Request, env: Env): Promise<Response> {
  const clientId = env.JIRA_OAUTH_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Jira OAuth not configured", 503);
  }

  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }
  const user = await resolveAuthUser(env.DB, sessionToken);
  if (!user) {
    return new Response(null, { status: 302, headers: { location: `${frontendUrl}/settings` } });
  }
  if (user.businessRole !== "admin") {
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${JIRA_BUSINESS_SETTINGS_PATH}?error=${OAUTH_CALLBACK_CODES.JIRA_BUSINESS_ADMIN_REQUIRED}`,
      },
    });
  }
  if (!(await isIntegrationAvailable(env.DB, user.id, "jira"))) {
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${JIRA_BUSINESS_SETTINGS_PATH}?error=${OAUTH_CALLBACK_CODES.JIRA_INTEGRATION_DISABLED}`,
      },
    });
  }

  const state = generateRandomHex(16);
  const callbackUrl = env.JIRA_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/jira/callback";
  return jiraAuthorizeRedirect({
    clientId,
    callbackUrl,
    scope: JIRA_OAUTH_BUSINESS_SCOPE,
    state,
    stateCookie: JIRA_BUSINESS_OAUTH_STATE_COOKIE,
  });
}

async function fetchJiraAccessibleSites(accessToken: string): Promise<JiraAccessibleSite[] | null> {
  try {
    const res = await tracedFetch(
      JIRA_ACCESSIBLE_RESOURCES_URL,
      { headers: { [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${accessToken}`, accept: "application/json" } },
      "jira.accessibleResources",
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "Jira accessible-resources fetch failed");
      return null;
    }
    const data = (await res.json()) as Array<{ id?: string; url?: string; name?: string }>;
    if (!Array.isArray(data)) return null;
    return data
      .filter((site): site is { id: string; url: string; name?: string } => Boolean(site?.id && site?.url))
      .map((site) => ({ cloudId: site.id, url: site.url, name: site.name ?? null }));
  } catch (err) {
    log.warn({ error: String(err) }, "Jira accessible-resources fetch failed");
    return null;
  }
}

async function fetchJiraAccountId(accessToken: string): Promise<string | null> {
  try {
    const res = await tracedFetch(
      JIRA_ME_URL,
      { headers: { [HTTP_HEADER_NAMES.AUTHORIZATION]: `Bearer ${accessToken}`, accept: "application/json" } },
      "jira.me",
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "Jira /me fetch failed");
      return null;
    }
    const data = (await res.json()) as { account_id?: string };
    return data.account_id ?? null;
  } catch (err) {
    log.warn({ error: String(err) }, "Jira /me fetch failed");
    return null;
  }
}

/**
 * Shared terminal step for both the single-site callback path and the
 * multi-site finalize endpoint: store encrypted tokens, record the selected
 * site, and (business flow) persist the webhook workspace binding.
 */
async function finalizeJiraConnection(params: {
  env: Env;
  user: UserInfo;
  flow: "user" | "business";
  tokens: JiraTokenExchange;
  site: JiraAccessibleSite;
  accountId: string | null;
}): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  const { env, user, flow, tokens, site, accountId } = params;
  const previousJiraAccountIds = accountId ? await listJiraPersonalDataReportAccountIdsForUser(env.DB, user.id) : [];

  try {
    await storeJiraTokens(
      env.DB,
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresIn,
      env.TOKEN_ENCRYPTION_KEY,
      accountId ?? undefined,
    );
    resetAuthMeUserCache();
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("UNIQUE constraint failed") || errMsg.includes("unique")) {
      log.warn({ userId: user.id, accountId }, "Jira account already connected to another user");
      return { ok: false, errorCode: OAUTH_CALLBACK_CODES.JIRA_ACCOUNT_ALREADY_CONNECTED };
    }
    throw err;
  }

  if (accountId) {
    const now = Date.now();
    await upsertJiraUserSite(env.DB, {
      userId: user.id,
      jiraCloudId: site.cloudId,
      siteUrl: site.url,
      siteName: site.name,
      jiraAccountId: accountId,
    });
    await upsertJiraPersonalDataReportAccount(env.DB, {
      jiraAccountId: accountId,
      personalDataUpdatedAt: now,
      now,
    });
    await deleteUnreferencedJiraPersonalDataReportAccounts(
      env.DB,
      previousJiraAccountIds.filter((previousAccountId) => previousAccountId !== accountId),
    );
  } else {
    // Fail closed: without a fresh account ID the new tokens may belong to a
    // different Atlassian account, so a surviving mapping from a previous
    // connection would attribute the old account's webhook activity to this
    // user. Drop it rather than leave it stale.
    await deleteJiraUserSite(env.DB, user.id);
    log.warn({ userId: user.id }, "Jira connection finalized without account ID; webhook actor mapping unavailable");
  }

  if (flow === "business") {
    const installationToken = generateRandomHex(32);
    try {
      await upsertJiraWebhookInstallation(env.DB, {
        businessId: user.businessId,
        jiraCloudId: site.cloudId,
        siteUrl: site.url,
        siteName: site.name,
        installationToken,
        connectedByUserId: user.id,
      });
    } catch (err) {
      if (String(err).includes("UNIQUE constraint failed") || String(err).includes("unique")) {
        log.warn({ userId: user.id, jiraCloudId: site.cloudId }, "Jira site is already bound to another business");
        return { ok: false, errorCode: OAUTH_CALLBACK_CODES.JIRA_SITE_ALREADY_BOUND };
      }
      throw err;
    }
    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "jira",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.WORKSPACE_BOUND,
      message: "Jira business workspace is bound for webhook ingress.",
      details: { provider: "jira", workspaceId: site.cloudId, siteUrl: site.url },
    });

    // Register the dynamic webhooks now that the binding row exists. A failure
    // marks the installation degraded (visible in settings) rather than
    // failing the connect: the binding credential is stored, so a reconnect or
    // the refresh cron can recover registration.
    const { registerJiraWebhooks } = await import("../webhooks/jira-registration.js");
    const registered = await registerJiraWebhooks(env, env.DB, {
      businessId: user.businessId,
      jiraCloudId: site.cloudId,
      installationToken,
      connectedByUserId: user.id,
    });
    if (!registered) {
      log.warn(
        { userId: user.id, businessId: user.businessId, jiraCloudId: site.cloudId },
        "Jira webhook registration failed during workspace bind; installation marked degraded",
      );
    }
  }

  log.info(
    { userId: user.id, jiraCloudId: site.cloudId, hasAccountId: Boolean(accountId), flow },
    "Jira OAuth connected",
  );
  return { ok: true };
}

export async function handleAuthJiraCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const isBusinessSetup = !!state && cookies[JIRA_BUSINESS_OAUTH_STATE_COOKIE] === state;
  const stateCookieName = isBusinessSetup ? JIRA_BUSINESS_OAUTH_STATE_COOKIE : JIRA_OAUTH_STATE_COOKIE;
  const settingsPath = isBusinessSetup ? JIRA_BUSINESS_SETTINGS_PATH : JIRA_SETTINGS_PATH;
  const flow: "user" | "business" = isBusinessSetup ? "business" : "user";

  const errorRedirect = (errorCode: string, clearStateCookie: string): Response =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}${settingsPath}?error=${errorCode}`,
        "set-cookie": clearStateCookie,
      },
    });

  try {
    const result = await resolveOAuthCallback(request, url, env, stateCookieName);
    if (result instanceof Response) return result;
    const { user, code, clearStateCookie } = result;

    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "jira",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_CALLBACK_RECEIVED,
      message: "Jira OAuth callback received.",
      details: { provider: "jira", credentialScope: flow },
    });

    if (!code) {
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_CONNECT_FAILED, clearStateCookie);
    }

    // Scope can change during the OAuth round trip: re-check before storing anything.
    if (!(await isIntegrationAvailable(env.DB, user.id, "jira"))) {
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_INTEGRATION_DISABLED, clearStateCookie);
    }
    if (isBusinessSetup && user.businessRole !== "admin") {
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_BUSINESS_ADMIN_REQUIRED, clearStateCookie);
    }

    const clientId = env.JIRA_OAUTH_CLIENT_ID;
    const clientSecret = env.JIRA_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return jsonErrorResponse("Jira OAuth not configured", 503);
    }

    const callbackUrl = env.JIRA_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/jira/callback";
    const tokenRes = await tracedFetch(
      JIRA_TOKEN_URL,
      {
        method: "POST",
        headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      },
      "jira.oauth",
    );
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.access_token) {
      log.error({ error: tokenData.error, status: tokenRes.status }, "Jira token exchange failed");
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_CONNECT_FAILED, clearStateCookie);
    }

    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "jira",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_TOKEN_EXCHANGED,
      message: "Jira OAuth token exchange succeeded.",
      details: { provider: "jira", credentialScope: flow },
    });

    const tokens: JiraTokenExchange = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresIn: tokenData.expires_in ?? 3600,
    };

    const sites = await fetchJiraAccessibleSites(tokens.accessToken);
    if (!sites || sites.length === 0) {
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_SITE_FETCH_FAILED, clearStateCookie);
    }

    const accountId = await fetchJiraAccountId(tokens.accessToken);

    if (sites.length === 1) {
      const finalized = await finalizeJiraConnection({ env, user, flow, tokens, site: sites[0], accountId });
      if (!finalized.ok) {
        return errorRedirect(finalized.errorCode, clearStateCookie);
      }
      const redirectParams = accountId ? "" : `?warning=${OAUTH_CALLBACK_CODES.JIRA_ID_FETCH_FAILED}`;
      return new Response(null, {
        status: 302,
        headers: [
          ["location", `${frontendUrl}${settingsPath}${redirectParams}`],
          ["set-cookie", clearStateCookie],
        ],
      });
    }

    // Multiple sites: hold tokens server-side and let the settings UI finalize.
    if (!env.TOKEN_ENCRYPTION_KEY) {
      log.error({ userId: user.id }, "TOKEN_ENCRYPTION_KEY missing -- cannot hold pending Jira tokens");
      return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_CONNECT_FAILED, clearStateCookie);
    }
    const nonce = generateRandomHex(32);
    const tokenPayload = await encrypt(JSON.stringify(tokens), env.TOKEN_ENCRYPTION_KEY);
    await insertJiraOAuthPending(env.DB, {
      nonce,
      userId: user.id,
      flow,
      tokenPayload,
      sitesJson: JSON.stringify(sites),
      jiraAccountId: accountId,
      ttlMs: JIRA_OAUTH_PENDING_TTL_MS,
    });
    return new Response(null, {
      status: 302,
      headers: [
        ["location", `${frontendUrl}${settingsPath}?jira_site_selection=${nonce}`],
        ["set-cookie", clearStateCookie],
      ],
    });
  } catch (err) {
    Sentry.captureException(err);
    log.error({ error: String(err) }, "Jira OAuth callback failed");
    return errorRedirect(OAUTH_CALLBACK_CODES.JIRA_CONNECT_FAILED, clearCookieHeader(stateCookieName));
  }
}

/** Lists the pending sites for the picker. The nonce alone is not enough: the caller must be the initiating user. */
export async function handleJiraPendingSites(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("nonce") ?? "";
  const pending = await getJiraOAuthPending(env.DB, nonce);
  if (!pending || pending.userId !== Number(auth.userId) || pending.expiresAt <= Date.now()) {
    return jsonErrorResponse("Site selection expired or not found", 404);
  }
  return jsonResponse({ ok: true, flow: pending.flow, sites: JSON.parse(pending.sitesJson) });
}

export async function handleJiraFinalize(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const body = await parseJsonBody(request);
  const nonce = typeof body?.nonce === "string" ? body.nonce : "";
  const cloudId = typeof body?.cloudId === "string" ? body.cloudId : "";
  if (!nonce || !cloudId) {
    return jsonErrorResponse("nonce and cloudId are required", 400);
  }

  const pending = await getJiraOAuthPending(env.DB, nonce);
  if (!pending || pending.userId !== Number(auth.userId) || pending.expiresAt <= Date.now()) {
    return jsonErrorResponse("Site selection expired or not found", 404);
  }

  const sites = JSON.parse(pending.sitesJson) as JiraAccessibleSite[];
  const site = sites.find((candidate) => candidate.cloudId === cloudId);
  if (!site) {
    return jsonErrorResponse("Unknown cloudId for this selection", 400);
  }

  const user = auth.user;
  if (!user) {
    return jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401);
  }
  // Re-checks: availability/role can change between callback and finalize.
  if (!(await isIntegrationAvailable(env.DB, user.id, "jira"))) {
    return jsonErrorResponse("Jira integration is disabled for your organization", 403);
  }
  if (pending.flow === "business" && user.businessRole !== "admin") {
    return jsonErrorResponse("Only business admins can bind a Jira workspace", 403);
  }

  // Single-use: the DELETE is the atomic claim against concurrent finalizes.
  if (!(await consumeJiraOAuthPending(env.DB, nonce))) {
    return jsonErrorResponse("Site selection expired or not found", 404);
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    return jsonErrorResponse("Jira OAuth not configured", 503);
  }
  const tokens = JSON.parse(await decrypt(pending.tokenPayload, env.TOKEN_ENCRYPTION_KEY)) as JiraTokenExchange;

  const finalized = await finalizeJiraConnection({
    env,
    user,
    flow: pending.flow,
    tokens,
    site,
    accountId: pending.jiraAccountId,
  });
  if (!finalized.ok) {
    return jsonResponse({ ok: false, error: finalized.errorCode }, 409);
  }
  return jsonResponse({ ok: true, cloudId: site.cloudId, siteUrl: site.url });
}

export async function handleAuthNotion(request: Request, env: Env): Promise<Response> {
  const clientId = env.NOTION_OAUTH_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Notion OAuth not configured", 503);
  }

  const result = await resolveOAuthStart(request, env, "notion");
  if (result instanceof Response) return result;

  const callbackUrl = env.NOTION_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/notion/callback";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${NOTION_OAUTH_AUTHORIZE_URL}?owner=user&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&state=${result.state}`,
      "set-cookie": setCookieHeader(NOTION_OAUTH_STATE_COOKIE, result.state, {
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
        path: "/",
      }),
    },
  });
}

export async function handleAuthNotionCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;

  try {
    const result = await resolveOAuthCallback(request, url, env, NOTION_OAUTH_STATE_COOKIE);
    if (result instanceof Response) return result;
    const { user, code, clearStateCookie } = result;

    if (!code) {
      return notionSettingsRedirect(frontendUrl, clearStateCookie, OAUTH_CALLBACK_CODES.NOTION_CONNECT_FAILED);
    }

    if (!(await isIntegrationAvailable(env.DB, user.id, "notion"))) {
      return notionSettingsRedirect(frontendUrl, clearStateCookie, OAUTH_CALLBACK_CODES.NOTION_CONNECT_FAILED);
    }

    const clientId = env.NOTION_OAUTH_CLIENT_ID;
    const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return jsonErrorResponse("Notion OAuth not configured", 503);
    }

    const callbackUrl = env.NOTION_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/notion/callback";
    const tokenRes = await tracedFetch(
      NOTION_TOKEN_URL,
      {
        method: "POST",
        headers: {
          [HTTP_HEADER_NAMES.AUTHORIZATION]: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json",
          "Notion-Version": NOTION_API_VERSION,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl,
        }),
      },
      "notion.oauth",
    );
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string | null;
      expires_in?: number;
      bot_id?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.access_token) {
      log.error({ error: tokenData.error, status: tokenRes.status }, "Notion token exchange failed");
      return notionSettingsRedirect(frontendUrl, clearStateCookie, OAUTH_CALLBACK_CODES.NOTION_CONNECT_FAILED);
    }

    await storeNotionTokens(
      env.DB,
      user.id,
      tokenData.access_token,
      tokenData.refresh_token ?? null,
      tokenData.expires_in ?? null,
      env.TOKEN_ENCRYPTION_KEY,
      tokenData.bot_id,
    );
    resetAuthMeUserCache();

    log.info({ userId: user.id, notionBotId: tokenData.bot_id }, "Notion OAuth connected");
    return notionSettingsRedirect(frontendUrl, clearStateCookie);
  } catch (err) {
    Sentry.captureException(err);
    log.error({ error: String(err) }, "Notion OAuth callback failed");
    return notionSettingsRedirect(
      frontendUrl,
      clearCookieHeader(NOTION_OAUTH_STATE_COOKIE),
      OAUTH_CALLBACK_CODES.NOTION_CONNECT_FAILED,
    );
  }
}

export async function handleDisconnectNotion(env: Env, auth: AuthInfo): Promise<Response> {
  await clearNotionTokens(env.DB, auth.userId, env);
  resetAuthMeUserCache();
  return jsonResponse({ ok: true });
}

export async function handleAuthMe(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  if (!auth.user) {
    return jsonResponse({ authenticated: false });
  }

  const url = new URL(request.url);
  // Always bypass the /auth/me cache while impersonating so the actor- vs
  // target-shaped responses cannot collide on the same cache key.
  const fresh = url.searchParams.get("fresh") === "1" || Boolean(auth.impersonationId);
  const span = startSpan("auth.me.resolve_user", { "auth.user_id": auth.user.id });
  try {
    const { user, cacheHit } = await resolveAuthMeUser(env.DB, env, auth.user, { fresh });
    endSpan(span, "ok", { "auth.me.cache_hit": cacheHit, "auth.me.fresh": fresh });

    // Phase 1 narrowing: availableIntegrations, integrationTools, integrationScopes
    // are excluded from the default response. They are available via GET /api/user/integrations.
    if (auth.impersonationId) {
      return jsonResponse({
        authenticated: true,
        user,
        impersonation: {
          impersonationId: auth.impersonationId,
          actor: auth.actorUser ? { id: auth.actorUser.id, login: auth.actorUser.login ?? null } : null,
          readOnly: true as const,
        },
      });
    }
    return jsonResponse({ authenticated: true, user });
  } catch (error) {
    endSpan(span, "error", { "error.message": String(error), "auth.me.fresh": fresh });
    throw error;
  }
}

export async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
  // Treat an active impersonation cookie as authenticated for the public-shell
  // bootstrap. Browser reload during impersonation must not appear signed out.
  // If the cookie is present but stale, fail closed and clear it — never fall
  // through to session_token, which would let the shell bootstrap as authenticated
  // only for every subsequent authenticated request to 401.
  const impersonationCookie = parseImpersonationTokenCookie(request);
  if (impersonationCookie) {
    let resolvedOk = false;
    try {
      const tokenHash = await computeSha256Hex(impersonationCookie);
      const resolved = await resolveImpersonationByTokenHash(env.DB, tokenHash);
      resolvedOk = resolved.status === "ok";
    } catch (error) {
      log.warn({ error: String(error) }, "Impersonation status probe failed closed");
    }
    if (resolvedOk) {
      return jsonResponse({ authenticated: true });
    }
    const headers = new Headers({ [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" });
    headers.append("set-cookie", clearCookieHeader(IMPERSONATION_COOKIE_NAME));
    return new Response(JSON.stringify({ authenticated: false }), { status: 200, headers });
  }

  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) return jsonResponse({ authenticated: false });

  try {
    return jsonResponse({ authenticated: await hasActiveAuthSession(env.DB, sessionToken) });
  } catch (error) {
    log.warn({ error: String(error) }, "Auth status probe failed closed");
    return jsonErrorResponse("Auth status unavailable", 503);
  }
}

export async function handleGetUserIntegrations(env: Env, auth: AuthInfo): Promise<Response> {
  if (!auth.user) {
    return jsonErrorResponse("Authentication required", 401);
  }

  const extras = await resolveAuthUserExtras(env.DB, auth.user.id, auth.user.businessId);
  const [lifecycleSummaries, businessHealthRows] = await Promise.all([
    getIntegrationLifecycleSummaries(
      env.DB,
      extras.availableIntegrations.map((integrationId) => {
        const typedIntegrationId = integrationId as IntegrationId;
        const scope = extras.integrationScopes[integrationId];
        return (integrationId === "github" || scope === "business") && auth.user?.businessId
          ? { integrationId: typedIntegrationId, businessId: auth.user.businessId }
          : { integrationId: typedIntegrationId, userId: auth.user!.id };
      }),
    ),
    Promise.all(
      extras.availableIntegrations
        .map((integrationId) => integrationId as IntegrationId)
        .filter((integrationId) => USER_INTEGRATIONS_BUSINESS_HEALTH_IDS.has(integrationId))
        .map(async (integrationId) => ({
          integrationId,
          row: await getLatestBusinessIntegrationHealthCheck(env.DB, auth.user!.businessId, integrationId, "basic"),
        })),
    ),
  ]);
  const businessHealthByIntegration = new Map<
    IntegrationId,
    {
      status: "passed" | "failed" | "skipped";
      checkKind: "basic";
      operation: string;
      checkedAt: number;
      latencyMs: number;
      diagnostic: string;
      failureReason: string | null;
    }
  >();
  for (const { integrationId, row } of businessHealthRows) {
    if (!row) continue;
    businessHealthByIntegration.set(integrationId, {
      status: row.status,
      checkKind: "basic",
      operation: row.operation,
      checkedAt: row.checked_at,
      latencyMs: row.latency_ms,
      diagnostic: row.diagnostic,
      failureReason: row.failure_reason,
    });
  }
  return jsonResponse({
    availableIntegrations: extras.availableIntegrations,
    integrationTools: getIntegrationToolEntries(extras.availableIntegrations),
    integrationScopes: extras.integrationScopes,
    currentHealth: Object.fromEntries(
      extras.availableIntegrations.map((integrationId) => {
        const typedIntegrationId = integrationId as IntegrationId;
        const scope = extras.integrationScopes[integrationId];
        return [
          integrationId,
          deriveCurrentIntegrationHealth({
            health: scope === "business" ? (businessHealthByIntegration.get(typedIntegrationId) ?? null) : null,
            lifecycle: lifecycleSummaries.get(typedIntegrationId) ?? null,
          }),
        ];
      }),
    ),
  });
}

export async function handleAuthSlack(request: Request, env: Env): Promise<Response> {
  const clientId = env.SLACK_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Slack OAuth not configured", 503);
  }

  const result = await resolveOAuthStart(request, env, "slack", { checkAvailability: false });
  if (result instanceof Response) return result;

  const callbackUrl = env.SLACK_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/slack/callback";

  // Only `search:read` is requested as a user scope: Slack has no bot equivalent
  // for search. History (`channels:history` etc.) is granted to the bot via the
  // workspace install (SLACK_WORKSPACE_INSTALL_SCOPES), so normal `@cycloid`
  // use no longer requires every employee to complete this user OAuth.
  const userScopes = "search:read";
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${encodeURIComponent(userScopes)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${result.state}`,
      "set-cookie": setCookieHeader("slack_oauth_state", result.state, {
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
        path: "/",
      }),
    },
  });
}

const SLACK_LINK_CSRF_COOKIE = "slack_link_csrf";
const SLACK_LINK_CONFIRM_PATH = "/auth/slack/link/confirm";

function htmlResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "text/html; charset=utf-8", ...(init?.headers ?? {}) },
  });
}

function slackLinkSettingsRedirect(env: Env, code: OAuthCallbackCode, extraHeaders?: Record<string, string>): Response {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const key = code === OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS ? "success" : "error";
  return new Response(null, {
    status: 302,
    headers: { location: `${frontendUrl}/settings/integrations?${key}=${code}`, ...(extraHeaders ?? {}) },
  });
}

/**
 * GET /auth/slack/link?token=... — render-only consent screen for Slack
 * magic-link identity binding. Public route: it resolves the browser session
 * itself so an unauthenticated visitor gets a sign-in prompt (rather than a
 * router 401) and can reopen the link after signing in. No mutation here.
 */
export async function handleAuthSlackLink(request: Request, env: Env): Promise<Response> {
  if (!env.SLACK_LINK_SIGNING_KEY) {
    return jsonErrorResponse("Slack linking not configured", 503);
  }
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return slackLinkSettingsRedirect(env, OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID);
  }

  const sessionToken = parseSessionTokenCookie(request);
  const user = sessionToken ? await resolveAuthUser(env.DB, sessionToken) : null;
  if (!user) {
    return htmlResponse(renderSlackLinkSignInHtml(frontendUrl));
  }

  const businessId = await getUserBusinessIdOrNull(env.DB, user.id).catch(() => null);
  const resolution = await resolveSlackLink(env, token, businessId);
  if (!resolution.ok) {
    return slackLinkSettingsRedirect(env, resolution.code);
  }

  // Double-submit CSRF: the same random value is embedded in the form and set
  // as an HttpOnly cookie; confirm compares them. Proves the POST came from
  // this server-rendered page.
  const csrfToken = generateRandomHex(16);
  return htmlResponse(
    renderSlackLinkConsentHtml({
      token,
      csrfToken,
      confirmPath: SLACK_LINK_CONFIRM_PATH,
      cycloidLogin: user.login,
      slackDisplayName: resolution.context.slackDisplayName,
      slackUserId: resolution.context.slackUserId,
      workspaceName: resolution.context.workspaceName,
    }),
    {
      headers: {
        "set-cookie": setCookieHeader(SLACK_LINK_CSRF_COOKIE, csrfToken, {
          maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
          path: "/",
        }),
      },
    },
  );
}

function slackLinkRequestOriginAllowed(request: Request, env: Env): boolean {
  const expectedOrigin = new URL(env.FRONTEND_URL || DEFAULT_FRONTEND_URL).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  // Neither header present: reject rather than assume same-origin.
  return false;
}

/**
 * POST /auth/slack/link/confirm — the only bind path. Public route that
 * enforces auth itself: re-resolves the browser session, checks the request
 * origin against FRONTEND_URL, and validates the double-submit CSRF token
 * before consuming the magic-link token and binding the Slack identity.
 */
export async function handleAuthSlackLinkConfirm(request: Request, env: Env): Promise<Response> {
  if (!env.SLACK_LINK_SIGNING_KEY) {
    return jsonErrorResponse("Slack linking not configured", 503);
  }
  if (!slackLinkRequestOriginAllowed(request, env)) {
    return jsonErrorResponse("Invalid origin", 403);
  }

  const sessionToken = parseSessionTokenCookie(request);
  const user = sessionToken ? await resolveAuthUser(env.DB, sessionToken) : null;
  if (!user) {
    return jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401);
  }

  const form = new URLSearchParams(await request.text());
  const token = form.get("token");
  const csrfField = form.get("csrf");
  const csrfCookie = parseCookies(request)[SLACK_LINK_CSRF_COOKIE];
  if (!csrfField || !csrfCookie || !timingSafeEqualString(csrfField, csrfCookie)) {
    return jsonErrorResponse("Invalid CSRF token", 403);
  }
  const clearCsrf = clearCookieHeader(SLACK_LINK_CSRF_COOKIE);
  if (!token) {
    return slackLinkSettingsRedirect(env, OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID, { "set-cookie": clearCsrf });
  }

  const businessId = await getUserBusinessIdOrNull(env.DB, user.id).catch(() => null);
  const code = await confirmSlackLink(env, { token, userId: user.id, userBusinessId: businessId });
  return slackLinkSettingsRedirect(env, code, { "set-cookie": clearCsrf });
}

/**
 * The Slack bot token binds workspace-wide to the business, so install
 * start and callback both require business admin (mirrors Linear/Jira
 * business OAuth). Non-admins land on the member-visible settings page.
 */
function slackInstallAdminRequiredResponse(env: Env, extraHeaders?: Record<string, string>): Response {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  return new Response(null, {
    status: 302,
    headers: {
      location: `${frontendUrl}/settings/integrations?error=${OAUTH_CALLBACK_CODES.SLACK_BUSINESS_ADMIN_REQUIRED}`,
      ...extraHeaders,
    },
  });
}

export async function handleAuthSlackInstall(request: Request, env: Env): Promise<Response> {
  const clientId = env.SLACK_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("Slack OAuth not configured", 503);
  }

  const result = await resolveOAuthStart(request, env, "slack", { checkAvailability: false });
  if (result instanceof Response) return result;
  if (result.user.businessRole !== "admin") {
    return slackInstallAdminRequiredResponse(env);
  }

  const callbackUrl = slackInstallCallbackUrl(env, request.url);
  const returnTo = normalizeSlackWorkspaceInstallReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const headers = new Headers({
    location: `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(SLACK_WORKSPACE_INSTALL_SCOPE)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${result.state}`,
  });
  headers.append(
    "set-cookie",
    setCookieHeader(SLACK_WORKSPACE_INSTALL_STATE_COOKIE, result.state, {
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
      path: "/",
    }),
  );
  headers.append(
    "set-cookie",
    setCookieHeader(SLACK_WORKSPACE_INSTALL_RETURN_TO_COOKIE, returnTo, {
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
      path: "/",
    }),
  );
  return new Response(null, {
    status: 302,
    headers,
  });
}

export async function handleAuthSlackInstallCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const returnTo = normalizeSlackWorkspaceInstallReturnTo(
    parseCookies(request)[SLACK_WORKSPACE_INSTALL_RETURN_TO_COOKIE],
  );
  try {
    const result = await resolveOAuthCallback(request, url, env, SLACK_WORKSPACE_INSTALL_STATE_COOKIE);
    if (result instanceof Response) return result;
    const { user, code, clearStateCookie } = result;

    if (user.businessRole !== "admin") {
      return slackInstallAdminRequiredResponse(env, { "set-cookie": clearStateCookie });
    }

    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "slack",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_CALLBACK_RECEIVED,
      message: "Slack workspace install callback received.",
      details: {
        provider: "slack",
        credentialScope: "business",
      },
    });

    if (!code) {
      // Slack sends ?error=access_denied when the workspace blocks the app
      // (approval required) or the user cancels the consent screen.
      const denied = url.searchParams.get("error") === "access_denied";
      const headers = new Headers({
        location: slackWorkspaceInstallRedirectLocation(
          env,
          "error",
          denied ? OAUTH_CALLBACK_CODES.SLACK_WORKSPACE_APPROVAL_REQUIRED : OAUTH_CALLBACK_CODES.SLACK_CONNECT_FAILED,
          returnTo,
        ),
      });
      for (const cookie of slackWorkspaceInstallClearCookies(clearStateCookie)) {
        headers.append("set-cookie", cookie);
      }
      return new Response(null, {
        status: 302,
        headers,
      });
    }

    const install = await installSlackWorkspaceFromCode(
      env,
      code,
      user.id,
      slackInstallCallbackUrl(env, url.toString()),
    );
    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "slack",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.OAUTH_TOKEN_EXCHANGED,
      message: "Slack workspace install token exchange succeeded.",
      details: {
        provider: "slack",
        teamId: install.teamId,
        workspaceId: install.teamId,
      },
    });
    await emitAuthLifecycleEvent({
      db: env.DB,
      integrationId: "slack",
      userId: user.id,
      businessId: user.businessId,
      stage: INTEGRATION_LIFECYCLE_STAGE.WORKSPACE_BOUND,
      message: "Slack workspace install is bound for webhook ingress.",
      details: {
        provider: "slack",
        teamId: install.teamId,
        workspaceId: install.teamId,
      },
    });
    log.info(
      { userId: user.id, teamId: install.teamId, botUserId: install.botUserId },
      "Slack workspace install connected",
    );
    // Flip the /auth/me slackWorkspaceInstalled signal immediately so the
    // settings page reflects the install right after the redirect.
    resetAuthMeUserCache();
    const headers = new Headers({
      location: slackWorkspaceInstallRedirectLocation(
        env,
        "success",
        OAUTH_CALLBACK_CODES.SLACK_INSTALL_SUCCESS,
        returnTo,
      ),
    });
    for (const cookie of slackWorkspaceInstallClearCookies(clearStateCookie)) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (err) {
    const failureCode =
      err instanceof SlackWorkspaceInstallError && err.code === "business_has_other_workspace"
        ? OAUTH_CALLBACK_CODES.SLACK_WORKSPACE_ALREADY_INSTALLED
        : undefined;
    Sentry.captureException(err);
    log.error({ error: String(err) }, "Slack workspace install callback failed");
    const headers = new Headers({
      location: slackWorkspaceInstallRedirectLocation(
        env,
        "error",
        failureCode ?? OAUTH_CALLBACK_CODES.SLACK_CONNECT_FAILED,
        returnTo,
      ),
    });
    for (const cookie of slackWorkspaceInstallClearCookies()) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, {
      status: 302,
      headers,
    });
  }
}

export async function handleSeedSlackWorkspace(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  if (auth.authMode !== "admin_token") {
    return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  }
  try {
    const body = (await parseJsonBody(request)) ?? {};
    const result = await seedSlackWorkspaceFromEnv(env, body);
    log.info({ teamId: result.teamId, botUserId: result.botUserId }, "Seeded Slack workspace install from env");
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    return jsonErrorResponse(err instanceof Error ? err.message : "Slack workspace seed failed", 400);
  }
}

export async function handleAuthSlackCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;

  try {
    const result = await resolveOAuthCallback(request, url, env, "slack_oauth_state");
    if (result instanceof Response) return result;
    const { user, code, clearStateCookie } = result;

    if (!code) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${frontendUrl}/settings/integrations?error=${OAUTH_CALLBACK_CODES.SLACK_CONNECT_FAILED}`,
          "set-cookie": clearStateCookie,
        },
      });
    }

    const clientId = env.SLACK_CLIENT_ID;
    const clientSecret = env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return jsonErrorResponse("Slack OAuth not configured", 503);
    }

    const callbackUrl = env.SLACK_OAUTH_CALLBACK_URL || "http://localhost:3000/auth/slack/callback";
    const tokenRes = await tracedFetch(
      SLACK_TOKEN_URL,
      {
        method: "POST",
        headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          code,
        }),
      },
      "slack.oauth",
    );
    const tokenData = (await tokenRes.json()) as {
      ok?: boolean;
      authed_user?: {
        id: string;
        access_token: string;
        token_type?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      error?: string;
    };
    if (!tokenData.ok || !tokenData.authed_user?.access_token || !tokenData.authed_user?.id) {
      log.error({ error: tokenData.error }, "Slack OAuth v2 token exchange failed");
      return new Response(null, {
        status: 302,
        headers: {
          location: `${frontendUrl}/settings/integrations?error=${OAUTH_CALLBACK_CODES.SLACK_CONNECT_FAILED}`,
          "set-cookie": clearStateCookie,
        },
      });
    }

    const authedUser = tokenData.authed_user;

    // Store encrypted user token + identity link
    const encryptedAccessToken = await encrypt(authedUser.access_token, env.TOKEN_ENCRYPTION_KEY);
    const encryptedRefreshToken = authedUser.refresh_token
      ? await encrypt(authedUser.refresh_token, env.TOKEN_ENCRYPTION_KEY)
      : undefined;

    // Single upsert: stores both OAuth tokens and identity link (externalUserId).
    // connectIntegration uses COALESCE to preserve existing external_user_id.
    await connectIntegration(env.DB, user.id, "slack", {
      oauthAccessToken: encryptedAccessToken,
      oauthRefreshToken: encryptedRefreshToken,
      oauthExpiresAt: authedUser.expires_in ? Date.now() + authedUser.expires_in * 1000 : undefined,
      externalUserId: authedUser.id,
      encrypted: true,
    });
    resetAuthMeUserCache();

    log.info({ userId: user.id, slackUserId: authedUser.id }, "Slack OAuth v2 connected");

    return new Response(null, {
      status: 302,
      headers: [
        ["location", `${frontendUrl}/settings/integrations`],
        ["set-cookie", clearStateCookie],
      ],
    });
  } catch (err) {
    Sentry.captureException(err);
    log.error({ error: String(err) }, "Slack OAuth callback failed");
    return new Response(null, {
      status: 302,
      headers: {
        location: `${frontendUrl}/settings/integrations?error=${OAUTH_CALLBACK_CODES.SLACK_CONNECT_FAILED}`,
        "set-cookie": clearCookieHeader("slack_oauth_state"),
      },
    });
  }
}

export async function handleDisconnectSlack(env: Env, auth: { userId: string }): Promise<Response> {
  await clearSlackLink(env.DB, auth.userId);
  resetAuthMeUserCache();
  return jsonResponse({ ok: true });
}

export async function handleGithubReauthorize(request: Request, env: Env, auth: { userId: string }): Promise<Response> {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return jsonErrorResponse("GitHub OAuth not configured", 503);
  }

  const githubTokens = await getGithubTokens(env.DB, auth.userId, env.TOKEN_ENCRYPTION_KEY);
  const githubToken = githubTokens?.accessToken ?? null;

  if (githubToken) {
    try {
      const revokeRes = await tracedFetch(
        `https://api.github.com/applications/${clientId}/grant`,
        {
          method: "DELETE",
          headers: {
            [HTTP_HEADER_NAMES.AUTHORIZATION]: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            accept: "application/json",
            [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json",
            "user-agent": "cycloid-worker",
          },
          body: JSON.stringify({ access_token: githubToken }),
        },
        "github.revokeGrant",
      );

      if (revokeRes.status >= 500) {
        log.error(
          { userId: auth.userId, status: revokeRes.status },
          "GitHub grant revocation failed -- transient error",
        );
        return jsonErrorResponse("GitHub API error -- try again", 502);
      }

      log.info({ userId: auth.userId, status: revokeRes.status }, "GitHub OAuth grant revoked");
    } catch (err) {
      log.error({ userId: auth.userId, error: String(err) }, "GitHub grant revocation failed -- network error");
      return jsonErrorResponse("Could not reach GitHub -- try again", 502);
    }
  } else {
    log.warn({ userId: auth.userId }, "GitHub reauthorize -- no token to revoke, proceeding with logout");
  }

  await clearGithubToken(env.DB, auth.userId);

  const sessionToken = parseSessionTokenCookie(request);
  if (sessionToken) {
    await Promise.all([
      deleteAuthSession(env.DB, sessionToken),
      invalidateAuthSessionCache(sessionToken, env.RATE_LIMITS),
    ]);
  }

  const response = githubOAuthRedirectResponse(request, env);
  response.headers.append("set-cookie", clearCookieHeader("session_token"));
  return response;
}

export async function handleGithubSetupCallback(url: URL, env: Env): Promise<Response> {
  // GitHub redirects here after a user installs/configures the GitHub App (setup_url).
  // Opportunistically sync the installation row before redirecting. The webhook
  // remains the source of truth for ongoing install changes, but this removes the
  // local-dev/slow-webhook gap where GitHub says access is granted while D1 still
  // has no installation row.
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const installationIdParam = url.searchParams.get("installation_id");
  const installationId = installationIdParam ? Number(installationIdParam) : null;
  log.info({ installationId: installationIdParam }, "GitHub App setup callback received");

  if (installationId && Number.isInteger(installationId)) {
    try {
      const { getAppInstallationDetails } = await import("../github/octokit");
      const installation = await getAppInstallationDetails(env, installationId);
      const upsertParams = {
        installationId: installation.installationId,
        ownerLogin: installation.ownerLogin,
        ownerId: installation.ownerId,
        ownerType: installation.ownerType,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        events: installation.events,
      };
      try {
        await upsertInstallation(env.DB, upsertParams);
      } catch (error) {
        if (!isInstallationOwnerUniqueConstraintError(error)) throw error;
        const conflictingInstallation = await getConflictingInstallationByOwner(
          env.DB,
          installation.ownerLogin,
          installation.installationId,
        );
        if (!conflictingInstallation) throw error;
        await replaceConflictingInstallation(env.DB, conflictingInstallation.installation_id, upsertParams);
        log.warn(
          {
            installationId: installation.installationId,
            ownerLogin: installation.ownerLogin,
            replacedInstallationId: conflictingInstallation.installation_id,
          },
          "GitHub setup callback replaced stale installation row after owner conflict",
        );
      }
      log.info(
        { installationId: installation.installationId, ownerLogin: installation.ownerLogin },
        "GitHub setup callback synced installation",
      );
      await bumpReposInstallationVersion(env);
    } catch (error) {
      log.warn(
        { installationId, error: String(error) },
        "GitHub setup callback could not sync installation; waiting for webhook",
      );
    }
  }

  return new Response(null, {
    status: 302,
    headers: { location: `${frontendUrl}?setup=complete` },
  });
}

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  const sessionToken = parseSessionTokenCookie(request);
  const impersonationCookie = parseImpersonationTokenCookie(request);

  if (!sessionToken && !impersonationCookie) {
    return jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401);
  }

  const tasks: Promise<unknown>[] = [];
  if (sessionToken) {
    tasks.push(deleteAuthSession(env.DB, sessionToken));
    tasks.push(invalidateAuthSessionCache(sessionToken, env.RATE_LIMITS));
  }
  if (impersonationCookie) {
    tasks.push(
      computeSha256Hex(impersonationCookie)
        .then((hash) => revokeImpersonationByTokenHash(env.DB, hash))
        .then((revoked) => {
          if (revoked) {
            log.warn(
              {
                event: "impersonation_session_revoked",
                impersonationId: revoked.id,
                actorUserId: revoked.actorUserId,
                targetUserId: revoked.targetUserId,
                trigger: "logout",
              },
              "Impersonation session revoked on logout",
            );
          }
        }),
    );
  }
  await Promise.all(tasks);

  const headers = new Headers({ [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" });
  headers.append("set-cookie", clearCookieHeader("session_token"));
  headers.append("set-cookie", clearCookieHeader(IMPERSONATION_COOKIE_NAME));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
