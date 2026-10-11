import { z } from "zod";

import { JSON_HEADERS, requestJson, requestVoid } from "./client";

export type SlackChannelMemoryScopeType = "customer" | "incident" | "support" | "sales" | "generic";

export type SlackChannelMemoryIntake = {
  businessId: string;
  teamId: string;
  channelId: string;
  scopeType: SlackChannelMemoryScopeType;
  scopeId: string | null;
  enabledAtMs: number;
  enabledByUserId: number | null;
};

export type SlackWorkspaceMemoryInstall = {
  teamId: string;
  teamName: string | null;
  teamDomain: string | null;
  uninstalledAt: number | null;
};

export type SlackWorkspaceMemoryChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
};

export type SlackAlertAutomationProvider = "datadog" | "sentry";

export type SlackAlertAutomationRule = {
  id: string;
  businessId: string;
  configuredByUserId: string | null;
  name: string | null;
  triggerKind: "slack_channel_message";
  triggerProvider: SlackAlertAutomationProvider;
  slackTeamId: string;
  slackChannelId: string;
  slackBotUserId: string | null;
  allowedSlackAppIds: string[];
  allowedSlackBotIds: string[];
  repoOwner: string;
  repoName: string;
  installationId: number;
  modelId: string | null;
  promptTemplate: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SlackAlertSenderCandidate = {
  appId: string | null;
  botId: string | null;
  botName: string | null;
  sampleTs: string;
  messageCount: number;
};

type SlackAlertAutomationRulesResponse = {
  rules: SlackAlertAutomationRule[];
};

type SlackAlertSenderCandidatesResponse = {
  candidates: SlackAlertSenderCandidate[];
};

type SlackAlertAutomationRuleResponse = {
  rule: SlackAlertAutomationRule;
};

const slackAlertAutomationProviderSchema = z.union([z.literal("datadog"), z.literal("sentry")]);

const slackAlertAutomationRuleSchema: z.ZodType<SlackAlertAutomationRule> = z.object({
  id: z.string(),
  businessId: z.string(),
  configuredByUserId: z.string().nullable(),
  name: z.string().nullable(),
  triggerKind: z.literal("slack_channel_message"),
  triggerProvider: slackAlertAutomationProviderSchema,
  slackTeamId: z.string(),
  slackChannelId: z.string(),
  slackBotUserId: z.string().nullable(),
  allowedSlackAppIds: z.array(z.string()),
  allowedSlackBotIds: z.array(z.string()),
  repoOwner: z.string(),
  repoName: z.string(),
  installationId: z.number(),
  modelId: z.string().nullable(),
  promptTemplate: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const slackAlertSenderCandidateSchema: z.ZodType<SlackAlertSenderCandidate> = z.object({
  appId: z.string().nullable(),
  botId: z.string().nullable(),
  botName: z.string().nullable(),
  sampleTs: z.string(),
  messageCount: z.number(),
});

const slackAlertAutomationRulesResponseSchema: z.ZodType<SlackAlertAutomationRulesResponse> = z.object({
  rules: z.array(slackAlertAutomationRuleSchema),
});

const slackAlertSenderCandidatesResponseSchema: z.ZodType<SlackAlertSenderCandidatesResponse> = z.object({
  candidates: z.array(slackAlertSenderCandidateSchema),
});

const slackAlertAutomationRuleResponseSchema: z.ZodType<SlackAlertAutomationRuleResponse> = z.object({
  rule: slackAlertAutomationRuleSchema,
});

export async function fetchSlackChannelMemorySettings(businessId: string): Promise<{
  intake: SlackChannelMemoryIntake[];
  workspaces: SlackWorkspaceMemoryInstall[];
}> {
  return requestJson(
    `/api/admin/slack-channel-intake?business_id=${encodeURIComponent(businessId)}`,
    undefined,
    "Failed to fetch Slack channel memory settings",
  );
}

export async function fetchSlackWorkspaceMemoryChannels(input: {
  businessId: string;
  teamId: string;
}): Promise<SlackWorkspaceMemoryChannel[]> {
  const data = await requestJson<{ channels: SlackWorkspaceMemoryChannel[] }>(
    `/api/admin/slack-channel-intake/channels?business_id=${encodeURIComponent(
      input.businessId,
    )}&team_id=${encodeURIComponent(input.teamId)}`,
    undefined,
    "Failed to fetch Slack channels",
  );
  return data.channels;
}

export async function saveSlackChannelMemoryIntake(input: {
  businessId: string;
  teamId: string;
  channelId: string;
  scopeType: SlackChannelMemoryScopeType;
  scopeId?: string | null;
}): Promise<SlackChannelMemoryIntake> {
  const data = await requestJson<{ intake: SlackChannelMemoryIntake }>(
    "/api/admin/slack-channel-intake",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        business_id: input.businessId,
        team_id: input.teamId,
        channel_id: input.channelId,
        scope_type: input.scopeType,
        scope_id: input.scopeId ?? null,
      }),
    },
    "Failed to save Slack channel memory settings",
  );
  return data.intake;
}

