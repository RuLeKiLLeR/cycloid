import { BRAINTRUST_DEFAULT_API_URL, normalizeBraintrustApiUrl } from "../../../../shared/constants/integrations.js";
import {
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
} from "../../../../shared/constants/sandbox-env.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import { isCancellationError } from "./cancellation.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as dynamicToolFailureResult,
  createDynamicToolJsonSuccess,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const BRAINTRUST_DYNAMIC_TOOL_NAMESPACE = "braintrust";
export const BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME = "list_projects";
export const BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME = "query_sql";
export const BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME = "summarize_experiment";
export const BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME = "generate_permalink";
export const BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME = "infer_schema";

const BRAINTRUST_TIMEOUT_MS = 15_000;
const BRAINTRUST_RESPONSE_MAX_CHARS = 64 * 1024;
const BRAINTRUST_ERROR_MAX_CHARS = 2 * 1024;
const BRAINTRUST_SCHEMA_MAX_DEPTH = 20;

function dynamicToolSuccessResult(payload: unknown): FirstPartyDynamicToolCallResult {
  return createDynamicToolJsonSuccess(payload, { truncateText: true });
}

function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new DynamicToolError(`Braintrust tool field '${fieldName}' must be a boolean.`, "invalid_input");
}

function asOptionalInteger(value: unknown, fieldName: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DynamicToolError(
      `Braintrust tool field '${fieldName}' must be an integer between ${min} and ${max}.`,
      "invalid_input",
    );
  }
  return value;
}

function credentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): {
  apiKey: string;
  apiUrl: string;
} | null {
  const apiKey = env[BRAINTRUST_INTEGRATION_API_KEY_ENV]?.trim();
  const rawApiUrl = env[BRAINTRUST_INTEGRATION_API_URL_ENV]?.trim();
  const apiUrl = rawApiUrl ? normalizeBraintrustApiUrl(rawApiUrl) : BRAINTRUST_DEFAULT_API_URL;
  if (!apiKey || !apiUrl) return null;
  return { apiKey, apiUrl };
}

export function redactBraintrustDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | undefined {
  const input = asRecord(args);
  if (!input) return { queryRedacted: true };

  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : null;
  const query = asNonEmptyString(input.query);
  return {
    ...(limit !== null ? { limit } : {}),
    ...(query ? { queryLength: query.length } : {}),
    queryRedacted: true,
  };
}

