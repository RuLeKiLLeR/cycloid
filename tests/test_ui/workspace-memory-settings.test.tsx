import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { WorkspaceMemorySettings } from "../../apps/ui/src/components/settings/WorkspaceMemorySettings";

// -----------------------------------------------------------------------------
// Mocks
//
// The ambient Slack-channel memory controls split out of the former
// BusinessIntegrationsSettings mega-page onto WorkspaceMemorySettings (the
// "Slack memory" route). The section is now titled "Tracked channels" and
// removing a channel routes through the shared confirm dialog.
// -----------------------------------------------------------------------------

const layoutMocks = vi.hoisted(() => ({
  user: {
    id: 1,
    login: "testadmin",
    name: "Test Admin",
    email: "admin@example.com",
    avatarUrl: null,
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
  capabilitiesStatus: "ready" as const,
}));

const apiMocks = vi.hoisted(() => ({
  fetchSlackChannelMemorySettings: vi.fn(async () => ({ intake: [], workspaces: [] })),
  fetchSlackWorkspaceMemoryChannels: vi.fn(async () => [
    { id: "C_TEST", name: "engineering", isPrivate: false, isMember: true },
    { id: "C_OTHER", name: "sales", isPrivate: false, isMember: true },
  ]),
  saveSlackChannelMemoryIntake: vi.fn(async () => ({
    businessId: "biz-1",
    teamId: "T_TEST",
    channelId: "C_TEST",
    scopeType: "generic",
    scopeId: null,
    enabledAtMs: 1_780_000_000_000,
    enabledByUserId: 1,
  })),
  disableSlackChannelMemoryIntake: vi.fn(async () => undefined),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/company-memory.ts", () => ({
  fetchSlackChannelMemorySettings: apiMocks.fetchSlackChannelMemorySettings,
  fetchSlackWorkspaceMemoryChannels: apiMocks.fetchSlackWorkspaceMemoryChannels,
  saveSlackChannelMemoryIntake: apiMocks.saveSlackChannelMemoryIntake,
  disableSlackChannelMemoryIntake: apiMocks.disableSlackChannelMemoryIntake,
}));

// Run useSyncEffect eagerly so the async loads happen under act.
vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const React = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      React.useEffect(effect, []);
    },
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

