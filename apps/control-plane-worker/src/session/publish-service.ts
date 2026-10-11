import * as Sentry from "@sentry/cloudflare";

import { reviewVerificationExemptReason } from "../../../../shared/agent/constants.js";
import type { DeferredPrTemplateFillPayload } from "../../../../shared/events/bridge.js";
import type { PrTemplateFillLlmOutput } from "../../../../shared/llm/post-execution.js";
import type { PublishStage, PublishStatus } from "../../../../shared/types/publish.js";
import type { ExecutionVerification, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { renderPrEvidenceCommentFromReadiness } from "../../../sandbox-bridge/src/services/pr.js";
import { resolveInternalFeatureGateUser } from "../auth/db.js";
import { PR_READINESS_STORAGE_KEY, PUBLISHING_PROMPT_ID_STORAGE_KEY } from "../constants/sessions";
import { isSmokeTestRepo } from "../constants/smoke-test";
import { computeSha256Hex } from "../crypto";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createInstallationToken } from "../github/octokit";
import {
  createPrIssueComment,
  createPrReviewCommentReply,
  getPrMergeStatus,
  getPrReviewLoopWorklist,
  type PrMergeStatus,
  resolvePrReviewThread,
  type ReviewLoopWorklistItem,
  updateIssueComment,
} from "../github/pr";
import { buildPrDedupMarker } from "../github/pr-dedup-marker";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { emitPrCreatedMetric, emitReviewLoopArmedMetric } from "../observability/pr-metrics";
import { emitReviewLoopArrivalToFirstOperationEvent } from "../observability/review-loop-events";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { PrBodyStorageUnavailableError, storePrBodyBaseAndReconcile } from "../services/pr-body-reconciler";
import { isEligibleForAutomaticPrReview, spawnPrReviewTrigger } from "../services/pr-review-trigger-spawn.js";
import { generatePrTemplateFill } from "../services/pr-template-fill";
import { generatePublishPrTitle } from "../services/publish-pr-title";
import { shadowEmitReviewLoopEpochBlockedTerminal } from "../services/review-loop-epoch-blocked-terminal";
import {
  completeReviewLoopEpochFromVerifiedPush,
  getReviewLoopEpochById,
  isCiEpoch,
  isMentionEpoch,
  isMergeConflictEpoch,
  markReviewLoopEpochBlocked,
  markReviewLoopEpochCompleted,
  markReviewLoopEpochPublishing,
  markReviewLoopEpochWaitingForOwner,
  mentionReplyTargetSourceIds,
  type ReviewLoopEpoch,
  reviewSourceKind,
  shadowEmitReviewLoopEpochTerminal,
} from "../services/review-loop-epochs";
import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopPushOperationId,
  buildReviewLoopReplyOperationId,
  buildReviewLoopSummaryCommentOperationId,
  countSucceededReviewLoopOperations,
  fillSucceededReviewLoopReplyVerdict,
  getReviewLoopOperationById,
  markReviewLoopOperationFailed,
  markReviewLoopOperationSucceeded,
  type ReviewLoopReplyOperationKind,
  type ReviewLoopReplyVerdict,
  selectLatestSucceededReviewLoopPushHead,
} from "../services/review-loop-operations";
import {
  resolveReviewLoopChecklist,
  resolveReviewLoopCiEligibility,
  resolveReviewLoopHumanEligibility,
  resolveReviewLoopMergeConflictEligibility,
} from "../services/review-loop-settings";
import { isCheckRunFailureSourceId, parseReviewLoopSourceNumericId } from "../services/review-loop-source-id";
import { syncSessionProjection } from "../services/session-projection";
import type { UserSettingsCache } from "../settings/db";
import type { Env, ReplayState, SessionEvent } from "../types";
import { jsonErrorResponse, nowIso } from "../utils";
import { updateCompletionPrUrlForPrompt, updateCompletionPrUrlForSession } from "./completions-db";
import * as doDb from "./do-db.js";
import { durableStep } from "./durable-step";
import type { DurableEntry } from "./events";
import { applyEvent, type ApplyEventDeps } from "./fsm/apply-event";
import { liveFsmSinks } from "./fsm/live-side-effects";
import {
  armNoSignalAdvanceOnPrOpened,
  FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY,
} from "./fsm/no-signal-advance-producer";
import {
  buildPublishFailedEmission,
  buildPublishNoChangesEmission,
  buildPublishPrOpenedEmission,
  buildPublishSupersededEmission,
  type PublishEmission,
  publishShadowResolver,
} from "./fsm/publish-producer";
import { GithubReleaseEvidenceService } from "./github-release-evidence.js";
import { fallbackPrBody, resolvePrTitle } from "./pr-body.js";
import { buildFailedVerificationComment, PrBodyAssembler } from "./pr-body-assembler.js";
import {
  GithubPrOperations,
  type ResolvedPrRepoAuth,
  type ResolvedPrUpdateContext,
  type SessionPrWorkflowExt,
} from "./pr-github-ops.js";
import { upsertSessionPrMetadata } from "./pr-metadata-db";
import { type PrEventOptions, PrWorkflowNotifications, readPublishProvenanceTags } from "./pr-notifications.js";
import { resolveAttachedPrNumber } from "./pr-number";
import { applyTicketKeyPrefix } from "./pr-title.js";
import { type ApplyProposedPrTitleResult, PrTitleReconciler } from "./pr-title-reconciler.js";
import { promptResultBranch } from "./prompt-result.js";
import { computeRichStatus, getRichStatusProjectionInputs } from "./rich-status.js";
import { enterSessionReviewListening, notifySessionReviewLoopSummaryCommentPosted } from "./state";
import { resolveSessionTicketKey } from "./ticket-key.js";
import type { VerificationStateForPrInput } from "./verification-state.js";

/**
 * Activates (re-enters) `review_listening` mode for a session from outside the
 * Durable Object, calling the DO via the `enterSessionReviewListening` route
 * (`POST /session/review-listening/enter`). Used by reengageSessionForReview to
 * re-enter review-listening mode after sandbox rehydration.
 *
 * The enter route unconditionally dispatches `review_listening.entered` (which
 * sets `reviewListeningActive: true` via the lifecycle reducer) regardless of
 * whether the session was previously in review-listening mode. The only guard is
 * for archived sessions.
 */
export async function emitReviewListeningEntered(
  env: import("../types").Env,
  sessionId: string,
  options: { headSha: string; prUrl?: string },
): Promise<
  import("./internal-routes").SessionFetchResult<import("./internal-routes").EnterSessionReviewListeningResponse> | null
> {
  const prUrl = options.prUrl;
  if (!prUrl) return null;
  return enterSessionReviewListening(env, sessionId, {
    prUrl,
    currentHeadSha: options.headSha,
  });
}

/**
 * Emits a `review_loop.summary_comment.posted` session event from outside the
 * Durable Object, calling the DO via the `notifySessionReviewLoopSummaryCommentPosted`
 * route (`POST /session/review-loop/summary-comment-posted`).
 * Used by publishReviewLoopSummaryComment after a GitHub comment is successfully
 * created or updated.
 */
export async function emitReviewSummaryCommentPosted(
  env: import("../types").Env,
  sessionId: string,
  epochId: string,
  githubCommentId: number,
): Promise<void> {
  await notifySessionReviewLoopSummaryCommentPosted(env, sessionId, { epochId, githubCommentId });
}

export type ReviewLoopSummaryCommentResult =
  | { ok: true; githubCommentId: number }
  | {
      ok: false;
      reason:
        | "epoch_not_found"
        | "invalid_source_kind"
        | "invalid_status"
        | "session_mismatch"
        | "not_eligible"
        | "body_too_large"
        | "github_post_failed"
        | "github_patch_failed";
    };

const REVIEW_LOOP_SUMMARY_COMMENT_MAX_BODY_BYTES = 8192;
// A ci epoch should PUSH a fix, not summarize — its prompt never instructs review_summary_comment.
// Reject a summary comment from a ci epoch as defense in depth (the enqueue tags the prompt
// sourceKind "mixed", but the epoch row's sourceKind stays "ci"). Push stays allowed for ci epochs
// in validateReviewLoopPublishGuard.
// `mention` epochs enqueue their prompt as "human" (unlocking review_summary_comment); the epoch row
// keeps its real 'mention' sourceKind, so admit it here too or a mention turn's summary comment posts
// would be rejected as invalid_source_kind.
// `verification` (QA) epochs enqueue their prompt as "mixed" (dispatchReviewLoopEpoch's
// promptMetadataSourceKind) DELIBERATELY to unlock review_summary_comment so every QA cycle can post
// one summary comment — intended product behavior. The epoch row keeps its real 'verification'
// sourceKind (same pattern as ci/mention), so it must be admitted here too or that summary post would
// be rejected as invalid_source_kind.
const REVIEW_LOOP_SUMMARY_COMMENT_VALID_SOURCE_KINDS = new Set<string>(["human", "mixed", "mention", "verification"]);
const REVIEW_LOOP_SUMMARY_COMMENT_VALID_STATUSES = new Set<string>(["processing", "publishing", "completed"]);

/**
 * Posts (or idempotently updates) a single top-level PR summary comment for
 * a human-driven review wave.
 *
 * Idempotency: keyed on (epochId, epoch.headSha). A first call POSTs a new
 * issue comment; a retry or second call PATCHes the same comment.
 * Does NOT reject when arg headSha differs from epoch.headSha — the summary
 * describes the wave and is still valid after a head move.
 */
export async function publishReviewLoopSummaryComment(args: {
  env: import("../types").Env;
  db: D1Database;
  sessionId: string;
  epochId: string;
  /** Informational only — op-id and GitHub calls use epoch.headSha for stability. */
  headSha?: string;
  body: string;
  promptId?: string;
}): Promise<ReviewLoopSummaryCommentResult> {
  const { env, db, sessionId, epochId, body, promptId } = args;

  // 1. Body size guard.
  const bodyByteLength = new TextEncoder().encode(body).length;
  if (bodyByteLength > REVIEW_LOOP_SUMMARY_COMMENT_MAX_BODY_BYTES) {
    return { ok: false, reason: "body_too_large" };
  }

  // 2. Load + validate epoch.
  const epoch = await getReviewLoopEpochById(db, epochId);
  if (!epoch) return { ok: false, reason: "epoch_not_found" };
  if (epoch.sessionId !== sessionId) return { ok: false, reason: "session_mismatch" };
  if (!REVIEW_LOOP_SUMMARY_COMMENT_VALID_SOURCE_KINDS.has(epoch.sourceKind)) {
    return { ok: false, reason: "invalid_source_kind" };
  }
  if (!REVIEW_LOOP_SUMMARY_COMMENT_VALID_STATUSES.has(epoch.status)) {
    return { ok: false, reason: "invalid_status" };
  }

  // 3. Re-check eligibility (fail-closed). Mirror resolveReviewLoopEligibilityForEpoch: a mention
  // (`@cycloid …`) epoch bypasses the review checklist and gates on install capabilities only, so it
  // must publish its summary comment even in manual review mode (the human gate would reject it with
  // `review_handling_disabled`). Genuine reviewer epochs (human/mixed) stay on the human gate; passing
  // `sourceKind` lets a verification epoch's summary comment through in manual mode too (QA is on the
  // separate auto_verify axis). Both resolvers return { installationId } used below.
  const elig = isMentionEpoch(epoch)
    ? await resolveReviewLoopCiEligibility(env, {
        ownerUserId: epoch.ownerUserId,
        repoOwner: epoch.repoOwner,
        repoName: epoch.repoName,
      })
    : await resolveReviewLoopHumanEligibility(env, {
        ownerUserId: epoch.ownerUserId,
        repoOwner: epoch.repoOwner,
        repoName: epoch.repoName,
        sourceKind: epoch.sourceKind,
      });
  if (!elig.ok) return { ok: false, reason: "not_eligible" };

  // 4. Build operation id using epoch.headSha (not arg headSha) for stability.
  const operationId = await buildReviewLoopSummaryCommentOperationId({
    epochId: epoch.id,
    headSha: epoch.headSha,
  });

  // 5. Begin operation attempt.
  const attempt = await beginReviewLoopOperationAttempt(db, {
    operationId,
    epochId: epoch.id,
    sessionId,
    promptId: promptId ?? null,
    kind: "summary_comment",
    targetSourceId: null,
    headSha: epoch.headSha,
    maxAttempts: 3,
    nowMs: Date.now(),
  });

  // 5a. If already succeeded → PATCH with new body (idempotent update).
  if (attempt.status === "already_succeeded") {
    const existingGithubId = attempt.operation.githubId;
    const commentId = existingGithubId ? Number(existingGithubId) : null;
    if (!commentId) return { ok: false, reason: "github_patch_failed" };

    try {
      const token = await createInstallationToken(env, elig.installationId);
      await updateIssueComment(token, epoch.repoOwner, epoch.repoName, commentId, body);
      return { ok: true, githubCommentId: commentId };
    } catch {
      return { ok: false, reason: "github_patch_failed" };
    }
  }

  // 5b. attempts_exhausted or conflict — surface as post failed.
  if (attempt.status === "attempts_exhausted" || attempt.status === "conflict") {
    return { ok: false, reason: "github_post_failed" };
  }

  // 6. POST a new issue comment.
  try {
    const token = await createInstallationToken(env, elig.installationId);
    const created = await createPrIssueComment(token, epoch.repoOwner, epoch.repoName, epoch.prNumber, body);
    await markReviewLoopOperationSucceeded(db, attempt.operation.operationId, {
      githubId: String(created.id),
      nowMs: Date.now(),
      expectedAttempts: attempt.operation.attempts,
    });
    // 7. Emit session event (fire-and-forget; do not block on failure).
    emitReviewSummaryCommentPosted(env, sessionId, epochId, created.id).catch(() => {});
    return { ok: true, githubCommentId: created.id };
  } catch (error) {
    const message = stringifyError(error);
    await markReviewLoopOperationFailed(db, attempt.operation.operationId, {
      error: message,
      nowMs: Date.now(),
      expectedAttempts: attempt.operation.attempts,
    });
    return { ok: false, reason: "github_post_failed" };
  }
}

const FAILED_VERIFICATION_COMMENT_STORAGE_KEY = "pr_failed_verification_comment:latest_id";
const REVIEW_LOOP_MAX_CHANGED_FILES = 10;
const REVIEW_LOOP_MAX_CHANGED_LINES = 300;
const REVIEW_LOOP_OPERATION_MAX_ATTEMPTS = 3;
const REVIEW_LOOP_REPLY_ACTIVE_STATUSES = new Set(["processing", "waiting_for_owner", "publishing"]);

// A review-loop iteration (epoch) stays actionable both for the session that published the PR
// (ext.prUrl) and for a session that adopted the PR via review listening without publishing it —
// e.g. a verification session, whose ext.prUrl stays null while it works the loop on its target PR.
function sessionPrMatchesReviewLoopEpoch(
  ext: SessionPrWorkflowExt,
  epoch: { prUrl: string; prNumber: number },
): boolean {
  if (ext.prUrl === epoch.prUrl && ext.prNumber === epoch.prNumber) return true;
  return ext.reviewListeningActive === true && ext.reviewListeningPrUrl === epoch.prUrl;
}

// Repo-agnostic "sensitive change" heuristic for the owner-approval gate. The
// review loop applies this to EVERY customer repo's changed files, so it must
// NOT hard-code Cycloid's own monorepo layout — it flags the categories of
// change that are high-blast-radius in ANY repository: database migrations,
// CI/CD pipeline config, infrastructure-as-code, dependency lockfiles, and
// auth/secret-bearing config. A match routes the publish to `waiting_for_owner`
// (owner approval) rather than auto-publishing. Kept deliberately conservative:
// each pattern targets a directory/extension/filename convention that is
// near-universal, not a heuristic on file contents.
//
// Directory-segment patterns: match when the path contains the segment anywhere
// (e.g. `db/migrations/` or `services/api/migrations/`), so a nested repo layout
// is still caught.
const REVIEW_LOOP_SENSITIVE_DIR_SEGMENTS = [
  "migrations/", // database migrations (Rails, Prisma, Knex, Alembic, D1, ...)
  "migration/", // singular variant used by some frameworks
  ".github/workflows/", // GitHub Actions CI/CD pipelines
  ".gitlab/", // GitLab CI config dir
  ".circleci/", // CircleCI config dir
  ".buildkite/", // Buildkite keeps pipeline config in .buildkite/pipeline.yml
  "terraform/", // infrastructure-as-code (HashiCorp Terraform)
  "infra/", // common infrastructure directory convention
  "deploy/", // deployment manifests/scripts
  "k8s/", // Kubernetes manifests
  "kubernetes/",
  "helm/", // Helm charts
];

// Exact filenames (matched on the path's basename) that are sensitive in any repo.
const REVIEW_LOOP_SENSITIVE_FILENAMES = new Set([
  // Dependency lockfiles — a change here can swap transitive dependencies.
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "bun.lock", // Bun 1.2+ text lockfile
  "cargo.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  // CI/CD config files that live at known paths.
  ".gitlab-ci.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  "buildkite.yml",
  "buildkite.yaml",
  // Infra / deploy config.
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "wrangler.toml", // Cloudflare Workers config
  "fly.toml", // Fly.io
  "vercel.json",
  "netlify.toml",
  "procfile", // Heroku/Foreman
  "serverless.yml",
  "serverless.yaml",
  // Auth / secret-bearing config that should never change without review.
  ".env",
  ".npmrc",
  ".pypirc",
]);

// Filename suffixes (matched on the basename) for infra-as-code and CI/CD.
const REVIEW_LOOP_SENSITIVE_SUFFIXES = [
  ".tf", // Terraform
  ".tfvars",
  ".dockerfile",
];

// `.env.*` files (e.g. `.env.production`, `.env.local`) carry secrets/config.
function isDotEnvFile(basename: string): boolean {
  return basename === ".env" || basename.startsWith(".env.");
}

type PublishRequest = {
  sessionId: string;
  branch?: string;
  commitSha?: string;
  diffSummary?: string;
  prTitle?: string;
  prBody?: string;
  prTemplateFill?: DeferredPrTemplateFillPayload;
  prReadiness?: PrReadinessEvidence;
  verification?: ExecutionVerification;
  promptId?: string;
  requestedMode?: "normal" | "skip_publish";
};

type PublishResult =
  | { ok: true; status: "published"; prUrl: string; prNumber: number; branchName: string }
  | { ok: true; status: "superseded"; reason: string }
  | { ok: true; status: "skipped" }
  | { ok: true; status: "deferred"; reason: string; operationId?: string }
  | { ok: false; response: Response };

export function logPrTemplateFillEmptySections(
  log: Pick<Logger, "info">,
  fill: PrTemplateFillLlmOutput,
  context: {
    sessionId: string;
    promptId: string;
    repoOwner: string | null;
    repoName: string | null;
  },
): void {
  for (const section of fill.sections) {
    if (section.kind !== "empty") continue;
    log.info(
      {
        event: "pr_template_fill.section_empty",
        sessionId: context.sessionId,
        promptId: context.promptId,
        repoOwner: context.repoOwner,
        repoName: context.repoName,
        heading: section.heading.slice(0, 120),
        emptyReason: (section.emptyReason ?? "").slice(0, 240),
      },
      "PR template fill intentionally left a template section empty",
    );
  }
}

