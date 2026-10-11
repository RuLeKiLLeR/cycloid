import type { ErrorCode } from "../../../../../shared/types/sandbox.js";

export type LifecycleSandboxState =
  "none" | "spawning" | "connecting" | "ready" | "reconnecting" | "stopping" | "stopped" | "failed";

export type LifecyclePromptPhase = "none" | "queued" | "dispatching" | "running" | "terminal";

export type LifecycleSessionStatus = "active" | "archived";

export interface LifecycleReviewListeningState {
  active: boolean;
  prUrl: string | null;
  currentHeadSha: string | null;
  enteredAt: number | null;
}

export interface LifecycleState {
  sessionStatus: LifecycleSessionStatus;
  sandbox: {
    state: LifecycleSandboxState;
    sandboxId: string | null;
    startupAttemptId: string | null;
    spawnInProgress: boolean;
    spawnFailureCount: number;
    lastSpawnFailureAt: number | null;
    lastHeartbeatAt: number | null;
  };
  prompt: {
    phase: LifecyclePromptPhase;
    promptId: string | null;
    startupAttemptId: string | null;
    sandboxId: string | null;
    queuedAt: number | null;
    sentToBridgeAt: number | null;
    bridgeAcceptedAt: number | null;
    codexPromptSentAt: number | null;
    lastRunningActivityAt: number | null;
    terminalErrorCode: ErrorCode | null;
  };
  reviewListening: LifecycleReviewListeningState;
  deadlines: LifecycleDeadlines;
}

export interface LifecycleDeadlines {
  sandboxReconnectGrace: number | null;
  sandboxLiveness: number | null;
  promptStartup: number | null;
  promptDispatch: number | null;
  promptRunningInactivity: number | null;
  spawnTimeout: number | null;
}

export type LifecycleSandboxPatch = Partial<LifecycleState["sandbox"]> & {
  // D1-only transport markers. They do not live in DO storage `LifecycleState`,
  // but they are written through the applier so the reducer is the single
  // source of truth for set/clear (reconnect-grace + auto-close scheduling).
  disconnectStartedAt?: number | null;
  autoCloseScheduledAt?: number | null;
};

export type LifecycleStatePatch = Partial<{
  sandbox: LifecycleSandboxPatch;
  prompt: Partial<LifecycleState["prompt"]>;
  reviewListening: Partial<LifecycleState["reviewListening"]>;
  deadlines: Partial<LifecycleDeadlines>;
}>;

export interface LifecycleConfig {
  startupTimeoutMs: number;
  promptDispatchTimeoutMs: number;
  runningInactivityMs: number;
  sandboxReconnectGraceMs: number;
  sandboxLivenessMs: number;
  spawnTimeoutMs: number;
  spawnFailureCircuitLimit: number;
  spawnFailureResetMs: number;
}

export type BoundaryStopReason = "user" | "reaped" | "spawn_failed" | null;

export type LifecycleDecision =
  | { action: "noop"; reason: string }
  | { action: "persist_state"; patch: LifecycleStatePatch; reason: string }
  | { action: "arm_alarm"; deadlineAt: number; reason: string }
  | { action: "emit_terminal"; promptId: string; errorCode: ErrorCode; reason: string }
  | { action: "spawn_sandbox"; reason: string }
  | { action: "stop_sandbox"; reason: string }
  | {
      action: "finalize_sandbox_stopped";
      stopReason: BoundaryStopReason;
      // When true, the applier preserves an existing non-null sandbox.stopReason
      // ("first authoritative transition wins"); transport-driven stops set this
      // so a transport WS close after a user-stop does not overwrite "user".
      preserveExistingStopReason: boolean;
      patch: LifecycleStatePatch;
      reason: string;
    };

