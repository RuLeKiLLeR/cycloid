import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../types";
import {
  buildArtifactTabs,
  deriveReportTexts,
  deriveSessionChanges,
  deriveWorkbenchPhaseIndex,
  deriveWorkbenchPhaseStates,
  getCanonicalSessionStatus,
  parsePrNumber,
  parseStoredPanelWidth,
  resolveArtifactTab,
  sessionDisplayBranch,
  WORKBENCH_PHASE_INDEX,
  WORKBENCH_PHASES,
} from "./workbench";

describe("deriveWorkbenchPhaseIndex", () => {
  it("maps merged lifecycle stage to Done", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "completed", uiLifecycleStage: "merged", prUrl: "x" })).toBe(
      WORKBENCH_PHASE_INDEX.done,
    );
  });

  it("maps merge_ready to Review", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "completed", uiLifecycleStage: "merge_ready", prUrl: "x" })).toBe(
      WORKBENCH_PHASE_INDEX.review,
    );
  });

  it("maps post-publish verification to Review", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "completed", uiLifecycleStage: "verifying", prUrl: "x" })).toBe(
      WORKBENCH_PHASE_INDEX.review,
    );
  });

  it("completed is Done regardless of whether publication produced a PR", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "completed", prUrl: "https://pr" })).toBe(WORKBENCH_PHASE_INDEX.done);
    expect(deriveWorkbenchPhaseIndex({ phase: "completed", prUrl: null })).toBe(WORKBENCH_PHASE_INDEX.done);
  });

  it("does not infer a running phase from verification or PR presence", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "running", hasVerification: true })).toBe(WORKBENCH_PHASE_INDEX.building);
    expect(deriveWorkbenchPhaseIndex({ phase: "running", prUrl: "x" })).toBe(WORKBENCH_PHASE_INDEX.building);
    expect(deriveWorkbenchPhaseIndex({ phase: "running" })).toBe(WORKBENCH_PHASE_INDEX.building);
  });

  it("uses finalizingStep for verification and publishing", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "finalizing", finalizingStep: "post_execution" })).toBe(
      WORKBENCH_PHASE_INDEX.verifying,
    );
    expect(deriveWorkbenchPhaseIndex({ phase: "finalizing", finalizingStep: "publishing" })).toBe(
      WORKBENCH_PHASE_INDEX.publishing,
    );
  });

  it("running while the sandbox is still creating with no prompts sits at Planning", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "running", sandboxSubstate: "creating", promptCount: 0 })).toBe(
      WORKBENCH_PHASE_INDEX.planning,
    );
  });

  it("failed only claims Building when prompt work was observed", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "failed", prUrl: "x" })).toBe(WORKBENCH_PHASE_INDEX.created);
    expect(deriveWorkbenchPhaseIndex({ phase: "failed", promptCount: 1 })).toBe(WORKBENCH_PHASE_INDEX.building);
  });

  it("idle with no prompts is Created", () => {
    expect(deriveWorkbenchPhaseIndex({ phase: "idle", promptCount: 0 })).toBe(WORKBENCH_PHASE_INDEX.created);
  });
});

