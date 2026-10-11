import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarFilterPopover } from "../../apps/ui/src/components/SidebarFilterPopover";
import type { DisplayStatus } from "../../shared/session/display-status";

const OPTIONS: DisplayStatus[] = ["working", "waiting_for_input", "completed", "failed", "archived"];

let happyWindow: Window;
let container: HTMLElement;
let root: Root;

function installDomGlobals(windowInstance: Window) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    KeyboardEvent: windowInstance.KeyboardEvent,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

beforeEach(() => {
  happyWindow = new Window({ url: "https://app.test/" });
  installDomGlobals(happyWindow);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  happyWindow.close();
});

async function render(props: Parameters<typeof SidebarFilterPopover>[0]) {
  await act(async () => {
    root.render(createElement(SidebarFilterPopover, props));
  });
}

describe("SidebarFilterPopover", () => {
  it("renders each option with its label and count when open", async () => {
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: { working: 3, waiting_for_input: 1, completed: 2, failed: 1, archived: 4 },
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });

    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');
    expect(options.length).toBe(OPTIONS.length);
    expect(options[0].textContent).toContain("Working");
    expect(options[0].textContent).toContain("3");
    expect(options[1].textContent).toContain("Waiting for input");
    expect(options[1].textContent).toContain("1");
    expect(options[2].textContent).toContain("Completed");
    expect(options[3].textContent).toContain("Failed");
  });

  it("renders nothing when closed", async () => {
    await render({
      open: false,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("calls onToggle when an option is clicked and reflects aria-checked", async () => {
    const onToggle = vi.fn();
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set<DisplayStatus>(["working"]),
      counts: {},
      onToggle,
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    expect(buttons[0].getAttribute("aria-checked")).toBe("true");
    expect(buttons[1].getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith("waiting_for_input");
  });

  it("disables Clear when no filters are selected", async () => {
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    const clearBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Clear",
    );
    expect(clearBtn?.disabled).toBe(true);
  });

  it("focuses the first option when the popover opens", async () => {
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    expect(document.activeElement).toBe(options[0]);
  });

  it("moves focus with ArrowDown / ArrowUp and wraps around", async () => {
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    // First option is already focused from open. Press ArrowDown twice.
    await act(async () => {
      options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[1]);
    await act(async () => {
      options[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[2]);
    // ArrowUp wraps when above the first option.
    await act(async () => {
      options[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      options[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[options.length - 1]);
  });

  it("Home / End jump to first and last option", async () => {
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    });
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    await act(async () => {
      options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[options.length - 1]);
    await act(async () => {
      options[options.length - 1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[0]);
  });

  it("Tab closes the popover per the WAI-ARIA menu pattern", async () => {
    const onClose = vi.fn();
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose,
    });
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    await act(async () => {
      options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    await render({
      open: true,
      options: OPTIONS,
      selected: new Set(),
      counts: {},
      onToggle: vi.fn(),
      onClear: vi.fn(),
      onClose,
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