/** Surface that asked to resume a stuck publish, for telemetry/log attribution. */
export type ResumePublishTrigger = "bridge_reconnect" | "publishing_watchdog" | "alarm_wake";

export type ResumePublishOutcome =
  | { resumed: false; reason: "no_session" | "archived" | "not_publishing" | "no_branch" }
  | { resumed: true; status: Extract<PublishResult, { ok: true }>["status"] | "error" };

export type TerminalizePublishOnCloseOutcome =
  { terminalized: false; reason: "not_publishing" } | { terminalized: true; status: "published" | "failed" };

const inFlightPromptPublishes = new WeakMap<DurableObjectStorage, Map<string, Promise<PublishResult>>>();

type ReviewLoopPublishGuardResult =
  | { ok: true; epochId: string | null; epoch: ReviewLoopEpoch | null }
  | { ok: false; epochId: string | null; reason: string; ownerApprovalRequired?: boolean; benign?: boolean };

export type ReviewLoopPushResult =
  | { ok: true; status: "published" | "already_published"; operationId: string; commitSha: string }
  | {
      ok: false;
      reason: string;
      operationId?: string;
      ownerApprovalRequired?: boolean;
      retryable?: boolean;
      operationInProgress?: boolean;
    };

export type ReviewLoopReplyResult =
  | { ok: true; status: "replied" | "already_replied"; operationId: string; githubId: string | null }
  | { ok: false; reason: string; operationId?: string; retryable?: boolean };

type ReviewLoopOperationContext = {
  session: NonNullable<ReturnType<typeof doDb.getSession>>;
  ext: SessionPrWorkflowExt;
  epoch: ReviewLoopEpoch;
  auth: ResolvedPrRepoAuth;
  token: string;
  expectedBots: ReviewLoopEpoch["expectedBots"];
};

/**
 * Repo-agnostic check for whether a changed file is "sensitive" enough that an
 * auto review-loop push should instead require owner approval. Generalizes the
 * old Cycloid-specific path list to categories that are high-risk in ANY repo
 * (migrations, CI/CD, infra-as-code, lockfiles, auth/secret config). Matching is
 * case-insensitive and tolerates a leading slash and nested directory layouts.
 */
export function isReviewLoopSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, "").trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);

  // Directory-segment matches (segment can appear anywhere in the path).
  for (const segment of REVIEW_LOOP_SENSITIVE_DIR_SEGMENTS) {
    // Match either a leading segment (`migrations/...`) or a nested one
    // (`.../migrations/...`) so repo layout doesn't matter.
    if (lower.startsWith(segment) || lower.includes(`/${segment}`)) return true;
  }

  if (REVIEW_LOOP_SENSITIVE_FILENAMES.has(basename)) return true;
  if (isDotEnvFile(basename)) return true;
  for (const suffix of REVIEW_LOOP_SENSITIVE_SUFFIXES) {
    if (basename.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Maps a worklist sourceId to the GitHub reply primitive used to respond to it.
 * - `review-comment:<id>` → threaded reply on the review comment.
 * - `issue-comment:<id>`  → top-level PR (issue) comment.
 * - `review-body:<id>`    → a human's top-level review body; there is no GitHub API to reply
 *   inline to a review body, so it is answered with a top-level PR (issue) comment.
 * Returns `null` for source kinds with no supported reply primitive (e.g. `check-run-failure:`
 * CI items); callers should reject these with a kind-specific reason.
 */
function replyOperationKindForSourceId(sourceId: string): ReviewLoopReplyOperationKind | null {
  if (parseReviewLoopSourceNumericId(sourceId, "review-comment") !== null) return "review_comment_reply";
  if (parseReviewLoopSourceNumericId(sourceId, "issue-comment") !== null) return "issue_comment_reply";
  if (parseReviewLoopSourceNumericId(sourceId, "review-body") !== null) return "issue_comment_reply";
  return null;
}

async function shouldResolveReviewThreadAfterReply(input: {
  db: D1Database;
  epoch: ReviewLoopEpoch;
  worklistItems: ReviewLoopWorklistItem[];
  item: ReviewLoopWorklistItem;
  verdict: ReviewLoopReplyVerdict;
}): Promise<boolean> {
  if (!input.item.reviewThreadId) return false;
  if (input.verdict === "declined") return false;
  const threadItems = input.worklistItems.filter(
    (candidate) =>
      candidate.reviewThreadId === input.item.reviewThreadId &&
      replyOperationKindForSourceId(candidate.sourceId) === "review_comment_reply",
  );
  for (const threadItem of threadItems) {
    if (threadItem.sourceId === input.item.sourceId) continue;
    const operationId = await buildReviewLoopReplyOperationId({
      epochId: input.epoch.id,
      headSha: input.epoch.headSha,
      targetSourceId: threadItem.sourceId,
      opKind: "review_comment_reply",
    });
    const operation = await getReviewLoopOperationById(input.db, operationId);
    if (operation?.status !== "succeeded") return false;
    if (operation.verdict === "declined") return false;
  }
  return true;
}

function buildReviewLoopReplyBody(
  body: string,
  item: ReviewLoopWorklistItem,
  opKind: ReviewLoopReplyOperationKind,
): string {
  const trimmed = body.trim();
  if (opKind !== "issue_comment_reply") return trimmed;
  const source = item.sourceUrl.trim();
  if (!source) return trimmed;
  return `${trimmed}\n\nSource: ${source}`;
}

function reviewLoopSourceUrlForSourceId(prUrl: string, sourceId: string): string | null {
  const reviewCommentId = parseReviewLoopSourceNumericId(sourceId, "review-comment");
  if (reviewCommentId !== null) return `${prUrl}#discussion_r${reviewCommentId}`;

  const issueCommentId = parseReviewLoopSourceNumericId(sourceId, "issue-comment");
  if (issueCommentId !== null) return `${prUrl}#issuecomment-${issueCommentId}`;

  const reviewBodyId = parseReviewLoopSourceNumericId(sourceId, "review-body");
  if (reviewBodyId !== null) return `${prUrl}#pullrequestreview-${reviewBodyId}`;

  return null;
}

function resolveReviewLoopReplyItem(input: {
  worklist: Awaited<ReturnType<typeof getPrReviewLoopWorklist>>;
  targetSourceId: string;
  prUrl: string;
}): ReviewLoopWorklistItem | null {
  const item = input.worklist.items.find((candidate) => candidate.sourceId === input.targetSourceId);
  if (item) return item;

  const duplicateGroup = input.worklist.duplicateGroups.find((group) =>
    group.duplicateSourceIds.includes(input.targetSourceId),
  );
  if (!duplicateGroup) return null;

  const canonicalItem = input.worklist.items.find(
    (candidate) => candidate.sourceId === duplicateGroup.canonicalSourceId,
  );
  if (!canonicalItem) return null;

  return {
    ...canonicalItem,
    sourceId: input.targetSourceId,
    sourceUrl: reviewLoopSourceUrlForSourceId(input.prUrl, input.targetSourceId) ?? canonicalItem.sourceUrl,
    reviewThreadId: null,
  };
}

/**
 * Resolves a `mention` epoch's reply target directly from its own authorized target source ids, bypassing
 * the shared worklist. A mention's reply target is always one of the exact comment(s)/review(s) the user
 * @-mentioned in (the mention payload's targets — see {@link mentionReplyTargetSourceIds}, which excludes
 * a targeted mention's context-only parent). getPrReviewLoopWorklist has no producer
 * that surfaces a human top-level `issue-comment:<id>` — its issue-comment lane is bot-allowlist-only
 * (`fetchReviewLoopIssueCommentItems`) — so routing a mention reply through the shared worklist lookup
 * always rejects it as "not in the current worklist" (the exact ARC-1514 mention-reply bug). Synthesize a
 * minimal item (mirroring the duplicate-group synthesis in {@link resolveReviewLoopReplyItem}): the reply
 * POST needs only the `sourceId` (→ reply primitive via {@link replyOperationKindForSourceId}) and the
 * derived `sourceUrl` (→ the reply body's `Source:` line); a mention has no review thread to auto-resolve,
 * so `reviewThreadId` is null. Fails closed — returns null for a target that is not one of the epoch's
 * triggering sources (no arbitrary-comment replies) or whose kind has no reply primitive
 * (`reviewLoopSourceUrlForSourceId` returns null, e.g. `check-run-failure:`).
 */
export function resolveMentionReplyItem(input: {
  authorizedTargetSourceIds: string[];
  targetSourceId: string;
  prUrl: string;
}): ReviewLoopWorklistItem | null {
  if (!input.authorizedTargetSourceIds.includes(input.targetSourceId)) return null;
  const sourceUrl = reviewLoopSourceUrlForSourceId(input.prUrl, input.targetSourceId);
  if (sourceUrl === null) return null;
  return {
    sourceId: input.targetSourceId,
    sourceUrl,
    reviewThreadId: null,
    authorLogin: "unknown",
    authorType: "unknown",
    body: "",
    path: null,
    line: null,
    startLine: null,
    startSide: null,
    side: null,
    diffHunk: null,
    updatedAtMs: 0,
    isResolved: false,
    isOutdated: false,
  };
}

/**
 * Fallback reply-target resolution from the epoch's OWN prompted/triggering source ids when the live
 * worklist refetch no longer surfaces the target. The refetch drops items whose GitHub state moved on —
 * most commonly the agent's own fix push flipped the commented thread `isOutdated`, which excludes it
 * from the rebuilt worklist (`thread_outdated` unpromptable) — so the contractually-required verdict
 * reply for a JUST-ADDRESSED comment would be rejected as "not in the current worklist" and the item
 * silently disposed with no visible response (PR #7656: fix pushed 31s after the ChatGPT comment, reply
 * blocked, thread never answered). An id this epoch prompted (or was triggered by) is a legitimate reply
 * target for the epoch's whole lifetime; generalizes the ARC-1514 mention resolution to bot/human review
 * epochs. Same fail-closed contract as {@link resolveMentionReplyItem}: unknown ids and kinds with no
 * reply primitive return null. `reviewThreadId` is null, so the auto-resolve-thread step is skipped —
 * posting the reply is the point; thread resolution stays worklist-backed.
 *
 * Authorization is PROMPTED-first: the reply contract asks the agent to reply to prompted ids only,
 * and `triggering − prompted` is late-folded or budget-dropped work the agent never saw (it stays
 * re-drivable in a later epoch, and answering it early would double-handle it there). The triggering
 * set is consulted ONLY when the epoch has no prompted ids recorded (legacy rows predating
 * prompted_source_ids).
 */
export function resolveReviewLoopEpochOwnedReplyItem(input: {
  epoch: { promptedSourceIds?: string[]; triggeringSourceIds?: string[] };
  targetSourceId: string;
  prUrl: string;
}): ReviewLoopWorklistItem | null {
  const prompted = input.epoch.promptedSourceIds ?? [];
  const authorized =
    prompted.length > 0
      ? prompted.includes(input.targetSourceId)
      : (input.epoch.triggeringSourceIds ?? []).includes(input.targetSourceId);
  if (!authorized) return null;
  const sourceUrl = reviewLoopSourceUrlForSourceId(input.prUrl, input.targetSourceId);
  if (sourceUrl === null) return null;
  return {
    sourceId: input.targetSourceId,
    sourceUrl,
    reviewThreadId: null,
    authorLogin: "unknown",
    authorType: "unknown",
    body: "",
    path: null,
    line: null,
    startLine: null,
    startSide: null,
    side: null,
    diffHunk: null,
    updatedAtMs: 0,
    isResolved: false,
    isOutdated: false,
  };
}

async function computeReviewLoopReadinessDiffHash(readiness: PrReadinessEvidence): Promise<string> {
  return computeSha256Hex(
    JSON.stringify({
      changed_files: [...readiness.changedFiles]
        .map((file) => file.trim())
        .filter(Boolean)
        .sort(),
      diff_stats: readiness.diffStats,
    }),
  );
}

interface PublishServiceHost {
  readonly state: DurableObjectState;
  readonly env: Env;
  readonly log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  broadcast(message: Record<string, unknown>): void;
  appendAndMirrorEvents(
    sessionId: string,
    entries: DurableEntry[],
    promptId?: string,
  ): Promise<{ replay: ReplayState; events: SessionEvent[] }>;
  fetchInternal(request: Request): Promise<Response>;
  upsertPrWebhookRef(prUrl: string, sessionId: string): Promise<void>;
  enterReviewListening(input: { sessionId: string; prUrl: string; currentHeadSha: string }): Promise<void>;
  setVerificationStateForPr?(input: VerificationStateForPrInput): Promise<void>;
  exitReviewListening(input: {
    sessionId: string;
    reason: "merged" | "closed" | "archived" | "user_stop" | "draft_republish";
  }): Promise<void>;
  // ARC-876: publish-service writes `publishing_started_at` when entering the
  // publishing watchdog window; the DO must reschedule its alarm so the new
  // deadline is picked up immediately rather than at the next event tick.
  rescheduleSessionAlarm(): Promise<void>;
  withPublishUserSettingsCache?<T>(operation: (settingsCache: UserSettingsCache) => Promise<T>): Promise<T>;
  // Per-user "open PRs as drafts by default" toggle. Fail-toward-false so a
  // settings read failure publishes ready-for-review (matches the historical
  // hardcoded behavior) rather than silently flipping users into drafts.
  getDefaultPrDraft(ownerUserId: string, settingsCache?: UserSettingsCache): Promise<boolean>;
}

function prDraftOptions(
  verification: ExecutionVerification | null | undefined,
  userDefaultDraft: boolean,
): PrEventOptions {
  const manualReviewReason = verification?.manualReviewReason?.trim();
  return {
    // `publishMode: "draft"` remains the internal manual-review signal. The
    // GitHub `draft` flag now reflects the per-user setting; default off
    // preserves the previous ready-for-review behavior.
    draft: userDefaultDraft,
    ...(manualReviewReason ? { manualReviewReason } : {}),
  };
}

const PROD_PR_SMOKE_TITLE_PREFIX = "Prod PR smoke test";

export function isProdPrSmokeSessionForAutoClose(input: {
  title: string | null | undefined;
  repoOwner: string | null | undefined;
  repoName: string | null | undefined;
}): boolean {
  return (
    input.title?.startsWith(PROD_PR_SMOKE_TITLE_PREFIX) === true && isSmokeTestRepo(input.repoOwner, input.repoName)
  );
}

function reviewLoopSizeManualReviewReason(readiness: PrReadinessEvidence | null | undefined): string | null {
  if (!readiness) return null;

  const reasons: string[] = [];
  const changedFileCount = readiness.changedFiles.filter((file) => file.trim().length > 0).length;
  if (changedFileCount > REVIEW_LOOP_MAX_CHANGED_FILES) {
    reasons.push(`${changedFileCount} changed files exceeds the ${REVIEW_LOOP_MAX_CHANGED_FILES}-file threshold`);
  }

  const changedLineCount = Math.max(0, readiness.diffStats.insertions) + Math.max(0, readiness.diffStats.deletions);
  if (changedLineCount > REVIEW_LOOP_MAX_CHANGED_LINES) {
    reasons.push(`${changedLineCount} changed lines exceeds the ${REVIEW_LOOP_MAX_CHANGED_LINES}-line threshold`);
  }

  if (reasons.length === 0) return null;
  return `Review-loop changes need owner review: ${reasons.join("; ")}.`;
}

function withManualReviewSizeAlert(
  verification: ExecutionVerification | null | undefined,
  reason: string | null,
): ExecutionVerification | undefined {
  if (!reason) return verification ?? undefined;

  const existingReason = verification?.manualReviewReason?.trim();
  return {
    ...(verification ?? { verified: false }),
    verified: verification?.verified ?? false,
    publishMode: "draft",
    status: "manual_review_required",
    verdict: "INCONCLUSIVE",
    manualReviewReason: existingReason ? `${existingReason} ${reason}` : reason,
    explanation: verification?.explanation ?? reason,
  };
}

type FailedVerificationCommentRef = {
  prNumber: number;
  commentId: number;
};

function isFailedVerificationCommentRef(value: unknown): value is FailedVerificationCommentRef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FailedVerificationCommentRef>;
  return typeof candidate.prNumber === "number" && typeof candidate.commentId === "number";
}

/**
 * Reproject `session_index.rich_status` atomically with a publish_status write.
 * Reads post-transition DO state from `sql` (caller must invoke after
 * `updateSessionFields`) and returns the canonical rich_status string.
 *
 * Exported so the publish-service projection test can exercise it directly
 * without standing up a full DO harness.
 *
 * `userStopped` is intentionally omitted (DO-memory/KV only, not in SQL): this
 * projection never passes `planApprovalPending`, and a pending question needs an
 * active prompt, which a publish transition does not have — so the user-stop
 * precedence over waiting_for_input cannot apply here.
 */
export function computeRichStatusForPublishProjection(sql: SqlStorage, sessionId: string): string | null {
  const session = doDb.getSession(sql, sessionId);
  if (!session) return null;
  const ext = doDb.getSessionExtended(sql, sessionId);
  const sandbox = doDb.getSandboxState(sql, sessionId);
  const activePromptId = doDb.getActiveProcessingPromptId(sql, sessionId);
  const projection = getRichStatusProjectionInputs(sql, sessionId, activePromptId);
  return computeRichStatus(session, {
    sandboxStatus: sandbox?.status ?? undefined,
    activePromptId,
    stopReason: sandbox?.stopReason ?? null,
    activePromptHasPendingQuestion: projection.activePromptHasPendingQuestion,
    publishStatus: ext?.publishStatus ?? "not_started",
    postExecutionPending: projection.postExecutionPending,
    mostRecentPromptResultNoChanges: projection.mostRecentPromptResultNoChanges,
    reviewListeningActive: ext?.reviewListeningActive ?? false,
  });
}

/**
 * ARC-876: shared publish gate. Reads the most recent prompt's push outcome
 * (populated from the `post_execution` event payload) and rejects the publish
 * attempt if the branch was not pushed, so publish never forks on the old
 * `lastPushSucceeded` session flag.
 */
export function isPromptPublishable(sql: SqlStorage, sessionId: string): { ok: true } | { ok: false; reason: string } {
  // Prefer the prompt that produced the currently publishable branch. A later
  // no-op follow-up can have its own `push_status=unknown`; that must not mask
  // the earlier prompt whose branch was actually pushed.
  const ext = doDb.getSessionExtended(sql, sessionId);
  const branch = ext?.lastBranch?.trim() || null;
  const prompts = doDb.getPromptsWithPushOutcomes(sql, sessionId);
  let latestOutcome: doDb.PromptPushOutcome | null = null;

  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    const outcome = prompts[i].pushOutcome;
    if (!outcome) continue;
    latestOutcome ??= outcome;
    if (branch && promptResultBranch(prompts[i].result) !== branch) continue;
    return publishableFromPushOutcome(outcome);
  }

  if (latestOutcome) return publishableFromPushOutcome(latestOutcome);
  // No prompt has a recorded push outcome — let the publish flow run; the
  // verifyRemoteBranch step will fail closed if the branch is missing.
  return { ok: true };
}

