import { describe, expect, it } from "vitest";

import {
  allowlistedRedirectHosts,
  resolveGithubOAuthHost,
} from "../../apps/control-plane-worker/src/auth/github-oauth-host";
import {
  GITHUB_OAUTH_RETURN_TO_COOKIE,
  githubOAuthAuthorizePath,
  handleAuthGithubSso,
  SSO_COMPLETE_RETURN_TO,
} from "../../apps/control-plane-worker/src/auth/github-sso";
import {
  githubOAuthReturnToRedirectUrl,
  handleAuthGithub,
  normalizeGithubOAuthReturnTo,
} from "../../apps/control-plane-worker/src/auth/routes";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { HTTP_HEADER_NAMES } from "../../shared/constants/http-headers.js";

const env = {
  WORKER_ENV: "local",
  GITHUB_CLIENT_ID: "client123",
  GITHUB_CALLBACK_URL: "https://app.trycycloid.com/auth/callback",
} as Env;

function ssoRequest(org: string | null): Request {
  const url = new URL("https://app.trycycloid.com/auth/github/sso");
  if (org !== null) url.searchParams.set("org", org);
  return new Request(url);
}

describe("githubOAuthAuthorizePath", () => {
  it("builds the authorize path with encoded callback and state", () => {
    expect(githubOAuthAuthorizePath("client123", "https://app.trycycloid.com/auth/callback", "abc")).toBe(
      "/login/oauth/authorize?client_id=client123&redirect_uri=https%3A%2F%2Fapp.trycycloid.com%2Fauth%2Fcallback&scope=repo%20read:org&state=abc",
    );
  });
});

describe("handleAuthGithubSso", () => {
  it("redirects through the org SSO page to a silent OAuth re-auth", async () => {
    const response = await handleAuthGithubSso(ssoRequest("mialabs"), env);
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/orgs/mialabs/sso");

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((cookie) => cookie.startsWith("oauth_state="));
    expect(stateCookie).toBeDefined();
    const state = stateCookie!.split(";")[0].split("=")[1];

    // return_to must be a github.com-relative authorize path carrying the same
    // state the callback will validate against the cookie.
    expect(location.searchParams.get("return_to")).toBe(
      githubOAuthAuthorizePath("client123", "https://app.trycycloid.com/auth/callback", state),
    );

    const returnToCookie = cookies.find((cookie) => cookie.startsWith(`${GITHUB_OAUTH_RETURN_TO_COOKIE}=`));
    expect(returnToCookie).toBeDefined();
    expect(returnToCookie!.split(";")[0]).toBe(`${GITHUB_OAUTH_RETURN_TO_COOKIE}=${SSO_COMPLETE_RETURN_TO}`);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["path traversal", "mialabs/sso/.."],
    ["url injection", "mialabs?x=1"],
    ["too long", "a".repeat(40)],
    ["leading hyphen", "-mialabs"],
    ["trailing hyphen", "mialabs-"],
  ])("rejects %s org with 400", async (_label, org) => {
    const response = await handleAuthGithubSso(ssoRequest(org), env);
    expect(response.status).toBe(400);
  });

  it("returns 503 when GitHub OAuth is not configured", async () => {
    const response = await handleAuthGithubSso(ssoRequest("mialabs"), { ...env, GITHUB_CLIENT_ID: undefined } as Env);
    expect(response.status).toBe(503);
  });

  it("renders the Turnstile challenge when WORKER_ENV is missing", async () => {
    const response = await handleAuthGithubSso(ssoRequest("mialabs"), {
      GITHUB_CLIENT_ID: "client123",
      GITHUB_CALLBACK_URL: "https://app.trycycloid.com/auth/callback",
      TURNSTILE_SITE_KEY: "site",
    } as Env);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cf-turnstile");
  });
});

describe("normalizeGithubOAuthReturnTo", () => {
  it.each([
    ["/sessions", "/sessions"],
    ["/api/sessions/sess-1/artifacts/art-1/shot.png", "/api/sessions/sess-1/artifacts/art-1/shot.png"],
    ["  /sessions?tab=open  ", "/sessions?tab=open"],
  ])("keeps same-origin relative path %s", (input, expected) => {
    expect(normalizeGithubOAuthReturnTo(input)).toBe(expected);
  });

  // Regression: dot-segments and encoded dot-segments canonicalize into a
  // protocol-relative path (`//evil.example`) that later resolves to an
  // external origin. The pre-parse `//` check does not catch these because the
  // raw value still starts with a single slash.
  it.each([
    ["dot-segment collapse", "/..//evil.example"],
    ["encoded first dot", "/.%2e//evil.example"],
    ["fully encoded dot-segment", "/%2e%2e//evil.example"],
    ["protocol-relative", "//evil.example"],
    ["absolute external url", "https://evil.example/"],
    ["missing leading slash", "sessions"],
    ["empty", ""],
    ["undefined", undefined],
  ])("rejects %s", (_label, input) => {
    expect(normalizeGithubOAuthReturnTo(input)).toBeNull();
  });
});

