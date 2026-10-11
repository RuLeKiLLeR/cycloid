import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import type { MemoryFile } from "../../../../shared/memory/parser.js";
import { MEMORY_AGENT_MODEL } from "../constants/memory.js";
import type { Logger } from "../logger";
import { queryPlatformStructuredOutput } from "../services/platform-structured-output";
import type { MemoryCandidateAudit, MemoryEpisodeSummary } from "./analyzer.js";

export type RepoMemoryJudgeVerdict = "store" | "reject";
export const REPO_MEMORY_JUDGE_CONFIDENCE_FLOOR = 0.5;

export interface RepoMemoryJudgeResult {
  verdict: RepoMemoryJudgeVerdict;
  confidence: number;
  rationale: string;
  issues: string[];
  belowConfidenceFloor: boolean;
}

export interface RepoMemoryJudgeInput {
  apiKey: string;
  repoOwner: string;
  repoName: string;
  sourcePrUrl: string;
  sourcePrNumber: number;
  sourceSessionIds: string[];
  log?: Logger;
  episodeSummary?: MemoryEpisodeSummary | null;
  candidateAudit: MemoryCandidateAudit[];
  existingMemories: Array<{
    id: string;
    memory_type: string;
    level: string;
    primitive: string;
    context_hint: string;
    content: string;
    applies_to: string[];
  }>;
  change: {
    kind: "add" | "update" | "remove";
    targetMemoryId: string | null;
    candidate: unknown;
    memory: MemoryFile | null;
  };
}

const JUDGE_TOOL: StructuredOutputTool = {
  name: "submit_repo_memory_judgment",
  description: "Judge whether a proposed repo memory should be stored directly in D1 without human PR review.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["store", "reject"] },
      confidence: {
        type: "number",
        description:
          "Calibrated 0.0-1.0 probability that this memory is still correct and useful in ~6 months. A store verdict below 0.5 is recorded as a rejected audit and does not persist memory. Reserve >0.8 for memories backed by direct reviewer or user evidence; default to ~0.5-0.7 for sound inferences.",
      },
      rationale: { type: "string" },
      issues: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "confidence", "rationale", "issues"],
  },
};

export async function judgeRepoMemorySuggestion(input: RepoMemoryJudgeInput): Promise<RepoMemoryJudgeResult> {
  const raw = await queryPlatformStructuredOutput(
    {
      ARCANIST_OPENAI_API_KEY: input.apiKey,
    },
    {
      model: MEMORY_AGENT_MODEL,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      tool: JUDGE_TOOL,
      systemPrompt: [
        "You are the quality gate for repo memories that will be written directly to D1 without human PR review.",
        "Return store only when the proposed change is grounded in the supplied episode, durable, actionable in future repo work, non-duplicative, and safe to apply without a reviewer.",
        "Reject memories that are speculative, merely descriptive, too local to one function, redundant with existing memories, contradicted by evidence, or better handled as a convention/documentation change.",
        "For gotchas, store only concrete surprising failure modes with safer future behavior. Do not reject useful gotchas just because they are narrow.",
        "Do not reject a tactical or gotcha memory merely because the same episode also produced a broader strategic memory. Store it when it captures distinct actionable future behavior that the broader memory would not reliably trigger.",
        "A memory can mention tool descriptions, user-facing feedback, or documentation when those are part of a reusable implementation safety pattern; reject only pure documentation edits with no future execution behavior.",
        "For updates/removals, store only when the target memory and the supplied evidence support the change.",
        "confidence is a calibrated 0.0-1.0 probability that the memory is still correct and useful in ~6 months. It is retained as audit-only calibration evidence, but a store result below 0.5 will not persist, so use reject when the evidence does not justify durable memory. Reserve confidence above 0.8 for memories grounded in direct reviewer or user evidence; use ~0.5-0.7 for sound inferences from the diff/episode alone.",
      ].join(" "),
      userPrompt: JSON.stringify({
        repo: `${input.repoOwner}/${input.repoName}`,
        source_pr_url: input.sourcePrUrl,
        source_pr_number: input.sourcePrNumber,
        source_session_ids: input.sourceSessionIds,
        episode_summary: input.episodeSummary ?? null,
        candidate_audit: input.candidateAudit,
        existing_memories: input.existingMemories.slice(0, 30).map((memory) => ({
          id: memory.id,
          memory_type: memory.memory_type,
          level: memory.level,
          primitive: memory.primitive,
          context_hint: memory.context_hint.slice(0, 300),
          content: memory.content.slice(0, 1_000),
          applies_to: memory.applies_to.slice(0, 20),
        })),
        proposed_change: input.change,
        policy: {
          decision:
            "verdict=store with confidence >= 0.5 writes durable repo memory to D1; every other result records only the judgment audit.",
          bar: "Be stricter than the analyzer because no human PR review will happen.",
        },
      }),
      maxTokens: 1_000,
      timeoutMs: 30_000,
      serviceTier: OpenAIServiceTier.Flex,
      strictErrors: true,
      retry: { maxAttempts: 3 },
      spanName: "repo_memory.judge",
    },
    {
      subsystem: "memory",
      callType: "repo_memory_judge",
      phase: "background",
      sourceId: `repo_memory_judge:${input.repoOwner}/${input.repoName}:${input.sourcePrNumber}:${Date.now()}`,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
    },
    { logger: input.log },
  );

  const result = coerceRepoMemoryJudgment(raw);
  if (!result) {
    throw new Error("Repo memory judge returned invalid structured output");
  }
  return result;
}

export function coerceRepoMemoryJudgment(raw: Record<string, unknown> | null): RepoMemoryJudgeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const verdict = raw.verdict;
  if (verdict !== "store" && verdict !== "reject") return null;
  const confidence = raw.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  const rationale = raw.rationale;
  if (typeof rationale !== "string" || !rationale.trim()) return null;
  const issues = raw.issues;
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== "string")) return null;
  return {
    verdict,
    confidence: Math.max(0, Math.min(1, confidence)),
    rationale: rationale.trim().slice(0, 2_000),
    issues: issues
      .map((issue) => issue.trim())
      .filter(Boolean)
      .slice(0, 20),
    belowConfidenceFloor: verdict === "store" && confidence < REPO_MEMORY_JUDGE_CONFIDENCE_FLOOR,
  };
}

export const REPO_MEMORY_JUDGE_MODEL = MEMORY_AGENT_MODEL;
