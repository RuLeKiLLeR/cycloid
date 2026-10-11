// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
// Load harness mocks before bridge modules are evaluated.
import "./helpers/bridge-test-harness.ts";

import { describe, expect, it, vi } from "vitest";

import { AgentBridge, computeReconnectDelayMs } from "../../apps/sandbox-bridge/src/bridge.ts";
import {
  EVENT_BUFFER_MAX,
  MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS,
  STARTUP_GRACE_MS,
} from "../../apps/sandbox-bridge/src/constants/bridge.ts";
import {
  ControlPlaneSession,
  UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR,
} from "../../apps/sandbox-bridge/src/control-plane-session.ts";
import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.ts";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_PROTOCOL_VERSION_HEADER } from "../../shared/constants/bridge-protocol.ts";
import {
  awaitFatalBridgeStop,
  closeWs,
  createLogger,
  defaultConfig,
  errorWs,
  findAllRuntimeLogs,
  findRuntimeLog,
  findRuntimePhaseLog,
  latestWs,
  makeAsyncIterator,
  mocks,
  openWs,
  sendWsMessage,
  setupBridgeTestLifecycle,
  waitForBridgeStartup,
} from "./helpers/bridge-test-harness.ts";

setupBridgeTestLifecycle();

// ── WebSocket URL construction ──

function expectSandboxWsUrl(raw: string, expectedOrigin: string) {
  const parsed = new URL(raw);
  expect(parsed.origin).toBe(expectedOrigin);
  expect(parsed.pathname).toBe("/api/sessions/sess-1/ws");
  expect(parsed.searchParams.get("type")).toBe("sandbox");
  expect(parsed.searchParams.get("sessionId")).toBe("sess-1");
  expect(parsed.searchParams.get("sandboxId")).toBe("sbx-1");
}

