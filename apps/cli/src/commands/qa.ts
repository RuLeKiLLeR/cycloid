import type { Command } from "commander";

import { normalizeGithubPullRequestUrl } from "../../../../shared/agent/verify-directive.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { apiFetch } from "../api.js";
import { requireConfig } from "../config.js";
import { ApiError, CliError } from "../errors.js";
import {
  assertCycloidSessionMutationAllowed,
  getRuntimeOptions,
  isJson,
  randomIdempotencyKey,
  type RuntimeOptions,
  writeJson,
} from "../runtime.js";
import { waitForCreatedPrompt } from "./create.js";
import { resolveModelAndBackend } from "./model-options.js";
import { parsePollInterval } from "./watch.js";

const QA_PROMPT = "Verify this pull request.";

type SessionCreateResponse = {
  sessionId: string;
  sessionUrl?: string;
  promptAlreadyEnqueued?: boolean;
};

type PromptCreateResponse = {
  prompt?: {
    promptId?: string;
    id?: string;
  };
};

type QaOptions = {
  model?: string;
  backend?: string;
  reasoningEffort?: string;
  wait?: boolean;
  pollInterval?: string;
  idempotencyKey?: string;
} & RuntimeOptions;

function parseCanonicalPrUrl(prUrl: string): { targetPrUrl: string; repoUrl: string } {
  const targetPrUrl = normalizeGithubPullRequestUrl(prUrl);
  if (!targetPrUrl) {
    throw new CliError(
      "user",
      `Invalid pull request URL: "${prUrl}". Expected https://github.com/<owner>/<repo>/pull/<number>.`,
    );
  }

  const url = new URL(targetPrUrl);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  return {
    targetPrUrl,
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}

function parseCreateConflict(error: ApiError): CliError {
  let message = error.message;
  let sessionId: string | undefined;
  let sessionUrl: string | undefined;

  try {
    const parsed = JSON.parse(error.body) as {
      error?: string | { message?: unknown };
      sessionId?: unknown;
      sessionUrl?: unknown;
    };
    const parsedMessage =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : undefined;
    if (parsedMessage) message = parsedMessage;
    if (typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
    if (typeof parsed.sessionUrl === "string") sessionUrl = parsed.sessionUrl;
  } catch {
    // Fall back to the ApiError message.
  }

  const location = sessionUrl ? ` (${sessionUrl})` : "";
  const existing = sessionId ? ` Existing verifier session: ${sessionId}${location}.` : "";
  return new CliError("conflict", `${message}${existing}`, {
    hint: error.hint,
    requestId: error.requestId,
  });
}

export async function qaCommand(prUrl: string, options: QaOptions, command?: Command): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  assertCycloidSessionMutationAllowed("qa");
  const config = requireConfig(runtime);
  const { targetPrUrl, repoUrl } = parseCanonicalPrUrl(prUrl);
  const agentRuntimeBackend = resolveModelAndBackend(options);
  const idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
  const sessionIdempotencyKey = `${idempotencyKey}:session`;
  const promptIdempotencyKey = `${idempotencyKey}:prompt`;

  const body: Record<string, unknown> = {
    context: { repoUrl },
    qa: true,
    targetPrUrl,
  };
  if (options.model) body.model = options.model;
  if (options.backend) body.agentRuntimeBackend = agentRuntimeBackend;
  if (options.reasoningEffort) body.reasoningEffort = options.reasoningEffort;

  let sessionData: SessionCreateResponse;
  try {
    sessionData = await apiFetch<SessionCreateResponse>(config, "/api/sessions", {
      method: "POST",
      headers: { "Idempotency-Key": sessionIdempotencyKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) throw parseCreateConflict(err);
    throw err;
  }

  const sessionId = sessionData.sessionId;
  let promptId: string | undefined;
  if (!sessionData.promptAlreadyEnqueued) {
    try {
      const promptData = await apiFetch<PromptCreateResponse>(config, `/api/sessions/${sessionId}/prompts`, {
        method: "POST",
        headers: { "Idempotency-Key": promptIdempotencyKey },
        body: JSON.stringify({ prompt: QA_PROMPT }),
      });
      promptId = promptData.prompt?.promptId ?? promptData.prompt?.id;
    } catch (err) {
      throw new CliError(
        err instanceof CliError ? err.code : "server",
        `QA session created (${sessionId}) but prompt enqueue failed: ${stringifyError(err)}`,
        {
          exitCode: err instanceof CliError ? err.exitCode : undefined,
          hint: `Retry with: cycloid sessions qa ${targetPrUrl} --idempotency-key ${idempotencyKey}`,
          requestId: err instanceof CliError ? err.requestId : undefined,
          data: {
            ...(err instanceof CliError && err.data ? err.data : {}),
            sessionId,
            ...(sessionData.sessionUrl ? { sessionUrl: sessionData.sessionUrl } : {}),
          },
        },
      );
    }
  }

  if (options.wait) {
    const waitPollIntervalMs = parsePollInterval(options.pollInterval);
    if (!isJson(command, options)) {
      console.log(`Session: ${sessionId}`);
      if (sessionData.sessionUrl) console.log(`URL: ${sessionData.sessionUrl}`);
    }
    await waitForCreatedPrompt(sessionId, promptId, sessionData.sessionUrl, waitPollIntervalMs, runtime, command);
    if (!isJson(command, options)) {
      console.log(`Target PR: ${targetPrUrl}`);
    }
  }

  if (isJson(command, options)) {
    const output: Record<string, unknown> = { sessionId, repoUrl, targetPrUrl };
    if (sessionData.sessionUrl) output.sessionUrl = sessionData.sessionUrl;
    if (options.model) output.model = options.model;
    if (options.backend) output.agentRuntimeBackend = agentRuntimeBackend;
    if (options.reasoningEffort) output.reasoningEffort = options.reasoningEffort;
    if (promptId) output.promptId = promptId;
    writeJson(output);
    return;
  }

  if (options.wait) return;
  console.log(`Session: ${sessionId}`);
  if (sessionData.sessionUrl) console.log(`URL: ${sessionData.sessionUrl}`);
  console.log(`Target PR: ${targetPrUrl}`);
  console.log(`Follow with: cycloid sessions events ${sessionId} --follow --json`);
}
