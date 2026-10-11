import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { MEMORY_REVIEW_BOT_TOOL } from "../../apps/control-plane-worker/src/memory-review-bot/reviewer";
import {
  expectedLabelsToReviewerOutput,
  loadMemoryReviewBotFixtures,
  MemoryReviewBotFixtureValidationError,
  validateMemoryReviewBotFixture,
} from "./eval-loader";
import {
  buildMemoryReviewBotReviewerInput,
  buildProductionMemoryReviewInputFromFixture,
  createMemoryReviewBotOracleBaselineReviewer,
  createProductionMemoryReviewBotReviewer,
  runMemoryReviewBotFixtures,
} from "./eval-runner";
import {
  MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION,
  type MemoryReviewBotEvalFixture,
  type MemoryReviewBotReviewerOutput,
} from "./eval-schema";
import {
  scoreConfusionExact,
  scoreEvidenceValid,
  scoreFalsePositiveHurtExact,
  scoreItemLabelsExact,
  scoreLifecycleExact,
  scoreRootCauseExact,
  scoreSchemaValid,
} from "./eval-scorers";

const execFileAsync = promisify(execFile);

describe("memory review bot eval fixtures", () => {
  it("loads visible tuning fixtures and passes the oracle baseline", async () => {
    const fixtures = await loadMemoryReviewBotFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    expect(
      fixtures.every((fixture) => fixture.fixture_source === "production" || fixture.fixture_source === "synthetic"),
    ).toBe(true);

    const reviewer = createMemoryReviewBotOracleBaselineReviewer(fixtures);
    const results = await runMemoryReviewBotFixtures(fixtures, reviewer);

    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.flatMap((result) => result.failed_scorers)).toEqual([]);
  });

  it("maps fixtures into the production reviewer input shape without adding eval-only evidence IDs", () => {
    const fixture = validFixture();
    const input = buildProductionMemoryReviewInputFromFixture(fixture);

    expect(input.schemaVersion).toBe("memory-review-bot-output-v1");
    expect(input.task).toMatchObject({
      promptText: fixture.prompt.bounded_prompt,
      title: fixture.prompt.task_summary,
      diffSummary: fixture.prompt.outcome_summary,
    });
    expect(input.returnedMemories).toEqual([
      expect.objectContaining({
        memoryId: "mem-1",
        source: "recall",
        lifecycleState: "active",
        content: "Review delivery failures retry independently after persistence.",
        evidenceIds: ["ev_memory"],
      }),
    ]);
    expect(input.evidence.map((entry) => entry.id).sort()).toEqual(["ev_memory", "ev_output"]);
    expect(input.evidence.find((entry) => entry.id === "ev_memory")).toMatchObject({ memoryId: "mem-1" });
    expect(input.evidence.find((entry) => entry.id === "ev_memory")?.text).toContain("source_ref=mem-1");
  });

  it("maps generic fixture memory evidence onto memories without direct source refs", () => {
    const fixture = validFixture();
    fixture.evidence = [
      {
        evidence_id: "ev_memory_generic",
        kind: "memory",
        snippet: "The memory snapshot documented review delivery retries.",
      },
    ];

    const input = buildProductionMemoryReviewInputFromFixture(fixture);

    expect(input.returnedMemories[0]?.evidenceIds).toEqual(["ev_memory_generic"]);
  });

  it("runs fixture evals through the production reviewer prompt schema and validator", async () => {
    const fixture = validFixture();
    const reviewer = createProductionMemoryReviewBotReviewer(
      { apiKey: "test-key", model: "test-model", promptVersion: "test-prompt" },
      {
        queryStructuredOutput: async (_env, options) => {
          const productionInput = JSON.parse(options.userPrompt) as { returnedMemories: { memoryId: string }[] };
          expect(options.model).toBe("test-model");
          expect(options.tool.name).toBe("submit_memory_review");
          expect(productionInput.returnedMemories.map((memory) => memory.memoryId)).toEqual(["mem-1"]);
          return {
            prompt_outcome: "true_positive",
            confidence: 0.88,
            summary: "The production reviewer found the memory useful.",
            failure_code: null,
            memory_results: [
              {
                memory_id: "mem-1",
                relevance: "relevant",
                usefulness: "useful",
                effect: "helped",
                lifecycle_state: "active",
                root_causes: ["retrieval"],
                evidence_ids: ["ev_output"],
                rationale: "The output used the retry guidance.",
              },
            ],
          };
        },
      },
    );

    const result = await reviewer(buildMemoryReviewBotReviewerInput(fixture));

    expect(result).toMatchObject({
      metadata: { model: "test-model", prompt_version: "test-prompt" },
      output: { prompt_outcome: "true_positive" },
    });
  });

  it("fails production fixture evals when the production validator rejects model output", async () => {
    const fixture = validFixture();
    const reviewer = createProductionMemoryReviewBotReviewer(
      { apiKey: "test-key", model: "test-model" },
      {
        queryStructuredOutput: async () => ({
          ...expectedLabelsToReviewerOutput(fixture),
          memory_results: [{ ...fixture.expected.memory_results[0], evidence_ids: ["ev_fabricated"] }],
        }),
      },
    );

    await expect(reviewer(buildMemoryReviewBotReviewerInput(fixture))).rejects.toThrow(
      "Production memory reviewer failed for unit-fixture: fabricated_evidence_id",
    );
  });

  it("allows the successful null failure_code shape in the production structured output schema", () => {
    const schema = MEMORY_REVIEW_BOT_TOOL.input_schema as unknown as {
      properties: { failure_code: { type: unknown; enum: unknown[] } };
    };

    expect(schema.properties.failure_code.type).toEqual(["string", "null"]);
    expect(schema.properties.failure_code.enum).toContain(null);
  });

  it("refuses to fall back to oracle when production reviewer mode has no API key", async () => {
    await expectEvalScriptFailure(
      ["--mode", "tuning", "--reviewer", "production"],
      "Production reviewer mode requires --api-key, ARCANIST_OPENAI_API_KEY, or OPENAI_API_KEY. Refusing to use the oracle baseline.",
    );
  });

  it("refuses to run hidden verify with the oracle reviewer", async () => {
    await expectEvalScriptFailure(
      ["--mode", "verify"],
      "Verify mode requires --reviewer production. Refusing to run the oracle baseline as a gate.",
    );
  });

  it("rejects invalid fixture enums", () => {
    const raw = rawFixture();
    const expected = raw.expected as Record<string, unknown>;
    raw.expected = { ...expected, prompt_outcome: "mixed" };

    expect(() => validateMemoryReviewBotFixture(raw)).toThrow(MemoryReviewBotFixtureValidationError);
    try {
      validateMemoryReviewBotFixture(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryReviewBotFixtureValidationError);
      expect((error as MemoryReviewBotFixtureValidationError).reasonCodes).toContain("invalid_enum");
    }
  });

  it("rejects fabricated expected evidence IDs", () => {
    const raw = rawFixture();
    const expected = raw.expected as Record<string, unknown>;
    raw.expected = { ...expected, evidence_ids: ["ev_missing"] };

    try {
      validateMemoryReviewBotFixture(raw);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryReviewBotFixtureValidationError);
      expect((error as MemoryReviewBotFixtureValidationError).reasonCodes).toContain("fabricated_evidence_id");
    }
  });

  it("rejects fixture snippets that look like unredacted secrets", () => {
    const raw = rawFixture();
    const evidence = raw.evidence as unknown[];
    raw.evidence = [
      ...evidence,
      {
        evidence_id: "ev_secret",
        kind: "output",
        snippet: "The captured output included api_key=sk-thiswouldbeasecretvalue and must be redacted.",
      },
    ];

    try {
      validateMemoryReviewBotFixture(raw);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryReviewBotFixtureValidationError);
      expect((error as MemoryReviewBotFixtureValidationError).reasonCodes).toContain("secret_detected");
    }
  });
});

