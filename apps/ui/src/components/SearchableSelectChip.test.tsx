import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchableSelectChip } from "./SearchableSelectChip";

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

const OPTIONS = [
  { value: "", label: "Choose a repo…", disabled: true },
  { value: "https://github.com/a/one", label: "a/one" },
  { value: "https://github.com/a/two", label: "a/two · private" },
];

function mount(onChange: (next: string) => boolean | void = () => {}) {
  act(() => {
    root.render(
      <SearchableSelectChip
        id="test-repo-select"
        ariaLabel="Repository"
        label="Repository"
        selectedLabel="Repository"
        value=""
        onChange={onChange}
        options={OPTIONS}
      />,
    );
  });
}

function trigger() {
  const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  if (!button) throw new Error("trigger button not found");
  return button;
}

function openPanel() {
  act(() => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function panel() {
  return container.querySelector<HTMLElement>('[role="listbox"]')?.parentElement ?? null;
}

function combobox() {
  const input = container.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!input) throw new Error("combobox not found");
  return input;
}

describe("SearchableSelectChip", () => {
  it("opens a panel anchored to the trigger (absolute against a relative wrapper)", () => {
    mount();
    expect(panel()).toBeNull();

    openPanel();

    const wrapper = trigger().parentElement;
    expect(wrapper?.className).toContain("relative");

    const openedPanel = panel();
    expect(openedPanel).not.toBeNull();
    // Positioning regression guard: the popover must anchor to its trigger
    // wrapper, drop below it, and sit on the dropdown layer.
    expect(openedPanel?.parentElement).toBe(wrapper);
    expect(openedPanel?.className).toContain("absolute");
    expect(openedPanel?.className).toContain("top-full");
    expect(openedPanel?.className).toContain("z-dropdown");
  });

  it("uses Monochrome Control surface tokens (hairline ring, no drop shadow, no pill trigger)", () => {
    mount();
    openPanel();

    const openedPanel = panel();
    expect(openedPanel?.className).toContain("border-border");
    expect(openedPanel?.className).toContain("bg-surface-1");
    expect(openedPanel?.className).toContain("shadow-card");
    expect(openedPanel?.className).not.toContain("shadow-xl");

    expect(trigger().className).not.toContain("rounded-full");
    expect(trigger().className).not.toContain("ring-");
  });

  it("renders the search field as the shared Input primitive and focuses it on open", () => {
    mount();
    openPanel();

    const search = container.querySelector<HTMLInputElement>("#test-repo-select-search");
    expect(search).not.toBeNull();
    // The shared Input primitive owns the border/focus treatment; the old
    // hand-rolled input doubled borders under the global focus-visible rule.
    expect(search?.className).toContain("control-sm");
    expect(search?.className).toContain("border-border-strong");
    expect(search?.className).not.toContain("outline-none");
    expect(document.activeElement).toBe(search);
  });

  it("filters options and selects one", () => {
    const onChange = vi.fn();
    mount(onChange);
    openPanel();

    const search = container.querySelector<HTMLInputElement>("#test-repo-select-search");
    if (!search) throw new Error("search input not found");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "two");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual(["a/two · private"]);

    act(() => {
      options[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("https://github.com/a/two");
    expect(panel()).toBeNull();
  });

  it("exposes the controlled listbox and active option to assistive technology", () => {
    mount();
    openPanel();

    const input = combobox();
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    const activeId = input.getAttribute("aria-activedescendant");

    expect(input.getAttribute("aria-controls")).toBe(listbox?.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(activeId).not.toBeNull();
    expect(document.getElementById(activeId!)?.textContent).toBe("a/one");
  });

  it("navigates enabled options and commits the active option from the keyboard", () => {
    const onChange = vi.fn();
    mount(onChange);
    openPanel();
    const input = combobox();

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("a/two · private");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("a/one");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("https://github.com/a/two");
    expect(panel()).toBeNull();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    mount();
    openPanel();

    act(() => combobox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});

describe("command composer clipping", () => {
  it("does not clip composer-anchored popovers (.command-composer has no overflow hidden)", () => {
    // Regression guard: `overflow: hidden` on .command-composer clipped the
    // repo/model select panels, prompt autocomplete dropdowns, and the
    // send-button tooltip, leaving a misaligned sliver over the toolbar row.
    const css = readFileSync(join(__dirname, "../App.css"), "utf8");
    const rule = css.match(/\.command-composer\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).not.toMatch(/overflow\s*:\s*hidden/);
  });
});
