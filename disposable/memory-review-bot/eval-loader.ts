import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  MEMORY_EFFECT_LABELS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_RELEVANCE_LABELS,
  MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION,
  MEMORY_REVIEW_FAILURE_CODES,
  MEMORY_REVIEW_ROOT_CAUSES,
  MEMORY_USEFULNESS_LABELS,
  type MemoryReviewBotEvalFixture,
  type MemoryReviewLabels,
  PROMPT_OUTCOMES,
  REVIEW_BOT_EVIDENCE_KINDS,
  REVIEW_BOT_FIXTURE_SOURCES,
  REVIEW_BOT_RETURNED_MEMORY_SOURCES,
} from "./eval-schema";

export const DEFAULT_MEMORY_REVIEW_BOT_TUNING_FIXTURE_DIR = path.join(
  process.cwd(),
  "docs",
  "memory-new",
  "review-bot-fixtures",
  "tuning",
);

const MAX_TASK_SUMMARY_CHARS = 700;
const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTCOME_SUMMARY_CHARS = 2_000;
const MAX_MEMORY_EXCERPT_CHARS = 1_200;
const MAX_EVIDENCE_SNIPPET_CHARS = 1_200;
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EVIDENCE_ID_PATTERN = /^ev_[a-z0-9][a-z0-9_]*$/;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const MEMORY_REVIEW_BOT_FIXTURE_REASON_CODES = [
  "invalid_json",
  "invalid_fixture_shape",
  "missing_required_field",
  "invalid_enum",
  "invalid_id",
  "duplicate_memory_id",
  "duplicate_evidence_id",
  "unknown_memory_id",
  "fabricated_evidence_id",
  "snippet_too_large",
  "secret_detected",
] as const;
export type MemoryReviewBotFixtureReasonCode = (typeof MEMORY_REVIEW_BOT_FIXTURE_REASON_CODES)[number];

export interface MemoryReviewBotFixtureIssue {
  code: MemoryReviewBotFixtureReasonCode;
  path: string;
  message: string;
}

export class MemoryReviewBotFixtureValidationError extends Error {
  readonly issues: MemoryReviewBotFixtureIssue[];
  readonly reasonCodes: MemoryReviewBotFixtureReasonCode[];

  constructor(message: string, issues: MemoryReviewBotFixtureIssue[]) {
    super(message);
    this.name = "MemoryReviewBotFixtureValidationError";
    this.issues = issues;
    this.reasonCodes = [...new Set(issues.map((issue) => issue.code))];
  }
}

export async function loadMemoryReviewBotFixtures(
  fixturePath = DEFAULT_MEMORY_REVIEW_BOT_TUNING_FIXTURE_DIR,
): Promise<MemoryReviewBotEvalFixture[]> {
  const fixtureStat = await stat(fixturePath);
  const filePaths = fixtureStat.isDirectory()
    ? (await readdir(fixturePath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(fixturePath, entry.name))
        .sort((a, b) => a.localeCompare(b))
    : [fixturePath];

  const fixtures: MemoryReviewBotEvalFixture[] = [];
  for (const filePath of filePaths) {
    fixtures.push(await loadMemoryReviewBotFixtureFile(filePath));
  }
  return fixtures;
}

export async function loadMemoryReviewBotFixtureFile(filePath: string): Promise<MemoryReviewBotEvalFixture> {
  const rawText = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MemoryReviewBotFixtureValidationError(`Invalid JSON in ${filePath}: ${message}`, [
      { code: "invalid_json", path: "$", message },
    ]);
  }
  return validateMemoryReviewBotFixture(parsed, filePath);
}

