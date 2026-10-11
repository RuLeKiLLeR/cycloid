import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend";
import {
  DEFAULT_AGENT_NAME,
  isQaTesterAgentRole,
  resolveAgentRuntimeMetadata,
} from "../../../../shared/agent/constants";
import type { AgentRuntimeMetadata } from "../../../../shared/agent/schema";
import { parseQaDirectiveFromText, resolveQaTargetPullRequestUrl } from "../../../../shared/agent/verify-directive";
import { MAX_UPLOADED_IMAGE_SIZE_BYTES, MAX_UPLOADED_IMAGES } from "../../../../shared/constants/uploads";
import { PROMPT_SEND_BLOCKED_ERROR } from "../../../../shared/session/eligibility";
import type { UploadedImage } from "../../../../shared/types/sandbox";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  acceptUploadedImagePayload,
  arrayBufferToBase64,
  isSupportedImageMimeType,
  trimUploadedImagesToPromptBudget,
} from "../../../../shared/utils/uploads";
import { getUserByGithubId, resolveInternalFeatureGateUser } from "../auth/db";
import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { claimGithubCheckJob, listMatchingGithubCheckRules } from "../automation/github-check-db";
import { recordGithubPrMemoryIngestion } from "../company-memory/service";
import { MEMORY_BRANCH_PREFIX } from "../constants/memory";
import { SessionEntrypoint } from "../enums/session-entrypoint";
import {
  deleteCachedInstallationRepos,
  deleteInstallation,
  getConflictingInstallationByOwner,
  isInstallationOwnerUniqueConstraintError,
  replaceConflictingInstallation,
  suspendInstallation,
  unsuspendInstallation,
  updateInstallationPermissions,
  upsertInstallation,
} from "../github/installations-db";
import {
  GITHUB_QA_STARTED_REACTION,
  type GithubIssueCommentReactionContent,
  postIssueComment,
  postIssueCommentReaction,
} from "../github/issues";
import { createInstallationToken, getAppSlug, invalidateInstallationTokenCache } from "../github/octokit";
import {
  type CommitCiStatus,
  FAILING_CHECK_RUN_CONCLUSIONS,
  getCommitCiStatus,
  getPrCommitShas,
  getPrHeadSha,
  getPrReviewComments,
  getPrState,
  getPullRequestsForCommit,
  GITHUB_API,
  githubHeaders,
  isNoOpHeadTreeChange,
} from "../github/pr";
import { ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET, normalizeGitHubActorLogin } from "../github/pr-review-bots";
import { actorCanWriteToRepo, getActorRepoPermissionLevel } from "../github/repo-permission";
import { githubPullRequestUrlMatchesRepo, parseGithubPullRequestUrl } from "../github/verification-pr-context";
import { createLogger } from "../logger";
import { createMemoryAnalysisJob } from "../memory/db";
import type { MemoryAnalysisJobParams } from "../memory/service";
import { setSpanAttributes } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { emitReviewLoopTruncatedTailRekeyedMetric } from "../observability/pr-metrics";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { tracedFetch } from "../observability/wrappers";
import { syncFsmLabelsForPr } from "../services/fsm-label-sync";
import { bootstrapMentionSession } from "../services/github-mention-bootstrap";
import { isCycloidMember } from "../services/internal-feature-gate";
import { isOpencodeAccessDeniedError } from "../services/opencode-access-gate";
import { spawnPrReviewTrigger } from "../services/pr-review-trigger-spawn";
import { ProviderCredentialNotValidatedError } from "../services/provider-credential-gate";
import { resolvePublicAppBaseUrl, resolvePublicSessionUrl } from "../services/public-url";
import { bumpReposInstallationVersion } from "../services/repos";
import { emitReviewLoopCiSignalFromWebhook } from "../services/review-loop-ci-signal";
import {
  bootstrapMentionEpoch,
  ingestReviewLoopCheckRunWebhook,
  ingestReviewLoopCiFailureWebhook,
  ingestReviewLoopCommitStatusWebhook,
  ingestReviewLoopPrIssueCommentWebhook,
  ingestReviewLoopPullRequestReviewCommentWebhook,
  ingestReviewLoopPullRequestReviewWebhook,
} from "../services/review-loop-epochs";
import { reconcileReviewLoopEpochsForHeadChange } from "../services/review-loop-head-change";
import {
  selectReviewLoopIssueCommentReplyGithubIds,
  selectReviewLoopReplyGithubIds,
} from "../services/review-loop-operations";
import type { ReviewEventLite } from "../services/review-loop-reengage";
import { ensureSessionLiveForPr, reengageSessionForReview } from "../services/review-loop-reengage";
import { dispatchReviewLoopEpoch } from "../services/review-loop-sweep";
import { resolveSessionContinuation } from "../services/session-continuation";
import { resolveBaseModelForAutomaticRouting, resolveVerificationModel } from "../services/session-model-routing";
import { syncSessionProjection } from "../services/session-projection";
import {
  type CompletionOutcomeUpdate,
  findCompletionsForSessionsPr,
  updateCompletionOutcomes,
} from "../session/completions-db";
import { emitWebhookPrTerminal } from "../session/fsm/cron-producer";
import { classifyHeadChange, shadowEmitHeadChange } from "../session/fsm/head-producer";
import { dispatchHumanGithubPrActionAlert } from "../session/human-github-pr-action-alert";
import { getTrackingSessionIdForPrUrl } from "../session/pr-coordination-db";
import { reconcilePrDraftStateForPr } from "../session/pr-draft-reconciliation";
import { toPublicEnqueueDispatch, toPublicEnqueuedPrompt } from "../session/prompt-response";
import { emitReviewListeningEntered } from "../session/publish-service";
import {
  closeSessionForWebhook,
  createSessionState,
  enqueueSessionPrompt,
  getSessionState,
  notifySessionPrClosed,
  notifySessionPrMerged,
  updateSessionReviewListeningHead,
} from "../session/state";
import { requestCoordinatedVerification } from "../session/verification-coordinator-service";
import { syncVerificationStateForPr } from "../session/verification-state";
import type { CallbackContext, Env } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse, normalizeWebhookReference } from "../utils";
import { GITHUB_WEBHOOK_MAX_BYTES, readCappedWebhookBody } from "./body-limit";
import {
  buildWebhookIdempotencyKey,
  claimSessionWebhookRef,
  claimWebhookIdempotency,
  listSessionIdsByWebhookRef,
  releaseWebhookIdempotencyClaim,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_ISSUE,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "./db";
import { extractCycloidReviewTrigger } from "./github-review-trigger";
import { capturePrActivityEvent, isCapturedPrActivityEventType } from "./pr-activity-capture";
import { buildGithubIssuePrompt, renderReviewBodyMentionInlineComments } from "./prompts";
import { scheduleReviewAckReaction } from "./review-ack-reaction";
import { extractCommonWebhookActor, extractGithubUserActor, extractRepoAndInstallation, recordField } from "./shared";
import { verifyGithubWebhookSignature } from "./verify";

const log = createLogger({ bindings: { component: "webhooks" } });

const WEBHOOK_SOURCE_GITHUB = "github";

export async function handleGithubWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) {
    return jsonErrorResponse("Missing signature", 401);
  }

  const bodyResult = await readCappedWebhookBody(request, GITHUB_WEBHOOK_MAX_BYTES);
  if (bodyResult instanceof Response) return bodyResult;
  const rawBody = bodyResult;
  const valid = await verifyGithubWebhookSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET || "");
  if (!valid) {
    return jsonErrorResponse("Invalid signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonErrorResponse("Invalid JSON", 400);
  }

  const eventType = request.headers.get("x-github-event");

  // Attribute webhook latency by event type (and action when present) on the worker.fetch root span
  // so the 2.3%>1s tail can be split per event. setSpanAttributes mutates the active span context,
  // which the router's endSpan(rootSpan, ...) reads. Cheap: header read + a parsed-body field.
  setSpanAttributes({
    "github.event": eventType ?? "none",
    ...(typeof payload.action === "string" ? { "github.action": payload.action } : {}),
  });

  // Durable PR-conversation capture (migration 0248), before the per-handler
  // action/allow-list filters so edits/deletes/approvals/dropped-bot comments on
  // tracked PRs are all captured. Passive tap: reads pr_coordination + writes
  // pr_activity_events; no effect on the handler's own claim/FSM path. A transient
  // D1 error propagates so GitHub redelivers (idempotent on delivery_id).
  if (isCapturedPrActivityEventType(eventType)) {
    await capturePrActivityEvent({ env, eventType: eventType as string, payload, request });
  }

  switch (eventType) {
    case "check_run":
      return handleCheckRunEvent(payload, rawBody, request, env, ctx);
    case "installation":
      return handleInstallationEvent(payload, rawBody, request, env);
    case "installation_repositories":
      return handleInstallationRepositoriesEvent(payload, rawBody, request, env);
    case "issue_comment":
      return handleIssueCommentEvent(payload, rawBody, request, env, ctx);
    case "pull_request":
      return handlePullRequestEvent(payload, rawBody, request, env, ctx);
    case "pull_request_review":
      return handlePullRequestReviewEvent(payload, rawBody, request, env, ctx);
    case "pull_request_review_comment":
      return handlePullRequestReviewCommentEvent(payload, rawBody, request, env, ctx);
    case "push":
      return handlePushEvent(payload, rawBody, request, env);
    case "status":
      return handleStatusEvent(payload, rawBody, request, env, ctx);
    default:
      return jsonResponse({ ok: true, skipped: true });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function previewText(value: unknown, maxChars = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function extractPromptFromIssueComment(
  commentBody: unknown,
  appSlug: string,
): { mentioned: boolean; prompt: string | null } {
  if (typeof commentBody !== "string") return { mentioned: false, prompt: null };

  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegex(appSlug)}(?=$|\\s|[.,:;!?])`, "i");
  const match = mentionPattern.exec(commentBody);
  if (!match) return { mentioned: false, prompt: null };

  const prompt = commentBody
    .slice(match.index + match[0].length)
    .replace(/^[\s,.:;\-]+/, "")
    .trim();

  return { mentioned: true, prompt: prompt.length > 0 ? prompt : null };
}

function parseGithubInstallationPermissions(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const permissions: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") permissions[key] = value;
  }
  return permissions;
}

function parseGithubInstallationEvents(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((event): event is string => typeof event === "string");
}

function buildGithubIssueSessionComment(sessionId: string, frontendUrl: string, repoPrivate?: boolean): string {
  if (repoPrivate === false) {
    return "Started a Cycloid session for this issue.";
  }
  return `Started a Cycloid session for this issue.\n\n[View session](${frontendUrl}/sessions/${sessionId})`;
}

function buildDuplicateVerificationSessionComment(sessionId: string, env: Env, repoPrivate?: boolean): string {
  if (repoPrivate === false) {
    return "A verification session is already running for this pull request.";
  }
  return `A verification session is already running for this pull request: ${resolvePublicSessionUrl(env, sessionId)}`;
}

async function enqueueIssueSessionPrompt(
  env: Env,
  db: D1Database,
  sessionId: string,
  prompt: string,
  actorUserId: string,
  issueNumber: number,
): Promise<Response> {
  const session = await getSessionState(env, sessionId);
  if (!session) {
    log.warn({ sessionId, issueNumber }, "GitHub issue follow-up skipped: session not found");
    return jsonResponse({ ok: true, skipped: true, reason: "session_not_found", sessionId });
  }

  const enqueueResult = await enqueueSessionPrompt(env, sessionId, prompt, actorUserId);
  if (!enqueueResult.ok || !enqueueResult.payload) {
    switch (enqueueResult.error) {
      case PROMPT_SEND_BLOCKED_ERROR:
        log.warn(
          { sessionId, issueNumber, reason: enqueueResult.reason ?? null },
          "GitHub issue follow-up skipped: session not sendable",
        );
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: enqueueResult.reason ?? "session_not_sendable",
          sessionId,
        });
      default: {
        const err = new Error(`Session DO prompt enqueue failed with status ${enqueueResult.status}`);
        await runWithSentryTag(
          "handleIssueCommentEvent.enqueue",
          () => Promise.reject(err),
          log.child({ sessionId, issueNumber }),
        );
        throw err;
      }
    }
  }

  try {
    await syncSessionProjection({
      db,
      sessionId,
      session: enqueueResult.payload.session,
      replay: enqueueResult.payload.replay,
      logger: log,
      source: "webhooks.github.issueFollowup.enqueue",
      userId: actorUserId,
    });
  } catch (err) {
    await runWithSentryTag(
      "handleIssueCommentEvent.sync",
      () => Promise.reject(err),
      log.child({ sessionId, issueNumber }),
    );
    throw err;
  }
  log.info({ sessionId, issueNumber }, "GitHub issue follow-up enqueued");
  return jsonResponse({
    ok: true,
    created: false,
    sessionId,
    enqueued: true,
    prompt: toPublicEnqueuedPrompt(enqueueResult.payload.prompt),
    dispatch: toPublicEnqueueDispatch(enqueueResult.payload.dispatch),
  });
}

interface GithubIssueCommentDetails {
  deliveryId: string | null;
  commentId: number | null;
  commentBody: unknown;
  commentPreview: string | null;
  issueId: number | null;
  issueNumber: number | null;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  issueUrl: string | null;
  issueIsPullRequest: boolean;
  repoOwner: string | null;
  repoName: string | null;
  repoPrivate?: boolean;
  repositoryUrl: string | null;
  installationId: number | null;
  senderId: number | null;
  senderLogin: string | null;
  senderType: string;
}

interface AuthorizedGithubIssueCommentDetails extends GithubIssueCommentDetails {
  issueId: number;
  issueNumber: number;
  issueUrl: string;
  repoOwner: string;
  repoName: string;
  repositoryUrl: string;
  installationId: number;
}

interface IssueCommentPromptContext {
  followUpPrompt: string;
  bootstrapPrompt: string;
  externalIssueRef: string;
  agentRuntime: AgentRuntimeMetadata;
  uploadedImages: UploadedImage[];
}

interface GithubIssuePromptComment {
  id: number | null;
  body: string;
  authorName: string;
}

type IssueCommentParseResult = { ok: true; details: GithubIssueCommentDetails } | { ok: false; response: Response };

const GITHUB_ISSUE_CONTEXT_TIMEOUT_MS = 5_000;
const GITHUB_ISSUE_CONTEXT_COMMENT_LIMIT = 5;
const GITHUB_MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

function parseGithubIssueComments(body: unknown): GithubIssuePromptComment[] | null {
  if (!Array.isArray(body)) return null;
  return body.flatMap((comment) => {
    if (!comment || typeof comment !== "object") return [];
    const record = comment as Record<string, unknown>;
    if (typeof record.body !== "string" || record.body.trim().length === 0) return [];
    const user = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : null;
    const authorName = normalizeWebhookReference(user?.login) ?? "github_user";
    return [{ id: typeof record.id === "number" ? record.id : null, body: record.body, authorName }];
  });
}

async function fetchGithubIssueComments(params: {
  token: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
}): Promise<GithubIssuePromptComment[]> {
  const { token, repoOwner, repoName, issueNumber } = params;
  try {
    const response = await tracedFetch(
      `${GITHUB_API}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/issues/${issueNumber}/comments?per_page=${GITHUB_ISSUE_CONTEXT_COMMENT_LIMIT}&sort=created&direction=desc`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_ISSUE_CONTEXT_TIMEOUT_MS),
      },
      "github.issueCommentsFetch",
    );
    if (!response.ok) {
      log.warn({ repoOwner, repoName, issueNumber, status: response.status }, "GitHub issue comments fetch failed");
      return [];
    }
    const comments = parseGithubIssueComments(await response.json());
    if (!comments) {
      log.warn({ repoOwner, repoName, issueNumber }, "GitHub issue comments fetch returned unexpected shape");
      return [];
    }
    return [...comments].reverse();
  } catch (error) {
    log.warn({ repoOwner, repoName, issueNumber, error: String(error) }, "GitHub issue comments fetch failed");
    return [];
  }
}

function isSafeGithubIssueImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "github.com" || host === "user-images.githubusercontent.com" || host === "raw.githubusercontent.com"
    );
  } catch {
    return false;
  }
}

function githubImageName(rawUrl: string, index: number): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    const rawName = pathname.split("/").filter(Boolean).at(-1) ?? `github-issue-image-${index + 1}`;
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
    return safeName.includes(".") ? safeName : `${safeName}.png`;
  } catch {
    return `github-issue-image-${index + 1}.png`;
  }
}

function extractGithubIssueImageUrls(markdownValues: readonly string[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const markdown of markdownValues) {
    for (const match of markdown.matchAll(GITHUB_MARKDOWN_IMAGE_REGEX)) {
      const url = match[1] ?? match[2];
      if (!url || seen.has(url) || !isSafeGithubIssueImageUrl(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= MAX_UPLOADED_IMAGES) return urls;
    }
  }
  return urls;
}

async function readGithubIssueImageBuffer(response: Response, imageUrl: string): Promise<ArrayBuffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
    log.warn({ imageUrl, contentLength }, "GitHub issue image skipped: oversize");
    return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
    log.warn({ imageUrl, byteLength: buffer.byteLength }, "GitHub issue image skipped: oversize");
    return null;
  }
  return buffer;
}

async function fetchGithubIssueImage(params: {
  token: string;
  imageUrl: string;
  index: number;
  signal: AbortSignal;
}): Promise<UploadedImage | null> {
  const { token, imageUrl, index, signal } = params;
  try {
    const response = await tracedFetch(
      imageUrl,
      {
        headers: githubHeaders(token),
        signal,
      },
      "github.issueImageFetch",
    );
    if (!response.ok) {
      log.warn({ imageUrl, status: response.status }, "GitHub issue image fetch failed");
      return null;
    }
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isSupportedImageMimeType(mediaType)) {
      log.warn({ imageUrl, mediaType }, "GitHub issue image skipped: unsupported media type");
      return null;
    }
    const buffer = await readGithubIssueImageBuffer(response, imageUrl);
    if (!buffer) return null;
    return { name: githubImageName(imageUrl, index), mediaType, data: arrayBufferToBase64(buffer) };
  } catch (error) {
    log.warn({ imageUrl, error: String(error) }, "GitHub issue image fetch failed");
    return null;
  }
}

async function fetchGithubIssueImages(params: {
  token: string;
  issueBody: string;
  comments: readonly GithubIssuePromptComment[];
}): Promise<UploadedImage[]> {
  const imageUrls = extractGithubIssueImageUrls([params.issueBody, ...params.comments.map((comment) => comment.body)]);
  const uploadedImages: UploadedImage[] = [];
  const signal = AbortSignal.timeout(GITHUB_ISSUE_CONTEXT_TIMEOUT_MS);
  const candidates = await Promise.all(
    imageUrls.map((imageUrl, index) => fetchGithubIssueImage({ token: params.token, imageUrl, index, signal })),
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const accepted = acceptUploadedImagePayload(candidate, uploadedImages);
    if (!accepted.ok) {
      log.warn({ imageUrl: imageUrls[index], code: accepted.code }, "GitHub issue image skipped: invalid payload");
      continue;
    }
    uploadedImages.push(accepted.image);
  }
  return uploadedImages;
}

function parseGithubIssueCommentEvent(payload: Record<string, unknown>, request: Request): IssueCommentParseResult {
  if (payload.action !== "created") {
    log.info({ action: payload.action }, "Skipping GitHub issue comment: unsupported action");
    return { ok: false, response: jsonResponse({ ok: true, skipped: true, reason: "unsupported_action" }) };
  }

  const issue = payload.issue as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;
  if (!issue || !comment || !repository || !sender) {
    log.warn({}, "Skipping GitHub issue comment: missing payload fields");
    return { ok: false, response: jsonErrorResponse("Missing issue comment payload", 400) };
  }

  const { repoOwner, repoName, repoPrivate, repositoryUrl, installationId } = extractRepoAndInstallation(
    payload,
    repository,
  );
  const { senderId, senderLogin, senderType } = extractCommonWebhookActor(payload);
  const details: GithubIssueCommentDetails = {
    deliveryId: normalizeWebhookReference(request.headers.get("x-github-delivery")),
    commentId: typeof comment.id === "number" ? comment.id : null,
    commentBody: comment.body,
    commentPreview: previewText(comment.body),
    issueId: typeof issue.id === "number" ? issue.id : null,
    issueNumber: typeof issue.number === "number" ? issue.number : null,
    issueTitle: typeof issue.title === "string" ? issue.title : "",
    issueBody: typeof issue.body === "string" ? issue.body : "",
    issueLabels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => {
            if (typeof label === "string") return label;
            if (label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
              return (label as { name: string }).name;
            }
            return null;
          })
          .filter((label): label is string => Boolean(label))
      : [],
    issueUrl: normalizeWebhookReference(issue.html_url),
    issueIsPullRequest: Boolean(issue.pull_request),
    repoOwner,
    repoName,
    repoPrivate,
    repositoryUrl,
    installationId,
    senderId,
    senderLogin,
    senderType,
  };

  log.info(
    {
      deliveryId: details.deliveryId,
      commentId: details.commentId,
      issueId: details.issueId,
      issueNumber: details.issueNumber,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      installationId: details.installationId,
      senderLogin: details.senderLogin,
      senderType: details.senderType,
      commentPreview: details.commentPreview,
    },
    "Received GitHub issue comment webhook",
  );

  return { ok: true, details };
}

function filterGithubIssueCommentActor(details: GithubIssueCommentDetails, appSlug: string): Response | null {
  if (details.senderType !== "User") {
    log.warn(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        issueNumber: details.issueNumber,
        senderLogin: details.senderLogin,
        senderType: details.senderType,
      },
      "Skipping GitHub issue comment: non-user sender",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "non_user_sender" });
  }

  if (details.senderLogin?.toLowerCase() === appSlug.toLowerCase()) {
    log.warn(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        issueNumber: details.issueNumber,
        senderLogin: details.senderLogin,
        appSlug,
      },
      "Skipping GitHub issue comment: self-trigger",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "self_trigger" });
  }

  return null;
}

function isCycloidReplyBotSender(senderLogin: string | null, senderType: string): boolean {
  if (senderType === "User" || !senderLogin) return false;
  const normalized = normalizeGitHubActorLogin(senderLogin);
  // Intentionally narrower than ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET: cycloid-qa stays routed through ingest.
  // Add any future Cycloid-owned PR reply bot here if its issue comments should not re-enter review-loop.
  return normalized === "cycloid" || normalized === "cycloid-dev" || normalized === "cycloid-staging";
}

function resolveGithubIssueCommentMention(
  details: GithubIssueCommentDetails,
  appSlug: string,
): { ok: true; prompt: string | null } | { ok: false; response: Response } {
  const issueComment = extractPromptFromIssueComment(details.commentBody, appSlug);
  if (!issueComment.mentioned) {
    log.warn(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        issueNumber: details.issueNumber,
        repoOwner: details.repoOwner,
        repoName: details.repoName,
        senderLogin: details.senderLogin,
        appSlug,
        commentPreview: details.commentPreview,
      },
      "Skipping GitHub issue comment: mention missing",
    );
    return { ok: false, response: jsonResponse({ ok: true, skipped: true, reason: "mention_missing" }) };
  }

  return { ok: true, prompt: issueComment.prompt };
}

function validateGithubIssueCommentMetadata(
  details: GithubIssueCommentDetails,
): { ok: true; details: AuthorizedGithubIssueCommentDetails } | { ok: false; response: Response } {
  if (
    !details.issueId ||
    !details.issueNumber ||
    !details.issueUrl ||
    !details.repoOwner ||
    !details.repoName ||
    !details.repositoryUrl ||
    !details.installationId
  ) {
    log.error(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        issueId: details.issueId,
        issueNumber: details.issueNumber,
        repoOwner: details.repoOwner,
        repoName: details.repoName,
        installationId: details.installationId,
        issueUrl: details.issueUrl,
      },
      "GitHub issue comment rejected: missing issue metadata",
    );
    return { ok: false, response: jsonErrorResponse("Missing issue metadata", 400) };
  }

  return {
    ok: true,
    details: {
      ...details,
      issueId: details.issueId,
      issueNumber: details.issueNumber,
      issueUrl: details.issueUrl,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      repositoryUrl: details.repositoryUrl,
      installationId: details.installationId,
    },
  };
}

async function resolveGithubIssueCommentActor(
  env: Env,
  details: AuthorizedGithubIssueCommentDetails,
  appSlug: string,
  extractedPrompt: string | null,
): Promise<{ ok: true; actorUserId: string } | { ok: false; response: Response }> {
  if (!details.senderId) {
    log.warn(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        issueNumber: details.issueNumber,
        senderLogin: details.senderLogin,
      },
      "Skipping GitHub issue comment: unknown sender",
    );
    return { ok: false, response: jsonResponse({ ok: true, skipped: true, reason: "github_user_not_connected" }) };
  }

  const actor = await getUserByGithubId(env.DB, details.senderId);
  if (!actor) {
    log.warn(
      {
        deliveryId: details.deliveryId,
        commentId: details.commentId,
        githubUserId: details.senderId,
        senderLogin: details.senderLogin,
        issueNumber: details.issueNumber,
      },
      "Skipping GitHub issue comment: GitHub user not connected",
    );
    return { ok: false, response: jsonResponse({ ok: true, skipped: true, reason: "github_user_not_connected" }) };
  }

  const actorUserId = String(actor.id);
  log.info(
    {
      deliveryId: details.deliveryId,
      commentId: details.commentId,
      issueId: details.issueId,
      issueNumber: details.issueNumber,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      senderLogin: details.senderLogin,
      githubUserId: details.senderId,
      actorUserId,
      appSlug,
      promptPreview: previewText(extractedPrompt),
    },
    "GitHub issue comment mention resolved",
  );

  return { ok: true, actorUserId };
}

async function authorizeGithubIssueCommentActor(
  env: Env,
  details: AuthorizedGithubIssueCommentDetails,
  actorUserId: string,
): Promise<Response | null> {
  let hasAccess: boolean;
  try {
    hasAccess = await verifyUserRepoAccess(env.DB, actorUserId, details.repoOwner, details.repoName, {
      githubTokenEnv: env,
    });
  } catch (err) {
    log.error(
      {
        deliveryId: details.deliveryId,
        issueNumber: details.issueNumber,
        repoOwner: details.repoOwner,
        repoName: details.repoName,
        userId: actorUserId,
        error: String(err),
      },
      "GitHub issue session skipped: repo access verification unavailable",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "repo_access_verification_failed" });
  }

  if (!hasAccess) {
    log.warn(
      {
        deliveryId: details.deliveryId,
        issueNumber: details.issueNumber,
        repoOwner: details.repoOwner,
        repoName: details.repoName,
        userId: actorUserId,
      },
      "GitHub issue session rejected: user does not have GitHub access to repo",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "repo_not_authorized" });
  }

  return null;
}

function buildIssueCommentPromptContext(
  details: AuthorizedGithubIssueCommentDetails,
  extractedPrompt: string | null,
  issueComments: readonly GithubIssuePromptComment[] = [],
  uploadedImages: readonly UploadedImage[] = [],
): IssueCommentPromptContext {
  const issueRef = `${details.repoOwner}/${details.repoName}#${details.issueNumber}`;
  const qaDirective = parseQaDirectiveFromText(extractedPrompt);
  const normalizedPrompt = qaDirective.qa ? qaDirective.text || null : extractedPrompt;
  const targetPrUrlSelection = resolveQaTargetPullRequestUrl(extractedPrompt, {
    currentPrUrl: details.issueIsPullRequest ? details.issueUrl : null,
  });
  const targetPrUrl = targetPrUrlSelection.status === "selected" ? targetPrUrlSelection.targetPrUrl : null;
  const agentRuntime = resolveAgentRuntimeMetadata({
    qa: qaDirective.qa,
    targetPrUrl,
  });
  const fallbackPrompt = buildGithubIssuePrompt({
    repoUrl: details.repositoryUrl,
    issueRef,
    issueUrl: details.issueUrl,
    issueTitle: details.issueTitle,
    issueBody: details.issueBody,
    issueComments,
    includeOutputContract: false,
  });
  return {
    followUpPrompt: normalizedPrompt ?? fallbackPrompt,
    bootstrapPrompt: buildGithubIssuePrompt({
      repoUrl: details.repositoryUrl,
      issueRef,
      issueUrl: details.issueUrl,
      issueTitle: details.issueTitle,
      issueBody: details.issueBody,
      issueComments,
      commentBody: normalizedPrompt,
      includeOutputContract: true,
    }),
    externalIssueRef: String(details.issueId),
    agentRuntime,
    uploadedImages: [...uploadedImages],
  };
}

async function routeGithubIssueCommentToExistingSession(
  env: Env,
  details: AuthorizedGithubIssueCommentDetails,
  promptContext: IssueCommentPromptContext,
  actorUserId: string,
): Promise<Response | null> {
  const existingSessionIds = await listSessionIdsByWebhookRef(
    env.DB,
    SESSION_WEBHOOK_REF_SOURCE_GITHUB_ISSUE,
    promptContext.externalIssueRef,
  );
  if (existingSessionIds.length === 0) return null;

  log.info(
    {
      deliveryId: details.deliveryId,
      issueNumber: details.issueNumber,
      issueId: details.issueId,
      existingSessionId: existingSessionIds[0],
      existingSessionCount: existingSessionIds.length,
    },
    "GitHub issue comment matched existing session",
  );
  return enqueueIssueSessionPrompt(
    env,
    env.DB,
    existingSessionIds[0],
    promptContext.followUpPrompt,
    actorUserId,
    details.issueNumber,
  );
}

function scheduleGithubIssueSessionComment(
  env: Env,
  executionCtx: ExecutionContext | undefined,
  details: AuthorizedGithubIssueCommentDetails,
  sessionId: string,
): void {
  const frontendUrl = resolvePublicAppBaseUrl(env);
  const issueCommentTask = postIssueComment(
    env,
    details.installationId,
    details.repoOwner,
    details.repoName,
    details.issueNumber,
    buildGithubIssueSessionComment(sessionId, frontendUrl, details.repoPrivate),
  ).catch((err) => {
    log.error(
      {
        deliveryId: details.deliveryId,
        error: String(err),
        sessionId,
        issueNumber: details.issueNumber,
        repoOwner: details.repoOwner,
        repoName: details.repoName,
        commentId: details.commentId,
      },
      "Failed to post GitHub issue session comment",
    );
  });
  if (executionCtx) executionCtx.waitUntil(issueCommentTask);
}

function scheduleGithubIssueCommentReaction(
  env: Env,
  executionCtx: ExecutionContext | undefined,
  context: Extract<CallbackContext, { source: "github_qa_issue_comment" }>,
  content: GithubIssueCommentReactionContent,
): void {
  const reactionTask = postIssueCommentReaction(
    env,
    context.installationId,
    context.repoOwner,
    context.repoName,
    context.commentId,
    content,
  ).catch((err) => {
    log.warn(
      {
        error: String(err),
        repoOwner: context.repoOwner,
        repoName: context.repoName,
        issueNumber: context.issueNumber,
        commentId: context.commentId,
        targetPrUrl: context.targetPrUrl,
        reaction: content,
      },
      "Failed to post GitHub QA issue-comment reaction",
    );
  });
  if (executionCtx) executionCtx.waitUntil(reactionTask);
}

export type VerifierParentRuntime = {
  sessionId: string;
  model: string | null;
  agentRuntimeBackend: AgentRuntimeBackend | null;
};

/**
 * Find the model/backend pair the originating implementation session for
 * `prUrl` ran on, so a comment-triggered verifier can inherit that runtime.
 *
 * Unlike the review-loop-done auto path (which loads the parent by id), a
 * `qa=true` or legacy `verify = true` comment usually arrives AFTER the review loop finished and
 * cleared `reviewListeningActive`, so this intentionally does NOT use
 * `isImplementationSessionForPr` (which requires active listening). It matches any
 * non-archived implementation session registered for the PR.
 *
 * `listSessionIdsByWebhookRef` orders by `session_id`, not recency, so when a PR
 * has several implementation sessions (e.g. a later re-run on a different
 * backend/model) we pick the most recently CREATED one — its runtime reflects
 * the current state of the PR, not an arbitrary earlier run. Returns null when
 * none resolves; the caller then falls back to the default verifier runtime.
 */
export async function resolveVerifierParentRuntimeForPr(
  env: Env,
  prUrl: string,
  logger: typeof log = log,
): Promise<VerifierParentRuntime | null> {
  try {
    const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
    let latest: {
      sessionId: string;
      createdAtMs: number;
      model: string | null;
      agentRuntimeBackend: AgentRuntimeBackend | null;
    } | null = null;
    const sessions = await Promise.all(sessionIds.map((sessionId) => getSessionState(env, sessionId)));
    for (const [index, session] of sessions.entries()) {
      if (!session || session.agentRole !== "implementation" || session.status === "archived") continue;
      const parsed = Date.parse(session.createdAt);
      const createdAtMs = Number.isFinite(parsed) ? parsed : 0;
      if (!latest || createdAtMs > latest.createdAtMs) {
        latest = {
          sessionId: sessionIds[index],
          createdAtMs,
          model: session.model ?? null,
          agentRuntimeBackend: session.agentRuntimeBackend ?? null,
        };
      }
    }
    return latest
      ? { sessionId: latest.sessionId, model: latest.model, agentRuntimeBackend: latest.agentRuntimeBackend }
      : null;
  } catch (error) {
    logger.warn(
      { targetPrUrl: prUrl, error: String(error) },
      "Failed to resolve originating session for verifier runtime; using default verifier runtime",
    );
  }
  return null;
}

async function bootstrapGithubIssueSession(
  env: Env,
  details: AuthorizedGithubIssueCommentDetails,
  promptContext: IssueCommentPromptContext,
  actorUserId: string,
  executionCtx?: ExecutionContext,
  options?: {
    webhookRefSource?: string;
    webhookExternalRef?: string;
    postSessionComment?: boolean;
    verificationAttemptCount?: number | null;
    sessionIdOverride?: string;
    // Verification only: the originating (built) session's backend/model, so the
    // verifier inherits the same valid runtime. When omitted (e.g. ordinary
    // issue-comment build sessions), the default verifier runtime is used.
    verifierParentRuntime?: VerifierParentRuntime | null;
    // Fired once the session is durably live (prompt enqueued + projected),
    // before any post-enqueue side effects that may throw. The verifier lock
    // owner uses this to know the verifier started (ARC-1173).
    onPromptEnqueued?: (sessionId: string) => Promise<void>;
    callbackContext?: CallbackContext;
  },
): Promise<Response> {
  // Verification paths pre-mint the session id so it can be the per-PR lock
  // holder before this bootstrap runs (ARC-1173).
  const sessionId = options?.sessionIdOverride ?? crypto.randomUUID();
  const webhookRefSource = options?.webhookRefSource ?? SESSION_WEBHOOK_REF_SOURCE_GITHUB_ISSUE;
  const webhookExternalRef = options?.webhookExternalRef ?? promptContext.externalIssueRef;
  const claimed = await claimSessionWebhookRef(env.DB, webhookRefSource, webhookExternalRef, sessionId);
  if (!claimed) {
    const winnerSessionIds = await listSessionIdsByWebhookRef(env.DB, webhookRefSource, webhookExternalRef);
    if (winnerSessionIds.length === 0) {
      log.warn(
        {
          deliveryId: details.deliveryId,
          issueNumber: details.issueNumber,
          issueId: details.issueId,
          attemptedSessionId: sessionId,
        },
        "GitHub issue session claim lost but no winner session found",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "session_claim_lost" });
    }
    log.info(
      {
        deliveryId: details.deliveryId,
        issueNumber: details.issueNumber,
        issueId: details.issueId,
        attemptedSessionId: sessionId,
        winnerSessionId: winnerSessionIds[0],
      },
      "GitHub issue session claim lost; routing to winner",
    );
    return enqueueIssueSessionPrompt(
      env,
      env.DB,
      winnerSessionIds[0],
      promptContext.followUpPrompt,
      actorUserId,
      details.issueNumber,
    );
  }

  const defaultVerifierModel = resolveBaseModelForAutomaticRouting(null);
  let baseModel = options?.verifierParentRuntime
    ? resolveVerificationModel({
        parentModel: options.verifierParentRuntime.model,
        parentAgentRuntimeBackend: options.verifierParentRuntime.agentRuntimeBackend,
      })
    : defaultVerifierModel;

  const createVerifierSession = () =>
    createSessionState(env, sessionId, actorUserId, {
      entrypoint: SessionEntrypoint.GITHUB,
      repoContext: { repoOwner: details.repoOwner, repoName: details.repoName },
      installationId: details.installationId,
      model: baseModel.currentModel,
      agentRuntimeBackend: baseModel.agentRuntimeBackend,
      agentRole: promptContext.agentRuntime.agentRole,
      agentProfile: promptContext.agentRuntime.agentProfile,
      harnessKind: promptContext.agentRuntime.harnessKind,
      runtimeStartupProfile: promptContext.agentRuntime.runtimeStartupProfile,
      targetPrUrl: promptContext.agentRuntime.targetPrUrl ?? null,
      callbackContext: options?.callbackContext,
      githubIssueContext: {
        githubIssueId: details.issueId,
        owner: details.repoOwner,
        repo: details.repoName,
        issueNumber: details.issueNumber,
        url: details.issueUrl,
      },
      waitUntil: executionCtx ? executionCtx.waitUntil.bind(executionCtx) : undefined,
    });

  let created: Awaited<ReturnType<typeof createSessionState>>;
  try {
    created = await createVerifierSession();
  } catch (error) {
    const inheritedRuntime =
      baseModel.currentModel !== defaultVerifierModel.currentModel ||
      baseModel.agentRuntimeBackend !== defaultVerifierModel.agentRuntimeBackend;
    if (
      options?.verifierParentRuntime &&
      inheritedRuntime &&
      (error instanceof ProviderCredentialNotValidatedError || isOpencodeAccessDeniedError(error))
    ) {
      log.warn(
        {
          sessionId,
          issueNumber: details.issueNumber,
          actorUserId,
          parentSessionId: options.verifierParentRuntime.sessionId,
          inheritedVerifierBackend: baseModel.agentRuntimeBackend,
          inheritedVerifierModel: baseModel.currentModel,
          fallbackVerifierBackend: defaultVerifierModel.agentRuntimeBackend,
          fallbackVerifierModel: defaultVerifierModel.currentModel,
          reasonCode:
            error instanceof ProviderCredentialNotValidatedError ? error.reasonCode : "opencode_access_denied",
        },
        "Falling back to default verifier runtime because actor cannot start inherited parent runtime",
      );
      baseModel = defaultVerifierModel;
      created = await createVerifierSession();
    } else {
      throw error;
    }
  }
  const { session, replay } = created;
  const verifierParentContext =
    options?.verifierParentRuntime?.sessionId && Number.isFinite(Number(actorUserId))
      ? {
          parentSessionId: options.verifierParentRuntime.sessionId,
          parentPromptId: `github-verification:${details.commentId}`,
          spawnedByUserId: Number(actorUserId),
          spawnDepth: 1,
        }
      : null;

  await syncSessionProjection({
    db: env.DB,
    sessionId,
    session,
    replay,
    parentContext: verifierParentContext,
    logger: log,
    source: "webhooks.github.issueBootstrap.create",
    userId: actorUserId,
  });

  const enqueueResult = await enqueueSessionPrompt(env, session.sessionId, promptContext.bootstrapPrompt, actorUserId, {
    ...(promptContext.agentRuntime.agentProfile !== DEFAULT_AGENT_NAME
      ? { agent: promptContext.agentRuntime.agentProfile }
      : {}),
    uploadedImages: promptContext.uploadedImages,
  });
  if (!enqueueResult.ok || !enqueueResult.payload) {
    // Bootstrap on a brand-new session shouldn't hit the eligibility gate, but
    // keep the switch shape so a future code added in eligibility.ts doesn't
    // silently fall through here.
    switch (enqueueResult.error) {
      case PROMPT_SEND_BLOCKED_ERROR:
      default: {
        const err = new Error(
          enqueueResult.error === PROMPT_SEND_BLOCKED_ERROR
            ? `Bootstrap enqueue rejected as not sendable (reason=${enqueueResult.reason ?? "unknown"})`
            : `Session DO prompt enqueue failed with status ${enqueueResult.status}`,
        );
        await runWithSentryTag(
          "handleIssueCommentEvent.bootstrap",
          () => Promise.reject(err),
          log.child({ sessionId: session.sessionId, issueNumber: details.issueNumber }),
        );
        throw err;
      }
    }
  }

  try {
    await syncSessionProjection({
      db: env.DB,
      sessionId: session.sessionId,
      session: enqueueResult.payload.session,
      replay: enqueueResult.payload.replay,
      logger: log,
      source: "webhooks.github.issueBootstrap.enqueue",
      userId: actorUserId,
    });
  } catch (err) {
    await runWithSentryTag(
      "handleIssueCommentEvent.sync",
      () => Promise.reject(err),
      log.child({ sessionId: session.sessionId, issueNumber: details.issueNumber }),
    );
    throw err;
  }
  // The verifier is now durably live: marking it here means a throw in the
  // post-enqueue side effects below cannot make the caller release a live
  // verifier's lock (ARC-1173).
  try {
    await options?.onPromptEnqueued?.(session.sessionId);
  } catch (err) {
    log.warn(
      { sessionId: session.sessionId, issueNumber: details.issueNumber, error: String(err) },
      "onPromptEnqueued hook failed after GitHub issue session enqueue",
    );
  }
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  if (isQaTesterAgentRole(promptContext.agentRuntime.agentRole) && promptContext.agentRuntime.targetPrUrl) {
    await syncVerificationStateForPr(env, {
      prUrl: promptContext.agentRuntime.targetPrUrl,
      state: "verification-in-progress",
      attemptCount: options?.verificationAttemptCount ?? null,
      installationId: details.installationId,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      requestId: details.deliveryId,
      logger: log,
    });
    if (options?.callbackContext?.source === "github_qa_issue_comment") {
      scheduleGithubIssueCommentReaction(env, executionCtx, options.callbackContext, GITHUB_QA_STARTED_REACTION);
    }
  }

  if (options?.postSessionComment !== false) {
    scheduleGithubIssueSessionComment(env, executionCtx, details, session.sessionId);
  }
  log.info(
    {
      deliveryId: details.deliveryId,
      sessionId: session.sessionId,
      issueId: details.issueId,
      issueNumber: details.issueNumber,
      repoOwner: details.repoOwner,
      repoName: details.repoName,
      installationId: details.installationId,
      actorUserId,
      senderLogin: details.senderLogin,
    },
    "GitHub issue session created",
  );
  return jsonResponse({
    ok: true,
    created: true,
    sessionId: session.sessionId,
    enqueued: true,
    prompt: toPublicEnqueuedPrompt(enqueueResult.payload.prompt),
    dispatch: toPublicEnqueueDispatch(enqueueResult.payload.dispatch),
  });
}

async function routeAuthorizedGithubIssueComment(payload: {
  env: Env;
  rawBody: string;
  request: Request;
  details: AuthorizedGithubIssueCommentDetails;
  promptContext: IssueCommentPromptContext;
  actorUserId: string;
  executionCtx?: ExecutionContext;
}): Promise<Response> {
  const duplicate = await claimGithubWebhook(payload.request, payload.rawBody, payload.env);
  if (duplicate) return duplicate;

  // NOTE: deliberately NOT wrapped in a release-claim-and-500 guard like the review-loop ingest paths.
  // The session bootstrap / existing-session enqueue below is NOT idempotent on redelivery
  // (enqueueSessionPrompt carries no per-delivery key), so releasing the claim after the prompt is
  // already durably enqueued would re-enqueue a DUPLICATE prompt on GitHub's redelivery and run the
  // agent twice. Making this path retry-safe requires a per-delivery enqueue idempotency key first
  // (tracked as a follow-up); until then we keep the pre-existing behavior (a transient pre-enqueue
  // throw surfaces 5xx with the claim retained).
  const existingSessionResponse = await routeGithubIssueCommentToExistingSession(
    payload.env,
    payload.details,
    payload.promptContext,
    payload.actorUserId,
  );
  if (existingSessionResponse) return existingSessionResponse;

  return bootstrapGithubIssueSession(
    payload.env,
    payload.details,
    payload.promptContext,
    payload.actorUserId,
    payload.executionCtx,
  );
}

async function handleIssueCommentEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = parseGithubIssueCommentEvent(payload, request);
  if (!parsed.ok) return parsed.response;

  const appSlug = await getAppSlug(env);

  if (parsed.details.issueIsPullRequest) {
    if (isCycloidReplyBotSender(parsed.details.senderLogin, parsed.details.senderType)) {
      log.warn(
        {
          deliveryId: parsed.details.deliveryId,
          commentId: parsed.details.commentId,
          issueNumber: parsed.details.issueNumber,
          senderLogin: parsed.details.senderLogin,
          senderType: parsed.details.senderType,
        },
        "Skipping GitHub issue comment: Cycloid bot reply sender",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "non_user_sender" });
    }

    const reviewTrigger = extractCycloidReviewTrigger(parsed.details.commentBody);
    if (reviewTrigger.triggered) {
      const actorFilterResponse = filterGithubIssueCommentActor(parsed.details, appSlug);
      if (actorFilterResponse) return actorFilterResponse;
      const metadata = validateGithubIssueCommentMetadata(parsed.details);
      if (!metadata.ok) return metadata.response;
      const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, reviewTrigger.focus);
      if (!actor.ok) return actor.response;
      const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
      if (unauthorizedResponse) return unauthorizedResponse;
      if (!metadata.details.commentId || !metadata.details.senderLogin) {
        return jsonErrorResponse("Missing comment metadata", 400);
      }

      const duplicate = await claimGithubWebhook(request, rawBody, env);
      if (duplicate) return duplicate;
      const actorUser = await resolveInternalFeatureGateUser(env.DB, Number(actor.actorUserId));
      if (!actorUser || !isCycloidMember(actorUser)) {
        ctx?.waitUntil(
          postStructuredEventToDd(env, {
            event: "pr_review_trigger",
            triggerSource: "webhook",
            outcome: "rejected_not_member",
            prUrl: metadata.details.issueUrl,
          }),
        );
        log.info(
          { event: "pr_review_trigger", outcome: "rejected_not_member", prUrl: metadata.details.issueUrl },
          "Skipped triggered PR review for non-member",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "not_member" });
      }

      const permission = await getActorRepoPermissionLevel(env, {
        installationId: metadata.details.installationId,
        repoOwner: metadata.details.repoOwner,
        repoName: metadata.details.repoName,
        actorLogin: metadata.details.senderLogin,
      });
      if (permission === null) {
        ctx?.waitUntil(
          postStructuredEventToDd(env, {
            event: "pr_review_trigger",
            triggerSource: "webhook",
            outcome: "permission_indeterminate",
            prUrl: metadata.details.issueUrl,
          }),
        );
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "pr_review_permission_indeterminate",
          logFields: { deliveryId: metadata.details.deliveryId, commentId: metadata.details.commentId },
          warnMessage: "Released triggered PR review webhook claim for permission retry",
        });
        return jsonErrorResponse("PR review permission lookup failed - retry", 500);
      }
      if (!actorCanWriteToRepo(permission)) {
        ctx?.waitUntil(
          postStructuredEventToDd(env, {
            event: "pr_review_trigger",
            triggerSource: "webhook",
            outcome: "no_write_permission",
            prUrl: metadata.details.issueUrl,
          }),
        );
        log.info(
          { event: "pr_review_trigger", outcome: "no_write_permission", prUrl: metadata.details.issueUrl },
          "Skipped triggered PR review",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "no_write_permission" });
      }

      const triggerCommentId = metadata.details.commentId;
      try {
        const requestedSessionId = crypto.randomUUID();
        const continuation = await resolveSessionContinuation({
          env,
          sessionId: requestedSessionId,
          prompt: reviewTrigger.focus ?? "Review this pull request.",
          continuePrUrl: metadata.details.issueUrl,
          continueMode: "update-pr",
          allowPromptInference: false,
          repoContext: { repoOwner: metadata.details.repoOwner, repoName: metadata.details.repoName },
          installationId: metadata.details.installationId,
          logger: log,
        });
        const result = await spawnPrReviewTrigger({
          env,
          ownerUserId: actor.actorUserId,
          businessId: actorUser.businessId,
          prUrl: metadata.details.issueUrl,
          prNumber: metadata.details.issueNumber,
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          installationId: metadata.details.installationId,
          claimToken: crypto.randomUUID(),
          triggerCommentId,
          triggerSource: "webhook",
          authorization: { mode: "webhook_actor", actorLogin: metadata.details.senderLogin },
          focus: reviewTrigger.focus,
          sessionId: requestedSessionId,
          repoContext: continuation.repoContext,
          waitUntil: (promise) => ctx?.waitUntil(promise),
        });
        if (!result.ok && result.kind === "skip" && result.reason === "claim_contended") {
          return jsonResponse({ ok: true, skipped: true, reason: result.reason });
        }
        if (!result.ok) throw new Error(`PR review trigger ${result.reason}`);
        const sessionId = result.sessionId;
        await postIssueCommentReaction(
          env,
          metadata.details.installationId,
          metadata.details.repoOwner,
          metadata.details.repoName,
          triggerCommentId,
          GITHUB_QA_STARTED_REACTION,
        ).catch((error) => log.warn({ sessionId, error: String(error) }, "Failed to acknowledge PR review trigger"));
        ctx?.waitUntil(
          postStructuredEventToDd(env, {
            event: "pr_review_trigger",
            triggerSource: "webhook",
            outcome: "created",
            sessionId,
            prUrl: metadata.details.issueUrl,
          }),
        );
        log.info(
          { event: "pr_review_trigger", outcome: "created", sessionId, prUrl: metadata.details.issueUrl },
          "Created triggered PR review",
        );
        return jsonResponse({ ok: true, sessionId });
      } catch (error) {
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "pr_review_trigger_retryable_failure",
          logFields: { deliveryId: metadata.details.deliveryId, commentId: metadata.details.commentId },
          warnMessage: "Failed to release triggered PR review webhook claim for retry",
        });
        ctx?.waitUntil(
          postStructuredEventToDd(env, {
            event: "pr_review_trigger",
            triggerSource: "webhook",
            outcome: "spawn_failed",
            prUrl: metadata.details.issueUrl,
          }),
        );
        log.error(
          { event: "pr_review_trigger", outcome: "spawn_failed", error: String(error) },
          "Failed to create triggered PR review",
        );
        return jsonErrorResponse("Failed to start PR review", 500);
      }
    }

    const issueComment = extractPromptFromIssueComment(parsed.details.commentBody, appSlug);
    const qaDirective = parseQaDirectiveFromText(issueComment.prompt);
    if (issueComment.mentioned && qaDirective.removedVerifyDirective) {
      const metadata = validateGithubIssueCommentMetadata(parsed.details);
      if (metadata.ok) {
        await postIssueComment(
          env,
          metadata.details.installationId,
          metadata.details.repoOwner,
          metadata.details.repoName,
          metadata.details.issueNumber,
          "The old GitHub QA directive is no longer supported. Use `qa=true` with a GitHub pull request URL.",
        ).catch((err) => {
          log.warn(
            {
              deliveryId: metadata.details.deliveryId,
              issueNumber: metadata.details.issueNumber,
              repoOwner: metadata.details.repoOwner,
              repoName: metadata.details.repoName,
              error: String(err),
            },
            "Failed to post GitHub QA directive deprecation comment",
          );
        });
      }
      return jsonResponse({ ok: true, skipped: true, reason: "removed_verify_directive" });
    }
    if (issueComment.mentioned && qaDirective.qa) {
      const actorFilterResponse = filterGithubIssueCommentActor(parsed.details, appSlug);
      if (actorFilterResponse) return actorFilterResponse;

      const metadata = validateGithubIssueCommentMetadata(parsed.details);
      if (!metadata.ok) return metadata.response;

      const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, issueComment.prompt);
      if (!actor.ok) return actor.response;

      const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
      if (unauthorizedResponse) return unauthorizedResponse;

      const duplicate = await claimGithubWebhook(request, rawBody, env);
      if (duplicate) return duplicate;

      // The whole-delivery claim is committed above. Wrap the verify-directive work so a transient
      // throw (D1/Session-DO/GitHub) releases the claim and returns a non-200 for redelivery instead
      // of dropping the directive until the ~7-day TTL. `findActiveVerificationSession` + the
      // FSM-native spawn idempotency anchor (W11-V4) dedup the redelivery so it never starts a
      // duplicate verifier (the per-PR lock was removed at D-51).
      try {
        // Gate and register on the PR the verifier will actually target: the
        // comment may reference a different PR than the one it was posted on.
        const promptContext = buildIssueCommentPromptContext(metadata.details, issueComment.prompt);
        const verifyTargetPrUrl = promptContext.agentRuntime.targetPrUrl ?? metadata.details.issueUrl;
        if (
          !githubPullRequestUrlMatchesRepo(verifyTargetPrUrl, metadata.details.repoOwner, metadata.details.repoName)
        ) {
          await postIssueComment(
            env,
            metadata.details.installationId,
            metadata.details.repoOwner,
            metadata.details.repoName,
            metadata.details.issueNumber,
            "QA testing can only target pull requests in this repository.",
          ).catch((err) => {
            log.warn(
              {
                deliveryId: metadata.details.deliveryId,
                issueNumber: metadata.details.issueNumber,
                repoOwner: metadata.details.repoOwner,
                repoName: metadata.details.repoName,
                targetPrUrl: verifyTargetPrUrl,
                error: String(err),
              },
              "Failed to post GitHub QA target repo rejection comment",
            );
          });
          return jsonResponse({ ok: true, skipped: true, reason: "target_pr_repo_mismatch" });
        }
        if (!metadata.details.commentId) {
          log.error(
            {
              deliveryId: metadata.details.deliveryId,
              issueNumber: metadata.details.issueNumber,
              repoOwner: metadata.details.repoOwner,
              repoName: metadata.details.repoName,
            },
            "GitHub QA issue comment rejected: missing comment id",
          );
          return jsonErrorResponse("Missing comment metadata", 400);
        }
        const callbackContext: Extract<CallbackContext, { source: "github_qa_issue_comment" }> = {
          source: "github_qa_issue_comment",
          installationId: metadata.details.installationId,
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          issueNumber: metadata.details.issueNumber,
          commentId: metadata.details.commentId,
          targetPrUrl: verifyTargetPrUrl,
        };
        const coordinated = await requestCoordinatedVerification({
          env,
          logger: log,
          waitUntil: ctx?.waitUntil.bind(ctx),
          source: "github",
          ownerUserId: actor.actorUserId,
          businessId: null,
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          installationId: metadata.details.installationId,
          prUrl: verifyTargetPrUrl,
          prompt: issueComment.prompt,
          requestId: request.headers.get("x-github-delivery"),
          callbackContext,
        });
        if (coordinated.ok) {
          if (coordinated.duplicate) {
            let commentPostFailed = false;
            await postIssueComment(
              env,
              metadata.details.installationId,
              metadata.details.repoOwner,
              metadata.details.repoName,
              metadata.details.issueNumber,
              buildDuplicateVerificationSessionComment(coordinated.sessionId, env, metadata.details.repoPrivate),
            ).catch((err) => {
              commentPostFailed = true;
              log.warn(
                { sessionId: coordinated.sessionId, issueNumber: metadata.details.issueNumber, error: String(err) },
                "Failed to post duplicate-verifier comment",
              );
            });
            await postStructuredEventToDd(env, {
              event: "verification_directive_rejected",
              reason_code: "verifier_active",
              pr_url: verifyTargetPrUrl,
              session_id: coordinated.sessionId,
              comment_post_failed: commentPostFailed,
            });
          }
          if (!coordinated.duplicate) {
            scheduleGithubIssueCommentReaction(env, ctx, callbackContext, GITHUB_QA_STARTED_REACTION);
          }
          return jsonResponse({
            ok: true,
            skipped: coordinated.duplicate,
            reason: coordinated.duplicate ? "verifier_active" : undefined,
            sessionId: coordinated.sessionId,
          });
        }
        if (coordinated.reason === "run_limit_reached") {
          let commentPostFailed = false;
          await postIssueComment(
            env,
            metadata.details.installationId,
            metadata.details.repoOwner,
            metadata.details.repoName,
            metadata.details.issueNumber,
            "🔍 Verification has reached the run limit for this pull request.",
          ).catch((err) => {
            commentPostFailed = true;
            log.warn(
              { issueNumber: metadata.details.issueNumber, targetPrUrl: verifyTargetPrUrl, error: String(err) },
              "Failed to post verification run-limit comment",
            );
          });
          await postStructuredEventToDd(env, {
            event: "verification_run_limit_hit",
            reason_code: "limit_exceeded",
            pr_url: verifyTargetPrUrl,
            comment_post_failed: commentPostFailed,
          });
          return jsonResponse({
            ok: true,
            skipped: true,
            reason: "verification_run_limit_reached",
          });
        }
        if (coordinated.reason === "schedule_failed") {
          throw new Error(coordinated.error ?? "GitHub QA coordinator scheduling failed");
        }
        if (coordinated.reason === "invalid_pr") {
          let commentPostFailed = false;
          await postIssueComment(
            env,
            metadata.details.installationId,
            metadata.details.repoOwner,
            metadata.details.repoName,
            metadata.details.issueNumber,
            "QA target pull request could not be resolved.",
          ).catch((err) => {
            commentPostFailed = true;
            log.warn(
              { issueNumber: metadata.details.issueNumber, targetPrUrl: verifyTargetPrUrl, error: String(err) },
              "Failed to post invalid GitHub QA target comment",
            );
          });
          await postStructuredEventToDd(env, {
            event: "verification_directive_rejected",
            reason_code: "invalid_pr",
            pr_url: verifyTargetPrUrl,
            comment_post_failed: commentPostFailed,
          });
          return jsonResponse({
            ok: true,
            skipped: true,
            reason: "invalid_pr",
          });
        }
        log.warn(
          {
            deliveryId: metadata.details.deliveryId,
            issueNumber: metadata.details.issueNumber,
            repoOwner: metadata.details.repoOwner,
            repoName: metadata.details.repoName,
            targetPrUrl: verifyTargetPrUrl,
            reason: coordinated.reason,
            error: coordinated.error,
          },
          "GitHub QA coordinator request failed",
        );
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: coordinated.reason,
        });
      } catch (err) {
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "verification_directive_retryable",
          logFields: { deliveryId: parsed.details.deliveryId, commentId: parsed.details.commentId },
          warnMessage: "Failed to release webhook claim for verify-directive retry",
        });
        log.warn(
          { error: String(err), deliveryId: parsed.details.deliveryId, commentId: parsed.details.commentId },
          "GitHub verify-directive ingest failed; released claim for redelivery",
        );
        return jsonErrorResponse("issue_comment verify directive failed — retry", 500);
      }
    }

    // Top-level `@cycloid …` directive on a PR (ARC-1514). Pulls Cycloid into the PR as a task
    // REGARDLESS of the per-user automatic-reviews toggle (mentions bypass it — no
    // resolveReviewLoopChecklist consult). Bootstraps a `mention` epoch that the review-loop sweep
    // (PR5) claims + dispatches; we never enqueue the prompt here (single writer = the sweep).
    if (issueComment.mentioned && !qaDirective.qa && !qaDirective.removedVerifyDirective) {
      // ---- Loop safety FIRST (before auth/claim) ----
      // 1) non-`User` sender + self-`appSlug` author.
      const actorFilterResponse = filterGithubIssueCommentActor(parsed.details, appSlug);
      if (actorFilterResponse) return actorFilterResponse;

      // 2) Cycloid-owned bot authors (the owned set is bots-only; `filterGithubIssueCommentActor`
      //    already drops non-`User` senders, but a user-typed login collision is fenced here too).
      const normalizedSender = parsed.details.senderLogin
        ? normalizeGitHubActorLogin(parsed.details.senderLogin)
        : null;
      if (normalizedSender && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedSender)) {
        log.warn(
          {
            deliveryId: parsed.details.deliveryId,
            commentId: parsed.details.commentId,
            issueNumber: parsed.details.issueNumber,
            senderLogin: parsed.details.senderLogin,
          },
          "Skipping GitHub PR mention: owned-bot author",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "owned_bot_sender" });
      }

      // 3) Cycloid's OWN review-loop replies: a threaded reply is posted with the acting user's
      //    credentials, so GitHub attributes the issue-comment to that user and the `appSlug`
      //    self-skip cannot catch it. Match the stored operation github_id instead (#7119/#7182
      //    self-reply-loop incident). Scans the issue-comment/review-body id namespace only.
      if (parsed.details.commentId) {
        let selfReplyIds: Set<string>;
        try {
          selfReplyIds = await selectReviewLoopIssueCommentReplyGithubIds(env.DB, [String(parsed.details.commentId)]);
        } catch (err) {
          log.warn(
            { error: String(err), deliveryId: parsed.details.deliveryId, commentId: parsed.details.commentId },
            "GitHub PR mention self-reply lookup failed; retrying delivery",
          );
          return jsonErrorResponse("issue_comment mention self-reply lookup failed — retry", 500);
        }
        if (selfReplyIds.has(String(parsed.details.commentId))) {
          log.warn(
            {
              deliveryId: parsed.details.deliveryId,
              commentId: parsed.details.commentId,
              issueNumber: parsed.details.issueNumber,
            },
            "Skipping GitHub PR mention: Cycloid-authored reply",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "self_reply" });
        }
      }

      // ---- Auth (fail closed): validate → resolve actor → authorize repo access ----
      const metadata = validateGithubIssueCommentMetadata(parsed.details);
      if (!metadata.ok) return metadata.response;

      const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, issueComment.prompt);
      if (!actor.ok) {
        log.warn(
          {
            action: "issue_comment_mention",
            repoOwner: metadata.details.repoOwner,
            repoName: metadata.details.repoName,
            prNumber: metadata.details.issueNumber,
            senderLogin: parsed.details.senderLogin,
          },
          "GitHub PR mention denied: actor unresolved",
        );
        return actor.response;
      }

      const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
      if (unauthorizedResponse) {
        log.warn(
          {
            action: "issue_comment_mention",
            repoOwner: metadata.details.repoOwner,
            repoName: metadata.details.repoName,
            prNumber: metadata.details.issueNumber,
            senderLogin: parsed.details.senderLogin,
          },
          "GitHub PR mention denied: no repo access",
        );
        return unauthorizedResponse;
      }

      // A bare `@cycloid` with no free text carries no actionable directive.
      const directiveText = issueComment.prompt;
      if (!directiveText) {
        log.info(
          {
            deliveryId: metadata.details.deliveryId,
            commentId: metadata.details.commentId,
            issueNumber: metadata.details.issueNumber,
          },
          "Skipping GitHub PR mention: empty directive",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "empty_mention" });
      }
      if (!metadata.details.commentId) {
        log.error(
          { deliveryId: metadata.details.deliveryId, issueNumber: metadata.details.issueNumber },
          "GitHub PR mention rejected: missing comment id",
        );
        return jsonErrorResponse("Missing comment metadata", 400);
      }
      const mentionCommentId = metadata.details.commentId;
      const { repoOwner, repoName } = metadata.details;
      const prNumber = metadata.details.issueNumber;
      const prUrl = metadata.details.issueUrl;

      const duplicate = await claimGithubWebhook(request, rawBody, env);
      if (duplicate) return duplicate;

      // The whole-delivery claim is committed above. A transient failure during the multi-step
      // bound-session resolve + revive + head lookup + epoch bootstrap would otherwise leave the
      // claim committed and let GitHub's redelivery dedup drop the mention until the ~7-day TTL.
      // Release the claim and return a non-200 so GitHub redelivers (bootstrap is idempotent on the
      // mention sentinel + source ids).
      try {
        // ---- Bound-session resolution ----
        // Prefer the single tracking session for this PR. With no tracking winner, attach ONLY when
        // exactly one webhook ref matches; multiple refs with no winner are AMBIGUOUS → fail closed
        // (never attach a mention to a guessed/legacy session). No ref at all → skip (non-owned-PR
        // mentions are ARC-1515, out of scope).
        let sessionId = await getTrackingSessionIdForPrUrl(env.DB, prUrl);
        if (!sessionId) {
          const refSessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
          if (refSessionIds.length === 1) {
            sessionId = refSessionIds[0];
          } else if (refSessionIds.length > 1) {
            log.warn(
              {
                action: "issue_comment_mention",
                repoOwner,
                repoName,
                prNumber,
                senderLogin: parsed.details.senderLogin,
                refCount: refSessionIds.length,
              },
              "Skipping GitHub PR mention: ambiguous bound session",
            );
            return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
          }
        }
        if (!sessionId) {
          const actorUser = await resolveInternalFeatureGateUser(env.DB, Number(actor.actorUserId));
          if (!actorUser || !isCycloidMember(actorUser) || !parsed.details.senderLogin) {
            log.info(
              { deliveryId: metadata.details.deliveryId, repoOwner, repoName, prNumber },
              "Skipping GitHub PR mention: no bound session",
            );
            return jsonResponse({ ok: true, skipped: true, reason: "no_bound_session" });
          }

          // If create+bind succeeds but the bootstrap FSM emit throws, redelivery can hand off to
          // the bound session; the bootstrap-claim TTL self-heals the remaining tail claim.
          const bootstrap = await bootstrapMentionSession(env, {
            actorUserId: actor.actorUserId,
            actorLogin: parsed.details.senderLogin,
            actorBusinessId: actorUser.businessId,
            installationId: metadata.details.installationId,
            repoOwner,
            repoName,
            prUrl,
            directiveText,
            waitUntil: (promise) => ctx?.waitUntil(promise),
          });
          if (bootstrap.kind === "skip") {
            return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
          }
          if (bootstrap.kind === "rejected") {
            await postIssueComment(
              env,
              metadata.details.installationId,
              repoOwner,
              repoName,
              prNumber,
              bootstrap.publicMessage,
            ).catch((err) => {
              log.warn(
                {
                  action: "issue_comment_mention",
                  deliveryId: metadata.details.deliveryId,
                  repoOwner,
                  repoName,
                  prNumber,
                  reason: bootstrap.reason,
                  error: String(err),
                },
                "Failed to post GitHub mention bootstrap rejection comment",
              );
            });
            return jsonResponse({ ok: true, skipped: true, reason: bootstrap.reason });
          }
          if (bootstrap.kind === "retry") {
            throw new Error(`GitHub mention bootstrap retry requested: ${bootstrap.reason}`);
          }
          sessionId = bootstrap.sessionId;
        }

        // ---- PR-open gate (BEFORE any revive) ----
        // ensureSessionLiveForPr below unarchives + warms/cold-boots the sandbox, and getPrHeadSha
        // returns a SHA even for closed/merged PRs, so without this gate an @cycloid comment on a
        // terminal (closed/merged) PR would revive the sandbox and dispatch a mention epoch. Mirror
        // reengageSessionForReview (services/review-loop-reengage.ts, which documents the open-gate as
        // the caller's job for ensureSessionLiveForPr): gate on PR-open state FIRST. Mint the
        // installation token once here and reuse it for the head-SHA lookup below. getPrState returns
        // "closed"/"merged" for a genuinely-not-open PR and null on a TRANSIENT GitHub failure
        // (404/429/5xx); a 401/403 throws. The gate runs AFTER the claim commit so a benign not-open
        // skip consumes the delivery (no redelivery, no revive), while the transient/throw path falls
        // to the catch below which releases the claim so GitHub redelivers (fail-closed retry).
        const installationToken = await createInstallationToken(env, metadata.details.installationId);
        const prState = await getPrState(installationToken, repoOwner, repoName, prNumber);
        if (prState === null) {
          // Indeterminate PR state (transient GitHub failure) — throw so the catch releases the claim
          // and GitHub redelivers, instead of reviving on an unknown state or silently dropping it.
          throw new Error("issue_comment mention PR-state lookup indeterminate — retry");
        }
        if (prState !== "open") {
          log.info(
            { action: "issue_comment_mention", sessionId, repoOwner, repoName, prNumber, prState },
            "Skipping GitHub PR mention: PR not open",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "pr_not_open" });
        }

        // ---- Revive the PR-bound session (unarchive / warm the same sandbox / reuse it) so the
        //      mention can run even on a finished/stopped/archived session. Idempotently re-registers
        //      the github_pr_url ref. Failure statuses (not found / unarchive / warm) → skip. ----
        const live = await ensureSessionLiveForPr({ env, db: env.DB, sessionId, prUrl, nowMs: Date.now() });
        if (live.status !== "live") {
          log.warn(
            {
              action: "issue_comment_mention",
              sessionId,
              repoOwner,
              repoName,
              prNumber,
              reason: live.status,
            },
            "Skipping GitHub PR mention: session not revivable",
          );
          return jsonResponse({ ok: true, skipped: true, reason: live.status });
        }

        // ---- Resolve the current PR head SHA for the epoch key (reuse the gate's token) ----
        const headSha = await getPrHeadSha(installationToken, repoOwner, repoName, prNumber);
        if (!headSha) {
          log.warn(
            { action: "issue_comment_mention", sessionId, repoOwner, repoName, prNumber },
            "Skipping GitHub PR mention: PR head unavailable",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "pr_head_unavailable" });
        }

        // ---- Bootstrap a `ready` directive mention epoch; the sweep dispatches it. ----
        const epoch = await bootstrapMentionEpoch(env.DB, {
          sessionId,
          ownerUserId: Number(live.session.ownerUserId),
          repoOwner,
          repoName,
          prNumber,
          prUrl,
          headSha,
          mode: "directive",
          targetSourceIds: [`issue-comment:${mentionCommentId}`],
          mentionText: directiveText,
          nowMs: Date.now(),
        });
        if (!epoch) {
          // OR-IGNORE contention exhausted its retry budget with no committed row — retry via
          // redelivery rather than silently dropping the mention.
          throw new Error("bootstrapMentionEpoch exhausted its retry budget");
        }

        // ---- Re-arm review_listening so the sweep can dispatch this mention epoch even on a
        //      just-revived (unarchived / cold-booted) session. Bootstrap-then-arm mirrors the
        //      review re-engage ordering so the epoch is durable before the DO is marked listening.
        //      The enter route returns updated:false ONLY when the session is archived again
        //      (re-archive race between revive and this emit) — the epoch is then NOT dispatchable
        //      (the sweep skips non-review-listening sessions), so treat !updated as retryable and
        //      release the claim + redeliver, mirroring reengageSessionForReview. ----
        const listening = await emitReviewListeningEntered(env, sessionId, { headSha, prUrl });
        if (!listening || !listening.ok || !listening.payload?.updated) {
          const reason = listening?.payload?.reason ?? (listening ? `http_${listening.status}` : "no_pr_url");
          throw new Error(`emitReviewListeningEntered not durable for mention: ${reason}`);
        }

        log.info(
          {
            action: "issue_comment_mention",
            deliveryId: metadata.details.deliveryId,
            sessionId,
            epochId: epoch.id,
            repoOwner,
            repoName,
            prNumber,
          },
          "GitHub PR mention bootstrapped mention epoch",
        );
        // 👀 acknowledge the mention on the PR comment so the human sees Cycloid picked it up. Manual
        // review mode suppresses the ingest-path ack (ingest returns `ignored`), so the mention path —
        // the way Cycloid engages in manual mode — owns the acknowledgment. Fire-and-forget.
        scheduleReviewAckReaction(env, ctx, {
          installationId: metadata.details.installationId,
          owner: repoOwner,
          repo: repoName,
          actorLogin: parsed.details.senderLogin,
          actorType: parsed.details.senderType,
          surface: { kind: "issue_comment", commentId: mentionCommentId, body: directiveText },
        });
        return jsonResponse({ ok: true, mention: true, epochId: epoch.id, sessionId });
      } catch (err) {
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "issue_comment_mention_retryable",
          logFields: { deliveryId: parsed.details.deliveryId, commentId: mentionCommentId },
          warnMessage: "Failed to release webhook claim for issue-comment mention retry",
        });
        log.warn(
          { error: String(err), deliveryId: parsed.details.deliveryId, commentId: mentionCommentId },
          "GitHub issue-comment mention failed; released claim for redelivery",
        );
        return jsonErrorResponse("issue_comment mention failed — retry", 500);
      }
    }

    if (
      parsed.details.commentId &&
      parsed.details.issueNumber &&
      parsed.details.issueUrl &&
      parsed.details.repoOwner &&
      parsed.details.repoName
    ) {
      const duplicate = await claimGithubWebhook(request, rawBody, env);
      if (duplicate) return duplicate;
      // The whole-delivery claim is committed above. A transient ingest failure (D1/GitHub) would
      // otherwise leave it committed and let GitHub's redelivery dedup drop the PR comment until the
      // ~7-day TTL. Release the claim and return a non-200 so GitHub redelivers; the ingest is
      // idempotent on sourceId (epoch upsert), so reprocessing is safe.
      try {
        const result = await ingestReviewLoopPrIssueCommentWebhook({
          env,
          deliveryId: parsed.details.deliveryId,
          sourceId: `issue-comment:${parsed.details.commentId}`,
          commentId: parsed.details.commentId,
          commentBody: typeof parsed.details.commentBody === "string" ? parsed.details.commentBody : null,
          actorLogin: parsed.details.senderLogin,
          actorType: parsed.details.senderType,
          repoOwner: parsed.details.repoOwner,
          repoName: parsed.details.repoName,
          prNumber: parsed.details.issueNumber,
          prUrl: parsed.details.issueUrl,
          // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
          waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
        });
        if (result.status === "handled") {
          scheduleReviewAckReaction(env, ctx, {
            installationId: parsed.details.installationId,
            owner: parsed.details.repoOwner,
            repo: parsed.details.repoName,
            actorLogin: parsed.details.senderLogin,
            actorType: parsed.details.senderType,
            surface: {
              kind: "issue_comment",
              commentId: parsed.details.commentId,
              body: typeof parsed.details.commentBody === "string" ? parsed.details.commentBody : null,
            },
          });
          return jsonResponse({ ok: true, reviewLoop: true, epochId: result.epoch.id, status: result.epoch.status });
        }
        if (parsed.details.senderType === "User") {
          try {
            const selfPostedIds = await selectReviewLoopIssueCommentReplyGithubIds(env.DB, [
              String(parsed.details.commentId),
            ]);
            if (!selfPostedIds.has(String(parsed.details.commentId))) {
              dispatchHumanGithubPrActionAlert(
                {
                  env,
                  deliveryId: parsed.details.deliveryId,
                  prUrl: parsed.details.issueUrl,
                  prNumber: parsed.details.issueNumber,
                  repoOwner: parsed.details.repoOwner,
                  repoName: parsed.details.repoName,
                  actorLogin: parsed.details.senderLogin,
                  actorType: parsed.details.senderType,
                  actionKind: "issue_comment",
                  commentId: parsed.details.commentId,
                },
                ctx ? (promise) => ctx.waitUntil(promise) : undefined,
              );
            }
          } catch (alertError) {
            log.warn(
              {
                error: String(alertError),
                deliveryId: parsed.details.deliveryId,
                commentId: parsed.details.commentId,
                prUrl: parsed.details.issueUrl,
              },
              "Skipped human GitHub PR comment alert after self-reply lookup failed",
            );
          }
        }
      } catch (error) {
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "issue_comment_review_loop_ingest_retryable",
          logFields: { deliveryId: parsed.details.deliveryId, commentId: parsed.details.commentId },
          warnMessage: "Failed to release webhook claim for issue-comment review-loop ingest retry",
        });
        log.warn(
          { error: String(error), deliveryId: parsed.details.deliveryId, commentId: parsed.details.commentId },
          "GitHub issue-comment review-loop ingest failed; released claim for redelivery",
        );
        return jsonErrorResponse("issue_comment review-loop ingest failed — retry", 500);
      }
    }
    log.warn(
      {
        deliveryId: parsed.details.deliveryId,
        commentId: parsed.details.commentId,
        issueId: parsed.details.issueId,
        issueNumber: parsed.details.issueNumber,
        repoOwner: parsed.details.repoOwner,
        repoName: parsed.details.repoName,
      },
      "Skipping GitHub issue comment: pull request comment",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "pull_request_comment" });
  }

  const actorFilterResponse = filterGithubIssueCommentActor(parsed.details, appSlug);
  if (actorFilterResponse) return actorFilterResponse;

  const mention = resolveGithubIssueCommentMention(parsed.details, appSlug);
  if (!mention.ok) return mention.response;

  const metadata = validateGithubIssueCommentMetadata(parsed.details);
  if (!metadata.ok) return metadata.response;

  const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, mention.prompt);
  if (!actor.ok) return actor.response;

  const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
  if (unauthorizedResponse) return unauthorizedResponse;

  let promptContext = buildIssueCommentPromptContext(metadata.details, mention.prompt);
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  if (isQaTesterAgentRole(promptContext.agentRuntime.agentRole)) {
    await postIssueComment(
      env,
      metadata.details.installationId,
      metadata.details.repoOwner,
      metadata.details.repoName,
      metadata.details.issueNumber,
      "QA testing can only be requested from a pull request comment. Comment on the pull request with `@cycloid qa=true`.",
    ).catch((err) => {
      log.warn(
        {
          deliveryId: metadata.details.deliveryId,
          issueNumber: metadata.details.issueNumber,
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          error: String(err),
        },
        "Failed to post issue QA directive rejection comment",
      );
    });
    return jsonResponse({ ok: true, skipped: true, reason: "qa_directive_requires_pull_request_comment" });
  }

  let issueComments: GithubIssuePromptComment[] = [];
  let uploadedImages: UploadedImage[] = [];
  try {
    const installationToken = await createInstallationToken(env, metadata.details.installationId);
    const fetchedIssueComments = await fetchGithubIssueComments({
      token: installationToken,
      repoOwner: metadata.details.repoOwner,
      repoName: metadata.details.repoName,
      issueNumber: metadata.details.issueNumber,
    });
    issueComments = fetchedIssueComments.filter(
      (comment) => metadata.details.commentId === null || comment.id !== metadata.details.commentId,
    );
    uploadedImages = await fetchGithubIssueImages({
      token: installationToken,
      issueBody: metadata.details.issueBody,
      comments: issueComments,
    });
  } catch (error) {
    log.warn(
      {
        deliveryId: metadata.details.deliveryId,
        issueNumber: metadata.details.issueNumber,
        repoOwner: metadata.details.repoOwner,
        repoName: metadata.details.repoName,
        error: String(error),
      },
      "GitHub issue context fetch failed; continuing without issue comments/images",
    );
  }

  const promptContextWithIssueContext = buildIssueCommentPromptContext(
    metadata.details,
    mention.prompt,
    issueComments,
    uploadedImages,
  );
  const uploadedImageBudget = trimUploadedImagesToPromptBudget({
    promptText: promptContextWithIssueContext.bootstrapPrompt,
    uploadedImages: promptContextWithIssueContext.uploadedImages,
  });
  promptContext = {
    ...promptContextWithIssueContext,
    uploadedImages: uploadedImageBudget.uploadedImages,
  };

  return routeAuthorizedGithubIssueComment({
    env,
    rawBody,
    request,
    details: metadata.details,
    promptContext,
    actorUserId: actor.actorUserId,
    executionCtx: ctx,
  });
}