describe("githubOAuthReturnToRedirectUrl", () => {
  const frontendUrl = "https://app.trycycloid.com";
  const callbackUrl = new URL("https://api.trycycloid.com/auth/callback");

  // Regression: the SSO completion path was being resolved against the worker's
  // own origin, so users landed on the control-plane worker at "/?sso=complete"
  // and saw "Not found" instead of the app.
  it("resolves SPA return-to paths against the frontend, not the callback origin", () => {
    expect(githubOAuthReturnToRedirectUrl(SSO_COMPLETE_RETURN_TO, callbackUrl, frontendUrl)).toBe(
      "https://app.trycycloid.com/?sso=complete",
    );
  });

  // Worker-served paths (artifact downloads, /auth/* deep links) must stay on
  // the callback origin so the request hits the worker, not the SPA.
  it("keeps worker-served paths on the callback origin", () => {
    expect(
      githubOAuthReturnToRedirectUrl("/api/sessions/sess-1/artifacts/art-1/shot.png", callbackUrl, frontendUrl),
    ).toBe("https://api.trycycloid.com/api/sessions/sess-1/artifacts/art-1/shot.png");
  });

  it("falls back to the frontend URL when there is no return-to", () => {
    expect(githubOAuthReturnToRedirectUrl(null, callbackUrl, frontendUrl)).toBe(frontendUrl);
  });

  it("tolerates a trailing slash on the frontend URL", () => {
    expect(githubOAuthReturnToRedirectUrl("/sessions", callbackUrl, "https://app.trycycloid.com/")).toBe(
      "https://app.trycycloid.com/sessions",
    );
  });

  // Defense in depth: a value that somehow reaches this helper without being a
  // strict single-slash relative path must fall back to the frontend rather
  // than resolve to an external origin.
  it.each([
    ["protocol-relative", "//evil.example"],
    ["backslash protocol-relative", "/\\evil.example"],
    ["absolute external url", "https://evil.example/"],
    ["missing leading slash", "sessions"],
  ])("falls back to the frontend for %s", (_label, returnTo) => {
    expect(githubOAuthReturnToRedirectUrl(returnTo, callbackUrl, frontendUrl)).toBe(frontendUrl);
  });
});

// Multi-host GitHub sign-in: the redirect_uri + post-login host are chosen from
// X-Forwarded-Host validated against a strict allowlist, failing closed to the
// env-var (app.trycycloid.com) defaults so an absent/spoofed header behaves
// exactly as today. Integration OAuth is unaffected (not exercised here).
const multiHostEnv = {
  WORKER_ENV: "local",
  GITHUB_CLIENT_ID: "client123",
  GITHUB_CALLBACK_URL: "https://app.trycycloid.com/auth/callback",
  FRONTEND_URL: "https://app.trycycloid.com",
  INTERNAL_FRONTEND_URL: "https://internal.app.trycycloid.com",
} as Env;

const DEFAULT_HOST_CONFIG = {
  callbackUrl: "https://app.trycycloid.com/auth/callback",
  frontendUrl: "https://app.trycycloid.com",
};

function forwardedHostRequest(forwardedHost: string | null): Request {
  // The callback/authorize request is proxied to the control-plane host; the UI
  // worker forwards the original serving host in X-Forwarded-Host.
  const headers = new Headers();
  if (forwardedHost !== null) headers.set(HTTP_HEADER_NAMES.FORWARDED_HOST, forwardedHost);
  return new Request("https://api.trycycloid.com/auth/callback", { headers });
}

