import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionDesktopActionPath } from "../../apps/ui/src/hooks/useSessionDesktopActionPath";
import type { DesktopActionPathRow } from "../../shared/types/desktop-action-path";

const apiMocks = vi.hoisted(() => ({
  fetchSessionDesktopActionPath: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/sessions.ts", () => ({
  fetchSessionDesktopActionPath: apiMocks.fetchSessionDesktopActionPath,
}));

let happyWindow: Window;
let root: Root;
let container: HTMLElement;
let rootMounted = false;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    DOMException: windowInstance.DOMException,
    AbortController: windowInstance.AbortController,
    AbortSignal: windowInstance.AbortSignal,
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
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

function desktopRow(overrides: Partial<DesktopActionPathRow> = {}): DesktopActionPathRow {
  const seq = overrides.desktopActionSeq ?? 1;
  return {
    actionId: `action-${seq}`,
    desktopActionSeq: seq,
    sessionId: "s-1",
    promptId: null,
    phase: "agent",
    action: "click",
    label: `Click ${seq}`,
    status: "completed",
    activeWindowTitle: "Browser",
    warningCode: null,
    errorCode: null,
    screenshot: null,
    createdAtMs: 1000 + seq,
    updatedAtMs: 1000 + seq,
    ...overrides,
  };
}

