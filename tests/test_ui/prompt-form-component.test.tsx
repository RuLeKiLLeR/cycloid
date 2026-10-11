// Eagerly load the markdown chunk that `MarkdownEventContent` lazy-imports so the
// dynamic `import("./MarkdownContent")` resolves from the module cache within
// `flushAsyncWork`'s fixed flush window. Without this, the first test that renders
// block markdown races the (uncached) chunk load and flakes on slower CI runners.
import "../../apps/ui/src/components/MarkdownContent";

import { Window } from "happy-dom";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptForm } from "../../apps/ui/src/components/PromptForm";
import { SessionPrRow } from "../../apps/ui/src/components/session/SessionPrRow";

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    location: windowInstance.location,
    history: windowInstance.history,
    Element: windowInstance.Element,
    HTMLElement: windowInstance.HTMLElement,
    HTMLTextAreaElement: windowInstance.HTMLTextAreaElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    InputEvent: windowInstance.InputEvent,
    MouseEvent: windowInstance.MouseEvent,
    File: windowInstance.File,
    FileReader: windowInstance.FileReader,
    Blob: windowInstance.Blob,
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor<T>(read: () => T | null, attempts = 100): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    const value = read();
    if (value !== null) return value;
    await act(async () => {
      await flushAsyncWork();
    });
  }
  throw new Error(`waitFor timed out after ${attempts} attempts`);
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  Simulate.change(textarea, { target: { value } } as unknown as Event);
}

function setInputFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
}

