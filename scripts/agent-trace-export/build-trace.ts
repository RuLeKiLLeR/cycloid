/**
 * Assemble the final agent-trace record from a ParsedTranscript plus the
 * session-identity overrides the caller supplies (repo, env, agent, branch, ...).
 * Transcript-derivable fields come from the parse; identity fields that live only
 * in Cycloid control-plane metadata come from `overrides`.
 */

import { parseClaudeTranscript } from "./parse-claude.js";
import { parseCodexRollout } from "./parse-codex.js";
import { deepRedact } from "./redact.js";
import type { AgentTrace, ParsedTranscript, RedactionOptions, TraceOverrides } from "./types.js";
import { DEFAULT_REDACTION } from "./types.js";

export type HarnessFormat = "codex" | "claude";

/**
 * Detect which harness produced a transcript from its records. Codex rollout
 * lines carry top-level `type` of session_meta/response_item/event_msg; Claude
 * project lines carry assistant/user with a nested `message`.
 */
export function detectFormat(records: unknown[]): HarnessFormat {
  for (const rec of records) {
    if (typeof rec !== "object" || rec === null) continue;
    const r = rec as Record<string, unknown>;
    if (r.type === "session_meta" || r.type === "response_item" || r.type === "turn_context") return "codex";
    if (r.type === "event_msg" && typeof (r.payload as Record<string, unknown>)?.type === "string") return "codex";
    if ((r.type === "assistant" || r.type === "user") && typeof r.message === "object") return "claude";
  }
  // Default to claude (its records are a strict subset that the codex parser
  // would silently drop); callers can force a format explicitly.
  return "claude";
}

export function parseTranscript(
  records: unknown[],
  format: HarnessFormat = detectFormat(records),
  redaction: RedactionOptions = DEFAULT_REDACTION,
): ParsedTranscript {
  return format === "codex" ? parseCodexRollout(records, redaction) : parseClaudeTranscript(records, redaction);
}

function round4(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function buildTrace(parsed: ParsedTranscript, overrides: TraceOverrides): AgentTrace {
  const actualInputTokens = parsed.actualInputTokens;
  const actualOutputTokens = parsed.actualOutputTokens;
  // `measuredTotal` is the sum of the DECOMPOSED input components below
  // (systemContext + taskText + uploads + historicalSessions), not input+output.
  // We do not decompose input context, so every component is 0 and the full
  // measured input is reported as `unmeasuredTokens`.
  const systemContext = 0;
  const taskText = 0;
  const uploads = 0;
  const historicalSessions = 0;
  const measuredTotal = systemContext + taskText + uploads + historicalSessions;
  const contextFillPercent =
    parsed.contextWindow && parsed.contextWindow > 0 ? round4(parsed.peakTotalTokens / parsed.contextWindow) : 0;

  const trace: AgentTrace = {
    sessionId: overrides.sessionId,
    repo: overrides.repo ?? "",
    env: overrides.env ?? "local",
    model: overrides.model ?? parsed.model ?? "",
    provider: overrides.provider ?? parsed.provider ?? "",
    agent: overrides.agent ?? "build",
    agentRole: overrides.agentRole ?? "implementation",
    harnessKind: parsed.harnessKind,
    branch: overrides.branch ?? "",
    complete: overrides.complete ?? parsed.complete,
    outcome: overrides.outcome ?? parsed.outcome,
    success: overrides.success ?? parsed.success,
    editCount: parsed.editCount,
    toolCallCount: parsed.toolCallCount,
    questionCount: parsed.questionCount,
    grepSearchCommandCount: parsed.grepSearchCommandCount,
    ripgrepSearchCommandCount: parsed.ripgrepSearchCommandCount,
    contextFillPercent,
    tokenBreakdown: {
      actualInputTokens,
      actualOutputTokens,
      historicalSessions,
      measuredTotal,
      systemContext,
      taskText,
      unmeasuredTokens: Math.max(0, actualInputTokens - measuredTotal),
      uploads,
    },
    durationMs: parsed.durationMs,
    turns: parsed.turns,
    tools: parsed.tools,
  };

  // Final guard: scrub every string in the assembled trace so no field can leak
  // a secret regardless of which parser/call site produced it (e.g. a Codex
  // tool `command` input that the parser did not individually redact).
  return deepRedact(trace);
}
