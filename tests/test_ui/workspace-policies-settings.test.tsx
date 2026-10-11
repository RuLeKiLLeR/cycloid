import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspacePoliciesSettings } from "../../apps/ui/src/components/settings/WorkspacePoliciesSettings";
import { MAX_BUSINESS_EGRESS_DOMAINS } from "../../shared/types/business-egress-policy";

// -----------------------------------------------------------------------------
// Mocks
//
// The former BusinessIntegrationsSettings mega-page was split; the shared-sessions
// toggle, custom egress allowlist, and workspace-default sandbox source now live
// on WorkspacePoliciesSettings. These tests exercise that policy panel directly.
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
    egressAllowlist: null as string[] | null,
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
  repos: [] as Array<{ fullName: string }>,
  reposLoaded: true,
  settings: { defaultRepo: null as string | null },
  refreshSessions: vi.fn(async () => undefined),
  refreshUser: vi.fn(async () => undefined),
}));

const apiMocks = vi.hoisted(() => ({
  updateBusinessSharedSessions: vi.fn(async () => undefined),
  fetchBusinessEgressAllowlistSource: vi.fn(async () => ({
    ok: true,
    source: { sourceRepoOwner: "trycycloid", sourceRepoName: "policy" },
    path: ".cycloid/egress-allowlist.txt",
    defaultBranch: "main",
    domains: ["api.acme.test"],
  })),
  createBusinessEgressAllowlistPr: vi.fn(async () => ({
    ok: true,
    source: { sourceRepoOwner: "trycycloid", sourceRepoName: "policy" },
    path: ".cycloid/egress-allowlist.txt",
    defaultBranch: "main",
    domains: ["registry.acme.test"],
    addedDomains: ["registry.acme.test"],
    prUrl: "https://github.com/trycycloid/policy/pull/12",
    prNumber: 12,
    branchName: "cycloid/egress-allowlist-biz-1",
    status: "created" as const,
  })),
  syncBusinessEgressAllowlistFromSource: vi.fn(async () => ({
    ok: true,
    applied: true,
    fileExists: true,
    domains: ["registry.acme.test"],
    egressAllowlist: ["registry.acme.test"],
  })),
  fetchSandboxLayerAssignments: vi.fn(async () => ({ businessDefault: null, repoAssignments: [] })),
  setSandboxLayerBusinessDefaultSource: vi.fn(async () => ({
    sourceRepo: "trycycloid/cycloid",
    manifestPath: ".cycloid/sandbox.yaml",
    sourceId: "source-1",
    latestActiveBuildId: "build-1",
    latestActiveArtifactRef: "template-1",
    updatedAt: 1_781_000_000_000,
  })),
  clearSandboxLayerBusinessDefaultSource: vi.fn(async () => undefined),
  fetchSandboxLayerResolutionPreview: vi.fn(async () => ({
    repo: "trycycloid/cycloid",
    resourceProfileKey: "trycycloid/cycloid",
    selected: null,
    selection: null,
    misses: [],
    latestRepoBuild: null,
    fallback: { reason: "no_sandbox_layer_selected", templateId: "cycloid-base" },
  })),
  fetchSandboxLayerBuildHistory: vi.fn(async () => []),
  fetchSandboxLayerBuildLogs: vi.fn(async () => []),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/integrations.ts", () => ({
  updateBusinessSharedSessions: apiMocks.updateBusinessSharedSessions,
  fetchBusinessEgressAllowlistSource: apiMocks.fetchBusinessEgressAllowlistSource,
  createBusinessEgressAllowlistPr: apiMocks.createBusinessEgressAllowlistPr,
  syncBusinessEgressAllowlistFromSource: apiMocks.syncBusinessEgressAllowlistFromSource,
}));

vi.mock("../../apps/ui/src/api/sandbox-layers.ts", () => ({
  fetchSandboxLayerAssignments: apiMocks.fetchSandboxLayerAssignments,
  setSandboxLayerBusinessDefaultSource: apiMocks.setSandboxLayerBusinessDefaultSource,
  clearSandboxLayerBusinessDefaultSource: apiMocks.clearSandboxLayerBusinessDefaultSource,
  fetchSandboxLayerResolutionPreview: apiMocks.fetchSandboxLayerResolutionPreview,
  fetchSandboxLayerBuildHistory: apiMocks.fetchSandboxLayerBuildHistory,
  fetchSandboxLayerBuildLogs: apiMocks.fetchSandboxLayerBuildLogs,
}));

// Run useSyncEffect eagerly so async loads actually happen under act.
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

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(WorkspacePoliciesSettings));
    await flushAsyncWork();
  });

  // Additional flushes: the egress-source and sandbox-assignment requests resolve
  // after render and trigger follow-up state updates.
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

