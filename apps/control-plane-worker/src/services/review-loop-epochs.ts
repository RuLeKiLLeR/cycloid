import { isReadOnlyAgentRole } from "../../../../shared/agent/constants.js";
import { type PrReviewExpectedBot } from "../../../../shared/constants/pr-review-bots.js";
import { D1_RETRY_SAFE_MARKER, d1Changed } from "../db/errors";
import { getInstallationsByOwners } from "../github/installations-db";
import { type CommitCheckRun, type CommitStatusContext, parseCiFailingCheckNames } from "../github/pr";
import {
  classifyPrReviewBotForTelemetry,
  CYCLOID_QA_BOT_KEY,
  expectedBotKey,
  matchReviewLoopBot,
  normalizeGitHubActorLogin,
  qaCommentVerdictActionable,
  resolveIngestBotKey,
} from "../github/pr-review-bots";
import { extractManagedQaCommentVerdict } from "../github/verification-comment-marker";
import {
  classifyReviewLoopIngestIgnoredReason,
  emitReviewLoopArrivalToDispatchEvent,
  emitReviewLoopCiFirstFailToDispatchEvent,
  emitReviewLoopEpochTerminalEvent,
  emitReviewLoopIngestOutcomeEvent,
  REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON,
  type ReviewLoopDispatchTrigger,
  type ReviewLoopIngestWebhookKind,
} from "../observability/review-loop-events";
import {
  type EpochTerminalItemDisposition,
  type EpochTerminalKind,
  shadowEmitEpochTerminal,
} from "../session/fsm/epoch-producer";
import {
  classifyReviewReceived,
  type ReviewClassificationInput,
  shadowEmitReviewReceived,
} from "../session/fsm/review-producer";
import { getSessionState } from "../session/state";
import { getUserPrReviewBotSettingsByUserIds } from "../settings/db";
import type { Env, SessionState } from "../types";
import { listSessionIdsByWebhookRef, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR } from "../webhooks/db";
import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopPushOperationId,
  listSucceededReviewLoopReplyOperations,
  markReviewLoopOperationSucceeded,
  touchSucceededReviewLoopOperation,
} from "./review-loop-operations";
import type { ReviewLoopEpochSummary } from "./review-loop-rollup";
import {
  resolveAutomaticReviewsEnabled,
  resolveReviewLoopChecklist,
  resolveReviewLoopCiEligibility,
} from "./review-loop-settings";
import { isCheckRunFailureSourceId, parseReviewLoopSourceNumericId } from "./review-loop-source-id";

export type ReviewLoopEpochStatus =
  | "collecting"
  | "ready"
  | "reserving"
  | "enqueued"
  | "processing"
  | "waiting_for_owner"
  | "publishing"
  | "completed"
  | "blocked";

// Canonical home is review-loop-rollup.ts (the rollup reducer is the primary consumer);
// re-exported here so epoch-DAO callers get the shape without a second import.
export type { ReviewLoopEpochSummary } from "./review-loop-rollup";

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type ReviewLoopSourceKind = "bot" | "human" | "mixed" | "ci" | "verification" | "merge_conflict" | "mention";

/**
 * Optional telemetry context a terminal-transition caller threads into the epoch
 * setters so a `review_loop.epoch.completed` event can be emitted from the single
 * DAO chokepoint (covering both sweep and publish callers). `model` is the session
 * agent model (not on the epoch row); `dispatch` is the caller's `waitUntil` on a
 * request/DO path — omit it on the cron sweep path to bare-await the emit. When the
 * field is absent, no event is emitted (graceful, additive instrumentation).
 */
export interface ReviewLoopEpochTelemetry {
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  model: string | null;
  dispatch?: (promise: Promise<unknown>) => void;
}

async function emitEpochTerminalTelemetry(
  epoch: ReviewLoopEpoch | null,
  telemetry: ReviewLoopEpochTelemetry | undefined,
): Promise<void> {
  if (!epoch || !telemetry) return;
  const promise = emitReviewLoopEpochTerminalEvent(telemetry.env, epoch, { model: telemetry.model });
  if (telemetry.dispatch) telemetry.dispatch(promise);
  else await promise;
}

/**
 * The two storage-level sentinels that distinguish a CI-fix epoch from a
 * bot/human review epoch, given a single home so they are no longer scattered
 * magic strings. Storage layout is intentionally UNCHANGED (no migration): a
 * CI-fix epoch is still a row in `pr_review_response_epochs` with
 * `source_kind = 'ci'` and `expected_bots_hash = 'ci-fixes'`. Classify epochs
 * with `isCiEpoch` / `isReviewEpoch` and read the overloaded `worklist_hash`
 * through `ciFailingCheckFingerprint` / `reviewWorklistHash` rather than
 * touching these constants directly.
 */
export const REVIEW_LOOP_EPOCH_SENTINELS = {
  /**
   * CI-failure epochs key on this sentinel instead of a real expected-bots hash so they NEVER
   * fold into a concurrent bot/human review epoch on the same head (the epoch unique key is
   * owner+session+prUrl+headSha+expectedBotsHash and does NOT include source_kind). Distinct hash =
   * distinct epoch row = CI fixing tracked independently of review-comment handling.
   */
  ciExpectedBotsHash: "ci-fixes",
  ciSourceKind: "ci",
  /**
   * Verification-intake epochs (the QTA needs-work verdict carried into the loop, RLA v2) key on
   * this sentinel for the same reason as CI epochs: a distinct expected_bots_hash keeps them from
   * folding into a concurrent bot/human review epoch on the same head.
   */
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationExpectedBotsHash: "verification-intake",
  verificationSourceKind: "verification",
  /**
   * Merge-conflict resolution epochs key on this sentinel so a dirty-head rescue turn can coexist
   * with bot, human, CI, and verification epochs on the same head without folding into their rows.
   */
  mergeConflictExpectedBotsHash: "merge-conflict",
  mergeConflictSourceKind: "merge_conflict",
  /**
   * `@cycloid` mention epochs key on this sentinel for the same reason as the CI/verification/
   * merge-conflict sentinels: a distinct expected_bots_hash (NOT the empty-human hash) keeps a
   * mention from folding into — or being folded into by — a concurrent bot/human/ci/verification/
   * merge-conflict epoch on the same head. A mention is an INDEPENDENT class (like `ci`): it is
   * matched by id, dispatches capabilities-only (even in manual review mode), and never suppresses
   * bot/human bootstrap. Multiple mentions on one head each take their own wave under this hash.
   */
  mentionExpectedBotsHash: "mention",
  mentionSourceKind: "mention",
} as const;

// Back-compat alias: the CI sentinel expected-bots hash. Prefer
// REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash in new code.
export const REVIEW_LOOP_CI_EPOCH_HASH = REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash;

/** Source kinds that rebuild a GitHub review-comment worklist. */
export type ReviewSourceKind = Exclude<ReviewLoopSourceKind, "ci" | "merge_conflict" | "mention">;

/**
 * A CI-fix epoch: tracks "address the failing CI checks on this head", waits on
 * no review bots, and uses `worklist_hash` as a failing-check NAME fingerprint
 * to drive the same-failure attempt cap (see `ciFailingCheckFingerprint`).
 *
 * A real TypeScript type predicate: the POSITIVE branch narrows `sourceKind` to
 * the CI literal. (The negative branch cannot SUBTRACT `'ci'` from the union, so
 * to get a compile-time bot/human/mixed narrowing in the not-CI case call
 * `isReviewEpoch`, whose positive branch narrows to `ReviewSourceKind`.)
 */
export function isCiEpoch<T extends { sourceKind: ReviewLoopSourceKind }>(
  epoch: T,
): epoch is T & { sourceKind: typeof REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind } {
  return epoch.sourceKind === REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind;
}

/**
 * A review epoch (bot | human | mixed | verification): tracks review-comment/bot feedback on a
 * head, and uses `worklist_hash` as the GitHub worklist hash that feeds the push
 * operation id for idempotency (see `reviewWorklistHash`). A real type
 * predicate: the POSITIVE branch narrows `sourceKind` to `ReviewSourceKind`
 * (bot/human/mixed/verification), giving callers downstream of `if (!isReviewEpoch(e)) return`
 * (or `if (isReviewEpoch(e)) { ... }`) a compile-time guarantee the epoch has a review worklist.
 */
export function isReviewEpoch<T extends { sourceKind: ReviewLoopSourceKind }>(
  epoch: T,
): epoch is T & { sourceKind: ReviewSourceKind } {
  return !isCiEpoch(epoch) && !isMergeConflictEpoch(epoch) && !isMentionEpoch(epoch);
}

/**
 * An `@cycloid` mention epoch: a user @-mentioned Cycloid on a PR (top-level comment, review-comment
 * reply, or review body) to pull it into that feedback. Like `ci`/`merge_conflict`, it is an
 * INDEPENDENT class — matched by id, keyed on a distinct sentinel expected_bots_hash so it never folds
 * into (or is folded into by) a bot/human/ci/verification/merge-conflict epoch on the same head, and it
 * dispatches capabilities-only (bypassing the review checklist) so a mention is honored even in manual
 * review mode. A real type predicate: the POSITIVE branch narrows `sourceKind` to the mention literal.
 */
export function isMentionEpoch<T extends { sourceKind: ReviewLoopSourceKind }>(
  epoch: T,
): epoch is T & { sourceKind: typeof REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind } {
  return epoch.sourceKind === REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind;
}

/**
 * The source ids a mention epoch AUTHORIZED the agent to reply to — the mention payload's target
 * `sourceIds`, falling back to `triggeringSourceIds` for legacy payloads that predate that field. This
 * is the EXACT set the sweep dispatch scopes the prompt to (`mention.sourceIds ?? triggeringSourceIds`),
 * so the reply handler's allow-list must use it rather than the raw `triggeringSourceIds`: a targeted
 * review-comment mention folds the replied-to PARENT into `triggeringSourceIds`/`handledSourceIds` for
 * cross-epoch dedup while keeping it OUT of the payload targets (it is context, not a reply target). Using
 * the triggering set would let an untrusted mention steer a reply onto the un-authorized parent comment.
 */
export function mentionReplyTargetSourceIds(epoch: {
  terminalEvidence: readonly unknown[];
  triggeringSourceIds: string[];
}): string[] {
  for (const entry of epoch.terminalEvidence) {
    if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "mention") {
      const sourceIds = (entry as MentionEpochEvidence).sourceIds;
      if (sourceIds && sourceIds.length > 0) return sourceIds;
      break;
    }
  }
  return epoch.triggeringSourceIds;
}

/**
 * A verification-intake epoch (RLA v2): carries the QTA needs-work verdict into the review loop.
 * Waits on no bots (immediately ready, like CI), but unlike CI it dispatches the comment-style
 * review worklist — with the managed QTA comment admitted — so it IS a review epoch
 * (`isReviewEpoch` true) for streaks, rollups, and the reply path.
 */
export function isVerificationEpoch<T extends { sourceKind: ReviewLoopSourceKind }>(
  epoch: T,
): epoch is T & { sourceKind: typeof REVIEW_LOOP_EPOCH_SENTINELS.verificationSourceKind } {
  return epoch.sourceKind === REVIEW_LOOP_EPOCH_SENTINELS.verificationSourceKind;
}

export function isMergeConflictEpoch<T extends { sourceKind: ReviewLoopSourceKind }>(
  epoch: T,
): epoch is T & { sourceKind: typeof REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind } {
  return epoch.sourceKind === REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind;
}

/**
 * The source kind cast to its review (non-CI) form, for the call sites that have
 * ALREADY established the epoch is not CI (e.g. immediately after an
 * `if (isCiEpoch(e)) return` early-return) and need to pass it where only the
 * review kinds are accepted. Centralizes the one narrowing point so the cast is
 * named and asserted rather than scattered inline `as` casts. Throws if misused
 * on a CI epoch, surfacing a logic error instead of silently mislabeling it.
 */
export function reviewSourceKind(epoch: { sourceKind: ReviewLoopSourceKind }): ReviewSourceKind {
  if (isCiEpoch(epoch)) {
    throw new Error("reviewSourceKind called on a CI epoch");
  }
  if (isMergeConflictEpoch(epoch)) {
    throw new Error("reviewSourceKind called on a merge-conflict epoch");
  }
  if (isMentionEpoch(epoch)) {
    throw new Error("reviewSourceKind called on a mention epoch");
  }
  // The negative branch of the isCiEpoch predicate narrows away the ci-literal intersection but
  // cannot SUBTRACT 'ci' from the sourceKind union, so the cast (now runtime-guarded by the throw
  // above) is still required to land on ReviewSourceKind.
  return epoch.sourceKind as ReviewSourceKind;
}

/**
 * Reusable SQL predicate selecting bot/human/mixed epochs ONLY — excludes ci-fix,
 * verification-intake, merge-conflict, AND mention epochs. Used by bot-bootstrap suppression
 * (`hasReviewLoopEpochForHead`) and human fold-in target selection (`selectLatestEpochForHead`): a
 * verification intake (created with `expectedBots: []`, worklist admitting only the managed QTA
 * comment) must never stand in for a real bot/human review epoch, or it would hide pending bot
 * feedback — bots already present, or whose webhook was missed, would then never be recovered. A
 * mention epoch is likewise its own independent class: it must not suppress bot/human bootstrap, and
 * a human review must never fold into a mention epoch's stored directive. Use inside a WHERE clause.
 */
export const REVIEW_LOOP_BOT_HUMAN_EPOCH_SQL_PREDICATE = `source_kind NOT IN ('${REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind}', '${REVIEW_LOOP_EPOCH_SENTINELS.verificationSourceKind}', '${REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind}', '${REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind}')`;

/**
 * Reads the overloaded `worklist_hash` column as the CI failing-check NAME
 * fingerprint — meaningful ONLY for CI-fix epochs (where it drives the
 * same-failure attempt cap). Returns null for review epochs and for CI epochs
 * that never recorded a fingerprint (completed-noop / head-changed-blocked).
 */
export function ciFailingCheckFingerprint(epoch: {
  sourceKind: ReviewLoopSourceKind;
  worklistHash: string | null;
}): string | null {
  if (!isCiEpoch(epoch)) return null;
  return epoch.worklistHash && epoch.worklistHash.length > 0 ? epoch.worklistHash : null;
}

/**
 * Reads the overloaded `worklist_hash` column as the GitHub worklist hash —
 * meaningful ONLY for review epochs (where it feeds the push operation id for
 * idempotency). Returns "" for a review epoch with no recorded hash (matching
 * the historical `epoch.worklistHash ?? ""` op-id input) and null for CI epochs.
 */
export function reviewWorklistHash(epoch: {
  sourceKind: ReviewLoopSourceKind;
  worklistHash: string | null;
}): string | null {
  if (!isReviewEpoch(epoch)) return null;
  return epoch.worklistHash ?? "";
}

