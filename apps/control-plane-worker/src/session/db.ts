import { displayStatusFromPhase } from "../../../../shared/session/display-status.js";
import type { BlockedReason, FailureReason, FsmState } from "../../../../shared/session/lifecycle-chip.js";
import { isBlockedReason, isFailureReason, isFsmState } from "../../../../shared/session/lifecycle-chip.js";
import type { UiLifecycleStage } from "../../../../shared/session/lifecycle-stage.js";
import { normalizeUiLifecycleStage } from "../../../../shared/session/lifecycle-stage.js";
import type {
  CycloidDoneStatus,
  Phase,
  ReviewLoopDoneState,
  VerificationState,
} from "../../../../shared/session/phase.js";
import {
  normalizeCycloidDoneOutcome,
  normalizeCycloidDoneReasons,
  normalizeCycloidDoneState,
  normalizeReviewLoopDoneState,
  qaTestingStateFromVerificationState,
  TERMINAL_PHASES_ARRAY,
  verificationStateFromQaTestingState,
} from "../../../../shared/session/phase.js";
import type { PublishStage, PublishStatus } from "../../../../shared/types/publish.js";
import type {
  SandboxRuntimeBackend,
  SandboxRuntimeProvider,
  SandboxRuntimeState,
} from "../../../../shared/types/sandbox.js";
import { businessIdsMatch, isInternalCycloidBusinessId } from "../constants/businesses";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../constants/verification";
import { InitiationMode, parseInitiationMode } from "../enums/initiation-mode.js";
import { parseSessionEntrypoint } from "../enums/session-entrypoint.js";
import {
  parsePersistedRuntimeBackendOrNull,
  runtimeBackendOrNull,
  runtimeProviderOrNull,
  runtimeStateOrNull,
} from "../sandbox/runtime-backend";
import type { AuthInfo, ReplayState, SessionState } from "../types";
import { resolveRequiredBusinessId } from "./business-id";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
export const ACTIVE_SESSION_CAP_EXCLUDED_PHASES = [
  ...TERMINAL_PHASES_ARRAY,
  "review_listening",
] as const satisfies ReadonlyArray<Phase>;
// Home prewarm can create a real session row before any prompt is sent.
// Keep those empty shells out of normal list surfaces.
const SESSION_HAS_USER_VISIBLE_WORK_SQL = `(
  s.title IS NOT NULL
  OR EXISTS (SELECT 1 FROM prompt_runs pr WHERE pr.session_id = s.session_id)
  OR EXISTS (SELECT 1 FROM session_completions sc WHERE sc.session_id = s.session_id)
)`;

function buildInsertValuesSql(params: {
  table: string;
  columns: string[];
  values: string[];
  onConflict: string;
}): string {
  const { table, columns, values, onConflict } = params;
  if (columns.length !== values.length) {
    throw new Error(`Invalid INSERT for ${table}: ${columns.length} columns but ${values.length} values expressions`);
  }
  return `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${values.join(", ")})
       ${onConflict}`;
}

// Parent/child fields (parent_session_id, parent_prompt_id, spawned_by_user_id,
// spawn_depth) use COALESCE on UPDATE so that whichever upsert provides a
// non-null value wins regardless of ordering, and subsequent upserts that
// don't carry parent context preserve the existing values. spawn_depth uses a
// CASE because 0 is the legitimate default for non-child rows; we treat any
// positive value as "the canonical depth, don't downgrade".
// initiation_mode is INSERT-only on the upsert: it's set at session create and
// must never be downgraded by later projection writes that lack the field.
// scheduled_rule_id / rule_name_snapshot / cron_snapshot are likewise written
// once at create and preserved (COALESCE) on subsequent upserts.
export const UPSERT_SESSION_INDEX_SQL = buildInsertValuesSql({
  table: "session_index",
  columns: [
    "session_id",
    "owner_user_id",
    "business_id",
    "status",
    "created_at",
    "updated_at",
    "closed_at",
    "last_event_id",
    "title",
    "title_tags",
    "rich_status",
    "model",
    "reasoning_effort",
    "agent_runtime_backend",
    "agent_role",
    "target_pr_url",
    "installation_id",
    "repo_owner",
    "repo_name",
    "callback_context_json",
    "parent_session_id",
    "parent_prompt_id",
    "spawned_by_user_id",
    "spawn_depth",
    "initiation_mode",
    "entrypoint",
    "scheduled_rule_id",
    "rule_name_snapshot",
    "cron_snapshot",
  ],
  values: [
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
    "?",
  ],
  onConflict: `ON CONFLICT(session_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         business_id = COALESCE(session_index.business_id, excluded.business_id),
         status = excluded.status,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at,
         last_event_id = excluded.last_event_id,
         title = excluded.title,
         title_tags = excluded.title_tags,
         rich_status = COALESCE(excluded.rich_status, session_index.rich_status),
         model = COALESCE(excluded.model, session_index.model),
         reasoning_effort = COALESCE(excluded.reasoning_effort, session_index.reasoning_effort),
         agent_runtime_backend = COALESCE(excluded.agent_runtime_backend, session_index.agent_runtime_backend),
         agent_role = excluded.agent_role,
         target_pr_url = excluded.target_pr_url,
         installation_id = COALESCE(excluded.installation_id, session_index.installation_id),
         repo_owner = COALESCE(excluded.repo_owner, session_index.repo_owner),
         repo_name = COALESCE(excluded.repo_name, session_index.repo_name),
         callback_context_json = COALESCE(excluded.callback_context_json, session_index.callback_context_json),
         parent_session_id = COALESCE(excluded.parent_session_id, session_index.parent_session_id),
         parent_prompt_id = COALESCE(excluded.parent_prompt_id, session_index.parent_prompt_id),
         spawned_by_user_id = COALESCE(excluded.spawned_by_user_id, session_index.spawned_by_user_id),
         spawn_depth = CASE WHEN excluded.spawn_depth > 0 THEN excluded.spawn_depth ELSE session_index.spawn_depth END,
         scheduled_rule_id = COALESCE(session_index.scheduled_rule_id, excluded.scheduled_rule_id),
         rule_name_snapshot = COALESCE(session_index.rule_name_snapshot, excluded.rule_name_snapshot),
         cron_snapshot = COALESCE(session_index.cron_snapshot, excluded.cron_snapshot)`,
});

