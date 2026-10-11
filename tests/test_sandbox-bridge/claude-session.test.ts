// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSessionStaticBehavioralGuidance } from "../../apps/sandbox-bridge/src/constants/bridge.js";
import {
  buildClaudeFirstPartyDynamicToolsProjection,
  parseClaudeFirstPartyDynamicToolName,
} from "../../apps/sandbox-bridge/src/services/claude-first-party-dynamic-tools.js";
import {
  buildClaudeMcpContentItemsForDynamicToolResult,
  filterClaudeDesktopDynamicToolSpecsForImageFeedback,
  resolveClaudeImageFeedbackCapability,
} from "../../apps/sandbox-bridge/src/services/claude-image-feedback.js";
import {
  buildUserMessage,
  ClaudeSessionManager,
  parseClaudeModel,
} from "../../apps/sandbox-bridge/src/services/claude-session.js";
import { serializeFirstPartyDynamicToolContentItemsForPersistence } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";
import { KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME } from "../../apps/sandbox-bridge/src/services/known-image-dynamic-tool.js";
import { MEMORY_FEATURE_DISABLED } from "../../shared/constants/memory.js";

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
}

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimal push-backed SDKMessage stream used as the fake query's output. */
class PushOut {
  queue = [];
  waiters = [];
  closed = false;
  push(msg) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ done: false, value: msg });
    else this.queue.push(msg);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ done: true, value: undefined });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const v = this.queue.shift();
        if (v) return Promise.resolve({ done: false, value: v });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * Fake SDK `query()` factory: captures options, drains the input stream so we can
 * assert the per-turn user messages, and lets the test emit output messages and
 * drive turn completion. Exposes spies for setModel/interrupt/return.
 */
function makeFakeQuery() {
  const out = new PushOut();
  const inputs = [];
  const optionsByCall = [];
  const setModel = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const returnFn = vi.fn(async () => {
    out.close();
    return { done: true, value: undefined };
  });
  const factory = vi.fn(({ prompt, options }) => {
    optionsByCall.push(options);
    void (async () => {
      for await (const m of prompt) inputs.push(m);
    })();
    return {
      setModel,
      interrupt,
      return: returnFn,
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    };
  });
  return { factory, out, inputs, optionsByCall, setModel, interrupt, returnFn };
}

/** Read a per-turn stream until its terminal `result`, then detach (as the bridge does). */
async function drainTurn(stream) {
  const records = [];
  for await (const rec of stream) {
    records.push(rec);
    if (rec.type === "result") break;
  }
  await stream.return?.();
  return records;
}

const successResult = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" };

function newManager(fake, extra = {}) {
  return new ClaudeSessionManager({
    getCwd: () => "/workspace",
    log: makeLog(),
    queryImpl: fake.factory,
    ...extra,
  });
}

describe("ClaudeSessionManager warmup", () => {
  it("uses SDK startup without binding prompt, session, or MCP state, then closes the warm handle", async () => {
    const fake = makeFakeQuery();
    const warmHandle = {
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(async () => {}),
      query: vi.fn(),
    };
    const startupImpl = vi.fn(async () => warmHandle);
    const manager = newManager(fake, { startupImpl, claudePath: "/opt/claude" });

    await manager.warmup({
      signal: new AbortController().signal,
      promptLog: makeLog(),
      timeoutMs: 1234,
    });

    expect(startupImpl).toHaveBeenCalledTimes(1);
    const params = startupImpl.mock.calls[0][0];
    expect(params.initializeTimeoutMs).toBe(1234);
    expect(params.options).toMatchObject({
      cwd: "/workspace",
      settingSources: [],
      strictMcpConfig: true,
      pathToClaudeCodeExecutable: "/opt/claude",
    });
    expect(params.options.abortController).toBeInstanceOf(AbortController);
    expect(params.options.abortController.signal.aborted).toBe(false);
    expect(params.options).not.toHaveProperty("mcpServers");
    expect(params.options).not.toHaveProperty("sessionId");
    expect(params.options).not.toHaveProperty("resume");
    expect(params.options).not.toHaveProperty("systemPrompt");
    expect(warmHandle.query).not.toHaveBeenCalled();
    expect(warmHandle.close).toHaveBeenCalledTimes(1);
    expect(manager.isInitialized).toBe(false);
  });

  it("aborts the SDK startup process when bridge warmup is aborted", async () => {
    const fake = makeFakeQuery();
    let resolveWarmup;
    const warmHandle = {
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(async () => {}),
      query: vi.fn(),
    };
    const startupImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveWarmup = resolve;
        }),
    );
    const manager = newManager(fake, { startupImpl });
    const abort = new AbortController();

    const warmupPromise = manager.warmup({
      signal: abort.signal,
      promptLog: makeLog(),
      timeoutMs: 1234,
    });
    await vi.waitFor(() => expect(startupImpl).toHaveBeenCalledTimes(1));
    const params = startupImpl.mock.calls[0][0];

    abort.abort();

    await expect(warmupPromise).rejects.toThrow("Aborted");
    expect(params.options.abortController.signal.aborted).toBe(true);
    expect(warmHandle.close).not.toHaveBeenCalled();

    resolveWarmup(warmHandle);
    await vi.waitFor(() => expect(warmHandle.close).toHaveBeenCalledTimes(1));
  });
});

