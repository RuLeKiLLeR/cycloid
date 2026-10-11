# OpenEvidence — Pre-Execution Action Items

Source: [openevidence-exhibit-a-gap-analysis.md](openevidence-exhibit-a-gap-analysis.md), [openevidence-exhibit-a-redline.md](openevidence-exhibit-a-redline.md).

Assumes the redline lands as proposed: SOC 2 Type II deferred (audit kicks off June 2026, Type II ~12 months later), initial pentest tied to that cycle, PHI scoped to when it's actually enabled, observability carve-out accepted, restricted-mode controls accepted as the interim bridge.

Two top-level buckets — **Docs** and **Code / Infra** — each tiered the same way as the gap analysis:

- 🟢 **Minimal lift** — days to ~2 weeks
- 🟡 **Heavy lift** — months, vendor coordination, or platform-security workstream
- 🔴 **External dependency / can't deliver immediately** — gated on audit cycle, vendor negotiation, or fleet rollout

The **Pre-exec** column marks items that must land before execution. Anything without ✅ is a timed commitment after signing.

Several policy docs commit us to systems we have to actually run — those policies have a `→ Code` pointer to the implementation item in the lower section.

---

## Docs

### 🟢 Minimal lift

| §             | Item                                                    | Pre-exec | Notes                                                                                                                                                 |
| ------------- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1          | Architecture diagram                                    | ✅       | §17 bundle                                                                                                                                            |
| §2.1          | Data-flow diagram                                       | ✅       | §17 bundle                                                                                                                                            |
| §4.1          | GitHub App permission manifest                          | ✅       | §17 bundle; pull from GitHub App settings                                                                                                             |
| §6.1          | Default egress allowlist writeup                        | ✅       | §17 bundle; document current sandbox whitelist                                                                                                        |
| §9.1          | Data inventory                                          | ✅       | §17 bundle                                                                                                                                            |
| §13.1         | Subprocessor list                                       | ✅       | §17 bundle; function / data category / region / BAA / PHI / foundational flag                                                                         |
| §3.3          | Privileged-access policy writeup                        | ✅       | Backs §3.3 counter. → Code: §3.3 24h post-hoc notification, §3.3 JIT provisioning, §3.5 privileged-access session recording                           |
| §3.4          | Break-glass policy                                      | ✅       | Reason, approver, user, systems, time, duration, commands, Customer Content accessed, remediation, 24h notification. → Code: §3.4 break-glass capture |
| §12.1         | IR 24h notification SLA + contact list                  | ✅       | §17 bundle. → Code: §12.1 on-call alerting path                                                                                                       |
| §12.3         | Post-incident report template                           | ✅       | 10-business-day SLA                                                                                                                                   |
| §12.4         | Credential / GitHub compromise playbook                 | ✅       | → Code: §12.4 GitHub App key + customer-token rotation tooling                                                                                        |
| §10.4         | Vulnerability management policy                         | ✅       | 7/30/90/72h tiers under "commercially reasonable efforts." → Code: §10.4 vuln tracking + SLA workflow                                                 |
| §16.1         | BCP / DR documentation                                  | ✅       | Annual-review cadence. → Code: §16.1 backup verification + DR restore test                                                                            |
| §11.3         | Interim assurance package (bundle of the above)         | ✅       | Stand-in for SOC 2 Type II at signing                                                                                                                 |
| §11.3 / §11.4 | SOC 2 status note                                       | ✅       | Audit kickoff June 2026, Type II target window, interim controls                                                                                      |
| §3.1          | Personnel security policy writeup                       | ✅       | Background checks, signed confidentiality, training cadence, AUP, offboarding, least-privilege (attestable evidence is 🟡)                            |
| §3.2          | Endpoint policy writeup                                 | ✅       | Note target state (MDM, EDR) vs. current state                                                                                                        |
| §3.3 non-code | Admin-access policy writeup                             | ✅       | FIDO2 hardware-backed MFA, named users, quarterly access reviews                                                                                      |
| §8.1          | Confirm OpenAI BAA scope covers auxiliary-LLM workflows | ✅       | Already executed; re-read scope and confirm                                                                                                           |

### 🟡 Heavy lift

| §             | Item                                                | Pre-exec | Notes                                                                |
| ------------- | --------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| §13.2         | Subprocessor flow-down audit + renegotiation        |          | Legal review of every existing subprocessor agreement                |
| §10.1         | Documented secure SDLC program (attestable state)   |          | Most pieces exist; formalization takes weeks. → Code: §10.1 pipeline |
| §3.1          | Personnel security program with attestable evidence |          | Beyond the writeup — signed AUPs, training records, offboarding logs |
| §14.1 / §14.2 | PHI / HIPAA program documentation                   |          | Gated on subprocessor BAAs                                           |
| §11.5         | Customer audit-right process                        |          | Cadence, scope, NDA, redaction policy                                |

### 🔴 External dependency / can't deliver immediately

| §             | Item                                     | Pre-exec | Notes                                                                                            |
| ------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| §11.4         | SOC 2 Type II report                     |          | Audit June 2026; Type II ~12 months after                                                        |
| §10.2         | Initial third-party pentest              |          | Commissioned as part of SOC 2 cycle                                                              |
| §10.3         | Annual pentest cadence                   |          | Commences after initial                                                                          |
| §13.2 / §14.1 | AWS / Cloudflare / Braintrust / E2B BAAs |          | Vendor-paced; gates PHI per business. Initiate pre-exec so the subprocessor list can show status |

---

## Code / Infra

### 🟢 Minimal lift