export interface ReviewLoopEpoch {
  id: string;
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  wave: number;
  expectedBotsHash: string;
  expectedBots: PrReviewExpectedBot[];
  expectedBotKeys: string[];
  observedTerminalBots: string[];
  observedTerminalBotKeys: string[];
  observedTerminalBotCount: number;
  handledSourceIds: string[];
  triggeringSourceIds: string[];
  /**
   * Source ids actually included in a sent prompt. A strict subset of triggeringSourceIds; the
   * remainder (triggering − prompted) is feedback ingested into this epoch that was never put in
   * front of the agent (late fold-in, or blocked before dispatch) and is carried into a later
   * epoch by listKnownReviewLoopSourceIds rather than being treated as done.
   */
  promptedSourceIds: string[];
  promptedSourceRecords: PromptedReviewLoopSourceRecord[];
  /**
   * Budget-dropped worklist sourceIds this epoch dispatched but never put in front of the agent
   * (ARC-1226). Non-empty means the last dispatch was truncated; the settle paths re-drive the epoch
   * to `ready` (instead of `completed`) so the next sweep dispatches the carried tail once the
   * already-prompted items free up the 64KB body budget. Cleared to [] once the tail fully drains.
   */
  carriedForwardSourceIds: string[];
  /**
   * Consecutive carry-forward dispatch attempts that made NO forward progress — the carried tail did
   * not shrink (a crashed wave leaves it unchanged; a no-op settle resolves nothing) — since the last
   * shrink (ARC-1242). Reset to 0 on any wave that shrinks the tail. Drives
   * REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP so reclaim/crash cycles no longer prematurely park a
   * still-draining tail the way the reclaim-inflated attempt_count did.
   */
  carryForwardNoProgressCount: number;
  terminalEvidence: unknown[];
  timedOutBotKeys: string[];
  uncertainSourceIds: string[];
  firstActivityAt: number;
  fallbackAfterAt: number;
  status: ReviewLoopEpochStatus;
  sourceKind: ReviewLoopSourceKind;
  worklistHash: string | null;
  lastPromptId: string | null;
  blockedReason: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  reservationToken: string | null;
  attemptCount: number;
  transientFailureCount: number;
  contentionDeferralCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReviewLoopEpochRow {
  id: string;
  session_id: string;
  owner_user_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  pr_url: string;
  head_sha: string;
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  wave: number;
  expected_bots_hash: string;
  expected_bots_json: string;
  expected_bot_keys_json: string;
  observed_terminal_bots_json: string;
  observed_terminal_bot_keys_json: string;
  observed_terminal_bot_count: number;
  handled_source_ids_json: string;
  triggering_source_ids_json: string;
  prompted_source_ids_json: string;
  carried_forward_source_ids_json: string;
  carry_forward_no_progress_count: number;
  terminal_evidence_json: string;
  timed_out_bot_keys_json: string;
  uncertain_source_ids_json: string;
  first_activity_at: number;
  fallback_after_at: number;
  status: ReviewLoopEpochStatus;
  source_kind: ReviewLoopSourceKind;
  worklist_hash: string | null;
  last_prompt_id: string | null;
  blocked_reason: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  reservation_token: string | null;
  attempt_count: number;
  transient_failure_count: number;
  contention_deferral_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type ReviewLoopActivityInput = {
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  sourceId: string;
  botKey: string;
  botActorLogin: string | null;
  terminal: boolean;
  evidence: unknown;
  nowMs: number;
  sourceKind?: ReviewLoopSourceKind;
  humanSource?: { userId: number; login: string };
};

export interface PromptedReviewLoopSourceRecord {
  sourceId: string;
  promptedAtMs: number;
  /**
   * SHA-256 of the RAW (pre-truncation) body the agent was prompted with, recorded ONLY for
   * `review-body:*` sources. GitHub's reviews REST endpoint has no `updated_at` for a review body
   * and `submitted_at` does not change when a reviewer edits the body, so timestamp dedup cannot
   * detect a body edit. The hash lets the next wave re-admit an edited body (live hash differs)
   * while suppressing an unchanged one. Optional and fail-open: legacy records and every
   * non-`review-body` kind have no hash and keep the timestamp dedup path.
   */
  bodyHash?: string;
}

export interface KnownReviewLoopSources {
  promptedAtBySourceId: Map<string, number>;
  /**
   * Latest prompted body hash per `review-body:*` sourceId (see PromptedReviewLoopSourceRecord).
   * Optional/fail-open: consumers fall back to timestamp dedup when it is absent.
   */
  bodyHashBySourceId?: Map<string, string>;
  legacySourceIds: Set<string>;
  triggeringSourceIds: Set<string>;
}

const LEASE_MS = 5 * 60 * 1000;
/**
 * Lease window stamped on an in-flight epoch (enqueued/processing/publishing/waiting_for_owner).
 * If the owning prompt ends without driving a terminal transition (reply-only/no-op turn, sandbox
 * gone, crash), the lease expires and the sweep reclaims the epoch. Generous relative to LEASE_MS:
 * an in-flight prompt can run for many minutes, so the reclaim window must outlast a real turn to
 * avoid stealing an epoch from a prompt that is still working.
 */
const IN_FLIGHT_LEASE_MS = 30 * 60 * 1000;
/**
 * After this many claim attempts the sweep blocks the epoch (blocked_reason = attempt_cap_reached)
 * instead of re-driving it forever. attempt_count is bumped on every claimReviewLoopEpochForPrompt
 * and decremented when a claim defers without consuming an attempt (contention / transient). A genuine
 * recovery loop (reclaim → re-drive → reclaim …) is bounded by this cap.
 */
export const REVIEW_LOOP_ATTEMPT_CAP = 5;

/**
 * SHA-256 of the empty string — the canonical hash for an empty expected-bots list.
 * Pre-computed from computeExpectedPrReviewBotsHash([]) to avoid an async call at module load.
 */
export const EMPTY_EXPECTED_BOTS_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Shared "the bot has been OBSERVED as terminal" predicates for the review loop.
 *
 * A configured bot has "finished reviewing this head" when it reports ANY completed /
 * non-pending result — success, failure, neutral, cancelled, timed_out, action_required,
 * error, etc. — NOT only success. We exclude only the still-running states
 * (pending / queued / in_progress / empty / null), so a bot that posts a failing or neutral
 * conclusion is treated as done and the agent responds to it.
 *
 * This is intentionally DISTINCT from CI pass/fail (FAILING_CHECK_RUN_CONCLUSIONS in
 * github/pr.ts), which decides whether to escalate / open a CI-fix flow. A failing check is
 * still "observed terminal" here while also being a CI failure there. Do not conflate them.
 *
 * All three observation paths (webhook ingest, sweep backfill, bootstrap-from-head) MUST route
 * through these predicates so they agree on when an epoch's expected bots are all observed.
 */
const NON_TERMINAL_COMMIT_STATUS_STATES: ReadonlySet<string> = new Set(["pending"]);

export function isObservedTerminalCheckConclusion(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): boolean {
  const normalizedStatus = (status ?? "").trim().toLowerCase();
  // GitHub marks a check_run terminal via status === "completed"; any other status is still running.
  if (normalizedStatus !== "completed") return false;
  const normalizedConclusion = (conclusion ?? "").trim().toLowerCase();
  // A completed run with no conclusion has not actually resolved — treat as not-yet-terminal.
  return normalizedConclusion.length > 0;
}

export function isObservedTerminalCommitStatusState(state: string | null | undefined): boolean {
  const normalized = (state ?? "").trim().toLowerCase();
  if (normalized.length === 0) return false;
  return !NON_TERMINAL_COMMIT_STATUS_STATES.has(normalized);
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parsePromptedSourceRecords(raw: string | null | undefined): PromptedReviewLoopSourceRecord[] {
  return parseJsonArray<unknown>(raw).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as { sourceId?: unknown; promptedAtMs?: unknown; bodyHash?: unknown };
    if (typeof record.sourceId !== "string" || !record.sourceId) return [];
    if (typeof record.promptedAtMs !== "number" || !Number.isFinite(record.promptedAtMs)) return [];
    const bodyHash = typeof record.bodyHash === "string" && record.bodyHash ? record.bodyHash : undefined;
    return [{ sourceId: record.sourceId, promptedAtMs: record.promptedAtMs, ...(bodyHash ? { bodyHash } : {}) }];
  });
}

function parsePromptedSourceIds(raw: string | null | undefined): string[] {
  return parseJsonArray<unknown>(raw).flatMap((value) => {
    if (typeof value === "string" && value) return [value];
    if (value && typeof value === "object") {
      const sourceId = (value as { sourceId?: unknown }).sourceId;
      if (typeof sourceId === "string" && sourceId) return [sourceId];
    }
    return [];
  });
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

/**
 * Unions previously-recorded prompted source records with the ids in the current dispatch. Carried
 * forward ids keep their original promptedAtMs; ids in the current prompt are (re)stamped with the
 * dispatch time so edited-feedback dedup measures later edits against the latest time the source was
 * actually put in front of the agent. Used on reclaim re-enqueue so a smaller follow-up worklist
 * does not drop the first attempt's prompted ids.
 *
 * `promptedSourceBodyHashes` carries the raw-body hash for the `review-body:*` ids in the CURRENT
 * dispatch (see PromptedReviewLoopSourceRecord.bodyHash). A re-prompted id is (re)stamped with the
 * current body hash; an id only carried forward from `existing` keeps whatever hash it already had.
 */
function mergePromptedSourceRecords(
  existing: PromptedReviewLoopSourceRecord[],
  promptedSourceIds: string[],
  promptedAtMs: number,
  promptedSourceBodyHashes?: ReadonlyMap<string, string>,
): PromptedReviewLoopSourceRecord[] {
  const recordBySourceId = new Map<string, PromptedReviewLoopSourceRecord>();
  for (const record of existing) recordBySourceId.set(record.sourceId, record);
  for (const sourceId of promptedSourceIds) {
    if (!sourceId) continue;
    const bodyHash = promptedSourceBodyHashes?.get(sourceId);
    recordBySourceId.set(sourceId, { sourceId, promptedAtMs, ...(bodyHash ? { bodyHash } : {}) });
  }
  return sortedUnique(recordBySourceId.keys()).map((sourceId) => {
    const record = recordBySourceId.get(sourceId) as PromptedReviewLoopSourceRecord;
    return { sourceId, promptedAtMs: record.promptedAtMs, ...(record.bodyHash ? { bodyHash: record.bodyHash } : {}) };
  });
}

function expectedBotKeys(expectedBots: PrReviewExpectedBot[]): string[] {
  return sortedUnique(expectedBots.map(expectedBotKey));
}

function observedTerminalBotLogin(input: ReviewLoopActivityInput): string {
  return input.botActorLogin ? normalizeGitHubActorLogin(input.botActorLogin) : input.botKey;
}

function statusForObserved(
  expectedKeys: string[],
  observedKeys: string[],
  existingStatus?: ReviewLoopEpochStatus,
  sourceKind?: ReviewLoopSourceKind,
): ReviewLoopEpochStatus {
  // Walltime removal: epochs are immediately due — there is no `collecting` window. A live epoch keeps
  // its in-flight status; anything else (including a fresh insert) is `ready` for immediate dispatch.
  if (existingStatus && !["collecting", "ready"].includes(existingStatus)) return existingStatus;
  void expectedKeys;
  void observedKeys;
  void sourceKind;
  return "ready";
}

function rowToEpoch(row: ReviewLoopEpochRow): ReviewLoopEpoch {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    wave: row.wave,
    expectedBotsHash: row.expected_bots_hash,
    expectedBots: parseJsonArray<PrReviewExpectedBot>(row.expected_bots_json),
    expectedBotKeys: parseJsonArray<string>(row.expected_bot_keys_json),
    observedTerminalBots: parseJsonArray<string>(row.observed_terminal_bots_json),
    observedTerminalBotKeys: parseJsonArray<string>(row.observed_terminal_bot_keys_json),
    observedTerminalBotCount: row.observed_terminal_bot_count,
    handledSourceIds: parseJsonArray<string>(row.handled_source_ids_json),
    triggeringSourceIds: parseJsonArray<string>(row.triggering_source_ids_json),
    promptedSourceIds: parsePromptedSourceIds(row.prompted_source_ids_json),
    promptedSourceRecords: parsePromptedSourceRecords(row.prompted_source_ids_json),
    carriedForwardSourceIds: parseJsonArray<string>(row.carried_forward_source_ids_json),
    carryForwardNoProgressCount: row.carry_forward_no_progress_count ?? 0,
    terminalEvidence: parseJsonArray<unknown>(row.terminal_evidence_json),
    timedOutBotKeys: parseJsonArray<string>(row.timed_out_bot_keys_json),
    uncertainSourceIds: parseJsonArray<string>(row.uncertain_source_ids_json),
    firstActivityAt: row.first_activity_at,
    fallbackAfterAt: row.fallback_after_at,
    status: row.status,
    sourceKind: row.source_kind ?? "bot",
    worklistHash: row.worklist_hash,
    lastPromptId: row.last_prompt_id,
    blockedReason: row.blocked_reason,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    reservationToken: row.reservation_token,
    attemptCount: row.attempt_count,
    transientFailureCount: row.transient_failure_count,
    contentionDeferralCount: row.contention_deferral_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function selectLatestEpochByUniqueKey(
  db: D1Database,
  input: { ownerUserId: number; sessionId: string; prUrl: string; headSha: string; expectedBotsHash: string },
): Promise<ReviewLoopEpoch | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ? AND expected_bots_hash = ?
       ORDER BY wave DESC
       LIMIT 1`,
    )
    .bind(input.ownerUserId, input.sessionId, input.prUrl, input.headSha, input.expectedBotsHash)
    .first<ReviewLoopEpochRow>();
  return row ? rowToEpoch(row) : null;
}

/**
 * Returns the latest BOT/HUMAN/MIXED epoch for this (owner, session, prUrl, head), ignoring
 * expected_bots_hash. Used by the human webhook ingest path to fold a human review into an
 * in-flight bot wave regardless of which bots are configured.
 *
 * Excludes `ci` AND `verification` epochs: both are tracked independently of bot/human review
 * handling, so a human review must never fold into either (folding into a ci-keyed row drops the
 * feedback; folding into a verification-intake row leaves `source_kind='verification'` — see
 * `mergedSourceKind`, which only widens `bot`→`mixed` — so the human review would dispatch under the
 * QTA prompt instead of a human one). The `wave DESC, created_at DESC` ordering is a deterministic
 * tiebreaker when multiple bot/human/mixed epochs share the head.
 */
async function selectLatestEpochForHead(
  db: D1Database,
  input: { ownerUserId: number; sessionId: string; prUrl: string; headSha: string },
): Promise<ReviewLoopEpoch | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ? AND ${REVIEW_LOOP_BOT_HUMAN_EPOCH_SQL_PREDICATE}
       ORDER BY wave DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(input.ownerUserId, input.sessionId, input.prUrl, input.headSha)
    .first<ReviewLoopEpochRow>();
  return row ? rowToEpoch(row) : null;
}

export async function getReviewLoopEpochById(db: D1Database, epochId: string): Promise<ReviewLoopEpoch | null> {
  const row = await db
    .prepare(`SELECT * FROM pr_review_response_epochs WHERE id = ? LIMIT 1`)
    .bind(epochId)
    .first<ReviewLoopEpochRow>();
  return row ? rowToEpoch(row) : null;
}

/**
 * Returns the newest materialized CI epoch for this session/PR/head only after it completed. The FSM
 * uses this row as provenance when a still-red `caught_up` transition requests another CI-fix wave:
 * the aggregate FSM signal alone is not enough to invent a failing-check source id. A newer live or
 * blocked epoch proves that another retry must not be cloned from older provenance.
 */
export async function getLatestCiReviewLoopEpochForHead(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string },
): Promise<ReviewLoopEpoch | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND source_kind = 'ci'
       ORDER BY wave DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(input.sessionId, input.prUrl, input.headSha)
    .first<ReviewLoopEpochRow>();
  return row?.status === "completed" ? rowToEpoch(row) : null;
}

const MAX_EPOCH_ID_LOOKUP_BINDINGS = 100;

export async function listReviewLoopEpochsByIds(
  db: D1Database,
  epochIds: readonly string[],
): Promise<ReviewLoopEpoch[]> {
  const uniqueIds = [...new Set(epochIds)].filter((id) => id.length > 0);
  if (uniqueIds.length === 0) return [];

  const epochs: ReviewLoopEpoch[] = [];
  for (let index = 0; index < uniqueIds.length; index += MAX_EPOCH_ID_LOOKUP_BINDINGS) {
    const chunk = uniqueIds.slice(index, index + MAX_EPOCH_ID_LOOKUP_BINDINGS);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM pr_review_response_epochs WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<ReviewLoopEpochRow>();
    epochs.push(...(result.results ?? []).map(rowToEpoch));
  }
  return epochs;
}

/**
 * Returns the highest wave number across all epochs for a session, or 0 if none exist.
 * Used by reengageSessionForReview to compute the next wave for a human-triggered epoch.
 */
/**
 * Walks a session + PR's epochs newest-first, EXCLUDING the current epoch, and counts prior
 * consecutive `ci` epochs until the first non-`ci` (review-bearing) epoch, which BREAKS the walk.
 * Only ci epochs that recorded a fingerprint (non-null, non-empty `worklist_hash` — a real fix
 * attempt set at enqueue or at same-failure cap-block) are counted; ci epochs with a NULL/''
 * `worklist_hash` (completed-noop on flaky-green CI, or head_changed-blocked before enqueue) are
 * SKIPPED — neither counted nor allowed to break the same-fingerprint contiguity.
 * Returns two streaks computed from the SAME contiguous run of prior counted `ci` epochs:
 *
 *   - `sameFingerprintStreak`: count of consecutive prior `ci` epochs (contiguous from newest)
 *     whose stored `worklist_hash` (the failing-check fingerprint recorded at enqueue) EQUALS the
 *     current fingerprint. Counting stops at the FIRST prior ci epoch with a different fingerprint
 *     — the failing-set changed, so the situation is no longer "the same checks" and an older run
 *     does not count toward the same-failure cap. Drives the same-failure cap.
 *   - `totalConsecutiveStreak`: count of ALL consecutive prior `ci` epochs until the first non-ci
 *     epoch, regardless of fingerprint. Drives the total-attempt backstop for oscillating failures
 *     that never converge.
 *
 * The fingerprint is now the reset signal: a review-bearing epoch still breaks both streaks, but
 * there is no longer a "stop at a blocked ci_attempt_cap_reached boundary" rule — a new commit that
 * changes the failing-check set naturally resets `sameFingerprintStreak` on its own.
 */
export async function countConsecutiveCiFixEpochsForPr(
  db: D1Database,
  input: { sessionId: string; prUrl: string; excludeEpochId: string; fingerprint: string },
): Promise<{ sameFingerprintStreak: number; totalConsecutiveStreak: number }> {
  const rows = await db
    .prepare(
      `SELECT id, source_kind, worklist_hash FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ?
       ORDER BY created_at DESC, wave DESC`,
    )
    .bind(input.sessionId, input.prUrl)
    .all<{ id: string; source_kind: string; worklist_hash: string | null }>();
  // Per-check-NAME streaks: for each failing check in the CURRENT set, count consecutive prior ci
  // attempts (contiguous from newest) whose failing set ALSO contained that check. `sameFingerprintStreak`
  // (name kept for the sweep's cap read) is the MAX over the current names, so a check that fails every
  // round caps even as OTHER checks come and go. Exact-fingerprint matching would reset on any set change
  // (e.g. lint joining/leaving typecheck) and erode the same-failure cap down to the 6-attempt backstop.
  // For legacy/opaque worklist hashes the name set is the whole string (singleton), so this degrades to
  // the old exact-match behavior for them.
  const currentNames = parseCiFailingCheckNames(input.fingerprint);
  const perNameStreak = new Map<string, number>(currentNames.map((name) => [name, 0]));
  const perNameContiguous = new Map<string, boolean>(currentNames.map((name) => [name, true]));
  let totalConsecutiveStreak = 0;
  for (const row of rows.results ?? []) {
    if (row.id === input.excludeEpochId) continue; // don't count the attempt we're about to make
    // Adapt the projected row to the predicate/accessor shape so the ci-vs-review
    // classification and the worklist_hash-as-fingerprint reading go through the
    // same named helpers used everywhere else.
    const epochView = { sourceKind: row.source_kind as ReviewLoopSourceKind, worklistHash: row.worklist_hash };
    if (!isCiEpoch(epochView)) break; // any non-CI PR attempt resets every streak
    // Only a ci epoch that recorded a fingerprint (at enqueue, or at same-failure cap-block) is a
    // real fix ATTEMPT. Skip — do NOT count and do NOT break contiguity on — ci epochs with a
    // NULL/'' worklist_hash: those are completed-noops (CI self-resolved; worklist_hash stored as ''
    // via COALESCE) or head_changed-blocked epochs that never enqueued. Counting them would inflate
    // the backstop on flaky/green CI; breaking on them would reset a per-name streak for an identical
    // failure that straddles a flaky-green attempt.
    const fingerprint = ciFailingCheckFingerprint(epochView);
    if (!fingerprint) continue;
    totalConsecutiveStreak += 1;
    const priorNames = new Set(parseCiFailingCheckNames(fingerprint));
    for (const name of currentNames) {
      if (!perNameContiguous.get(name)) continue;
      if (priorNames.has(name)) {
        perNameStreak.set(name, (perNameStreak.get(name) ?? 0) + 1);
      } else {
        // This check was absent from an intervening attempt — its consecutive streak stops here.
        perNameContiguous.set(name, false);
      }
    }
  }
  const sameFingerprintStreak = currentNames.reduce((max, name) => Math.max(max, perNameStreak.get(name) ?? 0), 0);
  return { sameFingerprintStreak, totalConsecutiveStreak };
}

export type PriorCiFixAttemptContext = {
  epochId: string;
  promptId: string | null;
  headSha: string;
  failingCheckFingerprint: string;
  status: ReviewLoopEpochStatus;
};

export async function getLatestPriorMatchingCiFixAttempt(
  db: D1Database,
  input: { sessionId: string; prUrl: string; excludeEpochId: string; fingerprint: string },
): Promise<PriorCiFixAttemptContext | null> {
  const currentNames = new Set(parseCiFailingCheckNames(input.fingerprint));
  const rows = await db
    .prepare(
      `SELECT id, source_kind, head_sha, worklist_hash, last_prompt_id, status
       FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ?
       ORDER BY created_at DESC, wave DESC`,
    )
    .bind(input.sessionId, input.prUrl)
    .all<{
      id: string;
      source_kind: string;
      head_sha: string;
      worklist_hash: string | null;
      last_prompt_id: string | null;
      status: ReviewLoopEpochStatus;
    }>();
  for (const row of rows.results ?? []) {
    if (row.id === input.excludeEpochId) continue;
    const epochView = { sourceKind: row.source_kind as ReviewLoopSourceKind, worklistHash: row.worklist_hash };
    if (!isCiEpoch(epochView)) break;
    const fingerprint = ciFailingCheckFingerprint(epochView);
    if (!fingerprint) continue;
    const priorNames = parseCiFailingCheckNames(fingerprint);
    if (!priorNames.some((name) => currentNames.has(name))) continue;
    return {
      epochId: row.id,
      promptId: row.last_prompt_id,
      headSha: row.head_sha,
      failingCheckFingerprint: fingerprint,
      status: row.status,
    };
  }
  return null;
}

/**
 * Whether this session + PR already has a `ci` epoch on the given head that was blocked with
 * reason `ci_attempt_cap_reached`. Used to dedup the cap escalation: once we have escalated for a
 * head, do not re-post the PR comment when another ci epoch on the SAME head also hits the cap.
 */
async function hasCiEscalationForHead(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string; excludeEpochId: string; blockedReason: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND id != ?
         AND source_kind = 'ci' AND status = 'blocked' AND blocked_reason = ?
       LIMIT 1`,
    )
    .bind(input.sessionId, input.prUrl, input.headSha, input.excludeEpochId, input.blockedReason)
    .first<{ hit: number }>();
  return row !== null;
}

export async function hasCiAttemptCapEscalationForHead(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string; excludeEpochId: string },
): Promise<boolean> {
  return hasCiEscalationForHead(db, { ...input, blockedReason: "ci_attempt_cap_reached" });
}

/**
 * Whether this session + PR already has a `ci` epoch on the given head that was blocked with reason
 * `ci_checks_pending_cap_reached`. Dedups the pending-timeout escalation the same way
 * hasCiAttemptCapEscalationForHead dedups the attempt-cap escalation: a new CI wave on the SAME head
 * that crosses the pending timeout again must not re-post the comment.
 */
export async function hasCiPendingCapEscalationForHead(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string; excludeEpochId: string },
): Promise<boolean> {
  return hasCiEscalationForHead(db, { ...input, blockedReason: "ci_checks_pending_cap_reached" });
}

/**
 * Total review-loop epochs recorded for a session + PR across all heads/waves. Feeds the
 * `total_epochs` rollup on the `review_loop.settled` telemetry event (oscillation / epochs-per-PR
 * signal). Telemetry-only; never gates control flow.
 */
export async function countReviewLoopEpochsForPr(
  db: D1Database,
  input: { sessionId: string; prUrl: string },
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS epoch_count FROM pr_review_response_epochs WHERE session_id = ? AND pr_url = ?`)
    .bind(input.sessionId, input.prUrl)
    .first<{ epoch_count: number }>();
  return row?.epoch_count ?? 0;
}

/**
 * Looks up the latest human-source epoch for a given session + prUrl + headSha
 * (keyed on owner_user_id, session_id, pr_url, head_sha, expected_bots_hash=EMPTY).
 * Used by reengageSessionForReview to detect already_reengaged before bootstrap.
 */
/**
 * The highest-wave epoch for this head that already carries `sourceId` in its triggering set, across
 * ALL waves and expected-bots hashes — NOT just the latest wave. This is the idempotency anchor for
 * human reviews once distinct reviews split into separate waves (`epochCarriesDifferentHumanReview`):
 * `selectLatestEpochByUniqueKey` only reads `wave DESC LIMIT 1`, so a re-ingest or re-engage of
 * review A after a newer review B took the top wave would miss A's own older wave and open a
 * duplicate wave. Scanning every wave for the carrying epoch keeps the same review folding into the
 * wave it already owns (constraint: a redelivered review is idempotent).
 *
 * Filters triggering membership in the app layer (like the other epoch reads) rather than a SQL
 * `json_each`, so the FakeD1 test harness exercises the same path.
 */
export async function selectHumanEpochCarryingSource(
  db: D1Database,
  input: { ownerUserId: number; sessionId: string; prUrl: string; headSha: string },
  sourceId: string,
): Promise<ReviewLoopEpoch | null> {
  const rows = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ?
       ORDER BY wave DESC`,
    )
    .bind(input.ownerUserId, input.sessionId, input.prUrl, input.headSha)
    .all<ReviewLoopEpochRow>();
  for (const row of rows.results ?? []) {
    const epoch = rowToEpoch(row);
    if (epoch.triggeringSourceIds.includes(sourceId)) return epoch;
  }
  return null;
}

/**
 * Source IDs a prior epoch for this session + PR has already accounted for, used to decide whether
 * a head change carries genuinely new feedback before bootstrapping a fresh epoch (so a clean
 * re-review of Cycloid's own review-response push does not re-trigger the loop).
 *
 * An id counts as "known" when EITHER:
 *  - it was actually prompted by any epoch (prompted_source_ids_json — the work was put in front of
 *    the agent, so it is done), OR
 *  - it triggered a still-live epoch (status != 'blocked'). A live or completed epoch's ingested
 *    ids stay known so a re-review that only repeats them does not re-trigger.
 *
 * A blocked epoch's triggering ids are deliberately EXCLUDED unless they were also prompted: when an
 * epoch is blocked by a head change before it could prompt some ingested feedback (e.g. a human
 * review folded in after the prompt was already in flight), that feedback was never addressed and
 * must carry forward into the next epoch. GitHub keeps a comment's databaseId stable across head
 * changes, so once carried-forward feedback is prompted its prompted id matches on later heads and
 * the loop does not run forever.
 */
export async function listKnownReviewLoopSources(
  db: D1Database,
  input: { sessionId: string; prUrl: string },
): Promise<KnownReviewLoopSources> {
  const { results } = await db
    .prepare(
      `SELECT status, triggering_source_ids_json, prompted_source_ids_json
         FROM pr_review_response_epochs
        WHERE session_id = ? AND pr_url = ?`,
    )
    .bind(input.sessionId, input.prUrl)
    .all<{ status: ReviewLoopEpochStatus; triggering_source_ids_json: string; prompted_source_ids_json: string }>();
  const promptedSources = accumulatePromptedSources(results ?? []);
  const triggeringSourceIds = new Set<string>();
  for (const row of results ?? []) {
    if (row.status !== "blocked") {
      for (const sourceId of parseJsonArray<string>(row.triggering_source_ids_json)) triggeringSourceIds.add(sourceId);
    }
  }
  return { ...promptedSources, triggeringSourceIds };
}

