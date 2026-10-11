import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import type { BridgeLogger } from "../logger.js";
import { resolvePrePublishTestPlan, runConfiguredPrePublishTestCommand } from "../utils/pre-publish-tests.js";
import { resolveChangedFilesAgainstBase } from "./git/diff.js";

export type ReviewCheckStatus = "passed" | "failed" | "skipped";

export type ReviewCheckRecord = {
  command: string;
  reason: string;
  status: ReviewCheckStatus;
  exitCode: number | null;
  detail: string;
};

const MAX_DETAIL_CHARS = 500;
const NOOP_PROMPT_LOG = { warn: () => undefined } as unknown as BridgeLogger;

function bounded(value: string): string {
  return value.length <= MAX_DETAIL_CHARS ? value : `${value.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function failedRecord(reason: string): ReviewCheckRecord {
  return { command: "", reason: bounded(reason), status: "failed", exitCode: null, detail: bounded(reason) };
}

export async function runReviewPreflight(
  cwd: string,
  baseBranch: string | undefined,
  promptLog: BridgeLogger = NOOP_PROMPT_LOG,
): Promise<ReviewCheckRecord[]> {
  const base = baseBranch?.trim() || "main";
  if (!isSafeGitRef(base)) return [failedRecord(`PR base branch is not a safe git ref: ${base}`)];

  const { files: changedFiles, resolved } = resolveChangedFilesAgainstBase(cwd, base, promptLog, 30_000);
  if (!resolved) return [failedRecord("Could not resolve any base ref for the PR diff")];

  const plan = resolvePrePublishTestPlan(cwd, changedFiles);
  if (!plan.ok) return [failedRecord(plan.skipReason)];
  if (plan.skipped) {
    return [
      {
        command: "",
        reason: bounded(plan.skipReason),
        status: "skipped",
        exitCode: null,
        detail: bounded(plan.skipReason),
      },
    ];
  }

  const records: ReviewCheckRecord[] = [];
  for (const configuredCommand of plan.commands) {
    const result = await runConfiguredPrePublishTestCommand(cwd, configuredCommand, plan.timeoutMs);
    const detail = result.ok ? "Configured check passed." : bounded(result.reason);
    records.push({
      command: configuredCommand.command,
      reason: bounded(configuredCommand.reason),
      status: result.ok ? "passed" : "failed",
      exitCode: result.exitCode,
      detail,
    });
  }
  return records;
}
