#!/usr/bin/env python3
"""Generate a Word-track-changes redlined version of the OpenEvidence Exhibit A.

Re-run this whenever the proposed language in REDLINES changes — the script
always rebuilds from the pristine original docx in this folder.
"""
import re
import zipfile
from pathlib import Path

THIS_DIR = Path(__file__).parent
ORIGINAL_DOCX = THIS_DIR / "OpenEvidence_Customer_Proposed_Exhibit_A_Information_Security_Measures.docx"
OUTPUT_DOCX = THIS_DIR / "OpenEvidence_Exhibit_A_Cycloid_Redline.docx"

AUTHOR = "Cycloid"
DATE = "2026-05-22T00:00:00Z"


REDLINES = [
    {
        "section": "1.2",
        "anchor": "Provider shall implement and maintain controls that are no less protective than those described in this Exhibit",
        "proposed": (
            "Provider shall implement and maintain controls that are no less protective than those described "
            "in this Exhibit and consistent with industry-standard security practices for SaaS services handling "
            "confidential source code and high-value intellectual property, and, where Provider processes PHI "
            "pursuant to Section 14, PHI."
        ),
    },
    {
        "section": "1.3",
        "anchor": "Provider shall not materially reduce, bypass, or disable any control described in this Exhibit",
        "proposed": (
            "Provider shall not materially reduce or disable any control described in this Exhibit in a manner "
            "that materially weakens protection of Customer Content. For changes adding new Subprocessors with "
            "access to Customer Content, Provider shall provide Customer with at least thirty (30) days advance "
            "notice. For other material changes to architecture, hosting, model providers, GitHub App permissions, "
            "data retention, logging, encryption, privileged-access controls, or egress controls that affect "
            "Customer Content, Provider shall provide reasonable advance notice or, where the change is driven "
            "by security, regulatory, or incident-response considerations, prompt notice as soon as reasonably "
            "practicable after the change."
        ),
    },
    {
        "section": "3.3",
        "anchor": "Provider shall disable Privileged Access to Customer Content by default",
        "proposed": (
            "Provider shall disable Privileged Access to Customer Content by default. Privileged Access shall be "
            "named-user only, just-in-time, time-limited, least-privilege, ticketed, audit-logged, and gated by "
            "phishing-resistant MFA using FIDO2/WebAuthn hardware-backed authenticators. Provider shall notify "
            "Customer within twenty-four (24) hours after any instance of Privileged Access to Customer Content "
            "other than break-glass access governed by Section 3.4, and shall make audit records available to "
            "Customer upon reasonable request."
        ),
    },
    {
        "section": "4.3",
        "anchor": "Provider shall notify Customer and obtain Customer written approval before adding permissions",
        "proposed": (
            "Provider shall provide advance notice to Customer before adding GitHub App permissions, subscribing "
            "to new webhook events, changing token scopes, changing source-control attribution behavior, changing "
            "accessible repositories, or changing OAuth flows. For changes that expand the permissions or "
            "repositories the GitHub App can access in Customer's environment, Provider shall obtain Customer "
            "written approval. For security-driven changes to the GitHub App private-key or token-storage "
            "architecture, Provider shall provide prompt notice; for non-security-driven changes to private-key "
            "or token-storage architecture, Provider shall provide thirty (30) days advance notice."
        ),
    },
    {
        "section": "5.2",
        "anchor": "Sandbox filesystems shall be destroyed immediately upon Session end, timeout, Customer revocation",
        "proposed": (
            "Sandbox filesystems shall be destroyed upon Session end, Customer revocation, or seventy-two (72) "
            "hours after the sandbox is paused, whichever occurs first. For clarity, a live sandbox auto-pauses "
            "after sixty (60) minutes of developer inactivity; the seventy-two (72) hour retention applies to "
            "paused sandboxes only and is measured from the time of pause. The Services support pause and resume "
            "of Sessions to enable developers to continue interrupted work; the maximum idle pause window is "
            "seventy-two (72) hours by default and may be configured shorter or disabled entirely by Customer "
            "administrators. Paused or resumable sandboxes shall be disabled by default for Customer-designated "
            "restricted repositories. Persisted state shall be encrypted at rest, made visible to Customer "
            "administrators, limited to the Customer-approved duration, and destroyed at expiration."
        ),
    },
    {
        "section": "5.5",
        "anchor": "Provider shall not use Customer Content, repositories, Session state, transcripts, or artifacts for Provider product development",
        "proposed": (
            "Provider shall not use Customer Content, repositories, Session state, transcripts, or artifacts for "
            "model training, model fine-tuning, benchmark creation, internal demos, sales, marketing, advertising, "
            "or unrelated testing without Customer prior written approval. Provider may process Customer Content "
            "as reasonably necessary to operate, monitor, debug, secure, troubleshoot, and improve the Services, "
            "including the use of LLM observability tooling to diagnose Service issues, investigate Security "
            "Incidents, and meet service-level commitments to Customer, provided that such processing remains "
            "subject to the confidentiality, retention, deletion, access-control, and non-disclosure obligations "
            "of this Exhibit and the Terms."
        ),
    },
    {
        "section": "8.5",
        "anchor": "Provider shall maintain AI-agent safety controls designed to prevent prompt injection",
        "proposed": (
            "Provider shall maintain AI-agent safety controls designed to prevent prompt injection, excessive "
            "agency, data exfiltration, malicious tool use, arbitrary command execution, repository-content "
            "attacks, and unapproved actions. Such controls shall include policy enforcement outside the model, "
            "separation of trusted system instructions from untrusted repository content, least-privilege tool "
            "permissions, command and network policy enforcement, audit logging of tool calls, and clear "
            "identification of the human-directed task that authorized any Agent action. Authorization for Agent "
            "actions shall be granted by Customer or its End Users at task assignment; Agent actions taken within "
            "the scope of an authorized task shall not require additional per-action human approval, but shall "
            "remain subject to Customer's branch protection, CODEOWNERS, required review, the write-path "
            "restrictions in Section 4.6, and the required human review obligations in Section 15.2."
        ),
    },
    {
        "section": "10.2",
        "anchor": "Before production access to Customer restricted repositories or any broad repository access",
        "proposed": (
            "Provider shall commission an independent third-party penetration test and architecture review "
            "covering the control plane, GitHub App integration, OAuth flows, token storage, webhook validation, "
            "sandbox isolation and resume paths, network egress controls, logging and telemetry, model-provider "
            "routing, cloud/IaaS configuration, and administrative access. Provider shall commission such test "
            "as part of its SOC 2 audit cycle (commencing in June 2026) and shall provide Customer an executive "
            "summary and remediation attestation upon completion. Pending completion of the initial test, the "
            "interim assurance package provided pursuant to Section 11.3 and Customer's configuration of the "
            "restricted-mode deployment controls in Section 15.3 shall serve as Customer's interim risk "
            "mitigation. Critical and high findings shall be remediated within the timeframes set forth in "
            "Section 10.4."
        ),
    },
    {
        "section": "10.3",
        "anchor": "Provider shall commission an independent third-party penetration test at least annually",
        "proposed": (
            "Beginning with the initial test commissioned pursuant to Section 10.2, Provider shall commission an "
            "independent third-party penetration test at least annually thereafter, and shall use commercially "
            "reasonable efforts to commission targeted testing following material architecture changes affecting "
            "Customer Content. Automated, autonomous, or internal adversarial testing may supplement but shall "
            "not replace independent third-party testing."
        ),
    },
    {
        "section": "10.4",
        "anchor": "Provider shall remediate vulnerabilities affecting the Services or Customer Content within the following timeframes",
        "proposed": (
            "Provider shall use commercially reasonable efforts to remediate vulnerabilities affecting the "
            "Services or Customer Content within the following target timeframes, measured from discovery or "
            "notification: critical within seven (7) days; high within thirty (30) days; medium within ninety "
            "(90) days; and actively exploited vulnerabilities as soon as practicable and no later than "
            "seventy-two (72) hours for containment or compensating controls. Provider shall document risk "
            "acceptance for any exception and provide Customer notice for exceptions materially affecting "
            "Customer Content."
        ),
    },
    {
        "section": "11.4",
        "anchor": "Until Provider delivers a completed SOC 2 Type II report",
        "proposed": (
            "Provider shall commence a SOC 2 Type II audit by no later than June 2026 and shall use commercially "
            "reasonable efforts to deliver a completed SOC 2 Type II report (or an equivalent independent "
            "assurance report covering the Services) within twelve (12) months of audit commencement. Until "
            "Provider delivers such report, Customer may, at its election, configure the Services to apply any "
            "of the following controls: restricted repository scope, read-only access, no write access, no "
            "production secrets, no PHI handling, BYOK model credentials, shorter retention windows (subject to "
            "Provider's minimum operational requirements), and Customer-specific egress allowlists. The "
            "configuration options identified in Section 15.3 shall be sufficient to give effect to this "
            "Section 11.4."
        ),
    },
    {
        "section": "13.3",
        "anchor": "Provider shall provide at least thirty (30) days advance notice before adding or materially changing a Subprocessor",
        "proposed": (
            "Provider shall provide at least thirty (30) days advance notice before adding or materially "
            "changing a Subprocessor with access to Customer Content. Customer may reasonably object to a new "
            "or changed Subprocessor based on security, privacy, PHI, regulatory, or confidentiality concerns. "
            "If the parties cannot resolve the objection in good faith: (i) for non-foundational Subprocessors, "
            "Customer may suspend affected processing or terminate affected Services without penalty; and "
            "(ii) for foundational Subprocessors necessary to the operation of the Services (as of the "
            "Effective Date, including E2B, Cloudflare, AWS, and OpenAI), Customer may terminate affected "
            "Services, and Provider shall refund any prepaid fees attributable to Services not yet delivered."
        ),
    },
]


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def paragraph_text(paragraph_xml: str) -> str:
    """Extract the concatenated visible text from a <w:p>...</w:p> block."""
    return "".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", paragraph_xml, re.DOTALL))


