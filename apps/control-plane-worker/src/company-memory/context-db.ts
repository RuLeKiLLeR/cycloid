import { MEMORY_MAX_VECTOR_SYNC_ATTEMPTS } from "../constants/memory-context";
import { d1Changed } from "../db/errors";

export const MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
export const MEMORY_EMBEDDING_DIM = 1536;

export type MemoryScopeType = "business" | "repo" | "customer" | "slack_thread" | "session" | "incident" | "person";
export type MemoryPeerType = "human" | "agent" | "repo" | "customer" | "channel" | "system" | "session" | "incident";
export type MemoryCollectionKind = "working" | "long_term" | "repo" | "company" | "session";
export type MemoryConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";
export type MemoryConclusionStatus = "active" | "proposed" | "superseded" | "rejected" | "expired" | "deleted";
export type MemoryConfidence = "low" | "medium" | "high";
export type MemoryAuthority = "inferred" | "reviewed" | "source_of_truth";
export type MemoryEnforcement = "none" | "suggest" | "warn" | "block";
export type MemorySourceKind =
  | "memory_message"
  | "memory_conclusion"
  | "repo_memory"
  | "company_fact"
  | "company_take"
  | "ingestion_event"
  | "manual";
export type MemorySourceRelationship = "supports" | "contradicts" | "supersedes" | "derived_from" | "cites";
export type MemorySemanticSourceKind =
  "memory_conclusion" | "memory_message" | "memory_scope_card" | "repo_memory" | "company_fact" | "company_take";
export type MemoryVectorState = "pending" | "synced" | "failed" | "deleted";
// NOTE: migration 0235's work_type CHECK still lists 'backfill' (append-only, left as-is);
// nothing enqueues it so it is intentionally absent from this union.
export type MemoryWorkType = "derive" | "consolidate" | "vector_sync";
export type MemoryWorkTargetKind =
  "memory_message" | "memory_scope" | "repo_memory" | "company_fact" | "company_take" | "semantic_document";
export type MemoryWorkStatus = "pending" | "processing" | "completed" | "failed" | "canceled";
export type MemoryFusionMode = "none" | "deterministic" | "rrf";
export type MemorySelectorStatus = "not_run" | "selected" | "empty" | "failed" | "timeout";

export interface UpsertMemoryScopeParams {
  id: string;
  businessId: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  repoOwner: string | null;
  repoName: string | null;
  customerSlug: string | null;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  sessionId: string | null;
  incidentId: string | null;
  personId: string | null;
  metadataJson: string;
  nowMs: number;
}

export interface UpsertMemoryPeerParams {
  id: string;
  businessId: string;
  peerType: MemoryPeerType;
  peerKey: string;
  displayName: string | null;
  metadataJson: string;
  nowMs: number;
}

export interface UpsertMemorySessionParams {
  id: string;
  businessId: string;
  scopeId: string;
  sourceKind:
    | "arcanist_session"
    | "slack_thread"
    | "github_pr"
    | "github_issue"
    | "linear_issue"
    | "jira_issue"
    | "manual"
    | "system";
  sourceId: string;
  sourceUri: string | null;
  title: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  metadataJson: string;
  nowMs: number;
}

export interface InsertMemoryMessageParams {
  id: string;
  businessId: string;
  sessionId: string;
  seqInSession: number;
  peerId: string | null;
  role: "user" | "assistant" | "agent" | "tool" | "system" | "external";
  contentText: string;
  contentJson: string | null;
  sourceUri: string | null;
  occurredAtMs: number;
  nowMs: number;
}

export interface UpsertMemoryCollectionParams {
  id: string;
  businessId: string;
  scopeId: string;
  observerPeerId: string;
  observedPeerId: string;
  collectionKind: MemoryCollectionKind;
  metadataJson: string;
  nowMs: number;
}

export interface InsertMemoryConclusionParams {
  id: string;
  businessId: string;
  collectionId: string;
  scopeId: string;
  kind: string;
  content: string;
  level: MemoryConclusionLevel;
  status: MemoryConclusionStatus;
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  enforcement: MemoryEnforcement;
  sourceKind: string | null;
  sourceId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  validUntilMs: number | null;
  metadataJson: string;
  nowMs: number;
}

export interface InsertMemoryConclusionSourceParams {
  id: string;
  businessId: string;
  conclusionId: string;
  sourceKind: MemorySourceKind;
  sourceId: string;
  sourceUri: string | null;
  excerpt: string | null;
  relationship: MemorySourceRelationship;
  nowMs: number;
}

export interface InsertMemoryWorkItemParams {
  id: string;
  businessId: string;
  workType: MemoryWorkType;
  targetKind: MemoryWorkTargetKind;
  targetId: string;
  status: MemoryWorkStatus;
  priority: number;
  availableAtMs: number;
  payloadJson: string;
  nowMs: number;
}

export interface MemoryWorkItemRow {
  id: string;
  businessId: string;
  workType: MemoryWorkType;
  targetKind: MemoryWorkTargetKind;
  targetId: string;
  status: MemoryWorkStatus;
  priority: number;
  attempts: number;
  availableAtMs: number;
  payloadJson: string;
}

