import * as Sentry from "@sentry/cloudflare";

import {
  DEFAULT_AGENT_NAME,
  isQaTesterAgentRole,
  requiresQaTargetPrUrl,
  resolveAgentRuntimeMetadata,
} from "../../../../shared/agent/constants.js";
import type { AgentRuntimeMetadata } from "../../../../shared/agent/schema.js";
import { AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE } from "../../../../shared/agent/verify-directive.js";
import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import type { IntegrationId } from "../../../../shared/constants/integration-helpers.js";
import {
  extractSessionStartModelIdAnyBackend,
  formatModelLabel,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
  type IntegrationLifecycleReasonCode,
  type IntegrationLifecycleStage,
  type IntegrationLifecycleStatus,
} from "../../../../shared/enums/integration-lifecycle.js";
import type { RepoCandidate, RepoGuessTextContext } from "../../../../shared/repo-resolution/index.js";
import { PROMPT_SEND_BLOCKED_ERROR } from "../../../../shared/session/eligibility.js";
import { MAX_SKILLS_PER_PROMPT, parseLeadingSkillCommands } from "../../../../shared/skills/index.js";
import { sleep } from "../../../../shared/utils/timing.js";
import { getUserBusinessIdOrNull, getUserByLinearId, getUserBySlackId, getValidLinearToken } from "../auth/db";
import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { getBusiness } from "../business/db";
import { businessIdsMatch } from "../constants/businesses";
import { SLACK_MAX_ATTACHMENTS_PER_THREAD } from "../constants/slack";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { getInstallationByOwner } from "../github/installations-db";
import { parseRepoUrl } from "../github/pr";
import { fetchRepoSkills } from "../github/skills";
import { githubPullRequestUrlMatchesRepo, parseGithubPullRequestUrl } from "../github/verification-pr-context";
import { detectIncidentIntent } from "../incident-analyzer/intent";
import { writeIntegrationLifecycleEvent } from "../integrations/lifecycle/service";
import { isIntegrationAvailable } from "../integrations/service";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { endSpan, runInSpan, startSpan } from "../observability/context";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { flushSpansToQueue } from "../observability/exporter";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { emitSlackMentionAckLatencyMetric } from "../observability/slack-ack-metrics";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import { tracedFetch } from "../observability/wrappers";
import { isOpencodeAccessDeniedError, OPENCODE_ACCESS_DENIED_ERROR } from "../services/opencode-access-gate";
import {
  PROVIDER_KEY_NOT_VALIDATED_ERROR,
  ProviderCredentialNotValidatedError,
} from "../services/provider-credential-gate";
import { resolvePublicAppBaseUrl, resolvePublicSessionUrl } from "../services/public-url";
import {
  type RepoResolutionFallbackFailureCategory,
  type RepoResolutionMode,
  resolveRepoFromTextContext,
} from "../services/repo-resolver";
import { listAccessibleReposForUser, type RepoListItem } from "../services/repos";
import {
  type AdoptedPrMetadata,
  resolveSessionContinuation,
  SessionContinuationError,
} from "../services/session-continuation";
import { persistInitialSessionProjection } from "../services/session-create";
import { resolveBaseModelForAutomaticRouting } from "../services/session-model-routing";
import { syncSessionProjection } from "../services/session-projection";
import { getSessionIndexRepoUrl, getSessionLivenessRows, hasSessionIndexEntry } from "../session/db";
import type { SessionFetchResultWithError } from "../session/internal-routes";
import { toPublicEnqueueDispatch, toPublicEnqueuedPrompt } from "../session/prompt-response";
import {
  closeSessionForWebhook,
  completeSessionPrompt,
  createSessionState,
  enqueueSessionPrompt,
  getSessionState,
  type RepoContext,
  updateSessionCallbackContext,
} from "../session/state";
import { requestCoordinatedVerification } from "../session/verification-coordinator-service";
import { getUserSettings } from "../settings/db";
import {
  extractSlackAttachmentRefsFromEvent,
  extractSlackAttachmentRefsFromMessages,
  hasSlackFileAttachments,
  processSlackAttachments,
  processSlackAttachmentsFromMessages,
  type SkippedSlackAttachment,
  type SlackAttachmentResult,
} from "../slack/attachments";
import { buildStatusBlocks, buildStatusFallbackText, renderSlackQuotedReplySourceText } from "../slack/blocks";
import {
  buildRepoDisambiguationBlocks,
  buildRepoDisambiguationFallbackText,
  SLACK_REPO_DISAMBIGUATION_MAX_CANDIDATES,
} from "../slack/blocks";
import { resolveSlackMentions } from "../slack/mentions";
import {
  addReaction,
  getConversationInfo,
  getSlackBotUserId,
  getThreadReplies,
  postThreadReply,
  removeReaction,
  type SlackThreadMessage,
} from "../slack/notify";
import { resolveInstalledSlackBotToken } from "../slack/tokens";
import { getWorkspaceInstallMetadata } from "../slack/workspaces";
import type { CallbackContext, EnqueuePayload, Env } from "../types";
import {
  jsonErrorResponse,
  jsonResponse,
  normalizeWebhookReference,
  parseJsonBody,
  parsePositiveIntegerUserId,
} from "../utils";
import { readCappedWebhookBody } from "./body-limit";
import {
  bindLinearWebhookInstallationWebhookId,
  buildWebhookIdempotencyKey,
  claimLinearIssueSkipNotice,
  claimSlackThreadSessionRef,
  claimWebhookIdempotency,
  consumeSlackRepoDisambiguation,
  deleteLinearBootstrapJob,
  deleteLinearIssueSessionRefIfSession,
  deleteLinearIssueSkipNotice,
  deleteSlackThreadSessionRefIfSession,
  getActiveLinearWebhookInstallationByOrganization,
  getSessionIdBySlackThreadRef,
  insertSlackRepoDisambiguation,
  type LinearIssueSessionRef,
  peekSlackRepoDisambiguation,
  type SlackRepoDisambiguationCandidate,
  type SlackRepoDisambiguationRecord,
  upsertSessionWebhookRef,
} from "./db";
import { postLinearIssueComment } from "./linear";
import { fetchLinearIssueRecentComments } from "./linear-comments";
import {
  buildLinearIssuePrompt,
  buildLinearRepoGuessContext,
  buildSlackBootstrapPrompt,
  buildSlackFollowUpPrompt,
  buildSlackQuotedReplySource,
  buildSlackRepoGuessContext,
  formatPreviousSlackMessageContext,
  formatThreadContext,
  type LinearIssuePromptComment,
  parseRepoPromptFromSlackMessage,
  parseRepoPromptFromText,
  renderSlackThreadMessage,
} from "./prompts";
import {
  SLACK_INVALID_REPO_REPLY,
  slackInvalidBareRepoReply,
  slackMissingModelKeyReply,
  slackNoInstallationReply,
  slackRepoAccessVerificationFailedReply,
  slackRepoNotAuthorizedReply,
} from "./slack-operational-replies";
import {
  slackGeneralSettingsUrl,
  slackIntegrationsSettingsUrl,
  SlackThreadResponder,
  type SlackThreadResponderSessionBudget,
  slackWorkspaceIntegrationsSettingsUrl,
  TRANSIENT_LLM_FAILURE_CATEGORIES,
} from "./slack-thread-responder";
import { postSlackWakeAcknowledgement, postSlackWakeEnqueueFailedAsk, wakeSlackSessionForFollowUp } from "./slack-wake";
import { verifySlackWebhookSignature } from "./verify";

export const log = createLogger({ bindings: { component: "webhook" } });

async function postThreadReplyAndReportFailure(params: {
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  operation: string;
  slackBotToken: string;
  channelId: string;
  threadTs: string | undefined;
  text: string;
  blocks?: unknown[];
  sessionId?: string;
}): Promise<Awaited<ReturnType<typeof postThreadReply>>> {
  let result: Awaited<ReturnType<typeof postThreadReply>>;
  try {
    result =
      params.blocks === undefined
        ? await postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text)
        : await postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text, params.blocks);
  } catch (error) {
    await reportSlackPostFailure(params.env, {
      operation: params.operation,
      sessionId: params.sessionId,
      error,
    });
    throw error;
  }
  if (!result.ok) {
    await reportSlackPostFailure(params.env, {
      operation: params.operation,
      sessionId: params.sessionId,
      slackErrorCode: result.error,
    });
  }
  return result;
}

export function scheduleWebhookTask(ctx: ExecutionContext | undefined, task: Promise<unknown>): void {
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}

const LINEAR_PROMPT_CONTEXT_SOFT_TIMEOUT_MS = 1_500;
// Strict bound: Linear recommends rejecting timestamps more than a minute off.
// Used for future skew and for OAuth-revocation webhook binding.
const LINEAR_WEBHOOK_MAX_AGE_MS = 60 * 1000;
// Past bound for issue webhooks. Linear retries failed deliveries at most 3
// times with cumulative backoff of +1m, then +1h, then +6h from the previous
// attempt (linear.app/developers/webhooks), so the final retry lands ~7h01m
// after the original webhookTimestamp; 8h covers it with delivery margin.
// Replay protection for old signed bodies comes from idempotency keyed on the
// payload hash, not from this gate.
export const LINEAR_WEBHOOK_MAX_PAST_AGE_MS = 8 * 60 * 60 * 1000;
export const WEBHOOK_SOURCE_SLACK_EVENTS = "slack_events";
export const WEBHOOK_SOURCE_SLACK_INTERACTIONS = "slack_interactions";
export const WEBHOOK_SOURCE_LINEAR = "linear";
const SESSION_WEBHOOK_REF_SOURCE_SLACK_THREAD = "slack_thread";
const SESSION_WEBHOOK_REF_SOURCE_LINEAR_ISSUE = "linear_issue";
const SLACK_ATTACHMENT_ONLY_FOLLOW_UP_PROMPT = "Please use the attached Slack file(s) as context for this session.";
const SLACK_REPO_DISAMBIGUATION_TTL_MS = 10 * 60 * 1000;
const SLACK_SESSION_START_RETRY_DELAYS_MS = [0, 25, 100];
const SLACK_THREAD_CLAIM_RETRY_DELAYS_MS = [10, 25];
const INCIDENT_INVESTIGATION_SKILL_NAME = "investigate-incident";

interface LinearPromptContextResult {
  linearToken: string | null;
  comments: LinearIssuePromptComment[];
  commentsFetched: number | null;
  timedOut: boolean;
}

function emptyLinearPromptContext(timedOut = false): LinearPromptContextResult {
  return { linearToken: null, comments: [], commentsFetched: null, timedOut };
}