function publishableFromPushOutcome(outcome: doDb.PromptPushOutcome): { ok: true } | { ok: false; reason: string } {
  if (outcome.pushStatus === "succeeded") return { ok: true };
  if (outcome.pushStatus === "failed") {
    return {
      ok: false,
      reason: outcome.pushError
        ? `Branch was not pushed to GitHub: ${outcome.pushError}`
        : "Branch was not pushed to GitHub; PR cannot be created from this session",
    };
  }
  return {
    ok: false,
    reason: "Push outcome is unknown; PR cannot be created from this session",
  };
}

export class SessionPublishService {
  private readonly github: GithubPrOperations;
  private readonly githubEvidence: GithubReleaseEvidenceService;
  private readonly notifications: PrWorkflowNotifications;
  private readonly bodyAssembler: PrBodyAssembler;
  private readonly titleReconciler: PrTitleReconciler;

  constructor(
    private readonly host: PublishServiceHost,
    units: {
      bodyAssembler?: PrBodyAssembler;
      notifications?: PrWorkflowNotifications;
      github?: GithubPrOperations;
    } = {},
  ) {
    this.github = units.github ?? new GithubPrOperations(this.sql, host.env, host.log);
    this.githubEvidence = new GithubReleaseEvidenceService(this.sql, host);
    this.notifications = units.notifications ?? new PrWorkflowNotifications(this.sql, host);
    this.bodyAssembler = units.bodyAssembler ?? new PrBodyAssembler(this.sql, host);
    this.titleReconciler = new PrTitleReconciler(this.sql, host.log, this.github);
  }

  applyProposedPrTitle(sessionId: string, rawTitle: unknown): Promise<ApplyProposedPrTitleResult> {
    return this.titleReconciler.applyProposedPrTitle(sessionId, rawTitle);
  }

