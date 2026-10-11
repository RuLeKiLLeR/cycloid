import {
  DEFAULT_JIRA_TRIGGER_LABEL,
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  JIRA_TRIGGER_LABEL_ENV,
} from "../../../../shared/constants/sandbox-env.js";
import { flattenAdfDescription, wrapTextAsAdf } from "../../../../shared/utils/adf.js";
import { createBridgeLogger, LOG_ORDINALS, type LogLevel } from "../logger.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import { notifyAgentCreatedTicketKey } from "./agent-ticket-key-notify.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  buildDynamicToolErrorResult as buildSharedDynamicToolErrorResult,
  createDynamicToolFailure as dynamicToolFailureResult,
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

export const JIRA_DYNAMIC_TOOL_NAMESPACE = "jira";
export const JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME = "create_issue";
export const JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME = "get_issue";
export const JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME = "list_comments";
export const JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME = "add_comment";
export const JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME = "search_issues";
export const JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME = "list_transitions";
export const JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME = "transition_issue";

const JIRA_TIMEOUT_MS = 10_000;
const JIRA_SUMMARY_MAX_CHARS = 255;
const JIRA_DESCRIPTION_MAX_CHARS = 8 * 1024;
const JIRA_COMMENT_MAX_CHARS = 8 * 1024;
const JIRA_COMMENT_BODY_MAX_CHARS = 4 * 1024;
const JIRA_COMMENTS_DEFAULT_LIMIT = 25;
const JIRA_COMMENTS_MAX_LIMIT = 50;
const JIRA_SEARCH_DEFAULT_LIMIT = 10;
const JIRA_SEARCH_MAX_LIMIT = 25;
const JIRA_SEARCH_FIELDS = "summary,description,status,assignee,labels,issuetype,priority";
// Access tokens are injected at session spawn and Atlassian tokens are short-lived
// (~1h); long sessions can see token_expired. Surfaced in the error message so the
// agent can tell the user to relaunch instead of retrying blindly.
const JIRA_TOKEN_EXPIRED_HINT =
  "The Jira access token for this session has expired (Atlassian tokens are short-lived). Start a new session to refresh it.";

const log = createBridgeLogger(LOG_ORDINALS[(process.env.LOG_LEVEL || "info") as LogLevel] ?? 0, {
  component: "jira-dynamic-tool",
});

interface JiraCredentials {
  accessToken: string;
  cloudId: string;
  siteUrl: string | null;
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

function jiraCredentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): JiraCredentials | null {
  const accessToken = env[JIRA_ACCESS_TOKEN_ENV]?.trim();
  const cloudId = env[JIRA_CLOUD_ID_ENV]?.trim();
  if (!accessToken || !cloudId) return null;
  return { accessToken, cloudId, siteUrl: env[JIRA_SITE_URL_ENV]?.trim() || null };
}

function jiraTriggerLabelFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): string {
  return (env[JIRA_TRIGGER_LABEL_ENV]?.trim() || DEFAULT_JIRA_TRIGGER_LABEL).toLowerCase();
}

/**
 * An agent-applied trigger label would fire the Jira webhook and spawn another
 * session (sessions minting sessions), so it is stripped unconditionally. A
 * human who wants a trigger adds the label in Jira.
 */
function stripTriggerLabel(
  labels: string[] | undefined,
  triggerLabel: string,
): { labels: string[] | undefined; strippedLabels: string[] } {
  if (!labels) return { labels: undefined, strippedLabels: [] };
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const label of labels) {
    (label.toLowerCase() === triggerLabel ? stripped : kept).push(label);
  }
  return { labels: kept.length > 0 ? kept : undefined, strippedLabels: stripped };
}

function flattenedDescription(description: unknown): string | null {
  const text = flattenAdfDescription(description);
  return text ? truncateWithMarker(text, JIRA_DESCRIPTION_MAX_CHARS) : null;
}

// ---------------------------------------------------------------------------
// REST plumbing
// ---------------------------------------------------------------------------

