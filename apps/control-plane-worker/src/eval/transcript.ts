import type { FinalizingStep, Phase, SandboxSubstate, StopMode } from "../../../../shared/session/phase.js";
import { type ActivityEvent, flattenSessionEvents } from "../../../../shared/transcript/projector.js";
import { EVAL_TRANSCRIPT_MAX_BYTES } from "../constants/eval";

interface ExportPrompt {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface ExportEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface ExportData {
  session: {
    id: string;
    status: string;
    // Canonical phase contract (`shared/session/phase.ts`). Null for non-repo
    // sessions; consumers should display `status` in that case.
    phase?: Phase | null;
    sandboxSubstate?: SandboxSubstate;
    stopMode?: StopMode;
    finalizingStep?: FinalizingStep;
    repoUrl: string | null;
    createdAt: string;
    closedAt: string | null;
  };
  prompts: ExportPrompt[];
  events: ExportEvent[];
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  stats: {
    totalPrompts: number;
    successCount: number;
    failCount: number;
    totalToolCalls: number;
    totalDurationMs: number;
  };
}

function formatLifecycleLabel(session: ExportData["session"]): string {
  if (!session.phase) return session.status;
  const substate: string[] = [];
  if (session.sandboxSubstate && session.sandboxSubstate !== "none") substate.push(session.sandboxSubstate);
  if (session.stopMode && session.stopMode !== "none") substate.push(session.stopMode);
  if (session.finalizingStep && session.finalizingStep !== "none") substate.push(session.finalizingStep);
  return substate.length > 0 ? `${session.phase}/${substate.join("/")}` : session.phase;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function buildToolSummaryTable(activity: ActivityEvent[]): string {
  const counts: Record<string, number> = {};
  for (const event of activity) {
    if (event.type !== "tool_call") continue;
    const tool = event.tool || "unknown";
    counts[tool] = (counts[tool] || 0) + 1;
  }

  if (Object.keys(counts).length === 0) return "*No tool calls recorded.*";

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const lines = ["| Tool | Count |", "|------|-------|"];
  for (const [tool, count] of sorted) {
    lines.push(`| ${tool} | ${count} |`);
  }
  return lines.join("\n");
}

function buildTimeline(events: ExportEvent[]): string {
  const timelineTypes = new Set([
    "tool_call",
    "question",
    "prompt_processing",
    "prompt_completed",
    "prompt_failed",
    "publish.pr.created",
    "pr_created",
    "session_error",
    "memory_usage",
    "memory_recall_usage",
  ]);
  const relevant = events.filter((e) => timelineTypes.has(e.type));

  if (relevant.length === 0) return "*No events recorded.*";

  const lines = relevant.map((event, i) => {
    const data = event.data;
    let description: string;

    switch (event.type) {
      case "tool_call":
        description = `**${data.tool || "unknown"}** ${(data.summary as string) || ""}`;
        break;
      case "question":
        description = `**Question asked**: ${(data.question as string)?.slice(0, 200) || ""}`;
        break;
      case "prompt_processing":
        description = `**Prompt started** (${data.promptId || ""})`;
        break;
      case "prompt_completed":
        description = `**Prompt completed** (${data.promptId || ""})`;
        break;
      case "prompt_failed":
        description = `**Prompt failed** (${data.promptId || ""}): ${data.error || "unknown error"}`;
        break;
      case "publish.pr.created":
      case "pr_created":
        description = `**PR created**: ${data.prUrl || ""}`;
        break;
      case "session_error":
        description = `**Error**: ${data.error || "unknown"}`;
        break;
      case "memory_usage":
        description = formatMemoryUsageDescription(data);
        break;
      case "memory_recall_usage":
        description = formatMemoryRecallDescription(data);
        break;
      default:
        description = event.type;
    }

    return `${i + 1}. ${description}`;
  });
  return lines.join("\n");
}

function formatMemoryUsageDescription(data: Record<string, unknown>): string {
  const memories = formatMemoryRefs(data.activeMemories, data.activeMemoryIds);
  const trace = formatMemoryRetrievalTrace(data.retrievalTrace);
  return memories ? `**Memories used**: ${memories}${trace}` : `**Memories used**${trace}`;
}

function formatMemoryRecallDescription(data: Record<string, unknown>): string {
  const returned = formatMemoryRefs(data.returnedMemories, data.returnedMemoryIds);
  const intent = typeof data.intent === "string" && data.intent.trim() ? ` (${data.intent.trim()})` : "";
  const trace = formatMemoryRetrievalTrace(data.retrievalTrace);
  return returned
    ? `**Memory recall**${intent}: ${returned}${trace}`
    : `**Memory recall**${intent}: 0 memories${trace}`;
}

function formatMemoryRetrievalTrace(rawTrace: unknown): string {
  if (!rawTrace || typeof rawTrace !== "object" || Array.isArray(rawTrace)) return "";
  const trace = rawTrace as Record<string, unknown>;
  const version = typeof trace.retrievalConfigVersion === "string" ? trace.retrievalConfigVersion : "unknown";
  const candidateCount = typeof trace.candidateCount === "number" ? trace.candidateCount : null;
  const selectedCount = typeof trace.selectedCount === "number" ? trace.selectedCount : null;
  const returnedEmpty = typeof trace.returnedEmpty === "boolean" ? trace.returnedEmpty : null;
  const rejected = Array.isArray(trace.rejectedCandidates)
    ? trace.rejectedCandidates
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => (typeof entry.rejectReason === "string" ? entry.rejectReason : "rejected"))
        .slice(0, 3)
    : [];
  const pieces = [
    `config=${version}`,
    candidateCount === null ? null : `candidates=${candidateCount}`,
    selectedCount === null ? null : `selected=${selectedCount}`,
    returnedEmpty === null ? null : `empty=${returnedEmpty}`,
    rejected.length > 0 ? `rejections=${[...new Set(rejected)].join(",")}` : null,
  ].filter((piece): piece is string => piece !== null);
  return pieces.length > 0 ? ` [trace: ${pieces.join("; ")}]` : "";
}

function formatMemoryRefs(rawRefs: unknown, rawIds: unknown): string {
  const refs = Array.isArray(rawRefs) ? rawRefs : [];
  const labels = refs
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const id = typeof entry.id === "string" ? entry.id : "";
      const title = typeof entry.title === "string" ? entry.title : id;
      const reason = typeof entry.reason === "string" && entry.reason.trim() ? ` — ${entry.reason.trim()}` : "";
      const effect =
        typeof entry.expectedEffect === "string" && entry.expectedEffect.trim()
          ? ` -> ${entry.expectedEffect.trim()}`
          : "";
      return title ? `${title}${reason}${effect}` : "";
    })
    .filter(Boolean);
  if (labels.length > 0) return labels.join("; ").slice(0, 1000);
  if (!Array.isArray(rawIds)) return "";
  return rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).join(", ");
}