export interface InsertMemoryContextQueryParams {
  id: string;
  businessId: string;
  sessionId: string | null;
  promptId: string | null;
  scopeId: string | null;
  intent: string;
  requestJson: string;
  laneCountsJson: string;
  vectorAvailable: boolean;
  vectorUnavailableReason: string | null;
  fusionMode: MemoryFusionMode;
  candidateIdsJson: string;
  selectedIdsJson: string;
  rejectedJson: string;
  selectorStatus: MemorySelectorStatus;
  selectorModel: string | null;
  selectorLatencyMs: number | null;
  traceJson: string;
  nowMs: number;
}

export interface UpsertMemorySemanticDocumentParams {
  id: string;
  sourceKind: MemorySemanticSourceKind;
  sourceId: string;
  businessId: string;
  repoOwner: string | null;
  repoName: string | null;
  scopeType: string;
  scopeId: string;
  text: string;
  contentHash: string;
  embeddingModel: typeof MEMORY_EMBEDDING_MODEL;
  embeddingDim: typeof MEMORY_EMBEDDING_DIM;
  vectorNamespace: string;
  vectorId: string;
  vectorState: MemoryVectorState;
  lastError: string | null;
  nowMs: number;
}

export interface UpsertMemoryScopeCardParams {
  id: string;
  businessId: string;
  scopeId: string;
  observerPeerId: string;
  observedPeerId: string;
  cardJson: string;
  sourceConclusionIdsJson: string;
  status: "active" | "stale" | "deleted";
  nowMs: number;
}

export interface InsertOrReinforceMemoryConclusionParams extends InsertMemoryConclusionParams {
  source: InsertMemoryConclusionSourceParams;
}

