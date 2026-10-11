import type { IntegrationId } from "../../../../shared/constants/integration-helpers.js";

export type IntegrationHealthStatus = "passed" | "failed" | "skipped";
type IntegrationHealthCheckKind = "basic" | "synthetic_session";

export interface BusinessIntegrationHealthCheckRow {
  id: string;
  business_id: string;
  integration_id: IntegrationId;
  check_kind: IntegrationHealthCheckKind;
  status: IntegrationHealthStatus;
  operation: string;
  checked_at: number;
  latency_ms: number;
  diagnostic: string;
  failure_reason: string | null;
  details_json: string | null;
  created_at: number;
}

interface RecordBusinessIntegrationHealthCheckParams {
  id?: string;
  businessId: string;
  integrationId: IntegrationId;
  checkKind: IntegrationHealthCheckKind;
  status: IntegrationHealthStatus;
  operation: string;
  checkedAt: number;
  latencyMs: number;
  diagnostic: string;
  failureReason?: string | null;
  details?: Record<string, unknown> | null;
}

export async function recordBusinessIntegrationHealthCheck(
  db: D1Database,
  params: RecordBusinessIntegrationHealthCheckParams,
): Promise<string> {
  const id = params.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO business_integration_health_checks (
        id,
        business_id,
        integration_id,
        check_kind,
        status,
        operation,
        checked_at,
        latency_ms,
        diagnostic,
        failure_reason,
        details_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.businessId,
      params.integrationId,
      params.checkKind,
      params.status,
      params.operation,
      params.checkedAt,
      params.latencyMs,
      params.diagnostic,
      params.failureReason ?? null,
      params.details ? JSON.stringify(params.details) : null,
      Date.now(),
    )
    .run();
  return id;
}

export async function getLatestBusinessIntegrationHealthCheck(
  db: D1Database,
  businessId: string,
  integrationId: IntegrationId,
  checkKind: IntegrationHealthCheckKind,
): Promise<BusinessIntegrationHealthCheckRow | null> {
  const row = await db
    .prepare(
      `SELECT
        id,
        business_id,
        integration_id,
        check_kind,
        status,
        operation,
        checked_at,
        latency_ms,
        diagnostic,
        failure_reason,
        details_json,
        created_at
       FROM business_integration_health_checks
       WHERE business_id = ? AND integration_id = ? AND check_kind = ?
       ORDER BY checked_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(businessId, integrationId, checkKind)
    .first<BusinessIntegrationHealthCheckRow>();
  return row ?? null;
}

export async function listLatestBusinessIntegrationHealthChecks(
  db: D1Database,
  businessIds: string[],
  integrationId: IntegrationId,
  checkKind: IntegrationHealthCheckKind,
): Promise<BusinessIntegrationHealthCheckRow[]> {
  const uniqueBusinessIds = [...new Set(businessIds.filter((businessId) => businessId.length > 0))];
  if (uniqueBusinessIds.length === 0) return [];

  const rows = await db
    .prepare(
      `WITH requested(business_id) AS (
        SELECT DISTINCT value
        FROM json_each(?)
      ),
      ranked AS (
        SELECT
          h.id,
          h.business_id,
          h.integration_id,
          h.check_kind,
          h.status,
          h.operation,
          h.checked_at,
          h.latency_ms,
          h.diagnostic,
          h.failure_reason,
          h.details_json,
          h.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY h.business_id
            ORDER BY h.checked_at DESC, h.id DESC
          ) AS row_number
        FROM requested
        JOIN business_integration_health_checks h
          ON h.business_id = requested.business_id
        WHERE h.integration_id = ? AND h.check_kind = ?
      )
      SELECT
        id,
        business_id,
        integration_id,
        check_kind,
        status,
        operation,
        checked_at,
        latency_ms,
        diagnostic,
        failure_reason,
        details_json,
        created_at
      FROM ranked
      WHERE row_number = 1`,
    )
    .bind(JSON.stringify(uniqueBusinessIds), integrationId, checkKind)
    .all<BusinessIntegrationHealthCheckRow>();
  return rows.results ?? [];
}

export async function deleteBusinessIntegrationHealthChecksBefore(
  db: D1Database,
  integrationId: IntegrationId,
  cutoffCreatedAt: number,
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM business_integration_health_checks WHERE integration_id = ? AND created_at < ?")
    .bind(integrationId, cutoffCreatedAt)
    .run();
  return result.meta.changes ?? 0;
}
