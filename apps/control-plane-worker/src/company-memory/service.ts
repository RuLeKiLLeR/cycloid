import { scanForSecrets } from "../../../../shared/redaction/secrets.js";
import { COMPANY_MEMORY_SOURCE_TYPE, type CompanyMemorySourceType } from "../constants/company-memory";
import { createLogger } from "../logger";
import { getWorkspaceInstallMetadata, type SlackWorkspaceInstallMetadata } from "../slack/workspaces";
import type { Env } from "../types";
import { computeSha256Hex, normalizeWebhookReference } from "../utils";
import { enqueueMemoryContextDeriveForIngestion, type EnqueueMemoryContextIngestionParams } from "./context-producers";
import { getChannelIntake, getIngestionEventBySourceUri, recordIngestionEvent, type SlackChannelIntakeRow } from "./db";
import { enqueueMemoryRefineIfPending } from "./refine";

const log = createLogger({ bindings: { component: "company-memory" } });
const MAX_INLINE_CONTENT_TEXT_BYTES = 1_000_000;

// The memory-context graph is best-effort: a D1 failure here must never fail the
// ingestion webhook (retries skip the enqueue when result.created is false, so a
// throw would strand the event permanently). Log and continue.
export async function safeEnqueueMemoryContextDeriveForIngestion(
  db: D1Database,
  params: EnqueueMemoryContextIngestionParams,
): Promise<void> {
  try {
    await enqueueMemoryContextDeriveForIngestion(db, params);
  } catch (error) {
    log.error(
      { err: error, businessId: params.businessId, ingestionEventId: params.ingestionEventId },
      "Failed to enqueue memory-context derive for ingestion; continuing",
    );
  }
}

interface SlackEventPayload {
  event_id?: unknown;
  team_id?: unknown;
}

interface SlackEventBody {
  type?: unknown;
  channel_type?: unknown;
  text?: unknown;
  user?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
}

export function isCompanyMemorySlackSubtypeAllowed(event: Record<string, unknown> | undefined): boolean {
  const subtype = normalizeWebhookReference(event?.subtype);
  if (!subtype) return true;
  return !new Set([
    "bot_message",
    "message_changed",
    "message_deleted",
    "message_replied",
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "pinned_item",
    "file_share",
  ]).has(subtype);
}

export function mapSlackEventToSourceType(
  event: SlackEventBody,
  intakeRow: SlackChannelIntakeRow | null,
): CompanyMemorySourceType {
  if (intakeRow) return COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE;
  if (event.type === "app_mention") return COMPANY_MEMORY_SOURCE_TYPE.SLACK_APP_MENTION;
  return COMPANY_MEMORY_SOURCE_TYPE.SLACK_THREAD_PASTE;
}

export function buildSlackSourceUri(input: {
  teamId: string | null;
  teamDomain: string | null;
  channelId: string;
  messageTs: string;
}): string {
  const ts = input.messageTs.replace(".", "");
  if (input.teamDomain) return `https://${input.teamDomain}.slack.com/archives/${input.channelId}/p${ts}`;
  return `slack://${input.teamId ?? "unknown"}/${input.channelId}/${input.messageTs}`;
}

function isPublicSlackChannel(event: SlackEventBody): boolean {
  return event.channel_type === "channel";
}

export async function resolveSlackWorkspaceForMemory(
  env: Env,
  teamId: string | null,
): Promise<SlackWorkspaceInstallMetadata | null> {
  if (!teamId) return null;
  const workspace = await getWorkspaceInstallMetadata(env.DB, teamId);
  if (!workspace || workspace.uninstalledAt !== null) return null;
  return workspace;
}

