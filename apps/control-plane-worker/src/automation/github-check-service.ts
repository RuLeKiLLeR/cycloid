import { gateGithubSessionStart } from "../services/integration-gating";
import type { Env } from "../types";
import {
  getGithubCheckRule,
  type GithubCheckAutomationRule,
  insertGithubCheckRule,
  listGithubCheckRules,
  softDeleteGithubCheckRule,
  updateGithubCheckRule,
} from "./github-check-db";

export class GithubCheckAutomationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}
function bounded(value: string | null | undefined, max: number, field: string): string | null {
  const normalized = value?.trim() || null;
  if (normalized && new TextEncoder().encode(normalized).byteLength > max)
    throw new GithubCheckAutomationError(400, `invalid_${field}`, `${field} is too long`);
  return normalized;
}
export async function createGithubCheckAutomationRule(
  env: Env,
  input: {
    businessId: string;
    userId: string;
    repoOwner: string;
    repoName: string;
    checkName: string | null;
    modelId: string | null;
    promptTemplate: string;
    name: string | null;
    enabled: boolean;
  },
): Promise<GithubCheckAutomationRule> {
  const repoOwner = bounded(input.repoOwner, 100, "repo_owner");
  const repoName = bounded(input.repoName, 100, "repo_name");
  const promptTemplate = bounded(input.promptTemplate, 32768, "prompt") ?? "";
  if (!repoOwner || !repoName || !promptTemplate)
    throw new GithubCheckAutomationError(400, "invalid_rule", "Repository and instructions are required");
  const id = crypto.randomUUID();
  const gate = await gateGithubSessionStart(env, {
    userId: input.userId,
    businessId: input.businessId,
    sessionId: `github-check-rule-${id}`,
    repoOwner,
    repoName,
  });
  if (!gate.ok)
    throw new GithubCheckAutomationError(404, "repo_not_available", "Repository is not available for automation");
  const now = Date.now();
  const rule: GithubCheckAutomationRule = {
    id,
    businessId: input.businessId,
    configuredByUserId: input.userId,
    repoOwner,
    repoName,
    installationId: gate.installationId,
    checkName: bounded(input.checkName, 200, "check_name"),
    modelId: bounded(input.modelId, 200, "model_id"),
    promptTemplate,
    name: bounded(input.name, 200, "name"),
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  };
  await insertGithubCheckRule(env.DB, rule);
  return rule;
}
export { listGithubCheckRules };
export async function patchGithubCheckAutomationRule(
  env: Env,
  input: {
    businessId: string;
    id: string;
    checkName?: string | null;
    modelId?: string | null;
    promptTemplate?: string;
    name?: string | null;
    enabled?: boolean;
  },
): Promise<GithubCheckAutomationRule> {
  const current = await getGithubCheckRule(env.DB, input.businessId, input.id);
  if (!current) throw new GithubCheckAutomationError(404, "not_found", "Automation not found");
  const next = {
    ...current,
    checkName: input.checkName === undefined ? current.checkName : bounded(input.checkName, 200, "check_name"),
    modelId: input.modelId === undefined ? current.modelId : bounded(input.modelId, 200, "model_id"),
    promptTemplate:
      input.promptTemplate === undefined
        ? current.promptTemplate
        : (bounded(input.promptTemplate, 32768, "prompt") ?? ""),
    name: input.name === undefined ? current.name : bounded(input.name, 200, "name"),
    enabled: input.enabled ?? current.enabled,
    updatedAt: Date.now(),
  };
  if (!next.promptTemplate) throw new GithubCheckAutomationError(400, "invalid_prompt", "Instructions are required");
  await updateGithubCheckRule(env.DB, {
    businessId: input.businessId,
    id: input.id,
    name: next.name,
    promptTemplate: next.promptTemplate,
    checkName: next.checkName,
    modelId: next.modelId,
    enabled: next.enabled,
    updatedAt: next.updatedAt,
  });
  return next;
}
export async function deleteGithubCheckAutomationRule(env: Env, businessId: string, id: string): Promise<void> {
  if (!(await softDeleteGithubCheckRule(env.DB, businessId, id, Date.now())))
    throw new GithubCheckAutomationError(404, "not_found", "Automation not found");
}
