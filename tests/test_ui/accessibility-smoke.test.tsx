import { Window } from "happy-dom";
import { axe } from "jest-axe";
import type React from "react";
import { act, createElement, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import type { LayoutContext } from "../../apps/ui/src/components/Layout";
import { SessionDetailView } from "../../apps/ui/src/components/SessionDetail";
import { CliTokensSettings } from "../../apps/ui/src/components/settings/CliTokensSettings";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import { createEmptyTokenUsage } from "../../apps/ui/src/hooks/session-state/transcript-helpers";
import { HomePage } from "../../apps/ui/src/pages/HomePage";
import type { ModelSelection, Repo, SessionDetail, User } from "../../apps/ui/src/types";

const TEST_USER: User = {
  id: 1,
  login: "josiah",
  name: "Josiah",
  email: "josiah@example.com",
  avatarUrl: null,
  businessId: "biz-1",
  businessRole: "admin",
  sharedSessions: false,
  linearConnected: false,
  jiraConnected: false,
  jiraSiteName: null,
  notionConnected: false,
  slackConnected: false,
  slackNeedsReconnect: false,
};

const TEST_REPO: Repo = {
  fullName: "trycycloid/cycloid",
  url: "https://github.com/trycycloid/cycloid",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const TEST_MODEL: ModelSelection = {
  providerID: "openai",
  modelID: "gpt-5.4",
};

const TEST_MODELS = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        label: "GPT-5.4",
        reasoning: { efforts: ["none", "low", "medium", "high"], default: undefined },
      },
    ],
  },
];

const TEST_SESSION: SessionDetail = {
  sessionId: "s-1",
  phase: "idle",
  title: "Polish settings",
  repoUrl: TEST_REPO.url,
  prUrl: null,
  closeReason: null,
  queueLength: 0,
  createdAt: "2026-06-21T12:00:00.000Z",
  updatedAt: "2026-06-21T12:05:00.000Z",
  closedAt: null,
  lastEventId: null,
  ownerUserId: "1",
  model: TEST_MODEL,
  reasoningEffort: null,
  spawnDurationMs: null,
  lastBranch: null,
  baseBranch: "main",
  prCreating: false,
};

const layoutMocks = vi.hoisted(() => ({
  user: undefined as LayoutContext["user"],
  repos: [] as Repo[],
  reposLoaded: false,
  reposError: null as string | null,
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
  settingsLoaded: true,
  settingsError: null,
  setSettings: vi.fn(),
  selectedRepo: null as Repo | null,
  setSelectedRepo: vi.fn(),
  selectedRepoFreshValidated: true,
  models: [],
  selectedModel: null as ModelSelection | null,
  setSelectedModel: vi.fn(),
  selectModelForNewSession: vi.fn(),
  sessions: [],
  sessionsLoaded: true,
  setSessions: vi.fn(),
  patchSession: vi.fn(),
  creating: false,
  setCreating: vi.fn(),
  error: null,
  setError: vi.fn(),
  handleNewSessionPrompt: vi.fn(async () => undefined),
  loadFilesForHomePage: vi.fn(async () => []),
  onLinearChange: vi.fn(),
  onJiraChange: vi.fn(),
  onNotionChange: vi.fn(),
  onSlackChange: vi.fn(),
  onDefaultModelChange: vi.fn(),
  refreshUser: vi.fn(),
  endSession: vi.fn(),
}));

const sessionStateMocks = vi.hoisted(() => ({
  session: null as SessionDetail | null,
  prompts: [],
  transcripts: new Map(),
  incompletePromptIds: new Set<string>(),
  stateRef: { current: { session: null, prompts: [], transcripts: new Map() } },
  liveModeRef: { current: true },
  dispatch: vi.fn(),
  initializeSessionData: vi.fn(),
  mergeSessionMetadata: vi.fn(),
  ingestReplayPage: vi.fn(),
  applyPromptHistoryFetchResult: vi.fn(),
  updateSession: vi.fn(),
  setPrUpdated: vi.fn(),
  answerLatestQuestion: vi.fn(),
  getActivePromptId: vi.fn(() => null),
}));

const apiMocks = vi.hoisted(() => ({
  fetchCliTokens: vi.fn(async () => ({ data: [], nextCursor: null })),
  createCliToken: vi.fn(),
  revokeCliToken: vi.fn(),
  deleteCliToken: vi.fn(),
  fetchSessionFiles: vi.fn(async () => []),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/components/PromptForm.tsx", () => ({
  PromptForm: forwardRef(
    (
      props: {
        leadingActions?: React.ReactNode;
        leadingChips?: React.ReactNode;
        placeholder?: string;
        disabled?: boolean;
        submitDisabledReason?: string;
        onSubmit?: (payload: { prompt: string }) => void | Promise<void>;
      },
      _ref,
    ) =>
      createElement(
        "form",
        {
          onSubmit: (event: React.FormEvent) => {
            event.preventDefault();
            if (!props.disabled && !props.submitDisabledReason) void props.onSubmit?.({ prompt: "Build this" });
          },
        },
        props.leadingActions ?? null,
        props.leadingChips ?? null,
        createElement("textarea", {
          "aria-label": "Prompt",
          disabled: !!props.disabled,
          placeholder: props.placeholder,
          defaultValue: "Build this",
        }),
        createElement("button", { type: "submit", disabled: !!props.disabled || !!props.submitDisabledReason }, "Send"),
      ),
  ),
}));

vi.mock("../../apps/ui/src/components/Transcript.tsx", () => ({
  Transcript: () => createElement("div", { "aria-label": "Transcript" }),
}));

vi.mock("../../apps/ui/src/api/repos.ts", () => ({
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchRepos: vi.fn(async () => ({ repos: [TEST_REPO], ssoOrgs: [] })),
}));

