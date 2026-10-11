import { isTerminalPhase, type Phase } from "../../../../shared/session/phase.js";

export const MIN_WATCH_POLL_INTERVAL_MS = 250;
export const DEFAULT_WATCH_POLL_INTERVAL_MS = 1000;
export const MAX_WATCH_POLL_INTERVAL_MS = 60_000;
export const WATCH_REPLAY_PAGE_SIZE = 200;

// Phase-based watch terminality. `idle` is excluded because a brand-new session
// can sit idle between prompt enqueue and pickup.
export function isWatchTerminal(phase: Phase): boolean {
  return isTerminalPhase(phase);
}
