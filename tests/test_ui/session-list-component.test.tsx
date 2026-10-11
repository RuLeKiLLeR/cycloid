import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_STATUS_CHIPS } from "../../apps/ui/src/constants";
import type { SessionMetadata } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

let happyWindow: Window;
let root: { render: (node: unknown) => void; unmount: () => void };
let container: HTMLElement;
let act: (callback: () => void | Promise<void>) => void | Promise<void>;
let createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
let createRoot: (container: Element | DocumentFragment) => { render: (node: unknown) => void; unmount: () => void };
let MemoryRouter: unknown;
let SessionList: unknown;

async function importUiRuntime(packagePath: string) {
  const appSpecifier = "../../apps/ui/node_modules/" + packagePath;
  try {
    return await import(/* @vite-ignore */ appSpecifier);
  } catch {
    return await import(packagePath);
  }
}

async function loadUiModules() {
  if (SessionList) return;
  const react = await importUiRuntime("react");
  const reactDom = await importUiRuntime("react-dom/client");
  const router = await importUiRuntime("react-router");
  const sessionList = await import("../../apps/ui/src/components/SessionList");
  act = react.act;
  createElement = react.createElement;
  createRoot = reactDom.createRoot;
  MemoryRouter = router.MemoryRouter;
  SessionList = sessionList.SessionList;
}

function installDomGlobals(windowInstance: Window) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });

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
    localStorage: windowInstance.localStorage,
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

function makeSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  const phase = overrides.phase ?? "running";
  return {
    sessionId: "session-1",
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 0,
    model: null,
    title: "Fix the widget",
    ...overrides,
  };
}

async function renderSessionList(sessions: SessionMetadata[], route = "/sessions/session-1") {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
        createElement(SessionList, { sessions, onArchive: vi.fn() }),
      ),
    );
  });
}

