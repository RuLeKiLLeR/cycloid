import type { Command } from "commander";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { sleep } from "../../../../shared/utils/timing.js";
import { apiFetch } from "../api.js";
import type { CliConfig } from "../config.js";
import { requireConfig } from "../config.js";
import { isWatchTerminal, MIN_WATCH_POLL_INTERVAL_MS } from "../constants/watch.js";
import { CliError } from "../errors.js";
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
import { clampPollInterval } from "../utils/poll-interval.js";
import { extractSessionResultFields, formatSessionResult, type SessionResultFields } from "../utils/session-output.js";
import { unwrapSessionState } from "../utils/session-payload.js";
import { resolveModelAndBackend } from "./model-options.js";
import { extractSessionLifecycle, parsePollInterval, watchCommand } from "./watch.js";

const REPO_URL_PATTERNS = [
  /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
  /^git@[^:]+:[^/]+\/[^/]+?(?:\.git)?$/,
  /^https?:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/,
];

export function validateRepoUrl(url: string): string | null {
  if (REPO_URL_PATTERNS.some((pattern) => pattern.test(url))) return null;
  return `Invalid repo URL: "${url}". Expected a GitHub URL (https://github.com/owner/repo) or owner/repo shorthand.`;
}

type PromptStatus = {
  promptId: string;
  status: string;
  error?: string | null;
};

const PROMPT_TERMINAL_STATUSES = new Set(["completed", "failed"]);
const RESULT_FETCH_ATTEMPTS = 5;
const SESSION_CREATE_PROMPT_PREVIEW_MAX_CHARS = 4_000;

// Onboarding sessions are driven entirely by the bridge's canonical onboarding
// playbook (buildOnboardingAgentGuidance), not the user turn, so a prompt carries
// no signal. `--onboarding` always sends this fixed turn; any prompt the caller
// supplies is ignored (a no-op) rather than required or rejected.
const ONBOARDING_PROMPT = "Onboard this repository onto Cycloid.";

function selectCreatedPrompt(prompts: PromptStatus[], promptId: string | undefined): PromptStatus | null {
  if (prompts.length === 0) return null;
  if (promptId) {
    return prompts.find((prompt) => prompt.promptId === promptId) ?? null;
  }
  return prompts[prompts.length - 1] ?? null;
}

function buildPromptFailureError(sessionId: string, prompt: PromptStatus, sessionUrl?: string): CliError {
  const baseMessage = prompt.error?.trim() || "Prompt execution failed.";
  const location = sessionUrl ? ` ${sessionUrl}` : "";
  return new CliError("user", `Prompt failed in session ${sessionId}: ${baseMessage}${location}`, {
    hint: `Inspect with: cycloid sessions transcript ${sessionId}`,
  });
}

function buildSessionCreatePromptPreview(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  return trimmed.length > SESSION_CREATE_PROMPT_PREVIEW_MAX_CHARS
    ? trimmed.slice(0, SESSION_CREATE_PROMPT_PREVIEW_MAX_CHARS).trimEnd()
    : trimmed;
}

async function fetchCreatedPromptStatus(
  config: CliConfig,
  sessionId: string,
  promptId: string | undefined,
): Promise<PromptStatus | null> {
  const promptList = await apiFetch<{ prompts: PromptStatus[] }>(config, `/api/sessions/${sessionId}/prompts`);
  return selectCreatedPrompt(promptList.prompts, promptId);
}

