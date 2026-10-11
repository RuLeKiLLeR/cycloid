import { createAppAuth } from "@octokit/auth-app";
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";

import { createLogger } from "../logger";
import { createSingleFlight } from "../single-flight";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "github-octokit" } });

/**
 * Convert a PKCS#1 RSA private key (BEGIN RSA PRIVATE KEY) to PKCS#8 format
 * (BEGIN PRIVATE KEY). If the key is already PKCS#8 or another format, returns as-is.
 *
 * PKCS#8 wraps the PKCS#1 key bytes in a SEQUENCE { AlgorithmIdentifier, OCTET STRING }.
 * The RSA AlgorithmIdentifier is a fixed 26-byte ASN.1 prefix.
 */
export function ensurePkcs8(pem: string): string {
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) return pem;

  const b64 = pem
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const pkcs1Bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // ASN.1 AlgorithmIdentifier for RSA: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
  const algorithmId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  // Wrap PKCS#1 bytes in OCTET STRING
  const octetString = wrapAsn1(0x04, pkcs1Bytes);
  // Integer version = 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // Outer SEQUENCE { version, algorithmId, octetString }
  const pkcs8 = wrapAsn1(0x30, concat(version, algorithmId, octetString));

  const pkcs8B64 = btoa(String.fromCharCode(...pkcs8));
  const lines = pkcs8B64.match(/.{1,64}/g) ?? [];
  return ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----"].join("\n");
}

function wrapAsn1(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeAsn1Length(content.length);
  const result = new Uint8Array(1 + len.length + content.length);
  result[0] = tag;
  result.set(len, 1);
  result.set(content, 1 + len.length);
  return result;
}

function encodeAsn1Length(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function createInstallationOctokit(env: Env, installationId: number): Octokit {
  const rawKey = (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const privateKey = ensurePkcs8(rawKey);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey,
      installationId,
    },
  });
}

function createAppOctokit(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY">): Octokit {
  const rawKey = (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const privateKey = ensurePkcs8(rawKey);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey,
    },
  });
}

export interface GithubAppInstallationCapabilities {
  installationId: number;
  ownerLogin: string;
  ownerId: number;
  ownerType: string;
  repositorySelection: string | null;
  permissions: Record<string, string>;
  events: string[];
}

export async function getAppSlug(env: Env): Promise<string> {
  const cacheKey = "github-app-slug";
  const cached = await env.REPOS_CACHE.get(cacheKey);
  if (cached) return cached;

  const octokit = createAppOctokit(env);
  const response = await octokit.apps.getAuthenticated();
  const appData = response.data as { slug?: string | null; id: number };
  const slug = appData.slug ?? String(appData.id);

  await env.REPOS_CACHE.put(cacheKey, slug, { expirationTtl: 86400 });
  return slug;
}

export async function getAppInstallationCapabilities(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY">,
  installationId: number,
): Promise<GithubAppInstallationCapabilities> {
  const octokit = createAppOctokit(env);
  const { data } = await octokit.apps.getInstallation({ installation_id: installationId });
  const account = data.account;
  const ownerLogin = account && "login" in account && typeof account.login === "string" ? account.login : "";
  const ownerId = account && "id" in account && typeof account.id === "number" ? account.id : 0;
  const ownerType = data.target_type;
  const permissions: Record<string, string> = {};
  for (const [name, value] of Object.entries(data.permissions ?? {})) {
    if (typeof value === "string") permissions[name] = value;
  }
  return {
    installationId: data.id,
    ownerLogin,
    ownerId,
    ownerType,
    repositorySelection: data.repository_selection ?? null,
    permissions,
    events: Array.isArray(data.events) ? data.events.filter((event): event is string => typeof event === "string") : [],
  };
}

export interface GithubAppInstallationDetails {
  installationId: number;
  ownerLogin: string;
  ownerId: number;
  ownerType: string;
  repositorySelection: string | null;
  permissions: Record<string, string> | null;
  events: string[] | null;
}