describe("buildUserMessage", () => {
  it("prepends the per-prompt system context and serializes text + image parts", () => {
    const msg = buildUserMessage({
      system: "be terse",
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: "more", synthetic: true },
        { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,QUJD" },
      ],
      agent: "build",
      agentRole: "implementation",
    });
    expect(msg.type).toBe("user");
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toEqual([
      { type: "text", text: "<cycloid-system-context>\nbe terse\n</cycloid-system-context>" },
      { type: "text", text: "hello" },
      { type: "text", text: "more" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ]);
  });

  it("omits the system block when there is no system context and skips non-image files", () => {
    const msg = buildUserMessage({
      parts: [
        { type: "file", mime: "image/jpeg", filename: "remote.jpg", url: "https://example.com/x.jpg" },
        { type: "file", mime: "application/pdf", filename: "doc.pdf", url: "data:application/pdf;base64,QQ==" },
      ],
      agent: "build",
      agentRole: "implementation",
    });
    expect(msg.message.content).toEqual([{ type: "image", source: { type: "url", url: "https://example.com/x.jpg" } }]);
  });
});

describe("buildSessionStaticBehavioralGuidance — cache-prefix byte-stability", () => {
  // The append carries the cached prompt-cache prefix. Its only source of
  // non-determinism is e2eRuntimeSupported() -> hasConfiguredE2ERuntime(), which
  // reads ARCANIST_PREVIEW_CONTRACT_JSON. Prove the append is byte-stable WITHIN
  // each env state, that it carries no per-turn volatile markers, and that the
  // two states differ on purpose (so cross-session cache identity is keyed on the
  // runtime envelope, not just the API key).
  const E2E_CONTRACT = JSON.stringify({
    cwd: "/workspace/repo",
    kind: "web",
    runner: "docker",
    entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
    url: { hostPort: 4173 },
    e2e: { testCommand: "npm run test:e2e" },
  });

  function withPreviewContract<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
    if (value === undefined) delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
    else process.env.ARCANIST_PREVIEW_CONTRACT_JSON = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
      else process.env.ARCANIST_PREVIEW_CONTRACT_JSON = prev;
    }
  }

  it("is byte-identical across repeated calls and free of volatile markers (no E2E runtime)", () => {
    withPreviewContract(undefined, () => {
      const first = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
      for (let i = 0; i < 5; i++)
        expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).toBe(first);
      // No timestamps, ISO dates, or random-looking ids that would invalidate the cache per turn.
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
      expect(first).not.toMatch(/\b\d{13}\b/); // epoch millis
    });
  });

  it("is byte-identical across repeated calls and free of volatile markers when an E2E runtime is configured", () => {
    withPreviewContract(E2E_CONTRACT, () => {
      const first = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
      for (let i = 0; i < 5; i++)
        expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).toBe(first);
      // The configured-runtime path adds buildE2ERuntimeGuidance(); guard it against
      // non-deterministic injection too, not just the no-E2E case.
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
      expect(first).not.toMatch(/\b\d{13}\b/); // epoch millis
    });
  });

  it("intentionally differs between the two env states (append is keyed on the runtime envelope)", () => {
    const withoutRuntime = withPreviewContract(undefined, () =>
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
    );
    const withRuntime = withPreviewContract(E2E_CONTRACT, () =>
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
    );
    expect(withRuntime).not.toBe(withoutRuntime);
  });

  it("is byte-identical within each session-static agent role", () => {
    const implementation = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    const verification = buildSessionStaticBehavioralGuidance({ agentRole: "verification" });

    expect(buildSessionStaticBehavioralGuidance({ agentRole: "implementation" })).toBe(implementation);
    expect(buildSessionStaticBehavioralGuidance({ agentRole: "verification" })).toBe(verification);
    expect(verification).not.toBe(implementation);
  });
});

describe("parseClaudeModel", () => {
  it("accepts prefixed and bare ids, rejects empty", () => {
    expect(parseClaudeModel("anthropic/claude-opus-4-8")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
    });
    expect(parseClaudeModel("claude-opus-4-8")).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
    expect(parseClaudeModel("claude-fable-5")).toEqual({ providerID: "anthropic", modelID: "claude-fable-5" });
    expect(() => parseClaudeModel("")).toThrow("Unsupported Claude model");
  });

  it("fails closed for unknown, non-claude, and wrong-provider ids", () => {
    expect(() => parseClaudeModel("claude-opus-9-9")).toThrow("Unsupported Claude model");
    expect(() => parseClaudeModel("gpt-5.5")).toThrow("Unsupported Claude model");
    expect(() => parseClaudeModel("openai/gpt-5.5")).toThrow("Unsupported Claude model provider");
  });
});

