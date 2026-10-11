import {
  DEFAULT_SESSION_START_MODEL_ID,
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { wrapUserContent } from "../../../../shared/utils/prompt-safety.js";
import { isTransientDurableObjectInternalError } from "../db/errors";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { gateGithubSessionStart } from "../services/integration-gating";
import { isOpencodeAccessDeniedError, OPENCODE_ACCESS_DENIED_ERROR } from "../services/opencode-access-gate";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import { initializeAndProjectSession } from "../services/session-create";
import { buildSyncRichStatusStatement } from "../session/db";
import { enqueueSessionPrompt, updateSessionCallbackContext } from "../session/state";
import { getUserSettingsIfExists } from "../settings/db";
import { buildStatusBlocks, buildStatusFallbackText } from "../slack/blocks";
import { postThreadReply } from "../slack/notify";
import type { CallbackContext, Env, InternalAuthContext } from "../types";
import { SlackThreadAlreadyClaimedError } from "../webhooks/db";
import {
  type AutomationRule,
  claimAutomationEventJob,
  countOpenAutomationEventJobsForBusiness,
  findEnabledSlackChannelAutomationRules,
  insertAutomationEventJobIfNotExists,
  insertSkippedAutomationEventJobIfNotExists,
  listRecentSlackChannelAutomationJobsForDuplicateScan,
  markAutomationEventJobTerminal,
  updateAutomationEventJobPhase,
} from "./db";
import {
  evaluateSlackChannelAutomationTrigger,
  type SlackChannelAutomationEvent,
  type SlackChannelAutomationTriggerResult,
} from "./slack-channel-trigger";

const log = createLogger({ bindings: { component: "slack-channel-automation" } });
export const SLACK_CHANNEL_AUTOMATION_TEXT_MAX_CHARS = 4000;
export const SLACK_CHANNEL_AUTOMATION_MAX_RULES_PER_EVENT = 5;
export const SLACK_CHANNEL_AUTOMATION_MAX_OPEN_JOBS_PER_BUSINESS = 25;
export const SLACK_CHANNEL_AUTOMATION_DUPLICATE_SUPPRESSION_WINDOW_MS = 60_000;
const SLACK_CHANNEL_AUTOMATION_DUPLICATE_SCAN_LIMIT = 50;
const SLACK_CHANNEL_AUTOMATION_DUPLICATE_MIN_SIGNATURE_CHARS = 24;
const SLACK_CHANNEL_AUTOMATION_PLATFORM_ESCALATION_MENTIONS = "<@U0AHJCUSM70> <@U0AHT782S65>";
const SLACK_CHANNEL_AUTOMATION_ERROR_PREVIEW_CHARS = 400;

type GateGithubSessionStart = typeof gateGithubSessionStart;
type InitializeAndProjectSession = typeof initializeAndProjectSession;
type EnqueueSessionPrompt = typeof enqueueSessionPrompt;
type PostThreadReply = typeof postThreadReply;
type ResolveSlackBotToken = () => Promise<string | null>;

export type SlackChannelAutomationOutcome =
  | "no_rules"
  | "ignored"
  | "duplicate"
  | "duplicate_alert"
  | "missing_token"
  | "missing_config"
  | "backpressure"
  | "resolved_alert"
  | "repo_gate_failed"
  | "session_create_failed"
  | "thread_already_claimed"
  | "enqueue_failed"
  | "session_enqueued";

export type ProcessSlackChannelAutomationEventResult = {
  processed: number;
  outcomes: Array<{ ruleId: string; outcome: SlackChannelAutomationOutcome; jobId?: string; sessionId?: string }>;
};

export type ProcessSlackChannelAutomationEventDeps = {
  gateGithubSessionStart?: GateGithubSessionStart;
  initializeAndProjectSession?: InitializeAndProjectSession;
  enqueueSessionPrompt?: EnqueueSessionPrompt;
  postThreadReply?: PostThreadReply;
  makeId?: () => string;
  now?: () => number;
};

export type ProcessSlackChannelAutomationEventInput = {
  env: Env;
  businessId: string;
  slackBotToken?: string | null;
  resolveSlackBotToken?: ResolveSlackBotToken;
  event: SlackChannelAutomationEvent;
  rawPayloadJson: string;
  deps?: ProcessSlackChannelAutomationEventDeps;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stableSlackTsFragment(ts: string): string {
  return ts.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function buildJobId(ruleId: string, slackMessageTs: string): string {
  return `slack-auto-${ruleId}-${stableSlackTsFragment(slackMessageTs)}`;
}

function buildSessionId(ruleId: string, slackMessageTs: string): string {
  return `automation-${ruleId}-${stableSlackTsFragment(slackMessageTs)}`;
}

function buildIdempotencyKey(ruleId: string, event: SlackChannelAutomationEvent): string {
  const teamId = nonEmptyString(event.team) ?? "unknown-team";
  const channelId = nonEmptyString(event.channel) ?? "unknown-channel";
  const ts = nonEmptyString(event.ts) ?? "unknown-ts";
  return `slack:${teamId}:${channelId}:${ts}:${ruleId}`;
}

function toTriggerResult(
  rule: AutomationRule,
  event: SlackChannelAutomationEvent,
): SlackChannelAutomationTriggerResult {
  return evaluateSlackChannelAutomationTrigger(event, {
    teamId: rule.slackTeamId,
    channelId: rule.slackChannelId,
    botUserId: rule.slackBotUserId,
    allowedAppIds: rule.allowedSlackAppIds,
    allowedBotIds: rule.allowedSlackBotIds,
  });
}

function boundedText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function isDurableObjectInitializeFailure(errorText: string): boolean {
  return (
    /session-create initialize failed/i.test(errorText) &&
    (/\bDurable Object\b/i.test(errorText) || isTransientDurableObjectInternalError(errorText))
  );
}

function renderSessionCreateFailureReply(error: unknown): string {
  if (isOpencodeAccessDeniedError(error)) {
    return "Cycloid could not start this automation session because opencode is only available to Cycloid team members.";
  }

  const errorText = String(error);
  if (isDurableObjectInitializeFailure(errorText)) {
    return [
      "Cycloid could not start this automation session because the Session Durable Object initialize step failed with a Cloudflare internal/storage reset.",
      `${SLACK_CHANNEL_AUTOMATION_PLATFORM_ESCALATION_MENTIONS} please investigate the session-start path.`,
    ].join(" ");
  }

  return [
    "Cycloid could not start this automation session before the alert prompt was enqueued.",
    `${SLACK_CHANNEL_AUTOMATION_PLATFORM_ESCALATION_MENTIONS} please investigate the session-start path.`,
    `Startup error: ${boundedText(errorText, SLACK_CHANNEL_AUTOMATION_ERROR_PREVIEW_CHARS)}`,
  ].join(" ");
}

// Datadog Slack messages carry an empty top-level `text`; the status and body
// live in `attachments`. A recovery is identifiable two ways, checked in order
// of robustness:
//   1. attachments[].metadata.event_payload.transition_type contains "recovery"
//      (e.g. "alert recovery", "warning recovery") - structured and locale-proof.
//   2. attachments[].title / .fallback begins with the status prefix Datadog
//      renders, "Recovered:" or "Resolved:" (e.g. "Recovered: [Sandbox Bridge]
//      Git push to origin failing"). Firing alerts use "Triggered:".
// The prefix is anchored so a monitor whose *name* mentions "resolved" does not
// trip the filter. A top-level `text` check is kept as a last-resort fallback
// for any non-attachment / custom message format.
const RECOVERED_STATUS_PREFIX = /^\s*\[?\s*(?:recovered|resolved)\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isRecoveryTransition(attachment: Record<string, unknown>): boolean {
  const metadata = asRecord(attachment.metadata);
  const payload = metadata && asRecord(metadata.event_payload);
  const transition = payload ? nonEmptyString(payload.transition_type) : null;
  return Boolean(transition && /recovery/i.test(transition));
}

function isRecoveredStatusText(value: unknown): boolean {
  const text = nonEmptyString(value);
  return Boolean(text && RECOVERED_STATUS_PREFIX.test(text));
}

function isDatadogRecoveredAlert(event: SlackChannelAutomationEvent): boolean {
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  for (const raw of attachments) {
    const attachment = asRecord(raw);
    if (!attachment) continue;
    if (isRecoveryTransition(attachment)) return true;
    if (isRecoveredStatusText(attachment.title) || isRecoveredStatusText(attachment.fallback)) return true;
  }
  return false;
}

function startsWithAlertState(text: string, states: readonly string[]): boolean {
  const statePattern = states.join("|");
  return new RegExp(`^(?:\\[(?:${statePattern})\\]|(?:${statePattern})(?:\\s*[:\\-]|\\s*$))`, "i").test(text);
}

function startsWithSubjectState(text: string, subjects: readonly string[], states: readonly string[]): boolean {
  const subjectPattern = subjects.join("|");
  const statePattern = states.join("|");
  return new RegExp(`^(?:${subjectPattern})\\s+(?:${statePattern})(?:\\s*[:\\-]|\\s*$)`, "i").test(text);
}

export function isResolvedSlackAlertMessage(
  provider: AutomationRule["triggerProvider"],
  event: SlackChannelAutomationEvent,
): boolean {
  const text = nonEmptyString(event.text);

  switch (provider) {
    case "datadog":
      if (isDatadogRecoveredAlert(event)) return true;
      if (!text) return false;
      return (
        startsWithAlertState(text, ["recovered", "resolved"]) ||
        startsWithSubjectState(text, ["alert", "monitor"], ["recovered", "resolved"])
      );
    case "sentry":
      if (!text) return false;
      return startsWithAlertState(text, ["resolved"]) || startsWithSubjectState(text, ["issue"], ["resolved"]);
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function renderProviderLabel(provider: AutomationRule["triggerProvider"]): string {
  switch (provider) {
    case "datadog":
      return "Datadog";
    case "sentry":
      return "Sentry";
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

async function resolveSlackBotToken(input: ProcessSlackChannelAutomationEventInput): Promise<string | null> {
  if ("slackBotToken" in input) {
    return input.slackBotToken ?? null;
  }
  return (await input.resolveSlackBotToken?.()) ?? null;
}

async function resolveAutomationOwnerDefaultModel(db: D1Database, userId: string): Promise<string> {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) return DEFAULT_SESSION_START_MODEL_ID;
  const settings = await getUserSettingsIfExists(db, numericUserId);
  return (
    extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(settings?.default_model)) ??
    DEFAULT_SESSION_START_MODEL_ID
  );
}

// Collect the human-readable fragments from a Slack alert message. Datadog
// sends an empty top-level `text` and puts the alert title/body in
// `attachments[].title` / `.text`; Sentry populates `text`. Reading both
// (deduped, original order) means the Cycloid session sees the actual alert
// instead of "(no text)".
function collectAttachmentText(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const out: string[] = [];
  for (const raw of attachments) {
    const attachment = asRecord(raw);
    if (!attachment) continue;
    const title = nonEmptyString(attachment.title);
    const text = nonEmptyString(attachment.text);
    if (title) out.push(title);
    if (text) out.push(text);
  }
  return out;
}

export function extractAutomationAlertText(event: SlackChannelAutomationEvent): string {
  const topText = nonEmptyString(event.text);
  const fragments = [...(topText ? [topText] : []), ...collectAttachmentText(event.attachments)];
  const seen = new Set<string>();
  return fragments.filter((fragment) => !seen.has(fragment) && seen.add(fragment)).join("\n\n");
}

function normalizeSlackAlertSignature(text: string): string | null {
  const normalized = text
    .replace(/```/g, "\n")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>|]+(?:\|([^>]+))?>/g, "$1")
    .replace(/\b(?:error|exception)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.length < SLACK_CHANNEL_AUTOMATION_DUPLICATE_MIN_SIGNATURE_CHARS) return null;
  if (/^(state|first seen|project|alert|short id|resolve|archive)\b/.test(normalized)) return null;
  return normalized;
}

function slackAlertDuplicateSignatures(event: SlackChannelAutomationEvent): Set<string> {
  const signatures = new Set<string>();
  const alertText = extractAutomationAlertText(event);
  for (const line of alertText.split(/\r?\n/)) {
    const signature = normalizeSlackAlertSignature(line);
    if (signature) signatures.add(signature);
  }
  const fullTextSignature = normalizeSlackAlertSignature(alertText);
  if (fullTextSignature) signatures.add(fullTextSignature);
  return signatures;
}

function slackAlertDuplicateSignaturesFromPayloadJson(payloadJson: string): Set<string> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    const event = asRecord(parsed) ? asRecord(parsed)?.event : parsed;
    return slackAlertDuplicateSignatures((event ?? {}) as SlackChannelAutomationEvent);
  } catch {
    return new Set();
  }
}

function hasSharedSlackAlertSignature(left: Set<string>, right: Set<string>): boolean {
  for (const signature of left) {
    if (right.has(signature)) return true;
  }
  return false;
}

async function findRecentDuplicateSlackAlertJob(
  db: D1Database,
  params: {
    businessId: string;
    ruleId: string;
    slackTeamId: string;
    slackChannelId: string;
    slackMessageTs: string;
    event: SlackChannelAutomationEvent;
    nowMs: number;
  },
): Promise<{ jobId: string; slackMessageTs: string } | null> {
  const currentSignatures = slackAlertDuplicateSignatures(params.event);
  if (currentSignatures.size === 0) return null;

  const recentJobs = await listRecentSlackChannelAutomationJobsForDuplicateScan(db, {
    businessId: params.businessId,
    ruleId: params.ruleId,
    slackTeamId: params.slackTeamId,
    slackChannelId: params.slackChannelId,
    sinceMs: params.nowMs - SLACK_CHANNEL_AUTOMATION_DUPLICATE_SUPPRESSION_WINDOW_MS,
    limit: SLACK_CHANNEL_AUTOMATION_DUPLICATE_SCAN_LIMIT,
  });
  for (const job of recentJobs) {
    if (job.slackMessageTs === params.slackMessageTs) continue;
    if (
      hasSharedSlackAlertSignature(currentSignatures, slackAlertDuplicateSignaturesFromPayloadJson(job.payloadJson))
    ) {
      return { jobId: job.id, slackMessageTs: job.slackMessageTs };
    }
  }
  return null;
}

export function renderSlackChannelAutomationPrompt(rule: AutomationRule, event: SlackChannelAutomationEvent): string {
  const providerLabel = renderProviderLabel(rule.triggerProvider);
  const slackText = boundedText(extractAutomationAlertText(event), SLACK_CHANNEL_AUTOMATION_TEXT_MAX_CHARS);
  const renderedSlackText = slackText ? wrapUserContent(slackText, "slack_alert_message", providerLabel) : "(no text)";

  return [
    rule.promptTemplate.trim(),
    "",
    `${providerLabel} Slack alert context:`,
    "Slack message text:",
    "",
    renderedSlackText,
  ].join("\n");
}

async function postAutomationThreadReply(
  params: {
    postThreadReply: PostThreadReply;
    slackBotToken: string | null;
    channelId: string;
    threadTs: string;
    text: string;
  },
  context: { ruleId: string; jobId: string },
): Promise<void> {
  if (!params.slackBotToken) return;
  try {
    await params.postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text);
  } catch (err) {
    log.warn({ ...context, error: String(err) }, "slack_automation_thread_reply_failed");
  }
}

async function markOrphanedSlackAutomationSessionFailed(
  db: D1Database,
  context: { ruleId: string; jobId: string; sessionId: string },
): Promise<void> {
  try {
    await buildSyncRichStatusStatement(db, context.sessionId, "failed").statement.run();
  } catch (err) {
    log.error({ ...context, error: String(err) }, "slack_automation_session_orphan_cleanup_failed");
  }
}

async function postAutomationStartingStatus(
  params: {
    env: Env;
    postThreadReply: PostThreadReply;
    slackBotToken: string;
    channelId: string;
    threadTs: string;
    slackTeamId: string;
    sessionId: string;
    repoFullName: string;
  },
  context: { ruleId: string; jobId: string },
): Promise<CallbackContext> {
  const callbackContext: CallbackContext = {
    source: "slack",
    channel: params.channelId,
    threadTs: params.threadTs,
    slackTeamId: params.slackTeamId,
  };
  const statusInput = {
    stage: "starting" as const,
    sessionId: params.sessionId,
    frontendUrl: resolvePublicAppBaseUrl(params.env),
    repoFullName: params.repoFullName,
  };
  try {
    const postResult = await params.postThreadReply(
      params.slackBotToken,
      params.channelId,
      params.threadTs,
      buildStatusFallbackText(statusInput),
      buildStatusBlocks(statusInput),
    );
    if (postResult.ok && typeof postResult.ts === "string") {
      const updatedContext = { ...callbackContext, statusMessageTs: postResult.ts };
      const updateResult = await updateSessionCallbackContext(params.env, params.sessionId, updatedContext);
      if (!updateResult.ok) {
        log.warn(
          { ...context, sessionId: params.sessionId, status: updateResult.status },
          "slack_automation_status_message_ts_persist_failed",
        );
      }
      return updatedContext;
    }
    if (!postResult.ok) {
      await reportSlackPostFailure(params.env, {
        operation: "postAutomationStartingStatus",
        sessionId: params.sessionId,
        slackErrorCode: postResult.error,
      });
      log.warn(
        { ...context, sessionId: params.sessionId, slackError: postResult.error },
        "slack_automation_starting_status_failed",
      );
    }
  } catch (err) {
    log.warn({ ...context, sessionId: params.sessionId, error: String(err) }, "slack_automation_starting_status_threw");
  }
  return callbackContext;
}

export async function processSlackChannelAutomationEvent(
  input: ProcessSlackChannelAutomationEventInput,
): Promise<ProcessSlackChannelAutomationEventResult> {
  const db = input.env.DB;
  const now = input.deps?.now?.() ?? Date.now();
  const gate = input.deps?.gateGithubSessionStart ?? gateGithubSessionStart;
  const initializeSession = input.deps?.initializeAndProjectSession ?? initializeAndProjectSession;
  const enqueuePrompt = input.deps?.enqueueSessionPrompt ?? enqueueSessionPrompt;
  const postReply = input.deps?.postThreadReply ?? postThreadReply;
  const makeId = input.deps?.makeId ?? crypto.randomUUID.bind(crypto);

  const slackTeamId = nonEmptyString(input.event.team);
  const slackChannelId = nonEmptyString(input.event.channel);
  if (!slackTeamId || !slackChannelId) {
    return { processed: 0, outcomes: [] };
  }

  const rules = await findEnabledSlackChannelAutomationRules(db, {
    businessId: input.businessId,
    slackTeamId,
    slackChannelId,
  });
  if (rules.length === 0) {
    return { processed: 0, outcomes: [] };
  }

  const outcomes: ProcessSlackChannelAutomationEventResult["outcomes"] = [];
  for (const rule of rules.slice(0, SLACK_CHANNEL_AUTOMATION_MAX_RULES_PER_EVENT)) {
    const trigger = toTriggerResult(rule, input.event);
    if (!trigger.shouldTrigger) {
      outcomes.push({ ruleId: rule.id, outcome: "ignored" });
      continue;
    }
    if (trigger.senderType !== "allowed_app") {
      outcomes.push({ ruleId: rule.id, outcome: "ignored" });
      continue;
    }

    const slackMessageTs = nonEmptyString(input.event.ts);
    if (!slackMessageTs) {
      outcomes.push({ ruleId: rule.id, outcome: "ignored" });
      continue;
    }

    const jobId = buildJobId(rule.id, slackMessageTs);
    if (isResolvedSlackAlertMessage(rule.triggerProvider, input.event)) {
      const inserted = await insertSkippedAutomationEventJobIfNotExists(db, {
        id: jobId,
        ruleId: rule.id,
        businessId: input.businessId,
        triggerKind: rule.triggerKind,
        triggerProvider: rule.triggerProvider,
        idempotencyKey: buildIdempotencyKey(rule.id, input.event),
        slackTeamId,
        slackChannelId,
        slackMessageTs,
        slackThreadTs: nonEmptyString(input.event.thread_ts),
        payloadJson: input.rawPayloadJson,
        createdAt: now,
        completedAt: now,
        terminalReason: "resolved_alert",
      });
      outcomes.push({ ruleId: rule.id, jobId, outcome: inserted.inserted ? "resolved_alert" : "duplicate" });
      continue;
    }

    const duplicateAlertJob = await findRecentDuplicateSlackAlertJob(db, {
      businessId: input.businessId,
      ruleId: rule.id,
      slackTeamId,
      slackChannelId,
      slackMessageTs,
      event: input.event,
      nowMs: now,
    });
    if (duplicateAlertJob) {
      const inserted = await insertSkippedAutomationEventJobIfNotExists(db, {
        id: jobId,
        ruleId: rule.id,
        businessId: input.businessId,
        triggerKind: rule.triggerKind,
        triggerProvider: rule.triggerProvider,
        idempotencyKey: buildIdempotencyKey(rule.id, input.event),
        slackTeamId,
        slackChannelId,
        slackMessageTs,
        slackThreadTs: nonEmptyString(input.event.thread_ts),
        payloadJson: input.rawPayloadJson,
        createdAt: now,
        completedAt: now,
        terminalReason: "duplicate_recent_alert",
      });
      if (!inserted.inserted) {
        outcomes.push({ ruleId: rule.id, jobId, outcome: "duplicate" });
        continue;
      }
      const slackBotToken = await resolveSlackBotToken(input);
      await postAutomationThreadReply(
        {
          postThreadReply: postReply,
          slackBotToken,
          channelId: slackChannelId,
          threadTs: slackMessageTs,
          text:
            "Not triggering automation: this alert matches another alert from the last minute, " +
            "so a second session is unlikely to find anything new.",
        },
        { ruleId: rule.id, jobId },
      );
      outcomes.push({ ruleId: rule.id, jobId, outcome: "duplicate_alert" });
      continue;
    }

    const openJobCount = await countOpenAutomationEventJobsForBusiness(db, input.businessId);
    if (openJobCount >= SLACK_CHANNEL_AUTOMATION_MAX_OPEN_JOBS_PER_BUSINESS) {
      outcomes.push({ ruleId: rule.id, jobId, outcome: "backpressure" });
      continue;
    }

    const inserted = await insertAutomationEventJobIfNotExists(db, {
      id: jobId,
      ruleId: rule.id,
      businessId: input.businessId,
      triggerKind: rule.triggerKind,
      triggerProvider: rule.triggerProvider,
      idempotencyKey: buildIdempotencyKey(rule.id, input.event),
      slackTeamId,
      slackChannelId,
      slackMessageTs,
      slackThreadTs: nonEmptyString(input.event.thread_ts),
      payloadJson: input.rawPayloadJson,
      createdAt: now,
    });
    if (!inserted.inserted) {
      outcomes.push({ ruleId: rule.id, jobId, outcome: "duplicate" });
      continue;
    }

    const leaseOwner = makeId();
    const claimed = await claimAutomationEventJob(db, {
      jobId,
      leaseOwner,
      leaseExpiresAt: now + 5 * 60_000,
      nowMs: now,
    });
    if (!claimed.claimed) {
      outcomes.push({ ruleId: rule.id, jobId, outcome: "duplicate" });
      continue;
    }

    const slackBotToken = await resolveSlackBotToken(input);
    if (!slackBotToken) {
      await markAutomationEventJobTerminal(db, {
        jobId,
        leaseOwner,
        phase: "failed",
        terminalReason: "missing_slack_token",
        completedAt: now,
      });
      outcomes.push({ ruleId: rule.id, jobId, outcome: "missing_token" });
      continue;
    }

    if (!rule.configuredByUserId) {
      await markAutomationEventJobTerminal(db, {
        jobId,
        leaseOwner,
        phase: "failed",
        terminalReason: "missing_configured_user",
        completedAt: now,
      });
      await postAutomationThreadReply(
        {
          postThreadReply: postReply,
          slackBotToken,
          channelId: slackChannelId,
          threadTs: slackMessageTs,
          text: "Cycloid could not start this automation because the rule is missing an owner.",
        },
        { ruleId: rule.id, jobId },
      );
      outcomes.push({ ruleId: rule.id, jobId, outcome: "missing_config" });
      continue;
    }

    const sessionId = buildSessionId(rule.id, slackMessageTs);
    const gateResult = await gate(input.env, {
      userId: rule.configuredByUserId,
      businessId: rule.businessId,
      sessionId,
      repoOwner: rule.repoOwner,
      repoName: rule.repoName,
    });
    if (!gateResult.ok) {
      await markAutomationEventJobTerminal(db, {
        jobId,
        leaseOwner,
        phase: "failed",
        terminalReason: "repo_gate_failed",
        errorMessage: gateResult.body.reasonCode,
        completedAt: now,
      });
      await postAutomationThreadReply(
        {
          postThreadReply: postReply,
          slackBotToken,
          channelId: slackChannelId,
          threadTs: slackMessageTs,
          text: "Cycloid could not start this automation because repository access is unavailable.",
        },
        { ruleId: rule.id, jobId },
      );
      outcomes.push({ ruleId: rule.id, jobId, outcome: "repo_gate_failed" });
      continue;
    }

    const auth: InternalAuthContext = {
      userId: rule.configuredByUserId,
      businessId: rule.businessId,
      canAccessAllSessions: false,
    };
    const slackCallbackContext: CallbackContext = {
      source: "slack",
      channel: slackChannelId,
      threadTs: slackMessageTs,
      slackTeamId,
    };
    const model =
      normalizeRetiredBasetenModelId(rule.modelId) ??
      (await resolveAutomationOwnerDefaultModel(db, rule.configuredByUserId));

    try {
      await initializeSession(input.env, {
        sessionId,
        ownerUserId: rule.configuredByUserId,
        sessionKind: "repo",
        repoContext: { repoOwner: rule.repoOwner, repoName: rule.repoName },
        callbackContext: slackCallbackContext,
        auth,
        installationId: gateResult.installationId,
        model,
        reasoningEffort: null,
        projectionSource: "automation.slack_channel",
        projectionUserId: rule.configuredByUserId,
        initiationMode: InitiationMode.AUTOMATION,
        entrypoint: SessionEntrypoint.SLACK_AUTOMATION,
      });
    } catch (err) {
      if (err instanceof SlackThreadAlreadyClaimedError) {
        // Another session already owns this thread (e.g. a second automation rule
        // firing on the same alert message, or a human mention that claimed first).
        // The thread invariant is intact; skip quietly without a failure notice.
        log.info(
          { ruleId: rule.id, jobId, sessionId, existingSessionId: err.existingSessionId },
          "slack_automation_thread_already_claimed",
        );
        await markAutomationEventJobTerminal(db, {
          jobId,
          leaseOwner,
          phase: "failed",
          terminalReason: "thread_already_claimed",
          errorMessage: `thread owned by session ${err.existingSessionId}`,
          completedAt: now,
        });
        await markOrphanedSlackAutomationSessionFailed(db, { ruleId: rule.id, jobId, sessionId });
        outcomes.push({ ruleId: rule.id, jobId, outcome: "thread_already_claimed" });
        continue;
      }
      log.error({ ruleId: rule.id, jobId, sessionId, error: String(err) }, "slack_automation_session_create_failed");
      const terminalReason = isOpencodeAccessDeniedError(err) ? OPENCODE_ACCESS_DENIED_ERROR : "session_create_failed";
      await markAutomationEventJobTerminal(db, {
        jobId,
        leaseOwner,
        phase: "failed",
        terminalReason,
        errorMessage: String(err),
        completedAt: now,
      });
      await markOrphanedSlackAutomationSessionFailed(db, { ruleId: rule.id, jobId, sessionId });
      await postAutomationThreadReply(
        {
          postThreadReply: postReply,
          slackBotToken,
          channelId: slackChannelId,
          threadTs: slackMessageTs,
          text: renderSessionCreateFailureReply(err),
        },
        { ruleId: rule.id, jobId },
      );
      outcomes.push({ ruleId: rule.id, jobId, outcome: "session_create_failed" });
      continue;
    }

    await postAutomationStartingStatus(
      {
        env: input.env,
        postThreadReply: postReply,
        slackBotToken,
        channelId: slackChannelId,
        threadTs: slackMessageTs,
        slackTeamId,
        sessionId,
        repoFullName: `${rule.repoOwner}/${rule.repoName}`,
      },
      { ruleId: rule.id, jobId },
    );

    const renderedPrompt = renderSlackChannelAutomationPrompt(rule, input.event);
    const enqueue = await enqueuePrompt(input.env, sessionId, renderedPrompt, rule.configuredByUserId, { auth });
    if (!enqueue.ok) {
      await markAutomationEventJobTerminal(db, {
        jobId,
        leaseOwner,
        phase: "failed",
        terminalReason: "enqueue_failed",
        errorMessage: String(enqueue.status),
        completedAt: now,
      });
      await postAutomationThreadReply(
        {
          postThreadReply: postReply,
          slackBotToken,
          channelId: slackChannelId,
          threadTs: slackMessageTs,
          text: "Cycloid created this automation session but could not enqueue the alert prompt.",
        },
        { ruleId: rule.id, jobId },
      );
      await markOrphanedSlackAutomationSessionFailed(db, { ruleId: rule.id, jobId, sessionId });
      outcomes.push({ ruleId: rule.id, jobId, sessionId, outcome: "enqueue_failed" });
      continue;
    }

    await updateAutomationEventJobPhase(db, { jobId, leaseOwner, phase: "session_enqueued", nowMs: now });
    await markAutomationEventJobTerminal(db, {
      jobId,
      leaseOwner,
      phase: "succeeded",
      terminalReason: "session_enqueued",
      sessionId,
      completedAt: now,
    });
    outcomes.push({ ruleId: rule.id, jobId, sessionId, outcome: "session_enqueued" });
  }

  return {
    processed: outcomes.filter((outcome) => outcome.outcome !== "ignored").length,
    outcomes,
  };
}
