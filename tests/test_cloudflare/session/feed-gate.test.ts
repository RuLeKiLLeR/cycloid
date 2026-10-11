import { describe, expect, it } from "vitest";

import { decideFeedDelivery } from "../../../apps/control-plane-worker/src/session/feed-gate";

// The repo-access gate is the single leak boundary for the per-business feed
// fan-out (ARC-1322). It must mirror the session-list filter exactly: owners
// always see their own sessions; other business members see a session only when
// its `owner/name` is in their accessible-repo set; missing repo context is
// owner-only (fail closed).

const ownerDelta = (
  over: Partial<{ ownerUserId: string; repoOwner: string | null; repoName: string | null }> = {},
) => ({
  ownerUserId: "owner-1",
  repoOwner: "acme" as string | null,
  repoName: "widgets" as string | null,
  ...over,
});

describe("decideFeedDelivery", () => {
  it("delivers to the owner unconditionally (repo in set)", () => {
    const decision = decideFeedDelivery("owner-1", ownerDelta(), new Set(["acme/widgets"]));
    expect(decision).toEqual({ deliver: true, reason: "owner" });
  });

  it("delivers to the owner even with no accessible repos", () => {
    const decision = decideFeedDelivery("owner-1", ownerDelta(), new Set());
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe("owner");
  });

  it("delivers to the owner even when repo context is missing", () => {
    const decision = decideFeedDelivery("owner-1", ownerDelta({ repoOwner: null, repoName: null }), new Set());
    expect(decision).toEqual({ deliver: true, reason: "owner" });
  });

  it("delivers to another member when the repo is in their accessible set", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta(), new Set(["acme/widgets"]));
    expect(decision).toEqual({ deliver: true, reason: "repo-allowed" });
  });

  it("suppresses for another member when the repo is NOT in their set", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta(), new Set(["other/repo"]));
    expect(decision).toEqual({ deliver: false, reason: "repo-denied" });
  });

  it("suppresses for another member when the set is empty", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta(), new Set());
    expect(decision).toEqual({ deliver: false, reason: "repo-denied" });
  });

  it("suppresses for a non-owner when repoOwner is missing (fail closed)", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta({ repoOwner: null }), new Set(["acme/widgets"]));
    expect(decision).toEqual({ deliver: false, reason: "no-repo-context" });
  });

  it("suppresses for a non-owner when repoName is missing (fail closed)", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta({ repoName: null }), new Set(["acme/widgets"]));
    expect(decision).toEqual({ deliver: false, reason: "no-repo-context" });
  });

  it("normalizes owner/name case and whitespace to match the lowercased set", () => {
    const decision = decideFeedDelivery(
      "member-2",
      ownerDelta({ repoOwner: " ACME", repoName: "Widgets " }),
      new Set(["acme/widgets"]),
    );
    expect(decision).toEqual({ deliver: true, reason: "repo-allowed" });
  });

  it("treats an empty-string repoOwner as missing context (fail closed)", () => {
    const decision = decideFeedDelivery("member-2", ownerDelta({ repoOwner: "" }), new Set(["acme/widgets"]));
    expect(decision).toEqual({ deliver: false, reason: "no-repo-context" });
  });
});
