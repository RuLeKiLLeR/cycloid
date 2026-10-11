import {
  COMPANY_MEMORY_CHANNEL_SCOPE_TYPES,
  COMPANY_MEMORY_SCOPE_TYPES,
  COMPANY_MEMORY_SOURCE_TYPE,
  type CompanyMemoryChannelScopeType,
  type CompanyMemoryScopeType,
  type CompanyMemorySourceType,
} from "../constants/company-memory";
import { d1Changed } from "../db/errors";
import { computeSha256Hex, normalizeWebhookReference } from "../utils";

export interface IngestionEventInput {
  businessId: string;
  sourceType: CompanyMemorySourceType;
  sourceEventId: string | null;
  sourceUri: string;
  sourceTimeMs: number;
  contentText: string | null;
  contentRef: string | null;
  scopeType?: CompanyMemoryScopeType | null;
  scopeId?: string | null;
  actorRef?: string | null;
  teamId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  untrustedPayload?: boolean;
  redactionReason?: string | null;
  skipReason?: string | null;
  contentHash?: string | null;
}

export interface IngestionEventRow {
  id: string;
  businessId: string;
  sourceType: string;
  sourceEventId: string | null;
  sourceUri: string;
  sourceTimeMs: number;
  contentHash: string;
  contentText: string | null;
  contentRef: string | null;
  scopeType: string | null;
  scopeId: string | null;
  actorRef: string | null;
  teamId: string | null;
  channelId: string | null;
  threadTs: string | null;
  untrustedPayload: boolean;
  processingState: string;
  redactionReason: string | null;
  skipReason: string | null;
  receivedAtMs: number;
  processedAtMs: number | null;
}

interface IngestionEventDbRow {
  id: string;
  business_id: string;
  source_type: string;
  source_event_id: string | null;
  source_uri: string;
  source_time_ms: number;
  content_hash: string;
  content_text: string | null;
  content_ref: string | null;
  scope_type: string | null;
  scope_id: string | null;
  actor_ref: string | null;
  team_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  untrusted_payload: number;
  processing_state: string;
  redaction_reason: string | null;
  skip_reason: string | null;
  received_at_ms: number;
  processed_at_ms: number | null;
}

export interface SlackChannelIntakeRow {
  businessId: string;
  teamId: string;
  channelId: string;
  scopeType: CompanyMemoryChannelScopeType;
  scopeId: string | null;
  enabledAtMs: number;
  enabledByUserId: number | null;
}

interface SlackChannelIntakeDbRow {
  business_id: string;
  team_id: string;
  channel_id: string;
  scope_type: CompanyMemoryChannelScopeType;
  scope_id: string | null;
  enabled_at_ms: number;
  enabled_by_user_id: number | null;
}

function requireBusinessId(businessId: string): string {
  const normalized = businessId.trim();
  if (!normalized) throw new Error("business_id is required");
  return normalized;
}

function rowToIngestionEvent(row: IngestionEventDbRow): IngestionEventRow {
  return {
    id: row.id,
    businessId: row.business_id,
    sourceType: row.source_type,
    sourceEventId: row.source_event_id,
    sourceUri: row.source_uri,
    sourceTimeMs: row.source_time_ms,
    contentHash: row.content_hash,
    contentText: row.content_text,
    contentRef: row.content_ref,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    actorRef: row.actor_ref,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    untrustedPayload: row.untrusted_payload === 1,
    processingState: row.processing_state,
    redactionReason: row.redaction_reason,
    skipReason: row.skip_reason,
    receivedAtMs: row.received_at_ms,
    processedAtMs: row.processed_at_ms,
  };
}

function rowToChannelIntake(row: SlackChannelIntakeDbRow): SlackChannelIntakeRow {
  return {
    businessId: row.business_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    enabledAtMs: row.enabled_at_ms,
    enabledByUserId: row.enabled_by_user_id,
  };
}

function requireSourceType(value: CompanyMemorySourceType): CompanyMemorySourceType {
  if ((Object.values(COMPANY_MEMORY_SOURCE_TYPE) as string[]).includes(value)) return value;
  throw new Error(`Invalid company memory source_type: ${String(value)}`);
}

