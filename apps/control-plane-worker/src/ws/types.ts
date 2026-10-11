// WebSocket protocol types for sandbox bridge, client, and server communication.

// Re-export shared protocol types from shared/events/bridge.ts and shared/types/sandbox.ts.
export type { BridgeEvent as SandboxEvent, SandboxPromptActivityPhase } from "../../../../shared/events/bridge.js";
export type {
  DiagnosticEntry,
  ErrorCode,
  ErrorDetails,
  HandlePromptOptions,
  SandboxAckMessage,
  SandboxCommand,
  SandboxSocketMessage,
  UploadedFile,
  UploadedImage,
} from "../../../../shared/types/sandbox.js";
import type { BridgeEvent as SandboxEvent } from "../../../../shared/events/bridge.js";
import type { DesktopActionPathRow } from "../../../../shared/types/desktop-action-path.js";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay.js";
import type {
  ClientPrompt,
  ClientQueueState,
  ClientReplayPage,
  ClientSandboxState,
  ClientSessionSnapshot,
  ReplayError,
} from "../../../../shared/types/session-websocket.js";

// Messages from server to client (DO -> browser/SSE).
// Prompt lifecycle and user-visible failures are modeled through durable
// session events (`prompt_enqueued`, `prompt_processing`, `prompt_completed`,
// `prompt_failed`, `session_error`) plus `sandbox_error`, not separate
// top-level queue, processing, or protocol-error frames.
export type ServerMessage =
  // Raw sandbox_event frames are reserved for heartbeat/debug-style signals.
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "sandbox_ready"; sandboxId: string; spawnDurationMs?: number | null }
  | { type: "sandbox_error"; error: string }
  | {
      type: "subscribed";
      version: 2;
      session: ClientSessionSnapshot;
      sandbox: ClientSandboxState;
      queue: ClientQueueState;
      prompts: ClientPrompt[];
      lastDurableSequence: number;
      replay: ClientReplayPage;
    }
  | { type: "prompt_updated"; prompt: ClientPrompt }
  | { type: "desktop_action_path_row"; row: DesktopActionPathRow }
  | { type: "session_event"; event: SessionReplayEvent }
  | { type: "replay_event"; event: SessionReplayEvent }
  | ({ type: "replay_page" } & ClientReplayPage)
  | ReplayError
  | {
      type: "replay_truncated";
      requestedAfterSequence: number;
      firstReturnedSequence: number;
      lastReturnedSequence: number;
      droppedCount: number;
    }
  | {
      type: "session_status";
      // Canonical phase contract (`shared/session/phase.ts`). Emitted for every
      // session kind after PR D.
      phase: import("../../../../shared/session/phase.js").Phase;
      displayStatus: import("../../../../shared/session/display-status.js").DisplayStatus;
      uiLifecycleStage?: import("../../../../shared/session/lifecycle-stage.js").UiLifecycleStage;
      sandboxSubstate?: import("../../../../shared/session/phase.js").SandboxSubstate;
      stopMode?: import("../../../../shared/session/phase.js").StopMode;
      // Live-idle "kept alive after a user stop" flag; see
      // shared/types/session-websocket.ts. PR-2's broadcast sets it.
      userStopped?: boolean;
      planApprovalPending: boolean;
      planRevision: number;
      planStatus: import("../../../../shared/types/session-plan.js").SessionPlanStatus;
      finalizingStep?: import("../../../../shared/session/phase.js").FinalizingStep;
      title?: string;
      // Carried so a push re-entering a non-terminal phase updates the open
      // detail's branch (and the Create-PR CTA) without waiting for the poll.
      lastBranch?: string | null;
    }
  | {
      type: "pr_created";
      prUrl: string;
      prNumber: number;
      branchName: string;
      draft?: boolean;
      manualReviewReason?: string;
    }
  | {
      type: "pr_updated";
      prUrl: string;
      prNumber: number;
      branchName: string;
      draft?: boolean;
      manualReviewReason?: string;
    }
  | {
      type: "verification_updated";
      verification: import("../../../../shared/types/sandbox.js").ExecutionVerification | null;
      verificationSummary: import("../../../../shared/verification-summary.js").VerificationSummary | null;
    }
  | {
      type: "runtime_provenance_updated";
      runtimeProvenance: import("../../../../shared/types/sandbox.js").RuntimeProvenance | null;
    }
  | {
      type: "observability_readiness_updated";
      observabilityReadiness: import("../../../../shared/types/sandbox.js").ObservabilityReadiness | null;
    }
  | { type: "pr_failed"; error: string };
