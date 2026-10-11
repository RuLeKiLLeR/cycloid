// Side-effect import: path isolation must run before any sandbox-bridge
// import so module-load reads of /tmp paths resolve to per-file scratch dirs.
// Keep this first; do not let lint sort it down.
import "./helpers/isolated-bridge-paths.ts";

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_EVIDENCE_DIR } from "../../apps/sandbox-bridge/src/constants/bridge.ts";
import {
  adaptCodexDynamicToolResultForImageFeedback,
  filterCodexDesktopDynamicToolSpecsForImageFeedback,
  resolveCodexImageFeedbackCapability,
} from "../../apps/sandbox-bridge/src/services/codex-image-feedback.ts";
import {
  buildCodexRuntimeConfig,
  CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  CodexBridgeClient,
  createCodexWithStdio,
} from "../../apps/sandbox-bridge/src/services/codex-server.ts";
import { executeDatadogSearchLogsDynamicToolCall } from "../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.ts";
import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts";
import { KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME } from "../../apps/sandbox-bridge/src/services/known-image-dynamic-tool.ts";
import {
  executeLinearGetIssueDynamicToolCall,
  executeLinearListIssueStatusesDynamicToolCall,
} from "../../apps/sandbox-bridge/src/services/linear-dynamic-tool.ts";
import { executeSentryDynamicToolCall } from "../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.ts";
import {
  executeSlackGetThreadDynamicToolCall,
  executeSlackSearchMessagesDynamicToolCall,
} from "../../apps/sandbox-bridge/src/services/slack-dynamic-tool.ts";
import {
  KNOWN_IMAGE_FIXTURE_HEIGHT,
  KNOWN_IMAGE_FIXTURE_WIDTH,
} from "../../apps/sandbox-bridge/src/services/visual-feedback-fixture.ts";
import { MEMORY_FEATURE_DISABLED } from "../../shared/constants/memory";
import {
  executeLinearGetIssueDynamicToolCall,
  executeLinearListIssueStatusesDynamicToolCall,
} from "../../tools/linear/client.ts";
import { isolatedSandboxBridgePaths } from "./helpers/isolated-bridge-paths.ts";

const CODEX_HOME_PREFIX = isolatedSandboxBridgePaths.codexHomePrefix;
const EXECUTE_SANDBOX_POLICY = { type: "dangerFullAccess" } as const;
const DESKTOP_DYNAMIC_TOOL_KEYS = [
  "desktop.observe",
  "desktop.screenshot",
  "desktop.windows",
  "desktop.click",
  "desktop.type",
  "desktop.hotkey",
  "desktop.scroll",
  "desktop.drag",
  "desktop.open_app",
  "desktop.focus_window",
  "desktop.record_start",
  "desktop.record_stop",
  "desktop.record_status",
];

function createMockTransport(options?: {
  onRequest?: (method: string, params: Record<string, unknown> | undefined) => unknown | Promise<unknown>;
  mcpStatus?: Record<string, { status: string; error?: string }>;
}) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (options?.onRequest) {
      const handled = await options.onRequest(method, params);
      if (handled !== undefined) return handled;
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } };
    }
    if (method === "thread/read") {
      return { thread: { id: String(params?.threadId ?? "thread-1") } };
    }
    if (method === "thread/resume") {
      return { thread: { id: String(params?.threadId ?? "thread-1") } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    return {};
  });
  const transport = {
    request,
    close: vi.fn(),
    onNotification: null as ((method: string, params: Record<string, unknown>) => void) | null,
    onServerRequest: null as
      ((request: { id: string | number; method: string; params: Record<string, unknown> }) => Promise<unknown>) | null,
  };
  const client = new CodexBridgeClient({
    transport: transport as never,
    cwd: process.cwd(),
    model: "openai/gpt-5.5",
    agentRole: "implementation",
    mcpStatus: options?.mcpStatus,
  });
  const emit = (method: string, params: Record<string, unknown>) => transport.onNotification?.(method, params);
  return { client, transport, emit };
}

function createSpawnHarness(options?: { suppressAutoResponses?: string[] }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  const waiters = new Set<() => void>();

  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4321;
  child.killed = false;
  child.exitCode = null;
  const notifyWaiters = () => {
    for (const waiter of waiters) waiter();
  };
  const exitChild = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code;
    if (!stdin.writableEnded && !stdin.destroyed) stdin.end();
    if (!stdout.writableEnded && !stdout.destroyed) stdout.end();
    if (!stderr.writableEnded && !stderr.destroyed) stderr.end();
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
    notifyWaiters();
  };
  child.kill = vi.fn(() => {
    child.killed = true;
    exitChild(0, null);
    return true;
  });

  const requests: Array<{ id?: string | number; method?: string; params?: Record<string, unknown> }> = [];
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const payload = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      requests.push(payload);
      notifyWaiters();
      const suppressAutoResponses = new Set(options?.suppressAutoResponses ?? []);
      if (suppressAutoResponses.has(String(payload.method))) continue;
      if (payload.method === "initialize") {
        stdout.write(
          `${JSON.stringify({
            id: payload.id,
            result: {
              userAgent: "test/0.129.0",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "linux",
            },
          })}\n`,
        );
      } else if (payload.method === "mcpServerStatus/list") {
        stdout.write(
          `${JSON.stringify({ id: payload.id, result: { data: [{ name: "example-mcp" }], nextCursor: null } })}\n`,
        );
      } else if (payload.method === "account/login/start") {
        stdout.write(`${JSON.stringify({ id: payload.id, result: { type: "apiKey" } })}\n`);
      } else if (payload.method === "thread/start") {
        stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: "thread-created-1" } } })}\n`);
      } else if (payload.method === "thread/read") {
        stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: payload.params?.threadId } } })}\n`);
      } else if (payload.method === "turn/start") {
        stdout.write(`${JSON.stringify({ id: payload.id, result: { turn: { id: "turn-created-1" } } })}\n`);
      }
    }
  });

  return {
    child,
    exitChild,
    requests,
    spawn: vi.fn(() => child),
    async waitForRequestMatching(
      predicate: (request: { id?: string | number; method?: string; params?: Record<string, unknown> }) => boolean,
    ) {
      if (requests.some(predicate)) return;
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!requests.some(predicate)) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
    },
    send(message: Record<string, unknown>) {
      stdout.write(`${JSON.stringify(message)}\n`);
      notifyWaiters();
    },
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      expect(predicate()).toBe(true);
    },
    { timeout: 2000, interval: 10 },
  );
}

function transientSetupError(): Error & { errorCode: string } {
  return Object.assign(new Error("timed out"), { errorCode: "timeout" });
}

