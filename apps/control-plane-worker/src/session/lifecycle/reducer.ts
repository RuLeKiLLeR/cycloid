import type { ErrorCode } from "../../../../../shared/types/sandbox.js";
import { nextLifecycleDeadline } from "./deadlines";
import { pickTerminalErrorCode } from "./terminal-decision";
import type {
  BoundaryStopReason,
  LifecycleConfig,
  LifecycleDecision,
  LifecycleEvent,
  LifecycleState,
  LifecycleStatePatch,
} from "./types";

function activePromptMatches(state: LifecycleState, promptId: string): boolean {
  return state.prompt.promptId === promptId && state.prompt.phase !== "terminal";
}

function sandboxMatches(state: LifecycleState, sandboxId: string | null | undefined): boolean {
  return !sandboxId || !state.sandbox.sandboxId || state.sandbox.sandboxId === sandboxId;
}

function startupAttemptMatches(state: LifecycleState, startupAttemptId: string | null | undefined): boolean {
  const currentStartupAttemptId = state.prompt.startupAttemptId ?? state.sandbox.startupAttemptId;
  return !startupAttemptId || !currentStartupAttemptId || currentStartupAttemptId === startupAttemptId;
}

function persist(patch: LifecycleStatePatch, reason: string): LifecycleDecision {
  return { action: "persist_state", patch, reason };
}

function armNextDeadline(state: LifecycleState, patch: LifecycleStatePatch, now: number): LifecycleDecision[] {
  const deadlines = patch.deadlines;
  if (!deadlines) return [];
  const deadlineAt = nextLifecycleDeadline(
    {
      ...state.deadlines,
      ...deadlines,
    },
    now,
  );
  return deadlineAt === null ? [] : [{ action: "arm_alarm", deadlineAt, reason: "next lifecycle deadline" }];
}

function terminalPatch(
  state: LifecycleState,
  promptId: string,
  errorCode: ErrorCode,
  reason: string,
  // ARC-1196: callers that know the transport is still alive (terminal event
  // received over the socket) pass a re-armed liveness deadline; watchdog and
  // spawn-failure callers keep the default null.
  options: { sandboxLivenessAt?: number | null } = {},
): LifecycleDecision[] {
  const merged = pickTerminalErrorCode(state.prompt.terminalErrorCode, errorCode) ?? errorCode;
  return [
    persist(
      {
        prompt: {
          phase: "terminal",
          promptId,
          terminalErrorCode: merged,
          lastRunningActivityAt: null,
        },
        deadlines: {
          promptStartup: null,
          promptDispatch: null,
          promptRunningInactivity: null,
          sandboxLiveness: options.sandboxLivenessAt ?? null,
        },
      },
      reason,
    ),
    { action: "emit_terminal", promptId, errorCode: merged, reason },
  ];
}

function reviewListeningExitPatch(): LifecycleStatePatch["reviewListening"] {
  return { active: false, prUrl: null, currentHeadSha: null, enteredAt: null };
}

function finalizeStoppedDecisions(
  stopReason: BoundaryStopReason,
  reason: string,
  options: { preserveExistingStopReason?: boolean; reviewListeningExit?: boolean } = {},
): LifecycleDecision[] {
  // Single combined decision so the applier can perform the DO-storage patch
  // and the D1 sandbox_state write atomically, with one rich_status sync +
  // broadcast at the end. Emitting persist_state separately would let the
  // applyLifecycleStatePatch sync run before stopReason lands in D1 and
  // broadcast a transient "stopped_resumable" to clients.
  const patch: LifecycleStatePatch = {
    sandbox: { state: "stopped", spawnInProgress: false },
    deadlines: {
      sandboxReconnectGrace: null,
      sandboxLiveness: null,
      spawnTimeout: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
    },
    ...(options.reviewListeningExit ? { reviewListening: reviewListeningExitPatch() } : {}),
  };
  return [
    {
      action: "finalize_sandbox_stopped",
      stopReason,
      preserveExistingStopReason: options.preserveExistingStopReason ?? false,
      patch,
      reason,
    },
  ];
}

