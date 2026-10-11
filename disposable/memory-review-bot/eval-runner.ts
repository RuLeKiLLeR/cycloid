import {
  runMemoryReviewReviewer,
  type RunMemoryReviewReviewerDeps,
} from "../../apps/control-plane-worker/src/memory-review-bot/reviewer";
import {
  MEMORY_REVIEW_BOT_DEFAULT_MODEL,
  MEMORY_REVIEW_BOT_PROMPT_VERSION,
  MEMORY_REVIEW_BOT_SCHEMA_VERSION,
  type MemoryReviewEvidence,
  type MemoryReviewInput,
  type MemoryReviewOutput,
  type MemoryReviewReturnedMemory,
  type MemoryReviewUsageSource,
} from "../../apps/control-plane-worker/src/memory-review-bot/types";
import { expectedLabelsToReviewerOutput } from "./eval-loader";
import {
  MEMORY_REVIEW_BOT_REVIEWER_INPUT_SCHEMA_VERSION,
  type MemoryReviewBotEvalFixture,
  type MemoryReviewBotReviewer,
  type MemoryReviewBotReviewerInput,
  type MemoryReviewBotReviewerMetadata,
  type MemoryReviewBotReviewerOutput,
  type MemoryReviewBotReviewerResult,
} from "./eval-schema";
import {
  type MemoryReviewBotScoreResult,
  type MemoryReviewBotScorerName,
  scoreMemoryReviewBotOutput,
} from "./eval-scorers";

export const MEMORY_REVIEW_BOT_ORACLE_BASELINE_PROMPT_VERSION = "oracle-baseline-fixture-copy-v1" as const;
export const MEMORY_REVIEW_BOT_ORACLE_BASELINE_MODEL = "oracle-baseline-do-not-use-in-production" as const;

export interface MemoryReviewBotEvalResult {
  fixture_id: string;
  fixture_source: MemoryReviewBotEvalFixture["fixture_source"];
  expected: MemoryReviewBotEvalFixture["expected"];
  actual: MemoryReviewBotReviewerOutput;
  scores: MemoryReviewBotScoreResult[];
  passed: boolean;
  failed_scorers: MemoryReviewBotScorerName[];
  metadata: MemoryReviewBotReviewerMetadata;
}

export function buildMemoryReviewBotReviewerInput(fixture: MemoryReviewBotEvalFixture): MemoryReviewBotReviewerInput {
  return {
    schema_version: MEMORY_REVIEW_BOT_REVIEWER_INPUT_SCHEMA_VERSION,
    fixture_id: fixture.fixture_id,
    task: { ...fixture.prompt },
    returned_memories: fixture.returned_memories.map((memory) => ({ ...memory })),
    evidence: fixture.evidence.map((entry) => ({ ...entry })),
  };
}

export function buildProductionMemoryReviewInputFromFixture(fixture: MemoryReviewBotEvalFixture): MemoryReviewInput {
  const returnedMemories: MemoryReviewReturnedMemory[] = fixture.returned_memories.map((memory) => ({
    memoryId: memory.memory_id,
    source: mapFixtureMemorySource(memory.source),
    lifecycleState: memory.lifecycle_state,
    scopeStatus: "in_scope",
    content: memory.content_excerpt,
    contextHint: `Fixture source=${memory.source}; scope=${memory.scope}`,
    provenance: fixture.fixture_source,
    rank: memory.rank,
    score: memory.score,
    explanation: `Fixture returned memory source=${memory.source}; scope=${memory.scope}`,
    expectedEffect: null,
    observedEffect: null,
    intent: null,
    files: [],
    symbols: [],
    evidenceIds: fixtureEvidenceIdsForMemory(fixture, memory),
  }));

  return {
    schemaVersion: MEMORY_REVIEW_BOT_SCHEMA_VERSION,
    businessId: `fixture:${fixture.fixture_source}`,
    sessionId: fixture.prompt.session_id ?? `fixture-session:${fixture.fixture_id}`,
    promptId: fixture.prompt.prompt_id ?? `fixture-prompt:${fixture.fixture_id}`,
    ...repoFromFixtureScope(fixture),
    task: {
      promptText: fixture.prompt.bounded_prompt,
      title: fixture.prompt.task_summary,
      diffSummary: fixture.prompt.outcome_summary ?? null,
      completedAtMs: 0,
    },
    returnedMemories,
    evidence: buildProductionEvidenceFromFixture(fixture),
    scopeDefects: [],
  };
}

