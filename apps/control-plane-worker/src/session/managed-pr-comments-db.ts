import { computeSha256Hex } from "../crypto";
import { d1Changed } from "../db/errors";

export type ManagedPrCommentState = "started" | "skipped" | "stopped" | "result" | "metadata";

const MANAGED_PR_COMMENT_LEASE_MS = 30_000;

export interface ManagedPrCommentIdentity {
  repoOwner: string;
  repoName: string;
  installationId: number;
  prNumber: number;
  prUrl: string;
  kind: string;
}

export interface ManagedPrCommentDecisionInput {
  currentOwnerSessionId: string | null;
  currentStateRank: number | null;
  currentPromptId?: string | null;
  currentHeadSha?: string | null;
  incomingOwnerSessionId: string | null;
  incomingState: ManagedPrCommentState;
  incomingPromptId?: string | null;
  incomingHeadSha?: string | null;
}

export interface BeginManagedPrCommentUpdateInput {
  identity: ManagedPrCommentIdentity;
  ownerSessionId?: string | null;
  promptId?: string | null;
  headSha?: string | null;
  state: ManagedPrCommentState;
  body: string;
  now?: number;
}

export type BeginManagedPrCommentUpdateResult =
  | { apply: true; bodyHash: string; leaseOwner: string }
  | { apply: false; reason: "not_owner" | "stale_state" | "lease_busy" };

export function managedPrCommentStateRank(state: ManagedPrCommentState): number {
  switch (state) {
    case "started":
      return 1;
    case "skipped":
      return 2;
    case "stopped":
      return 3;
    case "result":
      return 4;
    case "metadata":
      return 0;
  }
}

export function shouldApplyManagedPrCommentUpdate(input: ManagedPrCommentDecisionInput): boolean {
  if (
    input.incomingState === "metadata" &&
    input.currentOwnerSessionId &&
    input.incomingOwnerSessionId &&
    input.currentOwnerSessionId !== input.incomingOwnerSessionId
  ) {
    return false;
  }
  if (input.incomingState === "metadata") return true;
  const currentRank = input.currentStateRank ?? 0;
  const incomingRank = managedPrCommentStateRank(input.incomingState);
  if (incomingRank > currentRank) return true;
  if (incomingRank < currentRank) return false;
  return isSameManagedPrCommentFreshnessScope(input);
}

function isSameManagedPrCommentFreshnessScope(input: ManagedPrCommentDecisionInput): boolean {
  const currentPromptId = input.currentPromptId?.trim() ?? "";
  const incomingPromptId = input.incomingPromptId?.trim() ?? "";
  if (currentPromptId && incomingPromptId && currentPromptId !== incomingPromptId) return false;

  const currentHeadSha = input.currentHeadSha?.trim() ?? "";
  const incomingHeadSha = input.incomingHeadSha?.trim() ?? "";
  if (currentHeadSha && incomingHeadSha && currentHeadSha !== incomingHeadSha) return false;

  return true;
}

