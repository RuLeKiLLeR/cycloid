import type { BusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import { normalizeBusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { d1Changed } from "../db/errors";
import {
  OFFBOARDING_DYNAMIC_BUSINESS_ID_EXCLUDED_TABLES,
  OFFBOARDING_SESSION_ID_TABLES,
  OFFBOARDING_USER_ID_TABLES,
} from "./offboarding-tables";

export type BusinessRecord = {
  id: string;
  name: string;
  sharedSessions: boolean;
  egressAllowlist: string[] | null;
  egressAllowlistSource: BusinessEgressAllowlistSource | null;
  createdAt: number;
};

type BusinessRow = {
  id: string;
  name: string;
  shared_sessions: number;
  egress_allowlist_json: string | null;
  egress_allowlist_source_repo_owner: string | null;
  egress_allowlist_source_repo_name: string | null;
  created_at: number;
};

export type BusinessEgressAllowlistSource = {
  sourceRepoOwner: string;
  sourceRepoName: string;
};

export type AdminBusinessSummaryRecord = {
  id: string;
  name: string;
  createdAt: number;
  memberCount: number;
  sessionCount: number;
  lastSessionAt: number | null;
};

export type OffboardingJobPhase =
  | "captured"
  | "exported"
  | "durable_objects_purged"
  | "external_cleanup_finished"
  | "s3_artifacts_deleted"
  | "db_purged"
  | "completed"
  | "failed";

export type OffboardingJob = {
  jobId: string;
  businessId: string;
  archiveKey: string;
  capturedUserIds: number[];
  capturedSessionIds: string[];
  phase: OffboardingJobPhase;
  stepMarkers: Record<string, boolean>;
  tableCounts: Record<string, number>;
  externalResults: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type OffboardingJobManifest = {
  job: OffboardingJob;
  created: boolean;
};

type OffboardingJobRow = {
  job_id: string;
  business_id: string;
  archive_key: string;
  captured_user_ids_json: string;
  captured_session_ids_json: string;
  phase: string;
  step_markers_json: string;
  table_counts_json: string;
  external_results_json: string;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export function buildOffboardingArchiveKey(businessId: string, jobId: string): string {
  return `offboard-archive/${encodeURIComponent(businessId)}/${encodeURIComponent(jobId)}`;
}

export async function createOffboardingJobManifest(
  db: D1Database,
  input: { businessId: string; jobId?: string; now?: number },
): Promise<OffboardingJobManifest> {
  const businessId = input.businessId.trim();
  if (!businessId) throw new Error("businessId is required");

  // Resume an in-progress job, but let a `failed` job be superseded by a fresh
  // manifest so a permanent failure never blocks re-offboarding the business.
  // Re-capture is safe: deleteBusinessCascade only removes the capture-source
  // rows (users, session_index) in its final atomic batch, which rolls back on
  // failure, so a failed job always leaves an identical snapshot to re-capture.
  const existing = await getActiveOffboardingJob(db, businessId);
  if (existing) return { job: existing, created: false };

  const jobId = input.jobId ?? crypto.randomUUID();
  const now = input.now ?? Date.now();
  const [usersResult, sessionsResult] = await db.batch([
    db.prepare("SELECT id FROM users WHERE business_id = ? ORDER BY id ASC").bind(businessId),
    db.prepare("SELECT session_id FROM session_index WHERE business_id = ? ORDER BY session_id ASC").bind(businessId),
  ]);
  const capturedUserIds = ((usersResult.results ?? []) as Array<{ id: number }>).map((row) => row.id);
  const capturedSessionIds = ((sessionsResult.results ?? []) as Array<{ session_id: string }>).map(
    (row) => row.session_id,
  );
  const archiveKey = buildOffboardingArchiveKey(businessId, jobId);

  try {
    await db
      .prepare(
        `INSERT INTO offboarding_jobs (
           job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
           phase, step_markers_json, table_counts_json, external_results_json, error_json,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        jobId,
        businessId,
        archiveKey,
        JSON.stringify(capturedUserIds),
        JSON.stringify(capturedSessionIds),
        "captured",
        "{}",
        "{}",
        "{}",
        null,
        now,
        now,
        null,
      )
      .run();
  } catch (error) {
    if (!isActiveOffboardingJobUniqueConstraintError(error)) throw error;
    const winner = await getActiveOffboardingJob(db, businessId);
    if (winner) return { job: winner, created: false };
    throw error;
  }

  const created = await getOffboardingJob(db, jobId);
  if (!created) throw new Error("Failed to create offboarding job manifest");
  return { job: created, created: true };
}

export async function getOffboardingJob(db: D1Database, jobId: string): Promise<OffboardingJob | null> {
  const row = await db
    .prepare("SELECT * FROM offboarding_jobs WHERE job_id = ? LIMIT 1")
    .bind(jobId)
    .first<OffboardingJobRow>();
  return row ? mapOffboardingJobRow(row) : null;
}

async function getActiveOffboardingJob(db: D1Database, businessId: string): Promise<OffboardingJob | null> {
  const row = await db
    .prepare(
      "SELECT * FROM offboarding_jobs WHERE business_id = ? AND phase NOT IN ('completed', 'failed') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(businessId)
    .first<OffboardingJobRow>();
  return row ? mapOffboardingJobRow(row) : null;
}

function isActiveOffboardingJobUniqueConstraintError(error: unknown): boolean {
  const parts = [stringifyError(error)];
  if (error instanceof Error && error.cause !== undefined && error.cause !== null) {
    parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
  }
  const message = parts.join(" ").toLowerCase();
  return (
    message.includes("unique constraint failed") &&
    (message.includes("idx_offboarding_jobs_active_business") || message.includes("offboarding_jobs.business_id"))
  );
}

export async function updateOffboardingJobProgress(
  db: D1Database,
  job: OffboardingJob,
  patch: {
    phase?: OffboardingJobPhase;
    stepMarkers?: Record<string, boolean>;
    tableCounts?: Record<string, number>;
    externalResults?: Record<string, unknown>;
    error?: Record<string, unknown> | null;
    completedAt?: number | null;
    now?: number;
  },
): Promise<OffboardingJob> {
  const now = patch.now ?? Date.now();
  const phase = patch.phase ?? job.phase;
  await db
    .prepare(
      `UPDATE offboarding_jobs
       SET phase = ?,
           step_markers_json = ?,
           table_counts_json = ?,
           external_results_json = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE job_id = ?`,
    )
    .bind(
      phase,
      JSON.stringify({ ...job.stepMarkers, ...(patch.stepMarkers ?? {}) }),
      JSON.stringify({ ...job.tableCounts, ...(patch.tableCounts ?? {}) }),
      JSON.stringify({ ...job.externalResults, ...(patch.externalResults ?? {}) }),
      patch.error === undefined
        ? job.error
          ? JSON.stringify(job.error)
          : null
        : patch.error
          ? JSON.stringify(patch.error)
          : null,
      now,
      patch.completedAt === undefined ? job.completedAt : patch.completedAt,
      job.jobId,
    )
    .run();
  const updated = await getOffboardingJob(db, job.jobId);
  if (!updated) throw new Error("Failed to update offboarding job manifest");
  return updated;
}

export type BusinessCascadeDeleteResult = {
  tableCounts: Record<string, number>;
  directBusinessTables: string[];
};

export type OffboardingTableExport = {
  table: string;
  rows: Array<Record<string, unknown>>;
};

export function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  if (
    identifier.startsWith("sqlite_") ||
    identifier.startsWith("_cf_") ||
    identifier.startsWith("_bak_") ||
    identifier === "d1_migrations"
  ) {
    throw new Error(`System SQL identifier is not allowed: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function deleteBusinessCascade(db: D1Database, job: OffboardingJob): Promise<BusinessCascadeDeleteResult> {
  const businessId = job.businessId.trim();
  if (!businessId) throw new Error("businessId is required");

  const tableCounts: Record<string, number> = {};
  await deleteByCapturedIds(db, tableCounts, OFFBOARDING_SESSION_ID_TABLES, job.capturedSessionIds);
  await deleteByCapturedIds(db, tableCounts, OFFBOARDING_USER_ID_TABLES, job.capturedUserIds);

  // Personal secrets use is_global=1 and business_id NULL. Delete only those rows for
  // captured users so repo-scoped env_blobs (is_global=0) authored by the same user survive.
  if (job.capturedUserIds.length > 0) {
    const placeholders = job.capturedUserIds.map(() => "?").join(", ");
    const personalSecretsResult = await db
      .prepare(`DELETE FROM env_blobs WHERE is_global = 1 AND owner_user_id IN (${placeholders})`)
      .bind(...job.capturedUserIds)
      .run();
    tableCounts.env_blobs_personal = (tableCounts.env_blobs_personal ?? 0) + (personalSecretsResult.meta?.changes ?? 0);
  }

  const directBusinessTables = await listDirectBusinessIdTables(db);
  if (directBusinessTables.length > 0) {
    const results = await db.batch(
      directBusinessTables.map((table) =>
        db.prepare(`DELETE FROM ${quoteSqlIdentifier(table)} WHERE business_id = ?`).bind(businessId),
      ),
    );
    directBusinessTables.forEach((table, index) => {
      tableCounts[table] = (tableCounts[table] ?? 0) + (results[index]?.meta?.changes ?? 0);
    });
  }

  // Explicit table->statement pairs so counts never rely on this batch staying
  // index-aligned with OFFBOARDING_ROOT_TABLES.
  const rootBatch: Array<{ table: string; statement: D1PreparedStatement }> = [
    {
      table: "session_index",
      statement: bindCapturedDelete(db, "session_index", "session_id", job.capturedSessionIds),
    },
    {
      table: "business_members",
      statement: db.prepare("DELETE FROM business_members WHERE business_id = ?").bind(businessId),
    },
    { table: "users", statement: bindCapturedDelete(db, "users", "id", job.capturedUserIds) },
    { table: "businesses", statement: db.prepare("DELETE FROM businesses WHERE id = ?").bind(businessId) },
  ];
  const rootResults = await db.batch(rootBatch.map((entry) => entry.statement));
  rootBatch.forEach((entry, index) => {
    tableCounts[entry.table] = (tableCounts[entry.table] ?? 0) + (rootResults[index]?.meta?.changes ?? 0);
  });

  return { tableCounts, directBusinessTables };
}

export async function readBusinessOffboardingRows(
  db: D1Database,
  job: OffboardingJob,
): Promise<OffboardingTableExport[]> {
  const exports = new Map<string, Array<Record<string, unknown>>>();
  await readRowsByCapturedIds(db, exports, OFFBOARDING_SESSION_ID_TABLES, job.capturedSessionIds);
  await readRowsByCapturedIds(db, exports, OFFBOARDING_USER_ID_TABLES, job.capturedUserIds);

  for (const table of await listDirectBusinessIdTables(db)) {
    const rows = await db
      .prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE business_id = ?`)
      .bind(job.businessId)
      .all<Record<string, unknown>>();
    appendRows(exports, table, rows.results ?? []);
  }

  const rootQueries = [
    {
      table: "session_index",
      statement: bindCapturedSelect(db, "session_index", "session_id", job.capturedSessionIds),
    },
    {
      table: "business_members",
      statement: db.prepare("SELECT * FROM business_members WHERE business_id = ?").bind(job.businessId),
    },
    { table: "users", statement: bindCapturedSelect(db, "users", "id", job.capturedUserIds) },
    { table: "businesses", statement: db.prepare("SELECT * FROM businesses WHERE id = ?").bind(job.businessId) },
  ];
  for (const query of rootQueries) {
    const rows = await query.statement.all<Record<string, unknown>>();
    appendRows(exports, query.table, rows.results ?? []);
  }

  return [...exports.entries()]
    .map(([table, rows]) => ({ table, rows }))
    .filter((entry) => entry.rows.length > 0)
    .sort((a, b) => a.table.localeCompare(b.table));
}

export async function listBusinesses(db: D1Database): Promise<Array<{ id: string; name: string; createdAt: number }>> {
  const result = await db
    .prepare("SELECT id, name, created_at FROM businesses ORDER BY name ASC")
    .all<{ id: string; name: string; created_at: number }>();
  return (result.results ?? []).map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

export async function searchAdminBusinesses(
  db: D1Database,
  options: { query?: string; limit: number; orderBy?: "createdAt" | "name" },
): Promise<AdminBusinessSummaryRecord[]> {
  const order = options.orderBy === "createdAt" ? "b.created_at DESC, b.id DESC" : "b.name COLLATE NOCASE ASC";
  const raw = options.query?.trim() ?? "";

  if (!raw) {
    const result = await db
      .prepare(
        `SELECT b.id, b.name, b.created_at,
                (SELECT COUNT(*) FROM business_members bm WHERE bm.business_id = b.id) AS member_count,
                (SELECT COUNT(*) FROM session_index s WHERE s.business_id = b.id) AS session_count,
                (SELECT MAX(s.created_at) FROM session_index s WHERE s.business_id = b.id) AS last_session_at
         FROM businesses b
         ORDER BY ${order}
         LIMIT ?`,
      )
      .bind(options.limit)
      .all<{
        id: string;
        name: string;
        created_at: number;
        member_count: number;
        session_count: number;
        last_session_at: number | null;
      }>();
    return (result.results ?? []).map(mapAdminBusinessSummaryRow);
  }

  const like = `%${escapeLike(raw)}%`;
  const result = await db
    .prepare(
      `SELECT b.id, b.name, b.created_at,
              (SELECT COUNT(*) FROM business_members bm WHERE bm.business_id = b.id) AS member_count,
              (SELECT COUNT(*) FROM session_index s WHERE s.business_id = b.id) AS session_count,
              (SELECT MAX(s.created_at) FROM session_index s WHERE s.business_id = b.id) AS last_session_at
       FROM businesses b
       WHERE b.name LIKE ? ESCAPE '\\'
          OR b.id LIKE ? ESCAPE '\\'
       ORDER BY ${order}
       LIMIT ?`,
    )
    .bind(like, like, options.limit)
    .all<{
      id: string;
      name: string;
      created_at: number;
      member_count: number;
      session_count: number;
      last_session_at: number | null;
    }>();
  return (result.results ?? []).map(mapAdminBusinessSummaryRow);
}

export async function createBusiness(db: D1Database, name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, now, now)
    .run();
  return id;
}

/**
 * Look up the business_id for a user via the business_members table.
 * Returns null if the user has no business membership.
 */
export async function getMemberBusinessId(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT business_id FROM business_members WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ business_id: string }>();
  return row?.business_id ?? null;
}

/**
 * Whether a business has opted into Codex bring-your-own-subscription (BYOS): the
 * ability to connect and use a personal ChatGPT/Codex `auth.json` as the OpenAI
 * model-provider credential, alongside BYOK. Per-business opt-in, default off
 * (ARC-1517). Returns false for a null/unknown business so callers fail closed.
 */
export async function isCodexByosEnabledForBusiness(db: D1Database, businessId: string | null): Promise<boolean> {
  if (!businessId) return false;
  const row = await db
    .prepare("SELECT codex_byos_enabled FROM businesses WHERE id = ? LIMIT 1")
    .bind(businessId)
    .first<{ codex_byos_enabled: number }>();
  return row?.codex_byos_enabled === 1;
}

export async function listBusinessMemberUserIds(db: D1Database, businessId: string): Promise<number[]> {
  const result = await db
    .prepare("SELECT user_id FROM business_members WHERE business_id = ? ORDER BY user_id ASC LIMIT 1000")
    .bind(businessId)
    .all<{ user_id: number }>();
  return (result.results ?? []).map((row) => row.user_id);
}

export async function getBusiness(db: D1Database, id: string): Promise<BusinessRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, name, shared_sessions, egress_allowlist_json,
              egress_allowlist_source_repo_owner, egress_allowlist_source_repo_name, created_at
       FROM businesses WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<BusinessRow>();
  return row ? mapBusinessRow(row, { includeEgressAllowlist: true }) : null;
}

export async function getBusinessForMember(db: D1Database, id: string, userId: number): Promise<BusinessRecord | null> {
  const row = await db
    .prepare(
      `SELECT b.id, b.name, b.shared_sessions, b.egress_allowlist_json,
              b.egress_allowlist_source_repo_owner, b.egress_allowlist_source_repo_name, b.created_at
       FROM businesses b
       INNER JOIN business_members bm ON bm.business_id = b.id
       WHERE b.id = ? AND bm.user_id = ?
       LIMIT 1`,
    )
    .bind(id, userId)
    .first<BusinessRow>();
  return row ? mapBusinessRow(row, { includeEgressAllowlist: false }) : null;
}

export async function getBusinessForAdmin(db: D1Database, id: string, userId: number): Promise<BusinessRecord | null> {
  const row = await db
    .prepare(
      `SELECT b.id, b.name, b.shared_sessions, b.egress_allowlist_json,
              b.egress_allowlist_source_repo_owner, b.egress_allowlist_source_repo_name, b.created_at
       FROM businesses b
       INNER JOIN business_members bm ON bm.business_id = b.id
       WHERE b.id = ? AND bm.user_id = ? AND bm.role = 'admin'
       LIMIT 1`,
    )
    .bind(id, userId)
    .first<BusinessRow>();
  return row ? mapBusinessRow(row, { includeEgressAllowlist: true }) : null;
}

/**
 * Enable or disable the `shared_sessions` flag for a business. Returns true if
 * a row was updated, false if no business matched `id`.
 */
export async function updateBusinessSharedSessions(
  db: D1Database,
  id: string,
  sharedSessions: boolean,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE businesses SET shared_sessions = ?, updated_at = ? WHERE id = ?")
    .bind(sharedSessions ? 1 : 0, Date.now(), id)
    .run();
  return d1Changed(result);
}

export async function getBusinessEgressPolicy(db: D1Database, id: string): Promise<BusinessEgressPolicy | null> {
  const row = await db
    .prepare("SELECT egress_allowlist_json FROM businesses WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ egress_allowlist_json: string | null }>();
  return parseBusinessEgressPolicy(row?.egress_allowlist_json ?? null);
}

export async function updateBusinessEgressPolicy(
  db: D1Database,
  id: string,
  policy: BusinessEgressPolicy | null,
): Promise<boolean> {
  const serialized = policy && policy.domains.length > 0 ? JSON.stringify(policy) : null;
  const result = await db
    .prepare("UPDATE businesses SET egress_allowlist_json = ?, updated_at = ? WHERE id = ?")
    .bind(serialized, Date.now(), id)
    .run();
  return d1Changed(result);
}

export async function getBusinessEgressAllowlistSource(
  db: D1Database,
  id: string,
): Promise<BusinessEgressAllowlistSource | null> {
  const row = await db
    .prepare(
      `SELECT egress_allowlist_source_repo_owner, egress_allowlist_source_repo_name
       FROM businesses WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<{ egress_allowlist_source_repo_owner: string | null; egress_allowlist_source_repo_name: string | null }>();
  return parseBusinessEgressAllowlistSource(row ?? null);
}

export async function updateBusinessEgressAllowlistSource(
  db: D1Database,
  id: string,
  source: BusinessEgressAllowlistSource | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE businesses
       SET egress_allowlist_source_repo_owner = ?,
           egress_allowlist_source_repo_name = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(source?.sourceRepoOwner ?? null, source?.sourceRepoName ?? null, Date.now(), id)
    .run();
  return d1Changed(result);
}

function mapBusinessRow(row: BusinessRow, options: { includeEgressAllowlist: boolean }): BusinessRecord {
  let egressAllowlist: string[] | null = null;
  let egressAllowlistSource: BusinessEgressAllowlistSource | null = null;

  if (options.includeEgressAllowlist) {
    try {
      egressAllowlist = parseBusinessEgressPolicy(row.egress_allowlist_json)?.domains ?? null;
    } catch {
      egressAllowlist = null;
    }
    egressAllowlistSource = parseBusinessEgressAllowlistSource(row);
  }
  return {
    id: row.id,
    name: row.name,
    sharedSessions: row.shared_sessions === 1,
    egressAllowlist,
    egressAllowlistSource,
    createdAt: row.created_at,
  };
}

function parseBusinessEgressAllowlistSource(
  row: {
    egress_allowlist_source_repo_owner: string | null;
    egress_allowlist_source_repo_name: string | null;
  } | null,
): BusinessEgressAllowlistSource | null {
  const owner = row?.egress_allowlist_source_repo_owner?.trim();
  const name = row?.egress_allowlist_source_repo_name?.trim();
  return owner && name ? { sourceRepoOwner: owner, sourceRepoName: name } : null;
}

function parseBusinessEgressPolicy(value: string | null): BusinessEgressPolicy | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored business egress policy must be valid JSON");
  }
  return normalizeBusinessEgressPolicy(parsed, "stored business egress policy");
}

function mapAdminBusinessSummaryRow(row: {
  id: string;
  name: string;
  created_at: number;
  member_count: number;
  session_count: number;
  last_session_at: number | null;
}): AdminBusinessSummaryRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    memberCount: row.member_count,
    sessionCount: row.session_count,
    lastSessionAt: row.last_session_at,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function mapOffboardingJobRow(row: OffboardingJobRow): OffboardingJob {
  return {
    jobId: row.job_id,
    businessId: row.business_id,
    archiveKey: row.archive_key,
    capturedUserIds: parseJsonArray<number>(row.captured_user_ids_json, "captured_user_ids_json"),
    capturedSessionIds: parseJsonArray<string>(row.captured_session_ids_json, "captured_session_ids_json"),
    phase: parseOffboardingJobPhase(row.phase),
    stepMarkers: parseJsonObject<boolean>(row.step_markers_json, "step_markers_json"),
    tableCounts: parseJsonObject<number>(row.table_counts_json, "table_counts_json"),
    externalResults: parseJsonObject<unknown>(row.external_results_json, "external_results_json"),
    error: row.error_json ? parseJsonObject<unknown>(row.error_json, "error_json") : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function parseOffboardingJobPhase(value: string): OffboardingJobPhase {
  const phases = new Set<OffboardingJobPhase>([
    "captured",
    "exported",
    "durable_objects_purged",
    "external_cleanup_finished",
    "s3_artifacts_deleted",
    "db_purged",
    "completed",
    "failed",
  ]);
  if (!phases.has(value as OffboardingJobPhase)) {
    throw new Error(`Unknown offboarding job phase: ${value}`);
  }
  return value as OffboardingJobPhase;
}

function parseJsonArray<T>(value: string, field: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return parsed as T[];
}

function parseJsonObject<T>(value: string, field: string): Record<string, T> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as Record<string, T>;
}

async function deleteByCapturedIds<T extends string | number>(
  db: D1Database,
  tableCounts: Record<string, number>,
  entries: ReadonlyArray<{ table: string; column: string }>,
  ids: readonly T[],
): Promise<void> {
  if (ids.length === 0) return;
  const existingEntries = await filterExistingColumnEntries(db, entries);
  const statements = existingEntries.map(({ table, column }) => bindCapturedDelete(db, table, column, ids));
  // D1 rejects an empty batch; every entry can be filtered out if the schema no
  // longer has the expected columns.
  if (statements.length === 0) return;
  const results = await db.batch(statements);
  existingEntries.forEach(({ table }, index) => {
    tableCounts[table] = (tableCounts[table] ?? 0) + (results[index]?.meta?.changes ?? 0);
  });
}

async function filterExistingColumnEntries(
  db: D1Database,
  entries: ReadonlyArray<{ table: string; column: string }>,
): Promise<Array<{ table: string; column: string }>> {
  const filtered: Array<{ table: string; column: string }> = [];
  for (const entry of entries) {
    const tableName = quoteSqlIdentifier(entry.table);
    const columns = await db.prepare(`PRAGMA table_info(${tableName})`).all<{ name: string }>();
    if ((columns.results ?? []).some((column) => column.name === entry.column)) filtered.push(entry);
  }
  return filtered;
}

function bindCapturedDelete<T extends string | number>(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly T[],
): D1PreparedStatement {
  if (ids.length === 0) {
    return db.prepare(`DELETE FROM ${quoteSqlIdentifier(table)} WHERE 1 = 0`);
  }
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(`DELETE FROM ${quoteSqlIdentifier(table)} WHERE ${quoteSqlIdentifier(column)} IN (${placeholders})`)
    .bind(...ids);
}

function bindCapturedSelect<T extends string | number>(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly T[],
): D1PreparedStatement {
  if (ids.length === 0) {
    return db.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE 1 = 0`);
  }
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE ${quoteSqlIdentifier(column)} IN (${placeholders})`)
    .bind(...ids);
}

async function readRowsByCapturedIds<T extends string | number>(
  db: D1Database,
  exports: Map<string, Array<Record<string, unknown>>>,
  entries: ReadonlyArray<{ table: string; column: string }>,
  ids: readonly T[],
): Promise<void> {
  if (ids.length === 0) return;
  for (const entry of await filterExistingColumnEntries(db, entries)) {
    const rows = await bindCapturedSelect(db, entry.table, entry.column, ids).all<Record<string, unknown>>();
    appendRows(exports, entry.table, rows.results ?? []);
  }
}

function appendRows(
  exports: Map<string, Array<Record<string, unknown>>>,
  table: string,
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) return;
  const existing = exports.get(table) ?? [];
  const seen = new Set(existing.map(stableRowKey));
  for (const row of rows) {
    const key = stableRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(row);
  }
  exports.set(table, existing);
}

function stableRowKey(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => [key, row[key]]),
  );
}

async function listDirectBusinessIdTables(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND name NOT LIKE '_bak_%'
         AND name != 'd1_migrations'
       ORDER BY name ASC`,
    )
    .all<{ name: string }>();
  const directTables: string[] = [];
  for (const row of result.results ?? []) {
    if (OFFBOARDING_DYNAMIC_BUSINESS_ID_EXCLUDED_TABLES.has(row.name)) continue;
    quoteSqlIdentifier(row.name);
    const pragma = await db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(row.name)})`).all<{ name: string }>();
    if ((pragma.results ?? []).some((column) => column.name === "business_id")) {
      directTables.push(row.name);
    }
  }
  return directTables;
}
