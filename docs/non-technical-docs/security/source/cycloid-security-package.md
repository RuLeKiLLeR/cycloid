---
title: "Cycloid Security Package"
subtitle: "Security assurance materials provided to prospects and customers conducting vendor security review."
---

**Prepared by:** TwoCycloids Corp d/b/a Cycloid
**Last updated:** 2026-05-22
**Confidentiality:** Provided under the parties' NDA or under the confidentiality terms of the Master Subscription Agreement / Order Form / equivalent.

This document is a snapshot of Cycloid's security posture as of the effective date. Material changes are communicated to active customers under the notice obligations in the security exhibit / MSA.

# Section 1. Security Boundaries & Subprocessors

This section identifies the subprocessors that may process Customer Content, the trust boundaries between them, the residency of Customer Content, and the administrative-access paths Provider personnel use to reach production systems.

## 1.1 Subprocessor boundaries

| Boundary                  | Implementation                                        | Region              | Customer Content access                                               | Trust posture                                                    |
| ------------------------- | ----------------------------------------------------- | ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Provider control plane    | Cloudflare Workers, Durable Objects, D1               | US                  | Yes — session metadata, transcript pointers                           | Provider-controlled                                              |
| Per-Session sandbox       | E2B Firecracker microVM                               | US                  | Yes — repo clone, environment variables, command output               | Provider-controlled, per-Session isolated                        |
| Persistent artifact store | Private Amazon S3                                     | US                  | Yes — transcripts, artifacts, exports                                 | Provider-controlled, accessed only behind an authenticated proxy |
| GitHub App                | Cycloid GitHub App                                    | US (GitHub-managed) | Yes — Customer-selected repos via short-lived installation tokens     | Customer controls scope; Provider holds keys                     |
| Default inference         | OpenAI enterprise account (ZDR; BAA where applicable) | US                  | Yes — prompts, code, model responses (in transit, no retention)       | Subprocessor, contractually constrained                          |
| LLM observability         | Braintrust                                            | US                  | Yes — session traces (service-operation use only)                     | Subprocessor, contractually constrained                          |
| Telemetry / logs          | Datadog (US5)                                         | US                  | Limited — operational logs only; Customer Content filtered / redacted | Subprocessor                                                     |
| Error reporting           | Sentry                                                | US                  | Limited — stack traces may incidentally capture fragments             | Subprocessor                                                     |

## 1.2 Trust boundaries

1. **End User ↔ Control plane.** End User ↔ Provider control plane over HTTPS/WSS. Auth at the control plane; the UI is not a security boundary and does not hold long-lived secrets.
2. **Control plane ↔ Sandbox.** The sandbox connects out to the control plane over authenticated WSS. Sandbox-hosted URLs are not directly internet-reachable; inbound access flows only through an authenticated control-plane proxy.
3. **Sandbox ↔ Internet.** Egress is enforced by a root-owned firewall inside the sandbox using an allowlist applied before clone, dependency setup, or agent startup. The agent and untrusted repository code cannot modify or bypass the policy. See Section 2.
4. **Control plane ↔ GitHub.** Installation tokens are short-lived, scoped per-installation, and never written to logs. The GitHub App private key is held in encrypted secret storage and never exposed to sandboxes.
5. **Control plane ↔ Model providers.** Inference egress is on the control-plane and sandbox allowlists. Default routing is Provider's OpenAI enterprise account configured for zero data retention. BYOK is available where Customer elects.
6. **Provider personnel ↔ Production.** Administrative access is named-user only, requires phishing-resistant MFA, and is audit-logged. See Section 11.

## 1.3 Administrative-access paths

| Path                                   | Who                           | What it can reach                        | Authentication                                                    | Logging                                 |
| -------------------------------------- | ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| Cloudflare dashboard / Wrangler        | Provider engineering          | Workers, DO, D1, secrets                 | SSO + phishing-resistant MFA                                      | Cloudflare audit log                    |
| AWS Console / CLI                      | Provider engineering          | S3, IAM, KMS                             | SSO + phishing-resistant MFA                                      | CloudTrail                              |
| GitHub Provider org admin              | Provider engineering          | Provider org settings, App configuration | SSO + phishing-resistant MFA + FIDO2 hardware keys (target state) | GitHub audit log                        |
| E2B admin console / API                | Provider engineering          | Sandbox lifecycle                        | Provider-issued API key + named-user SSO                          | E2B audit + Provider control-plane logs |
| Datadog / Braintrust / Sentry consoles | Provider engineering, on-call | Telemetry, traces, errors                | SSO + phishing-resistant MFA                                      | Vendor audit logs                       |
| Customer-support tooling (internal)    | Authorized Provider support   | Limited business and session views       | SSO + phishing-resistant MFA                                      | Internal audit logs                     |

All paths above are subject to the privileged-access controls described in Section 11.

## 1.4 Regions & residency

All Customer Content is processed and stored in the United States by default:

- Cloudflare Workers are globally distributed but stateless; the D1 primary is in the US.
- E2B sandboxes are provisioned in US regions.
- S3 storage is in `us-east-1` by default and configurable per environment.
- OpenAI, Braintrust, and Sentry process in the US.
- Datadog uses the US5 site.

