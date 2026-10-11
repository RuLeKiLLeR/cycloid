import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListBusinesses = vi.fn();
const mockVerifyCycloidAdmin = vi.fn();
const mockApprovePendingSignupSchemaSafeParse = vi.fn();
const mockApprovePendingSignup = vi.fn();

vi.mock("../../apps/control-plane-worker/src/business/db", () => ({
  listBusinesses: (...args: unknown[]) => mockListBusinesses(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/pending-signups-db", () => ({
  listOpenPendingSignups: vi.fn(),
  purgeDeniedPendingSignupsOlderThan: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../apps/control-plane-worker/src/services/admin-approvals", () => ({
  ApprovePendingSignupSchema: { safeParse: (...args: unknown[]) => mockApprovePendingSignupSchemaSafeParse(...args) },
  approvePendingSignup: (...args: unknown[]) => mockApprovePendingSignup(...args),
  denyPendingSignup: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/bootstrap", () => ({
  invalidateModelsMemoryCache: vi.fn(),
  modelsCacheKey: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidAdmin: (...args: unknown[]) => mockVerifyCycloidAdmin(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB: D1Database }) => env.DB,
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
  }),
}));

import { adminApprovalRoutes } from "../../apps/control-plane-worker/src/routes/admin-approvals";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

describe("admin approval routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects impersonated support-view sessions before admin approval reads", async () => {
    const route = adminApprovalRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/businesses"),
    );
    expect(route).toBeTruthy();

    const response = await route!.handler(
      new Request("https://example.com/api/admin/businesses"),
      { DB: {} as D1Database } as Env,
      [] as unknown as RegExpMatchArray,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
        impersonationId: "imp_1",
        readOnly: true,
      } as AuthInfo,
    );

    expect(response.status).toBe(403);
    expect(mockVerifyCycloidAdmin).not.toHaveBeenCalled();
    expect(mockListBusinesses).not.toHaveBeenCalled();
  });

  it("rejects invalid approve request bodies before calling the service", async () => {
    const route = adminApprovalRoutes.find(
      (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/admin/pending-signups/123/approve"),
    );
    expect(route).toBeTruthy();
    mockVerifyCycloidAdmin.mockResolvedValue(true);
    mockApprovePendingSignupSchemaSafeParse.mockReturnValue({
      success: false,
      error: { issues: [{ message: "Invalid input: expected object, received string" }] },
    });

    const response = await route!.handler(
      new Request("https://example.com/api/admin/pending-signups/123/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("not-an-object"),
      }),
      { DB: {} as D1Database } as Env,
      route!.pattern.exec("/api/admin/pending-signups/123/approve")!,
      {
        authMode: "user_session",
        userId: "1",
        tokenSource: "cookie",
        canAccessAllSessions: false,
      } as AuthInfo,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Invalid input: expected object, received string",
    });
    expect(mockApprovePendingSignup).not.toHaveBeenCalled();
  });
});
