import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail } from "../../../types";
import { ToastProvider } from "../../Toast";
import type { ArtifactTabId } from "../workbench";
import { SummaryPanel } from "./SummaryPanel";

vi.mock("../../../api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions")>()),
  retrySession: vi.fn(async () => undefined),
}));

import { retrySession } from "../../../api/sessions";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-summary-1",
    phase: "running",
    prUrl: null,
    createdAt: Date.now(),
    model: { providerID: "anthropic", modelID: "claude-fable-5" },
    title: "Test session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  } as SessionDetail;
}

type RenderExtra = {
  requestText?: string | null;
  finalMessage?: string | null;
  onSelectTab?: (id: ArtifactTabId) => void;
  onViewPr?: () => void;
  hydrated?: boolean;
};

function render(session: SessionDetail, extra: RenderExtra = {}) {
  act(() => {
    root.render(
      <ToastProvider>
        <SummaryPanel
          session={session}
          hydrated={extra.hydrated ?? true}
          promptCount={1}
          onSelectTab={extra.onSelectTab}
          onViewPr={extra.onViewPr}
        />
      </ToastProvider>,
    );
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === label);
}

describe("SummaryPanel status and text cards", () => {
  it("renders the stage timeline without a duplicate status chip", () => {
    render(makeSession({ phase: "running" }));
    // The header chip and runtime strip own the status text; the summary
    // renders only the stage timeline (no chip element), and the stage labels
    // share the chip vocabulary — "Working", not "Building".
    expect(container.querySelector(".status-pill")).toBeNull();
    const steps = Array.from(container.querySelectorAll("li")).map((el) => el.textContent?.trim());
    expect(steps).toContain("Working");
    expect(steps).not.toContain("Building");
    expect(container.querySelector('[aria-current="step"]')).not.toBeNull();
  });

  it("keeps request and answer prose out of the summary", () => {
    render(makeSession(), { requestText: "Fix the flaky retry test" });
    render(makeSession(), { finalMessage: "Merged the fix with 12 tests passing." });
    expect(container.textContent).not.toContain("Fix the flaky retry test");
    expect(container.textContent).not.toContain("Merged the fix with 12 tests passing.");
    expect(container.textContent).not.toContain("Latest answer");
  });
});

describe("SummaryPanel next action", () => {
  it("switches to the runtime tab while working", () => {
    const onSelectTab = vi.fn();
    render(makeSession({ phase: "running" }), { onSelectTab });
    const button = findButton("Inspect runtime");
    expect(button).toBeDefined();
    act(() => button?.click());
    expect(onSelectTab).toHaveBeenCalledWith("runtime");
  });

  it("focuses the composer when the agent is waiting for an answer", () => {
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "Prompt");
    document.body.appendChild(textarea);
    try {
      render(makeSession({ phase: "waiting_for_input" }));
      const button = findButton("Answer agent");
      expect(button).toBeDefined();
      act(() => button?.click());
      expect(document.activeElement).toBe(textarea);
    } finally {
      textarea.remove();
    }
  });

  it("offers Retry with the failure detail when the session failed", async () => {
    render(makeSession({ phase: "failed", publishError: "push rejected" } as Partial<SessionDetail>));
    expect(container.textContent).toContain("Session stopped on a failure.");
    expect(container.textContent).toContain("push rejected");
    const button = findButton("Retry");
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(retrySession).toHaveBeenCalledWith("s-summary-1");
    expect(container.textContent).toContain("Retrying last prompt");
  });

  it("disables the Retry button and surfaces the error toast when retry rejects", async () => {
    vi.mocked(retrySession).mockImplementationOnce(async () => {
      throw new Error("session_not_retryable");
    });
    render(makeSession({ phase: "failed", closeReason: "sandbox lost" } as Partial<SessionDetail>));
    const button = findButton("Retry");
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(retrySession).toHaveBeenCalledWith("s-summary-1");
    // Failure surfaced as a toast; the button re-enables for another attempt.
    expect(container.textContent).toContain("session_not_retryable");
    expect(findButton("Retry")?.disabled).toBe(false);
  });

  it("keeps the runtime fallback when the phase is not retryable", () => {
    const onSelectTab = vi.fn();
    render(
      makeSession({
        phase: "finalizing",
        displayStatus: "failed",
        publishError: "publish failed",
      } as Partial<SessionDetail>),
      { onSelectTab },
    );
    expect(container.textContent).toContain("publish failed");
    expect(findButton("Retry")).toBeUndefined();
    const button = findButton("Inspect runtime");
    expect(button).toBeDefined();
    act(() => button?.click());
    expect(onSelectTab).toHaveBeenCalledWith("runtime");
  });

  it("links to the PR when the session is done and the PR is open", () => {
    const onViewPr = vi.fn();
    render(makeSession({ phase: "completed", prUrl: "https://github.com/trycycloid/cycloid/pull/12" }), {
      onViewPr,
    });
    const link = Array.from(container.querySelectorAll("a")).find((el) => el.textContent?.trim() === "Open PR");
    expect(link?.getAttribute("href")).toBe("https://github.com/trycycloid/cycloid/pull/12");
    // Block the browser navigation so the DOM environment does not fetch GitHub.
    link?.addEventListener("click", (event) => event.preventDefault());
    act(() => link?.click());
    expect(onViewPr).toHaveBeenCalled();
  });

  it("renders no next action once the PR is merged", () => {
    render(
      makeSession({
        phase: "completed",
        uiLifecycleStage: "merged",
        prUrl: "https://github.com/trycycloid/cycloid/pull/12",
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).not.toContain("Next action");
  });

  it("renders no next action before hydration", () => {
    render(makeSession({ phase: "running" }), { hydrated: false });
    expect(container.textContent).not.toContain("Next action");
  });
});

describe("SummaryPanel PR handoff", () => {
  it("keeps PR details in the PR tab while preserving the review action", () => {
    render(
      makeSession({
        phase: "completed",
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        publishedBranch: "arc/fix-retry",
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).not.toContain("PR #123");
    expect(container.querySelector('[aria-label="Copy branch main"]')).toBeNull();
    const review = Array.from(container.querySelectorAll("a")).find((el) => el.textContent?.trim() === "Open PR");
    expect(review?.getAttribute("href")).toBe("https://github.com/trycycloid/cycloid/pull/123");
  });

  it("carries merge-ready through the next action without duplicating review-loop detail", () => {
    render(
      makeSession({
        phase: "review_listening",
        prUrl: "https://github.com/trycycloid/cycloid/pull/9",
        uiLifecycleStage: "merge_ready",
        reviewLoopDoneState: "done",
      } as Partial<SessionDetail>),
    );
    // The status chip lives in the header; the summary reflects merge-ready
    // through the next-action copy only.
    expect(container.textContent).toContain("Review loop caught up and checks passed.");
    expect(container.textContent).not.toContain("Merge ready");
    expect(container.textContent).not.toContain("Review loop done");
    expect(container.textContent).not.toContain("Verified");
  });

  it("omits the PR preview without a PR", () => {
    render(makeSession({ prUrl: null }));
    expect(container.textContent).not.toContain("Pull request");
  });
});

describe("SummaryPanel context card", () => {
  it("renders repo, branch, owner, and source without model/provider rows", () => {
    render(
      makeSession({
        startBranch: "main",
        ownerLogin: "josiah",
        initiationMode: "user",
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).toContain("trycycloid/cycloid");
    // Model/provider live in the header and runtime strip, not the summary.
    expect(container.textContent).not.toContain("claude-fable-5");
    expect(container.textContent).not.toContain("anthropic");
    expect(container.textContent).toContain("josiah");
    expect(container.textContent).toContain("You");
  });

  it("labels scheduled sessions with the rule name", () => {
    render(
      makeSession({
        initiationMode: "automation",
        ruleNameSnapshot: "Nightly triage",
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).toContain("Scheduled");
    expect(container.textContent).toContain("Nightly triage");
  });

  it("keeps context-token readouts out of the summary (strip + Runtime own them)", () => {
    render(makeSession());
    expect(container.textContent).not.toContain("tokens ·");
    expect(container.textContent).not.toContain("of window");
  });
});
