/**
 * Heartbeat event-loop-starvation probe.
 *
 * The bridge heartbeat runs on a fixed `setInterval`. A heavy in-sandbox build
 * (e.g. `docker compose up --build`) saturates CPU and starves the Node event
 * loop, so the timer fires late and the control plane / E2B can mistake a
 * busy-but-healthy VM for a dead one. A late tick is the observable signal.
 */
export interface HeartbeatStall {
  actualGapMs: number;
  driftMs: number;
}

/**
 * Returns stall details when the observed gap between heartbeat ticks indicates
 * the event loop was starved (at least one full interval missed), else null.
 * A gap of one interval is normal jitter; `>= 2x` means a tick was dropped.
 */
export function computeHeartbeatStall(tickGapMs: number, intervalMs: number): HeartbeatStall | null {
  if (!Number.isFinite(tickGapMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  if (tickGapMs < intervalMs * 2) return null;
  return { actualGapMs: tickGapMs, driftMs: tickGapMs - intervalMs };
}
