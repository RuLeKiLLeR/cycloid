import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStickyBar } from "../../apps/ui/src/components/SessionStickyBar";
import type { SessionDetail } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
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

async function renderWithRoot(render: (root: Root) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    render(root);
  });

  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "session-123456",
    phase: "completed",
    displayStatus: displayStatusFromPhase(overrides.phase ?? "completed"),
    title: "Improve transcript UX",
    repoUrl: "https://github.com/trycycloid/cycloid",
    prUrl: "https://github.com/trycycloid/cycloid/pull/123",
    createdAt: 0,
    model: null,
    queueLength: 0,
    startBranch: null,
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  };
}

describe("SessionStickyBar", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/sessions/session-123456" });
    installDomGlobals(happyWindow);
  });

  afterEach(() => {
    happyWindow.close();
    document.body.innerHTML = "";
  });

  it("renders title, status, and safe PR link", async () => {
    const onViewPr = vi.fn();
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession(),
          hydrated: true,
          visible: true,
          onViewPr,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Improve transcript UX");
    expect(rendered.container.querySelector('[aria-label="Session status: PR ready"]')).not.toBeNull();
    const link = rendered.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/trycycloid/cycloid/pull/123");

    link?.addEventListener("click", (event) => event.preventDefault());
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onViewPr).toHaveBeenCalledTimes(1);

    await rendered.unmount();
  });

  it("renders without a PR link", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession({ prUrl: null, phase: "running" }),
          hydrated: true,
          visible: true,
          onViewPr: vi.fn(),
        }),
      );
    });

    expect(rendered.container.querySelector("a")).toBeNull();
    expect(rendered.container.querySelector('[aria-label="Session status: Working"]')).not.toBeNull();

    await rendered.unmount();
  });

  it("renders draft PR copy in sentence case", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession({ prDraft: true }),
          hydrated: true,
          visible: true,
          onViewPr: vi.fn(),
        }),
      );
    });

    expect(rendered.container.textContent).toContain("View draft");
    expect(rendered.container.textContent).not.toContain("View Draft");

    await rendered.unmount();
  });

  it("collapses hidden chrome and removes hidden PR links from tab order", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession(),
          hydrated: true,
          visible: false,
          onViewPr: vi.fn(),
        }),
      );
    });
    const stickyBar = rendered.container.querySelector('[data-session-sticky-bar="true"]');

    expect(stickyBar?.className).toContain("h-0");
    expect(stickyBar?.className).toContain("mb-0");
    expect(stickyBar?.querySelector("a")).toBeNull();
    expect(rendered.container.textContent).not.toContain("View PR");

    await rendered.unmount();
  });

  it("does not render unsafe PR URLs", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession({ prUrl: "javascript:alert(1)" }),
          hydrated: true,
          visible: true,
          onViewPr: vi.fn(),
        }),
      );
    });

    expect(rendered.container.querySelector("a")).toBeNull();
    expect(rendered.container.textContent).not.toContain("View PR");

    await rendered.unmount();
  });

  it("gates status and PR affordances until hydrated", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(SessionStickyBar, {
          session: makeSession(),
          hydrated: false,
          visible: true,
          onViewPr: vi.fn(),
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Improve transcript UX");
    expect(rendered.container.querySelector('[aria-label^="Session status:"]')).toBeNull();
    expect(rendered.container.querySelector("a")).toBeNull();

    await rendered.unmount();
  });
});
