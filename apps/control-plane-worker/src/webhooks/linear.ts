import { MAX_UPLOADED_IMAGE_SIZE_BYTES, MAX_UPLOADED_IMAGES } from "../../../../shared/constants/uploads.js";
import type { UploadedImage } from "../../../../shared/types/sandbox.js";
import { isRecord } from "../../../../shared/utils/type-guards.js";
import {
  acceptUploadedImagePayload,
  arrayBufferToBase64,
  isSupportedImageMimeType,
} from "../../../../shared/utils/uploads.js";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { LinearContext } from "../types";

const log = createLogger({ bindings: { component: "webhook" } });

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_IMAGE_FETCH_TIMEOUT_MS = 5_000;
const LINEAR_MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Identifier class mirrors TICKET_KEY_SHAPE (`[A-Z][A-Z0-9]*-\d+`) so alphanumeric
// project keys (e.g. `A1-123`) are captured, not just all-alpha prefixes.
const LINEAR_URL_RE = /https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)\S*/;

type LinearAttachmentSkipReason =
  "auth_failed" | "cap_exceeded" | "download_failed" | "invalid_payload" | "non_image" | "oversize" | "unsafe_host";

type LinearMarkdownImageSource = {
  url: string;
  name: string;
};

function logLinearAttachmentSkipped(reason: LinearAttachmentSkipReason, fields: Record<string, unknown> = {}): void {
  log.warn({ event: "linear_attachment_skipped", reason, ...fields }, "Skipped Linear image attachment");
}

async function readLinearGraphqlBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function hasLinearGraphqlErrors(body: Record<string, unknown>): boolean {
  if (!("errors" in body)) return false;
  return !Array.isArray(body.errors) || body.errors.length > 0;
}

function isSafeLinearUploadUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "uploads.linear.app";
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

function isBlockedIpv6Host(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized.includes(":") && (normalized === "::1" || /^(fc|fd|fe[89ab])/i.test(normalized));
}

function isSafeLinearRedirectUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return false;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    if (isBlockedIpv6Host(hostname)) return false;
    if (isPrivateIpv4(hostname)) return false;
    return hostname === "uploads.linear.app" || hostname.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
}

function linearImageNameFromUrl(rawUrl: string, index: number): string {
  try {
    const url = new URL(rawUrl);
    const lastPathPart = url.pathname.split("/").filter(Boolean).pop() ?? `image-${index + 1}`;
    return `linear-${index + 1}-${decodeURIComponent(lastPathPart).replace(/[\\/]/g, "-")}`;
  } catch {
    return `linear-${index + 1}-image`;
  }
}

export function extractLinearMarkdownImageSources(markdownValues: readonly string[]): LinearMarkdownImageSource[] {
  const seen = new Set<string>();
  const sources: LinearMarkdownImageSource[] = [];
  for (const markdown of markdownValues) {
    for (const match of markdown.matchAll(LINEAR_MARKDOWN_IMAGE_RE)) {
      const rawUrl = match[1];
      if (!isSafeLinearUploadUrl(rawUrl)) continue;
      const url = new URL(rawUrl).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, name: linearImageNameFromUrl(url, sources.length) });
    }
  }
  return sources;
}

function contentLengthExceedsLimit(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) return false;
  const parsedLength = Number(contentLength);
  return Number.isFinite(parsedLength) && parsedLength > maxBytes;
}

async function readLinearImageBuffer(response: Response, url: string): Promise<ArrayBuffer | null> {
  if (contentLengthExceedsLimit(response, MAX_UPLOADED_IMAGE_SIZE_BYTES)) {
    logLinearAttachmentSkipped("oversize", { host: new URL(url).hostname });
    return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
    logLinearAttachmentSkipped("oversize", { host: new URL(url).hostname, byteLength: buffer.byteLength });
    return null;
  }
  return buffer;
}

