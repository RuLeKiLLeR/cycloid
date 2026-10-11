import { describe, expect, it } from "vitest";

import {
  buildGateResults,
  buildTruncatedDiffExcerpt,
  deriveAuthoritativePublishMode,
  foldGateResults,
  mapGateDecision,
  maxPublishMode,
  normalizeGateResults,
  TRUNCATED_DIFF_OMISSION_MARKER_PREFIX,
} from "../../shared/post-execution.js";
import { type GateResults, PUBLISH_GATE_NAMES } from "../../shared/types/sandbox.js";

describe("buildTruncatedDiffExcerpt", () => {
  it("returns empty text for missing input or non-positive limits", () => {
    expect(buildTruncatedDiffExcerpt(undefined, 120)).toBe("");
    expect(buildTruncatedDiffExcerpt("diff", 0)).toBe("");
    expect(buildTruncatedDiffExcerpt("diff", -1)).toBe("");
  });

  it("returns text unchanged when it fits the limit", () => {
    expect(buildTruncatedDiffExcerpt("short diff", 20)).toBe("short diff");
    expect(buildTruncatedDiffExcerpt("exact", 5)).toBe("exact");
  });

  it("uses a single head-tail split with an omission marker for long text", () => {
    const text = ["start evidence", "x".repeat(300), "late evidence"].join("\n");

    const excerpt = buildTruncatedDiffExcerpt(text, 120);

    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(excerpt).toContain("start evidence");
    expect(excerpt).toContain("late evidence");
    expect(excerpt).toContain(TRUNCATED_DIFF_OMISSION_MARKER_PREFIX);
  });

  it("reports the actual omitted character count in the marker", () => {
    const text = "a".repeat(1_000);
    const excerpt = buildTruncatedDiffExcerpt(text, 120);
    const markerMatch = excerpt.match(/\[\.\.\. omitted (\d+) chars \.\.\.\]/);

    expect(markerMatch).not.toBeNull();
    const omittedChars = Number(markerMatch?.[1]);
    const visibleChars = excerpt.length - (markerMatch?.[0].length ?? 0) - 2;

    expect(omittedChars).toBe(text.length - visibleChars);
  });

  it("hard caps output when the marker itself fills the limit", () => {
    const excerpt = buildTruncatedDiffExcerpt("x".repeat(500), 12);

    expect(excerpt).toHaveLength(12);
  });
});

describe("mapGateDecision", () => {
  it("maps the bridge gate-decision vocabulary to the wire enum", () => {
    expect(mapGateDecision("passed")).toBe("pass");
    expect(mapGateDecision("draft")).toBe("draft");
    expect(mapGateDecision("blocked")).toBe("skipped");
  });

  it("maps a resource-killed gate to draft (inconclusive → manual review)", () => {
    expect(mapGateDecision("resource_killed")).toBe("draft");
  });

  it("maps absent or unrecognized decisions to skipped", () => {
    expect(mapGateDecision(undefined)).toBe("skipped");
    expect(mapGateDecision("")).toBe("skipped");
    expect(mapGateDecision("something_new")).toBe("skipped");
  });
});

describe("buildGateResults", () => {
  it("is complete over the closed gate set even when the input is empty", () => {
    const result = buildGateResults({});

    expect(Object.keys(result).sort()).toEqual([...PUBLISH_GATE_NAMES].sort());
    for (const name of PUBLISH_GATE_NAMES) {
      expect(result[name]).toEqual({ decision: "skipped" });
    }
  });

  it("translates each present gate decision and leaves the rest skipped", () => {
    const result = buildGateResults({
      tests: "draft",
    });

    expect(result.tests).toEqual({ decision: "draft" });
  });

  it("attaches descriptive reasons only for the named gates", () => {
    const result = buildGateResults({ tests: "draft" }, { tests: "Configured pre-publish test failed: …" });

    expect(result.tests).toEqual({ decision: "draft", reason: "Configured pre-publish test failed: …" });
  });

  it("ignores gate names outside the closed set", () => {
    const result = buildGateResults({ visual_evidence: "draft", unknown_gate: "blocked" });

    expect(result).not.toHaveProperty("visual_evidence");
    expect(result).not.toHaveProperty("unknown_gate");
    expect(Object.keys(result).sort()).toEqual([...PUBLISH_GATE_NAMES].sort());
  });
});

