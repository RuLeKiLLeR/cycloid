import type { ServerMessage } from "./useSessionWebSocket";

const SERVER_MESSAGE_TYPES = {
  observability_readiness_updated: true,
  pong: true,
  pr_created: true,
  pr_failed: true,
  pr_updated: true,
  desktop_action_path_row: true,
  prompt_updated: true,
  replay_error: true,
  replay_event: true,
  replay_page: true,
  replay_truncated: true,
  runtime_provenance_updated: true,
  sandbox_error: true,
  sandbox_event: true,
  sandbox_ready: true,
  session_event: true,
  session_status: true,
  subscribed: true,
  verification_updated: true,
} satisfies Record<ServerMessage["type"], true>;

export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(data);
    if (!isKnownServerMessage(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isKnownServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || !isServerMessageType(value.type)) return false;

  switch (value.type) {
    case "subscribed":
      return (
        value.version === 2 &&
        isRecord(value.session) &&
        isRecord(value.sandbox) &&
        isRecord(value.queue) &&
        Array.isArray(value.prompts) &&
        isNumber(value.lastDurableSequence) &&
        isReplayPageShape(value.replay)
      );
    case "session_event":
    case "replay_event":
      return isReplayEventShape(value.event);
    case "replay_page":
      return isReplayPageShape(value);
    case "replay_error":
      return isString(value.message);
    case "replay_truncated":
      return (
        isNumber(value.requestedAfterSequence) &&
        isNumber(value.firstReturnedSequence) &&
        isNumber(value.lastReturnedSequence) &&
        isNumber(value.droppedCount)
      );
    case "sandbox_event":
      return isRecord(value.event);
    case "sandbox_ready":
      return isString(value.sandboxId) && isOptionalNumberOrNull(value.spawnDurationMs);
    case "sandbox_error":
      return isString(value.error);
    case "prompt_updated":
      return isRecord(value.prompt);
    case "desktop_action_path_row":
      return isRecord(value.row);
    case "session_status":
      // phaseFieldsFromInfo always emits all four phase fields (PhaseInfo guarantees
      // sentinel "none" values for sandboxSubstate / stopMode / finalizingStep when
      // not active). Require them so a future emitter that drops a field fails loudly
      // rather than silently as the legacy `status` field did pre-fix.
      return (
        isString(value.phase) &&
        isString(value.displayStatus) &&
        isString(value.sandboxSubstate) &&
        isString(value.stopMode) &&
        isString(value.finalizingStep) &&
        isOptionalBoolean(value.planApprovalPending) &&
        (value.planRevision === undefined || isNumber(value.planRevision)) &&
        isOptionalString(value.planStatus) &&
        isOptionalString(value.title)
      );
    case "pr_created":
    case "pr_updated":
      return (
        isString(value.prUrl) &&
        isNumber(value.prNumber) &&
        isString(value.branchName) &&
        isOptionalBoolean(value.draft) &&
        isOptionalString(value.manualReviewReason)
      );
    case "verification_updated":
      return value.verification === null || isRecord(value.verification);
    case "runtime_provenance_updated":
      return value.runtimeProvenance === null || isRecord(value.runtimeProvenance);
    case "observability_readiness_updated":
      return value.observabilityReadiness === null || isRecord(value.observabilityReadiness);
    case "pr_failed":
      return isString(value.error);
    case "pong":
      return true;
  }

  const exhaustive: never = value.type;
  return exhaustive;
}

export function isLivenessServerMessage(msg: ServerMessage): boolean {
  switch (msg.type) {
    case "subscribed":
    case "session_event":
    case "replay_event":
    case "replay_truncated":
    case "sandbox_ready":
    case "sandbox_error":
    case "prompt_updated":
    case "desktop_action_path_row":
    case "session_status":
    case "pr_created":
    case "pr_updated":
    case "verification_updated":
    case "runtime_provenance_updated":
    case "observability_readiness_updated":
    case "pr_failed":
      return true;
    case "replay_page":
      return msg.beforeSequence == null;
    case "replay_error":
    case "sandbox_event":
    case "pong":
      return false;
  }

  const exhaustive: never = msg;
  return exhaustive;
}

function isServerMessageType(type: unknown): type is ServerMessage["type"] {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(SERVER_MESSAGE_TYPES, type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReplayEventShape(value: unknown): boolean {
  return isRecord(value) && isString(value.type) && isNumber(value.sequence);
}

function isReplayPageShape(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return (
    isNumber(value.afterSequence) &&
    isOptionalNumberOrNull(value.beforeSequence) &&
    Array.isArray(value.events) &&
    value.events.every(isReplayEventShape) &&
    typeof value.hasMore === "boolean" &&
    isNumber(value.droppedCount) &&
    isNumberOrNull(value.firstSequence) &&
    isNumberOrNull(value.lastSequence)
  );
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isOptionalNumberOrNull(value: unknown): value is number | null | undefined {
  return value === undefined || isNumberOrNull(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}