async function downloadLinearMarkdownImage(source: LinearMarkdownImageSource, token: string): Promise<Response | null> {
  if (!isSafeLinearUploadUrl(source.url)) {
    logLinearAttachmentSkipped("unsafe_host");
    return null;
  }
  const authedResponse = await tracedFetch(
    source.url,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(LINEAR_IMAGE_FETCH_TIMEOUT_MS),
    },
    "linear.webhook.attachmentDownload",
  );
  if ([301, 302, 303, 307, 308].includes(authedResponse.status)) {
    const location = authedResponse.headers.get("location");
    if (!location) {
      logLinearAttachmentSkipped("download_failed", { httpStatus: authedResponse.status });
      return null;
    }
    const redirectUrl = new URL(location, source.url).toString();
    if (!isSafeLinearRedirectUrl(redirectUrl)) {
      logLinearAttachmentSkipped("unsafe_host");
      return null;
    }
    return tracedFetch(
      redirectUrl,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(LINEAR_IMAGE_FETCH_TIMEOUT_MS),
      },
      "linear.webhook.attachmentDownloadRedirect",
    );
  }
  return authedResponse;
}

export async function fetchLinearIssueMarkdownImageSources(
  linearToken: string,
  linearIssueId: string,
): Promise<LinearMarkdownImageSource[]> {
  const res = await tracedFetch(
    LINEAR_GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${linearToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `query LinearIssueImageMarkdown($linearIssueId: String!) {
          issue(id: $linearIssueId) {
            description
            comments(last: 5) { nodes { body } }
          }
        }`,
        variables: { linearIssueId },
      }),
      signal: AbortSignal.timeout(LINEAR_IMAGE_FETCH_TIMEOUT_MS),
    },
    "linear.issue.imageMarkdown",
  );
  const responseBody = await readLinearGraphqlBody(res);
  if (!res.ok || !isRecord(responseBody) || hasLinearGraphqlErrors(responseBody)) {
    throw new Error(`Linear issue image markdown query failed with status ${res.status}`);
  }
  const data = isRecord(responseBody.data) ? responseBody.data : null;
  const issue = data && isRecord(data.issue) ? data.issue : null;
  const comments = issue && isRecord(issue.comments) ? issue.comments : null;
  const commentNodes = comments && Array.isArray(comments.nodes) ? comments.nodes : [];
  const markdownValues = [
    typeof issue?.description === "string" ? issue.description : "",
    ...commentNodes.flatMap((node) => (isRecord(node) && typeof node.body === "string" ? [node.body] : [])),
  ];
  return extractLinearMarkdownImageSources(markdownValues);
}

export async function fetchLinearIssueImages(linearToken: string, linearIssueId: string): Promise<UploadedImage[]> {
  let sources: LinearMarkdownImageSource[];
  try {
    sources = await fetchLinearIssueMarkdownImageSources(linearToken, linearIssueId);
  } catch (err) {
    log.warn({ linearIssueId, error: String(err) }, "Linear image source fetch failed");
    return [];
  }

  const uploadedImages: UploadedImage[] = [];
  const attemptedSources = sources.slice(0, MAX_UPLOADED_IMAGES);
  if (sources.length > MAX_UPLOADED_IMAGES) {
    logLinearAttachmentSkipped("cap_exceeded", { skippedCount: sources.length - MAX_UPLOADED_IMAGES });
  }
  for (const source of attemptedSources) {
    try {
      const response = await downloadLinearMarkdownImage(source, linearToken);
      if (!response) continue;
      if (response.status === 401 || response.status === 403) {
        logLinearAttachmentSkipped("auth_failed", { httpStatus: response.status });
        continue;
      }
      if (!response.ok) {
        logLinearAttachmentSkipped("download_failed", { httpStatus: response.status });
        continue;
      }
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!isSupportedImageMimeType(mediaType)) {
        logLinearAttachmentSkipped("non_image");
        continue;
      }
      const buffer = await readLinearImageBuffer(response, source.url);
      if (!buffer) continue;
      const accepted = acceptUploadedImagePayload(
        { name: source.name, mediaType, data: arrayBufferToBase64(buffer) },
        uploadedImages,
      );
      if (!accepted.ok) {
        logLinearAttachmentSkipped("invalid_payload");
        continue;
      }
      uploadedImages.push(accepted.image);
    } catch (err) {
      logLinearAttachmentSkipped("download_failed", { error: String(err) });
    }
  }
  return uploadedImages;
}

export type LinearMutationResult = { success: boolean; externalId: string | null };

export type LinearIssuePickupContext = {
  viewerId: string;
  issue: {
    assigneeId: string | null;
    state: { id: string; type: string } | null;
    startedStates: Array<{ id: string; type: string; position: number }>;
    commentBodies: string[];
  };
};

export type LinearIssuePickupUpdate = {
  stateId: string | null;
  assigneeId: string | null;
};