describe("ClaudeSessionManager — persistent query + demux", () => {
  it("opens one query for the session and demuxes turns (turn 1 closes, turn 2 reuses it)", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.ensureReady();
    expect(mgr.isInitialized).toBe(true);

    // Turn 1
    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "one" }], agent: "build", agentRole: "implementation" },
      sig("sess"),
    );
    fake.out.push({ type: "system", subtype: "init", session_id: "sess" });
    fake.out.push({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
    fake.out.push(successResult);
    const t1 = await drainTurn(s1);
    expect(t1.at(-1).type).toBe("result");
    expect(fake.factory).toHaveBeenCalledTimes(1);

    // Turn 2 — same query (factory NOT called again), turn-1 return() did not kill it
    const { stream: s2 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "two" }], agent: "build", agentRole: "implementation" },
      sig("sess"),
    );
    fake.out.push({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } });
    fake.out.push(successResult);
    const t2 = await drainTurn(s2);

    expect(fake.factory).toHaveBeenCalledTimes(1);
    expect(t2.some((r) => r.type === "assistant")).toBe(true);
    expect(t2.at(-1).type).toBe("result");
    expect(fake.inputs).toHaveLength(2);
  });

  it("delivers the distinct per-prompt system context on every turn", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { system: "turn-1 context", parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s"),
    );
    fake.out.push(successResult);
    await drainTurn(s1);

    const { stream: s2 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { system: "turn-2 context", parts: [{ type: "text", text: "y" }], agent: "build", agentRole: "implementation" },
      sig("s"),
    );
    fake.out.push(successResult);
    await drainTurn(s2);

    expect(fake.inputs[0].message.content[0].text).toContain("turn-1 context");
    expect(fake.inputs[1].message.content[0].text).toContain("turn-2 context");
  });

  it("keeps one persistent query across sequential verification phase prompts", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    for (const phase of [
      "verification-planner",
      "verification-checker",
      "verification-launcher",
      "verification-operator",
      "verification-judge",
    ]) {
      const { stream } = mgr.subscribeEvents();
      await mgr.dispatch(
        { parts: [{ type: "text", text: `phase ${phase}` }], agent: "verify", agentRole: "verification" },
        sig("verifier"),
      );
      fake.out.push(successResult);
      await drainTurn(stream);
    }

    expect(fake.factory).toHaveBeenCalledTimes(1);
    expect(fake.inputs.map((input) => input.message.content.at(-1)?.text)).toEqual([
      "phase verification-planner",
      "phase verification-checker",
      "phase verification-launcher",
      "phase verification-operator",
      "phase verification-judge",
    ]);
  });

  it("uses the pinned sessionId on a fresh open and resume on a restored session", async () => {
    const fresh = makeFakeQuery();
    const m1 = newManager(fresh);
    m1.subscribeEvents();
    await m1.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("fresh-id"));
    expect(fresh.optionsByCall[0].sessionId).toBe("fresh-id");
    expect(fresh.optionsByCall[0].resume).toBeUndefined();

    const restored = makeFakeQuery();
    const m2 = newManager(restored);
    m2.markResumable("restored-id");
    m2.subscribeEvents();
    await m2.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("restored-id"));
    expect(restored.optionsByCall[0].resume).toBe("restored-id");
    expect(restored.optionsByCall[0].sessionId).toBeUndefined();
  });

  it("wires the static claude_code preset with appended behavioral guidance and includePartialMessages at query open", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
    const opts = fake.optionsByCall[0];
    // Parity with the Codex `${CODEX_HOME}/AGENTS.md` channel: the exact static
    // behavioral guidance rides the system prompt for claude_code sessions.
    // `excludeDynamicSections: true` is the prompt-cache lever — it keeps the
    // SDK's per-user dynamic sections (cwd/git-status/auto-memory) out of the
    // cached prefix so resumes/cross-session reuse the cached bytes.
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
      excludeDynamicSections: true,
    });
    // Standalone content guards: fail if any static section is dropped from
    // the builder (the toEqual above only verifies wiring, not content).
    const appended = (opts.systemPrompt as { append: string }).append;
    for (const section of [
      "# Sandbox environment",
      "# Investigation and checks",
      "# Task completion",
      "# Git restrictions",
      "# Linked repo guidance",
      "# Agent profiles",
      "# Validation before commit",
    ]) {
      expect(appended).toContain(section);
    }
    expect(opts.includePartialMessages).toBe(true);
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("maps reasoning variants to SDK effort when the persistent query opens", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "high" }, sig("effort-high"));
    expect(fake.optionsByCall[0].effort).toBe("high");
  });

  it("omits SDK effort for the none reasoning variant", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "none" }, sig("effort-none"));
    expect(fake.optionsByCall[0]).not.toHaveProperty("effort");
  });

  it("fails closed for unsupported Claude reasoning variants", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await expect(
      mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "turbo" }, sig("bad-effort")),
    ).rejects.toThrow("Unsupported Claude reasoning effort: turbo");
    expect(fake.factory).not.toHaveBeenCalled();
  });

  it("logs and rejects mid-session effort changes without closing the query", async () => {
    const fake = makeFakeQuery();
    const log = makeLog();
    const mgr = newManager(fake, { log });

    const { stream: firstStream } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "high" }, sig("effort"));
    fake.out.push(successResult);
    await drainTurn(firstStream);

    mgr.subscribeEvents();
    await expect(
      mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "low" }, sig("effort")),
    ).rejects.toThrow("Claude reasoning effort cannot change after the persistent query opens");

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "claude.effort_mismatch",
        sessionId: "effort",
        currentEffort: "high",
        requestedEffort: "low",
      }),
      "Claude reasoning effort changed after the persistent query opened",
    );
    expect(fake.factory).toHaveBeenCalledTimes(1);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.interrupt).not.toHaveBeenCalled();

    const { stream: nextStream } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", variant: "high" }, sig("effort"));
    fake.out.push(successResult);
    await drainTurn(nextStream);

    expect(fake.factory).toHaveBeenCalledTimes(1);
    expect(fake.inputs).toHaveLength(2);
  });

  it("uses verification-role static guidance in the cached append for verifier sessions", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "verify", agentRole: "verification" }, sig("s"));

    const append = fake.optionsByCall[0].systemPrompt.append;
    expect(append).toBe(buildSessionStaticBehavioralGuidance({ agentRole: "verification" }));
    expect(append).not.toContain("# Task completion");
    expect(append).not.toContain("# Git restrictions");
    expect(append).not.toContain("# Implementation checks");
  });

  it("projects available first-party dynamic tools through MCP and injects their guidance per turn", async () => {
    const prev = {
      DD_API_KEY: process.env.DD_API_KEY,
      DD_APP_KEY: process.env.DD_APP_KEY,
      DD_SITE: process.env.DD_SITE,
    };
    process.env.DD_API_KEY = "dd-api";
    process.env.DD_APP_KEY = "dd-app";
    process.env.DD_SITE = "datadoghq.com";
    try {
      const fake = makeFakeQuery();
      const mgr = newManager(fake);
      const { stream } = mgr.subscribeEvents();
      await mgr.dispatch(
        { system: "turn context", parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
        sig("s"),
      );
      fake.out.push(successResult);
      await drainTurn(stream);

      const opts = fake.optionsByCall[0];
      expect(opts.mcpServers.cycloid_first_party_dynamic_tools).toMatchObject({
        type: "sdk",
        name: "cycloid_first_party_dynamic_tools",
      });
      expect(opts.systemPrompt.append).not.toContain("# First-party dynamic tools");
      expect(fake.inputs[0].message.content[0].text).toContain("turn context");
      expect(fake.inputs[0].message.content[0].text).toContain("# First-party dynamic tools");
      expect(fake.inputs[0].message.content[0].text).toContain("datadog.search_datadog_logs");
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("appends the customer's project doc (CYCLOID.md > AGENTS.md > CLAUDE.md) to the system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-project-doc-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "Use pnpm, never npm.", "utf-8");
    writeFileSync(join(cwd, "CLAUDE.md"), "loser doc", "utf-8");

    const fake = makeFakeQuery();
    const mgr = newManager(fake, { getCwd: () => cwd });
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));

    const appended = fake.optionsByCall[0].systemPrompt.append;
    // Behavioral guidance stays intact, the precedence winner is appended.
    expect(appended).toContain("# Sandbox environment");
    expect(appended).toContain("# Repo instructions (AGENTS.md)");
    expect(appended).toContain("Use pnpm, never npm.");
    expect(appended).not.toContain("loser doc");
  });

  it("leaves the system prompt unchanged when the repo has no instruction doc", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-no-doc-"));
    tempDirs.push(cwd);

    const fake = makeFakeQuery();
    const mgr = newManager(fake, { getCwd: () => cwd });
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));

    expect(fake.optionsByCall[0].systemPrompt.append).toBe(
      buildSessionStaticBehavioralGuidance({ agentRole: "implementation" }),
    );
  });

  it("keeps Cycloid per-turn volatile content out of the cached append (cache-prefix invariant)", async () => {
    // The cache invariant: request.system (per-turn volatile context) must ride
    // the queued user message's <cycloid-system-context> block ONLY, never the
    // cached systemPrompt.append. buildUserMessage alone cannot prove this (it
    // has no view of systemPrompt), so assert both at the manager level.
    const marker = "VOLATILE-TURN-CONTEXT-MARKER";
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch(
      { system: marker, parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s"),
    );
    // Drain the turn before asserting on fake.inputs: dispatch only pushes onto
    // the input stream, and the fake consumes it asynchronously, so reading
    // fake.inputs[0] right after dispatch would race the consumer. Draining to
    // the terminal result guarantees the queued message has been consumed
    // (matches the sibling per-turn-context test).
    fake.out.push(successResult);
    await drainTurn(stream);

    const append = (fake.optionsByCall[0].systemPrompt as { append: string }).append;
    expect(append).not.toContain(marker);

    const queued = fake.inputs[0].message.content[0].text;
    expect(queued).toContain(`<cycloid-system-context>\n${marker}`);
    expect(queued).toContain("</cycloid-system-context>");
  });

  it("passes a sanitized env (no telemetry secrets, ANTHROPIC_API_KEY present) and SDK isolation flags", async () => {
    const prevDd = process.env.DD_API_KEY;
    const prevAnth = process.env.ANTHROPIC_API_KEY;
    process.env.DD_API_KEY = "dd-secret";
    process.env.ANTHROPIC_API_KEY = "anth-key";
    try {
      const fake = makeFakeQuery();
      const mgr = newManager(fake);
      mgr.subscribeEvents();
      await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s-env"));
      const opts = fake.optionsByCall[0];
      // env REPLACES process.env for the subprocess, so it must be sanitized
      // but still carry the provider key.
      expect(opts.env).toBeDefined();
      expect(opts.env.DD_API_KEY).toBeUndefined();
      expect(opts.env.ANTHROPIC_API_KEY).toBe("anth-key");
      // SDK isolation: no filesystem settings, only explicitly-passed MCP.
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
    } finally {
      if (prevDd === undefined) delete process.env.DD_API_KEY;
      else process.env.DD_API_KEY = prevDd;
      if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnth;
    }
  });

  it("canUseTool returns the SDK allow shape (echoes updatedInput) and the deny shape", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
    const canUseTool = fake.optionsByCall[0].canUseTool;

    // Allow MUST carry `updatedInput` — the SDK control protocol rejects a bare
    // `{behavior:"allow"}` (the regression the E2E caught).
    const allowInput = { file_path: "/repo/src/app.ts" };
    await expect(canUseTool("Write", allowInput, {})).resolves.toEqual({
      behavior: "allow",
      updatedInput: allowInput,
    });

    const deny = await canUseTool("Write", { file_path: "/repo/.env" }, {});
    expect(deny.behavior).toBe("deny");
    expect(deny.message).toContain("protected path");
  });

  it("enforces the review-loop worktree boundary (parity with the Codex gate)", async () => {
    const fake = makeFakeQuery();
    let reviewLoop = { reviewLoopMode: false };
    const mgr = newManager(fake, {
      getCwd: () => "/workspace/repo",
      getReviewLoopContext: () => reviewLoop,
    });
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
    const canUseTool = fake.optionsByCall[0].canUseTool;

    // Outside the worktree, but allowed when not in review-loop mode.
    await expect(canUseTool("Write", { file_path: "/tmp/outside.txt" }, {})).resolves.toMatchObject({
      behavior: "allow",
    });

    // In review-loop mode the same out-of-worktree write is denied.
    reviewLoop = { reviewLoopMode: true };
    const deny = await canUseTool("Write", { file_path: "/tmp/outside.txt" }, {});
    expect(deny.behavior).toBe("deny");
    expect(deny.message).toContain("worktree");
  });

  it("normalizes Claude first-party MCP tool names before review-loop source-kind checks", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake, {
      getReviewLoopContext: () => ({ reviewLoopMode: true, reviewLoopSourceKind: "bot" }),
    });
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
    const canUseTool = fake.optionsByCall[0].canUseTool;

    const deny = await canUseTool(
      "mcp__cycloid_first_party_dynamic_tools__cycloid__review_summary_comment",
      { epochId: "epoch-1", body: "summary" },
      {},
    );
    expect(deny.behavior).toBe("deny");
    expect(deny.message).toContain("review-loop source kind");
  });
});