const UPSERT_REPLAY_METADATA_SQL = `INSERT INTO durable_event_replay_metadata (session_id, last_event_sequence, last_event_timestamp, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_event_sequence = excluded.last_event_sequence,
         last_event_timestamp = excluded.last_event_timestamp,
         updated_at = excluded.updated_at`;

export type SessionProjectionOperation =
  | "upsertSessionIndex"
  | "upsertReplayMetadata"
  | "syncRichStatus"
  | "updateSessionPublishState"
  | "updateSessionSnapshotImageId"
  | "updateSessionRuntimeBackend"
  | "updateSessionRuntimeState"
  | "projectReviewLoopDoneState"
  | "projectVerificationState"
  | "projectCycloidDoneStatus"
  | "projectDisplayColumns";

export interface SessionProjectionStatement {
  operation: SessionProjectionOperation;
  statement: D1PreparedStatement;
}

export interface RuntimeProjectionState {
  runtimeProvider?: SandboxRuntimeProvider | null;
  runtimeBackend?: SandboxRuntimeBackend | null;
  runtimeState?: SandboxRuntimeState | null;
  runtimeSandboxId?: string | null;
  runtimeTemplateId?: string | null;
  runtimeStateExpiresAt?: number | null;
  runtimeLiveLeaseExpiresAt?: number | null;
  runtimePreviewUrl?: string | null;
  runtimeCreatedAt?: number | null;
  runtimeLastResumedAt?: number | null;
  runtimeLastPausedAt?: number | null;
  runtimeLastProviderRefreshedAt?: number | null;
  runtimeProviderTtlExpiresAt?: number | null;
}

export interface PublishProjectionState {
  publishStatus?: PublishStatus | null;
  publishStage?: PublishStage | null;
  publishError?: string | null;
  publishedBranch?: string | null;
  publishAttempt?: number | null;
  publishSequence?: number | null;
}

export interface ParentSessionContext {
  parentSessionId: string;
  parentPromptId: string;
  spawnedByUserId: number;
  spawnDepth: number;
}

export async function buildUpsertSessionIndexStatement(
  db: D1Database,
  session: SessionState,
  richStatus?: string | null,
  parentContext?: ParentSessionContext | null,
): Promise<SessionProjectionStatement> {
  const businessId = await resolveRequiredBusinessId(db, {
    operation: "session_index upsert",
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    businessId: session.businessId ?? null,
  });

  return {
    operation: "upsertSessionIndex",
    statement: db
      .prepare(UPSERT_SESSION_INDEX_SQL)
      .bind(
        session.sessionId,
        session.ownerUserId,
        businessId,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.closedAt,
        session.lastEventId,
        session.title,
        session.titleTags ? JSON.stringify(session.titleTags) : null,
        richStatus ?? null,
        session.model ?? null,
        session.reasoningEffort ?? null,
        session.agentRuntimeBackend ?? null,
        session.agentRole ?? null,
        session.targetPrUrl ?? null,
        session.installationId ?? null,
        session.repoOwner ?? null,
        session.repoName ?? null,
        session.callbackContext ? JSON.stringify(session.callbackContext) : null,
        parentContext?.parentSessionId ?? null,
        parentContext?.parentPromptId ?? null,
        parentContext?.spawnedByUserId ?? null,
        parentContext?.spawnDepth ?? 0,
        session.initiationMode ?? InitiationMode.USER,
        session.entrypoint ?? null,
        session.scheduledRuleId ?? null,
        session.ruleNameSnapshot ?? null,
        session.cronSnapshot ?? null,
      ),
  };
}

export function buildSyncRichStatusStatement(
  db: D1Database,
  sessionId: string,
  richStatus: string,
  planApprovalPending?: boolean,
): SessionProjectionStatement {
  const planApprovalSql = planApprovalPending === undefined ? "" : ", plan_approval_pending = ?";
  const sql =
    richStatus === "archived"
      ? `UPDATE session_index SET rich_status = ?${planApprovalSql}, status = 'archived' WHERE session_id = ?`
      : `UPDATE session_index SET rich_status = ?${planApprovalSql} WHERE session_id = ?`;
  const binds =
    planApprovalPending === undefined ? [richStatus, sessionId] : [richStatus, planApprovalPending ? 1 : 0, sessionId];
  return {
    operation: "syncRichStatus",
    statement: db.prepare(sql).bind(...binds),
  };
}

export interface SessionLivenessRow {
  session_id: string;
  status: string;
  rich_status: string | null;
  agent_role: string | null;
}

export async function getSessionLivenessRows(db: D1Database, sessionIds: string[]): Promise<SessionLivenessRow[]> {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT session_id, status, rich_status, agent_role FROM session_index WHERE session_id IN (${placeholders})`,
    )
    .bind(...sessionIds)
    .all<SessionLivenessRow>();
  return result.results ?? [];
}

interface SessionIndexAgentRoleBusinessDbRow {
  session_id: string;
  agent_role: string | null;
  business_id: string | null;
}

export interface SessionIndexAgentRoleBusinessRow {
  sessionId: string;
  agentRole: string | null;
  businessId: string | null;
}

export async function getSessionIndexAgentRoleBusinessRows(
  db: D1Database,
  sessionIds: string[],
): Promise<SessionIndexAgentRoleBusinessRow[]> {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT session_id, agent_role, business_id FROM session_index WHERE session_id IN (${placeholders})`)
    .bind(...sessionIds)
    .all<SessionIndexAgentRoleBusinessDbRow>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.session_id,
    agentRole: row.agent_role ?? null,
    businessId: row.business_id ?? null,
  }));
}

