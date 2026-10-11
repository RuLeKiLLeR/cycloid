import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import type { UserInfo } from "../../apps/control-plane-worker/src/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClearGithubToken = vi.fn();
const mockCreateAuthSession = vi.fn<(db: unknown, userId: number) => Promise<string>>();
const mockDeleteAuthSession = vi.fn();
const mockResolveAuthUser = vi.fn<(db: unknown, token: string) => Promise<UserInfo | null>>();
const mockResolveAuthSession = vi.fn();
const mockGetUserByGithubId =
  vi.fn<(db: unknown, githubId: number) => Promise<{ id: number; login: string | null } | null>>();
const mockGetUserBusinessIdOrNull = vi.fn<(db: unknown, userId: number) => Promise<string | null>>();
const mockGetUserSettings = vi.fn<(db: unknown, userId: number) => Promise<Record<string, never>>>();
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  resolveAuthUser: (...args: unknown[]) => mockResolveAuthUser(args[0], args[1] as string),
  clearGithubToken: (...args: unknown[]) => mockClearGithubToken(...args),
  clearSlackLink: vi.fn(),
  createAuthSession: (...args: unknown[]) => mockCreateAuthSession(args[0], args[1] as number),
  deleteAuthSession: (...args: unknown[]) => mockDeleteAuthSession(...args),
  resolveAuthSession: (...args: unknown[]) => mockResolveAuthSession(...args),
  getUserByGithubId: (...args: unknown[]) => mockGetUserByGithubId(args[0], args[1] as number),
  getUserBusinessIdOrNull: (...args: unknown[]) => mockGetUserBusinessIdOrNull(args[0], args[1] as number),
  hasActiveAuthSession: vi.fn(),
  resolveAuthUserExtras: vi.fn(),
  clearNotionTokens: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettings: (...args: unknown[]) => mockGetUserSettings(args[0], args[1] as number),
}));

const mockGetPendingSignupByGithubId = vi.fn();
const mockUpsertPendingSignup = vi.fn();
const mockDeletePendingSignupByGithubId = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/pending-signups-db", () => ({
  getPendingSignupByGithubId: (...args: unknown[]) => mockGetPendingSignupByGithubId(...args),
  upsertPendingSignup: (...args: unknown[]) => mockUpsertPendingSignup(...args),
  deletePendingSignupByGithubId: (...args: unknown[]) => mockDeletePendingSignupByGithubId(...args),
  listOpenPendingSignups: vi.fn(),
  markPendingSignupDenied: vi.fn(),
  deletePendingSignup: vi.fn(),
  getPendingSignupById: vi.fn(),
  purgeDeniedPendingSignupsOlderThan: vi.fn(),
}));

const mockNotifyCycloidAdminOfPendingSignup = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/pending-signups-notify", () => ({
  notifyCycloidAdminOfPendingSignup: (...args: unknown[]) => mockNotifyCycloidAdminOfPendingSignup(...args),
}));

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

const { mockAuthenticateGitHubUser, MockBusinessMismatchError } = vi.hoisted(() => {
  class HoistedBusinessMismatchError extends Error {
    storedBusinessId: string;
    requestedBusinessId: string;

    constructor(storedBusinessId: string, requestedBusinessId: string) {
      super("business mismatch");
      this.storedBusinessId = storedBusinessId;
      this.requestedBusinessId = requestedBusinessId;
    }
  }

  return {
    mockAuthenticateGitHubUser:
      vi.fn<
        (
          db: unknown,
          ghUser: unknown,
          credentials: unknown,
          businessId: string,
          encryptionKey: string | undefined,
        ) => Promise<number>
      >(),
    MockBusinessMismatchError: HoistedBusinessMismatchError,
  };
});