describe("truthful lifecycle presentation", () => {
  it.each([
    [{ phase: "running" as const }, "Working"],
    [{ phase: "finalizing" as const, finalizingStep: "post_execution" as const }, "Verifying"],
    [{ phase: "finalizing" as const, finalizingStep: "publishing" as const }, "Publishing"],
    [{ phase: "review_listening" as const, prUrl: "x" }, "Reviewing"],
    [{ phase: "completed" as const, uiLifecycleStage: "merge_ready" as const, prUrl: "x" }, "Merge ready"],
    [{ phase: "failed" as const }, "Failed"],
    [{ phase: "archived" as const }, "Archived"],
  ])("maps %j to %s", (input, label) => {
    expect(getCanonicalSessionStatus(input).label).toBe(label);
  });

  it("marks unobserved stages as skipped, not pending, once the session settles", () => {
    // Completed without a PR: Publishing and Reviewing never happened and
    // never will — hollow pending dots would read as "still waiting".
    const states = deriveWorkbenchPhaseStates({ phase: "completed", prUrl: null, promptCount: 1 });
    const byKey = Object.fromEntries(WORKBENCH_PHASES.map((phase, index) => [phase.key, states[index]]));
    expect(byKey.building).toBe("done");
    expect(byKey.publishing).toBe("skipped");
    expect(byKey.review).toBe("skipped");
    expect(byKey.done).toBe("done");
    expect(states).not.toContain("pending");
  });

  it("shares the status chip vocabulary for renamed stages", () => {
    const labels = WORKBENCH_PHASES.map((phase) => phase.label);
    expect(labels).toContain("Working");
    expect(labels).toContain("Reviewing");
    expect(labels).toContain("Completed");
    expect(labels).not.toContain("Building");
  });

  it("never marks settled, stopped, or failed phases as live current", () => {
    expect(deriveWorkbenchPhaseStates({ phase: "completed", prUrl: null })).not.toContain("current");
    expect(deriveWorkbenchPhaseStates({ phase: "stopped" })).not.toContain("current");
    expect(deriveWorkbenchPhaseStates({ phase: "failed" })).not.toContain("current");
    expect(deriveWorkbenchPhaseStates({ phase: "running" })).toContain("current");
  });
});

describe("buildArtifactTabs", () => {
  const base = { changesCount: 0, hasPr: false, prUrl: null };

  it("always renders the fixed tabs in stable order", () => {
    expect(buildArtifactTabs(base).map((tab) => tab.id)).toEqual(["summary", "runtime", "changes", "report"]);
  });

  it("appends a numbered PR tab when the session has a published PR", () => {
    const tabs = buildArtifactTabs({ ...base, hasPr: true, prUrl: "https://github.com/acme/webapp/pull/123" });
    expect(tabs.map((tab) => tab.id)).toEqual(["summary", "runtime", "changes", "report", "pr"]);
    expect(tabs[4]?.label).toBe("PR #123");
  });

  it("labels the PR tab without a number when only PR-object errors exist", () => {
    const tabs = buildArtifactTabs({ ...base, hasPr: true, prUrl: null });
    expect(tabs[4]).toMatchObject({ id: "pr", label: "PR" });
  });

  it("omits the PR tab when the session has no PR data", () => {
    expect(buildArtifactTabs(base).some((tab) => tab.id === "pr")).toBe(false);
  });

  it("badges Changes with the touched-file count only when changes exist", () => {
    const changes = (count: number) =>
      buildArtifactTabs({ ...base, changesCount: count }).find((tab) => tab.id === "changes");
    expect(changes(0)?.badge).toBeNull();
    expect(changes(4)?.badge).toBe(4);
  });
});

describe("resolveArtifactTab", () => {
  const tabs = buildArtifactTabs({ changesCount: 0, hasPr: false, prUrl: null });

  it("returns the stored tab when it exists in the registry", () => {
    expect(resolveArtifactTab("changes", tabs)).toBe("changes");
    expect(resolveArtifactTab("runtime", tabs)).toBe("runtime");
  });

  it("falls back to summary for a persisted tab that no longer exists", () => {
    // e.g. "pr" persisted for a session whose registry has no PR tab.
    expect(resolveArtifactTab("pr", tabs)).toBe("summary");
  });

  it("falls back to summary for missing or unknown values", () => {
    expect(resolveArtifactTab(null, tabs)).toBe("summary");
    expect(resolveArtifactTab("diffs", tabs)).toBe("summary");
  });
});

describe("parsePrNumber", () => {
  it("parses the PR number from a GitHub pull URL", () => {
    expect(parsePrNumber("https://github.com/acme/webapp/pull/421")).toBe(421);
    expect(parsePrNumber("https://github.com/acme/webapp/pull/421/files")).toBe(421);
  });

  it("returns null for missing or non-PR URLs", () => {
    expect(parsePrNumber(null)).toBeNull();
    expect(parsePrNumber("https://github.com/acme/webapp")).toBeNull();
    expect(parsePrNumber("https://github.com/acme/webapp/pull/abc")).toBeNull();
  });
});

