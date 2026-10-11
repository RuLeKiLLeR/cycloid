import { Window } from "happy-dom";
import { act, createElement, type ReactElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionHeader } from "../../apps/ui/src/components/SessionHeader";
import { FALLBACK_POLL_INITIAL_MS, RESILIENCE_POLL_MS, WS_BOOTSTRAP_TIMEOUT_MS } from "../../apps/ui/src/constants";
import { trackAction } from "../../apps/ui/src/datadog";
import { useSessionBootstrap } from "../../apps/ui/src/hooks/useSessionBootstrap";
import { useSessionFallbackPolling } from "../../apps/ui/src/hooks/useSessionFallbackPolling";
import { useSessionReplay } from "../../apps/ui/src/hooks/useSessionReplay";
import { useSessionState } from "../../apps/ui/src/hooks/useSessionState";
import type { PromptRow, SessionDetail } from "../../apps/ui/src/types";

const apiMocks = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
  fetchPromptEvents: vi.fn(async () => ({
    ok: true,
    result: {
      events: [],
      maxSequence: 0,
      complete: true,
    },
  })),
  fetchPromptEventsPage: vi.fn(async () => ({
    ok: true,
    result: {
      events: [],
      maxSequence: 0,
      complete: true,
      nextAfterSequence: null,
      rawEventCount: 0,
    },
    rawEvents: [],
  })),
  fetchSessionHistoryProbe: vi.fn(async () => ({
    ok: true,
    complete: false,
    rawEventCount: 1000,
    lastSequence: 1000,
  })),
  fetchSessionView: vi.fn(async () => ({
    session: {
      sessionId: "s-1",
      phase: "idle",
    },
    prompts: [],
  })),
  submitMemoryFeedback: vi.fn(async () => {
    throw new Error("submitMemoryFeedback mock should not be called");
  }),
}));

const wsMocks = vi.hoisted(() => ({
  options: undefined as
    | undefined
    | {
        onMessage: (msg: unknown) => void;
        onWsBlocked?: () => void;
        onConnected?: () => void;
        onDisconnected?: () => void;
      },
  requestReplayPage: vi.fn(() => true),
}));

vi.mock("../../apps/ui/src/api/client.ts", () => ({
  ApiError: apiMocks.ApiError,
}));

vi.mock("../../apps/ui/src/api/sessions.ts", () => ({
  buildPromptEventsResult: (rawEvents: Array<{ sequence?: number; data?: { id?: string; text?: string } }>) => ({
    events: rawEvents.map((event, index) => ({
      type: "text",
      id: event.data?.id ?? `text-${index}`,
      text: event.data?.text ?? "",
    })),
    maxSequence: rawEvents.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0),
  }),
  fetchPromptEvents: apiMocks.fetchPromptEvents,
  fetchPromptEventsPage: apiMocks.fetchPromptEventsPage,
  fetchSessionHistoryProbe: apiMocks.fetchSessionHistoryProbe,
  fetchSessionView: apiMocks.fetchSessionView,
  submitMemoryFeedback: apiMocks.submitMemoryFeedback,
}));

vi.mock("../../apps/ui/src/hooks/useSessionWebSocket.ts", () => ({
  isLivenessMessage: (msg: { type?: string }) =>
    ["subscribed", "session_event", "replay_event", "replay_truncated", "session_status"].includes(msg.type ?? ""),
  useSessionWebSocket: (options: NonNullable<typeof wsMocks.options>) => {
    wsMocks.options = options;
    return { requestReplayPage: wsMocks.requestReplayPage };
  },
}));

vi.mock("../../apps/ui/src/datadog.ts", () => ({
  addSessionTiming: vi.fn(),
  setDatadogSessionContext: vi.fn(),
  clearDatadogSessionContext: vi.fn(),
  trackAction: vi.fn(),
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  captureUiError: vi.fn(),
}));

type FallbackControls = ReturnType<typeof useSessionFallbackPolling>;

let happyWindow: Window;
let root: Root;
let container: HTMLElement;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    IntersectionObserver: class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-1",
    phase: "idle",
    title: "Test session",
    repoUrl: "https://github.com/test-owner/test-repo",
    prUrl: null,
    createdAt: 0,
    model: null,
    queueLength: 0,
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  };
}

function makePrompt(promptId: string, result: string | null = null): PromptRow {
  return { promptId, session_id: "s-1", prompt: "plan it", result, status: result == null ? "running" : "completed" };
}

