import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledRule } from "../../apps/ui/src/api/automation-schedules";
import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import {
  AutomationSchedulesSettings,
  preValidateCron,
} from "../../apps/ui/src/components/settings/AutomationSchedulesSettings";
import { SCHEDULED_AUTOMATION_TEMPLATES } from "../../apps/ui/src/constants/automationTemplates";
import { buildCronFromPreset } from "../../apps/ui/src/constants/scheduleCron";

const apiMocks = vi.hoisted(() => ({
  fetchScheduledRules: vi.fn(),
  createScheduledRule: vi.fn(),
  deleteScheduledRule: vi.fn(),
}));

// The repo field is now a Select fed from the layout context repos (same source
// GeneralSettings' default-repo picker uses), so the component reads
// useLayoutContext directly.
const layoutMocks = vi.hoisted(() => ({
  repos: [
    {
      fullName: "acme/webapp",
      url: "https://github.com/acme/webapp",
      private: false,
      defaultBranch: "main",
      ownerType: "Organization",
    },
    {
      fullName: "acme/api",
      url: "https://github.com/acme/api",
      private: false,
      defaultBranch: "main",
      ownerType: "Organization",
    },
  ],
  reposLoaded: true,
}));

vi.mock("../../apps/ui/src/api/automation-schedules.ts", () => ({
  fetchScheduledRules: apiMocks.fetchScheduledRules,
  createScheduledRule: apiMocks.createScheduledRule,
  deleteScheduledRule: apiMocks.deleteScheduledRule,
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
    HTMLFormElement: windowInstance.HTMLFormElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    SVGElement: windowInstance.SVGElement,
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
    root.render(createElement(ConfirmProvider, null, createElement(AutomationSchedulesSettings)));
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // happy-dom does not propagate input events through React's value tracker,
  // so React's onChange never fires. Set the value via the prototype setter,
  // then call the onChange prop React stashed on the DOM node directly —
  // same workaround used by `api-keys-settings.test.tsx`.
  const proto =
    input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  valueSetter?.call(input, value);

  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (
        input as unknown as Record<
          string,
          { onChange?: (event: { target: HTMLInputElement | HTMLTextAreaElement }) => void }
        >
      )[reactPropsKey]
    : null;
  reactProps?.onChange?.({ target: input });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value;
  // Walk up to the React fiber root and grab the onChange prop. React 18+ doesn't
  // always attach `__reactProps$` on every element type (notably selects); the
  // alternative is to dispatch a bubbling change event and let React's root
  // delegation pick it up.
  const reactPropsKey = Object.getOwnPropertyNames(select).find((key) => key.startsWith("__reactProps$"));
  if (reactPropsKey) {
    const reactProps = (
      select as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>
    )[reactPropsKey];
    reactProps?.onChange?.({ target: select });
    return;
  }
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function repoSelect(container: Element): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll("select")).find((candidate) =>
    Array.from(candidate.querySelectorAll("option")).some(
      (option) => (option as HTMLOptionElement).value === "acme/webapp",
    ),
  ) as HTMLSelectElement | undefined;
  if (!select) throw new Error("repository select not found");
  return select;
}

async function selectRepo(container: Element, value: string) {
  await act(async () => {
    setSelectValue(repoSelect(container), value);
    await flushAsyncWork();
  });
}

function dialogButton(container: Element, text: string): HTMLButtonElement {
  const dialog = container.querySelector('[role="alertdialog"]');
  if (!dialog) throw new Error("confirmation dialog not open");
  const button = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`dialog button "${text}" not found`);
  return button as HTMLButtonElement;
}

async function clickReactButton(button: HTMLButtonElement) {
  await act(async () => {
    const key = Object.getOwnPropertyNames(button).find((k) => k.startsWith("__reactProps$"));
    (button as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
    await flushAsyncWork();
  });
}

/** Click the row-level "Delete" button (outside any open dialog). */
function rowDeleteButton(container: Element): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Delete" && !b.closest('[role="alertdialog"]'),
  );
  if (!button) throw new Error("row delete button not found");
  return button as HTMLButtonElement;
}