function requireScopeType(value: CompanyMemoryScopeType): CompanyMemoryScopeType {
  if ((COMPANY_MEMORY_SCOPE_TYPES as readonly string[]).includes(value)) return value;
  throw new Error(`Invalid company memory scope_type: ${String(value)}`);
}

function requireChannelScopeType(value: CompanyMemoryChannelScopeType): CompanyMemoryChannelScopeType {
  if ((COMPANY_MEMORY_CHANNEL_SCOPE_TYPES as readonly string[]).includes(value)) return value;
  throw new Error(`Invalid company memory scope_type: ${String(value)}`);
}

function requireSourceTimeMs(value: number): number {
  if (Number.isFinite(value)) return Math.floor(value);
  throw new Error("source_time_ms must be finite");
}

function requireSourceUri(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("source_uri is required");
  return normalized;
}

function optionalReference(value: string | null | undefined): string | null {
  return normalizeWebhookReference(value) ?? null;
}

function optionalReason(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

export async function recordIngestionEvent(
  db: D1Database,
  input: IngestionEventInput,
): Promise<{ id: string; created: boolean }> {
  const businessId = requireBusinessId(input.businessId);
  const sourceType = requireSourceType(input.sourceType);
  const sourceUri = requireSourceUri(input.sourceUri);
  const sourceTimeMs = requireSourceTimeMs(input.sourceTimeMs);
  const scopeType = input.scopeType ? requireScopeType(input.scopeType) : null;
  const sourceEventId = optionalReference(input.sourceEventId);
  const redactionReason = optionalReason(input.redactionReason);
  const skipReason = optionalReason(input.skipReason);
  const id = crypto.randomUUID();
  const contentHash = input.contentHash ?? (await computeSha256Hex(input.contentText ?? input.contentRef ?? ""));
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ingestion_events
       (id, business_id, source_type, source_event_id, source_uri, source_time_ms, content_hash, content_text,
        content_ref, scope_type, scope_id, actor_ref, team_id, channel_id, thread_ts, untrusted_payload,
        processing_state, redaction_reason, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      businessId,
      sourceType,
      sourceEventId,
      sourceUri,
      sourceTimeMs,
      contentHash,
      input.contentText,
      input.contentRef,
      scopeType,
      optionalReference(input.scopeId),
      optionalReference(input.actorRef),
      optionalReference(input.teamId),
      optionalReference(input.channelId),
      optionalReference(input.threadTs),
      input.untrustedPayload ? 1 : 0,
      redactionReason ? "quarantined" : "pending",
      redactionReason,
      skipReason,
    )
    .run();
  if (d1Changed(result)) return { id, created: true };
  if (sourceEventId) {
    const row = await db
      .prepare(
        `SELECT id FROM ingestion_events
         WHERE business_id = ? AND source_type = ? AND source_event_id = ?
         LIMIT 1`,
      )
      .bind(businessId, sourceType, sourceEventId)
      .first<{ id: string }>();
    if (row?.id) return { id: row.id, created: false };
  }
  return { id, created: false };
}

export async function claimPendingIngestionEvent(
  db: D1Database,
  businessId: string,
  id: string,
): Promise<IngestionEventRow | null> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const row = await db
    .prepare(
      `UPDATE ingestion_events
       SET processing_state = 'processing', processed_at_ms = unixepoch() * 1000
       WHERE business_id = ? AND id = ? AND processing_state = 'pending'
       RETURNING *`,
    )
    .bind(normalizedBusinessId, id)
    .first<IngestionEventDbRow>();
  return row ? rowToIngestionEvent(row) : null;
}

export async function resetIngestionEventPending(db: D1Database, id: string, businessId: string): Promise<void> {
  const normalizedBusinessId = requireBusinessId(businessId);
  await db
    .prepare(
      `UPDATE ingestion_events
       SET processing_state = 'pending', processed_at_ms = NULL
       WHERE id = ? AND business_id = ? AND processing_state = 'processing'`,
    )
    .bind(id, normalizedBusinessId)
    .run();
}