function parseLinearWebhookTimestamp(value: unknown): number | null {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

async function fetchRepoSkillNames(env: Env, actorUserId: string, repoUrl: string): Promise<Set<string> | null> {
  let repo: ReturnType<typeof parseRepoUrl>;
  try {
    repo = parseRepoUrl(repoUrl);
  } catch {
    return null;
  }

  try {
    const skills = await fetchRepoSkills(env, actorUserId, repo.owner, repo.repo);
    return new Set(skills.map((skill) => skill.name));
  } catch (err) {
    log.warn({ repoOwner: repo.owner, repoName: repo.repo, error: String(err) }, "Slack skill lookup failed");
    return null;
  }
}

async function resolveSlackPromptSkills(params: {
  env: Env;
  actorUserId: string;
  repoUrl: string;
  prompt: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  skipImplicitIncidentDetection?: boolean;
}): Promise<{ prompt: string | null; skills?: string[] }> {
  if (!params.prompt) return { prompt: params.prompt };

  const explicit = parseLeadingSkillCommands(params.prompt);
  if (explicit.skills.length > 0) {
    const availableNames = await fetchRepoSkillNames(params.env, params.actorUserId, params.repoUrl);
    const requested = explicit.skills.slice(0, MAX_SKILLS_PER_PROMPT);
    if (availableNames && requested.every((skill) => availableNames.has(skill))) {
      return { prompt: explicit.prompt, skills: requested };
    }
    log.info(
      { repoUrl: params.repoUrl, requested },
      "Slack explicit skill commands could not be validated against repo; falling back to plain prompt",
    );
    return { prompt: params.prompt };
  }

  if (params.skipImplicitIncidentDetection) {
    return { prompt: params.prompt };
  }

  const availableNames = await fetchRepoSkillNames(params.env, params.actorUserId, params.repoUrl);
  if (
    availableNames?.has(INCIDENT_INVESTIGATION_SKILL_NAME) &&
    (await detectIncidentIntent({
      env: params.env,
      prompt: params.prompt,
      logger: log,
      waitUntil: params.waitUntil,
    }))
  ) {
    return { prompt: params.prompt, skills: [INCIDENT_INVESTIGATION_SKILL_NAME] };
  }

  return { prompt: params.prompt };
}

export function isRecentLinearWebhookTimestamp(value: unknown, now: number): boolean {
  const timestamp = parseLinearWebhookTimestamp(value);
  if (timestamp === null) return false;
  return Math.abs(now - timestamp) <= LINEAR_WEBHOOK_MAX_AGE_MS;
}

/**
 * Asymmetric acceptance window for Linear issue webhooks: up to 8h in the past
 * so all of Linear's redeliveries (cumulative +1m/+1h1m/+7h1m) survive the
 * gate, but only the strict 60s skew into the future, where staleness has no
 * retry justification.
 */
export function isAcceptableLinearWebhookTimestamp(value: unknown, now: number): boolean {
  const timestamp = parseLinearWebhookTimestamp(value);
  if (timestamp === null) return false;
  const age = now - timestamp;
  return age >= -LINEAR_WEBHOOK_MAX_AGE_MS && age <= LINEAR_WEBHOOK_MAX_PAST_AGE_MS;
}

export function isLinearOAuthRevocationEvent(payload: Record<string, unknown>): boolean {
  return payload.type === "OAuthApp" && payload.action === "revoked";
}

/** Returns true when actorUserId can be safely cast to a numeric D1 row id. */
function isNumericUserId(actorUserId: string): boolean {
  return Number.isFinite(Number(actorUserId));
}

type WebhookRepoSelectionSource = "explicit" | "default" | "inferred";

interface WebhookRepoSelectionMatched {
  status: "matched";
  repoUrl: string;
  repoOwner: string | null;
  repoName: string | null;
}

interface WebhookRepoSelectionInferenceUnavailable {
  status: "skipped";
  reason: "repo_inference_unavailable";
  llmFailure?: RepoResolutionFallbackFailureCategory;
  candidates?: RepoCandidate[];
}

interface WebhookRepoSelectionInferenceUnknown {
  status: "skipped";
  reason: "repo_inference_unknown";
  llmFailure?: RepoResolutionFallbackFailureCategory;
  candidates?: RepoCandidate[];
}

type WebhookRepoSelectionSkipped = WebhookRepoSelectionInferenceUnavailable | WebhookRepoSelectionInferenceUnknown;

type WebhookRepoSelectionPolicyResult = WebhookRepoSelectionMatched | WebhookRepoSelectionSkipped;

type WebhookRepoSelectionResult =
  | {
      status: "resolved";
      repoUrl: string;
      repoOwner: string | null;
      repoName: string | null;
      source: WebhookRepoSelectionSource;
    }
  | WebhookRepoSelectionSkipped;

type WebhookRepoSelectionResolvedResult = Extract<WebhookRepoSelectionResult, { status: "resolved" }>;

interface WebhookRepoResponderSkipped {
  response: Response;
  releaseReason: string;
}

type WebhookRepoSelectionResponderResult =
  | { status: "resolved"; selection: WebhookRepoSelectionResolvedResult }
  | ({ status: "skipped" } & WebhookRepoResponderSkipped);

export async function resolveWebhookRepoSelectionPolicy(params: {
  sourceLabel: "Slack" | "Linear" | "Jira";
  actorUserId: string;
  explicitRepoUrl: string | null;
  defaultRepoUrl: string | null;
  fallBackFromInvalidExplicitRepoUrl: boolean;
  inferRepo: () => Promise<WebhookRepoSelectionPolicyResult>;
}): Promise<WebhookRepoSelectionResult> {
  const { sourceLabel, actorUserId, explicitRepoUrl, defaultRepoUrl, fallBackFromInvalidExplicitRepoUrl, inferRepo } =
    params;

  if (explicitRepoUrl) {
    if (fallBackFromInvalidExplicitRepoUrl) {
      try {
        const parsedRepo = parseRepoUrl(explicitRepoUrl);
        return {
          status: "resolved",
          repoUrl: explicitRepoUrl,
          repoOwner: parsedRepo.owner,
          repoName: parsedRepo.repo,
          source: "explicit",
        };
      } catch {
        log.warn(
          { repoUrl: explicitRepoUrl },
          `Ignoring invalid ${sourceLabel} repo directive and falling back to default repo policy`,
        );
      }
    } else {
      return {
        status: "resolved",
        repoUrl: explicitRepoUrl,
        repoOwner: null,
        repoName: null,
        source: "explicit",
      };
    }
  }

  if (defaultRepoUrl) {
    return {
      status: "resolved",
      repoUrl: defaultRepoUrl,
      repoOwner: null,
      repoName: null,
      source: "default",
    };
  }

  if (!isNumericUserId(actorUserId)) {
    log.info({ actorUserId }, `Skipping ${sourceLabel} repo inference for non-numeric actor user`);
    return {
      status: "skipped",
      reason: "repo_inference_unavailable",
    };
  }

  const inference = await inferRepo();
  if (inference.status === "matched") {
    return {
      status: "resolved",
      repoUrl: inference.repoUrl,
      repoOwner: inference.repoOwner,
      repoName: inference.repoName,
      source: "inferred",
    };
  }

  return inference;
}

async function respondToWebhookRepoSelection(params: {
  policy: Parameters<typeof resolveWebhookRepoSelectionPolicy>[0];
  onRepoInferenceUnavailable: (
    selection: WebhookRepoSelectionInferenceUnavailable,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
  onRepoInferenceUnknown: (
    selection: WebhookRepoSelectionInferenceUnknown,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
}): Promise<WebhookRepoSelectionResponderResult> {
  const selection = await resolveWebhookRepoSelectionPolicy(params.policy);
  if (selection.status === "resolved") {
    return {
      status: "resolved",
      selection,
    };
  }

  const skipped =
    selection.reason === "repo_inference_unavailable"
      ? await params.onRepoInferenceUnavailable(selection)
      : await params.onRepoInferenceUnknown(selection);
  return {
    status: "skipped",
    ...skipped,
  };
}

type WebhookRepoAuthorizationSkippedReason =
  "invalid_repo_url" | "no_installation" | "repo_access_verification_failed" | "repo_not_authorized";

type WebhookRepoAuthorizationPolicyResult =
  | {
      status: "authorized";
      owner: string;
      repo: string;
      installation: NonNullable<Awaited<ReturnType<typeof getInstallationByOwner>>>;
      accessCheck: "verified" | "skipped";
    }
  | {
      status: "skipped";
      reason: WebhookRepoAuthorizationSkippedReason;
      repoUrl: string;
      owner?: string;
      repo?: string;
    };

type WebhookRepoAuthorizationAuthorizedResult = Extract<WebhookRepoAuthorizationPolicyResult, { status: "authorized" }>;
type WebhookRepoAuthorizationSkippedResult = Extract<WebhookRepoAuthorizationPolicyResult, { status: "skipped" }>;

type WebhookRepoAuthorizationResponderResult =
  | { status: "authorized"; authorization: WebhookRepoAuthorizationAuthorizedResult }
  | ({ status: "skipped" } & WebhookRepoResponderSkipped);

export async function authorizeWebhookRepoPolicy(params: {
  sourceLabel: "Slack" | "Linear" | "Jira";
  env: Env;
  db: D1Database;
  actorUserId: string;
  repoUrl: string;
  repoOwner: string | null;
  repoName: string | null;
  verifyRepoAccess: boolean;
}): Promise<WebhookRepoAuthorizationPolicyResult> {
  const { sourceLabel, env, db, actorUserId, repoUrl, repoOwner, repoName, verifyRepoAccess } = params;
  let owner = repoOwner;
  let repo = repoName;

  if (!owner || !repo) {
    try {
      ({ owner, repo } = parseRepoUrl(repoUrl));
    } catch {
      log.warn({ repoUrl }, `${sourceLabel} session rejected: invalid repo URL`);
      return {
        status: "skipped",
        reason: "invalid_repo_url",
        repoUrl,
      };
    }
  }

  const installation = await getInstallationByOwner(db, owner);
  if (!installation) {
    log.warn({ repoOwner: owner }, `${sourceLabel} session rejected: no GitHub App installation for repo owner`);
    return {
      status: "skipped",
      reason: "no_installation",
      repoUrl,
      owner,
      repo,
    };
  }

  if (!verifyRepoAccess) {
    return {
      status: "authorized",
      owner,
      repo,
      installation,
      accessCheck: "skipped",
    };
  }

  let hasAccess: boolean;
  try {
    hasAccess = await verifyUserRepoAccess(db, actorUserId, owner, repo, {
      githubTokenEnv: env,
    });
  } catch (err) {
    log.error(
      { repoOwner: owner, repoName: repo, userId: actorUserId, error: String(err) },
      `${sourceLabel} session skipped: repo access verification unavailable`,
    );
    return {
      status: "skipped",
      reason: "repo_access_verification_failed",
      repoUrl,
      owner,
      repo,
    };
  }

  if (!hasAccess) {
    log.warn(
      { repoOwner: owner, repoName: repo, userId: actorUserId },
      `${sourceLabel} session rejected: repo not authorized`,
    );
    return {
      status: "skipped",
      reason: "repo_not_authorized",
      repoUrl,
      owner,
      repo,
    };
  }

  return {
    status: "authorized",
    owner,
    repo,
    installation,
    accessCheck: "verified",
  };
}

async function respondToWebhookRepoAuthorization(params: {
  policy: Parameters<typeof authorizeWebhookRepoPolicy>[0];
  onInvalidRepoUrl: (
    authorization: WebhookRepoAuthorizationSkippedResult,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
  onNoInstallation: (
    authorization: WebhookRepoAuthorizationSkippedResult,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
  onRepoAccessVerificationFailed: (
    authorization: WebhookRepoAuthorizationSkippedResult,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
  onRepoNotAuthorized: (
    authorization: WebhookRepoAuthorizationSkippedResult,
  ) => Promise<WebhookRepoResponderSkipped> | WebhookRepoResponderSkipped;
}): Promise<WebhookRepoAuthorizationResponderResult> {
  const authorization = await authorizeWebhookRepoPolicy(params.policy);
  if (authorization.status === "authorized") {
    return {
      status: "authorized",
      authorization,
    };
  }

  let skipped: WebhookRepoResponderSkipped;
  switch (authorization.reason) {
    case "invalid_repo_url":
      skipped = await params.onInvalidRepoUrl(authorization);
      break;
    case "no_installation":
      skipped = await params.onNoInstallation(authorization);
      break;
    case "repo_access_verification_failed":
      skipped = await params.onRepoAccessVerificationFailed(authorization);
      break;
    case "repo_not_authorized":
      skipped = await params.onRepoNotAuthorized(authorization);
      break;
    default:
      authorization.reason satisfies never;
      throw new Error(`Unexpected authorization reason: ${String(authorization.reason)}`);
  }

  return {
    status: "skipped",
    ...skipped,
  };
}

/**
 * Resolves user settings for a given actorUserId string. Encapsulates the
 * numeric-id parse and `Number.isFinite` guard so callers don't repeat the
 * pattern. Returns null when the id is non-numeric or the lookup fails.
 */
export async function resolveUserSettings(
  db: D1Database,
  actorUserId: string,
): Promise<Awaited<ReturnType<typeof getUserSettings>> | null> {
  if (!isNumericUserId(actorUserId)) return null;
  try {
    return await getUserSettings(db, Number(actorUserId));
  } catch (err) {
    log.warn({ error: String(err), actorUserId }, "resolveUserSettings: getUserSettings failed, returning null");
    return null;
  }
}

interface SlackRepoTextContextParts {
  channelName: string | null;
  threadContext: string | null;
  previousMessageContext: string | null;
  threadMessages: SlackThreadMessage[];
}

function filterSlackThreadMessagesForTrigger(
  event: Record<string, unknown> | undefined,
  threadMessages: readonly SlackThreadMessage[],
  triggerTs: string | null,
): Record<string, unknown>[] {
  const messages = [event, ...threadMessages].filter((message): message is Record<string, unknown> =>
    Boolean(message && typeof message === "object"),
  );
  const cutoff = normalizeWebhookReference(event?.ts) ?? triggerTs;
  if (!cutoff) return messages;
  const cutoffNumber = Number(cutoff);
  if (!Number.isFinite(cutoffNumber)) return messages;
  return messages.filter((message) => {
    const messageTs = normalizeWebhookReference(message.ts);
    return !messageTs || Number(messageTs) <= cutoffNumber;
  });
}

function slackReplyToTextForEvent(
  event: Record<string, unknown> | undefined,
  fallbackText?: string | null,
): string | null {
  if (event && typeof event === "object") {
    const rendered = renderSlackThreadMessage(event as SlackThreadMessage);
    if (rendered) return rendered;
  }
  const fallback = fallbackText?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
}

function slackReplyToQuoteSourceForEvent(event: Record<string, unknown> | undefined) {
  if (!event || typeof event !== "object") return null;
  const source = buildSlackQuotedReplySource(event as SlackThreadMessage);
  if (!source) return null;
  const replyToText = renderSlackThreadMessage(event as SlackThreadMessage);
  const renderedSource = renderSlackQuotedReplySourceText(source);
  if (!replyToText || !renderedSource) return null;
  return renderedSource.trim() === replyToText.trim() ? source : null;
}

function repoListItemToCandidate(repo: RepoListItem): RepoCandidate | null {
  const [repoOwner, repoName] = repo.fullName.split("/");
  if (!repoOwner || !repoName) return null;
  return {
    repoOwner,
    repoName,
    description: repo.description ?? null,
    url: repo.url,
    private: repo.private,
    defaultBranch: repo.defaultBranch,
  };
}

export function getSlackTeamIdFromEventPayload(
  payload: Record<string, unknown>,
  event: Record<string, unknown> | undefined,
): string | null {
  return (
    normalizeWebhookReference(payload.team_id) ||
    normalizeWebhookReference((payload.team as Record<string, unknown> | undefined)?.id) ||
    normalizeWebhookReference(event?.team) ||
    normalizeWebhookReference(event?.team_id)
  );
}

export function getSlackTeamIdFromInteractionPayload(payload: Record<string, unknown>): string | null {
  return (
    normalizeWebhookReference((payload.team as Record<string, unknown> | undefined)?.id) ||
    normalizeWebhookReference(payload.team_id)
  );
}

export async function isSlackWebhookAvailable(db: D1Database, userId: number): Promise<boolean> {
  return isIntegrationAvailable(db, userId, "slack" as IntegrationId);
}

export async function resolveSlackWebhookBotToken(
  env: Env,
  teamId: string | null,
  operation: string,
): Promise<string | null> {
  if (!teamId) {
    log.warn({ operation }, "Slack webhook skipped: missing team_id");
    return null;
  }
  const token = await resolveInstalledSlackBotToken(env, teamId);
  if (!token) {
    log.warn({ operation, teamId }, "Slack webhook skipped: workspace bot token unavailable");
  }
  return token;
}

function linearRepoClarificationText(llmFailure: RepoResolutionFallbackFailureCategory | undefined): string {
  if (llmFailure && TRANSIENT_LLM_FAILURE_CATEGORIES.has(llmFailure)) {
    return "Repo inference is temporarily unavailable. Try again in a moment, or add `repo=owner/repo` to the issue description to skip inference.";
  }
  if (llmFailure) {
    return "Repo inference is currently unavailable. Add `repo=owner/repo` to the issue description, or set a default repo in your Cycloid settings.";
  }
  return "I couldn't determine which repo to use. Add `repo=owner/repo` to the issue description, or set a default repo in your Cycloid settings.";
}

function postSlackRepoClarification(
  env: Env,
  slackBotToken: string,
  channelId: string,
  threadTs: string,
  llmFailure?: RepoResolutionFallbackFailureCategory,
  ctx?: ExecutionContext,
): void {
  new SlackThreadResponder({ slackBotToken, channelId, threadTs, ctx }).postRepoClarification(env, llmFailure);
}

async function postSlackRepoDisambiguation(params: {
  env: Env;
  slackBotToken: string;
  db: D1Database;
  ctx?: ExecutionContext;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  actorUserId: string;
  actorSlackUserId: string | null;
  promptText: string;
  event: Record<string, unknown> | undefined;
  threadMessages?: SlackThreadMessage[];
  candidates: readonly RepoCandidate[];
}): Promise<boolean> {
  const trimmedCandidates: SlackRepoDisambiguationCandidate[] = params.candidates
    .slice(0, SLACK_REPO_DISAMBIGUATION_MAX_CANDIDATES)
    .map(({ repoOwner, repoName }) => ({ repoOwner, repoName }));
  if (trimmedCandidates.length === 0) return false;

  const now = Date.now();
  const threadMessages =
    params.threadMessages ??
    (params.event?.thread_ts ? await getThreadReplies(params.slackBotToken, params.channelId, params.threadTs) : []);
  const attachmentMessages = filterSlackThreadMessagesForTrigger(params.event, threadMessages, params.messageTs);
  const attachmentRefs =
    attachmentMessages.length > 0
      ? extractSlackAttachmentRefsFromMessages(attachmentMessages)
      : extractSlackAttachmentRefsFromEvent(params.event);
  const record: SlackRepoDisambiguationRecord = {
    id: crypto.randomUUID(),
    channelId: params.channelId,
    threadTs: params.threadTs,
    messageTs: params.messageTs,
    actorUserId: params.actorUserId,
    actorSlackUserId: params.actorSlackUserId,
    promptText: params.promptText,
    attachmentFileIds: attachmentRefs.fileIds,
    attachmentOmittedCount: attachmentRefs.omittedCount,
    candidates: trimmedCandidates,
    createdAt: now,
    expiresAt: now + SLACK_REPO_DISAMBIGUATION_TTL_MS,
    consumedAt: null,
  };

  try {
    await insertSlackRepoDisambiguation(params.db, record);
  } catch (err) {
    log.error(
      { error: String(err), channelId: params.channelId, threadTs: params.threadTs },
      "Failed to persist Slack repo disambiguation row",
    );
    return false;
  }

  const blocks = buildRepoDisambiguationBlocks(record.id, trimmedCandidates);
  const replyPromise = runWithSentryTag(
    "postRepoDisambiguationReply",
    () =>
      postThreadReplyAndReportFailure({
        env: params.env,
        operation: "postRepoDisambiguationReply",
        slackBotToken: params.slackBotToken,
        channelId: params.channelId,
        threadTs: params.threadTs,
        text: buildRepoDisambiguationFallbackText(),
        blocks,
      }),
    log,
  );
  if (params.ctx) {
    params.ctx.waitUntil(replyPromise);
  } else {
    void replyPromise;
  }
  return true;
}

// Defense-in-depth check that a Slack-supplied response_url points at a
// Slack-controlled domain before we POST to it, so a bypassed signature
// check could not turn this handler into an SSRF proxy.
function isSlackResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget ephemeral acknowledgment through an interaction payload's
 * `response_url` ("already handled", "expired", ...). No-ops when the payload
 * carries no Slack-hosted response_url; `text` must stay metadata-only (no
 * payload contents, raw errors, or identifiers beyond what the clicker already
 * sees).
 */
export function postSlackInteractionEphemeral(params: {
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  text: string;
  operation: string;
}): void {
  const responseUrl = typeof params.payload.response_url === "string" ? params.payload.response_url : null;
  if (!responseUrl || !isSlackResponseUrl(responseUrl)) return;
  const post = runWithSentryTag(
    params.operation,
    () =>
      tracedFetch(
        responseUrl,
        {
          method: "POST",
          headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            replace_original: false,
            text: params.text,
          }),
        },
        "slack.response_url",
      ).then(() => undefined),
    log,
  );
  if (params.ctx) {
    params.ctx.waitUntil(post);
  } else {
    void post;
  }
}

/**
 * Post a concise, non-sensitive setup/enqueue error message back into the
 * Slack thread so the triggering user sees actionable feedback instead of a
 * silent skip. `operation` identifies the call site for Sentry tagging; the
 * message text is caller-supplied and must not include raw errors or stack
 * traces.
 */
function postSlackSetupError(
  slackBotToken: string,
  channelId: string,
  threadTs: string,
  message: string,
  operation: string,
  ctx?: ExecutionContext,
  sessionBudget?: SlackThreadResponderSessionBudget,
): void {
  new SlackThreadResponder({ slackBotToken, channelId, threadTs, sessionBudget, ctx }).postSetupError(
    message,
    operation,
  );
}

function postSlackThreadAssociationReply(params: {
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  operation: string;
  // Association replies always target a thread with a claimed session, so they
  // are budget-bound by construction.
  sessionBudget: SlackThreadResponderSessionBudget;
  ctx?: ExecutionContext;
}): void {
  new SlackThreadResponder({
    slackBotToken: params.slackBotToken,
    channelId: params.channelId,
    threadTs: params.threadTs,
    sessionBudget: params.sessionBudget,
    ctx: params.ctx,
  }).postThreadAssociation(params.operation);
}

async function enqueueSlackFollowUpWithStartupRetry(params: {
  env: Env;
  db: D1Database;
  sessionId: string;
  promptText: string;
  replyToText?: string | null;
  replyToQuoteSource?: ReturnType<typeof slackReplyToQuoteSourceForEvent>;
  actorUserId: string;
  skills?: string[];
  uploadedFiles: Awaited<ReturnType<typeof collectSlackPromptAttachments>>["uploadedFiles"];
  uploadedImages: Awaited<ReturnType<typeof collectSlackPromptAttachments>>["uploadedImages"];
}): Promise<
  | { kind: "enqueued"; result: SessionFetchResultWithError<EnqueuePayload> }
  | { kind: "session_not_found" }
  | { kind: "session_closed" }
  | { kind: "session_not_sendable"; reason: string | null }
  | { kind: "session_starting" }
  | { kind: "error"; result: SessionFetchResultWithError<EnqueuePayload> }
> {
  for (let attempt = 0; ; attempt += 1) {
    const enqueueResult = await enqueueSessionPrompt(
      params.env,
      params.sessionId,
      params.promptText,
      params.actorUserId,
      {
        source: "slack",
        replyToText: params.replyToText ?? params.promptText,
        ...(params.replyToQuoteSource ? { replyToQuoteSource: params.replyToQuoteSource } : {}),
        ...(params.skills?.length ? { skills: params.skills } : {}),
        uploadedFiles: params.uploadedFiles,
        uploadedImages: params.uploadedImages,
      },
    );
    if (enqueueResult.status === 404) {
      let sessionProjectionExists = true;
      try {
        sessionProjectionExists = await hasSessionIndexEntry(params.db, params.sessionId);
      } catch (err) {
        log.warn(
          { sessionId: params.sessionId, error: String(err) },
          "Could not check Slack follow-up session projection after enqueue 404",
        );
      }
      if (sessionProjectionExists) return { kind: "session_not_found" };
      if (attempt === SLACK_SESSION_START_RETRY_DELAYS_MS.length) return { kind: "session_starting" };
      await sleep(SLACK_SESSION_START_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (enqueueResult.status === 409) {
      switch (enqueueResult.error) {
        case PROMPT_SEND_BLOCKED_ERROR:
          return { kind: "session_not_sendable", reason: enqueueResult.reason ?? null };
        default:
          return { kind: "session_closed" };
      }
    }
    if (!enqueueResult.ok) return { kind: "error", result: enqueueResult };
    return { kind: "enqueued", result: enqueueResult };
  }
}

type SessionCloseAuthorizationResult =
  { authorized: true } | { authorized: false; reason: "missing_actor" | "actor_not_authorized" };

/**
 * Authorizes Slack-driven session close requests against the target session.
 *
 * A validly signed Slack payload can still carry an arbitrary session id, so
 * every stop path must enforce the same IDOR guard here: allow only the session
 * owner, or a same-business actor when that business explicitly enables shared
 * sessions. Same-business membership alone is not enough.
 */
export async function authorizeSessionCloseActor(
  db: D1Database,
  actorUserId: string,
  session: { ownerUserId: string | number | null; businessId: string | null },
): Promise<SessionCloseAuthorizationResult> {
  if (!actorUserId || actorUserId.startsWith("slack:")) {
    return { authorized: false, reason: "missing_actor" };
  }
  if (String(actorUserId) === String(session.ownerUserId)) {
    return { authorized: true };
  }

  const actorUserIdNumber = Number(actorUserId);
  if (!Number.isSafeInteger(actorUserIdNumber)) {
    return { authorized: false, reason: "missing_actor" };
  }
  const actorBusinessId = await getUserBusinessIdOrNull(db, actorUserIdNumber);
  if (!actorBusinessId || !businessIdsMatch(actorBusinessId, session.businessId)) {
    return { authorized: false, reason: "actor_not_authorized" };
  }

  const actorBusiness = await getBusiness(db, actorBusinessId);
  if (actorBusiness?.sharedSessions !== true) {
    return { authorized: false, reason: "actor_not_authorized" };
  }

  return { authorized: true };
}

export async function handleSlackThreadFollowUp(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  event: Record<string, unknown> | undefined;
  text: string;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  isAppMention: boolean;
  actorUserId: string;
  actorLabel: string | null;
  slackTeamId: string;
  slackBotToken: string;
  existingSessionId: string;
  eventReceivedMs?: number;
}): Promise<Response> {
  const {
    env,
    db,
    ctx,
    event,
    text,
    channelId,
    threadTs,
    messageTs,
    isAppMention,
    actorUserId,
    actorLabel,
    slackTeamId,
    slackBotToken,
    existingSessionId,
    eventReceivedMs,
  } = params;

  if (text.toLowerCase() === "stop") {
    const session = await getSessionState(env, existingSessionId);
    if (!session) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: "session_not_found" });
    }
    const authorization = await authorizeSessionCloseActor(db, actorUserId, session);
    if (!authorization.authorized) {
      return jsonResponse({ ok: true, created: false, skipped: true, reason: authorization.reason });
    }
    const closeResult = await closeSessionForWebhook(env, db, existingSessionId, {
      reason: "slack_stop_message",
      metadata: { closeSource: "slack_stop_message", actorUserId, channelId, threadTs },
    });
    return jsonResponse({ ok: true, created: false, sessionId: existingSessionId, stopped: closeResult.closed });
  }

  const parsedFollowUpMessage = parseRepoPromptFromSlackMessage(text);
  const normalizedFollowUpText = parsedFollowUpMessage.directivePresent ? (parsedFollowUpMessage.prompt ?? "") : text;
  const sessionRepoUrl = await getSessionIndexRepoUrl(db, existingSessionId);
  const selectedFollowUpPrompt = sessionRepoUrl
    ? await resolveSlackPromptSkills({
        env,
        actorUserId,
        repoUrl: sessionRepoUrl,
        prompt: normalizedFollowUpText,
        skipImplicitIncidentDetection: true,
      })
    : { prompt: normalizedFollowUpText };

  // Optimistic "eyes" ack (fire-and-forget). Kept at the pre-existing position so
  // it isn't scheduled before the handler is committed to enqueuing. Emits the
  // mention -> ack latency metric only when the reaction actually landed.
  log.info({ channelId, messageTs, teamId: slackTeamId, hasToken: true }, "Adding eyes reaction (follow-up)");
  if (messageTs && channelId) {
    scheduleWebhookTask(
      ctx,
      runWithSentryTag(
        "addReaction.followUp",
        async () => {
          const res = await addReaction(slackBotToken, channelId, messageTs, "eyes");
          log.debug({ result: res }, "Eyes reaction result (follow-up)");
          if (res.ok && eventReceivedMs != null) {
            await emitSlackMentionAckLatencyMetric(env, "follow_up", Date.now() - eventReceivedMs);
          }
        },
        log,
      ),
    );
  }

  let threadContext: string | null = null;
  if (messageTs) {
    await runWithSentryTag(
      "getSlackThreadContext.followUp",
      async () => {
        const [threadMessages, botUserIdResult] = await Promise.all([
          getThreadReplies(slackBotToken, channelId, threadTs),
          getSlackBotUserId(slackBotToken),
        ]);
        threadContext = formatThreadContext(threadMessages, messageTs, botUserIdResult ?? undefined, threadTs);
      },
      log,
    );
  }
  const currentMessagePrompt = selectedFollowUpPrompt.prompt
    ? buildSlackFollowUpPrompt(selectedFollowUpPrompt.prompt, actorLabel, threadContext)
    : "";
  let promptText = currentMessagePrompt || (selectedFollowUpPrompt.skills?.length ? (threadContext ?? "") : "");

  // The thread has a claimed session, so every operational reply below is
  // budget-bound: it rides the session's ask anchor instead of a new post.
  const followUpSessionBudget: SlackThreadResponderSessionBudget = {
    env,
    sessionId: existingSessionId,
    slackTeamId,
  };
  const attachments = await collectSlackPromptAttachments({
    slackBotToken,
    event,
    channelId,
    threadTs,
    operation: "postSkippedSlackAttachments.followUp",
    sessionBudget: followUpSessionBudget,
    ctx,
  });
  const hasUploadedAttachments = attachments.uploadedFiles.length > 0 || attachments.uploadedImages.length > 0;
  if (!selectedFollowUpPrompt.prompt?.trim() && hasUploadedAttachments) {
    promptText = threadContext
      ? `${threadContext}\n\n${SLACK_ATTACHMENT_ONLY_FOLLOW_UP_PROMPT}`
      : SLACK_ATTACHMENT_ONLY_FOLLOW_UP_PROMPT;
  }
  if (!promptText) {
    return jsonResponse({ ok: true, skipped: true, reason: "no_supported_attachments" });
  }

  // Resolve `<@ID>` mentions: keep the stable ID in the agent prompt, bare
  // `@Name` in the session-view display text. Fail-open and cosmetic.
  const resolvedPromptText = await resolveSlackMentions(promptText, {
    token: slackBotToken,
    kv: env.REPOS_CACHE,
    teamId: slackTeamId,
    keepRawId: true,
  });
  const renderedReplyToText = slackReplyToTextForEvent(event, selectedFollowUpPrompt.prompt ?? promptText);
  const replyToText = renderedReplyToText
    ? await resolveSlackMentions(renderedReplyToText, {
        token: slackBotToken,
        kv: env.REPOS_CACHE,
        teamId: slackTeamId,
      })
    : renderedReplyToText;

  const followUpEnqueueParams = {
    env,
    db,
    sessionId: existingSessionId,
    promptText: resolvedPromptText,
    replyToText,
    // replyToQuoteSource posts back into Slack, which renders `<@ID>` natively.
    replyToQuoteSource: slackReplyToQuoteSourceForEvent(event),
    actorUserId,
    skills: selectedFollowUpPrompt.skills,
    uploadedFiles: attachments.uploadedFiles,
    uploadedImages: attachments.uploadedImages,
  };
  let enqueueOutcome = await enqueueSlackFollowUpWithStartupRetry(followUpEnqueueParams);
  let wokenFromPhase: "archived" | "stopped" | null = null;
  if (enqueueOutcome.kind === "session_not_sendable" || enqueueOutcome.kind === "session_closed") {
    // The bound session is in a disabled phase. Instead of dead-ending the
    // thread, route through wake: archived/user-stopped sessions wake and the
    // reply enqueues; archived sessions get a fresh-session reply; failed/blocked
    // get a single Retry nudge. Gating (DM mention-free, channel
    // @mention) already happened at the follow-up gate above this call.
    const unsendableReason = enqueueOutcome.kind === "session_not_sendable" ? enqueueOutcome.reason : "session_closed";
    log.info(
      { sessionId: existingSessionId, channelId, threadTs, reason: unsendableReason },
      "Slack follow-up hit an unsendable session; routing through wake",
    );
    const wakeOutcome = await wakeSlackSessionForFollowUp({
      env,
      db,
      sessionId: existingSessionId,
      actorUserId,
      slackTeamId,
      slackBotToken,
      channelId,
      threadTs,
      promptText: resolvedPromptText,
      replyToText: replyToText ?? null,
    });
    if (wakeOutcome.kind === "woken") {
      wokenFromPhase = wakeOutcome.fromPhase;
      enqueueOutcome = await enqueueSlackFollowUpWithStartupRetry(followUpEnqueueParams);
    } else {
      const wakeReason = wakeOutcome.kind === "retry_nudge" ? "wake_retry_nudge" : `wake_${wakeOutcome.reason}`;
      return jsonResponse({ ok: true, skipped: true, reason: wakeReason, sessionId: existingSessionId });
    }
  }
  if (enqueueOutcome.kind === "session_not_found") {
    return jsonResponse({ ok: true, skipped: true, reason: "session_not_found", sessionId: existingSessionId });
  }
  if (enqueueOutcome.kind === "session_starting") {
    log.info({ sessionId: existingSessionId, channelId, threadTs }, "Slack follow-up arrived while session starts");
    postSlackThreadAssociationReply({
      slackBotToken,
      channelId,
      threadTs,
      operation: "postSlackThreadAssociationReply.sessionStarting",
      sessionBudget: followUpSessionBudget,
      ctx,
    });
    return jsonResponse({ ok: true, skipped: true, reason: "session_starting", sessionId: existingSessionId });
  }
  if (enqueueOutcome.kind === "session_not_sendable" || enqueueOutcome.kind === "session_closed") {
    // Only reachable when the post-wake re-enqueue was still rejected (a wake
    // race or a phase the wake path cannot clear). Never the dead-end copy: a
    // single budget-path ask tells the user the pickup failed.
    const reason = enqueueOutcome.kind === "session_not_sendable" ? enqueueOutcome.reason : "session_closed";
    log.warn(
      { sessionId: existingSessionId, channelId, threadTs, reason, wokenFromPhase },
      "Slack follow-up enqueue still rejected after wake",
    );
    await postSlackWakeEnqueueFailedAsk({
      env,
      sessionId: existingSessionId,
      slackBotToken,
      channelId,
      threadTs,
      slackTeamId,
    });
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: reason ?? "session_not_sendable",
      sessionId: existingSessionId,
    });
  }
  if (enqueueOutcome.kind === "error") {
    postSlackSetupError(
      slackBotToken,
      channelId,
      threadTs,
      "Something went wrong sending your follow-up. Please try again.",
      "postSlackSetupError.followUpEnqueueFailed",
      ctx,
      followUpSessionBudget,
    );
    const err = new Error(`Session DO prompt enqueue failed with status ${enqueueOutcome.result.status}`);
    await runWithSentryTag("handleSlackEventsWebhook.enqueue", () => Promise.reject(err), log);
    throw err;
  }
  const enqueueResult = enqueueOutcome.result;

  if (messageTs && channelId) {
    scheduleWebhookTask(
      ctx,
      runWithSentryTag(
        "updateCallbackContext",
        () =>
          updateSessionCallbackContext(env, existingSessionId, {
            source: "slack",
            channel: channelId,
            threadTs,
            slackTeamId,
            reactionMessageTimestamps: [messageTs],
          } satisfies CallbackContext),
        log,
      ),
    );
  }

  const ep = enqueueResult.payload!;
  await syncSessionProjection({
    db,
    sessionId: existingSessionId,
    session: ep.session,
    replay: ep.replay,
    logger: log,
    source: "webhooks.slack.followup",
    userId: actorUserId,
  });

  await emitLifecycleEvent({
    db,
    integrationId: "slack",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_FOLLOWUP_ENQUEUED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: ep.session.businessId ?? null,
    userId: actorUserId,
    sessionId: existingSessionId,
    message: "Slack webhook enqueued a follow-up prompt for an existing session.",
    details: {
      provider: "slack",
      teamId: slackTeamId,
      eventKind: "thread_followup",
    },
  });

  if (wokenFromPhase !== null) {
    // Wake acknowledgment is a card update, never a new message (budget law).
    await runWithSentryTag(
      "postSlackWakeAcknowledgement",
      () => postSlackWakeAcknowledgement({ env, sessionId: existingSessionId }),
      log,
    );
  }

  return jsonResponse({
    ok: true,
    created: false,
    sessionId: existingSessionId,
    enqueued: true,
    prompt: toPublicEnqueuedPrompt(ep.prompt),
    dispatch: toPublicEnqueueDispatch(ep.dispatch),
    ...(wokenFromPhase !== null ? { woken: true, wokenFrom: wokenFromPhase } : {}),
  });
}

