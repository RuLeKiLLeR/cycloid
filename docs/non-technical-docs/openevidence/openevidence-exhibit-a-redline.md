# Redline: OpenEvidence Customer-Proposed Exhibit A

**Source:** `OpenEvidence_Customer_Proposed_Exhibit_A_Information_Security_Measures.docx` (customer-proposed replacement draft to Pilot Order Form dated April 27, 2026).

**Approach:** Cycloid accepts the structure of the Exhibit and the substantial majority of its controls. The redlines below address ~12 specific clauses where the language as drafted is operationally infeasible, commercially unworkable, or out-of-step with current product architecture. The proposed alternatives preserve the spirit of the Customer's intent while making the obligations executable today.

**Format:** Each item shows the verbatim original, the proposed replacement, and a one-line rationale. Items not redlined here are accepted as drafted (or will be after the minimal-lift product/policy items currently in progress).

---

## 1. §1.2 Minimum Standard — scope PHI obligation

**Issue:** As drafted, binds Provider to industry-standard practices for SaaS handling PHI even when no PHI is in scope.

**Original:**

> Provider shall implement and maintain controls that are no less protective than those described in this Exhibit and consistent with industry-standard security practices for SaaS services handling confidential source code, PHI, and high-value intellectual property.

**Proposed:**

> Provider shall implement and maintain controls that are no less protective than those described in this Exhibit and consistent with industry-standard security practices for SaaS services handling confidential source code and high-value intellectual property, and, where Provider processes PHI pursuant to Section 14, PHI.

**Why:** PHI-grade obligations attach only when PHI handling is actually enabled, which is gated on subprocessor BAAs (in flight; see §14).

---

## 2. §1.3 No Material Weakening — 30-day notice carve-outs

**Issue:** 30-day advance written notice for any material change to architecture/security controls blocks routine security fixes and vendor swaps.

**Original:**

> Provider shall not materially reduce, bypass, or disable any control described in this Exhibit without Customer prior written approval. Provider shall notify Customer at least thirty (30) days before any material change to architecture, hosting, model providers, GitHub App permissions, Subprocessors, data retention, logging, encryption, privileged-access controls, or egress controls that affects Customer Content.

**Proposed:**

> Provider shall not materially reduce or disable any control described in this Exhibit in a manner that materially weakens protection of Customer Content. For changes adding new Subprocessors with access to Customer Content, Provider shall provide Customer with at least thirty (30) days advance notice. For other material changes to architecture, hosting, model providers, GitHub App permissions, data retention, logging, encryption, privileged-access controls, or egress controls that affect Customer Content, Provider shall provide reasonable advance notice or, where the change is driven by security, regulatory, or incident-response considerations, prompt notice as soon as reasonably practicable after the change.

**Why:** Preserves customer visibility while carving out emergency security/regulatory changes from the 30-day window.

---

## 3. §3.3 Privileged Access — replace per-event written approval with post-hoc notification

**Issue:** Customer pre-approval, in writing, of every internal engineering privileged-access event is operationally impractical and would block routine support and debugging.

**Original:**

> Provider shall disable Privileged Access to Customer Content by default. Privileged Access shall be named-user only, just-in-time, time-limited, least-privilege, ticketed, and approved by Customer in writing except for emergency access necessary to address an active Security Incident or material service outage. All Privileged Access shall require phishing-resistant MFA using FIDO2/WebAuthn hardware-backed authenticators.

**Proposed:**

> Provider shall disable Privileged Access to Customer Content by default. Privileged Access shall be named-user only, just-in-time, time-limited, least-privilege, ticketed, audit-logged, and gated by phishing-resistant MFA using FIDO2/WebAuthn hardware-backed authenticators. Provider shall notify Customer within twenty-four (24) hours after any instance of Privileged Access to Customer Content other than break-glass access governed by Section 3.4, and shall make audit records available to Customer upon reasonable request.

**Why:** Preserves accountability via audit logging and 24-hour post-hoc notification. Eliminates the per-event written-approval requirement that would block routine support.

---

## 4. §4.3 No Unapproved Permission Changes — scope GitHub-App approvals

**Issue:** Same 30-day-approval problem applies to GitHub App permission and token-storage changes that may be security-driven.

**Original:**

> Provider shall notify Customer and obtain Customer written approval before adding permissions, subscribing to new webhook events, changing token scopes, changing source-control attribution behavior, changing accessible repositories, changing OAuth flows, or changing the GitHub App private-key or token-storage architecture.

**Proposed:**