export interface MemoryConclusionRow {
  id: string;
  businessId: string;
  collectionId: string;
  scopeId: string;
  kind: string;
  content: string;
  level: MemoryConclusionLevel;
  status: MemoryConclusionStatus;
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  enforcement: MemoryEnforcement;
  sourceKind: string | null;
  sourceId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  reinforcementCount: number;
  timesDerived: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MemoryConclusionSourceChainRow {
  conclusionId: string;
  kind: string;
  content: string;
  level: MemoryConclusionLevel;
  confidence: MemoryConfidence;
  sourceKind: MemorySourceKind;
  sourceId: string;
  sourceUri: string | null;
  excerpt: string | null;
  relationship: MemorySourceRelationship;
  sourceCreatedAtMs: number;
}

export interface MemoryScopeCardRow {
  id: string;
  businessId: string;
  scopeId: string;
  observerPeerId: string;
  observedPeerId: string;
  cardJson: string;
  sourceConclusionIdsJson: string;
  status: "active" | "stale" | "deleted";
  updatedAtMs: number;
}

export interface RepoMemoryFtsRow {
  id: string;
  memoryId: string;
  repoOwner: string;
  repoName: string;
  memoryType: string;
  actionType: string | null;
  level: string;
  primitive: string;
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  enforcement: MemoryEnforcement;
  contextHint: string;
  content: string;
  sourcePrNumber: number | null;
  sourceSessionIdsJson: string;
  memoryJson: string;
  rank: number;
}

export interface MemoryConclusionFtsRow extends MemoryConclusionRow {
  rank: number;
  sourceUri: string | null;
  sourceExcerpt: string | null;
}

export interface MemoryMessageFtsRow {
  id: string;
  businessId: string;
  sessionId: string;
  scopeId: string;
  role: string;
  contentText: string;
  sourceUri: string | null;
  occurredAtMs: number;
  rank: number;
}

export interface RecentMemoryMessageRow {
  id: string;
  businessId: string;
  sessionId: string;
  scopeId: string;
  role: string;
  contentText: string;
  sourceUri: string | null;
  occurredAtMs: number;
}

export interface MemoryMessageForDerivationRow {
  id: string;
  businessId: string;
  sessionId: string;
  scopeId: string;
  role: string;
  contentText: string;
  sourceUri: string | null;
  occurredAtMs: number;
}

export interface MemorySemanticDocumentRow {
  id: string;
  sourceKind: MemorySemanticSourceKind;
  sourceId: string;
  businessId: string;
  repoOwner: string | null;
  repoName: string | null;
  scopeType: string;
  scopeId: string;
  text: string;
  vectorNamespace: string;
  vectorId: string;
  vectorState: MemoryVectorState;
  updatedAtMs: number;
  conclusionLevel: MemoryConclusionLevel | null;
}

export interface PendingMemorySemanticDocumentRow extends MemorySemanticDocumentRow {
  syncAttempts: number;
}

export async function upsertMemoryScope(db: D1Database, params: UpsertMemoryScopeParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_scopes
       (id, business_id, scope_type, scope_key, repo_owner, repo_name, customer_slug,
        slack_team_id, slack_channel_id, slack_thread_ts, session_id, incident_id, person_id,
        metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, scope_type, scope_key) DO UPDATE SET
         repo_owner = excluded.repo_owner,
         repo_name = excluded.repo_name,
         customer_slug = excluded.customer_slug,
         slack_team_id = excluded.slack_team_id,
         slack_channel_id = excluded.slack_channel_id,
         slack_thread_ts = excluded.slack_thread_ts,
         session_id = excluded.session_id,
         incident_id = excluded.incident_id,
         person_id = excluded.person_id,
         metadata_json = excluded.metadata_json,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = NULL`,
    )
    .bind(
      params.id,
      params.businessId,
      params.scopeType,
      params.scopeKey,
      params.repoOwner,
      params.repoName,
      params.customerSlug,
      params.slackTeamId,
      params.slackChannelId,
      params.slackThreadTs,
      params.sessionId,
      params.incidentId,
      params.personId,
      params.metadataJson,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

export async function upsertMemoryPeer(db: D1Database, params: UpsertMemoryPeerParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_peers
       (id, business_id, peer_type, peer_key, display_name, metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, peer_type, peer_key) DO UPDATE SET
         display_name = excluded.display_name,
         metadata_json = excluded.metadata_json,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = NULL`,
    )
    .bind(
      params.id,
      params.businessId,
      params.peerType,
      params.peerKey,
      params.displayName,
      params.metadataJson,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

export async function upsertMemorySession(db: D1Database, params: UpsertMemorySessionParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_sessions
       (id, business_id, scope_id, source_kind, source_id, source_uri, title,
        started_at_ms, ended_at_ms, metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, source_kind, source_id) DO UPDATE SET
         scope_id = excluded.scope_id,
         source_uri = excluded.source_uri,
         title = excluded.title,
         started_at_ms = COALESCE(excluded.started_at_ms, memory_sessions.started_at_ms),
         ended_at_ms = COALESCE(excluded.ended_at_ms, memory_sessions.ended_at_ms),
         metadata_json = excluded.metadata_json,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = NULL`,
    )
    .bind(
      params.id,
      params.businessId,
      params.scopeId,
      params.sourceKind,
      params.sourceId,
      params.sourceUri,
      params.title,
      params.startedAtMs,
      params.endedAtMs,
      params.metadataJson,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

export async function insertMemoryMessage(db: D1Database, params: InsertMemoryMessageParams): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO memory_messages
       (id, business_id, session_id, seq_in_session, peer_id, role, content_text,
        content_json, source_uri, occurred_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.businessId,
      params.sessionId,
      params.seqInSession,
      params.peerId,
      params.role,
      params.contentText,
      params.contentJson,
      params.sourceUri,
      params.occurredAtMs,
      params.nowMs,
    )
    .run();
}

export async function upsertMemoryCollection(db: D1Database, params: UpsertMemoryCollectionParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_collections
       (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind,
        metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, observer_peer_id, observed_peer_id, collection_kind) DO UPDATE SET
         metadata_json = excluded.metadata_json,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = NULL`,
    )
    .bind(
      params.id,
      params.businessId,
      params.scopeId,
      params.observerPeerId,
      params.observedPeerId,
      params.collectionKind,
      params.metadataJson,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

// Returns the number of rows actually inserted (0 when the conclusion already existed).
export async function insertMemoryConclusion(db: D1Database, params: InsertMemoryConclusionParams): Promise<number> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO memory_conclusions
       (id, business_id, collection_id, scope_id, kind, content, level, status, confidence,
        authority, enforcement, source_kind, source_id, repo_owner, repo_name, valid_until_ms,
        created_at_ms, updated_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.businessId,
      params.collectionId,
      params.scopeId,
      params.kind,
      params.content,
      params.level,
      params.status,
      params.confidence,
      params.authority,
      params.enforcement,
      params.sourceKind,
      params.sourceId,
      params.repoOwner,
      params.repoName,
      params.validUntilMs,
      params.nowMs,
      params.nowMs,
      params.metadataJson,
    )
    .run();
  return result.meta.changes ?? 0;
}

// Returns the number of rows actually inserted (0 when this exact source edge already existed).
export async function insertMemoryConclusionSource(
  db: D1Database,
  params: InsertMemoryConclusionSourceParams,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO memory_conclusion_sources
       (id, business_id, conclusion_id, source_kind, source_id, source_uri, excerpt, relationship, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.businessId,
      params.conclusionId,
      params.sourceKind,
      params.sourceId,
      params.sourceUri,
      params.excerpt,
      params.relationship,
      params.nowMs,
    )
    .run();
  return result.meta.changes ?? 0;
}

export async function insertOrReinforceMemoryConclusion(
  db: D1Database,
  params: InsertOrReinforceMemoryConclusionParams,
): Promise<void> {
  const conclusionInserted = await insertMemoryConclusion(db, params);
  const sourceInserted = await insertMemoryConclusionSource(db, params.source);
  // A new source edge against a pre-existing conclusion is a fresh reinforcement.
  if (conclusionInserted === 0 && sourceInserted > 0) {
    await db
      .prepare(
        `UPDATE memory_conclusions
         SET reinforcement_count = reinforcement_count + 1,
             updated_at_ms = ?
         WHERE id = ?
           AND business_id = ?`,
      )
      .bind(params.nowMs, params.id, params.businessId)
      .run();
  }
}

export async function recordMemoryConclusionFeedback(
  db: D1Database,
  params: { businessId: string; conclusionId: string; rating: "up" | "down"; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE memory_conclusions
       SET positive_feedback_count = positive_feedback_count + CASE WHEN ? = 'up' THEN 1 ELSE 0 END,
           negative_feedback_count = negative_feedback_count + CASE WHEN ? = 'down' THEN 1 ELSE 0 END,
           updated_at_ms = ?
       WHERE business_id = ?
         AND id = ?
         AND status = 'active'
         AND deleted_at_ms IS NULL`,
    )
    .bind(params.rating, params.rating, params.nowMs, params.businessId, params.conclusionId)
    .run();
  return d1Changed(result);
}

export async function insertMemoryWorkItem(db: D1Database, params: InsertMemoryWorkItemParams): Promise<void> {
  // Work ids are deterministic (one per logical entity), so a plain INSERT OR IGNORE
  // would make every re-enqueue a permanent no-op once the row reached a terminal
  // state. Reset terminal (completed/failed) rows back to pending with fresh
  // availability + attempts so the entity can be reprocessed, while genuinely
  // in-flight rows (pending/processing) and intentionally canceled rows are left
  // untouched to preserve dedupe.
  await db
    .prepare(
      `INSERT INTO memory_work_items
       (id, business_id, work_type, target_kind, target_id, status, priority, available_at_ms,
        payload_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'pending',
         attempts = 0,
         locked_until_ms = NULL,
         last_error = NULL,
         priority = excluded.priority,
         available_at_ms = excluded.available_at_ms,
         payload_json = excluded.payload_json,
         updated_at_ms = excluded.updated_at_ms
       WHERE memory_work_items.status IN ('completed', 'failed')`,
    )
    .bind(
      params.id,
      params.businessId,
      params.workType,
      params.targetKind,
      params.targetId,
      params.status,
      params.priority,
      params.availableAtMs,
      params.payloadJson,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

export async function claimNextMemoryWorkItem(
  db: D1Database,
  params: { nowMs: number; lockMs: number; maxAttempts: number },
): Promise<MemoryWorkItemRow | null> {
  const row = await db
    .prepare(
      `SELECT
         id,
         business_id AS businessId,
         work_type AS workType,
         target_kind AS targetKind,
         target_id AS targetId,
         status,
         priority,
         attempts,
         available_at_ms AS availableAtMs,
         payload_json AS payloadJson
       FROM memory_work_items
       WHERE (status = 'pending' OR (status = 'processing' AND locked_until_ms <= ?))
         AND available_at_ms <= ?
         AND attempts < ?
       ORDER BY priority DESC, available_at_ms ASC, attempts ASC, created_at_ms ASC
       LIMIT 1`,
    )
    .bind(params.nowMs, params.nowMs, params.maxAttempts)
    .all<MemoryWorkItemRow>();
  const item = row.results[0] ?? null;
  if (!item) return null;
  const update = await db
    .prepare(
      `UPDATE memory_work_items
       SET status = 'processing',
           attempts = attempts + 1,
           locked_until_ms = ?,
           updated_at_ms = ?
       WHERE id = ?
         AND (status = 'pending' OR (status = 'processing' AND locked_until_ms <= ?))
         AND attempts = ?
         AND available_at_ms <= ?`,
    )
    .bind(params.nowMs + params.lockMs, params.nowMs, item.id, params.nowMs, item.attempts, params.nowMs)
    .run();
  if (update.meta.changes === 0) return null;
  return { ...item, status: "processing", attempts: item.attempts + 1 };
}

export async function completeMemoryWorkItem(db: D1Database, params: { id: string; nowMs: number }): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_work_items
       SET status = 'completed',
           locked_until_ms = NULL,
           completed_at_ms = ?,
           updated_at_ms = ?,
           last_error = NULL
       WHERE id = ?`,
    )
    .bind(params.nowMs, params.nowMs, params.id)
    .run();
}

export async function failMemoryWorkItem(
  db: D1Database,
  params: { id: string; error: string; retry: boolean; availableAtMs: number; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_work_items
       SET status = ?,
           locked_until_ms = NULL,
           available_at_ms = ?,
           last_error = ?,
           updated_at_ms = ?
       WHERE id = ?`,
    )
    .bind(
      params.retry ? "pending" : "failed",
      params.availableAtMs,
      params.error.slice(0, 500),
      params.nowMs,
      params.id,
    )
    .run();
}

export async function deferMemoryWorkItem(
  db: D1Database,
  params: { id: string; reason: string; availableAtMs: number; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_work_items
       SET status = 'pending',
           attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           locked_until_ms = NULL,
           available_at_ms = ?,
           last_error = ?,
           updated_at_ms = ?
       WHERE id = ?`,
    )
    .bind(params.availableAtMs, params.reason.slice(0, 500), params.nowMs, params.id)
    .run();
}

export async function insertMemoryContextQuery(db: D1Database, params: InsertMemoryContextQueryParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_context_queries
       (id, business_id, session_id, prompt_id, scope_id, intent, request_json, lane_counts_json,
        vector_available, vector_unavailable_reason, fusion_mode, candidate_ids_json, selected_ids_json,
        rejected_json, selector_status, selector_model, selector_latency_ms, trace_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.businessId,
      params.sessionId,
      params.promptId,
      params.scopeId,
      params.intent,
      params.requestJson,
      params.laneCountsJson,
      params.vectorAvailable ? 1 : 0,
      params.vectorUnavailableReason,
      params.fusionMode,
      params.candidateIdsJson,
      params.selectedIdsJson,
      params.rejectedJson,
      params.selectorStatus,
      params.selectorModel,
      params.selectorLatencyMs,
      params.traceJson,
      params.nowMs,
    )
    .run();
}

export async function getMemoryMessageForDerivation(
  db: D1Database,
  params: { businessId: string; messageId: string },
): Promise<MemoryMessageForDerivationRow | null> {
  const result = await db
    .prepare(
      `SELECT
         mm.id,
         mm.business_id AS businessId,
         mm.session_id AS sessionId,
         ms.scope_id AS scopeId,
         mm.role,
         mm.content_text AS contentText,
         mm.source_uri AS sourceUri,
         mm.occurred_at_ms AS occurredAtMs
       FROM memory_messages mm
       JOIN memory_sessions ms ON ms.id = mm.session_id
       WHERE mm.business_id = ?
         AND mm.id = ?
         AND mm.deleted_at_ms IS NULL
         AND ms.deleted_at_ms IS NULL
       LIMIT 1`,
    )
    .bind(params.businessId, params.messageId)
    .all<MemoryMessageForDerivationRow>();
  return result.results[0] ?? null;
}

export async function upsertMemorySemanticDocument(
  db: D1Database,
  params: UpsertMemorySemanticDocumentParams,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_semantic_documents
       (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
        text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
        vector_state, last_error, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_id, embedding_model) DO UPDATE SET
         business_id = excluded.business_id,
         repo_owner = excluded.repo_owner,
         repo_name = excluded.repo_name,
         scope_type = excluded.scope_type,
         scope_id = excluded.scope_id,
         text = excluded.text,
         content_hash = excluded.content_hash,
         embedding_dim = excluded.embedding_dim,
         vector_namespace = excluded.vector_namespace,
         vector_id = excluded.vector_id,
         -- Only re-embed when the content actually changed. An unchanged upsert keeps
         -- the existing vector_state (so a synced doc stays synced instead of being
         -- re-embedded every run); a changed one goes back to pending AND resets
         -- sync_attempts so a doc that previously exhausted its retries becomes
         -- syncable again once its content changes.
         vector_state = CASE
           WHEN excluded.content_hash = memory_semantic_documents.content_hash
             THEN memory_semantic_documents.vector_state
           ELSE 'pending'
         END,
         sync_attempts = CASE
           WHEN excluded.content_hash = memory_semantic_documents.content_hash
             THEN memory_semantic_documents.sync_attempts
           ELSE 0
         END,
         last_error = CASE
           WHEN excluded.content_hash = memory_semantic_documents.content_hash
             THEN memory_semantic_documents.last_error
           ELSE excluded.last_error
         END,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = NULL`,
    )
    .bind(
      params.id,
      params.sourceKind,
      params.sourceId,
      params.businessId,
      params.repoOwner,
      params.repoName,
      params.scopeType,
      params.scopeId,
      params.text,
      params.contentHash,
      params.embeddingModel,
      params.embeddingDim,
      params.vectorNamespace,
      params.vectorId,
      params.vectorState,
      params.lastError,
      params.nowMs,
    )
    .run();
}

export async function upsertMemoryScopeCard(db: D1Database, params: UpsertMemoryScopeCardParams): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_scope_cards
       (id, business_id, scope_id, observer_peer_id, observed_peer_id, card_json,
        source_conclusion_ids_json, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, observer_peer_id, observed_peer_id) DO UPDATE SET
         card_json = excluded.card_json,
         source_conclusion_ids_json = excluded.source_conclusion_ids_json,
         status = excluded.status,
         updated_at_ms = excluded.updated_at_ms,
         deleted_at_ms = CASE WHEN excluded.status = 'deleted' THEN excluded.updated_at_ms ELSE NULL END`,
    )
    .bind(
      params.id,
      params.businessId,
      params.scopeId,
      params.observerPeerId,
      params.observedPeerId,
      params.cardJson,
      params.sourceConclusionIdsJson,
      params.status,
      params.nowMs,
      params.nowMs,
    )
    .run();
}

export async function listActiveMemoryScopeCardsForScope(
  db: D1Database,
  params: { businessId: string; scopeId: string; limit: number },
): Promise<MemoryScopeCardRow[]> {
  const result = await db
    .prepare(
      `SELECT
         id,
         business_id AS businessId,
         scope_id AS scopeId,
         observer_peer_id AS observerPeerId,
         observed_peer_id AS observedPeerId,
         card_json AS cardJson,
         source_conclusion_ids_json AS sourceConclusionIdsJson,
         status,
         updated_at_ms AS updatedAtMs
       FROM memory_scope_cards
       WHERE business_id = ?
         AND scope_id = ?
         AND status = 'active'
         AND deleted_at_ms IS NULL
       ORDER BY updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(params.businessId, params.scopeId, boundedLimit(params.limit, 25))
    .all<MemoryScopeCardRow>();
  return result.results;
}

export async function listActiveMemoryConclusionsForScope(
  db: D1Database,
  params: { businessId: string; scopeId: string; limit: number },
): Promise<MemoryConclusionRow[]> {
  const result = await db
    .prepare(
      `SELECT
         id,
         business_id AS businessId,
         collection_id AS collectionId,
         scope_id AS scopeId,
         kind,
         content,
         level,
         status,
         confidence,
         authority,
         enforcement,
         source_kind AS sourceKind,
         source_id AS sourceId,
         repo_owner AS repoOwner,
         repo_name AS repoName,
         reinforcement_count AS reinforcementCount,
         times_derived AS timesDerived,
         created_at_ms AS createdAtMs,
         updated_at_ms AS updatedAtMs
       FROM memory_conclusions
       WHERE business_id = ?
         AND scope_id = ?
         AND status = 'active'
         AND deleted_at_ms IS NULL
       ORDER BY reinforcement_count DESC, times_derived DESC, updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(params.businessId, params.scopeId, Math.max(0, Math.min(params.limit, 100)))
    .all<MemoryConclusionRow>();
  return result.results;
}

export async function listReinforcedMemoryConclusionsForScopes(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; limit: number },
): Promise<MemoryConclusionRow[]> {
  if (params.scopeIds.length === 0) return [];
  const result = await buildListReinforcedMemoryConclusionsForScopesStatement(db, params).all<MemoryConclusionRow>();
  return result.results;
}

export function buildListReinforcedMemoryConclusionsForScopesStatement(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         id,
         business_id AS businessId,
         collection_id AS collectionId,
         scope_id AS scopeId,
         kind,
         content,
         level,
         status,
         confidence,
         authority,
         enforcement,
         source_kind AS sourceKind,
         source_id AS sourceId,
         repo_owner AS repoOwner,
         repo_name AS repoName,
         reinforcement_count AS reinforcementCount,
         times_derived AS timesDerived,
         created_at_ms AS createdAtMs,
         updated_at_ms AS updatedAtMs
       FROM memory_conclusions
       WHERE business_id = ?
         AND scope_id IN (SELECT value FROM json_each(?))
         AND status = 'active'
         AND deleted_at_ms IS NULL
         AND (valid_until_ms IS NULL OR valid_until_ms > ?)
         AND (reinforcement_count > 0 OR times_derived > 0)
       ORDER BY reinforcement_count DESC, times_derived DESC, updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(params.businessId, JSON.stringify(params.scopeIds), Date.now(), boundedLimit(params.limit, 20));
}

export async function listRecentMemoryMessagesForScopes(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; limit: number },
): Promise<RecentMemoryMessageRow[]> {
  if (params.scopeIds.length === 0) return [];
  const result = await buildListRecentMemoryMessagesForScopesStatement(db, params).all<RecentMemoryMessageRow>();
  return result.results;
}

export function buildListRecentMemoryMessagesForScopesStatement(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         mm.id,
         mm.business_id AS businessId,
         mm.session_id AS sessionId,
         ms.scope_id AS scopeId,
         mm.role,
         mm.content_text AS contentText,
         mm.source_uri AS sourceUri,
         mm.occurred_at_ms AS occurredAtMs
       FROM memory_messages mm
       JOIN memory_sessions ms ON ms.id = mm.session_id
       WHERE mm.business_id = ?
         AND ms.scope_id IN (SELECT value FROM json_each(?))
         AND mm.deleted_at_ms IS NULL
         AND ms.deleted_at_ms IS NULL
       ORDER BY mm.occurred_at_ms DESC, mm.seq_in_session DESC
       LIMIT ?`,
    )
    .bind(params.businessId, JSON.stringify(params.scopeIds), boundedLimit(params.limit, 20));
}

export async function searchRepoMemoryFts(
  db: D1Database,
  params: { repoOwner: string; repoName: string; query: string; limit: number },
): Promise<RepoMemoryFtsRow[]> {
  const result = await db
    .prepare(
      `SELECT
         rm.id,
         rm.memory_id AS memoryId,
         rm.repo_owner AS repoOwner,
         rm.repo_name AS repoName,
         rm.memory_type AS memoryType,
         rm.action_type AS actionType,
         rm.level,
         rm.primitive,
         rm.confidence,
         rm.authority,
         rm.enforcement,
         rm.context_hint AS contextHint,
         rm.content,
         rm.source_pr_number AS sourcePrNumber,
         rm.source_session_ids_json AS sourceSessionIdsJson,
         rm.memory_json AS memoryJson,
         bm25(repo_memories_fts) AS rank
       FROM repo_memories_fts
       JOIN repo_memories rm ON rm.rowid = repo_memories_fts.rowid
       WHERE repo_memories_fts MATCH ?
         AND rm.repo_owner = ?
         AND rm.repo_name = ?
         AND rm.status = 'active'
       ORDER BY rank ASC, rm.updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(params.query, params.repoOwner, params.repoName, boundedLimit(params.limit, 30))
    .all<RepoMemoryFtsRow>();
  return result.results;
}

export async function searchMemoryConclusionsFts(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string | null;
    repoName: string | null;
    scopeIds: string[];
    query: string;
    limit: number;
  },
): Promise<MemoryConclusionFtsRow[]> {
  // Fail closed: with no scopes resolved we must not fall back to an unscoped
  // match that would leak other scopes' conclusions across the business.
  if (params.scopeIds.length === 0) return [];
  const result = await buildSearchMemoryConclusionsFtsStatement(db, params).all<MemoryConclusionFtsRow>();
  return result.results;
}

