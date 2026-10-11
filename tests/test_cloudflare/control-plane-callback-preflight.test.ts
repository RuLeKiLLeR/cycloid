import { describe, expect, it, vi } from "vitest";

import {
  assertLocalControlPlaneCallbackReachable,
  SandboxCallbackPreflightError,
} from "../../apps/control-plane-worker/src/services/control-plane-callback-preflight";

function fetchUrl(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(String(input));
}

describe("local control-plane callback preflight", () => {
  it("skips non-local environments", async () => {
    const fetchImpl = vi.fn();

    await assertLocalControlPlaneCallbackReachable({
      env: { WORKER_ENV: "production" },
      fetchImpl,
      sessionId: "session-1",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes health and the sandbox websocket route for local callback URLs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Expected websocket upgrade request", { status: 426 }));

    await assertLocalControlPlaneCallbackReachable({
      env: {
        WORKER_ENV: "local",
        CONTROL_PLANE_URL: "https://example-tunnel.ngrok-free.dev",
      },
      fetchImpl,
      sessionId: "session-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl.mock.calls[0][0]).pathname).toBe("/api/health");
    const websocketUrl = fetchUrl(fetchImpl.mock.calls[1][0]);
    expect(websocketUrl.pathname).toBe("/api/sessions/session-1/ws");
    expect(websocketUrl.searchParams.get("type")).toBe("sandbox");
  });

  it("rejects local-only callback hosts because Modal cannot reach them", async () => {
    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "http://localhost:3017",
        },
        fetchImpl: vi.fn(),
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      name: "SandboxCallbackPreflightError",
      errorCode: "sandbox_callback",
      check: "configuration",
    });

    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "http://[::1]:3017",
        },
        fetchImpl: vi.fn(),
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      name: "SandboxCallbackPreflightError",
      errorCode: "sandbox_callback",
      check: "configuration",
    });
  });

  it("does not reject public hostnames with private-address-looking prefixes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Expected websocket upgrade request", { status: 426 }));

    await assertLocalControlPlaneCallbackReachable({
      env: {
        WORKER_ENV: "local",
        CONTROL_PLANE_URL: "https://10.example.com",
      },
      fetchImpl,
      sessionId: "session-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects hosted Cycloid callback hosts in local dev", async () => {
    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://app.trycycloid.com",
        },
        fetchImpl: vi.fn(),
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Local control-plane callback URL must not point at hosted Cycloid");

    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://qa.trycycloid.com",
        },
        fetchImpl: vi.fn(),
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      name: "SandboxCallbackPreflightError",
      errorCode: "sandbox_callback",
      check: "configuration",
    });
  });

  it("fails when the health endpoint is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://dead-tunnel.ngrok-free.dev/sensitive/path?token=secret",
        },
        fetchImpl,
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      name: "SandboxCallbackPreflightError",
      errorCode: "sandbox_callback",
      check: "health",
    });
  });

  it("shows the probed route but redacts callback URL paths and query strings", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    let error: Error | null = null;
    try {
      await assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://dead-tunnel.ngrok-free.dev/sensitive/path?token=secret",
        },
        fetchImpl,
        sessionId: "session-1",
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(SandboxCallbackPreflightError);
    expect(error?.message).toContain(
      "Local control-plane callback preflight failed: GET https://dead-tunnel.ngrok-free.dev/api/health was not reachable",
    );
    expect(error?.message).not.toContain("sensitive/path");
    expect(error?.message).not.toContain("token=secret");
  });

  it("shows the websocket route when tunnel health succeeds but session websocket fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://stale-tunnel.ngrok-free.dev",
        },
        fetchImpl,
        sessionId: "session-1",
      }),
    ).rejects.toThrow("GET https://stale-tunnel.ngrok-free.dev/api/sessions/session-1/ws returned HTTP 404");
  });

  it("fails when the tunnel serves health but not the websocket route", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(
      assertLocalControlPlaneCallbackReachable({
        env: {
          WORKER_ENV: "local",
          CONTROL_PLANE_URL: "https://stale-tunnel.ngrok-free.dev",
        },
        fetchImpl,
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      name: "SandboxCallbackPreflightError",
      errorCode: "sandbox_callback",
      check: "websocket",
      status: 404,
    } satisfies Partial<SandboxCallbackPreflightError>);
  });
});