> Provider shall provide advance notice to Customer before adding GitHub App permissions, subscribing to new webhook events, changing token scopes, changing source-control attribution behavior, changing accessible repositories, or changing OAuth flows. For changes that expand the permissions or repositories the GitHub App can access in Customer's environment, Provider shall obtain Customer written approval. For security-driven changes to the GitHub App private-key or token-storage architecture, Provider shall provide prompt notice; for non-security-driven changes to private-key or token-storage architecture, Provider shall provide thirty (30) days advance notice.

**Why:** Customer approval gate preserved for expansion of scope; security-driven architecture changes can proceed with notice rather than approval.

---

## 5. §5.2 Ephemeral Filesystems — support pause-and-resume

**Issue:** Immediate destruction on Session timeout is incompatible with pause-and-resume, which is foundational to the Cycloid developer experience. Either developers lose their in-flight work, or sandbox hold costs become unviable.

**Original:**

> Sandbox filesystems shall be destroyed immediately upon Session end, timeout, Customer revocation, or task completion unless Customer affirmatively enables persistence for a specific Session or repository. Paused or resumable sandboxes shall be disabled by default for restricted repositories. If Customer enables persistence, Provider shall make the persistence window visible to Customer administrators, encrypt persisted state at rest, limit the persistence window to the Customer-approved duration, and destroy persisted state at expiration.

**Proposed:**

> Sandbox filesystems shall be destroyed upon Session end, Customer revocation, or seventy-two (72) hours after the sandbox is paused, whichever occurs first. For clarity, a live sandbox auto-pauses after sixty (60) minutes of developer inactivity; the seventy-two (72) hour retention applies to paused sandboxes only and is measured from the time of pause. The Services support pause and resume of Sessions to enable developers to continue interrupted work; the maximum idle pause window is seventy-two (72) hours by default and may be configured shorter or disabled entirely by Customer administrators. Paused or resumable sandboxes shall be disabled by default for Customer-designated restricted repositories. Persisted state shall be encrypted at rest, made visible to Customer administrators, limited to the Customer-approved duration, and destroyed at expiration.

**Why:** Pause-and-resume is core to the product (and matches what the Services do today: 60-minute live-idle auto-pause, 72-hour retention on paused state). Customer retains control over the maximum pause window and can disable pause/resume entirely for restricted repos.

---

## 6. §5.5 No Training or Internal Reuse — carve out service-operation observability

**Issue:** As drafted, sweeps in LLM observability tooling (e.g., Braintrust) that Cycloid uses to debug Service issues, investigate Security Incidents, and meet SLA. Without that data flow, troubleshooting customer-reported issues becomes substantially harder.

**Original:**

> Provider shall not use Customer Content, repositories, Session state, transcripts, or artifacts for Provider product development, model training, model fine-tuning, benchmark creation, internal demos, sales, marketing, analytics, or unrelated testing without Customer prior written approval.

**Proposed:**

> Provider shall not use Customer Content, repositories, Session state, transcripts, or artifacts for model training, model fine-tuning, benchmark creation, internal demos, sales, marketing, advertising, or unrelated testing without Customer prior written approval. Provider may process Customer Content as reasonably necessary to operate, monitor, debug, secure, troubleshoot, and improve the Services, including the use of LLM observability tooling to diagnose Service issues, investigate Security Incidents, and meet service-level commitments to Customer, provided that such processing remains subject to the confidentiality, retention, deletion, access-control, and non-disclosure obligations of this Exhibit and the Terms.

**Why:** Preserves the substantive prohibition on training, marketing, and analytics reuse while carving out the service-operation use that's necessary for support and SLA delivery.

---

## 7. §8.5 Agent Safety Controls — task-level authorization, not per-action approval

**Issue:** Requiring human approval before every Agent action that modifies source code, CI/CD, deployments, secrets, or external systems defeats the purpose of a background coding agent. Customer authorizes the work scope when an End User assigns a task.

**Original (final clause of §8.5):**

> ...and human approval before actions that modify source code, CI/CD, deployments, secrets, package publishing, access controls, or external systems.

**Proposed (final clause of §8.5):**

> ...and clear identification of the human-directed task that authorized any Agent action. Authorization for Agent actions shall be granted by Customer or its End Users at task assignment; Agent actions taken within the scope of an authorized task shall not require additional per-action human approval, but shall remain subject to Customer's branch protection, CODEOWNERS, required review, the write-path restrictions in Section 4.6, and the required human review obligations in Section 15.2.

**Why:** Customer's branch protection and required-review controls already provide the human-review gate on Agent output (and Cycloid respects those — see §15.2). Per-action approval would defeat the background-agent model the Services are designed to provide.

---

## 8. §10.2 Independent Testing — tie initial pentest to SOC 2 cycle

