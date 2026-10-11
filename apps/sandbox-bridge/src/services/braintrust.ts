/**
 * Braintrust logging for LLM behavior analysis.
 * Ships through the control-plane telemetry broker: the SDK targets the broker
 * via `BRAINTRUST_API_URL`/`BRAINTRUST_APP_URL` (injected by the control plane)
 * and authenticates with the session token as its apiKey; the control plane
 * validates it and swaps in the platform BRAINTRUST_API_KEY before forwarding.
 * The platform key is no longer present in the sandbox. No-ops if the broker is
 * unreachable.
 */
import type { StartSpanArgs } from "braintrust";

import { normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { redact, truncate } from "../../../../shared/observability/redact.js";
import {
  BRAINTRUST_PROJECT,
  BT_DEFAULT_ENV,
  BT_MAX_TEXT_LENGTH,
  BT_MAX_TOOL_IO_LENGTH,
} from "../constants/observability.js";
import { hasRestorableAgentSession, parseSessionConfig } from "../utils/session-config.js";
import { resolveTelemetryBrokerEndpoint } from "./telemetry-broker.js";

type BtSpanType = StartSpanArgs["type"];

export interface BtSpan {
  id: string;
  log(data: Record<string, unknown>): void;
  startSpan(opts: { name: string; type?: BtSpanType; event?: Record<string, unknown> }): BtSpan;
  end(): void;
}

interface BtLogger {
  startSpan(opts: { name: string; type?: BtSpanType; event?: Record<string, unknown> }): BtSpan;
  log(data: Record<string, unknown>): void;
}

let logger: BtLogger | null = null;

const noopSpan: BtSpan & { startSpan(opts: Record<string, unknown>): BtSpan } = {
  id: "",
  log() {},
  end() {},
  startSpan() {
    return noopSpan;
  },
};

const noopLogger: BtLogger & { startSpan(opts: Record<string, unknown>): typeof noopSpan } = {
  startSpan() {
    return noopSpan;
  },
  log() {},
};

let btModule: typeof import("braintrust") | null = null;

/** Cached env-derived metadata (stable for sandbox lifetime). */
const sessionConfig = parseSessionConfig();
const envMeta = {
  userId: process.env.OWNER_USER_ID || undefined,
  userLogin: process.env.OWNER_LOGIN || undefined,
  businessId: process.env.BUSINESS_ID || undefined,
  provider: process.env.PROVIDER || undefined,
  branch: process.env.BRANCH || undefined,
  prebuiltImage: process.env.FROM_REPO_IMAGE === "true",
  isRestored: hasRestorableAgentSession(sessionConfig),
};

export async function initBraintrust(): Promise<void> {
  const broker = resolveTelemetryBrokerEndpoint();
  if (!broker) return;

  try {
    btModule = await import("braintrust");
    // The SDK reads BRAINTRUST_API_URL / BRAINTRUST_APP_URL from env (both
    // pointed at the broker by the control plane); `login` and `logs3` therefore
    // land on the broker, which swaps the session token for the platform key.
    logger = btModule.initLogger({
      projectName: BRAINTRUST_PROJECT,
      apiKey: broker.sandboxAuthToken,
    });
  } catch (err) {
    // Keep flushBraintrust a no-op when init failed; the cause is already logged here.
    btModule = null;
    // eslint-disable-next-line no-console
    console.error("[braintrust] Failed to initialize:", err);
  }
}

export async function flushBraintrust(): Promise<void> {
  if (!btModule) return;
  try {
    await btModule.flush();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[braintrust] flush failed:", err);
  }
}

export function getBtLogger(): BtLogger {
  return logger ?? noopLogger;
}

/** Shared metadata taxonomy for all Braintrust spans. */
export function btMetadata(ctx: {
  sessionId?: string;
  promptId?: string;
  sandboxId?: string;
  repo?: string;
  agent?: string;
  model?: string;
  source?: string;
  errorCode?: string;
  outcome?: string;
}): Record<string, unknown> {
  return {
    sessionId: ctx.sessionId,
    promptId: ctx.promptId,
    sandboxId: ctx.sandboxId,
    repo: ctx.repo,
    agent: ctx.agent,
    model: ctx.model,
    source: ctx.source,
    errorCode: ctx.errorCode,
    outcome: ctx.outcome,
    env: normalizeEnvironment(process.env.WORKER_ENV, BT_DEFAULT_ENV),
    ...envMeta,
  };
}

/**
 * Compute Braintrust scores from prompt outcome only.
 * Detailed behavior remains in Datadog-backed prompt logs and metadata.
 */
export function btScores(_signals: unknown, outcome: string): Record<string, number> {
  return { success: outcome === "success" ? 1 : 0 };
}

/**
 * Build Braintrust tags for the root prompt span.
 * Tags enable fast trace-level filtering in the Braintrust UI.
 */
export function btTags(ctx: { businessId?: string; agent?: string; outcome?: string; isRestored?: boolean }): string[] {
  const tags: string[] = [];
  if (ctx.businessId) tags.push(ctx.businessId);
  if (ctx.agent) tags.push(`agent:${ctx.agent}`);
  if (ctx.outcome) tags.push(ctx.outcome);
  if (ctx.isRestored) tags.push("restored");
  return tags;
}

/**
 * Build a structured output object for the Braintrust prompt span.
 * Richer than a bare outcome string; makes the BT UI more useful.
 *
 * `content.responseText` / `content.reasoningText` carry the assistant's final
 * message and accumulated thinking for the turn. Sanitized (redact + truncate)
 * HERE so no call site can forget; empty strings are omitted rather than
 * logged as noise.
 */
export function btStructuredOutput(
  outcome: string,
  signals?: {
    editCount: number;
    toolCallCount: number;
    questionCount: number;
  },
  content?: {
    responseText?: string;
    reasoningText?: string;
  },
): Record<string, unknown> {
  const output: Record<string, unknown> = { outcome };
  if (signals) {
    output.editCount = signals.editCount;
    output.toolCallCount = signals.toolCallCount;
    output.questionCount = signals.questionCount;
  }
  if (content?.responseText) {
    output.response = sanitizeText(content.responseText);
  }
  if (content?.reasoningText) {
    output.reasoning = sanitizeText(content.reasoningText);
  }
  return output;
}

/** Sanitize text for Braintrust logging. */
export function sanitizeText(text: string): string {
  return redact(truncate(text, BT_MAX_TEXT_LENGTH));
}

/** Sanitize tool IO for Braintrust logging. */
export function sanitizeToolIO(data: unknown): unknown {
  if (typeof data === "string") return redact(truncate(data, BT_MAX_TOOL_IO_LENGTH));
  if (data && typeof data === "object") {
    const str = JSON.stringify(data);
    if (str.length > BT_MAX_TOOL_IO_LENGTH) {
      return redact(truncate(str, BT_MAX_TOOL_IO_LENGTH));
    }
    const redacted = redact(str);
    try {
      return JSON.parse(redacted);
    } catch {
      return redacted;
    }
  }
  return data;
}

/** Serialize any tool result to text for length checks / attachment bodies. */
function toolOutputText(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    const str = JSON.stringify(data);
    return str === undefined ? String(data) : str;
  } catch {
    return String(data);
  }
}

