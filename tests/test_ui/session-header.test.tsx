import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChildSessionSummary } from "../../apps/ui/src/api/sessions";
import type { SessionDetail } from "../../apps/ui/src/types";
import { displayStatusFromPhase } from "../../shared/session/display-status";

vi.mock("../../apps/ui/src/api/sessions", () => ({
  fetchChildSessions: vi.fn(),
}));

let happyWindow: Window;
let root: { render: (node: unknown) => void; unmount: () => void };
let container: HTMLElement;
let act: (callback: () => void | Promise<void>) => void | Promise<void>;
let createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
let createRoot: (container: Element | DocumentFragment) => { render: (node: unknown) => void; unmount: () => void };
let MemoryRouter: unknown;
let SessionHeader: unknown;
let fetchChildSessionsMock: ReturnType<typeof vi.fn>;

async function importUiRuntime(packagePath: string) {
  const appSpecifier = "../../apps/ui/node_modules/" + packagePath;
  try {
    return await import(/* @vite-ignore */ appSpecifier);
  } catch {
    return await import(packagePath);
  }
}

async function loadUiModules() {
  if (SessionHeader) return;
  const react = await importUiRuntime("react");
  const reactDom = await importUiRuntime("react-dom/client");
  const router = await importUiRuntime("react-router");
  const sessionHeader = await import("../../apps/ui/src/components/SessionHeader");
  const sessionsApi = await import("../../apps/ui/src/api/sessions");
  act = react.act;
  createElement = react.createElement;
  createRoot = reactDom.createRoot;
  MemoryRouter = router.MemoryRouter;
  SessionHeader = sessionHeader.SessionHeader;
  fetchChildSessionsMock = vi.mocked(sessionsApi.fetchChildSessions);
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
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

let visibilityState: "hidden" | "visible" = "visible";

function setDocumentVisibility(state: "hidden" | "visible") {
  visibilityState = state;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
}

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const phase = overrides.phase ?? "idle";
  return {
    sessionId: "parent-session",
    phase,
    displayStatus: displayStatusFromPhase(phase),
    title: "Parent session",
    repoUrl: "https://github.com/test-owner/test-repo",
    prUrl: null,
    createdAt: 0,
    model: null,
    queueLength: 0,
    startBranch: null,
    lastBranch: null,
    baseBranch: "main",
    childSessionIds: ["child-1"],
    ...overrides,
  };
}

function makeChildSummary(title: string): ChildSessionSummary {
  return {
    childSessionId: "child-1",
    childSessionUrl: "/sessions/child-1",
    title,
    status: "running",
    prUrl: null,
    createdAt: 0,
    completedAt: null,
    failureReason: null,
  };
}

function makeChildSummaryWithStatus(status: ChildSessionSummary["status"]): ChildSessionSummary {
  return { ...makeChildSummary("Child title"), status };
}

