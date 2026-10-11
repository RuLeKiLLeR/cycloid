/**
 * DAO for `scheduled_rules`. Routes call services; services call DAOs.
 * Raw prepared statements only.
 */
import { TERMINAL_PHASES_ARRAY } from "../../../../shared/session/phase.js";
import { d1Changed } from "../db/errors";

export const AUTOMATION_EVENT_JOB_PAYLOAD_MAX_BYTES = 32 * 1024;
const AUTOMATION_EVENT_JOB_LEASE_MS = 5 * 60 * 1000;
const STALE_UNCLAIMED_AUTOMATION_EVENT_JOB_MS = 15 * 60 * 1000;

export type AutomationTriggerProvider = "datadog" | "sentry";
export type AutomationTriggerKind = "slack_channel_message";

export type AutomationRuleRow = {
  id: string;
  business_id: string;
  configured_by_user_id: string | null;
  name: string | null;
  trigger_kind: AutomationTriggerKind;
  trigger_provider: AutomationTriggerProvider;
  slack_team_id: string;
  slack_channel_id: string;
  slack_bot_user_id: string | null;
  allowed_slack_app_ids_json: string;
  allowed_slack_bot_ids_json: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  model_id: string | null;
  prompt_template: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type AutomationRule = {
  id: string;
  businessId: string;
  configuredByUserId: string | null;
  name: string | null;
  triggerKind: AutomationTriggerKind;
  triggerProvider: AutomationTriggerProvider;
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

export type AutomationEventJobPhase = "queued" | "claimed" | "session_enqueued" | "succeeded" | "skipped" | "failed";

export type AutomationEventJobTerminalPhase = Extract<AutomationEventJobPhase, "succeeded" | "skipped" | "failed">;
export type AutomationEventJobNonTerminalPhase = Exclude<AutomationEventJobPhase, AutomationEventJobTerminalPhase>;

function parseStringArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rowToAutomationRule(row: AutomationRuleRow): AutomationRule {
  return {
    id: row.id,
    businessId: row.business_id,
    configuredByUserId: row.configured_by_user_id,
    name: row.name,
    triggerKind: row.trigger_kind,
    triggerProvider: row.trigger_provider,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    slackBotUserId: row.slack_bot_user_id,
    allowedSlackAppIds: parseStringArrayJson(row.allowed_slack_app_ids_json),
    allowedSlackBotIds: parseStringArrayJson(row.allowed_slack_bot_ids_json),
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    installationId: row.installation_id,
    modelId: row.model_id,
    promptTemplate: row.prompt_template,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type FindEnabledSlackChannelAutomationRulesInput = {
  businessId: string;
  slackTeamId: string;
  slackChannelId: string;
};

export async function findEnabledSlackChannelAutomationRules(
  db: D1Database,
  input: FindEnabledSlackChannelAutomationRulesInput,
): Promise<AutomationRule[]> {
  const result = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
              slack_team_id, slack_channel_id, slack_bot_user_id,
              allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
              repo_owner, repo_name, installation_id, model_id, prompt_template,
              enabled, created_at, updated_at
       FROM automation_rules
       WHERE business_id = ?
         AND trigger_kind = 'slack_channel_message'
         AND slack_team_id = ?
         AND slack_channel_id = ?
         AND enabled = 1
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(input.businessId, input.slackTeamId, input.slackChannelId)
    .all<AutomationRuleRow>();
  return (result.results ?? []).map(rowToAutomationRule);
}

export async function listSlackChannelAutomationRules(db: D1Database, businessId: string): Promise<AutomationRule[]> {
  const result = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
              slack_team_id, slack_channel_id, slack_bot_user_id,
              allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
              repo_owner, repo_name, installation_id, model_id, prompt_template,
              enabled, created_at, updated_at
       FROM automation_rules
       WHERE business_id = ?
         AND trigger_kind = 'slack_channel_message'
       ORDER BY updated_at DESC, created_at DESC, id ASC`,
    )
    .bind(businessId)
    .all<AutomationRuleRow>();
  return (result.results ?? []).map(rowToAutomationRule);
}

export async function getSlackChannelAutomationRule(
  db: D1Database,
  input: { businessId: string; ruleId: string },
): Promise<AutomationRule | null> {
  const row = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
              slack_team_id, slack_channel_id, slack_bot_user_id,
              allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
              repo_owner, repo_name, installation_id, model_id, prompt_template,
              enabled, created_at, updated_at
       FROM automation_rules
       WHERE business_id = ? AND id = ? AND trigger_kind = 'slack_channel_message'
       LIMIT 1`,
    )
    .bind(input.businessId, input.ruleId)
    .first<AutomationRuleRow>();
  return row ? rowToAutomationRule(row) : null;
}

export async function updateSlackChannelAutomationRule(
  db: D1Database,
  input: {
    businessId: string;
    ruleId: string;
    name: string | null;
    repoOwner: string;
    repoName: string;
    installationId: number;
    modelId: string | null;
    promptTemplate: string;
    enabled: boolean;
    nowMs: number;
  },
): Promise<AutomationRule | null> {
  const result = await db
    .prepare(
      `UPDATE automation_rules
       SET name = ?, repo_owner = ?, repo_name = ?, installation_id = ?,
           model_id = ?, prompt_template = ?, enabled = ?, updated_at = ?
       WHERE business_id = ? AND id = ? AND trigger_kind = 'slack_channel_message'`,
    )
    .bind(
      input.name,
      input.repoOwner,
      input.repoName,
      input.installationId,
      input.modelId,
      input.promptTemplate,
      input.enabled ? 1 : 0,
      input.nowMs,
      input.businessId,
      input.ruleId,
    )
    .run();
  if (!d1Changed(result)) return null;
  return getSlackChannelAutomationRule(db, input);
}

export type UpsertSlackChannelAutomationRuleInput = {
  id: string;
  businessId: string;
  configuredByUserId: string;
  name: string | null;
  triggerProvider: AutomationTriggerProvider;
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
  nowMs: number;
};

export async function upsertSlackChannelAutomationRule(
  db: D1Database,
  input: UpsertSlackChannelAutomationRuleInput,
): Promise<AutomationRule> {
  const appIdsJson = JSON.stringify(input.allowedSlackAppIds);
  const botIdsJson = JSON.stringify(input.allowedSlackBotIds);
  const result = await db
    .prepare(
      `INSERT INTO automation_rules (
        id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
        slack_team_id, slack_channel_id, slack_bot_user_id,
        allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
        repo_owner, repo_name, installation_id, model_id, prompt_template,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'slack_channel_message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        configured_by_user_id = excluded.configured_by_user_id,
        name = excluded.name,
        trigger_provider = excluded.trigger_provider,
        slack_team_id = excluded.slack_team_id,
        slack_channel_id = excluded.slack_channel_id,
        slack_bot_user_id = excluded.slack_bot_user_id,
        allowed_slack_app_ids_json = excluded.allowed_slack_app_ids_json,
        allowed_slack_bot_ids_json = excluded.allowed_slack_bot_ids_json,
        repo_owner = excluded.repo_owner,
        repo_name = excluded.repo_name,
        installation_id = excluded.installation_id,
        model_id = excluded.model_id,
        prompt_template = excluded.prompt_template,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
      WHERE automation_rules.business_id = excluded.business_id`,
    )
    .bind(
      input.id,
      input.businessId,
      input.configuredByUserId,
      input.name,
      input.triggerProvider,
      input.slackTeamId,
      input.slackChannelId,
      input.slackBotUserId,
      appIdsJson,
      botIdsJson,
      input.repoOwner,
      input.repoName,
      input.installationId,
      input.modelId,
      input.promptTemplate,
      input.enabled ? 1 : 0,
      input.nowMs,
      input.nowMs,
    )
    .run();

  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error("Failed to save Slack channel automation rule");
  }

  const row = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
              slack_team_id, slack_channel_id, slack_bot_user_id,
              allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
              repo_owner, repo_name, installation_id, model_id, prompt_template,
              enabled, created_at, updated_at
       FROM automation_rules
       WHERE business_id = ?
         AND id = ?
         AND trigger_kind = 'slack_channel_message'
       LIMIT 1`,
    )
    .bind(input.businessId, input.id)
    .first<AutomationRuleRow>();
  if (!row) {
    throw new Error("Failed to read saved Slack channel automation rule");
  }
  return rowToAutomationRule(row);
}

export async function deleteSlackChannelAutomationRule(
  db: D1Database,
  input: { businessId: string; ruleId: string },
): Promise<{ deleted: boolean }> {
  const result = await db
    .prepare("DELETE FROM automation_rules WHERE business_id = ? AND id = ? AND trigger_kind = 'slack_channel_message'")
    .bind(input.businessId, input.ruleId)
    .run();
  return { deleted: (result.meta?.changes ?? 0) === 1 };
}

export type InsertAutomationEventJobInput = {
  id: string;
  ruleId: string;
  businessId: string;
  triggerKind: AutomationTriggerKind;
  triggerProvider: AutomationTriggerProvider;
  idempotencyKey: string;
  slackTeamId: string;
  slackChannelId: string;
  slackMessageTs: string;
  slackThreadTs: string | null;
  payloadJson: string;
  createdAt: number;
};

function assertAutomationEventJobPayloadWithinBound(payloadJson: string): void {
  const bytes = new TextEncoder().encode(payloadJson).byteLength;
  if (bytes > AUTOMATION_EVENT_JOB_PAYLOAD_MAX_BYTES) {
    throw new RangeError(`automation_event_jobs.payload_json exceeds ${AUTOMATION_EVENT_JOB_PAYLOAD_MAX_BYTES} bytes`);
  }
}

export async function insertAutomationEventJobIfNotExists(
  db: D1Database,
  input: InsertAutomationEventJobInput,
): Promise<{ inserted: boolean }> {
  assertAutomationEventJobPayloadWithinBound(input.payloadJson);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO automation_event_jobs (
        id, rule_id, business_id, trigger_kind, trigger_provider, idempotency_key,
        slack_team_id, slack_channel_id, slack_message_ts, slack_thread_ts,
        phase, payload_json, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
    )
    .bind(
      input.id,
      input.ruleId,
      input.businessId,
      input.triggerKind,
      input.triggerProvider,
      input.idempotencyKey,
      input.slackTeamId,
      input.slackChannelId,
      input.slackMessageTs,
      input.slackThreadTs,
      input.payloadJson,
      input.createdAt,
      input.createdAt,
    )
    .run();
  return { inserted: (result.meta?.changes ?? 0) === 1 };
}

export async function insertSkippedAutomationEventJobIfNotExists(
  db: D1Database,
  input: InsertAutomationEventJobInput & { terminalReason: string; completedAt: number },
): Promise<{ inserted: boolean }> {
  assertAutomationEventJobPayloadWithinBound(input.payloadJson);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO automation_event_jobs (
        id, rule_id, business_id, trigger_kind, trigger_provider, idempotency_key,
        slack_team_id, slack_channel_id, slack_message_ts, slack_thread_ts,
        phase, terminal_reason, payload_json, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ruleId,
      input.businessId,
      input.triggerKind,
      input.triggerProvider,
      input.idempotencyKey,
      input.slackTeamId,
      input.slackChannelId,
      input.slackMessageTs,
      input.slackThreadTs,
      input.terminalReason,
      input.payloadJson,
      input.createdAt,
      input.completedAt,
      input.completedAt,
    )
    .run();
  return { inserted: (result.meta?.changes ?? 0) === 1 };
}

export async function claimAutomationEventJob(
  db: D1Database,
  input: { jobId: string; leaseOwner: string; leaseExpiresAt: number; nowMs: number },
): Promise<{ claimed: boolean }> {
  const result = await db
    .prepare(
      `UPDATE automation_event_jobs
       SET phase = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           claimed_at = ?,
           updated_at = ?
       WHERE id = ?
         AND (
           phase = 'queued'
           OR (
             phase NOT IN ('succeeded', 'skipped', 'failed')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?
           )
         )`,
    )
    .bind(input.leaseOwner, input.leaseExpiresAt, input.nowMs, input.nowMs, input.jobId, input.nowMs)
    .run();
  return { claimed: (result.meta?.changes ?? 0) === 1 };
}

export async function updateAutomationEventJobPhase(
  db: D1Database,
  input: { jobId: string; leaseOwner: string; phase: AutomationEventJobNonTerminalPhase; nowMs: number },
): Promise<{ updated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE automation_event_jobs
       SET phase = ?, updated_at = ?
       WHERE id = ?
         AND lease_owner = ?
         AND phase NOT IN ('succeeded', 'skipped', 'failed')`,
    )
    .bind(input.phase, input.nowMs, input.jobId, input.leaseOwner)
    .run();
  return { updated: (result.meta?.changes ?? 0) === 1 };
}

export async function markAutomationEventJobTerminal(
  db: D1Database,
  input: {
    jobId: string;
    leaseOwner: string;
    phase: AutomationEventJobTerminalPhase;
    terminalReason: string;
    sessionId?: string | null;
    errorMessage?: string | null;
    completedAt: number;
  },
): Promise<{ updated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE automation_event_jobs
       SET phase = ?,
           session_id = ?,
           terminal_reason = ?,
           error_message = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE id = ?
         AND lease_owner = ?
         AND phase NOT IN ('succeeded', 'skipped', 'failed')`,
    )
    .bind(
      input.phase,
      input.sessionId ?? null,
      input.terminalReason,
      input.errorMessage ?? null,
      input.completedAt,
      input.completedAt,
      input.jobId,
      input.leaseOwner,
    )
    .run();
  return { updated: (result.meta?.changes ?? 0) === 1 };
}

export async function countOpenAutomationEventJobsForBusiness(db: D1Database, businessId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c
       FROM automation_event_jobs
       WHERE business_id = ?
         AND phase NOT IN ('succeeded', 'skipped', 'failed')`,
    )
    .bind(businessId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export type SweptAutomationEventJob = {
  id: string;
  ruleId: string;
  businessId: string;
  terminalReason: "lease_expired" | "stale_unclaimed";
};

type SweptAutomationEventJobRow = {
  id: string;
  rule_id: string;
  business_id: string;
  terminal_reason: SweptAutomationEventJob["terminalReason"];
};

const STALE_AUTOMATION_EVENT_JOB_SWEEP_LIMIT = 100;

export async function failStaleAutomationEventJobs(db: D1Database, nowMs: number): Promise<SweptAutomationEventJob[]> {
  const expiredLeaseCutoff = nowMs - AUTOMATION_EVENT_JOB_LEASE_MS;
  const staleUnclaimedCutoff = nowMs - STALE_UNCLAIMED_AUTOMATION_EVENT_JOB_MS;
  const candidatesResult = await db
    .prepare(
      `SELECT id,
              rule_id,
              business_id,
              CASE
                WHEN phase = 'queued'
                 AND lease_expires_at IS NULL
                 AND created_at < ?
                THEN 'stale_unclaimed'
                ELSE 'lease_expired'
              END AS terminal_reason
       FROM automation_event_jobs
       WHERE phase NOT IN ('succeeded', 'skipped', 'failed')
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
           OR (phase = 'queued' AND lease_expires_at IS NULL AND created_at < ?)
         )
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(staleUnclaimedCutoff, expiredLeaseCutoff, staleUnclaimedCutoff, STALE_AUTOMATION_EVENT_JOB_SWEEP_LIMIT)
    .all<SweptAutomationEventJobRow>();
  const candidates = candidatesResult.results ?? [];
  if (candidates.length === 0) return [];

  const updateResults = await db.batch(
    candidates.map((job) =>
      db
        .prepare(
          `UPDATE automation_event_jobs
           SET phase = 'failed',
               terminal_reason = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               completed_at = ?,
               updated_at = ?
           WHERE id = ?
             AND phase NOT IN ('succeeded', 'skipped', 'failed')`,
        )
        .bind(job.terminal_reason, nowMs, nowMs, job.id),
    ),
  );

  return candidates
    .filter((_, index) => (updateResults[index]?.meta.changes ?? 0) > 0)
    .map((job) => ({
      id: job.id,
      ruleId: job.rule_id,
      businessId: job.business_id,
      terminalReason: job.terminal_reason,
    }));
}

export type RecentSlackChannelAutomationJobForDuplicateScan = {
  id: string;
  slackMessageTs: string;
  payloadJson: string;
  createdAt: number;
};

export async function listRecentSlackChannelAutomationJobsForDuplicateScan(
  db: D1Database,
  input: {
    businessId: string;
    ruleId: string;
    slackTeamId: string;
    slackChannelId: string;
    sinceMs: number;
    limit: number;
  },
): Promise<RecentSlackChannelAutomationJobForDuplicateScan[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT id, slack_message_ts, payload_json, created_at
       FROM automation_event_jobs
       WHERE business_id = ?
         AND rule_id = ?
         AND slack_team_id = ?
         AND slack_channel_id = ?
         AND created_at >= ?
         AND (phase IN ('queued', 'claimed', 'session_enqueued') OR terminal_reason = 'session_enqueued')
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(input.businessId, input.ruleId, input.slackTeamId, input.slackChannelId, input.sinceMs, limit)
    .all<{
      id: string;
      slack_message_ts: string;
      payload_json: string;
      created_at: number;
    }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    slackMessageTs: row.slack_message_ts,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  }));
}

export type ScheduledRuleRow = {
  id: string;
  business_id: string;
  configured_by_user_id: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  model_id: string | null;
  prompt_template: string;
  cron_expression: string;
  normalized_cron: string;
  name: string | null;
  enabled: number;
  next_fire_at: number;
  last_enqueued_at: number | null;
  created_at: number;
  updated_at: number;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  last_delivered_at: number | null;
  last_delivery_error: string | null;
};

export type ScheduledRule = {
  id: string;
  businessId: string;
  configuredByUserId: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  modelId: string | null;
  promptTemplate: string;
  cronExpression: string;
  normalizedCron: string;
  name: string | null;
  enabled: boolean;
  nextFireAt: number;
  lastEnqueuedAt: number | null;
  createdAt: number;
  updatedAt: number;
  slackTeamId: string | null;
  slackChannelId: string | null;
  lastDeliveredAt: number | null;
  lastDeliveryError: string | null;
};

export type AutomationSlotJobPhase =
  "slot_claimed" | "gate_revalidated" | "checks_passed" | "session_projected" | "prompt_enqueued";

export type AutomationSlotJobTerminalOutcome = "fired" | "skipped_overlap" | "skipped_concurrency" | "failed";

export type AutomationSlotJobRow = {
  job_key: string;
  rule_id: string;
  slot_ms: number;
  session_id: string;
  prompt_template: string;
  installation_id: number;
  phase: AutomationSlotJobPhase;
  terminal_outcome: AutomationSlotJobTerminalOutcome | null;
  failure_reason: string | null;
  retry_after_ms: number;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type AutomationSlotJob = {
  jobKey: string;
  ruleId: string;
  slotMs: number;
  sessionId: string;
  promptTemplate: string;
  installationId: number;
  phase: AutomationSlotJobPhase;
  terminalOutcome: AutomationSlotJobTerminalOutcome | null;
  failureReason: string | null;
  retryAfterMs: number;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function rowToScheduledRule(row: ScheduledRuleRow): ScheduledRule {
  return {
    id: row.id,
    businessId: row.business_id,
    configuredByUserId: row.configured_by_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    installationId: row.installation_id,
    modelId: row.model_id,
    promptTemplate: row.prompt_template,
    cronExpression: row.cron_expression,
    normalizedCron: row.normalized_cron,
    name: row.name,
    enabled: row.enabled !== 0,
    nextFireAt: row.next_fire_at,
    lastEnqueuedAt: row.last_enqueued_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    lastDeliveredAt: row.last_delivered_at,
    lastDeliveryError: row.last_delivery_error,
  };
}

export function rowToAutomationSlotJob(row: AutomationSlotJobRow): AutomationSlotJob {
  return {
    jobKey: row.job_key,
    ruleId: row.rule_id,
    slotMs: row.slot_ms,
    sessionId: row.session_id,
    promptTemplate: row.prompt_template,
    installationId: row.installation_id,
    phase: row.phase,
    terminalOutcome: row.terminal_outcome,
    failureReason: row.failure_reason,
    retryAfterMs: row.retry_after_ms,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type InsertScheduledRuleInput = {
  id: string;
  businessId: string;
  configuredByUserId: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  /** Optional per-rule agent model. Omit (or null) to use the backend default. */
  modelId?: string | null;
  promptTemplate: string;
  cronExpression: string;
  normalizedCron: string;
  name: string | null;
  nextFireAt: number;
  createdAt: number;
  enabled?: boolean;
  /** Slack delivery target; omit (or null) for a rule with no channel delivery. */
  slackTeamId?: string | null;
  slackChannelId?: string | null;
};

export async function insertScheduledRuleIfBusinessUnderEnabledCap(
  db: D1Database,
  input: InsertScheduledRuleInput,
  maxEnabledRules: number,
  maxTotalRules: number,
): Promise<{ inserted: boolean }> {
  // Two guards, both enforced in the INSERT so concurrent creates cannot
  // exceed either: the enabled cap applies only to enabled inserts; the total
  // cap applies to every insert (paused creates/duplicates included).
  const result = await db
    .prepare(
      `INSERT INTO scheduled_rules (
        id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id,
        model_id, prompt_template, cron_expression, normalized_cron, name,
        enabled, next_fire_at, last_enqueued_at, created_at, updated_at,
        slack_team_id, slack_channel_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
      WHERE (? = 0 OR (
        SELECT COUNT(*)
        FROM scheduled_rules
        WHERE business_id = ? AND enabled = 1
      ) < ?)
      AND (
        SELECT COUNT(*)
        FROM scheduled_rules
        WHERE business_id = ?
      ) < ?`,
    )
    .bind(
      input.id,
      input.businessId,
      input.configuredByUserId,
      input.repoOwner,
      input.repoName,
      input.installationId,
      input.modelId ?? null,
      input.promptTemplate,
      input.cronExpression,
      input.normalizedCron,
      input.name,
      input.enabled === false ? 0 : 1,
      input.nextFireAt,
      input.createdAt,
      input.createdAt,
      input.slackTeamId ?? null,
      input.slackChannelId ?? null,
      input.enabled === false ? 0 : 1,
      input.businessId,
      maxEnabledRules,
      input.businessId,
      maxTotalRules,
    )
    .run();
  return { inserted: (result.meta?.changes ?? 0) === 1 };
}

/**
 * Hard-delete a scheduled rule scoped to its owning business. Returns
 * `{ deleted: true }` when exactly one row was removed. Business scoping
 * lives in the WHERE clause so cross-business deletes are rejected at the
 * SQL layer without a separate read-then-delete race.
 *
 * The partial unique index on `(business_id, repo_owner, repo_name,
 * normalized_cron, prompt_template) WHERE enabled = 1` makes hard delete
 * safe: identity is reusable immediately, and historical session/PR
 * provenance survives via the immutable snapshot columns on the session
 * row, so no FK or tombstone is needed.
 */
export async function deleteScheduledRuleById(
  db: D1Database,
  ruleId: string,
  businessId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .prepare("DELETE FROM scheduled_rules WHERE id = ? AND business_id = ?")
    .bind(ruleId, businessId)
    .run();
  return { deleted: (result.meta?.changes ?? 0) === 1 };
}

export async function getScheduledRuleById(
  db: D1Database,
  id: string,
  businessId: string,
): Promise<ScheduledRule | null> {
  const row = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id, model_id,
              prompt_template, cron_expression, normalized_cron, name, enabled,
              next_fire_at, last_enqueued_at, created_at, updated_at,
              slack_team_id, slack_channel_id, last_delivered_at, last_delivery_error
       FROM scheduled_rules WHERE id = ? AND business_id = ? LIMIT 1`,
    )
    .bind(id, businessId)
    .first<ScheduledRuleRow>();
  return row ? rowToScheduledRule(row) : null;
}

export async function getScheduledRuleByIdForScheduler(db: D1Database, id: string): Promise<ScheduledRule | null> {
  const row = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id, model_id,
              prompt_template, cron_expression, normalized_cron, name, enabled,
              next_fire_at, last_enqueued_at, created_at, updated_at,
              slack_team_id, slack_channel_id, last_delivered_at, last_delivery_error
       FROM scheduled_rules WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<ScheduledRuleRow>();
  return row ? rowToScheduledRule(row) : null;
}

export type UpdateScheduledRuleInput = {
  id: string;
  businessId: string;
  promptTemplate: string;
  cronExpression: string;
  normalizedCron: string;
  name: string | null;
  nextFireAt: number;
  slackTeamId: string | null;
  slackChannelId: string | null;
  updatedAt: number;
};

export async function updateScheduledRuleById(
  db: D1Database,
  input: UpdateScheduledRuleInput,
): Promise<{ updated: boolean }> {
  const result = await db
    .prepare(
      `UPDATE scheduled_rules
       SET prompt_template = ?, cron_expression = ?, normalized_cron = ?, name = ?,
           next_fire_at = ?, slack_team_id = ?, slack_channel_id = ?, updated_at = ?
       WHERE id = ? AND business_id = ?`,
    )
    .bind(
      input.promptTemplate,
      input.cronExpression,
      input.normalizedCron,
      input.name,
      input.nextFireAt,
      input.slackTeamId,
      input.slackChannelId,
      input.updatedAt,
      input.id,
      input.businessId,
    )
    .run();
  return { updated: d1Changed(result) };
}

export async function setScheduledRuleEnabledById(
  db: D1Database,
  input: {
    id: string;
    businessId: string;
    enabled: boolean;
    nextFireAt: number;
    updatedAt: number;
    maxEnabledRules: number;
  },
): Promise<{ updated: boolean }> {
  if (!input.enabled) {
    const result = await db
      .prepare(
        `UPDATE scheduled_rules
         SET enabled = 0, updated_at = ?
         WHERE id = ? AND business_id = ? AND enabled = 1`,
      )
      .bind(input.updatedAt, input.id, input.businessId)
      .run();
    return { updated: d1Changed(result) };
  }

  const result = await db
    .prepare(
      `UPDATE scheduled_rules
       SET enabled = 1, next_fire_at = ?, updated_at = ?
       WHERE id = ? AND business_id = ? AND enabled = 0
         AND (
           SELECT COUNT(*) FROM scheduled_rules
           WHERE business_id = ? AND enabled = 1
         ) < ?`,
    )
    .bind(input.nextFireAt, input.updatedAt, input.id, input.businessId, input.businessId, input.maxEnabledRules)
    .run();
  return { updated: d1Changed(result) };
}

export type ListScheduledRulesOptions = {
  businessId: string;
  /** Encoded cursor: `${createdAt}:${id}`. */
  cursor?: string | null;
  limit: number;
};

export type ListScheduledRulesResult = {
  items: ScheduledRule[];
  nextCursor: string | null;
};

function decodeCursor(cursor: string | null | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(":");
  if (idx <= 0) return null;
  const createdAt = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(createdAt) || id === "") return null;
  return { createdAt, id };
}

function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`;
}

export async function listScheduledRules(
  db: D1Database,
  options: ListScheduledRulesOptions,
): Promise<ListScheduledRulesResult> {
  const decoded = decodeCursor(options.cursor);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const fetchLimit = limit + 1;
  let statement;
  if (decoded) {
    statement = db
      .prepare(
        `SELECT id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id, model_id,
                prompt_template, cron_expression, normalized_cron, name, enabled,
                next_fire_at, last_enqueued_at, created_at, updated_at,
                slack_team_id, slack_channel_id, last_delivered_at, last_delivery_error
         FROM scheduled_rules
         WHERE business_id = ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(options.businessId, decoded.createdAt, decoded.createdAt, decoded.id, fetchLimit);
  } else {
    statement = db
      .prepare(
        `SELECT id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id, model_id,
                prompt_template, cron_expression, normalized_cron, name, enabled,
                next_fire_at, last_enqueued_at, created_at, updated_at,
                slack_team_id, slack_channel_id, last_delivered_at, last_delivery_error
         FROM scheduled_rules
         WHERE business_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(options.businessId, fetchLimit);
  }
  const result = await statement.all<ScheduledRuleRow>();
  const rows = (result.results ?? []).map(rowToScheduledRule);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    rows.length = limit;
    nextCursor = encodeCursor(last.createdAt, last.id);
  }
  return { items: rows, nextCursor };
}

export async function countEnabledScheduledRulesForBusiness(db: D1Database, businessId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as c FROM scheduled_rules WHERE business_id = ? AND enabled = 1")
    .bind(businessId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function countScheduledRulesForBusiness(db: D1Database, businessId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as c FROM scheduled_rules WHERE business_id = ?")
    .bind(businessId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Find rules whose `next_fire_at` is at or before `nowMs`. Bounded by
 * `limit`. Indexed by `idx_scheduled_rules_due`.
 */
export async function listDueScheduledRules(db: D1Database, nowMs: number, limit: number): Promise<ScheduledRule[]> {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id, model_id,
              prompt_template, cron_expression, normalized_cron, name, enabled,
              next_fire_at, last_enqueued_at, created_at, updated_at,
              slack_team_id, slack_channel_id, last_delivered_at, last_delivery_error
       FROM scheduled_rules
       WHERE enabled = 1
         AND next_fire_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM automation_slot_jobs
           WHERE automation_slot_jobs.rule_id = scheduled_rules.id
             AND automation_slot_jobs.terminal_outcome IS NULL
         )
       ORDER BY next_fire_at ASC
       LIMIT ?`,
    )
    .bind(nowMs, bounded)
    .all<ScheduledRuleRow>();
  return (result.results ?? []).map(rowToScheduledRule);
}

/**
 * Atomically claim the firing slot for a rule. Returns true when the CAS
 * succeeded (i.e. this caller is responsible for the firing); false when
 * another caller already claimed the slot or the rule is no longer enabled.
 *
 * The CAS condition `last_enqueued_at IS NULL OR last_enqueued_at < ?slot`
 * is what makes concurrent sweep invocations safe per the ARC-717 history.
 */
export async function claimScheduledRuleFire(
  db: D1Database,
  ruleId: string,
  slotMs: number,
  nextFireAtMs: number,
  nowMs: number,
  jobKey: string,
  sessionId: string,
  promptTemplate: string,
  installationId: number,
): Promise<boolean> {
  const [claim] = await db.batch([
    db
      .prepare(
        `UPDATE scheduled_rules
       SET last_enqueued_at = ?, next_fire_at = ?, updated_at = ?
       WHERE id = ?
         AND enabled = 1
         AND (last_enqueued_at IS NULL OR last_enqueued_at < ?)`,
      )
      .bind(slotMs, nextFireAtMs, nowMs, ruleId, slotMs),
    db
      .prepare(
        `INSERT INTO automation_slot_jobs (
          job_key, rule_id, slot_ms, session_id, prompt_template, installation_id, phase,
          retry_after_ms, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'slot_claimed', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM scheduled_rules
          WHERE id = ? AND last_enqueued_at = ?
        )
        ON CONFLICT(job_key) DO NOTHING`,
      )
      .bind(jobKey, ruleId, slotMs, sessionId, promptTemplate, installationId, slotMs, nowMs, nowMs, ruleId, slotMs),
  ]);
  return d1Changed(claim);
}

export async function listDueAutomationSlotJobs(
  db: D1Database,
  nowMs: number,
  limit: number,
): Promise<AutomationSlotJob[]> {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT job_key, rule_id, slot_ms, session_id, phase, terminal_outcome,
              prompt_template, installation_id, failure_reason, retry_after_ms,
              lease_expires_at, created_at, updated_at
       FROM automation_slot_jobs
       WHERE terminal_outcome IS NULL
         AND retry_after_ms <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(nowMs, nowMs, bounded)
    .all<AutomationSlotJobRow>();
  return (result.results ?? []).map(rowToAutomationSlotJob);
}

export async function getAutomationSlotJob(db: D1Database, jobKey: string): Promise<AutomationSlotJob | null> {
  const row = await db
    .prepare(
      `SELECT job_key, rule_id, slot_ms, session_id, phase, terminal_outcome,
              prompt_template, installation_id, failure_reason, retry_after_ms,
              lease_expires_at, created_at, updated_at
       FROM automation_slot_jobs
       WHERE job_key = ?
       LIMIT 1`,
    )
    .bind(jobKey)
    .first<AutomationSlotJobRow>();
  return row ? rowToAutomationSlotJob(row) : null;
}

export async function insertManualAutomationSlotJob(
  db: D1Database,
  input: {
    jobKey: string;
    ruleId: string;
    slotMs: number;
    sessionId: string;
    promptTemplate: string;
    installationId: number;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO automation_slot_jobs (
        job_key, rule_id, slot_ms, session_id, prompt_template, installation_id, phase,
        retry_after_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'slot_claimed', ?, ?, ?)`,
    )
    .bind(
      input.jobKey,
      input.ruleId,
      input.slotMs,
      input.sessionId,
      input.promptTemplate,
      input.installationId,
      input.createdAt,
      input.createdAt,
      input.createdAt,
    )
    .run();
}

export async function claimAutomationSlotJobLease(
  db: D1Database,
  jobKey: string,
  nowMs: number,
  leaseExpiresAtMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE automation_slot_jobs
       SET lease_expires_at = ?, updated_at = ?
       WHERE job_key = ?
         AND terminal_outcome IS NULL
         AND retry_after_ms <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
    .bind(leaseExpiresAtMs, nowMs, jobKey, nowMs, nowMs)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function updateAutomationSlotJobPhase(
  db: D1Database,
  jobKey: string,
  phase: AutomationSlotJobPhase,
  nowMs: number,
  installationId?: number,
): Promise<void> {
  if (installationId === undefined) {
    await db
      .prepare(
        `UPDATE automation_slot_jobs
         SET phase = ?, updated_at = ?
         WHERE job_key = ? AND terminal_outcome IS NULL`,
      )
      .bind(phase, nowMs, jobKey)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE automation_slot_jobs
       SET phase = ?, installation_id = ?, updated_at = ?
       WHERE job_key = ? AND terminal_outcome IS NULL`,
    )
    .bind(phase, installationId, nowMs, jobKey)
    .run();
}

export async function rescheduleAutomationSlotJob(
  db: D1Database,
  jobKey: string,
  retryAfterMs: number,
  nowMs: number,
  failureReason: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_slot_jobs
       SET retry_after_ms = ?, lease_expires_at = NULL, failure_reason = ?, updated_at = ?
       WHERE job_key = ? AND terminal_outcome IS NULL`,
    )
    .bind(retryAfterMs, failureReason, nowMs, jobKey)
    .run();
}

export async function markAutomationSlotJobTerminal(
  db: D1Database,
  jobKey: string,
  outcome: AutomationSlotJobTerminalOutcome,
  nowMs: number,
  failureReason: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_slot_jobs
       SET terminal_outcome = ?, failure_reason = ?, lease_expires_at = NULL, updated_at = ?
       WHERE job_key = ? AND terminal_outcome IS NULL`,
    )
    .bind(outcome, failureReason, nowMs, jobKey)
    .run();
}

