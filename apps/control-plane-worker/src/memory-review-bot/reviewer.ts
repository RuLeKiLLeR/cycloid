import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import { type StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import {
  type PlatformStructuredOutputEnv,
  type PlatformStructuredOutputOptions,
  type PlatformStructuredOutputTelemetry,
  queryPlatformStructuredOutput,
} from "../services/platform-structured-output";
import {
  MEMORY_REVIEW_BOT_DEFAULT_MODEL,
  MEMORY_REVIEW_BOT_FAILURE_CODES,
  MEMORY_REVIEW_BOT_PROMPT_VERSION,
  MEMORY_REVIEW_BOT_SCHEMA_VERSION,
  MEMORY_REVIEW_EFFECTS,
  MEMORY_REVIEW_LIFECYCLE_STATES,
  MEMORY_REVIEW_PROMPT_OUTCOMES,
  MEMORY_REVIEW_RELEVANCE,
  MEMORY_REVIEW_ROOT_CAUSES,
  MEMORY_REVIEW_USEFULNESS,
  type MemoryReviewBotFailureCode,
  type MemoryReviewEffect,
  type MemoryReviewInput,
  type MemoryReviewItemResult,
  type MemoryReviewLifecycleState,
  type MemoryReviewOutput,
  type MemoryReviewPromptOutcome,
  type MemoryReviewRelevance,
  type MemoryReviewRootCause,
  type MemoryReviewUsefulness,
} from "./types";

const REVIEWER_TIMEOUT_MS = 30_000;
const REVIEWER_MAX_OUTPUT_TOKENS = 2_500;

type PlatformStructuredOutputQuery = (
  env: PlatformStructuredOutputEnv,
  options: PlatformStructuredOutputOptions,
  telemetry: PlatformStructuredOutputTelemetry,
) => Promise<Record<string, unknown> | null>;

export type MemoryReviewParseResult =
  | { ok: true; output: MemoryReviewOutput; repaired: boolean }
  | { ok: false; failureCode: MemoryReviewBotFailureCode; message: string; repaired: boolean };

type MemoryReviewValidationResult =
  { ok: true; output: MemoryReviewOutput } | { ok: false; failureCode: MemoryReviewBotFailureCode; message: string };

export interface RunMemoryReviewReviewerDeps {
  queryStructuredOutput?: PlatformStructuredOutputQuery;
}

export interface RunMemoryReviewReviewerInput {
  env: PlatformStructuredOutputEnv;
  telemetry: PlatformStructuredOutputTelemetry;
  input: MemoryReviewInput;
  model?: string;
  promptVersion?: string;
}

const FAILURE_CODE_SET = new Set<string>(MEMORY_REVIEW_BOT_FAILURE_CODES);
const PROMPT_OUTCOME_SET: ReadonlySet<MemoryReviewPromptOutcome> = new Set(MEMORY_REVIEW_PROMPT_OUTCOMES);
const RELEVANCE_SET: ReadonlySet<MemoryReviewRelevance> = new Set(MEMORY_REVIEW_RELEVANCE);
const USEFULNESS_SET: ReadonlySet<MemoryReviewUsefulness> = new Set(MEMORY_REVIEW_USEFULNESS);
const EFFECT_SET: ReadonlySet<MemoryReviewEffect> = new Set(MEMORY_REVIEW_EFFECTS);
const LIFECYCLE_SET: ReadonlySet<MemoryReviewLifecycleState> = new Set(MEMORY_REVIEW_LIFECYCLE_STATES);
const ROOT_CAUSE_SET: ReadonlySet<MemoryReviewRootCause> = new Set(MEMORY_REVIEW_ROOT_CAUSES);

export const MEMORY_REVIEW_BOT_TOOL: StructuredOutputTool = {
  name: "submit_memory_review",
  description: "Classify observed memory usage for one completed prompt using only supplied evidence.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt_outcome: { type: "string", enum: MEMORY_REVIEW_PROMPT_OUTCOMES },
      confidence: { type: "number" },
      summary: { type: "string" },
      memory_results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory_id: { type: "string" },
            relevance: { type: "string", enum: MEMORY_REVIEW_RELEVANCE },
            usefulness: { type: "string", enum: MEMORY_REVIEW_USEFULNESS },
            effect: { type: "string", enum: MEMORY_REVIEW_EFFECTS },
            lifecycle_state: { type: "string", enum: MEMORY_REVIEW_LIFECYCLE_STATES },
            root_causes: {
              type: "array",
              items: { type: "string", enum: MEMORY_REVIEW_ROOT_CAUSES },
            },
            evidence_ids: {
              type: "array",
              items: { type: "string" },
            },
            rationale: { type: "string" },
          },
          required: [
            "memory_id",
            "relevance",
            "usefulness",
            "effect",
            "lifecycle_state",
            "root_causes",
            "evidence_ids",
            "rationale",
          ],
        },
      },
      failure_code: { type: ["string", "null"], enum: [...MEMORY_REVIEW_BOT_FAILURE_CODES, null] },
    },
    required: ["prompt_outcome", "confidence", "summary", "memory_results", "failure_code"],
  },
};

