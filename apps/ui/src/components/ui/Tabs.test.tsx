import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type TabItem, Tabs } from "./Tabs";

let container: HTMLDivElement;
let root: Root;

const TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "changes", label: "Changes" },
  { id: "logs", label: "Logs", disabled: true },
  { id: "checks", label: "Checks" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function tabButtons() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

function render(value: string, onValueChange: (id: string) => void) {
  act(() => {
    root.render(<Tabs tabs={TABS} value={value} onValueChange={onValueChange} ariaLabel="Section tabs" />);
  });
}

describe("Tabs", () => {
  it("marks the selected tab with aria-selected and roving tabindex", () => {
    render("overview", () => {});
    const [overview, changes] = tabButtons();
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.tabIndex).toBe(0);
    expect(changes.getAttribute("aria-selected")).toBe("false");
    expect(changes.tabIndex).toBe(-1);
  });

  it("selects a tab on click", () => {
    const onValueChange = vi.fn();
    render("overview", onValueChange);
    act(() => {
      tabButtons()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith("changes");
  });

  it("moves selection with ArrowRight and skips disabled tabs", () => {
    const onValueChange = vi.fn();
    render("overview", onValueChange);
    act(() => {
      tabButtons()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith("changes");

    onValueChange.mockClear();
    render("changes", onValueChange);
    act(() => {
      tabButtons()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    // "logs" is disabled, so it jumps to "checks".
    expect(onValueChange).toHaveBeenLastCalledWith("checks");
  });

  it("wraps to the first enabled tab with ArrowRight from the last", () => {
    const onValueChange = vi.fn();
    render("checks", onValueChange);
    act(() => {
      tabButtons()[3].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith("overview");
  });

  it("jumps to first and last enabled tabs with Home and End", () => {
    const onValueChange = vi.fn();
    render("changes", onValueChange);
    act(() => {
      tabButtons()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith("checks");
    act(() => {
      tabButtons()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith("overview");
  });
});