// ── FSM-sourced mirror projection writes (ARC-1330 W11-P1 → D-59c sole-writer cutover) ─────────────
//
// `project()` (from the committed spine row) is now the SOLE writer of the three legacy session_index
// mirror column groups (`review_loop_done_state` / `qa_testing_state` / `cycloid_done_*`). D-59c deleted
// the blind `mirror*ToIndex` fns + the DO persist/recompute setters that used to write them from the
// legacy DO state, and dropped the P1 `WHERE col IS F` confirm guard: these statements now UNCONDITIONALLY
// write the projected value (a single source cannot disagree with itself — the structural fix for the
// disagreeing-writers class behind the "label says done / verdict says app_breaks" illegal states). Only
// invoked from `syncSessionProjection` when `project()` supplies `fsmMirror` (the FSM live projectExecutor,
// every POST-PUBLISH state — ACTIVE states write the live mirror, TERMINAL states write the CLEARED terminal
// projection so the pre-terminal values do not strand; pre-publish states supply no mirror), so the D1 mirror
// is written exclusively from the spine.
//
// The verification write covers only the categorical `qa_testing_state` — the numeric
// `qa_testing_attempt_count`/`max_attempts` are a KNOWN, by-design divergence (the FSM run-count is
// consecutive-failed, the legacy count is PR-scoped lifetime; W11-V7 owns that authority pin), so this
// projection neither writes nor tracks them.
export function buildProjectReviewLoopDoneStateStatement(
  db: D1Database,
  sessionId: string,
  doneState: ReviewLoopDoneState | null,
): SessionProjectionStatement {
  return {
    operation: "projectReviewLoopDoneState",
    statement: db
      .prepare("UPDATE session_index SET review_loop_done_state = ? WHERE session_id = ?")
      .bind(doneState, sessionId),
  };
}

export function buildProjectVerificationStateStatement(
  db: D1Database,
  sessionId: string,
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationState: VerificationState | null,
): SessionProjectionStatement {
  const value = qaTestingStateFromVerificationState(verificationState);
  return {
    operation: "projectVerificationState",
    statement: db.prepare("UPDATE session_index SET qa_testing_state = ? WHERE session_id = ?").bind(value, sessionId),
  };
}

export function buildProjectCycloidDoneStatusStatement(
  db: D1Database,
  sessionId: string,
  status: CycloidDoneStatus,
): SessionProjectionStatement {
  const reasonsJson = JSON.stringify(status.reasons);
  return {
    operation: "projectCycloidDoneStatus",
    statement: db
      .prepare(
        `UPDATE session_index
         SET arcanist_done_state = ?,
             arcanist_done_outcome = ?,
             arcanist_done_reasons_json = ?
         WHERE session_id = ?`,
      )
      .bind(status.state, status.outcome, reasonsJson, sessionId),
  };
}

// ── FSM-sourced DISPLAY-column projection write (ARC-1330 W11-P3 → D-59c sole-writer cutover) ──────
//
// The status-PILL column `rich_status` twin of the P1 mirror writes. D-59c dropped the P3 confirm guard:
// `project()` now UNCONDITIONALLY writes the projected phase for ACTIVE post-publish states, making it the
// sole authoritative `rich_status` writer for the review-loop display (the legacy per-transition
// `buildSyncRichStatusStatement` still owns pre-publish + non-FSM lifecycle phases; the FSM projection wins
// on the projectExecutor seam because it runs after the row upsert in the same `syncSessionProjection`).
// Deliberately does NOT replicate `buildSyncRichStatusStatement`'s `status = 'archived'` side-effect: this
// isolated display statement only writes `rich_status`. The live projection DOES write the `archived` pill on
// an ARCHIVED terminal transition (MIRROR_TERMINAL_STATES), but the `status='archived'` flip rides the
// session upsert in the SAME `syncSessionProjection` call (the re-read session is already archived post-
// archival), so the two stay coupled without this statement owning the side-effect.
export function buildProjectDisplayColumnsStatement(
  db: D1Database,
  sessionId: string,
  richStatus: string,
  uiLifecycleStage: UiLifecycleStage,
): SessionProjectionStatement {
  return {
    operation: "projectDisplayColumns",
    statement: db
      .prepare("UPDATE session_index SET rich_status = ?, ui_lifecycle_stage = ? WHERE session_id = ?")
      .bind(richStatus, uiLifecycleStage, sessionId),
  };
}

export function buildUpdateSessionPublishStateStatement(
  db: D1Database,
  sessionId: string,
  publishState: PublishProjectionState,
): SessionProjectionStatement {
  const hasPublishStage = publishState.publishStage !== undefined;
  const hasPublishError = publishState.publishError !== undefined;
  const hasPublishedBranch = publishState.publishedBranch !== undefined;
  return {
    operation: "updateSessionPublishState",
    statement: db
      .prepare(
        `UPDATE session_index
         SET publish_status = COALESCE(?, publish_status),
             publish_stage = CASE WHEN ? THEN ? ELSE publish_stage END,
             publish_error = CASE WHEN ? THEN ? ELSE publish_error END,
             published_branch = CASE WHEN ? THEN ? ELSE published_branch END,
             publish_attempt = COALESCE(?, publish_attempt),
             publish_sequence = COALESCE(?, publish_sequence)
         WHERE session_id = ?`,
      )
      .bind(
        publishState.publishStatus ?? null,
        hasPublishStage ? 1 : 0,
        publishState.publishStage ?? null,
        hasPublishError ? 1 : 0,
        publishState.publishError ?? null,
        hasPublishedBranch ? 1 : 0,
        publishState.publishedBranch ?? null,
        publishState.publishAttempt ?? null,
        publishState.publishSequence ?? null,
        sessionId,
      ),
  };
}

export function buildUpdateSessionSnapshotImageIdStatement(
  db: D1Database,
  sessionId: string,
  snapshotImageId: string | null,
): SessionProjectionStatement {
  return {
    operation: "updateSessionSnapshotImageId",
    statement: db
      .prepare("UPDATE session_index SET snapshot_image_id = ? WHERE session_id = ?")
      .bind(snapshotImageId, sessionId),
  };
}

export function buildUpdateSessionRuntimeBackendStatement(
  db: D1Database,
  sessionId: string,
  runtimeBackend: SandboxRuntimeBackend,
): SessionProjectionStatement {
  return {
    operation: "updateSessionRuntimeBackend",
    statement: db
      .prepare("UPDATE session_index SET runtime_backend = ? WHERE session_id = ?")
      .bind(runtimeBackendOrNull(runtimeBackend), sessionId),
  };
}

