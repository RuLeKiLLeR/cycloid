import { SLACK_SESSION_TEAM_ID_ENV } from "../../../../shared/constants/sandbox-env.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString } from "../utils/dynamic-tool-helpers.js";
import { isCancellationError } from "./cancellation.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as dynamicToolFailureResult,
  createDynamicToolJsonSuccess,
  DYNAMIC_TOOL_ERROR_CODES,
  isDynamicToolErrorCode,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const SLACK_DYNAMIC_TOOL_NAMESPACE = "slack";
export const SLACK_GET_THREAD_DYNAMIC_TOOL_NAME = "get_thread";
export const SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME = "search_messages";
export const SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME = "send_message";

const SLACK_TOOL_TIMEOUT_MS = 10_000;

type SlackDynamicToolFailureBody = {
  ok?: false;
  errorCode?: unknown;
  error?: unknown;
};

function buildSlackDynamicToolSpec(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[] {
  return (env) =>
    env[SLACK_SESSION_TEAM_ID_ENV]?.trim()
      ? [
          {
            namespace: SLACK_DYNAMIC_TOOL_NAMESPACE,
            name,
            description,
            inputSchema,
          },
        ]
      : [];
}

async function executeSlackProxyCall(
  toolPath: string,
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"]);
  const sessionId = context.env["SESSION_ID"]?.trim();
  const sandboxAuthToken = context.env["SANDBOX_AUTH_TOKEN"]?.trim();

  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) {
    return dynamicToolFailureResult(
      DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED,
      "Slack dynamic tool routing is not configured for this session.",
    );
  }

  try {
    const response = await (context.fetchImpl ?? fetch)(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/slack/${toolPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(args ?? {}),
        signal: createTimeoutAwareSignal(context.signal, SLACK_TOOL_TIMEOUT_MS),
      },
    );

    const body = (await response.json()) as SlackDynamicToolFailureBody | { ok?: true; result?: unknown };
    if (!response.ok || body.ok === false) {
      const rawErrorCode = asNonEmptyString((body as SlackDynamicToolFailureBody).errorCode);
      const errorCode =
        rawErrorCode && isDynamicToolErrorCode(rawErrorCode) ? rawErrorCode : mapStatusToErrorCode(response.status);
      const errorText =
        asNonEmptyString((body as SlackDynamicToolFailureBody).error) ??
        `Slack dynamic tool request failed with HTTP ${response.status}.`;
      return dynamicToolFailureResult(errorCode, errorText);
    }

    return createDynamicToolJsonSuccess((body as { result?: unknown }).result ?? null);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult(DYNAMIC_TOOL_ERROR_CODES.CANCELLED, "Slack dynamic tool request was cancelled.");
    }
    return dynamicToolFailureResult(
      DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR,
      `Slack dynamic tool request failed: ${String(error)}`,
    );
  }
}

function mapStatusToErrorCode(status: number): DynamicToolErrorCode {
  if (status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (status === 403) return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
  if (status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (status === 409) return DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED;
  if (status === 429) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

export const buildSlackGetThreadDynamicToolSpec = buildSlackDynamicToolSpec(
  SLACK_GET_THREAD_DYNAMIC_TOOL_NAME,
  "Read a Slack thread by channel ID and root message timestamp.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      channel: { type: "string", minLength: 1 },
      ts: { type: "string", minLength: 1 },
    },
    required: ["channel", "ts"],
  },
);

export const buildSlackSearchMessagesDynamicToolSpec = buildSlackDynamicToolSpec(
  SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME,
  "Search Slack messages in the current workspace.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1 },
      channel: { type: "string", minLength: 1 },
      count: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
);

export const buildSlackSendMessageDynamicToolSpec = buildSlackDynamicToolSpec(
  SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME,
  "Send a Slack message to a channel or thread in the current workspace.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      channel: { type: "string", minLength: 1 },
      threadTs: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1, maxLength: 4096 },
    },
    required: ["channel", "text"],
  },
);

export async function executeSlackGetThreadDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeSlackProxyCall("get-thread", args, context);
}

export async function executeSlackSearchMessagesDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeSlackProxyCall("search-messages", args, context);
}

export async function executeSlackSendMessageDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeSlackProxyCall("send-message", args, context);
}

export function redactSlackDynamicToolInputForPersistence(
  name: string,
  args: unknown,
): Record<string, unknown> | undefined {
  if (name !== SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME) return undefined;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { textRedacted: true };
  }
  const input = args as Record<string, unknown>;
  const channel = asNonEmptyString(input.channel);
  const threadTs = asNonEmptyString(input.threadTs);
  const text = asNonEmptyString(input.text);
  return {
    ...(channel ? { channel } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(text ? { textLength: text.length } : {}),
    textRedacted: true,
  };
}