export async function getAppInstallationDetails(
  env: Env,
  installationId: number,
): Promise<GithubAppInstallationDetails> {
  const octokit = createAppOctokit(env);
  const { data } = await octokit.apps.getInstallation({ installation_id: installationId });
  const account = data.account;

  if (!account || !("login" in account) || !("id" in account)) {
    throw new Error(`GitHub installation ${installationId} is missing account details`);
  }

  return {
    installationId: data.id,
    ownerLogin: account.login,
    ownerId: account.id,
    ownerType: data.target_type,
    repositorySelection: data.repository_selection ?? null,
    permissions: data.permissions ? Object.fromEntries(Object.entries(data.permissions)) : null,
    events: Array.isArray(data.events) ? data.events : null,
  };
}

// GitHub installation access tokens are valid for 60 minutes. Cache the minted
// token just under that with a 10-minute safety buffer so 27 callers stop
// re-minting (and burning the app's token-mint rate limit) on every request.
const INSTALLATION_TOKEN_TTL_SECONDS = 50 * 60;

function installationTokenCacheKey(installationId: number): string {
  return `github-installation-token:${installationId}`;
}

type CreateInstallationTokenParams = RestEndpointMethodTypes["apps"]["createInstallationAccessToken"]["parameters"];

export interface InstallationTokenScope {
  /** Repo names (not `owner/repo`) within the installation account. */
  repositories: string[];
  /** Permission map; must not exceed the App installation's granted permissions. */
  permissions: Record<string, string>;
}

// Permissions the sandbox clone/fetch token needs and nothing more: clone/fetch
// and ordinary pushes are `contents:write`; PR inspection is `pull_requests:read`;
// CI inspection uses check runs (`checks:read`), classic commit statuses
// (`statuses:read`; `gh pr checks` reads both through statusCheckRollup), and
// Actions workflow run logs (`actions:read`, what `gh run view --log`/
// `--log-failed` reads). The in-sandbox `gh` shim uses the read-only variant below.
// `metadata:read` is always implied by GitHub. Every scope here is read-only except
// `contents:write` (clone credential reused for ordinary push); PR/issue/check
// *mutation* stays server-side
// (github/pr.ts), so this deliberately omits `pull_requests:write`, `issues:write`,
// `checks:write`, and `actions:write` -- a sandbox foothold can read CI to
// self-diagnose but cannot open/edit/comment on PRs or rerun/cancel workflows as the
// installation. `workflows:write` is deliberately NOT here: it lives only on the push
// scope below, so the long-lived clone surface never carries it. An installation
// token can only request scopes the App is already granted; GitHub rejects an
// over-broad mint rather than dropping the extra scopes. mintWithCiReadFallback()
// degrades gracefully to SANDBOX_REQUIRED_TOKEN_PERMISSIONS when CI reads are not yet
// granted. Widen here only when a real sandbox flow fails.
export const SANDBOX_INSTALLATION_TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "write",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
};

// The subset the App has granted since day one; the sandbox clone/push/PR-read surface
// cannot function without it. CI read scopes (checks/statuses/actions) are layered on
// top and are the only ones allowed to degrade (see mintWithCiReadFallback). If a
// mint fails for one of THESE, the installation is genuinely broken and the error
// must propagate.
export const SANDBOX_REQUIRED_TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "write",
  pull_requests: "read",
};

// Push-only permission set: the minimal scope plus `workflows:write`, which GitHub
// requires to push changes under `.github/workflows/**` (it rejects such a push from a
// `contents:write`-only token). Requested ONLY on the push path (the /session/clone-token
// DO route), never on clone or the `gh` shim, so the widened scope is confined to the
// brief publish moment. `workflows:write` does widen blast radius (a push-time foothold
// could publish a malicious Actions workflow to a branch); that is the accepted cost of
// supporting CI-file edits. An installation that has not approved `workflows:write` makes
// this an over-broad request (GitHub rejects the mint, never silently downgrading), so the
// DO route falls back to SANDBOX_INSTALLATION_TOKEN_PERMISSIONS -- keeping non-workflow
// pushes working and letting a workflow-file push surface GitHub's own graceful rejection.
export const SANDBOX_PUSH_TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
  ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS,
  workflows: "write",
};