export function buildUpdateSessionRuntimeStateStatement(
  db: D1Database,
  sessionId: string,
  runtimeState: RuntimeProjectionState,
): SessionProjectionStatement {
  const state = runtimeStateOrNull(runtimeState.runtimeState);
  const stateExpiresAt = state === "running" ? null : (runtimeState.runtimeStateExpiresAt ?? null);
  return {
    operation: "updateSessionRuntimeState",
    statement: db
      .prepare(
        `UPDATE session_index
         SET runtime_provider = ?,
             runtime_backend = ?,
             runtime_state = ?,
             runtime_sandbox_id = ?,
             runtime_template_id = ?,
             runtime_state_expires_at = ?,
             runtime_live_lease_expires_at = ?,
             runtime_preview_url = ?,
             runtime_created_at = ?,
             runtime_last_resumed_at = ?,
             runtime_last_paused_at = ?,
             runtime_last_provider_refreshed_at = ?,
             runtime_provider_ttl_expires_at = ?
         WHERE session_id = ?`,
      )
      .bind(
        runtimeProviderOrNull(runtimeState.runtimeProvider),
        runtimeBackendOrNull(runtimeState.runtimeBackend),
        state,
        runtimeState.runtimeSandboxId ?? null,
        runtimeState.runtimeTemplateId ?? null,
        stateExpiresAt,
        runtimeState.runtimeLiveLeaseExpiresAt ?? null,
        runtimeState.runtimePreviewUrl ?? null,
        runtimeState.runtimeCreatedAt ?? null,
        runtimeState.runtimeLastResumedAt ?? null,
        runtimeState.runtimeLastPausedAt ?? null,
        runtimeState.runtimeLastProviderRefreshedAt ?? null,
        runtimeState.runtimeProviderTtlExpiresAt ?? null,
        sessionId,
      ),
  };
}

export function buildUpsertReplayMetadataStatement(db: D1Database, replay: ReplayState): SessionProjectionStatement {
  return {
    operation: "upsertReplayMetadata",
    statement: db
      .prepare(UPSERT_REPLAY_METADATA_SQL)
      .bind(
        replay.sessionId,
        replay.lastEventSequence,
        replay.lastEventTimestamp ?? replay.updatedAt ?? new Date().toISOString(),
        replay.updatedAt ?? new Date().toISOString(),
      ),
  };
}

export async function runSessionProjectionStatements(
  db: D1Database,
  statements: SessionProjectionStatement[],
): Promise<unknown[]> {
  if (statements.length === 0) return [];

  const preparedStatements = statements.map(({ statement }) => statement);

  return db.batch(preparedStatements);
}

export async function hasSessionIndexEntry(db: D1Database, sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const row = await db
    .prepare("SELECT session_id FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ session_id: string }>();
  return Boolean(row?.session_id);
}

/**
 * Count a business's currently non-terminal top-level sessions. Source of truth
 * for the per-business active-session cap enforced at `POST /api/sessions`
 * admission. A session that finished - shipped its PR (`completed`), was stopped
 * (`stopped`), failed (`failed`), or was blocked (`blocked`) - keeps
 * `status='active'` (nothing auto-closes the row), so filtering on `status`
 * alone over-counts stale terminal-phase rows. We therefore also exclude the
 * canonical terminal phases plus `review_listening` via `rich_status` (the phase
 * column). Review-listening sessions have already shipped their PR and no longer
 * hold compute, so they should not consume the compute-session cap while they
 * monitor for review comments. A terminal/review-listening phase or
 * closed/archived session is excluded, so capacity frees automatically with no
 * separate bookkeeping. `rich_status IS NULL` (a fresh/idle session) still
 * counts.
 * Backed by idx_session_index_business_status (migration 0194); `rich_status` is
 * a residual filter on the matched rows.
 */
export async function countActiveSessionsForBusiness(db: D1Database, businessId: string): Promise<number> {
  if (!businessId) return 0;
  const placeholders = ACTIVE_SESSION_CAP_EXCLUDED_PHASES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM session_index
       WHERE business_id = ?
         AND status != 'closed' AND status != 'archived'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))`,
    )
    .bind(businessId, ...ACTIVE_SESSION_CAP_EXCLUDED_PHASES)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getSessionIndexRepoUrl(db: D1Database, sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare("SELECT repo_owner, repo_name FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ repo_owner: string | null; repo_name: string | null }>();
  if (!row?.repo_owner || !row.repo_name) return null;
  return `https://github.com/${row.repo_owner}/${row.repo_name}`;
}

export async function getSessionIndexIdentity(
  db: D1Database,
  sessionId: string,
): Promise<{ ownerUserId: number; businessId: string | null } | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare("SELECT owner_user_id, business_id FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ owner_user_id: number; business_id: string | null }>();
  if (!row) return null;
  return { ownerUserId: row.owner_user_id, businessId: row.business_id ?? null };
}

export async function getSessionIndexIdentityWithRepo(
  db: D1Database,
  sessionId: string,
): Promise<{
  ownerUserId: number;
  businessId: string | null;
  repoOwner: string | null;
  repoName: string | null;
} | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare("SELECT owner_user_id, business_id, repo_owner, repo_name FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{
      owner_user_id: number;
      business_id: string | null;
      repo_owner: string | null;
      repo_name: string | null;
    }>();
  if (!row) return null;
  return {
    ownerUserId: row.owner_user_id,
    businessId: row.business_id ?? null,
    repoOwner: row.repo_owner ?? null,
    repoName: row.repo_name ?? null,
  };
}

export interface SessionIndexRuntimeProjection {
  runtimeSandboxId: string;
  runtimeBackend: SandboxRuntimeBackend;
}

/**
 * The session's projected runtime VM (id + backend) from `session_index`. Used by the FSM
 * `terminate_runtime` executor (R4) to drive the DO cleanup-run for a final-terminal session.
 * Returns null when there is no projected VM to reclaim (never spawned, or already cleared /
 * terminated — the projection is nulled at clear) or the persisted backend is unparseable.
 * Legacy rows with a NULL/empty `runtime_backend` resolve to the e2b default (the same
 * `parsePersistedRuntimeBackend` semantics the cleanup sweep applies) — a pre-backend-column
 * session reaching a final terminal must still get its VM reclaimed, not fall back to the
 * 72h retention path.
 */
