import { type CronSweepPage, runCronSweep } from "../cron/sweep-runner";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "../observability/pr-metrics";
import { SESSION_BEARER_INTERNAL_ROUTES, SESSION_INTERNAL_ORIGIN } from "../session/internal-routes";
import { getSessionStub } from "../session/state";
import type { Env } from "../types";

const JOB_NAME = "session-index-reconciler";
const TICK_LIMIT = 200;
const PAGE_LIMIT = 50;
const CONCURRENCY = 10;
const REPROJECT_ROUTE = SESSION_BEARER_INTERNAL_ROUTES.sessionIndexReproject;
const SESSION_INDEX_DRIFT_FIELDS = new Set([
  "rich_status",
  "ui_lifecycle_stage",
  "runtime_provider",
  "runtime_backend",
  "runtime_state",
  "runtime_sandbox_id",
  "runtime_template_id",
  "runtime_state_expires_at",
  "runtime_live_lease_expires_at",
  "runtime_preview_url",
  "runtime_created_at",
  "runtime_last_resumed_at",
  "runtime_last_paused_at",
  "runtime_last_provider_refreshed_at",
  "runtime_provider_ttl_expires_at",
]);

// Fields the SessionDO advances in its own SQLite on a throttled / eventually-consistent
// cadence rather than projecting to session_index synchronously. The live lease is bumped on
// every activity/streaming tick by recordRuntimeActivity (DO-local only) while the projection
// flush is gated behind a half-life throttle, so session_index perpetually trails DO truth for
// live sessions. The reconciler still REPAIRS this every sweep (the reaper and review-loop
// reengage read the lease from session_index), but a reprojection whose ONLY drift is one of
// these fields is EXPECTED lag, not a silent upstream-writer fault — it must not sustain the
// `[Sessions] session_index drift reprojected` monitor (query keys on drift:true). Keep this set
// minimal: add a field only with evidence it is genuinely throttle-projected, not silently stale.
const EVENTUALLY_CONSISTENT_DRIFT_FIELDS = new Set(["runtime_live_lease_expires_at"]);

/**
 * Classify an allow-listed drift set for monitor alerting. Drift limited to throttle-projected
 * eventually-consistent fields is repaired but reported non-alerting so a permanent, benign
 * projection lag does not keep the drift monitor in WARN. An empty set (drift the DO reported but
 * we could not attribute to a known column) stays alerting — never silence unexplained drift.
 */
export function isAlertingDrift(fieldsChanged: string[]): boolean {
  if (fieldsChanged.length === 0) return true;
  return fieldsChanged.some((field) => !EVENTUALLY_CONSISTENT_DRIFT_FIELDS.has(field));
}

interface SessionIndexReconcileItem {
  sessionId: string;
  updatedAt: string | number;
}

interface ReprojectResponse {
  ok: boolean;
  drift: boolean;
  fields_changed?: unknown;
  reason?: string;
}

export function buildSessionIndexDriftEvent(input: {
  sessionId: string;
  fieldsChanged: string[];
  outcome: string;
}): Record<string, unknown> {
  return {
    event: "session_index.drift",
    session_id: input.sessionId,
    fields_changed: input.fieldsChanged,
    outcome: input.outcome,
  };
}

function encodeCursor(item: SessionIndexReconcileItem): string {
  return JSON.stringify({ updatedAt: item.updatedAt, sessionId: item.sessionId });
}

