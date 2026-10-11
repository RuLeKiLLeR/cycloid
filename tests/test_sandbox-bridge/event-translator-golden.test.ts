// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Event-translator trace harness.
//
// Fixtures are intentionally small and synthetic. They target the invariants
// documented in `docs/bridge.md`:
//   - seen/emitted split for incremental Codex parts
//   - per-part text IDs (not shared messageId)
//   - delayed tool-call summary emission (wait for `state.input`)
//   - `execution_complete` finalization semantics
//
// Assertions below cover the event kinds, ordering, canonical phases, bridge
// compatibility payloads, and semantic fields that matter for each scenario.

import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupOutboxDir, isolateOutboxDir, makeAsyncIterator } from "./helpers/event-stream-helpers.ts";
import { createMockedRepoFixture } from "./helpers/repo-fixture.ts";

let repoFixturePath: string;

// ── Mock setup (vi.hoisted so mocks are available before module-level imports) ──

const mocks = vi.hoisted(() => {
  const wsInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    handlers: Record<string, (...args: unknown[]) => void>;
  }> = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 1;
    on = vi.fn();
    send = vi.fn();
    ping = vi.fn();
    close = vi.fn();
    handlers: Record<string, (...args: unknown[]) => void> = {};

    constructor(
      public url: string,
      public options?: Record<string, unknown>,
    ) {
      this.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        this.handlers[event] = handler;
      });
      wsInstances.push(this);
    }
  }

  const mockStream = {
    [Symbol.asyncIterator]: vi.fn(),
    return: vi.fn().mockResolvedValue(undefined),
  };

  const mockClient = {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "codex-session-1" } }),
      get: vi.fn().mockResolvedValue({ data: null }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: mockStream }),
    },
    tool: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      ids: vi.fn().mockResolvedValue({ data: [] }),
    },
    mcp: {
      status: vi.fn().mockResolvedValue({ data: {} }),
    },
  };

  const mockServer = { url: "http://localhost:12345", close: vi.fn() };

  const mockCreateCodex = vi.fn().mockResolvedValue({
    client: mockClient,
    server: mockServer,
  });

  const mockExecFileSync = vi.fn();
  const mockExecFile = vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      (callback as Function)(null, "main\n", "");
    }
    return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
  });
  const createMockEmitter = () => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const emitter = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        (handlers[event] ||= []).push(handler);
        return emitter;
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const nextHandler of handlers[event] ?? []) nextHandler(...args);
      },
    };
    return emitter;
  };
  const mockSpawn = vi.fn(() => {
    const child = Object.assign(createMockEmitter(), {
      stdin: Object.assign(createMockEmitter(), { end: vi.fn() }),
      stdout: createMockEmitter(),
      stderr: createMockEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stderr.emit("data", "mock tar failure");
      child.emit("close", 2);
    });
    return child;
  });

  return {
    MockWebSocket,
    wsInstances,
    mockClient,
    mockServer,
    mockStream,
    mockCreateCodex,
    mockExecFileSync,
    mockExecFile,
    mockSpawn,
  };
});

vi.mock("../../apps/sandbox-bridge/src/services/codex-server.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../apps/sandbox-bridge/src/services/codex-server.ts")>()),
  createCodexWithStdio: mocks.mockCreateCodex,
}));
vi.mock("ws", () => ({ default: mocks.MockWebSocket, WebSocket: mocks.MockWebSocket }));
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("child_process", () => ({
  execFileSync: mocks.mockExecFileSync,
  execFile: mocks.mockExecFile,
  spawn: mocks.mockSpawn,
}));
vi.mock("node:child_process", () => ({
  execFileSync: mocks.mockExecFileSync,
  execFile: mocks.mockExecFile,
  spawn: mocks.mockSpawn,
}));

const { AgentBridge } = await import("../../apps/sandbox-bridge/src/bridge.js");

// ── Helpers ──

function defaultConfig() {
  return {
    repoPath: repoFixturePath,
    sandboxId: "sbx-golden",
    sessionId: "sess-golden",
    controlPlaneUrl: "https://control.example.com",
    authToken: "tok-secret",
    dependencies: {
      refreshAgentGhAuth: vi.fn(async () => ({ ok: true })),
    },
  };
}

