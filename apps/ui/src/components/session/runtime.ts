import { displayStatusFromSession } from "../../../../../shared/session/display-status.js";
import { isArchiveAvailable, isStopAvailable, isWarmAvailable } from "../../../../../shared/session/eligibility.js";
import type { RuntimeProvenance } from "../../../../../shared/types/sandbox.js";
import { RUNTIME_CONTEXT_EVENT_LIMIT, RUNTIME_TEST_COMMAND_PATTERN } from "../../constants/session-workbench";
import { isFileChangeTool, normalizeToolName, TOOL_NAMES } from "../../constants/tools";
import type { SessionTokenUsage } from "../../hooks/session-state/types";
import type { ActivityEvent, Phase, SandboxSubstate } from "../../types";

export type SandboxStateInput = {
  phase: Phase;
  displayStatus?: import("../../../../../shared/session/display-status.js").DisplayStatus;
  sandboxSubstate?: SandboxSubstate | null;
  sandboxConnected?: boolean | null;
  finalizingStep?: import("../../../../../shared/session/phase.js").FinalizingStep | null;
  uiLifecycleStage?: import("../../../../../shared/session/lifecycle-stage.js").UiLifecycleStage | null;
};

export type SandboxState = {
  /** Sentence-case sandbox readout, e.g. "Active", "Provisioning". */
  label: string;
  /** True while the sandbox is actively doing work (drives the live dot). */
  live: boolean;
};

/**
 * Presentation-only sandbox/VM readout. The status value is the same
 * projection the rest of the page renders — `displayStatus` from the session
 * record, falling back to the shared `displayStatusFromPhase` projection.
 * This maps that value to a label; it is NOT a new status derivation path.
 */
export function deriveSandboxState(input: SandboxStateInput): SandboxState {
  const status = input.displayStatus ?? displayStatusFromSession(input);
  switch (status) {
    case "working":
      // Substate is checked before the connected flag: while the sandbox is
      // still being created the bridge has never connected, so a false
      // `sandboxConnected` means "starting", not a lost connection —
      // "Disconnected" is reserved for a connection that existed and dropped.
      switch (input.sandboxSubstate) {
        case "creating":
          return { label: "Starting", live: true };
        case "reconnecting":
          return { label: "Reconnecting", live: true };
        case "stopping":
          return { label: "Stopping", live: false };
      }
      if (input.sandboxConnected === false) return { label: "Disconnected", live: false };
      return { label: "Active", live: true };
    case "waiting_for_input":
      if (input.sandboxConnected === false) return { label: "Disconnected", live: false };
      return { label: "Active", live: false };
    case "archived":
      return { label: "Archived", live: false };
    case "stopped":
      return { label: "Stopped", live: false };
    case "completed":
    case "failed":
      return { label: "Idle", live: false };
  }
}

/**
 * Live bridge-transport readout for the sandbox card. Rendered only while the
 * session is in a non-terminal display status — "Disconnected" on a stopped or
 * archived session is a tautology, not signal. `sandboxConnected` reaches the
 * record from both the WS snapshot (`subscribed.sandbox.connected`,
 * `sandbox_ready`, heartbeats) and the view fetch; a record that predates the
 * field renders nothing.
 */
export function deriveSandboxConnection(input: {
  phase: Phase;
  displayStatus?: import("../../../../../shared/session/display-status.js").DisplayStatus;
  sandboxConnected?: boolean | null;
  finalizingStep?: import("../../../../../shared/session/phase.js").FinalizingStep | null;
  uiLifecycleStage?: import("../../../../../shared/session/lifecycle-stage.js").UiLifecycleStage | null;
}): { label: "Connected" | "Disconnected"; live: boolean } | null {
  if (typeof input.sandboxConnected !== "boolean") return null;
  const status = input.displayStatus ?? displayStatusFromSession(input);
  if (status !== "working" && status !== "waiting_for_input") return null;
  return input.sandboxConnected ? { label: "Connected", live: true } : { label: "Disconnected", live: false };
}

export type SandboxMeta = {
  /** Provider sandbox id: live sandbox state first, provenance report as fallback. */
  sandboxId: string | null;
  /** Runtime backend readout, e.g. "e2b_cloud". */
  runtime: string | null;
  /** Boot path readout, e.g. "fresh_clone", "repo_image", "session_snapshot". */
  bootMode: string | null;
  /** Sandbox base-image version the session booted from. */
  imageVersion: string | null;
};