export async function listKnownReviewLoopSourceIds(
  db: D1Database,
  input: { sessionId: string; prUrl: string },
): Promise<Set<string>> {
  const knownSources = await listKnownReviewLoopSources(db, input);
  const known = new Set<string>([
    ...knownSources.promptedAtBySourceId.keys(),
    ...knownSources.legacySourceIds,
    ...knownSources.triggeringSourceIds,
  ]);
  return known;
}

/**
 * Prompted source metadata for dispatch dedup. Timestamped records suppress only true replays:
 * a worklist item is skipped when its GitHub updatedAtMs is not newer than the prompt time recorded
 * here. Legacy string-only entries stay in legacySourceIds and retain the old suppress-by-id
 * behavior.
 */
export async function listPromptedReviewLoopSources(
  db: D1Database,
  input: { sessionId: string; prUrl: string; excludeEpochId: string },
): Promise<{
  promptedAtBySourceId: Map<string, number>;
  bodyHashBySourceId: Map<string, string>;
  legacySourceIds: Set<string>;
}> {
  const { results } = await db
    .prepare(
      `SELECT prompted_source_ids_json
         FROM pr_review_response_epochs
        WHERE session_id = ? AND pr_url = ? AND id != ?`,
    )
    .bind(input.sessionId, input.prUrl, input.excludeEpochId)
    .all<{ prompted_source_ids_json: string }>();
  return accumulatePromptedSources(results ?? []);
}

type AccumulatedPromptedSources = {
  promptedAtBySourceId: Map<string, number>;
  bodyHashBySourceId: Map<string, string>;
  legacySourceIds: Set<string>;
};

function createPromptedSourceAccumulator(): AccumulatedPromptedSources {
  return {
    promptedAtBySourceId: new Map<string, number>(),
    bodyHashBySourceId: new Map<string, string>(),
    legacySourceIds: new Set<string>(),
  };
}

function addPromptedSourceRecord(
  accumulator: AccumulatedPromptedSources,
  record: PromptedReviewLoopSourceRecord,
): void {
  const current = accumulator.promptedAtBySourceId.get(record.sourceId);
  if (current === undefined || record.promptedAtMs > current) {
    accumulator.promptedAtBySourceId.set(record.sourceId, record.promptedAtMs);
    // Keep the body hash colocated with the latest prompt time; clear a stale hash if the
    // newest record has none so we never compare against an older epoch's hash.
    if (record.bodyHash) accumulator.bodyHashBySourceId.set(record.sourceId, record.bodyHash);
    else accumulator.bodyHashBySourceId.delete(record.sourceId);
  }
}

export function accumulatePromptedSourceRecords(input: {
  records: Iterable<PromptedReviewLoopSourceRecord>;
  legacySourceIds?: Iterable<string>;
}): AccumulatedPromptedSources {
  const accumulator = createPromptedSourceAccumulator();
  for (const record of input.records) addPromptedSourceRecord(accumulator, record);
  for (const sourceId of input.legacySourceIds ?? []) {
    if (sourceId) accumulator.legacySourceIds.add(sourceId);
  }
  return accumulator;
}

export function accumulatePromptedSources(
  rows: Iterable<{ prompted_source_ids_json: string }>,
): AccumulatedPromptedSources {
  const accumulator = createPromptedSourceAccumulator();
  for (const row of rows) {
    const records = parsePromptedSourceRecords(row.prompted_source_ids_json);
    const recordedSourceIds = new Set(records.map((record) => record.sourceId));
    for (const record of records) addPromptedSourceRecord(accumulator, record);
    for (const sourceId of parsePromptedSourceIds(row.prompted_source_ids_json)) {
      // parsePromptedSourceIds already strips falsy strings; the sourceId guard is
      // defense-in-depth mirroring accumulatePromptedSourceRecords' legacy-id loop.
      if (sourceId && !recordedSourceIds.has(sourceId)) accumulator.legacySourceIds.add(sourceId);
    }
  }
  return accumulator;
}

const MAX_EPOCH_MERGE_CAS_ATTEMPTS = 5;

function mergedSourceKind(current: ReviewLoopSourceKind, input: ReviewLoopActivityInput): ReviewLoopSourceKind {
  // A human fold-in only widens a bot epoch to mixed; folding another human into a
  // human-only epoch keeps it human (mixed specifically means bot + human). Every other kind —
  // including `mention` — is returned UNCHANGED: mention/ci/verification/merge_conflict are keyed on
  // distinct sentinel hashes so they are never selected as the fold target in the first place, and
  // even if one were, this must never relabel it (a mention that widened to `mixed` would dispatch
  // under the review-worklist path instead of its stored directive).
  return input.humanSource && current === "bot" ? "mixed" : current;
}

// Returns the merged epoch, or null when a concurrent writer froze/terminated the epoch mid-CAS and
// the source now warrants its own new wave — the caller must re-select and re-decide.
async function updateEpochMerge(
  db: D1Database,
  existing: ReviewLoopEpoch,
  input: ReviewLoopActivityInput,
): Promise<ReviewLoopEpoch | null> {
  let current = existing;

  for (let attempt = 0; attempt < MAX_EPOCH_MERGE_CAS_ATTEMPTS; attempt += 1) {
    const isHuman = Boolean(input.humanSource);
    const handledSourceIds = sortedUnique([...current.handledSourceIds, input.sourceId]);
    const triggeringSourceIds = sortedUnique([...current.triggeringSourceIds, input.sourceId]);
    // Human fold-in: do NOT accumulate bot terminal keys/evidence
    const observedTerminalBotKeys =
      !isHuman && input.terminal
        ? sortedUnique([...current.observedTerminalBotKeys, input.botKey])
        : current.observedTerminalBotKeys;
    const observedTerminalBots =
      !isHuman && input.terminal
        ? sortedUnique([...current.observedTerminalBots, observedTerminalBotLogin(input)])
        : current.observedTerminalBots;
    const terminalEvidence =
      !isHuman && !current.handledSourceIds.includes(input.sourceId) && input.terminal
        ? [...current.terminalEvidence, input.evidence]
        : current.terminalEvidence;
    const sourceKind = mergedSourceKind(current.sourceKind, input);
    const status = statusForObserved(current.expectedBotKeys, observedTerminalBotKeys, current.status, sourceKind);

    const result = await db
      .prepare(
        `UPDATE pr_review_response_epochs
         SET observed_terminal_bots_json = ?,
             observed_terminal_bot_keys_json = ?,
             observed_terminal_bot_count = ?,
             handled_source_ids_json = ?,
             triggering_source_ids_json = ?,
             terminal_evidence_json = ?,
             status = ?,
             source_kind = ?,
             updated_at = ?
         WHERE id = ?
           AND status = ?
           AND source_kind = ?
           AND observed_terminal_bots_json = ?
           AND observed_terminal_bot_keys_json = ?
           AND observed_terminal_bot_count = ?
           AND handled_source_ids_json = ?
           AND triggering_source_ids_json = ?
           AND terminal_evidence_json = ?`,
      )
      .bind(
        JSON.stringify(observedTerminalBots),
        JSON.stringify(observedTerminalBotKeys),
        observedTerminalBotKeys.length,
        JSON.stringify(handledSourceIds),
        JSON.stringify(triggeringSourceIds),
        JSON.stringify(terminalEvidence),
        status,
        sourceKind,
        input.nowMs,
        current.id,
        current.status,
        current.sourceKind,
        JSON.stringify(current.observedTerminalBots),
        JSON.stringify(current.observedTerminalBotKeys),
        current.observedTerminalBotCount,
        JSON.stringify(current.handledSourceIds),
        JSON.stringify(current.triggeringSourceIds),
        JSON.stringify(current.terminalEvidence),
      )
      .run();

    if (d1Changed(result)) return (await getReviewLoopEpochById(db, current.id))!;

    const fresh = await getReviewLoopEpochById(db, current.id);
    if (!fresh) throw new Error("Review-loop epoch disappeared during activity merge");
    // The CAS lost: a concurrent writer changed the row since we decided to fold in. It may have frozen
    // the worklist (collecting/ready → reserving/enqueued) or terminated the epoch (completed/blocked).
    // Re-evaluate the wave decision against the fresh row before re-folding: if it now warrants a new
    // wave (e.g. a human review whose matched epoch just got claimed for prompting), bail so the caller
    // re-selects and starts a new immediately-due wave — folding it into the now-frozen worklist would
    // strand the reviewer's instruction (it would never reach a prompt, yet be treated as known).
    if (shouldStartNewWave(fresh, input)) return null;
    current = fresh;
  }

  throw new Error("Review-loop epoch activity merge CAS retries exhausted");
}

/**
 * Inserts a fresh epoch wave. Returns null when the row was ignored because a
 * competing writer already committed the same unique key (lost race); the
 * caller must re-select and verify the winner exists — OR IGNORE suppresses
 * ANY constraint violation, so a missing winner means something other than
 * the unique key fired.
 *
 * The statement is d1-retry-safe: a wrapper retry replays the same bound id,
 * so a replay of a committed insert reports changes = 0, resolves as a lost
 * race, and the caller converges on the committed row.
 */
async function insertReviewLoopEpochActivity(
  db: D1Database,
  input: ReviewLoopActivityInput,
  wave: number,
): Promise<ReviewLoopEpoch | null> {
  const id = crypto.randomUUID();
  const isHuman = Boolean(input.humanSource);
  const sourceKind: ReviewLoopSourceKind = isHuman ? "human" : (input.sourceKind ?? "bot");
  const expectedKeys = expectedBotKeys(input.expectedBots);
  // Human fold-in: do NOT accumulate bot terminal keys on insert
  const observedKeys = !isHuman && input.terminal ? [input.botKey] : [];
  const observedBots = !isHuman && input.terminal ? [observedTerminalBotLogin(input)] : [];
  const terminalEvidence = !isHuman && input.terminal ? [input.evidence] : [];
  const status = statusForObserved(expectedKeys, observedKeys, undefined, sourceKind);
  const repoOwner = input.repoOwner.trim().toLowerCase();
  const repoName = input.repoName.trim().toLowerCase();
  // Walltime removal: every epoch is immediately due. `fallback_after_at` is retained as the row's
  // due-timestamp = insert time; there is no collection window.
  const fallbackAfterAt = input.nowMs;

  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO pr_review_response_epochs (
        id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
        expected_bots_hash, expected_bots_json, expected_bot_keys_json,
        observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
        handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
        timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
        status, source_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.sessionId,
      input.ownerUserId,
      repoOwner,
      repoName,
      input.prNumber,
      input.prUrl,
      input.headSha,
      wave,
      input.expectedBotsHash,
      JSON.stringify(input.expectedBots),
      JSON.stringify(expectedKeys),
      JSON.stringify(observedBots),
      JSON.stringify(observedKeys),
      observedKeys.length,
      JSON.stringify([input.sourceId]),
      JSON.stringify([input.sourceId]),
      JSON.stringify(terminalEvidence),
      JSON.stringify([]),
      JSON.stringify([]),
      input.nowMs,
      fallbackAfterAt,
      status,
      sourceKind,
      input.nowMs,
      input.nowMs,
    )
    .run();

  if (!d1Changed(result)) return null;
  return (await getReviewLoopEpochById(db, id))!;
}

// An epoch can still absorb new prompt content only while it is collecting signals. Once it has been
// claimed for prompting ("reserving") or dispatched ("enqueued" and beyond), its worklist is frozen:
// the sweep snapshots triggeringSourceIds at claim time, so anything folded in after that never
// reaches the prompt. "ready" is still open — the claim (and the worklist snapshot) happens after.
// NOTE (walltime removal): `collecting` is now unreachable — the effective fold window is `ready`
// (the pre-dispatch state). Kept in the set as a harmless legacy guard; a live epoch stops folding.
function epochAcceptsFoldIn(epoch: ReviewLoopEpoch): boolean {
  return epoch.status === "collecting" || epoch.status === "ready";
}

// A source is "accounted for" by an epoch once it was either ingested via webhook (handledSourceIds)
// or shown to the agent (promptedSourceIds). "prompted = done" — mirrors listKnownReviewLoopSourceIds,
// so a late webhook for an already-prompted source folds in rather than spawning a redundant wave.
function epochAccountsForSource(epoch: ReviewLoopEpoch, sourceId: string): boolean {
  return epoch.handledSourceIds.includes(sourceId) || epoch.promptedSourceIds.includes(sourceId);
}

// True when this epoch already carries a DIFFERENT human review than the incoming human source. Each
// human review must own its own wave so `fetchReviewLoopReviewThreadItems` scopes the worklist to just
// that review's comments (folding two reviews into one epoch leaks the sibling review's inline
// comments). The `sourceId !== input.sourceId` guard keeps the SAME review (a redelivery) folding
// rather than splitting.
//
// The `sourceKind` gate is load-bearing: `human:<reviewId>` is the PR-review-SUBMISSION namespace for
// BOTH humans and bots (a bot review is ingested with `sourceId: human:<reviewId>` and no humanSource
// — see handlePullRequestReviewEvent's bot path), so the prefix alone does NOT prove a human authored
// the carried source. Only `human` and `mixed` epochs actually carry a human review; a pure `bot`
// epoch must still WIDEN to `mixed` when a human folds in, not split the human off.
function epochCarriesDifferentHumanReview(epoch: ReviewLoopEpoch, input: ReviewLoopActivityInput): boolean {
  if (!input.humanSource) return false;
  if (epoch.sourceKind !== "human" && epoch.sourceKind !== "mixed") return false;
  return epoch.triggeringSourceIds.some(
    (sourceId) => sourceId !== input.sourceId && parseReviewLoopSourceNumericId(sourceId, "human") !== null,
  );
}

function shouldStartNewWave(epoch: ReviewLoopEpoch, input: ReviewLoopActivityInput): boolean {
  // A terminal epoch can no longer fold anything: a source it never accounted for opens a new wave.
  if (["completed", "blocked"].includes(epoch.status)) return !epochAccountsForSource(epoch, input.sourceId);
  // A human review that arrives once the matched epoch's worklist is frozen (claimed/dispatched)
  // cannot ride along — folding it in would only record unprompted triggering that never reaches the
  // agent (and, if the epoch later completes rather than blocks, would be treated as done). Give it
  // its own immediately-due wave instead. Bot signals still fold so terminal accumulation completes.
  if (input.humanSource && !epochAcceptsFoldIn(epoch)) return !epochAccountsForSource(epoch, input.sourceId);
  // A distinct human review does not fold into an epoch that already carries another human review; it
  // takes its own wave so each worklist is scoped to a single review. Reached only after the
  // upsert-level idempotency guard has ruled out a redelivery of a review some wave already carries,
  // so this never duplicates an existing review's wave.
  if (epochCarriesDifferentHumanReview(epoch, input)) return true;
  return false;
}

function humanOnlyNewWaveInput(input: ReviewLoopActivityInput): ReviewLoopActivityInput {
  if (!input.humanSource || input.expectedBotsHash === EMPTY_EXPECTED_BOTS_HASH) return input;
  return { ...input, expectedBots: [], expectedBotsHash: EMPTY_EXPECTED_BOTS_HASH };
}

export async function upsertReviewLoopEpochActivity(
  db: D1Database,
  input: ReviewLoopActivityInput,
): Promise<ReviewLoopEpoch> {
  // Cross-wave idempotency: once distinct human reviews split into separate waves, a redelivery or
  // re-engage of a review some (possibly older) wave already carries must fold into that wave, not
  // open a duplicate. `selectLatestEpochByUniqueKey` below only sees the top wave and would treat the
  // older review as "different", so scan every wave for the carrying epoch first and return it. Bots
  // keep their existing per-key accumulation; only human sources need the all-waves lookup.
  if (input.humanSource) {
    const carrying = await selectHumanEpochCarryingSource(
      db,
      { ownerUserId: input.ownerUserId, sessionId: input.sessionId, prUrl: input.prUrl, headSha: input.headSha },
      input.sourceId,
    );
    if (carrying) return carrying;
  }

  let selectedKeyInput = input;
  for (let attempt = 0; attempt < MAX_EPOCH_MERGE_CAS_ATTEMPTS; attempt += 1) {
    const existing = await selectLatestEpochByUniqueKey(db, selectedKeyInput);
    if (!existing) {
      const inserted = await insertReviewLoopEpochActivity(db, selectedKeyInput, 1);
      if (inserted) return inserted;
      await assertEpochInsertLostRace(db, selectedKeyInput, 0);
      continue; // fold into the race winner on the next iteration
    }
    if (!shouldStartNewWave(existing, selectedKeyInput)) {
      const merged = await updateEpochMerge(db, existing, selectedKeyInput);
      if (merged) return merged;
      // updateEpochMerge bailed: the epoch froze/terminated mid-CAS. Re-select and re-decide — the next
      // iteration sees the frozen epoch and routes to the new-wave arm below.
      continue;
    }

    const newWaveInput = humanOnlyNewWaveInput(selectedKeyInput);
    const inserted = await insertReviewLoopEpochActivity(db, newWaveInput, existing.wave + 1);
    if (inserted) return inserted;
    await assertEpochInsertLostRace(db, newWaveInput, existing.wave);
    selectedKeyInput = newWaveInput;
    continue; // fold into the race winner on the next iteration (mirrors the wave-1 arm)
  }

  throw new Error("Review-loop epoch wave insert retries exhausted");
}

/**
 * An ignored epoch insert is only legitimate when a competing writer committed
 * a row with the same unique key at a higher wave. If no such row exists, the
 * OR IGNORE masked a different constraint (e.g. a primary-key collision) and
 * looping would retry forever — surface it instead.
 */
async function assertEpochInsertLostRace(
  db: D1Database,
  input: ReviewLoopActivityInput,
  minExpectedWave: number,
): Promise<void> {
  const winner = await selectLatestEpochByUniqueKey(db, input);
  if (!winner || winner.wave <= minExpectedWave) {
    throw new Error("Review-loop epoch insert was ignored without a matching unique-key row");
  }
}

export async function listDueReviewLoopEpochs(
  db: D1Database,
  options: { nowMs: number; limit: number },
): Promise<ReviewLoopEpoch[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE status = 'ready'
          OR (status = 'reserving' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       ORDER BY CASE
         WHEN status = 'reserving' THEN lease_expires_at
         ELSE updated_at
       END ASC, updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(options.nowMs, options.limit)
    .all<ReviewLoopEpochRow>();
  return (rows.results ?? []).map(rowToEpoch);
}

type ReviewLoopEpochHeadLookup = { sessionId: string; prUrl: string; headSha: string };

async function reviewLoopEpochHeadExists(
  statement: D1PreparedStatement,
  options: ReviewLoopEpochHeadLookup,
): Promise<boolean> {
  const row = await statement.bind(options.sessionId, options.prUrl, options.headSha).first<{ hit: number }>();
  return row !== null;
}

/**
 * Whether a BOT/HUMAN/MIXED epoch already exists for this head. Used by head reconciliation to
 * decide whether to bootstrap a fresh bot/human epoch from head signals.
 *
 * Excludes `ci`, `verification`, and `merge_conflict` epochs: those independent rescue/intake loops
 * must not suppress bootstrapping a real bot/human review epoch on the same head. CI fixing,
 * verification intake, and merge-conflict resolution are tracked independently; counting any of them
 * here would hide pending bot feedback (see `REVIEW_LOOP_BOT_HUMAN_EPOCH_SQL_PREDICATE`).
 */
export async function hasReviewLoopEpochForHead(db: D1Database, options: ReviewLoopEpochHeadLookup): Promise<boolean> {
  return reviewLoopEpochHeadExists(
    db.prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND ${REVIEW_LOOP_BOT_HUMAN_EPOCH_SQL_PREDICATE}
       LIMIT 1`,
    ),
    options,
  );
}

/**
 * Whether a bot/mixed expected-reviewer collection epoch exists for this head. Human-only epochs are
 * immediately due and do not prove configured review bots have arrived or timed out, so the sweep uses
 * this narrower predicate for the expected-bot no-show gate.
 */
export async function hasExpectedBotReviewLoopEpochForHead(
  db: D1Database,
  options: ReviewLoopEpochHeadLookup,
): Promise<boolean> {
  return reviewLoopEpochHeadExists(
    db.prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ?
         AND (source_kind IS NULL OR source_kind IN ('bot', 'mixed'))
       LIMIT 1`,
    ),
    options,
  );
}

/**
 * Whether a CI-fix epoch already exists for this head. The structural complement of
 * `hasReviewLoopEpochForHead` (which excludes `ci` rows): keyed on the CI sentinel
 * (`source_kind = 'ci'`) so it matches ONLY ci-fix epochs and never a bot/human review epoch.
 *
 * Head reconciliation uses this to bound CI recovery to the catch-up window: once a ci-fix epoch
 * exists for the head, the per-tick GitHub check-runs poll + recovery is skipped (the live
 * `check_run` webhook now owns subsequent CI failures on that head).
 */
export async function hasCiReviewLoopEpochForHead(
  db: D1Database,
  options: ReviewLoopEpochHeadLookup,
): Promise<boolean> {
  return reviewLoopEpochHeadExists(
    db.prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND source_kind = '${REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind}'
       LIMIT 1`,
    ),
    options,
  );
}

export async function hasMergeConflictReviewLoopEpochForHead(
  db: D1Database,
  options: ReviewLoopEpochHeadLookup,
): Promise<boolean> {
  return reviewLoopEpochHeadExists(
    db.prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND source_kind = '${REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind}'
         -- Terminal pre-dispatch/no-op rows did not attempt a conflict resolution prompt. Do not let
         -- them suppress a future dirty retry on the same head after eligibility or the base changes.
         AND (status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL}) OR COALESCE(worklist_hash, '') <> '')
       LIMIT 1`,
    ),
    options,
  );
}