  async publishSessionResult(
    request: PublishRequest,
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<PublishResult> {
    return this.withPublishUserSettingsCache(settingsCache, (activeSettingsCache) =>
      this.publishSessionResultScoped(request, activeSettingsCache),
    );
  }

  private withPublishUserSettingsCache<T>(
    settingsCache: UserSettingsCache | undefined,
    operation: (settingsCache?: UserSettingsCache) => Promise<T>,
  ): Promise<T> {
    if (settingsCache) return operation(settingsCache);
    return this.host.withPublishUserSettingsCache
      ? this.host.withPublishUserSettingsCache((hostSettingsCache) => operation(hostSettingsCache))
      : operation();
  }

  private getDefaultPrDraft(ownerUserId: string, settingsCache: UserSettingsCache | undefined): Promise<boolean> {
    return settingsCache
      ? this.host.getDefaultPrDraft(ownerUserId, settingsCache)
      : this.host.getDefaultPrDraft(ownerUserId);
  }

  private async publishSessionResultScoped(
    request: PublishRequest,
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<PublishResult> {
    if (!request.promptId) return this.publishSessionResultInner(request, settingsCache);

    let perStorage = inFlightPromptPublishes.get(this.host.state.storage);
    if (!perStorage) {
      perStorage = new Map();
      inFlightPromptPublishes.set(this.host.state.storage, perStorage);
    }

    const key = `${request.sessionId}:${request.promptId}`;
    const inFlight = perStorage.get(key);
    if (inFlight) return inFlight;

    const run = this.publishSessionResultInner(request, settingsCache);
    perStorage.set(key, run);
    try {
      return await run;
    } finally {
      if (perStorage.get(key) === run) perStorage.delete(key);
      if (perStorage.size === 0) inFlightPromptPublishes.delete(this.host.state.storage);
    }
  }

  private async publishSessionResultInner(
    request: PublishRequest,
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<PublishResult> {
    const session = doDb.getSession(this.sql, request.sessionId);
    const ext = doDb.getSessionExtended(this.sql, request.sessionId);
    if (!session || !ext) {
      return { ok: false, response: jsonErrorResponse("Session not found", 404) };
    }
    const adoptedExternalPr = ext.adoptedExternalPr === true;
    const scheduledProvenance =
      ext.entrypoint === SessionEntrypoint.SCHEDULED ||
      (ext.entrypoint === null && ext.initiationMode === InitiationMode.AUTOMATION && ext.scheduledRuleId !== null);

    const branch = request.branch ?? ext.lastBranch ?? undefined;
    if (!branch) {
      return { ok: false, response: jsonErrorResponse("No branch available for PR creation", 400) };
    }
    if (ext.baseBranch && branch === ext.baseBranch) {
      doDb.updateSessionFields(this.sql, request.sessionId, { prCreating: false });
      // ARC-1330 (PR 37) shadow: a head==base publish is the net-zero N10 "no change produced" terminal.
      await this.shadowEmitFsmPublishEvent(request.sessionId, buildPublishNoChangesEmission());
      return {
        ok: false,
        response: jsonErrorResponse("Head branch matches base branch — no changes to create a PR from", 400),
      };
    }
    if (request.requestedMode === "skip_publish") {
      await this.setPublishState(request.sessionId, {
        publishStatus: "skipped",
        publishStage: "done",
        publishError: null,
      });
      await this.notifications.emitPublishCompleted(request.sessionId, "skipped", request.promptId);
      return { ok: true, status: "skipped" };
    }

    const prompts = doDb.getPrompts(this.sql, request.sessionId);
    const prompt = request.promptId ? prompts.find((candidate) => candidate.promptId === request.promptId) : null;
    const verification = withManualReviewSizeAlert(
      request.verification,
      prompt?.reviewLoopEpochId ? reviewLoopSizeManualReviewReason(request.prReadiness) : null,
    );
    const userDefaultDraft = await this.getDefaultPrDraft(session.ownerUserId, settingsCache);
    const options = prDraftOptions(verification, userDefaultDraft);
    const ticketKey = resolveSessionTicketKey({
      llmTicketKey: ext.ticketKey ?? null,
      linearIdentifier: ext.linearContext?.identifier ?? null,
      prompts,
    });
    const title = resolvePrTitle(request.prTitle, ext.title, prompts, ticketKey);
    // ARC-876 resume: durably anchor the prompt that owns this publish BEFORE we
    // enter `publishing`, so a publish interrupted by a DO restart can be resumed
    // (`resumeStuckPublish`) re-keyed on the SAME (sessionId, promptId) — matching
    // the dedup marker, the `create_pr_*` durable step, and the per-prompt
    // single-flight — instead of falling back to the `no_prompt` key and risking a
    // duplicate PR. Cleared on every terminal transition (setPublishState /
    // recordPublishedPr).
    if (request.promptId) {
      await this.host.state.storage.put(PUBLISHING_PROMPT_ID_STORAGE_KEY, request.promptId);
    }

    let body: string;
    try {
      body = await this.bodyAssembler.composePrBody(
        ext,
        request.prBody || fallbackPrBody(request.diffSummary),
        verification,
        request.prReadiness,
        request.sessionId,
        request.promptId,
      );

      await this.setPublishState(request.sessionId, {
        publishStatus: "publishing",
        publishStage: "verifying",
        publishError: null,
      });
      await this.notifications.emitPublishStarted(request.sessionId, branch, request.promptId);
    } catch (error) {
      // ARC-960: any throw inside this try drives a durable terminal failure via
      // failPublish, whether or not setPublishState("publishing") already ran.
      // The primary target is the pre-"publishing" region (composePrBody), where
      // a throw would otherwise leave the session stuck at its pre-publish status
      // (e.g. not_started) with no watchdog armed — the operator-hostile middle
      // state where a pushed branch never resolves to a terminal outcome. It also
      // deliberately covers the half-started case where setPublishState succeeded
      // and only emitPublishStarted threw: fail fast to "failed" rather than rely
      // on the publishing watchdog for that slim window. Throws after this block
      // are handled by the existing inner failPublish handlers / publishing
      // watchdog.
      //
      // failPublish logs and emits a durable publish.failed event but does not
      // capture to Sentry, and this path now resolves (no longer rejects) so the
      // prompt-queue handoff catch can't report it — capture the throw here to
      // preserve the Sentry signal that path previously provided.
      Sentry.captureException(error, {
        tags: { sessionId: request.sessionId, operation: "publishSessionResult", cause: "pre_publish_throw" },
      });
      return this.failPublish(request.sessionId, "verifying", error, request.promptId, {
        cause: "pre_publish_throw",
      });
    }

    let auth: ResolvedPrRepoAuth | null;
    try {
      auth = await this.github.resolveRepoAuthForPublish(request.sessionId);
    } catch (error) {
      return this.failPublish(request.sessionId, "verifying", error, request.promptId);
    }
    if (!auth) {
      return this.failPublish(
        request.sessionId,
        "verifying",
        new Error("GitHub auth is unavailable for publish"),
        request.promptId,
      );
    }

    const reviewLoopGuard = await this.validateReviewLoopPublishGuard(request, session, ext, auth);
    if (!reviewLoopGuard.ok) {
      return this.blockReviewLoopPublish(request.sessionId, branch, reviewLoopGuard, request.promptId);
    }

    let remoteHeadSha: string;
    if (reviewLoopGuard.epochId && request.promptId) {
      const push = await this.publishReviewLoopPush({
        sessionId: request.sessionId,
        promptId: request.promptId,
        branch,
        commitSha: request.commitSha,
        prReadiness: request.prReadiness,
        auth,
        guard: reviewLoopGuard,
      });
      if (!push.ok) {
        if (push.operationInProgress) {
          this.host.log.info(
            {
              event: "review_loop_publish_deferred",
              sessionId: request.sessionId,
              promptId: request.promptId,
              operationId: push.operationId,
              reason: push.reason,
            },
            "Review-loop publish deferred because operation is already running",
          );
          return {
            ok: true,
            status: "deferred",
            reason: push.reason,
            ...(push.operationId ? { operationId: push.operationId } : {}),
          };
        }
        if (push.ownerApprovalRequired || push.retryable !== true) {
          return this.blockReviewLoopPublish(
            request.sessionId,
            branch,
            {
              ok: false,
              epochId: reviewLoopGuard.epochId,
              reason: push.reason,
              ...(push.ownerApprovalRequired ? { ownerApprovalRequired: true } : {}),
            },
            request.promptId,
          );
        }
        return this.failPublish(request.sessionId, "pushing", new Error(push.reason), request.promptId);
      }
      remoteHeadSha = push.commitSha;
    } else {
      try {
        remoteHeadSha = await this.verifyRemoteBranch(
          auth,
          branch,
          request.commitSha,
          request.sessionId,
          request.promptId,
        );
      } catch (error) {
        return this.failPublish(request.sessionId, "pushing", error, request.promptId);
      }
    }

    const attempt = (ext.publishAttempt ?? 0) + 1;
    await this.setPublishState(request.sessionId, {
      publishStatus: "publishing",
      publishStage: ext.prUrl ? "updating_pr" : "creating_pr",
      publishError: null,
      publishedBranch: branch,
      publishAttempt: attempt,
    });

    const existingAttachedPrUrl = ext.prUrl ?? null;
    const existingAttachedPrNumber = resolveAttachedPrNumber(ext.prNumber, existingAttachedPrUrl);
    let currentPr =
      existingAttachedPrUrl && existingAttachedPrNumber
        ? { prUrl: existingAttachedPrUrl, prNumber: existingAttachedPrNumber }
        : null;
    if (!currentPr) {
      try {
        // ARC-1014: pass the deterministic dedup marker so a crash that created
        // the PR on GitHub but never recorded the D1 row is recovered by the
        // strongly-consistent `/pulls?head=` list, with no chance of a duplicate
        // PR from GitHub search-index lag.
        const dedupMarker = buildPrDedupMarker(request.sessionId, request.promptId);
        const existingOpenPr = await this.github.findOpenPr(auth, branch, dedupMarker);
        if (existingOpenPr) {
          currentPr = { prUrl: existingOpenPr.prUrl, prNumber: existingOpenPr.prNumber };
          if (existingOpenPr.matchedMarker) {
            this.host.log.info(
              {
                event: "pr_create_recovery_via_marker",
                sessionId: request.sessionId,
                promptId: request.promptId,
                prNumber: existingOpenPr.prNumber,
                prUrl: existingOpenPr.prUrl,
                branch,
              },
              "pr_create_recovery_via_marker",
            );
          } else {
            // Legacy branch-head fallback: an open PR exists on our (session-owned)
            // head branch but carries no dedup marker — e.g. a PR created before
            // ARC-1014, or one a prior attempt opened without the marker. Adopting
            // it is correct (GitHub rejects a second PR for the same head anyway),
            // but log it distinctly so the fallback is explicit and we can tell it
            // apart from a confirmed marker recovery.
            this.host.log.info(
              {
                event: "pr_create_adopted_head_pr_without_marker",
                sessionId: request.sessionId,
                promptId: request.promptId,
                prNumber: existingOpenPr.prNumber,
                prUrl: existingOpenPr.prUrl,
                branch,
              },
              "pr_create_adopted_head_pr_without_marker",
            );
          }
        }
      } catch (error) {
        return this.failPublish(request.sessionId, "creating_pr", error, request.promptId);
      }
    }

    try {
      if (currentPr) {
        doDb.updateSessionFields(this.sql, request.sessionId, {
          prUrl: currentPr.prUrl,
          prNumber: currentPr.prNumber,
        });
        const context = await this.github.resolvePrUpdateContext(request.sessionId);
        if (!context) {
          throw new Error("PR is not available for update");
        }
        let actualDraft: boolean;
        if (adoptedExternalPr) {
          const draftState = await this.github.getPrDraftState(context);
          if (!draftState) throw new Error("PR draft state is not available for adopted external PR publish");
          actualDraft = draftState.isDraft;
        } else {
          actualDraft = await this.ensurePrReadyForPublish(context, "Marked PR ready for review on republish");
        }
        const reconciledOptions = { ...options, draft: actualDraft };
        doDb.updateSessionFields(this.sql, request.sessionId, {
          prDraft: actualDraft,
          prManualReviewReason: options.manualReviewReason?.trim() || null,
        });
        if (!adoptedExternalPr) {
          try {
            await storePrBodyBaseAndReconcile(this.host.env, {
              identity: {
                repoOwner: context.repoOwner,
                repoName: context.repoName,
                installationId: context.installationId ?? 0,
                prNumber: context.prNumber,
                prUrl: context.prUrl,
              },
              baseBody: body,
              tokenHint: context.token,
              logger: this.host.log,
              rememberBody: (nextBody) => this.bodyAssembler.rememberPrBody(request.sessionId, nextBody),
              patchWithoutStorage: true,
            });
          } catch (error) {
            if (!(error instanceof PrBodyStorageUnavailableError)) throw error;
            await this.github.updatePrBody(context, body);
            await this.bodyAssembler.rememberPrBody(request.sessionId, body);
          }
          await this.titleReconciler.applyResolvedTitle(
            request.sessionId,
            context,
            currentPr.prNumber,
            title,
            ext.prTitleLastApplied ?? null,
            { created: false },
          );
        }
        await this.syncFailedVerificationComment(request.sessionId, context, verification, request.prReadiness);
        if (!adoptedExternalPr) {
          await this.github.applyProvenanceLabel(request.sessionId, auth, currentPr.prNumber, {
            scheduled: scheduledProvenance,
            scheduledRuleId: ext.scheduledRuleId ?? null,
          });
        }
        await this.recordPublishedPr(
          request.sessionId,
          currentPr.prUrl,
          currentPr.prNumber,
          branch,
          reconciledOptions,
          request.promptId,
        );
        await this.runPublishSideEffects({
          sessionId: request.sessionId,
          promptId: request.promptId,
          session,
          ext,
          auth,
          prUrl: currentPr.prUrl,
          prNumber: currentPr.prNumber,
          branch,
          body,
          remoteHeadSha,
          reconciledOptions,
          created: false,
          countCreateMetric: false,
          actualDraft,
          repoOwner: ext.repoOwner ?? "",
          repoName: ext.repoName ?? "",
        });
        if (!adoptedExternalPr) {
          this.scheduleDeferredDiffAwareTitle(request, session, ext, context, currentPr.prNumber, title, ticketKey);
          this.scheduleDeferredPrTemplateFill(request, session, ext, context, currentPr.prNumber);
        }
        await this.autoCloseProdSmokePrIfNeeded({
          sessionId: request.sessionId,
          promptId: request.promptId,
          session,
          ext,
          auth,
          prUrl: currentPr.prUrl,
          prNumber: currentPr.prNumber,
        });
        // ARC-1330 (PR 37) shadow: a published (adopted/updated) PR is the PUBLISHING→REVIEW terminal.
        // PR 48: + arm the reviewer first-contact latch (idempotent on a re-publish — armed once per PR).
        await this.shadowEmitFsmPublishEvent(
          request.sessionId,
          buildPublishPrOpenedEmission(remoteHeadSha, request.prReadiness?.diffStats),
          currentPr.prUrl,
          {
            ownerUserId: Number(session.ownerUserId),
            repoOwner: ext.repoOwner ?? "",
            repoName: ext.repoName ?? "",
          },
        );
        return {
          ok: true,
          status: "published",
          prUrl: currentPr.prUrl,
          prNumber: currentPr.prNumber,
          branchName: branch,
        };
      }

      const stepSuffix = `${request.sessionId}_${request.promptId ?? "no_prompt"}`;
      const createPrStep = `create_pr_${stepSuffix}`;
      const created = await durableStep(
        this.host.state.storage,
        createPrStep,
        () => this.github.createPr(request.sessionId, branch, title, body, { draft: options.draft === true }),
        this.host.log,
      );
      const createdContext = {
        sessionId: request.sessionId,
        token: auth.token,
        tokenSource: auth.tokenSource,
        installationId: auth.installationId,
        installationToken: auth.installationToken,
        repoOwner: created.repoOwner,
        repoName: created.repoName,
        prNumber: created.prNumber,
        prUrl: created.prUrl,
        ext,
      };
      // Persist the PR identity before any enrichment or lifecycle side effect.
      // If a later GitHub/D1 integration step fails, the already-created PR is
      // still attached to the session and can be reconciled on retry.
      await this.recordPublishedPr(
        request.sessionId,
        created.prUrl,
        created.prNumber,
        branch,
        { ...options, draft: created.actualDraft ?? options.draft === true },
        request.promptId,
      );
      try {
        // Newly-created PRs reflect the user's `default_pr_draft` preference
        // (forwarded to GitHub at create time). Existing branch PRs normally get
        // marked ready; ARC-1515 external adoptions preserve the live draft state.
        let actualDraft = created.actualDraft ?? options.draft === true;
        const preserveAdoptedExternalPr = adoptedExternalPr && created.created === false;
        if (created.created === false) {
          if (preserveAdoptedExternalPr) {
            const draftState = await this.github.getPrDraftState(createdContext);
            if (!draftState) throw new Error("PR draft state is not available for adopted external PR publish");
            actualDraft = draftState.isDraft;
          } else {
            actualDraft = await this.ensurePrReadyForPublish(
              createdContext,
              "Marked adopted PR ready for review on publish",
            );
          }
        }
        if (!preserveAdoptedExternalPr) {
          try {
            await storePrBodyBaseAndReconcile(this.host.env, {
              identity: {
                repoOwner: createdContext.repoOwner,
                repoName: createdContext.repoName,
                installationId: createdContext.installationId ?? 0,
                prNumber: createdContext.prNumber,
                prUrl: createdContext.prUrl,
              },
              baseBody: body,
              tokenHint: createdContext.token,
              logger: this.host.log,
              rememberBody: (nextBody) => this.bodyAssembler.rememberPrBody(request.sessionId, nextBody),
              patchWithoutStorage: created.created === false,
            });
          } catch (error) {
            if (!(error instanceof PrBodyStorageUnavailableError)) throw error;
            await this.github.updatePrBody(createdContext, body);
            await this.bodyAssembler.rememberPrBody(request.sessionId, body);
          }
        }
        const reconciledOptions = { ...options, draft: actualDraft };
        // Persist the reconciled draft state before any remaining enrichment or
        // side effect can fail, so retries have durable identity and truthfully
        // reflect a PR that was marked ready for review.
        await this.recordPublishedPr(
          request.sessionId,
          created.prUrl,
          created.prNumber,
          branch,
          reconciledOptions,
          request.promptId,
        );
        if (!preserveAdoptedExternalPr) {
          await this.titleReconciler.applyResolvedTitle(
            request.sessionId,
            createdContext,
            created.prNumber,
            title,
            ext.prTitleLastApplied ?? null,
            { created: created.created !== false },
          );
        }
        await this.syncFailedVerificationComment(request.sessionId, createdContext, verification, request.prReadiness);
        if (!preserveAdoptedExternalPr) {
          await this.github.applyProvenanceLabel(request.sessionId, auth, created.prNumber, {
            scheduled: scheduledProvenance,
            scheduledRuleId: ext.scheduledRuleId ?? null,
          });
        }
        // Per-operation durable steps replace the legacy coarse `pr_create_events`
        // gate + `pr_create_event_emitted` boolean: each non-idempotent effect is
        // now keyed independently inside runPublishSideEffects, so a `durableStep`
        // cache hit on the underlying `github.createPr` call (or a replay) does not
        // re-fire any of them. The create path always emits `publish.pr.created`
        // (even when adopting an existing branch PR); only the PR-created metric is
        // gated on a genuine creation (created.created !== false) so adopted PRs do
        // not inflate the drafts-vs-ready total.
        await this.runPublishSideEffects({
          sessionId: request.sessionId,
          promptId: request.promptId,
          session,
          ext,
          auth,
          prUrl: created.prUrl,
          prNumber: created.prNumber,
          branch,
          body,
          remoteHeadSha,
          reconciledOptions,
          created: true,
          countCreateMetric: created.created !== false,
          actualDraft,
          repoOwner: created.repoOwner,
          repoName: created.repoName,
        });
        if (!preserveAdoptedExternalPr) {
          this.scheduleDeferredDiffAwareTitle(
            request,
            session,
            ext,
            createdContext,
            created.prNumber,
            title,
            ticketKey,
          );
          this.scheduleDeferredPrTemplateFill(request, session, ext, createdContext, created.prNumber);
        }
        await this.autoCloseProdSmokePrIfNeeded({
          sessionId: request.sessionId,
          promptId: request.promptId,
          session,
          ext,
          auth,
          prUrl: created.prUrl,
          prNumber: created.prNumber,
        });
        // ARC-1330 (PR 37) shadow: a freshly-created/opened PR is the PUBLISHING→REVIEW terminal.
        // PR 48: + arm the reviewer first-contact latch (armed once per PR at the init_record entry).
        await this.shadowEmitFsmPublishEvent(
          request.sessionId,
          buildPublishPrOpenedEmission(remoteHeadSha, request.prReadiness?.diffStats),
          created.prUrl,
          {
            ownerUserId: Number(session.ownerUserId),
            repoOwner: created.repoOwner,
            repoName: created.repoName,
          },
        );
        return { ok: true, status: "published", prUrl: created.prUrl, prNumber: created.prNumber, branchName: branch };
      } catch (error) {
        this.host.log.warn(
          { sessionId: request.sessionId, promptId: request.promptId, prUrl: created.prUrl, error: String(error) },
          "PR created; post-create publish enrichment failed and will be reconciled",
        );
        return { ok: true, status: "published", prUrl: created.prUrl, prNumber: created.prNumber, branchName: branch };
      }
    } catch (error) {
      const stage: PublishStage = currentPr ? "updating_pr" : "creating_pr";
      return this.failPublish(request.sessionId, stage, error, request.promptId);
    }
  }

  private async generateDiffAwareTitle(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    currentTitle: string,
    ticketKey: string | null,
  ): Promise<string | null> {
    if (request.prTitle?.trim()) return null;
    if (ext.prNumber && ext.prTitleLastApplied && currentTitle.trim() === ext.prTitleLastApplied.trim()) return null;

    try {
      const generated = await durableStep(
        this.host.state.storage,
        this.publishStep("pr_title", request.sessionId, request.promptId),
        () =>
          generatePublishPrTitle(
            this.host.env,
            {
              currentTitle,
              diffSummary: request.diffSummary ?? null,
              commitSha: request.commitSha ?? null,
              changedFiles: request.prReadiness?.changedFiles ?? null,
              diffStats: request.prReadiness?.diffStats ?? null,
            },
            {
              sessionId: request.sessionId,
              promptId: request.promptId,
              businessId: session.businessId ?? null,
              ownerUserId: session.ownerUserId ?? null,
              repoOwner: ext.repoOwner ?? null,
              repoName: ext.repoName ?? null,
              waitUntil: (promise) => this.host.waitUntil(promise),
            },
          ),
        this.host.log,
      );
      if (!generated) return null;
      return applyTicketKeyPrefix(generated, ticketKey);
    } catch (error) {
      this.host.log.warn(
        { event: "publish_pr_title_generation_failed", sessionId: request.sessionId, error: String(error) },
        "Publish-time PR title generation failed; using existing resolved title",
      );
      return null;
    }
  }

  private scheduleDeferredDiffAwareTitle(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    context: ResolvedPrUpdateContext,
    prNumber: number,
    deterministicTitle: string,
    ticketKey: string | null,
  ): void {
    this.host.waitUntil(
      this.applyDeferredDiffAwareTitle(request, session, ext, context, prNumber, deterministicTitle, ticketKey),
    );
  }

  private async applyDeferredDiffAwareTitle(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    context: ResolvedPrUpdateContext,
    prNumber: number,
    deterministicTitle: string,
    ticketKey: string | null,
  ): Promise<void> {
    const generatedTitle = await this.generateDiffAwareTitle(request, session, ext, deterministicTitle, ticketKey);
    if (!generatedTitle) return;
    await this.titleReconciler.applyDeferredGeneratedTitle(
      request.sessionId,
      context,
      prNumber,
      deterministicTitle,
      generatedTitle,
    );
  }

  private scheduleDeferredPrTemplateFill(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    context: ResolvedPrUpdateContext,
    prNumber: number,
  ): void {
    if (!request.prTemplateFill || !request.prReadiness) return;
    this.host.waitUntil(this.applyDeferredPrTemplateFill(request, session, ext, context, prNumber));
  }

  private async applyDeferredPrTemplateFill(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    context: ResolvedPrUpdateContext,
    prNumber: number,
  ): Promise<void> {
    if (!request.prTemplateFill || !request.prReadiness) return;
    const fill = await durableStep(
      this.host.state.storage,
      this.publishStep("pr_template_fill", request.sessionId, request.promptId),
      () =>
        generatePrTemplateFill(
          this.host.env,
          request.prTemplateFill!.input,
          {
            sessionId: request.sessionId,
            promptId: request.promptId,
            businessId: session.businessId ?? null,
            ownerUserId: session.ownerUserId ?? null,
            repoOwner: ext.repoOwner ?? null,
            repoName: ext.repoName ?? null,
            waitUntil: (promise) => this.host.waitUntil(promise),
          },
          this.host.log,
        ),
      this.host.log,
    );
    if (!fill) return;
    logPrTemplateFillEmptySections(this.host.log, fill, {
      sessionId: request.sessionId,
      promptId: request.promptId ?? "unknown",
      repoOwner: ext.repoOwner ?? null,
      repoName: ext.repoName ?? null,
    });

    const enrichedBody = renderPrEvidenceCommentFromReadiness({
      evidence: request.prReadiness,
      generatedBody: request.prTemplateFill.generatedBody,
      verification: request.verification,
      prTemplate: { status: "found", candidate: request.prTemplateFill.template },
      prTemplateFill: fill,
    });
    if (request.prBody && enrichedBody === request.prBody) return;

    const patchDirectly = async () => {
      await this.github.updatePrBody(context, enrichedBody);
      await this.bodyAssembler.rememberPrBody(request.sessionId, enrichedBody);
    };

    try {
      const reconciled = await storePrBodyBaseAndReconcile(this.host.env, {
        identity: {
          repoOwner: context.repoOwner,
          repoName: context.repoName,
          installationId: context.installationId ?? 0,
          prNumber,
          prUrl: context.prUrl,
        },
        baseBody: enrichedBody,
        tokenHint: context.token,
        logger: this.host.log,
        rememberBody: (nextBody) => this.bodyAssembler.rememberPrBody(request.sessionId, nextBody),
        patchWithoutStorage: true,
      });
      if (reconciled === null) await patchDirectly();
    } catch (error) {
      this.host.log.warn(
        {
          event: "pr_template_fill_body_reconcile_failed",
          sessionId: request.sessionId,
          prNumber,
          error: String(error),
        },
        "Deferred PR template fill body reconcile failed; trying direct PR body patch",
      );
      try {
        await patchDirectly();
      } catch (patchError) {
        this.host.log.warn(
          {
            event: "pr_template_fill_body_patch_failed",
            sessionId: request.sessionId,
            prNumber,
            error: String(patchError),
          },
          "Deferred PR template fill body patch failed",
        );
      }
    }
  }

  /**
   * Stable durable-step name for a per-operation publish side effect, keyed by
   * sessionId + promptId + operation. The key memoizes across the entire prompt
   * lifetime, so a same-prompt re-publish is treated as the same logical
   * operation (matching the existing `create_pr_<session>_<promptId>` step) —
   * that is intended: the gate exists to suppress DO replays.
   *
   * `operation` is the effect CATEGORY (`pr_event`, `publish_completed`,
   * `slack_pr_created`, `release_evidence`) and is deliberately
   * operation-AGNOSTIC across create vs update. A genuine PR update always
   * arrives on a NEW promptId (each prompt publishes once via
   * `triggerPrCreation`/`triggerPrUpdate`), so distinct prompts get distinct
   * keys and every event still fires. The only case where one promptId hits both
   * the create and the update path is a DO replay (crash after `recordPublishedPr`
   * persisted `prUrl`), and there we WANT the whole group deduped — emitting a
   * second `publish.pr.updated`/`publish.completed`/evidence enqueue for the same
   * logical publish would be a duplicate. Keeping every effect's key
   * operation-agnostic makes the group dedupe uniformly (no skew where the PR
   * event re-fires but completion does not).
   *
   * Promptless publishes fall back to `no_prompt`. Real callers always supply a
   * promptId, so the only residual `no_prompt` collision is two promptless
   * publishes of the same PR — which does not occur in normal flow. We
   * deliberately do NOT fold `ext.publishAttempt` into the key: it is incremented
   * on every `publishSessionResultInner` entry (including replays), so it is
   * replay-unstable and using it would defeat replay dedup entirely.
   */
  private publishStep(operation: string, sessionId: string, promptId?: string): string {
    return `publish_${operation}_${sessionId}_${promptId ?? "no_prompt"}`;
  }

  /**
   * Single gated runner for the non-idempotent PR create/update post-publish
   * side effects, called by both the create path (`created: true`) and the
   * update path (`created: false`). Each effect is wrapped in its own
   * `durableStep` with a stable per-operation key so a DO replay does not
   * re-emit it.
   *
   * Guarantee: at-most-once per effect, exactly-once on the normal replay
   * (cache-hit) path. `durableStep` is memoize-on-success, so a crash between an
   * effect resolving and its `storage.put` landing can still re-run that single
   * effect on replay (the narrow window documented in durable-step.ts) — but
   * never the whole group, which is strictly better than the legacy coarse gate.
   *
   * Idempotent effects (`recordPublishedPr`, labels, body/title,
   * `syncFailedVerificationComment`) stay OUTSIDE this runner in the callers, and
   * `markReviewLoopEpochCompletedForPrompt` runs ungated here (it is a D1
   * CAS-guarded write). Fire-and-forget dispatches (`slack_pr_created`,
   * `release_evidence`, the metric counters) are gated for at-most-once
   * DISPATCH only — delivery remains best-effort, exactly as before.
   */
  private async runPublishSideEffects(args: {
    sessionId: string;
    promptId?: string;
    session: NonNullable<ReturnType<typeof doDb.getSession>>;
    ext: SessionPrWorkflowExt;
    auth: ResolvedPrRepoAuth;
    prUrl: string;
    prNumber: number;
    branch: string;
    body: string;
    remoteHeadSha: string;
    reconciledOptions: PrEventOptions;
    // true on the create path (emit `publish.pr.created` + dispatch the PR-created
    // Slack notification); false on the update path (emit `publish.pr.updated`).
    created: boolean;
    // true only for a genuinely new PR (createPr did not adopt an existing one).
    // Gates the PR-created metric so adopted PRs do not inflate the count.
    countCreateMetric: boolean;
    actualDraft: boolean;
    repoOwner: string;
    repoName: string;
  }): Promise<void> {
    const { sessionId, promptId, session, ext, auth, prUrl, prNumber, branch, body, remoteHeadSha, reconciledOptions } =
      args;
    const storage = this.host.state.storage;

    // 1. PR event (+ create metric when a genuinely new PR). Operation-agnostic
    //    key: a real update lands on a new promptId (distinct key, still fires);
    //    a create→update transition on the SAME promptId is a DO replay and must
    //    dedupe the whole group, not just some effects.
    await durableStep(
      storage,
      this.publishStep("pr_event", sessionId, promptId),
      async () => {
        await this.notifications.emitPublishPrEvent(
          args.created ? "publish.pr.created" : "publish.pr.updated",
          sessionId,
          prUrl,
          prNumber,
          branch,
          promptId,
          reconciledOptions,
        );
        // Count every genuinely-new PR Cycloid opens, tagged draft:true|false,
        // so drafts can be compared against ready ("green") PRs from one metric.
        // Dispatched via waitUntil so telemetry never delays publish completion
        // (the emitter caps its own POST and swallows errors).
        if (args.countCreateMetric) {
          this.host.waitUntil(
            emitPrCreatedMetric(this.host.env, {
              repo: `${args.repoOwner}/${args.repoName}`,
              ownerUserId: Number(session.ownerUserId),
              draft: args.actualDraft,
            }),
          );
        }
      },
      this.host.log,
    );

    // 2. PR-created Slack notification (create path only). Gated so the first
    //    fire-and-forget delivery cannot double-post on replay before
    //    `statusMessageTs` persists.
    if (args.created) {
      await durableStep(
        storage,
        this.publishStep("slack_pr_created", sessionId, promptId),
        async () => {
          this.notifications.notifyPrCreatedFireAndForget(sessionId);
        },
        this.host.log,
      );
    }

    // 3. publish.completed.
    await durableStep(
      storage,
      this.publishStep("publish_completed", sessionId, promptId),
      async () => {
        await this.notifications.emitPublishCompleted(sessionId, "published", promptId, prUrl, prNumber);
      },
      this.host.log,
    );

    // 4. Review-listening entry + armed metric. Gated internally on the head sha
    //    (a new head is a new wave that should re-enter); eligibility checks and
    //    the status-comment reconcile stay outside the gate.
    await this.enterReviewListeningIfEligible(sessionId, session, ext, prUrl, remoteHeadSha, promptId);

    // A genuine PR create is the only publish signal that excludes adopted and
    // follow-up republishes. The trusted-auto authorization is based on the
    // already-resolved owner/session GitHub publish context; there is no
    // synthetic GitHub actor to run the webhook collaborator check against.
    let owner: Awaited<ReturnType<typeof resolveInternalFeatureGateUser>> = null;
    try {
      owner = await resolveInternalFeatureGateUser(this.host.env.DB, Number(session.ownerUserId));
    } catch (error) {
      this.host.log.warn(
        { sessionId, ownerUserId: session.ownerUserId, error: String(error) },
        "Automatic PR review eligibility lookup failed after publish",
      );
    }
    const businessId = owner?.businessId;
    const installationId = auth.installationId;
    if (
      businessId &&
      installationId !== undefined &&
      isEligibleForAutomaticPrReview(session, owner, args.countCreateMetric)
    ) {
      try {
        await durableStep(
          storage,
          this.publishStep("auto_pr_review", sessionId, promptId),
          async () => {
            const result = await spawnPrReviewTrigger({
              env: this.host.env,
              ownerUserId: session.ownerUserId,
              businessId,
              prUrl,
              prNumber,
              repoOwner: args.repoOwner,
              repoName: args.repoName,
              installationId,
              claimToken: crypto.randomUUID(),
              triggerCommentId: 0,
              triggerSource: "auto",
              authorization: { mode: "trusted_auto" },
              focus: null,
              authorModel: session.model,
              authorAgentRuntimeBackend: session.agentRuntimeBackend,
            });
            if (!result.ok && result.kind === "retryable") {
              throw new Error(`Automatic PR review ${result.reason}`);
            }
            return result;
          },
          this.host.log,
        );
      } catch (error) {
        // Reviewer startup is an auxiliary post-publish effect. Keep the
        // already-created PR published while the durable step remains
        // retryable on a later session replay.
        this.host.log.warn(
          { sessionId, prUrl, error: String(error) },
          "Automatic PR review startup failed after publish",
        );
      }
    }

    // 5. GitHub release-evidence enqueue (fire-and-forget dispatch).
    await durableStep(
      storage,
      this.publishStep("release_evidence", sessionId, promptId),
      async () => {
        // Release evidence ultimately patches a managed region into the PR body.
        // Preserve-mode sessions adopt a human-owned PR, so they must not dispatch
        // any release-evidence work that can rewrite that body.
        if (ext.adoptedExternalPr !== true) {
          this.scheduleGithubReleaseEvidence(sessionId, auth, prNumber, body);
        }
      },
      this.host.log,
    );

    // 6. Mark the review-loop epoch completed (ungated: D1 CAS-guarded write).
    await this.markReviewLoopEpochCompletedForPrompt(sessionId, promptId);
  }

  private async autoCloseProdSmokePrIfNeeded(args: {
    sessionId: string;
    promptId?: string;
    session: NonNullable<ReturnType<typeof doDb.getSession>>;
    ext: SessionPrWorkflowExt;
    auth: ResolvedPrRepoAuth;
    prUrl: string;
    prNumber: number;
  }): Promise<void> {
    if (
      !isProdPrSmokeSessionForAutoClose({
        title: args.session.title,
        repoOwner: args.ext.repoOwner,
        repoName: args.ext.repoName,
      })
    ) {
      return;
    }

    const context = {
      sessionId: args.sessionId,
      token: args.auth.token,
      tokenSource: args.auth.tokenSource,
      installationId: args.auth.installationId,
      installationToken: args.auth.installationToken,
      repoOwner: args.auth.repoOwner,
      repoName: args.auth.repoName,
      prNumber: args.prNumber,
      prUrl: args.prUrl,
      ext: args.ext,
    };

    try {
      await durableStep(
        this.host.state.storage,
        this.publishStep("prod_smoke_pr_close", args.sessionId, args.promptId),
        () => this.github.closePr(context),
        this.host.log,
      );
      this.host.log.info(
        { event: "prod_pr_smoke_pr_closed", sessionId: args.sessionId, prUrl: args.prUrl, prNumber: args.prNumber },
        "Closed prod PR smoke test pull request",
      );
    } catch (error) {
      this.host.log.warn(
        {
          event: "prod_pr_smoke_pr_close_failed",
          sessionId: args.sessionId,
          prUrl: args.prUrl,
          prNumber: args.prNumber,
          error: String(error),
        },
        "Failed to close prod PR smoke test pull request",
      );
    }
  }

  async publishReviewLoopPush(request: {
    sessionId: string;
    promptId: string;
    branch: string;
    commitSha?: string;
    prReadiness?: PrReadinessEvidence;
    auth?: ResolvedPrRepoAuth;
    // The publish flow already ran validateReviewLoopPublishGuard (loading + validating
    // the epoch with identical inputs) before reaching here; thread that result through
    // so the guard and the getReviewLoopEpochById read are not repeated on the hot path.
    guard?: Extract<ReviewLoopPublishGuardResult, { ok: true }>;
  }): Promise<ReviewLoopPushResult> {
    const session = doDb.getSession(this.sql, request.sessionId);
    const ext = doDb.getSessionExtended(this.sql, request.sessionId);
    if (!session || !ext) return { ok: false, reason: "Review-loop push blocked: session not found." };
    if (!request.prReadiness)
      return { ok: false, reason: "Review-loop push blocked: missing publish readiness evidence." };

    const auth = request.auth ?? (await this.github.resolveRepoAuthForPublish(request.sessionId));
    if (!auth) return { ok: false, reason: "Review-loop push blocked: GitHub auth is unavailable." };

    const guard =
      request.guard ??
      (await this.validateReviewLoopPublishGuard(
        {
          sessionId: request.sessionId,
          branch: request.branch,
          commitSha: request.commitSha,
          prReadiness: request.prReadiness,
          promptId: request.promptId,
        },
        session,
        ext,
        auth,
      ));
    if (!guard.ok) {
      return {
        ok: false,
        reason: guard.reason,
        ...(guard.ownerApprovalRequired ? { ownerApprovalRequired: true } : {}),
      };
    }
    if (!guard.epochId)
      return { ok: false, reason: "Review-loop push blocked: prompt is not attached to a review iteration." };

    const db = this.host.env.DB;
    if (!db) return { ok: false, reason: "Review-loop push blocked: database is unavailable." };

    const epoch = guard.epoch ?? (await getReviewLoopEpochById(db, guard.epochId));
    if (!epoch) return { ok: false, reason: "Review-loop push blocked: review iteration was not found." };

    const diffHash = await computeReviewLoopReadinessDiffHash(request.prReadiness);
    const operationId = await buildReviewLoopPushOperationId({
      epochId: epoch.id,
      // The raw stored `worklist_hash` is used here purely as a deterministic
      // discriminator for the push operation id. Its MEANING differs by epoch
      // kind (review worklist hash vs CI failing-check fingerprint), but the
      // op-id only needs a stable per-epoch value, so the raw column is correct
      // for BOTH kinds — do not narrow it through reviewWorklistHash here, which
      // would null out CI epochs and change their op-id (breaking idempotency).
      headSha: epoch.headSha,
      worklistHash: epoch.worklistHash ?? "",
      diffHash,
    });

    const attempt = await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: epoch.id,
      sessionId: request.sessionId,
      promptId: request.promptId,
      kind: "push",
      targetSourceId: null,
      headSha: epoch.headSha,
      maxAttempts: REVIEW_LOOP_OPERATION_MAX_ATTEMPTS,
      nowMs: Date.now(),
    });
    if (attempt.status === "already_succeeded") {
      return {
        ok: true,
        status: "already_published",
        operationId: attempt.operation.operationId,
        commitSha: attempt.operation.githubId ?? epoch.headSha,
      };
    }
    if (attempt.status === "attempts_exhausted") {
      await markReviewLoopEpochBlocked(db, epoch.id, {
        nowMs: Date.now(),
        reason: "publish_failed",
        expectedPromptId: request.promptId,
      });
      // ARC-1330: an agent fix POST that failed past its retry cap is a give-up the caught_up cascade
      // cannot re-derive → route to NEEDS_YOU(review_response_failed) via epoch.blocked{response_failed}.
      await shadowEmitReviewLoopEpochBlockedTerminal(this.host.env, epoch, "publish_failed", this.host.log, (promise) =>
        this.host.waitUntil(promise),
      );
      return { ok: false, reason: "Review-loop push failed too many times.", operationId, retryable: false };
    }
    if (attempt.status === "conflict") {
      return {
        ok: false,
        reason: "Review-loop push is already running for this operation.",
        operationId: attempt.operation.operationId,
        retryable: true,
        operationInProgress: true,
      };
    }

    const publishing =
      epoch.status === "publishing" && epoch.lastPromptId === request.promptId
        ? epoch
        : await markReviewLoopEpochPublishing(db, guard.epochId, {
            promptId: request.promptId,
            nowMs: Date.now(),
          }).catch((error) => {
            this.host.log.warn(
              { sessionId: request.sessionId, epochId: guard.epochId, error: String(error) },
              "Failed to mark review-loop epoch publishing before guarded push",
            );
            return null;
          });
    if (!publishing) {
      // ARC-1407: the epoch-publishing CAS refused — a concurrent sweep advanced the epoch after the
      // guard read (a later prompt / reclaim / another worker moved it), or it was already
      // terminalized. But the agent's push may have genuinely landed; discarding it here is what
      // stranded 83% of prod push ops. Verified reality beats bookkeeping state: if the agent's claimed
      // commit IS the remote branch head, record the op succeeded and re-drive completion so the
      // evidence unblocks the round. Fail-closed: only when a commit was actually claimed
      // (request.commitSha) AND verifyRemoteBranch confirms it (it throws on a missing/divergent head).
      if (request.commitSha) {
        try {
          const remoteHeadSha = await this.verifyRemoteBranch(
            auth,
            request.branch,
            request.commitSha,
            request.sessionId,
            request.promptId,
          );
          await markReviewLoopOperationSucceeded(db, attempt.operation.operationId, {
            githubId: remoteHeadSha,
            nowMs: Date.now(),
            expectedAttempts: attempt.operation.attempts,
          });
          // The prompt-id-gated completion (runPublishSideEffects step 6) no-ops on this stale prompt,
          // so settle from the verified evidence here or the round stays wedged (a silent fix otherwise).
          await this.completeReviewLoopEpochFromRecoveredPush(request.sessionId, guard.epochId, remoteHeadSha);
          this.host.log.warn(
            {
              event: "review_loop_push_recovered_after_cas_miss",
              sessionId: request.sessionId,
              epochId: guard.epochId,
              promptId: request.promptId,
              commitSha: remoteHeadSha,
            },
            "Review-loop push recovered: verified remote head accepted despite stale epoch state (ARC-1407)",
          );
          return {
            ok: true,
            status: "published",
            operationId: attempt.operation.operationId,
            commitSha: remoteHeadSha,
          };
        } catch (error) {
          this.host.log.warn(
            {
              event: "review_loop_push_recovery_verify_failed",
              sessionId: request.sessionId,
              epochId: guard.epochId,
              promptId: request.promptId,
              error: stringifyError(error),
            },
            "Review-loop push recovery could not verify the remote head; discarding as epoch_not_processing (ARC-1407)",
          );
        }
      }
      await markReviewLoopOperationFailed(db, attempt.operation.operationId, {
        error: "epoch_not_processing",
        nowMs: Date.now(),
        expectedAttempts: attempt.operation.attempts,
      });
      return { ok: false, reason: "Review-loop push blocked: review iteration is not processing this prompt." };
    }

    try {
      const remoteHeadSha = await this.verifyRemoteBranch(
        auth,
        request.branch,
        request.commitSha,
        request.sessionId,
        request.promptId,
      );
      await markReviewLoopOperationSucceeded(db, attempt.operation.operationId, {
        githubId: remoteHeadSha,
        nowMs: Date.now(),
        expectedAttempts: attempt.operation.attempts,
      });
      await this.emitReviewLoopFirstOperationIfNeeded(db, epoch, "push", Date.now());
      return { ok: true, status: "published", operationId: attempt.operation.operationId, commitSha: remoteHeadSha };
    } catch (error) {
      const message = stringifyError(error);
      await markReviewLoopOperationFailed(db, attempt.operation.operationId, {
        error: message,
        nowMs: Date.now(),
        expectedAttempts: attempt.operation.attempts,
      });
      const exhausted = attempt.operation.attempts >= REVIEW_LOOP_OPERATION_MAX_ATTEMPTS;
      if (exhausted) {
        await markReviewLoopEpochBlocked(db, publishing.id, {
          nowMs: Date.now(),
          reason: "publish_failed",
          error: message,
          expectedPromptId: request.promptId,
        });
        // ARC-1330: surface the failed fix POST as NEEDS_YOU(review_response_failed).
        await shadowEmitReviewLoopEpochBlockedTerminal(
          this.host.env,
          publishing,
          "publish_failed",
          this.host.log,
          (promise) => this.host.waitUntil(promise),
        );
      }
      return { ok: false, reason: message, operationId: attempt.operation.operationId, retryable: !exhausted };
    }
  }

  async replyToReviewBotComment(request: {
    sessionId: string;
    promptId: string;
    epochId: string;
    targetSourceId: string;
    verdict: ReviewLoopReplyVerdict;
    body: string;
  }): Promise<ReviewLoopReplyResult> {
    const logBlockedReply = (reason: string, epochId = request.epochId): void => {
      this.host.log.warn(
        {
          event: "review_loop_reply_result",
          sessionId: request.sessionId,
          promptId: request.promptId,
          epochId,
          targetSourceId: request.targetSourceId,
          status: "blocked",
          reason,
        },
        "Review-loop reply blocked",
      );
    };

    const body = request.body.trim();
    if (!body) {
      const reason = "Review-loop reply blocked: reply body is empty.";
      logBlockedReply(reason);
      return { ok: false, reason };
    }
    if (body.length > 4096) {
      const reason = "Review-loop reply blocked: reply body exceeds 4096 chars.";
      logBlockedReply(reason);
      return { ok: false, reason };
    }

    const context = await this.resolveReviewLoopOperationContext({
      sessionId: request.sessionId,
      promptId: request.promptId,
      epochId: request.epochId,
    });
    if (!context.ok) {
      logBlockedReply(context.reason);
      return { ok: false, reason: context.reason };
    }

    if (isMergeConflictEpoch(context.epoch)) {
      const reason =
        "Review-loop reply blocked: merge-conflict resolution prompts do not have review comments to reply to.";
      logBlockedReply(reason, context.epoch.id);
      return { ok: false, reason };
    }

    // CI check-run failures (`check-run-failure:<id>`) only ever come from the sweep path's
    // failingCheckRunWorklistItems; getPrReviewLoopWorklist never returns them. Reject them up
    // front with the CI-specific reason, before the worklist refetch, so the lookup below cannot
    // mask this with a generic "not in the worklist" error.
    if (isCheckRunFailureSourceId(request.targetSourceId)) {
      const reason =
        "Review-loop reply blocked: CI check-run failures cannot be replied to; push a fix or post a summary instead.";
      logBlockedReply(reason, context.epoch.id);
      return { ok: false, reason };
    }

    // A mention epoch's reply target is always one of its OWN triggering sources (the exact comment/
    // review the user @-mentioned in). getPrReviewLoopWorklist has no producer that surfaces a human
    // top-level `issue-comment:<id>` — its issue-comment lane is bot-allowlist-only — so a mention
    // reply routed through the shared worklist is always rejected as "not in the current worklist"
    // (ARC-1514). Resolve it directly from the epoch's triggering ids; no live worklist refetch is
    // needed (its items could never include the mention's own human comment), and reviewSourceKind
    // throws on 'mention', so mentions must never reach the getPrReviewLoopWorklist call below.
    let item: ReviewLoopWorklistItem | null;
    let worklistItems: ReviewLoopWorklistItem[];
    if (isMentionEpoch(context.epoch)) {
      item = resolveMentionReplyItem({
        // The mention payload's TARGET ids, not the broader triggeringSourceIds — a targeted mention
        // folds the replied-to parent into triggering for dedup but never authorizes it as a reply
        // target. Mirrors the set the dispatch scoped the prompt to.
        authorizedTargetSourceIds: mentionReplyTargetSourceIds(context.epoch),
        targetSourceId: request.targetSourceId,
        prUrl: context.epoch.prUrl,
      });
      worklistItems = [];
    } else {
      const worklist = await getPrReviewLoopWorklist(
        context.token,
        context.epoch.repoOwner,
        context.epoch.repoName,
        context.epoch.prNumber,
        {
          expectedBots: context.expectedBots,
          // Match the worklist the agent was prompted with so human top-level review bodies
          // (`review-body:<id>`) are surfaced here too; otherwise a valid reply target would be
          // rejected as "not in the worklist". "ci" epochs have no human review bodies, so they
          // fall back to the default bot-style worklist.
          sourceKind: isCiEpoch(context.epoch) ? "bot" : reviewSourceKind(context.epoch),
          triggeringSourceIds: context.epoch.triggeringSourceIds,
        },
      );
      worklistItems = worklist.items;
      item = resolveReviewLoopReplyItem({
        worklist,
        targetSourceId: request.targetSourceId,
        prUrl: context.epoch.prUrl,
      });
      if (!item) {
        // The live refetch no longer surfaces the target (typically: the agent's own fix push flipped
        // the thread `isOutdated`, dropping it from the rebuilt worklist). An id this epoch prompted or
        // was triggered by stays a valid reply target — without this, the contractual verdict reply for
        // a just-addressed comment is rejected and the comment ends silently disposed (PR #7656).
        item = resolveReviewLoopEpochOwnedReplyItem({
          epoch: context.epoch,
          targetSourceId: request.targetSourceId,
          prUrl: context.epoch.prUrl,
        });
        if (item) {
          this.host.log.info(
            {
              event: "review_loop_reply_epoch_owned_fallback",
              sessionId: request.sessionId,
              promptId: request.promptId,
              epochId: context.epoch.id,
              targetSourceId: request.targetSourceId,
            },
            "Review-loop reply target resolved from the epoch's own prompted/triggering ids (absent from the live worklist)",
          );
        }
      }
    }
    if (!item) {
      const reason = `Review-loop reply blocked: target source ${request.targetSourceId} is not in the current worklist.`;
      logBlockedReply(reason, context.epoch.id);
      return { ok: false, reason };
    }

    const opKind = replyOperationKindForSourceId(request.targetSourceId);
    if (!opKind) {
      // CI check-run-failure ids are rejected earlier; only genuinely unsupported kinds reach here.
      const reason = "Review-loop reply blocked: unsupported target source kind.";
      logBlockedReply(reason, context.epoch.id);
      return { ok: false, reason };
    }

    const operationId = await buildReviewLoopReplyOperationId({
      epochId: context.epoch.id,
      headSha: context.epoch.headSha,
      targetSourceId: request.targetSourceId,
      opKind,
    });
    const attempt = await beginReviewLoopOperationAttempt(this.host.env.DB, {
      operationId,
      epochId: context.epoch.id,
      sessionId: request.sessionId,
      promptId: request.promptId,
      kind: "reply",
      targetSourceId: request.targetSourceId,
      headSha: context.epoch.headSha,
      verdict: request.verdict,
      verdictBasis: body,
      maxAttempts: REVIEW_LOOP_OPERATION_MAX_ATTEMPTS,
      nowMs: Date.now(),
    });
    if (attempt.status === "already_succeeded") {
      const operation =
        attempt.operation.verdict === null
          ? await fillSucceededReviewLoopReplyVerdict(this.host.env.DB, attempt.operation.operationId, {
              verdict: request.verdict,
              verdictBasis: body,
              nowMs: Date.now(),
            })
          : attempt.operation;
      return {
        ok: true,
        status: "already_replied",
        operationId: operation?.operationId ?? attempt.operation.operationId,
        githubId: operation?.githubId ?? attempt.operation.githubId,
      };
    }
    if (attempt.status === "attempts_exhausted") {
      await markReviewLoopEpochBlocked(this.host.env.DB, context.epoch.id, {
        nowMs: Date.now(),
        reason: "reply_failed",
        expectedPromptId: request.promptId,
      });
      // ARC-1330: a failed reply POST → NEEDS_YOU(review_response_failed).
      await shadowEmitReviewLoopEpochBlockedTerminal(
        this.host.env,
        context.epoch,
        "reply_failed",
        this.host.log,
        (promise) => this.host.waitUntil(promise),
      );
      return { ok: false, reason: "Review-loop reply failed too many times.", operationId, retryable: false };
    }
    if (attempt.status === "conflict") {
      return {
        ok: false,
        reason: "Review-loop reply is already running for this operation.",
        operationId: attempt.operation.operationId,
        retryable: true,
      };
    }

    try {
      const replyBody = buildReviewLoopReplyBody(body, item, opKind);
      const created =
        opKind === "review_comment_reply"
          ? await createPrReviewCommentReply(
              context.token,
              context.epoch.repoOwner,
              context.epoch.repoName,
              context.epoch.prNumber,
              parseReviewLoopSourceNumericId(request.targetSourceId, "review-comment")!,
              replyBody,
            )
          : await createPrIssueComment(
              context.token,
              context.epoch.repoOwner,
              context.epoch.repoName,
              context.epoch.prNumber,
              replyBody,
            );
      await markReviewLoopOperationSucceeded(this.host.env.DB, attempt.operation.operationId, {
        githubId: String(created.id),
        nowMs: Date.now(),
        expectedAttempts: attempt.operation.attempts,
      });
      await this.emitReviewLoopFirstOperationIfNeeded(this.host.env.DB, context.epoch, "reply", Date.now());
      const reviewThreadId = item.reviewThreadId ?? null;
      const shouldResolveThread =
        opKind === "review_comment_reply" &&
        reviewThreadId !== null &&
        (await shouldResolveReviewThreadAfterReply({
          db: this.host.env.DB,
          epoch: context.epoch,
          worklistItems,
          item,
          verdict: request.verdict,
        }));
      if (shouldResolveThread) {
        try {
          await resolvePrReviewThread(context.token, reviewThreadId);
        } catch (error) {
          this.host.log.warn(
            {
              event: "review_loop_reply_thread_resolve_failed",
              sessionId: request.sessionId,
              epochId: context.epoch.id,
              operationId: attempt.operation.operationId,
              targetSourceId: request.targetSourceId,
              reviewThreadId,
              error: stringifyError(error),
            },
            "Review-loop reply posted but parent thread resolution failed",
          );
        }
      }
      this.host.log.info(
        {
          event: "review_loop_reply_result",
          sessionId: request.sessionId,
          epochId: context.epoch.id,
          operationId: attempt.operation.operationId,
          targetSourceId: request.targetSourceId,
          verdict: request.verdict,
          status: "succeeded",
        },
        "Review-loop reply posted",
      );
      return {
        ok: true,
        status: "replied",
        operationId: attempt.operation.operationId,
        githubId: String(created.id),
      };
    } catch (error) {
      const message = stringifyError(error);
      await markReviewLoopOperationFailed(this.host.env.DB, attempt.operation.operationId, {
        error: message,
        nowMs: Date.now(),
        expectedAttempts: attempt.operation.attempts,
      });
      const exhausted = attempt.operation.attempts >= REVIEW_LOOP_OPERATION_MAX_ATTEMPTS;
      if (exhausted) {
        await markReviewLoopEpochBlocked(this.host.env.DB, context.epoch.id, {
          nowMs: Date.now(),
          reason: "reply_failed",
          error: message,
          expectedPromptId: request.promptId,
        });
        // ARC-1330: a failed reply POST → NEEDS_YOU(review_response_failed).
        await shadowEmitReviewLoopEpochBlockedTerminal(
          this.host.env,
          context.epoch,
          "reply_failed",
          this.host.log,
          (promise) => this.host.waitUntil(promise),
        );
      }
      this.host.log.warn(
        {
          event: "review_loop_reply_result",
          sessionId: request.sessionId,
          epochId: context.epoch.id,
          operationId: attempt.operation.operationId,
          targetSourceId: request.targetSourceId,
          verdict: request.verdict,
          status: "failed",
          retryable: !exhausted,
          error: message,
        },
        "Review-loop reply failed",
      );
      return { ok: false, reason: message, operationId: attempt.operation.operationId, retryable: !exhausted };
    }
  }

  private async emitReviewLoopFirstOperationIfNeeded(
    db: D1Database,
    epoch: ReviewLoopEpoch,
    operationKind: "push" | "reply",
    nowMs: number,
  ): Promise<void> {
    const succeededCount = await countSucceededReviewLoopOperations(db, epoch.id);
    if (succeededCount !== 1) return;
    this.host.waitUntil(
      emitReviewLoopArrivalToFirstOperationEvent(this.host.env, {
        sourceKind: epoch.sourceKind,
        operationKind,
        repo: `${epoch.repoOwner}/${epoch.repoName}`,
        ownerUserId: epoch.ownerUserId,
        arrivalToFirstOperationMs: nowMs - epoch.firstActivityAt,
        sessionId: epoch.sessionId,
        prUrl: epoch.prUrl,
        epochId: epoch.id,
      }),
    );
  }

  /**
   * Shared review-loop eligibility gate for an epoch. Returns a BARE reason (no "Review-loop ...
   * blocked:" prefix) so the reply path and the publish guard can each apply their own prefix. The
   * ci/human-mixed-verification/bot-checklist branching is identical in both guards; this is its
   * single source of truth.
   */
  private async resolveReviewLoopEligibilityForEpoch(
    epoch: ReviewLoopEpoch,
  ): Promise<{ ok: true; installationId: number } | { ok: false; reason: string }> {
    // Human/mixed epochs carry a non-bot expected-bots hash (EMPTY) and verification-intake epochs
    // carry the verification sentinel hash, so the bot checklist would always fail them; all three
    // use the human gate (no configured bots required). CI epochs also bypass the bot checklist, but
    // they must use the CI-specific gate so a repo-level CI-response opt-out blocks existing CI
    // epochs too.
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    const eligibility =
      // CI and mention epochs both bypass the review checklist and gate on install capabilities only.
      // Mention (`@cycloid …`) must publish even in manual review mode, so it shares the CI (caps-only)
      // gate — never the checklist / automatic_reviews_enabled path.
      epoch.sourceKind === "ci" || isMentionEpoch(epoch)
        ? await resolveReviewLoopCiEligibility(this.host.env, {
            ownerUserId: epoch.ownerUserId,
            repoOwner: epoch.repoOwner,
            repoName: epoch.repoName,
          })
        : isMergeConflictEpoch(epoch)
          ? await resolveReviewLoopMergeConflictEligibility(this.host.env, {
              ownerUserId: epoch.ownerUserId,
              repoOwner: epoch.repoOwner,
              repoName: epoch.repoName,
            })
          : epoch.sourceKind === "human" || epoch.sourceKind === "mixed" || epoch.sourceKind === "verification"
            ? await resolveReviewLoopHumanEligibility(this.host.env, {
                ownerUserId: epoch.ownerUserId,
                repoOwner: epoch.repoOwner,
                repoName: epoch.repoName,
                // Verification epochs bypass the manual-review gate (QA independent of manual mode); ARC-1514.
                sourceKind: epoch.sourceKind,
              })
            : await resolveReviewLoopChecklist(this.host.env, {
                ownerUserId: epoch.ownerUserId,
                repoOwner: epoch.repoOwner,
                repoName: epoch.repoName,
                expectedBotsHash: epoch.expectedBotsHash,
              });
    if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
    return { ok: true, installationId: eligibility.installationId };
  }

  /**
   * Shared head-change + lifecycle guard for an epoch. One Get-a-PR read (getPrMergeStatus) returns
   * state + head, so the guard also fails closed on a merged/closed PR — never republish a push or
   * post a reply to a PR that is no longer open for review. Accepts the head only when it equals
   * epoch.headSha OR the epoch's own most-recent pushed SHA (expectedPushedHead) — the #4987
   * self-head-advance allowance. Fails closed on a head-read failure. Returns a BARE reason; callers
   * apply their prefix.
   */
  private async assertReviewLoopHeadUnchanged(
    epoch: ReviewLoopEpoch,
    token: string,
    expectedPushedHead?: string | null,
  ): Promise<{ ok: true; currentHead: string } | { ok: false; reason: string; benign: boolean }> {
    // getPrMergeStatus throws on 401/403 (auth lost) and returns state: null for any other non-OK;
    // both fail closed (we cannot prove the PR is open at the expected head). A head we cannot verify
    // is GENUINE (benign: false); a PR that merged/closed or moved on under us is BENIGN (it just
    // means the review iteration is no longer the live target).
    let mergeStatus: PrMergeStatus;
    try {
      mergeStatus = await getPrMergeStatus(token, epoch.repoOwner, epoch.repoName, epoch.prNumber);
    } catch {
      return { ok: false, reason: "current PR head could not be verified", benign: false };
    }
    if (mergeStatus.state === null)
      return { ok: false, reason: "current PR head could not be verified", benign: false };
    if (mergeStatus.state === "closed" || mergeStatus.state === "merged") {
      return { ok: false, reason: `the PR is ${mergeStatus.state}`, benign: true };
    }
    const currentHead = mergeStatus.headSha;
    if (!currentHead) return { ok: false, reason: "current PR head could not be verified", benign: false };
    if (currentHead !== epoch.headSha && (!expectedPushedHead || currentHead !== expectedPushedHead)) {
      return { ok: false, reason: "PR head changed while responding to review", benign: true };
    }
    return { ok: true, currentHead };
  }

  private async resolveReviewLoopOperationContext(input: {
    sessionId: string;
    promptId: string;
    epochId?: string | null;
    auth?: ResolvedPrRepoAuth;
  }): Promise<({ ok: true } & ReviewLoopOperationContext) | { ok: false; reason: string }> {
    const db = this.host.env.DB;
    if (!db) return { ok: false, reason: "Review-loop operation blocked: database is unavailable." };

    const session = doDb.getSession(this.sql, input.sessionId);
    const ext = doDb.getSessionExtended(this.sql, input.sessionId);
    if (!session || !ext) return { ok: false, reason: "Review-loop operation blocked: session not found." };
    if (session.status !== "active")
      return { ok: false, reason: "Review-loop operation blocked: session is not active." };

    const prompt = doDb.getPrompt(this.sql, input.promptId);
    const epochId = input.epochId?.trim() || prompt?.reviewLoopEpochId?.trim() || null;
    if (!epochId)
      return { ok: false, reason: "Review-loop operation blocked: prompt is not attached to a review iteration." };

    const epoch = await getReviewLoopEpochById(db, epochId);
    if (!epoch) return { ok: false, reason: "Review-loop operation blocked: review iteration was not found." };
    if (epoch.sessionId !== input.sessionId || epoch.ownerUserId !== Number(session.ownerUserId)) {
      return { ok: false, reason: "Review-loop operation blocked: review iteration belongs to a different session." };
    }
    if (epoch.lastPromptId && epoch.lastPromptId !== input.promptId) {
      return {
        ok: false,
        reason: "Review-loop operation blocked: review iteration is attached to a different prompt.",
      };
    }
    if (!REVIEW_LOOP_REPLY_ACTIVE_STATUSES.has(epoch.status)) {
      return {
        ok: false,
        reason: `Review-loop operation blocked: review iteration is not active for this prompt (${epoch.status}).`,
      };
    }
    if (!sessionPrMatchesReviewLoopEpoch(ext, epoch)) {
      return {
        ok: false,
        reason: "Review-loop operation blocked: this session is no longer working on the review iteration's PR.",
      };
    }

    const eligibility = await this.resolveReviewLoopEligibilityForEpoch(epoch);
    if (!eligibility.ok) return { ok: false, reason: `Review-loop operation blocked: ${eligibility.reason}.` };

    const auth = input.auth ?? (await this.github.resolveRepoAuthForPublish(input.sessionId));
    if (!auth) return { ok: false, reason: "Review-loop operation blocked: GitHub auth is unavailable." };
    let token: string;
    try {
      token = await createInstallationToken(this.host.env, eligibility.installationId);
    } catch (error) {
      this.host.log.warn(
        {
          event: "review_loop_reply_installation_token_unavailable",
          sessionId: input.sessionId,
          promptId: input.promptId,
          epochId: epoch.id,
          installationId: eligibility.installationId,
          error: stringifyError(error),
        },
        "Review-loop reply blocked: installation token mint failed",
      );
      return {
        ok: false,
        reason: "Review-loop operation blocked: GitHub App installation token is unavailable.",
      };
    }
    // #4987: after the agent pushes a review-loop fix the PR head advances past epoch.headSha, so a
    // reply to the just-addressed comment must accept the epoch's OWN most-recent pushed SHA — never
    // an arbitrary head. That SHA is the verified remote head recorded as the push operation's
    // github_id; a third-party head change still fails closed.
    const expectedPushedHead = await selectLatestSucceededReviewLoopPushHead(db, epoch.id);
    const head = await this.assertReviewLoopHeadUnchanged(epoch, token, expectedPushedHead);
    if (!head.ok) return { ok: false, reason: `Review-loop operation blocked: ${head.reason}.` };

    return { ok: true, session, ext, epoch, auth, token, expectedBots: epoch.expectedBots };
  }

  private async validateReviewLoopPublishGuard(
    request: PublishRequest,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    auth: ResolvedPrRepoAuth,
  ): Promise<ReviewLoopPublishGuardResult> {
    const prompt = request.promptId ? doDb.getPrompt(this.sql, request.promptId) : null;
    const epochId = prompt?.reviewLoopEpochId?.trim() || null;
    if (!epochId) return { ok: true, epochId: null, epoch: null };

    // benign = the PR/session moved on (not a real failure); benign blocks are routed to the neutral
    // `superseded` state (see blockReviewLoopPublish) instead of the red `failed` publish terminal.
    // Defaults to false (genuine).
    const fail = (
      reason: string,
      opts: { ownerApprovalRequired?: boolean; benign?: boolean } = {},
    ): ReviewLoopPublishGuardResult => ({
      ok: false,
      epochId,
      reason,
      ...(opts.ownerApprovalRequired ? { ownerApprovalRequired: true } : {}),
      ...(opts.benign ? { benign: true } : {}),
    });

    const db = this.host.env.DB;
    if (!db) return fail("Review-loop publish blocked: database is unavailable.");

    const epoch = await getReviewLoopEpochById(db, epochId);
    if (!epoch) return fail("Review-loop publish blocked: review iteration was not found.");
    if (session.status !== "active")
      return fail("Review-loop publish blocked: session is not active.", { benign: true });
    if (epoch.sessionId !== request.sessionId || epoch.ownerUserId !== Number(session.ownerUserId)) {
      return fail("Review-loop publish blocked: review iteration belongs to a different session.", { benign: true });
    }
    if (epoch.lastPromptId && epoch.lastPromptId !== request.promptId) {
      return fail("Review-loop publish blocked: review iteration is attached to a different prompt.", { benign: true });
    }
    if (!sessionPrMatchesReviewLoopEpoch(ext, epoch)) {
      return fail("Review-loop publish blocked: this session is no longer working on the review iteration's PR.", {
        benign: true,
      });
    }

    // Eligibility stays GENUINE (red) — it signals missing setup/capabilities that need user action.
    const eligibility = await this.resolveReviewLoopEligibilityForEpoch(epoch);
    if (!eligibility.ok) return fail(`Review-loop publish blocked: ${eligibility.reason}.`);

    // The publish guard already knows the SHA the agent just pushed (request.commitSha), so it
    // accepts a self-advance to that head directly (#4987).
    const head = await this.assertReviewLoopHeadUnchanged(
      epoch,
      auth.installationToken ?? auth.token,
      request.commitSha?.trim() || null,
    );
    if (!head.ok) return fail(`Review-loop publish blocked: ${head.reason}.`, { benign: head.benign });

    const readiness = request.prReadiness;
    if (!readiness) return fail("Review-loop publish blocked: missing publish readiness evidence.");

    const changedFiles = readiness.changedFiles.filter((file) => file.trim().length > 0);
    if (changedFiles.length > REVIEW_LOOP_MAX_CHANGED_FILES) {
      this.host.log.warn(
        { sessionId: request.sessionId, promptId: request.promptId, changedFiles: changedFiles.length },
        "Review-loop publish size alert: changed file count exceeded threshold",
      );
    }

    const changedLines = Math.max(0, readiness.diffStats.insertions) + Math.max(0, readiness.diffStats.deletions);
    if (changedLines > REVIEW_LOOP_MAX_CHANGED_LINES) {
      this.host.log.warn(
        { sessionId: request.sessionId, promptId: request.promptId, changedLines },
        "Review-loop publish size alert: changed line count exceeded threshold",
      );
    }

    const sensitiveFiles = changedFiles.filter(isReviewLoopSensitivePath);
    if (sensitiveFiles.length > 0) {
      const preview = sensitiveFiles.slice(0, 5).join(", ");
      const suffix = sensitiveFiles.length > 5 ? ` and ${sensitiveFiles.length - 5} more` : "";
      return fail(`Review-loop changes touch sensitive paths and require owner approval: ${preview}${suffix}.`, {
        ownerApprovalRequired: true,
      });
    }

    return { ok: true, epochId, epoch };
  }

  private async blockReviewLoopPublish(
    sessionId: string,
    branch: string,
    guard: Exclude<ReviewLoopPublishGuardResult, { ok: true }>,
    promptId?: string,
  ): Promise<PublishResult> {
    if (guard.epochId && this.host.env.DB) {
      const update = guard.ownerApprovalRequired ? markReviewLoopEpochWaitingForOwner : markReviewLoopEpochBlocked;
      const updatedEpoch = await update(this.host.env.DB, guard.epochId, {
        nowMs: Date.now(),
        reason: guard.reason,
        expectedPromptId: promptId ?? null,
      }).catch((error) => {
        this.host.log.warn(
          { sessionId, epochId: guard.epochId, error: String(error) },
          "Failed to update review-loop epoch after publish guard block",
        );
        return null;
      });
      // ARC-1330 (PR 41) shadow producer: the owner-approval publish guard dual-emits
      // `epoch.blocked{owner_approval}` — the design's sole owner-approval path, making PR 15's
      // `REVIEW—epoch.blocked{owner_approval}→NEEDS_YOU` edge reachable. Best-effort, OFF the legacy path.
      if (guard.ownerApprovalRequired && updatedEpoch?.status === "waiting_for_owner") {
        await shadowEmitReviewLoopEpochTerminal(
          this.host.env,
          updatedEpoch,
          "blocked_owner_approval",
          this.host.log,
          (promise) => this.host.waitUntil(promise),
        );
      } else if (updatedEpoch?.status === "blocked") {
        // ARC-1330: non-owner-approval publish-guard block (benign supersede / other). Clear the
        // in-flight marker so it doesn't strand (a benign block also routes to SUPERSEDED below via
        // publish.superseded; the producer's match guard makes this a no-op once the record has moved).
        await shadowEmitReviewLoopEpochBlockedTerminal(
          this.host.env,
          updatedEpoch,
          guard.reason,
          this.host.log,
          (promise) => this.host.waitUntil(promise),
        );
      }
    }

    // BENIGN = the PR/session moved on (merged/closed, head advanced under us, stale epoch). This is
    // not a failure: settle the session in the neutral `superseded` state with no red error, emit a
    // neutral PR event, and NO `pr_failed` broadcast. Owner-approval blocks stay genuine (red) — they
    // need user action. The epoch persistence above is unchanged for both paths.
    const benign = guard.benign === true && guard.ownerApprovalRequired !== true;
    if (benign) {
      await this.setPublishState(sessionId, {
        publishStatus: "superseded",
        publishStage: "done",
        publishError: null,
      });
      await this.notifications.emitPublishSuperseded(sessionId, guard.reason, branch, promptId);
      await this.notifications.emitPublishCompleted(sessionId, "superseded", promptId);
      // ARC-1330/ARC-1389 shadow producer: dual-emit the benign supersede onto the spine so the session
      // settles in the neutral SUPERSEDED terminal ({REVIEW,VERIFYING}→SUPERSEDED) instead of freezing in
      // its listening state. Best-effort, OFF the legacy path (the dual-emit contract).
      await this.shadowEmitFsmPublishEvent(sessionId, buildPublishSupersededEmission());
      return { ok: true, status: "superseded", reason: guard.reason };
    }

    // GENUINE (red) guard block — owner approval required, lost eligibility, or missing readiness
    // evidence. The legacy pre-publish block publish status was deleted (ARC-1330 D-57): a genuine
    // block now settles on the ordinary loud `failed` publish terminal (guard reason
    // preserved as `publishError`, `pr_failed` broadcast intact) — never a silent auto-merge. The
    // authoritative owner-approval surface is the FSM `epoch.blocked{owner_approval}` edge emitted
    // above, which projects `NEEDS_YOU(blocked_reason)` and never `MERGE_READY`. `failPublish`'s
    // `publish.failed` spine emission is only handled from `PUBLISHING`, so from the post-publish
    // `REVIEW`/`NEEDS_YOU` record it is an unhandled no-op and cannot clobber that `NEEDS_YOU`.
    return this.failPublish(sessionId, "verifying", new Error(guard.reason), promptId, {
      cause: "review_loop_publish_guard",
    });
  }

  private async markReviewLoopEpochCompletedForPrompt(sessionId: string, promptId?: string): Promise<void> {
    if (!promptId || !this.host.env.DB) return;
    const prompt = doDb.getPrompt(this.sql, promptId);
    const epochId = prompt?.reviewLoopEpochId?.trim();
    if (!epochId) return;
    const epoch = await markReviewLoopEpochCompleted(this.host.env.DB, epochId, {
      nowMs: Date.now(),
      expectedPromptId: promptId,
      // Dominant "work published" completion — the success numerator for the loop settle-rate SLI.
      // (The publish_failed/reply_failed blocked paths below are not yet instrumented; the headline
      // cap-block reasons are covered from the sweep.) waitUntil so a Datadog hiccup never slows publish.
      telemetry: {
        env: this.host.env,
        model: doDb.getSession(this.sql, sessionId)?.model ?? null,
        dispatch: (promise) => this.host.waitUntil(promise),
      },
    }).catch((error) => {
      this.host.log.warn(
        { sessionId, epochId, error: String(error) },
        "Failed to mark review-loop epoch completed after publish",
      );
      return null;
    });
    // ARC-1330 (PR 41) shadow producer: a published fix-commit completion dual-emits `epoch.committed`
    // (disposition `fixed`). Best-effort/try-caught inside the helper, OFF the legacy publish path.
    if (epoch?.status === "completed") {
      await shadowEmitReviewLoopEpochTerminal(this.host.env, epoch, "committed", this.host.log, (promise) =>
        this.host.waitUntil(promise),
      );
    }
  }

  /**
   * ARC-1407: settle a review-loop epoch from a verified late push when the prompt-id-gated completion
   * above cannot (the recording prompt is stale / the epoch moved on or was terminalized `blocked`).
   * Mirrors the completion telemetry + shadow-emit of `markReviewLoopEpochCompletedForPrompt`, but drives
   * the evidence-anchored DAO that bypasses the prompt-id CAS. Best-effort: a settle failure never fails
   * the (already-succeeded) push.
   */
  private async completeReviewLoopEpochFromRecoveredPush(
    sessionId: string,
    epochId: string,
    verifiedHeadSha: string,
  ): Promise<void> {
    if (!this.host.env.DB) return;
    const epoch = await completeReviewLoopEpochFromVerifiedPush(this.host.env.DB, epochId, {
      nowMs: Date.now(),
      verifiedHeadSha,
      telemetry: {
        env: this.host.env,
        model: doDb.getSession(this.sql, sessionId)?.model ?? null,
        dispatch: (promise) => this.host.waitUntil(promise),
      },
    }).catch((error) => {
      this.host.log.warn(
        { sessionId, epochId, error: String(error) },
        "Failed to settle review-loop epoch from recovered push (ARC-1407)",
      );
      return null;
    });
    if (epoch?.status === "completed") {
      await shadowEmitReviewLoopEpochTerminal(this.host.env, epoch, "committed", this.host.log, (promise) =>
        this.host.waitUntil(promise),
      );
    }
  }

  private get sql(): SqlStorage {
    return this.host.state.storage.sql;
  }

  private resolveSessionId(): string | null {
    const rows = this.sql.exec("SELECT session_id FROM session LIMIT 1").toArray();
    return rows.length > 0 ? (rows[0].session_id as string) : null;
  }

  private async verifyRemoteBranch(
    auth: ResolvedPrRepoAuth,
    branch: string,
    commitSha: string | undefined,
    sessionId: string,
    promptId?: string,
  ): Promise<string> {
    const remoteSha = await this.github.getRemoteBranchHeadSha(auth, branch);
    if (!remoteSha) throw new Error("Branch was not pushed to GitHub; PR cannot be created from this session");
    await this.setPublishState(sessionId, {
      publishStatus: "publishing",
      publishStage: "pushing",
      publishError: null,
      publishedBranch: branch,
    });
    await this.notifications.emitPublishPushConfirmed(sessionId, branch, remoteSha, promptId);
    // When the agent reports the SHA it pushed, the remote branch head MUST equal it — a mismatch
    // means the push did not land (or a third party moved the branch), so fail closed (a review-loop
    // push then marks the operation FAILED/retryable, never succeeded). A self-advance IS the agent's
    // own commitSha, so this equality check accepts it; only when commitSha is absent (initial PR
    // creation, no claimed SHA) is the remote head accepted as-is.
    if (commitSha && remoteSha !== commitSha) {
      throw new Error(`Remote branch SHA mismatch for ${branch}`);
    }
    return remoteSha;
  }

  private scheduleGithubReleaseEvidence(
    sessionId: string,
    auth: ResolvedPrRepoAuth,
    prNumber: number,
    body: string,
  ): void {
    this.host.waitUntil(
      this.githubEvidence.publishForPr({ sessionId, auth, prNumber, body }).catch((err) => {
        this.host.log.warn({ sessionId, prNumber, errorMessage: String(err) }, "GitHub release evidence task failed");
      }),
    );
  }

  private async ensurePrReadyForPublish(context: ResolvedPrUpdateContext, readyMessage: string): Promise<boolean> {
    const reconciledDraft = await this.github.ensurePrReadyForReview(context);
    if (reconciledDraft.changed) {
      this.host.log.info(
        { sessionId: context.sessionId, prNumber: context.prNumber, draft: reconciledDraft.actualDraft },
        readyMessage,
      );
    }
    return reconciledDraft.actualDraft;
  }

  // ARC-1330 D-50A — the managed verification-comment metadata-refresh machinery
  // (refreshVerificationCommentAfterPrMetadataChange / scheduleVerificationCommentMetadataRefreshRetry /
  // markPendingVerificationCommentForLiveGateRefresh) was removed with the comment surface. No managed PR
  // comment renders PR title/metadata, so a title change no longer needs a comment refresh.

  private async enterReviewListeningIfEligible(
    sessionId: string,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    prUrl: string,
    currentHeadSha: string,
    promptId?: string,
  ): Promise<void> {
    const repoOwner = ext.repoOwner?.trim();
    const repoName = ext.repoName?.trim();
    // ARC-1472: review-loop arming is DECOUPLED from the QA opt-out. #5485 keyed this skip on
    // `autoVerifyDisabled` as a proxy for prod-verifier smoke sessions, but that conflates two
    // separate axes: `autoVerifyDisabled` gates only verification (QA) spawn, while arming the
    // review loop (CI-fix + bot-response automation) must run for every published PR. Once
    // auto-verify defaults OFF (stack γ), keying on `autoVerifyDisabled` would strip review
    // automation from every new user. Suppress arming ONLY for sessions that structurally never
    // participate in the review loop — QA/verifier and onboarding sessions — via the canonical
    // `reviewVerificationExemptReason` predicate (the same guard the human-review re-engage path
    // uses). Verification spawn below stays gated on `autoVerifyDisabled`.
    const exemptReason = reviewVerificationExemptReason(session);
    if (exemptReason) {
      this.host.log.info(
        { sessionId, reason: exemptReason },
        "Skipping review listening after publish: session is exempt from the review loop",
      );
      return;
    }
    if (!repoOwner || !repoName) {
      this.host.log.info({ sessionId }, "Skipping review listening after publish: missing repo context");
      return;
    }

    const ownerUserId = Number(session.ownerUserId);
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
      this.host.log.info(
        { sessionId, ownerUserId: session.ownerUserId },
        "Skipping review listening after publish: invalid owner user id",
      );
      return;
    }

    // Drafts and ready PRs follow the same arming path: a draft no longer skips
    // review-listening. Arming is gated only by installation capabilities (a
    // missing bot checklist is arm-only). A capability-blocked (re)publish is a
    // no-op for an existing listener, matching the non-draft path — there is no
    // draft-specific exit.
    try {
      // Always arm review-listening for capable repos. A changed bot checklist
      // (expected_bots_changed) is arm-only — the always-on CI-fix + verification
      // arm still runs — so only missing installation capabilities (the GitHub App
      // can't ingest review/CI webhooks) blocks arming. A zero-bot repo now resolves
      // ok:true with an empty expected-bot set (walltime removal) and arms like any
      // other capable repo. The auto-response / CI-response opt-outs were removed
      // (ARC-1288), so a disabled toggle can no longer skip arming or silently
      // disable post-PR verification.
      //
      // resolveReviewLoopChecklist returns `expected_bots_changed` BEFORE its
      // capability check, so in that case verify capabilities directly (the CI gate
      // is capability-only) so a degraded GitHub App install does not silently arm a
      // listener whose webhooks can't be ingested.
      const checklist = await resolveReviewLoopChecklist(this.host.env, { ownerUserId, repoOwner, repoName });
      let capabilitiesMissing = false;
      if (!checklist.ok) {
        if (checklist.reason === "installation_capabilities_missing") {
          capabilitiesMissing = true;
        } else {
          const caps = await resolveReviewLoopCiEligibility(this.host.env, { ownerUserId, repoOwner, repoName });
          if (!caps.ok) {
            capabilitiesMissing = true;
          }
        }
      }
      if (capabilitiesMissing) {
        this.host.log.info(
          { sessionId, ownerUserId: session.ownerUserId },
          "Skipping review listening after publish: installation capabilities missing",
        );
        return;
      }
    } catch (error) {
      this.host.log.warn(
        { sessionId, ownerUserId: session.ownerUserId, error: String(error) },
        "Failed to resolve review-loop eligibility after publish; skipping review listening",
      );
      return;
    }

    const wasReviewListeningActive = ext.reviewListeningActive === true;

    // Gate ONLY the non-idempotent `review_listening.entered` append + armed
    // metric, keyed on the head sha and deliberately NOT the promptId. The
    // acceptance criterion is "entered exactly once per publish head/wave", so the
    // wave (head sha) is the dedup identity: a replay OR a different prompt that
    // re-publishes the same head is a cache hit (no re-append), while a genuinely
    // new wave (new head) re-enters. Including promptId would let two prompts at
    // the same head each append a duplicate `review_listening.entered`. The head
    // sha is the wave identity, so embedding it in the step name is the correct
    // memoization key — not a violation of the "stable keys" rule in
    // conventions.md, which targets keys that change WITHIN one logical attempt
    // (its "Per-attempt IDs are fine when the same attempt should memoize"
    // carve-out). The eligibility checks above stay OUTSIDE the gate: an
    // eligibility-check failure must not prevent the append step from memoizing,
    // or replay would re-append the entry.
    await durableStep(
      this.host.state.storage,
      `publish_review_listening_${sessionId}_${currentHeadSha}`,
      async () => {
        await this.enterReviewListening(sessionId, prUrl, currentHeadSha, promptId);
        if (!session.autoVerifyDisabled && this.host.setVerificationStateForPr) {
          this.host.waitUntil(
            this.host
              .setVerificationStateForPr({
                sessionId,
                prUrl,
                state: "verification-pending",
                attemptCount: 0,
                installationId: ext.installationId ?? null,
                repoOwner,
                repoName,
              })
              .catch((error) => {
                this.host.log.warn(
                  { sessionId, prUrl, error: String(error) },
                  "Failed to set verification pending state after review-listening entry",
                );
              }),
          );
        }

        if (!wasReviewListeningActive) {
          // ARC-1112: count every PR that newly arms the review loop, tagged
          // draft:true|false, restoring visibility into how often unverified (draft)
          // PRs enter the loop now that drafts and ready PRs share one arming path.
          // Source the draft flag from the persisted session row (recordPublishedPr
          // writes prDraft before this runs) rather than re-threading an isDraft
          // parameter into the unified arming path. Dispatched via waitUntil so
          // telemetry never delays publish completion (the emitter also caps its own
          // POST and swallows errors).
          const freshExt = doDb.getSessionExtended(this.sql, sessionId);
          if (!freshExt) {
            this.host.log.warn(
              { sessionId },
              "getSessionExtended returned null after enterReviewListening; draft tag will default to false",
            );
          }
          const prDraft = freshExt?.prDraft === true;
          this.host.waitUntil(
            emitReviewLoopArmedMetric(this.host.env, {
              repo: `${repoOwner}/${repoName}`,
              ownerUserId,
              draft: prDraft,
            }),
          );
        }
      },
      this.host.log,
    );
  }

