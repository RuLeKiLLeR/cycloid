import { SANDBOX_HEARTBEAT_LIVENESS_MS } from "../../constants/sessions";

export interface SandboxHeartbeatFreshness {
  lastHeartbeatAt: number | null;
  ageMs: number | null;
  fresh: boolean;
}

/**
 * Evaluate whether the lifecycle sandbox record's `lastHeartbeatAt` is within
 * the platform liveness bound (ARC-1196). Fails closed: a malformed record, a
 * missing/non-numeric `lastHeartbeatAt` (sessions whose lifecycle storage
 * predates the field), or a timestamp further in the future than the liveness
 * bound all count as stale, so an open-but-dead socket never receives a
 * prompt dispatch on the strength of a heartbeat we cannot prove.
 */
export function evaluateSandboxHeartbeatFreshness(record: unknown, now: number): SandboxHeartbeatFreshness {
  const candidate =
    record && typeof record === "object" && !Array.isArray(record)
      ? (record as { lastHeartbeatAt?: unknown }).lastHeartbeatAt
      : null;
  const lastHeartbeatAt = typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  if (lastHeartbeatAt === null) {
    return { lastHeartbeatAt: null, ageMs: null, fresh: false };
  }
  const ageMs = now - lastHeartbeatAt;
  const fresh = Math.abs(ageMs) <= SANDBOX_HEARTBEAT_LIVENESS_MS;
  return { lastHeartbeatAt, ageMs, fresh };
}