/**
 * All epoch summaries (review AND ci) for a single PR head, for the review-loop done-state rollup.
 * Deliberately has NO `source_kind` filter: the rollup reduces over the full epoch set for the head,
 * so a ci-fix epoch must be counted alongside bot/human review epochs (contrast
 * `hasReviewLoopEpochForHead`, which excludes ci rows).
 */
export async function getReviewLoopEpochSummariesForHead(
  db: D1Database,
  options: { sessionId: string; prUrl: string; headSha: string },
): Promise<ReviewLoopEpochSummary[]> {
  const rows = await db
    .prepare(
      `SELECT status, blocked_reason, source_kind FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ?`,
    )
    .bind(options.sessionId, options.prUrl, options.headSha)
    .all<{ status: ReviewLoopEpochStatus; blocked_reason: string | null; source_kind: ReviewLoopSourceKind | null }>();
  return (rows.results ?? []).map((row) => ({
    status: row.status as ReviewLoopEpochStatus,
    blockedReason: (row.blocked_reason as string | null) ?? null,
    sourceKind: row.source_kind ?? "bot",
  }));
}

/**
 * Latest epoch for the status comment. By default returns the latest
 * BOT/HUMAN/MIXED (review) epoch and EXCLUDES `ci` AND `verification` epochs: the live status
 * comment tracks bot/human review progress (its render keys on expectedBots, which both ci and
 * verification epochs leave empty), so a newer ci/verification epoch must never shadow the
 * bot/human epoch and overwrite the comment with a blank zero-bot state.
 *
 * The exclusion is now structurally enforced via the explicit `kind`
 * parameter rather than a convention-only `source_kind != 'ci'` filter buried in
 * the query: a future ci/verification-aware caller must opt in with `kind: "any"` (and own
 * the consequence) rather than silently inheriting review-only behavior or
 * silently breaking it by relaxing the filter.
 */
export async function getLatestReviewLoopEpochForPr(
  db: D1Database,
  options: { sessionId: string; prUrl: string; kind?: "review" | "any" },
): Promise<ReviewLoopEpoch | null> {
  const kind = options.kind ?? "review";
  // Two static query strings (rather than an interpolated local predicate) so the
  // schema-validation test can statically analyze each variant's SQL.
  const statement =
    kind === "review"
      ? db.prepare(
          `SELECT * FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND ${REVIEW_LOOP_BOT_HUMAN_EPOCH_SQL_PREDICATE}
       ORDER BY created_at DESC, wave DESC
       LIMIT 1`,
        )
      : db.prepare(
          `SELECT * FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ?
       ORDER BY created_at DESC, wave DESC
       LIMIT 1`,
        );
  const row = await statement.bind(options.sessionId, options.prUrl).first<ReviewLoopEpochRow>();
  return row ? rowToEpoch(row) : null;
}

export async function claimReviewLoopEpochForPrompt(
  db: D1Database,
  epochId: string,
  options: { leaseOwner: string; nowMs: number },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'reserving', lease_owner = ?, lease_expires_at = ?, reservation_token = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?
         AND (
           status = 'ready'
           OR (status = 'reserving' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         )`,
    )
    .bind(options.leaseOwner, options.nowMs + LEASE_MS, crypto.randomUUID(), options.nowMs, epochId, options.nowMs)
    .run();
  if (!d1Changed(result)) return null;
  // arrival_to_dispatch_ms is emitted once per dispatch at the enqueue step (markReviewLoopEpochEnqueued),
  // the actual dispatch. Emitting here too would double-count successful dispatches and record a
  // dispatch latency for claims that then block/no-op — polluting the rollout-gate metric.
  return getReviewLoopEpochById(db, epochId);
}

/**
 * Lists in-flight epochs whose reclaim lease has expired. The reclaimable in-flight states are
 * `enqueued`/`processing`/`publishing`. `waiting_for_owner` is deliberately EXCLUDED: it is an
 * intentional human-gated pause, not a stuck prompt, so it must not be reclaimed out from under the
 * owner. — the prompt that owned them ended without
 * driving a terminal transition. The sweep reconciles each (re-drives if the head still matches and
 * the attempt cap is not reached, otherwise blocks). Uses the existing (status, lease_expires_at)
 * index.
 */
export async function listStuckReviewLoopEpochs(
  db: D1Database,
  options: { nowMs: number; limit: number },
): Promise<ReviewLoopEpoch[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE status IN ('enqueued', 'processing', 'publishing')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       ORDER BY lease_expires_at ASC, updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(options.nowMs, options.limit)
    .all<ReviewLoopEpochRow>();
  return (rows.results ?? []).map(rowToEpoch);
}

/**
 * Reclaims a stuck in-flight epoch (expired lease). CAS-guarded on the in-flight status + the
 * observed lease_expires_at so a concurrent transition (the prompt finally publishing, or another
 * sweep) cannot be clobbered. Resets the epoch to `ready` (clearing the prompt binding and lease)
 * so the next sweep re-drives it. Returns null if the CAS lost (epoch already moved on).
 */
export async function reclaimStuckReviewLoopEpoch(
  db: D1Database,
  epochId: string,
  options: { nowMs: number; expectedLeaseExpiresAt: number | null },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'ready', last_prompt_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, last_error = 'reclaimed: in-flight lease expired', updated_at = ?
       WHERE id = ?
         AND status IN ('enqueued', 'processing', 'publishing')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at = ?`,
    )
    .bind(options.nowMs, epochId, options.expectedLeaseExpiresAt)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

/**
 * Blocks a stuck in-flight epoch that has exhausted the attempt cap. CAS-guarded the same way as
 * reclaimStuckReviewLoopEpoch.
 */
export async function blockStuckReviewLoopEpoch(
  db: D1Database,
  epochId: string,
  options: {
    nowMs: number;
    reason: string;
    error?: string | null;
    expectedLeaseExpiresAt: number | null;
    telemetry?: ReviewLoopEpochTelemetry;
  },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'blocked', blocked_reason = ?, last_error = ?, lease_owner = NULL,
           lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE id = ?
         AND status IN ('enqueued', 'processing', 'publishing')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at = ?`,
    )
    .bind(options.reason, options.error ?? null, options.nowMs, epochId, options.expectedLeaseExpiresAt)
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  await emitEpochTerminalTelemetry(epoch, options.telemetry);
  return epoch;
}

/**
 * Resolves the in-flight epoch owned by a prompt that just reached a terminal state WITHOUT
 * publishing (reply-only, no-op, or question-only review turns). Completes the epoch so it does not
 * sit in `enqueued`/`processing` forever waiting for a publish that will never come.
 *
 * Only `enqueued`/`processing` are completed: `publishing` is mid-publish (publish-service drives
 * its own completion) and `waiting_for_owner` is an intentional pause. The CAS binds last_prompt_id
 * so a stale prompt cannot complete an epoch that has since been re-pointed to a retry prompt.
 */
export async function resolveReviewLoopEpochForTerminalPrompt(
  db: D1Database,
  epochId: string,
  options: {
    promptId: string;
    nowMs: number;
    telemetry?: ReviewLoopEpochTelemetry;
  },
): Promise<ReviewLoopEpoch | null> {
  const before = await getReviewLoopEpochById(db, epochId);
  if (!before || before.lastPromptId !== options.promptId || !["enqueued", "processing"].includes(before.status)) {
    return null;
  }
  const hasUnresolvedPromptedWork = await hasUnresolvedPromptedWorkAfterNoDiff(db, before);
  const isCarryForwardDrain = (before.carriedForwardSourceIds?.length ?? 0) > 0;
  const noProgressCapReached = isCarryForwardDrain
    ? before.carryForwardNoProgressCount >= REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP
    : before.attemptCount >= REVIEW_LOOP_ATTEMPT_CAP;
  const noProgressStatus = noProgressCapReached ? "blocked" : "ready";
  const noProgressBlockedReason = noProgressCapReached ? REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON : null;

  // Clear last_error: a prior reclaim cycle may have stamped 'reclaimed: in-flight lease expired'.
  // Completing here via the no-changes (reply-only/no-op) path is a SUCCESSFUL terminal outcome, so a
  // leftover error would otherwise make a clean completion look like a failure in observability.
  // Mirrors the publish-path completion, which lands `completed` without a stale error.
  // ARC-1226: a reply-only/no-op terminal turn settles the epoch too; mirror the publish-completion
  // carry-forward logic so a truncated dispatch re-drives (`ready`) / backstops (`blocked`) here as
  // well rather than completing with dropped feedback unshown.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = CASE
             WHEN ? THEN ?
             ELSE ${CARRY_FORWARD_SETTLE_STATUS_SQL}
           END,
           blocked_reason = CASE
             WHEN ? THEN ?
             WHEN ${CARRY_FORWARD_BLOCKING_SQL} THEN '${REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON}'
             ELSE blocked_reason
           END,
           last_prompt_id = CASE
             WHEN ? THEN NULL
             WHEN ${CARRY_FORWARD_REDRIVING_SQL} THEN NULL
             ELSE last_prompt_id
           END,
           last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, updated_at = ?
       WHERE id = ? AND status IN ('enqueued', 'processing') AND last_prompt_id = ?`,
    )
    .bind(
      hasUnresolvedPromptedWork ? 1 : 0,
      noProgressStatus,
      hasUnresolvedPromptedWork ? 1 : 0,
      noProgressBlockedReason,
      hasUnresolvedPromptedWork ? 1 : 0,
      options.nowMs,
      epochId,
      options.promptId,
    )
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  await emitEpochTerminalTelemetry(epoch, options.telemetry);
  return epoch;
}

/**
 * Re-points an in-flight epoch's last_prompt_id to a retry prompt's id. A spawn-timeout retry clones
 * the active prompt to a NEW promptId but keeps the same reviewLoopEpochId; without re-pointing, the
 * epoch's last_prompt_id keeps the original and validateReviewLoopPublishGuard /
 * resolveReviewLoopOperationContext permanently reject the retried prompt's publish/reply
 * ("attached to a different prompt"). CAS binds the previous prompt id so we only re-point the
 * prompt we actually replaced.
 *
 * Also refreshes the in-flight lease (lease_owner = 'in-flight', lease_expires_at = now +
 * IN_FLIGHT_LEASE_MS), matching the other in-flight transitions. The retry prompt is a fresh attempt:
 * without re-stamping the lease, a retry that runs past the ORIGINAL ~30-min in-flight window could
 * be reclaimed by the stuck-epoch sweep while it is still actively working.
 */
export async function repointReviewLoopEpochPrompt(
  db: D1Database,
  epochId: string,
  options: { previousPromptId: string; nextPromptId: string; nowMs: number },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET last_prompt_id = ?, lease_owner = 'in-flight', lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('enqueued', 'processing', 'publishing', 'waiting_for_owner')
         AND last_prompt_id = ?`,
    )
    .bind(options.nextPromptId, options.nowMs + IN_FLIGHT_LEASE_MS, options.nowMs, epochId, options.previousPromptId)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

/**
 * ARC-1242 carry-forward backstop: after this many CONSECUTIVE no-progress dispatch attempts a still-
 * truncated epoch stops re-driving and settles to a non-exhausted `blocked`
 * (REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON) so the rollup keeps the head "working" — surfaced for human
 * follow-up rather than spinning forever. Measured against carry_forward_no_progress_count (bumped once
 * per dispatch when the carried tail did NOT shrink, reset on any shrink), NOT attempt_count. A crashed
 * or no-op wave leaves the tail unchanged, so it self-counts as no-progress at the next dispatch — no
 * separate crash backstop is needed, and reclaim/crash cycles between PRODUCTIVE waves no longer park a
 * still-draining tail early (the bug attempt_count caused). Reusing the general attempt cap value keeps
 * the budget intuitive: 5 dead attempts in a row is genuinely stuck.
 */
export const REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP = REVIEW_LOOP_ATTEMPT_CAP;
/** Blocked reason for a truncated epoch the backstop gave up re-driving. NOT an exhausted reason. */
export const REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON = "worklist_truncation_unresolved";
/** Blocked reason for no-diff terminal prompts that repeatedly leave prompted work unresolved. */
export const REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON = "no_progress_unresolved";
/**
 * ARC-1407 blocked reason: the sweep would re-prompt the SAME evidence (identical worklist_hash — same
 * source-ids/bodies/resolved-state) past the one-retry budget. Classified exactly like its sibling
 * `no_progress_unresolved`: the rollup keeps it in the "working" bucket (NOT in EXHAUSTED_BLOCKED_REASONS)
 * so a human follows up instead of the head falsely claiming caught-up, and the settle-rate SLI counts it
 * as a genuine convergence failure (CONVERGENCE_FAILURE_BLOCKED_REASONS). It does NOT DM the owner — the
 * PR status comment surfaces the humanized reason (see review-loop-blocked-reason.ts).
 */
export const REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_REASON = "no_new_evidence_reprompt_cap";
/**
 * One retry: allow the initial prompt + exactly one unchanged re-prompt, block the 2nd. attempt_count is
 * post-increment at claim (1 = initial dispatch) and worklist_hash only matches the row's stored value
 * from the 2nd dispatch onward, so a threshold of 3 blocks the 2nd unchanged re-prompt. attempt_count is
 * decremented by contention/transient deferrals, so this cap can only fire LATER, never early — bounded
 * above by REVIEW_LOOP_ATTEMPT_CAP.
 */
export const REVIEW_LOOP_NO_NEW_EVIDENCE_REPROMPT_ATTEMPTS = 3;

/**
 * Recorded as the disposition `basis` when the empty-worklist drain cap stamps an unservable item
 * `no_action_needed_informational` (see {@link listRecentReviewLoopEpochDrainSummaries}).
 */
export const REVIEW_LOOP_DRAIN_NO_PROGRESS_BASIS = "drain_no_progress";
/**
 * Consecutive never-prompted empty-worklist settles over the SAME triggering set before the sweep stamps
 * those items instead of letting the epoch.settled drain re-arm again. 3 = the initial drain dispatch plus
 * two identical repeats — enough to prove the rebuilt worklist can never service the registered item(s).
 */
export const REVIEW_LOOP_DRAIN_NO_PROGRESS_CAP = 3;

// Status a post-dispatch settle (publish completion or reply-only/no-op terminal) should land on,
// evaluated against the row being updated. With un-prompted carried-forward feedback still owed,
// re-drive to `ready` (the next sweep re-dispatches the tail) unless the wave cap is hit, in which
// case stop with a non-exhausted `blocked`. With nothing carried forward, complete normally. The
// reason/cap are compile-time constants, so they are safe to inline into the SQL. The column is
// NOT NULL DEFAULT '[]' (migration 0166), so the empty-array check alone fully expresses "pending".
const CARRY_FORWARD_HAS_PENDING_SQL = "carried_forward_source_ids_json != '[]'";
const CARRY_FORWARD_REDRIVING_SQL = `(${CARRY_FORWARD_HAS_PENDING_SQL} AND carry_forward_no_progress_count < ${REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP})`;
const CARRY_FORWARD_BLOCKING_SQL = `(${CARRY_FORWARD_HAS_PENDING_SQL} AND carry_forward_no_progress_count >= ${REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP})`;
const CARRY_FORWARD_SETTLE_STATUS_SQL = `CASE
        WHEN NOT (${CARRY_FORWARD_HAS_PENDING_SQL}) THEN 'completed'
        WHEN carry_forward_no_progress_count >= ${REVIEW_LOOP_CARRY_FORWARD_NO_PROGRESS_CAP} THEN 'blocked'
        ELSE 'ready'
      END`;

async function hasUnresolvedPromptedWorkAfterNoDiff(db: D1Database, epoch: ReviewLoopEpoch): Promise<boolean> {
  // `review_loop_reply` records a per-source verdict row, so the per-source query below resolves it
  // precisely and a partial 1-of-N reply leaves the unreplied prompted sources correctly flagged as
  // still unresolved. CI check-run items have no reply primitive and are exempt from this check.
  const promptedReviewSourceIds = epoch.promptedSourceIds.filter((sourceId) => !isCheckRunFailureSourceId(sourceId));
  if (promptedReviewSourceIds.length === 0) return false;
  const replyOperations = await listSucceededReviewLoopReplyOperations(db, epoch.id);
  const verdictBySourceId = new Map(
    replyOperations
      .filter(
        (operation) =>
          operation.verdict === "fixed" || operation.verdict === "replied" || operation.verdict === "declined",
      )
      .map((operation) => [operation.targetSourceId, operation.verdict]),
  );
  return promptedReviewSourceIds.some((sourceId) => !verdictBySourceId.has(sourceId));
}

export async function markReviewLoopEpochEnqueued(
  db: D1Database,
  epochId: string,
  options: {
    promptId: string;
    worklistHash: string;
    nowMs: number;
    expectedReservationToken: string | null;
    /**
     * Source ids included in the prompt being dispatched (worklist items plus the duplicate-group
     * members they stand in for). Recorded as prompted so the carry-forward logic treats them as
     * addressed; anything ingested but absent here remains carry-forward-eligible.
     */
    promptedSourceIds?: string[];
    /**
     * Raw-body hashes for the `review-body:*` ids in `promptedSourceIds` (see
     * PromptedReviewLoopSourceRecord.bodyHash). Persisted so the next wave can detect a body edit
     * the reviews endpoint's unchanged `submitted_at` would otherwise hide. Optional/fail-open.
     */
    promptedSourceBodyHashes?: ReadonlyMap<string, string>;
    /**
     * Prompted source records already on this epoch before the current enqueue attempt. Reclaimed
     * epochs pass this from their claimed row so re-enqueue preserves the earlier prompt's ids (and
     * their original promptedAtMs) without a second DB read on the common first-enqueue path.
     */
    existingPromptedSourceRecords?: PromptedReviewLoopSourceRecord[];
    /**
     * Budget-dropped sourceIds this dispatch could not fit (ARC-1226). Recorded un-prompted so the
     * dispatch-dedup union (prompted-only) re-surfaces them, and so the settle paths re-drive this
     * epoch instead of completing it. Recomputed every dispatch from worklist.droppedSourceIds, so
     * an empty/absent value clears any prior carry-forward once the tail has fully drained.
     */
    carriedForwardSourceIds?: string[];
    telemetry?: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
    /**
     * What drove this dispatch, as a bounded tag on the arrival_to_dispatch emit. Omitted on the
     * cron poll path (unchanged historical series); the FSM webhook sink / terminal-chain / reclaim
     * pass their respective triggers (ARC-1330 Phase B).
     */
    trigger?: ReviewLoopDispatchTrigger;
  },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  const promptedSourceIds = JSON.stringify(
    mergePromptedSourceRecords(
      options.existingPromptedSourceRecords ?? [],
      options.promptedSourceIds ?? [],
      options.nowMs,
      options.promptedSourceBodyHashes,
    ),
  );
  const carriedForwardSourceIds = JSON.stringify(options.carriedForwardSourceIds ?? []);
  // ARC-1242: forward progress = the carried tail shrank vs the prior dispatch. Bump the no-progress
  // counter when it did NOT shrink (crash/no-op wave), reset it when it did. json_array_length reads the
  // OLD column value (SQLite evaluates assignment RHS against the pre-update row); the new carried-tail
  // length is bound. This is COUNT-based, not set-membership: a tail that holds steady at the same length
  // while its members rotate (rare — sustained new-feedback influx exactly replacing drained items) counts
  // as no-progress and can eventually park. That is the intended safe direction
  // (blocked('worklist_truncation_unresolved') → rollup stays "working", never a false done); switch to a
  // membership-shrink check only if observed.
  const newCarriedCount = options.carriedForwardSourceIds?.length ?? 0;
  // Stamp an in-flight lease so a prompt that ends without driving a terminal transition
  // (reply-only/no-op turn, sandbox gone, crash) is reclaimable by the sweep. Previously the
  // lease was NULLed here, which left enqueued/processing epochs stuck forever.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'enqueued', last_prompt_id = ?, worklist_hash = ?, prompted_source_ids_json = ?,
           carried_forward_source_ids_json = ?,
           carry_forward_no_progress_count = CASE
             WHEN json_array_length(carried_forward_source_ids_json) > 0
              AND ? >= json_array_length(carried_forward_source_ids_json)
             THEN carry_forward_no_progress_count + 1 ELSE 0 END,
           lease_owner = 'in-flight', lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?`,
    )
    .bind(
      options.promptId,
      options.worklistHash,
      promptedSourceIds,
      carriedForwardSourceIds,
      newCarriedCount,
      options.nowMs + IN_FLIGHT_LEASE_MS,
      options.nowMs,
      epochId,
      expectedReservationToken,
      expectedReservationToken,
    )
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  if (epoch && options.telemetry) {
    const arrivalToDispatchMs = options.nowMs - epoch.firstActivityAt;
    await emitReviewLoopArrivalToDispatchEvent(options.telemetry, {
      sourceKind: epoch.sourceKind,
      repo: `${epoch.repoOwner}/${epoch.repoName}`,
      ownerUserId: epoch.ownerUserId,
      arrivalToDispatchMs,
      sessionId: epoch.sessionId,
      prUrl: epoch.prUrl,
      epochId: epoch.id,
      trigger: options.trigger,
    });
    if (isCiEpoch(epoch)) {
      await emitReviewLoopCiFirstFailToDispatchEvent(options.telemetry, {
        repo: `${epoch.repoOwner}/${epoch.repoName}`,
        ownerUserId: epoch.ownerUserId,
        ciFirstFailToDispatchMs: arrivalToDispatchMs,
        sessionId: epoch.sessionId,
        prUrl: epoch.prUrl,
        epochId: epoch.id,
        trigger: options.trigger,
      });
    }
  }
  return epoch;
}

export async function markReviewLoopEpochProcessing(
  db: D1Database,
  epochId: string,
  options: { promptId: string; nowMs: number },
): Promise<ReviewLoopEpoch | null> {
  // Refresh the in-flight lease on the transition so the reclaim window is measured from the
  // moment the prompt actually started processing, not from enqueue.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = ?, lease_owner = 'in-flight', lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = ? AND last_prompt_id = ?`,
    )
    .bind("processing", options.nowMs + IN_FLIGHT_LEASE_MS, options.nowMs, epochId, "enqueued", options.promptId)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

