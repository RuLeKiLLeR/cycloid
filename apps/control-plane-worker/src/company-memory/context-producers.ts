import { COMPANY_MEMORY_SOURCE_TYPE, type CompanyMemorySourceType } from "../constants/company-memory";
import {
  insertMemoryMessage,
  insertMemoryWorkItem,
  type MemoryScopeType,
  upsertMemoryPeer,
  upsertMemoryScope,
  upsertMemorySession,
} from "./context-db";
import {
  memoryHumanPeerId,
  memoryIngestionMessageId,
  memoryIngestionSessionId,
  memoryScopeId,
  memoryWorkItemId,
} from "./context-ids";

export interface EnqueueMemoryContextIngestionParams {
  created: boolean;
  ingestionEventId: string;
  businessId: string;
  sourceType: CompanyMemorySourceType;
  sourceEventId: string | null;
  sourceUri: string;
  sourceTimeMs: number;
  contentText: string | null;
  scopeType: string | null;
  scopeId: string | null;
  actorRef: string | null;
  teamId: string | null;
  channelId: string | null;
  threadTs: string | null;
  nowMs: number;
}

export async function enqueueMemoryContextDeriveForIngestion(
  db: D1Database,
  params: EnqueueMemoryContextIngestionParams,
): Promise<{ enqueued: boolean; reason: "ok" | "not_created" | "empty_content" }> {
  const content = params.contentText?.trim() ?? "";
  if (!params.created) return { enqueued: false, reason: "not_created" };
  if (!content) return { enqueued: false, reason: "empty_content" };

  const scope = resolveScope(params);
  await upsertMemoryScope(db, {
    id: scope.id,
    businessId: params.businessId,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    customerSlug: scope.scopeType === "customer" ? scope.scopeKey : null,
    slackTeamId: scope.scopeType === "slack_thread" ? params.teamId : null,
    slackChannelId: scope.scopeType === "slack_thread" ? params.channelId : null,
    slackThreadTs: scope.scopeType === "slack_thread" ? params.threadTs : null,
    sessionId: scope.scopeType === "session" ? scope.scopeKey : null,
    incidentId: scope.scopeType === "incident" ? scope.scopeKey : null,
    personId: null,
    metadataJson: JSON.stringify({ sourceType: params.sourceType }),
    nowMs: params.nowMs,
  });

  const peerId = params.actorRef ? memoryHumanPeerId(params.businessId, params.actorRef) : null;
  if (peerId && params.actorRef) {
    await upsertMemoryPeer(db, {
      id: peerId,
      businessId: params.businessId,
      peerType: "human",
      peerKey: params.actorRef,
      displayName: params.actorRef,
      metadataJson: "{}",
      nowMs: params.nowMs,
    });
  }

  const memorySessionId = memoryIngestionSessionId(
    params.businessId,
    params.sourceType,
    params.sourceEventId ?? params.ingestionEventId,
  );
  await upsertMemorySession(db, {
    id: memorySessionId,
    businessId: params.businessId,
    scopeId: scope.id,
    sourceKind: sourceKindForIngestion(params.sourceType),
    sourceId: params.sourceEventId ?? params.ingestionEventId,
    sourceUri: params.sourceUri,
    title: titleForIngestion(params),
    startedAtMs: params.sourceTimeMs,
    endedAtMs: null,
    metadataJson: JSON.stringify({
      ingestionEventId: params.ingestionEventId,
      teamId: params.teamId,
      channelId: params.channelId,
      threadTs: params.threadTs,
    }),
    nowMs: params.nowMs,
  });

  const messageId = memoryIngestionMessageId(params.businessId, params.ingestionEventId);
  await insertMemoryMessage(db, {
    id: messageId,
    businessId: params.businessId,
    sessionId: memorySessionId,
    seqInSession: 1,
    peerId,
    role: "external",
    contentText: content,
    contentJson: null,
    sourceUri: params.sourceUri,
    occurredAtMs: params.sourceTimeMs,
    nowMs: params.nowMs,
  });
  await insertMemoryWorkItem(db, {
    id: memoryWorkItemId(params.businessId, "derive", messageId),
    businessId: params.businessId,
    workType: "derive",
    targetKind: "memory_message",
    targetId: messageId,
    status: "pending",
    priority: 5,
    availableAtMs: params.nowMs,
    payloadJson: JSON.stringify({ ingestionEventId: params.ingestionEventId, sourceType: params.sourceType }),
    nowMs: params.nowMs,
  });
  return { enqueued: true, reason: "ok" };
}

function resolveScope(params: EnqueueMemoryContextIngestionParams): {
  id: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  repoOwner: string | null;
  repoName: string | null;
} {
  if (params.scopeType === "repo" && params.scopeId?.includes("/")) {
    const [repoOwner, repoName] = params.scopeId.split("/", 2);
    return {
      id: memoryScopeId(params.businessId, "repo", params.scopeId),
      scopeType: "repo",
      scopeKey: params.scopeId,
      repoOwner,
      repoName,
    };
  }
  if (params.scopeType === "customer" && params.scopeId) {
    return {
      id: memoryScopeId(params.businessId, "customer", params.scopeId),
      scopeType: "customer",
      scopeKey: params.scopeId,
      repoOwner: null,
      repoName: null,
    };
  }
  if (params.scopeType === "incident" && params.scopeId) {
    return {
      id: memoryScopeId(params.businessId, "incident", params.scopeId),
      scopeType: "incident",
      scopeKey: params.scopeId,
      repoOwner: null,
      repoName: null,
    };
  }
  if (params.teamId && params.channelId && params.threadTs) {
    const scopeKey = `${params.teamId}:${params.channelId}:${params.threadTs}`;
    return {
      id: memoryScopeId(params.businessId, "slack_thread", scopeKey),
      scopeType: "slack_thread",
      scopeKey,
      repoOwner: null,
      repoName: null,
    };
  }
  return {
    id: memoryScopeId(params.businessId, "business", params.businessId),
    scopeType: "business",
    scopeKey: params.businessId,
    repoOwner: null,
    repoName: null,
  };
}

function sourceKindForIngestion(
  sourceType: CompanyMemorySourceType,
): "arcanist_session" | "slack_thread" | "github_pr" | "system" {
  if (
    sourceType === COMPANY_MEMORY_SOURCE_TYPE.SLACK_APP_MENTION ||
    sourceType === COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE ||
    sourceType === COMPANY_MEMORY_SOURCE_TYPE.SLACK_THREAD_PASTE
  ) {
    return "slack_thread";
  }
  if (
    sourceType === COMPANY_MEMORY_SOURCE_TYPE.GITHUB_PR_EVENT ||
    sourceType === COMPANY_MEMORY_SOURCE_TYPE.GITHUB_REVIEW_LOOP_OUTCOME
  ) {
    return "github_pr";
  }
  if (sourceType === COMPANY_MEMORY_SOURCE_TYPE.SESSION_COMPLETE) return "arcanist_session";
  return "system";
}

function titleForIngestion(params: EnqueueMemoryContextIngestionParams): string {
  if (params.sourceType === COMPANY_MEMORY_SOURCE_TYPE.SESSION_COMPLETE) return "Session completion memory";
  if (params.sourceType === COMPANY_MEMORY_SOURCE_TYPE.GITHUB_PR_EVENT) return "GitHub PR memory";
  if (params.sourceType === COMPANY_MEMORY_SOURCE_TYPE.GITHUB_REVIEW_LOOP_OUTCOME) return "GitHub review-loop memory";
  return "Slack memory";
}
