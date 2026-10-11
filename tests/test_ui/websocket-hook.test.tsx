import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uiMocks = vi.hoisted(() => ({
  captureUiError: vi.fn(),
  postSessionWsTelemetry: vi.fn(),
  trackAction: vi.fn(),
}));

vi.mock("../../apps/ui/src/datadog.ts", () => ({
  addSessionTiming: vi.fn(),
  trackAction: uiMocks.trackAction,
}));
vi.mock("../../apps/ui/src/datadog", () => ({
  addSessionTiming: vi.fn(),
  trackAction: uiMocks.trackAction,
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  captureUiError: uiMocks.captureUiError,
}));
vi.mock("../../apps/ui/src/sentry", () => ({
  captureUiError: uiMocks.captureUiError,
}));

vi.mock("../../apps/ui/src/api/sessionTelemetry.ts", () => ({
  postSessionWsTelemetry: uiMocks.postSessionWsTelemetry,
}));
vi.mock("../../apps/ui/src/api/sessionTelemetry", () => ({
  postSessionWsTelemetry: uiMocks.postSessionWsTelemetry,
}));

import { getSessionWsUrl } from "../../apps/ui/src/api/sessions";
import { WS_LIVENESS_THRESHOLD_MS, WS_WATCHDOG_ESCALATION_THRESHOLD } from "../../apps/ui/src/constants";
import { createReconnectBackoff, WS_BLOCKED_THRESHOLD } from "../../apps/ui/src/hooks/sessionWebSocketBackoff";

const INITIAL_RECONNECT_BACKOFF_MS = 500;
const MAX_RECONNECT_BACKOFF_MS = 10_000;
import { parseServerMessage } from "../../apps/ui/src/hooks/sessionWebSocketMessages";
import { trackWsWatchdogEscalated } from "../../apps/ui/src/hooks/sessionWebSocketTelemetry";
import {
  isLivenessMessage,
  type ServerMessage,
  useSessionWebSocket,
} from "../../apps/ui/src/hooks/useSessionWebSocket";

type SubscribedMessage = Extract<ServerMessage, { type: "subscribed" }>;
type SessionEventMessage = Extract<ServerMessage, { type: "session_event" }>;
type ReplayPageMessage = Extract<ServerMessage, { type: "replay_page" }>;
type SandboxEventMessage = Extract<ServerMessage, { type: "sandbox_event" }>;
type PongMessage = Extract<ServerMessage, { type: "pong" }>;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: null | (() => void) = null;
  onmessage: null | ((event: { data: string }) => void) = null;
  onclose: null | (() => void) = null;
  onerror: null | (() => void) = null;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: () => void, options?: { once?: boolean }) {
    if (event !== "open") return;
    const current = this.onopen;
    this.onopen = () => {
      current?.();
      callback();
      if (options?.once) this.onopen = current;
    };
  }

  dispatchOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  dispatchClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  dispatchError() {
    this.onerror?.();
  }

  dispatchMessage(data: object | string) {
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }
}

type HookHarnessProps = {
  enabled?: boolean;
  getLastSequence?: () => number;
  isPromptActive?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onMessage?: (msg: ServerMessage) => void;
  onReady?: (api: ReturnType<typeof useSessionWebSocket>) => void;
  onWsBlocked?: () => void;
  sessionId?: string | null;
};

function HookHarness({
  enabled = true,
  getLastSequence = () => 0,
  isPromptActive = false,
  onConnected,
  onDisconnected,
  onMessage = () => undefined,
  onReady,
  onWsBlocked,
  sessionId = "s-123",
}: HookHarnessProps) {
  const api = useSessionWebSocket({
    enabled,
    getLastSequence,
    isPromptActive,
    onConnected,
    onDisconnected,
    onMessage,
    onWsBlocked,
    sessionId,
  });
  onReady?.(api);
  return null;
}

function makeSubscribed(status = "idle", sessionId = "s-123"): SubscribedMessage {
  return {
    type: "subscribed",
    version: 2,
    session: {
      sessionId,
      ownerUserId: "u-1",
      status,
      closeReason: null,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "Test session",
      model: null,
      repoUrl: "https://github.com/test-owner/test-repo",
      baseBranch: "main",
      lastBranch: null,
      prUrl: null,
      prCreating: false,
      spawnDurationMs: null,
    },
    sandbox: {
      status: "ready",
      sandboxId: "sb-1",
      connected: true,
      spawnDurationMs: null,
    },
    queue: {
      queuedCount: 0,
      processingPromptId: null,
    },
    prompts: [],
    lastDurableSequence: 0,
    replay: {
      afterSequence: 0,
      events: [],
      hasMore: false,
      droppedCount: 0,
      firstSequence: null,
      lastSequence: null,
    },
  };
}

