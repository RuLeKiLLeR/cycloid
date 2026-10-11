import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "../../../../shared/constants/dynamic-tool-names.js";
import type { MemoryRef } from "../../../../shared/events/bridge.js";
import {
  confidenceValue,
  enforcementValue,
  formatMemoryContextBlock,
  type MemoryContextBlockMemory,
} from "../../../../shared/memory/context-block.js";
import {
  buildRetrievalSignals,
  GENERIC_REPO_MEMORY_SYMBOL_TERMS,
  isPullRequestReferencedForRepo,
  isUsefulRecallEvidenceTerm,
  normalizeSignalTerms,
} from "../../../../shared/memory/retrieval-signals.js";
import { denoiseCurrentTaskText } from "../../../../shared/memory/task-denoising.js";
export { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "../../../../shared/constants/dynamic-tool-names.js";
import {
  MEMORY_CONFIDENCE_THRESHOLD,
  MEMORY_MAX_ACTIVE,
  MEMORY_RECALL_EVIDENCE_SCORE_WEIGHTS,
  MEMORY_RECALL_PATH_SPECIFICITY_WEIGHTS,
} from "../constants/bridge.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { memoryGlobMatches, memoryPathMatches, normalizeMemoryPath } from "../utils/memory-enforcement.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import {
  createDynamicToolFailure as failure,
  createDynamicToolTextSuccess as success,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { formatMemorySection, type Memory } from "./memory-ranking.js";
import { loadActiveRepoMemories, type LoadedRepoMemory } from "./repo-memory-files.js";
import {
  arrayField,
  booleanField,
  buildDecisionTrace,
  extractDecisionTraceCandidateIds,
  numberField,
  recordField,
  stringField,
} from "./trace-field-helpers.js";

export const MEMORY_CONTEXT_DYNAMIC_TOOL_NAME = "memory_context";
export const MEMORY_RECALL_DYNAMIC_TOOL_NAME = "memory_recall";

export const MEMORY_RECALL_TIMEOUT_MS = 25_000;
const MEMORY_RECALL_TASK_MAX_CHARS = 4_000;
const MEMORY_RECALL_MEMORY_PREVIEW_CHARS = 900;
const MEMORY_RECALL_MAX_CANDIDATES = 40;
/** Truncation length for the recorded `intent` on memory/trace payloads. */
export const MEMORY_INTENT_MAX_CHARS = 200;
/** Truncation length for a memory title/claim preview. */
export const MEMORY_TITLE_MAX_CHARS = 120;
/** Truncation length for decision-trace reason/effect fields. */
const MEMORY_TRACE_FIELD_MAX_CHARS = 300;
/** Truncation length for persisted current-task / recent-session summaries. */
const MEMORY_SESSION_SUMMARY_MAX_CHARS = 2_000;
const MEMORY_CONTEXT_KINDS = new Set([
  "repo_rule",
  "company_fact",
  "company_take",
  "session_observation",
  "derived_conclusion",
  "scope_card",
]);

type MemoryRecallInput = {
  intent: string;
  files?: string[];
  symbols?: string[];
  tool?: string;
};

type MemoryContextInput = MemoryRecallInput & {
  currentTaskSummary?: string;
  recentSessionSummary?: string | null;
  maxMemories?: number;
  mode?: "all" | "repo" | "company";
};

type MemoryRecallRanking = { id: string; score: number; reason?: string; expectedEffect?: string };
type MemoryRecallTrace = Record<string, unknown>;
type MemoryContextResponse = {
  ok?: boolean;
  memories?: unknown;
  traceId?: unknown;
  retrievalTrace?: unknown;
  repoRankings?: unknown;
  block?: unknown;
  error?: string;
};

export function buildMemoryRecallDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: MEMORY_RECALL_DYNAMIC_TOOL_NAME,
      description:
        "Recall reviewed repo memories relevant to the current plan, files, symbols, or tool action. Returns bounded guidance and never mutates files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", description: "What you are trying to do or decide now." },
          files: { type: "array", items: { type: "string" }, description: "Optional repo-relative files in scope." },
          symbols: { type: "array", items: { type: "string" }, description: "Optional symbols or commands in scope." },
          tool: { type: "string", description: "Optional tool name about to be used or just used." },
        },
        required: ["intent"],
      },
    },
  ];
}

