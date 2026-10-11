import { describe, expect, it, vi } from "vitest";

const mockVerifyCycloidAdmin = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidAdmin: (...args: unknown[]) => mockVerifyCycloidAdmin(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB: D1Database }) => env.DB,
}));

import {
  getCsvQueryParam,
  getTrimmedQueryParam,
  paginateQueryFromRequest,
  requireCycloidAdmin,
  requireRouteAuth,
} from "../../apps/control-plane-worker/src/routes/shared";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

describe("route shared helpers", () => {
  it("requires auth on authenticated routes", () => {
    const auth = { userId: "1", authMode: "user_session", tokenSource: "session" } as AuthInfo;
    expect(requireRouteAuth(auth)).toBe(auth);
    expect(() => requireRouteAuth(null)).toThrow("BUG: requireRouteAuth called without auth on an authenticated route");
  });

  it("reads trimmed and csv query params from a request URL", () => {
    const searchParams = new URL("https://app.test/path?scope=%20business%20&include=a,%20b,,c").searchParams;

    expect(getTrimmedQueryParam(searchParams, "scope")).toBe("business");
    expect(getCsvQueryParam(searchParams, "include")).toEqual(["a", "b", "c"]);
    expect(getCsvQueryParam(searchParams, "missing")).toEqual([]);
  });

  it("parses pagination directly from the request", () => {
    const request = new Request("https://app.test/path?cursor=%20cursor-1%20&limit=250");

    expect(paginateQueryFromRequest(request, 80)).toEqual({ cursor: "cursor-1", limit: 80 });
  });

  it("logs Cycloid admin gate denials and grants when a logger is provided", async () => {
    const auth = { userId: "1", authMode: "user_session", tokenSource: "session" } as AuthInfo;
    const logger = { warn: vi.fn(), info: vi.fn() };
    mockVerifyCycloidAdmin.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const denied = await requireCycloidAdmin({ DB: {} as D1Database } as never, auth, {
      logger,
      logContext: { route: "sandbox" },
    });

    expect(denied?.status).toBe(403);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "1",
        authMode: "user_session",
        tokenSource: "session",
        route: "sandbox",
        status: "denied",
        errorCode: "not_cycloid_admin",
      }),
      "Cycloid admin route denied",
    );

    const allowed = await requireCycloidAdmin({ DB: {} as D1Database } as never, auth, {
      logger,
      logContext: { route: "sandbox" },
    });

    expect(allowed).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "1", route: "sandbox", status: "allowed" }),
      "Cycloid admin route allowed",
    );
  });

  it("allows non-user Cycloid admin auth only when explicitly opted in", async () => {
    const auth = { userId: "1", authMode: "cli_token", tokenSource: "cli_token" } as AuthInfo;
    mockVerifyCycloidAdmin.mockResolvedValue(true);

    await expect(requireCycloidAdmin({ DB: {} as D1Database } as never, auth)).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      requireCycloidAdmin({ DB: {} as D1Database } as never, auth, { allowNonUserSession: true }),
    ).resolves.toBeNull();
  });
});