/**
 * The COMPLETE tool output, redacted but NOT truncated — returned only when the result is large
 * enough that the inline preview ({@link sanitizeToolIO}) would truncate it (otherwise null: the
 * preview already carries the whole result, so a second copy is pointless). Secrets are masked
 * with the same {@link redact} pass as the preview; only the length cap is lifted, so the full
 * text stays available for later analysis without ever emitting a secret verbatim.
 */
export function fullRedactedToolOutput(output: unknown): string | null {
  const raw = toolOutputText(output);
  if (raw.length <= BT_MAX_TOOL_IO_LENGTH) return null;
  return redact(raw);
}

/**
 * The COMPLETE redacted tool output as a Braintrust `Attachment` (held in object storage, not the
 * span row) — returned only when the result exceeds the inline-preview cap, else null. This is the
 * "attach" half of "redact then attach": the caller keeps a redacted bounded preview on the span
 * `output` and nests THIS attachment under a recognized span field so the whole tool result stays
 * analyzable later without inflating per-span cost.
 *
 * IMPORTANT: nest the returned attachment inside a schema field (`metadata`/`output`) — Braintrust
 * silently drops unknown top-level keys, so logging it as a bare `output_full` field loses it.
 *
 * Best-effort: returns null (never throws) if the Braintrust module is not initialized or a `Blob`
 * runtime is unavailable, so the preview alone lands. Secrets are masked in the attachment exactly
 * as in the preview.
 */
export function fullOutputAttachment(output: unknown): unknown | null {
  const full = fullRedactedToolOutput(output);
  if (full === null || !btModule) return null;
  try {
    return new btModule.Attachment({
      data: new Blob([full], { type: "text/plain" }),
      filename: "tool-output.txt",
      contentType: "text/plain",
    });
  } catch {
    return null;
  }
}
