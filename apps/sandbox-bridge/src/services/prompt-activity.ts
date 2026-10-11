import type {
  AgentProgressLabel,
  AgentProgressStep,
  BridgeEvent as SandboxEvent,
  SandboxPromptActivityPhase,
} from "../../../../shared/events/bridge.js";
import { PROMPT_ACTIVITY_PULSE_INTERVAL_MS } from "../constants/bridge.js";
import type { BridgeLogger } from "../logger.js";
import type { PromptLatencyTags } from "../types.js";
import type { DispatchLatencyTracker } from "./dispatch-latency-tracker.js";

/**
 * First-message latency is measured from the prompt-activity tracker creation
 * until the first of these event types is actually delivered to the control
 * plane. Keep in sync with the event types that represent visible agent work.
 */
const FIRST_PROMPT_ACTIVITY_EVENT_TYPES = new Set<SandboxEvent["type"]>([
  "token",
  "reasoning",
  "tool_call",
  "question",
  "error",
  "todo_update",
  "retry_status",
  "context_fill_warning",
  "compaction_start",
  "execution_complete",
]);

// Events that prove the agent produced new work. This is intentionally broader
// than the first-visible set: terminal tool updates and patches are useful
// progress even though they are not eligible to become the UI's first message.
const USEFUL_PROMPT_ACTIVITY_EVENT_TYPES = new Set<SandboxEvent["type"]>([
  "token",
  "reasoning",
  "final_answer",
  "patch",
  "tool_call",
  "tool_update",
  "tool_result",
  "question",
  "error",
  "todo_update",
  "retry_status",
  "context_fill_warning",
  "compaction_start",
  "compaction_complete",
  "execution_complete",
  "post_execution",
]);

/** Whether a delivered bridge event counts as the first visible agent-work signal. */
export function isVisiblePromptActivityEvent(type: SandboxEvent["type"]): boolean {
  return FIRST_PROMPT_ACTIVITY_EVENT_TYPES.has(type);
}

const COMPLETED_AGENT_PROGRESS_PROMPT_ID_LIMIT = 2048;

function normalizeCompletedAgentProgressPromptIdLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return COMPLETED_AGENT_PROGRESS_PROMPT_ID_LIMIT;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return COMPLETED_AGENT_PROGRESS_PROMPT_ID_LIMIT;
  }
  return Math.max(1, Math.floor(limit));
}

interface FirstPromptActivityTracker {
  startedAt: number;
  sessionId?: string;
  sandboxId?: string;
  startupAttemptId?: string;
  agent: string;
  model: string;
  // Set when the prompt reaches the dispatch boundary, so the first
  // visible-event handler can also report bucket B (dispatch -> first visible
  // event) alongside prompt.first_message.
  dispatchStartedAt?: number;
  latencyTags?: PromptLatencyTags;
}

interface WaitingPulseState {
  startedAt: number;
  pulseCount: number;
  lastAccountedAt: number;
  lastUsefulAt: number | null;
  lastUsefulEventType: SandboxEvent["type"] | null;
  usefulEventCount: number;
  firstUsefulEventMs: number | null;
  activeToolCallIds: Set<string>;
  toolActiveMs: number;
  noToolNoOutputMs: number;
  currentNoToolNoOutputGapStartedAt: number | null;
  maxNoToolNoOutputGapMs: number;
}

export interface PromptActivityReporterDeps {
  sendEvent: (event: SandboxEvent) => void;
  sandboxId: string;
  /** Bridge-owned; attached to prompt_activity so the DO can suppress stale activity. */
  getCurrentPromptStartupAttemptId: () => string | null;
  getRepoSlug: () => string | undefined;
  /** Read access to the in-flight / buffered event accounting on ControlPlaneSession. */
  getPendingAckEvents: () => Map<string, SandboxEvent>;
  getEventBuffer: () => SandboxEvent[];
  log: BridgeLogger;
  now?: () => number;
  completedAgentProgressPromptIdLimit?: number;
}

/**
 * Owns prompt_activity / agent_progress emission, the per-prompt agent-progress
 * dedup state, the prompt-activity pulse helpers, and the first-message latency
 * tracker. The startup-attempt id and the pending-ack/buffer accounting stay on
 * the bridge / ControlPlaneSession and are injected as readers.
 */
export class PromptActivityReporter {
  private readonly agentProgressSentByPromptId = new Map<string, Set<AgentProgressStep>>();
  private readonly completedAgentProgressPromptIds = new Set<string>();
  private readonly firstPromptActivityTrackers = new Map<string, FirstPromptActivityTracker>();
  private readonly dispatchLatencyTrackers = new Map<string, DispatchLatencyTracker>();
  private readonly waitingPulseStateByPromptId = new Map<string, WaitingPulseState>();
  private readonly deps: PromptActivityReporterDeps;
  private readonly now: () => number;
  private readonly completedAgentProgressPromptIdLimit: number;

