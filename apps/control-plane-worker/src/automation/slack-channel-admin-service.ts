import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { SLACK_ALERT_AUTOMATION_DEFAULT_PROMPTS } from "../../../../shared/constants/slack-alert-prompts.js";
import { isValidGithubRepoSegment } from "../../../../shared/github/repo-url.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { AUTOMATION_RULE_NAME_MAX_LENGTH, AUTOMATION_RULE_PROMPT_MAX_LENGTH } from "../constants/automation";
import { createLogger } from "../logger";
import { gateGithubSessionStart } from "../services/integration-gating";
import { detectWorkspaceAlertSenders } from "../slack/workspaces";
import type { Env } from "../types";
import {
  type AutomationRule,
  type AutomationTriggerProvider,
  deleteSlackChannelAutomationRule,
  getSlackChannelAutomationRule,
  listSlackChannelAutomationRules,
  updateSlackChannelAutomationRule,
  upsertSlackChannelAutomationRule,
} from "./db";

const log = createLogger({ bindings: { component: "slack-channel-automation-admin" } });

const PROVIDERS = new Set<AutomationTriggerProvider>(["datadog", "sentry"]);

export class SlackChannelAutomationAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = "SlackChannelAutomationAdminError";
  }
}

export function defaultSlackAlertPrompt(provider: AutomationTriggerProvider): string {
  return SLACK_ALERT_AUTOMATION_DEFAULT_PROMPTS[provider];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SlackChannelAutomationAdminError(400, "invalid_input", `${field} is required`);
  }
  return value.trim();
}

function normalizeProvider(value: unknown): AutomationTriggerProvider {
  const provider = requireString(value, "provider");
  if (!PROVIDERS.has(provider as AutomationTriggerProvider)) {
    throw new SlackChannelAutomationAdminError(400, "invalid_provider", "provider must be datadog or sentry");
  }
  return provider as AutomationTriggerProvider;
}

function validateRepoSegment(value: unknown, field: string): string {
  const segment = requireString(value, field);
  if (!isValidGithubRepoSegment(segment)) {
    throw new SlackChannelAutomationAdminError(400, "invalid_repo", `${field} is not a valid GitHub identifier`);
  }
  return segment;
}