async function jiraApiRequest<T>(params: {
  credentials: JiraCredentials;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  expectEmptyResponse?: boolean;
}): Promise<T> {
  const url = `https://api.atlassian.com/ex/jira/${encodeURIComponent(params.credentials.cloudId)}/rest/api/3${params.path}`;
  const response = await params.fetchImpl(url, {
    method: params.method,
    headers: {
      authorization: `Bearer ${params.credentials.accessToken}`,
      accept: "application/json",
      ...(params.body ? { "content-type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
    signal: createTimeoutAwareSignal(params.signal, JIRA_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = (await response.json()) as { errorMessages?: unknown; errors?: unknown };
      const messages = Array.isArray(errorBody.errorMessages)
        ? errorBody.errorMessages.filter((message): message is string => typeof message === "string")
        : [];
      const fieldErrors = asRecord(errorBody.errors);
      const fieldMessages = fieldErrors
        ? Object.entries(fieldErrors)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([field, message]) => `${field}: ${message}`)
        : [];
      detail = [...messages, ...fieldMessages].slice(0, 3).join("; ");
    } catch {
      // Non-JSON error body; the status code is enough.
    }
    const suffix = detail ? `: ${detail}` : "";
    const hint = response.status === 401 ? ` ${JIRA_TOKEN_EXPIRED_HINT}` : "";
    throw new DynamicToolError(
      `Jira API request failed (${response.status})${suffix}.${hint}`,
      "upstream_http_error",
      response.status,
    );
  }

  if (params.expectEmptyResponse || response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function buildJiraDynamicToolSpec(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[] {
  return (env) =>
    jiraCredentialsFromEnv(env)
      ? [
          {
            namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
            name,
            description,
            inputSchema,
          },
        ]
      : [];
}

function browseUrl(credentials: JiraCredentials, issueKey: string): string | null {
  return credentials.siteUrl ? `${credentials.siteUrl.replace(/\/$/, "")}/browse/${issueKey}` : null;
}

function buildJiraSuccessResult(payload: Record<string, unknown>): FirstPartyDynamicToolCallResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(payload, null, 2) }],
  };
}

function buildDynamicToolErrorResult(toolName: string, error: unknown): FirstPartyDynamicToolCallResult {
  return buildSharedDynamicToolErrorResult({
    error,
    cancelledMessage: `Jira ${toolName} was cancelled.`,
    mapErrorCode: mapDynamicToolErrorCode,
    unexpectedMessage: () => `Jira ${toolName} failed due to an unexpected upstream error.`,
  });
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

type JiraCreateIssueInput = {
  projectKey: string;
  summary: string;
  description?: string;
  issueType: string;
  labels?: string[];
  assigneeAccountId?: string;
};
type JiraIssueRefInput = { keyOrId: string };
type JiraListCommentsInput = { keyOrId: string; startAt: number; maxResults: number };
type JiraAddCommentInput = { keyOrId: string; body: string };
type JiraSearchIssuesInput = { jql: string; nextPageToken?: string; maxResults: number };
type JiraTransitionIssueInput = { keyOrId: string; transition: string };

function normalizeCreateIssueInput(args: unknown): JiraCreateIssueInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Jira create_issue requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, [
    "projectKey",
    "summary",
    "description",
    "issueType",
    "labels",
    "assigneeAccountId",
  ]);
  if (extras.length > 0) {
    throw new DynamicToolError(`Jira create_issue received unsupported fields: ${extras.join(", ")}.`, "invalid_input");
  }
  const projectKey = asNonEmptyString(input.projectKey);
  if (!projectKey) {
    throw new DynamicToolError("Jira create_issue requires a non-empty 'projectKey' string.", "invalid_input");
  }
  const summary = asNonEmptyString(input.summary);
  if (!summary) {
    throw new DynamicToolError("Jira create_issue requires a non-empty 'summary' string.", "invalid_input");
  }
  const description = asNonEmptyString(input.description);
  const issueType = input.issueType === undefined ? "Task" : asNonEmptyString(input.issueType);
  if (!issueType) {
    throw new DynamicToolError("Jira create_issue 'issueType' must be a non-empty string.", "invalid_input");
  }
  let labels: string[] | undefined;
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels) || input.labels.some((label) => !asNonEmptyString(label))) {
      throw new DynamicToolError("Jira create_issue 'labels' must be an array of non-empty strings.", "invalid_input");
    }
    labels = input.labels.map((label) => (label as string).trim());
  }
  const assigneeAccountId =
    input.assigneeAccountId === undefined ? undefined : (asNonEmptyString(input.assigneeAccountId) ?? undefined);
  if (input.assigneeAccountId !== undefined && !assigneeAccountId) {
    throw new DynamicToolError("Jira create_issue 'assigneeAccountId' must be a non-empty string.", "invalid_input");
  }

  return {
    projectKey,
    summary: truncateWithMarker(summary, JIRA_SUMMARY_MAX_CHARS, " [truncated]"),
    ...(description ? { description: truncateWithMarker(description, JIRA_DESCRIPTION_MAX_CHARS) } : {}),
    issueType,
    ...(labels ? { labels } : {}),
    ...(assigneeAccountId ? { assigneeAccountId } : {}),
  };
}