export function redactBraintrustSummarizeExperimentInputForPersistence(
  args: unknown,
): Record<string, unknown> | undefined {
  const input = asRecord(args);
  if (!input) return { inputRedacted: true };

  return {
    ...(asNonEmptyString(input.experiment_id) ? { experimentId: asNonEmptyString(input.experiment_id) } : {}),
    ...(typeof input.summarize_scores === "boolean" ? { summarizeScores: input.summarize_scores } : {}),
    ...(asNonEmptyString(input.comparison_experiment_id)
      ? { comparisonExperimentId: asNonEmptyString(input.comparison_experiment_id) }
      : {}),
    inputRedacted: true,
  };
}

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  if (error.code === DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT || error.code === DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED) {
    return error.code;
  }
  if (error.status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (error.status === 401) return DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED;
  if (error.status === 403) return DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING;
  if (error.status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (error.status === 429) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

function requireListProjectsInput(args: unknown): { limit: number } {
  const input = args === undefined ? {} : asRecord(args);
  if (!input) {
    throw new DynamicToolError("Braintrust list_projects requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["limit"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Braintrust list_projects received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const rawLimit = input.limit;
  if (rawLimit === undefined) return { limit: 20 };
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new DynamicToolError("Braintrust list_projects limit must be an integer from 1 to 100.", "invalid_input");
  }
  return { limit: rawLimit };
}

function requireQuerySqlInput(args: unknown): { query: string } {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Braintrust query_sql requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["query"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Braintrust query_sql received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const query = asNonEmptyString(input.query);
  if (!query) {
    throw new DynamicToolError("Braintrust query_sql requires a non-empty 'query' string.", "invalid_input");
  }
  // This catches accidental writes, but Braintrust's /btql endpoint is the
  // read-only enforcement boundary for complex WITH query forms.
  if (!/^(select|with)\b/i.test(query)) {
    throw new DynamicToolError("Braintrust query_sql only accepts read-only SELECT or WITH queries.", "invalid_input");
  }
  return { query };
}

function requireSummarizeExperimentInput(args: unknown): {
  experimentId: string;
  summarizeScores?: boolean;
  comparisonExperimentId?: string;
} {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Braintrust summarize_experiment requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["experiment_id", "summarize_scores", "comparison_experiment_id"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Braintrust summarize_experiment received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const experimentId = asNonEmptyString(input.experiment_id);
  if (!experimentId) {
    throw new DynamicToolError(
      "Braintrust summarize_experiment requires a non-empty 'experiment_id' string.",
      "invalid_input",
    );
  }
  return {
    experimentId,
    summarizeScores: asOptionalBoolean(input.summarize_scores, "summarize_scores"),
    comparisonExperimentId: asNonEmptyString(input.comparison_experiment_id) ?? undefined,
  };
}

function requireGeneratePermalinkInput(args: unknown): {
  objectType: "experiment" | "project";
  objectId: string;
  orgName?: string;
  projectName?: string;
  appUrl?: string;
} {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Braintrust generate_permalink requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["object_type", "object_id", "org_name", "project_name", "app_url"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Braintrust generate_permalink received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const objectType = asNonEmptyString(input.object_type);
  if (objectType !== "experiment" && objectType !== "project") {
    throw new DynamicToolError(
      "Braintrust generate_permalink requires 'object_type' to be 'experiment' or 'project'.",
      "invalid_input",
    );
  }
  const objectId = asNonEmptyString(input.object_id);
  if (!objectId) {
    throw new DynamicToolError(
      "Braintrust generate_permalink requires a non-empty 'object_id' string.",
      "invalid_input",
    );
  }
  return {
    objectType,
    objectId,
    orgName: asNonEmptyString(input.org_name) ?? undefined,
    projectName: asNonEmptyString(input.project_name) ?? undefined,
    appUrl: asNonEmptyString(input.app_url) ?? undefined,
  };
}

function requireInferSchemaInput(args: unknown): {
  sourceType: "project_logs" | "experiment" | "dataset";
  objectId: string;
  shape?: "spans" | "traces";
  sampleLimit: number;
  days: number;
  where?: string;
} {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Braintrust infer_schema requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["source_type", "object_id", "shape", "sample_limit", "days", "where"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Braintrust infer_schema received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const sourceType = asNonEmptyString(input.source_type);
  if (sourceType !== "project_logs" && sourceType !== "experiment" && sourceType !== "dataset") {
    throw new DynamicToolError(
      "Braintrust infer_schema requires 'source_type' to be 'project_logs', 'experiment', or 'dataset'.",
      "invalid_input",
    );
  }
  const objectId = asNonEmptyString(input.object_id);
  if (!objectId) {
    throw new DynamicToolError("Braintrust infer_schema requires a non-empty 'object_id' string.", "invalid_input");
  }
  const shape = asNonEmptyString(input.shape);
  if (shape !== undefined && shape !== "spans" && shape !== "traces") {
    throw new DynamicToolError("Braintrust infer_schema field 'shape' must be 'spans' or 'traces'.", "invalid_input");
  }
  if (shape !== undefined && sourceType !== "project_logs") {
    throw new DynamicToolError(
      "Braintrust infer_schema field 'shape' is only applicable when source_type is 'project_logs'.",
      "invalid_input",
    );
  }
  const where = asNonEmptyString(input.where) ?? undefined;
  if (where?.includes(";") || where?.includes("--") || where?.includes("/*") || where?.includes("*/")) {
    throw new DynamicToolError(
      "Braintrust infer_schema field 'where' must not contain semicolons or SQL comments.",
      "invalid_input",
    );
  }
  return {
    sourceType,
    objectId,
    shape: shape ?? undefined,
    sampleLimit: asOptionalInteger(input.sample_limit, "sample_limit", 1, 100) ?? 20,
    days: asOptionalInteger(input.days, "days", 1, 365) ?? 7,
    where,
  };
}

function truncateResponseText(value: string): { text: string; truncated: boolean } {
  if (value.length <= BRAINTRUST_RESPONSE_MAX_CHARS) return { text: value, truncated: false };
  const marker = "\n\n[truncated]";
  return {
    text: `${value.slice(0, Math.max(0, BRAINTRUST_RESPONSE_MAX_CHARS - marker.length))}${marker}`,
    truncated: true,
  };
}

async function readBraintrustJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const { text: truncatedText, truncated } = truncateResponseText(text);
  let payload: unknown;
  try {
    payload = JSON.parse(truncatedText);
  } catch {
    payload = { raw: truncatedText };
  }
  return truncated ? { truncated: true, response: payload } : payload;
}

async function readBraintrustErrorDetail(response: Response): Promise<string> {
  const raw = (await response.text().catch(() => "")).trim();
  if (!raw) return "";
  const { text, truncated } = truncateResponseText(raw);
  const detail = text.slice(0, BRAINTRUST_ERROR_MAX_CHARS);
  return `${detail}${truncated || text.length > BRAINTRUST_ERROR_MAX_CHARS ? "\n\n[truncated]" : ""}`;
}

async function requestBraintrustJson(params: {
  credentials: { apiKey: string; apiUrl: string };
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = new URL(`${params.credentials.apiUrl}${params.path}`);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await params.fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${params.credentials.apiKey}`,
      accept: "application/json",
    },
    signal: createTimeoutAwareSignal(params.signal, BRAINTRUST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readBraintrustErrorDetail(response);
    throw new DynamicToolError(
      `Braintrust API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      "upstream_http_error",
      response.status,
    );
  }

  return readBraintrustJsonResponse(response);
}

async function listBraintrustProjects(params: {
  credentials: { apiKey: string; apiUrl: string };
  limit: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = new URL(`${params.credentials.apiUrl}/v1/project`);
  url.searchParams.set("limit", String(params.limit));
  const response = await params.fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${params.credentials.apiKey}`,
      accept: "application/json",
    },
    signal: createTimeoutAwareSignal(params.signal, BRAINTRUST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readBraintrustErrorDetail(response);
    throw new DynamicToolError(
      `Braintrust API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      "upstream_http_error",
      response.status,
    );
  }

  const payload = await readBraintrustJsonResponse(response);
  const parsed = asRecord(payload);
  const objects = Array.isArray(parsed?.objects) ? parsed.objects : [];
  return {
    projects: objects.slice(0, params.limit).map((project) => {
      const row = asRecord(project) ?? {};
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        created: row.created ?? null,
        org_id: row.org_id ?? null,
      };
    }),
  };
}

async function queryBraintrustSql(params: {
  credentials: { apiKey: string; apiUrl: string };
  query: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await params.fetchImpl(`${params.credentials.apiUrl}/btql`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.credentials.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: params.query, fmt: "json" }),
    signal: createTimeoutAwareSignal(params.signal, BRAINTRUST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readBraintrustErrorDetail(response);
    throw new DynamicToolError(
      `Braintrust API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      "upstream_http_error",
      response.status,
    );
  }

  return readBraintrustJsonResponse(response);
}

function quoteBraintrustSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildInferSchemaQuery(input: ReturnType<typeof requireInferSchemaInput>): string {
  const quotedId = quoteBraintrustSqlString(input.objectId);
  const source =
    input.sourceType === "project_logs"
      ? `project_logs(${quotedId}${input.shape ? `, shape => ${quoteBraintrustSqlString(input.shape)}` : ""})`
      : `${input.sourceType}(${quotedId})`;
  const filters: string[] = [];
  if (input.sourceType === "project_logs") {
    filters.push(`created > now() - interval ${input.days} day`);
  }
  if (input.where) filters.push(`(${input.where})`);
  return [
    `SELECT * FROM ${source}`,
    filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    `LIMIT ${input.sampleLimit}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function extractRows(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (Array.isArray(record?.data)) return record.data;
  if (Array.isArray(record?.rows)) return record.rows;
  return Array.isArray(payload) ? payload : [];
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function collectSchemaField(
  fields: Map<string, { types: Set<string>; examples: unknown[]; counts: Map<string, number> }>,
  path: string,
  value: unknown,
  depth = 0,
): void {
  const field = fields.get(path) ?? { types: new Set<string>(), examples: [], counts: new Map<string, number>() };
  field.types.add(describeJsonType(value));
  if (field.examples.length < 3 && value !== undefined) field.examples.push(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    const key = JSON.stringify(value);
    field.counts.set(key, (field.counts.get(key) ?? 0) + 1);
  }
  fields.set(path, field);

  const record = asRecord(value);
  if (!record || depth >= BRAINTRUST_SCHEMA_MAX_DEPTH) return;
  for (const [childKey, childValue] of Object.entries(record)) {
    collectSchemaField(fields, path ? `${path}.${childKey}` : childKey, childValue, depth + 1);
  }
}

function inferSchemaFromRows(rows: unknown[], query: string): unknown {
  const fields = new Map<string, { types: Set<string>; examples: unknown[]; counts: Map<string, number> }>();
  for (const row of rows) {
    collectSchemaField(fields, "", row);
  }
  fields.delete("");
  return {
    query,
    sampleRows: rows.length,
    fields: [...fields.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, field]) => ({
        path,
        types: [...field.types].sort(),
        examples: field.examples,
        commonValues: [...field.counts.entries()]
          .sort(([, left], [, right]) => right - left)
          .slice(0, 5)
          .map(([value, count]) => ({ value: JSON.parse(value), count })),
      })),
  };
}

function braintrustAppUrlFromApiUrl(apiUrl: string): string {
  if (apiUrl === "https://api.braintrust.dev" || apiUrl === "https://api-eu.braintrust.dev") {
    return "https://www.braintrust.dev";
  }
  return apiUrl.replace(/\/api(?:\/v1)?$/i, "").replace(/\/+$/, "");
}

export function buildBraintrustListProjectsDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
      name: BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME,
      description: "List Braintrust projects visible to the configured business API key.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of projects to return. Defaults to 20.",
          },
        },
      },
    },
  ];
}

export function buildBraintrustQuerySqlDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
      name: BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME,
      description: "Query Braintrust logs, experiments, and datasets with read-only SQL via the Braintrust /btql API.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Read-only Braintrust SQL query. Include a LIMIT and time or ID filter for project_logs queries.",
          },
        },
        required: ["query"],
      },
    },
  ];
}

export function buildBraintrustSummarizeExperimentDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
      name: BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME,
      description: "Fetch Braintrust experiment summary metrics and optional baseline comparison by experiment ID.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          experiment_id: { type: "string", description: "Braintrust experiment UUID." },
          summarize_scores: {
            type: "boolean",
            description: "Whether to include score and metric summaries. Defaults to true.",
          },
          comparison_experiment_id: {
            type: "string",
            description: "Optional baseline experiment UUID. Used only when summarize_scores is true.",
          },
        },
        required: ["experiment_id"],
      },
    },
  ];
}

export function buildBraintrustGeneratePermalinkDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
      name: BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME,
      description: "Generate a shareable Braintrust web link for a project or experiment.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          object_type: { type: "string", enum: ["experiment", "project"] },
          object_id: {
            type: "string",
            description: "Braintrust object UUID. Returned for project links as caller-supplied correlation context.",
          },
          org_name: { type: "string", description: "Required with project_name for project links." },
          project_name: { type: "string", description: "Project name for project links." },
          app_url: { type: "string", description: "Optional Braintrust app base URL for self-hosted deployments." },
        },
        required: ["object_type", "object_id"],
      },
    },
  ];
}

export function buildBraintrustInferSchemaDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
      name: BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME,
      description: "Sample Braintrust logs, experiment rows, or dataset rows and infer available fields and metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_type: { type: "string", enum: ["project_logs", "experiment", "dataset"] },
          object_id: { type: "string", description: "Project, experiment, or dataset UUID matching source_type." },
          shape: {
            type: "string",
            enum: ["spans", "traces"],
            description: "Optional project_logs shape. Defaults to Braintrust's source default.",
          },
          sample_limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows to sample. Defaults to 20." },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 365,
            description: "Recent-day filter for project_logs. Defaults to 7.",
          },
          where: { type: "string", description: "Optional additional Braintrust SQL WHERE expression." },
        },
        required: ["source_type", "object_id"],
      },
    },
  ];
}

export async function executeBraintrustListProjectsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Braintrust credentials are not configured for this session.");
  }
  try {
    const { limit } = requireListProjectsInput(args);
    const payload = await listBraintrustProjects({
      credentials,
      limit,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult(payload);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Braintrust list_projects was cancelled.");
    }
    const braintrustError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(braintrustError),
      `Braintrust list_projects failed: ${braintrustError.message}`,
    );
  }
}

export async function executeBraintrustSummarizeExperimentDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Braintrust credentials are not configured for this session.");
  }
  try {
    const input = requireSummarizeExperimentInput(args);
    const payload = await requestBraintrustJson({
      credentials,
      path: `/v1/experiment/${encodeURIComponent(input.experimentId)}/summarize`,
      query: {
        summarize_scores: input.summarizeScores,
        comparison_experiment_id: input.summarizeScores !== false ? input.comparisonExperimentId : undefined,
      },
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult(payload);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Braintrust summarize_experiment was cancelled.");
    }
    const braintrustError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(braintrustError),
      `Braintrust summarize_experiment failed: ${braintrustError.message}`,
    );
  }
}

export async function executeBraintrustGeneratePermalinkDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Braintrust credentials are not configured for this session.");
  }
  try {
    const input = requireGeneratePermalinkInput(args);
    if (input.objectType === "experiment") {
      const summary = asRecord(
        await requestBraintrustJson({
          credentials,
          path: `/v1/experiment/${encodeURIComponent(input.objectId)}/summarize`,
          query: { summarize_scores: false },
          fetchImpl: context.fetchImpl ?? fetch,
          signal: context.signal,
        }),
      );
      const url = asNonEmptyString(summary?.experiment_url) ?? asNonEmptyString(summary?.experimentUrl);
      if (!url) {
        throw new DynamicToolError(
          "Braintrust experiment summary did not include an experiment URL.",
          "upstream_error",
        );
      }
      return dynamicToolSuccessResult({ objectType: input.objectType, objectId: input.objectId, url });
    }

    const projectName = input.projectName;
    if (!projectName || !input.orgName) {
      throw new DynamicToolError(
        "Braintrust project permalinks require 'org_name' and 'project_name'.",
        "invalid_input",
      );
    }
    const appUrl = braintrustAppUrlFromApiUrl(input.appUrl ?? credentials.apiUrl);
    return dynamicToolSuccessResult({
      objectType: input.objectType,
      objectId: input.objectId,
      url: `${appUrl}/app/${encodeURIComponent(input.orgName)}/p/${encodeURIComponent(projectName)}`,
    });
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Braintrust generate_permalink was cancelled.");
    }
    const braintrustError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(braintrustError),
      `Braintrust generate_permalink failed: ${braintrustError.message}`,
    );
  }
}

export async function executeBraintrustInferSchemaDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Braintrust credentials are not configured for this session.");
  }
  try {
    const input = requireInferSchemaInput(args);
    const query = buildInferSchemaQuery(input);
    const payload = await queryBraintrustSql({
      credentials,
      query,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult(inferSchemaFromRows(extractRows(payload), query));
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Braintrust infer_schema was cancelled.");
    }
    const braintrustError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(braintrustError),
      `Braintrust infer_schema failed: ${braintrustError.message}`,
    );
  }
}

export async function executeBraintrustQuerySqlDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Braintrust credentials are not configured for this session.");
  }
  try {
    const { query } = requireQuerySqlInput(args);
    const payload = await queryBraintrustSql({
      credentials,
      query,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult(payload);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Braintrust query_sql was cancelled.");
    }
    const braintrustError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(braintrustError),
      `Braintrust query_sql failed: ${braintrustError.message}`,
    );
  }
}
