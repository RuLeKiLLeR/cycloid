import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReportPanel } from "../../apps/ui/src/components/session/panels/ReportPanel";
import { useTransitionReveal } from "../../apps/ui/src/hooks/useTransitionReveal";
import type { SessionDetail } from "../../apps/ui/src/types";

let container: HTMLDivElement;
let root: Root;
let happyWindow: Window;

function Harness({ status }: { status: string }) {
  const reveal = useTransitionReveal(status, "PR opened");
  return <span data-reveal={String(reveal)}>{status}</span>;
}

function renderStatus(status: string) {
  act(() => root.render(<Harness status={status} />));
}

function renderReport(isComplete: boolean) {
  const session = {
    sessionId: "session-1",
    phase: isComplete ? "completed" : "running",
    displayStatus: isComplete ? "completed" : "working",
    prUrl: null,
    createdAt: 1,
    model: null,
    title: "Session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
  } as SessionDetail;
  act(() =>
    root.render(
      <ReportPanel
        session={session}
        requestText="Add a flourish"
        finalMessage={null}
        changes={[]}
        screenshots={[]}
        isComplete={isComplete}
      />,
    ),
  );
}

beforeEach(() => {
  happyWindow = new Window();
  for (const [key, value] of Object.entries({
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    Node: happyWindow.Node,
    Event: happyWindow.Event,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  happyWindow.close();
});

describe("useTransitionReveal", () => {
  it("reveals once for an observed transition to the target", () => {
    renderStatus("Running");
    renderStatus("PR opened");
    expect(container.firstElementChild?.getAttribute("data-reveal")).toBe("true");
    renderStatus("Blocked");
    renderStatus("PR opened");
    expect(container.firstElementChild?.getAttribute("data-reveal")).toBe("true");
  });

  it("does not reveal on an initially completed mount, remount, superseded, or blocked state", () => {
    renderStatus("PR opened");
    expect(container.firstElementChild?.getAttribute("data-reveal")).toBe("false");
    act(() => root.unmount());
    root = createRoot(container);
    renderStatus("Superseded");
    renderStatus("Blocked");
    expect(container.firstElementChild?.getAttribute("data-reveal")).toBe("false");
  });
});

describe("ReportPanel reveal", () => {
  it("settles only for completion observed in place", () => {
    renderReport(false);
    renderReport(true);
    expect(container.firstElementChild?.classList.contains("review-loop-settle")).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    renderReport(true);
    expect(container.firstElementChild?.classList.contains("review-loop-settle")).toBe(false);
  });
});
