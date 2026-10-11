import { describe, expect, it } from "vitest";

import type { PrInboxBucket, PrInboxItem } from "../../api/pr-inbox";
import { cycloidDoneChip, groupByBucket, PR_BUCKET_LABELS, PR_BUCKET_ORDER } from "./bucket-config";

function item(bucket: PrInboxBucket, updatedAt: string): PrInboxItem {
  return {
    sessionId: `s-${bucket}-${updatedAt}`,
    prUrl: null,
    prNumber: null,
    title: null,
    repoOwner: null,
    repoName: null,
    headBranch: null,
    draft: null,
    state: "x",
    bucket,
    phase: "x",
    feChip: "x",
    labels: [],
    stageSection: "x",
    cycloidDone: { state: "done", outcome: "success", reasons: [] },
    model: null,
    agentRuntimeBackend: null,
    initiationMode: "user",
    linkedTicket: null,
    updatedAt,
  };
}

describe("PR bucket config", () => {
  it("orders buckets actionable-first, terminal-last", () => {
    expect(PR_BUCKET_ORDER).toEqual([
      "needs_review",
      "changes_requested",
      "checks_failing",
      "approved",
      "draft",
      "open",
      "closed",
    ]);
  });

  it("has a sentence-case label for every bucket", () => {
    for (const bucket of PR_BUCKET_ORDER) {
      expect(PR_BUCKET_LABELS[bucket]).toBeTruthy();
    }
  });
});

describe("groupByBucket", () => {
  it("groups in triage order, drops empty buckets, and preserves item order", () => {
    const items = [
      item("closed", "2024-01-01"),
      item("needs_review", "2024-01-03"),
      item("needs_review", "2024-01-02"),
      item("approved", "2024-01-04"),
    ];
    const groups = groupByBucket(items);
    expect(groups.map((g) => g.bucket)).toEqual(["needs_review", "approved", "closed"]);
    expect(groups[0].items.map((i) => i.updatedAt)).toEqual(["2024-01-03", "2024-01-02"]);
    expect(groups[0].label).toBe("Needs review");
  });

  it("returns no groups for an empty list", () => {
    expect(groupByBucket([])).toEqual([]);
  });
});

describe("cycloidDoneChip", () => {
  it("marks working sessions", () => {
    expect(cycloidDoneChip({ state: "working", outcome: null, reasons: [] })).toEqual({
      kind: "text",
      label: "Working",
    });
  });

  it("marks needs-attention outcomes", () => {
    expect(cycloidDoneChip({ state: "done", outcome: "needs_attention", reasons: [] })).toEqual({
      kind: "needs-input",
      label: "Needs attention",
    });
  });

  it("marks successful/finished sessions as done", () => {
    expect(cycloidDoneChip({ state: "done", outcome: "success", reasons: [] })).toEqual({
      kind: "verified",
      label: "Done",
    });
    expect(cycloidDoneChip({ state: "done", outcome: null, reasons: [] })).toEqual({
      kind: "verified",
      label: "Done",
    });
  });
});
