import type { UserApiKeyProviderId } from "../../../../shared/constants/integration-helpers.js";
import type { OnboardingReasonCode } from "../../../../shared/constants/onboarding.js";

const SLACK_UNCONNECTED_ACCOUNT_REPLY_PREFIX = "Your Slack account isn't connected to Cycloid.";
const SLACK_INVALID_REPO_REPLY_PREFIX = "I couldn't parse that repo.";
const SLACK_NO_INSTALLATION_REPLY_PREFIX = "The Cycloid GitHub App isn't installed on";
const SLACK_REPO_ACCESS_VERIFICATION_FAILED_REPLY_PREFIX = "I couldn't verify your access to";
const SLACK_REPO_NOT_AUTHORIZED_REPLY_PREFIX = "You don't have GitHub access to";
const SLACK_REPO_CLARIFICATION_UNKNOWN_REPLY_PREFIX =
  "I couldn't confidently choose a repo from this Slack message or thread.";
const SLACK_REPO_CLARIFICATION_TRANSIENT_REPLY_PREFIX = "Repo inference is temporarily unavailable on our side.";
const SLACK_REPO_CLARIFICATION_UNAVAILABLE_REPLY_PREFIX = "Repo inference is currently unavailable.";
const SLACK_SKIPPED_ATTACHMENTS_REPLY_PREFIX = "Some attachments were not processed:";
const SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY_PREFIX =
  "I saw the attachment, but I need instructions before starting a new session.";
const SLACK_THREAD_ALREADY_ASSOCIATED_REPLY_PREFIX = "This Slack thread is already associated with a Cycloid session.";
const SLACK_LINK_DM_SENT_REPLY_PREFIX = "I just sent you a DM with a link to connect your Cycloid account.";
const SLACK_LINK_DM_ALREADY_SENT_REPLY_PREFIX = "I already sent you a DM with a link to connect your Cycloid account.";
export const SLACK_MISSING_MODEL_KEY_REPLY_PREFIX =
  "I can't start a session because there's no usable key for your default model.";

export const SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY = `${SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY_PREFIX} Reply with what you want Cycloid to do and include the attachment again.`;
export const SLACK_INVALID_REPO_REPLY = `${SLACK_INVALID_REPO_REPLY_PREFIX} Use \`repo=owner/repo\` or a full \`https://github.com/owner/repo\` URL, or update your default repo in Cycloid settings.`;

export function slackInvalidBareRepoReply(repoName: string): string {
  return `${SLACK_INVALID_REPO_REPLY_PREFIX} I couldn't find exactly one accessible GitHub repo named \`${repoName}\`. Use \`repo=owner/repo\` or a full \`https://github.com/owner/repo\` URL, or update your default repo in Cycloid settings.`;
}

export function slackUnconnectedAccountReply(settingsUrl: string): string {
  return `${SLACK_UNCONNECTED_ACCOUNT_REPLY_PREFIX} Connect it at ${settingsUrl} and try again.`;
}

/** Thread reply shown after DMing the user a magic link to connect their account. */
export function slackLinkDmSentReply(): string {
  return `${SLACK_LINK_DM_SENT_REPLY_PREFIX} Open it, confirm, then mention me again.`;
}

/**
 * Thread reply shown when a magic-link DM was already sent in the current
 * rate-limit window, so no new DM went out for this mention.
 */
export function slackLinkDmAlreadySentReply(): string {
  return `${SLACK_LINK_DM_ALREADY_SENT_REPLY_PREFIX} Open that DM, confirm, then mention me again.`;
}

/** Body of the magic-link DM. The link is single-use and short-lived. */
export function slackLinkDmText(linkUrl: string): string {
  return `Hi! To start Cycloid sessions from Slack, link your account here: ${linkUrl}\n\nThis link is single-use and expires shortly.`;
}

