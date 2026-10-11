import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewerChecklistSettings } from "../../apps/ui/src/components/settings/ReviewerChecklistSettings";

const apiMocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchPrReviewBotSettings: vi.fn(),
  updatePrReviewBotSettings: vi.fn(),
  listPrReviewBotSettings: vi.fn(),
}));

const DEFAULT_SETTINGS = vi.hoisted(() => ({
  theme: "system" as const,
  prReviewAutoResponseEnabled: false,
  defaultPrDraft: false,
  autoVerifyEnabled: true,
  automaticReviewsEnabled: false,
  useCodexSubscription: false,
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
  user: null as unknown,
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchSettings: apiMocks.fetchSettings,
  updateSettings: apiMocks.updateSettings,
  fetchPrReviewBotSettings: apiMocks.fetchPrReviewBotSettings,
  updatePrReviewBotSettings: apiMocks.updatePrReviewBotSettings,
  listPrReviewBotSettings: apiMocks.listPrReviewBotSettings,
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
    HTMLInputElement: windowInstance.HTMLInputElement,
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

async function renderSettings(props: { repoFullName?: string } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(ReviewerChecklistSettings, props));
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

function optionTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("option")).map((option) => option.textContent ?? "");
}

// Find a button by its exact trimmed text (used for "add" chips, "Custom…",
// "Add", and the "Save changes" / "Discard" footer actions).
function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

function switchByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector(`button[role="switch"][aria-label="${label}"]`);
}

