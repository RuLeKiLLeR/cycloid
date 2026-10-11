import { computeSha256Hex } from "../crypto";
import type { MemorySemanticSourceKind, MemoryWorkType } from "./context-db";

// Single source of truth for deterministic memory-context graph ids.
//
// Every id is a FULL COMPOSITE string built from bounded identifier components
// (business id, source kind, source/entity id, ...). We deliberately avoid the
// old truncated 32-bit FNV hashing: at ~77k rows a 32-bit space starts colliding,
// and INSERT OR IGNORE would then silently drop rows or cross-link tenants.
// Composite strings never collide across entities or tenants because the tenant
// (business id) and entity discriminator are always part of the string.
//
// Vector ids are the one exception: Cloudflare Vectorize caps id length, so the
// composite is folded through SHA-256 (collision-safe at any realistic scale)
// and truncated, which is why `memoryVectorId` is async.

export function memoryAgentPeerId(businessId: string): string {
  return `peer:agent:${businessId}:cycloid`;
}

export function memorySessionPeerId(businessId: string, sessionId: string): string {
  return `peer:session:${businessId}:${sessionId}`;
}

export function memoryHumanPeerId(businessId: string, actorRef: string): string {
  return `peer:human:${businessId}:${actorRef}`;
}

export function memoryScopeId(businessId: string, scopeType: string, scopeKey: string): string {
  return `scope:${scopeType}:${businessId}:${scopeKey}`;
}

export function memorySessionCollectionId(businessId: string, sessionId: string): string {
  return `collection:session:${businessId}:${sessionId}`;
}

export function memoryIngestionSessionId(businessId: string, sourceType: string, sourceKey: string): string {
  return `memory-session:${businessId}:${sourceType}:${sourceKey}`;
}

export function memoryIngestionMessageId(businessId: string, ingestionEventId: string): string {
  return `memory-message:${businessId}:${ingestionEventId}`;
}

export function memoryConclusionId(businessId: string, sourceKind: string, sourceId: string): string {
  return `conclusion:${businessId}:${sourceKind}:${sourceId}`;
}

export function memoryContradictionConclusionId(businessId: string, leftId: string, rightId: string): string {
  return memoryConclusionId(businessId, "contradiction", [leftId, rightId].sort().join("::"));
}

export function memoryConclusionSourceEdgeId(
  businessId: string,
  conclusionId: string,
  sourceKind: string,
  sourceId: string,
): string {
  return `source:${businessId}:${conclusionId}:${sourceKind}:${sourceId}`;
}

export function memorySemanticDocumentId(
  businessId: string,
  sourceKind: MemorySemanticSourceKind,
  sourceId: string,
): string {
  return `semantic:${businessId}:${sourceKind}:${sourceId}`;
}

export function memoryScopeCardId(
  businessId: string,
  scopeId: string,
  observerPeerId: string,
  observedPeerId: string,
): string {
  return `scope-card:${businessId}:${scopeId}:${observerPeerId}:${observedPeerId}`;
}

export function memoryWorkItemId(businessId: string, workType: MemoryWorkType, key: string): string {
  return `work:${businessId}:${workType}:${key}`;
}

export async function memoryVectorId(
  businessId: string,
  sourceKind: MemorySemanticSourceKind,
  sourceId: string,
): Promise<string> {
  const digest = await computeSha256Hex(`${businessId}:${sourceKind}:${sourceId}`);
  return `memvec:${digest.slice(0, 40)}`;
}
