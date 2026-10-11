import { NOTION_ACCESS_TOKEN_ENV } from "../../../../shared/constants/sandbox-env.js";
import { asFiniteNumber } from "../../../../shared/utils/type-guards.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import { isCancellationError } from "./cancellation.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as dynamicToolFailureResult,
  createDynamicToolJsonSuccess as successResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
  isDynamicToolErrorCode,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const NOTION_DYNAMIC_TOOL_NAMESPACE = "notion";
export const NOTION_SEARCH_DYNAMIC_TOOL_NAME = "search";
export const NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME = "get_block_children";

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2026-03-11";
const NOTION_TIMEOUT_MS = 10_000;
const NOTION_SEARCH_PAGE_SIZE_MAX = 25;
const NOTION_BLOCK_CHILDREN_PAGE_SIZE_MAX = 100;
const NOTION_BLOCK_CHILDREN_DEPTH_LIMIT = 2;
const NOTION_RICH_TEXT_PREVIEW_MAX_CHARS = 280;
const NOTION_SEARCH_INPUT_FIELDS = ["query", "pageSize"] as const;
const NOTION_GET_BLOCK_CHILDREN_INPUT_FIELDS = ["blockId", "pageSize"] as const;

type NotionSearchInput = { query?: string; pageSize?: number };
type NotionGetBlockChildrenInput = { blockId: string; pageSize?: number };

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function requireToolObjectInput(
  args: unknown,
  toolName: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError(`Notion ${toolName} requires an object input.`, "invalid_input");
  }

  const extras = unknownFields(input, allowedFields);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Notion ${toolName} received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  return input;
}

function notionCredentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): string | null {
  return env[NOTION_ACCESS_TOKEN_ENV]?.trim() || null;
}

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  if (error.code === DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT || error.code === DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND) {
    return error.code;
  }
  if (error.status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (error.status === 401) return DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED;
  if (error.status === 403) return DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING;
  if (error.status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

async function notionApiRequest<T>(params: {
  accessToken: string;
  path: string;
  method: "GET" | "POST";
  query?: URLSearchParams;
  body?: unknown;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const url = new URL(`${NOTION_API_BASE_URL}${params.path}`);
  if (params.query) {
    url.search = params.query.toString();
  }

  const response = await params.fetchImpl(url, {
    method: params.method,
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
    signal: createTimeoutAwareSignal(params.signal, NOTION_TIMEOUT_MS),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch (error) {
    // A timeout fired mid-body-stream throws TimeoutError here; propagate it so the
    // outer handler maps it to `cancelled` instead of swallowing it into a null body.
    if (isCancellationError(error)) throw error;
    body = null;
  }

  if (!response.ok) {
    const typed = asRecord(body);
    const message = asNonEmptyString(typed?.message) ?? `Notion API request failed (${response.status})`;
    const rawCode = asNonEmptyString(typed?.code);
    const code = rawCode && isDynamicToolErrorCode(rawCode) ? rawCode : DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_HTTP_ERROR;
    throw new DynamicToolError(message, code, response.status);
  }

  return body as T;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = " [truncated]";
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function normalizeRichTextArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return truncateText(
    value
      .map((entry) => asNonEmptyString(asRecord(entry)?.plain_text) ?? "")
      .filter(Boolean)
      .join(""),
    NOTION_RICH_TEXT_PREVIEW_MAX_CHARS,
  );
}

function normalizePageTitle(result: Record<string, unknown>): string | null {
  const objectType = asNonEmptyString(result.object);
  if (objectType === "page") {
    const properties = asRecord(result.properties);
    if (!properties) return null;
    for (const property of Object.values(properties)) {
      const record = asRecord(property);
      if (asNonEmptyString(record?.type) === "title") {
        return normalizeRichTextArray(record?.title) || null;
      }
    }
  }
  if (objectType === "data_source") {
    return normalizeRichTextArray(result.title) || null;
  }
  return null;
}

function normalizeSearchResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    object: asNonEmptyString(result.object) ?? "unknown",
    id: asNonEmptyString(result.id) ?? "",
    title: normalizePageTitle(result),
    url: asString(result.url),
    publicUrl: asString(result.public_url),
    inTrash: asBoolean(result.in_trash),
    lastEditedTime: asString(result.last_edited_time),
  };
}

function normalizeBlock(block: Record<string, unknown>): Record<string, unknown> {
  const type = asNonEmptyString(block.type) ?? "unsupported";
  const typePayload = asRecord(block[type]);
  return {
    id: asNonEmptyString(block.id) ?? "",
    type,
    hasChildren: asBoolean(block.has_children) ?? false,
    inTrash: asBoolean(block.in_trash),
    text:
      normalizeRichTextArray(typePayload?.rich_text) ||
      normalizeRichTextArray(typePayload?.title) ||
      asNonEmptyString(typePayload?.language) ||
      null,
  };
}

function normalizeSearchInput(args: unknown): NotionSearchInput {
  const input = requireToolObjectInput(args, "search", NOTION_SEARCH_INPUT_FIELDS);
  const query = input.query === undefined ? undefined : (asString(input.query)?.trim() ?? "");
  const pageSize = input.pageSize === undefined ? undefined : asFiniteNumber(input.pageSize);
  if (input.pageSize !== undefined && (!pageSize || pageSize < 1 || pageSize > NOTION_SEARCH_PAGE_SIZE_MAX)) {
    throw new DynamicToolError(
      `Notion search requires 'pageSize' to be between 1 and ${NOTION_SEARCH_PAGE_SIZE_MAX}.`,
      "invalid_input",
    );
  }
  return { ...(query !== undefined ? { query } : {}), ...(pageSize ? { pageSize } : {}) };
}

function normalizeGetBlockChildrenInput(args: unknown): NotionGetBlockChildrenInput {
  const input = requireToolObjectInput(args, "get_block_children", NOTION_GET_BLOCK_CHILDREN_INPUT_FIELDS);
  const blockId = asNonEmptyString(input.blockId);
  const pageSize = input.pageSize === undefined ? undefined : asFiniteNumber(input.pageSize);
  if (!blockId) {
    throw new DynamicToolError("Notion get_block_children requires a non-empty 'blockId' string.", "invalid_input");
  }
  if (input.pageSize !== undefined && (!pageSize || pageSize < 1 || pageSize > NOTION_BLOCK_CHILDREN_PAGE_SIZE_MAX)) {
    throw new DynamicToolError(
      `Notion get_block_children requires 'pageSize' to be between 1 and ${NOTION_BLOCK_CHILDREN_PAGE_SIZE_MAX}.`,
      "invalid_input",
    );
  }
  return { blockId, ...(pageSize ? { pageSize } : {}) };
}

async function fetchBlockChildrenTree(params: {
  accessToken: string;
  blockId: string;
  pageSize: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  depth: number;
}): Promise<Record<string, unknown>[]> {
  const normalizedResults: Record<string, unknown>[] = [];
  let nextCursor: string | null | undefined;

  do {
    const query = new URLSearchParams({ page_size: String(params.pageSize) });
    if (nextCursor) {
      query.set("start_cursor", nextCursor);
    }

    const response = await notionApiRequest<{
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>({
      accessToken: params.accessToken,
      path: `/blocks/${params.blockId}/children`,
      method: "GET",
      query,
      fetchImpl: params.fetchImpl,
      signal: params.signal,
    });

    const results = Array.isArray(response.results) ? response.results : [];
    for (const result of results) {
      const block = asRecord(result);
      if (!block) continue;
      const normalized = normalizeBlock(block);
      const childBlockId = asNonEmptyString(block.id);
      if (
        childBlockId &&
        (asBoolean(block.has_children) ?? false) &&
        params.depth < NOTION_BLOCK_CHILDREN_DEPTH_LIMIT
      ) {
        normalized.children = await fetchBlockChildrenTree({
          ...params,
          blockId: childBlockId,
          depth: params.depth + 1,
        });
      }
      normalizedResults.push(normalized);
    }

    nextCursor = asString(response.next_cursor);
    if (!(asBoolean(response.has_more) ?? false)) {
      break;
    }
  } while (nextCursor);

  return normalizedResults;
}

function buildNotionDynamicToolSpec(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[] {
  return (env) =>
    notionCredentialsFromEnv(env)
      ? [
          {
            namespace: NOTION_DYNAMIC_TOOL_NAMESPACE,
            name,
            description,
            inputSchema,
          },
        ]
      : [];
}

async function executeNotionTool<T>(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
  handler: (params: {
    accessToken: string;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    args: unknown;
  }) => Promise<T>,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = notionCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Notion credentials are not available for this session.");
  }

  try {
    return successResult(
      await handler({
        accessToken,
        fetchImpl: context.fetchImpl ?? fetch,
        signal: context.signal,
        args,
      }),
    );
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Notion tool call was cancelled.");
    }
    if (error instanceof DynamicToolError) {
      return dynamicToolFailureResult(mapDynamicToolErrorCode(error), error.message);
    }
    return dynamicToolFailureResult("upstream_error", `Notion tool call failed: ${String(error)}`);
  }
}

export const buildNotionSearchDynamicToolSpec = buildNotionDynamicToolSpec(
  NOTION_SEARCH_DYNAMIC_TOOL_NAME,
  "Search shared Notion pages by title.",
  {
    type: "object",
    properties: {
      query: { type: "string" },
      pageSize: { type: "number", minimum: 1, maximum: NOTION_SEARCH_PAGE_SIZE_MAX },
    },
    additionalProperties: false,
  },
);

export const buildNotionGetBlockChildrenDynamicToolSpec = buildNotionDynamicToolSpec(
  NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME,
  "Read child blocks for a Notion page or block, with depth-capped nested children.",
  {
    type: "object",
    required: ["blockId"],
    properties: {
      blockId: { type: "string", minLength: 1 },
      pageSize: { type: "number", minimum: 1, maximum: NOTION_BLOCK_CHILDREN_PAGE_SIZE_MAX },
    },
    additionalProperties: false,
  },
);

export async function executeNotionSearchDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeNotionTool(args, context, async ({ accessToken, fetchImpl, signal, args: rawArgs }) => {
    const input = normalizeSearchInput(rawArgs);
    const response = await notionApiRequest<{
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>({
      accessToken,
      path: "/search",
      method: "POST",
      body: {
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.pageSize ? { page_size: input.pageSize } : {}),
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      },
      fetchImpl,
      signal,
    });
    const results = Array.isArray(response.results) ? response.results : [];
    return {
      results: results.map((result) => normalizeSearchResult(asRecord(result) ?? {})),
      hasMore: asBoolean(response.has_more) ?? false,
      nextCursor: asString(response.next_cursor),
    };
  });
}

export async function executeNotionGetBlockChildrenDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeNotionTool(args, context, async ({ accessToken, fetchImpl, signal, args: rawArgs }) => {
    const input = normalizeGetBlockChildrenInput(rawArgs);
    return {
      blockId: input.blockId,
      children: await fetchBlockChildrenTree({
        accessToken,
        blockId: input.blockId,
        pageSize: input.pageSize ?? NOTION_BLOCK_CHILDREN_PAGE_SIZE_MAX,
        fetchImpl,
        signal,
        depth: 1,
      }),
    };
  });
}
