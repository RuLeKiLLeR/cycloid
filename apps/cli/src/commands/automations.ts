import type { Command } from "commander";

import {
  type AgentRuntimeBackend,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import {
  extractModelId,
  getAgentRuntimeBackendForModel,
  getSessionStartModelIdsForBackend,
  isSessionStartModelAllowedForBackend,
} from "../../../../shared/constants/models.js";
import { parseGithubRepoFullName } from "../../../../shared/github/repo-url.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { apiFetch, apiFetchText } from "../api.js";
import { requireConfig } from "../config.js";
import { ApiError, CliError, codeForHttpStatus } from "../errors.js";
import {
  confirmOrThrow,
  getRuntimeOptions,
  isJson,
  resolvePromptInput,
  type RuntimeOptions,
  writeJson,
} from "../runtime.js";
import { parseApiErrorBody } from "../utils/api-error.js";

type AutomationRule = {
  id: string;
  repoOwner: string;
  repoName: string;
  normalizedCron: string;
  enabled: boolean;
  nextFireAt: number | null;
  modelId?: string | null;
};

type AutomationListPayload = {
  data: {
    items: AutomationRule[];
    nextCursor: string | null;
  };
};

const AUTOMATION_ERROR_HINTS: Record<string, string> = {
  invalid_cron: "Use a standard five-field cron expression, for example: */15 * * * *",
  invalid_model:
    "Model is unknown or not selectable for its backend. Run `cycloid automations create --help` for allowed models.",
  repo_not_available: "Check that the token owner has GitHub access and Cycloid is installed for that repo.",
  duplicate_rule: "An enabled automation already exists for this repo, cron, and prompt.",
  invalid_skill: "Use a leading slash skill that exists in the selected repo, for example: /audit-prod-docs",
  rule_cap_reached:
    "Delete or disable an existing automation before creating another one. The cap is 20 enabled rules.",
  installation_unresolved: "Reconnect or reinstall the GitHub integration for that repository, then retry.",
  model_not_available:
    "That model's backend (Claude/opencode) is limited to Cycloid team businesses; use the codex default or a codex model.",
  repo_skills_unavailable:
    "Cycloid could not verify the repo's skills right now. Retry once GitHub skill discovery is healthy.",
  unknown_skill: "That leading slash skill does not exist in the selected repository.",
};
const MAX_ALL_PAGES = 1000;

export async function createAutomationCommand(
  repoUrl: string,
  promptArg: string | undefined,
  options: { cron: string; name?: string; model?: string; promptStdin?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const repo = parseAutomationRepo(repoUrl);
  const prompt = await resolvePromptInput(promptArg, options);
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  let normalizedModel: string | undefined;
  if (options.model !== undefined) {
    normalizedModel = extractModelId(options.model);
    const backend = resolveAutomationModelBackend(options.model, normalizedModel);
    if (normalizedModel === undefined || !isSessionStartModelAllowedForBackend(normalizedModel, backend)) {
      const allowed = getSessionStartModelIdsForBackend(backend).join(", ");
      throw new CliError("user", `Model '${options.model}' is not selectable. Allowed: ${allowed}.`);
    }
  }

  const body: Record<string, unknown> = {
    repoOwner: repo.owner,
    repoName: repo.repo,
    cron: options.cron,
    prompt,
  };
  if (options.name !== undefined) body.name = options.name;
  if (options.model !== undefined) body.modelId = normalizedModel;

  const payload = await automationApiFetch<{ data: AutomationRule }>(config, "/api/automation/schedules", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (isJson(command, options)) {
    writeJson(payload.data);
    return;
  }

  printAutomationRule(payload.data);
}

export async function listAutomationsCommand(
  options: { limit?: string; cursor?: string; all?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  const items: AutomationRule[] = [];
  let cursor: string | undefined = options.cursor;
  let nextCursor: string | null = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (options.all === true && pageCount > MAX_ALL_PAGES) {
      throw new CliError("user", `automations list --all exceeded ${MAX_ALL_PAGES} pages without reaching the end.`);
    }
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", options.limit);
    if (cursor) query.set("cursor", cursor);
    const payload = await automationApiFetch<AutomationListPayload>(
      config,
      `/api/automation/schedules${query.size ? `?${query.toString()}` : ""}`,
    );
    items.push(...payload.data.items);
    nextCursor = payload.data.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (options.all === true && nextCursor);

  const output = { items, nextCursor: options.all === true ? null : nextCursor };
  if (isJson(command, options)) {
    writeJson(output);
    return;
  }

  if (items.length === 0) {
    console.log("No automations found.");
    return;
  }

  for (const rule of items) {
    console.log(
      `${rule.id}\t${rule.repoOwner}/${rule.repoName}\t${rule.normalizedCron}\t${String(rule.enabled)}\t${formatTime(rule.nextFireAt)}`,
    );
  }
  if (output.nextCursor) console.log(`Next cursor: ${output.nextCursor}`);
}

export async function deleteAutomationCommand(
  id: string,
  options: { yes?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  if (isJson(command, options) && options.yes !== true) {
    throw new CliError("user", "`automations delete --json` requires --yes.");
  }
  if (options.yes !== true) {
    await confirmOrThrow(`Delete automation ${id}?`);
  }

  const runtime = getRuntimeOptions(command, options);
  const config = requireConfig(runtime);
  await automationApiFetchText(config, `/api/automation/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });

  if (isJson(command, options)) {
    writeJson({ ok: true, id });
    return;
  }
  console.log(`Deleted automation ${id}.`);
}

function parseAutomationRepo(value: string): { owner: string; repo: string } {
  if (/^git@/i.test(value) && !/^git@github\.com:/i.test(value)) {
    throw new CliError("user", "repo-url must be owner/name or a GitHub URL.");
  }
  const parsed = parseGithubRepoFullName(value);
  if (!parsed) throw new CliError("user", "repo-url must be owner/name or a GitHub URL.");
  return { owner: parsed.owner, repo: parsed.repo };
}

function resolveAutomationModelBackend(rawModel: string, normalizedModel: string | undefined): AgentRuntimeBackend {
  if (normalizedModel) {
    const backend = getAgentRuntimeBackendForModel(normalizedModel);
    if (backend) return backend;
  }

  const provider = rawModel.match(/^([a-z]+)[/:]/i)?.[1]?.toLowerCase();
  if (provider === "anthropic") return CLAUDE_CODE_AGENT_RUNTIME_BACKEND;
  if (provider === "baseten") return OPENCODE_AGENT_RUNTIME_BACKEND;
  return CODEX_AGENT_RUNTIME_BACKEND;
}

async function automationApiFetch<T>(
  config: Parameters<typeof apiFetch>[0],
  path: string,
  init?: RequestInit,
): Promise<T> {
  try {
    return await apiFetch<T>(config, path, init);
  } catch (err) {
    throw mapAutomationApiError(err);
  }
}

async function automationApiFetchText(
  config: Parameters<typeof apiFetchText>[0],
  path: string,
  init?: RequestInit,
): Promise<string> {
  try {
    return await apiFetchText(config, path, init);
  } catch (err) {
    throw mapAutomationApiError(err);
  }
}

function mapAutomationApiError(err: unknown): CliError {
  if (!(err instanceof ApiError)) {
    return err instanceof CliError ? err : new CliError("server", stringifyError(err));
  }

  const parsed = parseApiErrorBody(err.body);
  const serverCode = parsed?.rawError ?? parsed?.serverCode;
  return new CliError(codeForHttpStatus(err.status), parsed?.message || serverCode || err.message, {
    exitCode: err.exitCode,
    hint: serverCode ? AUTOMATION_ERROR_HINTS[serverCode] : undefined,
    requestId: err.requestId,
  });
}

function printAutomationRule(rule: AutomationRule): void {
  console.log(`ID: ${rule.id}`);
  console.log(`Repo: ${rule.repoOwner}/${rule.repoName}`);
  console.log(`Cron: ${rule.normalizedCron}`);
  if (rule.modelId) console.log(`Model: ${rule.modelId}`);
  console.log(`Next fire: ${formatTime(rule.nextFireAt)}`);
}

function formatTime(value: number | null | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "none";
}
