import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxMock = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
}));

import { runE2BCompatSmoke } from "../../apps/control-plane-worker/src/sandbox/e2b-compat";

function createSandboxDouble(
  overrides: Partial<{
    sandboxId: string;
    run: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    sandboxId: overrides.sandboxId ?? "sbx_123",
    commands: {
      run:
        overrides.run ??
        vi.fn().mockResolvedValue({
          stdout: "cycloid-e2b-ok\n",
          stderr: "",
          exitCode: 0,
        }),
    },
    pause: overrides.pause ?? vi.fn().mockResolvedValue(true),
    kill: overrides.kill ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("runE2BCompatSmoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an E2B sandbox with pause-on-timeout and auto-resume disabled", async () => {
    const sandbox = createSandboxDouble();
    sandboxMock.create.mockResolvedValue(sandbox);

    const result = await runE2BCompatSmoke({
      apiKey: "test-key",
      template: "cycloid-sandbox-dev-test",
      timeoutMs: 60_000,
      cleanup: "pause",
    });

    expect(sandboxMock.create).toHaveBeenCalledWith("cycloid-sandbox-dev-test", {
      apiKey: "test-key",
      timeoutMs: 60_000,
      lifecycle: {
        onTimeout: "pause",
        autoResume: false,
      },
    });
    expect(sandbox.commands.run).toHaveBeenCalledWith("echo cycloid-e2b-ok", {
      timeoutMs: 30_000,
    });
    expect(sandbox.pause).toHaveBeenCalledOnce();
    expect(sandbox.kill).not.toHaveBeenCalled();
    expect(result).toEqual({
      sandboxId: "sbx_123",
      commandStdout: "cycloid-e2b-ok\n",
      commandExitCode: 0,
      finalState: "paused",
    });
  });

  it("kills the sandbox when cleanup is kill", async () => {
    const sandbox = createSandboxDouble();
    sandboxMock.create.mockResolvedValue(sandbox);

    await runE2BCompatSmoke({
      apiKey: "test-key",
      template: "cycloid-sandbox-dev-test",
      timeoutMs: 60_000,
      cleanup: "kill",
    });

    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(sandbox.pause).not.toHaveBeenCalled();
  });

  it("passes a custom E2B domain when provided", async () => {
    const sandbox = createSandboxDouble();
    sandboxMock.create.mockResolvedValue(sandbox);

    await runE2BCompatSmoke({
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      template: "cycloid-sandbox-selfhost",
      timeoutMs: 60_000,
      cleanup: "kill",
    });

    expect(sandboxMock.create).toHaveBeenCalledWith("cycloid-sandbox-selfhost", {
      apiKey: "test-key",
      domain: "self-hosted.example.com",
      timeoutMs: 60_000,
      lifecycle: {
        onTimeout: "pause",
        autoResume: false,
      },
    });
  });

  it("cleans up when command execution fails", async () => {
    const sandbox = createSandboxDouble({
      run: vi.fn().mockRejectedValue(new Error("command failed")),
    });
    sandboxMock.create.mockResolvedValue(sandbox);

    await expect(
      runE2BCompatSmoke({
        apiKey: "test-key",
        template: "cycloid-sandbox-dev-test",
        timeoutMs: 60_000,
        cleanup: "pause",
      }),
    ).rejects.toThrow("command failed");

    expect(sandbox.pause).toHaveBeenCalledOnce();
  });

  it("rejects missing API key before creating a sandbox", async () => {
    await expect(
      runE2BCompatSmoke({
        apiKey: "",
        template: "cycloid-sandbox-dev-test",
        timeoutMs: 60_000,
        cleanup: "kill",
      }),
    ).rejects.toThrow("E2B_API_KEY is required");

    expect(sandboxMock.create).not.toHaveBeenCalled();
  });
});
