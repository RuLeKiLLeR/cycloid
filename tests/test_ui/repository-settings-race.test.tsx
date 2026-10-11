import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { RepositoryEnvVarsSettings } from "../../apps/ui/src/components/settings/RepositoryEnvVarsSettings";

// Regression suite for ARC-1555: switching repositories mid save/delete/import must
// not let a stale (previous-repo) mutation response clobber the newly selected repo's
// env-var config or paint its error. The editor is driven by an external `selectedRepo`
// prop, so we render it directly and re-render with a new prop to simulate the switch.

const layoutMocks = vi.hoisted(() => ({
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

// Capture the onStore callback the editor passes to ImportSecretsModal so the import
// race can be driven with the same deferred-promise control as save/delete, exercising
// the real guarded closure without depending on the modal's internal UI.
const importModalMock = vi.hoisted(() => ({
  onStore: null as null | ((args: { scope: string; text: string; sensitive: boolean }) => Promise<void>),
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

vi.mock("../../apps/ui/src/components/settings/ImportSecretsModal.tsx", () => ({
  ImportSecretsModal: (props: {
    onStore: (args: { scope: string; text: string; sensitive: boolean }) => Promise<void>;
  }) => {
    importModalMock.onStore = props.onStore;
    return null;
  },
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function envConfig(repoName: string, keyNames: string[]) {
  return { id: `env-${repoName}`, repoOwner: "org", repoName, keyNames, createdAt: 1, updatedAt: 1 };
}

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
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonsByText(container: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.includes(text) && !button.closest('[role="alertdialog"]'),
  ) as HTMLButtonElement[];
}

// Deletes route through the shared confirm dialog; click a row Delete, then
// confirm inside the alertdialog to actually fire the mutation.
function confirmDialogButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  const dialog = container.querySelector('[role="alertdialog"]');
  return (
    ([...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) as
      HTMLButtonElement | undefined) ?? null
  );
}

function inputByFieldLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === labelText);
  const id = label?.getAttribute("for");
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
  }
}

async function renderEditor(selectedRepo: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ConfirmProvider, null, createElement(RepositoryEnvVarsSettings, { selectedRepo })));
    await flushAsyncWork();
  });
  await settle();

  return {
    container,
    async rerender(nextRepo: string) {
      await act(async () => {
        root.render(
          createElement(ConfirmProvider, null, createElement(RepositoryEnvVarsSettings, { selectedRepo: nextRepo })),
        );
        await flushAsyncWork();
      });
      await settle();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

describe("RepositoryEnvVarsSettings repo-switch races (ARC-1555)", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/repositories";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    importModalMock.onStore = null;
    apiMocks.fetchRepositoryEnvironmentConfig.mockImplementation(async (_businessId, _owner, repoName) =>
      repoName === "repo-one"
        ? envConfig("repo-one", ["DATABASE_URL", "OPENAI_API_KEY"])
        : envConfig("repo-two", ["VAR_TWO"]),
    );
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("stale delete response does not overwrite the newly selected repo's config", async () => {
    const deleteDeferred = createDeferred<{ loginEnv: unknown; changed: boolean }>();
    apiMocks.deleteRepositoryEnvironmentVariable.mockReturnValueOnce(deleteDeferred.promise);

    const editor = await renderEditor("org/repo-one");
    expect(editor.container.textContent).toContain("DATABASE_URL");

    const deleteButton = buttonsByText(editor.container, "Delete")[0];
    expect(deleteButton).toBeTruthy();
    await act(async () => {
      deleteButton.click();
      await flushAsyncWork();
    });
    await act(async () => {
      confirmDialogButton(editor.container, "Delete")!.click();
      await flushAsyncWork();
    });

    // Switch to repo-two before the slow delete resolves; its fetch resolves fast.
    await editor.rerender("org/repo-two");
    expect(editor.container.textContent).toContain("VAR_TWO");

    // Resolve the stale delete with repo-one data.
    await act(async () => {
      deleteDeferred.resolve({ loginEnv: envConfig("repo-one", ["OPENAI_API_KEY"]), changed: true });
      await flushAsyncWork();
    });

    // The guard must drop the stale response: repo-two's config stays.
    expect(editor.container.textContent).toContain("VAR_TWO");
    expect(editor.container.textContent).not.toContain("OPENAI_API_KEY");
    expect(editor.container.textContent).not.toContain("DATABASE_URL");
    // Progress flag reset unconditionally; no stuck "Deleting…" state.
    expect(editor.container.textContent).not.toContain("Deleting…");

    await editor.unmount();
  });

  it("stale delete rejection does not paint an error on the newly selected repo", async () => {
    const deleteDeferred = createDeferred<{ loginEnv: unknown; changed: boolean }>();
    apiMocks.deleteRepositoryEnvironmentVariable.mockReturnValueOnce(deleteDeferred.promise);

    const editor = await renderEditor("org/repo-one");
    const deleteButton = buttonsByText(editor.container, "Delete")[0];
    await act(async () => {
      deleteButton.click();
      await flushAsyncWork();
    });
    await act(async () => {
      confirmDialogButton(editor.container, "Delete")!.click();
      await flushAsyncWork();
    });

    await editor.rerender("org/repo-two");

    await act(async () => {
      deleteDeferred.reject(new Error("stale-delete-boom"));
      await flushAsyncWork();
    });

    expect(editor.container.textContent).toContain("VAR_TWO");
    expect(editor.container.textContent).not.toContain("stale-delete-boom");
    expect(editor.container.textContent).not.toContain("Failed to delete");

    await editor.unmount();
  });

  it("delete on the still-selected repo updates config normally", async () => {
    apiMocks.deleteRepositoryEnvironmentVariable.mockResolvedValueOnce({
      loginEnv: envConfig("repo-one", ["OPENAI_API_KEY"]),
      changed: true,
    });

    const editor = await renderEditor("org/repo-one");
    const deleteButton = buttonsByText(editor.container, "Delete")[0];
    await act(async () => {
      deleteButton.click();
      await flushAsyncWork();
    });
    await act(async () => {
      confirmDialogButton(editor.container, "Delete")!.click();
      await flushAsyncWork();
    });
    await settle();

    expect(editor.container.textContent).not.toContain("DATABASE_URL");
    expect(editor.container.textContent).toContain("OPENAI_API_KEY");

    await editor.unmount();
  });

  it("stale save response does not overwrite the newly selected repo's config", async () => {
    const saveDeferred = createDeferred<unknown>();
    apiMocks.upsertRepositoryEnvironmentVariable.mockReturnValueOnce(saveDeferred.promise);

    const editor = await renderEditor("org/repo-one");
    const editButton = buttonsByText(editor.container, "Edit")[0];
    await act(async () => {
      editButton.click();
      await flushAsyncWork();
    });

    const saveButton = buttonsByText(editor.container, "Save variable")[0];
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton.click();
      await flushAsyncWork();
    });

    await editor.rerender("org/repo-two");
    expect(editor.container.textContent).toContain("VAR_TWO");

    await act(async () => {
      saveDeferred.resolve(envConfig("repo-one", ["DATABASE_URL", "OPENAI_API_KEY", "STALE_SAVE_KEY"]));
      await flushAsyncWork();
    });

    expect(editor.container.textContent).toContain("VAR_TWO");
    expect(editor.container.textContent).not.toContain("STALE_SAVE_KEY");
    expect(editor.container.textContent).not.toContain("OPENAI_API_KEY");

    await editor.unmount();
  });

  it("save on the still-selected repo updates config normally", async () => {
    apiMocks.upsertRepositoryEnvironmentVariable.mockResolvedValueOnce(
      envConfig("repo-one", ["DATABASE_URL", "NEW_SAVE_KEY", "OPENAI_API_KEY"]),
    );

    const editor = await renderEditor("org/repo-one");
    const editButton = buttonsByText(editor.container, "Edit")[0];
    await act(async () => {
      editButton.click();
      await flushAsyncWork();
    });

    // Add a value so save has something to send, then submit.
    const valueInput = inputByFieldLabel(editor.container, "New value");
    expect(valueInput).toBeTruthy();
    const saveButton = buttonsByText(editor.container, "Save variable")[0];
    await act(async () => {
      saveButton.click();
      await flushAsyncWork();
    });
    await settle();

    expect(editor.container.textContent).toContain("NEW_SAVE_KEY");

    await editor.unmount();
  });

  it("stale import response does not overwrite the newly selected repo's config", async () => {
    const importDeferred = createDeferred<{ loginEnv: unknown; importedCount: number }>();
    apiMocks.importRepositoryEnvironmentVariables.mockReturnValueOnce(importDeferred.promise);

    const editor = await renderEditor("org/repo-one");
    const onStoreRepoOne = importModalMock.onStore;
    expect(onStoreRepoOne).toBeTruthy();

    let storePromise!: Promise<void>;
    await act(async () => {
      storePromise = onStoreRepoOne!({ scope: "repository", text: "STALE_IMPORT_KEY=v", sensitive: true });
      await flushAsyncWork();
    });

    await editor.rerender("org/repo-two");
    expect(editor.container.textContent).toContain("VAR_TWO");

    await act(async () => {
      importDeferred.resolve({ loginEnv: envConfig("repo-one", ["STALE_IMPORT_KEY"]), importedCount: 1 });
      await storePromise;
      await flushAsyncWork();
    });

    expect(editor.container.textContent).toContain("VAR_TWO");
    expect(editor.container.textContent).not.toContain("STALE_IMPORT_KEY");

    await editor.unmount();
  });

  it("import on the still-selected repo updates config normally", async () => {
    apiMocks.importRepositoryEnvironmentVariables.mockResolvedValueOnce({
      loginEnv: envConfig("repo-one", ["DATABASE_URL", "IMPORTED_KEY", "OPENAI_API_KEY"]),
      importedCount: 1,
    });

    const editor = await renderEditor("org/repo-one");
    const onStore = importModalMock.onStore;
    expect(onStore).toBeTruthy();

    await act(async () => {
      await onStore!({ scope: "repository", text: "IMPORTED_KEY=v", sensitive: true });
      await flushAsyncWork();
    });
    await settle();

    expect(editor.container.textContent).toContain("IMPORTED_KEY");

    await editor.unmount();
  });
});
