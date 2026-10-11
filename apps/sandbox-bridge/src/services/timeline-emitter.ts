import type { BridgeEvent as SandboxEvent } from "../../../../shared/events/bridge.js";
import { redact, redactObject, truncate } from "../../../../shared/observability/redact.js";
import type {
  AgentTimelineEntry,
  AgentTimelinePayload,
  AgentTimelineStatus,
} from "../../../../shared/types/agent-timeline.js";
import type { ExecutionVerification, PrReadinessCommand } from "../../../../shared/types/sandbox.js";
import type { PromptLoopState } from "../prompt-loop-state.js";

const TIMELINE_COMPLETED = "completed" satisfies AgentTimelineStatus;
const TIMELINE_FAILED = "failed" satisfies AgentTimelineStatus;

export interface TimelineEmitterDeps {
  sendEvent: (event: SandboxEvent) => void;
  sandboxId: string;
  now?: () => number;
}

/**
 * Owns agent-timeline emission. `sendAgentTimelineEvent` is the single
 * redact/truncate chokepoint for observed timeline entries; the typed `emit*`
 * helpers derive their summaries and route through it.
 */
export class TimelineEmitter {
  private readonly deps: TimelineEmitterDeps;
  private readonly now: () => number;

  constructor(deps: TimelineEmitterDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  sendAgentTimelineEvent(
    input: Omit<AgentTimelinePayload, "source" | "observer"> & {
      promptId?: string;
      timestampMs?: number;
    },
  ): AgentTimelineEntry {
    const timestamp = input.timestampMs ?? this.now();
    const metadata = input.metadata ? redactObject(input.metadata) : undefined;
    const entry: AgentTimelineEntry = {
      eventType: input.eventType,
      source: "observed",
      observer: "sandbox_bridge",
      summary: truncate(redact(input.summary.trim()), 240),
      ...(input.status ? { status: input.status } : {}),
      ...(input.promptId ? { promptId: input.promptId } : {}),
      ...(metadata ? { metadata } : {}),
      timestampMs: timestamp,
    };

    this.deps.sendEvent({
      type: "agent_timeline",
      ...entry,
      ...(input.promptId ? { messageId: input.promptId } : {}),
      sandboxId: this.deps.sandboxId,
      timestamp,
    });
    return entry;
  }

  emitPromptObservationTimeline(messageId: string, loopState: PromptLoopState): AgentTimelineEntry[] {
    const entries: AgentTimelineEntry[] = [];
    if (loopState.toolCallCount > 0) {
      const toolTypeCount = loopState.toolCounts.size;
      entries.push(
        this.sendAgentTimelineEvent({
          eventType: "tools.run",
          promptId: messageId,
          status: TIMELINE_COMPLETED,
          summary:
            toolTypeCount > 0
              ? `Observed ${loopState.toolCallCount} tool call(s) across ${toolTypeCount} tool type(s).`
              : `Observed ${loopState.toolCallCount} tool call(s); tool type attribution was unavailable.`,
          metadata: {
            tool_call_count: loopState.toolCallCount,
            tool_type_count: toolTypeCount,
            tool_type_attribution_complete: toolTypeCount > 0,
          },
        }),
      );
    }

    if (loopState.modifiedFiles.size > 0) {
      entries.push(
        this.sendAgentTimelineEvent({
          eventType: "files.edited",
          promptId: messageId,
          status: TIMELINE_COMPLETED,
          summary: `Edited ${loopState.modifiedFiles.size} file(s).`,
        }),
      );
    }

    return entries;
  }

  emitCommandTimeline(messageId: string, commands: PrReadinessCommand[]): AgentTimelineEntry | undefined {
    if (commands.length === 0) return undefined;
    const checkCounts: Record<string, Record<string, number>> = {};
    for (const command of commands) {
      const check = command.check ?? "other";
      checkCounts[check] = checkCounts[check] ?? {};
      checkCounts[check][command.status] = (checkCounts[check][command.status] ?? 0) + 1;
    }
    const completedChecks = Object.entries(checkCounts)
      .filter(([check, counts]) => check !== "other" && (counts.completed ?? 0) > 0)
      .map(([check]) => check)
      .sort();
    const summary =
      completedChecks.length > 0
        ? `Observed ${commands.length} command(s), including completed ${completedChecks.join(", ")} checks.`
        : `Observed ${commands.length} command(s).`;

    return this.sendAgentTimelineEvent({
      eventType: "commands.run",
      promptId: messageId,
      status: TIMELINE_COMPLETED,
      summary,
    });
  }

  emitVerificationTimeline(
    messageId: string,
    verification: ExecutionVerification | undefined,
    postExecutionOutcome: "success" | "error" = "success",
  ): AgentTimelineEntry {
    const failed =
      postExecutionOutcome === "error" ||
      verification?.status === "failed" ||
      verification?.verdict === "REFUTED" ||
      verification?.verdict === "INCONCLUSIVE";
    const inconclusive = verification?.verdict === "INCONCLUSIVE";
    const status: AgentTimelineStatus = failed ? TIMELINE_FAILED : TIMELINE_COMPLETED;
    return this.sendAgentTimelineEvent({
      // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
      eventType: "verification.result",
      promptId: messageId,
      status,
      ...(verification?.evidence?.length ? { metadata: { evidence: verification.evidence } } : {}),
      summary: inconclusive
        ? "QA verification result was inconclusive."
        : status === TIMELINE_FAILED
          ? "QA verification result failed."
          : "QA verification result recorded.",
    });
  }

  emitPublishGateTimeline(
    messageId: string,
    status: AgentTimelineStatus,
    summary: string,
    metadata?: Record<string, unknown>,
  ): AgentTimelineEntry {
    return this.sendAgentTimelineEvent({
      eventType: "publish_gate.result",
      promptId: messageId,
      status,
      summary,
      ...(metadata ? { metadata } : {}),
    });
  }
}
