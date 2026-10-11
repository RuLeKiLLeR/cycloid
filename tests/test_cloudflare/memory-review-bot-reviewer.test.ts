import { describe, expect, it } from "vitest";

import {
  buildMemoryReviewInputFromContext,
  type MemoryReviewMemoryCatalog,
  selectEligibleMemoryUsageEvents,
} from "../../apps/control-plane-worker/src/memory-review-bot/review-service";
import {
  buildMemoryReviewSystemPrompt,
  parseMemoryReviewOutput,
  runMemoryReviewReviewer,
} from "../../apps/control-plane-worker/src/memory-review-bot/reviewer";
import {
  MEMORY_REVIEW_BOT_SCHEMA_VERSION,
  type MemoryReviewCompletedPromptContext,
  type MemoryReviewInput,
  type MemoryReviewUsageEvent,
} from "../../apps/control-plane-worker/src/memory-review-bot/types";
import { OpenAIServiceTier } from "../../shared/enums/openai-service-tier";

function baseInput(): MemoryReviewInput {
  return {
    schemaVersion: MEMORY_REVIEW_BOT_SCHEMA_VERSION,
    businessId: "biz-1",
    sessionId: "sess-1",
    promptId: "prompt-1",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    task: {
      promptText: "Add a small README edit.",
      title: "README edit",
      diffSummary: "Changed README only.",
      completedAtMs: 1_000,
    },
    returnedMemories: [
      {
        memoryId: "mem-1",
        source: "recall",
        lifecycleState: "active",
        scopeStatus: "in_scope",
        content: "Use webhook helper for webhook routes.",
        contextHint: "When editing webhooks",
        provenance: "pr-1",
        rank: 1,
        score: 0.91,
        explanation: "Matched README text incorrectly.",
        expectedEffect: "Use webhook helper.",
        observedEffect: null,
        intent: null,
        files: ["README.md"],
        symbols: [],
        evidenceIds: ["usage:mem-1", "memory:mem-1"],
      },
    ],
    evidence: [
      { id: "prompt", kind: "prompt", text: "Add a small README edit." },
      { id: "completion", kind: "completion", text: "Changed README only." },
      { id: "usage:mem-1", kind: "usage", memoryId: "mem-1", text: "source=recall; rank=1" },
      { id: "memory:mem-1", kind: "memory", memoryId: "mem-1", text: "Use webhook helper." },
    ],
    scopeDefects: [],
  };
}

function validOutput() {
  return {
    prompt_outcome: "false_positive",
    confidence: 0.87,
    summary: "The memory was unrelated to the README edit.",
    failure_code: null,
    memory_results: [
      {
        memory_id: "mem-1",
        relevance: "irrelevant",
        usefulness: "not_useful",
        effect: "neutral",
        lifecycle_state: "active",
        root_causes: ["retrieval"],
        evidence_ids: ["prompt", "usage:mem-1", "memory:mem-1"],
        rationale: "README-only task did not need webhook guidance.",
      },
    ],
  };
}

describe("memory review bot reviewer service tier", () => {
  it("routes the reviewer call to flex with a retry that absorbs a flex 429", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    await runMemoryReviewReviewer(
      {
        env: { ARCANIST_OPENAI_API_KEY: "sk-test" },
        telemetry: { subsystem: "memory_review_bot", callType: "review", phase: "memory", sourceId: "src" },
        input: baseInput(),
      },
      {
        queryStructuredOutput: async (_env, options) => {
          capturedOptions = options as Record<string, unknown>;
          return validOutput();
        },
      },
    );

    expect(capturedOptions?.serviceTier).toBe(OpenAIServiceTier.Flex);
    // A flex 429 (resource_unavailable) needs at least one retry to be absorbed, or the review drops.
    expect((capturedOptions?.retry as { maxAttempts?: number } | undefined)?.maxAttempts).toBeGreaterThanOrEqual(2);
  });
});

describe("memory review bot reviewer validation", () => {
  it("allows false negatives with no returned memories and no invented memory result", () => {
    const input = {
      ...baseInput(),
      returnedMemories: [],
      evidence: [
        { id: "prompt", kind: "prompt" as const, text: "Change replay page sizing." },
        { id: "memory", kind: "memory" as const, text: "Existing memory warned about replay limits." },
        { id: "completion", kind: "completion" as const, text: "The output unified replay limits." },
      ],
    };

    const result = parseMemoryReviewOutput(
      {
        prompt_outcome: "false_negative",
        confidence: 0.82,
        summary: "A relevant memory was missed by retrieval; no returned memory IDs are available to judge.",
        failure_code: null,
        memory_results: [],
      },
      input,
    );

    expect(result).toMatchObject({ ok: true });
  });

  it("tells the model not to invent memory result rows for missed memories", () => {
    const prompt = buildMemoryReviewSystemPrompt();

    expect(prompt).toContain("if returnedMemories is empty");
    expect(prompt).toContain("do not invent memory_results");
    expect(prompt).toContain("true_positive requires at least one returned memory marked useful");
    expect(prompt).toContain("Use false_positive rather than true_negative");
    expect(prompt).toContain("Use root_causes only as defect buckets");
    expect(prompt).toContain("Do not add retrieval merely because stale or superseded memory was surfaced");
    expect(prompt).toContain("Use effect=hurt only when evidence shows");
  });

  it("fails when the reviewer omits a returned memory result", () => {
    const result = parseMemoryReviewOutput({ ...validOutput(), memory_results: [] }, baseInput());
    expect(result).toMatchObject({ ok: false, failureCode: "missing_memory_result" });
  });

  it("fails when the reviewer returns an unknown memory ID", () => {
    const output = validOutput();
    output.memory_results[0].memory_id = "mem-unknown";

    const result = parseMemoryReviewOutput(output, baseInput());
    expect(result).toMatchObject({ ok: false, failureCode: "unknown_memory_id" });
  });

  it("fails when the reviewer fabricates evidence IDs", () => {
    const output = validOutput();
    output.memory_results[0].evidence_ids = ["prompt", "fabricated-evidence"];

    const result = parseMemoryReviewOutput(output, baseInput());
    expect(result).toMatchObject({ ok: false, failureCode: "fabricated_evidence_id" });
  });

  it("repairs common camelCase shape issues once", () => {
    const result = parseMemoryReviewOutput(
      {
        promptOutcome: "false_positive",
        confidence: "0.82",
        summary: "The memory was unrelated.",
        memoryResults: {
          "mem-1": {
            relevance: "irrelevant",
            usefulness: "not_useful",
            effect: "neutral",
            lifecycleState: "active",
            rootCauses: "retrieval",
            evidenceIds: "prompt",
            rationale: "README-only task did not need webhook guidance.",
          },
        },
      },
      baseInput(),
    );

    expect(result).toMatchObject({ ok: true, repaired: true });
  });
});

