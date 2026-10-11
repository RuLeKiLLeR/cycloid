import {
  confidenceFromNumber,
  confidenceValue,
  enforcementValue,
  formatMemoryContextBlock,
  type MemoryContextConfidence,
  type MemoryContextEnforcement,
} from "../../../../shared/memory/context-block";
import { buildRetrievalSignals } from "../../../../shared/memory/retrieval-signals";
import { denoiseTaskInput } from "../../../../shared/memory/task-denoising";
import { isQaRuntimeMemory } from "../../../../shared/verification/qa-runtime-learnings";
import { isCompanyMemoryDisabledForBusiness } from "../constants/company-memory";
import {
  isMemoryContextRetrievalDisabled,
  MEMORY_CONTEXT_COMPANY_RECALL_TIMEOUT_MS,
  MEMORY_CONTEXT_REPO_FTS_LIMIT,
  MEMORY_CONTEXT_SELECTOR_MODEL,
  MEMORY_CONTEXT_SEMANTIC_DOCUMENT_LIMIT,
  MEMORY_CONTEXT_VECTOR_TOP_K,
  MEMORY_EMBEDDING_TIMEOUT_MS,
} from "../constants/memory-context";
import { recordMemoryUsageEvents } from "../memory/db";
import {
  buildRepoMemoryRecallTrace,
  rankRepoMemoryRecallCandidates,
  type RepoMemoryRecallCandidate,
  type RepoMemoryRecallRanking,
  type RepoMemoryRecallRequest,
  type RepoMemoryRecallTrace,
} from "../memory/recall";
import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { resolveCompanyMemoryBootstrapScope } from "./bootstrap-scope";
import { parseMemoryScopeCardJson } from "./context-consolidation";
import {
  buildListRecentMemoryMessagesForScopesStatement,
  buildListReinforcedMemoryConclusionsForScopesStatement,
  buildSearchMemoryConclusionsFtsStatement,
  buildSearchMemoryMessagesFtsStatement,
  insertMemoryContextQuery,
  listActiveMemoryScopeCardsForScope,
  listMemorySemanticDocumentsByVectorIds,
  type MemoryConclusionFtsRow,
  type MemoryConclusionLevel,
  type MemoryConclusionRow,
  type MemoryFusionMode,
  type MemoryMessageFtsRow,
  type MemoryScopeCardRow,
  type MemorySemanticDocumentRow,
  type RecentMemoryMessageRow,
  type RepoMemoryFtsRow,
  searchRepoMemoryFts,
} from "./context-db";
import { createMemoryContextMetricSink, type MemoryContextMetricOptions } from "./context-metrics";
import {
  createPlatformMemoryContextSelector,
  type MemoryContextSelector,
  type MemorySelectorCandidate,
  type MemorySelectorResult,
  normalizeMemorySelectorFailureCode,
} from "./context-selector";
import {
  createOpenAIMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
  sanitizeErrorDetail,
} from "./context-vector-sync";
import { formatCompanyMemoryBlock, retrieveCompanyMemory } from "./retrieve";
import type { CompanyMemorySessionScope } from "./session-query";
import { getMemoryVectorIndex, type MemoryVectorIndex, type MemoryVectorMatch } from "./vector-index";

type MemoryContextMode = "all" | "repo" | "company";

type MemoryContextMemory = {
  id: string;
  kind: "repo_rule" | "company_fact" | "company_take" | "session_observation" | "derived_conclusion" | "scope_card";
  content: string;
  level: MemoryConclusionLevel | null;
  whyReturned: string;
  confidence: MemoryContextConfidence;
  enforcement: MemoryContextEnforcement;
  provenance: Array<{ sourceKind: string; sourceId: string; excerpt: string | null }>;
};

type MemoryContextRequest = {
  mode: MemoryContextMode;
  intent: string;
  files: string[];
  symbols: string[];
  tool: string | null;
  currentTaskSummary: string;
  recentSessionSummary: string | null;
  maxMemories: number;
  sourcePrNumbers: number[];
  sourceSessionIds: string[];
  memories: RepoMemoryRecallCandidate[];
  customer: string | null;
  includeActionItems: boolean | undefined;
  includeOpenQuestions: boolean | undefined;
  queryVector: number[] | null;
};

const MEMORY_CONTEXT_INTENT_MAX_CHARS = 4_000;
const MEMORY_CONTEXT_SUMMARY_MAX_CHARS = 2_000;
const MEMORY_CONTEXT_MAX_CANDIDATES = 40;
const MEMORY_CONTEXT_MAX_MEMORIES = 5;
const MEMORY_CONTEXT_MAX_SELECTOR_CANDIDATES = 60;
const MEMORY_CONTEXT_FTS_CANDIDATE_CAP = 30;

type MemoryContextQueryOptions = {
  vectorIndex?: MemoryVectorIndex | null;
  embeddingProvider?: MemoryEmbeddingProvider | null;
  selector?: MemoryContextSelector | null;
  nowMs?: number;
  metrics?: MemoryContextMetricOptions | null;
};

type MemoryContextLane =
  "repo_ranked" | "repo_fts" | "conclusion_fts" | "message_fts" | "scope_card" | "recent" | "reinforced" | "vector";

type MemoryContextCandidate = MemoryContextMemory & {
  lanes: MemoryContextLane[];
  laneRanks: Partial<Record<MemoryContextLane, number>>;
  scores: Partial<Record<MemoryContextLane, number>>;
};

