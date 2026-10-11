import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedDelta } from "../../../../shared/types/session-feed";
import { useSessionFeed } from "./useSessionFeed";

type UseSessionFeedOptions = Parameters<typeof useSessionFeed>[0];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: null | (() => void) = null;
  onmessage: null | ((event: { data: string }) => void) = null;
  onclose: null | (() => void) = null;
  onerror: null | (() => void) = null;
  close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: () => void, options?: { once?: boolean }) {
    if (event !== "open") return;
    const current = this.onopen;
    this.onopen = () => {
      current?.();
      callback();
      if (options?.once) this.onopen = current;
    };
  }

  dispatchOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  dispatchClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  dispatchMessage(data: object | string) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

let container: HTMLDivElement;
let root: Root;
let randomSpy: ReturnType<typeof vi.spyOn>;

function Harness(props: UseSessionFeedOptions) {
  useSessionFeed(props);
  return null;
}

function render(props: UseSessionFeedOptions) {
  act(() => {
    root.render(createElement(Harness, props));
  });
}

function latest(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

const baseOptions = (over: Partial<UseSessionFeedOptions> = {}): UseSessionFeedOptions => ({
  enabled: true,
  onDelta: () => {},
  onReconnect: () => {},
  ...over,
});

describe("useSessionFeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const happyWindow = new Window({ url: "https://app.trycycloid.com/" });
    Object.assign(globalThis, {
      WebSocket: FakeWebSocket,
      document: happyWindow.document,
      window: happyWindow,
    });

    container = happyWindow.document.createElement("div") as unknown as HTMLDivElement;
    happyWindow.document.body.appendChild(container as never);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("connects to the same-origin feed endpoint and fires onReconnect on open", () => {
    const onReconnect = vi.fn();
    render(baseOptions({ onReconnect }));

    const ws = latest();
    expect(ws.url).toBe("wss://app.trycycloid.com/api/users/me/feed/ws");
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => ws.dispatchOpen());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("does not connect when disabled", () => {
    render(baseOptions({ enabled: false }));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("delivers parsed deltas to onDelta", () => {
    const onDelta = vi.fn();
    render(baseOptions({ onDelta }));
    const ws = latest();
    act(() => ws.dispatchOpen());

    const status: FeedDelta = {
      type: "session_status",
      sessionId: "s-1",
      ownerUserId: "o-1",
      repoOwner: "acme",
      repoName: "widgets",
      source: "status",
      phase: "running",
    };
    act(() => ws.dispatchMessage(status));
    expect(onDelta).toHaveBeenCalledWith(status);

    const pr: FeedDelta = {
      type: "pr",
      sessionId: "s-1",
      ownerUserId: "o-1",
      repoOwner: "acme",
      repoName: "widgets",
      source: "pr",
      prUrl: "https://pr/1",
    };
    act(() => ws.dispatchMessage(pr));
    expect(onDelta).toHaveBeenLastCalledWith(pr);
  });

  it("ignores malformed and unknown frames", () => {
    const onDelta = vi.fn();
    render(baseOptions({ onDelta }));
    const ws = latest();
    act(() => ws.dispatchOpen());

    act(() => ws.dispatchMessage("not json"));
    act(() => ws.dispatchMessage({ type: "totally_unknown", sessionId: "s-1" }));
    act(() => ws.dispatchMessage({ type: "session_status" })); // missing sessionId
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("reconnects with backoff after a close", () => {
    render(baseOptions());
    const first = latest();
    act(() => first.dispatchOpen());
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => first.dispatchClose());
    // First reconnect delay is the initial 500ms (jitter pinned to 1.0× via random=0.5).
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latest()).not.toBe(first);
  });
});
