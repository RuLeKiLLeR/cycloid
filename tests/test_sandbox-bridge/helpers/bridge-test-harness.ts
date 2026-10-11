// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Path isolation MUST run before any bridge module is imported (the bridge
// constants module reads its `/tmp/...` defaults at module load). Import this
// side-effect first so the env-var overrides are in place before the
// `vi.mock` factories below resolve any bridge code.
import "./isolated-bridge-paths.ts";

import { rmSync, writeFileSync } from "fs";
import { afterEach, beforeEach, expect, vi } from "vitest";

import type { AgentBridge } from "../../../apps/sandbox-bridge/src/bridge.ts";
import type { PromptLoopState } from "../../../apps/sandbox-bridge/src/prompt-loop-state.ts";
import type { PostExecutionContext } from "../../../apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts";
import { makeAsyncIterator } from "./event-stream-helpers.ts";
import { createMockedRepoFixture } from "./repo-fixture.ts";

// ── Mock setup (vi.hoisted so mocks are available before module-level imports) ──

const mocks = vi.hoisted(() => {
  // WebSocket mock
  const wsInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    readyState: number;
    handlers: Record<string, (...args: unknown[]) => void>;
  }> = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 1;
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    ping = vi.fn();
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

  // Codex runtime client mock
  const mockStream = {
    [Symbol.asyncIterator]: vi.fn(),
    return: vi.fn().mockResolvedValue(undefined),
  };

  const mockClient = {
    session: {
      get: vi.fn().mockResolvedValue({ data: null }),
      create: vi.fn().mockResolvedValue({ data: { id: "codex-session-1" } }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: mockStream }),
    },
    tool: {
      ids: vi.fn().mockResolvedValue({ data: [] }),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    mcp: {
      status: vi.fn().mockResolvedValue({ data: {} }),
      add: vi.fn().mockResolvedValue({ data: {} }),
      disconnect: vi.fn().mockResolvedValue({ data: true }),
    },
    question: {
      reply: vi.fn().mockResolvedValue({ data: { ok: true } }),
    },
  };

  const mockServer = {
    url: "codex://local",
    close: vi.fn(),
  };

  const mockMcpStatusFromConfig = (options?: { config?: { mcp?: Record<string, unknown> } }) => ({
    data: Object.fromEntries(Object.keys(options?.config?.mcp ?? {}).map((name) => [name, { status: "connected" }])),
  });

  const mockCreateCodex = vi.fn(async (options?: { config?: { mcp?: Record<string, unknown> } }) => ({
    client: mockClient,
    server: mockServer,
    mcpStatus: mockMcpStatusFromConfig(options).data,
  }));
  const mockClaudeWarmHandle = {
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
    query: vi.fn(),
  };
  const mockCreateClaudeStartup = vi.fn(async () => mockClaudeWarmHandle);

  const mockExecFileSync = vi.fn();
  // Async execFile mock — calls the callback synchronously so promisified
  // wrappers resolve on the next microtask (compatible with vi.useFakeTimers).
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
    mockClaudeWarmHandle,
    mockCreateClaudeStartup,
    mockExecFileSync,
    mockExecFile,
    mockSpawn,
  };
});

export { mocks };

vi.mock("../../../apps/sandbox-bridge/src/services/codex-server.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createCodexWithStdio: mocks.mockCreateCodex,
  };
});

vi.mock("ws", () => ({ default: mocks.MockWebSocket, WebSocket: mocks.MockWebSocket }));

// The 30s resource-pressure sampler reads /sys/fs/cgroup, /proc and statfs — all
// environment-dependent (and on non-Linux hosts statfs still yields disk metrics),
// so it would emit a `sandbox_resource_sample` that perturbs exact event-count
// assertions like the heartbeat-cadence test. Neutralize the emission for bridge
// unit tests; the sampler's real coverage lives in the resource-telemetry suites.
vi.mock("../../../apps/sandbox-bridge/src/services/runtime-resource-snapshot.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildSandboxResourceSample: () => ({}),
  };
});

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

export const tempDirsToCleanup: string[] = [];

// Per-test repo fixture so the constructor's repo validation takes the same
// branch on every host (see repo-fixture.ts). Reset by the shared lifecycle.
let defaultRepoFixturePath: string | null = null;