vi.mock("../../apps/ui/src/api/skills.ts", () => ({
  fetchRepoSkills: vi.fn(async () => []),
}));

vi.mock("../../apps/ui/src/api/cli-tokens.ts", () => ({
  fetchCliTokens: apiMocks.fetchCliTokens,
  createCliToken: apiMocks.createCliToken,
  revokeCliToken: apiMocks.revokeCliToken,
  deleteCliToken: apiMocks.deleteCliToken,
}));

vi.mock("../../apps/ui/src/api/sessions.ts", () => ({
  createSessionAndSend: vi.fn(async () => ({ sessionId: "s-verify", promptId: "p-verify" })),
  fetchSessionFiles: apiMocks.fetchSessionFiles,
  fetchSessionPrerequisites: vi.fn(async () => ({ canStartSession: true })),
  respondToQuestion: vi.fn(async () => undefined),
  sendPrompt: vi.fn(async () => "prompt-1"),
  setSessionRepo: vi.fn(async () => undefined),
  stopSession: vi.fn(async () => undefined),
  submitMemoryFeedback: vi.fn(async () => undefined),
  unarchiveSession: vi.fn(async () => undefined),
  warmSandbox: vi.fn(),
}));

vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const ReactModule = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      ReactModule.useEffect(effect, []);
    },
    useSyncEffect: ReactModule.useEffect,
    useLayoutSyncEffect: ReactModule.useLayoutEffect,
  };
});

vi.mock("../../apps/ui/src/hooks/useSessionState.ts", () => ({
  getInFlightPromptId: vi.fn(() => null),
  useSessionState: () => ({
    state: {
      session: sessionStateMocks.session,
      prompts: sessionStateMocks.prompts,
      transcripts: sessionStateMocks.transcripts,
      incompletePromptIds: sessionStateMocks.incompletePromptIds,
      tokenUsage: createEmptyTokenUsage(),
      prError: null,
      prUpdated: false,
      prActivity: [],
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
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionBootstrap.ts", () => ({
  useSessionBootstrap: () => ({
    bootstrapFromHttp: vi.fn(),
    clearBootstrapTimeout: vi.fn(),
    error: null,
    fetchPromptHistoryWithRetry: vi.fn(async () => ({ ok: true, result: { events: [] } })),
    hydratePromptHistories: vi.fn(async () => undefined),
    markPromptHistoriesSkipped: vi.fn(),
    ownerAvatarUrl: null,
    promptHistoryStates: new Map(),
    prioritizePromptHistories: vi.fn(),
    refresh: vi.fn(async () => undefined),
    refreshActivePromptHistory: vi.fn(async () => undefined),
    sessionHydrated: true,
    setError: vi.fn(),
    setSessionHydrated: vi.fn(),
    wsBootstrappedRef: { current: true },
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionActionRunner.ts", () => ({
  useSessionActionRunner: () => ({
    runSessionAction: vi.fn(async ({ action }: { action: () => Promise<unknown> }) => action()),
    runTrackedSessionAction: vi.fn(async ({ action }: { action: () => Promise<unknown> }) => action()),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionFallbackPolling.ts", () => ({
  useSessionFallbackPolling: () => ({
    aggressiveFallbackActiveRef: { current: false },
    clearPolling: vi.fn(),
    startAggressiveFallbackPolling: vi.fn(),
    startResiliencePolling: vi.fn(),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionReplay.ts", () => ({
  useSessionReplay: () => ({
    loadingOlderEvents: false,
    scrollContainerRef: vi.fn(),
    topSentinelRef: vi.fn(),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionRepoFallback.ts", () => ({
  useSessionRepoFallback: () => ({
    effectiveRepos: [TEST_REPO],
    effectiveReposError: null,
    effectiveReposLoaded: true,
    fallbackSsoOrgs: [],
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionScreenshots.ts", () => ({
  useSessionScreenshots: () => new Map(),
}));

vi.mock("../../apps/ui/src/hooks/useTransientDisconnectMask.ts", () => ({
  useTransientDisconnectMask: (session: SessionDetail | null) => session,
}));

vi.mock("../../apps/ui/src/hooks/useMobile.ts", () => ({
  useMobile: () => false,
}));

vi.mock("../../apps/ui/src/datadog.ts", () => ({
  addSessionTiming: vi.fn(),
  clearDatadogSessionContext: vi.fn(),
  setDatadogSessionContext: vi.fn(),
  trackAction: vi.fn(),
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  captureUiError: vi.fn(),
}));

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    SVGElement: windowInstance.SVGElement,
    Element: windowInstance.Element,
    Document: windowInstance.Document,
    DocumentFragment: windowInstance.DocumentFragment,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
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
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(ToastProvider, null, element)));
    await flushAsyncWork();
  });

  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
  }

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe(container);
  expect(result.violations).toEqual([]);
}

describe("accessibility smoke", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com" });
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedModel = TEST_MODEL;
    sessionStateMocks.session = TEST_SESSION;
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("has no axe violations on HomePage, SessionDetail, and settings surfaces", async () => {
    const home = await render(createElement(HomePage));
    await expectNoAxeViolations(home.container);
    await home.unmount();

    const sessionDetail = await render(
      createElement(
        ToastProvider,
        null,
        createElement(
          ConfirmProvider,
          null,
          createElement(SessionDetailView, { sessionId: "s-1", initialSession: TEST_SESSION }),
        ),
      ),
    );
    await expectNoAxeViolations(sessionDetail.container);
    await sessionDetail.unmount();

    const settings = await render(createElement(ConfirmProvider, null, createElement(CliTokensSettings)));
    await expectNoAxeViolations(settings.container);
    await settings.unmount();
  });
});
