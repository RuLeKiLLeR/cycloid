import { Window } from "happy-dom";
import { act, createElement, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthProbeResult } from "../../apps/ui/src/api/auth-probe";
import { clearApiCache } from "../../apps/ui/src/api/cache";
import { HOME_SNAPSHOT_KEY_PREFIX, readHomeSnapshot, writeHomeSnapshot } from "../../apps/ui/src/api/home-snapshot";
import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { Layout, useLayoutContext } from "../../apps/ui/src/components/Layout";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_KEY } from "../../apps/ui/src/constants";
import { useMobile } from "../../apps/ui/src/hooks/useMobile";
import type { Repo, SessionMetadata, User, UserSettings } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

// Layout reads useConfirm() and useToast() during render, so every render must
// sit under both providers. Wrap each tree here instead of repeating the
// providers at every call site.
function renderWithConfirm(root: Root, tree: ReactNode) {
  root.render(createElement(ConfirmProvider, null, createElement(ToastProvider, null, tree)));
}

const DEFAULT_BOOTSTRAP = {
  authenticated: true as const,
  user: {
    id: 1,
    login: "mobile-user",
    name: "Mobile User",
    email: "mobile@example.com",
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
    canStartSupportView: false,
    canUseInternalModelProviderKeys: false,
    computerUse: false,
    canUseControlRoom: false,
    planApproval: false,
  },
  models: [] as Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string; label: string }>;
    hasApiKey?: boolean;
  }>,
  repos: [] as Repo[],
  reposPending: false,
  ssoOrgs: [],
  settings: {
    theme: "dark" as const,
    prReviewAutoResponseEnabled: true,
    defaultPrDraft: false,
    autoVerifyEnabled: true,
    automaticReviewsEnabled: false,
    planMode: "off",
    useCodexSubscription: false,
    defaultModel: null as string | null,
    defaultRepo: null as string | null,
    apiKeys: {},
  },
  warnings: [] as string[],
};

