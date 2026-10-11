import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  approveSessionPlan: vi.fn(),
  fetchSessionPlan: vi.fn(),
  updateSessionPlan: vi.fn(),
}));

vi.mock("../api/sessions", () => ({
  ...apiMocks,
  SessionPlanConflictError: class SessionPlanConflictError extends Error {
    readonly kind: "stale" | "state";

    constructor(kind: "stale" | "state", message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

import { PLAN_CONTEXT_MAX_CHARS } from "../../../../shared/plan-mode";
import { SessionPlanConflictError } from "../api/sessions";
import { PlanCard } from "./PlanCard";

let container: HTMLDivElement;
let root: Root;

const PLAN = [
  "# Plan",
  "",
  "## Intent Restatement",
  "",
  "Add a download button.",
  "",
  "## Ordered Steps",
  "",
  "1. Update the card.",
  "",
  "## Files To Touch",
  "",
  "- `PlanCard.tsx`",
  "",
].join("\n");

const LATEST_PLAN = {
  status: "pending" as const,
  revision: 2,
  markdown: PLAN,
  userEdited: false,
  updatedAt: "2026-07-09T12:00:00.000Z",
  planPromptId: "p-plan",
  valid: true,
  missingReason: null,
};

const DEFAULT_PROPS: ComponentProps<typeof PlanCard> = {
  content: PLAN,
  generating: false,
  sessionId: "session-1",
  promptId: "p-plan",
  planApprovalPending: true,
  planRevision: 2,
  planStatus: "pending",
  planAutoReason: null,
  planPromptFailed: false,
  onDiscuss: vi.fn(),
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiMocks.approveSessionPlan.mockReset();
  apiMocks.fetchSessionPlan.mockReset();
  apiMocks.updateSessionPlan.mockReset();
  apiMocks.fetchSessionPlan.mockResolvedValue(LATEST_PLAN);
  apiMocks.approveSessionPlan.mockResolvedValue({
    ok: true,
    revision: 2,
    implementationPromptId: "p-implementation",
    idempotent: false,
  });
  apiMocks.updateSessionPlan.mockResolvedValue({
    ok: true,
    planApprovalPending: true,
    revision: 3,
    status: "pending",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(props: Partial<ComponentProps<typeof PlanCard>> = {}) {
  await act(async () => {
    root.render(<PlanCard {...DEFAULT_PROPS} {...props} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findByLabel(label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === label);
}

function findButton(label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PlanCard download button", () => {
  it("downloads the plan markdown with a slugified filename", async () => {
    let blob: Blob | null = null;
    const createObjectURL = vi.fn((value: Blob) => {
      blob = value;
      return "blob:plan";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    let downloadName: string | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    await mount({ planApprovalPending: false, planRevision: null, planStatus: "none" });

    const button = findByLabel("Download plan as Markdown");
    expect(button).toBeTruthy();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(downloadName).toBe("add-a-download-button.md");
    expect(blob).not.toBeNull();
    expect((blob as unknown as Blob).type).toContain("text/markdown");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:plan");
  });

  it("does not leave a trailing dash when the title truncates onto a separator", async () => {
    const longTitle = `${"a".repeat(59)} tail`;
    const plan = ["# Plan", "", "## Intent Restatement", "", `${longTitle}.`, ""].join("\n");
    const createObjectURL = vi.fn(() => "blob:plan");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

    let downloadName: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    await mount({ content: plan, planApprovalPending: false, planRevision: null, planStatus: "none" });
    act(() => {
      findByLabel("Download plan as Markdown")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(downloadName).toBe(`${"a".repeat(59)}.md`);
  });

  it("hides the download button while the plan is still generating", async () => {
    await mount({ generating: true, planApprovalPending: false, planRevision: null, planStatus: "none" });
    expect(findByLabel("Download plan as Markdown")).toBeUndefined();
  });
});

describe("PlanCard approval gate", () => {
  it("renders actions only on the latest card while parked", async () => {
    await mount();
    await flush();

    expect(apiMocks.fetchSessionPlan).toHaveBeenCalledWith("session-1");
    expect(findButton("Accept")).toBeTruthy();
    expect(findButton("Edit")).toBeTruthy();
    expect(findButton("Discuss")).toBeUndefined();
    expect(container.textContent).toContain("rev 2");
  });

  it("renders the Auto classifier reason when present", async () => {
    await mount({ planAutoReason: "The task needs sequencing across files." });
    await flush();

    expect(container.textContent).toContain("Auto chose to plan because: The task needs sequencing across files.");
  });

  it("hides the Auto classifier reason on non-parked cards", async () => {
    await mount({
      planApprovalPending: false,
      planRevision: 2,
      planStatus: "approved",
      planAutoReason: "The task needs sequencing across files.",
    });
    await flush();

    expect(container.textContent).not.toContain("Auto chose to plan because:");
  });

  it("does not render actions for superseded or non-parked cards", async () => {
    await mount({ promptId: "p-superseded" });
    await flush();
    expect(findButton("Accept")).toBeUndefined();

    await mount({ planApprovalPending: false, planRevision: null, planStatus: "approved" });
    await flush();
    expect(findButton("Accept")).toBeUndefined();
    expect(findButton("Edit")).toBeUndefined();
    expect(findButton("Discuss")).toBeUndefined();
  });

  it("shows the persisted edited revision after the plan is approved", async () => {
    const editedPlan = `${PLAN}\nPersisted edit.`;
    apiMocks.fetchSessionPlan.mockResolvedValueOnce({
      ...LATEST_PLAN,
      status: "approved",
      markdown: editedPlan,
      userEdited: true,
    });

    await mount({ planApprovalPending: false, planRevision: 2, planStatus: "approved" });
    await flush();

    expect(apiMocks.fetchSessionPlan).toHaveBeenCalledWith("session-1");
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Persisted edit.");
    expect(container.textContent).toContain("edited · rev 2");
  });

  it("shows optimistic approval progress and then waits for the server-driven transition", async () => {
    let resolveApprove: ((value: unknown) => void) | null = null;
    apiMocks.approveSessionPlan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApprove = resolve;
        }),
    );
    await mount();
    await flush();

    act(() => {
      findButton("Accept")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(findButton("Accepting…")).toBeTruthy();
    expect(apiMocks.approveSessionPlan).toHaveBeenCalledWith("session-1", 2);

    await act(async () => {
      resolveApprove?.({ ok: true, revision: 2, implementationPromptId: "p-implementation", idempotent: false });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Plan accepted. Starting implementation…");

    await mount({ planApprovalPending: false, planStatus: "approved" });
    expect(container.textContent).not.toContain("Plan accepted. Starting implementation…");
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy();
  });

  it("refetches and shows a plan-changed state after a stale approval", async () => {
    apiMocks.fetchSessionPlan
      .mockResolvedValueOnce(LATEST_PLAN)
      .mockResolvedValueOnce({ ...LATEST_PLAN, revision: 3, markdown: `${PLAN}\nUpdated.` });
    apiMocks.approveSessionPlan.mockRejectedValueOnce(
      new SessionPlanConflictError("stale", "Plan revision is stale", undefined),
    );
    await mount();
    await flush();

    await act(async () => {
      findButton("Accept")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(apiMocks.fetchSessionPlan).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Plan changed. Review the latest revision before accepting.");
    expect(findButton("Accept")).toBeUndefined();
  });

  it("disables Accept with the invalid-plan reason while keeping Edit enabled", async () => {
    apiMocks.fetchSessionPlan.mockResolvedValueOnce({
      ...LATEST_PLAN,
      markdown: "# Plan\n\nIncomplete.",
      valid: false,
      missingReason: "invalid_plan",
    });
    await mount();
    await flush();

    expect(findButton("Accept")).toHaveProperty("disabled", true);
    expect(findButton("Edit")).toHaveProperty("disabled", false);
    expect(findButton("Discuss")).toBeUndefined();
    expect(container.textContent).toContain("Accept is unavailable: The plan is missing required sections.");
  });

  it("keeps plan-load errors inside the card", async () => {
    apiMocks.fetchSessionPlan.mockRejectedValueOnce(new Error("Plan lookup failed"));
    await mount();
    await flush();

    expect(container.querySelector('[data-plan-card="true"]')).toBeTruthy();
    expect(findButton("Accept")).toBeUndefined();
  });
});

describe("PlanCard editor", () => {
  it("prefills from GET and cancel restores the saved markdown", async () => {
    await mount();
    await flush();
    act(() => {
      findButton("Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit plan"]');
    expect(textarea?.value).toBe(PLAN);
    act(() => changeTextarea(textarea!, "Changed but not saved"));
    act(() => {
      findButton("Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      findButton("Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit plan"]')?.value).toBe(PLAN);
  });

  it("disables empty saves and shows the 12k injection-cap notice", async () => {
    await mount();
    await flush();
    act(() => {
      findButton("Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit plan"]')!;

    act(() => changeTextarea(textarea, "   "));
    expect(findButton("Save plan")).toHaveProperty("disabled", true);

    act(() => changeTextarea(textarea, "x".repeat(PLAN_CONTEXT_MAX_CHARS + 1)));
    expect(container.textContent).toContain("Only the first 12,000 characters will be included");
    expect(findButton("Save plan")).toHaveProperty("disabled", false);
  });

  it("keeps the editor open after save so a follow-up click cannot immediately accept", async () => {
    await mount();
    await flush();
    act(() => {
      findButton("Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit plan"]')!;
    const edited = `${PLAN}\nOne more detail.`;
    act(() => changeTextarea(textarea, edited));

    await act(async () => {
      findButton("Save plan")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.updateSessionPlan).toHaveBeenCalledWith("session-1", 2, edited);
    expect(container.textContent).toContain("edited · rev 3");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit plan"]')?.value).toBe(edited);
    expect(findButton("Saved")).toHaveProperty("disabled", true);
    expect(findButton("Done")).toBeTruthy();
    expect(findButton("Accept")).toBeUndefined();
    expect(apiMocks.approveSessionPlan).not.toHaveBeenCalled();

    act(() => {
      findButton("Done")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('textarea[aria-label="Edit plan"]')).toBeNull();
    expect(findButton("Accept")).toBeTruthy();
  });
});