function latestWs() {
  return mocks.wsInstances[mocks.wsInstances.length - 1];
}

function openWs(ws = latestWs()) {
  ws.handlers.open?.();
  ws.handlers.message?.(
    Buffer.from(
      JSON.stringify({
        type: "sandbox_session",
        sessionKey: "test-session-key",
        connectionGeneration: 1,
        nextAuthToken: "test-next-auth-token",
      }),
    ),
  );
}

function sendWsMessage(data: Record<string, unknown>, ws = latestWs()) {
  ws.handlers.message?.(Buffer.from(JSON.stringify(data)));
}

function closeWs(ws = latestWs()) {
  ws.handlers.close?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSentEvent(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const payload = isRecord(parsed.payload) ? parsed.payload : null;
  const bridgeData = payload && isRecord(payload.bridgeData) ? payload.bridgeData : null;
  if (!payload || typeof payload.bridgeEventType !== "string") {
    return parsed;
  }
  const canonicalPhase = typeof parsed.phase === "string" ? parsed.phase : undefined;
  return { ...parsed, canonicalPhase, ...(bridgeData ?? {}), type: payload.bridgeEventType };
}

function getSentEvents(ws = latestWs()): Array<Record<string, unknown>> {
  return ws.send.mock.calls
    .map((c: string[]) => decodeSentEvent(c[0]))
    .filter((m: Record<string, unknown>) => m.type !== "heartbeat");
}

/**
 * Capture bridge-emitted events for a given Codex event stream. Drives the
 * bridge through `run()` -> WS open -> prompt -> stream drain -> shutdown.
 *
 * `makeAsyncIterator` auto-annotates the stream to satisfy the ARC-761 role
 * gate by default; tests that exercise the gate explicitly opt out via
 * `{ annotateRole: false }`.
 */
async function captureGoldenTrace(codexEvents: Array<Record<string, unknown>>) {
  mocks.mockClient.event.subscribe.mockResolvedValue({
    stream: makeAsyncIterator(codexEvents),
  });

  const bridge = new AgentBridge(defaultConfig());
  const runPromise = bridge.run();
  await vi.advanceTimersByTimeAsync(0);

  const ws = latestWs();
  openWs(ws);
  sendWsMessage({ type: "prompt", messageId: "msg-golden", content: "Go" });
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10 && !getSentEvents().some((event) => event.type === "post_execution"); i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
  }

  bridge.shutdown();
  closeWs(ws);
  await vi.advanceTimersByTimeAsync(0);
  await runPromise;

  return getSentEvents(ws);
}

const STARTUP_EVENT_TYPES = [
  "runtime_info",
  "prompt_accepted",
  "agent_progress",
  "prompt_activity",
  "prompt_activity",
  "agent_session_created",
  "agent_progress",
  "prompt_activity",
  "prompt_activity",
  "prompt_activity",
  "agent_progress",
  "prompt_activity",
  "prompt_activity",
  "agent_progress",
  "prompt_activity",
  "prompt_activity",
  "agent_progress",
  "agent_prompt_sent",
] as const;

const SUCCESS_TAIL_EVENT_TYPES = [
  "estimated_input_composition",
  "execution_complete",
  "prompt_result",
  "session_idle",
  "push_complete",
  "post_execution",
] as const;

const PROMPT_ACTIVITY_SEQUENCE = [
  { phase: "agent_runtime_initializing", detail: null },
  { phase: "session_creating", detail: null },
  { phase: "event_subscribing", detail: null },
  { phase: "prompt_preparing", detail: "uploads" },
  { phase: "prompt_preparing", detail: "system_context" },
  { phase: "prompt_preparing", detail: "system_context_complete" },
  { phase: "prompt_preparing", detail: "braintrust_context" },
  { phase: "prompt_dispatching", detail: null },
  { phase: "waiting_for_agent_event", detail: null },
] as const;

const AGENT_PROGRESS_SEQUENCE = [
  { step: "starting_agent", label: "Starting agent", terminal: null },
  { step: "connecting_to_runtime", label: "Connecting to runtime", terminal: null },
  { step: "preparing_context", label: "Preparing context", terminal: null },
  { step: "starting_work", label: "Starting work", terminal: null },
  { step: "waiting_for_model", label: "Waiting for model", terminal: null },
] as const;

