/**
 * Service for scheduled-rule management (V1: create + list).
 * Routes call services; services call DAOs.
 */
import { CODEX_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  extractModelId,
  getAgentRuntimeBackendForModel,
  isSessionStartModelAllowedForBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { isValidGithubRepoSegment } from "../../../../shared/github/repo-url.js";
import { MAX_SKILLS_PER_PROMPT } from "../../../../shared/skills/index.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  AUTOMATION_LIST_DEFAULT_LIMIT,
  AUTOMATION_LIST_MAX_LIMIT,
  AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS,
  AUTOMATION_MAX_RULES_PER_BUSINESS,
  AUTOMATION_RULE_NAME_MAX_LENGTH,
  AUTOMATION_RULE_PROMPT_MAX_LENGTH,
  AUTOMATION_RUN_STATS_WINDOW_7D_MS,
  AUTOMATION_RUN_STATS_WINDOW_24H_MS,
  AUTOMATION_RUNS_DEFAULT_LIMIT,
  AUTOMATION_RUNS_MAX_LIMIT,
} from "../constants/automation";
import { fetchRepoSkills } from "../github/skills";
import { createLogger } from "../logger";
import { gateGithubSessionStart } from "../services/integration-gating";
import { getConversationInfo } from "../slack/notify";
import { resolveInstalledSlackBotToken } from "../slack/tokens";
import { getWorkspaceInstallMetadata } from "../slack/workspaces";
import type { Env } from "../types";
import { computeNextFireAt, CronValidationError, parseCronExpression } from "./cron";
import {
  type AutomationRun,
  type AutomationRunOutcomeCounts,
  countAutomationRunOutcomesForRuleSince,
  countEnabledScheduledRulesForBusiness,
  countScheduledRulesForBusiness,
  deleteScheduledRuleById,
  getAutomationSlotJob,
  getScheduledRuleById,
  insertManualAutomationSlotJob,
  insertScheduledRuleIfBusinessUnderEnabledCap,
  listAutomationRunsForRule,
  listScheduledRules,
  type ListScheduledRulesResult,
  type ScheduledRule,
  setScheduledRuleEnabledById,
  updateScheduledRuleById,
} from "./db";
import { splitScheduledAutomationPrompt } from "./prompt";
import { runManualAutomationSlotJob } from "./scheduler";

const log = createLogger({ bindings: { component: "automation-service" } });

/**
 * Error class for failures in the scheduled-rule service. Each instance
 * carries an HTTP-style status and a stable code so the routes layer can
 * render a safe response without leaking internals.
 */
export class ScheduledRuleServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, publicMessage: string, details?: Record<string, unknown>) {
    super(`${code}: ${publicMessage}`);
    this.name = "ScheduledRuleServiceError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}

export type CreateScheduledRuleInput = {
  callerUserId: string;
  businessId: string;
  repoOwner: string;
  repoName: string;
  cron: string;
  prompt: string;
  name?: string | null;
  /**
   * Optional Slack delivery target. Both must be provided together to enable
   * channel delivery; omitting both creates a rule with no Slack delivery.
   */
  slackTeamId?: string | null;
  slackChannelId?: string | null;
  /**
   * Optional agent model to pin for this rule's sessions (e.g. `claude-opus-4-8`).
   * Omit (or null) to use the backend default (gpt-5.4 / codex). A Claude model
   * routes the session to the claude_code backend automatically.
   */
  modelId?: string | null;
  /** Internal callers may create an exact paused copy without violating the active-identity constraint. */
  enabled?: boolean;
};

/**
 * Validate an optional per-rule model id. Returns the canonical model id, or
 * null when none is set (rule uses the backend default). Fails closed: unknown
 * models are rejected, and model/backend pairs must be selectable session-start
 * pairs. Fire-time session creation resolves the rule owner's provider key and
 * fails closed when the pinned backend lacks credentials.
 */
function validateModelId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    throw new ScheduledRuleServiceError(400, "invalid_model", "modelId must be a string");
  }
  const modelId = extractModelId(normalizeRetiredBasetenModelId(raw));
  if (!modelId) {
    throw new ScheduledRuleServiceError(400, "invalid_model", `Unknown model: ${raw}`);
  }
  const backend = getAgentRuntimeBackendForModel(modelId) ?? CODEX_AGENT_RUNTIME_BACKEND;
  if (!isSessionStartModelAllowedForBackend(modelId, backend)) {
    throw new ScheduledRuleServiceError(400, "invalid_model", `Invalid model for ${backend}: ${modelId}`);
  }
  return modelId;
}