export async function disableSlackChannelMemoryIntake(input: {
  businessId: string;
  teamId: string;
  channelId: string;
}): Promise<void> {
  await requestJson(
    "/api/admin/slack-channel-intake",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        business_id: input.businessId,
        team_id: input.teamId,
        channel_id: input.channelId,
        enabled: false,
      }),
    },
    "Failed to disable Slack channel memory",
  );
}

export async function fetchSlackAlertAutomationRules(businessId: string): Promise<SlackAlertAutomationRule[]> {
  const data = await requestJson(
    `/api/admin/slack-channel-automation?business_id=${encodeURIComponent(businessId)}`,
    undefined,
    "Failed to fetch Slack alert automation rules",
    { schema: slackAlertAutomationRulesResponseSchema },
  );
  return data.rules;
}

export async function detectSlackAlertSenders(input: {
  businessId: string;
  teamId: string;
  channelId: string;
  provider: SlackAlertAutomationProvider;
}): Promise<SlackAlertSenderCandidate[]> {
  const data = await requestJson(
    `/api/admin/slack-channel-automation/detect-senders?business_id=${encodeURIComponent(
      input.businessId,
    )}&team_id=${encodeURIComponent(input.teamId)}&channel_id=${encodeURIComponent(
      input.channelId,
    )}&provider=${encodeURIComponent(input.provider)}`,
    undefined,
    "Failed to detect Slack alert sender",
    { schema: slackAlertSenderCandidatesResponseSchema },
  );
  return data.candidates;
}

export async function saveSlackAlertAutomationRule(input: {
  businessId: string;
  teamId: string;
  channelId: string;
  provider: SlackAlertAutomationProvider;
  appIds: string[];
  botIds: string[];
  repoOwner: string;
  repoName: string;
  modelId: string;
  promptTemplate: string;
  name?: string | null;
}): Promise<SlackAlertAutomationRule> {
  const data = await requestJson(
    "/api/admin/slack-channel-automation",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        business_id: input.businessId,
        team_id: input.teamId,
        channel_id: input.channelId,
        provider: input.provider,
        app_ids: input.appIds,
        bot_ids: input.botIds,
        repo_owner: input.repoOwner,
        repo_name: input.repoName,
        model_id: input.modelId,
        prompt_template: input.promptTemplate,
        name: input.name ?? null,
      }),
    },
    "Failed to save Slack alert automation rule",
    { schema: slackAlertAutomationRuleResponseSchema },
  );
  return data.rule;
}

export async function updateSlackAlertAutomationRule(input: {
  businessId: string;
  ruleId: string;
  enabled?: boolean;
  name?: string | null;
  repoOwner?: string;
  repoName?: string;
  modelId?: string | null;
  promptTemplate?: string;
}): Promise<SlackAlertAutomationRule> {
  const data = await requestJson(
    `/api/admin/slack-channel-automation/${encodeURIComponent(input.ruleId)}`,
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        business_id: input.businessId,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.repoOwner !== undefined ? { repo_owner: input.repoOwner } : {}),
        ...(input.repoName !== undefined ? { repo_name: input.repoName } : {}),
        ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
        ...(input.promptTemplate !== undefined ? { prompt_template: input.promptTemplate } : {}),
      }),
    },
    "Failed to update Slack alert automation rule",
    { schema: slackAlertAutomationRuleResponseSchema },
  );
  return data.rule;
}

// NOTE: there is deliberately no pause/resume function here. The only write
// endpoint is the create POST, which upserts by a rule id derived from
// (business, provider, team, channel, repo). Rules whose stored id was not
// derived that way — e.g. the migration-seeded internal alert rules
// (migration 0193) — would be DUPLICATED by that POST instead of updated.
// Per-rule enable/disable needs a dedicated PATCH-by-id endpoint first.

export async function deleteSlackAlertAutomationRule(input: { businessId: string; ruleId: string }): Promise<void> {
  await requestVoid(
    `/api/admin/slack-channel-automation/${encodeURIComponent(input.ruleId)}?business_id=${encodeURIComponent(
      input.businessId,
    )}`,
    { method: "DELETE" },
    "Failed to delete Slack alert automation rule",
  );
}
