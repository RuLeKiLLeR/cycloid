import type { IntegrationId } from "../../../../../shared/constants/integration-helpers.js";
import type {
  IntegrationLifecycleReasonCode,
  IntegrationLifecycleStage,
  IntegrationLifecycleStatus,
} from "../../../../../shared/enums/integration-lifecycle.js";
import { D1_RETRY_SAFE_MARKER, isTransientD1StorageError } from "../../db/errors";

export interface IntegrationLifecycleEventRow {
  id: string;
  business_id: string | null;
  user_id: number | null;
  session_id: string | null;
  integration_id: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: IntegrationLifecycleStatus;
  reason_code: IntegrationLifecycleReasonCode | null;
  message: string | null;
  details_json: string | null;
  latency_ms: number;
  created_at: number;
}

export interface IntegrationLifecycleCursor {
  createdAt: number;
  id: string;
}

export interface IntegrationLifecycleScope {
  integrationId: IntegrationId;
  businessId?: string;
  userId?: number;
  sessionId?: string;
}

interface RecordIntegrationLifecycleEventParams {
  id?: string;
  businessId?: string | null;
  userId?: number | null;
  sessionId?: string | null;
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: IntegrationLifecycleStatus;
  reasonCode?: IntegrationLifecycleReasonCode | null;
  message?: string | null;
  detailsJson?: string | null;
  latencyMs?: number;
  createdAt?: number;
}

// OR IGNORE + an id fixed before the first attempt makes a replay exact-once:
// a committed row no-ops on retry (changes = 0), a missing row inserts.
const INSERT_INTEGRATION_LIFECYCLE_EVENT_SQL = `${D1_RETRY_SAFE_MARKER} INSERT OR IGNORE INTO integration_lifecycle_events (
        id,
        business_id,
        user_id,
        session_id,
        integration_id,
        stage,
        status,
        reason_code,
        message,
        details_json,
        latency_ms,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function prepareIntegrationLifecycleInsert(
  db: D1Database,
  params: RecordIntegrationLifecycleEventParams,
): { id: string; statement: D1PreparedStatement } {
  const id = params.id ?? crypto.randomUUID();
  const createdAt = params.createdAt ?? Date.now();
  return {
    id,
    statement: db
      .prepare(INSERT_INTEGRATION_LIFECYCLE_EVENT_SQL)
      .bind(
        id,
        params.businessId ?? null,
        params.userId ?? null,
        params.sessionId ?? null,
        params.integrationId,
        params.stage,
        params.status,
        params.reasonCode ?? null,
        params.message ?? null,
        params.detailsJson ?? null,
        params.latencyMs ?? 0,
        createdAt,
      ),
  };
}

export async function recordIntegrationLifecycleEvent(
  db: D1Database,
  params: RecordIntegrationLifecycleEventParams,
): Promise<string> {
  const prepared = prepareIntegrationLifecycleInsert(db, params);
  await prepared.statement.run();
  return prepared.id;
}

export async function recordIntegrationLifecycleEvents(
  db: D1Database,
  params: RecordIntegrationLifecycleEventParams[],
): Promise<void> {
  if (params.length === 0) return;
  const prepared = params.map((event) => prepareIntegrationLifecycleInsert(db, event));
  const statements = prepared.map((event) => event.statement);
  try {
    await db.batch(statements);
  } catch (error) {
    if (!isTransientD1StorageError(error)) throw error;
    // The traced wrapper never retries batch(); retry once here. Safe without
    // relying on batch atomicity: every statement is OR IGNORE keyed on an id
    // fixed before the first attempt, so replaying the whole batch is
    // exact-once per row even after a partial commit.
    await db.batch(statements);
  }
}

function applyCursorClause(
  sql: string,
  cursor?: IntegrationLifecycleCursor | null,
): { sql: string; bindings: Array<string | number | null> } {
  if (!cursor) {
    return { sql, bindings: [] };
  }
  return {
    sql: `${sql} AND (created_at < ? OR (created_at = ? AND id < ?))`,
    bindings: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

export async function listIntegrationLifecycleEvents(
  db: D1Database,
  params: {
    integrationId?: IntegrationId;
    sessionId?: string;
    businessId?: string;
    userId?: number;
    limit: number;
    cursor?: IntegrationLifecycleCursor | null;
  },
): Promise<IntegrationLifecycleEventRow[]> {
  const where: string[] = [];
  const bindings: Array<string | number | null> = [];
  if (params.integrationId) {
    where.push("integration_id = ?");
    bindings.push(params.integrationId);
  }
  if (params.sessionId) {
    where.push("session_id = ?");
    bindings.push(params.sessionId);
  }
  if (params.businessId) {
    where.push("business_id = ?");
    bindings.push(params.businessId);
  }
  if (params.userId != null) {
    where.push("user_id = ?");
    bindings.push(params.userId);
  }
  const baseSql = `SELECT
      id,
      business_id,
      user_id,
      session_id,
      integration_id,
      stage,
      status,
      reason_code,
      message,
      details_json,
      latency_ms,
      created_at
    FROM integration_lifecycle_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : "WHERE 1 = 1"}`;
  const cursor = applyCursorClause(baseSql, params.cursor);
  const rows = await db
    .prepare(`${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...bindings, ...cursor.bindings, params.limit)
    .all<IntegrationLifecycleEventRow>();
  return rows.results ?? [];
}