export async function runMemoryReviewReviewer(
  params: RunMemoryReviewReviewerInput,
  deps: RunMemoryReviewReviewerDeps = {},
): Promise<MemoryReviewParseResult> {
  const model = params.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL;
  const raw = await (deps.queryStructuredOutput ?? queryPlatformStructuredOutput)(
    params.env,
    {
      model,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      tool: MEMORY_REVIEW_BOT_TOOL,
      systemPrompt: buildMemoryReviewSystemPrompt(params.promptVersion ?? MEMORY_REVIEW_BOT_PROMPT_VERSION),
      userPrompt: JSON.stringify(params.input),
      maxTokens: REVIEWER_MAX_OUTPUT_TOKENS,
      timeoutMs: REVIEWER_TIMEOUT_MS,
      // Background, non-blocking memory-review call on gpt-5.4-mini (flex-eligible); route to flex
      // for Batch-rate billing. maxAttempts raised from 1 to 2 so a flex 429 (resource_unavailable)
      // is absorbed by a retry rather than dropping the review (the per-site flex retry gate). The
      // 30s timeout already gives flex queueing headroom.
      serviceTier: OpenAIServiceTier.Flex,
      strictErrors: true,
      retry: { maxAttempts: 2 },
      spanName: "memory_review_bot.review",
    },
    params.telemetry,
  );
  return parseMemoryReviewOutput(raw, params.input);
}

export function buildMemoryReviewSystemPrompt(promptVersion = MEMORY_REVIEW_BOT_PROMPT_VERSION): string {
  return [
    `Prompt version: ${promptVersion}. Schema version: ${MEMORY_REVIEW_BOT_SCHEMA_VERSION}.`,
    "You are an evidence-bound auditor for Cycloid memory recall quality.",
    "Classify only the memories already returned in the input for one completed prompt.",
    "Return memory_results with exactly one result for each input.returnedMemories entry, using only those memoryId values; if returnedMemories is empty, return an empty memory_results array.",
    "Do not search for additional memories, infer tenant context, or reward a memory without cited evidence that it applied to the task or affected the output.",
    "Use true_positive when surfaced memory was relevant, used correctly, and materially helped or guided the output.",
    "Use false_positive when surfaced memory was irrelevant, stale, overbroad, cross-scope, or misapplied; effect=hurt is the severe subtype.",
    "Use false_positive rather than true_negative when any returned memory is irrelevant, stale, overbroad, cross-scope, or not_useful because retrieval surfaced a bad candidate.",
    "Use true_negative only when there are no returned memories to credit or blame, or when returned memories were correctly irrelevant to a no-memory-needed task without retrieval defect evidence. Use false_negative only when the supplied evidence shows a memory should have mattered but was missed or marked neutral; do not invent memory_results for missed memories that are evidence-only.",
    "Derive prompt_outcome from memory_results: true_positive requires at least one returned memory marked useful with effect=helped; if every returned memory is irrelevant or not_useful, do not use true_positive.",
    "Use root_causes only as defect buckets. Use an empty root_causes array for correct useful/helped memories unless evidence shows a defect. Use retrieval for irrelevant or overbroad surfaced memories, agent_usage when a useful returned memory was ignored or misapplied, stale_memory for superseded/expired memories, and supersession_missing when superseded guidance was still surfaced instead of current guidance.",
    "Do not add retrieval merely because stale or superseded memory was surfaced; for lifecycle-driven failures, prefer stale_memory and supersession_missing unless the memory content is also unrelated or overbroad.",
    "Use effect=hurt only when evidence shows the surfaced memory actively made the output worse; a useful memory that was ignored or not applied is effect=neutral unless it misdirected the output.",
    "For superseded guidance that is task-adjacent but replaced by current guidance, prefer relevance=borderline, usefulness=not_useful, effect=neutral.",
    "Every non-neutral or otherwise substantive memory judgment must cite evidence_ids from the input. Unknown evidence IDs are invalid.",
    "Set failure_code to null for a successful review. If required prompt, output, usage, memory, or evidence data is missing, set failure_code instead of guessing.",
  ].join(" ");
}