async function waitForCreatedPromptToSettle(
  config: CliConfig,
  sessionId: string,
  promptId: string | undefined,
  pollIntervalMs: number,
): Promise<PromptStatus | null> {
  const effectivePollIntervalMs = clampPollInterval(pollIntervalMs, MIN_WATCH_POLL_INTERVAL_MS);
  while (true) {
    const createdPrompt = await fetchCreatedPromptStatus(config, sessionId, promptId);
    if (createdPrompt && PROMPT_TERMINAL_STATUSES.has(createdPrompt.status)) {
      return createdPrompt;
    }

    const sessionPayload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}`);
    const lifecycle = extractSessionLifecycle(sessionPayload);
    if (lifecycle.phase && isWatchTerminal(lifecycle.phase)) {
      return fetchCreatedPromptStatus(config, sessionId, promptId);
    }

    await sleep(effectivePollIntervalMs);
  }
}

export async function waitForCreatedPrompt(
  sessionId: string,
  promptId: string | undefined,
  sessionUrl: string | undefined,
  pollIntervalMs: number,
  runtime: RuntimeOptions,
  command: Command | undefined,
): Promise<void> {
  const config = requireConfig(runtime);
  const jsonMode = isJson(command, runtime);
  let createdPrompt: PromptStatus | null;

  if (jsonMode) {
    createdPrompt = await waitForCreatedPromptToSettle(config, sessionId, promptId, pollIntervalMs);
  } else {
    await watchCommand(sessionId, { ...runtime, pollInterval: String(pollIntervalMs) }, command);
    createdPrompt = await fetchCreatedPromptStatus(config, sessionId, promptId);
  }

  if (!createdPrompt) {
    throw new CliError("server", `Prompt status was unavailable after session ${sessionId} reached a terminal state.`, {
      hint: `Inspect with: cycloid sessions transcript ${sessionId}`,
    });
  }
  if (createdPrompt.status === "failed") {
    throw buildPromptFailureError(sessionId, createdPrompt, sessionUrl);
  }
  if (createdPrompt.status !== "completed") {
    throw new CliError(
      "server",
      `Prompt ${createdPrompt.promptId} did not reach a terminal success state before session ${sessionId} reached a terminal state (status: ${createdPrompt.status}).`,
      {
        hint: `Inspect with: cycloid sessions transcript ${sessionId}`,
      },
    );
  }
}

async function fetchSessionResultFields(config: CliConfig, sessionId: string): Promise<SessionResultFields> {
  const sessionPayload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}`);
  return extractSessionResultFields(unwrapSessionState(sessionPayload));
}

export async function fetchSettledSessionResultFields(
  config: CliConfig,
  sessionId: string,
  pollIntervalMs: number,
): Promise<SessionResultFields> {
  const effectivePollIntervalMs = clampPollInterval(pollIntervalMs, MIN_WATCH_POLL_INTERVAL_MS);
  let latest: SessionResultFields = {};
  for (let attempt = 0; attempt < RESULT_FETCH_ATTEMPTS; attempt++) {
    latest = await fetchSessionResultFields(config, sessionId);
    if (latest.prUrl || latest.publishedBranch) return latest;
    if (attempt < RESULT_FETCH_ATTEMPTS - 1) {
      await sleep(effectivePollIntervalMs);
    }
  }
  return latest;
}

