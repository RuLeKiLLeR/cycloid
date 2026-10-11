import type { PlatformLlmFailureCategory } from "../../../../shared/llm/platform-llm-contract.js";
import type {
  ReviewLoopTriageActionItem,
  ReviewLoopTriageCandidateItem,
  ReviewLoopTriageConflict,
  ReviewLoopTriageDroppedItem,
  ReviewLoopTriageItemKind,
  ReviewLoopTriageLlmInput,
} from "../../../../shared/llm/prompt-preparation.js";
import { isReviewLoopTriageLlmOutput } from "../../../../shared/llm/prompt-preparation.js";
import { PLATFORM_LLM_CALL_CONFIG } from "../constants/platform-llm";
import type { ReviewLoopWorklistItem } from "../github/pr";
import type { Logger } from "../logger";
import { emitReviewLoopTriageMetric } from "../observability/pr-metrics";
import type { Env } from "../types";
import { executePlatformLlmCall } from "./platform-llm";

export type ReviewLoopTriageFallbackReason =
  | "empty_worklist"
  | "too_many_items"
  | "llm_unavailable"
  | "llm_failed"
  | "output_invalid"
  | "no_action_items"
  | "coverage_gap"
  | "duplicate_coverage";

export type ReviewLoopTriageOutcome =
  | {
      ok: true;
      actionItems: ReviewLoopTriageActionItem[];
      droppedItems: ReviewLoopTriageDroppedItem[];
      /**
       * Conflicting action items (see validateTriageConflicts): each entry spans >= 2 DISTINCT action
       * items — one representative source id per item — with a non-empty summary. A cross-reference,
       * not coverage: the ids are still covered by their own action items. Lets the prompt flag
       * contradictions so the agent picks one with an explanation instead of guessing.
       */
      conflicts: ReviewLoopTriageConflict[];
      /** Action items discarded because they referenced a source id not present in the input. */
      discardedActionItemCount: number;
    }
  | { ok: false; reason: ReviewLoopTriageFallbackReason };

function reviewLoopTriageFallbackReasonForLlmFailure(
  category: PlatformLlmFailureCategory,
): Extract<ReviewLoopTriageFallbackReason, "llm_unavailable" | "llm_failed"> {
  return category === "provider_error_nonretryable" ? "llm_unavailable" : "llm_failed";
}

function reviewLoopTriageLocation(item: ReviewLoopWorklistItem): string | null {
  if (!item.path) return null;
  const hasRange = typeof item.startLine === "number" && typeof item.line === "number" && item.startLine !== item.line;
  const lineSuffix =
    typeof item.line !== "number" ? "" : hasRange ? `:${item.startLine}-${item.line}` : `:${item.line}`;
  const mixedSides = hasRange && item.startSide !== null && item.side !== null && item.startSide !== item.side;
  const annotations = [
    ...(mixedSides ? ["mixed diff sides"] : item.side === "LEFT" ? ["left side / deleted code"] : []),
    ...(item.isOutdated ? ["outdated diff; referenced code may have moved"] : []),
  ];
  const annotationSuffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";
  return `${item.path}${lineSuffix}${annotationSuffix}`;
}

/** Adapts worklist items (review comments or CI failures) to triage candidates. */
export function reviewLoopTriageCandidatesFromWorklistItems(
  items: ReviewLoopWorklistItem[],
  kind: ReviewLoopTriageItemKind,
): ReviewLoopTriageCandidateItem[] {
  return items.map((item) => ({
    sourceId: item.sourceId,
    kind,
    authorLogin: item.authorLogin,
    authorType: item.authorType,
    location: reviewLoopTriageLocation(item),
    body: item.body,
    diffHunk: item.diffHunk,
  }));
}

/**
 * Filters LLM-proposed conflicts down to the ones worth surfacing to the agent. A usable conflict:
 *  - spans >= 2 DIFFERENT action items — two ids the model bundled into the SAME action item are not
 *    a "pick one, reply to the other" choice (the agent fully applies that one item, so a "did not
 *    apply theirs" reply would be false). We keep one representative source id per distinct item so
 *    the rendered Conflict line names exactly the conflicting sides, no spurious extras;
 *  - has a non-empty trimmed summary — an empty summary renders a guidance-free "Conflict: a, b - "
 *    line, the exact guessing this feature exists to prevent.
 * Conflicts are advisory cross-references, never part of coverage, so a bad entry is dropped silently
 * and never triggers a triage fallback. Coverage is exactly-once upstream, so each source id maps to
 * at most one action item.
 */
