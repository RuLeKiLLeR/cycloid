import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionArtifactDrawer } from "./SessionArtifactDrawer";

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

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Artifacts
      </button>
      <SessionArtifactDrawer open={open} onClose={() => setOpen(false)} returnFocusRef={triggerRef}>
        <button type="button">Last action</button>
      </SessionArtifactDrawer>
    </>
  );
}

describe("SessionArtifactDrawer", () => {
  it("is a below-xl modal and focuses its close control", () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector("button") as HTMLButtonElement;
    act(() => trigger.click());
    const shell = container.querySelector(".xl\\:hidden");
    const dialog = container.querySelector('[role="dialog"]');
    expect(shell).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close details");
  });

  it("closes with Escape and restores focus to the trigger", () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector("button") as HTMLButtonElement;
    act(() => trigger.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps keyboard focus inside the drawer", () => {
    act(() => root.render(<Harness />));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    const buttons = Array.from(container.querySelectorAll('[role="dialog"] button')) as HTMLButtonElement[];
    const last = buttons[buttons.length - 1] as HTMLButtonElement;
    last.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
  });
});
