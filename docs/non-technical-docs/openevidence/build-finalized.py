#!/usr/bin/env python3
"""Generate the finalized OpenEvidence Exhibit A by accepting all tracked changes.

Input:  OpenEvidence_Exhibit_A_Cycloid_Redline.docx (with track-changes markup)
Output: OpenEvidence_Exhibit_A_Final.docx (clean, all changes accepted)

Run after OpenEvidence confirms they accept the redline as-is.
"""
import re
import zipfile
from pathlib import Path

THIS_DIR = Path(__file__).parent
REDLINE_DOCX = THIS_DIR / "OpenEvidence_Exhibit_A_Cycloid_Redline.docx"
OUTPUT_DOCX = THIS_DIR / "OpenEvidence_Exhibit_A_Final.docx"


def accept_changes(document_xml: str) -> tuple[str, int, int]:
    """Strip <w:del>...</w:del> entirely; unwrap <w:ins>...</w:ins>."""
    del_count = len(re.findall(r"<w:del\b[^>]*>", document_xml))
    ins_count = len(re.findall(r"<w:ins\b[^>]*>", document_xml))

    # Remove deletions entirely (including <w:delText> runs inside).
    document_xml = re.sub(r"<w:del\b[^>]*>.*?</w:del>", "", document_xml, flags=re.DOTALL)

    # Unwrap insertions: keep the inner runs, drop the <w:ins> wrapper.
    document_xml = re.sub(
        r"<w:ins\b[^>]*>(.*?)</w:ins>",
        lambda m: m.group(1),
        document_xml,
        flags=re.DOTALL,
    )

    # Defensive: any stray <w:delText> outside a <w:del> wrapper shouldn't exist,
    # but if it does, drop it.
    document_xml = re.sub(r"<w:delText\b[^>]*>.*?</w:delText>", "", document_xml, flags=re.DOTALL)

    return document_xml, del_count, ins_count


def main() -> None:
    print(f"Reading: {REDLINE_DOCX.name}")
    with zipfile.ZipFile(REDLINE_DOCX, "r") as zin:
        with zin.open("word/document.xml") as f:
            document_xml = f.read().decode("utf-8")

    new_document_xml, del_count, ins_count = accept_changes(document_xml)
    print(f"Accepted: {del_count} deletions removed, {ins_count} insertions unwrapped")

    # Sanity: confirm no track-change markup remains.
    remaining = len(re.findall(r"<w:(del|ins|delText)\b", new_document_xml))
    if remaining != 0:
        raise SystemExit(f"FAIL: {remaining} stray track-change tags remain")

    print(f"Writing: {OUTPUT_DOCX.name}")
    with zipfile.ZipFile(REDLINE_DOCX, "r") as zin:
        with zipfile.ZipFile(OUTPUT_DOCX, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == "word/document.xml":
                    zout.writestr(item, new_document_xml)
                else:
                    zout.writestr(item, zin.read(item.filename))

    print("Done.")


if __name__ == "__main__":
    main()