// A selected bot renders as a removable pill with an aria-labelled "×" button.
function removeButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="Remove ${label}"]`);
}

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement).click();
    await flushAsyncWork();
  });
}

describe("ReviewerChecklistSettings PR review bot checklist", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/general";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.models = [];
    layoutMocks.repos = [
      { fullName: "org/repo", url: "https://github.com/org/repo", private: false, defaultBranch: "main" },
      { fullName: "org/other", url: "https://github.com/org/other", private: true, defaultBranch: "main" },
    ];
    layoutMocks.reposLoaded = true;
    layoutMocks.settings = { ...DEFAULT_SETTINGS };
    layoutMocks.settingsLoaded = true;
    layoutMocks.settingsError = null;
    layoutMocks.setSettings.mockImplementation((next: unknown) => {
      layoutMocks.settings =
        typeof next === "function"
          ? (next as (prev: typeof layoutMocks.settings) => typeof layoutMocks.settings)(layoutMocks.settings)
          : (next as typeof layoutMocks.settings);
    });
    apiMocks.fetchSettings.mockResolvedValue(layoutMocks.settings ?? DEFAULT_SETTINGS);
    apiMocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...(layoutMocks.settings ?? DEFAULT_SETTINGS),
      ...patch,
    }));
    apiMocks.fetchPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: true,
    });
    apiMocks.updatePrReviewBotSettings.mockImplementation(
      async (
        _owner: string,
        _repo: string,
        input: {
          expectedBots: unknown;
          ciResponseEnabled?: boolean;
          mergeConflictResolutionEnabled?: boolean;
        },
      ) => ({
        expectedBots: input.expectedBots,
        ciResponseEnabled: input.ciResponseEnabled ?? true,
        mergeConflictResolutionEnabled: input.mergeConflictResolutionEnabled ?? true,
      }),
    );
    apiMocks.listPrReviewBotSettings.mockResolvedValue({
      repositories: [
        {
          repoOwner: "org",
          repoName: "other",
          expectedBots: [{ type: "known", id: "greptile" }],
          ciResponseEnabled: true,
          mergeConflictResolutionEnabled: false,
        },
      ],
      nextCursor: null,
    });
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("loads the selected repo checklist and shows customized repos", async () => {
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "org/repo",
    };
    apiMocks.fetchPrReviewBotSettings.mockResolvedValueOnce({
      expectedBots: [{ type: "known", id: "greptile" }],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: false,
    });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Reviewers Cycloid responds to");
    expect(apiMocks.listPrReviewBotSettings).toHaveBeenCalled();
    expect(apiMocks.fetchPrReviewBotSettings).toHaveBeenCalledWith("org", "repo");
    expect(optionTexts(container)).toContain("org/other · customized");

    // The wait-window control was removed with the reviewTimeoutMinutes setting.
    expect(container.querySelector("input[type='number']")).toBeNull();

    // The saved bot shows up as a removable pill, not as an "add" chip.
    expect(removeButton(container, "Greptile")).toBeTruthy();
    expect(buttonByText(container, "Greptile")).toBeUndefined();

    await unmount();
  });

  it("saves known and custom bots for the selected repo", async () => {
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "org/repo",
    };

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    // Add a known bot by clicking its "add" chip.
    await click(buttonByText(container, "CodeRabbit"));

    // Reveal the custom-login field via the "Custom…" chip, then add a bot.
    await click(buttonByText(container, "Custom…"));
    const customInput = container.querySelector("input[aria-label='Custom bot login']") as HTMLInputElement | null;
    expect(customInput).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(customInput!, "Team-Bot");
      customInput!.dispatchEvent(
        new happyWindow.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Team-Bot" }),
      );
      // Enter submits the custom login (reads the field directly, like the UI).
      customInput!.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flushAsyncWork();
    });

    await click(buttonByText(container, "Save changes"));

    expect(apiMocks.updatePrReviewBotSettings).toHaveBeenCalledWith("org", "repo", {
      expectedBots: [
        { type: "known", id: "coderabbit" },
        { type: "custom", login: "team-bot" },
      ],
      mergeConflictResolutionEnabled: true,
    });

    await unmount();
  });

  it("marks a mixed-case repo as customized after saving bots", async () => {
    layoutMocks.repos = [
      {
        fullName: "TryCycloid/Cycloid",
        url: "https://github.com/TryCycloid/Cycloid",
        private: false,
        defaultBranch: "main",
      },
    ];
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "TryCycloid/Cycloid",
    };
    apiMocks.listPrReviewBotSettings.mockResolvedValueOnce({ repositories: [], nextCursor: null });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    await click(buttonByText(container, "CodeRabbit"));
    await click(buttonByText(container, "Save changes"));

    expect(apiMocks.updatePrReviewBotSettings).toHaveBeenCalledWith("TryCycloid", "Cycloid", {
      expectedBots: [{ type: "known", id: "coderabbit" }],
      mergeConflictResolutionEnabled: true,
    });
    expect(optionTexts(container)).toContain("TryCycloid/Cycloid · customized");

    await unmount();
  });

  it("clears the customized marker for mixed-case repos after emptying the checklist", async () => {
    layoutMocks.repos = [
      {
        fullName: "TryCycloid/Cycloid",
        url: "https://github.com/TryCycloid/Cycloid",
        private: false,
        defaultBranch: "main",
      },
    ];
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "TryCycloid/Cycloid",
    };
    apiMocks.listPrReviewBotSettings.mockResolvedValueOnce({
      repositories: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          expectedBots: [{ type: "known", id: "greptile" }],
          ciResponseEnabled: true,
          mergeConflictResolutionEnabled: true,
        },
      ],
      nextCursor: null,
    });
    apiMocks.fetchPrReviewBotSettings.mockResolvedValueOnce({
      expectedBots: [{ type: "known", id: "greptile" }],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: true,
    });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(optionTexts(container)).toContain("TryCycloid/Cycloid · customized");
    expect(removeButton(container, "Greptile")).toBeTruthy();

    // Remove the only saved bot, then save the now-empty checklist.
    await click(removeButton(container, "Greptile"));
    await click(buttonByText(container, "Save changes"));

    expect(apiMocks.updatePrReviewBotSettings).toHaveBeenCalledWith("TryCycloid", "Cycloid", {
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(optionTexts(container)).toContain("TryCycloid/Cycloid");
    expect(optionTexts(container)).not.toContain("TryCycloid/Cycloid · customized");

    await unmount();
  });

  it("saves an empty checklist after removing all bots", async () => {
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "org/repo",
    };
    apiMocks.fetchPrReviewBotSettings.mockResolvedValueOnce({
      expectedBots: [{ type: "known", id: "greptile" }],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: false,
    });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    await click(removeButton(container, "Greptile"));
    await click(buttonByText(container, "Save changes"));

    expect(apiMocks.updatePrReviewBotSettings).toHaveBeenCalledWith("org", "repo", {
      expectedBots: [],
      mergeConflictResolutionEnabled: false,
    });

    await unmount();
  });

  it("saves disabling merge-conflict resolution as a repo customization without reviewer bots", async () => {
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "org/repo",
    };
    apiMocks.listPrReviewBotSettings.mockResolvedValueOnce({ repositories: [], nextCursor: null });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    await click(switchByLabel(container, "Resolve merge conflicts"));
    expect(buttonByText(container, "Save changes")).toBeTruthy();

    await click(buttonByText(container, "Save changes"));

    expect(apiMocks.updatePrReviewBotSettings).toHaveBeenCalledWith("org", "repo", {
      expectedBots: [],
      mergeConflictResolutionEnabled: false,
    });
    expect(optionTexts(container)).toContain("org/repo · customized");
    expect(container.textContent).toContain("Saved");

    await unmount();
  });

  it("does not offer a save action when there are no unsaved edits", async () => {
    layoutMocks.settings = {
      ...DEFAULT_SETTINGS,
      prReviewAutoResponseEnabled: true,
      defaultRepo: "org/repo",
    };
    apiMocks.fetchPrReviewBotSettings.mockResolvedValueOnce({
      expectedBots: [{ type: "known", id: "greptile" }],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: false,
    });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    // Saved and unchanged → "Saved", no Save/Discard.
    expect(buttonByText(container, "Save changes")).toBeUndefined();
    expect(buttonByText(container, "Discard")).toBeUndefined();
    expect(container.textContent).toContain("Saved");

    await unmount();
  });

  it("summarizes the customized repo count in the collapsed disclosure header", async () => {
    layoutMocks.settings = { ...DEFAULT_SETTINGS, prReviewAutoResponseEnabled: true, defaultRepo: "org/repo" };
    // Default mock configures 1 of the 2 repos (org/other).
    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("1 of 2 repos customized");

    await unmount();
  });

  it("describes an empty checklist without a saved/unsaved status", async () => {
    layoutMocks.settings = { ...DEFAULT_SETTINGS, prReviewAutoResponseEnabled: true, defaultRepo: "org/repo" };
    apiMocks.listPrReviewBotSettings.mockResolvedValueOnce({ repositories: [], nextCursor: null });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("No repo-specific PR settings yet");
    expect(container.textContent).not.toContain("Unsaved changes");
    expect(container.textContent).not.toContain("Saved");

    await unmount();
  });

  it("surfaces a failed customized-repos load in the disclosure summary", async () => {
    layoutMocks.settings = { ...DEFAULT_SETTINGS, prReviewAutoResponseEnabled: true, defaultRepo: "org/repo" };
    apiMocks.listPrReviewBotSettings.mockRejectedValueOnce(new Error("boom"));

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Couldn't load repo customizations");

    await unmount();
  });

  // Regression: the customized set is business-wide, but the summary count must
  // only include repos the current user can see, so the numerator can never
  // exceed `repos.length` (e.g. an admin customized a repo this member can't view).
  it("ignores customized repos the current user cannot see in the summary count", async () => {
    layoutMocks.settings = { ...DEFAULT_SETTINGS, prReviewAutoResponseEnabled: true, defaultRepo: "org/repo" };
    // Three customized repos, but only org/other is in the user's two visible repos.
    apiMocks.listPrReviewBotSettings.mockResolvedValueOnce({
      repositories: [
        {
          repoOwner: "org",
          repoName: "other",
          expectedBots: [{ type: "known", id: "greptile" }],
          ciResponseEnabled: true,
          mergeConflictResolutionEnabled: false,
        },
        {
          repoOwner: "org",
          repoName: "hidden-one",
          expectedBots: [{ type: "known", id: "greptile" }],
          ciResponseEnabled: true,
          mergeConflictResolutionEnabled: false,
        },
        {
          repoOwner: "org",
          repoName: "hidden-two",
          expectedBots: [{ type: "known", id: "greptile" }],
          ciResponseEnabled: true,
          mergeConflictResolutionEnabled: false,
        },
      ],
      nextCursor: null,
    });

    const { container, unmount } = await renderSettings();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("1 of 2 repos customized");
    expect(container.textContent).not.toContain("3 of 2");

    await unmount();
  });

  it("scopes the collapsed summary to the selected repo in controlled mode", async () => {
    // Controlled by the Repositories page picker: the summary must describe the
    // selected repo, not a business-wide "N of M repos customized" readout.
    layoutMocks.settings = { ...DEFAULT_SETTINGS, prReviewAutoResponseEnabled: true, defaultRepo: "org/repo" };
    apiMocks.fetchPrReviewBotSettings.mockResolvedValueOnce({
      expectedBots: [{ type: "known", id: "greptile" }],
      ciResponseEnabled: true,
      mergeConflictResolutionEnabled: false,
    });

    const { container, unmount } = await renderSettings({ repoFullName: "org/repo" });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchPrReviewBotSettings).toHaveBeenCalledWith("org", "repo");
    expect(container.textContent).toContain("1 reviewer selected for this repository");
    expect(container.textContent).not.toContain("repos customized");
    expect(container.textContent).toContain("on this repository before it batches a response");

    await unmount();
  });
});
