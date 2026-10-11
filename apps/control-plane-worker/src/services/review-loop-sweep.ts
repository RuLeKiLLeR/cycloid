import { isQaTesterAgentRole, isReadOnlyAgentRole } from "../../../../shared/agent/constants.js";
import type { PrReviewExpectedBot } from "../../../../shared/constants/pr-review-bots.js";
import { isAwaitingVerificationVerdict } from "../../../../shared/session/phase.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { recordReviewLoopOutcomeMemoryIngestion } from "../company-memory/service";
import {
  REVIEW_LOOP_DISPATCH_CONCURRENCY,
  REVIEW_STUCK_DEADLINE_MS,
  VERIFYING_BACKSTOP_DEADLINE_MS,
} from "../constants/review-loop";
import { isTransientD1StorageError, isTransientDurableObjectInternalError } from "../db/errors";
import { BlockerKind } from "../enums/blocker";
import { getInstallationByOwner, type InstallationRow } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import type { CommitCheckRun, CommitStatusContext, ReviewLoopWorklist, ReviewLoopWorklistItem } from "../github/pr";
import {
  createPrIssueComment,
  createPrReviewCommentReply,
  failingCheckFingerprint,
  failingCheckRunWorklistItemsWithLogEvidence,
  getCommitCheckRuns,
  getCommitStatusContexts,
  getPrHeadSha,
  getPrMergeStatus,
  getPrReviewLoopWorklist,
  hasPendingCheckRuns,
  isFailingCheckRun,
  isNoOpHeadTreeChange,
  updatePullRequestBranch,
} from "../github/pr";
import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  normalizeGitHubActorLogin,
  PR_REVIEW_BOT_CAPABILITIES,
} from "../github/pr-review-bots";
import { createLogger, type Logger } from "../logger";
import {
  emitReviewLoopDispatchDeferredMetric,
  emitReviewLoopTruncatedTailRekeyedMetric,
  emitReviewLoopWorklistTruncatedMetric,
} from "../observability/pr-metrics";
import {
  emitReviewListeningDormantCountEvent,
  emitReviewLoopNoiseGatedEvent,
  emitReviewLoopNoiseNearMissEvent,
  emitReviewLoopReadyToClaimEvent,
  type ReviewLoopDispatchTrigger,
} from "../observability/review-loop-events";
import { closeQaLoopBinding } from "../qa/db";
import { isSamePromptedReviewBodyHash } from "../review-loop-body-hash";
import { shadowEmitCiSignal } from "../session/fsm/ci-producer";
import { shadowEmitCronPrTerminal } from "../session/fsm/cron-producer";
import { deadlineWouldFire, shadowFireDueDeadline } from "../session/fsm/deadline-producer";
import { emitEpochDeferralToSpine } from "../session/fsm/epoch-producer";
import { classifyHeadChange, shadowEmitHeadChange } from "../session/fsm/head-producer";
import { repairStateDerivedSideEffects } from "../session/fsm/live-side-effects";
import { buildGithubGroundTruthReader, parseGithubPrUrl } from "../session/fsm/parity-check";
import { shadowEmitReviewItemReady } from "../session/fsm/review-producer";
import { reconcileSpineOpenPrTerminals } from "../session/fsm/spine-terminal-reconcile";
import type { FsmState } from "../session/fsm/types";
import { emitVerificationIntakeStanddownParity } from "../session/fsm/verification-intake-projection";
import { shadowEmitVerificationOutcome } from "../session/fsm/verification-producer";
import { REVIEW_LOOP_EPOCH_ACTIVE_PROMPT_ERROR } from "../session/internal-routes";
import { notifyUserBlocked } from "../session/notify-user-blocked";
import {
  getPrCoordination,
  listPrCoordinationTransientRepairCandidates,
  listReviewRowsWithUndispositionedNoInflight,
  listReviewStuckPrCoordinationCandidates,
  listVerificationBackstopCandidates,
  markPrCoordinationUpdateBranchQueued,
} from "../session/pr-coordination-db";
import {
  listForPr,
  listUndispositionedActionable,
  stampInformationalDispositions,
  upsertDispositionsBatch,
} from "../session/pr-review-item-disposition-db";
import {
  closeSessionForWebhook,
  enqueueSessionPrompt,
  getSessionState,
  listSessionPrompts,
  notifySessionPrMerged,
  updateSessionReviewListeningHead,
  warmSession,
} from "../session/state";
import {
  mapPrReviewBotSettingsRow,
  type UserPrReviewBotSettingsPayload,
  type UserPrReviewBotSettingsRow,
} from "../settings/db";
import type { Env, SessionState } from "../types";
import {
  deleteSessionWebhookRef,
  listReviewListeningGithubPrRefs,
  markReviewListeningGithubPrRefsSwept,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "../webhooks/db";
import {
  buildGithubPrCiFixPrompt,
  buildGithubPrMentionDirectivePrompt,
  buildGithubPrMentionTargetedPrompt,
  buildGithubPrMergeConflictPrompt,
  buildGithubPrReviewLoopHumanPrompt,
  buildGithubPrReviewLoopPrompt,
  buildGithubPrReviewLoopTriagedPrompt,
  buildGithubPrReviewLoopVerificationPrompt,
  buildReviewLoopHumanSummary,
} from "../webhooks/prompts";
import { syncFsmLabelsForPr } from "./fsm-label-sync";
import {
  accumulatePromptedSourceRecords,
  blockPendingReviewLoopEpochsForHead,
  blockStuckReviewLoopEpoch,
  bootstrapReviewLoopEpochForMergeConflict,
  bootstrapReviewLoopEpochFromHeadSignals,
  claimReviewLoopEpochForPrompt,
  countConsecutiveCiFixEpochsForPr,
  extendReviewLoopEpochLease,
  getLatestPriorMatchingCiFixAttempt,
  getReviewLoopEpochById,
  getReviewLoopEpochSummariesForHead,
  hasActiveMergeConflictReviewLoopEpochForHead,
  hasCiAttemptCapEscalationForHead,
  hasCiPendingCapEscalationForHead,
  hasCiReviewLoopEpochForHead,
  hasExpectedBotReviewLoopEpochForHead,
  hasMergeConflictReviewLoopEpochForHead,
  hasPendingReviewLoopWork,
  ingestReviewLoopCiFailureWebhook,
  isCiEpoch,
  isMentionEpoch,
  isMergeConflictEpoch,
  isObservedTerminalCheckConclusion,
  isObservedTerminalCommitStatusState,
  isVerificationEpoch,
  type KnownReviewLoopSources,
  listDueReviewLoopEpochs,
  listKnownReviewLoopSources,
  listPromptedReviewLoopSources,
  listRecentReviewLoopEpochDrainSummaries,
  listReviewLoopEpochsByIds,
  listStuckReviewLoopEpochs,
  markReviewLoopEpochBlocked,
  markReviewLoopEpochCompleted,
  markReviewLoopEpochContentionDeferred,
  markReviewLoopEpochEnqueued,
  markReviewLoopEpochProcessing,
  markReviewLoopEpochTransientFailure,
  type MentionEpochEvidence,
  type PromptedReviewLoopSourceRecord,
  reclaimStuckReviewLoopEpoch,
  REVIEW_LOOP_ATTEMPT_CAP,
  REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP,
  REVIEW_LOOP_DRAIN_NO_PROGRESS_BASIS,
  REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP,
  REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_ATTEMPTS,
  REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_REASON,
  REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON,
  type ReviewLoopEpoch,
  type ReviewLoopEpochTelemetry,
  reviewSourceKind,
  shadowEmitReviewLoopEpochTerminal,
  upsertReviewLoopEpochActivity,
} from "./review-loop-epochs";
import { reconcileReviewLoopEpochsForHeadChange } from "./review-loop-head-change";
import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopReplyOperationId,
  hasSucceededReviewLoopReplyToTarget,
  listReviewLoopReplyGithubIdsForSession,
  markReviewLoopOperationFailed,
  markReviewLoopOperationSucceeded,
} from "./review-loop-operations";
import { isSessionRuntimeLive } from "./review-loop-reengage";
import { reduceCiState } from "./review-loop-rollup";
import {
  isCodeReviewArmOnlyChecklistFailure,
  resolveReviewLoopChecklist,
  resolveReviewLoopCiEligibility,
  resolveReviewLoopHumanEligibility,
  resolveReviewLoopMergeConflictEligibility,
} from "./review-loop-settings";
import { parseReviewLoopSourceNumericId } from "./review-loop-source-id";
import {
  reviewLoopTriageCandidatesFromWorklistItems,
  type ReviewLoopTriageOutcome,
  triageReviewLoopWorklist,
} from "./review-loop-triage";

const DEFAULT_SWEEP_LIMIT = 50;
const DEFAULT_REVIEW_LISTENING_RECONCILE_LIMIT = 25;
const DEFAULT_STUCK_RECLAIM_LIMIT = 25;
const REVIEW_LOOP_TRANSIENT_FAILURE_LIMIT = 5;
// How long a ci epoch may keep deferring on perpetually-pending checks before we give up and
// escalate, so a check that never settles cannot defer the epoch forever. TIME-based (measured
// from the epoch's first_activity_at) rather than count-based: contention_deferral_count is shared
// with active_prompt / prompt_contention deferrals, so a busy session would otherwise falsely
// escalate ci_checks_pending_cap_reached even when checks settled quickly.
const REVIEW_LOOP_CI_PENDING_TIMEOUT_MS = 30 * 60 * 1000;
// Human review epochs can be created before review-listening has fully entered. If that enter
// event never lands, do not defer forever: escalate after the same elapsed-time window as CI
// pending checks.
const REVIEW_LOOP_REVIEW_LISTENING_ENTER_TIMEOUT_MS = 30 * 60 * 1000;
// Cap on consecutive auto-fix attempts against the SAME failing-check set (same fingerprint). Once
// the same checks have failed this many times we escalate and stop; CI fixing resumes if the set
// of failing checks changes (a new fingerprint resets this streak).
const REVIEW_LOOP_CI_SAME_FAILURE_CAP = 3;
// Backstop on TOTAL consecutive ci-fix attempts on a PR regardless of fingerprint, so an
// oscillating failure that never converges (each attempt fails different checks) cannot loop
// forever.
const REVIEW_LOOP_CI_TOTAL_ATTEMPT_BACKSTOP = 6;

type ProcessEpochResult =
  "enqueued" | "completed_noop" | "blocked" | "contention_deferred" | "transient_deferred" | "skipped";
type ReviewLoopPromptEnqueueResult = Awaited<ReturnType<typeof enqueueSessionPrompt>>;

type ReviewLoopChecklistPrefetchInputs = {
  installationByOwnerLogin: ReadonlyMap<string, InstallationRow>;
  botSettingsByOwnerRepo: ReadonlyMap<string, UserPrReviewBotSettingsPayload>;
};

type ReviewLoopChecklistPrefetchResult = ReviewLoopChecklistPrefetchInputs | null;

function readyAtMsForDueEpoch(epoch: ReviewLoopEpoch): number {
  if (epoch.status === "reserving" && epoch.leaseExpiresAt !== null) return epoch.leaseExpiresAt;
  return epoch.updatedAt;
}

type ReviewLoopPrefetchContext = {
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
};

function reviewLoopSettingsRepoKey(input: ReviewLoopPrefetchContext): string {
  return `${input.ownerUserId}:${input.repoOwner.trim().toLowerCase()}/${input.repoName.trim().toLowerCase()}`;
}

function reviewLoopRepoGroupKey(input: Pick<ReviewLoopPrefetchContext, "repoOwner" | "repoName">): string {
  return `${input.repoOwner.trim().toLowerCase()}/${input.repoName.trim().toLowerCase()}`;
}

async function prewarmReviewLoopDispatchSession(args: {
  env: Env;
  sessionId: string;
  epochId: string;
  sourceKind: string;
  nowMs: number;
  logger: Logger;
}): Promise<void> {
  const { env, sessionId, epochId, sourceKind, nowMs, logger } = args;
  if (await isSessionRuntimeLive(env.DB, sessionId, nowMs)) return;

  try {
    const warm = await warmSession(env, sessionId, `review-loop-dispatch-${epochId}`);
    if (warm.ok) return;
    logger.warn(
      {
        event: "review_loop_dispatch_prewarm_failed",
        sessionId,
        epochId,
        sourceKind,
        error: warm.error ?? "warm failed (unknown error)",
      },
      "Review-loop dispatch prewarm failed",
    );
  } catch (error) {
    logger.warn(
      {
        event: "review_loop_dispatch_prewarm_failed",
        sessionId,
        epochId,
        sourceKind,
        error: stringifyError(error),
      },
      "Review-loop dispatch prewarm failed",
    );
  }
}

function groupReviewLoopPrefetchContextsByRepo(
  contexts: ReviewLoopPrefetchContext[],
): Map<string, ReviewLoopPrefetchContext[]> {
  const contextsByRepo = new Map<string, ReviewLoopPrefetchContext[]>();
  for (const context of contexts) {
    const key = reviewLoopRepoGroupKey(context);
    const existing = contextsByRepo.get(key);
    if (existing) existing.push(context);
    else contextsByRepo.set(key, [context]);
  }
  return contextsByRepo;
}

