# Security

Repo-wide must-follow security rules live in [docs/conventions.md](conventions.md). Open this doc for auth, secrets, webhooks, environment validation, logging, or deploy-time security checks.

## Auth modes

| Mode                    | Used for                                         | Notes                                                                                                                      |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Cookie session          | Browser UI routes                                | `httpOnly`, `Secure`, `sameSite=lax`; checked server-side                                                                  |
| Impersonation cookie    | Internal operator read-only browser sessions     | `impersonation_token` cookie; takes precedence over session cookie; read-only (mutations blocked at router); 30-minute TTL |
| CLI / user bearer token | Human debugging and CLI access                   | Prefer scoped per-user tokens over admin tokens                                                                            |
| Admin bearer token      | Automation or trusted service access             | Do not use for routine human inspection                                                                                    |
| Webhook signature       | GitHub, Slack, Linear, PagerDuty webhook ingress | Verifies sender authenticity from the raw request body                                                                     |

Expired sessions must be enforced server-side. Authorization decisions do not belong in the client; hiding UI affordances is not access control.

## Webhook verification

- GitHub: HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`
- Safe GitHub PR close, reopen, and title mutations execute in the control plane through a session-bound capability. The sandbox receives no GitHub write token; its `gh` wrapper forwards only the bounded argument vector and the control plane uses the authorized installation credential.
- Slack: HMAC-SHA256 with `SLACK_SIGNING_SECRET` plus timestamp replay protection
- Linear: HMAC-SHA256 with `LINEAR_WEBHOOK_SECRET`
- PagerDuty: HMAC-SHA256 with per-installation webhook signing secret
- Cap request body size before signature verification to reject oversized payloads early. Default: 1 MiB; GitHub: 25 MiB.
- Read the raw body before parsing so the HMAC input matches the sender's payload.

## OAuth state and PKCE

- On OAuth callbacks, require the signed state to match, re-resolve the browser session, require the callback user to equal the initiating user, and re-check membership before exchanging or storing tokens.
- Never trust query-string business IDs or unsigned browser state for credential binding.
- Do not log OAuth access tokens, refresh tokens, authorization codes, or PKCE verifiers. Log only stable metadata such as `action`, `businessId`, `userId`, `requestId`, and provider status.

## Secrets and environment variables

- Secrets stay server-side and should be sourced from Terraform-managed SSM or Cloudflare Worker secrets.
- Public static worker config can live in Wrangler `[vars]`; do not duplicate the same value in SSM and Wrangler.
- Most SSM secret values use `value = "CHANGE_ME"` plus `ignore_changes = [value]` in `infra/ssm.tf`, so rotate the live value out-of-band and then redeploy or sync dependent Worker secrets.
- Turnstile SSM values are the exception: they are sourced from the Terraform-managed Cloudflare Turnstile widget.
- Validate required environment variables before the service starts handling traffic.
- Treat `ARCANIST_ADMIN_TOKEN` and `ARCANIST_ADMIN_GITHUB_IDS` as root-tier control-plane credentials. Keep the GitHub ID list minimal and review changes to it like any other privileged access grant.
- Internal Slack alert channel IDs (pending-signup, session-feedback, memory-feedback, memory-pr, customer-session-tracking, session-monitoring) are non-secret routing config, not credentials, so they are hardcoded in `apps/control-plane-worker/src/slack/internal-channels.ts` rather than stored in SSM. Each must be a channel **ID** (not a name) for a channel that is private, Cycloid-internal, not Slack Connect / shared, and in the correct workspace; pending-signup in particular receives PII (name + email). `postInternalAlert` cannot validate this before posting, so correctness is verified at code-review time. Delivery gates on `SLACK_BOT_TOKEN`, which is env-scoped.
- The sandbox GitHub token is repo-scoped: clone mints a single-repo `contents:write` + PR/CI read installation token (`sandboxInstallationTokenScope`), push may briefly add `workflows:write` only for workflow-file pushes, and `gh` mints a single-repo read-only installation token (`sandboxGhReadonlyTokenScope`). CI read scopes (`checks:read`, `actions:read`) let the agent self-diagnose failing CI (check runs, Actions workflow logs) without write escalation. The user OAuth token is never shipped to the sandbox; PRs are opened server-side as the user (`github/pr.ts`). This caps a prompt-injection foothold to a single-repo credential, not installation-wide or account-wide. The `/session/github-token` and `/session/clone-token` DO routes fail closed (400) when the session has no repo to scope to. Installation-wide server flows keep `createInstallationToken`.
- Ordinary GitHub HTTPS fetches use a read-only helper configured with `!<absolute-real-gh-path> auth git-credential`; the remote remains token-free and the helper list starts with an empty entry to reset inherited helpers.
- Sandbox agent child envs use the fail-closed allowlist in `shared/constants/agent-child-env.ts`.
  Bridge-only credentials such as `SANDBOX_AUTH_TOKEN`, GitHub clone tokens, Terraform plan tokens, Datadog platform keys, Sentry DSNs, and Braintrust platform keys must stay out of agent child envs.
  The runtime `gh` shim's child-visible file pointer contains only a derived `/session/github-token` mint token, not the sandbox bearer; the shim allowlists only read commands and hook/test/repo-command envs still strip the pointer.
  Provider keys that the agent runtime needs to call the model remain agent-reachable today (`OPENAI_API_KEY`/`CODEX_API_KEY`, `ANTHROPIC_API_KEY`, and `BASETEN_API_KEY` for opencode).
  Trusted integration credential names are agent-reachable only when a higher-trust MCP path references them; that is an accepted residual until those tools move behind a credential broker or provider-key proxy.
- Sandbox path and command guards are defense-in-depth around model tool use, not an OS-level bridge/agent isolation boundary.
  The bridge and agent currently run as the same Unix user inside a single-tenant ephemeral E2B micro-VM, so same-uid filesystem and `/proc` reads are not fully denied by the kernel.
  Do not describe protected-path checks as making bridge files unreadable to a determined same-uid process.

### Validation pattern

```ts
const required = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
```

## Logging and exposure controls

- Do not log secrets, tokens, or PII.
- Keep production logs structured and attach stable identifiers such as `requestId`, `userId`, `sessionId`, or `action` where available.
- Log auth failures, token creation/revocation, and other security-sensitive state changes.
- Keep debug-only tooling disabled in production.

### Sandbox auth monitoring

Sandbox auth failures (invalid/missing/expired token) emit WARN logs with `event:sandbox_auth_failure`.
Monitor globally in Datadog with:

```text
logs("service:cycloid-control-plane status:warn @event:sandbox_auth_failure").index("*").rollup("count").last("1m") > 10
```

Lifecycle races (a correctly-authenticated sandbox requests a token after the session stopped or sandbox disconnected) emit `event:sandbox_token_mint_rejected_inactive` instead, since they are not auth failures.

## Browser and HTTP considerations

- Tighten CORS to explicit origins when a route serves authenticated browser traffic.
- `Access-Control-Allow-Credentials: true` cannot be paired with `*`.
- Health endpoints should be unauthenticated and return readiness without leaking sensitive details.
- Authenticated bootstrap capabilities are server-authoritative UI exposure flags. Use them to decide whether authenticated route modules are registered or lazy-loaded, but keep server-side route authorization unchanged as the real security boundary.
- Public OAuth and callback paths that retain provider or subsystem names are intentional integration contracts: `/auth/github`, `/auth/linear`, `/auth/notion`, `/auth/slack`, provider setup callbacks, webhooks, and sandbox callbacks must stay stable for external services or scoped callback tokens. Do not reference authenticated feature routes, internal product taxonomy, or deploy metadata from the logged-out UI shell before the browser proves an authenticated session.
- Treat the logged-out UI shell as competitor-visible. Its rendered text and public entry assets may show only the brand, generic private-access or sign-in copy, and required auth-route wiring. Do not add to it: provider labels (`GitHub`, `OAuth`), product-category wording (`coding agent`, `agent workspace`), integration names, repo/session/settings/eval route names, or deploy/version metadata.
- Use `npm run security:unauth-exposure -- --dist dist/ui --base-url <url>` before deploy promotion when checking what logged-out visitors can learn from a local preview, staging URL, or production-equivalent deployment. Use `--skip-root-headers` only for Vite-only local dev URLs, and use the strict flags documented in [docs/testing.md](testing.md#unauthenticated-exposure-checks) as the source-map, metadata, and CSP hardening work lands.

## File path boundaries

When converting absolute file paths to repo-relative paths for commands such as `git add`, compute the relative path with `path.relative(repoRoot, filePath)` and run the command with `cwd: repoRoot`.

Reject the computed path if it is empty, exactly `..`, starts with `..${path.sep}`, or is absolute. Never use string-prefix checks like `startsWith(repoRoot)` for containment; sibling paths such as `/repo-other` can pass that check.

## Bearer-token route allowlists

Bearer-token routes must pass both the handler capability check and the router allowlist for that token class. Admin-capable handlers (`canAccessAllSessions`) must set `adminTokenOnly: true` and appear in `ADMIN_TOKEN_ROUTE_ALLOWLIST`; otherwise the route is reachable by no token and fails as `Forbidden: admin token cannot access this resource`.

Update the matching allowlist in the same change:

- admin automation: `ADMIN_TOKEN_ROUTE_ALLOWLIST` in `apps/control-plane-worker/src/constants/auth-tokens.ts`
- CI automation: `CI_AUTOMATION_TOKEN_ROUTE_ALLOWLIST` in `apps/control-plane-worker/src/constants/auth-tokens.ts`
- CLI/user tokens: scope entries in `apps/control-plane-worker/src/constants/cli-tokens.ts`; CLI routes stay `canAccessAllSessions: false`

`tests/test_cloudflare/admin-token-route-allowlist.test.ts` enforces admin route declarations and allowlist membership in both directions.

## Session artifact access

Session artifacts are stored in private S3 objects and served through the control-plane artifact proxy. Artifact uploads are sandbox-authenticated. The proxy accepts two auth paths: (1) anonymous callers with a signed `artifactToken` query parameter, restricted to artifacts with `visibility: "public"` metadata; (2) cookie-authenticated session owners without a token, authorized through `user_session` mode and session ownership or shared-business repo access.

Screenshot and WebM video artifacts are the only intentionally-public types, because PR descriptions surface them as GitHub-rendered evidence. Screenshots embed inline for public repos (unless `renderMode: "link"` signals a fallback, then they render as markdown links); WebM videos are linked only. The token path serves GitHub's PR-body renderer for public-repo evidence. The cookie path serves a reviewer clicking a private-repo PR body link; `SameSite=Lax` lets the cookie ride a top-level navigation but blocks cross-origin `<img>` tags. Missing, private, expired, revoked, or incorrectly signed artifacts return `404`.

When GitHub release evidence publishing is available, the control plane may copy screenshot and WebM video artifacts into Cycloid-managed GitHub prerelease buckets and render or link them from the PR body. It must not upload logs, raw files, auth state, artifacts from another session or repo, or any unsupported media type. PR and verification-comment publication must fall back to normal Cycloid links (with `renderMode: "link"`) on GitHub permission, workflow-risk, upload, or PR-body update uncertainty.

Runtime visual auth state is not an artifact. `appRuntime.auth.command` writes Playwright storage state under `/tmp/cycloid-auth/`; those files can contain cookies or bearer-equivalent browser state. Never copy them into `/tmp/cycloid-evidence/`, PR bodies, logs, or transcript events.

Public artifact responses use a short public cache TTL so exposed URLs stop working after revocation or expiry within the documented cache window. Authenticated callers can revoke an artifact with `DELETE /api/sessions/:sessionId/artifacts/:artifactId`. Video uploads are WebM-only (`video/webm`), capped at 50 MB. Other artifact types, including raw files and logs, must not be made public through stable proxy URLs without an explicit reviewable allowlist and tests.

## Before merge / deploy

- scan for hardcoded secrets
- verify required env vars exist in the correct source of truth
- confirm auth and authorization still fail closed on lookup failures
- confirm webhook routes still verify signatures
- check that logs and error responses do not expose sensitive values

## Reference procedures

Reference-only operational procedures for incident response, rotation coordination, and backups.

### Incident response

1. Rotate the exposed secret immediately.
2. Audit logs and database state for unauthorized usage.
3. Revoke any derived credentials or sessions.
4. Add a regression test or checklist update in the same PR that fixes the root cause.

### Secret rotation

Most production SSM-backed secret names are Terraform-managed, but their live values are not.
For `aws_ssm_parameter.env` entries in `infra/ssm.tf`, `value = "CHANGE_ME"` is a placeholder and Terraform ignores `value`, `type`, and `tags`.
Rotate those values by updating the live SSM parameter out-of-band through the AWS console or `aws ssm put-parameter --overwrite`, then redeploy or run the documented secret sync for every dependent surface.
The old Worker secret remains live until the control-plane deploy flow syncs SSM to Cloudflare Worker secrets.
After the deploy or sync, verify the new value is accepted and the old value is rejected.

Turnstile SSM parameters are different: `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are populated from the Terraform-managed Cloudflare Turnstile widget in `infra/ssm.tf`.
Rotate those by rotating/recreating the widget through Terraform, letting Terraform Cloud apply, then redeploying the dependent surface so the Worker secret sync picks up the new value.

| Token / secret                                  | Coordinate with                                               |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `ARCANIST_ADMIN_TOKEN`                          | Any human or automation still using admin bearer auth         |
| `CI_AUTOMATION_TOKEN`                           | GitHub Actions workflows calling the control plane API        |
| `SANDBOX_CALLBACK_SECRET`                       | The control plane and sandbox callback flow                   |
| `E2B_API_KEY`, `SANDBOX_RUNTIME_CLEANUP_SECRET` | The control plane E2B runtime and scheduled cleanup path      |
| Provider OAuth or webhook secrets               | The external provider dashboard plus the control-plane deploy |

After rotation, monitor the relevant auth path and logs until the new value is proven live.

### Backups

- D1 recovery uses Cloudflare's backup/export mechanisms. Export before destructive migration work.
- Keep backup/recovery operations tied to the same change-management plan as the migration itself.