export function ensureDefaultRepoFixture(): string {
  if (!defaultRepoFixturePath) {
    defaultRepoFixturePath = createMockedRepoFixture();
    tempDirsToCleanup.push(defaultRepoFixturePath);
  }
  return defaultRepoFixturePath;
}

/**
 * Wrap a wholesale mockExecFileSync override so the constructor's repo
 * validation (`git rev-parse --is-inside-work-tree`) still passes. Without
 * this, an override that does not answer rev-parse makes every
 * `new AgentBridge(defaultConfig())` throw "Repo checkout is missing or
 * invalid". Delegates everything else to the override.
 */
export function gitExecFileSyncMock(override: (cmd: string, args: string[], ...rest: unknown[]) => unknown) {
  return (cmd: string, args: string[], ...rest: unknown[]) => {
    const gitArgs = Array.isArray(args) && args[0] === "-C" ? args.slice(2) : args;
    if (Array.isArray(gitArgs) && gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") {
      return "true\n";
    }
    return override(cmd, args, ...rest);
  };
}

export type { IsolatedSandboxBridgePaths } from "./isolated-bridge-paths.ts";
export { isolatedSandboxBridgePaths, setupIsolatedSandboxBridgePaths } from "./isolated-bridge-paths.ts";

export function makePlatformLlmCapability(callType: string, phase = "post_execution", overrides = {}) {
  return {
    callType,
    phase,
    token: `cap-${phase}-${callType}`,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

export function makePlatformLlmCapabilities(callTypes: string[], phase = "post_execution") {
  return {
    capabilities: callTypes.map((callType) => makePlatformLlmCapability(callType, phase)),
  };
}

export function parsePlatformLlmBrokerRequest(init?: RequestInit) {
  return JSON.parse(String(init?.body ?? "{}")) as {
    callType?: string;
    phase?: string;
    input?: Record<string, unknown>;
  };
}

export function makePlatformLlmSuccess(callType: string, data: Record<string, unknown>, model = `model-${callType}`) {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      attempts: 1,
      durationMs: 10,
      model,
      toolName: `platform_llm_${callType}`,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export function makePlatformLlmFailure(
  callType: string,
  category = "provider_error_retryable",
  status = 503,
  model: string | undefined = `model-${callType}`,
) {
  const payload: Record<string, unknown> = {
    ok: false,
    category,
    attempts: 1,
    durationMs: 10,
    toolName: `platform_llm_${callType}`,
  };
  if (model !== undefined) payload.model = model;

  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

export function defaultConfig() {
  return {
    repoPath: ensureDefaultRepoFixture(),
    sandboxId: "sbx-1",
    sessionId: "sess-1",
    controlPlaneUrl: "https://control.example.com",
    publicAppUrl: "https://app.trycycloid.com",
    authToken: "tok-secret",
    dependencies: {
      createCodex: mocks.mockCreateCodex,
      createClaudeStartup: mocks.mockCreateClaudeStartup,
      createWebSocket: (url: string, options: Record<string, unknown>) =>
        new mocks.MockWebSocket(url, options) as unknown as InstanceType<typeof mocks.MockWebSocket>,
      refreshAgentGhAuth: vi.fn(async () => ({ ok: true })),
      codexProjectDocConfigSupported: () => true,
    },
  };
}

export function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

export function createPromptState() {
  return {
    abortReason: null,
    dispatchSucceeded: true,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
  };
}

export function parseRuntimeLogEntry(payload: unknown) {
  try {
    return JSON.parse(String(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function findRuntimeLog(
  consoleSpy: { mock: { calls: Array<[unknown]> } },
  predicate: (entry: Record<string, unknown>) => boolean,
) {
  return consoleSpy.mock.calls
    .map(([payload]) => parseRuntimeLogEntry(payload))
    .find((entry) => entry && predicate(entry));
}

export function findAllRuntimeLogs(
  consoleSpy: { mock: { calls: Array<[unknown]> } },
  predicate: (entry: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> {
  return consoleSpy.mock.calls
    .map(([payload]) => parseRuntimeLogEntry(payload))
    .filter((entry): entry is Record<string, unknown> => !!entry && predicate(entry));
}

export function findRuntimePhaseLog(
  consoleSpy: { mock: { calls: Array<[unknown]> } },
  event: string,
  step: string,
  status: string,
) {
  return findRuntimeLog(
    consoleSpy,
    (entry) => entry.event === event && entry.step === step && entry.phase_status === status,
  );
}

export type BridgeTestHarness = AgentBridge & {
  client: typeof mocks.mockClient | null;
  server: typeof mocks.mockServer | null;
  agentSessionId: string | null;
  featureBranchEnsured: boolean;
  sendEvent: (event: Record<string, unknown>) => void;
  postExecutionContext: (getPendingPostExecution: () => Promise<void> | null) => PostExecutionContext;
  gitOps: {
    readCurrentGitState: (promptLog: ReturnType<typeof createLogger>) => { branch?: string; commitSha?: string };
    ensureSessionBranch: (promptLog: ReturnType<typeof createLogger>, currentBranch: string) => string | undefined;
  };
  ensureFeatureBranchBeforeFirstEdit: (promptLog: ReturnType<typeof createLogger>, tool: string) => void;
  emitParentToolCallWithInput: (params: {
    canonical: string;
    input: Record<string, unknown>;
    loopState: PromptLoopState;
    messageId: string;
    now: number;
    part: {
      id: string;
      tool: string;
      state?: { input?: Record<string, unknown>; status?: string; output?: string; error?: string };
    };
    promptLog: ReturnType<typeof createLogger>;
    promptState: ReturnType<typeof createPromptState>;
    blockedDoomLoopReason: string;
    repeatedDoomLoopReason: string;
    eventFields?: Record<string, unknown>;
  }) => Promise<"blocked" | "emitted">;
};

export function asBridgeTestHarness(bridge: AgentBridge): BridgeTestHarness {
  return bridge as unknown as BridgeTestHarness;
}

/** Get the most recently created mock WebSocket */
export function latestWs() {
  return mocks.wsInstances[mocks.wsInstances.length - 1];
}

export async function waitForBridgeStartup(predicate: () => boolean, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (predicate()) return;
  }
}

export async function advanceTimersUntil(predicate: () => boolean, stepMs = 500, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Simulate the WS opening (triggers "open" handler) */
export function openWs(ws = latestWs()) {
  const connectionGeneration = mocks.wsInstances.indexOf(ws) + 1;
  ws.handlers.open?.();
  ws.handlers.message?.(
    Buffer.from(
      JSON.stringify({
        type: "sandbox_session",
        sessionKey: `test-session-key-${connectionGeneration}`,
        connectionGeneration,
        nextAuthToken: `test-next-auth-token-${connectionGeneration}`,
      }),
    ),
  );
}

/** Simulate a WS message */
export function sendWsMessage(data: Record<string, unknown>, ws = latestWs()) {
  ws.handlers.message?.(Buffer.from(JSON.stringify(data)));
}

/** Simulate WS close */
export function closeWs(ws = latestWs(), code = 1000, reason?: string) {
  ws.handlers.close?.(code, reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0));
}

/** Simulate WS error */
export function errorWs(err: Error, ws = latestWs()) {
  ws.handlers.error?.(err);
}

export {
  DEFAULT_CODEX_ASSISTANT_MESSAGE_ID,
  DEFAULT_CODEX_SESSION_ID,
  makeAsyncIterator,
  withAssistantMessage,
} from "./event-stream-helpers.ts";

export function makeControlledAsyncIterator(initialEvents: Array<Record<string, unknown>> = []) {
  const queue: Array<IteratorResult<Record<string, unknown>>> = initialEvents.map((event) => ({
    value: event,
    done: false,
  }));
  let pendingResolve: ((result: IteratorResult<Record<string, unknown>>) => void) | null = null;
  const returnFn = vi.fn().mockImplementation(async () => {
    if (pendingResolve) {
      pendingResolve({ value: undefined, done: true });
      pendingResolve = null;
    }
    return { value: undefined, done: true };
  });
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const next = queue.shift();
          if (next) return next;
          return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return: returnFn,
      };
    },
    push(event: Record<string, unknown>) {
      const result = { value: event, done: false };
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(result);
      } else {
        queue.push(result);
      }
    },
    end() {
      const result = { value: undefined, done: true };
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(result);
      } else {
        queue.push(result);
      }
    },
    return: returnFn,
  };
}

export function assertDispatchMetadata(dispatch: Record<string, unknown>, expectedKind: string) {
  expect(dispatch.dispatchKind).toBe(expectedKind);
  expect(dispatch.tokenCountEstimate).toEqual(expect.any(Number));
  expect(dispatch.sections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: expect.any(String),
        promptPhase: expect.any(String),
        cadence: expect.any(String),
        tokenCountEstimate: expect.any(Number),
      }),
    ]),
  );
  for (const section of dispatch.sections as Array<Record<string, unknown>>) {
    expect(section.content).toBeUndefined();
  }
  expect(
    (dispatch.sections as Array<{ tokenCountEstimate: number }>).reduce(
      (sum, section) => sum + section.tokenCountEstimate,
      0,
    ),
  ).toBe(dispatch.tokenCountEstimate);
}