describe("memory review bot eligibility", () => {
  const context: MemoryReviewCompletedPromptContext = {
    businessId: "biz-1",
    sessionId: "sess-1",
    promptId: "prompt-1",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    promptText: "Investigate webhook handling.",
    title: "Webhook handling",
    diffSummary: "Updated webhook route.",
    success: true,
    completedAtMs: 10_000,
  };

  function usage(overrides: Partial<MemoryReviewUsageEvent>): MemoryReviewUsageEvent {
    return {
      id: crypto.randomUUID(),
      repoOwner: "trycycloid",
      repoName: "cycloid",
      sessionId: "sess-1",
      promptId: "prompt-1",
      memoryId: "mem-eligible",
      source: "recall",
      selectionRank: 1,
      selectionScore: 0.9,
      explanation: null,
      expectedEffect: null,
      observedEffect: null,
      intent: null,
      filesJson: null,
      symbolsJson: null,
      reviewOutcome: null,
      usedAtMs: 1_000,
      ...overrides,
    };
  }

  it("excludes failed prompts and non-production memory usage sources", () => {
    const events = [
      usage({ memoryId: "mem-eligible", source: "recall" }),
      usage({ memoryId: "mem-prompt-start", source: "prompt_start" }),
      usage({ memoryId: "mem-bootstrap", source: "company_bootstrap" }),
      usage({ memoryId: "mem-synthetic", source: "company_recall", promptId: "company-memory-recall" }),
      usage({ memoryId: "mem-bridge", source: "recall", promptId: "codex-message-1", usedAtMs: 9_000 }),
      usage({ memoryId: "mem-future", source: "recall", promptId: "codex-message-2", usedAtMs: 11_000 }),
      usage({
        memoryId: "mem-reasoning",
        source: "company_reasoning_chain",
        promptId: "company-memory-reasoning-chain",
      }),
      usage({ memoryId: "mem-company", source: "company_recall" }),
    ];

    expect(selectEligibleMemoryUsageEvents({ ...context, success: false }, events)).toEqual([]);
    expect(selectEligibleMemoryUsageEvents(context, events).map((event) => event.memoryId)).toEqual([
      "mem-eligible",
      "mem-bridge",
      "mem-company",
    ]);
  });

  it("builds input only from eligible recall and prompt-linked company recall", () => {
    const catalog: MemoryReviewMemoryCatalog = new Map([
      [
        "mem-eligible",
        {
          memoryId: "mem-eligible",
          source: "recall",
          lifecycleState: "active",
          scopeStatus: "in_scope",
          content: "Use webhook helper.",
          contextHint: "When webhook routes change",
          provenance: "repo memory",
        },
      ],
      [
        "mem-company",
        {
          memoryId: "mem-company",
          source: "company_recall",
          lifecycleState: "active",
          scopeStatus: "in_scope",
          content: "Customer webhooks need archival projection.",
          contextHint: "decision held by brain",
          provenance: "memory_facts:event-1",
        },
      ],
    ]);

    const result = buildMemoryReviewInputFromContext(
      context,
      [
        usage({ memoryId: "mem-eligible", source: "recall" }),
        usage({ memoryId: "mem-prompt-start", source: "prompt_start" }),
        usage({ memoryId: "mem-company", source: "company_recall" }),
        usage({ memoryId: "mem-other-repo", source: "recall", repoOwner: "other", repoName: "repo" }),
      ],
      catalog,
    );

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.input.returnedMemories.map((memory) => memory.memoryId)).toEqual([
      "mem-eligible",
      "mem-company",
      "mem-other-repo",
    ]);
    expect(result.input.returnedMemories.find((memory) => memory.memoryId === "mem-other-repo")).toMatchObject({
      scopeStatus: "out_of_scope",
      content: null,
    });
    expect(result.input.scopeDefects).toEqual([
      {
        memoryId: "mem-other-repo",
        source: "recall",
        reason: "repo_scope_mismatch",
        usageEvidenceId: "usage:mem-other-repo",
      },
    ]);
  });
});
