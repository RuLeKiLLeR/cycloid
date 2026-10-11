# Sandbox Egress Inventory

Outbound network access from repo-session sandboxes is part of the product
contract. Keep this inventory current when changing the E2B template, sandbox
startup scripts, bridge runtime config, integration runtime env, or preview
runtime behavior.

## Scope

Covers normal Cycloid repo sessions in the E2B template from
`apps/sandbox-e2b/template.ts`: sandbox startup, the bridge, agent runtime
(Codex or Claude Code), dependency setup, runtime previews, observability, and
PR publication.

The control plane always passes `network.allowPublicTraffic: false` (keeps
sandbox URLs authenticated-only) plus a domain egress allowlist into the
sandbox. `/app/start-bridge.sh` applies the root-owned firewall helper before
clone, dependency setup, or bridge startup. E2B's provider-native IP/CIDR
network controls remain available through `E2B_SANDBOX_ALLOW_INTERNET_ACCESS`,
`E2B_SANDBOX_NETWORK_ALLOW_OUT`, and `E2B_SANDBOX_NETWORK_DENY_OUT`.

## Inventory

| Category                  | Destination                                                                                                                                                                                          | Initiator                                                                                                                               | Code path                                                                                                                                               | Secrets                                                                                                                                     | Required for                                                                                                      | Restrictability                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| First-party control plane | `CONTROL_PLANE_URL` as HTTPS/WSS, normally `api.trycycloid.com` in prod and `qa.trycycloid.com` in QA                                                                                                | Sandbox bridge                                                                                                                          | `apps/sandbox-bridge/src/bridge.ts`, `apps/control-plane-worker/src/session/durable-object.ts`                                                          | `SANDBOX_AUTH_TOKEN`                                                                                                                        | Bridge WebSocket, prompt/event stream, artifact/session APIs                                                      | Must allow exact environment host; fail closed if blocked.                                                                  |
| Runtime provider          | `api.e2b.dev`                                                                                                                                                                                        | Control plane worker, not sandbox process; local Cycloid-on-Cycloid verification can run that control plane inside a parent E2B sandbox | `apps/control-plane-worker/src/sandbox/e2b-client.ts`, `apps/control-plane-worker/src/sandbox/egress-policy.ts`                                         | `E2B_API_KEY`                                                                                                                               | Create, connect, refresh, pause, terminate sandboxes                                                              | Control-plane egress in production/QA; also default sandbox egress for parent-sandbox local verification.                   |
| Source control            | `github.com`, `api.github.com`, GitHub git HTTPS endpoints                                                                                                                                           | Startup scripts, Git, `gh`, bridge PR flow, agent commands                                                                              | `apps/sandbox-e2b/start-bridge.sh`, bridge PR services                                                                                                  | `GITHUB_CLONE_TOKEN`, `GITHUB_USER_TOKEN`, `GH_TOKEN`                                                                                       | Clone/fetch repos, resolve refs, publish branches/PRs, `gh` CLI attribution                                       | Must allow GitHub HTTPS. Credential-bearing remotes are scrubbed after clone.                                               |
| Package managers          | Public and customer-configured package registries such as npm, pnpm/yarn npm registry, PyPI, Bun, Docker registries including Docker Hub layer CDNs, and repo `.npmrc`/tool config hosts             | Startup dependency setup, agent shell commands, runtime preview builds                                                                  | `npm ci` in startup, repo commands invoked by the agent                                                                                                 | Possible repo-managed registry tokens from env blobs or checked-in config                                                                   | Install dependencies, run tests/builds, build preview containers                                                  | Do not narrow in v1 unless dependency-install scope is explicitly reduced; destinations are customer-controlled.            |
| Template build only       | Debian, NodeSource, GitHub CLI apt repo, ngrok agent apt repo, GitHub releases, npm registry, Bun installer, PyPI                                                                                    | Template build process                                                                                                                  | `apps/sandbox-e2b/template.ts`                                                                                                                          | E2B build credentials only                                                                                                                  | Build the reusable sandbox image                                                                                  | Not runtime sandbox egress. Track separately for supply-chain review.                                                       |
| Runtime tunnels           | `connect.ngrok-agent.com`, `crl.ngrok-agent.com`, `api.ngrok.com`, `tunnel.ngrok.com`, and regional `tunnel.<region>.ngrok.com` relay hosts for `us`, `eu`, `ap`, `au`, `sa`, `jp`, `in`             | Agent shell commands                                                                                                                    | `apps/control-plane-worker/src/sandbox/egress-policy.ts`, `apps/sandbox-e2b/template.ts`                                                                | Repo-provided `NGROK_AUTHTOKEN` or `NGROK_AUTH_TOKEN`                                                                                       | User-requested `ngrok http` / `ngrok tcp` tunnels inside an egress-enforced sandbox                               | Exact ngrok control/API, CRL, and standard relay hosts are in the default allowlist; public tunnel domains are inbound.     |
| Model provider            | Configured model-provider endpoints, including OpenAI, Anthropic, and Baseten API endpoints today; when gateway routing is enabled, OpenAI traffic routes through `CONTROL_PLANE_URL/openai` instead | Agent runtime (Codex, Claude Code, or opencode) and optional repo tools                                                                 | Agent runtime config, user commands, `shared/llm/*` where used in sandbox tools                                                                         | Provider credentials from agent runtime or user/business integration env; for OpenAI BYOK, session tokens (`arc-gw-*`) instead of raw keys  | Agent model calls and optional model integration work                                                             | Must allow the configured provider for agent operation before outbound enforcement is enabled.                              |
| Observability             | Datadog log intake (`http-intake.logs.<dd-site>`), Datadog API (`api.<dd-site>`) for first-party dynamic tools, Sentry, Braintrust API/app URLs                                                      | Bridge                                                                                                                                  | `apps/control-plane-worker/src/observability/sandbox-env.ts`, bridge observability services, `apps/sandbox-bridge/src/services/datadog-dynamic-tool.ts` | `DD_API_KEY`, `DD_APP_KEY`; Braintrust and Sentry platform secrets are brokered through the control plane, not exported into repo sandboxes | Sandbox/bridge logs, internal debugging, and agent Datadog log lookups. The bridge no longer exports OTLP traces. | Telemetry egress must never block normal prompt execution.                                                                  |
| Terraform verification    | Terraform Cloud, Terraform Registry, and HashiCorp releases                                                                                                                                          | Bridge-owned dynamic tool                                                                                                               | `apps/control-plane-worker/src/sandbox/egress-policy.ts`, `apps/sandbox-bridge/src/services/terraform-dynamic-tool.ts`                                  | `ARCANIST_TERRAFORM_PLAN_TOKEN` in the bridge env when business Terraform Cloud credentials are configured                                  | Terraform Cloud-backed `terraform plan` for infra changes                                                         | Terraform credentials are withheld from the agent child env; live planning uses only the first-party `terraform.plan` tool. |
| Runtime preview           | Customer app dependencies, browser-loaded assets, Docker image registries, app outbound calls                                                                                                        | Agent/browser/runtime preview commands                                                                                                  | `apps/sandbox-bridge/src/utils/preview-contract.ts`, `/app/scripts/cycloid-docker-preview`, Docker tooling in template                                  | Customer repo/env credentials may be involved                                                                                               | Starting and inspecting customer runtime previews                                                                 | Treat as customer-controlled in v1; enforcement needs explicit product decision.                                            |
| Agent shell               | Any destination reachable by user-requested commands                                                                                                                                                 | Agent tool execution                                                                                                                    | Agent shell in `/workspace/repo`                                                                                                                        | Any env vars intentionally injected into sandbox                                                                                            | User-directed debugging, installs, API checks                                                                     | Broad by design today; future restrictions need user-facing diagnostics and escape hatches.                                 |

