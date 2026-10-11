import { useCallback, useRef } from "react";

import { WS_LIVENESS_THRESHOLD_MS, WS_WATCHDOG_ESCALATION_THRESHOLD, WS_WATCHDOG_INTERVAL_MS } from "../constants";
import { isLivenessServerMessage } from "./sessionWebSocketMessages";
import type { ServerMessage } from "./useSessionWebSocket";

const WS_PING_INTERVAL_MS = 30_000;

type WatchdogStall = {
  consecutiveWatchdogStalls: number;
  staleDurationMs: number;
};

type UseWsWatchdogOptions = {
  getIsPromptActive: () => boolean;
  onEscalated: (stall: WatchdogStall) => void;
  onStall: (stall: WatchdogStall) => void;
};

export function useWsWatchdog({ getIsPromptActive, onEscalated, onStall }: UseWsWatchdogOptions) {
  const currentSocketRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);
  const consecutiveWatchdogStallsRef = useRef(0);
  const lastServerActivityAtRef = useRef(0);
  const subscribedRef = useRef(false);

  const getIsPromptActiveRef = useRef(getIsPromptActive);
  getIsPromptActiveRef.current = getIsPromptActive;
  const onEscalatedRef = useRef(onEscalated);
  onEscalatedRef.current = onEscalated;
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;

  const clearPingTimer = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const clearWatchdogTimer = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const clearVisibilitySubscription = useCallback(() => {
    visibilityCleanupRef.current?.();
    visibilityCleanupRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearPingTimer();
    clearWatchdogTimer();
    clearVisibilitySubscription();
    currentSocketRef.current = null;
  }, [clearPingTimer, clearVisibilitySubscription, clearWatchdogTimer]);

  const resetForNewSession = useCallback(() => {
    stop();
    consecutiveWatchdogStallsRef.current = 0;
    lastServerActivityAtRef.current = 0;
    subscribedRef.current = false;
  }, [stop]);

  const start = useCallback(
    (socket: WebSocket) => {
      stop();
      currentSocketRef.current = socket;
      subscribedRef.current = false;
      lastServerActivityAtRef.current = Date.now();

      const startTimers = () => {
        clearPingTimer();
        clearWatchdogTimer();
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

        pingTimerRef.current = setInterval(() => {
          if (currentSocketRef.current !== socket) return;
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, WS_PING_INTERVAL_MS);

        watchdogTimerRef.current = setInterval(() => {
          if (currentSocketRef.current !== socket) return;
          if (socket.readyState !== WebSocket.OPEN) return;

          const inBootstrapPhase = !subscribedRef.current;
          const watchdogActive = inBootstrapPhase || getIsPromptActiveRef.current();
          if (!watchdogActive) return;

          const staleDurationMs = Date.now() - lastServerActivityAtRef.current;
          if (staleDurationMs < WS_LIVENESS_THRESHOLD_MS) return;

          consecutiveWatchdogStallsRef.current += 1;
          const consecutiveWatchdogStalls = consecutiveWatchdogStallsRef.current;
          const stall = { consecutiveWatchdogStalls, staleDurationMs };
          onStallRef.current(stall);

          if (consecutiveWatchdogStalls === WS_WATCHDOG_ESCALATION_THRESHOLD) {
            onEscalatedRef.current(stall);
          }

          socket.close();
        }, WS_WATCHDOG_INTERVAL_MS);
      };

      if (typeof document !== "undefined") {
        const handleVisibilityChange = () => {
          if (document.visibilityState === "hidden") {
            clearPingTimer();
            clearWatchdogTimer();
            return;
          }
          if (currentSocketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
          lastServerActivityAtRef.current = Date.now();
          startTimers();
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        visibilityCleanupRef.current = () => {
          document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
      }

      startTimers();
    },
    [clearPingTimer, clearWatchdogTimer, stop],
  );

  const markMessage = useCallback((msg: ServerMessage) => {
    if (!isLivenessServerMessage(msg)) return;

    lastServerActivityAtRef.current = Date.now();
    consecutiveWatchdogStallsRef.current = 0;
    if (msg.type === "subscribed") {
      subscribedRef.current = true;
    }
  }, []);

  return {
    markMessage,
    resetForNewSession,
    start,
    stop,
  };
}
