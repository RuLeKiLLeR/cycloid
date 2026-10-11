import type { PromptState } from "../types";

export type SessionStageTimingStage = "prompt_processing" | "unattributed";

export interface SessionStageTiming {
  stage: SessionStageTimingStage;
  durationMs: number;
}

type PromptTimingInput = Pick<PromptState, "startedAt" | "completedAt">;

type Interval = {
  startMs: number;
  endMs: number;
};

function toTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInterval(startMs: number, endMs: number, sessionStartMs: number, sessionEndMs: number): Interval | null {
  const clampedStartMs = Math.max(startMs, sessionStartMs);
  const clampedEndMs = Math.min(endMs, sessionEndMs);
  if (clampedEndMs <= clampedStartMs) return null;
  return { startMs: clampedStartMs, endMs: clampedEndMs };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const current = merged[merged.length - 1];
    if (!current || interval.startMs > current.endMs) {
      merged.push({ ...interval });
      continue;
    }
    current.endMs = Math.max(current.endMs, interval.endMs);
  }
  return merged;
}

export function deriveSessionStageTimings(params: {
  createdAt: string | null | undefined;
  closedAt: string | null | undefined;
  prompts: readonly PromptTimingInput[];
}): SessionStageTiming[] {
  const sessionStartMs = toTimestampMs(params.createdAt);
  const sessionEndMs = toTimestampMs(params.closedAt);
  if (sessionStartMs == null || sessionEndMs == null || sessionEndMs < sessionStartMs) return [];

  const processingIntervals = mergeIntervals(
    params.prompts.flatMap((prompt) => {
      const startedAtMs = toTimestampMs(prompt.startedAt);
      const completedAtMs = toTimestampMs(prompt.completedAt);
      if (startedAtMs == null || completedAtMs == null) return [];
      const interval = clampInterval(startedAtMs, completedAtMs, sessionStartMs, sessionEndMs);
      return interval ? [interval] : [];
    }),
  );

  const promptProcessingDurationMs = processingIntervals.reduce(
    (total, interval) => total + interval.endMs - interval.startMs,
    0,
  );
  const totalDurationMs = sessionEndMs - sessionStartMs;
  const unattributedDurationMs = Math.max(0, totalDurationMs - promptProcessingDurationMs);

  const timings: SessionStageTiming[] = [];
  if (promptProcessingDurationMs > 0) {
    timings.push({ stage: "prompt_processing", durationMs: promptProcessingDurationMs });
  }
  timings.push({ stage: "unattributed", durationMs: unattributedDurationMs });
  return timings;
}
