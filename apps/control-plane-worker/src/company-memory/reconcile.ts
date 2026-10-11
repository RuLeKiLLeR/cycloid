import { StructuredOutputError } from "../../../../shared/llm/structured-output";
import { MEMORY_RECONCILIATION_RECURRENCE_INTERVAL_MS } from "../constants/company-memory";
import { GitHubRequestError } from "../github/errors";
import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { getDefaultBranch } from "../github/pr";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { adjudicateMemoryPair, type MemoryAdjudication } from "./adjudicate";
import {
  type ActiveMemoryFactForReconciliationRow,
  expirePastValidFacts,
  listActiveFactsForReconciliation,
  listActiveFactsForRepoReconciliation,
  listRecentRepoMemoryTargets,
  supersedeOlderFact,
} from "./reconcile-db";
import { loadActiveRepoMemories, type RepoMemoryRecord } from "./repo-memory-source";
import {
  advanceSchedulerRoundRobinCursor,
  getSchedulerRoundRobinCursor,
  listBusinessesDueForMemoryReconciliation,
  upsertMemoryReconciliationCursor,
  upsertMemoryReviewCandidate,
} from "./review-db";

const log = createLogger({ bindings: { component: "company-memory-reconcile" } });
const RECONCILE_BATCH_LIMIT = 50;
// Per-business scan depth, kept independent of the scheduler's business-batch
// `limit`. The d1 interval cursor marks the whole business scanned for the
// recurrence window, so the fact/repo-target scans must cover the intended
// depth regardless of how many businesses the tick processes; otherwise facts
// beyond the batch size would be interval-suppressed until the next window.
const RECONCILE_REPO_TARGET_LIMIT = 10;
const ADJUDICATION_CONFIDENCE_THRESHOLD = 0.75;

type ActiveFactRow = ActiveMemoryFactForReconciliationRow;

export interface MemoryReconciliationResult {
  businesses: number;
  expired: number;
  superseded: number;
  candidates: number;
  skipped: number;
  adjudicationProviderFailures: number;
}

export interface MemoryReconciliationOptions {
  businessId?: string;
  limit?: number;
  nowMs?: number;
  repoTargets?: MemoryReconciliationRepoTarget[];
  repoMemoryLoader?: (target: ResolvedRepoMemoryTarget) => Promise<RepoMemoryRecord[]>;
  adjudicate?: (input: {
    businessId: string;
    older: ActiveFactRow;
    newer: ActiveFactRow;
  }) => Promise<MemoryAdjudication | null>;
  adjudicatePair?: typeof adjudicateMemoryPair;
}

export interface MemoryReconciliationRepoTarget {
  owner: string;
  name: string;
  ref?: string;
  token?: string;
}

export interface ResolvedRepoMemoryTarget {
  owner: string;
  name: string;
  ref: string;
  token: string;
}

export interface MemoryReconciliationSchedulerOptions {
  logger?: Pick<typeof log, "info" | "warn" | "error">;
  limit?: number;
}

export async function runMemoryReconciliation(
  env: Env,
  options: MemoryReconciliationOptions,
): Promise<MemoryReconciliationResult> {
  const nowMs = safeNowMs(options.nowMs);
  const limit = options.limit ?? 10;
  // Single-business mode (manual trigger): bypass the round-robin scheduler and
  // surface errors to the caller. Scheduled mode: pick the next due batch via
  // the interval gate + round-robin cursor, and isolate per-business failures.
  const isScheduled = !options.businessId;
  const selection = isScheduled ? await selectDueBusinesses(env.DB, nowMs, limit) : null;
  const businessIds = options.businessId ? [options.businessId] : (selection?.businessIds ?? []);
  const result: MemoryReconciliationResult = {
    businesses: businessIds.length,
    expired: 0,
    superseded: 0,
    candidates: 0,
    skipped: 0,
    adjudicationProviderFailures: 0,
  };
  for (const businessId of businessIds) {
    if (isScheduled) {
      try {
        accumulateBusinessResult(result, await reconcileBusinessMemory(env, businessId, { ...options, nowMs }));
      } catch (error) {
        // One business must not abort the whole tick. It wrote no 'd1' cursor on
        // throw, so it stays interval-due and is retried when the round-robin wraps.
        log.warn(
          { event: "memory_reconciliation_business_failed", businessId, error: String(error) },
          "Memory reconciliation failed for a single business; continuing",
        );
      }
    } else {
      accumulateBusinessResult(result, await reconcileBusinessMemory(env, businessId, { ...options, nowMs }));
    }
  }
  // Advance the round-robin cursor only when this tick had work; hold position on
  // a zero-due tick. The CAS guards against an overlapping cron tick.
  if (selection && businessIds.length > 0 && selection.advanceTo) {
    await advanceSchedulerRoundRobinCursor(env.DB, {
      expectedCursorJson: selection.expectedCursorJson,
      lastBusinessId: selection.advanceTo,
      nowMs,
    });
  }
  log.info({ ...result }, "memory_reconciliation_tick");
  return result;
}

