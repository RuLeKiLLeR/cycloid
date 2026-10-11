import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCopyToClipboard } from "./useCopyToClipboard";

let container: HTMLDivElement;
let root: Root;
let api: { copied: boolean; copy: (text: string) => void } | null = null;

function Harness() {
  const [copied, copy] = useCopyToClipboard();
  api = { copied, copy };
  return null;
}

function mount() {
  act(() => {
    root.render(<Harness />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const flush = () => act(async () => await Promise.resolve());

describe("useCopyToClipboard", () => {
  it("reports copied after a successful write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    act(() => api!.copy("hello"));
    await flush();
    expect(api!.copied).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("stays not-copied when the write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    act(() => api!.copy("hello"));
    await flush();
    expect(api!.copied).toBe(false);
  });

  it("stays not-copied when the clipboard API is unavailable", async () => {
    // Insecure context / unsupported browser: navigator.clipboard is undefined.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    mount();
    act(() => api!.copy("hello"));
    await flush();
    expect(api!.copied).toBe(false);
  });
});
