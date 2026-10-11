import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pageMocks = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  layout: {
    capabilities: {
      canUseBusinessSessions: true,
      canUseControlRoom: true,
    },
    repos: [{ fullName: "acme/widgets", url: "https://github.com/acme/widgets" }],
  },
}));

vi.mock("../../apps/ui/src/api/sessions", () => ({
  fetchSessions: pageMocks.fetchSessions,
}));

vi.mock("../../apps/ui/src/components/Layout", () => ({
  useLayoutContext: () => pageMocks.layout,
}));

import { SessionsPage } from "../../apps/ui/src/pages/SessionsPage";
import { displayStatusFromPhase } from "../../shared/session/display-status";

let happyWindow: Window;
let container: HTMLDivElement;
let root: Root;

function installDomGlobals(windowInstance: Window) {
  for (const [key, value] of Object.entries({
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function session(sessionId: string, phase: "failed" | "running") {
  return {
    sessionId,
    phase,
    // The server sends displayStatus on every session row
    // (normalizeSessionMetadata fills it); the mocked fetchSessions bypasses
    // that normalization, so the fixture must carry it like the API does.
    displayStatus: displayStatusFromPhase(phase),
    closeReason: null,
    prUrl: null,
    createdAt: 1,
    model: null,
    title: sessionId,
    repoOwner: "acme",
    repoName: "widgets",
    ownerLogin: "teammate",
  };
}

describe("SessionsPage", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/sessions" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pageMocks.fetchSessions.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    happyWindow.close();
  });

  it("loads URL-backed filters and paginates the matching session list", async () => {
    pageMocks.fetchSessions
      .mockResolvedValueOnce({
        sessions: [session("failed-session", "failed"), session("running-session", "running")],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ sessions: [session("second-failure", "failed")], nextCursor: null });

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/sessions?scope=business&status=attention&repo=acme/widgets&q=fix"] },
          createElement(SessionsPage),
        ),
      );
      await flushAsyncWork();
    });

    expect(pageMocks.fetchSessions).toHaveBeenNthCalledWith(1, {
      scope: "business",
      cursor: null,
      status: null,
      query: "fix",
    });
    expect(container.querySelector('a[href="/sessions/failed-session"]')).not.toBeNull();
    expect(container.querySelector('a[href="/sessions/running-session"]')).toBeNull();
    // No header Activity button: the sidebar nav already links /activity under
    // the same capability gate.
    expect(container.querySelector('a[href="/activity"]')).toBeNull();

    const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load more",
    );
    await act(async () => {
      loadMore?.click();
      await flushAsyncWork();
    });

    expect(pageMocks.fetchSessions).toHaveBeenNthCalledWith(2, {
      scope: "business",
      cursor: "next",
      status: null,
      query: "fix",
    });
    expect(container.querySelector('a[href="/sessions/second-failure"]')).not.toBeNull();
  });
});
