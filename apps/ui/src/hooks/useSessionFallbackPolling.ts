import { type MutableRefObject, useCallback, useRef } from "react";

import type { Phase } from "../../../../shared/session/phase.js";
import { RESILIENCE_POLL_MS, TERMINAL_FOR_FALLBACK_POLLING_PHASES } from "../constants";
import { startFallbackBackoff } from "../utils/fallback-backoff";
import { useMountEffect, useSyncEffect } from "./useEffects";

type ActivePromptHistoryRefreshSource = "poll" | "subscribed_replay" | "replay_truncated" | "heartbeat_disconnect";

type UseSessionFallbackPollingOptions = {
  refreshRef: MutableRefObject<(source?: ActivePromptHistoryRefreshSource) => Promise<void>>;
  sessionPhase?: Phase | null;
};

export function useSessionFallbackPolling({ refreshRef, sessionPhase }: UseSessionFallbackPollingOptions) {
  const cancelPollingRef = useRef<(() => void) | null>(null);
  const aggressiveFallbackActiveRef = useRef(false);

  const clearPolling = useCallback(() => {
    if (cancelPollingRef.current) {
      cancelPollingRef.current();
      cancelPollingRef.current = null;
    }
  }, []);

  const startResiliencePolling = useCallback(() => {
    aggressiveFallbackActiveRef.current = false;
    clearPolling();
    const interval = setInterval(() => void refreshRef.current(), RESILIENCE_POLL_MS);
    cancelPollingRef.current = () => clearInterval(interval);
  }, [clearPolling, refreshRef]);

  const startAggressiveFallbackPolling = useCallback(() => {
    aggressiveFallbackActiveRef.current = true;
    clearPolling();
    // Exponential backoff with jitter; a fresh outage restarts at the
    // initial delay (reconnects route through startResiliencePolling).
    cancelPollingRef.current = startFallbackBackoff(() => void refreshRef.current());
  }, [clearPolling, refreshRef]);

  useMountEffect(() => {
    aggressiveFallbackActiveRef.current = false;
    return () => {
      clearPolling();
    };
  });

  useSyncEffect(() => {
    if (sessionPhase && TERMINAL_FOR_FALLBACK_POLLING_PHASES.has(sessionPhase)) {
      clearPolling();
    }
  }, [clearPolling, sessionPhase]);

  return {
    aggressiveFallbackActiveRef,
    clearPolling,
    startAggressiveFallbackPolling,
    startResiliencePolling,
  };
}

export type { ActivePromptHistoryRefreshSource };