  constructor(deps: PromptActivityReporterDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.completedAgentProgressPromptIdLimit = normalizeCompletedAgentProgressPromptIdLimit(
      deps.completedAgentProgressPromptIdLimit,
    );
  }

  sendPromptActivity(promptId: string, phase: SandboxPromptActivityPhase, detail?: string): void {
    if (phase === "waiting_for_agent_event") {
      this.logWaitingPulse(promptId);
    }
    const startupAttemptId = this.deps.getCurrentPromptStartupAttemptId();
    this.deps.sendEvent({
      type: "prompt_activity",
      promptId,
      phase,
      ...(startupAttemptId ? { startupAttemptId } : {}),
      ...(detail ? { detail } : {}),
      sandboxId: this.deps.sandboxId,
      timestamp: this.now(),
    });
  }

  sendAgentProgress(
    promptId: string,
    step: AgentProgressStep,
    label: AgentProgressLabel,
    opts: { terminal?: boolean; repeat?: boolean } = {},
  ): boolean {
    if (this.completedAgentProgressPromptIds.has(promptId)) return false;
    let sentSteps = this.agentProgressSentByPromptId.get(promptId);
    if (!sentSteps) {
      sentSteps = new Set<AgentProgressStep>();
      this.agentProgressSentByPromptId.set(promptId, sentSteps);
    }
    if (!opts.repeat && sentSteps.has(step)) return false;
    sentSteps.add(step);
    this.deps.sendEvent({
      type: "agent_progress",
      promptId,
      step,
      label,
      ...(opts.terminal ? { terminal: true } : {}),
      sandboxId: this.deps.sandboxId,
      timestamp: this.now(),
    });
    return true;
  }

  sendThinkingProgress(promptId: string, signal: string): void {
    const sent = this.sendAgentProgress(promptId, "thinking", "Thinking");
    if (!sent) return;

    const tracker = this.firstPromptActivityTrackers.get(promptId);
    if (!tracker) {
      this.deps.log.debug(
        { event: "prompt.received_to_thinking_tracker_missing", prompt_id: promptId, signal },
        "Prompt thinking progress timing tracker missing",
      );
      return;
    }

    const repo = this.deps.getRepoSlug();
    this.deps.log.info(
      {
        event: "prompt.received_to_thinking",
        ...(tracker.sessionId ? { session_id: tracker.sessionId } : {}),
        prompt_id: promptId,
        sandbox_id: tracker.sandboxId ?? this.deps.sandboxId,
        ...(tracker.startupAttemptId ? { startup_attempt_id: tracker.startupAttemptId } : {}),
        received_to_thinking_ms: Math.max(0, this.now() - tracker.startedAt),
        signal,
        ...(tracker.latencyTags ?? {}),
        agent: tracker.agent,
        model: tracker.model,
        ...(repo ? { repo } : {}),
      },
      "Prompt thinking progress observed",
    );
  }

  startPromptActivityPulse(promptId: string, phase: SandboxPromptActivityPhase, detail?: string): () => void {
    if (phase === "waiting_for_agent_event") {
      const now = this.now();
      const existing = this.waitingPulseStateByPromptId.get(promptId);
      this.waitingPulseStateByPromptId.set(
        promptId,
        existing ?? {
          startedAt: now,
          pulseCount: 0,
          lastAccountedAt: now,
          lastUsefulAt: null,
          lastUsefulEventType: null,
          usefulEventCount: 0,
          firstUsefulEventMs: null,
          activeToolCallIds: new Set<string>(),
          toolActiveMs: 0,
          noToolNoOutputMs: 0,
          currentNoToolNoOutputGapStartedAt: now,
          maxNoToolNoOutputGapMs: 0,
        },
      );
    }
    this.sendPromptActivity(promptId, phase, detail);
    const intervalId = setInterval(
      () => this.sendPromptActivity(promptId, phase, detail),
      PROMPT_ACTIVITY_PULSE_INTERVAL_MS,
    );
    return () => {
      clearInterval(intervalId);
    };
  }

