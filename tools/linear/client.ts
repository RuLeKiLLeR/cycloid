import { z } from "zod";

import { notifyAgentCreatedTicketKey } from "../../apps/sandbox-bridge/src/services/agent-ticket-key-notify.js";
import type { DynamicToolErrorCode } from "../../apps/sandbox-bridge/src/services/dynamic-tool-results.js";
import {
  buildDynamicToolErrorResult as buildSharedDynamicToolErrorResult,
  createDynamicToolFailure as dynamicToolFailureResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
  mapDynamicToolErrorCode as mapSharedDynamicToolErrorCode,
  truncateWithMarker,
} from "../../apps/sandbox-bridge/src/services/dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";
import { createTimeoutAwareSignal } from "../../apps/sandbox-bridge/src/utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../../apps/sandbox-bridge/src/utils/dynamic-tool-helpers.js";
import { LINEAR_ACCESS_TOKEN_ENV } from "../../shared/constants/sandbox-env.js";
import type { ToolMethods } from "../../shared/tools-runtime/index.js";
import { secret } from "../../shared/tools-runtime/index.js";
import { asFiniteNumber } from "../../shared/utils/type-guards.js";

export const LINEAR_DYNAMIC_TOOL_NAMESPACE = "linear";
export const LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME = "create_issue";
export const LINEAR_GET_ISSUE_DYNAMIC_TOOL_NAME = "get_issue";
export const LINEAR_LIST_ISSUE_STATUSES_DYNAMIC_TOOL_NAME = "list_issue_statuses";
export const LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME = "update_issue";
export const LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME = "list_comments";
export const LINEAR_CREATE_COMMENT_DYNAMIC_TOOL_NAME = "create_comment";
export const LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME = "search_issues";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 10_000;
const LINEAR_ISSUE_TITLE_MAX_CHARS = 255;
const LINEAR_ISSUE_DESCRIPTION_MAX_CHARS = 4 * 1024;
const LINEAR_COMMENT_BODY_MAX_CHARS = 4 * 1024;
const LINEAR_COMMENT_RESULT_BODY_MAX_CHARS = 2 * 1024;
const LINEAR_COMMENT_LIMIT_MAX = 50;
const LINEAR_SEARCH_ISSUES_LIMIT_MAX = 25;
type LinearGraphQlErrorResponse = {
  message?: unknown;
  extensions?: { code?: unknown } | null;
};

type LinearGraphQlResponse<T> = {
  data?: T | null;
  errors?: LinearGraphQlErrorResponse[] | null;
};

type LinearIssueResponse = {
  issue?: {
    id?: unknown;
    identifier?: unknown;
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    url?: unknown;
    state?: { id?: unknown; name?: unknown } | null;
    assignee?: { id?: unknown; name?: unknown } | null;
    team?: { id?: unknown; key?: unknown } | null;
  } | null;
};

type LinearIssueCreateResponse = {
  issueCreate?: {
    success?: unknown;
    issue?: NonNullable<LinearIssueResponse["issue"]> | null;
  } | null;
};

type LinearIssueUpdateResponse = {
  issueUpdate?: {
    success?: unknown;
    issue?: NonNullable<LinearIssueResponse["issue"]> | null;
  } | null;
};

type LinearWorkflowStatesResponse = {
  team?: {
    states?: {
      nodes?: Array<{
        id?: unknown;
        name?: unknown;
        type?: unknown;
        position?: unknown;
      } | null> | null;
    } | null;
  } | null;
};

type LinearCommentResponse = {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  user?: { id?: unknown; name?: unknown; displayName?: unknown } | null;
};

type LinearCommentsResponse = {
  issue?: {
    comments?: {
      nodes?: Array<LinearCommentResponse | null> | null;
      pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
    } | null;
  } | null;
};

type LinearCommentCreateResponse = {
  commentCreate?: {
    success?: unknown;
    comment?: LinearCommentResponse | null;
  } | null;
};

type LinearSearchIssuesResponse = {
  searchIssues?: {
    nodes?: Array<NonNullable<LinearIssueResponse["issue"]> | null> | null;
  } | null;
};

