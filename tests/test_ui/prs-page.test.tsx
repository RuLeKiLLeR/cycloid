import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrInboxItem, PrInboxPage } from "../../apps/ui/src/api/pr-inbox";
import { PrsPage } from "../../apps/ui/src/pages/PrsPage";

const apiMocks = vi.hoisted(() => ({
  fetchPrInbox: vi.fn(),
}));

vi.mock("../../apps/ui/src/api/pr-inbox.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../apps/ui/src/api/pr-inbox")>();
  return { ...original, fetchPrInbox: apiMocks.fetchPrInbox };
});

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => ({
    repos: [
      {
        fullName: "acme/web",
        url: "https://github.com/acme/web",
        private: false,
        defaultBranch: "main",
        ownerType: "Organization",
      },
    ],
  }),
}));

let happyWindow: Window;
let rendered: { container: HTMLDivElement; root: Root } | null = null;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    HTMLElement: windowInstance.HTMLElement,
    HTMLInputElement: windowInstance.HTMLInputElement,
    HTMLSelectElement: windowInstance.HTMLSelectElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

function item(sessionId: string, title: string, overrides: Partial<PrInboxItem> = {}): PrInboxItem {
  return {
    sessionId,
    prUrl: `https://github.com/acme/web/pull/${sessionId}`,
    prNumber: 42,
    title,
    repoOwner: "acme",
    repoName: "web",
    headBranch: `arc/${sessionId}`,
    draft: false,
    state: "REVIEW",
    bucket: "needs_review",
    phase: "review",
    feChip: "Review",
    labels: [],
    stageSection: "review",
    cycloidDone: { state: "working", outcome: null, reasons: [] },
    model: null,
    agentRuntimeBackend: null,
    initiationMode: "user",
    linkedTicket: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function page(
  items: PrInboxItem[],
  nextCursor: string | null = null,
  counts: Partial<PrInboxPage["bucketCounts"]> = {},
): PrInboxPage {
  const bucketCounts: PrInboxPage["bucketCounts"] = {
    draft: 0,
    needs_review: 0,
    changes_requested: 0,
    checks_failing: 0,
    approved: 0,
    open: 0,
    closed: 0,
  };
  for (const inboxItem of items) bucketCounts[inboxItem.bucket] += 1;
  Object.assign(bucketCounts, counts);
  return {
    items,
    nextCursor,
    totalCount: Object.values(bucketCounts).reduce((sum, count) => sum + count, 0),
    bucketCounts,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushSearchDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await flushAsyncWork();
}

async function waitFor<T>(predicate: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
    const result = predicate();
    if (result) return result;
  }
  throw new Error("waitFor timed out");
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered = { container, root };
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(PrsPage)));
    await flushAsyncWork();
  });
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  const reactPropsKey = Object.getOwnPropertyNames(input).find((key) => key.startsWith("__reactProps$"));
  if (!reactPropsKey) throw new Error("React input props not found");
  const props = (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[
    reactPropsKey
  ];
  props.onChange?.({ target: input });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value;
  const reactPropsKey = Object.getOwnPropertyNames(select).find((key) => key.startsWith("__reactProps$"));
  if (reactPropsKey) {
    const props = (select as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>)[
      reactPropsKey
    ];
    props.onChange?.({ target: select });
    return;
  }
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function buttonWithText(container: Element, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) ?? null
  );
}

beforeEach(() => {
  happyWindow = new Window({ url: "https://app.example.com/prs" });
  installDomGlobals(happyWindow);
  apiMocks.fetchPrInbox.mockReset();
});

afterEach(async () => {
  if (rendered) {
    await act(async () => {
      rendered?.root.unmount();
      await flushAsyncWork();
    });
    rendered.container.remove();
    rendered = null;
  }
  happyWindow.close();
});

