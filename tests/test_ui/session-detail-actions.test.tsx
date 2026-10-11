import { Window } from "happy-dom";
import type React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { SessionDetailView, shouldShowTranscriptHydrationPending } from "../../apps/ui/src/components/SessionDetail";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import { FALLBACK_POLL_INITIAL_MS, RESILIENCE_POLL_MS, WS_BOOTSTRAP_TIMEOUT_MS } from "../../apps/ui/src/constants";

const apiMocks = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
  createChildSession: vi.fn(async () => ({
    ok: true,
    childSessionId: "s-verify",
    childSessionUrl: "/sessions/s-verify",
    parentSessionId: "s-1",
    parentPromptId: "fallback:s-1",
    spawnDepth: 1,
  })),
  createSessionAndSend: vi.fn(async () => ({ sessionId: "s-verify", promptId: "p-verify" })),
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
  fetchSessionDesktopActionPath: vi.fn(async () => ({ ok: true, rows: [], maxDesktopActionSeq: 0 })),
  fetchSessionHistoryProbe: vi.fn(async () => ({
    ok: true,
    complete: false,
    rawEventCount: 1000,
    lastSequence: 1000,
  })),
  fetchRepos: vi.fn(async () => ({ repos: [], ssoOrgs: [] })),
  fetchSessionView: vi.fn(async () => ({ session: { sessionId: "s-1", phase: "idle" }, prompts: [] })),
  fetchSessionFiles: vi.fn(async () => []),
  fetchSettings: vi.fn(async () => ({})),
  fetchUser: vi.fn(async () => ({ status: "unauthenticated" as const })),
  respondToQuestion: vi.fn(async () => undefined),
  resumeSession: vi.fn(async () => undefined),
  sendPrompt: vi.fn(async () => "prompt-1"),
  setSessionRepo: vi.fn(async () => undefined),
  stopSession: vi.fn(async () => undefined),
  submitMemoryFeedback: vi.fn(async () => {
    throw new Error("submitMemoryFeedback mock should not be called");
  }),
  updateSettings: vi.fn(async () => undefined),
  warmSandbox: vi.fn(),
}));

const layoutMocks = vi.hoisted(() => ({
  capabilities: { computerUse: true },
  setSessions: vi.fn(),
  patchSession: vi.fn(),
  notifySessionListSync: vi.fn(),
  models: [],
  selectedModel: null,
  user: null,
  repos: [],
  reposLoaded: true,
  reposError: null,
  ssoOrgs: [],
  refreshingRepos: false,
  refreshRepos: vi.fn(async () => undefined),
  refreshSessions: vi.fn(async () => undefined),
  settings: {
    theme: "system",
    prReviewAutoResponseEnabled: true,
    defaultPrDraft: false,
    autoVerifyEnabled: true,
    automaticReviewsEnabled: false,
    useCodexSubscription: false,
    defaultModel: null,
    defaultRepo: null,
    apiKeys: {},
  },
  setSettings: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const sessionStateMocks = vi.hoisted(() => ({
  session: {
    sessionId: "s-1",
    phase: "stopped",
    title: "Resume me",
    repoUrl: "https://github.com/test-owner/test-repo",
    prUrl: null,
    closeReason: null,
    queueLength: 0,
    createdAt: "2026-04-02T12:00:00.000Z",
    updatedAt: "2026-04-02T12:00:00.000Z",
    closedAt: null,
    lastEventId: null,
    ownerUserId: "u-1",
    model: null,
    desktopActionPathAvailable: false,
    reasoningEffort: null,
    spawnDurationMs: null,
    lastBranch: null,
    baseBranch: "main",
    prCreating: false,
  },
  prompts: [],
  transcripts: new Map(),
  incompletePromptIds: new Set<string>(),
  tokenUsage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalBilledTokens: 0,
    context: 0,
    peakContext: 0,
    cost: 0,
    contextCacheRead: 0,
    contextCacheWrite: 0,
    contextUncachedInput: 0,
    cumulativeCacheRead: 0,
    cumulativeCacheWrite: 0,
    instructionFilesEst: 0,
    model: null,
    contextWindow: null,
  },
  prError: null,
  prUpdated: false,
  dispatch: vi.fn(),
  initializeSessionData: vi.fn(),
  mergeSessionMetadata: vi.fn(),
  ingestReplayPage: vi.fn(),
  hydrateAllPromptHistories: vi.fn(() => []),
  applyPromptHistoryFetchResult: vi.fn((promptId: string, result: unknown) => {
    sessionStateMocks.dispatch({ type: "event/prompt_history", promptId, result });
    return { replacedPartialReplay: false, staleDiscarded: false };
  }),
  updateSession: vi.fn(),
  setPrUpdated: vi.fn(),
  answerLatestQuestion: vi.fn(),
  getActivePromptId: vi.fn(() => null),
  getInFlightPromptId: vi.fn(
    (promptList = []) => promptList.find((prompt: { result: unknown }) => prompt.result === null)?.promptId ?? null,
  ),
  stateRef: { current: { session: null, prompts: [], transcripts: new Map() } },
  liveModeRef: { current: true },
}));

const transcriptMock = vi.hoisted(() => vi.fn(() => null));

const effectMocks = vi.hoisted(() => ({
  runMountEffects: false,
}));

const websocketMocks = vi.hoisted(() => ({
  onMount: undefined as
    | undefined
    | ((options: {
        onMessage: (msg: unknown) => void;
        onWsBlocked?: () => void;
        onConnected?: () => void;
        onDisconnected?: () => void;
        enabled?: boolean;
      }) => void),
  requestReplayPage: vi.fn(() => true),
}));

vi.mock("../../apps/ui/src/api/client.ts", () => ({
  ApiError: apiMocks.ApiError,
  requestJson: vi.fn(async () => ({ artifacts: [] })),
}));

vi.mock("../../apps/ui/src/api/sessions.ts", () => ({
  buildPromptEventsResult: (
    rawEvents: Array<{ sequence?: number; type?: string; data?: Record<string, unknown> }>,
  ) => ({
    events: rawEvents.map((event, index) =>
      event.type === "question"
        ? {
            type: "question",
            id: event.data?.id ?? `question-${index}`,
            question: event.data?.question ?? "",
            answer: event.data?.answer ?? null,
          }
        : {
            type: "text",
            id: event.data?.id ?? `text-${index}`,
            text: event.data?.text ?? "",
          },
    ),
    maxSequence: rawEvents.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0),
  }),
  createChildSession: apiMocks.createChildSession,
  createSessionAndSend: apiMocks.createSessionAndSend,
  fetchPromptEvents: apiMocks.fetchPromptEvents,
  fetchPromptEventsPage: apiMocks.fetchPromptEventsPage,
  fetchSessionDesktopActionPath: apiMocks.fetchSessionDesktopActionPath,
  fetchSessionHistoryProbe: apiMocks.fetchSessionHistoryProbe,
  fetchSessionView: apiMocks.fetchSessionView,
  fetchSessionFiles: apiMocks.fetchSessionFiles,
  respondToQuestion: apiMocks.respondToQuestion,
  resumeSession: apiMocks.resumeSession,
  sendPrompt: apiMocks.sendPrompt,
  setSessionRepo: apiMocks.setSessionRepo,
  stopSession: apiMocks.stopSession,
  submitMemoryFeedback: apiMocks.submitMemoryFeedback,
  warmSandbox: apiMocks.warmSandbox,
}));

vi.mock("../../apps/ui/src/api/repos.ts", () => ({
  fetchRepos: apiMocks.fetchRepos,
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchSettings: apiMocks.fetchSettings,
  updateSettings: apiMocks.updateSettings,
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => routerMocks.navigate,
  };
});

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const React = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      if (effectMocks.runMountEffects) {
        React.useEffect(effect, []);
      }
    },
    useOnChange: (deps: readonly unknown[], effect: () => void | (() => void)) => {
      const mounted = React.useRef(false);
      React.useEffect(() => {
        if (!mounted.current) {
          mounted.current = true;
          return;
        }
        return effect();
      }, deps);
    },
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

vi.mock("../../apps/ui/src/hooks/useMobile.ts", () => ({
  useMobile: () => false,
}));

function okPromptHistory(result: { events: unknown[]; maxSequence?: number }) {
  return { ok: true, result: { maxSequence: result.maxSequence ?? 0, events: result.events } };
}

function okPromptHistoryPage(result: {
  rawEvents?: Array<{ sequence?: number; type: string; data?: Record<string, unknown> }>;
  maxSequence?: number;
  complete?: boolean;
  nextAfterSequence?: number | null;
}) {
  const rawEvents = result.rawEvents ?? [];
  return {
    ok: true,
    result: {
      events: [],
      maxSequence: result.maxSequence ?? 0,
      complete: result.complete ?? true,
      nextAfterSequence: result.nextAfterSequence ?? null,
      rawEventCount: rawEvents.length,
    },
    rawEvents,
  };
}

