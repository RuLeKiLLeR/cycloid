import {
  buildRetrievalSignals,
  buildSignalIdf,
  GENERIC_REPO_MEMORY_SYMBOL_TERMS,
  isPullRequestReferencedForRepo,
  isUsefulRecallEvidenceTerm,
  normalizeSignalTerms,
  overlapScore,
  type PathMatchEvidence,
  pathSpecificityScore,
  textSimilarityScore,
} from "../../../../shared/memory/retrieval-signals.js";
import { denoiseTaskInput } from "../../../../shared/memory/task-denoising.js";

const REPO_MEMORY_RECALL_TRACE_MAX_REJECTED = 40;
const GENERIC_REPO_MEMORY_TOOL_TRIGGERS = new Set(["apply_patch", "bash"]);
const GENERIC_REPO_MEMORY_ERROR_TERMS = new Set(["error", "errors", "fail", "failed", "failure", "failures", "failur"]);
const GENERIC_REPO_MEMORY_TOOL_ANCHOR_TERMS = new Set(["edit", "editing", "requested", "general"]);
const REPO_MEMORY_RECALL_CONFIG = {
  version: "repo-memory-structured-v6-pr-reference",
  minFinalScore: 0.6,
  concreteTextMinFinalScore: 0.6,
  concreteTextMinTerms: 6,
  sameSourceSiblingMinFinalScore: 0.35,
  maxSelected: 3,
} as const;

export type RepoMemoryRecallCandidate = {
  id: string;
  type?: unknown;
  action_type?: unknown;
  level?: unknown;
  primitive?: unknown;
  authority?: unknown;
  enforcement?: unknown;
  context_hint?: unknown;
  applies_to?: unknown;
  candidate_channels?: unknown;
  source_pr_number?: unknown;
  source_session_ids?: unknown;
  triggers?: unknown;
  symbols?: unknown;
  subjects?: unknown;
  tags?: unknown;
  content?: unknown;
};

export type RepoMemoryRecallRequest = {
  repoOwner: string | null;
  repoName: string | null;
  intent: string;
  files: string[];
  symbols: string[];
  tool: string | null;
  sourcePrNumbers: number[];
  sourceSessionIds: string[];
  memories: RepoMemoryRecallCandidate[];
};

export type RepoMemoryRecallRanking = {
  id: string;
  score: number;
  reason?: string;
  expected_effect?: string;
};

export type RepoMemoryRecallTrace = {
  retrievalConfigVersion: string;
  rawPromptHash: string;
  denoisedPromptHash: string;
  denoisedTaskExcerpt: string;
  removedSections: string[];
  structuredSignals: Record<string, unknown>;
  candidateCount: number;
  selectedCount: number;
  returnedEmpty: boolean;
  timedOut: boolean;
  selectedCandidates: Array<{
    memoryId: string;
    memorySource: "repo";
    candidateChannels: string[];
    bridgeCandidateChannels?: string[];
    rawChannelScores?: Record<string, number>;
    pathMatches?: PathMatchEvidence[];
    matchedTerms?: Record<string, string[]>;
    actionSurface?: ActionSurfaceDecision;
    fusedScore?: number;
    rerankScore?: number;
    finalScore: number;
    decision: "selected";
    selectionRationale: string;
    expectedActionChange?: string;
    sourceArtifactId?: string | null;
  }>;
  rejectedCandidates: Array<{
    memoryId: string;
    memorySource: "repo";
    candidateChannels: string[];
    bridgeCandidateChannels?: string[];
    rawChannelScores?: Record<string, number>;
    pathMatches?: PathMatchEvidence[];
    matchedTerms?: Record<string, string[]>;
    actionSurface?: ActionSurfaceDecision;
    fusedScore?: number;
    rerankScore?: number;
    finalScore: number | null;
    decision: "rejected";
    rejectReason: string;
    sourceArtifactId?: string | null;
  }>;
};

type CandidateChannel =
  "exact_identifier" | "path_match" | "symbol_match" | "tool_or_command_match" | "error_fingerprint" | "fts_match";

