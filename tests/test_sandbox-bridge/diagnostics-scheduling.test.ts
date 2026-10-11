// @ts-nocheck -- sandbox-bridge is excluded from root tsconfig
//
// Guards that edit-tool completion no longer schedules hardcoded post-edit
// diagnostics. Repository validation is driven by configured verify commands.

import { rmSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAsyncIterator } from "./helpers/event-stream-helpers.ts";
import { createMockedRepoFixture } from "./helpers/repo-fixture.ts";

let repoFixturePath: string;

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

  const mockClient = {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "codex-session-1" } }),
      get: vi.fn().mockResolvedValue({ data: null }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    },
    event: {
      subscribe: vi.fn(),
    },
    tool: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      ids: vi.fn().mockResolvedValue({ data: [] }),
    },
    mcp: {
      status: vi.fn().mockResolvedValue({ data: {} }),
    },
  };

  const mockServer = {
    url: "http://localhost:12345",
    close: vi.fn(),
  };

  const mockCreateCodex = vi.fn().mockResolvedValue({
    client: mockClient,
    server: mockServer,
  });

  const mockExecFileSync = vi.fn();
  const mockExecFile = vi.fn((...args: unknown[]) => {
    const command = args[0];
    const commandArgs = args[1];
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      if (
        command === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs[0] === "rev-parse" &&
        commandArgs[1] === "--git-path" &&
        commandArgs[2] === "hooks/pre-commit"
      ) {
        (callback as Function)(null, ".git/hooks/pre-commit\n", "");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
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

const { AgentBridge } = await import("../../apps/sandbox-bridge/src/bridge.js");

function defaultConfig() {
  return {
    repoPath: repoFixturePath,
    sandboxId: "sbx-1",
    sessionId: "sess-1",
    controlPlaneUrl: "https://control.example.com",
    authToken: "tok-secret",
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
  return { ...parsed, ...(bridgeData ?? {}), type: payload.bridgeEventType };
}

function getSentEvents(ws = latestWs()): Array<Record<string, unknown>> {
  return ws.send.mock.calls
    .map((c: string[]) => decodeSentEvent(c[0]))
    .filter((m: Record<string, unknown>) => m.type !== "heartbeat");
}

function applyPatchEvents() {
  const part = {
    id: "tool-1",
    type: "tool",
    tool: "apply_patch",
    sessionID: "codex-session-1",
  };
  return [
    {
      type: "message.part.updated",
      properties: {
        part: { ...part, state: { status: "running", input: { patch: "*** Begin Patch" } } },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { ...part, state: { status: "completed", input: { patch: "*** Begin Patch" }, output: "ok" } },
      },
    },
    { type: "session.idle", properties: { sessionID: "codex-session-1" } },
  ];
}

beforeEach(() => {
  mocks.wsInstances.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
  repoFixturePath = createMockedRepoFixture();

  mocks.mockClient.session.create.mockResolvedValue({ data: { id: "codex-session-1" } });
  mocks.mockClient.session.promptAsync.mockResolvedValue(undefined);
  mocks.mockClient.session.abort.mockResolvedValue(undefined);
  mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator([]) });
  mocks.mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    const gitArgs = args[0] === "-C" ? args.slice(2) : args;
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") return "true\n";
    return "main\n";
  });

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, token: "ghs_mock_token" }), { status: 200 }),
  );
});

afterEach(() => {
  rmSync(repoFixturePath, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("post-edit diagnostics scheduling", () => {
  it("does not record pending diagnostics after edit tools complete", async () => {
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator(applyPatchEvents()),
    });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getSentEvents(ws).some((m) => m.type === "diagnostics")).toBe(false);
    expect(bridge.pendingDiagnostics).toHaveLength(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("feeds manually recorded diagnostics into the next prompt's system context and clears them", () => {
    const bridge = new AgentBridge(defaultConfig());
    bridge.pendingDiagnostics = [{ file: "src/foo.ts", severity: "error", message: "boom", line: 1, column: 1 }];

    const built = bridge.buildMeasuredSystemContext();
    const reminder = built.sections.find((s) => s.name === "diagnostics_reminder");

    expect(reminder).toBeDefined();
    expect(reminder.content).toContain("Fix these errors before continuing");
    expect(bridge.pendingDiagnostics).toHaveLength(0);
  });
});