describe("Claude first-party dynamic tool projection", () => {
  it("gates Datadog tool availability on Datadog credentials", () => {
    const withoutDatadog = buildClaudeFirstPartyDynamicToolsProjection({}, { env: {} });
    expect(withoutDatadog?.toolNames.has("datadog.search_datadog_logs")).toBe(false);

    const env = { DD_API_KEY: "api", DD_APP_KEY: "app", DD_SITE: "datadoghq.com" };
    const withDatadog = buildClaudeFirstPartyDynamicToolsProjection(env, { env });
    expect(withDatadog?.toolNames.has("datadog.search_datadog_logs")).toBe(true);
    expect(withDatadog?.toolNames.has("datadog.get_datadog_trace")).toBe(true);
  });

  it("hides side-effecting tools from verification-role projections", () => {
    const env = { LINEAR_ACCESS_TOKEN: "linear-token" };
    const projection = buildClaudeFirstPartyDynamicToolsProjection(env, { env }, { agentRole: "verification" });

    expect(projection?.toolNames.has("linear.get_issue")).toBe(true);
    expect(projection?.toolNames.has("linear.create_issue")).toBe(false);
    expect(projection?.toolNames.has("linear.update_issue")).toBe(false);
    expect(projection?.toolNames.has("linear.create_comment")).toBe(false);
  });

  it("executes a projected Cloudflare D1 tool through the shared MCP handler", async () => {
    const env = {
      CF_ACCOUNT_ID: "acct",
      CF_D1_DATABASE_ID: "db",
      CF_API_TOKEN: "token",
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        result: [{ results: [{ id: 1, name: "Ada" }], success: true }],
      }),
    }));
    const projection = buildClaudeFirstPartyDynamicToolsProjection(env, { env, fetchImpl });

    const result = await projection?.executeTool("cloudflare__query_d1", {
      sql: "select * from users where id = ?",
      params: [1],
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('"rowCount":1');
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
  });

  it("projects known dynamic-tool images into the Claude MCP tool result before the next desktop action", async () => {
    const env = { ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" };
    const projection = buildClaudeFirstPartyDynamicToolsProjection(env, { env });

    const result = await projection?.executeTool(`cycloid__${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`, {
      scenarioId: `claude-feedback-${randomUUID()}`,
      detail: "high",
    });

    expect(result?.isError).toBe(false);
    expect(result?.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('"fixture":"known_image"'),
    });
    expect(result?.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      _meta: {
        cycloidLabel: "Known visual-feedback fixture",
        cycloidDetail: "high",
        cycloidWidth: 640,
        cycloidHeight: 360,
      },
    });
    expect(result?.content[1].data).toEqual(expect.any(String));
    expect(result?.content[1].data.length).toBeGreaterThan(100);
  });

  it("keeps text and readable images when one Claude dynamic-tool image cannot be read", async () => {
    const imageDir = mkdtempSync(join(tmpdir(), "claude-image-feedback-"));
    tempDirs.push(imageDir);
    const readableImagePath = join(imageDir, "readable.png");
    writeFileSync(readableImagePath, "readable image bytes");
    const promptLog = makeLog();

    const result = await buildClaudeMcpContentItemsForDynamicToolResult({
      capability: resolveClaudeImageFeedbackCapability({
        nativeMcpToolResultImages: true,
        jsonSerializedContentItems: true,
      }),
      promptLog,
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: '{"ok":true}' },
          {
            type: "inputImage",
            path: join(imageDir, "missing.png"),
            mimeType: "image/png",
            label: "missing image",
            detail: "high",
            width: 640,
            height: 360,
            bytes: 1024,
          },
          {
            type: "inputImage",
            path: readableImagePath,
            mimeType: "image/png",
            label: "readable image",
            detail: "low",
            width: 320,
            height: 180,
            bytes: 20,
          },
        ],
      },
    });

    expect(result.unsupportedReason).toBeNull();
    expect(result.content).toEqual([
      { type: "text", text: '{"ok":true}' },
      {
        type: "image",
        data: Buffer.from("readable image bytes").toString("base64"),
        mimeType: "image/png",
        _meta: {
          cycloidLabel: "readable image",
          cycloidDetail: "low",
          cycloidWidth: 320,
          cycloidHeight: 180,
          cycloidBytes: 20,
        },
      },
    ]);
    expect(promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "desktop.image_feedback_read_failed",
        backend: "claude_code",
        path: expect.stringContaining("missing.png"),
        label: "missing image",
      }),
      "Failed to read Claude Code desktop image feedback image",
    );
  });

  it("keeps Claude dynamic-tool persistence text-only when tool results include images", async () => {
    const env = { ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" };
    const projection = buildClaudeFirstPartyDynamicToolsProjection(env, { env });

    const result = await projection?.executeTool(`cycloid__${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`, {
      scenarioId: `claude-persistence-${randomUUID()}`,
      detail: "high",
    });

    const textItem = result?.content.find((item) => item.type === "text");
    const imageItem = result?.content.find((item) => item.type === "image");
    expect(imageItem?.data).toEqual(expect.any(String));

    const persisted = serializeFirstPartyDynamicToolContentItemsForPersistence(
      [{ type: "inputText", text: textItem?.text ?? "" }],
      true,
    );
    const persistedItems = JSON.parse(persisted);
    expect(JSON.parse(persistedItems[0].text)).toMatchObject({ fixture: "known_image" });
    expect(persisted).not.toContain(imageItem?.data);
    expect(persisted).not.toContain("inputImage");
    expect(persisted).not.toContain("base64");
  });

  it("hides desktop tools and emits unsupported telemetry when native Claude image delivery fails", () => {
    const unsupportedCapability = resolveClaudeImageFeedbackCapability({
      nativeMcpToolResultImages: false,
      jsonSerializedContentItems: false,
    });
    const emitted = [];
    const specs = filterClaudeDesktopDynamicToolSpecsForImageFeedback({
      capability: unsupportedCapability,
      modelId: "claude-opus-4-8",
      emitUnsupported: (fields) => emitted.push(fields),
      specs: [
        {
          namespace: "desktop",
          name: "click",
          description: "Click the desktop.",
          inputSchema: { type: "object" },
        },
        {
          namespace: "cycloid",
          name: "memory_recall",
          description: "Recall memory.",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(specs.map((spec) => `${spec.namespace}.${spec.name}`)).toEqual(["cycloid.memory_recall"]);
    expect(emitted).toEqual([
      {
        event: "desktop.model_image_feedback_unsupported",
        backend: "claude_code",
        modelId: "claude-opus-4-8",
        reason: "no_delivery_path_available",
        registrationBlocked: true,
      },
    ]);
  });

  it("logs the model ID when an executed Claude dynamic tool returns unsupported image feedback", async () => {
    const env = { ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" };
    const promptLog = makeLog();
    const projection = buildClaudeFirstPartyDynamicToolsProjection(
      env,
      { env, promptLog },
      {
        imageFeedbackCapability: resolveClaudeImageFeedbackCapability({
          nativeMcpToolResultImages: false,
          jsonSerializedContentItems: true,
        }),
        modelId: "claude-opus-4-8",
      },
    );

    const result = await projection?.executeTool(`cycloid__${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`, {
      scenarioId: `claude-unsupported-model-${randomUUID()}`,
      detail: "high",
    });

    expect(result?.isError).toBe(false);
    expect(result?.content.every((item) => item.type === "text")).toBe(true);
    expect(promptLog.warn).toHaveBeenCalledWith(
      {
        event: "desktop.model_image_feedback_unsupported",
        backend: "claude_code",
        modelId: "claude-opus-4-8",
        reason: "json_only_content_items_not_model_visible",
        registrationBlocked: false,
      },
      "Claude Code desktop image feedback is unavailable",
    );
  });

  it("reads live memory context only when a projected tool executes", async () => {
    const env = {
      CF_ACCOUNT_ID: "acct",
      CF_D1_DATABASE_ID: "db",
      CF_API_TOKEN: "token",
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, result: [{ results: [], success: true }] }),
    }));
    const getRepoMemories = vi.fn(() => []);
    const getMemoryRefById = vi.fn(() => new Map());
    const projection = buildClaudeFirstPartyDynamicToolsProjection(env, {
      env,
      fetchImpl,
      getRepoMemories,
      getMemoryRefById,
    });

    expect(getRepoMemories).not.toHaveBeenCalled();
    expect(getMemoryRefById).not.toHaveBeenCalled();

    await projection?.executeTool("cloudflare__query_d1", { sql: "select 1" });

    expect(getRepoMemories).toHaveBeenCalledTimes(1);
    expect(getMemoryRefById).toHaveBeenCalledTimes(1);
  });

  it.skipIf(MEMORY_FEATURE_DISABLED)("forwards memory recall telemetry from projected tools", async () => {
    const telemetry = vi.fn();
    const projection = buildClaudeFirstPartyDynamicToolsProjection(
      {},
      {
        env: {},
        repoMemories: [
          {
            id: "mem-live-1",
            content: "Use the auth service boundary.",
            context_hint: "auth boundary",
          },
        ],
        memoryRefById: new Map([["mem-live-1", { id: "mem-live-1", path: "d1:mem-live-1" }]]),
        recordTelemetry: telemetry,
      },
    );

    const result = await projection?.executeTool("cycloid__memory_recall", { intent: "Change auth checks" });

    expect(result?.isError).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(
      "memory_recall.requested",
      expect.objectContaining({ requestedMemoryIds: ["mem-live-1"] }),
    );
    expect(telemetry).toHaveBeenCalledWith(
      "memory_recall.returned",
      expect.objectContaining({ requestedMemoryIds: ["mem-live-1"] }),
    );
  });

  it("parses projected Claude MCP tool names back to registry namespace and tool", () => {
    expect(
      parseClaudeFirstPartyDynamicToolName("mcp__cycloid_first_party_dynamic_tools__cloudflare__query_d1"),
    ).toEqual({ namespace: "cloudflare", name: "query_d1" });
    expect(parseClaudeFirstPartyDynamicToolName("cloudflare__query_d1")).toBeNull();
  });
});

