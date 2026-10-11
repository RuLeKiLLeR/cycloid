import {
  type ManagedMcpRuntimeServer,
  MCP_TRANSPORTS,
  type McpDiscoveredTool,
  type McpHeaderConfig,
  type McpServerInput,
  type McpServerRecord,
  type McpServerScope,
  type McpTransport,
  type McpValidationStatus,
} from "../../../../shared/types/mcp.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { d1Changed } from "../db/errors";
import { generateRandomHex } from "../utils";

interface McpServerRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  url: string | null;
  args_json: string;
  headers_json: string;
  secret_refs_json: string;
  scope_json: string;
  enabled: number;
  validation_status: McpValidationStatus;
  validation_error: string | null;
  discovered_tools_json: string;
  last_validated_at: number | null;
  created_by_user_id: number | null;
  created_at: number;
  updated_at: number;
}

export class McpRegistryValidationError extends Error {}

const MCP_TRANSPORT_SET = new Set<string>(MCP_TRANSPORTS);
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ARG_COUNT = 50;
const MAX_HEADER_COUNT = 50;
const MAX_SCOPE_REPOSITORY_COUNT = 100;
const MAX_SECRET_REF_COUNT = 50;
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeOptionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new McpRegistryValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new McpRegistryValidationError(`${field} is too long`);
  }
  return trimmed;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeOptionalString(value, field, maxLength);
  if (!normalized) throw new McpRegistryValidationError(`${field} is required`);
  return normalized;
}

function normalizeTransport(value: unknown): McpTransport {
  if (typeof value !== "string" || !MCP_TRANSPORT_SET.has(value)) {
    throw new McpRegistryValidationError(`transport must be one of: ${MCP_TRANSPORTS.join(", ")}`);
  }
  return value as McpTransport;
}

function normalizeUrl(value: unknown, transport: McpTransport): string | null {
  const normalized = normalizeOptionalString(value, "url", 2048);
  if (transport === "stdio") {
    if (normalized) throw new McpRegistryValidationError("url is not allowed for stdio MCP servers");
    return null;
  }
  if (!normalized) throw new McpRegistryValidationError("url is required for remote MCP servers");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new McpRegistryValidationError("url must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new McpRegistryValidationError("remote MCP server URL must use HTTPS");
  }
  return url.toString();
}

function normalizeCommand(value: unknown, transport: McpTransport): string | null {
  const normalized = normalizeOptionalString(value, "command", 512);
  if (transport !== "stdio") {
    if (normalized) throw new McpRegistryValidationError("command is only allowed for stdio MCP servers");
    return null;
  }
  if (!normalized) throw new McpRegistryValidationError("command is required for stdio MCP servers");
  return normalized;
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new McpRegistryValidationError("args must be an array");
  if (value.length > MAX_ARG_COUNT) throw new McpRegistryValidationError("args has too many entries");
  return value.map((arg, index) => {
    if (typeof arg !== "string") throw new McpRegistryValidationError(`args[${index}] must be a string`);
    if (arg.length > 512) throw new McpRegistryValidationError(`args[${index}] is too long`);
    return arg;
  });
}

function normalizeSecretRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !SECRET_REF_PATTERN.test(value)) {
    throw new McpRegistryValidationError(`${field} must be an uppercase env-style secret reference`);
  }
  return value;
}

function normalizeHeaders(value: unknown): Record<string, McpHeaderConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpRegistryValidationError("headers must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) throw new McpRegistryValidationError("headers has too many entries");
  const headers: Record<string, McpHeaderConfig> = {};
  const normalizedHeaderNames = new Set<string>();
  for (const [name, rawConfig] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) throw new McpRegistryValidationError(`Invalid header name: ${name}`);
    const normalizedName = name.toLowerCase();
    if (normalizedHeaderNames.has(normalizedName)) {
      throw new McpRegistryValidationError(`Duplicate header name: ${name}`);
    }
    normalizedHeaderNames.add(normalizedName);
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      throw new McpRegistryValidationError(`headers.${name} must be an object`);
    }
    const config = rawConfig as Record<string, unknown>;
    const secretRef =
      config.secretRef === undefined ? null : normalizeSecretRef(config.secretRef, `headers.${name}.secretRef`);
    if (!secretRef) {
      throw new McpRegistryValidationError(`headers.${name} must set secretRef`);
    }
    headers[normalizedName] = { secretRef };
  }
  return headers;
}