function normalizeIssueRefInput(toolName: string, args: unknown): JiraIssueRefInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError(`Jira ${toolName} requires an object input.`, "invalid_input");
  }
  const extras = unknownFields(input, ["keyOrId"]);
  if (extras.length > 0) {
    throw new DynamicToolError(`Jira ${toolName} received unsupported fields: ${extras.join(", ")}.`, "invalid_input");
  }
  const keyOrId = asNonEmptyString(input.keyOrId);
  if (!keyOrId) {
    throw new DynamicToolError(`Jira ${toolName} requires a non-empty 'keyOrId' string.`, "invalid_input");
  }
  return { keyOrId };
}

function optionalBoundedInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new DynamicToolError(`Jira ${field} must be an integer from ${min} to ${max}.`, "invalid_input");
  }
  return value as number;
}

function normalizeListCommentsInput(args: unknown): JiraListCommentsInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Jira list_comments requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["keyOrId", "startAt", "maxResults"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Jira list_comments received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const keyOrId = asNonEmptyString(input.keyOrId);
  if (!keyOrId) {
    throw new DynamicToolError("Jira list_comments requires a non-empty 'keyOrId' string.", "invalid_input");
  }
  return {
    keyOrId,
    startAt: optionalBoundedInt(input.startAt, "list_comments 'startAt'", 0, Number.MAX_SAFE_INTEGER, 0),
    maxResults: optionalBoundedInt(
      input.maxResults,
      "list_comments 'maxResults'",
      1,
      JIRA_COMMENTS_MAX_LIMIT,
      JIRA_COMMENTS_DEFAULT_LIMIT,
    ),
  };
}

function normalizeAddCommentInput(args: unknown): JiraAddCommentInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Jira add_comment requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["keyOrId", "body"]);
  if (extras.length > 0) {
    throw new DynamicToolError(`Jira add_comment received unsupported fields: ${extras.join(", ")}.`, "invalid_input");
  }
  const keyOrId = asNonEmptyString(input.keyOrId);
  if (!keyOrId) {
    throw new DynamicToolError("Jira add_comment requires a non-empty 'keyOrId' string.", "invalid_input");
  }
  const body = asNonEmptyString(input.body);
  if (!body) {
    throw new DynamicToolError("Jira add_comment requires a non-empty 'body' string.", "invalid_input");
  }
  return { keyOrId, body: truncateWithMarker(body, JIRA_COMMENT_MAX_CHARS) };
}

function normalizeSearchIssuesInput(args: unknown): JiraSearchIssuesInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Jira search_issues requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["jql", "nextPageToken", "maxResults"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Jira search_issues received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const jql = asNonEmptyString(input.jql);
  if (!jql) {
    throw new DynamicToolError("Jira search_issues requires a non-empty 'jql' string.", "invalid_input");
  }
  const nextPageToken =
    input.nextPageToken === undefined ? undefined : (asNonEmptyString(input.nextPageToken) ?? undefined);
  if (input.nextPageToken !== undefined && !nextPageToken) {
    throw new DynamicToolError("Jira search_issues 'nextPageToken' must be a non-empty string.", "invalid_input");
  }
  return {
    jql,
    ...(nextPageToken ? { nextPageToken } : {}),
    maxResults: optionalBoundedInt(
      input.maxResults,
      "search_issues 'maxResults'",
      1,
      JIRA_SEARCH_MAX_LIMIT,
      JIRA_SEARCH_DEFAULT_LIMIT,
    ),
  };
}