const THINKING_AGENT_PROGRESS = { step: "thinking", label: "Thinking", terminal: null } as const;

const CANONICAL_PHASE_BY_TYPE: Record<string, string> = {
  agent_progress: "prompt.dispatch",
  agent_timeline: "timeline",
  execution_complete: "prompt.complete",
  agent_prompt_sent: "prompt.dispatch",
  agent_session_created: "agent.session.create",
  estimated_input_composition: "bridge.event",
  final_answer: "text.delta",
  post_execution: "bridge.event",
  prompt_accepted: "prompt.dispatch",
  prompt_activity: "prompt.dispatch",
  prompt_result: "bridge.event",
  push_complete: "git.push",
  runtime_info: "bridge.event",
  session_idle: "idle",
  token: "text.delta",
  tool_call: "tool.call",
  tool_update: "bridge.event",
};

function typeSequence(trace: Array<Record<string, unknown>>): string[] {
  return trace.map((event) => String(event.type)).filter((type) => type !== "agent_timeline");
}

function hasMemoryRankingActivity(trace: Array<Record<string, unknown>>): boolean {
  return eventsOfType(trace, "prompt_activity").some(
    (event) => event.phase === "prompt_preparing" && event.detail === "memories",
  );
}

function startupEventTypes(trace: Array<Record<string, unknown>>): string[] {
  const expected = [...STARTUP_EVENT_TYPES];
  if (hasMemoryRankingActivity(trace)) {
    const insertIndex = expected.findIndex(
      (type, index) => type === "agent_progress" && index > expected.indexOf("agent_session_created"),
    );
    expected.splice(insertIndex, 0, "prompt_activity");
  }
  return expected;
}

function expectTypeSequence(trace: Array<Record<string, unknown>>, middle: string[], tail = SUCCESS_TAIL_EVENT_TYPES) {
  const finalTail =
    eventsOfType(trace, "final_answer").length > 0
      ? ["estimated_input_composition", "final_answer", ...tail.slice(1)]
      : tail;
  const thinkingProgressTypes = hasThinkingProgress(trace) ? ["agent_progress"] : [];
  expect(typeSequence(trace)).toEqual([...startupEventTypes(trace), ...thinkingProgressTypes, ...middle, ...finalTail]);
}

function eventsOfType(trace: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return trace.filter((event) => event.type === type);
}

function onlyEvent(trace: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
  const events = eventsOfType(trace, type);
  expect(events).toHaveLength(1);
  return events[0];
}

function hasThinkingProgress(trace: Array<Record<string, unknown>>): boolean {
  return eventsOfType(trace, "agent_progress").some((event) => event.step === "thinking");
}

function expectCanonicalEnvelopes(trace: Array<Record<string, unknown>>) {
  for (const event of trace) {
    expect(event.sessionId).toBe("sess-golden");
    expect(event.sandboxId).toBe("sbx-golden");
    if (event.type !== "runtime_info") {
      expect(event.promptId).toBe("msg-golden");
    }

    expect(event.canonicalPhase).toBe(CANONICAL_PHASE_BY_TYPE[String(event.type)]);
    expect(event.payload).toMatchObject({
      bridgeData: expect.any(Object),
      bridgeEventType: event.type,
    });
  }
}

function expectPromptActivitySequence(trace: Array<Record<string, unknown>>) {
  const expected = [...PROMPT_ACTIVITY_SEQUENCE];
  if (
    eventsOfType(trace, "prompt_activity").some(
      (event) => event.phase === "prompt_preparing" && event.detail === "workspace_setup_complete",
    )
  ) {
    expected.push({ phase: "prompt_preparing", detail: "workspace_setup_complete" });
  }
  if (hasMemoryRankingActivity(trace)) {
    expected.splice(4, 0, { phase: "prompt_preparing", detail: "memories" });
  }
  expect(
    eventsOfType(trace, "prompt_activity").map((event) => ({
      phase: event.phase,
      detail: event.detail ?? null,
    })),
  ).toEqual(expected);
}