type ScoredRepoMemoryCandidate = {
  memory: RepoMemoryRecallCandidate;
  channels: CandidateChannel[];
  bridgeCandidateChannels: string[];
  rawChannelScores: Partial<Record<CandidateChannel, number>>;
  pathMatches: PathMatchEvidence[];
  matchedTerms: Partial<Record<"symbol" | "tool" | "error" | "text", string[]>>;
  actionSurface: ActionSurfaceDecision;
  fusedScore: number;
  finalScore: number;
  sourceArtifactId: string | null;
};

type RepoMemoryRecallFocus = {
  sourceArtifactId: string;
  reason: "exact_identifier" | "strong_source_cluster";
};

type ActionSurfaceDecision = {
  compatible: boolean;
  reason: "compatible" | "missing_action_anchor" | "weak_path_only" | "same_domain_wrong_mechanism";
  matchedMechanisms: string[];
};

type RepoMemoryRecallTaskContext = {
  denoised: ReturnType<typeof denoiseTaskInput>;
  signals: ReturnType<typeof buildRetrievalSignals>;
};

type ToolMatchForRepoMemoryRecall = {
  matchedTerms: string[];
  score: number;
};

export async function rankRepoMemoryRecallCandidates(
  input: RepoMemoryRecallRequest,
): Promise<{ rankings: RepoMemoryRecallRanking[]; retrievalTrace: RepoMemoryRecallTrace }> {
  const result = selectRepoMemoryRecallCandidates(input);
  return { rankings: result.rankings, retrievalTrace: result.retrievalTrace };
}

function selectRepoMemoryRecallCandidates(input: RepoMemoryRecallRequest): {
  rankings: RepoMemoryRecallRanking[];
  retrievalTrace: RepoMemoryRecallTrace;
} {
  const idf = buildSignalIdf(input.memories.map(memoryTextForRepoMemoryRecall));
  const taskContext = buildRepoMemoryRecallTaskContext(input);
  const allScored = input.memories
    .map((memory) => scoreRepoMemoryRecallCandidate(memory, input, idf, taskContext))
    .sort(compareScoredRepoMemoryCandidates);
  const scored = allScored
    .filter(
      (candidate) =>
        candidate.bridgeCandidateChannels.length > 0 || candidate.channels.length > 0 || candidate.fusedScore > 0,
    )
    .sort(compareScoredRepoMemoryCandidates);
  const focus = selectRepoMemoryRecallFocusSource(scored);
  const selected: ScoredRepoMemoryCandidate[] = [];
  const rejected: Array<{ candidate: ScoredRepoMemoryCandidate; reason: string }> = [];

  for (const candidate of scored) {
    const rejectReason = repoMemoryRecallRejectReason(candidate, focus);
    if (rejectReason || selected.length >= REPO_MEMORY_RECALL_CONFIG.maxSelected) {
      rejected.push({ candidate, reason: rejectReason ?? "duplicate_of_selected_memory" });
      continue;
    }
    selected.push(candidate);
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.memory.id));
  const selectedSourceArtifactIds = new Set(
    selected.flatMap((candidate) => (candidate.sourceArtifactId ? [candidate.sourceArtifactId] : [])),
  );
  for (const candidate of allScored) {
    if (selected.length >= REPO_MEMORY_RECALL_CONFIG.maxSelected) break;
    if (selectedIds.has(candidate.memory.id)) continue;
    if (!candidate.sourceArtifactId || !selectedSourceArtifactIds.has(candidate.sourceArtifactId)) continue;
    if (repoMemoryRecallRejectReason(candidate, focus) !== null) continue;
    selected.push(candidate);
    selectedIds.add(candidate.memory.id);
  }
  const finalSelectedIds = new Set(selected.map((candidate) => candidate.memory.id));
  const finalRejected = rejected.filter(({ candidate }) => !finalSelectedIds.has(candidate.memory.id));

  const rankings = selected.map((candidate) => ({
    id: candidate.memory.id,
    score: candidate.finalScore,
    reason: repoMemoryRecallRationale(candidate),
    expected_effect: repoMemoryRecallExpectedEffect(candidate),
  }));
  return {
    rankings,
    retrievalTrace: buildRepoMemoryRecallTrace(input, rankings, false, {
      selected,
      rejected: finalRejected,
    }),
  };
}

