import {
  MAX_ACTIVE_SESSIONS_PER_BUSINESS,
  SESSION_CREATE_RATE_LIMIT_MAX,
  SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS,
} from "../../../../shared/constants/session.js";
import { countActiveSessionsForBusiness } from "../session/db.js";
import type { Env } from "../types.js";
import { checkDurableObjectRateLimit } from "./do-rate-limiter.js";

/**
 * Admission control for `POST /api/sessions`. A rejection carries the HTTP status
 * and a structured `code` the route maps to a JSON error (and WARN-logs).
 * Two per-business gates run in order: a sliding-window create rate limit (catches
 * bursts) then the active-session cap (bounds sustained concurrency).
 */
export type SessionAdmissionDecision =
  { ok: true } | { ok: false; status: number; code: string; message: string; activeCount?: number };

export type SessionAdmissionDeps = {
  db: D1Database;
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">;
  businessId: string | null;
};

/**
 * Decide whether a session create is admitted.
 *
 * A null business id means a trusted all-access caller (internal/admin tooling
 * with `canAccessAllSessions`), not an unproven membership: those bypass both
 * gates rather than fail closed, matching how the route already scopes such
 * callers.
 *
 * Rate limit runs before the cap so an abusive burst is shed cheaply (the DO
 * check is atomic and fails open if the limiter backend is down) before the cap
 * count. This intentionally meters create attempts that reach admission,
 * including attempts that would later bounce on the active-session cap. The cap
 * is counted directly from `session_index`, so a session frees capacity as soon
 * as it reaches a terminal phase (completed/stopped/failed/blocked) or is
 * closed, with no separate bookkeeping.
 */
export async function admitSessionCreate(deps: SessionAdmissionDeps): Promise<SessionAdmissionDecision> {
  const { db, env, businessId } = deps;
  if (!businessId) return { ok: true };

  const { limited } = await checkDurableObjectRateLimit(env, `session-create:${businessId}`, {
    max: SESSION_CREATE_RATE_LIMIT_MAX,
    windowSeconds: SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (limited) {
    return {
      ok: false,
      status: 429,
      code: "session_create_rate_limited",
      message: `Too many sessions created recently (limit ${SESSION_CREATE_RATE_LIMIT_MAX} per ${SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS}s). Retry shortly.`,
    };
  }

  const activeCount = await countActiveSessionsForBusiness(db, businessId);
  if (activeCount >= MAX_ACTIVE_SESSIONS_PER_BUSINESS) {
    return {
      ok: false,
      status: 429,
      code: "active_session_limit_exceeded",
      message: `Active session limit reached (${MAX_ACTIVE_SESSIONS_PER_BUSINESS}). Wait for a running session to finish, or close one, and try again.`,
      activeCount,
    };
  }

  return { ok: true };
}
