import type { CliTokenScope } from "../types";

export const CLI_TOKEN_SCOPES: CliTokenScope[] = ["read", "write"];
export const MAX_CLI_TOKEN_EXPIRY_DAYS = 365;
export const MAX_ACTIVE_CLI_TOKENS = 25;

// `last_used_at` is purely informational (token-list UI / staleness display); no
// auth decision depends on it. Throttling the write to once per token per this
// window collapses a per-request D1 write on the auth hot path into a rare one,
// removing the bulk of `cli_tokens` single-writer contention.
export const CLI_TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export const CLI_TOKEN_ROUTE_ALLOWLIST: Record<
  CliTokenScope,
  ReadonlyArray<readonly [method: string, pattern: string]>
> = {
  read: [
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/:sessionId"],
    ["GET", "/api/sessions/:sessionId/prompts"],
    ["GET", "/api/sessions/:sessionId/events"],
    ["GET", "/api/sessions/:sessionId/events/history"],
    ["GET", "/api/sessions/:sessionId/usage"],
    ["GET", "/api/sessions/:sessionId/input-composition"],
    ["GET", "/api/sessions/:sessionId/export"],
    ["GET", "/api/sessions/:sessionId/debug-summary"],
    ["GET", "/api/sessions/:sessionId/child-sessions"],
    ["GET", "/api/sessions/:sessionId/child-sessions/:childSessionId/status"],
    ["GET", "/api/auth/whoami"],
    ["GET", "/api/repos"],
    ["GET", "/api/repos/:owner/:repo/branches"],
    ["GET", "/api/repos/:owner/:repo/skills"],
    ["GET", "/api/models"],
    ["GET", "/api/cli-tokens"],
    ["POST", "/api/cli-tokens"],
    ["POST", "/api/cli-tokens/:id/revoke"],
    // `cycloid codex status`: read the workspace eligibility + saved-credential state.
    ["GET", "/api/settings/codex-subscription"],
    ["GET", "/api/automation/schedules"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests/:buildId"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests/:buildId/logs"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/assignments"],
    ["GET", "/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/resolution"],
    ["GET", "/api/businesses/:businessId/egress-allowlist/source"],
  ],
  write: [
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/:sessionId"],
    ["GET", "/api/sessions/:sessionId/prompts"],
    ["GET", "/api/sessions/:sessionId/events"],
    ["GET", "/api/sessions/:sessionId/events/history"],
    ["GET", "/api/sessions/:sessionId/usage"],
    ["GET", "/api/sessions/:sessionId/input-composition"],
    ["GET", "/api/sessions/:sessionId/export"],
    ["GET", "/api/sessions/:sessionId/debug-summary"],
    ["GET", "/api/sessions/:sessionId/child-sessions"],
    ["GET", "/api/sessions/:sessionId/child-sessions/:childSessionId/status"],
    ["GET", "/api/auth/whoami"],
    ["GET", "/api/repos"],
    ["GET", "/api/repos/:owner/:repo/branches"],
    ["GET", "/api/repos/:owner/:repo/skills"],
    ["GET", "/api/models"],
    ["GET", "/api/cli-tokens"],
    ["POST", "/api/cli-tokens"],
    ["POST", "/api/cli-tokens/:id/revoke"],
    // `cycloid codex login` / `status` / `logout` / `use`: manage the per-user Codex
    // subscription auth.json and selector. The control plane still enforces workspace
    // eligibility and validates the credential; the token only carries the user.
    ["GET", "/api/settings/codex-subscription"],
    ["PUT", "/api/settings/codex-subscription/auth-json"],
    ["DELETE", "/api/settings/codex-subscription/auth-json"],
    ["PUT", "/api/settings/codex-subscription/enabled"],
    ["POST", "/api/sessions"],
    ["POST", "/api/sessions/:sessionId/prompts"],
    ["POST", "/api/sessions/:sessionId/send"],
    ["POST", "/api/sessions/:sessionId/respond"],
    ["POST", "/api/sessions/:sessionId/stop"],
    ["POST", "/api/sessions/:sessionId/child-sessions"],
    ["DELETE", "/api/sessions/:sessionId"],
    ["GET", "/api/automation/schedules"],
    ["POST", "/api/automation/schedules"],
    ["DELETE", "/api/automation/schedules/:id"],
    ["POST", "/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/build-requests"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests/:buildId"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/build-requests/:buildId/logs"],
    ["GET", "/api/businesses/:businessId/sandbox-layer/assignments"],
    ["PUT", "/api/businesses/:businessId/sandbox-layer/default-source"],
    ["DELETE", "/api/businesses/:businessId/sandbox-layer/default-source"],
    ["GET", "/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/resolution"],
    ["PUT", "/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/assignment"],
    ["DELETE", "/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/assignment"],
    ["POST", "/api/admin/sandbox-layer/rebuild-campaigns"],
    ["GET", "/api/admin/sandbox-layer/rebuild-campaigns/:id"],
    // Test credentials are write-only from the API's perspective: PUT/DELETE
    // mutate, GET returns names + metadata and never values (docs/cli.md
    // documents `cycloid test-creds set`; before this entry the router 403'd
    // every CLI token while the docs promised it worked).
    ["GET", "/api/businesses/:businessId/repos/:owner/:repo/test-credentials"],
    ["PUT", "/api/businesses/:businessId/repos/:owner/:repo/test-credentials/:credName"],
    ["DELETE", "/api/businesses/:businessId/repos/:owner/:repo/test-credentials/:credName"],
    ["PUT", "/api/businesses/:businessId/egress-allowlist/source"],
    ["POST", "/api/businesses/:businessId/egress-allowlist/pull-request"],
    ["POST", "/api/businesses/:businessId/egress-allowlist/sync"],
  ],
};
