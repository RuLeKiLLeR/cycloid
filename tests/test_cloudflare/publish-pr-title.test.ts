import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryPlatformStructuredOutput: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/platform-structured-output.js", () => ({
  queryPlatformStructuredOutput: mocks.queryPlatformStructuredOutput,
}));

import {
  buildPublishPrTitlePrompt,
  generatePublishPrTitle,
  normalizePublishPrTitleEvidenceForPrompt,
  PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS,
  PUBLISH_PR_TITLE_MODEL,
} from "../../apps/control-plane-worker/src/services/publish-pr-title.js";
import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../shared/constants/models.js";

describe("normalizePublishPrTitleEvidenceForPrompt", () => {
  it("downsamples changed files with first-seen top-level directory diversity", () => {
    const evidence = normalizePublishPrTitleEvidenceForPrompt({
      currentTitle: "Changes from Cycloid",
      changedFiles: ["apps/ui/src/a.ts", "apps/ui/src/b.ts", "shared/utils/a.ts", "docs/a.md", "infra/main.tf"],
      diffStats: { filesChanged: 5, insertions: 10, deletions: 2 },
    });

    expect(evidence?.changedFiles?.slice(0, 4)).toEqual([
      "apps/ui/src/a.ts",
      "shared/utils/a.ts",
      "docs/a.md",
      "infra/main.tf",
    ]);
  });

  it("keeps the fully formatted prompt within the context cap for long evidence", () => {
    const evidence = normalizePublishPrTitleEvidenceForPrompt({
      currentTitle: "x".repeat(400),
      diffSummary: "Summary ".repeat(2_000),
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      changedFiles: Array.from(
        { length: 60 },
        (_, index) => `dir-${index % 40}/very/long/path/component/${"nested-".repeat(20)}file-${index}.ts`,
      ),
      diffStats: {
        raw: "raw stats ".repeat(1_000),
        filesChanged: 60,
        insertions: 5_000,
        deletions: 4_000,
      },
    });

    expect(evidence).not.toBeNull();
    expect(buildPublishPrTitlePrompt(evidence!).length).toBeLessThanOrEqual(PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS);
  });
});

describe("generatePublishPrTitle", () => {
  it("generates from large diffs after evidence normalization", async () => {
    mocks.queryPlatformStructuredOutput.mockResolvedValueOnce({ title: "Normalize publish title evidence" });

    const title = await generatePublishPrTitle(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        currentTitle: "Changes from Cycloid",
        diffSummary: "Large title evidence normalization",
        changedFiles: Array.from({ length: 60 }, (_, index) => `pkg-${index}/src/file.ts`),
        diffStats: { filesChanged: 60, insertions: 2_000, deletions: 1_000 },
      },
      { sessionId: "session-1", promptId: "prompt-1" },
    );

    expect(title).toBe("Normalize publish title evidence");
    expect(mocks.queryPlatformStructuredOutput).toHaveBeenCalledOnce();
    const options = mocks.queryPlatformStructuredOutput.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      model: PUBLISH_PR_TITLE_MODEL,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      maxTokens: 120,
    });
    const userPrompt = options?.userPrompt as string;
    expect(userPrompt.length).toBeLessThanOrEqual(PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS);
  });
});
