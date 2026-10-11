import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";

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

function mount(onChange = vi.fn()) {
  function Harness() {
    const [value, setValue] = useState("one");
    return (
      <SegmentedControl
        ariaLabel="View"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          { value: "one", label: "One" },
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "three", label: "Three" },
        ]}
      />
    );
  }

  act(() => root.render(<Harness />));
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

function press(button: HTMLButtonElement, key: string) {
  act(() => button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

describe("SegmentedControl", () => {
  it("keeps only the selected enabled radio in the tab order", () => {
    const radios = mount();
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("moves selection and focus with arrows while skipping disabled options", () => {
    const onChange = vi.fn();
    const radios = mount(onChange);
    radios[0].focus();

    press(radios[0], "ArrowRight");

    expect(onChange).toHaveBeenLastCalledWith("three");
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].tabIndex).toBe(0);
    expect(radios[2].getAttribute("aria-checked")).toBe("true");

    press(radios[2], "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("one");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("supports Home and End navigation", () => {
    const onChange = vi.fn();
    const radios = mount(onChange);

    press(radios[0], "End");
    expect(onChange).toHaveBeenLastCalledWith("three");
    expect(document.activeElement).toBe(radios[2]);

    press(radios[2], "Home");
    expect(onChange).toHaveBeenLastCalledWith("one");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("draws dividers and the selection bar as pseudo-elements, not borders", () => {
    // The global *:focus-visible rule flips border-color to white; real border-l
    // dividers / border-t selection bars would light up on keyboard focus, so
    // the segments must not carry them.
    const radios = mount();
    for (const radio of radios) {
      expect(radio.className).not.toContain("border-l");
      expect(radio.className).not.toContain("border-t-");
      expect(radio.className).toContain("before:w-px");
      expect(radio.className).toContain("after:top-0");
    }
    expect(radios[0].className).toContain("after:bg-border-focus");
    expect(radios[2].className).not.toContain("after:bg-border-focus");
  });
});

describe("SegmentedControl multiSelect", () => {
  function mountMulti(onChange = vi.fn()) {
    function Harness() {
      const [value, setValue] = useState<string[]>(["one"]);
      return (
        <SegmentedControl
          multiSelect
          ariaLabel="Lanes"
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
            { value: "disabled", label: "Disabled", disabled: true },
            { value: "three", label: "Three" },
          ]}
        />
      );
    }

    act(() => root.render(<Harness />));
    return Array.from(container.querySelectorAll<HTMLButtonElement>("[aria-pressed]"));
  }

  it("renders a group of aria-pressed toggles instead of radios", () => {
    const toggles = mountMulti();
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(toggles.map((toggle) => toggle.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    // Toggles are independently focusable — no roving tabindex.
    expect(toggles.every((toggle) => toggle.tabIndex === 0 || toggle.disabled)).toBe(true);
  });

  it("toggles membership on click, preserving option order", () => {
    const onChange = vi.fn();
    const toggles = mountMulti(onChange);

    act(() => toggles[3].click());
    expect(onChange).toHaveBeenLastCalledWith(["one", "three"]);
    expect(toggles[3].getAttribute("aria-pressed")).toBe("true");

    act(() => toggles[0].click());
    expect(onChange).toHaveBeenLastCalledWith(["three"]);
    expect(toggles[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("moves focus with arrows without toggling, skipping disabled segments", () => {
    const onChange = vi.fn();
    const toggles = mountMulti(onChange);
    toggles[0].focus();

    press(toggles[0], "ArrowRight");
    expect(document.activeElement).toBe(toggles[1]);

    press(toggles[1], "ArrowRight");
    expect(document.activeElement).toBe(toggles[3]); // skips disabled

    expect(onChange).not.toHaveBeenCalled();
  });
});
