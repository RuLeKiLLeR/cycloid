import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";

const { mockQueryOpenAIStructuredOutput } = vi.hoisted(() => ({
  mockQueryOpenAIStructuredOutput: vi.fn(),
}));

vi.mock("../../shared/llm/structured-output.js", () => ({
  queryOpenAIStructuredOutput: mockQueryOpenAIStructuredOutput,
}));

import { adjudicateMemoryPair } from "../../apps/control-plane-worker/src/company-memory/adjudicate";

describe("company memory adjudicate", () => {
  beforeEach(() => {
    mockQueryOpenAIStructuredOutput.mockReset();
  });

  it("requests three total structured-output attempts", async () => {
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      classification: "same_memory",
      confidence: 0.91,
      proposed_action: "no_action",
      rationale: "Both claims describe the same decision.",
      cited_memory_ids: ["mem-1", "mem-2"],
    });

    await expect(
      adjudicateMemoryPair({ ARCANIST_OPENAI_API_KEY: "sk-openai" } as Env, {
        businessId: "biz-1",
        memories: [
          {
            id: "mem-1",
            store: "d1",
            claim: "Use D1 for payments.",
            sourceTimeMs: 1_712_345_678_000,
            sourceUri: "slack://T1/C1/1712345678.000100",
          },
          {
            id: "mem-2",
            store: "repo",
            claim: "Use D1 for payments.",
            sourceTimeMs: 1_712_345_679_000,
            sourceUri: "https://github.com/trycycloid/cycloid/pull/123",
          },
        ],
      }),
    ).resolves.toMatchObject({ classification: "same_memory", confidence: 0.91 });

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        retry: { maxAttempts: 3 },
        spanName: "company_memory.adjudicate",
      }),
    );
  });
});
