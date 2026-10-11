import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionArtifactRow } from "../../apps/ui/src/api/artifacts";
import { useSessionScreenshots } from "../../apps/ui/src/hooks/useSessionScreenshots";

const artifactMocks = vi.hoisted(() => ({
  fetchSessionArtifacts: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/ui/src/api/artifacts")>();
  return {
    ...actual,
    fetchSessionArtifacts: artifactMocks.fetchSessionArtifacts,
  };
});

let happyWindow: Window;
let root: Root;
let container: HTMLElement;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    DOMException: windowInstance.DOMException,
    Event: windowInstance.Event,
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

function setDocumentVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function screenshotArtifact(sessionId: string, promptId: string, artifactId: string): SessionArtifactRow {
  return {
    artifactId,
    sessionId,
    promptId,
    type: "screenshot",
    url: null,
    metadata: { filename: `${artifactId}.png` },
    createdAt: 1,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function Harness({ onRender, sessionId }: { onRender: (labels: string[]) => void; sessionId: string }) {
  const screenshotsByPrompt = useSessionScreenshots(sessionId, "running");
  const labels = [...screenshotsByPrompt.values()].flatMap((shots) => shots.map((shot) => shot.label));
  onRender(labels);
  return null;
}

async function render(sessionId: string, onRender: (labels: string[]) => void) {
  await act(async () => {
    root.render(createElement(Harness, { sessionId, onRender }));
    await flushAsyncWork();
  });
}

describe("useSessionScreenshots", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/sessions/s-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    happyWindow?.close();
    vi.useRealTimers();
  });

  it("restores cached screenshots immediately when returning to a session", async () => {
    const renders: string[][] = [];
    let resolveS1Refresh: (rows: SessionArtifactRow[]) => void = () => undefined;

    artifactMocks.fetchSessionArtifacts.mockImplementation((sessionId: string) => {
      if (sessionId === "s-cache-1" && artifactMocks.fetchSessionArtifacts.mock.calls.length > 2) {
        return new Promise<SessionArtifactRow[]>((resolve) => {
          resolveS1Refresh = resolve;
        });
      }
      if (sessionId === "s-cache-1") return Promise.resolve([screenshotArtifact("s-cache-1", "p-1", "first")]);
      return Promise.resolve([screenshotArtifact("s-cache-2", "p-2", "second")]);
    });

    await render("s-cache-1", (labels) => renders.push(labels));
    expect(renders.at(-1)).toEqual(["first.png"]);

    await render("s-cache-2", (labels) => renders.push(labels));
    expect(renders.at(-1)).toEqual(["second.png"]);

    await render("s-cache-1", (labels) => renders.push(labels));
    expect(renders.at(-1)).toEqual(["first.png"]);

    await act(async () => {
      resolveS1Refresh([screenshotArtifact("s-cache-1", "p-1", "first-updated")]);
      await flushAsyncWork();
    });
    expect(renders.at(-1)).toEqual(["first-updated.png"]);
  });

  it("stops polling while hidden and reloads immediately when visible again", async () => {
    setDocumentVisibility("visible");
    artifactMocks.fetchSessionArtifacts.mockResolvedValue([screenshotArtifact("s-poll-1", "p-1", "shot-1")]);

    await render("s-poll-1", () => undefined);
    expect(artifactMocks.fetchSessionArtifacts).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();

    await act(async () => {
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(artifactMocks.fetchSessionArtifacts).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(artifactMocks.fetchSessionArtifacts).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(artifactMocks.fetchSessionArtifacts).toHaveBeenCalledTimes(3);
  });
});