function dispatchDrop(element: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: { files },
  });
  element.dispatchEvent(event);
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderPromptForm(props: Partial<Parameters<typeof PromptForm>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = async (nextProps: Partial<Parameters<typeof PromptForm>[0]> = {}) => {
    root.render(
      createElement(PromptForm, {
        lifecycle: { phase: "idle" },
        onSubmit: vi.fn(),
        ...nextProps,
      }),
    );
    await flushAsyncWork();
  };

  await act(async () => {
    await render(props);
  });

  return {
    container,
    async rerender(nextProps: Partial<Parameters<typeof PromptForm>[0]> = {}) {
      await act(async () => {
        await render(nextProps);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

async function renderNode(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(createElement(Fragment, null, node));
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

describe("PromptForm", () => {
  beforeEach(() => {
    happyWindow = new Window();
    installDomGlobals(happyWindow);
  });

  afterEach(() => {
    happyWindow.close();
  });

  it("keeps prompt entry enabled while exposing a hover and focus reason for disabled send", async () => {
    const reason = "Pick a repository and model to send prompt";
    const { container, unmount } = await renderPromptForm({ submitDisabledReason: reason });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const sendButton = container.querySelector<HTMLButtonElement>(`button[aria-label='Send: ${reason}']`);
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");
    const tooltipWrapper = sendButton?.parentElement;

    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
    expect(sendButton).not.toBeNull();
    expect(sendButton?.type).toBe("button");
    expect(sendButton?.disabled).toBe(false);
    expect(sendButton?.getAttribute("aria-disabled")).toBe("true");
    expect(sendButton?.getAttribute("aria-label")).toBe(`Send: ${reason}`);
    expect(tooltipWrapper?.getAttribute("aria-describedby")).toBe(tooltip?.id);
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toBe(reason);
    expect(tooltip?.className).toContain("group-hover:block");
    expect(tooltip?.className).toContain("group-focus-within:block");

    await unmount();
  });

  it("shows busy copy and disables the whole composer for external busy work", async () => {
    const busyLabel = "Starting session…";
    const onSubmit = vi.fn();
    const { container, unmount } = await renderPromptForm({ busyLabel, initialValue: "build the thing", onSubmit });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>(`button[aria-label='Send: ${busyLabel}']`);
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");

    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    expect(textarea?.disabled).toBe(true);
    expect(sendButton).not.toBeNull();
    expect(sendButton?.getAttribute("aria-disabled")).toBe("true");
    expect(tooltip?.textContent).toBe(busyLabel);

    await act(async () => {
      Simulate.submit(form!);
      await flushAsyncWork();
    });

    expect(onSubmit).not.toHaveBeenCalled();

    await unmount();
  });

  it("shows sending copy while keeping the prompt entry enabled during submit", async () => {
    const submit = deferredPromise<void>();
    const onSubmit = vi.fn(() => submit.promise);
    const { container, unmount } = await renderPromptForm({ onSubmit, initialValue: "follow up" });

    const form = container.querySelector<HTMLFormElement>("form");
    expect(form).not.toBeNull();

    await act(async () => {
      Simulate.submit(form!);
      await flushAsyncWork();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send: Sending prompt…']");
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");

    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
    expect(sendButton).not.toBeNull();
    expect(sendButton?.getAttribute("aria-disabled")).toBe("true");
    expect(tooltip?.textContent).toBe("Sending prompt…");

    submit.resolve();
    await act(async () => {
      await submit.promise;
      await flushAsyncWork();
    });

    await unmount();
  });

  it("requires explicit confirmation before submitting a matching PR as a takeover", async () => {
    const onSubmit = vi.fn();
    const { container, unmount } = await renderPromptForm({
      onSubmit,
      variant: "chat",
      takeoverRepoUrl: "https://github.com/acme/widgets",
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    await act(async () => {
      setTextareaValue(textarea!, "Finish https://github.com/acme/widgets/pull/42");
      await flushAsyncWork();
    });

    const chip = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Take over PR #42"),
    );
    expect(chip).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      Simulate.click(chip!);
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Taking over PR #42");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        takeoverPrUrl: "https://github.com/acme/widgets/pull/42",
      }),
    );
    await unmount();
  });

  it("keeps explicit submit disabled reasons ahead of busy copy", async () => {
    const reason = "Pick a repository and model to send prompt";
    const { container, unmount } = await renderPromptForm({
      busyLabel: "Starting session…",
      submitDisabledReason: reason,
      initialValue: "build the thing",
    });

    const sendButton = container.querySelector<HTMLButtonElement>(`button[aria-label='Send: ${reason}']`);
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");

    expect(sendButton).not.toBeNull();
    expect(tooltip?.textContent).toBe(reason);

    await unmount();
  });

  it("keeps terminal lifecycle disables on the generic unavailable copy", async () => {
    const { container, unmount } = await renderPromptForm({
      lifecycle: { phase: "archived" },
      initialValue: "build the thing",
    });

    const sendButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Send: Send is unavailable right now.']",
    );
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");

    expect(sendButton).not.toBeNull();
    expect(tooltip?.textContent).toBe("Send is unavailable right now.");

    await unmount();
  });

  it("keeps empty prompt disables on the enter-a-prompt copy", async () => {
    const { container, unmount } = await renderPromptForm();

    const sendButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Send: Enter a prompt to enable Send.']",
    );
    const tooltip = container.querySelector<HTMLElement>("[role='tooltip']");

    expect(sendButton).not.toBeNull();
    expect(tooltip?.textContent).toBe("Enter a prompt to enable Send.");

    await unmount();
  });

  it("rewarms with the new default reasoning effort when the model changes after text entry", async () => {
    const onWarm = vi.fn();
    const efforts = ["low", "medium", "high", "max"];
    const { container, rerender, unmount } = await renderPromptForm({
      defaultReasoningEffort: "high",
      onWarm,
      reasoningEfforts: efforts,
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "fix the bug");
      await flushAsyncWork();
    });

    expect(onWarm).toHaveBeenCalledTimes(1);
    expect(onWarm).toHaveBeenLastCalledWith("high");

    await rerender({
      defaultReasoningEffort: "max",
      onWarm,
      reasoningEfforts: efforts,
    });

    expect(onWarm).toHaveBeenCalledTimes(2);
    expect(onWarm).toHaveBeenLastCalledWith("max");

    await unmount();
  });

  it("keeps the default variant reasoning toggle on the kit button ladder", async () => {
    const { container, unmount } = await renderPromptForm({
      defaultReasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high"],
    });

    const reasoningButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Thinking: med. Click to cycle.']",
    );

    expect(reasoningButton).not.toBeNull();
    // Kit ghost Button (control-md) with the filled active wash on aria-pressed.
    expect(reasoningButton?.className).toContain("control-md");
    expect(reasoningButton?.className).toContain("btn-press");
    expect(reasoningButton?.className).toContain("aria-pressed:bg-surface-3");
    expect(reasoningButton?.className).not.toContain("min-w-[44px]");

    await unmount();
  });

  it("stacks the chat composer with a bottom action toolbar", async () => {
    const { container, unmount } = await renderPromptForm({ variant: "chat" });

    // The chat composer is the canonical command-composer surface: a
    // session-stack-surface card that stacks the textarea above a toolbar row,
    // rather than a horizontal row that vertically centers the send button.
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const composerShell = textarea?.parentElement?.parentElement;

    expect(composerShell).not.toBeNull();
    expect(composerShell?.className).toContain("session-stack-surface");
    expect(composerShell?.className).toContain("command-composer");
    expect(composerShell?.className).toContain("flex-col");
    expect(composerShell?.className).not.toContain("items-center");

    // The action row lives below the textarea as a dedicated toolbar.
    const toolbar = composerShell?.querySelector(".command-composer-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain("items-center");

    await unmount();
  });

  it("lets the default composer scroll once autosize reaches its max height", async () => {
    const { container, unmount } = await renderPromptForm();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    Object.defineProperty(textarea!, "scrollHeight", {
      configurable: true,
      get: () => 400,
    });

    await act(async () => {
      setTextareaValue(textarea!, "A very long prompt that should overflow once autosize hits its cap.");
      await flushAsyncWork();
    });

    expect(textarea?.style.height).toBe("192px");
    expect(textarea?.style.overflowY).toBe("auto");

    await unmount();
  });

  it("can keep the default variant action row while matching chat composer padding", async () => {
    const { container, unmount } = await renderPromptForm({ matchChatPadding: true });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const uploadButton = container.querySelector<HTMLButtonElement>("button[aria-label='Upload files as context']");

    expect(textarea).not.toBeNull();
    // matchChatPadding tightens the composer textarea padding to the compact
    // chat rhythm (px-3 py-2.5) instead of the roomier default (px-4 py-3).
    expect(textarea?.className).toContain("px-3");
    expect(textarea?.className).toContain("py-2.5");
    expect(textarea?.className).not.toContain("px-4");
    expect(textarea?.className).not.toContain("py-3");
    expect(uploadButton).not.toBeNull();

    await unmount();
  });

  it("uploads a picked image and includes it in the submit payload", async () => {
    const onSubmit = vi.fn();
    const { container, unmount } = await renderPromptForm({ onSubmit });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const fileInput = container.querySelector<HTMLInputElement>("input[type='file']");
    expect(textarea).not.toBeNull();
    expect(fileInput).not.toBeNull();
    expect(fileInput?.accept).toContain("image/png");

    await act(async () => {
      setTextareaValue(textarea!, "Review this screenshot");
      await flushAsyncWork();
    });

    const file = new File(["image"], "shot.png", { type: "image/png" });
    await act(async () => {
      setInputFiles(fileInput!, [file]);
      Simulate.change(fileInput!);
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("shot.png") ? true : null));
    expect(container.textContent).not.toContain("Unsupported file type");

    await act(async () => {
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Review this screenshot",
        uploadedImages: [{ name: "shot.png", mediaType: "image/png", data: "aW1hZ2U=" }],
      }),
    );

    await unmount();
  });

  it("uploads a dropped image through the same prompt attachment path", async () => {
    const { container, unmount } = await renderPromptForm();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    const file = new File(["image"], "drop.png", { type: "image/png" });
    await act(async () => {
      dispatchDrop(form!, [file]);
      await flushAsyncWork();
    });

    await waitFor(() => (container.textContent?.includes("drop.png") ? true : null));
    expect(container.textContent).not.toContain("Unsupported file type");

    await unmount();
  });

  it("submits leading slash skills separately from prompt text", async () => {
    const onSubmit = vi.fn();
    const loadSkills = vi.fn(async () => [
      { name: "review-spec", description: "Review a tech spec", content: "# Review" },
    ]);
    const { container, unmount } = await renderPromptForm({ onSubmit, loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "/rev");
      await flushAsyncWork();
    });

    const option = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("/review-spec"),
    );
    expect(option).not.toBeUndefined();

    await act(async () => {
      Simulate.mouseDown(option!);
      await flushAsyncWork();
    });

    await act(async () => {
      setTextareaValue(textarea!, "/review-spec check the plan");
      await flushAsyncWork();
    });

    await act(async () => {
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/review-spec check the plan",
        skills: ["review-spec"],
      }),
    );

    await unmount();
  });

  it("guards against a second submit while the skill cache is still resolving", async () => {
    const onSubmit = vi.fn();
    let resolveSkills: ((skills: Array<{ name: string; description: string; content: string }>) => void) | undefined;
    const loadSkills = vi.fn(
      () =>
        new Promise<Array<{ name: string; description: string; content: string }>>((resolve) => {
          resolveSkills = resolve;
        }),
    );
    const { container, unmount } = await renderPromptForm({ onSubmit, loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    await act(async () => {
      // Trailing text past the slash token keeps the skill autocomplete closed,
      // so the submit path reaches the ensureSkillCache await.
      setTextareaValue(textarea!, "/review-spec check the plan");
      await flushAsyncWork();
    });

    const form = container.querySelector("form");
    await act(async () => {
      // Two submits fired before the cache resolves; only the first should pass
      // the in-flight guard.
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(loadSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSkills?.([{ name: "review-spec", description: "Review a tech spec", content: "# Review" }]);
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);

    await unmount();
  });

  it("submits an optional-argument skill-only slash command with an empty prompt", async () => {
    const onSubmit = vi.fn();
    const loadSkills = vi.fn(async () => [
      { name: "audit-docs", description: "Audit docs", argument: "optional -- path to audit" },
    ]);
    const { container, unmount } = await renderPromptForm({ onSubmit, loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "/audit-docs");
      await flushAsyncWork();
    });

    await act(async () => {
      Simulate.keyDown(textarea!, { key: "Escape" } as unknown as KeyboardEvent);
      await flushAsyncWork();
    });

    await act(async () => {
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/audit-docs",
        skills: ["audit-docs"],
      }),
    );

    await unmount();
  });

  it("submits a skill-only slash command with required-looking argument metadata", async () => {
    const onSubmit = vi.fn();
    const loadSkills = vi.fn(async () => [
      { name: "verify-pr-before-merge", description: "Verify PR", argument: "PR URL or number" },
    ]);
    const { container, unmount } = await renderPromptForm({ onSubmit, loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "/verify-pr-before-merge");
      await flushAsyncWork();
    });

    await act(async () => {
      Simulate.keyDown(textarea!, { key: "Escape" } as unknown as KeyboardEvent);
      await flushAsyncWork();
    });

    await act(async () => {
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/verify-pr-before-merge",
        skills: ["verify-pr-before-merge"],
      }),
    );

    await unmount();
  });

  it("renders the skill autocomplete dropdown above the textarea so it stays on-screen when the composer is pinned to the viewport bottom", async () => {
    const loadSkills = vi.fn(async () => [
      { name: "review-spec", description: "Review a tech spec" },
      { name: "review-pr", description: "Review a pull request" },
    ]);
    const { container, unmount } = await renderPromptForm({ loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "/rev");
      await flushAsyncWork();
    });

    const dropdown = Array.from(container.querySelectorAll<HTMLDivElement>("div.absolute")).find((node) =>
      node.textContent?.includes("/review-spec"),
    );
    expect(dropdown).not.toBeUndefined();
    // bottom-full + mb-1 positions it above the textarea so it grows upward
    // into the message thread instead of off the bottom of the viewport.
    expect(dropdown?.className).toContain("bottom-full");
    expect(dropdown?.className).toContain("mb-1");
    expect(dropdown?.className).not.toContain("mt-1");
    // max-h-52 + overflow-y-auto must remain so very long lists scroll
    // inside the dropdown rather than pushing past the viewport edge.
    expect(dropdown?.className).toContain("max-h-52");
    expect(dropdown?.className).toContain("overflow-y-auto");

    await unmount();
  });

  it("keeps shared file autocomplete and attached-file chips working in the chat variant", async () => {
    const loadFiles = vi.fn(async () => ["src/foo.ts", "docs/usage.md"]);
    const { container, unmount } = await renderPromptForm({ loadFiles, variant: "chat" });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "Check @foo");
      await flushAsyncWork();
    });

    const option = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("src/foo.ts"),
    );
    expect(option).not.toBeUndefined();

    await act(async () => {
      Simulate.mouseDown(option!);
      await flushAsyncWork();
    });

    expect(textarea?.value).toBe("Check @src/foo.ts ");

    const removeButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Remove attached file src/foo.ts']",
    );
    expect(removeButton).not.toBeNull();

    await act(async () => {
      Simulate.click(removeButton!);
      await flushAsyncWork();
    });

    expect(textarea?.value).toBe("Check");

    await unmount();
  });

  it("keeps skill autocomplete selection valid when results arrive after keyboard navigation", async () => {
    const skills = deferredPromise<Array<{ name: string; description: string }>>();
    const loadSkills = vi.fn(() => skills.promise);
    const { container, unmount } = await renderPromptForm({ loadSkills });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      setTextareaValue(textarea!, "/rev");
      await flushAsyncWork();
    });

    await act(async () => {
      Simulate.keyDown(textarea!, { key: "ArrowDown" } as unknown as KeyboardEvent);
      await flushAsyncWork();
    });

    await act(async () => {
      skills.resolve([{ name: "review-spec", description: "Review a tech spec" }]);
      await flushAsyncWork();
    });

    await act(async () => {
      Simulate.keyDown(textarea!, { key: "Enter" } as unknown as KeyboardEvent);
      await flushAsyncWork();
    });

    expect(textarea?.value).toBe("/review-spec ");

    await unmount();
  });

  it("shows a provisional final-verification message before publish starts", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "not_started",
      publishError: null,
      verification: null,
      phase: "finalizing",
      lastBranch: "codex/fix-status-copy",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: {
        state: "final_verification_pending",
        tone: "info",
        title: "Local work complete. Final verification pending.",
        detail: null,
      },
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.textContent).toContain("Local work complete. Final verification pending.");
    expect(container.textContent).not.toContain("Create PR");

    await unmount();
  });

  it("renders the published PR state chip with an external compact PR-number link", async () => {
    const session = {
      prUrl: "https://github.com/example/repo/pull/12",
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "success",
      publishError: null,
      verification: null,
      phase: "completed",
      lastBranch: "codex/fix-status-copy",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: null,
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("PR #12");
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://github.com/example/repo/pull/12");
    expect(link?.className).toContain("btn-press");
    expect(link?.className).toContain("control-sm");

    await unmount();
  });

  it("prefers a real create-pr error over the failed publish status message", async () => {
    // ARC-1330 D-57: the pre-publish block status + its dedicated PrSection inline render were
    // deleted. A real create-pr error (`prError`) still takes precedence over `session.publishError`
    // in the inline message.
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "failed",
      publishError: "Targeted tests failed in durable-object-batch-reads.test.ts",
      verification: null,
      phase: "failed",
      lastBranch: "codex/fix-status-copy",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: null,
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.textContent).toContain("Targeted tests failed in durable-object-batch-reads.test.ts");
    expect(container.textContent?.match(/Targeted tests failed in durable-object-batch-reads\.test\.ts/g)).toHaveLength(
      1,
    );

    await unmount();
  });

  it("renders blocked publish detail as inline markdown with error tone", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "blocked_by_verification",
      publishError: "See [failed run](https://example.com/run) and `npm test`.",
      verification: null,
      phase: "failed",
      lastBranch: "codex/fix-status-copy",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: null,
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    const error = container.querySelector(".text-error");
    await waitFor(() => error?.querySelector('a[href="https://example.com/run"]') ?? null);
    expect(error?.textContent).toContain("See failed run and npm test.");
    expect(error?.querySelector('a[href="https://example.com/run"]')).not.toBeNull();
    expect(error?.querySelector("code")?.textContent).toBe("npm test");

    await unmount();
  });

  it("prefers a real publish error over the blocked publish status message", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "blocked_by_verification",
      publishError: "Targeted tests failed in durable-object-batch-reads.test.ts",
      verification: null,
      phase: "failed",
      lastBranch: "codex/fix-status-copy",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: null,
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: "GitHub rejected PR creation after verification passed",
      }),
    );

    expect(container.textContent).toContain("GitHub rejected PR creation after verification passed");
    expect(container.textContent).not.toContain("Targeted tests failed in durable-object-batch-reads.test.ts");

    await unmount();
  });

  it("renders a clean no-change outcome with non-error styling", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "not_started",
      publishError: null,
      verification: null,
      phase: "completed",
      lastBranch: "main",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: {
        state: "no_changes",
        tone: "info",
        title: "Completed without code changes - no PR created.",
        detail: null,
      },
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.textContent).toContain("Completed without code changes - no PR created.");
    expect(container.textContent).not.toContain("Create PR");
    expect(container.querySelector(".text-error")).toBeNull();

    await unmount();
  });

  it("renders outcome detail as block markdown", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "not_started",
      publishError: null,
      verification: null,
      phase: "completed",
      lastBranch: "main",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: {
        state: "no_changes",
        tone: "info",
        title: "Completed without code changes - no PR created.",
        detail: "- Checked `npm test`\n- No diff remained",
      },
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("npm test");
    expect(container.querySelector(".text-error")).toBeNull();

    await unmount();
  });

  it("renders an abnormal no-change outcome with error styling", async () => {
    const session = {
      prUrl: null,
      prDraft: false,
      prManualReviewReason: null,
      publishStatus: "not_started",
      publishError: null,
      verification: null,
      phase: "completed",
      lastBranch: "main",
      baseBranch: "main",
      repoUrl: "https://github.com/example/repo",
      outcome: {
        state: "no_change_abnormal",
        tone: "error",
        title: "Finalization failed before changes could be prepared.",
        detail: null,
      },
    } as unknown as Parameters<typeof SessionPrRow>[0]["session"];

    const { container, unmount } = await renderNode(
      createElement(SessionPrRow, {
        session,
        prError: null,
      }),
    );

    expect(container.textContent).toContain("Finalization failed before changes could be prepared.");
    expect(container.querySelector(".text-error")).not.toBeNull();

    await unmount();
  });
});
