import { d1Changed } from "../db/errors";
import { computeSha256Hex } from "../utils";

const RECONCILE_BATCH_LIMIT = 50;

export interface RepoMemoryTargetRow {
  owner: string;
  name: string;
}

export interface ActiveMemoryFactForReconciliationRow {
  id: string;
  business_id: string;
  kind: string;
  claim: string;
  holder: string;
  source_event_id: string;
  source_time_ms: number;
  source_uri: string;
  effective_at_ms: number | null;
  valid_until_ms: number | null;
  created_at_ms: number;
}

export async function expirePastValidFacts(db: D1Database, businessId: string, nowMs: number): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT id, claim, source_event_id, valid_until_ms
       FROM memory_facts
       WHERE business_id = ? AND status = 'active' AND valid_until_ms IS NOT NULL AND valid_until_ms <= ?
       LIMIT ?`,
    )
    .bind(businessId, nowMs, RECONCILE_BATCH_LIMIT)
    .all<{ id: string; claim: string; source_event_id: string; valid_until_ms: number }>();
  if (rows.results.length === 0) return 0;
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    statements.push(
      db
        .prepare(
          `UPDATE memory_facts
           SET status = 'expired', expired_at_ms = ?
           WHERE business_id = ? AND id = ? AND status = 'active'`,
        )
        .bind(nowMs, businessId, row.id),
      await candidateInsertStatement(db, {
        businessId,
        candidateType: "d1_expiration",
        status: "applied",
        primaryMemoryId: row.id,
        secondaryMemoryId: null,
        proposedAction: "expire_d1",
        rationale: "Memory valid_until_ms is in the past.",
        evidenceJson: JSON.stringify({
          primary_memory_id: row.id,
          valid_until_ms: row.valid_until_ms,
          source_event_id: row.source_event_id,
        }),
        nowMs,
      }),
    );
  }
  await db.batch(statements);
  return rows.results.length;
}

export async function listActiveFactsForReconciliation(
  db: D1Database,
  businessId: string,
  limit: number,
): Promise<ActiveMemoryFactForReconciliationRow[]> {
  const safeLimit = Math.max(2, Math.min(200, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT f.id, f.business_id, f.kind, f.claim, f.holder, f.source_event_id,
              e.source_time_ms, e.source_uri, f.effective_at_ms, f.valid_until_ms, f.created_at_ms
       FROM memory_facts f
       JOIN ingestion_events e ON e.id = f.source_event_id AND e.business_id = f.business_id
       WHERE f.business_id = ?
         AND f.status = 'active'
         AND f.kind IN ('decision','constraint','preference','fact')
       ORDER BY f.kind ASC, f.holder ASC, e.source_time_ms ASC, f.created_at_ms ASC
       LIMIT ?`,
    )
    .bind(businessId, safeLimit)
    .all<ActiveMemoryFactForReconciliationRow>();
  return result.results;
}

export async function listActiveFactsForRepoReconciliation(
  db: D1Database,
  businessId: string,
  owner: string,
  repo: string,
  limit: number,
): Promise<ActiveMemoryFactForReconciliationRow[]> {
  const repoScopeId = `${owner}/${repo}`;
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT f.id, f.business_id, f.kind, f.claim, f.holder, f.source_event_id,
              e.source_time_ms, e.source_uri, f.effective_at_ms, f.valid_until_ms, f.created_at_ms
       FROM memory_facts f
       JOIN ingestion_events e ON e.id = f.source_event_id AND e.business_id = f.business_id
       WHERE f.business_id = ?
         AND f.status = 'active'
         AND f.kind IN ('decision','constraint','preference','fact')
         AND (
           f.holder = ? OR f.holder = ?
           OR (e.scope_type = 'repo' AND e.scope_id = ?)
         )
       ORDER BY e.source_time_ms DESC, f.created_at_ms DESC
       LIMIT ?`,
    )
    .bind(businessId, repoScopeId, `repo:${repoScopeId}`, repoScopeId, safeLimit)
    .all<ActiveMemoryFactForReconciliationRow>();
  return result.results;
}

export async function listRecentRepoMemoryTargets(
  db: D1Database,
  businessId: string,
  limit: number,
): Promise<RepoMemoryTargetRow[]> {
  const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT repo_owner, repo_name, MAX(used_at) AS last_used_at
       FROM memory_usage_events
       WHERE repo_owner IS NOT NULL
         AND repo_name IS NOT NULL
         AND session_id IN (SELECT session_id FROM session_index WHERE business_id = ?)
       GROUP BY repo_owner, repo_name
       ORDER BY last_used_at DESC
       LIMIT ?`,
    )
    .bind(businessId, safeLimit)
    .all<{ repo_owner: string; repo_name: string }>();
  return rows.results
    .map((row) => ({ owner: row.repo_owner?.trim(), name: row.repo_name?.trim() }))
    .filter((row): row is RepoMemoryTargetRow => Boolean(row.owner && row.name));
}

export async function supersedeOlderFact(
  db: D1Database,
  input: {
    businessId: string;
    older: ActiveMemoryFactForReconciliationRow;
    newer: ActiveMemoryFactForReconciliationRow;
    adjudication: { rationale: string };
    evidenceJson: string;
    nowMs: number;
  },
): Promise<boolean> {
  const auditStatement = await candidateInsertStatement(db, {
    businessId: input.businessId,
    candidateType: "d1_supersession",
    status: "applied",
    primaryMemoryId: input.older.id,
    secondaryMemoryId: input.newer.id,
    proposedAction: "supersede_older_d1",
    rationale: input.adjudication.rationale,
    evidenceJson: input.evidenceJson,
    nowMs: input.nowMs,
  });
  const result = await db.batch([
    db
      .prepare(
        `UPDATE memory_facts
         SET status = 'superseded', superseded_by = ?, expired_at_ms = ?
         WHERE business_id = ? AND id = ? AND status = 'active'`,
      )
      .bind(input.newer.id, input.nowMs, input.businessId, input.older.id),
    auditStatement,
  ]);
  return d1Changed(result[0]);
}

async function candidateInsertStatement(
  db: D1Database,
  input: {
    businessId: string;
    candidateType: "d1_expiration" | "d1_supersession";
    status: "applied";
    primaryMemoryId: string;
    secondaryMemoryId: string | null;
    proposedAction: "expire_d1" | "supersede_older_d1";
    rationale: string;
    evidenceJson: string;
    nowMs: number;
  },
): Promise<D1PreparedStatement> {
  const idempotencyKey = await computeSha256Hex(
    [
      input.businessId,
      input.candidateType,
      "d1",
      input.primaryMemoryId,
      input.secondaryMemoryId ?? "",
      input.proposedAction,
    ].join("\u001f"),
  );
  return db
    .prepare(
      `INSERT OR IGNORE INTO memory_review_candidates
       (id, business_id, candidate_type, status, primary_store, primary_memory_id,
        secondary_store, secondary_memory_id, proposed_action, rationale, evidence_json,
        idempotency_key, resolved_at_ms)
       VALUES (?, ?, ?, ?, 'd1', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `mrc_${idempotencyKey.slice(0, 32)}`,
      input.businessId,
      input.candidateType,
      input.status,
      input.primaryMemoryId,
      input.secondaryMemoryId ? "d1" : null,
      input.secondaryMemoryId,
      input.proposedAction,
      input.rationale.slice(0, 2_000),
      input.evidenceJson.slice(0, 8_000),
      idempotencyKey,
      input.nowMs,
    );
}
