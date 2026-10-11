export const MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION = "memory_review_bot_fixture_v1" as const;
export const MEMORY_REVIEW_BOT_REVIEWER_INPUT_SCHEMA_VERSION = "memory_review_bot_reviewer_input_v1" as const;
export const MEMORY_REVIEW_BOT_REVIEWER_OUTPUT_SCHEMA_VERSION = "memory_review_bot_reviewer_output_v1" as const;

export const PROMPT_OUTCOMES = ["true_positive", "false_positive", "true_negative", "false_negative"] as const;
export type PromptOutcome = (typeof PROMPT_OUTCOMES)[number];

export const MEMORY_RELEVANCE_LABELS = ["relevant", "borderline", "irrelevant"] as const;
export type MemoryRelevance = (typeof MEMORY_RELEVANCE_LABELS)[number];

export const MEMORY_USEFULNESS_LABELS = ["useful", "not_useful"] as const;
export type MemoryUsefulness = (typeof MEMORY_USEFULNESS_LABELS)[number];

export const MEMORY_EFFECT_LABELS = ["helped", "hurt", "neutral"] as const;
export type MemoryEffect = (typeof MEMORY_EFFECT_LABELS)[number];

export const MEMORY_LIFECYCLE_STATES = ["active", "superseded", "expired", "rejected", "unknown"] as const;
export type MemoryLifecycleState = (typeof MEMORY_LIFECYCLE_STATES)[number];

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

export const MEMORY_REVIEW_FAILURE_CODES = [
  "missing_prompt",
  "missing_task_summary",
  "missing_transcript_evidence",
  "missing_output_evidence",
  "missing_memory_evidence",
  "missing_usage_evidence",
  "missing_required_evidence",
  "invalid_reviewer_output",
] as const;
export type MemoryReviewFailureCode = (typeof MEMORY_REVIEW_FAILURE_CODES)[number];

export const REVIEW_BOT_FIXTURE_SOURCES = ["production", "synthetic"] as const;
export type ReviewBotFixtureSource = (typeof REVIEW_BOT_FIXTURE_SOURCES)[number];

export const REVIEW_BOT_RETURNED_MEMORY_SOURCES = [
  "recall",
  "company_recall",
  "company_bootstrap",
  "synthetic",
] as const;
export type ReviewBotReturnedMemorySource = (typeof REVIEW_BOT_RETURNED_MEMORY_SOURCES)[number];

export const REVIEW_BOT_EVIDENCE_KINDS = [
  "prompt",
  "transcript",
  "output",
  "memory",
  "lifecycle",
  "feedback",
  "slack",
] as const;
export type ReviewBotEvidenceKind = (typeof REVIEW_BOT_EVIDENCE_KINDS)[number];

export type MemoryId = string;
export type EvidenceId = string;

export interface ReviewBotPromptFixture {
  session_id?: string;
  prompt_id?: string;
  task_summary: string;
  bounded_prompt: string;
  outcome_summary?: string;
}

export interface ReviewBotReturnedMemoryFixture {
  memory_id: MemoryId;
  source: ReviewBotReturnedMemorySource;
  rank: number;
  score: number;
  lifecycle_state: MemoryLifecycleState;
  scope: string;
  content_excerpt: string;
}

export interface ReviewBotEvidenceSnippet {
  evidence_id: EvidenceId;
  kind: ReviewBotEvidenceKind;
  source_ref?: string;
  snippet: string;
}

export interface MemoryReviewLabels {
  memory_id: MemoryId;
  relevance: MemoryRelevance;
  usefulness: MemoryUsefulness;
  effect: MemoryEffect;
  lifecycle_state: MemoryLifecycleState;
  root_causes: MemoryReviewRootCause[];
  evidence_ids: EvidenceId[];
  rationale?: string;
}

export interface ReviewBotExpectedLabels {
  prompt_outcome: PromptOutcome;
  evidence_ids: EvidenceId[];
  missed_memory_ids?: MemoryId[];
  failure_code?: MemoryReviewFailureCode;
  memory_results: MemoryReviewLabels[];
}

export interface MemoryReviewBotEvalFixture {
  schema_version: typeof MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION;
  fixture_id: string;
  fixture_source: ReviewBotFixtureSource;
  prompt: ReviewBotPromptFixture;
  returned_memories: ReviewBotReturnedMemoryFixture[];
  evidence: ReviewBotEvidenceSnippet[];
  expected: ReviewBotExpectedLabels;
}

export interface MemoryReviewBotReviewerInput {
  schema_version: typeof MEMORY_REVIEW_BOT_REVIEWER_INPUT_SCHEMA_VERSION;
  fixture_id: string;
  task: ReviewBotPromptFixture;
  returned_memories: ReviewBotReturnedMemoryFixture[];
  evidence: ReviewBotEvidenceSnippet[];
}

export interface MemoryReviewBotReviewerOutput {
  prompt_outcome: PromptOutcome;
  confidence: number;
  summary: string;
  memory_results: MemoryReviewLabels[];
  failure_code?: MemoryReviewFailureCode;
}

export interface MemoryReviewBotReviewerMetadata {
  prompt_version: string;
  model: string;
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  cost_usd: number | null;
}

export interface MemoryReviewBotReviewerRun {
  output: MemoryReviewBotReviewerOutput;
  metadata?: Partial<MemoryReviewBotReviewerMetadata>;
}

export type MemoryReviewBotReviewerResult = MemoryReviewBotReviewerOutput | MemoryReviewBotReviewerRun;

export type MemoryReviewBotReviewer = (
  input: MemoryReviewBotReviewerInput,
) => Promise<MemoryReviewBotReviewerResult> | MemoryReviewBotReviewerResult;