def build_redlined_paragraph(original_paragraph: str, proposed_text: str, del_id: int, ins_id: int) -> str:
    p_open_match = re.match(r"<w:p\b[^>]*>", original_paragraph)
    if not p_open_match:
        raise ValueError("Could not find paragraph opening tag")
    p_open = p_open_match.group(0)

    body = original_paragraph[len(p_open):]
    if not body.endswith("</w:p>"):
        raise ValueError("Paragraph doesn't end with </w:p>")
    inner = body[: -len("</w:p>")]

    ppr = ""
    ppr_match = re.match(r"<w:pPr>.*?</w:pPr>", inner, re.DOTALL)
    if ppr_match:
        ppr = ppr_match.group(0)
        inner = inner[len(ppr):]

    deleted_runs = re.sub(
        r"<w:t(\s[^>]*)?>",
        lambda m: f"<w:delText{m.group(1) or ''}>",
        inner,
    )
    deleted_runs = deleted_runs.replace("</w:t>", "</w:delText>")

    del_block = (
        f'<w:del w:id="{del_id}" w:author="{AUTHOR}" w:date="{DATE}">'
        f"{deleted_runs}"
        f"</w:del>"
    )
    ins_block = (
        f'<w:ins w:id="{ins_id}" w:author="{AUTHOR}" w:date="{DATE}">'
        f'<w:r><w:t xml:space="preserve">{xml_escape(proposed_text)}</w:t></w:r>'
        f"</w:ins>"
    )

    return f"{p_open}{ppr}{del_block}{ins_block}</w:p>"