describe("maxPublishMode", () => {
  it("returns the more conservative of two modes (draft > normal)", () => {
    expect(maxPublishMode("normal", "draft")).toBe("draft");
    expect(maxPublishMode("draft", "normal")).toBe("draft");
    expect(maxPublishMode("normal", "normal")).toBe("normal");
  });
});

describe("foldGateResults", () => {
  it("is normal when every gate passed or was skipped", () => {
    expect(foldGateResults(buildGateResults({ tests: "passed" }))).toBe("normal");
    expect(foldGateResults(buildGateResults({}))).toBe("normal");
  });

  it("raises to draft on any draft gate", () => {
    expect(foldGateResults(buildGateResults({ tests: "draft" }))).toBe("draft");
  });

  it("does not resurrect the removed blocked gate tier", () => {
    expect(buildGateResults({ tests: "blocked" }).tests).toEqual({ decision: "skipped" });
    expect(foldGateResults(buildGateResults({ tests: "blocked" }))).toBe("normal");
  });
});

describe("deriveAuthoritativePublishMode", () => {
  const gates = (overrides: Record<string, string> = {}): GateResults => buildGateResults(overrides);

  it("fails closed to draft when the gate signal is absent (and flags mismatch vs a normal sandbox)", () => {
    expect(deriveAuthoritativePublishMode({ gateResults: undefined, sandboxMode: "normal" })).toEqual({
      publishMode: "draft",
      sandboxMode: "normal",
      mismatch: true,
      reason: "missing_signal",
      // No gate signal was folded, so gateFloor must stay null (never a fabricated
      // mode); no functional verdict was supplied, so functionalForcedDraft is false.
      gateFloor: null,
      functionalForcedDraft: false,
    });
  });

  it("reports functionalForcedDraft from the verdict even on the missing-signal path", () => {
    const result = deriveAuthoritativePublishMode({
      gateResults: undefined,
      functionalVerdict: "REFUTED",
      sandboxMode: "normal",
    });
    // gateFloor stays null (no gates), but the verdict is still surfaced.
    expect(result).toMatchObject({ reason: "missing_signal", gateFloor: null, functionalForcedDraft: true });
  });

  it("does not flag a mismatch when the missing-signal fallback equals the sandbox draft", () => {
    const result = deriveAuthoritativePublishMode({ gateResults: undefined, sandboxMode: "draft" });
    expect(result.publishMode).toBe("draft");
    expect(result.mismatch).toBe(false);
  });

  it("agrees with the sandbox on a clean pass → normal", () => {
    const result = deriveAuthoritativePublishMode({
      gateResults: gates({ tests: "passed" }),
      sandboxMode: "normal",
    });
    expect(result).toMatchObject({ publishMode: "normal", mismatch: false, reason: "agreement" });
  });

  it("clamps a too-permissive sandbox UP to the gate floor and flags the divergence", () => {
    // Gates say draft, but a buggy/compromised sandbox reported normal.
    const result = deriveAuthoritativePublishMode({
      gateResults: gates({ tests: "draft" }),
      sandboxMode: "normal",
    });
    // Gate-driven draft with no functional verdict: gateFloor carries the draft
    // fold and functionalForcedDraft is false.
    expect(result).toMatchObject({
      publishMode: "draft",
      mismatch: true,
      reason: "clamped_to_floor",
      gateFloor: "draft",
      functionalForcedDraft: false,
    });
  });

  it("passes a stricter sandbox mode through unchanged (failure path drafts despite skipped gates)", () => {
    const result = deriveAuthoritativePublishMode({
      gateResults: gates({}), // all skipped → floor normal
      sandboxMode: "draft",
    });
    expect(result).toMatchObject({ publishMode: "draft", mismatch: false, reason: "sandbox_stricter" });
  });

  it("raises the floor to draft when functional verification was refuted (no UI-only input)", () => {
    const result = deriveAuthoritativePublishMode({
      gateResults: gates({ tests: "passed" }),
      functionalVerdict: "REFUTED",
      sandboxMode: "normal",
    });
    // No `uiOnly` input, so the upgrade `else` is reached and the result clamps to
    // the floor. The gate fold was clean (`normal`); the draft came from functional
    // verification, now surfaced via gateFloor + functionalForcedDraft, not a
    // separate reason.
    expect(result).toMatchObject({
      publishMode: "draft",
      mismatch: true,
      reason: "clamped_to_floor",
      gateFloor: "normal",
      functionalForcedDraft: true,
    });
  });

  it.each(["REFUTED", "INCONCLUSIVE"] as const)(
    "clamps a functional-verification draft (%s) to the pure gate/verdict floor",
    (functionalVerdict) => {
      // This pure helper has no event-level UI evidence context. A draft floor
      // raised by functional verification always clamps here; the control-plane
      // wrapper owns any separate UI evidence exception.
      const result = deriveAuthoritativePublishMode({
        gateResults: gates({ tests: "passed" }), // floor normal from gates; functional raises it
        functionalVerdict,
        sandboxMode: "normal",
      });
      expect(result).toMatchObject({
        publishMode: "draft",
        mismatch: true,
        reason: "clamped_to_floor",
        gateFloor: "normal",
        functionalForcedDraft: true,
      });
    },
  );

  it("clamps a gate-only draft to the pure gate floor", () => {
    const result = deriveAuthoritativePublishMode({
      gateResults: gates({ tests: "draft" }), // gate-forced draft floor
      functionalVerdict: "CONFIRMED",
      sandboxMode: "normal",
    });
    expect(result).toMatchObject({
      publishMode: "draft",
      mismatch: true,
      reason: "clamped_to_floor",
      gateFloor: "draft",
      functionalForcedDraft: false,
    });
  });

  it.each(["REFUTED", "INCONCLUSIVE"] as const)(
    "attributes a draft floor to the gate when a gate also drafted alongside a %s verdict",
    (functionalVerdict) => {
      // Both a gate and functional verification independently force draft. The
      // gate fold alone was already draft, so the clamp is a gate clamp; the
      // functional reason is reserved for drafts functional verification ALONE
      // caused.
      const result = deriveAuthoritativePublishMode({
        gateResults: gates({ tests: "draft" }),
        functionalVerdict,
        sandboxMode: "normal",
      });
      expect(result).toMatchObject({
        publishMode: "draft",
        mismatch: true,
        reason: "clamped_to_floor",
        gateFloor: "draft",
        functionalForcedDraft: true,
      });
    },
  );
});

