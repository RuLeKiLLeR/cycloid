/**
 * Parse a Codex rollout JSONL transcript (`$CODEX_HOME/sessions/*.jsonl`) into a
 * ParsedTranscript. The rollout uses the OpenAI Responses item format:
 *
 *   { type: "session_meta",  payload: { model_provider, cwd, base_instructions, git } }
 *   { type: "turn_context",  payload: { model, ... } }
 *   { type: "response_item", payload: { type: "function_call", name, arguments, call_id } }
 *   { type: "response_item", payload: { type: "function_call_output", call_id, output } }
 *   { type: "event_msg",     payload: { type: "user_message" | "token_count" | "task_complete" | ... } }
 *
 * Tool output (the real stdout/stderr) lives on `function_call_output.output`,
 * correlated to its call by `call_id`. This is exactly the text the Braintrust
 * span path discards.
 */

import { estimateTokens } from "../../apps/sandbox-bridge/src/utils/tokens.js";
import { redactAndTruncate, redactSecrets } from "./redact.js";
import type { ParsedTranscript, RedactionOptions, TraceTool, TraceTurn } from "./types.js";
import { DEFAULT_REDACTION } from "./types.js";

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const BASH_TOOL_NAMES = new Set(["exec_command", "shell", "bash", "container.exec", "local_shell", "exec"]);
const PATCH_TOOL_NAMES = new Set(["apply_patch", "edit_file", "write_file"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTimestamp(ts: unknown): number | undefined {
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Pull a human-readable command string out of a function_call's arguments JSON. */
export function extractCodexCommand(args: unknown): { command: string; input: Record<string, unknown> } {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return { command: args, input: { raw: args } };
    }
  }
  if (!isRecord(parsed)) return { command: String(args ?? ""), input: { raw: args } };

  // exec_command -> { cmd }; shell -> { command: string[] }; apply_patch -> { input/patch }.
  let command = "";
  if (typeof parsed.cmd === "string") command = parsed.cmd;
  else if (Array.isArray(parsed.command)) command = parsed.command.filter((p) => typeof p === "string").join(" ");
  else if (typeof parsed.command === "string") command = parsed.command;
  else if (typeof parsed.patch === "string") command = parsed.patch;
  else if (typeof parsed.input === "string") command = parsed.input;

  return { command, input: { command } };
}

const GREP_RE = /(^|[\s|;&(])grep(\s|$)/;
const RG_RE = /(^|[\s|;&(])rg(\s|$)/;

function classifyOutput(payload: Record<string, unknown>): string {
  const out = payload.output;
  if (typeof out === "string") return out;
  if (isRecord(out) && typeof out.content === "string") return out.content;
  return out === undefined ? "" : JSON.stringify(out);
}

export function parseCodexRollout(
  records: unknown[],
  redaction: RedactionOptions = DEFAULT_REDACTION,
): ParsedTranscript {
  let provider: string | undefined;
  let model: string | undefined;
  let systemText = "";
  let contextWindow: number | undefined;
  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  let peakTotalTokens = 0;
  let complete = false;
  let sawError = false;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  const turns: TraceTurn[] = [];
  const tools: TraceTool[] = [];
  let editCount = 0;
  let questionCount = 0;
  let grepSearchCommandCount = 0;
  let ripgrepSearchCommandCount = 0;

  // Pending function_call calls awaiting their output, keyed by call_id.
  interface PendingCall {
    name: string;
    command: string;
    input: Record<string, unknown>;
    startTs?: number;
    toolIndex: number;
  }
  const pending = new Map<string, PendingCall>();

  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const rec = raw as CodexRecord;
    const ts = parseTimestamp(rec.timestamp);
    if (ts !== undefined) {
      if (firstTs === undefined) firstTs = ts;
      lastTs = ts;
    }
    const payload = rec.payload;
    if (!isRecord(payload)) continue;

    if (rec.type === "session_meta") {
      if (typeof payload.model_provider === "string") provider = payload.model_provider;
      const base = payload.base_instructions;
      if (typeof base === "string") systemText = base;
      else if (isRecord(base) && typeof base.text === "string") systemText = base.text;
      continue;
    }

    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      continue;
    }

    const pType = payload.type;

    if (rec.type === "event_msg") {
      if (pType === "token_count") {
        const info = payload.info;
        if (isRecord(info)) {
          const total = info.total_token_usage;
          if (isRecord(total)) {
            if (typeof total.input_tokens === "number") actualInputTokens = total.input_tokens;
            if (typeof total.output_tokens === "number") actualOutputTokens = total.output_tokens;
            if (typeof total.total_tokens === "number") peakTotalTokens = Math.max(peakTotalTokens, total.total_tokens);
          }
          if (typeof info.model_context_window === "number") contextWindow = info.model_context_window;
        }
      } else if (pType === "user_message") {
        const text =
          typeof payload.message === "string" ? payload.message : typeof payload.text === "string" ? payload.text : "";
        turns.push({
          promptId: `p-${turns.length + 1}`,
          input: { system: redactSecrets(systemText), user: redactSecrets(text) },
        });
      } else if (pType === "task_complete") {
        complete = true;
      } else if (pType === "error" || pType === "stream_error") {
        sawError = true;
      }
      continue;
    }

    if (rec.type === "response_item") {
      if (pType === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const callId = typeof payload.call_id === "string" ? payload.call_id : `idx-${tools.length}`;
        const { command, input } = extractCodexCommand(payload.arguments);

        const isBash = BASH_TOOL_NAMES.has(name);
        const isPatch = PATCH_TOOL_NAMES.has(name);
        if (isPatch) editCount++;
        if (/question/i.test(name)) questionCount++;
        if (isBash && command) {
          if (RG_RE.test(command)) ripgrepSearchCommandCount++;
          else if (GREP_RE.test(command)) grepSearchCommandCount++;
        }

        const toolName = isBash ? "tool:bash" : `tool:${name}`;
        const toolIndex = tools.length;
        tools.push({ name: toolName, input, output: "" });
        pending.set(callId, { name, command, input, startTs: ts, toolIndex });
      } else if (pType === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const rawOut = classifyOutput(payload);
        const call = callId ? pending.get(callId) : undefined;
        if (call) {
          const tool = tools[call.toolIndex];
          tool.output = redactAndTruncate(rawOut, redaction);
          tool.outputEstimatedTokens = estimateTokens(rawOut);
          if (call.startTs !== undefined && ts !== undefined) tool.durationMs = ts - call.startTs;
          pending.delete(callId!);
        }
      }
      continue;
    }
  }

  const durationMs = firstTs !== undefined && lastTs !== undefined ? lastTs - firstTs : 0;
  const success = complete && !sawError;
  const outcome = sawError ? "error" : complete ? "success" : "incomplete";

  return {
    harnessKind: "codex-session",
    provider,
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
    contextWindow,
    peakTotalTokens,
    durationMs,
    complete,
    success,
    outcome,
  };
}