function buildRepoMemoryRecallTaskContext(input: RepoMemoryRecallRequest): RepoMemoryRecallTaskContext {
  const denoised = denoiseTaskInput({ rawText: input.intent, repoOwner: input.repoOwner, repoName: input.repoName });
  return {
    denoised,
    signals: buildRetrievalSignals({
      text: denoised.denoisedTaskText,
      files: input.files,
      symbols: input.symbols,
    }),
  };
}

function stringArrayForRepoMemoryRecall(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

function numberArrayForRepoMemoryRecall(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const numberValue = numberForRepoMemoryRecall(entry);
    return numberValue === null ? [] : [numberValue];
  });
}

function stringOrNullForRepoMemoryRecall(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildRepoMemoryRecallTrace(
  input: RepoMemoryRecallRequest,
  rankings: RepoMemoryRecallRanking[],
  timedOut: boolean,
  scoredTrace?: {
    selected: ScoredRepoMemoryCandidate[];
    rejected: Array<{ candidate: ScoredRepoMemoryCandidate; reason: string }>;
  },
): RepoMemoryRecallTrace {
  const denoised = denoiseTaskInput({ rawText: input.intent, repoOwner: input.repoOwner, repoName: input.repoName });
  const rankingById = new Map(rankings.map((ranking) => [ranking.id, ranking]));
  const selectedRankings = [...rankings].sort((a, b) => b.score - a.score);
  const selectedIds = new Set(selectedRankings.map((ranking) => ranking.id));
  return {
    retrievalConfigVersion: REPO_MEMORY_RECALL_CONFIG.version,
    rawPromptHash: denoised.rawFingerprint,
    denoisedPromptHash: denoised.taskFingerprint,
    denoisedTaskExcerpt: truncateForRepoRecallTrace(denoised.denoisedTaskText, 500),
    removedSections: denoised.removedSections,
    structuredSignals: {
      ...denoised.structuredSignals,
      files: input.files,
      symbols: input.symbols,
      tool: input.tool,
      sourcePrNumbers: input.sourcePrNumbers,
      sourceSessionIds: input.sourceSessionIds,
    },
    candidateCount: input.memories.length,
    selectedCount: selectedRankings.length,
    returnedEmpty: selectedRankings.length === 0,
    timedOut,
    selectedCandidates: scoredTrace
      ? scoredTrace.selected.map((candidate) => selectedTraceCandidate(candidate, rankingById.get(candidate.memory.id)))
      : selectedRankings.map((ranking) => ({
          memoryId: ranking.id,
          memorySource: "repo",
          candidateChannels: candidateChannelsForRepoRecall(input.memories.find((memory) => memory.id === ranking.id)),
          finalScore: ranking.score,
          decision: "selected",
          selectionRationale: ranking.reason ?? "selected_by_repo_memory_recall_gate",
        })),
    rejectedCandidates: scoredTrace
      ? scoredTrace.rejected
          .slice(0, REPO_MEMORY_RECALL_TRACE_MAX_REJECTED)
          .map(({ candidate, reason }) => rejectedTraceCandidate(candidate, reason))
      : input.memories
          .filter((memory) => !selectedIds.has(memory.id))
          .slice(0, REPO_MEMORY_RECALL_TRACE_MAX_REJECTED)
          .map((memory) => {
            const ranking = rankingById.get(memory.id);
            return {
              memoryId: memory.id,
              memorySource: "repo" as const,
              candidateChannels: candidateChannelsForRepoRecall(memory),
              finalScore: ranking?.score ?? null,
              decision: "rejected" as const,
              rejectReason: ranking ? "below_score_threshold" : "not_considered",
            };
          }),
  };
}

function candidateChannelsForRepoRecall(memory: RepoMemoryRecallCandidate | undefined): string[] {
  return memory ? stringArrayForRepoMemoryRecall(memory.candidate_channels) : [];
}

function scoreRepoMemoryRecallCandidate(
  memory: RepoMemoryRecallCandidate,
  input: RepoMemoryRecallRequest,
  idf: ReadonlyMap<string, number>,
  taskContext: RepoMemoryRecallTaskContext,
): ScoredRepoMemoryCandidate {
  const rawChannelScores: Partial<Record<CandidateChannel, number>> = {};
  const channels: CandidateChannel[] = [];
  const matchedTerms: ScoredRepoMemoryCandidate["matchedTerms"] = {};
  const add = (channel: CandidateChannel, score: number): void => {
    if (score <= 0) return;
    rawChannelScores[channel] = Math.max(rawChannelScores[channel] ?? 0, score);
    if (!channels.includes(channel)) channels.push(channel);
  };

  const bridgeCandidateChannels = stringArrayForRepoMemoryRecall(memory.candidate_channels);
  const { denoised, signals: taskSignals } = taskContext;
  const sourcePrNumber = numberForRepoMemoryRecall(memory.source_pr_number);
  if (sourcePrNumber !== null && isSourcePrNumberReferencedForRepoMemoryRecall(sourcePrNumber, input, denoised)) {
    add("exact_identifier", 0.98);
  }
  const sourceSessionIds = stringArrayForRepoMemoryRecall(memory.source_session_ids);
  if (sourceSessionIds.some((sessionId) => input.sourceSessionIds.includes(sessionId))) {
    add("exact_identifier", 0.98);
  }
  const appliesTo = stringArrayForRepoMemoryRecall(memory.applies_to);
  const pathEvidence = pathSpecificityScore(appliesTo, taskSignals.files);
  add("path_match", pathEvidence.score);
  const symbolTerms = normalizeSignalTerms(
    [
      ...stringArrayForRepoMemoryRecall(memory.symbols),
      ...stringArrayForRepoMemoryRecall(memory.subjects),
      ...stringArrayForRepoMemoryRecall(memory.tags),
    ].join(" "),
  );
  const inputSymbolTerms = normalizeSignalTerms(input.symbols.join(" "));
  const symbolScore = overlapScore(symbolTerms, inputSymbolTerms);
  if (symbolScore >= 0.12) {
    const matchedSymbolTerms = matchedSignalTerms(symbolTerms, inputSymbolTerms).filter(
      (term) => !GENERIC_REPO_MEMORY_SYMBOL_TERMS.has(term),
    );
    if (matchedSymbolTerms.length > 0) {
      matchedTerms.symbol = matchedSymbolTerms;
      add("symbol_match", Math.min(0.78, symbolScore + 0.25));
    }
  }
  const commandOverlap = commandOverlapForRepoMemoryRecall(memory, input, taskSignals, pathEvidence.score > 0);
  if (commandOverlap.score > 0) {
    matchedTerms.tool = commandOverlap.matchedTerms;
    add("tool_or_command_match", commandOverlap.score);
  } else if (commandOverlap.matchedTerms.length > 0) {
    matchedTerms.tool = commandOverlap.matchedTerms;
  }
  const errorOverlap = errorFingerprintOverlapForRepoMemoryRecall(memory, denoised.denoisedTaskText);
  if (errorOverlap.score > 0) {
    matchedTerms.error = errorOverlap.matchedTerms;
    add("error_fingerprint", errorOverlap.score);
  }
  const ftsScore = textSimilarityScore(memoryTextForRepoMemoryRecall(memory), taskSignals.terms, idf);
  const textTerms = distinctiveMatchedTerms(memoryTextForRepoMemoryRecall(memory), taskSignals.terms, idf);
  if (textTerms.length > 0) matchedTerms.text = textTerms;
  if (ftsScore >= 0.12) {
    add("fts_match", Math.min(0.72, ftsScore + 0.18));
  } else if (textTerms.length >= 4 && bridgeCandidateChannels.includes("text_retrieval")) {
    add("fts_match", 0.6);
  }

  const strongest = Math.max(0, ...Object.values(rawChannelScores));
  const channelBonus = Math.min(0.12, Math.max(0, channels.length - 1) * 0.04);
  const concreteBonus = channels.some((channel) => channel !== "fts_match") ? 0.08 : 0;
  const fusedScore = Math.min(1, strongest + channelBonus + concreteBonus);
  const actionSurface = actionSurfaceDecisionForRepoMemoryRecall(
    channels,
    pathEvidence.matches,
    matchedTerms,
    taskSignals.files.length,
  );
  return {
    memory,
    channels,
    bridgeCandidateChannels,
    rawChannelScores,
    pathMatches: pathEvidence.matches,
    matchedTerms,
    actionSurface,
    fusedScore,
    finalScore: fusedScore,
    sourceArtifactId: sourceArtifactIdForRepoMemoryRecall(memory),
  };
}

function repoMemoryRecallRejectReason(
  candidate: ScoredRepoMemoryCandidate,
  focus: RepoMemoryRecallFocus | null,
): string | null {
  const focusSourceArtifactId = focus?.sourceArtifactId ?? null;
  const focusedSiblingMinScore =
    focus?.reason === "exact_identifier" ? REPO_MEMORY_RECALL_CONFIG.sameSourceSiblingMinFinalScore : 0.6;
  const focusedSourceSibling =
    focusSourceArtifactId !== null &&
    candidate.sourceArtifactId === focusSourceArtifactId &&
    candidate.actionSurface.compatible &&
    candidate.finalScore >= focusedSiblingMinScore;
  if (!candidate.actionSurface.compatible) {
    return candidate.actionSurface.reason;
  }
  if (isPureTextRepoMemoryRecallCandidate(candidate) && !hasConcreteTextEvidenceForRepoMemoryRecall(candidate)) {
    return "weak_text_only_match";
  }
  if (candidate.finalScore < REPO_MEMORY_RECALL_CONFIG.minFinalScore && !focusedSourceSibling) {
    return "below_score_threshold";
  }
  if (focusSourceArtifactId && candidate.sourceArtifactId && candidate.sourceArtifactId !== focusSourceArtifactId) {
    return "same_subsystem_wrong_mechanism";
  }
  return null;
}

function selectRepoMemoryRecallFocusSource(candidates: ScoredRepoMemoryCandidate[]): RepoMemoryRecallFocus | null {
  const exact = candidates
    .filter((candidate) => candidate.sourceArtifactId && candidate.channels.includes("exact_identifier"))
    .sort(compareScoredRepoMemoryCandidates)[0];
  if (exact?.sourceArtifactId) {
    return { sourceArtifactId: exact.sourceArtifactId, reason: "exact_identifier" };
  }

  const groups = new Map<string, ScoredRepoMemoryCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.sourceArtifactId) continue;
    const group = groups.get(candidate.sourceArtifactId) ?? [];
    group.push(candidate);
    groups.set(candidate.sourceArtifactId, group);
  }
  let best: { id: string; score: number } | null = null;
  for (const [id, group] of groups) {
    const sorted = [...group].sort(compareScoredRepoMemoryCandidates);
    const top = sorted[0];
    if (!top || top.finalScore < 0.5) continue;
    const focusEligible = sorted.filter(isFocusEligibleRepoMemoryRecallCandidate);
    if (focusEligible.length === 0) continue;
    const score = Math.max(...focusEligible.map(sourceFocusEvidenceScoreForRepoMemoryRecall));
    if (!best || score > best.score || (score === best.score && id.localeCompare(best.id) < 0)) {
      best = { id, score };
    }
  }
  return best?.score && best.score >= 0.6 ? { sourceArtifactId: best.id, reason: "strong_source_cluster" } : null;
}

