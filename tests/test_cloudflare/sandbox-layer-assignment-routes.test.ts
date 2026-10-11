import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const serviceMocks = vi.hoisted(() => ({
  setBusinessDefault: vi.fn(),
  listAssignments: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/sandbox/layer-assignment-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/control-plane-worker/src/sandbox/layer-assignment-service")>();
  return {
    ...actual,
    listSandboxLayerAssignments: serviceMocks.listAssignments,
    setSandboxLayerBusinessDefaultSource: serviceMocks.setBusinessDefault,
  };
});

import { sandboxLayerAssignmentRoutes } from "../../apps/control-plane-worker/src/routes/sandbox-layer-assignments";
import { SandboxLayerAssignmentError } from "../../apps/control-plane-worker/src/sandbox/layer-assignment-service";

const auth: AuthInfo = {
  userId: "1",
  tokenSource: "test",
  authMode: "user_session",
  canAccessAllSessions: false,
  user: {
    id: 1,
    login: "admin",
    name: null,
    email: null,
    businessId: "biz-1",
    businessRole: "admin",
  },
};

function findRoute(method: string, path: string) {
  const route = sandboxLayerAssignmentRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!route) throw new Error(`Missing route for ${method} ${path}`);
  return route;
}

describe("sandbox layer assignment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers authenticated assignment endpoints", () => {
    const routeKeys = sandboxLayerAssignmentRoutes.map((route) => `${route.method}:${route.auth}:${route.pattern}`);
    expect(routeKeys).toEqual([
      "GET:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/assignments$/",
      "PUT:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/default-source$/",
      "DELETE:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/sandbox-layer\\/default-source$/",
      "PUT:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/repos\\/(?<owner>[^/]+)\\/(?<repo>[^/]+)\\/sandbox-layer\\/assignment$/",
      "DELETE:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/repos\\/(?<owner>[^/]+)\\/(?<repo>[^/]+)\\/sandbox-layer\\/assignment$/",
      "GET:authenticated:/^\\/api\\/businesses\\/(?<businessId>[^/]+)\\/repos\\/(?<owner>[^/]+)\\/(?<repo>[^/]+)\\/sandbox-layer\\/resolution$/",
    ]);
  });

  it("passes default-source assignment bodies to the service", async () => {
    serviceMocks.setBusinessDefault.mockResolvedValueOnce({
      assignment: { sourceRepo: "acme/templates", sourceId: "source-1" },
    });
    const path = "/api/businesses/biz-1/sandbox-layer/default-source";
    const route = findRoute("PUT", path);
    const response = await route.handler(
      new Request(`https://example.test${path}`, {
        method: "PUT",
        body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "templates" }),
      }),
      { DB: {} } as Env,
      path.match(route.pattern)!,
      auth,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, assignment: { sourceId: "source-1" } });
    expect(serviceMocks.setBusinessDefault).toHaveBeenCalledWith(
      expect.anything(),
      auth,
      expect.objectContaining({
        businessId: "biz-1",
        source: { sourceRepoOwner: "acme", sourceRepoName: "templates" },
      }),
    );
  });

  it("maps assignment service errors to stable JSON codes", async () => {
    serviceMocks.listAssignments.mockRejectedValueOnce(
      new SandboxLayerAssignmentError("business_admin_required", "Business admin access is required", 403),
    );
    const path = "/api/businesses/biz-1/sandbox-layer/assignments";
    const route = findRoute("GET", path);
    const response = await route.handler(
      new Request(`https://example.test${path}`),
      { DB: {} } as Env,
      path.match(route.pattern)!,
      auth,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "business_admin_required",
    });
  });
});
