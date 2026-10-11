/**
 * Shared types for the agent-trace export. The export reads a harness session
 * transcript (Codex rollout JSONL or Claude Code project JSONL) and emits the
 * agent-trace JSONL shape consumed downstream (Braintrust ingestion). Unlike the
 * Braintrust span source, this carries the REAL tool output text, not the tool
 * status string.
 */

/** A single tool call with its real output. */
export interface TraceTool {
  /** Display name, e.g. `tool:bash`. */
  name: string;
  /** Tool arguments (for bash: `{ command }`). */
  input: Record<string, unknown>;
  /** Real command output (stdout/stderr), truncated + redacted. */
  output: string;
  /** Wall-clock duration when derivable from the transcript timestamps. */
  durationMs?: number;
  /** Token estimate of the (untruncated) output, matching the bridge heuristic. */
  outputEstimatedTokens?: number;
}

/** One model turn: the system + user input that opened it. */
export interface TraceTurn {
  promptId: string;
  input: { system: string; user: string };
}

export interface TraceTokenBreakdown {
  actualInputTokens: number;
  actualOutputTokens: number;
  historicalSessions: number;
  measuredTotal: number;
  systemContext: number;
  taskText: number;
  unmeasuredTokens: number;
  uploads: number;
}

/** The full agent-trace record (the JSONL line shape James ingests). */
export interface AgentTrace {
  sessionId: string;
  repo: string;
  env: string;
  model: string;
  provider: string;
  agent: string;
  agentRole: string;
  harnessKind: string;
  branch: string;
  complete: boolean;
  outcome: string;
  success: boolean;
  editCount: number;
  toolCallCount: number;
  questionCount: number;
  grepSearchCommandCount: number;
  ripgrepSearchCommandCount: number;
  contextFillPercent: number;
  tokenBreakdown: TraceTokenBreakdown;
  durationMs: number;
  turns: TraceTurn[];
  tools: TraceTool[];
}

/**
 * Everything a parser can recover from a transcript alone. Session-identity
 * fields that live only in Cycloid control-plane metadata (repo, env, agent,
 * branch, ...) are supplied separately as overrides.
 */
export interface ParsedTranscript {
  harnessKind: string;
  provider?: string;
  model?: string;
  turns: TraceTurn[];
  tools: TraceTool[];
  toolCallCount: number;
  editCount: number;
  questionCount: number;
  grepSearchCommandCount: number;
  ripgrepSearchCommandCount: number;
  /** Total measured input tokens (last cumulative usage report). */
  actualInputTokens: number;
  actualOutputTokens: number;
  /** Context-window size, for contextFillPercent. */
  contextWindow?: number;
  /** Peak total tokens observed, for contextFillPercent numerator. */
  peakTotalTokens: number;
  durationMs: number;
  complete: boolean;
  success: boolean;
  outcome: string;
}

/** Session-identity overrides supplied by the caller (Cycloid knows these). */
export interface TraceOverrides {
  sessionId: string;
  repo?: string;
  env?: string;
  agent?: string;
  agentRole?: string;
  branch?: string;
  model?: string;
  provider?: string;
  /**
   * Session-level outcome. This is a Cycloid control-plane concept (did the
   * session succeed / fail / abort), NOT something a harness transcript records
   * reliably - a single errored tool result is routine, not a failed session.
   * Supply these from session metadata when you know them; otherwise the parser
   * defaults to a best-effort `complete` / `success`.
   */
  outcome?: string;
  success?: boolean;
  complete?: boolean;
}

/** Bounds for output redaction/truncation. */
export interface RedactionOptions {
  /** Max chars of output to keep; longer output is head+tail truncated. */
  maxOutputChars: number;
}

export const DEFAULT_REDACTION: RedactionOptions = { maxOutputChars: 8_000 };
