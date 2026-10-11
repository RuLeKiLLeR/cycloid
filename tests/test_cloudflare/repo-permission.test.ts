import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";

const mocks = vi.hoisted(() => ({
  createInstallationToken: vi.fn<(env: Env, installationId: number) => Promise<string>>(),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: mocks.createInstallationToken,
}));

import {
  actorCanWriteToRepo,
  getActorRepoPermissionLevel,
  type RepoPermissionLevel,
} from "../../apps/control-plane-worker/src/github/repo-permission";

const ENV = {} as Env;
const ARGS = {
  installationId: 42,
  repoOwner: "trycycloid",
  repoName: "cycloid",
  actorLogin: "octocat",
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createInstallationToken.mockResolvedValue("installation-token");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getActorRepoPermissionLevel", () => {
  it.each(["admin", "maintain", "write", "triage", "read"] as const)(
    "returns the %s role_name permission",
    async (level) => {
      fetchMock.mockResolvedValue(Response.json({ role_name: level, permission: "none" }));

      await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBe(level);

      expect(mocks.createInstallationToken).toHaveBeenCalledWith(ENV, ARGS.installationId);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.github.com/repos/trycycloid/cycloid/collaborators/octocat/permission");
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer installation-token");
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("user-agent")).toBe("Cycloid-Control-Plane");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    },
  );

  it.each(["admin", "write", "read", "none"] as const)("falls back to the %s permission field", async (level) => {
    fetchMock.mockResolvedValue(Response.json({ permission: level }));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBe(level);
  });

  it("prefers a recognized role_name over permission", async () => {
    fetchMock.mockResolvedValue(Response.json({ role_name: "maintain", permission: "write" }));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBe("maintain");
  });

  it("returns none for a 404", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBe("none");
  });

  it("returns null for a non-404 error response", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    fetchMock.mockResolvedValue(new Response("{not-json", { status: 200 }));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBeNull();
  });

  it("returns null when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));

    await expect(getActorRepoPermissionLevel(ENV, ARGS)).resolves.toBeNull();
  });
});

describe("actorCanWriteToRepo", () => {
  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
    [null, false],
  ] satisfies Array<[RepoPermissionLevel | null, boolean]>)("maps %s to %s", (level, expected) => {
    expect(actorCanWriteToRepo(level)).toBe(expected);
  });
});