describe("allowlistedRedirectHosts", () => {
  it("includes INTERNAL_FRONTEND_URL host when set", () => {
    const hosts = allowlistedRedirectHosts(multiHostEnv);
    expect([...hosts].sort()).toEqual(["app.trycycloid.com", "internal.app.trycycloid.com"]);
  });

  it("is just FRONTEND_URL host when INTERNAL_FRONTEND_URL is unset", () => {
    const hosts = allowlistedRedirectHosts({ ...multiHostEnv, INTERNAL_FRONTEND_URL: undefined } as Env);
    expect([...hosts]).toEqual(["app.trycycloid.com"]);
  });

  it("drops a malformed INTERNAL_FRONTEND_URL rather than widening the allowlist", () => {
    const hosts = allowlistedRedirectHosts({ ...multiHostEnv, INTERNAL_FRONTEND_URL: "not a url" } as Env);
    expect([...hosts]).toEqual(["app.trycycloid.com"]);
  });
});

describe("resolveGithubOAuthHost", () => {
  it("no X-Forwarded-Host header → env-var defaults (current behavior)", () => {
    expect(resolveGithubOAuthHost(forwardedHostRequest(null), multiHostEnv)).toEqual(DEFAULT_HOST_CONFIG);
  });

  it("allowlisted internal host → internal callback + redirect", () => {
    expect(resolveGithubOAuthHost(forwardedHostRequest("internal.app.trycycloid.com"), multiHostEnv)).toEqual({
      callbackUrl: "https://internal.app.trycycloid.com/auth/callback",
      frontendUrl: "https://internal.app.trycycloid.com",
    });
  });

  it("allowlisted prod host → prod callback + redirect (unchanged from default)", () => {
    expect(resolveGithubOAuthHost(forwardedHostRequest("app.trycycloid.com"), multiHostEnv)).toEqual(
      DEFAULT_HOST_CONFIG,
    );
  });

  it("non-allowlisted host → env-var defaults (open-redirect protection)", () => {
    expect(resolveGithubOAuthHost(forwardedHostRequest("evil.example"), multiHostEnv)).toEqual(DEFAULT_HOST_CONFIG);
  });

  it("INTERNAL_FRONTEND_URL unset + internal host → env-var defaults", () => {
    const env = { ...multiHostEnv, INTERNAL_FRONTEND_URL: undefined } as Env;
    expect(resolveGithubOAuthHost(forwardedHostRequest("internal.app.trycycloid.com"), env)).toEqual(
      DEFAULT_HOST_CONFIG,
    );
  });

  it("drops a query string on the callback template from the derived redirect_uri", () => {
    const env = { ...multiHostEnv, GITHUB_CALLBACK_URL: "https://app.trycycloid.com/auth/callback?env=dev" } as Env;
    expect(resolveGithubOAuthHost(forwardedHostRequest("internal.app.trycycloid.com"), env)).toEqual({
      callbackUrl: "https://internal.app.trycycloid.com/auth/callback",
      frontendUrl: "https://internal.app.trycycloid.com",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["host with path", "internal.app.trycycloid.com/evil"],
    ["host with scheme", "https://internal.app.trycycloid.com"],
    ["comma-joined header", "internal.app.trycycloid.com, evil.example"],
  ])("malformed header (%s) → env-var defaults", (_label, forwardedHost) => {
    expect(resolveGithubOAuthHost(forwardedHostRequest(forwardedHost), multiHostEnv)).toEqual(DEFAULT_HOST_CONFIG);
  });
});

describe("handleAuthGithub redirect_uri host selection", () => {
  function githubStartRequest(forwardedHost: string | null): Request {
    const headers = new Headers();
    if (forwardedHost !== null) headers.set(HTTP_HEADER_NAMES.FORWARDED_HOST, forwardedHost);
    return new Request("https://api.trycycloid.com/auth/github", { headers });
  }

  function redirectUri(response: Response): string | null {
    const location = new URL(response.headers.get("location")!);
    return location.searchParams.get("redirect_uri");
  }

  it("no header → prod callback redirect_uri", async () => {
    const response = await handleAuthGithub(githubStartRequest(null), multiHostEnv);
    expect(response.status).toBe(302);
    expect(redirectUri(response)).toBe("https://app.trycycloid.com/auth/callback");
  });

  it("allowlisted internal host → internal callback redirect_uri", async () => {
    const response = await handleAuthGithub(githubStartRequest("internal.app.trycycloid.com"), multiHostEnv);
    expect(redirectUri(response)).toBe("https://internal.app.trycycloid.com/auth/callback");
  });

  it("non-allowlisted host → prod callback redirect_uri", async () => {
    const response = await handleAuthGithub(githubStartRequest("evil.example"), multiHostEnv);
    expect(redirectUri(response)).toBe("https://app.trycycloid.com/auth/callback");
  });
});
