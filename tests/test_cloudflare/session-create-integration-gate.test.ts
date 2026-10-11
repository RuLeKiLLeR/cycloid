import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const mockGateGithubSessionStart = vi.fn();
const mockVerifyRepoAccessAndInstallation = vi.fn();
const mockCreateSessionState = vi.fn();
const mockSyncSessionProjection = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGateGithubSessionStart(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockVerifyRepoAccessAndInstallation(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import { ProviderCredentialNotValidatedError } from "../../apps/control-plane-worker/src/services/provider-credential-gate";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

function makeAuth(): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "user-42",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "member",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    },
  };
}

function makeAdminAuth(): AuthInfo {
  return {
    userId: "admin-token",
    tokenSource: "bearer",
    authMode: "admin_token",
    canAccessAllSessions: true,
  };
}

function makeEnv(): Env {
  return {
    // Minimal D1 stub: the only query these tests reach is the admission
    // active-session count, which must report under the cap so creation proceeds
    // to the behavior under test.
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ count: 0 }) }) }),
    } as unknown as D1Database,
    REPOS_CACHE: {} as KVNamespace,
  } as Env;
}

function getCreateSessionRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/sessions"),
  );
  if (!route) throw new Error("Create session route not found");
  return route;
}

describe("session create integration gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({
      session: { sessionId: "sess-1", ownerUserId: "42" },
      replay: [],
    });
    mockSyncSessionProjection.mockResolvedValue(undefined);
  });

  it("returns 409 when the GitHub integration gate blocks session start", async () => {
    mockGateGithubSessionStart.mockResolvedValue({
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: "provider_probe_passed",
        reasonCode: "repo_access_denied",
        userMessage: "Reconnect GitHub",
      },
    });

    const route = getCreateSessionRoute();
    const response = await route.handler(
      new Request("https://worker.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ repoOwner: "trycycloid", repoName: "cycloid" }),
      }),
      makeEnv(),
      route.pattern.exec("/api/sessions")!,
      makeAuth(),
    );

    expect(response.status).toBe(409);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: "integration_blocked",
      integrationId: "github",
      reasonCode: "repo_access_denied",
    });
  });

  it.each([
    ["a/../b", "cycloid"],
    ["trycycloid", "a/../b"],
    [".", "cycloid"],
    ["..", "cycloid"],
    ["try@cycloid", "cycloid"],
  ])("returns 400 for malformed repoOwner/repoName %s/%s", async (repoOwner, repoName) => {
    const route = getCreateSessionRoute();
    const response = await route.handler(
      new Request("https://worker.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ repoOwner, repoName }),
      }),
      makeEnv(),
      route.pattern.exec("/api/sessions")!,
      makeAuth(),
    );

    expect(response.status).toBe(400);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("uses the resolved owner user id for admin-created sessions", async () => {
    mockGateGithubSessionStart.mockResolvedValue({
      ok: true,
      installationId: 99,
    });

    const route = getCreateSessionRoute();
    const response = await route.handler(
      new Request("https://worker.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ ownerUserId: 1001, repoOwner: "trycycloid", repoName: "cycloid" }),
      }),
      makeEnv(),
      route.pattern.exec("/api/sessions")!,
      makeAdminAuth(),
    );

    expect(response.status).toBe(201);
    expect(mockGateGithubSessionStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "1001",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    );
    expect(mockVerifyRepoAccessAndInstallation).not.toHaveBeenCalled();
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        installationId: 99,
        repoContext: expect.objectContaining({
          repoOwner: "trycycloid",
          repoName: "cycloid",
        }),
      }),
    );
  });

  it("maps provider credential failures to the stable 409 response", async () => {
    mockGateGithubSessionStart.mockResolvedValue({
      ok: true,
      installationId: 99,
    });
    mockCreateSessionState.mockRejectedValueOnce(
      new ProviderCredentialNotValidatedError("anthropic", "claude-opus-4-8", "credentials_present"),
    );

    const route = getCreateSessionRoute();
    const response = await route.handler(
      new Request("https://worker.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          repoOwner: "trycycloid",
          repoName: "cycloid",
          model: "claude-opus-4-8",
        }),
      }),
      makeEnv(),
      route.pattern.exec("/api/sessions")!,
      makeAuth(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "provider_key_not_validated",
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      reasonCode: "credentials_present",
      message: "No validated Anthropic key. Validate your key in Settings to use claude-opus-4-8.",
    });
  });
});
