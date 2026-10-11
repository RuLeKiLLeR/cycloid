import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

import { CYCLOID_GIT_COMMITTER_EMAIL, CYCLOID_GIT_COMMITTER_NAME } from "../../../../shared/constants/git-identity.js";
import type { BridgeLogger } from "../logger.js";
import { buildProtectedPathPreCommitHook, CYCLOID_PROTECTED_PRE_COMMIT_MARKER } from "./git-protected-hook.js";
import { buildSanitizedHookEnv } from "./sanitized-env.js";

type GitSetupExecAsync = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

export interface GitSetupDeps {
  cwd: string;
  log: BridgeLogger;
  execAsync: GitSetupExecAsync;
}

/** Keep Cycloid scaffolding out of the customer's diff (fail-soft). */
export async function setupGitExclude(deps: GitSetupDeps): Promise<void> {
  try {
    const excludePath = join(deps.cwd, ".git", "info", "exclude");
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    const entries = [".cycloid-context.md", ".codex/", "AGENTS.override.md"];
    const missing = entries.filter((e) => !existing.includes(e));
    if (missing.length) {
      writeFileSync(excludePath, existing.trimEnd() + "\n" + missing.join("\n") + "\n", "utf-8");
    }
  } catch (err) {
    deps.log.warn({ error: String(err) }, "Failed to update .git/info/exclude");
  }
}

/** Fail closed if a manual git commit would include sandbox-protected paths. */
export async function setupProtectedPathPreCommitHook(deps: GitSetupDeps): Promise<void> {
  try {
    const hookPath = await resolveProtectedPreCommitHookPath(deps);
    if (!hookPath) return;
    mkdirSync(dirname(hookPath), { recursive: true });

    const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : "";
    if (existing.includes(CYCLOID_PROTECTED_PRE_COMMIT_MARKER)) return;

    let originalHookPath: string | undefined;
    if (existing.trim().length > 0) {
      originalHookPath = `${hookPath}.cycloid-original`;
      renameSync(hookPath, originalHookPath);
      chmodSync(originalHookPath, 0o755);
    }

    writeFileSync(hookPath, buildProtectedPathPreCommitHook(originalHookPath), "utf-8");
    chmodSync(hookPath, 0o755);
  } catch (err) {
    deps.log.warn({ error: String(err) }, "Failed to install protected-path pre-commit hook");
  }
}

async function resolveProtectedPreCommitHookPath(deps: GitSetupDeps): Promise<string | null> {
  const repoRoot = await resolveRepoRoot(deps);
  const configuredHooksPath = await readCoreHooksPath(deps);
  if (configuredHooksPath) {
    const safeHookDir = resolveContainedHookDir(repoRoot, configuredHooksPath);
    if (safeHookDir) return join(safeHookDir, "pre-commit");
    deps.log.error(
      { hooksPath: configuredHooksPath },
      "Cannot install protected-path hook because core.hooksPath points outside the repository",
    );
    return null;
  }

  const hookPathRaw = (
    await deps.execAsync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: deps.cwd,
      env: buildSanitizedHookEnv(),
    })
  ).trim();
  if (!hookPathRaw) return null;
  return isAbsolute(hookPathRaw) ? hookPathRaw : join(deps.cwd, hookPathRaw);
}

async function resolveRepoRoot(deps: GitSetupDeps): Promise<string> {
  try {
    const repoRoot = (
      await deps.execAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: deps.cwd,
        env: buildSanitizedHookEnv(),
      })
    ).trim();
    return repoRoot || deps.cwd;
  } catch {
    return deps.cwd;
  }
}

async function readCoreHooksPath(deps: GitSetupDeps): Promise<string | null> {
  try {
    const hooksPath = (
      await deps.execAsync("git", ["config", "--get", "core.hooksPath"], {
        cwd: deps.cwd,
        env: buildSanitizedHookEnv(),
      })
    ).trim();
    return hooksPath || null;
  } catch {
    return null;
  }
}

function resolveContainedHookDir(repoRoot: string, hooksPath: string): string | null {
  const realRepoRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : resolve(repoRoot);
  const hookDir = isAbsolute(hooksPath) ? resolve(hooksPath) : resolve(repoRoot, hooksPath);
  const containmentTarget = resolveWithExistingAncestor(hookDir);
  const relativePath = relative(realRepoRoot, containmentTarget);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  return containmentTarget;
}

function resolveWithExistingAncestor(targetPath: string): string {
  if (existsSync(targetPath)) return realpathSync(targetPath);

  const missingSegments: string[] = [];
  let cursor = targetPath;
  while (!existsSync(cursor)) {
    missingSegments.unshift(cursor.slice(dirname(cursor).length + 1));
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(targetPath);
    cursor = parent;
  }

  return resolve(realpathSync(cursor), ...missingSegments);
}

/**
 * Set git committer to Cycloid. GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL env vars
 * (set by DO) override the author per-commit, so commits show
 * "User authored and Cycloid committed."
 */
export async function setupGitConfig(deps: GitSetupDeps): Promise<void> {
  try {
    await deps.execAsync("git", ["config", "user.name", CYCLOID_GIT_COMMITTER_NAME], {
      cwd: deps.cwd,
      env: buildSanitizedHookEnv(),
    });
    await deps.execAsync("git", ["config", "user.email", CYCLOID_GIT_COMMITTER_EMAIL], {
      cwd: deps.cwd,
      env: buildSanitizedHookEnv(),
    });
    const authorName = process.env.GIT_AUTHOR_NAME;
    if (authorName) {
      deps.log.info({ author: authorName, committer: CYCLOID_GIT_COMMITTER_NAME }, "Git identity configured");
    }
  } catch (err) {
    deps.log.warn({ error: String(err) }, "Failed to set git identity");
  }
}
