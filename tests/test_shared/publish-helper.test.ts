import { describe, expect, it } from "vitest";

import { isPublishTerminalFailure } from "../../shared/session/publish";
import type { PublishStatus } from "../../shared/types/publish";

// `isPublishTerminalFailure` has exactly one semantic: `=== "failed"`. (The
// pre-publish block status + its `isPublishBlocked` helper were deleted in
// ARC-1330 D-57 — the post-review block surfaces via the FSM `blocked_reason`
// projection, not a publish status.)
describe("isPublishTerminalFailure", () => {
  // Exhaustive map keyed by PublishStatus so TypeScript fails compilation if
  // a new variant is added to the union without updating these parity tests.
  const ALL_STATUSES_BY_KEY: Record<PublishStatus, true> = {
    not_started: true,
    publishing: true,
    published: true,
    failed: true,
    skipped: true,
    superseded: true,
  };
  const ALL_STATUSES = Object.keys(ALL_STATUSES_BY_KEY) as PublishStatus[];

  it("isPublishTerminalFailure is true for failed only", () => {
    for (const status of ALL_STATUSES) {
      expect(isPublishTerminalFailure(status)).toBe(status === "failed");
    }
  });

  it("isPublishTerminalFailure tolerates null / undefined", () => {
    expect(isPublishTerminalFailure(null)).toBe(false);
    expect(isPublishTerminalFailure(undefined)).toBe(false);
  });

  it("stored legacy blocked_by_verification rows still read as terminal failure (D-57 stored-rows compat)", () => {
    // Writer + union arm deleted (ARC-1330 D-57); pre-existing rows persist the
    // literal and never got a PR — still a terminal publish outcome for the UI.
    expect(isPublishTerminalFailure("blocked_by_verification" as never)).toBe(true);
  });
});

describe("superseded publish status", () => {
  it("is not a publish *failure*", () => {
    expect(isPublishTerminalFailure("superseded")).toBe(false);
  });
});
