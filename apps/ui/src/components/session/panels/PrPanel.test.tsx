import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail } from "../../../types";
import { deriveQaVerificationChip } from "./ChecksPanel";
import { derivePrState, PrPanel, type PrPanelProps } from "./PrPanel";

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

const PR_URL = "https://github.com/trycycloid/cycloid/pull/123";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-pr-1",
    phase: "completed",
    prUrl: PR_URL,
    createdAt: Date.now(),
    model: { providerID: "anthropic", modelID: "claude-fable-5" },
    title: "Fix the flaky retry test",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
    publishedBranch: "arc/fix-flaky-retry",
    ...overrides,
  } as SessionDetail;
}

function render(session: SessionDetail, overrides: Partial<PrPanelProps> = {}) {
  act(() => {
    root.render(
      <PrPanel
        session={session}
        prError={null}
        qaTestSessionUrl={null}
        canTriggerQaVerification={false}
        qaVerificationLoading={false}
        qaVerificationError={null}
        onViewPr={() => {}}
        readOnly={false}
        {...overrides}
      />,
    );
  });
}

/** Action labels only — branch copy buttons are readouts, not actions. */
function buttonLabels(): string[] {
  return Array.from(container.querySelectorAll("a, button"))
    .filter((el) => !el.getAttribute("aria-label")?.startsWith("Copy branch"))
    .map((el) => el.textContent?.trim() ?? "");
}

describe("derivePrState", () => {
  it("returns null without a PR", () => {
    expect(derivePrState(makeSession({ prUrl: null }))).toBeNull();
  });

  it("maps each lifecycle stage from the FSM projection", () => {
    expect(derivePrState(makeSession({ uiLifecycleStage: "merged" }))).toBe("merged");
    expect(derivePrState(makeSession({ uiLifecycleStage: "closed" }))).toBe("closed");
    expect(derivePrState(makeSession({ uiLifecycleStage: "superseded" }))).toBe("superseded");
    expect(derivePrState(makeSession({ uiLifecycleStage: "merge_ready" }))).toBe("merge_ready");
    expect(derivePrState(makeSession({ uiLifecycleStage: "verifying" }))).toBe("verifying");
  });

  it("prefers the lifecycle stage over draft detection", () => {
    expect(derivePrState(makeSession({ uiLifecycleStage: "merged", prDraft: true }))).toBe("merged");
  });

  it("falls back to closeReason for archived sessions without a stage", () => {
    expect(derivePrState(makeSession({ phase: "archived", closeReason: "pr_merged" }))).toBe("merged");
    expect(derivePrState(makeSession({ phase: "archived", closeReason: "pr_closed" }))).toBe("closed");
  });

  it("detects drafts from prDraft and from the verification publish mode", () => {
    expect(derivePrState(makeSession({ prDraft: true }))).toBe("draft");
    expect(derivePrState(makeSession({ verification: { verified: false, publishMode: "draft" } as never }))).toBe(
      "draft",
    );
  });

  it("defaults to open for a published PR with no other signal", () => {
    expect(derivePrState(makeSession())).toBe("open");
  });
});

describe("PrPanel header", () => {
  it("renders the PR number, state chip, and title", () => {
    render(makeSession());
    expect(container.textContent).toContain("PR #123");
    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("Fix the flaky retry test");
  });

  it("renders the merged state chip from the projection", () => {
    render(makeSession({ uiLifecycleStage: "merged" }));
    expect(container.textContent).toContain("Merged");
  });

  it("renders copyable head and base branches", () => {
    render(makeSession());
    expect(container.querySelector('[aria-label="Copy branch arc/fix-flaky-retry"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Copy branch main"]')).not.toBeNull();
  });

  it("falls back to lastBranch for the head readout", () => {
    render(makeSession({ publishedBranch: null, lastBranch: "arc/wip" }));
    expect(container.querySelector('[aria-label="Copy branch arc/wip"]')).not.toBeNull();
  });

  it("shows the session owner and automation provenance when present", () => {
    render(makeSession({ ownerLogin: "octocat", initiationMode: "automation", ruleNameSnapshot: "Nightly triage" }));
    expect(container.textContent).toContain("Opened as octocat");
    expect(container.textContent).toContain("Automation · Nightly triage");
  });
});