describe("ClaudeSessionManager — model switching", () => {
  it("calls setModel only when the model changes, after the first open", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [], agent: "build", agentRole: "implementation", model: "anthropic/claude-opus-4-8" },
      sig("s"),
    );
    expect(fake.optionsByCall[0].model).toBe("claude-opus-4-8");
    expect(fake.setModel).not.toHaveBeenCalled();
    fake.out.push(successResult);
    await drainTurn(s1);

    // Same model → no switch
    const { stream: s2 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [], agent: "build", agentRole: "implementation", model: "anthropic/claude-opus-4-8" },
      sig("s"),
    );
    expect(fake.setModel).not.toHaveBeenCalled();
    fake.out.push(successResult);
    await drainTurn(s2);

    // Different model → switch
    const { stream: s3 } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [], agent: "build", agentRole: "implementation", model: "anthropic/claude-sonnet-4-6" },
      sig("s"),
    );
    expect(fake.setModel).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  it("retries transient setModel failures", async () => {
    vi.useFakeTimers();
    const fake = makeFakeQuery();
    fake.setModel.mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 503 }));
    const mgr = newManager(fake);

    try {
      const { stream: s1 } = mgr.subscribeEvents();
      await mgr.dispatch(
        { parts: [], agent: "build", agentRole: "implementation", model: "anthropic/claude-opus-4-8" },
        sig("s"),
      );
      fake.out.push(successResult);
      await drainTurn(s1);

      mgr.subscribeEvents();
      const dispatchPromise = mgr.dispatch(
        { parts: [], agent: "build", agentRole: "implementation", model: "anthropic/claude-sonnet-4-6" },
        sig("s"),
      );
      await vi.runAllTimersAsync();
      await dispatchPromise;

      expect(fake.setModel).toHaveBeenCalledTimes(2);
      expect(fake.setModel).toHaveBeenNthCalledWith(1, "claude-sonnet-4-6");
      expect(fake.setModel).toHaveBeenNthCalledWith(2, "claude-sonnet-4-6");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unsupported model change without enqueuing the turn", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await expect(
      mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation", model: "openai/gpt-5.5" }, sig("s")),
    ).rejects.toThrow("Unsupported Claude model");
    expect(fake.factory).not.toHaveBeenCalled();
  });
});

