import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_INSPECTOR_DEFAULT_WIDTH,
  SESSION_INSPECTOR_EXPANDED_KEY,
  SESSION_INSPECTOR_EXPANDED_WIDTH,
} from "../../constants/session-workbench";
import { createEmptyTokenUsage } from "../../hooks/session-state/transcript-helpers";
import type { SessionDetail } from "../../types";
import { ToastProvider } from "../Toast";
import { SessionInspector } from "./SessionInspector";

let container: HTMLDivElement;
let root: Root;

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

beforeEach(() => {
  installLocalStorage();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function makeSession(): SessionDetail {
  return {
    sessionId: "s-inspector-1",
    phase: "running",
    prUrl: null,
    createdAt: Date.now(),
    model: { providerID: "anthropic", modelID: "claude-fable-5" },
    title: "Test session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
  } as SessionDetail;
}

function render() {
  act(() => {
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <SessionInspector
            session={makeSession()}
            hydrated={true}
            prompts={[]}
            transcripts={new Map()}
            screenshotsByPrompt={new Map()}
            contextUsage={null}
            tokenUsage={createEmptyTokenUsage()}
            runtimeActionInFlight={null}
            onRuntimeAction={() => {}}
            prError={null}
            qaTestSessionUrl={null}
            canTriggerQaVerification={false}
            qaVerificationLoading={false}
            qaVerificationError={null}
            onTriggerQaVerification={() => {}}
            onViewPr={() => {}}
            readOnly={false}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
}

function widenButton(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Widen panel"]');
}

function restoreButton(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Restore panel width"]');
}

function inspectorAside(): HTMLElement {
  const aside = container.querySelector('aside[aria-label="Session artifacts"]');
  if (!aside) throw new Error("inspector aside not rendered");
  return aside as HTMLElement;
}

describe("SessionInspector expand toggle", () => {
  it("expands to the wide layout and persists the flag", () => {
    render();
    expect(inspectorAside().style.width).toBe(`${SESSION_INSPECTOR_DEFAULT_WIDTH}px`);

    act(() => widenButton()!.click());
    expect(localStorage.getItem(SESSION_INSPECTOR_EXPANDED_KEY)).toBe("1");
    expect(inspectorAside().style.width).toContain(`${SESSION_INSPECTOR_EXPANDED_WIDTH}px`);
    // Wide layout replaces the drag affordance while active.
    expect(restoreButton()).not.toBeNull();
    expect(widenButton()).toBeNull();
  });

  it("restores the previous width and persists the flag off", () => {
    render();
    act(() => widenButton()!.click());
    act(() => restoreButton()!.click());
    expect(localStorage.getItem(SESSION_INSPECTOR_EXPANDED_KEY)).toBe("0");
    expect(inspectorAside().style.width).toBe(`${SESSION_INSPECTOR_DEFAULT_WIDTH}px`);
  });

  it("boots into the wide layout when the flag is persisted", () => {
    localStorage.setItem(SESSION_INSPECTOR_EXPANDED_KEY, "1");
    render();
    expect(inspectorAside().style.width).toContain(`${SESSION_INSPECTOR_EXPANDED_WIDTH}px`);
  });

  it("keeps the collapse toggle working alongside expand", () => {
    render();
    const collapse = container.querySelector('button[aria-label="Collapse panel"]') as HTMLButtonElement;
    act(() => collapse.click());
    expect(container.querySelector('aside[aria-label="Session artifacts, collapsed"]')).not.toBeNull();
  });

  it("supports keyboard resizing through the separator", () => {
    render();
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator.getAttribute("aria-valuenow")).toBe(String(SESSION_INSPECTOR_DEFAULT_WIDTH));
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(inspectorAside().style.width).toBe(`${SESSION_INSPECTOR_DEFAULT_WIDTH + 16}px`);
    expect(separator.getAttribute("aria-valuenow")).toBe(String(SESSION_INSPECTOR_DEFAULT_WIDTH + 16));
  });
});
