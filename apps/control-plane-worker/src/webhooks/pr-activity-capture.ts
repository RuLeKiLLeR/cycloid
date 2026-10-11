// Pure, DB-free builder for the PR-activity capture log (migration 0248).
// Parses a GitHub webhook payload into a `PrActivityEventInput` row. NO gating,
// no D1, no handler state — the capture service (wired into github.ts) resolves
// the Cycloid-tracking gate + ownership session and does the write; this module
// only extracts, classifies, redacts, and size-caps.
//
// Two identities per row: `actor_*` is the ACTION actor (payload.sender — who
// edited/deleted/dismissed/submitted); `subjectAuthor_*` is the CONTENT author
// (comment.user / review.user / PR author). `occurred_at` is the action-time used
// for ordering. `body` / `diffHunk` / `rawJson` are secret-redacted (not
// PII-stripped) and size-capped so an oversized payload can never deterministically
// fail the INSERT and wedge the webhook. `rawJson` is a field-whitelisted snapshot
// (no `user.email`/`avatar_url`/profile URLs) plus the raw ISO timestamps.

import { redact } from "../../../../shared/observability/redact.js";
import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  isBotOrAppAuthor,
  knownReviewBotIdForActorLogin,
  normalizeGitHubActorLogin,
} from "../github/pr-review-bots";
import { type PrActivityEventInput, recordPrActivityEvent } from "../session/pr-activity-events-db";
import { getTrackingSessionIdForPrUrl } from "../session/pr-coordination-db";
import { normalizeWebhookReference } from "../utils";
import {
  extractCommonWebhookActor,
  extractGithubUserActor,
  extractRepoAndInstallation,
  log,
  recordField,
} from "./shared";

/** Size caps (chars). Bound the persisted row so an oversized payload can't deterministically fail the INSERT. */
const BODY_CAP = 65_536;
const DIFF_HUNK_CAP = 16_384;
const RAW_JSON_CAP = 65_536;
const TRUNCATION_MARKER = "…[truncated]";

/** Event types this module captures (routed from github.ts). */
export const CAPTURED_EVENT_TYPES = [
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request",
] as const;

/** The PR a webhook event refers to. Resolved before the tracking-gate lookup. */
export interface PrActivityPrRef {
  prUrl: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  installationId: number | null;
  headSha: string | null;
}

/** Result of building a row: a capturable input, or a supported event we could not build (logged/metered). */
export type BuildPrActivityResult =
  { kind: "capture"; input: PrActivityEventInput } | { kind: "malformed"; reason: string };

function idToString(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return normalizeWebhookReference(value);
}

function parseIsoToMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function capText(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return value.slice(0, Math.max(0, cap - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Classify the ACTION actor: cycloid-owned > known/typed bot > human. Null when no login. */
function classifyActorClass(login: string | null, type: string | null): string | null {
  if (!login) return null;
  if (ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(login))) return "cycloid";
  if (isBotOrAppAuthor(type) || knownReviewBotIdForActorLogin(login)) return "bot";
  return "human";
}

/**
 * Resolve the PR a webhook event refers to, or null when it is not a capturable
 * PR event (an `issue_comment` on a plain issue, or an event whose core PR
 * identity — url / number / owner / name — can't be resolved). The capture
 * service uses `prUrl` for the tracking-gate lookup.
 */
export function extractPrActivityRef(eventType: string, payload: Record<string, unknown>): PrActivityPrRef | null {
  const { repoOwner, repoName, installationId } = extractRepoAndInstallation(payload);

  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let headSha: string | null = null;

  if (eventType === "issue_comment") {
    const issue = recordField(payload.issue);
    const pullRequest = recordField(issue?.pull_request);
    if (!pullRequest) return null; // a comment on a plain issue, not a PR
    // Only the PR's html_url (`.../pull/N`) matches pr_coordination's stored pr_url.
    // Do NOT fall back to issue.html_url (`.../issues/N`) — that form never matches
    // the tracking gate and would silently drop capture. A PR issue_comment always
    // carries pull_request.html_url.
    prUrl = normalizeWebhookReference(pullRequest.html_url);
    prNumber = typeof issue?.number === "number" ? issue.number : null;
  } else {
    const pullRequest = recordField(payload.pull_request);
    prUrl = normalizeWebhookReference(pullRequest?.html_url);
    prNumber = typeof pullRequest?.number === "number" ? pullRequest.number : null;
    headSha = normalizeWebhookReference(recordField(pullRequest?.head)?.sha);
  }

  if (!prUrl || prNumber === null || !repoOwner || !repoName) return null;
  return { prUrl, repoOwner, repoName, prNumber, installationId, headSha };
}

interface EventContent {
  subjectId: string | null;
  subjectAuthorLogin: string | null;
  subjectAuthorType: string | null;
  body: string | null;
  reviewState: string | null;
  filePath: string | null;
  line: number | null;
  side: string | null;
  diffHunk: string | null;
  inReplyToId: string | null;
  title: string | null;
  createdMs: number | null;
  updatedMs: number | null;
  submittedMs: number | null;
  createdIso: string | null;
  updatedIso: string | null;
  submittedIso: string | null;
}

function isoOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Pull the event-type-specific content out of the payload's comment / review / pull_request subobject. */
function extractEventContent(eventType: string, payload: Record<string, unknown>): EventContent {
  const empty: EventContent = {
    subjectId: null,
    subjectAuthorLogin: null,
    subjectAuthorType: null,
    body: null,
    reviewState: null,
    filePath: null,
    line: null,
    side: null,
    diffHunk: null,
    inReplyToId: null,
    title: null,
    createdMs: null,
    updatedMs: null,
    submittedMs: null,
    createdIso: null,
    updatedIso: null,
    submittedIso: null,
  };

  if (eventType === "issue_comment") {
    const comment = recordField(payload.comment);
    const author = extractGithubUserActor(recordField(comment?.user));
    return {
      ...empty,
      subjectId: idToString(comment?.id),
      subjectAuthorLogin: author.userLogin,
      subjectAuthorType: author.userType || null,
      body: typeof comment?.body === "string" ? comment.body : null,
      createdMs: parseIsoToMs(comment?.created_at),
      updatedMs: parseIsoToMs(comment?.updated_at),
      createdIso: isoOf(comment?.created_at),
      updatedIso: isoOf(comment?.updated_at),
    };
  }

  if (eventType === "pull_request_review") {
    const review = recordField(payload.review);
    const author = extractGithubUserActor(recordField(review?.user));
    const submittedMs = parseIsoToMs(review?.submitted_at);
    return {
      ...empty,
      subjectId: idToString(review?.id),
      subjectAuthorLogin: author.userLogin,
      subjectAuthorType: author.userType || null,
      body: typeof review?.body === "string" ? review.body : null,
      reviewState: normalizeWebhookReference(review?.state)?.toLowerCase() ?? null,
      // Reviews carry only submitted_at in the webhook: submission IS the review's
      // creation; there is no update field, so an `edited`/`dismissed` review orders
      // by receipt time (resolveOccurredAt falls back to received_at).
      createdMs: submittedMs,
      updatedMs: null,
      submittedMs,
      submittedIso: isoOf(review?.submitted_at),
    };
  }

  if (eventType === "pull_request_review_comment") {
    const comment = recordField(payload.comment);
    const author = extractGithubUserActor(recordField(comment?.user));
    const line =
      typeof comment?.line === "number"
        ? comment.line
        : typeof comment?.original_line === "number"
          ? comment.original_line
          : null;
    return {
      ...empty,
      subjectId: idToString(comment?.id),
      subjectAuthorLogin: author.userLogin,
      subjectAuthorType: author.userType || null,
      body: typeof comment?.body === "string" ? comment.body : null,
      filePath: normalizeWebhookReference(comment?.path),
      line,
      side: normalizeWebhookReference(comment?.side),
      diffHunk: typeof comment?.diff_hunk === "string" ? comment.diff_hunk : null,
      inReplyToId: idToString(comment?.in_reply_to_id),
      createdMs: parseIsoToMs(comment?.created_at),
      updatedMs: parseIsoToMs(comment?.updated_at),
      createdIso: isoOf(comment?.created_at),
      updatedIso: isoOf(comment?.updated_at),
    };
  }

  // pull_request
  const pr = recordField(payload.pull_request);
  const author = extractGithubUserActor(recordField(pr?.user));
  return {
    ...empty,
    subjectId: null, // PR-level event
    subjectAuthorLogin: author.userLogin,
    subjectAuthorType: author.userType || null,
    body: typeof pr?.body === "string" ? pr.body : null,
    title: normalizeWebhookReference(pr?.title),
    createdMs: parseIsoToMs(pr?.created_at),
    updatedMs: parseIsoToMs(pr?.updated_at),
    createdIso: isoOf(pr?.created_at),
    updatedIso: isoOf(pr?.updated_at),
  };
}

/** Map an action to the timestamp at which it occurred (falls back to receipt time). */
function resolveOccurredAt(action: string, content: EventContent, receivedAt: number): number {
  switch (action) {
    case "created":
    case "opened":
      return content.createdMs ?? receivedAt;
    case "edited":
      return content.updatedMs ?? receivedAt;
    case "submitted":
      return content.submittedMs ?? receivedAt;
    // deleted / dismissed / resolved / unresolved / closed / reopened /
    // ready_for_review / converted_to_draft / synchronize: no reliable event-time field.
    default:
      return receivedAt;
  }
}

/**
 * Build a `PrActivityEventInput` from a webhook payload for a tracked PR. Returns
 * `malformed` (rather than a row that would violate a NOT NULL / uniqueness
 * constraint) when a required field can't be derived — the caller logs/meters it,
 * and because capture runs before the delivery claim, this avoids a permanent
 * redelivery wedge.
 */
export function buildPrActivityEventInput(params: {
  eventType: string;
  payload: Record<string, unknown>;
  prRef: PrActivityPrRef;
  deliveryId: string | null;
  sessionId: string;
  receivedAt: number;
}): BuildPrActivityResult {
  const { eventType, payload, prRef, deliveryId, sessionId, receivedAt } = params;

  if (!deliveryId) return { kind: "malformed", reason: "missing_delivery_id" };
  const action = normalizeWebhookReference(payload.action);
  if (!action) return { kind: "malformed", reason: "missing_action" };

  const actionActor = extractCommonWebhookActor(payload);
  const actorLogin = actionActor.senderLogin;
  const actorType = actionActor.senderType || null;
  const content = extractEventContent(eventType, payload);
  const occurredAt = resolveOccurredAt(action, content, receivedAt);

  const body = content.body === null ? null : capText(redact(content.body), BODY_CAP);
  const diffHunk = content.diffHunk === null ? null : capText(redact(content.diffHunk), DIFF_HUNK_CAP);

  // Field-whitelisted snapshot for fidelity: no body (it lives in its own column),
  // no raw user objects (drops incidental PII), plus the raw ISO timestamps.
  const rawSnapshot = {
    eventType,
    action,
    prUrl: prRef.prUrl,
    prNumber: prRef.prNumber,
    headSha: prRef.headSha,
    subjectId: content.subjectId,
    reviewState: content.reviewState,
    title: content.title,
    actor: { login: actorLogin, type: actorType },
    subjectAuthor: { login: content.subjectAuthorLogin, type: content.subjectAuthorType },
    filePath: content.filePath,
    line: content.line,
    side: content.side,
    inReplyToId: content.inReplyToId,
    timestamps: { createdAt: content.createdIso, updatedAt: content.updatedIso, submittedAt: content.submittedIso },
  };
  let rawJson = redact(JSON.stringify(rawSnapshot));
  if (rawJson.length > RAW_JSON_CAP) {
    rawJson = JSON.stringify({
      __truncated__: true,
      eventType,
      action,
      subjectId: content.subjectId,
      prUrl: prRef.prUrl,
    });
  }

  return {
    kind: "capture",
    input: {
      deliveryId,
      sessionId,
      repoOwner: prRef.repoOwner,
      repoName: prRef.repoName,
      prNumber: prRef.prNumber,
      prUrl: prRef.prUrl,
      installationId: prRef.installationId,
      eventType,
      action,
      subjectId: content.subjectId,
      inReplyToId: content.inReplyToId,
      reviewState: content.reviewState,
      actorLogin,
      actorType,
      actorClass: classifyActorClass(actorLogin, actorType),
      subjectAuthorLogin: content.subjectAuthorLogin,
      subjectAuthorType: content.subjectAuthorType,
      body,
      filePath: content.filePath,
      line: content.line,
      side: content.side,
      diffHunk,
      headSha: prRef.headSha,
      githubCreatedAt: content.createdMs,
      githubUpdatedAt: content.updatedMs,
      occurredAt,
      receivedAt,
      rawJson,
    },
  };
}

/** True iff this webhook event type is one the capture tap records. */
export function isCapturedPrActivityEventType(eventType: string | null | undefined): boolean {
  return typeof eventType === "string" && (CAPTURED_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * The capture tap: for a tracked PR, durably record one webhook event. Passive —
 * reads pr_coordination + writes pr_activity_events, with no effect on the handler's
 * own claim / FSM / review-loop path. Runs BEFORE the per-handler action / allow-list
 * filters, so edits, deletes, approvals, and dropped-bot comments on tracked PRs are
 * all captured.
 *
 * Gate order: not-a-PR-event → skip; untracked PR (no real coordinating session) →
 * skip (data-minimization); malformed supported event → log + skip (so no
 * constraint-violating row can wedge the delivery). A transient D1 error on the
 * write PROPAGATES so GitHub redelivers; the insert is idempotent on delivery_id.
 */
export async function capturePrActivityEvent(params: {
  env: { DB: D1Database };
  eventType: string;
  payload: Record<string, unknown>;
  request: Request;
}): Promise<void> {
  const { env, eventType, payload, request } = params;

  const prRef = extractPrActivityRef(eventType, payload);
  if (!prRef) return; // not a capturable PR event (e.g. an issue_comment on a plain issue)

  const sessionId = await getTrackingSessionIdForPrUrl(env.DB, prRef.prUrl);
  if (!sessionId) return; // untracked PR — the data-minimization boundary

  const deliveryId = normalizeWebhookReference(request.headers.get("x-github-delivery"));
  const result = buildPrActivityEventInput({
    eventType,
    payload,
    prRef,
    deliveryId,
    sessionId,
    receivedAt: Date.now(),
  });
  if (result.kind === "malformed") {
    log.warn(
      {
        eventType,
        action: normalizeWebhookReference(payload.action),
        prUrl: prRef.prUrl,
        deliveryId,
        reason: result.reason,
      },
      "PR activity capture skipped: malformed event",
    );
    return;
  }

  await recordPrActivityEvent(env.DB, result.input);
}