export async function handleMemoryContextQueryForSession(
  request: Request,
  env: Env,
  db: D1Database,
  sessionId: string,
  scope: CompanyMemorySessionScope,
  options: MemoryContextQueryOptions = {},
): Promise<Response> {
  const input = await parseMemoryContextRequest(request);
  if (!input) return jsonErrorResponse("Invalid memory context request", 400);

  const traceId = crypto.randomUUID();
  const metricSink = options.metrics === null ? null : createMemoryContextMetricSink(env, options.metrics);
  const nowMs = options.nowMs ?? Date.now();
  const candidates = new Map<string, MemoryContextCandidate>();
  let repoRankings: RepoMemoryRecallRanking[] = [];
  let repoTrace: RepoMemoryRecallTrace | null = null;
  let companyTrace: unknown = null;
  let ftsCandidateCount = 0;
  const denoised = denoiseTaskInput({
    rawText: input.intent,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    files: input.files,
  });
  const retrievalQuery = buildFtsQuery(
    buildRetrievalSignals({
      text: [denoised.denoisedTaskText, input.currentTaskSummary, input.recentSessionSummary ?? ""].join("\n"),
      files: input.files,
      symbols: input.symbols,
    }),
  );
  const laneCounts: Record<string, number> = {};
  let vectorAvailable = false;
  let vectorUnavailableReason: string | null = null;
  let vectorMatches: MemoryVectorMatch[] = [];
  metricSink?.emit({
    event: "memory_context.query_started",
    traceId,
    businessId: scope.businessId,
    sessionId,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    mode: input.mode,
  });

  const retrievalDisabled = isMemoryContextRetrievalDisabled(env);
  // Fail closed: when company memory is disabled for this business, no company-derived
  // lane (recall, scope card, recent, reinforced, conclusion/message FTS, or vector)
  // may inject company-derived content.
  const companyMemoryDisabled = isCompanyMemoryDisabledForBusiness(env, scope.businessId);
  if (!retrievalDisabled && (input.mode === "all" || input.mode === "repo")) {
    const repoRequest: RepoMemoryRecallRequest = {
      repoOwner: scope.repoOwner,
      repoName: scope.repoName,
      intent: input.intent,
      files: input.files,
      symbols: input.symbols,
      tool: input.tool,
      sourcePrNumbers: input.sourcePrNumbers,
      sourceSessionIds: input.sourceSessionIds,
      memories: input.memories,
    };
    try {
      const repoResult = await rankRepoMemoryRecallCandidates(repoRequest);
      repoRankings = repoResult.rankings;
      repoTrace = repoResult.retrievalTrace;
      // repoMemoriesForContext drops rankings whose candidate is missing or empty,
      // so returned indices no longer align with repoRankings. Look up each memory's
      // score by id to keep score/rank attached to the correct ranking.
      const repoRankingScoreById = new Map(repoRankings.map((ranking) => [ranking.id, ranking.score]));
      for (const [index, memory] of repoMemoriesForContext(input.memories, repoRankings, input.maxMemories).entries()) {
        addCandidate(candidates, memory, "repo_ranked", index + 1, repoRankingScoreById.get(memory.id) ?? 0);
      }
    } catch {
      repoTrace = buildRepoMemoryRecallTrace(repoRequest, [], false);
    }
  }

  if (!retrievalDisabled && (input.mode === "all" || input.mode === "company") && !companyMemoryDisabled) {
    // Degrade gracefully if the recall backend is unavailable, matching the repo_ranked
    // and vector lanes; a recall failure must not sink the whole context request.
    try {
      const companyResult = await retrieveCompanyMemoryForContext(env, db, sessionId, scope, input);
      companyTrace = companyResult.retrievalTrace;
      for (const [index, memory] of companyResult.memories.entries()) {
        addCandidate(candidates, memory, "conclusion_fts", index + 1, 0.5);
      }
    } catch (error) {
      companyTrace = { error: error instanceof Error ? error.name : "company_recall_failed" };
    }
  }

  const scopedIds = await resolveRelevantScopeIds(db, scope);
  if (!retrievalDisabled && (input.mode === "all" || input.mode === "company") && !companyMemoryDisabled) {
    const scopeCardRows = (
      await Promise.all(
        scopedIds.map((scopeId) =>
          listActiveMemoryScopeCardsForScope(db, {
            businessId: scope.businessId,
            scopeId,
            limit: 3,
          }),
        ),
      )
    ).flat();
    laneCounts.scope_card = scopeCardRows.length;
    for (const [index, row] of scopeCardRows.entries()) {
      const memory = scopeCardMemoryForContext(row);
      if (memory) addCandidate(candidates, memory, "scope_card", index + 1, 0.2);
    }

    if (scopedIds.length > 0) {
      const recentAndReinforcedLanes: Array<
        { kind: "recent"; statement: D1PreparedStatement } | { kind: "reinforced"; statement: D1PreparedStatement }
      > = [
        {
          kind: "recent",
          statement: buildListRecentMemoryMessagesForScopesStatement(db, {
            businessId: scope.businessId,
            scopeIds: scopedIds,
            limit: 10,
          }),
        },
        {
          kind: "reinforced",
          statement: buildListReinforcedMemoryConclusionsForScopesStatement(db, {
            businessId: scope.businessId,
            scopeIds: scopedIds,
            limit: 10,
          }),
        },
      ];

      const recentAndReinforcedResults = await db.batch(recentAndReinforcedLanes.map((lane) => lane.statement));
      for (const [laneIndex, lane] of recentAndReinforcedLanes.entries()) {
        const rows = recentAndReinforcedResults[laneIndex]?.results ?? [];
        if (lane.kind === "recent") {
          const recentRows = rows as RecentMemoryMessageRow[];
          laneCounts.recent = recentRows.length;
          for (const [index, row] of recentRows.entries()) {
            addCandidate(candidates, recentMessageMemoryForContext(row), "recent", index + 1, 0.15);
          }
        } else if (lane.kind === "reinforced") {
          const reinforcedRows = rows as MemoryConclusionRow[];
          laneCounts.reinforced = reinforcedRows.length;
          for (const [index, row] of reinforcedRows.entries()) {
            addCandidate(candidates, reinforcedConclusionMemoryForContext(row), "reinforced", index + 1, 0.3);
          }
        }
      }

      if (retrievalQuery) {
        const ftsLanes: Array<
          | { kind: "conclusion_fts"; statement: D1PreparedStatement }
          | { kind: "message_fts"; statement: D1PreparedStatement }
        > = [
          {
            kind: "conclusion_fts",
            statement: buildSearchMemoryConclusionsFtsStatement(db, {
              businessId: scope.businessId,
              repoOwner: scope.repoOwner,
              repoName: scope.repoName,
              scopeIds: scopedIds,
              query: retrievalQuery,
              limit: 20,
            }),
          },
          {
            kind: "message_fts",
            statement: buildSearchMemoryMessagesFtsStatement(db, {
              businessId: scope.businessId,
              scopeIds: scopedIds,
              query: retrievalQuery,
              limit: 10,
            }),
          },
        ];

        try {
          const ftsResults = await db.batch(ftsLanes.map((lane) => lane.statement));
          for (const [laneIndex, lane] of ftsLanes.entries()) {
            const rows = ftsResults[laneIndex]?.results ?? [];
            if (lane.kind === "conclusion_fts") {
              const conclusionRows = rows as MemoryConclusionFtsRow[];
              for (const [index, row] of conclusionRows.entries()) {
                if (ftsCandidateCount >= MEMORY_CONTEXT_FTS_CANDIDATE_CAP) break;
                addCandidate(
                  candidates,
                  conclusionFtsMemoryForContext(row),
                  "conclusion_fts",
                  index + 1,
                  bm25Score(row.rank),
                );
                ftsCandidateCount += 1;
                laneCounts.conclusion_fts = (laneCounts.conclusion_fts ?? 0) + 1;
              }
            } else {
              const messageRows = rows as MemoryMessageFtsRow[];
              for (const [index, row] of messageRows.entries()) {
                if (ftsCandidateCount >= MEMORY_CONTEXT_FTS_CANDIDATE_CAP) break;
                addCandidate(
                  candidates,
                  messageFtsMemoryForContext(row),
                  "message_fts",
                  index + 1,
                  bm25Score(row.rank),
                );
                ftsCandidateCount += 1;
                laneCounts.message_fts = (laneCounts.message_fts ?? 0) + 1;
              }
            }
          }
        } catch {
          laneCounts.conclusion_fts ??= 0;
          laneCounts.message_fts ??= 0;
        }
      }
    }
  }

  // Repo FTS runs AFTER the company (conclusion/message) FTS lanes so it fills only the
  // slots they leave, instead of exhausting the shared ftsCandidateCount cap first and
  // starving them (ARC-1544). Standalone block with its own guard: it must still run for
  // mode=repo and when company memory is disabled or resolves no scopes.
  if (
    !retrievalDisabled &&
    (input.mode === "all" || input.mode === "repo") &&
    retrievalQuery &&
    scope.repoOwner &&
    scope.repoName
  ) {
    const rows = await searchRepoMemoryFts(db, {
      repoOwner: scope.repoOwner,
      repoName: scope.repoName,
      query: retrievalQuery,
      limit: MEMORY_CONTEXT_REPO_FTS_LIMIT,
    });
    laneCounts.repo_fts = 0;
    for (const [index, row] of rows.entries()) {
      if (ftsCandidateCount >= MEMORY_CONTEXT_FTS_CANDIDATE_CAP) break;
      // QA runtime memories are QA-session-only and reach QA phase prompts
      // deterministically via the phase context bundle; never a recall lane.
      if (isQaRuntimeRepoMemoryRow(row)) continue;
      addCandidate(candidates, repoFtsMemoryForContext(row), "repo_fts", index + 1, bm25Score(row.rank));
      ftsCandidateCount += 1;
      laneCounts.repo_fts += 1;
    }
  }

  const vectorIndex = retrievalDisabled
    ? null
    : options.vectorIndex === undefined
      ? getMemoryVectorIndex(env)
      : options.vectorIndex;
  const queryVector = await resolveMemoryContextQueryVector({
    env,
    input,
    denoisedTaskText: denoised.denoisedTaskText,
    vectorDisabled: retrievalDisabled,
    vectorIndex,
    embeddingProvider: options.embeddingProvider,
  });
  if (retrievalDisabled) {
    vectorUnavailableReason = "retrieval_disabled";
  } else if (vectorIndex && queryVector.vector) {
    try {
      vectorMatches = await vectorIndex.query({
        vector: queryVector.vector,
        topK: MEMORY_CONTEXT_VECTOR_TOP_K,
        businessId: scope.businessId,
        repoOwner: scope.repoOwner,
        repoName: scope.repoName,
      });
      const vectorRows = await listMemorySemanticDocumentsByVectorIds(db, {
        businessId: scope.businessId,
        repoOwner: scope.repoOwner,
        repoName: scope.repoName,
        scopeIds: scopedIds,
        vectorIds: vectorMatches.map((match) => match.vectorId),
        limit: MEMORY_CONTEXT_SEMANTIC_DOCUMENT_LIMIT,
      });
      vectorAvailable = true;
      const vectorScores = firstVectorMatchById(vectorMatches);
      // Gate vector rows by mode (repo mode keeps only repo-derived docs, company mode
      // only company-derived) and fail closed on company-derived docs when company
      // memory is disabled for this business.
      const allowedVectorRows = orderVectorRows(vectorRows, vectorMatches).filter((row) =>
        isVectorRowAllowedForMode(row.sourceKind, input.mode, companyMemoryDisabled),
      );
      laneCounts.vector = allowedVectorRows.length;
      for (const row of allowedVectorRows) {
        const match = vectorScores.get(row.vectorId);
        addCandidate(
          candidates,
          semanticDocumentMemoryForContext(row),
          "vector",
          match?.rank ?? MEMORY_CONTEXT_VECTOR_TOP_K,
          match?.score ?? 0,
        );
      }
    } catch (error) {
      vectorAvailable = false;
      vectorUnavailableReason = error instanceof Error ? `vector_query_failed:${error.name}` : "vector_query_failed";
    }
  } else if (!vectorIndex) {
    vectorUnavailableReason = "missing_vectorize_binding";
  } else {
    vectorUnavailableReason = queryVector.unavailableReason ?? "query_embedding_unavailable";
  }

  const fusionMode: MemoryFusionMode = vectorAvailable && hasLexicalLane(laneCounts) ? "rrf" : "deterministic";
  const orderedCandidates = orderCandidates([...candidates.values()], fusionMode).slice(
    0,
    MEMORY_CONTEXT_MAX_SELECTOR_CANDIDATES,
  );
  const selectorCandidates = orderedCandidates;
  metricSink?.emit({
    event: "memory_context.candidates_generated",
    traceId,
    businessId: scope.businessId,
    sessionId,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    mode: input.mode,
    candidateCount: selectorCandidates.length,
    laneCounts,
  });
  if (!vectorAvailable && vectorUnavailableReason) {
    metricSink?.emit({
      event: "memory_context.vector_unavailable",
      traceId,
      businessId: scope.businessId,
      sessionId,
      repoOwner: scope.repoOwner,
      repoName: scope.repoName,
      mode: input.mode,
      vectorUnavailableReason,
    });
  }
  const selector = retrievalDisabled
    ? null
    : options.selector === undefined
      ? createPlatformMemoryContextSelector(env)
      : options.selector;
  const selectorStartMs = selector === null ? null : Date.now();
  const selectorResult =
    selector === null
      ? notRunSelectorResult()
      : await selector.select({
          traceId,
          businessId: scope.businessId,
          sessionId,
          repoOwner: scope.repoOwner,
          repoName: scope.repoName,
          denoisedTask: denoised.denoisedTaskText,
          files: input.files,
          symbols: input.symbols,
          tool: input.tool,
          sessionContext: {
            currentPromptExcerpt: input.intent.slice(0, 2_000),
            recentSummary: input.recentSessionSummary,
            changedFiles: input.files,
            toolNames: input.tool ? [input.tool] : [],
          },
          candidates: selectorCandidates.slice(0, 30).map(selectorCandidate),
        });
  const selectorLatencyMs = selectorStartMs === null ? null : Math.max(0, Date.now() - selectorStartMs);
  const selectedCandidates = selectedMemoryCandidates(orderedCandidates, selectorResult, input.maxMemories);
  const memories = selectedCandidates.map((candidate) => {
    const selection = selectorResult.selected.find((entry) => entry.memoryId === candidate.id);
    return stripCandidateEvidence({
      ...candidate,
      whyReturned:
        selection?.selectionRationale ??
        (candidate.enforcement === "block" ? "deterministic_block_enforcement" : candidate.whyReturned),
    });
  });
  metricSink?.emit({
    event: memories.length > 0 ? "memory_context.selector_returned" : "memory_context.selector_returned_empty",
    traceId,
    businessId: scope.businessId,
    sessionId,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    mode: input.mode,
    selectedCount: memories.length,
    selectorStatus: selectorResult.status,
    selectorLatencyMs,
    ...(selectorResult.failureReason
      ? { failureCode: normalizeMemorySelectorFailureCode(selectorResult.failureReason) }
      : {}),
  });
  const candidateIds = orderedCandidates.map((candidate) => candidate.id);
  const retrievalTrace = {
    retrievalConfigVersion: "memory-context-candidate-v1",
    traceId,
    mode: input.mode,
    rawPromptHash: denoised.rawFingerprint,
    denoisedPromptHash: denoised.taskFingerprint,
    denoisedTaskExcerpt: denoised.denoisedTaskText.slice(0, 500),
    removedSections: denoised.removedSections,
    query: retrievalQuery,
    vectorAvailable,
    vectorUnavailableReason,
    vectorMatches: vectorMatches.map((match, index) => ({
      vectorId: match.vectorId,
      score: match.score,
      rank: index + 1,
    })),
    laneCounts,
    fusionMode,
    rrfCandidateIds: rrfCandidateIds(orderedCandidates, fusionMode),
    blockEnforcedIds: orderedCandidates
      .filter((candidate) => candidate.enforcement === "block")
      .map((candidate) => candidate.id),
    candidates: orderedCandidates.slice(0, 30).map((candidate) => ({
      id: candidate.id,
      lanes: candidate.lanes,
      laneRanks: candidate.laneRanks,
      scores: candidate.scores,
    })),
    repo: repoTrace,
    company: companyTrace,
    selectorStatus: selectorResult.status,
    selectorLatencyMs,
    selector: {
      selected: selectorResult.selected,
      rejected: selectorResult.rejected,
      emptyReason: selectorResult.emptyReason,
      confidence: selectorResult.selectorConfidence,
      failureReason: selectorResult.failureReason,
    },
  };

  await insertMemoryContextQuery(db, {
    id: traceId,
    businessId: scope.businessId,
    sessionId,
    promptId: "memory-context",
    scopeId: scopedIds[0] ?? null,
    intent: denoised.denoisedTaskText.slice(0, MEMORY_CONTEXT_INTENT_MAX_CHARS),
    requestJson: JSON.stringify(sanitizedMemoryContextRequest(input, denoised)),
    laneCountsJson: JSON.stringify(laneCounts),
    vectorAvailable,
    vectorUnavailableReason,
    fusionMode,
    candidateIdsJson: JSON.stringify(candidateIds),
    selectedIdsJson: JSON.stringify(memories.map((memory) => memory.id)),
    rejectedJson: JSON.stringify(selectorResult.rejected),
    selectorStatus: selectorResult.status,
    selectorModel: selector === null ? null : MEMORY_CONTEXT_SELECTOR_MODEL,
    selectorLatencyMs,
    traceJson: JSON.stringify(retrievalTrace),
    nowMs,
  });

  return jsonResponse({
    ok: true,
    traceId,
    memories,
    repoRankings,
    block: formatMemoryContextBlock(memories, traceId),
    retrievalTrace,
  });
}

