import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { RepositoriesSettings } from "../../apps/ui/src/components/settings/RepositoriesSettings";

const layoutMocks = vi.hoisted(() => ({
  repos: [
    {
      fullName: "org/repo-one",
      url: "https://github.com/org/repo-one",
      private: true,
      defaultBranch: "main",
    },
    {
      fullName: "org/repo-two",
      url: "https://github.com/org/repo-two",
      private: true,
      defaultBranch: "main",
    },
  ],
  reposLoaded: true,
  settings: { defaultRepo: "org/repo-one" },
  // The env-var editor now lives on the Repositories page; its section is admin-gated
  // in-component via useWorkspaceAdminAccess (canManageBusinessIntegrations).
  capabilities: { canManageBusinessIntegrations: true },
  capabilitiesStatus: "ready" as const,
  user: {
    id: 1,
    login: "admin",
    name: "Admin",
    email: "admin@example.com",
    avatarUrl: null,
    businessId: "biz-1",
    businessRole: "admin" as const,
    sharedSessions: false,
    linearConnected: false,
    notionConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
  },
}));

const apiMocks = vi.hoisted(() => ({
  fetchRepositoryEnvironmentConfig: vi.fn(),
  upsertRepositoryEnvironmentVariable: vi.fn(),
  deleteRepositoryEnvironmentVariable: vi.fn(),
  importRepositoryEnvironmentVariables: vi.fn(),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/repository-settings.ts", () => ({
  fetchRepositoryEnvironmentConfig: apiMocks.fetchRepositoryEnvironmentConfig,
  upsertRepositoryEnvironmentVariable: apiMocks.upsertRepositoryEnvironmentVariable,
  deleteRepositoryEnvironmentVariable: apiMocks.deleteRepositoryEnvironmentVariable,
  importRepositoryEnvironmentVariables: apiMocks.importRepositoryEnvironmentVariables,
}));

// The Repositories page also mounts the reviewer checklist and the per-repo
// sandbox view; stub their data sources so those sibling sections stay quiet
// while these tests exercise the environment-variable editor.
vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchPrReviewBotSettings: vi.fn(async () => ({
    expectedBots: [],
    mergeConflictResolutionEnabled: true,
  })),
  listPrReviewBotSettings: vi.fn(async () => ({ repositories: [], nextCursor: null })),
  updatePrReviewBotSettings: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/sandbox-layers.ts", () => ({
  fetchSandboxLayerAssignments: vi.fn(async () => ({ businessDefault: null, repoAssignments: [] })),
  fetchSandboxLayerResolutionPreview: vi.fn(async () => ({
    repo: "org/repo-one",
    resourceProfileKey: "org/repo-one",
    selected: null,
    selection: null,
    misses: [],
    latestRepoBuild: null,
    fallback: { reason: "no_sandbox_layer_selected", templateId: "cycloid-base" },
  })),
  fetchSandboxLayerBuildHistory: vi.fn(async () => []),
  fetchSandboxLayerBuildLogs: vi.fn(async () => []),
}));

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
    InputEvent: windowInstance.InputEvent,
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

// The env-var editor now shares the Repositories page with the reviewer checklist
// (which renders its own number/text inputs above the editor), so "first
// non-password input" is no longer the key field. Target the editor's inputs by
// their SettingsField <label htmlFor> wiring instead.
function inputByFieldLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === labelText);
  const id = label?.getAttribute("for");
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
}

