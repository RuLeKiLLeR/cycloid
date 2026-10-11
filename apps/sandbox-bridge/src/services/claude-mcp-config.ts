import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLATFORM_SECRET_ENV_KEYS,
  SECRET_ENV_KEY_SUFFIX_PATTERN,
  TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES,
} from "../../../../shared/constants/agent-child-env.js";
import { type BridgeLogger } from "../logger.js";

/**
 * Project `.mcp.json` projection for the Claude Code backend.
 *
 * The Agent SDK loads no filesystem settings by default (`settingSources` is
 * empty), so the customer repo's committed `.mcp.json` — which the Claude Code
 * CLI would honor locally — is invisible to sandbox sessions unless the bridge
 * projects it into the `query()` `mcpServers` option. This module reads ONLY
 * `.mcp.json` (never settings.json hooks or other project settings, which stay
 * platform-owned) and maps it onto the SDK server-config shapes.
 *
 * Fail-safe by design: a missing file means no servers; a malformed file or
 * entry is logged and skipped so a bad customer config can never take down the
 * session. Tool calls from projected servers still pass through the in-process
 * `canUseTool` safety gate like every other tool.
 */

/** Structural subset of the SDK `McpServerConfig` union (stdio | sse | http). */
export type ProjectMcpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse" | "http"; url: string; headers?: Record<string, string> };

const MCP_CONFIG_FILENAME = ".mcp.json";

/**
 * Whether a `.mcp.json` `${VAR}` reference may be expanded at all. A malicious
 * or careless customer config must not bake a platform secret (e.g.
 * `${DD_API_KEY}`) into a server's command/args/headers, where a sanitized
 * child env would not help because the value is already a literal in argv.
 * Trusted customer-integration credential names are allowed for local stdio
 * server expansion only (the customer exposing their own same-tenant token to
 * their own session); platform secrets and unknown secret-shaped names are
 * rejected. Repo-controlled remote MCP URLs/headers are stricter and cannot
 * reference trusted integration credentials or session-managed MCP credential
 * names.
 */
function isExpandableEnvReference(name: string, ctx: ExpandContext): boolean {
  if (ctx.denyTrustedIntegrationCredentialRefs && TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES.has(name)) return false;
  if (ctx.deniedEnvNames?.has(name)) return false;
  if (TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES.has(name)) return true;
  if (PLATFORM_SECRET_ENV_KEYS.has(name)) return false;
  if (SECRET_ENV_KEY_SUFFIX_PATTERN.test(name)) return false;
  return true;
}

type ExpandContext = {
  env: NodeJS.ProcessEnv;
  /** Every env name referenced (before expansion), for preserveNames. */
  referenced: Set<string>;
  /** Referenced names rejected by `isExpandableEnvReference`, for logging. */
  denied: Set<string>;
  /** Additional env names rejected by this expansion context. */
  deniedEnvNames?: ReadonlySet<string>;
  /** Reject trusted integration credentials in repo-controlled remote URLs/headers. */
  denyTrustedIntegrationCredentialRefs?: boolean;
  /** Session-scoped managed MCP credential names to apply only when constructing a remote expansion context. */
  remoteDeniedEnvNames?: ReadonlySet<string>;
};

/**
 * Expand `${VAR}` / `${VAR:-default}` references from the bridge environment,
 * matching the Claude Code CLI's `.mcp.json` expansion. Like shell `:-`, the
 * default applies when the variable is unset OR empty. Returns null when a
 * referenced variable is unset and has no default, OR when it references a
 * disallowed secret name — the caller drops that server (fail closed) instead
 * of passing a literal `${...}` placeholder or a baked secret to the SDK.
 */
export function expandEnvReferences(value: string, ctx: ExpandContext): string | null {
  let failed = false;
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      ctx.referenced.add(name);
      if (!isExpandableEnvReference(name, ctx)) {
        ctx.denied.add(name);
        failed = true;
        return "";
      }
      const raw = ctx.env[name];
      // `:-` semantics: empty counts as unset when a default exists.
      const resolved = raw !== undefined && (raw !== "" || fallback === undefined) ? raw : fallback;
      if (resolved === undefined) {
        failed = true;
        return "";
      }
      return resolved;
    },
  );
  return failed ? null : expanded;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function expandRecord(record: Record<string, string>, ctx: ExpandContext): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const expanded = expandEnvReferences(raw, ctx);
    if (expanded === null) return null;
    result[key] = expanded;
  }
  return result;
}