function validateRepoSegment(value: string, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new ScheduledRuleServiceError(400, "invalid_repo", `${field} is required`);
  }
  if (!isValidGithubRepoSegment(trimmed)) {
    throw new ScheduledRuleServiceError(400, "invalid_repo", `${field} is not a valid GitHub identifier`);
  }
  return trimmed;
}

function sanitizeName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    throw new ScheduledRuleServiceError(400, "invalid_name", "name must be a string");
  }
  // Reject control characters outright (anything < 0x20 or 0x7F).

  if (/[\x00-\x1F\x7F]/.test(raw)) {
    throw new ScheduledRuleServiceError(400, "invalid_name", "name contains control characters");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > AUTOMATION_RULE_NAME_MAX_LENGTH) {
    throw new ScheduledRuleServiceError(
      400,
      "invalid_name",
      `name exceeds ${AUTOMATION_RULE_NAME_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validatePrompt(raw: string): string {
  if (typeof raw !== "string") {
    throw new ScheduledRuleServiceError(400, "invalid_prompt", "prompt must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ScheduledRuleServiceError(400, "invalid_prompt", "prompt is required");
  }
  if (trimmed.length > AUTOMATION_RULE_PROMPT_MAX_LENGTH) {
    throw new ScheduledRuleServiceError(
      400,
      "invalid_prompt",
      `prompt exceeds ${AUTOMATION_RULE_PROMPT_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

async function validatePromptSkillsForScheduledRule(
  env: Env,
  input: { callerUserId: string; repoOwner: string; repoName: string; promptTemplate: string },
): Promise<void> {
  const parsed = splitScheduledAutomationPrompt(input.promptTemplate);
  if (!parsed.skills?.length) return;
  if (parsed.skills.length > MAX_SKILLS_PER_PROMPT) {
    throw new ScheduledRuleServiceError(
      400,
      "invalid_skill",
      `Maximum ${MAX_SKILLS_PER_PROMPT} skills per automation prompt`,
    );
  }

  let availableSkills: Awaited<ReturnType<typeof fetchRepoSkills>>;
  try {
    availableSkills = await fetchRepoSkills(env, input.callerUserId, input.repoOwner, input.repoName);
  } catch (err) {
    log.warn(
      {
        userId: input.callerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        promptTemplate: input.promptTemplate,
        error: String(err),
      },
      "automation_rule_skill_lookup_failed",
    );
    throw new ScheduledRuleServiceError(
      503,
      "repo_skills_unavailable",
      "Unable to verify repository skills for this automation.",
    );
  }

  const availableNames = new Set(availableSkills.map((skill) => skill.name));
  const unknownSkill = parsed.skills.find((skill) => !availableNames.has(skill));
  if (unknownSkill) {
    throw new ScheduledRuleServiceError(400, "unknown_skill", `Unknown skill: ${unknownSkill}`);
  }
}

/**
 * Validate and verify a rule's Slack delivery target. Delivery requires BOTH a
 * team and a channel; supplying one without the other is a 400. When a target
 * is present, the check fails closed: the installed bot posts with `chat:write`
 * (not `chat:write.public`), so it must already be a member of the channel. We
 * verify membership at create time so a misconfigured channel fails loudly here
 * rather than silently at delivery. The workspace must also belong to the
 * caller's business (tenancy fail-closed): otherwise a user who knows another
 * business's team/channel IDs could have their digest delivered into that other
 * business's Slack. Returns the normalized (trimmed) target, or a null target
 * when no delivery is configured.
 */
async function resolveSlackDeliveryTarget(
  env: Env,
  businessId: string,
  rawTeamId: string | null | undefined,
  rawChannelId: string | null | undefined,
): Promise<{ slackTeamId: string | null; slackChannelId: string | null }> {
  const slackTeamId = typeof rawTeamId === "string" ? rawTeamId.trim() : "";
  const slackChannelId = typeof rawChannelId === "string" ? rawChannelId.trim() : "";
  if (!slackTeamId && !slackChannelId) {
    return { slackTeamId: null, slackChannelId: null };
  }
  if (!slackTeamId || !slackChannelId) {
    throw new ScheduledRuleServiceError(
      400,
      "invalid_slack_target",
      "slackTeamId and slackChannelId must both be provided to enable Slack delivery.",
    );
  }

  // Tenancy fail-closed: the workspace for this team must belong to the caller's
  // business before we resolve/use its bot token. resolveInstalledSlackBotToken
  // looks up by team id alone, so without this a cross-business team id would
  // validate against another business's install.
  const workspace = await getWorkspaceInstallMetadata(env.DB, slackTeamId);
  if (!workspace || workspace.businessId !== businessId) {
    throw new ScheduledRuleServiceError(
      400,
      "slack_workspace_not_connected",
      "That Slack workspace is not connected to Cycloid for your business.",
    );
  }

  const token = await resolveInstalledSlackBotToken(env, slackTeamId);
  if (!token) {
    throw new ScheduledRuleServiceError(
      400,
      "slack_workspace_not_connected",
      "That Slack workspace is not connected to Cycloid.",
    );
  }
  const info = await getConversationInfo(token, slackChannelId);
  if (!info) {
    // conversations.info fails for a private channel the bot cannot see, an
    // unknown channel, or a transient Slack error — all mean "cannot deliver".
    throw new ScheduledRuleServiceError(
      400,
      "slack_channel_unavailable",
      "That Slack channel could not be found. Invite the Cycloid bot to the channel and try again.",
    );
  }
  if (!info.isMember) {
    throw new ScheduledRuleServiceError(
      400,
      "slack_bot_not_in_channel",
      "Invite the Cycloid bot to that channel before scheduling delivery there.",
    );
  }
  return { slackTeamId, slackChannelId };
}

function throwRuleCapReached(): never {
  throw new ScheduledRuleServiceError(
    409,
    "rule_cap_reached",
    `Maximum of ${AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS} scheduled rules per business reached.`,
  );
}

function throwTotalRuleCapReached(): never {
  throw new ScheduledRuleServiceError(
    409,
    "rule_total_cap_reached",
    `Maximum of ${AUTOMATION_MAX_RULES_PER_BUSINESS} scheduled rules (including paused) per business reached.`,
  );
}

/**
 * Create a scheduled rule. Validates input, enforces the per-business cap,
 * runs the GitHub session-start preflight against the caller's identity, and
 * persists the rule with a precomputed `next_fire_at`. Throws
 * {@link ScheduledRuleServiceError} on any failure.
 */
export async function createScheduledRule(
  env: Env,
  input: CreateScheduledRuleInput,
  options?: { now?: () => number; idGenerator?: () => string },
): Promise<ScheduledRule> {
  const now = options?.now?.() ?? Date.now();

  const repoOwner = validateRepoSegment(input.repoOwner, "repoOwner");
  const repoName = validateRepoSegment(input.repoName, "repoName");
  const prompt = validatePrompt(input.prompt);
  const name = sanitizeName(input.name);
  const modelId = validateModelId(input.modelId);
  const enabled = input.enabled ?? true;

  let parsedCron;
  let nextFireAt;
  try {
    parsedCron = parseCronExpression(input.cron);
    // Computed here (not after the GitHub preflight) so a syntactically valid but
    // never-occurring schedule (e.g. `0 0 30 2 *` - Feb 30) surfaces as a 400
    // invalid_cron instead of falling through to a 500 after a wasted preflight:
    // computeNextFireAt throws CronValidationError when no fire time exists.
    nextFireAt = computeNextFireAt(parsedCron, now);
  } catch (err) {
    if (err instanceof CronValidationError) {
      throw new ScheduledRuleServiceError(400, "invalid_cron", err.reason);
    }
    throw err;
  }

  // Fast preflight before doing GitHub work. The insert below is the
  // authoritative cap enforcement so concurrent creates cannot exceed it.
  const db = env.DB;
  const totalCount = await countScheduledRulesForBusiness(db, input.businessId);
  if (totalCount >= AUTOMATION_MAX_RULES_PER_BUSINESS) {
    throwTotalRuleCapReached();
  }
  if (enabled) {
    const enabledCount = await countEnabledScheduledRulesForBusiness(db, input.businessId);
    if (enabledCount >= AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS) {
      throwRuleCapReached();
    }
  }

  // Verify any Slack delivery target before the GitHub preflight so a bad
  // channel fails fast (and closed) without a wasted GitHub round-trip.
  const slackTarget = await resolveSlackDeliveryTarget(env, input.businessId, input.slackTeamId, input.slackChannelId);

  // Preflight against the caller identity. Failures translate to 404 to avoid
  // leaking repo existence (per plan).
  const id = options?.idGenerator?.() ?? crypto.randomUUID();
  const gate = await gateGithubSessionStart(env, {
    userId: input.callerUserId,
    businessId: input.businessId,
    sessionId: `rule-preflight-${id}`,
    repoOwner,
    repoName,
  });
  if (!gate.ok) {
    log.warn(
      { businessId: input.businessId, repoOwner, repoName, reasonCode: gate.body.reasonCode },
      "automation_rule_create_blocked_by_integration_gate",
    );
    throw new ScheduledRuleServiceError(404, "repo_not_available", "Repository is not available for scheduling.", {
      stage: gate.body.stage,
      reasonCode: gate.body.reasonCode,
    });
  }
  const installationId = gate.installationId;
  await validatePromptSkillsForScheduledRule(env, {
    callerUserId: input.callerUserId,
    repoOwner,
    repoName,
    promptTemplate: prompt,
  });

  const insertResult = await (async () => {
    try {
      return await insertScheduledRuleIfBusinessUnderEnabledCap(
        db,
        {
          id,
          businessId: input.businessId,
          configuredByUserId: input.callerUserId,
          repoOwner,
          repoName,
          installationId,
          modelId,
          promptTemplate: prompt,
          cronExpression: input.cron.trim(),
          normalizedCron: parsedCron.normalized,
          name,
          nextFireAt,
          createdAt: now,
          enabled,
          slackTeamId: slackTarget.slackTeamId,
          slackChannelId: slackTarget.slackChannelId,
        },
        AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS,
        AUTOMATION_MAX_RULES_PER_BUSINESS,
      );
    } catch (err) {
      const message = stringifyError(err);
      if (/UNIQUE constraint failed|idx_scheduled_rules_active_identity/i.test(message)) {
        throw new ScheduledRuleServiceError(
          409,
          "duplicate_rule",
          "An identical scheduled rule already exists for this repository.",
        );
      }
      throw err;
    }
  })();
  if (!insertResult.inserted && enabled) {
    throwRuleCapReached();
  }
  // A paused insert has no enabled-cap failure mode, so a refused insert
  // means the total cap raced past the preflight.
  if (!insertResult.inserted) {
    throwTotalRuleCapReached();
  }

  log.info(
    {
      ruleId: id,
      businessId: input.businessId,
      actorUserId: input.callerUserId,
      repoOwner,
      repoName,
      normalizedCron: parsedCron.normalized,
      installationId,
    },
    "automation_rule_created",
  );

  return {
    id,
    businessId: input.businessId,
    configuredByUserId: input.callerUserId,
    repoOwner,
    repoName,
    installationId,
    modelId,
    promptTemplate: prompt,
    cronExpression: input.cron.trim(),
    normalizedCron: parsedCron.normalized,
    name,
    enabled,
    nextFireAt,
    lastEnqueuedAt: null,
    createdAt: now,
    updatedAt: now,
    slackTeamId: slackTarget.slackTeamId,
    slackChannelId: slackTarget.slackChannelId,
    lastDeliveredAt: null,
    lastDeliveryError: null,
  };
}

export type DeleteScheduledRuleInput = {
  callerUserId: string;
  businessId: string;
  ruleId: string;
  /** Computed by the route via `canAdministerCompanyMemory` (admin token or business admin role). */
  requesterIsBusinessAdmin: boolean;
};

/**
 * Whether `callerUserId` may delete `rule`. Member-create / admin-or-creator-delete:
 * a business admin may delete any rule; a non-admin member may delete only the rule
 * they created. A null/empty creator (defensive; `configured_by_user_id` is NOT NULL,
 * so this cannot arise from a persisted row) is admin-delete-only — fail closed.
 */
export function canDeleteScheduledRule(
  rule: { configuredByUserId: string | null },
  callerUserId: string,
  requesterIsBusinessAdmin: boolean,
): boolean {
  if (requesterIsBusinessAdmin) return true;
  if (!rule.configuredByUserId) return false;
  return rule.configuredByUserId === callerUserId;
}

export const canManageScheduledRule = canDeleteScheduledRule;

type ManageScheduledRuleInput = {
  callerUserId: string;
  businessId: string;
  ruleId: string;
  requesterIsBusinessAdmin: boolean;
};

async function requireManageableScheduledRule(env: Env, input: ManageScheduledRuleInput): Promise<ScheduledRule> {
  const rule = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!rule) {
    throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  }
  if (!canManageScheduledRule(rule, input.callerUserId, input.requesterIsBusinessAdmin)) {
    throw new ScheduledRuleServiceError(
      403,
      "forbidden",
      "Only a business admin or the rule's creator can manage this scheduled rule.",
    );
  }
  return rule;
}

export type UpdateScheduledRuleServiceInput = ManageScheduledRuleInput & {
  /** Every field is optional: `undefined` keeps the stored value (partial
   * PATCH), while `null` on the nullable fields clears them. */
  cron?: string;
  prompt?: string;
  name?: string | null;
  slackTeamId?: string | null;
  slackChannelId?: string | null;
};

export async function updateScheduledRule(
  env: Env,
  input: UpdateScheduledRuleServiceInput,
  options?: { now?: () => number },
): Promise<ScheduledRule> {
  const existing = await requireManageableScheduledRule(env, input);
  const now = options?.now?.() ?? Date.now();
  // Merge with the stored rule so a partial PATCH (e.g. `{ name }`) updates
  // only the provided fields instead of degrading into a full replace.
  const prompt = input.prompt === undefined ? existing.promptTemplate : validatePrompt(input.prompt);
  const name = input.name === undefined ? existing.name : sanitizeName(input.name);
  const cronExpression = input.cron === undefined ? existing.cronExpression : input.cron.trim();
  const slackTeamId = input.slackTeamId === undefined ? existing.slackTeamId : input.slackTeamId;
  const slackChannelId = input.slackChannelId === undefined ? existing.slackChannelId : input.slackChannelId;

  let parsedCron;
  let nextFireAt;
  try {
    parsedCron = parseCronExpression(cronExpression);
    nextFireAt = computeNextFireAt(parsedCron, now);
  } catch (err) {
    if (err instanceof CronValidationError) {
      throw new ScheduledRuleServiceError(400, "invalid_cron", err.reason);
    }
    throw err;
  }

  const slackTarget = await resolveSlackDeliveryTarget(env, input.businessId, slackTeamId, slackChannelId);
  try {
    const result = await updateScheduledRuleById(env.DB, {
      id: input.ruleId,
      businessId: input.businessId,
      promptTemplate: prompt,
      cronExpression,
      normalizedCron: parsedCron.normalized,
      name,
      nextFireAt,
      slackTeamId: slackTarget.slackTeamId,
      slackChannelId: slackTarget.slackChannelId,
      updatedAt: now,
    });
    if (!result.updated) {
      throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
    }
  } catch (err) {
    const message = stringifyError(err);
    if (/UNIQUE constraint failed|idx_scheduled_rules_active_identity/i.test(message)) {
      throw new ScheduledRuleServiceError(
        409,
        "duplicate_rule",
        "An identical scheduled rule already exists for this repository.",
      );
    }
    throw err;
  }

  const updated = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!updated) throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  return updated;
}

export async function setScheduledRuleEnabled(
  env: Env,
  input: ManageScheduledRuleInput & { enabled: boolean },
  options?: { now?: () => number },
): Promise<ScheduledRule> {
  const rule = await requireManageableScheduledRule(env, input);
  if (rule.enabled === input.enabled) return rule;

  const now = options?.now?.() ?? Date.now();
  let nextFireAt = rule.nextFireAt;
  if (input.enabled) {
    try {
      nextFireAt = computeNextFireAt(parseCronExpression(rule.cronExpression), now);
    } catch (err) {
      if (err instanceof CronValidationError) {
        throw new ScheduledRuleServiceError(400, "invalid_cron", err.reason);
      }
      throw err;
    }
  }

  try {
    const result = await setScheduledRuleEnabledById(env.DB, {
      id: input.ruleId,
      businessId: input.businessId,
      enabled: input.enabled,
      nextFireAt,
      updatedAt: now,
      maxEnabledRules: AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS,
    });
    if (!result.updated) {
      const current = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
      if (current?.enabled === input.enabled) return current;
      if (input.enabled) throwRuleCapReached();
      throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
    }
  } catch (err) {
    const message = stringifyError(err);
    if (/UNIQUE constraint failed|idx_scheduled_rules_active_identity/i.test(message)) {
      throw new ScheduledRuleServiceError(
        409,
        "duplicate_rule",
        "An identical enabled scheduled rule already exists for this repository.",
      );
    }
    throw err;
  }

  const updated = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!updated) throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  return updated;
}