// Destructive deletes route through the shared confirm dialog; find the
// confirm/cancel button inside the alertdialog by its label.
function confirmDialogButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  const dialog = container.querySelector('[role="alertdialog"]');
  if (!dialog) return null;
  return (
    ([...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as
      HTMLButtonElement | undefined) ?? null
  );
}

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ConfirmProvider, null, createElement(RepositoriesSettings)));
    await flushAsyncWork();
  });

  for (let i = 0; i < 4; i += 1) {
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

describe("RepositoriesSettings environment variables", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/repositories";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.reposLoaded = true;
    layoutMocks.settings = { defaultRepo: "org/repo-one" };
    apiMocks.fetchRepositoryEnvironmentConfig.mockResolvedValue({
      id: "env-1",
      repoOwner: "org",
      repoName: "repo-one",
      keyNames: ["DATABASE_URL", "OPENAI_API_KEY"],
      createdAt: 1,
      updatedAt: 1,
    });
    apiMocks.upsertRepositoryEnvironmentVariable.mockImplementation(async (_businessId, repoOwner, repoName, key) => ({
      id: "env-1",
      repoOwner,
      repoName,
      keyNames: ["DATABASE_URL", "OPENAI_API_KEY", key].sort(),
      createdAt: 1,
      updatedAt: 2,
    }));
    apiMocks.deleteRepositoryEnvironmentVariable.mockResolvedValue({
      loginEnv: {
        id: "env-1",
        repoOwner: "org",
        repoName: "repo-one",
        keyNames: ["OPENAI_API_KEY"],
        createdAt: 1,
        updatedAt: 3,
      },
      changed: true,
    });
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("loads the default repository and renders masked environment variables", async () => {
    const { container, unmount } = await renderSettings();

    expect(apiMocks.fetchRepositoryEnvironmentConfig).toHaveBeenCalledWith("biz-1", "org", "repo-one");
    expect(container.textContent).toContain("Environment variables");
    expect(container.textContent).toContain("DATABASE_URL");
    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.textContent).toContain("••••••••");

    await unmount();
  });

  it("opens the add-variable form with write-only guidance", async () => {
    const { container, unmount } = await renderSettings();

    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add variable"),
    ) as HTMLButtonElement | undefined;
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton!.click();
      await flushAsyncWork();
    });

    const keyInput = inputByFieldLabel(container, "Key");
    const valueInput = inputByFieldLabel(container, "Value");
    expect(keyInput).toBeTruthy();
    expect(valueInput).toBeTruthy();
    expect(valueInput?.type).toBe("password");
    expect(container.textContent).toContain("Values stay encrypted and write-only");
    expect(apiMocks.upsertRepositoryEnvironmentVariable).not.toHaveBeenCalled();

    await unmount();
  });

  it("deletes a variable from the selected repository only after the confirm dialog", async () => {
    const { container, unmount } = await renderSettings();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete"),
    ) as HTMLButtonElement | undefined;
    expect(deleteButton).toBeTruthy();

    // Cancelling the confirm dialog must not fire the delete.
    await act(async () => {
      deleteButton!.click();
      await flushAsyncWork();
    });
    expect(apiMocks.deleteRepositoryEnvironmentVariable).not.toHaveBeenCalled();
    await act(async () => {
      confirmDialogButton(container, "Cancel")!.click();
      await flushAsyncWork();
    });
    expect(apiMocks.deleteRepositoryEnvironmentVariable).not.toHaveBeenCalled();
    expect(container.textContent).toContain("DATABASE_URL");

    // Confirming fires it.
    await act(async () => {
      deleteButton!.click();
      await flushAsyncWork();
    });
    await act(async () => {
      confirmDialogButton(container, "Delete")!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.deleteRepositoryEnvironmentVariable).toHaveBeenCalledWith(
      "biz-1",
      "org",
      "repo-one",
      "DATABASE_URL",
    );
    expect(container.textContent).not.toContain("DATABASE_URL");
    expect(container.textContent).toContain("OPENAI_API_KEY");

    await unmount();
  });

  it("makes the key immutable when editing an existing variable", async () => {
    const { container, unmount } = await renderSettings();

    const editButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit"),
    ) as HTMLButtonElement | undefined;
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
      await flushAsyncWork();
    });

    const keyInput = inputByFieldLabel(container, "Key");
    expect(keyInput).toBeTruthy();
    expect(keyInput?.disabled).toBe(true);
    expect(container.textContent).toContain("Key cannot be changed when replacing an existing value.");

    await unmount();
  });

  it("allows saving an empty-string value for an existing key", async () => {
    const { container, unmount } = await renderSettings();

    const editButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit"),
    ) as HTMLButtonElement | undefined;
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
      await flushAsyncWork();
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save variable"),
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.upsertRepositoryEnvironmentVariable).toHaveBeenCalledWith(
      "biz-1",
      "org",
      "repo-one",
      "DATABASE_URL",
      "",
      { usageNote: null, sensitive: true },
    );
    expect(container.textContent).not.toContain("Key is required.");

    await unmount();
  });

  it("shows delete errors even when the draft form is closed", async () => {
    apiMocks.deleteRepositoryEnvironmentVariable.mockRejectedValueOnce(new Error("Delete failed"));
    const { container, unmount } = await renderSettings();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete"),
    ) as HTMLButtonElement | undefined;
    expect(deleteButton).toBeTruthy();

    await act(async () => {
      deleteButton!.click();
      await flushAsyncWork();
    });
    await act(async () => {
      confirmDialogButton(container, "Delete")!.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Delete failed");

    await unmount();
  });
});
