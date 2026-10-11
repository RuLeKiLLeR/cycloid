import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRefetchOnActive } from "./useRefetchOnActive";

type UseRefetchOnActiveOptions = Parameters<typeof useRefetchOnActive>[0];

let container: HTMLDivElement;
let root: Root;
let visibilityState: DocumentVisibilityState = "visible";

function Harness(props: UseRefetchOnActiveOptions) {
  useRefetchOnActive(props);
  return null;
}

function mount(props: UseRefetchOnActiveOptions) {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

function rerender(props: UseRefetchOnActiveOptions) {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

function dispatchFocus() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  visibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRefetchOnActive", () => {
  it("calls onActive on window focus", () => {
    const onActive = vi.fn();
    mount({ onActive });

    dispatchFocus();

    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("calls onActive when the document becomes visible", () => {
    const onActive = vi.fn();
    mount({ onActive });

    setVisibility("visible");

    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("ignores visibilitychange when the document is hidden", () => {
    const onActive = vi.fn();
    mount({ onActive });

    setVisibility("hidden");

    expect(onActive).not.toHaveBeenCalled();
  });

  it("coalesces a focus + visible pair fired together into a single call", () => {
    const onActive = vi.fn();
    mount({ onActive, coalesceMs: 1000 });

    // A browser tab switch fires both focus and visibilitychange back to back.
    dispatchFocus();
    setVisibility("visible");

    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("allows another activation after the coalesce window elapses", () => {
    const onActive = vi.fn();
    mount({ onActive, coalesceMs: 1000 });

    dispatchFocus();
    expect(onActive).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    dispatchFocus();

    expect(onActive).toHaveBeenCalledTimes(2);
  });

  it("runs a visibility-gated poll while the document is visible", () => {
    const onActive = vi.fn();
    mount({ onActive, pollMs: 30_000 });

    act(() => vi.advanceTimersByTime(30_000));
    expect(onActive).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(30_000));
    expect(onActive).toHaveBeenCalledTimes(2);
  });

  it("still refetches on return when a poll tick fired moments earlier", () => {
    // Regression: the poll must not share the focus/visibility coalesce gate, or a
    // poll tick in the second before a return would swallow the return refetch and
    // leave the list stale until the next tick (~poll interval later).
    const onActive = vi.fn();
    mount({ onActive, pollMs: 30_000, coalesceMs: 1000 });

    act(() => vi.advanceTimersByTime(30_000)); // poll tick
    expect(onActive).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(500)); // user returns 500ms later (within coalesce window)
    dispatchFocus();

    expect(onActive).toHaveBeenCalledTimes(2);
  });

  it("does not run the poll while the document is hidden", () => {
    const onActive = vi.fn();
    visibilityState = "hidden";
    mount({ onActive, pollMs: 30_000 });

    act(() => vi.advanceTimersByTime(90_000));

    expect(onActive).not.toHaveBeenCalled();
  });

  it("attaches nothing when disabled", () => {
    const onActive = vi.fn();
    mount({ onActive, pollMs: 30_000, enabled: false });

    dispatchFocus();
    setVisibility("visible");
    act(() => vi.advanceTimersByTime(60_000));

    expect(onActive).not.toHaveBeenCalled();
  });

  it("removes listeners and clears the poll on unmount", () => {
    const onActive = vi.fn();
    mount({ onActive, pollMs: 30_000 });
    act(() => root.unmount());

    dispatchFocus();
    setVisibility("visible");
    act(() => vi.advanceTimersByTime(60_000));

    expect(onActive).not.toHaveBeenCalled();
  });

  it("invokes the latest onActive after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    mount({ onActive: first });
    rerender({ onActive: second });

    dispatchFocus();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("starts firing once enabled flips from false to true (e.g. after login)", () => {
    const onActive = vi.fn();
    mount({ onActive, enabled: false });

    dispatchFocus(); // ignored while disabled
    expect(onActive).not.toHaveBeenCalled();

    rerender({ onActive, enabled: true });
    dispatchFocus();

    // The coalesce timestamp must not have been seeded while disabled, so the
    // first activation after enabling is not suppressed.
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("does not suppress the first activation after an enabled true->false->true cycle", () => {
    // Regression: the coalesce gate must reset when listeners are re-attached, or a
    // stale timestamp from before the disable would swallow the first activation
    // within coalesceMs of re-enabling.
    const onActive = vi.fn();
    mount({ onActive, enabled: true, coalesceMs: 1000 });

    dispatchFocus(); // activation stamps the gate
    expect(onActive).toHaveBeenCalledTimes(1);

    rerender({ onActive, enabled: false }); // listeners torn down
    act(() => vi.advanceTimersByTime(200)); // still within the coalesce window
    rerender({ onActive, enabled: true }); // listeners re-attached

    dispatchFocus();

    expect(onActive).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes the poll at the new cadence when pollMs changes", () => {
    const onActive = vi.fn();
    mount({ onActive, pollMs: 30_000 });

    rerender({ onActive, pollMs: 10_000 });
    act(() => vi.advanceTimersByTime(10_000));

    // The stale 30s interval was cleared; only the new 10s interval ticks.
    expect(onActive).toHaveBeenCalledTimes(1);
  });
});