function validateTriageConflicts(
  proposed: ReviewLoopTriageConflict[],
  actionItems: ReviewLoopTriageActionItem[],
): ReviewLoopTriageConflict[] {
  if (proposed.length === 0) return [];
  const actionItemIndexBySourceId = new Map<string, number>();
  actionItems.forEach((item, index) => {
    for (const sourceId of item.sourceIds) actionItemIndexBySourceId.set(sourceId, index);
  });
  return proposed
    .map((conflict) => {
      const sourceIdByItem = new Map<number, string>();
      for (const sourceId of conflict.sourceIds) {
        const index = actionItemIndexBySourceId.get(sourceId);
        if (index !== undefined && !sourceIdByItem.has(index)) sourceIdByItem.set(index, sourceId);
      }
      return { summary: conflict.summary.trim(), sourceIds: [...sourceIdByItem.values()] };
    })
    .filter((conflict) => conflict.sourceIds.length >= 2 && conflict.summary.length > 0);
}

/**
 * LLM triage of a review-loop epoch's worklist (RLA v2 work item D). Synthesizes the candidate
 * items into action items the deterministic renderer turns into the session prompt.
 *
 * FAIL OPEN, never closed: any failure — key missing, provider error, malformed output, an
 * over-budget worklist, or output that does not fully account for the input — returns
 * `{ ok: false }` and the caller dispatches the current deterministic worklist prompt with
 * nothing dropped. This is feature degradation, not a security boundary (spec §4).
 *
 * Output discipline (sourceIds are never LLM-invented):
 *  - an action item referencing ANY source id not present in the input is discarded;
 *  - dropped items with unknown source ids are ignored;
 *  - after discards, every input source id must be covered EXACTLY ONCE across the surviving
 *    action items and dropped items — a gap falls back (a triaged prompt must account for the
 *    full worklist), and so does a double-claim (two action items, or an action item plus a
 *    drop, citing the same source would hand the agent contradictory instructions);
 *  - zero surviving action items also falls back: the deterministic path decides what an
 *    all-non-actionable worklist means, not the LLM.
 */