export async function markReviewLoopEpochPublishing(
  db: D1Database,
  epochId: string,
  options: { promptId: string; nowMs: number },
): Promise<ReviewLoopEpoch | null> {
  // Refresh the in-flight lease: the publish push + side effects can take a while, and a crash
  // mid-publish must leave the epoch reclaimable rather than stranded in 'publishing' forever.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = ?, lease_owner = 'in-flight', lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = ? AND last_prompt_id = ?`,
    )
    .bind("publishing", options.nowMs + IN_FLIGHT_LEASE_MS, options.nowMs, epochId, "processing", options.promptId)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

export async function markReviewLoopEpochContentionDeferred(
  db: D1Database,
  epochId: string,
  options: { nowMs: number; reason: string; error?: string | null; expectedReservationToken: string | null },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'ready', blocked_reason = NULL, last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, contention_deferral_count = contention_deferral_count + 1,
           attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
           updated_at = ?
       WHERE id = ? AND status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?`,
    )
    .bind(options.error ?? options.reason, options.nowMs, epochId, expectedReservationToken, expectedReservationToken)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

export async function markReviewLoopEpochTransientFailure(
  db: D1Database,
  epochId: string,
  options: {
    nowMs: number;
    reason: string;
    error?: string | null;
    expectedReservationToken: string | null;
    transientFailureLimit: number;
  },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  // Increment in SQL and decide blocked-vs-ready off the incremented value in the same statement,
  // matching the sibling counters (attempt_count, contention_deferral_count). A prior JS
  // read-modify-write computed the count and the cap decision off a stale read whose value the CAS
  // WHERE (reservation_token) never re-checked, so a concurrent transient failure could clobber the
  // count and mis-decide the cap. blocked_reason uses the SAME threshold so a below-cap retry always
  // clears any stale reason; last_error is unconditional, preserving today's behavior.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = CASE WHEN transient_failure_count + 1 >= ? THEN 'blocked' ELSE 'ready' END,
           blocked_reason = CASE WHEN transient_failure_count + 1 >= ? THEN ? ELSE NULL END,
           last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, transient_failure_count = transient_failure_count + 1,
           attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
           updated_at = ?
       WHERE id = ? AND status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?`,
    )
    .bind(
      options.transientFailureLimit,
      options.transientFailureLimit,
      options.reason,
      options.error ?? options.reason,
      options.nowMs,
      epochId,
      expectedReservationToken,
      expectedReservationToken,
    )
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

// In-flight (non-terminal) epoch statuses. Shared by the head-change stale-block and the reconcile
// mergeability block so the "still working" set cannot drift between the two. Values are a fixed
// allowlist (never user input), safe to inline into the SQL IN-list.
const NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUSES = [
  "collecting",
  "ready",
  "reserving",
  "enqueued",
  "processing",
  "waiting_for_owner",
  "publishing",
] as const;
const NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL = NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUSES.map((s) => `'${s}'`).join(
  ", ",
);
// Pre-dispatch (undispatched) statuses: the epoch is created but no prompt has been claimed/sent yet.
// `claimReviewLoopEpochForPrompt` moves `ready` → `reserving` at dispatch, so anything past this set has
// an in-flight/paused prompt whose output is tied to the head it was generated against. Used to scope the
// mention head-change carry-forward so an in-flight mention prompt's head is never rewritten.
const PRE_DISPATCH_REVIEW_LOOP_EPOCH_STATUS_SQL = (["collecting", "ready"] as const).map((s) => `'${s}'`).join(", ");

/**
 * Source ids a LIVE (non-terminal) review-loop epoch already covers for a PR — prompted, legacy, OR
 * triggering. Unlike {@link listKnownReviewLoopSourceIds}, a TERMINAL (`completed`/`blocked`) epoch's
 * ids do NOT count: the FSM `dispatch_epoch` executor only ever considers `disposition='none'` items, so
 * an item a now-terminal epoch prompted but never dispositioned is UN-handled and must stay
 * re-dispatchable (ARC-1445 — a `head_changed`-blocked epoch left its prompted items undispositioned, and
 * treating them as "covered" wedged `caught_up` at `undispositioned ≥ 1` forever). Scoped to the FSM
 * dispatch dedup; the legacy bootstrap's new-feedback gate keeps using {@link listKnownReviewLoopSources}
 * (terminal-prompted stays "known" there so a clean re-review of a dispositioned-but-unresolved thread
 * does not re-nag).
 */
export async function listLiveEpochCoveredSourceIds(
  db: D1Database,
  input: { sessionId: string; prUrl: string },
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT triggering_source_ids_json, prompted_source_ids_json
         FROM pr_review_response_epochs
        WHERE session_id = ? AND pr_url = ?
          AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(input.sessionId, input.prUrl)
    .all<{ triggering_source_ids_json: string; prompted_source_ids_json: string }>();
  const rows = results ?? [];
  const prompted = accumulatePromptedSources(rows);
  const covered = new Set<string>([...prompted.promptedAtBySourceId.keys(), ...prompted.legacySourceIds]);
  for (const row of rows) {
    for (const sourceId of parseJsonArray<string>(row.triggering_source_ids_json)) covered.add(sourceId);
  }
  return covered;
}

/** One prior epoch's drain-relevant shape: how it ended, whether it ever prompted, what triggered it. */
export interface ReviewLoopEpochDrainSummary {
  status: ReviewLoopEpochStatus;
  lastPromptId: string | null;
  triggeringSourceIds: string[];
}

/**
 * The most recent epochs for a PR (newest first), excluding one id — the drain-cap probe. The
 * epoch.settled drain (ARC-1445) re-arms a FRESH synthetic epoch whenever undispositioned items no live
 * epoch covers remain, so an item that can never be serviced by a rebuilt worklist (e.g. a registered id
 * whose canonical form was already prompted and capped) spins the loop forever: dispatch → empty worklist
 * → noop settle → re-arm, one wave every few seconds until the PR closes or the REVIEW deadline fires.
 * The sweep's empty-worklist settle reads the immediately-preceding epochs through this to detect that
 * repetition and stamp the unservable items instead of re-arming again.
 */
export async function listRecentReviewLoopEpochDrainSummaries(
  db: D1Database,
  input: { sessionId: string; prUrl: string; excludeEpochId: string; limit: number },
): Promise<ReviewLoopEpochDrainSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT status, last_prompt_id, triggering_source_ids_json
         FROM pr_review_response_epochs
        WHERE session_id = ? AND pr_url = ? AND id != ?
        ORDER BY created_at DESC, wave DESC
        LIMIT ?`,
    )
    .bind(input.sessionId, input.prUrl, input.excludeEpochId, input.limit)
    .all<{ status: string; last_prompt_id: string | null; triggering_source_ids_json: string }>();
  return (results ?? []).map((row) => ({
    status: row.status as ReviewLoopEpochStatus,
    lastPromptId: row.last_prompt_id,
    triggeringSourceIds: parseJsonArray<string>(row.triggering_source_ids_json),
  }));
}

/**
 * Record a sandbox-side `cycloid.git_sync` force-push as a SUCCEEDED push operation on every
 * non-terminal review-loop epoch the session currently holds. The guarded publish path records its
 * pushes as operations, and two protections key off that record: the reply gate's #4987 own-pushed-SHA
 * carve-out (`selectLatestSucceededReviewLoopPushHead`) and the head-change reconciler's own-push
 * carry-forward (`hasSucceededReviewLoopPushToHead`). A git_sync push previously bypassed both — the
 * agent's own mid-prompt fix push blocked its own epoch as `head_changed` and got every subsequent
 * verdict reply rejected (PR #7656). Recording is idempotent per (epoch, pushed head) via the
 * deterministic operation id. Returns the number of epochs recorded against (0 = no live review work,
 * a non-review prompt's push — nothing to protect).
 */
export async function recordReviewLoopSelfPushForSession(
  db: D1Database,
  input: { sessionId: string; pushedHead: string; nowMs: number },
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, head_sha, worklist_hash, last_prompt_id
         FROM pr_review_response_epochs
        WHERE session_id = ?
          AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(input.sessionId)
    .all<{ id: string; head_sha: string; worklist_hash: string | null; last_prompt_id: string | null }>();
  const rows = results ?? [];
  let recorded = 0;
  for (const row of rows) {
    const operationId = await buildReviewLoopPushOperationId({
      epochId: row.id,
      headSha: row.head_sha,
      worklistHash: row.worklist_hash ?? "",
      // The pushed head is the discriminator: a second distinct git_sync push from the same epoch
      // state records a NEW operation instead of colliding with the first.
      diffHash: `git-sync:${input.pushedHead}`,
    });
    const attempt = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: row.id,
      sessionId: input.sessionId,
      promptId: row.last_prompt_id ?? "git-sync",
      kind: "push",
      targetSourceId: null,
      headSha: row.head_sha,
      maxAttempts: 3,
      nowMs: input.nowMs,
    });
    if (attempt.status === "already_succeeded") {
      // A repeat record of the same pushed head (push retried after a failure, or a re-invoked tool
      // call): refresh the operation's updated_at so the head-change proof's recency window reflects
      // the attempt that is about to happen — otherwise a retry outside the window would stale-block
      // the agent's own successful push.
      await touchSucceededReviewLoopOperation(db, operationId, input.nowMs);
      recorded += 1;
      continue;
    }
    if (attempt.status !== "started") continue;
    await markReviewLoopOperationSucceeded(db, operationId, {
      githubId: input.pushedHead,
      nowMs: input.nowMs,
      expectedAttempts: attempt.operation.attempts,
    });
    recorded += 1;
  }
  return recorded;
}

export async function markReviewLoopEpochsStaleForHeadChange(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    previousHeadSha: string;
    currentHeadSha: string;
    nowMs: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'blocked', blocked_reason = 'head_changed', last_error = ?, lease_owner = NULL,
           lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(
      `PR head changed from ${options.previousHeadSha} to ${options.currentHeadSha}`,
      options.nowMs,
      options.sessionId,
      options.prUrl,
      options.previousHeadSha,
    )
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Re-keys the budget-truncated carried tails (`carried_forward_source_ids_json != '[]'`, ARC-1226)
 * that are sitting `ready` on the previous head onto the new head, so they keep draining there instead
 * of being buried by the head-change stale-block (ARC-1244).
 *
 * The stale-block (`markReviewLoopEpochsStaleForHeadChange`) blocks ALL non-terminal epochs on a
 * foreign/user head change. A `ready` epoch that still owes a truncated tail would then be blocked,
 * stranding the un-prompted tail: it resurfaces as new actionable feedback on the new head, but the
 * only path that can bootstrap a new-head epoch (`bootstrapReviewLoopEpochFromHeadSignals`) reads CI
 * signals only — it cannot create one from review/issue-comment items — so without a fresh bot
 * re-review the loop sits `working` forever. Re-keying the `ready` tail-owing epoch onto the new head
 * lets the next sweep re-dispatch the carried tail with no fresh bot signal.
 *
 * Scope is deliberately narrow — `status = 'ready'` AND below the no-progress cap
 * (`CARRY_FORWARD_REDRIVING_SQL`), the exact "settled, re-driveable, will-drain" state the
 * post-dispatch settle parks a truncated tail in. This single predicate also excludes the cases a
 * broader re-key would get wrong, so they fall through to the stale-block (their pre-ARC-1244
 * behavior):
 *   - IN-FLIGHT rows (`reserving`/`enqueued`/`processing`/`publishing`): a prompt/publish is active;
 *     re-keying to `ready` + nulling the lease/prompt would race it and could double-publish.
 *   - `waiting_for_owner`: a deliberate human hand-off; re-keying would un-pause it and break the
 *     owner-resume CAS (`markReviewLoopEpochOwnerApprovalResolved`).
 *   - AT-CAP rows (`carry_forward_no_progress_count >= CAP`): genuinely stuck (5 no-progress
 *     dispatches), not re-driveable — re-keying would only relabel a parked block.
 * Because every matched row is below-cap → `ready`, there is no `blocked` settle arm here (no
 * blocked_reason/status CASE), which is why the metric this feeds counts only tails that will
 * actually drain.
 *
 * Callers run this BEFORE the stale-block on the foreign-push path: the re-keyed rows move off the
 * previous head, so the subsequent stale-block (keyed on `previousHeadSha`) naturally skips them.
 *
 * `UPDATE OR IGNORE`: the unique index includes head_sha, so a row whose (owner, session, prUrl,
 * head_sha, expected_bots_hash, wave) tuple already exists on the new head would violate it. OR IGNORE
 * SKIPS just that row (leaving it on the old head for the stale-block to block) instead of ABORTING
 * the whole multi-row statement — so one colliding wave can never strand the other non-colliding
 * tail-owing rows. `last_error` is overwritten with a head-change breadcrumb (mirroring the
 * stale-block's `last_error`) so a re-keyed row is self-describing in forensics rather than losing
 * its provenance. `carry_forward_no_progress_count` is deliberately NOT bumped: it measures
 * consecutive no-progress DISPATCH attempts, and a head change is not a dispatch.
 *
 * Returns the number re-keyed. NOTE: a collision against a TERMINAL new-head epoch (same tuple) still
 * strands that one tail (the colliding row is skipped → stale-blocked, and a terminal epoch will not
 * re-fetch the worklist) — a narrow residual tracked as a follow-up; the common case (no new-head
 * epoch yet) drains cleanly.
 */
export async function carryForwardTruncatedTailEpochsToNewHead(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    previousHeadSha: string;
    currentHeadSha: string;
    nowMs: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE OR IGNORE pr_review_response_epochs
       SET head_sha = ?,
           status = 'ready',
           blocked_reason = NULL,
           last_prompt_id = NULL,
           last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND status = 'ready'
         AND ${CARRY_FORWARD_REDRIVING_SQL}`,
    )
    .bind(
      options.currentHeadSha,
      `truncated tail re-keyed from ${options.previousHeadSha} to ${options.currentHeadSha} (ARC-1244)`,
      options.nowMs,
      options.sessionId,
      options.prUrl,
      options.previousHeadSha,
    )
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Blocks the in-flight review-loop epoch rows for a given (session, prUrl, headSha) with a fixed
 * reason. Unlike markReviewLoopEpochBlocked (which acts on a single CLAIMED epoch via its
 * reservation token), this targets every non-terminal epoch on a head from the reconcile path,
 * which holds no claim. A 0-row result is normal — no in-flight epoch exists for the head.
 */
export async function blockPendingReviewLoopEpochsForHead(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    headSha: string;
    reason: string;
    error: string;
    nowMs: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'blocked', blocked_reason = ?, last_error = ?, lease_owner = NULL,
           lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(options.reason, options.error, options.nowMs, options.sessionId, options.prUrl, options.headSha)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Carries in-flight review-loop epochs from a previous head to a new head. Used when Cycloid's own
 * update-branch advances the head: the merge commit would otherwise trip the head-change stale-block
 * (and re-bootstrap is gated on NEW feedback a base-merge does not carry), silently dropping pending
 * review work. Re-keying head_sha keeps that work alive on the new head so processEpoch's head check
 * passes. Only non-terminal rows are moved. Returns the number re-keyed.
 *
 * The unique index includes head_sha, so a re-key collides only if an epoch already exists at the
 * new head with the same (owner, expected_bots_hash, wave); callers treat a throw as "fall back to
 * stale-block" since that is the safe default.
 */
export async function carryForwardReviewLoopEpochsToNewHead(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    previousHeadSha: string;
    currentHeadSha: string;
    nowMs: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET head_sha = ?, updated_at = ?
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(options.currentHeadSha, options.nowMs, options.sessionId, options.prUrl, options.previousHeadSha)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Re-keys UNDISPATCHED pending `mention` epochs from the previous head onto the new head on a
 * foreign/user head change, so a pending `@cycloid` mention survives a mid-loop push instead of being
 * stale-blocked.
 *
 * A mention is a head-AGNOSTIC user instruction (unlike bot/human review feedback or a CI-fix epoch,
 * which are tied to the specific head they were raised against). But both the sweep dispatch
 * (`currentHead !== claimed.headSha` → block) and the reply handler (`assertReviewLoopHeadUnchanged` +
 * the reply-active status gate) require the epoch's head to match the live PR head, so a mention left on
 * the old head is blocked (`head_changed`) at dispatch/reply and the user's instruction is silently
 * dropped. The common trigger: the agent responding to one mention pushes a fix, advancing the head and
 * stale-blocking a sibling pending mention before it ever dispatched (ARC-1514 "only worked on 1").
 *
 * Scope is limited to PRE-DISPATCH statuses (`collecting`/`ready`) — NOT the full non-terminal set.
 * Re-keying an already-dispatched mention (`reserving`/`enqueued`/`processing`/`publishing`/
 * `waiting_for_owner`) would rewrite the head its prompt was generated against, making output produced
 * for the OLD head pass the later publish/reply head guards as current instead of being superseded with
 * `head_changed`. An in-flight mention is therefore left for the stale-block (mirroring the truncated-tail
 * re-key, which is likewise `ready`-only). (An agent's OWN fix push is already tolerated on the reply path
 * by `assertReviewLoopHeadUnchanged` accepting the epoch's own pushed head — ARC #4987 — so an in-flight
 * mention needs no re-key to reply after its own push.)
 *
 * Runs on the stale-block (foreign-push) path BEFORE {@link markReviewLoopEpochsStaleForHeadChange}: the
 * re-keyed rows move off `previousHeadSha`, so the subsequent stale-block (keyed on `previousHeadSha`)
 * naturally skips them. The base-merge carry-forward path already re-keys ALL non-terminal epochs
 * (mentions included), so this is only needed on the foreign-push arm.
 *
 * Status is PRESERVED (a `ready` pending mention stays ready and dispatchable). `UPDATE OR IGNORE`: the
 * unique index includes head_sha, so a mention wave colliding with one already on the new head is skipped
 * (left on the old head for the stale-block) rather than aborting the whole statement. `last_error` gets a
 * head-change breadcrumb so a re-keyed row is self-describing in forensics. Returns the number re-keyed.
 */
export async function carryForwardMentionEpochsToNewHead(
  db: D1Database,
  options: {
    sessionId: string;
    prUrl: string;
    previousHeadSha: string;
    currentHeadSha: string;
    nowMs: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE OR IGNORE pr_review_response_epochs
       SET head_sha = ?, last_error = ?, updated_at = ?
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND source_kind = '${REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind}'
         AND status IN (${PRE_DISPATCH_REVIEW_LOOP_EPOCH_STATUS_SQL})`,
    )
    .bind(
      options.currentHeadSha,
      `@cycloid mention carried forward across head change ${options.previousHeadSha} -> ${options.currentHeadSha}`,
      options.nowMs,
      options.sessionId,
      options.prUrl,
      options.previousHeadSha,
    )
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Whether a session has any in-flight (non-terminal) review-loop epoch for a PR. Used by the
 * reconcile mergeability path to act lazily — only read/act on PRs with pending review-loop work,
 * not every idle review-listening PR. Pass `headSha` to scope the check to a single head so it
 * matches exactly what {@link blockPendingReviewLoopEpochsForHead} would block — without it, a
 * lingering non-terminal epoch from an older head would report pending work the per-head block
 * cannot touch.
 */
export async function hasPendingReviewLoopWork(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha?: string },
): Promise<boolean> {
  // Two static statements (rather than an interpolated WHERE fragment) so each query is
  // independently schema-validated.
  const row =
    input.headSha === undefined
      ? await db
          .prepare(
            `SELECT 1 AS hit FROM pr_review_response_epochs
             WHERE session_id = ? AND pr_url = ? AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})
             LIMIT 1`,
          )
          .bind(input.sessionId, input.prUrl)
          .first<{ hit: number }>()
      : await db
          .prepare(
            `SELECT 1 AS hit FROM pr_review_response_epochs
             WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})
             LIMIT 1`,
          )
          .bind(input.sessionId, input.prUrl, input.headSha)
          .first<{ hit: number }>();
  return row !== null;
}

export async function hasActiveMergeConflictReviewLoopEpochForHead(
  db: D1Database,
  options: { sessionId: string; prUrl: string; headSha: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM pr_review_response_epochs
       WHERE session_id = ?
         AND pr_url = ?
         AND head_sha = ?
         AND source_kind = '${REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind}'
         AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})
       LIMIT 1`,
    )
    .bind(options.sessionId, options.prUrl, options.headSha)
    .first<{ hit: number }>();
  return row !== null;
}