type LinearCreateIssueInput = {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
  stateId?: string;
  assigneeId?: string;
};
type LinearUpdateIssueInput = {
  issueId: string;
  stateId?: string;
  title?: string;
  description?: string;
  priority?: number;
  assigneeId?: string;
};
type LinearGetIssueInput = { id?: string; identifier?: string };
type LinearListIssueStatusesInput = { teamId: string };
type LinearListCommentsInput = { issueId: string; cursor?: string; limit: number };
type LinearCreateCommentInput = { issueId: string; body: string };
type LinearSearchIssuesInput = {
  query: string;
  teamId?: string;
  stateType?: string;
  includeArchived: boolean;
  limit: number;
};

function hasOwnField(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function normalizeOptionalStringField(
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string | undefined {
  const value = asNonEmptyString(input[field]);
  if (!hasOwnField(input, field) || value) return value ?? undefined;
  throw new DynamicToolError(`Linear ${toolName} '${field}' must be a non-empty string.`, "invalid_input");
}

function normalizeOptionalPriorityField(input: Record<string, unknown>, toolName: string): number | undefined {
  const priority = input.priority === undefined ? null : asFiniteNumber(input.priority);
  if (input.priority !== undefined && priority === null) {
    throw new DynamicToolError(`Linear ${toolName} 'priority' must be a finite number.`, "invalid_input");
  }
  if (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 4)) {
    throw new DynamicToolError(`Linear ${toolName} 'priority' must be an integer between 0 and 4.`, "invalid_input");
  }
  return priority ?? undefined;
}

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  return mapSharedDynamicToolErrorCode(error, {
    passthrough: [DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND],
    statusCodes: {
      401: DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED,
      403: DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING,
      404: DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
    },
  });
}

function linearCredentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null {
  try {
    return secret(LINEAR_ACCESS_TOKEN_ENV, env).trim() || null;
  } catch {
    return null;
  }
}

async function linearGraphQlRequest<T>(params: {
  accessToken: string;
  query: string;
  variables: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await params.fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: params.query,
      variables: params.variables,
    }),
    signal: createTimeoutAwareSignal(params.signal, LINEAR_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DynamicToolError(
      `Linear API request failed (${response.status})`,
      "upstream_http_error",
      response.status,
    );
  }

  const body = (await response.json()) as LinearGraphQlResponse<T>;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length > 0) {
    const message = errors.map((error) => asNonEmptyString(error.message) ?? "Unknown Linear GraphQL error").join("; ");
    const authCode = errors.find((error) => {
      const code = asNonEmptyString(error.extensions?.code);
      return code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN";
    });
    if (authCode) {
      const code = asNonEmptyString(authCode.extensions?.code);
      throw new DynamicToolError(
        message,
        DYNAMIC_TOOL_ERROR_CODES.GRAPHQL_ERROR,
        code === "AUTHENTICATION_ERROR" ? 401 : 403,
      );
    }
    throw new DynamicToolError(message, DYNAMIC_TOOL_ERROR_CODES.GRAPHQL_ERROR);
  }

  if (!body.data) {
    throw new DynamicToolError("Linear GraphQL response was missing data.", DYNAMIC_TOOL_ERROR_CODES.GRAPHQL_ERROR);
  }
  return body.data;
}

function buildLinearDynamicToolSpec(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[] {
  return (env) =>
    linearCredentialsFromEnv(env)
      ? [
          {
            namespace: LINEAR_DYNAMIC_TOOL_NAMESPACE,
            name,
            description,
            inputSchema,
          },
        ]
      : [];
}

function normalizeGetIssueInput(args: unknown): LinearGetIssueInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear get_issue requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["id", "identifier"]);
  if (extras.length > 0) {
    throw new DynamicToolError(`Linear get_issue received unsupported fields: ${extras.join(", ")}.`, "invalid_input");
  }
  const id = asNonEmptyString(input.id);
  const identifier = asNonEmptyString(input.identifier);
  if ((id && identifier) || (!id && !identifier)) {
    throw new DynamicToolError("Linear get_issue requires exactly one of 'id' or 'identifier'.", "invalid_input");
  }
  return { ...(id ? { id } : {}), ...(identifier ? { identifier } : {}) };
}