def apply_redlines(document_xml: str) -> str:
    paragraphs = re.findall(r"<w:p\b[^>]*>.*?</w:p>", document_xml, re.DOTALL)
    next_id = 1000
    for redline in REDLINES:
        anchor = redline["anchor"]
        matching = [p for p in paragraphs if anchor in paragraph_text(p)]
        if len(matching) == 0:
            raise ValueError(f"§{redline['section']}: no paragraph matched anchor {anchor[:60]!r}")
        if len(matching) > 1:
            raise ValueError(
                f"§{redline['section']}: anchor matched {len(matching)} paragraphs; tighten the anchor"
            )
        original = matching[0]
        replacement = build_redlined_paragraph(
            original, redline["proposed"], del_id=next_id, ins_id=next_id + 1
        )
        document_xml = document_xml.replace(original, replacement, 1)
        next_id += 2
        print(f"  ✓ §{redline['section']}")
    return document_xml


def main() -> None:
    print(f"Reading: {ORIGINAL_DOCX.name}")
    with zipfile.ZipFile(ORIGINAL_DOCX, "r") as zin:
        with zin.open("word/document.xml") as f:
            document_xml = f.read().decode("utf-8")

    print(f"Applying {len(REDLINES)} redlines:")
    new_document_xml = apply_redlines(document_xml)

    print(f"Writing: {OUTPUT_DOCX.name}")
    with zipfile.ZipFile(ORIGINAL_DOCX, "r") as zin:
        with zipfile.ZipFile(OUTPUT_DOCX, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == "word/document.xml":
                    zout.writestr(item, new_document_xml)
                else:
                    zout.writestr(item, zin.read(item.filename))

    print("Done.")


if __name__ == "__main__":
    main()