describe("sessionDisplayBranch", () => {
  it("falls through start -> base -> last -> published and trims", () => {
    expect(sessionDisplayBranch({ startBranch: " feat/x ", baseBranch: "main" })).toBe("feat/x");
    expect(sessionDisplayBranch({ startBranch: "  ", baseBranch: "main" })).toBe("main");
    expect(sessionDisplayBranch({ lastBranch: null, publishedBranch: "arc/pr-1" })).toBe("arc/pr-1");
    expect(sessionDisplayBranch({})).toBeNull();
  });
});

describe("parseStoredPanelWidth", () => {
  const bounds = { min: 280, max: 560, fallback: 360 };

  it("returns the fallback for missing or non-numeric values", () => {
    expect(parseStoredPanelWidth(null, bounds)).toBe(360);
    expect(parseStoredPanelWidth("", bounds)).toBe(360);
    expect(parseStoredPanelWidth("wide", bounds)).toBe(360);
  });

  it("clamps numeric values into range", () => {
    expect(parseStoredPanelWidth("100", bounds)).toBe(280);
    expect(parseStoredPanelWidth("9999", bounds)).toBe(560);
    expect(parseStoredPanelWidth("420", bounds)).toBe(420);
  });
});

describe("deriveReportTexts", () => {
  const textEvent = (id: string, text: string): ActivityEvent => ({ type: "text", id, text }) as ActivityEvent;

  it("uses the first prompt as the request and the newest string result as the summary", () => {
    const prompts = [
      { promptId: "p1", prompt: "Fix the bug", result: "Did the fix" },
      { promptId: "p2", prompt: "Also add tests", result: "Added tests" },
    ];
    expect(deriveReportTexts(prompts, new Map())).toEqual({
      requestText: "Fix the bug",
      finalMessage: "Added tests",
    });
  });

  it("falls back to the newest streamed assistant text when results are not strings", () => {
    const prompts = [
      { promptId: "p1", prompt: "Fix the bug", result: null },
      { promptId: "p2", prompt: "Also add tests", result: { ok: true } },
    ];
    const transcripts = new Map<string, ActivityEvent[]>([
      ["p1", [textEvent("t1", "early message")]],
      ["p2", [textEvent("t2", "first"), textEvent("t3", "final message")]],
    ]);
    expect(deriveReportTexts(prompts, transcripts)).toEqual({
      requestText: "Fix the bug",
      finalMessage: "final message",
    });
  });

  it("returns nulls when there are no prompts", () => {
    expect(deriveReportTexts([], new Map())).toEqual({ requestText: null, finalMessage: null });
  });
});

describe("deriveSessionChanges", () => {
  const patch = (id: string, files: string[]): ActivityEvent =>
    ({ type: "patch", id, files, promptId: "p1" }) as unknown as ActivityEvent;
  const edit = (id: string, input: Record<string, unknown>): ActivityEvent =>
    ({ type: "tool_call", id, tool: "edit", summary: "", input, promptId: "p1" }) as unknown as ActivityEvent;
  const write = (id: string, input: Record<string, unknown>): ActivityEvent =>
    ({ type: "tool_call", id, tool: "write", summary: "", input, promptId: "p1" }) as unknown as ActivityEvent;

  it("returns an empty list when there are no file-change events", () => {
    const transcripts = new Map<string, ActivityEvent[]>([["p1", []]]);
    expect(deriveSessionChanges(["p1"], transcripts)).toEqual([]);
  });

  it("dedupes touched paths without inventing line counts", () => {
    const transcripts = new Map<string, ActivityEvent[]>([
      [
        "p1",
        [
          edit("e1", { file_path: "src/a.ts", oldString: "one\ntwo", newString: "one\ntwo\nthree" }),
          edit("e2", { file_path: "src/a.ts", oldString: "x", newString: "y" }),
          write("w1", { file_path: "src/b.ts", content: "line1\nline2\nline3" }),
        ],
      ],
    ]);
    const changes = deriveSessionChanges(["p1"], transcripts);
    expect(changes).toEqual([
      { path: "src/a.ts", edits: 2 },
      { path: "src/b.ts", edits: 1 },
    ]);
  });

  it("includes files from patch events", () => {
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [patch("pt1", ["src/c.ts", "src/d.ts"])]]]);
    expect(deriveSessionChanges(["p1"], transcripts).map((c) => c.path)).toEqual(["src/c.ts", "src/d.ts"]);
  });
});