const apiMocks = vi.hoisted(() => ({
  archiveSession: vi.fn(async () => undefined),
  createSession: vi.fn(async () => "sess-created"),
  createSessionAndSend: vi.fn(async () => ({ sessionId: "sess-created" })),
  fetchBootstrap: vi.fn(async () => DEFAULT_BOOTSTRAP),
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchRepos: vi.fn(async () => ({ repos: [], ssoOrgs: [] })),
  fetchSessionFiles: vi.fn(async () => []),
  fetchSessionTitle: vi.fn(async () => null),
  fetchSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
  fetchSettings: vi.fn(
    async () =>
      ({
        theme: "dark",
        prReviewAutoResponseEnabled: true,
        defaultPrDraft: false,
        autoVerifyEnabled: true,
        automaticReviewsEnabled: false,
        planMode: "off",
        useCodexSubscription: false,
        defaultModel: null,
        defaultRepo: null,
      }) satisfies UserSettings,
  ),
  fetchUser: vi.fn(async () => ({ status: "unauthenticated" as const })),
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
  fetchSessionTitle: apiMocks.fetchSessionTitle,
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
  fetchInstallUrl: apiMocks.fetchInstallUrl,
  fetchRepos: apiMocks.fetchRepos,
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

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(public readonly name: string) {
    const peers = MockBroadcastChannel.channels.get(name) ?? new Set<MockBroadcastChannel>();
    peers.add(this);
    MockBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown) {
    for (const peer of MockBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      peer.onmessage?.({ data: message } as MessageEvent<unknown>);
    }
  }

  close() {
    const peers = MockBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    peers.delete(this);
    if (peers.size === 0) MockBroadcastChannel.channels.delete(this.name);
  }

  static reset() {
    MockBroadcastChannel.channels.clear();
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
    get(query: string) {
      const mql = registry.get(query);
      if (!mql) throw new Error(`Missing media query registration: ${query}`);
      return mql;
    },
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
  // Deadline is test-harness settling slack (React act/flush under load), not a product-latency assertion.
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

function dispatchStorageEvent(key: string, newValue: string | null) {
  window.dispatchEvent(
    new happyWindow.StorageEvent("storage", {
      key,
      newValue,
      storageArea: localStorage,
    }),
  );
}

const MOCK_USER: User = {
  id: 1,
  login: "mobile-user",
  name: "Mobile User",
  email: "mobile@example.com",
  avatarUrl: "https://example.com/avatar.png",
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

function authenticatedUser(user: User = MOCK_USER): AuthProbeResult<User> {
  return { status: "authenticated", value: user };
}

function unauthenticatedUser(): AuthProbeResult<User> {
  return { status: "unauthenticated" };
}

function makeSessionMetadata(
  session: Omit<SessionMetadata, "displayStatus"> & Partial<Pick<SessionMetadata, "displayStatus">>,
): SessionMetadata {
  return {
    ...session,
    displayStatus: session.displayStatus ?? displayStatusFromPhase(session.phase),
  };
}

const MOCK_SESSIONS: SessionMetadata[] = [
  makeSessionMetadata({
    sessionId: "sess-1",
    phase: "idle",
    prUrl: null,
    createdAt: Date.now(),
    model: null,
    title: "Mobile session",
  }),
];

const MOCK_REPO: Repo = {
  fullName: "test/mobile-repo",
  url: "https://github.com/test/mobile-repo",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const SNAPSHOT_REPO: Repo = {
  fullName: "test/snapshot-repo",
  url: "https://github.com/test/snapshot-repo",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const AUTH_HINT_KEY = "layout.authenticated_hint";

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
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    StorageEvent: windowInstance.StorageEvent,
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

async function renderWithRoot(render: (root: Root, container: HTMLDivElement) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    render(root, container);
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

describe("useMobile", () => {
  let mediaHarness: ReturnType<typeof createMatchMediaHarness>;

  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/" });
    installDomGlobals(happyWindow);
    mediaHarness = createMatchMediaHarness();
    mediaHarness.setViewportWidth(1024);
  });

  it("tracks the current breakpoint match and updates on viewport changes", async () => {
    let currentValue = false;

    const rendered = await renderWithRoot((root) => {
      function TestHook() {
        currentValue = useMobile();
        return null;
      }

      renderWithConfirm(root, createElement(TestHook));
    });

    expect(currentValue).toBe(false);

    await act(async () => {
      mediaHarness.setViewportWidth(600);
      await flushAsyncWork();
    });
    expect(currentValue).toBe(true);

    await act(async () => {
      mediaHarness.setViewportWidth(900);
      await flushAsyncWork();
    });
    expect(currentValue).toBe(false);

    await rendered.unmount();
  });

  it("removes the matchMedia listener on unmount", async () => {
    const rendered = await renderWithRoot((root) => {
      function TestHook() {
        useMobile();
        return null;
      }

      renderWithConfirm(root, createElement(TestHook));
    });

    const mediaQuery = mediaHarness.get("(max-width: 767px)");
    expect(mediaQuery.listeners.size).toBe(1);

    await rendered.unmount();

    expect(mediaQuery.listeners.size).toBe(0);
  });
});

describe("Layout mobile drawer", () => {
  let mediaHarness: ReturnType<typeof createMatchMediaHarness>;

  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/" });
    installDomGlobals(happyWindow);
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: MockBroadcastChannel,
    });
    mediaHarness = createMatchMediaHarness();
    mediaHarness.setViewportWidth(390);
    clearApiCache();
    MockBroadcastChannel.reset();

    apiMocks.fetchUser.mockResolvedValue(authenticatedUser());
    apiMocks.fetchSessions.mockResolvedValue({ sessions: MOCK_SESSIONS, nextCursor: null });
    apiMocks.fetchBootstrap.mockResolvedValue(DEFAULT_BOOTSTRAP);
  });

  afterEach(() => {
    clearApiCache();
    vi.useRealTimers();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, "confirm");
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    MockBroadcastChannel.reset();
  });

  it("opens, scroll-locks, and closes the mobile sidebar drawer", async () => {
    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
              createElement(Route, { path: "settings/:tab", element: createElement("div", null, "settings page") }),
            ),
          ),
        ),
      );
    });

    const toggleButton = rendered.container.querySelector('button[aria-label="Toggle navigation"]');
    expect(toggleButton).not.toBeNull();
    expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      click(toggleButton);
      await flushAsyncWork();
    });

    expect(rendered.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    const backdrop = rendered.container.querySelector('button[aria-hidden="true"]');
    await act(async () => {
      click(backdrop);
      await flushAsyncWork();
    });

    expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");

    await act(async () => {
      click(toggleButton);
      await flushAsyncWork();
    });

    // Poll for the session link instead of a fixed number of flushAsyncWork
    // calls. The startup chain (fetchUser → dynamic imports →
    // Promise.allSettled → setSessionsLoaded) needs an indeterminate number
    // of microtask ticks that varies with CI scheduling.
    const sessionLink = await waitFor(() => rendered.container.querySelector('a[href="/sessions/sess-1"]'));

    await act(async () => {
      click(sessionLink);
      await flushAsyncWork();
    });

    expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(rendered.container.textContent).toContain("session page");

    await rendered.unmount();
  });

  it("keeps the desktop nav rail free of user identity chrome", async () => {
    mediaHarness.setViewportWidth(1024);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    // The overhaul dropped the desktop top header; the persistent nav surface is
    // the sidebar. Identity chrome (avatar/account/sign-out) lives only in the
    // sidebar footer, never in the primary product-nav region above it.
    expect(rendered.container.querySelector("header")).toBeNull();
    const nav = await waitFor(() =>
      rendered.container.querySelector('aside[aria-label="Session navigation"] nav[aria-label="Product navigation"]'),
    );
    expect(nav.textContent).not.toContain(`@${MOCK_USER.login}`);
    expect(nav.textContent).not.toContain("Sign out");
    expect(nav.querySelector(`img[src="${MOCK_USER.avatarUrl}"]`)).toBeNull();

    await rendered.unmount();
  });

  it("does not render an evals link in the nav rail", async () => {
    mediaHarness.setViewportWidth(1024);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    const sidebar = await waitFor(() => rendered.container.querySelector('aside[aria-label="Session navigation"]'));
    expect(sidebar.querySelector('a[href="/evals"]')).toBeNull();
    expect(sidebar.textContent).not.toContain("Evals");

    await rendered.unmount();
  });

  it("hides control-room nav items when canUseControlRoom is false", async () => {
    mediaHarness.setViewportWidth(1024);
    // DEFAULT_BOOTSTRAP has canUseControlRoom: false.

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    const nav = await waitFor(() => rendered.container.querySelector('nav[aria-label="Product navigation"]'));
    // Non-gated items stay; the control-room links are hidden.
    expect(nav.querySelector('a[href="/automations"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/prs"]')).toBeNull();
    expect(nav.querySelector('a[href="/context"]')).toBeNull();

    await rendered.unmount();
  });

  it("shows control-room nav items when canUseControlRoom is true", async () => {
    mediaHarness.setViewportWidth(1024);
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      capabilities: { ...DEFAULT_BOOTSTRAP.capabilities, canUseControlRoom: true },
    });

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    const nav = await waitFor(() => rendered.container.querySelector('nav[aria-label="Product navigation"]'));
    await waitFor(() => expect(nav.querySelector('a[href="/prs"]')).not.toBeNull());
    expect(nav.querySelector('a[href="/context"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/automations"]')).not.toBeNull();

    await rendered.unmount();
  });

  it("renders the new task CTA as the primary white-ink action", async () => {
    mediaHarness.setViewportWidth(1024);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    await expandSidebarIfCollapsed(rendered.container);
    // Monochrome Control: the new-task CTA is the sidebar's one primary action —
    // white ink (`bg-accent` / `text-text-inverse`), 0 radius. Off the session
    // route it renders as that primary button, not a rounded pill.
    const newTaskLink = await waitFor(() => {
      const link = Array.from(
        rendered.container.querySelectorAll<HTMLAnchorElement>('aside[aria-label="Session navigation"] a[href="/"]'),
      ).find((anchor) => anchor.textContent?.includes("New task"));
      return link ?? null;
    });
    expect(newTaskLink.className).toContain("bg-accent");
    expect(newTaskLink.className).toContain("text-text-inverse");
    expect(newTaskLink.className).not.toMatch(/rounded-(full|\[)/);

    await rendered.unmount();
  });

  it("does not render a bulk clear archived sessions action", async () => {
    mediaHarness.setViewportWidth(1024);
    const archivedSession: SessionMetadata = {
      sessionId: "sess-archived",
      phase: "archived",
      prUrl: null,
      createdAt: Date.now(),
      model: null,
      title: "Archived session",
    };
    apiMocks.fetchSessions.mockReset().mockResolvedValueOnce({ sessions: [archivedSession], nextCursor: null });

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    await expandSidebarIfCollapsed(rendered.container);
    await waitFor(() => (rendered.container.textContent?.includes("Archived session") ? true : null));

    expect(rendered.container.textContent).not.toContain("Clear archived");

    await rendered.unmount();
  });

  it("keeps the selected session route open after archiving it", async () => {
    mediaHarness.setViewportWidth(1024);

    function SessionPage() {
      const { id } = useParams();
      return createElement("div", null, `session page ${id}`);
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home-route-sentinel") }),
              createElement(Route, { path: "sessions/:id", element: createElement(SessionPage) }),
            ),
          ),
        ),
      );
    });

    const archiveButton = await waitFor(() =>
      rendered.container.querySelector('button[aria-label="Archive Mobile session"]'),
    );

    await act(async () => {
      click(archiveButton);
      await flushAsyncWork();
    });
    const confirmButton = await waitFor(() => findButtonByText(rendered.container, "Archive session"));
    await act(async () => {
      click(confirmButton);
      await flushAsyncWork();
    });

    await waitFor(() => expect(apiMocks.archiveSession).toHaveBeenCalledTimes(1));
    expect(apiMocks.archiveSession).toHaveBeenCalledWith("sess-1", { closePr: false });
    expect(rendered.container.textContent).toContain("session page sess-1");
    // The /sessions/:id route stays mounted even after the row is optimistically
    // removed from the sidebar; the index "/" home route must not.
    expect(rendered.container.textContent).not.toContain("home-route-sentinel");

    await rendered.unmount();
  });

  it("requires confirmation before archiving an active session", async () => {
    mediaHarness.setViewportWidth(1024);
    apiMocks.fetchSessions.mockResolvedValueOnce({
      sessions: [
        makeSessionMetadata({
          sessionId: "sess-active",
          phase: "running",
          prUrl: null,
          createdAt: Date.now(),
          model: null,
          title: "Active session",
        }),
      ],
      nextCursor: null,
    });

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-active"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    const archiveButton = await waitFor(() =>
      rendered.container.querySelector('button[aria-label="Archive Active session"]'),
    );

    await act(async () => {
      click(archiveButton);
      await flushAsyncWork();
    });

    expect(apiMocks.archiveSession).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Archive active session?");
    expect(rendered.container.querySelector('a[href="/sessions/sess-active"]')).not.toBeNull();

    const confirmButton = await waitFor(() => findButtonByText(rendered.container, "Archive session"));
    await act(async () => {
      click(confirmButton);
      await flushAsyncWork();
    });

    await waitFor(() => expect(apiMocks.archiveSession).toHaveBeenCalledTimes(1));
    expect(apiMocks.archiveSession).toHaveBeenCalledWith("sess-active", { closePr: false });

    await rendered.unmount();
  });

  it("batches sidebar resize updates through requestAnimationFrame", async () => {
    mediaHarness.setViewportWidth(1024);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    // The resize handle is the only element with cursor-col-resize.
    const handle = await waitFor(() => rendered.container.querySelector(".cursor-col-resize"));
    expect(handle).not.toBeNull();

    // Swap RAF only AFTER initial mount so React's startup work used the real
    // implementation. The drag handlers look up requestAnimationFrame at call
    // time, so swapping it now still intercepts every mousemove.
    const rafCallbacks: Array<FrameRequestCallback> = [];
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    let rafCalls = 0;
    let cancelCalls = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCalls += 1;
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {
      cancelCalls += 1;
    }) as typeof cancelAnimationFrame;

    try {
      // Start drag
      await act(async () => {
        handle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
        await flushAsyncWork();
      });

      // Multiple mousemoves within one frame should coalesce into a single RAF.
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 320 }));
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 340 }));
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 360 }));
        await flushAsyncWork();
      });

      // Exactly one RAF scheduled for three mousemoves.
      expect(rafCalls).toBe(1);

      // Flush the RAF and confirm width updated to the latest pending value.
      await act(async () => {
        const cb = rafCallbacks.shift();
        cb?.(performance.now());
        await flushAsyncWork();
      });

      // mouseup persists the final width.
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 360 }));
        await flushAsyncWork();
      });

      expect(globalThis.localStorage.getItem("cycloid-sidebar-width")).not.toBeNull();

      // Another move after mouseup should NOT schedule a frame (drag is over).
      const rafCallsBeforeIdleMove = rafCalls;
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 380 }));
        await flushAsyncWork();
      });
      expect(rafCalls).toBe(rafCallsBeforeIdleMove);

      // cancelAnimationFrame path is wired (used when mouseup races with an
      // in-flight frame, or when the resize effect unmounts mid-drag).
      expect(cancelCalls).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }

    await rendered.unmount();
  });

  it("refreshes the session list when another tab broadcasts a sync message", async () => {
    mediaHarness.setViewportWidth(1024);
    apiMocks.fetchSessions.mockResolvedValueOnce({ sessions: MOCK_SESSIONS, nextCursor: null }).mockResolvedValueOnce({
      sessions: [{ ...MOCK_SESSIONS[0], title: "Synced session", phase: "running" }],
      nextCursor: null,
    });

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    await waitFor(() =>
      rendered.container.querySelector('a[href="/sessions/sess-1"]')?.textContent?.includes("Mobile session"),
    );
    const initialFetchCalls = apiMocks.fetchSessions.mock.calls.length;
    const remoteTabChannel = new MockBroadcastChannel("cycloid-sessions");

    await act(async () => {
      remoteTabChannel.postMessage({ type: "refresh-sessions" });
      await flushAsyncWork();
    });

    await waitFor(() => apiMocks.fetchSessions.mock.calls.length > initialFetchCalls);
    expect(apiMocks.fetchSessions.mock.calls.at(-1)?.[0]).toMatchObject({ force: true });
    await waitFor(() =>
      rendered.container.querySelector('a[href="/sessions/sess-1"]')?.textContent?.includes("Synced session"),
    );

    remoteTabChannel.close();
    await rendered.unmount();
  });

  it("applies sidebar preferences from storage events", async () => {
    mediaHarness.setViewportWidth(1024);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "320");
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      settings: { ...DEFAULT_BOOTSTRAP.settings },
    });

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => rendered.container.querySelector('aside[aria-label="Session navigation"]'));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(rendered.container.querySelector('aside[aria-label="Session navigation"]')?.getAttribute("style")).toContain(
      "width: 320px",
    );

    localStorage.setItem(SIDEBAR_WIDTH_KEY, "480");
    await act(async () => {
      dispatchStorageEvent(SIDEBAR_WIDTH_KEY, "480");
      await flushAsyncWork();
    });
    await waitFor(() =>
      rendered.container
        .querySelector('aside[aria-label="Session navigation"]')
        ?.getAttribute("style")
        ?.includes("width: 480px"),
    );

    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    await act(async () => {
      dispatchStorageEvent(SIDEBAR_COLLAPSED_KEY, "1");
      await flushAsyncWork();
    });
    // Collapsing minimizes to the icon rail rather than removing the sidebar.
    await waitFor(() => rendered.container.querySelector('button[aria-label="Expand navigation"]'));
    const rail = rendered.container.querySelector('aside[aria-label="Session navigation"]');
    expect(rail?.getAttribute("data-testid")).toBe("sidebar-rail");
    expect(rail?.getAttribute("style")).toContain("width: 52px");

    await rendered.unmount();
  });

  it("rolls back an optimistically archived session when the request fails", async () => {
    mediaHarness.setViewportWidth(1024);
    apiMocks.archiveSession.mockReset().mockRejectedValueOnce(new Error("nope"));

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    const archiveButton = await waitFor(() =>
      rendered.container.querySelector('button[aria-label="Archive Mobile session"]'),
    );
    await act(async () => {
      click(archiveButton);
      await flushAsyncWork();
    });
    const confirmButton = await waitFor(() => findButtonByText(rendered.container, "Archive session"));
    await act(async () => {
      click(confirmButton);
      await flushAsyncWork();
    });

    // Row is restored after the network failure since scope/filter/auth still match.
    await waitFor(() => rendered.container.querySelector('a[href="/sessions/sess-1"]'));
    expect(rendered.container.querySelector('a[href="/sessions/sess-1"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain("Could not archive session");

    await rendered.unmount();
  });

  it("keeps the home page file loader stable across layout re-renders", async () => {
    const seenLoaders: Array<() => Promise<string[]>> = [];
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      repos: [MOCK_REPO],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultRepo: MOCK_REPO.fullName },
    });

    function HomeHarness() {
      const { loadFilesForHomePage } = useLayoutContext();
      useEffect(() => {
        seenLoaders.push(loadFilesForHomePage);
      }, [loadFilesForHomePage]);
      return createElement("div", null, "home page");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(seenLoaders.length).toBeGreaterThan(1);
    expect(new Set(seenLoaders).size).toBe(1);

    await rendered.unmount();
  });

  it("ignores stale bootstrap data that resolves after logout", async () => {
    mediaHarness.setViewportWidth(480);
    const pendingBootstrap = deferred<typeof DEFAULT_BOOTSTRAP>();
    const pendingSessions = deferred<{ sessions: SessionMetadata[]; nextCursor: string | null }>();
    apiMocks.fetchBootstrap.mockReturnValueOnce(pendingBootstrap.promise);
    apiMocks.fetchSessions.mockReturnValueOnce(pendingSessions.promise);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    const navButton = await waitFor(() => rendered.container.querySelector('button[aria-label="Toggle navigation"]'));
    await act(async () => {
      click(navButton);
      await flushAsyncWork();
    });
    const logoutButton = await waitFor(
      () =>
        Array.from(rendered.container.querySelectorAll("button")).find(
          (element) => element.textContent?.trim() === "Sign out",
        ) ?? null,
    );

    await act(async () => {
      click(logoutButton);
      await flushAsyncWork();
    });

    pendingSessions.resolve({ sessions: MOCK_SESSIONS, nextCursor: null });
    pendingBootstrap.resolve(DEFAULT_BOOTSTRAP);

    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.logoutUser).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector("header")).toBeNull();
    expect(rendered.container.textContent).not.toContain(MOCK_USER.login);

    await rendered.unmount();
  });

  it("selects a saved bare default model from settings", async () => {
    let observedModel: ReturnType<typeof useLayoutContext>["selectedModel"] = null;
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      models: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", label: "OpenAI / GPT-5.4 Mini" },
            { id: "gpt-5.4", name: "GPT-5.4", label: "OpenAI / GPT-5.4" },
          ],
        },
      ],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultModel: "gpt-5.4" },
    });

    function HomeHarness() {
      const { selectedModel } = useLayoutContext();
      useEffect(() => {
        observedModel = selectedModel;
      }, [selectedModel]);
      return createElement("div", null, "home page");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observedModel?.modelID === "gpt-5.4" ? observedModel : null));
    expect(observedModel).toEqual({ providerID: "openai", modelID: "gpt-5.4" });

    await rendered.unmount();
  });

  it("auto-selects the first usable launch model when no saved default exists", async () => {
    let observedModel: ReturnType<typeof useLayoutContext>["selectedModel"] = null;
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      models: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            { id: "gpt-5.5", name: "GPT-5.5", label: "OpenAI / GPT-5.5" },
            { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", label: "OpenAI / GPT-5.4 Mini" },
          ],
        },
      ],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultModel: null },
    });

    function HomeHarness() {
      const { selectedModel } = useLayoutContext();
      useEffect(() => {
        observedModel = selectedModel;
      }, [selectedModel]);
      return createElement("div", null, "home page");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observedModel?.modelID === "gpt-5.5" ? observedModel : null));
    expect(observedModel).toEqual({ providerID: "openai", modelID: "gpt-5.5" });

    await rendered.unmount();
  });

  it("navigates to a new session before the background session refresh resolves", async () => {
    const backgroundRefresh = deferred<{ sessions: SessionMetadata[]; nextCursor: string | null }>();
    mediaHarness.setViewportWidth(1024);
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      repos: [MOCK_REPO],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultRepo: MOCK_REPO.fullName },
    });
    apiMocks.fetchSessions
      .mockResolvedValueOnce({ sessions: MOCK_SESSIONS, nextCursor: null })
      .mockReturnValueOnce(backgroundRefresh.promise);
    apiMocks.createSessionAndSend.mockResolvedValueOnce({ sessionId: "sess-new", promptId: "prompt-1" });

    function HomeHarness() {
      const { handleNewSessionPrompt, selectedRepo, setSelectedRepo } = useLayoutContext();
      useEffect(() => {
        if (!selectedRepo) setSelectedRepo(MOCK_REPO);
      }, [selectedRepo, setSelectedRepo]);
      return createElement(
        "button",
        {
          type: "button",
          id: "submit-new-session",
          disabled: !selectedRepo,
          onClick: () => void handleNewSessionPrompt({ prompt: "Fix login race" }),
        },
        selectedRepo ? "submit" : "loading",
      );
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    expect(rendered.container.querySelector<HTMLButtonElement>("#submit-new-session")?.disabled).toBe(false);

    await act(async () => {
      click(rendered.container.querySelector("#submit-new-session"));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("session page");
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(2);
    await expandSidebarIfCollapsed(rendered.container);
    expect(rendered.container.querySelector('a[href="/sessions/sess-new"]')?.textContent).toContain("Fix login race");

    await act(async () => {
      backgroundRefresh.resolve({
        sessions: [
          {
            sessionId: "sess-new",
            phase: "running",
            prUrl: null,
            createdAt: Date.now(),
            model: null,
            title: "Fix login race",
          },
          ...MOCK_SESSIONS,
        ],
        nextCursor: null,
      });
      await flushAsyncWork();
    });

    expect(rendered.container.querySelector('a[href="/sessions/sess-new"]')).not.toBeNull();

    await rendered.unmount();
  });

  it("creates and sends a home prompt without a prewarm session", async () => {
    mediaHarness.setViewportWidth(1024);
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      repos: [MOCK_REPO],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultRepo: MOCK_REPO.fullName },
    });
    apiMocks.createSessionAndSend.mockResolvedValueOnce({ sessionId: "sess-fresh", promptId: "prompt-1" });

    function Harness() {
      const { handleNewSessionPrompt, selectedRepo, setSelectedRepo } = useLayoutContext();
      useEffect(() => {
        if (!selectedRepo) setSelectedRepo(MOCK_REPO);
      }, [selectedRepo, setSelectedRepo]);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            type: "button",
            id: "submit-new-session",
            disabled: !selectedRepo,
            onClick: () => void handleNewSessionPrompt({ prompt: "First prompt" }),
          },
          "submit",
        ),
      );
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { path: "sessions/:id", element: createElement(Harness) }),
            ),
          ),
        ),
      );
    });

    await act(async () => {
      click(rendered.container.querySelector("#submit-new-session"));
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.createSession).not.toHaveBeenCalled();
    expect(apiMocks.sendPrompt).not.toHaveBeenCalled();
    expect(apiMocks.createSessionAndSend).toHaveBeenCalledTimes(1);
    expect(apiMocks.createSessionAndSend).toHaveBeenCalledWith(
      "First prompt",
      { url: MOCK_REPO.url, baseBranch: MOCK_REPO.defaultBranch },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    await rendered.unmount();
  });

  it("starts authenticated startup fetches in parallel when a recent auth hint exists", async () => {
    const fetchUserResult = deferred<AuthProbeResult<User>>();
    localStorage.setItem(AUTH_HINT_KEY, "1");
    apiMocks.fetchUser.mockReturnValueOnce(fetchUserResult.promise);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      fetchUserResult.resolve(authenticatedUser());
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("home page");

    await rendered.unmount();
  });

  it("does not leak prefetched startup failures when a stale auth hint resolves unauthenticated", async () => {
    localStorage.setItem(AUTH_HINT_KEY, "1");
    apiMocks.fetchUser.mockResolvedValueOnce(unauthenticatedUser());
    apiMocks.fetchSessions.mockRejectedValueOnce(new Error("sessions failed"));
    apiMocks.fetchBootstrap.mockRejectedValueOnce(new Error("bootstrap failed"));

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain("home page");

    await rendered.unmount();
  });

  it("debounces auth refresh on window focus when already authenticated", async () => {
    apiMocks.fetchUser.mockResolvedValueOnce(authenticatedUser()).mockResolvedValueOnce(authenticatedUser());
    let now = new Date("2026-04-11T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    await flushAsyncWork();
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    // /auth/me always refreshes on focus so admin/teammate/webhook field flips
    // (slackWorkspaceInstalled, integration scopes, businessRole, etc.) propagate
    // -- the server-side cache bounds the cost. Sessions + bootstrap also bump
    // every focus; only the repos rehydrate inside the bootstrap stays gated by
    // the throttle (verified via the capabilitiesOnly path).
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(2);

    await act(async () => {
      now += 5 * 60 * 1000 + 1000;
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(3);

    await rendered.unmount();
  });

  it("rehydrates sessions and bootstrap on window focus after a login transition", async () => {
    apiMocks.fetchUser.mockResolvedValueOnce(unauthenticatedUser()).mockResolvedValueOnce(authenticatedUser());

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    await flushAsyncWork();
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchBootstrap).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await rendered.unmount();
  });

  it("refreshes bootstrap capabilities when refreshUser updates user state", async () => {
    let triggerRefreshUser: null | (() => Promise<void>) = null;
    apiMocks.fetchUser.mockResolvedValueOnce(unauthenticatedUser()).mockResolvedValueOnce(authenticatedUser());

    function HomeHarness() {
      const { refreshUser } = useLayoutContext();
      useEffect(() => {
        triggerRefreshUser = refreshUser;
      }, [refreshUser]);
      return createElement("div", null, "home page");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await flushAsyncWork();
    expect(triggerRefreshUser).not.toBeNull();
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchBootstrap).not.toHaveBeenCalled();

    await act(async () => {
      await triggerRefreshUser?.();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await rendered.unmount();
  });

  it("updates the focus debounce window after refreshUser", async () => {
    let triggerRefreshUser: null | (() => Promise<void>) = null;
    apiMocks.fetchUser
      .mockResolvedValueOnce(authenticatedUser())
      .mockResolvedValueOnce(authenticatedUser())
      .mockResolvedValueOnce(authenticatedUser())
      .mockResolvedValueOnce(authenticatedUser());
    let now = new Date("2026-04-11T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    function HomeHarness() {
      const { refreshUser } = useLayoutContext();
      useEffect(() => {
        triggerRefreshUser = refreshUser;
      }, [refreshUser]);
      return createElement("div", null, "home page");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await flushAsyncWork();
    expect(triggerRefreshUser).not.toBeNull();
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      now += 30_000;
      await triggerRefreshUser?.();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);

    await act(async () => {
      now += 1_000;
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    // /auth/me re-fetches on every focus now (server-side cache absorbs cost);
    // the throttle gates only the heavier bootstrap join.
    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(3);

    await act(async () => {
      now += 5 * 60 * 1000 + 1_000;
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(4);

    await rendered.unmount();
  });

  it("does not let a stale auth refresh clear a newer in-flight refresh", async () => {
    mediaHarness.setViewportWidth(480);
    const pendingStaleRefresh = deferred<AuthProbeResult<User>>();
    const pendingCurrentRefresh = deferred<AuthProbeResult<User>>();
    apiMocks.fetchUser
      .mockResolvedValueOnce(authenticatedUser())
      .mockReturnValueOnce(pendingStaleRefresh.promise)
      .mockReturnValueOnce(pendingCurrentRefresh.promise);
    let now = new Date("2026-04-11T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    const navButton = await waitFor(() => rendered.container.querySelector('button[aria-label="Toggle navigation"]'));
    await act(async () => {
      click(navButton);
      await flushAsyncWork();
    });
    const logoutButton = await waitFor(
      () =>
        Array.from(rendered.container.querySelectorAll("button")).find(
          (element) => element.textContent?.trim() === "Sign out",
        ) ?? null,
    );

    await act(async () => {
      now += 5 * 60 * 1000 + 1_000;
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);

    await act(async () => {
      click(logoutButton);
      await flushAsyncWork();
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(3);

    await act(async () => {
      pendingStaleRefresh.resolve(authenticatedUser());
      await flushAsyncWork();
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(3);

    await act(async () => {
      pendingCurrentRefresh.resolve(unauthenticatedUser());
      await flushAsyncWork();
    });

    await rendered.unmount();
  });

  it("waits for fetchUser before loading authenticated data when no auth hint exists", async () => {
    const fetchUserResult = deferred<AuthProbeResult<User>>();
    localStorage.removeItem(AUTH_HINT_KEY);
    apiMocks.fetchUser.mockReturnValueOnce(fetchUserResult.promise);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement("div", null, "home page") }),
            ),
          ),
        ),
      );
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchBootstrap).not.toHaveBeenCalled();

    await act(async () => {
      fetchUserResult.resolve(authenticatedUser());
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await rendered.unmount();
  });

  it("starts authenticated startup fetches in parallel for auth-only deep links without an auth hint", async () => {
    const fetchUserResult = deferred<AuthProbeResult<User>>();
    localStorage.removeItem(AUTH_HINT_KEY);
    apiMocks.fetchUser.mockReturnValueOnce(fetchUserResult.promise);

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
        root,
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/sess-1"] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Layout) },
              createElement(Route, { path: "sessions/:id", element: createElement("div", null, "session page") }),
            ),
          ),
        ),
      );
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchBootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      fetchUserResult.resolve(authenticatedUser());
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("session page");

    await rendered.unmount();
  });

  it("hydrates repos from a user-scoped home snapshot after auth resolves", async () => {
    const fetchUserResult = deferred<AuthProbeResult<User>>();
    const bootstrapResult = deferred<typeof DEFAULT_BOOTSTRAP>();
    apiMocks.fetchUser.mockReturnValueOnce(fetchUserResult.promise);
    apiMocks.fetchBootstrap.mockReturnValueOnce(bootstrapResult.promise);
    writeHomeSnapshot(
      String(MOCK_USER.id),
      {
        businessId: MOCK_USER.businessId,
        repos: [SNAPSHOT_REPO],
        ssoOrgs: [{ orgId: 42, login: "test", authorizeUrl: "/auth/github/sso?org=42" }],
        defaultRepoUrl: SNAPSHOT_REPO.fullName,
      },
      () => 123,
    );

    let observed: {
      user: ReturnType<typeof useLayoutContext>["user"];
      repos: Repo[];
      selectedRepo: Repo | null;
      selectedRepoFreshValidated: boolean;
    } = {
      user: undefined,
      repos: [],
      selectedRepo: null,
      selectedRepoFreshValidated: false,
    };

    function HomeHarness() {
      const context = useLayoutContext();
      useEffect(() => {
        observed = {
          user: context.user,
          repos: context.repos,
          selectedRepo: context.selectedRepo,
          selectedRepoFreshValidated: context.selectedRepoFreshValidated,
        };
      }, [context.user, context.repos, context.selectedRepo, context.selectedRepoFreshValidated]);
      return createElement("div", null, observed.selectedRepo?.fullName ?? "no repo");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    expect(observed.repos).toEqual([]);

    await act(async () => {
      fetchUserResult.resolve(authenticatedUser());
      await flushAsyncWork();
    });

    await waitFor(() => (observed.selectedRepo?.url === SNAPSHOT_REPO.url ? observed : null));
    expect(observed.user?.id).toBe(MOCK_USER.id);
    expect(observed.repos).toEqual([SNAPSHOT_REPO]);
    expect(observed.selectedRepoFreshValidated).toBe(false);

    await act(async () => {
      bootstrapResult.resolve({ ...DEFAULT_BOOTSTRAP, repos: null, reposPending: true });
      await flushAsyncWork();
    });

    await rendered.unmount();
  });

  it("does not apply a snapshot for a different resolved user", async () => {
    const otherUser = { ...MOCK_USER, id: 2, login: "other-user" };
    const bootstrapResult = deferred<typeof DEFAULT_BOOTSTRAP>();
    apiMocks.fetchUser.mockResolvedValueOnce(authenticatedUser(otherUser));
    apiMocks.fetchBootstrap.mockReturnValueOnce(bootstrapResult.promise);
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observedRepos: Repo[] = [];

    function HomeHarness() {
      const { repos } = useLayoutContext();
      useEffect(() => {
        observedRepos = repos;
      }, [repos]);
      return createElement("div", null, repos.length);
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (apiMocks.fetchBootstrap.mock.calls.length === 1 ? true : null));
    expect(observedRepos).toEqual([]);

    await act(async () => {
      bootstrapResult.resolve({ ...DEFAULT_BOOTSTRAP, user: { ...DEFAULT_BOOTSTRAP.user, id: otherUser.id } });
      await flushAsyncWork();
    });

    await rendered.unmount();
  });

  it("blocks stale snapshot repo submission until repo data is fresh", async () => {
    const bootstrapResult = deferred<typeof DEFAULT_BOOTSTRAP>();
    apiMocks.fetchBootstrap.mockReturnValueOnce(bootstrapResult.promise);
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observedError: string | null = null;

    function HomeHarness() {
      const { error, handleNewSessionPrompt, selectedRepo } = useLayoutContext();
      useEffect(() => {
        observedError = error;
      }, [error]);
      return createElement(
        "button",
        {
          type: "button",
          id: "submit-stale-snapshot",
          disabled: !selectedRepo,
          onClick: () => {
            void handleNewSessionPrompt({ prompt: "use stale repo" }).catch(() => undefined);
          },
        },
        selectedRepo ? "submit" : "loading",
      );
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => rendered.container.querySelector<HTMLButtonElement>("#submit-stale-snapshot:not(:disabled)"));

    await act(async () => {
      click(rendered.container.querySelector("#submit-stale-snapshot"));
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionAndSend).not.toHaveBeenCalled();
    expect(observedError).toBe("Repository access is still refreshing. Try again in a moment.");

    await act(async () => {
      bootstrapResult.resolve({ ...DEFAULT_BOOTSTRAP, repos: null, reposPending: true });
      await flushAsyncWork();
    });

    await rendered.unmount();
  });

  it("rewrites the home snapshot after deferred repo validation", async () => {
    apiMocks.fetchBootstrap.mockResolvedValueOnce({
      ...DEFAULT_BOOTSTRAP,
      repos: null,
      reposPending: true,
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultRepo: MOCK_REPO.fullName },
    });
    apiMocks.fetchRepos.mockResolvedValueOnce({
      repos: [MOCK_REPO],
      ssoOrgs: [],
    });
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observed: {
      selectedRepo: Repo | null;
      selectedRepoFreshValidated: boolean;
    } = {
      selectedRepo: null,
      selectedRepoFreshValidated: false,
    };

    function HomeHarness() {
      const { selectedRepo, selectedRepoFreshValidated } = useLayoutContext();
      useEffect(() => {
        observed = { selectedRepo, selectedRepoFreshValidated };
      }, [selectedRepo, selectedRepoFreshValidated]);
      return createElement("div", null, selectedRepo?.fullName ?? "no repo");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observed.selectedRepoFreshValidated ? observed : null));

    expect(observed.selectedRepo?.url).toBe(MOCK_REPO.url);
    expect(readHomeSnapshot(String(MOCK_USER.id))?.repos).toEqual([MOCK_REPO]);

    await rendered.unmount();
  });

  it("keeps fresh repo validation during same-user auth refresh", async () => {
    apiMocks.fetchBootstrap.mockResolvedValue({
      ...DEFAULT_BOOTSTRAP,
      repos: [MOCK_REPO],
      settings: { ...DEFAULT_BOOTSTRAP.settings, defaultRepo: MOCK_REPO.fullName },
    });
    apiMocks.fetchUser.mockResolvedValue(authenticatedUser());
    let now = new Date("2026-04-11T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observed: {
      selectedRepo: Repo | null;
      selectedRepoFreshValidated: boolean;
    } = {
      selectedRepo: null,
      selectedRepoFreshValidated: false,
    };

    function HomeHarness() {
      const { selectedRepo, selectedRepoFreshValidated } = useLayoutContext();
      useEffect(() => {
        observed = { selectedRepo, selectedRepoFreshValidated };
      }, [selectedRepo, selectedRepoFreshValidated]);
      return createElement("div", null, selectedRepo?.fullName ?? "no repo");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observed.selectedRepoFreshValidated ? observed : null));
    expect(observed.selectedRepo?.url).toBe(MOCK_REPO.url);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchUser).toHaveBeenCalledTimes(2);
    expect(observed.selectedRepo?.url).toBe(MOCK_REPO.url);
    expect(observed.selectedRepoFreshValidated).toBe(true);

    now += 1;
    await rendered.unmount();
  });

  it("ignores snapshot removals for a different user", async () => {
    const bootstrapResult = deferred<typeof DEFAULT_BOOTSTRAP>();
    apiMocks.fetchBootstrap.mockReturnValueOnce(bootstrapResult.promise);
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observedSelectedRepo: Repo | null = null;

    function HomeHarness() {
      const { selectedRepo } = useLayoutContext();
      useEffect(() => {
        observedSelectedRepo = selectedRepo;
      }, [selectedRepo]);
      return createElement("div", null, selectedRepo?.fullName ?? "no repo");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observedSelectedRepo?.url === SNAPSHOT_REPO.url ? observedSelectedRepo : null));

    await act(async () => {
      dispatchStorageEvent(`${HOME_SNAPSHOT_KEY_PREFIX}other-user`, null);
      await flushAsyncWork();
    });

    expect(observedSelectedRepo?.url).toBe(SNAPSHOT_REPO.url);

    await act(async () => {
      bootstrapResult.resolve({ ...DEFAULT_BOOTSTRAP, repos: null, reposPending: true });
      await flushAsyncWork();
    });

    await rendered.unmount();
  });

  it("clears optimistic repo state when another tab purges the home snapshot", async () => {
    const bootstrapResult = deferred<typeof DEFAULT_BOOTSTRAP>();
    apiMocks.fetchBootstrap.mockReturnValueOnce(bootstrapResult.promise);
    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [SNAPSHOT_REPO],
      ssoOrgs: [],
      defaultRepoUrl: SNAPSHOT_REPO.fullName,
    });

    let observed: {
      selectedRepo: Repo | null;
      selectedRepoFreshValidated: boolean;
    } = {
      selectedRepo: null,
      selectedRepoFreshValidated: false,
    };

    function HomeHarness() {
      const { selectedRepo, selectedRepoFreshValidated } = useLayoutContext();
      useEffect(() => {
        observed = { selectedRepo, selectedRepoFreshValidated };
      }, [selectedRepo, selectedRepoFreshValidated]);
      return createElement("div", null, selectedRepo?.fullName ?? "no repo");
    }

    const rendered = await renderWithRoot((root) => {
      renderWithConfirm(
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
              createElement(Route, { index: true, element: createElement(HomeHarness) }),
            ),
          ),
        ),
      );
    });

    await waitFor(() => (observed.selectedRepo?.url === SNAPSHOT_REPO.url ? observed : null));

    await act(async () => {
      dispatchStorageEvent(`${HOME_SNAPSHOT_KEY_PREFIX}${MOCK_USER.id}`, null);
      await flushAsyncWork();
    });

    expect(observed.selectedRepo).toBeNull();

    writeHomeSnapshot(String(MOCK_USER.id), {
      businessId: MOCK_USER.businessId,
      repos: [MOCK_REPO],
      ssoOrgs: [],
      defaultRepoUrl: MOCK_REPO.fullName,
    });

    await act(async () => {
      dispatchStorageEvent(`${HOME_SNAPSHOT_KEY_PREFIX}${MOCK_USER.id}`, "snapshot");
      await flushAsyncWork();
    });

    expect(observed.selectedRepo?.url).toBe(MOCK_REPO.url);
    expect(observed.selectedRepoFreshValidated).toBe(true);

    await act(async () => {
      bootstrapResult.resolve({ ...DEFAULT_BOOTSTRAP, repos: null, reposPending: true });
      await flushAsyncWork();
    });

    await rendered.unmount();
  });
});
