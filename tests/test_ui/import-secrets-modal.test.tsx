import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportSecretsModal } from "../../apps/ui/src/components/settings/ImportSecretsModal";

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

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    HTMLTextAreaElement: windowInstance.HTMLTextAreaElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    Event: windowInstance.Event,
    InputEvent: windowInstance.InputEvent,
    Node: windowInstance.Node,
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

type DragHandlers = {
  onDragEnter?: (event: { preventDefault: () => void; currentTarget: Element; relatedTarget: Node | null }) => void;
  onDragLeave?: (event: { preventDefault: () => void; currentTarget: Element; relatedTarget: Node | null }) => void;
};

function getReactProps<T>(element: Element): T | null {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? ((element as unknown as Record<string, T>)[key] ?? null) : null;
}

function fireDrag(button: Element, kind: "enter" | "leave", relatedTarget: Node | null) {
  const props = getReactProps<DragHandlers>(button);
  const handler = kind === "enter" ? props?.onDragEnter : props?.onDragLeave;
  handler?.({ preventDefault: () => undefined, currentTarget: button, relatedTarget });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));

  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (textarea as unknown as Record<string, { onChange?: (event: { target: HTMLTextAreaElement }) => void }>)[
        reactPropsKey
      ]
    : null;
  reactProps?.onChange?.({ target: textarea });
}

describe("ImportSecretsModal", () => {
  let happyWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    await happyWindow.happyDOM.close();
  });

  it("blocks Store when the paste text is invalid", async () => {
    const onStore = vi.fn();
    await act(async () => {
      root.render(
        createElement(ImportSecretsModal, {
          open: true,
          onClose: () => undefined,
          allowedScopes: ["repository"],
          portal: false,
          onStore,
        }),
      );
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    await act(async () => {
      setTextareaValue(textarea!, "not-valid");
    });

    const storeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Store"),
    ) as HTMLButtonElement;
    await act(async () => {
      storeButton.click();
    });

    expect(container.textContent).toMatch(/must be KEY=VALUE/i);
    expect(onStore).not.toHaveBeenCalled();
  });

  it("keeps the drop zone highlighted when dragging over a child, clears it on true leave", async () => {
    await act(async () => {
      root.render(
        createElement(ImportSecretsModal, {
          open: true,
          onClose: () => undefined,
          allowedScopes: ["repository"],
          portal: false,
          onStore: vi.fn(),
        }),
      );
    });

    const dropZone = Array.from(container.querySelectorAll("button")).find((button) =>
      button.className.includes("border-dashed"),
    ) as HTMLButtonElement;
    expect(dropZone).toBeTruthy();
    const child = dropZone.querySelector("p");
    expect(child).toBeTruthy();

    // Drag enters the zone -> highlighted.
    await act(async () => {
      fireDrag(dropZone, "enter", null);
    });
    expect(dropZone.className).toContain("border-accent");

    // Cursor crosses into a child element (browsers fire dragleave on the parent).
    // The guard must keep the highlight because the drag has not left the zone.
    await act(async () => {
      fireDrag(dropZone, "leave", child);
    });
    expect(dropZone.className).toContain("border-accent");

    // Cursor truly leaves the zone (relatedTarget outside / null) -> highlight clears.
    await act(async () => {
      fireDrag(dropZone, "leave", null);
    });
    expect(dropZone.className).not.toContain("border-accent");
    expect(dropZone.className).toContain("border-border");
  });

  it("calls onStore with parsed paste text and sensitive flag", async () => {
    const onStore = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        createElement(ImportSecretsModal, {
          open: true,
          onClose: () => undefined,
          allowedScopes: ["personal", "repository"],
          defaultScope: "personal",
          portal: false,
          onStore,
        }),
      );
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    await act(async () => {
      setTextareaValue(textarea!, "API_KEY=sk-test # note");
    });

    const storeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Store"),
    ) as HTMLButtonElement;
    await act(async () => {
      storeButton.click();
      await Promise.resolve();
    });

    expect(onStore).toHaveBeenCalledWith({
      scope: "personal",
      text: "API_KEY=sk-test # note",
      sensitive: true,
    });
  });
});
