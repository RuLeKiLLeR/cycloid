import { chmodSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { stringify as stringifyYaml } from "yaml";

/**
 * Authenticate the agent's `gh` without ever putting a GitHub token in the agent's
 * environment. #6891 denies SANDBOX_AUTH_TOKEN + GH_TOKEN + the gh-shim token-file
 * pointer to the untrusted agent child, which severed the agent's only gh auth (the
 * token-minting shim). The bridge (which legitimately holds SANDBOX_AUTH_TOKEN) fetches
 * a repo-scoped READ-ONLY installation token from the control plane and writes it into
 * the agent's gh config file. The agent's real gh then reads it from disk — no token in
 * its env, and read-only so an exfiltrated copy cannot push or mutate.
 */

// Git's conventional username for a GitHub App installation token. gh uses the
// oauth_token for API auth; the login is the config key / display name only.
const GH_INSTALLATION_TOKEN_LOGIN = "x-access-token";

// Installation/scoped/user tokens are `gh?_` + url-safe base62 (plus `_`/`-`). Reject
// anything else (whitespace, YAML metacharacters) so a malformed token can neither
// corrupt hosts.yml nor be written as bogus auth.
const GH_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function agentGhConfigDir(homeDir: string = process.env.HOME || homedir()): string {
  return join(homeDir, ".config", "gh");
}

/**
 * Serialize a gh hosts.yml that authenticates github.com with `token`, matching gh's
 * own `--insecure-storage` output: the oauth_token appears BOTH under the users map and
 * at the top level. A users-map-only config is treated by gh 2.x as pre-migration and it
 * tries to move the token into the OS keyring (dbus/secret-service) — absent in the
 * headless sandbox, so the migration aborts and gh reports itself unauthenticated.
 */
export function buildAgentGhHostsYaml(token: string, login: string = GH_INSTALLATION_TOKEN_LOGIN): string {
  return stringifyYaml({
    "github.com": {
      users: { [login]: { oauth_token: token } },
      git_protocol: "https",
      oauth_token: token,
      user: login,
    },
  });
}

/**
 * Serialize gh's config.yml with the current schema `version` so gh treats its
 * migrations as already applied and does NOT run the multi-account/secure-storage
 * migration on load (that migration needs a keyring the sandbox does not have).
 */
export function buildAgentGhConfigYaml(): string {
  return stringifyYaml({ version: "1", git_protocol: "https" });
}

export function buildAgentGitConfig(
  realGhPath: string = process.env.ARCANIST_REAL_GH_PATH || "/usr/local/lib/cycloid/real-bin/gh",
): string {
  if (!realGhPath.startsWith("/")) throw new Error("GitHub credential helper path must be absolute");
  return `[credential "https://github.com"]\n\thelper =\n\thelper = !${realGhPath} auth git-credential\n`;
}

export interface WriteAgentGhAuthResult {
  written: boolean;
  path?: string;
  reason?: "empty_token" | "malformed_token" | "write_failed";
}

/**
 * Write the agent's gh hosts.yml (0600, in a 0700 config dir) so its real gh
 * authenticates from disk with no token in its env. Fails closed on an empty or
 * malformed token rather than writing an unauthenticated/corrupt config.
 */
export function writeAgentGhAuthConfig(opts: {
  token: string;
  homeDir?: string;
  realGhPath?: string;
}): WriteAgentGhAuthResult {
  const token = (opts.token ?? "").trim();
  if (!token) return { written: false, reason: "empty_token" };
  if (!GH_TOKEN_PATTERN.test(token)) return { written: false, reason: "malformed_token" };

  const dir = agentGhConfigDir(opts.homeDir);
  const hostsPath = join(dir, "hosts.yml");
  const configPath = join(dir, "config.yml");
  const gitConfigPath = join(opts.homeDir || process.env.HOME || homedir(), ".gitconfig");
  const gitConfigTempPath = `${gitConfigPath}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(hostsPath, buildAgentGhHostsYaml(token), { encoding: "utf-8", mode: 0o600 });
    chmodSync(hostsPath, 0o600);
    // Pin the config schema version so gh skips its keyring migration on load.
    writeFileSync(configPath, buildAgentGhConfigYaml(), { encoding: "utf-8", mode: 0o600 });
    chmodSync(configPath, 0o600);
    writeFileSync(gitConfigTempPath, buildAgentGitConfig(opts.realGhPath), { encoding: "utf-8", mode: 0o600 });
    chmodSync(gitConfigTempPath, 0o600);
    renameSync(gitConfigTempPath, gitConfigPath);
  } catch {
    return { written: false, reason: "write_failed" };
  }
  return { written: true, path: hostsPath };
}

export interface RefreshAgentGhAuthResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/**
 * Fetch the repo-scoped read-only installation token from the control-plane
 * github-token route (authenticated with the sandbox auth token, which stays in the
 * bridge) and write it into the agent's gh config. Fails soft: any fetch/HTTP/parse
 * problem returns { ok: false } and never throws, so a transient control-plane blip
 * cannot crash the bridge or a prompt turn.
 */
export async function refreshAgentGhAuth(opts: {
  tokenUrl: string;
  authToken: string;
  homeDir?: string;
  realGhPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RefreshAgentGhAuthResult> {
  if (!opts.tokenUrl || !opts.authToken) return { ok: false, reason: "missing_config" };
  const fetchFn = opts.fetchImpl ?? fetch;

  let token: string;
  try {
    const res = await fetchFn(opts.tokenUrl, {
      headers: { Authorization: `Bearer ${opts.authToken}` },
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const payload = (await res.json()) as { ok?: boolean; token?: unknown };
    if (payload.ok !== true || typeof payload.token !== "string" || payload.token.trim().length === 0) {
      return { ok: false, reason: "no_token" };
    }
    token = payload.token;
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }

  const written = writeAgentGhAuthConfig({ token, homeDir: opts.homeDir, realGhPath: opts.realGhPath });
  return written.written ? { ok: true, path: written.path } : { ok: false, reason: written.reason };
}

/** Build the control-plane github-token URL for a session; empty if inputs are missing. */
export function buildGithubTokenUrl(controlPlaneUrl: string, sessionId: string): string {
  const cp = (controlPlaneUrl ?? "").trim();
  const sid = (sessionId ?? "").trim();
  if (!cp || !sid) return "";
  const base = (/^https?:\/\//.test(cp) ? cp : `https://${cp}`).replace(/\/+$/, "");
  return `${base}/api/sessions/${encodeURIComponent(sid)}/github-token`;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_DELAY_MS = 15_000;

// Retry only failures that self-heal: at bridge boot the sandbox is still spawning, so
// the /github-token route 403s ("Sandbox not active") until the bridge signals ready a
// few seconds later; transient network/5xx also clear. A missing_config / 400 / no_token
// / malformed / write_failed will not improve by retrying, so stop immediately.
function isRetryableRefreshReason(reason?: string): boolean {
  if (!reason) return false;
  if (reason === "fetch_failed" || reason === "http_403") return true;
  return /^http_5\d\d$/.test(reason);
}

/**
 * Boot entrypoint (invoked from index.ts main() on normal bridge boot). Reads the sandbox
 * env, fetches the repo-scoped read-only token, and writes the agent's gh config. Retries
 * the self-healing failures (notably the boot-time 403 before the sandbox is "ready") with
 * exponential backoff. Fail-soft — returns a result, never throws.
 */
export async function runWriteAgentGhAuth(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  log?: (fields: Record<string, unknown>, msg: string) => void;
}): Promise<RefreshAgentGhAuthResult> {
  const env = opts?.env ?? process.env;
  const tokenUrl = buildGithubTokenUrl(env.CONTROL_PLANE_URL ?? "", env.SESSION_ID ?? "");
  const authToken = env.SANDBOX_AUTH_TOKEN ?? "";
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let result: RefreshAgentGhAuthResult = { ok: false, reason: "missing_config" };
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1;
    result = await refreshAgentGhAuth({
      tokenUrl,
      authToken,
      homeDir: env.HOME,
      fetchImpl: opts?.fetchImpl,
      signal: opts?.signal,
    });
    if (result.ok || !isRetryableRefreshReason(result.reason) || attempt === maxAttempts - 1) break;
    await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_DELAY_MS));
  }
  opts?.log?.(
    {
      event: result.ok ? "agent_gh_auth.written" : "agent_gh_auth.skipped",
      reason: result.reason,
      path: result.path,
      attempts,
    },
    result.ok ? "Wrote agent gh auth config" : "Agent gh auth not written",
  );
  return result;
}
