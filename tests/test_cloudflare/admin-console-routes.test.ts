import { describe, expect, it, vi } from "vitest";

const mockVerifyCycloidAdmin = vi.fn();
const mockListAdminBusinessesDetailed = vi.fn();
const mockSearchAdminBusinesses = vi.fn();
const mockGetAdminBusinessDetail = vi.fn();
const mockSearchAdminUsers = vi.fn();
const mockGetAdminUserDetail = vi.fn();
const mockListAdminSessions = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/admin-console", () => ({
  listAdminBusinessesDetailed: (...args: unknown[]) => mockListAdminBusinessesDetailed(...args),
  searchAdminBusinesses: (...args: unknown[]) => mockSearchAdminBusinesses(...args),
  getAdminBusinessDetail: (...args: unknown[]) => mockGetAdminBusinessDetail(...args),
  searchAdminUsers: (...args: unknown[]) => mockSearchAdminUsers(...args),
  getAdminUserDetail: (...args: unknown[]) => mockGetAdminUserDetail(...args),
  listAdminSessions: (...args: unknown[]) => mockListAdminSessions(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidAdmin: (...args: unknown[]) => mockVerifyCycloidAdmin(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB: D1Database }) => env.DB,
}));

import { adminConsoleRoutes } from "../../apps/control-plane-worker/src/routes/admin-console";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const env = { DB: {} as D1Database } as Env;

function userSessionAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    authMode: "user_session",
    userId: "1",
    tokenSource: "cookie",
    canAccessAllSessions: false,
    ...overrides,
  } as AuthInfo;
}

function findRoute(method: string, path: string) {
  const route = adminConsoleRoutes.find((c) => c.method === method && c.pattern.test(path));
  if (!route) throw new Error(`No route for ${method} ${path}`);
  const match = path.match(route.pattern)!;
  return { route, match };
}

describe("admin console routes", () => {
  it("rejects non user-session auth before reads", async () => {
    mockVerifyCycloidAdmin.mockReset();
    mockListAdminBusinessesDetailed.mockReset();
    const { route, match } = findRoute("GET", "/api/admin/console/businesses");
    const res = await route.handler(
      new Request("https://example.com/api/admin/console/businesses"),
      env,
      match,
      userSessionAuth({ authMode: "cli_token" }) as AuthInfo,
    );
    expect(res.status).toBe(403);
    expect(mockVerifyCycloidAdmin).not.toHaveBeenCalled();
    expect(mockListAdminBusinessesDetailed).not.toHaveBeenCalled();
  });

  it("rejects impersonated sessions before reads", async () => {
    mockVerifyCycloidAdmin.mockReset();
    mockListAdminBusinessesDetailed.mockReset();
    const { route, match } = findRoute("GET", "/api/admin/console/businesses");
    const res = await route.handler(
      new Request("https://example.com/api/admin/console/businesses"),
      env,
      match,
      userSessionAuth({ impersonationId: "imp_1", readOnly: true }),
    );
    expect(res.status).toBe(403);
    expect(mockListAdminBusinessesDetailed).not.toHaveBeenCalled();
  });

  it("rejects non-admin users", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(false);
    mockListAdminBusinessesDetailed.mockReset();
    const { route, match } = findRoute("GET", "/api/admin/console/businesses");
    const res = await route.handler(
      new Request("https://example.com/api/admin/console/businesses"),
      env,
      match,
      userSessionAuth(),
    );
    expect(res.status).toBe(403);
    expect(mockListAdminBusinessesDetailed).not.toHaveBeenCalled();
  });

  it("forwards business id and 404s when missing", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockGetAdminBusinessDetail.mockReset().mockResolvedValue(null);
    const { route, match } = findRoute("GET", "/api/admin/console/businesses/biz-abc");
    const res = await route.handler(
      new Request("https://example.com/api/admin/console/businesses/biz-abc"),
      env,
      match,
      userSessionAuth(),
    );
    expect(res.status).toBe(404);
    expect(mockGetAdminBusinessDetail).toHaveBeenCalledWith(env.DB, "biz-abc");
  });

  it("parses business search filters from query string", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockListAdminBusinessesDetailed.mockReset();
    mockSearchAdminBusinesses.mockReset().mockResolvedValue([]);
    const { route, match } = findRoute("GET", "/api/admin/console/businesses");
    await route.handler(
      new Request("https://example.com/api/admin/console/businesses?q=acme&orderBy=createdAt&limit=10"),
      env,
      match,
      userSessionAuth(),
    );
    expect(mockSearchAdminBusinesses).toHaveBeenCalledWith(env.DB, {
      query: "acme",
      orderBy: "createdAt",
      limit: 10,
    });
    expect(mockListAdminBusinessesDetailed).not.toHaveBeenCalled();
  });

  it("lists businesses when the search query is blank", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockListAdminBusinessesDetailed.mockReset().mockResolvedValue([]);
    mockSearchAdminBusinesses.mockReset();
    const { route, match } = findRoute("GET", "/api/admin/console/businesses");
    await route.handler(
      new Request("https://example.com/api/admin/console/businesses?q=%20%20&orderBy=name&limit=15"),
      env,
      match,
      userSessionAuth(),
    );
    expect(mockListAdminBusinessesDetailed).toHaveBeenCalledWith(env.DB, {
      orderBy: "name",
      limit: 15,
    });
    expect(mockSearchAdminBusinesses).not.toHaveBeenCalled();
  });

  it("parses session filters from query string", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockListAdminSessions.mockReset().mockResolvedValue([]);
    const { route, match } = findRoute("GET", "/api/admin/console/sessions");
    await route.handler(
      new Request("https://example.com/api/admin/console/sessions?businessId=b1&userId=42&status=active&limit=10"),
      env,
      match,
      userSessionAuth(),
    );
    expect(mockListAdminSessions).toHaveBeenCalledWith(env.DB, {
      businessId: "b1",
      userId: 42,
      status: "active",
      limit: 10,
    });
  });

  it("ignores invalid session status filter", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockListAdminSessions.mockReset().mockResolvedValue([]);
    const { route, match } = findRoute("GET", "/api/admin/console/sessions");
    await route.handler(
      new Request("https://example.com/api/admin/console/sessions?status=banana"),
      env,
      match,
      userSessionAuth(),
    );
    expect(mockListAdminSessions).toHaveBeenCalledWith(env.DB, {
      businessId: undefined,
      userId: undefined,
      status: undefined,
      limit: undefined,
    });
  });

  it("400s on non-numeric user id", async () => {
    mockVerifyCycloidAdmin.mockReset().mockResolvedValue(true);
    mockGetAdminUserDetail.mockReset();
    const { route, match } = findRoute("GET", "/api/admin/console/users/abc");
    const res = await route.handler(
      new Request("https://example.com/api/admin/console/users/abc"),
      env,
      match,
      userSessionAuth(),
    );
    expect(res.status).toBe(400);
    expect(mockGetAdminUserDetail).not.toHaveBeenCalled();
  });
});