async function prefetchReviewLoopChecklistInputsForRepo(
  env: Env,
  contexts: ReviewLoopPrefetchContext[],
): Promise<ReviewLoopChecklistPrefetchResult> {
  if (contexts.length === 0) return null;
  if (typeof env.DB.batch !== "function") return null;

  const first = contexts[0];
  const repoOwner = first.repoOwner.trim().toLowerCase();
  const repoName = first.repoName.trim().toLowerCase();
  const ownerUserIds = [...new Set(contexts.map((context) => context.ownerUserId).filter(Number.isFinite))];
  if (ownerUserIds.length === 0) return null;
  const ownerPlaceholders = "?";
  const userIdPlaceholders = ownerUserIds.map(() => "?").join(", ");
  const [installationsResult, settingsResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM github_installations WHERE owner_login COLLATE NOCASE IN (${ownerPlaceholders})`,
    ).bind(repoOwner),
    env.DB.prepare(
      `SELECT user_id, repo_owner, repo_name, expected_bots_json, ci_response_enabled, review_timeout_minutes, merge_conflict_resolution_enabled, created_at, updated_at
       FROM user_pr_review_bot_settings
       WHERE repo_owner = ? AND repo_name = ? AND user_id IN (${userIdPlaceholders})`,
    ).bind(repoOwner, repoName, ...ownerUserIds),
  ]);

  const installationByOwnerLogin = new Map(
    ((installationsResult.results ?? []) as InstallationRow[]).map((row) => [
      row.owner_login.trim().toLowerCase(),
      row,
    ]),
  );
  const settingsRowsByUserId = new Map(
    ((settingsResult.results ?? []) as UserPrReviewBotSettingsRow[]).map((row) => [row.user_id, row]),
  );
  const botSettingsByOwnerRepo = new Map<string, UserPrReviewBotSettingsPayload>();
  for (const ownerUserId of ownerUserIds) {
    botSettingsByOwnerRepo.set(
      reviewLoopSettingsRepoKey({ ownerUserId, repoOwner, repoName }),
      await mapPrReviewBotSettingsRow(settingsRowsByUserId.get(ownerUserId) ?? null),
    );
  }

  return { installationByOwnerLogin, botSettingsByOwnerRepo };
}

async function prefetchReviewLoopChecklistInputsByRepo(
  env: Env,
  contexts: ReviewLoopPrefetchContext[],
): Promise<Map<string, ReviewLoopChecklistPrefetchInputs>> {
  const inputsByRepo = new Map<string, ReviewLoopChecklistPrefetchInputs>();
  for (const [repoKey, repoContexts] of groupReviewLoopPrefetchContextsByRepo(contexts)) {
    try {
      const inputs = await prefetchReviewLoopChecklistInputsForRepo(env, repoContexts);
      if (inputs) inputsByRepo.set(repoKey, inputs);
    } catch (error) {
      log.warn(
        { event: "review_loop.prefetch_failed", repoKey, error: String(error) },
        "Review-loop checklist prefetch failed; falling back to per-call D1 reads",
      );
    }
  }
  return inputsByRepo;
}

function isKnownReviewLoopReplay(item: ReviewLoopWorklistItem, knownSources: KnownReviewLoopSources): boolean {
  const promptedAtMs = knownSources.promptedAtBySourceId.get(item.sourceId);
  if (promptedAtMs !== undefined) {
    // Review bodies have no GitHub `updated_at`; when a prompted hash exists, an edited body (live
    // hash differs) is genuinely new actionable feedback, not a replay. Falls back to timestamp for
    // legacy review-body records (no stored hash) and every other kind.
    const promptedBodyHash = knownSources.bodyHashBySourceId?.get(item.sourceId);
    if (item.rawBodyHash !== undefined && promptedBodyHash !== undefined) {
      return isSamePromptedReviewBodyHash(item.rawBodyHash, promptedBodyHash);
    }
    return item.updatedAtMs <= promptedAtMs;
  }
  return knownSources.legacySourceIds.has(item.sourceId) || knownSources.triggeringSourceIds.has(item.sourceId);
}

/**
 * Raw-body hashes for the `review-body:*` ids a dispatched worklist prompts, keyed by sourceId.
 * Persisted with the prompted records so the next wave can detect a reviewer's body edit (the reviews
 * endpoint has no `updated_at`). Only review-body items carry `rawBodyHash`, so this map is empty for
 * bot/CI worklists. (PR-1 edited-review-body dedup.)
 *
 * Covers the canonical items (worklist.items) AND review-body ids collapsed as a DUPLICATE, which
 * are still recorded as prompted. A duplicate review body gets ITS OWN raw-body hash (carried on the
 * worklist as reviewBodyDuplicateHashes) — NOT the canonical's, which only shares the NORMALIZED
 * body, so a duplicate differing only in whitespace/case/beyond-cap bytes would otherwise be stamped
 * with a mismatching hash and re-admitted spuriously every wave.
 */
function reviewBodyHashesFromWorklistItems(worklist: {
  items: ReviewLoopWorklistItem[];
  reviewBodyDuplicateHashes?: ReadonlyMap<string, string>;
}): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const item of worklist.items) {
    if (item.rawBodyHash) hashes.set(item.sourceId, item.rawBodyHash);
  }
  for (const [sourceId, hash] of worklist.reviewBodyDuplicateHashes ?? []) {
    hashes.set(sourceId, hash);
  }
  return hashes;
}

type ReviewLoopDuplicateGroup = {
  canonicalSourceId: string;
  duplicateSourceIds: string[];
  duplicateSources?: Array<{ sourceId: string; path: string | null; line: number | null }>;
};
type UsedReviewLoopTriage = Extract<ReviewLoopTriageOutcome, { ok: true }>;

function expandSourceIdsWithDuplicateGroups(
  sourceIds: Iterable<string>,
  duplicateGroups: readonly ReviewLoopDuplicateGroup[],
): string[] {
  const expanded = new Set(sourceIds);
  for (const group of duplicateGroups) {
    if (!expanded.has(group.canonicalSourceId)) continue;
    for (const duplicateSourceId of group.duplicateSourceIds) expanded.add(duplicateSourceId);
  }
  return [...expanded].sort();
}

function promptedSourceIdsForTriage(
  triage: UsedReviewLoopTriage,
  duplicateGroups: readonly ReviewLoopDuplicateGroup[],
): string[] {
  return expandSourceIdsWithDuplicateGroups(
    triage.actionItems.flatMap((item) => item.sourceIds),
    duplicateGroups,
  );
}

function droppedSourceIdsForTriage(
  triage: UsedReviewLoopTriage,
  duplicateGroups: readonly ReviewLoopDuplicateGroup[],
): Array<{ sourceId: string; basis: string }> {
  const basisBySourceId = new Map<string, string>();
  for (const dropped of triage.droppedItems) {
    const basis = dropped.reason.trim() || "Dropped by review-loop triage as zero-substance noise.";
    for (const sourceId of expandSourceIdsWithDuplicateGroups([dropped.sourceId], duplicateGroups)) {
      basisBySourceId.set(sourceId, basis);
    }
  }
  return [...basisBySourceId.entries()].map(([sourceId, basis]) => ({ sourceId, basis }));
}

async function markTriageDroppedItemsDeclined(input: {
  db: D1Database;
  epoch: ReviewLoopEpoch;
  triage: UsedReviewLoopTriage;
  duplicateGroups: readonly ReviewLoopDuplicateGroup[];
  nowMs: number;
}): Promise<void> {
  await upsertDispositionsBatch(
    input.db,
    droppedSourceIdsForTriage(input.triage, input.duplicateGroups).map((dropped) => ({
      sessionId: input.epoch.sessionId,
      prUrl: input.epoch.prUrl,
      sourceId: dropped.sourceId,
      disposition: "declined",
      basis: dropped.basis,
      epochId: input.epoch.id,
    })),
    input.nowMs,
  );
}
// One-off PR comment posted when a review-listening PR has real merge conflicts with its base.
// Cycloid does not auto-resolve textual conflicts; it surfaces them and pauses the loop.
const MERGE_CONFLICT_PR_COMMENT =
  "Cycloid: this branch has merge conflicts with its base branch, so automated review responses are paused. Please rebase or resolve the conflicts; Cycloid resumes once the branch is mergeable again.";
// One-off PR comment when Cycloid cannot bring a behind-base branch up to date (no contents:write
// on the head repo, or repeated update-branch attempts that never take effect).
const BRANCH_UPDATE_FAILED_PR_COMMENT =
  "Cycloid: couldn't bring this branch up to date with its base branch, so automated review responses are paused. Please update or rebase the branch manually.";
// How long we wait for OUR own queued update-branch to advance the head before deciding the base-merge
// is stuck (queued-forever, or base re-advancing faster than we update) and surfacing it to the owner.
// The `update_branch_queued_at` spine marker is stamped when our update-branch queues for a head and
// clears when the head advances, so a marker still on the SAME head past this window means the queued
// merge never landed. This replaces the folded `pr_mergeability_attempts` counter — it preserves the
// old ~15-minute give-up horizon (the folded 3-attempt cap × the folded 5-minute cooldown) without a
// per-head attempt row (D-54). A successful update advances the head and the per-head re-queue on the
// next head handles a fast-moving base, so we issue update-branch at most once per head.
const UPDATE_BRANCH_STUCK_GIVE_UP_MS = 15 * 60 * 1000;
const log = createLogger({ bindings: { component: "review-loop-sweep" } });

const SUPPORTED_DELETABLE_REVIEW_LOOP_SOURCE_PREFIXES = ["review-comment:", "issue-comment:", "qa-verdict:"] as const;

function isSupportedDeletableReviewLoopSource(sourceId: string): boolean {
  return SUPPORTED_DELETABLE_REVIEW_LOOP_SOURCE_PREFIXES.some((prefix) => sourceId.startsWith(prefix));
}

async function buildUnpromptableInformationalStamps(
  db: D1Database,
  input: {
    sessionId: string;
    prUrl: string;
    worklist: ReviewLoopWorklist;
  },
): Promise<Array<{ sessionId: string; prUrl: string; sourceId: string; basis: string; threadRootSourceId?: string }>> {
  const registered = new Set(await listUndispositionedActionable(db, input.sessionId, input.prUrl));
  const canClassifyDeleted = Array.isArray(input.worklist.liveSourceIds);
  const live = new Set(input.worklist.liveSourceIds ?? []);
  const basisBySourceId = new Map<string, { basis: string; threadRootSourceId?: string }>();

  for (const item of input.worklist.unpromptableItems ?? []) {
    if (registered.has(item.sourceId)) {
      basisBySourceId.set(item.sourceId, {
        basis: item.reason,
        ...(item.threadRootSourceId ? { threadRootSourceId: item.threadRootSourceId } : {}),
      });
    }
  }

  for (const sourceId of registered) {
    if (basisBySourceId.has(sourceId)) continue;
    if (!canClassifyDeleted) continue;
    if (!isSupportedDeletableReviewLoopSource(sourceId)) continue;
    if (!live.has(sourceId)) basisBySourceId.set(sourceId, { basis: "comment_deleted" });
  }

  return [...basisBySourceId.entries()].map(([sourceId, entry]) => ({
    sessionId: input.sessionId,
    prUrl: input.prUrl,
    sourceId,
    basis: entry.basis,
    ...(entry.threadRootSourceId ? { threadRootSourceId: entry.threadRootSourceId } : {}),
  }));
}

/**
 * Best-effort blocked-session DM from the review-loop sweep. The sweep is
 * route-triggered (not DO-resident), so KV alone is the dedup guard - no DO
 * storage flag - and `callbackContext` is unavailable here (it lives in the
 * SessionDO), so target resolution falls back to the linked-team / single-active-
 * install path. Never throws; a null/invalid owner is a silent no-op.
 */
/**
 * Epoch-block reasons that warrant an owner DM, mapped to their blocker kind.
 * These block via `markReviewLoopEpochBlocked` with NO PR comment of their own,
 * so the DM is the only owner-facing notice. Reasons absent here never DM.
 */
export const EPOCH_BLOCK_DM_KIND: Record<string, BlockerKind> = {
  attempt_cap_reached: BlockerKind.ReviewAttemptCap,
  // GitHub App lost/lacks the access it needs on this repo: only the owner can
  // fix it (reinstall / grant the missing permission).
  missing_installation: BlockerKind.GithubAppPermission,
  installation_capabilities_missing: BlockerKind.GithubAppPermission,
  // GitHub returned 401/403 polling this PR (classifyGithubPollFailure): the
  // repo's GitHub authorization is no longer valid and needs the owner to
  // reconnect.
  github_auth_lost: BlockerKind.GithubAuthLost,
};

async function dmSweepOwnerBlocked(
  env: Env,
  args: { sessionId: string; ownerUserId: number | null; kind: BlockerKind; dedupKey: string; prUrl?: string },
): Promise<void> {
  const { ownerUserId } = args;
  if (ownerUserId === null || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return;
  await notifyUserBlocked(env, {
    sessionId: args.sessionId,
    ownerUserId,
    kind: args.kind,
    dedupKey: args.dedupKey,
    ...(args.prUrl ? { prUrl: args.prUrl } : {}),
  });
}

export interface ReviewLoopSweepResult {
  attempted: number;
  enqueued: number;
  completedNoop: number;
  blocked: number;
  contentionDeferred: number;
  transientDeferred: number;
  dispatchErrors: number;
  /** Prompts enqueued for human-source epochs (sourceKind==="human"). */
  humanEpochsCreated: number;
  /** Prompts enqueued for mixed-source epochs (sourceKind==="mixed"). */
  mixedEpochsCreated: number;
  // summaryCommentsPosted / summaryCommentsFailed are NOT incremented here:
  // summary comments are emitted from publish-service.ts in response to session
  // events, not from the sweep loop. There is no observable hook in this file.
  reviewListeningAttempted: number;
  reviewListeningClosed: number;
  reviewListeningHeadChanged: number;
  reviewListeningStaleEpochsBlocked: number;
  reviewListeningEpochsBootstrapped: number;
  /** Failing CI checks already on the head that were recovered into a ci-fix epoch on reconcile. */
  reviewListeningCiChecksRecovered: number;
  /** QTA needs-work verdicts carried into a verification-intake epoch on reconcile. */
  reviewListeningVerificationIntakes: number;
  /** Dirty PR heads carried into a merge-conflict resolution epoch on reconcile. */
  reviewListeningMergeConflictIntakes: number;
  /** In-flight epochs blocked because the PR has real merge conflicts (mergeable_state=dirty). */
  reviewListeningRebaseBlocked: number;
  /** Behind-base PRs for which an update-branch was issued (server-side base merge). */
  reviewListeningBranchUpdated: number;
  /** Pending epochs re-keyed to a new head after our own update-branch advanced it. */
  reviewListeningCarriedForward: number;
  /**
   * Budget-truncated-tail epochs re-keyed to a new head (as a re-driveable `ready` epoch) instead of
   * being stale-blocked on a foreign head change, so the un-prompted tail drains without a fresh bot
   * signal (ARC-1244). Feeds the `arcanist.review_loop.head_change_truncated_tail_rekeyed` metric.
   */
  reviewListeningTruncatedTailRekeyed: number;
  reviewListeningRefsHealed: number;
  reviewListeningErrors: number;
  /** In-flight epochs whose expired lease was reclaimed (reset to `ready` for re-drive). */
  stuckReclaimed: number;
  /** In-flight epochs blocked because they hit the attempt cap during reclaim. */
  stuckBlocked: number;
  /** FSM D17 committed in-flight epoch rows whose epoch dispatch side-effect was redelivered. */
  fsmEpochDispatchRedelivered: number;
  /** FSM D17 terminal loud side-effects redelivered. */
  fsmLoudRedelivered: number;
  /** FSM D17 MERGE_READY settle telemetry side-effects redelivered. */
  fsmSettleRedelivered: number;
  /** A3 run-scoped verification backstops fired (stuck verifier → stopped + NOTIFY_QA_ISSUE). */
  fsmVerifyingDeadlineFired: number;
  /** A3 cross-DO dormant-REVIEW give-ups fired (REVIEW dwelt > 4h → NEEDS_YOU(review_stuck) + drain). */
  fsmReviewStuckDeadlineFired: number;
  /** ARC-1330: stranded in_flight_epoch_id markers (epoch already completed/blocked) cleared via the
   *  self-heal pass — the standing stock that wedged in REVIEW before the emit-on-terminal fix landed. */
  fsmStrandedTerminalMarkersCleared: number;
  /** ARC-1445: REVIEW rows (in_flight NULL) whose undispositioned items had no live epoch, re-dispatched
   *  via a `review.item_ready` drain — the stock the forward `epoch.settled` arm-the-drain cannot reach. */
  fsmUndispatchedReviewItemsDispatched: number;
}

function createReviewLoopSweepResult(overrides: Partial<ReviewLoopSweepResult> = {}): ReviewLoopSweepResult {
  return {
    attempted: 0,
    enqueued: 0,
    completedNoop: 0,
    blocked: 0,
    contentionDeferred: 0,
    transientDeferred: 0,
    dispatchErrors: 0,
    humanEpochsCreated: 0,
    mixedEpochsCreated: 0,
    reviewListeningAttempted: 0,
    reviewListeningClosed: 0,
    reviewListeningHeadChanged: 0,
    reviewListeningStaleEpochsBlocked: 0,
    reviewListeningEpochsBootstrapped: 0,
    reviewListeningCiChecksRecovered: 0,
    reviewListeningVerificationIntakes: 0,
    reviewListeningMergeConflictIntakes: 0,
    reviewListeningRebaseBlocked: 0,
    reviewListeningBranchUpdated: 0,
    reviewListeningCarriedForward: 0,
    reviewListeningTruncatedTailRekeyed: 0,
    reviewListeningRefsHealed: 0,
    reviewListeningErrors: 0,
    stuckReclaimed: 0,
    stuckBlocked: 0,
    fsmEpochDispatchRedelivered: 0,
    fsmLoudRedelivered: 0,
    fsmSettleRedelivered: 0,
    fsmVerifyingDeadlineFired: 0,
    fsmReviewStuckDeadlineFired: 0,
    fsmStrandedTerminalMarkersCleared: 0,
    fsmUndispatchedReviewItemsDispatched: 0,
    ...overrides,
  };
}

function addDispatchResult(target: ReviewLoopSweepResult, source: ReviewLoopSweepResult): void {
  target.attempted += source.attempted;
  target.enqueued += source.enqueued;
  target.completedNoop += source.completedNoop;
  target.blocked += source.blocked;
  target.contentionDeferred += source.contentionDeferred;
  target.transientDeferred += source.transientDeferred;
  target.dispatchErrors += source.dispatchErrors;
  target.humanEpochsCreated += source.humanEpochsCreated;
  target.mixedEpochsCreated += source.mixedEpochsCreated;
}

function addProcessEpochStatus(
  result: ReviewLoopSweepResult,
  epoch: ReviewLoopEpoch,
  status: ProcessEpochResult,
): void {
  if (status === "enqueued") {
    result.enqueued += 1;
    if (epoch.sourceKind === "human") result.humanEpochsCreated += 1;
    if (epoch.sourceKind === "mixed") result.mixedEpochsCreated += 1;
  }
  if (status === "completed_noop") result.completedNoop += 1;
  if (status === "blocked") result.blocked += 1;
  if (status === "contention_deferred") result.contentionDeferred += 1;
  if (status === "transient_deferred") result.transientDeferred += 1;
}

function groupReviewLoopEpochsBySession(epochs: ReviewLoopEpoch[]): ReviewLoopEpoch[][] {
  const groupsBySession = new Map<string, ReviewLoopEpoch[]>();
  for (const epoch of epochs) {
    const group = groupsBySession.get(epoch.sessionId);
    if (group) {
      group.push(epoch);
    } else {
      groupsBySession.set(epoch.sessionId, [epoch]);
    }
  }
  return [...groupsBySession.values()];
}

async function processReviewLoopEpochGroupsWithConcurrency(
  groups: ReviewLoopEpoch[][],
  concurrency: number,
  processGroup: (group: ReviewLoopEpoch[]) => Promise<ReviewLoopSweepResult>,
  onGroupError: (group: ReviewLoopEpoch[], error: unknown) => void,
): Promise<ReviewLoopSweepResult> {
  const result = createReviewLoopSweepResult();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < groups.length) {
      const group = groups[nextIndex];
      nextIndex += 1;
      try {
        addDispatchResult(result, await processGroup(group));
      } catch (error) {
        result.dispatchErrors += group.length;
        onGroupError(group, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  return result;
}

function extractGithubStatus(error: unknown): number | null {
  const match = /\((\d{3})\)/.exec(String(error));
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

function classifyGithubPollFailure(error: unknown):
  | { transient: true; reason: "github_poll_failed" }
  | {
      transient: false;
      reason: string;
    } {
  const status = extractGithubStatus(error);
  if (status === 401 || status === 403) return { transient: false, reason: "github_auth_lost" };
  if (status === 404) return { transient: false, reason: "repo_gone" };
  if (status === 422) return { transient: false, reason: "github_validation_failed" };
  if (status === 429 || status === null || status >= 500) return { transient: true, reason: "github_poll_failed" };
  return { transient: false, reason: "github_poll_failed" };
}

function isPromptContentionFailure(result: { status: number; error?: string | null; reason?: string | null }): boolean {
  if (result.status === 429) return true;
  if (result.status !== 409) return false;
  const reason = String(result.reason ?? result.error ?? "").toLowerCase();
  return ["running", "waiting_for_input", "sandbox_creating", "reconnecting"].some((value) => reason.includes(value));
}

// A 409 whose reason indicates the sandbox is stopped/not-yet-ready — the session can still be
// re-driven (Fix 1 cold-resumes review-loop enqueues), so this is a bounded transient retry, not a
// permanent pause. Terminal reasons (archived/blocked/failed/finalizing) are deliberately excluded so
// they continue to fail fast via prompt_enqueue_failed.
//
// Keys strictly off the structured `reason` field, never the generic `error`: `session_not_sendable`
// (PROMPT_SEND_BLOCKED_ERROR) is the umbrella error returned for EVERY blocked send — archived,
// blocked, failed, finalizing, and stopped all share it, discriminated only by `reason`. Falling back
// to `error` would let a reason-less 409 match `session_not_sendable` and burn the transient-retry
// budget on a genuinely terminal state. A 409 without a recoverable `reason` is treated as terminal
// (falls through to prompt_enqueue_failed).
function isResumableEnqueueFailure(result: { status: number; reason?: string | null }): boolean {
  if (result.status !== 409) return false;
  const reason = String(result.reason ?? "").toLowerCase();
  return reason.includes("stopped") || reason.includes("session_not_sendable");
}

async function handleReviewLoopPromptEnqueueFailure(
  result: ReviewLoopPromptEnqueueResult,
  options: {
    deferForContention: (reason: string, error?: string | null) => Promise<unknown>;
    deferForTransientPollFailure: (
      reason: string,
      error?: string | null,
    ) => Promise<{ status: string } | null | undefined>;
    block: (reason: string, error?: string | null) => Promise<unknown>;
    adoptExistingPrompt: (existing: {
      existingPromptId: string;
      existingPromptStatus: string;
    }) => Promise<"enqueued" | "skipped">;
  },
): Promise<Exclude<ProcessEpochResult, "completed_noop">> {
  const error = result.error ?? `status_${result.status}`;
  if (isPromptContentionFailure(result)) {
    await options.deferForContention("prompt_contention", error);
    return "contention_deferred";
  }
  if (isResumableEnqueueFailure(result)) {
    const deferred = await options.deferForTransientPollFailure("prompt_send_not_ready", error);
    if (!deferred) return "skipped";
    return deferred.status === "blocked" ? "blocked" : "transient_deferred";
  }
  if (result.error === REVIEW_LOOP_EPOCH_ACTIVE_PROMPT_ERROR) {
    const existing = readExistingEpochPromptFromReject(result.errorDetails);
    if (existing) return options.adoptExistingPrompt(existing);
  }
  await options.block("prompt_enqueue_failed", error);
  return "blocked";
}

/**
 * Verification verdict gating: before a PR has an approving verification verdict, public "done" and
 * final-ready surfaces stay withheld. RLA still dispatches bot/human/CI work before automatic VA so
 * the verifier remains the final judge after review feedback is handled.
 *
 * Verification must actually be in play — auto policy and not opted out per session — otherwise no
 * verdict will ever arrive and gating would withhold public done forever.
 * verification-in-progress is unreachable here in processEpoch (the pause check defers first) but
 * still answers true for the reconcile rollup.
 */
// Verification is "in play" for this session iff it was not opted out for the session. Shared by
// isAwaitingFirstVerificationVerdict and computeShowDone so the two cannot drift on the opt-out check.
// ARC-1330 D-50A — D7 always-on: the env-level tri-state `VerificationPolicy` gate is gone (no
// deploy-wide `disabled`/`manual` arm); only the per-user/session `auto_verify_disabled` opt-out (#6395)
// gates. `env` is retained on the signature for call-site symmetry with the other predicates.
export function verificationApplies(env: Env, session: SessionState): boolean {
  return !session.autoVerifyDisabled;
}

export function isAwaitingFirstVerificationVerdict(env: Env, session: SessionState): boolean {
  if (!verificationApplies(env, session)) return false;
  // State logic shared with the auto-verification scheduler (shared/session/phase.ts) so the two
  // cannot drift; this adds only the policy/disabled gate via verificationApplies above.
  return isAwaitingVerificationVerdict(session.verificationState ?? null, session.verificationResult ?? null);
}

// ARC-1330 D-59b: `computeShowDone` (the fail-open `review-loop:done` show-decision over the collapsed
// done-state vocabulary) is deleted. Its only caller — the cron `reconcileReviewLoopDoneState` label
// decision — was removed in D-59a, and the public "done" surface is now the strict-conjunction
// `MERGE_READY` projection of the spine record (`project()`), not a per-signal recompute here.
// `verificationApplies` / `isAwaitingFirstVerificationVerdict` survive: the CI-webhook `ci.signal`
// producer (`review-loop-ci-signal.ts`) still reads them as its awaiting-verdict cohort guard.

function expectedKnownBotKey(bot: PrReviewExpectedBot): string | null {
  return bot.type === "known" ? `known:${bot.id}` : null;
}

function missingExpectedKnownBotKeys(
  expectedBots: PrReviewExpectedBot[],
  observedBotKeys: Set<string>,
  signal: "check_run" | "commit_status",
): Set<string> {
  const missing = new Set<string>();
  for (const bot of expectedBots) {
    if (bot.type !== "known") continue;
    const key = expectedKnownBotKey(bot);
    if (!key || observedBotKeys.has(key)) continue;
    if (PR_REVIEW_BOT_CAPABILITIES[bot.id].terminalSignals.includes(signal)) missing.add(key);
  }
  return missing;
}

type MatchedKnownBot = { key: string; actorLogin: string | null };

function matchExpectedKnownTerminalBotByActor(
  expectedBots: PrReviewExpectedBot[],
  missingBotKeys: Set<string>,
  actorLogin: string | null,
): MatchedKnownBot | null {
  if (!actorLogin) return null;
  const normalizedActor = normalizeGitHubActorLogin(actorLogin);
  for (const bot of expectedBots) {
    if (bot.type !== "known") continue;
    const key = expectedKnownBotKey(bot);
    if (!key || !missingBotKeys.has(key)) continue;
    const aliases = PR_REVIEW_BOT_CAPABILITIES[bot.id].actorAliases.map((alias) => normalizeGitHubActorLogin(alias));
    if (aliases.includes(normalizedActor)) return { key, actorLogin };
  }
  return null;
}

async function markReviewLoopEpochProcessingIfPromptIsProcessing(
  env: Env,
  options: { epochId: string; promptId: string; promptStatus: string; nowMs: number; logger: Logger },
): Promise<void> {
  if (options.promptStatus !== "processing") return;
  const processing = await markReviewLoopEpochProcessing(env.DB, options.epochId, {
    promptId: options.promptId,
    nowMs: options.nowMs,
  });
  // A 0-row update returns null and is expected when the DO's own transition already
  // advanced the epoch. Silent stuck-in-"enqueued" is exactly what made this bug class
  // invisible, so surface only the genuinely stuck case: still "enqueued" after both
  // transitions had their chance.
  if (!processing) {
    const current = await getReviewLoopEpochById(env.DB, options.epochId);
    if (current?.status === "enqueued") {
      options.logger.warn(
        { epochId: options.epochId, promptId: options.promptId },
        "Review-loop epoch stuck in enqueued after processing transition",
      );
    }
  }
}

/**
 * Heals an epoch whose prompt the DO already holds. On a mid-dispatch crash the
 * first sweep enqueued the prompt but died before `markReviewLoopEpochEnqueued`,
 * so the epoch is stuck `reserving`. The re-sweep's enqueue is rejected with the
 * surviving prompt's id/status; bind the epoch to THAT prompt (completing the
 * interrupted transition) instead of minting a duplicate. Idempotent: the CAS
 * keys on the re-sweep's own reservation token.
 */
export async function adoptExistingReviewLoopEpochPrompt(
  env: Env,
  options: {
    epochId: string;
    reservationToken: string | null;
    existingPromptId: string;
    existingPromptStatus: string;
    worklistHash: string;
    promptedSourceIds: string[];
    /** Raw-body hashes for the review-body ids in promptedSourceIds (PR-1 edited-review-body dedup). */
    promptedSourceBodyHashes?: ReadonlyMap<string, string>;
    existingPromptedSourceRecords?: PromptedReviewLoopSourceRecord[];
    /** Budget-dropped, un-prompted sourceIds to carry forward (ARC-1226). Empty for the CI path. */
    carriedForwardSourceIds?: string[];
    nowMs: number;
    logger: Logger;
  },
): Promise<"enqueued" | "skipped"> {
  const enqueued = await markReviewLoopEpochEnqueued(env.DB, options.epochId, {
    promptId: options.existingPromptId,
    worklistHash: options.worklistHash,
    nowMs: options.nowMs,
    expectedReservationToken: options.reservationToken,
    promptedSourceIds: options.promptedSourceIds,
    promptedSourceBodyHashes: options.promptedSourceBodyHashes,
    existingPromptedSourceRecords: options.existingPromptedSourceRecords,
    carriedForwardSourceIds: options.carriedForwardSourceIds,
    telemetry: env,
  });
  if (!enqueued) {
    options.logger.warn(
      { epochId: options.epochId, existingPromptId: options.existingPromptId },
      "Review-loop epoch adopt-existing enqueue claim was lost",
    );
    return "skipped";
  }
  options.logger.info(
    {
      event: "review_loop_epoch_adopted_existing_prompt",
      epochId: options.epochId,
      existingPromptId: options.existingPromptId,
      existingPromptStatus: options.existingPromptStatus,
    },
    "review_loop_epoch_adopted_existing_prompt",
  );
  // Drive the processing transition only when the surviving prompt is already
  // processing — its own scheduled transition no-oped against the reserving epoch.
  await markReviewLoopEpochProcessingIfPromptIsProcessing(env, {
    epochId: options.epochId,
    promptId: options.existingPromptId,
    promptStatus: options.existingPromptStatus,
    nowMs: options.nowMs,
    logger: options.logger,
  });
  return "enqueued";
}

/** Reads the surviving prompt id/status off a duplicate-epoch reject's errorDetails. */
export function readExistingEpochPromptFromReject(errorDetails: Record<string, unknown> | null | undefined): {
  existingPromptId: string;
  existingPromptStatus: string;
} | null {
  const existingPromptId =
    errorDetails && typeof errorDetails.existingPromptId === "string" ? errorDetails.existingPromptId : null;
  if (!existingPromptId) return null;
  const existingPromptStatus =
    errorDetails && typeof errorDetails.existingPromptStatus === "string"
      ? errorDetails.existingPromptStatus
      : "queued";
  return { existingPromptId, existingPromptStatus };
}

async function backfillReviewLoopTerminalSignals(
  env: Env,
  epoch: ReviewLoopEpoch,
  token: string,
  nowMs: number,
  logger: Logger,
): Promise<void> {
  const observedBotKeys = new Set(epoch.observedTerminalBotKeys ?? []);
  const missingCommitStatusBotKeys = missingExpectedKnownBotKeys(epoch.expectedBots, observedBotKeys, "commit_status");
  const missingCheckRunBotKeys = missingExpectedKnownBotKeys(epoch.expectedBots, observedBotKeys, "check_run");

  const [statusResult, checkRunResult] = await Promise.allSettled([
    missingCommitStatusBotKeys.size > 0
      ? getCommitStatusContexts(token, epoch.repoOwner, epoch.repoName, epoch.headSha)
      : Promise.resolve([]),
    missingCheckRunBotKeys.size > 0
      ? getCommitCheckRuns(token, epoch.repoOwner, epoch.repoName, epoch.headSha)
      : Promise.resolve([]),
  ]);

  if (statusResult.status === "rejected") {
    logger.warn({ epochId: epoch.id, error: String(statusResult.reason) }, "Review-loop commit status backfill failed");
  } else {
    const seenStatusProducers = new Set<string>();
    for (const status of statusResult.value) {
      const statusProducerKey = `${status.creatorLogin ?? ""}:${status.context ?? ""}`;
      if (seenStatusProducers.has(statusProducerKey)) continue;
      seenStatusProducers.add(statusProducerKey);
      if (!isObservedTerminalCommitStatusState(status.state)) continue;
      if (status.creatorType !== "Bot" && status.creatorType !== "App") continue;
      if (!status.creatorLogin) continue;
      const bot = matchExpectedKnownTerminalBotByActor(
        epoch.expectedBots,
        missingCommitStatusBotKeys,
        status.creatorLogin,
      );
      if (!bot) continue;
      const sourceId = `commit-status:${status.id}:${epoch.prNumber}`;
      try {
        await upsertReviewLoopEpochActivity(env.DB, {
          sessionId: epoch.sessionId,
          ownerUserId: epoch.ownerUserId,
          repoOwner: epoch.repoOwner,
          repoName: epoch.repoName,
          prNumber: epoch.prNumber,
          prUrl: epoch.prUrl,
          headSha: epoch.headSha,
          expectedBots: epoch.expectedBots,
          expectedBotsHash: epoch.expectedBotsHash,
          sourceId,
          botKey: bot.key,
          botActorLogin: bot.actorLogin,
          terminal: true,
          evidence: {
            type: "commit_status",
            sourceId,
            statusId: status.id,
            context: status.context,
            state: status.state,
            description: status.description,
            targetUrl: status.targetUrl,
            deliveryId: null,
          },
          nowMs,
        });
        missingCommitStatusBotKeys.delete(bot.key);
        observedBotKeys.add(bot.key);
      } catch (error) {
        logger.warn(
          { epochId: epoch.id, sourceId, error: String(error) },
          "Review-loop commit status backfill merge failed",
        );
      }
    }
  }

  if (checkRunResult.status === "rejected") {
    logger.warn({ epochId: epoch.id, error: String(checkRunResult.reason) }, "Review-loop check-run backfill failed");
    return;
  }

  for (const checkRun of checkRunResult.value) {
    if (!isObservedTerminalCheckConclusion(checkRun.status, checkRun.conclusion)) continue;
    const actorLogin = checkRun.appSlug ? `${checkRun.appSlug}[bot]` : null;
    const bot = matchExpectedKnownTerminalBotByActor(epoch.expectedBots, missingCheckRunBotKeys, actorLogin);
    if (!bot) continue;
    const sourceId = `check-run:${checkRun.id}:${epoch.prNumber}`;
    try {
      await upsertReviewLoopEpochActivity(env.DB, {
        sessionId: epoch.sessionId,
        ownerUserId: epoch.ownerUserId,
        repoOwner: epoch.repoOwner,
        repoName: epoch.repoName,
        prNumber: epoch.prNumber,
        prUrl: epoch.prUrl,
        headSha: epoch.headSha,
        expectedBots: epoch.expectedBots,
        expectedBotsHash: epoch.expectedBotsHash,
        sourceId,
        botKey: bot.key,
        botActorLogin: bot.actorLogin,
        terminal: true,
        evidence: {
          type: "check_run",
          sourceId,
          checkRunId: checkRun.id,
          checkRunName: checkRun.name,
          status: checkRun.status,
          conclusion: checkRun.conclusion,
          deliveryId: null,
        },
        nowMs,
      });
      missingCheckRunBotKeys.delete(bot.key);
      observedBotKeys.add(bot.key);
    } catch (error) {
      logger.warn({ epochId: epoch.id, sourceId, error: String(error) }, "Review-loop check-run backfill merge failed");
    }
  }
}

/**
 * Posts a one-off CI escalation comment on the PR. The managed status-comment service has no field
 * for a one-off message, so a plain PR issue comment is the simplest robust surface. Failures are
 * logged, not thrown — the caller still blocks the epoch regardless.
 */
async function postCiEscalationComment(
  token: string,
  epoch: ReviewLoopEpoch,
  body: string,
  logger: Logger,
): Promise<void> {
  try {
    await createPrIssueComment(token, epoch.repoOwner, epoch.repoName, epoch.prNumber, body);
  } catch (error) {
    logger.warn({ epochId: epoch.id, error: String(error) }, "Failed to post CI escalation comment");
  }
}

function formatCiCheckRunForMemory(run: CommitCheckRun): string {
  return [
    `- ${run.name ?? "Unnamed check"}: status=${run.status}, conclusion=${run.conclusion ?? "none"}`,
    run.detailsUrl ? `, url=${run.detailsUrl}` : "",
    run.appSlug || run.appName ? `, app=${run.appSlug ?? run.appName}` : "",
  ].join("");
}

async function recordCiReviewLoopMemoryOutcome(
  env: Env,
  input: {
    businessId: string | null | undefined;
    epoch: ReviewLoopEpoch;
    outcome: "ci_attempt_cap_reached" | "ci_checks_pending_cap_reached";
    reason: string;
    runs: CommitCheckRun[];
    sourceTimeMs: number;
    logger: Logger;
  },
): Promise<void> {
  const businessId = input.businessId?.trim();
  if (!businessId) return;
  try {
    await recordReviewLoopOutcomeMemoryIngestion(env, {
      businessId,
      sessionId: input.epoch.sessionId,
      epochId: input.epoch.id,
      repoOwner: input.epoch.repoOwner,
      repoName: input.epoch.repoName,
      prNumber: input.epoch.prNumber,
      prUrl: input.epoch.prUrl,
      headSha: input.epoch.headSha,
      outcome: input.outcome,
      sourceKind: input.epoch.sourceKind,
      sourceTimeMs: input.sourceTimeMs,
      contentText: [
        `Review-loop CI outcome for ${input.epoch.repoOwner}/${input.epoch.repoName} PR #${input.epoch.prNumber}.`,
        `Session: ${input.epoch.sessionId}`,
        `Iteration: ${input.epoch.id}`,
        `Head SHA: ${input.epoch.headSha}`,
        `Outcome: ${input.outcome}`,
        `Reason: ${input.reason}`,
        "Failing or pending checks:",
        ...input.runs.map(formatCiCheckRunForMemory),
      ].join("\n"),
    });
  } catch (error) {
    input.logger.warn(
      { epochId: input.epoch.id, sessionId: input.epoch.sessionId, error: String(error) },
      "Failed to record review-loop memory outcome",
    );
  }
}

