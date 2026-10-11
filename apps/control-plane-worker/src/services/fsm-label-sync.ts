// ARC-1330 (W11-P2) — the canonical PR-label IO writer. Applies `labelsOf(record)` to a GitHub PR,
// reconciling the managed-label namespace (fsm/label-projection.ts) to exactly the projected set.
//
// This SUPERSEDES the three legacy label writers (`syncVerificationStateLabels`, `syncReviewLoopLabels`,
// `clearSynchronizeStaleReviewLoopLabels`). Their call sites delegate here instead;
// the legacy lists survive (un-deleted) until D-59b. Best-effort like the legacy reconcilers: labels are
// a cosmetic mirror of the spine row (the source of truth), so a GitHub failure is logged and swallowed.

import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { addLabels, ensureRepoLabel, listLabels, removeLabel } from "../github/pr";
import { parseGithubPullRequestUrl } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import {
  FSM_MANAGED_LABEL_META,
  labelsForPersistedRecord,
  reconcileFsmLabelSet,
} from "../session/fsm/label-projection";
import { getPrCoordination } from "../session/pr-coordination-db";
import type { Env } from "../types";
import { normalizeWebhookReference } from "../utils";

/** Result of a canonical label reconcile — the managed labels actually applied/removed on the PR. */
export interface FsmLabelSyncResult {
  added: string[];
  removed: string[];
}

function emptyResult(): FsmLabelSyncResult {
  return { added: [], removed: [] };
}

function logLabelRejections(
  results: PromiseSettledResult<unknown>[],
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): void {
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ owner, repo, prNumber, error: String(result.reason) }, "FSM label reconcile write failed");
    }
  }
}

/**
 * Token-level canonical reconcile: make the PR's MANAGED labels exactly `desired`, never touching a
 * non-managed label. DIFF-BASED targeted add/remove — deliberately NOT a full-set `setLabels` PUT
 * (mirroring legacy `syncReviewLoopLabels`' discipline): a full-set PUT snapshots the label list and
 * would permanently clobber a label a concurrent writer (a user, another reconciler) adds between our
 * read and our write. Targeted ops only ever name managed labels from the computed diff, so a
 * concurrently-added label structurally cannot be dropped, while managed-axis exactness is preserved
 * (every stale managed label in the diff is removed; the next tick self-heals any race remainder).
 *
 * `ensureRepoLabel` (fail-closed) runs before each add so a net-new §12 label the repo lacks cannot
 * 422 the add; an un-ensurable label is skipped (logged), the rest still apply. Remove-before-add so a
 * stale managed label clears before its replacement lands. allSettled + logged rejections — a single
 * failed write never abandons the others. Never throws.
 */
export async function syncFsmLabels(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  desired: readonly string[],
  opts: { currentLabels?: string[] | null; logger: Logger },
): Promise<FsmLabelSyncResult> {
  const { logger } = opts;
  try {
    const currentLabels = opts.currentLabels ?? (await listLabels(token, owner, repo, prNumber));
    const plan = reconcileFsmLabelSet(currentLabels, desired);
    if (!plan.changed) return emptyResult();

    const removed: string[] = [];
    const removeResults = await Promise.allSettled(
      plan.removed.map(async (label) => {
        await removeLabel(token, owner, repo, prNumber, label);
        removed.push(label);
      }),
    );

    const added: string[] = [];
    const addResults = await Promise.allSettled(
      plan.added.map(async (label) => {
        const meta = FSM_MANAGED_LABEL_META[label];
        if (!meta) return; // desired is a subset of the managed namespace; defensive only.
        const ensured = await ensureRepoLabel(token, owner, repo, label, meta.color, meta.description);
        if (!ensured.ok) {
          logger.warn(
            { owner, repo, prNumber, label, reason: ensured.reason, status: ensured.status },
            "FSM label ensure failed; skipping add",
          );
          return;
        }
        await addLabels(token, owner, repo, prNumber, [label]);
        added.push(label);
      }),
    );

    logLabelRejections([...removeResults, ...addResults], owner, repo, prNumber, logger);
    return { added, removed };
  } catch (error) {
    logger.warn({ owner, repo, prNumber, error: String(error) }, "FSM label reconcile failed");
    return emptyResult();
  }
}

async function resolveInstallationId(
  env: Env,
  prUrl: string,
  input: { installationId?: number | null; repoOwner?: string | null; repoName?: string | null },
): Promise<number | null> {
  const parsed = parseGithubPullRequestUrl(prUrl);
  if (!parsed) return null;
  const hintMatches =
    input.repoOwner?.toLowerCase() === parsed.owner.toLowerCase() &&
    input.repoName?.toLowerCase() === parsed.repo.toLowerCase();
  if (hintMatches && typeof input.installationId === "number" && input.installationId > 0) {
    return input.installationId;
  }
  const installation = await getInstallationByOwner(env.DB, parsed.owner);
  return installation && installation.suspended_at === null ? installation.installation_id : null;
}

/**
 * Env-level canonical reconcile: load the session's spine row, project `labelsOf(record)`, and apply it
 * to the PR. The drop-in replacement for `syncVerificationStateLabelsForPr` at the live-cutover call
 * sites. Returns early (no-op) when there is no spine row for the session (genesis/backfill has not run)
 * or the row's state is unknown — the sweep's periodic reconcile self-heals either way. Never throws.
 */
export async function syncFsmLabelsForPr(
  env: Env,
  options: {
    prUrl: string;
    sessionId: string;
    installationId?: number | null;
    repoOwner?: string | null;
    repoName?: string | null;
    /** Current label set from a per-tick PR fetch, for write-dedup; null/omitted → the writer fetches. */
    currentLabels?: string[] | null;
    /** Reuse a caller-minted installation token (the sweep/webhook already have one). */
    tokenHint?: string;
    logger: Logger;
  },
): Promise<FsmLabelSyncResult> {
  const prUrl = normalizeWebhookReference(options.prUrl);
  const parsed = prUrl ? parseGithubPullRequestUrl(prUrl) : null;
  if (!prUrl || !parsed) return emptyResult();

  try {
    const record = await getPrCoordination(env.DB, options.sessionId);
    if (!record) return emptyResult();

    let desired: readonly string[];
    try {
      desired = labelsForPersistedRecord(record);
    } catch (error) {
      options.logger.warn(
        { prUrl, sessionId: options.sessionId, state: record.state, error: String(error) },
        "FSM label projection skipped: unknown spine state",
      );
      return emptyResult();
    }

    const token =
      options.tokenHint ??
      (await (async () => {
        const installationId = await resolveInstallationId(env, prUrl, options);
        if (!installationId) {
          options.logger.warn({ prUrl, sessionId: options.sessionId }, "FSM label reconcile skipped installation");
          return null;
        }
        return createInstallationToken(env, installationId);
      })());
    if (!token) return emptyResult();

    return await syncFsmLabels(token, parsed.owner, parsed.repo, parsed.number, desired, {
      currentLabels: options.currentLabels ?? null,
      logger: options.logger,
    });
  } catch (error) {
    options.logger.warn({ prUrl, sessionId: options.sessionId, error: String(error) }, "FSM label sync failed");
    return emptyResult();
  }
}
