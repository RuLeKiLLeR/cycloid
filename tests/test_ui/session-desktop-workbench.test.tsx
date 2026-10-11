import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../apps/ui/src/api/client";
import {
  type DesktopWorkbenchRecording,
  SessionDesktopWorkbench,
} from "../../apps/ui/src/components/SessionDesktopWorkbench";
import {
  DESKTOP_VIEWER_RECONNECT_DELAY_MS,
  DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS,
  DESKTOP_VIEWER_UPSTREAM_UNAVAILABLE_RETRY_MS,
} from "../../apps/ui/src/hooks/useSessionDesktopViewer";
import type { DesktopActionPathRow, DesktopActionScreenshotRef } from "../../shared/types/desktop-action-path";
import type { CreateDesktopViewTicketResponse } from "../../shared/types/desktop-viewer";

const apiMocks = vi.hoisted(() => ({
  createSessionDesktopViewTicket: vi.fn(),
  fetchSessionDesktopViewTicketStatus: vi.fn(),
  heartbeatSessionDesktopViewTicket: vi.fn(),
  revokeSessionDesktopViewTicket: vi.fn(),
}));

const rfbMocks = vi.hoisted(() => {
  type FakeRfbListener = (event: { detail: Record<string, unknown> }) => void;
  const loadRfbModule = vi.fn(async () => undefined);

  class FakeRFB {
    static instances: FakeRFB[] = [];

    target: HTMLElement;
    urlOrChannel: string | WebSocket | RTCDataChannel;
    options: unknown;
    listeners = new Map<string, FakeRfbListener[]>();
    viewOnly = false;
    focusOnClick = true;
    clipViewport = false;
    scaleViewport = false;
    resizeSession = true;
    disconnect = vi.fn(() => {
      this.dispatchDisconnect(true);
    });

    constructor(target: HTMLElement, urlOrChannel: string | WebSocket | RTCDataChannel, options: unknown) {
      this.target = target;
      this.urlOrChannel = urlOrChannel;
      this.options = options;
      const canvas = target.ownerDocument.createElement("canvas");
      canvas.setAttribute("data-fake-rfb-screen", "true");
      target.appendChild(canvas);
      FakeRFB.instances.push(this);
    }

    addEventListener(type: string, listener: FakeRfbListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, detail: Record<string, unknown>) {
      for (const listener of this.listeners.get(type) ?? []) listener({ detail });
    }

    dispatchConnect() {
      this.emit("connect", {});
    }

    dispatchDisconnect(clean = false) {
      this.emit("disconnect", { clean });
    }
  }

  return { FakeRFB, loadRfbModule };
});

vi.mock("../../apps/ui/src/api/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/ui/src/api/sessions")>();
  return {
    ...actual,
    createSessionDesktopViewTicket: apiMocks.createSessionDesktopViewTicket,
    fetchSessionDesktopViewTicketStatus: apiMocks.fetchSessionDesktopViewTicketStatus,
    heartbeatSessionDesktopViewTicket: apiMocks.heartbeatSessionDesktopViewTicket,
    revokeSessionDesktopViewTicket: apiMocks.revokeSessionDesktopViewTicket,
  };
});

vi.mock("@novnc/novnc/lib/rfb.js", async () => {
  await rfbMocks.loadRfbModule();
  return { default: rfbMocks.FakeRFB };
});

let happyWindow: Window;
let root: Root;
let container: HTMLElement;
let rootMounted = false;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    CustomEvent: windowInstance.CustomEvent,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
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

function desktopTicket(
  overrides: Partial<CreateDesktopViewTicketResponse["ticket"]> = {},
): CreateDesktopViewTicketResponse {
  const ticketId = overrides.ticketId ?? "a".repeat(64);
  return {
    ok: true,
    ticket: {
      ticketId,
      expiresAtMs: 2_000,
      hardExpiresAtMs: 10_000,
      heartbeatIntervalMs: 20_000,
      viewOnly: true,
      websocketPath: `/api/sessions/s-1/desktop/view-ticket/${ticketId}/ws`,
      heartbeatPath: `/api/sessions/s-1/desktop/view-ticket/${ticketId}/heartbeat`,
      revokePath: `/api/sessions/s-1/desktop/view-ticket/${ticketId}`,
      statusPath: `/api/sessions/s-1/desktop/view-ticket/${ticketId}/status`,
      ...overrides,
    },
  };
}

