import { describe, expect, it } from "vitest";

import { computeHeartbeatStall } from "../../apps/sandbox-bridge/src/services/heartbeat-stall.ts";

describe("computeHeartbeatStall", () => {
  const interval = 30_000;

  it("returns null for an on-time tick", () => {
    expect(computeHeartbeatStall(30_000, interval)).toBeNull();
  });

  it("returns null for normal jitter under 2x the interval", () => {
    expect(computeHeartbeatStall(45_000, interval)).toBeNull();
    expect(computeHeartbeatStall(59_999, interval)).toBeNull();
  });

  it("flags a stall at or beyond 2x the interval (a tick was dropped)", () => {
    expect(computeHeartbeatStall(60_000, interval)).toEqual({ actualGapMs: 60_000, driftMs: 30_000 });
  });

  it("reports the full drift for a long CPU-starvation gap", () => {
    // e.g. event loop blocked by a heavy build for ~2.5 min
    expect(computeHeartbeatStall(150_000, interval)).toEqual({ actualGapMs: 150_000, driftMs: 120_000 });
  });

  it("is defensive against bad inputs", () => {
    expect(computeHeartbeatStall(Number.NaN, interval)).toBeNull();
    expect(computeHeartbeatStall(60_000, 0)).toBeNull();
    expect(computeHeartbeatStall(60_000, Number.NaN)).toBeNull();
  });
});