function sourceFocusEvidenceScoreForRepoMemoryRecall(candidate: ScoredRepoMemoryCandidate): number {
  const symbolScore = candidate.rawChannelScores.symbol_match ?? 0;
  const toolScore = candidate.rawChannelScores.tool_or_command_match ?? 0;
  const errorScore = candidate.rawChannelScores.error_fingerprint ?? 0;
  const textScore = candidate.rawChannelScores.fts_match ?? 0;
  const strongestPathScore = Math.max(0, ...candidate.pathMatches.map((match) => match.score));
  const pathSupport = strongestPathScore >= 0.95 ? 0.18 : strongestPathScore > 0 ? 0.08 : 0;
  const matchedTextSupport = Math.min(0.18, (candidate.matchedTerms.text?.length ?? 0) * 0.02);
  return Math.min(1.4, symbolScore + toolScore + errorScore + textScore + pathSupport + matchedTextSupport);
}

function isPureTextRepoMemoryRecallCandidate(candidate: ScoredRepoMemoryCandidate): boolean {
  return candidate.channels.length > 0 && candidate.channels.every((channel) => channel === "fts_match");
}

function hasConcreteTextEvidenceForRepoMemoryRecall(candidate: ScoredRepoMemoryCandidate): boolean {
  return (
    (candidate.matchedTerms.text?.length ?? 0) >= REPO_MEMORY_RECALL_CONFIG.concreteTextMinTerms &&
    candidate.finalScore >= REPO_MEMORY_RECALL_CONFIG.concreteTextMinFinalScore
  );
}

