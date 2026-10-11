import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledRule } from "../../apps/ui/src/api/automation-schedules";
import { InstalledAutomations } from "../../apps/ui/src/components/automations/InstalledAutomations";

const rule: ScheduledRule = {
  id: "rule-1",
  businessId: "biz-a",
  configuredByUserId: "42",
  repoOwner: "acme",
  repoName: "web",
  installationId: 123,
  promptTemplate: "Run tests.",
  cron: "0 14 * * 1-5",
  normalizedCron: "0 14 * * 1,2,3,4,5",
  name: "Test sweep",
  enabled: true,
  nextFireAt: Date.UTC(2026, 0, 7, 14),
  lastEnqueuedAt: null,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 1),
  canManage: true,
  canDelete: true,
  slackTeamId: null,
  slackChannelId: null,
  lastDeliveredAt: null,
  lastDeliveryError: null,
};

let container: HTMLDivElement;
let root: Root;
let happyWindow: Window;

beforeEach(() => {
  happyWindow = new Window({ url: "https://app.example.test/automations" });
  for (const [key, value] of Object.entries({
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    Node: happyWindow.Node,
    Event: happyWindow.Event,
    MouseEvent: happyWindow.MouseEvent,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  happyWindow.close();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

function render(overrides: Partial<ComponentProps<typeof InstalledAutomations>> = {}) {
  const props: ComponentProps<typeof InstalledAutomations> = {
    rules: [rule],
    loading: false,
    busyAction: null,
    onEdit: vi.fn(),
    onToggle: vi.fn(),
    onRunNow: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    nextCursor: null,
    loadingMore: false,
    loadMoreError: null,
    onLoadMore: vi.fn(),
    ...overrides,
  };
  act(() => root.render(createElement(InstalledAutomations, props)));
  return props;
}

function openActionsMenu() {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error("Menu trigger not found");
  act(() => trigger.click());
  return trigger;
}

describe("InstalledAutomations", () => {
  it("keeps View runs and Run now visible and folds the rest behind the overflow menu", () => {
    const props = render();

    // Visible row actions: View runs + Run now + the single menu trigger.
    expect(button("View runs")).toBeDefined();
    act(() => button("Run now").click());
    expect(props.onRunNow).toHaveBeenCalledWith(rule);
    for (const folded of ["Edit", "Pause", "Duplicate", "Delete"]) {
      expect(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === folded)).toBeUndefined();
    }

    for (const [label, callback] of [
      ["Edit", props.onEdit],
      ["Pause", props.onToggle],
      ["Duplicate", props.onDuplicate],
      ["Delete", props.onDelete],
    ] as const) {
      openActionsMenu();
      // The Menu panel portals to document.body (unclip fix), so query the document.
      const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (candidate) => candidate.textContent === label,
      );
      if (!item) throw new Error(`Menu item not found: ${label}`);
      act(() => item.click());
      expect(callback).toHaveBeenCalledWith(rule);
    }
  });

  it("labels the toggle Resume for a paused rule", () => {
    render({ rules: [{ ...rule, enabled: false }] });
    openActionsMenu();
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
    expect(items).toContain("Resume");
    expect(items).not.toContain("Pause");
  });

  it("renders truthful paused and in-flight states", () => {
    render({
      rules: [{ ...rule, enabled: false }],
      busyAction: { ruleId: rule.id, action: "run" },
    });
    // One vocabulary pair: the chip says Paused; there is no duplicate
    // lowercase "paused" meta readout and no Enabled badge for the default state.
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).not.toContain("Enabled");
    expect(container.textContent).toContain("Starting…");
    expect(button("Starting…").disabled).toBe(true);
  });

  it("shows no state chip for an enabled rule", () => {
    render();
    expect(container.textContent).not.toContain("Paused");
    expect(container.textContent).not.toContain("Enabled");
    expect(container.textContent).toContain("next ");
  });

  it("humanizes the schedule and keeps the raw cron behind a title attr", () => {
    // A paused rule has no "next …" readout, so the subtitle carries the whole
    // schedule story: humanized text, raw expression on hover.
    render({ rules: [{ ...rule, enabled: false, cron: "0 9 1 1 *" }] });
    expect(container.textContent).toContain("Yearly on Jan 1 at 09:00 UTC");
    expect(container.textContent).not.toContain("0 9 1 1 *");
    expect(container.querySelector('[title="0 9 1 1 *"]')).not.toBeNull();
  });

  it("hides mutation controls from a non-manager", () => {
    render({ rules: [{ ...rule, canManage: false, canDelete: false }] });
    expect(container.textContent).toContain("Creator or admin can manage");
    expect(container.textContent).not.toContain("Run now");
    expect(container.textContent).not.toContain("Delete");
    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull();
  });
});
import { Window } from "happy-dom";
