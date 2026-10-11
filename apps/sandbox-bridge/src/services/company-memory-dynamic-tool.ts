import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { isCancellationError } from "./cancellation.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import {
  createDynamicToolFailure as failure,
  createDynamicToolJsonSuccess,
  createDynamicToolTextSuccess,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import {
  CYCLOID_DYNAMIC_TOOL_NAMESPACE,
  MEMORY_INTENT_MAX_CHARS,
  MEMORY_TITLE_MAX_CHARS,
} from "./memory-dynamic-tool.js";
import { buildDecisionTrace, extractDecisionTraceCandidateIds, stringField } from "./trace-field-helpers.js";

export const COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME = "company_memory_recall";
export const COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME = "company_memory_reasoning_chain";

const COMPANY_MEMORY_TOOL_TIMEOUT_MS = 10_000;

function createSignal(signal: AbortSignal | undefined): AbortSignal {
  return createTimeoutAwareSignal(signal, COMPANY_MEMORY_TOOL_TIMEOUT_MS);
}

async function readCompanyMemoryResponse(response: Response): Promise<{
  ok?: boolean;
  block?: string;
  memories?: unknown;
  retrievalTrace?: unknown;
  memory?: unknown;
  sources?: unknown;
  error?: string;
} | null> {
  try {
    return (await response.json()) as {
      ok?: boolean;
      block?: string;
      memories?: unknown;
      retrievalTrace?: unknown;
      memory?: unknown;
      sources?: unknown;
      error?: string;
    };
  } catch (error) {
    // A timeout fired mid-body-stream throws TimeoutError here; propagate it so the
    // outer handler maps it to `cancelled` instead of collapsing to an upstream_error.
    if (isCancellationError(error)) throw error;
    return null;
  }
}

function buildSpec(name: string, description: string, inputSchema: Record<string, unknown>) {
  return (env: NodeJS.ProcessEnv | Record<string, string>): FirstPartyDynamicToolSpec[] =>
    env["SESSION_ID"]?.trim() && env["SANDBOX_AUTH_TOKEN"]?.trim()
      ? [{ namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE, name, description, inputSchema }]
      : [];
}

async function executeCompanyMemoryCall(
  endpoint: "query" | "reasoning-chain",
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"]);
  const sessionId = context.env["SESSION_ID"]?.trim();
  const sandboxAuthToken = context.env["SANDBOX_AUTH_TOKEN"]?.trim();
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) {
    return failure("not_connected", "Company memory routing is not configured for this session.");
  }
  const path = endpoint === "query" ? "memory/context" : "company-memory/reasoning-chain";
  try {
    const response = await (context.fetchImpl ?? fetch)(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/sandbox/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(endpoint === "query" ? companyMemoryContextArgs(args) : (args ?? {})),
        signal: createSignal(context.signal),
      },
    );
    const body = await readCompanyMemoryResponse(response);
    if (!body) return failure("upstream_error", "Company memory unavailable for this turn.");
    if (!response.ok || body.ok === false) {
      return failure("upstream_error", body.error ?? "Company memory unavailable for this turn.");
    }
    if (endpoint === "query") {
      recordCompanyMemoryRecallTelemetry(args, body, context);
      return createDynamicToolTextSuccess(body.block ?? "");
    }
    return createDynamicToolJsonSuccess({ memory: body.memory, sources: body.sources });
  } catch (error) {
    if (isCancellationError(error)) return failure("cancelled", "Company memory request was cancelled.");
    return failure("upstream_error", "Company memory unavailable for this turn.");
  }
}

function objectArgs(args: unknown): Record<string, unknown> | null {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
}

function companyMemoryContextArgs(args: unknown): Record<string, unknown> {
  const input = objectArgs(args) ?? {};
  const { topK, ...rest } = input;
  return {
    ...rest,
    mode: "company",
    ...(typeof topK === "number" && Number.isFinite(topK) ? { maxMemories: topK } : {}),
  };
}

