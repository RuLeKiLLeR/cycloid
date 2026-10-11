import { computeSha256Hex } from "../crypto";
import {
  getMemoryMessageForDerivation,
  insertMemoryWorkItem,
  insertOrReinforceMemoryConclusion,
  MEMORY_EMBEDDING_DIM,
  MEMORY_EMBEDDING_MODEL,
  upsertMemoryCollection,
  upsertMemoryPeer,
  upsertMemorySemanticDocument,
} from "./context-db";
import {
  memoryAgentPeerId,
  memoryConclusionId,
  memoryConclusionSourceEdgeId,
  memorySemanticDocumentId,
  memorySessionCollectionId,
  memorySessionPeerId,
  memoryVectorId,
  memoryWorkItemId,
} from "./context-ids";

const MEMORY_CONTEXT_CONSOLIDATION_IDLE_MS = 5 * 60_000;

export interface DeriveExplicitConclusionResult {
  status: "derived" | "skipped";
  reason: "ok" | "message_not_found" | "empty_message";
  conclusionId: string | null;
}

export async function deriveExplicitConclusionFromMemoryMessage(
  db: D1Database,
  params: { businessId: string; messageId: string; nowMs: number },
): Promise<DeriveExplicitConclusionResult> {
  const message = await getMemoryMessageForDerivation(db, {
    businessId: params.businessId,
    messageId: params.messageId,
  });
  if (!message) return { status: "skipped", reason: "message_not_found", conclusionId: null };
  const content = message.contentText.trim();
  if (!content) return { status: "skipped", reason: "empty_message", conclusionId: null };

  const observerPeerId = memoryAgentPeerId(params.businessId);
  const observedPeerId = memorySessionPeerId(params.businessId, message.sessionId);
  const collectionId = memorySessionCollectionId(params.businessId, message.sessionId);
  const conclusionId = memoryConclusionId(params.businessId, "memory_message", message.id);

  await upsertMemoryPeer(db, {
    id: observerPeerId,
    businessId: params.businessId,
    peerType: "agent",
    peerKey: "cycloid",
    displayName: "Cycloid",
    metadataJson: "{}",
    nowMs: params.nowMs,
  });
  await upsertMemoryPeer(db, {
    id: observedPeerId,
    businessId: params.businessId,
    peerType: "session",
    peerKey: message.sessionId,
    displayName: message.sessionId,
    metadataJson: "{}",
    nowMs: params.nowMs,
  });
  await upsertMemoryCollection(db, {
    id: collectionId,
    businessId: params.businessId,
    scopeId: message.scopeId,
    observerPeerId,
    observedPeerId,
    collectionKind: "session",
    metadataJson: JSON.stringify({ sourceSessionId: message.sessionId }),
    nowMs: params.nowMs,
  });
  await insertOrReinforceMemoryConclusion(db, {
    id: conclusionId,
    businessId: params.businessId,
    collectionId,
    scopeId: message.scopeId,
    kind: "observation",
    content,
    level: "explicit",
    status: "active",
    confidence: confidenceForRole(message.role),
    authority: "inferred",
    enforcement: "none",
    sourceKind: "memory_message",
    sourceId: message.id,
    repoOwner: null,
    repoName: null,
    validUntilMs: null,
    metadataJson: JSON.stringify({ role: message.role, occurredAtMs: message.occurredAtMs }),
    nowMs: params.nowMs,
    source: {
      id: memoryConclusionSourceEdgeId(params.businessId, conclusionId, "memory_message", message.id),
      businessId: params.businessId,
      conclusionId,
      sourceKind: "memory_message",
      sourceId: message.id,
      sourceUri: message.sourceUri,
      excerpt: content.slice(0, 500),
      relationship: "supports",
      nowMs: params.nowMs,
    },
  });
  const semanticDocId = memorySemanticDocumentId(params.businessId, "memory_conclusion", conclusionId);
  await upsertMemorySemanticDocument(db, {
    id: semanticDocId,
    sourceKind: "memory_conclusion",
    sourceId: conclusionId,
    businessId: params.businessId,
    repoOwner: null,
    repoName: null,
    scopeType: "session",
    scopeId: message.scopeId,
    text: content,
    contentHash: await computeSha256Hex(content),
    embeddingModel: MEMORY_EMBEDDING_MODEL,
    embeddingDim: MEMORY_EMBEDDING_DIM,
    vectorNamespace: params.businessId,
    vectorId: await memoryVectorId(params.businessId, "memory_conclusion", conclusionId),
    vectorState: "pending",
    lastError: null,
    nowMs: params.nowMs,
  });
  await insertMemoryWorkItem(db, {
    id: memoryWorkItemId(params.businessId, "vector_sync", conclusionId),
    businessId: params.businessId,
    workType: "vector_sync",
    targetKind: "semantic_document",
    targetId: semanticDocId,
    status: "pending",
    priority: 0,
    availableAtMs: params.nowMs,
    payloadJson: "{}",
    nowMs: params.nowMs,
  });
  await insertMemoryWorkItem(db, {
    id: memoryWorkItemId(params.businessId, "consolidate", `${message.scopeId}:${observerPeerId}:${observedPeerId}`),
    businessId: params.businessId,
    workType: "consolidate",
    targetKind: "memory_scope",
    targetId: message.scopeId,
    status: "pending",
    priority: -1,
    availableAtMs: params.nowMs + MEMORY_CONTEXT_CONSOLIDATION_IDLE_MS,
    payloadJson: JSON.stringify({
      observerPeerId,
      observedPeerId,
      idleMs: MEMORY_CONTEXT_CONSOLIDATION_IDLE_MS,
      limit: 50,
    }),
    nowMs: params.nowMs,
  });

  return { status: "derived", reason: "ok", conclusionId };
}

function confidenceForRole(role: string): "low" | "medium" | "high" {
  if (role === "user" || role === "external") return "medium";
  if (role === "system") return "low";
  return "medium";
}