// ARC-1330 (PR 48): NOT demoted — legacy still owns epoch dispatch in this slice and the
// epoch terminals feed the spine; see the ownership map at `runReviewLoopSweep`.
// ARC-1330: emit the spine terminal that un-strands `in_flight_epoch_id` for a just-blocked epoch
// (benign/CI-cap -> epoch.settled; publish_failed/reply_failed -> epoch.blocked{response_failed}; the
// "session moved on / not acting" reasons use the marker-clearing terminal). DYNAMIC import, deliberately:
// `live-side-effects` dynamically imports THIS sweep during the live review dispatch, so a new STATIC edge
// from the sweep into the review-loop-epochs module cycle perturbs its init order (it broke the live
// review-producer dispatch test). Loading it lazily, only when a block fires, keeps the eval-time graph identical.
async function emitBlockedEpochTerminal(
  env: Env,
  epoch: ReviewLoopEpoch,
  blockReason: string,
  logger: Logger,
  waitUntil?: (promise: Promise<unknown>) => void,
  options?: { clearDisabledMarker?: boolean },
): Promise<boolean> {
  const { shadowEmitReviewLoopEpochBlockedTerminal } = await import("./review-loop-epoch-blocked-terminal");
  return shadowEmitReviewLoopEpochBlockedTerminal(env, epoch, blockReason, logger, waitUntil, options);
}

/**
 * Dispatch orchestration for a single review-loop epoch: claim-CAS → session/review-listening/owner/
 * head guards → verification-in-progress pause → CI / merge-conflict / review branching → prior-source
 * dedup → worklist build + triage → prompt enqueue (+ enqueue-failure taxonomy) →
 * markReviewLoopEpochEnqueued.
 *
 * Extracted from the cron `processEpoch` (ARC-1330 Phase B, slice B3) so the FSM `dispatch_epoch`
 * sink (B4) and the stuck-epoch reclaim (B6) can drive an epoch on webhook arrival / on reclaim
 * instead of only on the every-5-minutes cron poll. The claim-CAS (`claimReviewLoopEpochForPrompt`) is the single
 * mutex, so the same epoch reached from the poll and the webhook at once dispatches exactly once — the
 * loser claims nothing and returns "skipped". Behavior-preserving vs the prior inline `processEpoch`:
 * the cron forwards through this with no `trigger` (its dispatch telemetry is unchanged); `trigger`
 * only adds a bounded tag on the arrival_to_dispatch emit for the non-poll callers.
 *
 * `leaseOwner` is "scheduled-sweep" for every caller: the claim just needs a stable lease-owner label
 * and the reclaim keys off lease expiry, not the owner string.
 */
// Reads the self-contained mention payload a mention epoch stored in terminal_evidence_json at
// bootstrap. Returns the first `type: "mention"` entry, or null if none is present (a malformed /
// legacy row → the dispatch blocks it honestly rather than sending an empty prompt).
function mentionEvidenceFromEpoch(epoch: ReviewLoopEpoch): MentionEpochEvidence | null {
  for (const entry of epoch.terminalEvidence) {
    if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "mention") {
      return entry as MentionEpochEvidence;
    }
  }
  return null;
}

