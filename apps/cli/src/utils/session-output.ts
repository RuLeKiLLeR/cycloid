import { isNoChangesPromptResult, noChangeOutcomeCopy } from "../../../../shared/session/no-change-outcome.js";
import {
  type FinalizingStep,
  type Phase,
  PHASES,
  type SandboxSubstate,
  type StopMode,
} from "../../../../shared/session/phase.js";
import {
  type ActivityEvent,
  flattenSessionEvents,
  partitionEventsByPrompt,
  type RawSessionEvent,
  resolveAuthoritativePromptEventsWithDiagnostics,
} from "../../../../shared/transcript/projector.js";
import { derivePromptDisplayText } from "../../../../shared/transcript/prompt-display.js";
import { formatSessionErrorMessage } from "../../../../shared/types/error-codes.js";
import { stringifyError } from "../../../../shared/utils/errors.js";

// Leading chars of a session UUID shown in the transcript header.
const SHORT_SESSION_ID_LENGTH = 8;
// Max chars of a prompt kept as its short display label.
const PROMPT_LABEL_MAX_CHARS = 80;

// Derived from the canonical PHASES array so a new phase can never silently
// drift out of this set (which would coerce it to null and break arc watch
// exit — the failure mode behind two past regressions).
export const VALID_PHASES = new Set<Phase>(PHASES);
const VALID_SANDBOX_SUBSTATES = new Set<SandboxSubstate>(["creating", "reconnecting", "stopping", "none"]);
const VALID_STOP_MODES = new Set<StopMode>(["user", "resumable", "none"]);
const VALID_FINALIZING_STEPS = new Set<FinalizingStep>(["post_execution", "publishing", "none"]);