  private accountWaitingInterval(wait: WaitingPulseState, now: number): void {
    const elapsed = Math.max(0, now - wait.lastAccountedAt);
    if (wait.activeToolCallIds.size > 0) {
      wait.toolActiveMs += elapsed;
      if (wait.currentNoToolNoOutputGapStartedAt !== null) {
        wait.maxNoToolNoOutputGapMs = Math.max(
          wait.maxNoToolNoOutputGapMs,
          Math.max(0, wait.lastAccountedAt - wait.currentNoToolNoOutputGapStartedAt),
        );
        wait.currentNoToolNoOutputGapStartedAt = null;
      }
    } else {
      wait.noToolNoOutputMs += elapsed;
      wait.currentNoToolNoOutputGapStartedAt ??= wait.lastAccountedAt;
    }
    wait.lastAccountedAt = now;
  }

  private logWaitingPulse(promptId: string): void {
    const now = this.now();
    const wait = this.waitingPulseStateByPromptId.get(promptId);
    if (!wait) return;
    this.accountWaitingInterval(wait, now);
    wait.pulseCount += 1;
    const activeToolCount = wait.activeToolCallIds.size;
    this.deps.log.info(
      {
        event: "prompt.wait_pulse",
        prompt_id: promptId,
        waiting_pulse_count: wait.pulseCount,
        waiting_elapsed_ms: Math.max(0, now - wait.startedAt),
        useful_activity_observed: wait.lastUsefulAt !== null,
        useful_activity_age_ms: Math.max(0, now - (wait.lastUsefulAt ?? wait.startedAt)),
        last_useful_event_type: wait.lastUsefulEventType ?? "none",
        active_tool_call: activeToolCount > 0,
        active_tool_count: activeToolCount,
        tool_active_ms: wait.toolActiveMs,
        no_tool_no_output_ms: wait.noToolNoOutputMs,
      },
      "Prompt waiting for agent event",
    );
  }

  withPromptActivityPulse<T>(
    promptId: string,
    phase: SandboxPromptActivityPhase,
    work: () => Promise<T>,
    detail?: string,
    latencyTags?: PromptLatencyTags,
  ): Promise<T> {
    const startedAt = this.now();
    const stopPulse = this.startPromptActivityPulse(promptId, phase, detail);
    const finish = (outcome: "completed" | "failed") => {
      stopPulse();
      this.logActivityPhaseDuration(promptId, phase, this.now() - startedAt, outcome, detail, latencyTags);
    };
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (err) {
      finish("failed");
      throw err;
    }
    void promise.then(
      () => finish("completed"),
      () => finish("failed"),
    );
    return promise;
  }

  private logActivityPhaseDuration(
    promptId: string,
    phase: SandboxPromptActivityPhase,
    durationMs: number,
    outcome: "completed" | "failed",
    detail?: string,
    latencyTags?: PromptLatencyTags,
  ): void {
    const repo = this.deps.getRepoSlug();
    this.deps.log.info(
      {
        event: "prompt.activity_phase",
        prompt_id: promptId,
        phase,
        outcome,
        duration_ms: Math.max(0, durationMs),
        ...(detail ? { detail } : {}),
        ...(latencyTags ?? {}),
        ...(repo ? { repo } : {}),
      },
      "Prompt activity phase complete",
    );
  }

  /** Seed the first-message tracker for a prompt at dispatch time. */
  recordFirstPromptActivityTracker(messageId: string, tracker: FirstPromptActivityTracker): void {
    this.firstPromptActivityTrackers.set(messageId, tracker);
  }

  /** Seed the dispatch subspan tracker for a prompt at handlePrompt entry. */
  recordDispatchLatencyTracker(messageId: string, tracker: DispatchLatencyTracker): void {
    this.dispatchLatencyTrackers.set(messageId, tracker);
  }

  /**
   * Stash the dispatch-boundary timestamp + latency tags on the tracker so the
   * first visible-event handler can report bucket B (dispatch -> first visible
   * event) at the same anchor as `prompt.first_message`.
   */
  recordPromptDispatched(messageId: string, dispatchStartedAt: number, latencyTags: PromptLatencyTags): void {
    const tracker = this.firstPromptActivityTrackers.get(messageId);
    if (!tracker) {
      return;
    }
    tracker.dispatchStartedAt = dispatchStartedAt;
    tracker.latencyTags = latencyTags;
  }

  /** Clear per-prompt agent-progress dedup state once a prompt is terminal. */
  markPromptComplete(messageId: string): void {
    this.agentProgressSentByPromptId.delete(messageId);
    this.logWaitingSummary(messageId);
    this.waitingPulseStateByPromptId.delete(messageId);
    this.rememberCompletedAgentProgressPromptId(messageId);
  }