export async function dispatchReviewLoopEpoch(
  env: Env,
  epoch: ReviewLoopEpoch,
  options: {
    nowMs: number;
    logger: Logger;
    /** Bounded telemetry tag for the arrival_to_dispatch emit; omitted on the cron/poll path. */
    trigger?: ReviewLoopDispatchTrigger;
    /** Batched checklist inputs from the sweep prefetch; absent callers fall back to per-call D1 reads. */
    prefetchInputs?: ReviewLoopChecklistPrefetchInputs;
  },
): Promise<ProcessEpochResult> {
  const { nowMs, logger, trigger, prefetchInputs } = options;
  const claimed = await claimReviewLoopEpochForPrompt(env.DB, epoch.id, {
    leaseOwner: "scheduled-sweep",
    nowMs,
  });
  if (!claimed) return "skipped";
  await emitReviewLoopReadyToClaimEvent(env, {
    sourceKind: epoch.sourceKind,
    repo: `${epoch.repoOwner}/${epoch.repoName}`,
    ownerUserId: epoch.ownerUserId,
    readyToClaimMs: nowMs - readyAtMsForDueEpoch(epoch),
    sessionId: epoch.sessionId,
    prUrl: epoch.prUrl,
    epochId: epoch.id,
  });
  // Session model for the review_loop.epoch.completed telemetry tag. Captured after the session is
  // loaded below; early terminal transitions (e.g. attempt-cap block before the session fetch) emit
  // with model "unknown", which is correct — the model isn't known at that point.
  let sessionModel: string | null = null;
  const epochTelemetry = (): ReviewLoopEpochTelemetry => ({ env, model: sessionModel });
  // ARC-1330: settle a no-actionable-work epoch AND emit the spine `epoch.settled` terminal so the
  // transition clears `in_flight_epoch_id`. Without the emit the marker strands and `caught_up`'s
  // `no_inflight_epoch` conjunct stays false forever — the wedge these `completed_noop` arms caused.
  // Mirrors the prompt-driven emit at publish-service/durable-object: emit ONLY when the DAO actually
  // settled the row `completed` (a stale-token no-op returns null), best-effort (the producer is
  // try-caught OFF this path).
  const completeNoopEpochAndSettle = async (
    completeOptions: Parameters<typeof markReviewLoopEpochCompleted>[2],
  ): Promise<void> => {
    const settled = await markReviewLoopEpochCompleted(env.DB, claimed.id, completeOptions);
    if (settled?.status === "completed") {
      await shadowEmitReviewLoopEpochTerminal(env, settled, "settled", logger);
    }
  };
  const blockClaimedEpoch = async (reason: string, error?: string | null) => {
    const blockResult = await markReviewLoopEpochBlocked(env.DB, claimed.id, {
      nowMs,
      reason,
      error,
      expectedReservationToken: claimed.reservationToken,
      telemetry: epochTelemetry(),
    });
    // A subset of epoch-block reasons need human action with no PR comment of
    // their own; DM the owner for those. dedupKey scopes per epoch+head so a
    // re-block of the same epoch/head won't re-DM. Most block reasons
    // (head_changed, session_mismatch, ...) are not in the map and never DM.
    // Only DM when this call actually blocked the epoch: markReviewLoopEpochBlocked
    // returns null on a no-op (stale token, wrong status, or a concurrent worker
    // already advanced the epoch), and a DM there would be spurious.
    // ARC-1330: clear the stranded in-flight marker (the producer routes/skips by reason + guards on
    // the in-flight epoch). Only when the block actually landed (non-null).
    if (blockResult) {
      await emitBlockedEpochTerminal(env, claimed, reason, logger);
    }
    const dmKind = EPOCH_BLOCK_DM_KIND[reason];
    if (blockResult && dmKind) {
      await dmSweepOwnerBlocked(env, {
        sessionId: claimed.sessionId,
        ownerUserId: claimed.ownerUserId,
        kind: dmKind,
        dedupKey: `${claimed.id}:${claimed.headSha}`,
        prUrl: claimed.prUrl,
      });
    }
    return blockResult;
  };
  // W11-V5: the two deferral wrappers now DUAL-write — the legacy `pr_review_response_epochs`
  // lease/defer counter (unchanged; legacy's sweep depends on it as a PERMANENT parallel fallback in the
  // Phase-B hybrid — D-53-as-deletion was cancelled) PLUS a spine `epoch.deferred` observation via
  // `emitEpochDeferralToSpine`. The spine emit is best-effort/additive (a REVIEW `log_noop` self-loop; no
  // state change, the epoch stays in-flight and the §10 REVIEW deadline is the SF10 give-up). It NEVER
  // replaces the legacy write — the cron/legacy defer path is the fallback the hybrid keeps by design.
  const deferClaimedEpochForContention = async (reason: string, error?: string | null) => {
    const result = await markReviewLoopEpochContentionDeferred(env.DB, claimed.id, {
      nowMs,
      reason,
      error,
      expectedReservationToken: claimed.reservationToken,
    });
    await emitEpochDeferralToSpine(
      env,
      claimed.sessionId,
      { epochId: claimed.id, deferralKind: "contention", reason },
      logger,
    );
    return result;
  };
  const deferClaimedEpochForTransientPollFailure = async (reason: string, error?: string | null) => {
    const result = await markReviewLoopEpochTransientFailure(env.DB, claimed.id, {
      nowMs,
      reason,
      error,
      expectedReservationToken: claimed.reservationToken,
      transientFailureLimit: REVIEW_LOOP_TRANSIENT_FAILURE_LIMIT,
    });
    await emitEpochDeferralToSpine(
      env,
      claimed.sessionId,
      { epochId: claimed.id, deferralKind: "transient", reason },
      logger,
    );
    // ARC-1330: a transient poll failure that crossed the retry limit flips to `blocked` -> emit the
    // clearing terminal (a still-deferred `ready` result keeps re-driving and stays in-flight).
    if (result?.status === "blocked") {
      await emitBlockedEpochTerminal(env, claimed, reason, logger);
    }
    return result;
  };
  const handleGithubPollFailure = async (error: unknown) => {
    const classification = classifyGithubPollFailure(error);
    if (!classification.transient) {
      await blockClaimedEpoch(classification.reason, String(error));
      return "blocked" as const;
    }
    const deferred = await deferClaimedEpochForTransientPollFailure(classification.reason, String(error));
    if (!deferred) return "skipped" as const;
    return deferred.status === "blocked" ? ("blocked" as const) : ("transient_deferred" as const);
  };
  class PostSideEffectBlockFailure extends Error {
    constructor(readonly originalError: unknown) {
      super(`Review-loop block failed after side effect: ${String(originalError)}`);
      this.name = "PostSideEffectBlockFailure";
    }
  }
  const runPostSideEffectBlock = async (block: () => Promise<void>) => {
    try {
      await block();
    } catch (error) {
      if (isTransientD1StorageError(error)) {
        throw new PostSideEffectBlockFailure(error);
      }
      throw error;
    }
  };
  const prewarmBeforeEnqueue = async () =>
    prewarmReviewLoopDispatchSession({
      env,
      sessionId: claimed.sessionId,
      epochId: claimed.id,
      sourceKind: claimed.sourceKind,
      nowMs,
      logger,
    });

  // Attempt cap: claimReviewLoopEpochForPrompt bumped attempt_count, so claimed.attemptCount is the
  // post-increment value. Contention/transient deferrals decrement it, so this counts only attempts
  // that actually consumed a drive (including reclaim → re-drive cycles). Past the cap, block instead
  // of retrying forever.
  //
  // ARC-1226: a carry-forward drain (carried_forward non-empty) is a bounded, PRODUCTIVE loop — each
  // productive wave dispatches up to ~16 items and shrinks the tail — so it must be EXEMPT from this
  // general cap. Otherwise a PR needing >5 waves blocks here with `attempt_cap_reached` (an EXHAUSTED
  // reason → rollup falsely settles review-loop:done with the tail unshown). The drain is instead
  // bounded by REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP in the settle paths, which uses the honest
  // non-exhausted `worklist_truncation_unresolved` reason (rollup stays "working"). Non-drain epochs
  // still cap here. ARC-1242: that cap counts CONSECUTIVE no-progress attempts, not attempt_count, so a
  // flaky drain that keeps shrinking its tail is never parked early by reclaim/crash cycles.
  const isCarryForwardDrain = (claimed.carriedForwardSourceIds?.length ?? 0) > 0;
  if (!isCarryForwardDrain && claimed.attemptCount > REVIEW_LOOP_ATTEMPT_CAP) {
    await blockClaimedEpoch("attempt_cap_reached", `Review-loop epoch exceeded ${REVIEW_LOOP_ATTEMPT_CAP} attempts`);
    logger.warn(
      { epochId: claimed.id, sessionId: claimed.sessionId, attemptCount: claimed.attemptCount },
      "Review-loop epoch blocked after attempt cap",
    );
    return "blocked";
  }

  try {
    const session = await getSessionState(env, claimed.sessionId);
    sessionModel = session?.model ?? null;
    if (!session || session.status === "archived") {
      await blockClaimedEpoch("session_not_review_listening");
      return "blocked";
    }
    if (!session.reviewListeningActive) {
      const ownerMatches = Number(session.ownerUserId) === claimed.ownerUserId;
      const prMatches = !session.reviewListeningPrUrl || session.reviewListeningPrUrl === claimed.prUrl;
      const headMatches = !session.reviewListeningHeadSha || session.reviewListeningHeadSha === claimed.headSha;
      // Enter-pending deferral covers `mention` as well as `human`: the mention webhook bootstraps the
      // `ready` epoch BEFORE it arms review-listening (emitReviewListeningEntered runs after bootstrap),
      // so a sweep that claims the row in that gap must DEFER (retry until the listener arms / the enter
      // timeout), not hard-block it as session_not_review_listening — which would terminally drop the
      // mention even though the webhook is mid-arm.
      if ((claimed.sourceKind === "human" || isMentionEpoch(claimed)) && ownerMatches && prMatches && headMatches) {
        const reviewListeningEnterElapsedMs = nowMs - claimed.firstActivityAt;
        if (reviewListeningEnterElapsedMs > REVIEW_LOOP_REVIEW_LISTENING_ENTER_TIMEOUT_MS) {
          await blockClaimedEpoch(
            "review_listening_enter_timeout",
            `Review-listening enter still pending after ${reviewListeningEnterElapsedMs}ms`,
          );
          return "blocked";
        }
        await deferClaimedEpochForContention("review_listening_enter_pending");
        return "contention_deferred";
      }
      await blockClaimedEpoch("session_not_review_listening");
      return "blocked";
    }
    if (Number(session.ownerUserId) !== claimed.ownerUserId || session.reviewListeningPrUrl !== claimed.prUrl) {
      await blockClaimedEpoch("session_mismatch");
      return "blocked";
    }
    // Defensive: epochs are never created for read-only QA/review sessions, but
    // block any stale rows instead of dispatching implementation work to them.
    if (isReadOnlyAgentRole(session.agentRole)) {
      await blockClaimedEpoch(isQaTesterAgentRole(session.agentRole) ? "verification_session" : "review_session");
      return "blocked";
    }
    // RLA pause: while a verification run is in progress for this PR, defer dispatch entirely.
    // The contention deferral decrements the attempt the claim consumed, so paused ticks never
    // burn the attempt cap; webhook ingest keeps recording into epochs while paused. The epoch
    // re-drives once the run reaches verification-done / verification-exhausted.
    if (session.verificationState === "verification-in-progress") {
      await deferClaimedEpochForContention("verification_in_progress");
      await emitReviewLoopDispatchDeferredMetric(env, {
        repo: `${claimed.repoOwner}/${claimed.repoName}`,
        ownerUserId: claimed.ownerUserId,
        reason: "verification_in_progress",
      });
      return "contention_deferred";
    }
    // Human, mixed, and ci epochs do not depend on bot configuration. Human/mixed carry a human
    // signal in triggeringSourceIds; ci epochs key on the sentinel `expectedBotsHash` ("ci-fixes")
    // and drive off failing check runs, not the configured bot set. None of them must be killed by
    // bot-settings drift, so they bypass the bot checklist. CI still uses its dedicated gate so
    // repo-level CI-response opt-outs block existing CI epochs too.
    const checklistOk: boolean = await (async () => {
      if (claimed.sourceKind === "ci") {
        const elig = await resolveReviewLoopCiEligibility(env, {
          ownerUserId: claimed.ownerUserId,
          repoOwner: claimed.repoOwner,
          repoName: claimed.repoName,
          installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
        });
        if (!elig.ok) {
          await blockClaimedEpoch(elig.reason);
          return false;
        }
        return true;
      }
      // Mention epochs (`@cycloid …`) are an independent class that must be honored REGARDLESS of the
      // per-user manual review toggle, so they gate on CAPABILITIES ONLY (resolveReviewLoopCiEligibility
      // reads install caps, never the review checklist / automatic_reviews_enabled). NEVER route a
      // mention through resolveReviewLoopChecklist, or manual mode would silently drop it.
      if (isMentionEpoch(claimed)) {
        const elig = await resolveReviewLoopCiEligibility(env, {
          ownerUserId: claimed.ownerUserId,
          repoOwner: claimed.repoOwner,
          repoName: claimed.repoName,
          installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
        });
        if (!elig.ok) {
          await blockClaimedEpoch(elig.reason);
          return false;
        }
        return true;
      }
      if (isMergeConflictEpoch(claimed)) {
        const elig = await resolveReviewLoopMergeConflictEligibility(env, {
          ownerUserId: claimed.ownerUserId,
          repoOwner: claimed.repoOwner,
          repoName: claimed.repoName,
          installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
          botSettingsByOwnerRepo: prefetchInputs?.botSettingsByOwnerRepo,
        });
        if (!elig.ok) {
          await blockClaimedEpoch(elig.reason);
          return false;
        }
        return true;
      }
      // Verification-intake epochs carry the sentinel expected-bots hash, so the bot checklist
      // would always fail them; like human epochs they need no configured bots (zero-bot repos
      // still get the full QTA needs-work cycle), so they share the human gate.
      // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
      if (claimed.sourceKind === "human" || claimed.sourceKind === "mixed" || claimed.sourceKind === "verification") {
        const elig = await resolveReviewLoopHumanEligibility(env, {
          ownerUserId: claimed.ownerUserId,
          repoOwner: claimed.repoOwner,
          repoName: claimed.repoName,
          installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
          // Verification epochs bypass the manual-review gate (QA independent of manual mode); ARC-1514.
          sourceKind: claimed.sourceKind,
        });
        if (!elig.ok) {
          await blockClaimedEpoch(elig.reason);
          return false;
        }
        return true;
      }
      const checklist = await resolveReviewLoopChecklist(env, {
        ownerUserId: claimed.ownerUserId,
        repoOwner: claimed.repoOwner,
        repoName: claimed.repoName,
        expectedBotsHash: claimed.expectedBotsHash,
        installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
        botSettingsByOwnerRepo: prefetchInputs?.botSettingsByOwnerRepo,
      });
      if (!checklist.ok) {
        await blockClaimedEpoch(checklist.reason);
        return false;
      }
      return true;
    })();
    if (!checklistOk) return "blocked";
    // Head-divergence BLOCKING is gated SOLELY on the live PR head (the `currentHead !== claimed.headSha`
    // check below after the GitHub poll), NOT on session.reviewListeningHeadSha. ARC-1339: the
    // head-change reconcile re-keys epochs onto the new head (D1) and advances the session head + clears
    // the prior-head verification verdict (DO) in separate, non-atomic writes, with fallible work (token
    // mint, label cleanup) in between. If the re-key lands but the session-head/verdict update is skipped
    // (a post-reconcile await throws → redelivery retries), a sweep claiming the correctly re-keyed epoch
    // in that window used to see the lagging session head and mis-block it head_changed. That terminal
    // blocked row then counted toward hasReviewLoopEpochForHead, suppressing bootstrap and re-stranding
    // the recovered tail (the exact wedge ARC-1244 fixes). The live PR head is the single source of truth
    // and can't lag, so it alone decides head_changed. The same window exists on the ARC-1302
    // own-base-merge carry-forward path; gating blocking on the live head fixes the whole class at the
    // consumer. A lagging session head (epoch matches the live head but the session has not caught up) is
    // handled as a DEFER below — never a block. Cost: a genuinely-stale epoch (live head moved on) now
    // mints a token + one GitHub poll before blocking, instead of short-circuiting locally — bounded (one
    // batch per head change).
    const installationId = session.installationId;
    if (typeof installationId !== "number") {
      await blockClaimedEpoch("missing_installation");
      return "blocked";
    }

    const promptList = await listSessionPrompts(env, claimed.sessionId);
    if (promptList.ok && promptList.payload?.queue.processingPromptId) {
      await deferClaimedEpochForContention(
        "active_prompt",
        `Active prompt ${promptList.payload.queue.processingPromptId}`,
      );
      return "contention_deferred";
    }

    const token = await createInstallationToken(env, installationId);
    let currentHead: string | null;
    try {
      currentHead = await getPrHeadSha(token, claimed.repoOwner, claimed.repoName, claimed.prNumber);
    } catch (error) {
      return handleGithubPollFailure(error);
    }
    if (!currentHead) {
      return handleGithubPollFailure(new Error("GitHub PR head lookup failed"));
    }
    if (currentHead !== claimed.headSha) {
      await blockClaimedEpoch("head_changed");
      return "blocked";
    }
    // ARC-1339: the epoch matches the live PR head, but the loaded session still records a DIFFERENT
    // reviewListeningHeadSha — the head-change bookkeeping (advance head + clear the prior-head
    // verification verdict) has not landed for this session yet (the non-atomic webhook re-key won the
    // race against its own head/verdict update). The session view is stale, so dispatching now could enqueue
    // review-loop work against a head whose verification state has not been reset yet. DEFER (never block —
    // a head_changed block here would strand the re-keyed tail) until the reconcile lands the new head +
    // clears the verdict (next sweep's reconcileReviewListeningSessions tick or webhook
    // redelivery), then re-drive against fresh state. Contention deferral, so it never burns the attempt
    // cap; the epoch stays non-terminal at the new head, so hasReviewLoopEpochForHead still suppresses a
    // duplicate bootstrap meanwhile.
    if (session.reviewListeningHeadSha && session.reviewListeningHeadSha !== currentHead) {
      await deferClaimedEpochForContention("session_head_lagging");
      return "contention_deferred";
    }
    // CI-failure epoch: drive a fix prompt off the head's failing check runs, debouncing while
    // checks are still pending and enforcing a 3-attempt streak cap per change. This branch fully
    // handles the epoch and returns, so it never reaches the bot/human review-comment worklist code.
    if (isCiEpoch(claimed)) {
      // FIX 7: wrap the head check-run poll in the same transient-failure handling the bot path
      // uses, so a transient 502/429 defers (transient_deferred) instead of permanently blocking.
      let runs;
      try {
        runs = await getCommitCheckRuns(token, claimed.repoOwner, claimed.repoName, claimed.headSha);
      } catch (error) {
        return handleGithubPollFailure(error);
      }
      // Debounce: do not act mid-suite.
      if (hasPendingCheckRuns(runs)) {
        // Cap the debounce by ELAPSED TIME since the epoch started waiting, not by deferral count
        // (which is shared with active_prompt / prompt_contention deferrals and would falsely
        // escalate on a busy session). A perpetually-pending check would otherwise defer forever,
        // so once checks have been pending past the timeout, escalate (PR comment) and stop.
        if (nowMs - claimed.firstActivityAt > REVIEW_LOOP_CI_PENDING_TIMEOUT_MS) {
          // Dedup the pending-timeout escalation per head: a new CI wave on the same head crossing
          // the timeout again must not re-post the comment. Still block this epoch either way.
          const alreadyEscalated = await hasCiPendingCapEscalationForHead(env.DB, {
            sessionId: claimed.sessionId,
            prUrl: claimed.prUrl,
            headSha: claimed.headSha,
            excludeEpochId: claimed.id,
          });
          if (!alreadyEscalated) {
            await postCiEscalationComment(
              token,
              claimed,
              "Cycloid: CI checks on this change have been pending without settling for an extended period, so automated CI fixing has stopped. This PR needs human attention.",
              logger,
            );
          }
          await recordCiReviewLoopMemoryOutcome(env, {
            businessId: session.businessId,
            epoch: claimed,
            outcome: "ci_checks_pending_cap_reached",
            reason: `CI checks still pending after ${REVIEW_LOOP_CI_PENDING_TIMEOUT_MS}ms`,
            runs,
            sourceTimeMs: nowMs,
            logger,
          });
          await runPostSideEffectBlock(async () => {
            await markReviewLoopEpochBlocked(env.DB, claimed.id, {
              reason: "ci_checks_pending_cap_reached",
              error: `CI checks still pending after ${REVIEW_LOOP_CI_PENDING_TIMEOUT_MS}ms`,
              nowMs,
              expectedReservationToken: claimed.reservationToken,
              telemetry: epochTelemetry(),
            });
            // ARC-1330: clear the stranded marker (the cascade owns CI exhaustion via row 4).
            await emitBlockedEpochTerminal(env, claimed, "ci_checks_pending_cap_reached", logger);
            // DM the owner that CI never settled. dedupKey = head: a new CI wave on
            // the same head crossing the timeout again won't re-DM; a new head will.
            await dmSweepOwnerBlocked(env, {
              sessionId: claimed.sessionId,
              ownerUserId: claimed.ownerUserId,
              kind: BlockerKind.CiPendingTimeout,
              dedupKey: claimed.headSha,
              prUrl: claimed.prUrl,
            });
          });
          return "blocked";
        }
        await deferClaimedEpochForContention("ci_checks_pending");
        return "contention_deferred";
      }
      const ciItems = await failingCheckRunWorklistItemsWithLogEvidence(runs, {
        token,
        repoOwner: claimed.repoOwner,
        repoName: claimed.repoName,
      });
      if (ciItems.length === 0) {
        // All green/skipped now — nothing to fix.
        await completeNoopEpochAndSettle({
          nowMs,
          worklistHash: "",
          expectedReservationToken: claimed.reservationToken,
          // Empty worklist = no pending work; settle cleanly and clear any (CI never carries, but
          // keeps the contract uniform) stale carry-forward instead of re-driving off it. ARC-1226.
          clearCarryForward: true,
          telemetry: epochTelemetry(),
        });
        return "completed_noop";
      }
      // Fingerprint of the failing-check NAME set on this head. Stable across reruns (same names,
      // new ids → same fingerprint), so the cap distinguishes "the same checks failing again" from
      // "a different set of checks now failing". Stored as the ci epoch's worklist_hash at enqueue.
      const ciFingerprint = failingCheckFingerprint(runs);
      // Two streaks over the prior consecutive ci epochs (DAO excludes this epoch):
      //   - sameFingerprintStreak: max consecutive prior attempts a still-failing check has persisted
      //     (per check-NAME union, so set growth/shrink doesn't erode it) → same-failure cap.
      //   - totalConsecutiveStreak: all prior ci attempts → oscillation backstop.
      const { sameFingerprintStreak, totalConsecutiveStreak } = await countConsecutiveCiFixEpochsForPr(env.DB, {
        sessionId: claimed.sessionId,
        prUrl: claimed.prUrl,
        excludeEpochId: claimed.id,
        fingerprint: ciFingerprint,
      });
      const priorMatchingAttempt =
        sameFingerprintStreak > 0
          ? await getLatestPriorMatchingCiFixAttempt(env.DB, {
              sessionId: claimed.sessionId,
              prUrl: claimed.prUrl,
              excludeEpochId: claimed.id,
              fingerprint: ciFingerprint,
            })
          : null;
      const capEscalation =
        sameFingerprintStreak >= REVIEW_LOOP_CI_SAME_FAILURE_CAP
          ? {
              comment: `Cycloid: the same CI checks have failed after ${REVIEW_LOOP_CI_SAME_FAILURE_CAP} automated fix attempts on this change. This PR needs human attention. Automated CI fixing will resume if the set of failing checks changes.`,
              error: `CI still failing on the same checks after ${REVIEW_LOOP_CI_SAME_FAILURE_CAP} automated fix attempts`,
            }
          : totalConsecutiveStreak >= REVIEW_LOOP_CI_TOTAL_ATTEMPT_BACKSTOP
            ? {
                comment: `Cycloid: CI is still failing after ${REVIEW_LOOP_CI_TOTAL_ATTEMPT_BACKSTOP} automated fix attempts on this PR without converging. This PR needs human attention.`,
                error: `CI still failing after ${REVIEW_LOOP_CI_TOTAL_ATTEMPT_BACKSTOP} automated fix attempts without converging`,
              }
            : null;
      if (capEscalation) {
        // Dedup the escalation — only post the cap comment once per head. If a ci epoch on this
        // head was already blocked with ci_attempt_cap_reached, skip the comment (still block this
        // epoch so it stops enqueuing).
        const alreadyEscalated = await hasCiAttemptCapEscalationForHead(env.DB, {
          sessionId: claimed.sessionId,
          prUrl: claimed.prUrl,
          headSha: claimed.headSha,
          excludeEpochId: claimed.id,
        });
        if (!alreadyEscalated) {
          await postCiEscalationComment(token, claimed, capEscalation.comment, logger);
        }
        await recordCiReviewLoopMemoryOutcome(env, {
          businessId: session.businessId,
          epoch: claimed,
          outcome: "ci_attempt_cap_reached",
          reason: capEscalation.error,
          runs,
          sourceTimeMs: nowMs,
          logger,
        });
        await runPostSideEffectBlock(async () => {
          await markReviewLoopEpochBlocked(env.DB, claimed.id, {
            reason: "ci_attempt_cap_reached",
            error: capEscalation.error,
            nowMs,
            expectedReservationToken: claimed.reservationToken,
            // Record the failing-check fingerprint on the cap-blocked epoch so it counts as a real
            // same-fingerprint attempt: a rerun of the SAME failing set must re-cap immediately, not
            // re-enqueue (the streak walk skips ci epochs with no stored fingerprint).
            worklistHash: ciFingerprint,
            telemetry: epochTelemetry(),
          });
          // ARC-1330: clear the stranded marker (the cascade re-derives CI exhaustion via row 4).
          await emitBlockedEpochTerminal(env, claimed, "ci_attempt_cap_reached", logger);
          // DM the owner that automated CI fixing gave up. dedupKey = failing-check
          // fingerprint: stable across reruns of the same failing set (no re-DM),
          // but a different failing set re-notifies.
          await dmSweepOwnerBlocked(env, {
            sessionId: claimed.sessionId,
            ownerUserId: claimed.ownerUserId,
            kind: BlockerKind.CiRedExhausted,
            dedupKey: ciFingerprint,
            prUrl: claimed.prUrl,
          });
        });
        return "blocked";
      }
      // LLM triage first (RLA v2 work item D); the dedicated CI-fix builder is the deterministic
      // fail-open fallback. FIX 9 context for the fallback: the bot builder instructs
      // cycloid.review_loop_reply (nonsensical for a CI check) and, after WU2 stripped the PR
      // header, carries no PR context — CI worklist items have CI-log URLs, not PR linkage.
      const ciTriage = await triageReviewLoopWorklist(env, {
        sessionId: claimed.sessionId,
        epochId: claimed.id,
        ownerUserId: claimed.ownerUserId,
        repoOwner: claimed.repoOwner,
        repoName: claimed.repoName,
        prNumber: claimed.prNumber,
        headSha: claimed.headSha,
        candidates: reviewLoopTriageCandidatesFromWorklistItems(ciItems, "ci_failure"),
        logger,
      });
      const ciPromptArgs = {
        epochId: claimed.id,
        repoUrl: `https://github.com/${claimed.repoOwner}/${claimed.repoName}`,
        prUrl: claimed.prUrl,
        prNumber: claimed.prNumber,
        headSha: claimed.headSha,
        worklistItems: ciItems,
        duplicateGroups: [],
        timedOutBotKeys: claimed.timedOutBotKeys,
        ciAttemptContext: priorMatchingAttempt
          ? {
              attemptNumber: sameFingerprintStreak + 1,
              maxAttempts: REVIEW_LOOP_CI_SAME_FAILURE_CAP,
              currentFailingCheckFingerprint: ciFingerprint,
              priorEpochId: priorMatchingAttempt.epochId,
              priorPromptId: priorMatchingAttempt.promptId,
              priorHeadSha: priorMatchingAttempt.headSha,
              priorStatus: priorMatchingAttempt.status,
            }
          : undefined,
      };
      const ciPrompt = ciTriage.ok
        ? // No conflicts are passed on the CI path: ciContext makes the triaged builder suppress them
          // structurally (CI sourceIds are check-run-failure: ids with no review_loop_reply primitive),
          // so the suppression invariant lives in the builder, not in each call-site.
          buildGithubPrReviewLoopTriagedPrompt({ ...ciPromptArgs, actionItems: ciTriage.actionItems, ciContext: true })
        : buildGithubPrCiFixPrompt(ciPromptArgs);
      await prewarmBeforeEnqueue();
      const ciEnqueueResult = await enqueueSessionPrompt(
        env,
        claimed.sessionId,
        ciPrompt,
        String(claimed.ownerUserId),
        {
          reviewLoopEpochId: claimed.id,
          // CI epochs use the bot-style builder; "mixed" is only prompt metadata on the enqueue.
          reviewLoopSourceKind: "mixed",
          // Human-facing summary shown in place of the agent-machinery prompt (CI-fix footer).
          replyToText: buildReviewLoopHumanSummary({ kind: "ci", checkCount: ciItems.length }),
        },
      );
      if (!ciEnqueueResult.ok || !ciEnqueueResult.payload) {
        return handleReviewLoopPromptEnqueueFailure(ciEnqueueResult, {
          deferForContention: deferClaimedEpochForContention,
          deferForTransientPollFailure: deferClaimedEpochForTransientPollFailure,
          block: blockClaimedEpoch,
          // Duplicate-epoch reject: adopt the prompt the DO already holds (see review path).
          adoptExistingPrompt: (existing) =>
            adoptExistingReviewLoopEpochPrompt(env, {
              epochId: claimed.id,
              reservationToken: claimed.reservationToken,
              existingPromptId: existing.existingPromptId,
              existingPromptStatus: existing.existingPromptStatus,
              worklistHash: ciFingerprint,
              promptedSourceIds: ciItems.map((item) => item.sourceId),
              existingPromptedSourceRecords: claimed.promptedSourceRecords,
              nowMs,
              logger,
            }),
        });
      }
      const ciEnqueued = await markReviewLoopEpochEnqueued(env.DB, claimed.id, {
        promptId: ciEnqueueResult.payload.prompt.promptId,
        // Record the failing-check fingerprint so a later attempt can tell whether it is retrying
        // the SAME failing-set (reset signal for the same-failure cap).
        worklistHash: ciFingerprint,
        nowMs,
        expectedReservationToken: claimed.reservationToken,
        promptedSourceIds: ciItems.map((item) => item.sourceId),
        existingPromptedSourceRecords: claimed.promptedSourceRecords,
        telemetry: env,
        trigger,
      });
      if (!ciEnqueued) {
        logger.warn({ epochId: claimed.id }, "Review-loop epoch enqueue claim was lost");
        return "skipped";
      }
      await markReviewLoopEpochProcessingIfPromptIsProcessing(env, {
        epochId: claimed.id,
        promptId: ciEnqueueResult.payload.prompt.promptId,
        promptStatus: ciEnqueueResult.payload.prompt.status,
        nowMs,
        logger,
      });
      return "enqueued";
    }

    if (isMergeConflictEpoch(claimed)) {
      let mergeStatus;
      try {
        mergeStatus = await getPrMergeStatus(token, claimed.repoOwner, claimed.repoName, claimed.prNumber);
      } catch (error) {
        return handleGithubPollFailure(error);
      }
      if (mergeStatus.state === null || mergeStatus.headSha === null) {
        return handleGithubPollFailure(new Error("GitHub PR merge-status lookup failed"));
      }
      if (mergeStatus.state === "closed" || mergeStatus.state === "merged") {
        await blockClaimedEpoch(`pr_${mergeStatus.state}`);
        return "blocked";
      }
      if (mergeStatus.headSha !== claimed.headSha) {
        await blockClaimedEpoch("head_changed");
        return "blocked";
      }
      if (mergeStatus.mergeableState === "unknown") {
        await deferClaimedEpochForContention("mergeability_pending");
        return "contention_deferred";
      }
      if (mergeStatus.mergeableState !== "dirty") {
        await completeNoopEpochAndSettle({
          nowMs,
          worklistHash: "",
          expectedReservationToken: claimed.reservationToken,
          clearCarryForward: true,
          telemetry: epochTelemetry(),
        });
        return "completed_noop";
      }

      const worklistHash = `merge-conflict:${claimed.headSha}`;
      const prompt = buildGithubPrMergeConflictPrompt({
        epochId: claimed.id,
        repoUrl: `https://github.com/${claimed.repoOwner}/${claimed.repoName}`,
        prUrl: claimed.prUrl,
        prNumber: claimed.prNumber,
        headSha: claimed.headSha,
        baseRef: mergeStatus.baseRef || "main",
      });
      await prewarmBeforeEnqueue();
      const enqueueResult = await enqueueSessionPrompt(env, claimed.sessionId, prompt, String(claimed.ownerUserId), {
        reviewLoopEpochId: claimed.id,
        reviewLoopSourceKind: "merge_conflict",
        // Human-facing summary shown in place of the agent-machinery merge-conflict prompt.
        replyToText: buildReviewLoopHumanSummary({ kind: "merge-conflict" }),
      });
      if (!enqueueResult.ok || !enqueueResult.payload) {
        return handleReviewLoopPromptEnqueueFailure(enqueueResult, {
          deferForContention: deferClaimedEpochForContention,
          deferForTransientPollFailure: deferClaimedEpochForTransientPollFailure,
          block: blockClaimedEpoch,
          adoptExistingPrompt: (existing) =>
            adoptExistingReviewLoopEpochPrompt(env, {
              epochId: claimed.id,
              reservationToken: claimed.reservationToken,
              existingPromptId: existing.existingPromptId,
              existingPromptStatus: existing.existingPromptStatus,
              worklistHash,
              promptedSourceIds: claimed.triggeringSourceIds,
              existingPromptedSourceRecords: claimed.promptedSourceRecords,
              nowMs,
              logger,
            }),
        });
      }
      const enqueued = await markReviewLoopEpochEnqueued(env.DB, claimed.id, {
        promptId: enqueueResult.payload.prompt.promptId,
        worklistHash,
        nowMs,
        expectedReservationToken: claimed.reservationToken,
        promptedSourceIds: claimed.triggeringSourceIds,
        existingPromptedSourceRecords: claimed.promptedSourceRecords,
        // Emit arrival_to_dispatch_ms for merge-conflict dispatches too. The claim-side emit this
        // slice removed used to cover this path; the CI + review enqueues already thread telemetry,
        // so without this a merge-conflict dispatch silently disappears from the metric (Codex P2).
        telemetry: env,
      });
      if (!enqueued) {
        logger.warn({ epochId: claimed.id }, "Review-loop merge-conflict epoch enqueue claim was lost");
        return "skipped";
      }
      await markReviewLoopEpochProcessingIfPromptIsProcessing(env, {
        epochId: claimed.id,
        promptId: enqueueResult.payload.prompt.promptId,
        promptStatus: enqueueResult.payload.prompt.status,
        nowMs,
        logger,
      });
      return "enqueued";
    }

    // `@cycloid` mention epoch: dispatch a scoped (targeted) or free-text (directive) mention turn
    // built from the self-contained payload stored at bootstrap (evidence carries the diff hunk, which
    // the review-comment worklist item does not). The head is already verified above. Enqueues with
    // reviewLoopSourceKind "human" (bridge tool-gating: human already unlocks review_summary_comment +
    // review_loop_reply); the epoch row keeps its real 'mention' sourceKind. Fully handles the epoch and
    // returns, so a mention never reaches the bot/human review-comment worklist path (which would throw
    // in reviewSourceKind on a mention).
    if (isMentionEpoch(claimed)) {
      const mention = mentionEvidenceFromEpoch(claimed);
      if (!mention) {
        await blockClaimedEpoch("mention_evidence_missing", "Mention epoch carried no mention payload to dispatch");
        return "blocked";
      }
      const worklistHash = `mention:${claimed.headSha}`;
      // The target source id(s) the agent replies to via cycloid.review_loop_reply. Carried on the
      // self-contained mention payload (targets only — parents are folded into the epoch's
      // handled/triggering set for dedup but are context, not reply targets). Fall back to the epoch's
      // triggering ids for any pre-existing payload that predates the payload `sourceIds` field.
      const mentionSourceIds = mention.sourceIds ?? claimed.triggeringSourceIds;
      const prompt =
        mention.mode === "targeted" && mention.comment
          ? buildGithubPrMentionTargetedPrompt({
              epochId: claimed.id,
              prUrl: claimed.prUrl,
              headSha: claimed.headSha,
              mentionText: mention.mentionText,
              sourceIds: mentionSourceIds,
              comment: mention.comment,
              parentComment: mention.parentComment ?? null,
            })
          : buildGithubPrMentionDirectivePrompt({
              epochId: claimed.id,
              prUrl: claimed.prUrl,
              headSha: claimed.headSha,
              directiveText: mention.mentionText,
              sourceIds: mentionSourceIds,
            });
      await prewarmBeforeEnqueue();
      const enqueueResult = await enqueueSessionPrompt(env, claimed.sessionId, prompt, String(claimed.ownerUserId), {
        reviewLoopEpochId: claimed.id,
        reviewLoopSourceKind: "human",
        replyToText: buildReviewLoopHumanSummary({
          kind: "mention",
          mentionText: mention.mentionText,
          comment: mention.comment ?? null,
          parentComment: mention.parentComment ?? null,
        }),
      });
      if (!enqueueResult.ok || !enqueueResult.payload) {
        return handleReviewLoopPromptEnqueueFailure(enqueueResult, {
          deferForContention: deferClaimedEpochForContention,
          deferForTransientPollFailure: deferClaimedEpochForTransientPollFailure,
          block: blockClaimedEpoch,
          adoptExistingPrompt: (existing) =>
            adoptExistingReviewLoopEpochPrompt(env, {
              epochId: claimed.id,
              reservationToken: claimed.reservationToken,
              existingPromptId: existing.existingPromptId,
              existingPromptStatus: existing.existingPromptStatus,
              worklistHash,
              promptedSourceIds: claimed.triggeringSourceIds,
              existingPromptedSourceRecords: claimed.promptedSourceRecords,
              nowMs,
              logger,
            }),
        });
      }
      const enqueued = await markReviewLoopEpochEnqueued(env.DB, claimed.id, {
        promptId: enqueueResult.payload.prompt.promptId,
        worklistHash,
        nowMs,
        expectedReservationToken: claimed.reservationToken,
        promptedSourceIds: claimed.triggeringSourceIds,
        existingPromptedSourceRecords: claimed.promptedSourceRecords,
        telemetry: env,
        trigger,
      });
      if (!enqueued) {
        logger.warn({ epochId: claimed.id }, "Review-loop mention epoch enqueue claim was lost");
        return "skipped";
      }
      await markReviewLoopEpochProcessingIfPromptIsProcessing(env, {
        epochId: claimed.id,
        promptId: enqueueResult.payload.prompt.promptId,
        promptStatus: enqueueResult.payload.prompt.status,
        nowMs,
        logger,
      });
      return "enqueued";
    }

    await backfillReviewLoopTerminalSignals(env, claimed, token, nowMs, logger);

    // Drop feedback a PRIOR epoch on this PR already put in front of the agent, so this epoch — which
    // may have just been re-bootstrapped by new CI signals on a head Cycloid itself pushed — does not
    // re-answer already-handled review comments / issue comments / review bodies. #4795 resolves
    // replied review-comment threads (they leave the worklist as isResolved); this is the backstop for
    // the kinds with no resolve primitive (issue-comment / review-body) and for resolution failures.
    // Verification epochs are EXEMPT: their sole worklist item is synthesized from the STORED QA verdict
    // (ARC-1330 D-50A follow-up), so there is nothing GitHub-sourced to dedup against a prior epoch, and
    // deduping the synthetic item would suppress a genuinely new needs-work verdict. Re-drives are bounded
    // instead by the ARC-1407 no-new-evidence worklist-hash cap below.
    let excludePromptedSourceRecords: ReadonlyMap<string, number> | undefined;
    let excludePromptedSourceBodyHashes: ReadonlyMap<string, string> | undefined;
    let excludeSourceIds: ReadonlySet<string> | undefined;
    // Greptile P1 (#7827): when this lookup fails, `wasPrompted` below cannot be trusted — every
    // outdated thread would read as never-prompted and be stamped WITHOUT its in-thread note,
    // re-creating the silent disposal. Defer thread_outdated stamps to a later, healthy wave instead.
    let promptedSourceLookupFailed = false;
    if (!isVerificationEpoch(claimed)) {
      try {
        const promptedSources = await listPromptedReviewLoopSources(env.DB, {
          sessionId: claimed.sessionId,
          prUrl: claimed.prUrl,
          excludeEpochId: claimed.id,
        });
        excludePromptedSourceRecords = promptedSources.promptedAtBySourceId;
        excludePromptedSourceBodyHashes = promptedSources.bodyHashBySourceId;
        excludeSourceIds = promptedSources.legacySourceIds;
      } catch (error) {
        // Fail open: a transient D1 read failure degrades to the pre-dedup behavior rather than
        // dropping or blocking real work. Matches the bootstrap-path precedent and the
        // never-lose-un-prompted-feedback invariant.
        promptedSourceLookupFailed = true;
        logger.warn(
          { epochId: claimed.id, error: String(error) },
          "Review-loop dispatch dedup lookup failed; proceeding without it",
        );
      }
      // ARC-1226: when re-driving a truncated epoch (it still owes a carried-forward tail), also
      // exclude THIS epoch's own already-prompted items from the worklist so the carried tail fits in
      // the freed body budget — otherwise the same head-of-list items re-consume the 64KB budget and
      // the tail drops on every wave (no convergence). The dedup union (listPromptedReviewLoopSources)
      // deliberately omits the dispatching epoch's own ids; for the drain re-drive we add them back
      // from the in-memory claimed row, so this holds even if the lookup above failed open.
      if ((claimed.carriedForwardSourceIds?.length ?? 0) > 0) {
        const selfRecordedIds = new Set((claimed.promptedSourceRecords ?? []).map((record) => record.sourceId));
        const selfPrompted = accumulatePromptedSourceRecords({
          records: claimed.promptedSourceRecords ?? [],
          legacySourceIds: (claimed.promptedSourceIds ?? []).filter((sourceId) => !selfRecordedIds.has(sourceId)),
        });
        const records = new Map<string, number>(excludePromptedSourceRecords ?? []);
        const bodyHashes = new Map<string, string>(excludePromptedSourceBodyHashes ?? []);
        for (const [sourceId, promptedAtMs] of selfPrompted.promptedAtBySourceId) {
          const current = records.get(sourceId);
          if (current === undefined || promptedAtMs > current) {
            records.set(sourceId, promptedAtMs);
            const bodyHash = selfPrompted.bodyHashBySourceId.get(sourceId);
            if (bodyHash) bodyHashes.set(sourceId, bodyHash);
            else bodyHashes.delete(sourceId);
          }
        }
        excludePromptedSourceRecords = records;
        excludePromptedSourceBodyHashes = bodyHashes;
        excludeSourceIds = new Set([...(excludeSourceIds ?? []), ...selfPrompted.legacySourceIds]);
      }
    }

    // A4 single-intake: the managed QA comment (restored by #6939) is admitted through the reviewer-ingest
    // gate as `known:cycloid-qa`, so a verification epoch's worklist is sourced from that comment like any
    // other reviewer's — no synthetic verdict item is threaded here (that path was removed to guarantee the
    // verdict is intaken exactly once).
    // Reached only after the `isCiEpoch(claimed)` branch returned, so this is a review epoch — narrow
    // the kind to bot/human/mixed/verification explicitly.
    const epochSourceKind = reviewSourceKind(claimed);
    // Fence Cycloid's own review-loop replies out of the rebuilt worklist so a human thread it already
    // replied to (with no code change) is not re-answered every sweep as if the reply were new reviewer
    // feedback (PR #7119). Only human/mixed epochs build human-triggered threads (the bot path already
    // drops Cycloid-owned authors), so the read is skipped for bot/verification. Session-scoped; empty
    // for a PR with no prior replies.
    const selfReplyCommentIds =
      epochSourceKind === "human" || epochSourceKind === "mixed"
        ? await listReviewLoopReplyGithubIdsForSession(env.DB, claimed.sessionId)
        : undefined;
    let worklist;
    try {
      worklist = await getPrReviewLoopWorklist(token, claimed.repoOwner, claimed.repoName, claimed.prNumber, {
        expectedBots: claimed.expectedBots,
        sourceKind: epochSourceKind,
        triggeringSourceIds: claimed.triggeringSourceIds,
        excludePromptedSourceRecords,
        excludePromptedSourceBodyHashes,
        excludeSourceIds,
        excludeSelfReplyCommentIds: selfReplyCommentIds,
      });
    } catch (error) {
      return handleGithubPollFailure(error);
    }
    // Noise-gated and otherwise unpromptable rows were never added to `items`, so they will never be
    // prompted. Record each registered row as terminal informational (insert-or-convert-from-`none`, never
    // rewinding a real stamp) so it counts as handled in FSM `caught_up` accounting.
    const noiseGatedItems = worklist.noiseGatedItems ?? [];
    const allUnpromptableStamps = await buildUnpromptableInformationalStamps(env.DB, {
      sessionId: claimed.sessionId,
      prUrl: claimed.prUrl,
      worklist,
    });
    // With the prompted-source lookup failed, a previously-prompted outdated thread cannot be told
    // apart from a never-prompted one — stamping it now would silently dispose it without its note.
    // Leave thread_outdated rows undispositioned this wave; a later sweep (healthy lookup) posts the
    // note and stamps. All other bases carry no note and stamp as usual.
    const unpromptableStamps = promptedSourceLookupFailed
      ? allUnpromptableStamps.filter((stamp) => stamp.basis !== "thread_outdated")
      : allUnpromptableStamps;
    if (promptedSourceLookupFailed && unpromptableStamps.length < allUnpromptableStamps.length) {
      logger.warn(
        {
          epochId: claimed.id,
          sessionId: claimed.sessionId,
          deferredCount: allUnpromptableStamps.length - unpromptableStamps.length,
        },
        "Deferring thread_outdated stamps: prompted-source lookup failed, cannot decide note-worthiness",
      );
    }
    const informationalStamps = [
      ...noiseGatedItems.map((gated) => ({
        sessionId: claimed.sessionId,
        prUrl: claimed.prUrl,
        sourceId: gated.sourceId,
        basis: gated.reason,
      })),
      ...unpromptableStamps,
    ];
    // Visible-response backstop: a `thread_outdated` drop for an inline comment a PRIOR prompt already
    // put in front of the agent means the agent worked the feedback and its own push moved the
    // commented code (the verdict reply that would have said so is typically what got lost across the
    // head change). Silently disposing leaves the reviewer staring at an unanswered comment
    // (PR #7656), so post a terse in-thread note before the stamp. Once-per-thread across epochs AND
    // heads: the durable succeeded-reply guard below dedups on (session, PR, target) — the per-op
    // idempotency key alone includes epoch id + head, so a re-armed epoch or a carried-forward head
    // would otherwise mint a fresh op-id and re-post when the informational stamp write failed.
    // Best-effort: a GitHub failure is logged and never blocks the load-bearing stamp below.
    for (const stamp of unpromptableStamps) {
      if (stamp.basis !== "thread_outdated") continue;
      // One note per THREAD: an outdated thread stamps one entry PER COMMENT, and a reply to any
      // comment id lands in the same GitHub thread — acting on non-root entries would post the
      // identical note once per comment (ChatGPT P2 on #7827). Root-less entries (legacy shape)
      // keep per-comment behavior.
      if (stamp.threadRootSourceId !== undefined && stamp.threadRootSourceId !== stamp.sourceId) continue;
      const reviewCommentId = parseReviewLoopSourceNumericId(stamp.sourceId, "review-comment");
      if (reviewCommentId === null) continue;
      const wasPrompted =
        excludePromptedSourceRecords?.has(stamp.sourceId) === true || excludeSourceIds?.has(stamp.sourceId) === true;
      if (!wasPrompted) continue;
      try {
        const alreadyReplied = await hasSucceededReviewLoopReplyToTarget(env.DB, {
          sessionId: claimed.sessionId,
          prUrl: claimed.prUrl,
          targetSourceId: stamp.sourceId,
        });
        if (alreadyReplied) continue;
        const operationId = await buildReviewLoopReplyOperationId({
          epochId: claimed.id,
          headSha: claimed.headSha,
          targetSourceId: stamp.sourceId,
          opKind: "review_comment_reply",
        });
        const attempt = await beginReviewLoopOperationAttempt(env.DB, {
          operationId,
          epochId: claimed.id,
          sessionId: claimed.sessionId,
          promptId: claimed.lastPromptId ?? "outdated-backstop",
          kind: "reply",
          targetSourceId: stamp.sourceId,
          headSha: claimed.headSha,
          verdict: "replied",
          maxAttempts: 2,
          nowMs,
        });
        if (attempt.status !== "started") continue;
        const shortHead = claimed.headSha.slice(0, 7);
        const body = `Cycloid worked on this feedback and the commented code has since changed (thread outdated as of \`${shortHead}\`). If this still needs attention, mention @cycloid.`;
        const created = await createPrReviewCommentReply(
          token,
          claimed.repoOwner,
          claimed.repoName,
          claimed.prNumber,
          reviewCommentId,
          body,
        ).catch(async (error) => {
          await markReviewLoopOperationFailed(env.DB, operationId, {
            error: stringifyError(error),
            nowMs,
            expectedAttempts: attempt.operation.attempts,
          });
          logger.warn(
            {
              event: "review_loop_outdated_backstop_reply_failed",
              epochId: claimed.id,
              sessionId: claimed.sessionId,
              sourceId: stamp.sourceId,
              error: stringifyError(error),
            },
            "Review-loop outdated-thread backstop reply failed; stamping informational without a note",
          );
          return null;
        });
        if (!created) continue;
        await markReviewLoopOperationSucceeded(env.DB, operationId, {
          githubId: String(created.id),
          nowMs,
          expectedAttempts: attempt.operation.attempts,
        });
        logger.info(
          {
            event: "review_loop_outdated_backstop_reply_posted",
            epochId: claimed.id,
            sessionId: claimed.sessionId,
            sourceId: stamp.sourceId,
            githubCommentId: created.id,
          },
          "Posted an outdated-thread note for a previously-prompted comment before its informational stamp",
        );
      } catch (error) {
        logger.warn(
          {
            event: "review_loop_outdated_backstop_reply_failed",
            epochId: claimed.id,
            sessionId: claimed.sessionId,
            sourceId: stamp.sourceId,
            error: stringifyError(error),
          },
          "Review-loop outdated-thread backstop reply failed; stamping informational without a note",
        );
      }
    }
    if (informationalStamps.length > 0) {
      try {
        await stampInformationalDispositions(env.DB, informationalStamps, nowMs);
      } catch (error) {
        // The stamp is load-bearing for caught_up: if the FSM producer already registered this source
        // as `none`, leaving it unstamped keeps caught_up gated forever (the gated item is excluded from
        // every future prompt worklist, so no terminal disposition would ever land — the session wedges).
        // So DON'T complete the epoch on a stamp failure — defer it for a bounded retry (the transient
        // limit blocks it if the write keeps failing) so a later sweep re-stamps it. (D4)
        logger.warn(
          { epochId: claimed.id, prNumber: claimed.prNumber, error: stringifyError(error) },
          "Review-loop noise gate: informational disposition stamp failed; deferring epoch for retry",
        );
        const deferred = await deferClaimedEpochForTransientPollFailure(
          "noise_disposition_stamp_failed",
          stringifyError(error),
        );
        if (!deferred) return "skipped";
        return deferred.status === "blocked" ? "blocked" : "transient_deferred";
      }
      for (const gated of noiseGatedItems) {
        const bot = gated.bot.startsWith("known:") ? gated.bot.slice("known:".length) : gated.bot;
        await emitReviewLoopNoiseGatedEvent(env, {
          bot,
          reason: gated.reason,
          repo: `${claimed.repoOwner}/${claimed.repoName}`,
          ownerUserId: claimed.ownerUserId,
          sessionId: claimed.sessionId,
          prUrl: claimed.prUrl,
          sourceId: gated.sourceId,
        });
      }
    }
    // Near-miss telemetry (D4 sizing): known-bot outputs that matched a no-findings phrase but were
    // FORWARDED because residual survived — they ARE in the prompt worklist, so nothing changes for the
    // agent; we only record how often the deterministic gate fell short (the input that decides whether a
    // semantic tie-break is worth adding). Best-effort, off the dispatch decision — the emit never throws.
    for (const nearMiss of worklist.noiseNearMissItems ?? []) {
      const bot = nearMiss.bot.startsWith("known:") ? nearMiss.bot.slice("known:".length) : nearMiss.bot;
      await emitReviewLoopNoiseNearMissEvent(env, {
        bot,
        residualLength: nearMiss.residualLength,
        repo: `${claimed.repoOwner}/${claimed.repoName}`,
        ownerUserId: claimed.ownerUserId,
        sessionId: claimed.sessionId,
        prUrl: claimed.prUrl,
        sourceId: nearMiss.sourceId,
      });
    }
    if (worklist.droppedItemCount > 0) {
      logger.warn(
        {
          epochId: claimed.id,
          prNumber: claimed.prNumber,
          sourceKind: claimed.sourceKind,
          droppedItemCount: worklist.droppedItemCount,
          droppedBodyBytes: worklist.droppedBodyBytes,
          retainedItemCount: worklist.items.length,
        },
        "Review-loop worklist truncated by body budget; some feedback items were dropped",
      );
      // Surface the P0 failure class as a metric (the dropped items are carried forward and
      // re-dispatched, ARC-1226, but a sustained rate means PRs routinely exceed the single-wave
      // budget). Best-effort: the emitter swallows its own POST failures.
      await emitReviewLoopWorklistTruncatedMetric(env, {
        repo: `${claimed.repoOwner}/${claimed.repoName}`,
        ownerUserId: claimed.ownerUserId,
        sourceKind: claimed.sourceKind,
        droppedItemCount: worklist.droppedItemCount,
      });
    }
    if ((worklist.droppedHunkCount ?? 0) > 0) {
      logger.warn(
        {
          epochId: claimed.id,
          prNumber: claimed.prNumber,
          sourceKind: claimed.sourceKind,
          droppedHunkCount: worklist.droppedHunkCount,
          droppedHunkBytes: worklist.droppedHunkBytes,
          retainedItemCount: worklist.items.length,
        },
        "Review-loop worklist truncated by diff-hunk budget; some code anchors were dropped",
      );
    }
    if (worklist.items.length === 0) {
      if (isVerificationEpoch(claimed)) {
        // ARC-1330 D-50A follow-up — the verification-intake worklist is synthesized from the STORED QA
        // verdict (above), not the deleted managed QA comment. An empty worklist here therefore means NO
        // `needs-work` verdict is stored for this session/head — a contract violation, since V10 only
        // dispatches this epoch for an `app_breaks` verdict. Loud-block honestly (result-missing, never a
        // silent empty prompt) so the FSM's stamped `in_flight_epoch_id` is not stranded on a broken epoch.
        logger.warn(
          {
            epochId: claimed.id,
            prNumber: claimed.prNumber,
            triggeringSourceIds: claimed.triggeringSourceIds,
            worklistHash: worklist.worklistHash,
            verificationResult: session.verificationResult ?? null,
          },
          "Verification review-loop epoch found no stored QA verdict to dispatch",
        );
        await blockClaimedEpoch(
          "verification_result_missing",
          "Verification-intake epoch found no stored QA verdict to dispatch",
        );
        return "blocked";
      }
      // Bounded drain (ARC-1445 follow-up): the epoch.settled drain re-arms a fresh synthetic epoch
      // whenever undispositioned items no live epoch covers remain, so a registered item the rebuilt
      // worklist can never surface (e.g. a `human:<reviewId>` row whose canonical `review-body:` form
      // was already prompted and capped) spins dispatch → empty worklist → noop settle → re-arm forever
      // (~one wave every few seconds until PR close or the REVIEW deadline). After
      // REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP consecutive never-prompted empty settles over the same
      // triggering set, stamp the still-`none` triggering ids informational so the drain has no fuel
      // left. Mention epochs never trigger off registered dispositions — skip them.
      if (!isMentionEpoch(claimed) && claimed.lastPromptId === null && claimed.triggeringSourceIds.length > 0) {
        const priorNeeded = REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP - 1;
        const prior = await listRecentReviewLoopEpochDrainSummaries(env.DB, {
          sessionId: claimed.sessionId,
          prUrl: claimed.prUrl,
          excludeEpochId: claimed.id,
          limit: priorNeeded,
        });
        const triggeringKey = [...claimed.triggeringSourceIds].sort().join("\n");
        const drainRepeated =
          prior.length >= priorNeeded &&
          prior.every(
            (summary) =>
              summary.status === "completed" &&
              summary.lastPromptId === null &&
              [...summary.triggeringSourceIds].sort().join("\n") === triggeringKey,
          );
        if (drainRepeated) {
          const registeredNone = new Set(await listUndispositionedActionable(env.DB, claimed.sessionId, claimed.prUrl));
          // Stamp ONLY alias orphans: a `human:<reviewId>` registration whose canonical
          // `review-body:<reviewId>` row already carries a REAL disposition — the item WAS handled and
          // only the register/stamp namespace split left this row `none`. A row whose canonical form
          // is ALSO undispositioned (or absent) is genuinely-unserviced reviewer feedback; silently
          // stamping it informational would re-create the exact silent-disposal class this stack
          // removes, so leave it alone — the drain keeps cycling and the REVIEW deadline surfaces it
          // LOUDLY (review_stuck → NEEDS_YOU) instead of a quiet merge-ready.
          const dispositionBySourceId = new Map(
            (await listForPr(env.DB, claimed.sessionId, claimed.prUrl)).map((row) => [row.sourceId, row.disposition]),
          );
          const stamps = claimed.triggeringSourceIds
            .filter((sourceId) => {
              if (!registeredNone.has(sourceId)) return false;
              const submissionReviewId = parseReviewLoopSourceNumericId(sourceId, "human");
              if (submissionReviewId === null) return false;
              const canonicalDisposition = dispositionBySourceId.get(`review-body:${submissionReviewId}`);
              return canonicalDisposition !== undefined && canonicalDisposition !== "none";
            })
            .map((sourceId) => ({
              sessionId: claimed.sessionId,
              prUrl: claimed.prUrl,
              sourceId,
              basis: REVIEW_LOOP_DRAIN_NO_PROGRESS_BASIS,
            }));
          if (stamps.length > 0) {
            await stampInformationalDispositions(env.DB, stamps, nowMs);
            logger.warn(
              {
                event: "review_loop_drain_no_progress_capped",
                epochId: claimed.id,
                sessionId: claimed.sessionId,
                prUrl: claimed.prUrl,
                stampedSourceIds: stamps.map((stamp) => stamp.sourceId),
                consecutiveNoopSettles: REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP,
              },
              "Review-loop drain made no progress; stamped unservable items informational to stop the re-arm loop",
            );
          }
        }
      }
      await completeNoopEpochAndSettle({
        nowMs,
        worklistHash: worklist.worklistHash,
        expectedReservationToken: claimed.reservationToken,
        // Empty rebuilt worklist proves nothing is pending. Settle `completed` and CLEAR any stale
        // carried tail (e.g. carried comments resolved/deleted on GitHub) instead of re-driving off
        // the stale column forever. ARC-1226.
        clearCarryForward: true,
        telemetry: epochTelemetry(),
      });
      return "completed_noop";
    }

    // ARC-1407: don't blindly re-prompt the SAME evidence. worklist_hash canonicalizes the worklist
    // (source-ids + bodies + resolved/outdated state) and is preserved across the reclaim + no-diff
    // re-drive, so an unchanged hash proves nothing new arrived since the last dispatch. Past the
    // one-retry budget, block with a distinct terminal "needs human" reason instead of churning to the
    // generic attempt cap. CI epochs never reach here (the isCiEpoch branch above returns), so this is
    // review-epoch only. attempt_count is post-increment at claim and decremented by deferrals, so this
    // cap fires no earlier than the one-retry point and is bounded above by REVIEW_LOOP_ATTEMPT_CAP.
    if (
      claimed.worklistHash !== null &&
      worklist.worklistHash === claimed.worklistHash &&
      claimed.attemptCount >= REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_ATTEMPTS
    ) {
      await blockClaimedEpoch(
        REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_REASON,
        `No new evidence since the last prompt (worklist_hash ${worklist.worklistHash}) after ${claimed.attemptCount} attempts`,
      );
      logger.warn(
        {
          event: "review_loop_no_new_evidence_reprompt_cap",
          epochId: claimed.id,
          sessionId: claimed.sessionId,
          worklistHash: worklist.worklistHash,
          attemptCount: claimed.attemptCount,
        },
        "Review-loop epoch blocked: re-prompt with no new evidence past the one-retry budget (ARC-1407)",
      );
      return "blocked";
    }

    const promptArgs = {
      epochId: claimed.id,
      repoUrl: `https://github.com/${claimed.repoOwner}/${claimed.repoName}`,
      prUrl: claimed.prUrl,
      prNumber: claimed.prNumber,
      headSha: claimed.headSha,
      worklistItems: worklist.items,
      duplicateGroups: worklist.duplicateGroups,
      timedOutBotKeys: claimed.timedOutBotKeys,
    };
    // LLM triage first (RLA v2 work item D); the per-kind deterministic builders are the
    // fail-open fallback (heuristic worklist forwarded whole, nothing dropped).
    const triage = await triageReviewLoopWorklist(env, {
      sessionId: claimed.sessionId,
      epochId: claimed.id,
      ownerUserId: claimed.ownerUserId,
      repoOwner: claimed.repoOwner,
      repoName: claimed.repoName,
      prNumber: claimed.prNumber,
      headSha: claimed.headSha,
      candidates: reviewLoopTriageCandidatesFromWorklistItems(worklist.items, "comment"),
      logger,
    });
    let usedTriage: UsedReviewLoopTriage | null = triage.ok ? triage : null;
    if (usedTriage) {
      try {
        await markTriageDroppedItemsDeclined({
          db: env.DB,
          epoch: claimed,
          triage: usedTriage,
          duplicateGroups: worklist.duplicateGroups,
          nowMs,
        });
      } catch (error) {
        logger.warn(
          { epochId: claimed.id, error: String(error) },
          "Review-loop triage drop disposition failed; falling back to full worklist",
        );
        usedTriage = null;
      }
    }
    const promptedSourceIds = usedTriage
      ? promptedSourceIdsForTriage(usedTriage, worklist.duplicateGroups)
      : [
          ...worklist.items.map((item) => item.sourceId),
          ...worklist.duplicateGroups.flatMap((group) => group.duplicateSourceIds),
        ];
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    const prompt = usedTriage
      ? buildGithubPrReviewLoopTriagedPrompt({
          ...promptArgs,
          actionItems: usedTriage.actionItems,
          // Surface triage-detected conflicting feedback so the agent picks one with an explanation
          // (or escalates to the owner) instead of guessing; empty in the common no-conflict case.
          conflicts: usedTriage.conflicts,
          // Keep the verification framing when a QTA needs-work verdict is triaged successfully —
          // otherwise the triaged renderer reframes it as routine bot feedback.
          // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
          verificationContext: claimed.sourceKind === "verification",
        })
      : claimed.sourceKind === "bot"
        ? buildGithubPrReviewLoopPrompt(promptArgs)
        : claimed.sourceKind === "verification"
          ? buildGithubPrReviewLoopVerificationPrompt(promptArgs)
          : buildGithubPrReviewLoopHumanPrompt(promptArgs);
    // The prompt-metadata source kind drives bridge tool gating. Verification (and mixed) map to
    // "mixed" DELIBERATELY: that unlocks cycloid.review_summary_comment so every verification /
    // review cycle can post one summary comment on the PR — intended product behavior, not an
    // accidental fallthrough. The epoch row keeps its real sourceKind 'verification' (same pattern
    // as CI epochs enqueueing as "mixed"). Do not narrow this without removing per-cycle summaries.
    const promptMetadataSourceKind: "bot" | "human" | "mixed" =
      claimed.sourceKind === "bot" ? "bot" : claimed.sourceKind === "human" ? "human" : "mixed";
    // Human-facing summary shown in place of the agent-machinery prompt. The summary builder only
    // accepts "human" | "bot" | "verification"; the non-CI branch reaches here for those plus "mixed"
    // (CI / merge-conflict are handled earlier), so narrow anything else to "human".
    const summarySourceKind: "human" | "bot" | "verification" =
      claimed.sourceKind === "bot" || claimed.sourceKind === "verification" ? claimed.sourceKind : "human";
    const displaySummary = usedTriage
      ? buildReviewLoopHumanSummary({
          kind: "triaged",
          sourceKind: summarySourceKind,
          actionItems: usedTriage.actionItems,
          // Pass the full worklist so each triaged action item can link back to its source comment(s).
          worklistItems: worklist.items,
        })
      : buildReviewLoopHumanSummary({
          kind: "worklist",
          sourceKind: summarySourceKind,
          items: worklist.items,
        });
    await prewarmBeforeEnqueue();
    const enqueueResult = await enqueueSessionPrompt(env, claimed.sessionId, prompt, String(claimed.ownerUserId), {
      reviewLoopEpochId: claimed.id,
      reviewLoopSourceKind: promptMetadataSourceKind,
      replyToText: displaySummary,
    });
    if (!enqueueResult.ok || !enqueueResult.payload) {
      return handleReviewLoopPromptEnqueueFailure(enqueueResult, {
        deferForContention: deferClaimedEpochForContention,
        deferForTransientPollFailure: deferClaimedEpochForTransientPollFailure,
        block: blockClaimedEpoch,
        // Duplicate-epoch reject: the DO already holds a prompt for this epoch (a
        // prior sweep crashed before marking it enqueued). Adopt that prompt rather
        // than block — blocking would strand a live agent run.
        adoptExistingPrompt: (existing) =>
          adoptExistingReviewLoopEpochPrompt(env, {
            epochId: claimed.id,
            reservationToken: claimed.reservationToken,
            existingPromptId: existing.existingPromptId,
            existingPromptStatus: existing.existingPromptStatus,
            worklistHash: worklist.worklistHash,
            promptedSourceIds,
            promptedSourceBodyHashes: reviewBodyHashesFromWorklistItems(worklist),
            existingPromptedSourceRecords: claimed.promptedSourceRecords,
            carriedForwardSourceIds: worklist.droppedSourceIds ?? [],
            nowMs,
            logger,
          }),
      });
    }

    const enqueued = await markReviewLoopEpochEnqueued(env.DB, claimed.id, {
      promptId: enqueueResult.payload.prompt.promptId,
      worklistHash: worklist.worklistHash,
      nowMs,
      expectedReservationToken: claimed.reservationToken,
      // Everything this prompt covers. On triage success this is only the kept action-item sources
      // plus their duplicate-group members; triage-dropped noise is dispositioned above, not prompted.
      promptedSourceIds,
      promptedSourceBodyHashes: reviewBodyHashesFromWorklistItems(worklist),
      existingPromptedSourceRecords: claimed.promptedSourceRecords,
      // ARC-1226: feedback the body budget dropped, recorded un-prompted so the settle path re-drives
      // this epoch and the next sweep dispatches the tail. Recomputed every dispatch (empty clears it).
      carriedForwardSourceIds: worklist.droppedSourceIds ?? [],
      telemetry: env,
      trigger,
    });
    if (!enqueued) {
      logger.warn({ epochId: claimed.id }, "Review-loop epoch enqueue claim was lost");
      return "skipped";
    }
    // An idle review-listening session promotes the new prompt straight to "processing" and
    // fires the epoch processing transition from inside the enqueue RPC — before this epoch is
    // marked "enqueued" above. That premature transition no-ops against the still-"reserving"
    // epoch, so without this the epoch stays "enqueued" forever and review_loop_reply is rejected
    // with "epoch is not active for this prompt (enqueued)". Drive it now that the prompt is
    // already processing; it is a harmless no-op if the DO's transition happened to win the race.
    await markReviewLoopEpochProcessingIfPromptIsProcessing(env, {
      epochId: claimed.id,
      promptId: enqueueResult.payload.prompt.promptId,
      promptStatus: enqueueResult.payload.prompt.status,
      nowMs,
      logger,
    });
    return "enqueued";
  } catch (error) {
    if (error instanceof PostSideEffectBlockFailure) {
      logger.warn(
        { epochId: claimed.id, error: String(error.originalError) },
        "Review-loop epoch sweep failed after side effect",
      );
      await blockClaimedEpoch("sweep_failed", String(error.originalError));
      return "blocked";
    }
    if (isTransientD1StorageError(error)) {
      logger.warn(
        { epochId: claimed.id, transientError: String(error) },
        "Review-loop epoch dispatch deferred on transient D1 error",
      );
      const deferred = await deferClaimedEpochForTransientPollFailure("transient_d1_error", String(error));
      if (!deferred) return "skipped";
      return deferred.status === "blocked" ? "blocked" : "transient_deferred";
    }
    // A Durable Object / subrequest call in this dispatch (e.g. enqueueSessionPrompt) can fail with a
    // bare Cloudflare `internal error; reference = <id>` platform blip. It succeeds on a later attempt,
    // so defer with the same bounded retry as the D1 case rather than permanently blocking the epoch and
    // stranding the review loop. `transientError`-keyed (not `error`-keyed) so a transient blip does not
    // page Sentry; a persistent fault still blocks once the retry limit is crossed.
    if (isTransientDurableObjectInternalError(error)) {
      logger.warn(
        { epochId: claimed.id, transientError: String(error) },
        "Review-loop epoch dispatch deferred on transient Cloudflare DO fault",
      );
      const deferred = await deferClaimedEpochForTransientPollFailure("transient_do_internal_error", String(error));
      if (!deferred) return "skipped";
      return deferred.status === "blocked" ? "blocked" : "transient_deferred";
    }
    logger.warn({ epochId: claimed.id, error: String(error) }, "Review-loop epoch sweep failed");
    await blockClaimedEpoch("sweep_failed", String(error));
    return "blocked";
  }
}

