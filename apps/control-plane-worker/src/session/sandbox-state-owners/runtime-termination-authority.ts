/**
 * The single decision the termination chokepoint enforces: when a disconnect
 * lane is about to terminalize an in-flight prompt, may we kill the runtime, or
 * must we defer and let the bridge reconnect to the SAME still-alive E2B VM?
 *
 * Pure over already-resolved inputs (provider probing readiness, runtime
 * presence, the provider liveness probe, and the sustained-loss window) so
 * every branch is unit-testable without a DO or a network call. The DO method `confirmRuntimeDeadBeforeTerminalize`
 * resolves the inputs (reads `sandbox_state`, runs the `getSandboxInfo` probe)
 * and enacts the side effects (re-arm grace on `defer`, terminate as today).
 *
 * Fails safe against false disconnects: a provider-confirmed missing runtime
 * after the independent transport-loss window is the only terminal decision.
 * Tool activity, prompt inactivity, a silent transport, `alive`, `unknown`, a
 * probe error, or missing provider metadata can never manufacture a disconnect.
 */
export type RuntimeTerminationDecision = "terminate" | "defer";

/** E2B liveness as resolved by the `getSandboxInfo` probe (null = not probed). */
export type RuntimeLivenessProbe = "alive" | "dead" | "unknown" | null;

export interface RuntimeTerminationInputs {
  /** `E2B_ORPHAN_REAPER_LIVENESS_GUARD` — off leaves loss unconfirmed. */
  killSwitchEnabled: boolean;
  /** The DO still points at an E2B runtime we could reconnect a bridge to. */
  hasE2BRuntime: boolean;
  /** The independent transport-loss observation window has elapsed. */
  lossWindowElapsed: boolean;
  /** Probe outcome; only a decisive provider `dead` can terminate. */
  liveness: RuntimeLivenessProbe;
}

export function decideRuntimeTerminationOnDisconnect(inputs: RuntimeTerminationInputs): RuntimeTerminationDecision {
  if (!inputs.killSwitchEnabled) return "defer";
  if (!inputs.hasE2BRuntime) return "defer";
  if (!inputs.lossWindowElapsed) return "defer";
  return inputs.liveness === "dead" ? "terminate" : "defer";
}
