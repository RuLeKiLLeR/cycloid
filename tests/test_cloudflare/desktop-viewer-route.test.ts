import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVerifyCycloidMember = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidMember: (...args: unknown[]) => mockVerifyCycloidMember(...args),
}));

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const TICKET_ID = "a".repeat(64);
const PATH = `/api/sessions/s-1/desktop/view-ticket/${TICKET_ID}/ws`;
const REVOKE_PATH = `/api/sessions/s-1/desktop/view-ticket/${TICKET_ID}`;

function desktopViewerRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.pattern.routeTemplate === "/api/sessions/:sessionId/desktop/view-ticket/:ticketId/ws",
  );
  if (!route) throw new Error("desktop viewer websocket route not found");
  return route;
}

function desktopActionPathRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" && candidate.pattern.routeTemplate === "/api/sessions/:sessionId/desktop/action-path",
  );
  if (!route) throw new Error("desktop action path route not found");
  return route;
}

async function callDesktopViewerRoute(origin: string | null): Promise<Response> {
  const route = desktopViewerRoute();
  const headers = new Headers({ upgrade: "websocket" });
  if (origin) headers.set("origin", origin);
  const request = new Request(`https://api.trycycloid.com${PATH}`, { headers });
  const match = new URL(request.url).pathname.match(route.pattern);
  if (!match) throw new Error("desktop viewer websocket route did not match");
  return route.handler(request, { FRONTEND_URL: "https://app.trycycloid.com" } as Env, match, {
    userId: "user-1",
  } as AuthInfo);
}

describe("desktop viewer websocket route", () => {
  beforeEach(() => {
    mockVerifyCycloidMember.mockReset();
    mockVerifyCycloidMember.mockResolvedValue(true);
  });

  it("fails closed before reading an action path for a non-Cycloid user", async () => {
    mockVerifyCycloidMember.mockResolvedValueOnce(false);
    const route = desktopActionPathRoute();
    const request = new Request("https://api.trycycloid.com/api/sessions/s-1/desktop/action-path");
    const match = new URL(request.url).pathname.match(route.pattern);
    if (!match) throw new Error("desktop action path route did not match");

    const response = await route.handler(request, { DB: {} } as Env, match, {
      userId: "user-1",
      user: { id: 1 },
    } as AuthInfo);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden" });
  });

  it("routes desktop ticket revocation separately from generic session archive", () => {
    const revokeRoute = sessionRoutes.find(
      (candidate) =>
        candidate.method === "DELETE" &&
        candidate.pattern.routeTemplate === "/api/sessions/:sessionId/desktop/view-ticket/:ticketId",
    );
    const archiveRoute = sessionRoutes.find(
      (candidate) => candidate.method === "DELETE" && candidate.pattern.routeTemplate === "/api/sessions/:sessionId",
    );

    expect(revokeRoute).toBeDefined();
    expect(archiveRoute).toBeDefined();
    expect(REVOKE_PATH.match(revokeRoute!.pattern)?.groups).toMatchObject({
      sessionId: "s-1",
      ticketId: TICKET_ID,
    });
    expect(REVOKE_PATH.match(archiveRoute!.pattern)).toBeNull();
  });

  it("rejects websocket upgrades without an Origin header", async () => {
    const response = await callDesktopViewerRoute(null);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Origin not allowed" });
  });

  it("rejects websocket upgrades from a foreign Origin", async () => {
    const response = await callDesktopViewerRoute("https://evil.example");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Origin not allowed" });
  });
});