Provider does not replicate Customer Content to non-US regions for support, logging, backup, model inference, or disaster recovery without Customer prior written approval.

# Section 2. Sandbox Egress Allowlist

## 2.1 Enforcement design

- **Default-deny.** Outbound traffic from each sandbox is denied by default. Allowed destinations are limited to the list below plus Customer-specific additions.
- **Enforcement point.** A root-owned firewall helper, `/usr/local/sbin/cycloid-enforce-egress`, runs at sandbox startup before clone, dependency installation, package download, command execution, or agent startup. The agent and untrusted repository code cannot modify or bypass this policy.
- **Mechanism.** The helper resolves each allowlisted hostname to IPs, allows TCP 80/443 to those IPs, permits DNS, and rejects all other outbound traffic. For CDN-fronted domains with Anycast and short DNS TTLs, the helper also allows the provider's published CIDR ranges on 80/443 so traffic does not strand on a different edge IP; this currently covers GitHub's Meta API CIDRs for GitHub-hosted domains and Fastly's CIDRs for PyPI (`pypi.org`, `files.pythonhosted.org`).
- **Sandbox inbound.** `network.allowPublicTraffic` is always set to `false`; sandbox-hosted URLs are reachable only through the authenticated control-plane proxy.
- **Provider-native controls.** E2B's `network.allowOut` / `network.denyOut` (IP/CIDR level) are also available and may be set per environment.
- **Logging.** Both allowed and denied egress attempts are logged to `/var/log/cycloid-egress.log` inside the sandbox with destination host, protocol, timestamp, and action. A root-owned `curl` wrapper logs blocked curl requests by domain before iptables rejects them.

## 2.2 Default allowlist

### Provider control plane

| Hostname             | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `api.trycycloid.com` | Production control plane (bridge WSS, prompt/event stream, artifact / session APIs) |
| `qa.trycycloid.com`  | QA control plane (non-prod environments only)                                       |

### Source control (GitHub)

| Hostname                                                     | Purpose                              |
| ------------------------------------------------------------ | ------------------------------------ |
| `github.com`, `api.github.com`                               | Git HTTPS, `gh` CLI, GitHub REST API |
| `codeload.github.com`                                        | Archive / tarball downloads          |
| `objects.githubusercontent.com`, `raw.githubusercontent.com` | LFS / large objects, raw fetches     |

The firewall helper additionally allows GitHub's published Meta API CIDR ranges on TCP 80/443 to handle edge IP rotation.

### Package registries

| Hostname                                     | Purpose         |
| -------------------------------------------- | --------------- |
| `registry.npmjs.org`, `registry.yarnpkg.com` | npm / Yarn      |
| `pypi.org`, `files.pythonhosted.org`         | Python packages |
| `hub.getdbt.com`                             | dbt Hub         |

### Container registries

| Hostname                                                                     | Purpose    |
| ---------------------------------------------------------------------------- | ---------- |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | Docker Hub |
| `ghcr.io`, `pkg-containers.githubusercontent.com`                            | GHCR       |

### Model providers

| Hostname            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `api.openai.com`    | Default inference (Provider OpenAI enterprise account: ZDR) |
| `api.anthropic.com` | Alternate model provider (when Customer or business elects) |

### Observability and operations

| Hostname                                                                           | Purpose                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `api.us5.datadoghq.com`, `us5.datadoghq.com`, `http-intake.logs.us5.datadoghq.com` | Datadog US5 site (regional endpoints permitted) |
| `www.braintrust.dev`, `api.braintrust.dev`, `api-eu.braintrust.dev`                | Braintrust observability                        |
| `sentry.io`                                                                        | Error reporting                                 |

### Connected services (Customer-enabled integrations only)

| Hostname                     | Purpose            |
| ---------------------------- | ------------------ |
| `api.notion.com`             | Notion integration |
| `slack.com`, `api.slack.com` | Slack integration  |

### Browser-binary CDNs (Playwright)

| Hostname                                         | Purpose                      |
| ------------------------------------------------ | ---------------------------- |
| `playwright.azureedge.net`, `cdn.playwright.dev` | Playwright browser downloads |

## 2.3 Categorically blocked egress

Unless approved by Customer in writing, the default policy blocks raw-IP egress not on the resolved-hostname or published-CIDR set (GitHub Meta, Fastly), non-allowlisted DNS resolvers and DNS-over-HTTPS providers, tunneling services, reverse shells, paste sites, public file-sharing services, arbitrary webhook destinations, personal email providers, public object-storage destinations not on the allowlist, and package registries not on the allowlist.

## 2.4 Customer-specific overrides

Two override mechanisms are supported:

- `E2B_SANDBOX_EGRESS_ALLOWLIST` — global additions appended to the default list.
- `E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON` — per-business additions keyed by `businessId`.

For Customer restricted repositories, a per-business override may either narrow or extend the default list. Every session starts from a fresh sandbox built under its own egress policy.

## 2.5 Egress logging

Each allowed and denied egress attempt is recorded with session identifier, resolved destination host, protocol, action (allow / deny), policy result and reason, and timestamp. Logs are subject to the retention and access restrictions in Section 5.

# Section 3. Encryption, Secrets & Key Management

## 3.1 Encryption in transit

