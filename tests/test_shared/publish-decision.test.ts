import { describe, expect, it } from "vitest";

import { type PublishSignals, resolvePublishVerdict } from "../../shared/publish-decision.js";

function signals(overrides: Partial<PublishSignals> = {}): PublishSignals {
  return {
    warnReasons: [],
    ...overrides,
  };
}

describe("resolvePublishVerdict", () => {
  it("returns CONFIRMED by default when no bad-news signal is present", () => {
    expect(resolvePublishVerdict(signals())).toBe("CONFIRMED");
  });

  it("returns INCONCLUSIVE on a warn reason", () => {
    expect(resolvePublishVerdict(signals({ warnReasons: ["a human should look"] }))).toBe("INCONCLUSIVE");
  });

  it("ignores whitespace-only warn reasons", () => {
    expect(resolvePublishVerdict(signals({ warnReasons: ["", "  "] }))).toBe("CONFIRMED");
  });

  it("returns INCONCLUSIVE on a manual-review reason", () => {
    expect(resolvePublishVerdict(signals({ manualReviewReason: "agent requested review" }))).toBe("INCONCLUSIVE");
  });

  it("ignores a whitespace-only manual-review reason", () => {
    expect(resolvePublishVerdict(signals({ manualReviewReason: "   " }))).toBe("CONFIRMED");
  });

  it("returns the forced verdict when set (INCONCLUSIVE)", () => {
    expect(resolvePublishVerdict(signals({ forcedVerdict: "INCONCLUSIVE" }))).toBe("INCONCLUSIVE");
  });

  it("returns the forced verdict when set (REFUTED)", () => {
    expect(resolvePublishVerdict(signals({ forcedVerdict: "REFUTED" }))).toBe("REFUTED");
  });

  it("short-circuits on a forced verdict before evaluating soft signals", () => {
    // forced REFUTED wins even though the soft signals alone would only be INCONCLUSIVE
    expect(resolvePublishVerdict(signals({ forcedVerdict: "REFUTED", warnReasons: ["look here"] }))).toBe("REFUTED");
  });
});