function normalizeSecretRefs(value: unknown, headers: Record<string, McpHeaderConfig>): string[] {
  const refs = new Set<string>();
  for (const config of Object.values(headers)) {
    if (config.secretRef) refs.add(config.secretRef);
  }
  if (value !== undefined) {
    if (!Array.isArray(value)) throw new McpRegistryValidationError("secretRefs must be an array");
    if (value.length > MAX_SECRET_REF_COUNT) throw new McpRegistryValidationError("secretRefs has too many entries");
    for (const [index, ref] of value.entries()) {
      refs.add(normalizeSecretRef(ref, `secretRefs[${index}]`));
    }
  }
  if (refs.size > MAX_SECRET_REF_COUNT) throw new McpRegistryValidationError("secretRefs has too many entries");
  return [...refs].sort();
}

function normalizeScope(value: unknown): McpServerScope {
  if (value === undefined) return { type: "business" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpRegistryValidationError("scope must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.type === "business") return { type: "business" };
  if (raw.type !== "repositories") {
    throw new McpRegistryValidationError("scope.type must be business or repositories");
  }
  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) {
    throw new McpRegistryValidationError("scope.repositories must be a non-empty array");
  }
  if (raw.repositories.length > MAX_SCOPE_REPOSITORY_COUNT) {
    throw new McpRegistryValidationError("scope.repositories has too many entries");
  }
  const repositoriesByKey = new Map<string, { owner: string; name: string }>();
  for (const [index, repo] of raw.repositories.entries()) {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) {
      throw new McpRegistryValidationError(`scope.repositories[${index}] must be an object`);
    }
    const rawRepo = repo as Record<string, unknown>;
    const owner = requireString(rawRepo.owner, `scope.repositories[${index}].owner`, 100);
    const name = requireString(rawRepo.name, `scope.repositories[${index}].name`, 100);
    if (!REPO_PART_PATTERN.test(owner) || !REPO_PART_PATTERN.test(name)) {
      throw new McpRegistryValidationError(`scope.repositories[${index}] has invalid repo identifiers`);
    }
    repositoriesByKey.set(`${owner.toLowerCase()}/${name.toLowerCase()}`, { owner, name });
  }
  const repositories = [...repositoriesByKey.values()];
  return { type: "repositories", repositories };
}

function isUniqueMcpServerNameError(error: unknown): boolean {
  const message = stringifyError(error);
  return message.includes("idx_mcp_servers_business_name_active") || message.includes("mcp_servers.business_id");
}

function throwDuplicateMcpServerNameIfNeeded(error: unknown): never {
  if (isUniqueMcpServerNameError(error)) {
    throw new McpRegistryValidationError("MCP server name already exists");
  }
  throw error;
}

function normalizeEnabled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new McpRegistryValidationError("enabled must be a boolean");
  return value;
}

export function normalizeMcpServerInput(input: unknown): McpServerInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new McpRegistryValidationError("body must be an object");
  }
  const raw = input as Record<string, unknown>;
  const transport = normalizeTransport(raw.transport);
  const headers = normalizeHeaders(raw.headers);
  return {
    name: requireString(raw.name, "name", MAX_NAME_LENGTH),
    description: normalizeOptionalString(raw.description, "description", MAX_DESCRIPTION_LENGTH),
    transport,
    command: normalizeCommand(raw.command, transport),
    url: normalizeUrl(raw.url, transport),
    args: normalizeArgs(raw.args),
    headers,
    secretRefs: normalizeSecretRefs(raw.secretRefs, headers),
    scope: normalizeScope(raw.scope),
    enabled: normalizeEnabled(raw.enabled),
  };
}

function mapMcpServerRow(row: McpServerRow): McpServerRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    url: row.url,
    args: parseJson<string[]>(row.args_json, []),
    headers: parseJson<Record<string, McpHeaderConfig>>(row.headers_json, {}),
    secretRefs: parseJson<string[]>(row.secret_refs_json, []),
    scope: parseJson<McpServerScope>(row.scope_json, { type: "business" }),
    enabled: row.enabled === 1,
    validationStatus: row.validation_status,
    validationError: row.validation_error,
    discoveredTools: parseJson<McpDiscoveredTool[]>(row.discovered_tools_json, []),
    lastValidatedAt: row.last_validated_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMcpServers(db: D1Database, businessId: string): Promise<McpServerRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, business_id, name, description, transport, command, url, args_json, headers_json, secret_refs_json,
              scope_json, enabled, validation_status, validation_error, discovered_tools_json, last_validated_at,
              created_by_user_id, created_at, updated_at
       FROM mcp_servers
       WHERE business_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .bind(businessId)
    .all<McpServerRow>();
  return result.results.map(mapMcpServerRow);
}

