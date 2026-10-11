import {
  MEMORY_EFFECT_LABELS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_RELEVANCE_LABELS,
  MEMORY_REVIEW_FAILURE_CODES,
  MEMORY_REVIEW_ROOT_CAUSES,
  MEMORY_USEFULNESS_LABELS,
  type MemoryReviewBotEvalFixture,
  type MemoryReviewBotReviewerOutput,
  type MemoryReviewLabels,
  PROMPT_OUTCOMES,
} from "./eval-schema";

export const MEMORY_REVIEW_BOT_SCORERS = [
  "schema_valid",
  "evidence_valid",
  "confusion_exact",
  "item_labels_exact",
  "false_positive_hurt_exact",
  "root_cause_exact",
  "lifecycle_exact",
] as const;
export type MemoryReviewBotScorerName = (typeof MEMORY_REVIEW_BOT_SCORERS)[number];

export const MEMORY_REVIEW_BOT_SCORE_REASON_CODES = [
  "missing_memory_result",
  "unexpected_memory_result",
  "duplicate_memory_result",
  "invalid_schema",
  "invalid_enum",
  "fabricated_evidence_id",
  "missing_required_evidence",
  "confusion_mismatch",
  "relevance_mismatch",
  "usefulness_mismatch",
  "effect_mismatch",
  "false_positive_hurt_mismatch",
  "root_cause_mismatch",
  "lifecycle_mismatch",
] as const;
export type MemoryReviewBotScoreReasonCode = (typeof MEMORY_REVIEW_BOT_SCORE_REASON_CODES)[number];

export interface MemoryReviewBotScoreResult {
  scorer: MemoryReviewBotScorerName;
  passed: boolean;
  reason_codes: MemoryReviewBotScoreReasonCode[];
  details: string[];
}

interface ReviewerOutputValidation {
  output: MemoryReviewBotReviewerOutput | null;
  reasonCodes: MemoryReviewBotScoreReasonCode[];
  details: string[];
}

export function scoreMemoryReviewBotOutput(
  fixture: MemoryReviewBotEvalFixture,
  actual: unknown,
): MemoryReviewBotScoreResult[] {
  return [
    scoreSchemaValid(fixture, actual),
    scoreEvidenceValid(fixture, actual),
    scoreConfusionExact(fixture, actual),
    scoreItemLabelsExact(fixture, actual),
    scoreFalsePositiveHurtExact(fixture, actual),
    scoreRootCauseExact(fixture, actual),
    scoreLifecycleExact(fixture, actual),
  ];
}

export function scoreSchemaValid(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  return result("schema_valid", validation.reasonCodes.length === 0, validation.reasonCodes, validation.details);
}

export function scoreEvidenceValid(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) return result("evidence_valid", false, validation.reasonCodes, validation.details);

  const evidenceIds = new Set(fixture.evidence.map((entry) => entry.evidence_id));
  const reasonCodes: MemoryReviewBotScoreReasonCode[] = [];
  const details: string[] = [];
  for (const memoryResult of validation.output.memory_results) {
    if (requiresEvidence(memoryResult) && memoryResult.evidence_ids.length === 0) {
      reasonCodes.push("missing_required_evidence");
      details.push(`${memoryResult.memory_id} has a substantive judgment without evidence.`);
    }
    for (const evidenceId of memoryResult.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) {
        reasonCodes.push("fabricated_evidence_id");
        details.push(`${memoryResult.memory_id} cites unknown evidence_id ${evidenceId}.`);
      }
    }
  }
  return result("evidence_valid", reasonCodes.length === 0, reasonCodes, details);
}

export function scoreConfusionExact(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) return result("confusion_exact", false, validation.reasonCodes, validation.details);
  if (validation.output.prompt_outcome !== fixture.expected.prompt_outcome) {
    return result(
      "confusion_exact",
      false,
      ["confusion_mismatch"],
      [`expected ${fixture.expected.prompt_outcome}, got ${validation.output.prompt_outcome}`],
    );
  }
  return result("confusion_exact", true, [], []);
}