export async function createCommand(
  repoUrl: string,
  promptArg: string | undefined,
  options: {
    model?: string;
    backend?: string;
    reasoningEffort?: string;
    autoVerify?: boolean;
    baseBranch?: string;
    startBranch?: string;
    continuePr?: string;
    continueMode?: string;
    promptStdin?: boolean;
    uploadedFile?: UploadedFileOption;
    idempotencyKey?: string;
    wait?: boolean;
    pollInterval?: string;
    json?: boolean;
    cold?: boolean;
    onboarding?: boolean;
  } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  assertCycloidSessionMutationAllowed("create");
  const config = requireConfig(runtime);

  const agentRuntimeBackend = resolveModelAndBackend(options);

  // --onboarding ignores any supplied prompt and always sends the canonical turn.
  const prompt = options.onboarding ? ONBOARDING_PROMPT : await resolvePromptInput(promptArg, options);
  const waitPollIntervalMs = options.wait ? parsePollInterval(options.pollInterval) : null;

  const repoError = validateRepoUrl(repoUrl);
  if (repoError) {
    throw new CliError("user", repoError);
  }
  const baseBranch = options.baseBranch?.trim();
  if (options.baseBranch !== undefined && !baseBranch) {
    throw new CliError("user", "--base-branch must not be empty.");
  }
  const startBranch = options.startBranch?.trim();
  if (options.startBranch !== undefined && !startBranch) {
    throw new CliError("user", "--start-branch must not be empty.");
  }
  const continuePr = options.continuePr?.trim();
  if (options.continuePr !== undefined && !continuePr) {
    throw new CliError("user", "--continue-pr must not be empty.");
  }
  const continueMode = options.continueMode?.trim();
  if (options.continueMode !== undefined && !continueMode) {
    throw new CliError("user", "--continue-mode must not be empty.");
  }
  const uploadedFiles = await resolveUploadedFileOptions(options.uploadedFile);

  const idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
  const sessionIdempotencyKey = `${idempotencyKey}:session`;
  const promptIdempotencyKey = `${idempotencyKey}:prompt`;
  const body: Record<string, unknown> = { context: { repoUrl } };
  if (options.model) body.model = options.model;
  if (options.backend) body.agentRuntimeBackend = agentRuntimeBackend;
  if (options.reasoningEffort) body.reasoningEffort = options.reasoningEffort;
  if (options.autoVerify) body.autoVerify = true;
  const promptPreview = buildSessionCreatePromptPreview(prompt);
  if (promptPreview) body.prompt = promptPreview;
  if (baseBranch) body.baseBranch = baseBranch;
  if (startBranch) body.startBranch = startBranch;
  if (continuePr) body.continuePrUrl = continuePr;
  if (continueMode) body.continueMode = continueMode;
  if (options.cold) body.cold = true;
  if (options.onboarding) body.onboarding = true;
  const sessionData = await apiFetch<{ sessionId: string; sessionUrl?: string }>(config, "/api/sessions", {
    method: "POST",
    headers: { "Idempotency-Key": sessionIdempotencyKey },
    body: JSON.stringify(body),
  });
  const sessionId = sessionData.sessionId;

  let promptId: string | undefined;
  let waitResultFields: SessionResultFields = {};
  try {
    const promptData = await apiFetch<{ prompt?: { promptId?: string; id?: string } }>(
      config,
      `/api/sessions/${sessionId}/prompts`,
      {
        method: "POST",
        headers: { "Idempotency-Key": promptIdempotencyKey },
        body: JSON.stringify({ prompt, ...(uploadedFiles?.length ? { uploadedFiles } : {}) }),
      },
    );
    promptId = promptData.prompt?.promptId ?? promptData.prompt?.id;
  } catch (err) {
    throw new CliError(
      err instanceof CliError ? err.code : "server",
      `Session created (${sessionId}) but prompt failed: ${stringifyError(err)}`,
      {
        exitCode: err instanceof CliError ? err.exitCode : undefined,
        hint: `Retry with: cycloid sessions send ${sessionId} --prompt-stdin`,
        requestId: err instanceof CliError ? err.requestId : undefined,
        data: {
          ...(err instanceof CliError && err.data ? err.data : {}),
          sessionId,
          ...(sessionData.sessionUrl ? { sessionUrl: sessionData.sessionUrl } : {}),
        },
      },
    );
  }

  if (options.wait) {
    if (!isJson(command, options)) {
      console.log(`Session: ${sessionId}`);
      if (sessionData.sessionUrl) console.log(`URL: ${sessionData.sessionUrl}`);
    }
    await waitForCreatedPrompt(sessionId, promptId, sessionData.sessionUrl, waitPollIntervalMs!, runtime, command);
    if (isJson(command, options)) {
      try {
        waitResultFields = await fetchSettledSessionResultFields(config, sessionId, waitPollIntervalMs!);
      } catch {
        // The prompt already succeeded; result output is a convenience and must
        // not turn a successful --wait run into a failure.
      }
    }
    if (!isJson(command, options)) {
      try {
        const sessionPayload = await apiFetch<Record<string, unknown>>(config, `/api/sessions/${sessionId}`);
        const sessionState = unwrapSessionState(sessionPayload);
        const resultLine = formatSessionResult(sessionState);
        if (resultLine) console.log(resultLine);
      } catch {
        // The prompt already succeeded; result output is a convenience and must
        // not turn a successful --wait run into a failure.
      }
    }
  }

  if (isJson(command, options)) {
    const output: Record<string, unknown> = { sessionId };
    if (sessionData.sessionUrl) output.sessionUrl = sessionData.sessionUrl;
    output.repoUrl = repoUrl;
    if (options.model) output.model = options.model;
    if (options.backend) output.agentRuntimeBackend = agentRuntimeBackend;
    if (options.reasoningEffort) output.reasoningEffort = options.reasoningEffort;
    if (options.autoVerify) output.autoVerify = true;
    if (baseBranch) output.baseBranch = baseBranch;
    if (startBranch) output.startBranch = startBranch;
    if (continuePr) output.continuePrUrl = continuePr;
    if (continueMode) output.continueMode = continueMode;
    if (options.onboarding) output.onboarding = true;
    if (promptId) output.promptId = promptId;
    Object.assign(output, waitResultFields);
    writeJson(output);
    return;
  }

  if (options.wait) return;
  console.log(`Session: ${sessionId}`);
  if (sessionData.sessionUrl) console.log(`URL: ${sessionData.sessionUrl}`);
  console.log(`Follow with: cycloid sessions events ${sessionId} --follow --json`);
}