describe("WorkspacePoliciesSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/workspace-policies";
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
      egressAllowlist: null,
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
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.settings = { defaultRepo: null };
    apiMocks.updateBusinessSharedSessions.mockResolvedValue(undefined);
    apiMocks.fetchSandboxLayerAssignments.mockResolvedValue({ businessDefault: null, repoAssignments: [] });
    apiMocks.setSandboxLayerBusinessDefaultSource.mockResolvedValue({
      sourceRepo: "trycycloid/cycloid",
      manifestPath: ".cycloid/sandbox.yaml",
      sourceId: "source-1",
      latestActiveBuildId: "build-1",
      latestActiveArtifactRef: "template-1",
      updatedAt: 1_781_000_000_000,
    });
    apiMocks.clearSandboxLayerBusinessDefaultSource.mockResolvedValue(undefined);
    apiMocks.fetchSandboxLayerResolutionPreview.mockResolvedValue({
      repo: "trycycloid/cycloid",
      resourceProfileKey: "trycycloid/cycloid",
      selected: null,
      selection: null,
      misses: [],
      latestRepoBuild: null,
      fallback: { reason: "no_sandbox_layer_selected", templateId: "cycloid-base" },
    });
    apiMocks.fetchSandboxLayerBuildHistory.mockResolvedValue([]);
    apiMocks.fetchSandboxLayerBuildLogs.mockResolvedValue([]);
    layoutMocks.refreshSessions.mockResolvedValue(undefined);
    layoutMocks.refreshUser.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the shared sessions section with current state from the user context", async () => {
    const { container, unmount } = await render();

    expect(container.textContent).toContain("Shared sessions");
    expect(container.textContent).not.toContain("Self-hosted sandboxes");
    expect(container.textContent).not.toContain("Shared sessions disabled");
    expect(container.textContent).not.toContain("Shared sessions enabled");

    const toggle = container.querySelector("[role='switch']") as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    expect(toggle!.getAttribute("aria-label")).toBe("Shared sessions disabled");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    await unmount();
  });

  it("reflects enabled state when user.sharedSessions is true", async () => {
    layoutMocks.user = { ...layoutMocks.user, sharedSessions: true };
    const { container, unmount } = await render();

    expect(container.textContent).not.toContain("Shared sessions enabled");
    const toggle = container.querySelector("[role='switch']") as HTMLElement | null;
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    expect(toggle!.getAttribute("aria-label")).toBe("Shared sessions enabled");

    await unmount();
  });

  it("calls updateBusinessSharedSessions and refreshes user on toggle click", async () => {
    const { container, unmount } = await render();

    const toggle = container.querySelector("[role='switch']") as HTMLElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.updateBusinessSharedSessions).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateBusinessSharedSessions).toHaveBeenCalledWith("biz-1", true);
    expect(layoutMocks.refreshUser).toHaveBeenCalledTimes(1);
    expect(layoutMocks.refreshUser).toHaveBeenCalledWith();
    expect(layoutMocks.refreshSessions).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("disables the switch while saving to prevent duplicate requests", async () => {
    let resolveUpdate: (() => void) | null = null;
    apiMocks.updateBusinessSharedSessions.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { container, unmount } = await render();
    const toggle = container.querySelector("[role='switch']") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });

    expect(toggle!.disabled).toBe(true);
    expect(toggle!.getAttribute("aria-label")).toBe("Saving shared sessions…");

    await act(async () => {
      resolveUpdate?.();
      await flushAsyncWork();
    });

    expect(apiMocks.updateBusinessSharedSessions).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("shows an error when the API call fails", async () => {
    apiMocks.updateBusinessSharedSessions.mockRejectedValueOnce(new Error("nope"));
    // Suppress the expected console.error so the test output stays clean.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { container, unmount } = await render();
    const toggle = container.querySelector("[role='switch']") as HTMLElement | null;

    await act(async () => {
      toggle!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("nope");
    expect(layoutMocks.refreshUser).not.toHaveBeenCalled();
    expect(layoutMocks.refreshSessions).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    await unmount();
  });

  it("shows the workspace default sandbox source when one is configured", async () => {
    apiMocks.fetchSandboxLayerAssignments.mockResolvedValue({
      businessDefault: {
        sourceRepo: "trycycloid/cycloid",
        manifestPath: ".cycloid/sandbox.yaml",
        sourceId: "source-1",
        latestActiveBuildId: "build-1",
        latestActiveArtifactRef: "template-abc123",
        updatedAt: 1_781_000_000_000,
      },
      repoAssignments: [],
    });

    const { container, unmount } = await render();

    expect(apiMocks.fetchSandboxLayerAssignments).toHaveBeenCalledWith("biz-1");
    expect(container.textContent).toContain("Workspace default");
    expect(container.textContent).toContain("New sessions build from trycycloid/cycloid.");
    expect(container.textContent).toContain("Current image template-abc");

    await unmount();
  });

  it("saves a workspace default sandbox source from the settings panel", async () => {
    layoutMocks.repos = [{ fullName: "trycycloid/cycloid" }];
    layoutMocks.settings = { defaultRepo: "trycycloid/cycloid" };

    const { container, unmount } = await render();
    const editButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Set default");
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
      await flushAsyncWork();
    });

    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save default",
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();
    expect(saveButton!.disabled).toBe(false);

    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setSandboxLayerBusinessDefaultSource).toHaveBeenCalledWith("biz-1", {
      sourceRepoOwner: "trycycloid",
      sourceRepoName: "cycloid",
    });
    expect(container.textContent).toContain("New sessions build from trycycloid/cycloid.");

    await unmount();
  });

  it("renders saved domains and lets admins add domains through an egress allowlist PR", async () => {
    layoutMocks.user = { ...layoutMocks.user, egressAllowlist: ["api.acme.test"] };

    const { container, unmount } = await render();
    expect(container.textContent).toContain("Custom egress domains");
    expect(container.textContent).toContain("api.acme.test");

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    const input = container.querySelector(
      "input[aria-label='Add egress allowlist domains']",
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "Registry.Acme.test, api.acme.test");
      await flushAsyncWork();
    });

    await act(async () => {
      const addButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Add domains",
      );
      addButton!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("registry.acme.test");

    expect(container.textContent).toContain("api.acme.test");
    expect(container.textContent).toContain("Synced");

    await act(async () => {
      const saveButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Open policy PR",
      );
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.createBusinessEgressAllowlistPr).toHaveBeenCalledTimes(1);
    expect(apiMocks.createBusinessEgressAllowlistPr).toHaveBeenCalledWith("biz-1", ["registry.acme.test"]);
    expect(container.textContent).toContain("https://github.com/trycycloid/policy/pull/12");
    expect(
      container.querySelector<HTMLAnchorElement>("a[href='https://github.com/trycycloid/policy/pull/12']"),
    ).not.toBeNull();

    await unmount();
  });

  it("renders an unsafe policy PR URL as text instead of a link", async () => {
    apiMocks.createBusinessEgressAllowlistPr.mockResolvedValueOnce({
      ok: true,
      source: { sourceRepoOwner: "trycycloid", sourceRepoName: "policy" },
      path: ".cycloid/egress-allowlist.txt",
      defaultBranch: "main",
      domains: ["registry.acme.test"],
      addedDomains: ["registry.acme.test"],
      prUrl: "/pull/12",
      prNumber: 12,
      branchName: "cycloid/egress-allowlist-biz-1",
      status: "created" as const,
    });

    const { container, unmount } = await render();

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    const input = container.querySelector(
      "input[aria-label='Add egress allowlist domains']",
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "registry.acme.test");
      await flushAsyncWork();
    });

    await act(async () => {
      const saveButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Open policy PR",
      );
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("/pull/12");
    expect(container.querySelector("a[href='/pull/12']")).toBeNull();

    await unmount();
  });

  it("surfaces allowlist validation errors before enqueueing draft state updates", async () => {
    layoutMocks.user = {
      ...layoutMocks.user,
      egressAllowlist: Array.from({ length: MAX_BUSINESS_EGRESS_DOMAINS }, (_, index) => `service-${index}.acme.test`),
    };

    const { container, unmount } = await render();

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    const input = container.querySelector(
      "input[aria-label='Add egress allowlist domains']",
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "overflow.acme.test");
      await flushAsyncWork();
    });

    await act(async () => {
      const addButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Add domains",
      );
      addButton!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain(`egressAllowlist must contain at most ${MAX_BUSINESS_EGRESS_DOMAINS}`);
    expect(input!.value).toBe("overflow.acme.test");

    await unmount();
  });

  it("rejects URL-formatted egress allowlist entries before opening a policy PR", async () => {
    const { container, unmount } = await render();

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    const input = container.querySelector(
      "input[aria-label='Add egress allowlist domains']",
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "https://api.acme.test");
      await flushAsyncWork();
    });

    await act(async () => {
      const saveButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Open policy PR",
      );
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("egressAllowlist entries must be exact domain names");
    expect(apiMocks.createBusinessEgressAllowlistPr).not.toHaveBeenCalled();

    await unmount();
  });

  it("treats pending input as unsaved and opens a PR with the allowlist", async () => {
    layoutMocks.user = { ...layoutMocks.user, egressAllowlist: ["api.acme.test"] };

    const { container, unmount } = await render();

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    const input = container.querySelector(
      "input[aria-label='Add egress allowlist domains']",
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "Registry.Acme.test");
      await flushAsyncWork();
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open policy PR",
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();
    expect(saveButton!.disabled).toBe(false);
    expect(container.textContent).toContain("Unsaved");

    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.createBusinessEgressAllowlistPr).toHaveBeenCalledTimes(1);
    expect(apiMocks.createBusinessEgressAllowlistPr).toHaveBeenCalledWith("biz-1", ["registry.acme.test"]);

    await unmount();
  });

  it("refreshes the runtime egress allowlist from the source repo", async () => {
    layoutMocks.user = { ...layoutMocks.user, egressAllowlist: ["api.acme.test"] };

    const { container, unmount } = await render();

    await act(async () => {
      const disclosure = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Custom egress domains"),
      );
      disclosure!.click();
      await flushAsyncWork();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    await act(async () => {
      const refreshButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh from repo",
      ) as HTMLButtonElement | undefined;
      expect(refreshButton?.disabled).toBe(false);
      refreshButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.syncBusinessEgressAllowlistFromSource).toHaveBeenCalledWith("biz-1");
    expect(layoutMocks.refreshUser).toHaveBeenCalledTimes(1);

    await unmount();
  });
});