function accumulateBusinessResult(
  result: MemoryReconciliationResult,
  businessResult: Omit<MemoryReconciliationResult, "businesses">,
): void {
  result.expired += businessResult.expired;
  result.superseded += businessResult.superseded;
  result.candidates += businessResult.candidates;
  result.skipped += businessResult.skipped;
  result.adjudicationProviderFailures += businessResult.adjudicationProviderFailures;
}

/**
 * Pick the next batch of due businesses via the interval gate + round-robin
 * cursor. When the cursor reaches the end of the id space (fewer than `limit`
 * rows past it), wrap and re-query from the beginning to fill the batch,
 * deduping. The advance target is the wrapped segment's max when a wrap supplied
 * the tail, else the pre-wrap segment's max; null when nothing was due.
 */
async function selectDueBusinesses(
  db: Env["DB"],
  nowMs: number,
  limit: number,
): Promise<{ businessIds: string[]; advanceTo: string | null; expectedCursorJson: string | null }> {
  const cursor = await getSchedulerRoundRobinCursor(db);
  const recurrenceIntervalMs = MEMORY_RECONCILIATION_RECURRENCE_INTERVAL_MS;
  const preWrap = await listBusinessesDueForMemoryReconciliation(db, {
    nowMs,
    recurrenceIntervalMs,
    afterBusinessId: cursor.lastBusinessId,
    limit,
  });
  const businessIds = [...preWrap];
  // Query returns business_id ASC, so the last element is the segment max.
  let advanceTo: string | null = preWrap.length > 0 ? preWrap[preWrap.length - 1] : null;
  if (preWrap.length < limit && cursor.lastBusinessId !== "") {
    const wrap = await listBusinessesDueForMemoryReconciliation(db, {
      nowMs,
      recurrenceIntervalMs,
      afterBusinessId: "",
      limit: limit - preWrap.length,
    });
    const seen = new Set(preWrap);
    for (const id of wrap) {
      if (businessIds.length >= limit) break;
      if (seen.has(id)) continue;
      seen.add(id);
      businessIds.push(id);
      advanceTo = id; // wrapped segment max (ascending; last appended within the cap)
    }
  }
  return {
    businessIds,
    advanceTo: businessIds.length > 0 ? advanceTo : null,
    expectedCursorJson: cursor.rawCursorJson,
  };
}

export async function runScheduledMemoryReconciliation(
  env: Env,
  options: MemoryReconciliationSchedulerOptions,
): Promise<MemoryReconciliationResult> {
  const result = await runMemoryReconciliation(env, { limit: options.limit ?? 10 });
  if (result.expired > 0 || result.superseded > 0 || result.candidates > 0 || result.adjudicationProviderFailures > 0) {
    options.logger?.info?.({ ...result }, "Company memory reconciliation sweep");
  }
  return result;
}

