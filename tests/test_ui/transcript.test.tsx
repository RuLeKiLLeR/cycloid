import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Transcript } from "../../apps/ui/src/components/Transcript";
import type { ActivityEvent, PromptRow } from "../../apps/ui/src/types";

vi.mock("../../apps/ui/src/components/MarkdownContent.tsx", () => ({
  MarkdownContent: ({ content, variant = "block" }: { content: string; variant?: "block" | "inline" }) =>
    createElement(variant === "inline" ? "span" : "div", { "data-markdown-variant": variant }, content),
  InlineMarkdownContent: ({ content }: { content: string }) =>
    createElement("span", { "data-markdown-variant": "inline" }, content),
}));

const ANSWER_QUESTION = vi.fn();

const PROMPT_A: PromptRow = {
  promptId: "p-1",
  session_id: "s-1",
  prompt: "first prompt",
  result: "done",
  status: "completed",
};

let happyWindow: Window;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLInputElement: windowInstance.HTMLInputElement,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    InputEvent: windowInstance.InputEvent,
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderWithRoot(render: (root: Root) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    render(root);
    await flushAsyncWork();
  });

  return {
    container,
    async rerender(renderNext: (root: Root) => void) {
      await act(async () => {
        renderNext(root);
        await flushAsyncWork();
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

describe("Transcript", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.test/sessions/s-1" });
    installDomGlobals(happyWindow);
    ANSWER_QUESTION.mockReset();
  });

  afterEach(() => {
    happyWindow.close();
    document.body.innerHTML = "";
  });

  it("filters echoed prompt text but still renders recovered assistant text", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            { type: "text", id: "echo-1", text: "first prompt" },
            { type: "text", id: "reply-1", text: "Recovered assistant reply" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("first prompt");
    expect(rendered.container.textContent).toContain("Recovered assistant reply");
    expect(
      rendered.container.querySelector('[data-message-bubble="true"][data-role="assistant"]')?.textContent,
    ).toContain("Recovered assistant reply");

    await rendered.unmount();
  });

  it("hides the benign review-loop worktree policy block from the normal transcript", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "session_error",
              id: "err-1",
              error: 'Policy block: review-loop access outside worktree "/tmp/review-lint-format.log"',
              code: "policy_block",
            },
            { type: "text", id: "reply-1", text: "Continuing with an in-tree path." },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("review-loop access outside worktree");
    expect(rendered.container.textContent).toContain("Continuing with an in-tree path.");

    await rendered.unmount();
  });

  it("still shows the review-loop worktree policy block in support view", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "session_error",
              id: "err-1",
              error: 'Policy block: review-loop access outside worktree "/tmp/review-lint-format.log"',
              code: "policy_block",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          supportView: true,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("review-loop access outside worktree");

    await rendered.unmount();
  });

  it("keeps other policy blocks visible in the normal transcript", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "session_error",
              id: "err-1",
              error: 'Policy block: protected path "package-lock.json"',
              code: "policy_block",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("protected path");

    await rendered.unmount();
  });

  it("renders a muted progress indicator only when the active turn is in flight", async () => {
    const activePrompt: PromptRow = { ...PROMPT_A, result: null, status: "processing" };
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: activePrompt,
          events: [],
          isActive: true,
          showProgressIndicator: true,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const indicators = rendered.container.querySelectorAll('[role="status"]');
    expect(indicators.length).toBe(1);
    expect(indicators[0].textContent).toBe("Working…");
    expect(indicators[0].classList.contains("text-text-muted")).toBe(true);
    expect(indicators[0].classList.contains("text-warning")).toBe(false);

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: activePrompt,
          events: [],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });
    expect(rendered.container.querySelectorAll('[role="status"]').length).toBe(0);

    await rendered.unmount();
  });

  it("updates the progress indicator when the in-flight flag changes", async () => {
    const activePrompt: PromptRow = { ...PROMPT_A, result: null, status: "processing" };
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: activePrompt,
          events: [],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("Working…");

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: activePrompt,
          events: [],
          isActive: true,
          showProgressIndicator: true,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });
    expect(rendered.container.textContent).toContain("Working…");

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: activePrompt,
          events: [],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });
    expect(rendered.container.textContent).not.toContain("Working…");

    await rendered.unmount();
  });

  it("renders a completed plan turn as a collapsed plan card, not a markdown wall", async () => {
    const planText = [
      "# Plan",
      "",
      "## Intent Restatement",
      "Add a Local troubleshooting section to the README.",
      "",
      "## Scope In/Out",
      "In scope: README only. UNIQUE_BODY_MARKER",
      "",
      "## Breadth",
      "XS. One file.",
    ].join("\n");

    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [{ type: "text", id: "plan-1", text: planText, promptId: "p-1" }],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const card = rendered.container.querySelector('[data-plan-card="true"]');
    expect(card).not.toBeNull();
    // Not rendered as a normal assistant bubble.
    expect(rendered.container.querySelector('[data-message-bubble="true"][data-role="assistant"]')).toBeNull();
    // Summary is shown; the body stays collapsed.
    expect(card?.textContent).toContain("Add a Local troubleshooting section to the README");
    expect(card?.textContent).not.toContain("Breadth XS");
    expect(card?.textContent).not.toContain("3 sections");
    expect(card?.textContent).not.toContain("Download");
    expect(rendered.container.textContent).not.toContain("UNIQUE_BODY_MARKER");

    // Expanding reveals the full plan body.
    const toggle = card?.querySelector("button[aria-expanded]") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(rendered.container.textContent).toContain("UNIQUE_BODY_MARKER");

    await rendered.unmount();
  });

  it("renders the plan once when it appears twice (streamed + recovered copy)", async () => {
    // The plan can arrive twice in a turn: a clean streamed copy and a
    // result-recovered copy prefixed with a prose preamble. Both must collapse
    // into a single card, not a card plus a duplicate wall.
    const cleanPlan = "# Plan\n\n## Intent Restatement\nDo the thing. DUP_MARKER\n\n## Breadth\nXS.";
    const preamblePlan = `I have enough context to lock the plan.\n\n${cleanPlan}`;
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            { type: "text", id: "plan-clean", text: cleanPlan, promptId: "p-1" },
            { type: "text", id: "plan-recovered", text: preamblePlan, promptId: "p-1" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Exactly one plan card, and the plan body text (DUP_MARKER) appears once.
    expect(rendered.container.querySelectorAll('[data-plan-card="true"]').length).toBe(1);
    const occurrences = (rendered.container.textContent?.match(/DUP_MARKER/g) ?? []).length;
    expect(occurrences).toBe(0); // collapsed: not shown until expanded
    // The preamble copy is not rendered as its own bubble.
    expect(rendered.container.textContent).not.toContain("I have enough context to lock the plan");

    await rendered.unmount();
  });

  it("collapses a completed plan turn even while a later turn is still active", async () => {
    // A finished plan turn keeps result === null, so its Transcript is rendered
    // with isActive=true while the implementation turn runs. The card must still
    // collapse — gated on the plan prompt being completed, not session activity.
    const planText = "# Plan\n\n## Intent Restatement\nDo the thing.\n\n## Breadth\nXS.";
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: { ...PROMPT_A, result: null, status: "completed" },
          events: [{ type: "text", id: "plan-done", text: planText, promptId: "p-1" }],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.querySelector('[data-plan-card="true"]')).not.toBeNull();

    await rendered.unmount();
  });

  it("shows a collapsed 'Planning…' card while the plan is still streaming", async () => {
    const planText = "# Plan\n\n## Breadth\nXS.";
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: { ...PROMPT_A, result: null, status: "processing" },
          // The last text event of an active turn is the streaming one.
          events: [{ type: "text", id: "plan-stream", text: planText, promptId: "p-1" }],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Collapsed from the first token (no expand→collapse flip): a card, showing a
    // generating state, with the body hidden.
    const card = rendered.container.querySelector('[data-plan-card="true"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Planning");
    expect(card?.textContent).not.toContain("Download");

    await rendered.unmount();
  });

  it("renders customer activity instead of raw read, grep, and glob tool calls", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "read-1",
              tool: "read",
              summary: "read apps/ui/src/Layout.tsx",
              input: { file_path: "apps/ui/src/Layout.tsx" },
              promptId: "p-1",
            },
            {
              type: "tool_call",
              id: "grep-1",
              tool: "grep",
              summary: "grep SessionDetail",
              input: { pattern: "SessionDetail" },
              promptId: "p-1",
            },
            {
              type: "tool_call",
              id: "glob-1",
              tool: "glob",
              summary: "glob **/*.tsx",
              input: { pattern: "**/*.tsx" },
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // The run renders folded by default: the header carries the friendly tally
    // (proving read/grep/glob were recognized) while the rows stay hidden.
    expect(rendered.container.textContent).toContain("Read 1 file · Searched 2 places");
    expect(rendered.container.textContent).not.toContain("Inspected code");
    expect(rendered.container.textContent).not.toContain("apps/ui/src/Layout.tsx");

    const toggle = rendered.container.querySelector("[data-tool-run-summary='true']");
    if (!toggle) throw new Error("expected tool-run toggle");

    // Clicking the header expands the run so the rows show their targets inline.
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("apps/ui/src/Layout.tsx");
    expect(rendered.container.textContent).toContain("SessionDetail");
    expect(rendered.container.textContent).toContain("**/*.tsx");

    // Clicking again folds the run back to its one-line tally.
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("Read 1 file · Searched 2 places");
    expect(rendered.container.textContent).not.toContain("apps/ui/src/Layout.tsx");

    await rendered.unmount();
  });

  it("renders split text stream segments with unique keys", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rendered: Awaited<ReturnType<typeof renderWithRoot>> | undefined;

    try {
      rendered = await renderWithRoot((root) => {
        root.render(
          createElement(Transcript, {
            prompt: PROMPT_A,
            events: [
              { type: "text", id: "stream-1", streamId: "stream-1", text: "before" },
              { type: "tool_call", id: "tool-1", tool: "Read", summary: "Read file" },
              { type: "text", id: "stream-1#1", streamId: "stream-1", text: "after" },
            ],
            isActive: false,
            showProgressIndicator: false,
            onAnswerQuestion: ANSWER_QUESTION,
            hideAvatar: false,
          }),
        );
      });

      expect(rendered.container.textContent).toContain("before");
      expect(rendered.container.textContent).toContain("after");
      expect(
        consoleError.mock.calls.some((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes("Encountered two children with the same key")),
        ),
      ).toBe(false);
    } finally {
      await rendered?.unmount();
      consoleError.mockRestore();
    }
  });

  it("collapses tool activity into a single block before assistant text", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "bash-1",
              tool: "Bash",
              summary: "Bash inspect transcript rendering",
              input: { command: 'rg "tool_run_group" apps/ui/src', prompt: "Inspect transcript rendering" },
            },
            { type: "text", id: "reply-1", text: "Recovered assistant reply" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Folded by default: the tally and the assistant reply are visible; the row
    // summary stays hidden until the group is expanded.
    expect(rendered.container.textContent).toContain("Ran 1 command");
    expect(rendered.container.textContent).toContain("Recovered assistant reply");
    expect(rendered.container.textContent).not.toContain("inspect transcript rendering");
    expect(
      rendered.container.querySelector('[data-message-bubble="true"][data-role="assistant"]')?.textContent,
    ).toContain("Recovered assistant reply");
    expect(rendered.container.querySelector("[data-tool-run-summary='true']")?.className).toContain("items-center");

    // Expand the group to reveal the row summary (input still hidden).
    const groupToggle = rendered.container.querySelector("[data-tool-run-summary='true']");
    if (!groupToggle) throw new Error("expected tool-run toggle");
    await act(async () => {
      groupToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("inspect transcript rendering");
    expect(rendered.container.textContent).not.toContain('rg "tool_run_group" apps/ui/src');

    // Expand the individual command row to reveal its input.
    const buttons = rendered.container.querySelectorAll("button");
    const rowToggle = buttons.item(1);
    if (!rowToggle) throw new Error("expected tool row toggle");

    await act(async () => {
      rowToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("command:");
    expect(rendered.container.textContent).toContain('rg "tool_run_group" apps/ui/src');

    await rendered.unmount();
  });

  it("shows a live ticker for the active trailing tool group", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "bash-1",
              tool: "Bash",
              summary: "Bash inspect transcript rendering",
              input: { command: "git status --short" },
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Running 1 command…");
    expect(rendered.container.textContent).toContain("git status --short");
    expect(rendered.container.textContent?.match(/git status --short/g)).toHaveLength(2);
    expect(rendered.container.querySelector(".animate-spin")).not.toBeNull();

    await rendered.unmount();
  });

  it("does not pin a forced-open active tool group after the prompt settles", async () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "bash-1",
        tool: "Bash",
        summary: "Bash inspect transcript rendering",
        input: { command: "git status --short" },
      },
    ];
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events,
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });
    // While active, the trailing run is pinned open: clicking the header is a
    // no-op, so its rows stay visible.
    const activeToggle = rendered.container.querySelector("[data-tool-run-summary='true']");
    if (!activeToggle) throw new Error("expected active tool-run toggle");

    await act(async () => {
      activeToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("git status --short");

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events,
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Settling releases the pin: the run folds to its tally and can now be expanded.
    expect(rendered.container.textContent).toContain("Ran 1 command");
    expect(rendered.container.textContent).not.toContain("git status --short");

    const settledToggle = rendered.container.querySelector("[data-tool-run-summary='true']");
    if (!settledToggle) throw new Error("expected settled tool-run toggle");

    await act(async () => {
      settledToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("Ran 1 command");
    expect(rendered.container.textContent).toContain("git status --short");

    await rendered.unmount();
  });

  it("renders a settled trailing tool group folded without a spinner", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "bash-1",
              tool: "Bash",
              summary: "Bash inspect transcript rendering",
              input: { command: "git status --short" },
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Settled runs fold to their tally line (no command rows), with no live spinner.
    expect(rendered.container.textContent).toContain("Ran 1 command");
    expect(rendered.container.textContent).not.toContain("git status --short");
    expect(rendered.container.querySelector(".animate-spin")).toBeNull();

    await rendered.unmount();
  });

  it("windows huge inactive transcripts and expands on demand", async () => {
    const events: ActivityEvent[] = Array.from({ length: 500 }, (_, index) => ({
      type: "text",
      id: `text-${index}`,
      text: `assistant message ${index}`,
    }));
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events,
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("assistant message 0");
    expect(rendered.container.textContent).toContain("assistant message 259");
    expect(rendered.container.textContent).not.toContain("assistant message 400");
    expect(rendered.container.textContent).toContain("Show 240 more");

    const showMore = [...rendered.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 240 more"),
    );
    if (!showMore) throw new Error("expected transcript show-more button");

    await act(async () => {
      showMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("assistant message 400");

    await rendered.unmount();
  });

  it("keeps the active transcript tail mounted when windowing", async () => {
    const events: ActivityEvent[] = Array.from({ length: 500 }, (_, index) => ({
      type: "text",
      id: `text-${index}`,
      text: `stream item ${index}`,
    }));
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events,
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("stream item 0");
    expect(rendered.container.textContent).toContain("stream item 499");
    expect(rendered.container.textContent).not.toContain("stream item 250");
    expect(rendered.container.textContent).toContain("middle transcript items hidden while the prompt is active");

    await rendered.unmount();
  });

  it("renders large opened tool groups incrementally", async () => {
    const toolEvents: ActivityEvent[] = Array.from({ length: 300 }, (_, index) => ({
      type: "tool_call",
      id: `tool-${index}`,
      tool: "Bash",
      summary: `command-${index}`,
      input: { command: `echo ${index}` },
    }));
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [...toolEvents, { type: "text", id: "reply-1", text: "done" }],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Expand the folded run; only the first page of commands renders.
    const groupToggle = rendered.container.querySelector("[data-tool-run-summary='true']");
    if (!groupToggle) throw new Error("expected tool-run toggle");
    await act(async () => {
      groupToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("echo 119");
    expect(rendered.container.textContent).not.toContain("echo 200");
    expect(rendered.container.textContent).toContain("Show 120 more");

    const showMore = [...rendered.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 120 more"),
    );
    if (!showMore) throw new Error("expected tool-event show-more button");
    await act(async () => {
      showMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.textContent).toContain("echo 200");

    await rendered.unmount();
  });

  it("keeps patch activity visible outside tool groups", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            { type: "patch", id: "patch-1", files: ["apps/ui/src/components/Transcript.tsx"] },
            { type: "text", id: "reply-1", text: "Recovered assistant reply" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Patch activity renders standalone (outside any tool-run group), its kind
    // carried by the row glyph rather than a text label.
    expect(rendered.container.querySelector('[title="patch"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain("apps/ui/src/components/Transcript.tsx");
    expect(rendered.container.textContent).toContain("Recovered assistant reply");
    expect(rendered.container.textContent).not.toContain("Ran tool activity");
    expect(rendered.container.textContent).not.toContain("Ran 1 command");

    await rendered.unmount();
  });

  it("renders fallback and error labels for grouped activity", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "customer_activity",
              id: "activity-1",
              category: "command",
              title: "Activity",
              summary: "Activity failed",
              status: "error",
              count: 0,
              details: [],
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Worked through 1 step");
    expect(rendered.container.textContent).toContain("Error");
    expect(rendered.container.textContent).not.toContain("Ran tool activity");
    expect(rendered.container.textContent).not.toContain("Worked through 0 steps");

    await rendered.unmount();
  });

  it("renders typed session error labels", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [{ type: "session_error", id: "err-1", error: "bridge stopped", code: "sandbox_terminated" }],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Sandbox terminated: bridge stopped");

    await rendered.unmount();
  });

  it("renders workspace setup delay as terminal agent progress", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_progress",
              id: "ap-1",
              step: "workspace_setup_delayed",
              label: "Workspace setup delayed",
              terminal: true,
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Workspace setup delayed");
    expect(rendered.container.querySelector(".animate-pulse")).toBeNull();

    await rendered.unmount();
  });

  it("renders trailing agent progress group as one live spinner row", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: { ...PROMPT_A, result: null, status: "processing" },
          events: [
            {
              type: "agent_progress",
              id: "ap-1",
              step: "starting_agent",
              label: "Starting agent",
              terminal: false,
              promptId: "p-1",
            },
            {
              type: "prompt_activity",
              id: "pa-1",
              phase: "waiting_for_agent_event",
              detail: "draining",
              promptId: "p-1",
            },
            {
              type: "agent_progress",
              id: "ap-2",
              step: "waiting_for_model",
              label: "Waiting for model",
              terminal: false,
              promptId: "p-1",
            },
            {
              type: "agent_progress",
              id: "ap-3",
              step: "thinking",
              label: "Thinking",
              terminal: false,
              promptId: "p-1",
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Thinking");
    expect(rendered.container.textContent).not.toContain("Waiting for model");
    expect(rendered.container.textContent).not.toContain("Starting agent");
    expect(rendered.container.querySelector(".animate-spin")).not.toBeNull();

    await rendered.unmount();
  });

  it("drops a superseded agent progress group once the turn produces output", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_progress",
              id: "ap-1",
              step: "starting_agent",
              label: "Starting agent",
              terminal: false,
              promptId: "p-1",
            },
            {
              type: "agent_progress",
              id: "ap-2",
              step: "waiting_for_model",
              label: "Waiting for model",
              terminal: false,
              promptId: "p-1",
            },
            { type: "text", id: "text-1", text: "Done" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    // Turn moved past the progress group (the "Done" text follows it), so the
    // stale row is dropped entirely rather than persisting as a muted line.
    expect(rendered.container.textContent).toContain("Done");
    expect(rendered.container.textContent).not.toContain("Waiting for model");
    expect(rendered.container.textContent).not.toContain("Starting agent");
    expect(rendered.container.querySelector(".animate-spin")).toBeNull();

    await rendered.unmount();
  });

  it("renders terminal trailing agent progress group as settled while active", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: { ...PROMPT_A, result: null, status: "processing" },
          events: [
            {
              type: "agent_progress",
              id: "ap-1",
              step: "preparing_workspace",
              label: "Preparing workspace",
              terminal: false,
              promptId: "p-1",
            },
            {
              type: "agent_progress",
              id: "ap-2",
              step: "workspace_ready",
              label: "Workspace ready",
              terminal: true,
              promptId: "p-1",
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Workspace ready");
    expect(rendered.container.querySelector(".animate-spin")).toBeNull();
    expect(rendered.container.querySelector(".text-text-muted")?.textContent).toContain("Workspace ready");

    await rendered.unmount();
  });

  it("renders workspace setup failure as terminal error agent progress", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_progress",
              id: "ap-1",
              step: "workspace_setup_failed",
              label: "Workspace setup failed",
              terminal: true,
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Workspace setup failed");
    expect(rendered.container.querySelector(".text-error")).not.toBeNull();

    await rendered.unmount();
  });

  it("does not render internal prompt activity events", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "prompt_activity",
              id: "pa-1",
              phase: "waiting_for_agent_event",
              detail: "draining",
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("codex");
    expect(rendered.container.textContent).not.toContain("draining");

    await rendered.unmount();
  });

  it("renders raw runtime events only in support view", async () => {
    const rawEvent: ActivityEvent = {
      type: "raw_agent_runtime",
      id: "raw-1",
      eventType: "debug",
      partType: "delta",
      data: { secretShape: "support-only" },
    };
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            { type: "text", id: "reply-1", text: "Before runtime detail" },
            rawEvent,
            { type: "text", id: "reply-2", text: "After runtime detail" },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("raw event");

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            { type: "text", id: "reply-1", text: "Before runtime detail" },
            rawEvent,
            { type: "text", id: "reply-2", text: "After runtime detail" },
          ],
          isActive: false,
          showProgressIndicator: false,
          supportView: true,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const transcriptText = rendered.container.textContent ?? "";
    expect(transcriptText).toContain("raw event");
    expect(transcriptText.indexOf("Before runtime detail")).toBeLessThan(transcriptText.indexOf("raw event"));
    expect(transcriptText.indexOf("raw event")).toBeLessThan(transcriptText.indexOf("After runtime detail"));

    await rendered.unmount();
  });

  it("renders completed tool summaries with inline markdown and keeps active summaries plain", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "tool-complete",
              tool: "agent",
              summary: "agent Opened [logs](https://example.com/logs) and checked `npm test`.",
              status: "completed",
            },
            {
              type: "tool_call",
              id: "tool-active",
              tool: "agent",
              summary: "agent Streaming [docs](https://example.com/docs) now.",
              status: "started",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.querySelector('[data-markdown-variant="inline"]')?.textContent).toContain(
      "Opened [logs](https://example.com/logs) and checked `npm test`.",
    );

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "tool-active",
              tool: "agent",
              summary: "agent Streaming [docs](https://example.com/docs) now.",
              status: "started",
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.querySelector('[data-markdown-variant="inline"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Streaming [docs](https://example.com/docs) now.");

    await rendered.unmount();
  });

  it("keeps expandable tool summaries plain so links are not nested in buttons", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "tool_call",
              id: "tool-expandable",
              tool: "agent",
              summary: "agent Opened [logs](https://example.com/logs) and checked `npm test`.",
              input: { prompt: "inspect logs" },
              status: "completed",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const toggle = rendered.container.querySelector("button");
    expect(toggle?.textContent).toContain("Opened [logs](https://example.com/logs) and checked `npm test`.");
    expect(toggle?.querySelector('[data-markdown-variant="inline"]')).toBeNull();
    expect(toggle?.querySelector("a")).toBeNull();

    await rendered.unmount();
  });

  it("keeps memory transcript rows hidden while memory visuals are disabled", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "memory_usage",
              id: "mem-1",
              activeMemoryIds: ["mem-a", "mem-b"],
              activeMemories: [
                { id: "mem-a", title: "Detailed memory A" },
                { id: "mem-b", title: "Detailed memory B" },
              ],
            },
            {
              type: "memory_recall_usage",
              id: "mrec-1",
              eventName: "memory_recall.returned",
              requestedMemoryIds: ["mem-c"],
              returnedMemoryIds: ["mem-c"],
              requestedMemories: [{ id: "mem-c" }],
              returnedMemories: [{ id: "mem-c", title: "Detailed memory C" }],
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("2 memories applied");
    expect(rendered.container.textContent).not.toContain("1 memory recalled");
    expect(rendered.container.textContent).not.toContain("Detailed memory A");
    expect(rendered.container.textContent).not.toContain("Detailed memory C");
    expect(rendered.container.querySelector<HTMLAnchorElement>("a[href*='.cycloid/memory']")).toBeNull();

    await rendered.unmount();
  });

  it("hides zero-result memory recall events", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "memory_recall_usage",
              id: "mrec-empty",
              eventName: "memory_recall.returned",
              requestedMemoryIds: ["mem-x", "mem-y"],
              returnedMemoryIds: [],
              requestedMemories: [{ id: "mem-x" }, { id: "mem-y" }],
              returnedMemories: [],
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).not.toContain("Recall returned 0 memories");

    await rendered.unmount();
  });

  it("groups post-execution timeline rows into a collapsible panel", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_timeline",
              id: "atl-1",
              eventType: "git.push",
              source: "observed",
              observer: "bridge",
              status: "started",
              summary: "Started pushing the session branch to origin.",
              promptId: "p-1",
            },
            {
              type: "agent_timeline",
              id: "atl-2",
              eventType: "git.push",
              source: "observed",
              observer: "bridge",
              status: "completed",
              summary: "Pushed the session branch to origin.",
              promptId: "p-1",
            },
            {
              type: "agent_timeline",
              id: "atl-3",
              eventType: "verification.result",
              source: "observed",
              observer: "bridge",
              status: "started",
              summary: "Running configured pre-publish test before opening the pull request.",
              metadata: { gate: "tests", command: "npm test" },
              promptId: "p-1",
            },
            {
              type: "agent_timeline",
              id: "atl-4",
              eventType: "publish_gate.result",
              source: "observed",
              observer: "bridge",
              status: "completed",
              summary: "Configured pre-publish test passed.",
              metadata: { gate: "tests", command: "npm test" },
              promptId: "p-1",
            },
            {
              type: "agent_timeline",
              id: "atl-5",
              eventType: "pr.open",
              source: "observed",
              observer: "control_plane",
              status: "completed",
              summary: "Opened pull request.",
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Publish");
    expect(rendered.container.textContent).toContain("PR opened");
    expect(
      Array.from(rendered.container.querySelectorAll("span")).find((element) => element.textContent === "PR opened")
        ?.classList,
    ).not.toContain("review-loop-settle");
    expect(rendered.container.textContent).not.toContain("verification.result started");
    expect(rendered.container.textContent).not.toContain("observed");
    expect(rendered.container.textContent).not.toContain("Branch push");

    const toggle = rendered.container.querySelector<HTMLButtonElement>("button");
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(rendered.container.textContent).not.toContain("Branch push");
    expect(rendered.container.textContent).not.toContain("Pre-publish gate");
    expect(rendered.container.textContent).not.toContain("PR publish");
    expect(rendered.container.textContent).toContain("npm test");

    await rendered.unmount();
  });

  it("keeps the post-execution panel open as new timeline events arrive", async () => {
    const baseEvents = [
      {
        type: "agent_timeline",
        id: "atl-1",
        eventType: "git.push",
        source: "observed",
        observer: "bridge",
        status: "started",
        summary: "Started pushing the session branch to origin.",
        promptId: "p-1",
      },
    ] as const;
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [...baseEvents],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const toggle = rendered.container.querySelector<HTMLButtonElement>("button");
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rendered.container.textContent).toContain("Publish");
    expect(rendered.container.textContent).toContain("Running");
    expect(rendered.container.textContent).not.toContain("Branch push");

    await rendered.rerender((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            ...baseEvents,
            {
              type: "agent_timeline",
              id: "atl-2",
              eventType: "git.push",
              source: "observed",
              observer: "bridge",
              status: "completed",
              summary: "Pushed the session branch to origin.",
              promptId: "p-1",
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("No PR");
    expect(rendered.container.textContent).not.toContain("Branch push");

    await rendered.unmount();
  });

  it("renders terminal verification summaries when no PR event exists", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_timeline",
              id: "atl-verify",
              eventType: "verification.result",
              source: "observed",
              observer: "bridge",
              status: "failed",
              summary: "QA verification result was inconclusive.",
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Publish");
    expect(rendered.container.textContent).toContain("Blocked");
    expect(rendered.container.textContent).not.toContain("No PR");
    expect(rendered.container.textContent).not.toContain("QA verification result was inconclusive.");

    const toggle = rendered.container.querySelector<HTMLButtonElement>("button");
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(rendered.container.textContent).toContain("QA verification result was inconclusive.");
    expect(rendered.container.querySelector('[data-markdown-variant="inline"]')?.textContent).toContain(
      "QA verification result was inconclusive.",
    );

    await rendered.unmount();
  });

  it("uses PR publish metadata to render blocked without parsing the summary", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "agent_timeline",
              id: "atl-pr",
              eventType: "pr.open",
              source: "observed",
              observer: "control_plane",
              status: "failed",
              summary: "GitHub publication stopped.",
              metadata: { reason: "verification failed" },
              promptId: "p-1",
            },
          ],
          isActive: false,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    expect(rendered.container.textContent).toContain("Publish");
    expect(rendered.container.textContent).toContain("Blocked");

    const toggle = rendered.container.querySelector<HTMLButtonElement>("button");
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(rendered.container.textContent).not.toContain("PR publish");
    expect(rendered.container.textContent).not.toContain("blocked");

    await rendered.unmount();
  });

  it("uses explicit Something else as the only free-text option", async () => {
    const rendered = await renderWithRoot((root) => {
      root.render(
        createElement(Transcript, {
          prompt: PROMPT_A,
          events: [
            {
              type: "question",
              id: "q-approval",
              question: "Approve guarded review-loop publish?",
              answer: null,
              options: [
                { label: "Approve", description: "Publish the small diff" },
                { label: "Something else", description: "Give a different instruction" },
              ],
            },
          ],
          isActive: true,
          showProgressIndicator: false,
          onAnswerQuestion: ANSWER_QUESTION,
          hideAvatar: false,
        }),
      );
    });

    const buttons = Array.from(rendered.container.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttons).toEqual(["Approve", "Something else"]);
    expect(rendered.container.textContent).not.toContain("Other…");

    const somethingElse = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Something else",
    );
    expect(somethingElse).toBeTruthy();
    await act(async () => {
      somethingElse!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(rendered.container.querySelector('input[placeholder="Type your answer…"]')).not.toBeNull();
    expect(ANSWER_QUESTION).not.toHaveBeenCalled();

    await rendered.unmount();
  });
});
