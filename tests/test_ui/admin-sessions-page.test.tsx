import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchAdminSessions: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/admin-console", () => ({
  fetchAdminSessions: apiMocks.fetchAdminSessions,
}));

import { AdminSessionsPage } from "../../apps/ui/src/pages/AdminSessionsPage";

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
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
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage(initialEntry = "/admin/sessions?businessId=biz-1&userId=42&status=active") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(AdminSessionsPage)));
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

describe("AdminSessionsPage", () => {
  beforeEach(() => {
    installDomGlobals(new Window({ url: "https://app.trycycloid.com/admin/sessions" }));
    apiMocks.fetchAdminSessions.mockReset();
    apiMocks.fetchAdminSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears business and user filter chips from the URL-backed filters", async () => {
    const { container, unmount } = await renderPage();

    expect(apiMocks.fetchAdminSessions).toHaveBeenLastCalledWith({
      businessId: "biz-1",
      userId: 42,
      status: "active",
      limit: 100,
    });

    const clearBusiness = container.querySelector<HTMLButtonElement>('button[aria-label="Clear business filter"]');
    expect(clearBusiness).not.toBeNull();

    await act(async () => {
      Simulate.click(clearBusiness!);
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("Business biz-1");
    expect(apiMocks.fetchAdminSessions).toHaveBeenLastCalledWith({
      businessId: undefined,
      userId: 42,
      status: "active",
      limit: 100,
    });

    const clearUser = container.querySelector<HTMLButtonElement>('button[aria-label="Clear user filter"]');
    expect(clearUser).not.toBeNull();

    await act(async () => {
      Simulate.click(clearUser!);
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("User 42");
    expect(apiMocks.fetchAdminSessions).toHaveBeenLastCalledWith({
      businessId: undefined,
      userId: undefined,
      status: "active",
      limit: 100,
    });

    await unmount();
  });
});