/**
 * Sandbox identity/provenance readouts from the session record. The id prefers
 * the live sandbox state (`sandboxId` — WS snapshot / `sandbox_ready` / view
 * fetch) over the provenance report, which only lands after the bridge's
 * runtime_info arrives.
 */
export function deriveSandboxMeta(input: {
  sandboxId?: string | null;
  runtimeProvenance?: RuntimeProvenance | null;
}): SandboxMeta {
  const provenance = input.runtimeProvenance ?? null;
  const runtime = provenance?.runtime ?? null;
  return {
    sandboxId: input.sandboxId ?? runtime?.sandboxId ?? null,
    runtime: runtime?.backend ?? runtime?.provider ?? null,
    bootMode: provenance?.bootMode ?? null,
    imageVersion: provenance?.sandboxImageVersion ?? null,
  };
}

export type RuntimeActionId = "stop" | "wake" | "archive";

/**
 * Session actions the Runtime tab may offer, in display order. Every entry is
 * backed by a real UI API function (`stopSession`, `warmSandbox`,
 * `archiveSession`) and gated by the canonical
 * eligibility helpers in `shared/session/eligibility.ts` — no visibility
 * decision is derived locally. Archive is additionally hidden while the
 * session is live so the destructive path is stop-first.
 */
export function deriveRuntimeActions(input: {
  phase: Phase;
  sandboxSubstate?: SandboxSubstate | null;
}): RuntimeActionId[] {
  const substate = input.sandboxSubstate ?? undefined;
  const actions: RuntimeActionId[] = [];
  if (isStopAvailable(input.phase, substate, false)) actions.push("stop");
  if (isWarmAvailable(input.phase)) actions.push("wake");
  const live = input.phase === "running" || input.phase === "waiting_for_input" || input.phase === "finalizing";
  if (isArchiveAvailable(input.phase) && !live) actions.push("archive");
  return actions;
}

export type ContextEventKind = "context_fill_warning" | "compaction_start" | "compaction_complete";

export type ContextEventEntry = {
  id: string;
  kind: ContextEventKind;
  /** Short mono tag, e.g. "fill warning" (rendered uppercase). */
  label: string;
  /** Preformatted mono readout, e.g. "364K → 45K". Null when the event carried no counts. */
  detail: string | null;
};

export type ContextUsage = {
  contextTokens: number | null;
  contextWindow: number | null;
  /** 0-100 fill percentage when known or computable. */
  fillPercent: number | null;
  /** Newest-first compaction/fill-warning history, capped at RUNTIME_CONTEXT_EVENT_LIMIT. */
  events: ContextEventEntry[];
};

export function hasTokenUsage(usage: SessionTokenUsage): boolean {
  return (
    usage.model !== null ||
    usage.contextWindow !== null ||
    usage.input !== 0 ||
    usage.output !== 0 ||
    usage.cacheRead !== 0 ||
    usage.cacheWrite !== 0 ||
    usage.totalTokens !== 0 ||
    usage.totalBilledTokens !== 0 ||
    usage.context !== 0 ||
    usage.peakContext !== 0 ||
    usage.cost !== 0
  );
}

export function mergeExactContextUsage(
  tokenUsage: SessionTokenUsage,
  eventUsage: ContextUsage | null,
): ContextUsage | null {
  if (!hasTokenUsage(tokenUsage)) return eventUsage;
  const contextWindow = tokenUsage.contextWindow ?? eventUsage?.contextWindow ?? null;
  const contextTokens = tokenUsage.context;
  const fillPercent =
    contextWindow && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 100)
      : (eventUsage?.fillPercent ?? null);
  return { contextTokens, contextWindow, fillPercent, events: eventUsage?.events ?? [] };
}

export function formatExactTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US").format(tokens);
}

/** Dollar readout at 2-3 decimals — micro-cent precision is noise here. */
export function formatUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  const formatted = `$${cost.toFixed(3).replace(/0$/, "")}`;
  // Sub-millicent costs round to zero at 3 decimals; show the floor instead
  // of a fake "$0.00" that contradicts hasTokenUsage.
  return formatted === "$0.00" ? "<$0.001" : formatted;
}

