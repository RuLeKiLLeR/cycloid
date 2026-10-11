import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { IntegrationsSettings } from "../../apps/ui/src/components/settings/IntegrationsSettings";
import type { UserIntegrations } from "../../apps/ui/src/types";

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const layoutMocks = vi.hoisted(() => ({
  defaultUser: {
    id: 1,
    login: "testuser",
    name: "Test User",
    email: "testexample.com",
    avatarUrl: "https://example.com/avatar.png",
    businessId: "biz-1",
    businessRole: "member" as const,
    sharedSessions: false,
    linearConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
  },
  user: null as unknown,
  onLinearChange: vi.fn(),
  onSlackChange: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchUserIntegrations: vi.fn(async (): Promise<UserIntegrations> => ({
    availableIntegrations: ["github", "linear", "openai"],
    integrationTools: [],
    integrationScopes: { linear: "user" },
    currentHealth: {},
  })),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/repos.ts", () => ({
  fetchInstallUrl: apiMocks.fetchInstallUrl,
}));

vi.mock("../../apps/ui/src/api/integrations.ts", () => ({
  fetchUserIntegrations: apiMocks.fetchUserIntegrations,
  fetchMcpServers: vi.fn(async () => []),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  validateMcpServer: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/onboarding.ts", () => ({
  fetchOnboardingStatus: vi.fn(async () => []),
}));

vi.mock("../../apps/ui/src/api/auth.ts", () => ({
  disconnectLinear: vi.fn(),
  disconnectSlack: vi.fn(),
}));

// Run useMountEffect eagerly as a normal effect so the async integrations load
// actually happens under `act`.
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
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
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

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((container.textContent ?? "").includes(text)) return;
    await act(async () => {
      await flushAsyncWork();
    });
  }
  expect(container.textContent ?? "").toContain(text);
}

async function renderWithSearch(search: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        ConfirmProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [`/settings/integrations${search}`] },
          createElement(IntegrationsSettings),
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

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("IntegrationsSettings callback banner", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/integrations";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.user = layoutMocks.defaultUser;
    apiMocks.fetchInstallUrl.mockResolvedValue("https://github.com/apps/cycloid/installations/new");
    apiMocks.fetchUserIntegrations.mockResolvedValue({
      availableIntegrations: ["github", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { linear: "user" },
      currentHealth: {},
    });

    // Stub fetch so any escape-hatch relative-URL requests don't blow up with
    // "Invalid URL".
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders no banner when there are no callback params", async () => {
    const { container, unmount } = await renderWithSearch("");
    const alerts = container.querySelectorAll("[role='alert'], [role='status']");
    expect(alerts.length).toBe(0);
    await unmount();
  });

  it("renders an error banner for ?error=linear_connect_failed", async () => {
    const { container, unmount } = await renderWithSearch("?error=linear_connect_failed");
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Linear connection failed");
    expect(alert!.textContent).toContain("OAuth flow");
    // Status banner should not also be present
    expect(container.querySelector("[role='status']")).toBeNull();
    await unmount();
  });

  it("renders an error banner for ?error=linear_account_already_connected", async () => {
    const { container, unmount } = await renderWithSearch("?error=linear_account_already_connected");
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Linear account already in use");
    await unmount();
  });

  it("renders an error banner for ?error=slack_connect_failed", async () => {
    const { container, unmount } = await renderWithSearch("?error=slack_connect_failed");
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Slack connection failed");
    await unmount();
  });

  it("renders a warning banner for ?warning=linear_id_fetch_failed", async () => {
    const { container, unmount } = await renderWithSearch("?warning=linear_id_fetch_failed");
    const status = container.querySelector("[role='status']") as HTMLElement | null;
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Linear connected with limitations");
    expect(status!.textContent).toContain("Linear user identity");
    // Warning should not use role=alert
    expect(container.querySelector("[role='alert']")).toBeNull();
    await unmount();
  });

  it("ignores unknown error codes instead of rendering an empty banner", async () => {
    const { container, unmount } = await renderWithSearch("?error=not_a_real_code");
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelector("[role='status']")).toBeNull();
    await unmount();
  });

  it("dismisses the banner when the dismiss button is clicked", async () => {
    const { container, unmount } = await renderWithSearch("?error=linear_connect_failed");
    const alertBefore = container.querySelector("[role='alert']");
    expect(alertBefore).not.toBeNull();

    const dismissButton = [...container.querySelectorAll("button")].find(
      (btn) => btn.textContent?.trim() === "Dismiss",
    ) as HTMLButtonElement | undefined;
    expect(dismissButton).toBeDefined();

    await act(async () => {
      dismissButton!.click();
      await flushAsyncWork();
    });

    expect(container.querySelector("[role='alert']")).toBeNull();
    await unmount();
  });

  it("renders the banner during the transient !user loading state", async () => {
    // Simulate the brief window before LayoutContext has populated `user`
    // (e.g. a user who lands straight from an OAuth redirect while the
    // layout-level auth check is still resolving). The banner must still
    // render so the OAuth outcome is visible.
    layoutMocks.user = null;
    const { container, unmount } = await renderWithSearch("?error=linear_connect_failed");
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Linear connection failed");
    await unmount();
  });

  it("renders nothing during the !user loading state when there are no callback params", async () => {
    layoutMocks.user = null;
    const { container, unmount } = await renderWithSearch("");
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelector("[role='status']")).toBeNull();
    expect(container.textContent).toBe("");
    await unmount();
  });

  it("prefers error over warning when both params are present", async () => {
    const { container, unmount } = await renderWithSearch(
      "?error=linear_connect_failed&warning=linear_id_fetch_failed",
    );
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Linear connection failed");
    expect(container.querySelector("[role='status']")).toBeNull();
    await unmount();
  });

  it("renders an error banner for ?error=slack_business_admin_required", async () => {
    const { container, unmount } = await renderWithSearch("?error=slack_business_admin_required");
    const alert = container.querySelector("[role='alert']") as HTMLElement | null;
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Only workspace admins can install Cycloid in Slack");
    await unmount();
  });
});

