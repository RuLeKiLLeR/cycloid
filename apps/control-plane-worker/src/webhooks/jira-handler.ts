import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { MAX_UPLOADED_IMAGE_SIZE_BYTES, MAX_UPLOADED_IMAGES } from "../../../../shared/constants/uploads.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
  type IntegrationLifecycleReasonCode,
} from "../../../../shared/enums/integration-lifecycle.js";
import type { UploadedImage } from "../../../../shared/types/sandbox.js";
import { flattenAdfDescription, formatJiraIssueCommentAsAdf } from "../../../../shared/utils/adf.js";
import { isRecord } from "../../../../shared/utils/type-guards.js";
import {
  acceptUploadedImagePayload,
  arrayBufferToBase64,
  isSupportedImageMimeType,
  trimUploadedImagesToPromptBudget,
} from "../../../../shared/utils/uploads.js";
import { getUserBusinessIdOrNull, getValidJiraToken } from "../auth/db";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { getJiraUserSite, getUserByExternalId } from "../integrations/db";
import { classifyProviderHttpFailure } from "../integrations/provider-failure";
import { degradeJiraInstallationReactively } from "../integrations/reactive-health";
import { createLogger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { tracedFetch } from "../observability/wrappers";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import { resolveBaseModelForAutomaticRouting } from "../services/session-model-routing";
import { syncSessionProjection } from "../services/session-projection";
import { getSessionLivenessRows } from "../session/db";
import { closeSessionForWebhook, createSessionState, enqueueSessionPrompt } from "../session/state";
import type { Env } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse, normalizeWebhookReference } from "../utils";
import { readCappedWebhookBody } from "./body-limit";
import {
  claimJiraIssueSessionRef,
  claimJiraIssueSkipNotice,
  deleteJiraIssueSessionRefIfSession,
  deleteJiraIssueSkipNotice,
  getJiraIssueSessionRef,
  getJiraWebhookInstallationByToken,
  getSessionIdByJiraIssueRef,
  type JiraIssueSessionRef,
  type JiraWebhookInstallation,
  releaseWebhookIdempotencyClaim,
  upsertSessionWebhookRef,
} from "./db";
import { jiraTriggerLabel } from "./jira-registration";
import { buildJiraIssuePrompt, JIRA_ISSUE_PROMPT_COMMENTS_MAX_RESULTS, parseRepoPromptFromText } from "./prompts";
import {
  authorizeWebhookRepoPolicy,
  claimOrSkip,
  emitLifecycleEvent,
  emitWebhookDrop,
  emitWebhookSkipLifecycle,
  recordWebhookDrop,
  repoSkipCommentText,
  resolveUserSettings,
  resolveWebhookRepoSelectionPolicy,
  type WebhookDropFields,
} from "./shared";
import { verifyJiraWebhookJwt } from "./verify";

const log = createLogger({ bindings: { component: "jira-webhook" } });

export const WEBHOOK_SOURCE_JIRA = "jira";
const SESSION_WEBHOOK_REF_SOURCE_JIRA_ISSUE = "jira_issue";
const JIRA_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const JIRA_ISSUE_FETCH_TIMEOUT_MS = 10_000;
const JIRA_ATTACHMENT_FETCH_TIMEOUT_MS = 5_000;
const JIRA_ISSUE_COMMENT_TIMEOUT_MS = 10_000;
const JIRA_ISSUE_COMMENTS_FETCH_TIMEOUT_MS = 5_000;
const JIRA_EVENT_ALLOWLIST = new Set(["jira:issue_created", "jira:issue_updated"]);
const JIRA_SKIP_COMMENT_REASONS = new Set([
  "repo_inference_unknown",
  "invalid_repo_url",
  "no_installation",
  "repo_not_authorized",
  "repo_access_verification_failed",
]);
// Mirrors the Linear displacement guard: a ref may be displaced only once it is
// old enough that an in-flight bootstrap cannot still be racing, and only when
// the session it points at is provably dead.
const JIRA_SESSION_REF_DISPLACE_MIN_AGE_MS = 2 * 60 * 1000;
const JIRA_DEAD_SESSION_STATUSES = new Set(["archived"]);

interface JiraWebhookDropFields extends WebhookDropFields {
  payloadHash?: string | null;
  cloudId?: string | null;
  jiraIssueKey?: string | null;
}

function jiraSkipReasonCode(reason: string): IntegrationLifecycleReasonCode | null {
  switch (reason) {
    case "invalid_repo_url":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_URL_INVALID;
    case "no_installation":
      return INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING;
    case "repo_not_authorized":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED;
    case "repo_access_verification_failed":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_CHECK_FAILED;
    case "repo_inference_unavailable":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_INFERENCE_UNAVAILABLE;
    case "repo_inference_unknown":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_INFERENCE_UNKNOWN;
    case "payload_malformed":
    case "payload_too_large":
    case "missing_issue_key":
    case "unexpected_event_type":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_PAYLOAD_MALFORMED;
    case "unknown_installation_token":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED;
    case "actor_not_connected":
    case "actor_business_mismatch":
    case "actor_site_mismatch":
      return INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED;
    default:
      return null;
  }
}

function jiraDropExtraFields(fields: JiraWebhookDropFields) {
  return {
    payloadHash: fields.payloadHash ?? null,
    cloudId: fields.cloudId ?? null,
    jiraIssueKey: fields.jiraIssueKey ?? null,
  };
}

function jiraWebhookDropOptions(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  fields: JiraWebhookDropFields;
}) {
  return {
    ...params,
    lifecycleEmitter: emitLifecycleEvent,
    integrationId: "jira" as const,
    provider: "jira",
    eventName: "jira.webhook_dropped",
    label: "Jira",
    reasonCode: jiraSkipReasonCode,
    lifecycleDetails: jiraDropExtraFields,
    datadogFields: jiraDropExtraFields,
    logFailure: (fields: JiraWebhookDropFields, err: unknown) => {
      log.warn({ reason: fields.reason, error: String(err) }, "Failed to record Jira webhook drop");
    },
  };
}