function isFocusEligibleRepoMemoryRecallCandidate(candidate: ScoredRepoMemoryCandidate): boolean {
  if (!candidate.actionSurface.compatible) return false;
  if (isPureTextRepoMemoryRecallCandidate(candidate)) return hasConcreteTextEvidenceForRepoMemoryRecall(candidate);
  return true;
}

function selectedTraceCandidate(
  candidate: ScoredRepoMemoryCandidate,
  ranking: RepoMemoryRecallRanking | undefined,
): RepoMemoryRecallTrace["selectedCandidates"][number] {
  return {
    memoryId: candidate.memory.id,
    memorySource: "repo",
    candidateChannels: candidate.channels,
    bridgeCandidateChannels: candidate.bridgeCandidateChannels,
    rawChannelScores: rawChannelScoresRecord(candidate.rawChannelScores),
    pathMatches: candidate.pathMatches,
    matchedTerms: matchedTermsRecord(candidate.matchedTerms),
    actionSurface: candidate.actionSurface,
    fusedScore: candidate.fusedScore,
    rerankScore: candidate.finalScore,
    finalScore: candidate.finalScore,
    decision: "selected",
    selectionRationale: ranking?.reason ?? repoMemoryRecallRationale(candidate),
    expectedActionChange: ranking?.expected_effect ?? repoMemoryRecallExpectedEffect(candidate),
    sourceArtifactId: candidate.sourceArtifactId,
  };
}