  private logWaitingSummary(promptId: string): void {
    const wait = this.waitingPulseStateByPromptId.get(promptId);
    if (!wait) return;
    const now = this.now();
    this.accountWaitingInterval(wait, now);
    const finalGapMs =
      wait.currentNoToolNoOutputGapStartedAt === null ? 0 : Math.max(0, now - wait.currentNoToolNoOutputGapStartedAt);
    wait.maxNoToolNoOutputGapMs = Math.max(wait.maxNoToolNoOutputGapMs, finalGapMs);
    this.deps.log.info(
      {
        event: "prompt.wait_summary",
        prompt_id: promptId,
        waiting_elapsed_ms: Math.max(0, now - wait.startedAt),
        tool_active_ms: wait.toolActiveMs,
        no_tool_no_output_ms: wait.noToolNoOutputMs,
        max_no_tool_no_output_gap_ms: wait.maxNoToolNoOutputGapMs,
        final_no_output_gap_ms: finalGapMs,
        useful_event_count: wait.usefulEventCount,
        first_useful_event_ms: wait.firstUsefulEventMs ?? -1,
        last_useful_event_type: wait.lastUsefulEventType ?? "none",
        active_tool_count_at_completion: wait.activeToolCallIds.size,
        ...(this.deps.getRepoSlug() ? { repo: this.deps.getRepoSlug() } : {}),
      },
      "Prompt wait composition complete",
    );
  }

  private rememberCompletedAgentProgressPromptId(messageId: string): void {
    this.completedAgentProgressPromptIds.delete(messageId);
    this.completedAgentProgressPromptIds.add(messageId);

    while (this.completedAgentProgressPromptIds.size > this.completedAgentProgressPromptIdLimit) {
      const oldestPromptId = this.completedAgentProgressPromptIds.values().next().value;
      if (oldestPromptId === undefined) {
        return;
      }
      this.completedAgentProgressPromptIds.delete(oldestPromptId);
    }
  }

  /**
   * Runs via ControlPlaneSession.onEventSent. Logs `prompt.first_message` the
   * first time a visible-work event for a tracked prompt is actually delivered.
   */
  recordFirstPromptActivitySent(event: SandboxEvent): void {
    this.recordUsefulPromptActivitySent(event);
    if (!isVisiblePromptActivityEvent(event.type)) {
      return;
    }
    if (!("messageId" in event) || typeof event.messageId !== "string") {
      return;
    }

    const tracker = this.firstPromptActivityTrackers.get(event.messageId);
    if (!tracker) {
      return;
    }
    this.firstPromptActivityTrackers.delete(event.messageId);

    const now = this.now();
    const durationMs = Math.max(0, now - tracker.startedAt);
    const repo = this.deps.getRepoSlug();
    this.deps.log.info(
      {
        event: "prompt.first_visible_event",
        ...(tracker.sessionId ? { session_id: tracker.sessionId } : {}),
        prompt_id: event.messageId,
        sandbox_id: tracker.sandboxId ?? this.deps.sandboxId,
        ...(tracker.startupAttemptId ? { startup_attempt_id: tracker.startupAttemptId } : {}),
        first_event_type: event.type,
        prompt_received_to_first_visible_event_ms: durationMs,
        ...(tracker.latencyTags ?? {}),
        agent: tracker.agent,
        model: tracker.model,
        ...(repo ? { repo } : {}),
      },
      "Prompt first visible event observed",
    );
    this.deps.log.info(
      {
        event: "prompt.first_message",
        prompt_id: event.messageId,
        first_event_type: event.type,
        time_to_first_message_ms: durationMs,
        ...(tracker.latencyTags ?? {}),
        agent: tracker.agent,
        model: tracker.model,
        ...(repo ? { repo } : {}),
      },
      "Prompt first message emitted",
    );

    // Bucket B of the per-turn latency split: dispatch boundary -> first
    // visible event (token/reasoning/tool_call), i.e. model time-to-first-event.
    // Anchored on the same first-visible-event signal as prompt.first_message
    // (not the near-instant session.status ack) so it reflects model latency.
    if (tracker.dispatchStartedAt != null && tracker.latencyTags) {
      this.deps.log.info(
        {
          event: "prompt.dispatch_to_first_event",
          prompt_id: event.messageId,
          dispatch_to_first_event_ms: Math.max(0, now - tracker.dispatchStartedAt),
          first_event_type: event.type,
          ...tracker.latencyTags,
          // Override agent/model from the tracker so both sibling metrics
          // (prompt.first_message above) share one tag source and cannot
          // drift apart if buildPromptLatencyTags ever changes.
          agent: tracker.agent,
          model: tracker.model,
        },
        "First visible event observed after dispatch",
      );
    }
  }

