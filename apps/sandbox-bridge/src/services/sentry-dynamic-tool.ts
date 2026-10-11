import { SENTRY_ACCESS_TOKEN_ENV, SENTRY_ORGANIZATION_SLUG_ENV } from "../../../../shared/constants/sandbox-env.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import { isCancellationError } from "./cancellation.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as dynamicToolFailureResult,
  createDynamicToolJsonSuccess as successResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const SENTRY_DYNAMIC_TOOL_NAMESPACE = "sentry";
export const SENTRY_DYNAMIC_TOOL_NAME = "lookup_issue";
export const SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME = "search_issues";

type SentryIssueApiResponse = {
  id?: unknown;
  shortId?: unknown;
  title?: unknown;
  culprit?: unknown;
  permalink?: unknown;
  firstSeen?: unknown;
  lastSeen?: unknown;
  status?: unknown;
  count?: unknown;
  userCount?: unknown;
  project?: { slug?: unknown; name?: unknown } | null;
  metadata?: { value?: unknown } | null;
};

type SentryShortIdApiResponse = {
  group?: SentryIssueApiResponse | null;
};

type SentryEventApiResponse = {
  id?: unknown;
  eventID?: unknown;
  title?: unknown;
  message?: unknown;
  platform?: unknown;
  culprit?: unknown;
  permalink?: unknown;
  dateCreated?: unknown;
  tags?: Array<{ key?: unknown; value?: unknown }> | null;
};

type SentryLookupResult = {
  organizationSlug: string;
  resolvedFrom: "issue_id" | "short_id" | "issue_url" | "event_url";
  issue: Record<string, unknown>;
  event: Record<string, unknown> | null;
};

type SentrySearchIssuesInput = {
  query: string;
  project: string | null;
  statsPeriod: string;
  limit: number;
};

type SentryReference =
  | { kind: "issue_id"; organizationSlug: string; issueId: string }
  | { kind: "issue_url"; organizationSlug: string; issueId: string }
  | { kind: "event_url"; organizationSlug: string; issueId: string; eventId: string }
  | { kind: "short_id"; organizationSlug: string; shortId: string };

