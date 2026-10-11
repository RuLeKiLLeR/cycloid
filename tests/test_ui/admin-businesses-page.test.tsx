import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  searchAdminBusinesses: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/admin-console", () => ({
  searchAdminBusinesses: apiMocks.searchAdminBusinesses,
}));

import { AdminBusinessesPage } from "../../apps/ui/src/pages/AdminBusinessesPage";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    HTMLAnchorElement: windowInstance.HTMLAnchorElement,
    HTMLInputElement: windowInstance.HTMLInputElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
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

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(AdminBusinessesPage)));
    await flushAsyncWork();
  });

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const inputConstructor = input.ownerDocument.defaultView?.HTMLInputElement;
  const setter = inputConstructor
    ? Object.getOwnPropertyDescriptor(inputConstructor.prototype, "value")?.set
    : undefined;
  setter?.call(input, value);
  Simulate.change(input);
}

describe("AdminBusinessesPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installDomGlobals(new Window({ url: "https://app.trycycloid.com/admin/businesses" }));
    apiMocks.searchAdminBusinesses.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores stale in-flight responses when a newer search finishes later", async () => {
    const initial = deferred<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        memberCount: number;
        sessionCount: number;
        lastSessionAt: number | null;
      }>
    >();
    const filtered = deferred<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        memberCount: number;
        sessionCount: number;
        lastSessionAt: number | null;
      }>
    >();

    apiMocks.searchAdminBusinesses
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => filtered.promise);

    const { container, unmount } = await renderPage();
    const input = container.querySelector("input[type='search']") as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      changeInputValue(input!, "beta");
      await flushAsyncWork();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
    });
    expect(apiMocks.searchAdminBusinesses).toHaveBeenCalledTimes(2);

    await act(async () => {
      filtered.resolve([
        {
          id: "biz-beta",
          name: "Beta Labs",
          createdAt: 2,
          memberCount: 3,
          sessionCount: 4,
          lastSessionAt: null,
        },
      ]);
      await filtered.promise;
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Beta Labs");
    expect(container.textContent).not.toContain("Acme Corp");

    await act(async () => {
      initial.resolve([
        {
          id: "biz-acme",
          name: "Acme Corp",
          createdAt: 1,
          memberCount: 1,
          sessionCount: 2,
          lastSessionAt: null,
        },
      ]);
      await initial.promise;
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Beta Labs");
    expect(container.textContent).not.toContain("Acme Corp");

    await unmount();
  });
});