  private async enterReviewListening(
    sessionId: string,
    prUrl: string,
    currentHeadSha: string,
    promptId?: string,
  ): Promise<void> {
    await this.host.enterReviewListening({ sessionId, prUrl, currentHeadSha });
    await this.appendEntries(
      sessionId,
      [
        {
          type: "review_listening.entered",
          timestamp: nowIso(),
          data: {
            sessionId,
            ...(promptId ? { promptId } : {}),
            prUrl,
            currentHeadSha,
          },
        },
      ],
      promptId,
    );
  }

  private async syncFailedVerificationComment(
    sessionId: string,
    context: ResolvedPrUpdateContext,
    verification: ExecutionVerification | undefined,
    evidence: PrReadinessEvidence | undefined,
  ): Promise<void> {
    const body = buildFailedVerificationComment(verification, evidence);

    try {
      const storedRef = await this.host.state.storage.get(FAILED_VERIFICATION_COMMENT_STORAGE_KEY);
      const ref =
        isFailedVerificationCommentRef(storedRef) && storedRef.prNumber === context.prNumber ? storedRef : null;
      if (!body) {
        if (!ref) return;
        await this.github.deletePrEvidenceComment(context, ref.commentId);
        await this.host.state.storage.delete(FAILED_VERIFICATION_COMMENT_STORAGE_KEY);
        return;
      }

      if (ref) {
        try {
          await this.github.updatePrEvidenceComment(context, ref.commentId, body);
          return;
        } catch (error) {
          this.host.log.warn(
            { sessionId, prNumber: context.prNumber, commentId: ref.commentId, error: String(error) },
            "Failed to update failed verification comment; creating a fresh comment",
          );
        }
      }

      const commentId = await this.github.createPrEvidenceComment(context, body);
      await this.host.state.storage.put(FAILED_VERIFICATION_COMMENT_STORAGE_KEY, {
        prNumber: context.prNumber,
        commentId,
      } satisfies FailedVerificationCommentRef);
    } catch (error) {
      this.host.log.warn(
        { sessionId, prNumber: context.prNumber, error: String(error) },
        "Failed to sync failed verification comment after PR publish",
      );
    }
  }