describe("memory review bot scorers", () => {
  it("schema_valid fails on missing memory results", () => {
    const fixture = validFixture();
    const actual = expectedLabelsToReviewerOutput(fixture);
    actual.memory_results = [];

    const score = scoreSchemaValid(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("missing_memory_result");
  });

  it("schema_valid fails on invalid enums", () => {
    const fixture = validFixture();
    const actual = { ...expectedLabelsToReviewerOutput(fixture), prompt_outcome: "mixed" };

    const score = scoreSchemaValid(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("invalid_enum");
  });

  it("evidence_valid fails on fabricated evidence IDs", () => {
    const fixture = validFixture();
    const actual = withMemoryResult(fixture, { evidence_ids: ["ev_fake"] });

    const score = scoreEvidenceValid(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("fabricated_evidence_id");
  });

  it("evidence_valid fails when substantive labels cite no evidence", () => {
    const fixture = validFixture();
    const actual = withMemoryResult(fixture, { evidence_ids: [] });

    const score = scoreEvidenceValid(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("missing_required_evidence");
  });

  it("confusion_exact reports confusion mismatches", () => {
    const fixture = validFixture();
    const actual = { ...expectedLabelsToReviewerOutput(fixture), prompt_outcome: "false_positive" as const };

    const score = scoreConfusionExact(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("confusion_mismatch");
  });

  it("item_labels_exact reports relevance, usefulness, and effect mismatches", () => {
    const fixture = validFixture();
    const actual = withMemoryResult(fixture, {
      relevance: "irrelevant",
      usefulness: "not_useful",
      effect: "neutral",
    });

    const score = scoreItemLabelsExact(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("relevance_mismatch");
    expect(score.reason_codes).toContain("usefulness_mismatch");
    expect(score.reason_codes).toContain("effect_mismatch");
  });

  it("item_labels_exact tolerates inactive neutral borderline relevance boundaries", () => {
    const fixture = validFixture({
      memoryResult: {
        relevance: "borderline",
        usefulness: "not_useful",
        effect: "neutral",
        lifecycle_state: "superseded",
        root_causes: ["stale_memory"],
      },
    });
    const actual = withMemoryResult(fixture, { relevance: "irrelevant" });

    const score = scoreItemLabelsExact(fixture, actual);

    expect(score.passed).toBe(true);
    expect(score.reason_codes).toEqual([]);
  });

  it("false_positive_hurt_exact reports hurt subtype mismatches", () => {
    const fixture = validFixture({
      promptOutcome: "false_positive",
      memoryResult: {
        relevance: "irrelevant",
        usefulness: "not_useful",
        effect: "hurt",
        root_causes: ["retrieval"],
      },
    });
    const actual = withMemoryResult(fixture, { effect: "neutral" });

    const score = scoreFalsePositiveHurtExact(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("false_positive_hurt_mismatch");
  });

  it("root_cause_exact reports root cause mismatches", () => {
    const fixture = validFixture();
    const actual = withMemoryResult(fixture, { root_causes: ["agent_usage"] });

    const score = scoreRootCauseExact(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("root_cause_mismatch");
  });

  it("lifecycle_exact reports lifecycle mismatches", () => {
    const fixture = validFixture();
    const actual = withMemoryResult(fixture, { lifecycle_state: "superseded" });

    const score = scoreLifecycleExact(fixture, actual);

    expect(score.passed).toBe(false);
    expect(score.reason_codes).toContain("lifecycle_mismatch");
  });
});

function validFixture(
  options: {
    promptOutcome?: MemoryReviewBotEvalFixture["expected"]["prompt_outcome"];
    memoryResult?: Partial<MemoryReviewBotEvalFixture["expected"]["memory_results"][number]>;
  } = {},
): MemoryReviewBotEvalFixture {
  const memoryResult = {
    memory_id: "mem-1",
    relevance: "relevant",
    usefulness: "useful",
    effect: "helped",
    lifecycle_state: "active",
    root_causes: ["retrieval"],
    evidence_ids: ["ev_output"],
    rationale: "The memory directly guided the output.",
    ...options.memoryResult,
  } satisfies MemoryReviewBotEvalFixture["expected"]["memory_results"][number];

  return {
    schema_version: MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION,
    fixture_id: "unit-fixture",
    fixture_source: "synthetic",
    prompt: {
      session_id: "session-1",
      prompt_id: "prompt-1",
      task_summary: "Use a relevant memory.",
      bounded_prompt: "Apply the known review delivery memory.",
      outcome_summary: "The output applied the memory.",
    },
    returned_memories: [
      {
        memory_id: "mem-1",
        source: "synthetic",
        rank: 1,
        score: 0.9,
        lifecycle_state: "active",
        scope: "repo:unit",
        content_excerpt: "Review delivery failures retry independently after persistence.",
      },
    ],
    evidence: [
      {
        evidence_id: "ev_memory",
        kind: "memory",
        source_ref: "mem-1",
        snippet: "Memory snapshot: review delivery failures retry independently after persistence.",
      },
      {
        evidence_id: "ev_output",
        kind: "output",
        snippet: "The output added independent delivery retry after persistence.",
      },
    ],
    expected: {
      prompt_outcome: options.promptOutcome ?? "true_positive",
      evidence_ids: ["ev_output"],
      memory_results: [memoryResult],
    },
  };
}

function withMemoryResult(
  fixture: MemoryReviewBotEvalFixture,
  override: Partial<MemoryReviewBotReviewerOutput["memory_results"][number]>,
): MemoryReviewBotReviewerOutput {
  const actual = expectedLabelsToReviewerOutput(fixture);
  return {
    ...actual,
    memory_results: [{ ...actual.memory_results[0], ...override }],
  };
}

function rawFixture(): Record<string, unknown> {
  return structuredClone(validFixture()) as unknown as Record<string, unknown>;
}

async function expectEvalScriptFailure(args: string[], expectedStderr: string): Promise<void> {
  const env = { ...process.env };
  delete env.ARCANIST_OPENAI_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.MEMORY_REVIEW_BOT_VERIFY_FIXTURE_PATH;

  let error: unknown;
  try {
    await execFileAsync("npx", ["tsx", "disposable/memory-review-bot/evaluate-memory-review-bot.ts", ...args], {
      cwd: process.cwd(),
      env,
    });
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({ stderr: expect.stringContaining(expectedStderr) });
}
