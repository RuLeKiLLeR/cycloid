import { stringifyError } from "../../../../shared/utils/errors.js";
import { createBridgeLogger, LOG_ORDINALS, type LogLevel } from "../logger.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import type { FirstPartyDynamicToolExecuteContext } from "./first-party-dynamic-tools.js";

const log = createBridgeLogger(LOG_ORDINALS[(process.env.LOG_LEVEL || "info") as LogLevel] ?? 0, {
  component: "agent-ticket-key-notify",
});

const NOTIFY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

function requestSignal(signal?: AbortSignal): AbortSignal {
  return createTimeoutAwareSignal(signal, NOTIFY_TIMEOUT_MS);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Notify the control plane of a ticket key the agent minted mid-run
 * (jira/linear `create_issue`) so the publish-time PR title carries it.
 *
 * Best-effort w.r.t. the calling tool: the issue is already created, so this
 * NEVER throws and the caller must NOT fail the `create_issue` tool on a notify
 * failure (that would risk duplicate tickets). But unlike a fire-and-forget
 * lifecycle ping, a transient failure here silently recreates the original
 * unprefixed-title bug, so we apply a bounded retry on network / 5xx / 429
 * failures and emit a non-secret WARN + telemetry on exhaustion. The
 * control-plane handler is idempotent (set-if-absent), so retries are safe.
 */
export async function notifyAgentCreatedTicketKey(
  ticketKey: string,
  provider: "jira" | "linear",
  context: FirstPartyDynamicToolExecuteContext,
): Promise<void> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"]);
  const sessionId = context.env["SESSION_ID"]?.trim();
  const sandboxAuthToken = context.env["SANDBOX_AUTH_TOKEN"]?.trim();
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) {
    // Not configured for this session (e.g. benchmark runs); nothing to notify.
    return;
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await (context.fetchImpl ?? fetch)(
        `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/ticket-key`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${sandboxAuthToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ ticketKey }),
          signal: requestSignal(context.signal),
        },
      );
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
      // 4xx is deterministic (invalid/forbidden/not_found) — retrying won't help.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      // Only the caller's signal (session teardown) should abort the capture.
      // Our own per-attempt `AbortSignal.timeout` surfaces as a TimeoutError that
      // must be retried, not swallowed — otherwise a slow control plane silently
      // drops the key and the PR title ships unprefixed.
      if (context.signal?.aborted) return;
      lastError = stringifyError(error);
    }
    if (attempt < MAX_ATTEMPTS) {
      await delay(RETRY_BASE_DELAY_MS * attempt, context.signal);
    }
  }

  context.recordTelemetry?.("agent_ticket_key_notify_failed", { provider, ticketKey, error: lastError });
  log.warn(
    { event: "agent_ticket_key_notify_failed", sessionId, provider, ticketKey, error: lastError },
    "Failed to capture agent-created ticket key into PR title after retries",
  );
}
