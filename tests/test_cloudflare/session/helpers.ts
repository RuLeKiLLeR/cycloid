/**
 * Shared fakes and helpers for session Durable Object tests.
 *
 * All three session test suites need identical FakeStorage, FakeD1,
 * createFakeState, and createTestEnv implementations. Centralised here
 * to avoid triple-duplication.
 */
import { vi } from "vitest";

import type { InitiationMode } from "../../../apps/control-plane-worker/src/enums/initiation-mode.ts";
import type { SessionEntrypoint } from "../../../apps/control-plane-worker/src/enums/session-entrypoint.ts";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { initSchema } from "../../../apps/control-plane-worker/src/session/schema.ts";
import type { PromptState, SessionState } from "../../../apps/control-plane-worker/src/types";
import {
  FakeDurableState,
  FakeSqlStorage,
  mockCloudflareWorkers as mockHarnessCloudflareWorkers,
} from "../helpers/worker-harness";

export class FakeStorage extends FakeSqlStorage {
  constructor() {
    super();
    initSchema(this.sql as unknown as SqlStorage);
  }

  private currentSessionId(): string | undefined {
    const rows = this.sql.exec("SELECT session_id FROM session LIMIT 1").toArray();
    return rows.length > 0 ? (rows[0].session_id as string) : undefined;
  }

  private peekLastPushSucceeded(sessionId: string): number {
    const rows = this.sql.exec("SELECT last_push_succeeded FROM session WHERE session_id = ?", sessionId).toArray();
    return rows.length > 0 ? ((rows[0].last_push_succeeded as number) ?? 0) : 0;
  }

  private getPromptHasPendingQuestion(promptId: string | null | undefined): boolean | undefined {
    if (!promptId) return undefined;
    const rows = this.sql.exec("SELECT has_pending_question FROM prompts WHERE prompt_id = ?", promptId).toArray();
    if (rows.length === 0) return undefined;
    return rows[0].has_pending_question === 1;
  }

