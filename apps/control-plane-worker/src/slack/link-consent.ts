/**
 * Server-rendered consent screen for Slack magic-link identity binding. The
 * worker renders this (rather than a SPA route) so the whole flow stays under
 * the already-proxied `/auth/*` prefix and the CSRF token can be embedded
 * server-side. All interpolated values are untrusted (Slack display name,
 * workspace name, Cycloid login) and must be HTML-escaped.
 */

import { escapeHtml } from "../../../../shared/utils/html.js";

export { escapeHtml };

interface SlackLinkConsentArgs {
  /** The signed magic-link token, echoed back on confirm. */
  token: string;
  /** Double-submit CSRF token; must match the `slack_link_csrf` cookie. */
  csrfToken: string;
  /** POST target for the confirm form. */
  confirmPath: string;
  cycloidLogin: string | null;
  slackDisplayName: string | null;
  slackUserId: string;
  workspaceName: string | null;
}

export function renderSlackLinkConsentHtml(args: SlackLinkConsentArgs): string {
  const slackLabel = args.slackDisplayName ? `${args.slackDisplayName} (${args.slackUserId})` : args.slackUserId;
  const workspace = args.workspaceName ?? "your Slack workspace";
  const account = args.cycloidLogin ?? "your Cycloid account";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Link your Slack account</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #e6e8eb; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  .card { background: #181b22; border: 1px solid #262a33; border-radius: 12px; padding: 32px; max-width: 420px; width: 100%; box-sizing: border-box; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  p { font-size: 14px; line-height: 1.5; color: #b6bcc6; }
  .row { font-size: 14px; margin: 6px 0; }
  .row strong { color: #e6e8eb; }
  button { width: 100%; margin-top: 20px; padding: 10px 16px; font-size: 14px; font-weight: 600; color: #fff; background: #4338ca; border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { background: #4f46e5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Link your Slack account to Cycloid</h1>
    <p>Confirm that this Slack user is you. After linking, mentioning @Cycloid will start sessions as your Cycloid account.</p>
    <div class="row">Slack user: <strong>${escapeHtml(slackLabel)}</strong></div>
    <div class="row">Workspace: <strong>${escapeHtml(workspace)}</strong></div>
    <div class="row">Cycloid account: <strong>${escapeHtml(account)}</strong></div>
    <form method="POST" action="${escapeHtml(args.confirmPath)}">
      <input type="hidden" name="token" value="${escapeHtml(args.token)}" />
      <input type="hidden" name="csrf" value="${escapeHtml(args.csrfToken)}" />
      <button type="submit">Link my account</button>
    </form>
  </div>
</body>
</html>`;
}

export function renderSlackLinkSignInHtml(frontendUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Sign in to Cycloid</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #e6e8eb; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  .card { background: #181b22; border: 1px solid #262a33; border-radius: 12px; padding: 32px; max-width: 420px; width: 100%; box-sizing: border-box; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  p { font-size: 14px; line-height: 1.5; color: #b6bcc6; }
  a { display: inline-block; margin-top: 16px; padding: 10px 16px; font-size: 14px; font-weight: 600; color: #fff; background: #4338ca; border-radius: 8px; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sign in to finish linking Slack</h1>
    <p>Sign in to Cycloid in this browser, then reopen the link from Slack to finish connecting your account.</p>
    <a href="${escapeHtml(frontendUrl)}">Open Cycloid</a>
  </div>
</body>
</html>`;
}