**Issue:** Initial pentest will be commissioned as part of the SOC 2 audit cycle starting June 2026; we can't gate restricted-repo access on a pentest that hasn't happened yet.

**Original:**

> Before production access to Customer restricted repositories or any broad repository access, Provider shall complete an independent third-party penetration test and architecture review covering the control plane, GitHub App integration, OAuth flows, token storage, webhook validation, sandbox isolation and resume paths, network egress controls, logging and telemetry, model-provider routing, cloud/IaaS configuration, and administrative access. Provider shall remediate critical and high findings before such access is enabled and provide Customer an executive summary and remediation attestation.

**Proposed:**

> Provider shall commission an independent third-party penetration test and architecture review covering the control plane, GitHub App integration, OAuth flows, token storage, webhook validation, sandbox isolation and resume paths, network egress controls, logging and telemetry, model-provider routing, cloud/IaaS configuration, and administrative access. Provider shall commission such test as part of its SOC 2 audit cycle (commencing in June 2026) and shall provide Customer an executive summary and remediation attestation upon completion. Pending completion of the initial test, the interim assurance package provided pursuant to Section 11.3 and Customer's configuration of the restricted-mode deployment controls in Section 15.3 shall serve as Customer's interim risk mitigation. Critical and high findings shall be remediated within the timeframes set forth in Section 10.4.

**Why:** Commits to the pentest happening as part of the SOC 2 cycle. Removes the absolute pre-condition on restricted-repo access; replaces it with interim controls the Customer already has access to.

---

## 9. §10.3 Annual Testing — anchor to initial test

**Issue:** Annual cadence depends on the initial test happening; we can commit to annual once SOC 2 cycle is underway.

**Original:**

> Provider shall commission an independent third-party penetration test at least annually and after material architecture changes affecting Customer Content. Automated, autonomous, or internal adversarial testing may supplement but shall not replace independent third-party testing.

**Proposed:**

> Beginning with the initial test commissioned pursuant to Section 10.2, Provider shall commission an independent third-party penetration test at least annually thereafter, and shall use commercially reasonable efforts to commission targeted testing following material architecture changes affecting Customer Content. Automated, autonomous, or internal adversarial testing may supplement but shall not replace independent third-party testing.

**Why:** Anchors annual cadence to the initial test in §10.2; softens material-change testing with commercially-reasonable-efforts.

---

## 10. §10.4 Vulnerability Remediation — add commercially-reasonable-efforts qualifier

**Issue:** Flat timelines without a "commercially reasonable efforts" qualifier create absolute commitments that may not survive contact with a complex real-world vulnerability.

**Original:**

> Provider shall remediate vulnerabilities affecting the Services or Customer Content within the following timeframes, measured from discovery or notification unless a shorter timeframe is reasonably required by active exploitation: critical within seven (7) days; high within thirty (30) days; medium within ninety (90) days; and actively exploited vulnerabilities as soon as practicable and no later than seventy-two (72) hours for containment or compensating controls. Provider shall document risk acceptance for any exception and provide Customer notice for exceptions materially affecting Customer Content.

**Proposed:**

> Provider shall use commercially reasonable efforts to remediate vulnerabilities affecting the Services or Customer Content within the following target timeframes, measured from discovery or notification: critical within seven (7) days; high within thirty (30) days; medium within ninety (90) days; and actively exploited vulnerabilities as soon as practicable and no later than seventy-two (72) hours for containment or compensating controls. Provider shall document risk acceptance for any exception and provide Customer notice for exceptions materially affecting Customer Content.

**Why:** Keeps the target timeframes intact; adds the standard SaaS-security qualifier.

---

## 11. §11.4 SOC 2 Condition — replace open-ended evidence lever with §15.3 controls

**Issue:** Two problems: (i) Customer's right to demand "additional security evidence" at any time creates an undefined obligation; (ii) the configuration levers Customer may apply pending SOC 2 should be tied to the specific product controls Cycloid already supports, not a unilateral demand list.

**Original:**

> Until Provider delivers a completed SOC 2 Type II report or other mutually acceptable independent assurance report covering the Services, Customer may restrict repository scope, prohibit access to restricted repositories, require read-only access, disable write access, prohibit production secrets and PHI, require BYOK, require shorter retention, require egress restrictions, or require additional security evidence as a condition of continued use.

**Proposed:**

