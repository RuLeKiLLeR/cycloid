import { describe, expect, it, vi } from "vitest";

import { E2BSandboxRuntimeError } from "../../apps/control-plane-worker/src/sandbox/e2b-client";
import {
  buildDesktopViewerUpstream,
  buildDesktopViewTicketPaths,
  detectRfbInputAttempt,
  isValidDesktopViewerUpstreamHost,
  proxyDesktopViewerWebSocket,
  resolveDesktopViewerUpstream,
  RfbViewOnlyInputGuard,
} from "../../apps/control-plane-worker/src/services/desktop-viewer-proxy";

class FakeWebSocket {
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.closedCode = code ?? null;
    this.closedReason = reason ?? null;
    this.emit("close", {});
  });
  readonly accept = vi.fn();
  closedCode: number | null = null;
  closedReason: string | null = null;
  private readonly listeners = new Map<string, Array<(event: { data?: string | ArrayBuffer }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string | ArrayBuffer }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  emit(type: string, event: { data?: string | ArrayBuffer }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("desktop viewer proxy helpers", () => {
  it("keeps provider host and token out of browser-facing ticket paths", () => {
    const response = buildDesktopViewTicketPaths("session-1", {
      ticketId: "a".repeat(64),
      expiresAtMs: 1000,
      hardExpiresAtMs: 2000,
      heartbeatIntervalMs: 20_000,
      viewOnly: true,
    });

    expect(response.ticket.websocketPath).toBe(
      "/api/sessions/session-1/desktop/view-ticket/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ws",
    );
    expect(response.ticket.statusPath).toBe(
      "/api/sessions/session-1/desktop/view-ticket/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status",
    );
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("6080");
    expect(serialized).not.toContain("e2b.app");
    expect(serialized).not.toContain("traffic");
    expect(serialized).not.toContain("secret-token");
  });

  it("builds the server-only websockify upstream with traffic auth only in headers", () => {
    const upstream = buildDesktopViewerUpstream({
      runtimeProvider: "e2b",
      runtimeSandboxId: "sbx_123",
      port: 6080,
      host: "6080-sbx_123.e2b.app",
      trafficAccessToken: "secret-token",
    });

    expect(upstream.url).toBe("https://6080-sbx_123.e2b.app/websockify");
    expect(upstream.headers.get("upgrade")).toBe("websocket");
    expect(upstream.headers.get("x-e2b-access-token")).toBe("secret-token");
  });

  it("rejects malformed desktop upstream hosts before proxy fetch", () => {
    expect(isValidDesktopViewerUpstreamHost("6080-sbx_123.e2b.app")).toBe(true);
    expect(isValidDesktopViewerUpstreamHost("localhost:6080")).toBe(true);
    expect(isValidDesktopViewerUpstreamHost("127.0.0.1:6080")).toBe(true);
    expect(isValidDesktopViewerUpstreamHost("https://6080-sbx_123.e2b.app")).toBe(false);
    expect(isValidDesktopViewerUpstreamHost("6080-sbx_123.e2b.app/path")).toBe(false);
    expect(isValidDesktopViewerUpstreamHost("6080-sbx_123.e2b.app@evil.test")).toBe(false);
    expect(isValidDesktopViewerUpstreamHost("169.254.169.254:80")).toBe(false);

    expect(() =>
      buildDesktopViewerUpstream({
        runtimeProvider: "e2b",
        runtimeSandboxId: "sbx_123",
        port: 6080,
        host: "6080-sbx_123.e2b.app/path",
        trafficAccessToken: "secret-token",
      }),
    ).toThrow("Invalid desktop viewer upstream host");
  });

  it("resolves only E2B desktop upstreams and rejects unsupported sandbox state", async () => {
    await expect(
      resolveDesktopViewerUpstream({
        env: {},
        sandboxState: { runtimeBackend: "freestyle", runtimeSandboxId: "vm-1" },
        resolveE2BPort: async () => {
          throw new Error("should not be called");
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      diagnostics: {
        phase: "sandbox_backend",
        reason: "unsupported_sandbox_backend",
        runtimeBackend: "freestyle",
      },
    });

    const supervisorStarts: Array<{ runtimeSandboxId: string; timeoutMs: number }> = [];
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async (runtimeSandboxId, timeoutMs) => {
        supervisorStarts.push({ runtimeSandboxId, timeoutMs });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      resolveE2BPort: async (runtimeSandboxId, port, timeoutMs) => ({
        runtimeProvider: "e2b",
        runtimeSandboxId,
        port,
        host: `${port}-${runtimeSandboxId}.e2b.app`,
        trafficAccessToken: `token-${timeoutMs}`,
      }),
    });
    expect(resolved).toMatchObject({
      ok: true,
      upstream: {
        url: "https://6080-sbx_123.e2b.app/websockify",
      },
      diagnostics: {
        phase: "ready",
        upstreamHostPresent: true,
        trafficAccessTokenPresent: true,
      },
    });
    expect(supervisorStarts).toEqual([{ runtimeSandboxId: "sbx_123", timeoutMs: 30_000 }]);
  });

  it("marks terminal sandbox and runtime states as non-retryable", async () => {
    const stopped = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: {
        status: "stopped",
        runtimeBackend: "e2b_cloud",
        runtimeState: "paused",
        runtimeSandboxId: "sbx_123",
      },
      startDesktopSupervisor: async () => {
        throw new Error("should not start desktop after sandbox stopped");
      },
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after sandbox stopped");
      },
    });

    expect(stopped).toMatchObject({
      ok: false,
      status: 409,
      error: "Desktop live view is unavailable because the sandbox is stopped",
      diagnostics: {
        phase: "sandbox_state",
        reason: "sandbox_stopped",
        retryable: false,
        sandboxStatus: "stopped",
        runtimeState: "paused",
      },
    });

    const killed = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: {
        status: "ready",
        runtimeBackend: "e2b_cloud",
        runtimeState: "killed",
        runtimeSandboxId: "sbx_123",
      },
    });

    expect(killed).toMatchObject({
      ok: false,
      status: 409,
      diagnostics: {
        reason: "runtime_killed",
        retryable: false,
      },
    });

    const paused = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: {
        status: "ready",
        runtimeBackend: "e2b_cloud",
        runtimeState: "paused",
        runtimeSandboxId: "sbx_123",
      },
    });

    expect(paused).toMatchObject({
      ok: false,
      status: 409,
      diagnostics: {
        reason: "runtime_paused",
        retryable: false,
      },
    });
  });

  it("reports unavailable when desktop supervisor startup fails", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after supervisor failure");
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop supervisor is unavailable",
      diagnostics: {
        phase: "supervisor_start",
        reason: "supervisor_start_exit_nonzero",
        supervisorExitCode: 127,
        supervisorStderr: "not found",
      },
    });
  });

  it("preserves supervisor health root cause when startup exits nonzero", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({
        exitCode: 2,
        stdout: JSON.stringify({
          status: "unavailable",
          display: ":99",
          size: { width: 1280, height: 720 },
          checks: { screenshot: true },
          ports: {
            vnc: { reachable: true },
            novnc: { reachable: true },
            loopbackOnly: false,
          },
          failedComponent: "ports",
          lastError: "non_loopback_binding",
        }),
        stderr: "desktop supervisor failed",
      }),
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after supervisor failure");
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop supervisor is unavailable",
      diagnostics: {
        phase: "supervisor_start",
        reason: "non_loopback_binding",
        retryable: false,
        supervisorExitCode: 2,
        supervisorHealthStatus: "unavailable",
        supervisorHealthFailedComponent: "ports",
        supervisorHealthLastError: "non_loopback_binding",
        supervisorHealthVncReachable: true,
        supervisorHealthNovncReachable: true,
        supervisorHealthLoopbackOnly: false,
      },
    });
  });

  it("reports unavailable when desktop supervisor startup errors", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => {
        throw new Error("e2b command failed");
      },
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after supervisor error");
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop supervisor is unavailable",
      diagnostics: {
        phase: "supervisor_start",
        reason: "supervisor_start_error",
      },
    });
  });

  it("reports unavailable when supervisor health is unavailable", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: "unavailable",
          display: ":99",
          size: { width: 0, height: 0 },
          checks: { screenshot: false },
          ports: {
            vnc: { reachable: false },
            novnc: { reachable: false },
            loopbackOnly: false,
          },
          failedComponent: "xvfb",
          failedPhase: "x_display",
          lastError: "x_display_unreachable",
        }),
        stderr: "",
      }),
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after supervisor health failure");
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop supervisor health is unavailable",
      diagnostics: {
        phase: "x_display",
        reason: "x_display_unreachable",
        supervisorHealthStatus: "unavailable",
        supervisorHealthFailedComponent: "xvfb",
        supervisorHealthFailedPhase: "x_display",
        supervisorHealthDisplay: ":99",
        supervisorHealthScreenshotOk: false,
      },
    });
  });

  it("preserves screenshot black/uniform supervisor health diagnostics", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: "unavailable",
          display: ":99",
          size: { width: 1440, height: 900 },
          checks: { screenshot: true },
          screenshot: { nonBlackPixelRatio: 0, entropy: 0, uniform: true },
          ports: {
            vnc: { reachable: true },
            novnc: { reachable: true },
            loopbackOnly: true,
          },
          failedComponent: "screenshot_black_or_uniform",
          failedPhase: "screenshot_black_or_uniform",
          lastError: "screenshot_black_or_uniform",
        }),
        stderr: "",
      }),
      resolveE2BPort: async () => {
        throw new Error("should not resolve noVNC port after supervisor health failure");
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      diagnostics: {
        phase: "screenshot_black_or_uniform",
        reason: "screenshot_black_or_uniform",
        supervisorHealthFailedComponent: "screenshot_black_or_uniform",
        supervisorHealthFailedPhase: "screenshot_black_or_uniform",
        supervisorHealthWidth: 1440,
        supervisorHealthHeight: 900,
        supervisorHealthScreenshotOk: true,
        supervisorHealthScreenshotNonBlackPixelRatio: 0,
        supervisorHealthScreenshotEntropy: 0,
        supervisorHealthScreenshotUniform: true,
      },
    });
  });

  it("reports unavailable when noVNC port resolution fails", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: "preparing",
          display: ":99",
          size: { width: 1280, height: 720 },
          checks: { screenshot: true },
          ports: {
            vnc: { reachable: true },
            novnc: { reachable: false },
            loopbackOnly: true,
          },
        }),
        stderr: "",
      }),
      resolveE2BPort: async () => {
        throw new E2BSandboxRuntimeError("E2B rate limited port resolution", {
          code: "rate_limit",
          status: 429,
          retryAfterMs: 2_000,
          requestSent: true,
        });
      },
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop noVNC port is unavailable",
      diagnostics: {
        phase: "provider_port_resolve",
        reason: "port_resolve_error",
        supervisorHealthStatus: "preparing",
        supervisorHealthDisplay: ":99",
        supervisorHealthWidth: 1280,
        supervisorHealthHeight: 720,
        providerErrorCode: "rate_limit",
        providerErrorStatus: 429,
        providerErrorRetryAfterMs: 2000,
        providerErrorRequestSent: true,
      },
    });
  });

  it("reports unavailable when noVNC port resolution returns an invalid host", async () => {
    const resolved = await resolveDesktopViewerUpstream({
      env: {},
      sandboxState: { runtimeBackend: "e2b_cloud", runtimeSandboxId: "sbx_123" },
      startDesktopSupervisor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: "ready",
          display: ":99",
          size: { width: 1280, height: 720 },
          checks: { screenshot: true },
          ports: {
            vnc: { reachable: true },
            novnc: { reachable: true },
            loopbackOnly: true,
          },
        }),
        stderr: "",
      }),
      resolveE2BPort: async (runtimeSandboxId, port) => ({
        runtimeProvider: "e2b",
        runtimeSandboxId,
        port,
        host: "https://6080-sbx_123.e2b.app/path",
        trafficAccessToken: "secret-token",
      }),
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 503,
      error: "Desktop noVNC port is unavailable",
      diagnostics: {
        phase: "provider_port_resolve",
        reason: "invalid_port_host",
        upstreamHostPresent: true,
        trafficAccessTokenPresent: true,
      },
    });
  });

  it("records upstream auth failures distinctly when the noVNC proxy returns 403", async () => {
    const clientSocket = {
      close: vi.fn(),
      addEventListener: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const onClose = vi.fn();
    const onHandshake = vi.fn();

    await proxyDesktopViewerWebSocket({
      upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
      clientSocket,
      fetchImpl: async () => new Response("Forbidden", { status: 403 }),
      onHandshake,
      onClose,
    });

    expect(clientSocket.close).toHaveBeenCalledWith(1011, "Desktop upstream rejected live view");
    expect(onHandshake).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        hasWebSocket: false,
        closeReason: "upstream_forbidden",
        errorType: null,
        errorMessage: null,
      }),
    );
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "upstream_forbidden", source: "proxy" }));
  });

  it("records safe diagnostics when the upstream WebSocket fetch throws before opening", async () => {
    const clientSocket = {
      close: vi.fn(),
      addEventListener: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const onClose = vi.fn();
    const onHandshake = vi.fn();

    await proxyDesktopViewerWebSocket({
      upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
      clientSocket,
      fetchImpl: async () => {
        throw new TypeError("Unsupported URL scheme wss://6080-sbx_123.e2b.app/websockify");
      },
      onHandshake,
      onClose,
    });

    expect(clientSocket.close).toHaveBeenCalledWith(1011, "Desktop proxy failed");
    expect(onHandshake).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: null,
        hasWebSocket: false,
        closeReason: "proxy_failed",
        errorType: "TypeError",
        errorMessage: "Unsupported URL scheme <redacted-url>",
      }),
    );
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "proxy_failed", source: "proxy" }));
  });

  it("detects RFB keyboard, pointer, drag, and clipboard input attempts", () => {
    expect(detectRfbInputAttempt(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 65]).buffer)).toBe("keyboard");
    expect(detectRfbInputAttempt(new Uint8Array([5, 1, 0, 10, 0, 20]).buffer)).toBe("pointer");
    expect(detectRfbInputAttempt(new Uint8Array([5, 1, 0, 20, 0, 40]).buffer)).toBe("pointer");
    expect(detectRfbInputAttempt(new Uint8Array([6, 0, 0, 0, 0, 0, 0, 4, 116, 101, 120, 116]).buffer)).toBe(
      "clipboard",
    );
    expect(detectRfbInputAttempt(new Uint8Array([250, 0, 1, 3]).buffer)).toBe("power_control");
    expect(detectRfbInputAttempt(new Uint8Array([251, 0, 5, 0]).buffer)).toBe("desktop_resize");
    expect(detectRfbInputAttempt(new Uint8Array([255, 0, 0, 1]).buffer)).toBe("keyboard");
    expect(detectRfbInputAttempt(new Uint8Array([3, 0, 0, 0]).buffer)).toBeNull();
    expect(detectRfbInputAttempt("RFB 003.008\n")).toBeNull();
  });

  it("allows fragmented read-only RFB handshake and viewer messages", () => {
    const guard = new RfbViewOnlyInputGuard();
    expect(guard.inspectClientMessage("RFB 003.008\n")).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([0, ...Array(19).fill(0)]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([2, 0, 0, 1, 0, 0, 0, 0]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([3, 1, 0, 0]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([0, 0, 0, 20, 0, 20]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([150, 1, 0, 0, 0, 0, 0, 20, 0, 20]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([248, 0, 0, 0, 0, 0, 0, 0, 3]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([97, 98, 99]))).toBeNull();
  });

  it("allows noVNC extended clipboard capability negotiation without allowing clipboard transfer", () => {
    const guard = new RfbViewOnlyInputGuard();
    expect(guard.inspectClientMessage("RFB 003.008\n")).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();

    const extendedClipboardCaps = bytes([6, 0, 0, 0, 255, 255, 255, 248, 31, 0, 0, 1, 0, 0, 0, 0]);
    expect(guard.inspectClientMessage(extendedClipboardCaps.slice(0, 10))).toBeNull();
    expect(guard.inspectClientMessage(extendedClipboardCaps.slice(10))).toBeNull();

    const extendedClipboardNotify = bytes([6, 0, 0, 0, 255, 255, 255, 252, 8, 0, 0, 1]);
    expect(guard.inspectClientMessage(extendedClipboardNotify)).toBe("clipboard");
  });

  it("blocks malformed extended clipboard capability messages with extra payload", () => {
    const guard = new RfbViewOnlyInputGuard();
    expect(guard.inspectClientMessage("RFB 003.008\n")).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([1]))).toBeNull();

    const malformedExtendedClipboardCaps = bytes([6, 0, 0, 0, 255, 255, 255, 244, 31, 0, 0, 1]);
    expect(guard.inspectClientMessage(malformedExtendedClipboardCaps)).toBe("protocol_violation");
  });

  it("blocks RFB input attempts even when they are coalesced after allowed viewer messages", () => {
    const guard = new RfbViewOnlyInputGuard();
    expect(guard.inspectClientMessage("RFB 003.008\n")).toBeNull();
    expect(guard.inspectClientMessage(bytes([1, 1, 3, 0, 0, 0, 0, 0, 0, 20, 0, 20, 5, 1, 0, 10, 0, 10]))).toBe(
      "pointer",
    );
  });

  it("blocks RFB input attempts as soon as a fragmented mutating message starts", () => {
    const guard = new RfbViewOnlyInputGuard();
    expect(guard.inspectClientMessage("RFB 003.008\n")).toBeNull();
    expect(guard.inspectClientMessage(bytes([1, 1]))).toBeNull();
    expect(guard.inspectClientMessage(bytes([4]))).toBe("keyboard");
  });

  it("closes the viewer proxy without forwarding a blocked RFB input frame upstream", async () => {
    const clientSocket = new FakeWebSocket();
    const upstreamSocket = new FakeWebSocket();
    const onInputAttempt = vi.fn();
    const onClose = vi.fn();
    let resolveHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => {
      resolveHandshake = resolve;
    });

    const proxyTask = proxyDesktopViewerWebSocket({
      upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
      clientSocket: clientSocket as unknown as WebSocket,
      fetchImpl: async () =>
        Object.assign(new Response(null, { status: 200 }), { webSocket: upstreamSocket as unknown as WebSocket }),
      onInputAttempt,
      onHandshake: () => resolveHandshake(),
      onClose,
    });

    await handshake;
    for (let i = 0; i < 5 && clientSocket.listenerCount("message") === 0; i += 1) {
      await Promise.resolve();
    }
    expect(clientSocket.listenerCount("message")).toBeGreaterThan(0);

    clientSocket.emit("message", { data: "RFB 003.008\n" });
    expect(upstreamSocket.sent).toEqual(["RFB 003.008\n"]);

    const coalescedInput = bytes([1, 1, 3, 0, 0, 0, 0, 0, 0, 20, 0, 20, 5, 1, 0, 10, 0, 10]);
    clientSocket.emit("message", { data: coalescedInput });

    await proxyTask;

    expect(onInputAttempt).toHaveBeenCalledWith("pointer");
    expect(upstreamSocket.sent).toEqual(["RFB 003.008\n"]);
    expect(clientSocket.close).toHaveBeenCalledWith(1008, "Desktop viewer input is disabled");
    expect(upstreamSocket.close).toHaveBeenCalledWith(1008, "Desktop viewer input is disabled");
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "input_blocked", source: "proxy" }));
  });

  it("notifies close once when the close callback throws", async () => {
    const clientSocket = new FakeWebSocket();
    const upstreamSocket = new FakeWebSocket();
    const onClose = vi.fn(async () => {
      throw new Error("close notification failed");
    });
    let resolveHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => {
      resolveHandshake = resolve;
    });

    const proxyTask = proxyDesktopViewerWebSocket({
      upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
      clientSocket: clientSocket as unknown as WebSocket,
      fetchImpl: async () =>
        Object.assign(new Response(null, { status: 200 }), { webSocket: upstreamSocket as unknown as WebSocket }),
      onHandshake: () => resolveHandshake(),
      onClose,
    });

    await handshake;
    for (let i = 0; i < 5 && clientSocket.listenerCount("close") === 0; i += 1) {
      await Promise.resolve();
    }
    expect(clientSocket.listenerCount("close")).toBeGreaterThan(0);

    clientSocket.emit("close", {});

    await proxyTask;
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "client_closed", source: "client" }));
    expect(onClose).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "proxy_failed" }));
  });

  it("closes the viewer proxy when the ticket hard-expiry lease elapses", async () => {
    vi.useFakeTimers();
    try {
      const clientSocket = new FakeWebSocket();
      const upstreamSocket = new FakeWebSocket();
      const onClose = vi.fn();
      let resolveHandshake!: () => void;
      const handshake = new Promise<void>((resolve) => {
        resolveHandshake = resolve;
      });

      const proxyTask = proxyDesktopViewerWebSocket({
        upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
        clientSocket: clientSocket as unknown as WebSocket,
        maxConnectionDurationMs: 25,
        fetchImpl: async () =>
          Object.assign(new Response(null, { status: 200 }), { webSocket: upstreamSocket as unknown as WebSocket }),
        onHandshake: () => resolveHandshake(),
        onClose,
      });

      await handshake;
      await vi.advanceTimersByTimeAsync(25);
      await proxyTask;

      expect(clientSocket.close).toHaveBeenCalledWith(1008, "Desktop viewer ticket expired");
      expect(upstreamSocket.close).toHaveBeenCalledWith(1008, "Desktop viewer ticket expired");
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "ticket_expired", source: "proxy" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an active desktop stream open when handshake telemetry fails", async () => {
    const clientSocket = new FakeWebSocket();
    const upstreamSocket = new FakeWebSocket();
    let resolveHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => {
      resolveHandshake = resolve;
    });
    const onHandshake = vi.fn(async () => {
      resolveHandshake();
      throw new Error("Datadog unavailable");
    });
    const onClose = vi.fn();
    const proxyTask = proxyDesktopViewerWebSocket({
      upstream: { url: "wss://6080-sbx_123.e2b.app/websockify", headers: new Headers() },
      clientSocket: clientSocket as unknown as WebSocket,
      fetchImpl: async () =>
        Object.assign(new Response(null, { status: 200 }), { webSocket: upstreamSocket as unknown as WebSocket }),
      onHandshake,
      onClose,
    });

    await handshake;
    expect(onHandshake).toHaveBeenCalledWith(expect.objectContaining({ hasWebSocket: true }));
    expect(clientSocket.close).not.toHaveBeenCalled();

    for (let i = 0; i < 5 && clientSocket.listenerCount("close") === 0; i += 1) {
      await Promise.resolve();
    }
    clientSocket.emit("close", {});
    await proxyTask;
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "client_closed", source: "client" }));
  });
});