function normalizeCreateIssueInput(args: unknown): LinearCreateIssueInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear create_issue requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["teamId", "title", "description", "priority", "stateId", "assigneeId"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear create_issue received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const teamId = asNonEmptyString(input.teamId);
  if (!teamId) {
    throw new DynamicToolError("Linear create_issue requires a non-empty 'teamId' string.", "invalid_input");
  }
  const title = asNonEmptyString(input.title);
  if (!title) {
    throw new DynamicToolError("Linear create_issue requires a non-empty 'title' string.", "invalid_input");
  }
  const description = asNonEmptyString(input.description);
  const priority = normalizeOptionalPriorityField(input, LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME);
  const stateId = normalizeOptionalStringField(input, "stateId", LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME);
  const assigneeId = normalizeOptionalStringField(input, "assigneeId", LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME);

  return {
    teamId,
    title: truncateWithMarker(title, LINEAR_ISSUE_TITLE_MAX_CHARS, " [truncated]"),
    ...(description ? { description: truncateWithMarker(description, LINEAR_ISSUE_DESCRIPTION_MAX_CHARS) } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(stateId ? { stateId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
  };
}

function normalizeUpdateIssueInput(args: unknown): LinearUpdateIssueInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear update_issue requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["issueId", "stateId", "title", "description", "priority", "assigneeId"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear update_issue received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const issueId = asNonEmptyString(input.issueId);
  if (!issueId) {
    throw new DynamicToolError("Linear update_issue requires a non-empty 'issueId' string.", "invalid_input");
  }
  const title = hasOwnField(input, "title") ? asNonEmptyString(input.title) : undefined;
  if (hasOwnField(input, "title") && !title) {
    throw new DynamicToolError("Linear update_issue 'title' must be a non-empty string.", "invalid_input");
  }
  const description = hasOwnField(input, "description") ? asNonEmptyString(input.description) : undefined;
  if (hasOwnField(input, "description") && !description) {
    throw new DynamicToolError("Linear update_issue 'description' must be a non-empty string.", "invalid_input");
  }
  const priority = normalizeOptionalPriorityField(input, LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME);
  const stateId = normalizeOptionalStringField(input, "stateId", LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME);
  const assigneeId = normalizeOptionalStringField(input, "assigneeId", LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME);

  return {
    issueId,
    ...(stateId ? { stateId } : {}),
    ...(title ? { title: truncateWithMarker(title, LINEAR_ISSUE_TITLE_MAX_CHARS, " [truncated]") } : {}),
    ...(description ? { description: truncateWithMarker(description, LINEAR_ISSUE_DESCRIPTION_MAX_CHARS) } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(assigneeId ? { assigneeId } : {}),
  };
}

export function redactLinearDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | undefined {
  const input = asRecord(args);
  if (!input) return undefined;

  const teamId = asNonEmptyString(input.teamId);
  const stateId = asNonEmptyString(input.stateId);
  const assigneeId = asNonEmptyString(input.assigneeId);
  const title = asNonEmptyString(input.title);
  const description = asNonEmptyString(input.description);
  const body = asNonEmptyString(input.body);
  const query = asNonEmptyString(input.query);
  const priority = asFiniteNumber(input.priority);

  return {
    ...(teamId ? { teamId } : {}),
    ...(stateId ? { stateId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(priority !== null ? { priority } : {}),
    ...(title ? { titleLength: title.length } : {}),
    ...(description ? { descriptionLength: description.length } : {}),
    ...(body ? { bodyLength: body.length } : {}),
    ...(query ? { queryLength: query.length } : {}),
    ...(title ? { titleRedacted: true } : {}),
    ...(description ? { descriptionRedacted: true } : {}),
    ...(body ? { bodyRedacted: true } : {}),
    ...(query ? { queryRedacted: true } : {}),
  };
}

function normalizeListIssueStatusesInput(args: unknown): LinearListIssueStatusesInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear list_issue_statuses requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["teamId"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear list_issue_statuses received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const teamId = asNonEmptyString(input.teamId);
  if (!teamId) {
    throw new DynamicToolError("Linear list_issue_statuses requires a non-empty 'teamId' string.", "invalid_input");
  }
  return { teamId };
}

function normalizeListCommentsInput(args: unknown): LinearListCommentsInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear list_comments requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["issueId", "cursor", "limit"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear list_comments received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const issueId = asNonEmptyString(input.issueId);
  if (!issueId) {
    throw new DynamicToolError("Linear list_comments requires a non-empty 'issueId' string.", "invalid_input");
  }
  const cursor = normalizeOptionalStringField(input, "cursor", LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME);
  const limit = input.limit === undefined ? LINEAR_COMMENT_LIMIT_MAX : asFiniteNumber(input.limit);
  if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > LINEAR_COMMENT_LIMIT_MAX) {
    throw new DynamicToolError(
      `Linear list_comments requires 'limit' to be an integer between 1 and ${LINEAR_COMMENT_LIMIT_MAX}.`,
      "invalid_input",
    );
  }
  return { issueId, ...(cursor ? { cursor } : {}), limit };
}

function normalizeCreateCommentInput(args: unknown): LinearCreateCommentInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear create_comment requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["issueId", "body"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear create_comment received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const issueId = asNonEmptyString(input.issueId);
  if (!issueId) {
    throw new DynamicToolError("Linear create_comment requires a non-empty 'issueId' string.", "invalid_input");
  }
  const body = asNonEmptyString(input.body);
  if (!body) {
    throw new DynamicToolError("Linear create_comment requires a non-empty 'body' string.", "invalid_input");
  }
  return { issueId, body: truncateWithMarker(body, LINEAR_COMMENT_BODY_MAX_CHARS) };
}

function normalizeSearchIssuesInput(args: unknown): LinearSearchIssuesInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Linear search_issues requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["query", "teamId", "stateType", "includeArchived", "limit"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Linear search_issues received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const query = asNonEmptyString(input.query);
  if (!query) {
    throw new DynamicToolError("Linear search_issues requires a non-empty 'query' string.", "invalid_input");
  }
  const teamId = normalizeOptionalStringField(input, "teamId", LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME);
  const stateType = normalizeOptionalStringField(input, "stateType", LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME);
  const includeArchived = input.includeArchived === undefined ? false : input.includeArchived;
  if (typeof includeArchived !== "boolean") {
    throw new DynamicToolError("Linear search_issues requires 'includeArchived' to be a boolean.", "invalid_input");
  }
  const limit = input.limit === undefined ? 10 : asFiniteNumber(input.limit);
  if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > LINEAR_SEARCH_ISSUES_LIMIT_MAX) {
    throw new DynamicToolError(
      `Linear search_issues requires 'limit' to be an integer between 1 and ${LINEAR_SEARCH_ISSUES_LIMIT_MAX}.`,
      "invalid_input",
    );
  }
  return { query, ...(teamId ? { teamId } : {}), ...(stateType ? { stateType } : {}), includeArchived, limit };
}

function summarizeIssue(issue: NonNullable<LinearIssueResponse["issue"]>): Record<string, unknown> {
  const rawDescription = typeof issue.description === "string" ? issue.description : null;
  return {
    id: asNonEmptyString(issue.id) ?? "",
    identifier: asNonEmptyString(issue.identifier) ?? "",
    title: asNonEmptyString(issue.title) ?? "Untitled Linear issue",
    state: {
      id: asNonEmptyString(issue.state?.id) ?? null,
      name: asNonEmptyString(issue.state?.name) ?? null,
    },
    assignee: issue.assignee
      ? {
          id: asNonEmptyString(issue.assignee.id) ?? null,
          name: asNonEmptyString(issue.assignee.name) ?? null,
        }
      : null,
    priority: asFiniteNumber(issue.priority),
    team: {
      id: asNonEmptyString(issue.team?.id) ?? null,
      key: asNonEmptyString(issue.team?.key) ?? null,
    },
    url: asNonEmptyString(issue.url) ?? null,
    description: rawDescription ? truncateWithMarker(rawDescription, LINEAR_ISSUE_DESCRIPTION_MAX_CHARS) : null,
  };
}

function summarizeComment(comment: LinearCommentResponse | null): Record<string, unknown> | null {
  if (!comment) return null;
  const id = asNonEmptyString(comment.id);
  const body = asNonEmptyString(comment.body);
  if (!id || !body) return null;
  const truncated = body.length > LINEAR_COMMENT_RESULT_BODY_MAX_CHARS;
  return {
    id,
    body: truncateWithMarker(body, LINEAR_COMMENT_RESULT_BODY_MAX_CHARS),
    truncated,
    createdAt: asNonEmptyString(comment.createdAt) ?? null,
    author: comment.user
      ? {
          id: asNonEmptyString(comment.user.id) ?? null,
          name: asNonEmptyString(comment.user.displayName) ?? asNonEmptyString(comment.user.name) ?? null,
        }
      : null,
  };
}

function issueNotFoundMessage(input: LinearGetIssueInput): string {
  if ("identifier" in input && input.identifier) return `Linear issue '${input.identifier}' was not found.`;
  return `Linear issue '${input.id}' was not found.`;
}

function buildLinearSuccessResult(payload: Record<string, unknown>): FirstPartyDynamicToolCallResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(payload, null, 2) }],
  };
}