function screenshot(overrides: Partial<DesktopActionScreenshotRef> = {}): DesktopActionScreenshotRef {
  return {
    actionId: "action-1",
    artifactId: "artifact-1",
    kind: "desktop_action_screenshot",
    artifactAccessVisibility: "private",
    label: "After click",
    viewUrl: "/api/sessions/s-1/artifacts/artifact-1/view?filename=after.png",
    width: 1280,
    height: 720,
    bytes: 120000,
    captureMode: "full_display",
    displayName: ":99",
    capturedAtMs: 1000,
    status: "available",
    ...overrides,
  };
}

function row(overrides: Partial<DesktopActionPathRow> = {}): DesktopActionPathRow {
  const seq = overrides.desktopActionSeq ?? 1;
  return {
    actionId: `action-${seq}`,
    desktopActionSeq: seq,
    sessionId: "s-1",
    promptId: null,
    phase: "agent",
    action: "click",
    label: `Click button ${seq}`,
    status: "completed",
    activeWindowTitle: "Settings",
    warningCode: null,
    errorCode: null,
    screenshot: null,
    createdAtMs: 1000 + seq,
    updatedAtMs: 1000 + seq,
    ...overrides,
  };
}

function recording(overrides: Partial<DesktopWorkbenchRecording> = {}): DesktopWorkbenchRecording {
  return {
    recordingId: "rec-1",
    label: "Settings happy path",
    status: "completed",
    startedAtMs: 1000,
    stoppedAtMs: 4500,
    durationMs: 3500,
    bytes: 1_200_000,
    maxDurationMs: 60_000,
    maxBytes: 50 * 1024 * 1024,
    overlayStatus: "applied",
    failureReason: null,
    ...overrides,
  };
}

async function flushAsyncWork() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function renderWorkbench(props: Partial<Parameters<typeof SessionDesktopWorkbench>[0]> = {}) {
  await act(async () => {
    root.render(
      createElement(SessionDesktopWorkbench, {
        sessionId: "s-1",
        rows: [],
        loading: false,
        refreshing: false,
        error: null,
        onRefresh: vi.fn(),
        ...props,
      }),
    );
    rootMounted = true;
    await flushAsyncWork();
  });
}

async function openLiveDesktopViewer() {
  const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes("Open desktop"),
  );
  expect(openButton).not.toBeNull();

  await act(async () => {
    openButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    await flushAsyncWork();
  });
}

