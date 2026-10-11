import { computeSha256Hex, normalizeWebhookReference } from "../utils";

export type MemoryReviewCandidateType =
  "d1_supersession" | "d1_contradiction" | "d1_expiration" | "repo_pr_needed" | "cross_store_conflict" | "duplicate";
export type MemoryReviewStatus = "pending" | "applied" | "approved" | "rejected" | "dismissed";
export type MemoryStore = "d1" | "repo";
export type MemoryReviewAction =
  "expire_d1" | "reject_d1" | "supersede_older_d1" | "create_repo_memory_pr" | "manual_review" | "no_action";

export interface MemoryReviewCandidateInput {
  businessId: string;
  candidateType: MemoryReviewCandidateType;
  status?: MemoryReviewStatus;
  primaryStore: MemoryStore;
  primaryMemoryId: string;
  secondaryStore?: MemoryStore | null;
  secondaryMemoryId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repoMemoryPath?: string | null;
  proposedAction: MemoryReviewAction;
  rationale: string;
  evidenceJson: string;
  resolvedByUserId?: number | null;
}

export interface MemoryReviewCandidateRow {
  id: string;
  businessId: string;
  candidateType: MemoryReviewCandidateType;
  status: MemoryReviewStatus;
  primaryStore: MemoryStore;
  primaryMemoryId: string;
  secondaryStore: MemoryStore | null;
  secondaryMemoryId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoMemoryPath: string | null;
  proposedAction: MemoryReviewAction;
  rationale: string;
  evidenceJson: string;
  idempotencyKey: string;
  createdAtMs: number;
  resolvedAtMs: number | null;
  resolvedByUserId: number | null;
}

interface MemoryReviewCandidateDbRow {
  id: string;
  business_id: string;
  candidate_type: MemoryReviewCandidateType;
  status: MemoryReviewStatus;
  primary_store: MemoryStore;
  primary_memory_id: string;
  secondary_store: MemoryStore | null;
  secondary_memory_id: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_memory_path: string | null;
  proposed_action: MemoryReviewAction;
  rationale: string;
  evidence_json: string;
  idempotency_key: string;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolved_by_user_id: number | null;
}

export interface ListMemoryReviewCandidatesInput {
  businessId: string;
  status?: MemoryReviewStatus | null;
  source?: "d1" | "repo" | "cross_store" | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface PaginatedMemoryReviewCandidates {
  candidates: MemoryReviewCandidateRow[];
  nextCursor: string | null;
}

export interface ResolveMemoryReviewCandidateInput {
  businessId: string;
  id: string;
  action: "approve" | "reject" | "dismiss";
  resolvedByUserId: number | null;
}

function requireBusinessId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("business_id is required");
  return normalized;
}

function requiredString(value: string, field: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized.slice(0, maxChars);
}

function optionalString(value: string | null | undefined, maxChars: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function rowToCandidate(row: MemoryReviewCandidateDbRow): MemoryReviewCandidateRow {
  return {
    id: row.id,
    businessId: row.business_id,
    candidateType: row.candidate_type,
    status: row.status,
    primaryStore: row.primary_store,
    primaryMemoryId: row.primary_memory_id,
    secondaryStore: row.secondary_store,
    secondaryMemoryId: row.secondary_memory_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoMemoryPath: row.repo_memory_path,
    proposedAction: row.proposed_action,
    rationale: row.rationale,
    evidenceJson: row.evidence_json,
    idempotencyKey: row.idempotency_key,
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms,
    resolvedByUserId: row.resolved_by_user_id,
  };
}

function parseCandidatesCursor(value: string | null): { createdAtMs: number; id: string } | null {
  const normalized = normalizeWebhookReference(value);
  if (!normalized) return null;
  const separator = normalized.indexOf(":");
  if (separator <= 0) return null;
  const createdAtMs = Number(normalized.slice(0, separator));
  const id = normalized.slice(separator + 1);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || !id) return null;
  return { createdAtMs, id };
}

function encodeCandidatesCursor(row: MemoryReviewCandidateRow): string {
  return `${row.createdAtMs}:${row.id}`;
}

