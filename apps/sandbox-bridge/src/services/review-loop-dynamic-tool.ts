import {
  CYCLOID_DYNAMIC_TOOL_NAMESPACE,
  REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME,
} from "../../../../shared/constants/dynamic-tool-names.js";
import { buildControlPlaneReviewTool } from "./control-plane-review-tool.js";
import { DYNAMIC_TOOL_ERROR_CODES, type DynamicToolErrorCode } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
export { REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME } from "../../../../shared/constants/dynamic-tool-names.js";

const REVIEW_LOOP_TOOL_TIMEOUT_MS = 10_000;

type ReviewLoopReplyFailureBody = {
  ok?: false;
  reason?: unknown;
  error?: unknown;
};

type ReviewLoopReplyResponseBody = ReviewLoopReplyFailureBody | { ok?: true; [key: string]: unknown };

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeReplyInput(args: unknown): {
  epochId: string;
  targetSourceId: string;
  verdict: "fixed" | "replied" | "declined";
  body: string;
  promptId?: string;
} | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const epochId = stringField(input.epochId);
  const targetSourceId = stringField(input.targetSourceId);
  const verdict = stringField(input.verdict);
  const body = stringField(input.body);
  if (!epochId || !targetSourceId || !body) return null;
  if (verdict !== "fixed" && verdict !== "replied" && verdict !== "declined") return null;
  const promptId = stringField(input.promptId);
  return { epochId, targetSourceId, verdict, body, ...(promptId ? { promptId } : {}) };
}

function mapStatusToErrorCode(status: number): DynamicToolErrorCode {
  if (status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (status === 403) return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
  if (status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (status === 409) return DYNAMIC_TOOL_ERROR_CODES.BLOCKED;
  if (status === 429 || status === 503) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

const executeReviewLoopReplyRequest = buildControlPlaneReviewTool<
  NonNullable<ReturnType<typeof normalizeReplyInput>>,
  ReviewLoopReplyResponseBody
>({
  normalizeInput: normalizeReplyInput,
  invalidInputMessage:
    "cycloid.review_loop_reply requires { epochId: string, targetSourceId: string, verdict: 'fixed' | 'replied' | 'declined', body: string, promptId?: string }.",
  path: "/review-loop/reply",
  timeoutMs: REVIEW_LOOP_TOOL_TIMEOUT_MS,
  notConnectedMessage: "Review-loop reply routing is not configured for this session.",
  cancelledMessage: "Review-loop reply request was cancelled.",
  failurePrefix: "Review-loop reply request failed",
  parseResponse: (response) => response.json() as Promise<ReviewLoopReplyResponseBody>,
  isSuccess: (response, body) => response.ok && body.ok !== false,
  renderSuccess: (body) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(body) }] }),
  mapError: (response, body) => {
    const reason = stringField((body as ReviewLoopReplyFailureBody).reason) ?? stringField(body.error);
    return {
      errorCode: mapStatusToErrorCode(response.status),
      text: reason ?? `Review-loop reply request failed with HTTP ${response.status}.`,
    };
  },
});

export function buildReviewLoopReplyDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME,
      description:
        "Post a guarded source-linked verdict reply to a review-loop worklist item. Only works for active review-loop prompts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          epochId: { type: "string", minLength: 1 },
          promptId: { type: "string", minLength: 1 },
          targetSourceId: { type: "string", minLength: 1 },
          verdict: { type: "string", enum: ["fixed", "replied", "declined"] },
          body: { type: "string", minLength: 1, maxLength: 4096 },
        },
        required: ["epochId", "targetSourceId", "verdict", "body"],
      },
    },
  ];
}

export async function executeReviewLoopReplyDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeReviewLoopReplyRequest(args, context);
}

export function redactReviewLoopReplyDynamicToolInput(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { bodyRedacted: true };
  const input = args as Record<string, unknown>;
  const epochId = stringField(input.epochId);
  const promptId = stringField(input.promptId);
  const targetSourceId = stringField(input.targetSourceId);
  const verdict = stringField(input.verdict);
  const body = stringField(input.body);
  return {
    ...(epochId ? { epochId } : {}),
    ...(promptId ? { promptId } : {}),
    ...(targetSourceId ? { targetSourceId } : {}),
    ...(verdict ? { verdict } : {}),
    ...(body ? { bodyLength: body.length } : {}),
    bodyRedacted: true,
  };
}
