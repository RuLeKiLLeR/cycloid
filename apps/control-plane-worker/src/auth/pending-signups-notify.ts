import { escapeSlackMrkdwnText } from "../slack/blocks";
import { postInternalAlert } from "../slack/internal-alerts";
import { PENDING_SIGNUP_NOTIFY_CHANNEL_ID } from "../slack/internal-channels";
import type { Env } from "../types";

interface NotifyInput {
  githubLogin: string;
  githubId: number;
  name: string | null;
  email: string | null;
  frontendUrl: string;
}

/**
 * Best-effort Slack post to the configured internal #cycloid-signups channel
 * when a new self-serve signup lands in pending_signups. Informational only -
 * approval happens in the admin UI (`/admin/pending-signups`), not from Slack.
 * Failures are logged but never raised so the OAuth callback always succeeds
 * for the user.
 */
export async function notifyCycloidAdminOfPendingSignup(env: Env, input: NotifyInput): Promise<void> {
  // `name`/`githubLogin`/`email` are GitHub-controlled and interpolated into
  // Slack mrkdwn. Posting to a shared channel widens the blast radius of
  // mention/link injection (`<!channel>`, `<@U123>`), so escape every external
  // field before interpolation.
  const githubLogin = escapeSlackMrkdwnText(input.githubLogin);
  const name = input.name ? escapeSlackMrkdwnText(input.name) : null;
  const email = input.email ? escapeSlackMrkdwnText(input.email) : null;

  const text = [
    `New Cycloid signup pending approval: *${githubLogin}* (GitHub ID ${input.githubId})`,
    name ? `Name: ${name}` : null,
    email ? `Email: ${email}` : null,
    `Approve: ${input.frontendUrl}/admin/pending-signups`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  // postInternalAlert no-ops when SLACK_BOT_TOKEN is unconfigured (e.g. QA),
  // never throws, and handles the metadata-only failure logging (the message
  // carries PII). Text-only: no `blocks` argument.
  await postInternalAlert(env, PENDING_SIGNUP_NOTIFY_CHANNEL_ID, text);
}
