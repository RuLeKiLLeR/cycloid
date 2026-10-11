import { describe, expect, it } from "vitest";

import { additiveRatioBackoffMs, multiplierRangeBackoffMs } from "../../apps/ui/src/utils/backoff";

describe("ui backoff utilities", () => {
  it("preserves additive ratio jitter and cap", () => {
    expect(additiveRatioBackoffMs({ delayMs: 1_000, maxMs: 30_000, jitterRatio: 0.2, random: () => 1 })).toBe(1_200);
    expect(additiveRatioBackoffMs({ delayMs: 30_000, maxMs: 30_000, jitterRatio: 0.2, random: () => 1 })).toBe(30_000);
  });

  it("preserves symmetric multiplier jitter with a hard cap", () => {
    expect(
      multiplierRangeBackoffMs({
        delayMs: 1_000,
        maxMs: 10_000,
        minMultiplier: 0.5,
        maxMultiplier: 1.5,
        random: () => 0,
      }),
    ).toBe(500);
    expect(
      multiplierRangeBackoffMs({
        delayMs: 10_000,
        maxMs: 10_000,
        minMultiplier: 0.5,
        maxMultiplier: 1.5,
        random: () => 1,
      }),
    ).toBe(10_000);
  });
});
