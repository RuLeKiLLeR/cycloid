// @ts-nocheck -- sandbox-bridge is excluded from root tsconfig
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  createOpencode: vi.fn(),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencode: sdkMocks.createOpencode,
}));

import { OPENCODE_MEMORY_CONTEXT_FILE_ENV } from "../../apps/sandbox-bridge/src/services/opencode-first-party-dynamic-tools.js";
import { OPENCODE_IMAGE_FEEDBACK_MODEL_ENV } from "../../apps/sandbox-bridge/src/services/opencode-image-feedback.js";
import { OpencodeSessionManager } from "../../apps/sandbox-bridge/src/services/opencode-session.js";
import { BUILTIN_AGENTS, PLAN_AGENT_NAME } from "../../shared/agent/constants.js";
import { BasetenModel } from "../../shared/constants/models.js";

function makeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

function makeManager() {
  return new OpencodeSessionManager({
    getCwd: () => "/workspace",
    log: makeLog(),
    startupTimeoutMs: 1_000,
    withPromptActivityPulse: (_id, _phase, work) => work(),
  });
}

describe("OpencodeSessionManager MCP startup", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // opencode is rooted by chdir'ing the process to the repo cwd; stub it so the
    // test does not actually change into a non-existent "/workspace".
    vi.spyOn(process, "chdir").mockImplementation(() => {});
    process.env.BASETEN_API_KEY = "baseten-key";
    process.env.SANDBOX_AUTH_TOKEN = "sandbox-auth";
    process.env.GITHUB_CLONE_TOKEN = "clone-token";
    process.env.GH_TOKEN = "gh-token";
    process.env.LINEAR_ACCESS_TOKEN = "linear-token";
    process.env.DD_API_KEY = "dd-api";
    process.env.DD_APP_KEY = "dd-app";
    process.env.DD_SITE = "datadoghq.com";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...previousEnv };
  });

  it("starts opencode with the sanitized agent-child env", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    let serverEnv: NodeJS.ProcessEnv = {};
    sdkMocks.createOpencode.mockImplementation(async () => {
      serverEnv = { ...process.env };
      return {
        client: { mcp: { connect } },
        server: { url: "http://127.0.0.1:1234", close: vi.fn() },
      };
    });

    await makeManager().ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(serverEnv.BASETEN_API_KEY).toBe("baseten-key");
    expect(serverEnv.OPENCODE_CLIENT).toBe("serve");
    for (const name of [
      "SANDBOX_AUTH_TOKEN",
      "GITHUB_CLONE_TOKEN",
      "GH_TOKEN",
      "LINEAR_ACCESS_TOKEN",
      "DD_API_KEY",
      "DD_APP_KEY",
      "DD_SITE",
    ]) {
      expect(serverEnv[name], name).toBeUndefined();
    }
    expect(process.env.SANDBOX_AUTH_TOKEN).toBe("sandbox-auth");
  });

  it("passes trusted bridge env to the opencode first-party MCP subprocess", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: vi.fn() },
    });

    await makeManager().ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    const mcpEnv = sdkMocks.createOpencode.mock.calls[0][0].config.mcp.cycloid_first_party_dynamic_tools.environment;
    expect(mcpEnv.BASETEN_API_KEY).toBe("baseten-key");
    expect(mcpEnv.SANDBOX_AUTH_TOKEN).toBe("sandbox-auth");
    expect(mcpEnv.LINEAR_ACCESS_TOKEN).toBe("linear-token");
    expect(mcpEnv.DD_API_KEY).toBe("dd-api");
  });

  it("reinitializes opencode MCP registration when the prompt agent role changes", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    sdkMocks.createOpencode
      .mockResolvedValueOnce({
        client: { mcp: { connect } },
        server: { url: "http://127.0.0.1:1234", close: firstClose },
      })
      .mockResolvedValueOnce({
        client: { mcp: { connect } },
        server: { url: "http://127.0.0.1:5678", close: secondClose },
      });
    const manager = makeManager();

    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    await manager.ensureClientInitializedForPrompt({
      agentRole: "verification",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    const implementationMcpEnv =
      sdkMocks.createOpencode.mock.calls[0][0].config.mcp.cycloid_first_party_dynamic_tools.environment;
    const verificationMcpEnv =
      sdkMocks.createOpencode.mock.calls[1][0].config.mcp.cycloid_first_party_dynamic_tools.environment;
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(sdkMocks.createOpencode).toHaveBeenCalledTimes(2);
    expect(implementationMcpEnv.ARCANIST_AGENT_ROLE).toBe("implementation");
    expect(verificationMcpEnv.ARCANIST_AGENT_ROLE).toBe("verification");
    expect(connect).toHaveBeenCalledTimes(2);
    manager.shutdown();
  });

  it("reuses opencode MCP registration when the prompt model resolves to the active model", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    const firstClose = vi.fn();
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: firstClose },
    });
    const manager = makeManager();

    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      model: BasetenModel.KimiK27Code,
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    const kimiMcpEnv =
      sdkMocks.createOpencode.mock.calls[0][0].config.mcp.cycloid_first_party_dynamic_tools.environment;
    expect(firstClose).not.toHaveBeenCalled();
    expect(sdkMocks.createOpencode).toHaveBeenCalledTimes(1);
    expect(kimiMcpEnv[OPENCODE_IMAGE_FEEDBACK_MODEL_ENV]).toBe(BasetenModel.KimiK27Code);
    expect(sdkMocks.createOpencode.mock.calls[0][0].config.model).toBe("baseten/moonshotai/Kimi-K2.7-Code");
    expect(connect).toHaveBeenCalledTimes(1);
    manager.shutdown();
  });

  it("advertises and connects Cycloid first-party dynamic tools through opencode MCP", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: vi.fn() },
    });

    await makeManager().ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    // Roots opencode at the repo clone so edits land in the worktree (else an
    // empty git diff / no PR). createOpencode's ServerOptions has no cwd field.
    expect(process.chdir).toHaveBeenCalledWith("/workspace");
    expect(sdkMocks.createOpencode.mock.calls[0][0]).not.toHaveProperty("cwd");

    const config = sdkMocks.createOpencode.mock.calls[0][0].config;
    expect(config.lsp).toBeUndefined();
    expect(config.compaction).toStrictEqual({
      tail_turns: 4,
      preserve_recent_tokens: 30_000,
    });
    expect(config.mcp.cycloid_first_party_dynamic_tools).toMatchObject({
      type: "local",
      enabled: true,
      timeout: 10_000,
    });
    expect(Object.keys(config.agent)).toStrictEqual(Object.keys(BUILTIN_AGENTS));
    for (const [name, agent] of Object.entries(BUILTIN_AGENTS)) {
      const permission =
        name === PLAN_AGENT_NAME
          ? { edit: "deny", bash: "ask", webfetch: "ask" }
          : { edit: "ask", bash: "ask", webfetch: "ask" };
      expect(config.agent[name]).toStrictEqual({
        mode: "primary",
        model: "baseten/moonshotai/Kimi-K2.7-Code",
        description: agent.description,
        permission,
      });
    }
    expect(config.provider.baseten.models["moonshotai/Kimi-K2.7-Code"].reasoning).toBe(true);
    expect(connect).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      path: { name: "cycloid_first_party_dynamic_tools" },
    });
  });

  it("resolves Kimi K2.7 Code to its Baseten wire id in opencode config", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: vi.fn() },
    });

    const manager = makeManager();
    expect(manager.resolveOpencodeModel("kimi-k2.7-code")).toEqual({
      providerID: "baseten",
      modelID: "moonshotai/Kimi-K2.7-Code",
    });

    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      model: "kimi-k2.7-code",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    const config = sdkMocks.createOpencode.mock.calls[0][0].config;
    expect(config.model).toBe("baseten/moonshotai/Kimi-K2.7-Code");
    expect(config.provider.baseten.models["moonshotai/Kimi-K2.7-Code"]).toMatchObject({
      id: "moonshotai/Kimi-K2.7-Code",
      name: "Kimi K2.7 Code",
      tool_call: true,
      reasoning: true,
      limit: { context: 262_000, output: 32_000 },
    });
    manager.shutdown();
  });

  it("maps retired persisted Baseten models to Kimi during runtime restore", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: vi.fn() },
    });

    await makeManager().ensureClientInitializedForPrompt({
      agentRole: "implementation",
      model: "baseten/zai-org/GLM-4.7",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(sdkMocks.createOpencode.mock.calls[0][0].config.model).toBe("baseten/moonshotai/Kimi-K2.7-Code");
  });

  it("fails startup and closes the server when the Cycloid MCP server cannot connect", async () => {
    const close = vi.fn();
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect: vi.fn().mockResolvedValue({ data: false }) } },
      server: { url: "http://127.0.0.1:1234", close },
    });

    await expect(
      makeManager().ensureClientInitializedForPrompt({
        agentRole: "implementation",
        signal: new AbortController().signal,
        promptLog: makeLog(),
      }),
    ).rejects.toThrow("opencode MCP connect returned false");
    // The booted server subprocess must be closed on connect failure, not leaked.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refreshes the opencode memory context side-channel before each prompt", async () => {
    const connect = vi.fn().mockResolvedValue({ data: true });
    sdkMocks.createOpencode.mockResolvedValue({
      client: { mcp: { connect } },
      server: { url: "http://127.0.0.1:1234", close: vi.fn() },
    });
    let repoMemories = [
      { id: "mem-old", content: "old", context_hint: "", type: "rule", scope: "repo", referenced_files: null },
    ];
    const manager = new OpencodeSessionManager({
      getCwd: () => "/workspace",
      log: makeLog(),
      startupTimeoutMs: 1_000,
      getRepoMemories: () => repoMemories,
      withPromptActivityPulse: (_id, _phase, work) => work(),
    });

    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    const mcpEnv = sdkMocks.createOpencode.mock.calls[0][0].config.mcp.cycloid_first_party_dynamic_tools.environment;
    const contextFile = mcpEnv[OPENCODE_MEMORY_CONTEXT_FILE_ENV];
    expect(JSON.parse(readFileSync(contextFile, "utf8")).repoMemories[0].id).toBe("mem-old");

    repoMemories = [
      { id: "mem-new", content: "new", context_hint: "", type: "rule", scope: "repo", referenced_files: null },
    ];
    await manager.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(JSON.parse(readFileSync(contextFile, "utf8")).repoMemories[0].id).toBe("mem-new");
    manager.shutdown();
  });
});
