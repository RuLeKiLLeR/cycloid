import { describe, expect, it } from "vitest";

import { normalizeQuestionOption } from "../../apps/ui/src/utils/transcript.js";

describe("normalizeQuestionOption", () => {
  it("converts a plain string to { label }", () => {
    expect(normalizeQuestionOption("Continue working")).toEqual({ label: "Continue working" });
  });

  it("passes through an object with label and description", () => {
    const opt = { label: "Option A", description: "Do it this way" };
    expect(normalizeQuestionOption(opt)).toEqual(opt);
  });

  it("passes through an object with label only", () => {
    const opt = { label: "Option B" };
    expect(normalizeQuestionOption(opt)).toEqual({ label: "Option B" });
  });

  it("handles mixed options array", () => {
    const options: Array<string | { label: string; description?: string }> = [
      "Stop the agent",
      { label: "Continue", description: "Keep going" },
      { label: "Retry" },
    ];
    const normalized = options.map(normalizeQuestionOption);
    expect(normalized).toEqual([
      { label: "Stop the agent" },
      { label: "Continue", description: "Keep going" },
      { label: "Retry" },
    ]);
  });
});