function expectAgentProgressSequence(trace: Array<Record<string, unknown>>) {
  const expected = hasThinkingProgress(trace)
    ? [...AGENT_PROGRESS_SEQUENCE, THINKING_AGENT_PROGRESS]
    : AGENT_PROGRESS_SEQUENCE;
  expect(
    eventsOfType(trace, "agent_progress").map((event) => ({
      step: event.step,
      label: event.label,
      terminal: event.terminal ?? null,
    })),
  ).toEqual(expected);
}

function expectSuccessfulTail(trace: Array<Record<string, unknown>>) {
  for (const finalAnswer of eventsOfType(trace, "final_answer")) {
    expect(finalAnswer).toMatchObject({
      ackId: expect.any(String),
      messageId: "msg-golden",
      payload: {
        bridgeEventType: "final_answer",
        channel: "output",
      },
    });
  }

  const complete = onlyEvent(trace, "execution_complete");
  expect(complete).toMatchObject({
    idleObserved: true,
    messageId: "msg-golden",
    sessionEditCount: 0,
    sessionPromptCount: 1,
    success: true,
    payload: {
      bridgeData: {
        idleObserved: true,
        messageId: "msg-golden",
        sessionEditCount: 0,
        sessionPromptCount: 1,
        success: true,
      },
      bridgeEventType: "execution_complete",
      success: true,
    },
  });
  expect(complete.ackId).toEqual(expect.any(String));

  expect(onlyEvent(trace, "prompt_result")).toMatchObject({
    messageId: "msg-golden",
    payload: {
      bridgeData: { messageId: "msg-golden" },
      bridgeEventType: "prompt_result",
    },
  });
  expect(onlyEvent(trace, "session_idle")).toMatchObject({
    messageId: "msg-golden",
    sessionEditCount: 0,
    sessionPromptCount: 1,
    payload: {
      bridgeData: {
        messageId: "msg-golden",
        sessionEditCount: 0,
        sessionPromptCount: 1,
      },
      bridgeEventType: "session_idle",
    },
  });
  expect(onlyEvent(trace, "push_complete")).toMatchObject({
    ackId: expect.any(String),
    branchName: "main",
    messageId: "msg-golden",
    payload: {
      branch: "main",
      bridgeData: {
        branchName: "main",
        messageId: "msg-golden",
      },
      bridgeEventType: "push_complete",
      success: true,
    },
  });
  expect(onlyEvent(trace, "post_execution")).toMatchObject({
    ackId: expect.any(String),
    branch: "main",
    commitSha: "main",
    hasChanges: true,
    messageId: "msg-golden",
    payload: {
      bridgeData: {
        branch: "main",
        commitSha: "main",
        hasChanges: true,
        messageId: "msg-golden",
      },
      bridgeEventType: "post_execution",
    },
  });
}

function expectTextToken(event: Record<string, unknown>, content: string, partId: string) {
  expect(event).toMatchObject({
    content,
    messageId: "msg-golden",
    partId,
    payload: {
      bridgeData: {
        content,
        messageId: "msg-golden",
        partId,
      },
      bridgeEventType: "token",
      channel: "output",
      partId,
      text: content,
    },
  });
}

// ── Tests ──

let workspaceSetupMarkerDir: string | null = null;
let originalWorkspaceSetupPendingPath: string | undefined;
let originalWorkspaceSetupReadyPath: string | undefined;
let originalRealGitPath: string | undefined;

let goldenOutboxDir: string | undefined;

beforeEach(() => {
  mocks.wsInstances.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
  goldenOutboxDir = isolateOutboxDir();
  repoFixturePath = createMockedRepoFixture();

  originalWorkspaceSetupPendingPath = process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH;
  originalWorkspaceSetupReadyPath = process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
  originalRealGitPath = process.env.ARCANIST_REAL_GIT_PATH;
  workspaceSetupMarkerDir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-golden-workspace-setup-")));
  process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH = join(workspaceSetupMarkerDir, "pending");
  process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH = join(workspaceSetupMarkerDir, "ready");
  process.env.ARCANIST_REAL_GIT_PATH = "git";

  mocks.mockClient.session.create.mockResolvedValue({ data: { id: "codex-session-1" } });
  mocks.mockClient.session.promptAsync.mockResolvedValue(undefined);
  mocks.mockClient.session.abort.mockResolvedValue(undefined);
  mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator([]) });
  mocks.mockExecFileSync.mockImplementation((command: string, args: string[] = []) => {
    if (command === "git" && args.includes("--is-inside-work-tree")) return "true\n";
    return "main\n";
  });

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, token: "ghs_mock_token" }), { status: 200 }),
  );
});