export function validateMemoryReviewBotFixture(raw: unknown, sourceName = "<memory-review-bot-fixture>") {
  const issues: MemoryReviewBotFixtureIssue[] = [];
  if (!isRecord(raw)) {
    throw new MemoryReviewBotFixtureValidationError(`${sourceName} must be a JSON object`, [
      { code: "invalid_fixture_shape", path: "$", message: "Fixture root must be an object." },
    ]);
  }

  readEnum(raw, "schema_version", [MEMORY_REVIEW_BOT_FIXTURE_SCHEMA_VERSION], "$.schema_version", issues);
  const fixtureId = readString(raw, "fixture_id", "$.fixture_id", issues, { max: 120 });
  if (fixtureId && !FIXTURE_ID_PATTERN.test(fixtureId)) {
    issue(issues, "invalid_id", "$.fixture_id", "fixture_id must be a stable lowercase slug.");
  }
  readEnum(raw, "fixture_source", REVIEW_BOT_FIXTURE_SOURCES, "$.fixture_source", issues);

  const prompt = readRecord(raw, "prompt", "$.prompt", issues);
  if (prompt) {
    const taskSummary = readString(prompt, "task_summary", "$.prompt.task_summary", issues, {
      max: MAX_TASK_SUMMARY_CHARS,
    });
    const boundedPrompt = readString(prompt, "bounded_prompt", "$.prompt.bounded_prompt", issues, {
      max: MAX_PROMPT_CHARS,
    });
    readOptionalString(prompt, "session_id", "$.prompt.session_id", issues, { max: 120 });
    readOptionalString(prompt, "prompt_id", "$.prompt.prompt_id", issues, { max: 120 });
    readOptionalString(prompt, "outcome_summary", "$.prompt.outcome_summary", issues, {
      max: MAX_OUTCOME_SUMMARY_CHARS,
    });
    scanForSecrets(taskSummary, "$.prompt.task_summary", issues);
    scanForSecrets(boundedPrompt, "$.prompt.bounded_prompt", issues);
    scanForSecrets(readOptionalRawString(prompt, "outcome_summary"), "$.prompt.outcome_summary", issues);
  }

  const memoryIds = new Set<string>();
  const returnedMemories = readArray(raw, "returned_memories", "$.returned_memories", issues);
  if (returnedMemories) {
    returnedMemories.forEach((entry, index) => {
      const entryPath = `$.returned_memories[${index}]`;
      if (!isRecord(entry)) {
        issue(issues, "invalid_fixture_shape", entryPath, "Returned memory must be an object.");
        return;
      }
      const memoryId = readString(entry, "memory_id", `${entryPath}.memory_id`, issues, { max: 160 });
      if (memoryId) {
        if (!MEMORY_ID_PATTERN.test(memoryId)) {
          issue(issues, "invalid_id", `${entryPath}.memory_id`, "memory_id must be stable text.");
        }
        if (memoryIds.has(memoryId)) {
          issue(issues, "duplicate_memory_id", `${entryPath}.memory_id`, `Duplicate memory_id ${memoryId}.`);
        }
        memoryIds.add(memoryId);
      }
      readEnum(entry, "source", REVIEW_BOT_RETURNED_MEMORY_SOURCES, `${entryPath}.source`, issues);
      readPositiveInteger(entry, "rank", `${entryPath}.rank`, issues);
      readBoundedNumber(entry, "score", `${entryPath}.score`, issues, 0, 1);
      readEnum(entry, "lifecycle_state", MEMORY_LIFECYCLE_STATES, `${entryPath}.lifecycle_state`, issues);
      readString(entry, "scope", `${entryPath}.scope`, issues, { max: 240 });
      const excerpt = readString(entry, "content_excerpt", `${entryPath}.content_excerpt`, issues, {
        max: MAX_MEMORY_EXCERPT_CHARS,
      });
      scanForSecrets(excerpt, `${entryPath}.content_excerpt`, issues);
    });
  }

  const evidenceIds = new Set<string>();
  const evidence = readArray(raw, "evidence", "$.evidence", issues);
  if (evidence) {
    if (evidence.length === 0) {
      issue(issues, "missing_required_field", "$.evidence", "At least one evidence snippet is required.");
    }
    evidence.forEach((entry, index) => {
      const entryPath = `$.evidence[${index}]`;
      if (!isRecord(entry)) {
        issue(issues, "invalid_fixture_shape", entryPath, "Evidence must be an object.");
        return;
      }
      const evidenceId = readString(entry, "evidence_id", `${entryPath}.evidence_id`, issues, { max: 120 });
      if (evidenceId) {
        if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
          issue(issues, "invalid_id", `${entryPath}.evidence_id`, "evidence_id must look like ev_stable_id.");
        }
        if (evidenceIds.has(evidenceId)) {
          issue(issues, "duplicate_evidence_id", `${entryPath}.evidence_id`, `Duplicate evidence_id ${evidenceId}.`);
        }
        evidenceIds.add(evidenceId);
      }
      readEnum(entry, "kind", REVIEW_BOT_EVIDENCE_KINDS, `${entryPath}.kind`, issues);
      readOptionalString(entry, "source_ref", `${entryPath}.source_ref`, issues, { max: 240 });
      const snippet = readString(entry, "snippet", `${entryPath}.snippet`, issues, {
        max: MAX_EVIDENCE_SNIPPET_CHARS,
      });
      scanForSecrets(snippet, `${entryPath}.snippet`, issues);
    });
  }

  const expected = readRecord(raw, "expected", "$.expected", issues);
  if (expected) {
    readEnum(expected, "prompt_outcome", PROMPT_OUTCOMES, "$.expected.prompt_outcome", issues);
    readOptionalEnum(expected, "failure_code", MEMORY_REVIEW_FAILURE_CODES, "$.expected.failure_code", issues);
    validateEvidenceIdArray(expected, "evidence_ids", "$.expected.evidence_ids", evidenceIds, issues, true);
    validateOptionalMemoryIdArray(expected, "missed_memory_ids", "$.expected.missed_memory_ids", issues);

    const expectedResults = readArray(expected, "memory_results", "$.expected.memory_results", issues);
    if (expectedResults) {
      const expectedResultIds = new Set<string>();
      expectedResults.forEach((entry, index) => {
        validateExpectedMemoryResult(entry, index, memoryIds, evidenceIds, expectedResultIds, issues);
      });
      for (const memoryId of memoryIds) {
        if (!expectedResultIds.has(memoryId)) {
          issue(
            issues,
            "unknown_memory_id",
            "$.expected.memory_results",
            `Expected labels are missing returned memory ${memoryId}.`,
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new MemoryReviewBotFixtureValidationError(
      `${sourceName} failed memory review bot fixture validation`,
      issues,
    );
  }
  return raw as unknown as MemoryReviewBotEvalFixture;
}

function validateExpectedMemoryResult(
  entry: unknown,
  index: number,
  memoryIds: Set<string>,
  evidenceIds: Set<string>,
  seenResultIds: Set<string>,
  issues: MemoryReviewBotFixtureIssue[],
): void {
  const entryPath = `$.expected.memory_results[${index}]`;
  if (!isRecord(entry)) {
    issue(issues, "invalid_fixture_shape", entryPath, "Expected memory result must be an object.");
    return;
  }
  const memoryId = readString(entry, "memory_id", `${entryPath}.memory_id`, issues, { max: 160 });
  if (memoryId) {
    if (!memoryIds.has(memoryId)) {
      issue(issues, "unknown_memory_id", `${entryPath}.memory_id`, `Unknown returned memory_id ${memoryId}.`);
    }
    if (seenResultIds.has(memoryId)) {
      issue(issues, "duplicate_memory_id", `${entryPath}.memory_id`, `Duplicate expected result for ${memoryId}.`);
    }
    seenResultIds.add(memoryId);
  }
  readEnum(entry, "relevance", MEMORY_RELEVANCE_LABELS, `${entryPath}.relevance`, issues);
  readEnum(entry, "usefulness", MEMORY_USEFULNESS_LABELS, `${entryPath}.usefulness`, issues);
  readEnum(entry, "effect", MEMORY_EFFECT_LABELS, `${entryPath}.effect`, issues);
  readEnum(entry, "lifecycle_state", MEMORY_LIFECYCLE_STATES, `${entryPath}.lifecycle_state`, issues);
  validateEnumArray(entry, "root_causes", MEMORY_REVIEW_ROOT_CAUSES, `${entryPath}.root_causes`, issues);
  validateEvidenceIdArray(entry, "evidence_ids", `${entryPath}.evidence_ids`, evidenceIds, issues, true);
  readOptionalString(entry, "rationale", `${entryPath}.rationale`, issues, { max: 700 });
  scanForSecrets(readOptionalRawString(entry, "rationale"), `${entryPath}.rationale`, issues);
}

function validateEvidenceIdArray(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  evidenceIds: Set<string>,
  issues: MemoryReviewBotFixtureIssue[],
  requireNonEmpty: boolean,
): void {
  const values = readStringArray(record, key, pathName, issues);
  if (!values) return;
  if (requireNonEmpty && values.length === 0) {
    issue(issues, "missing_required_field", pathName, "At least one evidence ID is required.");
  }
  for (const evidenceId of values) {
    if (!evidenceIds.has(evidenceId)) {
      issue(issues, "fabricated_evidence_id", pathName, `Unknown evidence_id ${evidenceId}.`);
    }
  }
}

function validateOptionalMemoryIdArray(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): void {
  if (!(key in record)) return;
  const values = readStringArray(record, key, pathName, issues);
  if (!values) return;
  for (const memoryId of values) {
    if (!MEMORY_ID_PATTERN.test(memoryId)) {
      issue(issues, "invalid_id", pathName, `Invalid missed memory_id ${memoryId}.`);
    }
  }
}

function validateEnumArray<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): void {
  const values = readStringArray(record, key, pathName, issues);
  if (!values) return;
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      issue(issues, "invalid_enum", pathName, `${value} is not an allowed value.`);
    }
  }
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): Record<string, unknown> | null {
  const value = record[key];
  if (!isRecord(value)) {
    issue(issues, "missing_required_field", pathName, "Expected object.");
    return null;
  }
  return value;
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): unknown[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    issue(issues, "missing_required_field", pathName, "Expected array.");
    return null;
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
  options: { max: number },
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, "missing_required_field", pathName, "Expected non-empty string.");
    return null;
  }
  if (value.length > options.max) {
    issue(issues, "snippet_too_large", pathName, `String length ${value.length} exceeds ${options.max}.`);
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
  options: { max: number },
): void {
  if (!(key in record)) return;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, "missing_required_field", pathName, "Expected non-empty string when present.");
    return;
  }
  if (value.length > options.max) {
    issue(issues, "snippet_too_large", pathName, `String length ${value.length} exceeds ${options.max}.`);
  }
}

