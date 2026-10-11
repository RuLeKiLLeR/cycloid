import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { progressLabel, SessionProgressIndicator, SessionProgressProvider } from "./SessionProgressIndicator";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SessionProgressIndicator", () => {
  it("names finalizing work from the exact step", () => {
    expect(progressLabel({ phase: "finalizing", finalizingStep: "post_execution", queueLength: 0 })).toBe(
      "Running checks…",
    );
    expect(progressLabel({ phase: "finalizing", finalizingStep: "publishing", queueLength: 0 })).toBe(
      "Publishing changes…",
    );
  });

  it("shows the active follow-up queue count", () => {
    act(() => {
      root.render(
        <SessionProgressProvider value={{ phase: "running", finalizingStep: null, queueLength: 3 }}>
          <SessionProgressIndicator />
        </SessionProgressProvider>,
      );
    });
    expect(container.textContent).toContain("Working…");
    expect(container.textContent).toContain("3 queued");
  });
});
