import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("failed GitHub check automation surface", () => {
  it("advertises only the implemented bounded trigger", () => {
    const page = readFileSync("apps/ui/src/pages/AutomationsPage.tsx", "utf8");
    expect(page).toContain("Failed GitHub check");
    expect(page).toContain("three configurable trigger types");
    expect(page).toContain('adminAccess === "admin"');
    expect(page).toContain("busyGithubCheckRuleId");
    expect(page).toContain("Failed to update GitHub check automation");
    expect(page).not.toContain("Watch a channel");
    expect(page).not.toContain("Generic webhook");
  });

  it("explains lifecycle precedence in the builder", () => {
    const modal = readFileSync("apps/ui/src/components/automations/GithubCheckAutomationModal.tsx", "utf8");
    expect(modal).toMatch(/Cycloid-owned PR review-loop CI\s+keeps precedence/);
    expect(modal).toContain("Exact check name (optional)");
    expect(modal).toContain('setRepo("")');
    expect(modal).toContain('setCheckName("")');
  });
});