export async function markAutomationSlotJobTerminalAndRestoreSchedule(
  db: D1Database,
  ruleId: string,
  jobKey: string,
  outcome: AutomationSlotJobTerminalOutcome,
  nowMs: number,
  nextFireAtMs: number | null,
  failureReason: string | null = null,
): Promise<void> {
  if (nextFireAtMs === null) {
    await markAutomationSlotJobTerminal(db, jobKey, outcome, nowMs, failureReason);
    return;
  }

  await db.batch([
    db
      .prepare("UPDATE scheduled_rules SET next_fire_at = ?, updated_at = ? WHERE id = ?")
      .bind(nextFireAtMs, nowMs, ruleId),
    db
      .prepare(
        `UPDATE automation_slot_jobs
         SET terminal_outcome = ?, failure_reason = ?, lease_expires_at = NULL, updated_at = ?
         WHERE job_key = ? AND terminal_outcome IS NULL`,
      )
      .bind(outcome, failureReason, nowMs, jobKey),
  ]);
}

/**
 * One historical firing of a scheduled rule, read from `automation_slot_jobs`
 * joined against `session_index`. `outcome` is the scheduler-level terminal
 * outcome (`null` while a slot job is still pending/retrying). `sessionId` /
 * `sessionRichStatus` are non-null only when the fired session's index row
 * still exists — skipped runs never create a session, and offboarding can
 * delete old rows. `sessionRichStatus` is the session's *current* phase, not
 * a durable per-run outcome: archival overwrites it with `archived`.
 */
