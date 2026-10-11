import { createHash } from "node:crypto";

import {
  MAX_CHILD_SESSION_SPAWN_DEPTH,
  MAX_CHILD_SESSIONS_PER_PROMPT,
  SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
  SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
  SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN,
  SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE,
} from "../../../../shared/constants/session.js";
import { SPAWN_CHILD_SESSION_TIMEOUT_MS } from "../constants/bridge.js";
import { ddLog } from "./dd-logs.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import { DYNAMIC_TOOL_ERROR_CODES } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "./memory-dynamic-tool.js";

export const SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME = "spawn_child_session";

const REASONING_EFFORTS = ["low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type SpawnChildSessionInput = {
  prompt: string;
  repositoryId: string;
  title?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

type ChildSessionApiSuccess = {
  ok: true;
  childSessionId: string;
  childSessionUrl: string;
  parentSessionId: string;
  parentPromptId?: string | null;
  spawnDepth?: number;
};

type ChildSessionApiError = {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export function buildSpawnChildSessionIdempotencyKey(input: SpawnChildSessionInput): string {
  return createHash("sha256")
    .update(input.prompt)
    .update("\n")
    .update(input.repositoryId)
    .update("\n")
    .update(input.title ?? "")
    .update("\n")
    .update(input.model ?? "")
    .update("\n")
    .update(input.reasoningEffort ?? "")
    .digest("hex");
}

function success(text: string): FirstPartyDynamicToolCallResult {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}

function failure(errorCode: DynamicToolErrorCode, text: string): FirstPartyDynamicToolCallResult {
  return { success: false, errorCode, contentItems: [{ type: "inputText", text }] };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeInput(args: unknown): SpawnChildSessionInput | { invalid: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { invalid: "cycloid.spawn_child_session requires an object input." };
  }
  const raw = args as Record<string, unknown>;
  const prompt = stringField(raw.prompt);
  const repositoryId = stringField(raw.repositoryId);
  if (!prompt) return { invalid: "prompt is required." };
  if (prompt.length > SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH)
    return { invalid: `prompt must not exceed ${SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH} characters.` };
  if (!repositoryId) return { invalid: "repositoryId is required." };
  if (!SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN.test(repositoryId)) {
    return { invalid: "repositoryId must be in 'owner/repo' format." };
  }
  const title = stringField(raw.title) ?? undefined;
  if (title && title.length > SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH) {
    return { invalid: `title must not exceed ${SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH} characters.` };
  }
  const model = stringField(raw.model) ?? undefined;
  const reasoningRaw = stringField(raw.reasoningEffort);
  const reasoningEffort =
    reasoningRaw && (REASONING_EFFORTS as readonly string[]).includes(reasoningRaw)
      ? (reasoningRaw as ReasoningEffort)
      : undefined;
  return {
    prompt,
    repositoryId,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function isCancellation(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function isTimeout(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "TimeoutError";
}

function errorCodeForStatus(status: number, apiCode: string | null): DynamicToolErrorCode {
  if (apiCode) {
    switch (apiCode) {
      case "missing_field":
      case "invalid_input":
      case "invalid_repo":
      case "invalid_model":
      case "cross_repo_not_supported":
        return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
      case "unauthorized_repo":
      case "integration_gating_failed":
        return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
      case "depth_limit_exceeded":
      case "max_children_per_prompt":
      case "max_children_per_session":
      case "concurrent_limit_exceeded":
        return DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED;
      case "parent_not_found":
      case "not_found":
        return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
      case "internal_error":
        return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
    }
  }
  if (status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (status === 401 || status === 403) return DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN;
  if (status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (status === 409) return DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED;
  if (status === 429 || status === 503) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

function recordSpawnChildSessionToolOutcome(
  context: FirstPartyDynamicToolExecuteContext,
  outcome: string,
  startedAt: number,
  fields: Record<string, unknown> = {},
): void {
  try {
    ddLog({
      event: "spawn_child_session.create",
      surface: "bridge",
      outcome,
      duration_ms: Math.max(0, Date.now() - startedAt),
      parentSessionConfigured: Boolean(context.env.SESSION_ID?.trim()),
      ...fields,
    });
  } catch {
    // Tool outcome telemetry is best-effort and must never affect the tool call.
  }
}

export function buildSpawnChildSessionDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME,
      description: `Spawn a child Cycloid session under the current parent session. The child runs an independent prompt against the same parent business and inherits the parent's runtime backend. Call once per child you want to launch; the parent agent must orchestrate fan-out by issuing the tool repeatedly. Hard caps: at most ${MAX_CHILD_SESSIONS_PER_PROMPT} children per parent prompt and max child depth ${MAX_CHILD_SESSION_SPAWN_DEPTH}. Identical-content spawns under one parent session dedupe to the same child; differentiate prompts for distinct work. Returns the child session id and URL. Use this whenever the user asks to 'kick off N sessions', 'fan out', or 'run subtasks in parallel'; do not narrate fake child sessions.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
            description: "The full prompt the child session should run.",
          },
          repositoryId: {
            type: "string",
            pattern: SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE,
            description:
              "Repository for the child session in 'owner/repo' format. Must match the parent's repo; cross-repo children are not supported.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
            description: "Optional human-readable title for the child session.",
          },
          model: {
            type: "string",
            description: "Optional model override; defaults to the parent's model when omitted.",
          },
          reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["prompt", "repositoryId"],
      },
    },
  ];
}

export async function executeSpawnChildSessionDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const startedAt = Date.now();
  const normalized = normalizeInput(args);
  if ("invalid" in normalized) {
    recordSpawnChildSessionToolOutcome(context, "invalid_input", startedAt, { errorCode: "invalid_input" });
    return failure("invalid_input", `cycloid.spawn_child_session: ${normalized.invalid}`);
  }

  const controlPlaneUrl = normalizeControlPlaneUrl(context.env.CONTROL_PLANE_URL ?? context.env.ARCANIST_API_URL);
  const parentSessionId = context.env.SESSION_ID?.trim();
  const sandboxAuthToken = context.env.SANDBOX_AUTH_TOKEN?.trim();

  if (!controlPlaneUrl || !parentSessionId || !sandboxAuthToken) {
    recordSpawnChildSessionToolOutcome(context, "not_connected", startedAt, { errorCode: "not_connected" });
    return failure(
      "not_connected",
      "Child-session creation is not configured for this session (missing control plane URL, session id, or sandbox auth token).",
    );
  }

  const overallSignal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(SPAWN_CHILD_SESSION_TIMEOUT_MS)])
    : AbortSignal.timeout(SPAWN_CHILD_SESSION_TIMEOUT_MS);

  try {
    const fetchImpl = context.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(parentSessionId)}/sandbox/child-sessions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
          "Idempotency-Key": buildSpawnChildSessionIdempotencyKey(normalized),
        },
        body: JSON.stringify({
          prompt: normalized.prompt,
          repositoryId: normalized.repositoryId,
          ...(normalized.title ? { title: normalized.title } : {}),
          ...(normalized.model ? { model: normalized.model } : {}),
          ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
        }),
        signal: overallSignal,
      },
    );

    const rawBody = await response.text();
    let parsed: ChildSessionApiSuccess | ChildSessionApiError | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as ChildSessionApiSuccess | ChildSessionApiError) : null;
    } catch {
      parsed = null;
    }

    if (response.ok && parsed && parsed.ok === true) {
      recordSpawnChildSessionToolOutcome(context, "success", startedAt);
      return success(
        JSON.stringify({
          ok: true,
          childSessionId: parsed.childSessionId,
          childSessionUrl: parsed.childSessionUrl,
          parentSessionId: parsed.parentSessionId,
          parentPromptId: parsed.parentPromptId ?? null,
          spawnDepth: typeof parsed.spawnDepth === "number" ? parsed.spawnDepth : null,
        }),
      );
    }

    const apiCode = parsed && parsed.ok === false && typeof parsed.error?.code === "string" ? parsed.error.code : null;
    const apiMessage =
      parsed && parsed.ok === false && typeof parsed.error?.message === "string" ? parsed.error.message : null;
    const errorCode = errorCodeForStatus(response.status, apiCode);
    recordSpawnChildSessionToolOutcome(context, errorCode, startedAt, {
      errorCode,
      apiCode,
      httpStatus: response.status,
      phase: "child_session_create",
    });
    return failure(errorCode, apiMessage ?? `Child-session creation failed with HTTP ${response.status}.`);
  } catch (error) {
    if (isCancellation(error)) {
      recordSpawnChildSessionToolOutcome(context, "cancelled", startedAt, { errorCode: "cancelled" });
      return failure("cancelled", "Child-session creation was cancelled.");
    }
    if (isTimeout(error)) {
      recordSpawnChildSessionToolOutcome(context, "timed_out", startedAt, { errorCode: "timed_out" });
      return failure("timed_out", `Child-session creation timed out after ${SPAWN_CHILD_SESSION_TIMEOUT_MS}ms.`);
    }
    recordSpawnChildSessionToolOutcome(context, "upstream_error", startedAt, { errorCode: "upstream_error" });
    return failure("upstream_error", `Child-session creation request failed: ${String(error)}`);
  }
}
