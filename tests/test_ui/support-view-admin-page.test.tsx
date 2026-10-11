import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listImpersonationDirectory: vi.fn(),
  searchImpersonationTargets: vi.fn(),
  startImpersonation: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/admin-impersonation", () => ({
  listImpersonationDirectory: apiMocks.listImpersonationDirectory,
  searchImpersonationTargets: apiMocks.searchImpersonationTargets,
  startImpersonation: apiMocks.startImpersonation,
}));

import { SupportViewAdminPage } from "../../apps/ui/src/pages/SupportViewAdminPage";

let happyWindow: Window;
let assignSpy: ReturnType<typeof vi.fn>;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    HTMLInputElement: windowInstance.HTMLInputElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    FocusEvent: windowInstance.FocusEvent,
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

function changeInputValue(input: HTMLInputElement, value: string) {
  const inputConstructor = input.ownerDocument.defaultView?.HTMLInputElement;
  const setter = inputConstructor
    ? Object.getOwnPropertyDescriptor(inputConstructor.prototype, "value")?.set
    : undefined;
  setter?.call(input, value);
  Simulate.change(input);
}

async function openCustomerDropdown(container: ParentNode) {
  const filter = container.querySelector<HTMLInputElement>("#support-view-customer-filter");
  expect(filter).not.toBeNull();
  await act(async () => {
    filter!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushAsyncWork();
  });
  return filter!;
}

async function renderSupportViewPage(route = "/admin/support-view") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(SupportViewAdminPage)));
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

describe("SupportViewAdminPage", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/admin/support-view" });
    installDomGlobals(happyWindow);
    assignSpy = vi.fn();
    Object.defineProperty(happyWindow.location, "assign", {
      configurable: true,
      writable: true,
      value: assignSpy,
    });
    apiMocks.listImpersonationDirectory.mockReset();
    apiMocks.searchImpersonationTargets.mockReset();
    apiMocks.startImpersonation.mockReset();
    apiMocks.listImpersonationDirectory.mockResolvedValue({
      ok: true,
      truncated: false,
      businesses: [
        {
          id: "biz-customer",
          name: "Customer Inc",
          users: [
            {
              id: 42,
              login: "customer-one",
              name: "Customer One",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
          ],
        },
      ],
    });
    apiMocks.searchImpersonationTargets.mockResolvedValue({ ok: true, sessions: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a grouped customer dropdown without requiring a search first", async () => {
    const { container, unmount } = await renderSupportViewPage();

    expect(apiMocks.listImpersonationDirectory).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>("#support-view-customer-filter")?.placeholder).toBe(
      "Select customer",
    );
    expect(container.textContent).not.toContain("Customer Inc (biz-customer)");
    await openCustomerDropdown(container);

    expect(container.textContent).toContain("Customer Inc (biz-customer)");
    expect(container.textContent).toContain("customer-one");
    expect(container.textContent).toContain("Showing 1 of 1 customers");
    expect(apiMocks.searchImpersonationTargets).not.toHaveBeenCalled();

    await act(async () => {
      const customerButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("customer-one"),
      );
      customerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("customer-one");
    expect(container.textContent).toContain("Customer Inc (biz-customer)");

    await unmount();
  });

  it("filters the visible customer list", async () => {
    apiMocks.listImpersonationDirectory.mockResolvedValueOnce({
      ok: true,
      truncated: false,
      businesses: [
        {
          id: "biz-customer",
          name: "Customer Inc",
          users: [
            {
              id: 42,
              login: "customer-one",
              name: "Customer One",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
            {
              id: 43,
              login: "customer-two",
              name: "Customer Two",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
          ],
        },
      ],
    });

    const { container, unmount } = await renderSupportViewPage();
    const filter = await openCustomerDropdown(container);
    expect(container.textContent).toContain("customer-one");
    expect(container.textContent).toContain("customer-two");

    await act(async () => {
      changeInputValue(filter, "two");
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("customer-one");
    expect(container.textContent).toContain("customer-two");
    expect(container.textContent).toContain("Showing 1 of 2 customers");

    await unmount();
  });

  it("clears stale customer filtering when the dropdown closes", async () => {
    apiMocks.listImpersonationDirectory.mockResolvedValueOnce({
      ok: true,
      truncated: false,
      businesses: [
        {
          id: "biz-customer",
          name: "Customer Inc",
          users: [
            {
              id: 42,
              login: "customer-one",
              name: "Customer One",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
            {
              id: 43,
              login: "customer-two",
              name: "Customer Two",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
          ],
        },
      ],
    });

    const { container, unmount } = await renderSupportViewPage();
    const filter = await openCustomerDropdown(container);

    await act(async () => {
      changeInputValue(filter, "missing");
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Showing 0 of 2 customers");

    await act(async () => {
      Simulate.blur(filter, { relatedTarget: null });
      await flushAsyncWork();
    });

    expect(filter.value).toBe("");
    expect(container.textContent).not.toContain("Showing 0 of 2 customers");

    await unmount();
  });

  it("warns when the customer dropdown is limited", async () => {
    apiMocks.listImpersonationDirectory.mockResolvedValueOnce({
      ok: true,
      truncated: true,
      businesses: [],
    });

    const { container, unmount } = await renderSupportViewPage();

    expect(container.textContent).toContain("Customer list is limited");

    await unmount();
  });

  it("starts support view without requiring reason text", async () => {
    apiMocks.startImpersonation.mockImplementation(() => new Promise(() => {}));

    const { container, unmount } = await renderSupportViewPage();
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Start support view"),
    );

    await openCustomerDropdown(container);

    await act(async () => {
      const customerButton = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("customer-one"),
      );
      customerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect((button as HTMLButtonElement | undefined)?.disabled).toBe(false);

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(apiMocks.startImpersonation).toHaveBeenCalledWith({ targetUserId: 42, reason: "" });
    expect(container.textContent).not.toContain("Reason must be at least");

    await unmount();
  });

  it("auto-starts support view for admin-console session links", async () => {
    apiMocks.startImpersonation.mockResolvedValueOnce({
      ok: true,
      impersonationId: "imp-1",
      expiresAt: 123,
    });

    const { unmount } = await renderSupportViewPage("/admin/support-view?sessionId=sess-123&targetUserId=42");

    expect(apiMocks.startImpersonation).toHaveBeenCalledWith({
      targetUserId: 42,
      reason: "Open session sess-123 from admin console",
    });
    expect(assignSpy).toHaveBeenCalledWith("/sessions/sess-123");

    await unmount();
  });

  it("shows an error for invalid admin-console support-view links", async () => {
    const { container, unmount } = await renderSupportViewPage("/admin/support-view?sessionId=sess-123");

    expect(apiMocks.startImpersonation).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Invalid admin-console support-view link");

    await unmount();
  });
});
