/**
 * Scheduled-automation tick. Invoked from the existing every-5-minute
 * control-plane cron sweep (see `router.ts:scheduled()`). Do not register
 * a separate cron trigger — ARC-717 history at `wrangler.toml`.
 *
 * Per-tick algorithm:
 *  1. Find rules whose `next_fire_at <= now` (`listDueScheduledRules`).
 *  2. For each rule: atomically claim the firing slot via CAS, recompute
 *     `next_fire_at` from the stored cron (park on parse failure).
 *  3. Re-validate authorization at fire time via `gateGithubSessionStart`.
 *     - Durable failure (e.g. installation suspended) → disable rule.
 *     - Transient failure (provider unavailable) → leave enabled, retry next sweep.
 *  4. Skip if a prior session for the same rule is still in-flight.
 *  5. Skip if per-business concurrency cap is reached.
 *  6. Create the session and enqueue the stored prompt, threading the four
 *     provenance fields so the projection and PR-body footer can render
 *     scheduled-run badging downstream.
 */
import { DEFAULT_SESSION_START_MODEL_ID } from "../../../../shared/constants/models.js";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../../../shared/enums/integration-lifecycle.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  AUTOMATION_MAX_CONCURRENT_SESSIONS_PER_BUSINESS,
  AUTOMATION_PER_TICK_RULE_BUDGET,
} from "../constants/automation";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import { emitAutomationSlackDeliveryMetric } from "../observability/automation-metrics";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { gateGithubSessionStart } from "../services/integration-gating";
import { isOpencodeAccessDeniedError, OPENCODE_ACCESS_DENIED_ERROR } from "../services/opencode-access-gate";
import { initializeAndProjectSession, SessionCreateError } from "../services/session-create";
import { resolveBaseModelForAutomaticRouting } from "../services/session-model-routing";
import { buildSyncRichStatusStatement } from "../session/db";
import { enqueueSessionPrompt, listSessionPrompts } from "../session/state";
import { resolveInstalledSlackBotToken } from "../slack/tokens";
import type { CallbackContext, Env, InternalAuthContext } from "../types";
import { computeNextFireAt, CronValidationError, parseCronExpression } from "./cron";
import {
  type AutomationSlotJob,
  type AutomationSlotJobTerminalOutcome,
  claimAutomationSlotJobLease,
  claimScheduledRuleFire,
  countActiveAutomationSessionsForBusiness,
  disableScheduledRule,
  getAutomationSlotJob,
  getScheduledRuleByIdForScheduler,
  hasInFlightSessionForRule,
  listDueAutomationSlotJobs,
  listDueScheduledRules,
  markAutomationSlotJobTerminal,
  markAutomationSlotJobTerminalAndRestoreSchedule,
  parkScheduledRule,
  recordScheduledRuleDelivery,
  rescheduleAutomationSlotJob,
  type ScheduledRule,
  updateAutomationSlotJobPhase,
} from "./db";
import { scheduledAutomationPromptEquals, splitScheduledAutomationPrompt } from "./prompt";

const log = createLogger({ bindings: { component: "automation-scheduler" } });

const SLOT_MS = 60_000;
const PARK_FAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year
const SLOT_JOB_LEASE_MS = 10 * 60 * 1000;

export type AutomationSchedulerTickOptions = {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Per-tick cap on rules processed. Defaults to constant. */
  limit?: number;
};

export type AutomationSchedulerTickReport = {
  scanned: number;
  fired: number;
  skippedOverlap: number;
  skippedConcurrency: number;
  parkedInvalidCron: number;
  disabledDurable: number;
  transientFailures: number;
  createFailures: number;
};

function emptySchedulerReport(): AutomationSchedulerTickReport {
  return {
    scanned: 0,
    fired: 0,
    skippedOverlap: 0,
    skippedConcurrency: 0,
    parkedInvalidCron: 0,
    disabledDurable: 0,
    transientFailures: 0,
    createFailures: 0,
  };
}

/**
 * Run one scheduling pass. Idempotent across concurrent invocations: the
 * atomic CAS on `last_enqueued_at` is what makes overlapping sweeps safe.
 */