describe("normalizeGateResults", () => {
  it("accepts a complete, valid gate-results object", () => {
    const valid = buildGateResults({ tests: "draft" });
    expect(normalizeGateResults(valid)).toEqual(valid);
  });

  it("fails closed (undefined) for absent or non-object input", () => {
    expect(normalizeGateResults(undefined)).toBeUndefined();
    expect(normalizeGateResults(null)).toBeUndefined();
    expect(normalizeGateResults("draft")).toBeUndefined();
    expect(normalizeGateResults(42)).toBeUndefined();
  });

  it("fails closed when any closed gate is missing (incomplete signal)", () => {
    expect(normalizeGateResults({})).toBeUndefined();
  });

  it("fails closed when any gate decision is not a valid enum value", () => {
    const valid = buildGateResults({ tests: "passed" });
    const tampered = { ...valid, tests: { decision: "totally-normal-trust-me" } };
    expect(normalizeGateResults(tampered)).toBeUndefined();
  });

  it("keeps and truncates descriptive reasons, dropping non-string ones", () => {
    const base = buildGateResults({});
    const withReason = {
      ...base,
      tests: { decision: "draft", reason: "x".repeat(5_000) },
    };
    const result = normalizeGateResults(withReason);
    expect(result?.tests.reason).toHaveLength(2_000);
  });
});
