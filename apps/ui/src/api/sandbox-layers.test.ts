import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxLayerBuildRequest, type SandboxLayerBuildRequest } from "./sandbox-layers";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Full envelope as serialized by the control plane's formatBuildRequest()
// (sandbox/layer-source-service.ts) — the response schema requires it.
const BUILD_REQUEST_ENVELOPE: SandboxLayerBuildRequest = {
  id: "build-1",
  status: "queued",
  repo: "acme org/widgets",
  sourceRepo: "acme org/widgets",
  targetRepo: "acme/target",
  requestedRef: "main",
  commitSha: "abc123",
  manifestPath: ".cycloid/sandbox.yaml",
  layerPath: ".cycloid/sandbox.Dockerfile",
  sourceContentHash: "hash-1",
  baseTemplateRef: "base-template",
  baseVersion: "1.2.3",
  baseSource: "registry",
  baseVersionQuality: "versioned",
  resourceProfileKey: "default",
  promotionEligibility: "default_branch_head",
  willPromote: 1,
  providerArtifactRef: null,
  activeTemplateRef: null,
  createdBy: { userId: 7, login: "octocat", name: "Octo Cat" },
  failureSummary: null,
};

describe("sandbox layer API", () => {
  it("posts rebuild requests to the repo route with an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          buildRequest: BUILD_REQUEST_ENVELOPE,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const buildRequest = await createSandboxLayerBuildRequest("biz-1", "acme org", "widgets", {
      manifestPath: ".cycloid/sandbox.yaml",
      targetRepo: { owner: "acme", name: "target" },
      idempotencyKey: "rebuild-key-1",
    });

    expect(buildRequest).toEqual(BUILD_REQUEST_ENVELOPE);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/businesses/biz-1/repos/acme%20org/widgets/sandbox-layer/build-requests");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("rebuild-key-1");
    expect(JSON.parse(String(init.body))).toEqual({
      manifestPath: ".cycloid/sandbox.yaml",
      targetRepo: { owner: "acme", name: "target" },
    });
  });

  it("fails closed when the build-request envelope is malformed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        // Missing every required envelope field beyond id/status.
        JSON.stringify({ ok: true, buildRequest: { id: "build-1", status: "queued" } }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSandboxLayerBuildRequest("biz-1", "acme", "widgets", { idempotencyKey: "rebuild-key-2" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
