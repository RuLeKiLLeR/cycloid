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

const mockVerifyUserRepoAccess = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock("../../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

const mockGetInstallationByOwner = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

import { verifyRepoAccessAndInstallation } from "../../../apps/control-plane-worker/src/services/repo-gate";

const fakeDb = {} as D1Database;
const memberAuth = { userId: "u1", canAccessAllSessions: false, businessRole: "member" as const };

describe("verifyRepoAccessAndInstallation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns installationId on success for regular user", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 42, suspended_at: null });

    const result = await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo");

    expect(result).toEqual({ ok: true, installationId: 42 });
    expect(mockVerifyUserRepoAccess).toHaveBeenCalledWith(fakeDb, "u1", "acme", "repo", {
      githubTokenEnv: undefined,
      reposCacheEnv: undefined,
    });
    expect(mockGetInstallationByOwner).toHaveBeenCalledWith(fakeDb, "acme");
  });

  it("skips repo access check for API-token users", async () => {
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 7, suspended_at: null });

    const result = await verifyRepoAccessAndInstallation(
      fakeDb,
      { userId: "u1", canAccessAllSessions: true },
      "acme",
      "repo",
    );

    expect(result).toEqual({ ok: true, installationId: 7 });
    expect(mockVerifyUserRepoAccess).not.toHaveBeenCalled();
  });

  it("returns 403 when user lacks repo access", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(false);

    const result = await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("repo_access_denied");
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("You do not have access to this repository on GitHub");
    }
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
  });

  it("returns 503 when repo access verification throws", async () => {
    mockVerifyUserRepoAccess.mockRejectedValue(new Error("GitHub API timeout"));

    const result = await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("access_unverifiable");
      expect(result.response.status).toBe(503);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Unable to verify repository access. Please try again.");
    }
  });

  it("returns 403 when no installation exists", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue(null);

    const result = await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("installation_missing");
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Cycloid is not installed on this GitHub organization");
    }
  });

  it("returns 403 when installation is suspended", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 42, suspended_at: 1700000000 });

    const result = await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("installation_suspended");
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Cycloid installation is suspended for this GitHub organization");
    }
  });

  it("passes reposCacheEnv through to verifyUserRepoAccess", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 1, suspended_at: null });

    const fakeCache = {} as Pick<import("../../../apps/control-plane-worker/src/types").Env, "REPOS_CACHE">;
    await verifyRepoAccessAndInstallation(fakeDb, memberAuth, "acme", "repo", { reposCacheEnv: fakeCache });

    expect(mockVerifyUserRepoAccess).toHaveBeenCalledWith(fakeDb, "u1", "acme", "repo", {
      githubTokenEnv: undefined,
      reposCacheEnv: fakeCache,
    });
  });

  it("normalizes repo access denial before business membership is established", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(false);

    const result = await verifyRepoAccessAndInstallation(
      fakeDb,
      { userId: "u1", canAccessAllSessions: false, businessRole: null },
      "acme",
      "repo",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Access unavailable. Contact your administrator.");
    }
  });

  it("normalizes installation state before business membership is established", async () => {
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 42, suspended_at: 1700000000 });

    const result = await verifyRepoAccessAndInstallation(
      fakeDb,
      { userId: "u1", canAccessAllSessions: false, businessRole: null },
      "acme",
      "repo",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Access unavailable. Contact your administrator.");
    }
  });
});
