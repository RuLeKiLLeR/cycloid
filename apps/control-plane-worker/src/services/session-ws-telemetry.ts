import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";

export const SESSION_WS_TELEMETRY_ACTIONS = [
  "ws_blocked_fallback",
  "ws_connected",
  "ws_error",
  "ws_watchdog_escalated",
  "ws_watchdog_reconnect",
] as const;

export type SessionWsTelemetryAction = (typeof SESSION_WS_TELEMETRY_ACTIONS)[number];
export type SessionWsViewerRelation = "owner" | "shared" | "admin";

export type SessionWsTelemetryPayload = {
  action: SessionWsTelemetryAction;
  attempts?: number;
  closeReason?: string;
  consecutiveWatchdogStalls?: number;
  staleDurationMs?: number;
};

const ACTION_SET = new Set<string>(SESSION_WS_TELEMETRY_ACTIONS);
const MAX_CLOSE_REASON_LENGTH = 64;
const log = createLogger({ bindings: { component: "session-ws-telemetry" } });

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function parseSessionWsTelemetryPayload(
  payload: unknown,
): { ok: true; value: SessionWsTelemetryPayload } | { ok: false; error: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const body = payload as Record<string, unknown>;
  const action = body.action;
  if (typeof action !== "string" || !ACTION_SET.has(action)) {
    return { ok: false, error: "Invalid WebSocket telemetry action" };
  }

  return {
    ok: true,
    value: {
      action: action as SessionWsTelemetryAction,
      attempts: optionalNonNegativeInteger(body.attempts),
      closeReason: optionalBoundedString(body.closeReason, MAX_CLOSE_REASON_LENGTH),
      consecutiveWatchdogStalls: optionalNonNegativeInteger(body.consecutiveWatchdogStalls),
      staleDurationMs: optionalNonNegativeInteger(body.staleDurationMs),
    },
  };
}

export async function emitSessionWsTelemetry(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  input: {
    sessionId: string;
    userId: string;
    viewerRelation: SessionWsViewerRelation;
    payload: SessionWsTelemetryPayload;
  },
  logger: Pick<Logger, "warn"> = log,
): Promise<void> {
  const event = {
    event: "session_ws_telemetry",
    action: input.payload.action,
    sessionId: input.sessionId,
    userId: input.userId,
    viewerRelation: input.viewerRelation,
    attempts: input.payload.attempts ?? null,
    closeReason: input.payload.closeReason ?? null,
    consecutiveWatchdogStalls: input.payload.consecutiveWatchdogStalls ?? null,
    staleDurationMs: input.payload.staleDurationMs ?? null,
  };

  const posted = await postStructuredEventToDd(env, event);
  if (!posted) {
    logger.warn(
      { event: "session_ws_telemetry_export_failed", sessionId: input.sessionId, action: input.payload.action },
      "Session WebSocket telemetry export failed",
    );
  }
}
