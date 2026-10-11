import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SessionProgressIndicator,
  SessionProgressProvider,
} from "../../apps/ui/src/components/SessionProgressIndicator";

describe("SessionProgressIndicator", () => {
  let happyWindow: Window;
  let root: Root | null = null;

  beforeEach(() => {
    happyWindow = new Window();
    for (const [key, value] of Object.entries({
      window: happyWindow,
      document: happyWindow.document,
      navigator: happyWindow.navigator,
      HTMLElement: happyWindow.HTMLElement,
      Node: happyWindow.Node,
      Event: happyWindow.Event,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      writable: true,
      value: true,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    await happyWindow.happyDOM.close();
  });

  it("renders the minimal active prompt tail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(SessionProgressIndicator));
    });

    expect(container.textContent).toBe("Working…");
  });

  it("shows finalization progress and the queued follow-up count", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        createElement(
          SessionProgressProvider,
          { value: { phase: "finalizing", finalizingStep: "publishing", queueLength: 2 } },
          createElement(SessionProgressIndicator),
        ),
      );
    });

    expect(container.textContent).toContain("Publishing changes…");
    expect(container.textContent).toContain("2 queued");
  });
});
