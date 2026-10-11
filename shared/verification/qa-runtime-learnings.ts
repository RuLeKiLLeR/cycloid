import {
  QA_RUNTIME_LEARNING_CLAIM_MAX_CHARS,
  QA_RUNTIME_LEARNING_DETAIL_MAX_CHARS,
  QA_RUNTIME_LEARNING_EVIDENCE_MAX_CHARS,
  QA_RUNTIME_LEARNING_MAX_SUPERSEDES,
  QA_RUNTIME_LEARNINGS_FENCE,
  QA_RUNTIME_LEARNINGS_MAX_ENTRIES,
  QA_RUNTIME_MEMORY_TAG,
} from "../constants/qa-runtime-memory.js";

export type QaRuntimeLearningKind = "gotcha" | "procedure";

export type QaRuntimeLearning = {
  kind: QaRuntimeLearningKind;
  claim: string;
  detail: string;
  evidence: string;
  supersedesMemoryIds: string[];
};

export function isQaRuntimeMemory(memory: { tags?: string[] | null }): boolean {
  return Array.isArray(memory.tags) && memory.tags.includes(QA_RUNTIME_MEMORY_TAG);
}

/**
 * QA runtime memories are visible to QA (verification) sessions only; every
 * other consumer gets the pool with them filtered out.
 */
export function visibleRepoMemoriesForSession<T extends { tags?: string[] | null }>(
  memories: T[],
  input: { qaSession: boolean },
): T[] {
  return input.qaSession ? memories : memories.filter((memory) => !isQaRuntimeMemory(memory));
}

/**
 * Extract self-reported runtime learnings from a free-form QA phase note.
 * Emission is best-effort by contract: a missing, empty, or malformed fence
 * returns null so callers can no-op silently.
 */
export function parseQaRuntimeLearnings(output: string): QaRuntimeLearning[] | null {
  const fencePattern = new RegExp("```" + QA_RUNTIME_LEARNINGS_FENCE + "\\s*([\\s\\S]*?)```", "gi");
  const matches = [...output.matchAll(fencePattern)];
  for (const match of matches.reverse()) {
    const json = match[1]?.trim() ?? "";
    if (!json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const learnings = parsed
      .slice(0, QA_RUNTIME_LEARNINGS_MAX_ENTRIES)
      .map((entry) => normalizeLearning(entry))
      .filter((entry): entry is QaRuntimeLearning => entry !== null);
    if (learnings.length > 0) return learnings;
  }
  return null;
}

function normalizeLearning(value: unknown): QaRuntimeLearning | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "gotcha" || record.kind === "procedure" ? record.kind : null;
  const claim = boundedString(record.claim, QA_RUNTIME_LEARNING_CLAIM_MAX_CHARS);
  const detail = boundedString(record.detail, QA_RUNTIME_LEARNING_DETAIL_MAX_CHARS);
  if (!kind || !claim || !detail) return null;
  return {
    kind,
    claim,
    detail,
    evidence: boundedString(record.evidence, QA_RUNTIME_LEARNING_EVIDENCE_MAX_CHARS) ?? "",
    supersedesMemoryIds: Array.isArray(record.supersedesMemoryIds)
      ? record.supersedesMemoryIds
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
          .slice(0, QA_RUNTIME_LEARNING_MAX_SUPERSEDES)
      : [],
  };
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxChars);
}
