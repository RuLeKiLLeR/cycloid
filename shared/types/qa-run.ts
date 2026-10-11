import type { VerificationResult, VerificationState } from "../session/phase.js";

export const QA_RUN_BLOCKER_LIMIT = 5;
export const QA_RUN_BLOCKER_MAX_CHARS = 300;
export const QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY = "qa_run_terminal_summary";

export type QaRunTerminalSummary = {
  childSessionId: string;
  runId?: number;
  head: string | null;
  evidenceCount: number;
  blockers: string[];
};

export type QaRunCoordinationSnapshot = {
  state?: string | null;
  verificationChildId?: string | null;
  verificationRunId?: number | null;
  verificationRunHead?: string | null;
  verificationRunCount?: number | null;
  verdictHeadSha?: string | null;
  headSha?: string | null;
};

export type QaRunView = {
  state: VerificationState | null;
  verdict: VerificationResult | null;
  childSessionId: string | null;
  runId: number | null;
  head: string | null;
  attemptCount: number;
  maxAttempts: number | null;
  evidenceCount: number | null;
  blockers: string[];
};

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars).trimEnd();
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function normalizeQaRunBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const blockers: string[] = [];
  for (const item of value) {
    const blocker = boundedString(item, QA_RUN_BLOCKER_MAX_CHARS);
    if (!blocker) continue;
    blockers.push(blocker);
    if (blockers.length >= QA_RUN_BLOCKER_LIMIT) break;
  }
  return blockers;
}

export function normalizeQaRunTerminalSummary(value: unknown): QaRunTerminalSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const childSessionId = boundedString(record.childSessionId, 128);
  if (!childSessionId) return null;
  const runId = nonNegativeInteger(record.runId);
  const head = boundedString(record.head, 128);
  const evidenceCount = nonNegativeInteger(record.evidenceCount) ?? 0;
  return {
    childSessionId,
    ...(runId !== null ? { runId } : {}),
    head,
    evidenceCount,
    blockers: normalizeQaRunBlockers(record.blockers),
  };
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstNonNegativeInteger(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

export function buildQaRunView(input: {
  state?: VerificationState | null;
  verdict?: VerificationResult | null;
  attemptCount?: number | null;
  maxAttempts?: number | null;
  terminal?: QaRunTerminalSummary | null;
  coordination?: QaRunCoordinationSnapshot | null;
}): QaRunView | null {
  const terminal = input.terminal ?? null;
  const coordination = input.coordination ?? null;
  const activeCoordination = coordination?.state === "VERIFYING";
  const childSessionId = firstNonEmptyString(coordination?.verificationChildId, terminal?.childSessionId);
  const runId = firstNonNegativeInteger(coordination?.verificationRunId, terminal?.runId);
  const head = activeCoordination
    ? firstNonEmptyString(coordination?.verificationRunHead, coordination?.headSha, terminal?.head)
    : firstNonEmptyString(
        terminal?.head,
        coordination?.verdictHeadSha,
        coordination?.verificationRunHead,
        coordination?.headSha,
      );
  const attemptCount = firstNonNegativeInteger(coordination?.verificationRunCount, input.attemptCount) ?? 0;
  const maxAttempts = firstNonNegativeInteger(input.maxAttempts);
  const evidenceCount = terminal ? terminal.evidenceCount : null;
  const blockers = terminal?.blockers ?? [];
  const state = input.state ?? null;
  const verdict = input.verdict ?? null;

  if (
    !state &&
    !verdict &&
    !childSessionId &&
    runId === null &&
    !head &&
    attemptCount === 0 &&
    evidenceCount === null &&
    blockers.length === 0
  ) {
    return null;
  }

  return {
    state,
    verdict,
    childSessionId,
    runId,
    head,
    attemptCount,
    maxAttempts,
    evidenceCount,
    blockers,
  };
}