export function formatExactContextReadout(usage: ContextUsage): string | null {
  const parts: string[] = [];
  if (usage.contextTokens !== null && usage.contextWindow !== null) {
    parts.push(`${formatExactTokenCount(usage.contextTokens)} / ${formatExactTokenCount(usage.contextWindow)}`);
  } else if (usage.contextTokens !== null) {
    parts.push(formatExactTokenCount(usage.contextTokens));
  }
  if (usage.fillPercent !== null) {
    if (parts.length === 0) return `${usage.fillPercent}%`;
    parts.push(`(${usage.fillPercent}%)`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function contextEventEntry(promptId: string, evt: ActivityEvent): ContextEventEntry | null {
  switch (evt.type) {
    case "context_fill_warning": {
      const parts: string[] = [`${evt.fillPercent}%`];
      if (evt.contextTokens != null && evt.contextWindow != null) {
        parts.push(`${formatTokenCount(evt.contextTokens)} / ${formatTokenCount(evt.contextWindow)}`);
      } else if (evt.contextTokens != null) {
        parts.push(formatTokenCount(evt.contextTokens));
      }
      return { id: `${promptId}:${evt.id}`, kind: evt.type, label: "fill warning", detail: parts.join(" · ") };
    }
    case "compaction_start":
      return {
        id: `${promptId}:${evt.id}`,
        kind: evt.type,
        label: "compaction",
        detail: evt.contextTokens != null ? `at ${formatTokenCount(evt.contextTokens)}` : null,
      };
    case "compaction_complete": {
      const before = evt.contextTokensBefore != null ? formatTokenCount(evt.contextTokensBefore) : null;
      const after = evt.contextTokensAfter != null ? formatTokenCount(evt.contextTokensAfter) : null;
      const detail = before && after ? `${before} → ${after}` : (after ?? before);
      return { id: `${promptId}:${evt.id}`, kind: evt.type, label: "compacted", detail };
    }
    default:
      return null;
  }
}

/**
 * Latest known context-window usage from events already streamed into session
 * state. Only `context_fill_warning` and compaction events carry token counts;
 * when none has streamed, usage is unknown and this returns null (the UI omits
 * the readout rather than faking one). The event history is newest-first and
 * carries no timestamps — projected ActivityEvents do not retain them.
 */
export function deriveContextUsage(
  promptOrder: string[],
  transcripts: Map<string, ActivityEvent[]>,
): ContextUsage | null {
  let seen = false;
  let contextTokens: number | null = null;
  // The window is a model property, so a window reported by an earlier fill
  // warning still applies after later compaction events.
  let contextWindow: number | null = null;
  let fillPercent: number | null = null;
  const history: ContextEventEntry[] = [];

  for (const promptId of promptOrder) {
    const events = transcripts.get(promptId);
    if (!events) continue;
    for (const evt of events) {
      if (evt.type === "context_fill_warning") {
        seen = true;
        contextTokens = evt.contextTokens ?? null;
        if (evt.contextWindow != null) contextWindow = evt.contextWindow;
        fillPercent = evt.fillPercent;
      } else if (evt.type === "compaction_start" && evt.contextTokens != null) {
        seen = true;
        contextTokens = evt.contextTokens;
        fillPercent = null;
      } else if (evt.type === "compaction_complete" && evt.contextTokensAfter != null) {
        seen = true;
        contextTokens = evt.contextTokensAfter;
        fillPercent = null;
      }
      const entry = contextEventEntry(promptId, evt);
      if (entry) history.push(entry);
    }
  }

  if (!seen) return null;
  if (fillPercent === null && contextTokens !== null && contextWindow !== null && contextWindow > 0) {
    fillPercent = Math.round((contextTokens / contextWindow) * 100);
  }
  return {
    contextTokens,
    contextWindow,
    fillPercent,
    events: history.slice(-RUNTIME_CONTEXT_EVENT_LIMIT).reverse(),
  };
}

/** Compact mono readout for token counts: 812 -> "812", 82_400 -> "82.4K". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${trimTrailingZero((tokens / 1_000).toFixed(1))}K`;
  return String(Math.round(tokens));
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** Exact mono context readout: "91K / 400K (23%)", degrading to what is known. */
export function formatContextReadout(usage: ContextUsage): string | null {
  const parts: string[] = [];
  if (usage.contextTokens !== null && usage.contextWindow !== null) {
    parts.push(`${formatTokenCount(usage.contextTokens)} / ${formatTokenCount(usage.contextWindow)}`);
  } else if (usage.contextTokens !== null) {
    parts.push(formatTokenCount(usage.contextTokens));
  }
  if (usage.fillPercent !== null) {
    if (parts.length === 0) return `${usage.fillPercent}%`;
    parts.push(`(${usage.fillPercent}%)`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export type RuntimeActivityKind = "tool" | "edit" | "test" | "retry" | "error" | "step" | "publish";

/** Mono tag text per activity kind (rendered uppercase by the panel). */
export const RUNTIME_ACTIVITY_KIND_LABELS: Record<RuntimeActivityKind, string> = {
  tool: "tool",
  edit: "edit",
  test: "test",
  retry: "retry",
  error: "error",
  step: "step",
  publish: "publish",
};

export type RuntimeLogEntry = {
  id: string;
  /** Category tag for the entry (drives the eyebrow label). */
  kind: RuntimeActivityKind;
  /**
   * Short mono label for the entry (tool name, "patch", …). Null when the kind
   * tag already says everything — a second badge would be noise.
   */
  label: string | null;
  detail: string | null;
  status: "running" | "completed" | "error" | null;
};

function classifyToolCall(tool: string, summary: string): RuntimeActivityKind {
  if (isFileChangeTool(tool)) return "edit";
  if (normalizeToolName(tool) === TOOL_NAMES.BASH && RUNTIME_TEST_COMMAND_PATTERN.test(summary)) return "test";
  return "tool";
}

/** Friendly labels for timeline entries worth surfacing; unknown ids stay hidden. */
function timelineEntryCopy(
  eventType: string,
  metadata?: Record<string, unknown>,
): { kind: RuntimeActivityKind; label: string } | null {
  if (eventType === "pr.open") return { kind: "publish", label: "Opened PR" };
  if (eventType === "verification.result") return { kind: "test", label: "Verification finished" };
  if (eventType === "publish_gate.result") {
    return metadata?.gate === "fix"
      ? { kind: "publish", label: "Preparing changes" }
      : { kind: "publish", label: "Publish update" };
  }
  if (eventType.startsWith("publish.")) return { kind: "publish", label: "Publish update" };
  return null;
}

function timelineStatus(status: string | undefined): RuntimeLogEntry["status"] {
  if (!status) return "completed";
  return /fail|error/i.test(status) ? "error" : "completed";
}

/**
 * Compact tail of log-like transcript events (tool calls, patches, retries,
 * progress, publish/verification timeline, errors) for the Runtime tab,
 * newest first. Prose events (text/reasoning) stay in the thread — the tail
 * is instrumentation, not a second transcript.
 */
export function deriveRuntimeLogTail(
  promptOrder: string[],
  transcripts: Map<string, ActivityEvent[]>,
  limit: number,
): RuntimeLogEntry[] {
  const entries: RuntimeLogEntry[] = [];
  for (const promptId of promptOrder) {
    const events = transcripts.get(promptId);
    if (!events) continue;
    for (const evt of events) {
      switch (evt.type) {
        case "tool_call":
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: classifyToolCall(evt.tool, evt.summary),
            label: evt.tool,
            detail: evt.summary.trim() || null,
            status: evt.toolStatus ?? null,
          });
          break;
        case "patch":
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: "edit",
            label: "patch",
            detail: evt.files.join(", ") || null,
            status: "completed",
          });
          break;
        case "retry_status":
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: "retry",
            label: "retry",
            detail: evt.message.trim() || null,
            status: "running",
          });
          break;
        case "agent_progress":
          // The STEP kind tag is the category; a second "progress" badge on
          // every row said nothing, so the entry is tag + detail only.
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: "step",
            label: null,
            detail: evt.label.trim() || null,
            status: evt.terminal ? "completed" : "running",
          });
          break;
        case "session_resumed_cold":
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: "step",
            label: "resume",
            detail: evt.reason?.trim() || "resumed cold",
            status: "completed",
          });
          break;
        case "agent_timeline": {
          const copy = timelineEntryCopy(evt.eventType, evt.metadata);
          if (!copy) break;
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: copy.kind,
            label: copy.label,
            detail: evt.summary.trim() || null,
            status: timelineStatus(evt.status),
          });
          break;
        }
        case "session_error":
          entries.push({
            id: `${promptId}:${evt.id}`,
            kind: "error",
            label: "error",
            detail: evt.error.trim() || null,
            status: "error",
          });
          break;
      }
    }
  }
  return entries.slice(-limit).reverse();
}