async function emitJiraWebhookDrop(env: Env, db: D1Database, fields: JiraWebhookDropFields): Promise<void> {
  await emitWebhookDrop(jiraWebhookDropOptions({ env, db, fields }));
}

export function recordJiraWebhookDrop(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  fields: JiraWebhookDropFields;
}): void {
  recordWebhookDrop(jiraWebhookDropOptions(params));
}

async function readJiraResponseDetail(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text ? text.slice(0, 500) : null;
  } catch {
    return null;
  }
}

export async function postJiraIssueComment(params: {
  env: Env;
  db: D1Database;
  installation: JiraWebhookInstallation;
  issueKey: string;
  text: string;
}): Promise<{ success: boolean }> {
  const { env, db, installation, issueKey, text } = params;
  const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
  if (!accessToken) {
    log.warn({ issueKey, cloudId: installation.jiraCloudId }, "Jira skip notice token unavailable");
    return { success: false };
  }

  let response: Response;
  try {
    response = await tracedFetch(
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(installation.jiraCloudId)}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: formatJiraIssueCommentAsAdf(text) }),
        signal: AbortSignal.timeout(JIRA_ISSUE_COMMENT_TIMEOUT_MS),
      },
      "jira.issueCommentCreate",
    );
  } catch (err) {
    log.warn({ issueKey, cloudId: installation.jiraCloudId, error: String(err) }, "Jira skip notice post failed");
    return { success: false };
  }

  const responseDetail = await readJiraResponseDetail(response);
  if (!response.ok) {
    log.warn(
      { issueKey, cloudId: installation.jiraCloudId, status: response.status, responseDetail },
      "Jira skip notice post returned an error",
    );
    return { success: false };
  }
  return { success: true };
}

function jiraPickupCommentBody(sessionUrl: string): string {
  return `Cycloid picked up this ticket and is working on it. Session: ${sessionUrl}. A pull request will follow.`;
}

export async function markJiraIssuePickedUp(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  installation: JiraWebhookInstallation;
  issueKey: string;
  sessionId: string;
  statusCategoryKey: string | null;
  statusCategoryKnown: boolean;
  assigneeAccountId: string | null;
  assigneeKnown: boolean;
  actorAccountId: string;
}): Promise<void> {
  const task = (async () => {
    const {
      env,
      db,
      installation,
      issueKey,
      sessionId,
      statusCategoryKey,
      statusCategoryKnown,
      assigneeAccountId,
      assigneeKnown,
      actorAccountId,
    } = params;
    const sessionUrl = `${resolvePublicAppBaseUrl(env)}/sessions/${sessionId}`;
    try {
      await postJiraIssueComment({
        env,
        db,
        installation,
        issueKey,
        text: jiraPickupCommentBody(sessionUrl),
      });
    } catch (err) {
      log.warn({ issueKey, error: String(err) }, "Jira pickup comment failed");
    }

    const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
    if (!accessToken) {
      log.warn({ issueKey }, "Jira pickup mutation token unavailable");
      return;
    }
    const baseUrl = `https://api.atlassian.com/ex/jira/${encodeURIComponent(installation.jiraCloudId)}`;
    if (statusCategoryKnown && statusCategoryKey !== "indeterminate" && statusCategoryKey !== "done") {
      try {
        const response = await tracedFetch(
          `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
          {
            headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
            signal: AbortSignal.timeout(JIRA_ISSUE_COMMENT_TIMEOUT_MS),
          },
          "jira.issueTransitionsList",
        );
        const body = (await response.json()) as { transitions?: unknown };
        const transitions = Array.isArray(body.transitions) ? body.transitions : [];
        const candidates = transitions.flatMap((transition) => {
          if (!isRecord(transition) || !isRecord(transition.to)) return [];
          const to = transition.to;
          if (!isRecord(to) || !isRecord(to.statusCategory) || to.statusCategory.key !== "indeterminate") return [];
          const id = typeof transition.id === "string" ? transition.id : null;
          const name = typeof to.name === "string" ? to.name : "";
          return id ? [{ id, name }] : [];
        });
        const transition = candidates.find((candidate) => candidate.name === "In Progress");
        if (!transition) {
          log.warn({ issueKey }, "Jira pickup transition unavailable");
        } else {
          const transitionResponse = await tracedFetch(
            `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify({ transition: { id: transition.id } }),
              signal: AbortSignal.timeout(JIRA_ISSUE_COMMENT_TIMEOUT_MS),
            },
            "jira.issueTransition",
          );
          if (!transitionResponse.ok)
            log.warn({ issueKey, status: transitionResponse.status }, "Jira pickup transition failed");
        }
      } catch (err) {
        log.warn({ issueKey, error: String(err) }, "Jira pickup transition threw");
      }
    }

    if (assigneeKnown && assigneeAccountId === null) {
      try {
        const response = await tracedFetch(
          `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${accessToken}`,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ accountId: actorAccountId }),
            signal: AbortSignal.timeout(JIRA_ISSUE_COMMENT_TIMEOUT_MS),
          },
          "jira.issueAssigneeUpdate",
        );
        if (!response.ok) log.warn({ issueKey, status: response.status }, "Jira pickup assignee update failed");
      } catch (err) {
        log.warn({ issueKey, error: String(err) }, "Jira pickup assignee update threw");
      }
    }
  })().catch((err) => {
    log.error({ issueKey: params.issueKey, error: String(err) }, "Jira pickup task failed");
  });
  if (params.ctx) {
    params.ctx.waitUntil(task);
    return;
  }
  await task;
}

