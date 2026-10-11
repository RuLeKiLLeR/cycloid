import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxMock = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  setTimeout: vi.fn(),
  pause: vi.fn(),
  kill: vi.fn(),
  getInfo: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
}));

import { E2BSandboxClient, E2BSandboxRuntimeError } from "../../apps/control-plane-worker/src/sandbox/e2b-client";
import { FreestyleSandboxClient } from "../../apps/control-plane-worker/src/sandbox/freestyle-client";
import { createSandboxProviderClient } from "../../apps/control-plane-worker/src/sandbox/provider-client";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function createSandboxDouble(
  overrides: Partial<{
    sandboxId: string;
    setTimeout: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    sandboxId: overrides.sandboxId ?? "e2b-sbx-1",
    setTimeout: overrides.setTimeout ?? vi.fn().mockResolvedValue(undefined),
    commands: {
      run: overrides.run ?? vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    },
  };
}

describe("E2BSandboxClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a sandbox from template with pause-on-timeout and disabled auto-resume", async () => {
    const sandbox = createSandboxDouble({ sandboxId: "e2b-sbx-123" });
    sandboxMock.create.mockResolvedValue(sandbox);
    const logger = createLogger();
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    const result = await client.createSandbox({
      sessionId: "sess-1",
      sandboxId: "sandbox-1",
      template: "cycloid-sandbox-dev-test",
      timeoutMs: 60_000,
      envs: { SESSION_ID: "sess-1" },
      metadata: { source: "test" },
    });

    expect(sandboxMock.create).toHaveBeenCalledWith("cycloid-sandbox-dev-test", {
      apiKey: "test-key",
      timeoutMs: 60_000,
      lifecycle: {
        onTimeout: "pause",
        autoResume: false,
      },
      envs: { SESSION_ID: "sess-1" },
      metadata: {
        source: "test",
        session_id: "sess-1",
        sandbox_id: "sandbox-1",
        runtime_provider: "e2b",
        template: "cycloid-sandbox-dev-test",
      },
    });
    expect(result).toMatchObject({
      runtimeProvider: "e2b",
      runtimeSandboxId: "e2b-sbx-123",
      runtimeTemplateId: "cycloid-sandbox-dev-test",
      status: "running",
    });
    // Spawn-latency instrumentation: create duration is measured and surfaced.
    expect(typeof result.createDurationMs).toBe("number");
    expect(result.createDurationMs).toBeGreaterThanOrEqual(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: "createSandbox", runtimeSandboxId: "e2b-sbx-123", outcome: "success" }),
      "E2B sandbox runtime operation completed",
    );
  });

  it("passes configured network policy to sandbox creation", async () => {
    const sandbox = createSandboxDouble({ sandboxId: "e2b-sbx-123" });
    sandboxMock.create.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    await client.createSandbox({
      sandboxId: "sandbox-1",
      template: "cycloid-sandbox-dev-test",
      timeoutMs: 60_000,
      envs: {},
      metadata: {},
      allowInternetAccess: false,
      network: {
        allowPublicTraffic: false,
        allowOut: ["1.1.1.1"],
        denyOut: ["0.0.0.0/0"],
      },
    });

    expect(sandboxMock.create).toHaveBeenCalledWith(
      "cycloid-sandbox-dev-test",
      expect.objectContaining({
        allowInternetAccess: false,
        network: {
          allowPublicTraffic: false,
          allowOut: ["1.1.1.1"],
          denyOut: ["0.0.0.0/0"],
        },
      }),
    );
  });

  it("passes configured self-hosted domain to E2B SDK operations", async () => {
    const sandbox = createSandboxDouble({ sandboxId: "e2b-sbx-123" });
    sandboxMock.create.mockResolvedValue(sandbox);
    sandboxMock.connect.mockResolvedValue(sandbox);
    sandboxMock.setTimeout.mockResolvedValue(undefined);
    sandboxMock.pause.mockResolvedValue(true);
    sandboxMock.kill.mockResolvedValue(true);
    const client = new E2BSandboxClient({
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      logger: createLogger(),
    });

    await client.createSandbox({
      sandboxId: "sandbox-1",
      template: "cycloid-sandbox-dev-test",
      timeoutMs: 60_000,
      envs: {},
      metadata: {},
    });
    await client.connectSandbox("e2b-sbx-123", 120_000);
    await client.refreshSandbox("e2b-sbx-123", 60_000);
    await client.pauseSandbox("e2b-sbx-123");
    await client.terminateSandbox("e2b-sbx-123", "runtime_cleanup");

    expect(sandboxMock.create).toHaveBeenCalledWith(
      "cycloid-sandbox-dev-test",
      expect.objectContaining({ apiKey: "test-key", domain: "self-hosted.example.com" }),
    );
    expect(sandboxMock.connect).toHaveBeenCalledWith("e2b-sbx-123", {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      timeoutMs: 120_000,
    });
    expect(sandboxMock.setTimeout).toHaveBeenCalledWith("e2b-sbx-123", 60_000, {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
    });
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-sbx-123", {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
    });
    expect(sandboxMock.kill).toHaveBeenCalledWith("e2b-sbx-123", {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
    });
  });

  it("connects and resets timeout", async () => {
    const sandbox = createSandboxDouble();
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    const connected = await client.connectSandbox("e2b-sbx-1", 120_000);

    expect(sandboxMock.connect).toHaveBeenCalledWith("e2b-sbx-1", {
      apiKey: "test-key",
      timeoutMs: 120_000,
    });
    expect(sandbox.setTimeout).toHaveBeenCalledWith(120_000);
    expect(connected.runtimeSandboxId).toBe("e2b-sbx-1");
  });

  it("refreshes provider TTL using milliseconds while enforcing the documented 3600 second cap", async () => {
    sandboxMock.setTimeout.mockResolvedValue(undefined);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    const result = await client.refreshSandbox("e2b-sbx-1", 60_001);

    expect(sandboxMock.setTimeout).toHaveBeenCalledWith("e2b-sbx-1", 61_000, {
      apiKey: "test-key",
    });
    expect(result.status).toBe("refreshed");
    await expect(client.refreshSandbox("e2b-sbx-1", 3_600_001)).rejects.toMatchObject({
      code: "missing_config",
      requestSent: false,
    });
  });

  it("runs a foreground command with envs", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 7, stdout: "out", stderr: "err" });
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    await expect(
      client.runCommand({
        runtimeSandboxId: "e2b-sbx-1",
        command: "npm test",
        cwd: "/workspace/repo",
        envs: { CI: "1" },
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "err" });

    expect(run).toHaveBeenCalledWith("npm test", {
      cwd: "/workspace/repo",
      envs: { CI: "1" },
      timeoutMs: 30_000,
    });
  });

  it("normalizes thrown foreground command exits into command results", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("exit status 17"), {
        exitCode: 17,
        stdout: "command output",
        stderr: "command error",
      }),
    );
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const logger = createLogger();
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    await expect(
      client.runCommand({
        runtimeSandboxId: "e2b-sbx-1",
        command: "npm test",
      }),
    ).resolves.toEqual({ exitCode: 17, stdout: "command output", stderr: "command error" });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: "runCommand", runtimeSandboxId: "e2b-sbx-1", outcome: "success" }),
      "E2B sandbox runtime operation completed",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("normalizes nested thrown foreground command result records within the depth cap", async () => {
    const run = vi.fn().mockRejectedValue({
      result: {
        commandResult: {
          exitCode: 42,
          stdout: "nested output",
          stderr: "nested error",
        },
      },
    });
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    await expect(
      client.runCommand({
        runtimeSandboxId: "e2b-sbx-1",
        command: "npm test",
      }),
    ).resolves.toEqual({ exitCode: 42, stdout: "nested output", stderr: "nested error" });
  });

  it("rethrows thrown command errors when no command result is found within the depth cap", async () => {
    const logger = createLogger();
    const sandbox = createSandboxDouble({
      run: vi
        .fn()
        .mockRejectedValueOnce({
          result: {
            details: {
              commandResult: {
                exitCode: 42,
                stdout: "too deep",
                stderr: "too deep",
              },
            },
          },
        })
        .mockRejectedValueOnce({ result: { commandResult: { stdout: "missing exit code", stderr: "err" } } }),
    });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    await expect(client.runCommand({ runtimeSandboxId: "e2b-sbx-1", command: "npm test" })).rejects.toMatchObject({
      code: "unknown",
      requestSent: true,
    });
    await expect(client.runCommand({ runtimeSandboxId: "e2b-sbx-1", command: "npm test" })).rejects.toMatchObject({
      code: "unknown",
      requestSent: true,
    });
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: "runCommand", outcome: "error", errorCode: "unknown" }),
      "E2B sandbox runtime operation failed",
    );
  });

  it("normalizes thrown foreground command exit status messages without output", async () => {
    const run = vi.fn().mockRejectedValue(new Error("exit status 1"));
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    await expect(
      client.runCommand({
        runtimeSandboxId: "e2b-sbx-1",
        command: "false",
      }),
    ).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "" });
  });

  it("starts a background command with E2B's no-timeout sentinel", async () => {
    const run = vi.fn().mockResolvedValue({ pid: 4242 });
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    const result = await client.startCommand({
      runtimeSandboxId: "e2b-sbx-1",
      command: "/app/start-bridge.sh",
      envs: { SESSION_ID: "sess-1" },
    });

    expect(run).toHaveBeenCalledWith("/app/start-bridge.sh", {
      envs: { SESSION_ID: "sess-1" },
      timeoutMs: 0,
      background: true,
    });
    expect(result).toMatchObject({ pid: 4242 });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("commandId");
  });

  it.each([
    ["network", new TypeError("fetch failed"), undefined],
    ["auth", Object.assign(new Error("unauthorized"), { status: 401 }), 401],
    ["rate_limit", Object.assign(new Error("rate limit"), { status: 429 }), 429],
    ["missing_sandbox", Object.assign(new Error("sandbox not found"), { status: 404 }), 404],
    ["timeout", Object.assign(new Error("request timed out"), { status: 504 }), 504],
  ] as const)("classifies startCommand %s failures from commands.run", async (code, error, status) => {
    const run = vi.fn().mockRejectedValue(error);
    const sandbox = createSandboxDouble({ run });
    sandboxMock.connect.mockResolvedValue(sandbox);
    const logger = createLogger();
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    await expect(
      client.startCommand({
        runtimeSandboxId: "e2b-sbx-1",
        command: "/app/start-bridge.sh",
        envs: { SESSION_ID: "sess-1" },
      }),
    ).rejects.toMatchObject({
      code,
      ...(status === undefined ? {} : { status }),
      requestSent: true,
    });
    expect(run).toHaveBeenCalledWith("/app/start-bridge.sh", {
      envs: { SESSION_ID: "sess-1" },
      timeoutMs: 0,
      background: true,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "startCommand",
        runtimeSandboxId: "e2b-sbx-1",
        outcome: "error",
        errorCode: code,
        requestSent: true,
      }),
      "E2B sandbox runtime operation failed",
    );
  });

  it("pauses and terminates sandboxes, logging the terminate reason", async () => {
    sandboxMock.pause.mockResolvedValue(false);
    sandboxMock.kill.mockResolvedValue(true);
    const logger = createLogger();
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    await expect(client.pauseSandbox("e2b-sbx-1")).resolves.toEqual({ status: "paused" });
    await expect(client.terminateSandbox("e2b-sbx-1", "runtime_cleanup")).resolves.toEqual({ status: "killed" });

    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-sbx-1", { apiKey: "test-key" });
    expect(sandboxMock.kill).toHaveBeenCalledWith("e2b-sbx-1", { apiKey: "test-key" });
    // The reason is the only record of which control-plane path requested the
    // kill — E2B itself only logs a flat `kill_reason: 'request'`.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: "terminateSandbox", reason: "runtime_cleanup", outcome: "success" }),
      expect.any(String),
    );
  });

  it("treats missing sandbox kill as a missing result", async () => {
    sandboxMock.kill.mockResolvedValue(false);
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    await expect(client.terminateSandbox("e2b-sbx-missing", "runtime_cleanup")).resolves.toEqual({ status: "missing" });

    sandboxMock.kill.mockRejectedValueOnce(Object.assign(new Error("sandbox not found"), { status: 404 }));
    await expect(client.terminateSandbox("e2b-sbx-missing", "runtime_cleanup")).resolves.toEqual({ status: "missing" });
  });

  it("classifies common provider errors", async () => {
    const logger = createLogger();
    const client = new E2BSandboxClient({ apiKey: "test-key", logger });

    sandboxMock.connect.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(client.runCommand({ runtimeSandboxId: "e2b-sbx-1", command: "true" })).rejects.toMatchObject({
      code: "auth",
      status: 401,
      requestSent: true,
    });

    sandboxMock.create.mockRejectedValueOnce(Object.assign(new Error("template not found"), { status: 404 }));
    await expect(
      client.createSandbox({
        sessionId: "sess-1",
        sandboxId: "sandbox-1",
        template: "missing-template",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_template",
      status: 404,
      message: expect.stringContaining("missing-template"),
    });

    sandboxMock.setTimeout.mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }));
    await expect(client.refreshSandbox("e2b-sbx-1", 60_000)).rejects.toMatchObject({
      code: "rate_limit",
      status: 429,
    });

    sandboxMock.connect.mockRejectedValueOnce(Object.assign(new Error("sandbox not found"), { status: 404 }));
    await expect(client.runCommand({ runtimeSandboxId: "missing", command: "true" })).rejects.toMatchObject({
      code: "missing_sandbox",
      status: 404,
    });

    sandboxMock.connect.mockRejectedValueOnce(Object.assign(new Error("not enough credits"), { status: 402 }));
    await expect(client.runCommand({ runtimeSandboxId: "e2b-sbx-1", command: "true" })).rejects.toMatchObject({
      code: "quota",
      status: 402,
    });

    sandboxMock.connect.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.runCommand({ runtimeSandboxId: "e2b-sbx-1", command: "true" })).rejects.toMatchObject({
      code: "network",
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: "runCommand", outcome: "error", errorCode: "auth" }),
      "E2B sandbox runtime operation failed",
    );
  });

  it("probes liveness via static getInfo without auto-resuming, mapping state", async () => {
    sandboxMock.getInfo.mockResolvedValue({ sandboxId: "e2b-sbx-1", state: "running" });
    const client = new E2BSandboxClient({
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      logger: createLogger(),
    });

    await expect(client.getSandboxInfo("e2b-sbx-1", { requestTimeoutMs: 5_000 })).resolves.toEqual({
      status: "running",
    });
    // Uses getInfo (metadata read), never connect (which auto-resumes paused VMs).
    expect(sandboxMock.getInfo).toHaveBeenCalledWith("e2b-sbx-1", {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      requestTimeoutMs: 5_000,
    });
    expect(sandboxMock.connect).not.toHaveBeenCalled();

    sandboxMock.getInfo.mockResolvedValue({ sandboxId: "e2b-sbx-1", state: "paused" });
    await expect(client.getSandboxInfo("e2b-sbx-1")).resolves.toEqual({ status: "paused" });
  });

  it("classifies a missing sandbox getInfo as missing, and errors/timeouts as unknown", async () => {
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    sandboxMock.getInfo.mockRejectedValueOnce(Object.assign(new Error("sandbox not found"), { status: 404 }));
    await expect(client.getSandboxInfo("missing")).resolves.toEqual({ status: "missing" });

    sandboxMock.getInfo.mockRejectedValueOnce(Object.assign(new Error("request timed out"), { status: 504 }));
    await expect(client.getSandboxInfo("e2b-sbx-1")).resolves.toEqual({ status: "unknown", errorCode: "timeout" });

    sandboxMock.getInfo.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.getSandboxInfo("e2b-sbx-1")).resolves.toEqual({ status: "unknown", errorCode: "network" });
  });

  it("preserves the raw SDK state when getInfo returns a non-running/paused state (diagnosis)", async () => {
    // Classification-miss branch: getInfo resolves with an info object whose state
    // is neither running nor paused. getSandboxInfo classifies `unknown` but must
    // surface the raw state so the sandbox-loss diagnosis can read what E2B actually
    // reported instead of losing it above the probe layer.
    const client = new E2BSandboxClient({ apiKey: "test-key", logger: createLogger() });

    sandboxMock.getInfo.mockResolvedValueOnce({ sandboxId: "e2b-sbx-1", state: "terminated" });
    await expect(client.getSandboxInfo("e2b-sbx-1")).resolves.toEqual({
      status: "unknown",
      errorCode: "unknown",
      rawState: "terminated",
    });
  });

  it("rejects missing config before sending provider requests", async () => {
    const client = new E2BSandboxClient({ logger: createLogger() });

    await expect(client.terminateSandbox("e2b-sbx-1", "runtime_cleanup")).rejects.toBeInstanceOf(
      E2BSandboxRuntimeError,
    );
    await expect(client.terminateSandbox("e2b-sbx-1", "runtime_cleanup")).rejects.toMatchObject({
      code: "missing_config",
      requestSent: false,
    });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });
});

describe("createSandboxProviderClient", () => {
  it("returns an E2BSandboxClient for the e2b_cloud backend", () => {
    const client = createSandboxProviderClient(E2B_CLOUD_RUNTIME_BACKEND, { apiKey: "test-key" });
    expect(client).toBeInstanceOf(E2BSandboxClient);
  });

  it("returns a FreestyleSandboxClient for the freestyle backend", () => {
    const client = createSandboxProviderClient(FREESTYLE_RUNTIME_BACKEND, { apiKey: "test-key" });
    expect(client).toBeInstanceOf(FreestyleSandboxClient);
  });
});
