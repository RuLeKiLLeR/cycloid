import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeysSection } from "../../apps/ui/src/components/settings/ApiKeysSettings";
import type { UserIntegrations } from "../../apps/ui/src/types";

const apiMocks = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    data?: unknown;

    constructor(message: string, status: number, code?: string, data?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.data = data;
    }
  },
  fetchSettings: vi.fn(),
  fetchCodexSubscriptionState: vi.fn(),
  fetchUserIntegrations: vi.fn(),
  setProviderApiKey: vi.fn(),
  clearProviderApiKey: vi.fn(),
  setCodexSubscriptionAuthJson: vi.fn(),
  clearCodexSubscriptionAuthJson: vi.fn(),
  updateSettings: vi.fn(),
}));

const DEFAULT_SETTINGS = vi.hoisted(() => ({
  theme: "system",
  prReviewAutoResponseEnabled: true,
  defaultPrDraft: false,
  autoVerifyEnabled: true,
  automaticReviewsEnabled: false,
  useCodexSubscription: false,
  defaultModel: null as string | null,
  defaultRepo: null as string | null,
  apiKeys: {},
}));

const layoutMocks = vi.hoisted(() => ({
  user: null as { isCycloidAdmin?: boolean } | null,
  capabilities: { canUseInternalModelProviderKeys: false },
  settings: { ...DEFAULT_SETTINGS } as typeof DEFAULT_SETTINGS | null,
  settingsLoaded: true,
  settingsError: null,
  setSettings: vi.fn(),
  refreshModels: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/client.ts", () => ({
  ApiError: apiMocks.ApiError,
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchSettings: apiMocks.fetchSettings,
  fetchCodexSubscriptionState: apiMocks.fetchCodexSubscriptionState,
  setProviderApiKey: apiMocks.setProviderApiKey,
  clearProviderApiKey: apiMocks.clearProviderApiKey,
  setCodexSubscriptionAuthJson: apiMocks.setCodexSubscriptionAuthJson,
  clearCodexSubscriptionAuthJson: apiMocks.clearCodexSubscriptionAuthJson,
  updateSettings: apiMocks.updateSettings,
}));