async function handleStatusEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<Response> {
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!repository) {
    log.warn({}, "Skipping GitHub status: missing repository payload");
    return jsonErrorResponse("Missing status payload", 400);
  }

  const deliveryId = normalizeWebhookReference(request.headers.get("x-github-delivery"));
  const statusId = typeof payload.id === "number" ? payload.id : null;
  const statusSha = normalizeWebhookReference(payload.sha);
  const rawState = normalizeWebhookReference(payload.state);
  const statusState = rawState ? rawState.toLowerCase() : "";
  const context = normalizeWebhookReference(payload.context);
  const description = normalizeWebhookReference(payload.description);
  const targetUrl = normalizeWebhookReference(payload.target_url);
  const { senderLogin: actorLogin, senderType: actorType } = extractCommonWebhookActor(payload);
  const { repoOwner, repoName, installationId } = extractRepoAndInstallation(payload, repository);

  log.info(
    {
      deliveryId,
      statusId,
      statusSha,
      statusState,
      context,
      actorLogin,
      actorType,
      repoOwner,
      repoName,
      installationId,
    },
    "Received GitHub status webhook",
  );

  if (statusState === "pending") {
    return jsonResponse({ ok: true, skipped: true, reason: "status_pending" });
  }
  if (!statusState || !["success", "failure", "error"].includes(statusState)) {
    return jsonResponse({ ok: true, skipped: true, reason: "unsupported_status_state" });
  }
  if (!statusId || !statusSha || !repoOwner || !repoName || !installationId) {
    log.error(
      { deliveryId, statusId, statusSha, repoOwner, repoName, installationId },
      "GitHub status rejected: missing metadata",
    );
    return jsonErrorResponse("Missing status metadata", 400);
  }
  if (actorLogin && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(actorLogin))) {
    log.info({ deliveryId, statusId, actorLogin }, "Skipping GitHub status: cycloid-owned actor");
    return jsonResponse({ ok: true, skipped: true, reason: "cycloid_owned_sender" });
  }

  // Whole-delivery claim short-circuits a clean redelivery before the external PR lookup. On a
  // partial mid-loop failure below we RELEASE this claim so the redelivery re-enters the per-PR loop.
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  // The token mint + commit→PR lookup run AFTER the claim is committed and BEFORE the per-PR loop. A
  // transient failure here would otherwise leave the claim committed and let GitHub's redelivery dedup
  // drop the status event until the ~7-day TTL. Release the claim and return a non-200 so GitHub
  // redelivers (the per-PR loop's own partial-failure release handles mid-loop failures separately).
  let installationToken: string;
  let pullRequests: Awaited<ReturnType<typeof getPullRequestsForCommit>>;
  try {
    installationToken = await createInstallationToken(env, installationId);
    pullRequests = await getPullRequestsForCommit(installationToken, repoOwner, repoName, statusSha);
  } catch (error) {
    await releaseGithubWebhookClaim(request, rawBody, env.DB, "status_lookup_retryable").catch((releaseErr) =>
      log.warn({ error: String(releaseErr), deliveryId, statusId }, "Failed to release webhook claim for status retry"),
    );
    log.warn(
      { error: String(error), deliveryId, statusId, statusSha },
      "GitHub status commit→PR lookup failed; released claim for redelivery",
    );
    return jsonErrorResponse("status commit lookup failed — retry", 500);
  }
  if (pullRequests.length === 0) {
    // CI signal arrived for a commit with no associated PR. Could be a race, a token losing repo
    // access, or a malformed SHA; without a queryable signal we cannot see if this rate is climbing.
    await postStructuredEventToDd(env, {
      event: "webhook.commit_lookup_empty",
      webhook_source: WEBHOOK_SOURCE_GITHUB,
      status_sha: statusSha,
      repo_owner: repoOwner,
      repo_name: repoName,
    });
    return jsonResponse({ ok: true, skipped: true, reason: "no_pull_requests" });
  }

  const total = pullRequests.length;
  let handled = 0;
  let ignored = 0;
  let mismatched = 0;
  let duplicated = 0;
  const ignoredReasons: string[] = [];
  // FIX #11: claim idempotency PER (delivery, PR) and isolate per-PR errors so a transient mid-loop
  // failure only releases the failing PR's claim (and the whole-delivery claim) and surfaces a
  // non-200 for redelivery — the redelivery skips PRs that already succeeded (their per-PR claims
  // persist) and re-processes only the failed PR.
  const failedPrNumbers: number[] = [];
  for (const pr of pullRequests) {
    if (!pr.number || pr.headSha !== statusSha) {
      mismatched += 1;
      continue;
    }

    // The per-PR claim sits inside the per-PR try so a transient claim-time D1 throw is recorded as a
    // failed PR (catch below) and the whole-delivery release-and-500 fires, instead of escaping
    // uncaught and stranding the committed whole-delivery claim.
    try {
      const claimed = await claimGithubWebhookForPr(request, rawBody, env.DB, pr.number);
      if (!claimed) {
        duplicated += 1;
        continue;
      }

      const prUrl = pr.htmlUrl || `https://github.com/${repoOwner}/${repoName}/pull/${pr.number}`;
      const result = await ingestReviewLoopCommitStatusWebhook({
        env,
        deliveryId,
        sourceId: `commit-status:${statusId}:${pr.number}`,
        statusId,
        context,
        state: statusState,
        description,
        targetUrl,
        actorLogin,
        actorType,
        repoOwner,
        repoName,
        prNumber: pr.number,
        prUrl,
        headSha: statusSha,
      });
      if (result.status === "handled") {
        handled += 1;
      } else {
        ignored += 1;
        ignoredReasons.push(result.reason);
      }

      // Best-effort: a terminal-success commit status may have just turned the tracked head green.
      // Drive the done-state reconcile so verification doesn't wait for the next sweep tick when
      // review-loop/no-show state is already settled. Defer it off the hot path via waitUntil so the
      // 200 acks before this slow GitHub/DO work runs (GitHub times out webhooks ~10s). It's
      // sweep-backed and idempotent, so a deferred failure is safe — wrap in runWithSentryTag so it
      // is logged + Sentry-captured, never dropped. The reconcile result does NOT affect the per-PR
      // claim/redelivery decision (its own outcome is best-effort), so deferring preserves the loop's
      // idempotency semantics.
      // repoOwner / repoName are already asserted non-null by the metadata guard above (returns 400).
      if (statusState === "success") {
        const prNumber = pr.number;
        const emitCiSignal = () =>
          emitReviewLoopCiSignalFromWebhook(env, {
            prUrl,
            repoOwner,
            repoName,
            headSha: statusSha,
            token: installationToken,
            logger: log,
            // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
            waitUntil: executionCtx ? (promise) => executionCtx.waitUntil(promise) : undefined,
          });
        const deferred = runWithSentryTag("webhook.reconcile_review_loop_done", emitCiSignal, log, {
          message: "Review-loop webhook ci-signal emit failed (status); sweep will backstop",
          logFields: { deliveryId, statusId, prNumber },
          tags: { webhook_event: "status" },
        });
        if (executionCtx) executionCtx.waitUntil(deferred);
        else await deferred;
      }
    } catch (error) {
      // Record the failure FIRST and make the per-PR release defensive: if the release itself throws
      // (e.g. the same transient DB failure), the exception must not escape this catch — otherwise
      // failedPrNumbers.push would be skipped and the whole-delivery release-and-500 guard below would
      // never run, permanently dropping this PR on redelivery.
      failedPrNumbers.push(pr.number);
      const released = await releaseGithubWebhookClaimForPr(request, rawBody, env.DB, pr.number)
        .then(() => true)
        .catch(async (releaseError) => {
          log.warn(
            {
              deliveryId,
              statusId,
              prNumber: pr.number,
              context: "status_per_pr_release",
              error: String(releaseError),
            },
            "Failed to release per-PR webhook claim; PR may dedupe until TTL",
          );
          // A log alone never reaches Datadog; the locked claim strands this PR until the ~7-day TTL.
          await postStructuredEventToDd(env, {
            event: "webhook.claim_release_failed",
            webhook_source: WEBHOOK_SOURCE_GITHUB,
            delivery_id: deliveryId,
            status_id: statusId,
            pr_number: pr.number,
            error: String(releaseError),
          });
          return false;
        });
      log.warn(
        { deliveryId, statusId, prNumber: pr.number, error: String(error) },
        released
          ? "GitHub status ingest failed for PR; released per-PR claim for redelivery"
          : "GitHub status ingest failed for PR; per-PR claim release failed",
      );
    }
  }

  if (handled === 0 && ignored === 0 && mismatched > 0) {
    log.info(
      { deliveryId, statusId, statusSha, total, mismatched },
      "GitHub status skipped: no associated PR entries match status SHA",
    );
  }

  if (failedPrNumbers.length > 0) {
    await releaseGithubWebhookClaim(request, rawBody, env.DB, "status_partial_failure").catch(async (error) => {
      log.warn(
        { deliveryId, statusId, context: "status_partial_failure", error: String(error) },
        "Failed to release webhook claim after partial ingest; redelivery may dedupe until TTL",
      );
      await postStructuredEventToDd(env, {
        event: "webhook.claim_release_failed",
        webhook_source: WEBHOOK_SOURCE_GITHUB,
        delivery_id: deliveryId,
        status_id: statusId,
        context: "status_partial_failure",
        error: String(error),
      });
    });
    return jsonErrorResponse(`status ingest failed for ${failedPrNumbers.length} of ${total} pull requests`, 500);
  }

  return jsonResponse({
    ok: true,
    reviewLoop: true,
    total,
    handled,
    ignored,
    mismatched,
    duplicated,
    reasons: ignoredReasons,
  });
}

