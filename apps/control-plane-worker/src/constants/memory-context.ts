import { OpenAIModel } from "../../../../shared/constants/models.js";

// Max attempts before a semantic document is treated as permanently unsyncable
// (see listPendingMemorySemanticDocuments; reset to 0 when its content changes).
export const MEMORY_MAX_VECTOR_SYNC_ATTEMPTS = 3;

// Deferral delay when a vector_sync run leaves failed documents with retry
// budget remaining (transient embedding/Vectorize outages).
export const MEMORY_CONTEXT_VECTOR_SYNC_RETRY_DELAY_MS = 5 * 60 * 1000;

// Query-time retrieval knobs (context-query.ts). Placement-only constants; values
// unchanged. The three `30`s are independent lane caps that happen to coincide.
export const MEMORY_CONTEXT_REPO_FTS_LIMIT = 30;
export const MEMORY_CONTEXT_VECTOR_TOP_K = 30;
export const MEMORY_CONTEXT_SEMANTIC_DOCUMENT_LIMIT = 30;
export const MEMORY_CONTEXT_COMPANY_RECALL_TIMEOUT_MS = 4_000;
// Keep the sidecar selector tied to the canonical registry id.
export const MEMORY_CONTEXT_SELECTOR_MODEL = OpenAIModel.GPT54Mini;
export const MEMORY_CONTEXT_SELECTOR_TIMEOUT_MS = 25_000;
// Embeddings are on the prompt-critical retrieval path. Fail open to lexical
// recall rather than allowing an unavailable provider to stall the prompt.
export const MEMORY_EMBEDDING_TIMEOUT_MS = 5_000;
export const MEMORY_EMBEDDING_SYNC_TIMEOUT_MS = 30_000;

type MemoryContextFlagEnv = {
  MEMORY_CONTEXT_RETRIEVAL_DISABLED?: string;
};

// Single blast-radius kill switch for the whole memory-context pipeline.
export function isMemoryContextRetrievalDisabled(env: MemoryContextFlagEnv): boolean {
  return isEnabledFlag(env.MEMORY_CONTEXT_RETRIEVAL_DISABLED);
}

function isEnabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}