export function buildMemoryContextDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: MEMORY_CONTEXT_DYNAMIC_TOOL_NAME,
      description:
        "Pull scoped Cycloid memory context for the current task across repo and company memory. Returns only explicitly requested memory with provenance and a trace id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", description: "What you are trying to do or decide now." },
          files: { type: "array", items: { type: "string" }, description: "Optional repo-relative files in scope." },
          symbols: { type: "array", items: { type: "string" }, description: "Optional symbols or commands in scope." },
          tool: { type: "string", description: "Optional tool name about to be used or just used." },
          currentTaskSummary: { type: "string" },
          recentSessionSummary: { type: ["string", "null"] },
          maxMemories: { type: "number", minimum: 1, maximum: 5 },
        },
        required: ["intent"],
      },
    },
  ];
}

export async function executeMemoryRecallDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const input = normalizeMemoryRecallInput(args);
  if (!input) {
    return failure(
      "invalid_input",
      "cycloid.memory_recall requires { intent: string, files?: string[], symbols?: string[], tool?: string }.",
    );
  }

  const contextResult = await requestMemoryContext({ ...input, mode: "repo" }, context);
  const { rawMemories, selectedRepoMemories, refByMemoryId, retrievalTrace } = contextResult;
  recordMemoryRecallReturned(context, input, rawMemories, selectedRepoMemories, refByMemoryId, retrievalTrace);
  if (refByMemoryId.size === 0) return success("No active repo memories are available for this repository.");
  if (selectedRepoMemories.length === 0) {
    return success("No active repo memories met the relevance threshold for this request.");
  }
  return success(formatMemorySection(selectedRepoMemories));
}

export async function executeMemoryContextDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const input = normalizeMemoryContextInput(args);
  if (!input) {
    return failure(
      "invalid_input",
      "cycloid.memory_context requires { intent: string, files?: string[], symbols?: string[], tool?: string, currentTaskSummary?: string, recentSessionSummary?: string | null, maxMemories?: number }.",
    );
  }
  const contextResult = await requestMemoryContext({ ...input, mode: "all" }, context);
  const memories = parseMemoryContextMemories(contextResult.response.memories).slice(0, input.maxMemories ?? 5);
  recordMemoryContextReturned(context, input, memories, contextResult.retrievalTrace, contextResult.traceId);
  return success(
    formatMemoryContextBlock(memories, contextResult.traceId, { unavailable: contextResult.controlPlaneUnavailable }),
  );
}