// The key identifies the underlying conflict by its deterministic memory pair.
// Deliberately excludes candidateType and proposedAction: both are derived from
// non-deterministic LLM adjudication (reconcile.ts), so including them would make
// the same conflict hash to different keys when the LLM flips, inserting duplicate
// zombie candidates (ARC-1554). primaryStore/primaryMemoryId/secondaryStore/
// secondaryMemoryId are derived deterministically from sourceTimeMs ordering, so
// the pair is a stable identity; both LLM-derived fields are refreshed on conflict.
export async function buildMemoryReviewIdempotencyKey(input: {
  businessId: string;
  primaryStore: MemoryStore;
  primaryMemoryId: string;
  secondaryStore?: MemoryStore | null;
  secondaryMemoryId?: string | null;
}): Promise<string> {
  return computeSha256Hex(
    [
      input.businessId,
      input.primaryStore,
      input.primaryMemoryId,
      input.secondaryStore ?? "",
      input.secondaryMemoryId ?? "",
    ].join("\u001f"),
  );
}

export async function upsertMemoryReviewCandidate(
  db: D1Database,
  input: MemoryReviewCandidateInput,
): Promise<MemoryReviewCandidateRow> {
  const businessId = requireBusinessId(input.businessId);
  const primaryMemoryId = requiredString(input.primaryMemoryId, "primary_memory_id", 200);
  const secondaryMemoryId = optionalString(input.secondaryMemoryId, 200);
  const idempotencyKey = await buildMemoryReviewIdempotencyKey({
    businessId,
    primaryStore: input.primaryStore,
    primaryMemoryId,
    secondaryStore: input.secondaryStore,
    secondaryMemoryId,
  });
  const id = `mrc_${idempotencyKey.slice(0, 32)}`;
  const status = input.status ?? "pending";
  const resolvedAtMs = status === "applied" || status === "approved" ? Date.now() : null;
  await db
    .prepare(
      `INSERT INTO memory_review_candidates
       (id, business_id, candidate_type, status, primary_store, primary_memory_id,
        secondary_store, secondary_memory_id, repo_owner, repo_name, repo_memory_path,
        proposed_action, rationale, evidence_json, idempotency_key, resolved_at_ms, resolved_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, idempotency_key) DO UPDATE SET
         candidate_type = excluded.candidate_type,
         proposed_action = excluded.proposed_action,
         rationale = excluded.rationale,
         evidence_json = excluded.evidence_json,
         repo_owner = COALESCE(excluded.repo_owner, memory_review_candidates.repo_owner),
         repo_name = COALESCE(excluded.repo_name, memory_review_candidates.repo_name),
         repo_memory_path = COALESCE(excluded.repo_memory_path, memory_review_candidates.repo_memory_path)`,
    )
    .bind(
      id,
      businessId,
      input.candidateType,
      status,
      input.primaryStore,
      primaryMemoryId,
      input.secondaryStore ?? null,
      secondaryMemoryId,
      optionalString(input.repoOwner, 100),
      optionalString(input.repoName, 100),
      optionalString(input.repoMemoryPath, 500),
      input.proposedAction,
      requiredString(input.rationale, "rationale", 2_000),
      requiredString(input.evidenceJson, "evidence_json", 8_000),
      idempotencyKey,
      resolvedAtMs,
      input.resolvedByUserId ?? null,
    )
    .run();
  const row = await getMemoryReviewCandidate(db, businessId, id);
  if (!row) throw new Error("Failed to upsert memory review candidate");
  return row;
}