export function buildSearchMemoryConclusionsFtsStatement(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string | null;
    repoName: string | null;
    scopeIds: string[];
    query: string;
    limit: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         mc.id,
         mc.business_id AS businessId,
         mc.collection_id AS collectionId,
         mc.scope_id AS scopeId,
         mc.kind,
         mc.content,
         mc.level,
         mc.status,
         mc.confidence,
         mc.authority,
         mc.enforcement,
         mc.source_kind AS sourceKind,
         mc.source_id AS sourceId,
         mc.repo_owner AS repoOwner,
         mc.repo_name AS repoName,
         mc.reinforcement_count AS reinforcementCount,
         mc.times_derived AS timesDerived,
         mc.created_at_ms AS createdAtMs,
         mc.updated_at_ms AS updatedAtMs,
         bm25(memory_conclusions_fts) AS rank,
         (
           SELECT source_uri
           FROM memory_conclusion_sources source
           WHERE source.conclusion_id = mc.id
             AND source.deleted_at_ms IS NULL
           ORDER BY source.created_at_ms ASC
           LIMIT 1
         ) AS sourceUri,
         (
           SELECT excerpt
           FROM memory_conclusion_sources source
           WHERE source.conclusion_id = mc.id
             AND source.deleted_at_ms IS NULL
           ORDER BY source.created_at_ms ASC
           LIMIT 1
         ) AS sourceExcerpt
       FROM memory_conclusions_fts
       JOIN memory_conclusions mc ON mc.rowid = memory_conclusions_fts.rowid
       WHERE memory_conclusions_fts MATCH ?
         AND mc.business_id = ?
         AND mc.status = 'active'
         AND mc.deleted_at_ms IS NULL
         AND (mc.valid_until_ms IS NULL OR mc.valid_until_ms > ?)
         AND mc.scope_id IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR mc.repo_owner IS NULL OR mc.repo_owner = ?)
         AND (? IS NULL OR mc.repo_name IS NULL OR mc.repo_name = ?)
       ORDER BY rank ASC, mc.reinforcement_count DESC, mc.updated_at_ms DESC
       LIMIT ?`,
    )
    .bind(
      params.query,
      params.businessId,
      Date.now(),
      JSON.stringify(params.scopeIds),
      params.repoOwner,
      params.repoOwner,
      params.repoName,
      params.repoName,
      boundedLimit(params.limit, 30),
    );
}

export async function getMemoryConclusionSourceChain(
  db: D1Database,
  params: {
    businessId: string;
    memoryId: string;
    repoOwner: string | null;
    repoName: string | null;
    customerSlug: string | null;
    slackTeamId: string | null;
    slackChannelId: string | null;
    slackThreadTs: string | null;
    limit: number;
  },
): Promise<MemoryConclusionSourceChainRow[]> {
  const result = await db
    .prepare(
      `SELECT
         mc.id AS conclusionId,
         mc.kind,
         mc.content,
         mc.level,
         mc.confidence,
         source.source_kind AS sourceKind,
         source.source_id AS sourceId,
         source.source_uri AS sourceUri,
         source.excerpt,
         source.relationship,
         source.created_at_ms AS sourceCreatedAtMs
       FROM memory_conclusions mc
       JOIN memory_scopes scope ON scope.id = mc.scope_id AND scope.business_id = mc.business_id
       JOIN memory_conclusion_sources source
         ON source.conclusion_id = mc.id
        AND source.business_id = mc.business_id
        AND source.deleted_at_ms IS NULL
       WHERE mc.business_id = ?
         AND mc.id = ?
         AND mc.status = 'active'
         AND mc.deleted_at_ms IS NULL
         AND (mc.valid_until_ms IS NULL OR mc.valid_until_ms > ?)
         AND (? IS NULL OR scope.repo_owner IS NULL OR scope.repo_owner = ?)
         AND (? IS NULL OR scope.repo_name IS NULL OR scope.repo_name = ?)
         AND (? IS NULL OR scope.customer_slug = ?)
         AND (? IS NULL OR scope.slack_team_id = ?)
         AND (? IS NULL OR scope.slack_channel_id = ?)
         AND (? IS NULL OR scope.slack_thread_ts = ?)
       ORDER BY source.created_at_ms ASC, source.source_id ASC
       LIMIT ?`,
    )
    .bind(
      params.businessId,
      params.memoryId,
      Date.now(),
      params.repoOwner,
      params.repoOwner,
      params.repoName,
      params.repoName,
      params.customerSlug,
      params.customerSlug,
      params.slackTeamId,
      params.slackTeamId,
      params.slackChannelId,
      params.slackChannelId,
      params.slackThreadTs,
      params.slackThreadTs,
      boundedLimit(params.limit, 50),
    )
    .all<MemoryConclusionSourceChainRow>();
  return result.results;
}

export async function searchMemoryMessagesFts(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; query: string; limit: number },
): Promise<MemoryMessageFtsRow[]> {
  // Fail closed: never fall back to an unscoped match that would leak other
  // scopes' messages across the business.
  if (params.scopeIds.length === 0) return [];
  const result = await buildSearchMemoryMessagesFtsStatement(db, params).all<MemoryMessageFtsRow>();
  return result.results;
}

export function buildSearchMemoryMessagesFtsStatement(
  db: D1Database,
  params: { businessId: string; scopeIds: string[]; query: string; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT
         mm.id,
         mm.business_id AS businessId,
         mm.session_id AS sessionId,
         ms.scope_id AS scopeId,
         mm.role,
         mm.content_text AS contentText,
         mm.source_uri AS sourceUri,
         mm.occurred_at_ms AS occurredAtMs,
         bm25(memory_messages_fts) AS rank
       FROM memory_messages_fts
       JOIN memory_messages mm ON mm.rowid = memory_messages_fts.rowid
       JOIN memory_sessions ms ON ms.id = mm.session_id
       WHERE memory_messages_fts MATCH ?
         AND mm.business_id = ?
         AND mm.deleted_at_ms IS NULL
         AND ms.deleted_at_ms IS NULL
         AND ms.scope_id IN (SELECT value FROM json_each(?))
       ORDER BY rank ASC, mm.occurred_at_ms DESC
       LIMIT ?`,
    )
    .bind(params.query, params.businessId, JSON.stringify(params.scopeIds), boundedLimit(params.limit, 20));
}