async function releaseSlackThreadSessionClaim(params: {
  db: D1Database;
  businessId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  sessionId: string;
  reason: string;
}): Promise<void> {
  try {
    const released = await deleteSlackThreadSessionRefIfSession(
      params.db,
      params.businessId,
      params.teamId,
      params.channelId,
      params.threadTs,
      params.sessionId,
    );
    if (released) {
      log.info(
        { channelId: params.channelId, threadTs: params.threadTs, sessionId: params.sessionId, reason: params.reason },
        "Released Slack thread session claim before session creation",
      );
    }
  } catch (err) {
    log.warn(
      {
        error: String(err),
        channelId: params.channelId,
        threadTs: params.threadTs,
        sessionId: params.sessionId,
        reason: params.reason,
      },
      "Failed to release Slack thread session claim",
    );
    Sentry.captureException(err, { tags: { operation: "releaseSlackThreadSessionClaim" } });
  }
}

function postSkippedSlackAttachments(
  slackBotToken: string,
  channelId: string,
  threadTs: string,
  skipped: readonly SkippedSlackAttachment[],
  operation: string,
  ctx?: ExecutionContext,
  sessionBudget?: SlackThreadResponderSessionBudget,
): void {
  if (skipped.length === 0) return;
  new SlackThreadResponder({ slackBotToken, channelId, threadTs, sessionBudget, ctx }).postSkippedAttachments(
    skipped,
    operation,
  );
}

function postSlackAttachmentOnlyNewSessionReply(
  slackBotToken: string,
  channelId: string,
  threadTs: string,
  ctx?: ExecutionContext,
): void {
  new SlackThreadResponder({ slackBotToken, channelId, threadTs, ctx }).postAttachmentOnlyNewSession();
}

export function isAllowedSlackAttachmentEvent(event: Record<string, unknown> | undefined): boolean {
  const subtype = normalizeWebhookReference(event?.subtype);
  return !subtype || subtype === "file_share";
}

async function collectSlackPromptAttachments(params: {
  slackBotToken: string;
  event: Record<string, unknown> | undefined;
  messages?: readonly Record<string, unknown>[];
  threadWide?: boolean;
  channelId: string;
  threadTs: string;
  operation: string;
  downloadSupported?: boolean;
  /** Present when the thread already has a claimed session (budget-bound replies). */
  sessionBudget?: SlackThreadResponderSessionBudget;
  ctx?: ExecutionContext;
}): Promise<SlackAttachmentResult> {
  const messages = params.messages ?? (params.event ? [params.event] : []);
  if (!messages.some((message) => hasSlackFileAttachments(message))) {
    return { uploadedFiles: [], uploadedImages: [], skipped: [] };
  }

  try {
    const attachments =
      params.messages && params.threadWide
        ? await processSlackAttachmentsFromMessages(params.slackBotToken, params.messages, {
            ...(params.downloadSupported === undefined ? {} : { downloadSupported: params.downloadSupported }),
          })
        : params.downloadSupported === undefined
          ? await processSlackAttachments(params.slackBotToken, params.event)
          : await processSlackAttachments(params.slackBotToken, params.event, {
              downloadSupported: params.downloadSupported,
            });
    const boundedSkipped =
      params.threadWide && attachments.skipped.length > 1
        ? [
            {
              filename: `${attachments.skipped.length} thread attachments`,
              code: "too_many" as const,
              reason: "Some thread attachments were skipped; only supported prompt attachments were included",
            },
          ]
        : attachments.skipped;
    postSkippedSlackAttachments(
      params.slackBotToken,
      params.channelId,
      params.threadTs,
      boundedSkipped,
      params.operation,
      params.ctx,
      params.sessionBudget,
    );
    return { ...attachments, skipped: boundedSkipped };
  } catch (error) {
    log.error({ error: String(error) }, "Slack attachment processing failed");
    const skipped: SkippedSlackAttachment[] = [
      {
        filename: "Slack attachment",
        code: "download_failed",
        reason: "Unable to process Slack attachment",
      },
    ];
    postSkippedSlackAttachments(
      params.slackBotToken,
      params.channelId,
      params.threadTs,
      skipped,
      params.operation,
      params.ctx,
      params.sessionBudget,
    );
    return { uploadedFiles: [], uploadedImages: [], skipped };
  }
}

type RepoInferenceResult =
  | {
      status: "matched";
      repoUrl: string;
      repoOwner: string;
      repoName: string;
      confidence: number;
      reason: string;
    }
  | {
      status: "unknown" | "unavailable";
      reason: string;
      confidence: number;
      llmFailure?: RepoResolutionFallbackFailureCategory;
      candidates?: RepoCandidate[];
    };

async function inferRepoFromTextContext(params: {
  env: Env;
  actorUserId: string;
  context: RepoGuessTextContext | Promise<RepoGuessTextContext>;
  mode: RepoResolutionMode;
  sourceLabel: "Slack" | "Linear" | "Jira";
  matchedLogMessage: string;
  unavailableLogMessage: string;
  unknownLogMessage: string;
  ctx?: ExecutionContext;
}): Promise<RepoInferenceResult> {
  const [context, reposResult] = await Promise.all([
    Promise.resolve(params.context),
    listAccessibleReposForUser(params.env, params.actorUserId, { bypassCache: false }),
  ]);

  if (!reposResult.ok) {
    log.warn(
      { actorUserId: params.actorUserId, status: reposResult.status, error: reposResult.error },
      params.unavailableLogMessage,
    );
    return {
      status: "unavailable",
      reason: "Accessible repo list unavailable.",
      confidence: 0,
    };
  }

  const candidates = reposResult.repos
    .map(repoListItemToCandidate)
    .filter((candidate): candidate is RepoCandidate => Boolean(candidate));
  const guess = await resolveRepoFromTextContext({
    env: params.env,
    context,
    candidates,
    logger: log,
    mode: params.mode,
    waitUntil: params.ctx ? (promise) => params.ctx!.waitUntil(promise) : undefined,
  });

  if (guess.status === "matched") {
    log.info(
      {
        repoOwner: guess.repoOwner,
        repoName: guess.repoName,
        confidence: guess.confidence,
        source: params.sourceLabel.toLowerCase(),
      },
      params.matchedLogMessage,
    );
    return {
      status: "matched",
      repoUrl: `https://github.com/${guess.repoOwner}/${guess.repoName}`,
      repoOwner: guess.repoOwner,
      repoName: guess.repoName,
      confidence: guess.confidence,
      reason: guess.reason,
    };
  }

  log.info(
    {
      reason: guess.reason,
      confidence: guess.confidence,
      llmFailure: guess.llmFailure ?? null,
      source: params.sourceLabel.toLowerCase(),
    },
    params.unknownLogMessage,
  );
  // Only surface a disambiguation picker when the resolver returned an
  // explicit candidate subset. A fully empty guess.candidates means there
  // was no signal at all — falling back to every accessible repo would
  // turn no-signal prompts into a 100-option picker, which is broader than
  // the ambiguity-only intent.
  const unknownCandidates: RepoCandidate[] =
    guess.status === "unknown" && guess.candidates && guess.candidates.length > 0 ? guess.candidates : [];

  return {
    status: "unknown",
    reason: guess.reason,
    confidence: guess.confidence,
    ...(guess.llmFailure ? { llmFailure: guess.llmFailure } : {}),
    ...(unknownCandidates.length > 0 ? { candidates: unknownCandidates } : {}),
  };
}

async function collectSlackRepoTextContextParts(params: {
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  eventThreadTs: string | null;
  isAppMention: boolean;
  threadMessages?: SlackThreadMessage[];
}): Promise<SlackRepoTextContextParts> {
  const result: SlackRepoTextContextParts = {
    channelName: null,
    threadContext: null,
    previousMessageContext: null,
    threadMessages: [],
  };
  const token = params.slackBotToken;

  const channelNamePromise = runWithSentryTag(
    "getSlackConversationInfo",
    async () => {
      const conversation = await getConversationInfo(token, params.channelId);
      result.channelName = conversation?.name ?? null;
    },
    log,
  );

  if (params.eventThreadTs) {
    const threadContextPromise = runWithSentryTag(
      "getThreadReplies",
      async () => {
        const [threadMessages, botUserIdResult] = await Promise.all([
          params.threadMessages ?? getThreadReplies(token, params.channelId, params.threadTs),
          getSlackBotUserId(token),
        ]);
        result.threadMessages = threadMessages;
        const botUserId = botUserIdResult ?? undefined;
        result.threadContext = params.messageTs
          ? formatThreadContext(threadMessages, params.messageTs, botUserId, params.threadTs)
          : null;
        if (!result.threadContext && params.isAppMention && params.messageTs) {
          result.previousMessageContext = formatPreviousSlackMessageContext(
            threadMessages,
            params.messageTs,
            botUserId,
          );
        }
      },
      log,
    );
    await Promise.all([channelNamePromise, threadContextPromise]);
    return result;
  }

  await channelNamePromise;
  return result;
}

async function resolveLinearPromptContext(
  db: D1Database,
  actorUserId: string,
  env: Env,
  linearIssueId: string,
  sessionId: string,
): Promise<LinearPromptContextResult> {
  let linearToken: string | null = null;
  try {
    linearToken = await getValidLinearToken(db, actorUserId, env);
  } catch (err) {
    log.error({ linearIssueId, sessionId, error: String(err) }, "Failed to resolve Linear token for prompt context");
  }

  if (!linearToken) {
    log.warn(
      { userId: actorUserId, linearIssueId },
      "No Linear token available for Linear prompt comments or session attachment",
    );
    return emptyLinearPromptContext();
  }

  const comments = await fetchLinearIssueRecentComments(linearToken, linearIssueId);
  return { linearToken, comments, commentsFetched: comments.length, timedOut: false };
}

