import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBusinessEgressAllowlistSource: vi.fn(),
  setBusinessEgressPolicy: vi.fn(),
  getInstallationByOwner: vi.fn(),
  createScopedInstallationToken: vi.fn(),
  getDefaultBranch: vi.fn(),
  createPullRequest: vi.fn(),
  getFileContent: vi.fn(),
  getRefSha: vi.fn(),
  createOrResetRef: vi.fn(),
  createOrUpdateFile: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/business/db", () => ({
  getBusinessEgressAllowlistSource: mocks.getBusinessEgressAllowlistSource,
}));

vi.mock("../../apps/control-plane-worker/src/business/service", () => ({
  setBusinessEgressPolicy: mocks.setBusinessEgressPolicy,
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: mocks.getInstallationByOwner,
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createScopedInstallationToken: mocks.createScopedInstallationToken,
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getDefaultBranch: mocks.getDefaultBranch,
  createPullRequest: mocks.createPullRequest,
}));

vi.mock("../../apps/control-plane-worker/src/memory/github", () => ({
  getFileContent: mocks.getFileContent,
  getRefSha: mocks.getRefSha,
  createOrResetRef: mocks.createOrResetRef,
  createOrUpdateFile: mocks.createOrUpdateFile,
}));

const { createBusinessEgressAllowlistPullRequest, syncBusinessEgressAllowlistFromSource } =
  await import("../../apps/control-plane-worker/src/business/egress-allowlist-source");

function env() {
  return { DB: {} as D1Database } as never;
}

describe("egress allowlist source service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBusinessEgressAllowlistSource.mockResolvedValue({
      sourceRepoOwner: "acme",
      sourceRepoName: "policy",
    });
    mocks.getInstallationByOwner.mockResolvedValue({
      installation_id: 123,
      owner_login: "acme",
      owner_id: 456,
      owner_type: "Organization",
      repository_selection: "selected",
      permissions_json: null,
      events_json: null,
      created_at: Date.now(),
      suspended_at: null,
    });
    mocks.createScopedInstallationToken.mockResolvedValue("installation-token");
    mocks.getDefaultBranch.mockResolvedValue("main");
  });

  it("does not clear the runtime policy when the source file is absent", async () => {
    mocks.getFileContent.mockResolvedValue(null);

    const result = await syncBusinessEgressAllowlistFromSource(env(), "biz-1");

    expect(result.fileExists).toBe(false);
    expect(result.domains).toEqual([]);
    expect(mocks.setBusinessEgressPolicy).not.toHaveBeenCalled();
  });

  it("rejects over-limit source files during sync before updating runtime policy", async () => {
    const domains = Array.from({ length: 101 }, (_, index) => `api-${index}.example.test`);
    mocks.getFileContent.mockResolvedValue(`${domains.join("\n")}\n`);

    await expect(syncBusinessEgressAllowlistFromSource(env(), "biz-1")).rejects.toThrow(
      ".cycloid/egress-allowlist.txt must contain at most 100 domain names",
    );
    expect(mocks.setBusinessEgressPolicy).not.toHaveBeenCalled();
  });

  it("preserves pending domains when updating an existing allowlist PR branch", async () => {
    mocks.getRefSha.mockImplementation(async (_token: string, _owner: string, _repo: string, ref: string) => {
      if (ref === "heads/main") return "base-sha";
      if (ref === "heads/cycloid/egress-allowlist-biz-1") return "branch-sha";
      throw new Error(`unexpected ref ${ref}`);
    });
    mocks.getFileContent.mockImplementation(
      async (_token: string, _owner: string, _repo: string, _path: string, ref: string) => {
        if (ref === "main") return "base.example.test\n";
        if (ref === "cycloid/egress-allowlist-biz-1") return "a.example.test\nbase.example.test\n";
        return null;
      },
    );
    mocks.createPullRequest.mockResolvedValue({
      created: false,
      prUrl: "https://github.com/acme/policy/pull/7",
      prNumber: 7,
    });

    const result = await createBusinessEgressAllowlistPullRequest(env(), {
      businessId: "biz-1",
      domains: ["b.example.test"],
    });

    expect(mocks.createOrResetRef).not.toHaveBeenCalled();
    expect(mocks.createOrUpdateFile).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "policy",
      expect.objectContaining({
        branch: "cycloid/egress-allowlist-biz-1",
        content: "a.example.test\nb.example.test\nbase.example.test\n",
      }),
    );
    expect(result.addedDomains).toEqual(["b.example.test"]);
    expect(result.domains).toEqual(["a.example.test", "b.example.test", "base.example.test"]);
    expect(result.status).toBe("updated");
  });

  it("rejects PR updates that would exceed the total source domain limit", async () => {
    const existingDomains = Array.from({ length: 99 }, (_, index) => `api-${index}.example.test`);
    mocks.getRefSha.mockImplementation(async (_token: string, _owner: string, _repo: string, ref: string) => {
      if (ref === "heads/main") return "base-sha";
      throw new Error("GitHub get ref failed (404): missing");
    });
    mocks.getFileContent.mockResolvedValue(`${existingDomains.join("\n")}\n`);

    await expect(
      createBusinessEgressAllowlistPullRequest(env(), {
        businessId: "biz-1",
        domains: ["extra-1.example.test", "extra-2.example.test"],
      }),
    ).rejects.toThrow(".cycloid/egress-allowlist.txt must contain at most 100 domain names");
    expect(mocks.createOrResetRef).not.toHaveBeenCalled();
    expect(mocks.createOrUpdateFile).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });
});
