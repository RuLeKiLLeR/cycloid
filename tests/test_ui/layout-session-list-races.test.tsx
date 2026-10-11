import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthProbeResult } from "../../apps/ui/src/api/auth-probe";
import { clearApiCache } from "../../apps/ui/src/api/cache";
import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { Layout, useLayoutContext } from "../../apps/ui/src/components/Layout";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import type { SessionMetadata, User, UserSettings } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

function renderWithProviders(root: Root, tree: ReactNode) {
  root.render(createElement(ConfirmProvider, null, createElement(ToastProvider, null, tree)));
}

const DEFAULT_BOOTSTRAP = {
  authenticated: true as const,
  user: {
    id: 1,
    login: "race-user",
    name: "Race User",
    email: "race@example.com",
    avatarUrl: "https://example.com/avatar.png",
    businessId: "biz-1",
    businessRole: "admin" as const,
    sharedSessions: false,
    linearConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
  },
  capabilities: {
    canAccessIntegrationDebug: true,
    canManageBusinessIntegrations: true,
    canManageCliTokens: true,
    canUseBusinessSessions: false,
    canAdminPendingSignups: false,
  },
  models: [] as Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string; label: string }>;
    hasApiKey?: boolean;
  }>,
  repos: [] as Array<{ fullName: string; url: string; private: boolean; defaultBranch: string }>,
  settings: {
    theme: "dark" as const,
    prReviewAutoResponseEnabled: true,
    defaultPrDraft: false,
    autoVerifyEnabled: true,
    automaticReviewsEnabled: false,
    useCodexSubscription: false,
    defaultModel: null as string | null,
    defaultRepo: null as string | null,
    apiKeys: {},
  },
  warnings: [] as string[],
};

const apiMocks = vi.hoisted(() => ({
  fetchBootstrap: vi.fn(async () => DEFAULT_BOOTSTRAP),
  fetchSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
  fetchSettings: vi.fn(
    async () =>
      ({
        theme: "dark",
        prReviewAutoResponseEnabled: true,
        defaultPrDraft: false,
        autoVerifyEnabled: true,
        automaticReviewsEnabled: false,
        useCodexSubscription: false,
        defaultModel: null,
        defaultRepo: null,
      }) satisfies UserSettings,
  ),
  fetchUser: vi.fn(async () => ({ status: "unauthenticated" as const })),
  fetchSessionFiles: vi.fn(async () => []),
  archiveSession: vi.fn(async () => ({ ok: true, archived: true })),
  createSession: vi.fn(async () => "sess-created"),
  createSessionAndSend: vi.fn(async () => ({ sessionId: "sess-created" })),
  logoutUser: vi.fn(async () => undefined),
  sendPrompt: vi.fn(async () => "prompt-1"),
  submitMemoryFeedback: vi.fn(async () => {
    throw new Error("submitMemoryFeedback mock should not be called");
  }),
  warmSandbox: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/sessions.ts", () => ({
  archiveSession: apiMocks.archiveSession,
  createSession: apiMocks.createSession,
  createSessionAndSend: apiMocks.createSessionAndSend,
  fetchSessionFiles: apiMocks.fetchSessionFiles,
  fetchSessions: apiMocks.fetchSessions,
  getSessionFeedWsUrl: () => "wss://test/api/users/me/feed/ws",
  sendPrompt: apiMocks.sendPrompt,
  submitMemoryFeedback: apiMocks.submitMemoryFeedback,
  warmSandbox: apiMocks.warmSandbox,
}));

vi.mock("../../apps/ui/src/api/bootstrap.ts", () => ({
  fetchBootstrap: apiMocks.fetchBootstrap,
}));

vi.mock("../../apps/ui/src/api/auth.ts", () => ({
  fetchUser: apiMocks.fetchUser,
  logoutUser: apiMocks.logoutUser,
}));

vi.mock("../../apps/ui/src/api/repos.ts", () => ({
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchRepos: vi.fn(async () => ({ repos: [], ssoOrgs: [] })),
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchSettings: apiMocks.fetchSettings,
}));

vi.mock("../../apps/ui/src/datadog.ts", () => ({
  addSessionTiming: vi.fn(),
  setDatadogUser: vi.fn(),
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  clearSentryUser: vi.fn(),
  setSentryUser: vi.fn(),
}));

type MatchMediaListener = (event: MediaQueryListEvent) => void;

class MockMediaQueryList {
  readonly listeners = new Set<MatchMediaListener>();

  constructor(
    public media: string,
    public matches: boolean,
  ) {}

  addEventListener(eventName: string, listener: MatchMediaListener) {
    if (eventName === "change") this.listeners.add(listener);
  }

  removeEventListener(eventName: string, listener: MatchMediaListener) {
    if (eventName === "change") this.listeners.delete(listener);
  }