async function resolveLinearPromptContextBeforeDeadline(
  contextPromise: Promise<LinearPromptContextResult>,
  linearIssueId: string,
  sessionId: string,
): Promise<LinearPromptContextResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<LinearPromptContextResult>((resolve) => {
    timeoutId = setTimeout(() => {
      log.warn(
        { linearIssueId, sessionId, timeoutMs: LINEAR_PROMPT_CONTEXT_SOFT_TIMEOUT_MS },
        "Linear prompt context soft timeout elapsed",
      );
      resolve(emptyLinearPromptContext(true));
    }, LINEAR_PROMPT_CONTEXT_SOFT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([contextPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function postLinearRepoClarificationWhenTokenReady(
  contextPromise: Promise<LinearPromptContextResult>,
  linearIssueId: string,
  llmFailure: RepoResolutionFallbackFailureCategory | undefined,
  ctx?: ExecutionContext,
): void {
  const task = contextPromise
    .then(async ({ linearToken }) => {
      if (!linearToken) return;
      await postLinearIssueComment(linearToken, linearIssueId, linearRepoClarificationText(llmFailure));
    })
    .catch((err) => {
      log.error({ linearIssueId, error: String(err) }, "Failed to post Linear repo clarification");
    });
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}

// Skip reasons that warrant a user-facing comment on the issue. These all occur
// after actor resolution, so a Linear token for the actor is resolvable. Earlier
// identity-gate skips (unknown org, unconnected actor, etc.) are intentionally
// excluded: there is often no usable token and commenting would be noisy.
const LINEAR_SKIP_COMMENT_REASONS = new Set<string>([
  "invalid_repo_url",
  "no_installation",
  "repo_not_authorized",
  "repo_access_verification_failed",
]);

function linearSkipReasonCode(reason: string): IntegrationLifecycleReasonCode | null {
  switch (reason) {
    case "invalid_repo_url":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_URL_INVALID;
    case "no_installation":
      return INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING;
    case "repo_not_authorized":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED;
    case "repo_access_verification_failed":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_CHECK_FAILED;
    case "repo_inference_unavailable":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_INFERENCE_UNAVAILABLE;
    case "repo_inference_unknown":
      return INTEGRATION_LIFECYCLE_REASON_CODE.REPO_INFERENCE_UNKNOWN;
    case "webhook_timestamp_rejected":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_TIMESTAMP_REJECTED;
    case "missing_linear_tenant_metadata":
    case "missing_issue_id":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WEBHOOK_PAYLOAD_MALFORMED;
    case "unknown_linear_organization":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_NOT_INSTALLED;
    case "linear_webhook_mismatch":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH;
    case "non_user_actor":
    case "linear_user_not_connected":
    case "linear_actor_business_mismatch":
      return INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED;
    case "session_claim_lost":
      return INTEGRATION_LIFECYCLE_REASON_CODE.SESSION_CLAIM_LOST;
    case "session_bootstrap_failed":
      return INTEGRATION_LIFECYCLE_REASON_CODE.SESSION_BOOTSTRAP_FAILED;
    case "session_setup_failed":
      return INTEGRATION_LIFECYCLE_REASON_CODE.SESSION_SETUP_FAILED;
    case "linear_webhook_unbound_for_revoke":
      return INTEGRATION_LIFECYCLE_REASON_CODE.WORKSPACE_MISMATCH;
    case "integration_disabled":
      return INTEGRATION_LIFECYCLE_REASON_CODE.INTEGRATION_DISABLED;
    case "stale_session_ref_displaced":
      return INTEGRATION_LIFECYCLE_REASON_CODE.STALE_SESSION_REF_DISPLACED;
    default:
      return null;
  }
}

export interface WebhookDropFields {
  reason: string;
  /** Lifecycle status; defaults to SKIPPED. Use FAILED for error paths. */
  status?: IntegrationLifecycleStatus;
  /** False when another writer already records the D1 lifecycle event for this path. */
  emitLifecycle?: boolean;
  businessId?: string | null;
  userId?: string | number | null;
  sessionId?: string | null;
}

interface RecordWebhookDropOptions<TFields extends WebhookDropFields> {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  fields: TFields;
  lifecycleEmitter?: typeof emitLifecycleEvent;
  integrationId: IntegrationId;
  provider: string;
  eventName: string;
  label: string;
  reasonCode: (reason: string) => IntegrationLifecycleReasonCode | null;
  lifecycleDetails: (fields: TFields) => Record<string, unknown>;
  datadogFields: (fields: TFields) => Record<string, unknown>;
  logFailure: (fields: TFields, err: unknown) => void;
}

export async function emitWebhookSkipLifecycle(params: {
  db: D1Database;
  integrationId: IntegrationId;
  provider: string;
  businessId: string | null;
  userId: string | number | null;
  reason: string;
  reasonCode: IntegrationLifecycleReasonCode | null;
  message: string;
  details?: Record<string, unknown>;
  lifecycleEmitter?: typeof emitLifecycleEvent;
}): Promise<void> {
  const lifecycleEmitter = params.lifecycleEmitter ?? emitLifecycleEvent;
  await lifecycleEmitter({
    db: params.db,
    integrationId: params.integrationId,
    stage: INTEGRATION_LIFECYCLE_STAGE.SESSION_BOOTSTRAP_SKIPPED,
    status: INTEGRATION_LIFECYCLE_STATUS.SKIPPED,
    businessId: params.businessId,
    userId: params.userId,
    reasonCode: params.reasonCode,
    message: params.message,
    details: { provider: params.provider, reason: params.reason, ...(params.details ?? {}) },
  });
}

export async function emitWebhookDrop<TFields extends WebhookDropFields>(
  options: Omit<RecordWebhookDropOptions<TFields>, "ctx" | "logFailure">,
): Promise<void> {
  const { env, db, fields } = options;
  const lifecycleEmitter = options.lifecycleEmitter ?? emitLifecycleEvent;
  const status = fields.status ?? INTEGRATION_LIFECYCLE_STATUS.SKIPPED;
  if (fields.emitLifecycle !== false) {
    await lifecycleEmitter({
      db,
      integrationId: options.integrationId,
      stage: INTEGRATION_LIFECYCLE_STAGE.SESSION_BOOTSTRAP_SKIPPED,
      status,
      businessId: fields.businessId ?? null,
      userId: fields.userId,
      sessionId: fields.sessionId ?? null,
      reasonCode: options.reasonCode(fields.reason),
      message: `${options.label} webhook dropped: ${fields.reason}`,
      details: { provider: options.provider, reason: fields.reason, ...options.lifecycleDetails(fields) },
    });
  }
  await postStructuredEventToDd(env, {
    event: options.eventName,
    reason: fields.reason,
    status,
    businessId: fields.businessId ?? null,
    sessionId: fields.sessionId ?? null,
    ...options.datadogFields(fields),
  });
}

export function recordWebhookDrop<TFields extends WebhookDropFields>(options: RecordWebhookDropOptions<TFields>): void {
  const { ctx, fields } = options;
  const task = (async () => {
    await emitWebhookDrop(options);
  })().catch((err) => {
    options.logFailure(fields, err);
  });
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}

export interface LinearWebhookDropFields extends WebhookDropFields {
  deliveryId?: string | null;
  payloadHash?: string | null;
  workspaceId?: string | null;
  linearIssueId?: string | null;
}

function linearWebhookDropOptions(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  fields: LinearWebhookDropFields;
}): RecordWebhookDropOptions<LinearWebhookDropFields> {
  return {
    ...params,
    integrationId: "linear",
    provider: "linear",
    eventName: "linear.webhook_dropped",
    label: "Linear",
    reasonCode: linearSkipReasonCode,
    lifecycleDetails: (fields) => ({
      webhookDeliveryId: fields.deliveryId ?? null,
      payloadHash: fields.payloadHash ?? null,
      workspaceId: fields.workspaceId ?? null,
      linearIssueId: fields.linearIssueId ?? null,
    }),
    datadogFields: (fields) => ({
      deliveryId: fields.deliveryId ?? null,
      payloadHash: fields.payloadHash ?? null,
      workspaceId: fields.workspaceId ?? null,
      linearIssueId: fields.linearIssueId ?? null,
    }),
    logFailure: (fields, err) => {
      log.warn({ reason: fields.reason, error: String(err) }, "Failed to record Linear webhook drop");
    },
  };
}

/**
 * Records a dropped Linear webhook (skip or failure) so silently lost label
 * triggers are observable after the fact: a D1 lifecycle event for in-product
 * debugging plus a Datadog structured event (@event:linear.webhook_dropped)
 * for monitoring. Fields are stage-dependent — early drops only carry
 * delivery-level fields. Fire-and-forget; never blocks the webhook response.
 */
export function recordLinearWebhookDrop(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  fields: LinearWebhookDropFields;
}): void {
  recordWebhookDrop(linearWebhookDropOptions(params));
}

export function repoSkipCommentText(reason: string, repoOwner?: string | null, repoName?: string | null): string {
  const repoLabel = repoOwner && repoName ? `\`${repoOwner}/${repoName}\`` : "the target repo";
  switch (reason) {
    case "repo_inference_unknown":
    case "invalid_repo_url":
      return "Cycloid couldn't start a session: no repository could be determined for this issue. Set a default repo in your Cycloid settings, or add `repo=owner/name` to the description, then re-add the label.";
    case "no_installation":
      return `Cycloid couldn't start a session: the GitHub App isn't installed for ${repoLabel}. Install it, then re-add the label.`;
    case "repo_not_authorized":
      return `Cycloid couldn't start a session: you don't have access to ${repoLabel}.`;
    case "repo_access_verification_failed":
      return `Cycloid couldn't confirm access to ${repoLabel}. Reconnect GitHub in your Cycloid settings, then re-add the label.`;
    default:
      return "Cycloid couldn't start a session for this issue.";
  }
}

/**
 * Records, and where useful surfaces, a webhook skip that prevented a session
 * from starting. Always emits a queryable lifecycle event; for the user-actionable
 * repo-step reasons it also posts a comment on the Linear issue (deduped via
 * claimLinearIssueSkipNotice so duplicate webhook deliveries don't spam).
 * Best-effort: never blocks or fails the webhook response.
 */
export async function notifyLinearWebhookSkip(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  businessId: string | null;
  actorUserId: string;
  linearIssueId: string;
  reason: string;
  repoOwner?: string | null;
  repoName?: string | null;
  deliveryId?: string | null;
  payloadHash?: string | null;
  workspaceId?: string | null;
}): Promise<void> {
  const { env, db, ctx, businessId, actorUserId, linearIssueId, reason, repoOwner, repoName } = params;

  await emitWebhookSkipLifecycle({
    db,
    integrationId: "linear",
    provider: "linear",
    businessId,
    userId: actorUserId,
    reasonCode: linearSkipReasonCode(reason),
    message: `Linear session not started: ${reason}`,
    reason,
  });
  recordLinearWebhookDrop({
    env,
    db,
    ctx,
    fields: {
      reason,
      emitLifecycle: false,
      businessId,
      userId: actorUserId,
      linearIssueId,
      deliveryId: params.deliveryId ?? null,
      payloadHash: params.payloadHash ?? null,
      workspaceId: params.workspaceId ?? null,
    },
  });

  if (!LINEAR_SKIP_COMMENT_REASONS.has(reason)) return;

  const task = (async () => {
    const claimed = await claimLinearIssueSkipNotice(db, linearIssueId, reason);
    if (!claimed) return;

    let posted = false;
    try {
      const linearToken = await getValidLinearToken(db, actorUserId, env);
      if (linearToken) {
        const commentResult = await postLinearIssueComment(
          linearToken,
          linearIssueId,
          repoSkipCommentText(reason, repoOwner, repoName),
        );
        posted = commentResult.success;
      }
    } catch (err) {
      log.error({ linearIssueId, reason, error: String(err) }, "Failed to post Linear skip notice");
    }

    // Release the dedup slot when delivery did not succeed so a later webhook
    // can retry; a delivered comment keeps the slot to suppress duplicates.
    if (!posted) await deleteLinearIssueSkipNotice(db, linearIssueId, reason);
  })().catch((err) => {
    log.error({ linearIssueId, reason, error: String(err) }, "Linear skip notice task failed");
  });

  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}

/**
 * Verifies the Slack request timestamp and HMAC signature, then reads and
 * returns the raw body plus the parsed header values. Returns a 401 Response
 * on any verification failure so callers can do:
 *
 *   const result = await verifySlackRequest(request, env);
 *   if (result instanceof Response) return result;
 *   const { rawBody, timestamp, signature } = result;
 */
export async function verifySlackRequest(
  request: Request,
  env: Env,
): Promise<{ rawBody: string; timestamp: string; signature: string } | Response> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) {
    return jsonErrorResponse("Missing signature headers", 401);
  }

  const bodyResult = await readCappedWebhookBody(request);
  if (bodyResult instanceof Response) return bodyResult;
  const rawBody = bodyResult;
  const valid = await verifySlackWebhookSignature(rawBody, timestamp, signature, env.SLACK_SIGNING_SECRET || "");
  if (!valid) {
    return jsonErrorResponse("Invalid signature", 401);
  }

  return { rawBody, timestamp, signature };
}

/**
 * Attempt to claim webhook idempotency for the given source/event.
 * Returns the key the claim was written under (so failure paths can release
 * exactly that row) plus a duplicate-skip Response when already claimed, or
 * `duplicate: null` to proceed.
 */
export async function claimOrSkip(
  db: D1Database,
  source: string,
  eventId: string | null | unknown,
  payloadHash: string,
): Promise<{ duplicate: Response | null; idempotencyKey: string }> {
  const idempotencyKey = buildWebhookIdempotencyKey(source, eventId, payloadHash);
  const claimed = await claimWebhookIdempotency(db, source, idempotencyKey, payloadHash);
  if (!claimed) {
    log.info({ source, idempotencyKey, payloadHash }, "Skipping duplicate webhook delivery");
    return { duplicate: jsonResponse({ ok: true, skipped: true, reason: "duplicate" }), idempotencyKey };
  }
  return { duplicate: null, idempotencyKey };
}

export function lifecycleUserId(value: string | number | null | undefined): number | null {
  return parsePositiveIntegerUserId(value);
}