function normalizeTransitionIssueInput(args: unknown): JiraTransitionIssueInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Jira transition_issue requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, ["keyOrId", "transition"]);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Jira transition_issue received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const keyOrId = asNonEmptyString(input.keyOrId);
  if (!keyOrId) {
    throw new DynamicToolError("Jira transition_issue requires a non-empty 'keyOrId' string.", "invalid_input");
  }
  const transition = asNonEmptyString(input.transition);
  if (!transition) {
    throw new DynamicToolError(
      "Jira transition_issue requires a non-empty 'transition' (transition ID or name).",
      "invalid_input",
    );
  }
  return { keyOrId, transition };
}

export function redactJiraDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | undefined {
  const input = asRecord(args);
  if (!input) return {};

  const keyOrId = asNonEmptyString(input.keyOrId);
  const projectKey = asNonEmptyString(input.projectKey);
  const issueType = asNonEmptyString(input.issueType);
  const assigneeAccountId = asNonEmptyString(input.assigneeAccountId);
  const summary = asNonEmptyString(input.summary);
  const description = asNonEmptyString(input.description);
  const body = asNonEmptyString(input.body);
  const jql = asNonEmptyString(input.jql);
  const labels = Array.isArray(input.labels) ? input.labels.length : null;

  return {
    ...(keyOrId ? { keyOrId } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(issueType ? { issueType } : {}),
    ...(assigneeAccountId ? { assigneeAccountId } : {}),
    ...(labels !== null ? { labelCount: labels } : {}),
    ...(summary ? { summaryLength: summary.length } : {}),
    ...(description ? { descriptionLength: description.length } : {}),
    ...(body ? { bodyLength: body.length } : {}),
    ...(jql ? { jqlLength: jql.length } : {}),
    ...(summary ? { summaryRedacted: true } : {}),
    ...(description ? { descriptionRedacted: true } : {}),
    ...(body ? { bodyRedacted: true } : {}),
    ...(jql ? { jqlRedacted: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

// Built per-env (not via buildJiraDynamicToolSpec) so the labels description
// names the session's actual trigger label, which is configurable per
// installation.
export function buildJiraCreateIssueDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!jiraCredentialsFromEnv(env)) return [];
  return [
    {
      namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
      name: JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME,
      description: "Create a Jira issue in a project.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["projectKey", "summary"],
        properties: {
          projectKey: { type: "string", description: "Jira project key such as ENG." },
          summary: { type: "string", description: "Issue summary (title)." },
          description: { type: "string", description: "Plain-text issue description." },
          issueType: { type: "string", description: "Issue type name such as Task, Bug, or Story. Defaults to Task." },
          labels: {
            type: "array",
            items: { type: "string" },
            description: `Labels to apply to the issue. The session trigger label ("${jiraTriggerLabelFromEnv(env)}") is ignored: applying it would spawn another session.`,
          },
          assigneeAccountId: { type: "string", description: "Atlassian account ID for the assignee." },
        },
      },
    },
  ];
}

export const buildJiraGetIssueDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME,
  "Read a Jira issue by key or ID.",
  {
    type: "object",
    additionalProperties: false,
    required: ["keyOrId"],
    properties: {
      keyOrId: { type: "string", description: "Jira issue key such as ENG-123 or the numeric issue ID." },
    },
  },
);

export const buildJiraListCommentsDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME,
  "List comments for a Jira issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["keyOrId"],
    properties: {
      keyOrId: { type: "string", description: "Jira issue key such as ENG-123 or the numeric issue ID." },
      startAt: { type: "integer", minimum: 0, description: "Zero-based pagination offset. Defaults to 0." },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: JIRA_COMMENTS_MAX_LIMIT,
        description: `Maximum comments to return. Defaults to ${JIRA_COMMENTS_DEFAULT_LIMIT}.`,
      },
    },
  },
);

export const buildJiraAddCommentDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME,
  "Add a plain-text comment to a Jira issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["keyOrId", "body"],
    properties: {
      keyOrId: { type: "string", description: "Jira issue key such as ENG-123 or the numeric issue ID." },
      body: { type: "string", description: "Plain-text comment body." },
    },
  },
);

export const buildJiraSearchIssuesDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
  "Search Jira issues using JQL.",
  {
    type: "object",
    additionalProperties: false,
    required: ["jql"],
    properties: {
      jql: { type: "string", description: "Jira Query Language expression." },
      nextPageToken: { type: "string", description: "Pagination token from a previous search_issues response." },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: JIRA_SEARCH_MAX_LIMIT,
        description: `Maximum issues to return. Defaults to ${JIRA_SEARCH_DEFAULT_LIMIT}.`,
      },
    },
  },
);