export async function duplicateScheduledRule(
  env: Env,
  input: ManageScheduledRuleInput,
  options?: { now?: () => number; idGenerator?: () => string },
): Promise<ScheduledRule> {
  const rule = await requireManageableScheduledRule(env, input);
  const sourceName = rule.name ?? `${rule.repoOwner}/${rule.repoName}`;
  const name = `Copy of ${sourceName}`.slice(0, AUTOMATION_RULE_NAME_MAX_LENGTH);
  return createScheduledRule(
    env,
    {
      callerUserId: input.callerUserId,
      businessId: input.businessId,
      repoOwner: rule.repoOwner,
      repoName: rule.repoName,
      cron: rule.cronExpression,
      prompt: rule.promptTemplate,
      name,
      slackTeamId: rule.slackTeamId,
      slackChannelId: rule.slackChannelId,
      modelId: rule.modelId,
      enabled: false,
    },
    options,
  );
}

export async function runScheduledRuleNow(
  env: Env,
  input: ManageScheduledRuleInput,
  options?: { now?: () => number; idGenerator?: () => string },
) {
  const rule = await requireManageableScheduledRule(env, input);
  const now = options?.now?.() ?? Date.now();
  const id = options?.idGenerator?.() ?? crypto.randomUUID();
  const jobKey = `automation:manual:${rule.id}:${id}`;
  const sessionId = `automation-${rule.id}-manual-${id}`;

  try {
    await insertManualAutomationSlotJob(env.DB, {
      jobKey,
      ruleId: rule.id,
      slotMs: now,
      sessionId,
      promptTemplate: rule.promptTemplate,
      installationId: rule.installationId,
      createdAt: now,
    });
  } catch (err) {
    const message = stringifyError(err);
    if (/UNIQUE constraint failed|idx_automation_slot_jobs_rule_slot/i.test(message)) {
      throw new ScheduledRuleServiceError(409, "run_already_requested", "A run was already requested just now.");
    }
    throw err;
  }

  const createdJob = await getAutomationSlotJob(env.DB, jobKey);
  if (!createdJob) throw new ScheduledRuleServiceError(500, "run_create_failed", "Failed to create automation run.");
  const processed = await runManualAutomationSlotJob(env, createdJob, now);
  if (!processed) throw new ScheduledRuleServiceError(500, "run_create_failed", "Failed to create automation run.");
  return processed;
}