export type AutomationRun = {
  jobKey: string;
  slotMs: number;
  outcome: AutomationSlotJobTerminalOutcome | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  sessionRichStatus: string | null;
};

type AutomationRunRow = {
  job_key: string;
  slot_ms: number;
  terminal_outcome: AutomationSlotJobTerminalOutcome | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  session_id: string | null;
  session_rich_status: string | null;
};

export type ListAutomationRunsForRuleOptions = {
  ruleId: string;
  /** Encoded cursor: the `slot_ms` of the last run on the previous page. */
  cursor?: string | null;
  limit: number;
};

export type ListAutomationRunsResult = {
  items: AutomationRun[];
  nextCursor: string | null;
};

function rowToAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    jobKey: row.job_key,
    slotMs: row.slot_ms,
    outcome: row.terminal_outcome,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionId: row.session_id,
    sessionRichStatus: row.session_rich_status,
  };
}

/**
 * List a rule's firing history, newest slot first. Keyset-paginated on
 * `slot_ms`, which is unique per rule (`idx_automation_slot_jobs_rule_slot`).
 * Business scoping is NOT applied here — `automation_slot_jobs` has no
 * business column, so callers (the service layer) must first prove the rule
 * belongs to the caller's business via `getScheduledRuleById`.
 */
export async function listAutomationRunsForRule(
  db: D1Database,
  options: ListAutomationRunsForRuleOptions,
): Promise<ListAutomationRunsResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const fetchLimit = limit + 1;
  const cursorSlot = options.cursor != null && /^\d+$/.test(options.cursor) ? Number(options.cursor) : null;
  const statement =
    cursorSlot !== null
      ? db
          .prepare(
            `SELECT j.job_key, j.slot_ms, j.terminal_outcome, j.failure_reason, j.created_at, j.updated_at,
            s.session_id AS session_id, s.rich_status AS session_rich_status
     FROM automation_slot_jobs j
     LEFT JOIN session_index s ON s.session_id = j.session_id
     WHERE j.rule_id = ? AND j.slot_ms < ?
     ORDER BY j.slot_ms DESC
     LIMIT ?`,
          )
          .bind(options.ruleId, cursorSlot, fetchLimit)
      : db
          .prepare(
            `SELECT j.job_key, j.slot_ms, j.terminal_outcome, j.failure_reason, j.created_at, j.updated_at,
            s.session_id AS session_id, s.rich_status AS session_rich_status
     FROM automation_slot_jobs j
     LEFT JOIN session_index s ON s.session_id = j.session_id
     WHERE j.rule_id = ?
     ORDER BY j.slot_ms DESC
     LIMIT ?`,
          )
          .bind(options.ruleId, fetchLimit);
  const result = await statement.all<AutomationRunRow>();
  const rows = (result.results ?? []).map(rowToAutomationRun);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = String(rows[limit - 1].slotMs);
  }
  return { items: rows, nextCursor };
}