vi.mock("../../apps/ui/src/hooks/useSessionState.ts", () => ({
  getInFlightPromptId: sessionStateMocks.getInFlightPromptId,
  useSessionState: () => ({
    state: {
      session: sessionStateMocks.session,
      prompts: sessionStateMocks.prompts,
      transcripts: sessionStateMocks.transcripts,
      incompletePromptIds: sessionStateMocks.incompletePromptIds,
      tokenUsage: sessionStateMocks.tokenUsage,
      prError: sessionStateMocks.prError,
      prUpdated: sessionStateMocks.prUpdated,
    },
    dispatch: sessionStateMocks.dispatch,
    stateRef: sessionStateMocks.stateRef,
    liveModeRef: sessionStateMocks.liveModeRef,
    initializeSessionData: sessionStateMocks.initializeSessionData,
    mergeSessionMetadata: sessionStateMocks.mergeSessionMetadata,
    ingestReplayPage: sessionStateMocks.ingestReplayPage,
    applyPromptHistoryFetchResult: sessionStateMocks.applyPromptHistoryFetchResult,
    updateSession: sessionStateMocks.updateSession,
    setPrUpdated: sessionStateMocks.setPrUpdated,
    answerLatestQuestion: sessionStateMocks.answerLatestQuestion,
    getActivePromptId: sessionStateMocks.getActivePromptId,
    getInFlightPromptId: sessionStateMocks.getInFlightPromptId,
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionWebSocket.ts", () => ({
  isLivenessMessage: (msg: { type?: string; beforeSequence?: number | null }) => {
    switch (msg.type) {
      case "subscribed":
      case "session_event":
      case "replay_event":
      case "replay_truncated":
      case "sandbox_ready":
      case "sandbox_error":
      case "prompt_updated":
      case "session_status":
      case "pr_created":
      case "pr_updated":
      case "pr_failed":
        return true;
      case "replay_page":
        return msg.beforeSequence == null;
      case "replay_error":
      case "sandbox_event":
      case "pong":
        return false;
      default:
        return false;
    }
  },
  useSessionWebSocket: (options: {
    onMessage: (msg: unknown) => void;
    onWsBlocked?: () => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
    enabled?: boolean;
  }) => {
    websocketMocks.onMount?.(options);
    return { requestReplayPage: websocketMocks.requestReplayPage };
  },
}));

vi.mock("../../apps/ui/src/components/MarkdownContent.tsx", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("div", null, content),
  InlineMarkdownContent: ({ content }: { content: string }) => createElement("span", null, content),
}));

vi.mock("../../apps/ui/src/components/PromptForm.tsx", () => ({
  PromptForm: ({
    leadingActions,
    placeholder,
    disabled,
    onSubmit,
  }: {
    leadingActions?: React.ReactNode;
    placeholder?: string;
    disabled?: boolean;
    onSubmit?: (payload: { prompt: string }) => void | Promise<void>;
  }) =>
    createElement(
      "div",
      { "data-testid": "prompt-form" },
      leadingActions ?? null,
      createElement("textarea", { "aria-label": "Prompt", placeholder, disabled }),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => void onSubmit?.({ prompt: "resume from prompt" }),
        },
        "Submit prompt",
      ),
      createElement("button", { type: "button", "aria-label": "Upload files as context" }),
    ),
}));

