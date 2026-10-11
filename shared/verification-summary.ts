import { commandLooksFailed } from "./command-classification.js";
import type {
  ExecutionVerification,
  PrReadinessCheck,
  PrReadinessEvidence,
  VerificationArtifact,
  VerifierCheckStatus,
} from "./types/sandbox.js";

/**
 * Presentation-neutral summary of what verification actually ran for a
 * session. Built once from the readiness/verification evidence the pipeline
 * already collects; the PR body renderer and the session UI both consume this
 * struct so "what was verified" never diverges between surfaces.
 */
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type VerificationSummaryCommand = {
  command: string;
  status: VerifierCheckStatus;
  exitCode: number | null;
  source: "post_execution";
  checks: PrReadinessCheck[];
  summary?: string;
  /** Redacted tail of failed command stderr/output (reviewer-facing). */
  failureOutput?: string;
  skipReason?: string;
};

/** Outcome-discriminated part. */
export type VerificationSummaryOutcomeFields =
  { outcome: "draft"; draftReason?: string } | { outcome: "verified" | "unverified"; draftReason?: never };

export type VerificationSummary = VerificationSummaryOutcomeFields & {
  commands: VerificationSummaryCommand[];
  /** Checks with at least one passing command. */
  checksPassed: PrReadinessCheck[];
  skippedChecks: Array<{ check: PrReadinessCheck; reason: string }>;
  /** Screenshot/video artifacts only — the publicly renderable artifact types. */
  visualArtifacts: VerificationArtifact[];
  runtimeEvidence: { required: boolean; satisfied: boolean } | null;
  caveats: string[];
};

export type BuildVerificationSummaryInput = {
  verification?: ExecutionVerification | null;
  readiness?: PrReadinessEvidence | null;
};

function commandChecks(command: { check?: PrReadinessCheck; checks?: PrReadinessCheck[] }): PrReadinessCheck[] {
  if (command.checks && command.checks.length > 0) return command.checks;
  return command.check ? [command.check] : [];
}

function resolveOutcome(verification: ExecutionVerification | null | undefined): VerificationSummaryOutcomeFields {
  if (verification?.publishMode === "draft") {
    const draftReason = verification.manualReviewReason?.trim();
    return { outcome: "draft", ...(draftReason ? { draftReason } : {}) };
  }
  return { outcome: verification?.verified ? "verified" : "unverified" };
}

export function buildVerificationSummary(input: BuildVerificationSummaryInput): VerificationSummary {
  const { verification, readiness } = input;

  const commands: VerificationSummaryCommand[] = (readiness?.commandsRun ?? [])
    .filter((command) => command.source === "post_execution")
    .map((command) => ({
      command: command.command,
      // "completed" means the command ran, not that it succeeded: a non-zero
      // exit code or failure-shaped output still counts as failed (same
      // classification the PR-template input builder uses).
      status: command.status === "skipped" ? "skipped" : commandLooksFailed(command) ? "failed" : "passed",
      exitCode: command.exitCode,
      source: "post_execution",
      checks: commandChecks(command),
      ...(command.summary ? { summary: command.summary } : {}),
      ...(command.failureOutput ? { failureOutput: command.failureOutput } : {}),
      ...(command.skipReason ? { skipReason: command.skipReason } : {}),
    }));

  const checksPassed = [
    ...new Set(commands.filter((command) => command.status === "passed").flatMap((command) => command.checks)),
  ];

  const visualArtifacts = (verification?.artifacts ?? []).filter(
    (artifact) => artifact.type === "screenshot" || artifact.type === "video",
  );

  const runtimeEvidence =
    verification?.runtimeEvidenceRequired !== undefined || verification?.runtimeEvidenceSatisfied !== undefined
      ? {
          required: verification?.runtimeEvidenceRequired === true,
          satisfied: verification?.runtimeEvidenceSatisfied === true,
        }
      : null;

  return {
    ...resolveOutcome(verification),
    commands,
    checksPassed,
    skippedChecks: (readiness?.skippedChecks ?? []).map((entry) => ({ check: entry.check, reason: entry.reason })),
    visualArtifacts,
    runtimeEvidence,
    caveats: verification?.caveats ?? [],
  };
}