export function parseMemoryReviewOutput(
  raw: Record<string, unknown> | null,
  input: MemoryReviewInput,
): MemoryReviewParseResult {
  const first = validateMemoryReviewOutput(raw, input);
  if (first.ok) return { ok: true, output: first.output, repaired: false };

  const repaired = repairMemoryReviewOutput(raw);
  if (!repaired) return { ...first, repaired: false };

  const second = validateMemoryReviewOutput(repaired, input);
  if (second.ok) return { ok: true, output: second.output, repaired: true };
  return { ...second, repaired: true };
}

function validateMemoryReviewOutput(
  raw: Record<string, unknown> | null,
  input: MemoryReviewInput,
): MemoryReviewValidationResult {
  if (!raw) {
    return { ok: false, failureCode: "missing_reviewer_output", message: "Reviewer returned no structured output" };
  }

  const failureCode = raw.failure_code;
  if (typeof failureCode === "string" && failureCode.trim()) {
    return {
      ok: false,
      failureCode: normalizeFailureCode(failureCode),
      message: `Reviewer returned failure_code=${failureCode}`,
    };
  }

  const promptOutcome = raw.prompt_outcome;
  if (!isAllowedString(promptOutcome, PROMPT_OUTCOME_SET)) {
    return { ok: false, failureCode: "invalid_enum", message: "Invalid or missing prompt_outcome" };
  }
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    return { ok: false, failureCode: "invalid_reviewer_output", message: "Invalid or missing confidence" };
  }
  if (typeof raw.summary !== "string" || !raw.summary.trim()) {
    return { ok: false, failureCode: "invalid_reviewer_output", message: "Invalid or missing summary" };
  }
  if (!Array.isArray(raw.memory_results)) {
    return { ok: false, failureCode: "invalid_reviewer_output", message: "memory_results must be an array" };
  }

  const validMemoryIds = new Set(input.returnedMemories.map((memory) => memory.memoryId));
  const validEvidenceIds = new Set(input.evidence.map((evidence) => evidence.id));
  const seen = new Set<string>();
  const memoryResults: MemoryReviewItemResult[] = [];

  for (const entry of raw.memory_results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, failureCode: "invalid_reviewer_output", message: "memory_results entries must be objects" };
    }
    const record = entry as Record<string, unknown>;
    const memoryId = typeof record.memory_id === "string" ? record.memory_id.trim() : "";
    if (!memoryId) return { ok: false, failureCode: "invalid_reviewer_output", message: "memory_id is required" };
    if (!validMemoryIds.has(memoryId)) {
      return { ok: false, failureCode: "unknown_memory_id", message: `Unknown memory_id: ${memoryId}` };
    }
    if (seen.has(memoryId)) {
      return { ok: false, failureCode: "duplicate_memory_result", message: `Duplicate memory_id: ${memoryId}` };
    }
    seen.add(memoryId);

    const relevance = record.relevance;
    const usefulness = record.usefulness;
    const effect = record.effect;
    const lifecycleState = record.lifecycle_state;
    if (
      !isAllowedString(relevance, RELEVANCE_SET) ||
      !isAllowedString(usefulness, USEFULNESS_SET) ||
      !isAllowedString(effect, EFFECT_SET) ||
      !isAllowedString(lifecycleState, LIFECYCLE_SET)
    ) {
      return { ok: false, failureCode: "invalid_enum", message: `Invalid enum for memory_id: ${memoryId}` };
    }

    const rootCauses = stringArray(record.root_causes);
    if (rootCauses === null || rootCauses.some((cause) => !ROOT_CAUSE_SET.has(cause as MemoryReviewRootCause))) {
      return { ok: false, failureCode: "invalid_enum", message: `Invalid root_causes for memory_id: ${memoryId}` };
    }
    const typedRootCauses = rootCauses as MemoryReviewRootCause[];

    const evidenceIds = stringArray(record.evidence_ids);
    if (evidenceIds === null) {
      return { ok: false, failureCode: "invalid_reviewer_output", message: `Invalid evidence_ids for ${memoryId}` };
    }
    const fabricatedEvidence = evidenceIds.find((id) => !validEvidenceIds.has(id));
    if (fabricatedEvidence) {
      return {
        ok: false,
        failureCode: "fabricated_evidence_id",
        message: `Unknown evidence_id for ${memoryId}: ${fabricatedEvidence}`,
      };
    }
    if (isSubstantiveJudgment({ relevance, usefulness, effect }, typedRootCauses) && evidenceIds.length === 0) {
      return { ok: false, failureCode: "missing_evidence", message: `Missing evidence_ids for ${memoryId}` };
    }
    if (typeof record.rationale !== "string" || !record.rationale.trim()) {
      return { ok: false, failureCode: "invalid_reviewer_output", message: `Missing rationale for ${memoryId}` };
    }

    memoryResults.push({
      memoryId,
      relevance,
      usefulness,
      effect,
      lifecycleState,
      rootCauses: typedRootCauses,
      evidenceIds,
      rationale: record.rationale.trim().slice(0, 1_000),
    });
  }

  const missing = [...validMemoryIds].find((memoryId) => !seen.has(memoryId));
  if (missing) return { ok: false, failureCode: "missing_memory_result", message: `Missing result for ${missing}` };

  return {
    ok: true,
    output: {
      promptOutcome,
      confidence: Math.max(0, Math.min(1, raw.confidence)),
      summary: raw.summary.trim().slice(0, 2_000),
      memoryResults,
    },
  };
}