/**
 * Scheduler-level run-outcome counts for one rule since `sinceMs`
 * (`created_at >= sinceMs`). Counts only what `terminal_outcome` durably
 * records: `fired` (session created + prompt enqueued), `failed` (gate,
 * session-create, or enqueue failure), and `skipped` (overlap or concurrency
 * cap). Session-level success is intentionally NOT counted here because
 * `session_index.rich_status` is overwritten to `archived` when the sandbox
 * archives, so it cannot back a durable windowed success count.
 */
export type AutomationRunOutcomeCounts = {
  fired: number;
  failed: number;
  skipped: number;
};

export async function countAutomationRunOutcomesForRuleSince(
  db: D1Database,
  ruleId: string,
  sinceMs: number,
): Promise<AutomationRunOutcomeCounts> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN terminal_outcome = 'fired' THEN 1 ELSE 0 END) AS fired,
         SUM(CASE WHEN terminal_outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN terminal_outcome IN ('skipped_overlap', 'skipped_concurrency') THEN 1 ELSE 0 END) AS skipped
       FROM automation_slot_jobs
       WHERE rule_id = ? AND created_at >= ?`,
    )
    .bind(ruleId, sinceMs)
    .first<{ fired: number | null; failed: number | null; skipped: number | null }>();
  return {
    fired: row?.fired ?? 0,
    failed: row?.failed ?? 0,
    skipped: row?.skipped ?? 0,
  };
}

/**
 * Park a rule whose stored cron expression cannot be re-parsed by setting
 * `next_fire_at` far into the future. Keeps the row enabled so an operator
 * sees it in the listing.
 */
export async function parkScheduledRule(
  db: D1Database,
  ruleId: string,
  nextFireAtMs: number,
  nowMs: number,
): Promise<void> {
  await db
    .prepare("UPDATE scheduled_rules SET next_fire_at = ?, updated_at = ? WHERE id = ?")
    .bind(nextFireAtMs, nowMs, ruleId)
    .run();
}

/**
 * Disable a rule durably (installation gone, user inactive, etc.).
 */
export async function disableScheduledRule(db: D1Database, ruleId: string, nowMs: number): Promise<void> {
  await db.prepare("UPDATE scheduled_rules SET enabled = 0, updated_at = ? WHERE id = ?").bind(nowMs, ruleId).run();
}

/**
 * Record the outcome of a Slack delivery attempt for a scheduled rule.
 * On success pass `{ deliveredAt: nowMs, error: null }` (clears any prior
 * error); on failure pass `{ deliveredAt: null, error: "<reason>" }` (the
 * COALESCE preserves the last successful delivery timestamp). Observability
 * only — delivery status never gates or disables the rule.
 */
export async function recordScheduledRuleDelivery(
  db: D1Database,
  ruleId: string,
  nowMs: number,
  outcome: { deliveredAt: number | null; error: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE scheduled_rules
       SET last_delivered_at = COALESCE(?, last_delivered_at),
           last_delivery_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(outcome.deliveredAt, outcome.error, nowMs, ruleId)
    .run();
}

/**
 * rich_status values treated as terminal for overlap and concurrency checks.
 * Re-exported from the canonical shared `TERMINAL_PHASES_ARRAY` so a new
 * terminal phase added in one place automatically updates the SQL filters.
 */
export const TERMINAL_RICH_STATUSES = TERMINAL_PHASES_ARRAY;

/**
 * Return true when at least one prior session for this scheduled rule is
 * still non-terminal (i.e. should suppress the next firing).
 */
export async function hasInFlightSessionForRule(db: D1Database, scheduledRuleId: string): Promise<boolean> {
  const placeholders = TERMINAL_RICH_STATUSES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT 1 as c FROM session_index
       WHERE scheduled_rule_id = ?
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))
       LIMIT 1`,
    )
    .bind(scheduledRuleId, ...TERMINAL_RICH_STATUSES)
    .first<{ c: number }>();
  return row !== null;
}

/**
 * Count non-terminal automation sessions for a business. Used to enforce the
 * per-business concurrency cap.
 */
export async function countActiveAutomationSessionsForBusiness(db: D1Database, businessId: string): Promise<number> {
  const placeholders = TERMINAL_RICH_STATUSES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c FROM session_index
       WHERE business_id = ?
         AND initiation_mode = 'automation'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))`,
    )
    .bind(businessId, ...TERMINAL_RICH_STATUSES)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