async function reconcileBusinessMemory(
  env: Env,
  businessId: string,
  options: MemoryReconciliationOptions,
): Promise<Omit<MemoryReconciliationResult, "businesses">> {
  const nowMs = safeNowMs(options.nowMs);
  const result = { expired: 0, superseded: 0, candidates: 0, skipped: 0, adjudicationProviderFailures: 0 };
  const expired = await expirePastValidFacts(env.DB, businessId, nowMs);
  result.expired += expired;
  result.candidates += expired;
  const facts = await listActiveFactsForReconciliation(env.DB, businessId, RECONCILE_BATCH_LIMIT);
  for (const [older, newer] of candidatePairs(facts)) {
    const adjudicationResult = await adjudicateMemoryPairOrSkip(
      async () =>
        (await options.adjudicate?.({ businessId, older, newer })) ??
        (await adjudicateMemoryPair(env, {
          businessId,
          memories: [
            {
              id: older.id,
              store: "d1",
              claim: older.claim,
              sourceTimeMs: older.source_time_ms,
              sourceUri: older.source_uri,
            },
            {
              id: newer.id,
              store: "d1",
              claim: newer.claim,
              sourceTimeMs: newer.source_time_ms,
              sourceUri: newer.source_uri,
            },
          ],
        })),
      {
        businessId,
        scope: "d1",
        primaryMemoryId: older.id,
        primaryStore: "d1",
        secondaryMemoryId: newer.id,
        secondaryStore: "d1",
      },
    );
    result.adjudicationProviderFailures += adjudicationResult.providerFailure ? 1 : 0;
    const adjudication = adjudicationResult.adjudication;
    if (!shouldApplyNewerWins(adjudication, older.id, newer.id)) {
      result.skipped += 1;
      continue;
    }
    const applied = await supersedeOlderFact(env.DB, {
      businessId,
      older,
      newer,
      adjudication: adjudication!,
      evidenceJson: JSON.stringify({
        older_memory_id: older.id,
        newer_memory_id: newer.id,
        older_source_uri: older.source_uri,
        newer_source_uri: newer.source_uri,
        older_source_time_ms: older.source_time_ms,
        newer_source_time_ms: newer.source_time_ms,
        adjudication,
      }),
      nowMs,
    });
    if (applied) {
      result.superseded += 1;
      result.candidates += 1;
    }
  }
  // Cross-store runs before the interval-gating 'd1' cursor write so a cross-store
  // throw leaves the business eligible on the next tick (cross-store keeps its own
  // 'cross_store' cursors for repo-level progress, unaffected here).
  const crossStoreResult = await reconcileRepoMemoryForBusiness(env, businessId, options, nowMs);
  result.candidates += crossStoreResult.candidates;
  result.skipped += crossStoreResult.skipped;
  result.adjudicationProviderFailures += crossStoreResult.adjudicationProviderFailures;
  // Only advance the interval gate after the full business (D1 + cross-store)
  // reconciled cleanly. A provider failure must not interval-suppress the
  // business for the whole recurrence window, so skip the 'd1' cursor write when
  // any adjudication hit a retryable provider failure; it then stays due and is
  // re-adjudicated on the next scheduled tick.
  if (result.adjudicationProviderFailures === 0) {
    await upsertMemoryReconciliationCursor(env.DB, {
      businessId,
      cursorType: "d1",
      cursorJson: JSON.stringify({
        active_fact_count: facts.length,
        adjudication_provider_failures: result.adjudicationProviderFailures,
      }),
      lastScannedAtMs: nowMs,
    });
  }
  return result;
}