/** Pick only safe, non-destructive Linear changes for a newly claimed issue. */
export function selectLinearIssuePickupUpdate(context: LinearIssuePickupContext): LinearIssuePickupUpdate {
  const currentStateType = context.issue.state?.type;
  const stateId = ["triage", "backlog", "unstarted"].includes(currentStateType ?? "")
    ? (context.issue.startedStates.slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0]?.id ??
      null)
    : null;
  return {
    stateId,
    assigneeId: context.issue.assigneeId === null ? context.viewerId : null,
  };
}

export function pickupCommentBody(sessionUrl: string): string {
  return `Cycloid picked up this ticket and is working on it. Session: ${sessionUrl}. A pull request will follow.`;
}

export async function fetchLinearIssuePickupContext(
  linearToken: string,
  linearIssueId: string,
): Promise<LinearIssuePickupContext> {
  const res = await tracedFetch(
    LINEAR_GRAPHQL_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${linearToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query LinearIssuePickupContext($id: String!) {
          viewer { id }
          issue(id: $id) {
            assignee { id }
            state { id type }
            team { states { nodes { id type position } } }
            comments(last: 20) { nodes { body } }
          }
        }`,
        variables: { id: linearIssueId },
      }),
      signal: AbortSignal.timeout(LINEAR_IMAGE_FETCH_TIMEOUT_MS),
    },
    "linear.issuePickupContext",
  );
  const responseBody = await readLinearGraphqlBody(res);
  if (!res.ok || !isRecord(responseBody) || hasLinearGraphqlErrors(responseBody)) {
    throw new Error(`Linear issue pickup context query failed with status ${res.status}`);
  }
  const data = isRecord(responseBody.data) ? responseBody.data : null;
  const viewer = data && isRecord(data.viewer) ? data.viewer : null;
  const issue = data && isRecord(data.issue) ? data.issue : null;
  if (typeof viewer?.id !== "string" || !issue) throw new Error("Linear issue pickup context response was incomplete");
  const assignee = isRecord(issue.assignee) ? issue.assignee : null;
  const state = isRecord(issue.state) ? issue.state : null;
  const team = isRecord(issue.team) ? issue.team : null;
  const states = team && isRecord(team.states) && Array.isArray(team.states.nodes) ? team.states.nodes : [];
  const comments = isRecord(issue.comments) && Array.isArray(issue.comments.nodes) ? issue.comments.nodes : [];
  return {
    viewerId: viewer.id,
    issue: {
      assigneeId: typeof assignee?.id === "string" ? assignee.id : null,
      state:
        typeof state?.id === "string" && typeof state.type === "string" ? { id: state.id, type: state.type } : null,
      startedStates: states.flatMap((node) => {
        if (!isRecord(node) || node.type !== "started" || typeof node.id !== "string") return [];
        const position = typeof node.position === "number" ? node.position : Number(node.position);
        return Number.isFinite(position) ? [{ id: node.id, type: "started", position }] : [];
      }),
      commentBodies: comments.flatMap((node) => (isRecord(node) && typeof node.body === "string" ? [node.body] : [])),
    },
  };
}

export async function updateLinearIssueForPickup(
  linearToken: string,
  linearIssueId: string,
  update: LinearIssuePickupUpdate,
): Promise<LinearMutationResult> {
  const input: Record<string, string> = {};
  if (update.stateId) input.stateId = update.stateId;
  if (update.assigneeId) input.assigneeId = update.assigneeId;
  if (Object.keys(input).length === 0) return { success: true, externalId: null };
  const res = await tracedFetch(
    LINEAR_GRAPHQL_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${linearToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation IssuePickupUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        variables: { id: linearIssueId, input },
      }),
    },
    "linear.issuePickupUpdate",
  );
  const responseBody = await readLinearGraphqlBody(res);
  const result = parseLinearMutationResult(responseBody, "issueUpdate", "issue");
  return res.ok ? result : { success: false, externalId: null };
}

/**
 * Parse a Linear create-mutation response into `{ success, externalId }`. The
 * external id (e.g. `attachmentCreate.attachment.id`) is only present when the
 * mutation query selects the entity sub-field; absent → `externalId: null`.
 */
function parseLinearMutationResult(body: unknown, mutationField: string, entityField: string): LinearMutationResult {
  if (!isRecord(body) || hasLinearGraphqlErrors(body)) return { success: false, externalId: null };
  const data = isRecord(body.data) ? body.data : null;
  const mutationResult = data && isRecord(data[mutationField]) ? data[mutationField] : null;
  const success = mutationResult?.success === true;
  const entity = mutationResult && isRecord(mutationResult[entityField]) ? mutationResult[entityField] : null;
  const externalId = entity && typeof entity.id === "string" ? entity.id : null;
  return { success, externalId };
}

export function extractLinearContextFromPrompt(prompt: string): LinearContext | null {
  const match = prompt.match(LINEAR_URL_RE);
  if (!match) return null;
  const url = match[0].replace(/[),.\]]+$/, "");
  const identifier = match[1];
  return { identifier, url };
}

/** Deterministic attachment URL for a session, used both to post and to recover. */
export function linearSessionAttachmentUrl(frontendUrl: string, sessionId: string): string {
  return `${frontendUrl}/sessions/${sessionId}`;
}

/**
 * Create the Linear attachment linking an issue to its Cycloid session.
 * Returns `{ success, externalId }`; the external id is captured from
 * `attachmentCreate.attachment.id` so the bootstrap job can checkpoint the
 * link and skip re-posting on resume (ARC-1051).
 */
export async function linkSessionToLinearIssue(
  linearToken: string,
  linearIssueId: string,
  sessionId: string,
  frontendUrl: string,
  repoFullName?: string,
): Promise<LinearMutationResult> {
  const sessionUrl = linearSessionAttachmentUrl(frontendUrl, sessionId);
  const title = repoFullName ? `Cycloid session for ${repoFullName}` : "Cycloid session";
  const res = await tracedFetch(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${linearToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation AttachmentCreate($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }`,
        variables: {
          input: {
            issueId: linearIssueId,
            title,
            subtitle: sessionId.slice(0, 8),
            url: sessionUrl,
            iconUrl: "https://app.trycycloid.com/favicon.ico",
          },
        },
      }),
    },
    "linear.attachmentCreate",
  );
  const responseBody = await readLinearGraphqlBody(res);
  const result = parseLinearMutationResult(responseBody, "attachmentCreate", "attachment");
  if (!res.ok || !result.success) {
    log.warn({ linearIssueId, sessionId, status: res.status, responseBody }, "Linear attachmentCreate failed");
    return { success: false, externalId: null };
  }
  return result;
}

