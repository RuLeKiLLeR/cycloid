import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeneralSettings } from "../../apps/ui/src/components/settings/GeneralSettings";

// Keep concurrent-save ordering covered independently from the settings API implementation.

const apiMocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchPrReviewBotSettings: vi.fn(),
  listPrReviewBotSettings: vi.fn(),
  updateSettings: vi.fn(),
  updatePrReviewBotSettings: vi.fn(),
}));

const DEFAULT_SETTINGS = vi.hoisted(() => ({
  theme: "system" as const,
  prReviewAutoResponseEnabled: false,
  defaultPrDraft: false,
  autoVerifyEnabled: true,
  automaticReviewsEnabled: false,
  planMode: "off" as "off" | "on" | "auto",
  planApprovalRequired: true,
  settingsProfile: "custom" as "manual" | "autonomous" | "custom",
  defaultModel: null as string | null,
  defaultRepo: null as string | null,
  apiKeys: {},
}));

const layoutMocks = vi.hoisted(() => ({
  models: [] as unknown[],
  onDefaultModelChange: vi.fn(),
  repos: [] as Array<{ fullName: string; url: string; private: boolean; defaultBranch: string }>,
  reposLoaded: true,
  settings: { ...DEFAULT_SETTINGS } as typeof DEFAULT_SETTINGS | null,
  settingsLoaded: true,
  settingsError: null as string | null,
  setSettings: vi.fn(),
  capabilities: { planApproval: false },
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchSettings: apiMocks.fetchSettings,
  fetchPrReviewBotSettings: apiMocks.fetchPrReviewBotSettings,
  listPrReviewBotSettings: apiMocks.listPrReviewBotSettings,
  updateSettings: apiMocks.updateSettings,
  updatePrReviewBotSettings: apiMocks.updatePrReviewBotSettings,
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
    HTMLTextAreaElement: windowInstance.HTMLTextAreaElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    FocusEvent: windowInstance.FocusEvent,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(GeneralSettings));
    await flushAsyncWork();
  });

  return {
    container,
    async rerender() {
      await act(async () => {
        root.render(createElement(GeneralSettings));
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

describe("GeneralSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/general";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.models = [];
    layoutMocks.settings = { ...DEFAULT_SETTINGS };
    layoutMocks.repos = [
      {
        fullName: "org/repo",
        url: "https://github.com/org/repo",
        private: false,
        defaultBranch: "main",
      },
    ];
    layoutMocks.settingsLoaded = true;
    layoutMocks.settingsError = null;
    layoutMocks.capabilities = { planApproval: false };
    layoutMocks.setSettings.mockImplementation((next: unknown) => {
      layoutMocks.settings =
        typeof next === "function"
          ? (next as (prev: typeof layoutMocks.settings) => typeof layoutMocks.settings)(layoutMocks.settings)
          : (next as typeof layoutMocks.settings);
    });
    apiMocks.fetchSettings.mockResolvedValue(layoutMocks.settings ?? DEFAULT_SETTINGS);
    apiMocks.fetchPrReviewBotSettings.mockResolvedValue({ expectedBots: [] });
    apiMocks.listPrReviewBotSettings.mockResolvedValue({ repositories: [], nextCursor: null });
    apiMocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      ...patch,
    }));
    apiMocks.updatePrReviewBotSettings.mockImplementation(async (_owner: string, _repo: string, input) => ({
      expectedBots: input.expectedBots,
      mergeConflictResolutionEnabled: input.mergeConflictResolutionEnabled ?? true,
    }));
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("saves the default repo through the layout context", async () => {
    const { container, unmount } = await renderSettings();
    expect(container.textContent).not.toContain("Custom instructions");
    expect(container.textContent).not.toContain("Environments");

    const selects = Array.from(container.querySelectorAll("select"));
    // The always-on reviewer checklist also renders a repository <select> with an "org/repo"
    // option, so disambiguate the Session-defaults "Default repository" select by its "None" option.
    const repoSelect = selects.find(
      (select) =>
        !select.multiple &&
        Array.from(select.options).some((option) => option.value === "org/repo") &&
        Array.from(select.options).some((option) => option.textContent === "None"),
    );
    expect(repoSelect).toBeTruthy();

    await act(async () => {
      repoSelect!.value = "org/repo";
      repoSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ defaultRepo: "org/repo" });
    expect(layoutMocks.settings).toEqual({
      theme: "system",
      prReviewAutoResponseEnabled: false,
      defaultPrDraft: false,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: false,
      planMode: "off",
      planApprovalRequired: true,
      settingsProfile: "custom",
      defaultModel: null,
      defaultRepo: "org/repo",
      apiKeys: {},
    });

    await unmount();
  });

  it("ignores a stale default-repo save after a newer selection succeeds", async () => {
    layoutMocks.repos = [
      {
        fullName: "org/repo-one",
        url: "https://github.com/org/repo-one",
        private: false,
        defaultBranch: "main",
      },
      {
        fullName: "org/repo-two",
        url: "https://github.com/org/repo-two",
        private: false,
        defaultBranch: "main",
      },
    ];

    const firstSave = deferred<Record<string, unknown>>();
    const secondSave = deferred<Record<string, unknown>>();
    apiMocks.updateSettings.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(secondSave.promise);

    const { container, unmount } = await renderSettings();
    const repoSelect = Array.from(container.querySelectorAll("select")).find(
      (select) =>
        !select.multiple &&
        Array.from(select.options).some((option) => option.value === "org/repo-one") &&
        Array.from(select.options).some((option) => option.value === "org/repo-two") &&
        Array.from(select.options).some((option) => option.textContent === "None"),
    );
    expect(repoSelect).toBeTruthy();

    await act(async () => {
      repoSelect!.value = "org/repo-one";
      repoSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });
    await act(async () => {
      repoSelect!.value = "org/repo-two";
      repoSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    await act(async () => {
      secondSave.resolve({ ...DEFAULT_SETTINGS, defaultRepo: "org/repo-two" });
      await flushAsyncWork();
    });
    await act(async () => {
      firstSave.resolve({ ...DEFAULT_SETTINGS, defaultRepo: "org/repo-one" });
      await flushAsyncWork();
    });

    expect(apiMocks.updateSettings.mock.calls).toEqual([
      [{ defaultRepo: "org/repo-one" }],
      [{ defaultRepo: "org/repo-two" }],
    ]);
    expect(layoutMocks.setSettings).toHaveBeenCalledTimes(1);
    expect(layoutMocks.settings).toEqual({ ...DEFAULT_SETTINGS, defaultRepo: "org/repo-two" });
    expect(container.textContent).not.toContain("Saving…");

    await unmount();
  });

  it("merges concurrent saves for different settings instead of dropping the earlier success", async () => {
    const draftSave = deferred<Record<string, unknown>>();
    const repoSave = deferred<Record<string, unknown>>();
    apiMocks.updateSettings.mockReturnValueOnce(draftSave.promise).mockReturnValueOnce(repoSave.promise);

    const { container, unmount } = await renderSettings();
    const draftToggle = container.querySelector("button[aria-label='Open pull requests as drafts']");
    const repoSelect = Array.from(container.querySelectorAll("select")).find(
      (select) =>
        !select.multiple &&
        Array.from(select.options).some((option) => option.value === "org/repo") &&
        Array.from(select.options).some((option) => option.textContent === "None"),
    );
    expect(draftToggle).toBeTruthy();
    expect(repoSelect).toBeTruthy();

    await act(async () => {
      draftToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });
    await act(async () => {
      repoSelect!.value = "org/repo";
      repoSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    await act(async () => {
      repoSave.resolve({ ...DEFAULT_SETTINGS, defaultRepo: "org/repo" });
      await flushAsyncWork();
    });
    await act(async () => {
      draftSave.resolve({ ...DEFAULT_SETTINGS, defaultPrDraft: true });
      await flushAsyncWork();
    });

    expect(apiMocks.updateSettings.mock.calls).toEqual([[{ defaultPrDraft: true }], [{ defaultRepo: "org/repo" }]]);
    expect(layoutMocks.setSettings).toHaveBeenCalledTimes(2);
    expect(layoutMocks.settings).toEqual({
      ...DEFAULT_SETTINGS,
      defaultPrDraft: true,
      defaultRepo: "org/repo",
    });
    expect(container.textContent).not.toContain("Saving…");

    await unmount();
  });

  it("renders the draft-PR toggle and saves it on", async () => {
    const { container, unmount } = await renderSettings();

    const toggle = container.querySelector("button[aria-label='Open pull requests as drafts']");
    expect(toggle).toBeTruthy();
    expect(container.textContent).toContain("Open pull requests as drafts");

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ defaultPrDraft: true });
    expect(layoutMocks.settings).toEqual({
      theme: "system",
      prReviewAutoResponseEnabled: false,
      defaultPrDraft: true,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: false,
      planMode: "off",
      planApprovalRequired: true,
      settingsProfile: "custom",
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {},
    });

    await unmount();
  });

  it("renders the QA-test toggle and saves it off", async () => {
    const { container, unmount } = await renderSettings();

    const toggle = container.querySelector("button[aria-label='QA-test my PRs at publish']");
    expect(toggle).toBeTruthy();
    expect(container.textContent).toContain("Cycloid runs a QA test on your published PRs");

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ autoVerifyEnabled: false });
    expect(layoutMocks.settings).toEqual({
      theme: "system",
      prReviewAutoResponseEnabled: false,
      defaultPrDraft: false,
      autoVerifyEnabled: false,
      automaticReviewsEnabled: false,
      planMode: "off",
      planApprovalRequired: true,
      settingsProfile: "custom",
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {},
    });

    await unmount();
  });

  it("labels automatic default model selection without referencing GPT-5.4 Mini", async () => {
    layoutMocks.models = [
      {
        id: "openai",
        name: "OpenAI",
        hasApiKey: true,
        models: [
          { id: "gpt-5.5", name: "Launch Default", label: "OpenAI / Launch Default" },
          { id: "gpt-5.4", name: "GPT-5.4", label: "OpenAI / GPT-5.4" },
        ],
      },
      {
        id: "openai",
        name: "OpenAI",
        hasApiKey: true,
        models: [{ id: "gpt-5.4", name: "GPT-5.4", label: "OpenAI / GPT-5.4" }],
      },
    ];

    const { container, unmount } = await renderSettings();
    const defaultModelSelect = Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.textContent === "Auto (Launch Default)"),
    );

    expect(defaultModelSelect).toBeTruthy();
    expect(defaultModelSelect!.textContent).toContain("Auto (Launch Default)");
    expect(defaultModelSelect!.textContent).not.toContain("GPT-5.4 Mini");

    await unmount();
  });

  it("renders and saves every plan mode setting only when plan approval is available", async () => {
    const hidden = await renderSettings();
    expect(hidden.container.querySelector("fieldset[role='radiogroup']")).toBeNull();
    await hidden.unmount();

    layoutMocks.capabilities = { planApproval: true };
    const visible = await renderSettings();
    const group = visible.container.querySelector("fieldset[role='radiogroup']");
    expect(group).toBeTruthy();
    // Accessible name comes from the sr-only <legend>, not aria-label (which
    // would silence the legend for assistive tech).
    expect(group?.querySelector("legend")?.textContent).toBe("Plan generation");
    expect(visible.container.textContent).toContain("When plan generation is off, this setting has no effect.");

    for (const setting of ["auto", "on", "off"] as const) {
      const label = setting === "off" ? "Off" : setting === "auto" ? "Auto" : "On";
      const option = visible.container.querySelector(`input[type='radio'][value='${setting}']`);
      expect(option).toBeTruthy();
      expect(option?.parentElement?.textContent).toBe(label);
      await act(async () => {
        option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushAsyncWork();
      });
      expect(apiMocks.updateSettings).toHaveBeenLastCalledWith({ planMode: setting });
      expect(layoutMocks.settings).toEqual(expect.objectContaining({ planMode: setting }));
      await visible.rerender();
    }

    await visible.unmount();
  });

  it("falls back to /api/settings when bootstrap settings are missing", async () => {
    layoutMocks.settings = null;
    const loadedSettings = {
      theme: "system",
      prReviewAutoResponseEnabled: false,
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {},
    };
    apiMocks.fetchSettings.mockResolvedValueOnce(loadedSettings);

    const view = await renderSettings();

    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSettings).toHaveBeenCalledWith({ scope: "full" });
    expect(layoutMocks.setSettings).toHaveBeenCalledWith(loadedSettings);

    await view.unmount();
  });
});