function buildDynamicToolErrorResult(toolName: string, error: unknown): FirstPartyDynamicToolCallResult {
  return buildSharedDynamicToolErrorResult({
    error,
    cancelledMessage: `Linear ${toolName} was cancelled.`,
    mapErrorCode: mapDynamicToolErrorCode,
    unexpectedMessage: () => `Linear ${toolName} failed due to an unexpected upstream error.`,
  });
}

export const buildLinearCreateIssueDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME,
  "Create a Linear issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["teamId", "title"],
    properties: {
      teamId: { type: "string", description: "Linear team UUID." },
      title: { type: "string", description: "Issue title." },
      description: { type: "string", description: "Issue description." },
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "Linear issue priority: 0 for no priority, 1 urgent, 2 high, 3 medium, 4 low.",
      },
      stateId: { type: "string", description: "Initial Linear workflow state UUID." },
      assigneeId: { type: "string", description: "Linear user UUID for the issue assignee." },
    },
  },
);

export const buildLinearGetIssueDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_GET_ISSUE_DYNAMIC_TOOL_NAME,
  "Read a Linear issue by ID or identifier.",
  {
    type: "object",
    additionalProperties: false,
    oneOf: [{ required: ["id"] }, { required: ["identifier"] }],
    properties: {
      id: { type: "string", description: "Linear issue UUID or shorthand issue identifier such as ENG-123." },
      identifier: { type: "string", description: "Linear shorthand issue identifier such as ENG-123." },
    },
  },
);

export const buildLinearListIssueStatusesDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_LIST_ISSUE_STATUSES_DYNAMIC_TOOL_NAME,
  "List workflow states for a Linear team.",
  {
    type: "object",
    additionalProperties: false,
    required: ["teamId"],
    properties: {
      teamId: { type: "string", description: "Linear team UUID." },
    },
  },
);

export const buildLinearUpdateIssueDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME,
  "Update a Linear issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["issueId"],
    properties: {
      issueId: { type: "string", description: "Linear issue UUID." },
      stateId: { type: "string", description: "Linear workflow state UUID." },
      title: { type: "string", description: "Issue title." },
      description: { type: "string", description: "Issue description." },
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "Linear issue priority: 0 for no priority, 1 urgent, 2 high, 3 medium, 4 low.",
      },
      assigneeId: { type: "string", description: "Linear user UUID for the issue assignee." },
    },
  },
);

export const buildLinearListCommentsDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME,
  "List comments on a Linear issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["issueId"],
    properties: {
      issueId: { type: "string", description: "Linear issue UUID." },
      cursor: { type: "string", description: "Optional pagination cursor." },
      limit: { type: "integer", minimum: 1, maximum: LINEAR_COMMENT_LIMIT_MAX },
    },
  },
);

export const buildLinearCreateCommentDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_CREATE_COMMENT_DYNAMIC_TOOL_NAME,
  "Create a comment on a Linear issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["issueId", "body"],
    properties: {
      issueId: { type: "string", description: "Linear issue UUID." },
      body: { type: "string", description: "Comment body." },
    },
  },
);

export const buildLinearSearchIssuesDynamicToolSpec = buildLinearDynamicToolSpec(
  LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
  "Search Linear issues by text.",
  {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Linear search term." },
      teamId: { type: "string", description: "Optional Linear team UUID filter." },
      stateType: { type: "string", description: "Optional workflow state type filter." },
      includeArchived: { type: "boolean", description: "Whether to include archived issues. Defaults false." },
      limit: { type: "integer", minimum: 1, maximum: LINEAR_SEARCH_ISSUES_LIMIT_MAX },
    },
  },
);

