import { JSON_HEADERS, requestVoid } from "./client";

export const SESSION_WS_TELEMETRY_ACTIONS = [
  "ws_blocked_fallback",
  "ws_connected",
  "ws_error",
  "ws_watchdog_escalated",
  "ws_watchdog_reconnect",
] as const;

export type SessionWsTelemetryPayload = {
  action: (typeof SESSION_WS_TELEMETRY_ACTIONS)[number];
  attempts?: number;
  closeReason?: string;
  consecutiveWatchdogStalls?: number;
  staleDurationMs?: number;
};

export async function postSessionWsTelemetry(sessionId: string, payload: SessionWsTelemetryPayload): Promise<void> {
  await requestVoid(
    `/api/sessions/${encodeURIComponent(sessionId)}/ws-telemetry`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    },
    "Failed to record WebSocket telemetry",
  );
}
