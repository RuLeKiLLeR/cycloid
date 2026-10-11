// Transient-disconnect visibility mask.
//
// Within the sandbox reconnect grace window (SANDBOX_RECONNECT_GRACE_MS, 90s),
// a disconnect is an implementation detail: control-plane deploys restart the
// session Durable Objects and sever every sandbox WebSocket, and the bridge
// normally reconnects in ~2s. Rendering "reconnecting" (and the derived phase
// flip it causes, e.g. review_listening -> running) for those blips is
// customer-visible churn with no actionable signal.
//
// This module is the shared render-side state machine for suppressing that
// churn: a live transition into `sandboxSubstate: "reconnecting"` keeps
// showing the pre-disconnect phase/substate until the disconnect has persisted
// for TRANSIENT_DISCONNECT_VISIBILITY_MS. The durable event stream and
// lifecycle state are untouched — this masks presentation only. Consumers:
// the web UI session view (useTransientDisconnectMask) and the CLI watch
// status line.
//
// A view that is ALREADY reconnecting when first observed (page load or watch
// start mid-grace) is never masked: the disconnect age is unknown and may
// exceed the threshold.

import type { Phase, SandboxSubstate } from "./phase.js";

// Default 15s: long enough that deploy-driven reconnects (~2s) never surface,
// short enough that a real outage becomes visible well before the 90s grace
// expiry turns it into prompt-failure messaging.
export const TRANSIENT_DISCONNECT_VISIBILITY_MS = 15_000;

export interface LifecycleView {
  phase: Phase;
  sandboxSubstate?: SandboxSubstate;
}

export interface DisconnectMask {
  // Epoch ms when the reconnecting transition was observed.
  since: number;
  // The phase/substate shown while the mask is active.
  heldPhase: Phase;
  heldSubstate: SandboxSubstate;
}

// Advance the mask for a newly observed lifecycle view. `previous` is the
// last observed view (before this update); it supplies the pre-disconnect
// phase/substate that the mask holds.
export function nextDisconnectMask(
  mask: DisconnectMask | null,
  previous: LifecycleView | null,
  current: LifecycleView | null,
  now: number,
): DisconnectMask | null {
  if (!current || current.sandboxSubstate !== "reconnecting") return null;
  if (mask) return mask;
  if (!previous || previous.sandboxSubstate === "reconnecting") return null;
  return { since: now, heldPhase: previous.phase, heldSubstate: previous.sandboxSubstate ?? "none" };
}

export function isDisconnectMaskActive(mask: DisconnectMask | null, now: number): boolean {
  return mask !== null && now - mask.since < TRANSIENT_DISCONNECT_VISIBILITY_MS;
}

// Returns the view to render: the held pre-disconnect phase/substate while the
// mask is active, the true view otherwise.
export function applyDisconnectMask<T extends LifecycleView>(view: T, mask: DisconnectMask | null, now: number): T {
  if (!isDisconnectMaskActive(mask, now)) return view;
  return { ...view, phase: mask!.heldPhase, sandboxSubstate: mask!.heldSubstate };
}