/**
 * Hard-delete a scheduled rule the caller's business owns. Allowed only when the
 * caller is a business admin OR the rule's creator; a non-creator member is denied.
 * Throws `ScheduledRuleServiceError(404, "not_found")` for unknown or cross-business
 * ids (404 for both to avoid existence leaks) and `(403, "forbidden")` when the rule
 * exists in the caller's business but the caller is neither admin nor creator. No
 * re-validation of GitHub auth — delete removes future fires and does not initiate
 * anything.
 */
export async function deleteScheduledRule(env: Env, input: DeleteScheduledRuleInput): Promise<void> {
  const rule = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!rule) {
    throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  }
  if (!canDeleteScheduledRule(rule, input.callerUserId, input.requesterIsBusinessAdmin)) {
    throw new ScheduledRuleServiceError(
      403,
      "forbidden",
      "Only a business admin or the rule's creator can delete this scheduled rule.",
    );
  }
  const { deleted } = await deleteScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!deleted) {
    // Lost a race with a concurrent delete; the rule is already gone.
    throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  }
  log.info(
    {
      ruleId: input.ruleId,
      businessId: input.businessId,
      actorUserId: input.callerUserId,
      requesterIsBusinessAdmin: input.requesterIsBusinessAdmin,
    },
    "automation_rule_deleted",
  );
}