export async function listMemorySemanticDocumentsByVectorIds(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string | null;
    repoName: string | null;
    scopeIds: string[];
    vectorIds: string[];
    limit: number;
  },
): Promise<MemorySemanticDocumentRow[]> {
  const vectorIds = [...new Set(params.vectorIds.map((id) => id.trim()).filter(Boolean))].slice(0, 60);
  const scopeIds = [...new Set(params.scopeIds.map((id) => id.trim()).filter(Boolean))].slice(0, 60);
  if (vectorIds.length === 0 || scopeIds.length === 0) return [];
  const placeholders = vectorIds.map(() => "?").join(",");
  const scopePlaceholders = scopeIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT
         doc.id,
         doc.source_kind AS sourceKind,
         doc.source_id AS sourceId,
         doc.business_id AS businessId,
         doc.repo_owner AS repoOwner,
         doc.repo_name AS repoName,
         doc.scope_type AS scopeType,
         doc.scope_id AS scopeId,
         doc.text,
         doc.vector_namespace AS vectorNamespace,
         doc.vector_id AS vectorId,
         doc.vector_state AS vectorState,
         doc.updated_at_ms AS updatedAtMs,
         mc.level AS conclusionLevel
       FROM memory_semantic_documents doc
       LEFT JOIN memory_conclusions mc
         ON doc.source_kind = 'memory_conclusion'
        AND mc.id = doc.source_id
        AND mc.business_id = doc.business_id
        AND mc.status = 'active'
        AND mc.deleted_at_ms IS NULL
        AND (mc.valid_until_ms IS NULL OR mc.valid_until_ms > ?)
       WHERE doc.vector_id IN (${placeholders})
         AND doc.business_id = ?
         AND doc.scope_id IN (${scopePlaceholders})
         AND doc.vector_state = 'synced'
         AND doc.deleted_at_ms IS NULL
         AND (doc.source_kind != 'memory_conclusion' OR mc.id IS NOT NULL)
         AND (? IS NULL OR doc.repo_owner IS NULL OR doc.repo_owner = ?)
         AND (? IS NULL OR doc.repo_name IS NULL OR doc.repo_name = ?)
       LIMIT ?`,
    )
    .bind(
      Date.now(),
      ...vectorIds,
      params.businessId,
      ...scopeIds,
      params.repoOwner,
      params.repoOwner,
      params.repoName,
      params.repoName,
      boundedLimit(params.limit, 60),
    )
    .all<MemorySemanticDocumentRow>();
  return result.results;
}

export async function listPendingMemorySemanticDocuments(
  db: D1Database,
  params: { limit: number },
): Promise<PendingMemorySemanticDocumentRow[]> {
  const result = await db
    .prepare(
      `SELECT
         id,
         source_kind AS sourceKind,
         source_id AS sourceId,
         business_id AS businessId,
         repo_owner AS repoOwner,
         repo_name AS repoName,
         scope_type AS scopeType,
         scope_id AS scopeId,
         text,
         vector_namespace AS vectorNamespace,
         vector_id AS vectorId,
         vector_state AS vectorState,
         sync_attempts AS syncAttempts,
         updated_at_ms AS updatedAtMs,
         NULL AS conclusionLevel
       FROM memory_semantic_documents
       WHERE vector_state IN ('pending', 'failed')
         AND deleted_at_ms IS NULL
         AND sync_attempts < ${MEMORY_MAX_VECTOR_SYNC_ATTEMPTS}
       ORDER BY vector_state ASC, updated_at_ms ASC
       LIMIT ?`,
    )
    .bind(boundedLimit(params.limit, 25))
    .all<PendingMemorySemanticDocumentRow>();
  return result.results;
}

export async function markMemorySemanticDocumentSynced(
  db: D1Database,
  params: { id: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_semantic_documents
       SET vector_state = 'synced',
           last_sync_at_ms = ?,
           last_error = NULL,
           updated_at_ms = ?
       WHERE id = ?`,
    )
    .bind(params.nowMs, params.nowMs, params.id)
    .run();
}

export async function markMemorySemanticDocumentFailed(
  db: D1Database,
  params: { id: string; error: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_semantic_documents
       SET vector_state = 'failed',
           sync_attempts = sync_attempts + 1,
           last_error = ?,
           updated_at_ms = ?
       WHERE id = ?`,
    )
    .bind(params.error.slice(0, 500), params.nowMs, params.id)
    .run();
}

function boundedLimit(value: number, max: number): number {
  return Math.max(0, Math.min(Math.floor(value), max));
}
