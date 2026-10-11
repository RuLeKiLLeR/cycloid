// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { rmSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupOutboxDir, isolateOutboxDir, makeAsyncIterator } from "./helpers/event-stream-helpers.ts";
import { createMockedRepoFixture } from "./helpers/repo-fixture.ts";

let outboxDir: string | undefined;
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
    question: {
      reply: vi.fn().mockResolvedValue({ data: { ok: true } }),
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

const { AgentBridge } = await import("../../apps/sandbox-bridge/src/bridge.js");

// ── Helpers ──

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

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type BridgeInternals = {
  hasSentPromptInCurrentSession: boolean;
  uploadedContentTracker: {
    commitSeen: (...args: unknown[]) => unknown;
  };
};

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

  return {
    ...parsed,
    ...(bridgeData ?? {}),
    type: payload.bridgeEventType,
  };
}

/** Extract sent events from mock WS, filtering out heartbeats */
function getSentEvents(ws = latestWs()): Array<Record<string, unknown>> {
  return ws.send.mock.calls
    .map((c: string[]) => decodeSentEvent(c[0]))
    .filter((m: Record<string, unknown>) => m.type !== "heartbeat");
}

// ── Tests ──

beforeEach(() => {
  mocks.wsInstances.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
  outboxDir = isolateOutboxDir();
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
  delete process.env.ARCANIST_TEST_DISPATCH_DELAY_MS;
  rmSync(repoFixturePath, { recursive: true, force: true });
  cleanupOutboxDir(outboxDir);
  outboxDir = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bridge event emission order", () => {
  it("forwards token events before promptAsync resolves", async () => {
    const promptDispatch = deferredPromise<void>();
    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([
        {
          type: "message.part.updated",
          properties: {
            part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Hello" },
          },
        },
        { type: "session.idle", properties: { sessionID: "codex-session-1" } },
      ]),
    });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sentBeforeResolve = getSentEvents(ws);
    const token = sentBeforeResolve.find((m) => m.type === "token");
    expect(token).toBeDefined();
    expect(token?.content).toBe("Hello");
    expect(sentBeforeResolve.some((m) => m.type === "execution_complete")).toBe(false);

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(true);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("waits for promptAsync before failing when the stream ends before prompt start", async () => {
    const promptDispatch = deferredPromise<void>();
    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator([]) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(getSentEvents(ws).some((m) => m.type === "execution_complete")).toBe(false);

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(complete?.error).toContain("Agent runtime event stream ended before prompt start");
    expect(complete?.idleObserved).toBe(false);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits prompt activity while waiting for Codex events", async () => {
    const delayedIdleEvent = deferredPromise<IteratorResult<unknown>>();
    const streamReturn = vi.fn().mockResolvedValue(undefined);
    const stream = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          next() {
            if (step === 0) {
              step++;
              return Promise.resolve({
                value: {
                  type: "message.part.updated",
                  properties: {
                    part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Starting" },
                  },
                },
                done: false,
              });
            }
            if (step === 1) {
              step++;
              return delayedIdleEvent.promise;
            }
            return Promise.resolve({ value: undefined, done: true });
          },
          return: streamReturn,
        };
      },
      return: streamReturn,
    };

    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const initialActivity = getSentEvents(ws).filter(
      (m) => m.type === "prompt_activity" && m.phase === "waiting_for_agent_event",
    );
    expect(initialActivity).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);

    const pulsedActivity = getSentEvents(ws).filter(
      (m) => m.type === "prompt_activity" && m.phase === "waiting_for_agent_event",
    );
    expect(pulsedActivity.length).toBeGreaterThanOrEqual(2);
    expect(pulsedActivity.at(-1)).toMatchObject({
      type: "prompt_activity",
      promptId: "msg-1",
      phase: "waiting_for_agent_event",
      sandboxId: "sbx-1",
    });

    delayedIdleEvent.resolve({
      value: { type: "session.idle", properties: { sessionID: "codex-session-1" } },
      done: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(true);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("ignores stale idle before the current prompt starts", async () => {
    const promptDispatch = deferredPromise<void>();
    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([
        { type: "session.idle", properties: { sessionID: "codex-session-1" } },
        {
          type: "message.part.updated",
          properties: {
            part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Fresh output" },
          },
        },
        { type: "session.idle", properties: { sessionID: "codex-session-1" } },
      ]),
    });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sentBeforeResolve = getSentEvents(ws);
    expect(sentBeforeResolve.some((m) => m.type === "execution_complete")).toBe(false);
    expect(sentBeforeResolve.find((m) => m.type === "token")?.content).toBe("Fresh output");

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(true);
    expect(complete?.idleObserved).toBe(true);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("fails cleanly and closes the stream when promptAsync rejects", async () => {
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
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(String(complete?.error)).toContain("dispatch failed");
    expect(streamReturn).toHaveBeenCalled();

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("fails cleanly when a selected skill is missing before subscribing to Codex events", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go", skills: ["definitely-missing-skill"] });
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(String(complete?.error)).toContain("Selected skill not found: definitely-missing-skill");
    expect(mocks.mockClient.event.subscribe).not.toHaveBeenCalled();

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("does not abandon the first pending event when prompt dispatch wins the race", async () => {
    const firstNext = deferredPromise<IteratorResult<unknown>>();
    let nextCallCount = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCallCount += 1;
            if (nextCallCount === 1) return firstNext.promise;
            if (nextCallCount === 2) {
              return Promise.resolve({
                done: false,
                value: {
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: "part-1",
                      messageID: "msg-assistant",
                      type: "text",
                      sessionID: "codex-session-1",
                      text: "Hello",
                    },
                  },
                },
              });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
      return: vi.fn().mockResolvedValue(undefined),
    };
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(nextCallCount).toBe(1);

    firstNext.resolve({
      done: false,
      value: {
        type: "message.updated",
        properties: { info: { id: "msg-assistant", sessionID: "codex-session-1", role: "assistant" } },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const token = getSentEvents(ws).find((m) => m.type === "token");
    expect(token).toBeDefined();
    expect(token?.content).toBe("Hello");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("ignores stale idle from a retained pre-dispatch read after prompt dispatch wins", async () => {
    const promptDispatch = deferredPromise<void>();
    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    const firstNext = deferredPromise<IteratorResult<unknown>>();
    let nextCallCount = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCallCount += 1;
            if (nextCallCount === 1) return firstNext.promise;
            if (nextCallCount === 2) {
              return Promise.resolve({
                done: false,
                value: {
                  type: "message.updated",
                  properties: { info: { id: "msg-assistant", sessionID: "codex-session-1", role: "assistant" } },
                },
              });
            }
            if (nextCallCount === 3) {
              return Promise.resolve({
                done: false,
                value: {
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: "part-1",
                      messageID: "msg-assistant",
                      type: "text",
                      sessionID: "codex-session-1",
                      text: "Fresh output",
                    },
                  },
                },
              });
            }
            return Promise.resolve({
              done: false,
              value: { type: "session.idle", properties: { sessionID: "codex-session-1" } },
            });
          },
        };
      },
      return: vi.fn().mockResolvedValue(undefined),
    };
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(nextCallCount).toBe(1);

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);

    firstNext.resolve({
      done: false,
      value: { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    });
    await vi.advanceTimersByTimeAsync(0);

    const sentEvents = getSentEvents(ws);
    const tokenIndex = sentEvents.findIndex((m) => m.type === "token");
    const completeIndex = sentEvents.findIndex((m) => m.type === "execution_complete");
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(sentEvents[tokenIndex]?.content).toBe("Fresh output");
    expect(completeIndex).toBeGreaterThan(tokenIndex);
    expect(sentEvents[completeIndex]?.success).toBe(true);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("fails when a retained pre-dispatch idle is followed by stream end before prompt start", async () => {
    const promptDispatch = deferredPromise<void>();
    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    const firstNext = deferredPromise<IteratorResult<unknown>>();
    let nextCallCount = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCallCount += 1;
            if (nextCallCount === 1) return firstNext.promise;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
      return: vi.fn().mockResolvedValue(undefined),
    };
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(nextCallCount).toBe(1);

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);

    firstNext.resolve({
      done: false,
      value: { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    });
    await vi.advanceTimersByTimeAsync(0);

    const sentEvents = getSentEvents(ws);
    const complete = sentEvents.find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(complete?.error).toContain("Agent runtime event stream ended before prompt start");
    expect(complete?.idleObserved).toBe(false);
    expect(sentEvents.some((m) => m.type === "session_idle")).toBe(false);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("does not start the prompt start timeout until dispatch reaches Codex", async () => {
    process.env.ARCANIST_TEST_DISPATCH_DELAY_MS = "100000";
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

    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });

    await vi.advanceTimersByTimeAsync(99_000);
    expect(mocks.mockClient.session.promptAsync).not.toHaveBeenCalled();
    expect(getSentEvents(ws).find((m) => m.type === "execution_complete")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(String(complete?.error)).toContain("Prompt start timed out");
    expect(mocks.mockClient.session.abort).toHaveBeenCalledTimes(1);
    expect(mocks.mockClient.session.abort).toHaveBeenCalledWith({ path: { id: "codex-session-1" } });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("times out after prompt dispatch resolves without any Codex events", async () => {
    const promptDispatch = deferredPromise<void>();
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

    mocks.mockClient.session.promptAsync.mockReturnValue(promptDispatch.promise);
    mocks.mockClient.session.abort.mockRejectedValueOnce(new Error("abort unavailable"));
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const bridgeInternals = bridge as unknown as BridgeInternals;
    const commitSeenSpy = vi.spyOn(bridgeInternals.uploadedContentTracker, "commitSeen");
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getSentEvents(ws).find((m) => m.type === "execution_complete")).toBeUndefined();

    promptDispatch.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(String(complete?.error)).toContain("Prompt start timed out");
    expect(String(complete?.error)).not.toContain("abort unavailable");
    expect(mocks.mockClient.session.abort).toHaveBeenCalledTimes(1);
    expect(mocks.mockClient.session.abort).toHaveBeenCalledWith({ path: { id: "codex-session-1" } });

    expect(commitSeenSpy).toHaveBeenCalledTimes(1);
    expect(bridgeInternals.hasSentPromptInCurrentSession).toBe(true);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("resets the prompt start timeout after a retry dispatch", async () => {
    const retryIdleEvent = deferredPromise<IteratorResult<unknown>>();
    const streamReturn = vi.fn().mockResolvedValue(undefined);
    const stream = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          next() {
            if (step === 0) {
              step++;
              return Promise.resolve({
                value: {
                  type: "session.error",
                  properties: {
                    sessionID: "codex-session-1",
                    error: { data: { message: "503 Service Unavailable" } },
                  },
                },
                done: false,
              });
            }
            if (step === 1) {
              step++;
              return retryIdleEvent.promise;
            }
            return Promise.resolve({ value: undefined, done: true });
          },
          return: streamReturn,
        };
      },
      return: streamReturn,
    };

    vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.mockClient.session.promptAsync.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(getSentEvents(ws).find((m) => m.type === "retry_status")).toBeDefined();

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(getSentEvents(ws).some((m) => m.type === "execution_complete")).toBe(false);

    retryIdleEvent.resolve({
      value: { type: "session.idle", properties: { sessionID: "codex-session-1" } },
      done: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(true);
    expect(complete?.idleObserved).toBe(true);
    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(2);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("does not deadlock when stopped while waiting on a question", async () => {
    const streamReturn = vi.fn().mockResolvedValue(undefined);
    const stream = {
      [Symbol.asyncIterator]() {
        let emittedQuestion = false;
        return {
          async next() {
            if (!emittedQuestion) {
              emittedQuestion = true;
              return {
                value: {
                  type: "question.asked",
                  properties: {
                    id: "que_1",
                    sessionID: "codex-session-1",
                    questions: [{ question: "Proceed?", header: "Proceed", options: [] }],
                  },
                },
                done: false,
              };
            }
            return new Promise<IteratorResult<unknown>>(() => {});
          },
          return: streamReturn,
        };
      },
      return: streamReturn,
    };

    mocks.mockClient.event.subscribe.mockResolvedValue({ stream });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    expect(getSentEvents(ws).find((m) => m.type === "question")).toBeDefined();

    sendWsMessage({ type: "stop" });
    await vi.advanceTimersByTimeAsync(0);

    const complete = getSentEvents(ws).find((m) => m.type === "execution_complete");
    expect(complete).toBeDefined();
    expect(complete?.success).toBe(false);
    expect(complete?.errorCode).toBe("aborted");
    expect(streamReturn).toHaveBeenCalled();

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits text tokens in order for a streaming response", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Hello" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Hello world" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", type: "text", sessionID: "codex-session-1", text: "Hello world!" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const tokens = getSentEvents(ws).filter((m) => m.type === "token");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].content).toBe("Hello");
    expect(tokens[1].content).toBe(" world");
    expect(tokens[2].content).toBe("!");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits tool_call only after input is available", async () => {
    const events = [
      // First update: tool part without input
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: {}, status: "running" },
          },
        },
      },
      // Second update: tool part with input populated
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "running" },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const toolCalls = getSentEvents(ws).filter((m) => m.type === "tool_call");
    // Only 1 tool_call emitted (after input populated)
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].args).toEqual({ filePath: "/src/foo.ts" });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits immediate-input tool_call with status and startedAt but no summary", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "running" },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const toolCalls = getSentEvents(ws).filter((m) => m.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      tool: "read",
      args: { filePath: "/src/foo.ts" },
      status: "running",
    });
    expect(toolCalls[0].startedAt).toEqual(expect.any(Number));
    expect(toolCalls[0]).not.toHaveProperty("summary");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits deferred-input tool_call once, with summary and without immediate-only fields", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: {}, status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "completed", output: "file content" },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sent = getSentEvents(ws);
    const toolCalls = sent.filter((m) => m.type === "tool_call");
    const toolUpdates = sent.filter((m) => m.type === "tool_update");

    expect(toolCalls).toHaveLength(1);
    expect(toolUpdates).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      tool: "read",
      args: { filePath: "/src/foo.ts" },
      summary: "read /src/foo.ts",
    });
    expect(toolCalls[0]).not.toHaveProperty("status");
    expect(toolCalls[0]).not.toHaveProperty("startedAt");

    const toolCallIdx = sent.findIndex((m) => m.type === "tool_call");
    const toolUpdateIdx = sent.findIndex((m) => m.type === "tool_update");
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(toolUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallIdx).toBeLessThan(toolUpdateIdx);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits tool_call before tool_update for a completed tool", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/src/foo.ts" }, status: "completed", output: "file content" },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sent = getSentEvents(ws);
    const toolCallIdx = sent.findIndex((m) => m.type === "tool_call");
    const toolUpdateIdx = sent.findIndex((m) => m.type === "tool_update");

    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(toolUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallIdx).toBeLessThan(toolUpdateIdx);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("text before tool call, text after tool call have different partIds", async () => {
    const events = [
      // Text part A
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-A", type: "text", sessionID: "codex-session-1", text: "Before" },
        },
      },
      // Tool call
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "bash",
            state: { input: { command: "ls" }, status: "running" },
          },
        },
      },
      // Text part B (different part ID)
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-B", type: "text", sessionID: "codex-session-1", text: "After" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sent = getSentEvents(ws);
    const tokens = sent.filter((m) => m.type === "token");
    const toolCalls = sent.filter((m) => m.type === "tool_call");

    expect(tokens).toHaveLength(2);
    expect(tokens[0].partId).toBe("part-A");
    expect(tokens[1].partId).toBe("part-B");
    expect(toolCalls).toHaveLength(1);

    // Token(A) comes before tool_call, Token(B) comes after
    const tokenAIdx = sent.findIndex((m) => m.type === "token" && m.partId === "part-A");
    const toolCallIdx = sent.findIndex((m) => m.type === "tool_call");
    const tokenBIdx = sent.findIndex((m) => m.type === "token" && m.partId === "part-B");
    expect(tokenAIdx).toBeLessThan(toolCallIdx);
    expect(toolCallIdx).toBeLessThan(tokenBIdx);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("does not emit removed step events around tool calls", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: { type: "step-start", sessionID: "codex-session-1" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: "codex-session-1",
            tool: "read",
            state: { input: { filePath: "/test.ts" }, status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID: "codex-session-1" },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ];
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator(events) });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    const sent = getSentEvents(ws);
    const toolCallIdx = sent.findIndex((m) => m.type === "tool_call");

    expect(sent.some((m) => m.type === "step_start")).toBe(false);
    expect(sent.some((m) => m.type === "step_finish")).toBe(false);
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("question event emitted when question.asked received", async () => {
    const events = [
      {
        type: "question.asked",
        properties: {
          id: "q-1",
          sessionID: "codex-session-1",
          questions: [{ question: "Should I proceed?" }],
        },
      },
      // session.idle after question is answered (won't be reached until we respond)
    ];

    // Build an async iterator that yields the question, then waits for answer,
    // then yields session.idle
    let resolveIdle: () => void;
    const idlePromise = new Promise<void>((r) => {
      resolveIdle = r;
    });
    const customIterator = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < events.length) {
              return { value: events[index++], done: false };
            }
            // Wait for idle signal then yield session.idle
            await idlePromise;
            return { value: { type: "session.idle", properties: { sessionID: "codex-session-1" } }, done: false };
          },
        };
      },
      return: vi.fn().mockResolvedValue(undefined),
    };
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: customIterator });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);

    // Question event should have been emitted
    const sent = getSentEvents(ws);
    const questions = sent.filter((m) => m.type === "question");
    expect(questions).toHaveLength(1);
    expect(questions[0].questionId).toBe("q-1");
    expect(questions[0].question).toBe("Should I proceed?");

    // Answer the question so the event loop can continue
    sendWsMessage({ type: "respond", answer: "yes" });
    resolveIdle!();
    await vi.advanceTimersByTimeAsync(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// Token / compaction / context-fill emission off the parent message.updated
// stream. These guard the token-budget orchestration block in the prompt event
// loop (the part that wraps TokenBudgetTracker.recordMessageUpdate and turns its
// result into usage / compaction_start / compaction_complete / context_fill_warning
// events).
describe("bridge token and compaction emission", () => {
  async function driveStream(events: Array<Record<string, unknown>>) {
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator(events),
    });
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Go" });
    await vi.advanceTimersByTimeAsync(0);
    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
    // Snapshot after the run settles so any completion-phase events are included
    // rather than silently dropped by an early capture.
    return getSentEvents(ws);
  }

  it("emits a usage event for an assistant token update", async () => {
    const sent = await driveStream([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "asst-1",
            sessionID: "codex-session-1",
            role: "assistant",
            modelID: "gpt-5.5",
            tokens: { input: 100, output: 50 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    const usage = sent.find((m) => m.type === "usage");
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(50);
    expect(usage?.model).toBe("gpt-5.5");
    expect(usage?.contextWindow).toBe(1_000_000);
  });

  it("emits compaction_start then compaction_complete for a compaction message", async () => {
    const sent = await driveStream([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "cmp-1",
            sessionID: "codex-session-1",
            role: "assistant",
            agent: "compaction",
            modelID: "gpt-5.5",
            tokens: { input: 1000, output: 0 },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "cmp-1",
            sessionID: "codex-session-1",
            role: "assistant",
            agent: "compaction",
            modelID: "gpt-5.5",
            // Post-compaction input drops to 300 (contextUsed = input + cacheRead
            // + cacheWrite, output excluded), so contextTokensAfter must reflect
            // the reduced context rather than copying contextTokensBefore.
            tokens: { input: 300, output: 200 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    const start = sent.find((m) => m.type === "compaction_start");
    const complete = sent.find((m) => m.type === "compaction_complete");
    expect(start).toBeDefined();
    expect(complete).toBeDefined();
    expect(start?.contextTokens).toBe(1000);
    expect(complete?.contextTokensBefore).toBe(1000);
    expect(complete?.contextTokensAfter).toBe(300);
    // start must precede complete in the emitted order
    expect(sent.indexOf(start!)).toBeLessThan(sent.indexOf(complete!));
  });

  it("emits context_fill_warning when context crosses the threshold", async () => {
    const sent = await driveStream([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "fill-1",
            sessionID: "codex-session-1",
            role: "assistant",
            modelID: "gpt-5.5",
            tokens: { input: 850_000, output: 10 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "codex-session-1" } },
    ]);

    const warning = sent.find((m) => m.type === "context_fill_warning");
    expect(warning).toBeDefined();
    expect(warning?.fillPercent).toBe(0.85);
    expect(warning?.contextWindow).toBe(1_000_000);
    expect(warning?.contextTokens).toBe(850_000);
  });
});
