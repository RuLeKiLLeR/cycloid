import { isCancellationError } from "./cancellation.js";
import type { FirstPartyDynamicToolCallResult } from "./first-party-dynamic-tools.js";

const DYNAMIC_TOOL_JSON_RESPONSE_MAX_CHARS = 64 * 1024;
const TRUNCATED_MARKER = "\n\n[truncated]";

export const DYNAMIC_TOOL_ERROR_CODES = {
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
  EXECUTION_FAILED: "execution_failed",
  FORBIDDEN: "forbidden",
  GRAPHQL_ERROR: "graphql_error",
  INVALID_CREDENTIAL: "invalid_credential",
  INVALID_INPUT: "invalid_input",
  LIMIT_EXCEEDED: "limit_exceeded",
  MANUAL_RENAME: "manual_rename",
  MISSING_BINARY: "missing_binary",
  NOT_CONNECTED: "not_connected",
  NOT_FOUND: "not_found",
  NOT_REGISTERED: "not_registered",
  SCOPE_MISSING: "scope_missing",
  TIMED_OUT: "timed_out",
  TOKEN_EXPIRED: "token_expired",
  UPSTREAM_ERROR: "upstream_error",
  UPSTREAM_HTTP_ERROR: "upstream_http_error",
  UPSTREAM_RATE_LIMITED: "upstream_rate_limited",
  WORKSPACE_UNKNOWN: "workspace_unknown",
  WORKSPACE_UNINSTALLED: "workspace_uninstalled",
} as const;

export type DynamicToolErrorCode = (typeof DYNAMIC_TOOL_ERROR_CODES)[keyof typeof DYNAMIC_TOOL_ERROR_CODES];

const DYNAMIC_TOOL_ERROR_CODE_SET = new Set<string>(Object.values(DYNAMIC_TOOL_ERROR_CODES));

export const DYNAMIC_TOOL_ERROR_GUIDANCE: Partial<Record<DynamicToolErrorCode, string>> = {
  [DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN]:
    "Verify the identifier and arguments before retrying; do not repeat the identical call.",
  [DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL]:
    "Ask the user to reconnect the integration in Cycloid settings. Never ask the user to paste secrets.",
  [DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT]: "Fix the arguments to match the tool schema and retry.",
  [DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED]: "Hard cap reached. Do not retry; adjust your plan.",
  [DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED]:
    "This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
  [DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND]:
    "Verify the identifier and arguments before retrying; do not repeat the identical call.",
  [DYNAMIC_TOOL_ERROR_CODES.NOT_REGISTERED]:
    "This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
  [DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING]:
    "The integration lacks a required scope. Tell the user which action failed so they can re-grant access.",
  [DYNAMIC_TOOL_ERROR_CODES.TIMED_OUT]: "Retry once with a narrower request (smaller range, fewer results).",
  [DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED]:
    "Ask the user to reconnect the integration in Cycloid settings. Never ask the user to paste secrets.",
  [DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED]:
    "Automatic retries were already attempted. Continue other work and try again later; do not immediately retry.",
  [DYNAMIC_TOOL_ERROR_CODES.WORKSPACE_UNKNOWN]:
    "The Slack workspace is not installed for this business. Report it; do not retry.",
  [DYNAMIC_TOOL_ERROR_CODES.WORKSPACE_UNINSTALLED]:
    "The Slack workspace is not installed for this business. Report it; do not retry.",
};

export function isDynamicToolErrorCode(value: string): value is DynamicToolErrorCode {
  return DYNAMIC_TOOL_ERROR_CODE_SET.has(value);
}

export class DynamicToolError extends Error {
  constructor(
    message: string,
    readonly code: DynamicToolErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DynamicToolError";
  }
}

export function mapDynamicToolErrorCode(
  error: DynamicToolError,
  options: {
    passthrough: readonly DynamicToolErrorCode[];
    statusCodes: Readonly<Record<number, DynamicToolErrorCode>>;
    defaultCode?: DynamicToolErrorCode;
  },
): DynamicToolErrorCode {
  if (options.passthrough.includes(error.code)) return error.code;
  if (error.status !== undefined) {
    const mapped = options.statusCodes[error.status];
    if (mapped) return mapped;
  }
  return options.defaultCode ?? DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

export function createDynamicToolFailure(
  errorCode: DynamicToolErrorCode,
  text: string,
  retryAfterMs?: number,
): FirstPartyDynamicToolCallResult {
  return {
    success: false,
    errorCode,
    contentItems: [{ type: "inputText", text }],
    ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
  };
}

export function appendRecoveryGuidance(result: FirstPartyDynamicToolCallResult): FirstPartyDynamicToolCallResult {
  if (result.success || !result.errorCode) return result;
  const guidance = DYNAMIC_TOOL_ERROR_GUIDANCE[result.errorCode];
  if (!guidance) return result;
  const textIndex = result.contentItems.findIndex((item) => item.type === "inputText");
  if (textIndex === -1) return result;
  const textItem = result.contentItems[textIndex];
  if (textItem?.type === "inputText" && textItem.text.includes("\n\nRecovery:")) return result;

  return {
    ...result,
    contentItems: result.contentItems.map((item, index) =>
      index === textIndex && item.type === "inputText"
        ? { ...item, text: `${item.text}\n\nRecovery: ${guidance}` }
        : item,
    ),
  };
}

export function createDynamicToolTextSuccess(text: string): FirstPartyDynamicToolCallResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

export function buildDynamicToolErrorResult(params: {
  error: unknown;
  cancelledMessage: string;
  mapErrorCode: (error: DynamicToolError) => DynamicToolErrorCode;
  unexpectedMessage: (error: unknown) => string;
}): FirstPartyDynamicToolCallResult {
  if (isCancellationError(params.error)) {
    return createDynamicToolFailure(DYNAMIC_TOOL_ERROR_CODES.CANCELLED, params.cancelledMessage);
  }
  if (params.error instanceof DynamicToolError) {
    return createDynamicToolFailure(params.mapErrorCode(params.error), params.error.message, params.error.retryAfterMs);
  }
  return createDynamicToolFailure(DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR, params.unexpectedMessage(params.error));
}

export function createDynamicToolJsonSuccess(
  payload: unknown,
  options: { truncateText?: boolean } = {},
): FirstPartyDynamicToolCallResult {
  const rawText = JSON.stringify(payload);
  const text = options.truncateText ? truncateResponseText(rawText) : rawText;
  return createDynamicToolTextSuccess(text);
}

export function truncateWithMarker(value: string, maxChars: number, marker = TRUNCATED_MARKER): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function truncateResponseText(value: string): string {
  return truncateWithMarker(value, DYNAMIC_TOOL_JSON_RESPONSE_MAX_CHARS);
}
