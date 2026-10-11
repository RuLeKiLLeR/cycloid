// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexSessionManager } from "../../apps/sandbox-bridge/src/services/codex-session.js";

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

function defaultCreateCodexResult() {
  return {
    client: { session: { create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }) } },
    server: { url: "codex://local", close: vi.fn() },
  };
}

function makeManager(overrides: { createCodex?: unknown; useOpenAIFlexServiceTier?: boolean } = {}) {
  const log = makeLog();
  const createCodex = overrides.createCodex ?? vi.fn().mockResolvedValue(defaultCreateCodexResult());
  const mgr = new CodexSessionManager({
    createCodex,
    getCwd: () => "/workspace",
    log,
    startupTimeoutMs: 1_000,
    logResourceSnapshot: () => ({}),
    withPromptActivityPulse: (_id, _phase, work) => work(),
    useOpenAIFlexServiceTier: overrides.useOpenAIFlexServiceTier,
  });
  return { mgr, createCodex, log };
}

describe("CodexSessionManager.parseModel", () => {
  it("accepts a known openai model", () => {
    const { mgr } = makeManager();
    expect(mgr.parseModel("gpt-5.4")).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
  });

  it("throws on an unknown model", () => {
    const { mgr } = makeManager();
    expect(() => mgr.parseModel("future-provider/future-model")).toThrow("Unsupported Codex model");
    expect(() => mgr.parseModel("claude-sonnet-4-5")).toThrow("Unsupported Codex model 'claude-sonnet-4-5'");
  });
});

describe("CodexSessionManager env / requested model resolution", () => {
  let savedModel: string | undefined;
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedModel = process.env.MODEL;
    savedProvider = process.env.PROVIDER;
    delete process.env.MODEL;
    delete process.env.PROVIDER;
  });

  afterEach(() => {
    if (savedModel === undefined) delete process.env.MODEL;
    else process.env.MODEL = savedModel;
    if (savedProvider === undefined) delete process.env.PROVIDER;
    else process.env.PROVIDER = savedProvider;
  });

  it("defaults to the openai provider with no model when MODEL is unset", () => {
    const { mgr } = makeManager();
    expect(mgr.getEnvModelInfo()).toEqual({ providerID: "openai" });
  });

  it("parses MODEL from the environment when set", () => {
    process.env.MODEL = "gpt-5.4";
    const { mgr } = makeManager();
    expect(mgr.getEnvModelInfo()).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
  });

  it("throws (fail-closed) on a non-openai provider", () => {
    process.env.PROVIDER = "anthropic";
    const { mgr } = makeManager();
    expect(() => mgr.getEnvModelInfo()).toThrow("Unsupported Codex provider 'anthropic'");
  });

  it("prefers the requested model over the environment default", () => {
    process.env.MODEL = "gpt-5.5";
    const { mgr } = makeManager();
    expect(mgr.getRequestedModelInfo("gpt-5.4")).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
    expect(mgr.getRequestedModelInfo()).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  });
});

describe("CodexSessionManager.ensureClientInitializedForPrompt", () => {
  it("is a no-op when a client already exists for the same agent role", async () => {
    const { mgr, createCodex } = makeManager();
    await mgr.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    await mgr.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    expect(createCodex).toHaveBeenCalledTimes(1);
  });

  it("reinitializes the runtime when the prompt agent role changes", async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const createCodex = vi
      .fn()
      .mockResolvedValueOnce({
        client: { session: { create: vi.fn() } },
        server: { url: "codex://implementation", close: firstClose },
      })
      .mockResolvedValueOnce({
        client: { session: { create: vi.fn() } },
        server: { url: "codex://verification", close: secondClose },
      });
    const { mgr } = makeManager({ createCodex });

    await mgr.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    await mgr.ensureClientInitializedForPrompt({
      agentRole: "verification",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(createCodex).toHaveBeenCalledTimes(2);
    expect(createCodex).toHaveBeenNthCalledWith(1, expect.objectContaining({ agentRole: "implementation" }));
    expect(createCodex).toHaveBeenNthCalledWith(2, expect.objectContaining({ agentRole: "verification" }));
    expect(mgr.server?.url).toBe("codex://verification");
  });

  it("spawns the runtime once under concurrent calls (double-spawn latch)", async () => {
    let resolveInit: () => void = () => {};
    const createCodex = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveInit = () => resolve(defaultCreateCodexResult());
      }),
    );
    const { mgr } = makeManager({ createCodex });
    const signal = new AbortController().signal;
    const log = makeLog();
    const p1 = mgr.ensureClientInitializedForPrompt({ agentRole: "implementation", signal, promptLog: log });
    const p2 = mgr.ensureClientInitializedForPrompt({ agentRole: "implementation", signal, promptLog: log });
    resolveInit();
    await Promise.all([p1, p2]);
    expect(createCodex).toHaveBeenCalledTimes(1);
    expect(mgr.client).not.toBeNull();
    expect(mgr.server).not.toBeNull();
  });

  it("clears the init latch after a failed init so a later prompt can retry", async () => {
    const createCodex = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(defaultCreateCodexResult());
    const { mgr } = makeManager({ createCodex });
    const signal = new AbortController().signal;
    await expect(
      mgr.ensureClientInitializedForPrompt({ agentRole: "implementation", signal, promptLog: makeLog() }),
    ).rejects.toThrow("boom");
    expect(mgr.client).toBeNull();
    await mgr.ensureClientInitializedForPrompt({ agentRole: "implementation", signal, promptLog: makeLog() });
    expect(createCodex).toHaveBeenCalledTimes(2);
    expect(mgr.client).not.toBeNull();
  });

  it("forwards the OpenAI flex service tier opt-in to Codex runtime creation", async () => {
    const createCodex = vi.fn().mockResolvedValue(defaultCreateCodexResult());
    const { mgr } = makeManager({ createCodex, useOpenAIFlexServiceTier: true });

    await mgr.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(createCodex).toHaveBeenCalledWith(expect.objectContaining({ useOpenAIFlexServiceTier: true }));
  });
});

describe("CodexSessionManager.createCodexSessionForPrompt", () => {
  it("throws when the client is not initialized", async () => {
    const { mgr } = makeManager();
    await expect(
      mgr.createCodexSessionForPrompt({ messageId: "m1", promptLog: makeLog(), signal: new AbortController().signal }),
    ).rejects.toThrow("Codex client not initialized");
  });

  it("creates a session and returns its id", async () => {
    const { mgr } = makeManager();
    await mgr.ensureClientInitializedForPrompt({
      agentRole: "implementation",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });
    const id = await mgr.createCodexSessionForPrompt({
      messageId: "m1",
      promptLog: makeLog(),
      signal: new AbortController().signal,
    });
    expect(id).toBe("sess-1");
    expect(mgr.client.session.create).toHaveBeenCalledWith({ body: { title: "Cycloid Session" } });
  });
});