export async function awaitFatalBridgeStop(runPromise: Promise<void>) {
  // Fatal websocket errors should stop the bridge on the next turn; advancing
  // large fake time windows makes this path flaky on slower CI runners.
  await vi.advanceTimersByTimeAsync(0);
  await runPromise;
}

// ── Shared lifecycle ──

let savedCycloidOpenAiApiKey: string | undefined;
let savedOpenAiApiKey: string | undefined;
let savedCodexApiKey: string | undefined;
let savedProvider: string | undefined;
let savedModel: string | undefined;
let savedRepoPrivate: string | undefined;
let savedE2bSandboxId: string | undefined;
let savedE2bTemplateId: string | undefined;
let savedE2bSandboxTemplate: string | undefined;
let savedRuntimeEnvironment: string | undefined;
let savedRuntimeProvider: string | undefined;
let savedRuntimeCpuRequest: string | undefined;
let savedRuntimeCpuLimit: string | undefined;
let savedRuntimeMemoryRequestMb: string | undefined;
let savedRuntimeMemoryLimitMb: string | undefined;
let savedRuntimeSessionKind: string | undefined;
let savedTerminalBenchTaskId: string | undefined;
let savedOwnerUserId: string | undefined;
let savedSandboxAuthToken: string | undefined;
let savedRealGitPath: string | undefined;