  private upsertSession(session: SessionState): void {
    const createdAt = Number.isFinite(Date.parse(session.createdAt)) ? Date.parse(session.createdAt) : Date.now();
    const updatedAt = Number.isFinite(Date.parse(session.updatedAt)) ? Date.parse(session.updatedAt) : createdAt;
    const closedAt =
      session.closedAt && Number.isFinite(Date.parse(session.closedAt)) ? Date.parse(session.closedAt) : null;
    const existingExt = doDb.getSessionExtended(this.sql as unknown as SqlStorage, session.sessionId);

    this.sql.exec(
      `INSERT OR REPLACE INTO session (
				session_id, owner_user_id, business_id, title, status, created_at, updated_at, closed_at,
				model, reasoning_effort, repo_owner, repo_name, base_branch, last_branch,
				last_commit_sha, pr_url, pr_number, pr_creating, pr_draft, pr_manual_review_reason, installation_id,
				prompt_counter, repo_private, callback_context_json,
				linear_context_json, github_issue_context_json, resolved_agents_json,
				agent_session_id, agent_session_agent, last_push_succeeded, spawn_duration_ms, plan_mode,
				plan_approval_required, adopted_external_pr
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.sessionId,
      session.ownerUserId,
      session.businessId ?? null,
      session.title ?? null,
      session.status,
      createdAt,
      updatedAt,
      closedAt,
      session.model ?? null,
      session.reasoningEffort ?? null,
      existingExt?.repoOwner ?? null,
      existingExt?.repoName ?? null,
      existingExt?.baseBranch ?? null,
      existingExt?.lastBranch ?? null,
      existingExt?.lastCommitSha ?? null,
      existingExt?.prUrl ?? null,
      existingExt?.prNumber ?? null,
      existingExt?.prCreating ? 1 : 0,
      existingExt?.prDraft == null ? null : Number(existingExt.prDraft),
      existingExt?.prManualReviewReason ?? null,
      existingExt?.installationId ?? null,
      existingExt?.promptCounter ?? 0,
      existingExt?.repoPrivate == null ? null : Number(existingExt.repoPrivate),
      existingExt?.callbackContext ? JSON.stringify(existingExt.callbackContext) : null,
      existingExt?.linearContext ? JSON.stringify(existingExt.linearContext) : null,
      existingExt?.githubIssueContext ? JSON.stringify(existingExt.githubIssueContext) : null,
      existingExt?.resolvedAgents ? JSON.stringify(existingExt.resolvedAgents) : null,
      existingExt?.agentSessionId ?? null,
      existingExt?.agentSessionAgent ?? null,
      // ARC-876: lastPushSucceeded column is deprecated. Preserve the column
      // for backward DB compatibility (drop in a follow-up migration); no app
      // code reads it.
      this.peekLastPushSucceeded(session.sessionId),
      existingExt?.spawnDurationMs ?? null,
      (session.planMode ?? existingExt?.planMode) ? 1 : 0,
      (session.planApprovalRequired ?? existingExt?.planApprovalRequired) ? 1 : 0,
      (session.adoptedExternalPr ?? existingExt?.adoptedExternalPr) ? 1 : 0,
    );
    doDb.ensureSandboxState(this.sql as unknown as SqlStorage, session.sessionId);
  }

  private replacePrompts(prompts: PromptState[]): void {
    const sessionId = this.currentSessionId();
    if (!sessionId) return;
    this.sql.exec("DELETE FROM prompts WHERE session_id = ?", sessionId);
    for (const prompt of prompts) {
      seedPrompt(this, {
        promptId: prompt.promptId,
        sessionId,
        promptText: prompt.prompt,
        actorUserId: prompt.actorUserId,
        agent: prompt.agent ?? null,
        status: prompt.status,
        createdAt: Number.isFinite(Date.parse(prompt.createdAt)) ? Date.parse(prompt.createdAt) : Date.now(),
        startedAt:
          prompt.startedAt && Number.isFinite(Date.parse(prompt.startedAt)) ? Date.parse(prompt.startedAt) : null,
        completedAt:
          prompt.completedAt && Number.isFinite(Date.parse(prompt.completedAt)) ? Date.parse(prompt.completedAt) : null,
        updatedAt: Number.isFinite(Date.parse(prompt.updatedAt)) ? Date.parse(prompt.updatedAt) : Date.now(),
        error: prompt.error ?? null,
        resultJson: prompt.result == null ? null : JSON.stringify(prompt.result),
        skillsJson: prompt.skills ? JSON.stringify(prompt.skills) : null,
        filesJson: prompt.files ? JSON.stringify(prompt.files) : null,
        uploadedFilesJson: prompt.uploadedFiles ? JSON.stringify(prompt.uploadedFiles) : null,
        uploadedImagesJson: prompt.uploadedImages ? JSON.stringify(prompt.uploadedImages) : null,
        planContextJson: prompt.planContext ? JSON.stringify(prompt.planContext) : null,
        reviewLoopEpochId: prompt.reviewLoopEpochId ?? null,
        reviewLoopSourceKind: prompt.reviewLoopSourceKind ?? null,
      });
    }
  }

  private legacyGet<T>(key: string): T | undefined {
    const sessionId = this.currentSessionId();
    if (!sessionId) {
      return this.map.get(key) as T | undefined;
    }

    switch (key) {
      case "session":
        return doDb.getSession(this.sql as unknown as SqlStorage, sessionId) as T | undefined;
      case "prompts":
        return doDb.getPrompts(this.sql as unknown as SqlStorage, sessionId) as T | undefined;
      case "activePromptId":
        return doDb.getActiveProcessingPromptId(this.sql as unknown as SqlStorage, sessionId) as T | undefined;
      case "promptCounter":
        return doDb.getSessionExtended(this.sql as unknown as SqlStorage, sessionId)?.promptCounter as T | undefined;
      case "last_push_succeeded": {
        const rows = this.sql.exec("SELECT last_push_succeeded FROM session WHERE session_id = ?", sessionId).toArray();
        if (rows.length === 0) return undefined;
        return Boolean(rows[0].last_push_succeeded) as unknown as T;
      }
      case "agent_session_id":
        return (doDb.getSessionExtended(this.sql as unknown as SqlStorage, sessionId)?.agentSessionId ?? undefined) as
          T | undefined;
      case "agent_session_agent":
        return (doDb.getSessionExtended(this.sql as unknown as SqlStorage, sessionId)?.agentSessionAgent ??
          undefined) as T | undefined;
      case "sandbox_status":
        return doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.status as T | undefined;
      case "pending_prompt_dispatch":
        return doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.pendingPromptDispatch as
          T | undefined;
      case "spawnRetryCount":
        return doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.spawnRetryCount as T | undefined;
      case "sandbox_auth_token_hash":
        return (doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.sandboxAuthTokenHash ??
          undefined) as T | undefined;
      case "spawn_started_at":
        return (doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.spawnStartedAt ?? undefined) as
          T | undefined;
      case "prompt_last_activity_at":
        return (doDb.getSandboxState(this.sql as unknown as SqlStorage, sessionId)?.promptLastActivityAt ??
          undefined) as T | undefined;
      case "has_pending_question":
        return this.getPromptHasPendingQuestion(
          doDb.getActiveProcessingPromptId(this.sql as unknown as SqlStorage, sessionId),
        ) as T | undefined;
      default:
        return this.map.get(key) as T | undefined;
    }
  }

  private legacyPut<T>(key: string, value: T): boolean {
    const sessionId = this.currentSessionId();

    switch (key) {
      case "session":
        this.upsertSession(value as unknown as SessionState);
        return true;
      case "prompts":
        this.replacePrompts(value as unknown as PromptState[]);
        return true;
      case "activePromptId": {
        // session.active_prompt_id was dropped (DO schema migration 70);
        // active prompt is derived from prompts.status. Translate the
        // legacy put("activePromptId", X) into the equivalent prompt-row
        // state change via the shared helper so all three test entry
        // points (this, sqlUpdateSession, prompt-activity-owner) share
        // one maintained implementation.
        if (!sessionId) return false;
        setActivePromptIdViaPromptRow(this.sql as unknown as SqlStorage, sessionId, value as string | null);
        return true;
      }
      case "promptCounter":
        if (!sessionId) return false;
        doDb.updateSessionFields(this.sql as unknown as SqlStorage, sessionId, { promptCounter: value as number });
        return true;
      case "last_push_succeeded":
        if (!sessionId) return false;
        this.sql.exec(
          "UPDATE session SET last_push_succeeded = ?, updated_at = ? WHERE session_id = ?",
          Boolean(value) ? 1 : 0,
          Date.now(),
          sessionId,
        );
        return true;
      case "agent_session_id":
        if (!sessionId) return false;
        doDb.updateSessionFields(this.sql as unknown as SqlStorage, sessionId, {
          agentSessionId: value as string | null,
        });
        return true;
      case "agent_session_agent":
        if (!sessionId) return false;
        doDb.updateSessionFields(this.sql as unknown as SqlStorage, sessionId, {
          agentSessionAgent: value as string | null,
        });
        return true;
      case "sandbox_status":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, { status: String(value) });
        return true;
      case "pending_prompt_dispatch":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, {
          pendingPromptDispatch: Boolean(value),
        });
        return true;
      case "spawnRetryCount":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, { spawnRetryCount: Number(value) });
        return true;
      case "sandbox_auth_token_hash":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, {
          sandboxAuthTokenHash: value as string | null,
        });
        return true;
      case "spawn_started_at":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, {
          spawnStartedAt: value as number | null,
        });
        return true;
      case "prompt_last_activity_at":
        if (!sessionId) return false;
        doDb.ensureSandboxState(this.sql as unknown as SqlStorage, sessionId);
        doDb.updateSandboxState(this.sql as unknown as SqlStorage, sessionId, {
          promptLastActivityAt: value as number | null,
        });
        return true;
      case "has_pending_question": {
        if (!sessionId) return false;
        const promptId = doDb.getActiveProcessingPromptId(this.sql as unknown as SqlStorage, sessionId);
        if (!promptId) return false;
        doDb.updatePrompt(this.sql as unknown as SqlStorage, promptId, { hasPendingQuestion: Boolean(value) });
        return true;
      }
      default:
        return false;
    }
  }

  async get<T>(key: string): Promise<T | undefined>;
  async get(keys: string[]): Promise<Map<string, unknown>>;
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, unknown>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, unknown>();
      for (const k of keyOrKeys) {
        const value = this.legacyGet(k);
        if (value !== undefined) result.set(k, value);
      }
      return result;
    }
    return this.legacyGet(keyOrKeys);
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      if (!this.legacyPut(keyOrEntries, value as T)) {
        this.map.set(keyOrEntries, value);
      }
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        if (!this.legacyPut(k, v)) {
          this.map.set(k, v);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FakeD1 -- minimal D1 stub
// ---------------------------------------------------------------------------

export class FakeD1Statement {
  bind(..._values: unknown[]): this {
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    return { success: true, meta: { last_row_id: 0 } };
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export class FakeD1 {
  prepare(_query: string): FakeD1Statement {
    return new FakeD1Statement();
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ success: true; meta: { last_row_id: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

// ---------------------------------------------------------------------------
// createFakeState -- mimics DurableObjectState with WebSocket hibernation API
// ---------------------------------------------------------------------------

export function createFakeState() {
  return new FakeDurableState(new FakeStorage());
}

// ---------------------------------------------------------------------------
// SQL seed helpers -- insert initial state into DO-internal SQLite tables
// ---------------------------------------------------------------------------

/** Parameters for seeding a session row. */
export interface SeedSessionParams {
  sessionId: string;
  ownerUserId: string;
  businessId?: string | null;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number | null;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentRuntimeBackend?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
  lastBranch?: string | null;
  lastCommitSha?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prCreating?: number;
  prDraft?: number | null;
  prManualReviewReason?: string | null;
  installationId?: number | null;
  activePromptId?: string | null;
  promptCounter?: number;
  repoPrivate?: number | null;
  callbackContextJson?: string | null;
  linearContextJson?: string | null;
  githubIssueContextJson?: string | null;
  resolvedAgentsJson?: string | null;
  agentSessionId?: string | null;
  agentSessionAgent?: string | null;
  lastPushSucceeded?: number;
  spawnDurationMs?: number | null;
  initiationMode?: InitiationMode;
  entrypoint?: SessionEntrypoint;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  autoVerifyDisabled?: number;
  planMode?: number;
  planApprovalRequired?: number;
  adoptedExternalPr?: number;
  agentRole?: string | null;
}

/**
 * Insert a session row into the SQL session table.
 * Must be called AFTER DO construction (which runs initSchema).
 */
export function seedSession(storage: FakeStorage, params: SeedSessionParams): void {
  const now = Date.now();
  // active_prompt_id was dropped in DO schema migration 70; tests that
  // previously seeded a "session with an in-flight prompt" should seed a
  // prompt row directly via seedPrompt(status: "processing") instead. The
  // activePromptId param is accepted for ergonomic call-site continuity
  // and is auto-translated into a processing prompt row when set.
  storage.sql.exec(
    `INSERT INTO session (
			session_id, owner_user_id, business_id, status, created_at, updated_at, closed_at,
			title, model, reasoning_effort, agent_runtime_backend, repo_owner, repo_name, base_branch,
			last_branch, last_commit_sha, pr_url, pr_number, pr_creating, pr_draft, pr_manual_review_reason,
			installation_id, prompt_counter, repo_private,
			callback_context_json, linear_context_json, github_issue_context_json,
			resolved_agents_json, agent_session_id, agent_session_agent,
			last_push_succeeded, spawn_duration_ms,
			initiation_mode, entrypoint, scheduled_rule_id, rule_name_snapshot, cron_snapshot, auto_verify_disabled, plan_mode,
			plan_approval_required, adopted_external_pr, agent_role
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.sessionId,
    params.ownerUserId,
    params.businessId ?? null,
    params.status ?? "active",
    params.createdAt ?? now,
    params.updatedAt ?? now,
    params.closedAt ?? null,
    params.title ?? null,
    params.model ?? null,
    params.reasoningEffort ?? null,
    params.agentRuntimeBackend ?? null,
    params.repoOwner ?? null,
    params.repoName ?? null,
    params.baseBranch ?? null,
    params.lastBranch ?? null,
    params.lastCommitSha ?? null,
    params.prUrl ?? null,
    params.prNumber ?? null,
    params.prCreating ?? 0,
    params.prDraft ?? null,
    params.prManualReviewReason ?? null,
    params.installationId ?? null,
    params.promptCounter ?? 0,
    params.repoPrivate ?? null,
    params.callbackContextJson ?? null,
    params.linearContextJson ?? null,
    params.githubIssueContextJson ?? null,
    params.resolvedAgentsJson ?? null,
    params.agentSessionId ?? null,
    params.agentSessionAgent ?? null,
    params.lastPushSucceeded ?? 0,
    params.spawnDurationMs ?? null,
    params.initiationMode ?? "user",
    params.entrypoint ?? null,
    params.scheduledRuleId ?? null,
    params.ruleNameSnapshot ?? null,
    params.cronSnapshot ?? null,
    params.autoVerifyDisabled ?? 0,
    params.planMode ?? 0,
    params.planApprovalRequired ?? 0,
    params.adoptedExternalPr ?? 0,
    params.agentRole ?? null,
  );
}

/** Parameters for seeding a sandbox_state row. */
export interface SeedSandboxParams {
  sessionId: string;
  status?: string;
  sandboxId?: string | null;
  spawnRetryCount?: number;
  pendingPromptDispatch?: number;
  sandboxAuthTokenHash?: string | null;
  spawnStartedAt?: number | null;
  lastSpawnAttemptId?: string | null;
  promptLastActivityAt?: number | null;
  disconnectStartedAt?: number | null;
  autoCloseScheduledAt?: number | null;
}

export interface SeedSandboxStateOptions {
  status?: string;
  spawnRetryCount?: number;
  pendingPromptDispatch?: number;
}

/** Insert a sandbox_state row. Must be called AFTER DO construction. */
export function seedSandboxState(storage: FakeStorage, params: SeedSandboxParams): void;
/** Seed the DO-owned sandbox_state row through a SqlStorage handle. */
export function seedSandboxState(sql: SqlStorage, sessionId: string, options?: SeedSandboxStateOptions): void;
export function seedSandboxState(
  storageOrSql: FakeStorage | SqlStorage,
  paramsOrSessionId: SeedSandboxParams | string,
  options: SeedSandboxStateOptions = {},
): void {
  if (typeof paramsOrSessionId === "string") {
    const sql = storageOrSql as SqlStorage;
    sql.exec(
      `INSERT INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET status = excluded.status,
         spawn_retry_count = excluded.spawn_retry_count,
         pending_prompt_dispatch = excluded.pending_prompt_dispatch`,
      paramsOrSessionId,
      options.status ?? "idle",
      options.spawnRetryCount ?? 0,
      options.pendingPromptDispatch ?? 0,
    );
    return;
  }

  const storage = storageOrSql as FakeStorage;
  const params = paramsOrSessionId;
  storage.sql.exec(
    `INSERT INTO sandbox_state (
      session_id, status, sandbox_id, spawn_retry_count, pending_prompt_dispatch,
      sandbox_auth_token_hash, spawn_started_at, last_spawn_attempt_id,
      prompt_last_activity_at, disconnect_started_at, auto_close_scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.sessionId,
    params.status ?? "idle",
    params.sandboxId ?? null,
    params.spawnRetryCount ?? 0,
    params.pendingPromptDispatch ?? 0,
    params.sandboxAuthTokenHash ?? null,
    params.spawnStartedAt ?? null,
    params.lastSpawnAttemptId ?? null,
    params.promptLastActivityAt ?? null,
    params.disconnectStartedAt ?? null,
    params.autoCloseScheduledAt ?? null,
  );
}

/** Parameters for seeding a prompt row. */
export interface SeedPromptParams {
  promptId: string;
  sessionId: string;
  promptText: string;
  actorUserId?: string | null;
  agent?: string | null;
  status?: string;
  createdAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number;
  error?: string | null;
  resultJson?: string | null;
  queuePosition?: number;
  hasPendingQuestion?: number;
  filesJson?: string | null;
  skillsJson?: string | null;
  uploadedFilesJson?: string | null;
  uploadedImagesJson?: string | null;
  planContextJson?: string | null;
  reviewLoopEpochId?: string | null;
  reviewLoopSourceKind?: "bot" | "human" | "mixed" | "merge_conflict" | null;
  // ARC-876: bundled push outcome persisted from the post_execution event.
  pushStatus?: "succeeded" | "failed" | "unknown" | null;
  pushError?: string | null;
}

/** Insert a prompt row. Must be called AFTER DO construction. */
export function seedPrompt(storage: FakeStorage, params: SeedPromptParams): void {
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO prompts (
      prompt_id, session_id, prompt_text, actor_user_id, agent, status,
      created_at, started_at, completed_at, updated_at, error, result_json,
      queue_position, has_pending_question, skills_json, files_json, uploaded_files_json, uploaded_images_json,
      plan_context_json, review_loop_epoch_id, review_loop_source_kind, push_status, push_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.promptId,
    params.sessionId,
    params.promptText,
    params.actorUserId ?? null,
    params.agent ?? null,
    params.status ?? "queued",
    params.createdAt ?? now,
    params.startedAt ?? null,
    params.completedAt ?? null,
    params.updatedAt ?? now,
    params.error ?? null,
    params.resultJson ?? null,
    params.queuePosition ?? 0,
    params.hasPendingQuestion ?? 0,
    params.skillsJson ?? null,
    params.filesJson ?? null,
    params.uploadedFilesJson ?? null,
    params.uploadedImagesJson ?? null,
    params.planContextJson ?? null,
    params.reviewLoopEpochId ?? null,
    params.reviewLoopSourceKind ?? null,
    params.pushStatus ?? null,
    params.pushError ?? null,
  );
}

// ---------------------------------------------------------------------------
// SQL query helpers -- read state back from SQL tables for assertions
// ---------------------------------------------------------------------------

/** Read the session row. Returns null if not found. */
export function querySession(storage: FakeStorage, sessionId: string): Record<string, unknown> | null {
  const rows = storage.sql.exec("SELECT * FROM session WHERE session_id = ?", sessionId).toArray();
  return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

/** Read the sandbox_state row. Returns null if not found. */
export function querySandboxState(storage: FakeStorage, sessionId: string): Record<string, unknown> | null {
  const rows = storage.sql.exec("SELECT * FROM sandbox_state WHERE session_id = ?", sessionId).toArray();
  return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

/**
 * Return the currently-processing prompt id for a session, or null if none.
 * Replaces the legacy `session.active_prompt_id` column reads in tests.
 */
export function queryActiveProcessingPromptId(storage: FakeStorage, sessionId: string): string | null {
  return doDb.getActiveProcessingPromptId(storage.sql as unknown as SqlStorage, sessionId);
}

/**
 * Sets the "currently processing" prompt for a session by flipping
 * prompts.status rows directly. Replaces the legacy
 * `updateSessionFields(sql, { activePromptId })` setup after
 * session.active_prompt_id was dropped (DO migration 70). Any other
 * processing row is marked failed first; if `promptId` is non-null,
 * that row is either inserted with status='processing' (if missing)
 * or flipped from any prior status to 'processing'. Single shared
 * implementation so callers (FakeStorage.legacyPut, sqlUpdateSession
 * in batch-reads, prompt-activity-owner test setup) stay in sync.
 */
export function setActivePromptIdViaPromptRow(sql: SqlStorage, sessionId: string, promptId: string | null): void {
  const now = Date.now();
  sql.exec(
    "UPDATE prompts SET status = 'failed', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE session_id = ? AND status = 'processing' AND prompt_id != COALESCE(?, '')",
    now,
    now,
    sessionId,
    promptId ?? null,
  );
  if (!promptId) return;
  const existing = sql.exec("SELECT prompt_id FROM prompts WHERE prompt_id = ?", promptId).toArray();
  if (existing.length === 0) {
    sql.exec(
      `INSERT INTO prompts (
        prompt_id, session_id, prompt_text, status,
        created_at, started_at, updated_at, queue_position, has_pending_question
      ) VALUES (?, ?, ?, 'processing', ?, ?, ?, 0, 0)`,
      promptId,
      sessionId,
      "test",
      now,
      now,
      now,
    );
  } else {
    sql.exec(
      "UPDATE prompts SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ? WHERE prompt_id = ?",
      now,
      now,
      promptId,
    );
  }
}

/** Read all prompts for a session, ordered by created_at. */
export function queryPrompts(storage: FakeStorage, sessionId: string): Array<Record<string, unknown>> {
  return storage.sql
    .exec("SELECT * FROM prompts WHERE session_id = ? ORDER BY created_at ASC", sessionId)
    .toArray() as Array<Record<string, unknown>>;
}

/** Read all events for a session, ordered by sequence. */
export function queryEvents(storage: FakeStorage, sessionId: string): Array<Record<string, unknown>> {
  return storage.sql
    .exec("SELECT * FROM events WHERE session_id = ? ORDER BY sequence ASC", sessionId)
    .toArray() as Array<Record<string, unknown>>;
}

/** Read parsed event payloads for a session, ordered by sequence. */
export function querySessionEvents(
  storage: FakeStorage,
  sessionId: string,
): Array<{ sequence: number; id: string; type: string; promptId: string | null; data: Record<string, unknown> }> {
  return doDb.getEvents(storage.sql as unknown as SqlStorage, sessionId).map((event) => ({
    sequence: event.sequence,
    id: event.id,
    type: event.type,
    promptId: typeof event.data?.promptId === "string" ? event.data.promptId : null,
    data: event.data,
  }));
}

// ---------------------------------------------------------------------------
// createTestEnv -- minimal env for DO instantiation
// ---------------------------------------------------------------------------

export function createTestEnv(): Record<string, unknown> {
  return {
    DB: new FakeD1(),
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
  };
}

// ---------------------------------------------------------------------------
// Common vi.mock factories -- call these at module top-level
// ---------------------------------------------------------------------------

export function mockCloudflareWorkers() {
  mockHarnessCloudflareWorkers({ setState: true });
}

export function mockSentryCloudflare() {
  vi.mock("@sentry/cloudflare", () => ({
    instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
    withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
    setTag: () => {},
    setUser: () => {},
    captureException: vi.fn(),
  }));
}