function readOptionalRawString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    issue(issues, "missing_required_field", pathName, "Expected string array.");
    return null;
  }
  const strings: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issue(issues, "missing_required_field", `${pathName}[${index}]`, "Expected non-empty string.");
      return;
    }
    strings.push(entry);
  });
  return strings;
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): T[number] | null {
  const value = record[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issue(issues, "invalid_enum", pathName, `Expected one of ${allowed.join(", ")}.`);
    return null;
  }
  return value as T[number];
}

function readOptionalEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): void {
  if (!(key in record)) return;
  readEnum(record, key, allowed, pathName, issues);
}

function readPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
): void {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    issue(issues, "missing_required_field", pathName, "Expected positive integer.");
  }
}

function readBoundedNumber(
  record: Record<string, unknown>,
  key: string,
  pathName: string,
  issues: MemoryReviewBotFixtureIssue[],
  min: number,
  max: number,
): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    issue(issues, "missing_required_field", pathName, `Expected number between ${min} and ${max}.`);
  }
}

function scanForSecrets(value: string | null, pathName: string, issues: MemoryReviewBotFixtureIssue[]): void {
  if (!value) return;
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_/\-+=]{8,}/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    issue(issues, "secret_detected", pathName, "Snippet appears to contain an unredacted secret.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function issue(
  issues: MemoryReviewBotFixtureIssue[],
  code: MemoryReviewBotFixtureReasonCode,
  pathName: string,
  message: string,
): void {
  issues.push({ code, path: pathName, message });
}

export function expectedLabelsToReviewerOutput(fixture: MemoryReviewBotEvalFixture) {
  return {
    prompt_outcome: fixture.expected.prompt_outcome,
    confidence: 1,
    summary: `Oracle baseline copied expected labels for ${fixture.fixture_id}.`,
    memory_results: fixture.expected.memory_results.map((result): MemoryReviewLabels => ({ ...result })),
    ...(fixture.expected.failure_code ? { failure_code: fixture.expected.failure_code } : {}),
  };
}