function recordCompanyMemoryRecallTelemetry(
  args: unknown,
  body: { memories?: unknown; retrievalTrace?: unknown },
  context: FirstPartyDynamicToolExecuteContext,
): void {
  const memories = Array.isArray(body.memories) ? body.memories : [];
  const returnedMemories = memories.flatMap((memory, index) => {
    if (!memory || typeof memory !== "object") return [];
    const record = memory as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    if (!id) return [];
    const claim =
      typeof record.claim === "string" && record.claim.trim()
        ? record.claim.trim()
        : typeof record.content === "string" && record.content.trim()
          ? record.content.trim()
          : id;
    return [
      {
        id,
        title: claim.slice(0, MEMORY_TITLE_MAX_CHARS),
        selectionRank: index + 1,
        ...(typeof record.score === "number" && Number.isFinite(record.score) ? { selectionScore: record.score } : {}),
      },
    ];
  });
  const returnedMemoryIds = returnedMemories.map((memory) => memory.id);
  const retrievalTrace =
    body.retrievalTrace && typeof body.retrievalTrace === "object"
      ? (body.retrievalTrace as Record<string, unknown>)
      : undefined;
  const candidateIds = companyMemoryCandidateIds(retrievalTrace, returnedMemoryIds);
  const requestedMemoryIds = candidateIds.length > 0 ? candidateIds : ["company_memory_query"];
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const intent = typeof input.intent === "string" ? input.intent.slice(0, MEMORY_INTENT_MAX_CHARS) : "";
  const files = Array.isArray(input.files)
    ? input.files.filter((file): file is string => typeof file === "string")
    : [];
  context.recordTelemetry?.("memory_recall.returned", {
    requestedMemoryIds,
    requestedMemories: requestedMemoryIds.map((id) => ({ id })),
    returnedMemoryIds,
    returnedMemories,
    usageSource: "company_recall",
    intent,
    files,
    repoOwner: process.env.REPO_OWNER || undefined,
    repoName: process.env.REPO_NAME || undefined,
    decisionTrace: buildCompanyMemoryDecisionTrace({
      intent,
      files,
      candidateIds,
      returnedMemories,
      retrievalTrace,
    }),
    ...(retrievalTrace ? { retrievalTrace } : {}),
  });
}

function companyMemoryCandidateIds(
  retrievalTrace: Record<string, unknown> | undefined,
  fallbackIds: string[],
): string[] {
  return extractDecisionTraceCandidateIds(retrievalTrace, { fallbackIds });
}

function buildCompanyMemoryDecisionTrace(params: {
  intent: string;
  files: string[];
  candidateIds: string[];
  returnedMemories: Array<{ id: string; title?: string; selectionRank?: number; selectionScore?: number }>;
  retrievalTrace: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  return buildDecisionTrace({
    toolName: "cycloid.company_memory_recall",
    traceId: stringField(params.retrievalTrace, "traceId") ?? "unavailable",
    intent: params.intent,
    files: params.files,
    candidateIds: params.candidateIds,
    returnedIds: params.returnedMemories.map((memory) => memory.id),
    returnedMemories: params.returnedMemories,
    retrievalTrace: params.retrievalTrace,
  });
}

export const buildCompanyMemoryRecallDynamicToolSpec = buildSpec(
  COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME,
  "Retrieve company-wide memory such as decisions, constraints, dead ends, preferences, and prior commitments.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", description: "What you need to know or decide." },
      files: { type: "array", items: { type: "string" } },
      customer: { type: "string" },
      topK: { type: "number" },
      includeActionItems: {
        type: "boolean",
        description: "Set true when the task needs remembered todos, owners, or follow-up work.",
      },
      includeOpenQuestions: {
        type: "boolean",
        description: "Set true when the task needs unresolved questions, monitoring items, or watch points.",
      },
    },
    required: ["intent"],
  },
);

export const buildCompanyMemoryReasoningChainDynamicToolSpec = buildSpec(
  COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME,
  "Fetch source provenance for a company-memory claim id.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      memoryId: { type: "string", description: "The company memory id to inspect." },
    },
    required: ["memoryId"],
  },
);

export function executeCompanyMemoryRecallDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeCompanyMemoryCall("query", args, context);
}

export function executeCompanyMemoryReasoningChainDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeCompanyMemoryCall("reasoning-chain", args, context);
}