export function scoreItemLabelsExact(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) return result("item_labels_exact", false, validation.reasonCodes, validation.details);

  const actualById = resultsByMemoryId(validation.output.memory_results);
  const reasonCodes: MemoryReviewBotScoreReasonCode[] = [];
  const details: string[] = [];
  for (const expected of fixture.expected.memory_results) {
    const actualResult = actualById.get(expected.memory_id);
    if (!actualResult) {
      reasonCodes.push("missing_memory_result");
      details.push(`Missing actual result for ${expected.memory_id}.`);
      continue;
    }
    if (
      actualResult.relevance !== expected.relevance &&
      !allowsInactiveNeutralRelevanceBoundary(expected, actualResult)
    ) {
      reasonCodes.push("relevance_mismatch");
      details.push(`${expected.memory_id} relevance expected ${expected.relevance}, got ${actualResult.relevance}.`);
    }
    if (actualResult.usefulness !== expected.usefulness) {
      reasonCodes.push("usefulness_mismatch");
      details.push(`${expected.memory_id} usefulness expected ${expected.usefulness}, got ${actualResult.usefulness}.`);
    }
    if (actualResult.effect !== expected.effect) {
      reasonCodes.push("effect_mismatch");
      details.push(`${expected.memory_id} effect expected ${expected.effect}, got ${actualResult.effect}.`);
    }
  }
  return result("item_labels_exact", reasonCodes.length === 0, reasonCodes, details);
}

export function scoreFalsePositiveHurtExact(
  fixture: MemoryReviewBotEvalFixture,
  actual: unknown,
): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) {
    return result("false_positive_hurt_exact", false, validation.reasonCodes, validation.details);
  }

  const expectedHurtIds = hurtFalsePositiveIds(fixture.expected.prompt_outcome, fixture.expected.memory_results);
  const actualHurtIds = hurtFalsePositiveIds(validation.output.prompt_outcome, validation.output.memory_results);
  if (!sameSortedStrings(expectedHurtIds, actualHurtIds)) {
    return result(
      "false_positive_hurt_exact",
      false,
      ["false_positive_hurt_mismatch"],
      [
        `expected hurt false-positive memories ${expectedHurtIds.join(",") || "none"}, got ${
          actualHurtIds.join(",") || "none"
        }`,
      ],
    );
  }
  return result("false_positive_hurt_exact", true, [], []);
}

export function scoreRootCauseExact(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) return result("root_cause_exact", false, validation.reasonCodes, validation.details);

  const actualById = resultsByMemoryId(validation.output.memory_results);
  const reasonCodes: MemoryReviewBotScoreReasonCode[] = [];
  const details: string[] = [];
  for (const expected of fixture.expected.memory_results) {
    const actualResult = actualById.get(expected.memory_id);
    if (!actualResult) {
      reasonCodes.push("missing_memory_result");
      details.push(`Missing actual result for ${expected.memory_id}.`);
      continue;
    }
    const expectedRootCauses = sortStrings(expected.root_causes);
    const actualRootCauses = sortStrings(actualResult.root_causes);
    if (!sameSortedStrings(expectedRootCauses, actualRootCauses)) {
      reasonCodes.push("root_cause_mismatch");
      details.push(
        `${expected.memory_id} root causes expected ${expectedRootCauses.join(",") || "none"}, got ${
          actualRootCauses.join(",") || "none"
        }.`,
      );
    }
  }
  return result("root_cause_exact", reasonCodes.length === 0, reasonCodes, details);
}

export function scoreLifecycleExact(fixture: MemoryReviewBotEvalFixture, actual: unknown): MemoryReviewBotScoreResult {
  const validation = validateReviewerOutput(fixture, actual);
  if (!validation.output) return result("lifecycle_exact", false, validation.reasonCodes, validation.details);

  const actualById = resultsByMemoryId(validation.output.memory_results);
  const reasonCodes: MemoryReviewBotScoreReasonCode[] = [];
  const details: string[] = [];
  for (const expected of fixture.expected.memory_results) {
    const actualResult = actualById.get(expected.memory_id);
    if (!actualResult) {
      reasonCodes.push("missing_memory_result");
      details.push(`Missing actual result for ${expected.memory_id}.`);
      continue;
    }
    if (actualResult.lifecycle_state !== expected.lifecycle_state) {
      reasonCodes.push("lifecycle_mismatch");
      details.push(
        `${expected.memory_id} lifecycle expected ${expected.lifecycle_state}, got ${actualResult.lifecycle_state}.`,
      );
    }
  }
  return result("lifecycle_exact", reasonCodes.length === 0, reasonCodes, details);
}

