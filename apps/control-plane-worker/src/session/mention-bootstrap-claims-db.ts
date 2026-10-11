import { MENTION_BOOTSTRAP_CLAIM_STALE_AFTER_MS } from "../constants/mention-bootstrap";
import { d1Changed } from "../db/errors";

interface MentionBootstrapClaimRow {
  business_id: string;
  pr_url: string;
  claimed_at: number;
}

export async function claimMentionBootstrap(
  db: D1Database,
  args: {
    businessId: string;
    prUrl: string;
    now?: number;
    staleAfterMs?: number;
  },
): Promise<{ won: boolean }> {
  const now = args.now ?? Date.now();
  const staleAfterMs = args.staleAfterMs ?? MENTION_BOOTSTRAP_CLAIM_STALE_AFTER_MS;
  const result = await db
    .prepare(
      `INSERT INTO mention_bootstrap_claims (business_id, pr_url, claimed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(business_id, pr_url) DO UPDATE SET claimed_at = excluded.claimed_at
       WHERE mention_bootstrap_claims.claimed_at < ?`,
    )
    .bind(args.businessId, args.prUrl, now, now - staleAfterMs)
    .run();

  return { won: d1Changed(result) };
}

export async function releaseMentionBootstrap(
  db: D1Database,
  args: { businessId: string; prUrl: string },
): Promise<void> {
  await db
    .prepare(`DELETE FROM mention_bootstrap_claims WHERE business_id = ? AND pr_url = ?`)
    .bind(args.businessId, args.prUrl)
    .run();
}

export async function getMentionBootstrapClaim(
  db: D1Database,
  args: { businessId: string; prUrl: string },
): Promise<{ businessId: string; prUrl: string; claimedAt: number } | null> {
  const row = await db
    .prepare(
      `SELECT business_id, pr_url, claimed_at
       FROM mention_bootstrap_claims
       WHERE business_id = ? AND pr_url = ?
       LIMIT 1`,
    )
    .bind(args.businessId, args.prUrl)
    .first<MentionBootstrapClaimRow>();

  return row
    ? {
        businessId: row.business_id,
        prUrl: row.pr_url,
        claimedAt: row.claimed_at,
      }
    : null;
}
