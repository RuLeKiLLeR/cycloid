import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationsDebugSettings } from "../../apps/ui/src/components/settings/IntegrationsDebugSettings";

const apiMocks = vi.hoisted(() => ({
  fetchIntegrationLifecycleEvents: vi.fn(async () => ({
    events: [
      {
        id: "evt-1",
        business_id: "biz-1",
        user_id: 1,
        session_id: "sess-1",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "failed" as const,
        reason_code: "repo_access_denied",
        message: "GitHub couldn't verify repo access.",
        details_json: JSON.stringify({ repoOwner: "acme", repoName: "web" }),
        latency_ms: 123,
        created_at: 1_700_000_000_000,
      },
    ],
    nextCursor: null,
  })),
}));

vi.mock("../../apps/ui/src/api/integration-lifecycle.ts", () => ({
  fetchIntegrationLifecycleEvents: apiMocks.fetchIntegrationLifecycleEvents,
}));

vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const React = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      React.useEffect(effect, []);
    },
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
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

async function render(initialEntry = "/settings/integration-debug/github") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/settings/integration-debug",
            element: createElement(IntegrationsDebugSettings),
          }),
          createElement(Route, {
            path: "/settings/integration-debug/:integrationId",
            element: createElement(IntegrationsDebugSettings),
          }),
        ),
      ),
    );
    await flushAsyncWork();
  });

  for (let i = 0; i < 4; i += 1) {
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

function NavigationHarness() {
  const navigate = useNavigate();

  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        onClick: () => navigate("/settings/integration-debug/linear"),
      },
      "go-linear",
    ),
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: "/settings/integration-debug",
        element: createElement(IntegrationsDebugSettings),
      }),
      createElement(Route, {
        path: "/settings/integration-debug/:integrationId",
        element: createElement(IntegrationsDebugSettings),
      }),
    ),
  );
}

describe("IntegrationsDebugSettings", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/settings/integration-debug/github" });
    installDomGlobals(happyWindow);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders lifecycle events for the selected integration", async () => {
    const { container, unmount } = await render();

    expect(apiMocks.fetchIntegrationLifecycleEvents).toHaveBeenCalledWith({ integrationId: "github", limit: 50 });
    expect(container.textContent ?? "").toContain("Integration events");
    expect(container.textContent ?? "").toContain("GitHub");
    expect(container.textContent ?? "").not.toContain("Admin only");
    expect(container.textContent ?? "").not.toContain("Lifecycle events for integrations in your business.");
    expect(container.textContent ?? "").not.toContain("Datadog");
    expect(container.textContent ?? "").toContain("GitHub couldn't verify repo access.");
    expect(container.textContent ?? "").toContain("Provider Probe Passed");
    expect(container.textContent ?? "").toContain("failed");
    expect(container.textContent ?? "").toContain("repo_access_denied");
    expect(container.textContent ?? "").toContain('"repoOwner": "acme"');
    expect(container.textContent ?? "").toContain("session sess-1");

    await unmount();
  });

  it("copies event identifiers from event rows", async () => {
    const { container, unmount } = await render();

    const copyEventButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy event ID"]');
    expect(copyEventButton).toBeTruthy();

    await act(async () => {
      copyEventButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("evt-1");

    await unmount();
  });

  it("ignores stale load-more results after switching integrations", async () => {
    let resolveLoadMore: ((value: { events: typeof firstPageEvents; nextCursor: string | null }) => void) | null = null;
    const firstPageEvents = [
      {
        id: "evt-1",
        business_id: "biz-1",
        user_id: 1,
        session_id: "sess-1",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "failed" as const,
        reason_code: "repo_access_denied",
        message: "GitHub couldn't verify repo access.",
        details_json: JSON.stringify({ repoOwner: "acme", repoName: "web" }),
        latency_ms: 123,
        created_at: 1_700_000_000_000,
      },
    ];

    apiMocks.fetchIntegrationLifecycleEvents.mockReset();
    apiMocks.fetchIntegrationLifecycleEvents
      .mockResolvedValueOnce({
        events: firstPageEvents,
        nextCursor: "100:evt-1",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLoadMore = resolve;
          }),
      )
      .mockResolvedValueOnce({
        events: [
          {
            id: "evt-3",
            business_id: "biz-1",
            user_id: 1,
            session_id: "sess-3",
            integration_id: "linear",
            stage: "provider_probe_passed",
            status: "passed" as const,
            reason_code: null,
            message: "Linear check passed.",
            details_json: null,
            latency_ms: 55,
            created_at: 1_700_000_100_000,
          },
        ],
        nextCursor: null,
      });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/settings/integration-debug/github"] },
          createElement(NavigationHarness),
        ),
      );
      await flushAsyncWork();
    });

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await flushAsyncWork();
      });
    }

    const loadMoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more",
    );
    expect(loadMoreButton).toBeTruthy();

    await act(async () => {
      loadMoreButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const navigateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "go-linear",
    );
    expect(navigateButton).toBeTruthy();

    await act(async () => {
      navigateButton?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await flushAsyncWork();
      });
    }

    await act(async () => {
      resolveLoadMore?.({
        events: [
          {
            id: "evt-2",
            business_id: "biz-1",
            user_id: 1,
            session_id: "sess-2",
            integration_id: "github",
            stage: "credential_resolved",
            status: "failed",
            reason_code: "token_missing",
            message: "No GitHub OAuth token is stored for this user.",
            details_json: null,
            latency_ms: 12,
            created_at: 1_700_000_050_000,
          },
        ],
        nextCursor: null,
      });
      await flushAsyncWork();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Linear check passed.");
    expect(text).not.toContain("No GitHub OAuth token is stored for this user.");
    expect(text).not.toContain("Loading…");

    await act(async () => {
      root.unmount();
      await flushAsyncWork();
    });
    container.remove();
  });
});
