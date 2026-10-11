import {
  SANDBOX_HEARTBEAT_LIVENESS_MS,
  SANDBOX_RECONNECT_GRACE_MS,
  SPAWN_CONNECT_TIMEOUT_MS,
  STALE_PROMPT_TIMEOUT_MS,
} from "../../constants/sessions";
import type { LifecycleConfig, LifecycleDeadlines } from "./types";

const LIFECYCLE_STARTUP_TIMEOUT_MS = 180 * 1000;
const LIFECYCLE_SPAWN_FAILURE_RESET_MS = 10 * 60 * 1000;
// Phase-independent sandbox liveness window (2 missed 30s heartbeats). Distinct
// from the 15-min runningInactivityMs prompt-silence timer (STALE_PROMPT_TIMEOUT_MS).
const LIFECYCLE_SANDBOX_LIVENESS_MS = SANDBOX_HEARTBEAT_LIVENESS_MS;

export function defaultLifecycleConfig(overrides: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return {
    startupTimeoutMs: LIFECYCLE_STARTUP_TIMEOUT_MS,
    promptDispatchTimeoutMs: LIFECYCLE_STARTUP_TIMEOUT_MS,
    runningInactivityMs: STALE_PROMPT_TIMEOUT_MS,
    sandboxReconnectGraceMs: SANDBOX_RECONNECT_GRACE_MS,
    sandboxLivenessMs: LIFECYCLE_SANDBOX_LIVENESS_MS,
    spawnTimeoutMs: SPAWN_CONNECT_TIMEOUT_MS,
    spawnFailureCircuitLimit: 3,
    spawnFailureResetMs: LIFECYCLE_SPAWN_FAILURE_RESET_MS,
    ...overrides,
  };
}

export function nextLifecycleDeadline(deadlines: LifecycleDeadlines, now: number): number | null {
  let next: number | null = null;
  for (const deadline of Object.values(deadlines)) {
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) continue;
    if (deadline <= now) continue;
    next = next === null ? deadline : Math.min(next, deadline);
  }
  return next;
}