export async function listMemoryReviewCandidates(
  db: D1Database,
  input: ListMemoryReviewCandidatesInput,
): Promise<PaginatedMemoryReviewCandidates> {
  const businessId = requireBusinessId(input.businessId);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const cursor = parseCandidatesCursor(input.cursor ?? null);
  const status = input.status ?? null;
  const source = input.source ?? null;
  const crossStoreOnly = source === "cross_store" ? 1 : null;
  const storeSource = source === "d1" || source === "repo" ? source : null;
  const rows = await db
    .prepare(
      `SELECT *
       FROM memory_review_candidates
       WHERE business_id = ?
         AND (? IS NULL OR status = ?)
         AND (? IS NULL OR primary_store = ? OR secondary_store = ?)
         AND (? IS NULL OR (primary_store IS NOT NULL AND secondary_store IS NOT NULL AND primary_store != secondary_store))
         AND (? IS NULL OR created_at_ms < ? OR (created_at_ms = ? AND id < ?))
       ORDER BY created_at_ms DESC, id DESC
       LIMIT ?`,
    )
    .bind(
      businessId,
      status,
      status,
      storeSource,
      storeSource,
      storeSource,
      crossStoreOnly,
      cursor?.createdAtMs ?? null,
      cursor?.createdAtMs ?? null,
      cursor?.createdAtMs ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<MemoryReviewCandidateDbRow>();
  const candidates = rows.results.map(rowToCandidate);
  if (candidates.length <= limit) return { candidates, nextCursor: null };
  const selected = candidates.slice(0, limit);
  return { candidates: selected, nextCursor: encodeCandidatesCursor(selected[selected.length - 1]) };
}

export async function getMemoryReviewCandidate(
  db: D1Database,
  businessId: string,
  id: string,
): Promise<MemoryReviewCandidateRow | null> {
  const row = await db
    .prepare("SELECT * FROM memory_review_candidates WHERE business_id = ? AND id = ? LIMIT 1")
    .bind(requireBusinessId(businessId), requiredString(id, "id", 200))
    .first<MemoryReviewCandidateDbRow>();
  return row ? rowToCandidate(row) : null;
}

export async function resolveMemoryReviewCandidate(
  db: D1Database,
  input: ResolveMemoryReviewCandidateInput,
): Promise<MemoryReviewCandidateRow | null> {
  const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "dismissed";
  const row = await db
    .prepare(
      `UPDATE memory_review_candidates
       SET status = ?, resolved_at_ms = unixepoch() * 1000, resolved_by_user_id = ?
       WHERE business_id = ? AND id = ? AND status = 'pending'
       RETURNING *`,
    )
    .bind(status, input.resolvedByUserId, requireBusinessId(input.businessId), requiredString(input.id, "id", 200))
    .first<MemoryReviewCandidateDbRow>();
  return row ? rowToCandidate(row) : null;
}

// Reserved sentinel row in memory_reconciliation_cursors that stores the
// round-robin scheduler position. business_id can never collide with a real
// business (generated IDs never equal this literal) and the row has no
// memory_facts, so the due-query never returns it. cursor_type='d1' with empty
// repo owner/name satisfies the PK and the cursor_type CHECK. last_scanned_at_ms
// is required but never read for gating on this row.
const SCHEDULER_CURSOR_BUSINESS_ID = "__scheduler__";
const SCHEDULER_CURSOR_TYPE = "d1" as const;

export async function listBusinessesDueForMemoryReconciliation(
  db: D1Database,
  input: { nowMs: number; recurrenceIntervalMs: number; afterBusinessId: string; limit: number },
): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(input.limit)));
  const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, Math.floor(input.nowMs)) : Date.now();
  const recurrenceIntervalMs = Number.isFinite(input.recurrenceIntervalMs)
    ? Math.max(0, Math.floor(input.recurrenceIntervalMs))
    : 0;
  // Interval gate via LEFT JOIN on the per-business 'd1' cursor (a business is
  // due when it has never been scanned or its last scan is older than the
  // interval); round-robin via business_id > afterBusinessId.
  const rows = await db
    .prepare(
      `SELECT mf.business_id AS business_id
       FROM (SELECT DISTINCT business_id FROM memory_facts WHERE status = 'active') mf
       LEFT JOIN memory_reconciliation_cursors c
         ON c.business_id = mf.business_id
        AND c.cursor_type = 'd1' AND c.repo_owner = '' AND c.repo_name = ''
       WHERE mf.business_id > ?
         AND (c.last_scanned_at_ms IS NULL OR (? - c.last_scanned_at_ms) > ?)
       ORDER BY mf.business_id ASC
       LIMIT ?`,
    )
    .bind(input.afterBusinessId, nowMs, recurrenceIntervalMs, safeLimit)
    .all<{ business_id: string }>();
  return rows.results.map((row) => row.business_id).filter(Boolean);
}

/**
 * Read the round-robin scheduler position. Fails soft: a missing row, malformed
 * JSON, or missing field is treated as "start from the beginning" (empty
 * afterBusinessId) so a bad row cannot crash every cron tick. `rawCursorJson` is
 * the exact stored value, used for the compare-and-swap advance.
 */