export async function getSessionIndexRuntimeProjection(
  db: D1Database,
  sessionId: string,
): Promise<SessionIndexRuntimeProjection | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare("SELECT runtime_sandbox_id, runtime_backend FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ runtime_sandbox_id: string | null; runtime_backend: string | null }>();
  if (!row?.runtime_sandbox_id) return null;
  const runtimeBackend = parsePersistedRuntimeBackendOrNull(row.runtime_backend);
  if (!runtimeBackend) return null;
  return { runtimeSandboxId: String(row.runtime_sandbox_id), runtimeBackend };
}

export async function deleteOrphanedSessionIndex(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM session_index WHERE session_id = ?").bind(sessionId),
    db.prepare("DELETE FROM durable_event_replay_metadata WHERE session_id = ?").bind(sessionId),
  ]);
}

interface SessionRow {
  session_id: string;
  owner_user_id: number;
  business_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_event_id: string | null;
  title: string | null;
  rich_status: string | null;
  ui_lifecycle_stage?: string | null;
  model: string | null;
  reasoning_effort: string | null;
  agent_runtime_backend: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  parent_session_id: string | null;
  spawn_depth: number | null;
  owner_login?: string | null;
  owner_avatar_url?: string | null;
  pr_url?: string | null;
  pr_draft?: number | null;
  publish_status?: PublishStatus | null;
  publish_stage?: PublishStage | null;
  publish_error?: string | null;
  published_branch?: string | null;
  match_score?: number | null;
  initiation_mode?: string | null;
  entrypoint?: string | null;
  scheduled_rule_id?: string | null;
  rule_name_snapshot?: string | null;
  cron_snapshot?: string | null;
  // Raw persisted column: existing rows may hold legacy `done_green`/`done_exhausted`
  // strings, so this is typed `string | null` (not the narrowed `ReviewLoopDoneState`)
  // and normalized at the projection boundary via `normalizeReviewLoopDoneState`.
  review_loop_done_state?: string | null;
  arcanist_done_state?: string | null;
  arcanist_done_outcome?: string | null;
  arcanist_done_reasons_json?: string | null;
  verification_state?: VerificationState | null;
  verification_attempt_count?: number | null;
  verification_max_attempts?: number | null;
  qa_testing_state?: string | null;
  qa_testing_attempt_count?: number | null;
  qa_testing_max_attempts?: number | null;
  // Raw READ-side columns from the `pr_coordination` FSM record (LEFT JOIN on
  // session_id). NULL when the session has no coordination row (pre-publish /
  // legacy). Constrained by CHECK at the DB level, so cast (not validated) at the
  // projection boundary — same pattern as publish_status/PublishStatus above.
  fsm_state?: FsmState | null;
  fsm_blocked_reason?: BlockedReason | null;
  fsm_failure_reason?: FailureReason | null;
}

function deriveSessionStatus(row: SessionRow): string {
  if (row.status === "archived") return "archived";
  return row.rich_status ?? (row.status === "active" ? "idle" : row.status);
}

interface ListSessionsOptions {
  limit?: number;
  cursor?: string | null;
  businessId?: string | null;
  excludeOwnerUserId?: string | null;
  search?: SessionSearchOptions;
}

interface ListSessionsResult {
  data: SessionRow[];
  nextCursor: string | null;
}

export interface SessionSearchOptions {
  query?: string | null;
  repo?: string | null;
}

export function buildStatusConditions(status: string | null): { conditions: string[]; binds: unknown[] } {
  // The default feed (no explicit status) must exclude archived sessions — they
  // stay in `session_index` after archiving, so without this they leak into the
  // sidebar. The "archived" chip requests them explicitly via status="archived".
  // Null-safe: `NULL != 'archived'` is UNKNOWN in SQL, so a bare inequality would
  // also drop rows whose status is NULL — only exclude rows that are truly archived.
  if (!status) return { conditions: ["(s.status IS NULL OR s.status != 'archived')"], binds: [] };
  if (status === "active") {
    return { conditions: ["s.status != 'closed'", "s.status != 'archived'"], binds: [] };
  }
  if (status === "closed" || status === "archived") {
    return { conditions: ["(s.status = 'closed' OR s.status = 'archived')"], binds: [] };
  }
  // Phase filter: must be non-archived and match the persisted phase string.
  // After the phase-flip, `session_index.rich_status` stores phase values
  // ("running" / "stopped" / etc.) directly; the legacy alias values
  // `sandbox_creating` and `stopped_resumable` are gone. Derived status:
  // rich_status ?? (status === "active" ? "idle" : status).
  if (status === "idle") {
    return {
      conditions: [
        "s.status != 'closed'",
        "s.status != 'archived'",
        "(s.rich_status = 'idle' OR (s.rich_status IS NULL AND s.status = 'active'))",
      ],
      binds: [],
    };
  }
  return {
    conditions: ["s.status != 'closed'", "s.status != 'archived'", "s.rich_status = ?"],
    binds: [status],
  };
}

const SESSION_LIST_CURSOR_VERSION = "v2";

type SessionListCursor = { createdAt: string; sessionId: string; matchScore?: number };

function parseFiniteMatchScore(value: string): number | null {
  const matchScore = Number(value);
  return Number.isFinite(matchScore) ? matchScore : null;
}

function decodeCursor(cursor: string | null | undefined): SessionListCursor | null {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const parts = decoded.split("|");
    // Only v2 cursors are accepted; anything else (including legacy pre-v2
    // cursors) decodes to null and restarts pagination from the first page.
    if (parts[0] !== SESSION_LIST_CURSOR_VERSION) return null;
    if (parts.length === 3) return { createdAt: parts[1], sessionId: parts[2] };
    if (parts.length !== 4) return null;
    const matchScore = parseFiniteMatchScore(parts[1]);
    if (matchScore === null) return null;
    return { matchScore, createdAt: parts[2], sessionId: parts[3] };
  } catch {
    return null;
  }
}

function encodeCursor(row: SessionRow, includeMatchScore: boolean): string {
  const timestamp = row.created_at;
  if (includeMatchScore) {
    return btoa(`${SESSION_LIST_CURSOR_VERSION}|${Number(row.match_score ?? 0)}|${timestamp}|${row.session_id}`);
  }
  return btoa(`${SESSION_LIST_CURSOR_VERSION}|${timestamp}|${row.session_id}`);
}

