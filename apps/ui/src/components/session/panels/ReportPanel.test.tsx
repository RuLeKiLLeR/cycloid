import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionDetail } from "../../../types";
import { ReportPanel } from "./ReportPanel";

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
    sessionId: "s-report-1",
    phase: "completed",
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

function render(isComplete: boolean, overrides: Partial<SessionDetail> = {}) {
  act(() => {
    root.render(
      <ReportPanel
        session={makeSession(overrides)}
        requestText="Fix the flaky test"
        finalMessage={null}
        changes={[]}
        screenshots={[]}
        isComplete={isComplete}
      />,
    );
  });
}

const VERIFIED_SUMMARY = {
  outcome: "verified",
  commands: [{ command: "npm test", status: "passed", exitCode: 0, source: "post_execution", checks: [] }],
  checksPassed: [],
  skippedChecks: [],
  visualArtifacts: [],
  runtimeEvidence: null,
  caveats: [],
} as unknown as SessionDetail["verificationSummary"];

describe("ReportPanel gating", () => {
  it("shows a restrained empty state while the session is active", () => {
    render(false);
    expect(container.textContent).toContain("Report will be available when the session finishes.");
    expect(container.textContent).not.toContain("Request");
    // No verification evidence yet — the section stays hidden while active.
    expect(container.textContent).not.toContain("Verification");
  });

  it("surfaces existing verification evidence above the gate while active", () => {
    render(false, { verificationSummary: VERIFIED_SUMMARY });
    expect(container.textContent).toContain("Verification");
    expect(container.textContent).toContain("npm test");
    expect(container.textContent).toContain("Report will be available when the session finishes.");
  });

  it("renders the report once the session finishes", () => {
    render(true, { prUrl: "https://github.com/trycycloid/cycloid/pull/9" });
    expect(container.textContent).not.toContain("Report will be available when the session finishes.");
    expect(container.textContent).toContain("Request");
    expect(container.textContent).toContain("Fix the flaky test");
    expect(container.textContent).toContain("Touched files (0)");
    expect(container.textContent).toContain("https://github.com/trycycloid/cycloid/pull/9");
    expect(container.firstElementChild?.classList.contains("review-loop-settle")).toBe(false);
  });

  it("settles only when completion is observed in place", () => {
    render(false);
    render(true);
    expect(container.firstElementChild?.classList.contains("review-loop-settle")).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    render(true);
    expect(container.firstElementChild?.classList.contains("review-loop-settle")).toBe(false);
  });

  it("explains a completed session without verification instead of a bare state", () => {
    render(true);
    expect(container.textContent).toContain("Verification");
    expect(container.textContent).toContain("No verification recorded");
    expect(container.textContent).toContain("test-gate results and evidence appear here when Cycloid runs checks.");
  });
});