export async function automationSchedulerTick(
  env: Env,
  options: AutomationSchedulerTickOptions = {},
): Promise<AutomationSchedulerTickReport> {
  const now = options.now?.() ?? Date.now();
  const limit = options.limit ?? AUTOMATION_PER_TICK_RULE_BUDGET;
  const report = emptySchedulerReport();

  const db = env.DB;
  if (!db) {
    log.warn({}, "automation_scheduler_db_missing");
    return report;
  }

  const pendingJobs = await listDueAutomationSlotJobs(db, now, limit);
  for (const job of pendingJobs) {
    try {
      await processSlotJob(env, job, now, report);
    } catch (err) {
      log.error(
        { jobKey: job.jobKey, ruleId: job.ruleId, slot: job.slotMs, error: String(err) },
        "automation_slot_job_unhandled_error",
      );
      // Console logs are not shipped to Datadog (logpush off); a permanent rule
      // error would otherwise repeat every tick with no queryable signal.
      emitAutomationSchedulerEvent(env, {
        event: "automation.scheduler_error",
        stage: "slot_job",
        rule_id: job.ruleId,
        error: String(err),
      });
    }
  }

  const remainingLimit = Math.max(0, limit - pendingJobs.length);
  const due = remainingLimit > 0 ? await listDueScheduledRules(db, now, remainingLimit) : [];
  report.scanned = pendingJobs.length + due.length;

  for (const rule of due) {
    try {
      await processRule(env, rule, now, report);
    } catch (err) {
      // Final safety net: never let one rule crash the sweep.
      log.error(
        { ruleId: rule.id, businessId: rule.businessId, error: String(err) },
        "automation_scheduler_unhandled_rule_error",
      );
      // Console logs are not shipped to Datadog (logpush off); a permanent rule
      // error would otherwise repeat every tick with no queryable signal.
      emitAutomationSchedulerEvent(env, {
        event: "automation.scheduler_error",
        stage: "rule",
        rule_id: rule.id,
        business_id: rule.businessId,
        error: String(err),
      });
    }
  }

  log.info({ ...report, now }, "automation_scheduler_tick_complete");
  return report;
}

async function processRule(
  env: Env,
  rule: ScheduledRule,
  now: number,
  report: AutomationSchedulerTickReport,
): Promise<void> {
  const db = env.DB;
  const slot = Math.floor(now / SLOT_MS) * SLOT_MS;
  const sessionId = buildAutomationSessionId(rule.id, slot);
  const jobKey = buildAutomationSlotJobKey(rule.id, slot);

  // Recompute next_fire_at from the rule's stored cron. Parse failure parks
  // the rule without crashing sibling rules.
  let nextFireAtAfterSlot: number;
  try {
    const parsed = parseCronExpression(rule.cronExpression);
    nextFireAtAfterSlot = computeNextFireAt(parsed, slot + SLOT_MS);
  } catch (err) {
    if (err instanceof CronValidationError) {
      await parkScheduledRule(db, rule.id, now + PARK_FAR_FUTURE_MS, now);
      log.error(
        { ruleId: rule.id, businessId: rule.businessId, reason: err.reason },
        "automation_rule_parked_invalid_cron",
      );
      report.parkedInvalidCron += 1;
      return;
    }
    throw err;
  }

  // Atomic CAS claim. Wins exactly once per slot across concurrent sweeps.
  // After this point `next_fire_at` is already advanced to the next cron
  // period and `last_enqueued_at` is set to this slot, so any later return
  // path silently drops *this slot's* firing — durable disable / overlap
  // skip / concurrency cap are intentional drops (next_fire_at advances by
  // design). Transient gate retries are driven by the durable slot job, so a
  // later sweep keeps retrying this slot instead of minting a fresh one.
  const claimed = await claimScheduledRuleFire(
    db,
    rule.id,
    slot,
    nextFireAtAfterSlot,
    now,
    jobKey,
    sessionId,
    rule.promptTemplate,
    rule.installationId,
  );
  if (!claimed) {
    log.info({ ruleId: rule.id, slot }, "automation_enqueue_skipped_duplicate");
    return;
  }

  const job = await getAutomationSlotJob(db, jobKey);
  if (!job) {
    log.error({ ruleId: rule.id, slot, jobKey }, "automation_slot_job_missing_after_claim");
    report.createFailures += 1;
    return;
  }
  await processSlotJob(env, job, now, report, { nextFireAtAfterSlot });
}

