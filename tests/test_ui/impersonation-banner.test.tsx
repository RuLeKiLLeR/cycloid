import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImpersonationBanner } from "../../apps/ui/src/components/ImpersonationBanner";

describe("ImpersonationBanner", () => {
  let window: Window;
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window = new Window();
    const doc = window.document as unknown as Document;
    container = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(container as unknown as Node);
    (globalThis as Record<string, unknown>).window = window as unknown as Window & typeof globalThis;
    (globalThis as Record<string, unknown>).document = doc;
    (globalThis as Record<string, unknown>).HTMLElement = window.HTMLElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).HTMLElement;
    vi.restoreAllMocks();
  });

  function render(props: Parameters<typeof ImpersonationBanner>[0]) {
    act(() => {
      root.render(createElement(ImpersonationBanner, props));
    });
  }

  it("renders target login, operator login, and a stop button when impersonating", () => {
    render({
      impersonation: {
        impersonationId: "imp-1",
        actor: { id: 42, login: "operator-josiah" },
        readOnly: true,
      },
      targetLogin: "customer-acme",
    });

    expect(container.textContent).toContain("Viewing as");
    expect(container.textContent).toContain("customer-acme");
    expect(container.textContent).toContain("operator-josiah");
    expect(container.querySelector("button")?.textContent).toContain("Stop impersonating");
  });

  it("falls back to actor id when login is missing", () => {
    render({
      impersonation: {
        impersonationId: "imp-2",
        actor: { id: 99, login: null },
        readOnly: true,
      },
      targetLogin: null,
    });
    expect(container.textContent).toContain("actor #99");
  });

  it("does not display the impersonation reason", () => {
    // The banner sits in the customer-shaped UI; the reason field is operator-
    // entered free text and may contain ticket details, so it must never appear.
    render({
      impersonation: {
        impersonationId: "imp-3",
        actor: { id: 1, login: "op" },
        readOnly: true,
      },
      targetLogin: "cust",
    });
    expect(container.textContent).not.toContain("reason");
    expect(container.textContent).not.toContain("ticket");
  });
});