export async function listEnabledMcpServersForSession(
  db: D1Database,
  params: { businessId: string; repoOwner: string; repoName: string },
): Promise<McpServerRecord[]> {
  const allServers = await listMcpServers(db, params.businessId);
  return allServers.filter((server) => {
    if (!server.enabled) return false;
    if (server.scope.type === "business") return true;
    return server.scope.repositories.some(
      (repo) =>
        repo.owner.toLowerCase() === params.repoOwner.toLowerCase() &&
        repo.name.toLowerCase() === params.repoName.toLowerCase(),
    );
  });
}

export async function getMcpServer(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
): Promise<McpServerRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, business_id, name, description, transport, command, url, args_json, headers_json, secret_refs_json,
              scope_json, enabled, validation_status, validation_error, discovered_tools_json, last_validated_at,
              created_by_user_id, created_at, updated_at
       FROM mcp_servers
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(businessId, mcpServerId)
    .first<McpServerRow>();
  return row ? mapMcpServerRow(row) : null;
}

export async function createMcpServer(
  db: D1Database,
  businessId: string,
  createdByUserId: number | null,
  rawInput: unknown,
): Promise<McpServerRecord> {
  const input = normalizeMcpServerInput(rawInput);
  const now = Date.now();
  const id = `mcp_${generateRandomHex(12)}`;
  let result: D1Result;
  try {
    result = await db
      .prepare(
        `INSERT OR IGNORE INTO mcp_servers (
         id, business_id, name, description, transport, command, url, args_json, headers_json, secret_refs_json,
         scope_json, enabled, validation_status, validation_error, discovered_tools_json, last_validated_at,
         created_by_user_id, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', NULL, '[]', NULL, ?, ?, ?)`,
      )
      .bind(
        id,
        businessId,
        input.name,
        input.description ?? null,
        input.transport,
        input.command ?? null,
        input.url ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.secretRefs ?? []),
        JSON.stringify(input.scope ?? { type: "business" }),
        input.enabled ? 1 : 0,
        createdByUserId,
        now,
        now,
      )
      .run();
  } catch (error) {
    throwDuplicateMcpServerNameIfNeeded(error);
  }
  if (!d1Changed(result)) {
    throw new McpRegistryValidationError("MCP server name already exists");
  }
  const created = await getMcpServer(db, businessId, id);
  if (!created) throw new Error("Failed to read created MCP server");
  return created;
}

