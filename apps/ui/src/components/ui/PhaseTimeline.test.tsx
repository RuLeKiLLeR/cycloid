import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Phase, type PhaseState, PhaseTimeline } from "./PhaseTimeline";

let container: HTMLDivElement;
let root: Root;

const PHASES: Phase[] = [
  { key: "plan", label: "Plan" },
  { key: "build", label: "Build" },
  { key: "verify", label: "Verify" },
  { key: "review", label: "Review" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function states() {
  return Array.from(container.querySelectorAll("li")).map((li) => li.getAttribute("data-state"));
}

describe("PhaseTimeline", () => {
  it("maps currentIndex to done/current/pending", () => {
    act(() => {
      root.render(<PhaseTimeline phases={PHASES} currentIndex={1} />);
    });
    expect(states()).toEqual(["done", "current", "pending", "pending"]);
  });

  it("marks the current phase with aria-current=step", () => {
    act(() => {
      root.render(<PhaseTimeline phases={PHASES} currentIndex={2} />);
    });
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Verify");
  });

  it("honors an explicit states array over currentIndex", () => {
    const explicit: PhaseState[] = ["done", "done", "current", "pending"];
    act(() => {
      root.render(<PhaseTimeline phases={PHASES} currentIndex={0} states={explicit} />);
    });
    expect(states()).toEqual(explicit);
  });

  it("marks paused and failed stages as current without the live animation", () => {
    const explicit: PhaseState[] = ["done", "paused", "failed", "pending"];
    act(() => root.render(<PhaseTimeline phases={PHASES} states={explicit} />));
    expect(states()).toEqual(explicit);
    const currentSteps = container.querySelectorAll('[aria-current="step"]');
    expect(currentSteps).toHaveLength(2);
    expect(currentSteps[0]?.querySelector(".review-loop-breathe")).toBeNull();
    expect(currentSteps[1]?.querySelector(".review-loop-breathe")).toBeNull();
  });

  it("renders skipped stages struck and dashed, never as current", () => {
    const explicit: PhaseState[] = ["done", "skipped", "skipped", "done"];
    act(() => root.render(<PhaseTimeline phases={PHASES} states={explicit} />));
    expect(states()).toEqual(explicit);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
    const skipped = container.querySelector('[data-state="skipped"]');
    expect(skipped?.querySelector(".border-dashed")).not.toBeNull();
    expect(skipped?.querySelector(".line-through")).not.toBeNull();
    expect(skipped?.textContent).toContain("(skipped)");
  });

  it("renders horizontally when requested", () => {
    act(() => {
      root.render(<PhaseTimeline phases={PHASES} currentIndex={0} orientation="horizontal" />);
    });
    expect(container.querySelector("ol")?.className).toContain("items-center");
    expect(states()).toEqual(["current", "pending", "pending", "pending"]);
  });
});