function screenshot(
  actionId: string,
  overrides: Partial<NonNullable<DesktopActionPathRow["screenshot"]>> = {},
): NonNullable<DesktopActionPathRow["screenshot"]> {
  return {
    actionId,
    artifactId: `artifact-${actionId}`,
    kind: "desktop_action_screenshot",
    artifactAccessVisibility: "private",
    label: `Screenshot ${actionId}`,
    viewUrl: `/api/sessions/s-1/artifacts/artifact-${actionId}`,
    width: 1280,
    height: 720,
    bytes: 1024,
    capturedAtMs: 2000,
    status: "available",
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderHookHarness(
  onRender: (value: ReturnType<typeof useSessionDesktopActionPath>) => void,
  options: { sessionId?: string; enabled?: boolean } = {},
) {
  function Harness({ sessionId, enabled }: { sessionId: string; enabled?: boolean }) {
    const value = useSessionDesktopActionPath(sessionId, { enabled });
    onRender(value);
    return null;
  }

  const render = (nextOptions: { sessionId?: string; enabled?: boolean } = options) => {
    act(() => {
      root.render(
        createElement(Harness, {
          sessionId: nextOptions.sessionId ?? "s-1",
          enabled: nextOptions.enabled,
        }),
      );
    });
  };

  render(options);
  return { rerender: render };
}

function unmountRoot() {
  if (!rootMounted) return;
  act(() => root.unmount());
  rootMounted = false;
}

describe("useSessionDesktopActionPath", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/sessions/s-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    unmountRoot();
    container.remove();
    happyWindow.close();
  });

  it("loads the REST snapshot and orders rows by desktop action sequence", async () => {
    apiMocks.fetchSessionDesktopActionPath.mockResolvedValueOnce({
      ok: true,
      rows: [desktopRow({ desktopActionSeq: 2 }), desktopRow({ desktopActionSeq: 1 })],
      maxDesktopActionSeq: 2,
    });
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(true);
    await act(async () => {
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
    expect(latest?.loading).toBe(false);
    expect(latest?.rows.map((row) => row.desktopActionSeq)).toEqual([1, 2]);
    expect(latest?.maxDesktopActionSeq).toBe(2);
  });

  it("does not fetch or ingest live rows while disabled", async () => {
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness(
      (value) => {
        latest = value;
      },
      { enabled: false },
    );

    expect(latest?.loading).toBe(false);
    expect(latest?.rows).toEqual([]);

    await act(async () => {
      latest?.refreshSnapshot();
      latest?.ingestLiveRow(desktopRow({ desktopActionSeq: 1 }));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopActionPath).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(false);
    expect(latest?.rows).toEqual([]);
  });

  it("aborts an in-flight request and resets state when disabled", async () => {
    const signals: AbortSignal[] = [];
    apiMocks.fetchSessionDesktopActionPath.mockImplementationOnce((_sessionId: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    const harness = renderHookHarness((value) => {
      latest = value;
    });

    expect(signals).toHaveLength(1);
    expect(latest?.loading).toBe(true);

    harness.rerender({ enabled: false });

    expect(signals[0]?.aborted).toBe(true);
    expect(latest?.loading).toBe(false);
    expect(latest?.refreshing).toBe(false);
    expect(latest?.rows).toEqual([]);
  });

  it("merges live rows and refreshes the snapshot when a sequence gap appears", async () => {
    apiMocks.fetchSessionDesktopActionPath
      .mockResolvedValueOnce({
        ok: true,
        rows: [desktopRow({ desktopActionSeq: 1 })],
        maxDesktopActionSeq: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        rows: [
          desktopRow({ desktopActionSeq: 1 }),
          desktopRow({ desktopActionSeq: 2 }),
          desktopRow({ desktopActionSeq: 3 }),
        ],
        maxDesktopActionSeq: 3,
      });
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness((value) => {
      latest = value;
    });
    await act(async () => {
      await flushAsyncWork();
    });

    await act(async () => {
      latest?.ingestLiveRow(desktopRow({ desktopActionSeq: 3 }));
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledTimes(2);
    expect(latest?.rows.map((row) => row.desktopActionSeq)).toEqual([1, 2, 3]);
    expect(latest?.maxDesktopActionSeq).toBe(3);
  });

  it("passes abort signals for gap and manual refreshes and aborts superseded refreshes", async () => {
    const gapRefresh = deferred<{ ok: true; rows: DesktopActionPathRow[]; maxDesktopActionSeq: number }>();
    const manualRefresh = deferred<{ ok: true; rows: DesktopActionPathRow[]; maxDesktopActionSeq: number }>();
    const refreshSignals: AbortSignal[] = [];
    apiMocks.fetchSessionDesktopActionPath
      .mockResolvedValueOnce({
        ok: true,
        rows: [desktopRow({ desktopActionSeq: 1 })],
        maxDesktopActionSeq: 1,
      })
      .mockImplementationOnce((_sessionId: string, signal: AbortSignal) => {
        refreshSignals.push(signal);
        return gapRefresh.promise;
      })
      .mockImplementationOnce((_sessionId: string, signal: AbortSignal) => {
        refreshSignals.push(signal);
        return manualRefresh.promise;
      });
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness((value) => {
      latest = value;
    });
    await act(async () => {
      await flushAsyncWork();
    });

    await act(async () => {
      latest?.ingestLiveRow(desktopRow({ desktopActionSeq: 3 }));
      await flushAsyncWork();
    });

    expect(refreshSignals).toHaveLength(1);
    expect(refreshSignals[0]).toBeInstanceOf(AbortSignal);
    expect(refreshSignals[0]?.aborted).toBe(false);

    await act(async () => {
      latest?.refreshSnapshot();
      await flushAsyncWork();
    });

    expect(refreshSignals).toHaveLength(2);
    expect(refreshSignals[0]?.aborted).toBe(true);
    expect(refreshSignals[1]).toBeInstanceOf(AbortSignal);
    expect(refreshSignals[1]?.aborted).toBe(false);

    unmountRoot();

    expect(refreshSignals[1]?.aborted).toBe(true);
  });

  it("treats snapshot rows as authoritative and removes rows absent from the latest snapshot", async () => {
    apiMocks.fetchSessionDesktopActionPath
      .mockResolvedValueOnce({
        ok: true,
        rows: [desktopRow({ desktopActionSeq: 1 }), desktopRow({ desktopActionSeq: 2 })],
        maxDesktopActionSeq: 2,
      })
      .mockResolvedValueOnce({
        ok: true,
        rows: [desktopRow({ desktopActionSeq: 2 })],
        maxDesktopActionSeq: 2,
      });
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness((value) => {
      latest = value;
    });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(latest?.rows.map((row) => row.desktopActionSeq)).toEqual([1, 2]);

    await act(async () => {
      latest?.refreshSnapshot();
      await flushAsyncWork();
    });

    expect(latest?.rows.map((row) => row.desktopActionSeq)).toEqual([2]);
  });

  it("refreshes the snapshot for live screenshot rows that may prune older screenshots", async () => {
    const pruningRefresh = deferred<{ ok: true; rows: DesktopActionPathRow[]; maxDesktopActionSeq: number }>();
    const followUpRefresh = deferred<{ ok: true; rows: DesktopActionPathRow[]; maxDesktopActionSeq: number }>();
    apiMocks.fetchSessionDesktopActionPath
      .mockResolvedValueOnce({
        ok: true,
        rows: [desktopRow({ actionId: "action-1", desktopActionSeq: 1, screenshot: screenshot("action-1") })],
        maxDesktopActionSeq: 1,
      })
      .mockImplementationOnce(() => pruningRefresh.promise)
      .mockImplementationOnce(() => followUpRefresh.promise);
    let latest: ReturnType<typeof useSessionDesktopActionPath> | null = null;

    renderHookHarness((value) => {
      latest = value;
    });
    await act(async () => {
      await flushAsyncWork();
    });

    await act(async () => {
      latest?.ingestLiveRow(
        desktopRow({ actionId: "action-2", desktopActionSeq: 2, screenshot: screenshot("action-2") }),
      );
      latest?.ingestLiveRow(
        desktopRow({ actionId: "action-3", desktopActionSeq: 3, screenshot: screenshot("action-3") }),
      );
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledTimes(2);

    await act(async () => {
      pruningRefresh.resolve({
        ok: true,
        rows: [
          desktopRow({
            actionId: "action-1",
            desktopActionSeq: 1,
            status: "pruned",
            screenshot: screenshot("action-1", { status: "pruned" }),
          }),
          desktopRow({ actionId: "action-2", desktopActionSeq: 2, screenshot: screenshot("action-2") }),
          desktopRow({ actionId: "action-3", desktopActionSeq: 3, screenshot: screenshot("action-3") }),
        ],
        maxDesktopActionSeq: 3,
      });
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopActionPath).toHaveBeenCalledTimes(3);

    await act(async () => {
      followUpRefresh.resolve({
        ok: true,
        rows: [
          desktopRow({
            actionId: "action-1",
            desktopActionSeq: 1,
            status: "pruned",
            screenshot: screenshot("action-1", { status: "pruned" }),
          }),
          desktopRow({ actionId: "action-2", desktopActionSeq: 2, screenshot: screenshot("action-2") }),
          desktopRow({ actionId: "action-3", desktopActionSeq: 3, screenshot: screenshot("action-3") }),
        ],
        maxDesktopActionSeq: 3,
      });
      await flushAsyncWork();
    });

    expect(latest?.rows.map((row) => [row.actionId, row.screenshot?.status])).toEqual([
      ["action-1", "pruned"],
      ["action-2", "available"],
      ["action-3", "available"],
    ]);
  });
});
