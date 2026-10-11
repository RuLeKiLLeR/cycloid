import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { SlackAlertAutomationSettings } from "../../apps/ui/src/components/settings/SlackAlertAutomationSettings";

// -----------------------------------------------------------------------------
// Mocks
//
// The Slack alert automation controls split out of the former
// BusinessIntegrationsSettings mega-page. They now live in
// SlackAlertAutomationSettings, mounted on the Automations route. It renders from
// props (businessId/repos/reposLoaded/defaultRepo), so these tests drive it
// directly rather than through the AutomationsSettings page wrapper.
// -----------------------------------------------------------------------------

const layoutMocks = vi.hoisted(() => ({
  models: [
    {
      id: "baseten",
      name: "Baseten",
      hasApiKey: true,
      models: [
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", label: "Baseten / Kimi K2.7 Code", backends: ["codex"] },
      ],
    },
  ],
}));

const apiMocks = vi.hoisted(() => ({
  fetchSlackChannelMemorySettings: vi.fn(async () => ({ intake: [], workspaces: [] })),
  fetchSlackWorkspaceMemoryChannels: vi.fn(async () => [
    { id: "C_TEST", name: "engineering", isPrivate: false, isMember: true },
    { id: "C_OTHER", name: "sales", isPrivate: false, isMember: true },
  ]),
  fetchSlackAlertAutomationRules: vi.fn(async () => []),
  detectSlackAlertSenders: vi.fn(async () => []),
  saveSlackAlertAutomationRule: vi.fn(),
  deleteSlackAlertAutomationRule: vi.fn(async () => undefined),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/api/company-memory.ts", () => ({
  fetchSlackChannelMemorySettings: apiMocks.fetchSlackChannelMemorySettings,
  fetchSlackWorkspaceMemoryChannels: apiMocks.fetchSlackWorkspaceMemoryChannels,
  fetchSlackAlertAutomationRules: apiMocks.fetchSlackAlertAutomationRules,
  detectSlackAlertSenders: apiMocks.detectSlackAlertSenders,
  saveSlackAlertAutomationRule: apiMocks.saveSlackAlertAutomationRule,
  deleteSlackAlertAutomationRule: apiMocks.deleteSlackAlertAutomationRule,
}));

// Run useSyncEffect eagerly so async loads happen under act.
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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (textarea as unknown as Record<string, { onChange?: (event: { currentTarget: HTMLTextAreaElement }) => void }>)[
        reactPropsKey
      ]
    : null;
  reactProps?.onChange?.({ currentTarget: textarea });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  const reactPropsKey = Object.keys(select).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (select as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>)[
        reactPropsKey
      ]
    : null;
  reactProps?.onChange?.({ target: select });
}

