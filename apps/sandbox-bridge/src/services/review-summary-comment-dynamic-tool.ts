import { buildControlPlaneReviewTool } from "./control-plane-review-tool.js";
import { DYNAMIC_TOOL_ERROR_CODES, type DynamicToolErrorCode } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "./memory-dynamic-tool.js";

export const REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME = "review_summary_comment";

const REVIEW_SUMMARY_COMMENT_TOOL_TIMEOUT_MS = 10_000;

const BODY_MAX_BYTES = 8 * 1024; // 8 KB

type ReviewSummaryCommentFailureBody = {
  ok?: false;
  reason?: unknown;
  error?: unknown;
};

type ReviewSummaryCommentResponseBody = ReviewSummaryCommentFailureBody | { ok?: true; [key: string]: unknown };

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSummaryCommentInput(args: unknown): {
  epochId: string;
  body: string;
  promptId?: string;
} | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const epochId = stringField(input.epochId);
  const body = stringField(input.body);
  if (!epochId || !body) return null;
  const promptId = stringField(input.promptId);
  return { epochId, body, ...(promptId ? { promptId } : {}) };
}

function mapStatusToErrorCode(status: number): DynamicToolErrorCode {
  if (status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (status === 403) return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
  if (status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (status === 409) return DYNAMIC_TOOL_ERROR_CODES.BLOCKED;
  if (status === 429 || status === 503) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

const executeReviewSummaryCommentRequest = buildControlPlaneReviewTool<
  NonNullable<ReturnType<typeof normalizeSummaryCommentInput>>,
  ReviewSummaryCommentResponseBody
>({
  normalizeInput: normalizeSummaryCommentInput,
  invalidInputMessage: "cycloid.review_summary_comment requires { epochId: string, body: string, promptId?: string }.",
  limit: {
    measure: (input) => Buffer.byteLength(input.body, "utf8"),
    max: BODY_MAX_BYTES,
    message: `cycloid.review_summary_comment body must not exceed ${BODY_MAX_BYTES} bytes.`,
  },
  path: "/review-loop/summary-comment",
  timeoutMs: REVIEW_SUMMARY_COMMENT_TOOL_TIMEOUT_MS,
  notConnectedMessage: "Review-summary-comment routing is not configured for this session.",
  cancelledMessage: "Review-summary-comment request was cancelled.",
  failurePrefix: "Review-summary-comment request failed",
  parseResponse: (response) => response.json() as Promise<ReviewSummaryCommentResponseBody>,
  isSuccess: (response, body) => response.ok && body.ok !== false,
  renderSuccess: (body) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(body) }] }),
  mapError: (response, body) => {
    const reason = stringField((body as ReviewSummaryCommentFailureBody).reason) ?? stringField(body.error);
    return {
      errorCode: mapStatusToErrorCode(response.status),
      text: reason ?? `Review-summary-comment request failed with HTTP ${response.status}.`,
    };
  },
});

export function buildReviewSummaryCommentDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME,
      description:
        "Post a summary comment on the pull request for the current review-loop session. Only works for active human or mixed review-loop prompts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          epochId: { type: "string", minLength: 1 },
          promptId: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1, maxLength: BODY_MAX_BYTES },
        },
        required: ["epochId", "body"],
      },
    },
  ];
}

export async function executeReviewSummaryCommentDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeReviewSummaryCommentRequest(args, context);
}

export function redactReviewSummaryCommentDynamicToolInput(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { bodyRedacted: true };
  const input = args as Record<string, unknown>;
  const epochId = stringField(input.epochId);
  const promptId = stringField(input.promptId);
  const body = stringField(input.body);
  return {
    ...(epochId ? { epochId } : {}),
    ...(promptId ? { promptId } : {}),
    ...(body ? { bodyLength: Buffer.byteLength(body, "utf8") } : {}),
    bodyRedacted: true,
  };
}
