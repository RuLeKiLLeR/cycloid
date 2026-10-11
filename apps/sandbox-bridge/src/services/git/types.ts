import type { BridgeEvent as SandboxEvent } from "../../../../../shared/events/bridge.js";
import type {
  AgentTimelineEntry,
  AgentTimelineEventType,
  AgentTimelineStatus,
} from "../../../../../shared/types/agent-timeline.js";

export type GitDiffPreparation = {
  hasStagedFiles: boolean;
  stagedFiles: string[];
  publishFiles: string[];
  diffStat?: string;
  diffSummary?: string;
  fullDiff?: string;
  hasChanges: boolean;
};

export type RepoSnapshot = {
  headSha?: string;
  porcelain: string;
};

export type GitOperationsConfig = {
  cwd: string;
  controlPlaneUrl: string;
  getAuthToken: () => string;
  sessionId: string;
  sandboxId: string;
  baseBranch?: string;
  maxFullDiffBytes: number;
  truncatedFullDiffBytes: number;
  getModifiedFiles: () => Iterable<string>;
  /** Pre-sanitized branch slug captured from the initial task text. */
  getBranchNameHint?: () => string | undefined;
  sendEvent: (event: SandboxEvent) => void;
  pushDelay?: (ms: number) => Promise<void>;
  /**
   * Durably record that the branch physically landed on the remote, written
   * immediately after `git push` returns and before `push_complete` is emitted,
   * so a crash in that window is still recoverable. Optional: tests and callers
   * without an outbox omit it.
   */
  recordPushCheckpoint?: (info: { messageId: string; branch: string; commitSha?: string }) => void;
  /**
   * Durably record that a push was attempted before the blocking git push call.
   * Retryable clean-name collision probes are branch-resolved when git rejects
   * them, so crash recovery does not confuse them with the final renamed branch.
   * Optional: tests and callers without an outbox omit it.
   */
  recordPushAttempt?: (info: { messageId: string; branch: string; commitSha?: string }) => void;
  /**
   * Durably mark a recorded push attempt as deliberately concluded without a
   * push outcome event (session_not_active abort), so crash recovery does not
   * synthesize the push_error the live path intentionally suppressed.
   */
  recordPushAttemptResolved?: (info: { messageId: string; branch?: string; reason: string }) => void;
};

export type TimelineRecord = (
  eventType: AgentTimelineEventType,
  status: AgentTimelineStatus,
  summary: string,
  metadata?: Record<string, unknown>,
) => void;

export type TimelineRecorder = {
  entries: AgentTimelineEntry[];
  record: TimelineRecord;
};