afterEach(() => {
  rmSync(repoFixturePath, { recursive: true, force: true });
  cleanupOutboxDir(goldenOutboxDir);
  goldenOutboxDir = undefined;
  if (originalWorkspaceSetupPendingPath === undefined) {
    delete process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH;
  } else {
    process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH = originalWorkspaceSetupPendingPath;
  }
  if (originalWorkspaceSetupReadyPath === undefined) {
    delete process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
  } else {
    process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH = originalWorkspaceSetupReadyPath;
  }
  if (originalRealGitPath === undefined) {
    delete process.env.ARCANIST_REAL_GIT_PATH;
  } else {
    process.env.ARCANIST_REAL_GIT_PATH = originalRealGitPath;
  }
  originalWorkspaceSetupPendingPath = undefined;
  originalWorkspaceSetupReadyPath = undefined;
  originalRealGitPath = undefined;

  if (workspaceSetupMarkerDir) {
    rmSync(workspaceSetupMarkerDir, { recursive: true, force: true });
    workspaceSetupMarkerDir = null;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("event translator golden trace", () => {
  it("text-only completion emits token then execution_complete", async () => {
    const trace = await captureGoldenTrace([
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Hello" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    expectTypeSequence(trace, ["token"]);
    expectCanonicalEnvelopes(trace);
    expectPromptActivitySequence(trace);
    expectAgentProgressSequence(trace);
    expectTextToken(onlyEvent(trace, "token"), "Hello", "part-1");
    expect(onlyEvent(trace, "final_answer")).toMatchObject({
      content: "Hello",
      partId: "msg-golden:final_answer",
      payload: {
        text: "Hello",
        partId: "msg-golden:final_answer",
      },
    });
    expectSuccessfulTail(trace);
  });

  it("tool call with late state.input defers summary until input populates", async () => {
    const trace = await captureGoldenTrace([
      // Tool part first arrives without state.input — bridge must not emit a
      // summary yet (would produce bare tool name).
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { status: "running" },
          },
        },
      },
      // Input populates — summary should now emit with useful details.
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: {
              status: "running",
              input: { filePath: "/src/foo.ts" },
            },
          },
        },
      },
      // Tool completes.
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/src/foo.ts" },
              output: "file contents",
            },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    expectTypeSequence(trace, ["tool_call", "tool_update"]);
    expectCanonicalEnvelopes(trace);
    expectPromptActivitySequence(trace);
    expectAgentProgressSequence(trace);

    expect(onlyEvent(trace, "tool_call")).toMatchObject({
      args: { filePath: "/src/foo.ts" },
      callId: "part-tool-1",
      inputEstimatedTokens: 7,
      messageId: "msg-golden",
      summary: "read /src/foo.ts",
      tool: "read",
      payload: {
        args: { filePath: "/src/foo.ts" },
        bridgeData: {
          args: { filePath: "/src/foo.ts" },
          callId: "part-tool-1",
          inputEstimatedTokens: 7,
          messageId: "msg-golden",
          summary: "read /src/foo.ts",
          tool: "read",
        },
        bridgeEventType: "tool_call",
        callId: "part-tool-1",
        summary: "read /src/foo.ts",
        tool: "read",
      },
    });

    expect(onlyEvent(trace, "tool_update")).toMatchObject({
      callId: "part-tool-1",
      messageId: "msg-golden",
      outputChars: 13,
      outputEstimatedTokens: 4,
      status: "completed",
      tool: "read",
      payload: {
        bridgeData: {
          callId: "part-tool-1",
          messageId: "msg-golden",
          outputChars: 13,
          outputEstimatedTokens: 4,
          status: "completed",
          tool: "read",
        },
        bridgeEventType: "tool_update",
      },
    });
    expectSuccessfulTail(trace);
  });

  it("text → tool → text preserves distinct part IDs across the tool call", async () => {
    const trace = await captureGoldenTrace([
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-text-1", type: "text", sessionID: "codex-session-1", text: "Before" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "grep",
            state: { status: "completed", input: { pattern: "foo" }, output: "match" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-text-2", type: "text", sessionID: "codex-session-1", text: "After" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    expectTypeSequence(trace, ["token", "tool_call", "token"]);
    expectCanonicalEnvelopes(trace);
    expectPromptActivitySequence(trace);
    expectAgentProgressSequence(trace);

    const tokens = eventsOfType(trace, "token");
    expect(tokens).toHaveLength(2);
    expectTextToken(tokens[0], "Before", "part-text-1");
    expectTextToken(tokens[1], "After", "part-text-2");
    expect(onlyEvent(trace, "final_answer")).toMatchObject({
      content: "After",
      partId: "msg-golden:final_answer",
      payload: {
        text: "After",
        partId: "msg-golden:final_answer",
      },
    });
    expect(onlyEvent(trace, "tool_call")).toMatchObject({
      args: { pattern: "foo" },
      callId: "part-tool-1",
      inputEstimatedTokens: 5,
      messageId: "msg-golden",
      status: "completed",
      tool: "grep",
      payload: {
        args: { pattern: "foo" },
        bridgeData: {
          args: { pattern: "foo" },
          callId: "part-tool-1",
          inputEstimatedTokens: 5,
          messageId: "msg-golden",
          status: "completed",
          tool: "grep",
        },
        bridgeEventType: "tool_call",
        callId: "part-tool-1",
        tool: "grep",
      },
    });
    expectSuccessfulTail(trace);
  });

  it("promptAsync rejection surfaces execution_complete with success=false", async () => {
    const streamReturn = vi.fn().mockResolvedValue(undefined);
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
          return: streamReturn,
        };
      },
      return: streamReturn,
    };
    mocks.mockClient.session.promptAsync.mockRejectedValue(new Error("dispatch failed"));
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-golden", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const trace = getSentEvents(ws);
    expect(typeSequence(trace)).toEqual([
      ...startupEventTypes(trace).filter((type) => type !== "agent_prompt_sent"),
      "execution_complete",
      "post_execution",
    ]);
    expectCanonicalEnvelopes(trace);
    expectPromptActivitySequence(trace);
    expectAgentProgressSequence(trace);

    const complete = onlyEvent(trace, "execution_complete");
    expect(complete).toMatchObject({
      error: "dispatch failed",
      errorCode: "unknown",
      errorDetails: {
        message: "dispatch failed",
        name: "Error",
      },
      idleObserved: false,
      messageId: "msg-golden",
      sessionEditCount: 0,
      sessionPromptCount: 1,
      success: false,
      payload: {
        bridgeData: {
          error: "dispatch failed",
          errorCode: "unknown",
          errorDetails: {
            message: "dispatch failed",
            name: "Error",
          },
          idleObserved: false,
          messageId: "msg-golden",
          sessionEditCount: 0,
          sessionPromptCount: 1,
          success: false,
        },
        bridgeEventType: "execution_complete",
        error: "dispatch failed",
        errorCode: "unknown",
        errorDetails: {
          message: "dispatch failed",
          name: "Error",
        },
        success: false,
      },
    });
    expect(complete.ackId).toEqual(expect.any(String));
    expect(eventsOfType(trace, "prompt_result")).toHaveLength(0);
    expect(eventsOfType(trace, "session_idle")).toHaveLength(0);
    expect(eventsOfType(trace, "push_complete")).toHaveLength(0);
  });

  it("idle completion stops the prompt before later stream events", async () => {
    const trace = await captureGoldenTrace([
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Fresh" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    expectTypeSequence(trace, []);
    expectCanonicalEnvelopes(trace);
    expectPromptActivitySequence(trace);
    expectAgentProgressSequence(trace);
    expect(eventsOfType(trace, "token")).toHaveLength(0);
    expectSuccessfulTail(trace);
  });
});