async function handleCheckRunEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<Response> {
  if (payload.action !== "completed") {
    log.info({ action: payload.action }, "Skipping GitHub check_run: unsupported action");
    return jsonResponse({ ok: true, skipped: true, reason: "unsupported_action" });
  }

  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!checkRun || !repository) {
    log.warn({}, "Skipping GitHub check_run: missing payload fields");
    return jsonErrorResponse("Missing check_run payload", 400);
  }

  const deliveryId = normalizeWebhookReference(request.headers.get("x-github-delivery"));
  const checkRunId = typeof checkRun.id === "number" ? checkRun.id : null;
  const checkRunStatus = typeof checkRun.status === "string" ? checkRun.status : "";
  const checkRunConclusion = typeof checkRun.conclusion === "string" ? checkRun.conclusion : null;
  const checkRunName = typeof checkRun.name === "string" ? checkRun.name : null;
  const checkRunHeadSha = normalizeWebhookReference(checkRun.head_sha);
  const pullRequests = Array.isArray(checkRun.pull_requests) ? checkRun.pull_requests : [];
  const { senderLogin, senderType } = extractCommonWebhookActor(payload);
  const checkRunApp = checkRun.app as Record<string, unknown> | undefined;
  const checkRunAppSlug = normalizeWebhookReference(checkRunApp?.slug);
  // `sender` is whoever triggered the event (can be a human on a rerequest); the producing bot is
  // on `check_run.app`. Prefer the app identity so capability matching and the cycloid filter
  // operate on the bot that actually generated the check.
  const actorLogin = checkRunAppSlug ? `${checkRunAppSlug}[bot]` : senderLogin;
  const actorType = checkRunAppSlug ? "Bot" : senderType;
  const { repoOwner, repoName, installationId } = extractRepoAndInstallation(payload, repository);

  log.info(
    {
      deliveryId,
      checkRunId,
      checkRunName,
      checkRunStatus,
      checkRunConclusion,
      checkRunHeadSha,
      pullRequestCount: pullRequests.length,
      senderLogin,
      senderType,
      checkRunAppSlug,
      actorLogin,
      actorType,
      repoOwner,
      repoName,
      installationId,
    },
    "Received GitHub check_run webhook",
  );

  if (checkRunStatus !== "completed") {
    return jsonResponse({ ok: true, skipped: true, reason: "check_run_not_completed" });
  }
  if (!checkRunId || !checkRunHeadSha || !repoOwner || !repoName) {
    log.error(
      { deliveryId, checkRunId, checkRunHeadSha, repoOwner, repoName },
      "GitHub check_run rejected: missing metadata",
    );
    return jsonErrorResponse("Missing check_run metadata", 400);
  }
  if (actorLogin && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(actorLogin))) {
    log.info({ deliveryId, checkRunId, actorLogin }, "Skipping GitHub check_run: cycloid-owned actor");
    return jsonResponse({ ok: true, skipped: true, reason: "cycloid_owned_sender" });
  }
  if (pullRequests.length === 0) {
    // CI check completed but the delivery carried no associated PR; surface a queryable signal so a
    // climbing rate (race / lost repo access) is visible rather than silently swallowed.
    await postStructuredEventToDd(env, {
      event: "webhook.commit_lookup_empty",
      webhook_source: WEBHOOK_SOURCE_GITHUB,
      status_sha: checkRunHeadSha,
      repo_owner: repoOwner,
      repo_name: repoName,
    });
    return jsonResponse({ ok: true, skipped: true, reason: "no_pull_requests" });
  }

  // Whole-delivery claim short-circuits a clean redelivery. On a partial mid-loop failure below we
  // RELEASE this claim so the redelivery re-enters the per-PR loop.
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  const total = pullRequests.length;
  let handled = 0;
  let ignored = 0;
  let mismatched = 0;
  let duplicated = 0;
  // CI-failure ingestion is a secondary pass over the same PR entries, so its outcomes are counted
  // separately to keep handled + ignored + mismatched === total (one primary outcome per PR entry).
  let ciHandled = 0;
  let ciIgnored = 0;
  const ignoredReasons: string[] = [];
  // FIX #11: also claim idempotency PER (delivery, PR) and isolate per-PR errors. A transient
  // mid-loop failure on one PR releases ONLY that PR's claim (and the whole-delivery claim) and
  // surfaces a non-200 so GitHub redelivers — the redelivery skips PRs that already succeeded (their
  // per-PR claims persist) and re-processes only the failed PR.
  const failedPrNumbers: number[] = [];
  // Terminal-success check_runs may have just turned a tracked head green. Mint one installation token
  // up front (only when we'll actually use it) to drive the inline done-state reconcile per PR below;
  // a mint failure just leaves the reconcile to the sweep.
  let reconcileToken: string | null = null;
  if (checkRunConclusion === "success" && installationId !== null) {
    try {
      reconcileToken = await createInstallationToken(env, installationId);
    } catch (error) {
      log.warn(
        { deliveryId, checkRunId, error: String(error) },
        "Review-loop webhook done-reconcile token mint failed (check_run); sweep will backstop",
      );
    }
  }
  for (const entry of pullRequests) {
    const pr = entry as Record<string, unknown> | undefined;
    if (!pr) {
      mismatched += 1;
      continue;
    }
    const prNumber = typeof pr.number === "number" ? pr.number : null;
    const prHead = pr.head as Record<string, unknown> | undefined;
    const prHeadSha = normalizeWebhookReference(prHead?.sha);
    if (!prNumber || !prHeadSha || prHeadSha !== checkRunHeadSha) {
      mismatched += 1;
      continue;
    }

    // The per-PR claim sits inside the per-PR try so a transient claim-time D1 throw is recorded as a
    // failed PR (catch below) and the whole-delivery release-and-500 fires, instead of escaping
    // uncaught and stranding the committed whole-delivery claim.
    try {
      const claimed = await claimGithubWebhookForPr(request, rawBody, env.DB, prNumber);
      if (!claimed) {
        duplicated += 1;
        continue;
      }

      if (checkRunConclusion && FAILING_CHECK_RUN_CONCLUSIONS.has(checkRunConclusion) && checkRunName) {
        const matchingRules = await listMatchingGithubCheckRules(env.DB, {
          repoOwner,
          repoName,
          checkName: checkRunName,
        });
        for (const rule of matchingRules) {
          await claimGithubCheckJob(env.DB, {
            rule,
            checkRunId,
            prNumber,
            headSha: prHeadSha,
            checkName: checkRunName,
            now: Date.now(),
          });
        }
      }

      const prUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;
      const result = await ingestReviewLoopCheckRunWebhook({
        env,
        deliveryId,
        sourceId: `check-run:${checkRunId}:${prNumber}`,
        checkRunId,
        checkRunName,
        checkRunStatus,
        checkRunConclusion,
        actorLogin,
        actorType,
        repoOwner,
        repoName,
        prNumber,
        prUrl,
        headSha: checkRunHeadSha,
      });
      if (result.status === "handled") {
        handled += 1;
      } else {
        ignored += 1;
        ignoredReasons.push(result.reason);
      }

      // CI-failure path: a failing terminal check_run from ANY app drives the loop until green.
      // Independent of the bot path above — cycloid-owned actors are already filtered upstream, and
      // the ci epoch upsert dedups on sourceId. Use a `ci-check:` prefix DISTINCT from the bot path's
      // `check-run:` sourceId: listKnownReviewLoopSourceIds is not source_kind-scoped, so a shared id
      // would let a CI signal count as a "known" bot source (and vice-versa) and corrupt the
      // bootstrap/head-reconciliation new-feedback check. The ci epoch's own dedup still works because
      // every ci ingestion for a given check run uses the same `ci-check:` id.
      if (checkRunConclusion && FAILING_CHECK_RUN_CONCLUSIONS.has(checkRunConclusion)) {
        const ciResult = await ingestReviewLoopCiFailureWebhook({
          env,
          deliveryId,
          sourceId: `ci-check:${checkRunId}:${prNumber}`,
          checkRunId,
          checkRunName,
          checkRunConclusion,
          actorLogin,
          actorType,
          repoOwner,
          repoName,
          prNumber,
          prUrl,
          headSha: checkRunHeadSha,
        });
        if (ciResult.status === "handled") {
          // FIX 7: do NOT sync the bot-progress status comment from the CI ingest path. A ci epoch
          // has no expected bots, so getLatestReviewLoopEpochForPr (which excludes ci epochs) finds
          // no bot/human epoch and the sync would otherwise post a "watching for reviews from <bots>"
          // status comment driven purely by a CI failure. A genuine bot/human epoch's status comment
          // is still synced by the bot path above and by the sweep.
          ciHandled += 1;
          if (ciResult.epoch.status === "ready") {
            const dispatchCiEpoch = () =>
              dispatchReviewLoopEpoch(env, ciResult.epoch, {
                nowMs: Date.now(),
                logger: log,
                trigger: "webhook_arrival",
              });
            const deferred = runWithSentryTag("webhook.dispatch_review_loop_ci_epoch", dispatchCiEpoch, log, {
              message: "Review-loop webhook ci epoch dispatch failed (check_run); sweep will backstop",
              logFields: { deliveryId, checkRunId, prNumber, epochId: ciResult.epoch.id },
              tags: { webhook_event: "check_run" },
            });
            if (executionCtx) executionCtx.waitUntil(deferred);
            else await deferred;
          } else {
            log.info(
              {
                deliveryId,
                checkRunId,
                prNumber,
                epochId: ciResult.epoch.id,
                epochStatus: ciResult.epoch.status,
              },
              "Review-loop webhook ci epoch handled but not ready; sweep will dispatch when ready",
            );
          }
        } else {
          ciIgnored += 1;
          ignoredReasons.push(`ci:${ciResult.reason}`);
        }
      }

      // Best-effort: a terminal-success check_run may have just turned the tracked head green. Drive
      // the done-state reconcile so verification doesn't wait for the next sweep tick when
      // review-loop/no-show state is already settled. Defer it off the hot path via waitUntil so the
      // 200 acks before this slow GitHub/DO work runs (GitHub times out webhooks ~10s).
      // Sweep-backed + idempotent, so a deferred failure is safe — wrap in runWithSentryTag so it is
      // logged + Sentry-captured, never dropped. The reconcile result does NOT affect the per-PR
      // claim/redelivery decision, so deferring preserves the loop's idempotency semantics.
      // reconcileToken is set only when checkRunConclusion ===
      // "success".
      if (reconcileToken) {
        const token = reconcileToken;
        const emitCiSignal = () =>
          emitReviewLoopCiSignalFromWebhook(env, {
            prUrl,
            repoOwner,
            repoName,
            headSha: checkRunHeadSha,
            token,
            logger: log,
            // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
            waitUntil: executionCtx ? (promise) => executionCtx.waitUntil(promise) : undefined,
          });
        const deferred = runWithSentryTag("webhook.reconcile_review_loop_done", emitCiSignal, log, {
          message: "Review-loop webhook ci-signal emit failed (check_run); sweep will backstop",
          logFields: { deliveryId, checkRunId, prNumber },
          tags: { webhook_event: "check_run" },
        });
        if (executionCtx) executionCtx.waitUntil(deferred);
        else await deferred;
      }
    } catch (error) {
      // Record the failure FIRST and make the per-PR release defensive: release ONLY this PR's claim
      // so the redelivery reprocesses it (succeeded PRs keep their claims), but if the release itself
      // throws (e.g. the same transient DB failure) the exception must not escape this catch —
      // otherwise failedPrNumbers.push would be skipped and the whole-delivery release-and-500 guard
      // below would never run, permanently dropping this PR on redelivery.
      failedPrNumbers.push(prNumber);
      const released = await releaseGithubWebhookClaimForPr(request, rawBody, env.DB, prNumber)
        .then(() => true)
        .catch(async (releaseError) => {
          log.warn(
            {
              deliveryId,
              checkRunId,
              prNumber,
              context: "check_run_per_pr_release",
              error: String(releaseError),
            },
            "Failed to release per-PR webhook claim; PR may dedupe until TTL",
          );
          await postStructuredEventToDd(env, {
            event: "webhook.claim_release_failed",
            webhook_source: WEBHOOK_SOURCE_GITHUB,
            delivery_id: deliveryId,
            check_run_id: checkRunId,
            pr_number: prNumber,
            error: String(releaseError),
          });
          return false;
        });
      log.warn(
        { deliveryId, checkRunId, prNumber, error: String(error) },
        released
          ? "GitHub check_run ingest failed for PR; released per-PR claim for redelivery"
          : "GitHub check_run ingest failed for PR; per-PR claim release failed",
      );
    }
  }

  if (handled === 0 && ignored === 0 && mismatched > 0) {
    log.info(
      { deliveryId, checkRunId, checkRunHeadSha, total, mismatched },
      "GitHub check_run skipped: no pull_requests entries match check head SHA",
    );
  }

  // Surface a non-200 so GitHub redelivers when any PR failed mid-loop. Release the whole-delivery
  // claim so the redelivery re-enters the per-PR loop (the per-PR claims that succeeded persist, so
  // only the failed PRs are reprocessed).
  if (failedPrNumbers.length > 0) {
    await releaseGithubWebhookClaim(request, rawBody, env.DB, "check_run_partial_failure").catch(async (error) => {
      log.warn(
        { deliveryId, checkRunId, context: "check_run_partial_failure", error: String(error) },
        "Failed to release webhook claim after partial ingest; redelivery may dedupe until TTL",
      );
      await postStructuredEventToDd(env, {
        event: "webhook.claim_release_failed",
        webhook_source: WEBHOOK_SOURCE_GITHUB,
        delivery_id: deliveryId,
        check_run_id: checkRunId,
        context: "check_run_partial_failure",
        error: String(error),
      });
    });
    return jsonErrorResponse(`check_run ingest failed for ${failedPrNumbers.length} of ${total} pull requests`, 500);
  }

  return jsonResponse({
    ok: true,
    reviewLoop: true,
    total,
    handled,
    ignored,
    mismatched,
    duplicated,
    ciHandled,
    ciIgnored,
    reasons: ignoredReasons,
  });
}

