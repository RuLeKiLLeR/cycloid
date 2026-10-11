import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchableSelectChip } from "../../apps/ui/src/components/SearchableSelectChip";

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
    InputEvent: windowInstance.InputEvent,
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

async function renderChip(
  props: Partial<Parameters<typeof SearchableSelectChip>[0]> = {},
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(SearchableSelectChip, {
        ariaLabel: "Model",
        label: "Model",
        selectedLabel: "Model",
        value: "",
        onChange: vi.fn(),
        options: [],
        ...props,
      }),
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

describe("SearchableSelectChip", () => {
  beforeEach(() => {
    happyWindow = new Window();
    installDomGlobals(happyWindow);
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("renders grouped headers as non-selectable rows and filters empty groups", async () => {
    const onChange = vi.fn();
    const { container, unmount } = await renderChip({
      onChange,
      options: [
        { value: "openai:gpt-5.4", label: "GPT-5.4", group: "Codex" },
        { value: "anthropic:claude-opus-4-8", label: "Claude Opus 4.8", group: "Claude Code" },
      ],
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Claude Code");
    expect([...container.querySelectorAll("[role='group']")].map((group) => group.getAttribute("aria-label"))).toEqual([
      "Codex",
      "Claude Code",
    ]);
    expect([...container.querySelectorAll("[role='option']")].map((option) => option.textContent)).toEqual([
      "GPT-5.4",
      "Claude Opus 4.8",
    ]);

    const search = container.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();

    await act(async () => {
      search!.value = "Claude";
      Simulate.change(search!, { target: { value: "Claude" } } as unknown as Event);
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("Codex");
    expect(container.textContent).toContain("Claude Code");
    expect([...container.querySelectorAll("[role='option']")].map((option) => option.textContent)).toEqual([
      "Claude Opus 4.8",
    ]);

    await unmount();
  });

  it("renders one ARIA group when same-group options are not contiguous", async () => {
    const { container, unmount } = await renderChip({
      options: [
        { value: "openai:gpt-5.4", label: "GPT-5.4", group: "Codex" },
        { value: "anthropic:claude-opus-4-8", label: "Claude Opus 4.8", group: "Claude Code" },
        { value: "baseten:kimi-k2.7-code", label: "Kimi K2.7 Code", group: "Codex" },
      ],
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const groups = [...container.querySelectorAll<HTMLElement>("[role='group']")];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Codex", "Claude Code"]);
    expect(groups[0]?.textContent).toBe("CodexGPT-5.4Kimi K2.7 Code");
    expect(groups[1]?.textContent).toBe("Claude CodeClaude Opus 4.8");

    await unmount();
  });

  it("does not resolve typed group labels as options", async () => {
    const onChange = vi.fn();
    const { container, unmount } = await renderChip({
      onChange,
      options: [{ value: "openai:gpt-5.4", label: "GPT-5.4", group: "Codex" }],
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const search = container.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();

    await act(async () => {
      search!.value = "Codex";
      Simulate.change(search!, { target: { value: "Codex" } } as unknown as Event);
      Simulate.keyDown(search!, { key: "Enter" } as unknown as KeyboardEvent);
      await flushAsyncWork();
    });

    expect(onChange).not.toHaveBeenCalled();

    await unmount();
  });

  it("keeps ungrouped chips free of section headers", async () => {
    const { container, unmount } = await renderChip({
      options: [
        { value: "repo-a", label: "acme/repo-a" },
        { value: "repo-b", label: "acme/repo-b" },
      ],
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect([...container.querySelectorAll("[role='option']")].map((option) => option.textContent)).toEqual([
      "acme/repo-a",
      "acme/repo-b",
    ]);
    expect(container.querySelector("[role='listbox']")?.textContent).toBe("acme/repo-aacme/repo-b");

    await unmount();
  });
});
