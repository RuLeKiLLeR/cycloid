// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AttentionSignalState,
  deriveAttentionSignalState,
  useAttentionSignal,
} from "../../apps/ui/src/hooks/useAttentionSignal";
import type { SessionMetadata } from "../../apps/ui/src/types";
import {
  clearAuthenticatedBaseTitle,
  resetAuthenticatedTitle,
  setAuthenticatedBaseTitle,
  setAuthenticatedTitleAttention,
} from "../../apps/ui/src/utils/authenticated-title";

function session(sessionId: string, displayStatus: SessionMetadata["displayStatus"]): SessionMetadata {
  return {
    sessionId,
    phase: displayStatus === "completed" ? "completed" : "running",
    displayStatus,
    prUrl: null,
    createdAt: 1,
    model: null,
    title: null,
  };
}

function baseline(sessions: SessionMetadata[] = []): AttentionSignalState {
  return deriveAttentionSignalState({ statuses: new Map(), waiting: false, completed: false }, sessions, "visible");
}

describe("deriveAttentionSignalState", () => {
  it("tracks waiting sessions as a level-triggered signal", () => {
    const waiting = deriveAttentionSignalState(baseline(), [session("one", "waiting_for_input")], "visible");
    expect(waiting.waiting).toBe(true);
    expect(deriveAttentionSignalState(waiting, [session("one", "working")], "visible").waiting).toBe(false);
  });

  it("arms completion only for a known session transition while hidden", () => {
    const working = baseline([session("one", "working")]);
    expect(deriveAttentionSignalState(working, [session("one", "completed")], "visible").completed).toBe(false);
    expect(deriveAttentionSignalState(working, [session("one", "completed")], "hidden").completed).toBe(true);
  });

  it("does not arm from hydration, new completed sessions, removals, or remounts", () => {
    expect(baseline([session("one", "completed")]).completed).toBe(false);
    const working = baseline([session("one", "working")]);
    expect(
      deriveAttentionSignalState(working, [session("one", "working"), session("two", "completed")], "hidden").completed,
    ).toBe(false);
    expect(deriveAttentionSignalState(working, [], "hidden").completed).toBe(false);
    expect(baseline([session("one", "completed")]).completed).toBe(false);
  });

  it("preserves state identity when session values are unchanged", () => {
    const state = baseline([session("one", "working")]);
    expect(deriveAttentionSignalState(state, [session("one", "working")], "visible")).toBe(state);
  });
});

describe("authenticated title writer", () => {
  beforeEach(resetAuthenticatedTitle);
  afterEach(resetAuthenticatedTitle);

  it("composes base-title changes with one attention prefix", () => {
    const owner = Symbol("page");
    setAuthenticatedBaseTitle(owner, "Session - Cycloid");
    setAuthenticatedTitleAttention(true);
    expect(document.title).toBe("● Session - Cycloid");
    setAuthenticatedBaseTitle(owner, "Other - Cycloid");
    setAuthenticatedTitleAttention(true);
    expect(document.title).toBe("● Other - Cycloid");
    setAuthenticatedTitleAttention(false);
    expect(document.title).toBe("Other - Cycloid");
  });

  it("ignores cleanup from a superseded page owner", () => {
    const oldOwner = Symbol("old");
    const newOwner = Symbol("new");
    setAuthenticatedBaseTitle(oldOwner, "Old - Cycloid");
    setAuthenticatedBaseTitle(newOwner, "New - Cycloid");
    clearAuthenticatedBaseTitle(oldOwner);
    expect(document.title).toBe("New - Cycloid");
  });
});

describe("useAttentionSignal", () => {
  let visibilityState: DocumentVisibilityState;
  let container: HTMLDivElement;
  let root: Root;

  function Harness({ sessions }: { sessions: SessionMetadata[] }) {
    useAttentionSignal(sessions);
    return null;
  }

  function render(sessions: SessionMetadata[]) {
    act(() => root.render(<Harness sessions={sessions} />));
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
    document.head.innerHTML = [
      '<link rel="icon" href="/original-32.png" sizes="32x32">',
      '<link rel="icon" href="/original-16.png" sizes="16x16">',
      '<link rel="apple-touch-icon" href="/apple.png">',
    ].join("");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetAuthenticatedTitle();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.head.innerHTML = "";
    resetAuthenticatedTitle();
  });

  it("swaps and restores icon hrefs without touching the apple icon", () => {
    render([session("one", "working")]);
    render([session("one", "waiting_for_input")]);
    expect(document.querySelector<HTMLLinkElement>('link[sizes="32x32"]')?.getAttribute("href")).toBe(
      "/favicon-32-attention.png",
    );
    expect(document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/apple.png",
    );
    act(() => root.unmount());
    root = createRoot(container);
    expect(document.querySelector<HTMLLinkElement>('link[sizes="32x32"]')?.getAttribute("href")).toBe(
      "/original-32.png",
    );
  });

  it("focus clears completion but preserves a waiting signal", () => {
    visibilityState = "hidden";
    render([session("one", "working"), session("two", "waiting_for_input")]);
    render([session("one", "completed"), session("two", "waiting_for_input")]);
    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.title.startsWith("● ")).toBe(true);
    render([session("one", "completed"), session("two", "working")]);
    expect(document.title.startsWith("● ")).toBe(false);
  });

  it("does not throw when icon links are missing", () => {
    document.head.innerHTML = "";
    expect(() => render([session("one", "waiting_for_input")])).not.toThrow();
  });
});
