import { describe, expect, it } from "vitest";

import { SANDBOX_HEARTBEAT_LIVENESS_MS } from "../../../apps/control-plane-worker/src/constants/sessions";
import { evaluateSandboxHeartbeatFreshness } from "../../../apps/control-plane-worker/src/session/lifecycle/heartbeat-freshness";

const NOW = 1_750_000_000_000;

describe("evaluateSandboxHeartbeatFreshness", () => {
  it("is fresh for a recent heartbeat", () => {
    expect(evaluateSandboxHeartbeatFreshness({ lastHeartbeatAt: NOW - 1_000 }, NOW)).toEqual({
      lastHeartbeatAt: NOW - 1_000,
      ageMs: 1_000,
      fresh: true,
    });
  });

  it("is fresh exactly at the liveness bound and stale just past it", () => {
    const atBound = NOW - SANDBOX_HEARTBEAT_LIVENESS_MS;
    expect(evaluateSandboxHeartbeatFreshness({ lastHeartbeatAt: atBound }, NOW).fresh).toBe(true);
    expect(evaluateSandboxHeartbeatFreshness({ lastHeartbeatAt: atBound - 1 }, NOW).fresh).toBe(false);
  });

  it("tolerates future timestamps only within the liveness bound", () => {
    expect(evaluateSandboxHeartbeatFreshness({ lastHeartbeatAt: NOW + 5_000 }, NOW).fresh).toBe(true);
    expect(
      evaluateSandboxHeartbeatFreshness({ lastHeartbeatAt: NOW + SANDBOX_HEARTBEAT_LIVENESS_MS + 1 }, NOW).fresh,
    ).toBe(false);
  });

  it("fails closed when no heartbeat is recorded", () => {
    for (const record of [undefined, null, {}, { lastHeartbeatAt: null }, { lastHeartbeatAt: undefined }]) {
      expect(evaluateSandboxHeartbeatFreshness(record, NOW)).toEqual({
        lastHeartbeatAt: null,
        ageMs: null,
        fresh: false,
      });
    }
  });

  it("fails closed on malformed records and non-finite timestamps", () => {
    for (const record of [
      "ready",
      42,
      ["lastHeartbeatAt"],
      { lastHeartbeatAt: "recent" },
      { lastHeartbeatAt: Number.NaN },
      { lastHeartbeatAt: Number.POSITIVE_INFINITY },
    ]) {
      expect(evaluateSandboxHeartbeatFreshness(record, NOW).fresh).toBe(false);
    }
  });
});