All control-plane, sandbox-bridge, user-interface, webhook, API, model-provider, repository, and subprocessor traffic is encrypted using TLS 1.2 or higher (TLS 1.3 where supported by the counterparty). Provider validates certificates and does not intentionally disable TLS verification for Customer-Content flows.

## 3.2 Encryption at rest

| Data                                                                                | Mechanism                                                                                             |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cloudflare D1 (session metadata, audit tables)                                      | AES-256 managed by Cloudflare                                                                         |
| Amazon S3 (transcripts, artifacts, exports)                                         | Server-side encryption AES-256 (SSE-S3 default; SSE-KMS available per environment)                    |
| Cloudflare Workers Secrets (App private keys, OAuth secrets, subprocessor API keys) | Encrypted at rest by Cloudflare                                                                       |
| Customer-supplied repository secrets and environment variables                      | Encrypted at rest in Cloudflare Workers Secrets; never persisted in clear text; never written to logs |
| Sandbox ephemeral filesystem                                                        | Encrypted at rest via sandbox-provider defaults; destroyed at session end / pause-window expiry       |
| Subprocessor copies (per-subprocessor)                                              | Subject to subprocessor encryption (see Section 4)                                                    |

## 3.3 Key management

- **GitHub App private key.** Stored in Cloudflare Workers Secrets; never exposed to sandboxes; never written to logs.
- **OAuth client secrets.** Stored in Cloudflare Workers Secrets.
- **Webhook secrets.** Unique per installation; stored in Cloudflare Workers Secrets; rotated promptly on suspected compromise.
- **Subprocessor API keys** (Datadog, Braintrust, Sentry, model providers, E2B). Stored in Cloudflare Workers Secrets; least-privilege scope; rotated on suspected compromise or personnel departure with access.
- **Sandbox-injected credentials** (`GITHUB_CLONE_TOKEN`, `GITHUB_USER_TOKEN`, model-provider keys). Generated per request, scoped to the minimum operation, injected into the sandbox at session start only, never written to images or snapshots, deleted from the sandbox at session end. For OpenAI BYOK, raw keys are never sent to the sandbox; instead, short-lived gateway session tokens (`arc-gw-*`) are injected and the control plane holds the upstream credential.

## 3.4 Customer-supplied secrets

- **Write-only via API.** Customer-supplied repository environment variables, personal secrets, test credentials, API keys, and similar secrets are write-only through Provider APIs.
- **Not retrievable in plaintext.** They are not retrievable in plaintext through the user interface or support tooling.
- **Sandbox injection.** Decrypted only inside the specific approved sandbox at session start, or when Customer expressly authorizes a specific operation.

## 3.5 Key rotation and revocation

Provider rotates secrets and keys promptly after suspected compromise, personnel departure with access to sensitive secrets, material architecture changes affecting key exposure, or Customer request based on reasonable security grounds. Customer-initiated revocation is supported for GitHub, model-provider, and connected-service credentials.

## 3.6 No secrets in logs

Provider does not intentionally write platform secrets, Customer secrets, GitHub tokens, model-provider keys, OAuth secrets, webhook secrets, repository environment variables, or credentials to logs, transcripts, artifacts, telemetry, crash reports, model prompts, or support tickets. Provider maintains automated secret-detection and redaction controls for logs and artifacts.

# Section 4. Subprocessor List

This section lists each subprocessor that processes, stores, transmits, can access, or provides systems that can access Customer Content. It is updated when Provider adds or materially changes a subprocessor, subject to the notice obligations in the security exhibit / MSA. The "BAA / HIPAA flow-down" column applies only when Customer processes Protected Health Information (PHI) through the Services; for non-healthcare customers it is informational only.

## 4.1 Core subprocessors (always engaged)

| #   | Subprocessor                  | Function                                                          | Customer Content access                                          | Region                                 | Assurance                            | BAA / HIPAA flow-down |
| --- | ----------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------ | --------------------- |
| 1   | **Cloudflare, Inc.**          | Control plane (Workers, DO, D1), CDN, TLS termination, WAF        | Yes — session metadata, transcript pointers, audit logs          | US                                     | SOC 2 Type II, ISO 27001             | In flight (PHI only)  |
| 2   | **E2B (FoundryLabs, Inc.)**   | Per-session sandbox hosting (Firecracker microVMs)                | Yes — ephemeral repo clones, env vars, command output            | US                                     | SOC 2 (in progress)                  | In flight (PHI only)  |
| 3   | **Amazon Web Services, Inc.** | S3 (private buckets), KMS (planned), IAM                          | Yes — persistent transcripts and artifacts                       | US (`us-east-1` default; configurable) | SOC 1/2/3, ISO 27001, HIPAA eligible | In flight (PHI only)  |
| 4   | **OpenAI, L.L.C.**            | Model inference and auxiliary LLM workflows (default routing)     | Yes — prompts, code excerpts, model outputs (ZDR — no retention) | US                                     | SOC 2 Type II                        | **Executed**          |
| 5   | **GitHub, Inc.**              | Customer-installed GitHub App: repo access, PR creation, webhooks | Yes — Customer-controlled scope; short-lived installation tokens | US                                     | SOC 1/2, ISO 27001                   | In flight (PHI only)  |