describe("ClaudeSessionManager — input-queue edge cases", () => {
  it("retries transient query open failures", async () => {
    vi.useFakeTimers();
    const fake = makeFakeQuery();
    fake.factory.mockImplementationOnce(() => {
      throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    });
    const mgr = newManager(fake);

    try {
      mgr.subscribeEvents();
      const dispatchPromise = mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
      await vi.runAllTimersAsync();
      await dispatchPromise;

      expect(fake.factory).toHaveBeenCalledTimes(2);
      expect(fake.inputs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an overlapping dispatch while query open is retrying", async () => {
    vi.useFakeTimers();
    const fake = makeFakeQuery();
    fake.factory.mockImplementationOnce(() => {
      throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    });
    const mgr = newManager(fake);

    try {
      mgr.subscribeEvents();
      const firstDispatch = mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));

      await Promise.resolve();
      await expect(mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"))).rejects.toThrow(
        "already active",
      );

      await vi.runAllTimersAsync();
      await firstDispatch;
      expect(fake.factory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the original input stream across query open retries", async () => {
    vi.useFakeTimers();
    const fake = makeFakeQuery();
    const prompts = [];
    fake.factory.mockImplementation(({ prompt, options }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      }
      return makeFakeQuery().factory({ prompt, options });
    });
    const mgr = newManager(fake);

    try {
      mgr.subscribeEvents();
      const dispatchResult = mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s")).then(
        () => null,
        (error) => error,
      );

      await Promise.resolve();
      mgr.shutdown();
      await vi.runAllTimersAsync();

      const error = await dispatchResult;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/shutting down|input stream is closed/);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toBe(prompts[0]);
      expect(prompts[1]).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an overlapping dispatch while a turn is active", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));
    await expect(mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"))).rejects.toThrow(
      "already active",
    );
  });

  it("rejects dispatch after shutdown", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    mgr.shutdown();
    await expect(mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"))).rejects.toThrow(
      "shutting down",
    );
  });

  it("does not open a query or enqueue when the signal is already aborted", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    const ac = new AbortController();
    ac.abort();
    await mgr.dispatch(
      { parts: [], agent: "build", agentRole: "implementation" },
      { sessionId: "s", signal: ac.signal },
    );
    // No query opened, nothing enqueued onto the SDK input; the stream is closed.
    expect(fake.factory).not.toHaveBeenCalled();
    expect(fake.inputs).toHaveLength(0);
    expect(stream.isClosed).toBe(true);
  });

  it("leaves a live query alive when a later dispatch is already aborted", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    // First prompt completes and leaves the persistent query alive.
    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("sess"));
    fake.out.push(successResult);
    await drainTurn(s1);

    // A second prompt arrives already aborted: must close only its stream, NOT
    // interrupt the persistent query left alive by the completed first prompt.
    const { stream: s2 } = mgr.subscribeEvents();
    const ac = new AbortController();
    ac.abort();
    await mgr.dispatch(
      { parts: [], agent: "build", agentRole: "implementation" },
      { sessionId: "sess", signal: ac.signal },
    );
    expect(fake.interrupt).not.toHaveBeenCalled();
    expect(fake.inputs).toHaveLength(1); // only the first prompt enqueued
    expect(s2.isClosed).toBe(true);
  });
});