/**
 * Thin cron-path wrapper over `dispatchReviewLoopEpoch`: the scheduled sweep drives each due epoch
 * through the shared orchestration with no `trigger` tag (unchanged dispatch telemetry). Kept as a
 * named seam so the sweep loop + its per-status result tallying read unchanged (ARC-1330 Phase B B3).
 */
async function processEpoch(
  env: Env,
  epoch: ReviewLoopEpoch,
  nowMs: number,
  logger: Logger,
  prefetchInputs: ReviewLoopChecklistPrefetchInputs | undefined,
): Promise<ProcessEpochResult> {
  return dispatchReviewLoopEpoch(env, epoch, { nowMs, logger, prefetchInputs });
}

/**
 * Recovery for CI failures that completed BEFORE the session armed review-listening (or before the
 * head was reconciled here). The only place a ci-fix epoch is otherwise created is the live
 * `check_run` webhook (ingestReviewLoopCiFailureWebhook), which is dropped with
 * `no_review_listening_session` if it arrives before listening arms — and nothing else recovers it
 * (bootstrapReviewLoopEpochFromHeadSignals only bootstraps configured review-bot signals, never an
 * Actions CI failure). So when reconcile confirms a session is listening on `headSha`, poll the
 * head's check runs and bootstrap a ci-fix epoch for each FAILING, completed check
 * (`isFailingCheckRun`), building the ingest input EXACTLY as the live webhook does so a later live
 * `check_run` webhook for the same check dedupes against the same sentinel row (the upsert is
 * idempotent on the `ci-check:<id>:<pr>` sourceId — no duplicate epoch). Pending/in-progress checks
 * are skipped (isFailingCheckRun requires status === "completed"). Attempt caps / escalation are
 * enforced downstream by processEpoch and are not bypassed here.
 *
 * ARC-1330 (PR 48): NOT demoted — the tech spec assumed the FSM ciFix loop would own
 * this decision, but epoch CREATION stayed legacy-owned (the FSM's own ciFix `dispatch_epoch` commits
 * synthetic ids the live sink skips as `epoch_row_not_materialized_legacy_owns_dispatch`); see the
 * ownership map at `runReviewLoopSweep`.
 */