/**
 * Recovery query for link-back idempotency: find an existing attachment on the
 * issue whose `url` equals the deterministic session URL. Returns its id, or
 * null when none exists. Throws on transport/GraphQL error so the caller can
 * treat it as transient and retry rather than risk a duplicate post.
 */
export async function findLinearAttachmentExternalIdByUrl(
  linearToken: string,
  linearIssueId: string,
  attachmentUrl: string,
): Promise<string | null> {
  const res = await tracedFetch(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${linearToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `query IssueAttachments($id: String!) { issue(id: $id) { attachments { nodes { id url } } } }`,
        variables: { id: linearIssueId },
      }),
    },
    "linear.issueAttachments",
  );
  const responseBody = await readLinearGraphqlBody(res);
  if (!res.ok || !isRecord(responseBody) || hasLinearGraphqlErrors(responseBody)) {
    throw new Error(`Linear issue attachments query failed with status ${res.status}`);
  }
  const data = isRecord(responseBody.data) ? responseBody.data : null;
  const issue = data && isRecord(data.issue) ? data.issue : null;
  const attachments = issue && isRecord(issue.attachments) ? issue.attachments : null;
  const nodes = attachments && Array.isArray(attachments.nodes) ? attachments.nodes : [];
  for (const node of nodes) {
    if (isRecord(node) && node.url === attachmentUrl && typeof node.id === "string") {
      return node.id;
    }
  }
  return null;
}

export async function postLinearIssueComment(
  linearToken: string,
  linearIssueId: string,
  body: string,
): Promise<LinearMutationResult> {
  const res = await tracedFetch(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${linearToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
        variables: {
          input: {
            issueId: linearIssueId,
            body,
          },
        },
      }),
    },
    "linear.commentCreate",
  );
  const responseBody = await readLinearGraphqlBody(res);
  const result = parseLinearMutationResult(responseBody, "commentCreate", "comment");
  if (!res.ok || !result.success) {
    log.warn({ linearIssueId, status: res.status, responseBody }, "Linear commentCreate failed");
    return { success: false, externalId: null };
  }
  return result;
}