describe("IntegrationsSettings Slack workspace install hint", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/integrations";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.user = layoutMocks.defaultUser;
    apiMocks.fetchInstallUrl.mockResolvedValue("https://github.com/apps/cycloid/installations/new");
    apiMocks.fetchUserIntegrations.mockResolvedValue({
      availableIntegrations: ["github", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { linear: "user" },
    });
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (layoutMocks as Record<string, unknown>).capabilities = undefined;
  });

  it("tells non-admins to ask an admin when no workspace install exists", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, slackWorkspaceInstalled: false };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Slack");

    expect(container.textContent).toContain("Ask an admin to install Cycloid in Slack first.");
    await unmount();
  });

  it("links admins directly to Slack install OAuth when no workspace install exists", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, businessRole: "admin", slackWorkspaceInstalled: false };
    (layoutMocks as Record<string, unknown>).capabilities = { canManageBusinessIntegrations: true };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Slack");

    expect(container.textContent).toContain("Workspace install required first.");
    expect(container.querySelector("a[href='/auth/slack/install?returnTo=%2Fsettings%2Fintegrations']")).not.toBeNull();
    await unmount();
  });

  it("shows no install hint when the workspace install exists", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, slackWorkspaceInstalled: true };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Slack");

    expect(container.textContent).not.toContain("Ask an admin to install Cycloid in Slack first.");
    expect(container.textContent).not.toContain("Workspace install required first.");
    await unmount();
  });

  it("shows no install hint when the field is absent (stale cached /auth/me)", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Slack");

    expect(container.textContent).not.toContain("Ask an admin to install Cycloid in Slack first.");
    expect(container.textContent).not.toContain("Workspace install required first.");
    await unmount();
  });

  // Regression: the GitHub install URL only feeds the install/manage links, so
  // its failure must not block the integrations page (which now also hosts the
  // Model API keys section). Only a failed integrations fetch is fatal.
  it("still renders the page when the install URL fetch fails", async () => {
    apiMocks.fetchInstallUrl.mockRejectedValueOnce(new Error("install-url down"));

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Connected accounts");

    expect(container.textContent).not.toContain("Failed to load integrations");
    await unmount();
  });
});