export async function notifyJiraWebhookSkip(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  installation: JiraWebhookInstallation;
  businessId: string | null;
  actorUserId: string;
  jiraIssueId: string;
  jiraIssueKey: string;
  reason: string;
  repoOwner?: string | null;
  repoName?: string | null;
  payloadHash?: string | null;
  cloudId?: string | null;
}): Promise<void> {
  const {
    env,
    db,
    ctx,
    installation,
    businessId,
    actorUserId,
    jiraIssueId,
    jiraIssueKey,
    reason,
    repoOwner,
    repoName,
  } = params;
  const cloudId = params.cloudId ?? installation.jiraCloudId;

  const task = (async () => {
    await emitWebhookSkipLifecycle({
      db,
      integrationId: "jira",
      provider: "jira",
      businessId,
      userId: actorUserId,
      reasonCode: jiraSkipReasonCode(reason),
      message: `Jira session not started: ${reason}`,
      reason,
      details: { cloudId, jiraIssueKey, payloadHash: params.payloadHash ?? null },
      lifecycleEmitter: emitLifecycleEvent,
    });
    await emitJiraWebhookDrop(env, db, {
      reason,
      emitLifecycle: false,
      businessId,
      userId: actorUserId,
      jiraIssueKey,
      payloadHash: params.payloadHash ?? null,
      cloudId,
    });

    if (!JIRA_SKIP_COMMENT_REASONS.has(reason)) return;

    const claimed = await claimJiraIssueSkipNotice(db, jiraIssueId, reason);
    if (!claimed) return;

    const commentResult = await postJiraIssueComment({
      env,
      db,
      installation,
      issueKey: jiraIssueKey,
      text: repoSkipCommentText(reason, repoOwner, repoName),
    });
    if (!commentResult.success) {
      await deleteJiraIssueSkipNotice(db, jiraIssueId, reason);
    }
  })().catch((err) => {
    log.error({ jiraIssueId, jiraIssueKey, reason, error: String(err) }, "Jira skip notice task failed");
  });

  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  await task;
}

interface RefetchedJiraIssue {
  key: string;
  issueId: string | null;
  summary: string | null;
  description: string | null;
  comments: JiraIssuePromptComment[];
  status: string | null;
  statusCategoryKey: string | null;
  statusCategoryKnown: boolean;
  assigneeAccountId: string | null;
  assigneeKnown: boolean;
  issueType: string | null;
  labels: string[];
  uploadedImages: UploadedImage[];
}

interface JiraIssuePromptComment {
  body: string;
  authorName: string;
}

type JiraAttachmentSkipReason =
  | "auth_failed"
  | "cap_exceeded"
  | "download_failed"
  | "invalid_payload"
  | "non_image"
  | "oversize"
  | "payload_budget"
  | "unsafe_host";

export interface JiraIssueAttachment {
  id: string;
  filename: string;
  mimeType: string;
  content: string;
}

function normalizeJiraAttachmentId(rawId: unknown): string | null {
  if (typeof rawId === "number" && Number.isSafeInteger(rawId)) return String(rawId);
  return normalizeWebhookReference(rawId);
}

function logJiraAttachmentSkipped(reason: JiraAttachmentSkipReason, fields: Record<string, unknown> = {}): void {
  log.warn({ event: "jira_attachment_skipped", reason, ...fields }, "Skipped Jira image attachment");
}

function parseJiraIssueAttachments(rawAttachments: unknown): JiraIssueAttachment[] {
  if (!Array.isArray(rawAttachments)) return [];
  const attachments: JiraIssueAttachment[] = [];
  for (const rawAttachment of rawAttachments) {
    if (!rawAttachment || typeof rawAttachment !== "object") continue;
    const attachment = rawAttachment as Record<string, unknown>;
    const id = normalizeJiraAttachmentId(attachment.id);
    const filename = normalizeWebhookReference(attachment.filename);
    const mimeType = normalizeWebhookReference(attachment.mimeType);
    const content = normalizeWebhookReference(attachment.content);
    if (!id || !filename || !mimeType || !content) continue;
    attachments.push({ id, filename, mimeType, content });
  }
  return attachments;
}

function isSafeJiraAttachmentContentUrl(rawUrl: string, cloudId: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (
      hostname === "api.atlassian.com" &&
      url.pathname.startsWith(`/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/attachment/content/`)
    ) {
      return true;
    }
    return (
      hostname.endsWith(".atlassian.net") &&
      (url.pathname.startsWith("/jira/rest/api/3/attachment/content/") ||
        url.pathname.startsWith("/rest/api/3/attachment/content/"))
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function isSafeJiraAttachmentRedirectUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    if (
      hostname.includes(":") &&
      (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80"))
    ) {
      return false;
    }
    if (isPrivateIpv4(hostname)) return false;
    return (
      hostname === "api.atlassian.com" || hostname === "api.media.atlassian.com" || hostname.endsWith(".amazonaws.com")
    );
  } catch {
    return false;
  }
}

function uniqueJiraImageName(attachment: JiraIssueAttachment): string {
  const safeFilename = attachment.filename.replace(/[\\/]/g, "-").trim() || "attachment";
  return `jira-${attachment.id}-${safeFilename}`;
}

function contentLengthExceedsLimit(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) return false;
  const parsedLength = Number(contentLength);
  return Number.isFinite(parsedLength) && parsedLength > maxBytes;
}

async function readJiraAttachmentBuffer(response: Response, attachmentId: string): Promise<ArrayBuffer | null> {
  if (contentLengthExceedsLimit(response, MAX_UPLOADED_IMAGE_SIZE_BYTES)) {
    logJiraAttachmentSkipped("oversize", { attachmentId });
    return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
    logJiraAttachmentSkipped("oversize", { attachmentId, byteLength: buffer.byteLength });
    return null;
  }
  return buffer;
}