async function resolveMemoryContextQueryVector(params: {
  env: Env;
  input: MemoryContextRequest;
  denoisedTaskText: string;
  vectorDisabled: boolean;
  vectorIndex: MemoryVectorIndex | null;
  embeddingProvider?: MemoryEmbeddingProvider | null;
}): Promise<{ vector: number[] | null; unavailableReason: string | null }> {
  if (params.input.queryVector) return { vector: params.input.queryVector, unavailableReason: null };
  if (params.vectorDisabled || !params.vectorIndex) return { vector: null, unavailableReason: null };
  if (!params.denoisedTaskText.trim()) return { vector: null, unavailableReason: "query_embedding_unavailable" };
  const embeddingProvider =
    params.embeddingProvider === undefined
      ? params.env.ARCANIST_OPENAI_API_KEY
        ? createOpenAIMemoryEmbeddingProvider(params.env)
        : null
      : params.embeddingProvider;
  if (!embeddingProvider) return { vector: null, unavailableReason: "query_embedding_unavailable" };
  try {
    return {
      vector: await embeddingProvider.embed(params.denoisedTaskText, AbortSignal.timeout(MEMORY_EMBEDDING_TIMEOUT_MS)),
      unavailableReason: null,
    };
  } catch (error) {
    return {
      vector: null,
      unavailableReason: isEmbeddingTimeout(error)
        ? "embedding_timeout"
        : error instanceof Error
          ? `query_embedding_failed:${sanitizeErrorDetail(error.message)}`
          : "query_embedding_failed",
    };
  }
}

function isEmbeddingTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function sanitizedMemoryContextRequest(
  input: MemoryContextRequest,
  denoised: ReturnType<typeof denoiseTaskInput>,
): Record<string, unknown> {
  return {
    mode: input.mode,
    rawPromptHash: denoised.rawFingerprint,
    denoisedPromptHash: denoised.taskFingerprint,
    denoisedTaskExcerpt: denoised.denoisedTaskText.slice(0, 500),
    removedSections: denoised.removedSections,
    structuredSignals: denoised.structuredSignals,
    files: input.files,
    symbols: input.symbols,
    tool: input.tool,
    maxMemories: input.maxMemories,
    sourcePrNumbers: input.sourcePrNumbers,
    sourceSessionIds: input.sourceSessionIds,
    repoCandidateIds: input.memories.map((memory) => memory.id).slice(0, MEMORY_CONTEXT_MAX_CANDIDATES),
    customer: input.customer,
    includeActionItems: input.includeActionItems,
    includeOpenQuestions: input.includeOpenQuestions,
    queryVector: input.queryVector ? "[redacted-vector]" : null,
  };
}

async function parseMemoryContextRequest(request: Request): Promise<MemoryContextRequest | null> {
  const body = await parseJsonBody(request);
  if (!body) return null;
  const intent = boundedString(body.intent, MEMORY_CONTEXT_INTENT_MAX_CHARS);
  if (!intent) return null;
  const mode = body.mode === "repo" || body.mode === "company" || body.mode === "all" ? body.mode : "all";
  const maxMemories =
    typeof body.maxMemories === "number" && Number.isFinite(body.maxMemories)
      ? Math.max(1, Math.min(Math.floor(body.maxMemories), MEMORY_CONTEXT_MAX_MEMORIES))
      : MEMORY_CONTEXT_MAX_MEMORIES;
  // reasoningLevel is intentionally ignored: nothing branches on it (the selector
  // hardcodes reasoningEffort). Tolerate its presence in incoming JSON for now while
  // the bridge is updated to stop sending it.
  return {
    mode,
    intent,
    files: stringArray(body.files),
    symbols: stringArray(body.symbols),
    tool: boundedString(body.tool, 200),
    currentTaskSummary: boundedString(body.currentTaskSummary, MEMORY_CONTEXT_SUMMARY_MAX_CHARS) ?? intent,
    recentSessionSummary: boundedString(body.recentSessionSummary, MEMORY_CONTEXT_SUMMARY_MAX_CHARS),
    maxMemories,
    sourcePrNumbers: numberArray(body.sourcePrNumbers),
    sourceSessionIds: stringArray(body.sourceSessionIds),
    memories: repoMemoryCandidates(body.memories),
    customer: boundedString(body.customer, 200),
    includeActionItems: optionalBoolean(body.includeActionItems),
    includeOpenQuestions: optionalBoolean(body.includeOpenQuestions),
    queryVector: vectorNumberArray(body.queryVector),
  };
}