function rejectedTraceCandidate(
  candidate: ScoredRepoMemoryCandidate,
  reason: string,
): RepoMemoryRecallTrace["rejectedCandidates"][number] {
  return {
    memoryId: candidate.memory.id,
    memorySource: "repo",
    candidateChannels: candidate.channels,
    bridgeCandidateChannels: candidate.bridgeCandidateChannels,
    rawChannelScores: rawChannelScoresRecord(candidate.rawChannelScores),
    pathMatches: candidate.pathMatches,
    matchedTerms: matchedTermsRecord(candidate.matchedTerms),
    actionSurface: candidate.actionSurface,
    fusedScore: candidate.fusedScore,
    rerankScore: candidate.finalScore,
    finalScore: candidate.finalScore,
    decision: "rejected",
    rejectReason: reason,
    sourceArtifactId: candidate.sourceArtifactId,
  };
}

function rawChannelScoresRecord(scores: Partial<Record<CandidateChannel, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(scores).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function matchedTermsRecord(
  terms: Partial<Record<"symbol" | "tool" | "error" | "text", string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(terms).filter(([, value]) => Array.isArray(value) && value.length > 0));
}

function repoMemoryRecallRationale(candidate: ScoredRepoMemoryCandidate): string {
  return `returned_by_${candidate.channels.join("+") || "unknown"}_score_${candidate.finalScore.toFixed(2)}`;
}

function repoMemoryRecallExpectedEffect(candidate: ScoredRepoMemoryCandidate): string {
  if (candidate.channels.includes("exact_identifier"))
    return "Apply the prior fix pattern from the matched source artifact.";
  if (candidate.channels.includes("path_match")) return "Check the memory before editing the matched path.";
  if (candidate.channels.includes("error_fingerprint"))
    return "Use the prior failure fingerprint to choose the next diagnostic.";
  return "Use the matched symbols, commands, or task terms to avoid a known prior failure mode.";
}

function compareScoredRepoMemoryCandidates(a: ScoredRepoMemoryCandidate, b: ScoredRepoMemoryCandidate): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  const textChannelDelta = Number(b.channels.includes("fts_match")) - Number(a.channels.includes("fts_match"));
  if (textChannelDelta !== 0) return textChannelDelta;
  const matchedTextDelta = (b.matchedTerms.text?.length ?? 0) - (a.matchedTerms.text?.length ?? 0);
  if (matchedTextDelta !== 0) return matchedTextDelta;
  return a.memory.id.localeCompare(b.memory.id);
}

