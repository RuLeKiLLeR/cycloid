import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { requireConfig } from "../config.js";
import {
  assertCycloidSessionMutationAllowed,
  getRuntimeOptions,
  isJson,
  randomIdempotencyKey,
  resolvePromptInput,
  type RuntimeOptions,
  writeJson,
} from "../runtime.js";
import { resolveUploadedFileOptions, type UploadedFileOption } from "../uploads.js";
import { formatSessionResult } from "../utils/session-output.js";
import { unwrapSessionState } from "../utils/session-payload.js";
import { fetchSettledSessionResultFields, waitForCreatedPrompt } from "./create.js";
import { parsePollInterval } from "./watch.js";

export async function messageCommand(
  sessionId: string,
  promptArg: string | undefined,
  options: {
    promptStdin?: boolean;
    uploadedFile?: UploadedFileOption;
    idempotencyKey?: string;
    wait?: boolean;
    pollInterval?: string;
    json?: boolean;
  } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  assertCycloidSessionMutationAllowed("send");
  const config = requireConfig(runtime);
  const prompt = await resolvePromptInput(promptArg, options);
  const uploadedFiles = await resolveUploadedFileOptions(options.uploadedFile);

  const response = await apiFetch<{ prompt?: { promptId?: string; id?: string } }>(
    config,
    `/api/sessions/${sessionId}/prompts`,
    {
      method: "POST",
      headers: { "Idempotency-Key": options.idempotencyKey ?? randomIdempotencyKey() },
      body: JSON.stringify({ prompt, ...(uploadedFiles?.length ? { uploadedFiles } : {}) }),
    },
  );
  const promptId = response.prompt?.promptId ?? response.prompt?.id;
  if (options.wait) {
    const pollIntervalMs = parsePollInterval(options.pollInterval);
    await waitForCreatedPrompt(sessionId, promptId, undefined, pollIntervalMs, runtime, command);
    if (isJson(command, options)) {
      let resultFields: object = {};
      try {
        resultFields = await fetchSettledSessionResultFields(config, sessionId, pollIntervalMs);
      } catch {
        resultFields = {};
      }
      writeJson({ sessionId, ...(promptId ? { promptId } : {}), ...resultFields });
      return;
    }
    try {
      const sessionPayload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}`);
      const resultLine = formatSessionResult(unwrapSessionState(sessionPayload));
      if (resultLine) console.log(resultLine);
    } catch {
      // The prompt already succeeded; result output is a convenience and must
      // not turn a successful --wait run into a failure.
    }
  }
  if (isJson(command, options)) {
    writeJson({ sessionId, ...(promptId ? { promptId } : {}) });
    return;
  }
  if (options.wait) return;
  console.log(`Message sent to session ${sessionId}.`);
}