describe("PrPanel actions", () => {
  it("links Open PR to the PR URL and reports the click", () => {
    const onViewPr = vi.fn();
    render(makeSession(), { onViewPr });
    const link = container.querySelector(`a[href="${PR_URL}"]`) as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe("Open PR");
    // Cancel the navigation default so happy-dom does not follow the href;
    // React's synthetic onClick still fires.
    container.addEventListener("click", (event) => event.preventDefault());
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onViewPr).toHaveBeenCalledTimes(1);
  });

  it("labels the action View draft for a draft PR", () => {
    render(makeSession({ prDraft: true }));
    expect(buttonLabels()).toContain("View draft");
  });

  it("shows Verify PR only when the QA trigger is available", () => {
    render(makeSession(), { canTriggerQaVerification: true, onTriggerQaVerification: () => {} });
    expect(buttonLabels()).toContain("Verify PR");
  });

  it("hides Verify PR in read-only view and when a QA test session exists", () => {
    render(makeSession(), { canTriggerQaVerification: true, onTriggerQaVerification: () => {}, readOnly: true });
    expect(buttonLabels()).not.toContain("Verify PR");

    render(makeSession(), {
      canTriggerQaVerification: true,
      onTriggerQaVerification: () => {},
      qaTestSessionUrl: "/sessions/child-1",
    });
    expect(buttonLabels()).not.toContain("Verify PR");
    const qaLink = container.querySelector('a[href="/sessions/child-1"]');
    expect(qaLink?.textContent?.trim()).toBe("View QA test");
  });

  it("renders no merge or review-loop trigger actions (no UI endpoints exist)", () => {
    render(makeSession({ uiLifecycleStage: "merge_ready", reviewLoopDoneState: "done" }));
    const labels = buttonLabels().filter(Boolean);
    expect(labels).toEqual(["Open PR"]);
  });

  it("surfaces the QA verification error", () => {
    render(makeSession(), { qaVerificationError: "QA session failed to start" });
    expect(container.textContent).toContain("QA session failed to start");
  });
});

describe("PrPanel review loop", () => {
  it("renders the review-loop claim when the projection carries one", () => {
    render(makeSession({ reviewLoopDoneState: "working" }));
    expect(container.textContent).toContain("Listening");
    expect(container.textContent).toContain("Watching reviewer comments and CI");
  });

  it("renders the cycloid-done aggregate with needs-attention reasons", () => {
    render(
      makeSession({
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "needs_attention",
        cycloidDoneReasons: ["ci_red"],
      }),
    );
    expect(container.textContent).toContain("Caught up");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("CI failing");
  });

  it("omits the section when no claim reached the client", () => {
    render(makeSession());
    expect(container.textContent).not.toContain("Review loop");
  });
});

describe("deriveQaVerificationChip", () => {
  it("returns null when the QA loop never made a claim", () => {
    expect(deriveQaVerificationChip(makeSession())).toBeNull();
    expect(deriveQaVerificationChip(makeSession({ verificationState: null, verificationResult: null }))).toBeNull();
  });

  it("maps lifecycle states, marking only an in-progress run as live", () => {
    expect(deriveQaVerificationChip(makeSession({ verificationState: "verification-in-progress" }))).toEqual({
      label: "QA running",
      tone: "accent",
    });
    expect(deriveQaVerificationChip(makeSession({ verificationState: "verification-pending" }))).toEqual({
      label: "QA queued",
      tone: "default",
    });
    expect(deriveQaVerificationChip(makeSession({ verificationState: "verification-exhausted" }))).toEqual({
      label: "QA exhausted",
      tone: "default",
    });
  });

  it("surfaces the verdict once the run is done", () => {
    expect(
      deriveQaVerificationChip(
        makeSession({ verificationState: "verification-done", verificationResult: "merge-ready" }),
      ),
    ).toEqual({ label: "QA merge ready", tone: "success" });
    expect(
      deriveQaVerificationChip(
        makeSession({ verificationState: "verification-done", verificationResult: "needs-work" }),
      ),
    ).toEqual({ label: "QA needs work", tone: "warning" });
    // Done without a recorded verdict falls back to the lifecycle label.
    expect(deriveQaVerificationChip(makeSession({ verificationState: "verification-done" }))).toEqual({
      label: "QA done",
      tone: "default",
    });
  });
});

describe("PrPanel without a PR", () => {
  it("renders the session outcome and publish failure instead of the card", () => {
    render(
      makeSession({ prUrl: null, outcome: { state: "publish_blocked", tone: "error", title: "Publish blocked" } }),
      {
        prError: "Branch push rejected",
      },
    );
    expect(container.textContent).toContain("Publish blocked");
    expect(container.textContent).toContain("Branch push rejected");
    expect(buttonLabels()).not.toContain("Open PR");
  });

  it("renders the publish error from the session record", () => {
    render(makeSession({ prUrl: null, publishError: "Publish failed: protected branch" }));
    expect(container.textContent).toContain("Publish failed: protected branch");
  });
});