export async function markReviewLoopEpochCompleted(
  db: D1Database,
  epochId: string,
  options: {
    nowMs: number;
    worklistHash?: string | null;
    expectedReservationToken?: string | null;
    expectedPromptId?: string | null;
    /**
     * Settle unconditionally `completed` and CLEAR carried_forward (ARC-1226). The sweep's
     * completed_noop path passes this: an empty rebuilt worklist proves there is no pending work, so
     * the epoch must complete even if the row still holds a STALE carried tail from a prior wave (the
     * carried comments were resolved/deleted on GitHub). Without it the conditional settle below would
     * read the stale column and wrongly re-drive forever. Omit for post-prompt completions, where the
     * column authoritatively reflects this dispatch's drops.
     */
    clearCarryForward?: boolean;
    telemetry?: ReviewLoopEpochTelemetry;
  },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  const expectedPromptId = options.expectedPromptId ?? null;
  if (expectedPromptId !== null) {
    const before = await getReviewLoopEpochById(db, epochId);
    if (
      before &&
      before.lastPromptId === expectedPromptId &&
      ["enqueued", "processing", "publishing"].includes(before.status)
    ) {
      const hasUnresolvedPromptedWork = await hasUnresolvedPromptedWorkAfterNoDiff(db, before);
      if (hasUnresolvedPromptedWork) {
        const noProgressCapReached = before.attemptCount >= REVIEW_LOOP_ATTEMPT_CAP;
        const result = await db
          .prepare(
            `UPDATE pr_review_response_epochs
             SET status = ?, blocked_reason = ?, last_prompt_id = NULL, last_error = NULL,
                 lease_owner = NULL, lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
             WHERE id = ? AND status IN ('enqueued', 'processing', 'publishing') AND last_prompt_id = ?`,
          )
          .bind(
            noProgressCapReached ? "blocked" : "ready",
            noProgressCapReached ? REVIEW_LOOP_NO_PROGRESS_UNRESOLVED_REASON : null,
            options.nowMs,
            epochId,
            expectedPromptId,
          )
          .run();
        if (!d1Changed(result)) return null;
        const epoch = await getReviewLoopEpochById(db, epochId);
        await emitEpochTerminalTelemetry(epoch, options.telemetry);
        return epoch;
      }
    }
  }
  // ARC-1226: when the dispatch left budget-dropped feedback un-prompted (carried_forward non-empty),
  // do NOT settle terminal `completed` — re-drive to `ready` so the next sweep dispatches the carried
  // tail, or stop with a non-exhausted `blocked` once the wave cap is hit. A clean dispatch (no
  // carry-forward) completes exactly as before. The completed_noop caller passes clearCarryForward to
  // force a clean terminal completion regardless of any stale carried column.
  const settleSql = options.clearCarryForward
    ? `status = 'completed',
           worklist_hash = COALESCE(?, worklist_hash),
           carried_forward_source_ids_json = '[]',
           lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, updated_at = ?`
    : `status = ${CARRY_FORWARD_SETTLE_STATUS_SQL},
           worklist_hash = COALESCE(?, worklist_hash),
           blocked_reason = CASE WHEN ${CARRY_FORWARD_BLOCKING_SQL} THEN '${REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON}' ELSE blocked_reason END,
           last_prompt_id = CASE WHEN ${CARRY_FORWARD_REDRIVING_SQL} THEN NULL ELSE last_prompt_id END,
           last_error = CASE WHEN ${CARRY_FORWARD_REDRIVING_SQL} THEN NULL ELSE last_error END,
           lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, updated_at = ?`;
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET ${settleSql}
       WHERE id = ?
         AND (
           (status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?)
           OR (status IN ('enqueued', 'processing', 'publishing') AND ? IS NOT NULL AND last_prompt_id = ?)
         )`,
    )
    .bind(
      options.worklistHash ?? null,
      options.nowMs,
      epochId,
      expectedReservationToken,
      expectedReservationToken,
      expectedPromptId,
      expectedPromptId,
    )
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  await emitEpochTerminalTelemetry(epoch, options.telemetry);
  return epoch;
}

export async function markReviewLoopEpochBlocked(
  db: D1Database,
  epochId: string,
  options: {
    nowMs: number;
    reason: string;
    error?: string | null;
    expectedReservationToken?: string | null;
    expectedPromptId?: string | null;
    /**
     * When provided, stores this fingerprint on the blocked epoch's worklist_hash (COALESCE — only
     * overwrites when non-null). The CI same-failure cap blocks a ci epoch BEFORE it enqueues, so it
     * never reaches markReviewLoopEpochEnqueued (which normally records the fingerprint). Without
     * storing it here a cap-blocked ci epoch keeps worklist_hash=NULL, which (1) makes the streak
     * walk treat it as a non-attempt and (2) lets the SAME failing checks be re-attempted after the
     * cap already fired. Passing the fingerprint here makes the cap-blocked epoch a real
     * same-fingerprint attempt so an immediate rerun re-caps instead of re-enqueuing.
     */
    worklistHash?: string;
    telemetry?: ReviewLoopEpochTelemetry;
  },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  const expectedPromptId = options.expectedPromptId ?? null;
  const worklistHash = options.worklistHash ?? null;
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'blocked', blocked_reason = ?, last_error = ?, worklist_hash = COALESCE(?, worklist_hash),
           lease_owner = NULL, lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE id = ?
         AND (
           (status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?)
           OR (status IN ('enqueued', 'processing', 'publishing', 'waiting_for_owner') AND ? IS NOT NULL AND last_prompt_id = ?)
         )`,
    )
    .bind(
      options.reason,
      options.error ?? null,
      worklistHash,
      options.nowMs,
      epochId,
      expectedReservationToken,
      expectedReservationToken,
      expectedPromptId,
      expectedPromptId,
    )
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  await emitEpochTerminalTelemetry(epoch, options.telemetry);
  return epoch;
}

export async function markReviewLoopEpochOwnerApprovalResolved(
  db: D1Database,
  epochId: string,
  options: { promptId: string; nowMs: number },
): Promise<ReviewLoopEpoch | null> {
  // Re-stamp the in-flight lease: the resumed prompt is processing again, so it must be reclaimable
  // if it then ends without a terminal transition.
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'processing', blocked_reason = NULL, last_error = NULL, lease_owner = 'in-flight',
           lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'waiting_for_owner' AND last_prompt_id = ?`,
    )
    .bind(options.nowMs + IN_FLIGHT_LEASE_MS, options.nowMs, epochId, options.promptId)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

export async function markReviewLoopEpochWaitingForOwner(
  db: D1Database,
  epochId: string,
  options: {
    nowMs: number;
    reason: string;
    error?: string | null;
    expectedReservationToken?: string | null;
    expectedPromptId?: string | null;
  },
): Promise<ReviewLoopEpoch | null> {
  const expectedReservationToken = options.expectedReservationToken ?? null;
  const expectedPromptId = options.expectedPromptId ?? null;
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = 'waiting_for_owner', blocked_reason = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
           reservation_token = NULL, updated_at = ?
       WHERE id = ?
         AND (
           (status = 'reserving' AND ? IS NOT NULL AND reservation_token = ?)
           OR (status IN ('enqueued', 'processing', 'publishing') AND ? IS NOT NULL AND last_prompt_id = ?)
         )`,
    )
    .bind(
      options.reason,
      options.error ?? null,
      options.nowMs,
      epochId,
      expectedReservationToken,
      expectedReservationToken,
      expectedPromptId,
      expectedPromptId,
    )
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}

export type ReviewLoopWebhookIngestResult =
  { status: "handled"; epoch: ReviewLoopEpoch } | { status: "ignored"; reason: string };

/**
 * ARC-1330 (PR 39) shadow producer seam: dual-emit a `handled` review ingest as
 * `review.received{bot|human, actionable}` onto the shadow FSM spine. This is the ONE place a review
 * webhook is matched to a live review-listening session, so the resolved `session_id` rides the handled
 * epoch — the faithful "review webhooks → review.received" seam (cheat-sheet: ingest fns in this file). An
 * `ignored` outcome (stale head / unconfigured actor / no listening session / self-trigger upstream) emits
 * nothing. Fully best-effort/try-caught inside `shadowEmitReviewReceived` OFF the legacy ingest path;
 * observe-only (PR 45 measures divergence).
 */
async function shadowEmitReviewReceivedForIngest(
  env: Env,
  result: ReviewLoopWebhookIngestResult,
  classificationInput: ReviewClassificationInput,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (result.status !== "handled") return;
  // PR 47: thread the LEGACY-created epoch id (`result.epoch.id`) so a live dispatching edge stamps
  // the REAL epoch row into `in_flight_epoch_id` (legacy creates, the FSM records, the live sink's
  // dispatch_epoch exists-check anchors on it), and the handler's waitUntil so live side-effect
  // execution never blocks the webhook response.
  await shadowEmitReviewReceived(env, result.epoch.sessionId, classifyReviewReceived(classificationInput), undefined, {
    waitUntil,
    legacyEpochId: result.epoch.id,
  });
}

async function emitReviewLoopWebhookIngestOutcome(
  env: Env,
  result: ReviewLoopWebhookIngestResult,
  input: {
    sourceKind: string;
    webhookKind: ReviewLoopIngestWebhookKind;
    repoOwner: string;
    repoName: string;
    prUrl: string;
    actorLogin?: string | null;
    actorType?: string | null;
  },
): Promise<void> {
  const bot =
    input.sourceKind === "bot"
      ? classifyPrReviewBotForTelemetry({ actorLogin: input.actorLogin, actorType: input.actorType })
      : null;
  await emitReviewLoopIngestOutcomeEvent(env, {
    sourceKind: input.sourceKind,
    webhookKind: input.webhookKind,
    outcome: result.status,
    reason: result.status === "ignored" ? result.reason : null,
    repo: `${input.repoOwner}/${input.repoName}`,
    ownerUserId: result.status === "handled" ? result.epoch.ownerUserId : null,
    sessionId: result.status === "handled" ? result.epoch.sessionId : null,
    prUrl: input.prUrl,
    bot,
    ignoredClass:
      input.sourceKind === "bot" && result.status === "ignored"
        ? classifyReviewLoopIngestIgnoredReason({ webhookKind: input.webhookKind, reason: result.reason })
        : null,
  });
}

/**
 * ARC-1330 (PR 41) shadow producer seam: dual-emit a SETTLED review-loop epoch terminal as
 * `epoch.committed/replied/declined/blocked` onto the shadow FSM spine, writing the terminal disposition
 * for each owned source id. The single mapping point (`ReviewLoopEpoch` → `EpochTerminalInput`): the
 * epoch's `sourceKind` selects the `epoch_trigger` (`ci_fix` vs `review`), and the prompted source ids
 * (the items actually put in front of the agent; falling back to the triggering set when the epoch never
 * dispatched) are the items the terminal dispositions. Best-effort/try-caught inside
 * `shadowEmitEpochTerminal` OFF the legacy terminal write; observe-only (PR 45 measures divergence).
 */
export async function shadowEmitReviewLoopEpochTerminal(
  env: Env,
  epoch: ReviewLoopEpoch,
  kind: EpochTerminalKind,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
  options?: { clearOnly?: boolean },
): Promise<void> {
  const sourceIds = epoch.promptedSourceIds.length > 0 ? epoch.promptedSourceIds : epoch.triggeringSourceIds;
  const itemDispositions = await resolveEpochTerminalItemDispositions(env.DB, epoch, kind, sourceIds);
  const effectiveKind =
    kind === "replied" &&
    itemDispositions.length > 0 &&
    itemDispositions.every((item) => item.disposition === "declined")
      ? "declined"
      : kind;
  await shadowEmitEpochTerminal(
    env,
    epoch.sessionId,
    epoch.prUrl,
    {
      kind: effectiveKind,
      epochId: epoch.id,
      epochTrigger: isCiEpoch(epoch) ? "ci_fix" : "review",
      sourceIds,
      itemDispositions,
      headSha: epoch.headSha,
    },
    log,
    waitUntil,
    options,
  );
}

function fallbackDispositionForEpochTerminal(
  kind: EpochTerminalKind,
): EpochTerminalItemDisposition["disposition"] | null {
  switch (kind) {
    case "committed":
      return "fixed";
    case "replied":
      return "replied";
    case "declined":
      return "declined";
    case "blocked_owner_approval":
      return null;
    case "blocked_response_failed":
      return null;
    case "settled":
      // A no-actionable-work settle stamps NO disposition — items keep whatever they already carry.
      return null;
  }
}

async function resolveEpochTerminalItemDispositions(
  db: D1Database | undefined,
  epoch: ReviewLoopEpoch,
  kind: EpochTerminalKind,
  sourceIds: readonly string[],
): Promise<EpochTerminalItemDisposition[]> {
  const fallbackDisposition = fallbackDispositionForEpochTerminal(kind);
  if (!fallbackDisposition || sourceIds.length === 0) return [];
  if (!db || isCiEpoch(epoch)) {
    return sourceIds.map((sourceId) => ({ sourceId, disposition: fallbackDisposition, basis: null }));
  }

  const replyOperations = await listSucceededReviewLoopReplyOperations(db, epoch.id);
  const operationBySourceId = new Map(replyOperations.map((operation) => [operation.targetSourceId, operation]));
  return sourceIds.flatMap((rawSourceId): EpochTerminalItemDisposition[] => {
    // Namespace canonicalization: review submissions (human AND bot — the webhook mints
    // `human:<reviewId>` for both) trigger epochs under the submission namespace, but reply ops and
    // the prompted worklist key the canonical form `review-body:<reviewId>`. Canonicalize for the op
    // lookup, and stamp BOTH ids whenever either form appears: the FSM `review.received` registration
    // keys the webhook `human:<reviewId>` (transition.ts registerReview) while a prompted epoch's
    // sourceIds carry `review-body:<reviewId>`, so stamping only one form leaves the other row `none`
    // forever — undispositioned rows gate `caught_up` and fuel the epoch.settled drain re-arm into an
    // unbounded dispatch loop.
    const humanReviewId = parseReviewLoopSourceNumericId(rawSourceId, "human");
    const reviewBodyReviewId = parseReviewLoopSourceNumericId(rawSourceId, "review-body");
    const submissionReviewId = humanReviewId ?? reviewBodyReviewId;
    const sourceId = humanReviewId !== null ? `review-body:${humanReviewId}` : rawSourceId;
    const aliasSourceIds =
      submissionReviewId !== null ? [`review-body:${submissionReviewId}`, `human:${submissionReviewId}`] : [sourceId];
    const operation = operationBySourceId.get(sourceId) ?? operationBySourceId.get(rawSourceId);
    if (!operation?.verdict || isCheckRunFailureSourceId(sourceId)) {
      return aliasSourceIds.map((id) => ({ sourceId: id, disposition: fallbackDisposition, basis: null }));
    }
    if (operation.verdict === "declined") {
      const basis = operation.verdictBasis?.trim() || "Declined in a review-loop reply.";
      return aliasSourceIds.map((id) => ({ sourceId: id, disposition: "declined" as const, basis }));
    }
    const verdict = operation.verdict;
    return aliasSourceIds.map((id) => ({ sourceId: id, disposition: verdict, basis: null }));
  });
}

export interface ReviewLoopPullRequestReviewWebhookInput {
  env: Env;
  deliveryId: string | null;
  sourceId: string;
  reviewId: number;
  reviewState: string;
  reviewBody: string | null;
  reviewCommitId: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  /** PR 47: the webhook handler's ExecutionContext seam — live FSM side-effects defer through it. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** When the actor is a human reviewer (flag-ON path), pass their userId and login
   *  so the epoch is tagged mixed/human and the sourceKind transition fires. */
  humanSource?: { userId: number; login: string };
  /**
   * When set, process ONLY this session instead of iterating all sessions
   * returned by listSessionIdsByWebhookRef. Used by the human-loop router so
   * each per-session outer iteration folds into the correct epoch rather than
   * always resolving to the first eligible session.
   * The bot path (called once, outside any loop) leaves this unset and retains
   * the original internal-iteration behaviour.
   */
  sessionId?: string;
}

/**
 * Shared per-session gate run at the top of every webhook ingest loop body: loads the
 * session and skips it unless it is a live, review-listening session for this exact PR.
 * Returns the validated session, or null when the session should be skipped (the caller
 * `continue`s). Head-sha, owner-id, and bot-matching gating stay per-function because
 * they differ across webhook kinds.
 *
 * Read-only QA/review sessions are excluded: they may listen on a target PR for lifecycle
 * reconciliation (PR merged/closed), but review-loop work belongs to the implementation
 * session that owns the PR — review iterations must never be created for or bound to them.
 */
async function loadReviewListeningSession(env: Env, sessionId: string, prUrl: string): Promise<SessionState | null> {
  const session = await getSessionState(env, sessionId);
  if (!session || session.status === "archived") return null;
  if (!session.reviewListeningActive || session.reviewListeningPrUrl !== prUrl) return null;
  if (isReadOnlyAgentRole(session.agentRole)) return null;
  return session;
}

interface ReviewLoopSessionContext {
  sessionId: string;
  session: SessionState;
  ownerUserId: number;
}

async function loadReviewLoopSessionContexts(
  env: Env,
  sessionIds: string[],
  prUrl: string,
): Promise<ReviewLoopSessionContext[]> {
  const sessions = await Promise.all(sessionIds.map((sessionId) => loadReviewListeningSession(env, sessionId, prUrl)));
  return sessions.flatMap((session, index): ReviewLoopSessionContext[] => {
    if (!session) return [];

    const ownerUserId = Number(session.ownerUserId);
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return [];
    return [{ sessionId: sessionIds[index], session, ownerUserId }];
  });
}

function reviewLoopPrefetchRepoKey(ownerUserId: number, repoOwner: string, repoName: string): string {
  return `${ownerUserId}:${repoOwner.trim().toLowerCase()}/${repoName.trim().toLowerCase()}`;
}

async function prefetchReviewLoopChecklistInputs(
  env: Env,
  contexts: ReviewLoopSessionContext[],
  repoOwner: string,
  repoName: string,
) {
  const ownerUserIds = contexts.map((context) => context.ownerUserId);
  const [installationByOwnerLogin, botSettingsByUserId] = await Promise.all([
    getInstallationsByOwners(env.DB, [repoOwner]),
    getUserPrReviewBotSettingsByUserIds(env.DB, ownerUserIds, repoOwner, repoName),
  ]);

  return {
    installationByOwnerLogin,
    botSettingsByOwnerRepo: new Map(
      [...botSettingsByUserId.entries()].map(([ownerUserId, settings]) => [
        reviewLoopPrefetchRepoKey(ownerUserId, repoOwner, repoName),
        settings,
      ]),
    ),
  };
}

type ReviewLoopWebhookPrefetch = Awaited<ReturnType<typeof prefetchReviewLoopChecklistInputs>>;

type ReviewLoopWebhookContextOutcome =
  { status: "handled"; epoch: ReviewLoopEpoch } | { status: "ignored"; reason: string };

async function runReviewLoopWebhookIngest(input: {
  env: Env;
  prUrl: string;
  repoOwner: string;
  repoName: string;
  sessionIds?: string[];
  prefetchChecklistInputs: boolean;
  handleContext: (args: {
    sessionId: string;
    session: ReviewLoopSessionContext["session"];
    ownerUserId: number;
    prefetchedChecklistInputs: ReviewLoopWebhookPrefetch | null;
  }) => Promise<ReviewLoopWebhookContextOutcome>;
}): Promise<ReviewLoopWebhookIngestResult> {
  const sessionIds =
    input.sessionIds ??
    (await listSessionIdsByWebhookRef(input.env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, input.prUrl));
  // No session webhook-ref at all for this PR: Cycloid never tracked it (human/third-party PR that a
  // review bot commented on). Kept distinct from `no_review_listening_session` so the suspicious-ingest
  // monitor can ignore it — see REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON.
  if (sessionIds.length === 0) return { status: "ignored", reason: REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON };

  // A session IS registered for this PR but none is live+listening on this head — a Cycloid-owned PR
  // whose bot review was genuinely dropped (stays `no_review_listening_session` → suspicious).
  const contexts = await loadReviewLoopSessionContexts(input.env, sessionIds, input.prUrl);
  if (contexts.length === 0) return { status: "ignored", reason: "no_review_listening_session" };
  const prefetchedChecklistInputs = input.prefetchChecklistInputs
    ? await prefetchReviewLoopChecklistInputs(input.env, contexts, input.repoOwner, input.repoName)
    : null;

  const ignoredReasons: string[] = [];
  for (const { sessionId, session, ownerUserId } of contexts) {
    const outcome = await input.handleContext({ sessionId, session, ownerUserId, prefetchedChecklistInputs });
    if (outcome.status === "handled") return outcome;
    ignoredReasons.push(outcome.reason);
  }

  return { status: "ignored", reason: ignoredReasons[0] ?? "no_review_listening_session" };
}