async function renderHeader(session: SessionDetail, options: { hydrated?: boolean } = {}) {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/sessions/parent-session"] },
        createElement(SessionHeader, {
          session,
          onStop: vi.fn(),
          hydrated: options.hydrated ?? true,
        }),
      ),
    );
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionHeader", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await loadUiModules();
    happyWindow = new Window({ url: "http://localhost/sessions/parent-session" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setDocumentVisibility("visible");
    fetchChildSessionsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    happyWindow.close();
    vi.useRealTimers();
  });

  it("refreshes child titles when polling returns the same child with a new title", async () => {
    fetchChildSessionsMock
      .mockResolvedValueOnce([makeChildSummary("First child title")])
      .mockResolvedValueOnce([makeChildSummary("Updated child title")]);

    await renderHeader(makeSession());
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Related sessions (1)");
    expect(container.querySelector('[aria-label="Related sessions"]')).not.toBeNull();
    expect(container.textContent).toContain("First child title");
    expect(container.textContent).not.toContain("Children");
    expect(container.textContent).not.toContain("Updated child title");

    await act(async () => {
      vi.advanceTimersByTime(8000);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Updated child title");
    expect(fetchChildSessionsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps seeded headers non-actionable until hydrated", async () => {
    await renderHeader(makeSession({ phase: "running", sandboxSubstate: "none" }), { hydrated: false });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.querySelector('[aria-label="Session status: Working"]')).toBeNull();
    expect(container.textContent).not.toContain("Children");
    expect(container.textContent).not.toContain("Related sessions");
    expect(container.textContent).not.toContain("Stop");
    expect(fetchChildSessionsMock).not.toHaveBeenCalled();
  });

  it("prefers startBranch when showing the session branch pill", async () => {
    await renderHeader(makeSession({ childSessionIds: [], startBranch: "release/2026-06", baseBranch: "main" }));

    expect(container.textContent).toContain("release/2026-06");
    expect(container.textContent).not.toContain("Branch: ");
    expect(container.querySelector('[aria-label="Branch: release/2026-06"]')).not.toBeNull();
  });

  it("keeps the status chip a plain readout, not a PR link", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
      }),
    );

    const status = container.querySelector('[aria-label="Session status: PR ready"]');
    expect(status).not.toBeNull();
    // Chips are readouts; PR navigation has its own labelled affordances.
    expect(status?.closest("a")).toBeNull();
  });

  it("shows lifecycle stage labels before the legacy PR-ready fallback", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "merge_ready",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "success",
      }),
    );

    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: PR ready"]')).toBeNull();
  });

  it("prefers explicit QA state over legacy verification lifecycle labels", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "merge_ready",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        verificationState: "verification-in-progress",
        verificationResult: null,
      }),
    );

    const chip = container.querySelector('[aria-label="Session status: QA running"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toBe("QA testing is running");
    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).toBeNull();
  });

  it("does not infer merge-ready from lifecycle when explicit verification fields are clear", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "merge_ready",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        verificationState: null,
        verificationResult: null,
      }),
    );

    expect(container.querySelector('[aria-label="Session status: PR ready"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).toBeNull();
  });

  it("does not show merge-ready from explicit verification before done-state readiness", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "verifying",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
      }),
    );

    expect(container.querySelector('[aria-label="Session status: PR ready"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).toBeNull();
    expect(container.querySelector('[aria-label="Session status: QA running"]')).toBeNull();
  });

  it("does not show merge-ready from skipped verification before done-state readiness", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "merge_ready",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        verificationState: "verification-skipped",
        verificationResult: null,
      }),
    );

    expect(container.querySelector('[aria-label="Session status: PR ready"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).toBeNull();
  });

  it("uses explicit merge-ready verification with done-state readiness even when lifecycle is stale", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "completed",
        uiLifecycleStage: "verifying",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "success",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
      }),
    );

    expect(container.querySelector('[aria-label="Session status: Merge ready"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: QA running"]')).toBeNull();
  });

  it("clamps long session titles to two lines", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        title: "A very long session title that should wrap across multiple lines without pushing header controls away",
      }),
    );

    const heading = container.querySelector("h1");

    expect(heading?.className).toContain("line-clamp-2");
    expect(heading?.className).toContain("break-words");
  });

  it("falls back to lastBranch when startBranch and baseBranch are missing", async () => {
    await renderHeader(makeSession({ childSessionIds: [], startBranch: null, baseBranch: null, lastBranch: "feat/x" }));

    expect(container.textContent).toContain("feat/x");
    expect(container.querySelector('[aria-label="Branch: feat/x"]')).not.toBeNull();
  });

  it("falls back to publishedBranch when startBranch, baseBranch, and lastBranch are missing", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        startBranch: null,
        baseBranch: null,
        lastBranch: null,
        publishedBranch: "feature/published",
      }),
    );

    expect(container.textContent).toContain("feature/published");
    expect(container.querySelector('[aria-label="Branch: feature/published"]')).not.toBeNull();
  });

  it("omits the branch pill when no branch is known", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        startBranch: null,
        baseBranch: null,
        lastBranch: null,
        publishedBranch: null,
      }),
    );

    expect(container.querySelector('[aria-label^="Branch: "]')).toBeNull();
  });

  it("keeps terminal sessions stopped even when stale done state remains merge-ready", async () => {
    await renderHeader(
      makeSession({
        childSessionIds: [],
        phase: "archived",
        closeReason: "user_stopped",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "success",
      }),
    );

    expect(container.querySelector('[aria-label="Session status: Stopped"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session status: PR ready"]')).toBeNull();
  });

  it("waits for a visible tab before fetching child session status", async () => {
    setDocumentVisibility("hidden");
    fetchChildSessionsMock.mockResolvedValue([makeChildSummary("First child title")]);

    await renderHeader(makeSession());
    await act(async () => {
      await flushAsyncWork();
    });

    expect(fetchChildSessionsMock).not.toHaveBeenCalled();

    await act(async () => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new happyWindow.Event("visibilitychange"));
      await flushAsyncWork();
    });

    expect(fetchChildSessionsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pending", "Queued"],
    ["running", "Working"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["canceled", "Canceled"],
  ] as const)("maps child status %s to %s", async (status, label) => {
    fetchChildSessionsMock.mockResolvedValue([makeChildSummaryWithStatus(status)]);

    await renderHeader(makeSession());
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain(`· ${status}`);
  });

  it("stops polling while hidden and resumes when visible again", async () => {
    fetchChildSessionsMock.mockResolvedValue([makeChildSummary("Child title")]);

    await renderHeader(makeSession());
    await act(async () => {
      await flushAsyncWork();
    });

    expect(fetchChildSessionsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentVisibility("hidden");
      document.dispatchEvent(new happyWindow.Event("visibilitychange"));
      vi.advanceTimersByTime(8000);
      await flushAsyncWork();
    });

    expect(fetchChildSessionsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new happyWindow.Event("visibilitychange"));
      await flushAsyncWork();
    });

    expect(fetchChildSessionsMock).toHaveBeenCalledTimes(2);
  });

  it("enriches the idle Stopped badge with a continue-anytime title after a user soft-stop", async () => {
    await renderHeader(makeSession({ childSessionIds: [], phase: "idle", userStopped: true }));

    const chip = container.querySelector('[aria-label="Session status: Stopped"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toBe("Stopped — continue anytime");
  });

  it("keeps the plain idle Stopped badge title when the session was not user-stopped", async () => {
    await renderHeader(makeSession({ childSessionIds: [], phase: "idle" }));

    const chip = container.querySelector('[aria-label="Session status: Stopped"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toBe("Session is not actively working");
  });
});