export const buildJiraListTransitionsDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME,
  "List the workflow transitions currently available for a Jira issue.",
  {
    type: "object",
    additionalProperties: false,
    required: ["keyOrId"],
    properties: {
      keyOrId: { type: "string", description: "Jira issue key such as ENG-123 or the numeric issue ID." },
    },
  },
);

export const buildJiraTransitionIssueDynamicToolSpec = buildJiraDynamicToolSpec(
  JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME,
  "Move a Jira issue to a new workflow status via a transition ID or name.",
  {
    type: "object",
    additionalProperties: false,
    required: ["keyOrId", "transition"],
    properties: {
      keyOrId: { type: "string", description: "Jira issue key such as ENG-123 or the numeric issue ID." },
      transition: { type: "string", description: "Transition ID or transition name (resolved via list_transitions)." },
    },
  },
);

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type JiraIssueFieldsResponse = {
  id?: unknown;
  key?: unknown;
  fields?: {
    summary?: unknown;
    description?: unknown;
    status?: { name?: unknown } | null;
    assignee?: { accountId?: unknown; displayName?: unknown } | null;
    labels?: unknown;
    issuetype?: { name?: unknown } | null;
    priority?: { name?: unknown } | null;
  } | null;
};

type JiraTransitionsResponse = {
  transitions?: Array<{
    id?: unknown;
    name?: unknown;
    to?: { name?: unknown } | null;
  } | null> | null;
};

type JiraCommentResponse = {
  id?: unknown;
  body?: unknown;
  created?: unknown;
  updated?: unknown;
  author?: { accountId?: unknown; displayName?: unknown } | null;
};

type JiraCommentsResponse = {
  startAt?: unknown;
  maxResults?: unknown;
  total?: unknown;
  comments?: Array<JiraCommentResponse | null> | null;
};

type JiraSearchResponse = {
  issues?: Array<JiraIssueFieldsResponse | null> | null;
  nextPageToken?: unknown;
  isLast?: unknown;
};

function summarizeJiraIssue(credentials: JiraCredentials, issue: JiraIssueFieldsResponse): Record<string, unknown> {
  const key = asNonEmptyString(issue.key) ?? "";
  const fields = issue.fields ?? {};
  return {
    id: asNonEmptyString(issue.id) ?? null,
    key,
    summary: asNonEmptyString(fields?.summary) ?? "Untitled Jira issue",
    status: asNonEmptyString(fields?.status?.name) ?? null,
    issueType: asNonEmptyString(fields?.issuetype?.name) ?? null,
    priority: asNonEmptyString(fields?.priority?.name) ?? null,
    assignee: fields?.assignee
      ? {
          accountId: asNonEmptyString(fields.assignee.accountId) ?? null,
          displayName: asNonEmptyString(fields.assignee.displayName) ?? null,
        }
      : null,
    labels: Array.isArray(fields?.labels)
      ? fields.labels.filter((label): label is string => typeof label === "string")
      : [],
    url: key ? browseUrl(credentials, key) : null,
    description: flattenedDescription(fields?.description),
  };
}

function summarizeJiraComment(comment: JiraCommentResponse): Record<string, unknown> {
  const rawBody = flattenAdfDescription(comment.body);
  const body = rawBody ? truncateWithMarker(rawBody, JIRA_COMMENT_BODY_MAX_CHARS) : null;
  return {
    id: asNonEmptyString(comment.id) ?? null,
    author: comment.author
      ? {
          accountId: asNonEmptyString(comment.author.accountId) ?? null,
          displayName: asNonEmptyString(comment.author.displayName) ?? null,
        }
      : null,
    createdAt: asNonEmptyString(comment.created) ?? null,
    updatedAt: asNonEmptyString(comment.updated) ?? null,
    body,
    truncated: Boolean(rawBody && body && rawBody.length > body.length),
  };
}

function isAmbiguousWriteFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