export async function executeLinearCreateIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearCreateIssueInput;
  try {
    input = normalizeCreateIssueInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const data = await linearGraphQlRequest<LinearIssueCreateResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        mutation LinearCreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              priority
              url
              state {
                id
                name
              }
              assignee {
                id
                name
              }
              team {
                id
                key
              }
            }
          }
        }
      `,
      variables: { input },
    });
    const result = data.issueCreate;
    if (result?.success !== true || !result.issue) {
      throw new DynamicToolError("Linear create_issue did not return a created issue.", "graphql_error");
    }
    // Feed the agent-created identifier into the session so the PR title carries
    // it. Isolated and best-effort: the issue already exists, so a notify throw
    // must never turn this into a tool error (which would risk a duplicate issue).
    const identifier = asNonEmptyString(result.issue.identifier);
    if (identifier) {
      try {
        await notifyAgentCreatedTicketKey(identifier, "linear", context);
      } catch {
        // Swallow: the created issue is still returned below.
      }
    }
    return buildLinearSuccessResult(summarizeIssue(result.issue));
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeLinearGetIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearGetIssueInput;
  try {
    input = normalizeGetIssueInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_GET_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const issueRef = input.id ?? input.identifier!;
    const data = await linearGraphQlRequest<LinearIssueResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        query LinearGetIssue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            priority
            url
            state {
              id
              name
            }
            assignee {
              id
              name
            }
            team {
              id
              key
            }
          }
        }
      `,
      variables: { id: issueRef },
    });
    const issue = data.issue;
    if (!issue) {
      throw new DynamicToolError(issueNotFoundMessage(input), "not_found", 404);
    }
    return buildLinearSuccessResult(summarizeIssue(issue));
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_GET_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeLinearUpdateIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearUpdateIssueInput;
  try {
    input = normalizeUpdateIssueInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const { issueId, ...updateInput } = input;
    const data = await linearGraphQlRequest<LinearIssueUpdateResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        mutation LinearUpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $issueId, input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              priority
              url
              state {
                id
                name
              }
              assignee {
                id
                name
              }
              team {
                id
                key
              }
            }
          }
        }
      `,
      variables: {
        issueId,
        input: updateInput,
      },
    });
    const result = data.issueUpdate;
    if (result?.success !== true || !result.issue) {
      throw new DynamicToolError("Linear update_issue did not return an updated issue.", "graphql_error");
    }
    return buildLinearSuccessResult(summarizeIssue(result.issue));
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}

function buildLinearAmbiguousCommentCreateResult(): FirstPartyDynamicToolCallResult {
  return dynamicToolFailureResult(
    "upstream_error",
    "Linear create_comment timed out after sending the request; it is unknown whether the comment was posted. Do not blindly retry. Read the issue comments first.",
  );
}

export async function executeLinearListCommentsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearListCommentsInput;
  try {
    input = normalizeListCommentsInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const data = await linearGraphQlRequest<LinearCommentsResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        query LinearIssueComments($issueId: String!, $first: Int!, $cursor: String) {
          issue(id: $issueId) {
            comments(first: $first, after: $cursor) {
              nodes {
                id
                body
                createdAt
                user {
                  id
                  name
                  displayName
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      variables: { issueId: input.issueId, first: input.limit, cursor: input.cursor ?? null },
    });
    if (!data.issue) {
      throw new DynamicToolError(`Linear issue '${input.issueId}' was not found.`, "not_found", 404);
    }
    const comments = (data.issue.comments?.nodes ?? [])
      .map((comment) => summarizeComment(comment))
      .filter((comment): comment is Record<string, unknown> => comment !== null);
    const hasMore = data.issue.comments?.pageInfo?.hasNextPage === true;
    const nextCursor = hasMore ? asNonEmptyString(data.issue.comments?.pageInfo?.endCursor) : null;
    return buildLinearSuccessResult({
      issueId: input.issueId,
      comments,
      truncated: comments.some((comment) => comment.truncated === true),
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeLinearCreateCommentDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearCreateCommentInput;
  try {
    input = normalizeCreateCommentInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_CREATE_COMMENT_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const data = await linearGraphQlRequest<LinearCommentCreateResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        mutation LinearCreateComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              id
              body
              createdAt
              user {
                id
                name
                displayName
              }
            }
          }
        }
      `,
      variables: { input },
    });
    const result = data.commentCreate;
    if (result?.success !== true || !result.comment) {
      throw new DynamicToolError("Linear create_comment did not return a created comment.", "graphql_error");
    }
    return buildLinearSuccessResult({
      issueId: input.issueId,
      comment: summarizeComment(result.comment),
    });
  } catch (error) {
    if (
      error instanceof DOMException ||
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      return buildLinearAmbiguousCommentCreateResult();
    }
    return buildDynamicToolErrorResult(LINEAR_CREATE_COMMENT_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeLinearSearchIssuesDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearSearchIssuesInput;
  try {
    input = normalizeSearchIssuesInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const filter: Record<string, unknown> = {};
    if (input.teamId) filter.team = { id: { eq: input.teamId } };
    if (input.stateType) filter.state = { type: { eq: input.stateType } };
    const data = await linearGraphQlRequest<LinearSearchIssuesResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        query LinearSearchIssues($term: String!, $first: Int!, $includeArchived: Boolean!, $filter: IssueFilter) {
          searchIssues(term: $term, first: $first, includeArchived: $includeArchived, filter: $filter) {
            nodes {
              id
              identifier
              title
              description
              priority
              url
              state {
                id
                name
              }
              assignee {
                id
                name
              }
              team {
                id
                key
              }
            }
          }
        }
      `,
      variables: {
        term: input.query,
        first: input.limit,
        includeArchived: input.includeArchived,
        filter: Object.keys(filter).length > 0 ? filter : null,
      },
    });
    const issues = (data.searchIssues?.nodes ?? []).flatMap((issue) => (issue ? [summarizeIssue(issue)] : []));
    return buildLinearSuccessResult({
      query: input.query,
      includeArchived: input.includeArchived,
      issues,
    });
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeLinearListIssueStatusesDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const accessToken = linearCredentialsFromEnv(context.env);
  if (!accessToken) {
    return dynamicToolFailureResult("not_connected", "Linear credentials are not configured for this session.");
  }

  let input: LinearListIssueStatusesInput;
  try {
    input = normalizeListIssueStatusesInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_LIST_ISSUE_STATUSES_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const data = await linearGraphQlRequest<LinearWorkflowStatesResponse>({
      accessToken,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      query: `
        query LinearWorkflowStates($teamId: String!) {
          team(id: $teamId) {
            states(first: 250) {
              nodes {
                id
                name
                type
                position
              }
            }
          }
        }
      `,
      variables: { teamId: input.teamId },
    });

    if (!data.team) {
      return dynamicToolFailureResult("not_found", `Linear team not found for id ${JSON.stringify(input.teamId)}.`);
    }
    const statuses = (data.team?.states?.nodes ?? [])
      .flatMap((state) => {
        if (!state) return [];
        const id = asNonEmptyString(state.id);
        const name = asNonEmptyString(state.name);
        const type = asNonEmptyString(state.type);
        const position = asFiniteNumber(state.position);
        if (!id || !name || !type || position === null) return [];
        return [{ id, name, type, position }];
      })
      .sort((a, b) => a.position - b.position);

    return buildLinearSuccessResult({ teamId: input.teamId, statuses });
  } catch (error) {
    return buildDynamicToolErrorResult(LINEAR_LIST_ISSUE_STATUSES_DYNAMIC_TOOL_NAME, error);
  }
}

const nonEmptyString = z.string().min(1);

const createIssueInputSchema = z
  .object({
    teamId: nonEmptyString.describe("Linear team UUID."),
    title: nonEmptyString.describe("Issue title."),
    description: z.string().optional().describe("Issue description."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("Linear issue priority: 0 for no priority, 1 urgent, 2 high, 3 medium, 4 low."),
    stateId: z.string().optional().describe("Initial Linear workflow state UUID."),
    assigneeId: z.string().optional().describe("Linear user UUID for the issue assignee."),
  })
  .strict();

const getIssueInputSchema = z
  .object({
    id: nonEmptyString.optional().describe("Linear issue UUID or shorthand issue identifier such as ENG-123."),
    identifier: nonEmptyString.optional().describe("Linear shorthand issue identifier such as ENG-123."),
  })
  .strict()
  .refine((value) => Boolean(value.id) !== Boolean(value.identifier), {
    message: "requires exactly one of 'id' or 'identifier'",
  });

const getIssueInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  oneOf: [{ required: ["id"] }, { required: ["identifier"] }],
  properties: {
    id: { type: "string", description: "Linear issue UUID or shorthand issue identifier such as ENG-123." },
    identifier: { type: "string", description: "Linear shorthand issue identifier such as ENG-123." },
  },
};

const listIssueStatusesInputSchema = z
  .object({
    teamId: nonEmptyString.describe("Linear team UUID."),
  })
  .strict();

const updateIssueInputSchema = z
  .object({
    issueId: nonEmptyString.describe("Linear issue UUID."),
    stateId: z.string().optional().describe("Linear workflow state UUID."),
    title: z.string().optional().describe("Issue title."),
    description: z.string().optional().describe("Issue description."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("Linear issue priority: 0 for no priority, 1 urgent, 2 high, 3 medium, 4 low."),
    assigneeId: z.string().optional().describe("Linear user UUID for the issue assignee."),
  })
  .strict();

const listCommentsInputSchema = z
  .object({
    issueId: nonEmptyString.describe("Linear issue UUID."),
    cursor: nonEmptyString.optional().describe("Optional pagination cursor."),
    limit: z.number().int().min(1).max(LINEAR_COMMENT_LIMIT_MAX).optional(),
  })
  .strict();

const createCommentInputSchema = z
  .object({
    issueId: nonEmptyString.describe("Linear issue UUID."),
    body: nonEmptyString.describe("Comment body."),
  })
  .strict();

const searchIssuesInputSchema = z
  .object({
    query: nonEmptyString.describe("Linear search term."),
    teamId: nonEmptyString.optional().describe("Optional Linear team UUID filter."),
    stateType: nonEmptyString.optional().describe("Optional workflow state type filter."),
    includeArchived: z.boolean().optional().describe("Whether to include archived issues. Defaults false."),
    limit: z.number().int().min(1).max(LINEAR_SEARCH_ISSUES_LIMIT_MAX).optional(),
  })
  .strict();

export const methods = {
  [LINEAR_CREATE_ISSUE_DYNAMIC_TOOL_NAME]: {
    description: "Create a Linear issue.",
    inputSchema: createIssueInputSchema,
    planMode: "sideEffecting",
    execute: executeLinearCreateIssueDynamicToolCall,
    redactPersistedInput: redactLinearDynamicToolInputForPersistence,
  },
  [LINEAR_GET_ISSUE_DYNAMIC_TOOL_NAME]: {
    description: "Read a Linear issue by ID or identifier.",
    inputSchema: getIssueInputSchema,
    inputJsonSchema: getIssueInputJsonSchema,
    planMode: "readOnly",
    execute: executeLinearGetIssueDynamicToolCall,
  },
  [LINEAR_LIST_ISSUE_STATUSES_DYNAMIC_TOOL_NAME]: {
    description: "List workflow states for a Linear team.",
    inputSchema: listIssueStatusesInputSchema,
    planMode: "readOnly",
    execute: executeLinearListIssueStatusesDynamicToolCall,
  },
  [LINEAR_UPDATE_ISSUE_DYNAMIC_TOOL_NAME]: {
    description: "Update a Linear issue.",
    inputSchema: updateIssueInputSchema,
    planMode: "sideEffecting",
    execute: executeLinearUpdateIssueDynamicToolCall,
    redactPersistedInput: redactLinearDynamicToolInputForPersistence,
  },
  [LINEAR_LIST_COMMENTS_DYNAMIC_TOOL_NAME]: {
    description: "List comments on a Linear issue.",
    inputSchema: listCommentsInputSchema,
    planMode: "readOnly",
    execute: executeLinearListCommentsDynamicToolCall,
  },
  [LINEAR_CREATE_COMMENT_DYNAMIC_TOOL_NAME]: {
    description: "Create a comment on a Linear issue.",
    inputSchema: createCommentInputSchema,
    planMode: "sideEffecting",
    execute: executeLinearCreateCommentDynamicToolCall,
    redactPersistedInput: redactLinearDynamicToolInputForPersistence,
  },
  [LINEAR_SEARCH_ISSUES_DYNAMIC_TOOL_NAME]: {
    description: "Search Linear issues by text.",
    inputSchema: searchIssuesInputSchema,
    planMode: "readOnly",
    execute: executeLinearSearchIssuesDynamicToolCall,
    redactPersistedInput: redactLinearDynamicToolInputForPersistence,
  },
} satisfies ToolMethods;