function resetSandboxBridgeTestEnv(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("ARCANIST_OPENAI_GATEWAY_ENABLED", "");
  vi.stubEnv("ARCANIST_MEMORY_TOOLS_ENABLED", "");
  vi.stubEnv("CODEX_HOME", "");
  vi.stubEnv("SESSION_ID", "");
  vi.stubEnv("PROVIDER", "");
  vi.stubEnv("MODEL", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ARCANIST_OPENAI_API_KEY", "");
  vi.stubEnv("DD_API_KEY", "");
  vi.stubEnv("DD_APP_KEY", "");
  vi.stubEnv("DD_SITE", "");
  vi.stubEnv("LINEAR_ACCESS_TOKEN", "");
  vi.stubEnv("NOTION_ACCESS_TOKEN", "");
  vi.stubEnv("SENTRY_ACCESS_TOKEN", "");
  vi.stubEnv("SENTRY_ORGANIZATION_SLUG", "");
  vi.stubEnv("SLACK_SESSION_TEAM_ID", "");
  vi.stubEnv("SANDBOX_AUTH_TOKEN", "");
  vi.stubEnv("CONTROL_PLANE_URL", "");
  vi.stubEnv("ARCANIST_BRIDGE_BUNDLE_PATH", "");
  vi.stubEnv("ARCANIST_CODEX_MEMORY_HOOKS", "");
  vi.stubEnv("ARCANIST_RUNTIME_PROVIDER", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createCodexWithStdio", () => {
  beforeEach(() => {
    resetSandboxBridgeTestEnv();
  });

  it("fails closed when no OpenAI key is configured", async () => {
    await expect(createCodexWithStdio({ agentRole: "implementation", cwd: process.cwd() })).rejects.toThrow(
      /No OpenAI credential configured for Codex runtime/,
    );
  });

  it("creates an app-server backed bridge client and initializes startup MCP status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    expect(result.server.url).toBe("codex://app-server");
    expect(result.server.pid).toBe(4321);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "mcpServerStatus/list",
    ]);
    expect(harness.requests[0]?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(harness.requests[2]?.params).toEqual({ type: "apiKey", apiKey: "sk-test" });
    expect(await result.client.mcp.status()).toEqual({
      data: { "example-mcp": { status: "connected" } },
    });

    const session = await result.client.session.create();
    expect(session.data.id).toBe("thread-created-1");
    await expect(result.client.session.get({ path: { id: session.data.id } })).resolves.toEqual({
      data: { id: session.data.id },
    });

    result.server.close();
  });

  it("reuses the same generated CODEX_HOME for stored-auth detection and runtime env", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      return {
        ...actual,
        randomUUID: vi.fn().mockReturnValueOnce("generated-home-a").mockReturnValueOnce("generated-home-b"),
      };
    });
    const { createCodexWithStdio: createCodexWithStdioFresh } =
      await import("../../apps/sandbox-bridge/src/services/codex-server.ts");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("SESSION_ID", "");
    const authHome = `${CODEX_HOME_PREFIX}generated-home-a`;
    const otherHome = `${CODEX_HOME_PREFIX}generated-home-b`;
    rmSync(authHome, { recursive: true, force: true });
    rmSync(otherHome, { recursive: true, force: true });
    const harness = createSpawnHarness();

    try {
      mkdirSync(authHome, { recursive: true });
      writeFileSync(join(authHome, "auth.json"), "{}", { encoding: "utf8", flag: "w" });

      const result = await createCodexWithStdioFresh({
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });

      expect(harness.spawn).toHaveBeenCalled();
      const spawnEnv = harness.spawn.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;
      expect(spawnEnv?.CODEX_HOME).toBe(authHome);
      expect(spawnEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(spawnEnv?.CODEX_API_KEY).toBeUndefined();

      result.server.close();
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
      rmSync(authHome, { recursive: true, force: true });
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("lets the current session OPENAI_API_KEY override stored auth", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      return {
        ...actual,
        randomUUID: vi.fn().mockReturnValueOnce("generated-home-openai-fallback"),
      };
    });
    const { createCodexWithStdio: createCodexWithStdioFresh } =
      await import("../../apps/sandbox-bridge/src/services/codex-server.ts");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("SESSION_ID", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-runtime-test");
    const authHome = `${CODEX_HOME_PREFIX}generated-home-openai-fallback`;
    rmSync(authHome, { recursive: true, force: true });
    const harness = createSpawnHarness();

    try {
      mkdirSync(authHome, { recursive: true });
      writeFileSync(join(authHome, "auth.json"), "{}", { encoding: "utf8", flag: "w" });

      const result = await createCodexWithStdioFresh({
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });

      expect(harness.spawn).toHaveBeenCalled();
      const spawnEnv = harness.spawn.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;
      expect(spawnEnv?.CODEX_HOME).toBe(authHome);
      expect(spawnEnv?.OPENAI_API_KEY).toBe("sk-runtime-test");
      expect(spawnEnv?.CODEX_API_KEY).toBe("sk-runtime-test");
      expect(existsSync(join(authHome, "auth.json"))).toBe(false);
      expect(harness.requests.map((request) => request.method)).toContain("account/login/start");

      result.server.close();
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
      rmSync(authHome, { recursive: true, force: true });
    }
  });

  it("writes current session auth.json before spawning Codex", async () => {
    const codexHome = join(tmpdir(), `codex-home-session-auth-json-${randomUUID()}`);
    const authJson = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}';
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("ARCANIST_CODEX_AUTH_JSON", authJson);
    vi.stubEnv("OPENAI_API_KEY", "sk-ignored-when-auth-json-present");
    const harness = createSpawnHarness();

    try {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), '{"source":"stale"}', "utf8");

      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const spawnEnv = harness.spawn.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;

      expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(authJson);
      if (process.platform !== "win32") {
        expect(statSync(join(codexHome, "auth.json")).mode & 0o777).toBe(0o600);
      }
      expect(spawnEnv?.ARCANIST_CODEX_AUTH_JSON).toBeUndefined();
      expect(spawnEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(harness.requests.map((request) => request.method)).not.toContain("account/login/start");

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("does not fall back to API-key auth when current session auth.json is invalid", async () => {
    const codexHome = join(tmpdir(), `codex-home-invalid-auth-json-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("ARCANIST_CODEX_AUTH_JSON", "not-json");
    vi.stubEnv("OPENAI_API_KEY", "sk-session-test");
    const harness = createSpawnHarness();

    try {
      await expect(
        createCodexWithStdio({
          agentRole: "implementation",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        }),
      ).rejects.toThrow("Codex session auth.json is not valid JSON");
      expect(harness.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("registers only the session's available dynamic tools on thread/start", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("LINEAR_ACCESS_TOKEN", "linear-token");
    vi.stubEnv("ARCANIST_CUA_ENABLED", "1");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    await result.client.session.create();

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(
      (
        (threadStart?.params as { dynamicTools?: Array<{ namespace?: string; name?: string }> } | undefined)
          ?.dynamicTools ?? []
      ).map((tool) => `${tool.namespace}.${tool.name}`),
    ).toEqual([
      ...DESKTOP_DYNAMIC_TOOL_KEYS,
      "cycloid.review_loop_reply",
      "cycloid.review_summary_comment",
      "cycloid.publish_pr_review",
      "cycloid.git_sync",
      "cycloid.spawn_child_session",
      "linear.create_issue",
      "linear.get_issue",
      "linear.list_issue_statuses",
      "linear.update_issue",
      "linear.list_comments",
      "linear.create_comment",
      "linear.search_issues",
    ]);

    result.server.close();
  });

  it("omits side-effecting dynamic tools from verification-role sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("LINEAR_ACCESS_TOKEN", "linear-token");
    vi.stubEnv("ARCANIST_CUA_ENABLED", "1");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "verification",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    await result.client.session.create();

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(
      (
        (threadStart?.params as { dynamicTools?: Array<{ namespace?: string; name?: string }> } | undefined)
          ?.dynamicTools ?? []
      ).map((tool) => `${tool.namespace}.${tool.name}`),
    ).toEqual([
      ...DESKTOP_DYNAMIC_TOOL_KEYS,
      "linear.get_issue",
      "linear.list_issue_statuses",
      "linear.list_comments",
      "linear.search_issues",
    ]);

    result.server.close();
  });

  it("runtime-blocks verification-role side-effecting dynamic tool calls before validation or fetch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("LINEAR_ACCESS_TOKEN", "linear-token");
    const fetchMock = vi.fn(async () => {
      throw new Error("blocked tool must not reach fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "verification",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();

    harness.send({
      id: "verification-side-effect-tool",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        namespace: "linear",
        tool: "create_issue",
        arguments: {},
      },
    });
    await harness.waitForRequestMatching(
      (request) => request.id === "verification-side-effect-tool" && !request.method,
    );

    const toolResponse = harness.requests.find(
      (request) => request.id === "verification-side-effect-tool" && !request.method,
    );
    expect(toolResponse).toMatchObject({
      id: "verification-side-effect-tool",
      result: {
        success: false,
        errorCode: "blocked",
        contentItems: [
          {
            type: "inputText",
            text: "Policy block: verification sessions cannot use side-effecting first-party dynamic tool 'linear.create_issue'.",
          },
        ],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    result.server.close();
  });

  it("registers Slack dynamic tools on thread/start only for Slack-originated sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("SLACK_SESSION_TEAM_ID", "T123");
    vi.stubEnv("ARCANIST_CUA_ENABLED", "1");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    await result.client.session.create();

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(
      (
        (threadStart?.params as { dynamicTools?: Array<{ namespace?: string; name?: string }> } | undefined)
          ?.dynamicTools ?? []
      ).map((tool) => `${tool.namespace}.${tool.name}`),
    ).toEqual([
      ...DESKTOP_DYNAMIC_TOOL_KEYS,
      "cycloid.review_loop_reply",
      "cycloid.review_summary_comment",
      "cycloid.publish_pr_review",
      "cycloid.git_sync",
      "cycloid.spawn_child_session",
      "slack.get_thread",
      "slack.search_messages",
      "slack.send_message",
    ]);

    result.server.close();
  });

  it("registers company memory dynamic tools on thread/start for sessions with memory tools enabled", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ARCANIST_CUA_ENABLED", "1");
    vi.stubEnv("SESSION_ID", "session-123");
    vi.stubEnv("SANDBOX_AUTH_TOKEN", "sandbox-token");
    vi.stubEnv("CONTROL_PLANE_URL", "http://localhost:3000");
    vi.stubEnv("ARCANIST_MEMORY_TOOLS_ENABLED", "1");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    await result.client.session.create();

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(
      (
        (threadStart?.params as { dynamicTools?: Array<{ namespace?: string; name?: string }> } | undefined)
          ?.dynamicTools ?? []
      ).map((tool) => `${tool.namespace}.${tool.name}`),
    ).toEqual([
      ...DESKTOP_DYNAMIC_TOOL_KEYS,
      "cycloid.memory_context",
      "cycloid.memory_recall",
      "cycloid.company_memory_recall",
      "cycloid.company_memory_reasoning_chain",
      "cycloid.review_loop_reply",
      "cycloid.review_summary_comment",
      "cycloid.publish_pr_review",
      "cycloid.git_sync",
      "cycloid.spawn_child_session",
    ]);

    result.server.close();
  });

  it("keeps session-static guidance in managed AGENTS.md instead of turn prompts", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("SESSION_ID", "session-123");
    vi.stubEnv("SANDBOX_AUTH_TOKEN", "sandbox-token");
    vi.stubEnv("CONTROL_PLANE_URL", "http://localhost:3000");
    vi.stubEnv("ARCANIST_MEMORY_TOOLS_ENABLED", "1");
    const codexHome = `${CODEX_HOME_PREFIX}turn-guidance-${randomUUID()}`;
    vi.stubEnv("CODEX_HOME", codexHome);
    rmSync(codexHome, { recursive: true, force: true });
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const session = await result.client.session.create();

      await result.client.session.promptAsync({
        path: { id: session.data.id },
        body: {
          sandboxPolicy: EXECUTE_SANDBOX_POLICY,
          parts: [
            {
              type: "text",
              text: 'Call cycloid.company_memory_recall with intent "Memory 2.0 local live testing known constraints and dead ends" and then summarize only the returned company memory results.',
            },
          ],
        },
      });

      const managedGuidance = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
      expect(managedGuidance).toContain("Available first-party dynamic tools:");
      expect(managedGuidance).toContain("`cycloid.company_memory_recall`");
      expect(managedGuidance).toContain("must call that tool before answering");
      expect(managedGuidance).toContain("do not answer from already-injected context alone");

      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const input = (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input ?? [];
      const text = input.map((part) => part.text ?? "").join("\n");
      expect(text).toContain("Call cycloid.company_memory_recall");
      expect(text).not.toContain("# Sandbox environment");
      expect(text).not.toContain("Available first-party dynamic tools:");
      expect(text).not.toContain("must call that tool before answering");

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("falls back to turn-prompt guidance when CODEX_HOME is not bridge-owned", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const codexHome = join(tmpdir(), `codex-local-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    rmSync(codexHome, { recursive: true, force: true });
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const session = await result.client.session.create();

      await result.client.session.promptAsync({
        path: { id: session.data.id },
        body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
      });

      expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const input = (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input ?? [];
      const text = input.map((part) => part.text ?? "").join("\n");
      expect(text).toContain("# Sandbox environment");
      expect(text).toContain("hello");

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("enriches generic app-server errors with the most relevant stderr diagnostic", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    const session = await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    harness.child.stderr.write(
      "2026-05-11T20:24:04.313241Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses\n",
    );
    harness.send({
      method: "error",
      params: {
        message: "Codex app-server error",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.error",
        properties: {
          sessionID: session.data.id,
          error: {
            name: "CodexStreamError",
            data: {
              message:
                "Codex app-server error: 2026-05-11T20:24:04.313241Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses",
            },
          },
        },
      },
    });

    result.server.close();
  });

  it("ignores Codex reconnect progress error notifications", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    harness.send({
      method: "error",
      params: {
        message: "Reconnecting... 1/5",
      },
    });
    harness.send({
      method: "error",
      params: {
        error: {
          message: "Reconnecting... 2/5",
        },
      },
    });

    await expect(
      Promise.race([iterator.next(), new Promise((resolve) => setTimeout(() => resolve("quiet"), 25))]),
    ).resolves.toBe("quiet");

    result.server.close();
  });

  it("derives session.error.errorCode from structured app-server error notifications", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });

    const session = await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    harness.send({
      method: "error",
      params: {
        error: {
          message: "HTTP 500 Internal Server Error",
          codexErrorInfo: { name: "BadRequest", httpStatusCode: 400 },
          additionalDetails: "cannot steer a review turn",
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.error",
        properties: {
          sessionID: session.data.id,
          errorCode: "codex_unrecoverable",
          codexErrorInfo: { name: "BadRequest", httpStatusCode: 400 },
          additionalDetails: "cannot steer a review turn",
          error: {
            name: "CodexStreamError",
            data: { message: "HTTP 500 Internal Server Error" },
          },
        },
      },
    });

    result.server.close();
  });

  it("rejects in-flight turn requests with runtime_error when the app-server exits unexpectedly", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness({ suppressAutoResponses: ["turn/start"] });

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();

    const promptPromise = result.client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
    });

    harness.child.emit("exit", 1, null);

    await expect(promptPromise).rejects.toMatchObject({
      errorCode: "runtime_error",
    });
  });

  it("does not count protocol stdout bytes against forwarded stdio output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    await result.client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
    });

    const clientPrivate = result.client as CodexBridgeClient & {
      transport: { stdoutBytesForwarded: number };
    };
    expect(clientPrivate.transport.stdoutBytesForwarded).toBe(0);

    result.server.close();
  });

  it("uses the configured startup timeout for initialize", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness({ suppressAutoResponses: ["initialize"] });

    try {
      const createPromise = createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        timeout: 25,
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });

      let settled = false;
      void createPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(24);
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.runAllTimersAsync();
      await expect(createPromise).rejects.toThrow(/Codex app-server request timed out: initialize/);
      expect(harness.requests.filter((request) => request.method === "initialize")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on malformed stdout and rejects the pending turn request", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness({ suppressAutoResponses: ["turn/start"] });

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    const promptPromise = result.client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
    });

    harness.child.stdout.write("{not-json}\n");

    await expect(promptPromise).rejects.toMatchObject({
      errorCode: "protocol_error",
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.error",
        properties: {
          sessionID: session.data.id,
          errorCode: "codex_unrecoverable",
          error: {
            name: "CodexTransportClosed",
            data: {
              message: "Malformed Codex app-server NDJSON line: {not-json}",
            },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("translates direct apply_patch raw response items into canonical tool lifecycle events", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("raw_response_item", {
      threadId: session.data.id,
      response_item: {
        type: "custom_tool_call",
        id: "resp-item-1",
        call_id: "call-apply-1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n",
      },
    });
    emit("raw_response_item", {
      threadId: session.data.id,
      response_item: {
        type: "custom_tool_call_output",
        call_id: "call-apply-1",
        status: "failed",
        result: "Failed to find expected lines in src/app.ts",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "resp-item-1",
            callID: "call-apply-1",
            tool: "apply_patch",
            state: {
              input: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n" },
              status: "running",
            },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call-apply-1",
            callID: "call-apply-1",
            tool: "apply_patch",
            state: {
              status: "error",
              error: "Failed to find expected lines in src/app.ts",
            },
          },
        },
      },
    });
    await Promise.resolve();
    await expect(Promise.race([iterator.next(), Promise.resolve("no-extra-event")])).resolves.toBe("no-extra-event");

    client.close();
  });

  it("keeps fileChange as a patch-only consequence stream after a direct apply_patch call", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/started", {
      threadId: session.data.id,
      item: {
        type: "customToolCall",
        id: "custom-item-1",
        callId: "call-shared-1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n",
      },
    });
    emit("item/started", {
      threadId: session.data.id,
      item: {
        type: "fileChange",
        id: "call-shared-1",
        changes: [{ path: "/workspace/repo/src/app.ts" }],
        status: "inProgress",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "custom-item-1",
            callID: "call-shared-1",
            tool: "apply_patch",
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call-shared-1",
            type: "patch",
            files: ["/workspace/repo/src/app.ts"],
          },
        },
      },
    });

    client.close();
  });

  it("translates commandExecution items into canonical bash tool parts including failed searches", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/completed", {
      threadId: session.data.id,
      item: {
        type: "commandExecution",
        id: "cmd-rg",
        command: "rg foo .",
        status: "completed",
        aggregatedOutput: "src/app.ts:foo",
      },
    });
    emit("item/completed", {
      threadId: session.data.id,
      item: {
        type: "commandExecution",
        id: "cmd-grep",
        command: "grep -r bar .",
        status: "failed",
        aggregatedOutput: "",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "cmd-rg",
            tool: "bash",
            state: {
              input: { command: "rg foo ." },
              status: "completed",
              output: "src/app.ts:foo",
            },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "cmd-grep",
            tool: "bash",
            state: {
              input: { command: "grep -r bar ." },
              status: "error",
            },
          },
        },
      },
    });

    client.close();
  });

  it("caps provider-native model context while retaining full command output and emitting size telemetry", async () => {
    const { client, emit } = createMockTransport();
    const promptLog = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    promptLog.child.mockReturnValue(promptLog);
    const session = await client.session.create();
    await client.session.promptAsync({
      path: { id: session.data.id },
      promptLog: promptLog as never,
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [] },
    });
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();
    const fullOutput = "x".repeat(CODEX_TOOL_OUTPUT_TOKEN_LIMIT * 4 + 1_000);

    emit("item/completed", {
      threadId: session.data.id,
      item: {
        type: "commandExecution",
        id: "cmd-large-output",
        command: "rg everything .",
        status: "completed",
        aggregatedOutput: fullOutput,
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "cmd-large-output",
            tool: "bash",
            state: { status: "completed", output: fullOutput },
          },
        },
      },
    });
    expect(promptLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "codex.tool_output_context_budget",
        toolType: "command",
        tool: "bash",
        originalChars: fullOutput.length,
        deliveredEstimatedChars: CODEX_TOOL_OUTPUT_TOKEN_LIMIT * 4,
        configuredTokenLimit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
        truncated: true,
        truncationReason: "provider_context_token_limit",
        fullOutputStreamPreserved: true,
      }),
      "Codex provider-native tool output context budget evaluated",
    );

    client.close();
  });

  it("does not synthesize fallback apply_patch tool parts when canonical apply_patch lifecycle is already present", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("raw_response_item", {
      threadId: session.data.id,
      response_item: {
        type: "custom_tool_call",
        id: "resp-item-2",
        call_id: "call-shared-3",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n",
      },
    });
    emit("item/started", {
      threadId: session.data.id,
      item: {
        type: "fileChange",
        id: "file-change-3",
        callId: "call-shared-3",
        changes: [{ path: "/workspace/repo/src/app.ts" }],
        status: "inProgress",
      },
    });
    emit("raw_response_item", {
      threadId: session.data.id,
      response_item: {
        type: "custom_tool_call_output",
        call_id: "call-shared-3",
        status: "completed",
        output: "Success. Updated the following files:\nM src/app.ts",
      },
    });
    emit("item/completed", {
      threadId: session.data.id,
      item: {
        type: "fileChange",
        id: "file-change-3",
        callId: "call-shared-3",
        changes: [{ path: "/workspace/repo/src/app.ts" }],
        status: "completed",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "resp-item-2",
            callID: "call-shared-3",
            tool: "apply_patch",
            state: {
              input: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n" },
              status: "running",
            },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "file-change-3",
            type: "patch",
            files: ["/workspace/repo/src/app.ts"],
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call-shared-3",
            callID: "call-shared-3",
            tool: "apply_patch",
            state: {
              status: "completed",
              output: "Success. Updated the following files:\nM src/app.ts",
            },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "file-change-3",
            type: "patch",
            files: ["/workspace/repo/src/app.ts"],
          },
        },
      },
    });

    client.close();
  });

  it("dedupes synthetic apply_patch fallback events by fileChange callId", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/started", {
      threadId: session.data.id,
      item: {
        type: "fileChange",
        id: "file-change-1",
        callId: "call-shared-2",
        changes: [{ path: "/workspace/repo/src/app.ts" }],
        status: "inProgress",
      },
    });
    emit("item/completed", {
      threadId: session.data.id,
      item: {
        type: "fileChange",
        id: "file-change-1",
        callId: "call-shared-2",
        changes: [{ path: "/workspace/repo/src/app.ts" }],
        status: "completed",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "file-change-1",
            type: "patch",
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "apply-call-shared-2",
            callID: "call-shared-2",
            tool: "apply_patch",
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "file-change-1",
            type: "patch",
          },
        },
      },
    });

    client.close();
  });

  it("forwards classified raw-fallback notifications into raw_agent_runtime events", async () => {
    const { client, emit } = createMockTransport();

    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("warning", {
      threadId: session.data.id,
      message: "apply_patch may fail",
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "raw_agent_runtime",
        properties: {
          sessionID: session.data.id,
          eventType: "warning",
          message: "apply_patch may fail",
        },
      },
    });

    client.close();
  });

  it("translates bridge MCP config into Codex mcp_servers config without embedding local secrets", () => {
    const config = {
      mcp: {
        "local-slack": {
          type: "local",
          command: ["node", "/app/local-slack/server.js"],
          environment: {
            SLACK_BOT_TOKEN: "xoxb-secret",
            SLACK_TEAM_ID: "T123",
          },
          enabled: true,
          timeout: 5_000,
        },
      },
    };

    expect(buildCodexRuntimeConfig(config, { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" })).toEqual({
      model_provider: "openai",
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      web_search: "disabled",
      apps: {
        _default: { enabled: false },
        connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
      },
      mcp_servers: {
        "local-slack": {
          command: "node",
          args: ["/app/local-slack/server.js"],
          env_vars: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
          enabled: true,
          startup_timeout_ms: 5_000,
        },
      },
    });
  });

  it("routes OpenAI gateway session keys through the control-plane gateway", () => {
    expect(
      buildCodexRuntimeConfig(
        {},
        {
          ARCANIST_OPENAI_GATEWAY_ENABLED: "1",
          OPENAI_API_KEY: "arc-gw-test",
          CONTROL_PLANE_URL: "https://qa.app.trycycloid.com",
        },
      ),
    ).toMatchObject({
      model_provider: "openai",
      openai_base_url: "https://qa.app.trycycloid.com/openai",
    });
  });

  it("routes OpenAI gateway session keys without duplicating gateway config", () => {
    expect(
      buildCodexRuntimeConfig(
        {},
        {
          ARCANIST_OPENAI_GATEWAY_ENABLED: "1",
          OPENAI_API_KEY: "arc-gw-test",
          CONTROL_PLANE_URL: "https://qa.app.trycycloid.com",
        },
      ),
    ).toMatchObject({
      model_provider: "openai",
      openai_base_url: "https://qa.app.trycycloid.com/openai",
    });
  });

  it("keeps OpenAI gateway env auth when stored Codex auth exists", async () => {
    vi.stubEnv("OPENAI_API_KEY", "arc-gw-test");
    vi.stubEnv("ARCANIST_OPENAI_GATEWAY_ENABLED", "1");
    vi.stubEnv("CONTROL_PLANE_URL", "https://qa.app.trycycloid.com");
    const codexHome = join(tmpdir(), `codex-home-gateway-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    const harness = createSpawnHarness();

    try {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), "{}\n", "utf8");

      const result = await createCodexWithStdio({
        agentRole: "implementation",
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const runtimeConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      const spawnEnv = harness.spawn.mock.calls[0]?.[2]?.env as Record<string, string> | undefined;

      expect(runtimeConfig).toContain('openai_base_url = "https://qa.app.trycycloid.com/openai"');
      expect(spawnEnv?.OPENAI_API_KEY).toBe("arc-gw-test");
      expect(spawnEnv?.CODEX_API_KEY).toBe("arc-gw-test");

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("omits service_tier from runtime config by default", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const codexHome = join(tmpdir(), `codex-home-default-tier-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const runtimeConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(runtimeConfig).not.toContain("service_tier");
      expect(runtimeConfig).toContain(`tool_output_token_limit = ${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`);

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("writes flex service_tier when the session config opts in", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const codexHome = join(tmpdir(), `codex-home-flex-tier-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        config: { model: "openai/gpt-5.5" },
        useOpenAIFlexServiceTier: true,
        spawn: harness.spawn as never,
      });
      const runtimeConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(runtimeConfig).toContain('service_tier = "flex"');

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("fails closed when OpenAI gateway routing is enabled without a Cycloid gateway key", () => {
    expect(() =>
      buildCodexRuntimeConfig(
        {},
        {
          ARCANIST_OPENAI_GATEWAY_ENABLED: "1",
          OPENAI_API_KEY: "sk-real-openai-key",
          CONTROL_PLANE_URL: "https://qa.app.trycycloid.com",
        },
      ),
    ).toThrow("ARCANIST_OPENAI_GATEWAY_ENABLED requires a Cycloid OpenAI gateway API key");
  });

  it("fails closed when OpenAI gateway routing lacks a control-plane URL", () => {
    expect(() =>
      buildCodexRuntimeConfig(
        {},
        {
          ARCANIST_OPENAI_GATEWAY_ENABLED: "1",
          OPENAI_API_KEY: "arc-gw-test",
        },
      ),
    ).toThrow("CONTROL_PLANE_URL is required when ARCANIST_OPENAI_GATEWAY_ENABLED=1");
  });

  it("does not report disabled startup MCP servers as connected", async () => {
    const { client } = createMockTransport({
      mcpStatus: { enabled: { status: "connected" } },
    });

    expect(await client.mcp.status()).toEqual({ data: { enabled: { status: "connected" } } });

    client.close();
  });

  it("forwards Codex project-doc config without requiring MCP config", () => {
    expect(
      buildCodexRuntimeConfig({
        project_doc_fallback_filenames: ["CLAUDE.md", "agents.md"],
        project_root_markers: [".git"],
        project_doc_max_bytes: 60_000,
      }),
    ).toEqual({
      model_provider: "openai",
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      web_search: "disabled",
      apps: {
        _default: { enabled: false },
        connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
      },
      project_doc_fallback_filenames: ["CLAUDE.md", "agents.md"],
      project_root_markers: [".git"],
      project_doc_max_bytes: 60_000,
    });
  });

  it("does not register managed memory hooks outside E2B without explicit opt-in", () => {
    const result = buildCodexRuntimeConfig(
      {},
      {
        ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
      },
    );

    expect(result.hooks).toBeUndefined();
  });

  it("does not register managed memory hooks by default in E2B", () => {
    const result = buildCodexRuntimeConfig(
      {},
      {
        ARCANIST_RUNTIME_PROVIDER: "e2b",
        ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
      },
    );

    expect(result.hooks).toBeUndefined();
  });

  it("registers managed memory hooks when explicitly enabled", () => {
    const result = buildCodexRuntimeConfig(
      {},
      {
        ARCANIST_CODEX_MEMORY_HOOKS: "1",
        ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
      },
    );

    expect(result.hooks?.UserPromptSubmit?.[0].hooks[0].command).toBe(
      `${JSON.stringify(process.execPath)} "/app/bridge/bundle.js" --memory-hook`,
    );
    expect(result.hooks?.PreToolUse).toEqual([{ matcher: "*", hooks: [expect.objectContaining({ type: "command" })] }]);
    expect(result.hooks?.PostToolUse?.[0].matcher).toBe("*");
    expect(result.hooks?.Stop?.[0].hooks[0].type).toBe("command");
  });

  it("registers managed memory hooks when memory tools are enabled", () => {
    const result = buildCodexRuntimeConfig(
      {},
      {
        ARCANIST_MEMORY_TOOLS_ENABLED: "1",
        ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
      },
    );

    expect(result.hooks?.UserPromptSubmit?.[0].hooks[0].command).toBe(
      `${JSON.stringify(process.execPath)} "/app/bridge/bundle.js" --memory-hook`,
    );
    expect(result.hooks?.PreToolUse?.[0].matcher).toBe("*");
    expect(result.hooks?.PostToolUse?.[0].matcher).toBe("*");
    expect(result.hooks?.Stop?.[0].hooks[0].type).toBe("command");
  });

  it("does not register managed memory hooks in E2B when explicitly disabled", () => {
    const result = buildCodexRuntimeConfig(
      {},
      {
        ARCANIST_RUNTIME_PROVIDER: "e2b",
        ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
        ARCANIST_MEMORY_TOOLS_ENABLED: "1",
        ARCANIST_CODEX_MEMORY_HOOKS: "0",
      },
    );

    expect(result.hooks).toBeUndefined();
  });

  it("writes managed memory hooks inline and removes legacy hook files", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ARCANIST_RUNTIME_PROVIDER", "e2b");
    vi.stubEnv("ARCANIST_BRIDGE_BUNDLE_PATH", "/app/bridge/bundle.js");
    vi.stubEnv("ARCANIST_CODEX_MEMORY_HOOKS", "1");
    const codexHome = join(tmpdir(), `codex-home-hooks-${randomUUID()}`);
    const cwd = join(tmpdir(), `codex-cwd-hooks-${randomUUID()}`);
    vi.stubEnv("CODEX_HOME", codexHome);
    const harness = createSpawnHarness();

    try {
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(join(cwd, ".codex"), { recursive: true });
      writeFileSync(join(codexHome, "hooks.json"), "{}\n", "utf8");
      writeFileSync(join(cwd, ".codex", "hooks.json"), "{}\n", "utf8");
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd,
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });

      const runtimeConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      const expectedHookCommand = `${JSON.stringify(process.execPath)} "/app/bridge/bundle.js" --memory-hook`;
      expect(runtimeConfig).toContain("[[hooks.UserPromptSubmit]]");
      expect(runtimeConfig).toContain("[[hooks.UserPromptSubmit.hooks]]");
      expect(runtimeConfig).toContain("[[hooks.PreToolUse]]");
      expect(runtimeConfig).toContain('command = "\\"');
      expect(runtimeConfig).toContain(`command = ${JSON.stringify(expectedHookCommand)}`);
      expect(runtimeConfig).toContain('matcher = "*"');
      expect(runtimeConfig).not.toContain("[features]");
      expect(runtimeConfig).not.toContain("codex_hooks");
      expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
      expect(existsSync(join(cwd, ".codex", "hooks.json"))).toBe(false);

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("drops invalid project-doc config values fail-closed", () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const warn = (message: string, fields: Record<string, unknown>) => warnings.push({ message, fields });
    const invalidProjectDocConfig = {
      project_doc_fallback_filenames: ["CLAUDE.md", 1],
      project_root_markers: [".git", false],
      project_doc_max_bytes: -1,
    } as unknown as Parameters<typeof buildCodexRuntimeConfig>[0];

    expect(buildCodexRuntimeConfig(invalidProjectDocConfig, {}, warn)).toEqual({
      model_provider: "openai",
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      web_search: "disabled",
      apps: {
        _default: { enabled: false },
        connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
      },
    });
    expect(buildCodexRuntimeConfig({ project_doc_max_bytes: 1.5 }, {}, warn)).toEqual({
      model_provider: "openai",
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      web_search: "disabled",
      apps: {
        _default: { enabled: false },
        connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
      },
    });
    expect(buildCodexRuntimeConfig({ project_doc_max_bytes: 0 }, {}, warn)).toEqual({
      model_provider: "openai",
      tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      web_search: "disabled",
      apps: {
        _default: { enabled: false },
        connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
      },
      project_doc_max_bytes: 0,
    });
    expect(warnings).toEqual([
      {
        message: "Ignoring invalid project_doc_max_bytes; expected a non-negative integer",
        fields: { value: -1 },
      },
      {
        message: "Ignoring invalid project_doc_max_bytes; expected a non-negative integer",
        fields: { value: 1.5 },
      },
    ]);
  });

  it("fails closed when a secret-like remote MCP header cannot be mapped to an env var", () => {
    const config = {
      mcp: {
        "custom-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      },
    };

    expect(() => buildCodexRuntimeConfig(config, {})).toThrow(
      "Remote MCP header 'Authorization' for 'custom-remote' must be provided via env indirection",
    );
  });

  it.each(["Proxy-Authorization", "X-Auth-Token", "X-Access-Token", "Private-Token"])(
    "fails closed for common secret-bearing remote MCP header names without env indirection: %s",
    (headerName) => {
      const config = {
        mcp: {
          "custom-remote": {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { [headerName]: "opaque-secret-token" },
          },
        },
      };

      expect(() => buildCodexRuntimeConfig(config, {})).toThrow(
        `Remote MCP header '${headerName}' for 'custom-remote' must be provided via env indirection`,
      );
    },
  );

  it("warns and embeds non-secret remote MCP headers when no matching env var exists", () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const config = {
      mcp: {
        "custom-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { "X-Feature-Flag": "enabled" },
        },
      },
    };

    const result = buildCodexRuntimeConfig(config, {}, (message, fields) => warnings.push({ message, fields }));

    expect(result.mcp_servers?.["custom-remote"]).toMatchObject({
      url: "https://example.com/mcp",
      http_headers: { "X-Feature-Flag": "enabled" },
    });
    expect(warnings).toEqual([
      {
        message: expect.stringContaining("embedding raw value in http_headers"),
        fields: { serverName: "custom-remote", headerName: "X-Feature-Flag" },
      },
    ]);
  });

  it("warns and embeds long non-secret remote MCP header values when no matching env var exists", () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const workspaceId = "d3NfMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A=";
    const config = {
      mcp: {
        "custom-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { "X-Workspace-Id": workspaceId },
        },
      },
    };

    const result = buildCodexRuntimeConfig(config, {}, (message, fields) => warnings.push({ message, fields }));

    expect(result.mcp_servers?.["custom-remote"]).toMatchObject({
      url: "https://example.com/mcp",
      http_headers: { "X-Workspace-Id": workspaceId },
    });
    expect(warnings).toEqual([
      {
        message: expect.stringContaining("embedding raw value in http_headers"),
        fields: { serverName: "custom-remote", headerName: "X-Workspace-Id" },
      },
    ]);
  });

  it("maps Authorization headers to AUTHORIZATION env vars for remote MCP servers", () => {
    const config = {
      mcp: {
        "custom-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      },
    };

    const result = buildCodexRuntimeConfig(config, { AUTHORIZATION: "Bearer secret-token" });

    expect(result.mcp_servers?.["custom-remote"]).toMatchObject({
      url: "https://example.com/mcp",
      env_http_headers: { Authorization: "AUTHORIZATION" },
    });
    expect(result.mcp_servers?.["custom-remote"]).not.toHaveProperty("http_headers");
  });

  it("keeps managed remote MCP authorization headers env-backed in Codex runtime config", () => {
    const config = {
      mcp: {
        "cycloid-mcp_1": {
          type: "remote",
          url: "https://mcp.example.com",
          env_http_headers: { Authorization: "DOCS_MCP_TOKEN" },
        },
      },
    };

    const result = buildCodexRuntimeConfig(config, { DOCS_MCP_TOKEN: "Bearer managed-secret" });

    expect(result.mcp_servers?.["cycloid-mcp_1"]).toMatchObject({
      url: "https://mcp.example.com",
      env_http_headers: { Authorization: "DOCS_MCP_TOKEN" },
    });
    expect(result.mcp_servers?.["cycloid-mcp_1"]).not.toHaveProperty("http_headers");
  });

  it("warns when a remote MCP server's oauth config is dropped during translation", () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const config = {
      mcp: {
        "oauth-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: { clientId: "abc", clientSecret: "shh" },
        },
      },
    };

    const result = buildCodexRuntimeConfig(config, {}, (message, fields) => warnings.push({ message, fields }));

    expect(result.mcp_servers?.["oauth-remote"]).toEqual({ url: "https://example.com/mcp" });
    expect(warnings).toEqual([
      {
        message: expect.stringContaining("oauth config dropped"),
        fields: { serverName: "oauth-remote" },
      },
    ]);
  });

  it("does not warn about oauth when the remote server explicitly opts out via oauth: false", () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const config = {
      mcp: {
        "no-oauth": {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: false,
        },
      },
    };

    buildCodexRuntimeConfig(config, {}, (message, fields) => warnings.push({ message, fields }));

    expect(warnings).toEqual([]);
  });

  it("starts Codex turns with full sandbox access and no approvals", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [], model: "openai/gpt-5.4-mini" },
    });

    expect(transport.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        model: "openai/gpt-5.5",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        modelProvider: "openai",
      }),
      expect.any(Number),
    );
    expect(transport.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: session.data.id,
        model: "openai/gpt-5.4-mini",
        approvalPolicy: "never",
      }),
      expect.any(Number),
    );

    client.close();
  });

  it("retries transient thread/start setup failures", async () => {
    vi.useFakeTimers();
    let threadStartAttempts = 0;
    const { client, transport } = createMockTransport({
      onRequest: (method) => {
        if (method !== "thread/start") return undefined;
        threadStartAttempts += 1;
        if (threadStartAttempts < 3) throw transientSetupError();
        return { thread: { id: "thread-retried" } };
      },
    });

    try {
      const sessionPromise = client.session.create();
      await vi.runAllTimersAsync();
      await expect(sessionPromise).resolves.toEqual({ data: { id: "thread-retried" } });
      expect(transport.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(3);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it("retries transient thread/resume setup failures before prompting restored sessions", async () => {
    vi.useFakeTimers();
    let resumeAttempts = 0;
    const { client, transport } = createMockTransport({
      onRequest: (method) => {
        if (method !== "thread/resume") return undefined;
        resumeAttempts += 1;
        if (resumeAttempts < 3) throw transientSetupError();
        return { thread: { id: "restored-thread" } };
      },
    });

    try {
      await client.session.get({ path: { id: "restored-thread" } });
      const promptPromise = client.session.promptAsync({
        path: { id: "restored-thread" },
        body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [] },
      });
      await vi.runAllTimersAsync();
      await expect(promptPromise).resolves.toEqual({ data: { ok: true } });
      expect(transport.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(3);
      expect(transport.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it("writes a runtime config that disables native Codex apps for Cycloid sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const codexHome = `${CODEX_HOME_PREFIX}${randomUUID()}`;
    rmSync(codexHome, { recursive: true, force: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });

      const runtimeConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(runtimeConfig).toContain("[apps._default]");
      expect(runtimeConfig).toContain("enabled = false");
      expect(runtimeConfig).toContain("[apps.connector_76869538009648d5b282a4bb21c3d157]");

      result.server.close();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("passes uploaded data-url images to app-server as local image files and cleans them up on completion", async () => {
    const { client, transport, emit } = createMockTransport();
    const session = await client.session.create();
    const pngBytes = Buffer.from("image-bytes");

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [
          { type: "text", text: "Describe this screenshot" },
          {
            type: "file",
            mime: "image/png",
            filename: "screenshot.png",
            url: `data:image/png;base64,${pngBytes.toString("base64")}`,
          },
        ],
      },
    });

    const turnStartCall = transport.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall).toBeDefined();
    const input = turnStartCall?.[1].input as Array<Record<string, string>>;
    expect(input[0]).toEqual({ type: "text", text: "Describe this screenshot", text_elements: [] });
    expect(input[1].type).toBe("localImage");
    expect(readFileSync(input[1].path)).toEqual(pngBytes);

    emit("turn/completed", {
      threadId: session.data.id,
      turn: { id: "turn-1", status: "completed", error: null },
    });

    expect(existsSync(input[1].path)).toBe(false);
    client.close();
  });

  it("injects known dynamic-tool images into the next Codex turn before the next desktop action", async () => {
    vi.stubEnv("ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE", "1");
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    const response = await transport.onServerRequest?.({
      id: "tool-image-1",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-image-1",
        namespace: "cycloid",
        tool: KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
        arguments: { scenarioId: `codex-feedback-${randomUUID()}`, detail: "high" },
      },
    });

    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining('"fixture":"known_image"') }],
    });
    expect(JSON.stringify(response)).not.toContain("inputImage");

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Now decide whether to click the desktop." }],
      },
    });

    const turnStartCall = transport.request.mock.calls.find(([method]) => method === "turn/start");
    const input = turnStartCall?.[1].input as Array<Record<string, string>>;
    expect(input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("# Desktop Image Feedback"),
      text_elements: [],
    });
    expect(input[0].text).toContain("before deciding any next desktop or CUA action");
    expect(input[1]).toEqual({ type: "localImage", path: expect.stringContaining("known-image.png") });
    expect(existsSync(input[1].path)).toBe(true);
    expect(input[2]).toEqual({
      type: "text",
      text: "Now decide whether to click the desktop.",
      text_elements: [],
    });

    client.close();
  });

  it("interrupts and restarts the active Codex turn with dynamic-tool image feedback", async () => {
    vi.stubEnv("ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE", "1");
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Use the desktop to inspect the page." }],
      },
    });

    const response = await transport.onServerRequest?.({
      id: "tool-image-active-turn",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-image-active-turn",
        namespace: "cycloid",
        tool: KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
        arguments: { scenarioId: `codex-active-feedback-${randomUUID()}`, detail: "high" },
      },
    });

    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining('"fixture":"known_image"') }],
    });

    const interruptCall = transport.request.mock.calls.find(([method]) => method === "turn/interrupt");
    expect(interruptCall).toEqual([
      "turn/interrupt",
      { threadId: session.data.id, turnId: "turn-1" },
      expect.any(Number),
    ]);

    const turnStartCalls = transport.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turnStartCalls).toHaveLength(2);
    const restartedInput = turnStartCalls[1]?.[1].input as Array<Record<string, string>>;
    expect(restartedInput[0]).toEqual({
      type: "text",
      text: expect.stringContaining("# Desktop Image Feedback"),
      text_elements: [],
    });
    expect(restartedInput[1]).toEqual({ type: "localImage", path: expect.stringContaining("known-image.png") });
    expect(restartedInput[2]).toEqual({
      type: "text",
      text: "Use the desktop to inspect the page.",
      text_elements: [],
    });

    client.close();
  });

  it("requeues dynamic-tool image feedback once when the active-turn restart fails", async () => {
    vi.stubEnv("ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE", "1");
    let turnStartCount = 0;
    const { client, transport } = createMockTransport({
      onRequest: (method) => {
        if (method !== "turn/start") return undefined;
        turnStartCount += 1;
        if (turnStartCount === 2) {
          throw new Error("restart failed");
        }
        return { turn: { id: `turn-${turnStartCount}` } };
      },
    });
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Use the desktop to inspect the page." }],
      },
    });

    await expect(
      transport.onServerRequest?.({
        id: "tool-image-requeue",
        method: "item/tool/call",
        params: {
          threadId: session.data.id,
          turnId: "turn-1",
          itemId: "item-image-requeue",
          namespace: "cycloid",
          tool: KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
          arguments: { scenarioId: `codex-requeue-feedback-${randomUUID()}`, detail: "high" },
        },
      }),
    ).resolves.toMatchObject({ success: true });

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Try again." }],
      },
    });

    const turnStartCalls = transport.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turnStartCalls).toHaveLength(3);
    const retryInput = turnStartCalls[2]?.[1].input as Array<Record<string, string>>;
    const feedbackTexts = retryInput.filter(
      (part) => part.type === "text" && part.text.includes("# Desktop Image Feedback"),
    );
    expect(feedbackTexts).toHaveLength(1);
    expect(retryInput[1]).toEqual({ type: "localImage", path: expect.stringContaining("known-image.png") });
    expect(retryInput[2]).toEqual({ type: "text", text: "Try again.", text_elements: [] });

    client.close();
  });

  it("does not treat JSON-serialized contentItems alone as sufficient Codex image feedback", async () => {
    const capability = resolveCodexImageFeedbackCapability({
      nativeToolResultImages: false,
      syntheticImageContext: false,
      jsonSerializedContentItems: true,
    });
    const adapted = adaptCodexDynamicToolResultForImageFeedback({
      capability,
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: '{"ok":true}' },
          {
            type: "inputImage",
            path: "/tmp/phase-evidence/desktop/scenario/known-image.png",
            mimeType: "image/png",
            label: "known",
            detail: "high",
            width: KNOWN_IMAGE_FIXTURE_WIDTH,
            height: KNOWN_IMAGE_FIXTURE_HEIGHT,
            bytes: 1024,
          },
        ],
      },
    });

    expect(capability).toEqual({
      supported: false,
      reason: "json_only_content_items_not_model_visible",
      fixture: "known_image_fixture",
    });
    expect(adapted.syntheticImageFeedback).toEqual([]);
    expect(adapted.unsupportedReason).toBe("json_only_content_items_not_model_visible");
    expect(JSON.stringify(adapted.result.contentItems)).not.toContain("inputImage");
  });

  it("keeps desktop tools and emits unsupported telemetry when both Codex image delivery paths fail", () => {
    const unsupportedCapability = resolveCodexImageFeedbackCapability({
      nativeToolResultImages: false,
      syntheticImageContext: false,
      jsonSerializedContentItems: false,
    });
    const emitted: unknown[] = [];
    const specs = filterCodexDesktopDynamicToolSpecsForImageFeedback({
      capability: unsupportedCapability,
      modelId: "gpt-5.5",
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

    expect(specs.map((spec) => `${spec.namespace}.${spec.name}`)).toEqual(["desktop.click", "cycloid.memory_recall"]);
    expect(emitted).toEqual([
      {
        event: "desktop.model_image_feedback_unsupported",
        backend: "codex",
        modelId: "gpt-5.5",
        reason: "no_delivery_path_available",
        registrationBlocked: false,
      },
    ]);
  });

  it("emits session.error with structured errorCode and Codex metadata from turn/completed failures", async () => {
    const { client, emit } = createMockTransport();
    try {
      const session = await client.session.create();
      const { stream } = await client.event.subscribe();
      const iterator = stream[Symbol.asyncIterator]();

      emit("turn/completed", {
        threadId: session.data.id,
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "Internal Server Error while steering review turn",
            codexErrorInfo: { name: "BadRequest", httpStatusCode: 400 },
            additionalDetails: "cannot steer a review turn",
          },
        },
      });

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: "session.error",
          properties: {
            sessionID: session.data.id,
            errorCode: "codex_unrecoverable",
            codexErrorInfo: { name: "BadRequest", httpStatusCode: 400 },
            additionalDetails: "cannot steer a review turn",
            error: {
              name: "CodexTurnFailed",
              data: { message: "Internal Server Error while steering review turn" },
            },
          },
        },
      });
    } finally {
      client.close();
    }
  });

  it("cleans up materialized images when turn/start rejects before a turn is created", async () => {
    let materializedPath = "";
    const { client } = createMockTransport({
      onRequest: (method, params) => {
        if (method !== "turn/start") return undefined;
        const input = (params?.input as Array<Record<string, string>> | undefined) ?? [];
        materializedPath = String(input[1]?.path ?? "");
        throw new Error("turn start failed");
      },
    });
    const session = await client.session.create();
    const pngBytes = Buffer.from("image-bytes");

    await expect(
      client.session.promptAsync({
        path: { id: session.data.id },
        body: {
          sandboxPolicy: EXECUTE_SANDBOX_POLICY,
          parts: [
            { type: "text", text: "Describe this screenshot" },
            {
              type: "file",
              mime: "image/png",
              filename: "screenshot.png",
              url: `data:image/png;base64,${pngBytes.toString("base64")}`,
            },
          ],
        },
      }),
    ).rejects.toThrow("turn start failed");

    expect(materializedPath).toMatch(/screenshot\.png$/);
    expect(existsSync(materializedPath)).toBe(false);
    client.close();
  });

  it("passes reasoning summaries through to turn/start when requested", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Investigate this bug" }],
        model: "openai/gpt-5.5",
        variant: "medium",
        summary: "concise",
      },
    });

    expect(transport.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: session.data.id,
        model: "openai/gpt-5.5",
        effort: "medium",
        summary: "concise",
      }),
      expect.any(Number),
    );

    client.close();
  });

  it("omits reasoning summary on turn/start when the value is unsupported", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "Investigate this bug" }],
        model: "openai/gpt-5.5",
        variant: "medium",
        summary: "none",
      },
    });

    const turnStartCall = transport.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).not.toHaveProperty("summary");
    client.close();
  });

  it("re-emits message.part.updated on every reasoning summaryTextDelta so the UI accumulates full reasoning text", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/started", {
      threadId: session.data.id,
      item: { type: "reasoning", id: "reason-1", content: [], summary: [] },
    });

    emit("item/reasoning/summaryTextDelta", {
      threadId: session.data.id,
      itemId: "reason-1",
      summaryIndex: 0,
      delta: "Let me ",
    });
    emit("item/reasoning/summaryTextDelta", {
      threadId: session.data.id,
      itemId: "reason-1",
      summaryIndex: 0,
      delta: "investigate ",
    });
    emit("item/reasoning/summaryTextDelta", {
      threadId: session.data.id,
      itemId: "reason-1",
      summaryIndex: 0,
      delta: "the bug.",
    });

    // First emit: message.updated (role broadcast) — driven by item/started or the first delta path.
    // We don't assert its position; just consume reasoning-part updates and assert the accumulated text.
    const reasoningTexts: string[] = [];
    while (reasoningTexts.length < 3) {
      const { value, done } = await iterator.next();
      if (done) break;
      const evt = value as { type: string; properties?: { part?: { type?: string; text?: string } } };
      if (evt.type === "message.part.updated" && evt.properties?.part?.type === "reasoning") {
        reasoningTexts.push(evt.properties.part.text ?? "");
      }
    }

    expect(reasoningTexts).toEqual(["Let me ", "Let me investigate ", "Let me investigate the bug."]);
    client.close();
  });

  it("does not overwrite reasoning content with summary deltas once a textDelta stream has produced content", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/started", {
      threadId: session.data.id,
      item: { type: "reasoning", id: "reason-2", content: [], summary: [] },
    });
    emit("item/reasoning/textDelta", {
      threadId: session.data.id,
      itemId: "reason-2",
      contentIndex: 0,
      delta: "real reasoning",
    });
    emit("item/reasoning/summaryTextDelta", {
      threadId: session.data.id,
      itemId: "reason-2",
      summaryIndex: 0,
      delta: "summary chunk",
    });

    const reasoningTexts: string[] = [];
    while (reasoningTexts.length < 1) {
      const { value, done } = await iterator.next();
      if (done) break;
      const evt = value as { type: string; properties?: { part?: { type?: string; text?: string } } };
      if (evt.type === "message.part.updated" && evt.properties?.part?.type === "reasoning") {
        reasoningTexts.push(evt.properties.part.text ?? "");
      }
    }

    // Only the textDelta produced a reasoning part — the subsequent summary delta must not emit
    // (would otherwise overwrite the real content stream). Drain any queued events on a real
    // timer tick to reliably catch a spurious emission.
    expect(reasoningTexts).toEqual(["real reasoning"]);
    const drained: Array<{ type: string; properties?: { part?: { type?: string } } }> = [];
    let drainTimeout: ReturnType<typeof setTimeout> | null = null;
    const drain = new Promise<void>((resolve) => {
      drainTimeout = setTimeout(resolve, 20);
    });
    const consume = (async () => {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) return;
        drained.push(value as { type: string; properties?: { part?: { type?: string } } });
      }
    })();
    await Promise.race([consume, drain]);
    if (drainTimeout) clearTimeout(drainTimeout);
    const spuriousReasoning = drained.some(
      (evt) => evt.type === "message.part.updated" && evt.properties?.part?.type === "reasoning",
    );
    expect(spuriousReasoning).toBe(false);
    client.close();
  });

  it("does not pass caller-supplied local_image paths through to app-server", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "local_image", path: "/tmp/secret.env" } as never],
      },
    });

    const turnStartCall = transport.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1].input).toEqual([]);
    client.close();
  });

  it("omits empty text entries for image-only prompts", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "only-image.png",
            url: `data:image/png;base64,${Buffer.from("image-only").toString("base64")}`,
          },
        ],
      },
    });

    const turnStartCall = transport.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1].input).toEqual([{ type: "localImage", path: expect.stringMatching(/only-image\.png$/) }]);
    client.close();
  });

  it("surfaces disabled web_search items as raw_agent_runtime events instead of tool calls", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/completed", {
      threadId: session.data.id,
      turnId: "turn-1",
      item: { type: "webSearch", id: "web-search-1", query: "latest docs" },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "raw_agent_runtime",
        properties: {
          sessionID: session.data.id,
          itemType: "webSearch",
          item: expect.objectContaining({
            id: "web-search-1",
            query: "latest docs",
          }),
        },
      },
    });

    client.close();
  });

  it("forwards non-apply_patch custom tool outputs as raw_agent_runtime events", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/completed", {
      threadId: session.data.id,
      turnId: "turn-1",
      item: {
        type: "customToolCallOutput",
        id: "custom-output-1",
        callId: "call-other-1",
        name: "computer_use",
        status: "completed",
        output: "clicked",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "raw_agent_runtime",
        properties: {
          sessionID: session.data.id,
          itemType: "customToolCallOutput",
          item: expect.objectContaining({
            id: "custom-output-1",
            callId: "call-other-1",
            name: "computer_use",
          }),
        },
      },
    });

    client.close();
  });

  it("materializes MCP image results under runtime evidence for artifact upload", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const images = [
      { bytes: Buffer.from("direct-url-bytes") },
      { bytes: Buffer.from("openai-image-url-bytes") },
      { bytes: Buffer.from("mime-type-bytes") },
      { bytes: Buffer.from("mime-type-snake-bytes") },
      { bytes: Buffer.from("source-media-type-bytes") },
      { bytes: Buffer.from("source-mime-type-bytes") },
      { bytes: Buffer.from("source-mime-type-snake-bytes") },
    ];
    const callId = `screenshot-call-${randomUUID()}`;
    const expectedPaths = images.map((_, index) =>
      join(RUNTIME_EVIDENCE_DIR, "mcp-tool-results", `agent-browser-captureScreenshot-${callId}-${index + 1}.png`),
    );
    const ignoredPath = join(
      RUNTIME_EVIDENCE_DIR,
      "mcp-tool-results",
      `agent-browser-captureScreenshot-${callId}-8.png`,
    );

    try {
      emit("item/completed", {
        threadId: session.data.id,
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: callId,
          server: "agent-browser",
          tool: "captureScreenshot",
          status: "completed",
          arguments: {},
          result: {
            content: [
              {
                type: "image",
                url: `data:image/png;base64,${images[0].bytes.toString("base64")}`,
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${images[1].bytes.toString("base64")}` },
              },
              {
                type: "image",
                data: images[2].bytes.toString("base64"),
                mimeType: "image/png",
              },
              {
                type: "image",
                data: images[3].bytes.toString("base64"),
                mime_type: "image/png",
              },
              {
                type: "image",
                source: {
                  data: images[4].bytes.toString("base64"),
                  media_type: "image/png",
                },
              },
              {
                type: "image",
                source: {
                  data: images[5].bytes.toString("base64"),
                  mimeType: "image/png",
                },
              },
              {
                type: "image",
                source: {
                  data: images[6].bytes.toString("base64"),
                  mime_type: "image/png",
                },
              },
              {
                type: "image",
                data: Buffer.from("ignored-root-media-type-bytes").toString("base64"),
                media_type: "image/png",
              },
            ],
          },
          error: null,
        },
      });

      for (const [index, image] of images.entries()) {
        expect(readFileSync(expectedPaths[index])).toEqual(image.bytes);
      }
      expect(existsSync(ignoredPath)).toBe(false);
    } finally {
      for (const path of expectedPaths) {
        rmSync(path, { force: true });
      }
      rmSync(ignoredPath, { force: true });
      client.close();
    }
  });

  it("ignores malformed MCP image result shapes", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const callId = `screenshot-call-${randomUUID()}`;
    const possiblePaths = [1, 2, 3].map((index) =>
      join(RUNTIME_EVIDENCE_DIR, "mcp-tool-results", `agent-browser-captureScreenshot-${callId}-${index}.png`),
    );

    try {
      emit("item/completed", {
        threadId: session.data.id,
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: callId,
          server: "agent-browser",
          tool: "captureScreenshot",
          status: "completed",
          arguments: {},
          result: {
            content: [
              { type: "image", url: "https://example.com/not-a-data-url.png" },
              { type: "image_url", image_url: { url: "data:image/png;base64,not-valid-base64!" } },
              { type: "image", data: Buffer.from("missing-root-mime").toString("base64") },
              { type: "image", data: Buffer.from("root-media-type").toString("base64"), media_type: "image/png" },
              { type: "image", mimeType: "image/png" },
              { type: "image", source: { data: Buffer.from("missing-source-mime").toString("base64") } },
              { type: "image", source: { mimeType: "image/png" } },
              { type: "image", data: Buffer.from("not-image-mime").toString("base64"), mimeType: "text/plain" },
            ],
          },
          error: null,
        },
      });

      for (const path of possiblePaths) {
        expect(existsSync(path)).toBe(false);
      }
    } finally {
      for (const path of possiblePaths) {
        rmSync(path, { force: true });
      }
      client.close();
    }
  });

  it("attributes usage to the requested prompt model", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [], model: "openai/gpt-5.4-mini" },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.status",
        properties: { sessionID: session.data.id, status: { type: "running" } },
      },
    });

    emit("thread/tokenUsage/updated", {
      threadId: session.data.id,
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 3,
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.updated",
        properties: { info: { sessionID: session.data.id, modelID: "gpt-5.4-mini" } },
      },
    });
    client.close();
  });

  it("broadcasts running status as soon as turn/start is accepted", async () => {
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.status",
        properties: {
          sessionID: session.data.id,
          status: { type: "running" },
        },
      },
    });

    emit("turn/started", {
      threadId: session.data.id,
      turn: { id: "turn-1" },
    });
    emit("thread/tokenUsage/updated", {
      threadId: session.data.id,
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.updated",
        properties: { info: { sessionID: session.data.id, modelID: "gpt-5.5" } },
      },
    });
    client.close();
  });

  it("surfaces question requests through the app-server request handler and accepts replies", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();

    const responsePromise = transport.onServerRequest?.({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          {
            id: "pick_one",
            header: "Choice",
            question: "Which approach do you prefer?",
            isOther: false,
            isSecret: false,
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    });

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: session.data.id,
          questions: [{ question: "Which approach do you prefer?" }],
        },
      },
    });

    await expect(client.question.reply({ id: "question-1", answer: "A" })).resolves.toEqual({ data: { ok: true } });
    await expect(responsePromise).resolves.toEqual({
      answers: { pick_one: { answers: ["A"] } },
    });
    client.close();
  });

  it("answers an empty-questions request immediately without broadcasting a blank question", async () => {
    const { client, transport } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();

    // A requestUserInput whose questions array is empty must not register a
    // pending response and stall the prompt awaiting an answer to nothing.
    const responsePromise = transport.onServerRequest?.({
      id: "question-empty",
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [],
      },
    });

    await expect(responsePromise).resolves.toEqual({ answers: {} });

    // No question.asked should reach the event stream; the next event is the
    // session-level idle/turn signal, never a blank question.
    const next = await Promise.race([
      stream[Symbol.asyncIterator]().next(),
      new Promise((resolve) => setTimeout(() => resolve({ value: { type: "__timeout__" } }), 50)),
    ]);
    expect((next as { value?: { type?: string } }).value?.type).not.toBe("question.asked");
    client.close();
  });

  it("executes Sentry dynamic tool calls through the app-server request handler", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("SENTRY_ACCESS_TOKEN", "sentry-token");
    vi.stubEnv("SENTRY_ORGANIZATION_SLUG", "acme");
    const harness = createSpawnHarness();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (href.endsWith("/organizations/acme/issues/123/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            shortId: "WEB-123",
            title: "Broken checkout",
            permalink: "https://sentry.io/organizations/acme/issues/123/",
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/organizations/acme/issues/123/events/latest/")) {
        return new Response(
          JSON.stringify({
            id: "evt-1",
            eventID: "evt-1",
            title: "TypeError",
            permalink: "https://sentry.io/organizations/acme/issues/123/events/evt-1/",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();

    harness.send({
      id: "tool-1",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        namespace: "sentry",
        tool: "lookup_issue",
        arguments: { reference: "123" },
      },
    });
    await harness.waitForRequestMatching((request) => request.id === "tool-1" && !request.method);

    const toolResponse = harness.requests.find((request) => request.id === "tool-1" && !request.method);
    expect(toolResponse).toMatchObject({
      id: "tool-1",
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining('"resolvedFrom":"issue_id"'),
          },
        ],
      },
    });

    result.server.close();
  });

  it.skipIf(!MEMORY_FEATURE_DISABLED)("returns not_registered for memory_recall while memory is disabled", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const repoPath = join(tmpdir(), `cycloid-codex-memory-${randomUUID()}`);
    mkdirSync(repoPath, { recursive: true });
    const harness = createSpawnHarness();

    try {
      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: repoPath,
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      const session = await result.client.session.create();

      harness.send({
        id: "memory-tool-1",
        method: "item/tool/call",
        params: {
          threadId: session.data.id,
          turnId: "turn-1",
          itemId: "item-memory-1",
          namespace: "cycloid",
          tool: "memory_recall",
          arguments: {
            intent: "Patch auth route",
            files: ["apps/control-plane-worker/src/auth/routes.ts"],
            symbols: ["verifyUserRepoAccess"],
            tool: "apply_patch",
          },
        },
      });

      await harness.waitForRequestMatching((request) => request.id === "memory-tool-1" && !request.method);
      const toolResponse = harness.requests.find((request) => request.id === "memory-tool-1" && !request.method);
      expect(toolResponse).toMatchObject({
        id: "memory-tool-1",
        result: {
          success: false,
          errorCode: "not_registered",
          contentItems: [
            {
              type: "inputText",
              text:
                "First-party dynamic tool 'cycloid.memory_recall' is not registered for this session.\n\n" +
                "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
            },
          ],
        },
      });
      expect(
        harness.requests.some(
          (request) =>
            request.method === "event" &&
            (request.params as { type?: string } | undefined)?.type === "memory.recall.telemetry",
        ),
      ).toBe(false);
      result.server.close();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("returns a typed not_registered failure for unknown dynamic tool namespaces", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();

    harness.send({
      id: "tool-unknown",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        namespace: "unknown",
        tool: "lookup",
        arguments: { id: "ENG-1" },
      },
    });
    await harness.waitForRequestMatching((request) => request.id === "tool-unknown" && !request.method);

    const toolResponse = harness.requests.find((request) => request.id === "tool-unknown" && !request.method);
    expect(toolResponse).toMatchObject({
      id: "tool-unknown",
      result: {
        success: false,
        errorCode: "not_registered",
        contentItems: [
          {
            type: "inputText",
            text:
              "First-party dynamic tool 'unknown.lookup' is not registered for this session.\n\n" +
              "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
          },
        ],
      },
    });

    result.server.close();
  });

  it("does not forward an aborted session signal into first-party dynamic tools", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("SENTRY_ACCESS_TOKEN", "sentry-token");
    vi.stubEnv("SENTRY_ORGANIZATION_SLUG", "acme");

    const harness = createSpawnHarness();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.endsWith("/organizations/acme/issues/123/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            shortId: "WEB-123",
            title: "Broken checkout",
            permalink: "https://sentry.io/organizations/acme/issues/123/",
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/organizations/acme/issues/123/events/latest/")) {
        return new Response(
          JSON.stringify({
            id: "evt-1",
            eventID: "evt-1",
            title: "TypeError",
            permalink: "https://sentry.io/organizations/acme/issues/123/events/evt-1/",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const sessionRecord = (
      result.client as unknown as { sessions: Map<string, { activeAbort: AbortController | null }> }
    ).sessions.get(session.data.id);
    expect(sessionRecord).toBeTruthy();
    sessionRecord!.activeAbort = new AbortController();
    sessionRecord!.activeAbort.abort();

    harness.send({
      id: "tool-aborted-session",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        namespace: "sentry",
        tool: "lookup_issue",
        arguments: { reference: "123" },
      },
    });
    await harness.waitForRequestMatching((request) => request.id === "tool-aborted-session" && !request.method);

    const toolResponse = harness.requests.find((request) => request.id === "tool-aborted-session" && !request.method);
    expect(toolResponse).toMatchObject({
      id: "tool-aborted-session",
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining('"resolvedFrom":"issue_id"'),
          },
        ],
      },
    });

    result.server.close();
  });

  it("forwards a live session signal into first-party dynamic tools so abort cancels the call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("SENTRY_ACCESS_TOKEN", "sentry-token");
    vi.stubEnv("SENTRY_ORGANIZATION_SLUG", "acme");

    const harness = createSpawnHarness();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const sessionRecord = (
      result.client as unknown as { sessions: Map<string, { activeAbort: AbortController | null }> }
    ).sessions.get(session.data.id);
    expect(sessionRecord).toBeTruthy();
    sessionRecord!.activeAbort = new AbortController();

    harness.send({
      id: "tool-live-session-abort",
      method: "item/tool/call",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        namespace: "sentry",
        tool: "lookup_issue",
        arguments: { reference: "123" },
      },
    });

    await waitForCondition(() => fetchMock.mock.calls.length > 0);
    await result.client.session.abort({ path: { id: session.data.id } });
    await harness.waitForRequestMatching((request) => request.id === "tool-live-session-abort" && !request.method);

    const toolResponse = harness.requests.find(
      (request) => request.id === "tool-live-session-abort" && !request.method,
    );
    expect(toolResponse).toMatchObject({
      id: "tool-live-session-abort",
      result: {
        success: false,
        errorCode: "cancelled",
      },
    });

    result.server.close();
  });

  it("does not write a server-request response after the transport is closed", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();
    const originalWrite = harness.child.stdin.write.bind(harness.child.stdin);
    let writesAfterEnd = 0;
    harness.child.stdin.write = ((chunk: unknown, ...args: unknown[]) => {
      if (harness.child.stdin.writableEnded || harness.child.stdin.destroyed) {
        writesAfterEnd += 1;
        const callback = args.find((arg) => typeof arg === "function") as ((error?: Error | null) => void) | undefined;
        callback?.(new Error("write after end"));
        return false;
      }
      return originalWrite(chunk as never, ...(args as []));
    }) as typeof harness.child.stdin.write;

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const clientPrivate = result.client as CodexBridgeClient & {
      pendingQuestionResponses: Map<string, { sessionID: string }>;
    };

    harness.send({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{ id: "pick_one", header: "Choice", question: "Which approach?", options: [] }],
      },
    });
    await waitForCondition(() => clientPrivate.pendingQuestionResponses.has("question-1"));

    result.server.close();

    expect(writesAfterEnd).toBe(0);
  });

  it("clears pending question responses when the app-server exits during request_user_input", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const clientPrivate = result.client as CodexBridgeClient & {
      pendingQuestionResponses: Map<string, { sessionID: string }>;
    };

    harness.send({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.data.id,
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{ id: "pick_one", header: "Choice", question: "Which approach?", options: [] }],
      },
    });
    await waitForCondition(() => clientPrivate.pendingQuestionResponses.has("question-1"));

    expect(clientPrivate.pendingQuestionResponses.has("question-1")).toBe(true);

    harness.exitChild(1, null);

    expect(clientPrivate.pendingQuestionResponses.has("question-1")).toBe(false);
    await expect(result.client.question.reply({ id: "question-1", answer: "A" })).resolves.toEqual({
      data: { ok: false },
    });
  });

  it("emits a terminal session.error and closes subscribed streams when the app-server exits mid-turn", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness({ suppressAutoResponses: ["turn/start"] });

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    const session = await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    const promptPromise = result.client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "hello" }] },
    });
    await harness.waitForRequestMatching((request) => request.method === "turn/start");

    harness.exitChild(1, null);

    await expect(promptPromise).rejects.toMatchObject({ errorCode: "runtime_error" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.error",
        properties: {
          sessionID: session.data.id,
          errorCode: "codex_transport_closed",
          error: {
            name: "CodexTransportClosed",
            data: { message: "Codex app-server exited unexpectedly (code=1 signal=null)" },
          },
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes subscribed streams without surfacing a session.error on intentional close", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    result.server.close();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps abort-signal transport shutdown silent for subscribed streams", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const harness = createSpawnHarness();
    const signalController = new AbortController();

    const result = await createCodexWithStdio({
      agentRole: "implementation",
      cwd: process.cwd(),
      signal: signalController.signal,
      config: { model: "openai/gpt-5.5" },
      spawn: harness.spawn as never,
    });
    await result.client.session.create();
    const { stream } = await result.client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    signalController.abort();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  describe("durable behavioral rules in CODEX_HOME/AGENTS.md", () => {
    it("writes AGENTS.md with session-static guidance when CODEX_HOME is bridge-owned", async () => {
      const { buildSessionStaticBehavioralGuidance } =
        await import("../../apps/sandbox-bridge/src/constants/bridge.ts");
      const { getAvailableFirstPartyDynamicToolNames } =
        await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts");
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const codexHome = `${CODEX_HOME_PREFIX}agents-md-${randomUUID()}`;
      vi.stubEnv("CODEX_HOME", codexHome);
      rmSync(codexHome, { recursive: true, force: true });
      const harness = createSpawnHarness();

      try {
        const result = await createCodexWithStdio({
          agentRole: "implementation",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        });

        const agentsPath = join(codexHome, "AGENTS.md");
        expect(existsSync(agentsPath)).toBe(true);
        expect(readFileSync(agentsPath, "utf8")).toBe(
          buildSessionStaticBehavioralGuidance({
            agentRole: "implementation",
            dynamicToolNames: getAvailableFirstPartyDynamicToolNames(process.env),
          }),
        );

        result.server.close();
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });

    it("writes verification-role AGENTS.md without implementation or commit directives", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const codexHome = `${CODEX_HOME_PREFIX}agents-md-${randomUUID()}`;
      vi.stubEnv("CODEX_HOME", codexHome);
      rmSync(codexHome, { recursive: true, force: true });
      const harness = createSpawnHarness();

      try {
        const result = await createCodexWithStdio({
          agentRole: "verification",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        });
        const contents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");

        expect(contents).toContain("# Sandbox environment");
        expect(contents).not.toContain("# Task completion");
        expect(contents).not.toContain("# Git restrictions");
        expect(contents).not.toContain("# Implementation checks");

        result.server.close();
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });

    it("AGENTS.md contains durable rules and omits deleted sections", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const codexHome = `${CODEX_HOME_PREFIX}agents-md-${randomUUID()}`;
      vi.stubEnv("CODEX_HOME", codexHome);
      rmSync(codexHome, { recursive: true, force: true });
      const harness = createSpawnHarness();

      try {
        const result = await createCodexWithStdio({
          agentRole: "implementation",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        });
        const contents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");

        expect(contents).toContain("# Sandbox environment");
        expect(contents).toContain("# Git restrictions");
        expect(contents).toContain("# Linked repo guidance");
        expect(contents).toContain("# Validation before commit");
        expect(contents).toContain("rg PATTERN .");
        expect(contents).toContain("guessed roots");

        expect(contents).not.toContain("# Repo identity");
        expect(contents).not.toContain("# Repo metadata");
        expect(contents).not.toContain("# Data boundary verification");
        expect(contents).not.toContain("# External tools");
        expect(contents).not.toContain("# External interactions");
        expect(contents).not.toContain("# SQL and database safety");
        expect(contents).not.toContain("# Requesting user identity");

        result.server.close();
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });

    it("AGENTS.md carries the first-party dynamic-tool framing when a dynamic tool is available", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      // Force the Datadog dynamic tool to be available so the dynamic-tools
      // section (Codex-only) is injected into AGENTS.md.
      vi.stubEnv("DD_API_KEY", "dd-test-api-key");
      vi.stubEnv("DD_APP_KEY", "dd-test-app-key");
      vi.stubEnv("DD_SITE", "us5.datadoghq.com");
      const codexHome = `${CODEX_HOME_PREFIX}agents-md-${randomUUID()}`;
      vi.stubEnv("CODEX_HOME", codexHome);
      rmSync(codexHome, { recursive: true, force: true });
      const harness = createSpawnHarness();

      try {
        const result = await createCodexWithStdio({
          agentRole: "implementation",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        });
        const contents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");

        expect(contents).toContain("# First-party dynamic tools");
        expect(contents).toContain("- `datadog.search_datadog_logs`");
        expect(contents).toContain("it is the intended interface to that integration");
        expect(contents).toContain(
          "Do not treat the absence of raw API keys or direct API/curl access as a limitation",
        );
        expect(contents).toContain("Never report missing raw credentials to the user as a blocker.");

        result.server.close();
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });

    it("does not write AGENTS.md when CODEX_HOME is not bridge-owned (local dev guard)", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const codexHome = join(tmpdir(), `local-dev-codex-${randomUUID()}`);
      vi.stubEnv("CODEX_HOME", codexHome);
      rmSync(codexHome, { recursive: true, force: true });
      const harness = createSpawnHarness();

      try {
        const result = await createCodexWithStdio({
          agentRole: "implementation",
          cwd: process.cwd(),
          config: { model: "openai/gpt-5.5" },
          spawn: harness.spawn as never,
        });

        expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);

        result.server.close();
      } finally {
        rmSync(codexHome, { recursive: true, force: true });
      }
    });
  });
});