export async function executeJiraCreateIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraCreateIssueInput;
  try {
    input = normalizeCreateIssueInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  const { labels, strippedLabels } = stripTriggerLabel(input.labels, jiraTriggerLabelFromEnv(context.env));
  if (strippedLabels.length > 0) {
    log.warn(
      { event: "jira_trigger_label_stripped", tool: JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME, strippedLabels },
      "Stripped session trigger label from Jira create_issue to prevent a session cascade",
    );
  }

  try {
    const created = await jiraApiRequest<{ id?: unknown; key?: unknown }>({
      credentials,
      method: "POST",
      path: "/issue",
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      body: {
        fields: {
          project: { key: input.projectKey },
          summary: input.summary,
          issuetype: { name: input.issueType },
          ...(input.description ? { description: wrapTextAsAdf(input.description) } : {}),
          ...(labels ? { labels } : {}),
          ...(input.assigneeAccountId ? { assignee: { accountId: input.assigneeAccountId } } : {}),
        },
      },
    });
    const key = asNonEmptyString(created.key);
    if (!key) {
      throw new DynamicToolError("Jira create_issue did not return an issue key.", "upstream_error");
    }
    // Feed the agent-created key into the session so the PR title carries it.
    // Isolated and best-effort: the issue already exists, so a notify throw must
    // never turn this into a tool error (which would risk a duplicate issue).
    try {
      await notifyAgentCreatedTicketKey(key, "jira", context);
    } catch {
      // Swallow: the created issue is still returned below.
    }
    return buildJiraSuccessResult({
      id: asNonEmptyString(created.id),
      key,
      url: browseUrl(credentials, key),
      ...(strippedLabels.length > 0 ? { strippedLabels } : {}),
    });
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeJiraGetIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraIssueRefInput;
  try {
    input = normalizeIssueRefInput(JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME, args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const issue = await jiraApiRequest<JiraIssueFieldsResponse>({
      credentials,
      method: "GET",
      path: `/issue/${encodeURIComponent(input.keyOrId)}?fields=summary,description,status,assignee,labels,issuetype,priority`,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return buildJiraSuccessResult(summarizeJiraIssue(credentials, issue));
  } catch (error) {
    if (error instanceof DynamicToolError && error.status === 404) {
      return dynamicToolFailureResult("not_found", `Jira issue '${input.keyOrId}' was not found.`);
    }
    return buildDynamicToolErrorResult(JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeJiraListCommentsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraListCommentsInput;
  try {
    input = normalizeListCommentsInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const params = new URLSearchParams({
      startAt: String(input.startAt),
      maxResults: String(input.maxResults),
    });
    const data = await jiraApiRequest<JiraCommentsResponse>({
      credentials,
      method: "GET",
      path: `/issue/${encodeURIComponent(input.keyOrId)}/comment?${params.toString()}`,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    const comments = (data.comments ?? []).flatMap((comment) => (comment ? [summarizeJiraComment(comment)] : []));
    const startAt = typeof data.startAt === "number" ? data.startAt : input.startAt;
    const total = typeof data.total === "number" ? data.total : null;
    const hasMore = total === null ? comments.length >= input.maxResults : startAt + comments.length < total;
    return buildJiraSuccessResult({
      keyOrId: input.keyOrId,
      startAt,
      maxResults: typeof data.maxResults === "number" ? data.maxResults : input.maxResults,
      total,
      comments,
      hasMore,
      ...(hasMore ? { nextStartAt: startAt + comments.length } : {}),
      truncated: comments.some((comment) => comment.truncated === true),
    });
  } catch (error) {
    if (error instanceof DynamicToolError && error.status === 404) {
      return dynamicToolFailureResult("not_found", `Jira issue '${input.keyOrId}' was not found.`);
    }
    return buildDynamicToolErrorResult(JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeJiraAddCommentDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraAddCommentInput;
  try {
    input = normalizeAddCommentInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const comment = await jiraApiRequest<JiraCommentResponse>({
      credentials,
      method: "POST",
      path: `/issue/${encodeURIComponent(input.keyOrId)}/comment`,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      body: { body: wrapTextAsAdf(input.body) },
    });
    return buildJiraSuccessResult({
      keyOrId: input.keyOrId,
      id: asNonEmptyString(comment.id) ?? null,
      createdAt: asNonEmptyString(comment.created) ?? null,
      commentAdded: true,
    });
  } catch (error) {
    if (isAmbiguousWriteFailure(error)) {
      return dynamicToolFailureResult(
        "upstream_error",
        "Jira add_comment timed out after sending the request; it is unknown whether the comment was posted. Do not blindly retry. Read the issue comments first.",
      );
    }
    if (error instanceof DynamicToolError && error.status === 404) {
      return dynamicToolFailureResult("not_found", `Jira issue '${input.keyOrId}' was not found.`);
    }
    return buildDynamicToolErrorResult(JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeJiraSearchIssuesDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraSearchIssuesInput;
  try {
    input = normalizeSearchIssuesInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const data = await jiraApiRequest<JiraSearchResponse>({
      credentials,
      method: "POST",
      path: "/search/jql",
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      body: {
        jql: input.jql,
        maxResults: input.maxResults,
        fields: JIRA_SEARCH_FIELDS.split(","),
        ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}),
      },
    });
    const nextPageToken = asNonEmptyString(data.nextPageToken);
    return buildJiraSuccessResult({
      issues: (data.issues ?? []).flatMap((issue) => (issue ? [summarizeJiraIssue(credentials, issue)] : [])),
      hasMore: Boolean(nextPageToken) || data.isLast === false,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME, error);
  }
}

async function fetchJiraTransitions(
  credentials: JiraCredentials,
  keyOrId: string,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<Array<{ id: string; name: string; toStatus: string | null }>> {
  const data = await jiraApiRequest<JiraTransitionsResponse>({
    credentials,
    method: "GET",
    path: `/issue/${encodeURIComponent(keyOrId)}/transitions`,
    fetchImpl: context.fetchImpl ?? fetch,
    signal: context.signal,
  });
  return (data.transitions ?? []).flatMap((transition) => {
    if (!transition) return [];
    const id = asNonEmptyString(transition.id);
    const name = asNonEmptyString(transition.name);
    if (!id || !name) return [];
    return [{ id, name, toStatus: asNonEmptyString(transition.to?.name) ?? null }];
  });
}

export async function executeJiraListTransitionsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraIssueRefInput;
  try {
    input = normalizeIssueRefInput(JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME, args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME, error);
  }

  try {
    const transitions = await fetchJiraTransitions(credentials, input.keyOrId, context);
    return buildJiraSuccessResult({ keyOrId: input.keyOrId, transitions });
  } catch (error) {
    if (error instanceof DynamicToolError && error.status === 404) {
      return dynamicToolFailureResult("not_found", `Jira issue '${input.keyOrId}' was not found.`);
    }
    return buildDynamicToolErrorResult(JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME, error);
  }
}

export async function executeJiraTransitionIssueDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = jiraCredentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Jira credentials are not configured for this session.");
  }

  let input: JiraTransitionIssueInput;
  try {
    input = normalizeTransitionIssueInput(args);
  } catch (error) {
    return buildDynamicToolErrorResult(JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME, error);
  }

  try {
    // Accept a transition ID directly or resolve a name via the transitions list.
    let transitionId = /^\d+$/.test(input.transition) ? input.transition : null;
    let transitionName: string | null = null;
    if (!transitionId) {
      const transitions = await fetchJiraTransitions(credentials, input.keyOrId, context);
      const match = transitions.find((transition) => transition.name.toLowerCase() === input.transition.toLowerCase());
      if (!match) {
        const available = transitions.map((transition) => transition.name).join(", ") || "none";
        return dynamicToolFailureResult(
          "invalid_input",
          `Jira transition '${input.transition}' is not available for '${input.keyOrId}'. Available transitions: ${available}.`,
        );
      }
      transitionId = match.id;
      transitionName = match.name;
    }

    await jiraApiRequest<undefined>({
      credentials,
      method: "POST",
      path: `/issue/${encodeURIComponent(input.keyOrId)}/transitions`,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
      body: { transition: { id: transitionId } },
      expectEmptyResponse: true,
    });

    return buildJiraSuccessResult({
      keyOrId: input.keyOrId,
      transitionId,
      ...(transitionName ? { transitionName } : {}),
      transitioned: true,
    });
  } catch (error) {
    if (error instanceof DynamicToolError && error.status === 404) {
      return dynamicToolFailureResult("not_found", `Jira issue '${input.keyOrId}' was not found.`);
    }
    return buildDynamicToolErrorResult(JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME, error);
  }
}
