import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Badge, Button, Input, Modal, Select } from "../../apps/ui/src/components/ui";

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    KeyboardEvent: windowInstance.KeyboardEvent,
    MouseEvent: windowInstance.MouseEvent,
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

describe("ui primitives", () => {
  it("maps Button variants and sizes onto the shared control classes", () => {
    const primary = renderToStaticMarkup(<Button variant="primary" size="lg" disabled />);
    expect(primary).toContain("control-lg");
    expect(primary).toContain("bg-accent");
    expect(primary).toContain("disabled:opacity-40");

    const danger = renderToStaticMarkup(<Button variant="danger" size="sm" />);
    expect(danger).toContain("control-sm");
    expect(danger).toContain("border-error-soft-border");
  });

  it("maps Badge tones onto the chip family with grayscale warning treatment", () => {
    const html = renderToStaticMarkup(<Badge tone="warning">Warning</Badge>);
    // Badges are Geist sentence-case chips in a 1px border, no radius — the
    // one-family collapse retired the mono/uppercase/tracking instrument register.
    expect(html).toContain("font-medium");
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-[0.08em]");
    // Warning is grayscale — the label carries the state, never a hue.
    expect(html).toContain("border-border-hover");
    expect(html).toContain("text-text-primary");
    expect(html).not.toContain("bg-warning-soft");
    expect(html).not.toContain("border-warning-soft-border");
  });

  it("renders Input and Select with tokenized focus and control classes", () => {
    const input = renderToStaticMarkup(<Input aria-label="Name" />);
    expect(input).toContain("control-md");
    // Focus flips the border to white (border-focus); no ring replacements.
    expect(input).toContain("focus-visible:border-border-focus");
    expect(input).toContain("border-border-strong");
    expect(input).not.toContain("ring-accent/");

    const select = renderToStaticMarkup(
      <Select aria-label="Pick one">
        <option value="a">A</option>
      </Select>,
    );
    // Select and Input share the same default rung (control-md).
    expect(select).toContain("control-md");
    expect(select).toContain("appearance-none");
    expect(select).toContain("pointer-events-none");
  });
});

describe("Modal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    happyWindow = new Window();
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  function renderModal(onClose = vi.fn()) {
    act(() => {
      root.render(
        <Modal open onClose={onClose} title="Test modal">
          <button type="button">First</button>
          <button type="button">Last</button>
        </Modal>,
      );
    });
    return onClose;
  }

  it("renders a dialog with the fixed scrim overlay", () => {
    renderModal();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // Dialog scrim is the fixed rgb(0 0 0 / 0.7), no blur (design contract).
    expect(document.body.innerHTML).toContain("bg-[rgb(0_0_0_/_0.7)]");
    expect(document.body.innerHTML).not.toContain("backdrop-blur");
  });

  it("labels the dialog from a non-string title", () => {
    act(() => {
      root.render(
        <Modal open onClose={vi.fn()} title={<span>Structured title</span>}>
          Body
        </Modal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Structured title");
    expect(dialog?.getAttribute("aria-label")).toBeNull();
  });

  it("lets callers override the panel width and padding defaults", () => {
    act(() => {
      root.render(
        <Modal open onClose={vi.fn()} title="Wide modal" className="w-fit max-w-[min(96vw,1440px)] p-0">
          <button type="button">Only button</button>
        </Modal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain("w-fit");
    expect(dialog?.className).toContain("max-w-[min(96vw,1440px)]");
    expect(dialog?.className).toContain("p-0");
    expect(dialog?.className).not.toContain("w-full");
    expect(dialog?.className).not.toContain("max-w-md");
    expect(dialog?.className).not.toContain("p-5");
  });

  it("closes on Escape", () => {
    const onClose = renderModal();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog", () => {
    renderModal();
    const buttons = Array.from(document.querySelectorAll("button"));
    const first = buttons.find((button) => button.textContent === "First");
    const last = buttons.find((button) => button.textContent === "Last");
    if (!first || !last) throw new Error("Modal buttons not found");

    act(() => {
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      first.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("excludes aria-hidden='true' but keeps aria-hidden='false' in the focus trap", () => {
    act(() => {
      root.render(
        <Modal open onClose={vi.fn()} title="Test modal">
          <button type="button">First</button>
          <button type="button" aria-hidden="true">
            Hidden
          </button>
          <button type="button" aria-hidden="false">
            Last
          </button>
        </Modal>,
      );
    });
    const buttons = Array.from(document.querySelectorAll("button"));
    const first = buttons.find((button) => button.textContent === "First");
    const last = buttons.find((button) => button.textContent === "Last");
    if (!first || !last) throw new Error("Modal buttons not found");

    // Shift+Tab from the first focusable wraps to the last focusable. The
    // aria-hidden="false" button must be that last element, proving it was not
    // dropped from the trap; the aria-hidden="true" button is skipped.
    act(() => {
      first.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });
});