> Provider shall commence a SOC 2 Type II audit by no later than June 2026 and shall use commercially reasonable efforts to deliver a completed SOC 2 Type II report (or an equivalent independent assurance report covering the Services) within twelve (12) months of audit commencement. Until Provider delivers such report, Customer may, at its election, configure the Services to apply any of the following controls: restricted repository scope, read-only access, no write access, no production secrets, no PHI handling, BYOK model credentials, shorter retention windows (subject to Provider's minimum operational requirements), and Customer-specific egress allowlists. The configuration options identified in Section 15.3 shall be sufficient to give effect to this Section 11.4.

**Why:** Pins down the SOC 2 timeline. Replaces the open-ended "additional security evidence" lever with the specific product configuration controls already enumerated in §15.3.

---

## 12. §13.3 Notice and Objection — scope termination right for foundational Subprocessors

**Issue:** Termination-without-penalty for objection to a foundational Subprocessor (e.g., AWS, Cloudflare, OpenAI, E2B) is a material commercial risk. For non-foundational Subprocessors it's reasonable.

**Original:**

> Provider shall provide at least thirty (30) days advance notice before adding or materially changing a Subprocessor with access to Customer Content. Customer may reasonably object to a new or changed Subprocessor based on security, privacy, PHI, regulatory, or confidentiality concerns. If the parties cannot resolve the objection, Customer may suspend affected processing or terminate affected Services without penalty.

**Proposed:**

> Provider shall provide at least thirty (30) days advance notice before adding or materially changing a Subprocessor with access to Customer Content. Customer may reasonably object to a new or changed Subprocessor based on security, privacy, PHI, regulatory, or confidentiality concerns. If the parties cannot resolve the objection in good faith: (i) for non-foundational Subprocessors, Customer may suspend affected processing or terminate affected Services without penalty; and (ii) for foundational Subprocessors necessary to the operation of the Services (as of the Effective Date, including E2B, Cloudflare, AWS, and OpenAI), Customer may terminate affected Services, and Provider shall refund any prepaid fees attributable to Services not yet delivered.

**Why:** Preserves objection right for non-foundational vendors; rationalizes foundational-vendor termination to refund-only.

---

## Items accepted as drafted (no redline)

The following high-volume items are accepted as drafted, conditional on the §17 attachment package being delivered in due course:

- §2.1–§2.4 (Hosting and Infrastructure)
- §3.1, §3.2, §3.4, §3.5 (Personnel, Endpoint, Break-Glass, Session Recording)
- §4.1, §4.2, §4.4–§4.8 (GitHub App Controls)
- §5.1, §5.3, §5.4 (Session Isolation, Hardened Runtime, Session Credentials)
- §6.1–§6.5 (Egress — Cycloid's current whitelist-only egress is operationally equivalent to default-deny)
- §7.1–§7.5 (Encryption and Key Management)
- §8.1–§8.4, §8.6 (Model Provider Inference — Cycloid already has OpenAI ZDR + BAA in place; auxiliary LLM workflows route through the same account)
- §9.1–§9.7 (Data Lifecycle, Retention, Deletion, Export)
- §10.1, §10.5 (Secure SDLC, Coordinated Disclosure)
- §11.1–§11.3, §11.5 (Monitoring, Customer Audit Logs, Assurance Materials, Audit Right)
- §12.1–§12.4 (Security Incident Response)
- §13.1, §13.2, §13.4 (Subprocessor List, Flow-Down Terms, Subprocessor Incidents)
- §14.1–§14.3 (PHI, Restricted Data, Confidentiality — conditional on BAAs in flight with non-OpenAI subprocessors)
- §15.1–§15.3 (Customer Controls)
- §16.1, §16.2 (Continuity, Termination Support)
- §17 (Required Attachments — to be delivered as the §17 package)
- §18 (Survival and Interpretation)

---

## Notes for OpenEvidence counsel

1. **The redlines above are all targeted at specific operational realities of Cycloid's architecture or the timing of our SOC 2 / pentest workstream.** None of them are objections to the substantive controls; in most cases we accept the obligation and simply change the mechanism for executing it.

2. **The §17 attachment package** (architecture diagram, data-flow, subprocessor list, GitHub App permission manifest, data inventory, retention map, privileged-access policy, security testing evidence, IR contact, SOC 2 status) is being prepared in parallel and will be delivered as a single bundle ahead of execution.

3. **PHI handling** (§14) is gated on subprocessor BAAs. OpenAI BAA is in place; AWS, Cloudflare, Braintrust, and E2B BAAs are in flight. We're happy to enable PHI handling on a per-business basis once the underlying BAAs are executed.

4. **SOC 2 Type II.** Audit commences June 2026. Pending Type II, we propose that Customer configure the Services via the §15.3 restricted-mode controls (which Customer-administrators control in product) as the interim risk mitigation.

5. We're happy to schedule a call to walk through any of these.