export async function triageReviewLoopWorklist(
  env: Env,
  args: {
    sessionId: string;
    epochId: string;
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
    candidates: ReviewLoopTriageCandidateItem[];
    logger: Logger;
  },
): Promise<ReviewLoopTriageOutcome> {
  const config = PLATFORM_LLM_CALL_CONFIG.review_loop_triage;
  const logBase = {
    event: "review_loop.triage",
    sessionId: args.sessionId,
    epochId: args.epochId,
    prNumber: args.prNumber,
    headSha: args.headSha,
    candidateCount: args.candidates.length,
  };
  const metricTags = { repo: `${args.repoOwner}/${args.repoName}`, ownerUserId: args.ownerUserId };
  const fallback = async (
    reason: ReviewLoopTriageFallbackReason,
    extra: Record<string, unknown> = {},
  ): Promise<ReviewLoopTriageOutcome> => {
    args.logger.info({ ...logBase, outcome: "fallback", reason, ...extra }, "Review-loop triage fell back");
    await emitReviewLoopTriageMetric(env, {
      ...metricTags,
      outcome: "fallback",
      reason,
      category: typeof extra.category === "string" ? extra.category : null,
      droppedItemCount: 0,
      // No triaged prompt is built on fallback, so no conflicts are proposed, surfaced, or dropped.
      conflictCount: 0,
      conflictDroppedCount: 0,
      // Surface the real discarded-action-item count when discards drove the fallback
      // (no_action_items / duplicate_coverage / coverage_gap pass it in `extra`). Hardcoding 0 hid
      // the hallucinated-sourceId signal from the triage_discarded_action_items series.
      discardedActionItemCount: typeof extra.discardedActionItemCount === "number" ? extra.discardedActionItemCount : 0,
    });
    return { ok: false, reason };
  };

  if (args.candidates.length === 0) return fallback("empty_worklist");
  // No silent truncation: an over-budget worklist falls back whole rather than triaging a sample
  // that would read as full coverage.
  if (config.maxItems !== null && args.candidates.length > config.maxItems) {
    return fallback("too_many_items", { maxItems: config.maxItems });
  }

  const input: ReviewLoopTriageLlmInput = {
    repo: `${args.repoOwner}/${args.repoName}`,
    prNumber: args.prNumber,
    headSha: args.headSha,
    items: args.candidates,
  };
  const result = await executePlatformLlmCall(
    env,
    {
      sessionId: args.sessionId,
      // The triage runs sweep-side before any sandbox exists; these two ids only feed
      // observability fields on the platform-LLM call.
      sandboxId: "review-loop-sweep",
      promptId: args.epochId,
      callType: "review_loop_triage",
      phase: config.phase,
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      serviceTier: config.serviceTier,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      toolName: config.toolName,
      maxOutputBytes: config.maxOutputBytes,
    },
    input,
  );
  if (!result.response.ok) {
    // Provider failures are already captured (Sentry + structured logs) inside
    // executePlatformLlmCall; this log records the sweep-side fallback decision.
    return fallback(reviewLoopTriageFallbackReasonForLlmFailure(result.response.category), {
      category: result.response.category,
      attempts: result.response.attempts,
    });
  }
  const data: unknown = result.response.data;
  if (!isReviewLoopTriageLlmOutput(data)) return fallback("output_invalid");

  const knownSourceIds = new Set(args.candidates.map((candidate) => candidate.sourceId));
  let discardedActionItemCount = 0;
  // Real (known) sourceIds carried by a DISCARDED action item. A discarded item loses its
  // instruction, so its real feedback must NOT be considered covered — otherwise a co-listed drop
  // of that same id would launder it through the coverage check (coverage passes, ok:true, real
  // feedback silently dropped). Forcing these uncovered re-prompts the full candidate set via the
  // deterministic builder, which loses nothing.
  const discardedKnownSourceIds = new Set<string>();
  const actionItems: ReviewLoopTriageActionItem[] = [];
  for (const item of data.actionItems) {
    if (item.sourceIds.length === 0 || item.sourceIds.some((sourceId) => !knownSourceIds.has(sourceId))) {
      discardedActionItemCount += 1;
      for (const sourceId of item.sourceIds) {
        if (knownSourceIds.has(sourceId)) discardedKnownSourceIds.add(sourceId);
      }
      continue;
    }
    actionItems.push(item);
  }
  const droppedItems = data.droppedItems.filter((dropped) => knownSourceIds.has(dropped.sourceId));
  if (actionItems.length === 0) return fallback("no_action_items", { discardedActionItemCount });
  const coverageCounts = new Map<string, number>();
  for (const sourceId of [
    ...actionItems.flatMap((item) => item.sourceIds),
    ...droppedItems.map((dropped) => dropped.sourceId),
  ]) {
    coverageCounts.set(sourceId, (coverageCounts.get(sourceId) ?? 0) + 1);
  }
  const duplicateCount = [...coverageCounts.values()].filter((count) => count > 1).length;
  if (duplicateCount > 0) {
    return fallback("duplicate_coverage", { duplicateCount, discardedActionItemCount });
  }
  // A candidate is uncovered if nothing covers it OR a discarded action item carried it (a co-listed
  // drop must not launder a discarded item's real feedback into "covered").
  const uncoveredCount = args.candidates.filter(
    (candidate) => !coverageCounts.has(candidate.sourceId) || discardedKnownSourceIds.has(candidate.sourceId),
  ).length;
  if (uncoveredCount > 0) {
    return fallback("coverage_gap", { uncoveredCount, discardedActionItemCount });
  }

  // Conflicts are advisory cross-references, NOT coverage: they are deliberately excluded from
  // coverageCounts (above) so a conflict between two already-covered ids cannot trip
  // duplicate_coverage. A usable conflict spans >= 2 DIFFERENT action items with a non-empty summary;
  // it survives validateConflicts as one representative source id per distinct item. The filter is
  // lossy by design (over-specified/under-specified/empty entries are dropped silently, never a
  // fallback), so we record proposedConflictCount vs survivors to keep that pruning observable.
  const proposedConflictCount = data.conflicts.length;
  const conflicts = validateTriageConflicts(data.conflicts, actionItems);
  const conflictDroppedCount = proposedConflictCount - conflicts.length;

  args.logger.info(
    {
      ...logBase,
      outcome: "used",
      actionItemCount: actionItems.length,
      droppedItemCount: droppedItems.length,
      // Surface both what the model proposed and what survived validation so a flat conflict signal
      // can be diagnosed as "model under-fired" vs "filter over-pruned" (the feature-tuning question).
      proposedConflictCount,
      conflictCount: conflicts.length,
      conflictDroppedCount,
      discardedActionItemCount,
      // Surface WHICH items were dropped so a wrong drop of real feedback is visible. The sourceId is
      // an internal synthesized id (safe to log); the reason is NOT logged — it is LLM free text
      // derived from untrusted reviewer comment bodies, and truncation is not redaction (PII /
      // log-injection risk per docs/security.md), so only its length is recorded as a coarse signal.
      droppedItems: droppedItems.map((dropped) => ({
        sourceId: dropped.sourceId,
        reasonLength: dropped.reason.length,
      })),
    },
    "Review-loop triage used",
  );
  await emitReviewLoopTriageMetric(env, {
    ...metricTags,
    outcome: "used",
    reason: null,
    category: null,
    droppedItemCount: droppedItems.length,
    conflictCount: conflicts.length,
    conflictDroppedCount,
    discardedActionItemCount,
  });
  return { ok: true, actionItems, droppedItems, conflicts, discardedActionItemCount };
}