  private async recordPublishedPr(
    sessionId: string,
    prUrl: string,
    prNumber: number,
    branch: string,
    options: PrEventOptions,
    promptId?: string,
  ): Promise<void> {
    doDb.updateSessionFields(this.sql, sessionId, {
      prUrl,
      prNumber,
      prDraft: options.draft === true,
      prManualReviewReason: options.manualReviewReason?.trim() || null,
      publishStatus: "published",
      publishStage: "done",
      publishError: null,
      publishedBranch: branch,
      // ARC-876: this path bypasses setPublishState, so disarm the publishing
      // watchdog inline. setPublishState's guard tolerates the leftover via
      // the previous-status check, but keeping the DB tidy avoids surprising
      // observers that scan publishing_started_at directly.
      publishingStartedAt: null,
    });
    // ARC-876 resume: this success path bypasses setPublishState, so clear the
    // publishing prompt anchor inline too. Best-effort: the row is already
    // `published`, and this runs inside the publish try/catch, so a thrown delete
    // must NOT bubble out and flip the settled row back to `failed`.
    await this.clearPublishingPromptAnchor(sessionId);
    await this.syncPublishProjection(sessionId, {
      publishStatus: "published",
      publishStage: "done",
      publishError: null,
      publishedBranch: branch,
    });
    await runWithSentryTag(
      "publish.upsert_session_pr_metadata",
      () =>
        upsertSessionPrMetadata(this.host.env.DB, {
          sessionId,
          prUrl,
          prNumber,
          prDraft: options.draft === true,
          publishedBranch: branch,
          sourcePromptId: promptId ?? null,
        }),
      this.host.log,
      { message: "Failed to upsert session PR metadata", logFields: { sessionId, prUrl, promptId } },
    );
    await this.host.upsertPrWebhookRef(prUrl, sessionId);
    // Best-effort: this per-session pr_url write stays detached, but a failure
    // must reach Sentry (not a bare `.catch`+log) so the orphan-repair rate is
    // observable. The closed/merged webhook backfills any row left NULL here.
    void runWithSentryTag(
      "publish.update_completion_pr_url",
      // Scope to the publishing prompt's completion so a multi-prompt session
      // opening different PRs does not have every completion's pr_url clobbered.
      // Fall back to the session-wide write only when no prompt id is in scope.
      () =>
        promptId
          ? updateCompletionPrUrlForPrompt(this.host.env.DB, sessionId, promptId, prUrl, options.draft === true)
          : updateCompletionPrUrlForSession(this.host.env.DB, sessionId, prUrl, options.draft === true),
      this.host.log,
      { message: "Failed to update completion pr_url", logFields: { sessionId, promptId } },
    );
  }

