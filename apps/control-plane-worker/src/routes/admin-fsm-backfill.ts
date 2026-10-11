// ARC-1330 lifecycle FSM (PR 35A wiring) — the one-shot backfill admin route.
//
// POST /api/admin/fsm/backfill — enumerate the active session fleet and materialize a `pr_coordination`
// row for every in-flight legacy session (the flip precondition + the divergence-soak cohort). Admin-token
// (or browser-admin) gated; the write path is idempotent, so a re-run is safe. Body: `{ dryRun?: boolean, limit?: number, rebaseline?: boolean,
// staleCutoffHours?: number }` — `dryRun` classifies without writing; `limit` caps processed sessions
// (staged rollout / smoke); `staleCutoffHours` tunes the stale-session fence (absent = the 12h default,
// `0`/`null` = fence disabled — the escape hatch for a deliberate manual backfill of one old session).
// Returns the batch tally.

import { createLogger } from "../logger";
import {
  DEFAULT_BACKFILL_STALE_CUTOFF_MS,
  listActiveSessionsForBackfill,
  runFsmBackfill,
} from "../session/fsm/backfill-runner";
import { assertDatabase, getSessionState } from "../session/state";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { parsePattern, requireCycloidAdmin, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "admin-fsm-backfill" } });

export const adminFsmBackfillRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/admin/fsm/backfill"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (routeAuth.authMode !== "admin_token" && routeAuth.authMode !== "ci_automation_token") {
        const guard = await requireCycloidAdmin(env, routeAuth, {
          logger: log,
          logContext: { route: "fsm_backfill" },
        });
        if (guard) return guard;
      }

      const db = assertDatabase(env);
      // parseJsonBody try/catches internally (null on empty/malformed) — an empty body = a full live run.
      const body = (await parseJsonBody(request)) ?? {};
      const dryRun = body.dryRun === true;
      if (
        body.limit !== undefined &&
        (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit <= 0)
      ) {
        return jsonErrorResponse("limit must be a positive integer", 400);
      }
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      // Optional phase scope (e.g. "review_listening" for the soak cohort) — bounds the enumeration so a
      // single run completes instead of loading the whole (mostly-inert) active fleet sequentially.
      const phase = typeof body.phase === "string" && body.phase.length > 0 ? body.phase : undefined;
      // PR 46 re-baseline mode: rewrite still-at-version-0 rows an earlier (pre-fix) runner deployment
      // seeded, from current legacy state; producer-advanced (version >= 1) rows are never touched.
      const rebaseline = body.rebaseline === true;
      // The stale-session fence (Jag, 2026-07-01): absent = the 12h default; 0/null = fence DISABLED
      // (deliberate manual backfill of an old session); a positive number = that many hours.
      const rawStaleCutoffHours = body.staleCutoffHours;
      let staleActivityCutoffMs: number | null;
      if (rawStaleCutoffHours === undefined) {
        staleActivityCutoffMs = DEFAULT_BACKFILL_STALE_CUTOFF_MS;
      } else if (rawStaleCutoffHours === null || rawStaleCutoffHours === 0) {
        staleActivityCutoffMs = null;
      } else if (
        typeof rawStaleCutoffHours === "number" &&
        Number.isFinite(rawStaleCutoffHours) &&
        rawStaleCutoffHours > 0
      ) {
        staleActivityCutoffMs = rawStaleCutoffHours * 60 * 60 * 1000;
      } else {
        return jsonErrorResponse("staleCutoffHours must be a non-negative number (0 disables the stale fence)", 400);
      }

      const report = await runFsmBackfill(
        {
          db,
          now: () => Date.now(),
          listActiveSessions: () => listActiveSessionsForBackfill(db, { phase }),
          loadSession: (sessionId) => getSessionState(env, sessionId),
        },
        { dryRun, limit, rebaseline, staleActivityCutoffMs },
      );

      log.info({ phase: phase ?? null, ...report }, "fsm backfill run complete");
      return jsonResponse({ ok: true, phase: phase ?? null, report });
    },
  },
];