interface SessionExportPrompt {
  id: string;
  prompt: string;
  replyToText?: string | null;
  status: string;
  result?: unknown;
  error?: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SessionExportData {
  ok: boolean;
  session: {
    id: string;
    status: string;
    repoUrl: string | null;
    createdAt: string;
    closedAt: string | null;
  };
  prompts: SessionExportPrompt[];
  events: RawSessionEvent[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCostUsd?: number;
  };
  stats: {
    totalPrompts: number;
    successCount: number;
    failCount: number;
    totalToolCalls: number;
    totalDurationMs: number;
  };
  pr: { url: string; number: number | null; branch: string | null } | null;
}
interface SessionResultState {
  prUrl?: unknown;
  publishedBranch?: unknown;
  lastBranch?: unknown;
  baseBranch?: unknown;
}

export interface SessionResultFields {
  prUrl?: string;
  publishedBranch?: string;
  lastBranch?: string;
}

export interface WatchStatusEvent {
  // Canonical phase contract from `shared/session/phase.ts`. Emitted for every
  // session kind after PR D. Null only if the server didn't populate it
  // (e.g. pre-PR-A worker still in the deploy gap).
  phase: Phase | null;
  sandboxSubstate?: SandboxSubstate;
  stopMode?: StopMode;
  finalizingStep?: FinalizingStep;
  title?: string;
  spawnDurationMs?: number | null;
}

interface ParsedSsePayload {
  status: WatchStatusEvent | null;
  events: Array<{ id?: number; type: string; data: Record<string, unknown> }>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

function renderTranscriptEvent(event: ActivityEvent): string {
  switch (event.type) {
    case "text":
      return event.text;
    case "tool_call":
      return `**Tool call:** ${event.tool}${event.summary ? ` - ${event.summary}` : ""}${event.toolStatus ? ` (${event.toolStatus})` : ""}\n`;
    case "reasoning":
      return `<details><summary>Reasoning</summary>\n\n${event.text}\n</details>\n`;
    case "patch":
      return `**Files changed:** ${event.files.join(", ")}\n`;
    case "question":
      return `**Question:** ${event.question}\n${event.answer ? `**Answer:** ${event.answer}\n` : ""}`;
    case "retry_status":
      return `*[retry ${event.attempt}: ${event.message}]*\n`;
    case "compaction_start":
      return event.contextTokens
        ? `*[compacting context at ${Math.round(event.contextTokens / 1000)}k tokens]*\n`
        : "*[compacting context]*\n";
    case "compaction_complete":
      if (event.contextTokensBefore && event.contextTokensAfter && event.contextTokensBefore > 0) {
        const savedPct = Math.round((1 - event.contextTokensAfter / event.contextTokensBefore) * 100);
        return `*[context compacted: ${Math.round(event.contextTokensBefore / 1000)}k → ${Math.round(event.contextTokensAfter / 1000)}k (${savedPct}% saved)]*\n`;
      }
      return "*[context compacted]*\n";
    case "context_fill_warning":
      return `*[context ${Math.round(event.fillPercent * 100)}% full]*\n`;
    case "tool_truncated":
      if (event.reason === "size_threshold") {
        return `*[${event.tool} output exceeded safe size]*\n`;
      }
      return `*[${event.tool} output truncated]*\n`;
    case "memory_usage":
      return event.activeMemoryIds.length > 0
        ? `*[used ${event.activeMemoryIds.length === 1 ? "1 memory" : `${event.activeMemoryIds.length} memories`}: ${event.activeMemories.map((memory) => `\`${memory.title || memory.id}\``).join(", ")}]*\n`
        : "";
    case "memory_recall_usage":
      return event.returnedMemoryIds.length > 0
        ? `*[recalled ${event.returnedMemoryIds.length === 1 ? "1 memory" : `${event.returnedMemoryIds.length} memories`}: ${event.returnedMemories.map((memory) => `\`${memory.title || memory.id}\``).join(", ")}]*\n`
        : "";
    case "agent_timeline":
      return `*[${event.eventType}${event.status ? ` (${event.status})` : ""}: ${event.summary}]*\n`;
    case "session_error":
      return `**Error:** ${formatSessionErrorMessage(event.error, event.code)}\n`;
    case "session_resumed_cold":
      return "*[Environment was reset; in-environment state was lost]*\n";
    case "customer_activity":
      return `**${event.title}:** ${event.summary}\n`;
    case "prompt_activity":
      return "";
    case "agent_progress":
      return `*[${event.label}]*\n`;
    case "raw_agent_runtime":
      return "";
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function formatSessionResult(session: SessionResultState): string | null {
  const { prUrl, publishedBranch, lastBranch } = extractSessionResultFields(session);
  const baseBranch = stringField(session.baseBranch);
  const branch = publishedBranch ?? (lastBranch && lastBranch !== baseBranch ? lastBranch : null);

  if (prUrl) {
    return `PR: ${prUrl}${branch ? ` (${branch})` : ""}`;
  }
  if (branch) {
    return `Branch: ${branch}`;
  }
  return null;
}

export function extractSessionResultFields(session: SessionResultState): SessionResultFields {
  const result: SessionResultFields = {};
  const prUrl = stringField(session.prUrl);
  const publishedBranch = stringField(session.publishedBranch);
  const lastBranch = stringField(session.lastBranch);
  if (prUrl) result.prUrl = prUrl;
  if (publishedBranch) result.publishedBranch = publishedBranch;
  if (lastBranch) result.lastBranch = lastBranch;
  return result;
}

// Most recent completed prompt's result. `result` may be a string (e.g. a
// truncated export payload) — `isNoChangesPromptResult` rejects non-objects.
function latestCompletedPromptResult(prompts: SessionExportData["prompts"]): unknown {
  for (let i = prompts.length - 1; i >= 0; i--) {
    if (prompts[i].status === "completed") return prompts[i].result;
  }
  return null;
}

export function renderSessionTranscript(exportData: SessionExportData): string {
  const lines: string[] = [];
  const promptIds = exportData.prompts.map((prompt) => prompt.id);
  const eventBuckets = partitionEventsByPrompt(exportData.events, promptIds);

  lines.push("# Session transcript\n");
  if (exportData.session.repoUrl) lines.push(`**Repo:** ${exportData.session.repoUrl}  `);
  lines.push(`**Session:** ${exportData.session.id.slice(0, SHORT_SESSION_ID_LENGTH)}  `);
  lines.push(`**Created:** ${formatDate(exportData.session.createdAt)}  `);
  lines.push(`**Status:** ${exportData.session.status}  `);
  const noChangeResult = latestCompletedPromptResult(exportData.prompts);
  // Mirror the server view's `!session.prUrl` gate: don't print a no-change
  // outcome when a PR exists (e.g. an earlier prompt opened one).
  if (!exportData.pr?.url && isNoChangesPromptResult(noChangeResult)) {
    lines.push(`**Outcome:** ${noChangeOutcomeCopy(noChangeResult.noChangeReason).title}  `);
  }
  lines.push(
    `**Tokens:** ${formatNumber(exportData.tokens.inputTokens)} in / ${formatNumber(exportData.tokens.outputTokens)} out / ${formatNumber(exportData.tokens.totalTokens)} total`,
  );
  if (exportData.pr?.url) {
    lines.push(`**PR:** ${exportData.pr.url}${exportData.pr.branch ? ` (${exportData.pr.branch})` : ""}`);
  }
  lines.push("");

  for (let i = 0; i < exportData.prompts.length; i++) {
    const prompt = exportData.prompts[i];
    const rawEvents = eventBuckets.get(prompt.id) ?? [];
    const { events: authoritativeEvents, diagnostics } = resolveAuthoritativePromptEventsWithDiagnostics(rawEvents);
    if (diagnostics.mergedDurablePromptActivityCount > 0) {
      console.error("[transcript] merged durable prompt_activity events missing from embedded terminal history", {
        sessionId: exportData.session.id,
        promptId: prompt.id,
        mergedDurablePromptActivityCount: diagnostics.mergedDurablePromptActivityCount,
        durablePromptActivityCount: diagnostics.durablePromptActivityCount,
        embeddedPromptActivityCount: diagnostics.embeddedPromptActivityCount,
        duplicateDurablePromptActivityCount: diagnostics.duplicateDurablePromptActivityCount,
      });
    }
    if (diagnostics.mergedDurableAgentProgressCount > 0) {
      console.error("[transcript] merged durable agent_progress events missing from embedded terminal history", {
        sessionId: exportData.session.id,
        promptId: prompt.id,
        mergedDurableAgentProgressCount: diagnostics.mergedDurableAgentProgressCount,
        durableAgentProgressCount: diagnostics.durableAgentProgressCount,
        embeddedAgentProgressCount: diagnostics.embeddedAgentProgressCount,
        duplicateDurableAgentProgressCount: diagnostics.duplicateDurableAgentProgressCount,
      });
    }
    const events = flattenSessionEvents(authoritativeEvents);

    lines.push("---\n");
    lines.push(`## Turn ${i + 1}\n`);
    lines.push(`**Prompt ID:** ${prompt.id}  `);
    lines.push(`**Prompt Status:** ${prompt.status}${prompt.error ? ` | ${prompt.error}` : ""}`);
    lines.push("");
    lines.push("**User:**\n");
    lines.push(derivePromptDisplayText({ prompt: prompt.prompt, replyToText: prompt.replyToText }));
    lines.push("");