describe("ClaudeSessionManager — mid-session session-id changes", () => {
  it("reopens (pinning the new id) when the bridge swaps the session id mid-life", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("sess-a"));
    fake.out.push(successResult);
    await drainTurn(s1);
    expect(fake.optionsByCall[0].sessionId).toBe("sess-a");

    // Agent-profile switch mints a new id — must reopen on the new id, not reuse
    // the query bound to sess-a, and pin (not resume) the never-seen id.
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "verification", agentRole: "verification" }, sig("sess-b"));
    expect(fake.factory).toHaveBeenCalledTimes(2);
    expect(fake.optionsByCall[1].sessionId).toBe("sess-b");
    expect(fake.optionsByCall[1].resume).toBeUndefined();
    expect(fake.interrupt).toHaveBeenCalled(); // old query torn down
  });

  it("reopens with resume (not a fresh pin) after the generator dies for the same id", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);

    const { stream: s1 } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("sess"));
    expect(fake.optionsByCall[0].resume).toBeUndefined();
    fake.out.close(); // generator dies
    await drainTurn(s1);

    // Same id, on-disk session now exists → reopen with resume.
    mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("sess"));
    expect(fake.factory).toHaveBeenCalledTimes(2);
    expect(fake.optionsByCall[1].resume).toBe("sess");
    expect(fake.optionsByCall[1].sessionId).toBeUndefined();
  });
});

