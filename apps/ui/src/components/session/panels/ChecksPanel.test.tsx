import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentScreenshot } from "../../../hooks/useSessionScreenshots";
import type { SessionDetail } from "../../../types";
import { ChecksPanel } from "./ChecksPanel";

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
    sessionId: "s-checks-1",
    phase: "completed",
    prUrl: null,
    createdAt: Date.now(),
    model: null,
    title: "Test session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  } as SessionDetail;
}

function render(session: SessionDetail, screenshots: AgentScreenshot[] = []) {
  act(() => {
    root.render(<ChecksPanel session={session} screenshots={screenshots} />);
  });
}

function summarySession(
  summary: Partial<NonNullable<SessionDetail["verificationSummary"]>>,
  overrides: Partial<SessionDetail> = {},
): SessionDetail {
  return makeSession({
    verificationSummary: {
      outcome: "unverified",
      commands: [],
      checksPassed: [],
      skippedChecks: [],
      visualArtifacts: [],
      runtimeEvidence: null,
      caveats: [],
      ...summary,
    } as never,
    ...overrides,
  });
}

describe("ChecksPanel", () => {
  it("renders a calm empty state without any verification evidence", () => {
    render(makeSession());
    expect(container.textContent).toContain("No verification yet");
  });

  it("switches the no-evidence copy to past tense once the session completes", () => {
    act(() => {
      root.render(<ChecksPanel session={makeSession()} screenshots={[]} isComplete />);
    });
    expect(container.textContent).toContain("No verification recorded");
    expect(container.textContent).toContain("test-gate results and evidence appear here when Cycloid runs checks.");
  });

  it("pairs a details-free outcome chip with the explanatory sentence", () => {
    // A verification object with only an outcome would otherwise render a
    // naked "Unverified" chip.
    render(summarySession({ outcome: "unverified" }));
    expect(container.textContent).toContain("Unverified");
    expect(container.textContent).toContain(
      "No verification recorded — test-gate results and evidence appear here when Cycloid runs checks.",
    );
  });

  it("omits the explanatory sentence when real evidence renders", () => {
    render(
      summarySession({
        outcome: "verified",
        commands: [
          { command: "npm test", status: "passed", exitCode: 0, source: "post_execution", checks: [] },
        ] as never,
      }),
    );
    expect(container.textContent).not.toContain("No verification recorded");
  });

  it("lists command outcomes with exit codes under the Commands label", () => {
    render(
      summarySession({
        outcome: "verified",
        commands: [
          { command: "npm test", status: "passed", exitCode: 0, source: "post_execution", checks: [] },
          { command: "npm run lint", status: "failed", exitCode: 1, source: "post_execution", checks: [] },
        ] as never,
      }),
    );
    expect(container.textContent).toContain("Commands");
    expect(container.textContent).toContain("npm test");
    expect(container.textContent).toContain("exit 0");
    expect(container.textContent).toContain("passed");
    expect(container.textContent).toContain("npm run lint");
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("Verified");
  });

  it("labels a draft outcome as manual review", () => {
    render(
      summarySession({
        outcome: "draft",
        commands: [
          { command: "npm test", status: "passed", exitCode: 0, source: "post_execution", checks: [] },
        ] as never,
      }),
    );
    expect(container.textContent).toContain("Draft — manual review");
  });

  it("renders skipped checks and caveats", () => {
    render(
      summarySession({
        skippedChecks: [{ check: "tests", reason: "no test harness" }] as never,
        caveats: ["Could not reach the staging API"],
      }),
    );
    expect(container.textContent).toContain("Skipped");
    expect(container.textContent).toContain("tests: no test harness");
    expect(container.textContent).toContain("Could not reach the staging API");
  });

  it("renders screenshot evidence links", () => {
    render(makeSession(), [
      { artifactId: "a1", viewUrl: "https://example.com/shot.png", label: "Home page" } as AgentScreenshot,
    ]);
    expect(container.textContent).toContain("Screenshots");
    const img = container.querySelector('img[src="https://example.com/shot.png"]');
    expect(img?.getAttribute("alt")).toBe("Home page");
  });
});
