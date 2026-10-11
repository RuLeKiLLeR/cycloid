import { describe, expect, it } from "vitest";

import { drainSpans, endSpan, runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";
import { withRouteSpan } from "../../apps/control-plane-worker/src/observability/route-span";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

function makeAuth(): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session_token",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "jdoe",
      name: "Jane Doe",
      email: "jane@example.com",
      businessId: "biz-1",
    },
  };
}

describe("withRouteSpan", () => {
  it("runs work inside the route span context and applies route attributes", async () => {
    const root = startSpan("worker.fetch", { "request.id": "req-1" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      await withRouteSpan("repos.list", { auth: makeAuth() }, async (routeSpan) => {
        routeSpan.setAttributes({
          "cache.status": "hit",
          "db.rows_returned": 3,
        });

        const child = startSpan("kv.get", { "kv.namespace": "REPOS_CACHE" });
        endSpan(child, "ok");
      });

      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "repos.list");
    const childSpan = spans.find((span) => span.name === "kv.get");
    const rootSpan = spans.find((span) => span.name === "worker.fetch");

    expect(routeSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(rootSpan).toBeDefined();

    expect(routeSpan!.parentSpanId).toBe(root.spanId);
    expect(routeSpan!.attributes["user.id"]).toBe("42");
    expect(routeSpan!.attributes["business.id"]).toBe("biz-1");
    expect(routeSpan!.attributes["cache.status"]).toBe("hit");
    expect(routeSpan!.attributes["db.rows_returned"]).toBe(3);
    expect(childSpan!.parentSpanId).toBe(routeSpan!.spanId);
  });

  it("marks the span as error and preserves dynamic attributes when the route throws", async () => {
    const root = startSpan("worker.fetch", { "request.id": "req-2" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      await expect(
        withRouteSpan("models.list", { auth: makeAuth() }, async (routeSpan) => {
          routeSpan.setAttribute("cache.status", "miss");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "models.list");

    expect(routeSpan).toBeDefined();
    expect(routeSpan!.status).toBe("error");
    expect(routeSpan!.attributes["cache.status"]).toBe("miss");
    expect(routeSpan!.attributes["error.message"]).toBe("Error: boom");
  });

  it("marks handled 5xx responses as error spans", async () => {
    const root = startSpan("worker.fetch", { "request.id": "req-3" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      const response = await withRouteSpan("sessions.view", { auth: makeAuth() }, async (routeSpan) => {
        routeSpan.setAttribute("error.message", "Failed to assemble session view");
        return new Response(JSON.stringify({ ok: false }), { status: 500 });
      });

      expect(response.status).toBe(500);
      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "sessions.view");

    expect(routeSpan).toBeDefined();
    expect(routeSpan!.status).toBe("error");
    expect(routeSpan!.attributes["error.message"]).toBe("Failed to assemble session view");
  });

  it("keeps handled 4xx responses as ok spans", async () => {
    const root = startSpan("worker.fetch", { "request.id": "req-4" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      const response = await withRouteSpan("sessions.view", { auth: makeAuth() }, async (routeSpan) => {
        routeSpan.setAttribute("cache.status", "miss");
        return new Response(JSON.stringify({ ok: false }), { status: 404 });
      });

      expect(response.status).toBe(404);
      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "sessions.view");

    expect(routeSpan).toBeDefined();
    expect(routeSpan!.status).toBe("ok");
    expect(routeSpan!.attributes["cache.status"]).toBe("miss");
  });
});
