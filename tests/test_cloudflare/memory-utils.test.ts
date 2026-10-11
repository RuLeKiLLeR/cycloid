import { describe, expect, it } from "vitest";

import {
  countCandidateAuditByLane,
  inferEngineeringDomains,
  semanticDefaultsForSuggestion,
} from "../../apps/control-plane-worker/src/memory/utils";

describe("memory utils", () => {
  const lanes = ["strategic", "tactical", "gotcha", "no_memory"] as const;

  it("counts candidate audit lanes while preserving zeroes", () => {
    expect(
      countCandidateAuditByLane([{ lane: "strategic" }, { lane: "strategic" }, { lane: "gotcha" }], lanes),
    ).toEqual({ strategic: 2, tactical: 0, gotcha: 1, no_memory: 0 });
    expect(countCandidateAuditByLane(undefined, lanes)).toEqual({
      strategic: 0,
      tactical: 0,
      gotcha: 0,
      no_memory: 0,
    });
  });

  it("infers engineering domains from referenced paths", () => {
    expect(inferEngineeringDomains(["apps/control-plane-worker/src/auth/db.ts", "tests/session.spec.ts"])).toEqual([
      "data_persistence",
      "security",
      "testing",
    ]);
    expect(inferEngineeringDomains(["README.md"])).toEqual(["code_structure"]);
  });

  it("maps legacy suggestion types to semantic defaults", () => {
    expect(semanticDefaultsForSuggestion("architecture", [])).toMatchObject({
      memory_type: "factual",
      action_type: null,
      level: "strategic",
      primitive: "claim",
    });
    expect(semanticDefaultsForSuggestion("gotcha", [])).toMatchObject({
      memory_type: "action",
      action_type: "procedure",
      level: "gotcha",
      primitive: "gotcha",
    });
    expect(semanticDefaultsForSuggestion("convention", [])).toMatchObject({
      memory_type: "action",
      action_type: "procedure",
      level: "tactical",
      primitive: "procedure",
    });
  });
});
