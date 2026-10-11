import type { AgentRuntimeBackend } from "../agent/agent-runtime-backend.js";
import type { PrTemplateFillLlmInput } from "../llm/post-execution.js";
import type { ToolFailureReport } from "../tool-failure.js";
import type { AgentTimelinePayload } from "../types/agent-timeline.js";
import type {
  ErrorCode,
  ErrorDetails,
  ExecutionVerification,
  GateResults,
  ObservabilityReadiness,
  PrReadinessEvidence,
  PublishMode,
  RuntimeReport,
  VerifierTerminalResult,
} from "../types/sandbox.js";
import type { VerificationPhaseArtifactRecord } from "../verification/phase-artifacts.js";

export type DeferredPrTemplateFillPayload = {
  template: {
    source: "repo_local" | "org_default" | "cycloid_config";
    path: string;
    content: string;
  };
  input: PrTemplateFillLlmInput;
  generatedBody?: string;
};

export type SandboxPromptActivityPhase =
  | "agent_runtime_initializing"
  | "session_creating"
  | "event_subscribing"
  | "prompt_preparing"
  | "prompt_dispatching"
  | "waiting_for_agent_event";

export type AgentProgressStep =
  | "starting_agent"
  | "preparing_workspace"
  | "workspace_ready"
  | "workspace_setup_delayed"
  | "workspace_setup_failed"
  | "processing_attachments"
  | "connecting_to_runtime"
  | "preparing_context"
  | "starting_work"
  | "waiting_for_model"
  | "thinking";

export type AgentProgressLabel =
  | "Starting agent"
  | "Preparing workspace"
  | "Workspace ready"
  | "Workspace setup delayed"
  | "Workspace setup failed"
  | "Processing attachments"
  | "Connecting to runtime"
  | "Preparing context"
  | "Starting work"
  | "Waiting for model"
  | "Thinking";

export interface EstimatedInputCompositionComponents {
  systemContext: number;
  historicalSessions: number;
  taskText: number;
  uploads: number;
  measuredTotal: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  unmeasuredTokens: number | null;
}

export interface EstimatedInputCompositionRecord {
  kind: "estimated_input_composition";
  version: 1;
  components: EstimatedInputCompositionComponents;
}

