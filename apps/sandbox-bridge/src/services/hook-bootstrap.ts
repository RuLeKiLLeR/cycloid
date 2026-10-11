import { existsSync as nodeExistsSync } from "fs";
import { isAbsolute, join } from "path";

import type { BridgeLogger } from "../logger.js";
import { setupProtectedPathPreCommitHook } from "../utils/git-setup.js";
import { buildSanitizedHookEnv } from "../utils/sanitized-env.js";

type HookBootstrapExecAsync = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

/** Hard ceiling for any single hook-manager install command. A hook install that
 * downloads environments can be slow; if it exceeds this, we treat it as a failure
 * rather than letting it wedge the publish path indefinitely. */
export const HOOK_BOOTSTRAP_COMMAND_TIMEOUT_MS = 180_000;

/** Local git config reads complete in milliseconds; a hung git process should
 * fail the verification fast instead of consuming the install-sized budget. */
const GIT_CONFIG_READ_TIMEOUT_MS = 10_000;

/** Truncation length for stderr/message tails captured into a hook error summary. */
const HOOK_ERROR_OUTPUT_MAX_CHARS = 800;

export type HookManagerName = "pre-commit" | "husky" | "lefthook";

export interface DetectedHookManager {
  name: HookManagerName;
  /** Supported managers fail closed when bootstrap fails; recognized-but-unsupported
   * managers (Lefthook, for now) are logged and skipped, never blocking. */
  supported: boolean;
  /** Install command, or null for verify-only managers (Husky installs via the
   * package-manager `prepare` lifecycle during dependency setup). */
  install: { cmd: string; args: string[] } | null;
}

export interface HookBootstrapDeps {
  cwd: string;
  log: BridgeLogger;
  execAsync: HookBootstrapExecAsync;
  managers: DetectedHookManager[];
  recordTimeline?: (event: string, detail: string, metadata?: Record<string, unknown>) => void;
  /** Aborts in-flight install commands (e.g. on server abort) instead of waiting
   * out the full per-command timeout. */
  signal?: AbortSignal;
  /** Filesystem existence check, injectable for tests. */
  existsImpl?: (path: string) => boolean;
}

export interface HookBootstrapManagerResult {
  name: HookManagerName;
  status: "installed" | "verified" | "failed" | "skipped";
  error?: string;
}

export interface HookBootstrapResult {
  managers: HookBootstrapManagerResult[];
}

/**
 * Detect committed hook-manager configuration. Read at bridge startup, before the
 * agent can edit files, so deleting a config mid-session cannot turn a declared
 * hook system into "none declared".
 */
export function detectHookManagers(
  cwd: string,
  existsImpl: (path: string) => boolean = nodeExistsSync,
): DetectedHookManager[] {
  const detected: DetectedHookManager[] = [];

  const hasPreCommit =
    existsImpl(join(cwd, ".pre-commit-config.yaml")) || existsImpl(join(cwd, ".pre-commit-config.yml"));
  if (hasPreCommit) {
    detected.push({
      name: "pre-commit",
      supported: true,
      install: {
        cmd: "pre-commit",
        // --install-hooks eagerly installs hook environments now; repeated
        // --hook-type installs both the pre-commit and commit-msg git hooks.
        args: ["install", "--install-hooks", "--hook-type", "pre-commit", "--hook-type", "commit-msg"],
      },
    });
  }

  // Husky v9 has no package.json config block; key off the directory. Hooks are
  // installed by the package manager `prepare` lifecycle during dependency setup,
  // so this path verifies rather than re-running arbitrary install scripts.
  if (existsImpl(join(cwd, ".husky"))) {
    detected.push({ name: "husky", supported: true, install: null });
  }

  // Lefthook is recognized but not yet enforced: logged and skipped, never blocking.
  const hasLefthook =
    existsImpl(join(cwd, "lefthook.yml")) ||
    existsImpl(join(cwd, ".lefthook.yml")) ||
    existsImpl(join(cwd, "lefthook.yaml"));
  if (hasLefthook) {
    detected.push({ name: "lefthook", supported: false, install: null });
  }

  return detected;
}

/**
 * Bootstrap detected hook managers, then re-chain the Cycloid protective wrapper
 * so it runs first and the manager's installed hook runs second. Best-effort per
 * manager: a supported manager that fails to install is reported as `failed`
 * (the caller surfaces it), but bootstrap never throws — the normal `git commit`
 * path still runs whatever hooks did install and fails closed on hook errors.
 */
