/**
 * Parse a Claude Code project transcript (under `~/.claude/projects/`) into a
 * ParsedTranscript. Each line is a record with a `type`:
 *
 *   { type: "assistant", message: { content: [ { type: "tool_use", id, name, input }, ... ], usage, model }, timestamp }
 *   { type: "user",      message: { content: [ { type: "tool_result", tool_use_id, content, is_error } ] | "<prompt text>" }, timestamp }
 *
 * Tool output (real text) lives on the `tool_result.content`, correlated to its
 * `tool_use` by `tool_use_id`. This is what the Braintrust span path discards.
 */

import { estimateTokens } from "../../apps/sandbox-bridge/src/utils/tokens.js";
import { redactAndTruncate, redactSecrets } from "./redact.js";
import type { ParsedTranscript, RedactionOptions, TraceTool, TraceTurn } from "./types.js";
import { DEFAULT_REDACTION } from "./types.js";

interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
}

const BASH_TOOL_NAMES = new Set(["Bash", "BashOutput"]);
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTimestamp(ts: unknown): number | undefined {
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Stringify a tool_result `content` (string, or array of text/content blocks). */
export function stringifyClaudeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

const GREP_RE = /(^|[\s|;&(])grep(\s|$)/;
const RG_RE = /(^|[\s|;&(])rg(\s|$)/;

function toolDisplayName(name: string): string {
  if (BASH_TOOL_NAMES.has(name)) return "tool:bash";
  return `tool:${name.toLowerCase()}`;
}

export function parseClaudeTranscript(
  records: unknown[],
  redaction: RedactionOptions = DEFAULT_REDACTION,
): ParsedTranscript {
  let model: string | undefined;
  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  let peakTotalTokens = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  const turns: TraceTurn[] = [];
  const tools: TraceTool[] = [];
  let editCount = 0;
  let questionCount = 0;
  let grepSearchCommandCount = 0;
  let ripgrepSearchCommandCount = 0;

  // tool_use call id -> index into `tools`, plus the call start timestamp.
  const callIndex = new Map<string, { index: number; startTs?: number }>();
  let firstUserPrompt = "";

  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const rec = raw as ClaudeRecord;
    const ts = parseTimestamp(rec.timestamp);
    if (ts !== undefined) {
      if (firstTs === undefined) firstTs = ts;
      lastTs = ts;
    }

    const msg = rec.message;
    if (!isRecord(msg)) continue;

    if (rec.type === "assistant") {
      if (typeof msg.model === "string") model = msg.model;
      const usage = msg.usage;
      if (isRecord(usage)) {
        const input = (usage.input_tokens as number) ?? 0;
        const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
        const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0;
        const output = (usage.output_tokens as number) ?? 0;
        // Cumulative input for a turn includes cache; track the largest seen.
        actualInputTokens = Math.max(actualInputTokens, input + cacheRead + cacheCreate);
        actualOutputTokens += output;
        peakTotalTokens = Math.max(peakTotalTokens, input + cacheRead + cacheCreate + output);
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "tool";
        const id = typeof block.id === "string" ? block.id : `idx-${tools.length}`;
        const input = isRecord(block.input) ? block.input : {};

        if (EDIT_TOOL_NAMES.has(name)) editCount++;
        if (name === "AskUserQuestion" || /question/i.test(name)) questionCount++;
        const command = typeof input.command === "string" ? input.command : "";
        if (BASH_TOOL_NAMES.has(name) && command) {
          if (RG_RE.test(command)) ripgrepSearchCommandCount++;
          else if (GREP_RE.test(command)) grepSearchCommandCount++;
        }

        // Redact tool inputs too (commands can embed secrets).
        const safeInput: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) safeInput[k] = typeof v === "string" ? redactSecrets(v) : v;

        callIndex.set(id, { index: tools.length, startTs: ts });
        tools.push({ name: toolDisplayName(name), input: safeInput, output: "" });
      }
      continue;
    }

    if (rec.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (!firstUserPrompt) firstUserPrompt = content;
        turns.push({ promptId: `p-${turns.length + 1}`, input: { system: "", user: redactSecrets(content) } });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const rawOut = stringifyClaudeContent(block.content);
        // Note: block.is_error marks a routine tool-level error (empty grep,
        // non-zero exit, denied tool) - it is NOT a session-level failure, so it
        // is preserved in tool.output but never flips the session outcome.
        const entry = callId ? callIndex.get(callId) : undefined;
        if (entry) {
          const tool = tools[entry.index];
          tool.output = redactAndTruncate(rawOut, redaction);
          tool.outputEstimatedTokens = estimateTokens(rawOut);
          if (entry.startTs !== undefined && ts !== undefined) tool.durationMs = ts - entry.startTs;
        }
      }
    }
  }

  const durationMs = firstTs !== undefined && lastTs !== undefined ? lastTs - firstTs : 0;
  // A Claude project transcript has no terminal session-outcome marker. Default
  // to complete/success when the transcript has activity; the caller overrides
  // outcome/success from Cycloid session metadata for known failures.
  const complete = tools.length > 0 || turns.length > 0;
  const success = complete;
  const outcome = complete ? "success" : "incomplete";

  return {
    harnessKind: "claude-session",
    provider: "anthropic",
    model,
    turns,
    tools,
    toolCallCount: tools.length,
    editCount,
    questionCount,
    grepSearchCommandCount,
    ripgrepSearchCommandCount,
    actualInputTokens,
    actualOutputTokens,
    contextWindow: undefined,
    peakTotalTokens,
    durationMs,
    complete,
    success,
    outcome,
  };
}
