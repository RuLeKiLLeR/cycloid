import { isSupportedDatadogSite, normalizeDatadogSite } from "../../../../shared/constants/integrations.js";
import {
  DATADOG_API_KEY_ENV,
  DATADOG_APP_KEY_ENV,
  DATADOG_SITE_ENV,
} from "../../../../shared/constants/sandbox-env.js";
import { asFiniteNumber, asStringArray } from "../../../../shared/utils/type-guards.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  buildDynamicToolErrorResult as buildSharedDynamicToolErrorResult,
  createDynamicToolJsonSuccess as dynamicToolSuccessResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
  mapDynamicToolErrorCode as mapSharedDynamicToolErrorCode,
  truncateWithMarker,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const DATADOG_DYNAMIC_TOOL_NAMESPACE = "datadog";
export const DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME = "search_datadog_logs";
export const DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME = "get_datadog_trace";
export const DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME = "query_metrics";
export const DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME = "get_monitors";

const DATADOG_TIMEOUT_MS = 10_000;
const DATADOG_LOG_LIMIT_MAX = 50;
const DATADOG_LOG_MESSAGE_MAX_CHARS = 4 * 1024;
const DATADOG_TRACE_PAGE_LIMIT = 100;
const DATADOG_TRACE_FETCH_SPAN_LIMIT = 500;
const DATADOG_TRACE_TREE_NODE_LIMIT = 250;
const DATADOG_TRACE_TREE_DEPTH_LIMIT = 8;
const DATADOG_TRACE_ID_PATTERN = /^[0-9a-f]{1,32}$/i;
const DATADOG_TRACE_LOOKBACK_DEFAULT = "24h";
const DATADOG_TRACE_LOOKBACK_MAX_MINUTES = 15 * 24 * 60;
const DATADOG_TRACE_LOOKBACK_PATTERN = /^([1-9]\d*)([mhd])$/;
const DATADOG_METRICS_DEFAULT_WINDOW_SECONDS = 60 * 60;
const DATADOG_METRICS_MAX_LOOKBACK_SECONDS = 15 * 24 * 60 * 60;
const DATADOG_METRICS_SERIES_LIMIT = 10;
const DATADOG_METRICS_POINTS_PER_SERIES_LIMIT = 100;
const DATADOG_MONITOR_LIMIT_MAX = 25;
const DATADOG_MONITOR_MESSAGE_MAX_CHARS = 500;

type DatadogCredentialState =
  | { status: "missing" }
  | { status: "invalid_site"; site: string }
  | { status: "ready"; apiKey: string; appKey: string; site: string };

type DatadogLogsSearchInput = {
  query: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

type DatadogTraceInput = {
  traceId: string;
  lookback: string;
};

type DatadogMetricsInput = {
  query: string;
  from: number;
  to: number;
};

type DatadogMonitorsInput = {
  name: string | null;
  tags: string[];
  groupStates: string | null;
  limit: number;
};

type DatadogApiResponse<T> = {
  data?: T[] | null;
  meta?: {
    page?: { after?: unknown } | null;
  } | null;
  errors?: Array<{ detail?: unknown; title?: unknown }> | null;
};

type DatadogMetricsApiResponse = {
  status?: unknown;
  series?: unknown[] | null;
  error?: unknown;
};

type DatadogMonitorApiResponse = {
  id?: unknown;
  name?: unknown;
  overall_state?: unknown;
  overallState?: unknown;
  message?: unknown;
};

type DatadogTraceSpan = {
  spanId: string;
  parentId: string | null;
  traceId: string;
  name: string | null;
  resourceName: string | null;
  service: string | null;
  status: string | null;
  type: string | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  duration: number | null;
  error: number | boolean | null;
  tags: string[];
  env: string | null;
  host: string | null;
};

type DatadogTraceTreeNode = DatadogTraceSpan & {
  children: DatadogTraceTreeNode[];
  truncatedChildren?: number;
};

function datadogCredentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): DatadogCredentialState {
  const apiKey = env[DATADOG_API_KEY_ENV]?.trim() ?? "";
  const appKey = env[DATADOG_APP_KEY_ENV]?.trim() ?? "";
  const site = normalizeDatadogSite(env[DATADOG_SITE_ENV]) ?? "";
  if (!apiKey || !appKey || !site) return { status: "missing" };
  if (!isSupportedDatadogSite(site)) return { status: "invalid_site", site };
  return { status: "ready", apiKey, appKey, site };
}

