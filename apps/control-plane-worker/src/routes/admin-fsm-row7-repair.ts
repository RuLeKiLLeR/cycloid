// ARC-1330 (W11-T1) — the one-shot row-7 parked-stock repair admin route.
//
// POST /api/admin/fsm/row7-repair — repair the STANDING STOCK that parked at cascade row-5 `ci_pending`
// (or drained on into `NEEDS_YOU(review_stuck)`) before #6381/#6403/the caughtUpInputs honest-CI reads
// stopped new sessions from parking. Admin-token (or browser-admin) gated. Body:
//   { target?: "review" | "needs_you", dryRun?: boolean, limit?: number }
//   • `target`  — `review` (default; part 2, re-emit honest ci.signal) or `needs_you` (part 3, CAS the
//                 stuck row back to REVIEW then re-emit). `needs_you` is Jag's deliberate call to fire.
//   • `dryRun`  — DEFAULTS TRUE (dryRun-first): reads + classifies (incl. the CI poll) but writes NOTHING.
//                 Pass `dryRun: false` to actually emit/reopen.
//   • `limit`   — cap processed rows (staged rollout / smoke); absent = the runner's bound.
// Returns the batch tally. Idempotent (a re-run is safe).

import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { shadowEmitCiSignal } from "../session/fsm/ci-producer";
import { isAbsentCiCorroborated, readHeadCiForRecord } from "../session/fsm/honest-ci-read";
import { type Row7RepairTarget, runRow7Repair } from "../session/fsm/row7-repair-runner";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { parsePattern, requireCycloidAdmin, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "admin-fsm-row7-repair" } });

const VALID_TARGETS: ReadonlySet<string> = new Set<Row7RepairTarget>(["review", "needs_you"]);

export const adminFsmRow7RepairRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/admin/fsm/row7-repair"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (routeAuth.authMode !== "admin_token" && routeAuth.authMode !== "ci_automation_token") {
        const guard = await requireCycloidAdmin(env, routeAuth, {
          logger: log,
          logContext: { route: "fsm_row7_repair" },
        });
        if (guard) return guard;
      }

      const db = assertDatabase(env);
      // parseJsonBody try/catches internally (null on empty/malformed) — an empty body = a `review` DRY RUN.
      const body = (await parseJsonBody(request)) ?? {};

      const rawTarget = body.target;
      const target: Row7RepairTarget = rawTarget === undefined ? "review" : (rawTarget as Row7RepairTarget);
      if (!VALID_TARGETS.has(target)) {
        return jsonErrorResponse('target must be "review" or "needs_you"', 400);
      }
      // dryRun-first: a repair only writes when dryRun is EXPLICITLY false (an accidental/empty POST reads).
      const dryRun = body.dryRun !== false;
      if (
        body.limit !== undefined &&
        (typeof body.limit !== "number" || !Number.isFinite(body.limit) || body.limit <= 0)
      ) {
        return jsonErrorResponse("limit must be a positive number", 400);
      }
      const limit = typeof body.limit === "number" ? body.limit : undefined;

      const report = await runRow7Repair(
        {
          db,
          now: () => Date.now(),
          readHeadCi: (prUrl, headSha) => readHeadCiForRecord(env, prUrl, headSha),
          // The FIX-1 absent trap: the runner settles an `absent` read only when a prior journaled
          // `ci.signal(absent)` corroborates it (the raw read + separate check keep the distinct tally).
          isAbsentCorroborated: (sessionId) => isAbsentCiCorroborated(db, sessionId),
          emitCiSignal: (sessionId, ciState) => shadowEmitCiSignal(env, sessionId, ciState, log),
          // The FIX-3 reopen telemetry (fsm.transition-shaped, best-effort inside the runner).
          emitRepairTelemetry: (event) => postStructuredEventToDd(env, event),
        },
        { target, dryRun, limit },
      );

      log.info({ ...report }, "fsm row7 repair run complete");
      return jsonResponse({ ok: true, report });
    },
  },
];