export async function emitLifecycleEvent(params: {
  db: D1Database;
  integrationId: IntegrationId;
  stage: IntegrationLifecycleStage;
  status: IntegrationLifecycleStatus;
  businessId?: string | null;
  userId?: string | number | null;
  sessionId?: string | null;
  reasonCode?: IntegrationLifecycleReasonCode | null;
  message: string;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await writeIntegrationLifecycleEvent(params.db, {
    integrationId: params.integrationId,
    stage: params.stage,
    status: params.status,
    businessId: params.businessId ?? null,
    userId: lifecycleUserId(params.userId),
    sessionId: params.sessionId ?? null,
    reasonCode: params.reasonCode ?? null,
    message: params.message,
    details: params.details ?? null,
  }).catch((error) => {
    log.warn(
      {
        integrationId: params.integrationId,
        stage: params.stage,
        status: params.status,
        sessionId: params.sessionId ?? null,
        error: String(error),
      },
      "Failed to emit integration lifecycle event from webhook handler",
    );
  });
}

type ParsedSlackRepoPrompt = ReturnType<typeof parseRepoPromptFromSlackMessage>;

interface SlackNewSessionParams {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  businessId: string;
  slackTeamId: string;
  slackBotToken: string;
  event: Record<string, unknown> | undefined;
  hasAttachments: boolean;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  eventThreadTs: string | null;
  isAppMention: boolean;
  actorUserId: string;
  actorLabel: string | null;
  text: string;
  parsedMessage: ParsedSlackRepoPrompt;
  preclaimedSessionId?: string;
  skipThreadClaim?: boolean;
  threadMessages?: SlackThreadMessage[];
  initialAttachments?: SlackAttachmentResult;
  // Webhook receipt time (Date.now()) captured at the top of the events handler,
  // used to measure mention -> "eyes" ack latency. Optional so internal replays
  // and tests can omit it.
  eventReceivedMs?: number;
}

type SlackRepoHint = "default" | "inferred" | null;
type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;

interface SlackSessionRepoResolutionParams extends SlackNewSessionParams {
  cachedSettings: Awaited<ReturnType<typeof getUserSettings>> | null;
}

interface SlackSessionRepoResolved {
  status: "resolved";
  repoUrl: string;
  prompt: string | null;
  repoHint: SlackRepoHint;
  threadContext: string | null;
  previousMessageContext: string | null;
  slackTextContextCollected: boolean;
  threadMessages: SlackThreadMessage[];
}

interface SlackSessionRepoSkipped {
  status: "skipped";
  response: Response;
  releaseReason: string;
}

type SlackSessionRepoResolutionResult = SlackSessionRepoResolved | SlackSessionRepoSkipped;

interface ResolveSlackSessionRepoDeps {
  collectSlackRepoTextContextParts: typeof collectSlackRepoTextContextParts;
  inferRepoFromTextContext: typeof inferRepoFromTextContext;
  listAccessibleReposForUser: typeof listAccessibleReposForUser;
  postSlackRepoClarification: typeof postSlackRepoClarification;
  postSlackRepoDisambiguation: typeof postSlackRepoDisambiguation;
}

const defaultResolveSlackSessionRepoDeps: ResolveSlackSessionRepoDeps = {
  collectSlackRepoTextContextParts,
  inferRepoFromTextContext,
  listAccessibleReposForUser,
  postSlackRepoClarification,
  postSlackRepoDisambiguation,
};

type SlackBareRepoNameHintResolution =
  | {
      status: "matched";
      repoUrl: string;
      repoOwner: string;
      repoName: string;
    }
  | {
      status: "ambiguous";
      candidates: RepoCandidate[];
    }
  | {
      status: "not_found" | "unavailable";
    };

async function resolveSlackBareRepoNameHint(params: {
  env: Env;
  actorUserId: string;
  repoNameHint: string;
  listAccessibleReposForUser: typeof listAccessibleReposForUser;
}): Promise<SlackBareRepoNameHintResolution> {
  const reposResult = await params.listAccessibleReposForUser(params.env, params.actorUserId, { bypassCache: false });
  if (!reposResult.ok) {
    log.warn(
      { actorUserId: params.actorUserId, status: reposResult.status, error: reposResult.error },
      "Slack bare repo-name lookup skipped: accessible repo list unavailable",
    );
    return { status: "unavailable" };
  }

  const normalizedHint = params.repoNameHint.trim().toLowerCase();
  const matches = reposResult.repos
    .map(repoListItemToCandidate)
    .filter((candidate): candidate is RepoCandidate => Boolean(candidate))
    .filter((candidate) => candidate.repoName.trim().toLowerCase() === normalizedHint);

  if (matches.length === 1) {
    const match = matches[0];
    return {
      status: "matched",
      repoUrl: `https://github.com/${match.repoOwner}/${match.repoName}`,
      repoOwner: match.repoOwner,
      repoName: match.repoName,
    };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", candidates: matches };
  }
  return { status: "not_found" };
}

export async function resolveSlackSessionRepo(
  params: SlackSessionRepoResolutionParams,
  deps: ResolveSlackSessionRepoDeps = defaultResolveSlackSessionRepoDeps,
): Promise<SlackSessionRepoResolutionResult> {
  const {
    env,
    db,
    ctx,
    slackBotToken,
    event,
    channelId,
    threadTs,
    messageTs,
    eventThreadTs,
    isAppMention,
    actorUserId,
    text,
    parsedMessage,
    cachedSettings,
  } = params;
  let repoUrl = parsedMessage.repoUrl;
  let prompt = parsedMessage.prompt;
  let repoHint: SlackRepoHint = null;
  let repoGuessChannelName: string | null = null;
  let threadContext: string | null = null;
  let previousMessageContext: string | null = null;
  let slackTextContextCollected = false;
  let threadMessages: SlackThreadMessage[] = params.threadMessages ?? [];
  if (parsedMessage.qa && !repoUrl && !parsedMessage.repoNameHint && parsedMessage.targetPrUrl) {
    const targetPr = parseGithubPullRequestUrl(parsedMessage.targetPrUrl);
    if (targetPr) repoUrl = `https://github.com/${targetPr.owner}/${targetPr.repo}`;
  }
  if (parsedMessage.repoNameHint) {
    const bareRepoNameResolution = await resolveSlackBareRepoNameHint({
      env,
      actorUserId,
      repoNameHint: parsedMessage.repoNameHint,
      listAccessibleReposForUser: deps.listAccessibleReposForUser,
    });
    if (bareRepoNameResolution.status === "matched") {
      repoUrl = bareRepoNameResolution.repoUrl;
    } else if (bareRepoNameResolution.status === "ambiguous") {
      const normalizedSlackUserId =
        typeof event?.user === "string" && event.user.length > 0 ? String(event.user) : null;
      const disambiguationOffered = await deps.postSlackRepoDisambiguation({
        env,
        slackBotToken,
        db,
        ctx,
        channelId,
        threadTs,
        messageTs,
        actorUserId,
        actorSlackUserId: normalizedSlackUserId,
        promptText: text,
        event,
        candidates: bareRepoNameResolution.candidates,
      });
      if (disambiguationOffered) {
        return {
          status: "skipped",
          releaseReason: "repo_disambiguation_offered",
          response: jsonResponse({
            ok: true,
            skipped: true,
            reason: "repo_disambiguation_offered",
            candidateCount: bareRepoNameResolution.candidates.slice(0, SLACK_REPO_DISAMBIGUATION_MAX_CANDIDATES).length,
          }),
        };
      }
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        slackInvalidBareRepoReply(parsedMessage.repoNameHint),
        "postSlackSetupError.bareRepoNameAmbiguous",
        ctx,
      );
      return {
        status: "skipped",
        releaseReason: "invalid_repo_url",
        response: jsonResponse({ ok: true, skipped: true, reason: "invalid_repo_url" }),
      };
    } else if (bareRepoNameResolution.status === "unavailable") {
      deps.postSlackRepoClarification(env, slackBotToken, channelId, threadTs, "timeout", ctx);
      return {
        status: "skipped",
        releaseReason: "repo_inference_unavailable",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_inference_unavailable" }),
      };
    } else {
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        slackInvalidBareRepoReply(parsedMessage.repoNameHint),
        "postSlackSetupError.bareRepoNameNotFound",
        ctx,
      );
      return {
        status: "skipped",
        releaseReason: "invalid_repo_url",
        response: jsonResponse({ ok: true, skipped: true, reason: "invalid_repo_url" }),
      };
    }
  }
  const selectionResult = await respondToWebhookRepoSelection({
    policy: {
      sourceLabel: "Slack",
      actorUserId,
      explicitRepoUrl: repoUrl,
      defaultRepoUrl: cachedSettings?.default_repo ?? null,
      fallBackFromInvalidExplicitRepoUrl: false,
      inferRepo: async () => {
        const contextParts = await deps.collectSlackRepoTextContextParts({
          slackBotToken,
          channelId,
          threadTs,
          messageTs,
          eventThreadTs,
          isAppMention,
          threadMessages: params.threadMessages,
        });
        repoGuessChannelName = contextParts.channelName;
        threadContext = contextParts.threadContext;
        previousMessageContext = contextParts.previousMessageContext;
        threadMessages = contextParts.threadMessages;
        slackTextContextCollected = true;

        const inference = await deps.inferRepoFromTextContext({
          env,
          actorUserId,
          context: buildSlackRepoGuessContext({
            text,
            channelId,
            channelName: repoGuessChannelName,
            threadContext,
            previousMessageContext,
            hasDefaultRepo: false,
            isThread: Boolean(eventThreadTs),
            isAppMention,
          }),
          mode: "slack",
          sourceLabel: "Slack",
          matchedLogMessage: "Slack repo inferred from text context",
          unavailableLogMessage: "Slack repo inference skipped: accessible repo list unavailable",
          unknownLogMessage: "Slack repo inference returned unknown",
          ctx,
        });

        if (inference.status === "matched") {
          return {
            status: "matched",
            repoUrl: inference.repoUrl,
            repoOwner: inference.repoOwner,
            repoName: inference.repoName,
          };
        }

        return {
          status: "skipped",
          reason: inference.status === "unavailable" ? "repo_inference_unavailable" : "repo_inference_unknown",
          llmFailure: inference.llmFailure,
          candidates: inference.candidates,
        };
      },
    },
    onRepoInferenceUnavailable: (selection) => {
      deps.postSlackRepoClarification(env, slackBotToken, channelId, threadTs, selection.llmFailure, ctx);
      return {
        releaseReason: "repo_inference_unavailable",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_inference_unavailable" }),
      };
    },
    onRepoInferenceUnknown: async (selection) => {
      const normalizedSlackUserId =
        typeof event?.user === "string" && event.user.length > 0 ? String(event.user) : null;
      const candidates = selection.candidates ?? [];
      let disambiguationOffered = false;
      if (candidates.length > 0 && !selection.llmFailure) {
        disambiguationOffered = await deps.postSlackRepoDisambiguation({
          env,
          slackBotToken,
          db,
          ctx,
          channelId,
          threadTs,
          messageTs,
          actorUserId,
          actorSlackUserId: normalizedSlackUserId,
          promptText: text,
          event,
          threadMessages,
          candidates,
        });
      }
      if (!disambiguationOffered) {
        deps.postSlackRepoClarification(env, slackBotToken, channelId, threadTs, selection.llmFailure, ctx);
        return {
          releaseReason: "repo_inference_unknown",
          response: jsonResponse({ ok: true, skipped: true, reason: "repo_inference_unknown" }),
        };
      }

      return {
        releaseReason: "repo_disambiguation_offered",
        response: jsonResponse({
          ok: true,
          skipped: true,
          reason: "repo_disambiguation_offered",
          candidateCount: candidates.slice(0, SLACK_REPO_DISAMBIGUATION_MAX_CANDIDATES).length,
        }),
      };
    },
  });
  if (selectionResult.status === "skipped") {
    return selectionResult;
  }

  repoUrl = selectionResult.selection.repoUrl;
  if (selectionResult.selection.source === "default") {
    repoHint = "default";
    prompt = parsedMessage.qa ? (parsedMessage.prompt ?? "") : text;
  } else if (selectionResult.selection.source === "inferred") {
    repoHint = "inferred";
    prompt = parsedMessage.qa ? (parsedMessage.prompt ?? "") : text;
  }

  return {
    status: "resolved",
    repoUrl,
    prompt,
    repoHint,
    threadContext,
    previousMessageContext,
    slackTextContextCollected,
    threadMessages,
  };
}

type SlackRepoAuthorizationResult =
  | {
      status: "authorized";
      owner: string;
      repo: string;
      installation: NonNullable<Awaited<ReturnType<typeof getInstallationByOwner>>>;
    }
  | {
      status: "skipped";
      response: Response;
      releaseReason: string;
    };

async function authorizeSlackRepo(params: {
  env: Env;
  db: D1Database;
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  actorUserId: string;
  repoUrl: string;
  ctx?: ExecutionContext;
}): Promise<SlackRepoAuthorizationResult> {
  const { env, db, slackBotToken, channelId, threadTs, actorUserId, repoUrl, ctx } = params;
  const authorizationResult = await respondToWebhookRepoAuthorization({
    policy: {
      sourceLabel: "Slack",
      env,
      db,
      actorUserId,
      repoUrl,
      repoOwner: null,
      repoName: null,
      verifyRepoAccess: isNumericUserId(actorUserId),
    },
    onInvalidRepoUrl: () => {
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        SLACK_INVALID_REPO_REPLY,
        "postSlackSetupError.invalidRepoUrl",
        ctx,
      );
      return {
        releaseReason: "invalid_repo_url",
        response: jsonResponse({ ok: true, skipped: true, reason: "invalid_repo_url" }),
      };
    },
    onNoInstallation: (authorization) => {
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        slackNoInstallationReply(authorization.owner ?? ""),
        "postSlackSetupError.noInstallation",
        ctx,
      );
      return {
        releaseReason: "no_installation",
        response: jsonResponse({ ok: true, skipped: true, reason: "no_installation" }),
      };
    },
    onRepoAccessVerificationFailed: (authorization) => {
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        slackRepoAccessVerificationFailedReply(authorization.owner ?? "", authorization.repo ?? ""),
        "postSlackSetupError.repoAccessVerificationFailed",
        ctx,
      );
      return {
        releaseReason: "repo_access_verification_failed",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_access_verification_failed" }),
      };
    },
    onRepoNotAuthorized: (authorization) => {
      postSlackSetupError(
        slackBotToken,
        channelId,
        threadTs,
        slackRepoNotAuthorizedReply(authorization.owner ?? "", authorization.repo ?? ""),
        "postSlackSetupError.repoNotAuthorized",
        ctx,
      );
      return {
        releaseReason: "repo_not_authorized",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_not_authorized" }),
      };
    },
  });

  if (authorizationResult.status === "authorized") {
    return {
      status: "authorized",
      owner: authorizationResult.authorization.owner,
      repo: authorizationResult.authorization.repo,
      installation: authorizationResult.authorization.installation,
    };
  }

  return {
    status: "skipped",
    releaseReason: authorizationResult.releaseReason,
    response: authorizationResult.response,
  };
}

type CreatedSessionState = Awaited<ReturnType<typeof createSessionState>>;