function repoMemoriesForContext(
  candidates: RepoMemoryRecallCandidate[],
  rankings: RepoMemoryRecallRanking[],
  maxMemories: number,
): MemoryContextMemory[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return rankings.slice(0, maxMemories).flatMap((ranking): MemoryContextMemory[] => {
    const candidate = byId.get(ranking.id);
    if (!candidate) return [];
    const content = typeof candidate.content === "string" && candidate.content.trim() ? candidate.content.trim() : null;
    if (!content) return [];
    const contextHint =
      typeof candidate.context_hint === "string" && candidate.context_hint.trim()
        ? candidate.context_hint.trim()
        : null;
    return [
      {
        id: ranking.id,
        kind: "repo_rule",
        content,
        level: null,
        whyReturned: ranking.reason ?? "selected_by_repo_memory_context",
        confidence: confidenceValue((candidate as Record<string, unknown>).confidence),
        enforcement: enforcementValue((candidate as Record<string, unknown>).enforcement),
        provenance: [
          {
            sourceKind: "repo_memory",
            sourceId: ranking.id,
            excerpt: contextHint,
          },
        ],
      },
    ];
  });
}

function isQaRuntimeRepoMemoryRow(row: RepoMemoryFtsRow): boolean {
  try {
    return isQaRuntimeMemory(JSON.parse(row.memoryJson) as { tags?: string[] });
  } catch {
    return false;
  }
}