| §     | Item                                                                                                  | Pre-exec | Notes                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §15.3 | Restricted-mode deployment preset                                                                     | ✅       | Single business-level preset: selected repos, read-only, no prod secrets, no PHI, no workflow access, no persistence, customer egress allowlist, BYOK. Backs §10.2 / §11.4 counters. |
| §15.1 | Expand business-admin toggles                                                                         | ✅       | Persistence, egress allowlist, retention window, BYOK, write capability per org/repo/branch                                                                                          |
| §4.6  | Write-path restrictions                                                                               | ✅       | Block agent edits to `.github/workflows`, secrets, environments, deployments, packages, CODEOWNERS, branch protection, repo security settings. Backs §8.5 counter.                   |
| §4.7  | Action attribution in logs                                                                            | ✅       | Session / agent / task IDs on every GitHub API call; tighten log schema; attribute action to App vs. End User vs. Provider employee vs. Agent                                        |
| §7.4  | Secret-detection + redaction middleware on logs / transcripts / artifacts / telemetry / crash reports | ✅       | Datadog + Braintrust paths. Required to attest "no plaintext secrets in observability."                                                                                              |
| §7.3  | Remove plaintext secret read paths                                                                    | ✅       | Audit UI / support surface                                                                                                                                                           |
| §5.4  | Secret-injection audit + snapshot test                                                                | ✅       | Confirm no snapshot path persists env vars                                                                                                                                           |
| §3.3  | 24h post-hoc notification on every privileged-access event                                            | ✅       | Slack / email on event emission; backs §3.3 policy doc                                                                                                                               |
| §3.4  | Break-glass capture automation                                                                        | ✅       | Form / endpoint that captures reason / approver / user / systems / time / duration / commands → Datadog event → auto-notify; backs §3.4 policy doc                                   |
| §9.5  | Customer-initiated deletion endpoint                                                                  | ✅       | `DELETE /businesses/:id/content` fanning out across D1 / S3 / Datadog / Braintrust                                                                                                   |
| §9.7  | Customer Content bulk export endpoint                                                                 | ✅       | Sessions, transcripts, artifacts, audit logs                                                                                                                                         |
| §11.2 | Audit-log export API                                                                                  | ✅       | Per-business surface for events already logged to Datadog                                                                                                                            |
| §10.1 | Verify / enable GitHub Advanced Security                                                              | ✅       | Dependabot, secret scanning, code scanning at attestable enabled state across our repos                                                                                              |
| §10.4 | Vuln tracking + SLA workflow                                                                          | ✅       | Linear or GitHub Issues with severity / SLA labels; backs §10.4 policy doc                                                                                                           |
| §12.1 | On-call alerting path                                                                                 | ✅       | PagerDuty / equivalent + customer-comms playbook trigger; backs §12.1 24h notification SLA                                                                                           |
| §12.4 | GitHub App key + customer-token rotation tooling                                                      | ✅       | Scripted rotation procedure + runbook; backs §12.4 playbook                                                                                                                          |
| §16.1 | D1 + S3 backup verification + DR restore test                                                         | ✅       | Confirm backups exist and are restorable; backs §16.1 BCP/DR doc                                                                                                                     |
| §8.6  | Outputs-as-Customer-Content enforcement gate                                                          |          | Same enforcement surface as §5.5 observability carve-out                                                                                                                             |

### 🟡 Heavy lift

| §     | Item                                          | Pre-exec | Notes                                                                                                                                |
| ----- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| §9.4  | Retention windows + automated purge (basics)  | ✅       | Per-tier defaults + working purge for sandbox FS / transcripts / artifacts. Full per-business override system can ship post-signing. |
| §3.5  | Privileged-access session recording           |          | CloudTrail consolidation, sandbox admin SSH recording, support-tool audit, ≥ 1yr retention. Backs §3.3 policy doc.                   |
| §3.3  | JIT provisioning system for production access |          | Named-user, time-bound, ticketed access to prod systems. Backs §3.3 policy doc.                                                      |
| §10.1 | Full secure SDLC pipeline at attestable state |          | SAST, IaC review, container / image scanning, peer review gates, separation of duties documented end-to-end                          |
| §2.2  | Platform-security workstream                  |          | S3 BPA + KMS encryption (config), anomaly alerting, IAM least-privilege, IaC review                                                  |

### 🔴 External rollout / can't deliver immediately

| §     | Item                                    | Pre-exec | Notes                                 |
| ----- | --------------------------------------- | -------- | ------------------------------------- |
| §3.2  | MDM rollout (Kandji / Jamf / Fleet)     |          | Fleet deployment                      |
| §3.2  | EDR rollout (Crowdstrike / SentinelOne) |          | Fleet deployment                      |
| §3.3  | FIDO2 / WebAuthn hardware-key rollout   |          | Across the team                       |
| §3.3  | Quarterly access-review cadence         |          | Ongoing process                       |
| §14.1 | PHI-tier infrastructure                 |          | Gated on subprocessor BAAs in Docs 🔴 |

---

## Critical path to signing

Pre-exec items only, in rough order:

1. **Subprocessor paperwork preflight**: confirm OpenAI BAA scope; initiate AWS / Cloudflare / Braintrust / E2B BAA conversations so the subprocessor list can show status.
2. **§17 attachment package**: all Docs 🟢 pre-exec rows.
3. **Load-bearing Code / Infra 🟢**: §15.3 restricted mode, §15.1 toggles, §4.6 write-path, §4.7 attribution, §7.4 redaction, §7.3 plaintext-secret cleanup, §5.4 secret-injection audit, §3.3 24h notification, §3.4 break-glass capture, §9.5 deletion, §9.7 export, §11.2 audit-log export, §10.1 GitHub Advanced Security, §10.4 vuln tracking, §12.1 on-call alerting, §12.4 rotation tooling, §16.1 backup verification.
4. **Load-bearing Code / Infra 🟡**: §9.4 retention basics.
5. **Send the formal redline + §17 bundle to OpenEvidence.**