export function repairMemoryReviewOutput(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const repaired: Record<string, unknown> = { ...raw };

  copyIfMissing(repaired, "prompt_outcome", "promptOutcome");
  copyIfMissing(repaired, "memory_results", "memoryResults");
  copyIfMissing(repaired, "failure_code", "failureCode");

  if (typeof repaired.confidence === "string") {
    const confidence = Number.parseFloat(repaired.confidence);
    if (Number.isFinite(confidence)) repaired.confidence = confidence;
  }

  if (
    repaired.memory_results &&
    !Array.isArray(repaired.memory_results) &&
    typeof repaired.memory_results === "object"
  ) {
    repaired.memory_results = Object.entries(repaired.memory_results as Record<string, unknown>).map(
      ([memoryId, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return { memory_id: memoryId, ...(value as Record<string, unknown>) };
        }
        return { memory_id: memoryId, value };
      },
    );
  }

  if (Array.isArray(repaired.memory_results)) {
    repaired.memory_results = repaired.memory_results.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const item: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
      copyIfMissing(item, "memory_id", "memoryId");
      copyIfMissing(item, "memory_id", "id");
      copyIfMissing(item, "lifecycle_state", "lifecycleState");
      copyIfMissing(item, "root_causes", "rootCauses");
      copyIfMissing(item, "evidence_ids", "evidenceIds");
      if (typeof item.root_causes === "string") item.root_causes = [item.root_causes];
      if (typeof item.evidence_ids === "string") item.evidence_ids = [item.evidence_ids];
      if (!Array.isArray(item.root_causes)) item.root_causes = [];
      if (!Array.isArray(item.evidence_ids)) item.evidence_ids = [];
      return item;
    });
  }

  return repaired;
}

function copyIfMissing(target: Record<string, unknown>, to: string, from: string): void {
  if (target[to] === undefined && target[from] !== undefined) target[to] = target[from];
}

function isAllowedString<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed) strings.push(trimmed);
  }
  return strings;
}

function isSubstantiveJudgment(
  record: {
    relevance: MemoryReviewRelevance;
    usefulness: MemoryReviewUsefulness;
    effect: MemoryReviewEffect;
  },
  rootCauses: MemoryReviewRootCause[],
): boolean {
  return (
    record.relevance === "relevant" ||
    record.relevance === "irrelevant" ||
    record.usefulness === "useful" ||
    record.effect === "helped" ||
    record.effect === "hurt" ||
    rootCauses.length > 0
  );
}

function normalizeFailureCode(value: string): MemoryReviewBotFailureCode {
  return FAILURE_CODE_SET.has(value) ? (value as MemoryReviewBotFailureCode) : "invalid_reviewer_output";
}
