/**
 * QA runtime memory: per-repo "how to run this app" learnings self-reported by
 * the QA Tester launcher/operator phases, stored as tagged repo memories, and
 * re-injected into future QA runs on the same repo.
 */

/** Tag distinguishing QA runtime memories inside `repo_memories`. */
export const QA_RUNTIME_MEMORY_TAG = "qa-runtime";

/** Fence name for the self-reported learnings block in QA phase notes. */
export const QA_RUNTIME_LEARNINGS_FENCE = "cycloid-qa-runtime-learnings";

/** Max learnings accepted from a single phase note. */
export const QA_RUNTIME_LEARNINGS_MAX_ENTRIES = 3;

export const QA_RUNTIME_LEARNING_CLAIM_MAX_CHARS = 200;
export const QA_RUNTIME_LEARNING_DETAIL_MAX_CHARS = 1_500;
export const QA_RUNTIME_LEARNING_EVIDENCE_MAX_CHARS = 500;
export const QA_RUNTIME_LEARNING_MAX_SUPERSEDES = 5;

/** Max stored learnings injected into QA phase prompts (most recent first). */
export const QA_RUNTIME_MEMORY_INJECTION_LIMIT = 10;
