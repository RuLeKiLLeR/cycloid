import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createFetchRouter(
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[href];
    if (!route) {
      throw new Error(`Unexpected fetch URL: ${href}`);
    }
    return typeof route === "function" ? await route(new Request(href, init)) : route;
  }) as typeof fetch;
}

describe("vercel dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds specs only when Vercel credentials are present", async () => {
    const { buildVercelGetDeploymentForRefDynamicToolSpec, buildVercelGetPreviewUrlDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/vercel-dynamic-tool.js");

    expect(buildVercelGetDeploymentForRefDynamicToolSpec({})).toEqual([]);
    expect(buildVercelGetPreviewUrlDynamicToolSpec({ VERCEL_ACCESS_TOKEN: "token" })).toHaveLength(1);
    expect(
      buildVercelGetDeploymentForRefDynamicToolSpec({ VERCEL_ACCESS_TOKEN: "token", VERCEL_TEAM_ID: "team_abc" }),
    ).toMatchObject([{ namespace: "vercel", name: "get_deployment_for_ref" }]);
  });

  it("resolves a deployment by git SHA", async () => {
    const { executeVercelGetDeploymentForRefDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/vercel-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://api.vercel.com/v6/deployments?projectId=prj_123&limit=1&meta-githubCommitSha=abc123&teamId=team_abc":
        () =>
          new Response(
            JSON.stringify({
              deployments: [
                {
                  uid: "dpl_123",
                  name: "widgets",
                  url: "widgets-git-feature-acme.vercel.app",
                  readyState: "READY",
                  target: "preview",
                  meta: { githubCommitSha: "abc123", githubCommitRef: "feature/auth" },
                },
              ],
            }),
            { status: 200 },
          ),
    });

    const result = await executeVercelGetDeploymentForRefDynamicToolCall(
      { projectId: "prj_123", gitSha: "abc123" },
      { env: { VERCEL_ACCESS_TOKEN: "token", VERCEL_TEAM_ID: "team_abc" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      deploymentId: "dpl_123",
      projectId: "prj_123",
      status: "READY",
      previewUrl: "https://widgets-git-feature-acme.vercel.app",
      gitSha: "abc123",
      gitRef: "feature/auth",
    });
  });

  it("returns preview URL only from get_preview_url", async () => {
    const { executeVercelGetPreviewUrlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/vercel-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://api.vercel.com/v6/deployments?projectId=prj_123&limit=1&meta-githubCommitRef=feature%2Fauth": () =>
        new Response(
          JSON.stringify({
            deployments: [
              {
                uid: "dpl_456",
                url: "widgets-preview.vercel.app",
                readyState: "READY",
                meta: { githubCommitRef: "feature/auth" },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const result = await executeVercelGetPreviewUrlDynamicToolCall(
      { projectId: "prj_123", gitRef: "feature/auth" },
      { env: { VERCEL_ACCESS_TOKEN: "token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      projectId: "prj_123",
      gitRef: "feature/auth",
      status: "READY",
      previewUrl: "https://widgets-preview.vercel.app",
      deploymentId: "dpl_456",
    });
  });
});
