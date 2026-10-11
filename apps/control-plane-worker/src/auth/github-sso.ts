import type { Env } from "../types";
import { generateRandomHex, jsonErrorResponse, setCookieHeader } from "../utils";
import { resolveGithubOAuthHost } from "./github-oauth-host";
import { renderTurnstileAuthForm, verifyTurnstileAuthRequest } from "./turnstile";

export const GITHUB_OAUTH_RETURN_TO_COOKIE = "github_oauth_return_to";
export const GITHUB_OAUTH_SCOPE = "repo%20read:org";
export const SSO_COMPLETE_RETURN_TO = "/?sso=complete";

// GitHub org logins: start/end alphanumeric, hyphens allowed in the middle, max 39 chars.
const GITHUB_ORG_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export function githubOAuthAuthorizePath(clientId: string, callbackUrl: string, state: string): string {
  return `/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${GITHUB_OAUTH_SCOPE}&state=${state}`;
}

/**
 * Start the one-click SSO authorization chain for a SAML-withheld org.
 *
 * GitHub grants an OAuth token SSO access only for orgs with an active SAML
 * session at token issuance, so completing Okta/IdP login alone never unblocks
 * the existing token. This route sends the user through the org's SSO page
 * with `return_to` pointing at our OAuth authorize URL: the IdP login runs
 * first, then GitHub silently re-issues our (already-consented) authorization
 * with the fresh SAML grant, and the normal callback invalidates the user's
 * repo caches and lands back on the app with `?sso=complete`.
 */
export async function handleAuthGithubSso(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const challenge = renderTurnstileAuthForm(request, env);
    if (challenge) return challenge;
  } else {
    const challengeError = await verifyTurnstileAuthRequest(request, env);
    if (challengeError) return challengeError;
  }

  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return jsonErrorResponse("GitHub OAuth not configured", 503);
  }

  const org = new URL(request.url).searchParams.get("org") ?? "";
  if (!GITHUB_ORG_LOGIN_PATTERN.test(org)) {
    return jsonErrorResponse("Invalid org", 400);
  }

  const state = generateRandomHex(16);
  // Keep the SAML re-auth redirect_uri on the (allowlisted) serving host so the
  // callback lands where the user is; fails closed to GITHUB_CALLBACK_URL.
  const { callbackUrl } = resolveGithubOAuthHost(request, env);
  const authorizePath = githubOAuthAuthorizePath(clientId, callbackUrl, state);
  const headers = new Headers({
    location: `https://github.com/orgs/${org}/sso?return_to=${encodeURIComponent(authorizePath)}`,
  });
  headers.append("set-cookie", setCookieHeader("oauth_state", state, { maxAge: OAUTH_COOKIE_MAX_AGE_MS, path: "/" }));
  headers.append(
    "set-cookie",
    setCookieHeader(GITHUB_OAUTH_RETURN_TO_COOKIE, SSO_COMPLETE_RETURN_TO, {
      maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      path: "/",
    }),
  );

  return new Response(null, { status: 302, headers });
}