// -----------------------------------------------------------------------------
// DOM setup
// -----------------------------------------------------------------------------

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
    HTMLInputElement: windowInstance.HTMLInputElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    InputEvent: windowInstance.InputEvent,
    KeyboardEvent: windowInstance.KeyboardEvent,
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
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function confirmDialogButton(container: Element, label: string): HTMLButtonElement | null {
  const dialog = container.querySelector('[role="alertdialog"]');
  if (!dialog) return null;
  return (
    ([...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as
      HTMLButtonElement | undefined) ?? null
  );
}

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ConfirmProvider, null, createElement(WorkspaceMemorySettings)));
    await flushAsyncWork();
  });

  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
  }

  return {
    container,
    root,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("WorkspaceMemorySettings tracked channels", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/slack-memory";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();

    layoutMocks.user = {
      id: 1,
      login: "testadmin",
      name: "Test Admin",
      email: "admin@example.com",
      avatarUrl: null,
      businessId: "biz-1",
      businessRole: "admin" as const,
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    };
    layoutMocks.capabilities = {
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: true,
      canManageCliTokens: true,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
    };
    layoutMocks.capabilitiesStatus = "ready";
    apiMocks.fetchSlackChannelMemorySettings.mockResolvedValue({
      intake: [],
      workspaces: [
        {
          teamId: "T_TEST",
          teamName: "Test Workspace",
          teamDomain: "test-workspace",
          uninstalledAt: null,
        },
      ],
    });
    apiMocks.fetchSlackWorkspaceMemoryChannels.mockResolvedValue([
      { id: "C_TEST", name: "engineering", isPrivate: false, isMember: true },
      { id: "C_OTHER", name: "sales", isPrivate: false, isMember: true },
    ]);
    apiMocks.saveSlackChannelMemoryIntake.mockResolvedValue({
      businessId: "biz-1",
      teamId: "T_TEST",
      channelId: "C_TEST",
      scopeType: "generic",
      scopeId: null,
      enabledAtMs: 1_780_000_000_000,
      enabledByUserId: 1,
    });
    apiMocks.disableSlackChannelMemoryIntake.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Slack channel memory rules with workspace and audit metadata", async () => {
    apiMocks.fetchSlackChannelMemorySettings.mockResolvedValue({
      workspaces: [
        {
          teamId: "T_TEST",
          teamName: "Test Workspace",
          teamDomain: "test-workspace",
          uninstalledAt: null,
        },
      ],
      intake: [
        {
          businessId: "biz-1",
          teamId: "T_TEST",
          channelId: "C_TEST",
          scopeType: "customer",
          scopeId: "acme",
          enabledAtMs: 1_780_000_000_000,
          enabledByUserId: 42,
        },
      ],
    });

    const { container, unmount } = await render();

    expect(apiMocks.fetchSlackChannelMemorySettings).toHaveBeenCalledWith("biz-1");
    // The section was renamed from "Ambient Slack memory" to "Tracked channels".
    expect(container.textContent).toContain("Tracked channels");
    expect(container.textContent).toContain("Prompt injection remains disabled until memory tools are enabled");
    expect(container.textContent).toContain("Test Workspace (T_TEST)");
    // Raw channel and user IDs moved out of the visible copy into title attrs.
    expect(container.querySelector('[title="C_TEST"]')).toBeTruthy();
    expect(container.textContent).not.toContain("C_TEST");
    expect(container.textContent).toContain("Customer work");
    expect(container.textContent).toContain("acme");
    expect(container.querySelector('[title="Enabled by user 42"]')).toBeTruthy();
    expect(container.textContent).not.toContain("User 42");

    await unmount();
  });

  it("handles Slack channel memory settings without a workspace list", async () => {
    apiMocks.fetchSlackChannelMemorySettings.mockResolvedValue({
      intake: [],
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Tracked channels");
    expect(container.textContent).toContain("Install the Slack workspace app before adding channels.");

    await unmount();
  });

  it("saves a Slack channel memory rule from the workspace controls", async () => {
    const { container, unmount } = await render();
    const channelSelect = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "C_TEST"),
    ) as HTMLSelectElement | undefined;
    expect(channelSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(channelSelect!, "C_TEST");
      channelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Add channel");
    expect(button).toBeTruthy();

    await act(async () => {
      button!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.saveSlackChannelMemoryIntake).toHaveBeenCalledWith({
      businessId: "biz-1",
      teamId: "T_TEST",
      channelId: "C_TEST",
      scopeType: "generic",
      scopeId: null,
    });
    expect(container.querySelector('[title="C_TEST"]')).toBeTruthy();

    await unmount();
  });

  it("disables a Slack channel memory rule from the audit row", async () => {
    apiMocks.fetchSlackChannelMemorySettings.mockResolvedValue({
      workspaces: [],
      intake: [
        {
          businessId: "biz-1",
          teamId: "T_TEST",
          channelId: "C_REMOVE",
          scopeType: "support",
          scopeId: null,
          enabledAtMs: 1_780_000_000_000,
          enabledByUserId: 42,
        },
      ],
    });

    const { container, unmount } = await render();
    expect(container.textContent).toContain("C_REMOVE");
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Remove");
    expect(button).toBeTruthy();

    // Removing now opens a confirm dialog; confirm it to run the disable.
    await act(async () => {
      button!.click();
      await flushAsyncWork();
    });
    const confirmButton = confirmDialogButton(container, "Remove");
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.disableSlackChannelMemoryIntake).toHaveBeenCalledWith({
      businessId: "biz-1",
      teamId: "T_TEST",
      channelId: "C_REMOVE",
    });
    expect(container.textContent).not.toContain("C_REMOVE");

    await unmount();
  });
});
