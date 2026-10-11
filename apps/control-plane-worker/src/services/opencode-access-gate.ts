import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import type { SessionEntrypoint } from "../enums/session-entrypoint";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "opencode-access-gate" } });

export const OPENCODE_ACCESS_DENIED_ERROR = "opencode_access_denied";

export class OpencodeAccessDeniedError extends Error {
  readonly businessId: string | null;
  readonly sessionId: string | null;

  constructor(input: { businessId: string | null; sessionId?: string | null }) {
    super("opencode is only available to Cycloid team members");
    this.name = "OpencodeAccessDeniedError";
    this.businessId = input.businessId;
    this.sessionId = input.sessionId ?? null;
  }
}

export function isOpencodeAccessDeniedError(error: unknown): boolean {
  if (error instanceof OpencodeAccessDeniedError) return true;
  if (error instanceof Error && error.name === "OpencodeAccessDeniedError") return true;
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? (error as { cause?: unknown }).cause : null;
  return cause ? isOpencodeAccessDeniedError(cause) : false;
}

export function canBusinessUseOpencode(input: {
  agentRuntimeBackend: AgentRuntimeBackend;
  businessId: string | null | undefined;
}): boolean {
  if (input.agentRuntimeBackend !== OPENCODE_AGENT_RUNTIME_BACKEND) return true;
  return isInternalCycloidBusinessId(input.businessId ?? "");
}

export async function assertBusinessCanUseOpencode(
  env: Env,
  input: {
    agentRuntimeBackend: AgentRuntimeBackend;
    businessId: string | null;
    sessionId?: string | null;
    ownerUserId?: string | null;
    entrypoint?: SessionEntrypoint | "spawn" | null;
  },
): Promise<void> {
  if (canBusinessUseOpencode(input)) return;

  const event = {
    event: "session_create.opencode_access_denied",
    action: "session_create.opencode_access_denied",
    backend: input.agentRuntimeBackend,
    businessId: input.businessId,
    sessionId: input.sessionId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    entrypoint: input.entrypoint ?? null,
  };
  log.warn(event, "opencode access denied for non-internal business");
  await postStructuredEventToDd(env, event);
  throw new OpencodeAccessDeniedError({ businessId: input.businessId, sessionId: input.sessionId });
}