describe("executeSentryDynamicToolCall", () => {
  it("returns not_connected when the tool is registered but credentials are missing", async () => {
    await expect(executeSentryDynamicToolCall({ reference: "123" }, { env: {} })).resolves.toEqual({
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "Sentry credentials are not configured for this session." }],
    });
  });

  it("returns a validation error when reference is missing", async () => {
    await expect(
      executeSentryDynamicToolCall({}, { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" } }),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Sentry lookup failed: Sentry lookup_issue requires a non-empty 'reference' string.",
        },
      ],
    });
  });

  it("returns a typed cancellation result when the request signal is aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          signal: abort.signal,
          fetchImpl: vi.fn(async () => {
            throw new DOMException("Aborted", "AbortError");
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Sentry lookup was cancelled." }],
    });
  });

  it("returns cancelled when the latest-event fetch aborts after the issue lookup succeeds", async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (href.endsWith("/organizations/acme/issues/123/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            shortId: "WEB-123",
            title: "Broken checkout",
            permalink: "https://sentry.io/organizations/acme/issues/123/",
          }),
          { status: 200 },
        );
      }
      abort.abort();
      throw new DOMException("Aborted", "AbortError");
    }) as typeof fetch;

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          signal: abort.signal,
          fetchImpl: fetchMock,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Sentry lookup was cancelled." }],
    });
  });
});

