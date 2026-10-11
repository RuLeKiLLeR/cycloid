import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIFF_VIEW_STORAGE_KEY, type DiffViewMode, parseDiffViewMode } from "../constants/diff-view";
import { readDiffViewPreference, useDiffViewPreference } from "./useDiffViewPreference";

let container: HTMLDivElement;
let root: Root;
let api: { mode: DiffViewMode; set: (mode: DiffViewMode) => void } | null = null;

function Harness() {
  const [mode, set] = useDiffViewPreference();
  api = { mode, set };
  return null;
}

function mount() {
  act(() => {
    root.render(<Harness />);
  });
}

beforeEach(() => {
  localStorage.clear();
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

describe("parseDiffViewMode", () => {
  it("accepts split and falls back to unified for everything else", () => {
    expect(parseDiffViewMode("split")).toBe("split");
    expect(parseDiffViewMode("unified")).toBe("unified");
    expect(parseDiffViewMode(null)).toBe("unified");
    expect(parseDiffViewMode("garbage")).toBe("unified");
    expect(parseDiffViewMode(42)).toBe("unified");
  });
});

describe("readDiffViewPreference", () => {
  it("defaults to unified when nothing is stored", () => {
    expect(readDiffViewPreference()).toBe("unified");
  });

  it("reads a persisted split preference", () => {
    localStorage.setItem(DIFF_VIEW_STORAGE_KEY, "split");
    expect(readDiffViewPreference()).toBe("split");
  });

  it("falls back to unified on a corrupt stored value", () => {
    localStorage.setItem(DIFF_VIEW_STORAGE_KEY, "sideways");
    expect(readDiffViewPreference()).toBe("unified");
  });

  it("falls back to unified when storage access throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDiffViewPreference()).toBe("unified");
    spy.mockRestore();
  });
});

describe("useDiffViewPreference", () => {
  it("initializes from storage", () => {
    localStorage.setItem(DIFF_VIEW_STORAGE_KEY, "split");
    mount();
    expect(api!.mode).toBe("split");
  });

  it("persists changes and updates state", () => {
    mount();
    expect(api!.mode).toBe("unified");
    act(() => api!.set("split"));
    expect(api!.mode).toBe("split");
    expect(localStorage.getItem(DIFF_VIEW_STORAGE_KEY)).toBe("split");
  });

  it("keeps in-memory state when persisting throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    mount();
    act(() => api!.set("split"));
    expect(api!.mode).toBe("split");
    spy.mockRestore();
  });
});