vi.mock("../../apps/ui/src/components/Transcript.tsx", () => ({
  Transcript: transcriptMock,
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

let happyWindow: Window;
const intersectionObserverInstances: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  rootMargin: string;
  thresholds: ReadonlyArray<number>;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "";
    this.thresholds = Array.isArray(options?.threshold) ? options.threshold : [options?.threshold ?? 0];
    intersectionObserverInstances.push(this);
  }

  trigger(entries: Array<Partial<IntersectionObserverEntry>>) {
    const normalized = entries.map((entry) => ({
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: entry.isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      isIntersecting: false,
      rootBounds: null,
      target: document.createElement("div"),
      time: 0,
      ...entry,
    }));
    this.callback(normalized as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    IntersectionObserver: FakeIntersectionObserver,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    requestIdleCallback: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelIdleCallback: vi.fn(),
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

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderSessionDetail(
  initialSession = sessionStateMocks.session,
  options?: { omitInitialSession?: boolean; sessionId?: string; artifact?: "pr" },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (
    nextSession = initialSession,
    nextOptions: { omitInitialSession?: boolean; sessionId?: string; artifact?: "pr" } | undefined = options,
  ) => {
    const sessionId = nextOptions?.sessionId ?? "s-1";
    root.render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [`/sessions/${sessionId}${nextOptions?.artifact ? `?artifact=${nextOptions.artifact}` : ""}`],
        },
        createElement(
          ToastProvider,
          null,
          createElement(
            ConfirmProvider,
            null,
            createElement(
              SessionDetailView,
              nextOptions?.omitInitialSession ? { sessionId } : { sessionId, initialSession: nextSession },
            ),
          ),
        ),
      ),
    );
    await flushAsyncWork();
  };
  await act(async () => {
    await render(initialSession);
  });

  return {
    container,
    async rerender(
      nextSession = sessionStateMocks.session,
      nextOptions: { omitInitialSession?: boolean; sessionId?: string; artifact?: "pr" } | undefined = options,
    ) {
      await act(async () => {
        await render(nextSession, nextOptions);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

function findButtonsByText(container: ParentNode, text: string) {
  return [...container.querySelectorAll("button")].filter((button) => button.textContent === text);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeSubscribedMessage(overrides?: {
  replay?: Partial<{
    afterSequence: number;
    events: unknown[];
    hasMore: boolean;
    droppedCount: number;
    firstSequence: number | null;
    lastSequence: number | null;
  }>;
}) {
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
      title: "Replay test",
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
    queue: { queuedCount: 0, processingPromptId: null },
    prompts: [],
    lastDurableSequence: 0,
    replay: {
      afterSequence: 0,
      events: [],
      hasMore: false,
      droppedCount: 0,
      firstSequence: null,
      lastSequence: null,
      ...overrides?.replay,
    },
  };
}

describe("SessionDetailView session actions", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/sessions/s-1";
    installDomGlobals(happyWindow);
    effectMocks.runMountEffects = false;
    websocketMocks.onMount = undefined;
    websocketMocks.requestReplayPage.mockReset();
    websocketMocks.requestReplayPage.mockReturnValue(true);
    intersectionObserverInstances.length = 0;
    sessionStateMocks.session.sessionId = "s-1";
    sessionStateMocks.session.status = "stopped";
    sessionStateMocks.session.phase = "stopped";
    sessionStateMocks.session.repoUrl = "https://github.com/test-owner/test-repo";
    sessionStateMocks.session.baseBranch = "main";
    sessionStateMocks.session.model = null;
    sessionStateMocks.session.desktopActionPathAvailable = false;
    sessionStateMocks.session.closeReason = null;
    sessionStateMocks.session.prUrl = null;
    sessionStateMocks.session.spawnDurationMs = null;
    sessionStateMocks.session.reviewLoopDoneState = null;
    sessionStateMocks.session.verification = null;
    sessionStateMocks.session.prDraft = false;
    sessionStateMocks.session.prManualReviewReason = null;
    sessionStateMocks.session.qaRun = null;
    delete sessionStateMocks.session.childSessionIds;
    delete sessionStateMocks.session.qaChildSessionId;
    sessionStateMocks.prompts = [];
    sessionStateMocks.transcripts = new Map();
    sessionStateMocks.tokenUsage.input = 0;
    sessionStateMocks.tokenUsage.output = 0;
    sessionStateMocks.tokenUsage.cacheRead = 0;
    sessionStateMocks.tokenUsage.cacheWrite = 0;
    sessionStateMocks.tokenUsage.totalTokens = 0;
    sessionStateMocks.tokenUsage.totalBilledTokens = 0;
    sessionStateMocks.tokenUsage.context = 0;
    sessionStateMocks.tokenUsage.peakContext = 0;
    sessionStateMocks.tokenUsage.cost = 0;
    sessionStateMocks.tokenUsage.contextCacheRead = 0;
    sessionStateMocks.tokenUsage.contextCacheWrite = 0;
    sessionStateMocks.tokenUsage.contextUncachedInput = 0;
    sessionStateMocks.tokenUsage.cumulativeCacheRead = 0;
    sessionStateMocks.tokenUsage.cumulativeCacheWrite = 0;
    sessionStateMocks.tokenUsage.instructionFilesEst = 0;
    sessionStateMocks.tokenUsage.model = null;
    sessionStateMocks.tokenUsage.contextWindow = null;
    sessionStateMocks.prError = null;
    sessionStateMocks.prUpdated = false;
    sessionStateMocks.initializeSessionData.mockReset();
    sessionStateMocks.mergeSessionMetadata.mockReset();
    sessionStateMocks.ingestReplayPage.mockReset();
    sessionStateMocks.getInFlightPromptId.mockReset();
    sessionStateMocks.getInFlightPromptId.mockImplementation(
      (promptList = []) => promptList.find((prompt: { result: unknown }) => prompt.result === null)?.promptId ?? null,
    );
    sessionStateMocks.incompletePromptIds = new Set();
    sessionStateMocks.applyPromptHistoryFetchResult.mockReset();
    sessionStateMocks.applyPromptHistoryFetchResult.mockImplementation((promptId: string, result: unknown) => {
      sessionStateMocks.dispatch({ type: "event/prompt_history", promptId, result });
      return { replacedPartialReplay: false, staleDiscarded: false };
    });
    sessionStateMocks.stateRef.current = { session: sessionStateMocks.session, prompts: [], transcripts: new Map() };
    vi.clearAllMocks();
    layoutMocks.setSessions.mockReset();
    layoutMocks.capabilities.computerUse = true;
    layoutMocks.patchSession.mockReset();
    layoutMocks.notifySessionListSync.mockReset();
    layoutMocks.user = null;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.reposError = null;
    layoutMocks.ssoOrgs = [];
    layoutMocks.refreshingRepos = false;
    layoutMocks.refreshRepos.mockReset();
    layoutMocks.refreshSessions.mockReset();
    layoutMocks.settings = {
      theme: "system",
      prReviewAutoResponseEnabled: true,
      defaultPrDraft: false,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: false,
      useCodexSubscription: false,
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {},
    };
    layoutMocks.setSettings.mockReset();
    routerMocks.navigate.mockReset();
    transcriptMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    intersectionObserverInstances.length = 0;
    happyWindow.close();
  });

  it("keeps empty terminal prompts loading while replay truncation is being rehydrated", () => {
    const prompt = {
      promptId: "p-1",
      status: "completed",
      result: "done",
    };

    expect(shouldShowTranscriptHydrationPending("skipped_due_to_truncation", prompt, 0)).toBe(true);
    expect(shouldShowTranscriptHydrationPending("skipped_due_to_truncation", prompt, 1)).toBe(false);
    expect(shouldShowTranscriptHydrationPending(null, prompt, 0)).toBe(false);
  });

  it("always renders the fixed scroll-to-bottom control at a symmetric bottom-right offset", async () => {
    const view = await renderSessionDetail();

    const button = document.body.querySelector<HTMLButtonElement>('button[aria-label="Scroll to bottom"]');

    expect(button).not.toBeNull();
    // The kit IconButton stays a plain ghost square; the fixed wrapper owns
    // positioning and the tonal (border + surface) elevation.
    const wrapper = button?.parentElement;
    expect(button?.className).toContain("hit-area-40");
    expect(button?.className).not.toContain("rounded-full");
    expect(wrapper?.className).toContain("fixed");
    expect(wrapper?.className).toContain("bottom-6");
    expect(wrapper?.className).toContain("right-6");
    expect(wrapper?.className).toContain("border-border");
    expect(wrapper?.parentElement).toBe(document.body);

    await view.unmount();
  });

  it("renders and fetches the desktop workbench regardless of the legacy capability flag", async () => {
    const view = await renderSessionDetail();

    expect(view.container.textContent).toContain("Action path");
    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));

    await view.unmount();
  });

  it("hides the desktop workbench when computer use is not enabled for the business", async () => {
    layoutMocks.capabilities.computerUse = false;

    const view = await renderSessionDetail();

    expect(view.container.textContent).not.toContain("Action path");
    expect(apiMocks.fetchSessionDesktopActionPath).not.toHaveBeenCalled();

    await view.unmount();
  });

  it("renders and fetches the desktop workbench when action path is available", async () => {
    sessionStateMocks.session.desktopActionPathAvailable = true;

    const view = await renderSessionDetail();

    expect(view.container.textContent).toContain("Action path");
    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
    const scroller = view.container.querySelector("[data-session-scroll-container]");
    const promptForm = view.container.querySelector("[data-testid='prompt-form']");
    const desktopPane = view.container.querySelector("aside[aria-label='Desktop view collapsed']");
    const mainColumn = scroller?.parentElement;
    expect(mainColumn?.contains(promptForm)).toBe(true);
    expect(mainColumn?.parentElement).toBe(desktopPane?.parentElement);
    expect(mainColumn?.contains(desktopPane)).toBe(false);

    await view.unmount();
  });

  it("does not point desktop pane controls at an absent pane", async () => {
    sessionStateMocks.session.desktopActionPathAvailable = true;

    const view = await renderSessionDetail();

    expect(view.container.querySelector("#session-desktop-pane")).toBeNull();
    expect(view.container.querySelectorAll('[aria-controls="session-desktop-pane"]')).toHaveLength(0);

    const openButton = findButtonsByText(view.container, "Desktop view")[0];
    expect(openButton).toBeDefined();

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(view.container.querySelector("#session-desktop-pane")).not.toBeNull();

    const closeButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="Close desktop view"]');
    expect(closeButton).not.toBeNull();

    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(view.container.querySelector("#session-desktop-pane")).toBeNull();
    expect(view.container.querySelectorAll('[aria-controls="session-desktop-pane"]')).toHaveLength(0);

    await view.unmount();
  });

  it("loads remaining prompt pages before the fixed scroll-to-bottom control scrolls", async () => {
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const firstPrompt = {
      promptId: "p-1",
      session_id: "s-1",
      prompt: "first",
      result: "done",
      status: "completed",
    };
    const secondPrompt = {
      promptId: "p-2",
      session_id: "s-1",
      prompt: "second",
      result: "done",
      status: "completed",
    };
    const thirdPrompt = {
      promptId: "p-3",
      session_id: "s-1",
      prompt: "third",
      result: "done",
      status: "completed",
    };
    sessionStateMocks.prompts = [firstPrompt];
    sessionStateMocks.stateRef.current = {
      session: sessionStateMocks.session,
      prompts: [firstPrompt],
      transcripts: new Map(),
    };
    apiMocks.fetchSessionView
      .mockResolvedValueOnce({
        session: sessionStateMocks.session,
        prompts: [firstPrompt],
        promptPage: { nextCursor: "cursor-2", total: 3 },
      })
      .mockResolvedValueOnce({
        session: sessionStateMocks.session,
        prompts: [secondPrompt],
        promptPage: { nextCursor: "cursor-3", total: 3 },
      })
      .mockResolvedValueOnce({
        session: sessionStateMocks.session,
        prompts: [thirdPrompt],
        promptPage: { nextCursor: null, total: 3 },
      });

    const view = await renderSessionDetail();
    await act(async () => {
      await flushAsyncWork();
    });

    const scroller = view.container.querySelector<HTMLElement>("[data-session-scroll-container]");
    if (!scroller) throw new Error("expected session scroll container");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 400 });
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    const button = document.body.querySelector<HTMLButtonElement>('button[aria-label="Scroll to bottom"]');
    if (!button) throw new Error("expected scroll-to-bottom button");

    await act(async () => {
      button.click();
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenNthCalledWith(2, "s-1", "cursor-2");
    expect(apiMocks.fetchSessionView).toHaveBeenNthCalledWith(3, "s-1", "cursor-3");
    expect(scrollTop).toBe(2400);

    await view.unmount();
    rafSpy.mockRestore();
  });

  it("marks only the canonical in-flight prompt for progress indicator rendering", async () => {
    sessionStateMocks.session = {
      ...sessionStateMocks.session,
      phase: "running",
      repoUrl: "https://github.com/test-owner/test-repo",
    };
    sessionStateMocks.prompts = [
      {
        promptId: "p-old",
        session_id: "s-1",
        prompt: "older unresolved",
        result: null,
        status: "processing",
      },
      {
        promptId: "p-new",
        session_id: "s-1",
        prompt: "newer unresolved",
        result: null,
        status: "processing",
      },
    ];

    const view = await renderSessionDetail(sessionStateMocks.session);

    const callsByPromptId = new Map(
      transcriptMock.mock.calls.map(([props]) => [props.prompt.promptId, props.showProgressIndicator]),
    );
    expect(callsByPromptId.get("p-old")).toBe(true);
    expect(callsByPromptId.get("p-new")).toBe(false);
    expect(sessionStateMocks.getInFlightPromptId).toHaveBeenCalledWith([
      expect.objectContaining({ promptId: "p-old" }),
      expect.objectContaining({ promptId: "p-new" }),
    ]);

    await view.unmount();
  });

  it("does not render a Resume button on stopped sessions (the textarea is the resume affordance)", async () => {
    sessionStateMocks.session.status = "stopped";

    const view = await renderSessionDetail();

    expect(findButtonsByText(view.container, "Resume session")).toHaveLength(0);
    expect(findButtonsByText(view.container, "Resume")).toHaveLength(0);

    await view.unmount();
  });

  it("keeps the desktop pane collapsed until the desktop control opens it", async () => {
    sessionStateMocks.session.desktopActionPathAvailable = true;
    const view = await renderSessionDetail();

    expect(view.container.querySelector("#session-desktop-pane")).toBeNull();
    expect(view.container.querySelector("aside[aria-label='Desktop view collapsed']")).not.toBeNull();

    const desktopButton = view.container.querySelector<HTMLButtonElement>(
      "aside[aria-label='Desktop view collapsed'] button[aria-expanded='false']",
    );
    expect(desktopButton).not.toBeNull();

    await act(async () => {
      desktopButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const desktopPane = view.container.querySelector("#session-desktop-pane");
    expect(desktopPane).not.toBeNull();
    expect(desktopPane?.textContent).toContain("Live desktop is idle.");
    expect(desktopPane?.textContent).toContain("Open desktop");

    sessionStateMocks.session = { ...sessionStateMocks.session, sessionId: "s-2" };
    await view.rerender(sessionStateMocks.session, { sessionId: "s-2" });

    expect(view.container.querySelector("#session-desktop-pane")).toBeNull();
    expect(
      view.container.querySelector("aside[aria-label='Desktop view collapsed'] button[aria-expanded='false']"),
    ).not.toBeNull();

    await view.unmount();
  });

  it("does not broadcast a cross-tab sync when switching to a different session id", async () => {
    sessionStateMocks.session = {
      ...sessionStateMocks.session,
      sessionId: "s-1",
      phase: "idle",
      prUrl: null,
      reviewLoopDoneState: null,
    };
    const view = await renderSessionDetail(sessionStateMocks.session, { sessionId: "s-1" });

    expect(layoutMocks.notifySessionListSync).not.toHaveBeenCalled();

    sessionStateMocks.session = {
      ...sessionStateMocks.session,
      sessionId: "s-2",
      phase: "running",
      prUrl: "https://github.com/trycycloid/cycloid/pull/2",
    };
    await view.rerender(sessionStateMocks.session, { sessionId: "s-2" });

    expect(layoutMocks.notifySessionListSync).not.toHaveBeenCalled();

    sessionStateMocks.session = {
      ...sessionStateMocks.session,
      phase: "completed",
    };
    await view.rerender(sessionStateMocks.session, { sessionId: "s-2" });

    expect(layoutMocks.notifySessionListSync).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("hides prompt and mutation controls in read-only support view", async () => {
    let wsOptions:
      | {
          enabled?: boolean;
        }
      | undefined;
    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };
    layoutMocks.user = {
      id: 42,
      login: "customer",
      name: "Customer User",
      email: "customer@example.com",
      avatarUrl: null,
      businessId: "biz-customer",
      businessRole: "member",
      sharedSessions: false,
      linearConnected: false,
      notionConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
      impersonation: {
        impersonationId: "imp-1",
        actor: { id: 7, login: "operator" },
        readOnly: true,
      },
    };
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.phase = "idle";
    sessionStateMocks.session.lastBranch = "feature/support";
    sessionStateMocks.session.baseBranch = "main";

    const view = await renderSessionDetail();

    expect(wsOptions?.enabled).toBe(true);
    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(view.container.querySelector("[data-testid='prompt-form']")).toBeNull();
    expect(findButtonsByText(view.container, "Submit prompt")).toHaveLength(0);
    expect(view.container.textContent).toContain("Read-only support view");

    await view.unmount();
  });

  it("renders the repo URL inside the header above the divider", async () => {
    const view = await renderSessionDetail();
    const header = view.container.querySelector("div.mb-8.pb-4.border-b.border-border");

    // Parsed GitHub URLs now render a shortened owner/repo label that links to
    // the full URL via href.
    const repoLink = header?.querySelector<HTMLAnchorElement>("a[href='https://github.com/test-owner/test-repo']");
    expect(repoLink).not.toBeNull();
    expect(repoLink?.textContent).toContain("test-owner/test-repo");
    expect(header?.textContent).not.toContain("https://github.com/test-owner/test-repo");

    await view.unmount();
  });

  it("keeps activity usage metrics hidden when a PR exists", async () => {
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";
    sessionStateMocks.session.spawnDurationMs = 8500;
    sessionStateMocks.transcripts = new Map([
      [
        "p-1",
        [
          {
            id: "tool-1",
            type: "tool_call",
            tool: "bash",
          },
        ],
      ],
    ]);
    sessionStateMocks.tokenUsage.input = 145_962;
    sessionStateMocks.tokenUsage.output = 1_600;
    sessionStateMocks.tokenUsage.cacheRead = 124_300;
    sessionStateMocks.tokenUsage.totalBilledTokens = 270_262;
    sessionStateMocks.tokenUsage.context = 270_262;
    sessionStateMocks.tokenUsage.contextWindow = 1_000_000;
    sessionStateMocks.tokenUsage.cost = 0.84;

    const view = await renderSessionDetail();

    expect(view.container.textContent).not.toContain("PR is open");
    expect(view.container.textContent).not.toContain("tool call");
    expect(view.container.textContent).not.toContain("270.3k in");
    expect(view.container.textContent).not.toContain("$0.84");
    expect(view.container.textContent).not.toContain("ctx 27%");

    await view.unmount();
  });

  it("does not show the removed PR status banner while work is running", async () => {
    sessionStateMocks.session.status = "running";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";
    sessionStateMocks.prUpdated = true;

    const view = await renderSessionDetail();
    expect(view.container.textContent).not.toContain("PR is open");
    expect(view.container.textContent).not.toContain("ready");
    expect(view.container.textContent).not.toContain("polishing");
    expect(view.container.textContent).not.toContain("fallback");

    await view.unmount();
  });

  it("renders draft PRs with manual-review CTA and reason copy", async () => {
    sessionStateMocks.session.phase = "idle";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";
    sessionStateMocks.session.prDraft = true;
    sessionStateMocks.session.verification = {
      verified: true,
      status: "manual_review_required",
      publishMode: "draft",
      manualReviewReason:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
      explanation:
        "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
    };

    const view = await renderSessionDetail(sessionStateMocks.session, { artifact: "pr" });
    const threadPrRow = view.container.querySelector("[data-session-pr-row]");
    expect(threadPrRow?.textContent).toContain("Draft");
    expect(threadPrRow?.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain(
      "Broad typecheck could not complete because the command was killed by resource limits",
    );
    expect(view.container.textContent).toContain("View draft");
    expect(view.container.textContent).not.toContain("Draft PR is open");

    await view.unmount();
  });

  it("renders manual-review metadata for ready PRs without showing draft copy", async () => {
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";
    sessionStateMocks.session.prDraft = false;
    sessionStateMocks.session.prManualReviewReason =
      "Verification was inconclusive; review the scoped evidence before merge.";

    const view = await renderSessionDetail(sessionStateMocks.session, { artifact: "pr" });
    expect(view.container.textContent).toContain("Verification was inconclusive");
    expect(view.container.textContent).toContain("Open PR");
    expect(view.container.textContent).not.toContain("View draft");

    await view.unmount();
  });

  it("shows the sticky outcome bar after the full header leaves view and wires its PR link", async () => {
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.title = "Sticky outcome session";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";
    sessionStateMocks.prUpdated = true;

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });
    const stickyBar = view.container.querySelector('[data-session-sticky-bar="true"]');
    expect(stickyBar?.getAttribute("aria-hidden")).toBe("true");

    const headerObserver = intersectionObserverInstances.find(
      (observer) =>
        (observer.root as HTMLElement | null)?.hasAttribute("data-session-scroll-container") &&
        observer.rootMargin === "",
    );
    if (!headerObserver) throw new Error("expected header visibility observer");
    const headerTarget = headerObserver.observe.mock.calls[0]?.[0] as Element;

    await act(async () => {
      headerObserver.trigger([{ target: headerTarget, isIntersecting: false }]);
      await flushAsyncWork();
    });

    expect(stickyBar?.getAttribute("aria-hidden")).toBe("false");
    const stickyPrLink = stickyBar?.querySelector("a");
    expect(stickyPrLink?.getAttribute("href")).toBe("https://github.com/trycycloid/cycloid/pull/1346");

    await act(async () => {
      stickyPrLink?.addEventListener("click", (event) => event.preventDefault());
      stickyPrLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(sessionStateMocks.setPrUpdated).toHaveBeenCalledWith(false);

    await view.unmount();
  });

  it("keeps the sticky outcome bar hidden when IntersectionObserver is unavailable", async () => {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.prUrl = "https://github.com/trycycloid/cycloid/pull/1346";

    const view = await renderSessionDetail();
    const stickyBar = view.container.querySelector('[data-session-sticky-bar="true"]');
    expect(stickyBar?.getAttribute("aria-hidden")).toBe("true");

    await view.unmount();
  });

  it("routes the header Stop through the shared confirm dialog as a secondary action", async () => {
    sessionStateMocks.session.phase = "running";
    sessionStateMocks.session.prUrl = null;

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });

    const stopButton = findButtonsByText(view.container, "Stop")[0];
    expect(stopButton).toBeDefined();
    // Stop is resumable — secondary styling, no danger hue, no mono uppercase.
    expect(stopButton?.className).toContain("border-border-strong");
    expect(stopButton?.className).not.toContain("text-error");
    expect(stopButton?.className).not.toContain("uppercase");

    await act(async () => {
      stopButton?.click();
      await flushAsyncWork();
    });

    // No inline confirm strip: the shared useConfirm dialog owns confirmation.
    expect(view.container.textContent).not.toContain("Confirm stop");
    const dialog = view.container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Stop this session? You can send a new prompt to resume.");
    // No PR on this session, so the PR clause must not appear.
    expect(dialog?.textContent).not.toContain("Any open PR stays open.");
    expect(apiMocks.stopSession).not.toHaveBeenCalled();

    const confirmButton = findButtonsByText(view.container, "Stop session")[0];
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton?.click();
      await flushAsyncWork();
    });

    expect(apiMocks.stopSession).toHaveBeenCalledWith("s-1");

    await view.unmount();
  });

  it("links to the exact QA run session and renders terminal metadata", async () => {
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.prUrl = "https://github.com/test-owner/test-repo/pull/89";
    sessionStateMocks.session.repoUrl = "https://github.com/test-owner/test-repo";
    sessionStateMocks.session.baseBranch = "main";
    sessionStateMocks.session.model = { providerID: "openai", modelID: "gpt-5-codex" };
    sessionStateMocks.session.childSessionIds = ["wrong-child"];
    sessionStateMocks.session.qaRun = {
      state: "verification-done",
      verdict: "merge-ready",
      childSessionId: "s-verify",
      runId: 12,
      head: "abcdef1234567890",
      attemptCount: 2,
      maxAttempts: 3,
      evidenceCount: 4,
      blockers: ["Runtime smoke failed."],
    };

    const view = await renderSessionDetail(sessionStateMocks.session, { artifact: "pr" });
    const link = Array.from(view.container.querySelectorAll("a")).find((anchor) =>
      anchor.textContent?.includes("View QA test"),
    );
    expect(link?.getAttribute("href")).toBe("/sessions/s-verify");
    // With a prior QA run the QA slot shows "View QA test", so no trigger button renders.
    expect(findButtonsByText(view.container, "Verify PR")).toHaveLength(0);

    await view.unmount();
  });

  it("triggers QA verification from an opened PR when auto verification is on", async () => {
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.prUrl = "https://github.com/test-owner/test-repo/pull/89";
    sessionStateMocks.session.repoUrl = "https://github.com/test-owner/test-repo";
    sessionStateMocks.session.baseBranch = "main";
    sessionStateMocks.session.model = { providerID: "openai", modelID: "gpt-5-codex" };
    sessionStateMocks.session.childSessionIds = ["s-ordinary"];

    const view = await renderSessionDetail(sessionStateMocks.session, { artifact: "pr" });
    const triggerButtons = findButtonsByText(view.container, "Verify PR");
    expect(triggerButtons).toHaveLength(1);
    expect(view.container.textContent).not.toContain("View QA test");

    await act(async () => {
      triggerButtons[0]?.click();
      await flushAsyncWork();
    });

    expect(apiMocks.createChildSession).toHaveBeenCalledWith("s-1", {
      prompt: expect.stringContaining(
        "The planner decides whether QA can be skipped or must run, whether runtime evidence is needed, and the required proof contract.",
      ),
      repositoryId: "test-owner/test-repo",
      model: { providerID: "openai", modelID: "gpt-5-codex" },
      qa: true,
      targetPrUrl: "https://github.com/test-owner/test-repo/pull/89",
      // The manual button always starts a fresh verifier rather than reusing an in-flight one.
      forceNewSession: true,
    });
    expect(apiMocks.createSessionAndSend).not.toHaveBeenCalled();
    expect(layoutMocks.refreshSessions).toHaveBeenCalledTimes(1);
    expect(routerMocks.navigate).toHaveBeenCalledWith("/sessions/s-verify");

    await view.unmount();
  });

  it("renders one QA trigger for alive PR sessions when auto verification is on", async () => {
    sessionStateMocks.session.phase = "waiting_for_input";
    sessionStateMocks.session.prUrl = "https://github.com/test-owner/test-repo/pull/89";
    sessionStateMocks.session.repoUrl = "https://github.com/test-owner/test-repo";
    sessionStateMocks.session.baseBranch = "main";

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true, artifact: "pr" });

    expect(findButtonsByText(view.container, "Verify PR")).toHaveLength(1);

    await view.unmount();
  });

  it("shows View QA test (not a trigger) while a run is active", async () => {
    sessionStateMocks.session.phase = "completed";
    sessionStateMocks.session.prUrl = "https://github.com/test-owner/test-repo/pull/89";
    sessionStateMocks.session.repoUrl = "https://github.com/test-owner/test-repo";
    sessionStateMocks.session.baseBranch = "main";
    sessionStateMocks.session.model = { providerID: "openai", modelID: "gpt-5-codex" };
    sessionStateMocks.session.qaRun = {
      state: "verification-in-progress",
      verdict: null,
      childSessionId: "s-verify",
      runId: 13,
      head: "abcdef1234567890",
      attemptCount: 1,
      maxAttempts: 3,
      evidenceCount: null,
      blockers: [],
    };

    const view = await renderSessionDetail(sessionStateMocks.session, { artifact: "pr" });
    // The QA slot is mutually exclusive: an existing run (even in progress) surfaces the
    // "View QA test" link to that run, so no trigger button renders.
    const link = Array.from(view.container.querySelectorAll("a")).find((anchor) =>
      anchor.textContent?.includes("View QA test"),
    );
    expect(link?.getAttribute("href")).toBe("/sessions/s-verify");
    expect(findButtonsByText(view.container, "Verify PR")).toHaveLength(0);

    await view.unmount();
  });

  it("shows merged-specific archived banner copy", async () => {
    sessionStateMocks.session.phase = "archived";
    sessionStateMocks.session.closeReason = "pr_merged";

    const view = await renderSessionDetail();

    expect(view.container.textContent).toContain("This session was archived because its pull request was merged.");

    await view.unmount();
  });

  it("does not render stopped-session side-panel resume copy", async () => {
    sessionStateMocks.session.status = "stopped";

    const view = await renderSessionDetail();

    expect(findButtonsByText(view.container, "Resume session")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Send a prompt to resume");

    await view.unmount();
  });

  it("renders archived-session terminal copy inline", async () => {
    sessionStateMocks.session.phase = "archived";
    sessionStateMocks.session.closeReason = "pr_merged";

    const view = await renderSessionDetail();
    const archivedBanner = Array.from(view.container.querySelectorAll("div.session-stack-surface")).find((node) =>
      node.textContent?.includes("Start a new session to continue."),
    );

    expect(findButtonsByText(view.container, "Restore session")).toHaveLength(0);
    expect(archivedBanner).toBeDefined();
    expect(archivedBanner?.className).toContain("px-4");
    expect(archivedBanner?.className).toContain("py-3");
    expect(archivedBanner?.className).not.toContain("session-stack-dense");
    expect(view.container.textContent).toContain("This session was archived because its pull request was merged.");

    await view.unmount();
  });

  it("does not render preview launch controls", async () => {
    sessionStateMocks.session.status = "idle";

    const view = await renderSessionDetail();

    expect(findButtonsByText(view.container, "Launch Preview")).toHaveLength(0);
    expect(findButtonsByText(view.container, "Open Preview")).toHaveLength(0);
    expect(findButtonsByText(view.container, "Retry Preview")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Modal");

    await view.unmount();
  });

  it("hides empty-state scaffolding while seeded session metadata is still hydrating", async () => {
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.repoUrl = null;
    const pending = deferred<{ session: typeof sessionStateMocks.session; prompts: [] }>();
    apiMocks.fetchSessionView.mockReturnValueOnce(pending.promise);

    const view = await renderSessionDetail(sessionStateMocks.session);

    expect(view.container.querySelector('[role="status"]')?.textContent).toContain("Loading session details");
    expect(view.container.querySelectorAll("[data-session-conversation-skeleton] .session-stack-surface")).toHaveLength(
      3,
    );
    expect(view.container.textContent).not.toContain("Connect a repository");
    expect(view.container.textContent).not.toContain("No prompts yet.");

    await view.unmount();
  });

  it("does not refetch repos and settings on mount when layout bootstrap already has them", async () => {
    effectMocks.runMountEffects = true;
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.repoUrl = null;
    layoutMocks.repos = [
      {
        fullName: "test-owner/test-repo",
        url: "https://github.com/test-owner/test-repo",
        private: true,
        defaultBranch: "main",
      },
    ];
    apiMocks.fetchUser.mockResolvedValue({
      status: "authenticated",
      value: { avatarUrl: "https://example.com/avatar.png" },
    });
    apiMocks.fetchSessionView.mockResolvedValue({
      session: { ...sessionStateMocks.session, repoUrl: null, phase: "idle" },
      prompts: [],
    });

    const view = await renderSessionDetail();

    await act(async () => {
      await flushAsyncWork();
    });
    expect(apiMocks.fetchRepos).not.toHaveBeenCalled();
    expect(apiMocks.fetchSettings).not.toHaveBeenCalled();

    await view.unmount();
  });

  it("retries repo fetch when bootstrap repo hydration failed", async () => {
    effectMocks.runMountEffects = true;
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.repoUrl = null;
    layoutMocks.user = {
      id: 1,
      login: "test-user",
      name: "Test User",
      email: "test@example.com",
      avatarUrl: "https://example.com/avatar.png",
      businessId: "biz-1",
      businessRole: "admin",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    };
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.reposError = "Failed to load repositories. GitHub may be unavailable.";
    apiMocks.fetchRepos.mockResolvedValue({
      repos: [
        {
          fullName: "test-owner/test-repo",
          url: "https://github.com/test-owner/test-repo",
          private: true,
          defaultBranch: "main",
        },
      ],
      ssoOrgs: [],
    });
    apiMocks.fetchSessionView.mockResolvedValue({
      session: { ...sessionStateMocks.session, repoUrl: null, phase: "idle" },
      prompts: [],
    });

    const view = await renderSessionDetail();

    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchRepos).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("surfaces SSO-withheld orgs from the session repo fallback", async () => {
    effectMocks.runMountEffects = true;
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.repoUrl = null;
    layoutMocks.user = {
      id: 1,
      login: "test-user",
      name: "Test User",
      email: "test@example.com",
      avatarUrl: "https://example.com/avatar.png",
      businessId: "biz-1",
      businessRole: "admin",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    };
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.reposError = "Failed to load repositories. GitHub may be unavailable.";
    apiMocks.fetchRepos.mockResolvedValue({
      repos: [],
      ssoOrgs: [
        {
          orgId: 42,
          login: "acme",
          authorizeUrl: "/auth/github/sso?org=42",
        },
      ],
    });
    apiMocks.fetchSessionView.mockResolvedValue({
      session: { ...sessionStateMocks.session, repoUrl: null, phase: "idle" },
      prompts: [],
    });

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });

    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchRepos).toHaveBeenCalledTimes(1);
    // Single org renders as one compact row — no duplicate heading.
    expect(view.container.textContent).toContain("acme requires SSO authorization");
    expect(view.container.textContent).not.toContain("needs SSO authorization");
    expect(view.container.querySelector<HTMLAnchorElement>("a[href='/auth/github/sso?org=42']")?.textContent).toBe(
      "Authorize",
    );
    // A successful SSO diagnosis must not also surface the stale repo-load error.
    expect(view.container.textContent).not.toContain("Failed to load repositories");

    const refreshButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh repositories",
    );
    expect(refreshButton).not.toBeUndefined();
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });
    expect(layoutMocks.refreshRepos).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("clears stale fallback SSO orgs once the layout repo state recovers", async () => {
    effectMocks.runMountEffects = true;
    sessionStateMocks.session.status = "idle";
    sessionStateMocks.session.repoUrl = null;
    layoutMocks.user = {
      id: 1,
      login: "test-user",
      name: "Test User",
      email: "test@example.com",
      avatarUrl: "https://example.com/avatar.png",
      businessId: "biz-1",
      businessRole: "admin",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    };
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.reposError = "Failed to load repositories. GitHub may be unavailable.";
    apiMocks.fetchRepos.mockResolvedValue({
      repos: [],
      ssoOrgs: [{ orgId: 42, login: "acme", authorizeUrl: "/auth/github/sso?org=42" }],
    });
    apiMocks.fetchSessionView.mockResolvedValue({
      session: { ...sessionStateMocks.session, repoUrl: null, phase: "idle" },
      prompts: [],
    });

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });
    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });
    expect(view.container.textContent).toContain("acme requires SSO authorization");

    // Simulate the layout recovering after the user authorizes SSO in another
    // tab: repos load, the error clears, and the layout no longer reports orgs.
    layoutMocks.repos = [{ url: "https://github.com/test-owner/test-repo", fullName: "test-owner/test-repo" }];
    layoutMocks.reposError = null;
    layoutMocks.ssoOrgs = [];
    await view.rerender();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(view.container.textContent).not.toContain("acme requires SSO authorization");

    await view.unmount();
  });

  it("hydrates from the websocket subscribed payload when it wins the HTTP race", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;
    const httpBootstrap = deferred<{
      session: typeof sessionStateMocks.session;
      prompts: Array<{ promptId: string; session_id: string; prompt: string; result: string | null; status: string }>;
    }>();
    const prompts = [
      { promptId: "p-1", session_id: "s-1", prompt: "first", result: null, status: "running" },
      { promptId: "p-2", session_id: "s-1", prompt: "second", result: "done", status: "completed" },
    ];
    const subscribed = {
      type: "subscribed" as const,
      version: 2,
      session: {
        sessionId: "s-1",
        ownerUserId: "u-1",
        ownerLogin: "session-owner",
        ownerAvatarUrl: "https://example.com/owner.png",
        phase: "idle",
        closeReason: null,
        createdAt: "2026-04-02T12:00:00.000Z",
        updatedAt: "2026-04-02T12:00:00.000Z",
        closedAt: null,
        lastEventId: null,
        title: "WS title",
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
      queue: { queuedCount: 0, processingPromptId: null },
      prompts,
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
    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };
    apiMocks.fetchSessionView.mockReturnValueOnce(httpBootstrap.promise);

    const view = await renderSessionDetail();

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");

    await act(async () => {
      wsOptions?.onMessage(subscribed);
      await flushAsyncWork();
    });

    expect(sessionStateMocks.mergeSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-1",
        phase: "idle",
        title: "WS title",
        ownerLogin: "session-owner",
        ownerAvatarUrl: "https://example.com/owner.png",
      }),
      prompts,
    );
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenCalledWith([]);
    expect(sessionStateMocks.initializeSessionData).not.toHaveBeenCalled();
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

    await act(async () => {
      httpBootstrap.resolve({
        session: { ...sessionStateMocks.session, title: "HTTP title", phase: "completed" },
        prompts: [{ promptId: "p-http", session_id: "s-1", prompt: "http", result: "done", status: "completed" }],
      });
      await httpBootstrap.promise;
      await flushAsyncWork();
    });

    expect(sessionStateMocks.initializeSessionData).not.toHaveBeenCalled();
    expect(sessionStateMocks.mergeSessionMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "HTTP title" }),
      expect.anything(),
    );

    await view.unmount();
  });

  it("fires seeded HTTP bootstrap immediately instead of waiting for the websocket timeout", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    const prompts = [{ promptId: "p-10", session_id: "s-1", prompt: "timeout", result: null, status: "running" }];
    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: {
        ...sessionStateMocks.session,
        ownerAvatarUrl: "https://example.com/owner.png",
      },
      prompts,
    });

    const view = await renderSessionDetail();

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");

    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(sessionStateMocks.initializeSessionData).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-1" }),
      prompts,
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-10",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await view.unmount();
  });

  it("preserves seeded content after an immediate HTTP bootstrap error while websocket is pending", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    apiMocks.fetchSessionView.mockRejectedValueOnce(new Error("bootstrap failed"));

    const view = await renderSessionDetail();

    await act(async () => {
      await flushAsyncWork();
    });

    expect(view.container.textContent).toContain("Loading session details");
    expect(view.container.textContent).not.toContain("bootstrap failed");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(wsOptions).toBeDefined();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "WS recovery",
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
        queue: { queuedCount: 0, processingPromptId: null },
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
      });
      await flushAsyncWork();
    });

    expect(view.container.textContent).not.toContain("bootstrap failed");
    expect(sessionStateMocks.mergeSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: "WS recovery" }),
      [],
    );
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenCalledWith([]);

    await view.unmount();
  });

  it("retries HTTP bootstrap after an initial fallback failure", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onWsBlocked?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const prompts = [{ promptId: "p-retry", session_id: "s-1", prompt: "retry", result: null, status: "completed" }];
    apiMocks.fetchSessionView.mockRejectedValueOnce(new Error("temporary bootstrap failure")).mockResolvedValueOnce({
      session: {
        ...sessionStateMocks.session,
        phase: "completed",
      },
      prompts,
    });

    const view = await renderSessionDetail();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_BOOTSTRAP_TIMEOUT_MS);
      await flushAsyncWork();
    });

    expect(view.container.textContent).not.toContain("temporary bootstrap failure");

    await act(async () => {
      wsOptions?.onWsBlocked?.();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(2);
    expect(sessionStateMocks.initializeSessionData).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-1", phase: "completed" }),
      prompts,
    );

    await view.unmount();
  });

  it("keeps aggressive polling latched until websocket liveness resumes after a watchdog fallback", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // pin backoff jitter to zero
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage(makeSubscribedMessage());
      await flushAsyncWork();
    });

    apiMocks.fetchSessionView.mockClear();

    await act(async () => {
      wsOptions?.onWsBlocked?.();
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INITIAL_MS);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    apiMocks.fetchSessionView.mockClear();

    await act(async () => {
      wsOptions?.onConnected?.();
      await flushAsyncWork();
    });

    // Aggressive polling stays latched; the backoff has doubled to 2x initial.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INITIAL_MS * 2);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    apiMocks.fetchSessionView.mockClear();

    await act(async () => {
      wsOptions?.onMessage(makeSubscribedMessage());
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INITIAL_MS);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionView).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS - FALLBACK_POLL_INITIAL_MS);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("removes an orphaned session from the sidebar and navigates home after no-seed bootstrap 404", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    apiMocks.fetchSessionView.mockRejectedValueOnce(new apiMocks.ApiError("Session not found", 404));

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });

    await act(async () => {
      await flushAsyncWork();
    });

    expect(layoutMocks.setSessions).toHaveBeenCalled();
    const updateSessions = layoutMocks.setSessions.mock.calls.at(-1)?.[0] as (
      sessions: Array<{ sessionId: string }>,
    ) => Array<{ sessionId: string }>;
    expect(updateSessions([{ sessionId: "s-1" }, { sessionId: "s-2" }])).toEqual([{ sessionId: "s-2" }]);
    expect(routerMocks.navigate).toHaveBeenCalledWith("/", { replace: true });

    await view.unmount();
  });

  it("preserves seeded content after an immediate HTTP bootstrap 404 while websocket is pending", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    apiMocks.fetchSessionView.mockRejectedValueOnce(new apiMocks.ApiError("Session not found", 404));

    const view = await renderSessionDetail();

    await act(async () => {
      await flushAsyncWork();
    });

    expect(view.container.textContent).toContain("Loading session details");
    const removesOrphan = layoutMocks.setSessions.mock.calls.some(
      ([updater]) =>
        typeof updater === "function" &&
        JSON.stringify(
          (updater as (sessions: Array<{ sessionId: string }>) => Array<{ sessionId: string }>)([
            { sessionId: "s-1" },
            { sessionId: "s-2" },
          ]),
        ) === JSON.stringify([{ sessionId: "s-2" }]),
    );
    expect(removesOrphan).toBe(false);
    expect(routerMocks.navigate).not.toHaveBeenCalled();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "WS recovery",
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
        queue: { queuedCount: 0, processingPromptId: null },
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
      });
      await flushAsyncWork();
    });

    const removesOrphanAfterWs = layoutMocks.setSessions.mock.calls.some(
      ([updater]) =>
        typeof updater === "function" &&
        JSON.stringify(
          (updater as (sessions: Array<{ sessionId: string }>) => Array<{ sessionId: string }>)([
            { sessionId: "s-1" },
            { sessionId: "s-2" },
          ]),
        ) === JSON.stringify([{ sessionId: "s-2" }]),
    );
    expect(removesOrphanAfterWs).toBe(false);
    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(sessionStateMocks.mergeSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: "WS recovery" }),
      [],
    );

    await view.unmount();
  });

  it("refresh polling re-fetches active prompt history for a running prompt", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: {
        ...sessionStateMocks.session,
        phase: "running",
      },
      prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Need input", result: null, status: "processing" }],
    });
    const pendingQuestionPage = okPromptHistoryPage({
      rawEvents: [
        {
          sequence: 1,
          type: "question",
          data: { promptId: "p-1", id: "q-1", question: "Ship it?", answer: null },
        },
      ],
      maxSequence: 1,
    });
    apiMocks.fetchPromptEventsPage.mockResolvedValue(pendingQuestionPage);

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Recovery test",
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
        queue: { queuedCount: 0, processingPromptId: "p-1" },
        prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Need input", result: null, status: "processing" }],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      });
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(sessionStateMocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event/prompt_history",
        promptId: "p-1",
        result: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            events: [expect.objectContaining({ type: "question", id: "q-1", question: "Ship it?", answer: null })],
          }),
        }),
      }),
    );

    await view.unmount();
  });

  it("serializes active prompt history refreshes across overlapping replay and poll triggers", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const firstRefresh = deferred<ReturnType<typeof okPromptHistoryPage>>();

    apiMocks.fetchPromptEventsPage.mockReset().mockReturnValueOnce(firstRefresh.promise);
    apiMocks.fetchSessionView.mockResolvedValueOnce({
      session: {
        ...sessionStateMocks.session,
        phase: "running",
      },
      prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Need input", result: null, status: "processing" }],
    });

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Overlap recovery",
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
        queue: { queuedCount: 0, processingPromptId: "p-1" },
        prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Need input", result: null, status: "processing" }],
        lastDurableSequence: 1,
        replay: {
          afterSequence: 0,
          events: [{ sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "missed" } }],
          hasMore: false,
          droppedCount: 0,
          firstSequence: 1,
          lastSequence: 1,
        },
      });
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEvents).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(apiMocks.fetchPromptEvents).not.toHaveBeenCalled();

    await act(async () => {
      firstRefresh.resolve(okPromptHistoryPage({}));
      await firstRefresh.promise;
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchPromptEvents).not.toHaveBeenCalled();

    await view.unmount();
  });

  it("hydrates prompt history prompt-by-prompt with bounded concurrency", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const pendingPromptFetches = Array.from({ length: 4 }, () => deferred<ReturnType<typeof okPromptHistoryPage>>());
    apiMocks.fetchPromptEventsPage.mockReset();
    for (const pendingFetch of pendingPromptFetches) {
      apiMocks.fetchPromptEventsPage.mockReturnValueOnce(pendingFetch.promise);
    }

    const prompts = Array.from({ length: 4 }, (_, index) => ({
      promptId: `p-${index + 1}`,
      session_id: "s-1",
      prompt: `Prompt ${index + 1}`,
      result: "done",
      status: "completed" as const,
    }));

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Concurrency recovery",
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
        queue: { queuedCount: 0, processingPromptId: null },
        prompts,
        lastDurableSequence: 1,
        replay: {
          afterSequence: 0,
          events: [{ sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "seed" } }],
          hasMore: false,
          droppedCount: 0,
          firstSequence: 1,
          lastSequence: 1,
        },
      });
      await flushAsyncWork();
    });

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

    await act(async () => {
      pendingPromptFetches[1]?.resolve(okPromptHistoryPage({}));
      await pendingPromptFetches[1]?.promise;
      await flushAsyncWork();
    });
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(3);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      3,
      "s-1",
      "p-3",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await act(async () => {
      pendingPromptFetches[0]?.resolve(okPromptHistoryPage({}));
      await pendingPromptFetches[0]?.promise;
      await flushAsyncWork();
    });
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(4);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      4,
      "s-1",
      "p-4",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await act(async () => {
      pendingPromptFetches[2]?.resolve(okPromptHistoryPage({}));
      pendingPromptFetches[3]?.resolve(okPromptHistoryPage({}));
      await Promise.all([pendingPromptFetches[2]?.promise, pendingPromptFetches[3]?.promise]);
      await flushAsyncWork();
    });

    await view.unmount();
  });

  it("prioritizes visible prompt hydration in rendered order", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const pendingPromptFetches = Array.from({ length: 5 }, () => deferred<ReturnType<typeof okPromptHistoryPage>>());
    apiMocks.fetchPromptEventsPage.mockReset();
    for (const pendingFetch of pendingPromptFetches) {
      apiMocks.fetchPromptEventsPage.mockReturnValueOnce(pendingFetch.promise);
    }

    const prompts = Array.from({ length: 5 }, (_, index) => ({
      promptId: `p-${index + 1}`,
      session_id: "s-1",
      prompt: `Prompt ${index + 1}`,
      result: "done",
      status: "completed" as const,
    }));
    sessionStateMocks.prompts = prompts;

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Visible prompt priority",
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
        queue: { queuedCount: 0, processingPromptId: null },
        prompts,
        lastDurableSequence: 1,
        replay: {
          afterSequence: 0,
          events: [{ sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "seed" } }],
          hasMore: false,
          droppedCount: 0,
          firstSequence: 1,
          lastSequence: 1,
        },
      });
      await flushAsyncWork();
    });

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

    const promptObserver = intersectionObserverInstances.find((observer) =>
      observer.observe.mock.calls.some(([node]) => (node as HTMLElement).dataset?.promptId === "p-4"),
    );
    expect(promptObserver).toBeDefined();
    const prompt3Node = promptObserver?.observe.mock.calls
      .map(([node]) => node as HTMLElement)
      .find((node) => node.dataset.promptId === "p-3");
    const prompt4Node = promptObserver?.observe.mock.calls
      .map(([node]) => node as HTMLElement)
      .find((node) => node.dataset.promptId === "p-4");
    expect(prompt3Node).toBeDefined();
    expect(prompt4Node).toBeDefined();

    await act(async () => {
      promptObserver?.trigger([
        { target: prompt4Node, isIntersecting: true },
        { target: prompt3Node, isIntersecting: true },
      ]);
      await flushAsyncWork();
    });

    await act(async () => {
      pendingPromptFetches[1]?.resolve(okPromptHistoryPage({}));
      await pendingPromptFetches[1]?.promise;
      await flushAsyncWork();
    });
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(3);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      3,
      "s-1",
      "p-3",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await act(async () => {
      pendingPromptFetches[2]?.resolve(okPromptHistoryPage({}));
      await pendingPromptFetches[2]?.promise;
      await flushAsyncWork();
    });
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(4);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      4,
      "s-1",
      "p-4",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await act(async () => {
      pendingPromptFetches[0]?.resolve(okPromptHistoryPage({}));
      pendingPromptFetches[3]?.resolve(okPromptHistoryPage({}));
      pendingPromptFetches[4]?.resolve(okPromptHistoryPage({}));
      await Promise.all([pendingPromptFetches[0]?.promise, pendingPromptFetches[3]?.promise]);
      await flushAsyncWork();
    });

    await view.unmount();
  });

  it("hydrates the active prompt outside the background scheduler concurrency limit", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const activePromptFetch = deferred<ReturnType<typeof okPromptHistoryPage>>();
    const firstPromptFetch = deferred<ReturnType<typeof okPromptHistoryPage>>();
    const secondPromptFetch = deferred<ReturnType<typeof okPromptHistoryPage>>();
    const thirdPromptFetch = deferred<ReturnType<typeof okPromptHistoryPage>>();
    apiMocks.fetchPromptEventsPage
      .mockReset()
      .mockReturnValueOnce(activePromptFetch.promise)
      .mockReturnValueOnce(firstPromptFetch.promise)
      .mockReturnValueOnce(secondPromptFetch.promise)
      .mockReturnValueOnce(thirdPromptFetch.promise);

    const prompts = [
      { promptId: "p-1", session_id: "s-1", prompt: "Prompt 1", result: "done", status: "completed" as const },
      { promptId: "p-2", session_id: "s-1", prompt: "Prompt 2", result: "done", status: "completed" as const },
      { promptId: "p-3", session_id: "s-1", prompt: "Prompt 3", result: "done", status: "completed" as const },
      { promptId: "p-4", session_id: "s-1", prompt: "Prompt 4", result: null, status: "processing" as const },
    ];

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Active prompt fast lane",
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
        queue: { queuedCount: 0, processingPromptId: "p-4" },
        prompts,
        lastDurableSequence: 1,
        replay: {
          afterSequence: 0,
          events: [{ sequence: 1, type: "text", data: { promptId: "p-4", id: "t-1", text: "live" } }],
          hasMore: false,
          droppedCount: 0,
          firstSequence: 1,
          lastSequence: 1,
        },
      });
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(3);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      1,
      "s-1",
      "p-4",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      2,
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      3,
      "s-1",
      "p-2",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEvents).not.toHaveBeenCalled();

    await act(async () => {
      secondPromptFetch.resolve(okPromptHistoryPage({}));
      await secondPromptFetch.promise;
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(4);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenNthCalledWith(
      4,
      "s-1",
      "p-3",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );

    await act(async () => {
      firstPromptFetch.resolve(okPromptHistoryPage({}));
      activePromptFetch.resolve(okPromptHistoryPage({}));
      thirdPromptFetch.resolve(okPromptHistoryPage({}));
      await Promise.all([firstPromptFetch.promise, activePromptFetch.promise, thirdPromptFetch.promise]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledTimes(4);

    await view.unmount();
  });

  it("keeps resilience polling active after a transient refresh failure", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    apiMocks.fetchSessionView
      .mockResolvedValueOnce({
        session: {
          ...sessionStateMocks.session,
          phase: "running",
        },
        prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Retry poll", result: null, status: "processing" }],
      })
      .mockRejectedValueOnce(new Error("temporary refresh failure"))
      .mockResolvedValueOnce({
        session: {
          ...sessionStateMocks.session,
          phase: "running",
        },
        prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Retry poll", result: null, status: "processing" }],
      });
    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Polling retry",
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
        queue: { queuedCount: 0, processingPromptId: "p-1" },
        prompts: [{ promptId: "p-1", session_id: "s-1", prompt: "Retry poll", result: null, status: "processing" }],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      });
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS);
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledTimes(3);
    expect(apiMocks.fetchPromptEventsPage).toHaveBeenCalledWith(
      "s-1",
      "p-1",
      { afterSequence: undefined },
      expect.any(AbortSignal),
    );
    expect(apiMocks.fetchPromptEvents).not.toHaveBeenCalled();

    await view.unmount();
  });
  it("reconnect with partial replay calls mergeSessionMetadata then ingestReplayPage in order", async () => {
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;
    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const prompts = [{ promptId: "p-1", session_id: "s-1", prompt: "first", result: null, status: "running" }];
    const makeSubscribed = (afterSequence: number, replayEvents: unknown[], lastSequence: number | null) => ({
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
        title: "Reconnect test",
        model: null,
        repoUrl: "https://github.com/test-owner/test-repo",
        baseBranch: "main",
        lastBranch: null,
        prUrl: null,
        prCreating: false,
        spawnDurationMs: null,
      },
      sandbox: { status: "ready", sandboxId: "sb-1", connected: true, spawnDurationMs: null },
      queue: { queuedCount: 0, processingPromptId: null },
      prompts,
      lastDurableSequence: lastSequence ?? 0,
      replay: {
        afterSequence,
        events: replayEvents,
        hasMore: false,
        droppedCount: 0,
        firstSequence: replayEvents.length > 0 ? afterSequence + 1 : null,
        lastSequence,
      },
    });

    const view = await renderSessionDetail();

    // First connect — full replay with events at seq 1-3
    const initialEvents = [
      { sequence: 1, type: "prompt_processing", data: { promptId: "p-1" } },
      { sequence: 2, type: "text", data: { promptId: "p-1", id: "t-1", text: "hello" } },
      { sequence: 3, type: "question", data: { promptId: "p-1", id: "q-1", question: "Need anything?", answer: null } },
    ];
    await act(async () => {
      wsOptions?.onMessage(makeSubscribed(0, initialEvents, 3));
      await flushAsyncWork();
    });

    expect(sessionStateMocks.mergeSessionMetadata).toHaveBeenCalledTimes(1);
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenCalledTimes(1);
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenCalledWith(initialEvents);

    // Live event at seq 4 advances lastSequenceRef
    await act(async () => {
      wsOptions?.onMessage({
        type: "session_event",
        event: { sequence: 4, type: "text", data: { promptId: "p-1", id: "t-2", text: "more" } },
      });
      await flushAsyncWork();
    });

    // Reconnect — partial replay with only seq 5
    const reconnectEvents = [
      { sequence: 5, type: "text", data: { promptId: "p-1", id: "t-3", text: "after reconnect" } },
    ];
    await act(async () => {
      wsOptions?.onMessage(makeSubscribed(4, reconnectEvents, 5));
      await flushAsyncWork();
    });

    // mergeSessionMetadata called again for reconnect
    expect(sessionStateMocks.mergeSessionMetadata).toHaveBeenCalledTimes(2);
    // ingestReplayPage called with only the partial replay
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenCalledTimes(2);
    expect(sessionStateMocks.ingestReplayPage).toHaveBeenLastCalledWith(reconnectEvents);

    // Verify call order: mergeSessionMetadata before ingestReplayPage for the reconnect
    const resetCalls = sessionStateMocks.mergeSessionMetadata.mock.invocationCallOrder;
    const ingestCalls = sessionStateMocks.ingestReplayPage.mock.invocationCallOrder;
    expect(resetCalls[1]).toBeLessThan(ingestCalls[1]);

    await view.unmount();
  });

  it("removes an orphaned session from the sidebar and navigates home after refresh 404", async () => {
    vi.useFakeTimers();
    effectMocks.runMountEffects = true;
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    apiMocks.fetchSessionView
      .mockRejectedValueOnce(new apiMocks.ApiError("Session not found", 404))
      .mockRejectedValueOnce(new apiMocks.ApiError("Session not found", 404));

    const view = await renderSessionDetail();

    await act(async () => {
      wsOptions?.onMessage({
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          phase: "running",
          closeReason: null,
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "WS recovery",
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
        queue: { queuedCount: 0, processingPromptId: null },
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
      });
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESILIENCE_POLL_MS);
      await flushAsyncWork();
    });

    expect(layoutMocks.setSessions).toHaveBeenCalled();
    const removesOrphan = layoutMocks.setSessions.mock.calls.some(
      ([updater]) =>
        typeof updater === "function" &&
        JSON.stringify(
          (updater as (sessions: Array<{ sessionId: string }>) => Array<{ sessionId: string }>)([
            { sessionId: "s-1" },
            { sessionId: "s-2" },
          ]),
        ) === JSON.stringify([{ sessionId: "s-2" }]),
    );
    expect(removesOrphan).toBe(true);
    expect(routerMocks.navigate).toHaveBeenCalledWith("/", { replace: true });

    await view.unmount();
  });

  it("creates and disconnects the replay observer with the scroll container as root", async () => {
    const view = await renderSessionDetail();

    const observer = intersectionObserverInstances.find((instance) => instance.rootMargin === "200px 0px 0px 0px");
    if (!observer) throw new Error("expected replay pagination observer");
    expect(observer.observe).toHaveBeenCalledTimes(1);
    expect(observer.root).toBe(view.container.querySelector("[data-session-scroll-container]"));
    expect(observer.rootMargin).toBe("200px 0px 0px 0px");

    await view.unmount();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("requests an older replay page when the top sentinel intersects and older events are available", async () => {
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
          onDisconnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const view = await renderSessionDetail();
    const observer = intersectionObserverInstances[0];

    await act(async () => {
      wsOptions?.onMessage(
        makeSubscribedMessage({
          replay: {
            afterSequence: 87,
            hasMore: true,
            firstSequence: 88,
            lastSequence: 288,
          },
        }),
      );
      await flushAsyncWork();
    });

    await act(async () => {
      observer.trigger([{ isIntersecting: true }]);
      await flushAsyncWork();
    });

    expect(websocketMocks.requestReplayPage).toHaveBeenCalledTimes(1);
    expect(websocketMocks.requestReplayPage).toHaveBeenCalledWith({ beforeSequence: 88, limit: 200 });
    expect(view.container.textContent).toContain("Loading earlier messages…");

    await view.unmount();
  });

  it("keeps initial long-session bootstraps on the normal older replay paging path", async () => {
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
          onDisconnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const view = await renderSessionDetail();
    const observer = intersectionObserverInstances[0];

    await act(async () => {
      wsOptions?.onMessage(
        makeSubscribedMessage({
          replay: {
            afterSequence: 0,
            hasMore: true,
            firstSequence: 88,
            lastSequence: 288,
          },
        }),
      );
      await flushAsyncWork();
    });

    await act(async () => {
      observer.trigger([{ isIntersecting: true }]);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionView).toHaveBeenCalledWith("s-1");
    expect(websocketMocks.requestReplayPage).toHaveBeenCalledTimes(1);
    expect(websocketMocks.requestReplayPage).toHaveBeenCalledWith({ beforeSequence: 88, limit: 200 });
    expect(view.container.textContent).toContain("Loading earlier messages…");

    await view.unmount();
  });

  it("does not request an older replay page when the sentinel intersects without older events", async () => {
    const view = await renderSessionDetail();
    const observer = intersectionObserverInstances[0];

    await act(async () => {
      observer.trigger([{ isIntersecting: true }]);
      await flushAsyncWork();
    });

    expect(websocketMocks.requestReplayPage).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await view.unmount();
  });

  it("clears the loading indicator on replay paging reset events", async () => {
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
          onDisconnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const view = await renderSessionDetail();
    const observer = intersectionObserverInstances[0];

    async function startLoading() {
      await act(async () => {
        wsOptions?.onMessage(
          makeSubscribedMessage({
            replay: {
              afterSequence: 41,
              hasMore: true,
              firstSequence: 42,
              lastSequence: 142,
            },
          }),
        );
        await flushAsyncWork();
      });

      await act(async () => {
        observer.trigger([{ isIntersecting: true }]);
        await flushAsyncWork();
      });

      expect(view.container.textContent).toContain("Loading earlier messages…");
    }

    await startLoading();

    await act(async () => {
      wsOptions?.onMessage({
        type: "replay_page",
        afterSequence: 0,
        beforeSequence: 42,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      });
      await flushAsyncWork();
    });
    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await startLoading();

    await act(async () => {
      wsOptions?.onMessage({
        type: "replay_truncated",
        requestedAfterSequence: 0,
        firstReturnedSequence: 1,
        lastReturnedSequence: 42,
        droppedCount: 1,
      });
      await flushAsyncWork();
    });
    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await startLoading();

    await act(async () => {
      wsOptions?.onDisconnected?.();
      await flushAsyncWork();
    });
    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await act(async () => {
      wsOptions?.onMessage(
        makeSubscribedMessage({
          replay: {
            hasMore: false,
            firstSequence: null,
            lastSequence: 142,
          },
        }),
      );
      await flushAsyncWork();
    });
    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await view.unmount();
  });

  it("clears replay paging state after replay_error so older paging can be retried", async () => {
    let wsOptions:
      | {
          onMessage: (msg: unknown) => void;
          onWsBlocked?: () => void;
          onConnected?: () => void;
          onDisconnected?: () => void;
        }
      | undefined;

    websocketMocks.onMount = (options) => {
      wsOptions = options;
    };

    const view = await renderSessionDetail();
    const observer = intersectionObserverInstances[0];

    await act(async () => {
      wsOptions?.onMessage(
        makeSubscribedMessage({
          replay: {
            afterSequence: 41,
            hasMore: true,
            firstSequence: 42,
            lastSequence: 142,
          },
        }),
      );
      await flushAsyncWork();
    });

    await act(async () => {
      observer.trigger([{ isIntersecting: true }]);
      await flushAsyncWork();
    });

    expect(websocketMocks.requestReplayPage).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Loading earlier messages…");

    await act(async () => {
      wsOptions?.onMessage({
        type: "replay_error",
        message: "limit must be a positive integer",
      });
      await flushAsyncWork();
    });

    expect(view.container.textContent).not.toContain("Loading earlier messages…");

    await act(async () => {
      observer.trigger([{ isIntersecting: true }]);
      await flushAsyncWork();
    });

    expect(websocketMocks.requestReplayPage).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it("shows the context-kept composer hint and keeps the textarea enabled after a user soft-stop", async () => {
    sessionStateMocks.session.phase = "idle";
    sessionStateMocks.session.userStopped = true;

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });

    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("placeholder")).toBe("Context kept — add what you missed…");
    expect(textarea?.disabled).toBe(false);

    await view.unmount();
  });

  it("does not show the context-kept hint for a plain idle session", async () => {
    sessionStateMocks.session.phase = "idle";
    sessionStateMocks.session.userStopped = false;

    const view = await renderSessionDetail(sessionStateMocks.session, { omitInitialSession: true });

    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("placeholder")).not.toBe("Context kept — add what you missed…");

    await view.unmount();
  });
});