/**
 * Fetch a replied-to review comment's body via `GET /repos/{owner}/{repo}/pulls/comments/{id}` (the
 * reply webhook payload only carries `in_reply_to_id`, not the parent's body). Best-effort: a 404 or
 * transient failure returns null so a missing/unreadable parent never blocks the mention. The body is
 * untrusted GitHub text; the prompt builder wraps it before it reaches the agent.
 */
async function fetchParentReviewCommentBestEffort(
  token: string,
  owner: string,
  repo: string,
  parentCommentId: string,
  logFields: { deliveryId: string | null; commentId: number },
): Promise<{ author: string; body: string } | null> {
  try {
    const response = await tracedFetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${encodeURIComponent(
        parentCommentId,
      )}`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      log.warn(
        { ...logFields, parentCommentId, status: response.status },
        "GitHub PR review-comment mention: parent comment fetch failed; continuing without parent context",
      );
      return null;
    }
    const data = (await response.json()) as { body?: unknown; user?: { login?: unknown } };
    const body = typeof data.body === "string" ? data.body : "";
    const author = normalizeWebhookReference(data.user?.login) ?? "github_user";
    return { author, body };
  } catch (err) {
    log.warn(
      { ...logFields, parentCommentId, error: String(err) },
      "GitHub PR review-comment mention: parent comment fetch errored; continuing without parent context",
    );
    return null;
  }
}

async function handlePullRequestReviewCommentEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (payload.action !== "created") {
    log.info({ action: payload.action }, "Skipping GitHub PR review comment: unsupported action");
    return jsonResponse({ ok: true, skipped: true, reason: "unsupported_action" });
  }

  const comment = payload.comment as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!comment || !pullRequest || !repository) {
    log.warn({}, "Skipping GitHub PR review comment: missing payload fields");
    return jsonErrorResponse("Missing pull request review comment payload", 400);
  }

  const deliveryId = normalizeWebhookReference(request.headers.get("x-github-delivery"));
  const commentId = typeof comment.id === "number" ? comment.id : null;
  const reviewId = typeof comment.pull_request_review_id === "number" ? comment.pull_request_review_id : null;
  const commentBody = typeof comment.body === "string" ? comment.body : null;
  const commentCommitId = normalizeWebhookReference(comment.commit_id);
  const {
    userId: commentUserId,
    userLogin: commentAuthor,
    userType: commentUserType,
  } = extractGithubUserActor(recordField(comment.user));
  const prNumber = typeof pullRequest.number === "number" ? pullRequest.number : null;
  const prUrl = normalizeWebhookReference(pullRequest.html_url);
  const prHead = pullRequest.head as Record<string, unknown> | undefined;
  const headSha = normalizeWebhookReference(prHead?.sha) ?? "unknown";
  const { repoOwner, repoName, repositoryUrl, installationId } = extractRepoAndInstallation(payload, repository);

  log.info(
    {
      deliveryId,
      commentId,
      reviewId,
      commentCommitId,
      commentAuthor,
      commentUserType,
      prNumber,
      prUrl,
      repoOwner,
      repoName,
      installationId,
    },
    "Received GitHub PR review comment webhook",
  );

  // ARC-1514: a reply to a review comment that mentions `@cycloid` pulls Cycloid into THAT comment as
  // a targeted task, REGARDLESS of the per-user automatic-reviews toggle (mentions bypass it — no
  // resolveReviewLoopChecklist consult). The bot review-loop ingest below is untouched for non-mention
  // comments. Mirrors the top-level PR-mention branch in handleIssueCommentEvent (single writer = the
  // review-loop sweep; we only bootstrap a `ready` mention epoch + re-arm review_listening here).
  const appSlug = await getAppSlug(env);
  const reviewCommentMention = extractPromptFromIssueComment(commentBody, appSlug);
  if (reviewCommentMention.mentioned) {
    // ---- Parse the fields the bot ingest path drops (coerced exactly as pr-activity-capture.ts). ----
    const inReplyToId =
      typeof comment.in_reply_to_id === "number"
        ? String(comment.in_reply_to_id)
        : normalizeWebhookReference(comment.in_reply_to_id);
    const diffHunk = typeof comment.diff_hunk === "string" ? comment.diff_hunk : null;
    const filePath = normalizeWebhookReference(comment.path);
    const commentSide = normalizeWebhookReference(comment.side);

    // Build a complete GithubIssueCommentDetails view of the review comment so the shared, fail-closed
    // issue-comment auth helpers apply unchanged. Every field the filter/validate/resolve/authorize
    // helpers read is populated (issueId=PR numeric database id, issueNumber=prNumber, issueUrl=prUrl, senderId/
    // senderLogin/senderType from the comment author, repositoryUrl, installationId). A PARTIAL object
    // risks fail-open, so unread fields (title/body/labels) are still set to safe defaults.
    const mentionDetails: GithubIssueCommentDetails = {
      deliveryId,
      commentId,
      commentBody,
      commentPreview: previewText(commentBody),
      issueId: typeof pullRequest.id === "number" ? pullRequest.id : null,
      issueNumber: prNumber,
      issueTitle: typeof pullRequest.title === "string" ? pullRequest.title : "",
      issueBody: typeof pullRequest.body === "string" ? pullRequest.body : "",
      issueLabels: [],
      issueUrl: prUrl,
      issueIsPullRequest: true,
      repoOwner,
      repoName,
      repositoryUrl,
      installationId,
      senderId: commentUserId,
      senderLogin: commentAuthor,
      senderType: commentUserType,
    };

    // ---- Loop safety FIRST (before auth/claim) ----
    // 1) non-`User` sender + self-`appSlug` author.
    const actorFilterResponse = filterGithubIssueCommentActor(mentionDetails, appSlug);
    if (actorFilterResponse) return actorFilterResponse;

    // 2) Cycloid-owned bot authors (the owned set is bots-only; a user-typed login collision is
    //    fenced here too).
    const normalizedSender = commentAuthor ? normalizeGitHubActorLogin(commentAuthor) : null;
    if (normalizedSender && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedSender)) {
      log.warn(
        { deliveryId, commentId, prNumber, senderLogin: commentAuthor },
        "Skipping GitHub PR review-comment mention: owned-bot author",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "owned_bot_sender" });
    }

    // 3) Cycloid's OWN review-loop replies: a threaded reply is posted with the acting user's
    //    credentials, so GitHub attributes the review-comment to that user and the `appSlug` self-skip
    //    cannot catch it. Match the stored review-comment reply github_id instead (#7119/#7182).
    if (commentId) {
      let selfReplyIds: Set<string>;
      try {
        selfReplyIds = await selectReviewLoopReplyGithubIds(env.DB, [String(commentId)]);
      } catch (err) {
        log.warn(
          { error: String(err), deliveryId, commentId },
          "GitHub PR review-comment mention self-reply lookup failed; retrying delivery",
        );
        return jsonErrorResponse("pull_request_review_comment mention self-reply lookup failed — retry", 500);
      }
      if (selfReplyIds.has(String(commentId))) {
        log.warn(
          { deliveryId, commentId, prNumber },
          "Skipping GitHub PR review-comment mention: Cycloid-authored reply",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "self_reply" });
      }
    }

    // ---- Auth (fail closed): validate → resolve actor → authorize repo access ----
    const metadata = validateGithubIssueCommentMetadata(mentionDetails);
    if (!metadata.ok) return metadata.response;

    const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, reviewCommentMention.prompt);
    if (!actor.ok) {
      log.warn(
        {
          action: "pr_review_comment_mention",
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          prNumber: metadata.details.issueNumber,
          senderLogin: commentAuthor,
        },
        "GitHub PR review-comment mention denied: actor unresolved",
      );
      return actor.response;
    }

    const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
    if (unauthorizedResponse) {
      log.warn(
        {
          action: "pr_review_comment_mention",
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          prNumber: metadata.details.issueNumber,
          senderLogin: commentAuthor,
        },
        "GitHub PR review-comment mention denied: no repo access",
      );
      return unauthorizedResponse;
    }

    if (!metadata.details.commentId) {
      log.error(
        { deliveryId, prNumber: metadata.details.issueNumber },
        "GitHub PR review-comment mention rejected: missing comment id",
      );
      return jsonErrorResponse("Missing pull request review comment metadata", 400);
    }
    const mentionCommentId = metadata.details.commentId;
    const { repoOwner: mentionRepoOwner, repoName: mentionRepoName } = metadata.details;
    const mentionPrNumber = metadata.details.issueNumber;
    const mentionPrUrl = metadata.details.issueUrl;

    const duplicate = await claimGithubWebhook(request, rawBody, env);
    if (duplicate) return duplicate;

    // The whole-delivery claim is committed above. A transient failure during the multi-step bound-
    // session resolve + revive + head lookup + parent fetch + epoch bootstrap would otherwise leave the
    // claim committed and let GitHub's redelivery dedup drop the mention until the ~7-day TTL. Release
    // the claim and return non-200 so GitHub redelivers (bootstrap is idempotent on the mention
    // sentinel + source ids).
    try {
      // ---- Bound-session resolution: tracking winner → single ref else fail-closed → skip. ----
      let sessionId = await getTrackingSessionIdForPrUrl(env.DB, mentionPrUrl);
      if (!sessionId) {
        const refSessionIds = await listSessionIdsByWebhookRef(
          env.DB,
          SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
          mentionPrUrl,
        );
        if (refSessionIds.length === 1) {
          sessionId = refSessionIds[0];
        } else if (refSessionIds.length > 1) {
          log.warn(
            {
              action: "pr_review_comment_mention",
              repoOwner: mentionRepoOwner,
              repoName: mentionRepoName,
              prNumber: mentionPrNumber,
              senderLogin: commentAuthor,
              refCount: refSessionIds.length,
            },
            "Skipping GitHub PR review-comment mention: ambiguous bound session",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
        }
      }
      if (!sessionId) {
        // ARC-1515: an authorized Cycloid member replying `@cycloid` on a PR Cycloid did NOT author
        // adopts it. Gate on internal membership (fail-closed: non-members keep the no-bound-session
        // skip), then bootstrap a session and hand off to the targeted-mention epoch flow below. Mirrors
        // the top-level issue-comment mention branch (single writer = the sweep).
        const actorUser = await resolveInternalFeatureGateUser(env.DB, Number(actor.actorUserId));
        if (!actorUser || !isCycloidMember(actorUser) || !commentAuthor) {
          log.info(
            { deliveryId, repoOwner: mentionRepoOwner, repoName: mentionRepoName, prNumber: mentionPrNumber },
            "Skipping GitHub PR review-comment mention: no bound session",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "no_bound_session" });
        }

        // A bare `@cycloid` reply carries no directive text; that is fine — resolveSessionContinuation
        // uses the explicit continuePrUrl (not the prompt) and the targeted epoch below supplies the task
        // context (parent comment + diff hunk).
        const bootstrap = await bootstrapMentionSession(env, {
          actorUserId: actor.actorUserId,
          actorLogin: commentAuthor,
          actorBusinessId: actorUser.businessId,
          installationId: metadata.details.installationId,
          repoOwner: mentionRepoOwner,
          repoName: mentionRepoName,
          prUrl: mentionPrUrl,
          directiveText: reviewCommentMention.prompt ?? "",
          waitUntil: (promise) => ctx?.waitUntil(promise),
        });
        if (bootstrap.kind === "skip") {
          return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
        }
        if (bootstrap.kind === "rejected") {
          await postIssueComment(
            env,
            metadata.details.installationId,
            mentionRepoOwner,
            mentionRepoName,
            mentionPrNumber,
            bootstrap.publicMessage,
          ).catch((err) => {
            log.warn(
              {
                action: "pr_review_comment_mention",
                deliveryId,
                repoOwner: mentionRepoOwner,
                repoName: mentionRepoName,
                prNumber: mentionPrNumber,
                reason: bootstrap.reason,
                error: String(err),
              },
              "Failed to post GitHub mention bootstrap rejection comment",
            );
          });
          return jsonResponse({ ok: true, skipped: true, reason: bootstrap.reason });
        }
        if (bootstrap.kind === "retry") {
          throw new Error(`GitHub mention bootstrap retry requested: ${bootstrap.reason}`);
        }
        sessionId = bootstrap.sessionId;
      }

      // ---- PR-open gate (BEFORE any revive) ----
      // ensureSessionLiveForPr below unarchives + warms/cold-boots the sandbox, and getPrHeadSha
      // returns a SHA even for closed/merged PRs, so without this gate an @cycloid reply on a
      // terminal (closed/merged) PR would revive the sandbox and dispatch a mention epoch. Mirror the
      // top-level issue-comment mention handler: gate on PR-open state FIRST. Mint the installation
      // token once here and reuse it for the head-SHA + parent-comment fetch below. getPrState returns
      // "closed"/"merged" for a genuinely-not-open PR and null on a TRANSIENT GitHub failure
      // (404/429/5xx); a 401/403 throws. The gate runs AFTER the claim commit so a benign not-open
      // skip consumes the delivery (no redelivery, no revive), while the transient/throw path falls to
      // the catch below which releases the claim so GitHub redelivers (fail-closed retry).
      const installationToken = await createInstallationToken(env, metadata.details.installationId);
      const prState = await getPrState(installationToken, mentionRepoOwner, mentionRepoName, mentionPrNumber);
      if (prState === null) {
        // Indeterminate PR state (transient GitHub failure) — throw so the catch releases the claim
        // and GitHub redelivers, instead of reviving on an unknown state or silently dropping it.
        throw new Error("pr_review_comment mention PR-state lookup indeterminate — retry");
      }
      if (prState !== "open") {
        log.warn(
          {
            action: "pr_review_comment_mention",
            sessionId,
            repoOwner: mentionRepoOwner,
            repoName: mentionRepoName,
            prNumber: mentionPrNumber,
            prState,
          },
          "Skipping GitHub PR review-comment mention: PR not open",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "pr_not_open" });
      }

      // ---- Revive the PR-bound session (unarchive / warm the same sandbox / reuse it) so the mention
      //      can run even on a finished/stopped/archived session. ----
      const live = await ensureSessionLiveForPr({ env, db: env.DB, sessionId, prUrl: mentionPrUrl, nowMs: Date.now() });
      if (live.status !== "live") {
        log.warn(
          {
            action: "pr_review_comment_mention",
            sessionId,
            repoOwner: mentionRepoOwner,
            repoName: mentionRepoName,
            prNumber: mentionPrNumber,
            reason: live.status,
          },
          "Skipping GitHub PR review-comment mention: session not revivable",
        );
        return jsonResponse({ ok: true, skipped: true, reason: live.status });
      }

      // ---- Resolve the current PR head SHA for the epoch key (reuse the gate's token). ----
      const mentionHeadSha = await getPrHeadSha(installationToken, mentionRepoOwner, mentionRepoName, mentionPrNumber);
      if (!mentionHeadSha) {
        log.warn(
          {
            action: "pr_review_comment_mention",
            sessionId,
            repoOwner: mentionRepoOwner,
            repoName: mentionRepoName,
            prNumber: mentionPrNumber,
          },
          "Skipping GitHub PR review-comment mention: PR head unavailable",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "pr_head_unavailable" });
      }

      // ---- Fetch the replied-to parent comment BODY (not carried on the reply payload). Tolerate
      //      404/transient failures → parentComment: null so a missing parent never blocks the
      //      mention. Only fetch when this comment is a reply. ----
      let parentComment: { author: string; body: string } | null = null;
      if (inReplyToId) {
        parentComment = await fetchParentReviewCommentBestEffort(
          installationToken,
          mentionRepoOwner,
          mentionRepoName,
          inReplyToId,
          { deliveryId, commentId: mentionCommentId },
        );
      }

      // ---- Bootstrap a `ready` TARGETED mention epoch (the sweep dispatches it). The captured comment
      //      + parent bodies are point-in-time evidence, so a later reviewer edit can't change what the
      //      agent was asked to do. All fields are untrusted; the prompt builder wraps each segment. ----
      const epoch = await bootstrapMentionEpoch(env.DB, {
        sessionId,
        ownerUserId: Number(live.session.ownerUserId),
        repoOwner: mentionRepoOwner,
        repoName: mentionRepoName,
        prNumber: mentionPrNumber,
        prUrl: mentionPrUrl,
        headSha: mentionHeadSha,
        mode: "targeted",
        targetSourceIds: [`review-comment:${mentionCommentId}`],
        parentSourceIds: inReplyToId ? [`review-comment:${inReplyToId}`] : [],
        mentionText: reviewCommentMention.prompt ?? "",
        comment: {
          author: commentAuthor ?? "github_user",
          body: commentBody ?? "",
          path: filePath,
          diffHunk,
        },
        parentComment,
        nowMs: Date.now(),
      });
      if (!epoch) {
        // OR-IGNORE contention exhausted its retry budget with no committed row — retry via redelivery
        // rather than silently dropping the mention.
        throw new Error("bootstrapMentionEpoch exhausted its retry budget");
      }

      // ---- Re-arm review_listening so the sweep can dispatch this mention epoch even on a just-revived
      //      (unarchived / cold-booted) session. The enter route returns updated:false ONLY when the
      //      session is archived again (re-archive race) — the epoch is then NOT dispatchable, so treat
      //      !updated as retryable (release claim + redeliver), mirroring reengageSessionForReview. ----
      const listening = await emitReviewListeningEntered(env, sessionId, {
        headSha: mentionHeadSha,
        prUrl: mentionPrUrl,
      });
      if (!listening || !listening.ok || !listening.payload?.updated) {
        const reason = listening?.payload?.reason ?? (listening ? `http_${listening.status}` : "no_pr_url");
        throw new Error(`emitReviewListeningEntered not durable for mention: ${reason}`);
      }

      log.info(
        {
          action: "pr_review_comment_mention",
          deliveryId,
          sessionId,
          epochId: epoch.id,
          repoOwner: mentionRepoOwner,
          repoName: mentionRepoName,
          prNumber: mentionPrNumber,
          inReplyToId,
          side: commentSide,
          hasParent: parentComment !== null,
        },
        "GitHub PR review-comment mention bootstrapped targeted mention epoch",
      );
      // 👀 acknowledge the mention on the reply comment itself (manual mode suppresses the ingest ack).
      scheduleReviewAckReaction(env, ctx, {
        installationId: metadata.details.installationId,
        owner: mentionRepoOwner,
        repo: mentionRepoName,
        actorLogin: commentAuthor,
        actorType: commentUserType,
        surface: { kind: "review_comment", commentId: mentionCommentId, body: commentBody ?? null },
      });
      return jsonResponse({ ok: true, mention: true, epochId: epoch.id, sessionId });
    } catch (err) {
      await releaseGithubWebhookClaimBestEffort({
        request,
        rawBody,
        db: env.DB,
        reason: "pr_review_comment_mention_retryable",
        logFields: { deliveryId, commentId: mentionCommentId },
        warnMessage: "Failed to release webhook claim for review-comment mention retry",
      });
      log.warn(
        { error: String(err), deliveryId, commentId: mentionCommentId },
        "GitHub PR review-comment mention failed; released claim for redelivery",
      );
      return jsonErrorResponse("pull_request_review_comment mention failed — retry", 500);
    }
  }

  if (!commentId || !prNumber || !prUrl || !repoOwner || !repoName || !installationId) {
    log.error(
      { deliveryId, commentId, prNumber, prUrl, repoOwner, repoName, installationId },
      "GitHub PR review comment rejected: missing review comment metadata",
    );
    return jsonErrorResponse("Missing pull request review comment metadata", 400);
  }

  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  // The whole-delivery claim is committed above. A transient ingest failure (D1/GitHub) would
  // otherwise leave it committed and let GitHub's redelivery dedup drop the review comment until the
  // ~7-day TTL. Release the claim and return a non-200 so GitHub redelivers; the ingest is idempotent
  // on sourceId (epoch upsert), so reprocessing is safe.
  try {
    const result = await ingestReviewLoopPullRequestReviewCommentWebhook({
      env,
      deliveryId,
      sourceId: `review-comment:${commentId}`,
      commentId,
      commentBody,
      commentCommitId,
      actorLogin: commentAuthor,
      actorType: commentUserType,
      repoOwner,
      repoName,
      prNumber,
      prUrl,
      headSha,
      // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
      waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    });
    if (result.status === "handled") {
      scheduleReviewAckReaction(env, ctx, {
        installationId,
        owner: repoOwner,
        repo: repoName,
        actorLogin: commentAuthor,
        actorType: commentUserType,
        surface: { kind: "review_comment", commentId, body: commentBody ?? null },
      });
      return jsonResponse({ ok: true, reviewLoop: true, epochId: result.epoch.id, status: result.epoch.status });
    }
    if (commentUserType === "User") {
      try {
        const selfPostedIds = await selectReviewLoopReplyGithubIds(env.DB, [String(commentId)]);
        if (!selfPostedIds.has(String(commentId))) {
          dispatchHumanGithubPrActionAlert(
            {
              env,
              deliveryId,
              prUrl,
              prNumber,
              repoOwner,
              repoName,
              actorLogin: commentAuthor,
              actorType: commentUserType,
              actionKind: "pull_request_review_comment",
              reviewId,
              commentId,
            },
            ctx ? (promise) => ctx.waitUntil(promise) : undefined,
          );
        }
      } catch (alertError) {
        log.warn(
          { error: String(alertError), deliveryId, commentId, prUrl },
          "Skipped human GitHub inline review comment alert after self-reply lookup failed",
        );
      }
    }

    return jsonResponse({ ok: true, skipped: true, reason: result.reason });
  } catch (err) {
    await releaseGithubWebhookClaimBestEffort({
      request,
      rawBody,
      db: env.DB,
      reason: "review_comment_ingest_retryable",
      logFields: { deliveryId, prUrl, commentId },
      warnMessage: "Failed to release webhook claim for review comment retry",
    });
    log.warn(
      { error: String(err), deliveryId, prUrl, commentId },
      "GitHub PR review comment ingest failed; released claim for redelivery",
    );
    return jsonErrorResponse("pull_request_review_comment ingest failed — retry", 500);
  }
}

// ---------------------------------------------------------------------------
// Factored helpers used by handlePullRequestReviewEvent
// ---------------------------------------------------------------------------

interface PrReviewExtractedFields {
  deliveryId: string | null;
  reviewId: number | null;
  reviewState: string;
  reviewBody: string | null;
  reviewAuthor: string | null;
  reviewUserId: number | null;
  reviewUserType: string;
  reviewCommitId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prHead: Record<string, unknown> | undefined;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string;
  installationId: number | null;
  repository: Record<string, unknown>;
  pullRequest: Record<string, unknown>;
}

type PrReviewExtractResult = { ok: true; fields: PrReviewExtractedFields } | { ok: false; response: Response };

function extractReviewEventFromPayload(payload: Record<string, unknown>, request: Request): PrReviewExtractResult {
  const review = payload.review as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!review || !pullRequest || !repository) {
    log.warn({}, "Skipping GitHub PR review: missing payload fields");
    return { ok: false, response: jsonErrorResponse("Missing pull request review payload", 400) };
  }

  const deliveryId = normalizeWebhookReference(request.headers.get("x-github-delivery"));
  const reviewId = typeof review.id === "number" ? review.id : null;
  const reviewState = (normalizeWebhookReference(review.state) ?? "").toLowerCase();
  const reviewBody = typeof review.body === "string" ? review.body : null;
  const {
    userId: reviewUserId,
    userLogin: reviewAuthor,
    userType: reviewUserType,
  } = extractGithubUserActor(recordField(review.user));
  const prNumber = typeof pullRequest.number === "number" ? pullRequest.number : null;
  const prUrl = normalizeWebhookReference(pullRequest.html_url);
  const prHead = pullRequest.head as Record<string, unknown> | undefined;
  const { repoOwner, repoName, repositoryUrl, installationId } = extractRepoAndInstallation(payload, repository);
  const repoUrl = repositoryUrl ?? "";

  return {
    ok: true,
    fields: {
      deliveryId,
      reviewId,
      reviewState,
      reviewBody,
      reviewAuthor,
      reviewUserId,
      reviewUserType,
      reviewCommitId: normalizeWebhookReference(review.commit_id),
      prNumber,
      prUrl,
      prHead,
      repoOwner,
      repoName,
      repoUrl,
      installationId,
      repository,
      pullRequest,
    },
  };
}

function isCycloidAppLogin(reviewAuthor: string | null, appSlug: string): boolean {
  if (!reviewAuthor) return false;
  return reviewAuthor.toLowerCase() === appSlug.toLowerCase();
}

function isEmptyApproval(reviewState: string, reviewBody: string | null, triggeringReviewComments: unknown[]): boolean {
  return reviewState === "approved" && (reviewBody?.trim().length ?? 0) === 0 && triggeringReviewComments.length === 0;
}

// ---------------------------------------------------------------------------
// Human review router (v1.1): dispatches bot + human reviews through the
// review-loop epoch machinery.
// ---------------------------------------------------------------------------

type HumanLoopPerSessionResult =
  | { sessionId: string; status: "ingest_handled"; epochId: string }
  | { sessionId: string; status: "ingest_ignored"; reason: string }
  | { sessionId: string; status: "reengaged"; epochId: string }
  | { sessionId: string; status: "already_reengaged"; epochId: string }
  | { status: "pr_not_open"; sessionId: string }
  | { status: "transient_pr_state"; sessionId: string }
  | { status: "session_not_found"; sessionId: string }
  | { status: "not_eligible"; sessionId: string; reason: string }
  | { status: "session_archived"; sessionId: string }
  | { status: "warm_failed"; sessionId: string; error: string }
  | { status: "enter_review_listening_failed"; sessionId: string; error?: string }
  | { status: "epoch_bootstrap_failed"; sessionId: string; error: string; retryable: boolean }
  | { sessionId: string; status: "errored"; error: string };

type HumanLoopLoadedSessionCandidate = {
  sessionId: string;
  session: NonNullable<Awaited<ReturnType<typeof getSessionState>>>;
};
type HumanLoopSessionCandidate =
  | HumanLoopLoadedSessionCandidate
  | { sessionId: string; session: null }
  | { sessionId: string; status: "errored"; error: string };

async function handlePullRequestReviewEventHumanLoop(
  env: Env,
  rawBody: string,
  request: Request,
  f: PrReviewExtractedFields,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!f.reviewId || !f.prNumber || !f.prUrl || !f.repoOwner || !f.repoName || !f.installationId) {
    log.error(
      {
        deliveryId: f.deliveryId,
        reviewId: f.reviewId,
        prNumber: f.prNumber,
        prUrl: f.prUrl,
        repoOwner: f.repoOwner,
        repoName: f.repoName,
        installationId: f.installationId,
      },
      "GitHub PR review rejected: missing review metadata",
    );
    return jsonErrorResponse("Missing pull request review metadata", 400);
  }

  if (!f.reviewUserId || !f.reviewAuthor) {
    log.warn(
      { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber },
      "Skipping GitHub PR review: missing reviewer identity",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "missing_reviewer_identity" });
  }

  const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, f.prUrl);
  if (sessionIds.length === 0) {
    log.info(
      { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber, prUrl: f.prUrl },
      "Skipping GitHub PR review: no matching sessions",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "no_matching_sessions" });
  }

  // Check empty-approval before claiming the webhook to avoid holding a claim on skipped deliveries.
  const installationToken = await createInstallationToken(env, f.installationId);
  const comments = await getPrReviewComments(installationToken, f.repoOwner, f.repoName, f.prNumber);
  const triggeringReviewComments = comments.filter((comment) => comment.reviewId === f.reviewId);

  if (isEmptyApproval(f.reviewState, f.reviewBody, triggeringReviewComments)) {
    log.info(
      { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber },
      "Skipping GitHub PR review: empty approval",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "empty_approval" });
  }

  // Self-trigger guard for legacy/user-authored reply deliveries. Current review-loop replies post
  // as cycloid[bot], so their implicit empty-body reviews take the bot ingest path and are dropped
  // by the Cycloid-owned actor allow-list. Keep this user-path guard for historical deliveries and
  // any race where a reply was posted before bot attribution shipped. Only an implicit review whose
  // comments are ALL replies we posted is dropped; any genuinely human comment (or an unknown
  // comment id) fails the check and the review is processed.
  // Consistency assumption: the github_id is written by markReviewLoopOperationSucceeded in the
  // same request that posts the reply, normally well before GitHub delivers this webhook. If a
  // delivery races that write, the guard fails open and admits at most one extra loop iteration —
  // the next implicit review sees the committed row and is dropped.
  if ((f.reviewBody?.trim().length ?? 0) === 0 && triggeringReviewComments.length > 0) {
    const commentIds = triggeringReviewComments
      .map((comment) => comment.id)
      .filter((id): id is number => typeof id === "number");
    if (commentIds.length === triggeringReviewComments.length) {
      const selfPostedIds = await selectReviewLoopReplyGithubIds(
        env.DB,
        commentIds.map((id) => String(id)),
      );
      if (commentIds.every((id) => selfPostedIds.has(String(id)))) {
        log.info(
          { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber, commentIds },
          "Skipping GitHub PR review: implicit review around self-posted review-loop replies",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "review_loop_reply_self_trigger" });
      }
    }
  }

  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  const ev: ReviewEventLite = {
    reviewId: f.reviewId,
    prUrl: f.prUrl,
    prNumber: f.prNumber,
    repoOwner: f.repoOwner,
    repoName: f.repoName,
    headSha: normalizeWebhookReference(f.prHead?.sha) ?? "unknown",
    reviewAuthor: f.reviewAuthor,
    reviewUserId: f.reviewUserId,
    installationId: f.installationId,
  };

  const humanSource = { userId: f.reviewUserId, login: f.reviewAuthor };
  const sessionCandidates: HumanLoopSessionCandidate[] = await Promise.all(
    sessionIds.map(async (sessionId): Promise<HumanLoopSessionCandidate> => {
      try {
        return { sessionId, session: await getSessionState(env, sessionId) };
      } catch (err) {
        const error = stringifyError(err);
        await runWithSentryTag(
          "handlePullRequestReviewEvent.humanLoop",
          () => Promise.reject(err),
          log.child({ sessionId, prNumber: f.prNumber }),
        );
        return { sessionId, status: "errored", error };
      }
    }),
  );
  const perSessionResults: HumanLoopPerSessionResult[] = await Promise.all(
    sessionCandidates.map(async (candidate): Promise<HumanLoopPerSessionResult> => {
      const { sessionId } = candidate;
      if ("status" in candidate) return candidate;
      try {
        const { session } = candidate;
        const isListening = session?.status === "active" && Boolean(session.reviewListeningActive);

        if (isListening) {
          // Fold human into the existing bot wave, scoped to this specific
          // session so parallel outer iterations each target their own epoch.
          const result = await ingestReviewLoopPullRequestReviewWebhook({
            env,
            deliveryId: f.deliveryId,
            sourceId: `human:${f.reviewId}`,
            reviewId: f.reviewId!,
            reviewState: f.reviewState,
            reviewBody: f.reviewBody,
            reviewCommitId: f.reviewCommitId,
            actorLogin: f.reviewAuthor,
            actorType: f.reviewUserType,
            repoOwner: f.repoOwner!,
            repoName: f.repoName!,
            prNumber: f.prNumber!,
            prUrl: f.prUrl!,
            headSha: normalizeWebhookReference(f.prHead?.sha) ?? "unknown",
            humanSource,
            sessionId,
            // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
            waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
          });
          if (result.status === "handled") {
            return { sessionId, status: "ingest_handled", epochId: result.epoch.id };
          }
          return { sessionId, status: "ingest_ignored", reason: result.reason };
        }

        // Active-but-idle or archived: reengage.
        const reengageResult = await reengageSessionForReview({
          env,
          db: env.DB,
          sessionId,
          ev,
        });
        return reengageResult;
      } catch (err) {
        const error = stringifyError(err);
        await runWithSentryTag(
          "handlePullRequestReviewEvent.humanLoop",
          () => Promise.reject(err),
          log.child({ sessionId, prNumber: f.prNumber }),
        );
        return { sessionId, status: "errored", error };
      }
    }),
  );

  // 👀 acknowledge the human review ONCE (not per session) when at least one session ingested it.
  if (perSessionResults.some((r) => r.status === "ingest_handled")) {
    scheduleReviewAckReaction(env, ctx, {
      installationId: f.installationId,
      owner: f.repoOwner!,
      repo: f.repoName!,
      actorLogin: f.reviewAuthor,
      actorType: f.reviewUserType,
      surface: {
        kind: "review_submission",
        reviewId: f.reviewId,
        reviewBody: f.reviewBody,
        prNumber: f.prNumber!,
        inlineComments: triggeringReviewComments,
      },
    });
  }

  // Summarize results.
  let ingestHandled = 0;
  let ingestIgnored = 0;
  let reengaged = 0;
  let alreadyReengaged = 0;
  let prNotOpen = 0;
  let sessionNotFound = 0;
  let notEligible = 0;
  let sessionArchived = 0;
  let warmFailed = 0;
  let enterReviewListeningFailed = 0;
  let epochBootstrapFailed = 0;
  let retryableEpochBootstrapFailed = 0;
  let transientPrState = 0;
  let errored = 0;

  for (const r of perSessionResults) {
    switch (r.status) {
      case "ingest_handled":
        ingestHandled++;
        break;
      case "ingest_ignored":
        ingestIgnored++;
        break;
      case "reengaged":
        reengaged++;
        break;
      case "already_reengaged":
        alreadyReengaged++;
        break;
      case "pr_not_open":
        prNotOpen++;
        break;
      case "session_not_found":
        sessionNotFound++;
        break;
      case "not_eligible":
        notEligible++;
        break;
      case "session_archived":
        sessionArchived++;
        break;
      case "warm_failed":
        warmFailed++;
        break;
      case "enter_review_listening_failed":
        enterReviewListeningFailed++;
        break;
      case "epoch_bootstrap_failed":
        epochBootstrapFailed++;
        if (r.retryable) retryableEpochBootstrapFailed++;
        break;
      case "transient_pr_state":
        transientPrState++;
        break;
      case "errored":
        errored++;
        break;
    }
  }

  // A retryable PR-state lookup failure, failed review-listening enter, D1 bootstrap failure, or
  // thrown per-session error means the human review was NOT durably handled for that session. The
  // idempotency claim was already committed before this loop, so returning 200 would let GitHub's
  // dedup drop the redelivery until the claim TTL expires. Release the claim and return a non-200
  // so GitHub redelivers immediately — existing per-session epochs are reused on retry and the
  // review-listening enter is attempted again.
  if (transientPrState > 0 || enterReviewListeningFailed > 0 || retryableEpochBootstrapFailed > 0 || errored > 0) {
    await releaseGithubWebhookClaimBestEffort({
      request,
      rawBody,
      db: env.DB,
      reason: "review_reengage_retryable",
      logFields: { prUrl: f.prUrl },
      warnMessage: "Failed to release webhook claim for review retry",
    });
    return jsonErrorResponse(
      `pull_request_review reengage incomplete (transient=${transientPrState}, enter_review_listening=${enterReviewListeningFailed}, epoch_bootstrap=${retryableEpochBootstrapFailed}, errored=${errored}) — retry`,
      500,
    );
  }

  dispatchHumanGithubPrActionAlert(
    {
      env,
      deliveryId: f.deliveryId,
      prUrl: f.prUrl,
      prNumber: f.prNumber,
      repoOwner: f.repoOwner,
      repoName: f.repoName,
      actorLogin: f.reviewAuthor,
      actorType: f.reviewUserType,
      actionKind: "pull_request_review",
      reviewId: f.reviewId,
      sessionIds,
    },
    ctx ? (promise) => ctx.waitUntil(promise) : undefined,
  );

  return jsonResponse({
    ok: true,
    total: sessionIds.length,
    ingest_handled: ingestHandled,
    ingest_ignored: ingestIgnored,
    reengaged,
    already_reengaged: alreadyReengaged,
    pr_not_open: prNotOpen,
    session_not_found: sessionNotFound,
    not_eligible: notEligible,
    session_archived: sessionArchived,
    warm_failed: warmFailed,
    enter_review_listening_failed: enterReviewListeningFailed,
    epoch_bootstrap_failed: epochBootstrapFailed,
    transient_pr_state: transientPrState,
    errored,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function handlePullRequestReviewEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Step 1: action guard.
  if (payload.action !== "submitted") {
    log.info({ action: payload.action }, "Skipping GitHub PR review: unsupported action");
    return jsonResponse({ ok: true, skipped: true, reason: "unsupported_action" });
  }

  // Step 2: extract fields.
  const extracted = extractReviewEventFromPayload(payload, request);
  if (!extracted.ok) return extracted.response;
  const f = extracted.fields;

  log.info(
    {
      deliveryId: f.deliveryId,
      reviewId: f.reviewId,
      reviewState: f.reviewState,
      reviewAuthor: f.reviewAuthor,
      githubUserId: f.reviewUserId,
      reviewUserType: f.reviewUserType,
      prNumber: f.prNumber,
      prUrl: f.prUrl,
      repoOwner: f.repoOwner,
      repoName: f.repoName,
      installationId: f.installationId,
    },
    "Received GitHub PR review webhook",
  );

  const isBot = f.reviewUserType !== "User";

  // Step 3: bot → ingest immediately (preserves original bot-path ordering; ingest
  // does its own session lookup internally).
  if (isBot) {
    if (f.reviewId && f.prNumber && f.prUrl && f.repoOwner && f.repoName && f.installationId) {
      const duplicate = await claimGithubWebhook(request, rawBody, env);
      if (duplicate) return duplicate;
      // The whole-delivery claim is committed above. A transient ingest failure (D1/GitHub) would
      // otherwise leave it committed and let GitHub's redelivery dedup drop the bot review until the
      // ~7-day TTL. Release the claim and return a non-200 so GitHub redelivers; the ingest is
      // idempotent on sourceId (epoch upsert), so reprocessing is safe.
      try {
        const result = await ingestReviewLoopPullRequestReviewWebhook({
          env,
          deliveryId: f.deliveryId,
          sourceId: `human:${f.reviewId}`,
          reviewId: f.reviewId,
          reviewState: f.reviewState,
          reviewBody: f.reviewBody,
          reviewCommitId: f.reviewCommitId,
          actorLogin: f.reviewAuthor,
          actorType: f.reviewUserType,
          repoOwner: f.repoOwner,
          repoName: f.repoName,
          prNumber: f.prNumber,
          prUrl: f.prUrl,
          headSha: normalizeWebhookReference(f.prHead?.sha) ?? "unknown",
          // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
          waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
        });
        if (result.status === "handled") {
          scheduleReviewAckReaction(env, ctx, {
            installationId: f.installationId,
            owner: f.repoOwner,
            repo: f.repoName,
            actorLogin: f.reviewAuthor,
            actorType: f.reviewUserType,
            surface: {
              kind: "review_submission",
              reviewId: f.reviewId,
              reviewBody: f.reviewBody,
              prNumber: f.prNumber,
            },
          });
          return jsonResponse({ ok: true, reviewLoop: true, epochId: result.epoch.id, status: result.epoch.status });
        }
        log.warn(
          {
            deliveryId: f.deliveryId,
            reviewId: f.reviewId,
            reviewAuthor: f.reviewAuthor,
            reviewUserType: f.reviewUserType,
            prNumber: f.prNumber,
            prUrl: f.prUrl,
            reason: result.reason,
          },
          "Skipping GitHub bot PR review after review-loop ingest ignored it",
        );
        return jsonResponse({ ok: true, skipped: true, reason: result.reason });
      } catch (err) {
        await releaseGithubWebhookClaimBestEffort({
          request,
          rawBody,
          db: env.DB,
          reason: "review_loop_bot_ingest_retryable",
          logFields: { deliveryId: f.deliveryId, reviewId: f.reviewId, prUrl: f.prUrl },
          warnMessage: "Failed to release webhook claim for bot review retry",
        });
        log.warn(
          { error: String(err), deliveryId: f.deliveryId, reviewId: f.reviewId, prUrl: f.prUrl },
          "GitHub bot PR review ingest failed; released claim for redelivery",
        );
        return jsonErrorResponse("pull_request_review bot ingest failed — retry", 500);
      }
    }
    log.warn(
      {
        deliveryId: f.deliveryId,
        reviewId: f.reviewId,
        reviewAuthor: f.reviewAuthor,
        reviewUserType: f.reviewUserType,
        prNumber: f.prNumber,
        prUrl: f.prUrl,
      },
      "Skipping GitHub bot PR review: missing required fields",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "missing_required_fields" });
  }

  // Step 4: self-trigger check (User type).
  const appSlug = await getAppSlug(env);
  if (isCycloidAppLogin(f.reviewAuthor, appSlug)) {
    log.warn(
      { deliveryId: f.deliveryId, reviewId: f.reviewId, reviewAuthor: f.reviewAuthor, prNumber: f.prNumber, appSlug },
      "Skipping GitHub PR review: self-trigger",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "self_trigger" });
  }

  // Step 4b: review-body `@cycloid …` directive (ARC-1514). A human review whose BODY mentions
  // @cycloid is pulled into the PR as a directive task REGARDLESS of the per-user automatic-reviews
  // toggle (mentions bypass it — no resolveReviewLoopChecklist consult), and is routed here INSTEAD OF
  // the normal human-review loop (Step 5) so manual mode never ignores it and the delivery claim isn't
  // consumed by the human-loop ingest first. Mirrors the top-level PR-mention branch in
  // handleIssueCommentEvent (single writer = the review-loop sweep; we only bootstrap a `ready`
  // directive mention epoch keyed `review-body:<reviewId>` + re-arm review_listening). Non-mention
  // review bodies fall through to Step 5 unchanged. Bots never reach here (Step 3 returns) and the app's
  // own reviews are dropped by the Step 4 self-trigger guard above.
  const reviewBodyMention = extractPromptFromIssueComment(f.reviewBody, appSlug);
  if (reviewBodyMention.mentioned) {
    // Build a complete GithubIssueCommentDetails view of the review submission so the shared, fail-closed
    // issue-comment auth helpers apply unchanged (issueId=PR numeric database id, issueNumber=prNumber, issueUrl=prUrl,
    // commentId=reviewId, senderId/senderLogin/senderType from the review author, repositoryUrl,
    // installationId). A PARTIAL object risks fail-open, so unread fields are still set to safe defaults.
    const mentionDetails: GithubIssueCommentDetails = {
      deliveryId: f.deliveryId,
      commentId: f.reviewId,
      commentBody: f.reviewBody,
      commentPreview: previewText(f.reviewBody),
      issueId: typeof f.pullRequest.id === "number" ? f.pullRequest.id : null,
      issueNumber: f.prNumber,
      issueTitle: typeof f.pullRequest.title === "string" ? f.pullRequest.title : "",
      issueBody: typeof f.pullRequest.body === "string" ? f.pullRequest.body : "",
      issueLabels: [],
      issueUrl: f.prUrl,
      issueIsPullRequest: true,
      repoOwner: f.repoOwner,
      repoName: f.repoName,
      repositoryUrl: f.repoUrl,
      installationId: f.installationId,
      senderId: f.reviewUserId,
      senderLogin: f.reviewAuthor,
      senderType: f.reviewUserType,
    };

    // ---- Loop safety FIRST (before auth/claim) ----
    // 1) non-`User` sender + self-`appSlug` author (a bot never reaches here — Step 3 returns; the app's
    //    own review was dropped by Step 4 — kept for defense-in-depth so the mirror is exact).
    const actorFilterResponse = filterGithubIssueCommentActor(mentionDetails, appSlug);
    if (actorFilterResponse) return actorFilterResponse;

    // 2) Cycloid-owned bot authors posted as a User (the owned set is bots-only; a user-typed login
    //    collision is fenced here too).
    const normalizedSender = f.reviewAuthor ? normalizeGitHubActorLogin(f.reviewAuthor) : null;
    if (normalizedSender && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedSender)) {
      log.warn(
        { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber, senderLogin: f.reviewAuthor },
        "Skipping GitHub PR review-body mention: owned-bot author",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "owned_bot_sender" });
    }

    // 3) Cycloid's OWN review-loop output: a summary comment / reply posted with the acting user's
    //    credentials is attributed to that user, so the `appSlug` self-skip cannot catch it. Match the
    //    stored review-body/issue-comment reply github_id instead (#7119/#7182 self-reply-loop incident).
    //    Scans the issue-comment/review-body id namespace only.
    if (f.reviewId) {
      let selfReplyIds: Set<string>;
      try {
        selfReplyIds = await selectReviewLoopIssueCommentReplyGithubIds(env.DB, [String(f.reviewId)]);
      } catch (err) {
        log.warn(
          { error: String(err), deliveryId: f.deliveryId, reviewId: f.reviewId },
          "GitHub PR review-body mention self-reply lookup failed; retrying delivery",
        );
        return jsonErrorResponse("pull_request_review mention self-reply lookup failed — retry", 500);
      }
      if (selfReplyIds.has(String(f.reviewId))) {
        log.warn(
          { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: f.prNumber },
          "Skipping GitHub PR review-body mention: Cycloid-authored review",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "self_reply" });
      }
    }

    // ---- Auth (fail closed): validate → resolve actor → authorize repo access ----
    const metadata = validateGithubIssueCommentMetadata(mentionDetails);
    if (!metadata.ok) return metadata.response;

    const actor = await resolveGithubIssueCommentActor(env, metadata.details, appSlug, reviewBodyMention.prompt);
    if (!actor.ok) {
      log.warn(
        {
          action: "pr_review_body_mention",
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          prNumber: metadata.details.issueNumber,
          senderLogin: f.reviewAuthor,
        },
        "GitHub PR review-body mention denied: actor unresolved",
      );
      return actor.response;
    }

    const unauthorizedResponse = await authorizeGithubIssueCommentActor(env, metadata.details, actor.actorUserId);
    if (unauthorizedResponse) {
      log.warn(
        {
          action: "pr_review_body_mention",
          repoOwner: metadata.details.repoOwner,
          repoName: metadata.details.repoName,
          prNumber: metadata.details.issueNumber,
          senderLogin: f.reviewAuthor,
        },
        "GitHub PR review-body mention denied: no repo access",
      );
      return unauthorizedResponse;
    }

    // A bare `@cycloid` review body with no free text carries no actionable directive.
    const directiveText = reviewBodyMention.prompt;
    if (!directiveText) {
      log.info(
        { deliveryId: f.deliveryId, reviewId: f.reviewId, prNumber: metadata.details.issueNumber },
        "Skipping GitHub PR review-body mention: empty directive",
      );
      return jsonResponse({ ok: true, skipped: true, reason: "empty_mention" });
    }
    if (!metadata.details.commentId) {
      log.error(
        { deliveryId: f.deliveryId, prNumber: metadata.details.issueNumber },
        "GitHub PR review-body mention rejected: missing review id",
      );
      return jsonErrorResponse("Missing pull request review metadata", 400);
    }
    const mentionReviewId = metadata.details.commentId;
    const { repoOwner, repoName } = metadata.details;
    const prNumber = metadata.details.issueNumber;
    const prUrl = metadata.details.issueUrl;

    const duplicate = await claimGithubWebhook(request, rawBody, env);
    if (duplicate) return duplicate;

    // The whole-delivery claim is committed above. A transient failure during the multi-step bound-
    // session resolve + revive + head lookup + epoch bootstrap would otherwise leave the claim committed
    // and let GitHub's redelivery dedup drop the mention until the ~7-day TTL. Release the claim and
    // return a non-200 so GitHub redelivers (bootstrap is idempotent on the mention sentinel + source ids).
    try {
      // ---- Bound-session resolution: tracking winner → single ref else fail-closed → skip. ----
      let sessionId = await getTrackingSessionIdForPrUrl(env.DB, prUrl);
      if (!sessionId) {
        const refSessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
        if (refSessionIds.length === 1) {
          sessionId = refSessionIds[0];
        } else if (refSessionIds.length > 1) {
          log.warn(
            {
              action: "pr_review_body_mention",
              repoOwner,
              repoName,
              prNumber,
              senderLogin: f.reviewAuthor,
              refCount: refSessionIds.length,
            },
            "Skipping GitHub PR review-body mention: ambiguous bound session",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
        }
      }
      if (!sessionId) {
        // ARC-1515: an authorized Cycloid member whose review BODY mentions `@cycloid` on a PR
        // Cycloid did NOT author adopts it. Gate on internal membership (fail-closed: non-members keep
        // the no-bound-session skip), then bootstrap a session and hand off to the directive-mention
        // epoch flow below. Mirrors the top-level issue-comment mention branch (single writer = the sweep).
        const actorUser = await resolveInternalFeatureGateUser(env.DB, Number(actor.actorUserId));
        if (!actorUser || !isCycloidMember(actorUser) || !f.reviewAuthor) {
          log.info(
            { deliveryId: f.deliveryId, repoOwner, repoName, prNumber },
            "Skipping GitHub PR review-body mention: no bound session",
          );
          return jsonResponse({ ok: true, skipped: true, reason: "no_bound_session" });
        }

        const bootstrap = await bootstrapMentionSession(env, {
          actorUserId: actor.actorUserId,
          actorLogin: f.reviewAuthor,
          actorBusinessId: actorUser.businessId,
          installationId: metadata.details.installationId,
          repoOwner,
          repoName,
          prUrl,
          directiveText,
          waitUntil: (promise) => ctx?.waitUntil(promise),
        });
        if (bootstrap.kind === "skip") {
          return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_bound_session" });
        }
        if (bootstrap.kind === "rejected") {
          await postIssueComment(
            env,
            metadata.details.installationId,
            repoOwner,
            repoName,
            prNumber,
            bootstrap.publicMessage,
          ).catch((err) => {
            log.warn(
              {
                action: "pr_review_body_mention",
                deliveryId: f.deliveryId,
                repoOwner,
                repoName,
                prNumber,
                reason: bootstrap.reason,
                error: String(err),
              },
              "Failed to post GitHub mention bootstrap rejection comment",
            );
          });
          return jsonResponse({ ok: true, skipped: true, reason: bootstrap.reason });
        }
        if (bootstrap.kind === "retry") {
          throw new Error(`GitHub mention bootstrap retry requested: ${bootstrap.reason}`);
        }
        sessionId = bootstrap.sessionId;
      }

      // ---- PR-open gate (BEFORE any revive) ----
      // ensureSessionLiveForPr below unarchives + warms/cold-boots the sandbox, and getPrHeadSha
      // returns a SHA even for closed/merged PRs, so without this gate an @cycloid review body on a
      // terminal (closed/merged) PR would revive the sandbox and dispatch a mention epoch. Mirror the
      // top-level issue-comment mention handler: gate on PR-open state FIRST. Mint the installation
      // token once here and reuse it for the head-SHA + inline-comment fetch below. getPrState returns
      // "closed"/"merged" for a genuinely-not-open PR and null on a TRANSIENT GitHub failure
      // (404/429/5xx); a 401/403 throws. The gate runs AFTER the claim commit so a benign not-open
      // skip consumes the delivery (no redelivery, no revive), while the transient/throw path falls to
      // the catch below which releases the claim so GitHub redelivers (fail-closed retry).
      const installationToken = await createInstallationToken(env, metadata.details.installationId);
      const prState = await getPrState(installationToken, repoOwner, repoName, prNumber);
      if (prState === null) {
        // Indeterminate PR state (transient GitHub failure) — throw so the catch releases the claim
        // and GitHub redelivers, instead of reviving on an unknown state or silently dropping it.
        throw new Error("pr_review_body mention PR-state lookup indeterminate — retry");
      }
      if (prState !== "open") {
        log.warn(
          { action: "pr_review_body_mention", sessionId, repoOwner, repoName, prNumber, prState },
          "Skipping GitHub PR review-body mention: PR not open",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "pr_not_open" });
      }

      // ---- Revive the PR-bound session (unarchive / warm the same sandbox / reuse it) so the mention
      //      can run even on a finished/stopped/archived session. ----
      const live = await ensureSessionLiveForPr({ env, db: env.DB, sessionId, prUrl, nowMs: Date.now() });
      if (live.status !== "live") {
        log.warn(
          { action: "pr_review_body_mention", sessionId, repoOwner, repoName, prNumber, reason: live.status },
          "Skipping GitHub PR review-body mention: session not revivable",
        );
        return jsonResponse({ ok: true, skipped: true, reason: live.status });
      }

      // ---- Resolve the current PR head SHA for the epoch key (reuse the gate's token). ----
      const headSha = await getPrHeadSha(installationToken, repoOwner, repoName, prNumber);
      if (!headSha) {
        log.warn(
          { action: "pr_review_body_mention", sessionId, repoOwner, repoName, prNumber },
          "Skipping GitHub PR review-body mention: PR head unavailable",
        );
        return jsonResponse({ ok: true, skipped: true, reason: "pr_head_unavailable" });
      }

      // ---- Fold this review's INLINE comments into the directive. This mention path routes INSTEAD OF
      //      the human-review loop (Step 5), which is the ONLY path that fetches + folds a review's inline
      //      comments (the per-comment `pull_request_review_comment` events only handle bots + `@cycloid`
      //      replies, not plain human inline comments). So a review whose body mentions @cycloid AND
      //      carries inline comments would otherwise LOSE those inline comments entirely. Render them into
      //      the mentionText and add each `review-comment:<id>` to targetSourceIds so bootstrapMentionEpoch
      //      marks them handled (the normal loop / cross-epoch dedup then won't re-dispatch them). Filter to
      //      THIS review's comments exactly as the human loop does (`comment.reviewId === reviewId`).
      //      Best-effort: an empty/absent inline set keeps the body directive alone (current behavior); a
      //      fetch failure proceeds with the body directive (WARN) rather than losing the mention. ----
      let mentionText = directiveText;
      const inlineSourceIds: string[] = [];
      try {
        const reviewComments = await getPrReviewComments(installationToken, repoOwner, repoName, prNumber);
        const inlineComments = reviewComments.filter(
          (comment) => comment.reviewId === mentionReviewId && typeof comment.id === "number",
        );
        for (const comment of inlineComments) {
          if (typeof comment.id === "number") inlineSourceIds.push(`review-comment:${comment.id}`);
        }
        const renderedInline = renderReviewBodyMentionInlineComments(inlineComments);
        if (renderedInline) mentionText = `${directiveText}\n\n${renderedInline}`;
      } catch (err) {
        log.warn(
          { error: String(err), deliveryId: f.deliveryId, reviewId: mentionReviewId, prNumber },
          "GitHub PR review-body mention: inline comment fetch failed; proceeding with body directive only",
        );
      }

      // ---- Bootstrap a `ready` DIRECTIVE mention epoch keyed `review-body:<reviewId>`; the sweep
      //      dispatches it. The captured review body + inline comments are a point-in-time directive, so a
      //      later reviewer edit cannot change what the agent was asked to do. All fields are UNTRUSTED
      //      GitHub text; the prompt builder wraps every segment. ----
      const epoch = await bootstrapMentionEpoch(env.DB, {
        sessionId,
        ownerUserId: Number(live.session.ownerUserId),
        repoOwner,
        repoName,
        prNumber,
        prUrl,
        headSha,
        mode: "directive",
        targetSourceIds: [`review-body:${mentionReviewId}`, ...inlineSourceIds],
        mentionText,
        nowMs: Date.now(),
      });
      if (!epoch) {
        // OR-IGNORE contention exhausted its retry budget with no committed row — retry via redelivery
        // rather than silently dropping the mention.
        throw new Error("bootstrapMentionEpoch exhausted its retry budget");
      }

      // ---- Re-arm review_listening so the sweep can dispatch this mention epoch even on a just-revived
      //      (unarchived / cold-booted) session. The enter route returns updated:false ONLY when the
      //      session is archived again (re-archive race) — the epoch is then NOT dispatchable, so treat
      //      !updated as retryable (release claim + redeliver), mirroring reengageSessionForReview. ----
      const listening = await emitReviewListeningEntered(env, sessionId, { headSha, prUrl });
      if (!listening || !listening.ok || !listening.payload?.updated) {
        const reason = listening?.payload?.reason ?? (listening ? `http_${listening.status}` : "no_pr_url");
        throw new Error(`emitReviewListeningEntered not durable for mention: ${reason}`);
      }

      log.info(
        {
          action: "pr_review_body_mention",
          deliveryId: f.deliveryId,
          sessionId,
          epochId: epoch.id,
          repoOwner,
          repoName,
          prNumber,
          reviewId: mentionReviewId,
        },
        "GitHub PR review-body mention bootstrapped directive mention epoch",
      );
      // 👀 acknowledge the mention. GitHub can't react to a review submission's body directly, so the
      // review_submission surface reacts to the review's inline comments (capped); a body-only review has
      // no reactable target and is a no-op. Manual mode suppresses the ingest ack, so the mention owns it.
      scheduleReviewAckReaction(env, ctx, {
        installationId: f.installationId,
        owner: repoOwner,
        repo: repoName,
        actorLogin: f.reviewAuthor,
        actorType: f.reviewUserType,
        surface: { kind: "review_submission", reviewId: mentionReviewId, reviewBody: f.reviewBody, prNumber },
      });
      return jsonResponse({ ok: true, mention: true, epochId: epoch.id, sessionId });
    } catch (err) {
      await releaseGithubWebhookClaimBestEffort({
        request,
        rawBody,
        db: env.DB,
        reason: "pr_review_body_mention_retryable",
        logFields: { deliveryId: f.deliveryId, reviewId: mentionReviewId },
        warnMessage: "Failed to release webhook claim for review-body mention retry",
      });
      log.warn(
        { error: String(err), deliveryId: f.deliveryId, reviewId: mentionReviewId },
        "GitHub PR review-body mention failed; released claim for redelivery",
      );
      return jsonErrorResponse("pull_request_review mention failed — retry", 500);
    }
  }

  // Step 5: human reviewer → review-loop human router.
  return handlePullRequestReviewEventHumanLoop(env, rawBody, request, f, ctx);
}

async function claimGithubWebhook(request: Request, rawBody: string, env: Env): Promise<Response | null> {
  const { idempotencyKey, payloadHash } = await buildGithubWebhookIdempotency(request, rawBody);
  const claimed = await claimWebhookIdempotency(env.DB, WEBHOOK_SOURCE_GITHUB, idempotencyKey, payloadHash);
  if (!claimed) {
    // Whole-delivery dedup skip. Without a signal here ops cannot distinguish a legitimate redelivery
    // dedup from a broken claim mechanism silently dropping real deliveries. App logs do not reach
    // Datadog (logpush=false), so this direct-posted event is the only queryable signal.
    await postStructuredEventToDd(env, {
      event: "webhook.idempotency_skipped",
      webhook_source: WEBHOOK_SOURCE_GITHUB,
      reason_code: "duplicate",
      delivery_id: normalizeWebhookReference(request.headers.get("x-github-delivery")),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "duplicate" });
  }
  return null;
}

async function releaseGithubWebhookClaim(
  request: Request,
  rawBody: string,
  db: D1Database,
  reason: string,
): Promise<void> {
  const { idempotencyKey } = await buildGithubWebhookIdempotency(request, rawBody);
  await releaseWebhookIdempotencyClaim(db, WEBHOOK_SOURCE_GITHUB, idempotencyKey);
  log.info({ idempotencyKey, reason }, "Released GitHub webhook claim for redelivery");
}

async function releaseGithubWebhookClaimBestEffort(params: {
  request: Request;
  rawBody: string;
  db: D1Database;
  reason: string;
  logFields: Record<string, unknown>;
  warnMessage: string;
}): Promise<void> {
  try {
    await releaseGithubWebhookClaim(params.request, params.rawBody, params.db, params.reason);
  } catch (error) {
    log.warn({ ...params.logFields, error: String(error) }, params.warnMessage);
  }
}

/**
 * Per-PR idempotency claim for multi-PR deliveries (check_run / status). Each PR entry in one
 * delivery gets its own claim derived from the delivery key + PR number, so a transient mid-loop
 * failure on one PR can be released and reprocessed on GitHub redelivery WITHOUT re-processing the
 * PRs that already succeeded (their claims persist). Returns true if this PR was newly claimed,
 * false if it was already handled in a prior delivery attempt.
 */
async function claimGithubWebhookForPr(
  request: Request,
  rawBody: string,
  db: D1Database,
  prNumber: number,
): Promise<boolean> {
  const { idempotencyKey, payloadHash } = await buildGithubWebhookIdempotency(request, rawBody);
  return claimWebhookIdempotency(db, WEBHOOK_SOURCE_GITHUB, `${idempotencyKey}:pr:${prNumber}`, payloadHash);
}

async function releaseGithubWebhookClaimForPr(
  request: Request,
  rawBody: string,
  db: D1Database,
  prNumber: number,
): Promise<void> {
  const { idempotencyKey } = await buildGithubWebhookIdempotency(request, rawBody);
  await releaseWebhookIdempotencyClaim(db, WEBHOOK_SOURCE_GITHUB, `${idempotencyKey}:pr:${prNumber}`);
}

async function buildGithubWebhookIdempotency(
  request: Request,
  rawBody: string,
): Promise<{ idempotencyKey: string; payloadHash: string }> {
  const payloadHash = await computeSha256Hex(rawBody);
  return {
    idempotencyKey: buildWebhookIdempotencyKey(
      WEBHOOK_SOURCE_GITHUB,
      request.headers.get("x-github-delivery"),
      payloadHash,
    ),
    payloadHash,
  };
}

async function handleInstallationEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const action = payload.action as string | undefined;
  const installation = payload.installation as Record<string, unknown> | undefined;

  if (!installation || !action) {
    return jsonErrorResponse("Missing installation or action", 400);
  }

  const installationId = installation.id as number;
  const account = installation.account as Record<string, unknown> | undefined;
  const ownerLogin = (account?.login as string) || "";
  const ownerId = (account?.id as number) || 0;
  const ownerType = (account?.type as string) || "Organization";
  const repositorySelection = (installation.repository_selection as string) || null;
  const permissions = parseGithubInstallationPermissions(installation.permissions);
  const events = parseGithubInstallationEvents(installation.events);
  const upsertParams = {
    installationId,
    ownerLogin,
    ownerId,
    ownerType,
    repositorySelection,
    permissions,
    events,
  };

  const db = env.DB;
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  switch (action) {
    case "created": {
      try {
        await upsertInstallation(db, upsertParams);
      } catch (error) {
        if (!isInstallationOwnerUniqueConstraintError(error)) throw error;
        const conflictingInstallation = await getConflictingInstallationByOwner(db, ownerLogin, installationId);
        if (!conflictingInstallation) throw error;
        await replaceConflictingInstallation(db, conflictingInstallation.installation_id, upsertParams);
        log.warn(
          {
            installation_id: installationId,
            owner_login: ownerLogin,
            owner_type: ownerType,
            replaced_installation_id: conflictingInstallation.installation_id,
            action,
          },
          "GitHub App install replaced stale installation row after owner conflict",
        );
      }

      log.info(
        { installation_id: installationId, owner_login: ownerLogin, owner_type: ownerType, action },
        "GitHub App installed",
      );
      break;
    }

    case "new_permissions_accepted":
      await updateInstallationPermissions(db, upsertParams);
      // A cached token still carries the old scopes; drop it so the next mint reflects the new grant.
      await invalidateInstallationTokenCache(env, installationId);
      log.info(
        { installation_id: installationId, owner_login: ownerLogin, owner_type: ownerType, action },
        "GitHub App installation permissions updated",
      );
      break;

    case "deleted":
      await deleteInstallation(db, installationId);
      // GitHub revokes the installation's tokens on uninstall; evict the cache so we never serve a dead token.
      await invalidateInstallationTokenCache(env, installationId);
      log.info(
        { installation_id: installationId, owner_login: ownerLogin, owner_type: ownerType, action },
        "GitHub App uninstalled",
      );
      break;

    case "suspend":
      await suspendInstallation(db, installationId, Date.now());
      // Suspended installations cannot mint usable tokens; drop any cached one.
      await invalidateInstallationTokenCache(env, installationId);
      log.info(
        { installation_id: installationId, owner_login: ownerLogin, owner_type: ownerType, action },
        "GitHub App installation suspended",
      );
      break;

    case "unsuspend":
      await unsuspendInstallation(db, installationId);
      log.info(
        { installation_id: installationId, owner_login: ownerLogin, owner_type: ownerType, action },
        "GitHub App installation unsuspended",
      );
      break;

    default:
      return jsonResponse({ ok: true, skipped: true, reason: `unhandled installation action: ${action}` });
  }

  await bumpReposInstallationVersion(env);
  return jsonResponse({ ok: true, action });
}

async function handleInstallationRepositoriesEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const action = payload.action as string | undefined;
  const installation = payload.installation as Record<string, unknown> | undefined;

  if (!installation || !action) {
    return jsonErrorResponse("Missing installation or action", 400);
  }

  const installationId = installation.id as number;
  const account = installation.account as Record<string, unknown> | undefined;
  const ownerLogin = (account?.login as string) || "";
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  // Clear the per-installation D1 cache before invalidating user-level KV. If the
  // D1 delete fails, skip the version bump: bumping would force user-level cache
  // misses that re-hydrate a fresh KV entry from the still-stale D1 row, extending
  // staleness to ~D1_TTL + KV_TTL. Leaving the bump off lets existing KV entries
  // expire naturally (<= 15m) without re-populating from stale data.
  let installationCacheCleared = true;
  try {
    await deleteCachedInstallationRepos(env.DB, installationId);
  } catch (error) {
    installationCacheCleared = false;
    log.error(
      { installation_id: installationId, error: String(error) },
      "Failed to invalidate installation repo cache; skipping installation-version bump",
    );
  }
  if (installationCacheCleared) {
    await bumpReposInstallationVersion(env);
  }
  // A token minted before the grant changed still carries the old repository
  // scope (missing added repos, or still covering removed ones); drop it so the
  // next mint reflects the current grant.
  await invalidateInstallationTokenCache(env, installationId);
  log.info(
    { installation_id: installationId, owner_login: ownerLogin, action },
    "GitHub App installation repositories changed",
  );

  return jsonResponse({ ok: true, action });
}

async function recordSessionCompletionPrOutcomes(params: {
  env: Env;
  db: D1Database;
  sessionIds: string[];
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  merged: boolean;
}): Promise<void> {
  const { env, db, sessionIds, prUrl, prNumber, repoOwner, repoName, installationId, merged } = params;
  const outcomeAt = Date.now();
  const completions = await findCompletionsForSessionsPr(db, sessionIds, prUrl);
  if (completions.length === 0) return;

  // GitHub enrichment (token + aggregate fetches) is best-effort: only the D1
  // outcome write needs to be durable. A persistent token failure (suspended /
  // removed installation, hard auth error) must NOT throw here — that would 500
  // the acknowledged path, block the notify/close loop below, and make GitHub
  // redeliver the same permanently-failing event forever. Degrade to recording
  // the outcome with null/unknown enrichment instead.
  let token: string | null = null;
  try {
    token = await createInstallationToken(env, installationId);
  } catch (err) {
    log.warn(
      { error: String(err), prUrl, prNumber, installationId },
      "PR outcome: installation token unavailable; recording outcome without enrichment",
    );
  }
  let reviewThreadCount: number | null = null;
  let prCommitShas: string[] = [];
  const ciStatusBySha = new Map<string, CommitCiStatus>();
  if (token) {
    try {
      const [reviewComments, commitShas] = await Promise.all([
        getPrReviewComments(token, repoOwner, repoName, prNumber),
        getPrCommitShas(token, repoOwner, repoName, prNumber),
      ]);
      reviewThreadCount = reviewComments.filter((comment) => comment.inReplyToId === null).length;
      prCommitShas = commitShas;
    } catch (err) {
      log.warn({ error: String(err), prUrl, prNumber }, "PR outcome aggregate fetch failed; recording outcome only");
    }
    // Completions missing commit_sha (the dominant case historically — ~80% of merged PRs
    // recorded ci_first_run_status "unknown") fall back to the PR's first commit: the SHA of the
    // first push is the first-pass CI anchor by definition.
    const firstPrCommitSha = prCommitShas[0];
    const commitShas = [
      ...new Set([
        ...completions.map((completion) => completion.commit_sha).filter((sha): sha is string => Boolean(sha)),
        ...(firstPrCommitSha && completions.some((completion) => !completion.commit_sha) ? [firstPrCommitSha] : []),
      ]),
    ];
    const ciStatusResults = await Promise.allSettled(
      commitShas.map((commitSha) => getCachedCommitCiStatus(token!, repoOwner, repoName, commitSha, ciStatusBySha)),
    );
    const failedCiStatusLookups = ciStatusResults.filter((result) => result.status === "rejected");
    if (failedCiStatusLookups.length > 0) {
      log.warn(
        {
          failedCount: failedCiStatusLookups.length,
          totalCount: commitShas.length,
          errors: failedCiStatusLookups.map((result) => String(result.reason)),
          prUrl,
          prNumber,
        },
        "CI status lookup failed for some commits; recording affected outcomes with unknown status",
      );
    }
  }
  const updates: CompletionOutcomeUpdate[] = [];

  for (const completion of completions) {
    const commitSha = completion.commit_sha || prCommitShas[0] || null;
    const commitIndex = commitSha ? prCommitShas.indexOf(commitSha) : -1;
    const followupCommitCount = commitIndex >= 0 ? prCommitShas.length - commitIndex - 1 : null;
    const ciFirstRunStatus = commitSha ? (ciStatusBySha.get(commitSha) ?? "unknown") : "unknown";
    const firstPassPassed =
      merged && reviewThreadCount === 0 && followupCommitCount === 0 && ciFirstRunStatus === "success";

    updates.push({
      sessionId: completion.session_id,
      promptId: completion.prompt_id,
      prOutcome: merged ? "merged" : "closed",
      prOutcomeAt: outcomeAt,
      firstPassPassed,
      reviewThreadCount,
      followupCommitCount,
      ciFirstRunStatus,
    });
  }

  await updateCompletionOutcomes(db, updates);
}

async function getCachedCommitCiStatus(
  token: string,
  repoOwner: string,
  repoName: string,
  commitSha: string,
  cache: Map<string, CommitCiStatus>,
): Promise<CommitCiStatus> {
  const cached = cache.get(commitSha);
  if (cached) return cached;
  const status = await getCommitCiStatus(token, repoOwner, repoName, commitSha);
  cache.set(commitSha, status);
  return status;
}

// ARC-1330 D-59b: `SYNCHRONIZE_STALE_REVIEW_LOOP_LABELS` + `clearSynchronizeStaleReviewLoopLabels` (the
// blunt head-change teardown of review-loop:done / review-loop:ci-red) are deleted. The canonical
// `labelsOf(record)` reconcile (`syncFsmLabelsForPr`) tears down stale
// managed labels precisely after the `head.changed` spine commit — see the synchronize handler.

/**
 * Reconciles a PR head-SHA change (pull_request `synchronize`) for review-listening sessions.
 * For each session listening on this PR whose recorded head differs from the new head, reconciles
 * in-flight review-loop epochs via the shared `reconcileReviewLoopEpochsForHeadChange` helper (carry
 * our own base-merge forward, else stale-block) and advances the session's review-listening head —
 * mirroring the sweep's reconcileReviewListeningSessions head-change branch, but inline so the
 * inter-sweep window cannot drop reviews on the new head as `stale_head`.
 */
async function handlePullRequestSynchronizeEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const prUrl = normalizeWebhookReference(pullRequest?.html_url);
  const newHeadSha = normalizeWebhookReference((pullRequest?.head as Record<string, unknown> | undefined)?.sha);
  const baseRepo = (pullRequest?.base as Record<string, unknown> | undefined)?.repo as
    Record<string, unknown> | undefined;
  const repoOwner = normalizeWebhookReference((baseRepo?.owner as Record<string, unknown> | undefined)?.login);
  const repoName = normalizeWebhookReference(baseRepo?.name);
  const rawPrNumber = pullRequest?.number;
  const prNumber = typeof rawPrNumber === "number" ? rawPrNumber : Number(rawPrNumber);
  const rawInstallationId = (payload.installation as Record<string, unknown> | undefined)?.id;
  const installationId = typeof rawInstallationId === "number" ? rawInstallationId : Number(rawInstallationId);
  if (!prUrl || !newHeadSha) {
    return jsonResponse({ ok: true, skipped: true, reason: "missing_synchronize_metadata" });
  }

  const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
  if (sessionIds.length === 0) {
    return jsonResponse({ ok: true, skipped: true, reason: "no_matching_sessions" });
  }

  // Claim only after confirming there is review-listening work, mirroring the other review-loop
  // handlers (avoid holding an idempotency claim on a no-op delivery).
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  const nowMs = Date.now();
  let headChanged = 0;
  let staleEpochsBlocked = 0;
  let carriedForward = 0;
  let truncatedRekeyed = 0;
  let errored = 0;

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const session = await getSessionState(env, sessionId);
        if (!session || session.status !== "active" || !session.reviewListeningActive) return;
        if (session.reviewListeningPrUrl && session.reviewListeningPrUrl !== prUrl) return;
        const previousHeadSha =
          typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha : "";
        if (previousHeadSha === newHeadSha) return;

        // ARC-1330 (PR 40) shadow producer state: did THIS session's head actually advance, and is the
        // advance a content-noop (same tree SHA)? The no-op flag is only set where the handler already
        // computes the tree compare (verdict-preservation path); it defaults false → `head.changed` (a
        // re-QA-forcing real change), which is behaviorally faithful with no settled verdict (see
        // head-producer.ts header). Dual-emitted once at the end of the per-session work.
        let shadowHeadAdvanced = false;
        let shadowIsContentNoop = false;

        if (previousHeadSha.length > 0) {
          // Carry our own base-merge forward, else stale-block (see reconcileReviewLoopEpochsForHeadChange).
          // The webhook advances the head out-of-band, so the sweep's head-change branch is skipped next
          // tick (previousHeadSha === newHeadSha); without this the base-merge would stale-block pending
          // feedback the sweep would have carried forward (ARC-1245).
          const epochResult = await reconcileReviewLoopEpochsForHeadChange(env.DB, {
            sessionId,
            prUrl,
            previousHeadSha,
            currentHeadSha: newHeadSha,
            nowMs,
            logger: log,
          });
          carriedForward += epochResult.carriedForward;
          staleEpochsBlocked += epochResult.staleBlocked;
          truncatedRekeyed += epochResult.truncatedRekeyed;
          // ARC-1244: a budget-truncated tail recovered onto the new head instead of being
          // stale-blocked. Emit here too (not just the sweep) since the webhook wins the head-advance
          // race — the sweep's branch is skipped next tick (previousHeadSha === newHeadSha). Called
          // unconditionally like the sweep (the emitter self-gates on rekeyed<=0) so the two callers
          // can't diverge. The `repo:` tag falls back to the always-present prUrl (base.repo.name can
          // be absent on a malformed delivery) via the canonical parser, so it is never undercounted
          // or empty.
          await emitReviewLoopTruncatedTailRekeyedMetric(env, {
            repo: repoName ?? parseGithubPullRequestUrl(prUrl)?.repo ?? "",
            ownerUserId: Number(session.ownerUserId),
            rekeyed: epochResult.truncatedRekeyed,
          });
        }
        // ARC-1330 D-59a: the legacy head-change done-state reset (setSessionReviewLoopDoneState → "working")
        // is deleted with the rest of the cron done-state decision sites. The FSM owns the head-change reset
        // at live via the `head.changed` edge (advance_head); the DO done-state field is no longer the source
        // of truth for the settle.
        const effectiveInstallationId = Number.isSafeInteger(installationId)
          ? installationId
          : typeof session.installationId === "number"
            ? session.installationId
            : NaN;
        // Hoisted so the verification-verdict clear below can reuse it for the no-op-tree check
        // (ARC-1243 follow-up) without a second token mint. Null when PR metadata is incomplete — the
        // no-op check then fails open and the verdict is cleared as before.
        let installationToken: string | null = null;
        if (
          Number.isSafeInteger(effectiveInstallationId) &&
          repoOwner &&
          repoName &&
          Number.isSafeInteger(prNumber) &&
          prNumber > 0
        ) {
          // ARC-1330 D-59b: the blunt legacy synchronize teardown (strip review-loop:done +
          // review-loop:ci-red) is deleted. The canonical `labelsOf(record)` reconcile below, run after
          // the `head.changed` spine commit, tears down the stale managed labels precisely
          // (`clear_verification` → REVIEW → labelsOf([]) strips them; a no-op head PRESERVES the
          // verdict-derived label — a correctness gain over the always-strip legacy clear). The token is
          // still minted here for the no-op-tree check below.
          installationToken = await createInstallationToken(env, effectiveInstallationId);
        } else {
          log.warn(
            { sessionId, prUrl, installationId: effectiveInstallationId, repoOwner, repoName, prNumber },
            "PR synchronize: skipped review-loop label cleanup due to missing PR metadata",
          );
        }
        const updateResult = await updateSessionReviewListeningHead(env, sessionId, {
          prUrl,
          currentHeadSha: newHeadSha,
        });
        if (!updateResult.ok) {
          log.warn(
            { sessionId, prUrl, status: updateResult.status },
            "PR synchronize: review-listening head update failed",
          );
          errored += 1;
          return;
        }
        if (updateResult.payload?.updated !== false) {
          headChanged += 1;
          shadowHeadAdvanced = true;
        }
        // The head advanced for this session. CLASSIFY the advance (real content change vs content-noop
        // rebase/reword) so the FSM head producer below re-QAs the right way — `head.changed` clears the
        // now-stale prior-head verdict, `head.noop_changed` preserves it (verification-intake /
        // `review-loop:done` head-freshness).
        //
        // ARC-1330 D-59 RESIDUE FOLD: the standalone session-store clear/stamp that used to live here is
        // DELETED. The session's verificationState/Result/VerdictHeadSha store (which the scheduler's
        // ARC-1243 `verdict_already_settled` gate reads) is now maintained by the live head producer's
        // `syncLegacyVerificationStoreForHeadChange` (fsm/head-producer.ts), which `shadowEmitHeadChange`
        // (below) runs SYNCHRONOUSLY before the spine transition — the pre-spawn ordering (#6527) that makes
        // the deferred-clear race impossible (asserted in fsm/head-verdict-store-counterpart.test.ts). The
        // producer helper is the SOLE maintainer at live; the fold is merge-gated on the live flip. All this
        // block still does is compute the classifier for the emit.
        //
        // The GUARD is preserved verbatim so the spine classification is byte-identical to pre-fold: the
        // no-op tree read only runs when there is a settled verdict to preserve — with no verdict,
        // `shadowIsContentNoop` stays false and the spine sees `head.changed` (a re-QA-forcing advance, which
        // is behaviorally faithful with nothing to preserve). Skip `verification-in-progress`: there is no
        // settled verdict, and the producer helper skips the active run too (never wiping its state/labels).
        if (
          session.verificationState !== "verification-in-progress" &&
          (session.verificationState != null || session.verificationResult != null)
        ) {
          // A content no-op head advance (same tree SHA: rebase/reword/no-op force-push) has nothing new to
          // verify — classify it so the FSM `head.noop_changed` edge PRESERVES the verdict.
          // isNoOpHeadTreeChange fails open (false) on any read failure or missing token, so a real content
          // change still classifies as `head.changed` and the new head re-verifies. Reused as the shadow
          // head classifier — no extra GitHub read (the rate-limit cost the shadow phase must not add).
          const noOpHeadChange =
            installationToken != null &&
            repoOwner != null &&
            repoName != null &&
            previousHeadSha.length > 0 &&
            (await isNoOpHeadTreeChange(installationToken, repoOwner, repoName, previousHeadSha, newHeadSha));
          shadowIsContentNoop = noOpHeadChange;
        }
        // ARC-1330 (PR 40) — DUAL-EMIT the head advance onto the shadow spine as
        // `head.changed`/`head.noop_changed`. SHADOW/observe-only, internally try-caught OFF the legacy
        // critical path (never bumps `errored` / blocks the live head reconciliation). Only after the head
        // actually advanced for this session.
        if (shadowHeadAdvanced) {
          await shadowEmitHeadChange(
            env,
            sessionId,
            classifyHeadChange({
              headSha: newHeadSha,
              prevHeadSha: previousHeadSha.length > 0 ? previousHeadSha : null,
              isContentNoop: shadowIsContentNoop,
            }),
            log,
            // PR 47: live FSM side-effect execution defers through the handler's ExecutionContext.
            ctx ? (promise) => ctx.waitUntil(promise) : undefined,
          );
          // ARC-1330 (W11-P2) — reconcile the canonical labels off the now-committed spine row
          // (shadowEmitHeadChange awaits the CAS commit; only side-effects defer via waitUntil).
          // `head.changed` cleared the verdict → REVIEW → labelsOf strips the stale managed labels; a
          // `head.noop_changed` preserved the verdict → its label survives. Best-effort; sweep self-heals.
          await syncFsmLabelsForPr(env, {
            prUrl,
            sessionId,
            installationId: Number.isSafeInteger(effectiveInstallationId)
              ? effectiveInstallationId
              : (session.installationId ?? null),
            repoOwner,
            repoName,
            tokenHint: installationToken ?? undefined,
            logger: log,
          });
        }
      } catch (err) {
        errored += 1;
        log.warn({ error: String(err), sessionId, prUrl }, "PR synchronize: review-loop head reconciliation failed");
      }
    }),
  );

  // A thrown per-session error or a non-OK head update means the review-listening head was NOT
  // reconciled for that session. The idempotency claim was already committed before this loop, so
  // returning 200 would let GitHub's dedup drop the redelivery and those sessions keep the stale
  // reviewListeningHeadSha until the next sweep tick — the exact window this fix eliminates. Release
  // the claim and return a non-2xx so GitHub redelivers; the per-session pre-checks (previousHeadSha
  // === newHeadSha) make already-advanced sessions no-op on retry, and re-marking epochs stale /
  // re-advancing the head is idempotent, so only the failed sessions do real work.
  if (errored > 0) {
    await releaseGithubWebhookClaimBestEffort({
      request,
      rawBody,
      db: env.DB,
      reason: "synchronize_reconcile_retryable",
      logFields: { prUrl },
      warnMessage: "Failed to release webhook claim for synchronize retry",
    });
    return jsonErrorResponse(
      `pull_request synchronize reconcile incomplete (errored=${errored} of ${sessionIds.length}) — retry`,
      500,
    );
  }

  return jsonResponse({
    ok: true,
    reviewLoop: true,
    synchronize: true,
    total: sessionIds.length,
    headChanged,
    staleEpochsBlocked,
    carriedForward,
    truncatedRekeyed,
    errored,
  });
}

async function handlePullRequestDraftStateEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  draft: boolean,
): Promise<Response> {
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const prUrl = normalizeWebhookReference(pullRequest?.html_url);
  if (!prUrl) return jsonResponse({ ok: true, skipped: true, reason: "missing_pr_url" });

  const sessionIds = await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
  if (sessionIds.length === 0) {
    return jsonResponse({ ok: true, skipped: true, reason: "no_matching_sessions" });
  }

  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  // The whole-delivery claim is committed above. reconcilePrDraftStateForPr re-reads sessions before
  // its own per-session try, so a transient throw there escapes the failed-count branch below; wrap it
  // so any throw releases the claim and returns a non-200 for redelivery (the reconcile is idempotent).
  try {
    const reconciliation = await reconcilePrDraftStateForPr({
      env,
      logger: log,
      prUrl,
      draft,
    });

    if (reconciliation.failed > 0) {
      await releaseGithubWebhookClaimBestEffort({
        request,
        rawBody,
        db: env.DB,
        reason: "pr_draft_reconcile_retryable",
        logFields: { prUrl },
        warnMessage: "Failed to release webhook claim for PR draft-state retry",
      });
      return jsonErrorResponse(
        `pull_request draft-state reconcile incomplete (failed=${reconciliation.failed} of ${reconciliation.sessionCount}) — retry`,
        500,
      );
    }

    return jsonResponse({ ok: true, prDraft: draft, reconciliation });
  } catch (err) {
    await releaseGithubWebhookClaimBestEffort({
      request,
      rawBody,
      db: env.DB,
      reason: "pr_draft_reconcile_retryable",
      logFields: { prUrl },
      warnMessage: "Failed to release webhook claim for PR draft-state retry",
    });
    log.warn(
      { error: String(err), prUrl },
      "GitHub PR draft-state reconcile threw before completion; released claim for redelivery",
    );
    return jsonErrorResponse("pull_request draft-state reconcile threw before completion — retry", 500);
  }
}

function pullRequestRepoContext(pullRequest: Record<string, unknown>): {
  repoOwner: string | null;
  repoName: string | null;
} {
  const base = pullRequest.base as Record<string, unknown> | undefined;
  const baseRepo = base?.repo as Record<string, unknown> | undefined;
  return {
    repoOwner: ((baseRepo?.owner as Record<string, unknown> | undefined)?.login as string | undefined) ?? null,
    repoName: (baseRepo?.name as string | undefined) ?? null,
  };
}

async function handlePullRequestEvent(
  payload: Record<string, unknown>,
  rawBody: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const action = payload?.action as string;
  const pullRequest = payload?.pull_request as Record<string, unknown> | undefined;
  if (!pullRequest?.html_url) {
    return jsonResponse({ ok: true, skipped: true });
  }

  if (action === "opened" || action === "reopened") {
    // Clear outcome for reopened memory PRs so they return to pending
    if (action === "reopened") {
      const headRef = ((pullRequest.head as Record<string, unknown> | undefined)?.ref as string | undefined) ?? "";
      if (headRef.startsWith(MEMORY_BRANCH_PREFIX)) {
        const memoryPrUrl = normalizeWebhookReference(pullRequest.html_url);
        if (memoryPrUrl && env.DB) {
          const { updateMemoryPrOutcome } = await import("../memory/db.js");
          await updateMemoryPrOutcome(env.DB, memoryPrUrl, null);
        }
      }
    }
    return jsonResponse({ ok: true, skipped: true });
  }

  // A `synchronize` action is a head-SHA change (a new commit pushed to the PR). Reconcile the
  // review-listening head immediately so reviews on the new head are not dropped as `stale_head`
  // during the inter-sweep window (the 5-min sweep is the backstop, not the primary path here).
  if (action === "synchronize") {
    return handlePullRequestSynchronizeEvent(payload, rawBody, request, env, ctx);
  }

  if (action === "ready_for_review" || action === "converted_to_draft") {
    return handlePullRequestDraftStateEvent(payload, rawBody, request, env, action === "converted_to_draft");
  }

  // PR-E1: the `review-loop:done` label handler is deleted (the label is scrapped; the FSM `caught_up`
  // cascade owns verification scheduling). No other `labeled` action handler exists, so skip.
  if (action === "labeled") {
    return jsonResponse({ ok: true, skipped: true, reason: "no_label_handler" });
  }

  if (action !== "closed") {
    return jsonResponse({ ok: true, skipped: true });
  }

  const db = env.DB;
  const duplicate = await claimGithubWebhook(request, rawBody, env);
  if (duplicate) return duplicate;

  const prUrl = normalizeWebhookReference(pullRequest?.html_url);
  const merged = pullRequest?.merged === true;
  const prNumber = pullRequest.number as number | undefined;
  const repo = (pullRequest.base as Record<string, unknown> | undefined)?.repo as Record<string, unknown> | undefined;
  const repoOwner = ((repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined) ?? null;
  const repoName = (repo?.name as string | undefined) ?? null;
  const prTitle = typeof pullRequest.title === "string" ? pullRequest.title : null;
  const prBody = typeof pullRequest.body === "string" ? pullRequest.body : null;
  const mergedAtMs =
    typeof pullRequest.merged_at === "string" ? Date.parse(pullRequest.merged_at) || Date.now() : Date.now();
  const { senderLogin } = extractCommonWebhookActor(payload);
  const { installationId } = extractRepoAndInstallation(payload);

  // The whole-delivery claim is committed above. The memory-PR outcome update and the session-ref
  // lookup run before the protected reconcile block below, so a transient D1 failure there would
  // otherwise leave the claim committed and let GitHub's redelivery dedup drop the pr-closed handling
  // until the ~7-day TTL. Release the claim and return a non-200 so GitHub redelivers; the memory
  // outcome update and the downstream reconcile re-stamp are idempotent.
  let sessionIds: string[];
  try {
    // Detect memory PR merge/close — only short-circuit if a tracking row exists
    const headRef = ((pullRequest.head as Record<string, unknown> | undefined)?.ref as string | undefined) ?? "";
    if (headRef.startsWith(MEMORY_BRANCH_PREFIX)) {
      const memoryPrUrl = normalizeWebhookReference(pullRequest.html_url);
      if (memoryPrUrl && db) {
        const { updateMemoryPrOutcome } = await import("../memory/db.js");
        const updated = await updateMemoryPrOutcome(db, memoryPrUrl, merged ? "merged" : "closed");
        if (updated) {
          log.info({ memoryPrUrl, merged }, "Memory PR outcome recorded");
          return jsonResponse({ ok: true, memoryPr: true, merged });
        }
        // No tracking row — fall through to normal PR handling
      }
    }

    sessionIds = await listSessionIdsByWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl!);
    if (sessionIds.length === 0) {
      return jsonResponse({ ok: true, skipped: true, reason: "no matching sessions" });
    }
  } catch (err) {
    await releaseGithubWebhookClaimBestEffort({
      request,
      rawBody,
      db,
      reason: "pr_closed_session_lookup_retryable",
      logFields: { prUrl, prNumber },
      warnMessage: "Failed to release webhook claim for pr-closed retry",
    });
    log.warn(
      { error: String(err), prUrl, prNumber },
      "GitHub pr-closed pre-reconcile session lookup failed; released claim for redelivery",
    );
    return jsonErrorResponse("pull_request closed session lookup failed — retry", 500);
  }

  if (prUrl && prNumber && repoOwner && repoName && installationId) {
    // Outcome reconciliation must be durable: it runs on the acknowledged path
    // (not detached `ctx.waitUntil`). The idempotency claim was already committed
    // above, so a swallowed transient failure here would let GitHub's dedup drop
    // the redelivery until the claim TTL expires. On failure, release the claim
    // and return a retryable 5xx so GitHub redelivers immediately; the outcome
    // write is idempotent (re-stamping the same outcome is a no-op).
    try {
      await recordSessionCompletionPrOutcomes({
        env,
        db,
        sessionIds,
        prUrl,
        prNumber,
        repoOwner,
        repoName,
        installationId,
        merged,
      });
    } catch (err) {
      log.warn({ error: String(err), prUrl, prNumber }, "Failed to record session completion PR outcomes — retrying");
      await releaseGithubWebhookClaimBestEffort({
        request,
        rawBody,
        db,
        reason: "pr_outcome_reconcile_retryable",
        logFields: { prUrl, prNumber },
        warnMessage: "Failed to release webhook claim for outcome retry",
      });
      return jsonErrorResponse("pull_request closed outcome reconcile failed — retry", 500);
    }
  }

  if (merged && prUrl && prNumber && repoOwner && repoName) {
    const companyMemoryTask = recordGithubPrMemoryIngestionForSessions({
      env,
      sessionIds,
      prUrl,
      prNumber,
      repoOwner,
      repoName,
      prBody,
      mergedAtMs,
      actorLogin: senderLogin,
    });
    if (ctx) ctx.waitUntil(companyMemoryTask);
    else await companyMemoryTask;
  }

  const results = await Promise.all(
    sessionIds.map(async (sessionId) => {
      let sessionNotified = false;
      let sessionClosed = false;

      // ARC-1330 (W11-T2) — emit the webhook-observed PR terminal onto the FSM spine. This is the PRIMARY
      // real-time terminal-delivery path: the legacy close-out below emits NO FSM event, so without this a
      // user manually fixing + merging a wedged NEEDS_YOU PR (dropped by the cron sweep's working set) would
      // strand the spine. Best-effort / try-caught OFF the notify+close critical path (never blocks archival);
      // idempotent (a §10 final terminal leaves pr.merged unhandled, so a
      // later cron-poll re-emit no-ops). Runs before the close so the terminal row is committed while the
      // session still resolves; effects defer through the request's waitUntil.
      await emitWebhookPrTerminal(
        env,
        sessionId,
        merged ? "merged" : "closed",
        log,
        ctx ? ctx.waitUntil.bind(ctx) : undefined,
      );

      if (merged) {
        try {
          const result = await notifySessionPrMerged(env, sessionId, prUrl!);
          if (!result.ok) {
            log.warn({ status: result.status, sessionId, prUrl }, "notify-pr-merged returned non-2xx");
          } else {
            sessionNotified = !!result.payload?.notified;
          }
        } catch (err) {
          log.warn({ error: String(err), sessionId, prUrl }, "Failed to send PR-merged notification");
        }
      }

      try {
        const result = await closeSessionForWebhook(env, db, sessionId, {
          reason: merged ? "pr_merged" : "pr_closed",
          metadata: {
            closeSource: "github_pr_webhook",
            prState: merged ? "merged" : "closed",
            ...(prUrl ? { prUrl } : {}),
            ...(typeof pullRequest.number === "number" ? { prNumber: pullRequest.number } : {}),
          },
        });
        sessionClosed = result.closed;
      } catch (err) {
        log.warn({ error: String(err), sessionId, prUrl }, "Failed to close session from webhook");
      }

      // Unmerged close that actually archived a live session: post a Slack notice
      // naming who closed the PR, so an in-flight thread is not silently killed by
      // a third party. Merged closes already post their own ":white_check_mark: PR
      // merged" card. Gating on `sessionClosed` (true only on the delivery that
      // performed the archive) dedupes across GitHub redeliveries — an already-
      // archived session returns closed:false and no second notice fires.
      if (sessionClosed && !merged && prUrl) {
        try {
          const notify = await notifySessionPrClosed(env, sessionId, prUrl, senderLogin);
          if (!notify.ok) {
            log.warn({ status: notify.status, sessionId, prUrl }, "notify-pr-closed returned non-2xx");
          }
        } catch (err) {
          log.warn({ error: String(err), sessionId, prUrl }, "Failed to send PR-closed notification");
        }
      }

      return { sessionNotified, sessionClosed };
    }),
  );

  const archived = results.filter((r) => r.sessionClosed).length;
  const notified = results.filter((r) => r.sessionNotified).length;

  if (merged && db) {
    // Create memory analysis job for merged PRs.
    // The consumer fetches all review comments and runs the memory agent.
    if (prNumber && repoOwner && repoName && installationId) {
      try {
        const jobParams: MemoryAnalysisJobParams = {
          sessionIds,
          prUrl: prUrl!,
          prNumber,
          repoOwner,
          repoName,
          installationId,
          prTitle,
          prBody,
        };
        const memoryJobId = await createMemoryAnalysisJob(db, repoOwner, repoName, prNumber, JSON.stringify(jobParams));
        if (memoryJobId) {
          if (env.MEMORY_ANALYSIS_QUEUE) {
            const enqueuePromise = env.MEMORY_ANALYSIS_QUEUE.send({ jobId: memoryJobId }).catch((err: unknown) => {
              log.warn(
                { error: String(err), jobId: memoryJobId },
                "Failed to enqueue memory analysis; cron will pick it up",
              );
            });
            if (ctx) ctx.waitUntil(enqueuePromise);
          } else {
            log.error({ jobId: memoryJobId }, "MEMORY_ANALYSIS_QUEUE binding missing — job created but not enqueued");
          }
          log.info({ jobId: memoryJobId, prUrl, prNumber }, "Memory analysis job created for merged PR");
        }
      } catch (err) {
        // Non-fatal: memory job creation failure should not block the merge webhook response
        log.error({ error: String(err), prUrl, prNumber }, "Failed to create memory analysis job");
      }
    }
  }

  return jsonResponse({ ok: true, archived, notified, merged, total: sessionIds.length });
}

async function recordGithubPrMemoryIngestionForSessions(input: {
  env: Env;
  sessionIds: string[];
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  prBody: string | null;
  mergedAtMs: number;
  actorLogin: string | null;
}): Promise<void> {
  for (const sessionId of input.sessionIds) {
    try {
      const session = await getSessionState(input.env, sessionId);
      if (!session?.businessId) continue;
      await recordGithubPrMemoryIngestion(input.env, {
        businessId: session.businessId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        bodyText: input.prBody,
        mergedAtMs: input.mergedAtMs,
        actorLogin: input.actorLogin,
      });
      return;
    } catch (err) {
      log.warn({ sessionId, prUrl: input.prUrl, error: String(err) }, "GitHub PR memory ingestion failed");
    }
  }
}

async function handlePushEvent(
  _payload: Record<string, unknown>,
  _rawBody: string,
  _request: Request,
  _env: Env,
): Promise<Response> {
  return jsonResponse({ ok: true, skipped: true, reason: "push_event_noop" });
}