// Read-only variant for the agent's `gh` (the /session/github-token route). Unlike the
// clone/push token, this one is delivered into a file the untrusted agent can read
// (its gh config), so it must carry NO write scope: `contents:read` not `contents:write`.
// The agent's gh only reads (PRs/pushes happen via the separate write-scoped clone-token
// on the bridge, and the gh wrapper blocks mutating subcommands); dropping write here
// means a prompt-injection foothold that exfiltrates this token still cannot push or
// mutate. CI reads stay so `gh pr checks` / `gh run view` keep working; they degrade via
// mintWithCiReadFallback to contents+pr read (never write) when ungranted.
export const SANDBOX_GH_READONLY_TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
};

/**
 * Scope a sandbox installation token to the single target repo with the minimal
 * sandbox clone permission set. Centralized so clone/push fallback (and the
 * guardrail test) cannot drift to installation-wide.
 */
export function sandboxInstallationTokenScope(repoName: string): InstallationTokenScope {
  return { repositories: [repoName], permissions: { ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS } };
}

/**
 * Read-only variant of sandboxInstallationTokenScope for the agent's `gh`
 * (/session/github-token). Same single-repo scoping, but no write scope at all, because
 * the minted token is delivered into an agent-readable file (its gh config). Use only on
 * the github-token DO route; clone/push keep sandboxInstallationTokenScope/sandboxPushTokenScope.
 */
export function sandboxGhReadonlyTokenScope(repoName: string): InstallationTokenScope {
  return { repositories: [repoName], permissions: { ...SANDBOX_GH_READONLY_TOKEN_PERMISSIONS } };
}

/**
 * Push-path variant of sandboxInstallationTokenScope: same single-repo scoping, plus
 * `workflows:write`. Use only on the /session/clone-token DO route (the pre-push token),
 * with a fallback to sandboxInstallationTokenScope when the installation has not granted
 * `workflows:write`.
 */
export function sandboxPushTokenScope(repoName: string): InstallationTokenScope {
  return { repositories: [repoName], permissions: { ...SANDBOX_PUSH_TOKEN_PERMISSIONS } };
}

// Cache key for a scoped token. Keyed by installation + repos + permissions so a
// repo-A token is never cross-served to a repo-B request, and a narrowly-scoped
// token is never served where a different scope was requested. Distinct from the
// unscoped installationTokenCacheKey (the `:repos=...:perms=...` suffix), so the
// installation-wide cache entry can never satisfy a scoped request.
function scopedInstallationTokenCacheKey(installationId: number, scope: InstallationTokenScope): string {
  const repos = [...scope.repositories].sort().join(",");
  const perms = Object.entries(scope.permissions)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join(",");
  return `${installationTokenCacheKey(installationId)}:repos=${repos}:perms=${perms}`;
}

// Per-installation generation counter, bumped by invalidateInstallationTokenCache.
// A mint captures the generation before it starts and re-checks it before the KV
// write: if an invalidation landed while the mint was in flight, the write is
// skipped so a token minted around a grant change does not repopulate KV (undoing
// the delete) for the full 50-minute TTL. Per-isolate, like the single-flight and
// the KV-delete-then-mint-write race it guards; a cross-isolate write-after-delete
// stays bounded by GitHub's server-side grant enforcement (see ARC-1240) and is
// deliberately not closed with a distributed lock.
const installationTokenGenerations = new Map<number, number>();

function installationTokenGeneration(installationId: number): number {
  return installationTokenGenerations.get(installationId) ?? 0;
}