function commandOverlapForRepoMemoryRecall(
  memory: RepoMemoryRecallCandidate,
  input: RepoMemoryRecallRequest,
  taskSignals: RepoMemoryRecallTaskContext["signals"],
  hasPathAnchor: boolean,
): ToolMatchForRepoMemoryRecall {
  if (!input.tool) return { score: 0, matchedTerms: [] };
  const triggerTools = toolTriggersForRepoMemoryRecall(memory);
  if (triggerTools.includes(input.tool)) {
    if (isGenericToolTriggerForRepoMemoryRecall(input.tool)) {
      return {
        score: hasAdditionalToolAnchorForRepoMemoryRecall(memory, taskSignals, hasPathAnchor) ? 0.52 : 0,
        matchedTerms: [input.tool],
      };
    }
    return { score: 0.74, matchedTerms: [input.tool] };
  }
  const memoryTerms = buildRetrievalSignals({ text: memoryTextForRepoMemoryRecall(memory) }).terms;
  const toolTerms = buildRetrievalSignals({ text: input.tool }).terms;
  const matchedTerms = matchedSignalTerms(memoryTerms, toolTerms);
  return { score: matchedTerms.length > 0 ? 0.42 : 0, matchedTerms };
}

function toolTriggersForRepoMemoryRecall(memory: RepoMemoryRecallCandidate): string[] {
  if (!memory.triggers || typeof memory.triggers !== "object" || Array.isArray(memory.triggers)) return [];
  const triggers = memory.triggers as Record<string, unknown>;
  return uniqueStrings([
    ...stringArrayForRepoMemoryRecall(triggers.tools),
    ...stringArrayForRepoMemoryRecall(triggers.mcp_tools),
  ]);
}

function isGenericToolTriggerForRepoMemoryRecall(tool: string): boolean {
  return GENERIC_REPO_MEMORY_TOOL_TRIGGERS.has(tool.trim().toLowerCase());
}

function hasAdditionalToolAnchorForRepoMemoryRecall(
  memory: RepoMemoryRecallCandidate,
  taskSignals: RepoMemoryRecallTaskContext["signals"],
  hasPathAnchor: boolean,
): boolean {
  if (hasPathAnchor) return true;
  const triggers = isRecordForRepoMemoryRecall(memory.triggers) ? memory.triggers : null;
  if (
    triggers &&
    pathSpecificityScore(stringArrayForRepoMemoryRecall(triggers.path_globs), taskSignals.files).score > 0
  ) {
    return true;
  }
  const memoryTextTerms = buildRetrievalSignals({ text: memoryTextForRepoMemoryRecall(memory) }).terms;
  if (
    matchedSignalTerms(memoryTextTerms, taskSignals.terms).some(
      (term) => !GENERIC_REPO_MEMORY_TOOL_ANCHOR_TERMS.has(term),
    )
  ) {
    return true;
  }
  if (!triggers) return false;
  const commandTerms = buildRetrievalSignals({
    text: [
      ...stringArrayForRepoMemoryRecall(triggers.command_patterns),
      ...stringArrayForRepoMemoryRecall(triggers.forbidden_patterns),
    ].join(" "),
  }).terms;
  return matchedSignalTerms(commandTerms, taskSignals.terms).length > 0;
}

