import { z } from "zod";

import { JSON_HEADERS, requestJson as requestValidatedJson, requestVoid } from "./client";

const scheduledRuleSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  configuredByUserId: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  installationId: z.number(),
  promptTemplate: z.string(),
  cron: z.string(),
  normalizedCron: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  nextFireAt: z.number(),
  lastEnqueuedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Per-requester: whether the current user may mutate this rule (business admin or creator). */
  canManage: z.boolean(),
  canDelete: z.boolean(),
  slackTeamId: z.string().nullable(),
  slackChannelId: z.string().nullable(),
  lastDeliveredAt: z.number().nullable(),
  lastDeliveryError: z.string().nullable(),
});

export type ScheduledRule = z.infer<typeof scheduledRuleSchema>;

const scheduledRulesPageSchema = z.object({
  items: z.array(scheduledRuleSchema),
  nextCursor: z.string().nullable(),
});

type ScheduledRulesPage = z.infer<typeof scheduledRulesPageSchema>;

export type CreateScheduledRuleInput = {
  repoOwner: string;
  repoName: string;
  cron: string;
  prompt: string;
  name?: string | null;
  /** Optional Slack delivery target; both must be provided together. */
  slackTeamId?: string | null;
  slackChannelId?: string | null;
};

export type UpdateScheduledRuleInput = Omit<CreateScheduledRuleInput, "repoOwner" | "repoName">;

export async function fetchScheduledRules(cursor?: string | null): Promise<ScheduledRulesPage> {
  // NOTE: route-coverage test parses this fetch path statically -- keep it as a plain string literal
  const url = cursor ? `/api/automation/schedules?cursor=${encodeURIComponent(cursor)}` : "/api/automation/schedules";
  const response = await requestValidatedJson(url, undefined, "Failed to fetch scheduled rules", {
    schema: z.object({ ok: z.literal(true), data: scheduledRulesPageSchema }),
  });
  return response.data;
}

const scheduledRuleRunOutcomeSchema = z.enum(["fired", "skipped_overlap", "skipped_concurrency", "failed"]);

export type ScheduledRuleRunOutcome = z.infer<typeof scheduledRuleRunOutcomeSchema>;

const scheduledRuleRunSchema = z.object({
  jobKey: z.string(),
  slotMs: z.number(),
  /** Scheduler-level terminal outcome; null while the run is still starting/retrying. */
  outcome: scheduledRuleRunOutcomeSchema.nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Non-null only when the fired session still exists; skipped runs never create one. */
  sessionId: z.string().nullable(),
  /** The session's current phase (not a durable outcome — archival overwrites it). */
  sessionRichStatus: z.string().nullable(),
});

export type ScheduledRuleRun = z.infer<typeof scheduledRuleRunSchema>;

const scheduledRuleRunCountsSchema = z.object({
  fired: z.number(),
  failed: z.number(),
  skipped: z.number(),
});

export type ScheduledRuleRunCounts = z.infer<typeof scheduledRuleRunCountsSchema>;

const scheduledRuleRunsPageSchema = z.object({
  items: z.array(scheduledRuleRunSchema),
  nextCursor: z.string().nullable(),
  stats: z.object({
    last24h: scheduledRuleRunCountsSchema,
    last7d: scheduledRuleRunCountsSchema,
  }),
});

export type ScheduledRuleRunsPage = z.infer<typeof scheduledRuleRunsPageSchema>;

export async function fetchScheduledRuleRuns(ruleId: string, cursor?: string | null): Promise<ScheduledRuleRunsPage> {
  const base = `/api/automation/schedules/${encodeURIComponent(ruleId)}/runs`;
  const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
  const response = await requestValidatedJson(url, undefined, "Failed to fetch automation runs", {
    schema: z.object({ ok: z.literal(true), data: scheduledRuleRunsPageSchema }),
  });
  return response.data;
}

export async function deleteScheduledRule(id: string): Promise<void> {
  await requestVoid(
    `/api/automation/schedules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "Failed to delete scheduled rule",
  );
}

export async function createScheduledRule(input: CreateScheduledRuleInput): Promise<ScheduledRule> {
  const body: CreateScheduledRuleInput = {
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    cron: input.cron,
    prompt: input.prompt,
    name: input.name ?? null,
    slackTeamId: input.slackTeamId ?? null,
    slackChannelId: input.slackChannelId ?? null,
  };
  const response = await requestValidatedJson(
    "/api/automation/schedules",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
    "Failed to create scheduled rule",
    { schema: z.object({ ok: z.literal(true), data: scheduledRuleSchema }) },
  );
  return response.data;
}

export async function updateScheduledRule(id: string, input: UpdateScheduledRuleInput): Promise<ScheduledRule> {
  const response = await requestValidatedJson(
    `/api/automation/schedules/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        cron: input.cron,
        prompt: input.prompt,
        name: input.name ?? null,
        slackTeamId: input.slackTeamId ?? null,
        slackChannelId: input.slackChannelId ?? null,
      }),
    },
    "Failed to update automation",
    { schema: z.object({ ok: z.literal(true), data: scheduledRuleSchema }) },
  );
  return response.data;
}

export async function setScheduledRuleEnabled(id: string, enabled: boolean): Promise<ScheduledRule> {
  const response = await requestValidatedJson(
    `/api/automation/schedules/${encodeURIComponent(id)}`,
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) },
    enabled ? "Failed to resume automation" : "Failed to pause automation",
    { schema: z.object({ ok: z.literal(true), data: scheduledRuleSchema }) },
  );
  return response.data;
}

export async function duplicateScheduledRule(id: string): Promise<ScheduledRule> {
  const response = await requestValidatedJson(
    `/api/automation/schedules/${encodeURIComponent(id)}/duplicate`,
    { method: "POST" },
    "Failed to duplicate automation",
    { schema: z.object({ ok: z.literal(true), data: scheduledRuleSchema }) },
  );
  return response.data;
}

const manualRunSchema = z.object({
  jobKey: z.string(),
  sessionId: z.string(),
  phase: z.enum(["slot_claimed", "gate_revalidated", "checks_passed", "session_projected", "prompt_enqueued"]),
  outcome: scheduledRuleRunOutcomeSchema.nullable(),
  failureReason: z.string().nullable(),
});

export type ManualAutomationRun = z.infer<typeof manualRunSchema>;

export async function runScheduledRuleNow(id: string): Promise<ManualAutomationRun> {
  const response = await requestValidatedJson(
    `/api/automation/schedules/${encodeURIComponent(id)}/run-now`,
    { method: "POST" },
    "Failed to run automation",
    { schema: z.object({ ok: z.literal(true), data: manualRunSchema }) },
  );
  return response.data;
}