export async function bootstrapHookManagers(deps: HookBootstrapDeps): Promise<HookBootstrapResult> {
  const results: HookBootstrapManagerResult[] = [];
  const env = buildSanitizedHookEnv();

  for (const manager of deps.managers) {
    if (!manager.supported) {
      deps.log.info({ hookManager: manager.name }, "Recognized unsupported hook manager; skipping bootstrap");
      deps.recordTimeline?.("git.hooks.unsupported", `Recognized unsupported hook manager: ${manager.name}.`, {
        hookManager: manager.name,
      });
      results.push({ name: manager.name, status: "skipped" });
      continue;
    }

    if (!manager.install) {
      // Verify-only manager (Husky): hooks come from the dependency-setup prepare
      // lifecycle. Actually verify that lifecycle ran — when it was skipped or
      // failed, core.hooksPath is unset and commits would silently bypass the
      // customer's lint/format hooks, so reporting "verified" here would be a lie.
      const verification = await verifyHuskyHooksInstalled(deps);
      if (verification.ok) {
        results.push({ name: manager.name, status: "verified" });
        deps.recordTimeline?.("git.hooks.verified", `Verified hook manager: ${manager.name}.`, {
          hookManager: manager.name,
        });
      } else {
        deps.log.warn(
          { event: "git.hooks.verify_failed", hookManager: manager.name, error: verification.error },
          "Hook manager verification failed",
        );
        deps.recordTimeline?.("git.hooks.verify_failed", `Hook manager verification failed: ${manager.name}.`, {
          hookManager: manager.name,
          error: verification.error,
        });
        if (manager.name === "husky") {
          deps.recordTimeline?.(
            "git.hooks.husky_inert",
            "Husky detected but not installed; commit hooks will not run.",
            {
              hookManager: manager.name,
              error: verification.error,
            },
          );
        }
        results.push({ name: manager.name, status: "failed", error: verification.error });
      }
      continue;
    }

    deps.recordTimeline?.("git.hooks.bootstrap", `Bootstrapping hook manager: ${manager.name}.`, {
      hookManager: manager.name,
    });
    try {
      await deps.execAsync(manager.install.cmd, manager.install.args, {
        cwd: deps.cwd,
        timeout: HOOK_BOOTSTRAP_COMMAND_TIMEOUT_MS,
        env,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      deps.log.info({ hookManager: manager.name }, "Hook manager bootstrap completed");
      results.push({ name: manager.name, status: "installed" });
    } catch (err) {
      const error = summarizeError(err);
      deps.log.warn(
        { event: "git.hooks.bootstrap_failed", hookManager: manager.name, error },
        "Hook manager bootstrap failed",
      );
      deps.recordTimeline?.("git.hooks.bootstrap_failed", `Hook manager bootstrap failed: ${manager.name}.`, {
        hookManager: manager.name,
        error,
      });
      results.push({ name: manager.name, status: "failed", error });
    }
  }

  // Aggregate failure signal: the per-manager warns above carry the distinct
  // git.hooks.bootstrap_failed / git.hooks.verify_failed events, but a surge of
  // pre-commit-hook bootstrap failures across sessions is only detectable from a
  // queryable summary. The bridge caller does not pass recordTimeline, so emit it
  // via the bridge logger (failed == supported-but-failed; unsupported managers
  // are reported as "skipped", not counted here).
  const failedManagers = results.filter((r) => r.status === "failed");
  if (failedManagers.length > 0) {
    // `supportedCount` is the number of managers actually attempted (installed or
    // failed); skipped/unsupported managers are reported separately so an on-call
    // engineer reading `failedCount: 1, supportedCount: 1` is not misled into
    // thinking a skipped manager was run and silently dropped.
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    deps.log.warn(
      {
        event: "git.hooks.bootstrap_completed_with_failures",
        failedManagers: failedManagers.map((r) => r.name),
        failedCount: failedManagers.length,
        supportedCount: results.length - skippedCount,
        skippedCount,
      },
      "Hook manager bootstrap completed with failures",
    );
  }

  // Re-chain the Cycloid protective wrapper last. A manager install (e.g.
  // pre-commit) overwrites .git/hooks/pre-commit, so the wrapper must wrap the
  // newly installed hook. setupProtectedPathPreCommitHook is idempotent via its
  // marker and preserves+chains the existing hook.
  await setupProtectedPathPreCommitHook({ cwd: deps.cwd, log: deps.log, execAsync: deps.execAsync });

  return { managers: results };
}

/**
 * Husky installs by pointing `core.hooksPath` at `.husky` (v5-v8) or `.husky/_`
 * (v9) via the package-manager `prepare` lifecycle. Verification = that config
 * is set, points into `.husky`, and the directory exists. The agent cannot set
 * `core.hooksPath` itself (blocked by bash-parser), so a missing value means the
 * prepare lifecycle never ran or failed.
 */
async function verifyHuskyHooksInstalled(
  deps: HookBootstrapDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existsImpl = deps.existsImpl ?? nodeExistsSync;
  let hooksPath = "";
  try {
    hooksPath = (
      await deps.execAsync("git", ["config", "--get", "core.hooksPath"], {
        cwd: deps.cwd,
        timeout: GIT_CONFIG_READ_TIMEOUT_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    ).trim();
  } catch {
    // `git config --get` exits 1 when the key is unset.
    return {
      ok: false,
      error: "core.hooksPath is not set; husky hooks were never installed (prepare lifecycle skipped or failed)",
    };
  }
  if (!/(^|\/)\.husky(\/_)?\/?$/.test(hooksPath)) {
    return { ok: false, error: `core.hooksPath is "${hooksPath}", which does not point into .husky` };
  }
  const resolved = isAbsolute(hooksPath) ? hooksPath : join(deps.cwd, hooksPath);
  if (!existsImpl(resolved)) {
    return { ok: false, error: `core.hooksPath points at "${hooksPath}" but the directory does not exist` };
  }
  return { ok: true };
}

function summarizeError(err: unknown): string {
  const execErr = err as { stderr?: unknown; message?: unknown; status?: unknown };
  const parts: string[] = [];
  if (typeof execErr.status === "number") parts.push(`exit ${execErr.status}`);
  const stderr = typeof execErr.stderr === "string" ? execErr.stderr : execErr.stderr ? String(execErr.stderr) : "";
  if (stderr.trim()) parts.push(stderr.trim().slice(0, HOOK_ERROR_OUTPUT_MAX_CHARS));
  else if (typeof execErr.message === "string") parts.push(execErr.message.slice(0, HOOK_ERROR_OUTPUT_MAX_CHARS));
  else parts.push(String(err).slice(0, HOOK_ERROR_OUTPUT_MAX_CHARS));
  return parts.join(": ");
}
