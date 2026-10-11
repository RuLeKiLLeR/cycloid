import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import { MEMORY_AGENT_MODEL } from "../constants/memory";
import { queryPlatformStructuredOutput } from "../services/platform-structured-output";
import type { Env } from "../types";

export type MemoryAdjudicationClassification =
  | "same_memory"
  | "newer_supersedes_old"
  | "contradiction_needs_review"
  | "old_memory_expired"
  | "repo_memory_stale"
  | "unrelated";
export type MemoryAdjudicationAction =
  "no_action" | "expire_d1" | "reject_d1" | "supersede_older_d1" | "create_repo_memory_pr" | "manual_review";

export interface MemoryAdjudicationInput {
  businessId: string;
  memories: Array<{
    id: string;
    store: "d1" | "repo";
    claim: string;
    sourceTimeMs: number;
    sourceUri: string | null;
  }>;
}

export interface MemoryAdjudication {
  classification: MemoryAdjudicationClassification;
  confidence: number;
  proposed_action: MemoryAdjudicationAction;
  rationale: string;
  cited_memory_ids: string[];
}

const ADJUDICATION_TOOL: StructuredOutputTool = {
  name: "submit_memory_adjudication",
  description: "Classify whether two memories are duplicates, conflicts, supersessions, stale, or unrelated.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      classification: {
        type: "string",
        enum: [
          "same_memory",
          "newer_supersedes_old",
          "contradiction_needs_review",
          "old_memory_expired",
          "repo_memory_stale",
          "unrelated",
        ],
      },
      confidence: { type: "number" },
      proposed_action: {
        type: "string",
        enum: ["no_action", "expire_d1", "reject_d1", "supersede_older_d1", "create_repo_memory_pr", "manual_review"],
      },
      rationale: { type: "string" },
      cited_memory_ids: { type: "array", items: { type: "string" } },
    },
    required: ["classification", "confidence", "proposed_action", "rationale", "cited_memory_ids"],
  },
};

export async function adjudicateMemoryPair(
  env: Env,
  input: MemoryAdjudicationInput,
): Promise<MemoryAdjudication | null> {
  if (!env.ARCANIST_OPENAI_API_KEY || input.memories.length !== 2) return null;
  const raw = (await queryPlatformStructuredOutput(
    env,
    {
      model: MEMORY_AGENT_MODEL,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      tool: ADJUDICATION_TOOL,
      systemPrompt:
        "Classify whether two sourced company memories conflict, duplicate, supersede each other, or are unrelated. Prefer no_action unless both memory ids are cited by the evidence.",
      userPrompt: JSON.stringify({
        business_id: input.businessId,
        memories: input.memories.map((memory) => ({
          id: memory.id,
          store: memory.store,
          claim: memory.claim.slice(0, 1_000),
          source_time_ms: memory.sourceTimeMs,
          source_uri: memory.sourceUri,
        })),
        policy: "If the memories conflict and source ordering is clear, newer sourced memory wins for this release.",
      }),
      maxTokens: 1_000,
      timeoutMs: 30_000,
      serviceTier: OpenAIServiceTier.Flex,
      strictErrors: true,
      retry: { maxAttempts: 3 },
      spanName: "company_memory.adjudicate",
    },
    {
      subsystem: "company_memory",
      callType: "memory_adjudication",
      phase: "background",
      sourceId: `memory_adjudication:${input.businessId}:${input.memories.map((memory) => memory.id).join(",")}`,
      businessId: input.businessId,
    },
  )) as Partial<MemoryAdjudication>;
  return coerceMemoryAdjudication(raw);
}

function coerceMemoryAdjudication(raw: Partial<MemoryAdjudication>): MemoryAdjudication | null {
  if (!raw || typeof raw !== "object") return null;
  if (
    raw.classification !== "same_memory" &&
    raw.classification !== "newer_supersedes_old" &&
    raw.classification !== "contradiction_needs_review" &&
    raw.classification !== "old_memory_expired" &&
    raw.classification !== "repo_memory_stale" &&
    raw.classification !== "unrelated"
  ) {
    return null;
  }
  if (
    raw.proposed_action !== "no_action" &&
    raw.proposed_action !== "expire_d1" &&
    raw.proposed_action !== "reject_d1" &&
    raw.proposed_action !== "supersede_older_d1" &&
    raw.proposed_action !== "create_repo_memory_pr" &&
    raw.proposed_action !== "manual_review"
  ) {
    return null;
  }
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) return null;
  if (typeof raw.rationale !== "string" || !raw.rationale.trim()) return null;
  if (!Array.isArray(raw.cited_memory_ids) || raw.cited_memory_ids.some((id) => typeof id !== "string")) return null;
  return {
    classification: raw.classification,
    proposed_action: raw.proposed_action,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    rationale: raw.rationale.trim().slice(0, 2_000),
    cited_memory_ids: raw.cited_memory_ids
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 10),
  };
}