export async function ingestReviewLoopPullRequestReviewWebhook(
  input: ReviewLoopPullRequestReviewWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    sessionIds: input.sessionId ? [input.sessionId] : undefined,
    prefetchChecklistInputs: !input.humanSource,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      // Human-source path: fold the human review into the existing bot wave.
      //
      // No stale-head guard here, by design: the owner's review is a deliberate instruction and must
      // survive a push (including Cycloid's own review-response push that advanced the head). The
      // fold re-attributes it to the current reviewListeningHeadSha below, so an old-head human review
      // lands on the live epoch and is carried into a prompt instead of being dropped. The stale-head
      // guard is retained for the bot path further down, where an old-head review IS stale (the bot
      // re-reviews the new head and emits fresh signals).
      if (input.humanSource) {
        // Manual review mode (ARC-1514): this is the human-review bypass path (folds/creates a human
        // epoch and returns before any checklist call), so it must be gated here too — the shared gate
        // alone is not sufficient. When automatic review handling is off, drop the human review before it
        // registers an epoch (and, via `shadowEmitReviewReceivedForIngest` returning early on `ignored`,
        // before it registers a disposition item). The eyes-ack reaction is also skipped (scheduled only
        // on `handled`). @cycloid mentions bypass this via their own `mention` epoch path.
        if (!(await resolveAutomaticReviewsEnabled({ db: input.env.DB, ownerUserId }))) {
          return { status: "ignored", reason: "review_handling_disabled" };
        }
        const headSha = session.reviewListeningHeadSha ?? input.headSha;
        // Look up any in-flight epoch for this head, ignoring expected_bots_hash,
        // so the human folds into the bot epoch rather than creating a separate one.
        const existing = await selectLatestEpochForHead(input.env.DB, {
          ownerUserId,
          sessionId,
          prUrl: input.prUrl,
          headSha,
        });
        // Only fold into an epoch that is still collecting signals (collecting/ready). Once it has been
        // claimed for prompting ("reserving") or dispatched, its worklist is frozen and the review can
        // no longer ride along, so create a fresh human epoch instead (immediately due, no bot wait).
        // Folding into a frozen epoch would record the review as triggering it never prompts — the exact
        // way owner reviews were being stranded, including the narrow claim→enqueue ("reserving") window.
        const foldable = existing !== null && epochAcceptsFoldIn(existing);
        const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
          sessionId,
          ownerUserId,
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          prNumber: input.prNumber,
          prUrl: input.prUrl,
          headSha,
          expectedBots: foldable ? existing.expectedBots : [],
          expectedBotsHash: foldable ? existing.expectedBotsHash : EMPTY_EXPECTED_BOTS_HASH,
          sourceId: input.sourceId,
          botKey: "human",
          botActorLogin: input.actorLogin,
          terminal: false,
          evidence: {
            type: "review_submission",
            sourceId: input.sourceId,
            reviewId: input.reviewId,
            reviewState: input.reviewState,
            deliveryId: input.deliveryId,
          },
          nowMs: Date.now(),
          humanSource: input.humanSource,
        });
        return { status: "handled", epoch };
      }

      // Bot path: a bot review on a superseded commit is genuinely stale — the bot re-reviews the new
      // head and emits fresh signals — so drop it rather than acting on feedback about code that has
      // since changed. (Human reviews above intentionally skip this guard.)
      if (
        session.reviewListeningHeadSha &&
        input.reviewCommitId &&
        session.reviewListeningHeadSha !== input.reviewCommitId
      ) {
        return { status: "ignored", reason: "stale_head" };
      }

      const checklist = await resolveReviewLoopChecklist(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!checklist.ok) return { status: "ignored", reason: checklist.reason };
      // Allow-list ingest: only a configured bot or a known-registry review bot's review submission is
      // ingested + triaged (resolveIngestBotKey); the configured-bots list governs only whether it is a
      // no-show-latch terminal (configured → terminal; known-but-unconfigured → respond-only).
      const ingest = resolveIngestBotKey({
        expectedBots: checklist.expectedBots,
        actorLogin: input.actorLogin,
        actorType: input.actorType,
        signal: "review_submission",
      });
      if (!ingest) return { status: "ignored", reason: "actor_not_configured_bot" };
      const botKey = ingest.key;

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha: session.reviewListeningHeadSha ?? input.headSha,
        expectedBots: checklist.expectedBots,
        expectedBotsHash: checklist.expectedBotsHash,
        sourceId: input.sourceId,
        botKey,
        botActorLogin: input.actorLogin,
        // Configured bot's review = a latch terminal; an unlisted bot is respond-only (never gates caught_up).
        terminal: ingest.configured,
        evidence: {
          type: "review_submission",
          sourceId: input.sourceId,
          reviewId: input.reviewId,
          reviewState: input.reviewState,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: input.humanSource ? "human" : "bot",
    webhookKind: "review_submission",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin,
    actorType: input.actorType,
  });
  await shadowEmitReviewReceivedForIngest(
    input.env,
    result,
    {
      webhookKind: "review_submission",
      actorType: input.actorType,
      actorLogin: input.actorLogin,
      // Align the shadow FSM worklist source id with the epoch's: a human review's epoch is keyed
      // `human:<reviewId>` (and its terminal stamps dispositions under that id), so registering it under the
      // raw webhook `review:<reviewId>` would leave the item permanently undispositioned and `caught_up` could
      // never go true for human-review feedback. Bot reviews keep `input.sourceId` (= their epoch's source id).
      sourceId: input.humanSource ? `human:${input.reviewId}` : input.sourceId,
      reviewState: input.reviewState,
      body: input.reviewBody,
    },
    input.waitUntil,
  );
  return result;
}

export interface ReviewLoopPullRequestReviewCommentWebhookInput {
  env: Env;
  deliveryId: string | null;
  /** PR 47: the webhook handler's ExecutionContext seam — live FSM side-effects defer through it. */
  waitUntil?: (promise: Promise<unknown>) => void;
  sourceId: string;
  commentId: number;
  commentBody: string | null;
  commentCommitId: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

export async function ingestReviewLoopPullRequestReviewCommentWebhook(
  input: ReviewLoopPullRequestReviewCommentWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prefetchChecklistInputs: true,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
      if (!headSha) return { status: "ignored", reason: "missing_head_sha" };
      const commentHeadSha = typeof input.commentCommitId === "string" ? input.commentCommitId.trim() : "";
      if (!commentHeadSha) return { status: "ignored", reason: "missing_head_sha" };
      if (headSha !== commentHeadSha) return { status: "ignored", reason: "stale_head" };

      const checklist = await resolveReviewLoopChecklist(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!checklist.ok) return { status: "ignored", reason: checklist.reason };
      // Allow-list ingest: only a configured bot or a known-registry review bot's inline review comment
      // is ingested (content signal; never a latch terminal) — resolveIngestBotKey.
      const botKey =
        resolveIngestBotKey({
          expectedBots: checklist.expectedBots,
          actorLogin: input.actorLogin,
          actorType: input.actorType,
          signal: "activity",
        })?.key ?? null;
      if (!botKey) return { status: "ignored", reason: "actor_not_configured_bot" };

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha,
        expectedBots: checklist.expectedBots,
        expectedBotsHash: checklist.expectedBotsHash,
        sourceId: input.sourceId,
        botKey,
        botActorLogin: input.actorLogin,
        terminal: false,
        evidence: {
          type: "review_comment_activity",
          sourceId: input.sourceId,
          commentId: input.commentId,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: "bot",
    webhookKind: "review_comment",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin,
    actorType: input.actorType,
  });
  await shadowEmitReviewReceivedForIngest(
    input.env,
    result,
    {
      webhookKind: "review_comment",
      actorType: input.actorType,
      actorLogin: input.actorLogin,
      sourceId: input.sourceId,
      body: input.commentBody,
    },
    input.waitUntil,
  );
  return result;
}

export interface ReviewLoopPrIssueCommentWebhookInput {
  env: Env;
  deliveryId: string | null;
  /** PR 47: the webhook handler's ExecutionContext seam — live FSM side-effects defer through it. */
  waitUntil?: (promise: Promise<unknown>) => void;
  sourceId: string;
  commentId: number;
  commentBody: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
}

export async function ingestReviewLoopPrIssueCommentWebhook(
  input: ReviewLoopPrIssueCommentWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  // The epoch's minted source id (`qa-verdict:<commentId>` for the QA carve-out, else `input.sourceId`),
  // captured out of the ingest closure so the FSM `review.received` producer registers the item under the
  // SAME id the epoch terminal later dispositions — see the shadowEmit call below.
  let emittedReviewSourceId: string | null = null;
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prefetchChecklistInputs: true,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      const checklist = await resolveReviewLoopChecklist(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!checklist.ok) return { status: "ignored", reason: checklist.reason };
      // D3: the terminal (latch) determination stays allowlist-only — only a configured bot's final
      // issue comment can settle the no-show latch. The activity tier ingests any bot's content.
      const terminalBotKey =
        matchReviewLoopBot({
          expectedBots: checklist.expectedBots,
          actorLogin: input.actorLogin,
          actorType: input.actorType,
          signal: "issue_comment_final",
        })?.key ?? null;
      const botKey =
        terminalBotKey ??
        resolveIngestBotKey({
          expectedBots: checklist.expectedBots,
          actorLogin: input.actorLogin,
          actorType: input.actorType,
          signal: "activity",
          // A4: the QA verifier's managed comment (cycloid-qa[bot]) is carved into ingest here — admitted
          // under known:cycloid-qa only when it carries the managed QA marker for this PR.
          body: input.commentBody,
          qaMarkerTarget: { owner: input.repoOwner, repo: input.repoName, prNumber: input.prNumber },
        })?.key ??
        null;
      if (!botKey) return { status: "ignored", reason: "actor_not_configured_bot" };
      // A managed QA comment settles into an epoch ONLY for an app_breaks verdict; a clean/none verdict is
      // inert (it never re-opens the PR). Non-QA keys are unaffected.
      if (
        botKey === CYCLOID_QA_BOT_KEY &&
        !qaCommentVerdictActionable(
          extractManagedQaCommentVerdict(input.commentBody ?? "", {
            owner: input.repoOwner,
            repo: input.repoName,
            prNumber: input.prNumber,
          }),
        )
      ) {
        return { status: "ignored", reason: "qa_verdict_not_actionable" };
      }
      const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
      if (!headSha) return { status: "ignored", reason: "missing_head_sha" };
      // Keep the QA item's source id in lockstep with the sweep path (`qa-verdict:<commentId>`) so the two
      // intake seams share one disposition key (no double intake) and the epoch.committed re-run trigger (A4)
      // can recognize a QA-sourced disposition.
      const sourceId = botKey === CYCLOID_QA_BOT_KEY ? `qa-verdict:${input.commentId}` : input.sourceId;
      emittedReviewSourceId = sourceId;

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha,
        expectedBots: checklist.expectedBots,
        expectedBotsHash: checklist.expectedBotsHash,
        sourceId,
        botKey,
        botActorLogin: input.actorLogin,
        terminal: Boolean(terminalBotKey),
        evidence: {
          type: terminalBotKey ? "issue_comment_final" : "issue_comment_activity",
          sourceId,
          commentId: input.commentId,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: "bot",
    webhookKind: "issue_comment",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin,
    actorType: input.actorType,
  });
  await shadowEmitReviewReceivedForIngest(
    input.env,
    result,
    {
      webhookKind: "issue_comment",
      actorType: input.actorType,
      actorLogin: input.actorLogin,
      // Align the FSM worklist source id with the epoch's: a QA comment's epoch is keyed
      // `qa-verdict:<commentId>` (and its terminal dispositions under that id), so registering the
      // `review.received` item under the raw `issue-comment:<commentId>` would leave it permanently
      // undispositioned and `caught_up` could never fire for an ingested QA app_breaks. Non-QA keys keep
      // `input.sourceId` (== their epoch's source id). Mirrors the review_submission human-alignment above.
      sourceId: emittedReviewSourceId ?? input.sourceId,
      body: input.commentBody,
    },
    input.waitUntil,
  );
  return result;
}

export interface ReviewLoopCheckRunWebhookInput {
  env: Env;
  deliveryId: string | null;
  sourceId: string;
  checkRunId: number;
  checkRunName: string | null;
  checkRunStatus: string;
  checkRunConclusion: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

export async function ingestReviewLoopCheckRunWebhook(
  input: ReviewLoopCheckRunWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prefetchChecklistInputs: true,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
      if (!headSha) return { status: "ignored", reason: "missing_head_sha" };
      if (headSha !== input.headSha) return { status: "ignored", reason: "stale_head" };

      const checklist = await resolveReviewLoopChecklist(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!checklist.ok) return { status: "ignored", reason: checklist.reason };
      const botKey =
        matchReviewLoopBot({
          expectedBots: checklist.expectedBots,
          actorLogin: input.actorLogin,
          actorType: input.actorType,
          signal: "check_run",
        })?.key ?? null;
      if (!botKey) return { status: "ignored", reason: "actor_not_configured_bot" };
      // Only a completed conclusion (any conclusion, not just success) counts as the bot finishing.
      if (!isObservedTerminalCheckConclusion(input.checkRunStatus, input.checkRunConclusion)) {
        return { status: "ignored", reason: `non_terminal_conclusion:${input.checkRunConclusion ?? "null"}` };
      }

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha,
        expectedBots: checklist.expectedBots,
        expectedBotsHash: checklist.expectedBotsHash,
        sourceId: input.sourceId,
        botKey,
        botActorLogin: input.actorLogin,
        terminal: true,
        evidence: {
          type: "check_run",
          sourceId: input.sourceId,
          checkRunId: input.checkRunId,
          checkRunName: input.checkRunName,
          status: input.checkRunStatus,
          conclusion: input.checkRunConclusion,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: "bot",
    webhookKind: "check_run",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin,
    actorType: input.actorType,
  });
  return result;
}

export interface ReviewLoopCiFailureWebhookInput {
  env: Env;
  deliveryId: string | null;
  sourceId: string;
  checkRunId: number;
  checkRunName: string | null;
  checkRunConclusion: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

/**
 * Records a failing terminal `check_run` (from ANY app) on a review-listening PR as a
 * `ci` epoch. The epoch keys on REVIEW_LOOP_CI_EPOCH_HASH (sentinel expected-bots hash) so it
 * never folds into a concurrent bot/human review epoch on the same head — see the constant.
 * The resolveReviewLoopChecklist call here is only the feature-enabled gate; its
 * expectedBots/hash are intentionally NOT used for the CI epoch.
 */
export async function ingestReviewLoopCiFailureWebhook(
  input: ReviewLoopCiFailureWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prefetchChecklistInputs: true,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
      if (!headSha) return { status: "ignored", reason: "missing_head_sha" };
      if (headSha !== input.headSha) return { status: "ignored", reason: "stale_head" };
      const ciEligibility = await resolveReviewLoopCiEligibility(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!ciEligibility.ok) return { status: "ignored", reason: ciEligibility.reason };

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha,
        expectedBots: [], // CI epochs wait on no bots
        expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash, // sentinel — isolates from bot/human epochs
        sourceId: input.sourceId,
        sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind, // honored by insertReviewLoopEpochActivity (input.sourceKind ?? "bot")
        botKey: "ci", // non-empty placeholder; not used for CI worklist
        botActorLogin: input.actorLogin,
        terminal: true,
        evidence: {
          type: "ci_failure",
          sourceId: input.sourceId,
          checkRunId: input.checkRunId,
          checkRunName: input.checkRunName,
          conclusion: input.checkRunConclusion,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: "ci",
    webhookKind: "check_run",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
  });
  return result;
}

export interface ReviewLoopCommitStatusWebhookInput {
  env: Env;
  deliveryId: string | null;
  sourceId: string;
  statusId: number;
  context: string | null;
  state: string;
  description: string | null;
  targetUrl: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

export async function ingestReviewLoopCommitStatusWebhook(
  input: ReviewLoopCommitStatusWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const result = await runReviewLoopWebhookIngest({
    env: input.env,
    prUrl: input.prUrl,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prefetchChecklistInputs: true,
    handleContext: async ({ sessionId, session, ownerUserId, prefetchedChecklistInputs }) => {
      const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
      if (!headSha) return { status: "ignored", reason: "missing_head_sha" };
      if (headSha !== input.headSha) return { status: "ignored", reason: "stale_head" };

      const checklist = await resolveReviewLoopChecklist(input.env, {
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ...(prefetchedChecklistInputs ?? {}),
      });
      if (!checklist.ok) return { status: "ignored", reason: checklist.reason };
      const botKey =
        matchReviewLoopBot({
          expectedBots: checklist.expectedBots,
          actorLogin: input.actorLogin,
          actorType: input.actorType,
          signal: "commit_status",
        })?.key ?? null;
      if (!botKey) return { status: "ignored", reason: "actor_not_configured_bot" };
      // Any non-pending commit status (success/failure/error/...) means the bot finished.
      if (!isObservedTerminalCommitStatusState(input.state)) {
        return { status: "ignored", reason: `non_terminal_state:${input.state || "unknown"}` };
      }

      const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
        sessionId,
        ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        headSha,
        expectedBots: checklist.expectedBots,
        expectedBotsHash: checklist.expectedBotsHash,
        sourceId: input.sourceId,
        botKey,
        botActorLogin: input.actorLogin,
        terminal: true,
        evidence: {
          type: "commit_status",
          sourceId: input.sourceId,
          statusId: input.statusId,
          context: input.context,
          state: input.state,
          description: input.description,
          targetUrl: input.targetUrl,
          deliveryId: input.deliveryId,
        },
        nowMs: Date.now(),
      });
      return { status: "handled", epoch };
    },
  });
  await emitReviewLoopWebhookIngestOutcome(input.env, result, {
    sourceKind: "bot",
    webhookKind: "commit_status",
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin,
    actorType: input.actorType,
  });
  return result;
}

export interface ReviewLoopHumanBootstrapArgs {
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  triggeringSourceId: string;
  /** The GitHub user id of the reviewer, if known. Falls back to ownerUserId. */
  reviewerUserId?: number;
  nowMs: number;
}

/**
 * Bootstrap (or fold into) a review-loop epoch for a human reviewer signal.
 * Shared with re-engage: delegates all CAS/idempotency to upsertReviewLoopEpochActivity.
 * The resulting epoch is immediately `ready` (fallbackAfterAt = nowMs, empty expected bots).
 */
export async function bootstrapReviewLoopEpochForHuman(
  db: D1Database,
  args: ReviewLoopHumanBootstrapArgs,
): Promise<ReviewLoopEpoch> {
  // Use the explicit reviewerUserId when provided; fall back to ownerUserId.
  const humanUserId = args.reviewerUserId ?? args.ownerUserId;

  return upsertReviewLoopEpochActivity(db, {
    sessionId: args.sessionId,
    ownerUserId: args.ownerUserId,
    repoOwner: args.repoOwner,
    repoName: args.repoName,
    prNumber: args.prNumber,
    prUrl: args.prUrl,
    headSha: args.headSha,
    expectedBots: [],
    expectedBotsHash: EMPTY_EXPECTED_BOTS_HASH,
    sourceId: args.triggeringSourceId,
    botKey: "human",
    botActorLogin: null,
    terminal: false,
    evidence: null,
    nowMs: args.nowMs,
    humanSource: { userId: humanUserId, login: "" },
  });
}

export interface FsmDispatchedReviewLoopEpochArgs {
  /**
   * The committed `pr_coordination.in_flight_epoch_id` — used verbatim as this epoch row's PRIMARY
   * KEY `id`. That is the §17-B idempotency anchor: the FSM stamps the id under the SAME CAS as the
   * `dispatch_epoch` side-effect, so a redelivered/retried dispatch for the same committed version
   * carries the same id and the `INSERT OR IGNORE` below no-ops (changes = 0) — never double-creating.
   */
  id: string;
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  /** Selects the storage sentinel and source kind for the materialized FSM work item. */
  kind: "review" | "ci";
  /**
   * The completed CI epoch whose failing-check provenance authorizes a retry. Required for `kind =
   * 'ci'`; the insert proves this row is still the newest CI wave in the same atomic statement.
   */
  predecessorEpochId?: string;
  /**
   * The traced worklist. Review epochs carry registered disposition-store items; CI retry epochs copy
   * the failing-check source ids from their preceding real CI epoch. The executor rejects an empty set
   * upstream, so neither trigger can fabricate evidence.
   */
  sourceIds: string[];
  nowMs: number;
}

/**
 * Create the review-loop epoch the FSM's `dispatch_epoch` side-effect owns (Wave-11 W11-V5 — epoch
 * creation authority transfer, §17-B). UNLIKE the bootstrap creators this keys the row on an EXPLICIT
 * `id` (the committed `in_flight_epoch_id`) rather than a fresh UUID, so the executor's by-id
 * exists-check is the idempotency anchor.
 *
 * Shape: an immediately-DUE epoch with NO expected bots to wait on and `status = 'ready'`, so the
 * existing sweep (`claimReviewLoopEpochForPrompt`) claims and dispatches it exactly like a legacy-created
 * row. Review work uses `source_kind = 'mixed'` plus the empty-bot hash; CI retry work uses the existing
 * `ci` / `ci-fixes` sentinels. The traced `sourceIds` are stored in both `triggering_source_ids` and
 * `handled_source_ids`.
 *
 * WAVE (MAJOR-2 fix): review work uses `MAX(wave)+1` for this unique key, mirroring legacy
 * `insertReviewLoopEpochActivity`'s `existing.wave+1`. CI retries use a stricter atomic insert: the
 * supplied completed predecessor must still be the newest CI wave, and the new row takes exactly its
 * `wave+1`. If legacy CI ingest wins that wave, the FSM insert stops instead of retrying at `wave+2` and
 * double-driving the same red head. The PK `id` remains the redelivery anchor for both kinds.
 */
export async function createFsmDispatchedReviewLoopEpoch(
  db: D1Database,
  args: FsmDispatchedReviewLoopEpochArgs,
): Promise<ReviewLoopEpoch | null> {
  const repoOwner = args.repoOwner.trim().toLowerCase();
  const repoName = args.repoName.trim().toLowerCase();
  const sourceIds = JSON.stringify(args.sourceIds);
  const expectedBotsHash =
    args.kind === "ci" ? REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash : EMPTY_EXPECTED_BOTS_HASH;
  const sourceKind = args.kind === "ci" ? REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind : "mixed";
  if (args.kind === "ci") {
    if (!args.predecessorEpochId) return null;
    await db
      .prepare(
        `${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO pr_review_response_epochs (
          id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
          expected_bots_hash, expected_bots_json, expected_bot_keys_json,
          observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
          handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
          timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
          status, source_kind, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, predecessor.wave + 1, ?, '[]', '[]', '[]', '[]', 0,
               ?, ?, '[]', '[]', '[]', ?, ?, 'ready', ?, ?, ?
        FROM pr_review_response_epochs AS predecessor
        WHERE predecessor.id = ?
          AND predecessor.owner_user_id = ?
          AND predecessor.session_id = ?
          AND predecessor.pr_url = ?
          AND predecessor.head_sha = ?
          AND predecessor.expected_bots_hash = ?
          AND predecessor.source_kind = 'ci'
          AND predecessor.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM pr_review_response_epochs AS newer
            WHERE newer.owner_user_id = predecessor.owner_user_id
              AND newer.session_id = predecessor.session_id
              AND newer.pr_url = predecessor.pr_url
              AND newer.head_sha = predecessor.head_sha
              AND newer.expected_bots_hash = predecessor.expected_bots_hash
              AND newer.wave > predecessor.wave
          )`,
      )
      .bind(
        args.id,
        args.sessionId,
        args.ownerUserId,
        repoOwner,
        repoName,
        args.prNumber,
        args.prUrl,
        args.headSha,
        expectedBotsHash,
        sourceIds,
        sourceIds,
        args.nowMs,
        args.nowMs,
        sourceKind,
        args.nowMs,
        args.nowMs,
        args.predecessorEpochId,
        args.ownerUserId,
        args.sessionId,
        args.prUrl,
        args.headSha,
        expectedBotsHash,
      )
      .run();
    return getReviewLoopEpochById(db, args.id);
  }
  for (let attempt = 0; attempt < MAX_EPOCH_MERGE_CAS_ATTEMPTS; attempt += 1) {
    const maxWaveRow = await db
      .prepare(
        `SELECT MAX(wave) AS max_wave FROM pr_review_response_epochs
         WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ? AND expected_bots_hash = ?`,
      )
      .bind(args.ownerUserId, args.sessionId, args.prUrl, args.headSha, expectedBotsHash)
      .first<{ max_wave: number | null }>();
    const wave = Number(maxWaveRow?.max_wave ?? 0) + 1;
    const result = await db
      .prepare(
        `${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO pr_review_response_epochs (
          id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
          expected_bots_hash, expected_bots_json, expected_bot_keys_json,
          observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
          handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
          timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
          status, source_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', 0, ?, ?, '[]', '[]', '[]', ?, ?, 'ready', ?, ?, ?)`,
      )
      .bind(
        args.id,
        args.sessionId,
        args.ownerUserId,
        repoOwner,
        repoName,
        args.prNumber,
        args.prUrl,
        args.headSha,
        wave,
        expectedBotsHash,
        sourceIds,
        sourceIds,
        args.nowMs,
        args.nowMs,
        sourceKind,
        args.nowMs,
        args.nowMs,
      )
      .run();
    if (d1Changed(result)) return getReviewLoopEpochById(db, args.id);
    // changes = 0 (OR IGNORE). Disambiguate: a row now under OUR committed id = the §17-B redelivery
    // anchor (bind to it, idempotent). Otherwise a concurrent creator took this wave — re-read + retry.
    const existingById = await getReviewLoopEpochById(db, args.id);
    if (existingById) return existingById;
  }
  return null;
}

