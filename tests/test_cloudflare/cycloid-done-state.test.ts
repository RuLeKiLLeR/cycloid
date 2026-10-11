import { describe, expect, it } from "vitest";

import { deriveCycloidDoneStatus, normalizeCycloidDoneReasons } from "../../shared/session/phase";

describe("cycloid done state", () => {
  it("stays working until the review loop is done", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "working",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationApplies: true,
      }),
    ).toEqual({ state: "working", outcome: null, reasons: [] });
  });

  it("stays working while verification is still awaiting a verdict", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-in-progress",
        verificationResult: null,
        verificationApplies: true,
      }),
    ).toEqual({ state: "working", outcome: null, reasons: [] });
  });

  it("returns done success once the loop is caught up and verification is approving", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationApplies: true,
      }),
    ).toEqual({ state: "done", outcome: "success", reasons: [] });
  });

  it("returns done needs_attention when CI is red after RLA exhaustion", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        verificationApplies: true,
        ciRed: true,
      }),
    ).toEqual({ state: "done", outcome: "needs_attention", reasons: ["ci_red"] });
  });

  it("preserves the prior CI-red signal while verification finishes", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-in-progress",
        verificationResult: null,
        verificationApplies: true,
        currentReasons: ["ci_red"],
      }),
    ).toEqual({ state: "working", outcome: null, reasons: ["ci_red"] });
  });

  it.each([
    ["verification-exhausted", "verification_exhausted"],
    ["verification-stopped", "verification_stopped"],
  ] as const)("returns done needs_attention for %s", (verificationState, reason) => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState,
        verificationResult: null,
        verificationApplies: true,
      }),
    ).toEqual({ state: "done", outcome: "needs_attention", reasons: [reason] });
  });

  it("returns done needs_attention when QTA finished without a conclusive result", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: null,
        verificationApplies: true,
      }),
    ).toEqual({ state: "done", outcome: "needs_attention", reasons: ["verification_inconclusive"] });
  });

  it("keeps QTA needs-work as working even before the sweep re-engages RLA", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "needs-work",
        verificationApplies: true,
      }),
    ).toEqual({ state: "working", outcome: null, reasons: [] });
  });

  it("keeps QTA needs-work as working while the review loop is re-engaging", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "working",
        verificationState: "verification-done",
        verificationResult: "needs-work",
        verificationApplies: true,
      }),
    ).toEqual({ state: "working", outcome: null, reasons: [] });
  });

  it("treats skipped verification as success once the review loop is caught up", () => {
    expect(
      deriveCycloidDoneStatus({
        reviewLoopDoneState: "done",
        verificationState: "verification-skipped",
        verificationResult: null,
        verificationApplies: true,
      }),
    ).toEqual({ state: "done", outcome: "success", reasons: [] });
  });

  it("normalizes only known reason codes in stable order", () => {
    expect(normalizeCycloidDoneReasons(JSON.stringify(["verification_exhausted", "bogus", "ci_red"]))).toEqual([
      "ci_red",
      "verification_exhausted",
    ]);
  });
});