export function reduceLifecycle(
  state: LifecycleState,
  event: LifecycleEvent,
  config: LifecycleConfig,
  now: number,
): LifecycleDecision[] {
  // Boundary events bypass the archived no-op:
  //  - close_finalize runs immediately after the archive flip and must still
  //    finalize the sandbox (computeRichStatus short-circuits to "archived").
  //  - transport_stop_finalize can arrive after archive when the sandbox WS
  //    closes; matches pre-migration behavior of handleSandboxClose.
  //  - intentional_pause_close can also arrive after archive (the E2B WS may
  //    close just as the archive flip lands); clearing markers is safe and
  //    matches pre-migration handleSandboxClose behavior.
  // All other events are no-ops so archived sessions cannot otherwise mutate.
  if (
    state.sessionStatus === "archived" &&
    event.type !== "boundary.close_finalize" &&
    event.type !== "boundary.transport_stop_finalize" &&
    event.type !== "boundary.intentional_pause_close" &&
    event.type !== "review_listening.exited"
  ) {
    return [{ action: "noop", reason: "session archived" }];
  }

  switch (event.type) {
    case "sandbox.spawn_requested": {
      const resetFailures =
        state.sandbox.lastSpawnFailureAt !== null &&
        now - state.sandbox.lastSpawnFailureAt >= config.spawnFailureResetMs;
      const failureCount = resetFailures ? 0 : state.sandbox.spawnFailureCount;
      if (failureCount >= config.spawnFailureCircuitLimit) {
        if (state.prompt.promptId && state.prompt.phase !== "terminal") {
          return terminalPatch(state, state.prompt.promptId, "spawn_preconnect", "spawn circuit open");
        }
        return [{ action: "noop", reason: "spawn circuit open" }];
      }
      const patch: LifecycleStatePatch = {
        sandbox: {
          state: "spawning",
          startupAttemptId: event.startupAttemptId,
          spawnInProgress: true,
          // Spawning fresh abandons any prior transport. Clear the reconnect
          // markers so a stale reconnect-grace alarm armed by a now-superseded
          // ws_disconnected cannot fire mid-spawn, flip `spawning` back to
          // `stopped`, and terminalize the prompt this spawn is serving.
          disconnectStartedAt: null,
          ...(resetFailures ? { spawnFailureCount: 0, lastSpawnFailureAt: null } : {}),
        },
        deadlines: { spawnTimeout: now + config.spawnTimeoutMs, sandboxReconnectGrace: null },
      };
      return [
        persist(patch, "sandbox spawn requested"),
        { action: "spawn_sandbox", reason: "sandbox spawn requested" },
        ...armNextDeadline(state, patch, now),
      ];
    }
    case "sandbox.spawn_succeeded": {
      if (state.sandbox.startupAttemptId && state.sandbox.startupAttemptId !== event.startupAttemptId) {
        return [{ action: "noop", reason: "stale spawn succeeded" }];
      }
      return [
        persist(
          {
            sandbox: {
              state: "connecting",
              sandboxId: event.sandboxId,
              spawnInProgress: false,
              spawnFailureCount: 0,
              lastSpawnFailureAt: null,
            },
            deadlines: { spawnTimeout: null },
          },
          "sandbox spawn succeeded",
        ),
      ];
    }
    case "sandbox.spawn_failed": {
      if (state.sandbox.startupAttemptId && state.sandbox.startupAttemptId !== event.startupAttemptId) {
        return [{ action: "noop", reason: "stale spawn failed" }];
      }
      const failureCount = state.sandbox.spawnFailureCount + 1;
      const decisions: LifecycleDecision[] = [
        persist(
          {
            sandbox: {
              state: "failed",
              spawnInProgress: false,
              spawnFailureCount: failureCount,
              lastSpawnFailureAt: now,
            },
            deadlines: { spawnTimeout: null },
          },
          "sandbox spawn failed",
        ),
      ];
      if (state.prompt.promptId && state.prompt.phase !== "terminal") {
        decisions.push(
          ...terminalPatch(state, state.prompt.promptId, event.errorCode ?? "spawn_timeout", "sandbox spawn failed"),
        );
      }
      return decisions;
    }
    case "sandbox.ws_connected": {
      const patch: LifecycleStatePatch = {
        sandbox: {
          state: "ready",
          sandboxId: event.sandboxId,
          lastHeartbeatAt: now,
          spawnInProgress: false,
          // Transport reconnected: clear the D1 markers the reducer set on
          // ws_disconnected (and any auto-close scheduled during the gap).
          disconnectStartedAt: null,
          autoCloseScheduledAt: null,
        },
        deadlines: {
          sandboxReconnectGrace: null,
          spawnTimeout: null,
          // Phase-independent: seed the liveness deadline on accept so a socket
          // that connects but never produces real heartbeats converges within
          // the window, regardless of whether a prompt is running.
          sandboxLiveness: now + config.sandboxLivenessMs,
        },
      };
      return [persist(patch, "sandbox websocket connected"), ...armNextDeadline(state, patch, now)];
    }
    case "sandbox.heartbeat_received": {
      if (!sandboxMatches(state, event.sandboxId)) return [{ action: "noop", reason: "stale sandbox heartbeat" }];
      const patch: LifecycleStatePatch = {
        sandbox: { lastHeartbeatAt: now },
        deadlines: {
          // Phase-independent: every heartbeat re-arms the liveness deadline so
          // a bridge that stops beating converges from its last beat.
          sandboxLiveness: now + config.sandboxLivenessMs,
        },
      };
      return [persist(patch, "sandbox heartbeat received"), ...armNextDeadline(state, patch, now)];
    }
    case "sandbox.ws_disconnected": {
      if (!sandboxMatches(state, event.sandboxId)) return [{ action: "noop", reason: "stale sandbox disconnect" }];
      // A clean close starts reconnect grace, but it does not start a fresh
      // recovery budget. Anchor the deadline to the last proven bridge beat so
      // provider-visible VM state and prompt/tool activity cannot stretch a
      // dead bridge beyond the phase-independent liveness window. If the beat
      // is already stale, persist the past-due deadline; SessionDO's immediate
      // catch-up alarm path will fire it rather than dropping it.
      const lastBridgeContactAt = state.sandbox.lastHeartbeatAt ?? now;
      const reconnectDeadlineAt = Math.min(
        now + config.sandboxReconnectGraceMs,
        lastBridgeContactAt + config.sandboxLivenessMs,
      );
      const patch: LifecycleStatePatch = {
        // disconnectStartedAt powers the alarm's reconnect-grace candidate
        // (rescheduleSessionAlarm reads sandbox.disconnectStartedAt). Set it
        // here so ws-manager no longer needs to write it directly.
        sandbox: { state: "reconnecting", disconnectStartedAt: now },
        deadlines: { sandboxReconnectGrace: reconnectDeadlineAt, sandboxLiveness: null },
      };
      return [persist(patch, "sandbox websocket disconnected"), ...armNextDeadline(state, patch, now)];
    }
    case "sandbox.reconnect_grace_expired": {
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "stale reconnect grace deadline" }];
      const decisions: LifecycleDecision[] = [
        persist(
          {
            sandbox: { state: "stopped" },
            deadlines: { sandboxReconnectGrace: null, sandboxLiveness: null },
          },
          "sandbox reconnect grace expired",
        ),
      ];
      if (state.prompt.promptId && state.prompt.phase !== "terminal") {
        decisions.push(
          ...terminalPatch(state, state.prompt.promptId, "sandbox_disconnected", "sandbox reconnect grace expired"),
        );
      }
      return decisions;
    }
    case "sandbox.liveness_expired": {
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "stale sandbox liveness deadline" }];
      const decisions: LifecycleDecision[] = [
        persist(
          {
            sandbox: { state: "stopped" },
            deadlines: { sandboxLiveness: null, sandboxReconnectGrace: null },
          },
          "sandbox liveness expired",
        ),
      ];
      if (state.prompt.promptId && state.prompt.phase !== "terminal") {
        decisions.push(
          ...terminalPatch(state, state.prompt.promptId, "sandbox_disconnected", "sandbox liveness expired"),
        );
      }
      return decisions;
    }
    case "boundary.pre_publish_stall_expired": {
      const reason = "pre-publish stall backstop expired";
      const decisions: LifecycleDecision[] = [
        persist(
          {
            sandbox: { state: "failed", spawnInProgress: false },
            deadlines: {
              sandboxReconnectGrace: null,
              sandboxLiveness: null,
              promptStartup: null,
              promptDispatch: null,
              promptRunningInactivity: null,
              spawnTimeout: null,
            },
          },
          reason,
        ),
      ];
      if (state.prompt.promptId && state.prompt.phase !== "terminal") {
        decisions.push(...terminalPatch(state, state.prompt.promptId, "sandbox_disconnected", reason));
      }
      return decisions;
    }
    case "sandbox.stop_requested":
      return [
        persist({ sandbox: { state: "stopping" } }, "sandbox stop requested"),
        { action: "stop_sandbox", reason: "sandbox stop requested" },
      ];
    case "sandbox.stop_completed":
      if (!sandboxMatches(state, event.sandboxId)) return [{ action: "noop", reason: "stale sandbox stop completed" }];
      return [
        persist(
          {
            sandbox: { state: "stopped", spawnInProgress: false },
            deadlines: { sandboxReconnectGrace: null, sandboxLiveness: null, spawnTimeout: null },
          },
          "sandbox stop completed",
        ),
      ];
    case "prompt.enqueued":
      return [
        persist(
          {
            prompt: {
              phase: "queued",
              promptId: event.promptId,
              startupAttemptId: null,
              sandboxId: null,
              queuedAt: now,
              sentToBridgeAt: null,
              bridgeAcceptedAt: null,
              codexPromptSentAt: null,
              lastRunningActivityAt: null,
              terminalErrorCode: null,
            },
            deadlines: { promptDispatch: null },
          },
          "prompt enqueued",
        ),
      ];
    case "prompt.sent_to_bridge": {
      if (!activePromptMatches(state, event.promptId) || state.prompt.phase !== "queued") {
        return [{ action: "noop", reason: "stale prompt sent to bridge" }];
      }
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for prompt dispatch" }];
      const patch: LifecycleStatePatch = {
        prompt: {
          phase: "dispatching",
          promptId: event.promptId,
          sandboxId: event.sandboxId,
          sentToBridgeAt: now,
        },
        deadlines: {
          promptStartup: now + config.startupTimeoutMs,
          promptDispatch: null,
          promptRunningInactivity: null,
        },
      };
      return [persist(patch, "prompt sent to bridge"), ...armNextDeadline(state, patch, now)];
    }
    case "prompt.bridge_accepted":
    case "prompt.dispatching_progress": {
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale dispatching prompt event" }];
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for dispatching event" }];
      if (!startupAttemptMatches(state, event.startupAttemptId ?? null))
        return [{ action: "noop", reason: "stale startup attempt" }];
      const patch: LifecycleStatePatch = {
        prompt: {
          phase: "dispatching",
          promptId: event.promptId,
          startupAttemptId: event.startupAttemptId ?? state.prompt.startupAttemptId,
          sandboxId: event.sandboxId,
          bridgeAcceptedAt: event.type === "prompt.bridge_accepted" ? now : state.prompt.bridgeAcceptedAt,
        },
        deadlines: { promptStartup: state.deadlines.promptStartup ?? now + config.startupTimeoutMs },
      };
      return [persist(patch, event.type), ...armNextDeadline(state, patch, now)];
    }
    case "prompt.agent_prompt_sent": {
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale running prompt event" }];
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for running event" }];
      if (!startupAttemptMatches(state, event.startupAttemptId ?? null)) {
        return [{ action: "noop", reason: "stale startup attempt" }];
      }
      if (state.prompt.phase === "running")
        return [{ action: "noop", reason: "running prompt already observed execution" }];
      const patch: LifecycleStatePatch = {
        prompt: {
          phase: "dispatching",
          promptId: event.promptId,
          sandboxId: event.sandboxId,
          codexPromptSentAt: now,
        },
        deadlines: {
          promptStartup: null,
          promptDispatch: now + config.promptDispatchTimeoutMs,
        },
      };
      return [persist(patch, event.type), ...armNextDeadline(state, patch, now)];
    }
    case "prompt.running_activity": {
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale running prompt event" }];
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for running event" }];
      if (!startupAttemptMatches(state, event.startupAttemptId ?? null)) {
        return [{ action: "noop", reason: "stale startup attempt" }];
      }
      const patch: LifecycleStatePatch = {
        prompt: {
          phase: "running",
          promptId: event.promptId,
          sandboxId: event.sandboxId,
          lastRunningActivityAt: now,
        },
        deadlines: {
          promptDispatch: null,
          promptRunningInactivity: now + config.runningInactivityMs,
          sandboxLiveness: now + config.sandboxLivenessMs,
        },
      };
      return [persist(patch, event.type), ...armNextDeadline(state, patch, now)];
    }
    case "prompt.terminal_received": {
      if (!activePromptMatches(state, event.promptId)) {
        const merged = pickTerminalErrorCode(state.prompt.terminalErrorCode, event.errorCode ?? null);
        if (state.prompt.promptId === event.promptId && merged !== state.prompt.terminalErrorCode) {
          return [persist({ prompt: { terminalErrorCode: merged } }, "terminal precedence merge")];
        }
        return [{ action: "noop", reason: "stale terminal prompt event" }];
      }
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for terminal event" }];
      // ARC-1196: prompt terminal must NOT clear the phase-independent sandbox
      // liveness watchdog while the transport is still alive (the terminal
      // event arrived over the socket). Clearing it left idle sessions
      // unwatched until the next heartbeat — which a zombie never sends.
      // Genuinely-terminal sandbox transitions still clear it via
      // finalizeStoppedDecisions.
      const sandboxAlive = state.sandbox.state === "ready" || state.sandbox.state === "reconnecting";
      const sandboxLivenessAfterTerminal = sandboxAlive ? now + config.sandboxLivenessMs : null;
      const terminalDeadlines = {
        promptStartup: null,
        promptDispatch: null,
        promptRunningInactivity: null,
        sandboxLiveness: sandboxLivenessAfterTerminal,
      };
      if (!event.errorCode) {
        const patch: LifecycleStatePatch = {
          prompt: {
            phase: "terminal",
            promptId: event.promptId,
            terminalErrorCode: null,
            lastRunningActivityAt: null,
          },
          deadlines: terminalDeadlines,
        };
        return [persist(patch, "prompt terminal received"), ...armNextDeadline(state, patch, now)];
      }
      return [
        ...terminalPatch(state, event.promptId, event.errorCode ?? "unknown", "prompt terminal received", {
          sandboxLivenessAt: sandboxLivenessAfterTerminal,
        }),
        ...armNextDeadline(state, { deadlines: terminalDeadlines }, now),
      ];
    }
    case "prompt.startup_deadline_elapsed":
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale prompt startup deadline" }];
      if (state.prompt.phase === "running")
        return [{ action: "noop", reason: "running prompt ignores startup deadline" }];
      if (state.prompt.codexPromptSentAt !== null)
        return [{ action: "noop", reason: "prompt already dispatched to codex" }];
      return terminalPatch(
        state,
        event.promptId,
        state.prompt.bridgeAcceptedAt !== null ? "codex_prompt_dispatch_timeout" : "codex_startup_timeout",
        "prompt startup deadline elapsed",
      );
    case "prompt.dispatch_deadline_elapsed":
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale prompt dispatch deadline" }];
      if (state.prompt.phase === "running")
        return [{ action: "noop", reason: "running prompt ignores dispatch deadline" }];
      if (state.prompt.codexPromptSentAt === null)
        return [{ action: "noop", reason: "prompt not dispatched to codex" }];
      return terminalPatch(state, event.promptId, "codex_prompt_dispatch_timeout", "prompt dispatch deadline elapsed");
    case "prompt.running_keepalive": {
      if (!activePromptMatches(state, event.promptId)) return [{ action: "noop", reason: "stale running keepalive" }];
      if (!sandboxMatches(state, event.sandboxId))
        return [{ action: "noop", reason: "mismatched sandbox for keepalive" }];
      if (state.prompt.phase === "dispatching") {
        if (state.prompt.bridgeAcceptedAt !== null)
          return [{ action: "noop", reason: "dispatching keepalive already accepted" }];
        const patch: LifecycleStatePatch = {
          prompt: { bridgeAcceptedAt: now },
          deadlines: { promptStartup: state.deadlines.promptStartup ?? now + config.startupTimeoutMs },
        };
        return [persist(patch, "dispatching keepalive"), ...armNextDeadline(state, patch, now)];
      }
      if (state.prompt.phase !== "running") return [{ action: "noop", reason: "non-running prompt ignores keepalive" }];
      if (!event.activeToolCall) return [{ action: "noop", reason: "model wait keepalive without active tool" }];
      const patch: LifecycleStatePatch = {
        deadlines: { promptRunningInactivity: now + config.runningInactivityMs },
      };
      return [persist(patch, "running keepalive"), ...armNextDeadline(state, patch, now)];
    }
    case "prompt.running_inactivity_elapsed":
      if (!activePromptMatches(state, event.promptId))
        return [{ action: "noop", reason: "stale running inactivity deadline" }];
      if (state.prompt.phase !== "running")
        return [{ action: "noop", reason: "non-running prompt ignores running inactivity deadline" }];
      return terminalPatch(state, event.promptId, "stale_prompt", "prompt running inactivity elapsed");
    case "prompt.abort_requested":
      if (!activePromptMatches(state, event.promptId)) {
        return [{ action: "noop", reason: "stale prompt abort" }];
      }
      return terminalPatch(state, event.promptId, "aborted", "prompt abort requested");
    case "boundary.stop_finalize":
      return finalizeStoppedDecisions(event.stopReason, event.reason, {
        reviewListeningExit: event.stopReason === "user",
      });
    case "boundary.close_finalize":
      return finalizeStoppedDecisions(null, event.reason, { reviewListeningExit: true });
    case "boundary.transport_stop_finalize":
      return finalizeStoppedDecisions(event.stopReason, event.reason, { preserveExistingStopReason: true });
    case "boundary.auto_close_scheduled":
      // No lifecycle-state transition; only the D1 timestamp moves. The alarm
      // re-reads sandbox.autoCloseScheduledAt to decide when to fire the close.
      return [persist({ sandbox: { autoCloseScheduledAt: now } }, "auto-close scheduled")];
    case "boundary.intentional_pause_close":
      // E2B intentional pause closed the WS. Clear transport markers so the
      // alarm does not later treat this as an unexpected disconnect. Lifecycle
      // sandbox state stays where pauseE2BRuntimeForIdle put it.
      return [
        persist({ sandbox: { disconnectStartedAt: null, autoCloseScheduledAt: null } }, "intentional pause WS close"),
      ];
    case "review_listening.entered":
      return [
        persist(
          {
            reviewListening: {
              active: true,
              prUrl: event.prUrl,
              currentHeadSha: event.currentHeadSha,
              enteredAt: now,
            },
          },
          "review listening entered",
        ),
      ];
    case "review_listening.epoch_enqueued":
      return [
        persist(
          {
            reviewListening: {
              active: true,
              prUrl: event.prUrl,
              currentHeadSha: event.currentHeadSha,
              // This event fires only on a genuine head change (the head route short-circuits when
              // unchanged). Restart the no-show window for the new head: reviewers have not seen the
              // new commit yet, so the wait begins now. Anchoring on the original arm time would let a
              // long-armed listen settle the bot no-show immediately on a fresh push.
              enteredAt: now,
            },
          },
          "review listening epoch enqueued",
        ),
      ];
    case "review_listening.exited":
      return [persist({ reviewListening: reviewListeningExitPatch() }, `review listening exited: ${event.reason}`)];
    default:
      return [{ action: "noop", reason: "unknown lifecycle event" }];
  }
}