  private recordUsefulPromptActivitySent(event: SandboxEvent): void {
    if (!USEFUL_PROMPT_ACTIVITY_EVENT_TYPES.has(event.type)) return;
    if (!("messageId" in event) || typeof event.messageId !== "string") return;
    const wait = this.waitingPulseStateByPromptId.get(event.messageId);
    if (!wait) return;
    const now = this.now();
    this.accountWaitingInterval(wait, now);
    wait.lastUsefulAt = now;
    wait.lastUsefulEventType = event.type;
    wait.usefulEventCount += 1;
    wait.firstUsefulEventMs ??= Math.max(0, now - wait.startedAt);
    if (!("callId" in event) || typeof event.callId !== "string" || event.callId.length === 0) return;

    const active = wait.activeToolCallIds;
    if (event.type === "tool_call") {
      active.add(event.callId);
    } else if (
      event.type === "tool_result" ||
      (event.type === "tool_update" && (event.status === "completed" || event.status === "error"))
    ) {
      active.delete(event.callId);
    } else if (event.type === "tool_update") {
      active.add(event.callId);
    }
    if (active.size === 0) {
      wait.currentNoToolNoOutputGapStartedAt = now;
    } else {
      if (wait.currentNoToolNoOutputGapStartedAt !== null) {
        wait.maxNoToolNoOutputGapMs = Math.max(
          wait.maxNoToolNoOutputGapMs,
          Math.max(0, now - wait.currentNoToolNoOutputGapStartedAt),
        );
      }
      wait.currentNoToolNoOutputGapStartedAt = null;
    }
  }

  /**
   * Runs just before ControlPlaneSession.sendEvent. Records the first point where
   * a visible-work event has been translated into a bridge event and handed to the
   * delivery layer.
   */
  recordDispatchLatencyVisibleEventQueued(event: SandboxEvent): void {
    if (!isVisiblePromptActivityEvent(event.type)) {
      return;
    }
    if (!("messageId" in event) || typeof event.messageId !== "string") {
      return;
    }

    const tracker = this.dispatchLatencyTrackers.get(event.messageId);
    if (!tracker) {
      return;
    }
    tracker.recordBridgeFirstVisibleEventQueued(event.type);
  }

  /**
   * Runs when a visible-work event is buffered instead of written to the live WS.
   */
  recordDispatchLatencyVisibleEventBuffered(event: SandboxEvent): void {
    if (!isVisiblePromptActivityEvent(event.type)) {
      return;
    }
    if (!("messageId" in event) || typeof event.messageId !== "string") {
      return;
    }

    const tracker = this.dispatchLatencyTrackers.get(event.messageId);
    if (!tracker) {
      return;
    }
    tracker.recordBridgeFirstVisibleEventBuffered(event.type);
  }

  /**
   * Runs via ControlPlaneSession.onEventSent. Records the bridge_first_visible_event
   * subspan when a visible-work event is actually delivered (including after a
   * buffered flush once handlePrompt has finished).
   */
  recordDispatchLatencyVisibleEvent(event: SandboxEvent): void {
    if (!isVisiblePromptActivityEvent(event.type)) {
      return;
    }
    if (!("messageId" in event) || typeof event.messageId !== "string") {
      return;
    }

    const tracker = this.dispatchLatencyTrackers.get(event.messageId);
    if (!tracker) {
      return;
    }
    this.dispatchLatencyTrackers.delete(event.messageId);
    tracker.recordBridgeFirstVisibleEvent(event.type);
  }

  private hasPendingVisibleDelivery(messageId: string): boolean {
    const isPending = (event: SandboxEvent) =>
      isVisiblePromptActivityEvent(event.type) && "messageId" in event && event.messageId === messageId;

    return [...this.deps.getPendingAckEvents().values()].some(isPending) || this.deps.getEventBuffer().some(isPending);
  }

  /**
   * Drop the first-message tracker only when no visible-work event for the
   * prompt is still in-flight (pending ack) or buffered, so a delivered first
   * event still logs `prompt.first_message`.
   */
  deleteFirstPromptActivityTrackerIfNoPendingDelivery(messageId: string): void {
    if (this.hasPendingVisibleDelivery(messageId)) {
      return;
    }

    this.firstPromptActivityTrackers.delete(messageId);
  }

  /**
   * Drop the dispatch subspan tracker only when no visible-work event for the
   * prompt is still pending or buffered, mirroring deleteFirstPromptActivityTrackerIfNoPendingDelivery.
   */
  deleteDispatchLatencyTrackerIfNoPendingDelivery(messageId: string): void {
    if (this.hasPendingVisibleDelivery(messageId)) {
      return;
    }

    this.dispatchLatencyTrackers.delete(messageId);
  }
}
