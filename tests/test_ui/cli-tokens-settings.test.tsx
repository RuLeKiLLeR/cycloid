import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { CliTokensSettings } from "../../apps/ui/src/components/settings/CliTokensSettings";

const apiMocks = vi.hoisted(() => ({
  fetchCliTokens: vi.fn(),
  createCliToken: vi.fn(),
  revokeCliToken: vi.fn(),
  deleteCliToken: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/cli-tokens.ts", () => ({
  fetchCliTokens: apiMocks.fetchCliTokens,
  createCliToken: apiMocks.createCliToken,
  revokeCliToken: apiMocks.revokeCliToken,
  deleteCliToken: apiMocks.deleteCliToken,
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
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    HTMLInputElement: windowInstance.HTMLInputElement,
    SVGElement: windowInstance.SVGElement,
    KeyboardEvent: windowInstance.KeyboardEvent,
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
  await Promise.resolve();
}

async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  { attempts = 50 }: { attempts?: number } = {},
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
    const result = predicate();
    if (result) return result;
  }
  throw new Error(`waitFor timed out after ${attempts} attempts`);
}

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ConfirmProvider, null, createElement(CliTokensSettings)));
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

describe("CliTokensSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/cli-tokens";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    apiMocks.fetchCliTokens.mockResolvedValue({ data: [], nextCursor: null });
    apiMocks.createCliToken.mockResolvedValue({ ok: true, token: "arc_write", id: 2, scope: "write" });
    apiMocks.revokeCliToken.mockResolvedValue(undefined);
    apiMocks.deleteCliToken.mockResolvedValue(undefined);
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("defaults new token scope to read", async () => {
    const { container, unmount } = await renderSettings();

    const scopeSelect = container.querySelector("select[name='scope']") as HTMLSelectElement | null;
    expect(scopeSelect?.value).toBe("read");

    await unmount();
  });

  it("creates a token with the selected write scope", async () => {
    const { container, unmount } = await renderSettings();
    const scopeSelect = container.querySelector("select[name='scope']") as HTMLSelectElement | null;
    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create",
    );

    expect(scopeSelect).not.toBeNull();
    expect(createButton).toBeTruthy();

    await act(async () => {
      scopeSelect!.value = "write";
      scopeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    await act(async () => {
      createButton!.click();
    });
    await waitFor(() => (apiMocks.createCliToken.mock.calls.length > 0 ? true : null));

    expect(apiMocks.createCliToken).toHaveBeenCalledWith({ expiresInDays: undefined, scope: "write" });
    await waitFor(() => (container.textContent?.includes("Write token created") ? true : null));

    await unmount();
  });

  it("renders the scope for existing tokens", async () => {
    apiMocks.fetchCliTokens.mockResolvedValue({
      data: [
        {
          id: 1,
          tokenPrefix: "arc_1234",
          scope: "write",
          createdAt: Date.UTC(2026, 0, 1),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
      nextCursor: null,
    });

    const { container, unmount } = await renderSettings();

    expect(container.textContent).toContain("arc_1234");
    expect(container.textContent).toContain("Write");

    await unmount();
  });

  it("requires confirmation before revoking a token and revokes on confirm", async () => {
    apiMocks.fetchCliTokens.mockResolvedValue({
      data: [
        {
          id: 7,
          tokenPrefix: "arc_beef",
          scope: "read",
          createdAt: Date.UTC(2026, 0, 1),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
      nextCursor: null,
    });

    const { container, unmount } = await renderSettings();

    const revokeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Revoke",
    ) as HTMLButtonElement;
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      revokeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    // Confirmation dialog opens; the API is not called yet.
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("arc_beef");
    expect(apiMocks.revokeCliToken).not.toHaveBeenCalled();

    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Revoke",
    ) as HTMLButtonElement;
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.revokeCliToken.mock.calls.length > 0 ? true : null));

    expect(apiMocks.revokeCliToken).toHaveBeenCalledWith(7);

    await unmount();
  });

  it("does not revoke when the confirmation is cancelled", async () => {
    apiMocks.fetchCliTokens.mockResolvedValue({
      data: [
        {
          id: 7,
          tokenPrefix: "arc_beef",
          scope: "read",
          createdAt: Date.UTC(2026, 0, 1),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
      nextCursor: null,
    });

    const { container, unmount } = await renderSettings();

    const revokeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Revoke",
    ) as HTMLButtonElement;

    await act(async () => {
      revokeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const dialog = container.querySelector('[role="alertdialog"]');
    const cancelButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;

    await act(async () => {
      cancelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.revokeCliToken).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    await unmount();
  });

  it("keeps token creation available when an active token exists", async () => {
    apiMocks.fetchCliTokens.mockResolvedValue({
      data: [
        {
          id: 1,
          tokenPrefix: "arc_1234",
          scope: "read",
          createdAt: Date.UTC(2026, 0, 1),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
      nextCursor: null,
    });

    const { container, unmount } = await renderSettings();

    expect(container.querySelector("select[name='scope']")).not.toBeNull();
    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create",
    );
    expect(createButton).toBeTruthy();

    await unmount();
  });
});