## 4.2 Observability and operations subprocessors

| #   | Subprocessor                           | Function                                                               | Customer Content access                                        | Region   | Assurance                       | BAA / HIPAA flow-down |
| --- | -------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | -------- | ------------------------------- | --------------------- |
| 6   | **Braintrust Data, Inc.**              | LLM observability — service-operation use (debugging, root-cause, SLA) | Yes — session prompts, responses, traces                       | US       | SOC 2 Type II                   | In flight (PHI only)  |
| 7   | **Datadog, Inc.**                      | Telemetry, log aggregation, infrastructure monitoring (US5)            | Limited — operational logs; Customer Content filtered/redacted | US (US5) | SOC 2 Type II, ISO 27001, HIPAA | In flight (PHI only)  |
| 8   | **Functional Software, Inc. (Sentry)** | Error reporting (stack traces, exception context)                      | Limited — exception context may incidentally include fragments | US       | SOC 2 Type II                   | In flight (PHI only)  |

## 4.3 Conditional subprocessors (engaged only when Customer enables)

| #   | Subprocessor                | Function                                                           | Customer Content access          | Region | Assurance           | BAA / HIPAA flow-down                                    |
| --- | --------------------------- | ------------------------------------------------------------------ | -------------------------------- | ------ | ------------------- | -------------------------------------------------------- |
| 9   | **Anthropic, PBC**          | Alternate model provider (Customer or business election; BYOK)     | Yes when enabled                 | US     | SOC 2 Type II       | Engaged only when Customer election + flow-down in place |
| 10  | **Slack Technologies, LLC** | Slack integration (only when Customer installs the Slack app)      | Limited — notification payloads  | US     | SOC 2 Type II       | N/A — not used for PHI                                   |
| 11  | **Notion Labs, Inc.**       | Notion integration (only when Customer connects)                   | Limited — integration payloads   | US     | SOC 2 Type II       | N/A — not used for PHI                                   |
| 12  | **Modal Labs, Inc.**        | Eval / benchmark sandbox hosting (Provider-internal eval pipeline) | No — Provider eval fixtures only | US     | SOC 2 (in progress) | N/A — not used for Customer Content                      |

## 4.4 Notes

- **Subprocessor personnel access.** Provider configures subprocessor services so that subprocessor personnel do not have access to Customer Content except where strictly necessary to provide the underlying service, under written confidentiality and audit obligations, and only through logged and controlled support access.
- **Flow-down obligations.** Provider's standard practice is to require subprocessors to be bound by written obligations covering confidentiality, security, access control, deletion, breach notification, audit support, retention limits, non-training where applicable, and (where Customer processes PHI) HIPAA business-associate obligations. Status by subprocessor is tracked internally and made available on Customer request.
- **Subprocessor incidents.** Provider notifies Customer of any actual or reasonably suspected subprocessor incident affecting Customer Content within the same timeline as Provider security incidents (Section 10).
- **Change governance.** Provider provides notice before adding or materially changing a subprocessor with access to Customer Content, on the timeline set forth in the security exhibit / MSA.

# Section 5. Data Inventory & Retention Map

## 5.1 Data inventory

| #   | Category                                               | Systems / locations                                                              | Protections                                                                                                   | Subprocessors           |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Customer source code (repo clone)                      | Sandbox ephemeral filesystem only                                                | Per-session isolation; default-deny egress; encrypted at rest; destroyed at session end / pause-window expiry | E2B                     |
| 2   | Customer source code (transient on control plane)      | In-memory only during clone / PR flows; not persisted                            | TLS in transit; not written to logs                                                                           | Cloudflare              |
| 3   | Prompts and model inputs                               | Sandbox (in process); OpenAI (in transit, ZDR); Braintrust traces (operational)  | TLS; ZDR at OpenAI; access controls at Braintrust                                                             | OpenAI, Braintrust      |
| 4   | Model outputs / generated code                         | Sandbox FS (transient); transcripts in D1 / S3; PR body on GitHub                | Encrypted at rest; authenticated proxy                                                                        | AWS, Cloudflare, GitHub |
| 5   | Session transcripts                                    | D1 (metadata + structured events); S3 (large payloads / archives)                | AES-256 at rest; authenticated proxy; access controls                                                         | Cloudflare, AWS         |
| 6   | Artifacts (diffs, generated files, command output)     | S3 (private)                                                                     | AES-256 at rest; authenticated proxy                                                                          | AWS                     |
| 7   | Sandbox-resident files (caches, build output)          | Sandbox FS (per session)                                                         | Per-session isolation; destroyed on end / expiry                                                              | E2B                     |
| 8   | Customer-supplied secrets (env vars, repo credentials) | Cloudflare Workers Secrets; injected into sandbox at session start only          | Encrypted at rest; write-only via API; deleted from sandbox at session end                                    | Cloudflare, E2B         |
| 9   | GitHub installation tokens                             | Short-lived; cached in KV (50-min TTL) with cache invalidation on install events | Never written to logs; never exposed to agents outside approved sandbox                                       | Cloudflare              |
| 10  | Webhook payloads                                       | Control plane (in process); D1 (event records)                                   | HMAC-SHA256 validation against raw body; encrypted at rest                                                    | Cloudflare              |
| 11  | Audit logs (Customer-Content-related)                  | D1 (audit tables); Datadog (US5)                                                 | Encrypted at rest; access subject to privileged-access controls                                               | Cloudflare, Datadog     |
| 12  | Operational logs (may incidentally include fragments)  | Datadog (US5); Sentry (errors)                                                   | Secret-detection / redaction; access logged and least-privilege                                               | Datadog, Sentry         |
| 13  | Telemetry / traces                                     | Braintrust (LLM traces); Datadog (infra / APM)                                   | Access logged; least-privilege                                                                                | Braintrust, Datadog     |
| 14  | Support tickets / records                              | Internal support tooling (Cloudflare-backed); not sent to general-purpose CRM    | Logging limitations; redaction                                                                                | Cloudflare              |
| 15  | Backups                                                | Cloud-provider snapshots / versioning for D1 / S3                                | Encrypted; lifecycle per retention map                                                                        | Cloudflare, AWS         |