/**
 * Drop the cached installation token(s) so the next mint hits GitHub. Call when an
 * installation's grant changes underneath us (uninstall, suspend, permission
 * change, repo added/removed) and a still-cached token would be stale or
 * over-scoped. Deletes both the unscoped entry and every repo-scoped entry for the
 * installation: a repository-removal event must not leave a scoped token for the
 * removed repo usable until its TTL. Scoped keys cannot be reconstructed without
 * knowing the repo/permission combinations that were cached, so enumerate them by
 * KV prefix rather than guessing.
 */
export async function invalidateInstallationTokenCache(
  env: Pick<Env, "REPOS_CACHE">,
  installationId: number,
): Promise<void> {
  // Bump before the delete so an in-flight mint skips its KV write (see installationTokenGenerations).
  installationTokenGenerations.set(installationId, installationTokenGeneration(installationId) + 1);
  const unscopedKey = installationTokenCacheKey(installationId);
  // Trailing colon so `:1:` never matches installation `:10:`'s scoped keys.
  const scopedPrefix = `${unscopedKey}:`;
  // Cache cleanup is best-effort: a KV outage here must not throw out of a webhook
  // grant-change handler. A still-cached token stays bounded by GitHub's
  // server-side grant enforcement and the 50-minute TTL.
  try {
    const scopedDeletes: Promise<void>[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.REPOS_CACHE.list({ prefix: scopedPrefix, cursor });
      for (const entry of page.keys) scopedDeletes.push(env.REPOS_CACHE.delete(entry.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await Promise.all([env.REPOS_CACHE.delete(unscopedKey), ...scopedDeletes]);
  } catch (error) {
    log.warn(
      { action: "installation_token_cache", op: "invalidate", installationId, kvError: String(error) },
      "installation_token_cache_invalidate_failed",
    );
  }
}

// In-isolate single-flight so a cold-start burst (or a burst right after
// invalidateInstallationTokenCache) collapses to one KV read + at most one mint
// + one KV write per installation id, instead of every concurrent caller racing
// to mint and burning the app's token-mint rate limit. Dedup is per-isolate only
// (callers on different isolates do not share a flight); the worst bursts are
// concentrated on a single DO / small isolate set, so this captures the bulk of
// the win without a distributed lock. The shared promise is a live mint, not a
// cached value, and clears on settle, so invalidation semantics are unchanged.
// Keyed by cache key (string), not installation id, so a scoped mint for repo A
// does not collapse into the single-flight slot of an unscoped or repo-B mint.
// The unscoped key still contains the installation id, so per-installation dedup
// (the cold-start burst case) is preserved.
let installationTokenSingleFlight = createSingleFlight<string, string>();

// Shared cache+single-flight+invalidation core for both the unscoped and the
// repo-scoped token paths. The generation guard is keyed by installation id, so an
// invalidateInstallationTokenCache bump still skips an in-flight scoped mint's KV
// write; an already-cached scoped token stays bounded by GitHub's server-side grant
// enforcement and the TTL, the same tradeoff documented for the unscoped path.
interface InstallationTokenMintResult {
  token: string;
  cacheKey?: string | null;
}

interface PermissionFallbackMintResult {
  token: string;
  permissions: Record<string, string>;
}

async function mintAndCacheInstallationToken(
  env: Env,
  installationId: number,
  cacheKey: string,
  mint: () => Promise<string | InstallationTokenMintResult>,
): Promise<string> {
  return installationTokenSingleFlight(cacheKey, async () => {
    // Snapshot before minting; re-checked before the put below (see installationTokenGenerations).
    const generationAtStart = installationTokenGeneration(installationId);
    // Cache is best-effort: a KV outage must not block minting an otherwise
    // healthy GitHub token, or clone/publish/review/webhook flows lose access.
    try {
      const cached = await env.REPOS_CACHE.get(cacheKey);
      if (cached) return cached;
    } catch (error) {
      // Fall through to minting on a cache-read failure. Token minting is
      // security-sensitive, so surface the KV failure (metadata only, never the
      // token) instead of swallowing it silently. Use `kvError` rather than
      // `error`: the worker logger escalates any warn carrying an `error` key to
      // the registered error handler (Sentry/Datadog), and these best-effort KV
      // blips must not page.
      log.warn(
        { action: "installation_token_cache", op: "get", installationId, cacheKey, kvError: String(error) },
        "installation_token_cache_get_failed",
      );
    }

    const mintResult = await mint();
    const token = typeof mintResult === "string" ? mintResult : mintResult.token;
    const writeCacheKey = typeof mintResult === "string" ? cacheKey : (mintResult.cacheKey ?? null);
    if (installationTokenGeneration(installationId) !== generationAtStart) {
      // Invalidation landed mid-mint: return the fresh token to this caller but
      // do not repopulate KV. The next call re-reads KV (miss) and mints fresh.
      log.info(
        { action: "installation_token_cache", op: "put_skipped_invalidated", installationId, cacheKey },
        "installation_token_cache_put_skipped_invalidated",
      );
      return token;
    }
    if (!writeCacheKey) return token;
    try {
      await env.REPOS_CACHE.put(writeCacheKey, token, { expirationTtl: INSTALLATION_TOKEN_TTL_SECONDS });
    } catch (error) {
      // A cache-write failure should not fail the request; the next call re-mints.
      // `kvError` (not `error`) keeps this best-effort blip out of the worker's
      // logger error handler. See the get-failure note above.
      log.warn(
        {
          action: "installation_token_cache",
          op: "put",
          installationId,
          cacheKey: writeCacheKey,
          kvError: String(error),
        },
        "installation_token_cache_put_failed",
      );
    }
    return token;
  });
}

// A scoped mint requesting a permission the App installation hasn't granted comes
// back as a 422 from GitHub (not a silent drop). Match on that shape so the CI-read
// fallback only triggers for a genuine missing-grant, never for transient/auth errors.
const PERMISSIONS_NOT_GRANTED_MESSAGE = "The permissions requested are not granted to this installation.";

function isPermissionsNotGrantedError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  const message = String((err as { message?: unknown } | null | undefined)?.message ?? "");
  return status === 422 && message === PERMISSIONS_NOT_GRANTED_MESSAGE;
}

function samePermissions(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

/**
 * Mint a scoped installation token, degrading the CI read scopes (checks/statuses/actions)
 * if the App installation hasn't granted them yet. `mintWith(permissions)` performs
 * the actual GitHub mint for a given permission set. Tries the full desired set first;
 * on a "permissions not granted" 422, retries with only SANDBOX_REQUIRED_TOKEN_PERMISSIONS
 * so clone/push/PR-read keep working until the App grant + installation re-auth lands.
 * The degradation is logged (scope names only, never the token). Any non-permission
 * error, or a permission error when nothing extra can be dropped (the required subset
 * itself was rejected -> the installation is broken), propagates and fails closed.
 */
export async function mintWithCiReadFallback(
  installationId: number,
  desiredPermissions: Record<string, string>,
  mintWith: (permissions: Record<string, string>) => Promise<string>,
): Promise<PermissionFallbackMintResult> {
  try {
    return { token: await mintWith(desiredPermissions), permissions: desiredPermissions };
  } catch (err) {
    if (!isPermissionsNotGrantedError(err)) throw err;
    // Drop everything that isn't in the always-required subset; if that leaves the
    // request unchanged, the required scopes themselves were rejected -> re-throw.
    const fallback = Object.fromEntries(
      Object.entries(desiredPermissions).filter(([key]) => key in SANDBOX_REQUIRED_TOKEN_PERMISSIONS),
    );
    if (samePermissions(fallback, desiredPermissions)) throw err;
    log.warn(
      {
        action: "installation_token_mint",
        op: "ci_read_scope_degraded",
        installationId,
        requested: Object.keys(desiredPermissions).sort().join(","),
        retryWith: Object.keys(fallback).sort().join(","),
      },
      "sandbox_token_ci_read_scope_not_granted",
    );
    return { token: await mintWith(fallback), permissions: fallback };
  }
}

export async function createInstallationToken(
  env: Env,
  installationId: number,
  mint: () => Promise<string> = () => {
    const octokit = createInstallationOctokit(env, installationId);
    return octokit.apps
      .createInstallationAccessToken({ installation_id: installationId })
      .then(({ data }) => data.token);
  },
): Promise<string> {
  return mintAndCacheInstallationToken(env, installationId, installationTokenCacheKey(installationId), mint);
}

/**
 * Mint an installation token scoped to specific repos + permissions. Use for the
 * sandbox clone/`gh`/push surface so a prompt-injection foothold cannot exfiltrate
 * an installation-wide credential. Installation-wide server flows keep
 * createInstallationToken. The scoped token cannot exceed the App installation's
 * granted permissions or repo selection; GitHub rejects an over-broad request, and
 * that rejection propagates to the caller (fail closed), never silently downgrading.
 */
export async function createScopedInstallationToken(
  env: Env,
  installationId: number,
  scope: InstallationTokenScope,
  mint: () => Promise<string | InstallationTokenMintResult> = async () => {
    const octokit = createInstallationOctokit(env, installationId);
    const result = await mintWithCiReadFallback(installationId, scope.permissions, (permissions) =>
      octokit.apps
        .createInstallationAccessToken({
          installation_id: installationId,
          repositories: scope.repositories,
          permissions: permissions as CreateInstallationTokenParams["permissions"],
        })
        .then(({ data }) => data.token),
    );
    return {
      token: result.token,
      cacheKey: scopedInstallationTokenCacheKey(installationId, {
        repositories: scope.repositories,
        permissions: result.permissions,
      }),
    };
  },
): Promise<string> {
  return mintAndCacheInstallationToken(
    env,
    installationId,
    scopedInstallationTokenCacheKey(installationId, scope),
    mint,
  );
}

/**
 * Test-only: reset the module-level single-flight state. Entries self-delete on
 * settle, so this is only needed to stay safe if a test leaves a promise
 * un-awaited; call it in `beforeEach`. Re-creates the flight rather than reaching
 * into the closure's Map.
 */
export function __resetInstallationTokenSingleFlightForTest(): void {
  installationTokenSingleFlight = createSingleFlight<string, string>();
  installationTokenGenerations.clear();
}

// The sandbox bridge aborts its /session/clone-token request at 10s, so the
// server-side timeout + retry budget must finish below that or the retry can
// never reach the client: 2 attempts x 4s = ~8s worst case.
const CLONE_TOKEN_MINT_TIMEOUT_MS = 4_000;
const CLONE_TOKEN_MINT_MAX_ATTEMPTS = 2;

/**
 * Clone-token-specific wrapper around installation-token minting. GitHub's
 * token-mint endpoint normally responds in well under a second but has a rare
 * multi-second latency tail; abort the slow attempt and re-roll instead of
 * letting the bridge's client-side timeout fire. Used only by the
 * /session/clone-token DO route; other callers keep createInstallationToken.
 */
export async function createInstallationTokenForCloneToken(
  env: Env,
  installationId: number,
  scope: InstallationTokenScope,
  mint: (signal: AbortSignal) => Promise<string> = (signal) => {
    const octokit = createInstallationOctokit(env, installationId);
    return mintWithCiReadFallback(installationId, scope.permissions, (permissions) =>
      octokit.apps
        .createInstallationAccessToken({
          installation_id: installationId,
          repositories: scope.repositories,
          permissions: permissions as CreateInstallationTokenParams["permissions"],
          request: { signal },
        })
        .then(({ data }) => data.token),
    ).then((result) => result.token);
  },
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CLONE_TOKEN_MINT_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLONE_TOKEN_MINT_TIMEOUT_MS);
    try {
      return await mint(controller.signal);
    } catch (err) {
      lastErr = err;
      // Only the latency tail is worth re-rolling. A non-timeout failure
      // (e.g. 401/404 from GitHub) is definitive: surface it immediately
      // instead of burning a retry and hiding the first attempt's error.
      if (!controller.signal.aborted) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