  dispatch(matches: boolean) {
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}

function evaluateQuery(query: string, width: number) {
  const maxWidth = query.match(/max-width:\s*(\d+)px/);
  if (maxWidth) return width <= Number(maxWidth[1]);
  throw new Error(`Unsupported media query in test: ${query}`);
}

function createMatchMediaHarness() {
  const registry = new Map<string, MockMediaQueryList>();

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => {
      const existing = registry.get(query);
      if (existing) return existing;
      const created = new MockMediaQueryList(query, evaluateQuery(query, window.innerWidth));
      registry.set(query, created);
      return created;
    }),
  });

  return {
    setViewportWidth(width: number) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
      });
      for (const mql of registry.values()) {
        const next = evaluateQuery(mql.media, width);
        if (next !== mql.matches) mql.dispatch(next);
      }
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: T | null | undefined;
  while (Date.now() < deadline) {
    await act(async () => {
      await flushAsyncWork();
    });
    lastResult = predicate();
    if (lastResult) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for predicate to return a truthy value`);
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function findButtonByText(container: Element, text: string) {
  return (
    Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text) ?? null
  );
}

async function expandSidebarIfCollapsed(container: Element) {
  const expand = container.querySelector('button[aria-label="Expand navigation"]');
  if (!expand) return;
  await act(async () => {
    click(expand);
    await flushAsyncWork();
  });
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

function makeSessionMetadata(
  session: Omit<SessionMetadata, "displayStatus"> & Partial<Pick<SessionMetadata, "displayStatus">>,
): SessionMetadata {
  return {
    ...session,
    displayStatus: session.displayStatus ?? displayStatusFromPhase(session.phase),
  };
}

const MOCK_USER: User = {
  id: 1,
  login: "race-user",
  name: "Race User",
  email: "race@example.com",
  avatarUrl: "https://example.com/avatar.png",
  businessId: "biz-1",
  businessRole: "admin",
  sharedSessions: false,
  linearConnected: false,
  slackConnected: false,
  slackNeedsReconnect: false,
};

function authenticatedUser(user: User = MOCK_USER): AuthProbeResult<User> {
  return { status: "authenticated", value: user };
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

async function renderWithRoot(render: (root: Root) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    render(root);
    await flushAsyncWork();
    await flushAsyncWork();
  });

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

describe("Layout session list race handling", () => {
  beforeEach(() => {
    const happyWindow = new Window({ url: "https://app.test/" });
    installDomGlobals(happyWindow);
    createMatchMediaHarness().setViewportWidth(1024);
    clearApiCache();

    apiMocks.fetchUser.mockResolvedValue(authenticatedUser());
    apiMocks.fetchBootstrap.mockResolvedValue(DEFAULT_BOOTSTRAP);
  });

  afterEach(() => {
    clearApiCache();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("preserves a live-patched open row when a stale refetch resolves later", async () => {
    const initialSession: SessionMetadata = makeSessionMetadata({
      sessionId: "sess-1",
      phase: "idle",
      prUrl: null,
      createdAt: Date.now(),
      model: null,
      title: "Open session",
    });
    const staleSnapshot: SessionMetadata = {
      ...initialSession,
      prDraft: false,
    };
    const refreshDeferred = deferred<{ sessions: SessionMetadata[]; nextCursor: string | null }>();
    apiMocks.fetchSessions.mockReset().mockResolvedValueOnce({ sessions: [initialSession], nextCursor: null });
    apiMocks.fetchSessions.mockReturnValueOnce(refreshDeferred.promise);

    function Harness() {
      const { refreshSessions, setSessions } = useLayoutContext();
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => void refreshSessions() }, "Refresh sessions"),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              const patchedAt = Date.now();
              setSessions((prev) =>
                prev.map((session) =>
                  session.sessionId === "sess-1"
                    ? {
                        ...session,
                        phase: "stopped",
                        // The redesigned sidebar row renders the title (not a PR
                        // draft/status label), so patch the title to give the
                        // race a rendered, observable signal. `title` rides the
                        // lastLiveStatusPatchAt marker, so this exercises the
                        // same stale-clobber guard the old prDraft field did.
                        title: "Live patched session",
                        displayStatus: displayStatusFromPhase("stopped"),
                        prUrl: "https://github.com/acme/repo/pull/1",
                        prDraft: true,
                        lastLiveStatusPatchAt: patchedAt,
                        lastLivePrPatchAt: patchedAt,
                      }
                    : session,
                ),
              );
            },
          },
          "Apply live patch",
        ),
      );
    }

    const rendered = await renderWithRoot((root) => {
      renderWithProviders(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement(Harness) }),
            ),
          ),
        ),
      );
    });

    await expandSidebarIfCollapsed(rendered.container);

    try {
      vi.useFakeTimers();
      vi.setSystemTime(initialSession.createdAt);

      await act(async () => {
        click(findButtonByText(rendered.container, "Refresh sessions"));
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.advanceTimersByTimeAsync(1);
      await act(async () => {
        click(findButtonByText(rendered.container, "Apply live patch"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(rendered.container.textContent).toContain("Live patched session");

      await act(async () => {
        refreshDeferred.resolve({ sessions: [staleSnapshot], nextCursor: null });
        await Promise.resolve();
        await Promise.resolve();
      });

      // The stale refetch carries the pre-patch title ("Open session"); the
      // live-patched title must survive because its patch marker is newer than
      // the poll's issue time.
      expect(rendered.container.textContent).toContain("Live patched session");
      expect(rendered.container.textContent).not.toContain("Open session");
    } finally {
      vi.useRealTimers();
      await rendered.unmount();
    }
  });

  it("ignores an older same-scope refetch that resolves after a newer one", async () => {
    const initialSession: SessionMetadata = makeSessionMetadata({
      sessionId: "sess-1",
      phase: "idle",
      prUrl: null,
      createdAt: Date.now(),
      model: null,
      title: "Initial session",
    });
    const newerSnapshot: SessionMetadata = {
      ...initialSession,
      title: "Newer session",
    };
    const olderSnapshot: SessionMetadata = {
      ...initialSession,
      title: "Older session",
    };
    const firstRefresh = deferred<{ sessions: SessionMetadata[]; nextCursor: string | null }>();
    const secondRefresh = deferred<{ sessions: SessionMetadata[]; nextCursor: string | null }>();
    apiMocks.fetchSessions.mockReset().mockResolvedValueOnce({ sessions: [initialSession], nextCursor: null });
    apiMocks.fetchSessions.mockReturnValueOnce(firstRefresh.promise);
    apiMocks.fetchSessions.mockReturnValueOnce(secondRefresh.promise);

    function Harness() {
      const { refreshSessions } = useLayoutContext();
      return createElement("button", { type: "button", onClick: () => void refreshSessions() }, "Refresh sessions");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithProviders(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement(Harness) }),
            ),
          ),
        ),
      );
    });

    await expandSidebarIfCollapsed(rendered.container);

    await act(async () => {
      click(findButtonByText(rendered.container, "Refresh sessions"));
      click(findButtonByText(rendered.container, "Refresh sessions"));
      await flushAsyncWork();
    });

    await act(async () => {
      secondRefresh.resolve({ sessions: [newerSnapshot], nextCursor: null });
      await flushAsyncWork();
    });
    await waitFor(() => (rendered.container.textContent?.includes("Newer session") ? rendered.container : null));

    await act(async () => {
      firstRefresh.resolve({ sessions: [olderSnapshot], nextCursor: null });
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("Newer session");
    expect(rendered.container.textContent).not.toContain("Older session");

    await rendered.unmount();
  });

  it("applies a same-scope SWR revalidation after a later refresh bumps the request id", async () => {
    const initialSession: SessionMetadata = makeSessionMetadata({
      sessionId: "sess-1",
      phase: "idle",
      prUrl: null,
      createdAt: Date.now(),
      model: null,
      title: "Initial session",
    });
    const staleSnapshot: SessionMetadata = {
      ...initialSession,
      title: "Cached stale session",
    };
    const freshSnapshot: SessionMetadata = {
      ...initialSession,
      title: "Fresh revalidated session",
    };
    let revalidate: ((value: { sessions: SessionMetadata[]; nextCursor: string | null }) => void) | undefined;
    apiMocks.fetchSessions.mockReset().mockResolvedValueOnce({ sessions: [initialSession], nextCursor: null });
    apiMocks.fetchSessions.mockImplementationOnce(
      async (options?: {
        onRevalidate?: (value: { sessions: SessionMetadata[]; nextCursor: string | null }) => void;
      }) => {
        revalidate = options?.onRevalidate;
        return { sessions: [staleSnapshot], nextCursor: null };
      },
    );
    apiMocks.fetchSessions.mockResolvedValueOnce({ sessions: [staleSnapshot], nextCursor: null });

    function Harness() {
      const { refreshSessions } = useLayoutContext();
      return createElement("button", { type: "button", onClick: () => void refreshSessions() }, "Refresh sessions");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithProviders(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement(Harness) }),
            ),
          ),
        ),
      );
    });

    await expandSidebarIfCollapsed(rendered.container);

    await act(async () => {
      click(findButtonByText(rendered.container, "Refresh sessions"));
      await flushAsyncWork();
    });
    expect(rendered.container.textContent).toContain("Cached stale session");

    await act(async () => {
      click(findButtonByText(rendered.container, "Refresh sessions"));
      await flushAsyncWork();
    });

    await act(async () => {
      revalidate?.({ sessions: [freshSnapshot], nextCursor: null });
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("Fresh revalidated session");

    await rendered.unmount();
  });
});