export function encodeSessionListCursor(
  row: { created_at: string; session_id: string; match_score?: number | null },
  includeMatchScore: boolean,
): string {
  return encodeCursor(row as SessionRow, includeMatchScore);
}

function normalizeSearchText(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized.slice(0, 120) : null;
}

function normalizeRepoSearch(value: string | null | undefined): string | null {
  let normalized = value?.trim().toLowerCase() ?? "";
  normalized = normalized.replace(/^https?:\/\/github\.com\//, "").replace(/^git@github\.com:/, "");
  normalized = normalized.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 160) : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

function tokenizeSearchQuery(query: string | null): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of query.split(/[^a-z0-9/-]+/).filter(Boolean)) {
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 6) break;
  }
  return tokens;
}

export function hasActiveSessionSearch(search: SessionSearchOptions | undefined): boolean {
  return Boolean(normalizeSearchText(search?.query) || normalizeRepoSearch(search?.repo));
}

function buildSessionSearchClauses(search: SessionSearchOptions | undefined): {
  active: boolean;
  conditions: string[];
  binds: unknown[];
  scoreSql: string;
  scoreBinds: unknown[];
} {
  const query = normalizeSearchText(search?.query);
  const repo = normalizeRepoSearch(search?.repo);
  const tokens = tokenizeSearchQuery(query);

  const conditions: string[] = [];
  const binds: unknown[] = [];
  const scoreParts: string[] = [];
  const scoreBinds: unknown[] = [];

  if (repo) {
    const repoPattern = likePattern(repo);
    conditions.push(
      "(LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) = ? OR LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\')",
    );
    binds.push(repo, repoPattern);
    scoreParts.push(
      "CASE WHEN LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) = ? THEN 70 WHEN LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\' THEN 35 ELSE 0 END",
    );
    scoreBinds.push(repo, repoPattern);
  }

  if (query) {
    const queryPattern = likePattern(query);
    const queryConditions = [
      "LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\'",
      "LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\'",
    ];
    binds.push(queryPattern, queryPattern);

    for (const token of tokens) {
      const tokenPattern = likePattern(token);
      queryConditions.push("LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\'");
      queryConditions.push("LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\'");
      binds.push(tokenPattern, tokenPattern);
    }
    conditions.push(`(${queryConditions.join(" OR ")})`);

    scoreParts.push("CASE WHEN LOWER(COALESCE(s.title, '')) = ? THEN 120 ELSE 0 END");
    scoreBinds.push(query);
    scoreParts.push("CASE WHEN LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\' THEN 80 ELSE 0 END");
    scoreBinds.push(queryPattern);
    scoreParts.push(
      "CASE WHEN LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) = ? THEN 65 WHEN LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\' THEN 30 ELSE 0 END",
    );
    scoreBinds.push(query, queryPattern);

    for (const token of tokens) {
      const tokenPattern = likePattern(token);
      scoreParts.push("CASE WHEN LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\' THEN 12 ELSE 0 END");
      scoreBinds.push(tokenPattern);
      scoreParts.push(
        "CASE WHEN LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, '')) LIKE ? ESCAPE '\\' THEN 6 ELSE 0 END",
      );
      scoreBinds.push(tokenPattern);
    }
  }

  return {
    active: scoreParts.length > 0,
    conditions,
    binds,
    scoreSql: scoreParts.length > 0 ? scoreParts.join(" + ") : "0",
    scoreBinds,
  };
}

// Canonical `session_index` column set fed to `toSessionApiShape`. Shared by the
// paginated `listSessions` query and the by-id `getSessionApiShapeById` read so
// the two projections can never drift.
const SESSION_INDEX_API_COLUMNS =
  "session_id, owner_user_id, business_id, status, created_at, updated_at, closed_at, last_event_id, title, rich_status, ui_lifecycle_stage, model, reasoning_effort, agent_runtime_backend, repo_owner, repo_name, initiation_mode, entrypoint, scheduled_rule_id, rule_name_snapshot, cron_snapshot, review_loop_done_state, arcanist_done_state, arcanist_done_outcome, arcanist_done_reasons_json, qa_testing_state, qa_testing_attempt_count, qa_testing_max_attempts";

