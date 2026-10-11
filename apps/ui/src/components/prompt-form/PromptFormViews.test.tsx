import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptForm } from "../PromptForm";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const PAPERCLIP_PATH_START = "M21.44 11.05";

function mount(
  variant: "chat" | "default",
  onSubmit: Parameters<typeof PromptForm>[0]["onSubmit"] = async () => {},
  overrides: Partial<Parameters<typeof PromptForm>[0]> = {},
) {
  act(() => {
    root.render(<PromptForm lifecycle={{ phase: "idle" }} variant={variant} onSubmit={onSubmit} {...overrides} />);
  });
}

function enterPrompt(value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
  if (!textarea) throw new Error("prompt textarea not found");
  act(() => {
    textarea.value = value;
    Simulate.change(textarea);
  });
  return textarea;
}

describe("PromptForm attach button", () => {
  it("chat composer renders a paperclip icon with the attach label", () => {
    mount("chat");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]');
    expect(button).not.toBeNull();
    const path = button?.querySelector("svg path");
    expect(path?.getAttribute("d")?.startsWith(PAPERCLIP_PATH_START)).toBe(true);
  });

  it("default composer renders the same paperclip icon", () => {
    mount("default");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Upload files as context"]');
    expect(button).not.toBeNull();
    const path = button?.querySelector("svg path");
    expect(path?.getAttribute("d")?.startsWith(PAPERCLIP_PATH_START)).toBe(true);
  });
});

describe("PromptForm typography", () => {
  it("uses the smaller prompt size in the homepage chat composer", () => {
    mount("chat", async () => {}, { placeholder: "Describe what you want Cycloid to build…" });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');

    expect(textarea?.classList.contains("text-lg")).toBe(true);
    expect(textarea?.classList.contains("text-xl")).toBe(false);
  });
});

describe("PromptForm plan mode chip", () => {
  it.each([
    { setting: "off" as const, pressed: "false", active: false },
    { setting: "auto" as const, pressed: "mixed", active: true },
    { setting: "on" as const, pressed: "true", active: true },
  ])("renders $setting with tri-state semantics", ({ setting, pressed, active }) => {
    const onTogglePlanMode = vi.fn();
    mount("chat", async () => {}, {
      planModeAvailable: true,
      planMode: setting,
      onTogglePlanMode,
    });

    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Plan mode: ${setting}. Click to cycle."]`,
    );
    expect(button?.textContent).toContain(`Plan: ${setting}`);
    expect(button?.getAttribute("aria-pressed")).toBe(pressed);
    expect(button?.className.includes("aria-[pressed=mixed]:bg-surface-3")).toBe(true);
    expect(button?.className.includes("aria-pressed:border-border-strong")).toBe(true);
    expect(button?.className.includes("aria-pressed:border-border-focus")).toBe(false);
    expect(Boolean(button?.querySelector("svg"))).toBe(active);

    act(() => Simulate.click(button!));
    expect(onTogglePlanMode).toHaveBeenCalledOnce();
  });
});

describe("PromptForm feedback semantics", () => {
  it("marks the form and send action busy while submission is pending", async () => {
    let finishSubmission: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmission = resolve;
        }),
    );
    mount("default", onSubmit);
    enterPrompt("Fix the issue");
    const form = container.querySelector("form");

    await act(async () => {
      Simulate.submit(form!);
      await Promise.resolve();
    });

    expect(form?.getAttribute("aria-busy")).toBe("true");
    // While sending, the label carries the reason ("Send: Sending prompt…")
    // alongside aria-busy — the a11y contract the root prompt-form suite pins.
    expect(container.querySelector('[aria-busy="true"][aria-label="Send: Sending prompt…"]')).not.toBeNull();

    await act(async () => {
      finishSubmission?.();
      await Promise.resolve();
    });
  });

  it("announces submission errors and links them to the prompt field", async () => {
    mount("chat", async () => {
      throw new Error("Request failed");
    });
    const textarea = enterPrompt("Fix the issue");
    const form = container.querySelector("form");

    await act(async () => {
      Simulate.submit(form!);
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Request failed");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe(alert?.id);
  });
});

describe("composer focus treatment", () => {
  it("uses the existing composer border without adding a second focus outline", () => {
    const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

    expect(css).toContain(".command-composer textarea:focus-visible");
    expect(css).toContain("outline: none");
    expect(css).not.toContain(".command-composer:has(textarea:focus-visible)");
    expect(css).not.toContain("box-shadow: 0 0 0 1px var(--color-border-strong)");
    expect(css).not.toContain(".command-composer-accent");
  });
});