function makeSubscribedMessage(overrides?: Partial<ReturnType<typeof makeSession>> & { ownerUserId?: string }) {
  return {
    type: "subscribed" as const,
    version: 2,
    session: {
      sessionId: "s-1",
      ownerUserId: "u-1",
      phase: "idle",
      closeReason: null,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "Replay bootstrap",
      model: null,
      repoUrl: "https://github.com/test-owner/test-repo",
      baseBranch: "main",
      lastBranch: null,
      prUrl: null,
      prCreating: false,
      spawnDurationMs: null,
      ...overrides,
    },
    sandbox: {
      status: "ready",
      sandboxId: "sb-1",
      connected: true,
      spawnDurationMs: null,
    },
    queue: { queuedCount: 0, processingPromptId: null },
    prompts: [makePrompt("p-1")],
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

function render(element: ReactElement) {
  act(() => {
    root.render(element);
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionDetail extracted hooks", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/sessions/s-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    wsMocks.options = undefined;
    wsMocks.requestReplayPage.mockReturnValue(true);
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: (callback: () => void) => {
        callback();
        return 1;
      },
    });
    Object.defineProperty(globalThis, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    happyWindow?.close();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    vi.useRealTimers();
  });

  it("keeps fallback polling on completed and clears it on archived", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // pin backoff jitter to zero
    const refresh = vi.fn(async () => undefined);
    let controls: FallbackControls | undefined;

    function Harness({ phase }: { phase: SessionDetail["phase"] }) {
      const refreshRef = useRef(refresh);
      refreshRef.current = refresh;
      controls = useSessionFallbackPolling({ refreshRef, sessionPhase: phase });
      return null;
    }

    render(createElement(Harness, { phase: "running" }));

    act(() => controls?.startResiliencePolling());
    act(() => vi.advanceTimersByTime(RESILIENCE_POLL_MS - 1));
    expect(refresh).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => controls?.startAggressiveFallbackPolling());
    act(() => vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS));
    expect(refresh).toHaveBeenCalledTimes(2);

    render(createElement(Harness, { phase: "completed" }));
    // Backoff doubled after the first aggressive tick.
    act(() => vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS * 2));
    expect(refresh).toHaveBeenCalledTimes(3);

    render(createElement(Harness, { phase: "archived" }));
    act(() => vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS * 4));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("keeps HTTP refresh polling on completed and stops it on archived", async () => {
    const stopPolling = vi.fn();
    let refresh: ReturnType<typeof useSessionBootstrap>["refresh"] | undefined;

    function Harness() {
      refresh = useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling,
      }).refresh;
      return null;
    }

    render(createElement(Harness));

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: makeSession({ phase: "completed" }),
      prompts: [],
    });
    await act(async () => {
      await refresh?.();
    });
    expect(stopPolling).not.toHaveBeenCalled();

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: makeSession({ phase: "archived" }),
      prompts: [],
    });
    await act(async () => {
      await refresh?.();
    });
    expect(stopPolling).toHaveBeenCalledTimes(1);
  });

  it("starts cold HTTP bootstrap immediately without waiting for the websocket timeout", async () => {
    vi.useFakeTimers();
    const initializeSessionData = vi.fn();

    function Harness() {
      useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initializeSessionData,
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    await act(async () => {
      await flushAsyncWork();
    });

    expect(initializeSessionData).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }), []);
  });

  it("starts seeded HTTP bootstrap immediately without waiting for the websocket timeout", async () => {
    vi.useFakeTimers();
    const initializeSessionData = vi.fn();

    function Harness() {
      useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initialSession: makeSession(),
        initializeSessionData,
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_BOOTSTRAP_TIMEOUT_MS - 1);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);
    expect(initializeSessionData).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }), []);
  });

  it("surfaces a seeded HTTP bootstrap failure after the websocket timeout has elapsed", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ session: SessionDetail; prompts: PromptRow[] }>();
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionView.mockReturnValueOnce(pending.promise);

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initialSession: makeSession(),
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_BOOTSTRAP_TIMEOUT_MS);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.reject(new Error("late bootstrap failure"));
      await pending.promise.catch(() => undefined);
      await flushAsyncWork();
    });

    expect(bootstrap?.error).toContain("late bootstrap failure");
  });

  it("marks retry-helper prompt history as hydrated after a successful fetch", async () => {
    const stableSession = makeSession();
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchPromptEvents.mockResolvedValueOnce({
      ok: true,
      result: { events: [], maxSequence: 0, complete: true },
    });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      await bootstrap?.fetchPromptHistoryWithRetry("p-1");
      await flushAsyncWork();
    });

    expect(bootstrap?.promptHistoryStates.get("p-1")).toBe("hydrated");
  });

  it("loads the next prompt metadata page and hydrates newly loaded prompts", async () => {
    const firstPrompt = makePrompt("p-1", "done");
    const secondPrompt = makePrompt("p-2", "done");
    const stableSession = makeSession();
    let currentPrompts = [firstPrompt];
    const mergeSessionMetadata = vi.fn((_session: SessionDetail, prompts: PromptRow[]) => {
      currentPrompts = prompts;
    });
    const initializeSessionData = vi.fn();
    const navigate = vi.fn();
    const setSessions = vi.fn();
    const startPolling = vi.fn();
    const stopPolling = vi.fn();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionView
      .mockResolvedValueOnce({
        session: stableSession,
        prompts: [firstPrompt],
        promptPage: { nextCursor: "cursor-2", total: 2 },
      })
      .mockResolvedValueOnce({
        session: stableSession,
        prompts: [secondPrompt],
        promptPage: { nextCursor: null, total: 2 },
      });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => currentPrompts,
        initialSession: stableSession,
        initializeSessionData,
        mergeSessionMetadata,
        navigate,
        sessionId: "s-1",
        setSessions,
        startPolling,
        stopPolling,
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      await flushAsyncWork();
    });

    expect(bootstrap?.promptPage).toEqual({ nextCursor: "cursor-2", total: 2 });

    await act(async () => {
      await bootstrap?.loadNextPromptPage();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenLastCalledWith("s-1", "cursor-2");
    expect(mergeSessionMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s-1" }), [
      firstPrompt,
      secondPrompt,
    ]);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(bootstrap?.promptPage).toEqual({ nextCursor: null, total: 2 });
  });

  it("loads all remaining prompt metadata pages and hydrates each loaded page", async () => {
    const firstPrompt = makePrompt("p-1", "done");
    const secondPrompt = makePrompt("p-2", "done");
    const thirdPrompt = makePrompt("p-3", "done");
    const stableSession = makeSession();
    let currentPrompts = [firstPrompt];
    const mergeSessionMetadata = vi.fn((_session: SessionDetail, prompts: PromptRow[]) => {
      currentPrompts = prompts;
    });
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionView
      .mockResolvedValueOnce({
        session: stableSession,
        prompts: [firstPrompt],
        promptPage: { nextCursor: "cursor-2", total: 3 },
      })
      .mockResolvedValueOnce({
        session: stableSession,
        prompts: [secondPrompt],
        promptPage: { nextCursor: "cursor-3", total: 3 },
      })
      .mockResolvedValueOnce({
        session: stableSession,
        prompts: [thirdPrompt],
        promptPage: { nextCursor: null, total: 3 },
      });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => currentPrompts,
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata,
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      await flushAsyncWork();
    });
    apiMocks.fetchPromptEventsPage.mockClear();

    await act(async () => {
      await bootstrap?.loadRemainingPromptPages();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenNthCalledWith(2, "s-1", "cursor-2");
    expect(apiMocks.fetchSessionView).toHaveBeenNthCalledWith(3, "s-1", "cursor-3");
    expect(mergeSessionMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s-1" }), [
      firstPrompt,
      secondPrompt,
      thirdPrompt,
    ]);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-3",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(bootstrap?.promptPage).toEqual({ nextCursor: null, total: 3 });
  });

  it("applies the first prompt history page before later pages finish", async () => {
    const stableSession = makeSession();
    const prompt = makePrompt("p-1", "done");
    const secondPage = deferred<{
      ok: true;
      result: { events: never[]; maxSequence: number; complete: true; nextAfterSequence: null; rawEventCount: number };
      rawEvents: Array<{ sequence: number; type: string; data: { promptId: string; id: string; text: string } }>;
    }>();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;
    const idleScheduler = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    idleScheduler.requestIdleCallback = (callback) => {
      callback();
      return 1;
    };
    idleScheduler.cancelIdleCallback = vi.fn();

    apiMocks.fetchPromptEventsPage
      .mockResolvedValueOnce({
        ok: true,
        result: {
          events: [{ type: "text", id: "t-1", text: "first page" }],
          maxSequence: 10,
          complete: false,
          nextAfterSequence: 10,
          rawEventCount: 1,
        },
        rawEvents: [{ sequence: 10, type: "text", data: { promptId: "p-1", id: "t-1", text: "first page" } }],
      })
      .mockReturnValueOnce(secondPage.promise);

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [prompt],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1"]);
      await flushAsyncWork();
    });

    expect(applyPromptHistoryFetchResult).toHaveBeenCalledTimes(1);
    expect(applyPromptHistoryFetchResult).toHaveBeenLastCalledWith(
      "p-1",
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          complete: false,
          events: [expect.objectContaining({ text: "first page" })],
          nextAfterSequence: 10,
        }),
        rawEvents: [expect.objectContaining({ sequence: 10 })],
      }),
    );

    secondPage.resolve({
      ok: true,
      result: { events: [], maxSequence: 11, complete: true, nextAfterSequence: null, rawEventCount: 1 },
      rawEvents: [{ sequence: 11, type: "text", data: { promptId: "p-1", id: "t-2", text: "second page" } }],
    });

    await act(async () => {
      await secondPage.promise;
      await flushAsyncWork();
    });

    expect(applyPromptHistoryFetchResult).toHaveBeenCalledTimes(2);
    expect(applyPromptHistoryFetchResult).toHaveBeenLastCalledWith(
      "p-1",
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          complete: true,
          events: [expect.objectContaining({ text: "first page" }), expect.objectContaining({ text: "second page" })],
        }),
        rawEvents: [expect.objectContaining({ sequence: 10 }), expect.objectContaining({ sequence: 11 })],
      }),
    );
    expect(apiMocks.fetchSessionHistoryProbe).not.toHaveBeenCalled();
  });

  it("marks prompt history incomplete when progressive hydration throws unexpectedly", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    const unexpectedError = new Error("history parser exploded");
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchPromptEventsPage.mockRejectedValueOnce(unexpectedError);

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [makePrompt("p-1", "done")],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1"]);
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(applyPromptHistoryFetchResult).toHaveBeenCalledWith("p-1", {
      ok: false,
      error: unexpectedError,
    });
    expect(bootstrap?.promptHistoryStates.get("p-1")).toBe("failed");
  });

  it("hydrates many short prompts from one complete session-wide probe", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionHistoryProbe.mockResolvedValueOnce({
      ok: true,
      complete: true,
      rawEventCount: 3,
      lastSequence: 3,
      results: new Map([
        [
          "p-1",
          {
            events: [{ type: "text", id: "t-1", text: "first" }],
            maxSequence: 1,
            complete: true,
            rawEvents: [{ sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "first" } }],
          },
        ],
        [
          "p-2",
          {
            events: [{ type: "text", id: "t-2", text: "second" }],
            maxSequence: 2,
            complete: true,
            rawEvents: [{ sequence: 2, type: "text", data: { promptId: "p-2", id: "t-2", text: "second" } }],
          },
        ],
        [
          "p-3",
          {
            events: [{ type: "text", id: "t-3", text: "third" }],
            maxSequence: 3,
            complete: true,
            rawEvents: [{ sequence: 3, type: "text", data: { promptId: "p-3", id: "t-3", text: "third" } }],
          },
        ],
      ]),
    });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [makePrompt("p-1", "done"), makePrompt("p-2", "done"), makePrompt("p-3", "done")],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1", "p-2", "p-3"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledWith(
      "s-1",
      ["p-1", "p-2", "p-3"],
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).not.toHaveBeenCalled();
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledTimes(3);
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledWith(
      "p-1",
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ complete: true, events: [expect.objectContaining({ text: "first" })] }),
        rawEvents: [expect.objectContaining({ sequence: 1 })],
      }),
    );
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledWith(
      "p-3",
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ complete: true, events: [expect.objectContaining({ text: "third" })] }),
      }),
    );
  });

  it("keeps visible terminal prompts on the session-wide probe", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionHistoryProbe.mockResolvedValueOnce({
      ok: true,
      complete: true,
      rawEventCount: 3,
      lastSequence: 3,
      results: new Map([
        ["p-1", { events: [{ type: "text", id: "t-1", text: "first" }], maxSequence: 1, complete: true }],
        ["p-2", { events: [{ type: "text", id: "t-2", text: "second" }], maxSequence: 2, complete: true }],
        ["p-3", { events: [{ type: "text", id: "t-3", text: "third" }], maxSequence: 3, complete: true }],
      ]),
    });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [makePrompt("p-1", "done"), makePrompt("p-2", "done"), makePrompt("p-3", "done")],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1", "p-2", "p-3"]);
      bootstrap?.prioritizePromptHistories(["p-1", "p-2", "p-3"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledWith(
      "s-1",
      ["p-1", "p-2", "p-3"],
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).not.toHaveBeenCalled();
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledTimes(3);
  });

  it("lets the in-flight prompt bypass the session-wide probe", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionHistoryProbe.mockResolvedValueOnce({
      ok: true,
      complete: true,
      rawEventCount: 2,
      lastSequence: 3,
      results: new Map([
        ["p-1", { events: [{ type: "text", id: "t-1", text: "first" }], maxSequence: 1, complete: true }],
        ["p-3", { events: [{ type: "text", id: "t-3", text: "third" }], maxSequence: 3, complete: true }],
      ]),
    });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [makePrompt("p-1", "done"), makePrompt("p-2"), makePrompt("p-3", "done")],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1", "p-2", "p-3"]);
      bootstrap?.prioritizePromptHistories(["p-2"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledWith("s-1", ["p-1", "p-3"], expect.any(AbortSignal));
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
  });

  it("falls back to prompt-scoped hydration when the session-wide probe has more events", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionHistoryProbe.mockResolvedValueOnce({
      ok: true,
      complete: false,
      rawEventCount: 1000,
      lastSequence: 1000,
    });

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [makePrompt("p-1", "done"), makePrompt("p-2", "done")],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1", "p-2"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      1,
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      2,
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
  });

  it("drains prompts added while the session-wide probe is in flight", async () => {
    const stableSession = makeSession();
    const applyPromptHistoryFetchResult = vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false }));
    const probe = deferred<{
      ok: true;
      complete: true;
      rawEventCount: number;
      lastSequence: number;
      results: Map<
        string,
        { events: Array<{ type: "text"; id: string; text: string }>; maxSequence: number; complete: true }
      >;
    }>();
    let bootstrap: ReturnType<typeof useSessionBootstrap> | undefined;

    apiMocks.fetchSessionHistoryProbe.mockReturnValueOnce(probe.promise);

    function Harness() {
      bootstrap = useSessionBootstrap({
        applyPromptHistoryFetchResult,
        getCurrentPrompts: () => [
          makePrompt("p-1", "done"),
          makePrompt("p-2", "done"),
          makePrompt("p-3", "done"),
          makePrompt("p-4", "done"),
        ],
        initialSession: stableSession,
        initializeSessionData: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-1", "p-2"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessionHistoryProbe).toHaveBeenCalledWith("s-1", ["p-1", "p-2"], expect.any(AbortSignal));

    await act(async () => {
      bootstrap?.hydratePromptHistories(["p-3", "p-4"]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).not.toHaveBeenCalled();

    probe.resolve({
      ok: true,
      complete: true,
      rawEventCount: 2,
      lastSequence: 2,
      results: new Map([
        ["p-1", { events: [{ type: "text", id: "t-1", text: "first" }], maxSequence: 1, complete: true }],
        ["p-2", { events: [{ type: "text", id: "t-2", text: "second" }], maxSequence: 2, complete: true }],
      ]),
    });

    await act(async () => {
      await probe.promise;
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      1,
      "s-1",
      "p-3",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      2,
      "s-1",
      "p-4",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledWith(
      "p-3",
      expect.objectContaining({ ok: true, result: expect.objectContaining({ complete: true }) }),
    );
    expect(applyPromptHistoryFetchResult).toHaveBeenCalledWith(
      "p-4",
      expect.objectContaining({ ok: true, result: expect.objectContaining({ complete: true }) }),
    );
  });

  it("does not apply a cold HTTP bootstrap result after unmount", async () => {
    const initializeSessionData = vi.fn();
    const pending = deferred<{ session: SessionDetail; prompts: PromptRow[] }>();
    apiMocks.fetchSessionView.mockReturnValueOnce(pending.promise);

    function Harness() {
      useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initializeSessionData,
        mergeSessionMetadata: vi.fn(),
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      });
      return null;
    }

    render(createElement(Harness));
    act(() => root.unmount());
    pending.resolve({ session: makeSession(), prompts: [] });
    await act(async () => {
      await pending.promise;
      await flushAsyncWork();
    });

    expect(initializeSessionData).not.toHaveBeenCalled();
  });

  it("handles websocket bootstrap and replay pages without rendering SessionDetailView", () => {
    const mergeSessionMetadata = vi.fn();
    const ingestReplayPage = vi.fn();
    const setError = vi.fn();
    const hydratePromptHistories = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({
          ok: true,
          result: {
            events: [],
            maxSequence: 0,
          },
        })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories,
        ingestReplayPage,
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata,
        session: makeSession(),
        sessionId: "s-1",
        setError,
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage(
        makeSubscribedMessage({
          ownerLogin: "owner-user",
          ownerAvatarUrl: "https://avatars.example.com/owner.png",
        }),
      ),
    );
    expect(mergeSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-1",
        ownerLogin: "owner-user",
        ownerAvatarUrl: "https://avatars.example.com/owner.png",
      }),
      [expect.objectContaining({ promptId: "p-1" })],
    );
    expect(ingestReplayPage).toHaveBeenCalledWith([]);
    expect(hydratePromptHistories).toHaveBeenCalledWith(["p-1"]);

    const replayEvent = { type: "text", sequence: 2, data: { text: "older" } };
    act(() =>
      wsMocks.options?.onMessage({
        type: "replay_page",
        afterSequence: 0,
        beforeSequence: 10,
        events: [replayEvent],
        hasMore: false,
        droppedCount: 0,
        firstSequence: 2,
        lastSequence: 2,
      }),
    );

    expect(ingestReplayPage).toHaveBeenLastCalledWith([replayEvent]);
    expect(setError).toHaveBeenCalledWith(null);

    // Empty replay_page pages still flow through ingestReplayPage so the newest
    // firstSequence value can be applied without an extra short-circuit branch.
    const previousReplayCalls = ingestReplayPage.mock.calls.length;
    act(() =>
      wsMocks.options?.onMessage({
        type: "replay_page",
        afterSequence: 0,
        beforeSequence: 2,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: 0,
        lastSequence: 0,
      }),
    );
    expect(ingestReplayPage).toHaveBeenCalledTimes(previousReplayCalls + 1);
    expect(ingestReplayPage).toHaveBeenLastCalledWith([]);
  });

  it("refreshes the sidebar session list when websocket bootstrap reports new child sessions", () => {
    const refreshSessions = vi.fn(async () => undefined);
    const mergeSessionMetadata = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({
          ok: true,
          result: {
            events: [],
            maxSequence: 0,
          },
        })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata,
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        refreshSessions,
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ childSessionIds: ["child-1", "child-2"] })));

    expect(mergeSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionIds: ["child-1", "child-2"] }),
      expect.any(Array),
    );
    expect(refreshSessions).toHaveBeenCalledTimes(1);

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ childSessionIds: ["child-1", "child-2"] })));

    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("invokes maybeNotify('pr_created') when a pr_created WS message arrives", () => {
    const maybeNotify = vi.fn();
    const dispatchSessionState = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState,
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        maybeNotify,
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        type: "pr_created",
        prUrl: "https://github.com/test/test/pull/1",
        draft: false,
      }),
    );

    expect(dispatchSessionState).toHaveBeenCalledWith(expect.objectContaining({ prActivityKind: "created" }));
    expect(maybeNotify).toHaveBeenCalledTimes(1);
    expect(maybeNotify).toHaveBeenCalledWith("pr_created");

    // pr_updated must not trigger notify.
    maybeNotify.mockClear();
    act(() =>
      wsMocks.options?.onMessage({
        type: "pr_updated",
        prUrl: "https://github.com/test/test/pull/1",
        draft: false,
      }),
    );
    expect(maybeNotify).not.toHaveBeenCalled();
  });

  it("merges lastBranch from a session_status frame so a push re-entry updates the open session", () => {
    const updateSession = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession,
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() => wsMocks.options?.onMessage({ type: "session_status", phase: "review_listening", lastBranch: "feat/x" }));

    const updater = updateSession.mock.calls.at(-1)?.[0] as
      ((prev: SessionDetail | null) => SessionDetail | null) | undefined;
    expect(updater).toBeTypeOf("function");
    expect(updater?.(makeSession({ lastBranch: null }))).toMatchObject({
      phase: "review_listening",
      lastBranch: "feat/x",
    });

    // A frame without lastBranch must not clobber an existing branch.
    act(() => wsMocks.options?.onMessage({ type: "session_status", phase: "review_listening" }));
    const noBranchUpdater = updateSession.mock.calls.at(-1)?.[0] as
      ((prev: SessionDetail | null) => SessionDetail | null) | undefined;
    expect(noBranchUpdater?.(makeSession({ lastBranch: "feat/x" }))).toMatchObject({ lastBranch: "feat/x" });
  });

  it("applies sandbox connectivity from sandbox_ready and heartbeat frames", () => {
    const updateSession = vi.fn();
    const refresh = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession,
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    const lastUpdater = () =>
      updateSession.mock.calls.at(-1)?.[0] as ((prev: SessionDetail | null) => SessionDetail | null) | undefined;

    // sandbox_ready carries the live sandbox id and proves the bridge socket attached.
    act(() => wsMocks.options?.onMessage({ type: "sandbox_ready", sandboxId: "sbx_live_1", spawnDurationMs: 2100 }));
    expect(lastUpdater()?.(makeSession())).toMatchObject({
      sandboxId: "sbx_live_1",
      sandboxConnected: true,
      spawnDurationMs: 2100,
    });

    // The "unknown" placeholder id never clobbers a previously known real id.
    act(() => wsMocks.options?.onMessage({ type: "sandbox_ready", sandboxId: "unknown" }));
    expect(lastUpdater()?.(makeSession({ sandboxId: "sbx_live_1" }))).toMatchObject({
      sandboxId: "sbx_live_1",
      sandboxConnected: true,
    });

    // Reconnect-grace heartbeat flips connected off alongside the substate.
    act(() =>
      wsMocks.options?.onMessage({
        type: "sandbox_event",
        event: { type: "heartbeat", sandboxId: "sbx_live_1", status: "reconnecting", timestamp: 1 },
      }),
    );
    expect(lastUpdater()?.(makeSession({ sandboxConnected: true }))).toMatchObject({
      sandboxSubstate: "reconnecting",
      sandboxConnected: false,
    });

    // Terminal disconnect heartbeat flips connected off and refreshes authoritative state.
    act(() =>
      wsMocks.options?.onMessage({
        type: "sandbox_event",
        event: { type: "heartbeat", sandboxId: "sbx_live_1", status: "disconnected", timestamp: 2 },
      }),
    );
    expect(lastUpdater()?.(makeSession({ sandboxConnected: true }))).toMatchObject({ sandboxConnected: false });
    expect(refresh).toHaveBeenCalledWith("heartbeat_disconnect");

    // A bridge liveness heartbeat (status "ready") self-heals a stale indicator.
    act(() =>
      wsMocks.options?.onMessage({
        type: "sandbox_event",
        event: { type: "heartbeat", sandboxId: "sbx_live_1", status: "ready", timestamp: 3 },
      }),
    );
    expect(lastUpdater()?.(makeSession({ sandboxConnected: false }))).toMatchObject({ sandboxConnected: true });
  });

  it("renders the Stopped badge when a session_status WS frame carries userStopped (end-to-end, no prop injection)", () => {
    // Regression: `userStopped` must thread from the live WS frame through
    // useSessionReplay -> real session state -> the rendered SessionHeader badge.
    // Drives an ACTUAL session_status frame (never sets the prop directly) so a
    // break in the replay threading — the bug this covers — fails the assertion.
    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      const sessionState = useSessionState({
        sessionId: "s-1",
        initialSession: makeSession({ phase: "running", displayStatus: "working", userStopped: false }),
      });
      useSessionReplay({
        applyPromptHistoryFetchResult: sessionState.applyPromptHistoryFetchResult,
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: sessionState.dispatch,
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: sessionState.getActivePromptId,
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: sessionState.ingestReplayPage,
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: sessionState.mergeSessionMetadata,
        session: sessionState.state.session,
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: sessionState.setSessions,
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: sessionState.stateRef,
        transcripts: sessionState.state.transcripts,
        updateSession: sessionState.updateSession,
        wsBootstrappedRef,
      });
      const session = sessionState.state.session;
      if (!session) return null;
      return createElement(
        MemoryRouter,
        { initialEntries: ["/sessions/s-1"] },
        createElement(SessionHeader, {
          session,
          onStop: vi.fn(),
          hydrated: true,
        }),
      );
    }

    render(createElement(Harness));

    // Baseline: the running session renders the "Working" badge, not the stopped one.
    expect(container.querySelector('[aria-label="Session status: Working"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: Stopped"]')).toBeNull();

    // A live user soft-stop arrives as an idle session_status frame carrying userStopped:true.
    act(() =>
      wsMocks.options?.onMessage({
        type: "session_status",
        phase: "idle",
        displayStatus: "stopped",
        userStopped: true,
      }),
    );

    const chip = container.querySelector('[aria-label="Session status: Stopped"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toBe("Stopped — continue anytime");

    // Prompt-admit clears the flag (userStopped:false) -> the badge drops the continue-anytime title.
    act(() =>
      wsMocks.options?.onMessage({
        type: "session_status",
        phase: "idle",
        displayStatus: "stopped",
        userStopped: false,
      }),
    );
    const clearedChip = container.querySelector('[aria-label="Session status: Stopped"]');
    expect(clearedChip?.getAttribute("title")).toBe("Session is not actively working");
  });

  // Shared harness for the HTTP-merge tests below: real useSessionState + useSessionReplay
  // feeding a real SessionHeader, with sessionState captured so a test can drive the REAL
  // mergeSessionMetadata chokepoint that refresh()/bootstrapFromHttp funnel through.
  function renderBadgeHarness(initial: Partial<SessionDetail>) {
    let captured: ReturnType<typeof useSessionState> | undefined;
    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      const sessionState = useSessionState({ sessionId: "s-1", initialSession: makeSession(initial) });
      captured = sessionState;
      useSessionReplay({
        applyPromptHistoryFetchResult: sessionState.applyPromptHistoryFetchResult,
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: sessionState.dispatch,
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: sessionState.getActivePromptId,
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: sessionState.ingestReplayPage,
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: sessionState.mergeSessionMetadata,
        session: sessionState.state.session,
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: sessionState.setSessions,
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: sessionState.stateRef,
        transcripts: sessionState.state.transcripts,
        updateSession: sessionState.updateSession,
        wsBootstrappedRef,
      });
      const session = sessionState.state.session;
      if (!session) return null;
      return createElement(
        MemoryRouter,
        { initialEntries: ["/sessions/s-1"] },
        createElement(SessionHeader, {
          session,
          onStop: vi.fn(),
          hydrated: true,
        }),
      );
    }
    render(createElement(Harness));
    // The captured value is stable across re-renders (same hook instance).
    return () => captured!;
  }

  it("keeps the Stopped badge when an HTTP session-view merge carries userStopped (resilience poll no longer clobbers)", () => {
    const getState = renderBadgeHarness({ phase: "running", displayStatus: "working", userStopped: false });

    // Live soft-stop via WS renders the badge.
    act(() =>
      wsMocks.options?.onMessage({
        type: "session_status",
        phase: "idle",
        displayStatus: "stopped",
        userStopped: true,
      }),
    );
    expect(container.querySelector('[aria-label="Session status: Stopped"]')?.getAttribute("title")).toBe(
      "Stopped — continue anytime",
    );

    // The ~30s resilience poll funnels an HTTP session-view through mergeSessionMetadata. Now that
    // the DO-served view carries userStopped, the wholesale-replace merge keeps the badge.
    act(() =>
      getState().mergeSessionMetadata(makeSession({ phase: "idle", displayStatus: "stopped", userStopped: true }), []),
    );
    expect(container.querySelector('[aria-label="Session status: Stopped"]')?.getAttribute("title")).toBe(
      "Stopped — continue anytime",
    );

    // A later HTTP view with userStopped:false (post prompt-admit) correctly clears it.
    act(() =>
      getState().mergeSessionMetadata(makeSession({ phase: "idle", displayStatus: "stopped", userStopped: false }), []),
    );
    expect(container.querySelector('[aria-label="Session status: Stopped"]')?.getAttribute("title")).toBe(
      "Session is not actively working",
    );
  });

  it("renders the Stopped badge from a cold HTTP bootstrap merge carrying userStopped (reload-flash fix)", () => {
    // Cold reload: bootstrapFromHttp merges the HTTP view BEFORE any WS frame. With userStopped
    // carried on the view, the badge is correct immediately — no flash of the plain idle badge.
    const getState = renderBadgeHarness({ phase: "running", displayStatus: "working", userStopped: false });

    act(() =>
      getState().mergeSessionMetadata(makeSession({ phase: "idle", displayStatus: "stopped", userStopped: true }), []),
    );
    expect(container.querySelector('[aria-label="Session status: Stopped"]')?.getAttribute("title")).toBe(
      "Stopped — continue anytime",
    );
  });

  it("RAF-batches scroll pin updates and cancels pending frames on unmount", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    let replayState: ReturnType<typeof useSessionReplay> | undefined;

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      replayState = useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, get: () => 100 });
    let scrollTop = 0;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const topSentinel = document.createElement("div");

    act(() => {
      replayState?.scrollContainerRef(scrollContainer as HTMLDivElement);
      replayState?.topSentinelRef(topSentinel as HTMLDivElement);
    });

    // Initial pin: scrolled to bottom.
    expect(scrollTop).toBe(1000);

    rafSpy.mockClear();
    cancelSpy.mockClear();

    // Multiple synchronous scroll events should coalesce into a single RAF.
    act(() => {
      scrollTop = 200;
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Unmounting while a frame is pending must cancel it.
    act(() => root.unmount());
    expect(cancelSpy).toHaveBeenCalled();

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("keeps the sidebar child-id refresh key in sync with session prop updates", () => {
    const refreshSessions = vi.fn(async () => undefined);

    function Harness({ session }: { session: SessionDetail }) {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session,
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        refreshSessions,
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session, prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    const withChildren = makeSession({ childSessionIds: ["child-1"] });
    render(createElement(Harness, { session: withChildren }));

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ childSessionIds: ["child-1"] })));
    expect(refreshSessions).not.toHaveBeenCalled();

    render(createElement(Harness, { session: makeSession() }));
    act(() => wsMocks.options?.onMessage(makeSubscribedMessage()));
    expect(refreshSessions).not.toHaveBeenCalled();

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ childSessionIds: ["child-1"] })));
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps subscribed polling on completed and clears it on archived", () => {
    const clearPolling = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling,
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({
          ok: true,
          result: {
            events: [],
            maxSequence: 0,
          },
        })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ phase: "completed" })));
    expect(clearPolling).not.toHaveBeenCalled();

    act(() => wsMocks.options?.onMessage(makeSubscribedMessage({ phase: "archived" })));
    expect(clearPolling).toHaveBeenCalledTimes(1);
  });

  it("hydrates prompt history on subscribe even when replay already contains events", () => {
    const hydratePromptHistories = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({
          ok: true,
          result: {
            events: [],
            maxSequence: 0,
          },
        })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories,
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 0,
          events: [{ sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "partial" } }],
          hasMore: false,
          droppedCount: 0,
          firstSequence: 1,
          lastSequence: 1,
        },
      }),
    );

    expect(hydratePromptHistories).toHaveBeenCalledWith(["p-1"]);
  });

  it("refreshes authoritative state when subscribed replay reports dropped events", () => {
    const refresh = vi.fn(async () => undefined);
    const hydratePromptHistories = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories,
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 10,
          events: [{ sequence: 61, type: "text", data: { promptId: "p-1", id: "t-61", text: "partial" } }],
          hasMore: true,
          droppedCount: 1,
          firstSequence: 61,
          lastSequence: 61,
        },
      }),
    );

    expect(refresh).toHaveBeenCalledWith("replay_truncated");
    expect(hydratePromptHistories).not.toHaveBeenCalled();
  });

  it("refreshes authoritative state when subscribed replay implies a gap even without droppedCount", () => {
    const refresh = vi.fn(async () => undefined);
    const hydratePromptHistories = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories,
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 10,
          events: [{ sequence: 13, type: "text", data: { promptId: "p-1", id: "t-13", text: "partial" } }],
          hasMore: true,
          droppedCount: 0,
          firstSequence: 13,
          lastSequence: 13,
        },
      }),
    );

    expect(refresh).toHaveBeenCalledWith("replay_truncated");
    expect(hydratePromptHistories).not.toHaveBeenCalled();
  });

  it("keeps fresh bootstrap gaps on the normal older-events paging path", () => {
    const refresh = vi.fn(async () => undefined);
    const hydratePromptHistories = vi.fn();

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories,
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 0,
          events: [{ sequence: 13, type: "text", data: { promptId: "p-1", id: "t-13", text: "partial" } }],
          hasMore: true,
          droppedCount: 0,
          firstSequence: 13,
          lastSequence: 13,
        },
      }),
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(hydratePromptHistories).toHaveBeenCalledWith(["p-1"]);
  });

  it("ignores replay_truncated frames already covered by the subscribed bootstrap refresh", async () => {
    const refresh = vi.fn(async () => undefined);

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 10,
          events: [{ sequence: 61, type: "text", data: { promptId: "p-1", id: "t-61", text: "partial" } }],
          hasMore: true,
          droppedCount: 1,
          firstSequence: 61,
          lastSequence: 61,
        },
      }),
    );

    await act(async () => {
      await flushAsyncWork();
    });

    act(() =>
      wsMocks.options?.onMessage({
        type: "replay_truncated",
        requestedAfterSequence: 10,
        firstReturnedSequence: 61,
        lastReturnedSequence: 61,
        droppedCount: 1,
      }),
    );

    await act(async () => {
      await flushAsyncWork();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("replay_truncated");
    expect(vi.mocked(trackAction)).toHaveBeenCalledWith(
      "session_ws_subscribed_bootstrap",
      expect.objectContaining({
        sessionId: "s-1",
        promptCount: 1,
        replayEventCount: 1,
        replayTruncated: true,
      }),
    );
    expect(vi.mocked(trackAction)).not.toHaveBeenCalledWith(
      "session_replay_truncated",
      expect.objectContaining({ sessionId: "s-1" }),
    );
  });

  it("refreshes again for a later reconnect episode with a different truncation window", async () => {
    const refresh = vi.fn(async () => undefined);

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 10,
          events: [{ sequence: 61, type: "text", data: { promptId: "p-1", id: "t-61", text: "partial" } }],
          hasMore: true,
          droppedCount: 1,
          firstSequence: 61,
          lastSequence: 61,
        },
      }),
    );

    await act(async () => {
      await flushAsyncWork();
    });

    act(() =>
      wsMocks.options?.onMessage({
        ...makeSubscribedMessage(),
        replay: {
          afterSequence: 61,
          events: [{ sequence: 112, type: "text", data: { promptId: "p-1", id: "t-112", text: "partial-2" } }],
          hasMore: true,
          droppedCount: 1,
          firstSequence: 112,
          lastSequence: 112,
        },
      }),
    );

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, "replay_truncated");
    expect(refresh).toHaveBeenNthCalledWith(2, "replay_truncated");
  });

  it("tracks replay truncation with an explicit boolean instead of an exact count", async () => {
    const refresh = vi.fn(async () => undefined);

    function Harness() {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh,
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      return null;
    }

    render(createElement(Harness));

    act(() =>
      wsMocks.options?.onMessage({
        type: "replay_truncated",
        requestedAfterSequence: 10,
        firstReturnedSequence: 61,
        lastReturnedSequence: 61,
        droppedCount: 1,
      }),
    );

    await act(async () => {
      await flushAsyncWork();
    });

    expect(refresh).toHaveBeenCalledWith("replay_truncated");
    expect(vi.mocked(trackAction)).toHaveBeenCalledWith("session_replay_truncated", {
      sessionId: "s-1",
      truncated: true,
    });
  });

  it("rebuilds authoritative state on replay_truncated refreshes", async () => {
    const initializeSessionData = vi.fn();
    const mergeSessionMetadata = vi.fn();
    let refresh: ReturnType<typeof useSessionBootstrap>["refresh"] | undefined;

    function Harness() {
      refresh = useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        initialSession: makeSession(),
        initializeSessionData,
        mergeSessionMetadata,
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      }).refresh;
      return null;
    }

    render(createElement(Harness));

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: makeSession({ phase: "idle" }),
      prompts: [makePrompt("p-1", "done"), makePrompt("p-2", "done")],
    });

    await act(async () => {
      await refresh?.("replay_truncated");
      await flushAsyncWork();
    });

    expect(initializeSessionData).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }), [
      expect.objectContaining({ promptId: "p-1" }),
      expect.objectContaining({ promptId: "p-2" }),
    ]);
    expect(mergeSessionMetadata).not.toHaveBeenCalled();
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
  });

  it("does not restart prompt hydration when replay_truncated follows authoritative HTTP bootstrap", async () => {
    const initializeSessionData = vi.fn();
    const mergeSessionMetadata = vi.fn();
    const getCurrentPrompts = vi.fn(() => [makePrompt("p-1", "done")]);
    let refresh: ReturnType<typeof useSessionBootstrap>["refresh"] | undefined;

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: makeSession({ phase: "idle" }),
      prompts: [makePrompt("p-1", "done")],
    });

    function Harness() {
      refresh = useSessionBootstrap({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        getCurrentPrompts,
        initializeSessionData,
        mergeSessionMetadata,
        navigate: vi.fn(),
        sessionId: "s-1",
        setSessions: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
      }).refresh;
      return null;
    }

    render(createElement(Harness));
    await act(async () => {
      await flushAsyncWork();
    });

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: makeSession({ phase: "idle" }),
      prompts: [makePrompt("p-1", "done"), makePrompt("p-2", "done")],
    });

    await act(async () => {
      await refresh?.("replay_truncated");
      await flushAsyncWork();
    });

    expect(initializeSessionData).toHaveBeenCalledTimes(1);
    expect(mergeSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }), [
      expect.objectContaining({ promptId: "p-1" }),
      expect.objectContaining({ promptId: "p-2" }),
    ]);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      1,
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      2,
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
  });

  it("re-attaches the scroll listener when the transcript container is remounted", () => {
    function ScrollHarness({ show }: { show: boolean }) {
      const wsBootstrappedRef = useRef(false);
      const aggressiveFallbackActiveRef = useRef(false);
      const { scrollContainerRef, topSentinelRef } = useSessionReplay({
        applyPromptHistoryFetchResult: vi.fn(() => ({ replacedPartialReplay: false, staleDiscarded: false })),
        aggressiveFallbackActiveRef,
        bootstrapFromHttp: vi.fn(),
        clearBootstrapTimeout: vi.fn(),
        clearPolling: vi.fn(),
        dispatchSessionState: vi.fn(),
        fetchPromptHistoryOnce: vi.fn(async () => ({ ok: true, result: { events: [], maxSequence: 0 } })),
        getCurrentActivePromptId: vi.fn(() => null),
        hydratePromptHistories: vi.fn(),
        ingestReplayPage: vi.fn(),
        models: [],
        refresh: vi.fn(),
        refreshActivePromptHistory: vi.fn(),
        mergeSessionMetadata: vi.fn(),
        session: makeSession(),
        sessionId: "s-1",
        setError: vi.fn(),
        setSessionHydrated: vi.fn(),
        setSessions: vi.fn(),
        startAggressiveFallbackPolling: vi.fn(),
        startResiliencePolling: vi.fn(),
        stateRef: { current: { session: makeSession(), prompts: [], transcripts: new Map() } as never },
        transcripts: new Map(),
        updateSession: vi.fn(),
        wsBootstrappedRef,
      });
      // Mirror SessionDetail: the `if (error) return ...` screen replaces the whole transcript
      // subtree, so the nested scroll container is unmounted and remounted as a fresh DOM node
      // on recovery. The listener must follow the new node.
      if (!show) return createElement("div", { "data-testid": "error" }, "error");
      return createElement(
        "div",
        { "data-testid": "wrapper" },
        createElement(
          "div",
          { ref: scrollContainerRef, "data-testid": "scroll-container" },
          createElement("div", { ref: topSentinelRef, "data-testid": "sentinel" }),
        ),
      );
    }

    const realAdd = happyWindow.HTMLElement.prototype.addEventListener;
    const realRemove = happyWindow.HTMLElement.prototype.removeEventListener;
    const scrollAdds: EventTarget[] = [];
    const scrollRemoves: EventTarget[] = [];
    happyWindow.HTMLElement.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "scroll") scrollAdds.push(this);
      return (realAdd as (t: string, ...r: unknown[]) => void).call(this, type, ...rest);
    } as typeof realAdd;
    happyWindow.HTMLElement.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "scroll") scrollRemoves.push(this);
      return (realRemove as (t: string, ...r: unknown[]) => void).call(this, type, ...rest);
    } as typeof realRemove;

    try {
      render(createElement(ScrollHarness, { show: true }));
      const nodeA = container.querySelector('[data-testid="scroll-container"]');
      expect(nodeA).toBeTruthy();
      expect(scrollAdds).toContain(nodeA);

      // Error screen unmounts the container; the listener's cleanup must run.
      render(createElement(ScrollHarness, { show: false }));
      expect(scrollRemoves).toContain(nodeA);

      // Recovery remounts a fresh node; the listener must re-attach to it (the regression).
      render(createElement(ScrollHarness, { show: true }));
      const nodeB = container.querySelector('[data-testid="scroll-container"]');
      expect(nodeB).toBeTruthy();
      expect(nodeB).not.toBe(nodeA);
      expect(scrollAdds).toContain(nodeB);
    } finally {
      happyWindow.HTMLElement.prototype.addEventListener = realAdd;
      happyWindow.HTMLElement.prototype.removeEventListener = realRemove;
    }
  });
});
