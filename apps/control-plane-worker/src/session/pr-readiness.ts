import type { PrReadinessCheck, PrReadinessCommand, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";

const PR_READINESS_CHECKS = ["tests", "lint", "typecheck"] as const satisfies readonly PrReadinessCheck[];
const PR_COMMAND_STATUSES = ["completed", "error", "skipped"] as const;
const PR_COMMAND_SOURCES = ["agent", "post_execution"] as const;
const MAX_COMMAND_TEXT_LENGTH = 12_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asBoundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > MAX_COMMAND_TEXT_LENGTH ? value.slice(-MAX_COMMAND_TEXT_LENGTH) : value;
}

function normalizeCheck(value: unknown): PrReadinessCheck | undefined {
  return typeof value === "string" && PR_READINESS_CHECKS.includes(value as PrReadinessCheck)
    ? (value as PrReadinessCheck)
    : undefined;
}

function normalizeChecksDetected(value: unknown): Record<PrReadinessCheck, boolean> {
  const raw = isObject(value) ? value : {};
  return {
    tests: asBoolean(raw.tests),
    lint: asBoolean(raw.lint),
    typecheck: asBoolean(raw.typecheck),
  };
}

function normalizeCommand(value: unknown): PrReadinessCommand | null {
  if (!isObject(value)) return null;
  const status =
    typeof value.status === "string" &&
    PR_COMMAND_STATUSES.includes(value.status as (typeof PR_COMMAND_STATUSES)[number])
      ? (value.status as PrReadinessCommand["status"])
      : null;
  const source =
    typeof value.source === "string" && PR_COMMAND_SOURCES.includes(value.source as (typeof PR_COMMAND_SOURCES)[number])
      ? (value.source as PrReadinessCommand["source"])
      : null;
  if (!status || !source) return null;

  const command = asString(value.command) ?? "command unavailable";
  const check = normalizeCheck(value.check);
  const checks = Array.isArray(value.checks)
    ? value.checks.map(normalizeCheck).filter((entry): entry is PrReadinessCheck => entry !== undefined)
    : [];
  const summary = asBoundedString(value.summary);
  const failureOutput = status === "error" ? asBoundedString(value.failureOutput) : null;

  return {
    command,
    status,
    source,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    hasOutput: asBoolean(value.hasOutput),
    ...(check ? { check } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(summary ? { summary } : {}),
    ...(failureOutput ? { failureOutput } : {}),
    ...(typeof value.skipReason === "string" ? { skipReason: value.skipReason } : {}),
  };
}

function normalizeSkippedChecks(value: unknown): PrReadinessEvidence["skippedChecks"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isObject(entry)) return null;
      const check = normalizeCheck(entry.check);
      const reason = asString(entry.reason);
      return check && reason ? { check, reason } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        check: PrReadinessCheck;
        reason: string;
      } => entry !== null,
    );
}

function normalizeAgentTimeline(value: unknown): PrReadinessEvidence["agentTimeline"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is NonNullable<(typeof value)[number]> => isObject(entry));
  return entries.length > 0 ? (entries as PrReadinessEvidence["agentTimeline"]) : [];
}

export function normalizePrReadinessEvidence(value: unknown): PrReadinessEvidence | null {
  if (!isObject(value)) return null;

  const diffStats = isObject(value.diffStats) ? value.diffStats : {};
  const evidenceBundle = isObject(value.evidenceBundle) ? value.evidenceBundle : null;
  const agentTimeline = normalizeAgentTimeline(value.agentTimeline);
  const commandsRun = Array.isArray(value.commandsRun)
    ? value.commandsRun.map(normalizeCommand).filter((entry): entry is PrReadinessCommand => entry !== null)
    : [];

  return {
    changedFiles: asStringArray(value.changedFiles),
    diffStats: {
      ...(typeof diffStats.raw === "string" ? { raw: diffStats.raw } : {}),
      filesChanged: typeof diffStats.filesChanged === "number" ? diffStats.filesChanged : 0,
      insertions: typeof diffStats.insertions === "number" ? diffStats.insertions : 0,
      deletions: typeof diffStats.deletions === "number" ? diffStats.deletions : 0,
    },
    commandsRun,
    checksDetected: normalizeChecksDetected(value.checksDetected),
    skippedChecks: normalizeSkippedChecks(value.skippedChecks),
    filesMentionedInFinalAnswer: asStringArray(value.filesMentionedInFinalAnswer),
    ...(agentTimeline ? { agentTimeline } : {}),
    ...(evidenceBundle
      ? {
          evidenceBundle: {
            ...(typeof evidenceBundle.originalPrompt === "string"
              ? { originalPrompt: evidenceBundle.originalPrompt }
              : {}),
            ...(typeof evidenceBundle.finalSummary === "string" ? { finalSummary: evidenceBundle.finalSummary } : {}),
            ...(typeof evidenceBundle.agentFinalMessage === "string"
              ? { agentFinalMessage: evidenceBundle.agentFinalMessage }
              : {}),
            ...(typeof evidenceBundle.sessionUrl === "string" ? { sessionUrl: evidenceBundle.sessionUrl } : {}),
            ...(typeof evidenceBundle.issueUrl === "string" ? { issueUrl: evidenceBundle.issueUrl } : {}),
          },
        }
      : {}),
  };
}