export async function getLatestIntegrationLifecycleEvent(
  db: D1Database,
  params: IntegrationLifecycleScope,
): Promise<IntegrationLifecycleEventRow | null> {
  const rows = await listIntegrationLifecycleEvents(db, {
    ...params,
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function listLatestIntegrationLifecycleEvents(
  db: D1Database,
  scopes: IntegrationLifecycleScope[],
): Promise<IntegrationLifecycleEventRow[]> {
  if (scopes.length === 0) return [];
  const seenIntegrationIds = new Set<IntegrationId>();
  for (const scope of scopes) {
    if (seenIntegrationIds.has(scope.integrationId)) {
      throw new Error(`Duplicate integrationId in lifecycle summary scopes: ${scope.integrationId}`);
    }
    seenIntegrationIds.add(scope.integrationId);
  }
  const scopeJson = JSON.stringify(
    scopes.map((scope) => ({
      integrationId: scope.integrationId,
      businessId: scope.businessId ?? null,
      userId: scope.userId ?? null,
      sessionId: scope.sessionId ?? null,
    })),
  );
  const rows = await db
    .prepare(
      `WITH requested(integration_id, business_id, user_id, session_id) AS (
        SELECT
          json_extract(value, '$.integrationId'),
          json_extract(value, '$.businessId'),
          json_extract(value, '$.userId'),
          json_extract(value, '$.sessionId')
        FROM json_each(?)
      ),
      matches AS (
        SELECT
          e.id,
          e.business_id,
          e.user_id,
          e.session_id,
          e.integration_id,
          e.stage,
          e.status,
          e.reason_code,
          e.message,
          e.details_json,
          e.latency_ms,
          e.created_at
        FROM requested
        JOIN integration_lifecycle_events e INDEXED BY idx_integration_lifecycle_session
          ON e.integration_id = requested.integration_id
         AND e.session_id = requested.session_id
        WHERE requested.session_id IS NOT NULL
          AND (requested.business_id IS NULL OR e.business_id = requested.business_id)
          AND (requested.user_id IS NULL OR e.user_id = requested.user_id)
        UNION ALL
        SELECT
          e.id,
          e.business_id,
          e.user_id,
          e.session_id,
          e.integration_id,
          e.stage,
          e.status,
          e.reason_code,
          e.message,
          e.details_json,
          e.latency_ms,
          e.created_at
        FROM requested
        JOIN integration_lifecycle_events e INDEXED BY idx_integration_lifecycle_user
          ON e.integration_id = requested.integration_id
         AND e.user_id = requested.user_id
        WHERE requested.session_id IS NULL
          AND requested.user_id IS NOT NULL
          AND (requested.business_id IS NULL OR e.business_id = requested.business_id)
        UNION ALL
        SELECT
          e.id,
          e.business_id,
          e.user_id,
          e.session_id,
          e.integration_id,
          e.stage,
          e.status,
          e.reason_code,
          e.message,
          e.details_json,
          e.latency_ms,
          e.created_at
        FROM requested
        JOIN integration_lifecycle_events e INDEXED BY idx_integration_lifecycle_business
          ON e.integration_id = requested.integration_id
         AND e.business_id = requested.business_id
        WHERE requested.session_id IS NULL
          AND requested.user_id IS NULL
          AND requested.business_id IS NOT NULL
        UNION ALL
        SELECT
          e.id,
          e.business_id,
          e.user_id,
          e.session_id,
          e.integration_id,
          e.stage,
          e.status,
          e.reason_code,
          e.message,
          e.details_json,
          e.latency_ms,
          e.created_at
        FROM requested
        JOIN integration_lifecycle_events e INDEXED BY idx_integration_lifecycle_status
          ON e.integration_id = requested.integration_id
        WHERE requested.session_id IS NULL
          AND requested.user_id IS NULL
          AND requested.business_id IS NULL
      ),
      ranked AS (
        SELECT
          id,
          business_id,
          user_id,
          session_id,
          integration_id,
          stage,
          status,
          reason_code,
          message,
          details_json,
          latency_ms,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY integration_id
            ORDER BY created_at DESC, id DESC
          ) AS row_number
        FROM matches
      )
      SELECT
        id,
        business_id,
        user_id,
        session_id,
        integration_id,
        stage,
        status,
        reason_code,
        message,
        details_json,
        latency_ms,
        created_at
      FROM ranked
      WHERE row_number = 1`,
    )
    .bind(scopeJson)
    .all<IntegrationLifecycleEventRow>();
  return rows.results ?? [];
}

export async function deleteIntegrationLifecycleEventsBefore(
  db: D1Database,
  cutoffCreatedAt: number,
  limit: number,
  status?: IntegrationLifecycleStatus,
): Promise<number> {
  const result = status
    ? await db
        .prepare(
          `DELETE FROM integration_lifecycle_events
           WHERE id IN (
             SELECT id
             FROM integration_lifecycle_events
             WHERE created_at < ?
               AND status = ?
             LIMIT ?
           )`,
        )
        .bind(cutoffCreatedAt, status, limit)
        .run()
    : await db
        .prepare(
          `DELETE FROM integration_lifecycle_events
           WHERE id IN (
             SELECT id
             FROM integration_lifecycle_events
             WHERE created_at < ?
             LIMIT ?
           )`,
        )
        .bind(cutoffCreatedAt, limit)
        .run();
  return result.meta.changes ?? 0;
}
