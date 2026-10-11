import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptForm, type PromptFormHandle, type PromptFormProps } from "./PromptForm";

let container: HTMLDivElement;
let root: Root;

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPromptForm(props: Partial<PromptFormProps> = {}, ref?: React.Ref<PromptFormHandle>) {
  await act(async () => {
    root.render(
      <PromptForm
        ref={ref}
        lifecycle={{ phase: "idle" }}
        onSubmit={vi.fn()}
        initialValue="Build the feature"
        {...props}
      />,
    );
    await flushAsyncWork();
  });
}

function planModeButton() {
  return container.querySelector<HTMLButtonElement>('button[aria-label^="Plan mode:"]');
}

async function submitForm() {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    Simulate.submit(form!);
    await flushAsyncWork();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("PromptForm plan mode", () => {
  it.each(["default", "chat"] as const)("hides the chip without the capability in the %s variant", async (variant) => {
    await renderPromptForm({ planMode: "on", planModeAvailable: false, variant });

    expect(planModeButton()).toBeNull();
    expect(container.textContent).not.toContain("Plan mode");
  });

  it.each([
    ["off", "Plan: off", "false"],
    ["auto", "Plan: auto", "mixed"],
    ["on", "Plan: on", "true"],
  ] as const)("renders the %s state with its visible and accessible labels", async (planMode, label, ariaPressed) => {
    const onTogglePlanMode = vi.fn();
    await renderPromptForm({ planMode, planModeAvailable: true, onTogglePlanMode });

    expect(planModeButton()?.textContent).toBe(label);
    expect(planModeButton()?.getAttribute("aria-pressed")).toBe(ariaPressed);
    expect(planModeButton()?.getAttribute("aria-label")).toBe(`Plan mode: ${planMode}. Click to cycle.`);
  });

  it("invokes the toggle callback when the chip is clicked", async () => {
    const onTogglePlanMode = vi.fn();
    await renderPromptForm({ planMode: "off", planModeAvailable: true, onTogglePlanMode });

    act(() => {
      Simulate.click(planModeButton()!);
    });

    expect(onTogglePlanMode).toHaveBeenCalledOnce();
  });

  it("includes planMode in the submit payload when the capability is available", async () => {
    const onSubmit = vi.fn();
    await renderPromptForm({ onSubmit, planMode: "auto", planModeAvailable: true });

    await submitForm();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Build the feature", planMode: "auto" }));
  });

  it("omits planMode from the submit payload when the capability is unavailable", async () => {
    const onSubmit = vi.fn();
    await renderPromptForm({ onSubmit, planMode: "on", planModeAvailable: false });

    await submitForm();

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].planMode).toBeUndefined();
  });
});

describe("PromptForm direct prompt submission", () => {
  it("uses the current reasoning effort and plan mode", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptFormHandle>();
    await renderPromptForm(
      {
        onSubmit,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        planMode: "auto",
        planModeAvailable: true,
      },
      ref,
    );

    const reasoningButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Thinking:"]');
    expect(reasoningButton).not.toBeNull();
    act(() => Simulate.click(reasoningButton!));

    await act(async () => {
      await ref.current?.submitPrompt("Fix a small bug");
    });

    expect(onSubmit).toHaveBeenCalledWith({ prompt: "Fix a small bug", reasoningEffort: "high", planMode: "auto" });
  });

  it("guards direct prompts from concurrent double submission", async () => {
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const ref = createRef<PromptFormHandle>();
    await renderPromptForm({ onSubmit }, ref);

    let firstSubmit: Promise<void> | undefined;
    let secondSubmit: Promise<void> | undefined;
    await act(async () => {
      firstSubmit = ref.current?.submitPrompt("Fix a small bug");
      secondSubmit = ref.current?.submitPrompt("Fix a small bug");
      await flushAsyncWork();
    });

    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSubmit?.();
      await Promise.all([firstSubmit, secondSubmit]);
    });
  });
});
