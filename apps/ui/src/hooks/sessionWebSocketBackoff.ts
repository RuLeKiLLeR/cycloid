import { multiplierRangeBackoffMs } from "../utils/backoff";

const INITIAL_RECONNECT_BACKOFF_MS = 500;
const MAX_RECONNECT_BACKOFF_MS = 10_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const RECONNECT_JITTER_MIN_MULTIPLIER = 0.5;
const RECONNECT_JITTER_MAX_MULTIPLIER = 1.5;
export const WS_BLOCKED_THRESHOLD = 3;

export type SocketCloseReason = "watchdog" | null;

type ReconnectBackoffController = {
  consumeReconnectDelay: () => number;
  getConsecutiveFailures: () => number;
  markBlockedNotified: () => void;
  recordClose: (closeReason: SocketCloseReason) => void;
  recordConnected: () => void;
  resetForNewSession: () => void;
  shouldNotifyBlocked: () => boolean;
};

export function createReconnectBackoff(): ReconnectBackoffController {
  let backoffMs = INITIAL_RECONNECT_BACKOFF_MS;
  let consecutiveFailures = 0;
  let blockedNotified = false;

  function resetForNewSession() {
    backoffMs = INITIAL_RECONNECT_BACKOFF_MS;
    consecutiveFailures = 0;
    blockedNotified = false;
  }

  return {
    consumeReconnectDelay() {
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * RECONNECT_BACKOFF_MULTIPLIER, MAX_RECONNECT_BACKOFF_MS);
      // Apply symmetric jitter around the nominal backoff so clients still
      // desynchronize while the full capped delay remains reachable.
      //
      // Note: the returned delay is clamped to MAX_RECONNECT_BACKOFF_MS, so
      // once `delay` reaches the cap the jitter band is asymmetric — the
      // upside (>1.0x) is clipped at the cap while the downside (<1.0x) is
      // preserved. Effective spread at peak backoff is therefore
      // [0.5 * cap, cap] rather than [0.5 * cap, 1.5 * cap]. This is an
      // intentional trade-off: we never want a single client to wait longer
      // than the cap, even at the cost of a tighter thundering-herd window
      // at the ceiling.
      return multiplierRangeBackoffMs({
        delayMs: delay,
        maxMs: MAX_RECONNECT_BACKOFF_MS,
        minMultiplier: RECONNECT_JITTER_MIN_MULTIPLIER,
        maxMultiplier: RECONNECT_JITTER_MAX_MULTIPLIER,
      });
    },
    getConsecutiveFailures() {
      return consecutiveFailures;
    },
    markBlockedNotified() {
      blockedNotified = true;
    },
    recordClose(closeReason) {
      if (closeReason !== "watchdog") {
        consecutiveFailures += 1;
      }
    },
    recordConnected() {
      backoffMs = INITIAL_RECONNECT_BACKOFF_MS;
      consecutiveFailures = 0;
      blockedNotified = false;
    },
    resetForNewSession,
    shouldNotifyBlocked() {
      return consecutiveFailures >= WS_BLOCKED_THRESHOLD && !blockedNotified;
    },
  };
}
