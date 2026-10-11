import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQueryOpenAIStructuredOutput } = vi.hoisted(() => ({
  mockQueryOpenAIStructuredOutput: vi.fn(),
}));

vi.mock("../../shared/llm/structured-output.js", () => ({
  StructuredOutputError: class StructuredOutputError extends Error {},
  queryOpenAIStructuredOutput: mockQueryOpenAIStructuredOutput,
}));

import { coerceRepoMemoryJudgment, judgeRepoMemorySuggestion } from "../../apps/control-plane-worker/src/memory/judge";

function judgeInput() {
  return {
    apiKey: "sk-openai",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    sourcePrNumber: 123,
    sourceSessionIds: ["sess-1"],
    episodeSummary: null,
    candidateAudit: [],
    existingMemories: [],
    change: {
      kind: "add" as const,
      targetMemoryId: null,
      candidate: { content: "When changing memory logic, use existing structured output retry." },
      memory: null,
    },
  };
}

describe("repo memory judge", () => {
  beforeEach(() => {
    mockQueryOpenAIStructuredOutput.mockReset();
  });

  it("requests three total structured-output attempts", async () => {
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.82,
      rationale: "Grounded and durable.",
      issues: [],
    });

    await expect(
      judgeRepoMemorySuggestion({
        apiKey: "sk-openai",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        sourcePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        sourcePrNumber: 123,
        sourceSessionIds: ["sess-1"],
        episodeSummary: null,
        candidateAudit: [],
        existingMemories: [],
        change: {
          kind: "add",
          targetMemoryId: null,
          candidate: { content: "When changing memory logic, use existing structured output retry." },
          memory: null,
        },
      }),
    ).resolves.toMatchObject({ verdict: "store", confidence: 0.82 });

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        retry: { maxAttempts: 3 },
        spanName: "repo_memory.judge",
      }),
    );
  });

  it("documents the calibrated audit-only confidence scale in the system prompt", async () => {
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.6,
      rationale: "Grounded.",
      issues: [],
    });

    await judgeRepoMemorySuggestion(judgeInput());

    // Position-safe: assert against the call args directly so a change in the
    // wrapper's argument order surfaces as a clear "not called with" diff rather
    // than a silent `undefined.toContain`.
    for (const phrase of [
      "calibrated 0.0-1.0 probability that the memory is still correct and useful in ~6 months",
      "audit-only",
      "store result below 0.5 will not persist",
      "Reserve confidence above 0.8",
    ]) {
      expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: expect.stringContaining(phrase) }),
      );
    }
  });

  it("marks low-confidence store verdicts for audit-only persistence", async () => {
    const lowConfStore = coerceRepoMemoryJudgment({
      verdict: "store",
      confidence: 0.1,
      rationale: "Sound but uncertain.",
      issues: [],
    });
    expect(lowConfStore).toMatchObject({ verdict: "store", confidence: 0.1, belowConfidenceFloor: true });

    const highConfReject = coerceRepoMemoryJudgment({
      verdict: "reject",
      confidence: 0.95,
      rationale: "Confidently not a memory.",
      issues: [],
    });
    expect(highConfReject).toMatchObject({ verdict: "reject", confidence: 0.95 });
  });

  it("clamps out-of-range confidence into [0, 1]", () => {
    expect(
      coerceRepoMemoryJudgment({ verdict: "store", confidence: 1.7, rationale: "x", issues: [] })?.confidence,
    ).toBe(1);
    expect(
      coerceRepoMemoryJudgment({ verdict: "store", confidence: -0.4, rationale: "x", issues: [] })?.confidence,
    ).toBe(0);
  });
});
