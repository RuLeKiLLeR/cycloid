import { execFile as execFileCb, execFileSync, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";

import { buildSanitizedHookEnv } from "../../utils/sanitized-env.js";

const SANDBOX_REAL_GIT_PATH = "/usr/local/lib/cycloid/real-bin/git";

type GitExecError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
};

function formatGitErrorDetails(gitErr: GitExecError): string {
  const details: string[] = [];
  if (gitErr.signal !== undefined && gitErr.signal !== null) details.push(`signal=${gitErr.signal}`);
  if (gitErr.killed === true) details.push(`killed=true`);
  if (gitErr.code !== undefined && gitErr.code !== null) details.push(`code=${String(gitErr.code)}`);
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function gitBinary(): string {
  const configured = process.env.ARCANIST_REAL_GIT_PATH;
  if (configured) return configured;
  return existsSync(SANDBOX_REAL_GIT_PATH) ? SANDBOX_REAL_GIT_PATH : "git";
}

function augmentGitError(err: Error, args: string[], timeoutMs: number | undefined): Error {
  const gitErr = err as GitExecError;
  const aborted = gitErr.name === "AbortError" || gitErr.code === "ABORT_ERR";
  if (aborted) return err;

  const subcommand = args[0] ? `git ${args[0]}` : "git";
  const details = formatGitErrorDetails(gitErr);
  const timedOut = gitErr.code === "ETIMEDOUT" || (timeoutMs !== undefined && gitErr.killed === true);
  if (timedOut) {
    const timeoutText = timeoutMs === undefined ? "" : ` after ${timeoutMs}ms`;
    gitErr.message = `${subcommand} timed out or was killed${timeoutText}${details}`;
    return gitErr;
  }

  const externallyKilled = gitErr.killed === true || Boolean(gitErr.signal);
  if (!externallyKilled) return err;
  gitErr.message = `${subcommand} was killed externally${details}`;
  return gitErr;
}

/**
 * Single choke point for running `git` against the customer repo. Repo-cwd
 * git executes repo/agent-writable config — credential.helper,
 * core.sshCommand, core.fsmonitor, clean/smudge filters — so every invocation
 * gets the sanitized env, never the raw bridge env. A guard test
 * (`tests/test_sandbox-bridge/git-exec-env-guard.test.ts`) fails on raw git
 * spawns elsewhere in the bridge.
 */

export type RepoGitSyncOptions = {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
  stdio?: StdioOptions;
  input?: string;
  /** Extra entries layered over the sanitized base (e.g. GIT_COMMITTER_*).
   * The merged result is re-sanitized, so an overlay cannot reintroduce a
   * denylisted or secret-suffixed key. */
  env?: NodeJS.ProcessEnv;
};

export function execRepoGitSync(args: string[], options: RepoGitSyncOptions): string {
  const { env, ...rest } = options;
  try {
    return execFileSync(gitBinary(), args, {
      encoding: "utf-8",
      ...rest,
      env: buildSanitizedHookEnv({ ...process.env, ...env }),
    }) as string;
  } catch (err) {
    throw augmentGitError(err as Error, args, options.timeout);
  }
}

export type RepoGitAsyncOptions = RepoGitSyncOptions & { signal?: AbortSignal };

export function execRepoGit(args: string[], options: RepoGitAsyncOptions): Promise<string> {
  const { env, input, ...rest } = options;
  return new Promise<string>((resolve, reject) => {
    const child = execFileCb(
      gitBinary(),
      args,
      { encoding: "utf-8", ...rest, env: buildSanitizedHookEnv({ ...process.env, ...env }) },
      (err, stdout, _stderr) => {
        if (err) reject(augmentGitError(err, args, options.timeout));
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}