async function processSlotJob(
  env: Env,
  job: AutomationSlotJob,
  now: number,
  report: AutomationSchedulerTickReport,
  context: { nextFireAtAfterSlot?: number | null } = {},
): Promise<void> {
  const db = env.DB;
  const leaseClaimed = await claimAutomationSlotJobLease(db, job.jobKey, now, now + SLOT_JOB_LEASE_MS);
  if (!leaseClaimed) {
    log.info({ jobKey: job.jobKey, ruleId: job.ruleId, slot: job.slotMs }, "automation_slot_job_lease_skipped");
    return;
  }

  const latestJob = await getAutomationSlotJob(db, job.jobKey);
  if (!latestJob || latestJob.terminalOutcome) return;
  const rule = await getScheduledRuleByIdForScheduler(db, latestJob.ruleId);
  if (!rule) {
    await markAutomationSlotJobTerminal(db, latestJob.jobKey, "failed", now, "rule_missing");
    log.warn({ jobKey: latestJob.jobKey, ruleId: latestJob.ruleId }, "automation_slot_job_failed_rule_missing");
    report.createFailures += 1;
    return;
  }

  await runSlotJobPhases(env, rule, latestJob, now, report, context);
}

/** Execute a manually-created slot job through the normal scheduler pipeline. */
export async function runManualAutomationSlotJob(
  env: Env,
  job: AutomationSlotJob,
  now: number,
): Promise<AutomationSlotJob | null> {
  await processSlotJob(env, job, now, emptySchedulerReport(), { nextFireAtAfterSlot: null });
  return getAutomationSlotJob(env.DB, job.jobKey);
}

/**
 * When a scheduled rule has a Slack delivery channel, post a top-level
 * "starting" message and synthesize the `source:"slack"` callbackContext so the
 * session's normal completion path (`trackSlackThreadNotification`) delivers the
 * agent's final text as a threaded reply under it. The starting message's `ts`
 * is used as both `threadTs` (the reply target) and `statusMessageTs`.
 *
 * Fails OPEN and LOUD: any failure — workspace disconnected, bot removed from
 * the channel, transient Slack error — records the delivery error, emits a
 * metric, and returns null so the session still runs (it just doesn't deliver
 * this fire). Never throws; a delivery-setup problem must not fail the session.
 */
async function synthesizeSlackDeliveryContext(
  env: Env,
  rule: ScheduledRule,
  now: number,
): Promise<CallbackContext | null> {
  if (!rule.slackChannelId || !rule.slackTeamId) return null;
  const channel = rule.slackChannelId;
  const teamId = rule.slackTeamId;

  const recordFailure = async (outcome: "workspace_not_connected" | "post_failed", detail: string) => {
    await recordScheduledRuleDelivery(env.DB, rule.id, now, { deliveredAt: null, error: detail });
    await emitAutomationSlackDeliveryMetric(env, outcome);
    log.warn(
      { ruleId: rule.id, businessId: rule.businessId, channel, outcome, detail },
      "automation_slack_delivery_failed",
    );
  };

  try {
    // Verify the workspace is still connected before the session runs (early,
    // fail-closed detection), but do NOT post a starting message. A scheduled
    // automation delivers only its final digest as a single plain top-level
    // message at completion (see notifySlackThread's scheduled-automation
    // branch). Returning no threadTs/statusMessageTs makes that completion post
    // to the channel top-level — no session-status card, no thread.
    const token = await resolveInstalledSlackBotToken(env, teamId);
    if (!token) {
      await recordFailure("workspace_not_connected", "workspace_not_connected");
      return null;
    }
    return { source: "slack", channel, slackTeamId: teamId };
  } catch (err) {
    // Defensive: never let a delivery-setup error abort session creation — but
    // still record it loudly (metric + last_delivery_error) so a thrown
    // postMessage (network error, non-JSON response) is not silent on the
    // delivery-status / monitoring surfaces, matching the { ok:false } path.
    const detail = stringifyError(err);
    await recordFailure("post_failed", `post_threw:${detail}`).catch((recErr) =>
      log.warn({ ruleId: rule.id, error: String(recErr) }, "automation_slack_delivery_record_failed"),
    );
    return null;
  }
}

