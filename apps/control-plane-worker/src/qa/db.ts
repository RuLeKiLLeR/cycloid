import { d1Changed } from "../db/errors";
import { normalizeWebhookReference } from "../utils";

export type QaLoopBindingStatus = "active" | "closed" | "expired";
export type QaLoopBindingTerminalStatus = Exclude<QaLoopBindingStatus, "active">;

export interface QaLoopBindingCreateInput {
  prUrl: string;
  automatedLifecycleId: string;
  qaSessionId: string;
  parentSessionId: string;
  lastScheduledHeadSha: string | null;
  activePromptId: string | null;
}

export interface QaLoopBindingPromptInput {
  prUrl: string;
  automatedLifecycleId: string;
  qaSessionId: string;
  lastScheduledHeadSha: string | null;
  activePromptId: string | null;
}

export interface QaLoopBindingCloseInput {
  prUrl: string;
  automatedLifecycleId: string;
  qaSessionId: string;
  status: QaLoopBindingTerminalStatus;
}

export interface QaLoopBindingRecord {
  prUrl: string;
  automatedLifecycleId: string;
  qaSessionId: string;
  parentSessionId: string;
  status: QaLoopBindingStatus;
  lastScheduledHeadSha: string | null;
  activePromptId: string | null;
  createdAt: number;
  updatedAt: number;
}

function clean(value: string | null): string | null {
  return normalizeWebhookReference(value) ?? null;
}

function rowToQaLoopBindingRecord(row: {
  pr_url: string;
  automated_lifecycle_id: string;
  qa_session_id: string;
  parent_session_id: string;
  status: string;
  last_scheduled_head_sha: string | null;
  active_prompt_id: string | null;
  created_at: number;
  updated_at: number;
}): QaLoopBindingRecord {
  return {
    prUrl: row.pr_url,
    automatedLifecycleId: row.automated_lifecycle_id,
    qaSessionId: row.qa_session_id,
    parentSessionId: row.parent_session_id,
    status: "active",
    lastScheduledHeadSha: row.last_scheduled_head_sha,
    activePromptId: row.active_prompt_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getQaLoopBinding(
  db: D1Database,
  prUrl: string,
  automatedLifecycleId: string,
): Promise<QaLoopBindingRecord | null> {
  const normalizedPrUrl = clean(prUrl);
  const lifecycleId = clean(automatedLifecycleId);
  if (!normalizedPrUrl || !lifecycleId) return null;

  const row = await db
    .prepare(
      `SELECT pr_url, automated_lifecycle_id, qa_session_id, parent_session_id, status,
              last_scheduled_head_sha, active_prompt_id, created_at, updated_at
       FROM qa_loop_session_bindings
       WHERE pr_url = ? AND automated_lifecycle_id = ? AND status = 'active'`,
    )
    .bind(normalizedPrUrl, lifecycleId)
    .first<{
      pr_url: string;
      automated_lifecycle_id: string;
      qa_session_id: string;
      parent_session_id: string;
      status: string;
      last_scheduled_head_sha: string | null;
      active_prompt_id: string | null;
      created_at: number;
      updated_at: number;
    }>();

  return row ? rowToQaLoopBindingRecord(row) : null;
}

export async function createQaLoopBinding(
  db: D1Database,
  input: QaLoopBindingCreateInput,
): Promise<QaLoopBindingRecord | null> {
  const prUrl = clean(input.prUrl);
  const lifecycleId = clean(input.automatedLifecycleId);
  const qaSessionId = clean(input.qaSessionId);
  const parentSessionId = clean(input.parentSessionId);
  if (!prUrl || !lifecycleId || !qaSessionId || !parentSessionId) return null;

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO qa_loop_session_bindings (
         pr_url, automated_lifecycle_id, qa_session_id, parent_session_id, status,
         last_scheduled_head_sha, active_prompt_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT(pr_url, automated_lifecycle_id) DO UPDATE SET
         qa_session_id = excluded.qa_session_id,
         parent_session_id = excluded.parent_session_id,
         status = 'active',
         last_scheduled_head_sha = excluded.last_scheduled_head_sha,
         active_prompt_id = excluded.active_prompt_id,
         updated_at = excluded.updated_at
       WHERE qa_loop_session_bindings.status != 'active'`,
    )
    .bind(
      prUrl,
      lifecycleId,
      qaSessionId,
      parentSessionId,
      clean(input.lastScheduledHeadSha),
      clean(input.activePromptId),
      now,
      now,
    )
    .run();

  return getQaLoopBinding(db, prUrl, lifecycleId);
}

export async function markQaLoopBindingPromptEnqueued(
  db: D1Database,
  input: QaLoopBindingPromptInput,
): Promise<boolean> {
  const prUrl = clean(input.prUrl);
  const lifecycleId = clean(input.automatedLifecycleId);
  const qaSessionId = clean(input.qaSessionId);
  if (!prUrl || !lifecycleId || !qaSessionId) return false;

  const result = await db
    .prepare(
      `UPDATE qa_loop_session_bindings
       SET last_scheduled_head_sha = ?, active_prompt_id = ?, updated_at = ?
       WHERE pr_url = ? AND automated_lifecycle_id = ? AND qa_session_id = ? AND status = 'active'`,
    )
    .bind(clean(input.lastScheduledHeadSha), clean(input.activePromptId), Date.now(), prUrl, lifecycleId, qaSessionId)
    .run();
  return d1Changed(result);
}

export async function closeQaLoopBinding(db: D1Database, input: QaLoopBindingCloseInput): Promise<boolean> {
  const prUrl = clean(input.prUrl);
  const lifecycleId = clean(input.automatedLifecycleId);
  const qaSessionId = clean(input.qaSessionId);
  if (!prUrl || !lifecycleId || !qaSessionId) return false;

  const result = await db
    .prepare(
      `UPDATE qa_loop_session_bindings
       SET status = ?, active_prompt_id = NULL, updated_at = ?
       WHERE pr_url = ? AND automated_lifecycle_id = ? AND qa_session_id = ? AND status = 'active'`,
    )
    .bind(input.status, Date.now(), prUrl, lifecycleId, qaSessionId)
    .run();
  return d1Changed(result);
}
