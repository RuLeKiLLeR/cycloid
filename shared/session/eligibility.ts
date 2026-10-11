// Canonical eligibility helpers — "given current state, may the user take this action?"
// Distinct from `shared/session/phase.ts`, which owns the state machine. Every
// gate (server view payload, canonical enqueue/DO gate, UI consumers) calls
// these helpers so no decision site can drift.

import type { Phase, SandboxSubstate, StopMode } from "./phase.js";

// `true` ⇒ the textarea/composer is disabled and the route/DO must reject.
// `false` ⇒ a follow-up prompt is accepted (queued, processed, or used to
// auto-resume a resumable-stopped sandbox).
//
// Disabled set: `archived | blocked | failed | finalizing | stopped(stopMode=user)`.
// `finalizing` is treated as disabled because queueing a prompt during the
// publish-prep window would race the publish flow. Resumable-stopped sessions
// remain enabled — the next prompt cold-resumes the sandbox.
//
// `(running, sandboxSubstate=creating)` stays enabled: queue-while-spawning is
// intended product behavior and asserted by `tests/test_ui/prompt-form.test.ts`.
export function isPromptSendDisabled(
  phase: Phase,
  stopMode: StopMode | undefined,
  // `sandboxSubstate` is intentionally unused — queue-while-spawning
  // (`running` + `creating`) is allowed by design; the DO drains the queue
  // once the sandbox finishes. Add a substate branch here only if a specific
  // substate needs to be gated at the eligibility level.
  _sandboxSubstate: SandboxSubstate | undefined,
  _planApprovalPending: boolean,
): boolean {
  if (phase === "archived" || phase === "blocked" || phase === "failed" || phase === "finalizing") {
    return true;
  }
  if (phase === "stopped" && stopMode === "user") {
    return true;
  }
  return false;
}

// Structured-error code surfaced by the canonical gate on rejection. The route
// layer lifts this into a 409 envelope `{ ok: false, error, reason }` where
// `reason` is the offending phase. Webhook callers `switch` on this code with a
// `default` fallback. Sibling actions in follow-up PRs use the same envelope
// shape with `session_not_<action>` codes.
export const PROMPT_SEND_BLOCKED_ERROR = "session_not_sendable" as const;

// `true` ⇒ the user can stop the session right now. A stop is meaningful only
// while a prompt is actively running or waiting for input — every other phase
// either already isn't running (idle/review_listening/completed/blocked/failed/stopped/archived)
// or is mid-publish (finalizing) where stopping doesn't undo the publish.
//
// The sandbox transport substate also gates: stop while sandbox is `creating`
// or `reconnecting` returns a 409 from the DO because there's no socket yet,
// so surfacing the button would expose a predictably-failing action.
export function isStopAvailable(
  phase: Phase,
  sandboxSubstate: SandboxSubstate | undefined,
  _planApprovalPending: boolean,
): boolean {
  if (phase !== "running" && phase !== "waiting_for_input") return false;
  if (sandboxSubstate === "creating" || sandboxSubstate === "reconnecting") return false;
  return true;
}

export const STOP_BLOCKED_ERROR = "session_not_stoppable" as const;

// `true` ⇒ the user can pre-warm a sandbox for the session. Warming is a no-op
// when a sandbox is already running, so the helper rejects running/waiting_for_input.
// Archived is closed; finalizing/blocked are mid-publish. Everything else
// (idle/review_listening/completed/failed/stopped) is a sensible warm target — the DO still
// short-circuits if the sandbox is already connected.
export function isWarmAvailable(phase: Phase): boolean {
  if (phase === "archived" || phase === "running" || phase === "waiting_for_input") return false;
  if (phase === "finalizing" || phase === "blocked") return false;
  return true;
}

export const WARM_BLOCKED_ERROR = "session_not_warmable" as const;

// `true` ⇒ the session is currently stopped (hard or resumable) and a resume
// is a meaningful action. Hard-stopped + paused-E2B is included: the runtime's
// existing resume path covers both stopMode flavors. The route still applies
// the resume rate limit + repo-access check around this; the helper is only
// the phase-eligibility floor.
export function isResumeAvailable(phase: Phase): boolean {
  return phase === "stopped";
}

export const RESUME_BLOCKED_ERROR = "session_not_resumable" as const;

// `true` ⇒ the agent is currently asking a question and the user can respond.
// The phase machine collapses "active prompt + pending question" into
// `waiting_for_input`, which is also used by the plan-approval park. The
// explicit flag distinguishes those states; only a real pending question can
// accept a response. The DO still verifies its runtime `hasPendingQuestion`
// flag before forwarding to the sandbox.
export function isRespondAvailable(phase: Phase, planApprovalPending: boolean): boolean {
  return phase === "waiting_for_input" && !planApprovalPending;
}

export const RESPOND_BLOCKED_ERROR = "session_not_respondable" as const;

// `true` ⇒ the user can replay the last terminal prompt, via
// `POST /api/sessions/:sessionId/retry` forwarding to the DO's
// `/session/retry`. Retry clones the most recent completed/failed prompt and
// re-queues it, so every phase that can hold a queued prompt is retryable.
// Archived is closed; finalizing is blocked for the same reason sends are
// blocked: a queued prompt would race the publish-prep window. This helper is
// the phase floor only — the DO additionally rejects (400) when no
// completed/failed prompt exists to clone, a history check that needs prompt
// rows and therefore stays in the DO.
export function isRetryAvailable(phase: Phase): boolean {
  return phase !== "archived" && phase !== "finalizing";
}

export const RETRY_BLOCKED_ERROR = "session_not_retryable" as const;

// `true` ⇒ the user can archive (close) the session. Once archived, the
// `archive` action is a no-op — `isArchiveAvailable` returns false. Every
// other phase is archivable; the close transition is unconditional from the
// reducer's perspective (it just flips `status` to "archived" and runs
// `boundary.close_finalize`).
//
// `canSetRepo` is intentionally NOT modeled here. The repo-set route has no
// natural "forbidden phase" — repo selection happens once near session
// creation, and post-creation calls already 4xx on invalid input. Adding a
// `canSetRepo` field would be YAGNI; see the plan's PR 6e decision row.
export function isArchiveAvailable(phase: Phase): boolean {
  return phase !== "archived";
}