## 5.2 Retention map (defaults)

Customer may configure longer or shorter retention per business or per repository in writing. Customer-initiated deletion (Section 5.3) supersedes these defaults.

| #   | Category                                                               | Default retention                                                             | Notes                                                                                    |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A   | Live sandbox (idle)                                                    | Auto-pause after 60 minutes of developer inactivity                           | Configurable shorter per business                                                        |
| B   | Paused / resumable sandbox                                             | Up to 72 hours from pause, configurable shorter or disabled                   | Disabled by default for Customer-designated restricted repositories                      |
| C   | Sandbox filesystem and repository clone                                | Destroyed at end of pause window or earlier on Customer revocation            | Lives only inside the sandbox                                                            |
| D   | Session transcripts (events, model traces) containing Customer Content | 7 days                                                                        | Configurable longer per business                                                         |
| E   | Artifacts, generated files, diffs, command output                      | 7 days                                                                        | Stored in private S3 behind authenticated proxy                                          |
| F   | Logs containing Customer Content                                       | 14 days unless required for active security investigation                     | Security-investigation retention requires restricted access and documented justification |
| G   | Operational logs and telemetry (no Customer Content)                   | 30 days (Datadog default)                                                     | Standard infra retention                                                                 |
| H   | Stored configuration and Customer-supplied secrets                     | Until revoked, replaced, or deleted; deleted within 30 days after termination | Plaintext retrieval prohibited                                                           |
| I   | Backups containing Customer Content                                    | Aged out within 30 days of deletion request or termination                    | Legal holds, if any, disclosed where permitted                                           |
| J   | Subprocessor-side copies                                               | Provider directs deletion within 30 days of request / termination             | Tracked in Section 4                                                                     |
| K   | Audit logs (security and access events)                                | Minimum 1 year                                                                | Protected from modification; available on reasonable Customer request                    |

## 5.3 Customer-initiated deletion

On Customer request, Provider deletes active and primary copies of session transcripts, artifacts, stored configuration, repository clones, credentials, tokens, prompts, outputs, and Customer-Content-bearing logs within seven (7) days, and all remaining backup and subprocessor copies within thirty (30) days, except for limited records required by applicable law. A deletion certificate is provided on request identifying data categories deleted, systems covered, subprocessors notified, date of completion, and the basis for any retention.

## 5.4 Customer Content export

Customer may request export of session transcripts, artifacts, available audit logs, stored configuration, and other reasonably accessible Customer Content in a reasonably usable format. The standard export bundle includes session metadata and transcripts (JSON), artifacts (original file format, packaged as tar / zip from S3), available audit logs (JSON), and stored configuration (JSON, secrets redacted).

## 5.5 Logging limitations

Provider does not log, copy, export, index, analyze, or transmit Customer Content except as strictly necessary to provide the Services. Provider does not send Customer Content to general-purpose analytics, advertising, sales, product-usage, unmanaged APM, crash-reporting, shared-drive, or internal code-review tools.

# Section 6. GitHub App Permission Manifest

The authoritative list of granted GitHub App permissions lives in the GitHub App settings page. The manifest below is derived from Provider repository code and webhook handlers; Provider security reconciles this manifest against the live App settings before each signed delivery.

## 6.1 App identity

- **Name:** Cycloid GitHub App
- **Slug:** `cycloid` (Provider org)
- **Auth model:** App authentication (`@octokit/auth-app`) — JWTs for app-level calls; short-lived installation access tokens for repo-scoped calls.
- **Private key storage:** Cloudflare Workers Secrets (encrypted at rest; access logged; rotation supported).
- **OAuth client secrets:** Cloudflare Workers Secrets.
- **Installation tokens:** Short-lived per GitHub's default; cached in KV (50-min TTL) with invalidation on install/suspend/permission-change events; never written to logs; never exposed to agents outside the approved sandbox; revocable by Customer at any time.

## 6.2 Repository permissions requested