export type ListScheduledRulesInput = {
  businessId: string;
  cursor?: string | null;
  limit?: number | null;
};

export async function listScheduledRulesForBusiness(
  env: Env,
  input: ListScheduledRulesInput,
): Promise<ListScheduledRulesResult> {
  let limit = input.limit ?? AUTOMATION_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = AUTOMATION_LIST_DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), AUTOMATION_LIST_MAX_LIMIT);
  return listScheduledRules(env.DB, {
    businessId: input.businessId,
    cursor: input.cursor ?? null,
    limit,
  });
}

export type ListScheduledRuleRunsInput = {
  businessId: string;
  ruleId: string;
  cursor?: string | null;
  limit?: number | null;
};

export type ScheduledRuleRunStats = {
  last24h: AutomationRunOutcomeCounts;
  last7d: AutomationRunOutcomeCounts;
};

export type ScheduledRuleRunsResult = {
  items: AutomationRun[];
  nextCursor: string | null;
  stats: ScheduledRuleRunStats;
};

/**
 * Run history for one scheduled rule, plus rolling 24h/7d scheduler-level
 * outcome counts. Fails closed: the rule must exist inside the caller's
 * business (404 for unknown AND cross-business ids, matching delete) before
 * any slot-job rows — which carry no business column — are read.
 */
export async function listScheduledRuleRunsForBusiness(
  env: Env,
  input: ListScheduledRuleRunsInput,
  options?: { now?: () => number },
): Promise<ScheduledRuleRunsResult> {
  const rule = await getScheduledRuleById(env.DB, input.ruleId, input.businessId);
  if (!rule) {
    throw new ScheduledRuleServiceError(404, "not_found", "Scheduled rule not found.");
  }

  let limit = input.limit ?? AUTOMATION_RUNS_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = AUTOMATION_RUNS_DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), AUTOMATION_RUNS_MAX_LIMIT);

  const now = options?.now?.() ?? Date.now();
  const [page, last24h, last7d] = await Promise.all([
    listAutomationRunsForRule(env.DB, { ruleId: rule.id, cursor: input.cursor ?? null, limit }),
    countAutomationRunOutcomesForRuleSince(env.DB, rule.id, now - AUTOMATION_RUN_STATS_WINDOW_24H_MS),
    countAutomationRunOutcomesForRuleSince(env.DB, rule.id, now - AUTOMATION_RUN_STATS_WINDOW_7D_MS),
  ]);
  return { items: page.items, nextCursor: page.nextCursor, stats: { last24h, last7d } };
}