describe("ClaudeSessionManager — failure + lifecycle", () => {
  it("surfaces a generator failure as a terminal error on the active turn", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));

    // Generator dies mid-turn (no result emitted).
    fake.out.close();
    const records = await drainTurn(stream);
    const last = records.at(-1);
    expect(last.type).toBe("result");
    expect(last.is_error).toBe(true);
    expect(String(last.errors[0])).toContain("ended unexpectedly");
  });

  it("abort interrupts the current turn but keeps the query alive; shutdown ends it", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch({ parts: [], agent: "build", agentRole: "implementation" }, sig("s"));

    mgr.abort();
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(fake.returnFn).not.toHaveBeenCalled();
    expect(stream.isClosed).toBe(true);

    mgr.shutdown();
    expect(fake.returnFn).toHaveBeenCalledTimes(1);
  });
});

function sig(sessionId) {
  return { sessionId, signal: new AbortController().signal };
}

describe("AskUserQuestion gate", () => {
  const questionInput = {
    questions: [
      {
        question: "Deploy now?",
        header: "Deploy",
        options: [
          { label: "Yes", description: "ship it" },
          { label: "No", description: "wait" },
        ],
        multiSelect: false,
      },
    ],
  };

  it("holds the gate open until respondToQuestion supplies the answer", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s-q"),
    );

    const canUseTool = fake.optionsByCall[0].canUseTool;
    const gatePromise = canUseTool("AskUserQuestion", questionInput);

    // The synthetic question message reaches the active turn stream.
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.type).toBe("cycloid_question");
    expect(first.value.question).toBe("Deploy now?");
    expect(first.value.options).toEqual(questionInput.questions[0].options);

    expect(mgr.respondToQuestion("Yes", first.value.id)).toBe(true);
    const result = await gatePromise;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Deploy now?": "Yes" });
    // Original input fields are preserved alongside the injected answers.
    expect(result.updatedInput.questions).toEqual(questionInput.questions);
  });

  it("rejects a stale requestId instead of misrouting it to the pending question", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s-q2"),
    );

    const gatePromise = fake.optionsByCall[0].canUseTool("AskUserQuestion", questionInput);
    // A reply that names an unknown id must NOT resolve a different question.
    expect(mgr.respondToQuestion("No", "unknown-request-id")).toBe(false);
    // An id-less reply still falls back to the single pending question.
    expect(mgr.respondToQuestion("No")).toBe(true);
    const result = await gatePromise;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers).toEqual({ "Deploy now?": "No" });
  });

  it("returns false when no question is pending", () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    expect(mgr.respondToQuestion("answer")).toBe(false);
  });

  it("surfaces every question of a multi-question call as a numbered list", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s-q4"),
    );

    const multi = {
      questions: [
        { question: "Which DB?", header: "DB", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
        {
          question: "Which region?",
          header: "Region",
          options: [{ label: "US" }, { label: "EU" }],
          multiSelect: false,
        },
      ],
    };
    const gatePromise = fake.optionsByCall[0].canUseTool("AskUserQuestion", multi);
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.question).toBe("1. Which DB?\n2. Which region?");

    mgr.respondToQuestion("A, US", first.value.id);
    const result = await gatePromise;
    expect(result.updatedInput.answers).toEqual({ "Which DB?": "A, US", "Which region?": "A, US" });
  });

  it("denies immediately when no turn stream is live to surface the question", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    const { stream } = mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s-q5"),
    );
    // Simulate the turn stream having been torn down before the tool call.
    stream.close();

    const result = await fake.optionsByCall[0].canUseTool("AskUserQuestion", questionInput);
    expect(result.behavior).toBe("deny");
    // No orphaned pending question was registered.
    expect(mgr.respondToQuestion("late")).toBe(false);
  });

  it("denies the pending gate when the turn is aborted", async () => {
    const fake = makeFakeQuery();
    const mgr = newManager(fake);
    mgr.subscribeEvents();
    await mgr.dispatch(
      { parts: [{ type: "text", text: "x" }], agent: "build", agentRole: "implementation" },
      sig("s-q3"),
    );

    const gatePromise = fake.optionsByCall[0].canUseTool("AskUserQuestion", questionInput);
    mgr.abort();
    const result = await gatePromise;
    expect(result.behavior).toBe("deny");
    // The reply arrives after the abort: nothing pending to resolve.
    expect(mgr.respondToQuestion("late")).toBe(false);
  });
});