const PROVIDER_DISPLAY_NAMES: Record<UserApiKeyProviderId, string> = {
  openai: "OpenAI",
  baseten: "Baseten",
  anthropic: "Anthropic",
};

function providerDisplayName(provider: UserApiKeyProviderId): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

function providerKeyPhrase(providerName: string): string {
  const article = /^[aeiou]/i.test(providerName) ? "an" : "a";
  return `${article} ${providerName} key`;
}

export function slackMissingModelKeyReply(params: {
  modelLabel: string;
  provider: UserApiKeyProviderId;
  integrationsUrl: string;
  workspaceIntegrationsUrl: string;
  generalUrl: string;
  reasonCode: OnboardingReasonCode;
}): string {
  const providerName = providerDisplayName(params.provider);
  const keyPhrase = providerKeyPhrase(providerName);
  const integrationsLink = `<${params.integrationsUrl}|add or fix your ${providerName} key>`;
  const workspaceIntegrationsLink = `<${params.workspaceIntegrationsUrl}|workspace integrations>`;
  const generalLink = `<${params.generalUrl}|change your default model>`;
  let optionsLine = `Options: ${integrationsLink}, or ${generalLink}.`;
  let reasonLine: string;

  switch (params.reasonCode) {
    case "credentials_missing":
      reasonLine = `Add ${keyPhrase}, or change your default model.`;
      break;
    case "credentials_invalid":
      reasonLine = `Your ${providerName} key failed validation. Re-add it, or change your default model.`;
      break;
    case "credentials_present":
      reasonLine = `Your ${providerName} key is saved but not yet validated. Re-save it to validate, or change your default model.`;
      break;
    case "business_managed":
      reasonLine = `Your business manages the ${providerName} key. Ask an admin to add it in workspace integrations, or change your default model.`;
      optionsLine = `Options: ${workspaceIntegrationsLink}, or ${generalLink}.`;
      break;
    case "integration_disabled":
      reasonLine = `${providerName} is disabled for your business. Ask an admin to enable it in workspace integrations, or change your default model.`;
      optionsLine = `Options: ${workspaceIntegrationsLink}, or ${generalLink}.`;
      break;
    default:
      reasonLine = `Add or fix your ${providerName} key, or change your default model.`;
      break;
  }

  return `${SLACK_MISSING_MODEL_KEY_REPLY_PREFIX} Default model: ${params.modelLabel}.\n\n${reasonLine}\n\n${optionsLine}`;
}

export function slackNoInstallationReply(owner: string): string {
  return `${SLACK_NO_INSTALLATION_REPLY_PREFIX} \`${owner}\`. Install it on the repo's GitHub organization and try again.`;
}

export function slackRepoAccessVerificationFailedReply(owner: string, repo: string): string {
  return `${SLACK_REPO_ACCESS_VERIFICATION_FAILED_REPLY_PREFIX} \`${owner}/${repo}\` right now. Please try again in a moment.`;
}

export function slackRepoNotAuthorizedReply(owner: string, repo: string): string {
  return `${SLACK_REPO_NOT_AUTHORIZED_REPLY_PREFIX} \`${owner}/${repo}\`. Ask a repo admin to grant access, then try again.`;
}

export function slackRepoClarificationReply(
  kind: "unknown" | "transient" | "unavailable",
  settingsUrl: string,
): string {
  const defaultRepoLink = `<${settingsUrl}|default repo>`;
  if (kind === "unknown") {
    return `${SLACK_REPO_CLARIFICATION_UNKNOWN_REPLY_PREFIX} Add \`repo=owner/repo\` to the request, for example \`repo=myorg/myrepo fix the bug\`, or set a ${defaultRepoLink} in Cycloid settings.`;
  }
  if (kind === "transient") {
    return `${SLACK_REPO_CLARIFICATION_TRANSIENT_REPLY_PREFIX} Try again in a moment, or add \`repo=owner/repo\` to the request to skip inference. You can also set a ${defaultRepoLink} for future Slack requests.`;
  }
  return `${SLACK_REPO_CLARIFICATION_UNAVAILABLE_REPLY_PREFIX} Add \`repo=owner/repo\` to the request, or set a ${defaultRepoLink} in Cycloid settings.`;
}