export interface ReviewLoopVerificationBootstrapArgs {
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  /** Identifies one QTA needs-work verdict, e.g. `verification:<headSha>:<attempt>`. */
  triggeringSourceId: string;
  nowMs: number;
}

/**
 * Bootstrap (or fold into) a verification-intake epoch for a QTA needs-work verdict (RLA v2).
 * Keys on the verification sentinel hash so it never folds into a bot/human epoch on the same
 * head; waits on no bots and is immediately due (fallback = now). Idempotent on the triggering
 * source id via upsertReviewLoopEpochActivity — re-ingesting the same verdict merges instead of
 * opening a new wave, while a later verdict (new source id) on a terminal epoch opens one.
 */
export async function bootstrapReviewLoopEpochForVerification(
  db: D1Database,
  args: ReviewLoopVerificationBootstrapArgs,
): Promise<ReviewLoopEpoch> {
  return upsertReviewLoopEpochActivity(db, {
    sessionId: args.sessionId,
    ownerUserId: args.ownerUserId,
    repoOwner: args.repoOwner,
    repoName: args.repoName,
    prNumber: args.prNumber,
    prUrl: args.prUrl,
    headSha: args.headSha,
    expectedBots: [],
    expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.verificationExpectedBotsHash,
    sourceId: args.triggeringSourceId,
    sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.verificationSourceKind,
    botKey: "verification",
    botActorLogin: null,
    terminal: false,
    evidence: null,
    nowMs: args.nowMs,
  });
}

export interface ReviewLoopMergeConflictBootstrapArgs {
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  nowMs: number;
}

/**
 * Bootstrap (or fold into) a merge-conflict resolution epoch for a dirty PR head. Keyed on a
 * merge-conflict sentinel hash and a deterministic source id so the sweep starts at most one rescue
 * turn per head while keeping conflict resolution independent from reviewer, CI, and verification rows.
 */
export async function bootstrapReviewLoopEpochForMergeConflict(
  db: D1Database,
  args: ReviewLoopMergeConflictBootstrapArgs,
): Promise<ReviewLoopEpoch> {
  const sourceId = `merge-conflict:${args.headSha}`;
  const input: ReviewLoopActivityInput = {
    sessionId: args.sessionId,
    ownerUserId: args.ownerUserId,
    repoOwner: args.repoOwner,
    repoName: args.repoName,
    prNumber: args.prNumber,
    prUrl: args.prUrl,
    headSha: args.headSha,
    expectedBots: [],
    expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictExpectedBotsHash,
    sourceId,
    sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.mergeConflictSourceKind,
    botKey: "merge-conflict",
    botActorLogin: null,
    terminal: false,
    evidence: { type: "merge_conflict", sourceId },
    nowMs: args.nowMs,
  };

  const existing = await selectLatestEpochByUniqueKey(db, input);
  if (existing && ["completed", "blocked"].includes(existing.status) && !existing.worklistHash) {
    const inserted = await insertReviewLoopEpochActivity(db, input, existing.wave + 1);
    if (inserted) return inserted;
    await assertEpochInsertLostRace(db, input, existing.wave);
    const winner = await selectLatestEpochByUniqueKey(db, input);
    if (winner && winner.wave > existing.wave) return winner;
    throw new Error("Review-loop merge-conflict retry insert lost race without a retry wave");
  }

  return upsertReviewLoopEpochActivity(db, input);
}

/**
 * The mention payload carried in a mention epoch's `terminal_evidence_json`, self-contained so the
 * sweep can rebuild the agent prompt at dispatch WITHOUT re-fetching GitHub (the diff hunk in
 * particular is not carried on the review-comment worklist item). The webhook (PR6/7/8) captures the
 * comment/parent bodies at mention time — a point-in-time directive, so a later reviewer edit must not
 * change what the agent was asked to do. All fields are UNTRUSTED GitHub text; the prompt builders
 * wrap every segment with `wrapUserContent`.
 */
export interface MentionEpochEvidence {
  type: "mention";
  /** Discriminates the prompt template the sweep builds: a scoped comment vs a free-text directive. */
  mode: "targeted" | "directive";
  /**
   * The TARGET source ids the agent should reply to (the mention's `targetSourceIds` — NOT the
   * replied-to parents, which are context only). Carried in the payload so the sweep can print a
   * `Source: <id>` line in the dispatch prompt, giving the agent the id to pass to
   * `cycloid.review_loop_reply`. Optional for back-compat with any pre-existing stored payload.
   */
  sourceIds?: string[];
  /** The verbatim `@cycloid …` mention text. */
  mentionText: string;
  /** Present for `mode: "targeted"`: the review comment the agent is scoped to. */
  comment?: { author: string; body: string; path: string | null; diffHunk: string | null };
  /** Present for `mode: "targeted"`: the replied-to parent comment surfaced as context, if any. */
  parentComment?: { author: string; body: string } | null;
}

export interface ReviewLoopMentionBootstrapArgs {
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  /** Discriminates the dispatch prompt template. */
  mode: "targeted" | "directive";
  /**
   * The source ids this mention scopes the agent to (a targeted reply's replied-to comment, or the
   * directive comment itself). Seeded as BOTH triggering and handled + used as promptedSourceIds at
   * dispatch, so settlement + the per-source prompted dedup treat the mention as handled once
   * dispatched. Must be non-empty.
   */
  targetSourceIds: string[];
  /** The replied-to parent source ids surfaced as context (optional). */
  parentSourceIds?: string[];
  /** The verbatim `@cycloid …` mention text (untrusted). */
  mentionText: string;
  /** For a targeted mention: the captured comment the sweep renders (untrusted). */
  comment?: { author: string; body: string; path: string | null; diffHunk: string | null };
  /** For a targeted mention: the captured replied-to parent (untrusted), if any. */
  parentComment?: { author: string; body: string } | null;
  nowMs: number;
}

/**
 * The highest-wave NON-TERMINAL mention epoch on this head whose triggering set OVERLAPS the new
 * mention's TARGET ids — the idempotency anchor for {@link bootstrapMentionEpoch}. A distinct GitHub
 * comment always carries a distinct id, so the ONLY way a new mention's target overlaps a live
 * mention epoch is a redelivery of that same comment: the webhook caller runs bootstrap then
 * `emitReviewListeningEntered`; if the emit throws it releases the claim and GitHub redelivers the
 * SAME comment, re-running bootstrap with identical `targetSourceIds`. Non-terminal =
 * {@link NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUSES} (everything except the terminal `completed`/`blocked`
 * set): a redelivery while the first epoch is still live returns it (no second wave); a genuinely new
 * mention after the first has SETTLED finds no live epoch and mints fresh (correct — new work).
 *
 * Filters triggering membership in the app layer (like {@link selectHumanEpochCarryingSource}) rather
 * than a SQL `json_each`, so the FakeD1 test harness exercises the same path. The inlined sentinel /
 * status IN-list are fixed allowlists (never user input); the caller-supplied keys are parameterized.
 */
async function selectLiveMentionEpochForTargets(
  db: D1Database,
  input: { ownerUserId: number; sessionId: string; prUrl: string; headSha: string },
  targetSourceIds: readonly string[],
): Promise<ReviewLoopEpoch | null> {
  const targets = new Set(targetSourceIds);
  if (targets.size === 0) return null;
  const rows = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ?
         AND source_kind = '${REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind}'
         AND status IN (${NON_TERMINAL_REVIEW_LOOP_EPOCH_STATUS_SQL})
       ORDER BY wave DESC`,
    )
    .bind(input.ownerUserId, input.sessionId, input.prUrl, input.headSha)
    .all<ReviewLoopEpochRow>();
  for (const row of rows.results ?? []) {
    const epoch = rowToEpoch(row);
    if (epoch.triggeringSourceIds.some((id) => targets.has(id))) return epoch;
  }
  return null;
}

/**
 * Bootstrap a `ready`, immediately-due `@cycloid` mention epoch (PR6/7/8 call this from the webhook;
 * the sweep then claims + dispatches it through the normal lifecycle). Keyed on the mention sentinel
 * hash so it never folds into — or is folded into by — a bot/human/ci/verification/merge-conflict
 * epoch on the same head; each distinct mention on a head takes its own wave under that hash
 * (`MAX(wave)+1`, mirroring `createFsmDispatchedReviewLoopEpoch`). The mention payload is stored in
 * `terminal_evidence_json` so dispatch is self-contained. Returns the created/bound row, or null when
 * the retry budget is exhausted (a lost race with no committed row).
 *
 * Idempotent on webhook redelivery: before minting a new wave it binds to any still-live mention epoch
 * on this head whose triggering set already overlaps `targetSourceIds` (see
 * {@link selectLiveMentionEpochForTargets}), so a redelivered `@cycloid` comment does not double-mint
 * two ready waves that the sweep would then dispatch as two agent turns for one mention.
 */
export async function bootstrapMentionEpoch(
  db: D1Database,
  args: ReviewLoopMentionBootstrapArgs,
): Promise<ReviewLoopEpoch | null> {
  if (args.targetSourceIds.length === 0) {
    throw new Error("bootstrapMentionEpoch requires at least one targetSourceId");
  }
  const repoOwner = args.repoOwner.trim().toLowerCase();
  const repoName = args.repoName.trim().toLowerCase();
  // The TARGET ids are what the agent replies to (printed as `Source:` in the dispatch prompt).
  const targetSourceIds = sortedUnique(args.targetSourceIds);
  // Handled/triggering set = targets PLUS the replied-to parents. Folding the parents in marks them
  // "addressed by this epoch" so cross-epoch dedup (listKnownReviewLoopSourceIds reads
  // triggering_source_ids_json; epochAccountsForSource reads handled_source_ids_json) does not leave a
  // replied-to parent in a sibling human epoch's undispositioned set to be re-dispatched as new
  // unresolved feedback. Parents are context in the prompt, not reply targets, so they stay OUT of the
  // evidence `sourceIds`.
  const sourceIds = sortedUnique([...args.targetSourceIds, ...(args.parentSourceIds ?? [])]);
  const sourceIdsJson = JSON.stringify(sourceIds);
  const evidence: MentionEpochEvidence = {
    type: "mention",
    mode: args.mode,
    sourceIds: targetSourceIds,
    mentionText: args.mentionText,
    ...(args.comment ? { comment: args.comment } : {}),
    ...(args.parentComment !== undefined ? { parentComment: args.parentComment } : {}),
  };
  const evidenceJson = JSON.stringify([evidence]);
  // Idempotency guard for webhook redelivery: if the caller's post-bootstrap emit throws it releases
  // the webhook claim and GitHub redelivers the SAME comment, re-running this with identical
  // targetSourceIds. Bind to the still-live mention epoch that already covers these targets instead of
  // minting a SECOND ready wave (which the sweep would dispatch as a second agent turn). A genuinely
  // new mention (distinct comment id → distinct target) does not overlap and falls through to mint; a
  // new mention after the first has SETTLED (completed/blocked) finds no live epoch and also mints.
  const existingMention = await selectLiveMentionEpochForTargets(
    db,
    { ownerUserId: args.ownerUserId, sessionId: args.sessionId, prUrl: args.prUrl, headSha: args.headSha },
    targetSourceIds,
  );
  if (existingMention) {
    console.log("[review-loop] mention bootstrap idempotent hit (webhook redelivery)", {
      sessionId: args.sessionId,
      prUrl: args.prUrl,
      headSha: args.headSha,
      epochId: existingMention.id,
      targetSourceIds,
    });
    return existingMention;
  }
  for (let attempt = 0; attempt < MAX_EPOCH_MERGE_CAS_ATTEMPTS; attempt += 1) {
    const id = crypto.randomUUID();
    const maxWaveRow = await db
      .prepare(
        `SELECT MAX(wave) AS max_wave FROM pr_review_response_epochs
         WHERE owner_user_id = ? AND session_id = ? AND pr_url = ? AND head_sha = ? AND expected_bots_hash = ?`,
      )
      .bind(
        args.ownerUserId,
        args.sessionId,
        args.prUrl,
        args.headSha,
        REVIEW_LOOP_EPOCH_SENTINELS.mentionExpectedBotsHash,
      )
      .first<{ max_wave: number | null }>();
    const wave = Number(maxWaveRow?.max_wave ?? 0) + 1;
    const result = await db
      .prepare(
        `${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO pr_review_response_epochs (
          id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
          expected_bots_hash, expected_bots_json, expected_bot_keys_json,
          observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
          handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
          timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
          status, source_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', 0, ?, ?, ?, '[]', '[]', ?, ?, 'ready', ?, ?, ?)`,
      )
      .bind(
        id,
        args.sessionId,
        args.ownerUserId,
        repoOwner,
        repoName,
        args.prNumber,
        args.prUrl,
        args.headSha,
        wave,
        REVIEW_LOOP_EPOCH_SENTINELS.mentionExpectedBotsHash,
        sourceIdsJson,
        sourceIdsJson,
        evidenceJson,
        args.nowMs,
        args.nowMs,
        REVIEW_LOOP_EPOCH_SENTINELS.mentionSourceKind,
        args.nowMs,
        args.nowMs,
      )
      .run();
    if (d1Changed(result)) return getReviewLoopEpochById(db, id);
    // changes = 0 (OR IGNORE): a concurrent creator took this wave. Re-read MAX(wave) and retry a
    // higher wave (the fresh UUID id means we never bind to a prior mention's row by accident).
  }
  return null;
}

export interface ReviewLoopBootstrapInput {
  env: Pick<Env, "DB">;
  sessionId: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  checkRuns: CommitCheckRun[];
  commitStatuses: CommitStatusContext[];
  nowMs: number;
}

export interface ReviewLoopBootstrapResult {
  bootstrapped: number;
  ignored: Array<{ sourceId: string; reason: string }>;
  epoch: ReviewLoopEpoch | null;
}

export async function bootstrapReviewLoopEpochFromHeadSignals(
  input: ReviewLoopBootstrapInput,
): Promise<ReviewLoopBootstrapResult> {
  const ignored: Array<{ sourceId: string; reason: string }> = [];
  let bootstrapped = 0;
  let latestEpoch: ReviewLoopEpoch | null = null;

  const seenStatusProducers = new Set<string>();
  for (const status of input.commitStatuses) {
    const sourceId = `commit-status:${status.id}:${input.prNumber}`;
    const producerKey = `${status.creatorLogin ?? ""}:${status.context ?? ""}`;
    if (seenStatusProducers.has(producerKey)) {
      ignored.push({ sourceId, reason: "superseded_by_newer_status" });
      continue;
    }
    seenStatusProducers.add(producerKey);
    if (!isObservedTerminalCommitStatusState(status.state)) {
      ignored.push({ sourceId, reason: `state:${status.state || "unknown"}` });
      continue;
    }
    const botKey =
      matchReviewLoopBot({
        expectedBots: input.expectedBots,
        actorLogin: status.creatorLogin,
        actorType: status.creatorType ?? "",
        signal: "commit_status",
      })?.key ?? null;
    if (!botKey) {
      ignored.push({ sourceId, reason: "actor_not_configured_bot" });
      continue;
    }
    latestEpoch = await upsertReviewLoopEpochActivity(input.env.DB, {
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      headSha: input.headSha,
      expectedBots: input.expectedBots,
      expectedBotsHash: input.expectedBotsHash,
      sourceId,
      botKey,
      botActorLogin: status.creatorLogin,
      terminal: true,
      evidence: {
        type: "commit_status",
        source: "head_reconciliation",
        sourceId,
        statusId: status.id,
        context: status.context,
        state: status.state,
        description: status.description,
        targetUrl: status.targetUrl,
      },
      nowMs: input.nowMs,
    });
    bootstrapped += 1;
  }

  for (const run of input.checkRuns) {
    const sourceId = `check-run:${run.id}:${input.prNumber}`;
    if (!isObservedTerminalCheckConclusion(run.status, run.conclusion)) {
      ignored.push({ sourceId, reason: `conclusion:${run.conclusion ?? "null"}` });
      continue;
    }
    const actorLogin = run.appSlug ? `${run.appSlug}[bot]` : null;
    const botKey = actorLogin
      ? (matchReviewLoopBot({
          expectedBots: input.expectedBots,
          actorLogin,
          actorType: "Bot",
          signal: "check_run",
        })?.key ?? null)
      : null;
    if (!botKey) {
      ignored.push({ sourceId, reason: "actor_not_configured_bot" });
      continue;
    }
    latestEpoch = await upsertReviewLoopEpochActivity(input.env.DB, {
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      headSha: input.headSha,
      expectedBots: input.expectedBots,
      expectedBotsHash: input.expectedBotsHash,
      sourceId,
      botKey,
      botActorLogin: actorLogin,
      terminal: true,
      evidence: {
        type: "check_run",
        source: "head_reconciliation",
        sourceId,
        checkRunId: run.id,
        checkRunName: run.name,
        status: run.status,
        conclusion: run.conclusion,
        appSlug: run.appSlug,
      },
      nowMs: input.nowMs,
    });
    bootstrapped += 1;
  }

  return { bootstrapped, ignored, epoch: latestEpoch };
}

/**
 * ARC-1407: settle an epoch from SELF-AUTHENTICATING push evidence when the normal prompt-id-gated
 * completion (`markReviewLoopEpochCompleted`) cannot fire — the recording prompt is stale, the epoch
 * has moved on to a later prompt id, or it was already terminalized `blocked` while a verified fix push
 * was discarded (the exact `epoch_not_processing` wedge). Verified reality beats bookkeeping state.
 *
 * The settle is ANCHORED on a succeeded `push` operation at the verified remote head (the caller writes
 * that row immediately before calling this), so it can never fire without real, verified evidence. It
 * therefore relaxes the prompt-id/status CAS to any non-`completed` status — which is what un-wedges a
 * spuriously-`blocked` epoch — while reusing the SAME carry-forward-aware settle as
 * `markReviewLoopEpochCompleted`: complete cleanly when nothing is carried forward, else re-drive to
 * `ready` (or `blocked` at the wave cap) so a budget-dropped tail is never lost. Idempotent: returns
 * null (no-op) on an already-`completed` epoch or when no matching succeeded push op exists.
 */
export async function completeReviewLoopEpochFromVerifiedPush(
  db: D1Database,
  epochId: string,
  options: { nowMs: number; verifiedHeadSha: string; telemetry?: ReviewLoopEpochTelemetry },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET status = ${CARRY_FORWARD_SETTLE_STATUS_SQL},
           blocked_reason = CASE WHEN ${CARRY_FORWARD_BLOCKING_SQL} THEN '${REVIEW_LOOP_TRUNCATION_UNRESOLVED_REASON}' ELSE NULL END,
           last_prompt_id = CASE WHEN ${CARRY_FORWARD_REDRIVING_SQL} THEN NULL ELSE last_prompt_id END,
           last_error = CASE WHEN ${CARRY_FORWARD_REDRIVING_SQL} THEN NULL ELSE last_error END,
           lease_owner = NULL, lease_expires_at = NULL, reservation_token = NULL, updated_at = ?
       WHERE id = ?
         AND status != 'completed'
         AND EXISTS (
           SELECT 1 FROM pr_review_response_operations
            WHERE epoch_id = ? AND kind = 'push' AND status = 'succeeded' AND github_id = ?
         )`,
    )
    .bind(options.nowMs, epochId, epochId, options.verifiedHeadSha)
    .run();
  if (!d1Changed(result)) return null;
  const epoch = await getReviewLoopEpochById(db, epochId);
  await emitEpochTerminalTelemetry(epoch, options.telemetry);
  return epoch;
}

/**
 * ARC-1407: push an in-flight epoch's lease out by one lease window WITHOUT changing status or prompt.
 * Used by the stuck-epoch reclaim to keep an epoch whose agent is still alive from being reclaimed (and
 * blindly re-prompted) — the reclaim otherwise fires purely on lease expiry with no liveness check.
 * CAS'd on the observed `lease_expires_at` so it never races a concurrent transition; returns null on a
 * miss (status already advanced, or the lease moved).
 */
export async function extendReviewLoopEpochLease(
  db: D1Database,
  epochId: string,
  options: { nowMs: number; expectedLeaseExpiresAt: number | null },
): Promise<ReviewLoopEpoch | null> {
  const result = await db
    .prepare(
      `UPDATE pr_review_response_epochs
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('enqueued', 'processing', 'publishing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at = ?`,
    )
    .bind(options.nowMs + IN_FLIGHT_LEASE_MS, options.nowMs, epochId, options.expectedLeaseExpiresAt)
    .run();
  if (!d1Changed(result)) return null;
  return getReviewLoopEpochById(db, epochId);
}
