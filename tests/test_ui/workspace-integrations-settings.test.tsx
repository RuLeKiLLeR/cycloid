import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { WorkspaceIntegrationsSettings } from "../../apps/ui/src/components/settings/WorkspaceIntegrationsSettings";
import { serializeNeonBranchCredentialConfig } from "../../shared/integrations/neon";

// -----------------------------------------------------------------------------
// Mocks
//
// The integration-policy rows, shared-credential editors, and Linear/Slack
// workspace controls split out of the former BusinessIntegrationsSettings
// mega-page onto WorkspaceIntegrationsSettings. These tests exercise that panel.
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
    isCycloidAdmin: false,
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
  refreshUser: vi.fn(async () => undefined),
}));

const apiMocks = vi.hoisted(() => ({
  fetchBusinessIntegrations: vi.fn(async () => ({})),
  setBusinessIntegrationScope: vi.fn(async () => undefined),
  setBusinessCredentials: vi.fn(async () => undefined),
  deleteBusinessCredentials: vi.fn(async () => undefined),
  disconnectBusinessLinearWorkspace: vi.fn(async () => undefined),
  disconnectBusinessJiraWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/integrations.ts", () => ({
  fetchBusinessIntegrations: apiMocks.fetchBusinessIntegrations,
  setBusinessIntegrationScope: apiMocks.setBusinessIntegrationScope,
  setBusinessCredentials: apiMocks.setBusinessCredentials,
  deleteBusinessCredentials: apiMocks.deleteBusinessCredentials,
  disconnectBusinessLinearWorkspace: apiMocks.disconnectBusinessLinearWorkspace,
  disconnectBusinessJiraWorkspace: apiMocks.disconnectBusinessJiraWorkspace,
  fetchUserIntegrations: vi.fn(async () => ({
    availableIntegrations: [],
    integrationTools: [],
    integrationScopes: {},
    currentHealth: {},
  })),
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchMcpServers: vi.fn(async () => []),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  validateMcpServer: vi.fn(),
}));

// Run useSyncEffect eagerly so the integrations fetch happens under act.
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
    HTMLTextAreaElement: windowInstance.HTMLTextAreaElement,
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[reactPropsKey]
    : null;
  reactProps?.onChange?.({ target: input });
}

// The disconnect actions now route through the shared confirm dialog; find the
// confirm/cancel button inside the alertdialog by its label.
function confirmDialogButton(container: Element, label: string): HTMLButtonElement | null {
  const dialog = container.querySelector('[role="alertdialog"]');
  if (!dialog) return null;
  return (
    ([...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as
      HTMLButtonElement | undefined) ?? null
  );
}

async function render(initialEntry = "/settings/workspace-integrations") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        ConfirmProvider,
        null,
        createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(WorkspaceIntegrationsSettings)),
      ),
    );
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

describe("WorkspaceIntegrationsSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/workspace-integrations";
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
      isCycloidAdmin: false,
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
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({});
    apiMocks.setBusinessCredentials.mockResolvedValue(undefined);
    apiMocks.deleteBusinessCredentials.mockResolvedValue(undefined);
    apiMocks.disconnectBusinessLinearWorkspace.mockResolvedValue(undefined);
    apiMocks.disconnectBusinessJiraWorkspace.mockResolvedValue(undefined);
    layoutMocks.refreshUser.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render the repository environment variables section", async () => {
    const { container, unmount } = await render();

    expect(container.textContent).not.toContain("Repository environment variables");
    expect(container.querySelector("textarea[aria-label='Repository environment variables']")).toBeNull();
    expect(apiMocks.fetchBusinessIntegrations).toHaveBeenCalledWith("biz-1");

    await unmount();
  });

  it("renders a Sentry org slug field and requires it before saving", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({
      sentry: { scope: "business", credentialsConnected: false, credentialKind: null },
    });

    const { container, unmount } = await render();
    const inputs = Array.from(container.querySelectorAll("input"));
    const slugInput = inputs.find((input) => input.getAttribute("placeholder") === "Sentry organization slug…");
    const saveButton = container.querySelector(
      "[data-testid='business-sentry-credentials-save']",
    ) as HTMLButtonElement | null;

    expect(slugInput).toBeTruthy();
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      setInputValue(
        inputs.find((input) => input.getAttribute("placeholder") === "Sentry API key…")!,
        "sntrys_valid_token",
      );
      await flushAsyncWork();
    });
    await act(async () => {
      setInputValue(slugInput!, "acme");
      await flushAsyncWork();
    });

    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setBusinessCredentials).toHaveBeenCalledWith("biz-1", "sentry", {
      apiKey: "sntrys_valid_token",
      serviceUrl: "acme",
    });

    await unmount();
  });

  it("renders Datadog site and application-key fields and requires both before saving", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({
      datadog: { scope: "business", credentialsConnected: false, credentialKind: null },
    });

    const { container, unmount } = await render();
    const inputs = Array.from(container.querySelectorAll("input"));
    const siteInput = inputs.find(
      (input) => input.getAttribute("placeholder") === "Datadog site (for example us5.datadoghq.com)…",
    );
    const appKeyInput = inputs.find((input) => input.getAttribute("placeholder") === "Datadog application key…");
    const saveButton = container.querySelector(
      "[data-testid='business-datadog-credentials-save']",
    ) as HTMLButtonElement | null;

    expect(siteInput).toBeTruthy();
    expect(appKeyInput).toBeTruthy();
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      setInputValue(
        inputs.find((input) => input.getAttribute("placeholder") === "Datadog API key…")!,
        "dd-api-key",
      );
      await flushAsyncWork();
    });
    await act(async () => {
      setInputValue(appKeyInput!, "dd-app-key");
      await flushAsyncWork();
    });
    await act(async () => {
      setInputValue(siteInput!, "us5.datadoghq.com");
      await flushAsyncWork();
    });

    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setBusinessCredentials).toHaveBeenCalledWith("biz-1", "datadog", {
      apiKey: "dd-api-key",
      applicationKey: "dd-app-key",
      serviceUrl: "us5.datadoghq.com",
    });

    await unmount();
  });

  it("renders a single Stripe secret-key field and saves it as manual business credentials", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({
      stripe: { scope: "business", credentialsConnected: false, credentialKind: null },
    });

    const { container, unmount } = await render();
    const secretKeyInput = container.querySelector(
      "input[placeholder='Stripe secret key (prefer test mode)…']",
    ) as HTMLInputElement | null;
    const saveButton = container.querySelector(
      "[data-testid='business-stripe-credentials-save']",
    ) as HTMLButtonElement | null;

    expect(secretKeyInput).toBeTruthy();
    expect(saveButton?.disabled).toBe(true);
    expect(container.textContent).toContain("Prefer a test-mode or restricted secret key");

    await act(async () => {
      setInputValue(secretKeyInput!, "sk_test_1234567890");
      await flushAsyncWork();
    });

    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setBusinessCredentials).toHaveBeenCalledWith("biz-1", "stripe", {
      apiKey: "sk_test_1234567890",
    });

    await unmount();
  });

  it("renders Neon project fields and serializes the config before saving", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({
      neon: { scope: "business", credentialsConnected: false, credentialKind: null },
    });

    const { container, unmount } = await render();
    const inputs = Array.from(container.querySelectorAll("input"));
    const projectIdInput = inputs.find((input) => input.getAttribute("placeholder") === "Neon project ID…");
    const parentBranchInput = inputs.find(
      (input) =>
        input.getAttribute("placeholder") ===
        "Neon parent branch ID (optional, defaults to the project default branch)…",
    );
    const saveButton = container.querySelector(
      "[data-testid='business-neon-credentials-save']",
    ) as HTMLButtonElement | null;

    expect(projectIdInput).toBeTruthy();
    expect(parentBranchInput).toBeTruthy();
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      setInputValue(
        inputs.find((input) => input.getAttribute("placeholder") === "Neon API key…")!,
        "neon-api-key",
      );
      await flushAsyncWork();
    });
    await act(async () => {
      setInputValue(projectIdInput!, "bright-sun-123456");
      await flushAsyncWork();
    });
    await act(async () => {
      setInputValue(parentBranchInput!, "br-primary");
      await flushAsyncWork();
    });

    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setBusinessCredentials).toHaveBeenCalledWith("biz-1", "neon", {
      apiKey: "neon-api-key",
      serviceUrl: serializeNeonBranchCredentialConfig({
        projectId: "bright-sun-123456",
        parentBranchId: "br-primary",
      }),
    });

    await unmount();
  });

  it("pre-populates Neon project metadata from connected credentials", async () => {
    layoutMocks.user.isCycloidAdmin = true;
    apiMocks.fetchBusinessIntegrations.mockResolvedValue({
      neon: {
        scope: "business",
        credentialsConnected: false,
        credentialKind: null,
        neonCredentialConfig: {
          projectId: "bright-sun-123456",
          parentBranchId: "br-primary",
        },
      },
    });

    const { container, unmount } = await render();
    const projectIdInput = Array.from(container.querySelectorAll("input")).find(
      (input) => input.getAttribute("placeholder") === "Neon project ID…",
    );
    const parentBranchInput = Array.from(container.querySelectorAll("input")).find(
      (input) =>
        input.getAttribute("placeholder") ===
        "Neon parent branch ID (optional, defaults to the project default branch)…",
    );

    expect(projectIdInput?.value).toBe("bright-sun-123456");
    expect(parentBranchInput?.value).toBe("br-primary");

    layoutMocks.user.isCycloidAdmin = false;
    await unmount();
  });
  it("shows Linear workspace OAuth callback errors", async () => {
    const { container, unmount } = await render("/settings/workspace-integrations?error=linear_integration_disabled");

    expect(container.textContent).toContain("Linear is disabled");
    expect(container.textContent).toContain("Enable Linear in business integrations");

    await unmount();
  });

  it("hides the Linear workspace connect link when Linear is disabled", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: { scope: "disabled", credentialsConnected: false },
    });

    const { container, unmount } = await render();

    expect(container.querySelector("a[href='/auth/linear/business']")).toBeNull();

    await unmount();
  });

  it("shows connected Linear workspace state without workspace label", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "user",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: null,
          organizationUrlKey: null,
          webhookId: "lin-webhook-1",
          webhookBound: true,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Connected to");
    expect(container.textContent).not.toContain("Linear organization: lin-org-1");
    expect(container.querySelector("a[href='/auth/linear/business']")?.textContent).toBe("Reconnect");

    await unmount();
  });

  it("shows Linear workspace urlKey in the connected label when available", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "user",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: "Cycloid Inc",
          organizationUrlKey: "cycloid",
          webhookId: "lin-webhook-1",
          webhookBound: true,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Connected to cycloid");
    expect(container.textContent).not.toContain("Cycloid Inc");

    await unmount();
  });

  it("falls back to organizationName when urlKey is missing", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "user",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: "Cycloid Inc",
          organizationUrlKey: null,
          webhookId: "lin-webhook-1",
          webhookBound: true,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Connected to Cycloid Inc");

    await unmount();
  });

  it("disconnects an active Linear workspace", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "user",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: null,
          organizationUrlKey: null,
          webhookId: "lin-webhook-1",
          webhookBound: true,
        },
      },
    });

    const { container, unmount } = await render();

    const removeButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Remove");
    expect(removeButton).toBeDefined();

    // Removing now opens a confirm dialog; confirm it to run the disconnect.
    await act(async () => {
      removeButton!.click();
      await flushAsyncWork();
    });
    const confirmButton = confirmDialogButton(container, "Disconnect");
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.disconnectBusinessLinearWorkspace).toHaveBeenCalledTimes(1);
    expect(apiMocks.disconnectBusinessLinearWorkspace).toHaveBeenCalledWith("biz-1");
    expect(container.textContent).toContain("Connection revoked");
    expect(container.querySelector("a[href='/auth/linear/business']")?.textContent).toBe("Reconnect");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Remove")).toBe(false);

    await unmount();
  });

  it("shows waiting state before the first Linear webhook delivery", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "user",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: null,
          organizationUrlKey: null,
          webhookId: null,
          webhookBound: false,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Connected (pending webhook)");
    expect(container.querySelector("a[href='/auth/linear/business']")?.textContent).toBe("Reconnect");

    await unmount();
  });

  it("keeps the Remove action available when scope is disabled but workspace is still active", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      linear: {
        scope: "disabled",
        credentialsConnected: false,
        linearWorkspace: {
          status: "active",
          organizationId: "lin-org-1",
          organizationName: null,
          organizationUrlKey: null,
          webhookId: "lin-webhook-1",
          webhookBound: true,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.querySelector("a[href='/auth/linear/business']")).toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Remove")).toBe(true);

    await unmount();
  });

  it("shows the Slack workspace install button when no workspace is installed", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      slack: {
        scope: "user",
        credentialsConnected: false,
        credentialKind: null,
        slackWorkspace: { status: "not_installed", teamId: null, teamName: null, teamDomain: null, installedAt: null },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Slack workspace app");
    expect(container.textContent).toContain("Not installed");
    const installLink = container.querySelector("a[href='/auth/slack/install']");
    expect(installLink?.textContent).toBe("Install Cycloid in Slack");

    await unmount();
  });

  it("shows the installed Slack workspace with a Reinstall action", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      slack: {
        scope: "user",
        credentialsConnected: false,
        credentialKind: null,
        slackWorkspace: {
          status: "installed",
          teamId: "T_TEST",
          teamName: "Mia Labs",
          teamDomain: "mialabs",
          installedAt: 1_780_000_000_000,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Installed in Mia Labs");
    expect(container.querySelector("a[href='/auth/slack/install']")?.textContent).toBe("Reinstall");

    await unmount();
  });

  it("warns when the workspace is installed but the Slack scope is disabled", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      slack: {
        scope: "disabled",
        credentialsConnected: false,
        credentialKind: null,
        slackWorkspace: {
          status: "installed",
          teamId: "T_TEST",
          teamName: "Mia Labs",
          teamDomain: "mialabs",
          installedAt: 1_780_000_000_000,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Installed, but Slack is disabled for this workspace.");
    expect(container.querySelector("a[href='/auth/slack/install']")).toBeNull();

    await unmount();
  });

  it("renders the Slack install success banner from the callback redirect", async () => {
    const { container, unmount } = await render("/settings/workspace-integrations?success=slack_install_success");

    expect(container.textContent).toContain("Cycloid installed in Slack");

    await unmount();
  });

  it("shows a business-safe GitHub lifecycle message instead of a raw user-specific failure", async () => {
    apiMocks.fetchBusinessIntegrations.mockResolvedValueOnce({
      github: {
        scope: "business",
        credentialsConnected: false,
        credentialKind: null,
        lifecycle: {
          integrationId: "github",
          stage: "credential_resolved",
          status: "failed",
          reasonCode: "token_missing",
          message: "A member needs to reconnect GitHub before starting a session.",
          createdAt: 123,
        },
      },
    });

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Needs attention.");
    expect(container.textContent).toContain("A member needs to reconnect GitHub before starting a session.");
    expect(container.textContent).not.toContain("No GitHub OAuth token is stored for this user.");
    expect(container.textContent).not.toContain("token_missing");

    await unmount();
  });
});