export function setupBridgeTestLifecycle() {
  beforeEach(() => {
    mocks.wsInstances.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Start each test with an empty durable outbox so a prior test's persisted
    // critical events are not replayed by this test's bridge startup recovery.
    if (process.env.ARCANIST_OUTBOX_DIR) {
      rmSync(process.env.ARCANIST_OUTBOX_DIR, { recursive: true, force: true });
    }

    // Isolate tests from ambient provider credentials while preserving the
    // production invariant that Cycloid platform keys are present.
    savedCycloidOpenAiApiKey = process.env.ARCANIST_OPENAI_API_KEY;
    savedOpenAiApiKey = process.env.OPENAI_API_KEY;
    savedCodexApiKey = process.env.CODEX_API_KEY;
    savedProvider = process.env.PROVIDER;
    savedModel = process.env.MODEL;
    savedRepoPrivate = process.env.REPO_PRIVATE;
    savedE2bSandboxId = process.env.E2B_SANDBOX_ID;
    savedE2bTemplateId = process.env.E2B_TEMPLATE_ID;
    savedE2bSandboxTemplate = process.env.E2B_SANDBOX_TEMPLATE;
    savedRuntimeEnvironment = process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    savedRuntimeProvider = process.env.ARCANIST_RUNTIME_PROVIDER;
    savedRuntimeCpuRequest = process.env.ARCANIST_RUNTIME_CPU_REQUEST;
    savedRuntimeCpuLimit = process.env.ARCANIST_RUNTIME_CPU_LIMIT;
    savedRuntimeMemoryRequestMb = process.env.ARCANIST_RUNTIME_MEMORY_REQUEST_MB;
    savedRuntimeMemoryLimitMb = process.env.ARCANIST_RUNTIME_MEMORY_LIMIT_MB;
    savedRuntimeSessionKind = process.env.ARCANIST_SESSION_KIND;
    savedTerminalBenchTaskId = process.env.TERMINAL_BENCH_TASK_ID;
    savedOwnerUserId = process.env.OWNER_USER_ID;
    savedSandboxAuthToken = process.env.SANDBOX_AUTH_TOKEN;
    savedRealGitPath = process.env.ARCANIST_REAL_GIT_PATH;
    process.env.ARCANIST_OPENAI_API_KEY = "sk-openai-fake";
    process.env.ARCANIST_REAL_GIT_PATH = "git";
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.PROVIDER;
    delete process.env.MODEL;
    delete process.env.REPO_PRIVATE;
    delete process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH;
    delete process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
    delete process.env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH;
    delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
    delete process.env.E2B_SANDBOX_ID;
    delete process.env.E2B_TEMPLATE_ID;
    delete process.env.E2B_SANDBOX_TEMPLATE;
    delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    delete process.env.ARCANIST_RUNTIME_PROVIDER;
    delete process.env.ARCANIST_RUNTIME_CPU_REQUEST;
    delete process.env.ARCANIST_RUNTIME_CPU_LIMIT;
    delete process.env.ARCANIST_RUNTIME_MEMORY_REQUEST_MB;
    delete process.env.ARCANIST_RUNTIME_MEMORY_LIMIT_MB;
    delete process.env.ARCANIST_SESSION_KIND;
    delete process.env.TERMINAL_BENCH_TASK_ID;
    delete process.env.OWNER_USER_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;

    // Reset defaults
    mocks.mockCreateCodex.mockReset();
    mocks.mockCreateClaudeStartup.mockReset();
    mocks.mockClaudeWarmHandle.close.mockClear();
    mocks.mockClaudeWarmHandle.query.mockClear();
    mocks.mockClaudeWarmHandle[Symbol.asyncDispose].mockClear();
    mocks.mockCreateCodex.mockImplementation(async (options?: { config?: { mcp?: Record<string, unknown> } }) => ({
      client: mocks.mockClient,
      server: mocks.mockServer,
      mcpStatus: Object.fromEntries(
        Object.keys(options?.config?.mcp ?? {}).map((name) => [name, { status: "connected" }]),
      ),
    }));
    mocks.mockCreateClaudeStartup.mockResolvedValue(mocks.mockClaudeWarmHandle);
    mocks.mockClient.session.get.mockResolvedValue({ data: null });
    mocks.mockClient.session.create.mockResolvedValue({ data: { id: "codex-session-1" } });
    mocks.mockClient.session.promptAsync.mockResolvedValue(undefined);
    mocks.mockClient.session.abort.mockResolvedValue(undefined);
    mocks.mockClient.event.subscribe.mockResolvedValue({ stream: makeAsyncIterator([]) });
    mocks.mockClient.mcp.status.mockResolvedValue({ data: {} });
    mocks.mockClient.mcp.add.mockResolvedValue({ data: {} });
    mocks.mockClient.mcp.disconnect.mockResolvedValue({ data: true });
    mocks.mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const gitArgs = args[0] === "-C" ? args.slice(2) : args;
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--is-inside-work-tree") return "true\n";
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--git-path" && gitArgs[2] === "config") return ".git/config\n";
      return "main\n";
    });
    let mockCurrentBranch = "main";
    const mockCurrentHeadSha = "abc123";
    mocks.mockExecFile.mockImplementation((...args: unknown[]) => {
      const command = args[0];
      const commandArgs = args[1] as string[] | undefined;
      if (
        command === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs[0] === "rev-parse" &&
        commandArgs[1] === "--git-path" &&
        commandArgs[2] === "hooks/pre-commit"
      ) {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          (callback as Function)(null, ".git/hooks/pre-commit\n", "");
        }
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      if (command === "git" && Array.isArray(commandArgs)) {
        if (commandArgs[0] === "checkout" && commandArgs.includes("-B")) {
          mockCurrentBranch = commandArgs[commandArgs.indexOf("-B") + 1] ?? mockCurrentBranch;
        }
        if (commandArgs[0] === "branch" && commandArgs[1] === "--show-current") {
          const callback = args[args.length - 1];
          if (typeof callback === "function") (callback as Function)(null, `${mockCurrentBranch}\n`, "");
          return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
        }
        if (commandArgs[0] === "rev-parse" && commandArgs[1] === "--verify") {
          const callback = args[args.length - 1];
          if (typeof callback === "function") (callback as Function)(null, `${mockCurrentHeadSha}\n`, "");
          return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
        }
      }
      if (Array.isArray(commandArgs)) {
        const chromiumScreenshotArg = commandArgs.find((arg) => arg.startsWith("--screenshot="));
        const screenshotPath =
          chromiumScreenshotArg?.slice("--screenshot=".length) ??
          (commandArgs.includes("screenshot") ? commandArgs[commandArgs.length - 1] : null);
        if (screenshotPath) {
          writeFileSync(screenshotPath, Buffer.from("fake-png"));
        }
      }
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        (callback as Function)(null, "main\n", "");
      }
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    // Default fetch mock (prevents hangs under fake timers; e.g. clone-token refresh)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, token: "ghs_mock_token" }), { status: 200 }),
    );
  });

  afterEach(() => {
    defaultRepoFixturePath = null;
    while (tempDirsToCleanup.length > 0) {
      const dir = tempDirsToCleanup.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (savedCycloidOpenAiApiKey !== undefined) process.env.ARCANIST_OPENAI_API_KEY = savedCycloidOpenAiApiKey;
    else delete process.env.ARCANIST_OPENAI_API_KEY;
    if (savedOpenAiApiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiApiKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedCodexApiKey !== undefined) process.env.CODEX_API_KEY = savedCodexApiKey;
    else delete process.env.CODEX_API_KEY;
    if (savedProvider !== undefined) process.env.PROVIDER = savedProvider;
    else delete process.env.PROVIDER;
    if (savedModel !== undefined) process.env.MODEL = savedModel;
    else delete process.env.MODEL;
    if (savedRepoPrivate !== undefined) process.env.REPO_PRIVATE = savedRepoPrivate;
    else delete process.env.REPO_PRIVATE;
    if (savedE2bSandboxId !== undefined) process.env.E2B_SANDBOX_ID = savedE2bSandboxId;
    else delete process.env.E2B_SANDBOX_ID;
    if (savedE2bTemplateId !== undefined) process.env.E2B_TEMPLATE_ID = savedE2bTemplateId;
    else delete process.env.E2B_TEMPLATE_ID;
    if (savedE2bSandboxTemplate !== undefined) process.env.E2B_SANDBOX_TEMPLATE = savedE2bSandboxTemplate;
    else delete process.env.E2B_SANDBOX_TEMPLATE;
    if (savedRuntimeEnvironment !== undefined) process.env.ARCANIST_RUNTIME_ENVIRONMENT = savedRuntimeEnvironment;
    else delete process.env.ARCANIST_RUNTIME_ENVIRONMENT;
    if (savedRuntimeProvider !== undefined) process.env.ARCANIST_RUNTIME_PROVIDER = savedRuntimeProvider;
    else delete process.env.ARCANIST_RUNTIME_PROVIDER;
    if (savedRuntimeCpuRequest !== undefined) process.env.ARCANIST_RUNTIME_CPU_REQUEST = savedRuntimeCpuRequest;
    else delete process.env.ARCANIST_RUNTIME_CPU_REQUEST;
    if (savedRuntimeCpuLimit !== undefined) process.env.ARCANIST_RUNTIME_CPU_LIMIT = savedRuntimeCpuLimit;
    else delete process.env.ARCANIST_RUNTIME_CPU_LIMIT;
    if (savedRuntimeMemoryRequestMb !== undefined)
      process.env.ARCANIST_RUNTIME_MEMORY_REQUEST_MB = savedRuntimeMemoryRequestMb;
    else delete process.env.ARCANIST_RUNTIME_MEMORY_REQUEST_MB;
    if (savedRuntimeMemoryLimitMb !== undefined)
      process.env.ARCANIST_RUNTIME_MEMORY_LIMIT_MB = savedRuntimeMemoryLimitMb;
    else delete process.env.ARCANIST_RUNTIME_MEMORY_LIMIT_MB;
    if (savedRuntimeSessionKind !== undefined) process.env.ARCANIST_SESSION_KIND = savedRuntimeSessionKind;
    else delete process.env.ARCANIST_SESSION_KIND;
    if (savedTerminalBenchTaskId !== undefined) process.env.TERMINAL_BENCH_TASK_ID = savedTerminalBenchTaskId;
    else delete process.env.TERMINAL_BENCH_TASK_ID;
    if (savedOwnerUserId !== undefined) process.env.OWNER_USER_ID = savedOwnerUserId;
    else delete process.env.OWNER_USER_ID;
    if (savedSandboxAuthToken !== undefined) process.env.SANDBOX_AUTH_TOKEN = savedSandboxAuthToken;
    else delete process.env.SANDBOX_AUTH_TOKEN;
    if (savedRealGitPath !== undefined) process.env.ARCANIST_REAL_GIT_PATH = savedRealGitPath;
    else delete process.env.ARCANIST_REAL_GIT_PATH;
    delete process.env.ARCANIST_WORKSPACE_SETUP_PENDING_PATH;
    delete process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
    delete process.env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH;
    delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
  });
}