async function createSlackSessionRecord(params: {
  env: Env;
  db: D1Database;
  sessionId: string;
  actorUserId: string;
  businessId: string;
  owner: string;
  repo: string;
  repoContext: RepoContext;
  installationId: number;
  defaultModel: string | null;
  prompt: string;
  agentRuntime: AgentRuntimeMetadata;
  prUrl?: string | null;
  prNumber?: number | null;
  adoptedPrMetadata?: AdoptedPrMetadata | null;
  slackCallbackContext: SlackCallbackContext;
  onSessionCreated: () => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<CreatedSessionState> {
  const baseModel = resolveBaseModelForAutomaticRouting(params.defaultModel);
  const createdState = await createSessionState(params.env, params.sessionId, params.actorUserId, {
    businessId: params.businessId,
    entrypoint: SessionEntrypoint.SLACK,
    repoContext: params.repoContext,
    callbackContext: params.slackCallbackContext,
    installationId: params.installationId,
    model: baseModel.currentModel,
    agentRuntimeBackend: baseModel.agentRuntimeBackend,
    promptText: params.prompt,
    agentRole: params.agentRuntime.agentRole,
    agentProfile: params.agentRuntime.agentProfile,
    harnessKind: params.agentRuntime.harnessKind,
    runtimeStartupProfile: params.agentRuntime.runtimeStartupProfile,
    targetPrUrl: params.agentRuntime.targetPrUrl ?? null,
    prUrl: params.prUrl ?? null,
    prNumber: params.prNumber ?? null,
    waitUntil: params.waitUntil,
  });
  params.onSessionCreated();

  const { session, replay } = createdState;
  await persistInitialSessionProjection(params.env, {
    session,
    replay,
    sessionKind: "repo",
    projectionSource: "webhooks.slack.create",
    projectionUserId: params.actorUserId,
    adoptedPrMetadata: params.adoptedPrMetadata,
  });

  return createdState;
}

async function postSlackStartingStatus(params: {
  env: Env;
  slackBotToken: string;
  sessionId: string;
  repoFullName: string;
  repoHint: SlackRepoHint;
  slackCallbackContext: SlackCallbackContext;
}): Promise<void> {
  const { channel: channelId, threadTs } = params.slackCallbackContext;
  const frontendUrl = resolvePublicAppBaseUrl(params.env);
  const statusInput = {
    stage: "starting" as const,
    sessionId: params.sessionId,
    frontendUrl,
    repoFullName: params.repoFullName,
    repoHint: params.repoHint,
  };
  let postResult: { ok: boolean; ts?: string; error?: string };
  try {
    postResult = await postThreadReplyAndReportFailure({
      env: params.env,
      operation: "postRepoReply",
      sessionId: params.sessionId,
      slackBotToken: params.slackBotToken,
      channelId,
      threadTs,
      text: buildStatusFallbackText(statusInput),
      blocks: buildStatusBlocks(statusInput),
    });
  } catch (err) {
    log.error(
      { sessionId: params.sessionId, error: String(err), operation: "postRepoReply" },
      "Slack status reply threw",
    );
    Sentry.captureException(err, { tags: { operation: "postRepoReply", sessionId: params.sessionId } });
    postResult = { ok: false, error: String(err) };
  }
  if (postResult.ok && typeof postResult.ts === "string") {
    const updatedContext: SlackCallbackContext = { ...params.slackCallbackContext, statusMessageTs: postResult.ts };
    try {
      const updateResult = await updateSessionCallbackContext(params.env, params.sessionId, updatedContext);
      if (!updateResult.ok) {
        log.warn(
          { sessionId: params.sessionId, status: updateResult.status },
          "Failed to persist Slack statusMessageTs on session callback context",
        );
      }
    } catch (err) {
      log.warn(
        { sessionId: params.sessionId, error: String(err) },
        "Failed to persist Slack statusMessageTs on session callback context",
      );
      Sentry.captureException(err, { tags: { operation: "updateSlackStatusMessageTs", sessionId: params.sessionId } });
    }
  } else if (!postResult.ok) {
    log.warn(
      { sessionId: params.sessionId, slackError: postResult.error },
      "Slack status reply failed; continuing so completion notification can still post",
    );
  }
}

async function collectSlackBootstrapContext(params: {
  slackBotToken: string;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  eventThreadTs: string | null;
  isAppMention: boolean;
  threadContext: string | null;
  previousMessageContext: string | null;
  slackTextContextCollected: boolean;
  threadMessages: SlackThreadMessage[];
}): Promise<string | null> {
  let threadContext = params.threadContext;
  let previousMessageContext = params.previousMessageContext;

  // Fetch prior thread messages only when the trigger is inside an existing
  // Slack thread. Top-level invocations should not inherit adjacent channel
  // messages as prompt context.
  if (params.eventThreadTs && !params.slackTextContextCollected && params.threadMessages.length > 0) {
    await runWithSentryTag(
      "getThreadReplies",
      async () => {
        const botUserId = (await getSlackBotUserId(params.slackBotToken)) ?? undefined;
        const fetchedThreadContext = params.messageTs
          ? formatThreadContext(params.threadMessages, params.messageTs, botUserId, params.threadTs)
          : null;
        if (fetchedThreadContext) {
          threadContext = fetchedThreadContext;
          previousMessageContext = null;
        } else if (!threadContext && params.isAppMention && params.messageTs) {
          previousMessageContext = formatPreviousSlackMessageContext(
            params.threadMessages,
            params.messageTs,
            botUserId,
          );
        }
      },
      log,
    );
  }

  return (
    [threadContext, previousMessageContext].filter((value): value is string => Boolean(value)).join("\n\n") || null
  );
}

async function enqueueSlackBootstrapPrompt(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  slackBotToken: string;
  slackTeamId: string;
  event: Record<string, unknown> | undefined;
  channelId: string;
  threadTs: string;
  messageTs: string | null;
  eventThreadTs: string | null;
  isAppMention: boolean;
  actorUserId: string;
  session: CreatedSessionState["session"];
  installationId: number;
  repoUrl: string;
  prompt: string | null;
  agentRuntime: AgentRuntimeMetadata;
  threadContext: string | null;
  previousMessageContext: string | null;
  slackTextContextCollected: boolean;
  threadMessages: SlackThreadMessage[];
  initialAttachments?: SlackAttachmentResult;
}): Promise<Response> {
  // The session record exists by this point, so bootstrap-time operational
  // replies are budget-bound.
  const bootstrapSessionBudget: SlackThreadResponderSessionBudget = {
    env: params.env,
    sessionId: params.session.sessionId,
    slackTeamId: params.slackTeamId,
  };
  let threadMessages = params.threadMessages;
  if (params.eventThreadTs && params.threadMessages.length === 0) {
    let fetchedThreadMessages: SlackThreadMessage[] = [];
    await runWithSentryTag(
      "getThreadReplies",
      async () => {
        fetchedThreadMessages = await getThreadReplies(params.slackBotToken, params.channelId, params.threadTs);
      },
      log,
    );
    threadMessages = fetchedThreadMessages;
  }
  const attachmentMessages = filterSlackThreadMessagesForTrigger(params.event, threadMessages, params.messageTs);
  const attachments =
    params.initialAttachments ??
    (await collectSlackPromptAttachments({
      slackBotToken: params.slackBotToken,
      event: params.event,
      messages: params.eventThreadTs ? attachmentMessages : undefined,
      threadWide: Boolean(params.eventThreadTs),
      channelId: params.channelId,
      threadTs: params.threadTs,
      operation: "postSkippedSlackAttachments.newSession",
      sessionBudget: bootstrapSessionBudget,
      ctx: params.ctx,
    }));

  const slackContext = await collectSlackBootstrapContext({
    slackBotToken: params.slackBotToken,
    channelId: params.channelId,
    threadTs: params.threadTs,
    messageTs: params.messageTs,
    eventThreadTs: params.eventThreadTs,
    isAppMention: params.isAppMention,
    threadContext: params.threadContext,
    previousMessageContext: params.previousMessageContext,
    slackTextContextCollected: params.slackTextContextCollected,
    threadMessages,
  });

  const selectedPrompt = await resolveSlackPromptSkills({
    env: params.env,
    actorUserId: params.actorUserId,
    repoUrl: params.repoUrl,
    prompt: params.prompt,
    waitUntil: params.ctx ? (promise) => params.ctx!.waitUntil(promise) : undefined,
  });
  const builtBootstrapPrompt = buildSlackBootstrapPrompt(params.repoUrl, selectedPrompt.prompt, slackContext);
  // Resolve `<@ID>` mentions in the agent prompt, keeping the stable ID
  // (`@Name (<@ID>)`) so a self-set display name cannot impersonate a user.
  const bootstrapPrompt = builtBootstrapPrompt
    ? await resolveSlackMentions(builtBootstrapPrompt, {
        token: params.slackBotToken,
        kv: params.env.REPOS_CACHE,
        teamId: params.slackTeamId,
        keepRawId: true,
      })
    : builtBootstrapPrompt;
  const renderedReplyToText = slackReplyToTextForEvent(params.event, selectedPrompt.prompt);
  // Resolve mentions to bare `@Name` for the session-view display surface.
  const replyToText = renderedReplyToText
    ? await resolveSlackMentions(renderedReplyToText, {
        token: params.slackBotToken,
        kv: params.env.REPOS_CACHE,
        teamId: params.slackTeamId,
      })
    : renderedReplyToText;
  // replyToQuoteSource feeds the reply Cycloid posts back into Slack, where
  // `<@ID>` renders natively as @Name; intentionally left unresolved.
  const replyToQuoteSource = slackReplyToQuoteSourceForEvent(params.event);
  if (!bootstrapPrompt) {
    return jsonResponse({ ok: true, created: true, sessionId: params.session.sessionId, enqueued: false });
  }

  const enqueueResult = await enqueueSessionPrompt(
    params.env,
    params.session.sessionId,
    bootstrapPrompt,
    params.actorUserId,
    {
      source: "slack",
      ...(selectedPrompt.skills?.length ? { skills: selectedPrompt.skills } : {}),
      ...(params.agentRuntime.agentProfile !== DEFAULT_AGENT_NAME ? { agent: params.agentRuntime.agentProfile } : {}),
      ...(replyToText ? { replyToText } : {}),
      ...(replyToQuoteSource ? { replyToQuoteSource } : {}),
      uploadedFiles: attachments.uploadedFiles,
      uploadedImages: attachments.uploadedImages,
    },
  );
  if (!enqueueResult.ok) {
    postSlackSetupError(
      params.slackBotToken,
      params.channelId,
      params.threadTs,
      "I created the session but couldn't start work in it. Start a new Slack thread to try again.",
      "postSlackSetupError.bootstrapEnqueueFailed",
      params.ctx,
      bootstrapSessionBudget,
    );
    // Bootstrap targets a brand-new session; the eligibility gate shouldn't
    // fire here, but keep the switch shape so future codes don't fall through.
    switch (enqueueResult.error) {
      case PROMPT_SEND_BLOCKED_ERROR:
      default: {
        const err = new Error(
          enqueueResult.error === PROMPT_SEND_BLOCKED_ERROR
            ? `Bootstrap enqueue rejected as not sendable (reason=${enqueueResult.reason ?? "unknown"})`
            : `Session DO prompt enqueue failed with status ${enqueueResult.status}`,
        );
        await runWithSentryTag("handleSlackEventsWebhook.bootstrap", () => Promise.reject(err), log);
        throw err;
      }
    }
  }

  const ep = enqueueResult.payload!;
  await syncSessionProjection({
    db: params.db,
    sessionId: params.session.sessionId,
    session: ep.session,
    replay: ep.replay,
    logger: log,
    source: "webhooks.slack.bootstrap",
    userId: params.actorUserId,
  });

  await emitLifecycleEvent({
    db: params.db,
    integrationId: "slack",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_FOLLOWUP_ENQUEUED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: ep.session.businessId ?? null,
    userId: params.actorUserId,
    sessionId: params.session.sessionId,
    message: "Slack webhook created a session and enqueued the bootstrap prompt.",
    details: {
      provider: "slack",
      teamId: params.slackTeamId,
      eventKind: "session_bootstrap",
    },
  });

  return jsonResponse({
    ok: true,
    created: true,
    sessionId: params.session.sessionId,
    enqueued: true,
    prompt: toPublicEnqueuedPrompt(ep.prompt),
    dispatch: toPublicEnqueueDispatch(ep.dispatch),
  });
}

export async function handleSlackNewSession(params: SlackNewSessionParams): Promise<Response> {
  const {
    env,
    db,
    businessId,
    slackTeamId,
    slackBotToken,
    event,
    hasAttachments,
    channelId,
    threadTs,
    messageTs,
    eventThreadTs,
    isAppMention,
    actorUserId,
    actorLabel,
    text,
    parsedMessage,
    eventReceivedMs,
  } = params;

  // Repo disambiguation replays an attachment-only mention with a preclaimed
  // session. Let that replay bootstrap from the synthetic attachment event;
  // the ordinary webhook path still rejects a trigger with no prompt text.
  if (!text && hasAttachments && !params.preclaimedSessionId) {
    await collectSlackPromptAttachments({
      slackBotToken,
      event,
      channelId,
      threadTs,
      operation: "postSkippedSlackAttachments.newSessionMissingPrompt",
      downloadSupported: false,
      ctx: params.ctx,
    });
    postSlackAttachmentOnlyNewSessionReply(slackBotToken, channelId, threadTs, params.ctx);
    return jsonResponse({ ok: true, skipped: true, reason: "missing_prompt_text" });
  }

  let threadMessages = params.threadMessages;
  let initialAttachments = params.initialAttachments;
  if (!text && isAppMention && eventThreadTs && !hasAttachments) {
    threadMessages = await getThreadReplies(slackBotToken, channelId, threadTs);
    const attachmentMessages = filterSlackThreadMessagesForTrigger(event, threadMessages, messageTs);
    initialAttachments = await collectSlackPromptAttachments({
      slackBotToken,
      event,
      messages: attachmentMessages,
      threadWide: true,
      channelId,
      threadTs,
      operation: "postSkippedSlackAttachments.newSessionMissingPrompt",
      ctx: params.ctx,
    });
    const hasUsableAttachments =
      initialAttachments.uploadedFiles.length > 0 || initialAttachments.uploadedImages.length > 0;
    if (!hasUsableAttachments) {
      postSlackAttachmentOnlyNewSessionReply(slackBotToken, channelId, threadTs, params.ctx);
      return jsonResponse({ ok: true, skipped: true, reason: "missing_prompt_text" });
    }
  }

  if (parsedMessage.removedVerifyDirective) {
    postSlackSetupError(
      slackBotToken,
      channelId,
      threadTs,
      "The old Slack QA directive is no longer supported. Use `qa=true` with a GitHub pull request URL.",
      "postSlackSetupError.removedVerifyDirective",
      params.ctx,
    );
    return jsonResponse({ ok: true, skipped: true, reason: "removed_verify_directive" });
  }
  const sessionId = params.preclaimedSessionId ?? crypto.randomUUID();
  const threadBusinessId = businessId.trim();
  if (!threadBusinessId) {
    postSlackSetupError(
      slackBotToken,
      channelId,
      threadTs,
      "I couldn't resolve your Cycloid business for this Slack request. Reconnect Slack in Cycloid settings and try again.",
      "postSlackSetupError.businessMissing",
      params.ctx,
    );
    return jsonResponse({ ok: true, skipped: true, reason: "business_missing" });
  }
  let claimReleased = false;
  let sessionCreated = false;
  let threadClaimed = Boolean(params.preclaimedSessionId);
  const releaseClaim = async (reason: string) => {
    if (claimReleased || sessionCreated || !threadClaimed) return;
    claimReleased = true;
    await releaseSlackThreadSessionClaim({
      db,
      businessId: threadBusinessId,
      teamId: slackTeamId,
      channelId,
      threadTs,
      sessionId,
      reason,
    });
  };
  // Handle to the optimistic "eyes" ack (assigned once it's fired below). Kept
  // here so both the intentional pre-session bail paths and the unexpected-error
  // funnel can clear the reaction; null until the ack fires, so removal is a
  // no-op before then.
  let eyesReactionAdded: Promise<void> | null = null;
  // Clears the optimistic "eyes" ack on a pre-session bail (repo disambiguation,
  // missing QA target PR) or an unexpected pre-session throw. Awaits the add first
  // so a still-pending fire-and-forget add can't land after the remove and leave
  // the reaction behind. runWithSentryTag never rejects, so awaiting it is safe.
  const removeEyesReactionOnBail = async (operation: string): Promise<void> => {
    if (!eyesReactionAdded || !messageTs || !channelId) return;
    await eyesReactionAdded;
    await removeReaction(slackBotToken, channelId, messageTs, "eyes").catch((err) => {
      log.error({ channelId, messageTs, error: String(err) }, `Failed to remove eyes reaction (${operation})`);
      Sentry.captureException(err, { tags: { operation } });
    });
  };
  const releaseClaimOnUnexpectedPreSessionError = async <T>(
    reason: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      // The ack is scheduled before this funnel's steps (settings, repo, auth,
      // continuation). On a throw in the ctx.waitUntil path the webhook is already
      // accepted, so nothing else clears the reaction - drop it here too.
      await removeEyesReactionOnBail(reason);
      await releaseClaim(reason);
      throw err;
    }
  };
  if (parsedMessage.qa && parsedMessage.targetPrUrlSelection.status === "ambiguous") {
    try {
      await postThreadReplyAndReportFailure({
        env,
        operation: "postAmbiguousVerificationPrReply",
        sessionId,
        slackBotToken,
        channelId,
        threadTs,
        text: AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE,
      });
    } finally {
      await releaseClaim("ambiguous_target_pr_url");
    }
    return jsonResponse({ ok: true, skipped: true, reason: "ambiguous_target_pr_url" });
  }
  if (!params.preclaimedSessionId && !params.skipThreadClaim) {
    let claimedThread = await claimSlackThreadSessionRef(
      db,
      threadBusinessId,
      slackTeamId,
      channelId,
      threadTs,
      sessionId,
    );
    threadClaimed = claimedThread;
    if (!claimedThread) {
      let claimedSessionId = await getSessionIdBySlackThreadRef(db, threadBusinessId, slackTeamId, channelId, threadTs);
      if (!claimedSessionId) {
        for (const delayMs of SLACK_THREAD_CLAIM_RETRY_DELAYS_MS) {
          await sleep(delayMs);
          claimedThread = await claimSlackThreadSessionRef(
            db,
            threadBusinessId,
            slackTeamId,
            channelId,
            threadTs,
            sessionId,
          );
          threadClaimed = claimedThread;
          if (claimedThread) break;
          claimedSessionId = await getSessionIdBySlackThreadRef(db, threadBusinessId, slackTeamId, channelId, threadTs);
          if (claimedSessionId) break;
        }
      }
      if (claimedThread) {
        // A prior claimant released the thread before it finished creating a session.
      } else {
        const followUpText = parsedMessage.prompt ?? text;
        if (parsedMessage.qa) {
          log.info(
            { channelId, threadTs, sessionId: claimedSessionId },
            "Starting Slack verification session without replacing existing thread session claim",
          );
        } else {
          log.info(
            { channelId, threadTs, sessionId: claimedSessionId },
            "Skipping Slack new-session event: thread already claimed",
          );
          if (!claimedSessionId) {
            return jsonResponse({
              ok: true,
              created: false,
              skipped: true,
              reason: "slack_thread_already_claimed",
            });
          }
          return handleSlackThreadFollowUp({
            env,
            db,
            ctx: params.ctx,
            event,
            text: followUpText,
            channelId,
            threadTs,
            messageTs,
            isAppMention,
            actorUserId,
            actorLabel,
            slackTeamId,
            slackBotToken,
            existingSessionId: claimedSessionId,
            eventReceivedMs: params.eventReceivedMs,
          });
        }
      }
    }
  }

  // Add the "eyes" ack the moment we own the thread - before user settings and
  // repo resolution (which can run an LLM inference) - so perceived latency is
  // one reactions.add round-trip, not seconds. Fire-and-forget; the handle above
  // lets pre-session bail/throw paths await the add before removing the reaction,
  // preventing a still-pending add from re-applying it. Emits the mention -> ack
  // latency metric only when the reaction actually landed.
  log.info({ channelId, messageTs, teamId: slackTeamId, hasToken: true }, "Adding eyes reaction (new session)");
  if (messageTs && channelId) {
    eyesReactionAdded = runWithSentryTag(
      "addReaction.newSession",
      async () => {
        const res = await addReaction(slackBotToken, channelId, messageTs, "eyes");
        log.debug({ result: res }, "Eyes reaction result (new session)");
        if (res.ok && eventReceivedMs != null) {
          await emitSlackMentionAckLatencyMetric(env, "new_session", Date.now() - eventReceivedMs);
        }
      },
      log,
    );
    scheduleWebhookTask(params.ctx, eyesReactionAdded);
  }

  // Fetch user settings once for both default_repo and default_model
  const cachedSettings = await releaseClaimOnUnexpectedPreSessionError("resolve_user_settings_failed", () =>
    resolveUserSettings(db, actorUserId),
  );
  const defaultModel =
    extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(cachedSettings?.default_model)) ?? null;

  const repoResolution = await releaseClaimOnUnexpectedPreSessionError("resolve_slack_session_repo_failed", () =>
    resolveSlackSessionRepo({ ...params, cachedSettings, threadMessages, initialAttachments }),
  );
  if (repoResolution.status === "skipped") {
    // Repo is ambiguous/unresolved and we've posted a clarification instead of
    // starting - drop the "processing" ack so it doesn't contradict the question.
    await removeEyesReactionOnBail("removeReaction.repoResolutionSkipped");
    await releaseClaim(repoResolution.releaseReason);
    return repoResolution.response;
  }

  const authorization = await releaseClaimOnUnexpectedPreSessionError("installation_lookup_failed", () =>
    authorizeSlackRepo({
      env,
      db,
      slackBotToken,
      channelId,
      threadTs,
      actorUserId,
      repoUrl: repoResolution.repoUrl,
      ctx: params.ctx,
    }),
  );
  if (authorization.status === "skipped") {
    await releaseClaim(authorization.releaseReason);
    return authorization.response;
  }

  const slackCallbackContext: SlackCallbackContext = {
    source: "slack",
    channel: channelId,
    threadTs,
    slackTeamId,
    reactionMessageTimestamps: messageTs ? [messageTs] : undefined,
  };
  let continuationRepoContext: RepoContext = { repoOwner: authorization.owner, repoName: authorization.repo };
  let continuationAdoptedPrMetadata: AdoptedPrMetadata | null = null;
  let continuationTargetPrUrl: string | null = null;
  let continuationPrUrl: string | null = null;
  let continuationPrNumber: number | null = null;
  if (!parsedMessage.qa) {
    try {
      const continuation = await resolveSessionContinuation({
        env,
        sessionId,
        prompt: repoResolution.prompt ?? text,
        repoContext: continuationRepoContext,
        installationId: authorization.installation.installation_id,
        allowPromptInference: true,
        logger: log,
        telemetry: {
          sessionId,
          ownerUserId: actorUserId,
          repoOwner: authorization.owner,
          repoName: authorization.repo,
        },
      });
      continuationRepoContext = continuation.repoContext;
      continuationTargetPrUrl = continuation.targetPrUrl;
      continuationPrUrl = continuation.prUrl;
      continuationPrNumber = continuation.prNumber;
      continuationAdoptedPrMetadata = continuation.adoptedPrMetadata;
    } catch (error) {
      if (error instanceof SessionContinuationError) {
        if (channelId && threadTs) {
          await postThreadReplyAndReportFailure({
            env,
            operation: "postContinuationFailureReply",
            sessionId,
            slackBotToken,
            channelId,
            threadTs,
            text: `Could not continue that pull request: ${error.publicMessage}`,
          });
        }
        await releaseClaim("continue_pr_resolution_failed");
        return jsonResponse({ ok: true, skipped: true, reason: error.reasonCode, error: error.publicMessage });
      }
      throw error;
    }
  }
  const agentRuntime = resolveAgentRuntimeMetadata({
    qa: parsedMessage.qa,
    targetPrUrl: continuationTargetPrUrl ?? parsedMessage.targetPrUrl,
  });
  if (requiresQaTargetPrUrl({ qa: parsedMessage.qa, targetPrUrl: agentRuntime.targetPrUrl })) {
    try {
      if (channelId && threadTs) {
        await postThreadReplyAndReportFailure({
          env,
          operation: "postMissingVerificationPrReply",
          sessionId,
          slackBotToken,
          channelId,
          threadTs,
          text: "QA requires a GitHub pull request URL. Include the pull request URL in your Slack message.",
        });
      }
      // We bail before ever creating a session, so the terminal cleanup that
      // normally clears the optimistic "eyes" reaction never runs. Remove it
      // here (best-effort) so the parent message doesn't keep signaling "processing".
      await removeEyesReactionOnBail("removeReaction.missingTargetPrUrl");
    } finally {
      await releaseClaim("missing_target_pr_url");
    }
    return jsonResponse({ ok: true, skipped: true, reason: "missing_target_pr_url" });
  }
  if (
    isQaTesterAgentRole(agentRuntime.agentRole) &&
    agentRuntime.targetPrUrl &&
    !githubPullRequestUrlMatchesRepo(agentRuntime.targetPrUrl, authorization.owner, authorization.repo)
  ) {
    try {
      if (channelId && threadTs) {
        await postThreadReplyAndReportFailure({
          env,
          operation: "postVerificationPrRepoMismatchReply",
          sessionId,
          slackBotToken,
          channelId,
          threadTs,
          text: `QA target pull request must belong to the selected repo, ${authorization.owner}/${authorization.repo}.`,
        });
      }
    } finally {
      await releaseClaim("target_pr_repo_mismatch");
    }
    return jsonResponse({ ok: true, skipped: true, reason: "target_pr_repo_mismatch" });
  }
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  if (isQaTesterAgentRole(agentRuntime.agentRole) && agentRuntime.targetPrUrl) {
    const coordinated = await requestCoordinatedVerification({
      env,
      logger: log,
      waitUntil: params.ctx?.waitUntil.bind(params.ctx),
      source: "slack",
      ownerUserId: actorUserId,
      businessId: threadBusinessId,
      repoOwner: authorization.owner,
      repoName: authorization.repo,
      installationId: authorization.installation.installation_id,
      prUrl: agentRuntime.targetPrUrl,
      prompt: repoResolution.prompt ?? text,
      callbackContext: slackCallbackContext,
    });
    if (coordinated.ok) {
      if (channelId) {
        await postThreadReplyAndReportFailure({
          env,
          operation: coordinated.duplicate ? "postActiveVerifierReply" : "postCoordinatedVerificationReply",
          sessionId: coordinated.sessionId,
          slackBotToken,
          channelId,
          threadTs,
          text: coordinated.duplicate
            ? `🔍 A verification session is already running for that pull request: ${resolvePublicSessionUrl(env, coordinated.sessionId)}`
            : `🔍 Started verification session: ${resolvePublicSessionUrl(env, coordinated.sessionId)}`,
        });
      }
      await releaseClaim(coordinated.duplicate ? "verifier_active" : "coordinated_verification_started");
      return jsonResponse({
        ok: true,
        skipped: coordinated.duplicate,
        reason: coordinated.duplicate ? "verifier_active" : undefined,
        sessionId: coordinated.sessionId,
      });
    }
    if (coordinated.reason === "run_limit_reached") {
      if (channelId) {
        await postThreadReplyAndReportFailure({
          env,
          operation: "postVerificationRunLimitReply",
          sessionId,
          slackBotToken,
          channelId,
          threadTs,
          text: "🔍 Verification has reached the run limit for that pull request.",
        });
      }
      await releaseClaim("verification_run_limit_reached");
      return jsonResponse({ ok: true, skipped: true, reason: "verification_run_limit_reached" });
    }
    if (coordinated.reason === "schedule_failed") {
      log.warn(
        {
          channelId,
          threadTs,
          repoOwner: authorization.owner,
          repoName: authorization.repo,
          targetPrUrl: agentRuntime.targetPrUrl,
          error: coordinated.error,
        },
        "Slack QA coordinator scheduling failed; releasing claim for retry",
      );
      await releaseClaim("schedule_failed");
      return jsonErrorResponse("Slack QA coordinator scheduling failed — retry", 500);
    }
    if (coordinated.reason === "invalid_pr" && channelId) {
      await postThreadReplyAndReportFailure({
        env,
        operation: "postInvalidVerificationPrReply",
        sessionId,
        slackBotToken,
        channelId,
        threadTs,
        text: "Could not start QA because the target pull request could not be resolved.",
      });
    }
    log.warn(
      {
        channelId,
        threadTs,
        repoOwner: authorization.owner,
        repoName: authorization.repo,
        targetPrUrl: agentRuntime.targetPrUrl,
        reason: coordinated.reason,
        error: coordinated.error,
      },
      "Slack QA coordinator request failed",
    );
    await releaseClaim(coordinated.reason);
    return jsonResponse({ ok: true, skipped: true, reason: coordinated.reason });
  }
  let createdState: CreatedSessionState;
  try {
    createdState = await createSlackSessionRecord({
      env,
      db,
      sessionId,
      actorUserId,
      businessId: threadBusinessId,
      owner: authorization.owner,
      repo: authorization.repo,
      repoContext: continuationRepoContext,
      installationId: authorization.installation.installation_id,
      defaultModel,
      prompt: repoResolution.prompt ?? text,
      agentRuntime,
      prUrl: continuationPrUrl,
      prNumber: continuationPrNumber,
      adoptedPrMetadata: continuationAdoptedPrMetadata,
      slackCallbackContext,
      onSessionCreated: () => {
        sessionCreated = true;
      },
      waitUntil: params.ctx ? params.ctx.waitUntil.bind(params.ctx) : undefined,
    });
  } catch (err) {
    if (err instanceof ProviderCredentialNotValidatedError) {
      await releaseClaim(PROVIDER_KEY_NOT_VALIDATED_ERROR);
      if (channelId && threadTs) {
        const reply = slackMissingModelKeyReply({
          modelLabel: formatModelLabel(err.modelId, { includeProvider: true }) ?? err.modelId,
          provider: err.provider,
          integrationsUrl: slackIntegrationsSettingsUrl(env),
          workspaceIntegrationsUrl: slackWorkspaceIntegrationsSettingsUrl(env),
          generalUrl: slackGeneralSettingsUrl(env),
          reasonCode: err.reasonCode,
        });
        try {
          const postResult = await postThreadReplyAndReportFailure({
            env,
            operation: "postMissingModelKeyReply",
            sessionId,
            slackBotToken,
            channelId,
            threadTs,
            text: reply,
          });
          if (postResult.ok) {
            log.info(
              {
                action: "slack_missing_model_key_reply_posted",
                reasonCode: err.reasonCode,
                provider: err.provider,
                sessionId,
              },
              "Posted Slack missing model key reply",
            );
          } else {
            log.warn(
              {
                action: "slack_missing_model_key_reply_failed",
                reasonCode: err.reasonCode,
                provider: err.provider,
                sessionId,
                slackError: postResult.error,
              },
              "Slack missing model key reply failed",
            );
          }
        } catch (postError) {
          log.warn(
            {
              action: "slack_missing_model_key_reply_threw",
              reasonCode: err.reasonCode,
              provider: err.provider,
              sessionId,
              error: String(postError),
            },
            "Slack missing model key reply threw",
          );
          Sentry.captureException(postError, {
            tags: { operation: "postSlackMissingModelKeyReply", sessionId, provider: err.provider },
          });
        }
      }
      return jsonResponse({ ok: true, skipped: true, reason: PROVIDER_KEY_NOT_VALIDATED_ERROR });
    }
    if (isOpencodeAccessDeniedError(err)) {
      await releaseClaim(OPENCODE_ACCESS_DENIED_ERROR);
      return jsonResponse({ ok: true, skipped: true, reason: OPENCODE_ACCESS_DENIED_ERROR });
    }
    if (!sessionCreated) {
      await releaseClaim("create_session_failed");
    }
    throw err;
  }
  const { session } = createdState;

  // Post the durable session status message into the Slack thread.
  //
  // This post must complete before the sandbox prompt is enqueued so the
  // initial status message cannot be reordered behind a fast completion
  // notification (ARC-725). Both messages are posted via chat.postMessage into
  // the same thread, and Slack renders them in the order the API accepts them.
  // If the post fails we log and continue -- there is no status message to
  // race, and the session should still run. The whole caller is already inside
  // ctx.waitUntil, so awaiting here does not delay the webhook 200 response.
  if (channelId && threadTs) {
    await postSlackStartingStatus({
      env,
      slackBotToken,
      sessionId,
      repoFullName: `${authorization.owner}/${authorization.repo}`,
      repoHint: repoResolution.repoHint,
      slackCallbackContext,
    });
  }

  return enqueueSlackBootstrapPrompt({
    env,
    db,
    ctx: params.ctx,
    slackBotToken,
    slackTeamId,
    event,
    channelId,
    threadTs,
    messageTs,
    eventThreadTs,
    isAppMention,
    actorUserId,
    session,
    installationId: authorization.installation.installation_id,
    repoUrl: repoResolution.repoUrl,
    prompt: repoResolution.prompt,
    agentRuntime,
    threadContext: repoResolution.threadContext,
    previousMessageContext: repoResolution.previousMessageContext,
    slackTextContextCollected: repoResolution.slackTextContextCollected,
    threadMessages: repoResolution.threadMessages,
    initialAttachments,
  });
}

