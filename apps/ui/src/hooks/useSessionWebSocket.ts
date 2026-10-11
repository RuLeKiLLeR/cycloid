import { useCallback, useRef } from "react";

import type { DesktopActionPathRow } from "../../../../shared/types/desktop-action-path";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay";
import type {
  ClientPrompt,
  ClientQueueState,
  ClientReplayPage,
  ClientSandboxState,
  ClientSessionSnapshot,
  ReplayError,
  RequestReplayPage,
} from "../../../../shared/types/session-websocket";
import { getSessionWsUrl } from "../api/sessions";
import { createReconnectBackoff, type SocketCloseReason } from "./sessionWebSocketBackoff";
import { isLivenessServerMessage, parseServerMessage } from "./sessionWebSocketMessages";
import {
  trackWsBlockedFallback,
  trackWsConnected,
  trackWsError,
  trackWsWatchdogEscalated,
  trackWsWatchdogReconnect,
} from "./sessionWebSocketTelemetry";
import { useSyncEffect } from "./useEffects";
import { useWsWatchdog } from "./useWsWatchdog";

/**
 * Parsed server message from the DO WebSocket.
 * Prompt lifecycle and user-visible failures arrive via durable session
 * events (`prompt_enqueued`, `prompt_processing`, `prompt_completed`,
 * `prompt_failed`, `session_error`) plus `sandbox_error`, rather than
 * top-level queue, processing, or protocol-error frames.
 */
export type ServerMessage =
  | {
      type: "subscribed";
      version: 2;
      session: ClientSessionSnapshot;
      sandbox: ClientSandboxState;
      queue: ClientQueueState;
      prompts: ClientPrompt[];
      lastDurableSequence: number;
      replay: ClientReplayPage;
    }
  | { type: "session_event"; event: SessionReplayEvent }
  | { type: "replay_event"; event: SessionReplayEvent }
  | ({ type: "replay_page" } & ClientReplayPage)
  | ReplayError
  | {
      type: "replay_truncated";
      requestedAfterSequence: number;
      firstReturnedSequence: number;
      lastReturnedSequence: number;
      droppedCount: number;
    }
  // Raw sandbox_event frames are reserved for heartbeat/debug-style signals.
  | { type: "sandbox_event"; event: Record<string, unknown> }
  | { type: "sandbox_ready"; sandboxId: string; spawnDurationMs?: number | null }
  | { type: "sandbox_error"; error: string }
  | { type: "prompt_updated"; prompt: ClientPrompt }
  | { type: "desktop_action_path_row"; row: DesktopActionPathRow }
  | {
      type: "session_status";
      // Canonical phase contract. Emitted for every session kind after PR D.
      phase: import("../../../../shared/session/phase.js").Phase;
      displayStatus: import("../../../../shared/session/display-status.js").DisplayStatus;
      uiLifecycleStage?: import("../../../../shared/session/lifecycle-stage.js").UiLifecycleStage;
      sandboxSubstate?: import("../../../../shared/session/phase.js").SandboxSubstate;
      stopMode?: import("../../../../shared/session/phase.js").StopMode;
      // Live-idle "kept alive after a user stop" flag; see
      // shared/types/session-websocket.ts. Drives the detail-view "Stopped —
      // continue anytime" badge/composer hint. The control-plane broadcast
      // always sets it (true/false), so it clears cleanly at prompt admit.
      userStopped?: boolean;
      planApprovalPending?: boolean;
      planRevision?: number;
      planStatus?: import("../../../../shared/types/session-plan.js").SessionPlanStatus;
      finalizingStep?: import("../../../../shared/session/phase.js").FinalizingStep;
      title?: string;
      // Carried so a push re-entering a non-terminal phase updates the open
      // detail's branch (and the Create-PR CTA) without waiting for the poll.
      lastBranch?: string | null;
    }
  | {
      type: "pr_created";
      prUrl: string;
      prNumber: number;
      branchName: string;
      draft?: boolean;
      manualReviewReason?: string;
    }
  | {
      type: "pr_updated";
      prUrl: string;
      prNumber: number;
      branchName: string;
      draft?: boolean;
      manualReviewReason?: string;
    }
  | {
      type: "verification_updated";
      verification: import("../../../../shared/types/sandbox").ExecutionVerification | null;
      verificationSummary?: import("../../../../shared/verification-summary").VerificationSummary | null;
    }
  | {
      type: "runtime_provenance_updated";
      runtimeProvenance: import("../../../../shared/types/sandbox").RuntimeProvenance | null;
    }
  | {
      type: "observability_readiness_updated";
      observabilityReadiness: import("../../../../shared/types/sandbox").ObservabilityReadiness | null;
    }
  | { type: "pr_failed"; error: string }
  | { type: "pong" };

export function isLivenessMessage(msg: ServerMessage): boolean {
  return isLivenessServerMessage(msg);
}

interface UseSessionWebSocketOptions {
  sessionId: string | null;
  /** Called when afterSequence is needed for reconnect. */
  getLastSequence: () => number;
  onMessage: (msg: ServerMessage) => void;
  /** Called when WS fails to connect after WS_BLOCKED_THRESHOLD attempts. */
  onWsBlocked?: () => void;
  /** Called when WS connects successfully. */
  onConnected?: () => void;
  /** Called when WS disconnects and a reconnect cycle begins. */
  onDisconnected?: () => void;
  /** Whether a prompt is actively running. Controls watchdog activation. */
  isPromptActive?: boolean;
  enabled?: boolean;
}

