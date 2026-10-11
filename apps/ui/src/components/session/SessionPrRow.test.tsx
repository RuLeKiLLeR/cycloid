import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionDetail } from "../../types";
import { SessionPrRow } from "./SessionPrRow";

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

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-pr-row",
    phase: "completed",
    prUrl: "https://github.com/trycycloid/cycloid/pull/1346",
    createdAt: Date.now(),
    title: "Test session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  } as SessionDetail;
}

function render(session: SessionDetail, prError: string | null = null) {
  act(() => {
    root.render(<SessionPrRow session={session} prError={prError} />);
  });
}

describe("SessionPrRow", () => {
  it("renders one compact row with the PR state chip and an external PR-number link", () => {
    render(makeSession());
    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("PR #1346");
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://github.com/trycycloid/cycloid/pull/1346");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    // QA verify actions still live on the PR tab, not the thread row.
    expect(container.textContent).not.toContain("Verify");
    expect(container.textContent).not.toContain("View QA");
  });

  it("reflects the FSM lifecycle stage in the state chip", () => {
    render(makeSession({ uiLifecycleStage: "merged" } as Partial<SessionDetail>));
    expect(container.textContent).toContain("Merged");
  });

  it("labels drafts through the shared draft detection", () => {
    render(makeSession({ prDraft: true } as Partial<SessionDetail>));
    expect(container.textContent).toContain("Draft");
  });

  it("renders nothing without a PR, outcome, or publish failure", () => {
    render(makeSession({ prUrl: null }));
    expect(container.firstChild).toBeNull();
  });

  it("does not render a row for unsafe PR URLs", () => {
    render(makeSession({ prUrl: "javascript:alert(1)" }));
    expect(container.textContent).not.toContain("PR #");
  });

  it("surfaces a clean no-change outcome with non-error styling", () => {
    render(
      makeSession({
        prUrl: null,
        outcome: {
          state: "no_changes",
          tone: "info",
          title: "Completed without code changes - no PR created.",
          detail: "- Checked `npm test`\n- No diff remained",
        },
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).toContain("Completed without code changes - no PR created.");
    expect(container.querySelector(".text-error")).toBeNull();
  });

  it("surfaces an abnormal outcome with the error treatment", () => {
    render(
      makeSession({
        prUrl: null,
        outcome: {
          state: "no_change_abnormal",
          tone: "error",
          title: "Finalization failed before changes could be prepared.",
          detail: null,
        },
      } as Partial<SessionDetail>),
    );
    expect(container.textContent).toContain("Finalization failed before changes could be prepared.");
    expect(container.querySelector(".text-error")).not.toBeNull();
  });

  it("prefers a real create-pr error over the publish status message", () => {
    render(makeSession({ prUrl: null, publishError: "Targeted tests failed" } as Partial<SessionDetail>), null);
    expect(container.textContent).toContain("Targeted tests failed");

    render(
      makeSession({ prUrl: null, publishError: "Targeted tests failed" } as Partial<SessionDetail>),
      "GitHub rejected PR creation",
    );
    expect(container.textContent).toContain("GitHub rejected PR creation");
    expect(container.textContent).not.toContain("Targeted tests failed");
  });
});
