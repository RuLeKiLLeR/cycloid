import type { Env } from "../types";
import { checkDurableObjectRateLimit, type DurableObjectRateLimitResult } from "./do-rate-limiter";

export type { DurableObjectRateLimitResult };

const SESSION_RESUME_RATE_LIMIT_WINDOW_SECONDS = 30;
const SESSION_RESUME_RATE_LIMIT_MAX = 5;
const SESSION_WS_TELEMETRY_RATE_LIMIT_WINDOW_SECONDS = 60;
const SESSION_WS_TELEMETRY_RATE_LIMIT_MAX = 120;
const DESKTOP_ACTION_PATH_SNAPSHOT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DESKTOP_ACTION_PATH_SNAPSHOT_RATE_LIMIT_MAX = 30;
const DESKTOP_VIEW_TICKET_CREATE_RATE_LIMIT_WINDOW_SECONDS = 60;
const DESKTOP_VIEW_TICKET_CREATE_RATE_LIMIT_MAX = 20;
const DESKTOP_VIEW_WEBSOCKET_RATE_LIMIT_WINDOW_SECONDS = 60;
const DESKTOP_VIEW_WEBSOCKET_RATE_LIMIT_MAX = 60;
const SANDBOX_AUTH_FAILURE_RATE_LIMIT_WINDOW_SECONDS = 60;
const SANDBOX_AUTH_FAILURE_RATE_LIMIT_MAX = 5;
const SESSION_PLAN_EDIT_RATE_LIMIT_WINDOW_SECONDS = 60;
const SESSION_PLAN_EDIT_RATE_LIMIT_MAX = 10;
const SANDBOX_AUTH_FAILURE_LOCKOUT_SECONDS = 30;

export async function checkSessionResumeRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  sessionId: string,
  userId: string,
): Promise<{ limited: boolean }> {
  // Prefix a bounded limiter kind (like every sibling limiter here, e.g.
  // `session-ws-telemetry:`, `sandbox-auth:`) so the fail-open log's `keyPrefix`
  // - which the arcanist.rate_limiter.fail_open metric groups on - is a bounded
  // tag. Without the prefix the first key segment is the raw sessionId, which
  // would explode Datadog tag cardinality during exactly the fail-open outage the
  // metric exists to observe.
  return checkDurableObjectRateLimit(env, `session-resume:${sessionId}:${userId}`, {
    max: SESSION_RESUME_RATE_LIMIT_MAX,
    windowSeconds: SESSION_RESUME_RATE_LIMIT_WINDOW_SECONDS,
  });
}

export async function checkSessionWsTelemetryRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  sessionId: string,
  userId: string,
): Promise<{ limited: boolean }> {
  return checkDurableObjectRateLimit(env, `session-ws-telemetry:${sessionId}:${userId}`, {
    max: SESSION_WS_TELEMETRY_RATE_LIMIT_MAX,
    windowSeconds: SESSION_WS_TELEMETRY_RATE_LIMIT_WINDOW_SECONDS,
  });
}

export async function checkDesktopActionPathSnapshotRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  sessionId: string,
  userId: string,
): Promise<{ limited: boolean }> {
  return checkDurableObjectRateLimit(env, `desktop-action-path:${sessionId}:${userId}`, {
    max: DESKTOP_ACTION_PATH_SNAPSHOT_RATE_LIMIT_MAX,
    windowSeconds: DESKTOP_ACTION_PATH_SNAPSHOT_RATE_LIMIT_WINDOW_SECONDS,
  });
}

export async function checkDesktopViewTicketCreateRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  sessionId: string,
  userId: string,
): Promise<DurableObjectRateLimitResult> {
  return checkDurableObjectRateLimit(env, `desktop-view-ticket-create:${sessionId}:${userId}`, {
    max: DESKTOP_VIEW_TICKET_CREATE_RATE_LIMIT_MAX,
    windowSeconds: DESKTOP_VIEW_TICKET_CREATE_RATE_LIMIT_WINDOW_SECONDS,
  });
}

export async function checkDesktopViewWebSocketRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  sessionId: string,
  userId: string,
): Promise<DurableObjectRateLimitResult> {
  return checkDurableObjectRateLimit(env, `desktop-view-ws:${sessionId}:${userId}`, {
    max: DESKTOP_VIEW_WEBSOCKET_RATE_LIMIT_MAX,
    windowSeconds: DESKTOP_VIEW_WEBSOCKET_RATE_LIMIT_WINDOW_SECONDS,
  });
}

export async function checkSandboxAuthFailureRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  ip: string,
): Promise<{ limited: boolean }> {
  return checkDurableObjectRateLimit(env, `sandbox-auth:${ip}`, {
    max: SANDBOX_AUTH_FAILURE_RATE_LIMIT_MAX,
    windowSeconds: SANDBOX_AUTH_FAILURE_RATE_LIMIT_WINDOW_SECONDS,
    lockoutSeconds: SANDBOX_AUTH_FAILURE_LOCKOUT_SECONDS,
  });
}

export async function checkSessionPlanEditRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  userId: string,
): Promise<{ limited: boolean }> {
  return checkDurableObjectRateLimit(env, `session-plan-edit:${userId}`, {
    max: SESSION_PLAN_EDIT_RATE_LIMIT_MAX,
    windowSeconds: SESSION_PLAN_EDIT_RATE_LIMIT_WINDOW_SECONDS,
  });
}