function decodeCursor(cursor: string | null): SessionIndexReconcileItem | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as { updatedAt?: unknown; sessionId?: unknown };
    if (
      (typeof parsed.updatedAt !== "string" && typeof parsed.updatedAt !== "number") ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

export async function fetchSessionIndexReconcilePage(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<CronSweepPage<SessionIndexReconcileItem>> {
  const pageLimit = Math.max(1, Math.min(limit, PAGE_LIMIT));
  const decoded = decodeCursor(cursor);
  const query = decoded
    ? `SELECT session_id, updated_at
       FROM session_index
       WHERE status = 'active'
         AND (updated_at > ? OR (updated_at = ? AND session_id > ?))
       ORDER BY updated_at ASC, session_id ASC
       LIMIT ?`
    : `SELECT session_id, updated_at
       FROM session_index
       WHERE status = 'active'
       ORDER BY updated_at ASC, session_id ASC
       LIMIT ?`;
  const statement = decoded
    ? db.prepare(query).bind(decoded.updatedAt, decoded.updatedAt, decoded.sessionId, pageLimit)
    : db.prepare(query).bind(pageLimit);
  const rows = await statement.all<{ session_id: string; updated_at: string | number }>();
  const items = (rows.results ?? []).map((row) => ({ sessionId: row.session_id, updatedAt: row.updated_at }));
  return { items, nextCursor: items.length === 0 ? null : encodeCursor(items[items.length - 1]) };
}

function metricTags(env: Pick<Env, "WORKER_ENV">, tags: { drift: boolean | "unknown"; outcome: string }): string[] {
  return [...baseControlPlaneMetricTags(env), `drift:${tags.drift}`, `outcome:${tags.outcome}`];
}

function allowedFieldsChanged(fieldsChanged: unknown): string[] {
  if (!Array.isArray(fieldsChanged)) return [];
  return fieldsChanged.filter(
    (field): field is string => typeof field === "string" && SESSION_INDEX_DRIFT_FIELDS.has(field),
  );
}

async function emitReprojectMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { drift: boolean | "unknown"; outcome: string },
): Promise<void> {
  if (!env.DD_API_KEY) return;
  const series: CountMetricSeries[] = [
    {
      metric: "arcanist.session_index.reprojected",
      tags: metricTags(env, tags),
      value: 1,
    },
  ];
  await postCountMetricSeries(env.DD_API_KEY, series, "session-index-reconciler");
}

async function emitDriftFieldMetrics(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { drift: boolean; outcome: string; fieldsChanged: string[] },
): Promise<void> {
  if (!env.DD_API_KEY || tags.fieldsChanged.length === 0) return;
  const series = tags.fieldsChanged.map((field) => ({
    metric: "arcanist.session_index.drift_field",
    tags: [...metricTags(env, tags), `field:${field}`],
    value: 1,
  }));
  await postCountMetricSeries(env.DD_API_KEY, series, "session-index-drift-field");
}

async function emitDriftEvent(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  input: { sessionId: string; fieldsChanged: string[]; outcome: string },
  logger: Logger,
): Promise<void> {
  if (!env.DD_API_KEY) return;
  try {
    await postStructuredEventToDd(env, buildSessionIndexDriftEvent(input));
  } catch (error) {
    logger.warn({ sessionId: input.sessionId, error: String(error) }, "Session index drift event export failed");
  }
}

async function reprojectSessionIndexRow(env: Env, item: SessionIndexReconcileItem, logger: Logger): Promise<void> {
  try {
    if (!env.SANDBOX_RUNTIME_CLEANUP_SECRET) {
      logger.warn({ sessionId: item.sessionId }, "Session index reconciler skipped: cleanup secret missing");
      await emitReprojectMetric(env, { drift: "unknown", outcome: "missing_secret" });
      return;
    }
    const response = await getSessionStub(env, item.sessionId).fetch(
      new URL(REPROJECT_ROUTE.path, SESSION_INTERNAL_ORIGIN),
      {
        method: REPROJECT_ROUTE.method,
        headers: {
          authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
          "content-type": "application/json",
          "x-session-id": item.sessionId,
        },
        body: JSON.stringify({ sessionId: item.sessionId }),
      },
    );
    const payload = (await response.json().catch(() => null)) as ReprojectResponse | null;
    if (!response.ok || !payload) {
      logger.warn(
        { sessionId: item.sessionId, status: response.status, reason: payload?.reason ?? null },
        "Session index reproject route failed",
      );
      await emitReprojectMetric(env, { drift: "unknown", outcome: `http_${response.status}` });
      return;
    }
    if (!payload.drift) {
      await emitReprojectMetric(env, { drift: false, outcome: "clean" });
      return;
    }
    // The DO route already repaired the row; here we only classify the metric. Drift confined to
    // throttle-projected eventually-consistent fields (the live lease) is real-but-benign lag, so we
    // report it non-alerting (drift:false, outcome:"reprojected_soft") to keep the drift monitor quiet
    // while preserving field-level observability. Genuine state drift stays drift:true + emits the event.
    const fieldsChanged = allowedFieldsChanged(payload.fields_changed);
    const alerting = isAlertingDrift(fieldsChanged);
    const outcome = alerting ? "reprojected" : "reprojected_soft";
    await emitReprojectMetric(env, { drift: alerting, outcome });
    if (fieldsChanged.length > 0) {
      await emitDriftFieldMetrics(env, { drift: alerting, outcome, fieldsChanged });
    }
    if (alerting) {
      await emitDriftEvent(env, { sessionId: item.sessionId, fieldsChanged, outcome }, logger);
    }
  } catch (error) {
    logger.warn({ sessionId: item.sessionId, error: String(error) }, "Session index reconciler item failed");
    await emitReprojectMetric(env, { drift: "unknown", outcome: "exception" });
  }
}

export async function runSessionIndexReconcilerSweep(env: Env, options: { logger: Logger }) {
  return runCronSweep(env, options.logger, {
    name: JOB_NAME,
    tickLimit: TICK_LIMIT,
    concurrency: CONCURRENCY,
    fetchPage: fetchSessionIndexReconcilePage,
    processItem: (item) => reprojectSessionIndexRow(env, item, options.logger),
  });
}