async function reconcileRepoMemoryForBusiness(
  env: Env,
  businessId: string,
  options: MemoryReconciliationOptions,
  nowMs: number,
): Promise<{ candidates: number; skipped: number; adjudicationProviderFailures: number }> {
  const result = { candidates: 0, skipped: 0, adjudicationProviderFailures: 0 };
  let repoTargets = options.repoTargets;
  if (!repoTargets) {
    try {
      repoTargets = await listRecentRepoMemoryTargets(env.DB, businessId, RECONCILE_REPO_TARGET_LIMIT);
    } catch (err) {
      log.warn({ businessId, error: String(err) }, "Skipping repo-memory target discovery");
      repoTargets = [];
    }
  }
  for (const target of repoTargets) {
    const resolved = await resolveRepoMemoryTarget(env, target);
    if (!resolved) {
      result.skipped += 1;
      continue;
    }
    let targetAdjudicationProviderFailures = 0;
    let repoMemories: RepoMemoryRecord[];
    try {
      repoMemories =
        (await options.repoMemoryLoader?.(resolved)) ??
        (await loadActiveRepoMemories({
          token: resolved.token,
          owner: resolved.owner,
          repo: resolved.name,
          ref: resolved.ref,
        }));
    } catch (error) {
      if (isGithubRepoMemoryDirectoryNotFound(error)) {
        log.warn(
          {
            businessId,
            repoOwner: resolved.owner,
            repoName: resolved.name,
            githubOperation: error.operation,
            githubStatus: error.status,
            error: String(error),
          },
          "Skipping repo-memory target because GitHub returned 404 while listing the repo-memory directory",
        );
        result.skipped += 1;
        continue;
      }
      throw error;
    }
    const d1Facts = await listActiveFactsForRepoReconciliation(
      env.DB,
      businessId,
      resolved.owner,
      resolved.name,
      RECONCILE_BATCH_LIMIT,
    );
    for (const [fact, repoMemory] of crossStorePairs(d1Facts, repoMemories)) {
      const adjudicationResult = await adjudicateMemoryPairOrSkip(
        () =>
          (options.adjudicatePair ?? adjudicateMemoryPair)(env, {
            businessId,
            memories: [
              {
                id: fact.id,
                store: "d1",
                claim: fact.claim,
                sourceTimeMs: fact.source_time_ms,
                sourceUri: fact.source_uri,
              },
              {
                id: repoMemory.id,
                store: "repo",
                claim: repoMemory.claim,
                sourceTimeMs: repoMemory.sourceTimeMs,
                sourceUri: repoMemory.sourceUri,
              },
            ],
          }),
        {
          businessId,
          scope: "cross_store",
          primaryMemoryId: fact.id,
          primaryStore: "d1",
          secondaryMemoryId: repoMemory.id,
          secondaryStore: "repo",
          repoOwner: resolved.owner,
          repoName: resolved.name,
          repoMemoryPath: repoMemory.path,
        },
      );
      result.adjudicationProviderFailures += adjudicationResult.providerFailure ? 1 : 0;
      targetAdjudicationProviderFailures += adjudicationResult.providerFailure ? 1 : 0;
      const adjudication = adjudicationResult.adjudication;
      if (!shouldCreateCrossStoreCandidate(adjudication, fact.id, repoMemory.id)) {
        result.skipped += 1;
        continue;
      }
      await upsertMemoryReviewCandidate(env.DB, {
        businessId,
        candidateType: adjudication.classification === "repo_memory_stale" ? "repo_pr_needed" : "cross_store_conflict",
        primaryStore: repoMemory.sourceTimeMs < fact.source_time_ms ? "repo" : "d1",
        primaryMemoryId: repoMemory.sourceTimeMs < fact.source_time_ms ? repoMemory.id : fact.id,
        secondaryStore: repoMemory.sourceTimeMs < fact.source_time_ms ? "d1" : "repo",
        secondaryMemoryId: repoMemory.sourceTimeMs < fact.source_time_ms ? fact.id : repoMemory.id,
        repoOwner: resolved.owner,
        repoName: resolved.name,
        repoMemoryPath: repoMemory.path,
        proposedAction:
          adjudication.proposed_action === "create_repo_memory_pr" ? "create_repo_memory_pr" : "manual_review",
        rationale: adjudication.rationale,
        evidenceJson: JSON.stringify({
          d1_memory_id: fact.id,
          repo_memory_id: repoMemory.id,
          repo_memory_path: repoMemory.path,
          d1_source_uri: fact.source_uri,
          repo_source_uri: repoMemory.sourceUri,
          d1_source_time_ms: fact.source_time_ms,
          repo_source_time_ms: repoMemory.sourceTimeMs,
          adjudication,
        }),
      });
      result.candidates += 1;
    }
    await upsertMemoryReconciliationCursor(env.DB, {
      businessId,
      cursorType: "cross_store",
      repoOwner: resolved.owner,
      repoName: resolved.name,
      cursorJson: JSON.stringify({
        repo_memory_count: repoMemories.length,
        d1_fact_count: d1Facts.length,
        adjudication_provider_failures: targetAdjudicationProviderFailures,
      }),
      lastScannedAtMs: nowMs,
    });
  }
  return result;
}

async function adjudicateMemoryPairOrSkip(
  adjudicate: () => Promise<MemoryAdjudication | null>,
  context: {
    businessId: string;
    scope: "d1" | "cross_store";
    primaryMemoryId: string;
    primaryStore: "d1" | "repo";
    secondaryMemoryId: string;
    secondaryStore: "d1" | "repo";
    repoOwner?: string;
    repoName?: string;
    repoMemoryPath?: string;
  },
): Promise<{ adjudication: MemoryAdjudication | null; providerFailure: boolean }> {
  try {
    return { adjudication: await adjudicate(), providerFailure: false };
  } catch (error) {
    if (!isRetryableStructuredOutputError(error)) throw error;
    log.warn(
      {
        ...context,
        status: error.status,
        failureKind: error.failureKind,
        attempts: error.attempts,
        maxAttempts: error.maxAttempts,
        errorMessage: error.message,
      },
      "Skipping memory adjudication pair after retryable provider failure",
    );
    return { adjudication: null, providerFailure: true };
  }
}

