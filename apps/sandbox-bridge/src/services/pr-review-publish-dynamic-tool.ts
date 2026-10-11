import { existsSync } from "node:fs";
import path from "node:path";

import { REVIEW_AGENT_NAME } from "../../../../shared/agent/constants.js";
import { buildControlPlaneReviewTool } from "./control-plane-review-tool.js";
import { DYNAMIC_TOOL_ERROR_CODES, type DynamicToolErrorCode } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "./memory-dynamic-tool.js";
import type { ReviewCheckRecord } from "./pr-review-checks.js";

export const PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME = "publish_pr_review";
const TIMEOUT_MS = 30_000;
const DEFAULT_PUBLISH_CONTRACT_KEY = "__default__";
const publishedPromptContractKeys = new Set<string>();
const promptCheckEvidence = new Map<string, string>();
export const MAX_PR_REVIEW_CITATIONS = 5;
export const MAX_PR_REVIEW_CITATION_CHARS = 240;

function publishContractKey(sessionId: string | undefined): string {
  return sessionId?.trim() || DEFAULT_PUBLISH_CONTRACT_KEY;
}

export function resetPrReviewPublishContract(sessionId?: string): void {
  if (sessionId === undefined) {
    publishedPromptContractKeys.clear();
    promptCheckEvidence.clear();
    return;
  }
  publishedPromptContractKeys.delete(publishContractKey(sessionId));
  promptCheckEvidence.delete(publishContractKey(sessionId));
}

export function setPrReviewPublishCheckEvidence(sessionId: string, records: ReviewCheckRecord[]): void {
  promptCheckEvidence.set(publishContractKey(sessionId), JSON.stringify(records));
}

export function didPublishPrReviewForCurrentPrompt(sessionId?: string): boolean {
  return publishedPromptContractKeys.has(publishContractKey(sessionId));
}

function normalizeInput(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function normalizeCitations(input: unknown, repoPath: string): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (citation): citation is string =>
        typeof citation === "string" &&
        citation.length > 0 &&
        citation.length <= MAX_PR_REVIEW_CITATION_CHARS &&
        !path.isAbsolute(citation) &&
        !citation.split("/").includes("..") &&
        existsSync(path.resolve(repoPath, citation)),
    )
    .slice(0, MAX_PR_REVIEW_CITATIONS);
}

function normalizePublicationInput(input: Record<string, unknown>, repoPath: string): Record<string, unknown> {
  const findings = Array.isArray(input.findings)
    ? input.findings.map((finding) => {
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
        const record = finding as Record<string, unknown>;
        const citations = normalizeCitations(record.citations, repoPath);
        return record.citations === undefined ? record : { ...record, citations };
      })
    : input.findings;
  return { ...input, findings };
}

function mapStatus(status: number): DynamicToolErrorCode {
  if (status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (status === 403) return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
  if (status === 409) return DYNAMIC_TOOL_ERROR_CODES.BLOCKED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

const executeRequest = buildControlPlaneReviewTool<Record<string, unknown>, Record<string, unknown>>({
  normalizeInput,
  invalidInputMessage: "cycloid.publish_pr_review requires a structured PR review payload.",
  path: "/pr-review/publish",
  timeoutMs: TIMEOUT_MS,
  notConnectedMessage: "PR review publication is not configured for this session.",
  cancelledMessage: "PR review publication was cancelled.",
  failurePrefix: "PR review publication failed",
  parseResponse: (response) => response.json() as Promise<Record<string, unknown>>,
  isSuccess: (response, body) => response.ok && body.ok === true,
  renderSuccess: (body, context) => {
    publishedPromptContractKeys.add(publishContractKey(context.env["SESSION_ID"]));
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(body) }] };
  },
  mapError: (response, body) => ({
    errorCode: mapStatus(response.status),
    text: typeof body.error === "string" ? body.error : `PR review publication failed with HTTP ${response.status}.`,
  }),
});

export function buildPrReviewPublishDynamicToolSpec(): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME,
      description:
        "Publish the current review profile's managed PR summary and formal inline COMMENT review. Call exactly once after completing review analysis.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summaryMarkdown: { type: "string", minLength: 1, maxLength: 60_000 },
          verdict: { type: "string", enum: ["clear", "issues_found", "inconclusive"] },
          checks: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                command: { type: "string", maxLength: 1_000 },
                reason: { type: "string", minLength: 1, maxLength: 500 },
                status: { type: "string", enum: ["passed", "failed", "skipped"] },
                exitCode: { type: ["integer", "null"] },
                detail: { type: "string", minLength: 1, maxLength: 500 },
              },
              required: ["command", "reason", "status", "exitCode", "detail"],
            },
          },
          scopeNotVerified: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1_000 } },
          confidenceScore: { type: "integer", minimum: 1, maximum: 5 },
          importantFiles: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" }, reason: { type: "string" } },
              required: ["path", "reason"],
            },
          },
          findings: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                line: { type: "integer", minimum: 1 },
                side: { type: "string", enum: ["RIGHT"] },
                severity: { type: "string", enum: ["P1", "P2"] },
                title: { type: "string" },
                confidence: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                  description:
                    "Per-finding confidence: 1 weak hunch, 2 plausible but incomplete, 3 concrete actionable scenario, 4 strong code evidence, 5 directly proven.",
                },
                bodyMarkdown: { type: "string" },
                security: { type: "boolean" },
                suggestion: { type: "string", minLength: 1, maxLength: 4_000, pattern: "^[^`\\r\\n]+$" },
                citations: {
                  type: "array",
                  maxItems: MAX_PR_REVIEW_CITATIONS,
                  items: { type: "string", minLength: 1, maxLength: MAX_PR_REVIEW_CITATION_CHARS },
                },
              },
              required: ["path", "line", "side", "severity", "title", "confidence", "bodyMarkdown"],
            },
          },
          headSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        },
        required: ["verdict", "checks", "scopeNotVerified", "confidenceScore", "importantFiles", "findings", "headSha"],
      },
    },
  ];
}

export async function executePrReviewPublishDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  if (context.agentProfile !== REVIEW_AGENT_NAME) {
    return {
      success: false,
      errorCode: DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN,
      contentItems: [{ type: "inputText", text: "PR review publication is restricted to review-profile sessions." }],
    };
  }
  const input = normalizeInput(args);
  const expectedChecks = promptCheckEvidence.get(publishContractKey(context.env["SESSION_ID"]));
  if (!expectedChecks || JSON.stringify(input?.checks) !== expectedChecks) {
    return {
      success: false,
      errorCode: DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      contentItems: [{ type: "inputText", text: "PR review check evidence must match the bridge preflight." }],
    };
  }
  return executeRequest(
    normalizePublicationInput(input ?? {}, context.cwd ?? context.env["REPO_PATH"] ?? process.cwd()),
    context,
  );
}

export function redactPrReviewPublishInput(args: unknown): Record<string, unknown> {
  const input = normalizeInput(args);
  return {
    headSha: typeof input?.headSha === "string" ? input.headSha : null,
    findingCount: Array.isArray(input?.findings) ? input.findings.length : 0,
    verdict: typeof input?.verdict === "string" ? input.verdict : null,
    checkCount: Array.isArray(input?.checks) ? input.checks.length : 0,
    citationCount: Array.isArray(input?.findings)
      ? input.findings.reduce(
          (count, finding) =>
            count +
            (finding && typeof finding === "object" && Array.isArray((finding as Record<string, unknown>).citations)
              ? ((finding as Record<string, unknown>).citations as unknown[]).length
              : 0),
          0,
        )
      : 0,
    markdownRedacted: true,
  };
}