export async function recoverStaleIngestionEvents(
  db: D1Database,
  staleThresholdMs: number,
  limit = 100,
): Promise<number> {
  // Compute the stale cutoff in SQL against the D1 clock (unixepoch()*1000),
  // the same clock that stamps processed_at_ms/received_at_ms. Using Date.now()
  // (worker clock) here would skew the comparison under worker/D1 clock drift.
  const safeThresholdMs = Math.max(1, Math.floor(staleThresholdMs));
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await db
    .prepare(
      `UPDATE ingestion_events
       SET processing_state = 'pending', processed_at_ms = NULL
       WHERE id IN (
         SELECT id FROM ingestion_events
         WHERE processing_state = 'processing'
           AND COALESCE(processed_at_ms, received_at_ms) < (unixepoch() * 1000) - ?
         ORDER BY COALESCE(processed_at_ms, received_at_ms) ASC
         LIMIT ?
       )`,
    )
    .bind(safeThresholdMs, safeLimit)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Claims stale pending rows for recovery re-enqueue without changing their
 * processing state. For pending rows, processed_at_ms is the last recovery
 * enqueue attempt; the refine consumer still claims by processing_state.
 */
export async function claimReenqueueableIngestionEvents(
  db: D1Database,
  staleThresholdMs: number,
  limit = 100,
): Promise<Array<{ id: string; businessId: string }>> {
  // Stale cutoff computed in SQL against the D1 clock (unixepoch()*1000) so it
  // matches the clock that stamps processed_at_ms/received_at_ms; Date.now()
  // (worker clock) would skew the comparison under worker/D1 clock drift.
  const safeThresholdMs = Math.max(1, Math.floor(staleThresholdMs));
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await db
    .prepare(
      `UPDATE ingestion_events
       SET processed_at_ms = unixepoch() * 1000
       WHERE id IN (
         SELECT id FROM ingestion_events
         WHERE processing_state = 'pending'
           AND COALESCE(processed_at_ms, received_at_ms) < (unixepoch() * 1000) - ?
         ORDER BY COALESCE(processed_at_ms, received_at_ms) ASC
         LIMIT ?
       )
       RETURNING id, business_id`,
    )
    .bind(safeThresholdMs, safeLimit)
    .all<{ id: string; business_id: string }>();
  return result.results.map((row) => ({ id: row.id, businessId: row.business_id }));
}

export async function markIngestionEventSkipped(
  db: D1Database,
  id: string,
  businessId: string,
  skipReason: string,
): Promise<void> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const normalizedSkipReason = optionalReason(skipReason) ?? "unspecified";
  await db
    .prepare(
      `UPDATE ingestion_events
       SET processing_state = 'skipped', skip_reason = ?, processed_at_ms = unixepoch() * 1000
       WHERE id = ? AND business_id = ?`,
    )
    .bind(normalizedSkipReason, id, normalizedBusinessId)
    .run();
}

export async function getIngestionEvent(
  db: D1Database,
  businessId: string,
  id: string,
): Promise<IngestionEventRow | null> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const row = await db
    .prepare("SELECT * FROM ingestion_events WHERE business_id = ? AND id = ? LIMIT 1")
    .bind(normalizedBusinessId, id)
    .first<IngestionEventDbRow>();
  return row ? rowToIngestionEvent(row) : null;
}

export async function getIngestionEventBySourceUri(
  db: D1Database,
  businessId: string,
  sourceUri: string,
): Promise<IngestionEventRow | null> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const normalizedSourceUri = requireSourceUri(sourceUri);
  const row = await db
    .prepare("SELECT * FROM ingestion_events WHERE business_id = ? AND source_uri = ? LIMIT 1")
    .bind(normalizedBusinessId, normalizedSourceUri)
    .first<IngestionEventDbRow>();
  return row ? rowToIngestionEvent(row) : null;
}

