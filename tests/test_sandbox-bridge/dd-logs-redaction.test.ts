// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bridge dd log redaction", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
    process.env.SESSION_ID = "sess-abc";
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
    process.env.ARCANIST_RUNTIME_ENVIRONMENT = "test";
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    vi.restoreAllMocks();
  });

  it("redacts sentinel URL credentials from Datadog payloads", async () => {
    const { ddLog, initDdLogs, shutdownDdLogs } = await import("../../apps/sandbox-bridge/src/services/dd-logs.js");
    const secretUrl = "postgres://sentinel-user:sentinel-pass@db.example:5432/app";

    initDdLogs();
    ddLog({
      level: "warn",
      ts: 1,
      msg: "command output",
      database_url: secretUrl,
      output: `DATABASE_URL=${secretUrl}\nremote=https://sentinel-user:sentinel-pass@example.com/repo.git`,
    });
    await shutdownDdLogs();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(url).toMatch(/\/sandbox\/telemetry\/dd-logs$/);
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer sbx-token-1");
    expect((request.headers as Record<string, string>)["DD-API-KEY"]).toBeUndefined();
    const payload = gunzipSync(Buffer.from(request.body as Uint8Array)).toString("utf8");
    expect(payload).not.toContain("sentinel-pass");
    expect(payload).not.toContain(secretUrl);
    expect(payload).toContain("[REDACTED]");
  });

  it("sends each flush with the CURRENT SANDBOX_AUTH_TOKEN after a mid-session rotation", async () => {
    // The control plane rotates SANDBOX_AUTH_TOKEN on every sandbox WS handshake
    // and updates process.env. A token cached at init would 403 every 5s flush
    // after a reconnect and trip the sandbox-auth-failure lockout; the shipper
    // must read the live token per flush.
    const { ddLog, initDdLogs, flushDdLogs, shutdownDdLogs } =
      await import("../../apps/sandbox-bridge/src/services/dd-logs.js");

    initDdLogs();
    ddLog({ level: "info", ts: 1, msg: "before rotation" });
    await flushDdLogs();

    // Simulate the rotation the bridge applies on a WS handshake.
    process.env.SANDBOX_AUTH_TOKEN = "sbx-token-2";
    ddLog({ level: "info", ts: 2, msg: "after rotation" });
    await flushDdLogs();
    await shutdownDdLogs();

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const auths = calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>).map((h) => h.Authorization);
    expect(auths[0]).toBe("Bearer sbx-token-1");
    expect(auths.at(-1)).toBe("Bearer sbx-token-2");
  });

  it("keeps dispatch summary span offsets readable in Datadog payloads", async () => {
    const { ddLog, initDdLogs, shutdownDdLogs } = await import("../../apps/sandbox-bridge/src/services/dd-logs.js");

    initDdLogs();
    ddLog({
      level: "info",
      ts: 1,
      msg: "dispatch summary",
      event: "prompt.dispatch_subspans_completed",
      spans: {
        backend_first_token: { offset_ms: 4800, signal: "session.status" },
        prompt_sent_to_backend: { offset_ms: 40, duration_ms: 35 },
      },
    });
    await shutdownDdLogs();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    const payload = gunzipSync(Buffer.from(request.body as Uint8Array)).toString("utf8");

    expect(payload).toContain('"backend_first_token":{"offset_ms":4800,"signal":"session.status"}');
    expect(payload).not.toContain('"backend_first_token":"[REDACTED]"');
  });
});
