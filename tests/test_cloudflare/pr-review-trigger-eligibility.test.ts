import { describe, expect, it } from "vitest";

import { isEligibleForAutomaticPrReview } from "../../apps/control-plane-worker/src/services/pr-review-trigger-spawn";

const member = { businessId: "295d2abc-d10b-4662-b84d-7bfa66242882" };

describe("automatic PR review eligibility", () => {
  it("allows only genuine internal, non-exempt publishes", () => {
    expect(isEligibleForAutomaticPrReview({ agentRole: "primary", agentProfile: "build" }, member, true)).toBe(true);
  });

  it.each([
    ["adopted publish", { agentRole: "primary", agentProfile: "build" }, false],
    ["external owner", { agentRole: "primary", agentProfile: "build" }, true],
    ["review recursion", { agentRole: "verification", agentProfile: "review" }, true],
    ["plan recursion", { agentRole: "primary", agentProfile: "plan" }, true],
    ["QA tester", { agentRole: "verification", agentProfile: "verify" }, true],
    ["onboarding", { agentRole: "primary", agentProfile: "onboard" }, true],
  ] as const)("rejects %s", (_name, session, countCreateMetric) => {
    const owner = _name === "external owner" ? { businessId: "external-business" } : member;
    expect(isEligibleForAutomaticPrReview(session, owner, countCreateMetric)).toBe(false);
  });
});
