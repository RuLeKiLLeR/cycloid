import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { ApiError } from "../errors.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

export async function stopCommand(
  sessionId: string,
  options: { json?: boolean } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);

  let status: string;
  try {
    const response = await apiFetch<{ ok: boolean; status?: string }>(config, `/api/sessions/${sessionId}/stop`, {
      method: "POST",
    });
    status = response.status ?? "stopping";
  } catch (err) {
    // The route returns 409 `{ error: "session_not_stoppable", reason }` for
    // both "session in a non-stoppable phase" and "already stopped (no socket)".
    // Map both to a graceful exit with the structured reason so scripts that
    // call `arc stop` in a loop don't have to special-case the no-op.
    const parsed = parseStopBlocked(err);
    if (!parsed) throw err;
    status = parsed.reason;
  }

  emit(command, options, { sessionId, status }, (payload) => {
    if (payload.status === "already_stopped") {
      console.log(`Session ${payload.sessionId} is already stopped.`);
    } else if (payload.status === "stopping" || payload.status === "stopped") {
      console.log(`Stop requested for session ${payload.sessionId}.`);
    } else {
      console.log(`Session ${payload.sessionId} cannot be stopped from phase=${payload.status}.`);
    }
  });
}

function parseStopBlocked(err: unknown): { reason: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const body = JSON.parse(err.body) as { error?: string; reason?: string };
    if (body.error !== "session_not_stoppable") return null;
    return { reason: body.reason ?? "not_stoppable" };
  } catch {
    return null;
  }
}
