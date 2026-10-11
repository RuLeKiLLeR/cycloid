import { describe, expect, it } from "vitest";

import { getArchivedSessionBannerMessage, getPrOutcomeBadgeLabel } from "../../apps/ui/src/utils/session-close-reason";

describe("session close reason helpers", () => {
  it("returns merged-specific labels and copy", () => {
    expect(getArchivedSessionBannerMessage("pr_merged")).toContain("pull request was merged");
    expect(getArchivedSessionBannerMessage("pr_merged")).toContain("Start a new session to continue");
    expect(getPrOutcomeBadgeLabel("pr_merged")).toBe("merged");
  });

  it("returns closed-specific labels and copy", () => {
    expect(getArchivedSessionBannerMessage("pr_closed")).toContain("pull request was closed");
    expect(getPrOutcomeBadgeLabel("pr_closed")).toBe("closed");
  });

  it("falls back to generic archived copy for other reasons", () => {
    expect(getArchivedSessionBannerMessage("user_closed")).toContain("This session is archived permanently");
    expect(getPrOutcomeBadgeLabel("user_closed")).toBeNull();
  });
});