function hasDatadogCredentials(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return datadogCredentialsFromEnv(env).status === "ready";
}

function datadogApiUrl(site: string, path: string): string {
  return `https://api.${site}${path}`;
}

function datadogApiUrlWithQuery(site: string, path: string, query?: URLSearchParams): string {
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${datadogApiUrl(site, path)}${suffix}`;
}

function parseRetryDelaySeconds(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number.parseFloat(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function parseRetryAfterMsHeader(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const retryAfterMs = Number.parseFloat(headerValue);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return retryAfterMs;
}

function parseHttpRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const secondsRetryAfterMs = parseRetryDelaySeconds(headerValue);
  if (secondsRetryAfterMs !== null) return secondsRetryAfterMs;
  const retryAt = Date.parse(headerValue);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}

function getDatadogRetryAfterMs(headers: Headers): number | null {
  const retryAfterMsHeader = parseRetryAfterMsHeader(headers.get("retry-after-ms"));
  if (retryAfterMsHeader !== null) return retryAfterMsHeader;

  const retryAfterHeader = parseHttpRetryAfterMs(headers.get("retry-after"));
  if (retryAfterHeader !== null) return retryAfterHeader;

  // Datadog documents X-RateLimit-Period as the backoff window after a 429.
  const rateLimitPeriodMs = parseRetryDelaySeconds(headers.get("x-ratelimit-period"));
  if (rateLimitPeriodMs !== null) return rateLimitPeriodMs;

  return parseRetryDelaySeconds(headers.get("x-ratelimit-reset"));
}

async function datadogApiRequest<T>(params: {
  site: string;
  apiKey: string;
  appKey: string;
  path: string;
  method?: "GET" | "POST";
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<DatadogApiResponse<T>> {
  const method = params.method ?? "POST";
  const response = await params.fetchImpl(datadogApiUrlWithQuery(params.site, params.path, params.query), {
    method,
    headers: {
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "DD-API-KEY": params.apiKey,
      "DD-APPLICATION-KEY": params.appKey,
    },
    ...(method === "POST" ? { body: JSON.stringify(params.body ?? {}) } : {}),
    signal: createTimeoutAwareSignal(params.signal, DATADOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    const retryAfterMs = response.status === 429 ? (getDatadogRetryAfterMs(response.headers) ?? undefined) : undefined;
    throw new DynamicToolError(
      `Datadog API request failed (${response.status})`,
      "upstream_http_error",
      response.status,
      retryAfterMs,
    );
  }

  const payload = (await response.json()) as DatadogApiResponse<T>;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((error) => asNonEmptyString(error.detail) ?? asNonEmptyString(error.title) ?? "Unknown Datadog API error")
      .join("; ");
    throw new DynamicToolError(message, "upstream_error");
  }
  return payload;
}

async function datadogRawApiRequest<T>(params: {
  site: string;
  apiKey: string;
  appKey: string;
  path: string;
  query: URLSearchParams;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await params.fetchImpl(datadogApiUrlWithQuery(params.site, params.path, params.query), {
    method: "GET",
    headers: {
      accept: "application/json",
      "DD-API-KEY": params.apiKey,
      "DD-APPLICATION-KEY": params.appKey,
    },
    signal: createTimeoutAwareSignal(params.signal, DATADOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    const retryAfterMs = response.status === 429 ? (getDatadogRetryAfterMs(response.headers) ?? undefined) : undefined;
    throw new DynamicToolError(
      `Datadog API request failed (${response.status})`,
      "upstream_http_error",
      response.status,
      retryAfterMs,
    );
  }
  return (await response.json()) as T;
}

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  return mapSharedDynamicToolErrorCode(error, {
    passthrough: [
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL,
      DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED,
      DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
    ],
    statusCodes: {
      401: DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL,
      403: DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING,
      404: DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
      429: DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED,
    },
  });
}

function requireDatadogCredentials(
  env: NodeJS.ProcessEnv | Record<string, string>,
): Extract<DatadogCredentialState, { status: "ready" }> {
  const credentials = datadogCredentialsFromEnv(env);
  if (credentials.status === "missing") {
    throw new DynamicToolError("Datadog credentials are not connected for this session.", "not_connected");
  }
  if (credentials.status === "invalid_site") {
    throw new DynamicToolError(
      `Datadog site '${credentials.site}' is not supported for dynamic tools.`,
      "invalid_credential",
    );
  }
  return credentials;
}

function datadogToolErrorResult(
  error: unknown,
  cancelledMessage: string,
  failurePrefix: string,
): FirstPartyDynamicToolCallResult {
  return buildSharedDynamicToolErrorResult({
    error,
    cancelledMessage,
    mapErrorCode: mapDynamicToolErrorCode,
    unexpectedMessage: (unexpected) => `${failurePrefix}: ${String(unexpected)}`,
  });
}

function normalizeSearchLogsInput(args: unknown): DatadogLogsSearchInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Datadog search_datadog_logs requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["query", "from", "to", "cursor", "limit"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Datadog search_datadog_logs received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const query = asNonEmptyString(input.query);
  if (!query) {
    throw new DynamicToolError("Datadog search_datadog_logs requires a non-empty 'query' string.", "invalid_input");
  }

  const from = input.from === undefined ? undefined : asNonEmptyString(input.from);
  const to = input.to === undefined ? undefined : asNonEmptyString(input.to);
  const cursor = input.cursor === undefined ? undefined : asNonEmptyString(input.cursor);
  const limit = input.limit === undefined ? 10 : asFiniteNumber(input.limit);
  if (input.from !== undefined && !from) {
    throw new DynamicToolError(
      "Datadog search_datadog_logs requires 'from' to be a non-empty string.",
      "invalid_input",
    );
  }
  if (input.to !== undefined && !to) {
    throw new DynamicToolError("Datadog search_datadog_logs requires 'to' to be a non-empty string.", "invalid_input");
  }
  if (input.cursor !== undefined && !cursor) {
    throw new DynamicToolError(
      "Datadog search_datadog_logs requires 'cursor' to be a non-empty string.",
      "invalid_input",
    );
  }
  if (cursor && (!from || !to || from.includes("now") || to.includes("now"))) {
    throw new DynamicToolError(
      "Datadog search_datadog_logs requires fixed, non-relative 'from' and 'to' values when using 'cursor'.",
      "invalid_input",
    );
  }
  if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > DATADOG_LOG_LIMIT_MAX) {
    throw new DynamicToolError(
      `Datadog search_datadog_logs requires 'limit' to be an integer between 1 and ${DATADOG_LOG_LIMIT_MAX}.`,
      "invalid_input",
    );
  }

  return {
    query,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  };
}

function parseDatadogTraceLookbackMinutes(lookback: string): number | null {
  const match = DATADOG_TRACE_LOOKBACK_PATTERN.exec(lookback);
  if (!match) return null;
  const count = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2];
  if (!Number.isSafeInteger(count)) return null;
  if (unit === "m") return count;
  if (unit === "h") return count * 60;
  if (unit === "d") return count * 24 * 60;
  return null;
}

function normalizeGetTraceInput(args: unknown): DatadogTraceInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Datadog get_datadog_trace requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["traceId", "lookback"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Datadog get_datadog_trace received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const traceId = asNonEmptyString(input.traceId);
  if (!traceId) {
    throw new DynamicToolError("Datadog get_datadog_trace requires a non-empty 'traceId' string.", "invalid_input");
  }
  if (!DATADOG_TRACE_ID_PATTERN.test(traceId)) {
    throw new DynamicToolError(
      "Datadog get_datadog_trace requires 'traceId' to be a hex string (up to 32 characters).",
      "invalid_input",
    );
  }
  const lookback = input.lookback === undefined ? DATADOG_TRACE_LOOKBACK_DEFAULT : asNonEmptyString(input.lookback);
  if (!lookback) {
    throw new DynamicToolError(
      "Datadog get_datadog_trace requires 'lookback' to be a non-empty relative window such as '24h'.",
      "invalid_input",
    );
  }
  const lookbackMinutes = parseDatadogTraceLookbackMinutes(lookback);
  if (lookbackMinutes === null || lookbackMinutes > DATADOG_TRACE_LOOKBACK_MAX_MINUTES) {
    throw new DynamicToolError(
      "Datadog get_datadog_trace requires 'lookback' to be a relative window ending in m, h, or d and no more than 15d.",
      "invalid_input",
    );
  }
  return { traceId, lookback };
}

function normalizeMetricsInput(args: unknown, nowSeconds = Math.floor(Date.now() / 1000)): DatadogMetricsInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Datadog query_metrics requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["query", "from", "to"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Datadog query_metrics received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const query = asNonEmptyString(input.query);
  if (!query) {
    throw new DynamicToolError("Datadog query_metrics requires a non-empty 'query' string.", "invalid_input");
  }
  const from =
    input.from === undefined ? nowSeconds - DATADOG_METRICS_DEFAULT_WINDOW_SECONDS : asFiniteNumber(input.from);
  const to = input.to === undefined ? nowSeconds : asFiniteNumber(input.to);
  if (from === null || to === null || !Number.isInteger(from) || !Number.isInteger(to)) {
    throw new DynamicToolError(
      "Datadog query_metrics requires integer Unix-second 'from' and 'to' values.",
      "invalid_input",
    );
  }
  if (from >= to) {
    throw new DynamicToolError("Datadog query_metrics requires 'from' to be earlier than 'to'.", "invalid_input");
  }
  if (to - from > DATADOG_METRICS_MAX_LOOKBACK_SECONDS) {
    throw new DynamicToolError("Datadog query_metrics allows a maximum lookback of 15d.", "invalid_input");
  }
  return { query, from, to };
}

function normalizeMonitorsInput(args: unknown): DatadogMonitorsInput {
  const input = asRecord(args ?? {});
  if (!input) {
    throw new DynamicToolError("Datadog get_monitors requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["name", "tags", "groupStates", "limit"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Datadog get_monitors received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const name = input.name === undefined ? null : asNonEmptyString(input.name);
  if (input.name !== undefined && !name) {
    throw new DynamicToolError("Datadog get_monitors requires 'name' to be a non-empty string.", "invalid_input");
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new DynamicToolError("Datadog get_monitors requires 'tags' to be an array of strings.", "invalid_input");
  }
  const tags = input.tags === undefined ? [] : asStringArray(input.tags);
  if (input.tags !== undefined && tags.length !== input.tags.length) {
    throw new DynamicToolError("Datadog get_monitors requires 'tags' to contain only strings.", "invalid_input");
  }
  const groupStates = input.groupStates === undefined ? null : asNonEmptyString(input.groupStates);
  if (input.groupStates !== undefined && !groupStates) {
    throw new DynamicToolError(
      "Datadog get_monitors requires 'groupStates' to be a non-empty string.",
      "invalid_input",
    );
  }
  const limit = input.limit === undefined ? DATADOG_MONITOR_LIMIT_MAX : asFiniteNumber(input.limit);
  if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > DATADOG_MONITOR_LIMIT_MAX) {
    throw new DynamicToolError(
      `Datadog get_monitors requires 'limit' to be an integer between 1 and ${DATADOG_MONITOR_LIMIT_MAX}.`,
      "invalid_input",
    );
  }
  return { name: name ?? null, tags, groupStates: groupStates ?? null, limit };
}

function buildDatadogDynamicToolSpec(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[] {
  return (env) =>
    hasDatadogCredentials(env)
      ? [
          {
            namespace: DATADOG_DYNAMIC_TOOL_NAMESPACE,
            name,
            description,
            inputSchema,
          },
        ]
      : [];
}

function normalizedAttributesContainer(value: Record<string, unknown> | null): Record<string, unknown> | null {
  const nested = asRecord(value?.attributes);
  return nested ?? value;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = asNonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

function summarizeDatadogLogHit(hit: unknown): Record<string, unknown> | null {
  const record = asRecord(hit);
  const attributes = asRecord(record?.attributes);
  const nestedAttributes = normalizedAttributesContainer(attributes);
  if (!record || !attributes) return null;

  const message = firstString(attributes.message, nestedAttributes?.message, nestedAttributes?.["error.message"]);
  return {
    id: asNonEmptyString(record.id) ?? "",
    timestamp: firstString(attributes.timestamp, nestedAttributes?.timestamp),
    service: firstString(attributes.service, nestedAttributes?.service),
    status: firstString(attributes.status, nestedAttributes?.status),
    host: firstString(attributes.host, nestedAttributes?.host, nestedAttributes?.hostname),
    source: firstString(attributes.source, nestedAttributes?.source),
    traceId: firstString(
      attributes.trace_id,
      nestedAttributes?.trace_id,
      nestedAttributes?.["dd.trace_id"],
      nestedAttributes?.["trace.id"],
    ),
    spanId: firstString(
      attributes.span_id,
      nestedAttributes?.span_id,
      nestedAttributes?.["dd.span_id"],
      nestedAttributes?.["span.id"],
    ),
    tags: asStringArray(attributes.tags ?? nestedAttributes?.tags),
    message: message ? truncateWithMarker(message, DATADOG_LOG_MESSAGE_MAX_CHARS) : null,
  };
}

function summarizeTraceSpan(hit: unknown): DatadogTraceSpan | null {
  const record = asRecord(hit);
  const attributes = asRecord(record?.attributes);
  if (!record || !attributes) return null;

  const spanId = firstString(attributes.span_id, attributes.spanId);
  const traceId = firstString(attributes.trace_id, attributes.traceId);
  if (!spanId || !traceId) return null;

  const parentId = firstString(attributes.parent_id, attributes.parentId);
  const duration = asFiniteNumber(attributes.duration);
  const errorNumber = asFiniteNumber(attributes.error);
  const errorBoolean = typeof attributes.error === "boolean" ? attributes.error : null;
  return {
    spanId,
    parentId: parentId && parentId !== "0" ? parentId : null,
    traceId,
    name: firstString(attributes.name, attributes.operation_name),
    resourceName: firstString(attributes.resource_name, attributes.resourceName),
    service: firstString(attributes.service),
    status: firstString(attributes.status),
    type: firstString(attributes.type),
    startTimestamp: firstString(attributes.start_timestamp, attributes.startTime),
    endTimestamp: firstString(attributes.end_timestamp, attributes.endTime),
    duration,
    error: errorNumber ?? errorBoolean,
    tags: asStringArray(attributes.tags),
    env: firstString(attributes.env),
    host: firstString(attributes.host),
  };
}

function summarizeMetricsSeries(series: unknown): Record<string, unknown> | null {
  const record = asRecord(series);
  if (!record) return null;
  const pointlist = Array.isArray(record.pointlist) ? record.pointlist : [];
  const points = pointlist
    .slice(0, DATADOG_METRICS_POINTS_PER_SERIES_LIMIT)
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const timestamp = asFiniteNumber(point[0]);
      const value = asFiniteNumber(point[1]);
      return timestamp === null || value === null ? null : { timestamp, value };
    })
    .filter((point): point is { timestamp: number; value: number } => point !== null);
  return {
    metric: firstString(record.metric),
    displayName: firstString(record.display_name, record.displayName),
    scope: firstString(record.scope),
    expression: firstString(record.expression),
    points,
    truncatedPoints: pointlist.length > DATADOG_METRICS_POINTS_PER_SERIES_LIMIT,
  };
}

function summarizeMonitor(monitor: unknown): Record<string, unknown> | null {
  const record = asRecord(monitor);
  if (!record) return null;
  const id = typeof record.id === "number" || typeof record.id === "string" ? record.id : null;
  const name = firstString(record.name);
  if (id === null || !name) return null;
  const message = firstString(record.message);
  return {
    id,
    name,
    overallState: firstString(record.overall_state, record.overallState),
    messageExcerpt: message ? truncateWithMarker(message, DATADOG_MONITOR_MESSAGE_MAX_CHARS) : null,
  };
}

function traceSpanSortKey(span: DatadogTraceSpan): string {
  return `${span.startTimestamp ?? ""}:${span.spanId}`;
}

function buildTraceTree(spans: DatadogTraceSpan[]): {
  roots: DatadogTraceTreeNode[];
  truncated: boolean;
} {
  const spanMap = new Map(spans.map((span) => [span.spanId, span]));
  const childrenByParentId = new Map<string, DatadogTraceSpan[]>();
  for (const span of spans) {
    if (!span.parentId || !spanMap.has(span.parentId)) continue;
    const existing = childrenByParentId.get(span.parentId) ?? [];
    existing.push(span);
    childrenByParentId.set(span.parentId, existing);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => traceSpanSortKey(left).localeCompare(traceSpanSortKey(right)));
  }

  const roots = spans
    .filter((span) => !span.parentId || !spanMap.has(span.parentId))
    .sort((left, right) => traceSpanSortKey(left).localeCompare(traceSpanSortKey(right)));

  const state = {
    remainingNodes: DATADOG_TRACE_TREE_NODE_LIMIT,
    truncated: false,
  };

  const projectNode = (span: DatadogTraceSpan, depth: number): DatadogTraceTreeNode | null => {
    if (state.remainingNodes < 1) {
      state.truncated = true;
      return null;
    }
    state.remainingNodes -= 1;

    const childSpans = childrenByParentId.get(span.spanId) ?? [];
    let truncatedChildren = 0;
    const children: DatadogTraceTreeNode[] = [];

    if (depth >= DATADOG_TRACE_TREE_DEPTH_LIMIT) {
      truncatedChildren = childSpans.length;
      if (truncatedChildren > 0) state.truncated = true;
    } else {
      for (const childSpan of childSpans) {
        const childNode = projectNode(childSpan, depth + 1);
        if (childNode) {
          children.push(childNode);
        } else {
          truncatedChildren += 1;
        }
      }
    }

    return {
      ...span,
      children,
      ...(truncatedChildren > 0 ? { truncatedChildren } : {}),
    };
  };

  const projectedRoots: DatadogTraceTreeNode[] = [];
  for (const root of roots) {
    const node = projectNode(root, 1);
    if (node) {
      projectedRoots.push(node);
    } else {
      state.truncated = true;
    }
  }

  return {
    roots: projectedRoots,
    truncated: state.truncated,
  };
}

async function fetchDatadogTraceSpans(params: {
  credentials: Extract<DatadogCredentialState, { status: "ready" }>;
  traceId: string;
  lookback: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ spans: DatadogTraceSpan[]; truncated: boolean }> {
  const spans: DatadogTraceSpan[] = [];
  let cursor: string | undefined;
  let truncated = false;

  while (spans.length < DATADOG_TRACE_FETCH_SPAN_LIMIT) {
    const response = await datadogApiRequest<Record<string, unknown>>({
      site: params.credentials.site,
      apiKey: params.credentials.apiKey,
      appKey: params.credentials.appKey,
      path: "/api/v2/spans/events/search",
      body: {
        data: {
          type: "search_request",
          attributes: {
            filter: {
              query: `trace_id:${params.traceId}`,
              from: `now-${params.lookback}`,
              to: "now",
            },
            page: {
              limit: DATADOG_TRACE_PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            },
            sort: "timestamp",
          },
        },
      },
      fetchImpl: params.fetchImpl,
      signal: params.signal,
    });

    const pageItems = Array.isArray(response.data) ? response.data : [];
    for (const item of pageItems) {
      const span = summarizeTraceSpan(item);
      if (span) spans.push(span);
      if (spans.length >= DATADOG_TRACE_FETCH_SPAN_LIMIT) {
        truncated = true;
        break;
      }
    }

    const nextCursor = asNonEmptyString(response.meta?.page?.after);
    if (!nextCursor) break;
    if (spans.length >= DATADOG_TRACE_FETCH_SPAN_LIMIT) {
      truncated = true;
      break;
    }
    cursor = nextCursor;
  }

  return { spans, truncated };
}

export const buildDatadogSearchLogsDynamicToolSpec = buildDatadogDynamicToolSpec(
  DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME,
  "Search Datadog logs for matching events and return normalized log hits.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Datadog log search query." },
      from: { type: "string", description: "Lower bound for the search window." },
      to: { type: "string", description: "Upper bound for the search window." },
      cursor: {
        type: "string",
        description: "Datadog pagination cursor from a previous result. Requires fixed, non-relative from/to values.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: DATADOG_LOG_LIMIT_MAX,
        description: `Maximum number of log hits to return (1-${DATADOG_LOG_LIMIT_MAX}).`,
      },
    },
    required: ["query"],
  },
);

export const buildDatadogGetTraceDynamicToolSpec = buildDatadogDynamicToolSpec(
  DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME,
  "Fetch a Datadog trace by trace ID and return a normalized span tree.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      traceId: { type: "string", description: "Datadog trace ID to look up." },
      lookback: {
        type: "string",
        description: "Relative lookback window ending in m, h, or d. Defaults to 24h and is capped at 15d.",
      },
    },
    required: ["traceId"],
  },
);

export const buildDatadogQueryMetricsDynamicToolSpec = buildDatadogDynamicToolSpec(
  DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME,
  "Query Datadog metrics timeseries points and return bounded normalized series.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Datadog metrics query." },
      from: { type: "integer", description: "Unix seconds lower bound. Defaults to one hour ago." },
      to: { type: "integer", description: "Unix seconds upper bound. Defaults to now." },
    },
    required: ["query"],
  },
);

export const buildDatadogGetMonitorsDynamicToolSpec = buildDatadogDynamicToolSpec(
  DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME,
  "List Datadog monitors and return bounded monitor state summaries.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Optional monitor name filter." },
      tags: { type: "array", items: { type: "string" }, description: "Optional monitor tags filter." },
      groupStates: { type: "string", description: "Optional Datadog group_states filter." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: DATADOG_MONITOR_LIMIT_MAX,
        description: `Maximum monitors to return (1-${DATADOG_MONITOR_LIMIT_MAX}).`,
      },
    },
  },
);

export async function executeDatadogSearchLogsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  try {
    const credentials = requireDatadogCredentials(context.env);
    const input = normalizeSearchLogsInput(args);
    const fetchImpl = context.fetchImpl ?? fetch;
    const response = await datadogApiRequest<Record<string, unknown>>({
      site: credentials.site,
      apiKey: credentials.apiKey,
      appKey: credentials.appKey,
      path: "/api/v2/logs/events/search",
      body: {
        filter: {
          query: input.query,
          from: input.from ?? "now-15m",
          to: input.to ?? "now",
        },
        sort: "timestamp",
        page: {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
      fetchImpl,
      signal: context.signal,
    });

    const hits = (Array.isArray(response.data) ? response.data : [])
      .map((hit) => summarizeDatadogLogHit(hit))
      .filter((hit): hit is Record<string, unknown> => hit !== null);

    const nextCursor = asNonEmptyString(response.meta?.page?.after);
    return dynamicToolSuccessResult({
      query: input.query,
      from: input.from ?? "now-15m",
      to: input.to ?? "now",
      hits,
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch (error) {
    return datadogToolErrorResult(
      error,
      "Datadog search_datadog_logs was cancelled.",
      "Datadog search_datadog_logs failed",
    );
  }
}

export async function executeDatadogGetTraceDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  try {
    const credentials = requireDatadogCredentials(context.env);
    const input = normalizeGetTraceInput(args);
    const fetchImpl = context.fetchImpl ?? fetch;
    const { spans, truncated: fetchTruncated } = await fetchDatadogTraceSpans({
      credentials,
      traceId: input.traceId,
      lookback: input.lookback,
      fetchImpl,
      signal: context.signal,
    });

    if (spans.length === 0) {
      throw new DynamicToolError(`Datadog trace '${input.traceId}' was not found.`, "not_found", 404);
    }

    const { roots, truncated: treeTruncated } = buildTraceTree(spans);
    return dynamicToolSuccessResult({
      traceId: input.traceId,
      lookback: input.lookback,
      spanCount: spans.length,
      rootSpanCount: roots.length,
      truncated: fetchTruncated || treeTruncated,
      roots,
    });
  } catch (error) {
    return datadogToolErrorResult(
      error,
      "Datadog get_datadog_trace was cancelled.",
      "Datadog get_datadog_trace failed",
    );
  }
}

export async function executeDatadogQueryMetricsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  try {
    const credentials = requireDatadogCredentials(context.env);
    const input = normalizeMetricsInput(args);
    const fetchImpl = context.fetchImpl ?? fetch;
    const query = new URLSearchParams({
      query: input.query,
      from: String(input.from),
      to: String(input.to),
    });
    const response = await datadogRawApiRequest<DatadogMetricsApiResponse>({
      site: credentials.site,
      apiKey: credentials.apiKey,
      appKey: credentials.appKey,
      path: "/api/v1/query",
      query,
      fetchImpl,
      signal: context.signal,
    });
    if (asNonEmptyString(response.status) === "error") {
      throw new DynamicToolError(
        asNonEmptyString(response.error) ?? "Unknown Datadog metrics query error",
        "upstream_error",
      );
    }
    const rawSeries = Array.isArray(response.series) ? response.series : [];
    const series = rawSeries
      .slice(0, DATADOG_METRICS_SERIES_LIMIT)
      .map((item) => summarizeMetricsSeries(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    return dynamicToolSuccessResult({
      queryLength: input.query.length,
      from: input.from,
      to: input.to,
      series,
      truncated:
        rawSeries.length > DATADOG_METRICS_SERIES_LIMIT || series.some((item) => item.truncatedPoints === true),
    });
  } catch (error) {
    return datadogToolErrorResult(error, "Datadog query_metrics was cancelled.", "Datadog query_metrics failed");
  }
}

export async function executeDatadogGetMonitorsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  try {
    const credentials = requireDatadogCredentials(context.env);
    const input = normalizeMonitorsInput(args);
    const fetchImpl = context.fetchImpl ?? fetch;
    const query = new URLSearchParams();
    if (input.name) query.set("name", input.name);
    if (input.tags.length > 0) query.set("monitor_tags", input.tags.join(","));
    if (input.groupStates) query.set("group_states", input.groupStates);
    query.set("page", "0");
    query.set("page_size", String(input.limit + 1));
    const response = await datadogRawApiRequest<DatadogMonitorApiResponse[]>({
      site: credentials.site,
      apiKey: credentials.apiKey,
      appKey: credentials.appKey,
      path: "/api/v1/monitor",
      query,
      fetchImpl,
      signal: context.signal,
    });
    const rawMonitors = Array.isArray(response) ? response : [];
    const monitors = rawMonitors
      .slice(0, input.limit)
      .map((monitor) => summarizeMonitor(monitor))
      .filter((monitor): monitor is Record<string, unknown> => monitor !== null);
    return dynamicToolSuccessResult({
      filters: {
        name: input.name,
        tags: input.tags,
        groupStates: input.groupStates,
      },
      monitors,
      hasMore: rawMonitors.length > input.limit,
    });
  } catch (error) {
    return datadogToolErrorResult(error, "Datadog get_monitors was cancelled.", "Datadog get_monitors failed");
  }
}

export function redactDatadogDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | null | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  return {
    ...(typeof input.query === "string" ? { queryLength: input.query.length } : {}),
    ...(typeof input.from === "number" ? { from: input.from } : {}),
    ...(typeof input.to === "number" ? { to: input.to } : {}),
  };
}