const SENTRY_API_BASE_URL = "https://sentry.io/api/0";
const SENTRY_TIMEOUT_MS = 10_000;
const SENTRY_LOOKUP_INPUT_FIELDS = ["reference", "organizationSlug"] as const;
const SENTRY_SEARCH_ISSUES_INPUT_FIELDS = ["query", "project", "statsPeriod", "limit"] as const;
export const SENTRY_SEARCH_ISSUES_LIMIT_MAX = 25;
export const SENTRY_SEARCH_ISSUES_STATS_PERIOD_PATTERN = /^[1-9]\d*[smhdw]$/;

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  if (error.code === DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT || error.code === DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND) {
    return error.code;
  }
  if (error.status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (error.status === 401) return DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED;
  if (error.status === 403) return DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING;
  if (error.status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (error.status === 429) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

function normalizeOrganizationSlug(value: string): string {
  return value.trim().toLowerCase();
}

function sentryApiPath(path: string): string {
  return `${SENTRY_API_BASE_URL}${path}`;
}

function sentryApiUrl(path: string, query?: URLSearchParams): string {
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${sentryApiPath(path)}${suffix}`;
}

function requireLookupIssueInput(args: unknown): { reference: string; organizationSlug: string | null } {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Sentry lookup_issue requires an object input.", "invalid_input");
  }

  const extras = unknownFields(input, SENTRY_LOOKUP_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Sentry lookup_issue received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const reference = asNonEmptyString(input.reference);
  if (!reference) {
    throw new DynamicToolError("Sentry lookup_issue requires a non-empty 'reference' string.", "invalid_input");
  }

  const organizationSlug = input.organizationSlug == null ? null : asNonEmptyString(input.organizationSlug);
  if (input.organizationSlug != null && !organizationSlug) {
    throw new DynamicToolError(
      "Sentry lookup_issue requires 'organizationSlug' to be a non-empty string when provided.",
      "invalid_input",
    );
  }

  return { reference, organizationSlug: organizationSlug ? normalizeOrganizationSlug(organizationSlug) : null };
}

async function sentryApiRequest<T>(
  accessToken: string,
  path: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  query?: URLSearchParams,
): Promise<T> {
  const response = await fetchImpl(sentryApiUrl(path, query), {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
    signal: createTimeoutAwareSignal(signal, SENTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new DynamicToolError(
      `Sentry API request failed (${response.status})`,
      "upstream_http_error",
      response.status,
    );
  }
  return (await response.json()) as T;
}

function requireSearchIssuesInput(args: unknown): SentrySearchIssuesInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Sentry search_issues requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, SENTRY_SEARCH_ISSUES_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Sentry search_issues received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const query = asNonEmptyString(input.query);
  if (!query) {
    throw new DynamicToolError("Sentry search_issues requires a non-empty 'query' string.", "invalid_input");
  }
  const project = input.project === undefined ? null : asNonEmptyString(input.project);
  if (input.project !== undefined && !project) {
    throw new DynamicToolError(
      "Sentry search_issues requires 'project' to be a non-empty string when provided.",
      "invalid_input",
    );
  }
  const statsPeriod = input.statsPeriod === undefined ? "24h" : asNonEmptyString(input.statsPeriod);
  if (!statsPeriod) {
    throw new DynamicToolError(
      "Sentry search_issues requires 'statsPeriod' to be a non-empty string when provided.",
      "invalid_input",
    );
  }
  if (!SENTRY_SEARCH_ISSUES_STATS_PERIOD_PATTERN.test(statsPeriod)) {
    throw new DynamicToolError(
      "Sentry search_issues requires 'statsPeriod' to use a positive duration such as 30m, 24h, or 7d.",
      "invalid_input",
    );
  }
  const limit = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SENTRY_SEARCH_ISSUES_LIMIT_MAX) {
    throw new DynamicToolError(
      `Sentry search_issues requires 'limit' to be an integer between 1 and ${SENTRY_SEARCH_ISSUES_LIMIT_MAX}.`,
      "invalid_input",
    );
  }
  return { query, project: project ?? null, statsPeriod, limit };
}

function nullableInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function summarizeIssue(issue: SentryIssueApiResponse): Record<string, unknown> {
  return {
    id: asNonEmptyString(issue.id) ?? "",
    shortId: asNonEmptyString(issue.shortId) ?? null,
    title: asNonEmptyString(issue.title) ?? asNonEmptyString(issue.metadata?.value) ?? "Untitled Sentry issue",
    culprit: asNonEmptyString(issue.culprit) ?? null,
    permalink: asNonEmptyString(issue.permalink) ?? null,
    firstSeen: asNonEmptyString(issue.firstSeen) ?? null,
    lastSeen: asNonEmptyString(issue.lastSeen) ?? null,
    status: asNonEmptyString(issue.status) ?? null,
    count: nullableInteger(issue.count),
    userCount: nullableInteger(issue.userCount),
    projectSlug: asNonEmptyString(issue.project?.slug) ?? null,
    projectName: asNonEmptyString(issue.project?.name) ?? null,
  };
}

function summarizeEvent(event: SentryEventApiResponse): Record<string, unknown> {
  return {
    id: asNonEmptyString(event.id) ?? "",
    eventId: asNonEmptyString(event.eventID) ?? "",
    title: asNonEmptyString(event.title) ?? "Untitled Sentry event",
    message: asNonEmptyString(event.message) ?? null,
    platform: asNonEmptyString(event.platform) ?? null,
    culprit: asNonEmptyString(event.culprit) ?? null,
    permalink: asNonEmptyString(event.permalink) ?? null,
    occurredAt: asNonEmptyString(event.dateCreated) ?? null,
    tags: Array.isArray(event.tags)
      ? event.tags
          .map((tag) => {
            const key = asNonEmptyString(tag.key);
            const value = asNonEmptyString(tag.value);
            return key && value ? { key, value } : null;
          })
          .filter((tag): tag is { key: string; value: string } => tag !== null)
      : [],
  };
}

async function searchSentryIssues(
  credentials: { accessToken: string; organizationSlug: string },
  input: SentrySearchIssuesInput,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{
  organizationSlug: string;
  query: string;
  project: string | null;
  statsPeriod: string;
  issues: unknown[];
}> {
  const query = new URLSearchParams();
  query.set("query", input.query);
  query.set("statsPeriod", input.statsPeriod);
  query.set("limit", String(input.limit));
  if (input.project) query.set("project", input.project);

  const issues = await sentryApiRequest<SentryIssueApiResponse[]>(
    credentials.accessToken,
    `/organizations/${encodeURIComponent(credentials.organizationSlug)}/issues/`,
    fetchImpl,
    signal,
    query,
  );
  return {
    organizationSlug: credentials.organizationSlug,
    query: input.query,
    project: input.project,
    statsPeriod: input.statsPeriod,
    issues: Array.isArray(issues) ? issues.map((issue) => summarizeIssue(issue)) : [],
  };
}

function parseSentryReference(rawReference: string, defaultOrganizationSlug: string): SentryReference | null {
  const reference = rawReference.trim();
  if (!reference) return null;

  try {
    const parsed = new URL(reference);
    const host = parsed.hostname.toLowerCase();
    if (host === "sentry.io" || host.endsWith(".sentry.io")) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const issueIndex = parts.findIndex((part) => part === "issues");
      const subdomainOrganizationSlug =
        host !== "sentry.io" && host.endsWith(".sentry.io")
          ? normalizeOrganizationSlug(host.slice(0, -".sentry.io".length))
          : null;
      if (issueIndex >= 0) {
        const organizationSlug = normalizeOrganizationSlug(
          parts[0] === "organizations"
            ? (parts[1] ?? subdomainOrganizationSlug ?? defaultOrganizationSlug)
            : (subdomainOrganizationSlug ?? defaultOrganizationSlug),
        );
        const issueId = parts[issueIndex + 1];
        const eventsIndex = parts.findIndex((part) => part === "events");
        const eventId = eventsIndex >= 0 ? parts[eventsIndex + 1] : null;
        if (organizationSlug && issueId && eventId) {
          return { kind: "event_url", organizationSlug, issueId, eventId };
        }
        if (organizationSlug && issueId) {
          return { kind: "issue_url", organizationSlug, issueId };
        }
      }
    }
  } catch {
    // Fall through to non-URL parsing.
  }

  if (/^\d+$/.test(reference)) {
    return { kind: "issue_id", organizationSlug: defaultOrganizationSlug, issueId: reference };
  }
  if (/^[A-Z0-9_-]+-[A-Z0-9]+$/i.test(reference)) {
    return { kind: "short_id", organizationSlug: defaultOrganizationSlug, shortId: reference.toUpperCase() };
  }
  return null;
}

async function fetchIssueById(
  accessToken: string,
  organizationSlug: string,
  issueId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const issue = await sentryApiRequest<SentryIssueApiResponse>(
    accessToken,
    `/organizations/${encodeURIComponent(organizationSlug)}/issues/${encodeURIComponent(issueId)}/`,
    fetchImpl,
    signal,
  );
  return summarizeIssue(issue);
}

async function fetchIssueByShortId(
  accessToken: string,
  organizationSlug: string,
  shortId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: SentryShortIdApiResponse;
  try {
    response = await sentryApiRequest<SentryShortIdApiResponse>(
      accessToken,
      `/organizations/${encodeURIComponent(organizationSlug)}/shortids/${encodeURIComponent(shortId)}/`,
      fetchImpl,
      signal,
    );
  } catch (error) {
    if (error instanceof DynamicToolError && error.status === 404) {
      throw new DynamicToolError(
        `Sentry short ID '${shortId}' was not found in organization '${organizationSlug}'. Try the full issue URL or pass the correct organizationSlug.`,
        "not_found",
        404,
      );
    }
    throw error;
  }
  const exact = response.group ?? null;
  if (!exact) {
    throw new DynamicToolError(
      `Sentry short ID '${shortId}' was not found in organization '${organizationSlug}'. Try the full issue URL or pass the correct organizationSlug.`,
      "not_found",
      404,
    );
  }
  return summarizeIssue(exact);
}

async function fetchIssueEvent(
  accessToken: string,
  organizationSlug: string,
  issueId: string,
  eventId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const event = await sentryApiRequest<SentryEventApiResponse>(
    accessToken,
    `/organizations/${encodeURIComponent(organizationSlug)}/issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(eventId)}/`,
    fetchImpl,
    signal,
  );
  return summarizeEvent(event);
}

async function fetchLatestIssueEventBestEffort(
  accessToken: string,
  organizationSlug: string,
  issueId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    return await fetchIssueEvent(accessToken, organizationSlug, issueId, "latest", fetchImpl, signal);
  } catch (error) {
    if (isCancellationError(error)) throw error;
    if (error instanceof DynamicToolError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function credentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): {
  accessToken: string;
  organizationSlug: string;
} | null {
  const accessToken = env[SENTRY_ACCESS_TOKEN_ENV]?.trim();
  const organizationSlug = env[SENTRY_ORGANIZATION_SLUG_ENV]?.trim();
  if (!accessToken || !organizationSlug) return null;
  return { accessToken, organizationSlug };
}

async function lookupSentryReference(
  credentials: { accessToken: string; organizationSlug: string },
  reference: string,
  organizationSlug: string | null,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<SentryLookupResult> {
  const parsed = parseSentryReference(reference, organizationSlug ?? credentials.organizationSlug);
  if (!parsed) throw new DynamicToolError("Unsupported Sentry reference", "invalid_input");

  let issue: Record<string, unknown>;
  let event: Record<string, unknown> | null = null;
  switch (parsed.kind) {
    case "issue_id":
    case "issue_url":
      issue = await fetchIssueById(credentials.accessToken, parsed.organizationSlug, parsed.issueId, fetchImpl, signal);
      event = await fetchLatestIssueEventBestEffort(
        credentials.accessToken,
        parsed.organizationSlug,
        parsed.issueId,
        fetchImpl,
        signal,
      );
      break;
    case "event_url":
      issue = await fetchIssueById(credentials.accessToken, parsed.organizationSlug, parsed.issueId, fetchImpl, signal);
      event = await fetchIssueEvent(
        credentials.accessToken,
        parsed.organizationSlug,
        parsed.issueId,
        parsed.eventId,
        fetchImpl,
        signal,
      );
      break;
    case "short_id":
      issue = await fetchIssueByShortId(
        credentials.accessToken,
        parsed.organizationSlug,
        parsed.shortId,
        fetchImpl,
        signal,
      );
      if (typeof issue.id === "string" && issue.id) {
        event = await fetchLatestIssueEventBestEffort(
          credentials.accessToken,
          parsed.organizationSlug,
          issue.id,
          fetchImpl,
          signal,
        );
      }
      break;
  }

  return {
    organizationSlug: parsed.organizationSlug,
    resolvedFrom: parsed.kind,
    issue,
    event,
  };
}

export function buildSentryDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: SENTRY_DYNAMIC_TOOL_NAMESPACE,
      name: SENTRY_DYNAMIC_TOOL_NAME,
      description: "Resolve a Sentry issue, event, URL, or short ID into structured incident details.",
      inputSchema: {
        type: "object",
        properties: {
          reference: {
            type: "string",
            description: "Sentry issue URL, event URL, short ID like WEB-123 or WEB-7Q, or numeric issue ID",
          },
          organizationSlug: {
            type: "string",
            description: "Optional Sentry organization slug to use for bare short IDs or numeric issue IDs.",
          },
        },
        required: ["reference"],
        additionalProperties: false,
      },
    },
  ];
}

export function buildSentrySearchIssuesDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: SENTRY_DYNAMIC_TOOL_NAMESPACE,
      name: SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
      description: "Search Sentry issues in the connected organization and return normalized issue summaries.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sentry issue search query." },
          project: { type: "string", description: "Optional Sentry project slug or ID to filter by." },
          statsPeriod: { type: "string", description: "Stats period such as 24h. Defaults to 24h." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: SENTRY_SEARCH_ISSUES_LIMIT_MAX,
            description: `Maximum number of issues to return (1-${SENTRY_SEARCH_ISSUES_LIMIT_MAX}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
}

export function redactSentryDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | null | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  const query = typeof input.query === "string" ? input.query : null;
  return {
    ...(query !== null ? { queryLength: query.length } : {}),
    ...(typeof input.project === "string" ? { project: input.project } : {}),
    ...(typeof input.statsPeriod === "string" ? { statsPeriod: input.statsPeriod } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
  };
}

export async function executeSentryDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Sentry credentials are not configured for this session.");
  }
  try {
    const { reference, organizationSlug } = requireLookupIssueInput(args);
    const result = await lookupSentryReference(
      credentials,
      reference,
      organizationSlug,
      context.fetchImpl ?? fetch,
      context.signal,
    );
    return successResult(result);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Sentry lookup was cancelled.");
    }
    const sentryError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(sentryError),
      `Sentry lookup failed: ${sentryError.message}`,
    );
  }
}

export async function executeSentrySearchIssuesDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Sentry credentials are not configured for this session.");
  }
  try {
    const input = requireSearchIssuesInput(args);
    const result = await searchSentryIssues(credentials, input, context.fetchImpl ?? fetch, context.signal);
    return successResult(result);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Sentry search_issues was cancelled.");
    }
    const sentryError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(sentryError),
      `Sentry search_issues failed: ${sentryError.message}`,
    );
  }
}
