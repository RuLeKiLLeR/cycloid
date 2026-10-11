// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it, vi } from "vitest";

import { CodexRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/agent-runtime-adapter.js";
import { createAgentRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/agent-runtime-registry.js";
import { ClaudeCodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/claude-runtime-adapter.js";
import { OpencodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/opencode-runtime-adapter.js";
import {
  AGENT_RUNTIME_BACKENDS,
  isAgentRuntimeBackend,
  resolveAgentRuntimeBackend,
} from "../../shared/agent/agent-runtime-backend.js";

function makeLog() {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

function makeDeps(
  overrides: {
    createCodex?: unknown;
    createClaudeStartup?: unknown;
    stdioLineMaxBytes?: number;
    stdioSessionMaxBytes?: number;
  } = {},
) {
  const warmHandle = {
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
    query: vi.fn(),
  };
  return {
    createCodex:
      overrides.createCodex ??
      vi.fn().mockResolvedValue({
        client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
        server: { url: "codex://local", close: vi.fn() },
      }),
    getCwd: () => "/workspace",
    log: makeLog(),
    startupTimeoutMs: 1_000,
    stdioLineMaxBytes: overrides.stdioLineMaxBytes ?? 32 * 1024,
    stdioSessionMaxBytes: overrides.stdioSessionMaxBytes ?? 2_000_000,
    logResourceSnapshot: () => ({}),
    withPromptActivityPulse: (_id, _phase, work) => work(),
    getSandboxToken: () => "tok-test",
    getRolloutUploadUrl: () => "https://cp.example.com/api/sessions/sess-1/rollout",
    createClaudeStartup: overrides.createClaudeStartup ?? vi.fn(async () => warmHandle),
  };
}

describe("agent runtime backend identity", () => {
  it("lists exactly the known backends", () => {
    expect(AGENT_RUNTIME_BACKENDS).toEqual(["codex", "claude_code", "opencode"]);
  });

  it("type-guards known and unknown values", () => {
    expect(isAgentRuntimeBackend("codex")).toBe(true);
    expect(isAgentRuntimeBackend("claude_code")).toBe(true);
    expect(isAgentRuntimeBackend("opencode")).toBe(true);
    expect(isAgentRuntimeBackend(undefined)).toBe(false);
  });
});

describe("resolveAgentRuntimeBackend", () => {
  it("defaults to codex when unset or empty", () => {
    expect(resolveAgentRuntimeBackend(undefined)).toBe("codex");
    expect(resolveAgentRuntimeBackend("")).toBe("codex");
  });

  it("returns the backend when valid", () => {
    expect(resolveAgentRuntimeBackend("codex")).toBe("codex");
    expect(resolveAgentRuntimeBackend("claude_code")).toBe("claude_code");
    expect(resolveAgentRuntimeBackend("opencode")).toBe("opencode");
  });

  it("throws on an unknown backend", () => {
    expect(() => resolveAgentRuntimeBackend("other")).toThrow("Unknown agent runtime backend 'other'");
  });
});

describe("createAgentRuntimeAdapter", () => {
  it("builds a Codex adapter tagged with the codex backend", () => {
    const adapter = createAgentRuntimeAdapter("codex", makeDeps());
    expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
    expect(adapter.backend).toBe("codex");
    expect(adapter.harnessKind).toBe("codex-session");
    expect(adapter.rawFallbackPrefix).toBe("codex");
  });

  it("builds a Claude Code adapter tagged with the claude_code backend", () => {
    const adapter = createAgentRuntimeAdapter("claude_code", makeDeps());
    expect(adapter).toBeInstanceOf(ClaudeCodeRuntimeAdapter);
    expect(adapter.backend).toBe("claude_code");
    expect(adapter.harnessKind).toBe("claude-session");
    expect(adapter.rawFallbackPrefix).toBe("claude");
  });

  it("builds an Opencode adapter tagged with the opencode backend", () => {
    const adapter = createAgentRuntimeAdapter("opencode", makeDeps());
    expect(adapter).toBeInstanceOf(OpencodeRuntimeAdapter);
    expect(adapter.backend).toBe("opencode");
    expect(adapter.harnessKind).toBe("codex-session");
    expect(adapter.rawFallbackPrefix).toBe("opencode");
  });

  it("keeps the claude_code prompt-start deadline longer than codex", () => {
    const codex = createAgentRuntimeAdapter("codex", makeDeps());
    const claude = createAgentRuntimeAdapter("claude_code", makeDeps());
    expect(claude.promptStartTimeoutMs).toBeGreaterThan(codex.promptStartTimeoutMs);
  });

  it("exposes a non-mutating warmup contract on every backend", async () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      const createCodex = vi.fn().mockResolvedValue({
        client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
        server: { url: "codex://local", close: vi.fn() },
      });
      const warmHandle = {
        close: vi.fn(),
        [Symbol.asyncDispose]: vi.fn(async () => {}),
        query: vi.fn(),
      };
      const createClaudeStartup = vi.fn(async () => warmHandle);
      const adapter = createAgentRuntimeAdapter(backend, makeDeps({ createCodex, createClaudeStartup }));

      const result = await adapter.warmup({
        signal: new AbortController().signal,
        promptLog: makeLog(),
      });

      if (backend === "claude_code") {
        expect(result).toMatchObject({ outcome: "ready" });
        expect(result.duration_ms).toEqual(expect.any(Number));
        expect(createClaudeStartup).toHaveBeenCalledTimes(1);
        expect(warmHandle.close).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toEqual({ outcome: "skipped", reason: "not_supported", duration_ms: 0 });
        expect(createClaudeStartup).not.toHaveBeenCalled();
      }
      expect(adapter.isInitialized).toBe(false);
      expect(createCodex).not.toHaveBeenCalled();
    }
  });
});

describe("ClaudeCodeRuntimeAdapter model handling (lenient until phase 5)", () => {
  it("strips an optional anthropic/ prefix and passes the id through", () => {
    const adapter = createAgentRuntimeAdapter("claude_code", makeDeps());
    expect(adapter.parseModel("anthropic/claude-opus-4-8")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
    });
    expect(adapter.parseModel("claude-opus-4-8")).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
    expect(() => adapter.parseModel("")).toThrow("Unsupported Claude model");
  });

  it("reports isInitialized=false until a prompt latches readiness, false again on shutdown", async () => {
    const adapter = createAgentRuntimeAdapter("claude_code", makeDeps());
    expect(adapter.isInitialized).toBe(false);
    await adapter.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    expect(adapter.isInitialized).toBe(true);
    adapter.shutdown();
    expect(adapter.isInitialized).toBe(false);
  });
});

describe("CodexRuntimeAdapter delegation (behavior unchanged)", () => {
  it("delegates the fail-closed model guard to CodexSessionManager", () => {
    const adapter = createAgentRuntimeAdapter("codex", makeDeps());
    expect(adapter.parseModel("gpt-5.4")).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
    expect(() => adapter.parseModel("claude-sonnet-4-5")).toThrow("Unsupported Codex model 'claude-sonnet-4-5'");
  });

  it("reports isInitialized=false before the client/server are up", () => {
    const adapter = createAgentRuntimeAdapter("codex", makeDeps());
    expect(adapter.isInitialized).toBe(false);
  });

  it("flips isInitialized=true once the runtime is initialized and back to false on shutdown", async () => {
    const savedModel = process.env.MODEL;
    delete process.env.MODEL;
    try {
      const adapter = createAgentRuntimeAdapter("codex", makeDeps());
      await adapter.ensureClientInitializedForPrompt({
        agentRole: "implementation",
        signal: new AbortController().signal,
        promptLog: makeLog(),
      });
      expect(adapter.isInitialized).toBe(true);
      adapter.shutdown();
      expect(adapter.isInitialized).toBe(false);
    } finally {
      if (savedModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = savedModel;
    }
  });

  it("setStaticModel flows the model into the runtime config", async () => {
    const savedModel = process.env.MODEL;
    delete process.env.MODEL;
    try {
      const createCodex = vi.fn().mockResolvedValue({
        client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
        server: { url: "codex://local", close: vi.fn() },
      });
      const adapter = createAgentRuntimeAdapter("codex", makeDeps({ createCodex }));

      adapter.setStaticModel("openai/gpt-5.4");
      await adapter.ensureClientInitializedForPrompt({
        agentRole: "implementation",
        signal: new AbortController().signal,
        promptLog: makeLog(),
      });
      // The static model flows into the Codex runtime config passed to createCodex.
      expect(createCodex).toHaveBeenCalledTimes(1);
      expect(createCodex.mock.calls[0][0].config.model).toBeTruthy();
    } finally {
      if (savedModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = savedModel;
    }
  });

  it("setStaticModel(undefined) leaves no model in the runtime config", async () => {
    const savedModel = process.env.MODEL;
    delete process.env.MODEL;
    try {
      const createCodex = vi.fn().mockResolvedValue({
        client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
        server: { url: "codex://local", close: vi.fn() },
      });
      const adapter = createAgentRuntimeAdapter("codex", makeDeps({ createCodex }));

      adapter.setStaticModel(undefined);
      await adapter.ensureClientInitializedForPrompt({
        agentRole: "implementation",
        signal: new AbortController().signal,
        promptLog: makeLog(),
      });
      expect(createCodex).toHaveBeenCalledTimes(1);
      expect(createCodex.mock.calls[0][0].config.model).toBeUndefined();
    } finally {
      if (savedModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = savedModel;
    }
  });

  it("passes Codex stdio forwarding caps into runtime creation", async () => {
    const savedModel = process.env.MODEL;
    delete process.env.MODEL;
    try {
      const createCodex = vi.fn().mockResolvedValue({
        client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
        server: { url: "codex://local", close: vi.fn() },
      });
      const adapter = createAgentRuntimeAdapter(
        "codex",
        makeDeps({
          createCodex,
          stdioLineMaxBytes: 32 * 1024,
          stdioSessionMaxBytes: 2_000_000,
        }),
      );

      await adapter.ensureClientInitializedForPrompt({
        agentRole: "implementation",
        signal: new AbortController().signal,
        promptLog: makeLog(),
      });

      expect(createCodex).toHaveBeenCalledTimes(1);
      expect(createCodex.mock.calls[0][0]).toMatchObject({
        stdioLineMaxBytes: 32 * 1024,
        stdioSessionMaxBytes: 2_000_000,
      });
    } finally {
      if (savedModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = savedModel;
    }
  });
});