## Enforcement Design

Cycloid enforces hostname allowlisting inside the E2B sandbox at startup. The
control plane resolves the default list plus org-admin custom domains and passes
it as `ARCANIST_SANDBOX_EGRESS_ALLOWLIST`. The root-owned
`/usr/local/sbin/cycloid-enforce-egress` helper resolves those hostnames before
agent startup, allows TCP 80/443 to the resolved addresses, permits DNS, logs
the domain-to-address mapping to `/var/log/cycloid-egress.log`, and rejects
other outbound traffic. For CDN-fronted domains with Anycast and short DNS TTLs,
the helper also allows the provider's published CIDR ranges on 80/443 so traffic
is not stranded on a different edge IP than the point-in-time DNS sample. This
currently covers GitHub's published Meta API CIDRs for GitHub-hosted domains,
and Fastly's published CIDRs for PyPI (`pypi.org`, `files.pythonhosted.org`). A
root-owned `/usr/local/bin/curl` wrapper logs blocked curl request domains to
the same file before the firewall rejects them.

This is IP-level enforcement, not SNI or HTTP host enforcement. It blocks direct
traffic to non-allowlisted addresses, but a CDN-hosted blocked service can still
be reachable when it shares a resolved IP with an allowlisted service. DNS is
also allowed so configured hostnames can resolve, so DNS itself remains a
possible exfiltration path. The curl wrapper is diagnostic only; iptables is the
enforcement boundary.

Credential minimization is separate from egress enforcement.
The bridge withholds bridge-only tokens from agent child envs, but model provider keys needed by the selected runtime and intentionally referenced integration credentials can still be present in the agent environment.
Same-uid filesystem and `/proc` reads are an accepted limitation of the current single-user sandbox runtime, so egress logs should not be described as complete prevention of secret exfiltration.