export function slackSkippedAttachmentsReply(lines: readonly string[]): string {
  return `${SLACK_SKIPPED_ATTACHMENTS_REPLY_PREFIX}\n${lines.join("\n")}`;
}

/**
 * Only the "still starting" association reply survives: replies to threads
 * whose session went cold route through wake (webhooks/slack-wake.ts) instead
 * of a dead-end.
 */
export function slackThreadAlreadyAssociatedReply(): string {
  return `${SLACK_THREAD_ALREADY_ASSOCIATED_REPLY_PREFIX} That session is still starting. Please try again in a moment.`;
}

const SLACK_WAKE_RETRY_NUDGE_REPLY_PREFIX = "This session hit a failure";
const SLACK_WAKE_ARCHIVED_REPLY_PREFIX = "This session is archived.";
const SLACK_WAKE_RESUME_FAILED_REPLY_PREFIX = "I couldn't pick this session back up.";

/**
 * Wake nudge for `failed`/`blocked` sessions: those phases cannot be enqueued
 * directly (`isPromptSendDisabled`), and the retry/`user.retrigger` wake paths
 * land in later PRs, so the reply points at the card's Retry instead.
 */
export const SLACK_WAKE_RETRY_NUDGE_REPLY = `${SLACK_WAKE_RETRY_NUDGE_REPLY_PREFIX} — use Retry on the status card above, or start a fresh thread.`;

/** Archived sessions are terminal; Slack follow-ups must start fresh. */
export const SLACK_WAKE_ARCHIVED_REPLY = `${SLACK_WAKE_ARCHIVED_REPLY_PREFIX} Start a new session to continue.`;

/** Posted when a wake succeeded but the woken session still rejected the prompt. */
export const SLACK_WAKE_RESUME_FAILED_REPLY = `${SLACK_WAKE_RESUME_FAILED_REPLY_PREFIX} Please try again in a moment.`;

// These prefixes identify Cycloid-authored setup/error replies after Slack
// has rendered message content. Keep this derived from the same constants used
// by the reply builders above; the prompt filter also requires bot markers, so
// third-party bot alerts and human messages are still eligible context.
export const SLACK_OPERATIONAL_REPLY_PREFIXES = [
  SLACK_UNCONNECTED_ACCOUNT_REPLY_PREFIX,
  SLACK_INVALID_REPO_REPLY_PREFIX,
  SLACK_NO_INSTALLATION_REPLY_PREFIX,
  SLACK_REPO_ACCESS_VERIFICATION_FAILED_REPLY_PREFIX,
  SLACK_REPO_NOT_AUTHORIZED_REPLY_PREFIX,
  SLACK_REPO_CLARIFICATION_UNKNOWN_REPLY_PREFIX,
  SLACK_REPO_CLARIFICATION_TRANSIENT_REPLY_PREFIX,
  SLACK_REPO_CLARIFICATION_UNAVAILABLE_REPLY_PREFIX,
  SLACK_SKIPPED_ATTACHMENTS_REPLY_PREFIX,
  SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY_PREFIX,
  SLACK_THREAD_ALREADY_ASSOCIATED_REPLY_PREFIX,
  SLACK_LINK_DM_SENT_REPLY_PREFIX,
  SLACK_LINK_DM_ALREADY_SENT_REPLY_PREFIX,
  SLACK_MISSING_MODEL_KEY_REPLY_PREFIX,
  SLACK_WAKE_RETRY_NUDGE_REPLY_PREFIX,
  SLACK_WAKE_ARCHIVED_REPLY_PREFIX,
  SLACK_WAKE_RESUME_FAILED_REPLY_PREFIX,
];