export async function getSchedulerRoundRobinCursor(
  db: D1Database,
): Promise<{ lastBusinessId: string; rawCursorJson: string | null }> {
  const row = await db
    .prepare(
      `SELECT cursor_json
       FROM memory_reconciliation_cursors
       WHERE business_id = ? AND cursor_type = ? AND repo_owner = '' AND repo_name = ''
       LIMIT 1`,
    )
    .bind(SCHEDULER_CURSOR_BUSINESS_ID, SCHEDULER_CURSOR_TYPE)
    .first<{ cursor_json: string | null }>();
  if (!row) return { lastBusinessId: "", rawCursorJson: null };
  const rawCursorJson = row.cursor_json;
  if (!rawCursorJson) return { lastBusinessId: "", rawCursorJson };
  try {
    const parsed = JSON.parse(rawCursorJson) as { last_business_id?: unknown };
    const lastBusinessId = typeof parsed.last_business_id === "string" ? parsed.last_business_id : "";
    return { lastBusinessId, rawCursorJson };
  } catch {
    // Keep the raw value so the CAS advance can replace the bad row.
    return { lastBusinessId: "", rawCursorJson };
  }
}

/**
 * Advance the round-robin scheduler position with a compare-and-swap on the
 * stored cursor_json, so an overlapping cron tick that read a stale position
 * cannot double-advance. No-ops silently when the CAS does not match.
 */
export async function advanceSchedulerRoundRobinCursor(
  db: D1Database,
  input: { expectedCursorJson: string | null; lastBusinessId: string; nowMs: number },
): Promise<void> {
  const lastScannedAtMs = Number.isFinite(input.nowMs) ? Math.max(0, Math.floor(input.nowMs)) : Date.now();
  const cursorJson = JSON.stringify({ last_business_id: input.lastBusinessId });
  await db
    .prepare(
      `INSERT INTO memory_reconciliation_cursors
       (business_id, cursor_type, repo_owner, repo_name, cursor_json, last_scanned_at_ms)
       VALUES (?, ?, '', '', ?, ?)
       ON CONFLICT(business_id, cursor_type, repo_owner, repo_name) DO UPDATE SET
         cursor_json = excluded.cursor_json,
         last_scanned_at_ms = excluded.last_scanned_at_ms
       WHERE memory_reconciliation_cursors.cursor_json IS ?`,
    )
    .bind(SCHEDULER_CURSOR_BUSINESS_ID, SCHEDULER_CURSOR_TYPE, cursorJson, lastScannedAtMs, input.expectedCursorJson)
    .run();
}

export async function upsertMemoryReconciliationCursor(
  db: D1Database,
  input: {
    businessId: string;
    cursorType: "d1" | "repo" | "cross_store";
    repoOwner?: string | null;
    repoName?: string | null;
    cursorJson?: string | null;
    lastScannedAtMs: number;
  },
): Promise<void> {
  // The '__scheduler__' sentinel row stores the round-robin scheduler position
  // (cursor_type='d1', empty repo owner/name). A per-business cursor write with
  // that businessId would collide on the PK and overwrite the scheduler's
  // last_business_id, so reject it; no real business uses this reserved id.
  if (requireBusinessId(input.businessId) === SCHEDULER_CURSOR_BUSINESS_ID) {
    throw new Error("business_id is reserved");
  }
  const lastScannedAtMs = Number.isFinite(input.lastScannedAtMs)
    ? Math.max(0, Math.floor(input.lastScannedAtMs))
    : Date.now();
  await db
    .prepare(
      `INSERT INTO memory_reconciliation_cursors
       (business_id, cursor_type, repo_owner, repo_name, cursor_json, last_scanned_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id, cursor_type, repo_owner, repo_name) DO UPDATE SET
         cursor_json = excluded.cursor_json,
         last_scanned_at_ms = excluded.last_scanned_at_ms`,
    )
    .bind(
      requireBusinessId(input.businessId),
      input.cursorType,
      optionalString(input.repoOwner, 100) ?? "",
      optionalString(input.repoName, 100) ?? "",
      optionalString(input.cursorJson, 8_000),
      lastScannedAtMs,
    )
    .run();
}
