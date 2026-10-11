import { describe, expect, it } from "vitest";

import { additiveJitterBackoffMs, multiplicativeJitterBackoffMs } from "../../apps/sandbox-bridge/src/utils/backoff";

describe("sandbox bridge backoff utilities", () => {
  it("preserves additive jitter after the capped exponential base", () => {
    expect(
      additiveJitterBackoffMs({
        attempt: 1,
        attemptOffset: 1,
        baseMs: 1_000,
        maxBaseMs: 8_000,
        jitterMs: 1_000,
        random: () => 0.25,
      }),
    ).toBe(1_250);
    expect(
      additiveJitterBackoffMs({
        attempt: 10,
        attemptOffset: 1,
        baseMs: 1_000,
        maxBaseMs: 8_000,
        jitterMs: 1_000,
        random: () => 1,
      }),
    ).toBe(9_000);
  });

  it("preserves multiplicative jitter with rounded capped results", () => {
    expect(
      multiplicativeJitterBackoffMs({
        attempt: 3,
        attemptOffset: 1,
        baseMs: 2_000,
        maxMs: 30_000,
        jitterFactor: 0.25,
        random: () => 1,
      }),
    ).toBe(10_000);
    expect(
      multiplicativeJitterBackoffMs({
        attempt: 10,
        attemptOffset: 1,
        baseMs: 2_000,
        maxMs: 30_000,
        jitterFactor: 0.25,
        random: () => 1,
      }),
    ).toBe(30_000);
  });
});