// Legacy bridge event contract used by sandbox-bridge internals and transport
// compatibility payloads. SessionDO persists canonical CycloidEvent envelopes
// and projects them back into SessionEvent shape on read/broadcast. New
// canonical transport fields belong in shared/events/schema.ts.
export type BridgeEvent =
  | { type: "heartbeat"; sandboxId: string; status: string; timestamp: number; echoNonce?: string }
  | { type: "prompt_accepted"; messageId: string; startupAttemptId?: string; sandboxId: string; timestamp: number }
  | {
      type: "prompt_activity";
      promptId: string;
      phase: SandboxPromptActivityPhase;
      startupAttemptId?: string;
      detail?: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "agent_progress";
      promptId: string;
      step: AgentProgressStep;
      label: AgentProgressLabel;
      terminal?: boolean;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "agent_prompt_sent";
      messageId: string;
      startupAttemptId?: string;
      agentSessionId?: string;
      agentRuntimeBackend?: AgentRuntimeBackend;
      sandboxId: string;
      timestamp: number;
    }
  | { type: "token"; content: string; partId?: string; messageId: string; sandboxId: string; timestamp: number }
  | {
      type: "final_answer";
      content: string;
      partId?: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
      ackId?: string;
    }
  | { type: "reasoning"; content: string; partId: string; messageId: string; sandboxId: string; timestamp: number }
  | { type: "patch"; files: string[]; messageId: string; sandboxId: string; timestamp: number; ackId?: string }
  | {
      type: "tool_call";
      tool: string;
      args: Record<string, unknown>;
      callId: string;
      summary?: string;
      status?: string;
      output?: string;
      startedAt?: number;
      inputEstimatedTokens?: number;
      messageId: string;
      sandboxId: string;
      timestamp: number;
      ackId?: string;
    }
  | {
      type: "tool_update";
      callId: string;
      tool: string;
      status: string;
      completedAt?: number;
      durationMs?: number;
      outputEstimatedTokens?: number;
      outputChars?: number;
      failure?: ToolFailureReport;
      messageId: string;
      sandboxId: string;
      timestamp: number;
      ackId?: string;
    }
  | {
      type: "tool_result";
      callId: string;
      tool: string;
      result: string;
      error?: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
      ackId?: string;
    }
  | {
      type: "error";
      error: string;
      code?: ErrorCode;
      errorDetails?: ErrorDetails;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "prompt_telemetry_start";
      promptId: string;
      btSpanId?: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "execution_complete";
      ackId?: string;
      messageId: string;
      success: boolean;
      error?: string;
      errorCode?: ErrorCode;
      errorDetails?: ErrorDetails;
      idleObserved?: boolean;
      sessionEditCount?: number;
      sessionPromptCount?: number;
      connectionGeneration?: number;
      btSpanId?: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      // This remains the single PR-ready event. Push outcome is bundled here
      // so the control plane does not have to correlate with push_complete /
      // push_error: pushed === true means the branch landed on the remote;
      // pushed === false means push did not succeed (see pushError). The
      // control plane fails closed if pushed is missing or not true.
      type: "post_execution";
      ackId?: string;
      messageId: string;
      hasChanges: boolean;
      noChangeReason?: "no_diff" | "no_staged_files" | "prep_failed" | "post_prep_failed" | "verification_phase_skip";
      // ARC-1330 (PR 27): the bridge's `observedPromptProgress` signal — whether this turn made
      // repo progress (edits/commits), i.e. the prompt intended a code change. Serialized verbatim
      // so the control plane can persist it as the FSM `prompt_intends_change` record field at
      // FINALIZING. Projection-only: it colors the `¬hasChanges` ANSWERED_NO_PR split ("Answered"
      // vs "No change produced", SF11) and NEVER gates publish (publish is `hasChanges` alone, D3).
      // Optional for deploy-skew tolerance: an older bridge omits it → control plane reads `false`.
      promptIntendsChange?: boolean;
      branch?: string;
      commitSha?: string;
      pushed?: boolean;
      pushError?: string;
      diffSummary?: string;
      prTitle?: string;
      prBody?: string;
      prTemplateFill?: DeferredPrTemplateFillPayload;
      verification?: ExecutionVerification;
      verifierResult?: VerifierTerminalResult;
      verificationSkipped?: {
        reason: string;
        evidence: string[];
        headSha?: string;
      };
      prReadiness?: PrReadinessEvidence;
      // Server-authoritative publish-decision signal (always set by a current
      // bridge; optional in the type for deploy-skew tolerance — the control
      // plane fails closed to `draft` when absent/invalid). `publishMode` is the
      // sandbox's final decision; `gateResults` are the per-gate inputs the
      // control plane re-folds. The control plane never trusts `publishMode` to
      // be LESS conservative than these inputs justify.
      publishMode?: PublishMode;
      gateResults?: GateResults;
      connectionGeneration?: number;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "runtime_info";
      runtime: RuntimeReport;
      observabilityReadiness?: ObservabilityReadiness;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "verification_phase_artifact";
      runId: string;
      record: VerificationPhaseArtifactRecord;
      intermediate: true;
      verificationPhase: VerificationPhaseArtifactRecord["phase"];
      artifactType: VerificationPhaseArtifactRecord["artifactType"];
      attempt: number;
      validationStatus: "accepted";
      evidenceRefCount: number;
      blockerCount: number;
      computedAgainstHeadSha?: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      // Internal dev signal (onboarding sessions only): a kernel OOM-kill
      // happened during the boot/build, i.e. the customer's repo needs a bigger
      // sandbox spec. The control plane handles this as a side-effect (Slack +
      // Datadog metric) and never projects it into the customer's session
      // timeline. `oomKills` is the count observed since session start.
      type: "sandbox_undersized";
      oomKills: number;
      // The process the kernel OOM-killed, when the victim line was readable
      // from the kernel log (dmesg). Best-effort: absent when dmesg is empty or
      // restricted (no CAP_SYSLOG), in which case the signal is count-only.
      victimComm?: string;
      victimPid?: number;
      victimRssMb?: number;
      sandboxId: string;
      timestamp: number;
    }
  | {
      // Internal outcome signal (every session): a session operation failed with a
      // disk-full (ENOSPC) signature — git commit/push could not write because the
      // sandbox disk is exhausted. The disk equivalent of `sandbox_undersized`
      // (OOM): the control plane emits a Datadog COUNT and never projects it into
      // the customer timeline. `source` names the failing operation (e.g. "push").
      type: "sandbox_enospc";
      source: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      // Internal telemetry (every session): a periodic sandbox resource sample so
      // memory/swap/disk/cpu pressure is visible on Datadog BEFORE a kernel OOM
      // tears the session down (today nothing ingests this — it had to be read
      // live from `e2b sandbox metrics`). The control plane emits these as
      // Datadog gauges as a pure side-effect; it is never broadcast, persisted,
      // or projected into the customer's session timeline. Every metric field is
      // optional: a field is omitted when its source is unreadable in the sandbox
      // (e.g. cgroup memory.max is "max", no swap configured, cgroup v1). See
      // apps/sandbox-bridge/src/services/runtime-resource-snapshot.ts.
      type: "sandbox_resource_sample";
      memoryUsedBytes?: number;
      memoryLimitBytes?: number;
      memoryUsedPercent?: number;
      swapUsedBytes?: number;
      cpuUsedPercent?: number;
      cpuThrottledPeriodsPercent?: number;
      cpuPressureAvg10?: number;
      memoryPressureAvg10?: number;
      memoryHighEventsDelta?: number;
      memoryOomEventsDelta?: number;
      memoryOomKillEventsDelta?: number;
      pidsCurrent?: number;
      pidsLimit?: number;
      pidsUsedPercent?: number;
      pidsMaxEventsDelta?: number;
      disks?: Array<{
        mount: string;
        usedPercent?: number;
        usedBytes?: number;
        totalBytes?: number;
        availBytes?: number;
      }>;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "push_complete";
      ackId?: string;
      messageId: string;
      branchName: string;
      commitSha?: string;
      sandboxId?: string;
      timestamp: number;
    }
  | {
      type: "push_error";
      ackId?: string;
      messageId: string;
      branchName: string;
      error: string;
      sandboxId?: string;
      timestamp: number;
    }
  | {
      type: "question";
      ackId?: string;
      questionId: string;
      question: string;
      options?: Array<string | { label: string; description?: string }>;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      contextTokens: number;
      peakContextTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalCostUsd?: number;
      model?: string;
      contextWindow?: number;
      contextCacheRead?: number;
      contextCacheWrite?: number;
      contextUncachedInput?: number;
      cumulativeCacheRead?: number;
      cumulativeCacheWrite?: number;
      instructionFilesEst?: number;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "estimated_input_composition";
      messageId: string;
      sandboxId: string;
      timestamp: number;
      components: EstimatedInputCompositionComponents;
    }
  | {
      type: "retry_status";
      attempt: number;
      message: string;
      nextRetryAt?: string;
      provider?: string;
      errorCode?: ErrorCode;
      scope?: string;
      maxAttempts?: number;
      reason?: string;
      retryAfterMs?: number;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "tool_truncated";
      callId: string;
      tool: string;
      reason?: "truncation_marker" | "size_threshold";
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | { type: "compaction_start"; contextTokens?: number; messageId: string; sandboxId: string; timestamp: number }
  | {
      type: "compaction_complete";
      contextTokensBefore?: number;
      contextTokensAfter?: number;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "context_fill_warning";
      fillPercent: number;
      contextTokens: number;
      contextWindow: number;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | { type: "prompt_result"; messageId: string; sandboxId: string; timestamp: number }
  | {
      type: "session_idle";
      messageId: string;
      sandboxId: string;
      timestamp: number;
      connectionGeneration?: number;
      sessionEditCount?: number;
      sessionPromptCount?: number;
    }
  | {
      type: "agent_session_created";
      agentSessionId: string;
      agentRuntimeBackend?: AgentRuntimeBackend;
      agent: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | ({
      type: "agent_timeline";
      messageId?: string;
      promptId?: string;
      sandboxId: string;
      timestamp: number;
    } & AgentTimelinePayload)
  | {
      type: "raw_agent_runtime";
      agentRuntimeBackend?: AgentRuntimeBackend;
      runtimeEventType?: string;
      partType?: string;
      eventType?: string;
      id?: string;
      messageId: string;
      sandboxId: string;
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      type: "todo_update";
      todos: Array<{ id: string; content: string; status: string }>;
      messageId: string;
      sandboxId: string;
      timestamp: number;
    }
  | {
      type: "memory_usage";
      messageId: string;
      sandboxId: string;
      timestamp: number;
      activeMemoryIds: string[];
      activeMemories?: MemoryRef[];
      usageSource?: "prompt_start" | "company_bootstrap";
      repoOwner?: string;
      repoName?: string;
    }
  | {
      type: "memory_recall_usage";
      messageId: string;
      sandboxId: string;
      timestamp: number;
      eventName: string;
      requestedMemoryIds: string[];
      returnedMemoryIds?: string[];
      requestedMemories?: MemoryRef[];
      returnedMemories?: MemoryRef[];
      usageSource?: "recall" | "company_recall";
      intent?: string;
      files?: string[];
      symbols?: string[];
      tool?: string;
      repoOwner?: string;
      repoName?: string;
      codexRequestId?: string;
      codexThreadId?: string;
      codexTurnId?: string;
      codexItemId?: string;
      codexNamespace?: string;
      codexTool?: string;
      retrievalTrace?: Record<string, unknown>;
      decisionTrace?: Record<string, unknown>;
    };

export type MemoryRef = {
  id: string;
  path?: string;
  title?: string;
  selectionRank?: number;
  selectionScore?: number;
  reason?: string;
  expectedEffect?: string;
  observedEffect?: string;
};