async function downloadJiraAttachmentImage(
  attachment: JiraIssueAttachment,
  token: string,
  cloudId: string,
): Promise<ArrayBuffer | null> {
  if (!isSafeJiraAttachmentContentUrl(attachment.content, cloudId)) {
    logJiraAttachmentSkipped("unsafe_host", { attachmentId: attachment.id });
    return null;
  }

  const authedResponse = await tracedFetch(
    attachment.content,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(JIRA_ATTACHMENT_FETCH_TIMEOUT_MS),
    },
    "jira.webhook.attachmentDownload",
  );

  if ([301, 302, 303, 307, 308].includes(authedResponse.status)) {
    const location = authedResponse.headers.get("location");
    if (!location) {
      logJiraAttachmentSkipped("download_failed", { attachmentId: attachment.id, httpStatus: authedResponse.status });
      return null;
    }
    const redirectUrl = new URL(location, attachment.content).toString();
    if (!isSafeJiraAttachmentRedirectUrl(redirectUrl)) {
      logJiraAttachmentSkipped("unsafe_host", { attachmentId: attachment.id });
      return null;
    }
    const redirectedResponse = await tracedFetch(
      redirectUrl,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(JIRA_ATTACHMENT_FETCH_TIMEOUT_MS),
      },
      "jira.webhook.attachmentDownloadRedirect",
    );
    if (!redirectedResponse.ok) {
      logJiraAttachmentSkipped("download_failed", {
        attachmentId: attachment.id,
        httpStatus: redirectedResponse.status,
      });
      return null;
    }
    return readJiraAttachmentBuffer(redirectedResponse, attachment.id);
  }

  if (authedResponse.status === 401 || authedResponse.status === 403) {
    logJiraAttachmentSkipped("auth_failed", { attachmentId: attachment.id, httpStatus: authedResponse.status });
    return null;
  }
  if (!authedResponse.ok) {
    logJiraAttachmentSkipped("download_failed", { attachmentId: attachment.id, httpStatus: authedResponse.status });
    return null;
  }
  return readJiraAttachmentBuffer(authedResponse, attachment.id);
}

export async function fetchJiraIssueImages(
  attachments: readonly JiraIssueAttachment[],
  token: string,
  cloudId: string,
  _env: Env,
): Promise<UploadedImage[]> {
  const uploadedImages: UploadedImage[] = [];
  const seenProviderIds = new Set<string>();

  for (const attachment of attachments) {
    if (!isSupportedImageMimeType(attachment.mimeType)) {
      logJiraAttachmentSkipped("non_image", { attachmentId: attachment.id });
      continue;
    }
    if (seenProviderIds.has(attachment.id)) continue;
    seenProviderIds.add(attachment.id);
    if (uploadedImages.length >= MAX_UPLOADED_IMAGES) {
      logJiraAttachmentSkipped("cap_exceeded", { attachmentId: attachment.id });
      continue;
    }

    try {
      const buffer = await downloadJiraAttachmentImage(attachment, token, cloudId);
      if (!buffer) continue;
      const accepted = acceptUploadedImagePayload(
        {
          name: uniqueJiraImageName(attachment),
          mediaType: attachment.mimeType.toLowerCase(),
          data: arrayBufferToBase64(buffer),
        },
        uploadedImages,
      );
      if (!accepted.ok) {
        logJiraAttachmentSkipped("invalid_payload", { attachmentId: attachment.id });
        continue;
      }
      uploadedImages.push(accepted.image);
    } catch (err) {
      logJiraAttachmentSkipped("download_failed", { attachmentId: attachment.id, error: String(err) });
    }
  }

  return uploadedImages;
}

function parseJiraIssueComments(body: unknown): JiraIssuePromptComment[] | null {
  if (!isRecord(body)) return null;
  const comments = body.comments;
  if (!Array.isArray(comments)) return null;

  return comments.flatMap((comment) => {
    if (!isRecord(comment)) return [];
    const flattenedBody = flattenAdfDescription(comment.body);
    if (!flattenedBody) return [];
    const author = isRecord(comment.author) ? comment.author : null;
    const authorName = normalizeWebhookReference(author?.displayName) ?? "jira_user";
    return [{ body: flattenedBody, authorName }];
  });
}

