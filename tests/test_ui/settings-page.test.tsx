import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LayoutContext } from "../../apps/ui/src/components/Layout";
import { SettingsPage } from "../../apps/ui/src/pages/SettingsPage";

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
    HTMLAnchorElement: windowInstance.HTMLAnchorElement,
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

function createLayoutContext(overrides: Partial<LayoutContext> = {}): LayoutContext {
  return {
    user: {
      id: 1,
      login: "settings-user",
      name: "Settings User",
      email: "settings@example.com",
      avatarUrl: null,
      businessId: "biz-1",
      businessRole: "admin",
      sharedSessions: false,
      isCycloidAdmin: false,
      linearConnected: false,
      notionConnected: false,
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
    },
    capabilitiesStatus: "ready",
    repos: [],
    reposLoaded: true,
    reposError: null,
    settings: null,
    settingsLoaded: true,
    settingsError: null,
    setSettings: () => null,
    selectedRepo: null,
    setSelectedRepo: () => null,
    selectedRepoFreshValidated: true,
    models: [],
    selectedModel: null,
    setSelectedModel: () => null,
    sessions: [],
    sessionsLoaded: true,
    setSessions: () => null,
    patchSession: () => null,
    creating: false,
    setCreating: () => null,
    error: null,
    setError: () => null,
    handleNewSessionPrompt: async () => undefined,
    loadFilesForHomePage: async () => [],
    onLinearChange: () => null,
    onNotionChange: () => null,
    onSlackChange: () => null,
    onDefaultModelChange: () => null,
    refreshModels: async () => undefined,
    refreshUser: async () => undefined,
    refreshSessions: async () => undefined,
    endSession: async () => undefined,
    ...overrides,
  };
}

function LayoutContextOutlet({ context }: { context: LayoutContext }) {
  return createElement(Outlet, { context });
}

async function renderSettingsPage(context: LayoutContext) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings/general"] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(LayoutContextOutlet, { context }) },
            createElement(Route, {
              path: "/settings/*",
              element: createElement(SettingsPage),
            }),
          ),
        ),
      ),
    );
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

function getTabLabels(container: Element) {
  return Array.from(container.querySelectorAll('nav[aria-label="Settings sections"] a')).map(
    (link) => link.textContent?.trim() ?? "",
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/general";
    installDomGlobals(happyWindow);
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("renders settings tabs grouped by account, repositories, workspace, and system in the new IA order", async () => {
    const { container, unmount } = await renderSettingsPage(createLayoutContext());

    expect(getTabLabels(container)).toEqual([
      "Getting started",
      "Preferences",
      "Connected accounts",
      "Model API keys",
      "Personal secrets",
      "CLI tokens",
      "Usage",
      "Repositories",
      "Workspace policies",
      "Workspace integrations",
      "Slack memory",
      "MCP servers",
      "Diagnostics",
    ]);

    await unmount();
  });

  it("renders the group eyebrows above each tab cluster", async () => {
    const { container, unmount } = await renderSettingsPage(createLayoutContext());

    const groupLabels = Array.from(container.querySelectorAll('nav[aria-label="Settings sections"] p')).map(
      (p) => p.textContent?.trim() ?? "",
    );
    expect(groupLabels).toEqual(["Account", "Repositories", "Workspace", "System"]);

    await unmount();
  });

  it("removes the shell hero, per-tab descriptions, and the accent-bar active treatment", async () => {
    const { container, unmount } = await renderSettingsPage(createLayoutContext());

    // Shell-level <h1>Settings</h1> is gone (per-page header is the only h1 now).
    const h1Texts = Array.from(container.querySelectorAll("h1")).map((el) => el.textContent?.trim());
    expect(h1Texts).not.toContain("Settings");

    // Per-tab description copy must not render.
    expect(container.textContent).not.toContain("Notifications, default model, default repository.");
    expect(container.textContent).not.toContain("Recurring Cycloid runs against a repository.");
    expect(container.textContent).not.toContain("Bring your own provider keys.");

    // Active tab no longer renders a 2px accent-bar element; pill background is the only active signal.
    const accentBars = Array.from(container.querySelectorAll('nav[aria-label="Settings sections"] span')).filter(
      (el) => el.className.includes("bg-accent") && el.className.includes("w-[2px]"),
    );
    expect(accentBars.length).toBe(0);

    await unmount();
  });

  it("uses a current-section chooser on mobile and labels the return destination accurately", async () => {
    const { container, unmount } = await renderSettingsPage(createLayoutContext());

    const chooser = container.querySelector<HTMLButtonElement>('button[aria-controls="mobile-settings-sections"]');
    expect(chooser?.textContent).toContain("Preferences");
    expect(chooser?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('nav[aria-label="Settings section selector"]')).toBeNull();
    expect(container.textContent).toContain("Back to dashboard");

    await act(async () => {
      chooser?.click();
      await flushAsyncWork();
    });

    expect(chooser?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('nav[aria-label="Settings section selector"] a[href="/settings/api-keys"]'),
    ).not.toBeNull();

    await unmount();
  });

  it("preserves the relative tab order when capability-gated sections are filtered out", async () => {
    const { container, unmount } = await renderSettingsPage(
      createLayoutContext({
        capabilities: {
          canAccessIntegrationDebug: false,
          canManageBusinessIntegrations: false,
          canManageCliTokens: false,
          canUseBusinessSessions: false,
          canAdminPendingSignups: false,
          canStartSupportView: false,
          canUseInternalModelProviderKeys: false,
          canUseControlRoom: false,
        },
      }),
    );

    // Anchor tabs (enabled): Account tabs are always enabled and Repositories stays
    // member-usable. Workspace tabs render disabled (not hidden), and System's
    // Diagnostics is hidden entirely without the debug capability.
    expect(getTabLabels(container)).toEqual([
      "Getting started",
      "Preferences",
      "Connected accounts",
      "Model API keys",
      "Personal secrets",
      "CLI tokens",
      "Usage",
      "Repositories",
    ]);

    // Workspace admin tabs stay visible-but-disabled for members, with an
    // "Admins only" hint, rather than disappearing from the nav.
    const disabledLabels = Array.from(
      container.querySelectorAll('nav[aria-label="Settings sections"] [aria-disabled="true"]'),
    ).map((el) => el.querySelector("span")?.textContent?.trim() ?? "");
    expect(disabledLabels).toEqual(["Workspace policies", "Workspace integrations", "Slack memory", "MCP servers"]);
    expect(container.textContent).toContain("Admins only");

    await unmount();
  });
});
