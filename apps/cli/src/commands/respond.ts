import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { ApiError, CliError } from "../errors.js";
import {
  assertCycloidSessionMutationAllowed,
  emit,
  readStdin,
  resolveBusinessContext,
  type RuntimeOptions,
} from "../runtime.js";

async function resolveAnswerInput(answerArg: string | undefined, options: { answerStdin?: boolean }): Promise<string> {
  const shouldReadStdin = options.answerStdin === true || answerArg === "-";
  const answer = shouldReadStdin ? await readStdin() : answerArg;
  if (!answer || answer.trim().length === 0) {
    throw new CliError(
      "user",
      "Missing answer. Pass an answer argument, use '-' to read stdin, or pass --answer-stdin.",
    );
  }
  return answer;
}

export async function respondCommand(
  sessionId: string,
  answerArg: string | undefined,
  options: { answerStdin?: boolean; questionId?: string; json?: boolean } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  assertCycloidSessionMutationAllowed("respond");
  const questionId = options.questionId?.trim();
  if (!questionId) {
    throw new CliError("user", "Missing --question-id for the pending question.", {
      hint: `Find the question id with: cycloid sessions events ${sessionId} --follow --json`,
    });
  }
  const { config } = resolveBusinessContext(command, options);
  const answer = await resolveAnswerInput(answerArg, options);
  try {
    const payload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}/respond`, {
      method: "POST",
      body: JSON.stringify({ answer, questionId }),
    });
    emit(command, options, { sessionId, ...payload }, () => console.log(`Answer sent to session ${sessionId}.`));
  } catch (err) {
    const conflict = parseRespondConflict(err);
    if (!conflict) throw err;
    throw new CliError("conflict", conflict.message, {
      data: { reason: conflict.reason },
      hint: `Inspect pending questions with: cycloid sessions events ${sessionId} --follow --json`,
    });
  }
}

function parseRespondConflict(err: unknown): { message: string; reason: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const body = JSON.parse(err.body) as { error?: string; reason?: string };
    if (body.error !== "session_not_respondable") return null;
    return {
      message: body.reason
        ? `Session cannot be answered from phase=${body.reason}.`
        : "Session does not have a pending question.",
      reason: body.reason ?? "session_not_respondable",
    };
  } catch {
    return null;
  }
}