export async function updateMcpServer(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
  rawInput: unknown,
): Promise<McpServerRecord | null> {
  const input = normalizeMcpServerInput(rawInput);
  const now = Date.now();
  let result: D1Result;
  try {
    result = await db
      .prepare(
        `UPDATE mcp_servers
       SET name = ?, description = ?, transport = ?, command = ?, url = ?, args_json = ?, headers_json = ?,
           secret_refs_json = ?, scope_json = ?, enabled = ?, validation_status = 'untested',
           validation_error = NULL, discovered_tools_json = '[]', last_validated_at = NULL, validation_job_id = NULL,
           updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(
        input.name,
        input.description ?? null,
        input.transport,
        input.command ?? null,
        input.url ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.secretRefs ?? []),
        JSON.stringify(input.scope ?? { type: "business" }),
        input.enabled ? 1 : 0,
        now,
        businessId,
        mcpServerId,
      )
      .run();
  } catch (error) {
    throwDuplicateMcpServerNameIfNeeded(error);
  }
  if (!d1Changed(result)) return null;
  return getMcpServer(db, businessId, mcpServerId);
}

export async function deleteMcpServer(db: D1Database, businessId: string, mcpServerId: string): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      "UPDATE mcp_servers SET deleted_at = ?, updated_at = ? WHERE business_id = ? AND id = ? AND deleted_at IS NULL",
    )
    .bind(now, now, businessId, mcpServerId)
    .run();
  return d1Changed(result);
}

export async function markMcpServerValidating(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
  expected: { transport: McpTransport; updatedAt: number },
): Promise<{ server: McpServerRecord; validationJobId: string } | null> {
  const now = Date.now();
  const validationJobId = `mcp_validation_${generateRandomHex(12)}`;
  const result = await db
    .prepare(
      `UPDATE mcp_servers
       SET validation_status = 'validating', validation_error = NULL, discovered_tools_json = '[]',
           last_validated_at = NULL, validation_job_id = ?, updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND transport = ? AND updated_at = ?`,
    )
    .bind(validationJobId, now, businessId, mcpServerId, expected.transport, expected.updatedAt)
    .run();
  if (!d1Changed(result)) return null;
  const server = await getMcpServer(db, businessId, mcpServerId);
  if (!server) return null;
  return { server, validationJobId };
}

export async function resetMcpServerValidation(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
  error: string,
  validationJobId: string,
): Promise<McpServerRecord | null> {
  const now = Date.now();
  const update = await db
    .prepare(
      `UPDATE mcp_servers
       SET validation_status = 'untested', validation_error = ?, validation_job_id = NULL, updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND validation_status = 'validating'
         AND validation_job_id = ?`,
    )
    .bind(error, now, businessId, mcpServerId, validationJobId)
    .run();
  if (!d1Changed(update)) return null;
  return getMcpServer(db, businessId, mcpServerId);
}

export async function markMcpServerValidationUnsupported(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
  error: string,
  expected: { transport: McpTransport; updatedAt: number },
): Promise<McpServerRecord | null> {
  const now = Date.now();
  const update = await db
    .prepare(
      `UPDATE mcp_servers
       SET validation_status = 'untested', validation_error = ?, validation_job_id = NULL, updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND transport = ? AND updated_at = ?`,
    )
    .bind(error, now, businessId, mcpServerId, expected.transport, expected.updatedAt)
    .run();
  if (!d1Changed(update)) return null;
  return getMcpServer(db, businessId, mcpServerId);
}

export async function completeMcpServerValidation(
  db: D1Database,
  businessId: string,
  mcpServerId: string,
  result: { status: "valid"; tools: McpDiscoveredTool[] } | { status: "invalid"; error: string },
  validationJobId: string,
): Promise<McpServerRecord | null> {
  const now = Date.now();
  const update =
    result.status === "valid"
      ? await db
          .prepare(
            `UPDATE mcp_servers
       SET validation_status = ?, validation_error = ?, discovered_tools_json = ?, last_validated_at = ?,
           validation_job_id = NULL, updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND validation_status = 'validating'
         AND validation_job_id = ?`,
          )
          .bind(result.status, null, JSON.stringify(result.tools), now, now, businessId, mcpServerId, validationJobId)
          .run()
      : await db
          .prepare(
            `UPDATE mcp_servers
       SET validation_status = ?, validation_error = ?, validation_job_id = NULL, updated_at = ?
       WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND validation_status = 'validating'
         AND validation_job_id = ?`,
          )
          .bind(result.status, result.error, now, businessId, mcpServerId, validationJobId)
          .run();
  if (!d1Changed(update)) return null;
  return getMcpServer(db, businessId, mcpServerId);
}

export interface ManagedMcpRuntimeConfig {
  servers: ManagedMcpRuntimeServer[];
  envVars: Record<string, string>;
  warnings: string[];
}

function runtimeServerName(server: McpServerRecord): string {
  return `cycloid-${server.id}`;
}

export function buildManagedMcpRuntimeConfig(
  servers: McpServerRecord[],
  envSources: Record<string, string | undefined>,
): ManagedMcpRuntimeConfig {
  const runtimeServers: ManagedMcpRuntimeServer[] = [];
  const envVars: Record<string, string> = {};
  const warnings: string[] = [];

  for (const server of servers) {
    const missing = server.secretRefs.filter((secretRef) => !envSources[secretRef]);
    if (missing.length > 0) {
      warnings.push(`MCP server '${server.name}' skipped because secret refs are missing: ${missing.join(", ")}`);
      continue;
    }
    for (const secretRef of server.secretRefs) {
      const value = envSources[secretRef];
      if (value) envVars[secretRef] = value;
    }
    const headers = Object.fromEntries(
      Object.entries(server.headers).map(([name, config]) => [name, { envVar: config.secretRef }]),
    );
    runtimeServers.push({
      name: runtimeServerName(server),
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args.length > 0 ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(server.secretRefs.length > 0 ? { envVars: server.secretRefs } : {}),
    });
  }

  return { servers: runtimeServers, envVars, warnings };
}