async function runSlotJobPhases(
  env: Env,
  rule: ScheduledRule,
  job: AutomationSlotJob,
  now: number,
  report: AutomationSchedulerTickReport,
  context: { nextFireAtAfterSlot?: number | null },
): Promise<void> {
  const db = env.DB;
  const slot = job.slotMs;
  const sessionId = job.sessionId;
  const nextFireAtAfterSlot = job.jobKey.startsWith("automation:manual:")
    ? null
    : context.nextFireAtAfterSlot === undefined
      ? computeNextFireAtAfterSlot(rule, slot)
      : context.nextFireAtAfterSlot;

  // Re-validate authorization at fire time. Durable failures disable the rule;
  // transient failures leave the claimed slot job pending for a later retry.
  let installationId = job.installationId;
  if (job.phase === "slot_claimed") {
    const gate = await gateGithubSessionStart(env, {
      userId: rule.configuredByUserId,
      businessId: rule.businessId,
      sessionId,
      repoOwner: rule.repoOwner,
      repoName: rule.repoName,
    });
    if (!gate.ok) {
      const reason = gate.body.reasonCode;
      if (isDurableGateFailure(reason)) {
        await disableScheduledRule(db, rule.id, now);
        await markAutomationSlotJobTerminal(db, job.jobKey, "failed", now, reason);
        log.warn(
          {
            jobKey: job.jobKey,
            ruleId: rule.id,
            businessId: rule.businessId,
            reasonCode: reason,
            stage: gate.body.stage,
          },
          "automation_slot_job_failed_durable_gate",
        );
        emitAutomationSchedulerEvent(env, {
          event: "automation.rule_disabled",
          rule_id: rule.id,
          business_id: rule.businessId,
          reason_code: reason,
          stage: gate.body.stage,
        });
        report.disabledDurable += 1;
      } else {
        await rescheduleAutomationSlotJob(db, job.jobKey, now + SLOT_MS, now, reason);
        log.warn(
          {
            jobKey: job.jobKey,
            ruleId: rule.id,
            businessId: rule.businessId,
            reasonCode: reason,
            stage: gate.body.stage,
          },
          "automation_slot_job_transient_gate_retry",
        );
        report.transientFailures += 1;
      }
      return;
    }
    installationId = gate.installationId;
    await updateAutomationSlotJobPhase(db, job.jobKey, "gate_revalidated", now, installationId);
    log.info({ jobKey: job.jobKey, ruleId: rule.id, slot }, "automation_slot_job_gate_revalidated");
  }

  // Skip if a prior session for this rule is still in-flight.
  if (job.phase === "slot_claimed" || job.phase === "gate_revalidated") {
    if (await hasInFlightSessionForRule(db, rule.id)) {
      await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "skipped_overlap", now, nextFireAtAfterSlot);
      log.info({ jobKey: job.jobKey, ruleId: rule.id }, "automation_slot_job_skipped_overlap");
      report.skippedOverlap += 1;
      return;
    }

    // Skip if per-business concurrency cap is reached.
    const activeCount = await countActiveAutomationSessionsForBusiness(db, rule.businessId);
    if (activeCount >= AUTOMATION_MAX_CONCURRENT_SESSIONS_PER_BUSINESS) {
      await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "skipped_concurrency", now, nextFireAtAfterSlot);
      log.warn(
        { jobKey: job.jobKey, ruleId: rule.id, businessId: rule.businessId, activeCount },
        "automation_slot_job_skipped_concurrency_cap",
      );
      report.skippedConcurrency += 1;
      return;
    }
    await updateAutomationSlotJobPhase(db, job.jobKey, "checks_passed", now);
    log.info({ jobKey: job.jobKey, ruleId: rule.id, slot }, "automation_slot_job_checks_passed");
  }

  // Two-step session create + prompt enqueue.
  const promptTemplate = job.promptTemplate;
  const scheduledPrompt = splitScheduledAutomationPrompt(promptTemplate);
  const ruleNameSnapshot = rule.name ?? `${rule.repoOwner}/${rule.repoName} @ ${rule.normalizedCron}`;
  const cronSnapshot = rule.normalizedCron;
  // Honor the rule's pinned model when set (e.g. claude-opus-4-8); otherwise the
  // backend default. resolveBaseModelForAutomaticRouting derives the agent runtime
  // backend from the model, and createSessionState persists it — so a Claude model
  // runs the scheduled session on claude_code, not the codex default.
  const baseModel = resolveBaseModelForAutomaticRouting(rule.modelId ?? DEFAULT_SESSION_START_MODEL_ID);

  const auth: InternalAuthContext = {
    userId: rule.configuredByUserId,
    canAccessAllSessions: false,
    businessId: rule.businessId,
  };

  if (job.phase === "prompt_enqueued") {
    await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "fired", now, nextFireAtAfterSlot);
    log.info({ jobKey: job.jobKey, ruleId: rule.id, sessionId }, "automation_slot_job_prompt_checkpoint_recovered");
    report.fired += 1;
    return;
  }

  if (job.phase !== "session_projected") {
    // Set up Slack delivery (if configured) before the session is created so
    // the synthesized callbackContext is persisted with the session and picked
    // up by the completion path. Fails open: a null context means no delivery.
    const slackCallbackContext = await synthesizeSlackDeliveryContext(env, rule, now);
    try {
      await initializeAndProjectSession(env, {
        sessionId,
        ownerUserId: rule.configuredByUserId,
        sessionKind: "repo",
        repoContext: { repoOwner: rule.repoOwner, repoName: rule.repoName },
        auth,
        installationId,
        model: baseModel.currentModel,
        reasoningEffort: null,
        projectionSource: "automation.scheduler",
        projectionUserId: rule.configuredByUserId,
        initiationMode: InitiationMode.AUTOMATION,
        entrypoint: SessionEntrypoint.SCHEDULED,
        scheduledRuleId: rule.id,
        ruleNameSnapshot,
        cronSnapshot,
        ...(slackCallbackContext ? { callbackContext: slackCallbackContext } : {}),
      });
      await updateAutomationSlotJobPhase(db, job.jobKey, "session_projected", now);
      log.info({ jobKey: job.jobKey, ruleId: rule.id, sessionId }, "automation_slot_job_session_projected");
    } catch (err) {
      const stage = err instanceof SessionCreateError ? err.stage : "unknown";
      const opencodeDenied = isOpencodeAccessDeniedError(err);
      const terminalReason = opencodeDenied
        ? `session_create_${OPENCODE_ACCESS_DENIED_ERROR}`
        : `session_create_${stage}`;
      if (opencodeDenied) {
        await disableScheduledRule(db, rule.id, now);
        await markAutomationSlotJobTerminal(db, job.jobKey, "failed", now, terminalReason);
      } else {
        await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "failed", now, nextFireAtAfterSlot, terminalReason);
      }
      await markOrphanedAutomationSessionFailed(db, sessionId, rule.id);
      log.error(
        {
          jobKey: job.jobKey,
          ruleId: rule.id,
          businessId: rule.businessId,
          sessionId,
          stage,
          error: String(err),
        },
        "automation_slot_job_session_create_failed",
      );
      emitAutomationSchedulerEvent(env, {
        event: "automation.session_create_failed",
        rule_id: rule.id,
        business_id: rule.businessId,
        session_id: sessionId,
        stage: opencodeDenied ? OPENCODE_ACCESS_DENIED_ERROR : stage,
        reason: terminalReason,
      });
      if (opencodeDenied) report.disabledDurable += 1;
      report.createFailures += 1;
      return;
    }
  }

  if (await hasMatchingAutomationPrompt(env, sessionId, scheduledPrompt, rule.configuredByUserId, auth)) {
    await updateAutomationSlotJobPhase(db, job.jobKey, "prompt_enqueued", now);
    await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "fired", now, nextFireAtAfterSlot);
    log.info({ jobKey: job.jobKey, ruleId: rule.id, sessionId }, "automation_slot_job_prompt_already_enqueued");
    report.fired += 1;
    return;
  }

  const enqueue = await enqueueSessionPrompt(env, sessionId, scheduledPrompt.prompt, rule.configuredByUserId, {
    auth,
    ...(scheduledPrompt.skills?.length ? { skills: scheduledPrompt.skills } : {}),
  });
  if (!enqueue.ok) {
    await markSlotJobTerminalAndRestoreSchedule(
      db,
      rule,
      job,
      "failed",
      now,
      nextFireAtAfterSlot,
      `prompt_enqueue_${enqueue.status}`,
    );
    await markOrphanedAutomationSessionFailed(db, sessionId, rule.id);
    log.error(
      {
        jobKey: job.jobKey,
        ruleId: rule.id,
        businessId: rule.businessId,
        sessionId,
        status: enqueue.status,
      },
      "automation_slot_job_prompt_enqueue_failed",
    );
    emitAutomationSchedulerEvent(env, {
      event: "automation.prompt_enqueue_failed",
      rule_id: rule.id,
      business_id: rule.businessId,
      session_id: sessionId,
      stage: "prompt_enqueue",
      reason: `prompt_enqueue_${enqueue.status}`,
    });
    report.createFailures += 1;
    return;
  }
  await updateAutomationSlotJobPhase(db, job.jobKey, "prompt_enqueued", now);
  await markSlotJobTerminalAndRestoreSchedule(db, rule, job, "fired", now, nextFireAtAfterSlot);

  log.info(
    {
      jobKey: job.jobKey,
      ruleId: rule.id,
      businessId: rule.businessId,
      sessionId,
      slot,
      nextFireAtAfterSlot,
    },
    "automation_slot_job_fired",
  );
  report.fired += 1;
}