export async function recordSlackIngestion(
  env: Env,
  payload: SlackEventPayload,
  event: SlackEventBody,
  input: {
    businessId?: string | null;
    workspace?: SlackWorkspaceInstallMetadata | null;
    intakeRow?: SlackChannelIntakeRow | null;
  },
): Promise<{ created: boolean; id: string } | null> {
  const teamId = normalizeWebhookReference(payload.team_id) ?? null;
  const channelId = normalizeWebhookReference(event.channel);
  const messageTs = normalizeWebhookReference(event.ts);
  const threadTs = normalizeWebhookReference(event.thread_ts || event.ts);
  if (!teamId || !channelId || !messageTs || !threadTs) return null;
  const sourceTimeMs = Math.floor(Number.parseFloat(messageTs) * 1000);
  if (!Number.isFinite(sourceTimeMs)) return null;

  const workspace = input?.workspace ?? (await resolveSlackWorkspaceForMemory(env, teamId));
  const businessId = input?.businessId ?? workspace?.businessId ?? null;
  if (!businessId) {
    log.warn({ teamId, channelId }, "Skipping Slack memory ingestion: workspace business_id unavailable");
    return null;
  }
  const intakeRow =
    input && "intakeRow" in input
      ? (input.intakeRow ?? null)
      : await getChannelIntake(env.DB, businessId, teamId, channelId);
  const rawText = typeof event.text === "string" ? event.text : "";
  const text = truncateInlineContentText(rawText);
  const redaction = scanForSecrets(rawText);
  const sourceUri = buildSlackSourceUri({
    teamId,
    teamDomain: workspace?.teamDomain ?? null,
    channelId,
    messageTs,
  });
  const existing = await getIngestionEventBySourceUri(env.DB, businessId, sourceUri);
  if (existing) return { id: existing.id, created: false };

  const result = await recordIngestionEvent(env.DB, {
    businessId,
    sourceType: mapSlackEventToSourceType(event, intakeRow),
    sourceEventId: normalizeWebhookReference(payload.event_id),
    sourceUri,
    sourceTimeMs,
    contentHash: await computeSha256Hex(rawText),
    contentText: redaction.quarantined ? null : text,
    contentRef: null,
    scopeType: intakeRow?.scopeType ?? null,
    scopeId: intakeRow?.scopeId ?? null,
    actorRef: normalizeWebhookReference(event.user) ? `slack_user:${normalizeWebhookReference(event.user)}` : null,
    teamId,
    channelId,
    threadTs,
    untrustedPayload: isPublicSlackChannel(event),
    redactionReason: redaction.quarantined ? redaction.reason : null,
  });
  if (!redaction.quarantined) {
    await enqueueMemoryRefineIfPending(env, result, businessId);
    await safeEnqueueMemoryContextDeriveForIngestion(env.DB, {
      created: result.created,
      ingestionEventId: result.id,
      businessId,
      sourceType: mapSlackEventToSourceType(event, intakeRow),
      sourceEventId: normalizeWebhookReference(payload.event_id),
      sourceUri,
      sourceTimeMs,
      contentText: text,
      scopeType: intakeRow?.scopeType ?? null,
      scopeId: intakeRow?.scopeId ?? null,
      actorRef: normalizeWebhookReference(event.user) ? `slack_user:${normalizeWebhookReference(event.user)}` : null,
      teamId,
      channelId,
      threadTs,
      nowMs: Date.now(),
    });
  }
  return result;
}

