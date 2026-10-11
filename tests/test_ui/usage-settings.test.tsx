import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsageSettings } from "../../apps/ui/src/components/settings/UsageSettings";
import type { OpenAIGatewayUsage } from "../../apps/ui/src/types";

const apiMocks = vi.hoisted(() => ({
  fetchOpenAIGatewayUsage: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/settings.ts", () => ({
  fetchOpenAIGatewayUsage: apiMocks.fetchOpenAIGatewayUsage,
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

async function renderUsageSettings(payload: OpenAIGatewayUsage) {
  apiMocks.fetchOpenAIGatewayUsage.mockResolvedValue(payload);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(UsageSettings));
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

function usagePayload(overrides: Partial<OpenAIGatewayUsage["currentMonth"]> = {}): OpenAIGatewayUsage {
  return {
    currentMonth: {
      periodStartMs: Date.UTC(2026, 5, 1),
      periodEndMs: Date.UTC(2026, 6, 1),
      spentUsdMicros: 0,
      reservedUsdMicros: 0,
      monthlyLimitUsdMicros: 0,
      settledRequestCount: 0,
      reservedRequestCount: 0,
      releasedRequestCount: 0,
      settlementUnresolvedRequestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      ...overrides,
    },
    virtualKeys: [],
  };
}

describe("UsageSettings", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/usage";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("renders the empty state", async () => {
    const { container, unmount } = await renderUsageSettings(usagePayload());

    expect(container.textContent).toContain("OpenAI spend");
    expect(container.textContent).toContain("$0.00");
    // A zero managed limit means no managed key/limit exists, not a $0 allowance.
    expect(container.textContent).toContain("No limit set");
    expect(container.textContent).not.toContain("Virtual keys");

    await unmount();
  });

  it("renders populated spend, request, and token data without virtual key internals", async () => {
    const payload = usagePayload({
      spentUsdMicros: 1_234_567,
      reservedUsdMicros: 500_000,
      monthlyLimitUsdMicros: 100_000_000,
      settledRequestCount: 12,
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 300,
      reasoningOutputTokens: 40,
    });
    payload.virtualKeys = [
      {
        id: "vk_user_123",
        status: "active",
        monthlyLimitUsdMicros: 100_000_000,
        createdAt: Date.UTC(2026, 5, 2),
        updatedAt: Date.UTC(2026, 5, 2),
      },
    ];

    const { container, unmount } = await renderUsageSettings(payload);

    // Cents precision: micro-dollar tails read as raw data, not a bill.
    expect(container.textContent).toContain("$1.23");
    expect(container.textContent).not.toContain("$1.234567");
    expect(container.textContent).toContain("$0.50");
    expect(container.textContent).toContain("$100.00");
    expect(container.textContent).not.toContain("No limit set");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("1,000");
    expect(container.textContent).toContain("200");
    expect(container.textContent).toContain("300");
    expect(container.textContent).toContain("40");
    expect(container.textContent).not.toContain("vk_user_123");
    expect(container.textContent).not.toContain("Virtual keys");

    await unmount();
  });

  it("renders unresolved settlement warnings and rounds tiny spend to cents", async () => {
    const { container, unmount } = await renderUsageSettings(
      usagePayload({
        spentUsdMicros: 31,
        settlementUnresolvedRequestCount: 2,
      }),
    );

    expect(container.textContent).toContain("$0.00");
    expect(container.textContent).not.toContain("$0.000031");
    expect(container.textContent).toContain("2 requests finished without recorded usage and were not charged.");

    await unmount();
  });

  it("formats the current usage month as a UTC range", async () => {
    const { container, unmount } = await renderUsageSettings(
      usagePayload({
        periodStartMs: Date.UTC(2026, 5, 1, 0, 0),
        periodEndMs: Date.UTC(2026, 6, 1, 0, 0),
      }),
    );

    expect(container.textContent).toContain("Jun 1, 2026 – Jun 30, 2026");

    await unmount();
  });
});