async function switchToCustomCron(container: Element) {
  const presetSelect = Array.from(container.querySelectorAll("select")).find((select) => {
    const options = Array.from(select.querySelectorAll("option"));
    return options.some((option) => (option as HTMLOptionElement).value === "custom");
  }) as HTMLSelectElement | undefined;
  expect(presetSelect).toBeTruthy();
  await act(async () => {
    setSelectValue(presetSelect!, "custom");
    await flushAsyncWork();
  });
  await waitFor(() => container.querySelector('input[placeholder="0 14 * * 1-5"]'));
}

function clickSubmit(button: HTMLButtonElement) {
  // happy-dom does not propagate button-click → form-submit consistently and
  // does not attach `__reactProps$` to the parent <form>, so invoke the
  // submit button's React onClick directly — same pattern other tests use.
  const reactPropsKey = Object.getOwnPropertyNames(button).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (button as unknown as Record<string, { onClick?: (event: { preventDefault: () => void }) => void }>)[
        reactPropsKey
      ]
    : null;
  reactProps?.onClick?.({ preventDefault: () => {} });
}

function mockRule(overrides: Partial<ScheduledRule> = {}): ScheduledRule {
  return {
    id: "rule-1",
    businessId: "biz-1",
    configuredByUserId: "user-1",
    repoOwner: "acme",
    repoName: "webapp",
    installationId: 123,
    promptTemplate: "Review failing tests in this repository.",
    cron: "0 14 * * 1-5",
    normalizedCron: "0 14 * * 1,2,3,4,5",
    name: "Weekday flake sweep",
    enabled: true,
    nextFireAt: Date.UTC(2026, 5, 1, 14, 0, 0),
    lastEnqueuedAt: null,
    createdAt: Date.UTC(2026, 4, 22, 14, 0, 0),
    updatedAt: Date.UTC(2026, 4, 22, 14, 0, 0),
    canDelete: true,
    slackTeamId: null,
    slackChannelId: null,
    lastDeliveredAt: null,
    lastDeliveryError: null,
    ...overrides,
  };
}