    if (events.length > 0) {
      lines.push("**Assistant:**\n");
      let pendingText = "";
      for (const event of events) {
        const rendered = renderTranscriptEvent(event);
        if (!rendered) continue;

        if (event.type === "text") {
          pendingText += rendered;
        } else {
          if (pendingText) {
            lines.push(pendingText.trimEnd());
            lines.push("");
            pendingText = "";
          }
          lines.push(rendered);
        }
      }
      if (pendingText) {
        lines.push(pendingText.trimEnd());
        lines.push("");
      }
    } else if (prompt.error) {
      lines.push("**Assistant:**\n");
      lines.push(`**Error:** ${prompt.error}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function parseSsePayload(payload: string): ParsedSsePayload {
  const messages: Array<{ event: string; id?: number; data: string }> = [];
  let currentEvent = "message";
  let currentId: number | undefined;
  let currentData: string[] = [];

  function flush(): void {
    if (currentData.length === 0 && currentId === undefined && currentEvent === "message") return;
    const msg: { event: string; id?: number; data: string } = { event: currentEvent, data: currentData.join("\n") };
    if (currentId !== undefined) msg.id = currentId;
    messages.push(msg);
    currentEvent = "message";
    currentId = undefined;
    currentData = [];
  }

  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("id:")) {
      const parsed = Number.parseInt(line.slice("id:".length).trim(), 10);
      currentId = Number.isFinite(parsed) ? parsed : undefined;
      continue;
    }
    if (line.startsWith("data:")) {
      currentData.push(line.slice("data:".length).trimStart());
    }
  }
  flush();

  let status: WatchStatusEvent | null = null;
  const events: ParsedSsePayload["events"] = [];
  for (const message of messages) {
    const data = message.data ? parseJsonObject(message.data) : {};
    if (message.event === "status") {
      const phaseRaw = data.phase;
      const phase: Phase | null =
        typeof phaseRaw === "string" && VALID_PHASES.has(phaseRaw as Phase) ? (phaseRaw as Phase) : null;
      const entry: WatchStatusEvent = {
        phase,
      };
      const sandboxSubstate = validateEnumField(data.sandboxSubstate, VALID_SANDBOX_SUBSTATES);
      if (sandboxSubstate !== undefined) entry.sandboxSubstate = sandboxSubstate;
      const stopMode = validateEnumField(data.stopMode, VALID_STOP_MODES);
      if (stopMode !== undefined) entry.stopMode = stopMode;
      const finalizingStep = validateEnumField(data.finalizingStep, VALID_FINALIZING_STEPS);
      if (finalizingStep !== undefined) entry.finalizingStep = finalizingStep;
      if (typeof data.title === "string") entry.title = data.title;
      if (typeof data.spawnDurationMs === "number" || data.spawnDurationMs === null) {
        entry.spawnDurationMs = data.spawnDurationMs as number | null;
      }
      status = entry;
      continue;
    }
    events.push({
      type: message.event,
      ...(message.id !== undefined ? { id: message.id } : {}),
      data,
    });
  }

  return { status, events };
}

function validateEnumField<T extends string>(value: unknown, validSet: Set<T>): T | undefined {
  return typeof value === "string" && validSet.has(value as T) ? (value as T) : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(`Malformed SSE JSON payload: ${stringifyError(err)}`);
  }
}

export interface WatchRenderState {
  promptLabels: Map<string, string>;
  toolCalls: Map<string, { tool: string; summary: string }>;
}

type WatchRenderable = { kind: "text"; text: string } | { kind: "line"; line: string } | null;

function formatPromptLabel(promptId: string | undefined, promptLabels: Map<string, string>): string {
  if (!promptId) return "";
  const prompt = promptLabels.get(promptId);
  return prompt ? ` - ${prompt}` : "";
}

export function buildPromptLabelMap(
  prompts: Array<{ promptId: string; prompt: string; replyToText?: string | null }>,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const prompt of prompts) {
    const text = derivePromptDisplayText({ prompt: prompt.prompt, replyToText: prompt.replyToText });
    labels.set(prompt.promptId, text.replace(/\s+/g, " ").trim().slice(0, PROMPT_LABEL_MAX_CHARS));
  }
  return labels;
}

export function renderWatchEvent(
  event: { type: string; data: Record<string, unknown> },
  state: WatchRenderState,
): WatchRenderable {
  const data = event.data;

  switch (event.type) {
    case "text":
      return { kind: "text", text: String(data.text ?? "") };
    case "prompt_enqueued": {
      const promptId = typeof data.promptId === "string" ? data.promptId : undefined;
      return {
        kind: "line",
        line: `[queued] ${promptId ?? "unknown"}${formatPromptLabel(promptId, state.promptLabels)}`,
      };
    }
    case "prompt_processing": {
      const promptId = typeof data.promptId === "string" ? data.promptId : undefined;
      return {
        kind: "line",
        line: `[prompt] ${promptId ?? "unknown"} started${formatPromptLabel(promptId, state.promptLabels)}`,
      };
    }
    case "prompt_completed": {
      const promptId = typeof data.promptId === "string" ? data.promptId : undefined;
      return { kind: "line", line: `[prompt] ${promptId ?? "unknown"} completed` };
    }
    case "prompt_failed": {
      const promptId = typeof data.promptId === "string" ? data.promptId : undefined;
      const error = typeof data.error === "string" ? data.error : "unknown error";
      return { kind: "line", line: `[prompt] ${promptId ?? "unknown"} failed: ${error}` };
    }
    case "tool_call": {
      const toolId = String(data.id ?? "");
      const tool = String(data.tool ?? "unknown");
      const summary = String(data.summary ?? "");
      state.toolCalls.set(toolId, { tool, summary });
      return { kind: "line", line: `[tool] ${tool}${summary ? ` - ${summary}` : ""}` };
    }
    case "tool_update": {
      const toolId = String(data.id ?? "");
      const status = typeof data.status === "string" ? data.status : null;
      if (!status) return null;
      const tool = state.toolCalls.get(toolId);
      if (!tool) return { kind: "line", line: `[tool] ${toolId} ${status}` };
      return { kind: "line", line: `[tool ${status}] ${tool.tool}${tool.summary ? ` - ${tool.summary}` : ""}` };
    }
    case "question":
      return { kind: "line", line: `[question] ${String(data.question ?? "")}` };
    case "patch": {
      const files = Array.isArray(data.files)
        ? data.files.filter((item): item is string => typeof item === "string")
        : [];
      return { kind: "line", line: `[patch] ${files.join(", ")}` };
    }
    case "agent_timeline": {
      const eventType = String(data.eventType ?? "timeline");
      const status = typeof data.status === "string" ? ` ${data.status}` : "";
      return { kind: "line", line: `[agent] ${eventType}${status}: ${String(data.summary ?? "")}` };
    }
    case "session_error":
      return {
        kind: "line",
        line: `[error] ${formatSessionErrorMessage(String(data.error ?? "Unknown error"), typeof data.code === "string" ? data.code : null)}`,
      };
    case "pr_created":
    case "pr_updated":
      return { kind: "line", line: `[pr] ${String(data.prUrl ?? "")}` };
    case "pr_failed":
      return { kind: "line", line: `[pr error] ${String(data.error ?? "Unknown error")}` };
    case "session_idle":
      return { kind: "line", line: "[idle] waiting for next prompt" };
    default:
      return null;
  }
}
