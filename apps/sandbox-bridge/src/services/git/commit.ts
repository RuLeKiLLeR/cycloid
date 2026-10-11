import { execFileSync } from "child_process";

import {
  CYCLOID_CO_AUTHOR_TRAILER,
  CYCLOID_GIT_COMMITTER_EMAIL,
  CYCLOID_GIT_COMMITTER_NAME,
} from "../../../../../shared/constants/git-identity.js";
import { redact } from "../../../../../shared/observability/redact.js";
import type { AgentTimelineStatus } from "../../../../../shared/types/agent-timeline.js";
import type { BridgeLogger } from "../../logger.js";
import { buildSanitizedHookEnv } from "../../utils/sanitized-env.js";
import { readHeadSha } from "./progress.js";
import type { TimelineRecord } from "./types.js";

const COMMIT_ERROR_SUMMARY_MAX_CHARS = 4_000;
const COMMIT_ERROR_OUTPUT_MAX_CHARS = 1_800;
const TIMELINE_COMPLETED = "completed" satisfies AgentTimelineStatus;
const TIMELINE_FAILED = "failed" satisfies AgentTimelineStatus;
const TIMELINE_SKIPPED = "skipped" satisfies AgentTimelineStatus;
/** Upper bound for the commit, which runs repo pre-commit/commit-msg hooks. Generous
 * so legitimate hook suites (lint + typecheck) finish, but bounded so a hung hook
 * cannot hold the publish path open forever — a timeout kills the commit and the
 * caller fails closed (no push). */
const COMMIT_HOOK_TIMEOUT_MS = 300_000;

type CreateCommitOptions = {
  cwd: string;
  currentBranch: string;
  commitMessage?: string;
  promptLog: BridgeLogger;
  recordTimeline: TimelineRecord;
};

export type CreateCommitResult =
  | { status: "committed"; commitSha?: string; committedAtMs: number }
  | { status: "skipped"; reason: "no_commit_message" | "nothing_to_commit"; errorSummary?: string }
  | { status: "failed"; errorSummary: string };

export function createCommit({
  cwd,
  currentBranch,
  commitMessage,
  promptLog,
  recordTimeline,
}: CreateCommitOptions): CreateCommitResult {
  if (!commitMessage) return { status: "skipped", reason: "no_commit_message" };
  const resolvedCommitMessage = withCycloidCoAuthorTrailer(commitMessage, process.env);
  const commitEnv = {
    ...buildSanitizedHookEnv(),
    GIT_COMMITTER_NAME: CYCLOID_GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: CYCLOID_GIT_COMMITTER_EMAIL,
  };

  try {
    // The commit triggers repo-installed git hooks, which run untrusted customer
    // code. Strip bridge-only secrets from their environment so a hook cannot read
    // sandbox/GitHub/provider credentials during publish. GIT_AUTHOR_* and the
    // PATH/HOME the hooks need are preserved.
    execFileSync("git", ["commit", "-m", resolvedCommitMessage], {
      encoding: "utf-8",
      cwd,
      env: commitEnv,
      timeout: COMMIT_HOOK_TIMEOUT_MS,
    });
  } catch (err) {
    const errorSummary = summarizeCommitError(err);
    if (isNothingToCommitError(err)) {
      promptLog.info({ error: errorSummary, branch: currentBranch }, "No commit created because git had no changes");
      recordTimeline("git.commit", TIMELINE_SKIPPED, "Git commit skipped because there was nothing to commit.", {
        branch: currentBranch,
      });
      return { status: "skipped", reason: "nothing_to_commit", errorSummary };
    }

    promptLog.warn({ error: errorSummary, branch: currentBranch }, "Failed to commit uncommitted changes");
    recordTimeline("git.commit", TIMELINE_FAILED, "Git commit failed; skipping push.", {
      branch: currentBranch,
      error: errorSummary,
    });
    return { status: "failed", errorSummary };
  }

  promptLog.info({ commitMsg: resolvedCommitMessage, branch: currentBranch }, "Committed uncommitted changes");
  let commitSha: string | undefined;
  try {
    commitSha = readHeadSha(cwd);
  } catch (err) {
    promptLog.warn({ error: String(err), branch: currentBranch }, "Committed changes but failed to read HEAD SHA");
  }
  const committedAtMs = Date.now();
  recordTimeline("git.commit", TIMELINE_COMPLETED, "Created a git commit for staged changes.", {
    branch: currentBranch,
    committedAtMs,
    ...(commitSha ? { commitSha } : {}),
  });
  return { status: "committed", committedAtMs, ...(commitSha ? { commitSha } : {}) };
}

