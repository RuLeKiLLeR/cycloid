import { describe, expect, it } from "vitest";

import { halfJitterBackoffMs } from "../../apps/control-plane-worker/src/utils/backoff";

describe("control-plane backoff utilities", () => {
  it("applies the existing DO retry 50%-100% jitter band and cap", () => {
    expect(halfJitterBackoffMs({ attempt: 0, baseMs: 100, maxMs: 5_000, random: () => 0 })).toBe(50);
    expect(halfJitterBackoffMs({ attempt: 2, baseMs: 100, maxMs: 5_000, random: () => 1 })).toBe(400);
    expect(halfJitterBackoffMs({ attempt: 20, baseMs: 100, maxMs: 5_000, random: () => 1 })).toBe(5_000);
  });
});
