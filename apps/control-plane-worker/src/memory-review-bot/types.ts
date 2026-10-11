import { OpenAIModel } from "../../../../shared/constants/models.js";

export const MEMORY_REVIEW_BOT_PROMPT_VERSION = "memory-review-bot-v1";
export const MEMORY_REVIEW_BOT_SCHEMA_VERSION = "memory-review-bot-output-v1";
export const MEMORY_REVIEW_BOT_DEFAULT_MODEL = OpenAIModel.GPT54Mini;

export const MEMORY_REVIEW_PROMPT_OUTCOMES = [
  "true_positive",
  "false_positive",
  "true_negative",
  "false_negative",
] as const;
export type MemoryReviewPromptOutcome = (typeof MEMORY_REVIEW_PROMPT_OUTCOMES)[number];

export const MEMORY_REVIEW_RELEVANCE = ["relevant", "borderline", "irrelevant"] as const;
export type MemoryReviewRelevance = (typeof MEMORY_REVIEW_RELEVANCE)[number];

export const MEMORY_REVIEW_USEFULNESS = ["useful", "not_useful"] as const;
export type MemoryReviewUsefulness = (typeof MEMORY_REVIEW_USEFULNESS)[number];

export const MEMORY_REVIEW_EFFECTS = ["helped", "hurt", "neutral"] as const;
export type MemoryReviewEffect = (typeof MEMORY_REVIEW_EFFECTS)[number];

export const MEMORY_REVIEW_LIFECYCLE_STATES = ["active", "superseded", "expired", "rejected", "unknown"] as const;
export type MemoryReviewLifecycleState = (typeof MEMORY_REVIEW_LIFECYCLE_STATES)[number];

export const MEMORY_REVIEW_ROOT_CAUSES = [
  "creation",
  "retrieval",
  "agent_usage",
  "stale_memory",
  "provenance_missing",
  "supersession_missing",
  "telemetry_gap",
] as const;
export type MemoryReviewRootCause = (typeof MEMORY_REVIEW_ROOT_CAUSES)[number];

export const MEMORY_REVIEW_USAGE_SOURCES = ["recall", "company_recall"] as const;
export type MemoryReviewUsageSource = (typeof MEMORY_REVIEW_USAGE_SOURCES)[number];

export type MemoryReviewScopeStatus = "in_scope" | "out_of_scope" | "unknown";
export type MemoryReviewSessionEventDeliveryStatus = "pending" | "sent" | "failed" | "skipped";
export type MemoryReviewSlackDeliveryStatus = "pending" | "sent" | "failed" | "skipped_config";

export const MEMORY_REVIEW_BOT_FAILURE_CODES = [
  "no_completed_prompt",
  "failed_prompt",
  "no_eligible_memory_usage",
  "missing_required_evidence",
  "missing_reviewer_output",
  "invalid_reviewer_output",
  "missing_memory_result",
  "duplicate_memory_result",
  "unknown_memory_id",
  "invalid_enum",
  "fabricated_evidence_id",
  "missing_evidence",
  "reviewer_exception",
] as const;
export type MemoryReviewBotFailureCode = (typeof MEMORY_REVIEW_BOT_FAILURE_CODES)[number];

export interface MemoryReviewCompletedPromptContext {
  businessId: string;
  sessionId: string;
  promptId: string;
  repoOwner: string | null;
  repoName: string | null;
  promptText: string;
  title: string | null;
  diffSummary: string | null;
  success: boolean;
  completedAtMs: number;
}

export interface MemoryReviewUsageEvent {
  id?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  sessionId: string;
  promptId: string;
  memoryId: string;
  source: string;
  selectionRank: number | null;
  selectionScore: number | null;
  explanation: string | null;
  expectedEffect: string | null;
  observedEffect: string | null;
  intent: string | null;
  filesJson: string | null;
  symbolsJson: string | null;
  reviewOutcome: string | null;
  usedAtMs: number;
}

export interface MemoryReviewMemorySnapshot {
  memoryId: string;
  source: MemoryReviewUsageSource;
  lifecycleState: MemoryReviewLifecycleState;
  scopeStatus: MemoryReviewScopeStatus;
  content: string | null;
  contextHint: string | null;
  provenance: string | null;
}

export interface MemoryReviewEvidence {
  id: string;
  kind: "prompt" | "completion" | "usage" | "memory" | "scope_defect" | "context_query";
  memoryId?: string;
  text: string;
}

export interface MemoryReviewReturnedMemory extends MemoryReviewMemorySnapshot {
  rank: number | null;
  score: number | null;
  explanation: string | null;
  expectedEffect: string | null;
  observedEffect: string | null;
  intent: string | null;
  files: string[];
  symbols: string[];
  evidenceIds: string[];
}

export interface MemoryReviewScopeDefect {
  memoryId: string;
  source: MemoryReviewUsageSource;
  reason: "repo_scope_mismatch" | "memory_not_found_in_scope";
  usageEvidenceId: string;
}

export interface MemoryReviewInput {
  schemaVersion: string;
  businessId: string;
  sessionId: string;
  promptId: string;
  repoOwner: string | null;
  repoName: string | null;
  task: {
    promptText: string;
    title: string | null;
    diffSummary: string | null;
    completedAtMs: number;
  };
  returnedMemories: MemoryReviewReturnedMemory[];
  evidence: MemoryReviewEvidence[];
  scopeDefects: MemoryReviewScopeDefect[];
}

export interface MemoryReviewItemResult {
  memoryId: string;
  relevance: MemoryReviewRelevance;
  usefulness: MemoryReviewUsefulness;
  effect: MemoryReviewEffect;
  lifecycleState: MemoryReviewLifecycleState;
  rootCauses: MemoryReviewRootCause[];
  evidenceIds: string[];
  rationale: string;
}

export interface MemoryReviewOutput {
  promptOutcome: MemoryReviewPromptOutcome;
  confidence: number;
  summary: string;
  memoryResults: MemoryReviewItemResult[];
}

export interface MemoryReviewRecallResult {
  source: MemoryReviewUsageSource;
  memoryCount: number;
  relevantCount: number;
  usefulCount: number;
  hurtCount: number;
  promptOutcome: MemoryReviewPromptOutcome;
  aggregateEffect: MemoryReviewEffect;
  provenanceNotes: string[];
  evidenceIds: string[];
}

export interface MemoryReviewBotRun {
  id: string;
  businessId: string;
  sessionId: string;
  promptId: string;
  reviewerModel: string;
  promptVersion: string;
  schemaVersion: string;
  inputSnapshotJson: string;
  outputJson: string;
  promptOutcome: MemoryReviewPromptOutcome;
  confidence: number;
  summary: string;
  evidenceJson: string;
  failureCode: string | null;
  sessionEventStatus: MemoryReviewSessionEventDeliveryStatus;
  sessionEventId: string | null;
  sessionEventError: string | null;
  slackPostStatus: MemoryReviewSlackDeliveryStatus;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  slackError: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
  startedAtMs: number;
  completedAtMs: number;
  createdAtMs: number;
}