describe("SessionList", () => {
  beforeEach(async () => {
    await loadUiModules();
    happyWindow = new Window({ url: "http://localhost/sessions/session-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    happyWindow.close();
    vi.useRealTimers();
  });

  it("hides repo metadata when the list only spans one repo", async () => {
    await renderSessionList([
      makeSession({
        repoOwner: "acme",
        repoName: "widget",
      }),
    ]);

    const repoLabel = container.querySelector('[aria-label="Repository acme/widget"]');
    expect(repoLabel).toBeNull();
  });

  it("renders repo metadata when the list spans multiple repos", async () => {
    await renderSessionList([
      makeSession({
        repoOwner: "acme",
        repoName: "widget",
      }),
      makeSession({
        sessionId: "session-2",
        repoOwner: "acme",
        repoName: "api",
        title: "Fix the API",
      }),
    ]);

    const repoLabel = container.querySelector('[aria-label="Repository acme/widget"]');
    expect(repoLabel?.textContent).toBe("widget");
  });

  it("does not render an orphan separator after repo metadata when no inline status follows", async () => {
    await renderSessionList([
      makeSession({
        repoOwner: "acme",
        repoName: "widget",
      }),
      makeSession({
        sessionId: "session-2",
        repoOwner: "acme",
        repoName: "api",
        title: "Fix the API",
      }),
    ]);

    const repoLabel = container.querySelector('[aria-label="Repository acme/widget"]');
    const metadataRow = repoLabel?.parentElement;

    expect(metadataRow?.textContent).not.toContain("·");
  });

  it("keeps stopped sessions available as a filter chip", () => {
    expect(SESSION_STATUS_CHIPS).toContain("stopped");
  });

  it("shows a green PR pill for a non-draft PR", async () => {
    await renderSessionList([makeSession({ prUrl: "https://github.com/acme/widget/pull/1" })]);

    expect(container.textContent).toContain("PR");
    expect(container.textContent).not.toContain("Draft");
  });

  it("shows a Draft pill when the PR is a draft", async () => {
    await renderSessionList([makeSession({ prUrl: "https://github.com/acme/widget/pull/1", prDraft: true })]);

    expect(container.textContent).toContain("Draft");
  });

  it("does not crash when a legacy session payload is missing phase", async () => {
    await renderSessionList([
      makeSession({
        phase: undefined as unknown as SessionMetadata["phase"],
      }),
    ]);

    expect(container.textContent).toContain("Fix the widget");
  });

  it("uses predefined indent classes for child sessions instead of inline padding styles", async () => {
    await renderSessionList([
      makeSession({
        sessionId: "parent-session",
        title: "Parent session",
      }),
      makeSession({
        sessionId: "child-session",
        parentSessionId: "parent-session",
        spawnDepth: 2,
        title: "Child session",
      }),
    ]);

    const childLink = container.querySelector('a[href="/sessions/child-session"]');
    expect(childLink?.className).toContain("pl-[58px]");
    expect(childLink?.getAttribute("style")).toBeNull();
  });

  it("treats child sessions without spawnDepth as direct children", async () => {
    await renderSessionList([
      makeSession({
        sessionId: "parent-session",
        title: "Parent session",
      }),
      makeSession({
        sessionId: "child-session",
        parentSessionId: "parent-session",
        title: "Child session",
      }),
    ]);

    const childLink = container.querySelector('a[href="/sessions/child-session"]');
    expect(childLink?.className).toContain("pl-[44px]");
    expect(childLink?.className).not.toContain("pl-4");
  });

  it("advances relative age labels on the sidebar tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T12:00:00Z"));
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval);

    await renderSessionList([
      makeSession({
        createdAt: new Date("2026-05-13T11:58:00Z").toISOString() as unknown as number,
        title: "Ticking session",
      }),
    ]);

    expect(container.textContent).toContain("2m");

    vi.setSystemTime(new Date("2026-05-13T12:01:00Z"));
    await act(async () => {
      intervalCallback?.();
    });

    expect(container.textContent).toContain("3m");
    setIntervalSpy.mockRestore();
  });

  it("recomputes recency buckets on window focus after midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 23, 59, 30));
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
      void callback;
      return 1;
    }) as typeof window.setInterval);

    await renderSessionList([
      makeSession({
        createdAt: new Date(2026, 4, 13, 23, 58).toISOString() as unknown as number,
        title: "Late session",
      }),
    ]);

    expect(container.querySelector('[aria-label="Today (1)"]')).not.toBeNull();

    vi.setSystemTime(new Date(2026, 4, 14, 0, 1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(container.querySelector('[aria-label="Yesterday (1)"]')).not.toBeNull();
    setIntervalSpy.mockRestore();
  });

  const finishedFamily = () => [
    makeSession({ sessionId: "parent", title: "Parent", phase: "completed" }),
    makeSession({ sessionId: "child-1", parentSessionId: "parent", title: "Child one", phase: "completed" }),
    makeSession({ sessionId: "child-2", parentSessionId: "parent", title: "Child two", phase: "stopped" }),
  ];

  it("collapses a finished sub-agent family behind a summary line by default", async () => {
    await renderSessionList(finishedFamily());

    expect(container.textContent).toContain("2 sub-agents");
    expect(container.querySelector('a[href="/sessions/parent"]')).not.toBeNull();
    expect(container.querySelector('a[href="/sessions/child-1"]')).toBeNull();
    expect(container.querySelector('a[href="/sessions/child-2"]')).toBeNull();
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  it("carries the status roll-up in the summary line's accessible name when collapsed", async () => {
    await renderSessionList([
      makeSession({ sessionId: "parent", title: "Parent", phase: "completed" }),
      makeSession({ sessionId: "child-1", parentSessionId: "parent", title: "Child one", phase: "completed" }),
      makeSession({ sessionId: "child-2", parentSessionId: "parent", title: "Child two", phase: "completed" }),
    ]);

    // An explicit aria-label suppresses inner text from the accessible name, so
    // the "all done" roll-up must be folded into the label itself.
    const toggle = container.querySelector('button[aria-expanded="false"]');
    expect(toggle?.getAttribute("aria-label")).toContain("all done");
  });

  it("keeps a collapsed family open when the active route is one of its children", async () => {
    // Deep-linking to a finished child (or a working child that just finished)
    // must not hide the row for the page the user is on.
    await renderSessionList(finishedFamily(), "/sessions/child-1");

    expect(container.querySelector('a[href="/sessions/child-1"]')).not.toBeNull();
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  });

  it("expands a collapsed family when the summary line is clicked", async () => {
    await renderSessionList(finishedFamily());

    const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.click();
    });

    expect(container.querySelector('a[href="/sessions/child-1"]')).not.toBeNull();
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  });

  it("keeps a family with a working sub-agent expanded by default", async () => {
    await renderSessionList([
      makeSession({ sessionId: "parent", title: "Parent", phase: "completed" }),
      makeSession({ sessionId: "child-1", parentSessionId: "parent", title: "Child one", phase: "running" }),
    ]);

    expect(container.querySelector('a[href="/sessions/child-1"]')).not.toBeNull();
    expect(container.textContent).toContain("1 sub-agent");
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  });

  it("never hides a sub-agent that is waiting for input", async () => {
    await renderSessionList([
      makeSession({ sessionId: "parent", title: "Parent", phase: "completed" }),
      makeSession({
        sessionId: "child-1",
        parentSessionId: "parent",
        title: "Waiting child",
        phase: "waiting_for_input",
      }),
    ]);

    expect(container.querySelector('a[href="/sessions/child-1"]')).not.toBeNull();
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.textContent).not.toContain("sub-agent");
  });

  it("remembers an explicit collapse across a remount", async () => {
    const working = [
      makeSession({ sessionId: "parent", title: "Parent", phase: "completed" }),
      makeSession({ sessionId: "child-1", parentSessionId: "parent", title: "Child one", phase: "running" }),
    ];
    await renderSessionList(working);

    const toggle = container.querySelector('button[aria-expanded="true"]') as HTMLElement | null;
    await act(async () => {
      toggle?.click();
    });
    expect(container.querySelector('a[href="/sessions/child-1"]')).toBeNull();

    // Fresh mount re-reads the persisted override rather than the live default.
    act(() => root.unmount());
    root = createRoot(container);
    await renderSessionList(working);

    expect(container.querySelector('a[href="/sessions/child-1"]')).toBeNull();
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });
});
