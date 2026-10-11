// Run-history view for a scheduled rule: outcome-chip mapping (pure) plus
// rendering of the stats readout, run rows, session links, empty state, and
// cursor-driven load-more against a mocked runs API.
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledRuleRun, ScheduledRuleRunsPage } from "../../apps/ui/src/api/automation-schedules";
import { runChip, runDetail, RunHistory } from "../../apps/ui/src/components/automations/RunHistory";

const apiMocks = vi.hoisted(() => ({
  fetchScheduledRuleRuns: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/automation-schedules.ts", () => ({
  fetchScheduledRuleRuns: apiMocks.fetchScheduledRuleRuns,
}));

vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const React = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      React.useEffect(effect, []);
    },
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

function makeRun(overrides: Partial<ScheduledRuleRun> = {}): ScheduledRuleRun {
  return {
    jobKey: "automation:rule-1:1000",
    slotMs: 1000,
    outcome: "fired",
    failureReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    sessionId: "automation-rule-1-1000",
    sessionRichStatus: "completed",
    ...overrides,
  };
}

describe("runChip", () => {
  it("labels a pending slot job as starting", () => {
    expect(runChip(makeRun({ outcome: null }))).toEqual({ status: "running", label: "Starting" });
  });

  it("labels scheduler failures as failed", () => {
    expect(runChip(makeRun({ outcome: "failed", failureReason: "session_create_projection" }))).toEqual({
      status: "failed",
      label: "Failed",
    });
  });

  it("labels both skip outcomes as skipped", () => {
    expect(runChip(makeRun({ outcome: "skipped_overlap" })).label).toBe("Skipped");
    expect(runChip(makeRun({ outcome: "skipped_concurrency" })).label).toBe("Skipped");
  });

  it("reports the created session's current status for fired runs", () => {
    expect(runChip(makeRun({ sessionRichStatus: "completed" }))).toEqual({ status: "done", label: "Completed" });
    expect(runChip(makeRun({ sessionRichStatus: "failed" }))).toEqual({ status: "failed", label: "Failed" });
    expect(runChip(makeRun({ sessionRichStatus: "running" }))).toEqual({ status: "running", label: "Running" });
    expect(runChip(makeRun({ sessionRichStatus: "archived" }))).toEqual({ status: "pr-open", label: "Archived" });
  });

  it("falls back to a plain ran label when the session row is gone", () => {
    expect(runChip(makeRun({ sessionId: null, sessionRichStatus: null }))).toEqual({
      status: "pr-open",
      label: "Ran",
    });
  });
});

describe("runDetail", () => {
  it("explains skips and surfaces failure reasons", () => {
    expect(runDetail(makeRun({ outcome: "skipped_overlap" }))).toBe("Previous run still active");
    expect(runDetail(makeRun({ outcome: "skipped_concurrency" }))).toBe("Concurrency limit reached");
    expect(runDetail(makeRun({ outcome: "failed", failureReason: "prompt_enqueue_500" }))).toBe("prompt_enqueue_500");
    expect(runDetail(makeRun())).toBeNull();
  });
});

describe("RunHistory", () => {
  let happyWindow: Window;
  let container: HTMLElement;
  let root: Root;

  function installDomGlobals(windowInstance: Window) {
    const globals = {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      localStorage: windowInstance.localStorage,
      location: windowInstance.location,
      history: windowInstance.history,
      HTMLElement: windowInstance.HTMLElement,
      HTMLButtonElement: windowInstance.HTMLButtonElement,
      HTMLAnchorElement: windowInstance.HTMLAnchorElement,
      SVGElement: windowInstance.SVGElement,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
    };
    for (const [key, value] of Object.entries(globals)) {
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
    await Promise.resolve();
  }

  async function renderRunHistory(ruleId = "rule-1") {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(RunHistory, { ruleId })));
      await flushAsyncWork();
    });
  }

  function makePage(overrides: Partial<ScheduledRuleRunsPage> = {}): ScheduledRuleRunsPage {
    return {
      items: [],
      nextCursor: null,
      stats: {
        last24h: { fired: 0, failed: 0, skipped: 0 },
        last7d: { fired: 0, failed: 0, skipped: 0 },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.example.test/automations" });
    installDomGlobals(happyWindow);
    apiMocks.fetchScheduledRuleRuns.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushAsyncWork();
    });
    happyWindow.close();
    vi.unstubAllGlobals();
  });

  it("renders the stats readout and one row per run with a session link", async () => {
    apiMocks.fetchScheduledRuleRuns.mockResolvedValue(
      makePage({
        items: [
          makeRun({
            jobKey: "j1",
            slotMs: 3000,
            outcome: "failed",
            failureReason: "prompt_enqueue_500",
            sessionId: null,
            sessionRichStatus: null,
          }),
          makeRun({ jobKey: "j2", slotMs: 2000, outcome: "skipped_overlap", sessionId: null, sessionRichStatus: null }),
          makeRun({ jobKey: "j3", slotMs: 1000 }),
        ],
        stats: {
          last24h: { fired: 1, failed: 1, skipped: 1 },
          last7d: { fired: 4, failed: 2, skipped: 3 },
        },
      }),
    );

    await renderRunHistory();

    expect(apiMocks.fetchScheduledRuleRuns).toHaveBeenCalledWith("rule-1");
    const text = container.textContent ?? "";
    // One 7d stats line; the 24h readout is gone.
    expect(text).toContain("4 fired · 2 failed · 3 skipped");
    expect(text).not.toContain("24h");
    expect(text).toContain("Failed");
    expect(text).toContain("prompt_enqueue_500");
    expect(text).toContain("Skipped");
    expect(text).toContain("Previous run still active");
    expect(text).toContain("Completed");

    // The fired run's row itself is the session link; no bare "View session" text.
    expect(text).not.toContain("View session");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/sessions/automation-rule-1-1000");
  });

  it("shows a calm empty state when the rule has no runs", async () => {
    apiMocks.fetchScheduledRuleRuns.mockResolvedValue(makePage());
    await renderRunHistory();
    expect(container.textContent).toContain("No runs yet");
  });

  it("shows the load error", async () => {
    apiMocks.fetchScheduledRuleRuns.mockRejectedValue(new Error("boom"));
    await renderRunHistory();
    expect(container.textContent).toContain("boom");
  });

  it("loads the next page with the returned cursor", async () => {
    apiMocks.fetchScheduledRuleRuns
      .mockResolvedValueOnce(makePage({ items: [makeRun({ jobKey: "j1", slotMs: 2000 })], nextCursor: "2000" }))
      .mockResolvedValueOnce(makePage({ items: [makeRun({ jobKey: "j2", slotMs: 1000 })] }));

    await renderRunHistory();
    const loadMore = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more",
    );
    expect(loadMore).toBeDefined();
    await act(async () => {
      loadMore!.click();
      await flushAsyncWork();
    });

    expect(apiMocks.fetchScheduledRuleRuns).toHaveBeenLastCalledWith("rule-1", "2000");
    // Both pages render and the cursor is exhausted.
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Load more"),
    ).toBeUndefined();
  });
});