export function validateReviewerOutput(fixture: MemoryReviewBotEvalFixture, actual: unknown): ReviewerOutputValidation {
  const reasonCodes: MemoryReviewBotScoreReasonCode[] = [];
  const details: string[] = [];
  if (!isRecord(actual)) {
    return {
      output: null,
      reasonCodes: ["invalid_schema"],
      details: ["Reviewer output must be an object."],
    };
  }

  const promptOutcome = readEnum(actual, "prompt_outcome", PROMPT_OUTCOMES, reasonCodes, details);
  const confidence = readConfidence(actual, reasonCodes, details);
  const summary = readNonEmptyString(actual, "summary", reasonCodes, details);
  const failureCode = readOptionalEnum(actual, "failure_code", MEMORY_REVIEW_FAILURE_CODES, reasonCodes, details);
  const rawMemoryResults = actual.memory_results;
  if (!Array.isArray(rawMemoryResults)) {
    reasonCodes.push("invalid_schema");
    details.push("memory_results must be an array.");
  }

  const memoryResults: MemoryReviewLabels[] = [];
  const returnedMemoryIds = new Set(fixture.returned_memories.map((memory) => memory.memory_id));
  const seenMemoryIds = new Set<string>();
  if (Array.isArray(rawMemoryResults)) {
    rawMemoryResults.forEach((entry, index) => {
      const parsed = parseMemoryResult(entry, index, reasonCodes, details);
      if (!parsed) return;
      if (!returnedMemoryIds.has(parsed.memory_id)) {
        reasonCodes.push("unexpected_memory_result");
        details.push(`Reviewer returned unknown memory_id ${parsed.memory_id}.`);
      }
      if (seenMemoryIds.has(parsed.memory_id)) {
        reasonCodes.push("duplicate_memory_result");
        details.push(`Reviewer returned duplicate memory_id ${parsed.memory_id}.`);
      }
      seenMemoryIds.add(parsed.memory_id);
      memoryResults.push(parsed);
    });
  }

  for (const memoryId of returnedMemoryIds) {
    if (!seenMemoryIds.has(memoryId)) {
      reasonCodes.push("missing_memory_result");
      details.push(`Reviewer output is missing returned memory ${memoryId}.`);
    }
  }

  if (!promptOutcome || confidence === null || !summary || reasonCodes.length > 0) {
    return { output: null, reasonCodes: uniqueReasonCodes(reasonCodes), details };
  }

  return {
    output: {
      prompt_outcome: promptOutcome,
      confidence,
      summary,
      memory_results: memoryResults,
      ...(failureCode ? { failure_code: failureCode } : {}),
    },
    reasonCodes: [],
    details: [],
  };
}

function parseMemoryResult(
  entry: unknown,
  index: number,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): MemoryReviewLabels | null {
  if (!isRecord(entry)) {
    reasonCodes.push("invalid_schema");
    details.push(`memory_results[${index}] must be an object.`);
    return null;
  }

  const memoryId = readNonEmptyString(entry, "memory_id", reasonCodes, details);
  const relevance = readEnum(entry, "relevance", MEMORY_RELEVANCE_LABELS, reasonCodes, details);
  const usefulness = readEnum(entry, "usefulness", MEMORY_USEFULNESS_LABELS, reasonCodes, details);
  const effect = readEnum(entry, "effect", MEMORY_EFFECT_LABELS, reasonCodes, details);
  const lifecycleState = readEnum(entry, "lifecycle_state", MEMORY_LIFECYCLE_STATES, reasonCodes, details);
  const rootCauses = readEnumArray(entry, "root_causes", MEMORY_REVIEW_ROOT_CAUSES, reasonCodes, details);
  const evidenceIds = readStringArray(entry, "evidence_ids", reasonCodes, details);
  const rationale = typeof entry.rationale === "string" ? entry.rationale : undefined;

  if (!memoryId || !relevance || !usefulness || !effect || !lifecycleState || !rootCauses || !evidenceIds) {
    return null;
  }
  return {
    memory_id: memoryId,
    relevance,
    usefulness,
    effect,
    lifecycle_state: lifecycleState,
    root_causes: rootCauses,
    evidence_ids: evidenceIds,
    ...(rationale ? { rationale } : {}),
  };
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): T[number] | null {
  const value = record[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    reasonCodes.push("invalid_enum");
    details.push(`${key} must be one of ${allowed.join(", ")}.`);
    return null;
  }
  return value as T[number];
}

function readOptionalEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): T[number] | null {
  if (!(key in record)) return null;
  return readEnum(record, key, allowed, reasonCodes, details);
}

function readEnumArray<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): T[number][] | null {
  const values = readStringArray(record, key, reasonCodes, details);
  if (!values) return null;
  const parsed: T[number][] = [];
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      reasonCodes.push("invalid_enum");
      details.push(`${key} contains invalid value ${value}.`);
      continue;
    }
    parsed.push(value as T[number]);
  }
  return parsed;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    reasonCodes.push("invalid_schema");
    details.push(`${key} must be an array.`);
    return null;
  }
  const strings: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      reasonCodes.push("invalid_schema");
      details.push(`${key}[${index}] must be a non-empty string.`);
      return;
    }
    strings.push(entry);
  });
  return strings;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    reasonCodes.push("invalid_schema");
    details.push(`${key} must be a non-empty string.`);
    return null;
  }
  return value;
}

function readConfidence(
  record: Record<string, unknown>,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): number | null {
  const value = record.confidence;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    reasonCodes.push("invalid_schema");
    details.push("confidence must be a number between 0 and 1.");
    return null;
  }
  return value;
}

function result(
  scorer: MemoryReviewBotScorerName,
  passed: boolean,
  reasonCodes: MemoryReviewBotScoreReasonCode[],
  details: string[],
): MemoryReviewBotScoreResult {
  return {
    scorer,
    passed,
    reason_codes: uniqueReasonCodes(reasonCodes),
    details,
  };
}

function requiresEvidence(memoryResult: MemoryReviewLabels): boolean {
  return (
    memoryResult.relevance !== "borderline" ||
    memoryResult.usefulness === "useful" ||
    memoryResult.effect !== "neutral" ||
    memoryResult.root_causes.length > 0
  );
}

function resultsByMemoryId(results: MemoryReviewLabels[]): Map<string, MemoryReviewLabels> {
  return new Map(results.map((entry) => [entry.memory_id, entry]));
}

function allowsInactiveNeutralRelevanceBoundary(expected: MemoryReviewLabels, actual: MemoryReviewLabels): boolean {
  const boundary = new Set(["borderline", "irrelevant"]);
  return (
    boundary.has(expected.relevance) &&
    boundary.has(actual.relevance) &&
    expected.usefulness === "not_useful" &&
    actual.usefulness === "not_useful" &&
    expected.effect === "neutral" &&
    actual.effect === "neutral" &&
    expected.lifecycle_state === actual.lifecycle_state &&
    isInactiveLifecycleState(expected.lifecycle_state)
  );
}

function isInactiveLifecycleState(state: MemoryReviewLabels["lifecycle_state"]): boolean {
  return state === "superseded" || state === "expired" || state === "rejected";
}

function hurtFalsePositiveIds(promptOutcome: string, memoryResults: MemoryReviewLabels[]): string[] {
  if (promptOutcome !== "false_positive") return [];
  return sortStrings(
    memoryResults.filter((resultEntry) => resultEntry.effect === "hurt").map((resultEntry) => resultEntry.memory_id),
  );
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function uniqueReasonCodes(reasonCodes: MemoryReviewBotScoreReasonCode[]): MemoryReviewBotScoreReasonCode[] {
  return [...new Set(reasonCodes)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