describe("AutomationSchedulesSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/scheduled-runs";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [], nextCursor: null });
    apiMocks.createScheduledRule.mockResolvedValue(mockRule());
    apiMocks.deleteScheduledRule.mockResolvedValue(undefined);
  });

  it("pre-validates cron shape before submit", () => {
    expect(preValidateCron("")).toBe("Cron is required");
    expect(preValidateCron("@daily")).toBeNull();
    expect(preValidateCron("@sometimes")).toBe("Unknown cron alias");
    expect(preValidateCron("0 14 *")).toContain("5 space-separated fields");
    expect(preValidateCron("0 14 * * 1-5")).toBeNull();
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("renders existing rules from the API", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));
    expect(container.textContent).toContain("acme/webapp");
    expect(container.textContent).toContain("0 14 * * 1-5");

    await unmount();
  });

  it("renders a delete affordance per row and no edit affordance, with contact-support copy gone", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));
    expect(container.textContent).not.toContain("Contact support to remove a rule");

    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim().toLowerCase() ?? "");
    expect(labels.some((l) => l === "delete")).toBe(true);
    for (const label of labels) {
      expect(label).not.toContain("edit");
    }

    await unmount();
  });

  it("deletes a rule after confirming in the dialog and announces success", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    // Row Delete opens a confirmation dialog and does not call the API yet.
    await clickReactButton(rowDeleteButton(container));
    expect(apiMocks.deleteScheduledRule).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("Already-running sessions will finish");

    // Confirming fires the API and removes the row.
    await clickReactButton(dialogButton(container, "Delete"));
    await waitFor(() => (apiMocks.deleteScheduledRule.mock.calls.length > 0 ? true : null));

    expect(apiMocks.deleteScheduledRule).toHaveBeenCalledWith("rule-1");
    await waitFor(() => (container.textContent?.includes(`Deleted "Weekday flake sweep"`) ? true : null));
    expect(container.textContent).not.toContain("Weekday flake sweep · ");
    const statusRegion = container.querySelector('[role="status"]');
    expect(statusRegion?.textContent).toContain(`Deleted "Weekday flake sweep"`);

    await unmount();
  });

  it("cancelling the confirm dialog does not call the API and keeps the row", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    await clickReactButton(rowDeleteButton(container));
    await clickReactButton(dialogButton(container, "Cancel"));

    expect(apiMocks.deleteScheduledRule).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Weekday flake sweep");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    await unmount();
  });

  it("keeps the row in place and announces an error when the delete API fails", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    apiMocks.deleteScheduledRule.mockRejectedValueOnce(new Error("Rule could not be deleted"));
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    await clickReactButton(rowDeleteButton(container));
    await clickReactButton(dialogButton(container, "Delete"));

    await waitFor(() => (container.textContent?.includes("Rule could not be deleted") ? true : null));
    // Row stays in place because removal happens after the API succeeds.
    // Avoids the stale-snapshot rollback bug — no concurrent edits lost.
    expect(container.textContent).toContain("Weekday flake sweep");
    const alertRegions = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alertRegions.some((el) => el.textContent?.includes("Rule could not be deleted"))).toBe(true);

    await unmount();
  });

  it("hides the delete affordance and shows a hint when canDelete is false", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule({ canDelete: false })], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    const deleteButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim().toLowerCase() === "delete",
    );
    expect(deleteButtons).toHaveLength(0);
    expect(container.textContent).toContain("Only the creator or an admin can delete this");

    await unmount();
  });

  it("renders the delete affordance (and no hint) when canDelete is true", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule({ canDelete: true })], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === "delete",
    );
    expect(deleteButton).toBeTruthy();
    expect(container.textContent).not.toContain("Only the creator or an admin can delete this");

    await unmount();
  });

  it("flags malformed cron strings inline before allowing submit", async () => {
    const { container, unmount } = await renderSettings();

    await switchToCustomCron(container);
    await selectRepo(container, "acme/webapp");

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(cronInput).toBeTruthy();
    expect(promptInput).toBeTruthy();

    await act(async () => {
      setInputValue(cronInput, "0 14 *"); // 3 fields, not 5
      setInputValue(promptInput, "do the thing");
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Cron must have 5 space-separated fields");
    expect(submit.disabled).toBe(true);

    await act(async () => {
      setInputValue(cronInput, "0 14 * * 1-5");
      await flushAsyncWork();
    });

    expect(submit.disabled).toBe(false);

    await unmount();
  });

  it("keeps submit disabled until a repository is selected and shows a custom cron preview", async () => {
    const { container, unmount } = await renderSettings();

    await switchToCustomCron(container);

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      setInputValue(cronInput, "@daily");
      setInputValue(promptInput, "Daily check.");
      await flushAsyncWork();
    });

    // No repository selected yet: submit stays disabled but the preview renders.
    expect(container.textContent).toContain("UTC");
    expect(container.textContent).not.toContain("Preview available after save");
    expect(submit.disabled).toBe(true);

    await selectRepo(container, "acme/webapp");

    expect(submit.disabled).toBe(false);

    await unmount();
  });

  it("renders the repository field as a select fed from workspace repos", async () => {
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.querySelector('button[type="submit"]') ? true : null));

    const select = repoSelect(container);
    const optionValues = Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toContain("acme/webapp");
    expect(optionValues).toContain("acme/api");
    // The old free-text repo input (and its owner/repo-or-URL helper) is gone.
    expect(container.querySelector('input[placeholder="acme/webapp"]')).toBeNull();
    expect(container.textContent).not.toContain("owner/repo or GitHub URL");

    await unmount();
  });

  it("creates a rule from the selected repository and prepends it to the list", async () => {
    const { container, unmount } = await renderSettings();

    await switchToCustomCron(container);
    await selectRepo(container, "acme/webapp");

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      setInputValue(cronInput, "0 14 * * 1-5");
      setInputValue(promptInput, "Review low-risk failing tests.");
      await flushAsyncWork();
    });

    // Sanity: with a repo selected and all required fields filled, submit is enabled.
    expect(submit.disabled).toBe(false);

    await act(async () => {
      clickSubmit(submit);
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.createScheduledRule.mock.calls.length > 0 ? true : null));

    // The select value ("owner/repo") is split into the same repoOwner/repoName shape.
    expect(apiMocks.createScheduledRule).toHaveBeenCalledWith({
      repoOwner: "acme",
      repoName: "webapp",
      cron: "0 14 * * 1-5",
      prompt: "Review low-risk failing tests.",
      name: null,
      slackTeamId: null,
      slackChannelId: null,
    });

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));
    await unmount();
  });

  it("sends the Slack delivery target when both channel and workspace are provided", async () => {
    const { container, unmount } = await renderSettings();
    await switchToCustomCron(container);
    await selectRepo(container, "acme/webapp");

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const channelInput = container.querySelector('input[placeholder="Channel ID (e.g. C0123ABC)"]') as HTMLInputElement;
    const workspaceInput = container.querySelector(
      'input[placeholder="Workspace ID (e.g. T0123ABC)"]',
    ) as HTMLInputElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      setInputValue(cronInput, "0 14 * * 1-5");
      setInputValue(promptInput, "Post the digest.");
      setInputValue(channelInput, "C0123ABC");
      setInputValue(workspaceInput, "T0123ABC");
      await flushAsyncWork();
    });
    expect(submit.disabled).toBe(false);

    await act(async () => {
      clickSubmit(submit);
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.createScheduledRule.mock.calls.length > 0 ? true : null));

    expect(apiMocks.createScheduledRule).toHaveBeenCalledWith({
      repoOwner: "acme",
      repoName: "webapp",
      cron: "0 14 * * 1-5",
      prompt: "Post the digest.",
      name: null,
      slackTeamId: "T0123ABC",
      slackChannelId: "C0123ABC",
    });

    await unmount();
  });

  it("blocks submit with an inline error when only one Slack field is filled", async () => {
    const { container, unmount } = await renderSettings();
    await switchToCustomCron(container);
    await selectRepo(container, "acme/webapp");

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const channelInput = container.querySelector('input[placeholder="Channel ID (e.g. C0123ABC)"]') as HTMLInputElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      setInputValue(cronInput, "0 14 * * 1-5");
      setInputValue(promptInput, "Post the digest.");
      setInputValue(channelInput, "C0123ABC"); // channel only, no workspace
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Enter both a workspace ID and a channel ID");
    expect(submit.disabled).toBe(true);

    const workspaceInput = container.querySelector(
      'input[placeholder="Workspace ID (e.g. T0123ABC)"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(workspaceInput, "T0123ABC");
      await flushAsyncWork();
    });
    expect(submit.disabled).toBe(false);

    await unmount();
  });

  it("renders the last-delivery status for rules with a Slack channel", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({
      items: [
        mockRule({
          id: "delivered",
          name: "Delivered rule",
          slackChannelId: "C1",
          slackTeamId: "T1",
          lastDeliveredAt: Date.UTC(2026, 5, 1, 11, 0, 0),
        }),
        mockRule({
          id: "failed",
          name: "Failed rule",
          slackChannelId: "C2",
          slackTeamId: "T1",
          lastDeliveryError: "not_in_channel",
        }),
        mockRule({ id: "pending", name: "Pending rule", slackChannelId: "C3", slackTeamId: "T1" }),
        mockRule({ id: "nodelivery", name: "No delivery rule" }),
      ],
      nextCursor: null,
    });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Delivered rule") ? true : null));
    expect(container.textContent).toContain("Delivered to Slack");
    expect(container.textContent).toContain("Slack delivery failed: not_in_channel");
    expect(container.textContent).toContain("Delivers to Slack · no run yet");

    await unmount();
  });

  it("strips the old chrome copy from the page", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    // Negative assertions: removed copy must not regrow.
    expect(container.textContent).not.toContain("Automation");
    expect(container.textContent).not.toContain("Run a Cycloid task against a repository on a recurring schedule");
    expect(container.textContent).not.toContain("Scheduled runs share your usage quota");
    expect(container.textContent).not.toContain("Delete a rule to stop future fires");
    expect(container.textContent).not.toContain("Schedules fire on the every-5-minute control-plane sweep");
    // No leftover "1 rule" / "N rules" meta count.
    expect(container.textContent).not.toMatch(/\d+ rules?/);

    // Positive assertions: compact helpers retained.
    expect(container.textContent).toContain("Next run");
    expect(container.textContent).toContain("Up to 80 chars");

    // Prompt field has no helper paragraph (label + textarea only).
    const promptTextarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const promptField = promptTextarea.closest("div");
    const promptHelpers = promptField?.querySelectorAll("p");
    expect(promptHelpers && promptHelpers.length).toBe(0);

    // After the Wave 1 restructure "Recurring runs" is a section (h2) nested
    // under the parent Automations page header rather than its own h1.
    const sectionHeadings = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(sectionHeadings).toContain("Recurring runs");

    await unmount();
  });

  it("hides the Existing schedules section entirely when there are no rules", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = await renderSettings();

    // Wait for initial load to settle.
    await waitFor(() => (container.querySelector('button[type="submit"]') ? true : null));

    expect(container.textContent).not.toContain("Existing schedules");
    expect(container.textContent).not.toContain("No scheduled runs yet");

    await unmount();
  });

  it("renders load errors in the lifted status region with no Existing schedules card", async () => {
    apiMocks.fetchScheduledRules.mockRejectedValueOnce(new Error("Service unavailable"));
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Service unavailable") ? true : null));

    expect(container.textContent).not.toContain("Existing schedules");
    const alertRegions = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alertRegions.some((el) => el.textContent?.includes("Service unavailable"))).toBe(true);

    await unmount();
  });

  it("keeps the post-delete success message visible after deleting the last rule, and hides the section", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValue({ items: [mockRule()], nextCursor: null });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    await clickReactButton(rowDeleteButton(container));

    await act(async () => {
      const confirmButton = dialogButton(container, "Delete");
      const key = Object.getOwnPropertyNames(confirmButton).find((k) => k.startsWith("__reactProps$"));
      (confirmButton as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes(`Deleted "Weekday flake sweep"`) ? true : null));

    expect(container.textContent).not.toContain("Existing schedules");
    const statusRegions = Array.from(container.querySelectorAll('[role="status"]'));
    expect(statusRegions.some((el) => el.textContent?.includes(`Deleted "Weekday flake sweep"`))).toBe(true);

    await unmount();
  });

  it("keeps the Existing schedules section and Load more visible when deleting the last loaded rule while nextCursor remains", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValueOnce({
      items: [mockRule()],
      nextCursor: "cursor-2",
    });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("Weekday flake sweep") ? true : null));

    await clickReactButton(rowDeleteButton(container));

    await act(async () => {
      const confirmButton = dialogButton(container, "Delete");
      const key = Object.getOwnPropertyNames(confirmButton).find((k) => k.startsWith("__reactProps$"));
      (confirmButton as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes(`Deleted "Weekday flake sweep"`) ? true : null));

    // Section + Load more must remain reachable; otherwise unseen remote rules
    // become orphaned in the UI.
    expect(container.textContent).toContain("Existing schedules");
    const loadMoreButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === "load more",
    );
    expect(loadMoreButton).toBeTruthy();

    // Delete success still shows in the lifted status region.
    const statusRegions = Array.from(container.querySelectorAll('[role="status"]'));
    expect(statusRegions.some((el) => el.textContent?.includes(`Deleted "Weekday flake sweep"`))).toBe(true);

    await unmount();
  });

  it("renders the Load more affordance when nextCursor is present and surfaces loadMore errors without dropping rules", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValueOnce({
      items: [mockRule({ id: "rule-1", name: "First" })],
      nextCursor: "cursor-2",
    });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("First") ? true : null));

    const loadMoreButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === "load more",
    ) as HTMLButtonElement;
    expect(loadMoreButton).toBeTruthy();

    apiMocks.fetchScheduledRules.mockResolvedValueOnce({
      items: [mockRule({ id: "rule-2", name: "Second" })],
      nextCursor: null,
    });

    await act(async () => {
      const key = Object.getOwnPropertyNames(loadMoreButton).find((k) => k.startsWith("__reactProps$"));
      (loadMoreButton as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("Second") ? true : null));
    expect(apiMocks.fetchScheduledRules).toHaveBeenCalledWith("cursor-2");
    expect(container.textContent).toContain("First");

    await unmount();
  });

  it("surfaces a loadMore failure without removing already-loaded rules", async () => {
    apiMocks.fetchScheduledRules.mockResolvedValueOnce({
      items: [mockRule({ id: "rule-1", name: "First" })],
      nextCursor: "cursor-2",
    });
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.textContent?.includes("First") ? true : null));

    const loadMoreButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === "load more",
    ) as HTMLButtonElement;

    apiMocks.fetchScheduledRules.mockRejectedValueOnce(new Error("Cursor expired"));

    await act(async () => {
      const key = Object.getOwnPropertyNames(loadMoreButton).find((k) => k.startsWith("__reactProps$"));
      (loadMoreButton as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("Cursor expired") ? true : null));
    // Already-loaded rule must survive a paging failure.
    expect(container.textContent).toContain("First");

    await unmount();
  });

  it("surfaces server-side validation errors without losing the form state", async () => {
    apiMocks.createScheduledRule.mockRejectedValue(new Error("Cron cadence must be at least every 5 minutes"));
    const { container, unmount } = await renderSettings();

    await switchToCustomCron(container);
    await selectRepo(container, "acme/webapp");

    const cronInput = container.querySelector('input[placeholder="0 14 * * 1-5"]') as HTMLInputElement;
    const promptInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;

    await act(async () => {
      setInputValue(cronInput, "* * * * *"); // passes client-side shape check, server rejects cadence
      setInputValue(promptInput, "Try.");
      await flushAsyncWork();
    });

    await act(async () => {
      clickSubmit(submit);
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("must be at least every 5 minutes") ? true : null));
    // The selected repository and cron survive a failed create.
    expect(repoSelect(container).value).toBe("acme/webapp");
    expect(cronInput.value).toBe("* * * * *");

    await unmount();
  });

  it("pre-fills the form from a suggested-automation card and sends the template's cron on create", async () => {
    const { container, unmount } = await renderSettings();

    await waitFor(() => (container.querySelector('button[type="submit"]') ? true : null));

    // Stub scrollIntoView: happy-dom does not implement it, and the click
    // handler calls it on the New scheduled run section.
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });

    // Use the first template (the buttons render in SCHEDULED_AUTOMATION_TEMPLATES
    // order; roadmap templates never render on this create surface).
    const template = SCHEDULED_AUTOMATION_TEMPLATES[0];
    const useButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Use this",
    ) as HTMLButtonElement[];
    expect(useButtons).toHaveLength(SCHEDULED_AUTOMATION_TEMPLATES.length);

    await act(async () => {
      const key = Object.getOwnPropertyNames(useButtons[0]).find((k) => k.startsWith("__reactProps$"));
      (useButtons[0] as unknown as Record<string, { onClick?: () => void }>)[key!].onClick?.();
      await flushAsyncWork();
    });

    // Picking a weekly template hides the custom cron input, leaves the repo
    // unselected, and shows the "pick a repository" hint.
    expect(repoSelect(container).value).toBe("");
    expect(container.querySelector('input[placeholder="0 14 * * 1-5"]')).toBeNull();
    expect(container.textContent).toContain("pick a repository");

    // Select a repo, then create. The payload must carry the template's prompt,
    // name, and the cron derived from its weekly preset (minute hour * * day).
    await selectRepo(container, "acme/webapp");

    // Touching a field dismisses the now-stale "loaded a template" hint.
    expect(container.textContent).not.toContain("pick a repository");

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    await act(async () => {
      clickSubmit(submit);
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.createScheduledRule.mock.calls.length > 0 ? true : null));

    expect(apiMocks.createScheduledRule).toHaveBeenCalledWith({
      repoOwner: "acme",
      repoName: "webapp",
      prompt: template.prompt,
      name: template.name,
      cron: buildCronFromPreset(template.preset, template.hour, template.minute),
      slackTeamId: null,
      slackChannelId: null,
    });

    await unmount();
  });
});