function isRecordForRepoMemoryRecall(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFingerprintOverlapForRepoMemoryRecall(
  memory: RepoMemoryRecallCandidate,
  taskText: string,
): { score: number; matchedTerms: string[] } {
  const errorTerms = buildRetrievalSignals({ text: taskText }).errorTerms;
  if (errorTerms.length === 0) return { score: 0, matchedTerms: [] };
  const memoryTerms = buildRetrievalSignals({ text: memoryTextForRepoMemoryRecall(memory) }).errorTerms;
  const matched = uniqueStrings(errorTerms.filter((term) => memoryTerms.includes(term)));
  const concreteMatched = matched.filter((term) => !GENERIC_REPO_MEMORY_ERROR_TERMS.has(term));
  if (concreteMatched.length === 0) {
    return { score: 0, matchedTerms: matched };
  }
  return {
    score: concreteMatched.length >= 2 ? 0.72 : concreteMatched.length === 1 ? 0.48 : 0,
    matchedTerms: matched,
  };
}

function memoryTextForRepoMemoryRecall(memory: RepoMemoryRecallCandidate): string {
  return [
    memory.id,
    stringOrNullForRepoMemoryRecall(memory.context_hint),
    stringOrNullForRepoMemoryRecall(memory.content),
    stringArrayForRepoMemoryRecall(memory.applies_to).join(" "),
    stringArrayForRepoMemoryRecall(memory.symbols).join(" "),
    stringArrayForRepoMemoryRecall(memory.subjects).join(" "),
    stringArrayForRepoMemoryRecall(memory.tags).join(" "),
  ].join(" ");
}

function sourceArtifactIdForRepoMemoryRecall(memory: RepoMemoryRecallCandidate): string | null {
  const sourcePrNumber = numberForRepoMemoryRecall(memory.source_pr_number);
  if (sourcePrNumber !== null) return `pr:${sourcePrNumber}`;
  const firstSessionId = stringArrayForRepoMemoryRecall(memory.source_session_ids)[0];
  return firstSessionId ? `session:${firstSessionId}` : null;
}

function isSourcePrNumberReferencedForRepoMemoryRecall(
  sourcePrNumber: number,
  input: RepoMemoryRecallRequest,
  denoised: ReturnType<typeof denoiseTaskInput>,
): boolean {
  if (input.sourcePrNumbers.includes(sourcePrNumber)) return true;
  return isPullRequestReferencedForRepo(denoised.denoisedTaskText, sourcePrNumber, input.repoOwner, input.repoName);
}

function numberForRepoMemoryRecall(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function actionSurfaceDecisionForRepoMemoryRecall(
  channels: CandidateChannel[],
  pathMatches: PathMatchEvidence[],
  matchedTerms: Partial<Record<"symbol" | "tool" | "error" | "text", string[]>>,
  taskFileCount: number,
): ActionSurfaceDecision {
  const matchedMechanisms = uniqueStrings([
    ...(matchedTerms.symbol ?? []),
    ...(matchedTerms.tool ?? []),
    ...(matchedTerms.error ?? []),
    ...(matchedTerms.text ?? []),
  ]);
  if (channels.includes("exact_identifier")) return { compatible: true, reason: "compatible", matchedMechanisms };
  if (channels.includes("tool_or_command_match") || channels.includes("error_fingerprint")) {
    return { compatible: true, reason: "compatible", matchedMechanisms };
  }
  if ((matchedTerms.symbol?.length ?? 0) > 0) return { compatible: true, reason: "compatible", matchedMechanisms };
  const strongestPathScore = Math.max(0, ...pathMatches.map((match) => match.score));
  if (strongestPathScore >= 0.6 && ((matchedTerms.text?.length ?? 0) >= 3 || taskFileCount <= 3))
    return { compatible: true, reason: "compatible", matchedMechanisms };
  if (strongestPathScore > 0) return { compatible: false, reason: "weak_path_only", matchedMechanisms };
  if ((matchedTerms.text?.length ?? 0) >= 3) return { compatible: true, reason: "compatible", matchedMechanisms };
  if (channels.includes("fts_match"))
    return { compatible: false, reason: "same_domain_wrong_mechanism", matchedMechanisms };
  return { compatible: false, reason: "missing_action_anchor", matchedMechanisms };
}

function matchedSignalTerms(left: string[], right: string[]): string[] {
  const leftSet = new Set(left.flatMap((term) => normalizeSignalTerms(term)));
  return uniqueStrings(right.flatMap((term) => normalizeSignalTerms(term)).filter((term) => leftSet.has(term)));
}

function distinctiveMatchedTerms(text: string, taskTerms: string[], idf: ReadonlyMap<string, number>): string[] {
  const memoryTerms = new Set(normalizeSignalTerms(text));
  return uniqueStrings(
    taskTerms
      .filter((term) => memoryTerms.has(term))
      .filter((term) => isUsefulRecallEvidenceTerm(term))
      .filter((term) => (idf.get(term) ?? 0.1) >= 0.25),
  ).slice(0, 8);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function truncateForRepoRecallTrace(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}...[truncated]`;
}