export async function runMemoryReviewBotFixture(
  fixture: MemoryReviewBotEvalFixture,
  reviewer: MemoryReviewBotReviewer,
): Promise<MemoryReviewBotEvalResult> {
  const input = buildMemoryReviewBotReviewerInput(fixture);
  const reviewerResult = normalizeReviewerResult(await reviewer(input));
  const scores = scoreMemoryReviewBotOutput(fixture, reviewerResult.output);
  const failedScorers = scores.filter((score) => !score.passed).map((score) => score.scorer);
  return {
    fixture_id: fixture.fixture_id,
    fixture_source: fixture.fixture_source,
    expected: fixture.expected,
    actual: reviewerResult.output,
    scores,
    passed: failedScorers.length === 0,
    failed_scorers: failedScorers,
    metadata: reviewerResult.metadata,
  };
}

export async function runMemoryReviewBotFixtures(
  fixtures: MemoryReviewBotEvalFixture[],
  reviewer: MemoryReviewBotReviewer,
): Promise<MemoryReviewBotEvalResult[]> {
  const results: MemoryReviewBotEvalResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runMemoryReviewBotFixture(fixture, reviewer));
  }
  return results;
}

export function createMemoryReviewBotOracleBaselineReviewer(
  fixtures: MemoryReviewBotEvalFixture[],
): MemoryReviewBotReviewer {
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixture_id, fixture]));
  return (input: MemoryReviewBotReviewerInput) => {
    const fixture = fixturesById.get(input.fixture_id);
    if (!fixture) {
      throw new Error(`Oracle baseline fixture lookup failed for ${input.fixture_id}`);
    }
    return {
      output: expectedLabelsToReviewerOutput(fixture),
      metadata: {
        prompt_version: MEMORY_REVIEW_BOT_ORACLE_BASELINE_PROMPT_VERSION,
        model: MEMORY_REVIEW_BOT_ORACLE_BASELINE_MODEL,
        token_usage: null,
        cost_usd: null,
      },
    };
  };
}

export function createProductionMemoryReviewBotReviewer(
  params: {
    apiKey: string;
    model?: string;
    promptVersion?: string;
  },
  deps: RunMemoryReviewReviewerDeps = {},
): MemoryReviewBotReviewer {
  return async (input: MemoryReviewBotReviewerInput) => {
    const productionInput = reviewerInputToProductionInput(input);
    const review = await runMemoryReviewReviewer(
      {
        env: { ARCANIST_OPENAI_API_KEY: params.apiKey },
        telemetry: {
          subsystem: "memory_review_bot",
          callType: "review",
          phase: "memory",
          sourceId: input.fixture_id,
        },
        input: productionInput,
        model: params.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL,
        promptVersion: params.promptVersion ?? MEMORY_REVIEW_BOT_PROMPT_VERSION,
      },
      deps,
    );
    if (!review.ok) {
      throw new Error(`Production memory reviewer failed for ${input.fixture_id}: ${review.failureCode}`);
    }
    return {
      output: productionOutputToReviewerOutput(review.output),
      metadata: {
        prompt_version: params.promptVersion ?? MEMORY_REVIEW_BOT_PROMPT_VERSION,
        model: params.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL,
        token_usage: null,
        cost_usd: null,
      },
    };
  };
}

function reviewerInputToProductionInput(input: MemoryReviewBotReviewerInput): MemoryReviewInput {
  return buildProductionMemoryReviewInputFromFixture({
    schema_version: "memory_review_bot_fixture_v1",
    fixture_id: input.fixture_id,
    fixture_source: "synthetic",
    prompt: input.task,
    returned_memories: input.returned_memories,
    evidence: input.evidence,
    expected: {
      prompt_outcome: "true_negative",
      evidence_ids: input.evidence.map((entry) => entry.evidence_id),
      memory_results: [],
    },
  });
}