describe("WebSocket URL construction", () => {
  it("converts https:// to wss:// and appends the correct path", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();

    await waitForBridgeStartup(() => mocks.wsInstances.length > 0);

    const ws = latestWs();
    expectSandboxWsUrl(ws.url, "wss://control.example.com");

    bridge.shutdown();
    openWs(ws);
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("converts http:// to ws://", async () => {
    const bridge = new AgentBridge({
      ...defaultConfig(),
      controlPlaneUrl: "http://localhost:3000",
    });
    const runPromise = bridge.run();
    await waitForBridgeStartup(() => mocks.wsInstances.length > 0);

    expectSandboxWsUrl(latestWs().url, "ws://localhost:3000");

    bridge.shutdown();
    openWs();
    closeWs();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("adds https:// prefix when no protocol is specified", async () => {
    const bridge = new AgentBridge({
      ...defaultConfig(),
      controlPlaneUrl: "control.example.com",
    });
    const runPromise = bridge.run();
    await waitForBridgeStartup(() => mocks.wsInstances.length > 0);

    expectSandboxWsUrl(latestWs().url, "wss://control.example.com");

    bridge.shutdown();
    openWs();
    closeWs();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── WebSocket connection ──

describe("WebSocket connection", () => {
  it("passes auth token and sandbox ID as headers", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    expect(ws.options).toEqual({
      headers: {
        Authorization: "Bearer tok-secret",
        "X-Sandbox-ID": "sbx-1",
        [BRIDGE_PROTOCOL_VERSION_HEADER]: String(BRIDGE_PROTOCOL_VERSION),
      },
    });

    bridge.shutdown();
    openWs();
    closeWs();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("passes serialized boot correlation in the websocket handshake", async () => {
    const bridge = new AgentBridge({
      ...defaultConfig(),
      bootCorrelation: {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: null,
        sessionId: "sess-1",
        promptId: "prompt-1",
      },
    });
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    expect(ws.options).toEqual({
      headers: {
        Authorization: "Bearer tok-secret",
        "X-Sandbox-ID": "sbx-1",
        [BRIDGE_PROTOCOL_VERSION_HEADER]: String(BRIDGE_PROTOCOL_VERSION),
        "x-cycloid-correlation": JSON.stringify({
          traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
          sessionId: "sess-1",
          promptId: "prompt-1",
          sandboxId: "sbx-1",
        }),
      },
    });

    bridge.shutdown();
    openWs();
    closeWs();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("reports E2B runtime metadata without legacy runtime object headers", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    process.env.E2B_SANDBOX_ID = "e2b-sbx-1";
    process.env.E2B_SANDBOX_TEMPLATE = "cycloid-sandbox-dev-test";

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    expect(ws.options).toEqual({
      headers: {
        Authorization: "Bearer tok-secret",
        "X-Sandbox-ID": "sbx-1",
        [BRIDGE_PROTOCOL_VERSION_HEADER]: String(BRIDGE_PROTOCOL_VERSION),
      },
    });

    openWs(ws);
    const runtimeInfo = JSON.parse(ws.send.mock.calls[1][0]);
    expect(runtimeInfo.type).toBe("runtime_info");
    expect(runtimeInfo.runtime).toMatchObject({
      provider: "e2b",
      sandboxId: "e2b-sbx-1",
      templateId: "cycloid-sandbox-dev-test",
      modalSandboxId: "e2b-sbx-1",
    });
    const runtimeInfoLog = findRuntimeLog(consoleSpy, (entry) => entry.event === "runtime.info");
    expect(runtimeInfoLog).toMatchObject({
      event: "runtime.info",
      sandboxId: "sbx-1",
      dd_logs_enabled: expect.any(Boolean),
      trace_export_configured: false,
      trace_export_enabled: false,
      tracing_state: "disabled",
      runtime: {
        provider: "e2b",
        sandboxId: "e2b-sbx-1",
        templateId: "cycloid-sandbox-dev-test",
        modalSandboxId: "e2b-sbx-1",
      },
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("sends a heartbeat with status 'ready' on connect", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    expect(ws.send).toHaveBeenCalledTimes(2);
    const heartbeat = JSON.parse(ws.send.mock.calls[0][0]);
    expect(heartbeat.type).toBe("heartbeat");
    expect(heartbeat.sandboxId).toBe("sbx-1");
    expect(heartbeat.status).toBe("ready");
    const runtimeInfo = JSON.parse(ws.send.mock.calls[1][0]);
    expect(runtimeInfo.type).toBe("runtime_info");
    expect(runtimeInfo.sandboxId).toBe("sbx-1");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("includes log-only observability readiness in runtime_info", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    const runtimeInfo = JSON.parse(ws.send.mock.calls[1][0]);
    expect(runtimeInfo.type).toBe("runtime_info");
    // The bridge no longer exports OTLP traces, so trace export is always off and
    // tracingState is "disabled"; ddLogs simply mirrors DD_API_KEY configuration.
    expect(runtimeInfo.observabilityReadiness).toMatchObject({
      traceExport: false,
      traceExportConfigured: false,
      tracingState: "disabled",
    });
    expect(typeof runtimeInfo.observabilityReadiness.ddLogs).toBe("boolean");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

describe("sandbox session handshake", () => {
  it("rejects duplicate, malformed, and out-of-order sandbox_session frames", () => {
    const bridge = new AgentBridge(defaultConfig());
    const harness = bridge as unknown as {
      activateSandboxSession(message: Record<string, unknown>): void;
      config: { authToken: string };
      sandboxWsAuthToken: string;
    };

    expect(() =>
      harness.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "session-key-1",
        connectionGeneration: 1,
        nextAuthToken: "next-token-1",
      }),
    ).not.toThrow();
    expect(harness.config.authToken).toBe("tok-secret");
    expect(harness.sandboxWsAuthToken).toBe("next-token-1");

    expect(() =>
      harness.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "session-key-2",
        connectionGeneration: 2,
        nextAuthToken: "next-token-2",
      }),
    ).toThrow(/Duplicate sandbox WebSocket session frame/);

    const malformedBridge = new AgentBridge(defaultConfig()) as unknown as {
      activateSandboxSession(message: Record<string, unknown>): void;
      controlPlaneSession: { expectedSandboxConnectionGeneration: number | null };
    };
    expect(() =>
      malformedBridge.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "",
        connectionGeneration: 1,
        nextAuthToken: "next-token",
      }),
    ).toThrow(/Invalid sandbox WebSocket session key/);
    expect(() =>
      malformedBridge.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "session-key",
        connectionGeneration: 0,
        nextAuthToken: "next-token",
      }),
    ).toThrow(/Invalid sandbox WebSocket connection generation/);
    malformedBridge.controlPlaneSession.expectedSandboxConnectionGeneration = 3;
    expect(() =>
      malformedBridge.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "session-key",
        connectionGeneration: 2,
        nextAuthToken: "next-token",
      }),
    ).toThrow(UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR);
  });

  it("adopts a forward-jumped connection generation skipped by a deploy storm", () => {
    // ARC-1164: a control-plane Worker redeploy evicts the session DO and the
    // server increments + persists the connection generation on every WS accept.
    // During a deploy storm a single bridge reconnect can be accepted (and
    // superseded) more than once before the bridge adopts a frame, so the
    // generation legitimately jumps past expected+1. The bridge must re-adopt
    // the skip instead of stopping and failing the in-flight prompt.
    const bridge = new AgentBridge(defaultConfig()) as unknown as {
      activateSandboxSession(message: Record<string, unknown>): void;
      sandboxWsAuthToken: string;
      controlPlaneSession: { expectedSandboxConnectionGeneration: number | null };
    };
    // Bridge last adopted generation 3.
    bridge.controlPlaneSession.expectedSandboxConnectionGeneration = 3;
    // The deploy storm burned generations 4 and 5 on the server; the frame the
    // bridge finally processes carries 5 (a forward skip past expected+1).
    expect(() =>
      bridge.activateSandboxSession({
        type: "sandbox_session",
        sessionKey: "session-key-5",
        connectionGeneration: 5,
        nextAuthToken: "next-token-5",
      }),
    ).not.toThrow();
    expect(bridge.controlPlaneSession.expectedSandboxConnectionGeneration).toBe(5);
    expect(bridge.sandboxWsAuthToken).toBe("next-token-5");
  });

  it("logs protocol skew when the worker advertises a different protocol version", () => {
    const logger = createLogger();
    const session = new ControlPlaneSession({
      sessionId: "sess-1",
      sandboxId: "sbx-1",
      setAuthToken: vi.fn(),
      onEventSent: vi.fn(),
      log: logger,
    });

    expect(() =>
      session.activateSandboxSession(
        {
          type: "sandbox_session",
          sessionKey: "session-key-1",
          connectionGeneration: 1,
          nextAuthToken: "next-token-1",
          bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION + 1,
        },
        vi.fn(),
      ),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: "bridge.protocol_skew",
        bridgeVersion: BRIDGE_PROTOCOL_VERSION,
        workerVersion: BRIDGE_PROTOCOL_VERSION + 1,
      },
      "Bridge protocol version differs from control-plane worker version",
    );
  });

  it("tolerates old workers that omit the protocol version", () => {
    const logger = createLogger();
    const session = new ControlPlaneSession({
      sessionId: "sess-1",
      sandboxId: "sbx-1",
      setAuthToken: vi.fn(),
      onEventSent: vi.fn(),
      log: logger,
    });

    expect(() =>
      session.activateSandboxSession(
        {
          type: "sandbox_session",
          sessionKey: "session-key-1",
          connectionGeneration: 1,
          nextAuthToken: "next-token-1",
        },
        vi.fn(),
      ),
    ).not.toThrow();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "bridge.protocol_skew" }),
      expect.any(String),
    );
  });

  it("still rejects a stale or duplicate (<= expected) connection generation", () => {
    // The relax only accepts FORWARD progress; an equal-or-older generation is a
    // stale/replayed/superseded frame and must still be rejected (anti-replay).
    const bridge = new AgentBridge(defaultConfig()) as unknown as {
      activateSandboxSession(message: Record<string, unknown>): void;
      controlPlaneSession: { expectedSandboxConnectionGeneration: number | null };
    };
    bridge.controlPlaneSession.expectedSandboxConnectionGeneration = 5;
    for (const staleGeneration of [5, 4, 1]) {
      expect(() =>
        bridge.activateSandboxSession({
          type: "sandbox_session",
          sessionKey: "session-key-stale",
          connectionGeneration: staleGeneration,
          nextAuthToken: "next-token-stale",
        }),
      ).toThrow(UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR);
    }
  });
});

describe("WebSocket message handling", () => {
  it("logs ws_message_handler_error with prompt and agent-session correlation fields", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn");
    const bridge = new AgentBridge(defaultConfig());
    const harness = bridge as unknown as {
      activePromptTraceMeta: { promptId: string; agent: string; model: string } | null;
      agentSessionId: string | null;
      runtime: { respondToQuestion: (context: unknown, answer: string, requestId?: string) => void };
    };
    const respondError = new Error("ws respond boom");
    const respondToQuestionSpy = vi.spyOn(harness.runtime, "respondToQuestion").mockImplementation(() => {
      throw respondError;
    });
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    harness.activePromptTraceMeta = { promptId: "prompt-123", agent: "build", model: "gpt-5.5" };
    harness.agentSessionId = "codex-session-123";

    sendWsMessage({ type: "respond", answer: "Option A", requestId: "que_123" }, ws);
    await vi.advanceTimersByTimeAsync(0);

    expect(respondToQuestionSpy).toHaveBeenCalledTimes(1);
    expect(findRuntimeLog(consoleWarnSpy, (entry) => entry.event === "ws_message_handler_error")).toMatchObject({
      event: "ws_message_handler_error",
      error: String(respondError),
      active_prompt_id: "prompt-123",
      agent_session_id: "codex-session-123",
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Heartbeat mechanism ──

describe("heartbeat", () => {
  it("sends periodic heartbeats at 30s intervals", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // Initial heartbeat
    expect(ws.send).toHaveBeenCalledTimes(2);

    // Advance 30 seconds -- should send another heartbeat
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.send).toHaveBeenCalledTimes(3);

    // Advance another 30 seconds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.send).toHaveBeenCalledTimes(4);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("stops heartbeats when the WS connection closes", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    const callsBeforeClose = ws.send.mock.calls.length;

    // Close the connection, then advance time -- no more heartbeats
    closeWs(ws);
    bridge.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ws.send.mock.calls.length).toBe(callsBeforeClose);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("sends protocol-level ws.ping() alongside each interval heartbeat", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // Initial heartbeat on open does not ping (it's a direct sendEvent, not the interval)
    expect(ws.ping).toHaveBeenCalledTimes(0);

    // First interval tick -- ping should fire
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Second interval tick
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("does not send heartbeat when WS readyState is not OPEN", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    const initialCalls = ws.send.mock.calls.length;

    // Simulate WS being in a non-OPEN state
    ws.readyState = 3; // CLOSED
    await vi.advanceTimersByTimeAsync(30_000);

    // Should not have sent another heartbeat
    expect(ws.send.mock.calls.length).toBe(initialCalls);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Mid-turn rollout persist timer (ARC-1248) ──

describe("mid-turn rollout persist timer", () => {
  it("persists the rollout on an interval while a turn is active and stops when it ends", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const h = bridge as unknown as Record<string, unknown>;
    const persistSpy = vi.spyOn(h.runtime, "persistSession").mockResolvedValue(undefined);
    // Setup has run: an agent session exists, so ticks should persist.
    h.agentSessionId = "sess-1";

    h.startMidTurnRolloutPersist(createLogger());
    await vi.advanceTimersByTimeAsync(MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS);
    expect(persistSpy).toHaveBeenCalledTimes(2);

    // Turn ends -> timer stops -> no further persists.
    h.stopMidTurnRolloutPersist();
    await vi.advanceTimersByTimeAsync(MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS * 4);
    expect(persistSpy).toHaveBeenCalledTimes(2);
  });

  it("does not persist before an agent session exists", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const h = bridge as unknown as Record<string, unknown>;
    const persistSpy = vi.spyOn(h.runtime, "persistSession").mockResolvedValue(undefined);
    h.agentSessionId = null;

    h.startMidTurnRolloutPersist(createLogger());
    await vi.advanceTimersByTimeAsync(MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS * 3);
    expect(persistSpy).not.toHaveBeenCalled();
    h.stopMidTurnRolloutPersist();
  });

  it("clears the timer on shutdown so it cannot outlive the turn", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const h = bridge as unknown as Record<string, unknown>;
    const persistSpy = vi.spyOn(h.runtime, "persistSession").mockResolvedValue(undefined);
    h.agentSessionId = "sess-1";

    h.startMidTurnRolloutPersist(createLogger());
    bridge.shutdown();
    await vi.advanceTimersByTimeAsync(MID_TURN_ROLLOUT_PERSIST_INTERVAL_MS * 4);
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

// ── Event buffering ──

describe("event buffering", () => {
  function tokenEvent(content: string, messageId = "msg-1") {
    return {
      type: "token",
      content,
      messageId,
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    };
  }

  it("buffers events when WS is not connected and flushes on connect", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();

    // Before opening, the WS is not connected -- events get buffered internally.
    // We can't directly call sendEvent (private), but when we open, the initial
    // heartbeat should be sent. The buffering is tested indirectly: if a message
    // triggers sendEvent before WS is open, the events should flush on open.
    // For this test, verify the open handler sends the heartbeat properly.
    openWs(ws);

    expect(ws.send).toHaveBeenCalledTimes(2);
    const heartbeat = JSON.parse(ws.send.mock.calls[0][0]);
    expect(heartbeat.type).toBe("heartbeat");
    const runtimeInfo = JSON.parse(ws.send.mock.calls[1][0]);
    expect(runtimeInfo.type).toBe("runtime_info");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("caps buffered events when send throws while the socket is open", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    const warn = vi.fn();
    bridge["log"].warn = warn;
    ws.send.mockImplementation(() => {
      throw new Error("send failed");
    });

    for (let index = 0; index < EVENT_BUFFER_MAX + 2; index++) {
      bridge["sendEvent"](tokenEvent(`chunk-${index}`, `msg-${index}`));
    }

    expect(bridge["eventBuffer"]).toHaveLength(EVENT_BUFFER_MAX);
    const dropWarnings = warn.mock.calls.filter((call) => call[1] === "Event buffer full, dropping oldest event");
    expect(dropWarnings).toHaveLength(2);
    expect(dropWarnings[0][0]).toMatchObject({
      eventType: "token",
      cap: EVENT_BUFFER_MAX,
      reason: "dropped_oldest",
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("stops flushing and restores buffered order when a buffered send fails", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    bridge["eventBuffer"] = [tokenEvent("one"), tokenEvent("two"), tokenEvent("three")];
    ws.send.mockImplementation((payload: string) => {
      const message = JSON.parse(payload) as Record<string, unknown>;
      if (message.type === "token" && message.content === "one") {
        throw new Error("send failed");
      }
    });

    openWs(ws);

    const sentTokenContents = ws.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .filter((message) => message.type === "token")
      .map((message) => message.content);
    expect(sentTokenContents).toEqual(["one"]);
    expect(bridge["eventBuffer"].map((event: Record<string, unknown>) => event.content)).toEqual([
      "one",
      "two",
      "three",
    ]);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Shutdown ──

describe("shutdown", () => {
  it("sets shutdownRequested and closes the WebSocket", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    bridge.shutdown();
    expect(ws.close).toHaveBeenCalledOnce();

    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("closes the Codex server on exit", async () => {
    const bridge = new AgentBridge({
      ...defaultConfig(),
      agentSessionId: "restored-session-1",
      agentSessionAgent: "build",
    });
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" }, ws);
    await waitForBridgeStartup(() => mocks.mockCreateCodex.mock.calls.length > 0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    expect(mocks.mockServer.close).toHaveBeenCalledOnce();
  });

  it("prevents reconnection after shutdown", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const firstWs = latestWs();
    bridge.shutdown();
    openWs(firstWs);
    closeWs(firstWs);

    await vi.advanceTimersByTimeAsync(120_000);
    await runPromise;

    // Only one WebSocket was created (no reconnect attempt)
    expect(mocks.wsInstances.length).toBe(1);
  });
});

describe("Codex initialization timing", () => {
  it("defers createCodex until the first prompt for fresh sessions", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockCreateCodex).not.toHaveBeenCalled();

    const ws = latestWs();
    openWs(ws);

    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([{ type: "session.idle", properties: { sessionID: "codex-session-1" } }]),
    });

    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockCreateCodex).toHaveBeenCalledTimes(1);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("uses the registry provider for static Codex config when env provider mismatches a known model", async () => {
    process.env.PROVIDER = "openai";
    process.env.MODEL = "gpt-5.4-mini";
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([{ type: "session.idle", properties: { sessionID: "codex-session-1" } }]),
    });

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" }, ws);
    await waitForBridgeStartup(() => mocks.mockCreateCodex.mock.calls.length > 0);

    expect(mocks.mockCreateCodex).toHaveBeenCalledTimes(1);
    expect(mocks.mockCreateCodex.mock.calls[0][0].config.model).toBe("gpt-5.4-mini");

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("rejects unknown static Codex models instead of coercing them onto OpenAI", () => {
    const bridge = new AgentBridge(defaultConfig());
    expect(() => bridge["runtime"].parseModel("future-provider/future-model")).toThrow(
      "Unsupported Codex model 'future-provider/future-model'",
    );
    expect(() => bridge["runtime"].parseModel("claude-sonnet-4-5")).toThrow(
      "Unsupported Codex model 'claude-sonnet-4-5'",
    );
  });

  it("defers Codex initialization until the first prompt for restored sessions", async () => {
    const bridge = new AgentBridge({
      ...defaultConfig(),
      agentSessionId: "restored-session-1",
      agentSessionAgent: "build",
    });
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockCreateCodex).not.toHaveBeenCalled();
    const ws = latestWs();
    openWs(ws);
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([{ type: "session.idle", properties: { sessionID: "codex-session-1" } }]),
    });
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" }, ws);
    await waitForBridgeStartup(() => mocks.mockCreateCodex.mock.calls.length > 0);

    expect(mocks.mockCreateCodex).toHaveBeenCalledTimes(1);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("treats restored sessions as follow-up prompts for system context injection", async () => {
    mocks.mockClient.session.get.mockResolvedValue({ data: { id: "restored-session-1" } });
    mocks.mockClient.event.subscribe.mockResolvedValue({
      stream: makeAsyncIterator([{ type: "session.idle", properties: { sessionID: "restored-session-1" } }]),
    });

    const bridge = new AgentBridge({
      ...defaultConfig(),
      agentSessionId: "restored-session-1",
      agentSessionAgent: "build",
    });
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    // After the user_instructions lifecycle change, all durable rules
    // (sandbox env, investigation, task completion, git restrictions, etc.)
    // live in `${CODEX_HOME}/AGENTS.md` and don't ride per-turn `body.system`.
    // The remaining assertions confirm restored sessions reuse the existing
    // session id and don't accidentally pull in deferred-edit or MCP guidance.
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockClient.session.create).not.toHaveBeenCalled();
    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "restored-session-1" },
        body: expect.objectContaining({
          agent: "build",
          parts: [{ type: "text", text: "Hello" }],
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    const restoredSystem = mocks.mockClient.session.promptAsync.mock.calls[0][0].body.system;
    if (restoredSystem !== undefined) {
      expect(restoredSystem).not.toContain("# MCP Tool Guidance");
      expect(restoredSystem).not.toContain("Data boundary verification");
      expect(restoredSystem).not.toContain("Git restrictions");
    }

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("re-injects uploaded files after promptAsync fails before the send succeeds", async () => {
    mocks.mockClient.event.subscribe.mockImplementation(() =>
      Promise.resolve({
        stream: makeAsyncIterator([{ type: "session.idle", properties: { sessionID: "codex-session-1" } }]),
      }),
    );
    mocks.mockClient.session.promptAsync
      .mockRejectedValueOnce(new Error("send failed"))
      .mockResolvedValueOnce(undefined);

    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    const uploadedFiles = [{ name: "notes.txt", content: "hello world" }];
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "First try", uploadedFiles });
    await vi.advanceTimersByTimeAsync(0);

    sendWsMessage({ type: "prompt", messageId: "msg-2", content: "Second try", uploadedFiles });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.mockClient.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(mocks.mockClient.session.promptAsync.mock.calls[0][0].body.parts).toHaveLength(2);
    expect(mocks.mockClient.session.promptAsync.mock.calls[1][0].body.parts).toHaveLength(2);
    expect(mocks.mockClient.session.promptAsync.mock.calls[1][0].body.parts[1]).toMatchObject({
      type: "text",
      synthetic: true,
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Codex startup resilience ──

describe("Codex startup failure handling", () => {
  it("does not retry non-timeout errors", async () => {
    mocks.mockCreateCodex.mockRejectedValueOnce(new Error("Config validation failed"));

    const bridge = new AgentBridge({
      ...defaultConfig(),
      agentSessionId: "restored-session-1",
      agentSessionAgent: "build",
    });
    const runPromise = bridge.run();

    await vi.advanceTimersByTimeAsync(0);
    const ws = latestWs();
    openWs(ws);
    sendWsMessage({ type: "prompt", messageId: "msg-1", content: "Hello" }, ws);
    await vi.advanceTimersByTimeAsync(0);

    // Should have called createCodex only once (no retry for non-timeout)
    expect(mocks.mockCreateCodex).toHaveBeenCalledTimes(1);
    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Reconnection logic ──

describe("reconnection", () => {
  it("computes reconnect delay from the previous failed attempt and caps after jitter", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(computeReconnectDelayMs(0)).toBe(2_000);
      expect(computeReconnectDelayMs(1)).toBe(2_000);
      expect(computeReconnectDelayMs(2)).toBe(4_000);
      expect(computeReconnectDelayMs(3)).toBe(8_000);

      random.mockReturnValue(1);
      expect(computeReconnectDelayMs(10)).toBe(30_000);
    } finally {
      random.mockRestore();
    }
  });

  it("reconnects with exponential backoff on non-fatal WS errors", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    // First connection fails with non-fatal error
    const ws1 = latestWs();
    errorWs(new Error("Connection refused"), ws1);

    // Wait for first reconnect delay (base 2s + up to 25% jitter = 2.5s max)
    await vi.advanceTimersByTimeAsync(5_000);

    // Second WS should be created
    expect(mocks.wsInstances.length).toBe(2);

    // Second connection also fails
    const ws2 = latestWs();
    errorWs(new Error("Connection refused"), ws2);

    // Wait for second reconnect delay (base 4s + up to 25% jitter = 5s max)
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.wsInstances.length).toBe(3);

    // Clean up -- shutdown and let the third connection close
    bridge.shutdown();
    const ws3 = latestWs();
    openWs(ws3);
    closeWs(ws3);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("caps reconnect delay at 30 seconds after jitter", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const bridge = new AgentBridge(defaultConfig());
      const runPromise = bridge.run();
      await vi.advanceTimersByTimeAsync(0);

      // Simulate many failed connections to exceed the cap
      for (let i = 0; i < 10; i++) {
        const ws = latestWs();
        errorWs(new Error("Connection refused"), ws);

        // Advance enough time for the 30s capped delay.
        await vi.advanceTimersByTimeAsync(31_000);
      }

      // After 10 failures, the uncapped delay would be far above 30s.
      // If it weren't capped after jitter, the 31s
      // advance above wouldn't be enough for a reconnect at high attempt counts.
      // Verify we got at least 11 connections (initial + 10 retries)
      expect(mocks.wsInstances.length).toBe(11);

      bridge.shutdown();
      const ws = latestWs();
      openWs(ws);
      closeWs(ws);
      await vi.advanceTimersByTimeAsync(0);
      await runPromise;
    } finally {
      random.mockRestore();
    }
  });

  it("resets reconnect counter after successful connection", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    // First attempt fails
    const ws1 = latestWs();
    errorWs(new Error("fail"), ws1);
    await vi.advanceTimersByTimeAsync(5_000); // delay = 2*2^0 = 2s + jitter

    // Second attempt succeeds then gracefully closes
    const ws2 = latestWs();
    openWs(ws2);
    closeWs(ws2);

    // After a successful connection, reconnect counter resets to 0
    // So the next delay should be 2*2^0 = 2s + jitter again (not 2*2^1 = 4s)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.wsInstances.length).toBe(3);

    bridge.shutdown();
    const ws3 = latestWs();
    openWs(ws3);
    closeWs(ws3);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("logs WebSocket close causality with active prompt diagnostics", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);
    bridge["activePromptTraceMeta"] = { promptId: "msg-1", agent: "build", model: "gpt-5.4" };
    bridge["currentPromptAbort"] = vi.fn();
    const consoleSpy = vi.spyOn(console, "log");

    closeWs(ws, 1006, "network drop");
    bridge.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const closeLog = findRuntimePhaseLog(consoleSpy, "bridge.connect", "websocket", "disconnected");
    expect(closeLog).toMatchObject({
      close_code: 1006,
      close_reason: "network drop",
      close_reason_class: "abnormal",
      close_initiator: "remote",
      prompt_work_in_flight: true,
      active_prompt_id: "msg-1",
      active_prompt_agent: "build",
      active_prompt_model: "gpt-5.4",
      pending_ack_count: 0,
      event_buffer_length: 0,
      shutdown_requested: false,
    });
  });

  it("tags reconnect log with connect error class on connection failure", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const consoleSpy = vi.spyOn(console, "log");
    const ws1 = latestWs();
    errorWs(new Error("connect ECONNREFUSED 127.0.0.1:3000"), ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    const reconnectLog = findRuntimePhaseLog(consoleSpy, "bridge.connect", "reconnect", "reconnecting");
    expect(reconnectLog).toMatchObject({
      reconnect_reason: "connection_error",
      has_connected_to_control_plane: false,
      last_connect_error_class: "connection_refused",
    });
    expect(reconnectLog.last_connect_status_code).toBeUndefined();

    bridge.shutdown();
    const ws2 = latestWs();
    openWs(ws2);
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("emits bridge.connected startup timeline only for the first control-plane connection", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const consoleSpy = vi.spyOn(console, "log");
    const ws1 = latestWs();
    openWs(ws1);
    closeWs(ws1, 1006, "network drop");

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForBridgeStartup(() => mocks.wsInstances.length >= 2);
    const ws2 = latestWs();
    openWs(ws2);

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const connectedTimelineLogs = findAllRuntimeLogs(consoleSpy, (entry) => entry.event === "bridge.connected");
    expect(connectedTimelineLogs).toHaveLength(1);
    expect(connectedTimelineLogs[0]).toMatchObject({
      session_id: "sess-1",
      sandbox_id: "sbx-1",
      agent_runtime_backend: "codex",
    });
  });

  it("tags reconnect log with status code when WS handshake returns HTTP error", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const consoleSpy = vi.spyOn(console, "log");
    const ws1 = latestWs();
    errorWs(new Error("Unexpected server response: 502"), ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    const reconnectLog = findRuntimePhaseLog(consoleSpy, "bridge.connect", "reconnect", "reconnecting");
    expect(reconnectLog).toMatchObject({
      reconnect_reason: "connection_error",
      has_connected_to_control_plane: false,
      last_connect_error_class: "ws_502",
      last_connect_status_code: 502,
    });

    bridge.shutdown();
    const ws2 = latestWs();
    openWs(ws2);
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

describe("ACK tracking", () => {
  it("logs time to first prompt activity once when the first user-facing event is sent", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    vi.setSystemTime(new Date("2026-04-14T18:42:59.000Z"));
    bridge["promptActivity"].recordFirstPromptActivityTracker("msg-1", {
      startedAt: Date.now(),
      agent: "build",
      model: "gpt-5.4",
    });
    const consoleSpy = vi.spyOn(console, "log");

    await vi.advanceTimersByTimeAsync(1234);
    bridge["sendEvent"]({
      type: "token",
      content: "hello",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });
    bridge["sendEvent"]({
      type: "tool_call",
      tool: "bash",
      args: { command: "date" },
      callId: "tool-1",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const firstMessageLogs = consoleSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((entry) => entry.includes('"event":"prompt.first_message"'))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(firstMessageLogs).toHaveLength(1);
    expect(firstMessageLogs[0]).toMatchObject({
      event: "prompt.first_message",
      prompt_id: "msg-1",
      first_event_type: "token",
      time_to_first_message_ms: 1234,
      agent: "build",
      model: "gpt-5.4",
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("logs first prompt activity at buffered event delivery time", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();

    vi.setSystemTime(new Date("2026-04-14T18:42:59.000Z"));
    bridge["promptActivity"].recordFirstPromptActivityTracker("msg-1", {
      startedAt: Date.now(),
      agent: "build",
      model: "gpt-5.4",
    });
    const consoleSpy = vi.spyOn(console, "log");

    await vi.advanceTimersByTimeAsync(100);
    bridge["sendEvent"]({
      type: "token",
      content: "hello",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });
    expect(bridge["eventBuffer"]).toHaveLength(1);
    expect(consoleSpy.mock.calls.some((call) => String(call[0]).includes('"event":"prompt.first_message"'))).toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(3_400);
    openWs(ws);

    const firstMessageLogs = consoleSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((entry) => entry.includes('"event":"prompt.first_message"'))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(firstMessageLogs).toHaveLength(1);
    expect(firstMessageLogs[0]).toMatchObject({
      event: "prompt.first_message",
      prompt_id: "msg-1",
      first_event_type: "token",
      time_to_first_message_ms: 3500,
      agent: "build",
      model: "gpt-5.4",
    });

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("keeps first prompt activity tracker until pending acked activity is delivered", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();

    vi.setSystemTime(new Date("2026-04-14T18:42:59.000Z"));
    bridge["promptActivity"].recordFirstPromptActivityTracker("msg-1", {
      startedAt: Date.now(),
      agent: "build",
      model: "gpt-5.4",
    });
    const consoleSpy = vi.spyOn(console, "log");

    await vi.advanceTimersByTimeAsync(100);
    bridge["sendEvent"]({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      idleObserved: true,
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    expect(bridge["pendingAckEvents"].size).toBe(1);
    bridge["promptActivity"].deleteFirstPromptActivityTrackerIfNoPendingDelivery("msg-1");
    expect(bridge["promptActivity"]["firstPromptActivityTrackers"].has("msg-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(3_400);
    openWs(ws);

    const firstMessageLogs = consoleSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((entry) => entry.includes('"event":"prompt.first_message"'))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(firstMessageLogs).toHaveLength(1);
    expect(firstMessageLogs[0]).toMatchObject({
      event: "prompt.first_message",
      prompt_id: "msg-1",
      first_event_type: "execution_complete",
      time_to_first_message_ms: 3500,
      agent: "build",
      model: "gpt-5.4",
    });
    expect(bridge["promptActivity"]["firstPromptActivityTrackers"].has("msg-1")).toBe(false);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("tracks acked events until the control plane acknowledges them", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    bridge["sendEvent"]({
      type: "question",
      questionId: "que_1",
      question: "Continue?",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const question = ws.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .find((message) => message.type === "question");
    expect(question).toBeDefined();
    expect(question?.ackId).toMatch(/^msg-1:question:1:/);
    expect(bridge["pendingAckEvents"].size).toBe(1);

    sendWsMessage({ type: "ack", ackId: question?.ackId }, ws);
    expect(bridge["pendingAckEvents"].size).toBe(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("keeps structured transcript events pending until ACKed", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    bridge["sendEvent"]({
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });
    bridge["sendEvent"]({
      type: "tool_update",
      tool: "bash",
      callId: "call-1",
      status: "completed",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const sent = ws.send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>);
    const toolCall = sent.find((message) => message.type === "tool_call");
    const toolUpdate = sent.find((message) => message.type === "tool_update");
    expect(toolCall?.ackId).toMatch(/^msg-1:tool_call:1:/);
    expect(toolUpdate?.ackId).toMatch(/^msg-1:tool_update:2:/);
    expect(bridge["pendingAckEvents"].size).toBe(2);

    sendWsMessage({ type: "ack", ackId: toolCall?.ackId }, ws);
    expect(bridge["pendingAckEvents"].size).toBe(1);
    sendWsMessage({ type: "ack", ackId: toolUpdate?.ackId }, ws);
    expect(bridge["pendingAckEvents"].size).toBe(0);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("keeps merged phase text segment ids above source state", () => {
    const bridge = new AgentBridge(defaultConfig()) as unknown as {
      mergePhaseLoopState: (target: PromptLoopState, source: PromptLoopState) => void;
    };
    const target = new PromptLoopState();
    const source = new PromptLoopState();

    target.updateTextDelta("main:text:0", "Main turn text.", "main");
    source.updateTextDelta("phase:text:0", "Phase pre-tool text.", "phase");
    source.startNewTextSegment();
    source.updateTextDelta("phase:text:1", "Phase post-tool text.", "phase");

    bridge.mergePhaseLoopState(target, source);

    expect(target.text.currentTextSegmentId).toBeGreaterThanOrEqual(source.text.currentTextSegmentId);
    target.startNewTextSegment();
    target.updateTextDelta("main:text:1", "Main post-phase text.", "main");
    expect(target.latestMessageResponseText()).toBe("Main post-phase text.");
  });

  it("redelivers unacked structured transcript events after reconnect", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);

    bridge["sendEvent"]({
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });
    bridge["sendEvent"]({
      type: "tool_update",
      tool: "bash",
      callId: "call-1",
      status: "completed",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const firstSent = ws1.send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>);
    const firstToolCall = firstSent.find((message) => message.type === "tool_call");
    const firstToolUpdate = firstSent.find((message) => message.type === "tool_update");

    errorWs(new Error("Connection refused"), ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    const ws2 = latestWs();
    openWs(ws2);

    const resent = ws2.send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>);
    const resentToolCall = resent.find((message) => message.type === "tool_call");
    const resentToolUpdate = resent.find((message) => message.type === "tool_update");
    expect(resentToolCall?.ackId).toBe(firstToolCall?.ackId);
    expect(resentToolUpdate?.ackId).toBe(firstToolUpdate?.ackId);
    expect(bridge["pendingAckEvents"].size).toBe(2);

    sendWsMessage({ type: "ack", ackId: resentToolCall?.ackId }, ws2);
    sendWsMessage({ type: "ack", ackId: resentToolUpdate?.ackId }, ws2);
    expect(bridge["pendingAckEvents"].size).toBe(0);

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("resends pending acked events after reconnect until ACKed", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);

    bridge["sendEvent"]({
      type: "question",
      questionId: "que_1",
      question: "Continue?",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const firstQuestion = ws1.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .find((message) => message.type === "question");
    expect(firstQuestion?.ackId).toMatch(/^msg-1:question:1:/);

    errorWs(new Error("Connection refused"), ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    const ws2 = latestWs();
    openWs(ws2);

    const resentQuestion = ws2.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .find((message) => message.type === "question");
    expect(resentQuestion).toBeDefined();
    expect(resentQuestion?.ackId).toBe(firstQuestion?.ackId);
    expect(bridge["pendingAckEvents"].size).toBe(1);

    sendWsMessage({ type: "ack", ackId: resentQuestion?.ackId }, ws2);
    expect(bridge["pendingAckEvents"].size).toBe(0);

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("continues resending later pending ACK events after one transient resend failure", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);

    bridge["sendEvent"]({
      type: "question",
      questionId: "que_1",
      question: "Continue?",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });
    bridge["sendEvent"]({
      type: "question",
      questionId: "que_2",
      question: "Retry?",
      messageId: "msg-2",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    errorWs(new Error("Connection refused"), ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    const ws2 = latestWs();
    let threwOnFirstQuestion = false;
    ws2.send.mockImplementation((payload: string) => {
      const message = JSON.parse(payload) as { type?: string };
      if (!threwOnFirstQuestion && message.type === "question") {
        threwOnFirstQuestion = true;
        throw new Error("transient resend failure");
      }
    });
    openWs(ws2);

    const resentQuestions = ws2.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .filter((message) => message.type === "question")
      .map((message) => message.ackId);
    expect(resentQuestions).toHaveLength(2);
    expect(resentQuestions[0]).toMatch(/^msg-1:question:1:/);
    expect(resentQuestions[1]).toMatch(/^msg-2:question:1:/);
    expect(bridge["pendingAckEvents"].size).toBe(2);

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("resends pending ACK events after a watchdog-triggered reconnect", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);

    bridge["sendEvent"]({
      type: "question",
      questionId: "que_1",
      question: "Continue?",
      messageId: "msg-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
    });

    const firstQuestion = ws1.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .find((message) => message.type === "question");
    expect(firstQuestion?.ackId).toMatch(/^msg-1:question:1:/);

    await vi.advanceTimersByTimeAsync(105_000);
    expect(ws1.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_500);
    const ws2 = latestWs();
    expect(ws2).not.toBe(ws1);
    openWs(ws2);

    const resentQuestion = ws2.send.mock.calls
      .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
      .find((message) => message.type === "question");
    expect(resentQuestion?.ackId).toBe(firstQuestion?.ackId);

    sendWsMessage({ type: "ack", ackId: resentQuestion?.ackId }, ws2);
    expect(bridge["pendingAckEvents"].size).toBe(0);

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("keeps a long-running prompt's socket alive as long as the DO keeps echoing heartbeats", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // A healthy DO answering heartbeat echoes during a long prompt must never be
    // reconnected, even well past the liveness threshold + grace window.
    bridge["currentPromptAbort"] = vi.fn();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const lastHeartbeat = ws.send.mock.calls
        .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
        .reverse()
        .find((message) => message.type === "heartbeat");
      sendWsMessage({ type: "heartbeat_echo", echoNonce: lastHeartbeat?.echoNonce }, ws);
    }

    expect(ws.close).not.toHaveBeenCalled();
    expect(mocks.wsInstances).toHaveLength(1);

    bridge["currentPromptAbort"] = null;
    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("reconnects when only protocol-level pong frames arrive (no DO app-level echo)", async () => {
    // Regression: a dead/hung DO whose edge still answers protocol pings used to
    // look healthy forever. The pong is answered by the Cloudflare edge or the
    // DO's setWebSocketAutoResponse, not the DO application layer, so it must NOT
    // refresh liveness. Only the typed heartbeat_echo does.
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // Simulate pong frames arriving every 30s (in response to ws.ping()), but no
    // app-level heartbeat_echo and no other inbound traffic.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      ws.handlers.pong?.();
    }

    // 150s of pongs only -- the idle watchdog must have escalated.
    expect(ws.close).toHaveBeenCalled();
    closeWs(ws);

    // Drive the reconnect to completion, then shut down cleanly.
    await vi.advanceTimersByTimeAsync(2_500);
    const ws2 = latestWs();
    openWs(ws2);
    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("marks inbound liveness on the DO app-level heartbeat_echo, not on the pong", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // Every interval tick: protocol ping + app-level heartbeat carrying a nonce.
    // The DO replies with a typed heartbeat_echo, which is the only signal that
    // refreshes inbound liveness. A pong arrives too but must not count.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const lastHeartbeat = ws.send.mock.calls
        .map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
        .reverse()
        .find((message) => message.type === "heartbeat");
      expect(typeof lastHeartbeat?.echoNonce).toBe("string");
      ws.handlers.pong?.();
      sendWsMessage({ type: "heartbeat_echo", echoNonce: lastHeartbeat?.echoNonce }, ws);
    }

    // 180s elapsed -- echoes kept the socket alive, watchdog never fired.
    expect(ws.close).not.toHaveBeenCalled();
    expect(mocks.wsInstances).toHaveLength(1);

    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("keeps the watchdog armed but does not escalate before the grace window when work is in flight", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    openWs(ws);

    // Prompt work in flight, DO has gone silent (no heartbeat_echo). Past the
    // liveness threshold (90s) but still inside the grace window (90s + 60s).
    bridge["currentPromptAbort"] = vi.fn();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(mocks.wsInstances).toHaveLength(1);

    bridge["currentPromptAbort"] = null;
    bridge.shutdown();
    closeWs(ws);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("escalates a silent DO after the grace window even while work is in flight", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);
    const consoleErrorSpy = vi.spyOn(console, "error");

    const ws = latestWs();
    openWs(ws);

    // Prompt work in flight, DO silent past liveness threshold + grace
    // (90s + 60s = 150s). Pongs keep arriving but must not mask the dead DO.
    bridge["currentPromptAbort"] = vi.fn();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      ws.handlers.pong?.();
    }

    expect(ws.close).toHaveBeenCalledTimes(1);
    const doLivenessLog = findRuntimeLog(
      consoleErrorSpy,
      (entry) => entry.event === "bridge.do_liveness_failure" && entry.watchdogReason === "do_liveness",
    );
    expect(doLivenessLog).toBeTruthy();
    closeWs(ws);

    // The reconnect path takes over; a second socket is created.
    bridge["currentPromptAbort"] = null;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mocks.wsInstances.length).toBeGreaterThan(1);
    const ws2 = latestWs();
    openWs(ws2);
    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("idle (no-work) stale-socket path still escalates with the idle reason after the liveness threshold", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);
    const consoleWarnSpy = vi.spyOn(console, "warn");

    const ws = latestWs();
    openWs(ws);

    // No prompt work, no inbound/outbound activity. The idle path escalates at
    // the liveness threshold (90s) without the extra grace window.
    await vi.advanceTimersByTimeAsync(105_000);

    expect(ws.close).toHaveBeenCalledTimes(1);
    const idleLog = findRuntimeLog(
      consoleWarnSpy,
      (entry) => entry.event === "bridge.ws_stale_socket" && entry.watchdogReason === "idle_stale_socket",
    );
    expect(idleLog).toBeTruthy();
    closeWs(ws);

    await vi.advanceTimersByTimeAsync(2_500);
    const ws2 = latestWs();
    openWs(ws2);
    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

// ── Fatal error detection ──

describe("fatal errors", () => {
  it("stops reconnecting when the control plane sends a stale sandbox connection generation", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);
    const consoleSpy = vi.spyOn(console, "warn");

    const ws1 = latestWs();
    openWs(ws1);
    closeWs(ws1);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.wsInstances.length).toBe(2);

    const ws2 = latestWs();
    ws2.handlers.open?.();
    sendWsMessage(
      {
        type: "sandbox_session",
        sessionKey: "stale-session-key",
        connectionGeneration: 1,
        nextAuthToken: "stale-next-auth-token",
      },
      ws2,
    );

    await awaitFatalBridgeStop(runPromise);

    expect(ws2.close).toHaveBeenCalledWith(4002, "Invalid sandbox session frame");
    expect(mocks.wsInstances.length).toBe(2);
    expect(findRuntimePhaseLog(consoleSpy, "bridge.connect", "session_frame", "terminal")).toMatchObject({
      error: UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR,
      prompt_work_in_flight: false,
      shutdown_requested: false,
    });
  });

  it.each([
    "Unexpected server response: 401",
    "Unexpected server response: 403",
    "Unexpected server response: 409",
    "Unexpected server response: 410",
  ])("stops reconnecting on fatal error (ws format): %s", async (errorMsg) => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    // Non-404 lifecycle/auth errors are always fatal.
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS + 1_000);

    const ws = latestWs();
    errorWs(new Error(errorMsg), ws);

    await awaitFatalBridgeStop(runPromise);

    // Should NOT have created a second WS
    expect(mocks.wsInstances.length).toBe(1);
  });

  it.each(["HTTP 401", "HTTP 403", "HTTP 409", "HTTP 410"])(
    "stops reconnecting on fatal error (legacy format): %s",
    async (errorMsg) => {
      const bridge = new AgentBridge(defaultConfig());
      const runPromise = bridge.run();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS + 1_000);

      const ws = latestWs();
      errorWs(new Error(errorMsg), ws);

      await awaitFatalBridgeStop(runPromise);

      expect(mocks.wsInstances.length).toBe(1);
    },
  );

  it("404 retries before first connection during startup grace", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    // Error immediately within the bounded pre-connect grace.
    const ws1 = latestWs();
    errorWs(new Error("Unexpected server response: 404"), ws1);

    // Wait for reconnect (2s base + jitter)
    await vi.advanceTimersByTimeAsync(5_000);

    // Should have reconnected
    expect(mocks.wsInstances.length).toBe(2);

    bridge.shutdown();
    const ws2 = latestWs();
    openWs(ws2);
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });

  it("404 stops reconnecting after startup grace when never connected", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS + 1_000);

    const ws1 = latestWs();
    errorWs(new Error("Unexpected server response: 404"), ws1);

    await awaitFatalBridgeStop(runPromise);

    expect(mocks.wsInstances.length).toBe(1);
  });

  it("404 stops reconnecting after a prior successful control-plane connection", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);
    closeWs(ws1, 1006);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.wsInstances.length).toBe(2);

    const ws2 = latestWs();
    errorWs(new Error("Unexpected server response: 404"), ws2);

    await awaitFatalBridgeStop(runPromise);

    expect(mocks.wsInstances.length).toBe(2);
  });

  it("404 stops reconnecting after a prior connection in legacy HTTP format", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = latestWs();
    openWs(ws1);
    closeWs(ws1, 1006);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.wsInstances.length).toBe(2);

    const ws2 = latestWs();
    errorWs(new Error("HTTP 404"), ws2);

    await awaitFatalBridgeStop(runPromise);

    expect(mocks.wsInstances.length).toBe(2);
  });

  it("401/403/409/410 are always fatal even during startup grace", async () => {
    for (const code of [401, 403, 409, 410]) {
      mocks.wsInstances.length = 0;
      vi.clearAllMocks();

      const bridge = new AgentBridge(defaultConfig());
      const runPromise = bridge.run();
      await vi.advanceTimersByTimeAsync(0);

      // Error immediately within startup grace -- should still be fatal.
      const ws = latestWs();
      errorWs(new Error(`Unexpected server response: ${code}`), ws);

      await awaitFatalBridgeStop(runPromise);

      expect(mocks.wsInstances.length).toBe(1);
    }
  });

  it("treats non-HTTP errors as recoverable", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestWs();
    errorWs(new Error("ECONNREFUSED"), ws);

    await vi.advanceTimersByTimeAsync(5_000);

    // Should have attempted a reconnect
    expect(mocks.wsInstances.length).toBe(2);

    bridge.shutdown();
    const ws2 = latestWs();
    openWs(ws2);
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});

describe("sandbox connection generation reconnect (ARC-1164)", () => {
  it("re-adopts a forward-jumped generation on reconnect instead of stopping the bridge", async () => {
    const bridge = new AgentBridge(defaultConfig());
    const runPromise = bridge.run();
    await vi.advanceTimersByTimeAsync(0);

    // First connection adopts generation 1, then a control-plane Worker redeploy
    // evicts the session DO mid-session (abnormal close 1006).
    const ws1 = latestWs();
    openWs(ws1);
    closeWs(ws1, 1006);
    await vi.advanceTimersByTimeAsync(5_000);

    // The bridge reconnects exactly once (as observed in prod session 9c93d180).
    expect(mocks.wsInstances.length).toBe(2);

    // The deploy storm accepted (and superseded) that single reconnect more than
    // once on the server, each accept incrementing the persisted connection
    // generation -- so the frame the bridge finally processes carries generation
    // 3: a forward skip past expected+1. The old strict "=== expected + 1" check
    // stopped the bridge here and failed the in-flight prompt; now it re-adopts.
    const ws2 = latestWs();
    ws2.handlers.open?.();
    sendWsMessage(
      {
        type: "sandbox_session",
        sessionKey: "session-key-3",
        connectionGeneration: 3,
        nextAuthToken: "next-auth-token-3",
      },
      ws2,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Bridge stays alive: no fatal 4002 close, no further reconnect, and it
    // adopted generation 3 along with the fresh auth token.
    expect(ws2.close).not.toHaveBeenCalled();
    expect(mocks.wsInstances.length).toBe(2);
    const bridgeInternals = bridge as unknown as {
      controlPlaneSession: { expectedSandboxConnectionGeneration: number | null };
      sandboxWsAuthToken: string;
    };
    expect(bridgeInternals.controlPlaneSession.expectedSandboxConnectionGeneration).toBe(3);
    // The fresh auth token from the adopted frame must be installed -- this is the
    // side of the fix that ends the 403 cascade observed in the production incident
    // (a stale, un-rotated sandbox token).
    expect(bridgeInternals.sandboxWsAuthToken).toBe("next-auth-token-3");

    bridge.shutdown();
    closeWs(ws2);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
  });
});