export async function runSlackSessionCreateInBackgroundSpan(params: {
  env: Env;
  operation: string;
  logger: Logger;
  task: () => Promise<unknown>;
}): Promise<void> {
  const span = startSpan("slack.session_create", { operation: params.operation });
  await runInSpan(span, async () => {
    try {
      await runWithSentryTag(
        params.operation,
        async () => {
          try {
            await params.task();
            endSpan(span, "ok");
          } catch (error) {
            endSpan(span, "error", { "error.message": String(error) });
            throw error;
          }
        },
        params.logger,
      );
    } finally {
      await flushSpansToQueue(
        params.env.TRACE_QUEUE,
        "cycloid-control-plane-worker",
        normalizeEnvironment(params.env.WORKER_ENV, ENVIRONMENT.Production),
      );
    }
  });
}

interface ParsedDisambiguationSelection {
  disambiguationId: string;
  candidateIndex: number;
}

// Select value format: `<disambigId>:<candidateIndex>`.
function parseDisambiguationSelection(value: unknown): ParsedDisambiguationSelection | null {
  if (typeof value !== "string") return null;
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) return null;
  const disambiguationId = value.slice(0, idx);
  const selection = value.slice(idx + 1);
  if (!disambiguationId || !/^\d+$/.test(selection)) return null;
  const candidateIndex = Number.parseInt(selection, 10);
  if (!Number.isSafeInteger(candidateIndex)) return null;
  return { disambiguationId, candidateIndex };
}

function disambiguationActionValue(action: Record<string, unknown> | null): unknown {
  const selectedOption = action?.selected_option;
  if (
    selectedOption &&
    typeof selectedOption === "object" &&
    !Array.isArray(selectedOption) &&
    typeof (selectedOption as { value?: unknown }).value === "string"
  ) {
    return (selectedOption as { value: string }).value;
  }
  return action?.value;
}

export async function handleSlackRepoDisambiguationSelection(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  action: Record<string, unknown> | null;
}): Promise<Response> {
  const { env, db, ctx, payload, action } = params;
  const parsed = parseDisambiguationSelection(disambiguationActionValue(action));
  if (!parsed) {
    log.warn({}, "Slack repo disambiguation action rejected: invalid value");
    return jsonResponse({ ok: true, skipped: true, reason: "invalid_disambiguation_value" });
  }

  const user = payload.user as Record<string, unknown> | undefined;
  const clickingSlackUserId = typeof user?.id === "string" ? (user.id as string) : null;
  if (!clickingSlackUserId) {
    log.warn({}, "Slack repo disambiguation action rejected: missing user id");
    return jsonResponse({ ok: true, skipped: true, reason: "missing_user" });
  }

  const now = Date.now();
  const [record, linkedUser] = await Promise.all([
    peekSlackRepoDisambiguation(db, parsed.disambiguationId, now),
    getUserBySlackId(db, clickingSlackUserId),
  ]);
  if (!record) {
    log.info(
      { disambiguationId: parsed.disambiguationId },
      "Slack repo disambiguation record missing, consumed, or expired",
    );
    const responseUrl = typeof payload.response_url === "string" ? (payload.response_url as string) : null;
    if (responseUrl && isSlackResponseUrl(responseUrl)) {
      const ephemeralPromise = runWithSentryTag(
        "postRepoDisambiguationExpired",
        () =>
          tracedFetch(
            responseUrl,
            {
              method: "POST",
              headers: { [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json" },
              body: JSON.stringify({
                response_type: "ephemeral",
                replace_original: false,
                text: "That repo picker expired. Mention Cycloid again to try once more.",
              }),
            },
            "slack.response_url",
          ).then(() => undefined),
        log,
      );
      if (ctx) {
        ctx.waitUntil(ephemeralPromise);
      } else {
        void ephemeralPromise;
      }
    }
    return jsonResponse({ ok: true, skipped: true, reason: "disambiguation_unavailable" });
  }

  // Verify the clicker is the original requester BEFORE consuming, so an
  // intruder cannot burn the disambiguation. Match on Slack user id since
  // the control-plane actor id is numeric and not in the Slack payload.
  if (!record.actorSlackUserId) {
    log.warn(
      { disambiguationId: parsed.disambiguationId },
      "Slack repo disambiguation rejected: missing original Slack user id",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "disambiguation_user_missing" });
  }

  if (record.actorSlackUserId !== clickingSlackUserId) {
    log.warn(
      {
        disambiguationId: parsed.disambiguationId,
        expectedSlackUserId: record.actorSlackUserId,
        clickingSlackUserId,
      },
      "Slack repo disambiguation rejected: clicking user mismatch",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "disambiguation_user_mismatch" });
  }

  if (!linkedUser) {
    log.info({ slackUserId: clickingSlackUserId }, "Slack repo disambiguation rejected: Slack user not connected");
    return jsonResponse({ ok: true, skipped: true, reason: "slack_not_connected" });
  }
  if (!(await isSlackWebhookAvailable(db, linkedUser.id))) {
    log.info({ userId: linkedUser.id }, "Slack repo disambiguation rejected: Slack integration disabled");
    return jsonResponse({ ok: true, skipped: true, reason: "integration_disabled" });
  }
  if (String(linkedUser.id) !== record.actorUserId) {
    log.warn(
      {
        disambiguationId: parsed.disambiguationId,
        actorUserId: record.actorUserId,
        linkedUserId: linkedUser.id,
      },
      "Slack repo disambiguation rejected: linked user no longer matches original actor",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "disambiguation_actor_mismatch" });
  }
  const candidate = record.candidates[parsed.candidateIndex];
  if (!candidate) {
    log.warn(
      { disambiguationId: parsed.disambiguationId, candidateIndex: parsed.candidateIndex },
      "Slack repo disambiguation rejected: candidate index outside stored candidates",
    );
    return jsonResponse({ ok: true, skipped: true, reason: "repo_not_in_candidates" });
  }
  const selectedOwner = candidate.repoOwner;
  const selectedRepo = candidate.repoName;
  const omittedPlaceholderCount =
    record.attachmentFileIds.length >= SLACK_MAX_ATTACHMENTS_PER_THREAD
      ? Math.min(record.attachmentOmittedCount, SLACK_MAX_ATTACHMENTS_PER_THREAD)
      : 0;
  const syntheticEvent =
    record.attachmentFileIds.length > 0
      ? {
          type: "app_mention",
          channel: record.channelId,
          ts: record.messageTs ?? record.threadTs,
          thread_ts: record.threadTs,
          user: record.actorSlackUserId ?? undefined,
          files: [
            ...record.attachmentFileIds.map((id) => ({ id })),
            ...Array.from({ length: omittedPlaceholderCount }, (_, index) => ({
              id: `omitted-slack-attachment-${index}`,
            })),
          ],
        }
      : undefined;

  const slackTeamId = getSlackTeamIdFromInteractionPayload(payload);
  const slackBotToken = await resolveSlackWebhookBotToken(env, slackTeamId, "handleSlackRepoDisambiguationSelection");
  if (!slackTeamId || !slackBotToken) {
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: slackTeamId ? "slack_workspace_token_missing" : "missing_slack_team_id",
    });
  }

  const parsedDisambiguationPrompt = parseRepoPromptFromSlackMessage(record.promptText);
  const sessionId = crypto.randomUUID();
  const actorBusinessId = isNumericUserId(record.actorUserId)
    ? await getUserBusinessIdOrNull(db, Number(record.actorUserId))
    : null;
  const workspaceBusinessId = (await getWorkspaceInstallMetadata(db, slackTeamId))?.businessId ?? null;
  const threadBusinessId = workspaceBusinessId ?? actorBusinessId;
  if (!threadBusinessId) return jsonResponse({ ok: true, skipped: true, reason: "business_missing" });
  const claimedThread = await claimSlackThreadSessionRef(
    db,
    threadBusinessId,
    slackTeamId,
    record.channelId,
    record.threadTs,
    sessionId,
  );
  if (!claimedThread) {
    const claimedSessionId = await getSessionIdBySlackThreadRef(
      db,
      threadBusinessId,
      slackTeamId,
      record.channelId,
      record.threadTs,
    );
    log.info(
      { disambiguationId: parsed.disambiguationId, channelId: record.channelId, threadTs: record.threadTs },
      "Slack repo disambiguation selection skipped: thread already claimed",
    );
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: "slack_thread_already_claimed",
      sessionId: claimedSessionId ?? undefined,
    });
  }

  const consumed = await consumeSlackRepoDisambiguation(db, parsed.disambiguationId, now);
  if (!consumed) {
    log.info({ disambiguationId: parsed.disambiguationId }, "Slack repo disambiguation lost race to consume");
    await releaseSlackThreadSessionClaim({
      db,
      businessId: threadBusinessId,
      teamId: slackTeamId,
      channelId: record.channelId,
      threadTs: record.threadTs,
      sessionId,
      reason: "repo_disambiguation_consume_lost",
    });
    return jsonResponse({ ok: true, skipped: true, reason: "disambiguation_unavailable" });
  }

  const sessionParams: SlackNewSessionParams = {
    env,
    db,
    ctx,
    businessId: threadBusinessId,
    slackTeamId,
    slackBotToken,
    event: syntheticEvent,
    hasAttachments: record.attachmentFileIds.length > 0,
    channelId: record.channelId,
    threadTs: record.threadTs,
    messageTs: record.messageTs,
    // Reuse the original thread/app-mention signal so handleSlackNewSession
    // can re-collect Slack thread and previous-message context for the
    // bootstrap prompt, matching the inferred-repo path.
    eventThreadTs: record.threadTs,
    isAppMention: true,
    actorUserId: record.actorUserId,
    actorLabel: linkedUser.login ?? `Cycloid user ${linkedUser.id}`,
    text: record.promptText,
    preclaimedSessionId: sessionId,
    parsedMessage: {
      repoUrl: `https://github.com/${selectedOwner}/${selectedRepo}`,
      repoNameHint: null,
      prompt: parsedDisambiguationPrompt.prompt ?? (record.promptText.length > 0 ? record.promptText : null),
      directivePresent: true,
      qa: parsedDisambiguationPrompt.qa,
      removedVerifyDirective: parsedDisambiguationPrompt.removedVerifyDirective,
      targetPrUrl: parsedDisambiguationPrompt.targetPrUrl,
      targetPrUrlSelection: parsedDisambiguationPrompt.targetPrUrlSelection,
    },
  };

  if (ctx) {
    ctx.waitUntil(
      runSlackSessionCreateInBackgroundSpan({
        env,
        operation: "handleSlackRepoDisambiguationSelection.newSession",
        logger: log,
        task: () => handleSlackNewSession(sessionParams),
      }),
    );
    return jsonResponse({ ok: true, accepted: true, reason: "slack_new_session_queued" });
  }

  return handleSlackNewSession(sessionParams);
}

type LinearWebhookInstallation = NonNullable<
  Awaited<ReturnType<typeof getActiveLinearWebhookInstallationByOrganization>>
>;
type LinearRepoResolutionSource = "explicit" | "default" | "inferred";

interface LinearWebhookTenantContext {
  linearOrganizationId: string;
  linearWebhookId: string;
  linearInstallation: LinearWebhookInstallation;
}

interface LinearIssueActorContext extends LinearWebhookTenantContext {
  actorUserId: string;
}

type LinearWebhookContextResult<T> =
  { status: "resolved"; context: T } | { status: "skipped"; reason: string; response: Response };

interface LinearWebhookRepoResolved {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  repoFromDescription: boolean;
  repoResolutionSource: LinearRepoResolutionSource;
  parsedDescriptionRepo: ReturnType<typeof parseRepoPromptFromText>;
  linearDefaultModel: string | null;
  promptContextPromise: Promise<LinearPromptContextResult> | null;
  promptContext: LinearPromptContextResult | null;
}

type LinearWebhookRepoResolutionResult =
  { status: "resolved"; repo: LinearWebhookRepoResolved } | { status: "skipped"; reason: string; response: Response };

interface LinearWebhookRepoAuthorization {
  installationId: number;
}

type LinearWebhookRepoAuthorizationResult =
  | { status: "authorized"; authorization: LinearWebhookRepoAuthorization }
  | { status: "skipped"; reason: string; response: Response };

interface PersistedLinearWebhookSession {
  sessionId: string;
  session: Awaited<ReturnType<typeof createSessionState>>["session"];
}

export async function resolveLinearWebhookTenantContext(
  db: D1Database,
  payload: Record<string, unknown>,
  options?: { allowUnboundWebhookBinding?: boolean },
): Promise<LinearWebhookContextResult<LinearWebhookTenantContext>> {
  const linearOrganizationId = normalizeWebhookReference(payload.organizationId);
  const linearWebhookId = normalizeWebhookReference(payload.webhookId);
  if (!linearOrganizationId || !linearWebhookId) {
    log.warn(
      { hasOrganizationId: !!linearOrganizationId, hasWebhookId: !!linearWebhookId },
      "Linear webhook rejected: missing tenant metadata",
    );
    return {
      status: "skipped",
      reason: "missing_linear_tenant_metadata",
      response: jsonResponse({ ok: true, skipped: true, reason: "missing_linear_tenant_metadata" }),
    };
  }

  const linearInstallation = await getActiveLinearWebhookInstallationByOrganization(db, linearOrganizationId);
  if (!linearInstallation) {
    log.info({ linearOrganizationId }, "Linear webhook skipped: unknown organization");
    return {
      status: "skipped",
      reason: "unknown_linear_organization",
      response: jsonResponse({ ok: true, skipped: true, reason: "unknown_linear_organization" }),
    };
  }
  if (linearInstallation.linearWebhookId && linearInstallation.linearWebhookId !== linearWebhookId) {
    log.warn({ linearOrganizationId, linearWebhookId }, "Linear webhook skipped: webhook ID mismatch");
    return {
      status: "skipped",
      reason: "linear_webhook_mismatch",
      response: jsonResponse({ ok: true, skipped: true, reason: "linear_webhook_mismatch" }),
    };
  }
  if (!linearInstallation.linearWebhookId) {
    if (options?.allowUnboundWebhookBinding === false) {
      log.warn(
        { linearOrganizationId, linearWebhookId },
        "Linear webhook skipped: unbound installation cannot be claimed by stale revoke",
      );
      return {
        status: "skipped",
        reason: "linear_webhook_unbound_for_revoke",
        response: jsonResponse({ ok: true, skipped: true, reason: "linear_webhook_unbound_for_revoke" }),
      };
    }
    await bindLinearWebhookInstallationWebhookId(db, {
      businessId: linearInstallation.businessId,
      linearOrganizationId,
      linearWebhookId,
    });
  }

  return {
    status: "resolved",
    context: { linearOrganizationId, linearWebhookId, linearInstallation },
  };
}