| Permission          | Level        | Required for                                            | Operate without?                                                           |
| ------------------- | ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Contents**        | Read & write | Cloning at session start; pushing branches; opening PRs | No — write needed to publish PRs. Read-only supported for restricted mode. |
| **Metadata**        | Read         | Mandatory for app installation                          | No                                                                         |
| **Pull requests**   | Read & write | Opening PRs, updating PR body, replying to comments     | No — write needed to publish PRs                                           |
| **Issues**          | Read & write | Task descriptions, status comments, PR linking          | Yes — write can be disabled per business                                   |
| **Checks**          | Read & write | Reporting Provider-side check status                    | Yes                                                                        |
| **Commit statuses** | Read         | Determining build state                                 | Yes — best-effort                                                          |

Workflows, secrets, environments, deployments, packages, repository administration, security events, and organization-level permissions (members, administration, plan) are **not requested**, and Provider does not access them unless Customer separately approves in writing.

## 6.3 Account / user permissions (for OAuth user login)

| Permission                           | Level | Required for                                          |
| ------------------------------------ | ----- | ----------------------------------------------------- |
| **Email addresses**                  | Read  | Identifying the user; matching to business membership |
| **GitHub user identity** (login, id) | Read  | Audit attribution                                     |

## 6.4 Webhook event subscriptions

| Event                       | Purpose                                                              | Notes                        |
| --------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `installation`              | Track install / uninstall / suspend / unsuspend / permission changes | Required                     |
| `installation_repositories` | Track repo selection changes inside an install                       | Required                     |
| `issue_comment`             | Detect tasks created via PR / issue comment                          | Optional; gated per business |
| `pull_request`              | Track Provider-generated PR lifecycle                                | Required                     |
| `pull_request_review`       | Detect review activity on Provider-generated PRs                     | Required                     |
| `push`                      | Detect HEAD updates on tracked branches                              | Required                     |
| `status`                    | Detect commit-status signals from PR review bots                     | Optional; review loop only   |

Webhook secrets are unique per installation, validated against the raw request body with HMAC-SHA256, fail-closed on signature mismatch, and rotated promptly on suspected compromise.

## 6.5 Installation scope

The GitHub App is installable only on Customer-selected repositories. All-repository installation is supported by GitHub but is not the default Provider configuration. For Customer-designated restricted repositories, additional product-level controls apply (see Section 7).

## 6.6 Write-path restrictions

Provider enforces application-level restrictions in addition to GitHub permissions. Provider-generated PRs do not auto-merge, self-approve, bypass branch protection, approve deployments, publish packages, rotate secrets, modify GitHub Actions workflows, or trigger privileged CI/CD jobs. Mutating git/gh operations are blocked at two layers: (1) root-owned wrapper scripts at `/usr/local/bin/git` and `/usr/local/bin/gh` intercept commands before invoking the real binaries, and (2) the bridge command parser blocks mutating GitHub API operations from shell pipelines. `gh` CLI usage from the agent is restricted to read operations and Provider-mediated PR open / push flows.

## 6.7 Attribution

Provider distinguishes between actions performed by (a) the GitHub App, (b) a Customer end user, (c) a Provider employee, and (d) an agent. These distinctions are surfaced in Provider logs with session, agent, and task identifiers where technically feasible.

# Section 7. Customer Admin Controls & Restricted Mode

This section describes the levers a Customer administrator can pull to constrain Provider's blast radius. These are operational today; they do not require Provider engineering changes to enable per-customer.

## 7.1 Standard admin controls

| Lever                                           | Effect                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selected-repository installation                | Customer chooses repos at install time (and may change selection at any time); all-repos installation is not the default.                                |
| Read-only mode (per business)                   | Disables Provider write paths; PR creation, branch push, and write-bearing `gh` operations are blocked.                                                  |
| Disabled persistence (per business or per repo) | Disables paused / resumable sandboxes; sandbox destroyed at session end.                                                                                 |
| Custom egress allowlist (per business)          | Narrows or extends the default sandbox egress list (Section 2).                                                                                          |
| Per-business retention windows                  | Overrides defaults in Section 5 (e.g., shorter transcript or artifact retention).                                                                        |
| BYOK for model providers                        | Customer routes inference through Customer-elected model-provider credentials rather than the Provider enterprise account.                               |
| No production-secret access                     | Repository environment variables and Customer-supplied secrets can be marked as non-production-only; production secrets are not injected into sandboxes. |
| Customer revocation                             | Uninstall the GitHub App, revoke tokens, remove repositories, disable write, or suspend Provider access at any time.                                     |

## 7.2 Restricted mode (recommended for sensitive repositories)

For Customer-designated restricted repositories, Provider supports a deployment profile that combines the above into a single posture:

- Repo install limited to the Customer-selected restricted set.
- Read-only by default unless Customer separately enables write.
- Sandbox persistence disabled.
- No workflow / secrets / environments / deployments / packages access (already the default per Section 6).
- Customer-specific egress allowlist (Section 2.4).
- Customer-supplied secrets injected only at session start, never persisted to snapshots, deleted at session end.
- Shorter default retention windows.
- BYOK strongly recommended.

## 7.3 Required human review

Provider-generated changes are subject to Customer branch protections, CODEOWNERS, required reviews, required checks, security review, and release processes. Provider does not bypass these controls or encourage Customer personnel to bypass them.

## 7.4 Audit visibility

Customer-side audit visibility is available via:

- GitHub audit log (App actions, installation token use, repo access).
- Provider-side audit log (session create / terminate, GitHub App token use, privileged access, egress events, deletion events) — exported on reasonable Customer request.
- Customer-installed monitoring of Provider-generated PRs through Customer's existing CI / security tooling.

