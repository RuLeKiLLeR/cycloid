import { postStructuredEventToDd } from "../../observability/events-exporter";
import type { Env } from "../../types";
import * as doDb from "../do-db";

export type PromptActivityResult = { accepted: true } | { accepted: false; reason: "stale_prompt_id" };

interface PromptActivityLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

type PromptActivityTelemetryEnv = Pick<Env, "DD_API_KEY" | "WORKER_ENV">;

interface ClearForPromptOpts {
  sql: SqlStorage;
  env: PromptActivityTelemetryEnv;
  sessionId: string;
  expectedPromptId: string;
  logger?: PromptActivityLogger;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface ClearOnSessionCloseOpts {
  sql: SqlStorage;
  sessionId: string;
}

interface RecordForActiveOpts {
  sql: SqlStorage;
  sessionId: string;
  at: number;
}

function logRefusal(
  logger: PromptActivityLogger | undefined,
  env: PromptActivityTelemetryEnv,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  event: string,
  sessionId: string,
  expectedPromptId: string,
  observedActivePromptId: string | null,
): void {
  const payload = {
    event,
    sessionId,
    expectedPromptId,
    observedActivePromptId,
    reason: "stale_prompt_id",
  };
  logger?.info(payload, "promptLastActivityAt write refused (stale prompt id)");
  const postPromise = postStructuredEventToDd(env, payload);
  if (waitUntil) {
    waitUntil(postPromise);
  } else {
    console.warn("[prompt-activity] postStructuredEventToDd called without waitUntil; event may be dropped");
    void postPromise;
  }
}

export function clearPromptActivityForPrompt(opts: ClearForPromptOpts): PromptActivityResult {
  const observed = doDb.getActiveProcessingPromptId(opts.sql, opts.sessionId);
  if (observed !== opts.expectedPromptId) {
    logRefusal(
      opts.logger,
      opts.env,
      opts.waitUntil,
      "prompt_activity_refused_clear",
      opts.sessionId,
      opts.expectedPromptId,
      observed,
    );
    return { accepted: false, reason: "stale_prompt_id" };
  }
  doDb.updateSandboxState(opts.sql, opts.sessionId, { promptLastActivityAt: null });
  return { accepted: true };
}

export function clearPromptActivityOnSessionClose(opts: ClearOnSessionCloseOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { promptLastActivityAt: null });
}

/**
 * Records activity for whichever prompt is currently active in D1. Used by
 * the transport (ws-manager) sandbox-connect path where the dispatched
 * prompt id is whatever `sendPendingPromptToSandbox` just read, not the
 * snapshot captured at handler entry. No-ops when no prompt is active.
 *
 * Returns `{ accepted: false }` only when no active prompt is set; staleness
 * cannot occur here because the helper reads the source of truth directly.
 */
export function recordPromptActivityForCurrentActive(opts: RecordForActiveOpts): PromptActivityResult {
  const observed = doDb.getActiveProcessingPromptId(opts.sql, opts.sessionId);
  if (observed === null) {
    return { accepted: false, reason: "stale_prompt_id" };
  }
  doDb.updateSandboxState(opts.sql, opts.sessionId, { promptLastActivityAt: opts.at });
  return { accepted: true };
}
