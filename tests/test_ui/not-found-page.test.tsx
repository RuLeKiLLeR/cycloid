import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundPage } from "../../apps/ui/src/pages/NotFoundPage";
import { resetAuthenticatedTitle } from "../../apps/ui/src/utils/authenticated-title";

let happyWindow: Window;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  happyWindow = new Window({ url: "https://app.trycycloid.com/nonexistent" });
  for (const [key, value] of Object.entries({
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    Node: happyWindow.Node,
    Event: happyWindow.Event,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetAuthenticatedTitle();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  happyWindow.close();
});

describe("NotFoundPage", () => {
  it("renders the branded action and owns the page title", () => {
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/nonexistent"]}>
          <NotFoundPage />
        </MemoryRouter>,
      ),
    );

    expect(container.textContent).toContain("This page doesn't exist.");
    expect(container.textContent).toContain("Back to home");
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(document.title).toBe("Page not found - Cycloid");
    expect(container.querySelector("main")?.classList.contains("editorial-rise")).toBe(true);
  });

  it("replaces only the authenticated wildcard while preserving known deep links and aliases", () => {
    const source = readFileSync(join(process.cwd(), "apps/ui/src/authenticated-app.tsx"), "utf8");
    expect(source).toContain('<Route path="index.html" element={<Navigate to="/" replace />} />');
    expect(source).toContain('<Route path="authenticated.html" element={<Navigate to="/" replace />} />');
    expect(source).toContain('<Route path="*" element={<NotFoundPage />} />');
    expect(source).toContain('<Route path="sessions/:id" element={<SessionPage />} />');
    expect(source).toContain('<Route path="integration-debug/:integrationId"');
    expect(source).toContain('<Route path="workspace-integrations"');
    expect(source).toContain('capability="canUseControlRoom"');
  });
});