async function recoverFailingCiChecksForHead(
  env: Env,
  options: {
    checkRuns: CommitCheckRun[];
    repoOwner: string;
    repoName: string;
    prNumber: number;
    prUrl: string;
    headSha: string;
    logger: Logger;
  },
): Promise<number> {
  let recovered = 0;
  for (const run of options.checkRuns) {
    if (!isFailingCheckRun(run)) continue;
    // Mirror webhooks/github.ts check_run actor derivation: the producing app's slug is the actor;
    // there is no live `sender` here, so fall back to null (same as backfillReviewLoopTerminalSignals).
    const actorLogin = run.appSlug ? `${run.appSlug}[bot]` : null;
    const actorType = run.appSlug ? "Bot" : "";
    // Skip Cycloid-owned checks (e.g. the `[ARC]` PR-title check): they are our own, not third-party
    // CI the code-editing loop can fix. Mirrors the live check_run webhook's cycloid-owned-sender
    // skip (webhooks/github.ts) so recovery and the live path agree.
    if (actorLogin && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(actorLogin))) {
      continue;
    }
    try {
      const result = await ingestReviewLoopCiFailureWebhook({
        env,
        deliveryId: null,
        // Same sourceId scheme as the live check_run webhook so the idempotent upsert dedupes.
        sourceId: `ci-check:${run.id}:${options.prNumber}`,
        checkRunId: run.id,
        checkRunName: run.name,
        checkRunConclusion: run.conclusion,
        actorLogin,
        actorType,
        repoOwner: options.repoOwner,
        repoName: options.repoName,
        prNumber: options.prNumber,
        prUrl: options.prUrl,
        headSha: options.headSha,
      });
      if (result.status === "handled") recovered += 1;
    } catch (error) {
      options.logger.warn(
        { prUrl: options.prUrl, headSha: options.headSha, checkRunId: run.id, error: String(error) },
        "Review-loop CI-failure recovery ingest failed",
      );
    }
  }
  return recovered;
}

// PR-E1: the `review-loop:*` label constants are SCRAPPED. `REVIEW_LOOP_LABEL_META` /
// `RECONCILED_REVIEW_LOOP_LABELS` / `clearReviewLoopLabels` (the blunt legacy strip) are deleted with them —
// the canonical `labelsOf(record)` reconcile (`fsm-label-sync.ts`) is the sole label writer, and its managed
// strip set (`FSM_MANAGED_LABELS`) still carries the legacy strings as inline literals so in-flight PRs get
// torn down on the normal sweep sync.

async function reconcileReviewListeningSessions(
  env: Env,
  options: {
    nowMs: number;
    limit: number;
    logger: Logger;
    /** PR 47: the scheduled tick's ExecutionContext seam — live FSM side-effects defer through it. */
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<
  Pick<
    ReviewLoopSweepResult,
    | "reviewListeningAttempted"
    | "reviewListeningClosed"
    | "reviewListeningHeadChanged"
    | "reviewListeningStaleEpochsBlocked"
    | "reviewListeningEpochsBootstrapped"
    | "reviewListeningCiChecksRecovered"
    | "reviewListeningVerificationIntakes"
    | "reviewListeningMergeConflictIntakes"
    | "reviewListeningRebaseBlocked"
    | "reviewListeningBranchUpdated"
    | "reviewListeningCarriedForward"
    | "reviewListeningTruncatedTailRekeyed"
    | "reviewListeningRefsHealed"
    | "reviewListeningErrors"
  >
> {
  const result = {
    reviewListeningAttempted: 0,
    reviewListeningClosed: 0,
    reviewListeningHeadChanged: 0,
    reviewListeningStaleEpochsBlocked: 0,
    reviewListeningEpochsBootstrapped: 0,
    reviewListeningCiChecksRecovered: 0,
    reviewListeningVerificationIntakes: 0,
    reviewListeningMergeConflictIntakes: 0,
    reviewListeningRebaseBlocked: 0,
    reviewListeningBranchUpdated: 0,
    reviewListeningCarriedForward: 0,
    reviewListeningTruncatedTailRekeyed: 0,
    reviewListeningRefsHealed: 0,
    reviewListeningErrors: 0,
  };
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (result.reviewListeningAttempted < options.limit) {
    const remainingLimit = options.limit - result.reviewListeningAttempted;
    const page = await listReviewListeningGithubPrRefs(env.DB, {
      limit: remainingLimit,
      cursor,
      sweptBefore: options.nowMs,
    });
    result.reviewListeningAttempted += page.data.length;
    const prefetchInputsByRepo = await prefetchReviewLoopChecklistInputsByRepo(
      env,
      page.data.flatMap((ref) => {
        const parsed = parseGithubPrUrl(ref.prUrl);
        const ownerUserId = ref.ownerUserId;
        return parsed && ownerUserId !== null && Number.isSafeInteger(ownerUserId) && ownerUserId > 0
          ? [
              {
                ownerUserId,
                repoOwner: parsed.owner,
                repoName: parsed.repo,
              },
            ]
          : [];
      }),
    );

    // Bump the rotation watermark for the whole fetched page BEFORE processing: refs the loop below
    // skips (or a mid-tick crash) must still rotate to the back of the queue, otherwise no-op refs
    // pin the queue head and starve every newer ref out of the per-tick budget forever.
    if (page.data.length > 0) {
      try {
        await markReviewListeningGithubPrRefsSwept(env.DB, page.data, options.nowMs);
      } catch (error) {
        options.logger.warn({ error: String(error) }, "Review-loop reconciliation swept-at bump failed");
      }
    }

    for (const ref of page.data) {
      // Removes a ref the sweep can never act on again (session gone/archived, listening over, or the
      // session listens on a different PR), so it stops qualifying for sweep pages and webhook fanout.
      // Listening re-activation re-upserts the ref, so deletion is safe. Best-effort: on failure the
      // watermark bump above still rotates the ref to the back of the queue.
      const healRef = async (reason: string): Promise<void> => {
        try {
          await deleteSessionWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, ref.prUrl, ref.sessionId);
          result.reviewListeningRefsHealed += 1;
          options.logger.info(
            { sessionId: ref.sessionId, prUrl: ref.prUrl, reason },
            "Review-loop reconciliation removed dead webhook ref",
          );
        } catch (error) {
          options.logger.warn(
            { sessionId: ref.sessionId, prUrl: ref.prUrl, reason, error: String(error) },
            "Review-loop reconciliation dead-ref removal failed",
          );
        }
      };
      try {
        const session = await getSessionState(env, ref.sessionId);
        if (!session) {
          await healRef("session_not_found");
          continue;
        }
        if (session.status === "archived") {
          await healRef("session_archived");
          continue;
        }
        if (!session.reviewListeningActive) {
          await healRef("review_listening_inactive");
          continue;
        }
        const prUrl = session.reviewListeningPrUrl ?? ref.prUrl;
        if (!prUrl || prUrl !== ref.prUrl) {
          await healRef("pr_url_mismatch");
          continue;
        }
        const parsed = parseGithubPrUrl(prUrl);
        if (!parsed) {
          options.logger.warn({ sessionId: ref.sessionId, prUrl }, "Review-loop reconciliation skipped invalid PR URL");
          result.reviewListeningErrors += 1;
          continue;
        }
        const prefetchInputs = prefetchInputsByRepo.get(
          reviewLoopRepoGroupKey({ repoOwner: parsed.owner, repoName: parsed.repo }),
        );
        const installationId = session.installationId;
        if (typeof installationId !== "number") {
          options.logger.warn(
            { sessionId: ref.sessionId, prUrl },
            "Review-loop reconciliation skipped missing installation",
          );
          result.reviewListeningErrors += 1;
          continue;
        }

        const token = await createInstallationToken(env, installationId);
        // One Get-a-PR read for state + head + mergeability, instead of separate getPrState +
        // getPrHeadSha round-trips. mergeable_state is only populated by this single-PR endpoint.
        const mergeStatus = await getPrMergeStatus(token, parsed.owner, parsed.repo, parsed.prNumber);
        const prState = mergeStatus.state;
        if (prState === "merged" || prState === "closed") {
          // ARC-1330 (PR 43) SHADOW: dual-emit the cron-observed PR terminal onto the FSM spine (the
          // dropped-`pull_request.closed`-webhook backstop). Best-effort/try-caught OFF this legacy
          // close path — a shadow fault never blocks the merge-notify/close below. Sibling call only;
          // the poll itself is untouched.
          await shadowEmitCronPrTerminal(env, ref.sessionId, prState, options.logger, options.waitUntil);
          if (prState === "merged") {
            try {
              const notifyResult = await notifySessionPrMerged(env, ref.sessionId, prUrl);
              if (!notifyResult.ok) {
                options.logger.warn(
                  { sessionId: ref.sessionId, prUrl, status: notifyResult.status },
                  "Review-loop reconciliation PR-merged notification failed",
                );
              }
            } catch (error) {
              options.logger.warn(
                { sessionId: ref.sessionId, prUrl, error: String(error) },
                "Review-loop reconciliation PR-merged notification threw",
              );
            }
          }
          // Clear the managed labels before close (best-effort, never block the close; purely
          // cosmetic — close does not depend on labels).
          //
          // ARC-1330 (W11-P2) LIVE CUTOVER — the canonical writer reconciles off
          // the spine row, which the awaited `shadowEmitCronPrTerminal` above has just committed to
          // MERGED/CLOSED: `labelsOf(terminal record)` is the EMPTY managed set, so the reconcile
          // strips the FULL managed namespace — including the verification-* labels the legacy clear
          // never touched (they could linger on merged PRs once writer #1 stood down). If the terminal
          // emit failed (it is try-caught) the reconcile reflects the pre-terminal state — same
          // best-effort cosmetics as the legacy clear, and the label parity metric surfaces any stuck
          // shape.
          await syncFsmLabelsForPr(env, {
            prUrl,
            sessionId: ref.sessionId,
            installationId,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            tokenHint: token,
            logger: options.logger,
          });
          const closeResult = await closeSessionForWebhook(env, env.DB, ref.sessionId, {
            reason: prState === "merged" ? "pr_merged" : "pr_closed",
            metadata: {
              closeSource: "review_loop_reconciliation",
              prState,
              prUrl,
              prNumber: parsed.prNumber,
            },
          });
          if (closeResult.closed) result.reviewListeningClosed += 1;
          continue;
        }
        if (prState !== "open") {
          options.logger.warn(
            { sessionId: ref.sessionId, prUrl },
            "Review-loop reconciliation could not read PR state",
          );
          result.reviewListeningErrors += 1;
          continue;
        }

        // Read-only QA/review sessions stay review-listening only for the PR merged/closed cleanup above;
        // review-loop work (head tracking, branch updates, CI recovery, epoch bootstrap, done
        // rollup) belongs to the implementation session's ref for the same PR.
        if (isReadOnlyAgentRole(session.agentRole)) continue;

        // RLA pause: while a verification run is in progress for this PR, defer everything past
        // the merged/closed cleanup above — no head tracking, branch updates, CI recovery, done
        // rollup, or epoch bootstrap. Webhook ingest keeps recording into epochs while paused;
        // the ref rotates (watermark already bumped) and is re-evaluated next tick.
        if (session.verificationState === "verification-in-progress") {
          options.logger.info(
            { sessionId: ref.sessionId, prUrl },
            "Review-loop reconciliation deferred: verification in progress",
          );
          continue;
        }

        const currentHeadSha = mergeStatus.headSha;
        if (!currentHeadSha) {
          options.logger.warn({ sessionId: ref.sessionId, prUrl }, "Review-loop reconciliation could not read PR head");
          result.reviewListeningErrors += 1;
          continue;
        }
        const previousHeadSha =
          typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha : "";
        // Tracks whether the head moved this tick. A head change resets done-state to "working" and
        // then FALLS THROUGH to the new-head bootstrap below (checklist + epoch-kind query + CI
        // recovery + bot bootstrap all run on the new head this same tick). We only skip the settled
        // done-eval on a head-change tick (the new-head epochs have not settled yet, so the rollup
        // would be premature); the reset above already cleared any stale prior-head done claim.
        let headChangedThisTick = false;
        if (previousHeadSha !== currentHeadSha) {
          // ARC-1330 (W11): the sweep-observed head advance is DUAL-EMITTED onto the spine below (before any
          // label teardown) as head.changed / head.noop_changed. Defaults to a real change; set to the
          // content-noop determination the verdict-preservation tree compare computes when a settled verdict
          // is present (a null-verdict advance stays head.changed — behaviorally faithful, see head-producer),
          // mirroring the synchronize-webhook producer.
          let shadowIsContentNoop = false;
          if (previousHeadSha.length > 0) {
            // Carry our own base-merge forward, else stale-block (see reconcileReviewLoopEpochsForHeadChange).
            // Shared with the `synchronize` webhook so the two head-change paths cannot drift (ARC-1245).
            const epochResult = await reconcileReviewLoopEpochsForHeadChange(env.DB, {
              sessionId: ref.sessionId,
              prUrl,
              previousHeadSha,
              currentHeadSha,
              nowMs: options.nowMs,
              logger: options.logger,
            });
            result.reviewListeningCarriedForward += epochResult.carriedForward;
            result.reviewListeningStaleEpochsBlocked += epochResult.staleBlocked;
            result.reviewListeningTruncatedTailRekeyed += epochResult.truncatedRekeyed;
            await emitReviewLoopTruncatedTailRekeyedMetric(env, {
              repo: parsed.repo,
              ownerUserId: ref.ownerUserId ?? 0,
              rekeyed: epochResult.truncatedRekeyed,
            });
          }
          const updateResult = await updateSessionReviewListeningHead(env, ref.sessionId, { prUrl, currentHeadSha });
          if (!updateResult.ok) {
            options.logger.warn(
              { sessionId: ref.sessionId, prUrl, status: updateResult.status },
              "Review-loop reconciliation head update failed",
            );
            result.reviewListeningErrors += 1;
            continue;
          }
          // `updated: false` means another writer (the synchronize webhook) already advanced the stored
          // head for this PR — mirrors the webhook precedent's `shadowHeadAdvanced` gate. The spine emit
          // and the live reproject below MUST be gated on this, else the webhook+sweep race double-emits
          // `head.changed` for an already-advanced head, re-clearing a verdict recorded in between
          // (adversarial-review finding on #6525).
          const headUpdateAccepted = updateResult.payload?.updated !== false;
          if (headUpdateAccepted) result.reviewListeningHeadChanged += 1;
          // Head moved this tick → the loop is working again on the new head. Clear any stale prior-head
          // labels below so a CI-poll failure on a later tick cannot leave a stale done/CI label standing.
          // Then FALL THROUGH to the new-head bootstrap (do NOT continue) — only the settled ci-signal emit
          // is skipped this tick via headChangedThisTick.
          //
          // ARC-1330 D-59a: the legacy head-change done-state reset (setSessionReviewLoopDoneState →
          // "working") is deleted with the rest of the cron done-state decision sites. The FSM owns the
          // head-change reset at live via the `head.changed` edge (advance_head).
          // A verification verdict is session-level and otherwise only reset at the next run's start.
          //
          // ARC-1330 D-59 RESIDUE FOLD: the standalone DB clear/stamp of the prior-head verdict is DELETED
          // here — like the synchronize webhook, the sweep routes its head advance through
          // `shadowEmitHeadChange` (below), whose `syncLegacyVerificationStoreForHeadChange` maintains the
          // session verificationState/Result/VerdictHeadSha store at live (clear-on-real / restamp-on-noop),
          // so the standalone writers are redundant. The fold is merge-gated on the live flip.
          //
          // The IN-MEMORY clear STAYS: the producer helper persists the DB clear but does NOT mutate this
          // tick's in-memory `session`, and the same-tick needs-work read below (`needsWorkVerdict`, which
          // gates the D-59a stand-down parity sample) must not act on the verdict we just discarded. The
          // classifier (`shadowIsContentNoop`) is computed identically to pre-fold and only feeds the emit.
          if (session.verificationState != null || session.verificationResult != null) {
            // A content no-op head advance (same tree SHA: rebase/reword/no-op force-push) has nothing new
            // to verify — classify it so the FSM `head.noop_changed` edge PRESERVES the verdict (ARC-1243
            // scheduler skip). isNoOpHeadTreeChange fails open (false) on any read failure, so a real content
            // change — or an unresolvable prior commit — classifies as `head.changed` and re-verifies.
            // (In-progress is already deferred above, so the verdict here is settled.) Reused as the spine
            // head classifier below — no extra GitHub read (the shadow phase must not add rate-limit cost).
            const noOpHeadChange =
              previousHeadSha.length > 0 &&
              (await isNoOpHeadTreeChange(token, parsed.owner, parsed.repo, previousHeadSha, currentHeadSha));
            shadowIsContentNoop = noOpHeadChange;
            if (!noOpHeadChange) {
              // In-memory only: keep the same-tick needs-work read below from re-firing on a discarded
              // verdict. The DB clear is performed by the producer helper in `shadowEmitHeadChange`.
              session.verificationState = null;
              session.verificationResult = null;
              session.verificationNeedsWorkLabel = null;
            }
          }
          // ARC-1330 (W11) — DUAL-EMIT the sweep-observed head advance onto the spine BEFORE any label
          // teardown. Unlike the synchronize webhook, the sweep had no head producer, so the spine row still
          // carried the OLD head here; reprojecting labels off it would strip from a STALE record (the D-59b
          // blocker). classifyHeadChange picks head.noop_changed for a content-noop advance (advance +
          // restamp → the verdict-derived label survives) vs head.changed (advance + set_code_changed +
          // clear_verification → REVIEW strips the stale managed labels). Awaited, so the CAS commit lands
          // before the canonical reconcile reads the row; try-caught OFF the legacy critical path (a shadow
          // fault never perturbs the sweep). Effects defer through the tick's waitUntil.
          let spineHeadCommitted = false;
          if (headUpdateAccepted) {
            spineHeadCommitted = await shadowEmitHeadChange(
              env,
              ref.sessionId,
              classifyHeadChange({
                headSha: currentHeadSha,
                prevHeadSha: previousHeadSha.length > 0 ? previousHeadSha : null,
                isContentNoop: shadowIsContentNoop,
              }),
              options.logger,
              options.waitUntil,
            );
          }
          // Clear all review-loop labels: a CI label can be present even when the prior done-state was
          // "working" or null, so an unconditional strip is required (gating on prior-done-state would strand
          // it).
          //
          // ARC-1330 (W11-P2) LIVE CUTOVER — the blunt legacy strip stands down and the
          // canonical writer reconciles off the now-committed spine row: head.changed cleared the verdict →
          // REVIEW → labelsOf strips the stale managed labels, while a head.noop_changed PRESERVED the verdict
          // and its label — a correctness gain over the always-strip legacy clear. A stale-head reproject is
          // impossible because the emit above committed the fresh head first. Legacy clear stays for
          // shadow/off (superseded, deleted in D-59). Best-effort (allSettled + logs its own rejections); the
          // periodic sweep reconcile self-heals either way.
          // When the head update was NOT accepted (webhook won the race), the webhook path already
          // emitted and reprojected off the fresh spine row — the emit above was skipped, so skip
          // the reconcile too rather than reproject redundantly.
          if (spineHeadCommitted) {
            await syncFsmLabelsForPr(env, {
              prUrl,
              sessionId: ref.sessionId,
              installationId,
              repoOwner: parsed.owner,
              repoName: parsed.repo,
              tokenHint: token,
              logger: options.logger,
            });
          }
          // PR-E1: the stale-row `else if (headUpdateAccepted)` fallback (a blunt `clearReviewLoopLabels`
          // strip) is deleted with the scrapped review-loop labels. Post-scrap REVIEW projects no managed
          // label, so a stale spine row can no longer strand a done/verification label; the next sweep's
          // `syncFsmLabelsForPr` self-heals any legacy leftover from `FSM_MANAGED_LABELS`.
          headChangedThisTick = true;
        }

        const ownerUserId = Number(session.ownerUserId);
        const hasValidOwnerUserId = Number.isSafeInteger(ownerUserId) && ownerUserId > 0;

        // Mergeability: when enabled for this repo, start a dedicated merge-conflict resolution epoch.
        // Otherwise preserve the existing conservative behavior: surface the conflict and pause pending
        // review-loop work. `dirty` means GitHub found textual conflicts (mergeable: false).
        if (mergeStatus.mergeableState === "dirty") {
          if (hasValidOwnerUserId) {
            const eligibility = await resolveReviewLoopMergeConflictEligibility(env, {
              ownerUserId,
              repoOwner: parsed.owner,
              repoName: parsed.repo,
              installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
              botSettingsByOwnerRepo: prefetchInputs?.botSettingsByOwnerRepo,
            });
            if (eligibility.ok) {
              const activeMergeConflictEpochExists = await hasActiveMergeConflictReviewLoopEpochForHead(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
              });
              if (activeMergeConflictEpochExists) continue;
              const mergeConflictEpochExists = await hasMergeConflictReviewLoopEpochForHead(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
              });
              if (!mergeConflictEpochExists) {
                await bootstrapReviewLoopEpochForMergeConflict(env.DB, {
                  sessionId: ref.sessionId,
                  ownerUserId,
                  repoOwner: parsed.owner,
                  repoName: parsed.repo,
                  prNumber: parsed.prNumber,
                  prUrl,
                  headSha: currentHeadSha,
                  nowMs: options.nowMs,
                });
                result.reviewListeningMergeConflictIntakes += 1;
                // ARC-1330 D-59a: the legacy done-state reset (setSessionReviewLoopDoneState → "working" +
                // clearDoneLabel) on merge-conflict intake is deleted with the rest of the cron done-state
                // decision sites. The FSM owns the re-open at live (the merge-conflict epoch drives the
                // spine back into REVIEW); labels project from the spine, not this legacy setter.
                options.logger.info(
                  { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha },
                  "Review-loop merge-conflict resolution intake bootstrapped",
                );
                continue;
              }
            } else if (eligibility.reason !== "merge_conflict_resolution_disabled") {
              options.logger.info(
                { sessionId: ref.sessionId, prUrl, reason: eligibility.reason },
                "Review-loop merge-conflict resolution skipped: not eligible",
              );
            }
          }
          // A conflicted PR cannot make progress until the user rebases. Pause the loop for THIS head
          // and never fall through to CI recovery / bootstrap below — those would run against an
          // unmergeable tree, and once epochs are blocked `hasPendingReviewLoopWork` would otherwise
          // report no pending work and let the dirty branch resume. Scope the pending check to the
          // current head so it matches what `blockPendingReviewLoopEpochsForHead` blocks.
          if (await hasPendingReviewLoopWork(env.DB, { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha })) {
            // Notify once per head, then block. Post the comment and block ONLY after it is delivered:
            // a transient comment failure leaves the epochs pending so the notice retries next tick,
            // instead of silently pausing without ever telling the user to rebase. The folded
            // `pr_mergeability_attempts` row used to be the "already notified this head" memory; it is
            // now derived from the epoch blocked-state — a prior tick's block for this head persists as
            // a `rebase_needed`-blocked epoch, so re-entry (e.g. a NEW epoch arriving on the still-dirty
            // head) re-blocks without re-posting the comment (D-54).
            const noticeAlreadySent = (
              await getReviewLoopEpochSummariesForHead(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
              })
            ).some((summary) => summary.status === "blocked" && summary.blockedReason === "rebase_needed");
            let noticeDelivered = noticeAlreadySent;
            if (!noticeAlreadySent) {
              try {
                await createPrIssueComment(
                  token,
                  parsed.owner,
                  parsed.repo,
                  parsed.prNumber,
                  MERGE_CONFLICT_PR_COMMENT,
                );
                noticeDelivered = true;
              } catch (error) {
                options.logger.warn(
                  { sessionId: ref.sessionId, prUrl, error: String(error) },
                  "Review-loop reconciliation merge-conflict comment failed; will retry next tick",
                );
              }
            }
            if (noticeDelivered) {
              const blocked = await blockPendingReviewLoopEpochsForHead(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
                reason: "rebase_needed",
                error: `PR is not mergeable (mergeable_state=dirty) on head ${currentHeadSha}`,
                nowMs: options.nowMs,
              });
              result.reviewListeningRebaseBlocked += blocked;
              // DM the owner that the loop can't progress until they rebase. This
              // fires on every dirty tick (this block re-runs once noticeDelivered
              // is true); "once per head" uniqueness is enforced by the KV TTL
              // inside notifyUserBlocked (dedupKey=head), not by this call site - a
              // new head re-notifies, and a failed initial KV write means a later
              // tick legitimately retries the send.
              await dmSweepOwnerBlocked(env, {
                sessionId: ref.sessionId,
                ownerUserId: ref.ownerUserId,
                kind: BlockerKind.MergeConflict,
                dedupKey: currentHeadSha,
                prUrl,
              });
            }
          }
          continue;
        }

        // Behind base, no conflicts: bring the branch up to date server-side (the API equivalent of
        // the GitHub "Update branch" button). Lazy: only when the session has in-flight review work.
        if (
          mergeStatus.mergeableState === "behind" &&
          (await hasPendingReviewLoopWork(env.DB, { sessionId: ref.sessionId, prUrl }))
        ) {
          // Post the user-facing branch-update-failed comment at most once per head, block the pending
          // epochs `branch_update_failed`, and DM the owner. Dedup the comment on the epoch blocked-state
          // (a prior tick's block for this head persists as a `branch_update_failed`-blocked epoch), so a
          // re-entry on a new epoch re-blocks without re-posting — the folded `pr_mergeability_attempts`
          // counter used to be this "already surfaced this head" memory (D-54).
          const blockBranchUpdate = async (error: string): Promise<void> => {
            const alreadyBlocked = (
              await getReviewLoopEpochSummariesForHead(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
              })
            ).some((summary) => summary.status === "blocked" && summary.blockedReason === "branch_update_failed");
            if (!alreadyBlocked) {
              try {
                await createPrIssueComment(
                  token,
                  parsed.owner,
                  parsed.repo,
                  parsed.prNumber,
                  BRANCH_UPDATE_FAILED_PR_COMMENT,
                );
              } catch (commentError) {
                options.logger.warn(
                  { sessionId: ref.sessionId, prUrl, error: String(commentError) },
                  "Review-loop reconciliation branch-update-failed comment failed",
                );
              }
            }
            result.reviewListeningRebaseBlocked += await blockPendingReviewLoopEpochsForHead(env.DB, {
              sessionId: ref.sessionId,
              prUrl,
              headSha: currentHeadSha,
              reason: "branch_update_failed",
              error,
              nowMs: options.nowMs,
            });
            // DM the owner that the branch can't be auto-updated. KV dedup keyed
            // on head means repeated blocks for the same head won't re-DM.
            await dmSweepOwnerBlocked(env, {
              sessionId: ref.sessionId,
              ownerUserId: ref.ownerUserId,
              kind: BlockerKind.BranchUpdateFailed,
              dedupKey: currentHeadSha,
              prUrl,
            });
          };

          // The `update_branch_queued_at` spine marker (ARC-1302) is stamped when OUR update-branch
          // queues for a head and cleared when the head advances, so it is the surviving per-head signal
          // for "we already asked GitHub to base-merge this head" (the folded `pr_mergeability_attempts`
          // cooldown + retry counter). Read it scoped to the CURRENT head — a mismatched/absent row reads
          // as un-queued (issue now). A transient read throw is contained: treat it as un-queued (issue),
          // which is idempotent, rather than aborting this PR's tick.
          let queuedAt: number | null = null;
          try {
            const spine = await getPrCoordination(env.DB, ref.sessionId);
            if (spine?.prUrl === prUrl && spine.headSha === currentHeadSha) {
              queuedAt = spine.updateBranchQueuedAt;
            }
          } catch (readError) {
            options.logger.warn(
              { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha, error: String(readError) },
              "Review-loop reconciliation spine queued-marker read failed; treating head as un-queued",
            );
          }
          if (queuedAt != null) {
            // We already queued our own update-branch for THIS head. The merged commit may take a tick or
            // two to land and advance the head (the head-change carry-forward gate then re-keys the review
            // work); do not re-issue while it is in flight. If the head STILL has not advanced past the
            // give-up window, the base-merge is stuck — surface to the owner instead of retrying forever.
            if (options.nowMs - queuedAt >= UPDATE_BRANCH_STUCK_GIVE_UP_MS) {
              await blockBranchUpdate(
                `update-branch did not advance head ${currentHeadSha} within ${UPDATE_BRANCH_STUCK_GIVE_UP_MS}ms`,
              );
            }
            continue;
          }
          const updateResult = await updatePullRequestBranch(
            token,
            parsed.owner,
            parsed.repo,
            parsed.prNumber,
            currentHeadSha,
          );
          if (updateResult.ok) {
            // Queued. Stamp the spine marker on THIS head so the head-change carry-forward gate keys on it
            // (see reconcileReviewLoopEpochsForHeadChange). Gated on `ok` — a failed/transient update must
            // not leave a false marker (ARC-1302). Best-effort and isolated: the update-branch has already
            // queued at GitHub, so a transient D1 throw here must not abort or mis-count this PR's tick. If
            // the stamp fails, the marker stays null and the resulting head advance fails toward
            // stale-block (the conservative direction).
            try {
              await markPrCoordinationUpdateBranchQueued(env.DB, {
                sessionId: ref.sessionId,
                prUrl,
                headSha: currentHeadSha,
                nowMs: options.nowMs,
              });
            } catch (markError) {
              options.logger.warn(
                { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha, error: String(markError) },
                "Review-loop reconciliation spine queued-marker stamp failed; base-merge may stale-block",
              );
            }
            result.reviewListeningBranchUpdated += 1;
          } else if (updateResult.reason === "permission_denied") {
            // No contents:write on the head repo (fork/protection) — will not self-heal. Surface now.
            await blockBranchUpdate(`update-branch permission denied (status ${updateResult.status})`);
          } else {
            // expected_head_mismatch (head moved) / validation_failed / unavailable: transient or a
            // race. Re-poll mergeability next tick (no marker stamped, so we re-issue then).
            options.logger.info(
              { sessionId: ref.sessionId, prUrl, reason: updateResult.reason, status: updateResult.status },
              "Review-loop reconciliation update-branch deferred",
            );
          }
          continue;
        }

        if (!hasValidOwnerUserId) continue;

        // QTA verdict intake: a settled verification run concluded the PR needs work. `verificationResult`
        // is meaningful ONLY at verification-done — an outdated needs-work from run N persists while run N+1
        // is in progress, and the pause check above already deferred the in-progress case.
        const needsWorkVerdict =
          session.verificationState === "verification-done" && session.verificationResult === "needs-work";
        // ARC-1330 D-59a: the legacy needs-work re-intake (bootstrapReviewLoopEpochForVerification + the
        // done-state reset) is DELETED here with the rest of the cron done-state decision sites. The FSM
        // owns QA-findings re-intake (W11-V10): `record_verification(app_breaks)` registers the finding as an
        // undispositioned disposition-store item (`inject_findings`, keyed `verification:<head>:<run>`) and
        // W11-V5 `dispatch_epoch` drains it. The dual-run parity SAMPLE stays as the D-59a soak evidence — at
        // live it records whether the FSM registered the re-intake wherever the deleted legacy intake would
        // have fired, so the stand-down is never a silent drop. Observe-only (never writes the spine, never
        // throws).
        if (needsWorkVerdict) {
          await emitVerificationIntakeStanddownParity(env, {
            sessionId: ref.sessionId,
            prUrl,
            headSha: currentHeadSha,
          });
        }

        // Resolve the feature-enabled checklist BEFORE any head-signal poll. The bot checklist scopes
        // the CODE-REVIEW arm ONLY (RLA v2, docs/design/rla-v2.md): a zero-bot repo resolves ok:true with
        // an empty expected-bot set (walltime removal) and a changed set (expected_bots_changed) disables
        // only the bot-comment bootstrap below — NOT the always-on CI-fix + verification (done-rollup)
        // arm, which a zero-bot repo must still get. Missing installation capabilities is the only true
        // fail-closed reason that disables the whole loop (auto-response / CI-response opt-outs were
        // removed, ARC-1288).
        const checklist = await resolveReviewLoopChecklist(env, {
          ownerUserId,
          repoOwner: parsed.owner,
          repoName: parsed.repo,
          installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
          botSettingsByOwnerRepo: prefetchInputs?.botSettingsByOwnerRepo,
        });
        // ARC-1330 D-59a: the legacy loop-disabled teardown (clearStaleReviewLoopState —
        // setSessionReviewLoopDoneState(null) + clearReviewLoopLabels) is deleted with the rest of the cron
        // done-state decision sites. Under D7 (verification always-on) there is no disabled arm to reset;
        // labels project from the spine at live, so a disabled loop just skips below.
        if (!checklist.ok) {
          if (!isCodeReviewArmOnlyChecklistFailure(checklist.reason)) {
            // Whole loop disabled (master toggle off / installation capabilities missing) — fail
            // closed: do NOT poll GitHub check-runs to re-evaluate; just clear any stale
            // done-claim/labels.
            options.logger.info(
              { sessionId: ref.sessionId, prUrl, reason: checklist.reason },
              "Review-loop reconcile skipped: loop disabled",
            );
            continue;
          }
          // Code-review arm is off (no configured bots), but the always-on CI-fix + verification arm
          // must still run. Gate it on the bot-agnostic CI eligibility (honors the per-repo ci_response
          // opt-out and installation capabilities). If CI is also ineligible the whole arm is off →
          // fail closed; otherwise fall through with the bot-comment bootstrap skipped (checklist.ok
          // guards it below) and the no-show vacuously settled (no bots to wait for).
          const ciEligibility = await resolveReviewLoopCiEligibility(env, {
            ownerUserId,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            installationByOwnerLogin: prefetchInputs?.installationByOwnerLogin,
          });
          if (!ciEligibility.ok) {
            options.logger.info(
              { sessionId: ref.sessionId, prUrl, checklistReason: checklist.reason, ciReason: ciEligibility.reason },
              "Review-loop reconcile skipped: bot checklist not ready and CI arm not eligible",
            );
            continue;
          }
          options.logger.info(
            { sessionId: ref.sessionId, prUrl, reason: checklist.reason },
            "Review-loop code-review arm off (no bots); running CI-fix + verification arm only",
          );
        }

        // One shared CI poll for the whole settled-head reconcile: the done-state rollup, CI recovery,
        // and the bot bootstrap all need the head's check-runs + commit-statuses, so fetch them once
        // here and reuse them everywhere below (no double-poll). A fetch failure means we cannot read
        // CI: keep the prior done-state (no change) and skip recovery/bootstrap this tick; the next
        // sweep retries.
        let headCheckRuns: CommitCheckRun[];
        let commitStatuses: CommitStatusContext[];
        try {
          [headCheckRuns, commitStatuses] = await Promise.all([
            getCommitCheckRuns(token, parsed.owner, parsed.repo, currentHeadSha),
            getCommitStatusContexts(token, parsed.owner, parsed.repo, currentHeadSha),
          ]);
        } catch (error) {
          // CI poll failed: keep the prior done-state (no change) and skip recovery/bootstrap this tick.
          options.logger.warn(
            { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha, error: String(error) },
            "Review-loop reconciliation could not read head CI signals",
          );
          result.reviewListeningErrors += 1;
          continue;
        }

        // Determine up front whether each relevant epoch kind already exists on this head. CI
        // recovery and the bot bootstrap are independent catch-up paths, and each runs at most once
        // per head. Both queries are independent, so run them concurrently.
        const [expectedBotEpochExists, ciEpochExists] = await Promise.all([
          hasExpectedBotReviewLoopEpochForHead(env.DB, { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha }),
          hasCiReviewLoopEpochForHead(env.DB, { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha }),
        ]);

        // Recover failing CI checks already present on the confirmed head into ci-fix epochs. This is
        // independent of the bot gate: a CI check that failed before listening armed (so its live
        // check_run webhook was dropped) is never picked up by the bot-only bootstrap, and a bot epoch
        // on this head must not suppress CI recovery (distinct epoch kinds). Bounded to the catch-up
        // window via `ciEpochExists`: once a ci-fix epoch exists, the live check_run webhook owns later
        // failures, so recovery (and the metric) run once per head, not every tick. Reuses the shared
        // check-runs poll fetched above.
        if (!ciEpochExists) {
          result.reviewListeningCiChecksRecovered += await recoverFailingCiChecksForHead(env, {
            checkRuns: headCheckRuns,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            prNumber: parsed.prNumber,
            prUrl,
            headSha: currentHeadSha,
            logger: options.logger,
          });
        }

        // Bot bootstrap. This is the CODE-REVIEW arm, so it runs only when the bot checklist resolved ok
        // with a non-empty expected-bot set — a zero-bot repo (ok:true, expectedBots: []) has nothing to
        // bootstrap and runs the CI-fix + done-rollup arm only. It applies only while no bot/mixed
        // expected-reviewer epoch exists for this head. Human-only epochs do not count here: they can
        // complete before configured bots arrive.
        if (!expectedBotEpochExists && checklist.ok && checklist.expectedBots.length > 0) {
          try {
            // Require genuinely new actionable bot feedback before re-opening an epoch on a new
            // head. Cycloid's own review-response push changes the head, which makes bots
            // re-review the new commit; a clean re-review (passing check-runs/commit-statuses,
            // or only threads a prior epoch already handled) must not re-trigger the loop. Only
            // a source ID no prior epoch has seen counts as new work; for timestamped prompted
            // comments, a later GitHub updatedAtMs is also new work because the reviewer edited
            // already-prompted feedback.
            //
            // ARC-1226: exclude already-prompted items from this poll (the same dispatch-dedup the
            // prompted records carry). Without it the poll re-truncates to the first ~64KB, so a
            // budget-stranded carried tail from a prior head — or any genuinely-new feedback beyond
            // the budget — is re-dropped here, hasNewActionableFeedback stays false, and the no-show
            // settle below can falsely reach review-loop:done with that feedback never shown. The
            // prompted records are exactly knownSources.promptedAtBySourceId / legacySourceIds, so
            // the known-source lookup runs first and feeds the poll's exclude sets.
            const knownSources = await listKnownReviewLoopSources(env.DB, { sessionId: ref.sessionId, prUrl });
            const worklist = await getPrReviewLoopWorklist(token, parsed.owner, parsed.repo, parsed.prNumber, {
              expectedBots: checklist.expectedBots,
              excludePromptedSourceRecords: knownSources.promptedAtBySourceId,
              excludePromptedSourceBodyHashes: knownSources.bodyHashBySourceId,
              excludeSourceIds: knownSources.legacySourceIds,
            });
            // A re-review that repeats an earlier finding's body is collapsed by
            // getPrReviewLoopWorklist into duplicateGroups, keeping only the first-seen item in
            // `items`. When that canonical item is an old (known) source, the genuinely new
            // duplicate source still lives in duplicateGroups, so consider both.
            const duplicateSourceIds = worklist.duplicateGroups.flatMap((group) => group.duplicateSourceIds);
            const hasNewActionableFeedback =
              worklist.items.some((item) => !isKnownReviewLoopReplay(item, knownSources)) ||
              duplicateSourceIds.some(
                (sourceId) =>
                  !knownSources.promptedAtBySourceId.has(sourceId) &&
                  !knownSources.legacySourceIds.has(sourceId) &&
                  !knownSources.triggeringSourceIds.has(sourceId),
              );
            if (!hasNewActionableFeedback) {
              options.logger.info(
                {
                  sessionId: ref.sessionId,
                  prUrl,
                  headSha: currentHeadSha,
                  worklistSize: worklist.items.length,
                },
                "Review-loop bootstrap skipped: no new actionable feedback on new head",
              );
            } else {
              // Reuse the shared head check-runs + commit-statuses poll fetched above so the bot
              // bootstrap does not re-poll the same endpoints.
              const bootstrap = await bootstrapReviewLoopEpochFromHeadSignals({
                env,
                sessionId: ref.sessionId,
                ownerUserId,
                repoOwner: parsed.owner,
                repoName: parsed.repo,
                prNumber: parsed.prNumber,
                prUrl,
                headSha: currentHeadSha,
                expectedBots: checklist.expectedBots,
                expectedBotsHash: checklist.expectedBotsHash,
                checkRuns: headCheckRuns,
                commitStatuses,
                nowMs: options.nowMs,
              });
              result.reviewListeningEpochsBootstrapped += bootstrap.bootstrapped;
              if (bootstrap.ignored.length > 0) {
                options.logger.info(
                  {
                    sessionId: ref.sessionId,
                    prUrl,
                    headSha: currentHeadSha,
                    ignored: bootstrap.ignored.slice(0, 10),
                  },
                  "Review-loop bootstrap ignored head signals",
                );
              }
            }
          } catch (error) {
            options.logger.warn(
              { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha, error: String(error) },
              "Review-loop bootstrap from head signals failed",
            );
            result.reviewListeningErrors += 1;
          }
        }

        // CI-signal producer — runs for every settled review-listening ref that reached here (checklist-ok,
        // OR the zero-bot / CI-eligible fall-through above), AFTER CI recovery so a ci-fix epoch just
        // recovered from a failing check is visible. Gated on `!headChangedThisTick`: a head-change tick's
        // new-head epochs have not settled. CI is reduced from the shared poll above.
        //
        // ARC-1330 D-59a: the legacy done-state rollup that used to sit here (reconcileReviewLoopDoneState —
        // rollup → done-state persist → label reconcile) is deleted with the rest of the cron
        // done-state decision sites. The FSM owns the settle at live (`caught_up` recompute → cascade); what
        // survives is the periodic `ci.signal` producer below (the absent-CI re-poll + dropped-`check_run`-
        // webhook backstop, KEEP #5).
        if (!headChangedThisTick) {
          // The cron's own collapsed 4-valued CI verdict for the head.
          const ciRollup = reduceCiState(headCheckRuns, commitStatuses);
          // Dual-emit the cron CI rollup onto the spine as `ci.signal{green|failing|absent}` (`pending` → no
          // event). Best-effort/try-caught inside the producer; the poll above is untouched.
          await shadowEmitCiSignal(env, ref.sessionId, ciRollup, options.logger, options.waitUntil);
        }
      } catch (error) {
        result.reviewListeningErrors += 1;
        options.logger.warn(
          { sessionId: ref.sessionId, prUrl: ref.prUrl, error: String(error) },
          "Review-loop reconciliation failed",
        );
      }
    }

    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      options.logger.warn({ cursor: page.nextCursor }, "Review-loop reconciliation cursor repeated");
      result.reviewListeningErrors += 1;
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return result;
}