export type LifecycleEvent =
  | { type: "sandbox.spawn_requested"; startupAttemptId: string }
  | { type: "sandbox.spawn_succeeded"; startupAttemptId: string; sandboxId: string }
  | { type: "sandbox.spawn_failed"; startupAttemptId: string; errorCode?: ErrorCode }
  | { type: "sandbox.ws_connected"; sandboxId: string }
  | { type: "sandbox.heartbeat_received"; sandboxId: string }
  | { type: "sandbox.ws_disconnected"; sandboxId: string }
  | { type: "sandbox.reconnect_grace_expired"; sandboxId: string | null }
  | { type: "sandbox.liveness_expired"; sandboxId: string }
  | { type: "sandbox.stop_requested" }
  | { type: "sandbox.stop_completed"; sandboxId?: string }
  | { type: "prompt.enqueued"; promptId: string }
  | { type: "prompt.sent_to_bridge"; promptId: string; sandboxId: string }
  | { type: "prompt.bridge_accepted"; promptId: string; sandboxId: string; startupAttemptId?: string | null }
  | { type: "prompt.dispatching_progress"; promptId: string; sandboxId: string; startupAttemptId?: string | null }
  | { type: "prompt.agent_prompt_sent"; promptId: string; sandboxId: string; startupAttemptId?: string | null }
  | { type: "prompt.running_activity"; promptId: string; sandboxId: string; startupAttemptId?: string | null }
  | { type: "prompt.running_keepalive"; promptId: string; sandboxId: string; activeToolCall: boolean }
  // `stoppedByUser`: the DO corroborated this terminal as a delivered control-plane stop (the bridge's
  // deliberate "Stopped by user" abort reason) — distinguishes a real stop from classifyError's
  // text-matched "aborted" (init AbortError, external session delete, failsafe aborts). Reducer-ignored;
  // consumed by the FSM transport producer for the quiet STOPPED routing.
  | {
      type: "prompt.terminal_received";
      promptId: string;
      sandboxId?: string | null;
      errorCode?: ErrorCode | null;
      stoppedByUser?: boolean;
    }
  | { type: "prompt.startup_deadline_elapsed"; promptId: string }
  | { type: "prompt.dispatch_deadline_elapsed"; promptId: string }
  | { type: "prompt.running_inactivity_elapsed"; promptId: string }
  | { type: "prompt.abort_requested"; promptId: string }
  | { type: "boundary.stop_finalize"; stopReason: BoundaryStopReason; reason: string }
  | { type: "boundary.close_finalize"; reason: string }
  | { type: "boundary.transport_stop_finalize"; stopReason: BoundaryStopReason; reason: string }
  | { type: "boundary.pre_publish_stall_expired" }
  // Auto-close grace timer: scheduled when the sandbox WS closes with no
  // active prompt, fired by the alarm to finalize the session as stopped.
  | { type: "boundary.auto_close_scheduled" }
  // Intentional E2B idle-pause WS close: clear transport markers without
  // finalizing. The sandbox state stays where pauseE2BRuntimeForIdle left it.
  | { type: "boundary.intentional_pause_close" }
  | { type: "review_listening.entered"; prUrl: string; currentHeadSha: string }
  | { type: "review_listening.epoch_enqueued"; prUrl: string; currentHeadSha: string }
  | {
      type: "review_listening.exited";
      reason: "merged" | "closed" | "archived" | "user_stop" | "draft_republish" | "max_monitoring_ttl";
    };

export function createEmptyLifecycleState(): LifecycleState {
  return {
    sessionStatus: "active",
    sandbox: {
      state: "none",
      sandboxId: null,
      startupAttemptId: null,
      spawnInProgress: false,
      spawnFailureCount: 0,
      lastSpawnFailureAt: null,
      lastHeartbeatAt: null,
    },
    prompt: {
      phase: "none",
      promptId: null,
      startupAttemptId: null,
      sandboxId: null,
      queuedAt: null,
      sentToBridgeAt: null,
      bridgeAcceptedAt: null,
      codexPromptSentAt: null,
      lastRunningActivityAt: null,
      terminalErrorCode: null,
    },
    reviewListening: {
      active: false,
      prUrl: null,
      currentHeadSha: null,
      enteredAt: null,
    },
    deadlines: {
      sandboxReconnectGrace: null,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
      spawnTimeout: null,
    },
  };
}