async function requestMemoryContext(
  input: MemoryContextInput,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<{
  response: MemoryContextResponse;
  traceId: string;
  rawMemories: Memory[];
  selectedRepoMemories: Memory[];
  refByMemoryId: Map<string, MemoryRef>;
  retrievalTrace?: MemoryRecallTrace;
  controlPlaneUnavailable: boolean;
}> {
  const repoPath = context.cwd ?? context.env.REPO_PATH ?? process.cwd();
  const { memories: rawMemories, refByMemoryId } = resolveRecallMemoryPool(context, repoPath);
  const memories = buildDeterministicRecallCandidatePool(rawMemories, input);
  const fetched = await fetchMemoryContextFromControlPlane(memories, input, context);
  const response = fetched ?? buildEmptyMemoryContextFallback("control_plane_unavailable", memories);
  const rankings = parseRankingsPayload(response.repoRankings, new Set(memories.map((memory) => memory.id)));
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const selectedRepoMemories = rankings
    .filter((ranking) => ranking.score >= MEMORY_CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(input.maxMemories ?? MEMORY_MAX_ACTIVE, MEMORY_MAX_ACTIVE))
    .flatMap((ranking, index) => {
      const memory = byId.get(ranking.id);
      return memory
        ? [
            {
              ...memory,
              selectionRank: index + 1,
              selectionScore: ranking.score,
              ...(ranking.reason ? { reason: ranking.reason } : {}),
              ...(ranking.expectedEffect ? { expectedEffect: ranking.expectedEffect } : {}),
            },
          ]
        : [];
    });
  return {
    response,
    traceId: typeof response.traceId === "string" && response.traceId.trim() ? response.traceId.trim() : "unavailable",
    rawMemories: memories,
    selectedRepoMemories,
    refByMemoryId,
    controlPlaneUnavailable: fetched === null,
    ...(response.retrievalTrace && typeof response.retrievalTrace === "object"
      ? { retrievalTrace: response.retrievalTrace as MemoryRecallTrace }
      : {}),
  };
}

function resolveRecallMemoryPool(
  context: FirstPartyDynamicToolExecuteContext,
  repoPath: string,
): { memories: Memory[]; refByMemoryId: Map<string, MemoryRef> } {
  if (context.repoMemories?.length) {
    const refByMemoryId = new Map<string, MemoryRef>();
    const memories: Memory[] = [];
    const seen = new Set<string>();
    const orderedMemories = [...context.repoMemories].sort((a, b) => {
      const aIsD1 = context.memoryRefById?.get(a.id)?.path?.startsWith("d1:") ? 1 : 0;
      const bIsD1 = context.memoryRefById?.get(b.id)?.path?.startsWith("d1:") ? 1 : 0;
      return bIsD1 - aIsD1;
    });
    for (const memory of orderedMemories) {
      if (!memory.id || seen.has(memory.id)) continue;
      seen.add(memory.id);
      memories.push(memory);
      refByMemoryId.set(memory.id, context.memoryRefById?.get(memory.id) ?? toContextMemoryRef(memory));
    }
    return { memories, refByMemoryId };
  }

  const loaded = loadActiveRepoMemories(repoPath);
  return {
    memories: loaded.map((entry) => entry.memory),
    refByMemoryId: new Map(loaded.map((entry) => [entry.memory.id, toMemoryRef(entry)] as const)),
  };
}

function recordMemoryRecallReturned(
  context: FirstPartyDynamicToolExecuteContext,
  input: MemoryRecallInput,
  requested: Memory[],
  returned: Memory[],
  refByMemoryId: ReadonlyMap<string, MemoryRef>,
  retrievalTrace?: MemoryRecallTrace,
): void {
  recordMemoryRecallTelemetry(context, "memory_recall.returned", {
    requestedMemoryIds: requested.map((memory) => memory.id),
    returnedMemoryIds: returned.map((memory) => memory.id),
    requestedMemories: requested.map((memory) => refByMemoryId.get(memory.id) ?? { id: memory.id }),
    returnedMemories: returned.map((memory) => toMemoryRefForReturned(memory, refByMemoryId)),
    intent: input.intent.slice(0, MEMORY_INTENT_MAX_CHARS),
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    tool: input.tool ?? null,
    repoOwner: process.env.REPO_OWNER || undefined,
    repoName: process.env.REPO_NAME || undefined,
    decisionTrace: buildMemoryDecisionTrace({
      toolName: "cycloid.memory_recall",
      traceId: traceIdFromRetrievalTrace(retrievalTrace),
      input,
      candidateIds: requested.map((memory) => memory.id),
      returnedIds: returned.map((memory) => memory.id),
      returnedMemories: returned.map((memory) => ({
        id: memory.id,
        reason: memory.reason ?? null,
        expectedEffect: memory.expectedEffect ?? null,
        selectionRank: memory.selectionRank ?? null,
        selectionScore: memory.selectionScore ?? null,
      })),
      retrievalTrace,
    }),
    ...(retrievalTrace ? { retrievalTrace } : {}),
  });
}

function isCompanyMemoryKind(kind: string): boolean {
  return kind === "company_fact" || kind === "company_take";
}

function recordMemoryContextReturned(
  context: FirstPartyDynamicToolExecuteContext,
  input: MemoryContextInput,
  returned: MemoryContextBlockMemory[],
  retrievalTrace: MemoryRecallTrace | undefined,
  traceId = "unavailable",
): void {
  const candidateIds = memoryContextCandidateIds(retrievalTrace);
  // Company facts/takes are resolved downstream (review loader, feedback
  // aggregation) under the company_recall source, so they must not be recorded
  // as repo/graph recall usage. Ranks stay from the combined selection order.
  const ranked = returned.map((memory, index) => ({ memory, selectionRank: index + 1 }));
  const repoReturned = ranked.filter(({ memory }) => !isCompanyMemoryKind(memory.kind));
  const companyReturned = ranked.filter(({ memory }) => isCompanyMemoryKind(memory.kind));
  recordMemoryRecallTelemetry(context, "memory_context.returned", {
    requestedMemoryIds: candidateIds,
    returnedMemoryIds: repoReturned.map(({ memory }) => memory.id),
    requestedMemories: candidateIds.map((id) => ({ id })),
    returnedMemories: repoReturned.map(({ memory, selectionRank }) => ({
      id: memory.id,
      title: memory.content.slice(0, MEMORY_TITLE_MAX_CHARS),
      selectionRank,
      reason: memory.whyReturned,
    })),
    usageSource: "recall",
    intent: input.intent.slice(0, MEMORY_INTENT_MAX_CHARS),
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    tool: input.tool ?? null,
    repoOwner: process.env.REPO_OWNER || undefined,
    repoName: process.env.REPO_NAME || undefined,
    decisionTrace: buildMemoryDecisionTrace({
      toolName: "cycloid.memory_context",
      traceId,
      input,
      candidateIds,
      returnedIds: returned.map((memory) => memory.id),
      returnedMemories: returned.map((memory, index) => ({
        id: memory.id,
        reason: memory.whyReturned,
        confidence: memory.confidence,
        enforcement: memory.enforcement,
        selectionRank: index + 1,
      })),
      retrievalTrace,
    }),
    ...(retrievalTrace ? { retrievalTrace } : {}),
  });
  if (companyReturned.length > 0) {
    recordMemoryRecallTelemetry(context, "memory_context.returned", {
      requestedMemoryIds: companyReturned.map(({ memory }) => memory.id),
      returnedMemoryIds: companyReturned.map(({ memory }) => memory.id),
      requestedMemories: companyReturned.map(({ memory }) => ({ id: memory.id })),
      returnedMemories: companyReturned.map(({ memory, selectionRank }) => ({
        id: memory.id,
        title: memory.content.slice(0, MEMORY_TITLE_MAX_CHARS),
        selectionRank,
        reason: memory.whyReturned,
      })),
      usageSource: "company_recall",
      intent: input.intent.slice(0, MEMORY_INTENT_MAX_CHARS),
      files: input.files ?? [],
      symbols: input.symbols ?? [],
      tool: input.tool ?? null,
      repoOwner: process.env.REPO_OWNER || undefined,
      repoName: process.env.REPO_NAME || undefined,
    });
  }
}

function toMemoryRef(entry: LoadedRepoMemory): MemoryRef {
  return {
    id: entry.memory.id,
    ...(entry.repoRelativePath ? { path: entry.repoRelativePath } : {}),
    ...(entry.title ? { title: entry.title } : {}),
  };
}

function toContextMemoryRef(memory: Memory): MemoryRef {
  return {
    id: memory.id,
    path: `d1:${memory.id}`,
    ...(memory.context_hint ? { title: memory.context_hint } : {}),
  };
}

function toMemoryRefForReturned(memory: Memory, refByMemoryId: ReadonlyMap<string, MemoryRef>): MemoryRef {
  const base = refByMemoryId.get(memory.id) ?? { id: memory.id };
  return {
    ...base,
    ...(memory.selectionRank ? { selectionRank: memory.selectionRank } : {}),
    ...(typeof memory.selectionScore === "number" ? { selectionScore: memory.selectionScore } : {}),
    ...(memory.reason ? { reason: memory.reason } : {}),
    ...(memory.expectedEffect ? { expectedEffect: memory.expectedEffect } : {}),
  };
}

function recordMemoryRecallTelemetry(
  context: FirstPartyDynamicToolExecuteContext,
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    context.recordTelemetry?.(event, fields);
  } catch {
    // Recall telemetry is best-effort and must never fail the tool call.
  }
}