export async function resolveLinearIssueActorContext(params: {
  db: D1Database;
  payload: Record<string, unknown>;
  tenant: LinearWebhookTenantContext;
}): Promise<LinearWebhookContextResult<LinearIssueActorContext>> {
  const { db, payload, tenant } = params;
  const actor = payload?.actor as Record<string, unknown> | undefined;
  const actorLinearId = normalizeWebhookReference(actor?.id);
  const actorType = normalizeWebhookReference(actor?.type);

  if (actorType && actorType.toLowerCase() !== "user") {
    await emitLifecycleEvent({
      db,
      integrationId: "linear",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      businessId: tenant.linearInstallation.businessId,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
      message: "Linear webhook actor was not a user.",
      details: {
        provider: "linear",
        workspaceId: tenant.linearOrganizationId,
        actor: actorLinearId,
      },
    });
    log.info({ actorType }, "Skipping: non-user actor");
    return {
      status: "skipped",
      reason: "non_user_actor",
      response: jsonResponse({ ok: true, skipped: true, reason: "non_user_actor" }),
    };
  }

  if (!actorLinearId) {
    await emitLifecycleEvent({
      db,
      integrationId: "linear",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      businessId: tenant.linearInstallation.businessId,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
      message: "Linear webhook payload did not include an actor ID.",
      details: {
        provider: "linear",
        workspaceId: tenant.linearOrganizationId,
      },
    });
    log.info({}, "Skipping: no actor ID in webhook payload");
    return {
      status: "skipped",
      reason: "linear_user_not_connected",
      response: jsonResponse({ ok: true, skipped: true, reason: "linear_user_not_connected" }),
    };
  }

  const resolvedUser = await getUserByLinearId(db, actorLinearId);
  if (!resolvedUser) {
    await emitLifecycleEvent({
      db,
      integrationId: "linear",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      businessId: tenant.linearInstallation.businessId,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
      message: "Linear webhook actor is not connected to a Cycloid user.",
      details: {
        provider: "linear",
        workspaceId: tenant.linearOrganizationId,
        actor: actorLinearId,
      },
    });
    log.info({ actorLinearId }, "Linear user not connected to Cycloid");
    return {
      status: "skipped",
      reason: "linear_user_not_connected",
      response: jsonResponse({ ok: true, skipped: true, reason: "linear_user_not_connected" }),
    };
  }

  if (!(await isIntegrationAvailable(db, resolvedUser.id, "linear"))) {
    log.info({ userId: resolvedUser.id }, "Linear integration disabled for user's business");
    return {
      status: "skipped",
      reason: "integration_disabled",
      response: jsonResponse({ ok: true, skipped: true, reason: "integration_disabled" }),
    };
  }

  const actorBusinessId = await getUserBusinessIdOrNull(db, resolvedUser.id);
  if (actorBusinessId !== tenant.linearInstallation.businessId) {
    await emitLifecycleEvent({
      db,
      integrationId: "linear",
      stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      businessId: tenant.linearInstallation.businessId,
      userId: resolvedUser.id,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.ACTOR_RESOLUTION_FAILED,
      message: "Linear webhook actor belongs to a different Cycloid business.",
      details: {
        provider: "linear",
        workspaceId: tenant.linearOrganizationId,
        actor: actorLinearId,
      },
    });
    log.warn(
      { userId: resolvedUser.id, linearOrganizationId: tenant.linearOrganizationId },
      "Linear webhook skipped: actor outside mapped business",
    );
    return {
      status: "skipped",
      reason: "linear_actor_business_mismatch",
      response: jsonResponse({ ok: true, skipped: true, reason: "linear_actor_business_mismatch" }),
    };
  }

  return {
    status: "resolved",
    context: {
      ...tenant,
      actorUserId: String(resolvedUser.id),
    },
  };
}

export async function resolveLinearWebhookRepo(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  actorUserId: string;
  issue: Record<string, unknown>;
  labels: string[];
  triggerLabel: string;
  linearIssueId: string;
}): Promise<LinearWebhookRepoResolutionResult> {
  const { env, db, ctx, actorUserId, issue, labels, triggerLabel, linearIssueId } = params;
  const resolvedSettings = await resolveUserSettings(db, actorUserId);
  const userRepoUrl = resolvedSettings?.default_repo ?? null;
  const linearDefaultModel =
    extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(resolvedSettings?.default_model)) ?? null;

  const parsedDescriptionRepo = parseRepoPromptFromText(issue.description);
  const defaultRepoUrl = userRepoUrl || normalizeWebhookReference(env.LINEAR_DEFAULT_REPO_URL);
  let promptContextPromise: Promise<LinearPromptContextResult> | null = null;
  let promptContext: LinearPromptContextResult | null = null;
  const selectionResult = await respondToWebhookRepoSelection({
    policy: {
      sourceLabel: "Linear",
      actorUserId,
      explicitRepoUrl: parsedDescriptionRepo.repoUrl,
      defaultRepoUrl,
      fallBackFromInvalidExplicitRepoUrl: true,
      inferRepo: async () => {
        promptContextPromise = resolveLinearPromptContext(db, actorUserId, env, linearIssueId, "repo-inference");
        const promptIssueForInference = parsedDescriptionRepo.directivePresent
          ? { ...issue, description: parsedDescriptionRepo.prompt ?? "" }
          : issue;
        const linearRepoGuessContext = resolveLinearPromptContextBeforeDeadline(
          promptContextPromise,
          linearIssueId,
          "repo-inference",
        ).then((linearInferencePromptContext) => {
          promptContext = linearInferencePromptContext;
          return buildLinearRepoGuessContext({
            issue: promptIssueForInference,
            labels,
            comments: linearInferencePromptContext.comments,
            hasDefaultRepo: false,
            excludedLabelHints: [triggerLabel],
          });
        });
        const inference = await inferRepoFromTextContext({
          env,
          actorUserId,
          context: linearRepoGuessContext,
          mode: "linear",
          sourceLabel: "Linear",
          matchedLogMessage: "Linear repo inferred from issue context",
          unavailableLogMessage: "Linear repo inference skipped: accessible repo list unavailable",
          unknownLogMessage: "Linear repo inference returned unknown",
          ctx,
        });

        if (inference.status === "matched") {
          return {
            status: "matched",
            repoUrl: inference.repoUrl,
            repoOwner: inference.repoOwner,
            repoName: inference.repoName,
          };
        }

        return {
          status: "skipped",
          reason: inference.status === "unavailable" ? "repo_inference_unavailable" : "repo_inference_unknown",
          llmFailure: inference.llmFailure,
          candidates: inference.candidates,
        };
      },
    },
    onRepoInferenceUnavailable: (selection) => {
      if (promptContextPromise) {
        postLinearRepoClarificationWhenTokenReady(promptContextPromise, linearIssueId, selection.llmFailure, ctx);
      }
      return {
        releaseReason: "repo_inference_unavailable",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_inference_unavailable" }),
      };
    },
    onRepoInferenceUnknown: (selection) => {
      if (promptContextPromise) {
        postLinearRepoClarificationWhenTokenReady(promptContextPromise, linearIssueId, selection.llmFailure, ctx);
      }
      return {
        releaseReason: "repo_inference_unknown",
        response: jsonResponse({ ok: true, skipped: true, reason: "repo_inference_unknown" }),
      };
    },
  });

  if (selectionResult.status === "skipped") {
    return {
      status: "skipped",
      reason: selectionResult.releaseReason,
      response: selectionResult.response,
    };
  }

  const repoUrl = selectionResult.selection.repoUrl;
  let repoOwner = selectionResult.selection.repoOwner;
  let repoName = selectionResult.selection.repoName;
  const repoFromDescription = selectionResult.selection.source === "explicit";
  const repoResolutionSource: LinearRepoResolutionSource = selectionResult.selection.source;

  if (!repoOwner || !repoName) {
    try {
      ({ owner: repoOwner, repo: repoName } = parseRepoUrl(repoUrl));
    } catch {
      log.warn({ repoUrl }, "Linear session rejected: invalid repo URL");
      return {
        status: "skipped",
        reason: "invalid_repo_url",
        response: jsonResponse({ ok: true, skipped: true, reason: "invalid_repo_url" }),
      };
    }
  }

  return {
    status: "resolved",
    repo: {
      repoUrl,
      repoOwner,
      repoName,
      repoFromDescription,
      repoResolutionSource,
      parsedDescriptionRepo,
      linearDefaultModel,
      promptContextPromise,
      promptContext,
    },
  };
}

export async function authorizeLinearWebhookRepo(params: {
  env: Env;
  db: D1Database;
  actorUserId: string;
  repoOwner: string;
  repoName: string;
  repoFromDescription: boolean;
}): Promise<LinearWebhookRepoAuthorizationResult> {
  const { env, db, actorUserId, repoOwner, repoName, repoFromDescription } = params;
  const authorizationResult = await respondToWebhookRepoAuthorization({
    policy: {
      sourceLabel: "Linear",
      env,
      db,
      actorUserId,
      repoUrl: `https://github.com/${repoOwner}/${repoName}`,
      repoOwner,
      repoName,
      verifyRepoAccess: true,
    },
    onInvalidRepoUrl: () => ({
      releaseReason: "invalid_repo_url",
      response: jsonResponse({ ok: true, skipped: true, reason: "invalid_repo_url" }),
    }),
    onNoInstallation: () => ({
      releaseReason: "no_installation",
      response: jsonResponse({
        ok: true,
        skipped: true,
        reason: "no_installation",
        ...(repoFromDescription
          ? { error: `No GitHub App installation is configured for ${repoOwner}/${repoName}` }
          : {}),
      }),
    }),
    onRepoAccessVerificationFailed: () => ({
      releaseReason: "repo_access_verification_failed",
      response: jsonResponse({
        ok: true,
        skipped: true,
        reason: "repo_access_verification_failed",
        ...(repoFromDescription
          ? {
              error: `Unable to verify access to ${repoOwner}/${repoName} from the Linear issue description. Please try again.`,
            }
          : {}),
      }),
    }),
    onRepoNotAuthorized: () => ({
      releaseReason: "repo_not_authorized",
      response: jsonResponse({
        ok: true,
        skipped: true,
        reason: "repo_not_authorized",
        ...(repoFromDescription
          ? { error: `You do not have access to ${repoOwner}/${repoName} from the Linear issue description.` }
          : {}),
      }),
    }),
  });

  if (authorizationResult.status === "authorized") {
    return {
      status: "authorized",
      authorization: { installationId: authorizationResult.authorization.installation.installation_id },
    };
  }

  return {
    status: "skipped",
    reason: authorizationResult.releaseReason,
    response: authorizationResult.response,
  };
}

export async function createAndPersistLinearWebhookSession(params: {
  env: Env;
  db: D1Database;
  sessionId: string;
  actorUserId: string;
  linearIssueId: string;
  issue: Record<string, unknown>;
  repoOwner: string;
  repoName: string;
  installationId: number;
  model: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<PersistedLinearWebhookSession> {
  const { env, db, sessionId, actorUserId, linearIssueId, issue, repoOwner, repoName, installationId, model } = params;
  const issueIdentifier = normalizeWebhookReference(issue?.identifier);
  const issueUrl = normalizeWebhookReference(issue?.url);
  const linearContext = issueIdentifier && issueUrl ? { identifier: issueIdentifier, url: issueUrl } : undefined;
  const baseModel = resolveBaseModelForAutomaticRouting(model);

  const { session, replay } = await createSessionState(env, sessionId, actorUserId, {
    entrypoint: SessionEntrypoint.LINEAR,
    repoContext: { repoOwner, repoName },
    installationId,
    model: baseModel.currentModel,
    agentRuntimeBackend: baseModel.agentRuntimeBackend,
    linearContext,
    waitUntil: params.waitUntil,
  });

  await syncSessionProjection({
    db,
    sessionId,
    session,
    replay,
    logger: log,
    source: "webhooks.linear.create",
    userId: actorUserId,
  });
  await upsertSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_LINEAR_ISSUE, linearIssueId, session.sessionId);

  return { sessionId: session.sessionId, session };
}

/**
 * Resolve Linear prompt context (issue comments, with a soft deadline) and
 * build the bootstrap prompt. Called by the webhook handler BEFORE claiming the
 * durable bootstrap job so the built prompt is stored and replayed verbatim on
 * resume (ARC-1051). Storing the built prompt keeps the `listSessionPrompts`
 * dedup byte-stable: a re-fetch on the sweep path could return different
 * comments and silently double-enqueue.
 */
export async function buildLinearBootstrapPrompt(params: {
  env: Env;
  db: D1Database;
  actorUserId: string;
  linearIssueId: string;
  sessionId: string;
  issue: Record<string, unknown>;
  labels: string[];
  repo: LinearWebhookRepoResolved;
}): Promise<string> {
  const { env, db, actorUserId, linearIssueId, sessionId, issue, labels, repo } = params;
  let { promptContextPromise, promptContext } = repo;
  if (!promptContextPromise) {
    promptContextPromise = resolveLinearPromptContext(db, actorUserId, env, linearIssueId, sessionId);
  }
  if (!promptContext) {
    promptContext = await resolveLinearPromptContextBeforeDeadline(promptContextPromise, linearIssueId, sessionId);
  }

  log.info(
    {
      linearIssueId,
      hasTitle: !!normalizeWebhookReference(issue.title),
      hasDescription: !!normalizeWebhookReference(issue.description),
      labelCount: labels.length,
      hasProject: !!(
        issue.project &&
        typeof issue.project === "object" &&
        normalizeWebhookReference((issue.project as Record<string, unknown>).name)
      ),
      hasAssignee: !!(
        issue.assignee &&
        typeof issue.assignee === "object" &&
        normalizeWebhookReference((issue.assignee as Record<string, unknown>).name)
      ),
      apiTokenAvailable: !!promptContext.linearToken,
      commentsFetched: promptContext.commentsFetched,
      promptContextTimedOut: promptContext.timedOut,
    },
    "Prepared Linear prompt context",
  );

  const promptIssue = repo.parsedDescriptionRepo.directivePresent
    ? { ...issue, description: repo.parsedDescriptionRepo.prompt ?? "" }
    : issue;
  return buildLinearIssuePrompt({
    issue: promptIssue,
    labels,
    defaultRepoUrl: repo.repoUrl,
    comments: promptContext.comments,
  });
}

// Minimum age before a Linear issue session ref may be displaced by a newer
// webhook. Protects an in-flight bootstrap (claimed ref, prompt not yet
// enqueued) from being stolen by a concurrent delivery in the same burst.
export const LINEAR_SESSION_REF_DISPLACE_MIN_AGE_MS = 2 * 60 * 1000;

// "archived" is the single canonical terminal status since migration
// 0057_unify_session_status; no code path writes "closed" or "failed".
const LINEAR_DEAD_SESSION_STATUSES = new Set(["archived"]);

/**
 * True when a Linear issue session ref points at a provably dead session and
 * is old enough that it cannot belong to an in-flight bootstrap. Fails closed:
 * a missing/unparseable timestamp or a liveness lookup error keeps the ref
 * authoritative. Absence of prompt activity is deliberately NOT used as
 * evidence — prompt_runs rows are only written at prompt execution, so a
 * healthy just-started session has none.
 */
export async function isDisplaceableLinearSessionRef(
  db: D1Database,
  ref: LinearIssueSessionRef,
  now = Date.now(),
): Promise<boolean> {
  const updatedAtMs = ref.updatedAt ? Date.parse(ref.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return false;
  if (now - updatedAtMs < LINEAR_SESSION_REF_DISPLACE_MIN_AGE_MS) return false;

  try {
    const rows = await getSessionLivenessRows(db, [ref.sessionId]);
    const row = rows[0];
    if (!row) return true;
    return LINEAR_DEAD_SESSION_STATUSES.has(row.status);
  } catch (err) {
    log.warn(
      { sessionId: ref.sessionId, error: String(err) },
      "Linear session ref liveness lookup failed; keeping ref",
    );
    return false;
  }
}

/**
 * Removes a stale Linear issue session ref (already judged displaceable) and
 * best-effort closes the dead session it pointed at. Returns true when this
 * caller won the ref deletion; false means a concurrent delivery already
 * displaced it.
 */
export async function displaceStaleLinearSessionRef(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  linearIssueId: string;
  ref: LinearIssueSessionRef;
}): Promise<boolean> {
  const { env, db, ctx, linearIssueId, ref } = params;
  const released = await deleteLinearIssueSessionRefIfSession(db, linearIssueId, ref.sessionId);
  if (!released) return false;

  // Clear the durable bootstrap job too, scoped to BOTH keys so a concurrent
  // re-claim's newer job (different session_id) is never wiped (ARC-1051, B8).
  await deleteLinearBootstrapJob(db, linearIssueId, ref.sessionId);

  log.warn(
    { linearIssueId, displacedSessionId: ref.sessionId },
    "Displaced stale Linear issue session ref pointing at a dead session",
  );
  recordLinearWebhookDrop({
    env,
    db,
    ctx,
    fields: {
      reason: "stale_session_ref_displaced",
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      linearIssueId,
      sessionId: ref.sessionId,
    },
  });
  await runWithSentryTag(
    "handleLinearWebhook.displacedSessionClose",
    async () => {
      await closeSessionForWebhook(env, db, ref.sessionId, { reason: "linear_stale_ref_displaced" });
    },
    log,
    {
      message: "Failed to close displaced Linear zombie session",
      logFields: { linearIssueId, sessionId: ref.sessionId },
    },
  );
  return true;
}

export async function handleSandboxCallback(
  request: Request,
  env: Env,
  sessionId: string,
  promptId: string,
): Promise<Response> {
  const callbackPayload = (await parseJsonBody(request)) || {};
  const requestId = request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID);
  const callbackResult = await completeSessionPrompt(env, sessionId, promptId, callbackPayload, requestId);

  if (callbackResult.status === 404) {
    return jsonErrorResponse("Session or prompt not found", 404);
  }
  if (callbackResult.status === 409) {
    return jsonErrorResponse("Prompt callback rejected", 409);
  }
  if (!callbackResult.ok) {
    const err = new Error(`Session DO callback failed with status ${callbackResult.status}`);
    await runWithSentryTag("handleSandboxCallback", () => Promise.reject(err), log);
    throw err;
  }

  const cp = callbackResult.payload!;
  const db = env.DB;
  await syncSessionProjection({
    db,
    sessionId,
    session: cp.session,
    replay: cp.replay,
    logger: log,
    source: "webhooks.callback",
  });

  return jsonResponse({
    ok: true,
    sessionId,
    promptId,
    completedPrompt: cp.completedPrompt,
    nextDispatch: cp.nextDispatch,
    queue: cp.queue,
  });
}

// --- GitHub webhook payload extractors ---
// Shared by github.ts and the PR-activity capture builder (pr-activity-capture.ts).
// Kept here (not in github.ts) so the capture module can import them without a
// circular dependency: github.ts imports the capture module for its webhook tap,
// so the capture module must not import back from github.ts.

/** Coerce a value to a plain object, or undefined for non-objects / arrays / null. */
export function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export interface CommonGithubWebhookActor {
  senderId: number | null;
  senderLogin: string | null;
  senderType: string;
}

export interface GithubWebhookUserActor {
  userId: number | null;
  userLogin: string | null;
  userType: string;
}

/** Extract a GitHub `user`-shaped object's id / login / type. */
export function extractGithubUserActor(user: Record<string, unknown> | undefined): GithubWebhookUserActor {
  return {
    userId: typeof user?.id === "number" ? user.id : null,
    userLogin: normalizeWebhookReference(user?.login),
    userType: typeof user?.type === "string" ? user.type : "",
  };
}

/** Extract the webhook `sender` (the actor that triggered the delivery — the action actor). */
export function extractCommonWebhookActor(payload: Record<string, unknown>): CommonGithubWebhookActor {
  const sender = recordField(payload.sender);
  const { userId, userLogin, userType } = extractGithubUserActor(sender);
  return {
    senderId: userId,
    senderLogin: userLogin,
    senderType: userType,
  };
}

export interface GithubWebhookRepoAndInstallation {
  repoOwner: string | null;
  repoName: string | null;
  repoPrivate?: boolean;
  repositoryUrl: string | null;
  installationId: number | null;
}

export function extractRepoAndInstallation(
  payload: Record<string, unknown>,
  repository = recordField(payload.repository),
): GithubWebhookRepoAndInstallation {
  const repoOwner = normalizeWebhookReference(recordField(repository?.owner)?.login);
  const repoName = normalizeWebhookReference(repository?.name);
  return {
    repoOwner,
    repoName,
    repoPrivate: typeof repository?.private === "boolean" ? repository.private : undefined,
    repositoryUrl:
      normalizeWebhookReference(repository?.html_url) ??
      (repoOwner && repoName ? `https://github.com/${repoOwner}/${repoName}` : null),
    installationId: extractGithubInstallationId(payload),
  };
}

function extractGithubInstallationId(payload: Record<string, unknown>): number | null {
  const rawInstallationId = recordField(payload.installation)?.id;
  return typeof rawInstallationId === "number" ? rawInstallationId : null;
}
