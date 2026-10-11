import { describe, expect, it } from "vitest";

import {
  applyGateResult,
  type GateResult,
  initialPublishDecision,
  markGateFailedDraft,
  markGateResourceKilled,
  type PublishDecision,
} from "../../apps/sandbox-bridge/src/services/post-execution/publish-gates.js";

function fold(results: GateResult[]): PublishDecision {
  return results.reduce((decision, result) => applyGateResult(decision, result), initialPublishDecision());
}

describe("applyGateResult precedence", () => {
  const cases: Array<{
    name: string;
    results: GateResult[];
    expected: Partial<PublishDecision>;
  }> = [
    {
      name: "all pass -> normal",
      results: [{ decision: "pass" }, { decision: "pass" }],
      expected: { publishMode: "normal", publishWarnReasons: [] },
    },
    {
      name: "single draft -> draft with warn",
      results: [markGateFailedDraft("Pre-publish typecheck failed: x", { verdict: "REFUTED" })],
      expected: {
        publishMode: "draft",
        publishWarnReasons: ["Pre-publish typecheck failed: x"],
        verificationVerdictOverride: "REFUTED",
        verificationExplanationOverride: "Pre-publish typecheck failed: x",
      },
    },
    {
      name: "multiple draft gates append + dedupe warn reasons",
      results: [
        markGateFailedDraft("typecheck failed"),
        markGateFailedDraft("infra failed"),
        markGateFailedDraft("typecheck failed"),
      ],
      expected: { publishMode: "draft", publishWarnReasons: ["typecheck failed", "infra failed"] },
    },
    {
      name: "replace-mode draft replaces accumulated warn reasons",
      results: [
        markGateFailedDraft("typecheck failed"),
        {
          decision: "draft",
          warnReasons: ["replacement reason a", "replacement reason b"],
          warnReasonsMode: "replace",
        },
      ],
      expected: {
        publishMode: "draft",
        publishWarnReasons: ["replacement reason a", "replacement reason b"],
      },
    },
    {
      name: "resource-killed sets manual review without verdict override",
      results: [markGateResourceKilled("typecheck killed by resource limits")],
      expected: {
        publishMode: "draft",
        manualReviewReason: "typecheck killed by resource limits",
        publishWarnReasons: [],
      },
    },
    {
      name: "later verdict/explanation overrides win (last-wins)",
      results: [
        markGateFailedDraft("typecheck", { verdict: "REFUTED" }),
        {
          decision: "draft",
          warnReasons: ["tests inconclusive"],
          verdictOverride: "INCONCLUSIVE",
          explanationOverride: "tests inconclusive",
        },
      ],
      expected: {
        publishMode: "draft",
        verificationVerdictOverride: "INCONCLUSIVE",
        verificationExplanationOverride: "tests inconclusive",
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(fold(testCase.results)).toMatchObject(testCase.expected);
    });
  }

  it("replace mode with an empty array clears accumulated warn reasons", () => {
    const decision = fold([
      markGateFailedDraft("typecheck failed"),
      { decision: "draft", warnReasons: [], warnReasonsMode: "replace" },
    ]);
    expect(decision.publishWarnReasons).toEqual([]);
    expect(decision.publishMode).toBe("draft");
  });

  it("markGateFailedDraft without a verdict sets neither verdict nor explanation", () => {
    const decision = fold([markGateFailedDraft("infra-ish failure")]);
    expect(decision.verificationVerdictOverride).toBeUndefined();
    expect(decision.verificationExplanationOverride).toBeUndefined();
    expect(decision.publishWarnReasons).toEqual(["infra-ish failure"]);
  });

  it("resource-killed leaves verdict override unset", () => {
    const decision = fold([markGateResourceKilled("killed")]);
    expect(decision.verificationVerdictOverride).toBeUndefined();
    expect(decision.verificationExplanationOverride).toBeUndefined();
  });

  it("pass does not clear an existing draft decision", () => {
    const decision = fold([markGateFailedDraft("typecheck failed"), { decision: "pass" }]);
    expect(decision.publishMode).toBe("draft");
    expect(decision.publishWarnReasons).toEqual(["typecheck failed"]);
  });
});