export function buildSessionTranscript(exportData: ExportData): { transcript: string; sizeBytes: number } {
  const session = exportData.session;
  const prompts = exportData.prompts;
  const events = exportData.events;
  const activity = flattenSessionEvents(events);
  const tokens = exportData.tokens;
  const stats = exportData.stats;

  const sections: string[] = [];

  // Header
  sections.push("# Session Transcript");

  // Session info. Prefer canonical phase + substate over legacy status alias
  // for repo sessions. Non-repo sessions fall back to `status`.
  const lifecycleLabel = formatLifecycleLabel(session);
  sections.push(`## Session Info
- **Session ID**: ${session.id}
- **Repository**: ${session.repoUrl || "unknown"}
- **Created**: ${session.createdAt}
- **Duration**: ${formatDuration(stats.totalDurationMs)}
- **Status**: ${lifecycleLabel}`);

  // Prompts
  sections.push("## Prompts");
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const durationMs =
      p.startedAt && p.completedAt ? new Date(p.completedAt).getTime() - new Date(p.startedAt).getTime() : null;

    sections.push(`### Prompt ${i + 1}
> ${p.prompt.slice(0, 2000)}

- **Status**: ${p.status}${durationMs !== null ? `\n- **Duration**: ${formatDuration(durationMs)}` : ""}`);
  }

  // Tool usage summary
  // Eval transcript formatting stays app-specific, but durable event projection is shared.
  sections.push(`## Tool Usage Summary\n${buildToolSummaryTable(activity)}`);

  // Token usage
  sections.push(`## Token Usage
- **Input**: ${tokens.inputTokens.toLocaleString()}
- **Output**: ${tokens.outputTokens.toLocaleString()}
- **Total**: ${tokens.totalTokens.toLocaleString()}`);

  // Event timeline
  sections.push(`## Event Timeline\n${buildTimeline(events)}`);

  let transcript = sections.join("\n\n");
  let sizeBytes = new TextEncoder().encode(transcript).byteLength;

  // Truncate timeline if over limit
  if (sizeBytes > EVAL_TRANSCRIPT_MAX_BYTES) {
    const timelineHeader = "## Event Timeline\n";
    const timelineStart = transcript.indexOf(timelineHeader);
    if (timelineStart >= 0) {
      transcript = transcript.slice(0, timelineStart) + "## Event Timeline\n\n*Timeline truncated due to size.*";
      sizeBytes = new TextEncoder().encode(transcript).byteLength;
    }
  }

  return { transcript, sizeBytes };
}