function makeSessionEvent(sequence: number): SessionEventMessage {
  return {
    type: "session_event",
    event: { type: "text", sequence, data: { text: `event-${sequence}` } },
  };
}

function makeReplayPage(beforeSequence?: number | null): ReplayPageMessage {
  return {
    type: "replay_page",
    afterSequence: 10,
    beforeSequence,
    events: [],
    hasMore: false,
    droppedCount: 0,
    firstSequence: null,
    lastSequence: null,
  };
}

function makeSandboxEvent(): SandboxEventMessage {
  return {
    type: "sandbox_event",
    event: { type: "heartbeat", status: "connected" },
  };
}

function makePong(): PongMessage {
  return { type: "pong" };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.dynamicImportSettled();
  });
  act(() => {
    vi.advanceTimersByTime(0);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.dynamicImportSettled();
  });
}

describe("getSessionWsUrl", () => {
  beforeEach(() => {
    const happyWindow = new Window({ url: "https://app.trycycloid.com/" });
    Object.assign(globalThis, {
      WebSocket: FakeWebSocket,
      document: happyWindow.document,
      window: happyWindow,
    });
  });

  it("builds wss URL from https location", () => {
    const url = getSessionWsUrl("s-123");
    expect(url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws");
  });

  it("appends afterSequence when provided", () => {
    const url = getSessionWsUrl("s-123", 42);
    expect(url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws?afterSequence=42");
  });

  it("omits afterSequence when undefined", () => {
    const url = getSessionWsUrl("s-123", undefined);
    expect(url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws");
  });

  it("includes afterSequence=0 (means from beginning)", () => {
    const url = getSessionWsUrl("s-123", 0);
    expect(url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws?afterSequence=0");
  });
});

describe("useSessionWebSocket", () => {
  let container: HTMLElement;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let root: Root;
  let visibilityState: "hidden" | "visible" = "visible";

  function setDocumentVisibility(nextState: "hidden" | "visible") {
    visibilityState = nextState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
  }

  function renderHarness(props: HookHarnessProps = {}) {
    act(() => {
      root.render(createElement(HookHarness, props));
    });
  }

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  function openSocket(index: number) {
    const socket = FakeWebSocket.instances[index];
    act(() => {
      socket.dispatchOpen();
    });
    return socket;
  }

  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // random=0.5 keeps reconnect-backoff jitter at the nominal 1.0× delay so
    // assertions on reconnect timing stay deterministic.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const happyWindow = new Window({ url: "https://app.trycycloid.com/" });
    Object.assign(globalThis, {
      Event: happyWindow.Event,
      WebSocket: FakeWebSocket,
      document: happyWindow.document,
      window: happyWindow,
    });
    setDocumentVisibility("visible");

    container = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(container);
    root = createRoot(container);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await flushAsyncWork();
    act(() => {
      root.unmount();
    });
    await flushAsyncWork();
    consoleWarnSpy.mockRestore();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("connects, reports telemetry, and sends client pings", async () => {
    const onConnected = vi.fn();
    renderHarness({ onConnected });

    const ws = openSocket(0);
    await flushAsyncWork();

    expect(ws.url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(uiMocks.trackAction).toHaveBeenCalledWith("ws_connected", { sessionId: "s-123" });
    expect(uiMocks.postSessionWsTelemetry).toHaveBeenCalledWith("s-123", { action: "ws_connected" });

    advance(30_000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));
  });

  it("pauses ping and watchdog timers while hidden and resumes them on visibility", () => {
    renderHarness({ isPromptActive: true });

    const ws = openSocket(0);
    setDocumentVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    advance(WS_LIVENESS_THRESHOLD_MS + 30_000);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();

    setDocumentVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    advance(30_000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("does not schedule duplicate reconnects when a transport error fires", async () => {
    renderHarness();

    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.dispatchError();
    });
    await flushAsyncWork();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("sends replay page requests only while the socket is open", () => {
    let api: ReturnType<typeof useSessionWebSocket> | null = null;
    renderHarness({
      onReady: (value) => {
        api = value;
      },
    });

    expect(api?.requestReplayPage({ beforeSequence: 88, limit: 200 })).toBe(false);

    const ws = openSocket(0);
    expect(api?.requestReplayPage({ beforeSequence: 88, limit: 200 })).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "request_replay_page", beforeSequence: 88, limit: 200 }),
    );
  });

  it("forces close and reconnects after a post-bootstrap stall during an active prompt", async () => {
    const onDisconnected = vi.fn();
    renderHarness({ isPromptActive: true, onDisconnected });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(WS_LIVENESS_THRESHOLD_MS);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await flushAsyncWork();
    expect(uiMocks.captureUiError).not.toHaveBeenCalled();
  });

  it("repeated pong frames alone do not suppress the watchdog", () => {
    renderHarness({ isPromptActive: true });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(20_000);
    act(() => {
      ws.dispatchMessage(makePong());
    });
    advance(20_000);
    act(() => {
      ws.dispatchMessage(makePong());
    });
    advance(20_000);
    act(() => {
      ws.dispatchMessage(makePong());
    });
    advance(20_000);
    act(() => {
      ws.dispatchMessage(makePong());
    });
    advance(10_000);

    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("application-level frames reset the watchdog timer", () => {
    renderHarness({ isPromptActive: true });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(75_000);
    act(() => {
      ws.dispatchMessage(makeSessionEvent(1));
    });
    advance(15_000);

    expect(ws.close).not.toHaveBeenCalled();

    advance(60_000);
    expect(ws.close).not.toHaveBeenCalled();

    advance(15_000);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("sandbox_event frames do not reset the watchdog timer", () => {
    renderHarness({ isPromptActive: true });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(75_000);
    act(() => {
      ws.dispatchMessage(makeSandboxEvent());
    });
    advance(15_000);

    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("backward replay pages do not reset the watchdog timer", () => {
    renderHarness({ isPromptActive: true });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(75_000);
    act(() => {
      ws.dispatchMessage(makeReplayPage(5));
    });
    advance(15_000);

    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("malformed known frames do not reach onMessage or reset the watchdog timer", () => {
    const onMessage = vi.fn();
    renderHarness({ isPromptActive: true, onMessage });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    advance(75_000);
    act(() => {
      ws.dispatchMessage({ type: "replay_page" });
    });
    advance(15_000);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("reconnects with the latest afterSequence cursor", () => {
    let lastSequence = 0;
    renderHarness({
      getLastSequence: () => lastSequence,
      isPromptActive: true,
    });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    lastSequence = 42;
    advance(WS_LIVENESS_THRESHOLD_MS);
    advance(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("wss://app.trycycloid.com/api/sessions/s-123/ws?afterSequence=42");
  });

  it("does not fire during idle phases once bootstrap is complete", () => {
    renderHarness({ isPromptActive: false });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("idle"));
    });

    advance(WS_LIVENESS_THRESHOLD_MS * 3);
    expect(ws.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("still triggers the blocked-websocket fallback after repeated transport failures", async () => {
    const onWsBlocked = vi.fn();
    renderHarness({ onWsBlocked });

    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      FakeWebSocket.instances[0].dispatchClose();
    });
    expect(uiMocks.captureUiError).not.toHaveBeenCalled();

    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => {
      FakeWebSocket.instances[1].dispatchClose();
    });
    expect(uiMocks.captureUiError).not.toHaveBeenCalled();

    advance(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => {
      FakeWebSocket.instances[2].dispatchClose();
    });

    await flushAsyncWork();
    expect(onWsBlocked).toHaveBeenCalledTimes(1);

    advance(2000);
    expect(FakeWebSocket.instances).toHaveLength(4);
    act(() => {
      FakeWebSocket.instances[3].dispatchClose();
    });

    await flushAsyncWork();
    expect(onWsBlocked).toHaveBeenCalledTimes(1);
  });

  it("cleans up timers on unmount and stale timers do not affect a new hook instance", () => {
    renderHarness({ isPromptActive: true });

    const firstSocket = openSocket(0);
    act(() => {
      firstSocket.dispatchMessage(makeSubscribed("running"));
      root.unmount();
    });

    expect(firstSocket.close).toHaveBeenCalledTimes(1);

    root = createRoot(container);
    renderHarness({ isPromptActive: false, sessionId: "s-456" });
    const secondSocket = openSocket(1);
    act(() => {
      secondSocket.dispatchMessage(makeSubscribed("idle", "s-456"));
    });

    advance(WS_LIVENESS_THRESHOLD_MS * 2);
    expect(secondSocket.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("updates liveness before invoking the message handler callback", () => {
    const onMessage = vi.fn(() => {
      throw new Error("boom");
    });
    renderHarness({ isPromptActive: true, onMessage });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(75_000);
    act(() => {
      ws.dispatchMessage(makeSessionEvent(2));
    });
    advance(15_000);

    expect(ws.close).not.toHaveBeenCalled();

    advance(60_000);
    expect(ws.close).not.toHaveBeenCalled();

    advance(15_000);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("starts the blocked-websocket fallback on the first watchdog stall during an active prompt", async () => {
    const onWsBlocked = vi.fn();
    renderHarness({ isPromptActive: true, onWsBlocked });

    const ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    // A single liveness window — well under the old 3×90s escalation — must
    // start HTTP fallback so a half-open transport doesn't hang the transcript.
    advance(WS_LIVENESS_THRESHOLD_MS);
    expect(ws.close).toHaveBeenCalledTimes(1);

    await flushAsyncWork();
    expect(onWsBlocked).toHaveBeenCalledTimes(1);
    // Sentry is reserved for the persistent-failure escalation marker; a single
    // first-stall fallback must not page.
    expect(uiMocks.captureUiError).not.toHaveBeenCalled();

    // The reconnect still proceeds in parallel with the fallback.
    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not re-trigger fallback on subsequent watchdog stalls without recovery", async () => {
    const onWsBlocked = vi.fn();
    renderHarness({ isPromptActive: true, onWsBlocked });

    let ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    for (let stall = 1; stall <= WS_WATCHDOG_ESCALATION_THRESHOLD + 2; stall++) {
      advance(WS_LIVENESS_THRESHOLD_MS);
      expect(ws.close).toHaveBeenCalledTimes(1);

      advance(500);
      ws = openSocket(stall); // reconnect; no fresh `subscribed`, so no liveness reset
    }

    await flushAsyncWork();
    expect(onWsBlocked).toHaveBeenCalledTimes(1);
  });

  it("re-arms fallback for a fresh stall episode after the socket recovers", async () => {
    const onWsBlocked = vi.fn();
    renderHarness({ isPromptActive: true, onWsBlocked });

    let ws = openSocket(0);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running"));
    });

    advance(WS_LIVENESS_THRESHOLD_MS); // first stall episode -> fallback #1
    advance(500);
    ws = openSocket(1);
    act(() => {
      ws.dispatchMessage(makeSubscribed("running")); // recovery resets the stall streak
    });

    advance(WS_LIVENESS_THRESHOLD_MS); // a fresh stall after recovery -> fallback #2

    await flushAsyncWork();
    expect(onWsBlocked).toHaveBeenCalledTimes(2);
  });

  it("trackWsWatchdogEscalated pages Sentry for a persistently stalled transport (not 'escalated to fallback')", async () => {
    trackWsWatchdogEscalated("s-esc", 3);

    await flushAsyncWork();
    expect(uiMocks.trackAction).toHaveBeenCalledWith("ws_watchdog_escalated", {
      sessionId: "s-esc",
      consecutiveWatchdogStalls: 3,
    });
    expect(uiMocks.postSessionWsTelemetry).toHaveBeenCalledWith("s-esc", {
      action: "ws_watchdog_escalated",
      consecutiveWatchdogStalls: 3,
    });
    expect(uiMocks.captureUiError).toHaveBeenCalledTimes(1);
    const [err, ctx] = uiMocks.captureUiError.mock.calls[0];
    // Fallback now starts at stall #1, so the escalation marker must not claim it
    // "escalated to fallback" — it marks a persistently dead/stalled transport.
    expect(err.message).toBe("Session WebSocket watchdog: transport persistently stalled");
    expect(ctx).toMatchObject({ operation: "ws_watchdog_escalated", sessionId: "s-esc", stalls: "3" });
  });
});

describe("Reconnect backoff controller", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // random=0.5 lands the jitter multiplier at the nominal 1.0× delay,
    // so existing exact-delay assertions remain stable.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("tracks transport failures and caps reconnect delay without a WebSocket", () => {
    const backoff = createReconnectBackoff();

    for (let attempt = 1; attempt <= WS_BLOCKED_THRESHOLD; attempt++) {
      backoff.recordClose(null);
    }

    expect(backoff.getConsecutiveFailures()).toBe(WS_BLOCKED_THRESHOLD);
    expect(backoff.shouldNotifyBlocked()).toBe(true);
    backoff.markBlockedNotified();
    expect(backoff.shouldNotifyBlocked()).toBe(false);

    let delay = 0;
    for (let index = 0; index < 10; index++) {
      delay = backoff.consumeReconnectDelay();
    }
    expect(delay).toBe(MAX_RECONNECT_BACKOFF_MS);
  });

  it("resets failures and delay on successful connection while watchdog closes do not count as failures", () => {
    const backoff = createReconnectBackoff();

    backoff.recordClose(null);
    expect(backoff.consumeReconnectDelay()).toBe(INITIAL_RECONNECT_BACKOFF_MS);
    expect(backoff.consumeReconnectDelay()).toBe(INITIAL_RECONNECT_BACKOFF_MS * 2);

    backoff.recordConnected();
    backoff.recordClose("watchdog");

    expect(backoff.getConsecutiveFailures()).toBe(0);
    expect(backoff.consumeReconnectDelay()).toBe(INITIAL_RECONNECT_BACKOFF_MS);
  });
});

describe("ServerMessage parsing", () => {
  it("parses known server messages", () => {
    const subscribed = makeSubscribed("idle");
    expect(parseServerMessage(JSON.stringify(subscribed))).toEqual(subscribed);
  });

  it("ignores invalid JSON and unknown top-level message types", () => {
    expect(parseServerMessage("{not-json")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "unknown_frame" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ok: true }))).toBeNull();
  });

  it("ignores known message types with malformed payloads", () => {
    expect(parseServerMessage(JSON.stringify({ type: "session_event" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "replay_page" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "pr_created", prUrl: "https://example.com/pr/1" }))).toBeNull();
  });
});

describe("ServerMessage liveness", () => {
  it("treats forward progress frames as liveness and ignores noise frames", () => {
    expect(isLivenessMessage(makeSubscribed("idle"))).toBe(true);
    expect(isLivenessMessage(makeSessionEvent(1))).toBe(true);
    expect(isLivenessMessage(makeReplayPage(undefined))).toBe(true);
    expect(isLivenessMessage(makeReplayPage(5))).toBe(false);
    expect(isLivenessMessage(makeSandboxEvent())).toBe(false);
    expect(isLivenessMessage(makePong())).toBe(false);
  });

  it("replay_error is not a liveness frame -- it indicates a malformed request, not server progress", () => {
    // ARC-453: replay_error tells the client its `request_replay_page` payload
    // was malformed. It is not a liveness signal because no replay events are
    // delivered, and the watchdog should not reset on it.
    const msg: ServerMessage = { type: "replay_error", message: "limit must be a positive integer" };
    expect(isLivenessMessage(msg)).toBe(false);
  });
});

describe("ServerMessage shapes", () => {
  it("session_event has event with sequence", () => {
    const msg = makeSessionEvent(1);
    expect(msg.event.sequence).toBe(1);
    expect(msg.event.type).toBe("text");
  });

  it("replay_event has event with sequence", () => {
    const msg = {
      type: "replay_event" as const,
      event: { type: "tool_call", sequence: 5, data: { tool: "bash" } },
    };
    expect(msg.event.sequence).toBe(5);
  });

  it("replay_page carries a batched replay cursor", () => {
    const msg = {
      type: "replay_page" as const,
      afterSequence: 0,
      beforeSequence: 101,
      events: [{ type: "text", sequence: 100, data: { text: "older" } }],
      hasMore: true,
      droppedCount: 1,
      firstSequence: 100,
      lastSequence: 100,
    };
    expect(msg.beforeSequence).toBe(101);
    expect(msg.events[0].sequence).toBe(100);
  });

  it("replay_truncated carries a truncation sentinel", () => {
    const msg = {
      type: "replay_truncated" as const,
      requestedAfterSequence: 10,
      firstReturnedSequence: 50,
      lastReturnedSequence: 250,
      droppedCount: 1,
    };
    expect(msg.droppedCount).toBe(1);
  });
});
