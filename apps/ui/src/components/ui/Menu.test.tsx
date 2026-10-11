import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Menu, type MenuItem } from "./Menu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mountMenu(items?: MenuItem[]) {
  const onRename = vi.fn();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  act(() =>
    root.render(
      <Menu
        label="Session actions"
        items={
          items ?? [
            { label: "Rename", onSelect: onRename },
            { label: "Archive", onSelect: onArchive, disabled: true },
            { label: "Delete", onSelect: onDelete, tone: "danger" },
          ]
        }
      />,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!trigger) throw new Error("Menu trigger not found");
  return { trigger, onRename, onArchive, onDelete };
}

// The panel renders in a body portal (so ancestor overflow cannot clip it),
// so panel queries go through document, not the mount container.
function openMenu(trigger: HTMLButtonElement) {
  act(() => trigger.click());
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function press(element: HTMLElement, key: string) {
  act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

describe("Menu", () => {
  it("renders a default ellipsis IconButton trigger with menu aria wiring", () => {
    const { trigger } = mountMenu();
    expect(trigger.getAttribute("aria-label")).toBe("Session actions");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="menu"]')).toBeNull();

    openMenu(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(menu?.getAttribute("id"));
    // Dropdown layer + kit popover surface.
    expect(menu?.className).toContain("z-dropdown");
    expect(menu?.className).toContain("border-border");
  });

  it("focuses the first enabled item on open and roves with arrows, skipping disabled", () => {
    const { trigger } = mountMenu();
    const items = openMenu(trigger);
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0]);

    press(items[0], "ArrowDown");
    expect(document.activeElement).toBe(items[2]); // skips disabled "Archive"

    press(items[2], "ArrowDown");
    expect(document.activeElement).toBe(items[0]); // wraps

    press(items[0], "End");
    expect(document.activeElement).toBe(items[2]);
    press(items[2], "Home");
    expect(document.activeElement).toBe(items[0]);
  });

  it("selects an item: closes, refocuses the trigger, calls onSelect", () => {
    const { trigger, onRename } = mountMenu();
    const items = openMenu(trigger);

    act(() => items[0].click());
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and refocuses the trigger without selecting", () => {
    const { trigger, onRename } = mountMenu();
    const items = openMenu(trigger);

    press(items[0], "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes on outside pointer down", () => {
    const { trigger } = mountMenu();
    openMenu(trigger);

    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("gives danger items the error treatment", () => {
    const { trigger } = mountMenu();
    const items = openMenu(trigger);
    expect(items[2].className).toContain("text-error");
    expect(items[0].className).not.toContain("text-error");
  });

  it("portals the panel to document.body so ancestor overflow cannot clip it", () => {
    const { trigger } = mountMenu();
    openMenu(trigger);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    // Outside the mount container, direct child of body, fixed-positioned.
    expect(container.contains(menu)).toBe(false);
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.style.position).toBe("fixed");
  });

  it("closes when the page scrolls (fixed panel does not track its anchor)", () => {
    const { trigger } = mountMenu();
    openMenu(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => document.dispatchEvent(new Event("scroll")));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("supports a custom trigger via renderTrigger", () => {
    act(() =>
      root.render(
        <Menu
          label="Row actions"
          items={[{ label: "Open", onSelect: vi.fn() }]}
          renderTrigger={(props) => (
            <button type="button" {...props}>
              More
            </button>
          )}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    expect(trigger?.textContent).toBe("More");
    act(() => trigger?.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});
