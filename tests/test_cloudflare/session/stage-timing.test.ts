import { describe, expect, it } from "vitest";

import { deriveSessionStageTimings } from "../../../apps/control-plane-worker/src/session/stage-timing";

describe("deriveSessionStageTimings", () => {
  it("merges overlapping prompt-processing intervals into one wall-clock rollup", () => {
    const timings = deriveSessionStageTimings({
      createdAt: "2026-07-01T00:00:00.000Z",
      closedAt: "2026-07-01T00:00:20.000Z",
      prompts: [
        {
          startedAt: "2026-07-01T00:00:01.000Z",
          completedAt: "2026-07-01T00:00:07.000Z",
        },
        {
          startedAt: "2026-07-01T00:00:05.000Z",
          completedAt: "2026-07-01T00:00:12.000Z",
        },
        {
          startedAt: "2026-07-01T00:00:15.000Z",
          completedAt: "2026-07-01T00:00:18.000Z",
        },
      ],
    });

    expect(timings).toEqual([
      { stage: "prompt_processing", durationMs: 14_000 },
      { stage: "unattributed", durationMs: 6_000 },
    ]);
  });

  it("clips prompt-processing intervals to the session window and ignores invalid spans", () => {
    const timings = deriveSessionStageTimings({
      createdAt: "2026-07-01T00:00:00.000Z",
      closedAt: "2026-07-01T00:00:10.000Z",
      prompts: [
        {
          startedAt: "2026-06-30T23:59:55.000Z",
          completedAt: "2026-07-01T00:00:02.000Z",
        },
        {
          startedAt: "2026-07-01T00:00:02.000Z",
          completedAt: "2026-07-01T00:00:12.000Z",
        },
        {
          startedAt: "2026-07-01T00:00:08.000Z",
          completedAt: "2026-07-01T00:00:06.000Z",
        },
        {
          startedAt: null,
          completedAt: "2026-07-01T00:00:05.000Z",
        },
      ],
    });

    expect(timings).toEqual([
      { stage: "prompt_processing", durationMs: 10_000 },
      { stage: "unattributed", durationMs: 0 },
    ]);
  });

  it("returns no stage timings when the session is missing terminal bounds", () => {
    expect(
      deriveSessionStageTimings({
        createdAt: "2026-07-01T00:00:00.000Z",
        closedAt: null,
        prompts: [],
      }),
    ).toEqual([]);
  });
});