function repoFtsMemoryForContext(row: RepoMemoryFtsRow): MemoryContextMemory {
  return {
    id: row.memoryId,
    kind: "repo_rule",
    content: row.content,
    level: null,
    whyReturned: "repo_fts_match",
    confidence: row.confidence,
    enforcement: row.enforcement,
    provenance: [
      {
        sourceKind: "repo_memory",
        sourceId: row.memoryId,
        excerpt: row.contextHint,
      },
    ],
  };
}

function conclusionFtsMemoryForContext(row: MemoryConclusionFtsRow): MemoryContextMemory {
  return {
    id: row.sourceKind === "repo_memory" ? row.id : memoryConclusionMemoryId(row.id),
    kind: row.sourceKind === "repo_memory" ? "repo_rule" : "derived_conclusion",
    content: row.content,
    level: row.sourceKind === "repo_memory" ? null : row.level,
    whyReturned: "conclusion_fts_match",
    confidence: row.confidence,
    enforcement: row.enforcement,
    provenance: [
      {
        sourceKind: row.sourceKind ?? "memory_conclusion",
        sourceId: row.sourceId ?? row.id,
        excerpt: row.sourceExcerpt ?? row.sourceUri,
      },
    ],
  };
}

function messageFtsMemoryForContext(row: MemoryMessageFtsRow): MemoryContextMemory {
  return {
    id: row.id,
    kind: "session_observation",
    content: row.contentText,
    level: null,
    whyReturned: "message_fts_match",
    confidence: "medium",
    enforcement: "none",
    provenance: [
      {
        sourceKind: "memory_message",
        sourceId: row.id,
        excerpt: row.sourceUri,
      },
    ],
  };
}

function recentMessageMemoryForContext(row: RecentMemoryMessageRow): MemoryContextMemory {
  return {
    id: row.id,
    kind: "session_observation",
    content: row.contentText,
    level: null,
    whyReturned: "recent_scope_message",
    confidence: "medium",
    enforcement: "none",
    provenance: [
      {
        sourceKind: "memory_message",
        sourceId: row.id,
        excerpt: row.sourceUri,
      },
    ],
  };
}

function reinforcedConclusionMemoryForContext(row: MemoryConclusionFtsRow | MemoryConclusionRow): MemoryContextMemory {
  return {
    id: row.sourceKind === "repo_memory" ? row.id : memoryConclusionMemoryId(row.id),
    kind: row.sourceKind === "repo_memory" ? "repo_rule" : "derived_conclusion",
    content: row.content,
    level: row.sourceKind === "repo_memory" ? null : row.level,
    whyReturned: "reinforced_scope_conclusion",
    confidence: row.confidence,
    enforcement: row.enforcement,
    provenance: [
      {
        sourceKind: row.sourceKind ?? "memory_conclusion",
        sourceId: row.sourceId ?? row.id,
        excerpt: null,
      },
    ],
  };
}

function scopeCardMemoryForContext(row: MemoryScopeCardRow): MemoryContextMemory | null {
  // Reuse the writer's validator so we enforce version === 1 (rejecting stale card
  // shapes) instead of a divergent private parser.
  const parsed = parseMemoryScopeCardJson(row.cardJson);
  if (!parsed.ok || parsed.card.entries.length === 0) return null;
  const entries = parsed.card.entries;
  return {
    id: `scope_card:${row.id}`,
    kind: "scope_card",
    content: entries.map((entry) => `${entry.kind}: ${entry.content}`).join("\n"),
    level: null,
    whyReturned: "scope_card_candidate",
    confidence: highestCardConfidence(entries),
    enforcement: "none",
    provenance: [
      {
        sourceKind: "memory_scope_card",
        sourceId: row.id,
        excerpt: row.sourceConclusionIdsJson,
      },
    ],
  };
}

function semanticDocumentMemoryForContext(row: MemorySemanticDocumentRow): MemoryContextMemory {
  return {
    id: semanticDocumentMemoryId(row),
    kind: semanticKind(row.sourceKind),
    content: row.text,
    level: row.sourceKind === "memory_conclusion" ? row.conclusionLevel : null,
    whyReturned: "vector_semantic_match",
    confidence: "medium",
    enforcement: "none",
    provenance: [
      {
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        excerpt: row.vectorId,
      },
    ],
  };
}