export async function fetchJiraIssueComments(params: {
  token: string;
  cloudId: string;
  issueKey: string;
}): Promise<JiraIssuePromptComment[]> {
  const { token, cloudId, issueKey } = params;
  try {
    const response = await tracedFetch(
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=${JIRA_ISSUE_PROMPT_COMMENTS_MAX_RESULTS}&orderBy=-created`,
      {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(JIRA_ISSUE_COMMENTS_FETCH_TIMEOUT_MS),
      },
      "jira.webhook.issueCommentsFetch",
    );

    if (!response.ok) {
      log.warn({ issueKey, cloudId, status: response.status }, "Jira issue comments fetch returned an error");
      return [];
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (err) {
      log.warn({ issueKey, cloudId, error: String(err) }, "Jira issue comments fetch returned malformed JSON");
      return [];
    }

    const comments = parseJiraIssueComments(responseBody);
    if (!comments) {
      log.warn({ issueKey, cloudId }, "Jira issue comments fetch returned unexpected response shape");
      return [];
    }
    return [...comments].reverse();
  } catch (err) {
    log.warn({ issueKey, cloudId, error: String(err) }, "Jira issue comments fetch failed");
    return [];
  }
}

/**
 * The webhook payload is only a hint; the re-fetch through the business
 * binding credential is authoritative for content and trigger-label state.
 * Label-removed-before-refetch races resolve to a drop by design.
 */
export async function refetchJiraIssue(
  env: Env,
  db: D1Database,
  installation: JiraWebhookInstallation,
  issueKey: string,
): Promise<{ status: "ok"; issue: RefetchedJiraIssue } | { status: "skipped"; reason: string }> {
  const accessToken = await getValidJiraToken(db, String(installation.connectedByUserId), env);
  if (!accessToken) {
    return { status: "skipped", reason: "binding_credential_unavailable" };
  }

  let response: Response;
  try {
    response = await tracedFetch(
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(installation.jiraCloudId)}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,labels,issuetype,attachment,assignee`,
      {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(JIRA_ISSUE_FETCH_TIMEOUT_MS),
      },
      "jira.webhook.issueRefetch",
    );
  } catch (err) {
    log.warn({ issueKey, error: String(err) }, "Jira issue re-fetch failed");
    return { status: "skipped", reason: "issue_refetch_failed" };
  }

  if (response.status === 404) {
    return { status: "skipped", reason: "issue_not_found" };
  }
  if (!response.ok) {
    log.warn({ issueKey, status: response.status }, "Jira issue re-fetch returned an error");
    // Real-traffic reactive detection: a 401 from the issue endpoint means the
    // installer's OAuth token is dead, so surface it immediately instead of
    // waiting up to the full poll interval. The issue endpoint is resource-
    // scoped, so a 403 (no access to this one issue) must NOT disconnect the
    // whole integration.
    const { durability } = classifyProviderHttpFailure(response.status, { resourceScoped: true });
    if (durability === "durable_auth") {
      await degradeJiraInstallationReactively(db, env, {
        businessId: installation.businessId,
        jiraCloudId: installation.jiraCloudId,
        operation: "jira.webhook.issueRefetch",
        reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
        httpStatus: response.status,
      });
    }
    return { status: "skipped", reason: "issue_refetch_failed" };
  }

  const body = (await response.json()) as {
    id?: unknown;
    key?: unknown;
    fields?: {
      summary?: unknown;
      description?: unknown;
      status?: { name?: unknown; statusCategory?: { key?: unknown } | null } | null;
      assignee?: { accountId?: unknown } | null;
      labels?: unknown;
      issuetype?: { name?: unknown } | null;
      attachment?: unknown;
    } | null;
  };
  const fields = body.fields ?? {};
  const [uploadedImages, comments] = await Promise.all([
    fetchJiraIssueImages(parseJiraIssueAttachments(fields?.attachment), accessToken, installation.jiraCloudId, env),
    fetchJiraIssueComments({ token: accessToken, cloudId: installation.jiraCloudId, issueKey }),
  ]);
  return {
    status: "ok",
    issue: {
      key: normalizeWebhookReference(body.key) ?? issueKey,
      issueId: normalizeWebhookReference(body.id),
      summary: normalizeWebhookReference(fields?.summary),
      description: flattenAdfDescription(fields?.description),
      comments,
      status: normalizeWebhookReference(fields?.status?.name),
      statusCategoryKey: normalizeWebhookReference(fields?.status?.statusCategory?.key),
      statusCategoryKnown:
        isRecord(fields?.status) &&
        isRecord(fields.status.statusCategory) &&
        typeof fields.status.statusCategory.key === "string",
      assigneeAccountId: normalizeWebhookReference(fields?.assignee?.accountId),
      assigneeKnown: fields?.assignee === null || isRecord(fields?.assignee),
      issueType: normalizeWebhookReference(fields?.issuetype?.name),
      labels: Array.isArray(fields?.labels)
        ? fields.labels.filter((label): label is string => typeof label === "string")
        : [],
      uploadedImages,
    },
  };
}

/** Site-scoped ref key: keeps issue refs unambiguous if a second site is ever bound. */
function jiraIssueRefId(cloudId: string, issue: RefetchedJiraIssue): string {
  return `${cloudId}:${issue.issueId ?? issue.key}`;
}

/**
 * Stable per-delivery dedupe id for a Jira webhook, or null when the payload
 * carries no stable sub-id (caller falls back to the payload hash). Uses the
 * changelog id (issue updates) or comment id, scoped by cloudId + webhookEvent
 * + issueId so it is unique per legitimate event and stable across a retry of
 * the same delivery. Deliberately excludes the regenerable top-level timestamp.
 */
export function buildJiraStableDeliveryId(cloudId: string, payload: Record<string, unknown>): string | null {
  const webhookEvent = normalizeWebhookReference(payload.webhookEvent);
  if (!webhookEvent) return null;
  const changelog = payload.changelog as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const deliveryScopeId = normalizeWebhookReference(changelog?.id) ?? normalizeWebhookReference(comment?.id);
  if (!deliveryScopeId) return null;
  const issueId = normalizeWebhookReference(issue?.id) ?? normalizeWebhookReference(issue?.key) ?? "noissue";
  return `${cloudId}:${webhookEvent}:${issueId}:${deliveryScopeId}`;
}

