# OpenEvidence — Documentation Planning Doc

Scope: the **Docs** half of [openevidence-pre-execution-action-items.md](openevidence-pre-execution-action-items.md). Builds on the existing **Cycloid Security Package** at [`docs/non-technical-docs/security/source/cycloid-security-package.md`](../security/source/cycloid-security-package.md).

What ships to OpenEvidence: the default security package `.docx` + two diagrams + an OpenEvidence-specific addendum + the formal redline `.docx`.

---

## 1. Interim policy one-pagers (added to the default security package)

Six one-pagers, added as sub-sections under an expanded Section 11 of the security package. Each marked as **"interim, to be superseded by the SOC 2 deliverable for [TSC control family]"**. Section 11.1's mapping table stays as the index. README's "What's deliberately not in this package" paragraph updated to reflect that interim one-pagers are now included.

Each one-pager contains: scope, current controls, monitoring / evidence available today, gaps the SOC 2 audit will close, mapping to SOC 2 TSC control(s).

- [ ] **Privileged-access + break-glass policy** (CC6.1 / CC6.2 / CC6.3 / CC7.4). Covers OE §3.3 + §3.4 + admin access. Named-user, JIT, time-limited, ticketed, FIDO2 MFA, audit-logged, 24h post-hoc notification; break-glass capture and approval flow.
- [ ] **Personnel security policy** (CC1.4 / CC1.5). Background checks where permissible, signed confidentiality, security & privacy training at onboarding + annually, AUP, offboarding, least-privilege role assignment.
- [ ] **Endpoint security policy** (CC6.7 / CC6.8). Managed devices, disk encryption, screen lock, EDR, OS patching, no unapproved local Customer Content storage, remote wipe. State target (MDM/EDR rollout) vs. current.
- [ ] **Secure SDLC policy** (CC8.1). Peer review, branch protection, dep scanning, secret scanning, SAST, IaC review, container/image scanning, security review for material arch changes, separation of duties.
- [ ] **Vulnerability management policy** (CC7.1 / CC8.1). 7/30/90/72h target tiers under commercially reasonable efforts, documented risk acceptance, Customer notice for exceptions materially affecting Customer Content.
- [ ] **BCP / DR plan** (A1.2 / A1.3). RTOs / RPOs, backup and recovery process, annual review/test cadence, preservation of confidentiality / integrity / encryption / access control / deletion through backups.

---

## 2. Visual diagrams (one-page PDF/PNG attachments)

- [ ] **Architecture diagram** — control plane (CF Workers / DO / D1), sandbox-bridge, E2B sandboxes, S3 proxy, GitHub App, subprocessors, trust boundaries. Source: package Section 1.1 + 1.2.
- [ ] **Data-flow diagram** — Customer Content path: GitHub App → control plane → sandbox → model providers → S3 / D1 → observability. Source: package Section 5.1.

---

## 3. OpenEvidence addendum

Separate doc shipped alongside the default package. Section structure:

1. **Section-by-section mapping to OpenEvidence Exhibit A.** Table: OE § → security package section + (where applicable) redline counter pointer. Includes redlined §s with one-line summaries.
2. **PHI status snapshot.** OpenAI BAA executed; AWS / Cloudflare / Braintrust / E2B in flight. PHI enablement gated per-business on subprocessor BAA execution. Maps to OE §1.2 / §14.
3. **Restricted mode for OpenEvidence's restricted-repo use case.** Lifts package Section 7.2 and applies to OE §10.2 / §11.4 / §15.3. States the controls Customer admins can pull today as the interim bridge until SOC 2 Type II issues.
4. **Observability carve-out language and scope.** Quotes package Section 8.2; explicit list of carved-out vs. prohibited uses. Maps to §5.5 redline counter.
5. **Pointer to the formal redline.** One paragraph: the redline `.docx` is the authoritative contractual position; this addendum is reference material.

---

## 4. Verification refreshes before delivery

- [ ] Read the OpenAI BAA; confirm scope covers auxiliary LLM workflows (package Section 8.4).
- [ ] Read the SOC 2 engagement letter; confirm dates against package Section 9 (Type II ~October 2026; pentests July + September 2026).
- [ ] Pull current GitHub App settings; reconcile against package Section 6 manifest.
- [ ] Pull current vendor register; refresh BAA status column in package Section 4.
- [ ] Confirm production S3 region matches package Section 1 + Section 5 (`us-east-1` default).

---

## 5. Sequence

1. Run verification refreshes (Section 4). Blocks every date and scope statement downstream.
2. Draft six interim policy one-pagers (Section 1). Update package Section 11 framing + README.
3. Produce architecture + data-flow diagrams (Section 2).
4. Draft OpenEvidence addendum (Section 3).
5. Build the package: `docs/non-technical-docs/security/_template/build.sh`. Confirm new Section 11 content renders cleanly.
6. Bundle: package `.docx` + two diagrams + addendum `.docx` + redline `.docx` → send to OpenEvidence.