  /**
   * ARC-876 resume: best-effort clear of the publishing prompt anchor. Callers
   * run inside the publish try/catch and after the row is already terminal, so a
   * thrown DO-storage delete must never bubble out and flip a settled publish.
   */
  private async clearPublishingPromptAnchor(sessionId: string): Promise<void> {
    try {
      await this.host.state.storage.delete(PUBLISHING_PROMPT_ID_STORAGE_KEY);
    } catch (error) {
      this.host.log.warn(
        { event: "publishing_prompt_anchor_clear_failed", sessionId, error: String(error) },
        "Failed to clear publishing prompt anchor (best-effort)",
      );
    }
  }

  private async setPublishState(
    sessionId: string,
    state: {
      publishStatus?: PublishStatus;
      publishStage?: PublishStage | "done" | null;
      publishError?: string | null;
      publishedBranch?: string | null;
      publishAttempt?: number;
      publishSequence?: number;
    },
  ): Promise<void> {
    // ARC-876: arm/disarm the publishing watchdog atomically with the status
    // transition. Discriminate on the previous publishStatus rather than the
    // raw timestamp — `recordPublishedPr` writes publishStatus="published"
    // directly via doDb.updateSessionFields without nulling
    // publishing_started_at, so a stale timestamp can linger after a
    // successful publish. Re-checking publishStatus on transition guarantees
    // a fresh timestamp on every (re-)entry into `publishing`.
    const watchdogFields: { publishingStartedAt?: number | null } = {};
    // ARC-876 resume: a non-publishing terminal transition clears the publishing
    // prompt anchor so a later resume cannot fire against a settled session.
    const clearPublishingAnchor = state.publishStatus !== undefined && state.publishStatus !== "publishing";
    if (state.publishStatus === "publishing") {
      const existing = doDb.getSessionExtended(this.sql, sessionId);
      if (existing?.publishStatus !== "publishing") {
        watchdogFields.publishingStartedAt = Date.now();
      }
    } else if (state.publishStatus !== undefined) {
      watchdogFields.publishingStartedAt = null;
    }
    doDb.updateSessionFields(this.sql, sessionId, { ...state, ...watchdogFields });
    // Persist the terminal state BEFORE deleting the anchor: if the delete throws,
    // the row is already terminal (so resume's `publishing` guard no longer fires),
    // and a leftover anchor is harmless. Best-effort so an anchor-delete failure
    // never bubbles into the publish try/catch and flips a settled row.
    if (clearPublishingAnchor) {
      await this.clearPublishingPromptAnchor(sessionId);
    }
    await this.syncPublishProjection(sessionId, state);
    if (watchdogFields.publishingStartedAt !== undefined) {
      await this.host.rescheduleSessionAlarm();
    }
  }