function isRetryableStructuredOutputError(error: unknown): error is StructuredOutputError {
  if (!(error instanceof StructuredOutputError)) return false;
  if (error.failureKind === "transport") return true;
  const status = error.status;
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

function candidatePairs(facts: ActiveFactRow[]): Array<[ActiveFactRow, ActiveFactRow]> {
  const pairs: Array<[ActiveFactRow, ActiveFactRow]> = [];
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const left = facts[i];
      const right = facts[j];
      if (left.kind !== right.kind || left.holder !== right.holder) continue;
      const [older, newer] =
        left.source_time_ms < right.source_time_ms ||
        (left.source_time_ms === right.source_time_ms && left.created_at_ms <= right.created_at_ms)
          ? [left, right]
          : [right, left];
      if (older.id === newer.id || older.claim === newer.claim) continue;
      pairs.push([older, newer]);
      if (pairs.length >= RECONCILE_BATCH_LIMIT) return pairs;
    }
  }
  return pairs;
}

function shouldApplyNewerWins(
  adjudication: MemoryAdjudication | null,
  olderId: string,
  newerId: string,
): adjudication is MemoryAdjudication {
  if (!adjudication || adjudication.confidence < ADJUDICATION_CONFIDENCE_THRESHOLD) return false;
  if (adjudication.proposed_action !== "supersede_older_d1") return false;
  if (
    adjudication.classification !== "newer_supersedes_old" &&
    adjudication.classification !== "contradiction_needs_review"
  ) {
    return false;
  }
  return adjudication.cited_memory_ids.includes(olderId) && adjudication.cited_memory_ids.includes(newerId);
}

function shouldCreateCrossStoreCandidate(
  adjudication: MemoryAdjudication | null,
  d1Id: string,
  repoId: string,
): adjudication is MemoryAdjudication {
  if (!adjudication || adjudication.confidence < ADJUDICATION_CONFIDENCE_THRESHOLD) return false;
  if (!adjudication.cited_memory_ids.includes(d1Id) || !adjudication.cited_memory_ids.includes(repoId)) return false;
  return (
    adjudication.classification === "repo_memory_stale" ||
    adjudication.classification === "newer_supersedes_old" ||
    adjudication.classification === "contradiction_needs_review"
  );
}

function crossStorePairs(
  facts: ActiveFactRow[],
  repoMemories: RepoMemoryRecord[],
): Array<[ActiveFactRow, RepoMemoryRecord]> {
  const pairs: Array<[ActiveFactRow, RepoMemoryRecord]> = [];
  for (const fact of facts) {
    for (const repoMemory of repoMemories) {
      if (fact.claim === repoMemory.claim) continue;
      pairs.push([fact, repoMemory]);
      if (pairs.length >= RECONCILE_BATCH_LIMIT) return pairs;
    }
  }
  return pairs;
}

async function resolveRepoMemoryTarget(
  env: Env,
  target: MemoryReconciliationRepoTarget,
): Promise<ResolvedRepoMemoryTarget | null> {
  const owner = target.owner.trim();
  const name = target.name.trim();
  if (!owner || !name) return null;
  if (target.token && target.ref) return { owner, name, token: target.token, ref: target.ref };
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return null;
  const installation = await getInstallationByOwner(env.DB, owner);
  if (!installation || installation.suspended_at !== null) return null;
  const token = target.token ?? (await createInstallationToken(env, installation.installation_id));
  let ref = target.ref;
  if (!ref) {
    try {
      ref = await getDefaultBranch(token, owner, name);
    } catch (error) {
      if (isGithubRepoLookupNotFound(error)) {
        log.warn(
          {
            repoOwner: owner,
            repoName: name,
            githubOperation: error.operation,
            githubStatus: error.status,
            error: String(error),
          },
          "Skipping repo-memory target because GitHub repo lookup returned 404 while resolving the default branch",
        );
        return null;
      }
      throw error;
    }
  }
  return { owner, name, token, ref };
}

function safeNowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
}

function isGithubRepoLookupNotFound(error: unknown): error is GitHubRequestError {
  return error instanceof GitHubRequestError && error.status === 404 && error.operation === "GitHub repo lookup";
}

function isGithubRepoMemoryDirectoryNotFound(error: unknown): error is GitHubRequestError {
  return error instanceof GitHubRequestError && error.status === 404 && error.operation === "GitHub list directory";
}
