// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import {
  computeCompactionTokensReclaimed,
  computeOutputTokensPerSecondSample,
  shouldEmitClaudeRateLimitedMetric,
} from "../../apps/sandbox-bridge/src/services/agent-observability.js";

describe("agent-observability helpers", () => {
  it("computes output tokens/sec from cumulative observations", () => {
    expect(
      computeOutputTokensPerSecondSample(
        { atMs: 1_000, outputTokens: 120, model: "gpt-5.5" },
        { atMs: 3_000, outputTokens: 200, model: "gpt-5.5" },
      ),
    ).toEqual({
      outputTokensPerSecond: 40,
      outputTokens: 80,
      durationMs: 2_000,
      model: "gpt-5.5",
    });
  });

  it("skips zero-duration and non-growing output observations", () => {
    expect(
      computeOutputTokensPerSecondSample(
        { atMs: 1_000, outputTokens: 120, model: "gpt-5.5" },
        { atMs: 1_000, outputTokens: 160, model: "gpt-5.5" },
      ),
    ).toBeNull();
    expect(
      computeOutputTokensPerSecondSample(
        { atMs: 1_000, outputTokens: 120, model: "gpt-5.5" },
        { atMs: 2_000, outputTokens: 120, model: "gpt-5.5" },
      ),
    ).toBeNull();
  });

  it("computes reclaimed compaction tokens without going negative", () => {
    expect(computeCompactionTokensReclaimed(800, 250)).toBe(550);
    expect(computeCompactionTokensReclaimed(250, 800)).toBe(0);
  });

  it("only emits Claude rate-limit telemetry for non-allowed statuses", () => {
    expect(shouldEmitClaudeRateLimitedMetric({ status: "allowed" })).toBe(false);
    expect(shouldEmitClaudeRateLimitedMetric({ status: "rate_limited" })).toBe(true);
    expect(shouldEmitClaudeRateLimitedMetric(undefined)).toBe(false);
  });
});