export async function listSessions(
  db: D1Database,
  ownerUserId: string | null,
  status: string | null,
  options?: ListSessionsOptions,
): Promise<ListSessionsResult> {
  const limit = Math.min(Math.max((options?.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = decodeCursor(options?.cursor);
  const search = buildSessionSearchClauses(options?.search);

  const COLUMNS = SESSION_INDEX_API_COLUMNS;
  const joinColumns = COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");

  const visibilityConditions: string[] = [];
  const visibilityBinds: unknown[] = [];

  // Owner filter
  if (options?.businessId) {
    visibilityConditions.push("s.business_id = ?");
    visibilityBinds.push(options.businessId);
    if (options.excludeOwnerUserId) {
      visibilityConditions.push("s.owner_user_id != ?");
      visibilityBinds.push(options.excludeOwnerUserId);
    }
  } else if (ownerUserId) {
    visibilityConditions.push("s.owner_user_id = ?");
    visibilityBinds.push(ownerUserId);
  }

  // Status filter (pushed from JS to SQL)
  const statusFilter = buildStatusConditions(status);
  visibilityConditions.push(...statusFilter.conditions);
  visibilityBinds.push(...statusFilter.binds);
  visibilityConditions.push(SESSION_HAS_USER_VISIBLE_WORK_SQL);

  const conditions = [...visibilityConditions];
  const binds = [...visibilityBinds];
  conditions.push(...search.conditions);
  binds.push(...search.binds);

  // Cursor condition (keyset pagination on created_at DESC, session_id DESC).
  if (cursor && !search.active) {
    const timestamp = cursor.createdAt;
    conditions.push(`(s.created_at < ? OR (s.created_at = ? AND s.session_id < ?))`);
    binds.push(timestamp, timestamp, cursor.sessionId);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  // Fetch limit + 1 to detect whether more rows exist. PR metadata is projected
  // by publish, keyed by (session_id, pr_url), so list reads never race against
  // prompt completion writes.
  const selectedColumns = `${joinColumns},
    CASE WHEN parent.session_id IS NOT NULL THEN s.parent_session_id ELSE NULL END AS parent_session_id,
    CASE WHEN parent.session_id IS NOT NULL THEN s.spawn_depth ELSE NULL END AS spawn_depth,
    u.login AS owner_login, u.avatar_url AS owner_avatar_url,
    (SELECT pr_url FROM session_pr_metadata
      WHERE session_id = s.session_id
      ORDER BY updated_at DESC, pr_url DESC LIMIT 1) AS pr_url,
    (SELECT pr_draft FROM session_pr_metadata
      WHERE session_id = s.session_id
      ORDER BY updated_at DESC, pr_url DESC LIMIT 1) AS pr_draft,
    pc.state AS fsm_state, pc.blocked_reason AS fsm_blocked_reason, pc.failure_reason AS fsm_failure_reason`;

  let sql: string;
  let allBinds: unknown[];
  if (search.active) {
    const outerConditions: string[] = [];
    const outerBinds: unknown[] = [];
    if (cursor && cursor.matchScore !== undefined) {
      const timestamp = cursor.createdAt;
      outerConditions.push(
        `(match_score < ? OR (match_score = ? AND (created_at < ? OR (created_at = ? AND session_id < ?))))`,
      );
      outerBinds.push(cursor.matchScore, cursor.matchScore, timestamp, timestamp, cursor.sessionId);
    }
    const outerWhere = outerConditions.length > 0 ? ` WHERE ${outerConditions.join(" AND ")}` : "";
    sql = `SELECT * FROM (
      SELECT ${selectedColumns}, (${search.scoreSql}) AS match_score
      FROM session_index s
      LEFT JOIN session_index parent ON parent.session_id = s.parent_session_id AND parent.business_id IS s.business_id
      LEFT JOIN users u ON s.owner_user_id = u.id
      LEFT JOIN pr_coordination pc ON pc.session_id = s.session_id${where}
    ) ranked${outerWhere}
    ORDER BY match_score DESC, created_at DESC, session_id DESC
    LIMIT ?`;
    allBinds = [...search.scoreBinds, ...binds, ...outerBinds, limit + 1];
  } else {
    sql = `SELECT ${selectedColumns}
      FROM session_index s
      LEFT JOIN session_index parent ON parent.session_id = s.parent_session_id AND parent.business_id IS s.business_id
      LEFT JOIN users u ON s.owner_user_id = u.id
      LEFT JOIN pr_coordination pc ON pc.session_id = s.session_id${where}
      ORDER BY s.created_at DESC, s.session_id DESC
      LIMIT ?`;
    allBinds = [...binds, limit + 1];
  }

  const result = await db
    .prepare(sql)
    .bind(...allBinds)
    .all<SessionRow>();
  const rows = result.results ?? [];

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && data.length > 0 ? encodeCursor(data[data.length - 1], search.active) : null;
  // Parent anchors are sidebar context, not page rows. Keep cursor math tied to
  // the page slice so a child can pull in an older parent without skipping
  // normal sessions on the next page.
  const parentAnchors = await fetchMissingParentAnchorRows(
    db,
    data,
    selectedColumns,
    visibilityConditions,
    visibilityBinds,
  );

  return { data: parentAnchors.length ? [...data, ...parentAnchors] : data, nextCursor };
}

async function fetchMissingParentAnchorRows(
  db: D1Database,
  pageRows: SessionRow[],
  selectedColumns: string,
  visibilityConditions: string[],
  visibilityBinds: unknown[],
): Promise<SessionRow[]> {
  const rowsById = new Map(pageRows.map((row) => [row.session_id, row] as const));
  const anchors: SessionRow[] = [];
  let pendingParentIds = pageRows
    .map((row) => row.parent_session_id)
    .filter((id): id is string => !!id && !rowsById.has(id));

  while (pendingParentIds.length > 0) {
    const uniquePendingParentIds = [...new Set(pendingParentIds)].filter((id) => !rowsById.has(id));
    if (uniquePendingParentIds.length === 0) break;

    const parentIdPlaceholders = uniquePendingParentIds.map(() => "?").join(", ");
    const where = [`s.session_id IN (${parentIdPlaceholders})`, ...visibilityConditions].join(" AND ");
    const result = await db
      .prepare(
        `SELECT ${selectedColumns}
         FROM session_index s
         LEFT JOIN session_index parent ON parent.session_id = s.parent_session_id AND parent.business_id IS s.business_id
         LEFT JOIN users u ON s.owner_user_id = u.id
         LEFT JOIN pr_coordination pc ON pc.session_id = s.session_id
         WHERE ${where}
         ORDER BY s.created_at DESC, s.session_id DESC`,
      )
      .bind(...uniquePendingParentIds, ...visibilityBinds)
      .all<SessionRow>();

    const fetchedParents = result.results ?? [];
    if (fetchedParents.length === 0) break;

    pendingParentIds = [];
    for (const parent of fetchedParents) {
      if (rowsById.has(parent.session_id)) continue;
      rowsById.set(parent.session_id, parent);
      anchors.push(parent);
      if (parent.parent_session_id && !rowsById.has(parent.parent_session_id)) {
        pendingParentIds.push(parent.parent_session_id);
      }
    }
  }

  return anchors;
}

export function toSessionApiShape(row: SessionRow) {
  const phase = deriveSessionStatus(row);
  const displayStatus = displayStatusFromPhase(phase);
  // Normalize legacy persisted done-state strings to the collapsed union at the projection boundary.
  const reviewLoopDoneState = normalizeReviewLoopDoneState(row.review_loop_done_state);
  const cycloidDoneState = normalizeCycloidDoneState(row.arcanist_done_state);
  const cycloidDoneOutcome = normalizeCycloidDoneOutcome(row.arcanist_done_outcome);
  const cycloidDoneReasons = normalizeCycloidDoneReasons(row.arcanist_done_reasons_json);
  const verificationState = verificationStateFromQaTestingState(row.qa_testing_state);
  const verificationAttemptCount = row.qa_testing_attempt_count ?? 0;
  const verificationMaxAttempts = row.qa_testing_max_attempts ?? MAX_VERIFICATION_RUNS_PER_PR;
  return {
    sessionId: row.session_id,
    ownerUserId: String(row.owner_user_id),
    businessId: row.business_id ?? null,
    phase,
    displayStatus,
    status: phase,
    uiLifecycleStage: normalizeUiLifecycleStage(row.ui_lifecycle_stage),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    lastEventId: row.last_event_id,
    title: row.title,
    prUrl: row.pr_url ?? null,
    ...(row.pr_draft != null ? { prDraft: row.pr_draft === 1 } : {}),
    ...(row.publish_status ? { publishStatus: row.publish_status } : {}),
    ...(row.publish_error !== undefined ? { publishError: row.publish_error ?? null } : {}),
    ...(row.published_branch !== undefined ? { publishedBranch: row.published_branch ?? null } : {}),
    ...(row.model && { model: row.model }),
    desktopActionPathAvailable: isInternalCycloidBusinessId(row.business_id ?? ""),
    ...(row.reasoning_effort && { reasoningEffort: row.reasoning_effort }),
    sessionKind: "repo",
    ...(row.owner_login && { ownerLogin: row.owner_login }),
    ...(row.owner_avatar_url && { ownerAvatarUrl: row.owner_avatar_url }),
    ...(row.repo_owner && { repoOwner: row.repo_owner }),
    ...(row.repo_name && { repoName: row.repo_name }),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(typeof row.spawn_depth === "number" && row.spawn_depth > 0 ? { spawnDepth: row.spawn_depth } : {}),
    initiationMode: parseInitiationMode(row.initiation_mode),
    entrypoint: parseSessionEntrypoint(row.entrypoint),
    ...(row.scheduled_rule_id ? { scheduledRuleId: row.scheduled_rule_id } : {}),
    ...(row.rule_name_snapshot ? { ruleNameSnapshot: row.rule_name_snapshot } : {}),
    ...(row.cron_snapshot ? { cronSnapshot: row.cron_snapshot } : {}),
    ...(reviewLoopDoneState ? { reviewLoopDoneState } : {}),
    cycloidDoneState,
    ...(cycloidDoneOutcome ? { cycloidDoneOutcome } : {}),
    cycloidDoneReasons,
    ...(verificationState ? { verificationState } : {}),
    verificationAttemptCount: Number(verificationAttemptCount),
    verificationMaxAttempts: Number(verificationMaxAttempts),
    // READ-side FSM lifecycle projection (pr_coordination LEFT JOIN). Always
    // present, null when the session has no coordination row (pre-publish /
    // legacy). `state` and `failure_reason` are unconstrained TEXT in D1, so
    // validate each against the canonical set before narrowing — an unknown
    // value resolves to null (safe legacy fallback) instead of a bad union cast.
    fsmState: isFsmState(row.fsm_state) ? row.fsm_state : null,
    blockedReason: isBlockedReason(row.fsm_blocked_reason) ? row.fsm_blocked_reason : null,
    failureReason: isFailureReason(row.fsm_failure_reason) ? row.fsm_failure_reason : null,
  };
}

/** The API-list-row shape `toSessionApiShape` emits (also the `session_upserted` feed payload). */
export type SessionApiShape = ReturnType<typeof toSessionApiShape>;

/**
 * Read a single `session_index` row by id in the exact `listSessions`
 * projection (parent anchor + `users` join + latest-PR subqueries) and run it
 * through `toSessionApiShape`. Used by the realtime feed (ARC-1322) to publish a
 * `session_upserted` delta that is byte-identical to a fetched list row.
 *
 * Applies `listSessions`' user-visible-work filter so the feed never inserts a
 * sidebar row the next poll would exclude (returns null otherwise). It does NOT
 * apply per-user repo-access visibility — that is the feed DO's gate, downstream.
 */
export async function getSessionApiShapeById(db: D1Database, sessionId: string): Promise<SessionApiShape | null> {
  const joinColumns = SESSION_INDEX_API_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  const sql = `SELECT ${joinColumns},
    CASE WHEN parent.session_id IS NOT NULL THEN s.parent_session_id ELSE NULL END AS parent_session_id,
    CASE WHEN parent.session_id IS NOT NULL THEN s.spawn_depth ELSE NULL END AS spawn_depth,
    u.login AS owner_login, u.avatar_url AS owner_avatar_url,
    (SELECT pr_url FROM session_pr_metadata
      WHERE session_id = s.session_id
      ORDER BY updated_at DESC, pr_url DESC LIMIT 1) AS pr_url,
    (SELECT pr_draft FROM session_pr_metadata
      WHERE session_id = s.session_id
      ORDER BY updated_at DESC, pr_url DESC LIMIT 1) AS pr_draft,
    pc.state AS fsm_state, pc.blocked_reason AS fsm_blocked_reason, pc.failure_reason AS fsm_failure_reason
    FROM session_index s
    LEFT JOIN session_index parent ON parent.session_id = s.parent_session_id AND parent.business_id IS s.business_id
    LEFT JOIN users u ON s.owner_user_id = u.id
    LEFT JOIN pr_coordination pc ON pc.session_id = s.session_id
    WHERE s.session_id = ? AND ${SESSION_HAS_USER_VISIBLE_WORK_SQL}
    LIMIT 1`;
  const row = await db.prepare(sql).bind(sessionId).first<SessionRow>();
  return row ? toSessionApiShape(row) : null;
}

function canAccessSessionOwner(auth: AuthInfo, ownerUserId: string): boolean {
  return auth.canAccessAllSessions || ownerUserId === auth.userId;
}

export function canAccessSessionIdentity(
  auth: AuthInfo,
  ownerUserId: string,
  businessId: string | null | undefined,
): boolean {
  if (canAccessSessionOwner(auth, ownerUserId)) return true;
  if (auth.user?.sharedSessions && businessIdsMatch(auth.user.businessId, businessId)) return true;
  return false;
}

export function canAccessSession(auth: AuthInfo, session: SessionState): boolean {
  return canAccessSessionIdentity(auth, session.ownerUserId, session.businessId);
}

export async function deleteArchivedSessionsFromIndex(db: D1Database, ownerUserId?: string): Promise<void> {
  if (ownerUserId) {
    await db
      .prepare("DELETE FROM session_index WHERE status = 'archived' AND owner_user_id = ?")
      .bind(ownerUserId)
      .run();
  } else {
    await db.prepare("DELETE FROM session_index WHERE status = 'archived'").run();
  }
}