E2B also exposes provider-native controls: `allowInternetAccess` and
`network.allowPublicTraffic`/`network.allowOut`/`network.denyOut`. Cycloid
always sets `network.allowPublicTraffic: false` so inbound sandbox URLs remain
authenticated-only instead of relying on provider defaults. `allowOut` and
`denyOut` accept IP addresses or CIDR blocks, not hostnames.

Every session spawns a fresh sandbox, so the configured policy always applies
before any session-specific outbound setup runs.

Sessions belonging to Cycloid's internal businesses run with unrestricted
domain egress: the control plane emits `ARCANIST_SANDBOX_EGRESS_ENFORCEMENT=0`
when `isInternalCycloidBusinessId` matches the prod or QA Cycloid business ID.
This is internal-only and enforced in code; it is not customer-configurable.
Unrestricted egress also requires `E2B_SANDBOX_ALLOW_INTERNET_ACCESS` to stay
unset or true, because provider-native outbound restrictions such as
`allowInternetAccess=false` or `denyOut` still block traffic regardless of the
in-sandbox iptables setting.

Supported environment variables:

- `E2B_SANDBOX_EGRESS_ALLOWLIST`: optional comma-separated list or JSON array of
  exact domain names appended to the default runtime allowlist.
- Business setting `businesses.egress_allowlist_json`: optional D1-backed JSON
  policy set by org admins. Exact domain names are appended for new sandboxes in
  that business. When present, this takes precedence over the legacy env setting
  below. The D1 policy can be synced from a source repo (see below).
- `E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON`: legacy optional JSON object
  keyed by business ID, with arrays of exact domain names appended for that
  business when no D1-backed business policy is set.
- Business source repo fields `egress_allowlist_source_repo_owner` and
  `egress_allowlist_source_repo_name`: optional GitHub repo for the org's
  egress allowlist source file. When configured, admins add domains by opening
  PRs against `.cycloid/egress-allowlist.txt` on the default branch, then sync
  the merged file into the runtime D1 policy via UI or CLI. API endpoints:
  `GET/PUT /api/businesses/:id/egress-allowlist/source`,
  `POST /api/businesses/:id/egress-allowlist/pull-request`,
  `POST /api/businesses/:id/egress-allowlist/sync`. CLI: `cycloid egress`.
- `E2B_SANDBOX_ALLOW_INTERNET_ACCESS`: optional boolean passed to
  `allowInternetAccess`.
- `E2B_SANDBOX_NETWORK_ALLOW_OUT`: optional comma-separated list or JSON array of
  IP addresses/CIDR blocks passed to `network.allowOut`.
- `E2B_SANDBOX_NETWORK_DENY_OUT`: optional comma-separated list or JSON array of
  IP addresses/CIDR blocks passed to `network.denyOut`.

The allowlist source of truth should be machine-readable, owned in this repo,
with generated documentation, grouping destinations by required first-party
control paths, required source-control/model-provider paths, optional
integrations, observability, and customer-controlled egress. Production and QA
control-plane hosts must be explicit environment values, not wildcards.

Policy behavior should be:

- Fail closed for the bridge WebSocket, sandbox auth, GitHub clone, repo access,
  credential resolution, and model-provider access.
- Degrade optional MCP surfaces to unavailable when their destination or
  credentials are missing.
- Keep telemetry best-effort; network telemetry failures should be logged but
  should not block prompts or PR publication.
- Report provider policy failures through existing `network_policy`
  classification in `E2BSandboxRuntimeError` where the failure is observed by
  the control plane.
- Avoid printing secrets or private customer URLs in user-facing diagnostics.

## Future Verification Script

Before merging an enforcement PR:

1. Deploy the branch to QA control plane and QA E2B sandbox template.
2. Start a fresh QA Cycloid session against a private GitHub repo.
3. Confirm clone and background dependency setup complete.
4. Ask the agent to run `gh repo view` and a simple package-manager command.
5. Exercise the configured MCP surfaces and verify any dynamic-tool or
   integration behavior expected for the session.
6. If the repo has an App Runtime Profile, start the runtime preview and load it
   in the browser.
7. Stop and resume the session, then confirm the bridge reconnects.
8. Make a small docs-only edit and publish a PR.

Expected evidence:

- Session transcript link.
- Sandbox logs show no unexpected `network_policy` errors.
- Bridge reconnect/resume succeeds.
- Optional blocked integrations surface as unavailable, not as sandbox failure.
- PR publish completes with GitHub evidence.

## Drift Guardrails

- Update this document when adding sandbox-installed tools, bundled MCP servers,
  startup dependency behavior, new injected credentials, preview runtime
  behavior, or new remote MCP endpoints.
- If enforcement is implemented, move the inventory into a checked structured
  file and generate this markdown from it.