/**
 * Reclaims in-flight epochs (enqueued/processing/publishing) whose reclaim lease expired — the
 * prompt that owned them ended without driving a terminal transition (reply-only/no-op turn that
 * never completed the epoch, sandbox gone, crash). Without this, listDueReviewLoopEpochs never
 * re-selects them and they are stuck forever, silently swallowing later same-head activity.
 *
 * On reclaim: if the epoch has already consumed the attempt cap, block it with
 * `attempt_cap_reached` instead of looping forever; otherwise reset it to `ready` so the next sweep
 * re-drives it (re-validating head + eligibility through the normal processEpoch path).
 */
/**
 * ARC-1407: is the agent that owns the epoch's prior prompt still alive/working? Gates the stuck-epoch
 * reclaim so it does not orphan in-flight work. Preference order:
 *  (a) the epoch's last_prompt_id is still non-terminal (queued/processing) on the session DO — the
 *      precise "this prompt is still running" signal; then
 *  (b) the session runtime lease is still live (the sandbox agent may still be grinding even when the DO
 *      shows no processing prompt). NOT session_index.updated_at (coarse boundary, not liveness).
 */
async function isPriorPromptAgentAlive(
  env: Env,
  epoch: ReviewLoopEpoch,
  nowMs: number,
  logger: Logger,
): Promise<boolean> {
  if (epoch.lastPromptId) {
    const promptList = await listSessionPrompts(env, epoch.sessionId);
    if (promptList.ok && promptList.payload) {
      if (promptList.payload.queue?.processingPromptId === epoch.lastPromptId) return true;
      const prompt = (promptList.payload.prompts ?? []).find((candidate) => candidate.promptId === epoch.lastPromptId);
      if (prompt && (prompt.status === "queued" || prompt.status === "processing")) return true;
    } else {
      // The DO prompt-state probe is unavailable (HTTP error / uninitialized stub). Fall back to the
      // runtime live-lease, but log it: under sustained DO unavailability a still-fresh lease would keep
      // extending + skipping the reclaim, and that degradation must be observable rather than silent.
      logger.warn(
        {
          event: "review_loop_reclaim_liveness_probe_degraded",
          epochId: epoch.id,
          sessionId: epoch.sessionId,
          lastPromptId: epoch.lastPromptId,
          status: promptList.status,
        },
        "Review-loop reclaim liveness: DO prompt-state probe unavailable; falling back to runtime live-lease (ARC-1407)",
      );
    }
  }
  return await isSessionRuntimeLive(env.DB, epoch.sessionId, nowMs);
}

async function reconcileStuckReviewLoopEpochs(
  env: Env,
  options: { nowMs: number; limit: number; logger: Logger },
): Promise<{ stuckReclaimed: number; stuckBlocked: number }> {
  const result = { stuckReclaimed: 0, stuckBlocked: 0 };
  const stuck = await listStuckReviewLoopEpochs(env.DB, { nowMs: options.nowMs, limit: options.limit });
  for (const epoch of stuck) {
    try {
      // ARC-1226: mirror the processEpoch attempt-cap exemption here — a crashed/timed-out carry-
      // forward drain is reclaimed through this path too. Bound it by the carry-forward wave cap and,
      // at the cap, block with the NON-exhausted `worklist_truncation_unresolved` reason so the rollup
      // stays "working" instead of falsely settling review-loop:done with the tail unshown. Ordinary
      // (carried-empty) epochs keep the general cap + EXHAUSTED `attempt_cap_reached`.
      // ARC-1242: a carry-forward drain is bounded by CONSECUTIVE no-progress attempts (a crashed wave
      // leaves the tail unchanged, so it self-counts as no-progress at the next dispatch), NOT the
      // reclaim-inflated attempt_count. Ordinary (carried-empty) epochs keep the general attempt cap.
      const isCarryForwardDrain = (epoch.carriedForwardSourceIds?.length ?? 0) > 0;
      const overCap = isCarryForwardDrain
        ? epoch.carryForwardNoProgressCount >= REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP
        : epoch.attemptCount >= REVIEW_LOOP_ATTEMPT_CAP;
      if (overCap) {
        const reason = isCarryForwardDrain ? REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON : "attempt_cap_reached";
        const cap = isCarryForwardDrain ? REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP : REVIEW_LOOP_ATTEMPT_CAP;
        const blocked = await blockStuckReviewLoopEpoch(env.DB, epoch.id, {
          nowMs: options.nowMs,
          reason,
          error: isCarryForwardDrain
            ? `Review-loop carry-forward drain reclaimed but made no progress for ${cap} attempts`
            : `Review-loop epoch reclaimed but exhausted ${cap} attempts`,
          expectedLeaseExpiresAt: epoch.leaseExpiresAt,
          // Reclaim-path cap-blocks are real convergence failures (attempt_cap_reached) and must reach
          // the settle-rate failure term. Model isn't loaded on the reclaim sweep, so it tags "unknown".
          telemetry: { env, model: null },
        });
        if (blocked) {
          result.stuckBlocked += 1;
          // ARC-1330: clear the stranded marker (attempt/no-progress caps are cascade-derivable give-ups).
          await emitBlockedEpochTerminal(env, epoch, reason, options.logger);
          options.logger.warn(
            { epochId: epoch.id, sessionId: epoch.sessionId, attemptCount: epoch.attemptCount, status: epoch.status },
            "Review-loop epoch blocked after attempt cap on reclaim",
          );
          // Mirror the processEpoch DM: a reclaim-path cap-block is the same
          // owner-facing condition (attempt_cap_reached) reached via the stuck
          // sweep instead of a live claim. The drain reason
          // (worklist_truncation_unresolved) is not in the map, so it stays
          // silent. dedupKey matches the processEpoch scheme so the two paths
          // can't double-DM the same epoch+head.
          const dmKind = EPOCH_BLOCK_DM_KIND[reason];
          if (dmKind) {
            await dmSweepOwnerBlocked(env, {
              sessionId: epoch.sessionId,
              ownerUserId: epoch.ownerUserId,
              kind: dmKind,
              dedupKey: `${epoch.id}:${epoch.headSha}`,
              prUrl: epoch.prUrl,
            });
          }
        }
        continue;
      }
      // ARC-1407: the reclaim otherwise fires purely on the expired lease with no liveness check, so an
      // agent still working past the lease window gets orphaned (the next processEpoch mints a fresh
      // prompt against the reclaimed 'ready' epoch, and the finishing agent's push is then discarded as
      // epoch_not_processing). Skip the reclaim while the prior prompt's agent is alive; extend the lease
      // so the epoch is not re-listed next tick.
      if (await isPriorPromptAgentAlive(env, epoch, options.nowMs, options.logger)) {
        await extendReviewLoopEpochLease(env.DB, epoch.id, {
          nowMs: options.nowMs,
          expectedLeaseExpiresAt: epoch.leaseExpiresAt,
        });
        options.logger.info(
          {
            event: "review_loop_reclaim_skipped_agent_alive",
            epochId: epoch.id,
            sessionId: epoch.sessionId,
            lastPromptId: epoch.lastPromptId,
          },
          "Review-loop stuck-epoch reclaim skipped: prior prompt's agent still alive; lease extended (ARC-1407)",
        );
        continue;
      }
      const reclaimed = await reclaimStuckReviewLoopEpoch(env.DB, epoch.id, {
        nowMs: options.nowMs,
        expectedLeaseExpiresAt: epoch.leaseExpiresAt,
      });
      if (reclaimed) {
        result.stuckReclaimed += 1;
        options.logger.info(
          { epochId: epoch.id, sessionId: epoch.sessionId, fromStatus: epoch.status, attemptCount: epoch.attemptCount },
          "Review-loop epoch reclaimed from expired in-flight lease",
        );
      }
    } catch (error) {
      options.logger.warn({ epochId: epoch.id, error: String(error) }, "Review-loop stuck-epoch reclaim failed");
    }
  }
  return result;
}

/**
 * ONE COUNT query against session_index for caught-up dormant review_listening sessions.
 * Used exclusively to feed `review_listening.dormant_count` telemetry — never for sweep
 * control flow. The predicate mirrors the epoch-aware dormancy filter in
 * `listReviewListeningGithubPrRefs` (webhooks/db.ts) without the NOT EXISTS join so it
 * counts ALL caught-up sessions, including those with an in-flight epoch (edge case: a
 * webhook landed just before this tick and re-admitted the session). Close enough for
 * a gauge; the intent is trend visibility, not exact accounting.
 */
