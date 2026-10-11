import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes, useOutletContext } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminLayout } from "../../apps/ui/src/components/AdminLayout";
import type { LayoutContext } from "../../apps/ui/src/components/Layout";

const layoutContext = {
  user: { id: 42, login: "admin-user" },
} as LayoutContext;

function ChildRoute() {
  const context = useOutletContext<LayoutContext>();
  return createElement("div", null, context.user?.login ?? "missing");
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
    HTMLButtonElement: windowInstance.HTMLButtonElement,
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

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/admin/sessions"] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Outlet, { context: layoutContext }) },
            createElement(
              Route,
              { path: "/admin", element: createElement(AdminLayout) },
              createElement(Route, { path: "sessions", element: createElement(ChildRoute) }),
            ),
          ),
        ),
      ),
    );
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

describe("AdminLayout", () => {
  beforeEach(() => {
    installDomGlobals(new Window({ url: "https://app.trycycloid.com/admin/sessions" }));
  });

  afterEach(() => {
    delete (globalThis as { window?: Window }).window;
  });

  it("forwards the parent layout outlet context to nested admin routes", async () => {
    const { container, unmount } = await renderPage();

    expect(container.textContent).toContain("admin-user");

    await unmount();
  });

  it("omits the overview tab and keeps pending signups as the first admin destination", async () => {
    const { container, unmount } = await renderPage();
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("nav a"));

    expect(links.map((link) => link.textContent)).toEqual(["Pending signups", "Businesses", "Users", "Sessions"]);
    expect(links[0]?.getAttribute("href")).toBe("/admin/pending-signups");
    expect(container.textContent).not.toContain("Overview");

    await unmount();
  });
});