vi.mock("../../apps/control-plane-worker/src/auth/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/auth/service")>();
  return {
    ...actual,
    persistAuthenticatedGitHubUser: (...args: unknown[]) =>
      mockAuthenticateGitHubUser(args[0], args[1], args[2], args[3] as string, args[4] as string | undefined),
    BusinessMismatchError: MockBusinessMismatchError,
  };
});

const mockIsIntegrationAvailable = vi.fn<(db: unknown, userId: number, id: string) => Promise<boolean>>();
vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  isIntegrationAvailable: (...args: unknown[]) =>
    mockIsIntegrationAvailable(args[0], args[1] as number, args[2] as string),
}));

const mockTracedFetch = vi.fn<(url: string, init?: RequestInit, spanName?: string) => Promise<Response>>();
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) =>
    mockTracedFetch(args[0] as string, args[1] as RequestInit | undefined, args[2] as string | undefined),
}));

const mockGetAppSlug = vi.fn();
vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppSlug: (...args: unknown[]) => mockGetAppSlug(...args),
}));

// Stable mocks for utils -- we control cookie parsing and session token extraction
const mockParseCookies = vi.fn<(req: Request) => Record<string, string>>();
const mockParseSessionTokenCookie = vi.fn<(req: Request) => string | null>();
vi.mock("../../apps/control-plane-worker/src/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    parseCookies: (req: Request) => mockParseCookies(req),
    parseSessionTokenCookie: (req: Request) => mockParseSessionTokenCookie(req),
    generateRandomHex: () => "deadbeef1234abcd",
  };
});

// Minimal mock for other transitive imports
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  handleAuthCallback,
  handleAuthGithub,
  handleAuthLogout,
  handleGithubReauthorize,
  resolveOAuthCallback,
  resolveOAuthStart,
} from "../../apps/control-plane-worker/src/auth/routes";
import { renderTurnstileAuthForm } from "../../apps/control-plane-worker/src/auth/turnstile";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeUser: UserInfo = {
  id: 42,
  login: "testuser",
  name: "Test User",
  email: "test@example.com",
  businessId: "biz_1",
};

function fakeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: {},
    FRONTEND_URL: "https://app.test",
    ...overrides,
  };
}

function fakeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.test/auth/slack", { headers });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""].filter(Boolean);
}

function fakeGithubTokenDb(
  row: {
    oauth_access_token: string | null;
    oauth_refresh_token: string | null;
    oauth_expires_at: number | null;
    encrypted: number;
  } | null,
): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as D1Database;
}

function fakeCallbackUrl(params: Record<string, string> = {}): URL {
  const url = new URL("https://api.test/auth/slack/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

// ---------------------------------------------------------------------------
// resolveOAuthStart
// ---------------------------------------------------------------------------

// Safety net: restore any spy (e.g. the Date.now spy in handleAuthCallback)
// even if a test throws before its inline mockRestore, so it can't leak into
// later tests and freeze their clock.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveOAuthStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user + state when session and integration are valid", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);
    mockIsIntegrationAvailable.mockResolvedValue(true);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "slack");

    expect(result).not.toBeInstanceOf(Response);
    const ctx = result as { user: UserInfo; state: string };
    expect(ctx.user).toEqual(fakeUser);
    expect(ctx.state).toBe("deadbeef1234abcd");
  });

  it("redirects to /settings when session token is missing", async () => {
    mockParseSessionTokenCookie.mockReturnValue(null);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "slack");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("redirects to /settings when user cannot be resolved", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(null);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "linear");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/settings");
  });

  it("returns 403 when integration is disabled", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);
    mockIsIntegrationAvailable.mockResolvedValue(false);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "linear");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Linear integration is disabled/);
  });

  it("skips availability checks for Slack OAuth", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);
    mockIsIntegrationAvailable.mockResolvedValue(false);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "slack");

    expect(result).not.toBeInstanceOf(Response);
    const ctx = result as { user: UserInfo; state: string };
    expect(ctx.user).toEqual(fakeUser);
    expect(ctx.state).toBe("deadbeef1234abcd");
    expect(mockIsIntegrationAvailable).not.toHaveBeenCalled();
  });

  it("capitalizes integration name in the 403 error message", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);
    mockIsIntegrationAvailable.mockResolvedValue(false);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv() as never, "linear");

    const res = result as Response;
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Linear/);
  });

  it("uses default FRONTEND_URL when env var is missing", async () => {
    mockParseSessionTokenCookie.mockReturnValue(null);

    const result = await resolveOAuthStart(fakeRequest(), fakeEnv({ FRONTEND_URL: undefined }) as never, "slack");

    const res = result as Response;
    expect(res.headers.get("location")).toBe("https://app.trycycloid.com/settings");
  });
});