function traceIdFromRetrievalTrace(retrievalTrace: MemoryRecallTrace | undefined): string {
  if (!retrievalTrace) return "unavailable";
  const traceId = retrievalTrace.traceId;
  return typeof traceId === "string" && traceId.trim() ? traceId.trim() : "unavailable";
}

function memoryContextCandidateIds(retrievalTrace: MemoryRecallTrace | undefined): string[] {
  const repoTrace = repoCandidateTraceRecord(retrievalTrace);
  return extractDecisionTraceCandidateIds(retrievalTrace, {
    extraCandidates: [...arrayField(repoTrace?.selectedCandidates), ...arrayField(repoTrace?.rejectedCandidates)],
  });
}

function buildMemoryDecisionTrace(params: {
  toolName: string;
  traceId: string;
  input: MemoryRecallInput;
  candidateIds: string[];
  returnedIds: string[];
  returnedMemories: Array<Record<string, unknown>>;
  retrievalTrace: MemoryRecallTrace | undefined;
}): Record<string, unknown> {
  const trace = params.retrievalTrace;
  const repo = repoCandidateTraceRecord(trace);
  return buildDecisionTrace({
    toolName: params.toolName,
    traceId: params.traceId,
    intent: params.input.intent.slice(0, 500),
    files: params.input.files ?? [],
    candidateIds: params.candidateIds,
    returnedIds: params.returnedIds,
    returnedMemories: params.returnedMemories,
    retrievalTrace: trace,
    extraInput: { symbols: params.input.symbols ?? [], tool: params.input.tool ?? null },
    includeSelectorLatency: true,
    includeSelectorConfidence: true,
    repo: {
      candidateCount: numberField(repo, "candidateCount"),
      selectedCount: numberField(repo, "selectedCount"),
      returnedEmpty: booleanField(repo, "returnedEmpty"),
      timedOut: booleanField(repo, "timedOut"),
      selected: compactRepoCandidateDecisions(arrayField(repo?.selectedCandidates)),
      rejected: compactRepoCandidateDecisions(arrayField(repo?.rejectedCandidates)),
    },
  });
}