function parseServerEntry(raw: unknown, ctx: ExpandContext): ProjectMcpServerConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  // `.mcp.json` accepts "streamable-http" as a documented alias for the SDK's
  // programmatic "http" transport.
  const remoteType = entry.type === "streamable-http" ? "http" : entry.type;
  if (remoteType === "sse" || remoteType === "http") {
    if (typeof entry.url !== "string" || entry.url.length === 0) return null;
    const remoteCtx: ExpandContext = {
      env: ctx.env,
      referenced: ctx.referenced,
      denied: ctx.denied,
      deniedEnvNames: ctx.remoteDeniedEnvNames,
      denyTrustedIntegrationCredentialRefs: true,
    };
    const url = expandEnvReferences(entry.url, remoteCtx);
    if (url === null) return null;
    let headers: Record<string, string> | undefined;
    if (entry.headers !== undefined) {
      if (!isStringRecord(entry.headers)) return null;
      const expanded = expandRecord(entry.headers, remoteCtx);
      if (expanded === null) return null;
      headers = expanded;
    }
    return { type: remoteType, url, ...(headers ? { headers } : {}) };
  }

  // Default (and explicit "stdio") shape.
  if (entry.type !== undefined && entry.type !== "stdio") return null;
  if (typeof entry.command !== "string" || entry.command.length === 0) return null;
  const command = expandEnvReferences(entry.command, ctx);
  if (command === null) return null;
  let args: string[] | undefined;
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) return null;
    const expandedArgs: string[] = [];
    for (const arg of entry.args) {
      const expanded = expandEnvReferences(arg, ctx);
      if (expanded === null) return null;
      expandedArgs.push(expanded);
    }
    args = expandedArgs;
  }
  let serverEnv: Record<string, string> | undefined;
  if (entry.env !== undefined) {
    if (!isStringRecord(entry.env)) return null;
    const expanded = expandRecord(entry.env, ctx);
    if (expanded === null) return null;
    serverEnv = expanded;
  }
  return { command, ...(args ? { args } : {}), ...(serverEnv ? { env: serverEnv } : {}) };
}

export type LoadedProjectMcp = {
  servers: Record<string, ProjectMcpServerConfig>;
  /** Env names referenced by accepted project servers, before expansion.
   * Repo-projected MCP references are diagnostics only and must not drive
   * Claude child env credential preservation. */
  referencedEnvNames: Set<string>;
};

export type LoadProjectMcpOptions = {
  /** Env names that are session-managed credentials and must not be expanded into repo remote MCP URL/header fields. */
  deniedRemoteEnvNames?: ReadonlySet<string>;
};

/**
 * Load and validate `<cwd>/.mcp.json`, returning SDK-shaped server configs plus
 * the env names accepted servers reference, or undefined when the file is absent,
 * unreadable, or carries no usable servers. `${VAR}` references are expanded
 * against `env` but platform-secret / unknown secret-shaped references are
 * rejected (the server is dropped, fail closed) so a customer config cannot
 * bake a platform secret into argv. Repo-controlled remote MCP URLs/headers
 * also reject trusted integration credentials so same-tenant tokens cannot be
 * projected to arbitrary remote endpoints.
 */
export function loadProjectMcpServers(
  cwd: string,
  log: BridgeLogger,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadProjectMcpOptions = {},
): LoadedProjectMcp | undefined {
  const path = join(cwd, MCP_CONFIG_FILENAME);
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    log.warn({ event: "claude.mcp_config_invalid", path, error: String(err) }, "Ignoring malformed .mcp.json");
    return undefined;
  }

  const mcpServers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    if (mcpServers !== undefined) {
      log.warn({ event: "claude.mcp_config_invalid", path }, "Ignoring .mcp.json without an mcpServers object");
    }
    return undefined;
  }

  const servers: Record<string, ProjectMcpServerConfig> = {};
  const referencedEnvNames = new Set<string>();
  for (const [name, raw] of Object.entries(mcpServers)) {
    const ctx: ExpandContext = {
      env,
      referenced: new Set(),
      denied: new Set(),
      remoteDeniedEnvNames: options.deniedRemoteEnvNames,
    };
    const server = parseServerEntry(raw, ctx);
    if (ctx.denied.size > 0) {
      // Name-only: these are static platform/secret-shaped names, safe to log.
      log.warn(
        { event: "mcp_env_ref_denied", path, serverName: name, names: [...ctx.denied] },
        "Skipping .mcp.json server that references a denied secret env var",
      );
      continue;
    }
    if (!server) {
      log.warn(
        { event: "claude.mcp_server_skipped", path, serverName: name },
        "Skipping invalid or unresolvable .mcp.json server entry",
      );
      continue;
    }
    servers[name] = server;
    for (const ref of ctx.referenced) referencedEnvNames.add(ref);
  }

  if (Object.keys(servers).length === 0) return undefined;
  return { servers, referencedEnvNames };
}