# Section 8. Output Handling & No-Training Stance

## 8.1 No training, no fine-tuning, no benchmarks, no demos

Provider does not use Customer Content, repositories, session state, transcripts, or artifacts for Provider product development, model training, model fine-tuning, benchmark creation, internal demos, sales, marketing, analytics, or unrelated testing. Provider contractually requires model providers to refrain from using Customer Content for training or model improvement, and configures inference routing through Provider enterprise model-provider accounts set for **zero data retention (ZDR)** or equivalent non-retention, non-training settings.

## 8.2 Carve-out: service-operation observability

Provider's LLM observability stack (Braintrust) ingests session data — prompts, responses, and traces — for the limited purpose of operating the Services: debugging customer-reported issues, root-causing failures, monitoring quality, enforcing SLAs, and responding to incidents. This carve-out is narrowly scoped to service operations. Use for any of the prohibited purposes listed in Section 8.1 remains prohibited.

## 8.3 Outputs treated as Customer Content

Outputs, generated code, summaries, and model responses derived from Customer Content are treated as Customer Content. Provider does not disclose, reuse, or use such Outputs except to provide the Services to Customer.

## 8.4 Auxiliary LLM activity

Auxiliary LLM activity performed by Provider — including classification, routing, summarization, evaluation, debugging, or safety checks involving Customer Content — is subject to the same confidentiality, retention, non-training, logging, region, and (where applicable) BAA requirements as Customer task inference. Auxiliary workflows route through the same Provider OpenAI enterprise account configured for ZDR.

## 8.5 Agent safety controls

Provider maintains AI-agent safety controls designed to prevent prompt injection, excessive agency, data exfiltration, malicious tool use, arbitrary command execution, repository-content attacks, and unapproved actions. These include policy enforcement outside the model, separation of trusted system instructions from untrusted repository content, least-privilege tool permissions, command and network policy enforcement (Section 2), and audit logging of tool calls.

# Section 9. SOC 2 Status & Assurance Roadmap

## 9.1 SOC 2 Type II

Provider is in the SOC 2 Type II audit cycle.

| Milestone                           | Target              |
| ----------------------------------- | ------------------- |
| Audit kickoff with selected auditor | **June 2026**       |
| Type II observation period          | June – October 2026 |
| Type II report issuance             | **~October 2026**   |

Provider commits to delivering the SOC 2 Type II report to Customer within fifteen (15) days of issuance, under NDA where required. Material changes to this timeline are communicated to Customer promptly.

## 9.2 Independent penetration testing

| Pentest                                 | Window                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Initial independent third-party pentest | **Commencing early July 2026**                                                                               |
| Second independent third-party pentest  | **Commencing early September 2026**                                                                          |
| Annual cadence thereafter               | Plus commercially reasonable additional tests after material architecture changes affecting Customer Content |

Scope covers the control plane, GitHub App integration, OAuth flows, token storage, webhook validation, sandbox isolation and resume paths, network egress controls, logging and telemetry, model-provider routing, cloud / IaaS configuration, and administrative access. Executive summary, scope statement, findings summary, and remediation attestation are provided to Customer under NDA on completion.

## 9.3 Interim assurance package

This document is the interim assurance package, refreshed when material changes occur. Provider refreshes it as components mature (e.g., when pentest executive summaries are available, when SOC 2 Type II issues).

## 9.4 Bridge controls until Type II

Until Provider delivers the SOC 2 Type II report, Customer may use the product-level controls in Section 7 to constrain blast radius. These controls are operational today.

# Section 10. Incident Response — Contact, Notification & Escalation

The full incident-response runbook is part of the SOC 2 deliverables (CC7.3 / CC7.4 / CC7.5). This section captures the contact, timing, and flow.

## 10.1 Customer-facing security contact

| Channel            | Detail                                          |
| ------------------ | ----------------------------------------------- |
| Primary email      | **security@cycloid.com**                        |
| Backup email       | **team@cycloid.com**                            |
| In-product channel | Customer Slack Connect channel (if established) |

For Customer-side notifications, Provider uses the Customer security contact(s) listed on the Order Form (or equivalent).

## 10.2 Notification SLA

Provider notifies Customer **without undue delay and in no event later than twenty-four (24) hours** after discovering any security incident affecting Customer Content or Customer-dedicated systems. The notification includes (to the extent known): nature of the incident, affected systems, affected Customer Content or credentials, approximate time period of impact, containment steps already taken, actions Customer should take (if any), and Provider point of contact for coordination.

## 10.3 Internal escalation flow

```
Detection (monitoring, customer report, or subprocessor signal)
        ↓
On-call engineer (acknowledges, triages, contains)
        ↓
Lead engineer (paged within 1 hour of triage; takes ownership when
Customer Content is involved or the incident is high-severity)
        ↓
Customer notification within 24 hours of discovery
```

For credential or GitHub compromise, the on-call engineer initiates immediate rotation or revocation of affected credentials in parallel with the escalation above.

## 10.4 Investigation and updates