export function useSessionWebSocket({
  sessionId,
  getLastSequence,
  onMessage,
  onWsBlocked,
  onConnected,
  onDisconnected,
  isPromptActive = false,
  enabled = true,
}: UseSessionWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lazy init so the controller (which captures backoff/failure state) is not
  // rebuilt and discarded on every render.
  const reconnectBackoffRef = useRef<ReturnType<typeof createReconnectBackoff> | null>(null);
  reconnectBackoffRef.current ??= createReconnectBackoff();
  const socketCloseReasonRef = useRef<SocketCloseReason>(null);
  const mountedRef = useRef(true);
  const isPromptActiveRef = useRef(isPromptActive);
  isPromptActiveRef.current = isPromptActive;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Stable callback refs to avoid reconnect on callback identity changes
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onWsBlockedRef = useRef(onWsBlocked);
  onWsBlockedRef.current = onWsBlocked;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const getLastSequenceRef = useRef(getLastSequence);
  getLastSequenceRef.current = getLastSequence;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const sendJson = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const {
    markMessage: markWatchdogMessage,
    resetForNewSession: resetWatchdogForNewSession,
    start: startWatchdog,
    stop: stopWatchdog,
  } = useWsWatchdog({
    getIsPromptActive: () => isPromptActiveRef.current,
    onEscalated: ({ consecutiveWatchdogStalls }) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      // HTTP fallback already started on the first stall (see onStall); the
      // escalation signal now only marks a persistently dead transport for
      // telemetry/alerting.
      trackWsWatchdogEscalated(activeSessionId, consecutiveWatchdogStalls);
    },
    onStall: ({ consecutiveWatchdogStalls, staleDurationMs }) => {
      const activeSessionId = sessionIdRef.current;
      socketCloseReasonRef.current = "watchdog";
      if (!activeSessionId) return;
      trackWsWatchdogReconnect(activeSessionId, {
        closeReason: "watchdog",
        consecutiveWatchdogStalls,
        staleDurationMs,
      });
      // Start HTTP fallback in parallel with the reconnect on the first stall of
      // an episode, instead of waiting for the escalation threshold (3×90s ≈
      // 4.5min) before any backup polling — a half-open transport otherwise
      // hangs the transcript for minutes. The reconnect still proceeds; if it
      // recovers, the next liveness frame de-escalates back to resilience
      // polling (see useSessionReplay). markMessage resets the streak to 0 on
      // any liveness frame, so a later re-stall is a fresh 0→1 episode that
      // re-arms fallback. The ws_watchdog_reconnect action above already carries
      // consecutiveWatchdogStalls, so fallback-start is measurable as its
      // stalls===1 case — no separate metric needed.
      if (consecutiveWatchdogStalls === 1) {
        onWsBlockedRef.current?.();
      }
    },
  });

  useSyncEffect(() => {
    if (!sessionId || !enabled) return;
    mountedRef.current = true;
    reconnectBackoffRef.current!.resetForNewSession();
    resetWatchdogForNewSession();
    socketCloseReasonRef.current = null;

    function connect() {
      if (!mountedRef.current || !sessionId) return;

      const afterSequence = getLastSequenceRef.current();
      const url = getSessionWsUrl(sessionId, afterSequence > 0 ? afterSequence : undefined);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          ws.close();
          return;
        }
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        reconnectBackoffRef.current!.recordConnected();
        startWatchdog(ws);

        onConnectedRef.current?.();
        trackWsConnected(sessionId);
      };

      ws.onmessage = (event) => {
        const msg = parseServerMessage(event.data);
        if (!msg) return;
        markWatchdogMessage(msg);
        try {
          onMessageRef.current(msg);
        } catch {
          // Preserve the old boundary behavior: a bad consumer callback should
          // not tear down the socket handler or prevent watchdog state updates.
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stopWatchdog();
          wsRef.current = null;
        }
        if (!mountedRef.current) return;

        onDisconnectedRef.current?.();
        const closeReason = socketCloseReasonRef.current;
        socketCloseReasonRef.current = null;
        const reconnectBackoff = reconnectBackoffRef.current!;
        reconnectBackoff.recordClose(closeReason);

        if (closeReason !== "watchdog" && reconnectBackoff.shouldNotifyBlocked()) {
          reconnectBackoff.markBlockedNotified();
          const attempts = reconnectBackoff.getConsecutiveFailures();
          onWsBlockedRef.current?.();
          trackWsBlockedFallback(sessionId, attempts);
          console.warn(`[useSessionWebSocket] WS failed after ${attempts} attempts, triggering fallback`);
        }

        // Always try to reconnect (even after triggering fallback)
        const delay = reconnectBackoff.consumeReconnectDelay();
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, so reconnection is handled there
        trackWsError(sessionId);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      stopWatchdog();
      clearReconnectTimer();
      const ws = wsRef.current;
      if (ws) {
        // React strict mode safe: don't close in CONNECTING state
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener("open", () => ws.close(), { once: true });
        }
        wsRef.current = null;
      }
    };
  }, [
    sessionId,
    enabled,
    clearReconnectTimer,
    markWatchdogMessage,
    resetWatchdogForNewSession,
    startWatchdog,
    stopWatchdog,
  ]);

  function requestReplayPage(request: Omit<RequestReplayPage, "type">) {
    return sendJson({ type: "request_replay_page", ...request });
  }

  return { requestReplayPage };
}
