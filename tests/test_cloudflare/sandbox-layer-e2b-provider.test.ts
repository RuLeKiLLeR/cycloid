import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  compileSandboxLayerBuildCommands,
  compileSandboxLayerEnvInstruction,
  compileSandboxLayerSmokeCommand,
} from "../../apps/control-plane-worker/src/sandbox/layer-compiler";
import { getE2BSandboxLayerProviderAdapter } from "../../apps/control-plane-worker/src/sandbox/layer-e2b-provider";

const e2bMock = vi.hoisted(() => {
  const builder = {
    fromTemplate: vi.fn(),
    runCmd: vi.fn(),
  };
  builder.fromTemplate.mockReturnValue(builder);
  builder.runCmd.mockReturnValue(builder);
  return {
    moduleLoads: 0,
    builder,
    templateFactory: vi.fn(() => builder),
    buildInBackground: vi.fn(async () => ({ templateId: "layer-template", buildId: "provider-build" })),
    getBuildStatus: vi.fn(),
  };
});

vi.mock("e2b", () => {
  e2bMock.moduleLoads += 1;
  return {
    Template: Object.assign(e2bMock.templateFactory, {
      buildInBackground: e2bMock.buildInBackground,
      getBuildStatus: e2bMock.getBuildStatus,
    }),
  };
});

describe("sandbox layer E2B provider adapter", () => {
  beforeEach(() => {
    e2bMock.moduleLoads = 0;
    e2bMock.builder.fromTemplate.mockClear();
    e2bMock.builder.runCmd.mockClear();
    e2bMock.templateFactory.mockClear();
    e2bMock.buildInBackground.mockClear();
    e2bMock.getBuildStatus.mockClear();
  });

  it("loads the E2B SDK lazily when provider operations need it", async () => {
    const adapter = getE2BSandboxLayerProviderAdapter();

    expect(e2bMock.moduleLoads).toBe(0);
    expect(adapter).toMatchObject({
      startBuild: expect.any(Function),
      getBuildStatus: expect.any(Function),
      createSmokeSandbox: expect.any(Function),
      runSmokeCommand: expect.any(Function),
      terminateSmokeSandbox: expect.any(Function),
    });

    await adapter.startBuild({
      env: { E2B_API_KEY: "test-key" } as never,
      baseTemplateRef: "base-template",
      generatedName: "generated-template",
      instructions: [{ kind: "run", command: "apt-get update", startLine: 1, endLine: 1 }],
      cpuCount: 2,
      memoryMB: 4096,
      provenance: { source: "test" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    expect(e2bMock.moduleLoads).toBe(1);
    expect(e2bMock.templateFactory).toHaveBeenCalledOnce();
    expect(e2bMock.builder.fromTemplate).toHaveBeenCalledWith("base-template");
    expect(e2bMock.builder.runCmd).toHaveBeenCalledWith("apt-get update", { user: "root" });
    expect(e2bMock.buildInBackground).toHaveBeenCalledWith(e2bMock.builder, "generated-template", {
      apiKey: "test-key",
      cpuCount: 2,
      memoryMB: 4096,
      skipCache: false,
    });
  });

  it("forwards skipCache to buildInBackground when a base-change rebuild requests it", async () => {
    const adapter = getE2BSandboxLayerProviderAdapter();

    await adapter.startBuild({
      env: { E2B_API_KEY: "test-key" } as never,
      baseTemplateRef: "base-template",
      generatedName: "generated-template",
      instructions: [{ kind: "run", command: "apt-get update", startLine: 1, endLine: 1 }],
      cpuCount: 2,
      memoryMB: 4096,
      provenance: { source: "test" },
      skipCache: true,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    expect(e2bMock.buildInBackground).toHaveBeenCalledWith(e2bMock.builder, "generated-template", {
      apiKey: "test-key",
      cpuCount: 2,
      memoryMB: 4096,
      skipCache: true,
    });
  });

  it("constructs the default E2B sandbox layer provider adapter without loading the SDK", () => {
    expect(getE2BSandboxLayerProviderAdapter()).toMatchObject({
      startBuild: expect.any(Function),
      getBuildStatus: expect.any(Function),
      createSmokeSandbox: expect.any(Function),
      runSmokeCommand: expect.any(Function),
      terminateSmokeSandbox: expect.any(Function),
    });
  });

  it("generates the runtime layer env files instead of relying on build-time envs", () => {
    const command = compileSandboxLayerEnvInstruction({ NODE_OPTIONS: "--max-old-space-size=4096", FOO: "a'b" });

    expect(command).toContain("cat > /etc/cycloid/layer-env.sh <<'EOF'");
    expect(command).toContain("cat > /etc/profile.d/cycloid-layer-env.sh <<'EOF'");
    expect(command).toContain("export FOO='a'\\''b'");
    expect(command).toContain("export NODE_OPTIONS='--max-old-space-size=4096'");
    expect(command).toContain(". /etc/cycloid/layer-env.sh");
    expect(command).not.toContain("setEnvs");
  });

  it("accumulates multiple ENV instructions into the generated runtime env file", () => {
    const commands = compileSandboxLayerBuildCommands([
      { kind: "env", values: { FOO: "one" }, startLine: 1, endLine: 1 },
      { kind: "env", values: { BAR: "two" }, startLine: 2, endLine: 2 },
    ]);

    expect(commands[1]).toContain("export FOO='one'");
    expect(commands[2]).toContain("export FOO='one'");
    expect(commands[2]).toContain("export BAR='two'");
  });

  it("rejects reserved layer ENV keys before compiling shell", () => {
    for (const key of ["ARCANIST_TOKEN", "SANDBOX_ID", "SESSION_ID", "GITHUB_TOKEN", "OPENAI_API_KEY", "PATH"]) {
      expect(() => compileSandboxLayerEnvInstruction({ [key]: "value" })).toThrow(`ENV key '${key}' is reserved`);
    }
  });

  it("quotes smoke command argv at the execution boundary", () => {
    expect(compileSandboxLayerSmokeCommand(["bash", "-lc", "printf '%s' \"$TOKEN\""])).toBe(
      "'bash' '-lc' 'printf '\\''%s'\\'' \"$TOKEN\"'",
    );
  });
});
