import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../apps/ui/src/types";
import { formatThinkingDuration, reasoningSummaryLabel } from "../../apps/ui/src/utils/transcript.js";

function reasoning(
  partial: Partial<Extract<ActivityEvent, { type: "reasoning" }>>,
): Extract<ActivityEvent, { type: "reasoning" }> {
  return { type: "reasoning", id: "r1", text: "thinking", ...partial };
}

describe("formatThinkingDuration", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatThinkingDuration(0)).toBe("0s");
    expect(formatThinkingDuration(7000)).toBe("7s");
    expect(formatThinkingDuration(59_400)).toBe("59s");
  });

  it("renders minute-plus durations as minutes and seconds", () => {
    expect(formatThinkingDuration(60_000)).toBe("1m");
    expect(formatThinkingDuration(65_000)).toBe("1m 5s");
    expect(formatThinkingDuration(150_000)).toBe("2m 30s");
  });
});

describe("reasoningSummaryLabel", () => {
  it("shows the measured duration once a block spans at least a second", () => {
    expect(reasoningSummaryLabel(reasoning({ startedAtMs: 1000, endedAtMs: 8000 }), false)).toBe("Thought for 7s");
    // Past tense regardless of session activity so completed blocks aren't mislabeled.
    expect(reasoningSummaryLabel(reasoning({ startedAtMs: 1000, endedAtMs: 8000 }), true)).toBe("Thought for 7s");
  });

  it("falls back to a verb label when timing is missing or sub-second", () => {
    expect(reasoningSummaryLabel(reasoning({}), true)).toBe("thinking…");
    expect(reasoningSummaryLabel(reasoning({}), false)).toBe("Thought");
    expect(reasoningSummaryLabel(reasoning({ startedAtMs: 1000, endedAtMs: 1500 }), true)).toBe("thinking…");
  });
});
