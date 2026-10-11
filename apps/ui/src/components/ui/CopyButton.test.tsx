import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./CopyButton";

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function flushClipboard() {
  // Let the writeText promise chain settle inside act.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CopyButton (icon-only)", () => {
  it("copies the value and swaps to the check confirmation", async () => {
    act(() => root.render(<CopyButton value="feat/branch" label="Copy branch feat/branch" />));
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy branch feat/branch");
    expect(button?.getAttribute("title")).toBe("Copy branch feat/branch");

    act(() => button?.click());
    await flushClipboard();

    expect(writeText).toHaveBeenCalledWith("feat/branch");
    expect(button?.getAttribute("title")).toBe("Copied");

    // Confirmation resets after the hook's timing window.
    act(() => vi.runAllTimers());
    expect(button?.getAttribute("title")).toBe("Copy branch feat/branch");
  });

  it("renders through IconButton semantics (ghost square, extended hit area)", () => {
    act(() => root.render(<CopyButton value="x" label="Copy value" />));
    const button = container.querySelector("button");
    expect(button?.className).toContain("control-sm");
    expect(button?.className).toContain("hit-area-40");
  });
});

describe("CopyButton (text variant)", () => {
  it("renders children with the trailing swap icon and copies on click", async () => {
    act(() =>
      root.render(
        <CopyButton value="sess-123" label="Copy session ID">
          <span>sess-123</span>
        </CopyButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("sess-123");
    expect(button?.querySelectorAll("svg")).toHaveLength(1);

    act(() => button?.click());
    await flushClipboard();
    expect(writeText).toHaveBeenCalledWith("sess-123");
  });

  it("supports the text swap (copiedChildren) with the icon disabled", async () => {
    act(() =>
      root.render(
        <CopyButton value="token" label="Copy token" showIcon={false} copiedChildren="Copied">
          Copy
        </CopyButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Copy");
    expect(button?.querySelector("svg")).toBeNull();

    act(() => button?.click());
    await flushClipboard();
    expect(button?.textContent).toBe("Copied");

    act(() => vi.runAllTimers());
    expect(button?.textContent).toBe("Copy");
  });

  it("never bubbles the click into a navigating ancestor", async () => {
    const rowClick = vi.fn();
    // Native listener above the React root — a copy click inside a navigating
    // row must not propagate past the CopyButton.
    document.body.addEventListener("click", rowClick);
    act(() =>
      root.render(
        <CopyButton value="main" label="Copy branch main">
          main
        </CopyButton>,
      ),
    );
    const button = container.querySelector("button");
    act(() => button?.click());
    await flushClipboard();
    expect(writeText).toHaveBeenCalledWith("main");
    expect(rowClick).not.toHaveBeenCalled();
    document.body.removeEventListener("click", rowClick);
  });
});