function sanitizeOptionalName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new SlackChannelAutomationAdminError(400, "invalid_name", "name must be a string");
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new SlackChannelAutomationAdminError(400, "invalid_name", "name contains control characters");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > AUTOMATION_RULE_NAME_MAX_LENGTH) {
    throw new SlackChannelAutomationAdminError(
      400,
      "invalid_name",
      `name exceeds ${AUTOMATION_RULE_NAME_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

function sanitizePrompt(value: unknown, provider: AutomationTriggerProvider): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultSlackAlertPrompt(provider);
  if (raw.length > AUTOMATION_RULE_PROMPT_MAX_LENGTH) {
    throw new SlackChannelAutomationAdminError(
      400,
      "invalid_prompt",
      `prompt exceeds ${AUTOMATION_RULE_PROMPT_MAX_LENGTH} characters`,
    );
  }
  return raw;
}

function sanitizeModelId(value: unknown): string | null {
  if (value == null || value === "") return null;
  const modelId = extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(value));
  if (!modelId) {
    throw new SlackChannelAutomationAdminError(400, "invalid_model", "modelId is not a supported session model");
  }
  return modelId;
}

function normalizeIdList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function buildRuleId(input: {
  businessId: string;
  provider: AutomationTriggerProvider;
  teamId: string;
  channelId: string;
  repoOwner: string;
  repoName: string;
}): Promise<string> {
  const identity = JSON.stringify([
    input.businessId,
    input.provider,
    input.teamId,
    input.channelId,
    input.repoOwner,
    input.repoName,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `slack-alert-${hash.slice(0, 32)}`;
}

export async function listSlackAlertAutomationSettings(db: D1Database, businessId: string): Promise<AutomationRule[]> {
  return listSlackChannelAutomationRules(db, businessId);
}

export async function detectSlackAlertAutomationSenders(
  env: Env,
  input: { businessId: string; teamId: unknown; channelId: unknown; provider: unknown },
) {
  return detectWorkspaceAlertSenders(
    env.DB,
    {
      businessId: input.businessId,
      teamId: requireString(input.teamId, "teamId"),
      channelId: requireString(input.channelId, "channelId"),
      provider: normalizeProvider(input.provider),
    },
    env.TOKEN_ENCRYPTION_KEY,
  );
}

export async function saveSlackAlertAutomationRule(
  env: Env,
  input: {
    callerUserId: string;
    businessId: string;
    teamId: unknown;
    channelId: unknown;
    provider: unknown;
    appIds: unknown;
    botIds: unknown;
    repoOwner: unknown;
    repoName: unknown;
    promptTemplate?: unknown;
    modelId?: unknown;
    name?: unknown;
    enabled?: unknown;
    nowMs?: number;
  },
): Promise<AutomationRule> {
  const provider = normalizeProvider(input.provider);
  const slackTeamId = requireString(input.teamId, "teamId");
  const slackChannelId = requireString(input.channelId, "channelId");
  const repoOwner = validateRepoSegment(input.repoOwner, "repoOwner");
  const repoName = validateRepoSegment(input.repoName, "repoName");
  const allowedSlackAppIds = Array.from(new Set(normalizeIdList(input.appIds))).slice(0, 10);
  const allowedSlackBotIds = Array.from(new Set(normalizeIdList(input.botIds))).slice(0, 10);
  if (allowedSlackAppIds.length === 0 && allowedSlackBotIds.length === 0) {
    throw new SlackChannelAutomationAdminError(400, "missing_sender", "At least one Slack app or bot ID is required");
  }
  const promptTemplate = sanitizePrompt(input.promptTemplate, provider);
  const modelId = sanitizeModelId(input.modelId);
  const name = sanitizeOptionalName(input.name);
  const nowMs = input.nowMs ?? Date.now();

  const ruleId = await buildRuleId({
    businessId: input.businessId,
    provider,
    teamId: slackTeamId,
    channelId: slackChannelId,
    repoOwner,
    repoName,
  });

  const gate = await gateGithubSessionStart(env, {
    userId: input.callerUserId,
    businessId: input.businessId,
    sessionId: `slack-alert-rule-preflight-${ruleId}`,
    repoOwner,
    repoName,
  });
  if (!gate.ok) {
    log.warn(
      { businessId: input.businessId, repoOwner, repoName, reasonCode: gate.body.reasonCode },
      "slack_alert_automation_rule_blocked_by_repo_gate",
    );
    throw new SlackChannelAutomationAdminError(
      404,
      "repo_not_available",
      "Repository is not available for alert automation.",
      { stage: gate.body.stage, reasonCode: gate.body.reasonCode },
    );
  }

  try {
    return await upsertSlackChannelAutomationRule(env.DB, {
      id: ruleId,
      businessId: input.businessId,
      configuredByUserId: input.callerUserId,
      name,
      triggerProvider: provider,
      slackTeamId,
      slackChannelId,
      slackBotUserId: null,
      allowedSlackAppIds,
      allowedSlackBotIds,
      repoOwner,
      repoName,
      installationId: gate.installationId,
      modelId,
      promptTemplate,
      enabled: input.enabled !== false,
      nowMs,
    });
  } catch (err) {
    const message = stringifyError(err);
    if (/UNIQUE constraint failed|idx_automation_rules_active_identity/i.test(message)) {
      throw new SlackChannelAutomationAdminError(
        409,
        "duplicate_rule",
        "An enabled alert automation rule already exists for this provider, channel, and repository.",
      );
    }
    throw err;
  }
}

export async function removeSlackAlertAutomationRule(
  db: D1Database,
  input: { businessId: string; ruleId: unknown },
): Promise<void> {
  const deleted = await deleteSlackChannelAutomationRule(db, {
    businessId: input.businessId,
    ruleId: requireString(input.ruleId, "ruleId"),
  });
  if (!deleted.deleted) {
    throw new SlackChannelAutomationAdminError(404, "not_found", "Slack alert automation rule not found.");
  }
}

export async function updateSlackAlertAutomationRule(
  env: Env,
  input: {
    callerUserId: string;
    businessId: string;
    ruleId: unknown;
    name?: unknown;
    repoOwner?: unknown;
    repoName?: unknown;
    modelId?: unknown;
    promptTemplate?: unknown;
    enabled?: unknown;
    nowMs?: number;
  },
): Promise<AutomationRule> {
  const ruleId = requireString(input.ruleId, "ruleId");
  const current = await getSlackChannelAutomationRule(env.DB, { businessId: input.businessId, ruleId });
  if (!current) throw new SlackChannelAutomationAdminError(404, "not_found", "Slack alert automation rule not found.");

  const repoOwner =
    input.repoOwner === undefined ? current.repoOwner : validateRepoSegment(input.repoOwner, "repoOwner");
  const repoName = input.repoName === undefined ? current.repoName : validateRepoSegment(input.repoName, "repoName");
  const repoChanged = repoOwner !== current.repoOwner || repoName !== current.repoName;
  let installationId = current.installationId;
  if (repoChanged || input.enabled === true) {
    if (!current.configuredByUserId) {
      throw new SlackChannelAutomationAdminError(
        409,
        "missing_execution_owner",
        "Alert automation has no execution owner and cannot be enabled.",
      );
    }
    const gate = await gateGithubSessionStart(env, {
      userId: current.configuredByUserId,
      businessId: input.businessId,
      sessionId: `slack-alert-rule-preflight-${ruleId}`,
      repoOwner,
      repoName,
    });
    if (!gate.ok) {
      throw new SlackChannelAutomationAdminError(
        404,
        "repo_not_available",
        "Repository is not available for alert automation.",
      );
    }
    installationId = gate.installationId;
  }
  const updated = await updateSlackChannelAutomationRule(env.DB, {
    businessId: input.businessId,
    ruleId,
    name: input.name === undefined ? current.name : sanitizeOptionalName(input.name),
    repoOwner,
    repoName,
    installationId,
    modelId: input.modelId === undefined ? current.modelId : sanitizeModelId(input.modelId),
    promptTemplate:
      input.promptTemplate === undefined
        ? current.promptTemplate
        : sanitizePrompt(input.promptTemplate, current.triggerProvider),
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    nowMs: input.nowMs ?? Date.now(),
  });
  if (!updated) throw new SlackChannelAutomationAdminError(404, "not_found", "Slack alert automation rule not found.");
  return updated;
}