function buildAutomationSessionId(ruleId: string, slot: number): string {
  return `automation-${ruleId}-${slot}`;
}

function buildAutomationSlotJobKey(ruleId: string, slot: number): string {
  return `automation:${ruleId}:${slot}`;
}

function computeNextFireAtAfterSlot(rule: ScheduledRule, slot: number): number | null {
  try {
    return computeNextFireAt(parseCronExpression(rule.cronExpression), slot + SLOT_MS);
  } catch (err) {
    if (err instanceof CronValidationError) return null;
    throw err;
  }
}

async function markSlotJobTerminalAndRestoreSchedule(
  db: D1Database,
  rule: ScheduledRule,
  job: AutomationSlotJob,
  outcome: AutomationSlotJobTerminalOutcome,
  now: number,
  nextFireAtAfterSlot: number | null,
  failureReason: string | null = null,
): Promise<void> {
  await markAutomationSlotJobTerminalAndRestoreSchedule(
    db,
    rule.id,
    job.jobKey,
    outcome,
    now,
    nextFireAtAfterSlot,
    failureReason,
  );
}

/**
 * Classify a gate failure as durable (rule should be disabled) vs transient
 * (rule stays enabled, retry on the next sweep). Uses the canonical
 * lifecycle reason codes returned by `gateGithubSessionStart` /
 * `runPreflightProbe`. Anything not listed here is treated as transient so a
 * provider blip never silently disables a healthy customer rule.
 */
