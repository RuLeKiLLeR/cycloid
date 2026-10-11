import { PR_REVIEW_TRIGGER_CLAIM_STALE_AFTER_MS } from "../constants/pr-review-trigger";
import { d1Changed } from "../db/errors";

interface PrReviewTriggerClaimRow {
  pr_url: string;
  claimed_at: number;
  trigger_comment_id: number;
  session_id: string | null;
  claim_token: string;
  status: "in_flight" | "completed";
  trigger_source: "webhook" | "auto";
}

export interface PrReviewTriggerClaim {
  prUrl: string;
  claimedAt: number;
  triggerCommentId: number;
  sessionId: string | null;
  claimToken: string;
  status: "in_flight" | "completed";
  triggerSource: "webhook" | "auto";
}

function resolveClaimToken(args: { claimToken?: string; triggerCommentId?: number }): string {
  if (args.claimToken) return args.claimToken;
  if (args.triggerCommentId !== undefined) return `comment:${args.triggerCommentId}`;
  throw new Error("A PR review claim token is required");
}

export async function claimPrReviewTrigger(
  db: D1Database,
  args: {
    prUrl: string;
    triggerCommentId?: number;
    claimToken?: string;
    triggerSource?: "webhook" | "auto";
    now?: number;
    staleAfterMs?: number;
  },
): Promise<{ won: boolean }> {
  const now = args.now ?? Date.now();
  const staleAfterMs = args.staleAfterMs ?? PR_REVIEW_TRIGGER_CLAIM_STALE_AFTER_MS;
  const result = await db
    .prepare(
      `INSERT INTO pr_review_trigger_claims
         (pr_url, claimed_at, trigger_comment_id, claim_token, status, trigger_source, session_id)
       VALUES (?, ?, ?, ?, 'in_flight', ?, NULL)
       ON CONFLICT(pr_url) DO UPDATE SET
         claimed_at = excluded.claimed_at,
         trigger_comment_id = excluded.trigger_comment_id,
         claim_token = excluded.claim_token,
         status = 'in_flight',
         trigger_source = excluded.trigger_source,
         session_id = NULL
       WHERE pr_review_trigger_claims.status != 'completed'
         AND pr_review_trigger_claims.claimed_at < ?`,
    )
    .bind(
      args.prUrl,
      now,
      args.triggerCommentId ?? 0,
      resolveClaimToken(args),
      args.triggerSource ?? "webhook",
      now - staleAfterMs,
    )
    .run();

  return { won: d1Changed(result) };
}

export async function associatePrReviewTriggerSession(
  db: D1Database,
  args: { prUrl: string; triggerCommentId?: number; claimToken?: string; sessionId: string },
): Promise<{ updated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE pr_review_trigger_claims
       SET session_id = ?
       WHERE pr_url = ? AND claim_token = ? AND status = 'in_flight'`,
    )
    .bind(args.sessionId, args.prUrl, resolveClaimToken(args))
    .run();

  return { updated: d1Changed(result) };
}

export async function completePrReviewTrigger(
  db: D1Database,
  args: { prUrl: string; claimToken: string },
): Promise<{ updated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE pr_review_trigger_claims
       SET status = 'completed'
       WHERE pr_url = ? AND claim_token = ? AND session_id IS NOT NULL AND status = 'in_flight'`,
    )
    .bind(args.prUrl, args.claimToken)
    .run();
  return { updated: d1Changed(result) };
}

export async function releasePrReviewTrigger(
  db: D1Database,
  args: { prUrl: string; triggerCommentId?: number; claimToken?: string },
): Promise<void> {
  await db
    .prepare(`DELETE FROM pr_review_trigger_claims WHERE pr_url = ? AND claim_token = ? AND status = 'in_flight'`)
    .bind(args.prUrl, resolveClaimToken(args))
    .run();
}

export async function getPrReviewTriggerClaim(
  db: D1Database,
  args: { prUrl: string },
): Promise<PrReviewTriggerClaim | null> {
  const row = await db
    .prepare(
      `SELECT pr_url, claimed_at, trigger_comment_id, claim_token, status, trigger_source, session_id
       FROM pr_review_trigger_claims
       WHERE pr_url = ?
       LIMIT 1`,
    )
    .bind(args.prUrl)
    .first<PrReviewTriggerClaimRow>();

  return row
    ? {
        prUrl: row.pr_url,
        claimedAt: row.claimed_at,
        triggerCommentId: row.trigger_comment_id,
        sessionId: row.session_id,
        claimToken: row.claim_token,
        status: row.status,
        triggerSource: row.trigger_source,
      }
    : null;
}