// ---------------------------------------------------------------------------
// resolveOAuthCallback
// ---------------------------------------------------------------------------

describe("resolveOAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user + code + clearStateCookie on valid callback", async () => {
    mockParseCookies.mockReturnValue({ slack_oauth_state: "state123" });
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);

    const url = fakeCallbackUrl({ code: "authcode", state: "state123" });
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "slack_oauth_state");

    expect(result).not.toBeInstanceOf(Response);
    const ctx = result as { user: UserInfo; code: string; clearStateCookie: string };
    expect(ctx.user).toEqual(fakeUser);
    expect(ctx.code).toBe("authcode");
    expect(ctx.clearStateCookie).toContain("slack_oauth_state");
    expect(ctx.clearStateCookie).toContain("Max-Age=0");
  });

  it("returns 400 when state param is missing", async () => {
    mockParseCookies.mockReturnValue({ slack_oauth_state: "state123" });

    const url = fakeCallbackUrl({ code: "authcode" }); // no state param
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "slack_oauth_state");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid OAuth state");
  });

  it("returns 400 when state does not match stored cookie", async () => {
    mockParseCookies.mockReturnValue({ slack_oauth_state: "correct_state" });

    const url = fakeCallbackUrl({ code: "authcode", state: "wrong_state" });
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "slack_oauth_state");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
  });

  it("returns 401 when session token is missing", async () => {
    mockParseCookies.mockReturnValue({ slack_oauth_state: "state123" });
    mockParseSessionTokenCookie.mockReturnValue(null);

    const url = fakeCallbackUrl({ code: "authcode", state: "state123" });
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "slack_oauth_state");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when user cannot be resolved", async () => {
    mockParseCookies.mockReturnValue({ linear_oauth_state: "state123" });
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(null);

    const url = fakeCallbackUrl({ code: "authcode", state: "state123" });
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "linear_oauth_state");

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
  });

  it("returns null code when code param is missing", async () => {
    mockParseCookies.mockReturnValue({ slack_oauth_state: "state123" });
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);

    const url = fakeCallbackUrl({ state: "state123" }); // no code
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "slack_oauth_state");

    expect(result).not.toBeInstanceOf(Response);
    const ctx = result as { code: string | null };
    expect(ctx.code).toBeNull();
  });

  it("clears the correct cookie name for linear", async () => {
    mockParseCookies.mockReturnValue({ linear_oauth_state: "state123" });
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    mockResolveAuthUser.mockResolvedValue(fakeUser);

    const url = fakeCallbackUrl({ code: "authcode", state: "state123" });
    const result = await resolveOAuthCallback(fakeRequest(), url, fakeEnv() as never, "linear_oauth_state");

    const ctx = result as { clearStateCookie: string };
    expect(ctx.clearStateCookie).toContain("linear_oauth_state");
  });
});