async function render(repos: Array<{ fullName: string }> = [{ fullName: "trycycloid/cycloid" }]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        ConfirmProvider,
        null,
        createElement(SlackAlertAutomationSettings, {
          businessId: "biz-1",
          repos,
          reposLoaded: true,
          defaultRepo: repos[0]?.fullName ?? null,
        }),
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

describe("SlackAlertAutomationSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/automations";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();

    layoutMocks.models = [
      {
        id: "baseten",
        name: "Baseten",
        hasApiKey: true,
        models: [
          { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", label: "Baseten / Kimi K2.7 Code", backends: ["codex"] },
        ],
      },
    ];
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
    apiMocks.fetchSlackAlertAutomationRules.mockResolvedValue([]);
    apiMocks.detectSlackAlertSenders.mockResolvedValue([]);
    apiMocks.deleteSlackAlertAutomationRule.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Slack alert automation rules with sender IDs in tooltips", async () => {
    apiMocks.fetchSlackAlertAutomationRules.mockResolvedValue([
      {
        id: "rule-1",
        businessId: "biz-1",
        configuredByUserId: "1",
        name: "Datadog alerts",
        triggerKind: "slack_channel_message",
        triggerProvider: "datadog",
        slackTeamId: "T_TEST",
        slackChannelId: "C_TEST",
        slackBotUserId: null,
        allowedSlackAppIds: ["A_DATADOG"],
        allowedSlackBotIds: ["B_DATADOG"],
        repoOwner: "trycycloid",
        repoName: "cycloid",
        installationId: 123,
        modelId: "kimi-k2.7-code",
        promptTemplate: "Investigate this Datadog alert.",
        enabled: true,
        createdAt: 1_780_000_000_000,
        updatedAt: 1_780_000_000_000,
      },
    ]);

    const { container, unmount } = await render();

    expect(apiMocks.fetchSlackAlertAutomationRules).toHaveBeenCalledWith("biz-1");
    expect(container.textContent).toContain("Slack alert triggers");
    expect(container.textContent).toContain("Datadog");
    expect(container.textContent).toContain("Trigger instructions");
    expect(container.textContent).toContain(
      "Cycloid receives these instructions before the Slack alert context. Edit them to control when it should fix code, tune alerts, or only report findings.",
    );
    expect(container.textContent).toContain("#engineering");
    // The raw channel ID stays reachable behind a title attr on the name.
    expect(container.querySelector('[title="C_TEST"]')).toBeTruthy();
    expect(container.textContent).toContain("Triggers on one detected sender.");
    expect(container.querySelector('[title="apps A_DATADOG; bots B_DATADOG"]')).toBeTruthy();
    expect(container.textContent).toContain("trycycloid/cycloid");
    // Paused/Resume vocabulary, matching scheduled automations.
    expect(container.textContent).toContain("Active");
    expect(container.textContent).not.toContain("Enabled");
    expect(container.textContent).not.toContain("Disabled");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toContain("Pause");

    await unmount();
  });

  it("labels a disabled rule Paused", async () => {
    apiMocks.fetchSlackAlertAutomationRules.mockResolvedValue([
      {
        id: "rule-1",
        businessId: "biz-1",
        configuredByUserId: "1",
        name: "Datadog alerts",
        triggerKind: "slack_channel_message",
        triggerProvider: "datadog",
        slackTeamId: "T_TEST",
        slackChannelId: "C_TEST",
        slackBotUserId: null,
        allowedSlackAppIds: ["A_DATADOG"],
        allowedSlackBotIds: ["B_DATADOG"],
        repoOwner: "trycycloid",
        repoName: "cycloid",
        installationId: 123,
        modelId: "kimi-k2.7-code",
        promptTemplate: "Investigate this Datadog alert.",
        enabled: false,
        createdAt: 1_780_000_000_000,
        updatedAt: 1_780_000_000_000,
      },
    ]);

    const { container, unmount } = await render();

    expect(container.textContent).toContain("Paused");
    expect(container.textContent).not.toContain("Disabled");

    await unmount();
  });

  it("uses triage-first Slack alert prompt defaults without overwriting custom instructions", async () => {
    const { container, unmount } = await render();

    const promptTextarea = [...container.querySelectorAll("textarea")].find((textarea) =>
      textarea.value.includes("Datadog alert"),
    )!;
    const providerSelect = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "datadog" || option.value === "sentry"),
    ) as HTMLSelectElement | undefined;

    expect(providerSelect).toBeTruthy();
    expect(promptTextarea.value).toContain("Investigate this Datadog alert before making changes.");
    expect(promptTextarea.value).toContain("First determine whether the alert is still firing");
    expect(promptTextarea.value).toContain("propose monitor tuning, and implement it only if");
    expect(promptTextarea.value).toContain("use a PR title that describes the actual change");

    await act(async () => {
      setSelectValue(providerSelect!, "sentry");
      await flushAsyncWork();
    });

    expect(promptTextarea.value).toContain("Investigate this Sentry alert before making changes.");
    expect(promptTextarea.value).toContain("First determine whether the issue is still active");
    expect(promptTextarea.value).toContain("propose alert tuning or deletion");

    await act(async () => {
      setTextareaValue(promptTextarea, "Custom alert instructions");
      await flushAsyncWork();
    });
    await act(async () => {
      setSelectValue(providerSelect!, "datadog");
      await flushAsyncWork();
    });

    expect(promptTextarea.value).toBe("Custom alert instructions");

    await unmount();
  });
});