export async function getIngestionEventsForThread(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<IngestionEventRow[]> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  const normalizedThreadTs = normalizeWebhookReference(threadTs);
  if (!normalizedTeamId || !normalizedChannelId || !normalizedThreadTs) return [];
  const result = await db
    .prepare(
      `SELECT * FROM ingestion_events
       WHERE business_id = ? AND team_id = ? AND channel_id = ? AND thread_ts = ?
       ORDER BY source_time_ms ASC`,
    )
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId, normalizedThreadTs)
    .all<IngestionEventDbRow>();
  return result.results.map(rowToIngestionEvent);
}

export async function listCustomerScopeIds(db: D1Database, businessId: string): Promise<string[]> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const rows = await db
    .prepare(
      `SELECT DISTINCT lower(scope_id) AS scope_id
       FROM ingestion_events
       WHERE business_id = ?
         AND scope_type = 'customer'
         AND scope_id IS NOT NULL
         AND scope_id != ''`,
    )
    .bind(normalizedBusinessId)
    .all<{ scope_id: string }>();
  return rows.results.map((row) => row.scope_id);
}

export async function getChannelIntake(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
): Promise<SlackChannelIntakeRow | null> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  if (!normalizedTeamId || !normalizedChannelId) return null;
  const row = await db
    .prepare(
      `SELECT business_id, team_id, channel_id, scope_type, scope_id, enabled_at_ms, enabled_by_user_id
       FROM slack_channel_intake
       WHERE business_id = ? AND team_id = ? AND channel_id = ?
       LIMIT 1`,
    )
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId)
    .first<SlackChannelIntakeDbRow>();
  return row ? rowToChannelIntake(row) : null;
}

export async function upsertChannelIntake(
  db: D1Database,
  input: {
    businessId: string;
    teamId: string;
    channelId: string;
    scopeType: CompanyMemoryChannelScopeType;
    scopeId?: string | null;
    enabledByUserId?: number | null;
  },
): Promise<SlackChannelIntakeRow> {
  const businessId = requireBusinessId(input.businessId);
  const teamId = normalizeWebhookReference(input.teamId);
  const channelId = normalizeWebhookReference(input.channelId);
  const scopeType = requireChannelScopeType(input.scopeType);
  const scopeId = optionalReference(input.scopeId);
  if (!teamId || !channelId) throw new Error("team_id and channel_id are required");
  await db
    .prepare(
      `INSERT INTO slack_channel_intake
       (business_id, team_id, channel_id, scope_type, scope_id, enabled_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, team_id, channel_id) DO UPDATE SET
         scope_type = excluded.scope_type,
         scope_id = excluded.scope_id,
         enabled_at_ms = unixepoch() * 1000,
         enabled_by_user_id = excluded.enabled_by_user_id`,
    )
    .bind(businessId, teamId, channelId, scopeType, scopeId, input.enabledByUserId ?? null)
    .run();
  const row = await getChannelIntake(db, businessId, teamId, channelId);
  if (!row) throw new Error("Failed to upsert Slack channel intake");
  return row;
}

export async function deleteChannelIntake(
  db: D1Database,
  businessId: string,
  teamId: string,
  channelId: string,
): Promise<boolean> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const normalizedTeamId = normalizeWebhookReference(teamId);
  const normalizedChannelId = normalizeWebhookReference(channelId);
  if (!normalizedTeamId || !normalizedChannelId) return false;
  const result = await db
    .prepare("DELETE FROM slack_channel_intake WHERE business_id = ? AND team_id = ? AND channel_id = ?")
    .bind(normalizedBusinessId, normalizedTeamId, normalizedChannelId)
    .run();
  return d1Changed(result);
}

export async function listChannelIntake(db: D1Database, businessId: string): Promise<SlackChannelIntakeRow[]> {
  const normalizedBusinessId = requireBusinessId(businessId);
  const result = await db
    .prepare(
      `SELECT business_id, team_id, channel_id, scope_type, scope_id, enabled_at_ms, enabled_by_user_id
       FROM slack_channel_intake
       WHERE business_id = ?
       ORDER BY team_id ASC, channel_id ASC`,
    )
    .bind(normalizedBusinessId)
    .all<SlackChannelIntakeDbRow>();
  return result.results.map(rowToChannelIntake);
}