describe("executeLinearDynamicToolCall", () => {
  it("returns not_connected when Linear credentials are missing", async () => {
    await expect(executeLinearGetIssueDynamicToolCall({ id: "ENG-1" }, { env: {} })).resolves.toEqual({
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "Linear credentials are not configured for this session." }],
    });
  });

  it("returns cancelled when get_issue is aborted in flight", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          signal: abort.signal,
          fetchImpl: vi.fn(async () => {
            throw new DOMException("Aborted", "AbortError");
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Linear get_issue was cancelled." }],
    });
  });

  it("returns cancelled when list_issue_statuses is aborted in flight", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          signal: abort.signal,
          fetchImpl: vi.fn(async () => {
            throw new DOMException("Aborted", "AbortError");
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Linear list_issue_statuses was cancelled." }],
    });
  });
});

describe("executeFirstPartyDynamicToolCall", () => {
  it("routes Datadog tool calls through the registry executor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;

    await expect(
      executeFirstPartyDynamicToolCall(
        "datadog",
        "search_datadog_logs",
        { query: "service:api" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "datadoghq.eu" },
          fetchImpl,
        },
      ),
    ).resolves.toEqual(
      await executeDatadogSearchLogsDynamicToolCall(
        { query: "service:api" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "datadoghq.eu" },
          fetchImpl,
        },
      ),
    );

    await expect(
      executeFirstPartyDynamicToolCall("datadog", "get_datadog_trace", { traceId: "abc123" }, { env: {} }),
    ).resolves.toEqual({
      success: false,
      errorCode: "not_connected",
      contentItems: [
        {
          type: "inputText",
          text:
            "Datadog credentials are not connected for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
  });

  it("returns not_connected when a registered tool is called without credentials", async () => {
    await expect(
      executeFirstPartyDynamicToolCall("linear", "get_issue", { id: "ENG-1" }, { env: {} }),
    ).resolves.toEqual({
      success: false,
      errorCode: "not_connected",
      contentItems: [
        {
          type: "inputText",
          text:
            "Linear credentials are not configured for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
  });

  it("returns not_registered when the tool is absent from the session registry", async () => {
    await expect(executeFirstPartyDynamicToolCall("missing", "tool", { id: "ENG-1" }, { env: {} })).resolves.toEqual({
      success: false,
      errorCode: "not_registered",
      contentItems: [
        {
          type: "inputText",
          text:
            "First-party dynamic tool 'missing.tool' is not registered for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
  });

  it("proxies Slack get_thread through the control plane route", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sandbox-auth");
      expect(JSON.parse(String(init?.body))).toEqual({ channel: "C123", ts: "1710000000.000100" });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            messages: [{ user: "U123", ts: "1710000000.000100", text: "hello", threadTs: "1710000000.000100" }],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      executeSlackGetThreadDynamicToolCall(
        { channel: "C123", ts: "1710000000.000100" },
        {
          env: {
            CONTROL_PLANE_URL: "https://app.trycycloid.com",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            SLACK_SESSION_TEAM_ID: "T123",
          },
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            messages: [{ user: "U123", ts: "1710000000.000100", text: "hello", threadTs: "1710000000.000100" }],
          }),
        },
      ],
    });
  });

  it("redacts Slack send_message input before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts");

    expect(
      redactFirstPartyDynamicToolInputForPersistence("slack", "send_message", {
        channel: "C123",
        threadTs: "1710000000.000100",
        text: "hello world",
      }),
    ).toEqual({
      channel: "C123",
      threadTs: "1710000000.000100",
      textLength: 11,
      textRedacted: true,
    });
  });

  it("redacts malformed Slack send_message input before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts");

    expect(
      redactFirstPartyDynamicToolInputForPersistence("slack", "send_message", {
        channel: "   ",
        threadTs: "1710000000.000100",
        text: "secret password: sk-12345",
      }),
    ).toEqual({
      threadTs: "1710000000.000100",
      textLength: 25,
      textRedacted: true,
    });
  });

  it("fails closed when a dynamic tool redactor returns null", async () => {
    const dynamicTools = await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts");
    const redactSpy = vi
      .spyOn(dynamicTools, "redactFirstPartyDynamicToolInputForPersistence")
      .mockReturnValueOnce(null);
    const { client, emit } = createMockTransport();
    const session = await client.session.create();
    const { stream } = await client.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();

    emit("item/completed", {
      threadId: session.data.id,
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        namespace: "slack",
        tool: "send_message",
        arguments: {
          channel: "C123",
          text: "secret password: sk-12345",
        },
        status: "completed",
        success: true,
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            tool: "slack.send_message",
            state: {
              input: {},
              status: "completed",
              output: JSON.stringify({ success: true }),
            },
          },
        },
      },
    });

    redactSpy.mockRestore();
    client.close();
  });

  it("maps Slack control-plane rate limits to upstream_rate_limited", async () => {
    await expect(
      executeSlackSearchMessagesDynamicToolCall(
        { query: "deploy" },
        {
          env: {
            CONTROL_PLANE_URL: "https://app.trycycloid.com",
            SESSION_ID: "sess-1",
            SANDBOX_AUTH_TOKEN: "sandbox-auth",
            SLACK_SESSION_TEAM_ID: "T123",
          },
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({ ok: false, errorCode: "upstream_rate_limited", error: "Slack rate limited" }),
                { status: 429 },
              ),
          ) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "upstream_rate_limited",
      contentItems: [{ type: "inputText", text: "Slack rate limited" }],
    });
  });

  it("always registers review_summary_comment on thread/start regardless of source kind env var", async () => {
    // The tool is registered unconditionally at app-server start. Per-prompt gating happens at
    // execution time via checkToolSafety / isToolAllowedInReviewLoopSession, not via env var.
    resetSandboxBridgeTestEnv();
    for (const sourceKindEnv of ["human", "mixed", "bot", ""]) {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("ARCANIST_OPENAI_GATEWAY_ENABLED", "");
      vi.stubEnv("REVIEW_LOOP_SOURCE_KIND", sourceKindEnv);
      const harness = createSpawnHarness();

      const result = await createCodexWithStdio({
        agentRole: "implementation",
        cwd: process.cwd(),
        config: { model: "openai/gpt-5.5" },
        spawn: harness.spawn as never,
      });
      await result.client.session.create();

      const threadStart = harness.requests.find((request) => request.method === "thread/start");
      const toolNames = (
        (threadStart?.params as { dynamicTools?: Array<{ namespace?: string; name?: string }> } | undefined)
          ?.dynamicTools ?? []
      ).map((tool) => `${tool.namespace}.${tool.name}`);
      expect(toolNames, `expected review_summary_comment present for sourceKind="${sourceKindEnv}"`).toContain(
        "cycloid.review_summary_comment",
      );

      result.server.close();
    }
  });
});