Provider investigates, contains, remediates, and mitigates the incident; preserves relevant logs and forensic evidence; cooperates with Customer investigation and Customer's regulatory / contractual notification obligations; and provides periodic updates to the Customer security contact until containment and remediation are complete. Default cadence is every 24 hours during active investigation; more frequent for high-severity incidents.

## 10.5 Post-incident report

Within **ten (10) business days** after containment (or such longer period as reasonably necessary for complex investigations, with notice to Customer), Provider provides a written post-incident report including root cause, timeline, affected data categories and systems, containment actions, remediation actions, corrective controls, and evidence of completion.

## 10.6 Credential and GitHub compromise

For any actual or suspected compromise of GitHub tokens, OAuth credentials, webhook secrets, model-provider keys, cloud keys, Customer credentials, or repository access paths, Provider promptly rotates or revokes affected credentials, assists Customer with Customer-side rotation or revocation, and provides evidence of completion as part of the post-incident report.

## 10.7 Subprocessor incidents

Provider notifies Customer of any actual or reasonably suspected subprocessor incident affecting Customer Content within the same 24-hour timeline above and remains responsible for subprocessor acts and omissions relating to Customer Content.

## 10.8 Coordinated disclosure

External vulnerability reports may be sent to **security@cycloid.com**. Provider triages external reports in a timely manner and notifies Customer of validated vulnerabilities that materially affect Customer Content or Customer systems.

# Section 11. SOC 2-Deferred Commitments

This section lists control areas where Provider commits to the obligation contractually but has not yet produced a standalone pre-audit policy document. The documented-and-attested form of each policy is produced by the SOC 2 audit (Section 9). The mapping below identifies the SOC 2 Trust Services Criteria (TSC) control family that produces each policy as a SOC 2 deliverable.

These items are intentionally not packaged as standalone pre-audit attachments because (a) the SOC 2 audit will produce the documented versions in the auditor's format, and (b) producing parallel pre-audit versions creates rework and version drift. Customer's protection here is the contract commitment + the SOC 2 timeline commitment, not a pre-audit policy PDF.

## 11.1 Mapping

| Control area                            | Obligation Provider commits to                                                                                                                                                                                                                                                 | SOC 2 TSC control(s) that produce the documented version |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Personnel security                      | Background checks where legally permissible, signed confidentiality, security & privacy training at onboarding + annually, acceptable use, prompt offboarding, least-privilege role assignment                                                                                 | **CC1.4, CC1.5**                                         |
| Endpoint security                       | Managed or equivalently-controlled devices for administrative access / Customer Content access; disk encryption; screen lock; EDR or equivalent; OS patching; no unapproved local Customer Content storage; remote wipe / access revocation on loss / compromise / termination | **CC6.7, CC6.8**                                         |
| Privileged access                       | Disabled by default; named-user only, JIT, time-limited, least-privilege, ticketed, FIDO2 / WebAuthn MFA, audit-logged; post-hoc Customer notification for events affecting Customer Content                                                                                   | **CC6.1, CC6.2, CC6.3**                                  |
| Break-glass access                      | Permitted only for active incidents or material outages where waiting for approval would increase risk; documented reason, approver, user, systems, time, duration, commands, Customer Content accessed, remediation; 24h notification                                         | **CC6.1, CC7.4**                                         |
| Session recording & auditability        | Where technically feasible, session recording / command logging / equivalent immutable audit records for privileged access; ≥ 1 year retention; protected from modification; available on reasonable Customer request                                                          | **CC6.1, CC7.2**                                         |
| Secure SDLC                             | Peer review, branch protection, dep scanning, secret scanning, SAST, IaC review, container / image scanning, security review for material architecture changes, separation of duties for production deployment                                                                 | **CC8.1**                                                |
| Vulnerability remediation               | Target tiers: critical 7d / high 30d / medium 90d / actively exploited 72h, under commercially reasonable efforts; documented risk acceptance for exceptions; Customer notice for exceptions materially affecting Customer Content                                             | **CC7.1, CC8.1**                                         |
| Assurance materials                     | Current security-assurance materials on Customer reasonable request under NDA                                                                                                                                                                                                  | **Generated by the SOC 2 audit itself**                  |
| Business continuity / disaster recovery | BCP / DR procedures appropriate to the Services; tested or reviewed at least annually; backup and recovery processes preserve Customer Content confidentiality, integrity, encryption, access controls, and deletion obligations                                               | **A1.2, A1.3**                                           |

## 11.2 Today's commitment

For each area listed above, Provider commits in the security exhibit / MSA to maintaining the controls described. The absence of a standalone pre-audit policy document does not reduce the contractual obligation.

## 11.3 What Customer gets when SOC 2 Type II issues

The SOC 2 Type II report includes the system description (which supersedes / extends Section 1), the auditor's opinion and tests of operating effectiveness for each TSC control listed above, identified exceptions and management responses (if any), and subservice organizations (subprocessors) noted in scope. On issuance, Provider delivers the full Type II report to Customer within fifteen (15) days, under NDA where required.

## 11.4 Interim evidence on request

For any area above, Customer may request informal evidence under NDA pending SOC 2 issuance — for example, screenshots of MFA enforcement, configuration of branch protection, a sample audit-log record, or a description of the offboarding process. Provider responds reasonably and to the extent such evidence exists today.
