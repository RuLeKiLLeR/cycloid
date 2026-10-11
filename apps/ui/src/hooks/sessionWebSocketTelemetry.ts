import type { SessionWsTelemetryPayload } from "../api/sessionTelemetry";
import type { SocketCloseReason } from "./sessionWebSocketBackoff";

let datadogModulePromise: Promise<typeof import("../datadog")> | null = null;
let sessionTelemetryModulePromise: Promise<typeof import("../api/sessionTelemetry")> | null = null;

function loadDatadogModule() {
  datadogModulePromise ??= import("../datadog");
  return datadogModulePromise;
}

function loadSessionTelemetryModule() {
  sessionTelemetryModulePromise ??= import("../api/sessionTelemetry");
  return sessionTelemetryModulePromise;
}

function postSessionWsTelemetry(sessionId: string, payload: SessionWsTelemetryPayload) {
  void loadSessionTelemetryModule()
    .then(({ postSessionWsTelemetry: postTelemetry }) => postTelemetry(sessionId, payload))
    .catch((error) => {
      console.error("[session-ws-telemetry] Failed to post server telemetry", error);
    });
}

export function trackWsBlockedFallback(sessionId: string, attempts: number) {
  void loadDatadogModule()
    .then(({ trackAction }) => trackAction("ws_blocked_fallback", { sessionId, attempts }))
    .catch(console.error);
  postSessionWsTelemetry(sessionId, { action: "ws_blocked_fallback", attempts });
  void import("../sentry")
    .then(({ captureUiError }) =>
      captureUiError(new Error("Session WebSocket failed repeatedly; fallback polling activated"), {
        operation: "ws_blocked_fallback",
        sessionId,
        attempts: String(attempts),
      }),
    )
    .catch(console.error);
}

export function trackWsConnected(sessionId: string) {
  void loadDatadogModule()
    .then(({ trackAction }) => trackAction("ws_connected", { sessionId }))
    .catch(console.error);
  postSessionWsTelemetry(sessionId, { action: "ws_connected" });
}

export function trackWsError(sessionId: string) {
  void loadDatadogModule()
    .then(({ trackAction }) => trackAction("ws_error", { sessionId }))
    .catch(console.error);
  postSessionWsTelemetry(sessionId, { action: "ws_error" });
}

export function trackWsWatchdogEscalated(sessionId: string, consecutiveWatchdogStalls: number) {
  void loadDatadogModule()
    .then(({ trackAction }) =>
      trackAction("ws_watchdog_escalated", {
        sessionId,
        consecutiveWatchdogStalls,
      }),
    )
    .catch(console.error);
  postSessionWsTelemetry(sessionId, { action: "ws_watchdog_escalated", consecutiveWatchdogStalls });
  void import("../sentry")
    .then(({ captureUiError }) =>
      // HTTP fallback now starts on the first stall (see useSessionWebSocket), so
      // escalation no longer triggers it — this marks a persistently stalled
      // transport that never recovered across the escalation threshold.
      captureUiError(new Error("Session WebSocket watchdog: transport persistently stalled"), {
        operation: "ws_watchdog_escalated",
        sessionId,
        stalls: String(consecutiveWatchdogStalls),
      }),
    )
    .catch(console.error);
}

export function trackWsWatchdogReconnect(
  sessionId: string,
  {
    closeReason,
    consecutiveWatchdogStalls,
    staleDurationMs,
  }: {
    closeReason: SocketCloseReason;
    consecutiveWatchdogStalls: number;
    staleDurationMs: number;
  },
) {
  void loadDatadogModule()
    .then(({ trackAction }) =>
      trackAction("ws_watchdog_reconnect", {
        sessionId,
        staleDurationMs,
        consecutiveWatchdogStalls,
        closeReason,
      }),
    )
    .catch(console.error);
  postSessionWsTelemetry(sessionId, {
    action: "ws_watchdog_reconnect",
    staleDurationMs,
    consecutiveWatchdogStalls,
    ...(closeReason ? { closeReason } : {}),
  });
}