async function countDormantReviewListeningSessions(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS dormant_count FROM session_index
       WHERE rich_status = 'review_listening'
         AND COALESCE(review_loop_done_state, '') = 'done'
         AND arcanist_done_state = 'done'`,
    )
    .first<{ dormant_count: number }>();
  return row?.dormant_count ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARC-1330 (PR 48, the 4c cron demotion) — THE SWEEP OWNERSHIP MAP (post-flip, unconditionally live).
//
// The tech spec's PR 48 ("runReviewLoopSweep decision sites become repair-only") assumed PR 47 had
// handed the post-publish DECISIONS to the FSM wholesale. The Wave-10 scope decision it predates
// (PR 46/47 — live-side-effects.ts SCOPE note, live-resolver.ts `epoch1Fired`/`actionableExists`)
// kept LEGACY as the owner of epoch CREATION, WORKLIST construction, PROMPT dispatch, and the
// display/state MIRRORS, and PR 47 therefore gated the legacy decision CONSUMERS at their narrowest
// sites instead (the DO done-state verification schedule, the review-loop:done label webhook
// schedule, the verifier rerun-after-fix). Audited against that scope, EVERY write this sweep makes
// is either a D17/§14 KEEP or legacy-owned machinery the FSM has no live replacement for in this
// slice — so the PR-48 demotion is a set of DOCUMENTED NO-OPS, not blind mode gates (gating any of
// these at live would strand the loop, not demote it). Per-site disposition:
//
// KEPT — the D17/§14 reconcile set (unconditional, every mode):
//   • GitHub merge/close poll (`getPrMergeStatus` → merged/closed close-out) — D17 reconcile #1,
//     the dropped-webhook backstop; its `shadowEmitCronPrTerminal` sibling is the SOLE cron
//     producer of `pr.merged`/`pr.closed` for dropped webhooks (a REAL spine input at live).
//   • The absent-CI re-poll (the shared head CI poll → `shadowEmitCiSignal`) — D17 reconcile #2;
//     at live this emit IS the FSM's cron `ci.signal(green|failing|absent)` carrier (the cascade
//     row-7 green flip + FG-2 reset for webhook-less/no-CI repos) — demoting it would wedge
//     MERGE_READY for every cron-paced repo.
//   • Loud / blocked-owner redelivery (`dmSweepOwnerBlocked`, the CI escalation comments, the
//     ci-red internal alert) — D17 reconcile #3 (the full FSM `loud()` rewiring is PR 49).
//   • `reconcileStuckReviewLoopEpochs` (lease reclaim) + the transient-failure retry budget —
//     §14 KEEP #2, epoch crash-recovery (the CAS gives
//     mutual exclusion, not liveness).
//   • `cron_sweep_cursors` pagination (`listReviewListeningGithubPrRefs` + the swept-at rotation
//     watermark) and the dead-ref heal — deletion-tracker KEEP.
//   • The mergeability reconcile (dirty-block / update-branch, `update_branch_queued_at`) — §14
//     KEEP #6; no FSM slice owns branch updating.
//
// KEPT — legacy ownership retained by the Wave-10 scope decision (a live gate here would be a bug):
//   • `processEpoch` (claim → checklist → poll → prompt ENQUEUE → enqueued/blocked/completed epoch
//     transitions): legacy OWNS epoch dispatch at live — the live resolver arms no FSM epoch-1
//     trigger and the live sink's `dispatch_epoch` is an exists-check no-op anchored on the
//     legacy-created id. Its terminals also FEED the spine (the PR 41 epoch producer), so gating
//     it would both stop all review/CI-fix work AND starve the FSM of epoch events.
//   • `recoverFailingCiChecksForHead` (pre-listen CI recovery) and the bot bootstrap
//     (`bootstrapReviewLoopEpochFromHeadSignals`): epoch CREATION, legacy-owned at live (the FSM has no
//     failing-check / bot-comment identity to trace, so gating them would strand CI-fix + bot review).
//
// DELETED at D-59a (the legacy cron done-state DECISION sites this file owned; the FSM owns the settle at
// live via the `caught_up` recompute → cascade, with the periodic sweep + D17 redelivery as backstops):
//   • The verification needs-work intake (the `needsWorkVerdict` block above). It WAS the only re-entry
//     path for QTA findings; W11-V10 gave it an FSM owner — `record_verification(app_breaks)` registers the
//     finding as an undispositioned disposition-store item (`inject_findings`, keyed
//     `verification:<head>:<run>`) and W11-V5 `dispatch_epoch` drains it. The best-effort
//     `fsm.verification_intake_parity` dual-run sample (`emitVerificationIntakeStanddownParity`) SURVIVES as
//     the soak evidence that the FSM re-intake fires wherever the deleted legacy intake would have.
//   • `reconcileReviewLoopDoneState` (rollup → done-state persist → label reconcile),
//     `setSessionReviewLoopDoneState` + its DO route, `readyEligible`'s cron setter, and
//     `clearStaleReviewLoopState`. What SURVIVES in their place is the periodic `ci.signal` producer
//     (`shadowEmitCiSignal`, the absent-CI re-poll + dropped-`check_run`-webhook backstop, KEEP #5). The
//     spine-sourced rewiring of the legacy DISPLAY/mirror surface (rich_status, cycloid_done, PR labels —
//     projected via project()/P3 dual-run) lands in D-59b/59c.
//
// RETAINED (legacy ownership kept by the Wave-10/11 scope decision — a live gate here would be a bug):
//   • The head-change reconcile (epoch re-key + head advance + verdict clear/stamp): SHARED with the
//     `synchronize` webhook (ARC-1245 no-drift); the verdict store still feeds the ARC-1243 settle gate the
//     FSM's own spawn executor rides. Only the head-change done-state reset was deleted with the decision
//     sites above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A3 — the run-scoped 1h verification backstop. Under spawn-at-publish, a verifier child runs while real
 * parent sessions stay in REVIEW, but synthetic PR-coordinator rows intentionally remain in VERIFYING
 * after `requestCoordinatedVerification` stamps the child. A child that dies/skips WITHOUT ever emitting a
 * verdict (and without hitting the abnormal-stop seam) would otherwise leave the run silently unresolved.
 * This pass lists those REVIEW rows plus synthetic VERIFYING rows when they still have a stamped child and
 * no fresh verdict whose run spawned > 1h ago (the QA binding's `updated_at` is the run-scoped spawn
 * clock) and emits a run-scoped `verification.stopped` — CORE routes it to a record write + a
 * NON-BLOCKING `NOTIFY_QA_ISSUE` DM (no NEEDS_YOU: QA no longer gates merge). Idempotent: the binding is
 * closed after the emit so the row never re-triggers, regardless of what the record write stamps.
 * Best-effort/try-caught per row; no-op on an unbound DB.
 */
export async function fireStuckVerificationBackstops(
  env: Env,
  opts: { nowMs: number; limit: number; waitUntil?: (promise: Promise<unknown>) => void; logger: Logger },
): Promise<{ scanned: number; fired: number }> {
  const result = { scanned: 0, fired: 0 };
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") {
    return result;
  }
  let candidates: Awaited<ReturnType<typeof listVerificationBackstopCandidates>>;
  try {
    candidates = await listVerificationBackstopCandidates(db, {
      limit: opts.limit,
      spawnedBeforeMs: opts.nowMs - VERIFYING_BACKSTOP_DEADLINE_MS,
    });
  } catch (error) {
    opts.logger.warn({ error: String(error) }, "A3 verification backstop list failed (ignored)");
    return result;
  }
  for (const record of candidates) {
    result.scanned += 1;
    if (!record.prUrl || !record.verificationChildId) continue;
    try {
      await shadowEmitVerificationOutcome(
        env,
        record.sessionId,
        { outcome: "stopped", runId: record.verificationRunId, headSha: null },
        opts.logger,
        opts.waitUntil,
      );
      // Idempotency: close the binding so the JOIN (status='active') drops this row next sweep.
      await closeQaLoopBinding(db, {
        prUrl: record.prUrl,
        automatedLifecycleId: record.sessionId,
        qaSessionId: record.verificationChildId,
        status: "expired",
      }).catch(() => undefined);
      result.fired += 1;
    } catch (error) {
      opts.logger.warn(
        { sessionId: record.sessionId, error: String(error) },
        "A3 verification backstop fire failed for candidate (ignored)",
      );
    }
  }
  return result;
}

/**
 * A3 — the cross-DO dormant-REVIEW `review_stuck` give-up backstop.
 *
 * The per-session DO alarm arms the REVIEW state-deadline precisely when the DO drives the transition,
 * but a parent whose DO went dormant (host death / no further alarm tick) would dwell past
 * `REVIEW_STUCK_DEADLINE_MS` with no give-up fire. Spawn-at-publish keeps the row in REVIEW while a
 * verifier child runs, so QA no longer gates it — but the review-loop lifecycle give-up (a REVIEW that
 * never converges) still needs a cross-DO safety net. This sweep-driven pass lists REVIEW rows past
 * their window (oldest-dwell first, bounded) and, for each, invokes `shadowFireDueDeadline`, which
 * commits `deadline_exceeded → NEEDS_YOU(review_stuck)` (CAS + event log) and dispatches the drain/loud
 * bag. Disjoint from the run-scoped verification backstop (`fireStuckVerificationBackstops`): that fires
 * a stuck verifier child as a NON-BLOCKING QA notice; this fires the REVIEW-lifecycle give-up.
 * Best-effort/try-caught per row — a fault never perturbs the sweep. No-op on an unbound DB.
 */
export async function fireDwellDueReviewStuckDeadlines(
  env: Env,
  opts: { nowMs: number; limit: number; waitUntil?: (promise: Promise<unknown>) => void; logger: Logger },
): Promise<{ scanned: number; fired: number }> {
  const result = { scanned: 0, fired: 0 };
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") {
    return result;
  }
  let candidates: Awaited<ReturnType<typeof listReviewStuckPrCoordinationCandidates>>;
  try {
    candidates = await listReviewStuckPrCoordinationCandidates(db, {
      limit: opts.limit,
      reviewEnteredBeforeMs: opts.nowMs - REVIEW_STUCK_DEADLINE_MS,
    });
  } catch (error) {
    opts.logger.warn({ error: String(error) }, "A3 review-stuck deadline backstop list failed (ignored)");
    return result;
  }
  for (const record of candidates) {
    result.scanned += 1;
    // Cheap in-memory dwell pre-check (no extra read) before the fire producer re-reads + re-checks.
    if (!deadlineWouldFire({ state: record.state as FsmState, stateEnteredAt: record.stateEnteredAt }, opts.nowMs)) {
      continue;
    }
    try {
      const fire = await shadowFireDueDeadline(
        env,
        record.sessionId,
        opts.nowMs,
        opts.logger,
        undefined,
        opts.waitUntil,
      );
      if (fire.wouldFire) result.fired += 1;
    } catch (error) {
      opts.logger.warn(
        { sessionId: record.sessionId, error: String(error) },
        "A3 review-stuck deadline backstop fire failed for candidate (ignored)",
      );
    }
  }
  return result;
}

async function runDueReviewLoopEpochDispatch(
  env: Env,
  options: {
    nowMs: number;
    limit: number;
    logger: Logger;
  },
): Promise<ReviewLoopSweepResult> {
  const due = await listDueReviewLoopEpochs(env.DB, { nowMs: options.nowMs, limit: options.limit });
  const result = createReviewLoopSweepResult({ attempted: due.length });
  const duePrefetchInputsByRepo = await prefetchReviewLoopChecklistInputsByRepo(
    env,
    due.map((epoch) => ({
      ownerUserId: epoch.ownerUserId,
      repoOwner: epoch.repoOwner,
      repoName: epoch.repoName,
    })),
  );
  addDispatchResult(
    result,
    await processReviewLoopEpochGroupsWithConcurrency(
      groupReviewLoopEpochsBySession(due),
      REVIEW_LOOP_DISPATCH_CONCURRENCY,
      async (epochs) => {
        const groupResult = createReviewLoopSweepResult();
        for (const epoch of epochs) {
          try {
            addProcessEpochStatus(
              groupResult,
              epoch,
              await processEpoch(
                env,
                epoch,
                options.nowMs,
                options.logger,
                duePrefetchInputsByRepo.get(reviewLoopRepoGroupKey(epoch)),
              ),
            );
          } catch (error) {
            groupResult.dispatchErrors += 1;
            options.logger.warn(
              {
                error: String(error),
                epochId: epoch.id,
                sessionId: epoch.sessionId,
                repoOwner: epoch.repoOwner,
                repoName: epoch.repoName,
              },
              "Review-loop epoch dispatch failed",
            );
            break;
          }
        }
        return groupResult;
      },
      (epochs, error) => {
        const firstEpoch = epochs[0];
        options.logger.warn(
          {
            error: String(error),
            epochIds: epochs.map((epoch) => epoch.id),
            sessionId: firstEpoch?.sessionId,
            repoOwner: firstEpoch?.repoOwner,
            repoName: firstEpoch?.repoName,
          },
          "Review-loop epoch dispatch group failed",
        );
      },
    ),
  );
  return result;
}

export async function runReviewLoopEpochDispatchSweep(
  env: Env,
  options: {
    nowMs?: number;
    limit?: number;
    logger?: Logger;
  },
): Promise<ReviewLoopSweepResult> {
  if (!env.DB) {
    return createReviewLoopSweepResult();
  }
  const nowMs = options.nowMs ?? Date.now();
  const logger = options.logger ?? log;
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const result = await runDueReviewLoopEpochDispatch(env, { nowMs, limit, logger });
  if (
    result.attempted > 0 ||
    result.enqueued > 0 ||
    result.completedNoop > 0 ||
    result.blocked > 0 ||
    result.contentionDeferred > 0 ||
    result.transientDeferred > 0 ||
    result.dispatchErrors > 0
  ) {
    logger.info({ ...result }, "Review-loop epoch dispatch sweep completed");
  }
  return result;
}

// ARC-1330 SELF-HEAL: the standing stock that wedged in REVIEW/VERIFYING before the emit-on-terminal fix
// landed. `pr_coordination.in_flight_epoch_id` still points at an epoch that ALREADY reached a terminal
// status (completed / blocked), but no spine `epoch.*` terminal was ever emitted, so the marker strands
// and `caught_up`'s `no_inflight_epoch` conjunct stays false forever. The D17 repair arm cannot heal these
// (it only re-materializes a MISSING epoch row and re-dispatches side-effects — it can't mutate committed
// state). This applyEvent-driven backstop clears the marker directly by emitting the reason-routed
// terminal (mirroring `fireStuckVerificationBackstops`). Runs on the `*/5` cron; best-effort, per-row
// isolated. New rows never reach here (the forward emit-on-terminal fix clears the marker at settle time).
export async function reconcileStrandedTerminalEpochMarkers(
  env: Env,
  options: { limit: number; logger: Logger; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<{ cleared: number }> {
  if (!env.DB) return { cleared: 0 };
  const candidates = await listPrCoordinationTransientRepairCandidates(env.DB, { limit: options.limit }).catch(
    () => [],
  );
  const inFlightEpochIds = candidates.flatMap((rec) => (rec.inFlightEpochId ? [rec.inFlightEpochId] : []));
  let prefetchedEpochs = new Map<string, ReviewLoopEpoch>();
  if (inFlightEpochIds.length > 0) {
    try {
      prefetchedEpochs = new Map(
        (await listReviewLoopEpochsByIds(env.DB, inFlightEpochIds)).map((epoch) => [epoch.id, epoch]),
      );
    } catch (error) {
      options.logger.warn(
        { error: String(error), candidateCount: candidates.length, epochIdCount: inFlightEpochIds.length },
        "FSM stranded-terminal marker self-heal batched epoch prefetch failed; falling back to per-row reads",
      );
    }
  }
  let cleared = 0;
  for (const rec of candidates) {
    // The scan also returns VERIFYING rows with no in-flight marker (the D17 verification arm's cohort);
    // only a set in_flight_epoch_id can be a stranded terminal marker.
    if (!rec.inFlightEpochId) continue;
    try {
      const epoch =
        prefetchedEpochs.get(rec.inFlightEpochId) ?? (await getReviewLoopEpochById(env.DB, rec.inFlightEpochId));
      // Missing epoch row = the documented crash-between-commit-and-create gap → the D17 arm re-materializes
      // it. A still-live epoch (collecting/ready/reserving/enqueued) is NOT stranded — leave it.
      if (!epoch) continue;
      if (epoch.status === "completed") {
        // Heal ONLY a proven no-op completion (never dispatched a prompt → `last_prompt_id === null`).
        // A completed epoch that ran a prompt reaches `completed` via the publish / terminal-prompt paths,
        // which emit `committed`/`replied` (with item dispositions + `set_code_changed`) — replaying it as
        // `epoch.settled` would drop those and could leave owned review items undispositioned or skip the
        // re-verification trigger, so `caught_up` stays false. If such an epoch is somehow stranded it is a
        // DIFFERENT defect; leave it for the `review_stuck` deadline give-up (`REVIEW_STUCK_DEADLINE_MS`,
        // fired by the DO alarm or the cross-DO `fireDwellDueReviewStuckDeadlines` sweep backstop) rather
        // than mis-heal it. The
        // candidate was selected BY its in_flight_epoch_id, so this epoch IS the record's in-flight one.
        if (epoch.lastPromptId !== null) continue;
        await shadowEmitReviewLoopEpochTerminal(env, epoch, "settled", options.logger, options.waitUntil);
        cleared += 1;
      } else if (epoch.status === "blocked") {
        // Reason-routed (benign/CI-cap → epoch.settled; publish/reply_failed → NEEDS_YOU; skip-set no-ops).
        if (
          await emitBlockedEpochTerminal(env, epoch, epoch.blockedReason ?? "", options.logger, undefined, {
            clearDisabledMarker: true,
          })
        ) {
          cleared += 1;
        }
      }
    } catch (error) {
      options.logger.warn(
        { sessionId: rec.sessionId, epochId: rec.inFlightEpochId, error: String(error) },
        "FSM stranded-terminal marker self-heal failed (ignored)",
      );
    }
  }
  return { cleared };
}

// ARC-1445 self-heal: a REVIEW row wedged with NO in-flight epoch but undispositioned actionable items and
// no live epoch to disposition them. The forward `epoch.settled` arm-the-drain fix cannot reach rows whose
// terminal already fired (or that stranded some other way), so this reconcile re-fires the drain: feed ONE
// internal `review.item_ready` and the live `REVIEW — review.item_ready / dispatch_epoch` edge stamps a
// fresh in-flight id + dispatch; the executor then traces ALL undispositioned items into that one epoch.
// Fires at most once per wedged row (the next stamp leaves in_flight non-null, off this scanner) and never
// while a live epoch is pending (`hasPendingReviewLoopWork`), so it cannot double-drive.
export async function reconcileUndispatchedReviewItems(
  env: Env,
  options: { limit: number; logger: Logger; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<{ dispatched: number }> {
  if (!env.DB) return { dispatched: 0 };
  const candidates = await listReviewRowsWithUndispositionedNoInflight(env.DB, { limit: options.limit }).catch(
    () => [],
  );
  let dispatched = 0;
  for (const rec of candidates) {
    if (!rec.prUrl) continue;
    try {
      // A live/ready epoch already owns the loop — it will disposition these items; never double-drive.
      // Omit headSha so a lingering older-head epoch also counts as pending.
      if (await hasPendingReviewLoopWork(env.DB, { sessionId: rec.sessionId, prUrl: rec.prUrl })) continue;
      const undisp = await listUndispositionedActionable(env.DB, rec.sessionId, rec.prUrl);
      if (undisp.length === 0) continue; // raced clean between the scan and here
      // Count only CONFIRMED drives — `shadowEmitReviewItemReady` swallows its own faults and returns
      // false, so a failed drive does not inflate the self-heal telemetry.
      if (await shadowEmitReviewItemReady(env, rec.sessionId, undisp[0], options.logger, options.waitUntil)) {
        dispatched += 1;
      }
    } catch (error) {
      options.logger.warn(
        { sessionId: rec.sessionId, prUrl: rec.prUrl, error: String(error) },
        "FSM undispatched-review-items self-heal failed (ignored)",
      );
    }
  }
  return { dispatched };
}

export async function runReviewLoopSweep(
  env: Env,
  options: {
    nowMs?: number;
    limit?: number;
    reconciliationLimit?: number;
    logger?: Logger;
    /** PR 47: the scheduled tick's ExecutionContext seam — live FSM side-effects defer through it. */
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<ReviewLoopSweepResult> {
  if (!env.DB) {
    return createReviewLoopSweepResult();
  }
  const nowMs = options.nowMs ?? Date.now();
  const logger = options.logger ?? log;
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  // Reclaim stuck in-flight epochs (expired lease) BEFORE listing due epochs so a reclaimed epoch
  // (reset to `ready`) is re-driven in this same tick.
  const stuckReconciliation = await reconcileStuckReviewLoopEpochs(env, {
    nowMs,
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    logger,
  });
  const fsmRepair = await repairStateDerivedSideEffects(env, {
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    waitUntil: options.waitUntil,
    logger,
  });
  const fsmVerifyingDeadline = await fireStuckVerificationBackstops(env, {
    nowMs,
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    waitUntil: options.waitUntil,
    logger,
  });
  const fsmReviewStuckDeadline = await fireDwellDueReviewStuckDeadlines(env, {
    nowMs,
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    waitUntil: options.waitUntil,
    logger,
  });
  const fsmStrandedMarkers = await reconcileStrandedTerminalEpochMarkers(env, {
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    waitUntil: options.waitUntil,
    logger,
  });
  const fsmUndispatchedReviewItems = await reconcileUndispatchedReviewItems(env, {
    limit: Math.min(limit, DEFAULT_STUCK_RECLAIM_LIMIT),
    waitUntil: options.waitUntil,
    logger,
  });
  const result = await runDueReviewLoopEpochDispatch(env, { nowMs, limit, logger });
  Object.assign(result, {
    stuckReclaimed: stuckReconciliation.stuckReclaimed,
    stuckBlocked: stuckReconciliation.stuckBlocked,
    fsmEpochDispatchRedelivered: fsmRepair.epochDispatchRedelivered,
    fsmLoudRedelivered: fsmRepair.loudRedelivered,
    fsmSettleRedelivered: fsmRepair.settleRedelivered,
    fsmVerifyingDeadlineFired: fsmVerifyingDeadline.fired,
    fsmReviewStuckDeadlineFired: fsmReviewStuckDeadline.fired,
    fsmStrandedTerminalMarkersCleared: fsmStrandedMarkers.cleared,
    fsmUndispatchedReviewItemsDispatched: fsmUndispatchedReviewItems.dispatched,
  });
  const reconciliation = await reconcileReviewListeningSessions(env, {
    nowMs,
    limit: options.reconciliationLimit ?? DEFAULT_REVIEW_LISTENING_RECONCILE_LIMIT,
    logger,
    waitUntil: options.waitUntil,
  });
  Object.assign(result, reconciliation);
  const postReconcileDispatch = await runDueReviewLoopEpochDispatch(env, { nowMs, limit, logger });
  addDispatchResult(result, postReconcileDispatch);
  if (
    result.attempted > 0 ||
    result.reviewListeningAttempted > 0 ||
    result.stuckReclaimed > 0 ||
    result.stuckBlocked > 0 ||
    result.fsmEpochDispatchRedelivered > 0 ||
    result.fsmLoudRedelivered > 0 ||
    result.fsmSettleRedelivered > 0 ||
    result.fsmVerifyingDeadlineFired > 0 ||
    result.fsmReviewStuckDeadlineFired > 0 ||
    result.fsmStrandedTerminalMarkersCleared > 0 ||
    result.fsmUndispatchedReviewItemsDispatched > 0
  ) {
    logger.info({ ...result }, "Review-loop sweep completed");
  }
  // Best-effort dormant-count telemetry. runReviewLoopSweep is only called from the cron (inside the
  // scheduled task's waitUntil keepalive), so awaiting here guarantees the POST ships before the tick
  // ends; the try/catch keeps a telemetry/D1 failure from ever breaking the sweep.
  try {
    const dormantCount = await countDormantReviewListeningSessions(env.DB);
    await emitReviewListeningDormantCountEvent(env, { dormantCount });
  } catch {
    // swallow — telemetry must never affect the sweep
  }
  const db = env.DB;
  if (db) {
    // ARC-1330 (W11-T2) SPINE-DRIVEN merge/close reconcile (D17 backstop). The legacy merge/close poll above
    // (`shadowEmitCronPrTerminal`) only sees the review-listening working set, which DROPS sessions legacy
    // closed out or that sit in loud terminals (NEEDS_YOU/STOPPED) — the exact wedge where a merged/closed PR
    // never reaches the spine. This pass enumerates the SPINE'S OWN non-final post-publish rows (cursor-
    // rotated + read-bounded via cron_sweep_cursors), polls each PR's real state (the KEEP'd getPrMergeStatus,
    // isolated from auth throws), and mints the terminal ONLY on an observed merged/closed. Off the webhook
    // hot path, per-row best-effort — a fault never perturbs the sweep. Token plumbing lives
    // HERE (memoized per owner) so the reconcile module never re-implements installation-token resolution.
    try {
      const tokenByOwner = new Map<string, string | null>();
      const readGroundTruth = buildGithubGroundTruthReader({
        resolveToken: async (input) => {
          if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return null;
          const memoized = tokenByOwner.get(input.owner);
          if (memoized !== undefined) return memoized;
          const installation = await getInstallationByOwner(db, input.owner);
          const token =
            !installation || installation.suspended_at !== null
              ? null
              : await createInstallationToken(env, installation.installation_id);
          tokenByOwner.set(input.owner, token);
          return token;
        },
      });
      const spineReconcile = await reconcileSpineOpenPrTerminals({
        env,
        logger,
        readGroundTruth,
        waitUntil: options.waitUntil,
      });
      if (
        spineReconcile.reconciledMerged > 0 ||
        spineReconcile.reconciledClosed > 0 ||
        spineReconcile.noGroundTruth > 0 ||
        spineReconcile.failed > 0
      ) {
        logger.info({ ...spineReconcile }, "ARC-1330 spine terminal reconcile pass");
      }
    } catch (error) {
      logger.warn({ error: String(error) }, "ARC-1330 spine terminal reconcile pass failed (ignored, best-effort)");
    }
  }
  return result;
}