describe("handleAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByGithubId.mockReset();
    mockGetUserBusinessIdOrNull.mockReset();
    mockGetPendingSignupByGithubId.mockReset();
    mockUpsertPendingSignup.mockReset();
    mockDeletePendingSignupByGithubId.mockReset();
    mockNotifyCycloidAdminOfPendingSignup.mockReset();
    mockPostStructuredEventToDd.mockClear().mockResolvedValue(true);
    mockTracedFetch.mockReset();
    mockGetAppSlug.mockReset();
    mockAuthenticateGitHubUser.mockReset();
    mockCreateAuthSession.mockReset();
    mockGetUserSettings.mockReset();
    mockParseCookies.mockReturnValue({ oauth_state: "state123" });
    mockCreateAuthSession.mockResolvedValue("session-token");
    mockAuthenticateGitHubUser.mockResolvedValue(42);
    mockGetUserSettings.mockResolvedValue({});
  });

  it("stores a safe GitHub OAuth returnTo path when starting auth", async () => {
    const request = new Request(
      "https://api.test/auth/github?returnTo=%2Fapi%2Fsessions%2Fsess-1%2Fartifacts%2Fart-1%2Fshot.png",
    );
    const response = await handleAuthGithub(request, {
      WORKER_ENV: "local",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(setCookies(response).join("\n")).toContain(
      "github_oauth_return_to=/api/sessions/sess-1/artifacts/art-1/shot.png",
    );
  });

  it("does not store unsafe GitHub OAuth returnTo values", async () => {
    const request = new Request("https://api.test/auth/github?returnTo=https%3A%2F%2Fevil.test%2Fsteal");
    const response = await handleAuthGithub(request, {
      WORKER_ENV: "local",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
    } as never);

    const cookies = setCookies(response).join("\n");
    expect(cookies).toContain("github_oauth_return_to=");
    expect(cookies).toContain("Max-Age=0");
  });

  it("clears stale GitHub OAuth returnTo cookies when starting normal auth", async () => {
    const request = new Request("https://api.test/auth/github");
    const response = await handleAuthGithub(request, {
      WORKER_ENV: "local",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
    } as never);

    const cookies = setCookies(response).join("\n");
    expect(cookies).toContain("oauth_state=");
    expect(cookies).toContain("github_oauth_return_to=");
    expect(cookies).toContain("Max-Age=0");
  });

  it("renders a nonce-matched auto-submit Turnstile challenge with a fallback button", async () => {
    const response = renderTurnstileAuthForm(new Request("https://api.test/auth/github"), {
      WORKER_ENV: "production",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response).not.toBeNull();
    expect(response?.headers.get("content-type")).toContain("text/html");
    const nonce = response?.headers.get("x-script-nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const body = await response!.text();
    expect(body).toContain(`script nonce="${nonce}"`);
    expect(body).toContain('id="arc-auth-form"');
    expect(body).toContain('data-callback="arcTurnstilePass"');
    expect(body).toContain('<button type="submit">Continue</button>');
  });

  it("does not render a Turnstile challenge in local env", () => {
    const response = renderTurnstileAuthForm(new Request("https://api.test/auth/github"), {
      WORKER_ENV: "local",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response).toBeNull();
  });

  it("requires Turnstile when WORKER_ENV is missing", async () => {
    const response = renderTurnstileAuthForm(new Request("https://api.test/auth/github"), {
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("cf-turnstile");
  });

  it("requires Turnstile when WORKER_ENV is unknown", async () => {
    const response = renderTurnstileAuthForm(new Request("https://api.test/auth/github"), {
      WORKER_ENV: "staging",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("cf-turnstile");
  });

  it("auto-submit callback disables the fallback button and ignores duplicate callbacks", async () => {
    const response = renderTurnstileAuthForm(new Request("https://api.test/auth/github"), {
      WORKER_ENV: "production",
      TURNSTILE_SITE_KEY: "site",
    } as never);
    const body = await response!.text();
    const script = body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    let submitCount = 0;
    const button = { disabled: false };
    const form = {
      dataset: {} as Record<string, string>,
      querySelector: (selector: string) => (selector === "button[type=submit]" ? button : null),
      requestSubmit: () => {
        submitCount += 1;
      },
      submit: () => {
        throw new Error("requestSubmit should be preferred");
      },
    };
    const fakeWindow = {} as { arcTurnstilePass?: () => void };
    const fakeDocument = {
      getElementById: (id: string) => (id === "arc-auth-form" ? form : null),
    };

    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    new Function(script!)();
    fakeWindow.arcTurnstilePass?.();
    fakeWindow.arcTurnstilePass?.();

    expect(submitCount).toBe(1);
    expect(form.dataset.submitted).toBe("1");
    expect(button.disabled).toBe(true);
  });

  it("requires a Turnstile token before production GitHub OAuth redirects", async () => {
    const request = new Request("https://api.test/auth/github", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(),
    });
    const response = await handleAuthGithub(request, {
      WORKER_ENV: "production",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response.status).toBe(403);
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("requires a Turnstile token before GitHub OAuth redirects when WORKER_ENV is missing", async () => {
    const request = new Request("https://api.test/auth/github", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(),
    });
    const response = await handleAuthGithub(request, {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response.status).toBe(403);
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("verifies Turnstile before minting the GitHub OAuth redirect", async () => {
    mockTracedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const request = new Request("https://api.test/auth/github", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
    });
    const response = await handleAuthGithub(request, {
      WORKER_ENV: "production",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CALLBACK_URL: "https://api.test/auth/callback",
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_SITE_KEY: "site",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(mockTracedFetch).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
      "turnstile.siteverify",
    );
    const body = mockTracedFetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("secret")).toBe("secret");
    expect(body.get("response")).toBe("token");
    expect(body.get("remoteip")).toBe("203.0.113.10");
  });

  it("clears stale GitHub OAuth returnTo cookies when callback state is invalid", async () => {
    mockParseCookies.mockReturnValueOnce({
      oauth_state: "older-state",
      github_oauth_return_to: "/api/sessions/sess-1/artifacts/art-1/shot.png",
    });

    const request = fakeRequest({ cookie: "oauth_state=older-state" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      FRONTEND_URL: "https://app.test",
    } as never);

    const cookies = setCookies(response).join("\n");
    expect(response.status).toBe(400);
    expect(cookies).toContain("oauth_state=");
    expect(cookies).toContain("github_oauth_return_to=");
    expect(cookies).toContain("Max-Age=0");
  });

  it("redirects unknown GitHub users to /pending and inserts a pending signup row", async () => {
    mockGetUserByGithubId.mockResolvedValue(null);
    mockGetPendingSignupByGithubId.mockResolvedValue(null);
    mockUpsertPendingSignup.mockResolvedValue(true);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 999,
            login: "intruder",
            name: "Intruder",
            email: "intruder@example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const pendingWaitUntil: Array<Promise<unknown>> = [];
    const response = await handleAuthCallback(
      request,
      url,
      {
        DB: {},
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
        FRONTEND_URL: "https://app.test",
        RATE_LIMITS: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
        },
      } as never,
      { waitUntil: (promise: Promise<unknown>) => pendingWaitUntil.push(promise) } as ExecutionContext,
    );
    await Promise.all(pendingWaitUntil);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/pending");
    expect(response.headers.get("set-cookie")).not.toContain("session_token=");
    expect(mockUpsertPendingSignup).toHaveBeenCalled();
    expect(mockNotifyCycloidAdminOfPendingSignup).toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "pending_signup_created",
      }),
    );
    const eventPayload = mockPostStructuredEventToDd.mock.calls[0][1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty("githubLogin");
    expect(eventPayload).not.toHaveProperty("githubUserId");
    expect(eventPayload).not.toHaveProperty("email");
    expect(eventPayload).not.toHaveProperty("name");
    expect(eventPayload).not.toHaveProperty("request_id");
    expect(mockAuthenticateGitHubUser).not.toHaveBeenCalled();
    expect(mockCreateAuthSession).not.toHaveBeenCalled();
    expect(mockGetAppSlug).not.toHaveBeenCalled();
  });

  it("rate-limits repeated unknown-user GitHub OAuth signups from the same IP", async () => {
    mockGetUserByGithubId.mockResolvedValue(null);
    mockGetPendingSignupByGithubId.mockResolvedValue(null);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 999, login: "intruder" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123", "cf-connecting-ip": "203.0.113.7" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      FRONTEND_URL: "https://app.test",
      RATE_LIMITS: {
        get: vi.fn().mockResolvedValue("5"),
        put: vi.fn(),
      },
    } as never);

    expect(response.status).toBe(429);
    expect(mockUpsertPendingSignup).not.toHaveBeenCalled();
    expect(mockNotifyCycloidAdminOfPendingSignup).not.toHaveBeenCalled();
  });

  it("redirects previously denied users to /denied without re-notifying", async () => {
    mockGetUserByGithubId.mockResolvedValue(null);
    mockGetPendingSignupByGithubId.mockResolvedValue({
      id: 1,
      githubId: 999,
      login: "intruder",
      name: null,
      email: null,
      avatarUrl: null,
      requestedAt: 1000,
      deniedAt: 2000,
      deniedByUserId: 7,
    });
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 999, login: "intruder" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      FRONTEND_URL: "https://app.test",
      RATE_LIMITS: {
        get: vi.fn(),
        put: vi.fn(),
      },
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/denied");
    expect(mockUpsertPendingSignup).not.toHaveBeenCalled();
    expect(mockNotifyCycloidAdminOfPendingSignup).not.toHaveBeenCalled();
  });

  it("cleans up a stale pending signup if the GitHub user appears before redirecting", async () => {
    mockGetUserByGithubId.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue(ARCANIST_BUSINESS_ID);
    mockGetPendingSignupByGithubId.mockResolvedValue(null);
    mockUpsertPendingSignup.mockResolvedValue(true);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42162445,
            login: "parappally",
            name: "Jay",
            email: "jay@example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installations: [{ app_id: 123 }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123", "cf-connecting-ip": "203.0.113.8" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
      RATE_LIMITS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test");
    expect(mockDeletePendingSignupByGithubId).toHaveBeenCalledWith({}, 42162445);
    expect(mockNotifyCycloidAdminOfPendingSignup).not.toHaveBeenCalled();
    expect(mockAuthenticateGitHubUser).toHaveBeenCalled();
  });

  it("returns 403 without creating a session when business ownership mismatches", async () => {
    mockGetUserByGithubId.mockResolvedValue({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue("biz-existing");
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42162445,
            login: "parappally",
            name: "Jay",
            email: "jay@example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    mockAuthenticateGitHubUser.mockRejectedValueOnce(new MockBusinessMismatchError("biz-existing", "biz-requested"));

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      FRONTEND_URL: "https://app.test",
    } as never);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Access unavailable");
    expect(response.headers.get("set-cookie")).toContain("oauth_state=");
    expect(response.headers.get("set-cookie")).not.toContain("session_token=");
    expect(mockCreateAuthSession).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {
        requestId: null,
        githubLogin: "parappally",
        storedBusinessId: "biz-existing",
        requestedBusinessId: "biz-requested",
        action: "business_mismatch_denied",
      },
      "GitHub OAuth callback denied: business mismatch",
    );
  });

  it("preserves the GitHub App installation redirect after successful login", async () => {
    mockGetUserByGithubId.mockResolvedValue({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue(ARCANIST_BUSINESS_ID);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42162445,
            login: "parappally",
            name: "Jay",
            email: "jay@example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installations: [{ app_id: 999 }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    mockGetAppSlug.mockResolvedValue("cycloid");

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
      RATE_LIMITS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/apps/cycloid/installations/new");
    expect(mockAuthenticateGitHubUser).toHaveBeenCalledWith(
      {},
      {
        id: 42162445,
        login: "parappally",
        name: "Jay",
        email: "jay@example.com",
        avatar_url: undefined,
      },
      { accessToken: "gho_test", refreshToken: null, expiresAt: null },
      expect.any(String),
      undefined,
    );
    expect(mockCreateAuthSession).toHaveBeenCalledWith({}, 42);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { userId: 42, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID, action: "github_oauth_login" },
      "GitHub OAuth login succeeded",
    );
  });

  it("forwards refresh_token, expires_in, and encryption key when GitHub returns an expiring token", async () => {
    mockGetUserByGithubId.mockResolvedValue({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue(ARCANIST_BUSINESS_ID);
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "gho_expiring",
            refresh_token: "ghr_value",
            expires_in: 28800,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42162445, login: "parappally", name: "Jay", email: "jay@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ installations: [{ app_id: 123 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    mockGetAppSlug.mockResolvedValue("cycloid");

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
      TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    } as never);

    expect(mockAuthenticateGitHubUser).toHaveBeenCalledWith(
      {},
      {
        id: 42162445,
        login: "parappally",
        name: "Jay",
        email: "jay@example.com",
        avatar_url: undefined,
      },
      {
        accessToken: "gho_expiring",
        refreshToken: "ghr_value",
        expiresAt: fixedNow + 28800 * 1000,
      },
      ARCANIST_BUSINESS_ID,
      "test-encryption-key",
    );
    dateNowSpy.mockRestore();
  });

  it("creates a pending signup for a newly created GitHub account reusing a former username", async () => {
    mockGetUserByGithubId.mockResolvedValue(null);
    mockGetPendingSignupByGithubId.mockResolvedValue(null);
    mockUpsertPendingSignup.mockResolvedValue(true);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 777777, login: "parappally", name: "Attacker", email: "attacker@example.com" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/pending");
    expect(response.headers.get("set-cookie")).not.toContain("session_token=");
    expect(mockAuthenticateGitHubUser).not.toHaveBeenCalled();
    expect(mockCreateAuthSession).not.toHaveBeenCalled();
    expect(mockUpsertPendingSignup).toHaveBeenCalled();
  });

  it("authenticates an existing user ID after an account rename", async () => {
    mockGetUserByGithubId.mockResolvedValue({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue(ARCANIST_BUSINESS_ID);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42162445,
            login: "parappally-renamed",
            name: "Jay",
            email: "jay@example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installations: [{ app_id: 123 }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test");
    expect(response.headers.get("set-cookie")).toContain("session_token=session-token");
    expect(mockAuthenticateGitHubUser).toHaveBeenCalledWith(
      {},
      {
        id: 42162445,
        login: "parappally-renamed",
        name: "Jay",
        email: "jay@example.com",
        avatar_url: undefined,
      },
      { accessToken: "gho_test", refreshToken: null, expiresAt: null },
      ARCANIST_BUSINESS_ID,
      undefined,
    );
    expect(mockCreateAuthSession).toHaveBeenCalledWith({}, 42);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { userId: 42, githubUserId: 42162445, businessId: ARCANIST_BUSINESS_ID, action: "github_oauth_login" },
      "GitHub OAuth login succeeded",
    );
  });

  it("redirects OAuth returnTo paths as absolute URLs on the callback origin", async () => {
    mockParseCookies.mockReturnValueOnce({
      oauth_state: "state123",
      github_oauth_return_to: "/api/sessions/sess-1/artifacts/art-1/shot.png",
    });
    mockGetUserByGithubId.mockResolvedValue({ id: 42, login: "parappally" });
    mockGetUserBusinessIdOrNull.mockResolvedValue(ARCANIST_BUSINESS_ID);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42162445, login: "parappally", name: "Jay", email: "jay@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ installations: [{ app_id: 123 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const request = fakeRequest({
      cookie: "oauth_state=state123; github_oauth_return_to=/api/sessions/sess-1/artifacts/art-1/shot.png",
    });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://api.test/api/sessions/sess-1/artifacts/art-1/shot.png");
    expect(setCookies(response).join("\n")).toContain("github_oauth_return_to=");
  });

  it("idempotent re-OAuth: existing pending signup does not re-notify Slack", async () => {
    mockGetUserByGithubId.mockResolvedValue(null);
    mockGetPendingSignupByGithubId.mockResolvedValue({
      id: 1,
      githubId: 888888,
      login: "jerome998",
      name: "Stale Username",
      email: "stale@example.com",
      avatarUrl: null,
      requestedAt: 1000,
      deniedAt: null,
      deniedByUserId: null,
    });
    mockUpsertPendingSignup.mockResolvedValue(false);
    mockTracedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 888888, login: "jerome998", name: "Stale Username", email: "stale@example.com" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const request = fakeRequest({ cookie: "oauth_state=state123" });
    const url = new URL("https://api.test/auth/callback?code=authcode&state=state123");
    const response = await handleAuthCallback(request, url, {
      DB: {},
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_ID: "123",
      FRONTEND_URL: "https://app.test",
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/pending");
    expect(mockUpsertPendingSignup).toHaveBeenCalled();
    expect(mockNotifyCycloidAdminOfPendingSignup).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "pending_signup_created" }),
    );
    expect(mockAuthenticateGitHubUser).not.toHaveBeenCalled();
  });
});

describe("handleAuthLogout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without clearing cookies when no session cookie is present", async () => {
    mockParseSessionTokenCookie.mockReturnValue(null);

    const response = await handleAuthLogout(fakeRequest(), fakeEnv() as never);

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockDeleteAuthSession).not.toHaveBeenCalled();
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("deletes the session and clears the cookie when a session cookie is present", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");

    const response = await handleAuthLogout(
      fakeRequest({
        cookie: "session_token=tok_abc",
      }),
      fakeEnv() as never,
    );

    expect(response.status).toBe(200);
    expect(mockDeleteAuthSession).toHaveBeenCalledWith(expect.anything(), "tok_abc");
    expect(response.headers.get("set-cookie")).toContain("session_token=;");
    const body = (await response.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });
});

describe("handleGithubReauthorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracedFetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("revokes the stored GitHub grant token even if token validity is unknown", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    const db = fakeGithubTokenDb({
      oauth_access_token: "gho_stored",
      oauth_refresh_token: null,
      oauth_expires_at: Date.now() - 1,
      encrypted: 0,
    });

    const response = await handleGithubReauthorize(
      fakeRequest({ cookie: "session_token=tok_abc" }),
      fakeEnv({
        DB: db,
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
      }) as never,
      { userId: "42" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(response.headers.get("set-cookie")).toContain("session_token=;");
    expect(mockTracedFetch).toHaveBeenCalledWith(
      "https://api.github.com/applications/client-id/grant",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ access_token: "gho_stored" }),
      }),
      "github.revokeGrant",
    );
    expect(mockClearGithubToken).toHaveBeenCalledWith(db, "42");
    expect(mockDeleteAuthSession).toHaveBeenCalledWith(db, "tok_abc");
  });

  it("logs and still clears local auth when no stored GitHub token exists", async () => {
    mockParseSessionTokenCookie.mockReturnValue("tok_abc");
    const db = fakeGithubTokenDb(null);

    const response = await handleGithubReauthorize(
      fakeRequest({ cookie: "session_token=tok_abc" }),
      fakeEnv({
        DB: db,
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
      }) as never,
      { userId: "42" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(response.headers.get("set-cookie")).toContain("session_token=;");
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { userId: "42" },
      "GitHub reauthorize -- no token to revoke, proceeding with logout",
    );
    expect(mockClearGithubToken).toHaveBeenCalledWith(db, "42");
    expect(mockDeleteAuthSession).toHaveBeenCalledWith(db, "tok_abc");
  });
});