function truncateInlineContentText(text: string): string {
  const encoded = new TextEncoder();
  if (encoded.encode(text).byteLength <= MAX_INLINE_CONTENT_TEXT_BYTES) return text;
  let truncated = text.slice(0, MAX_INLINE_CONTENT_TEXT_BYTES);
  while (encoded.encode(truncated).byteLength > MAX_INLINE_CONTENT_TEXT_BYTES && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

async function recordCompanyMemoryIngestion(
  env: Env,
  input: {
    businessId: string;
    sourceType: CompanyMemorySourceType;
    sourceEventId: string;
    sourceUri: string;
    sourceTimeMs?: number;
    contentText: string;
    contentRef: string;
    scopeType?: "repo" | null;
    scopeId?: string | null;
    actorRef?: string | null;
  },
): Promise<{ created: boolean; id: string }> {
  const text = truncateInlineContentText(input.contentText);
  const redaction = scanForSecrets(input.contentText);
  const result = await recordIngestionEvent(env.DB, {
    businessId: input.businessId,
    sourceType: input.sourceType,
    sourceEventId: input.sourceEventId,
    sourceUri: input.sourceUri,
    sourceTimeMs: input.sourceTimeMs ?? Date.now(),
    contentHash: await computeSha256Hex(input.contentText),
    contentText: redaction.quarantined ? null : text,
    contentRef: input.contentRef,
    scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null,
    actorRef: input.actorRef ?? null,
    untrustedPayload: false,
    redactionReason: redaction.quarantined ? redaction.reason : null,
  });
  if (!redaction.quarantined) {
    await enqueueMemoryRefineIfPending(env, result, input.businessId);
    await safeEnqueueMemoryContextDeriveForIngestion(env.DB, {
      created: result.created,
      ingestionEventId: result.id,
      businessId: input.businessId,
      sourceType: input.sourceType,
      sourceEventId: input.sourceEventId,
      sourceUri: input.sourceUri,
      sourceTimeMs: input.sourceTimeMs ?? Date.now(),
      contentText: text,
      scopeType: input.scopeType ?? null,
      scopeId: input.scopeId ?? null,
      actorRef: input.actorRef ?? null,
      teamId: null,
      channelId: null,
      threadTs: null,
      nowMs: Date.now(),
    });
  }
  return result;
}

export async function recordGithubPrMemoryIngestion(
  env: Env,
  input: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    prUrl: string;
    bodyText?: string | null;
    mergedAtMs?: number;
    actorLogin?: string | null;
  },
): Promise<{ created: boolean; id: string }> {
  const body = input.bodyText?.trim() || `Pull request ${input.repoOwner}/${input.repoName}#${input.prNumber}`;
  return recordCompanyMemoryIngestion(env, {
    businessId: input.businessId,
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.GITHUB_PR_EVENT,
    sourceEventId: `github.pr:${input.repoOwner}/${input.repoName}#${input.prNumber}`,
    sourceUri: input.prUrl,
    sourceTimeMs: input.mergedAtMs,
    contentText: body,
    contentRef: `pr:${input.repoOwner}/${input.repoName}#${input.prNumber}`,
    scopeType: "repo",
    scopeId: `${input.repoOwner}/${input.repoName}`,
    actorRef: input.actorLogin ? `github_user:${input.actorLogin}` : null,
  });
}

export async function recordSessionCompleteMemoryIngestion(
  env: Env,
  input: {
    businessId: string;
    sessionId: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    prUrl: string;
    summaryText: string;
  },
): Promise<{ created: boolean; id: string }> {
  return recordCompanyMemoryIngestion(env, {
    businessId: input.businessId,
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SESSION_COMPLETE,
    sourceEventId: `session.complete:${input.sessionId}:${input.prUrl}`,
    sourceUri: input.prUrl,
    contentText: input.summaryText,
    contentRef: `session:${input.sessionId}`,
    scopeType: "repo",
    scopeId: `${input.repoOwner}/${input.repoName}`,
  });
}

export async function recordReviewLoopOutcomeMemoryIngestion(
  env: Env,
  input: {
    businessId: string;
    sessionId: string;
    promptId?: string | null;
    epochId: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    prUrl: string;
    headSha: string;
    outcome: "prompt_terminal" | "ci_attempt_cap_reached" | "ci_checks_pending_cap_reached";
    sourceKind: string;
    contentText: string;
    actorRef?: string | null;
    sourceTimeMs?: number;
  },
): Promise<{ created: boolean; id: string }> {
  return recordCompanyMemoryIngestion(env, {
    businessId: input.businessId,
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.GITHUB_REVIEW_LOOP_OUTCOME,
    sourceEventId: [
      "github.review_loop_outcome",
      input.repoOwner,
      input.repoName,
      String(input.prNumber),
      input.epochId,
      input.promptId ?? "no_prompt",
      input.outcome,
    ].join(":"),
    sourceUri: `${input.prUrl}#review-loop-${input.epochId}`,
    sourceTimeMs: input.sourceTimeMs,
    contentText: input.contentText,
    contentRef: `review-loop:${input.repoOwner}/${input.repoName}#${input.prNumber}:${input.epochId}`,
    scopeType: "repo",
    scopeId: `${input.repoOwner}/${input.repoName}`,
    actorRef: input.actorRef ?? null,
  });
}