export async function beginManagedPrCommentUpdate(
  db: D1Database,
  input: BeginManagedPrCommentUpdateInput,
): Promise<BeginManagedPrCommentUpdateResult> {
  const now = input.now ?? Date.now();
  const stateRank = managedPrCommentStateRank(input.state);
  const bodyHash = await computeSha256Hex(input.body);
  const leaseOwner = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO managed_pr_comments (
         repo_owner, repo_name, installation_id, pr_number, kind, pr_url,
         owner_session_id, comment_id, body_hash, prompt_id, head_sha, state, state_rank,
         lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.identity.repoOwner,
      input.identity.repoName,
      input.identity.installationId,
      input.identity.prNumber,
      input.identity.kind,
      input.identity.prUrl,
      input.ownerSessionId ?? null,
      bodyHash,
      input.promptId ?? null,
      input.headSha ?? null,
      input.state === "metadata" ? "started" : input.state,
      input.state === "metadata" ? 1 : stateRank,
      leaseOwner,
      now + MANAGED_PR_COMMENT_LEASE_MS,
      now,
      now,
    )
    .run();
  if (d1Changed(inserted)) return { apply: true, bodyHash, leaseOwner };

  const row = await db
    .prepare(
      `SELECT owner_session_id, state_rank, prompt_id, head_sha
       FROM managed_pr_comments
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ? AND kind = ?
       LIMIT 1`,
    )
    .bind(
      input.identity.repoOwner,
      input.identity.repoName,
      input.identity.installationId,
      input.identity.prNumber,
      input.identity.kind,
    )
    .first<{
      owner_session_id: string | null;
      state_rank: number | null;
      prompt_id: string | null;
      head_sha: string | null;
    }>();

  if (
    !shouldApplyManagedPrCommentUpdate({
      currentOwnerSessionId: row?.owner_session_id ?? null,
      currentStateRank: row?.state_rank ?? null,
      currentPromptId: row?.prompt_id ?? null,
      currentHeadSha: row?.head_sha ?? null,
      incomingOwnerSessionId: input.ownerSessionId ?? null,
      incomingState: input.state,
      incomingPromptId: input.promptId ?? null,
      incomingHeadSha: input.headSha ?? null,
    })
  ) {
    if (
      input.state === "metadata" &&
      row?.owner_session_id &&
      input.ownerSessionId &&
      row.owner_session_id !== input.ownerSessionId
    ) {
      return { apply: false, reason: "not_owner" };
    }
    return { apply: false, reason: "stale_state" };
  }

  const claimed = await db
    .prepare(
      `UPDATE managed_pr_comments
       SET
         pr_url = ?,
         owner_session_id = CASE
           WHEN ? = 'metadata' THEN COALESCE(owner_session_id, ?)
           ELSE COALESCE(?, owner_session_id)
         END,
         body_hash = ?,
         prompt_id = COALESCE(?, prompt_id),
         head_sha = COALESCE(?, head_sha),
         state = CASE
           WHEN ? = 'metadata' THEN state
           ELSE ?
         END,
         state_rank = CASE
           WHEN ? = 'metadata' THEN state_rank
           ELSE ?
         END,
         lease_owner = ?,
         lease_expires_at = ?,
         updated_at = ?
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ? AND kind = ?
         AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
         AND (
           ? = 'metadata'
           OR state_rank < ?
           OR (
             state_rank = ?
             AND (? IS NULL OR prompt_id IS NULL OR prompt_id = ?)
             AND (? IS NULL OR head_sha IS NULL OR head_sha = ?)
           )
         )`,
    )
    .bind(
      input.identity.prUrl,
      input.state,
      input.ownerSessionId ?? null,
      input.ownerSessionId ?? null,
      bodyHash,
      input.promptId ?? null,
      input.headSha ?? null,
      input.state,
      input.state,
      input.state,
      stateRank,
      leaseOwner,
      now + MANAGED_PR_COMMENT_LEASE_MS,
      now,
      input.identity.repoOwner,
      input.identity.repoName,
      input.identity.installationId,
      input.identity.prNumber,
      input.identity.kind,
      now,
      leaseOwner,
      input.state,
      stateRank,
      stateRank,
      input.promptId ?? null,
      input.promptId ?? null,
      input.headSha ?? null,
      input.headSha ?? null,
    )
    .run();
  if (!d1Changed(claimed)) return { apply: false, reason: "lease_busy" };
  return { apply: true, bodyHash, leaseOwner };
}

export async function markManagedPrCommentPublished(
  db: D1Database,
  identity: ManagedPrCommentIdentity,
  input: { commentId: number; bodyHash: string; leaseOwner: string; now?: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE managed_pr_comments
       SET comment_id = ?, body_hash = ?, lease_owner = NULL, lease_expires_at = 0, updated_at = ?
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ? AND kind = ? AND lease_owner = ?`,
    )
    .bind(
      input.commentId,
      input.bodyHash,
      input.now ?? Date.now(),
      identity.repoOwner,
      identity.repoName,
      identity.installationId,
      identity.prNumber,
      identity.kind,
      input.leaseOwner,
    )
    .run();
}

export async function releaseManagedPrCommentLease(
  db: D1Database,
  identity: ManagedPrCommentIdentity,
  leaseOwner: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE managed_pr_comments
       SET lease_owner = NULL, lease_expires_at = 0, updated_at = ?
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ? AND kind = ? AND lease_owner = ?`,
    )
    .bind(
      now,
      identity.repoOwner,
      identity.repoName,
      identity.installationId,
      identity.prNumber,
      identity.kind,
      leaseOwner,
    )
    .run();
}