vi.mock("../../apps/ui/src/api/integrations.ts", () => ({
  fetchUserIntegrations: apiMocks.fetchUserIntegrations,
  fetchMcpServers: vi.fn(async () => []),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  validateMcpServer: vi.fn(),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
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

const INTEGRATIONS: UserIntegrations = {
  availableIntegrations: ["openai"],
  integrationTools: [],
  integrationScopes: { openai: "user" },
};

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
    HTMLInputElement: windowInstance.HTMLInputElement,
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
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));

  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[reactPropsKey]
    : null;
  reactProps?.onChange?.({ target: input });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));

  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (textarea as unknown as Record<string, { onChange?: (event: { target: HTMLTextAreaElement }) => void }>)[
        reactPropsKey
      ]
    : null;
  reactProps?.onChange?.({ target: textarea });
}

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ApiKeysSection, { integrations: INTEGRATIONS }));
    await flushAsyncWork();
  });

  return {
    container,
    async rerender() {
      await act(async () => {
        root.render(createElement(ApiKeysSection, { integrations: INTEGRATIONS }));
        await flushAsyncWork();
      });
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

describe("ApiKeysSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/integrations";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.user = null;
    layoutMocks.capabilities = { canUseInternalModelProviderKeys: false };
    layoutMocks.settings = { ...DEFAULT_SETTINGS };
    layoutMocks.settingsLoaded = true;
    layoutMocks.settingsError = null;
    layoutMocks.refreshModels.mockResolvedValue(undefined);
    apiMocks.fetchCodexSubscriptionState.mockResolvedValue({
      eligible: true,
      credential: {
        isSet: false,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      },
    });
    layoutMocks.setSettings.mockImplementation((next: unknown) => {
      layoutMocks.settings =
        typeof next === "function"
          ? (next as (prev: typeof layoutMocks.settings) => typeof layoutMocks.settings)(layoutMocks.settings)
          : (next as typeof layoutMocks.settings);
    });
    apiMocks.fetchSettings.mockResolvedValue(layoutMocks.settings ?? DEFAULT_SETTINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a validated saved key state", async () => {
    layoutMocks.settings = {
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      apiKeys: {
        openai: {
          isSet: true,
          lastValidatedAt: 123,
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        },
      },
    };

    const { container, unmount } = await renderSettings();
    expect(container.textContent).toContain("Key validated");
    await unmount();
  });

  it("renders an unverified saved key state", async () => {
    layoutMocks.settings = {
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      apiKeys: {
        openai: {
          isSet: true,
          lastValidatedAt: 456,
          lastValidationStatus: "saved_unverified",
          lastValidationReasonCode: "network_validation_skipped",
        },
      },
    };

    const { container, unmount } = await renderSettings();
    expect(container.textContent).toContain("Saved (unverified).");
    await unmount();
  });

  it("updates the visible key state and refreshes models after a successful save", async () => {
    apiMocks.setProviderApiKey.mockResolvedValueOnce({
      isSet: true,
      lastValidatedAt: 123,
      lastValidationStatus: "validated",
      lastValidationReasonCode: null,
    });

    const { container, unmount } = await renderSettings();
    const input = Array.from(container.querySelectorAll("input")).find(
      (candidate) => candidate.getAttribute("placeholder") === "sk-…",
    );
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input!, "sk-test");
      await flushAsyncWork();
    });

    const save = Array.from(input!.closest("li")!.querySelectorAll("button")).find(
      (button) => button.textContent === "Save key",
    );
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);

    await act(async () => {
      save!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setProviderApiKey).toHaveBeenCalledWith("openai", "sk-test");
    expect(container.textContent).toContain("Key validated");
    expect(layoutMocks.refreshModels).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("updates the visible key state and refreshes models after a successful removal", async () => {
    layoutMocks.settings = {
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      apiKeys: {
        openai: {
          isSet: true,
          lastValidatedAt: 123,
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        },
      },
    };
    apiMocks.clearProviderApiKey.mockResolvedValueOnce({
      isSet: false,
      lastValidatedAt: null,
      lastValidationStatus: null,
      lastValidationReasonCode: null,
    });

    const { container, unmount } = await renderSettings();
    const remove = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Remove");
    expect(remove).toBeTruthy();

    await act(async () => {
      remove!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.clearProviderApiKey).toHaveBeenCalledWith("openai");
    expect(container.querySelector("input")).toBeTruthy();
    expect(container.textContent).toContain("Save");
    expect(layoutMocks.refreshModels).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("refreshes models after saving Codex subscription auth.json", async () => {
    layoutMocks.user = { isCycloidAdmin: true };
    layoutMocks.settings = {
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      useCodexSubscription: true,
    };
    apiMocks.setCodexSubscriptionAuthJson.mockResolvedValueOnce({
      isSet: true,
      lastValidatedAt: 789,
      lastValidationStatus: "validated",
      lastValidationReasonCode: null,
    });

    const { container, unmount } = await renderSettings();
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();

    await act(async () => {
      setTextareaValue(textarea!, '{"tokens":{"id_token":"test"}}');
      await flushAsyncWork();
    });

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save auth.json",
    );
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);

    await act(async () => {
      save!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.setCodexSubscriptionAuthJson).toHaveBeenCalledWith('{"tokens":{"id_token":"test"}}');
    expect(layoutMocks.refreshModels).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("refreshes models after clearing Codex subscription auth.json", async () => {
    layoutMocks.user = { isCycloidAdmin: true };
    layoutMocks.settings = {
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      useCodexSubscription: true,
    };
    apiMocks.fetchCodexSubscriptionState.mockResolvedValueOnce({
      eligible: true,
      credential: {
        isSet: true,
        lastValidatedAt: 789,
        lastValidationStatus: "validated",
        lastValidationReasonCode: null,
      },
    });
    apiMocks.clearCodexSubscriptionAuthJson.mockResolvedValueOnce({
      isSet: false,
      lastValidatedAt: null,
      lastValidationStatus: null,
      lastValidationReasonCode: null,
    });

    const { container, unmount } = await renderSettings();
    const remove = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Remove");
    expect(remove).toBeTruthy();

    await act(async () => {
      remove!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.clearCodexSubscriptionAuthJson).toHaveBeenCalledTimes(1);
    expect(layoutMocks.refreshModels).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("hides the Anthropic key field even when anthropic is an available integration", async () => {
    const integrationsWithAnthropic: UserIntegrations = {
      availableIntegrations: ["openai", "anthropic"],
      integrationTools: [],
      integrationScopes: { openai: "user", anthropic: "user" },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(createElement(ApiKeysSection, { integrations: integrationsWithAnthropic }));
      await flushAsyncWork();
    });

    // OpenAI is still shown; Anthropic is gated out of the customer UI entirely.
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).not.toContain("Anthropic");
    const placeholders = Array.from(container.querySelectorAll("input")).map((input) =>
      input.getAttribute("placeholder"),
    );
    expect(placeholders.some((placeholder) => placeholder?.includes("sk-ant-"))).toBe(false);

    await act(async () => {
      root.unmount();
      await flushAsyncWork();
    });
    container.remove();
  });

  it("shows the Baseten key field to customers even though it is not toggleable", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(createElement(ApiKeysSection, { integrations: INTEGRATIONS }));
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("Baseten");
    const placeholders = Array.from(container.querySelectorAll("input")).map((input) =>
      input.getAttribute("placeholder"),
    );
    expect(placeholders).toContain("Baseten API key");

    await act(async () => {
      root.unmount();
      await flushAsyncWork();
    });
    container.remove();
  });

  it("shows the Anthropic key field to Cycloid members even when it is not an available integration", async () => {
    layoutMocks.capabilities = { canUseInternalModelProviderKeys: true };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(createElement(ApiKeysSection, { integrations: INTEGRATIONS }));
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("Anthropic");
    const placeholders = Array.from(container.querySelectorAll("input")).map((input) =>
      input.getAttribute("placeholder"),
    );
    expect(placeholders.some((placeholder) => placeholder?.includes("sk-ant-"))).toBe(true);

    await act(async () => {
      root.unmount();
      await flushAsyncWork();
    });
    container.remove();
  });

  it("continues showing the Baseten key field to Cycloid members", async () => {
    layoutMocks.capabilities = { canUseInternalModelProviderKeys: true };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(createElement(ApiKeysSection, { integrations: INTEGRATIONS }));
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("Baseten");
    const placeholders = Array.from(container.querySelectorAll("input")).map((input) =>
      input.getAttribute("placeholder"),
    );
    expect(placeholders).toContain("Baseten API key");

    await act(async () => {
      root.unmount();
      await flushAsyncWork();
    });
    container.remove();
  });

  it("falls back to /api/settings when bootstrap settings are missing", async () => {
    layoutMocks.settings = null;
    const loadedSettings = {
      theme: "system",
      prReviewAutoResponseEnabled: true,
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {
        openai: {
          isSet: true,
          lastValidatedAt: 123,
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        },
      },
    };
    apiMocks.fetchSettings.mockResolvedValueOnce(loadedSettings);

    const view = await renderSettings();

    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSettings).toHaveBeenCalledWith({ scope: "full" });
    expect(layoutMocks.setSettings).toHaveBeenCalledWith(loadedSettings);

    await view.rerender();
    expect(view.container.textContent).toContain("Key validated");

    await view.unmount();
  });

  it("retries the settings fetch when the error action is clicked", async () => {
    layoutMocks.settings = null;
    apiMocks.fetchSettings.mockReset();
    apiMocks.fetchSettings.mockRejectedValueOnce(new Error("boom"));

    const view = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
    const retry = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Try again");
    expect(retry).toBeTruthy();

    const loadedSettings = { ...DEFAULT_SETTINGS, apiKeys: {} };
    apiMocks.fetchSettings.mockResolvedValueOnce(loadedSettings);
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(layoutMocks.setSettings).toHaveBeenCalledWith(loadedSettings);

    await view.unmount();
  });
});