describe("SessionDesktopWorkbench", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/sessions/s-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = false;
    rfbMocks.FakeRFB.instances = [];
    rfbMocks.loadRfbModule.mockReset();
    rfbMocks.loadRfbModule.mockResolvedValue(undefined);
    apiMocks.createSessionDesktopViewTicket.mockReset();
    apiMocks.fetchSessionDesktopViewTicketStatus.mockReset();
    apiMocks.heartbeatSessionDesktopViewTicket.mockReset();
    apiMocks.revokeSessionDesktopViewTicket.mockReset();
    apiMocks.createSessionDesktopViewTicket.mockResolvedValue(desktopTicket());
    apiMocks.fetchSessionDesktopViewTicketStatus.mockResolvedValue({
      ok: true,
      ticket: desktopTicket().ticket,
      connectionId: "00000000-0000-4000-8000-000000000001",
      connectedAtMs: 1000,
      closedAtMs: 1100,
      closeReason: "client_closed",
      revoked: false,
      expired: false,
    });
    apiMocks.heartbeatSessionDesktopViewTicket.mockResolvedValue({ ok: true, ticket: desktopTicket().ticket });
    apiMocks.revokeSessionDesktopViewTicket.mockResolvedValue({ ok: true, revoked: true });
  });

  afterEach(() => {
    if (rootMounted) {
      act(() => root.unmount());
      rootMounted = false;
    }
    vi.useRealTimers();
    vi.clearAllMocks();
    container.remove();
    happyWindow.close();
  });

  it("does not construct noVNC for a ticket cleared while the RFB module loads", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const moduleLoad = deferred<void>();
    rfbMocks.loadRfbModule.mockReturnValueOnce(moduleLoad.promise);
    apiMocks.createSessionDesktopViewTicket.mockResolvedValueOnce(
      desktopTicket({ ticketId: "a".repeat(64), heartbeatIntervalMs: 1_000 }),
    );
    apiMocks.heartbeatSessionDesktopViewTicket.mockRejectedValueOnce(new Error("ticket revoked"));

    await renderWorkbench();
    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);
    await openLiveDesktopViewer();
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await flushAsyncWork();
    });

    expect(apiMocks.revokeSessionDesktopViewTicket).toHaveBeenCalledWith(
      "/api/sessions/s-1/desktop/view-ticket/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    await act(async () => {
      moduleLoad.resolve();
      await moduleLoad.promise;
      await flushAsyncWork();
    });

    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);
  });

  it("renders loading, empty, and error states", async () => {
    await renderWorkbench({ loading: true });
    expect(container.querySelector('[aria-label="Loading desktop action path"]')).not.toBeNull();

    await renderWorkbench({ error: "Snapshot failed" });
    expect(container.textContent).toContain("Snapshot failed");
    expect(container.textContent).toContain("No desktop actions yet.");
  });

  it("renders an optional close control for pane placement", async () => {
    const onClose = vi.fn();
    await renderWorkbench({ onClose });

    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close desktop view"]');
    expect(closeButton).not.toBeNull();

    await act(async () => {
      closeButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders action rows and screenshot placeholders", async () => {
    await renderWorkbench({
      rows: [
        row({ desktopActionSeq: 1, screenshot: screenshot() }),
        row({
          desktopActionSeq: 2,
          status: "quota_exceeded",
          screenshot: screenshot({ actionId: "action-2", artifactId: "artifact-2", status: "quota_exceeded" }),
        }),
        row({
          desktopActionSeq: 3,
          status: "pruned",
          screenshot: screenshot({ actionId: "action-3", artifactId: "artifact-3", status: "pruned" }),
        }),
        row({ desktopActionSeq: 4, status: "screenshot_failed", warningCode: "screenshot_failed" }),
      ],
    });

    expect(container.textContent).toContain("Click button 1");
    expect(container.textContent).toContain("Quota exceeded");
    expect(container.textContent).toContain("Screenshot pruned");
    expect(container.textContent).toContain("Screenshot failed");
    expect(container.textContent).toContain("Code: screenshot_failed");
  });

  it("renders completed recording evidence status", async () => {
    await renderWorkbench({ recording: recording() });

    expect(container.textContent).toContain("Walkthrough recording");
    expect(container.textContent).toContain("Settings happy path");
    expect(container.textContent).toContain("Completed");
  });

  it("shows artifact-too-large recording state", async () => {
    await renderWorkbench({
      recording: recording({ bytes: 55 * 1024 * 1024, failureReason: "size_limit_exceeded" }),
    });

    expect(container.textContent).toContain("Artifact too large");
    expect(container.textContent).toContain("Code: size_limit_exceeded");
  });

  it("opens an available thumbnail in the shared image preview modal", async () => {
    await renderWorkbench({
      rows: [row({ screenshot: screenshot() })],
    });

    const button = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Open desktop action screenshot After click']",
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const dialog = document.body.querySelector('[role="dialog"][aria-label="After click"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("img")?.getAttribute("src")).toContain("/api/sessions/s-1/artifacts/artifact-1/view");
  });

  it("renders live desktop viewer lifecycle states through the ticketed same-origin WebSocket", async () => {
    vi.useFakeTimers();
    await renderWorkbench();
    expect(apiMocks.createSessionDesktopViewTicket).not.toHaveBeenCalled();
    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);
    expect(container.textContent).toContain("Live desktop is idle.");
    expect(container.textContent).toContain("Open desktop");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await flushAsyncWork();
    });
    expect(apiMocks.createSessionDesktopViewTicket).not.toHaveBeenCalled();
    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);

    await openLiveDesktopViewer();

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
    expect(container.textContent).toContain("Connecting");
    const rfb = rfbMocks.FakeRFB.instances[0];
    expect(rfb.urlOrChannel).toBe(
      "wss://app.trycycloid.com/api/sessions/s-1/desktop/view-ticket/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ws",
    );

    await act(async () => {
      rfb.dispatchConnect();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("View-only live desktop connected.");
  });

  it("expands the live desktop without creating another VNC connection", async () => {
    vi.useFakeTimers();
    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      rfb.dispatchConnect();
      await flushAsyncWork();
    });

    const liveTarget = container.querySelector<HTMLElement>("[data-view-only='true']");
    expect(liveTarget).not.toBeNull();
    const expandButton = container.querySelector<HTMLButtonElement>("button[aria-label='Expand live desktop']");
    expect(expandButton).not.toBeNull();

    await act(async () => {
      expandButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const dialog = container.querySelector<HTMLElement>("[role='dialog'][aria-label='Live desktop']");
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain("fixed");
    expect(dialog?.className).toContain("shadow-elevated");
    const expandedTarget = dialog?.querySelector<HTMLElement>("[data-view-only='true']");
    expect(expandedTarget).toBe(liveTarget);
    expect(expandedTarget?.parentElement?.className).toContain("flex-1");
    expect(expandedTarget?.parentElement?.className).not.toContain("aspect-[16/10]");
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
    expect(rfbMocks.FakeRFB.instances).toHaveLength(1);

    const closeButton = container.querySelector<HTMLButtonElement>("button[aria-label='Close expanded live desktop']");
    expect(closeButton).not.toBeNull();
    await act(async () => {
      closeButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(container.querySelector("[role='dialog'][aria-label='Live desktop']")).toBeNull();
    expect(container.querySelector("[data-view-only='true']")).toBe(liveTarget);
    expect(container.querySelector("button[aria-label='Expand live desktop']")).not.toBeNull();
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
    expect(rfbMocks.FakeRFB.instances).toHaveLength(1);
  });

  it("reconnects with a fresh ticket after an unclean viewer disconnect", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket
      .mockResolvedValueOnce(desktopTicket({ ticketId: "a".repeat(64) }))
      .mockResolvedValueOnce(desktopTicket({ ticketId: "b".repeat(64) }));

    await renderWorkbench();
    await openLiveDesktopViewer();
    const firstRfb = rfbMocks.FakeRFB.instances[0];
    await act(async () => {
      firstRfb.dispatchConnect();
      await flushAsyncWork();
    });

    await act(async () => {
      firstRfb.dispatchDisconnect(false);
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Reconnecting");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_RECONNECT_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances[1].urlOrChannel).toContain(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("reconnects with a fresh ticket after an unclean disconnect before first connect", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket
      .mockResolvedValueOnce(desktopTicket({ ticketId: "a".repeat(64) }))
      .mockResolvedValueOnce(desktopTicket({ ticketId: "b".repeat(64) }));

    await renderWorkbench();
    await openLiveDesktopViewer();
    const firstRfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      firstRfb.dispatchDisconnect(false);
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Reconnecting");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_RECONNECT_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances[1].urlOrChannel).toContain(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("reconnects with a fresh ticket after a clean viewer disconnect", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket
      .mockResolvedValueOnce(desktopTicket({ ticketId: "a".repeat(64) }))
      .mockResolvedValueOnce(desktopTicket({ ticketId: "b".repeat(64) }));

    await renderWorkbench();
    await openLiveDesktopViewer();
    const firstRfb = rfbMocks.FakeRFB.instances[0];
    await act(async () => {
      firstRfb.dispatchConnect();
      await flushAsyncWork();
    });

    await act(async () => {
      firstRfb.dispatchDisconnect(true);
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Preparing");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_RECONNECT_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances[1].urlOrChannel).toContain(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("retries the close status read when a clean startup disconnect races the proxy close write", async () => {
    vi.useFakeTimers();
    const ticket = desktopTicket({ ticketId: "e".repeat(64) });
    apiMocks.createSessionDesktopViewTicket
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce(desktopTicket({ ticketId: "f".repeat(64) }));
    apiMocks.fetchSessionDesktopViewTicketStatus
      .mockResolvedValueOnce({
        ok: true,
        ticket: ticket.ticket,
        connectionId: "00000000-0000-4000-8000-000000000001",
        connectedAtMs: 1000,
        closedAtMs: null,
        closeReason: null,
        revoked: false,
        expired: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        ticket: ticket.ticket,
        connectionId: "00000000-0000-4000-8000-000000000001",
        connectedAtMs: 1000,
        closedAtMs: 1100,
        closeReason: "upstream_unavailable",
        closeDetail: "runtime_sandbox_id_missing",
        revoked: false,
        expired: false,
      });

    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      rfb.dispatchDisconnect(true);
      await flushAsyncWork();
    });
    expect(apiMocks.fetchSessionDesktopViewTicketStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(100);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopViewTicketStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Preparing");
    expect(container.textContent).toContain("Server reason: upstream_unavailable (runtime_sandbox_id_missing).");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances[1].urlOrChannel).toContain(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
  });

  it("surfaces early upstream proxy failures instead of looping on preparing", async () => {
    vi.useFakeTimers();
    const ticket = desktopTicket({ ticketId: "d".repeat(64) });
    apiMocks.createSessionDesktopViewTicket.mockResolvedValueOnce(ticket);
    apiMocks.fetchSessionDesktopViewTicketStatus.mockResolvedValueOnce({
      ok: true,
      ticket: ticket.ticket,
      connectionId: "00000000-0000-4000-8000-000000000001",
      connectedAtMs: 1000,
      closedAtMs: 1100,
      closeReason: "upstream_forbidden",
      revoked: false,
      expired: false,
    });

    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      rfb.dispatchDisconnect(true);
      await flushAsyncWork();
    });

    expect(apiMocks.fetchSessionDesktopViewTicketStatus).toHaveBeenCalledWith(ticket.ticket.statusPath);
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Server reason: upstream_forbidden.");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_RECONNECT_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after the server blocks a view-only input attempt", async () => {
    vi.useFakeTimers();
    const ticket = desktopTicket({ ticketId: "f".repeat(64) });
    apiMocks.createSessionDesktopViewTicket.mockResolvedValueOnce(ticket);
    apiMocks.fetchSessionDesktopViewTicketStatus.mockResolvedValueOnce({
      ok: true,
      ticket: ticket.ticket,
      connectionId: "00000000-0000-4000-8000-000000000001",
      connectedAtMs: 1000,
      closedAtMs: 1100,
      closeReason: "input_blocked",
      closeDetail: "pointer",
      revoked: false,
      expired: false,
    });

    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      rfb.dispatchDisconnect(true);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("input was attempted on a view-only connection");
    expect(container.textContent).toContain("Server reason: input_blocked (pointer).");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_RECONNECT_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying early startup upstream-unavailable disconnects within the readiness window", async () => {
    vi.useFakeTimers();
    const tickets = ["a", "b", "c", "d"].map((letter) => desktopTicket({ ticketId: letter.repeat(64) }));
    apiMocks.createSessionDesktopViewTicket
      .mockResolvedValueOnce(tickets[0])
      .mockResolvedValueOnce(tickets[1])
      .mockResolvedValueOnce(tickets[2])
      .mockResolvedValueOnce(tickets[3]);
    apiMocks.fetchSessionDesktopViewTicketStatus.mockResolvedValue({
      ok: true,
      ticket: tickets[0].ticket,
      connectionId: "00000000-0000-4000-8000-000000000001",
      connectedAtMs: 1000,
      closedAtMs: 1100,
      closeReason: "upstream_unavailable",
      closeDetail: "non_loopback_binding",
      closeDiagnostics: {
        retryable: true,
        phase: "supervisor_start",
        reason: "non_loopback_binding",
        statusCode: 503,
        supervisorExitCode: 2,
        supervisorHealthStatus: "unavailable",
        supervisorHealthFailedComponent: "ports",
        supervisorHealthLastError: "non_loopback_binding",
        supervisorHealthDisplay: ":99",
        supervisorHealthWidth: 1280,
        supervisorHealthHeight: 720,
        supervisorHealthVncReachable: true,
        supervisorHealthNovncReachable: true,
        supervisorHealthLoopbackOnly: false,
      },
      revoked: false,
      expired: false,
    });

    await renderWorkbench();
    await openLiveDesktopViewer();

    for (let index = 0; index < 3; index += 1) {
      const rfb = rfbMocks.FakeRFB.instances[index];
      await act(async () => {
        rfb.dispatchDisconnect(true);
        await flushAsyncWork();
      });

      expect(container.textContent).toContain("Preparing");
      expect(container.textContent).toContain("Server reason: upstream_unavailable (non_loopback_binding).");
      expect(container.textContent).toContain("phase=supervisor_start");
      expect(container.textContent).toContain("failed=ports");
      expect(container.textContent).toContain("vnc=true");
      expect(container.textContent).toContain("novnc=true");
      expect(container.textContent).toContain("loopbackOnly=false");
      expect(container.textContent).not.toContain("Unavailable");

      await act(async () => {
        vi.advanceTimersByTime(DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS);
        await flushAsyncWork();
      });
    }

    expect(3 * DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS).toBeLessThan(DESKTOP_VIEWER_UPSTREAM_UNAVAILABLE_RETRY_MS);
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(4);
    expect(rfbMocks.FakeRFB.instances[3].urlOrChannel).toContain(
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );
  });

  it("does not retry non-retryable sandbox upstream disconnects", async () => {
    vi.useFakeTimers();
    const ticket = desktopTicket({ ticketId: "e".repeat(64) });
    apiMocks.createSessionDesktopViewTicket.mockResolvedValueOnce(ticket);
    apiMocks.fetchSessionDesktopViewTicketStatus.mockResolvedValueOnce({
      ok: true,
      ticket: ticket.ticket,
      connectionId: "00000000-0000-4000-8000-000000000001",
      connectedAtMs: 1000,
      closedAtMs: 1100,
      closeReason: "upstream_unavailable",
      closeDetail: "sandbox_stopped",
      closeDiagnostics: {
        retryable: false,
        phase: "sandbox_state",
        reason: "sandbox_stopped",
        sandboxStatus: "stopped",
        runtimeState: "paused",
      },
      revoked: false,
      expired: false,
    });

    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      rfb.dispatchDisconnect(true);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Server reason: upstream_unavailable (sandbox_stopped).");
    expect(container.textContent).toContain("phase=sandbox_state");
    expect(container.textContent).toContain("retryable=false");
    expect(container.textContent).toContain("runtime=paused");

    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
  });

  it("retries temporary desktop ticket 503s instead of making live view unavailable", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket
      .mockRejectedValueOnce(new ApiError("Desktop supervisor is unavailable", 503))
      .mockResolvedValueOnce(desktopTicket({ ticketId: "c".repeat(64) }));

    await renderWorkbench();
    await openLiveDesktopViewer();
    expect(container.textContent).toContain("Preparing");
    expect(container.textContent).not.toContain("Unavailable");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances[0].urlOrChannel).toContain(
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
  });

  it("does not retry non-retryable desktop ticket creation errors", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket.mockRejectedValueOnce(
      new ApiError("Desktop live view is unavailable because the sandbox is stopped", 409, "desktop_view_unavailable", {
        desktopViewRetryable: false,
        desktopViewReason: "sandbox_stopped",
      }),
    );

    await renderWorkbench();
    await openLiveDesktopViewer();

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Desktop live view is unavailable because the sandbox is stopped");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);
    expect(rfbMocks.FakeRFB.instances).toHaveLength(0);
  });

  it("renders unavailable and rate-limited live viewer copy", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket.mockRejectedValueOnce(new Error("Desktop sandbox is not connected"));
    await renderWorkbench();
    await openLiveDesktopViewer();
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Desktop sandbox is not connected");

    apiMocks.createSessionDesktopViewTicket.mockRejectedValueOnce(
      new ApiError("Desktop viewing tickets are being created too quickly. Please retry shortly.", 429, undefined, {
        retryAfterSeconds: 17,
      }),
    );
    await renderWorkbench({ sessionId: "s-rate-limited" });
    await openLiveDesktopViewer();
    expect(container.textContent).toContain("Rate limited");
    expect(container.textContent).toContain("Desktop viewing tickets are being created too quickly");
    expect(container.textContent).toContain("Retrying in 17s.");

    await act(async () => {
      vi.advanceTimersByTime(16_999);
      await flushAsyncWork();
    });
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushAsyncWork();
    });
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(3);
  });

  it("uses rate-limit retryAfterSeconds for the rendered message and reconnect delay", async () => {
    vi.useFakeTimers();
    apiMocks.createSessionDesktopViewTicket
      .mockRejectedValueOnce(
        new ApiError(
          "Desktop viewing tickets are being created too quickly. Please retry shortly.",
          429,
          "rate_limited",
          { retryAfterSeconds: 5 },
        ),
      )
      .mockResolvedValueOnce(desktopTicket({ ticketId: "c".repeat(64) }));

    await renderWorkbench({ sessionId: "s-rate-limited" });
    await openLiveDesktopViewer();

    expect(container.textContent).toContain("Rate limited");
    expect(container.textContent).toContain("Retrying in 5s.");
    expect(container.textContent).toContain("Retrying in 5 seconds.");

    await act(async () => {
      vi.advanceTimersByTime(4_999);
      await flushAsyncWork();
    });
    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushAsyncWork();
    });

    expect(apiMocks.createSessionDesktopViewTicket).toHaveBeenCalledTimes(2);
    expect(rfbMocks.FakeRFB.instances.at(-1)?.urlOrChannel).toContain(
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
  });

  it("cleans up the viewer ticket and noVNC connection on unmount", async () => {
    vi.useFakeTimers();
    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    await act(async () => {
      root.unmount();
      rootMounted = false;
      await flushAsyncWork();
    });

    expect(rfb.disconnect).toHaveBeenCalled();
    expect(apiMocks.revokeSessionDesktopViewTicket).toHaveBeenCalledWith(
      "/api/sessions/s-1/desktop/view-ticket/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("configures the live viewer as view-only and exposes no input target", async () => {
    vi.useFakeTimers();
    await renderWorkbench();
    await openLiveDesktopViewer();
    const rfb = rfbMocks.FakeRFB.instances[0];

    expect(rfb.viewOnly).toBe(true);
    expect(rfb.focusOnClick).toBe(false);
    expect(rfb.clipViewport).toBe(false);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.resizeSession).toBe(false);
    const liveTarget = container.querySelector<HTMLElement>("[data-view-only='true']");
    expect(liveTarget).not.toBeNull();
    expect(liveTarget?.parentElement?.className).toContain("aspect-[16/10]");
    expect(liveTarget?.getAttribute("aria-hidden")).toBe("true");
    expect(liveTarget?.className).toContain("pointer-events-none");
    expect(liveTarget?.className).toContain("[&_canvas]:object-contain");
    expect(container.querySelector("input, textarea, [contenteditable='true']")).toBeNull();
  });
});
