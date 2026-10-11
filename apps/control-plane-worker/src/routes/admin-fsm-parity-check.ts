// ARC-1330 (W11-G3) — the admin trigger for the W11-G1 non-tautological parity checker.
//
// POST /api/admin/fsm/parity-check — batch-run `fsm.parity` over the TERMINAL cohort (MERGED/CLOSED, plus
// MERGE_READY/NEEDS_YOU). The steady-state / dormant divergence samplers only ever pin `review_listening`,
// so post-flip they never observe a terminal — and because `project()` writes the legacy mirror columns
// FROM the spine, a "clean" divergence reading there degrades toward self-agreement (a tautology). This
// route sources ground truth that is INDEPENDENT of both the spine and the legacy mirrors: the GitHub PR's
// own merged/open/closed state via the KEEP'd merge/close poll surface (`getPrMergeStatus`). It emits one
// `fsm.parity` DD event per session and returns the per-session comparison rows + `{agree, diverge,
// no_ground_truth}` tallies.
//
// DEFAULT READ-ONLY. Body: { limit?: number, reconcile?: boolean }. `limit` caps BOTH the cohort enumeration
// AND the per-row GitHub reads (default ~100). It must NOT read the `session_index` mirror columns as ground
// truth (self-agreement), so the token plumbing here resolves an installation token and reads the PR directly
// (mirroring `honest-ci-read.ts`'s resolver idiom).
//
// W11-T2 STOCK RE-EMIT: `reconcile: true` (default false) is the parked-wedge repair. For every diverged row
// whose OBSERVED GitHub PR state is merged/closed (the ground-truth-backed wedge — spine open, PR terminal),
// it emits the matching `pr.merged`/`pr.closed` through `applyEvent`: the normal §10 POST_PUBLISH edge does
// the transition and runs its side-effects (VERIFYING-exit kill, loud fanout) — NO state is
// hand-written. SOUNDNESS: only an observed GitHub terminal mints an event (never a legacy field / timeout);
// a row that already sits in a final terminal is an idempotent no-op. Admin-fired only. Reports {reconciled,
// skipped}.

import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { createLogger } from "../logger";
import { type CronPrTerminal, emitObservedPrTerminal } from "../session/fsm/cron-producer";
import { buildGithubGroundTruthReader, type ParityRow, runTerminalCohortParity } from "../session/fsm/parity-check";
import { assertDatabase } from "../session/state";
import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { parsePattern, requireCycloidAdmin, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "admin-fsm-parity-check" } });

export const adminFsmParityCheckRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/admin/fsm/parity-check"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (routeAuth.authMode !== "admin_token" && routeAuth.authMode !== "ci_automation_token") {
        const guard = await requireCycloidAdmin(env, routeAuth, {
          logger: log,
          logContext: { route: "fsm_parity_check" },
        });
        if (guard) return guard;
      }

      const db = assertDatabase(env);
      // parseJsonBody try/catches internally (null on empty/malformed) — an empty body = a default-limit run.
      const body = (await parseJsonBody(request)) ?? {};

      if (
        body.limit !== undefined &&
        (typeof body.limit !== "number" || !Number.isFinite(body.limit) || body.limit <= 0)
      ) {
        return jsonErrorResponse("limit must be a positive number", 400);
      }
      const limit = typeof body.limit === "number" ? body.limit : undefined;

      if (body.reconcile !== undefined && typeof body.reconcile !== "boolean") {
        return jsonErrorResponse("reconcile must be a boolean", 400);
      }
      const reconcile = body.reconcile === true;

      // The legacy-INDEPENDENT ground-truth reader. Token plumbing lives HERE (never in parity-check.ts —
      // the G1 module injects the reader so it never re-implements installation-token resolution), mirroring
      // `readHeadCiForRecord`: parse `pr_url` owner → installation token. `buildGithubGroundTruthReader`
      // isolates a thrown/null token as `pr_unreadable` (never agreement), so one dead installation can't
      // abort the batch.
      const readGroundTruth = buildGithubGroundTruthReader({
        resolveToken: async (input) => {
          if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return null;
          const installation = await getInstallationByOwner(db, input.owner);
          if (!installation || installation.suspended_at !== null) return null;
          return await createInstallationToken(env, installation.installation_id);
        },
      });

      const { report, rows } = await runTerminalCohortParity({ db, env, readGroundTruth }, { limit });

      if (!reconcile) {
        log.info({ ...report }, "fsm parity check run complete");
        return jsonResponse({ ok: true, report, rows });
      }

      const reconcileReport = await reconcileDivergedTerminals(env, rows);
      log.info({ ...report, ...reconcileReport }, "fsm parity check + reconcile run complete");
      return jsonResponse({ ok: true, report, rows, reconcile: reconcileReport });
    },
  },
];

/**
 * The W11-T2 stock re-emit. For every diverged parity row whose OBSERVED GitHub PR state is merged/closed,
 * mint the matching `pr.merged`/`pr.closed` through `applyEvent` (`internal` actor) so the normal §10 edge
 * transitions the wedged spine row and runs its side-effects — never a hand-written state. Counts a committed
 * transition (`handled`) as `reconciled`; an idempotent no-op (row already final, lost race, unbound/off env)
 * as `skipped`. Sequential + bounded by the parity batch `limit`.
 */
export async function reconcileDivergedTerminals(
  env: Env,
  rows: ParityRow[],
): Promise<{ reconciled: number; skipped: number }> {
  let reconciled = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.result !== "diverge") continue;
    if (row.observedPrState !== "merged" && row.observedPrState !== "closed") continue;
    const terminal: CronPrTerminal = row.observedPrState;
    const result = await emitObservedPrTerminal(env, row.sessionId, terminal, "internal", log);
    if (result?.outcome === "handled") reconciled += 1;
    else skipped += 1;
  }
  return { reconciled, skipped };
}