function productionOutputToReviewerOutput(output: MemoryReviewOutput): MemoryReviewBotReviewerOutput {
  return {
    prompt_outcome: output.promptOutcome,
    confidence: output.confidence,
    summary: output.summary,
    memory_results: output.memoryResults.map((result) => ({
      memory_id: result.memoryId,
      relevance: result.relevance,
      usefulness: result.usefulness,
      effect: result.effect,
      lifecycle_state: result.lifecycleState,
      root_causes: [...result.rootCauses],
      evidence_ids: [...result.evidenceIds],
      rationale: result.rationale,
    })),
  };
}

function buildProductionEvidenceFromFixture(fixture: MemoryReviewBotEvalFixture): MemoryReviewEvidence[] {
  const evidence: MemoryReviewEvidence[] = [];

  for (const entry of fixture.evidence) {
    evidence.push({
      id: entry.evidence_id,
      kind: mapFixtureEvidenceKind(entry.kind),
      ...(entry.kind === "memory" && isFixtureMemoryId(fixture, entry.source_ref)
        ? { memoryId: entry.source_ref }
        : {}),
      text: [entry.source_ref ? `source_ref=${entry.source_ref}` : null, `fixture_kind=${entry.kind}`, entry.snippet]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return evidence;
}

function fixtureEvidenceIdsForMemory(
  fixture: MemoryReviewBotEvalFixture,
  memory: MemoryReviewBotEvalFixture["returned_memories"][number],
): string[] {
  const directEvidenceIds = fixture.evidence
    .filter((entry) => entry.kind === "memory" && entry.source_ref === memory.memory_id)
    .map((entry) => entry.evidence_id);
  if (directEvidenceIds.length > 0) return directEvidenceIds;

  return fixture.evidence
    .filter((entry) => entry.kind === "memory" && !entry.source_ref)
    .map((entry) => entry.evidence_id);
}

function isFixtureMemoryId(fixture: MemoryReviewBotEvalFixture, sourceRef: string | undefined): sourceRef is string {
  return Boolean(sourceRef && fixture.returned_memories.some((memory) => memory.memory_id === sourceRef));
}

function mapFixtureMemorySource(
  source: MemoryReviewBotEvalFixture["returned_memories"][number]["source"],
): MemoryReviewUsageSource {
  return source === "company_recall" || source === "company_bootstrap" ? "company_recall" : "recall";
}

function mapFixtureEvidenceKind(
  kind: MemoryReviewBotEvalFixture["evidence"][number]["kind"],
): MemoryReviewEvidence["kind"] {
  if (kind === "prompt") return "prompt";
  if (kind === "memory") return "memory";
  return "completion";
}

function repoFromFixtureScope(fixture: MemoryReviewBotEvalFixture): Pick<MemoryReviewInput, "repoOwner" | "repoName"> {
  const scopedRepo = fixture.returned_memories
    .map((memory) => memory.scope)
    .find((scope) => scope.startsWith("repo:"))
    ?.slice("repo:".length);
  const slashIndex = scopedRepo?.indexOf("/") ?? -1;
  if (!scopedRepo || slashIndex <= 0 || slashIndex === scopedRepo.length - 1) {
    return { repoOwner: null, repoName: null };
  }
  return {
    repoOwner: scopedRepo.slice(0, slashIndex),
    repoName: scopedRepo.slice(slashIndex + 1),
  };
}

function normalizeReviewerResult(result: MemoryReviewBotReviewerResult): {
  output: MemoryReviewBotReviewerOutput;
  metadata: MemoryReviewBotReviewerMetadata;
} {
  const maybeRun = isReviewerRun(result) ? result : { output: result };
  return {
    output: maybeRun.output,
    metadata: {
      prompt_version: maybeRun.metadata?.prompt_version ?? "unknown",
      model: maybeRun.metadata?.model ?? "unknown",
      token_usage: maybeRun.metadata?.token_usage ?? null,
      cost_usd: maybeRun.metadata?.cost_usd ?? null,
    },
  };
}

function isReviewerRun(result: MemoryReviewBotReviewerResult): result is {
  output: MemoryReviewBotReviewerOutput;
  metadata?: Partial<MemoryReviewBotReviewerMetadata>;
} {
  return !!result && typeof result === "object" && "output" in result;
}
