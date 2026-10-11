import { Window } from "happy-dom";
import type React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { SessionDetailView } from "../../apps/ui/src/components/SessionDetail";
import { getCanonicalSessionStatus } from "../../apps/ui/src/components/SessionHeader";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import { createEmptyTokenUsage } from "../../apps/ui/src/hooks/session-state/transcript-helpers";
import type { SessionDetail } from "../../apps/ui/src/types";

const endSessionMock = vi.fn();

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("../../apps/ui/src/components/Layout", () => ({
  useLayoutContext: () => ({
    setSessions: vi.fn(),
    patchSession: vi.fn(),
    selectedModel: null,
    models: [],
    repos: [],
    reposLoaded: true,
    reposError: null,
    settings: {},
    setSettings: vi.fn(),
    user: null,
    endSession: endSessionMock,
  }),
}));

vi.mock("../../apps/ui/src/hooks/useEffects", async () => {
  const React = await import("react");
  return {
    useMountEffect: React.useEffect,
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

vi.mock("../../apps/ui/src/hooks/useSessionActionRunner", () => ({
  useSessionActionRunner: () => ({
    runSessionAction: vi.fn(),
    runTrackedSessionAction: vi.fn(),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionBootstrap", () => ({
  useSessionBootstrap: () => ({
    bootstrapFromHttp: vi.fn(),
    clearBootstrapTimeout: vi.fn(),
    error: null,
    fetchPromptHistoryWithRetry: vi.fn(),
    fetchPromptHistoryOnce: vi.fn(),
    hydratePromptHistories: vi.fn(),
    markPromptHistoriesSkipped: vi.fn(),
    ownerAvatarUrl: null,
    promptHistoryStates: new Map(),
    prioritizePromptHistories: vi.fn(),
    refresh: vi.fn(),
    refreshActivePromptHistory: vi.fn(),
    sessionHydrated: true,
    setError: vi.fn(),
    setSessionHydrated: vi.fn(),
    wsBootstrappedRef: { current: true },
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionFallbackPolling", () => ({
  useSessionFallbackPolling: () => ({
    aggressiveFallbackActiveRef: { current: false },
    clearPolling: vi.fn(),
    startAggressiveFallbackPolling: vi.fn(),
    startResiliencePolling: vi.fn(),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionReplay", () => ({
  useSessionReplay: () => ({
    loadingOlderEvents: false,
    scrollContainerRef: vi.fn(),
    topSentinelRef: vi.fn(),
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionRepoFallback", () => ({
  useSessionRepoFallback: () => ({
    effectiveRepos: [],
    effectiveReposError: null,
    effectiveReposLoaded: true,
  }),
}));

vi.mock("../../apps/ui/src/hooks/useSessionScreenshots", () => ({
  useSessionScreenshots: () => new Map(),
}));

vi.mock("../../apps/ui/src/hooks/useSessionState", () => ({
  getInFlightPromptId: vi.fn(() => null),
  useSessionState: () => ({
    state: {
      session: {
        sessionId: "s-1",
        phase: "running",
        title: "Open PR session",
        repoUrl: "https://github.com/test-owner/test-repo",
        repoOwner: "test-owner",
        repoName: "test-repo",
        prUrl: "https://github.com/trycycloid/cycloid/pull/1346",
        prDraft: false,
        verification: null,
        queueLength: 0,
        createdAt: "2026-05-15T12:00:00.000Z",
        updatedAt: "2026-05-15T12:00:00.000Z",
        closedAt: null,
        lastEventId: null,
        ownerUserId: "u-1",
        ownerLogin: "parappally",
        ownerAvatarUrl: null,
        model: null,
        reasoningEffort: null,
        spawnDurationMs: null,
        lastBranch: null,
        baseBranch: "main",
        prCreating: false,
        prManualReviewReason: null,
        closeReason: null,
      },
      prompts: [],
      transcripts: new Map(),
      incompletePromptIds: new Set<string>(),
      tokenUsage: createEmptyTokenUsage(),
      prError: null,
      prUpdated: false,
    },
    dispatch: vi.fn(),
    stateRef: { current: { session: null, prompts: [], transcripts: new Map() } },
    liveModeRef: { current: true },
    initializeSessionData: vi.fn(),
    mergeSessionMetadata: vi.fn(),
    ingestReplayPage: vi.fn(),
    applyPromptHistoryFetchResult: vi.fn(),
    updateSession: vi.fn(),
    setPrUpdated: vi.fn(),
    answerLatestQuestion: vi.fn(),
    getActivePromptId: vi.fn(() => null),
  }),
}));

vi.mock("../../apps/ui/src/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  SectionErrorFallback: () => null,
}));

vi.mock("../../apps/ui/src/components/SessionHeader", async () => {
  const actual = await vi.importActual<typeof import("../../apps/ui/src/components/SessionHeader")>(
    "../../apps/ui/src/components/SessionHeader",
  );
  return {
    ...actual,
    CanonicalStatusChip: ({ status }: { status: { label: string } }) =>
      createElement("span", { "aria-label": `Session status: ${status.label}` }, status.label),
    SessionHeader: ({ session }: { session: { title: string } }) => createElement("div", null, session.title),
  };
});

vi.mock("../../apps/ui/src/components/SessionTurn", () => ({
  SessionTurn: () => null,
}));

vi.mock("../../apps/ui/src/components/PromptForm", () => ({
  PromptForm: ({ leadingActions }: { leadingActions?: React.ReactNode }) =>
    createElement("div", { "data-testid": "prompt-form-leading-actions" }, leadingActions),
}));

const baseSession: SessionDetail = {
  sessionId: "s-status",
  phase: "running",
  title: "Status session",
  repoUrl: "https://github.com/test-owner/test-repo",
  repoOwner: "test-owner",
  repoName: "test-repo",
  prUrl: null,
  prDraft: false,
  verification: null,
  queueLength: 0,
  createdAt: 1,
  model: null,
  lastBranch: null,
  baseBranch: "main",
};

describe("SessionDetailView footer actions", () => {
  let happyWindow: Window;

  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/sessions/s-1";
    Object.assign(globalThis, {
      window: happyWindow,
      document: happyWindow.document,
      HTMLElement: happyWindow.HTMLElement,
      SVGElement: happyWindow.SVGElement,
      Node: happyWindow.Node,
      MutationObserver: happyWindow.MutationObserver,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: happyWindow.navigator,
    });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      writable: true,
      value: true,
    });
    endSessionMock.mockReset();
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("does not render PR controls in the composer action row for active sessions with a PR", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            ToastProvider,
            null,
            createElement(ConfirmProvider, null, createElement(SessionDetailView, { sessionId: "s-1" })),
          ),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const actions = container.querySelector("[data-testid='prompt-form-leading-actions']");

    expect(actions).toBeTruthy();
    expect(actions?.textContent).toBe("");
    expect(container.textContent).not.toContain("PR is open. End the session");
    expect(container.textContent).not.toContain("Draft PR is open. End the session");
    expect(endSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});

describe("getCanonicalSessionStatus", () => {
  it("shows needs-you for blocked sessions", () => {
    expect(getCanonicalSessionStatus({ ...baseSession, phase: "blocked" })).toMatchObject({
      label: "Needs you",
      tone: "warning",
    });
  });

  it("shows failed for failed sessions", () => {
    expect(getCanonicalSessionStatus({ ...baseSession, phase: "failed" })).toMatchObject({
      label: "Failed",
      tone: "error",
    });
  });

  it("shows completed for completed sessions without a PR", () => {
    expect(getCanonicalSessionStatus({ ...baseSession, phase: "completed", prUrl: null })).toMatchObject({
      label: "Completed",
      tone: "success",
    });
  });
});