function repoCandidateTraceRecord(trace: MemoryRecallTrace | undefined): Record<string, unknown> | undefined {
  const topLevel = recordField(trace);
  const nested = recordField(trace, "repo");
  if (!topLevel && !nested) return undefined;
  return {
    candidateCount: numberField(nested, "candidateCount") ?? numberField(topLevel, "candidateCount"),
    selectedCount: numberField(nested, "selectedCount") ?? numberField(topLevel, "selectedCount"),
    returnedEmpty: booleanField(nested, "returnedEmpty") ?? booleanField(topLevel, "returnedEmpty"),
    timedOut: booleanField(nested, "timedOut") ?? booleanField(topLevel, "timedOut"),
    selectedCandidates: arrayField(nested?.selectedCandidates).length
      ? arrayField(nested?.selectedCandidates)
      : arrayField(topLevel?.selectedCandidates),
    rejectedCandidates: arrayField(nested?.rejectedCandidates).length
      ? arrayField(nested?.rejectedCandidates)
      : arrayField(topLevel?.rejectedCandidates),
  };
}

function compactRepoCandidateDecisions(entries: unknown[]): Array<Record<string, unknown>> {
  return entries.slice(0, 30).flatMap((entry): Array<Record<string, unknown>> => {
    const record = recordField(entry);
    const memoryId = stringField(record, "memoryId");
    if (!memoryId) return [];
    return [
      {
        memoryId,
        candidateChannels: arrayField(record?.candidateChannels).filter(
          (value): value is string => typeof value === "string",
        ),
        bridgeCandidateChannels: arrayField(record?.bridgeCandidateChannels).filter(
          (value): value is string => typeof value === "string",
        ),
        matchedTerms: recordField(record, "matchedTerms") ?? {},
        finalScore: numberField(record, "finalScore"),
        decision: stringField(record, "decision"),
        rejectReason: stringField(record, "rejectReason"),
        sourceArtifactId: stringField(record, "sourceArtifactId"),
      },
    ];
  });
}

function normalizeMemoryRecallInput(args: unknown): MemoryRecallInput | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const intent = typeof input.intent === "string" && input.intent.trim() ? input.intent.trim() : null;
  if (!intent) return null;
  const files = recallFilesFromInput(intent, stringArray(input.files));
  const symbols = stringArray(input.symbols);
  return {
    intent,
    ...(files?.length ? { files } : {}),
    ...(symbols?.length ? { symbols } : {}),
    ...(typeof input.tool === "string" && input.tool.trim() ? { tool: input.tool.trim() } : {}),
  };
}

function recallFilesFromInput(intent: string, files: string[] | undefined): string[] | undefined {
  const signals = buildRetrievalSignals({ text: intent, files: files ?? [] });
  return signals.files.length ? signals.files : undefined;
}

