import { basename, delimiter } from "path";

import {
  AGENT_CHILD_ALLOWED_OPERATIONAL_SECRETS,
  AGENT_CHILD_ALLOWED_PROVIDER_ENV_KEYS,
  AGENT_CHILD_ENV_EXACT_ALLOWLIST,
  ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV,
  CYCLOID_PREFIX_EXCLUDED_NAMES,
  isAgentVisibleRepoRuntimeEnvName,
  PLATFORM_SECRET_ENV_KEYS,
  SECRET_ENV_KEY_SUFFIX_PATTERN,
  TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES,
} from "../../../../shared/constants/agent-child-env.js";

const LEGACY_GH_SHIM_DIR_PREFIX = "cycloid-gh-shim-";

function stripLegacyGithubTokenShimPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => !basename(entry).startsWith(LEGACY_GH_SHIM_DIR_PREFIX))
    .join(delimiter);
}

/** Clone an environment with bridge-only secrets stripped, for running untrusted
 * hook code (bootstrap installs and the commit-time hook execution) and repo-cwd
 * git commands, whose repo-writable config (credential.helper, core.sshCommand,
 * filters) executes untrusted code. A denylist (rather than an allowlist) keeps
 * the toolchain env hooks legitimately need — `PATH`, `HOME`, language-runtime
 * vars — intact while closing the documented leak path. */
export function buildSanitizedHookEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (PLATFORM_SECRET_ENV_KEYS.has(key) || SECRET_ENV_KEY_SUFFIX_PATTERN.test(key)) continue;
    sanitized[key] = value;
  }
  if (sanitized.PATH) sanitized.PATH = stripLegacyGithubTokenShimPath(sanitized.PATH);
  return sanitized;
}

export type AgentChildEnvOptions = {
  /** Model provider key(s) the child needs, injected explicitly by name. */
  providerKeys?: Record<string, string | undefined>;
  /**
   * Env names referenced by the session's MCP config. Only names on the
   * trusted integration-credential allowlist are actually preserved; the
   * rest are reported in `deniedPreserveNames` so the caller can log them.
   */
  preserveNames?: Iterable<string>;
  /** Additional env names trusted by the control plane for this session only. */
  trustedPreserveNames?: Iterable<string>;
};

export type AgentChildEnvResult = {
  env: Record<string, string>;
  /** Platform-denylist names that were present in the source and withheld.
   * Safe to log by name (static platform names, never customer-chosen). */
  withheldPlatformNames: string[];
  /** Count of other source vars not copied (customer-chosen names are not
   * logged on every spawn — counts only). */
  withheldOtherCount: number;
  /** preserveNames entries rejected by the trusted allowlist or denylist. */
  deniedPreserveNames: string[];
};

function parseRepoRuntimeEnvNames(source: NodeJS.ProcessEnv | Record<string, string>): string[] {
  const raw = source[ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Build the env for an untrusted agent child process (fail-closed allowlist).
 *
 * Order matters: exact allowlist + `ARCANIST_*` prefix rule, then provider-key
 * and preserve overlays, then an unconditional final denylist pass so no
 * overlay (present or future) can resurface a platform secret.
 */
export function buildAgentChildEnv(
  source: NodeJS.ProcessEnv | Record<string, string>,
  opts: AgentChildEnvOptions = {},
): AgentChildEnvResult {
  const env: Record<string, string> = {};

  for (const name of AGENT_CHILD_ENV_EXACT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = String(value);
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!key.startsWith("ARCANIST_")) continue;
    if (CYCLOID_PREFIX_EXCLUDED_NAMES.has(key)) continue;
    if (SECRET_ENV_KEY_SUFFIX_PATTERN.test(key)) continue;
    env[key] = String(value);
  }

  const allowedSecrets = new Set(AGENT_CHILD_ALLOWED_OPERATIONAL_SECRETS);
  for (const [key, value] of Object.entries(opts.providerKeys ?? {})) {
    if (value === undefined) continue;
    if (!AGENT_CHILD_ALLOWED_PROVIDER_ENV_KEYS.has(key)) continue;
    env[key] = value;
    allowedSecrets.add(key);
  }

  for (const name of parseRepoRuntimeEnvNames(source)) {
    if (!isAgentVisibleRepoRuntimeEnvName(name)) continue;
    const value = source[name];
    if (value === undefined) continue;
    env[name] = String(value);
    allowedSecrets.add(name);
  }

  const deniedPreserveNames: string[] = [];
  const sessionTrustedPreserveNames = new Set(opts.trustedPreserveNames ?? []);
  for (const name of Array.from(opts.preserveNames ?? [])) {
    if (PLATFORM_SECRET_ENV_KEYS.has(name)) {
      deniedPreserveNames.push(name);
      continue;
    }
    if (!TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES.has(name) && !sessionTrustedPreserveNames.has(name)) {
      deniedPreserveNames.push(name);
      continue;
    }
    const value = source[name];
    if (value === undefined) continue;
    env[name] = String(value);
    allowedSecrets.add(name);
  }

  // Unconditional final denylist: structurally the last word, so a banned key
  // cannot survive any of the overlays above.
  for (const key of Object.keys(env)) {
    if (allowedSecrets.has(key)) continue;
    if (PLATFORM_SECRET_ENV_KEYS.has(key) || SECRET_ENV_KEY_SUFFIX_PATTERN.test(key)) delete env[key];
  }
  let withheldOtherCount = 0;
  const withheldPlatformNames: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || env[key] !== undefined) continue;
    if (PLATFORM_SECRET_ENV_KEYS.has(key)) withheldPlatformNames.push(key);
    else withheldOtherCount += 1;
  }
  if (env.PATH) env.PATH = stripLegacyGithubTokenShimPath(env.PATH);

  return { env, withheldPlatformNames, withheldOtherCount, deniedPreserveNames };
}

/**
 * Env for trusted-but-repo-influenced commands (repo test/diagnostic runs,
 * `cycloid-app`): the agent-child allowlist with no provider key, preserve
 * overlays, or session-scoped operational token. Callers that need the preview
 * contract overlay it explicitly AFTER this (trusted first-party runtime path
 * only).
 */
export function buildRepoCommandEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildAgentChildEnv(source).env;
  if (env.PATH) env.PATH = stripLegacyGithubTokenShimPath(env.PATH);
  return env;
}