async function isDisplaceableJiraSessionRef(
  db: D1Database,
  ref: JiraIssueSessionRef,
  now = Date.now(),
): Promise<boolean> {
  // Refs younger than the guard may belong to an in-flight bootstrap whose
  // session row has not landed yet; never displace those.
  const updatedAtMs = ref.updatedAt ? Date.parse(ref.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return false;
  if (now - updatedAtMs < JIRA_SESSION_REF_DISPLACE_MIN_AGE_MS) return false;

  try {
    const rows = await getSessionLivenessRows(db, [ref.sessionId]);
    const row = rows[0];
    if (!row) return true;
    return JIRA_DEAD_SESSION_STATUSES.has(row.status);
  } catch (err) {
    log.warn({ sessionId: ref.sessionId, error: String(err) }, "Jira session ref liveness lookup failed; keeping ref");
    return false;
  }
}

async function cleanupFailedJiraBootstrapSession(params: {
  env: Env;
  db: D1Database;
  jiraIssueId: string;
  sessionId: string;
  cause: unknown;
}): Promise<void> {
  const { env, db, jiraIssueId, sessionId, cause } = params;
  await runWithSentryTag(
    "handleJiraWebhook.bootstrapCleanup",
    async () => {
      await deleteJiraIssueSessionRefIfSession(db, jiraIssueId, sessionId);
      await closeSessionForWebhook(env, db, sessionId, { reason: "jira_bootstrap_failed" });
    },
    log,
    {
      message: "Failed to clean up Jira session after bootstrap failure",
      logFields: { jiraIssueId, sessionId, cause: String(cause) },
    },
  );
}

export async function handleJiraWebhook(
  request: Request,
  env: Env,
  installationToken: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const db = env.DB;

  // Primary ingress control: Atlassian signs OAuth-app webhook deliveries with
  // an HS256 JWT keyed by the app client secret. Everything below it (URL
  // token, issue re-fetch) is defense in depth.
  const jwtValid = await verifyJiraWebhookJwt(request.headers.get("authorization"), env.JIRA_OAUTH_CLIENT_SECRET || "");
  if (!jwtValid) {
    recordJiraWebhookDrop({ env, db, ctx, fields: { reason: "jwt_verification_failed", emitLifecycle: false } });
    return jsonResponse({ ok: true, skipped: true, reason: "jwt_verification_failed" });
  }

  const bodyResult = await readCappedWebhookBody(request, JIRA_WEBHOOK_MAX_BODY_BYTES);
  if (bodyResult instanceof Response) {
    recordJiraWebhookDrop({ env, db, ctx, fields: { reason: "payload_too_large", emitLifecycle: false } });
    return jsonResponse({ ok: true, skipped: true, reason: "payload_too_large" });
  }
  const rawBody = bodyResult;

  const installation = await getJiraWebhookInstallationByToken(db, installationToken);
  if (!installation) {
    recordJiraWebhookDrop({ env, db, ctx, fields: { reason: "unknown_installation_token", emitLifecycle: false } });
    return jsonResponse({ ok: true, skipped: true, reason: "unknown_installation_token" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: { reason: "payload_malformed", businessId: installation.businessId, cloudId: installation.jiraCloudId },
    });
    return jsonErrorResponse("Invalid JSON", 400);
  }

  const payloadHash = await computeSha256Hex(rawBody);
  // Jira retries a failed delivery at most five times in a short window. A
  // payload-hash-only claim misses those retries if Jira regenerates the
  // top-level `timestamp` (the body is no longer byte-identical). Prefer a
  // stable Jira-provided per-delivery id instead: the changelog id (issue
  // updates) or comment id uniquely identifies the change, is stable across a
  // retry of the SAME delivery, and differs between DISTINCT legitimate events
  // (a later comment / status change), so it neither misses retries nor
  // dedupes unrelated future updates within the idempotency TTL. Scope it by
  // cloudId + webhookEvent + issueId so ids cannot collide across sites, event
  // types, or issues. Events with no stable sub-id fall back to the payload-hash
  // key (prior behavior). NOTE: changelog/comment id stability across a Jira
  // retry is assumed from Atlassian's webhook contract; confirm against a
  // captured real redelivery before relying on it broadly.
  const stableDeliveryId = buildJiraStableDeliveryId(installation.jiraCloudId, payload);
  const { duplicate, idempotencyKey } = await claimOrSkip(db, WEBHOOK_SOURCE_JIRA, stableDeliveryId, payloadHash);
  if (duplicate) return duplicate;

  const releaseIdempotencyClaim = async (context: string): Promise<void> => {
    try {
      await releaseWebhookIdempotencyClaim(db, WEBHOOK_SOURCE_JIRA, idempotencyKey);
    } catch (releaseErr) {
      log.error(
        { idempotencyKey, context, error: String(releaseErr) },
        "Failed to release Jira webhook idempotency claim; redelivery will be deduped until the claim TTL expires",
      );
    }
  };

  try {
    return await processJiraWebhook({
      env,
      db,
      ctx,
      payload,
      payloadHash,
      installation,
      releaseIdempotencyClaim,
    });
  } catch (err) {
    await releaseIdempotencyClaim("handler_error");
    throw err;
  }
}

async function processJiraWebhook(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  payloadHash: string;
  installation: JiraWebhookInstallation;
  releaseIdempotencyClaim: (context: string) => Promise<void>;
}): Promise<Response> {
  const { env, db, ctx, payload, payloadHash, installation, releaseIdempotencyClaim } = params;
  const businessId = installation.businessId;
  const cloudId = installation.jiraCloudId;

  const dropFields = (
    fields: Omit<JiraWebhookDropFields, "businessId" | "cloudId" | "payloadHash">,
  ): JiraWebhookDropFields => ({ ...fields, businessId, cloudId, payloadHash });

  await emitLifecycleEvent({
    db,
    integrationId: "jira",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_VERIFIED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId,
    message: "Jira webhook JWT and installation token verified.",
    details: { provider: "jira", cloudId, auth: "jwt+installation_token" },
  });

  const webhookEvent = normalizeWebhookReference(payload.webhookEvent);
  if (!webhookEvent || !JIRA_EVENT_ALLOWLIST.has(webhookEvent)) {
    recordJiraWebhookDrop({ env, db, ctx, fields: dropFields({ reason: "unexpected_event_type" }) });
    return jsonResponse({ ok: true, skipped: true, reason: "unexpected_event_type" });
  }

  const payloadIssue = payload.issue as Record<string, unknown> | undefined;
  const issueKey = normalizeWebhookReference(payloadIssue?.key);
  if (!issueKey) {
    recordJiraWebhookDrop({ env, db, ctx, fields: dropFields({ reason: "missing_issue_key" }) });
    return jsonResponse({ ok: true, skipped: true, reason: "missing_issue_key" });
  }

  // Authoritative content + trigger-label check via the binding credential.
  const refetch = await refetchJiraIssue(env, db, installation, issueKey);
  if (refetch.status === "skipped") {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({ reason: refetch.reason, jiraIssueKey: issueKey }),
    });
    if (refetch.reason === "issue_refetch_failed" || refetch.reason === "binding_credential_unavailable") {
      // Transient dependency failure: release the payload-hash claim and
      // return non-2xx so Jira's retries are not silently deduplicated.
      await releaseIdempotencyClaim(refetch.reason);
      return jsonErrorResponse("Jira issue re-fetch unavailable", 503);
    }
    return jsonResponse({ ok: true, skipped: true, reason: refetch.reason });
  }
  const issue = refetch.issue;

  // Validate against the label the remote JQL filter was registered with;
  // env is only the fallback for rows that predate label persistence. If the
  // env label changes without a re-registration, deliveries still match what
  // Atlassian actually filtered on.
  const triggerLabel = installation.triggerLabel?.toLowerCase() ?? jiraTriggerLabel(env);
  if (!issue.labels.some((label) => label.toLowerCase() === triggerLabel)) {
    return jsonResponse({ ok: true, skipped: true, reason: "trigger_label_missing" });
  }

  const jiraIssueId = jiraIssueRefId(cloudId, issue);
  const existingRef = await getJiraIssueSessionRef(db, jiraIssueId);
  if (existingRef) {
    // Displace only refs that provably point at a dead session (leaked claim
    // from a failed bootstrap) so a label re-add can recover the issue.
    const displaceable = await isDisplaceableJiraSessionRef(db, existingRef);
    if (!displaceable) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "session_already_exists",
        sessionId: existingRef.sessionId,
      });
    }
    const displaced = await deleteJiraIssueSessionRefIfSession(db, jiraIssueId, existingRef.sessionId);
    if (displaced) {
      log.warn({ jiraIssueId, displacedSessionId: existingRef.sessionId }, "Displaced stale Jira issue session ref");
      recordJiraWebhookDrop({
        env,
        db,
        ctx,
        fields: dropFields({
          reason: "stale_session_ref_displaced",
          status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
          jiraIssueKey: issue.key,
          sessionId: existingRef.sessionId,
        }),
      });
      await runWithSentryTag(
        "handleJiraWebhook.displacedSessionClose",
        async () => {
          await closeSessionForWebhook(env, db, existingRef.sessionId, { reason: "jira_stale_ref_displaced" });
        },
        log,
        {
          message: "Failed to close displaced Jira zombie session",
          logFields: { jiraIssueId, sessionId: existingRef.sessionId },
        },
      );
    }
  }

  // Actor resolution: the JWT-authenticated payload's actor accountId maps to
  // a Cycloid user via the jira credential's external_user_id.
  const actorAccountId = normalizeWebhookReference((payload.user as Record<string, unknown> | undefined)?.accountId);
  if (!actorAccountId) {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({ reason: "actor_not_connected", jiraIssueKey: issue.key }),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "actor_not_connected" });
  }
  const resolvedUser = await getUserByExternalId(db, "jira", actorAccountId);
  if (!resolvedUser) {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({ reason: "actor_not_connected", jiraIssueKey: issue.key }),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "actor_not_connected" });
  }
  const actorUserId = String(resolvedUser.id);

  const actorBusinessId = await getUserBusinessIdOrNull(db, resolvedUser.id);
  if (actorBusinessId !== businessId) {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({ reason: "actor_business_mismatch", userId: actorUserId, jiraIssueKey: issue.key }),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "actor_business_mismatch" });
  }

  // Site consistency: the actor's selected site must be the bound site, or the
  // session's spawn-time tools would operate against a different Jira site.
  const actorSite = await getJiraUserSite(db, resolvedUser.id);
  if (!actorSite || actorSite.jiraCloudId !== cloudId) {
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({ reason: "actor_site_mismatch", userId: actorUserId, jiraIssueKey: issue.key }),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "actor_site_mismatch" });
  }
  const browseUrl = `${actorSite.siteUrl.replace(/\/$/, "")}/browse/${issue.key}`;

  await emitLifecycleEvent({
    db,
    integrationId: "jira",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId,
    userId: actorUserId,
    message: "Jira webhook resolved the tenant and actor context.",
    details: { provider: "jira", cloudId, actor: actorAccountId },
  });

  const sessionId = crypto.randomUUID();
  const claimedIssue = await claimJiraIssueSessionRef(db, jiraIssueId, sessionId);
  if (!claimedIssue) {
    const claimedSessionId = await getSessionIdByJiraIssueRef(db, jiraIssueId);
    if (!claimedSessionId) {
      log.warn({ jiraIssueId, attemptedSessionId: sessionId }, "Jira issue session claim lost without winner");
      await releaseIdempotencyClaim("session_claim_lost");
      recordJiraWebhookDrop({
        env,
        db,
        ctx,
        fields: dropFields({
          reason: "session_claim_lost",
          status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
          userId: actorUserId,
          jiraIssueKey: issue.key,
        }),
      });
      return jsonResponse({ ok: false, error: "session_claim_lost" }, 503);
    }
    return jsonResponse({ ok: true, skipped: true, reason: "session_already_exists", sessionId: claimedSessionId });
  }

  let sessionCreated = false;
  const releaseIssueClaim = async (reason: string): Promise<void> => {
    if (sessionCreated) return;
    const released = await deleteJiraIssueSessionRefIfSession(db, jiraIssueId, sessionId);
    if (released) {
      log.info({ jiraIssueId, sessionId, reason }, "Released Jira issue session claim before session creation");
    }
  };

  try {
    const settings = await resolveUserSettings(db, actorUserId);
    const defaultRepoUrl = settings?.default_repo ?? null;
    const defaultModel =
      extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(settings?.default_model)) ?? null;
    const parsedDescriptionRepo = parseRepoPromptFromText(issue.description);

    const selection = await resolveWebhookRepoSelectionPolicy({
      sourceLabel: "Jira",
      actorUserId,
      explicitRepoUrl: parsedDescriptionRepo.repoUrl,
      defaultRepoUrl,
      fallBackFromInvalidExplicitRepoUrl: true,
      // v1 has no Jira-side repo inference: the issue must name the repo
      // (repo=owner/name in the description) or the user must have a default.
      inferRepo: async () => ({ status: "skipped", reason: "repo_inference_unknown" }),
    });
    if (selection.status !== "resolved") {
      await releaseIssueClaim("repo_resolution_skipped");
      await notifyJiraWebhookSkip({
        env,
        db,
        ctx,
        installation,
        businessId,
        actorUserId,
        jiraIssueId,
        jiraIssueKey: issue.key,
        reason: selection.reason,
        payloadHash,
        cloudId,
      });
      return jsonResponse({ ok: true, skipped: true, reason: selection.reason });
    }

    const authorization = await authorizeWebhookRepoPolicy({
      sourceLabel: "Jira",
      env,
      db,
      actorUserId,
      repoUrl: selection.repoUrl,
      repoOwner: selection.repoOwner ?? null,
      repoName: selection.repoName ?? null,
      verifyRepoAccess: true,
    });
    if (authorization.status !== "authorized") {
      await releaseIssueClaim("repo_authorization_skipped");
      if (authorization.reason === "repo_access_verification_failed") {
        // Transient dependency failure: free the dedupe claim so Jira's
        // redelivery can retry.
        await releaseIdempotencyClaim(authorization.reason);
      }
      const repoOwner = authorization.owner ?? selection.repoOwner;
      const repoName = authorization.repo ?? selection.repoName;
      await notifyJiraWebhookSkip({
        env,
        db,
        ctx,
        installation,
        businessId,
        actorUserId,
        jiraIssueId,
        jiraIssueKey: issue.key,
        reason: authorization.reason,
        repoOwner,
        repoName,
        payloadHash,
        cloudId,
      });
      if (authorization.reason === "repo_access_verification_failed") {
        return jsonResponse({ ok: false, error: authorization.reason }, 503);
      }
      return jsonResponse({ ok: true, skipped: true, reason: authorization.reason });
    }

    const prompt = buildJiraIssuePrompt({
      issueKey: issue.key,
      summary: issue.summary,
      description: parsedDescriptionRepo.directivePresent ? (parsedDescriptionRepo.prompt ?? null) : issue.description,
      comments: issue.comments,
      browseUrl,
      labels: issue.labels,
      status: issue.status,
      issueType: issue.issueType,
      defaultRepoUrl: `https://github.com/${authorization.owner}/${authorization.repo}`,
    });
    const uploadedImageBudget = trimUploadedImagesToPromptBudget({
      promptText: prompt,
      uploadedImages: issue.uploadedImages,
    });
    if (uploadedImageBudget.droppedCount > 0) {
      logJiraAttachmentSkipped("payload_budget", { droppedCount: uploadedImageBudget.droppedCount });
    }
    const baseModel = resolveBaseModelForAutomaticRouting(defaultModel);

    const { session, replay } = await createSessionState(env, sessionId, actorUserId, {
      entrypoint: SessionEntrypoint.JIRA,
      repoContext: { repoOwner: authorization.owner, repoName: authorization.repo },
      installationId: authorization.installation.installation_id,
      model: baseModel.currentModel,
      agentRuntimeBackend: baseModel.agentRuntimeBackend,
      waitUntil: ctx ? ctx.waitUntil.bind(ctx) : undefined,
    });
    await syncSessionProjection({
      db,
      sessionId,
      session,
      replay,
      logger: log,
      source: "webhooks.jira.create",
      userId: actorUserId,
    });
    await upsertSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_JIRA_ISSUE, jiraIssueId, session.sessionId);
    sessionCreated = true;
    const enqueueResult = await enqueueSessionPrompt(env, session.sessionId, prompt, actorUserId, {
      uploadedImages: uploadedImageBudget.uploadedImages,
    });
    if (!enqueueResult.ok) {
      throw new Error(`Jira webhook bootstrap enqueue failed: ${enqueueResult.error}`);
    }

    await emitLifecycleEvent({
      db,
      integrationId: "jira",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_FOLLOWUP_ENQUEUED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      businessId,
      userId: actorUserId,
      sessionId: session.sessionId,
      message: "Jira webhook session created and bootstrap prompt enqueued.",
      details: { provider: "jira", cloudId, jiraIssueKey: issue.key },
    });

    await markJiraIssuePickedUp({
      env,
      db,
      ctx,
      installation,
      issueKey: issue.key,
      sessionId: session.sessionId,
      statusCategoryKey: issue.statusCategoryKey,
      statusCategoryKnown: issue.statusCategoryKnown,
      assigneeAccountId: issue.assigneeAccountId,
      assigneeKnown: issue.assigneeKnown,
      actorAccountId,
    });

    return jsonResponse({
      ok: true,
      created: true,
      sessionId: session.sessionId,
      jiraIssueKey: issue.key,
      enqueued: true,
      repoSource: selection.source,
    });
  } catch (err) {
    if (sessionCreated) {
      await cleanupFailedJiraBootstrapSession({ env, db, jiraIssueId, sessionId, cause: err });
    } else {
      try {
        await releaseIssueClaim("pre_session_failure");
      } catch (releaseErr) {
        log.error(
          { jiraIssueId, sessionId, error: String(releaseErr) },
          "Failed to release Jira issue claim after handler error",
        );
      }
    }
    recordJiraWebhookDrop({
      env,
      db,
      ctx,
      fields: dropFields({
        reason: sessionCreated ? "session_bootstrap_failed" : "session_setup_failed",
        status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
        userId: actorUserId,
        jiraIssueKey: issue.key,
        sessionId: sessionCreated ? sessionId : null,
      }),
    });
    throw err;
  }
}
