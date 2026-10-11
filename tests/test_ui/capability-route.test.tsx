import { Window } from "happy-dom";
import { act, createElement, type ElementType, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CapabilityRoute } from "../../apps/ui/src/components/CapabilityRoute";
import type { BootstrapCapabilities } from "../../shared/types/bootstrap";

const layoutMocks = vi.hoisted(() => ({
  capabilities: null as BootstrapCapabilities | null,
  capabilitiesStatus: "loading" as "loading" | "ready" | "unavailable",
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
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

async function renderRoute(component: ElementType) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/gated"] },
        createElement(
          Suspense,
          { fallback: createElement("div", null, "loading") },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/", element: createElement("div", null, "home") }),
            createElement(Route, {
              path: "/gated",
              element: createElement(CapabilityRoute, { capability: "canAccessIntegrationDebug", component }),
            }),
          ),
        ),
      ),
    );
  });

  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await flushAsyncWork();
    });
  }

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

describe("CapabilityRoute", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/gated" });
    installDomGlobals(happyWindow);
    layoutMocks.capabilities = null;
    layoutMocks.capabilitiesStatus = "loading";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not load the route module while capabilities are unresolved", async () => {
    const loader = vi.fn(async () => ({ default: () => createElement("div", null, "protected") }));
    const Component = lazy(loader);

    const { container, unmount } = await renderRoute(Component);

    expect(loader).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).toBe("");

    await unmount();
  });

  it("redirects denied routes without loading the route module", async () => {
    layoutMocks.capabilitiesStatus = "ready";
    layoutMocks.capabilities = {
      canAccessIntegrationDebug: false,
      canManageBusinessIntegrations: false,
      canManageCliTokens: true,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
    };
    const loader = vi.fn(async () => ({ default: () => createElement("div", null, "protected") }));
    const Component = lazy(loader);

    const { container, unmount } = await renderRoute(Component);

    expect(loader).not.toHaveBeenCalled();
    expect(container.textContent).toBe("home");

    await unmount();
  });

  it("redirects when capabilities are unavailable", async () => {
    layoutMocks.capabilitiesStatus = "unavailable";
    layoutMocks.capabilities = null;
    const loader = vi.fn(async () => ({ default: () => createElement("div", null, "protected") }));
    const Component = lazy(loader);

    const { container, unmount } = await renderRoute(Component);

    expect(loader).not.toHaveBeenCalled();
    expect(container.textContent).toBe("home");

    await unmount();
  });

  it("catches allowed gated route render failures locally", async () => {
    layoutMocks.capabilitiesStatus = "ready";
    layoutMocks.capabilities = {
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: false,
      canManageCliTokens: true,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Component = () => {
      throw new Error("route exploded");
    };

    const { container, unmount } = await renderRoute(Component);

    expect(container.textContent).toContain("Protected route failed to load");
    expect(container.textContent).toContain("route exploded");

    await unmount();
  });
});
