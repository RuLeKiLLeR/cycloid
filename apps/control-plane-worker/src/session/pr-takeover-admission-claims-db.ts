import { normalizeGithubPullRequestUrl } from "../../../../shared/agent/verify-directive.js";
import { d1Changed } from "../db/errors";

interface PrTakeoverAdmissionClaimRow {
  session_id: string;
}

const TERMINAL_PR_COORDINATION_STATES = "'MERGED', 'CLOSED', 'SUPERSEDED', 'ARCHIVED'";
const PR_TAKEOVER_ADMISSION_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Atomically reserves a pull request for a first-class takeover session.
 *
 * A completed coordinator can be replaced, but an in-flight claim remains
 * exclusive even before its normal pr_coordination row is populated.
 */
export async function claimPrTakeoverAdmission(
  db: D1Database,
  args: { prUrl: string; sessionId: string; now?: number; staleAfterMs?: number },
): Promise<{ won: boolean; sessionId: string }> {
  const now = args.now ?? Date.now();
  const prUrl = normalizeClaimPrUrl(args.prUrl);
  const staleAfterMs = args.staleAfterMs ?? PR_TAKEOVER_ADMISSION_CLAIM_STALE_AFTER_MS;
  const result = await db
    .prepare(
      `INSERT INTO pr_takeover_admission_claims (pr_url, session_id, claimed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(pr_url) DO UPDATE SET
         session_id = excluded.session_id,
         claimed_at = excluded.claimed_at
       WHERE pr_takeover_admission_claims.session_id = excluded.session_id
          OR EXISTS (
            SELECT 1
            FROM pr_coordination
            WHERE session_id = pr_takeover_admission_claims.session_id
              AND state IN (${TERMINAL_PR_COORDINATION_STATES})
          )
          OR (
            pr_takeover_admission_claims.claimed_at < ?
            AND NOT EXISTS (
              SELECT 1
              FROM pr_coordination
              WHERE session_id = pr_takeover_admission_claims.session_id
                AND state NOT IN (${TERMINAL_PR_COORDINATION_STATES})
            )
            AND NOT EXISTS (
              SELECT 1
              FROM session_index
              WHERE session_id = pr_takeover_admission_claims.session_id
                AND status = 'active'
            )
          )`,
    )
    .bind(prUrl, args.sessionId, now, now - staleAfterMs)
    .run();

  if (d1Changed(result)) return { won: true, sessionId: args.sessionId };

  const existing = await db
    .prepare(
      `SELECT session_id
       FROM pr_takeover_admission_claims
       WHERE pr_url = ?
       LIMIT 1`,
    )
    .bind(prUrl)
    .first<PrTakeoverAdmissionClaimRow>();
  if (!existing) throw new Error(`PR takeover admission claim disappeared for ${prUrl}`);

  return { won: false, sessionId: existing.session_id };
}

/** Release an unprojected claim after session initialization or persistence fails. */
export async function releasePrTakeoverAdmission(
  db: D1Database,
  args: { prUrl: string; sessionId: string },
): Promise<void> {
  const prUrl = normalizeClaimPrUrl(args.prUrl);
  await db
    .prepare(`DELETE FROM pr_takeover_admission_claims WHERE pr_url = ? AND session_id = ?`)
    .bind(prUrl, args.sessionId)
    .run();
}

function normalizeClaimPrUrl(prUrl: string): string {
  const normalized = normalizeGithubPullRequestUrl(prUrl);
  if (!normalized) throw new Error(`Invalid PR takeover admission URL: ${prUrl}`);
  return normalized.toLowerCase();
}