async function resolveRelevantScopeIds(db: D1Database, scope: CompanyMemorySessionScope): Promise<string[]> {
  const exactKeys = [
    scope.repoOwner && scope.repoName ? ["repo", `${scope.repoOwner}/${scope.repoName}`] : null,
    ["business", scope.businessId],
  ].filter((entry): entry is string[] => entry !== null);
  if (exactKeys.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT id
       FROM memory_scopes
       WHERE business_id = ?
         AND deleted_at_ms IS NULL
         AND (
           (scope_type = ? AND scope_key = ?)
           OR (scope_type = ? AND scope_key = ?)
         )
       ORDER BY CASE scope_type WHEN 'repo' THEN 0 WHEN 'business' THEN 1 ELSE 2 END`,
    )
    .bind(
      scope.businessId,
      exactKeys[0]?.[0] ?? "",
      exactKeys[0]?.[1] ?? "",
      exactKeys[1]?.[0] ?? "",
      exactKeys[1]?.[1] ?? "",
    )
    .all<{ id: string }>();
  return result.results.map((row) => row.id);
}

function addCandidate(
  candidates: Map<string, MemoryContextCandidate>,
  memory: MemoryContextMemory,
  lane: MemoryContextLane,
  rank: number,
  score: number,
): void {
  const existing = candidates.get(memory.id);
  if (!existing) {
    candidates.set(memory.id, {
      ...memory,
      lanes: [lane],
      laneRanks: { [lane]: rank },
      scores: { [lane]: score },
    });
    return;
  }
  if (!existing.lanes.includes(lane)) existing.lanes.push(lane);
  existing.laneRanks[lane] = Math.min(existing.laneRanks[lane] ?? rank, rank);
  existing.scores[lane] = Math.max(existing.scores[lane] ?? score, score);
  if (memory.enforcement === "block" || (memory.enforcement === "warn" && existing.enforcement === "none")) {
    existing.enforcement = memory.enforcement;
  }
  if (existing.provenance.length === 0) existing.provenance = memory.provenance;
}

function orderCandidates(candidates: MemoryContextCandidate[], fusionMode: MemoryFusionMode): MemoryContextCandidate[] {
  return [...candidates].sort(
    (left, right) => candidateSortScore(right, fusionMode) - candidateSortScore(left, fusionMode),
  );
}

function candidateSortScore(candidate: MemoryContextCandidate, fusionMode: MemoryFusionMode): number {
  const enforcementFloor = candidate.enforcement === "block" ? 10 : candidate.enforcement === "warn" ? 5 : 0;
  const deterministic = deterministicOrderingFloor(candidate);
  const rrf = fusionMode === "rrf" && isRrfEligibleCandidate(candidate) ? rrfScore(candidate) : 0;
  const nativeScore = Object.values(candidate.scores).reduce((sum, score) => sum + (score ?? 0), 0);
  return enforcementFloor + deterministic + rrf + nativeScore;
}

function deterministicOrderingFloor(candidate: MemoryContextCandidate): number {
  if (candidate.lanes.includes("repo_ranked")) return 2;
  if (candidate.lanes.includes("scope_card")) return 1.5;
  if (candidate.lanes.includes("reinforced")) return 1;
  if (candidate.lanes.includes("recent")) return 0.5;
  return 0;
}

function isRrfEligibleCandidate(candidate: MemoryContextCandidate): boolean {
  if (candidate.enforcement === "block") return false;
  if (
    candidate.lanes.some(
      (lane) => lane === "repo_ranked" || lane === "scope_card" || lane === "recent" || lane === "reinforced",
    )
  ) {
    return false;
  }
  return candidate.lanes.includes("vector") && candidate.lanes.some(isLexicalRrfLane);
}

function rrfScore(candidate: MemoryContextCandidate): number {
  return candidate.lanes.filter(isRrfScoredLane).reduce((score, lane) => {
    const rank = candidate.laneRanks[lane] ?? 60;
    return score + rrfLaneWeight(lane) / (60 + rank);
  }, 0);
}

function isRrfScoredLane(lane: MemoryContextLane): boolean {
  return lane === "vector" || isLexicalRrfLane(lane);
}

function isLexicalRrfLane(lane: MemoryContextLane): boolean {
  return lane === "repo_fts" || lane === "conclusion_fts" || lane === "message_fts";
}

function rrfLaneWeight(lane: MemoryContextLane): number {
  return lane === "message_fts" ? 0.8 : 1;
}

function rrfCandidateIds(candidates: MemoryContextCandidate[], fusionMode: MemoryFusionMode): string[] {
  if (fusionMode !== "rrf") return [];
  return candidates.filter(isRrfEligibleCandidate).map((candidate) => candidate.id);
}

function selectedMemoryCandidates(
  orderedCandidates: MemoryContextCandidate[],
  selectorResult: MemorySelectorResult,
  maxMemories: number,
): MemoryContextCandidate[] {
  const blockCandidates = orderedCandidates.filter((candidate) => candidate.enforcement === "block");
  const selectedIds = new Set(selectorResult.selected.map((selection) => selection.memoryId));
  const selectedNonBlockCandidates = orderedCandidates.filter(
    (candidate) => candidate.enforcement !== "block" && selectedIds.has(candidate.id),
  );
  const deduped = new Map<string, MemoryContextCandidate>();
  for (const candidate of [...blockCandidates, ...selectedNonBlockCandidates]) {
    if (!deduped.has(candidate.id)) deduped.set(candidate.id, candidate);
    if (deduped.size >= maxMemories) break;
  }
  return [...deduped.values()];
}

function stripCandidateEvidence(candidate: MemoryContextCandidate): MemoryContextMemory {
  const { lanes: _lanes, laneRanks: _laneRanks, scores: _scores, ...memory } = candidate;
  return memory;
}

function selectorCandidate(candidate: MemoryContextCandidate): MemorySelectorCandidate {
  return {
    id: candidate.id,
    kind: candidate.kind,
    content: candidate.content,
    confidence: candidate.confidence,
    enforcement: candidate.enforcement,
    provenance: candidate.provenance,
    lanes: candidate.lanes,
    laneRanks: compactNumberRecord(candidate.laneRanks),
    scores: compactNumberRecord(candidate.scores),
  };
}

function compactNumberRecord(record: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) =>
      typeof value === "number" && Number.isFinite(value) ? [[key, value]] : [],
    ),
  );
}

function notRunSelectorResult(): MemorySelectorResult {
  return {
    status: "failed",
    selected: [],
    rejected: [],
    emptyReason: "selector_disabled",
    selectorConfidence: 0,
    failureReason: "selector_disabled",
  };
}

function orderVectorRows(rows: MemorySemanticDocumentRow[], matches: MemoryVectorMatch[]): MemorySemanticDocumentRow[] {
  const order = new Map<string, number>();
  for (const [index, match] of matches.entries()) {
    if (!order.has(match.vectorId)) order.set(match.vectorId, index);
  }
  return [...rows].sort((left, right) => (order.get(left.vectorId) ?? 999) - (order.get(right.vectorId) ?? 999));
}

function firstVectorMatchById(matches: MemoryVectorMatch[]): Map<string, { score: number; rank: number }> {
  const byId = new Map<string, { score: number; rank: number }>();
  for (const [index, match] of matches.entries()) {
    if (!byId.has(match.vectorId)) byId.set(match.vectorId, { score: match.score, rank: index + 1 });
  }
  return byId;
}

function buildFtsQuery(signals: ReturnType<typeof buildRetrievalSignals>): string | null {
  const terms = [...signals.symbolTerms, ...signals.pathTerms, ...signals.errorTerms, ...signals.terms]
    .map((term) => term.replace(/"/g, "").replace(/[^a-zA-Z0-9_/-]/g, ""))
    .filter((term) => term.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function bm25Score(rank: number): number {
  // SQLite FTS5 bm25() returns more-negative = better (DAOs ORDER BY rank ASC).
  // Map to a [0, 1) score that increases as the rank grows more negative so the
  // strongest lexical hits sort first in deterministic fusion.
  if (!Number.isFinite(rank)) return 0;
  const strength = Math.max(0, -rank);
  return strength / (1 + strength);
}

function semanticKind(sourceKind: MemorySemanticDocumentRow["sourceKind"]): MemoryContextMemory["kind"] {
  if (sourceKind === "repo_memory") return "repo_rule";
  if (sourceKind === "memory_message") return "session_observation";
  if (sourceKind === "company_fact") return "company_fact";
  if (sourceKind === "company_take") return "company_take";
  if (sourceKind === "memory_scope_card") return "scope_card";
  return "derived_conclusion";
}

function semanticDocumentMemoryId(row: MemorySemanticDocumentRow): string {
  return row.sourceKind === "memory_conclusion"
    ? memoryConclusionMemoryId(row.sourceId)
    : `${row.sourceKind}:${row.sourceId}`;
}

function memoryConclusionMemoryId(conclusionId: string): string {
  return `memory_conclusion:${conclusionId}`;
}

function highestCardConfidence(entries: Array<{ confidence: MemoryContextConfidence }>): MemoryContextConfidence {
  if (entries.some((entry) => entry.confidence === "high")) return "high";
  if (entries.some((entry) => entry.confidence === "medium")) return "medium";
  return "low";
}

function hasLexicalLane(laneCounts: Record<string, number>): boolean {
  return (laneCounts.repo_fts ?? 0) > 0 || (laneCounts.conclusion_fts ?? 0) > 0 || (laneCounts.message_fts ?? 0) > 0;
}

function isVectorRowAllowedForMode(
  sourceKind: MemorySemanticDocumentRow["sourceKind"],
  mode: MemoryContextMode,
  companyMemoryDisabled: boolean,
): boolean {
  const isRepoDerived = sourceKind === "repo_memory";
  if (mode === "repo") return isRepoDerived;
  if (!isRepoDerived && companyMemoryDisabled) return false;
  if (mode === "company") return !isRepoDerived;
  return true;
}

async function retrieveCompanyMemoryForContext(
  env: Env,
  db: D1Database,
  sessionId: string,
  scope: CompanyMemorySessionScope,
  input: MemoryContextRequest,
): Promise<{ memories: MemoryContextMemory[]; block: string; retrievalTrace: unknown }> {
  const retrieveScope = await resolveCompanyMemoryBootstrapScope(env, {
    businessId: scope.businessId,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    callbackContext: scope.callbackContext,
  });
  if (input.customer) retrieveScope.customerSlug = input.customer;
  const denoisedQuery = denoiseTaskInput({
    rawText: input.intent,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    files: input.files,
  }).denoisedTaskText;
  const result = await retrieveCompanyMemory(env, {
    query: denoisedQuery,
    scope: retrieveScope,
    topK: input.maxMemories,
    timeoutMs: MEMORY_CONTEXT_COMPANY_RECALL_TIMEOUT_MS,
    files: input.files,
    includeActionItems: input.includeActionItems,
    includeOpenQuestions: input.includeOpenQuestions,
    retrievalMode: "explicit_recall",
  });
  await recordMemoryUsageEvents(
    db,
    result.memories.map((memory, index) => ({
      repoOwner: scope.repoOwner,
      repoName: scope.repoName,
      sessionId,
      promptId: "memory-context",
      memoryId: memory.id,
      source: "company_recall",
      selectionRank: index + 1,
      selectionScore: memory.score,
      intent: denoisedQuery,
      filesJson: input.files.length ? JSON.stringify(input.files) : null,
    })),
  );
  return {
    block: formatCompanyMemoryBlock(result.memories),
    memories: result.memories.flatMap((memory): MemoryContextMemory[] => {
      const sourceKind = memory.source === "fact" ? "company_fact" : "company_take";
      return [
        {
          id: memory.id,
          kind: sourceKind,
          content: memory.claim,
          level: null,
          whyReturned: "selected_by_company_memory_context",
          confidence: confidenceFromNumber(memory.confidence),
          enforcement: "none",
          provenance: [
            {
              sourceKind,
              sourceId: memory.id,
              excerpt: memory.source_events[0]?.source_uri ?? null,
            },
          ],
        },
      ];
    }),
    retrievalTrace: result.retrievalTrace,
  };
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim())
    .slice(0, 25);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (typeof entry === "number" && Number.isFinite(entry) ? [Math.floor(entry)] : []));
}

function vectorNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.flatMap((entry) => (typeof entry === "number" && Number.isFinite(entry) ? [entry] : []));
  return numbers.length ? numbers.slice(0, 4096) : null;
}

function repoMemoryCandidates(value: unknown): RepoMemoryRecallCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry): RepoMemoryRecallCandidate[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const id = (entry as Record<string, unknown>).id;
      return typeof id === "string" && id.trim() ? [entry as RepoMemoryRecallCandidate] : [];
    })
    .slice(0, MEMORY_CONTEXT_MAX_CANDIDATES);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