async function fetchMemoryContextFromControlPlane(
  memories: Memory[],
  input: MemoryContextInput,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<MemoryContextResponse | null> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env.CONTROL_PLANE_URL ?? context.env.ARCANIST_API_URL);
  const sessionId = context.env.SESSION_ID?.trim();
  const sandboxAuthToken = context.env.SANDBOX_AUTH_TOKEN?.trim();
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) return null;
  try {
    const response = await (context.fetchImpl ?? fetch)(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/sandbox/memory/context`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          mode: input.mode ?? "all",
          intent: input.intent.slice(0, MEMORY_RECALL_TASK_MAX_CHARS),
          files: input.files ?? [],
          symbols: input.symbols ?? [],
          tool: input.tool ?? null,
          currentTaskSummary: input.currentTaskSummary ?? input.intent.slice(0, MEMORY_RECALL_TASK_MAX_CHARS),
          recentSessionSummary: input.recentSessionSummary ?? null,
          maxMemories: input.maxMemories ?? 5,
          sourcePrNumbers: [],
          sourceSessionIds: [],
          memories: buildMemoryRecallRankingCandidates(memories),
        }),
        signal: createTimeoutAwareSignal(context.signal, MEMORY_RECALL_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as MemoryContextResponse | null;
    if (!response.ok || !body || body.ok === false) return null;
    return body;
  } catch {
    return null;
  }
}

function buildMemoryRecallRankingCandidates(memories: Memory[]) {
  return memories.map((memory) => ({
    id: memory.id,
    type: memory.memory_type ?? memory.type,
    action_type: memory.action_type ?? null,
    level: memory.level ?? null,
    primitive: memory.primitive ?? null,
    authority: memory.authority ?? null,
    enforcement: memory.enforcement ?? null,
    context_hint: memory.context_hint,
    applies_to: memory.applies_to,
    candidate_channels: candidateChannels(memory),
    source_pr_number:
      (memory as Memory & { sourcePrNumber?: number; source_pr_number?: number }).sourcePrNumber ??
      (memory as Memory & { source_pr_number?: number }).source_pr_number ??
      null,
    source_session_ids:
      (memory as Memory & { sourceSessionIds?: string[]; source_session_ids?: string[] }).sourceSessionIds ??
      (memory as Memory & { source_session_ids?: string[] }).source_session_ids ??
      [],
    triggers: memory.triggers ?? null,
    symbols: (memory as Memory & { symbols?: string[] }).symbols ?? [],
    subjects: (memory as Memory & { subjects?: string[] }).subjects ?? [],
    tags: (memory as Memory & { tags?: string[] }).tags ?? [],
    content: memory.content.slice(0, MEMORY_RECALL_MEMORY_PREVIEW_CHARS),
  }));
}

function buildEmptyMemoryContextFallback(vectorUnavailableReason: string, memories: Memory[]): MemoryContextResponse {
  return {
    ok: true,
    traceId: "unavailable",
    repoRankings: [],
    memories: [],
    retrievalTrace: {
      retrievalConfigVersion: "memory-context-compat-v1",
      traceId: "unavailable",
      vectorAvailable: false,
      vectorUnavailableReason,
      candidates: memories.map((memory) => ({
        id: memory.id,
        channels: candidateChannels(memory),
      })),
      candidateCount: memories.length,
      selectorStatus: "not_run",
    },
  };
}

function buildDeterministicRecallCandidatePool(memories: Memory[], input: MemoryRecallInput): Memory[] {
  return memories
    .filter((memory) => memory.status === undefined || memory.status === "active")
    .map((memory, index) => {
      const channels = recallCandidateChannels(memory, input);
      return { memory, channels, index, score: recallCandidateEvidenceScore(channels, memory, input) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(({ score, channels }) => score > 0 || channels.includes("source_pr_match"))
    .slice(0, MEMORY_RECALL_MAX_CANDIDATES)
    .map(
      ({ memory, channels }) =>
        ({
          ...memory,
          recallCandidateChannels: channels,
        }) as Memory & { recallCandidateChannels?: string[] },
    );
}

function candidateChannels(memory: Memory): string[] {
  const channels = (memory as Memory & { recallCandidateChannels?: string[] }).recallCandidateChannels;
  return Array.isArray(channels) ? channels : [];
}

function recallCandidateChannels(memory: Memory, input: MemoryRecallInput): string[] {
  const channels = new Set<string>();
  if (sourcePrMatches(memory, input.intent)) channels.add("source_pr_match");
  if ((memory.applies_to?.length ?? 0) > 0 && input.files?.some((file) => memoryPathMatches(memory, file))) {
    channels.add("path_match");
  }
  if (input.tool && memory.triggers?.tools?.includes(input.tool)) channels.add("tool_trigger_match");
  if (input.tool && memory.triggers?.mcp_tools?.includes(input.tool)) channels.add("tool_trigger_match");
  if (input.symbols?.some((symbol) => !isGenericLocalRecallSymbol(symbol) && memoryTextIncludes(memory, symbol)))
    channels.add("symbol_match");
  if (matchedRecallTextTerms(memory, input.intent).length >= 3) channels.add("text_retrieval");
  return [...channels];
}

function isGenericLocalRecallSymbol(symbol: string): boolean {
  return GENERIC_REPO_MEMORY_SYMBOL_TERMS.has(symbol.trim().toLowerCase());
}

function recallCandidateEvidenceScore(memoryChannels: string[], memory: Memory, input: MemoryRecallInput): number {
  const weights = MEMORY_RECALL_EVIDENCE_SCORE_WEIGHTS;
  let score = 0;
  if (memoryChannels.includes("path_match")) {
    score += weights.pathMatch;
    score += Math.min(
      weights.pathSpecificityMax,
      Math.max(0, ...(input.files ?? []).map((file) => memoryPathSpecificity(memory, file))),
    );
  }
  if (memoryChannels.includes("source_pr_match")) score += weights.sourcePrMatch;
  if (memoryChannels.includes("symbol_match")) score += weights.symbolMatch;
  if (memoryChannels.includes("tool_trigger_match")) score += input.tool ? weights.toolTriggerMatch : 0;
  if (memoryChannels.includes("text_retrieval")) {
    score += weights.textRetrieval;
    score += Math.min(
      weights.textRetrievalPerTermMax,
      matchedRecallTextTerms(memory, input.intent).length * weights.textRetrievalPerTermMultiplier,
    );
  }
  return score;
}

function sourcePrMatches(memory: Memory, intent: string): boolean {
  const sourcePr = sourcePrNumber(memory);
  return (
    sourcePr !== null && isPullRequestReferencedForRepo(intent, sourcePr, process.env.REPO_OWNER, process.env.REPO_NAME)
  );
}

function sourcePrNumber(memory: Memory): number | null {
  const value =
    (memory as Memory & { sourcePrNumber?: number; source_pr_number?: number }).sourcePrNumber ??
    (memory as Memory & { source_pr_number?: number }).source_pr_number;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function memoryPathSpecificity(memory: Memory, file: string): number {
  const normalizedFile = normalizeMemoryPath(file);
  if (!normalizedFile) return 0;
  const weights = MEMORY_RECALL_PATH_SPECIFICITY_WEIGHTS;
  return Math.max(
    0,
    ...(memory.applies_to ?? []).map((pattern) => {
      const normalizedPattern = normalizeMemoryPath(pattern);
      if (!normalizedPattern) return 0;
      if (normalizedPattern.includes("*")) {
        if (!memoryGlobMatches(normalizedPattern, normalizedFile)) return 0;
        return Math.min(
          weights.underDirectoryMax,
          literalLeadingSegments(normalizedPattern) * weights.underDirectoryPerSegment,
        );
      }
      if (normalizedFile === normalizedPattern) return weights.exactMatch;
      if (normalizedFile.startsWith(`${normalizedPattern}/`))
        return Math.min(
          weights.underDirectoryMax,
          normalizedPattern.split("/").length * weights.underDirectoryPerSegment,
        );
      // A pattern nested under the changed file cannot "match" it, but keep the legacy proximity
      // score so plain-path ranking does not regress.
      if (normalizedPattern.startsWith(`${normalizedFile}/`)) return weights.patternUnderFile;
      return 0;
    }),
  );
}

// Count leading path segments that contain no wildcard, stopping at the first `*`-bearing segment.
function literalLeadingSegments(pattern: string): number {
  let count = 0;
  for (const segment of pattern.split("/")) {
    if (segment.includes("*")) break;
    count += 1;
  }
  return count;
}

function matchedRecallTextTerms(memory: Memory, intent: string): string[] {
  const taskTerms = recallEvidenceTerms(denoiseCurrentTaskText(intent));
  const memoryTerms = new Set(recallEvidenceTerms(`${memory.context_hint}\n${memory.content}`));
  return taskTerms.filter((term) => memoryTerms.has(term));
}

function memoryTextIncludes(memory: Memory, value: string): boolean {
  const normalizedNeedle = value.trim().toLowerCase();
  if (!normalizedNeedle) return false;
  return [
    memory.context_hint,
    memory.content,
    ...(((memory as Memory & { symbols?: string[] }).symbols ?? []) as string[]),
    ...(((memory as Memory & { subjects?: string[] }).subjects ?? []) as string[]),
    ...(((memory as Memory & { tags?: string[] }).tags ?? []) as string[]),
  ]
    .join("\n")
    .toLowerCase()
    .includes(normalizedNeedle);
}

function recallEvidenceTerms(value: string): string[] {
  return normalizeSignalTerms(value).filter(isUsefulRecallEvidenceTerm);
}

function parseRankingsPayload(rankings: unknown, validIds: ReadonlySet<string>): MemoryRecallRanking[] {
  if (!Array.isArray(rankings)) return [];
  return rankings
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = (entry as Record<string, unknown>).id;
      const score = (entry as Record<string, unknown>).score;
      if (typeof id !== "string" || !validIds.has(id) || typeof score !== "number" || !Number.isFinite(score)) {
        return null;
      }
      const reason = (entry as Record<string, unknown>).reason;
      const expectedEffect =
        (entry as Record<string, unknown>).expected_effect ?? (entry as Record<string, unknown>).expectedEffect;
      return {
        id,
        score: Math.min(Math.max(score, 0), 1),
        ...(typeof reason === "string" && reason.trim()
          ? { reason: reason.trim().slice(0, MEMORY_TRACE_FIELD_MAX_CHARS) }
          : {}),
        ...(typeof expectedEffect === "string" && expectedEffect.trim()
          ? { expectedEffect: expectedEffect.trim().slice(0, MEMORY_TRACE_FIELD_MAX_CHARS) }
          : {}),
      };
    })
    .filter((entry): entry is MemoryRecallRanking => entry !== null);
}

function normalizeMemoryContextInput(args: unknown): MemoryContextInput | null {
  const input = normalizeMemoryRecallInput(args);
  if (!input || !args || typeof args !== "object" || Array.isArray(args)) return input;
  const record = args as Record<string, unknown>;
  const maxMemories = record.maxMemories;
  return {
    ...input,
    ...(typeof record.currentTaskSummary === "string" && record.currentTaskSummary.trim()
      ? { currentTaskSummary: record.currentTaskSummary.trim().slice(0, MEMORY_SESSION_SUMMARY_MAX_CHARS) }
      : {}),
    ...(typeof record.recentSessionSummary === "string"
      ? { recentSessionSummary: record.recentSessionSummary.trim().slice(0, MEMORY_SESSION_SUMMARY_MAX_CHARS) || null }
      : record.recentSessionSummary === null
        ? { recentSessionSummary: null }
        : {}),
    ...(typeof maxMemories === "number" && Number.isFinite(maxMemories)
      ? { maxMemories: Math.max(1, Math.min(Math.floor(maxMemories), 5)) }
      : {}),
  };
}

function parseMemoryContextMemories(value: unknown): MemoryContextBlockMemory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MemoryContextBlockMemory[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    const content = typeof record.content === "string" && record.content.trim() ? record.content.trim() : null;
    if (!id || !content) return [];
    const provenance = Array.isArray(record.provenance)
      ? record.provenance.flatMap((source): MemoryContextBlockMemory["provenance"] => {
          if (!source || typeof source !== "object" || Array.isArray(source)) return [];
          const sourceRecord = source as Record<string, unknown>;
          const sourceKind =
            typeof sourceRecord.sourceKind === "string" && sourceRecord.sourceKind.trim()
              ? sourceRecord.sourceKind.trim()
              : null;
          const sourceId =
            typeof sourceRecord.sourceId === "string" && sourceRecord.sourceId.trim()
              ? sourceRecord.sourceId.trim()
              : null;
          if (!sourceKind || !sourceId) return [];
          return [
            {
              sourceKind,
              sourceId,
              excerpt: typeof sourceRecord.excerpt === "string" ? sourceRecord.excerpt : null,
            },
          ];
        })
      : [];
    const kind =
      typeof record.kind === "string" && MEMORY_CONTEXT_KINDS.has(record.kind.trim()) ? record.kind.trim() : null;
    if (!kind || provenance.length === 0) return [];
    return [
      {
        id,
        kind,
        content,
        level: typeof record.level === "string" && record.level.trim() ? record.level.trim() : null,
        whyReturned:
          typeof record.whyReturned === "string" && record.whyReturned.trim() ? record.whyReturned.trim() : "selected",
        confidence: confidenceValue(record.confidence),
        enforcement: enforcementValue(record.enforcement),
        provenance,
      },
    ];
  });
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}
