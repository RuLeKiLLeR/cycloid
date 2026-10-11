import type { LifecycleEvent } from "../lifecycle/types.js";

/**
 * Disconnect-terminal lifecycle events: a silent VM death (heartbeat liveness
 * lease lapses) or a clean WS close whose reconnect grace expires. Neither must
 * terminalize the active prompt inside the reducer — the alarm handler routes a
 * still-`processing` prompt through the bounded disconnect re-enqueue
 * (`failActivePromptOnDisconnect` -> `retryActivePromptAfterDisconnect`) so a
 * mid-prompt VM death re-runs on a fresh sandbox instead of failing the session.
 * Their `emit_terminal` decision is therefore suppressed (`applyTerminal: false`).
 */
export const DISCONNECT_TERMINAL_LIFECYCLE_EVENTS: ReadonlySet<LifecycleEvent["type"]> = new Set([
  "sandbox.reconnect_grace_expired",
  "sandbox.liveness_expired",
]);

/**
 * Prompt-deadline events that finalize the active prompt and sort AHEAD of
 * `sandbox.liveness_expired` in `dispatchLifecycleAlarm`'s ordering. When a
 * disconnect-terminal event is due in the same alarm batch, letting one of these
 * terminalize the prompt first would defeat the re-enqueue (the prompt would no
 * longer be `processing` by the time the disconnect routes). Defer their
 * terminalization too so the disconnect path wins — the bounded re-run still
 * caps a genuinely stuck prompt, and a VM death is the more recoverable cause.
 *
 * INVARIANT (keep in sync with `dispatchLifecycleAlarm`'s `order` table in
 * durable-object.ts): this set must contain every prompt-deadline event whose
 * `order` is below `sandbox.liveness_expired` (11). Today that is
 * startup (3), dispatch (4), and running-inactivity (5). If a new prompt-deadline
 * lifecycle event is added at an order below liveness, add it here too — there is
 * no compile-time check, so a miss silently lets a co-batched deadline finalize
 * the prompt ahead of the disconnect re-enqueue.
 */
export const DISCONNECT_PREEMPTED_PROMPT_DEADLINE_EVENTS: ReadonlySet<LifecycleEvent["type"]> = new Set([
  "prompt.startup_deadline_elapsed",
  "prompt.dispatch_deadline_elapsed",
  "prompt.running_inactivity_elapsed",
]);

/**
 * Whether the reducer's terminalization for `eventType` should be deferred this
 * alarm batch (passed as `applyTerminal: false`). Pure so the precedence is
 * unit-testable independently of the Durable Object.
 *
 * - Disconnect-terminal events are always deferred (routed by the alarm handler).
 * - Prompt-deadline events are deferred only when a disconnect-terminal event is
 *   also due in the same batch (`batchHasDisconnectTerminal`).
 */
export function shouldDeferLifecycleTerminal(
  eventType: LifecycleEvent["type"],
  batchHasDisconnectTerminal: boolean,
): boolean {
  if (DISCONNECT_TERMINAL_LIFECYCLE_EVENTS.has(eventType)) return true;
  return batchHasDisconnectTerminal && DISCONNECT_PREEMPTED_PROMPT_DEADLINE_EVENTS.has(eventType);
}