const DURABLE_GATE_REASON_CODES: ReadonlySet<string> = new Set([
  INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED,
  INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
  INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
  INTEGRATION_LIFECYCLE_REASON_CODE.ORG_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED,
  INTEGRATION_LIFECYCLE_REASON_CODE.OAUTH_CALLBACK_USER_MISMATCH,
  INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
]);

function isDurableGateFailure(reasonCode: string): boolean {
  return DURABLE_GATE_REASON_CODES.has(reasonCode);
}

function emitAutomationSchedulerEvent(env: Env, event: { event: string } & Record<string, unknown>): void {
  void postStructuredEventToDd(env, event).catch((error) => {
    log.warn(
      {
        event: event.event,
        ruleId: typeof event.rule_id === "string" ? event.rule_id : undefined,
        error: String(error),
      },
      "automation_scheduler_event_export_failed",
    );
    return false;
  });
}

async function markOrphanedAutomationSessionFailed(db: D1Database, sessionId: string, ruleId: string): Promise<void> {
  try {
    await buildSyncRichStatusStatement(db, sessionId, "failed").statement.run();
  } catch (err) {
    // Cleanup failure is non-fatal — the orphan only suppresses future firings
    // of this rule, not the whole sweep. Log loudly so an operator can manually
    // remediate by setting rich_status='failed' on the session_index row.
    log.error({ sessionId, ruleId, error: String(err) }, "automation_session_orphan_cleanup_failed");
  }
}

async function hasMatchingAutomationPrompt(
  env: Env,
  sessionId: string,
  scheduledPrompt: { prompt: string; skills?: string[] },
  actorUserId: string,
  auth: InternalAuthContext,
): Promise<boolean> {
  const prompts = await listSessionPrompts(env, sessionId, { auth });
  if (!prompts.ok || !prompts.payload) return false;
  return prompts.payload.prompts.some(
    (prompt) =>
      prompt.actorUserId === actorUserId &&
      scheduledAutomationPromptEquals(scheduledPrompt, {
        prompt: prompt.prompt,
        ...(prompt.skills?.length ? { skills: prompt.skills } : {}),
      }),
  );
}
