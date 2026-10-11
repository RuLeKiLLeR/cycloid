import type { ExecutionVerification } from "../../../../shared/types/sandbox.js";
import type {
  SessionDebugBottleneckPhase,
  SessionDebugErrorDetails,
  SessionDebugPromptSummary,
  SessionDebugSummaryResponse,
} from "../../../../shared/types/session-debug.js";
import type { SessionViewOutcome } from "../../../../shared/types/session-view.js";
import { getSessionExportData, getSessionState, getSessionView } from "../session/state";
import type { Env, SessionState } from "../types";
import { deriveSessionViewOutcome } from "./session-view";

type PromptRunRow = {
  prompt_id: string;
  outcome: string | null;
  error_code: string | null;
  error_details_json: string | null;
  dd_trace_id: string | null;
  bt_span_id: string | null;
};

type ExportPrompt = {
  id: string;
  status?: string;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

type ExportEvent = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

type DebugExportData = {
  prompts: ExportPrompt[];
  events: ExportEvent[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function diffMs(start: number | null, end: number | null): number | null {
  if (start == null || end == null) return null;
  return Math.max(0, end - start);
}

const REDACTED_TEXT = "[redacted]";

const SENSITIVE_TEXT_PATTERNS = [
  /\b(?:api[_-]?key|authorization|bearer|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\b/i,
  /\b(?:SQLITE|D1|database|constraint failed|prepare statement|sql error)\b/i,
  /(?:^|\s)at\s+[^\n]+:\d+:\d+/,
  /(?:\/(?:app|home|tmp|Users|var|workspace|root|mnt|etc)\/|[A-Za-z]:\\)[^\s'")]+/,
];

function sanitizeDebugString(value: string | null): { value: string | null; redacted: boolean } {
  if (!value) return { value: null, redacted: false };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, redacted: false };
  if (SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { value: REDACTED_TEXT, redacted: true };
  }
  return { value: trimmed.slice(0, 500), redacted: trimmed.length > 500 };
}

function sanitizeDebugStringArray(value: unknown): { values: string[]; redacted: boolean } {
  if (!Array.isArray(value)) return { values: [], redacted: false };
  let redacted = false;
  const values: string[] = [];
  for (const item of value) {
    const sanitized = sanitizeDebugString(asString(item));
    if (sanitized.redacted) redacted = true;
    if (sanitized.value) values.push(sanitized.value);
  }
  return { values, redacted };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeErrorDetailsRecord(value: Record<string, unknown>, depth = 0): SessionDebugErrorDetails {
  let redacted = false;
  const output: SessionDebugErrorDetails = { redacted: false };

  for (const key of ["message", "name", "code", "syscall", "hostname", "address", "providerID"] as const) {
    const sanitized = sanitizeDebugString(asString(value[key]));
    if (sanitized.redacted) redacted = true;
    if (sanitized.value) output[key] = sanitized.value;
  }

  const errno = asNumber(value.errno);
  if (errno != null) {
    output.errno = String(errno);
  } else {
    const sanitizedErrno = sanitizeDebugString(asString(value.errno));
    if (sanitizedErrno.redacted) redacted = true;
    if (sanitizedErrno.value) output.errno = sanitizedErrno.value;
  }

  const port = asNumber(value.port);
  if (port != null) output.port = port;
  const statusCode = asNumber(value.statusCode);
  if (statusCode != null) output.statusCode = statusCode;
  const isRetryable = asBoolean(value.isRetryable);
  if (isRetryable != null) output.isRetryable = isRetryable;

  if (depth < 2 && isRecord(value.cause)) {
    output.cause = sanitizeErrorDetailsRecord(value.cause, depth + 1);
    if (output.cause.redacted) redacted = true;
  } else if (value.cause !== undefined) {
    redacted = true;
  }

  if (value.stack !== undefined || value.raw !== undefined || value.responseBodyPreview !== undefined) redacted = true;
  output.redacted = redacted;
  return output;
}

function sanitizeErrorDetailsJson(value: string | null): SessionDebugErrorDetails | null {
  const record = parseJsonRecord(value);
  return record ? sanitizeErrorDetailsRecord(record) : null;
}

function sanitizeVerificationDetails(verification: ExecutionVerification | null | undefined): {
  verdict: string | null;
  verified: boolean | null;
  status: string | null;
  publishMode: string | null;
  details: {
    explanation: string | null;
    manualReviewReason: string | null;
    caveats: string[];
  };
} {
  const explanation = sanitizeDebugString(verification?.explanation ?? null).value;
  const manualReviewReason = sanitizeDebugString(verification?.manualReviewReason ?? null).value;
  const caveats = sanitizeDebugStringArray(verification?.caveats).values;
  return {
    verdict: verification?.verdict ?? null,
    verified: verification?.verified ?? null,
    status: verification?.status ?? null,
    publishMode: verification?.publishMode ?? null,
    details: {
      explanation,
      manualReviewReason,
      caveats,
    },
  };
}

function summarizeTaskOutcome(outcome: SessionViewOutcome | null | undefined): {
  outcome: string | null;
  badSessionReason: string | null;
} {
  return {
    outcome: outcome?.state ?? null,
    badSessionReason: outcome?.tone === "error" ? sanitizeDebugString(outcome.detail ?? outcome.title).value : null,
  };
}

const PRE_BRIDGE_ERROR_CODES = new Set([
  "spawn_timeout",
  "spawn_modal_error",
  "spawn_provider_error",
  "spawn_deadline_no_object",
  "spawn_deadline_no_bridge",
  "spawn_preconnect",
  "sandbox_terminated",
  "sandbox_disconnected",
  "codex_startup_timeout",
  "codex_api_readiness_timeout",
  "codex_session_create_timeout",
  "codex_not_ready",
  "codex_transport_closed",
  "codex_unrecoverable",
]);

function deriveBtSpanMissingReason(promptRun: PromptRunRow | null): string | null {
  if (!promptRun || promptRun.bt_span_id) return null;
  if (promptRun.error_code && PRE_BRIDGE_ERROR_CODES.has(promptRun.error_code)) return "pre_bridge_failure";
  return null;
}

function normalizeExportPrompt(value: unknown): ExportPrompt | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    status: asString(value.status) ?? undefined,
    createdAt: asString(value.createdAt) ?? undefined,
    startedAt: asString(value.startedAt),
    completedAt: asString(value.completedAt),
  };
}

function normalizeExportEvent(value: unknown): ExportEvent | null {
  if (!isRecord(value)) return null;
  const type = asString(value.type);
  if (!type) return null;
  return {
    type,
    timestamp: asString(value.timestamp) ?? undefined,
    data: isRecord(value.data) ? value.data : undefined,
  };
}

function parseDebugExportData(value: unknown): DebugExportData {
  const record = isRecord(value) ? value : {};
  const prompts = Array.isArray(record.prompts) ? record.prompts.map(normalizeExportPrompt).filter(Boolean) : [];
  const events = Array.isArray(record.events) ? record.events.map(normalizeExportEvent).filter(Boolean) : [];
  return {
    prompts: prompts as ExportPrompt[],
    events: events as ExportEvent[],
  };
}

function getPromptIdForEvent(event: ExportEvent): string | null {
  return asString(event.data?.promptId);
}

function getEventTimestampMs(event: ExportEvent): number | null {
  return toTimestampMs(event.timestamp);
}

function findFirstEventTimestamp(events: ExportEvent[], predicate: (event: ExportEvent) => boolean): number | null {
  for (const event of events) {
    if (!predicate(event)) continue;
    const ts = getEventTimestampMs(event);
    if (ts != null) return ts;
  }
  return null;
}

function summarizeTools(events: ExportEvent[]): {
  totalCalls: number;
  failedCalls: number;
  byTool: Record<string, number>;
  firstToolCallAt: string | null;
} {
  const byTool: Record<string, number> = {};
  let failedCalls = 0;
  let firstToolCallAt: string | null = null;
  const seenToolCallIds = new Set<string>();
  const failedToolCallIds = new Set<string>();
  let countedAnonymousFailure = false;

  for (const event of events) {
    if (event.type === "tool_call") {
      const id = asString(event.data?.id);
      if (id) {
        if (seenToolCallIds.has(id)) continue;
        seenToolCallIds.add(id);
      }
      const tool = asString(event.data?.tool) ?? "unknown";
      byTool[tool] = (byTool[tool] ?? 0) + 1;
      if (!firstToolCallAt && event.timestamp) firstToolCallAt = event.timestamp;
      continue;
    }
    if (event.type === "tool_update" && asString(event.data?.status) === "error") {
      const id = asString(event.data?.id);
      if (id) {
        if (failedToolCallIds.has(id)) continue;
        failedToolCallIds.add(id);
      } else if (countedAnonymousFailure) {
        continue;
      } else {
        countedAnonymousFailure = true;
      }
      failedCalls += 1;
    }
  }

  return {
    totalCalls: Array.from(Object.values(byTool)).reduce((sum, count) => sum + count, 0),
    failedCalls,
    byTool,
    firstToolCallAt,
  };
}

function deriveBottleneck(
  timings: SessionDebugPromptSummary["timings"],
  toolSummary: SessionDebugPromptSummary["toolSummary"],
): { bottleneckPhase: SessionDebugBottleneckPhase; bottleneckDurationMs: number | null; notes: string[] } {
  const candidates: Array<{ phase: SessionDebugBottleneckPhase; duration: number | null; note: string }> = [
    { phase: "queue", duration: timings.queueMs, note: "Queue delay was the largest pre-execution phase." },
    { phase: "spawn", duration: timings.spawnMs, note: "Sandbox startup dominated the wait before work began." },
    {
      phase: "workspace_setup",
      duration: timings.workspaceSetupMs,
      note: "Workspace setup dominated the time to first token.",
    },
    {
      phase: "context_prep",
      duration: timings.contextPrepMs,
      note: "Context assembly and prompt preparation dominated the startup time.",
    },
    {
      phase: "model_wait",
      duration: timings.modelWaitMs,
      note: "The model wait after dispatch dominated the time to first token.",
    },
  ];

  const selected = candidates.reduce<(typeof candidates)[number] | null>(
    (max, candidate) =>
      candidate.duration != null && (!max || candidate.duration > (max.duration ?? -1)) ? candidate : max,
    null,
  );

  const notes: string[] = [];
  if (selected) {
    notes.push(selected.note);
  } else {
    notes.push("No dominant phase could be derived from the available prompt timeline.");
  }

  if (toolSummary.failedCalls > 0) {
    notes.push(`Observed ${toolSummary.failedCalls} failed tool call update(s) during the prompt.`);
  }
  if (toolSummary.totalCalls === 0) {
    notes.push("The prompt reached completion without issuing any tool calls.");
  }

  return {
    bottleneckPhase: selected?.phase ?? "unknown",
    bottleneckDurationMs: selected?.duration ?? null,
    notes,
  };
}

export function derivePromptDebugSummary(
  prompt: ExportPrompt,
  promptEvents: ExportEvent[],
  promptRun: PromptRunRow | null,
): SessionDebugPromptSummary {
  const createdAtMs = toTimestampMs(prompt.createdAt);
  const startedAtMs = toTimestampMs(prompt.startedAt);
  const completedAtMs = toTimestampMs(prompt.completedAt);

  const queueStartMs =
    findFirstEventTimestamp(promptEvents, (event) => event.type === "prompt_enqueued") ?? createdAtMs ?? null;
  const queueEndMs =
    findFirstEventTimestamp(promptEvents, (event) => event.type === "prompt_processing") ?? startedAtMs ?? null;
  const sandboxReadyMs = findFirstEventTimestamp(promptEvents, (event) => event.type === "sandbox_runtime_info");
  const workspaceSetupStartMs = findFirstEventTimestamp(
    promptEvents,
    (event) => event.type === "prompt_activity" && asString(event.data?.detail) === "workspace_setup",
  );
  const workspaceSetupEndMs = findFirstEventTimestamp(
    promptEvents,
    (event) => event.type === "prompt_activity" && asString(event.data?.detail) === "workspace_setup_complete",
  );
  const dispatchMs = findFirstEventTimestamp(
    promptEvents,
    (event) => event.type === "prompt_activity" && asString(event.data?.phase) === "prompt_dispatching",
  );
  const waitingForModelMs = findFirstEventTimestamp(
    promptEvents,
    (event) => event.type === "agent_progress" && asString(event.data?.step) === "waiting_for_model",
  );
  const firstTextEvent = promptEvents.find((event) => event.type === "text");
  const firstTextMs = firstTextEvent ? getEventTimestampMs(firstTextEvent) : null;

  const toolSummary = summarizeTools(promptEvents);
  const timings = {
    queueMs: diffMs(queueStartMs, queueEndMs),
    spawnMs: diffMs(queueEndMs ?? queueStartMs, sandboxReadyMs),
    workspaceSetupMs: diffMs(workspaceSetupStartMs, workspaceSetupEndMs),
    contextPrepMs: diffMs(workspaceSetupEndMs, dispatchMs),
    modelWaitMs: diffMs(waitingForModelMs ?? dispatchMs, firstTextMs),
    firstTokenMs: diffMs(queueStartMs, firstTextMs),
    totalMs: diffMs(createdAtMs, completedAtMs),
  };

  return {
    promptId: prompt.id,
    status: prompt.status ?? "unknown",
    createdAt: prompt.createdAt ?? null,
    startedAt: prompt.startedAt ?? null,
    completedAt: prompt.completedAt ?? null,
    outcome: promptRun?.outcome ?? null,
    errorCode: promptRun?.error_code ?? null,
    errorDetails: sanitizeErrorDetailsJson(promptRun?.error_details_json ?? null),
    firstTokenAt: firstTextEvent?.timestamp ?? null,
    firstToolCallAt: toolSummary.firstToolCallAt,
    timings,
    toolSummary: {
      totalCalls: toolSummary.totalCalls,
      failedCalls: toolSummary.failedCalls,
      byTool: toolSummary.byTool,
    },
    traces: {
      ddTraceId: promptRun?.dd_trace_id ?? null,
      btSpanId: promptRun?.bt_span_id ?? null,
      btSpanMissingReason: deriveBtSpanMissingReason(promptRun),
    },
    diagnosis: deriveBottleneck(timings, {
      totalCalls: toolSummary.totalCalls,
      failedCalls: toolSummary.failedCalls,
      byTool: toolSummary.byTool,
    }),
  };
}

async function getPromptRunsForSession(db: D1Database, sessionId: string, limit: number): Promise<PromptRunRow[]> {
  const result = await db
    .prepare(
      `SELECT prompt_id, outcome, error_code, error_details_json, dd_trace_id, bt_span_id
       FROM (
         SELECT prompt_id, outcome, error_code, error_details_json, dd_trace_id, bt_span_id, created_at
         FROM prompt_runs
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       )
       ORDER BY created_at ASC`,
    )
    .bind(sessionId, limit)
    .all<PromptRunRow>();
  return (result.results ?? []) as PromptRunRow[];
}

export async function buildSessionDebugSummary(
  env: Env,
  sessionId: string,
  requestId: string | null,
  session: SessionState | null,
  promptRunsLimit: number,
): Promise<SessionDebugSummaryResponse | null> {
  const sessionState = session ?? (await getSessionState(env, sessionId, requestId));
  if (!sessionState) return null;
  if (!env.DB) {
    throw new Error("Database not configured");
  }

  const [exportDataRaw, promptRuns, viewResult] = await Promise.all([
    getSessionExportData(env, sessionId, requestId),
    getPromptRunsForSession(env.DB, sessionId, promptRunsLimit),
    getSessionView(env, sessionId, requestId),
  ]);
  const exportData = parseDebugExportData(exportDataRaw);
  const promptRunById = new Map(promptRuns.map((row) => [row.prompt_id, row]));
  const sessionView = viewResult.ok ? viewResult.payload?.session : null;
  const sessionViewOutcome =
    sessionView && viewResult.ok ? deriveSessionViewOutcome(sessionView, viewResult.payload?.prompts ?? []) : null;
  const publishError = sanitizeDebugString(sessionView?.publishError ?? null).value;
  const prManualReviewReason = sanitizeDebugString(sessionView?.prManualReviewReason ?? null).value;
  const promptEventsById = new Map<string, ExportEvent[]>();

  for (const event of exportData.events) {
    const promptId = getPromptIdForEvent(event);
    if (!promptId) continue;
    const promptEvents = promptEventsById.get(promptId);
    if (promptEvents) {
      promptEvents.push(event);
    } else {
      promptEventsById.set(promptId, [event]);
    }
  }

  const prompts = exportData.prompts.map((prompt) => {
    const promptEvents = promptEventsById.get(prompt.id) ?? [];
    return derivePromptDebugSummary(prompt, promptEvents, promptRunById.get(prompt.id) ?? null);
  });

  return {
    ok: true,
    session: {
      sessionId: sessionState.sessionId,
      status: sessionState.status,
      businessId: sessionState.businessId ?? null,
      ownerUserId: sessionState.ownerUserId,
      repoUrl:
        sessionState.repoOwner && sessionState.repoName
          ? `https://github.com/${sessionState.repoOwner}/${sessionState.repoName}`
          : null,
      model: sessionState.model ?? null,
      createdAt: sessionState.createdAt,
      updatedAt: sessionState.updatedAt,
      spawnDurationMs: sessionView?.spawnDurationMs ?? null,
      sandboxStatus: sessionView?.sandboxStatus ?? null,
      publish: {
        status: sessionView?.publishStatus ?? null,
        stage: sessionView?.publishStage ?? null,
        error: publishError,
      },
      pullRequest: {
        url: sessionView?.prUrl ?? null,
        state: sessionView?.prUrl ? (sessionView.prDraft ? "draft" : "ready_for_review") : null,
        manualReviewReason: prManualReviewReason,
      },
      verification: sanitizeVerificationDetails(sessionView?.verification),
      taskOutcome: summarizeTaskOutcome(sessionViewOutcome),
      runtimeProvenance: {
        provider: sessionView?.runtimeProvenance?.runtime?.provider ?? null,
        sandboxId: sessionView?.runtimeProvenance?.runtime?.sandboxId ?? null,
        templateId: sessionView?.runtimeProvenance?.runtime?.templateId ?? null,
        bootMode: sessionView?.runtimeProvenance?.bootMode ?? null,
        sandboxImageVersion: sessionView?.runtimeProvenance?.sandboxImageVersion ?? null,
      },
    },
    prompts,
  };
}
