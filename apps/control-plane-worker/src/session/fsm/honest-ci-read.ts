// ARC-1330 (W11-T1) — HONEST, bounded, best-effort single-head CI read.
//
// The ONE shared token-resolution + one-head `reduceCiState` poll behind every §6 `caught_up`-recompute
// seam that needs an honest CI observation the moment the merge-ready conjunction completes: the
// verdict-return seam (#6381 `verification-producer.ts`), the shared live resolver's `caughtUpInputs`
// snapshot (`live-resolver.ts`), and the parked-stock repair passes (`row7-repair-runner.ts`). Extracted
// so those seams reuse ONE code path (matching the
// #6381 / #6403 idiom: parse `pr_url` → `getInstallationByOwner` → `createInstallationToken` → poll the
// head) instead of re-inlining it.
//
// SOUNDNESS (the whole reason this exists): the read NEVER fabricates green. It returns the raw 4-valued
// `reduceCiState` verdict (`green | absent | failing | pending`) or `undefined` on any missing input /
// read fault. Only a genuine `green`/`absent` classifies to `ci_green` downstream (`classifyCi`); a
// `pending`/faulted read leaves the resolver on its conservative `ci_pending` (cascade row-5 WAIT), so a
// non-green read keeps waiting and the later green `ci.signal` carry still mints MERGE_READY (prior
// behavior). Best-effort: every fault is swallowed to `undefined` — a CI read must never break a commit.
//
// THE ABSENT TRAP (W11-T1 keystone fix): `absent` classifies to `ci_green` (`CI_BUCKET_OF` — the no-CI-repo
// arm), but a SINGLE absent read is NOT proof of a no-CI repo — it is also what checks-not-yet-registered
// (a fresh push) and GitHub-aged-out/GC'd check runs (old parked stock) look like. The sibling #6403
// no-signal-advance producer requires ≥2 consecutive absent polls on the same head for exactly this reason.
// So the SETTLEABLE read below (`readSettleableHeadCiForRecord` — what every row-7 settle seam consumes)
// admits `absent` ONLY when corroborated: the session's own journal already carries a `ci.signal(absent)`
// event (a prior, time-separated absent observation — the #6403 debounce or the legacy sweep's absent-CI
// re-poll already saw it). An uncorroborated absent degrades to `pending` (row-5 WAIT). This is strictly
// MORE conservative than "≥1 historical non-absent observation for the head": a head with real CI history
// that now reads absent (aged-out runs) also degrades to `pending` — never a fabricated green. Genuinely
// no-CI repos still settle through the existing carriers (#6403's debounced emit / the sweep's re-poll),
// whose journaled `ci.signal(absent)` is precisely what corroborates every later settleable read. The raw
// `readHeadCiForRecord` stays exported for callers that debounce on their own (none today — #6403 owns its
// own read + DO-storage debounce and does not route through this helper).
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import { getInstallationByOwner } from "../../github/installations-db";
import { createInstallationToken } from "../../github/octokit";
import { parseGithubPullRequestUrl } from "../../github/verification-pr-context";
import { readHeadCiState, type ReviewLoopCiState } from "../../services/review-loop-rollup";
import type { Env } from "../../types";

/**
 * HONEST, bounded, best-effort CI observation for a record's live head (LIVE-only cohorts). Resolves the
 * record's PR `owner`/`repo` + an installation token (mirroring `verification-gate.ts`'s
 * `checkVerificationConflict` idiom), polls the ONE head's check-runs + status contexts, and reduces them
 * to a coarse {@link ReviewLoopCiState}. Returns `undefined` on any missing input (no creds / no D1 / no
 * PR url / no head / unparseable url / no or suspended installation) OR any read fault — the caller owns
 * the conservative fallback (`ci_pending`). Reads the record's CURRENT head (kept fresh by head.changed
 * webhooks), the same head the cascade's `ci_green(H)` + `verificationFresh` evaluate, so a head that
 * moved since the verdict is handled by the cascade's staleness rows, never a false MERGE_READY.
 *
 * `absent` (a no-CI repo) is a REAL read result and reduces to `ci_green` downstream (design §6 / `CI_BUCKET_OF`);
 * this helper does not itself classify — it returns the raw verdict so a caller can distinguish `absent`
 * from `green` where it matters (e.g. the `ci.signal` re-emit picks the honest event state).
 */
export async function readHeadCiForRecord(
  env: Env,
  prUrl: string | null,
  headSha: string | null,
): Promise<ReviewLoopCiState | undefined> {
  try {
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return undefined;
    const db = env.DB;
    if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return undefined;
    if (!prUrl || !headSha) return undefined;
    const parsed = parseGithubPullRequestUrl(prUrl);
    if (!parsed) return undefined;
    const installation = await getInstallationByOwner(db, parsed.owner);
    if (!installation || installation.suspended_at !== null) return undefined;
    const token = await createInstallationToken(env, installation.installation_id);
    return await readHeadCiState(token, parsed.owner, parsed.repo, headSha);
  } catch {
    return undefined;
  }
}

/**
 * Whether a fresh `absent` read is CORROBORATED for this session: the append-only journal already carries
 * a `ci.signal` event whose `ciState` was `absent` — a prior, time-separated absent observation (the #6403
 * ≥2-consecutive-absent debounce satisfied across observations, or the legacy sweep's absent-CI re-poll).
 * Best-effort: a query fault reads as NOT corroborated (fail toward the row-5 WAIT, never a false green).
 */
export async function isAbsentCiCorroborated(db: D1Database, sessionId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS corroborated FROM pr_coordination_events
          WHERE session_id = ? AND event = 'ci.signal'
            AND json_extract(metadata, '$.ciState') = 'absent'
          LIMIT 1`,
      )
      .bind(sessionId)
      .first<{ corroborated: number }>();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * The SETTLEABLE honest read — what every row-7 settle seam consumes (the verdict-return seam, the shared
 * live resolver's `caughtUpInputs`, the no-show settle). Identical to {@link readHeadCiForRecord} except
 * for the absent trap (see the file header): an UNCORROBORATED `absent` degrades to `pending` (cascade
 * row-5 WAIT), so a single absent poll can never be the observation that mints MERGE_READY. A corroborated
 * absent passes through unchanged (the genuine no-CI-repo arm, `CI_BUCKET_OF: absent → ci_green`).
 */
export async function readSettleableHeadCiForRecord(
  env: Env,
  sessionId: string,
  prUrl: string | null,
  headSha: string | null,
): Promise<ReviewLoopCiState | undefined> {
  const ci = await readHeadCiForRecord(env, prUrl, headSha);
  if (ci !== "absent") return ci;
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return "pending";
  return (await isAbsentCiCorroborated(db, sessionId)) ? "absent" : "pending";
}
