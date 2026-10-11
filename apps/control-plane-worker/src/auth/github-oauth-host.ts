import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import type { Env } from "../types";

/**
 * GitHub sign-in redirect host resolution for multi-host UI deployments.
 *
 * Prod serves the UI from app.trycycloid.com, but an internal dogfood deploy
 * (internal.app.trycycloid.com) talks to the SAME control plane. GitHub's OAuth
 * redirect_uri (at sign-in start) and our post-login redirect target must land on
 * whichever host the user is actually on, or the Set-Cookie for `session_token`
 * lands on the wrong host and the login silently fails.
 *
 * The UI Pages worker rewrites the Host header to WORKER_HOST when it proxies
 * /auth/*, so the control plane can't read the original host from `Host`. The
 * worker forwards it in `X-Forwarded-Host` instead. That header is
 * attacker-influenceable input, so it is validated against a STRICT exact-host
 * allowlist and we fail closed to the env-var defaults on any mismatch. We never
 * echo an arbitrary host into a redirect (open-redirect protection).
 *
 * Scope: GitHub SIGN-IN only. Integration OAuth (Slack/Jira/Linear/Notion) stays
 * pinned to its own *_CALLBACK_URL env vars.
 */

export interface GithubOAuthHostConfig {
  /** GitHub OAuth callback URL (redirect_uri). Origin swapped to the resolved host; path preserved. */
  callbackUrl: string;
  /** Post-login redirect origin (no trailing slash). */
  frontendUrl: string;
}

/**
 * Hosts allowed to override the GitHub sign-in redirect. Derived from the origins
 * of FRONTEND_URL plus the optional INTERNAL_FRONTEND_URL. Malformed values are
 * dropped. Absent INTERNAL_FRONTEND_URL => just FRONTEND_URL's host, so an
 * X-Forwarded-Host equal to the prod UI host resolves to today's behavior.
 */
export function allowlistedRedirectHosts(env: Env): Set<string> {
  const hosts = new Set<string>();
  for (const raw of [env.FRONTEND_URL || DEFAULT_FRONTEND_URL, env.INTERNAL_FRONTEND_URL]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).host);
    } catch {
      // Skip a malformed env value rather than widening the allowlist.
    }
  }
  return hosts;
}

/**
 * Resolve the GitHub sign-in callback + frontend URLs for this request.
 *
 * Reads `X-Forwarded-Host` (set by the UI worker). When it exactly matches an
 * allowlisted host, the GITHUB_CALLBACK_URL origin is swapped onto that host
 * (path preserved, query dropped) and that origin becomes the post-login
 * redirect target. Any
 * other, missing, or malformed value fails closed to the env-var defaults, so
 * a request with no header (or a spoofed one) behaves exactly as it does today.
 */
export function resolveGithubOAuthHost(request: Request, env: Env): GithubOAuthHostConfig {
  const defaultCallbackUrl = env.GITHUB_CALLBACK_URL || "http://localhost:3000/auth/callback";
  const defaultFrontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const fallback: GithubOAuthHostConfig = {
    callbackUrl: defaultCallbackUrl,
    frontendUrl: defaultFrontendUrl,
  };

  const forwardedHost = request.headers.get(HTTP_HEADER_NAMES.FORWARDED_HOST)?.trim();
  if (!forwardedHost) return fallback;
  if (!allowlistedRedirectHosts(env).has(forwardedHost)) return fallback;

  let callbackTemplate: URL;
  try {
    callbackTemplate = new URL(defaultCallbackUrl);
  } catch {
    return fallback;
  }
  // Exact-match host from the allowlist: safe to build the redirect origin from
  // it. `URL#host` never contains a path/scheme, so this cannot inject one.
  // The template's query string (empty in every real config) is deliberately
  // dropped: GitHub matches redirect_uri exactly, so silently forwarding a
  // stray query would produce an unregistered URL that fails token exchange.
  const targetOrigin = `${callbackTemplate.protocol}//${forwardedHost}`;
  return {
    callbackUrl: `${targetOrigin}${callbackTemplate.pathname}`,
    frontendUrl: targetOrigin,
  };
}
