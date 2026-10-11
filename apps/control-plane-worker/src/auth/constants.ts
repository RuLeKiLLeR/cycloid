export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const JIRA_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const JIRA_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const JIRA_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
export const JIRA_ME_URL = "https://api.atlassian.com/me";
export const JIRA_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// User flow scopes. The business-binding flow adds webhook management scopes
// (classic manage:jira-webhook) for dynamic webhook register/refresh/delete.
export const JIRA_OAUTH_USER_SCOPE = "read:jira-work write:jira-work read:jira-user read:me offline_access";
export const JIRA_OAUTH_BUSINESS_SCOPE = `${JIRA_OAUTH_USER_SCOPE} manage:jira-webhook`;
export const JIRA_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const NOTION_OAUTH_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
export const NOTION_REVOKE_TOKEN_URL = "https://api.notion.com/v1/oauth/revoke";
export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Max-age for the short-lived OAuth/CSRF state cookie set during authorize redirects.
export const OAUTH_STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export function expiresInToTimestamp(expiresIn: unknown, now = Date.now()): number | null {
  return typeof expiresIn === "number" ? now + expiresIn * 1000 : null;
}
