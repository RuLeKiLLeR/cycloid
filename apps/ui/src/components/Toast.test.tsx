import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./Toast";

let container: HTMLDivElement;
let root: Root;
let show: ReturnType<typeof useToast> | null = null;

function Harness() {
  show = useToast();
  return null;
}

function mount() {
  act(() => {
    root.render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  show = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function toastNodes() {
  return Array.from(document.querySelectorAll('[role="status"], [role="alert"]'));
}

function liveRegion() {
  return document.querySelector('[aria-live="polite"]');
}

describe("ToastProvider", () => {
  it("shows a toast with the message", () => {
    mount();
    act(() => show!("Saved"));
    const nodes = toastNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toContain("Saved");
  });

  it("dismisses on close-button click", () => {
    mount();
    act(() => show!("Saved"));
    const button = document.querySelector('[role="status"] button[aria-label="Dismiss"]') as HTMLButtonElement;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(toastNodes()).toHaveLength(0);
  });

  it("auto-dismisses after the duration", () => {
    vi.useFakeTimers();
    mount();
    act(() => show!("Saved", { durationMs: 1000 }));
    expect(toastNodes()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(toastNodes()).toHaveLength(0);
  });

  it("applies the error variant styling", () => {
    mount();
    act(() => show!("Boom", { variant: "error" }));
    expect(toastNodes()[0].className).toContain("bg-error-soft");
  });

  it("renders the live region before any toast so announcements aren't missed", () => {
    mount();
    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(region!.children).toHaveLength(0);
  });

  it("announces error toasts assertively via role=alert", () => {
    mount();
    act(() => show!("Boom", { variant: "error" }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Boom");
    act(() => show!("Saved"));
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Saved");
  });
});