  /**
   * ARC-1330 (PR 37) — DUAL-EMIT a publish-path terminal onto the shadow spine: `publish.pr_opened`
   * (PUBLISHING→REVIEW), `publish.no_changes` (→ANSWERED_NO_PR), or `publish.failed` (→FAILED). SHADOW/
   * observe-only — the whole body is try-caught OFF the legacy publish path (the producer dual-emit
   * contract), so a shadow fault is isolated here and never perturbs the live publish. No-op when
   * D1 is unbound (local/test). `prUrl` threads to the resolver for the
   * `publish.pr_opened` `init_record` (design §4 — §5 keeps it off the event payload).
   *
   * A `publish.pr_opened` emit arms the no-signal advance producer (`armContext` threads the owner/repo
   * it needs) for EVERY published PR — a no-CI / configured-but-silent-bot repo has no other carrier to
   * mint MERGE_READY, and arming is sound because the alarm tick only reads the head honestly. It only
   * writes a DO alarm key; the later alarm tick emits through the existing CI producer, never through a
   * bespoke state path. Best-effort: the producer swallows its own faults, so it can never block the emit.
   */
  private async shadowEmitFsmPublishEvent(
    sessionId: string,
    emission: PublishEmission,
    prUrl?: string,
    armContext?: { ownerUserId: number; repoOwner: string; repoName: string },
  ): Promise<void> {
    const db = this.host.env.DB;
    if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
    const deps: ApplyEventDeps = {
      db,
      env: this.host.env,
      now: Date.now,
      resolver: publishShadowResolver(sessionId, prUrl),
      // Real sinks; effect execution defers through the host waitUntil off the publish critical path.
      ...liveFsmSinks(this.host.env, { waitUntil: (promise) => this.host.waitUntil(promise) }),
    };
    // Arm the no-signal advance producer on a pr_opened emit. Fully self-caught (never throws), so it can
    // never block the publish emit; a key written for a publish whose emit then fails is benign.
    if (emission.event.type === "publish.pr_opened" && prUrl && armContext) {
      await armNoSignalAdvanceOnPrOpened(
        this.host.env,
        {
          sessionId,
          prUrl,
          ownerUserId: armContext.ownerUserId,
          repoOwner: armContext.repoOwner,
          repoName: armContext.repoName,
          now: Date.now(),
          armNoSignalAdvanceAlarm: async (deadlineMs) => {
            await this.host.state.storage.put(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY, deadlineMs);
            await this.host.rescheduleSessionAlarm();
          },
        },
        this.host.log,
      );
    }
    try {
      await applyEvent(deps, {
        sessionId,
        event: emission.event,
        metadata: emission.metadata,
        actor: emission.actor,
      });
    } catch (err) {
      this.host.log.warn({ sessionId, error: String(err) }, "fsm publish producer failed (ignored, shadow)");
    }
  }

  private async syncPublishProjection(
    sessionId: string,
    publishState: {
      publishStatus?: PublishStatus | null;
      publishStage?: PublishStage | "done" | null;
      publishError?: string | null;
      publishedBranch?: string | null;
      publishAttempt?: number | null;
      publishSequence?: number | null;
    },
  ): Promise<void> {
    if (!this.host.env.DB || typeof (this.host.env.DB as Partial<D1Database>).prepare !== "function") return;
    // Reproject rich_status atomically with the publish_status write so a
    // completed publish surfaces on `session_index.rich_status` immediately
    // (used by list filtering, child-summary aggregation, and automation
    // concurrency checks). Without this, computePhase changes affect only live
    // single-session reads — projected rows stay stale until some other
    // mutation pushes a fresh richStatus through. setPublishState already
    // wrote the new fields to the DO sql above, so doDb reads here reflect
    // the post-transition state.
    const richStatus = computeRichStatusForPublishProjection(this.sql, sessionId);
    await syncSessionProjection({
      db: this.host.env.DB,
      reportEnv: this.host.env,
      sessionId,
      publishState,
      ...(richStatus !== null ? { richStatus } : {}),
      logger: this.host.log,
      source: "publish-service",
    });
  }

  private async appendEntries(sessionId: string, entries: DurableEntry[], promptId?: string): Promise<void> {
    if (promptId) {
      await this.host.appendAndMirrorEvents(sessionId, entries, promptId);
      return;
    }
    await this.host.appendAndMirrorEvents(sessionId, entries);
  }

  private async failPublish(
    sessionId: string,
    stage: PublishStage,
    error: unknown,
    promptId?: string,
    metadata?: { cause?: string; phase?: "post_execution" | "publishing" },
  ): Promise<PublishResult> {
    const message = stringifyError(error);
    const provenance = readPublishProvenanceTags(this.sql, sessionId);
    this.host.log.warn(
      {
        event: "publish_failed",
        sessionId,
        stage,
        cause: metadata?.cause ?? "thrown",
        ...(metadata?.phase ? { phase: metadata.phase } : {}),
        ...provenance,
        reason: message,
      },
      "Publish failed",
    );
    this.host.waitUntil(
      postStructuredEventToDd(this.host.env, {
        event: "publish_failed",
        session_id: sessionId,
        ...(promptId ? { prompt_id: promptId } : {}),
        stage,
        cause: metadata?.cause ?? "thrown",
        ...(metadata?.phase ? { phase: metadata.phase } : {}),
        ...provenance,
        reason: message,
      }).catch((postError) => {
        this.host.log.warn({ sessionId, stage, error: String(postError) }, "Publish failed event export failed");
        return false;
      }),
    );
    if (stage === "updating_pr") {
      await this.appendEntries(
        sessionId,
        [
          {
            type: "session_error",
            timestamp: nowIso(),
            data: { error: `PR update failed: ${String(error)}`, code: "pr_update" },
          },
        ],
        promptId,
      );
    }
    await this.setPublishState(sessionId, {
      publishStatus: "failed",
      publishStage: stage,
      publishError: message,
    });
    // ARC-1330 (PR 37) shadow: the durable publish-failed terminal → PUBLISHING→FAILED on the spine.
    await this.shadowEmitFsmPublishEvent(sessionId, buildPublishFailedEmission());
    this.host.broadcast({ type: "pr_failed", error: message || "Failed to publish PR" });
    await this.appendEntries(
      sessionId,
      [
        {
          type: "publish.failed",
          timestamp: nowIso(),
          data: {
            sessionId,
            ...(promptId ? { promptId } : {}),
            stage,
            reason: message,
            // ARC-876: distinguish watchdog-induced timeouts from thrown
            // failures so support can pivot on `cause` without parsing the
            // human-readable reason. `phase` records which durable pending
            // state owned the watchdog that fired.
            cause: metadata?.cause ?? "thrown",
            ...(metadata?.phase ? { phase: metadata.phase } : {}),
          },
        },
        {
          type: "pr_failed",
          timestamp: nowIso(),
          data: { sessionId, ...(promptId ? { promptId } : {}), error: `PR creation failed: ${message}` },
        },
        {
          type: "agent_timeline",
          timestamp: nowIso(),
          data: {
            eventType: "pr.open",
            source: "observed",
            observer: "control_plane",
            status: "failed",
            summary: "Pull request publish failed.",
            ...(promptId ? { promptId } : {}),
            metadata: { stage, error: message },
          },
        },
      ],
      promptId,
    );
    return { ok: false, response: jsonErrorResponse(message || "Failed to publish PR", 500) };
  }

  /**
   * ARC-876: watchdog timeout entry point. Forces a terminal `publish.failed`
   * with `cause: "timeout"` and the originating phase so a stuck session
   * cannot stay in `finalizing` forever. Distinct user-visible error so
   * support can tell timeouts from thrown failures at a glance.
   */
  async failPublishOnTimeout(opts: {
    sessionId: string;
    phase: "post_execution" | "publishing";
    stage: PublishStage;
    elapsedMs: number;
    promptId?: string;
  }): Promise<void> {
    await this.withPublishUserSettingsCache(undefined, (settingsCache) =>
      this.failPublishOnTimeoutScoped(opts, settingsCache),
    );
  }

  private async failPublishOnTimeoutScoped(
    opts: {
      sessionId: string;
      phase: "post_execution" | "publishing";
      stage: PublishStage;
      elapsedMs: number;
      promptId?: string;
    },
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<void> {
    const error = new Error(
      `Timed out waiting for ${opts.phase === "post_execution" ? "post-execution" : `publish.${opts.stage}`} after ${opts.elapsedMs}ms`,
    );
    if (opts.phase === "post_execution") {
      const handled = await this.publishPrFromPostExecutionTimeout(opts, error, settingsCache);
      if (handled) return;
    }
    await this.failPublish(opts.sessionId, opts.stage, error, opts.promptId, {
      cause: "timeout",
      phase: opts.phase,
    });
  }

  private async publishPrFromPostExecutionTimeout(
    opts: {
      sessionId: string;
      stage: PublishStage;
      elapsedMs: number;
      promptId?: string;
    },
    timeoutError: Error,
    settingsCache?: UserSettingsCache | undefined,
  ): Promise<boolean> {
    const session = doDb.getSession(this.sql, opts.sessionId);
    const ext = doDb.getSessionExtended(this.sql, opts.sessionId);
    if (!session || !ext) return false;
    // ARC-876: terminals are immutable here. A real PR (prUrl) or a `published`
    // terminal means the work already converged. A prior forced `failed` (e.g. a
    // publishing-watchdog timeout, or a resume that could not progress) must NOT
    // be re-attempted by a late post-execution redelivery — only a redelivery
    // that proves a real PR may upgrade `failed -> published`, and that happens on
    // the normal publish path (marker recovery), never via this timeout recovery.
    if (ext.prUrl || ext.publishStatus === "published" || ext.publishStatus === "failed") return false;

    const branch = ext.lastBranch?.trim();
    if (!branch || (ext.baseBranch && branch === ext.baseBranch)) return false;

    const prompt = opts.promptId ? doDb.getPrompt(this.sql, opts.promptId) : null;
    if (prompt && prompt.status !== "completed") return false;
    if (opts.promptId) {
      const pushOutcome = doDb.getPromptPushOutcome(this.sql, opts.promptId);
      if (pushOutcome?.pushStatus !== "succeeded") return false;
    }

    this.host.log.warn(
      {
        event: "post_execution_timeout_publish_recovery",
        sessionId: opts.sessionId,
        promptId: opts.promptId,
        branch,
        elapsedMs: opts.elapsedMs,
      },
      "Post-execution timed out after a branch was pushed; publishing PR for manual review",
    );

    const verification: ExecutionVerification = {
      verified: false,
      status: "manual_review_required",
      verdict: "INCONCLUSIVE",
      publishMode: "draft",
      manualReviewReason: timeoutError.message,
      explanation:
        "Post-execution publish preparation timed out after the session branch was pushed. Cycloid opened the PR ready for review and marked it for manual attention instead of leaving the session without a pull request.",
      caveats: [timeoutError.message],
    };

    await this.publishSessionResult(
      {
        sessionId: opts.sessionId,
        promptId: opts.promptId,
        branch,
        commitSha: ext.lastCommitSha ?? undefined,
        diffSummary: "Post-execution publish preparation timed out after the session branch was pushed.",
        verification,
        requestedMode: "normal",
      },
      settingsCache,
    );
    return true;
  }

  /**
   * ARC-876: explicit terminal failure when `post_execution` arrived with
   * `pushed !== true`. Previously this branch silently skipped publish and
   * left the session in `finalizing`; now we surface a clear `publish.failed`
   * with `cause` reflecting the push outcome.
   */
  async failPublishOnPushOutcome(opts: {
    sessionId: string;
    cause: "push_failed" | "push_status_unknown";
    pushError?: string | null;
    promptId?: string;
  }): Promise<void> {
    const error = new Error(opts.pushError || "Push did not complete");
    await this.failPublish(opts.sessionId, "pushing", error, opts.promptId, {
      cause: opts.cause,
      phase: "post_execution",
    });
  }

  /**
   * ARC-876 resume: re-drive a publish that stalled mid-flight (e.g. a deploy
   * evicted the DO while it was in `publishing`/`verifying`). Called from three
   * surfaces — bridge reconnect (fast path), the publishing watchdog (backstop),
   * and the alarm wake — all keyed on `publishStatus === "publishing"`.
   *
   * Resume re-runs the REAL publish path (`publishSessionResult`), so the terminal
   * (published / skipped / blocked / failed) is derived exactly as a first-time
   * publish would derive it — never forced from inferred evidence. Idempotency is
   * provided by reconstructing with the ORIGINAL promptId (recovered from the
   * durable anchor), which re-keys the dedup marker, the `create_pr_*` durable
   * step, and the per-prompt single-flight on the interrupted attempt; a genuinely
   * in-flight publish collapses into the existing `inFlightPromptPublishes` entry
   * rather than starting a second publish.
   *
   * The DO is single-threaded per instance, so the `publishStatus === "publishing"`
   * re-read here is a sufficient guard (no CAS needed): a session that already
   * settled is a no-op.
   */
  async resumeStuckPublish(opts: { sessionId: string; trigger: ResumePublishTrigger }): Promise<ResumePublishOutcome> {
    const session = doDb.getSession(this.sql, opts.sessionId);
    const ext = doDb.getSessionExtended(this.sql, opts.sessionId);
    if (!session || !ext) return { resumed: false, reason: "no_session" };
    // Resume is for LIVE sessions only; a closing/closed session is terminalized
    // by the archive cleanup path (`terminalizeDanglingPublishOnClose`), not here.
    if (session.status === "archived") return { resumed: false, reason: "archived" };
    if (ext.publishStatus !== "publishing") return { resumed: false, reason: "not_publishing" };

    // Trim and reject a degenerate branch (whitespace-only, or equal to the base
    // branch) up front — matching the post-execution sibling path — so resume
    // never re-drives a publish that would only fail downstream. The fast path
    // no-ops; the watchdog backstop forces the terminal failure at its deadline.
    const branch = ext.lastBranch?.trim() || undefined;
    if (!branch || (ext.baseBranch && branch === ext.baseBranch)) {
      this.host.log.warn(
        {
          event: "publish_resume_skipped",
          sessionId: opts.sessionId,
          trigger: opts.trigger,
          reason: branch ? "branch_equals_base" : "no_branch",
          priorPublishStatus: "publishing",
          publishStage: ext.publishStage ?? null,
        },
        "Stuck publish resume skipped: no publishable branch",
      );
      return { resumed: false, reason: "no_branch" };
    }

    // Recover the original publishing promptId so marker / durable step /
    // single-flight all key on the interrupted attempt. The durable anchor is the
    // sole authority: it is written BEFORE `publishStatus` becomes `publishing`
    // (see publishSessionResultInner), so any session this guard admits has it.
    // Do NOT fall back to `getActiveProcessingPromptId` — a wedged publish usually
    // has a COMPLETED prompt (so it returns null) or a DIFFERENT processing prompt,
    // either of which would mis-key the marker/step. When the anchor is absent
    // (only a pre-anchor legacy session mid-publish at deploy), resume keys on
    // `no_prompt` and ARC-1014's strongly-consistent head-branch adoption still
    // prevents a duplicate PR.
    const promptId = (await this.host.state.storage.get<string>(PUBLISHING_PROMPT_ID_STORAGE_KEY)) ?? undefined;
    const verification = (await this.host.state.storage.get<ExecutionVerification>("verification")) ?? undefined;
    const prReadiness = (await this.host.state.storage.get<PrReadinessEvidence>(PR_READINESS_STORAGE_KEY)) ?? undefined;

    this.host.log.info(
      {
        event: "publish_resume_started",
        sessionId: opts.sessionId,
        promptId: promptId ?? null,
        trigger: opts.trigger,
        priorPublishStatus: "publishing",
        publishStage: ext.publishStage ?? null,
        publishAttempt: ext.publishAttempt ?? null,
      },
      "Resuming stuck publish",
    );

    const result = await this.publishSessionResult({
      sessionId: opts.sessionId,
      branch,
      commitSha: ext.lastCommitSha ?? undefined,
      verification,
      prReadiness,
      promptId,
      // A `publishing` session already cleared the skip gate, so resume always
      // re-drives a real publish; draft-ness is re-derived from `verification`.
      requestedMode: "normal",
    });

    const nextExt = doDb.getSessionExtended(this.sql, opts.sessionId);
    const resultStatus = result.ok ? result.status : "error";
    this.host.log.info(
      {
        event: "publish_resume_completed",
        sessionId: opts.sessionId,
        promptId: promptId ?? null,
        trigger: opts.trigger,
        resultStatus,
        nextPublishStatus: nextExt?.publishStatus ?? null,
      },
      "Stuck publish resume completed",
    );

    return { resumed: true, status: resultStatus };
  }

  /**
   * ARC-876 resume: archive/close cleanup. A session closed while still
   * `publishing` must not leave a dangling non-terminal row. This does NOT
   * re-drive a publish (the user is closing the session); it terminalizes the row:
   * `published` only when a PR already exists (prUrl), otherwise `failed` with
   * cause `closed_while_publishing`. Returns a no-op when the row is not stuck.
   */
  async terminalizeDanglingPublishOnClose(
    sessionId: string,
    closeReason: string,
  ): Promise<TerminalizePublishOnCloseOutcome> {
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    if (!ext || ext.publishStatus !== "publishing") return { terminalized: false, reason: "not_publishing" };

    // Anchor is the sole authority for the publishing prompt (used here only for
    // terminal-event attribution); no `getActiveProcessingPromptId` fallback, which
    // would mis-attribute to a completed/other prompt. See `resumeStuckPublish`.
    const promptId = (await this.host.state.storage.get<string>(PUBLISHING_PROMPT_ID_STORAGE_KEY)) ?? undefined;

    if (ext.prUrl) {
      // A PR already exists: converge to `published` rather than failing work the
      // user can already see. setPublishState clears the publishing anchor.
      await this.setPublishState(sessionId, {
        publishStatus: "published",
        publishStage: "done",
        publishError: null,
      });
      await this.notifications.emitPublishCompleted(
        sessionId,
        "published",
        promptId,
        ext.prUrl,
        ext.prNumber ?? undefined,
      );
      this.host.log.warn(
        {
          event: "publish_terminalized_on_close",
          sessionId,
          promptId: promptId ?? null,
          priorPublishStatus: "publishing",
          nextPublishStatus: "published",
          reason: closeReason,
        },
        "Terminalized dangling publish on close (PR already existed)",
      );
      return { terminalized: true, status: "published" };
    }

    // No PR yet: force a terminal failure. failPublish writes the failed state
    // (clearing the publishing anchor via setPublishState) and emits the durable
    // publish.failed terminal event.
    const stage = (ext.publishStage ?? "verifying") as PublishStage;
    await this.failPublish(sessionId, stage, new Error("Session closed while publishing"), promptId, {
      cause: "closed_while_publishing",
      phase: "publishing",
    });
    this.host.log.warn(
      {
        event: "publish_terminalized_on_close",
        sessionId,
        promptId: promptId ?? null,
        priorPublishStatus: "publishing",
        nextPublishStatus: "failed",
        reason: closeReason,
      },
      "Terminalized dangling publish on close (no PR; forced failed)",
    );
    return { terminalized: true, status: "failed" };
  }
}