describe("PrsPage", () => {
  it("keeps closed PRs reachable through the status select (single filter axis)", async () => {
    apiMocks.fetchPrInbox
      .mockResolvedValueOnce(page([item("open", "Open PR")], null, { needs_review: 7, closed: 3 }))
      .mockResolvedValueOnce(page([item("closed-pr", "Closed PR", { bucket: "closed" })], null, { closed: 3 }));

    const container = await renderPage();
    await waitFor(() => (container.textContent?.includes("Open PR") ? true : null));

    // No lane toggles: the status select is the only status filter axis.
    expect(container.querySelector('[aria-label="Show or hide PR lanes"]')).toBeNull();
    const statusSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]');
    if (!statusSelect) throw new Error("Status filter not found");
    const optionValues = Array.from(statusSelect.options).map((option) => option.value);
    expect(optionValues).toContain("closed");

    await act(async () => {
      setSelectValue(statusSelect, "closed");
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.fetchPrInbox.mock.calls.length === 2 ? true : null));
    expect(apiMocks.fetchPrInbox.mock.calls[1]?.[0]).toMatchObject({ bucket: "closed" });
    expect(apiMocks.fetchPrInbox.mock.calls[1]?.[0].lane).toBeUndefined();
    await waitFor(() => (container.textContent?.includes("Closed PR") ? true : null));
  });

  it("sends status and search to the server and ignores stale filter responses", async () => {
    apiMocks.fetchPrInbox.mockResolvedValueOnce(page([item("initial", "Initial PR")]));
    const container = await renderPage();
    await waitFor(() => (container.textContent?.includes("Initial PR") ? true : null));

    const statusRequest = deferred<PrInboxPage>();
    const searchRequest = deferred<PrInboxPage>();
    apiMocks.fetchPrInbox.mockReturnValueOnce(statusRequest.promise).mockReturnValueOnce(searchRequest.promise);

    const statusSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]');
    if (!statusSelect) throw new Error("Status filter not found");
    await act(async () => {
      setSelectValue(statusSelect, "approved");
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.fetchPrInbox.mock.calls.length === 2 ? true : null));

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="Search PRs"]');
    if (!searchInput) throw new Error("Search input not found");
    await act(async () => {
      setInputValue(searchInput, "needle");
      await flushAsyncWork();
    });
    await act(async () => {
      await flushSearchDebounce();
    });
    await waitFor(() => (apiMocks.fetchPrInbox.mock.calls.length === 3 ? true : null));

    expect(apiMocks.fetchPrInbox.mock.calls[1]?.[0]).toMatchObject({ bucket: "approved", search: null });
    expect(apiMocks.fetchPrInbox.mock.calls[2]?.[0]).toMatchObject({ bucket: "approved", search: "needle" });

    searchRequest.resolve(page([item("current", "Current filtered PR", { bucket: "approved" })]));
    await waitFor(() => (container.textContent?.includes("Current filtered PR") ? true : null));
    statusRequest.resolve(page([item("stale", "Stale status PR", { bucket: "approved" })]));
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Current filtered PR");
    expect(container.textContent).not.toContain("Stale status PR");
  });

  it("preserves rows and shows an inline retry when loading another page fails", async () => {
    apiMocks.fetchPrInbox
      .mockResolvedValueOnce(page([item("first", "First PR")], "next-page"))
      .mockRejectedValueOnce(new Error("Cursor expired"))
      .mockResolvedValueOnce(page([item("second", "Second PR")], null));

    const container = await renderPage();
    const loadMore = await waitFor(() => buttonWithText(container, "Load more"));
    await act(async () => {
      loadMore.click();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("Could not load more PRs: Cursor expired") ? true : null));
    expect(container.textContent).toContain("First PR");
    expect(container.querySelector('a[href="/sessions/first?artifact=pr"]')).not.toBeNull();
    expect(apiMocks.fetchPrInbox.mock.calls[1]?.[0]).toMatchObject({ cursor: "next-page" });

    const retry = buttonWithText(container, "Retry");
    if (!retry) throw new Error("Load-more retry not found");
    await act(async () => {
      retry.click();
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("Second PR") ? true : null));
    expect(container.textContent).toContain("First PR");
    expect(container.textContent).not.toContain("Cursor expired");
  });

  it("resets pagination and ignores a stale load-more response after filters change", async () => {
    const loadMoreRequest = deferred<PrInboxPage>();
    const filteredRequest = deferred<PrInboxPage>();
    apiMocks.fetchPrInbox
      .mockResolvedValueOnce(page([item("initial", "Initial PR")], "next-page"))
      .mockReturnValueOnce(loadMoreRequest.promise)
      .mockReturnValueOnce(filteredRequest.promise);

    const container = await renderPage();
    const loadMore = await waitFor(() => buttonWithText(container, "Load more"));
    await act(async () => {
      loadMore.click();
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.fetchPrInbox.mock.calls.length === 2 ? true : null));

    const statusSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]');
    if (!statusSelect) throw new Error("Status filter not found");
    await act(async () => {
      setSelectValue(statusSelect, "approved");
      await flushAsyncWork();
    });
    await waitFor(() => (apiMocks.fetchPrInbox.mock.calls.length === 3 ? true : null));
    expect(apiMocks.fetchPrInbox.mock.calls[2]?.[0].cursor).toBeUndefined();

    filteredRequest.resolve(page([item("filtered", "Filtered PR", { bucket: "approved" })]));
    await waitFor(() => (container.textContent?.includes("Filtered PR") ? true : null));
    loadMoreRequest.resolve(page([item("stale-page", "Stale page PR")]));
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Filtered PR");
    expect(container.textContent).not.toContain("Stale page PR");
  });

  it("distinguishes an empty inbox from an empty filtered result", async () => {
    apiMocks.fetchPrInbox.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
    const container = await renderPage();
    await waitFor(() => (container.textContent?.includes("No PRs yet") ? true : null));

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="Search PRs"]');
    if (!searchInput) throw new Error("Search input not found");
    await act(async () => {
      setInputValue(searchInput, "missing");
      await flushAsyncWork();
    });
    await act(async () => {
      await flushSearchDebounce();
    });

    await waitFor(() => (container.textContent?.includes("No matching PRs") ? true : null));
    expect(container.textContent).not.toContain("No PRs yet");
    expect(buttonWithText(container, "Clear filters")).not.toBeNull();
  });

  it("renders a first-page failure without presenting stale rows", async () => {
    apiMocks.fetchPrInbox.mockRejectedValueOnce(new Error("Service unavailable"));
    const container = await renderPage();
    await waitFor(() => (container.textContent?.includes("Could not load PRs") ? true : null));
    expect(container.textContent).toContain("Service unavailable");
    expect(container.querySelector('[href^="/sessions/"]')).toBeNull();
  });
});