function withCycloidCoAuthorTrailer(commitMessage: string, env: NodeJS.ProcessEnv): string {
  if (!shouldAppendCycloidCoAuthor(env)) return commitMessage;
  if (hasCycloidCoAuthorTrailer(commitMessage)) return commitMessage;

  return `${commitMessage.trimEnd()}\n\n${CYCLOID_CO_AUTHOR_TRAILER}`;
}

function shouldAppendCycloidCoAuthor(env: NodeJS.ProcessEnv): boolean {
  const authorName = env.GIT_AUTHOR_NAME?.trim();
  const authorEmail = env.GIT_AUTHOR_EMAIL?.trim().toLowerCase();
  if (!authorName && !authorEmail) return false;
  if (authorEmail === CYCLOID_GIT_COMMITTER_EMAIL.toLowerCase()) return false;
  if (authorName === CYCLOID_GIT_COMMITTER_NAME && !authorEmail) return false;
  return true;
}

function hasCycloidCoAuthorTrailer(commitMessage: string): boolean {
  const cycloidEmail = escapeRegExp(CYCLOID_GIT_COMMITTER_EMAIL);
  const pattern = new RegExp(`^Co-authored-by:\\s*.+<${cycloidEmail}>\\s*$`, "i");
  return commitMessage.split("\n").some((line) => pattern.test(line.trim()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeCommitError(error: unknown): string {
  const execError = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    status?: unknown;
    signal?: unknown;
  };
  const sections: string[] = [];

  const stdout = tailTruncate(stringifyExecOutput(execError.stdout).trim(), COMMIT_ERROR_OUTPUT_MAX_CHARS);
  if (stdout) sections.push(`stdout:\n${stdout}`);

  const metadata: string[] = [];
  if (typeof execError.status === "number") metadata.push(`exit code ${execError.status}`);
  if (typeof execError.signal === "string" && execError.signal) metadata.push(`signal ${execError.signal}`);
  if (metadata.length > 0) sections.push(metadata.join(", "));

  if (typeof execError.message === "string" && execError.message.trim()) {
    sections.push(tailTruncate(execError.message.trim(), COMMIT_ERROR_OUTPUT_MAX_CHARS));
  } else if (sections.length === 0) {
    sections.push(String(error));
  }

  const stderr = tailTruncate(stringifyExecOutput(execError.stderr).trim(), COMMIT_ERROR_OUTPUT_MAX_CHARS);
  if (stderr) sections.push(`stderr:\n${stderr}`);

  return tailTruncate(redact(sections.join("\n\n")), COMMIT_ERROR_SUMMARY_MAX_CHARS);
}

function stringifyExecOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Buffer.isBuffer(output)) return output.toString("utf-8");
  if (output == null) return "";
  return String(output);
}

function tailTruncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `[truncated ${omitted} chars]\n${value.slice(-maxChars)}`;
}

function isNothingToCommitError(error: unknown): boolean {
  const execError = error as { stderr?: unknown; stdout?: unknown };
  const stdout = stringifyExecOutput(execError.stdout);

  const hasNothingToCommit = stdout.split("\n").some((line) => {
    const trimmed = line.trim();
    return isNothingToCommitLine(trimmed);
  });
  if (!hasNothingToCommit) return false;

  return !hasCommitFailureStderr(stringifyExecOutput(execError.stderr));
}

function isNothingToCommitLine(line: string): boolean {
  return /^nothing to commit(?:,\s*working tree clean)?$/i.test(line) || /^no changes added to commit\b/i.test(line);
}

function hasCommitFailureStderr(stderr: string): boolean {
  const trimmed = stderr.trim();
  if (!trimmed) return false;

  return [
    /\berror:/i,
    /\bfatal:/i,
    /\babort(?:ed|ing)?\b/i,
    /\b[a-z][\w-]*\s+failed\b/i,
    /\bexit(?:ed)?(?:\s+with)?\s+(?:code|status)\s+[1-9]\d*\b/i,
    /\(code\s+[1-9]\d*\)/i,
  ].some((pattern) => pattern.test(trimmed));
}
